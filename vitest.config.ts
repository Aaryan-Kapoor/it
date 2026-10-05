import { configDefaults, defineConfig } from 'vitest/config'

// On Windows one group of tests is left out here, because of what the tests stand on and not
// because of what they test. Each add-on's tests start a stand-in connector that listens at a
// socket in a folder, which is how an add-on reaches the connector on Linux and macOS, and
// nothing can listen at such a path on Windows. The add-ons' other way to the connector, a
// port, which is the way Windows uses, is tested with them on Linux and macOS. Of the rest, a
// test or a group of tests that cannot run on Windows says so itself.
const windows = process.platform === 'win32'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'backend', include: ['convex/**/*.test.ts'], environment: 'edge-runtime', server: { deps: { inline: ['convex-test'] } } } },
      { test: { name: 'dom', include: ['web/**/*.test.ts', 'packages/runtime/**/*.test.ts'], environment: 'jsdom' } },
      {
        test: {
          name: 'node',
          include: ['packages/cli/**/*.test.ts', 'packages/content/**/*.test.ts', 'addons/**/*.test.ts', 'e2e/**/*.test.mjs'],
          exclude: windows ? [...configDefaults.exclude, 'addons/*/addon.test.ts'] : configDefaults.exclude,
          environment: 'node',
          // These tests start programs, some of them many, and a runner that several files
          // share is slower than the machine a test was written on. A test that says nothing
          // of its own is given this long, and one that needs longer says so itself.
          testTimeout: 30_000,
          // No test reports usage to the real address, whatever it runs
          env: { IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' },
        },
      },
    ],
  },
})
