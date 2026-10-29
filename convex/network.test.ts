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

describe('over https on the tailnet', () => {
  test('the address over https is offered first, whether or not the network is on, and only a name is kept', async () => {
    const { t, owner } = await household()
    const SECURE = 'https://studio.tail1234.ts.net:39000'
    await t.mutation(internal.network.report, { on: false, wanted: false, addresses: [], https: 'studio.tail1234.ts.net' })
    expect(await owner.query(api.network.get, {})).toMatchObject({ on: false, addresses: [SECURE], https: 'studio.tail1234.ts.net' })
    // The command waits on this to know the service has taken it
    expect(await t.query(internal.network.current, {})).toMatchObject({ addresses: [SECURE], https: 'studio.tail1234.ts.net' })
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN], https: 'studio.tail1234.ts.net' })
    expect((await owner.query(api.network.get, {})).addresses).toEqual([SECURE, LAN])
    // What is no name is not kept, and is not made into an address
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN], https: 'evil.example/x?' })
    expect(await owner.query(api.network.get, {})).toMatchObject({ addresses: [LAN], https: null })
    // Taken away, it is offered no more
    await t.mutation(internal.network.report, { on: true, wanted: true, addresses: [LAN] })
    expect((await owner.query(api.network.get, {})).addresses).toEqual([LAN])
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
      https: null,
      tailnet: false,
      canTailnet: null,
      exposed: null,
      asked: null,
      answered: null,
      link: 'local',
      links: { local: 'http://localhost:39000' },
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

describe('where the links agents give are', () => {
  /** A name on a tailnet, made up for these tests, and the machine's address there. */
  const NAME = 'studio.tail1234.ts.net'
  const NAMED = `http://${NAME}:39000`
  const TAIL = 'http://100.101.102.103:39000'
  const HERE = 'http://localhost:39000'
  const PLACES = ['local', 'tailnet', 'network'] as const
  /** What the service says under each network setting, and the places the links can then be at, each at its address. */
  const settings = [
    { as: 'off', said: { on: false, wanted: false, addresses: [], tailnet: false, canTailnet: true, tailnetName: NAME }, links: { local: HERE } },
    {
      as: 'kept to the tailnet, with its name known',
      said: { on: true, wanted: true, addresses: [NAMED, TAIL], tailnet: true, canTailnet: true, tailnetName: NAME },
      links: { local: HERE, tailnet: NAMED },
    },
    {
      as: 'kept to the tailnet, with no name for it',
      said: { on: true, wanted: true, addresses: [TAIL], tailnet: true, canTailnet: true },
      links: { local: HERE },
    },
    {
      as: 'on for every network, on a machine that is on a tailnet',
      said: { on: true, wanted: true, addresses: [LAN, TAIL], tailnet: false, canTailnet: true, tailnetName: NAME },
      links: { local: HERE, tailnet: NAMED, network: LAN },
    },
    {
      as: 'on for every network, on a machine on no tailnet',
      said: { on: true, wanted: true, addresses: [LAN], tailnet: false, canTailnet: false },
      links: { local: HERE, network: LAN },
    },
    { as: 'on, with the machine on no network', said: { on: true, wanted: true, addresses: [], tailnet: false, canTailnet: false }, links: { local: HERE } },
    // Over https through Tailscale, the tailnet's links are there whether or not the network is on
    {
      as: 'off, answering the tailnet over https',
      said: { on: false, wanted: false, addresses: [], tailnet: false, canTailnet: true, https: NAME },
      links: { local: HERE, tailnet: `https://${NAME}:39000` },
    },
    {
      as: 'on for every network, answering the tailnet over https too',
      said: { on: true, wanted: true, addresses: [LAN, TAIL], tailnet: false, canTailnet: true, tailnetName: NAME, https: NAME },
      links: { local: HERE, tailnet: `https://${NAME}:39000`, network: LAN },
    },
  ]

  test.each(settings)('with the network $as, only where It can be reached is offered and taken, and the links are then there', async ({ said, links }) => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, said)
    expect(await owner.query(api.network.get, {})).toMatchObject({ link: 'local', links })
    for (const to of PLACES) {
      const offered = Object.hasOwn(links, to)
      expect([to, await refusal(owner.mutation(api.network.link, { to }))]).toEqual([to, offered ? 'ok' : 'invalid'])
      if (!offered) continue
      expect((await owner.query(api.network.get, {})).link).toBe(to)
      // This computer's own is each machine's to say for itself: nothing is given for it
      expect(await t.query(internal.network.linkFor, {})).toEqual(to === 'local' ? null : { at: links[to as keyof typeof links] })
    }
  })

  test('a place that cannot be had is refused with why, in a sentence the owner reads, and nothing is changed', async () => {
    const { t, owner } = await household()
    const why = (to: 'tailnet' | 'network') =>
      owner.mutation(api.network.link, { to }).then(
        () => 'taken',
        (err) => String((err as { data?: unknown }).data ?? err),
      )
    // Before the service has said anything
    expect(await why('tailnet')).toContain('It answers only the machine it runs on, so no other device could open a link there.')
    expect(await rows(t)).toEqual([])
    await t.mutation(internal.network.report, settings[0]!.said)
    expect(await why('network')).toContain('It answers only the machine it runs on')
    await t.mutation(internal.network.report, settings[2]!.said)
    expect(await why('tailnet')).toContain('Tailscale has not said the machine’s name on the tailnet')
    expect(await why('network')).toContain('It is kept to your tailnet, and answers nothing at its address on the network.')
    await t.mutation(internal.network.report, settings[4]!.said)
    expect(await why('tailnet')).toContain('The machine It runs on is on no tailnet.')
    await t.mutation(internal.network.report, settings[5]!.said)
    expect(await why('network')).toContain('The machine It runs on has no address on a network just now.')
    expect((await rows(t))[0]!.link).toBeUndefined()
  })

  test('a choice It can no longer be reached at is kept, the links are this computer’s meanwhile with which place and why, and they are back there once It can be reached', async () => {
    const { t, owner } = await household()
    await t.mutation(internal.network.report, settings[1]!.said)
    await owner.mutation(api.network.link, { to: 'tailnet' })
    expect(await t.query(internal.network.linkFor, {})).toEqual({ at: NAMED })
    // The network was turned off
    await t.mutation(internal.network.report, settings[0]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ unlinked: { to: 'tailnet', why: 'off' } })
    expect(await owner.query(api.network.get, {})).toMatchObject({ link: 'tailnet', links: { local: HERE } })
    // On again, and Tailscale no longer says the name
    await t.mutation(internal.network.report, settings[2]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ unlinked: { to: 'tailnet', why: 'no_name' } })
    // On for every network, with the machine off its tailnet
    await t.mutation(internal.network.report, settings[4]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ unlinked: { to: 'tailnet', why: 'no_tailnet' } })
    // And the name is there again
    await t.mutation(internal.network.report, settings[3]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ at: NAMED })
    // The same of the address on the network: kept to the tailnet, and then on with no address
    await owner.mutation(api.network.link, { to: 'network' })
    expect(await t.query(internal.network.linkFor, {})).toEqual({ at: LAN })
    await t.mutation(internal.network.report, settings[1]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ unlinked: { to: 'network', why: 'kept_to_tailnet' } })
    await t.mutation(internal.network.report, settings[5]!.said)
    expect(await t.query(internal.network.linkFor, {})).toEqual({ unlinked: { to: 'network', why: 'no_address' } })
    // Chosen back to this computer, nothing is given and nothing is said
    await owner.mutation(api.network.link, { to: 'local' })
    expect(await t.query(internal.network.linkFor, {})).toBeNull()
    expect((await rows(t))[0]!.link).toBeUndefined()
  })

  test('the name is kept only as a name and only while the network is on, and what is written down holds neither it nor an address', async () => {
    const { t, owner } = await household()
    for (const tailnetName of [
      'not a name',
      'studio',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
      'http://studio.tail1234.ts.net',
    ]) {
      await t.mutation(internal.network.report, { ...settings[3]!.said, tailnetName })
      expect([tailnetName, (await rows(t))[0]!.tailnetName]).toEqual([tailnetName, undefined])
    }
    await t.mutation(internal.network.report, settings[3]!.said)
    expect((await rows(t))[0]!.tailnetName).toBe(NAME)
    await owner.mutation(api.network.link, { to: 'tailnet' })
    await t.mutation(internal.network.report, settings[0]!.said)
    expect((await rows(t))[0]!.tailnetName).toBeUndefined()
    expect(written.some((line) => line.includes('network.linked'))).toBe(true)
    for (const line of written) for (const secret of [NAME, '192.168.1.20', '100.101.102.103']) expect(line).not.toContain(secret)
  })

  test('only the owner’s browser chooses: a screen, a machine and a stranger are refused and change nothing', async () => {
    const { t, owner, screen, machine } = await household()
    await t.mutation(internal.network.report, settings[3]!.said)
    expect(await refusal(screen.mutation(api.network.link, { to: 'tailnet' }))).toBe('forbidden')
    expect(await refusal(machine.mutation(api.network.link, { to: 'tailnet' }))).toBe('forbidden')
    expect(await refusal(t.mutation(api.network.link, { to: 'tailnet' }))).toBe('unauthenticated')
    expect((await rows(t))[0]!.link).toBeUndefined()
    expect(await refusal(owner.mutation(api.network.link, { to: 'tailnet' }))).toBe('ok')
  })
})
