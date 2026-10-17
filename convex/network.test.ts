/// <reference types="vite/client" />
// What the backend keeps about the network: the service says whether its door answers other
// devices and at which addresses, and only the owner's browser is told.
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { ASKED_FOR_MS } from './network'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

const LAN = 'http://192.168.1.20:39000'
const SIX = 'http://[fd7a:115c:a1e0::ab12:4843]:39000'

/** A backend with the one person, and what each kind of caller calls it as: a machine, the owner's browser and a screen. */
async function household() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const browser = (role: 'owner' | 'screen') =>
    t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      const now = Date.now()
      const session = await ctx.db.insert('sessions', {
        userId: user._id,
        secretHash: `no-secret-${role}`,
        role,
        createdAt: now,
        lastSeenAt: now,
        cookieAt: now,
      })
      return { user: user._id as string, session: session as string }
    })
  const as = async (role: 'owner' | 'screen') => {
    const { user, session } = await browser(role)
    return t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role })
  }
  return { t, machine: t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' }), owner: await as('owner'), screen: await as('screen') }
}
/** A refusal's code, or `ok`. What a refusal carries arrives as text, sometimes inside text. */
const refusal = (asked: Promise<unknown>) =>
  asked.then(
    () => 'ok',
    (err) => /code\\*":\\*"([a-z_]+)/.exec(`${JSON.stringify((err as { data?: unknown }).data)} ${String(err)}`)?.[1] ?? String(err),
  )
const rows = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query('network').collect())

let written: string[]
beforeEach(() => {
  written = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void written.push(line))
})
afterEach(() => vi.restoreAllMocks())

describe('what the service says of its door', () => {
  test('until it has said anything, the network is off and there are no addresses', async () => {
    const { t, owner } = await household()
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: false, addresses: [] })
    expect(await t.query(internal.network.current, {})).toEqual({ on: false, wanted: false, addresses: [] })
  })

  test('the command reads only the applied policy, including its absence in an older service report', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN], tailnet: false, canTailnet: true })
    expect(await t.query(internal.network.current, {})).toMatchObject({ on: true, tailnet: false })
    await owner.mutation(api.network.ask, { to: 'tailscale' })
    expect(await t.query(internal.network.current, {})).toMatchObject({ tailnet: false })
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN], tailnet: true })
    expect(await t.query(internal.network.current, {})).toMatchObject({ on: true, tailnet: true })
    await t.mutation(internal.network.report, { on: false, wanted: false, addresses: [], tailnet: true })
    expect(await t.query(internal.network.current, {})).toMatchObject({ on: false, tailnet: false })
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN] })
    expect(await t.query(internal.network.current, {})).not.toHaveProperty('tailnet')
  })

  test('is what the owner’s browser and the command are told, in the order it was said, and there is one record of it however often it is said', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN, SIX] })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: true, addresses: [LAN, SIX] })
    expect(await t.query(internal.network.current, {})).toEqual({ on: true, wanted: true, addresses: [LAN, SIX] })
    // The machine moves to another network
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: ['http://10.0.0.20:39000'] })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: true, addresses: ['http://10.0.0.20:39000'] })
    // Turned off, no address is given, whatever was sent with the word
    await t.mutation(internal.network.report, { on: false, wanted: false, addresses: [LAN] })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: false, addresses: [] })
    expect((await rows(t)).length).toBe(1)
  })

  test('said again as it already stands, nothing is written, so that nothing that reads it runs again', async () => {
    const { t } = await household()
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN] })
    const [first] = await rows(t)
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN] })
    expect(await rows(t)).toEqual([first])
    expect(written.filter((line) => line.includes('network.reported')).length).toBe(1)
  })

  test('a door that was asked to listen on the network and could not is said to be off, and to have been asked: the command is told both, the owner’s browser that it is off', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, { on: false, wanted: true, addresses: [LAN] })
    expect(await t.query(internal.network.current, {})).toEqual({ on: false, wanted: true, addresses: [] })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: false, addresses: [] })
  })

  test('only whole addresses over plain http are kept, each once, and no more than a few', async () => {
    const { t, owner } = await household()
    const not = [
      'https://192.168.1.20:39000',
      'http://192.168.1.20',
      'http://192.168.1.20:39000/pair',
      'http://192.168.1.20:39000/',
      'http://user@192.168.1.20:39000',
      'javascript:alert(1)',
      'http://192.168.1.20:39000 onclick=x',
      '<b>http://192.168.1.20:39000</b>',
      `http://${'a'.repeat(300)}:39000`,
      '',
    ]
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [...not, LAN, LAN, SIX, 'http://desk.local:39000'] })
    expect((await owner.query(api.network.get, {})).addresses).toEqual([LAN, SIX, 'http://desk.local:39000'])
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: Array.from({ length: 40 }, (_, n) => `http://10.0.0.${n + 1}:39000`) })
    expect((await owner.query(api.network.get, {})).addresses.length).toBe(16)
  })

  test('what is written down says how many addresses there are, and never which', async () => {
    const { t } = await household()
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN, SIX] })
    expect(written.filter((line) => line.includes('network.reported'))).toEqual([
      JSON.stringify({ event: 'network.reported', on: true, wanted: true, addresses: 2 }),
    ])
    expect(written.join('\n')).not.toMatch(/192\.168|fd7a/)
  })
})

describe('what the service says of itself', () => {
  const stands = { on: false, wanted: false, addresses: [] }

  test('until it has said, neither is known, and the port everything is counted from is', async () => {
    const { t, owner } = await household()
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: null, usage: null })
    // A service that says only how its door stands leaves both unsaid
    await t.mutation(internal.network.report, { ...stands, on: true, wanted: true, addresses: [LAN] })
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: null, usage: null })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: true, addresses: [LAN] })
  })

  test('whether It starts by itself and whether counts of its use are sent are told to the owner’s browser as the service said them last', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, { ...stands, background: false, usage: false })
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: false, usage: false })
    await t.mutation(internal.network.report, { ...stands, background: true, usage: false })
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: true, usage: false })
    await t.mutation(internal.network.report, { ...stands, background: true, usage: true })
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: true, usage: true })
    // Said once more with one left out, that one is unsaid again
    await t.mutation(internal.network.report, { ...stands, usage: true })
    expect(await owner.query(api.network.service, {})).toEqual({ port: 39000, background: null, usage: true })
    expect((await rows(t)).length).toBe(1)
    // The door's own word is as it was throughout
    expect(await t.query(internal.network.current, {})).toEqual(stands)
  })

  test('said again as it already stands, nothing is written, and a change in either is', async () => {
    const { t } = await household()
    await t.mutation(internal.network.report, { ...stands, background: true, usage: true })
    const [first] = await rows(t)
    await t.mutation(internal.network.report, { ...stands, background: true, usage: true })
    expect(await rows(t)).toEqual([first])
    await t.mutation(internal.network.report, { ...stands, background: true, usage: false })
    expect((await rows(t))[0]).toMatchObject({ background: true, usage: false })
    expect(written.filter((line) => line.includes('network.reported')).map((line) => JSON.parse(line))).toEqual([
      { event: 'network.reported', on: false, wanted: false, addresses: 0, background: true, usage: true },
      { event: 'network.reported', on: false, wanted: false, addresses: 0, background: true, usage: false },
    ])
  })

  test('it is the owner’s to be told, and nobody else’s', async () => {
    const { t, owner, screen, machine } = await household()
    await t.mutation(internal.network.report, { ...stands, background: true, usage: true })
    expect(await refusal(owner.query(api.network.service, {}))).toBe('ok')
    expect(await refusal(screen.query(api.network.service, {}))).toBe('forbidden')
    expect(await refusal(machine.query(api.network.service, {}))).toBe('forbidden')
    expect(await refusal(t.query(api.network.service, {}))).toBe('unauthenticated')
  })
})

describe('who is told', () => {
  test('the owner’s browser is, and a paired screen, a machine and a browser that is not paired are not', async () => {
    const { t, owner, screen, machine } = await household()
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN] })
    expect(await refusal(owner.query(api.network.get, {}))).toBe('ok')
    expect(await refusal(screen.query(api.network.get, {}))).toBe('forbidden')
    expect(await refusal(machine.query(api.network.get, {}))).toBe('forbidden')
    expect(await refusal(t.query(api.network.get, {}))).toBe('unauthenticated')
  })
})

describe('the network as a switch on the site', () => {
  const told = { on: false, wanted: false, addresses: [] as string[], tailnet: false, canTailnet: false }
  // The clock is held: an asking is told with when it was made, and one that waited too long is let go of
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('until the service has said, the site is told nothing it could offer a switch by', async () => {
    const { owner } = await household()
    expect(await owner.query(api.network.get, {})).toEqual({
      on: false,
      addresses: [],
      tailnet: false,
      canTailnet: null,
      exposed: null,
      asked: null,
      answered: null,
    })
  })

  test('what the owner asks waits for the service, is taken up, and stays until it is answered with what became of it', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, told)
    expect(await t.query(internal.network.waiting, {})).toBeNull()
    // The asking is given a name, which is when it was made, and that is what its answer is known by
    const { asked } = await owner.mutation(api.network.ask, { to: 'on' })
    expect(asked).toBe(Date.now())
    expect((await owner.query(api.network.get, {})).asked).toEqual({ to: 'on', at: asked })
    expect(await t.query(internal.network.waiting, {})).toEqual({ to: 'on', at: asked })
    // Taken up: the service has it, and it stays here, as taken, until the service has answered for it
    expect(await t.mutation(internal.network.taken, {})).toEqual({ to: 'on', at: asked })
    expect(await t.query(internal.network.waiting, {})).toEqual({ to: 'on', at: asked, taken: true })
    // A service that could not answer for it, and asks again, is given the same asking and not a second one
    expect(await t.mutation(internal.network.taken, {})).toEqual({ to: 'on', at: asked })
    // The door is open, and the service says so and that it is what was asked: only now is the asking done with
    await t.mutation(internal.network.report, { ...told, on: true, wanted: true, addresses: [LAN] })
    await t.mutation(internal.network.answer, { asked, to: 'on', ok: true })
    expect(await t.query(internal.network.waiting, {})).toBeNull()
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: true, addresses: [LAN], asked: null, answered: { to: 'on', ok: true, asked } })
    // What it says of the door afterwards leaves what was asked and answered as it is
    await t.mutation(internal.network.report, { ...told, on: true, wanted: true, addresses: [LAN, SIX] })
    expect((await owner.query(api.network.get, {})).answered).toMatchObject({ to: 'on', ok: true, asked })
    expect(await rows(t)).toHaveLength(1)
  })

  test('an asking takes the place of one that still waits, each has a name of its own, and an answer for the one before does not end the one after', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, told)
    const first = (await owner.mutation(api.network.ask, { to: 'on' })).asked
    await t.mutation(internal.network.taken, {})
    // Asked again, in the same moment, from another tab: another asking, under another name, not yet taken
    const second = (await owner.mutation(api.network.ask, { to: 'off' })).asked
    expect(second).toBeGreaterThan(first)
    expect(await t.query(internal.network.waiting, {})).toEqual({ to: 'off', at: second })
    // The service answers for the first, which it had taken: the second still waits, and is taken up next
    await t.mutation(internal.network.answer, { asked: first, to: 'on', ok: true })
    expect(await owner.query(api.network.get, {})).toMatchObject({ asked: { to: 'off', at: second }, answered: { asked: first } })
    expect(await t.mutation(internal.network.taken, {})).toEqual({ to: 'off', at: second })
    await t.mutation(internal.network.answer, { asked: second, to: 'off', ok: true })
    expect(await owner.query(api.network.get, {})).toMatchObject({ asked: null, answered: { to: 'off', ok: true, asked: second } })
  })

  test('one that waited too long without being taken up is not carried out, and one that was taken up is never let go of unanswered', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, told)
    const late = (await owner.mutation(api.network.ask, { to: 'on' })).asked
    vi.advanceTimersByTime(ASKED_FOR_MS + 1)
    // The service was not there to take it: by now the person may have forgotten it
    expect(await t.mutation(internal.network.taken, {})).toBeNull()
    expect(await owner.query(api.network.get, {})).toMatchObject({ asked: null, answered: { to: 'on', ok: false, why: 'too_late', asked: late } })
    // Taken up in time, and then the backend could not be told for a long while: it is still the service's to answer for
    const kept = (await owner.mutation(api.network.ask, { to: 'on' })).asked
    await t.mutation(internal.network.taken, {})
    vi.advanceTimersByTime(ASKED_FOR_MS * 3)
    expect(await t.mutation(internal.network.taken, {})).toEqual({ to: 'on', at: kept })
  })

  test('the tailnet is offered only where the service says the machine is on one, and why "on" would mean the internet is passed on', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, told)
    expect(await refusal(owner.mutation(api.network.ask, { to: 'tailscale' }))).toBe('invalid')
    await t.mutation(internal.network.report, { ...told, canTailnet: true, exposed: 'has a public address (203.0.113.7)' })
    expect(await owner.query(api.network.get, {})).toMatchObject({ canTailnet: true, exposed: 'has a public address (203.0.113.7)' })
    expect(await refusal(owner.mutation(api.network.ask, { to: 'tailscale' }))).toBe('ok')
    // Kept to the tailnet, the door says so, and only while it is open
    await t.mutation(internal.network.report, { ...told, on: true, wanted: true, addresses: [LAN], tailnet: true, canTailnet: true })
    expect((await owner.query(api.network.get, {})).tailnet).toBe(true)
  })

  test('only the owner’s browser asks: a screen, a machine and a stranger are refused, and one asked before the service ever spoke is kept for it', async () => {
    const { t, owner, screen, machine } = await household()
    expect(await refusal(screen.mutation(api.network.ask, { to: 'on' }))).toBe('forbidden')
    expect(await refusal(machine.mutation(api.network.ask, { to: 'on' }))).toBe('forbidden')
    expect(await refusal(t.mutation(api.network.ask, { to: 'on' }))).toBe('unauthenticated')
    expect(await rows(t)).toEqual([])
    await owner.mutation(api.network.ask, { to: 'on' })
    expect(await rows(t)).toMatchObject([{ on: false, wanted: false, addresses: [], asked: { to: 'on' } }])
  })
})
