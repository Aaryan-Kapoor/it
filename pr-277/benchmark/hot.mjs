// These benchmark helpers perform no I/O when imported.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const HOME = '/tmp/it-perf/service';
const DOOR = 'http://localhost:4930';
const BACKEND = 'http://127.0.0.1:4970';
const SESSION = Object.freeze({ harness: 'claude-code', id: 'perf-session' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const now = () => performance.timeOrigin + performance.now();
const knownError = Symbol('benchmarkError');
const fail = code => Object.assign(new Error(code), { code, [knownError]: true });
const rounded = value => Math.round(value * 1000) / 1000;
let busy = false;

async function exclusive(fn) {
  if (busy) throw fail('measurement_already_running');
  busy = true;
  try { return await fn(); }
  catch (error) { throw error?.[knownError] ? error : fail('measurement_failed'); }
  finally { busy = false; }
}

function count(value, maximum = 200) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw fail('invalid_sample_count');
}

async function record(name) {
  try { return JSON.parse(await readFile(`${HOME}/${name}.json`, 'utf8')); }
  catch { throw fail(`${name}_record_unavailable`); }
}

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const q = p => {
    const at = (sorted.length - 1) * p;
    return rounded(sorted[Math.floor(at)] + (sorted[Math.ceil(at)] - sorted[Math.floor(at)]) * (at % 1));
  };
  return { n: sorted.length, min: rounded(sorted[0]), p25: q(.25), median: q(.5), p75: q(.75), p95: q(.95), max: rounded(sorted.at(-1)) };
}

async function machineToken(supplied) {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !supplied) throw fail('invalid_machine_token');
    return supplied;
  }
  const cached = await record('token');
  if (typeof cached.token !== 'string' || !(cached.exp > Date.now() / 1000 + 30)) throw fail('machine_token_needs_refresh');
  return cached.token;
}

async function call(token, type, path, args) {
  const body = JSON.stringify({ path, format: 'convex_encoded_json', args: [args] });
  const start = now();
  try {
    const response = await fetch(`${DOOR}/api/${type}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const text = await response.text();
    const parsed = JSON.parse(text);
    const end = now();
    if (!response.ok || parsed.status !== 'success') throw fail('backend_call_failed');
    return {
      start, end, ms: end - start, bytes: Buffer.byteLength(text),
      requestId: response.headers.get('x-convex-request-id'), value: parsed.value,
    };
  } catch (error) {
    throw fail(error?.code === 'backend_call_failed' ? 'backend_call_failed' : 'backend_call_unavailable');
  }
}

// Only timing metadata survives parsing. Raw lines, results, arguments and errors are discarded.
export function timingEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter(e =>
    (e.kind === undefined || e.kind === 'Completion') && Number.isFinite(e.executionTime) && Number.isFinite(e.timestamp)
    && e.parentExecutionId == null && (e.componentPath == null || e.componentPath === '')
  ).map(e => ({
    path: String(e.identifier ?? e.udfPath ?? '').replace(/\.js:/, ':'),
    type: String(e.udfType ?? '').toLowerCase(),
    at: Number(e.timestamp) * 1000,
    executionMs: e.executionTime * 1000,
    cached: typeof e.cachedResult === 'boolean' ? e.cachedResult : null,
    failed: Boolean(e.error), retry: e.willRetry === true,
    requestId: typeof e.requestId === 'string' ? e.requestId : null,
    executionId: typeof e.executionId === 'string' ? e.executionId : null,
    caller: typeof e.caller === 'string' ? e.caller : null,
  }));
}

async function logReader() {
  let key;
  try { key = (await record('service')).adminKey; } catch { return null; }
  if (typeof key !== 'string' || !key) return null;
  let cursor = 0;
  return {
    async read() {
      try {
        const response = await fetch(`${BACKEND}/api/stream_function_logs?cursor=${cursor}`, {
          headers: { authorization: `Convex ${key}` }, signal: AbortSignal.timeout(2500), redirect: 'error',
        });
        if (!response.ok) return null;
        const parsed = await response.json();
        if (typeof parsed.newCursor !== 'number' || !Array.isArray(parsed.entries)) return null;
        cursor = parsed.newCursor;
        return timingEntries(parsed.entries);
      } catch { return null; }
    },
  };
}

export function associateTimings(samples, entries, path, type) {
  const seen = new Set();
  const matching = entries.filter(e => {
    if (e.path !== path || (e.type && e.type !== type)) return false;
    if (!e.requestId || !e.executionId) return true;
    const key = `${e.requestId}:${e.executionId}:${e.at}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const used = new Set();
  const pairs = samples.map(sample => {
    let matches = sample.requestId ? matching.filter(e => e.requestId === sample.requestId && !e.retry) : [];
    let method = 'request_id';
    if (!matches.length) {
      method = 'window_inferred';
      // These clocks are on this machine. A millisecond allows for timestamp rounding.
      matches = matching.filter(e => !e.retry && e.at >= sample.start - 1 && e.at <= sample.end + 1);
    }
    const entry = matches.length === 1 && !used.has(matches[0]) ? matches[0] : null;
    if (entry) used.add(entry);
    return { entry, method: entry ? method : 'unmatched_or_ambiguous' };
  });
  const picked = pairs.flatMap(p => p.entry ? [p.entry] : []);
  return {
    available: true,
    matched: picked.length, unmatched: samples.length - picked.length,
    requestIdMatches: pairs.filter(p => p.method === 'request_id').length,
    timeWindowMatches: pairs.filter(p => p.method === 'window_inferred').length,
    executionMs: summarize(picked.map(e => e.executionMs)),
    cachedExecutionMs: summarize(picked.filter(e => e.cached === true && !e.failed && !e.retry).map(e => e.executionMs)),
    uncachedExecutionMs: summarize(picked.filter(e => e.cached === false && !e.failed && !e.retry).map(e => e.executionMs)),
    unknownCacheEntries: picked.filter(e => e.cached === null).length,
    failed: picked.filter(e => e.failed).length,
    retryEntries: matching.filter(e => e.retry).length,
    samples: pairs.map(p => p.entry ? { executionMs: rounded(p.entry.executionMs), cached: p.entry.cached, matchedBy: p.method } : null),
  };
}

/** Run measurements in a reserved benchmark window. Failed calls are not retried. */
export async function runHotBackend({ token, iterations = 20, warmup = 3, serverTiming = true } = {}) {
  return exclusive(async () => {
    count(iterations, 100); count(warmup, 20);
    const auth = await machineToken(token);
    const logs = serverTiming ? await logReader() : null;
    const logAvailable = logs ? (await logs.read()) !== null : false;
    const operations = [
      { path: 'artifacts:list', type: 'query', args: () => ({}) },
      { path: 'artifacts:get', label: 'artifact_with_history', type: 'query', args: () => ({ slug: 'perf-00' }) },
      { path: 'artifacts:get', label: 'artifact_without_history', type: 'query', args: () => ({ slug: 'perf-00', history: false }) },
      { path: 'state:get', type: 'query', args: () => ({ slug: 'perf-00' }) },
      { path: 'delivery:waitingFor', type: 'query', args: () => ({ session: SESSION }) },
      // An empty merge preserves user state while taking the real write/revision/rate-limit path.
      { path: 'state:patch', type: 'mutation', args: () => ({ slug: 'perf-00', patch: '{}' }) },
    ];
    const measurements = [];
    for (const op of operations) {
      for (let i = 0; i < warmup; i++) await call(auth, op.type, op.path, op.args());
      if (logAvailable) await logs.read();
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const { value: _discarded, ...sample } = await call(auth, op.type, op.path, op.args());
        samples.push(sample);
      }
      const entries = logAvailable ? await logs.read() : null;
      measurements.push({
        operation: op.label ?? op.path, function: op.path, type: op.type,
        wallMs: summarize(samples.map(s => s.ms)), responseBytes: summarize(samples.map(s => s.bytes)),
        wallSamplesMs: samples.map(s => rounded(s.ms)),
        server: entries ? associateTimings(samples, entries, op.path, op.type) : { available: false },
      });
    }
    return { kind: 'hot_backend', transport: 'HTTP via door', iterations, warmup,
      serverTimingRequested: serverTiming, adminLogAvailable: logAvailable,
      clockAssumption: 'HTTP client and backend run on the same machine; time-window correlations are inferred and ambiguous matches are omitted.',
      cacheNote: 'Warm queries may be server cache hits. Only uncachedExecutionMs describes successful fresh executions.',
      mutationEffect: 'state:patch merges an empty object and advances the state revision.', measurements };
  });
}

async function connectorClient() {
  const info = await record('connector');
  if (typeof info.token !== 'string') throw fail('invalid_connector_record');
  // A copied record must never send the test token to the owner's connector.
  if (info.socket !== `${HOME}/connector.sock`) throw fail('isolated_connector_socket_required');
  const where = { socketPath: info.socket };
  return async (path, body) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const method = text === undefined ? 'GET' : 'POST';
    const started = now();
    return new Promise((resolve, reject) => {
      const req = http.request({ ...where, path, method, headers: {
        'x-it-token': info.token, 'content-type': 'application/json', ...(text === undefined ? {} : { 'content-length': Buffer.byteLength(text) }),
      } }, res => {
        const pieces = []; let bytes = 0;
        res.on('data', piece => { bytes += piece.length; if (bytes > 1024 * 1024) req.destroy(); else pieces.push(piece); });
        res.on('error', () => reject(fail('connector_response_failed')));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(pieces).toString('utf8');
            if (res.statusCode !== 200) throw fail('connector_status_failed');
            const value = JSON.parse(raw); const ended = now();
            resolve({ value, started, ended, ms: ended - started });
          } catch { reject(fail('connector_response_invalid')); }
        });
      });
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => reject(fail('connector_request_failed')));
      req.on('close', () => { if (!req.res?.complete) reject(fail('connector_request_incomplete')); });
      if (text !== undefined) req.write(text);
      req.end();
    });
  };
}

/**
 * Select the isolated stand-in app, then drain old benchmark clicks before timing new ones.
 * The service must have been started with common.mjs's isolated app environment.
 * No real app or model is needed, matching the e2e stand-in's /clicks contract.
 */
export async function prepareClickFixture({ token, timeoutMs = 20000 } = {}) {
  return exclusive(async () => {
    const auth = await machineToken(token);
    const ask = await connectorClient();
    const me = (await call(auth, 'query', 'machines:me', {})).value;
    if (!me || !Array.isArray(me.wanted)) throw fail('machine_fixture_invalid');
    const alreadyChosen = me.wanted.includes(SESSION.harness);
    if (!alreadyChosen) await call(auth, 'mutation', 'machines:choose', {
      harnesses: [...me.wanted, SESSION.harness], system: process.platform,
    });
    let drained = 0, empty = 0, polls = 0;
    const end = now() + timeoutMs;
    while (now() < end) {
      const response = await ask(`/clicks?harness=${SESSION.harness}&session=${encodeURIComponent(SESSION.id)}`);
      polls++;
      const clicks = response.value?.clicks;
      if (!Array.isArray(clicks)) throw fail('connector_clicks_invalid');
      if (clicks.some(c => c.artifact !== 'perf-00' || c.name !== 'ping')) throw fail('unexpected_fixture_click');
      if (clicks.length) {
        const ack = await ask('/ack', { ids: clicks.map(c => c.id) });
        if (ack.value?.acked !== clicks.length) throw fail('fixture_ack_failed');
        drained += clicks.length; empty = 0;
      } else empty++;
      const health = (await ask('/health')).value;
      const listening = health.sessions?.includes(`${SESSION.harness}:${SESSION.id}`) === true;
      if (listening && empty >= 2) {
        const waiting = (await call(auth, 'query', 'delivery:waitingFor', { session: SESSION })).value;
        if (Array.isArray(waiting) && waiting.length === 0) return { selected: true, alreadyChosen, listening, drained, polls };
      }
      await sleep(1000);
    }
    throw fail('fixture_listener_not_ready');
  });
}

/** This measures only the connector socket and health handler, never click delivery. */
export async function runConnectorProbe({ iterations = 20, warmup = 3 } = {}) {
  return exclusive(async () => {
    count(iterations); count(warmup, 20);
    const ask = await connectorClient();
    for (let i = 0; i < warmup; i++) await ask('/health');
    const samples = [];
    for (let i = 0; i < iterations; i++) samples.push((await ask('/health')).ms);
    return { kind: 'connector_socket_probe', route: '/health', wallMs: summarize(samples),
      samplesMs: samples.map(rounded), includesPollingWait: false, includesClickDelivery: false };
  });
}

async function frameClock(button) {
  const calibrations = [];
  for (let i = 0; i < 7; i++) {
    const before = now();
    const remote = await button.evaluate(() => performance.timeOrigin + performance.now());
    const after = now();
    calibrations.push({ offset: (before + after) / 2 - remote, uncertainty: (after - before) / 2 });
  }
  return calibrations.sort((a, b) => a.uncertainty - b.uncertainty)[0];
}

/** Requires the already paired page to show perf-00 with its live #send button. */
export async function runClickDelivery({ page, iterations = 10, warmup = 2, frameSelector = '.mount iframe',
  buttonSelector = '#send', timeoutMs = 15000, phasesMs = [50, 250, 450, 650, 850] } = {}) {
  return exclusive(async () => {
    count(iterations, 50); count(warmup, 5);
    if (!page || !/^http:\/\/(localhost|127\.0\.0\.1):4930(?:\/|$)/.test(page.url())) throw fail('isolated_paired_page_required');
    if (!Array.isArray(phasesMs) || !phasesMs.length || phasesMs.some(p => !Number.isFinite(p) || p < 0 || p >= 1000)) throw fail('invalid_poll_phases');
    const button = page.frameLocator(frameSelector).locator(buttonSelector);
    const marker = `__it_bench_${randomBytes(6).toString('hex')}`;
    let ask, clock;
    try {
      await button.waitFor({ state: 'visible', timeout: timeoutMs });
      clock = await frameClock(button);
      ask = await connectorClient();
      await button.evaluate((el, key) => {
        const record = { at: null, trusted: false, handler: null };
        record.handler = event => { record.at = performance.timeOrigin + performance.now(); record.trusted = event.isTrusted; };
        window[key] = record; el.addEventListener('click', record.handler, true);
      }, marker);
    } catch { throw fail('click_measurement_setup_failed'); }

    const polls = []; const delivered = new Set(); const rows = [];
    let stopped = false, timer, inflight = Promise.resolve(), fatal, pending;
    const origin = now(); let tick = 0;
    const route = `/clicks?harness=${SESSION.harness}&session=${encodeURIComponent(SESSION.id)}`;
    const poll = () => {
      const planned = origin + tick * 1000;
      inflight = (async () => {
        const response = await ask(route);
        if (!Array.isArray(response.value?.clicks)) throw fail('connector_clicks_invalid');
        const clicks = response.value.clicks;
        polls.push({ start: response.started, end: response.ended, ms: response.ms, late: response.started - planned });
        const fresh = clicks.filter(c => !delivered.has(c.id));
        if (fresh.some(c => c.artifact !== 'perf-00' || c.name !== 'ping') || fresh.length > 1) throw fail('unexpected_click_delivery');
        if (fresh.length) {
          if (!pending) throw fail('preexisting_click_delivery');
          const click = fresh[0];
          delivered.add(click.id);
          const target = pending;
          target.delivery = { at: response.ended, pollStart: response.started, pollMs: response.ms, backendAt: click.at };
          const ack = await ask('/ack', { ids: [click.id] });
          if (ack.value?.acked !== 1) throw fail('click_ack_failed');
          target.ackMs = ack.ms;
          target.done = true;
        }
      })().catch(error => { fatal = fail(error?.code ?? 'connector_poll_failed'); }).finally(() => {
        tick = Math.max(tick + 1, Math.floor((now() - origin) / 1000) + 1);
        if (!stopped && !fatal) timer = setTimeout(poll, Math.max(0, origin + tick * 1000 - now()));
      });
    };
    const until = async predicate => {
      const end = now() + timeoutMs;
      while (!predicate()) {
        if (fatal) throw fatal;
        if (now() >= end) throw fail('click_delivery_timeout');
        // This only checks memory; it never probes the connector between scheduled polls.
        await sleep(5);
      }
      if (fatal) throw fatal;
    };
    poll();
    try {
      await until(() => polls.length >= 2);
      for (let i = 0; i < iterations + warmup; i++) {
        const phase = phasesMs[(i < warmup ? i : i - warmup) % phasesMs.length];
        const next = origin + (Math.floor((now() - origin) / 1000) + 1) * 1000 + phase;
        await sleep(next - now());
        if (fatal) throw fatal;
        const sample = { done: false }; pending = sample;
        await button.evaluate((_, key) => { window[key].at = null; }, marker);
        sample.commandAt = now();
        try { await button.click({ timeout: timeoutMs }); } catch { throw fail('browser_click_failed'); }
        const event = await button.evaluate((_, key) => ({ at: window[key].at, trusted: window[key].trusted }), marker);
        if (!event.trusted || typeof event.at !== 'number') throw fail('trusted_click_not_observed');
        const clickAt = event.at + clock.offset;
        await until(() => sample.done);
        const delivery = sample.delivery;
        const previousPoll = polls.filter(p => p.start <= clickAt).at(-1);
        const row = {
          targetPhaseMs: phase, observedPhaseMs: rounded(((clickAt - origin) % 1000 + 1000) % 1000),
          clickToDeliveryMs: rounded(delivery.at - clickAt), commandToDeliveryMs: rounded(delivery.at - sample.commandAt),
          clickToDeliveringPollStartMs: rounded(delivery.pollStart - clickAt), deliveringPollMs: rounded(delivery.pollMs),
          sincePreviousPollStartMs: previousPoll ? rounded(clickAt - previousPoll.start) : null,
          backendAcceptedToDeliveryMs: typeof delivery.backendAt === 'number' ? rounded(delivery.at - delivery.backendAt) : null,
          ackRequestMs: rounded(sample.ackMs),
        };
        if (i >= warmup) rows.push(row);
        pending = null;
      }
      return {
        kind: 'click_to_polling_addon', pollEveryMs: 1000, schedule: 'fixed cadence, missed ticks skipped, requests never overlap',
        warmup, iterations, frameClockUncertaintyMs: rounded(clock.uncertainty),
        clickToDeliveryMs: summarize(rows.map(r => r.clickToDeliveryMs)),
        deliveringPollMs: summarize(rows.map(r => r.deliveringPollMs)), ackRequestMs: summarize(rows.map(r => r.ackRequestMs)),
        pollIntervalsMs: summarize(polls.slice(1).map((p, i) => p.start - polls[i].start)),
        pollLatenessMs: summarize(polls.map(p => p.late)), rows,
        deliveryBoundary: 'Complete connector response parsed in the stand-in add-on; no model turn or application queue is measured.',
        ackBoundary: 'Connector acknowledgement response; asynchronous backend handoff confirmation is not awaited.',
      };
    } finally {
      stopped = true; clearTimeout(timer); await inflight;
      try { await button.evaluate((el, key) => { const r = window[key]; if (r) el.removeEventListener('click', r.handler, true); delete window[key]; }, marker); } catch {}
    }
  });
}
