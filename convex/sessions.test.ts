/// <reference types="vite/client" />
// Pairing and what comes of it, against an in-memory copy of the backend: a code and the wrong
// codes anyone sends, whose a display is, what ending a session ends, who a session and a
// machine were invited by, and what a screen is told about another display.
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
// The door of the service that runs the backend. Nothing listens there: what the backend sends it is caught below.
process.env.IT_PORT = '39000'
/** What the door shows with a request about a session, as the service gives it to the backend. */
const DOOR_KEY = 'the-words-only-the-door-and-the-backend-hold'
process.env.IT_DOOR_KEY = DOOR_KEY

type T = ReturnType<typeof convexTest>
const begun: T[] = []
function backend(): T {
  const t = convexTest(schema, modules)
  begun.push(t)
  return t
}
/** What the backend asked of the content service: each message's operation and body. */
let content: { op: string; body: any }[]

beforeEach(() => {
  vi.useFakeTimers()
  content = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const op = String(url).split('/control/')[1] ?? ''
      const body = JSON.parse(String(init.body))
      content.push({ op, body })
      return new Response(JSON.stringify(op === 'revoke' ? { epoch: body.epoch } : op === 'delete' ? { removed: 0, more: false } : { ok: true }))
    }),
  )
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers)
/** What the site sends to the session routes: its own header, and the cookie the browser holds, if it holds one. */
const asSite = (cookie?: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-it-site': '1',
  'x-it-door': DOOR_KEY,
  ...(cookie ? { cookie } : {}),
})
const redeem = (t: T, code: string, cookie?: string) => t.fetch('/session/redeem', { method: 'POST', body: JSON.stringify({ code }), headers: asSite(cookie) })
const tokenFor = (t: T, cookie?: string) => t.fetch('/session/token', { method: 'POST', headers: asSite(cookie) })
/** The browser signs out: it names the session it holds, and sends the cookie it holds. */
const endOf = (t: T, held: { session: string; cookie: string }) =>
  t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session: held.session }), headers: asSite(held.cookie) })
/** The cookie a reply sets first, as a browser would send it back: its name and its value. */
const cookieOf = (r: Response) => (r.headers.getSetCookie()[0] ?? '').split(';')[0]!
/** The name of the cookie a session is held in, and what an answer says to clear it. */
const nameOf = (session: string) => `it_session_${session.replace(/[^A-Za-z0-9]/g, '_')}`
const clearingOf = (session: string) => `${nameOf(session)}=; HttpOnly; SameSite=Strict; Path=/session; Max-Age=0`
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, any>
/** A key a machine could enrol with. */
async function aPublicKey() {
  const jwk = await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)
  return { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! }
}
const enrol = (t: T, code: string, publicKey: unknown, name = 'another machine') =>
  t.fetch('/bridge/enroll', { method: 'POST', body: JSON.stringify({ code, publicKey, name }) })
/** What a refusal said, however deep it was raised: its code and whatever else it carried. */
function refusalOf(e: unknown): Record<string, unknown> {
  let data: unknown = e instanceof ConvexError ? e.data : undefined
  for (let i = 0; i < 3 && typeof data === 'string'; i++) {
    try {
      data = JSON.parse(data)
    } catch {
      break
    }
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : { code: `threw: ${String((e as Error)?.message ?? e).slice(0, 100)}` }
}
/** A refusal's code, or `ok`. */
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => String(refusalOf(e).code),
  )

/** A backend as the service leaves it: the machine it runs on enrolled, which makes the one person. */
async function installed() {
  const t = backend()
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: await aPublicKey() })
  if ('error' in made) throw new Error(made.error)
  return { t, machineId: made.machineId, machine: t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' }) }
}
/** Pairs a browser with a code, as the site does: what the browser then holds, what it was told, and what it calls the backend as. */
async function pair(t: T, withCode: string, cookie?: string) {
  const redeemed = await redeem(t, withCode, cookie)
  if (redeemed.status !== 200) throw new Error(`the code was refused: ${redeemed.status}`)
  const held = cookieOf(redeemed)
  const said = (await (await tokenFor(t, held)).json()) as { token: string; user: string; session: string; role: 'owner' | 'screen' }
  const { iss, sub, kind, sid, role } = claimsOf(said.token)
  return { cookie: held, ...said, browser: t.withIdentity({ issuer: iss, subject: sub, kind, sid, role }) }
}
type Asks = Awaited<ReturnType<typeof installed>>['machine']
/** A browser paired from the machine itself, and a screen the owner's browser paired. */
const ownerOf = async (t: T, machine: Asks, cookie?: string) => pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code, cookie)
const screenOf = async (t: T, owner: { browser: Asks }, cookie?: string) => pair(t, (await owner.browser.mutation(api.sessions.inviteScreen, {})).code, cookie)
const register = (as: { browser: Asks }, key: string) =>
  as.browser.mutation(api.displays.register, { key, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0' })
const displayOf = (t: T, key: string) => t.run(async (ctx) => (await ctx.db.query('displays').collect()).find((d) => d.key === key) ?? null)
/** Whether the backend still takes a caller for anybody: it lists the person's pages for a browser or a machine it knows, and for nobody else. */
const alive = async (as: { browser: Asks } | Asks) => (await code(('browser' in as ? as.browser : as).query(api.artifacts.list, {}))) === 'ok'

describe('a code, and the wrong codes anyone sends', () => {
  test('a right code is redeemed however many wrong ones were sent before it, to pair a browser and to enrol a machine', async () => {
    const { t, machine } = await installed()
    const forBrowser = await machine.mutation(api.sessions.inviteOwner, {})
    const forMachine = await machine.mutation(api.sessions.inviteMachine, {})
    const key = await aPublicKey()
    // Anyone can send these, to either route, and none of them is told to wait
    for (let i = 0; i < 40; i++) {
      expect((await redeem(t, `not-the-code-${i}`)).status).toBe(401)
      expect((await enrol(t, `not-the-code-${i}`, key)).status).toBe(401)
    }
    // Nor is a code of the other kind, or one that could not be a code at all, anything against a code that waits
    expect((await redeem(t, forMachine.code)).status).toBe(401)
    expect((await enrol(t, forBrowser.code, key)).status).toBe(401)
    expect((await redeem(t, 'x'.repeat(65))).status).toBe(400)
    expect((await redeem(t, forBrowser.code)).status).toBe(200)
    expect((await enrol(t, forMachine.code, key)).status).toBe(200)
  })

  test('nothing is kept of a wrong code, and what is written down of them is one line a minute however many are sent', async () => {
    const { t, machine } = await installed()
    await machine.mutation(api.sessions.inviteOwner, {})
    const kept = () => t.run(async (ctx) => JSON.stringify(await ctx.db.query('invites').collect()))
    const before = await kept()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      for (let i = 0; i < 30; i++) await redeem(t, `not-the-code-${i}`)
      expect(await kept()).toBe(before)
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'code.refused', reason: 'unknown' }])
      await vi.advanceTimersByTimeAsync(61_000)
      for (let i = 0; i < 30; i++) await redeem(t, `not-the-code-${i}`)
      expect(lines.length).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('what a code is for, asked without using it', () => {
  const codeFor = (t: T, body: unknown, headers = asSite()) => t.fetch('/session/code', { method: 'POST', body: JSON.stringify(body), headers })
  const said = async (r: Response) => [r.status, await r.json(), r.headers.getSetCookie()]
  const WRONG = { error: 'That code is wrong, used or expired. Ask for a new one.' }

  test('a code that would pair a browser is said to be the owner’s or a screen’s, and is as good afterwards as it was', async () => {
    const { t, machine } = await installed()
    const owners = await machine.mutation(api.sessions.inviteOwner, {})
    expect(await said(await codeFor(t, { code: owners.code }))).toEqual([200, { role: 'owner' }, []])
    const owner = await pair(t, owners.code)
    const screens = await owner.browser.mutation(api.sessions.inviteScreen, {})
    // Asked as often as anyone likes, by a browser that is paired and by one that is not, and nothing is spent
    for (const cookie of [undefined, owner.cookie, undefined])
      expect(await said(await codeFor(t, { code: screens.code }, asSite(cookie)))).toEqual([200, { role: 'screen' }, []])
    expect((await t.run((ctx) => ctx.db.query('invites').collect())).map((i) => [i.role, i.usedAt !== undefined])).toEqual([
      ['owner', true],
      ['screen', false],
    ])
    expect((await pair(t, screens.code)).role).toBe('screen')
  })

  test('nothing is said of any other code: a wrong one, one that was used, one that has run out and a machine’s are answered alike', async () => {
    const { t, machine } = await installed()
    const used = await machine.mutation(api.sessions.inviteOwner, {})
    await pair(t, used.code)
    const machines = await machine.mutation(api.sessions.inviteMachine, {})
    const late = await machine.mutation(api.sessions.inviteOwner, {})
    await vi.advanceTimersByTimeAsync(601_000)
    const fresh = await machine.mutation(api.sessions.inviteMachine, {})
    for (const code of ['not-the-code', used.code, machines.code, late.code, fresh.code])
      expect(await said(await codeFor(t, { code }))).toEqual([401, WRONG, []])
    // The machine's code is still good for a machine
    expect((await enrol(t, fresh.code, await aPublicKey())).status).toBe(200)
  })

  test('it answers the site through the door and nobody else, and only something that could be a code', async () => {
    const { t, machine } = await installed()
    const { code } = await machine.mutation(api.sessions.inviteOwner, {})
    const { 'x-it-door': _door, ...notThroughTheDoor } = asSite()
    const { 'x-it-site': _site, ...notTheSite } = asSite()
    for (const headers of [notThroughTheDoor, notTheSite, { ...asSite(), 'x-it-door': 'x' }]) expect((await codeFor(t, { code }, headers)).status).toBe(403)
    for (const body of [[], {}, { code: 7 }, { code: 'x'.repeat(65) }]) expect((await codeFor(t, body)).status).toBe(400)
    expect((await t.fetch('/session/code', { headers: asSite() })).status).toBe(404)
  })

  test('what is written down of the codes it refuses is one line a minute, as for a code that is traded', async () => {
    const { t } = await installed()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      for (let i = 0; i < 30; i++) await codeFor(t, { code: `not-the-code-${i}` })
      for (let i = 0; i < 30; i++) await redeem(t, `not-the-code-${i}`)
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'code.refused', reason: 'unknown' }])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('whose a display is', () => {
  const KEY = 'the-laptop-display-key-01'

  test('naming the key of a display whose browser is still paired takes nothing over: a screen is refused, and so is another of the owner’s browsers', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const screen = await screenOf(t, laptop)
    const other = await ownerOf(t, machine)
    const display = await register(laptop, KEY)
    for (const taker of [screen, other]) {
      // Refused as any other display's key is, to a browser that may not speak for it
      expect(await code(register(taker, KEY))).toBe('not_found')
      expect((await displayOf(t, KEY))?.sessionId).toBe(laptop.session)
    }
    // The screen is no more that display than it was: it cannot say it is open, or be signed out as it
    expect(await screen.browser.query(api.displays.mine, { key: KEY })).toBeNull()
    expect(await code(screen.browser.mutation(api.displays.heartbeat, { key: KEY }))).toBe('not_found')
    expect((await laptop.browser.query(api.displays.mine, { key: KEY }))?.id).toBe(display.id)
    // The browser it is registers again as often as it likes, and is the same display
    expect((await register(laptop, KEY)).id).toBe(display.id)
  })

  test('a display goes with its browser to the session that browser is paired into next, once the one it had has ended', async () => {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const first = await screenOf(t, owner)
    const display = await register(first, KEY)
    // The same browser is paired again: the session it held ends as the new one begins
    const second = await screenOf(t, owner, first.cookie)
    expect((await register(second, KEY)).id).toBe(display.id)
    expect((await displayOf(t, KEY))?.sessionId).toBe(second.session)
    // And a display whose session's record has been cleaned away is nobody's to keep from its browser
    await endOf(t, second)
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.get(display.id).then((d) => ctx.db.get(d!.sessionId)))).toBeNull()
    const third = await screenOf(t, owner)
    expect((await register(third, KEY)).id).toBe(display.id)
  })
})

describe('what ending a session ends', () => {
  const PUSH = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
  const KEYS = ['the-screen-display-key-01', 'the-screen-display-key-02']
  /**
   * A screen whose browser lost what it kept and came back under another key: two displays, one
   * session, each with notifications on. And another screen, which nothing here is to touch.
   */
  async function household() {
    const { t, machine, machineId } = await installed()
    const owner = await ownerOf(t, machine)
    const screen = await screenOf(t, owner)
    const ids = []
    for (const key of KEYS) {
      ids.push((await register(screen, key)).id)
      await screen.browser.mutation(api.push.subscribe, { key, endpoint: PUSH(key), p256dh: 'p', auth: 'a' })
    }
    const bystander = await screenOf(t, owner)
    const untouched = await register(bystander, 'the-bystander-display-key')
    await bystander.browser.mutation(api.push.subscribe, { key: 'the-bystander-display-key', endpoint: PUSH('bystander'), p256dh: 'p', auth: 'a' })
    return { t, machine, machineId, owner, screen, ids, bystander, untouched }
  }
  type Household = Awaited<ReturnType<typeof household>>
  /** How things stand for a display once everything the backend set going has run: its sign-out number, whether it is still pushed to, and what the content service was told of it. */
  async function standing(t: T, id: string) {
    await settle(t)
    const d = await t.run(async (ctx) => (await ctx.db.query('displays').collect()).find((x) => x._id === id))
    return {
      epoch: d?.epoch,
      push: d?.push !== undefined,
      told: content.filter((c) => c.op === 'revoke' && c.body.displayId === id).map((c) => c.body.epoch),
    }
  }
  const ended = (t: T, session: string) =>
    t.run(async (ctx) => (await ctx.db.query('sessions').collect()).find((x) => x._id === session)?.endedAt !== undefined)

  const ways: Record<string, (h: Household) => Promise<unknown>> = {
    'the browser signing out': ({ t, screen }) => endOf(t, screen),
    'the browser being paired again': ({ t, owner, screen }) => screenOf(t, owner, screen.cookie),
    'the owner ending it': ({ owner, screen }) => owner.browser.mutation(api.sessions.end, { session: screen.session as never }),
  }
  test.each(Object.entries(ways))('%s signs out every display the session registered, and no other', async (_, end) => {
    const h = await household()
    await end(h)
    expect(await ended(h.t, h.screen.session)).toBe(true)
    // Each display's number has gone up, the content service has been told so, and nothing more is pushed to it
    for (const id of h.ids) expect(await standing(h.t, id)).toEqual({ epoch: 1, push: false, told: [1] })
    expect(await ended(h.t, h.bystander.session)).toBe(false)
    expect(await standing(h.t, h.untouched.id)).toEqual({ epoch: 0, push: true, told: [] })
  })

  test('forgetting one of a session’s displays ends the session, and signs out the other display it registered', async () => {
    const h = await household()
    await h.owner.browser.mutation(api.displays.forget, { displayId: h.ids[0] as never })
    expect(await ended(h.t, h.screen.session)).toBe(true)
    // The forgotten display's record is gone, and the content service was told of it once
    expect(await standing(h.t, h.ids[0]!)).toEqual({ epoch: undefined, push: false, told: [1] })
    expect(await standing(h.t, h.ids[1]!)).toEqual({ epoch: 1, push: false, told: [1] })
    expect(await standing(h.t, h.untouched.id)).toEqual({ epoch: 0, push: true, told: [] })
  })

  test('nothing is pushed to a display whose session has ended, whatever subscription its record still holds', async () => {
    const h = await household()
    const [first] = h.ids
    const note = await h.machine.mutation(api.notifications.send, { text: 'Are you there?' })
    await vi.advanceTimersByTimeAsync(200_000)
    const asked = () => h.t.query(internal.push._targets, { notificationId: note.id })
    expect((await asked())?.targets.map((x) => x.displayId).sort()).toEqual([...h.ids, h.untouched.id].sort())
    // The session ends, and its record of the subscription is put back as if the ending had missed it
    await endOf(h.t, h.screen)
    const push = { endpoint: PUSH(KEYS[0]!), p256dh: 'p', auth: 'a' }
    await h.t.run((ctx) => ctx.db.patch(first as never, { push }))
    expect((await asked())?.targets.map((x) => x.displayId)).toEqual([h.untouched.id])
    // Nor is one sent that was chosen a moment before the session ended
    expect(await h.t.query(internal.push._still, { notificationId: note.id, displayId: first as never, endpoint: push.endpoint })).toBe(false)
    expect(await h.t.query(internal.push._still, { notificationId: note.id, displayId: h.untouched.id, endpoint: PUSH('bystander') })).toBe(true)
  })
})

describe('a display whose browser’s pairing has ended', () => {
  const KEY = 'the-kitchen-display-key-1'
  async function household() {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const laptop = await register(owner, 'the-laptop-display-key-01')
    await owner.browser.mutation(api.displays.rename, { displayId: laptop.id, name: 'Laptop' })
    const screen = await screenOf(t, owner)
    const kitchen = await register(screen, KEY)
    await owner.browser.mutation(api.displays.rename, { displayId: kitchen.id, name: 'Kitchen' })
    await machine.action(api.publish.begin, { slug: 'plan', title: 'Plan', files: [{ path: 'index.html', size: 1, sha256: 'a'.repeat(64) }] })
    return { t, machine, owner, screen, kitchen }
  }
  const listed = async (as: Asks) => (await as.query(api.displays.list, {})).map((d) => [d.name, d.paired])
  const asked = async (t: T, key: string) => (await displayOf(t, key))?.showing !== undefined

  test('is said to be not paired wherever displays are listed, to the owner’s browser and to a machine', async () => {
    const { t, machine, owner, screen } = await household()
    const both = [
      ['Laptop', true],
      ['Kitchen', true],
    ]
    expect([await listed(owner.browser), await listed(machine)]).toEqual([both, both])
    await owner.browser.mutation(api.sessions.end, { session: screen.session as never })
    const ended = [
      ['Laptop', true],
      ['Kitchen', false],
    ]
    expect([await listed(owner.browser), await listed(machine)]).toEqual([ended, ended])
    // So it is a day later, when the record of its session has been cleaned away
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await listed(machine)).toEqual(ended)
    // Its browser is paired again and registers as the display it was: it is a display once more
    await register(await screenOf(t, owner), KEY)
    expect(await listed(machine)).toEqual(both)
  })

  test('a page asked onto it is reported as not shown there, with why, and is not brought up on it when its browser is paired again', async () => {
    const { t, machine, owner, screen } = await household()
    await owner.browser.mutation(api.sessions.end, { session: screen.session as never })
    // Asked onto that display by name
    expect(await machine.mutation(api.displays.show, { slug: 'plan', display: 'Kitchen' })).toEqual({
      displays: [],
      notShown: [{ display: 'Kitchen', reason: 'not_paired' }],
    })
    // Asked onto every display: it is shown on the ones that are paired, and that one is named as left out
    expect(await machine.mutation(api.displays.show, { slug: 'plan' })).toEqual({
      displays: ['Laptop'],
      notShown: [{ display: 'Kitchen', reason: 'not_paired' }],
    })
    expect([await asked(t, 'the-laptop-display-key-01'), await asked(t, KEY)]).toEqual([true, false])
    // A name no display has is still refused as that
    expect(await code(machine.mutation(api.displays.show, { slug: 'plan', display: 'Garage' }))).toBe('not_found')
    // Paired again, it is asked onto as any display is
    await register(await screenOf(t, owner), KEY)
    expect(await machine.mutation(api.displays.show, { slug: 'plan', display: 'kitchen' })).toEqual({ displays: ['Kitchen'], notShown: [] })
  })
})

describe('what a screen is told about a display that is not its own', () => {
  const MINE = 'the-screen-display-key-01'
  const THEIRS = 'the-laptop-display-key-01'
  async function household() {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const laptop = await register(owner, THEIRS)
    const screen = await screenOf(t, owner)
    const mine = await register(screen, MINE)
    return { t, machine, owner, laptop, screen, mine }
  }

  test('whether a display was forgotten is told to no screen, as if no display had ever had that key', async () => {
    const { t, owner, screen } = await household()
    const gone = await register(await screenOf(t, owner), 'the-forgotten-display-key')
    await owner.browser.mutation(api.displays.forget, { displayId: gone.id })
    expect(await screen.browser.query(api.displays.wasForgotten, { key: 'the-forgotten-display-key' })).toBe(false)
    expect(await screen.browser.query(api.displays.wasForgotten, { key: 'a-key-no-display-ever-had' })).toBe(false)
    // The owner's browser, which may speak for any display, is told
    expect(await owner.browser.query(api.displays.wasForgotten, { key: 'the-forgotten-display-key' })).toBe(true)
    expect(await owner.browser.query(api.displays.wasForgotten, { key: 'a-key-no-display-ever-had' })).toBe(false)
  })

  test('a screen that registers with the key of a display the owner forgot is refused as it is with any key that is another’s, and is not told that it was forgotten', async () => {
    const { t, owner, screen } = await household()
    const gone = await register(await screenOf(t, owner), 'the-forgotten-display-key')
    await owner.browser.mutation(api.displays.forget, { displayId: gone.id })
    const refusedWith = (as: typeof screen, key: string) =>
      register(as, key).then(
        () => ({ code: 'ok' }),
        (e) => refusalOf(e),
      )
    // The key of a display that is another browser's still, and the key of one that was forgotten: the same words
    const anothers = await refusedWith(screen, THEIRS)
    expect(anothers).toEqual({ code: 'not_found', message: 'This display is not registered.' })
    expect(await refusedWith(screen, 'the-forgotten-display-key')).toEqual(anothers)
    // So it is for the browser that was forgotten, once it is paired again as a screen: the site then starts it afresh under a key of its own
    const back = await screenOf(t, owner)
    expect(await refusedWith(back, 'the-forgotten-display-key')).toEqual(anothers)
    expect((await refusedWith(back, 'a-key-no-display-ever-had')).code).toBe('ok')
    // The owner's browser, which may be told what became of any display, is told
    expect(await refusedWith(owner, 'the-forgotten-display-key')).toEqual({
      code: 'forbidden',
      message: 'This display was forgotten. Pair this browser again to add it back.',
      forgotten: true,
    })
    // And the key is refused to all of them all the same: no display has it
    expect(await displayOf(t, 'the-forgotten-display-key')).toBeNull()
  })

  test('whether a sign-out has been confirmed is told only of a display the browser may speak for, and of any other as of a job that is not there', async () => {
    const { t, owner, screen } = await household()
    const theirs = await owner.browser.mutation(api.displays.signOut, { key: THEIRS })
    const own = await screen.browser.mutation(api.displays.signOut, { key: MINE })
    // Neither has been confirmed yet. The screen is told so of its own, and of the laptop's what it is told of a job long gone
    expect(await owner.browser.query(api.displays.signOutConfirmed, { job: theirs.job })).toBe(false)
    expect(await screen.browser.query(api.displays.signOutConfirmed, { job: own.job })).toBe(false)
    expect(await screen.browser.query(api.displays.signOutConfirmed, { job: theirs.job })).toBe(true)
    expect(await owner.browser.query(api.displays.signOutConfirmed, { job: own.job })).toBe(false)
    await settle(t)
    for (const job of [theirs.job, own.job]) expect(await screen.browser.query(api.displays.signOutConfirmed, { job })).toBe(true)
  })

  test('a notification sent to another display is no notification to a screen, answered or not', async () => {
    const { t, machine, owner, screen } = await household()
    await machine.action(api.publish.begin, { slug: 'plan', title: 'Plan', files: [{ path: 'index.html', size: 1, sha256: 'a'.repeat(64) }] })
    await owner.browser.mutation(api.displays.rename, { displayId: (await displayOf(t, THEIRS))!._id, name: 'Laptop' })
    const note = await machine.mutation(api.notifications.send, {
      text: 'Deploy?',
      slug: 'plan',
      display: 'laptop',
      buttons: [{ label: 'Yes', action: 'yes' }],
    })
    const answer = (as: typeof screen, displayKey: string) => as.browser.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey })
    const refused = () =>
      answer(screen, MINE).then(
        () => ({ code: 'ok' }),
        (e) => refusalOf(e),
      )
    const before = await refused()
    expect(before).toEqual({ code: 'not_found', message: 'No such notification.' })
    expect((await answer(owner, THEIRS)).actionId).toBeTruthy()
    // Answered since, it is refused to the screen in the very same words
    expect(await refused()).toEqual(before)
    // And to the display it was sent to, a second press is the first press again
    expect(await answer(owner, THEIRS)).toEqual({ actionId: null })
  })

  test('a screen names itself, and to it another display is no display to name', async () => {
    const { t, laptop, screen, mine } = await household()
    const rename = (displayId: string) =>
      screen.browser.mutation(api.displays.rename, { displayId: displayId as never, name: 'Mine now' }).then(
        () => ({ code: 'ok' }),
        (e) => refusalOf(e),
      )
    const gone = await register(screen, 'a-display-soon-let-go-of-1')
    await t.run((ctx) => ctx.db.delete(gone.id))
    expect(await rename(laptop.id)).toEqual(await rename(gone.id))
    expect((await rename(laptop.id)).code).toBe('not_found')
    expect((await rename(mine.id)).code).toBe('ok')
    expect((await displayOf(t, THEIRS))?.name).toBeUndefined()
  })
})

describe('the paired browsers the person sees and ends', () => {
  const sessionsOf = (as: { browser: Asks }) => as.browser.query(api.sessions.list, {})

  test('every paired browser is listed for the owner: what it is, when it was paired and last seen, the displays it registered, what invited it, and what would go with it', async () => {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const laptop = await register(owner, 'the-laptop-display-key-01')
    await owner.browser.mutation(api.displays.rename, { displayId: laptop.id, name: 'Laptop' })
    await vi.advanceTimersByTimeAsync(60_000)
    // A screen whose browser came back under a second key, and so is two displays
    const screen = await screenOf(t, owner)
    await register(screen, 'the-screen-display-key-01')
    await register(screen, 'the-screen-display-key-02')
    await vi.advanceTimersByTimeAsync(60_000)
    // And a browser that redeemed a code the machine asked for and never registered as a display
    const quiet = await ownerOf(t, machine)
    const paired = Date.now()
    const screens = [await displayOf(t, 'the-screen-display-key-01'), await displayOf(t, 'the-screen-display-key-02')]
    expect(await sessionsOf(owner)).toEqual([
      {
        id: owner.session,
        role: 'owner',
        pairedAt: paired - 120_000,
        lastSeenAt: paired - 120_000,
        mine: true,
        displays: [{ id: laptop.id, name: 'Laptop' }],
        invitedBy: { kind: 'machine', name: 'this machine' },
        along: { browsers: [screen.session], machines: [] },
      },
      {
        id: quiet.session,
        role: 'owner',
        pairedAt: paired,
        lastSeenAt: paired,
        mine: false,
        displays: [],
        invitedBy: { kind: 'machine', name: 'this machine' },
        along: { browsers: [], machines: [] },
      },
      {
        id: screen.session,
        role: 'screen',
        pairedAt: paired - 60_000,
        lastSeenAt: paired - 60_000,
        mine: false,
        displays: screens.map((d) => ({ id: d!._id, name: 'Chrome on Linux' })),
        invitedBy: { kind: 'browser', paired: true, name: 'Laptop' },
        along: { browsers: [], machines: [] },
      },
    ])
    // Each owner's browser is shown its own as its own
    expect((await sessionsOf(quiet)).map((x) => [x.id, x.mine])).toEqual([
      [quiet.session, true],
      [screen.session, false],
      [owner.session, false],
    ])
    // It is the owner's to see, and nobody else's
    expect(await code(sessionsOf(screen))).toBe('forbidden')
    expect(await code(machine.query(api.sessions.list, {}))).toBe('forbidden')
    // A browser that is no display asks for a code too, and is named as no more than a paired browser
    const quiets = await screenOf(t, quiet)
    expect((await sessionsOf(owner)).find((x) => x.id === quiets.session)!.invitedBy).toEqual({ kind: 'browser', paired: true, name: null })
    // It signs itself out: the screen it paired stays, and is said to come of a browser whose pairing has ended
    await endOf(t, quiet)
    expect((await sessionsOf(owner)).find((x) => x.id === quiets.session)!.invitedBy).toEqual({ kind: 'browser', paired: false, name: null })
    // A session that has ended is not among them
    await endOf(t, screen)
    expect((await sessionsOf(owner)).map((x) => x.id)).toEqual([owner.session, quiets.session])
  })

  test('the owner ends any one of them, and it is nobody from that moment', async () => {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const quiet = await ownerOf(t, machine)
    const screen = await screenOf(t, owner)
    const display = await register(screen, 'the-screen-display-key-01')
    await screen.browser.mutation(api.push.subscribe, {
      key: 'the-screen-display-key-01',
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: 'p',
      auth: 'a',
    })
    // A code the quiet one asked for, to enrol a machine with, is still waiting
    const waiting = await quiet.browser.mutation(api.sessions.inviteMachine, {})
    // Only the owner's browser ends another's session
    for (const as of [screen.browser, machine]) expect(await code(as.mutation(api.sessions.end, { session: quiet.session as never }))).toBe('forbidden')
    await owner.browser.mutation(api.sessions.end, { session: quiet.session as never })
    expect([await alive(quiet), (await tokenFor(t, quiet.cookie)).status]).toEqual([false, 401])
    // The code it asked for went with it
    expect((await enrol(t, waiting.code, await aPublicKey())).status).toBe(401)
    await owner.browser.mutation(api.sessions.end, { session: screen.session as never })
    await settle(t)
    expect(await alive(screen)).toBe(false)
    expect(await t.run(async (ctx) => [(await ctx.db.get(display.id))?.epoch, (await ctx.db.get(display.id))?.push !== undefined])).toEqual([1, false])
    expect(content.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)).toEqual([display.id])
    // Ending one that has ended does nothing more, and one that never was is no session
    expect(await code(owner.browser.mutation(api.sessions.end, { session: screen.session as never }))).toBe('ok')
    await t.run((ctx) => ctx.db.delete(screen.session as never))
    expect(await code(owner.browser.mutation(api.sessions.end, { session: screen.session as never }))).toBe('not_found')
    expect((await sessionsOf(owner)).map((x) => x.id)).toEqual([owner.session])
  })

  test('the owner ends all the others at once, and stays paired', async () => {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    const others = [await ownerOf(t, machine), await screenOf(t, owner), await screenOf(t, owner)]
    for (const [i, other] of others.entries()) await register(other, `the-other-display-key-0${i}`)
    expect(await code(others[1]!.browser.mutation(api.sessions.endOthers, {}))).toBe('forbidden')
    expect(await owner.browser.mutation(api.sessions.endOthers, {})).toEqual({ ended: 3 })
    for (const other of others) expect(await alive(other)).toBe(false)
    expect([await alive(owner), (await sessionsOf(owner)).map((x) => x.id)]).toEqual([true, [owner.session]])
    expect((await t.run((ctx) => ctx.db.query('displays').collect())).map((d) => d.epoch)).toEqual([1, 1, 1])
    expect(await owner.browser.mutation(api.sessions.endOthers, {})).toEqual({ ended: 0 })
  })

  test('only so many browsers are paired at once: one more ends the one seen longest ago, so that every one of them can be listed', async () => {
    const { t, machine } = await installed()
    const first = await ownerOf(t, machine)
    await register(first, 'the-first-display-key-001')
    const kept: string[] = []
    for (let i = 1; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(7_000)
      kept.push((await ownerOf(t, machine)).session)
    }
    expect([await alive(first), (await t.run((ctx) => ctx.db.query('sessions').collect())).filter((x) => x.endedAt === undefined).length]).toEqual([true, 50])
    await vi.advanceTimersByTimeAsync(7_000)
    const last = await ownerOf(t, machine)
    expect([await alive(first), await alive(last)]).toEqual([false, true])
    expect((await sessionsOf(last)).map((x) => x.id).sort()).toEqual([...kept, last.session].sort())
    // It ended as any session ends
    expect((await displayOf(t, 'the-first-display-key-001'))?.epoch).toBe(1)
  })
})

describe('revoking a machine', () => {
  /** Enrols another machine with a code that `by` asks for, and answers with what it calls the backend as. */
  async function joined(t: T, by: Asks, name: string) {
    const answered = await enrol(t, (await by.mutation(api.sessions.inviteMachine, {})).code, await aPublicKey(), name)
    const { machine: id } = (await answered.json()) as { machine: string }
    return { id, as: t.withIdentity({ issuer: SITE, subject: id, kind: 'machine' }) }
  }
  /**
   * The machine It runs on, a browser paired from it and a screen that browser added. And a
   * second machine, which joined with a code the first asked for, and whose agent then made
   * itself an owner's browser that registered as no display, added a screen and a third machine
   * from there, and has two codes still waiting.
   */
  async function household() {
    const { t, machine, machineId } = await installed()
    const owner = await ownerOf(t, machine)
    const screen = await screenOf(t, owner)
    const second = await joined(t, machine, 'second machine')
    const agent = await ownerOf(t, second.as)
    const agentsScreen = await screenOf(t, agent)
    const display = await register(agentsScreen, 'the-agents-screen-key-001')
    const third = await joined(t, agent.browser, 'third machine')
    const waiting = [await second.as.mutation(api.sessions.inviteOwner, {}), await agent.browser.mutation(api.sessions.inviteMachine, {})]
    return { t, machine, machineId, owner, screen, second, agent, agentsScreen, display, third, waiting }
  }

  test('the Machines page is told, for each machine, how many paired browsers and machines would go with it', async () => {
    const h = await household()
    expect((await h.owner.browser.query(api.machines.list, {})).map((m) => [m.name, m.runsIt, m.descendants])).toEqual([
      ['this machine', true, { browsers: 4, mine: true, machines: 2 }],
      ['second machine', false, { browsers: 2, mine: false, machines: 1 }],
      ['third machine', false, { browsers: 0, mine: false, machines: 0 }],
    ])
    // The browser the agent made for itself is among what its own machine would take along
    expect((await h.agent.browser.query(api.machines.list, {})).map((m) => m.descendants.mine)).toEqual([true, true, false])
    // What a machine is told of itself says nothing of them
    expect(await h.second.as.query(api.machines.me, {})).not.toHaveProperty('descendants')
  })

  test('it ends everything that descends from it: the browsers paired with its codes, the screens and machines they added, and every code of theirs still waiting', async () => {
    const h = await household()
    await h.owner.browser.mutation(api.machines.revoke, { machineId: h.second.id as never })
    await settle(h.t)
    expect([await alive(h.second.as), await alive(h.agent), await alive(h.agentsScreen), await alive(h.third.as)]).toEqual([false, false, false, false])
    // The browser the agent made for itself asks for nothing more, and enrols no machine
    expect(await code(h.agent.browser.mutation(api.sessions.inviteMachine, {}))).toBe('unauthenticated')
    expect((await tokenFor(h.t, h.agent.cookie)).status).toBe(401)
    expect((await redeem(h.t, h.waiting[0]!.code)).status).toBe(401)
    expect((await enrol(h.t, h.waiting[1]!.code, await aPublicKey())).status).toBe(401)
    // Its screen's display is signed out as its session ends
    expect([(await h.t.run((ctx) => ctx.db.get(h.display.id)))?.epoch, content.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)]).toEqual([
      1,
      [h.display.id],
    ])
    // What does not descend from it is as it was
    expect([await alive(h.machine), await alive(h.owner), await alive(h.screen)]).toEqual([true, true, true])
    expect((await h.owner.browser.query(api.machines.list, {})).map((m) => [m.name, m.descendants])).toEqual([
      ['this machine', { browsers: 2, mine: true, machines: 0 }],
    ])
    expect((await h.owner.browser.query(api.sessions.list, {})).map((x) => x.id)).toEqual([h.owner.session, h.screen.session])
  })

  test('a browser that descends from it is ended though the browser that invited it signed out long before', async () => {
    const h = await household()
    // The agent's own browser signs out, and its record is cleaned away: its screen and the machine it added are still there
    await endOf(h.t, h.agent)
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    await h.t.mutation(internal.retention.sweepRecords, {})
    expect([await alive(h.agentsScreen), await alive(h.third.as)]).toEqual([true, true])
    await h.owner.browser.mutation(api.machines.revoke, { machineId: h.second.id as never })
    expect([await alive(h.agentsScreen), await alive(h.third.as), await alive(h.screen)]).toEqual([false, false, true])
  })

  test('a machine that gives up its own access takes what descends from it along, as if it had been revoked', async () => {
    const h = await household()
    await h.second.as.mutation(api.machines.leave, {})
    expect([await alive(h.agent), await alive(h.agentsScreen), await alive(h.third.as), await alive(h.owner)]).toEqual([false, false, false, true])
    expect((await redeem(h.t, h.waiting[0]!.code)).status).toBe(401)
  })

  test('revoking the machine It runs on ends every browser, and enrolled again it pairs one afresh', async () => {
    const h = await household()
    await h.owner.browser.mutation(api.machines.revoke, { machineId: h.machineId })
    expect([await alive(h.owner), await alive(h.screen), await alive(h.second.as), await alive(h.agent), await alive(h.third.as)]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
    // `it setup` enrols the machine again, in place of the identity it had, and `it site` pairs a browser
    const again = await h.t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: await aPublicKey(), replaces: h.machineId })
    if ('error' in again) throw new Error(again.error)
    const back = await ownerOf(h.t, h.t.withIdentity({ issuer: SITE, subject: again.machineId, kind: 'machine' }))
    expect((await back.browser.query(api.sessions.list, {})).map((x) => [x.id, x.invitedBy])).toEqual([
      [back.session, { kind: 'machine', name: 'this machine' }],
    ])
    expect((await back.browser.query(api.machines.list, {})).map((m) => [m.id, m.runsIt, m.descendants])).toEqual([
      [again.machineId, true, { browsers: 1, mine: true, machines: 0 }],
    ])
  })

  test('erasing everything ends every session as any session is ended, before its record goes', async () => {
    const h = await household()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      await h.owner.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: h.owner.user })
      // They are ended in the asking itself, with nothing yet removed
      expect((await h.t.run((ctx) => ctx.db.query('sessions').collect())).map((s) => s.endedAt !== undefined)).toEqual([true, true, true, true])
      await settle(h.t)
    } finally {
      spy.mockRestore()
    }
    const ended = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'session.ended')
    expect(ended.map((l) => [l.sessionId, l.by]).sort()).toEqual([h.owner, h.screen, h.agent, h.agentsScreen].map((x) => [x.session, 'erased']).sort())
    expect(await h.t.run((ctx) => ctx.db.query('sessions').collect())).toEqual([])
  })
})

describe('what ending a paired browser takes with it', () => {
  async function joined(t: T, by: Asks, name: string) {
    const answered = await enrol(t, (await by.mutation(api.sessions.inviteMachine, {})).code, await aPublicKey(), name)
    const { machine: id } = (await answered.json()) as { machine: string }
    return { id, as: t.withIdentity({ issuer: SITE, subject: id, kind: 'machine' }) }
  }
  /**
   * The machine It runs on, and two browsers paired from it as the owner's. One, the laptop, has
   * added a screen and a second machine; an agent on that machine made itself an owner's browser,
   * which added a screen and a third machine in its turn. The laptop and the second machine each
   * have a code still waiting. The other, the desk, has added a screen of its own.
   */
  async function household() {
    const { t, machine, machineId } = await installed()
    const laptop = await ownerOf(t, machine)
    const kitchen = await screenOf(t, laptop)
    const display = await register(kitchen, 'the-kitchen-display-key-1')
    const second = await joined(t, laptop.browser, 'second machine')
    const agent = await ownerOf(t, second.as)
    const agentsScreen = await screenOf(t, agent)
    const third = await joined(t, agent.browser, 'third machine')
    const waiting = { screen: await laptop.browser.mutation(api.sessions.inviteScreen, {}), owner: await second.as.mutation(api.sessions.inviteOwner, {}) }
    const desk = await ownerOf(t, machine)
    const hall = await screenOf(t, desk)
    // A minute on, so that a code may be asked for again: only so many are made in a minute
    await vi.advanceTimersByTimeAsync(60_000)
    return { t, machine, machineId, laptop, kitchen, display, second, agent, agentsScreen, third, waiting, desk, hall }
  }
  type Household = Awaited<ReturnType<typeof household>>
  /** Who the backend still takes for somebody, by name. */
  async function living(h: Household) {
    const all = {
      laptop: h.laptop,
      kitchen: h.kitchen,
      second: h.second.as,
      agent: h.agent,
      agentsScreen: h.agentsScreen,
      third: h.third.as,
      desk: h.desk,
      hall: h.hall,
    }
    const out: string[] = []
    for (const [name, as] of Object.entries(all)) if (await alive(as)) out.push(name)
    return out
  }
  const waitingStill = async (h: Household) => [(await redeem(h.t, h.waiting.screen.code)).status, (await redeem(h.t, h.waiting.owner.code)).status]
  const alongOf = async (as: { browser: Asks }) =>
    Object.fromEntries((await as.browser.query(api.sessions.list, {})).map((x) => [x.id, [x.along.browsers.length, x.along.machines.length]]))

  test('the owner ending a browser ends the screens it paired, the machines it added, what came from those in their turn, and every code of theirs still waiting', async () => {
    const h = await household()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      await h.desk.browser.mutation(api.sessions.end, { session: h.laptop.session as never })
    } finally {
      spy.mockRestore()
    }
    expect(await living(h)).toEqual(['desk', 'hall'])
    expect(await waitingStill(h)).toEqual([401, 401])
    expect(await alive(h.machine)).toBe(true)
    // The kitchen's display is signed out with its session
    await settle(h.t)
    expect([(await displayOf(h.t, 'the-kitchen-display-key-1'))?.epoch, content.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)]).toEqual([
      1,
      [h.display.id],
    ])
    // What is written down says what ended each
    const said = lines.map((l) => JSON.parse(l))
    expect(said.filter((l) => l.event === 'session.ended').map((l) => [l.sessionId, l.by])).toEqual([
      [h.laptop.session, 'owner'],
      [h.kitchen.session, 'browser_ended'],
      [h.agent.session, 'machine_revoked'],
      [h.agentsScreen.session, 'machine_revoked'],
    ])
    expect(said.filter((l) => l.event === 'machine.revoked').map((l) => [l.machineId, l.by])).toEqual([
      [h.second.id, 'browser_ended'],
      [h.third.id, 'machine_revoked'],
    ])
  })

  test('the owner is told, for each paired browser, which browsers and machines would go with it', async () => {
    const h = await household()
    expect(await alongOf(h.desk)).toEqual({
      [h.desk.session]: [1, 0],
      [h.hall.session]: [0, 0],
      [h.laptop.session]: [3, 2],
      [h.kitchen.session]: [0, 0],
      [h.agent.session]: [1, 1],
      [h.agentsScreen.session]: [0, 0],
    })
    const laptops = (await h.desk.browser.query(api.sessions.list, {})).find((x) => x.id === h.laptop.session)!.along
    expect([[...laptops.browsers].sort(), [...laptops.machines].sort()]).toEqual([
      [h.kitchen.session, h.agent.session, h.agentsScreen.session].sort(),
      [h.second.id, h.third.id].sort(),
    ])
    // The browser the agent made for itself is among what the laptop would take along, and is told so of itself
    const asAgent = await h.agent.browser.query(api.sessions.list, {})
    expect(asAgent.find((x) => x.id === h.laptop.session)!.along.browsers).toContain(asAgent.find((x) => x.mine)!.id)
  })

  const itself: Record<string, (h: Household) => Promise<unknown>> = {
    'a browser that signs itself out': (h) => endOf(h.t, h.laptop),
    'a browser that is paired again': (h) => ownerOf(h.t, h.machine, h.laptop.cookie),
    'a browser that nothing has asked with for a year': async (h) => {
      // Every other browser is opened each month, and the laptop never again
      for (let month = 0; month < 13; month++) {
        await vi.advanceTimersByTimeAsync(30 * 86_400_000)
        for (const used of [h.kitchen, h.agent, h.agentsScreen, h.desk, h.hall]) expect((await tokenFor(h.t, used.cookie)).status).toBe(200)
      }
      await h.t.mutation(internal.retention.sweepRecords, {})
    },
  }
  test.each(Object.entries(itself))('%s ends only itself: what it let in stays', async (_, end) => {
    const h = await household()
    await end(h)
    expect(await living(h)).toEqual(['kitchen', 'second', 'agent', 'agentsScreen', 'third', 'desk', 'hall'])
  })

  test('a code that a machine it added asked for is still good once a browser has signed itself out, and the one it asked for itself is not', async () => {
    const h = await household()
    await endOf(h.t, h.laptop)
    expect(await waitingStill(h)).toEqual([401, 200])
  })

  test('the browser ended to make room for one more ends only itself', async () => {
    const { t, machine } = await installed()
    const first = await ownerOf(t, machine)
    await vi.advanceTimersByTimeAsync(7_000)
    const screen = await screenOf(t, first)
    const added = await joined(t, first.browser, 'added machine')
    for (let i = 2; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(7_000)
      await ownerOf(t, machine)
      expect((await tokenFor(t, screen.cookie)).status).toBe(200)
    }
    expect(await alive(first)).toBe(true)
    await vi.advanceTimersByTimeAsync(7_000)
    await ownerOf(t, machine)
    expect([await alive(first), await alive(screen), await alive(added.as)]).toEqual([false, true, true])
  })

  test('forgetting a display ends its browser as the owner ending it does, with what came from it', async () => {
    const h = await household()
    const laptops = await register(h.laptop, 'the-laptop-display-key-01')
    await h.desk.browser.mutation(api.displays.forget, { displayId: laptops.id })
    expect(await living(h)).toEqual(['desk', 'hall'])
    expect(await waitingStill(h)).toEqual([401, 401])
  })

  test('what a browser let in is ended with it though a browser between them signed out and its record was cleaned away', async () => {
    const h = await household()
    // The agent's own browser signs out, and a day later its record is gone: its screen and the third machine name a browser that is no more
    await endOf(h.t, h.agent)
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    await h.t.mutation(internal.retention.sweepRecords, {})
    expect(await h.t.run((ctx) => ctx.db.get(h.agent.session as never))).toBeNull()
    expect(await living(h)).toEqual(['laptop', 'kitchen', 'second', 'agentsScreen', 'third', 'desk', 'hall'])
    // They are still counted among what the laptop would take along, and go with it
    expect((await alongOf(h.desk))[h.laptop.session]).toEqual([2, 2])
    await h.desk.browser.mutation(api.sessions.end, { session: h.laptop.session as never })
    expect(await living(h)).toEqual(['desk', 'hall'])
  })

  test('ending all the others ends what came from them too, and says how many browsers ended', async () => {
    const h = await household()
    expect(await h.desk.browser.mutation(api.sessions.endOthers, {})).toEqual({ ended: 5 })
    expect(await living(h)).toEqual(['desk'])
    expect(await alive(h.machine)).toBe(true)
    expect((await h.desk.browser.query(api.machines.list, {})).map((m) => m.name)).toEqual(['this machine'])
  })

  test('the browser that asks stays paired when it ends all the others, though it came from a machine that one of them added', async () => {
    const h = await household()
    // The agent's browser asks: it descends from the second machine, which the laptop added
    expect(await h.agent.browser.mutation(api.sessions.endOthers, {})).toEqual({ ended: 5 })
    // Every other browser went, and with the laptop the machines that came from it, the one the agent's browser came from among them
    expect(await living(h)).toEqual(['agent'])
    expect(await alive(h.machine)).toBe(true)
    expect((await tokenFor(h.t, h.agent.cookie)).status).toBe(200)
    expect(await waitingStill(h)).toEqual([401, 401])
    // It is from then on a browser of the machine above that one, which is still enrolled, and is counted with it
    expect((await h.agent.browser.query(api.machines.list, {})).map((m) => [m.name, m.descendants])).toEqual([
      ['this machine', { browsers: 1, mine: true, machines: 0 }],
    ])
    expect(await h.agent.browser.mutation(api.sessions.endOthers, {})).toEqual({ ended: 0 })
    // So revoking that machine ends it, as it ends every browser that came from it
    await h.agent.browser.mutation(api.machines.revoke, { machineId: h.machineId })
    expect(await living(h)).toEqual([])
  })

  test('a browser that ends the one browser it came from is ended with it', async () => {
    const h = await household()
    await h.agent.browser.mutation(api.sessions.end, { session: h.laptop.session as never })
    expect(await living(h)).toEqual(['desk', 'hall'])
  })
})

describe('what the backend’s own routes will read', () => {
  /**
   * A body that says nothing of how long it is and goes on for a megabyte, a piece at a time.
   * It counts what was taken of it, and whether whoever was reading gave it up.
   */
  function endless(piece = 2048, most = 1024 * 1024) {
    const taken = { bytes: 0, givenUp: false }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (taken.bytes >= most) return controller.close()
        taken.bytes += piece
        controller.enqueue(new TextEncoder().encode('x'.repeat(piece)))
      },
      cancel() {
        taken.givenUp = true
      },
    })
    return { body, taken }
  }

  test('a body that goes on past what any route takes is given up on as it arrives, whatever length it claimed or did not claim', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    for (const [path, headers] of [
      ['/session/redeem', asSite()],
      ['/session/code', asSite()],
      ['/session/person', asSite()],
      ['/session/end', asSite(laptop.cookie)],
      ['/bridge/enroll', {}],
      ['/bridge/token', {}],
      ['/display/signout', {}],
    ] as const) {
      const { body, taken } = endless()
      const answered = await t.fetch(path, { method: 'POST', body, headers, duplex: 'half' } as RequestInit)
      // Refused as a request that sent nothing it could use, with no more of it read than a little past the most a route takes
      expect([path, answered.status === 400 || answered.status === 401, taken.givenUp, taken.bytes <= 8192 + 2 * 2048]).toEqual([path, true, true, true])
    }
    // The session it came with is as it was
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
  })

  test('a body that says it is longer than any route takes is not read at all', async () => {
    const { t } = await installed()
    const { body, taken } = endless()
    const answered = await t.fetch('/session/redeem', {
      method: 'POST',
      body,
      headers: { ...asSite(), 'content-length': '9000' },
      duplex: 'half',
    } as RequestInit)
    expect([answered.status, taken.bytes <= 2048]).toEqual([400, true])
  })

  test('a body within what a route takes is read whole, however many pieces it comes in', async () => {
    const { t, machine } = await installed()
    const { code } = await machine.mutation(api.sessions.inviteOwner, {})
    const whole = JSON.stringify({ code, padding: 'x'.repeat(6000) })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < whole.length; at += 700) controller.enqueue(new TextEncoder().encode(whole.slice(at, at + 700)))
        controller.close()
      },
    })
    expect((await t.fetch('/session/redeem', { method: 'POST', body, headers: asSite(), duplex: 'half' } as RequestInit)).status).toBe(200)
  })
})

describe('who the session routes answer', () => {
  const ask = (t: T, path: string, headers: Record<string, string>, body = '{}') => t.fetch(path, { method: 'POST', body, headers })

  test('a request that did not come through the door is refused on each of them, whatever else it carries', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const { code } = await machine.mutation(api.sessions.inviteOwner, {})
    const { 'x-it-door': _door, ...notThroughTheDoor } = asSite(laptop.cookie)
    for (const headers of [
      notThroughTheDoor,
      { ...notThroughTheDoor, 'x-it-door': '' },
      { ...notThroughTheDoor, 'x-it-door': `${DOOR_KEY}x` },
      { ...notThroughTheDoor, 'x-it-door': 'x' },
    ]) {
      expect((await ask(t, '/session/token', headers)).status).toBe(403)
      expect((await ask(t, '/session/redeem', headers, JSON.stringify({ code }))).status).toBe(403)
      expect((await ask(t, '/session/end', headers, JSON.stringify({ session: laptop.session }))).status).toBe(403)
    }
    // Nothing was done by any of them: the session is live, and the code is still good
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
    expect((await redeem(t, code)).status).toBe(200)
  })

  test('the door’s words alone are not enough: the site’s own header is asked for as well', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const { 'x-it-site': _site, ...notTheSite } = asSite(laptop.cookie)
    expect((await ask(t, '/session/token', notTheSite)).status).toBe(403)
  })
})

describe('a browser signing out', () => {
  const sessions = (t: T) => t.run(async (ctx) => (await ctx.db.query('sessions').collect()).map((x) => [x._id, x.endedAt !== undefined]))
  const end = (t: T, session: unknown, cookie?: string) =>
    t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session }), headers: asSite(cookie) })

  test('it ends the session it names, with that session’s own cookie, and that cookie is cleared and no other', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const other = await ownerOf(t, machine)
    const done = await end(t, laptop.session, laptop.cookie)
    expect([done.status, await done.json(), done.headers.getSetCookie()]).toEqual([200, { ok: true }, [clearingOf(laptop.session)]])
    expect(await sessions(t)).toEqual([
      [laptop.session, true],
      [other.session, false],
    ])
  })

  test('a tab left open under the session a browser held before ends nothing of the session the browser was paired into since', async () => {
    const { t, machine } = await installed()
    const old = await ownerOf(t, machine)
    // Another tab of the same browser redeems a fresh code: the browser holds the new session from then on
    const fresh = await ownerOf(t, machine, old.cookie)
    // The old tab asks for its session to be ended. What the browser sends by then is the new session's cookie
    const asked = await end(t, old.session, fresh.cookie)
    // All that is cleared is the cookie of the session it named, which is over
    expect([asked.status, ((await asked.json()) as { code: string }).code, asked.headers.getSetCookie()]).toEqual([
      409,
      'another_session',
      [clearingOf(old.session)],
    ])
    expect(await sessions(t)).toEqual([
      [old.session, true],
      [fresh.session, false],
    ])
    expect((await tokenFor(t, fresh.cookie)).status).toBe(200)
  })

  test('it ends no session but the one whose cookie it comes with, whichever it names', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const other = await ownerOf(t, machine)
    const kept = await sessions(t)
    // Another browser's session, named with this browser's cookie: nothing is ended, and no cookie is touched
    const anothers = await end(t, other.session, laptop.cookie)
    expect([anothers.status, anothers.headers.getSetCookie()]).toEqual([409, []])
    // Nothing that names a session, and nothing that is one
    for (const named of [undefined, null, 7, '', 'x'.repeat(65)]) expect((await end(t, named, laptop.cookie)).status).toBe(400)
    const none = await end(t, 'no-such-session', laptop.cookie)
    expect([none.status, none.headers.getSetCookie()]).toEqual([409, []])
    // And nothing at all without the site's own header
    const bare = await t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session: laptop.session }), headers: { cookie: laptop.cookie } })
    expect(bare.status).toBe(403)
    expect(await sessions(t)).toEqual(kept)
  })

  test('with no cookie that is a session still paired, there is nothing to end, and the answer says the browser is not paired', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    expect((await end(t, laptop.session, laptop.cookie)).status).toBe(200)
    // Asked a second time with the cookie the browser still sends, that cookie is cleared again: its session is over
    const again = await end(t, laptop.session, laptop.cookie)
    expect([again.status, again.headers.getSetCookie()]).toEqual([401, [clearingOf(laptop.session)]])
    // With no cookie, and with one that is no session's, no cookie is touched
    for (const cookie of [undefined, `it_session_nobodys=${'A'.repeat(43)}`]) {
      const asked = await end(t, 'no-such-session', cookie)
      expect([asked.status, asked.headers.getSetCookie()]).toEqual([401, []])
    }
  })

  test('the cookie of a session whose record is gone is cleared for the browser that names it, as when everything was erased', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    await t.run((ctx) => ctx.db.delete(laptop.session as never))
    const asked = await end(t, laptop.session, laptop.cookie)
    expect([asked.status, asked.headers.getSetCookie()]).toEqual([401, [clearingOf(laptop.session)]])
  })
})

/**
 * A browser's cookies for the site, as a browser keeps them. It sends every one it holds, and
 * applies what each answer sets and clears when that answer arrives, which need not be the
 * order the requests were made in.
 */
function aBrowser() {
  const jar = new Map<string, string>()
  return {
    /** What it sends with a request made now. */
    sends: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ') || undefined,
    /** An answer arrives. */
    takes(answer: Response): Response {
      for (const line of answer.headers.getSetCookie()) {
        const [pair, ...rest] = line.split(';').map((part) => part.trim())
        const at = pair!.indexOf('=')
        if (rest.includes('Max-Age=0')) jar.delete(pair!.slice(0, at))
        else jar.set(pair!.slice(0, at), pair!.slice(at + 1))
      }
      return answer
    },
    holds: () => [...jar.keys()],
  }
}
type ABrowser = ReturnType<typeof aBrowser>

describe('an answer about one session that reaches the browser after it was paired into another', () => {
  /** Pairs the browser with a code the machine asks for, and says which session it then is. */
  async function pairs(t: T, machine: Asks, b: ABrowser) {
    const code = (await machine.mutation(api.sessions.inviteOwner, {})).code
    const redeemed = b.takes(await redeem(t, code, b.sends()))
    expect(redeemed.status).toBe(200)
    return whoIs(t, b)
  }
  /** What the browser is, by asking for a token as the site does. */
  async function whoIs(t: T, b: ABrowser) {
    const answered = b.takes(await tokenFor(t, b.sends()))
    return answered.status === 200 ? ((await answered.json()) as { session: string }).session : answered.status
  }
  const listed = (t: T) => t.run(async (ctx) => (await ctx.db.query('sessions').collect()).filter((x) => x.endedAt === undefined).map((x) => x._id))

  test('a sign-out’s answer that arrives after the browser was paired again clears only the cookie of the session it ended', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    const old = (await pairs(t, machine, b)) as string
    // One tab signs out. The backend ends the session, and its answer is still on its way
    const late = await t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session: old }), headers: asSite(b.sends()) })
    expect(late.status).toBe(200)
    // Another tab pairs the browser again, and that answer arrives first
    const fresh = (await pairs(t, machine, b)) as string
    expect(fresh).not.toBe(old)
    b.takes(late)
    // The browser holds the new session's cookie, and is that session
    expect(b.holds()).toEqual([nameOf(fresh)])
    expect([await whoIs(t, b), await listed(t)]).toEqual([fresh, [fresh]])
  })

  test('a renewal’s answer that arrives after the browser was paired again puts back only its own session’s cookie, which is cleared when it is next met', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    const old = (await pairs(t, machine, b)) as string
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    // One tab asks for a token, and is given its cookie again with it. That answer is still on its way
    const late = await tokenFor(t, b.sends())
    expect([late.status, late.headers.getSetCookie().map((line) => line.split('=')[0])]).toEqual([200, [nameOf(old)]])
    // Another tab pairs the browser again: the old session ends, and that answer arrives first
    const fresh = (await pairs(t, machine, b)) as string
    expect(b.holds()).toEqual([nameOf(fresh)])
    b.takes(late)
    // The ended session's cookie is back beside the new one, and takes nothing from it
    expect(b.holds().sort()).toEqual([nameOf(old), nameOf(fresh)].sort())
    expect(await whoIs(t, b)).toBe(fresh)
    // And it was cleared by that very answer, since the backend knows its session to be over
    expect(b.holds()).toEqual([nameOf(fresh)])
    expect(await listed(t)).toEqual([fresh])
  })

  test('a pairing’s answer that arrives after a later pairing’s leaves the browser with the later session, and ends the earlier', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    // Two tabs each redeem a code at the same moment, and neither request carries the other's cookie
    const [one, two] = [await machine.mutation(api.sessions.inviteOwner, {}), await machine.mutation(api.sessions.inviteOwner, {})]
    const first = await redeem(t, one.code, b.sends())
    await vi.advanceTimersByTimeAsync(10)
    const second = await redeem(t, two.code, b.sends())
    // The answers arrive the other way about
    b.takes(second)
    b.takes(first)
    expect(b.holds().length).toBe(2)
    // The browser is the session paired last, whichever answer came last, and it holds no other from then on
    const now = (await whoIs(t, b)) as string
    expect([nameOf(now), b.holds(), await listed(t)]).toEqual([second.headers.getSetCookie()[0]!.split('=')[0], [nameOf(now)], [now]])
    expect(await t.run(async (ctx) => (await ctx.db.query('sessions').collect()).length)).toBe(2)
  })

  test('a sign-out’s answer that arrives after the same tab’s renewal was asked for leaves no cookie behind', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    const old = (await pairs(t, machine, b)) as string
    await vi.advanceTimersByTimeAsync(25 * 3_600_000)
    const renewal = await tokenFor(t, b.sends())
    const ending = await t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session: old }), headers: asSite(b.sends()) })
    // The sign-out's answer arrives first, and the renewal's after it puts the ended session's cookie back
    b.takes(ending)
    b.takes(renewal)
    expect(b.holds()).toEqual([nameOf(old)])
    // It earns nothing, and is cleared the next time it is met
    expect([await whoIs(t, b), b.holds()]).toEqual([401, []])
  })

  test('the cookies of sessions that are over are cleared a few at a time, and the session the browser holds is found among them', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    // A browser that kept the cookie of every session it ever held: each was ended from elsewhere while its answer was lost
    const ended: string[] = []
    for (let i = 0; i < 9; i++) {
      const lone = aBrowser()
      const session = (await pairs(t, machine, lone)) as string
      ended.push(lone.sends()!)
      await t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session }), headers: asSite(lone.sends()) })
    }
    const current = (await pairs(t, machine, b)) as string
    const everything = () => [...ended.filter((cookie) => !gone.has(cookie.split('=')[0]!)), b.sends()].join('; ')
    const gone = new Set<string>()
    const asks = async () => {
      const answered = await tokenFor(t, everything())
      const lines = answered.headers.getSetCookie()
      for (const line of lines) gone.add(line.split('=')[0]!)
      return [answered.status, ((await answered.json()) as { session: string }).session, lines.length, lines.every((line) => line.endsWith('Max-Age=0'))]
    }
    expect(await asks()).toEqual([200, current, 4, true])
    expect(await asks()).toEqual([200, current, 4, true])
    expect(await asks()).toEqual([200, current, 1, true])
    expect(await asks()).toEqual([200, current, 0, true])
    expect(gone.has(nameOf(current))).toBe(false)
  })

  test('a cookie whose session this backend has no record of is left as it is: it may be another It’s on the same machine', async () => {
    const { t, machine } = await installed()
    const b = aBrowser()
    const here = (await pairs(t, machine, b)) as string
    const elsewhere = `it_session_kn7another0its0session0id0000001=${'E'.repeat(43)}`
    const answered = await tokenFor(t, `${elsewhere}; ${b.sends()}`)
    expect([answered.status, ((await answered.json()) as { session: string }).session, answered.headers.getSetCookie()]).toEqual([200, here, []])
    const alone = await tokenFor(t, elsewhere)
    expect([alone.status, alone.headers.getSetCookie()]).toEqual([401, []])
  })
})

describe('a pairing that is used', () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000

  test('the cookie is set again, with a year from then, once the one the browser holds is more than a day old', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const setBy = async (cookie = laptop.cookie) => (await tokenFor(t, cookie)).headers.get('set-cookie')
    const AGAIN = `${laptop.cookie}; HttpOnly; SameSite=Strict; Path=/session; Max-Age=31536000`
    expect(await setBy()).toBeNull()
    await vi.advanceTimersByTimeAsync(23 * HOUR)
    expect(await setBy()).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    // The very secret the browser holds, and no new one: the session is the one it was
    expect(await setBy()).toBe(AGAIN)
    expect(await setBy()).toBeNull()
    await vi.advanceTimersByTimeAsync(DAY + HOUR)
    // Whatever other cookie of the family is sent, it is the session's own that is set again
    expect(await setBy(`it_session_nobodys=${'A'.repeat(43)}; ${laptop.cookie}`)).toBe(AGAIN)
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
  })

  test('a browser that is used stays paired long past the day it was paired a year before, and one left unused is ended a year after it was last seen', async () => {
    const { t, machine } = await installed()
    const used = await ownerOf(t, machine)
    const unused = await ownerOf(t, machine)
    const display = await register(unused, 'the-unused-display-key-01')
    await unused.browser.mutation(api.push.subscribe, {
      key: 'the-unused-display-key-01',
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: 'p',
      auth: 'a',
    })
    const there = async () => (await t.run((ctx) => ctx.db.query('sessions').collect())).map((x) => x._id)
    // One is opened every month for two years, and the other never again
    for (let month = 1; month <= 12; month++) {
      await vi.advanceTimersByTimeAsync(30 * DAY)
      expect((await tokenFor(t, used.cookie)).status).toBe(200)
      await t.mutation(internal.retention.sweepRecords, {})
    }
    expect(await there()).toEqual([used.session, unused.session])
    await vi.advanceTimersByTimeAsync(7 * DAY)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await there()).toEqual([used.session])
    // The one left unused ended as any session ends: its display is signed out, and is pushed nothing more
    await settle(t)
    expect(await t.run(async (ctx) => [(await ctx.db.get(display.id))?.epoch, (await ctx.db.get(display.id))?.push !== undefined])).toEqual([1, false])
    expect(content.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)).toEqual([display.id])
    expect((await tokenFor(t, unused.cookie)).status).toBe(401)
    for (let month = 13; month <= 24; month++) {
      await vi.advanceTimersByTimeAsync(30 * DAY)
      expect((await tokenFor(t, used.cookie)).status).toBe(200)
      await t.mutation(internal.retention.sweepRecords, {})
    }
    expect(await alive(used)).toBe(true)
  })
})

describe('a session nothing has asked with for as long as a session lasts', () => {
  const DAY = 86_400_000
  const ended = (t: T, session: string) => t.run(async (ctx) => (await ctx.db.get(session as never)) as { endedAt?: number } | null)

  test('earns no token though the hourly cleaning has not come to it, and is ended as the cleaning would have ended it', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const display = await register(laptop, 'the-laptop-display-key-01')
    // A browser that kept its cookie past the year it is given for, on an It that was stopped all the while
    await vi.advanceTimersByTimeAsync(400 * DAY)
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const asked = await tokenFor(t, laptop.cookie)
      // Refused, and its cookie is cleared: the session is over
      expect([asked.status, asked.headers.getSetCookie()]).toEqual([401, [clearingOf(laptop.session)]])
    } finally {
      spy.mockRestore()
    }
    expect(lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'session.ended')).toEqual([
      { event: 'session.ended', userId: laptop.user, sessionId: laptop.session, by: 'unused', displays: 1 },
    ])
    expect((await ended(t, laptop.session))?.endedAt).toBe(Date.now())
    // Its display is signed out with it, as with any session that ends
    await settle(t)
    expect([(await displayOf(t, 'the-laptop-display-key-01'))?.epoch, content.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)]).toEqual([
      1,
      [display.id],
    ])
    // And the token it was last given is nobody's
    expect(await code(laptop.browser.query(api.artifacts.list, {}))).toBe('unauthenticated')
  })

  test('ends nothing by being named in a sign-out, and is no session to a code that is redeemed with it', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    const screensCode = (await laptop.browser.mutation(api.sessions.inviteScreen, {})).code
    const ownersCode = (await machine.mutation(api.sessions.inviteOwner, {})).code
    await vi.advanceTimersByTimeAsync(400 * DAY)
    expect((await endOf(t, laptop)).status).toBe(401)
    expect((await ended(t, laptop.session))?.endedAt).toBe(Date.now())
    // The codes it could have been redeemed with ran out long before. A fresh owner's code pairs the browser as any other
    expect([(await redeem(t, screensCode, laptop.cookie)).status, (await redeem(t, ownersCode, laptop.cookie)).status]).toEqual([401, 401])
    const again = await ownerOf(t, machine, laptop.cookie)
    expect(again.session).not.toBe(laptop.session)
  })

  test('is still a session the day before, and a browser that asks then stays paired', async () => {
    const { t, machine } = await installed()
    const laptop = await ownerOf(t, machine)
    await vi.advanceTimersByTimeAsync(365 * DAY)
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(365 * DAY)
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
  })
})

describe('whether It still holds anything for a person', () => {
  const personThere = (t: T, body: unknown, headers = asSite()) => t.fetch('/session/person', { method: 'POST', body: JSON.stringify(body), headers })
  const said = async (r: Response) => [r.status, await r.json()]

  test('a browser that kept the person’s id is told that they are there, and that they are not once everything has been erased', async () => {
    const { t, machine } = await installed()
    const owner = await ownerOf(t, machine)
    expect(await said(await personThere(t, { person: owner.user }))).toEqual([200, { there: true }])
    // Asked without a cookie, as a browser whose pairing has ended asks
    expect(await said(await personThere(t, { person: owner.user }, asSite(owner.cookie)))).toEqual([200, { there: true }])
    await owner.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: owner.user })
    // From the moment the erasing is asked for, and when it is done
    expect(await said(await personThere(t, { person: owner.user }))).toEqual([200, { there: false }])
    await settle(t)
    expect(await said(await personThere(t, { person: owner.user }))).toEqual([200, { there: false }])
  })

  test('an id that is no person’s is answered as one whose person is gone, and nothing else is said', async () => {
    const { t, machine, machineId } = await installed()
    const owner = await ownerOf(t, machine)
    for (const person of ['nobody', owner.session, machineId, 'x'.repeat(64)])
      expect(await said(await personThere(t, { person }))).toEqual([200, { there: false }])
    for (const body of [[], {}, { person: 7 }, { person: '' }, { person: 'x'.repeat(65) }]) expect((await personThere(t, body)).status).toBe(400)
    const { 'x-it-door': _door, ...notThroughTheDoor } = asSite()
    expect((await personThere(t, { person: owner.user }, notThroughTheDoor)).status).toBe(403)
  })
})

describe('whom the backend believes', () => {
  test('the token it gives a browser, and the one it gives a machine, are each for an audience its own configuration takes, under its own name and keys', async () => {
    // What the backend program is given to believe: nothing in the functions themselves would
    // notice a kind of caller missing from it, since they are handed whoever it let through
    const { default: config } = await import('./auth.config')
    const { t, machine } = await installed()
    const browser = (await ownerOf(t, machine)).token
    // A machine that joined with a code, and proves it holds the key it enrolled with
    const pair = await generateKeyPair('ES256', { extractable: true })
    const jwk = await exportJWK(pair.publicKey)
    const enrolled = await enrol(t, (await machine.mutation(api.sessions.inviteMachine, {})).code, { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y })
    const { machine: id } = (await enrolled.json()) as { machine: string }
    const proof = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(id)
      .setAudience(`${SITE}/bridge/token`)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .sign(pair.privateKey)
    const answered = await t.fetch('/bridge/token', { method: 'POST', body: JSON.stringify({ machine: id, proof }) })
    const machines = ((await answered.json()) as { token: string }).token
    const keys = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    for (const [token, kind] of [
      [browser, 'browser'],
      [machines, 'machine'],
    ] as const) {
      const { payload, protectedHeader } = await jwtVerify(token, keys, { issuer: SITE })
      expect(payload.kind).toBe(kind)
      expect(config.providers.filter((p) => p.applicationID === payload.aud)).toEqual([
        { type: 'customJwt', issuer: payload.iss, jwks: `${payload.iss}/.well-known/jwks.json`, algorithm: protectedHeader.alg, applicationID: payload.aud },
      ])
    }
    // And it believes nobody else: one audience for each kind of caller, and no other
    expect(config.providers.map((p) => p.applicationID).sort()).toEqual(['it-browser', 'it-machine'])
  })
})
