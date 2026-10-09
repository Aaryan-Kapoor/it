import { configDefaults, defineConfig } from 'vitest/config'

// On Windows one group of tests is left out here, because of what the tests stand on and not
// because of what they test. Each add-on's tests start a stand-in connector that listens at a
// socket in a folder, which is how an add-on reaches the connector on Linux and macOS, and
// nothing can listen at such a path on Windows. The add-ons' other way to the connector, a
// port, which is the way Windows uses, is tested with them on Linux and macOS. Of the rest, a
// test or a group of tests that cannot run on Windows says so itself.
const windows = process.platform === 'win32'

// Where this machine keeps its settings is nothing to any test: each test that looks at such a
// place makes a person's folder of its own and looks there. Left as the machine has it, a test
// of the service's definition would look in the folder of whoever runs the tests, and could
// write there. The tests are started without it, and one that is about it sets its own.
delete process.env.XDG_CONFIG_HOME
// Nor is the T3 Code of whoever runs the tests: a connector that a test starts would ask it for
// a session and read its threads. Every test is started with a folder for it that holds
// nothing, and one that is about T3 Code names its own.
process.env.T3CODE_HOME = '/nonexistent/no-t3-code-for-tests'

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
