# Validation

Both source commits were green independently. The combined generated bundle passed `npm run generate`, `npm run check:ci`, `npm run typecheck`, and `npm run check:secrets`.

- `npx vitest run packages/cli/cli.test.ts packages/cli/command.test.ts packages/cli/publish.test.ts packages/cli/wait.test.ts packages/cli/functions.test.ts packages/cli/node.test.ts --maxWorkers=2`: 410 passed, 2 skipped, 6 files.
- `npx vitest run packages/cli/door.test.ts --maxWorkers=2`: 83 passed, 2 skipped.
- `bun test ./packages/cli/door.test.ts`: 79 passed, 8 skipped, 0 failed.
- With the real backend executable selected, `npx vitest run packages/cli/serve.test.ts packages/cli/backend.test.ts --maxWorkers=2 -t 'the backend program, started by the service|a newer backend program, and newer functions|a newer It whose functions the database refuses'`: 33 passed, 118 outside the selection.
- `node scripts/notices.mjs --check --bun`: 24 packages, unchanged notices.

The functions getter and site packing/negotiation tests failed before their fixes and passed afterward. Node door tests exercised Chromium and Firefox and both door implementations. The Node and Bun runtime versions are in the manifest. Linux was tested; macOS, Windows, oldest supported Node versions, and compiled standalone performance were not measured.

Benchmark helpers passed seven offline tests; portable copies and audit scripts passed Node syntax checks. Independent source and evidence reviews found no blockers. Publishable text was scanned with the repository credential detector.
