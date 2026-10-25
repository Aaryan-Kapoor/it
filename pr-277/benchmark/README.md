# Reproduce the performance comparison

These scripts compare baseline `71b888ac` with candidate `ced91a21`. Use Linux and Node 24. The measurements require Linux `/proc`, a Unix connector socket, and Playwright's Chromium. Use the same cached Convex backend executable for both variants. The measured backend release is `precompiled-2026-09-28-5c7cb5b`. Set `IT_BACKEND_BIN` to its executable before running any script. The scripts require this setting and refuse a backend inside the owner's service folder.

Reserve `/tmp/it-perf` and ports 4930, 4931, 4970, and 4971 for this reproduction. They are the door, content service, backend API, and backend HTTP ports. The seeded fixture uses `IT_HOME=/tmp/it-perf/service`. Cold samples use separate `/tmp/it-perf/cold-<round>-<variant>` folders. Do not reuse another run's folders or stop another run's processes.

Build both revisions before measuring. Start in a checkout containing both commits, with this benchmark directory saved at `/tmp/it-perf/evidence/benchmark`. The commands below create one disposable source checkout and preserve each built Node bundle at a separate path. The initial checks prevent replacement of existing bundles. Select Node 24 first and keep at least 4 GiB free.

```sh
set -eu
node --version
df -h /
export IT_BENCH_ROOT="${IT_BENCH_ROOT:-$PWD}"
: "${IT_BACKEND_BIN:?Set IT_BACKEND_BIN to the cached backend executable.}"
test ! -e /tmp/it-perf/source
test ! -e /tmp/it-perf/baseline/it.mjs
test ! -e /tmp/it-perf/candidate/it.mjs
mkdir -p /tmp/it-perf/baseline /tmp/it-perf/candidate /tmp/it-perf/bench /tmp/it-perf/logs
git -C "$IT_BENCH_ROOT" worktree add --detach /tmp/it-perf/source 71b888ac
cd /tmp/it-perf/source
npm ci
npm run generate
install -m 0444 packages/cli/dist/it.mjs /tmp/it-perf/baseline/it.mjs
git switch --detach ced91a21
npm ci
npm run generate
install -m 0444 packages/cli/dist/it.mjs /tmp/it-perf/candidate/it.mjs
npx playwright install chromium firefox
export IT_BENCH_ROOT="$PWD"
```

Keep both bundle files unchanged throughout the run. Record their hashes and the backend hash alongside the results. The scripts resolve repository helpers and Playwright from `IT_BENCH_ROOT`, or from the working directory when it is unset. They dynamically import those files, so the benchmark directory can remain outside the checkout.

Run the following commands sequentially in the same shell. Start with no seeded service folder, saved browser state, or cold-sample folders. `common.mjs` calls the repository's `e2e/lib.mjs` helper `itEnv`, which installs fake agent commands with `standInApps`, isolates their settings under `/tmp/it-perf/apps`, and removes real agent commands from the child PATH. It checks that isolation before starting a child. Setup uses `--none --no-service`, so it registers no background service or agent add-on.

```sh
export IT_HOME=/tmp/it-perf/service
export IT_PORT=4930
node /tmp/it-perf/evidence/benchmark/setup.mjs
node /tmp/it-perf/evidence/benchmark/seed.mjs
node /tmp/it-perf/evidence/benchmark/compare.mjs
node /tmp/it-perf/evidence/benchmark/cold.mjs
node /tmp/it-perf/evidence/benchmark/click-compare.mjs
node /tmp/it-perf/evidence/benchmark/fresh-backend.mjs
python3 /tmp/it-perf/evidence/benchmark/summarize.py \
  /tmp/it-perf/bench/compare.json \
  /tmp/it-perf/bench/cold.json \
  /tmp/it-perf/bench/click-compare.json \
  /tmp/it-perf/bench/fresh-backend.json \
  > /tmp/it-perf/evidence/summary.json
```

`seed.mjs` publishes 50 pages with `create`, which is the CLI's publish operation. It waits 1.1 seconds between publications. It then refreshes the isolated machine token and calls `prepareClickFixture` to select `claude-code`, drain any fixture clicks, and verify its stand-in listener. This selection persists for the main comparison. The comparison retains that database and republishes `perf-48`; empty state patches also advance revisions. A fresh reproduction needs a fresh fixture. Browser pairing state belongs to that fixture and cannot be reused with a different service database.

`compare.mjs` runs six baseline/candidate pairs, reversing their order each round, for 12 blocks. Each variant has six service starts and six samples of each browser mode, twelve samples of each CLI operation, and thirty retained calls per hot backend operation and connector probe. Each hot operation and probe discards one warmup per block. The service-start clock runs from process spawn until the PID-specific startup log, door health, site response, and backend HTTP health all pass. The two final immutable bundles contain identical backend functions. Alternating starts are warm restarts of the seeded service database and did not reload those functions.

Each browser run starts headless Chromium at 1440 by 900 with `--disable-dev-shm-usage`, saved pairing state, and the HTTP cache disabled. The local mode has no network shaping. The shaped mode configures 20 ms latency and 1,250,000 bytes per second in each direction. Navigation timing comes from the browser. `gridVisibleMs` ends when 50 card elements exist; it does not establish that they have painted. `gridInteractiveMs` additionally selects alphabetical sorting and observes Page 00 first. `openMs` ends when the page's button is visible and its `It.onState` callback arrives.

CLI timings cover process spawn through close. `waitTimeout` requests a 10 ms idle timeout and includes process overhead. `waitReady` follows a programmatic `It.action` call and ends when `wait` returns the action. It does not measure a trusted click or a model response. Memory is one RSS/PSS snapshot of the service and backend before the browser starts, rather than peak memory.

Hot client timings cover an HTTP request through the door, response reading, and JSON parsing. Backend execution timings are separate. Matches use request IDs when available, otherwise an inferred local time window. Ambiguous or missing matches remain explicit. Cached queries and uncached executions are reported separately. The connector `/health` probe measures a socket request, not click delivery.

`click-compare.mjs` runs two reversed-order pairs, in baseline, candidate, candidate, baseline order. Each block discards one warmup and retains five trusted browser clicks, giving ten clicks per variant. Its stand-in add-on polls once a second, with five target click phases across that interval. Delivery ends when it parses the connector response. This includes polling delay and excludes any model turn or application queue. The separate acknowledgement timing excludes asynchronous backend handoff confirmation. `click-run.mjs` is an optional single-variant runner and is not part of the comparison sequence.

`fresh-backend.mjs` runs five reversed-order pairs on the seeded fixture. It restarts the service before each block and makes one call per backend operation without warmup. These first calls are summarized separately from steady-state calls. A restart does not guarantee a cache miss, so use each operation's reported cache flag. After the timed calls and load snapshot in the first block of each variant, the runner records one diagnostic CPU profile of an actual `create` operation. That profiled publication is not a timing sample. Profiles remain under `/tmp/it-perf/profiles` and are excluded from published evidence.

`cold.mjs` runs five reversed-order pairs. Each sample starts with a new service folder, times setup, then times its first `serve`. The real cached backend excludes download time. Fresh folders do not imply cold operating-system or executable caches. After stopping its own service and waiting for exit, the runner removes that sample's folder. Startup failures stop the spawned service; a failed setup can leave its folder for inspection. No cleanup uses a saved PID or a process-name search.

Do not measure during tests, builds, profiling, compression, or another benchmark. The main comparison samples host load averages, free disk space, and `/proc/stat` about once a second. Cold, click, and fresh-backend comparisons record load averages before and after each block. The summary reports each variant's load ranges. CPU busy uses deltas of the first eight aggregate CPU counters, treats idle and iowait as idle, and excludes the guest counters already included in user and nice. It sums counter deltas within blocks, never across gaps between variants. These are whole-host measurements and can include unrelated work. Cold, click, and fresh-backend runs have no CPU-counter samples, so their CPU busy values remain absent.

`summarize.py` accepts any subset of the four completed JSON files. It rejects missing blocks, unexpected order, or missing required samples. It pools retained samples by variant, computes the standard median, and linearly interpolates quartiles at position `(n - 1) * p`. The IQR is the third quartile minus the first. It reports unmatched backend timings and cache counts without filling them in. The copied `common.mjs` uses the same quantile definition.

The scripts write raw results under `/tmp/it-perf/bench` and runtime logs under `/tmp/it-perf/logs`. Publish only the benchmark source, this README, reviewed numeric results, and charts. Keep service records, browser pairing state, logs, binaries, and profiles out of the evidence. These copies include path portability, environment checks, fresh-folder checks, and failure cleanup. Seeding also selects the stand-in app to reproduce the measured fixture state. Their measurement workloads follow the supplied runners.
