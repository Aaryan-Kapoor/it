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

test('An OpenCode that refused to load the add-on is not taken for one that took it, and holds back reopening until its add-on is heard from after the refusal.', () => {
  const seen = new AddonRuntimes()
  const report = { api: ADDON_API, version: ADDONS.opencode!.build, delivery: true, idle: false }
  // Heard from before it refused: that was another add-on, or another start of OpenCode
  seen.hear('opencode', 'before', report, 0)
  const refusedAt = Date.now() + 1000
  expect(seen.refused('opencode', refusedAt)).toBe(true)
  expect(seen.refused('opencode', refusedAt)).toBe(false)
  expect(seen.status('opencode', 0)).toMatchObject({ state: 'incompatible' })
  expect(seen.status('opencode', 0).detail).toMatch(/^OpenCode refused to load It’s add-on, as its log says/)
  expect(seen.status('opencode', 0).detail).toMatch(/Update It and OpenCode, then restart OpenCode/)
  // However long ago its last report was, since nothing of It runs in it and it may be open
  expect(seen.blocksWake('opencode', 3_600_000)).toBe(true)
  expect(seen.status('opencode', 3_600_000).state).toBe('incompatible')
  expect(seen.wakeHeld('opencode')).toMatch(/^OpenCode refused to load It’s add-on, so It did not start a second copy of a conversation that may be open in it/)
  const clock = Date.now
  try {
    Date.now = () => refusedAt + 1
    // An add-on that was running before the refusal goes on being heard from: OpenCode kept the copy it had, and refused the new one
    seen.hear('opencode', 'before', report, 5)
    expect(seen.status('opencode', 5).state).toBe('incompatible')
    expect(seen.blocksWake('opencode', 5)).toBe(true)
    // One that began after it: OpenCode loaded the add-on after all
    seen.hear('opencode', 'after', { ...report, since: refusedAt + 1 }, 10)
  } finally {
    Date.now = clock
  }
  expect(seen.status('opencode', 10)).toMatchObject({ state: 'active' })
  expect(seen.blocksWake('opencode', 31_000)).toBe(false)
  expect(seen.wakeHeld('opencode')).toBeUndefined()
  // And a refusal that is over is said to change what is said of the app
  const other = new AddonRuntimes()
  other.refused('opencode', 5)
  expect(other.refused('opencode', undefined)).toBe(true)
  expect(other.status('opencode', 0).state).toBe('inactive')
  // An app that does not say it refused is never taken to have
  expect(other.refused('pi', 5)).toBe(false)
  expect(other.blocksWake('pi', 0)).toBe(false)
})

test('An add-on that says when it began ends a refusal only where it began after it, however recently this connector first heard from it.', () => {
  const report = { api: ADDON_API, version: ADDONS.opencode!.build, delivery: true, idle: false }
  const refusedAt = Date.now() - 10_000
  // A connector started since: it hears for the first time from an add-on that was running before OpenCode refused the new one
  const seen = new AddonRuntimes()
  seen.refused('opencode', refusedAt)
  seen.hear('opencode', 'kept-running', { ...report, since: refusedAt - 60_000 }, 0)
  expect(seen.status('opencode', 0).state).toBe('incompatible')
  expect(seen.blocksWake('opencode', 0)).toBe(true)
  // Nor does one that does not say when it began, as an add-on of an earlier build does, nor one that says a time in this machine's future
  seen.hear('opencode', 'earlier-build', report, 0)
  seen.hear('opencode', 'odd-clock', { ...report, since: Date.now() + 3_600_000 }, 0)
  expect(seen.status('opencode', 0).state).toBe('incompatible')
  // One that began after the refusal ends it
  const other = new AddonRuntimes()
  other.refused('opencode', refusedAt)
  other.hear('opencode', 'loaded-since', { ...report, since: refusedAt + 1 }, 0)
  expect(other.status('opencode', 0).state).toBe('active')
  expect(other.refusedSince('opencode')).toBe(refusedAt)
})

test('a Hermes that refuses what the add-on hands it, because the person has not allowed it, is not called active, and is once they allow it', () => {
  const seen = new AddonRuntimes()
  const report = { api: ADDON_API, version: ADDONS.hermes!.build, delivery: true, idle: false, missing: [] as string[] }
  const refused = seen.hear('hermes', 'gateway', { ...report, delivery: false, missing: ['consent'] }, 0)
  expect(refused).toMatchObject({ state: 'incompatible' })
  expect(refused?.detail).toMatch(/refuses what it hands over, because that has not been allowed/)
  expect(refused?.detail).toContain('`hermes config set plugins.entries.it-bridge.allow_gateway_injection true`')
  expect(refused?.detail).not.toMatch(/missing a delivery API|Update the app/)
  expect(seen.status('hermes', 0).state).toBe('incompatible')
  expect(seen.blocksWake('hermes', 0)).toBe(true)
  // The same process, once the person has run the command: its next report says it can deliver
  expect(seen.hear('hermes', 'gateway', report, 1000)).toMatchObject({ state: 'active' })
  expect(seen.status('hermes', 1000).state).toBe('active')
})

test('an app with no such setting that says it lacks consent is told what any app that cannot deliver is told', () => {
  const seen = new AddonRuntimes()
  const said = seen.hear('pi', 'one', { api: ADDON_API, version: ADDONS.pi!.build, delivery: false, idle: true, missing: ['consent'] }, 0)
  expect(said).toMatchObject({ state: 'incompatible' })
  expect(said?.detail).toMatch(/missing a delivery API the add-on needs/)
})

test('a Hermes that lacks something besides being allowed is told what it lacks, since allowing it would not be enough', () => {
  const seen = new AddonRuntimes()
  const said = seen.hear(
    'hermes',
    'gateway',
    { api: ADDON_API, version: ADDONS.hermes!.build, delivery: false, idle: false, missing: ['consent', 'submit'] },
    0,
  )
  expect(said).toMatchObject({ state: 'incompatible' })
  expect(said?.detail).toMatch(/missing a delivery API to submit a message/)
  expect(said?.detail).not.toMatch(/allow_gateway_injection/)
})
