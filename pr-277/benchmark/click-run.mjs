// Start only the isolated fixture, exercise delivery, and always stop our service and browser.
import { readFileSync } from 'node:fs';
import { cli, base, candidate, startService, stopService, save, serviceHome, env, home, reachesAnApp } from './common.mjs';
import { browserRun } from './browser.mjs';
import { prepareClickFixture, runClickDelivery } from './hot.mjs';

const label = process.argv[2] ?? 'baseline';
if (!['baseline', 'candidate'].includes(label)) throw new Error('invalid_benchmark_label');
if (env.IT_HOME !== '/tmp/it-perf/service' || env.IT_PORT !== '4930' || reachesAnApp(env, home + '/apps')) {
  throw new Error('isolated_fixture_required');
}
const bundle = label === 'baseline' ? base : candidate;
let service, browser;
try {
  service = await startService(bundle, label + '-clicks');
  await cli(bundle, ['whoami']);
  const token = JSON.parse(readFileSync(serviceHome + '/token.json', 'utf8')).token;
  const fixture = await prepareClickFixture({ token });
  console.log(JSON.stringify({ fixture }));
  browser = await browserRun(bundle);
  const result = await runClickDelivery({ page: browser.page, iterations: 10, warmup: 1 });
  save(label + '-clicks', result);
  console.log(JSON.stringify({ clicks: result.clickToDeliveryMs, pollRequest: result.deliveringPollMs, cadence: result.pollIntervalsMs }));
} catch (error) {
  console.error(JSON.stringify({ error: typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'click_benchmark_failed' }));
  process.exitCode = 1;
} finally {
  try { await browser?.browser.close(); }
  finally { if (service?.p) await stopService(service.p); }
  console.log(JSON.stringify({ serviceStopped: Boolean(service?.p && service.p.exitCode !== null) }));
}
