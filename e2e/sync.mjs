// How soon what a page stores with It.store shows on the page's other displays, measured in real
// browsers against the stack (node e2e/stack.mjs). Three browsers are paired, the owner's and two
// screens, and all three show one page. One of them stores, as a busy page does, and each of the
// others notes when it first saw each value.
//
//   node e2e/sync.mjs                     every measurement
//   node e2e/sync.mjs burst-spread draw   only those named
//   node e2e/sync.mjs --out results.json  and the figures written to a file as well
//
// The measurements:
//   burst-spread   50 values stored over half a second, by a page that tries a refused value again a second later
//   burst-once     50 values stored at once, the same way
//   burst-naive    50 values stored over half a second by a page that does not try again: how many are lost
//   draw           a stroke stored every 200 ms for a minute, as a whiteboard does
//   draw-two       the same, drawn on two displays at once
//
// Each measurement has a page of its own, and between two of them the run waits for what It
// counts against the person to fill up again (--rest, in seconds, 40 unless it is told). For
// each display it says how long the values took to be shown there after they were stored (the
// median, the 95th in a hundred and the longest), how many were never shown, how long until all
// of them were, and how many bytes the display was sent over its live connection meanwhile.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { it, needsStack, root, sleep } from './lib.mjs'
import { APP, open } from './site.mjs'

const STACK = needsStack('Measuring how soon stored values reach other displays')
const args = process.argv.slice(2)
const option = (name, otherwise) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? otherwise : args[i + 1]
}
const out = option('out', null)
const rest = Number(option('rest', '40')) * 1000
const named = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const fixture = path.join(root, 'e2e/fixtures/sync')

const MEASURES = {
  'burst-spread': { what: '50 values over half a second, tried again when refused', write: ['burst', 'b', 50, 500, true], keys: 50, wait: 120_000 },
  'burst-once': { what: '50 values at once, tried again when refused', write: ['burst', 'b', 50, 0, true], keys: 50, wait: 120_000 },
  'burst-naive': { what: '50 values over half a second, not tried again', write: ['burst', 'b', 50, 500, false], keys: 50, wait: 15_000 },
  draw: {
    what: 'a stroke of 24 points every 200 ms for 60 seconds, tried again when refused',
    write: ['draw', 's', 200, 60_000, 24, true],
    keys: 300,
    wait: 180_000,
  },
  'draw-two': {
    what: 'a stroke every 200 ms for 60 seconds on each of two displays at once, tried again when refused',
    write: ['draw', 's', 200, 60_000, 24, true],
    two: true,
    keys: 600,
    wait: 180_000,
  },
}
const chosen = named.length ? named : Object.keys(MEASURES)
for (const name of chosen) if (!MEASURES[name]) throw new Error(`no such measurement: ${name}. One of ${Object.keys(MEASURES).join(', ')}`)

/** The frame a tab shows the page in, once It is running there and the page's state has arrived. */
async function frameIn(tab, slug, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const f of tab.frames()) {
      if (!/\/v\/\d+\/index\.html$/.test(new URL(f.url() || 'about:blank', 'http://x').pathname)) continue
      const ready = await f.evaluate((id) => window.It?.id === id && window.sync?.states > 0, slug).catch(() => false)
      if (ready) return f
    }
    await sleep(100)
  }
  throw new Error(`the page ${slug} was not shown, with its state, in the tab at ${tab.url()} within ${ms / 1000} seconds`)
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null)
const round = (ms) => (ms === null ? null : Math.round(ms))

const displays = []
/** Counts what a tab is sent over the site's live connection, from now on. */
const counted = (tab) => {
  const count = { bytes: 0 }
  tab.on('websocket', (ws) =>
    ws.on('framereceived', ({ payload }) => (count.bytes += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length)),
  )
  return count
}
const results = { at: new Date().toISOString(), site: APP, measures: {} }
try {
  console.log('Pairing three browsers: the owner’s, and two screens')
  const laptop = await open('owner')
  displays.push({ name: 'laptop', ...laptop, sent: counted(laptop.page) })
  for (const name of ['phone', 'tv']) {
    const screen = await open('screen', { owner: laptop })
    displays.push({ name, ...screen, sent: counted(screen.page) })
  }

  for (const [i, name] of chosen.entries()) {
    if (i > 0 && rest > 0) {
      console.log(`Waiting ${rest / 1000} seconds for what It counts to fill up again`)
      await sleep(rest)
    }
    const m = MEASURES[name]
    const slug = `sync-${name}-${Date.now().toString(36)}`
    await it(STACK.home, ['create', `Sync ${name}`, '--id', slug, '--dir', fixture])
    for (const d of displays) await d.page.goto(`${APP}/p/${slug}`)
    const frames = Object.fromEntries(await Promise.all(displays.map(async (d) => [d.name, await frameIn(d.page, slug)])))
    const writers = m.two ? ['laptop', 'phone'] : ['laptop']
    console.log(`${name}: ${m.what}, stored on ${writers.join(' and ')}`)
    const bytesBefore = Object.fromEntries(displays.map((d) => [d.name, d.sent.bytes]))
    const began = Date.now()
    // Each display that stores names its values apart, so that two of them never store under one name
    await Promise.all(
      writers.map((w) =>
        frames[w].evaluate(
          ([kind, ...rest]) => window.sync[kind](...rest),
          m.write.map((x, j) => (j === 1 && m.two ? `${x}${w}-` : x)),
        ),
      ),
    )
    // Waited for until every display has every value, or the time is up
    const allSeen = async () => {
      for (const f of Object.values(frames)) if ((await f.evaluate(() => Object.keys(window.sync.seen).length)) < m.keys) return false
      return true
    }
    while (Date.now() - began < m.wait && !(await allSeen())) await sleep(200)
    const read = Object.fromEntries(await Promise.all(Object.entries(frames).map(async ([n, f]) => [n, await f.evaluate(() => window.sync)])))
    const asked = Object.assign({}, ...writers.map((w) => read[w].asked))
    const keys = Object.keys(asked)
    const first = Math.min(...Object.values(asked))
    const lastAsked = Math.max(...Object.values(asked))
    const by = {}
    for (const [n, s] of Object.entries(read)) {
      // What a display stored itself is not counted for it: it is the other displays that are measured
      const theirs = keys.filter((k) => !writers.includes(n) || !(k in s.asked))
      const late = theirs.filter((k) => k in s.seen).map((k) => s.seen[k] - asked[k])
      late.sort((a, b) => a - b)
      if (!theirs.length) continue
      const missing = theirs.filter((k) => !(k in s.seen)).length
      by[n] = {
        values: theirs.length,
        shown: late.length,
        missing,
        p50: round(quantile(late, 0.5)),
        p95: round(quantile(late, 0.95)),
        max: round(late.length ? late[late.length - 1] : null),
        allShownAfterFirst: missing ? null : round(Math.max(...theirs.map((k) => s.seen[k])) - first),
        allShownAfterLast: missing ? null : round(Math.max(...theirs.map((k) => s.seen[k])) - lastAsked),
        within2s: theirs.filter((k) => k in s.seen && s.seen[k] - first <= 2000).length,
        within5s: theirs.filter((k) => k in s.seen && s.seen[k] - first <= 5000).length,
        statesReceived: s.states,
        bytesReceived: displays.find((d) => d.name === n).sent.bytes - bytesBefore[n],
      }
    }
    const refused = writers.reduce((n, w) => n + read[w].refused, 0)
    const reasons = {}
    for (const w of writers) for (const [why, n] of Object.entries(read[w].reasons)) reasons[why] = (reasons[why] ?? 0) + n
    const state = await it(STACK.home, ['state', slug])
    const stored = Object.keys(state.state?._page ?? {}).length
    results.measures[name] = { what: m.what, writers, values: keys.length, refused, reasons, storedInTheEnd: stored, revision: state.revision, displays: by }
    for (const [n, x] of Object.entries(by))
      console.log(
        `  ${n}: ${x.shown} of ${x.values} shown, the median after ${x.p50} ms, 95 in 100 after ${x.p95} ms, the longest ${x.max} ms; all of them ${x.allShownAfterFirst === null ? 'never' : `${x.allShownAfterFirst} ms after the first was stored`}; ${Math.round(x.bytesReceived / 1024)} KB received`,
      )
    console.log(`  ${refused} refusals, ${stored} values kept in the end, the state at revision ${state.revision}`)
    await it(STACK.home, ['delete', slug]).catch(() => {})
  }
} finally {
  for (const d of displays) await d.browser.close().catch(() => {})
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
}
