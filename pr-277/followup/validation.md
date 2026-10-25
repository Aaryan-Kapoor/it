# Validation at 47d3489b

The exact CI failure was reproduced with the original test: one failed, 84 outside the focused selection. The test read gzip storage as UTF-8 and found no script tags. After the fix the same focused test passed. It now obtains both HTML and JavaScript from production identity responses, checks their status and encoding, and preserves every CSP assertion. Four built JavaScript files and index.html were stored as gzip during verification.

After `npm run generate`, the candidate bundle SHA-256 remained `b4425147bf94c5fce0ba6966d704a1a5bbfec14fa848930c68deb1dab2ada70c`, identical to the original PR candidate. The final generation and all commands below exited successfully. Node was 24.22.1 and Bun was 1.3.11. Vitest used at most two workers.

```sh
npm run generate
npm run check:ci
npm run typecheck
npm run check:secrets
PLAYWRIGHT_BROWSERS_PATH=/tmp/it-perf/door-ci/browsers-chromium \
  node node_modules/vitest/vitest.mjs run \
  packages/cli/door.test.ts packages/cli/functions.test.ts packages/cli/node.test.ts --maxWorkers=2
PLAYWRIGHT_BROWSERS_PATH=/tmp/it-perf/door-ci/browsers-firefox \
  node node_modules/vitest/vitest.mjs run packages/cli/door.test.ts --maxWorkers=2 \
  -t 'In Firefox, with the door opened under'
bun test ./packages/cli/door.test.ts
git diff --check
```

The first Node command passed 87 tests and skipped four. The separate Firefox command passed the two browser cases absent from that first run. Together these covered 89 distinct tests: all 83 non-network-gated door tests and six functions/Node-bundle tests. The two network-opt-in door tests were skipped. Chromium and Firefox each ran against Node and Bun door implementations. Per-browser cache directories contained symlinks to installed browsers so the suite's setup launched only one browser at a time. Chromium used Playwright's default `--disable-dev-shm-usage` argument.

Bun passed 79 tests with eight skipped and zero failures, with 1,527 assertions. The skips comprise the two network tests, four browser cases, and two browser hooks counted by Bun. Biome checked 284 files. The secret check read 431 committed files and found no credential. Final typechecking produced no diagnostics.

The full Node/Bun door tests had also passed before the final generation. Existing real-backend deployment, CLI, and notice validation is retained in the original PR evidence. No backend implementation, connector, preview allocation, display targeting, or serving code changed in this follow-up. Linux was exercised locally. The test correction is platform-independent, but macOS and Windows were not rerun locally. New CI was not polled.

The standalone real-service screenshot verification is described by `results/browser-verification.json` and `benchmark/verify-browser.mjs`. It uses the isolated service and real backend, a paired Chromium browser, 50 cards, a working sort interaction, and a page that receives runtime state through the door. Screenshots are taken outside timed benchmark samples. All owned services and browsers are stopped afterward.
