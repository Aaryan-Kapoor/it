import { expect, test } from 'vitest'
import { ADDON_API, AddonRuntimes } from './src/addon-runtime'
import { ADDONS } from './src/addons.generated'

test.each(Object.keys(ADDONS))('%s reports its loaded build and required APIs independently of installation.', (app) => {
  const seen = new AddonRuntimes()
  const report = { api: ADDON_API, version: ADDONS[app]!.version, delivery: true, idle: true }
  expect(seen.status(app, 0).state).toBe('inactive')
  expect(seen.hear(app, 'one', report, 0)?.state).toBe('active')
  expect(seen.status(app, 29_000).version).toBe(report.version)
  expect(seen.status(app, 30_000).state).toBe('inactive')
  expect(seen.hear(app, 'one', { ...report, delivery: false }, 31_000)?.detail).toMatch(/missing a delivery API/)
  expect(seen.blocksWake(app, 31_000)).toBe(true)
  expect(seen.hear(app, 'one', { ...report, version: 'older-loaded-build' }, 32_000)?.detail).toMatch(/different add-on version/)
  expect(seen.hear(app, 'two', report, 32_000)?.state).toBe('active')
  expect(seen.status(app, 32_000).state).toBe('incompatible')
  expect(seen.hear(app, 'one', { ...report, api: 999 }, 32_000)?.detail).toMatch(/different delivery APIs/)
})

test('An open host without idle discovery blocks reopening without inventing a session.', () => {
  const seen = new AddonRuntimes()
  for (const app of ['hermes', 'opencode']) {
    seen.hear(app, 'one', { api: ADDON_API, version: ADDONS[app]!.version, delivery: true, idle: false }, 0)
    expect(seen.status(app, 0).detail).toMatch(/Open it and send a message/)
    expect(seen.blocksWake(app, 0)).toBe(true)
    expect(seen.blocksWake(app, 30_000)).toBe(false)
  }
  expect(seen.hear('codex', 'bad instance!', {}, 0)).toBeUndefined()
})
