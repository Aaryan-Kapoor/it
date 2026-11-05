import { expect, test } from 'vitest'
import { ADDON_API, AddonRuntimes } from './src/addon-runtime'
import { ADDONS } from './src/addons.generated'

test.each(Object.keys(ADDONS))('%s reports its loaded build and required APIs independently of installation.', (app) => {
  const seen = new AddonRuntimes()
  const report = { api: ADDON_API, version: ADDONS[app]!.build, delivery: true, idle: true }
  expect(seen.status(app, 0).state).toBe('inactive')
  expect(seen.hear(app, 'one', report, 0)).toMatchObject({ state: 'active' })
  expect(seen.hear(app, 'one', report, 0)?.outdated).toBeUndefined()
  expect(seen.status(app, 29_000).version).toBe(report.version)
  expect(seen.status(app, 30_000).state).toBe('inactive')
  expect(seen.hear(app, 'one', { ...report, delivery: false }, 31_000)?.detail).toMatch(/missing a delivery API/)
  expect(seen.blocksWake(app, 31_000)).toBe(true)
  expect(seen.hear(app, 'one', { ...report, api: 999 }, 32_000)?.detail).toMatch(/different delivery APIs/)
  expect(seen.hear(app, 'two', report, 32_000)?.state).toBe('active')
  expect(seen.status(app, 32_000).state).toBe('incompatible')
})

test.each(Object.keys(ADDONS))(
  'an earlier build of the %s add-on that speaks the same delivery API is active, holds back no reopening, and says that a restart of the app loads the build installed',
  (app) => {
    const seen = new AddonRuntimes()
    const current = { api: ADDON_API, version: ADDONS[app]!.build, delivery: true, idle: true }
    const earlier = { ...current, version: 'earlier-build' }
    expect(seen.hear(app, 'old', earlier, 0)).toMatchObject({ state: 'active', idle: true, outdated: true, version: 'earlier-build' })
    expect(seen.status(app, 0).detail).toMatch(/earlier build of It’s add-on than the one installed, and it still takes clicks\. Restart the app/)
    expect(seen.blocksWake(app, 0)).toBe(false)
    // A process of the current build beside it does not hide that one still wants the app restarted
    seen.hear(app, 'new', current, 1000)
    expect(seen.status(app, 1000)).toMatchObject({ state: 'active', outdated: true })
    // Once the earlier one has gone quiet, the app is up to date
    expect(seen.status(app, 30_500)).toMatchObject({ state: 'active' })
    expect(seen.status(app, 30_500).outdated).toBeUndefined()
    // Missing what it needs to hand a click over, or another API, it is refused whatever its build
    expect(seen.hear(app, 'old', { ...earlier, delivery: false }, 31_000)?.state).toBe('incompatible')
    expect(seen.hear(app, 'old', { ...earlier, api: ADDON_API + 1 }, 31_000)?.state).toBe('incompatible')
  },
)

test('An open host without idle discovery blocks reopening without inventing a session.', () => {
  const seen = new AddonRuntimes()
  for (const app of ['hermes', 'opencode']) {
    seen.hear(app, 'one', { api: ADDON_API, version: ADDONS[app]!.build, delivery: true, idle: false }, 0)
    expect(seen.status(app, 0).detail).toMatch(/Open the conversation and send a message in it to start listening/)
    expect(seen.blocksWake(app, 0)).toBe(true)
    expect(seen.blocksWake(app, 30_000)).toBe(false)
  }
  expect(seen.hear('codex', 'bad instance!', {}, 0)).toBeUndefined()
})

test.each(['idle', 'incompatible'])('Evicting a recent %s report keeps its wake hold until the report expires.', (reason) => {
  const seen = new AddonRuntimes()
  const report = { api: ADDON_API, version: ADDONS.opencode!.build, delivery: true, idle: true }
  seen.hear('opencode', 'blocking', reason === 'idle' ? { ...report, idle: false } : { ...report, api: ADDON_API + 1 }, 0)
  for (let n = 0; n < 100; n++) seen.hear('opencode', `working-${n}`, report, 1000)
  expect(seen.blocksWake('opencode', 29_999)).toBe(true)
  expect(seen.status('opencode', 29_999)).toMatchObject({ state: 'unverified', idle: false })
  expect(seen.blocksWake('opencode', 30_000)).toBe(false)
  expect(seen.status('opencode', 30_000).state).toBe('active')
  expect(seen.blocksWake('pi', 1000)).toBe(false)
})
