# Follow-up measurement for PR 277

This comparison checks the reported localhost regressions and the built-site CSP test failure. The product revision is `47d3489bef61f36706ae2febe4c976641ee83593`. Its only change from `ced91a21` is the test fix. After a full generation, its Node bundle is byte-for-byte identical to the original candidate. The restored baseline is also byte-for-byte identical to the original baseline. See `manifest.json`.

## What changed in the test

The test read stored gzip bytes as UTF-8. It found no script tags, and its JavaScript check could pass without inspecting executable text. It now requests identity responses from the production `answerSite` function, checks status 200 and the absence of Content-Encoding, and reads the returned text. All CSP assertions remain. The exact failure was reproduced before editing and passed afterward. Real Chromium and Firefox tests exercised both Node and Bun doors, followed by a real isolated 50-page service verification.

## Measurement protocol

The primary dataset is `results/followup.json`. It contains 12 baseline/candidate pairs, reversing order each pair, with every completed sample retained. Each block uses the same workload as the original comparison: warm service start, memory at rest, fresh Chromium on localhost, another fresh Chromium with 10 Mbps and 20 ms browser network emulation, two samples of each CLI operation, and hot backend and connector probes. Browser caches are disabled. Each CLI sample starts before spawning a new Node process. The service retains the same seeded 50-page database. Publishing republishes existing `perf-48`. Hot calls discard one warmup per operation per block.

There is at least 30 seconds between block starts. A normal grid visit, alphabetical sort, and opening create 19 mounts: nine previews, nine after sorting, and one opened page. The spacing lets the existing mount token bucket refill. No product limit or preview code changes. Builds, tests, profiling, and other benchmark traffic are not run concurrently with the primary comparison. Other agents still use this shared host. Each block retains one-second load, CPU, and free-disk samples.

The original measurements remain intact: browser navigation `loadEventEnd`, wall time to 50 cards plus a successful alphabetical sort, and `openMs` from before Playwright `.click()` until the button is visibly found and `It.onState` returns. The new browser instrumentation adds timestamps inside the document. `domClickToStateMs` runs from the captured DOM click to the frame receiving its first state. It excludes Playwright's pre-click waiting and post-readiness polling. It is a separate metric, not a replacement for the original one. `preClickMs` and `postReadyMs` compare browser and Node epoch-based performance timestamps; they are diagnostic approximations without a separate clock-calibration experiment. `clickCallMs` includes the complete Playwright click call, including prechecks and post-click handling.

The grid timestamp means the DOM has the cards and can complete the sorting interaction. It is not a paint measurement. The state timestamp means the runtime callback has received state; the original visibility check still confirms the page button is displayed before each sample completes. Browser exceptions, console errors, HTTP error status counts, and failed backend calls are recorded as counts/codes only. WebSocket observations retain function names, request timing, and success, never arguments or results.

## Controlled diagnostic experiments

`results/encoding.json` holds six interleaved gzip/identity pairs against one unchanged candidate service. Each sample starts a fresh Chromium with cache disabled. CDP changes accepted encodings; measured main-script sizes confirm 144,450 gzip bytes and 459,224 identity bytes. There are 30 seconds of initial idle time and 16 seconds between browser samples. All 12 samples completed with no failed backend calls. This separates wire encoding from server implementation and startup.

`results/site-cost.json` holds 50 measured cold-file requests per representation after ten warmups. The original serving function receives identity bytes; the new function receives the same JavaScript packed as gzip and serves either gzip or identity. Every call gets a new file object, so the WeakMap cannot reuse a decoded representation. Each returned body is checked against the identical decoded bytes. Timing includes response body reading; decompression for the assertion happens afterward. This deliberately measures the first-request decode cost, not the cheaper cached path. It excludes CLI module loading and networking.

`results/diagnose.json` retains the initial exploratory 12-block trace. Its short intervals exhausted the mount token bucket in four blocks, which introduced the existing five-second remount delay. It is not used for primary latency claims. One brief local text-comparison process also overlapped that exploratory trial. `results/encoding-interrupted.json` retains the two samples completed before the user interrupted the turn. That incomplete trial is not pooled into the completed encoding comparison. The orphaned isolated backend was stopped before restarting the entire encoding experiment. No selected samples were removed from a completed primary or controlled encoding comparison.

The final comparison retains a candidate outlier of 2.89 seconds for service start and 3.29 seconds for the grid. Its site load was 67 ms, and backend responses took up to 2.63 seconds. Its service-process startup CPU was 250 ms. These observations do not identify the precise backend-delay cause or prove tail-latency equivalence. `paired.json` contains all per-pair differences and a 10,000-replicate percentile bootstrap for the paired median, with fixed seed 277. It is a descriptive uncertainty estimate from twelve pairs, not proof of equivalence.

The original six-pair results remain at the parent verification directory. Lower absolute times in this follow-up must not be treated as additional product improvements: the machine's load changed. Compare variants within each interleaved experiment.

## Reproduction

Use the original `../benchmark/README.md` instructions to prepare Node 24, the real cached backend, the isolated stand-in apps, the two immutable bundles, and 50 pages. Build baseline `71b888ac` and candidate `47d3489b` sequentially in the same disposable source path. Record both bundle hashes and verify that their backend deployment hashes match before alternating service starts. The supplied hashes identify this machine's exact generated bundles; generated source maps can make hashes differ in another source directory.

Copy the supplied `benchmark/` scripts to `/tmp/it-perf/bench`. Set `IT_BENCH_ROOT` to the repository and `IT_BACKEND_BIN` to the cached executable outside the owner's service folder. The runners use only `/tmp/it-perf/service`, stand-in apps under `/tmp/it-perf/apps`, and ports 4930, 4931, 4970, and 4971. Use a fresh service folder and pairing state for a new reproduction. Never use the owner's `~/.it` or running service.

Run these commands sequentially after building both bundles. No builds or tests should overlap the measurements.

```sh
node /tmp/it-perf/bench/setup.mjs
node /tmp/it-perf/bench/seed.mjs
node /tmp/it-perf/bench/encoding.mjs
node /tmp/it-perf/bench/site-cost.mjs
node /tmp/it-perf/bench/followup.mjs
python3 /tmp/it-perf/bench/summarize-followup.py /tmp/it-perf/bench/followup.json
```

The isolated first pairing is outside the timed browser navigation. The exploratory `diagnose.mjs` is provided to explain its retained trace, but is not required for the primary comparison. The source of the site-cost experiment uses `IT_BENCH_ROOT` or the current directory for repository imports. All summary quartiles use linear interpolation at `(n - 1) * p`. Host CPU busy sums the first eight `/proc/stat` counter deltas, subtracting idle and iowait, and excludes gaps between blocks. Startup process CPU has 10 ms resolution and excludes the backend child.

Keep service records, pairing state, raw runtime logs, binaries, and CPU profiles private. Publish only the reviewed numerical results, runner source, test report, and screenshots. Close browsers and stop each owned service by its process handle before deleting the isolated folder. The supplied runners stop their service in `finally`; an externally killed parent can still leave its backend, so inspect only the owned folder and ports after an interruption.
