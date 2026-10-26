/// <reference types="vite/client" />
// The backend's own tests: who may do what, and that what is stored is what was meant.
// They run against an in-memory copy of the backend; the service that runs it, with its content
// service, is stood in for by a stub that records what the backend asked of it.
import { ALIVE, describeClick, LEASE_MS, LIMITS, PUBLICATION, QUOTA, STORE_KEY } from '@it/protocol'
import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { get as pageQuery, takePage } from './artifacts'
import { inboxPage as inboxPageQuery, inbox as inboxQuery } from './delivery'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
// The door of the service that runs the backend. Nothing listens there: what the backend sends it is caught below.
process.env.IT_PORT = '39000'
/** What the door shows with a request about a session, as the service gives it to the backend. */
const DOOR_KEY = 'the-words-only-the-door-and-the-backend-hold'
process.env.IT_DOOR_KEY = DOOR_KEY
const DOOR = 'http://127.0.0.1:39000'

const KEY = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' }
const sha = 'a'.repeat(64)
const page = [{ path: 'index.html', size: 100, sha256: sha }]
const displayKey = (who: string) => `${who}-display-key-0001`

type T = ReturnType<typeof convexTest>
/**
 * A backend for one test. What it has under way when the test ends is waited for before the
 * next test begins: something a test scheduled and started, and did not wait for, would
 * otherwise finish in the middle of another test's backend.
 */
const begun: T[] = []
function backend(): T {
  const t = convexTest(schema, modules)
  begun.push(t)
  return t
}
/** Stands in for the content service. Records what the backend asked of it. */
let content: {
  calls: { url: string; op: string; body: any; token: string }[]
  verifyOk: boolean
  stageOk: boolean
  failNext: number
  moreNext: number
  /** How many deletions it is next to answer as one that got nowhere: there is more, and nothing was removed. */
  stuckNext: number
  garbleNext: number
}
/**
 * Stands in for the service where it sends notifications for the backend. It records what it
 * was asked to send, answers as the push service would (a subscription whose address says
 * "gone" is gone, and `answers` can say otherwise for an address), and can be down.
 */
let sender: {
  asked: { subscription: { endpoint: string; p256dh: string; auth: string }; payload: string; ttl: number; token: string; body: string }[]
  keyAsked: string[]
  answers: (endpoint: string) => number | undefined
  down: boolean
  whileSending?: (endpoint: string) => Promise<void>
}

beforeEach(() => {
  vi.useFakeTimers()
  content = { calls: [], verifyOk: true, stageOk: true, failNext: 0, moreNext: 0, stuckNext: 0, garbleNext: 0 }
  sender = { asked: [], keyAsked: [], answers: () => undefined, down: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).startsWith(`${DOOR}/internal/push`)) {
        const token = String((init.headers as Record<string, string>).authorization).slice(7)
        if (sender.down) return new Response(null, { status: 502 })
        if (String(url) === `${DOOR}/internal/push/key`) {
          sender.keyAsked.push(token)
          return new Response(JSON.stringify({ key: 'the-key-a-browser-subscribes-with' }))
        }
        const asked = JSON.parse(String(init.body))
        sender.asked.push({ ...asked, token, body: String(init.body) })
        await sender.whileSending?.(asked.subscription.endpoint)
        return new Response(
          JSON.stringify({ status: sender.answers(asked.subscription.endpoint) ?? (asked.subscription.endpoint.includes('gone') ? 410 : 201) }),
        )
      }
      const op = String(url).split('/control/')[1] ?? ''
      const body = JSON.parse(String(init.body))
      content.calls.push({ url: String(url), op, body, token: String((init.headers as Record<string, string>).authorization).slice(7) })
      if (content.failNext > 0 && (op === 'revoke' || op === 'delete')) {
        content.failNext--
        return new Response(null, { status: 503 })
      }
      if (op === 'stage' && !content.stageOk) return new Response(null, { status: 503 })
      if (content.garbleNext > 0 && op === 'delete') {
        content.garbleNext--
        return new Response('{"removed": 10, "mo', { status: 200 })
      }
      if (op === 'verify') return new Response(JSON.stringify({ ok: content.verifyOk, missing: content.verifyOk ? [] : ['index.html'] }))
      if (op === 'delete' && content.stuckNext > 0) {
        content.stuckNext--
        return new Response(JSON.stringify({ removed: 0, more: true }))
      }
      if (op === 'delete' && content.moreNext > 0) {
        content.moreNext--
        return new Response(JSON.stringify({ removed: 1000, more: true }))
      }
      if (op === 'delete') return new Response(JSON.stringify({ removed: 1, more: false }))
      if (op === 'revoke') return new Response(JSON.stringify({ epoch: body.epoch }))
      return new Response(JSON.stringify({ ok: true }))
    }),
  )
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.unstubAllGlobals()
  vi.useRealTimers()
  process.env.IT_PORT = '39000'
})

/**
 * A database that notes every record read through it, for a function run by hand on it: the
 * stand-in backend counts nothing, and the real one refuses a function that reads too much.
 */
function watched(real: any): { db: any; read: any[] } {
  const read: any[] = []
  const noted = (got: unknown) => {
    for (const row of Array.isArray(got) ? got : [got]) if (row && typeof row === 'object') read.push(row)
    return got
  }
  const watching = (query: any): any =>
    new Proxy(query, {
      get(target, name) {
        const value = target[name]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const out = value.apply(target, args)
          return ['take', 'first', 'unique', 'collect'].includes(String(name)) ? Promise.resolve(out).then(noted) : watching(out)
        }
      },
    })
  const db = new Proxy(real, {
    get(target: any, name) {
      if (name === 'get') return async (id: never) => noted(await target.get(id))
      if (name === 'query') return (table: never) => watching(target.query(table))
      const value = target[name]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, read }
}

const subjectOf = (who: string) => `user_${who}`
/**
 * A person, and a browser of theirs that was paired as the owner's and has registered itself
 * as a display. The person's record is the one their first enrolment would make, and the
 * browser's session the one that redeeming a code would make: the tests of enrolling and of
 * pairing go through the functions and the routes themselves.
 */
async function person(t: T, who: string) {
  const user: string = await t.run(async (ctx) => {
    const there = (await ctx.db.query('users').collect()).find((u) => u.subject === subjectOf(who))
    return there?._id ?? (await ctx.db.insert('users', { subject: subjectOf(who), createdAt: Date.now() }))
  })
  return { user, ...(await paired(t, who, 'owner', displayKey(who))) }
}
let sessions = 0
/** Another browser paired for someone who is already there, as the owner's or as a screen: what it calls the backend as, and its session. */
async function browserOf(t: T, who: string, role: 'owner' | 'screen') {
  const { user, session }: { user: string; session: string } = await t.run(async (ctx) => {
    const u = (await ctx.db.query('users').collect()).find((x) => x.subject === subjectOf(who))!
    const now = Date.now()
    return {
      user: u._id,
      session: await ctx.db.insert('sessions', { userId: u._id, secretHash: `no-secret-${++sessions}`, role, createdAt: now, lastSeenAt: now, cookieAt: now }),
    }
  })
  // What the backend is told about a caller is what its own token for a session says (see the tests of pairing)
  const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role })
  const mutation = browser.mutation
  // The browser saves the server's deadline before dispatching each new click.
  browser.mutation = (async (fn, args) => {
    if (['actions:submit', 'actions:message'].includes(getFunctionName(fn))) {
      const { until } = await mutation(api.actions.replayGrant, {})
      return mutation(fn, { ...args, replayUntil: until })
    }
    if (getFunctionName(fn) === 'notifications:answer') return mutation(fn, { ...args, expectedSession: session })
    if (getFunctionName(fn) === 'artifacts:stop') {
      const shown = await browser.query(api.artifacts.get, args as { artifactId: Id<'artifacts'> })
      return mutation(fn, { ...args, expectedRun: shown.run?.identity, expectedSession: session })
    }
    return mutation(fn, args)
  }) as typeof mutation
  return { browser, session }
}
/** The same, once it has registered itself as a display. */
async function paired(t: T, who: string, role: 'owner' | 'screen', key: string, userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0') {
  const b = await browserOf(t, who, role)
  return { ...b, display: await b.browser.mutation(api.displays.register, { key, userAgent }) }
}
let keys = 0
async function machineOf(t: T, who: string, name = 'laptop', replaces?: string) {
  // Each machine has a key of its own: the same key enrolled twice is the same machine
  const publicKey = { ...KEY, x: `x${++keys}` }
  const made = await t.mutation(internal.bridge.enroll, { subject: subjectOf(who), name, publicKey, ...(replaces ? { replaces } : {}) })
  if ('error' in made) throw new Error(made.error)
  // It has said which system it runs, as a connector does in the first report it makes
  await t.run((ctx) => ctx.db.patch(made.machineId, { system: 'linux' }))
  return { id: made.machineId, as: t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' }) }
}
async function publish(machine: { as: ReturnType<T['withIdentity']> }, slug: string, extra: Record<string, unknown> = {}) {
  const begun = await machine.as.action(api.publish.begin, { slug, title: `Title of ${slug}`, files: page, ...extra })
  const done = await machine.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })
  return { ...begun, ...done }
}
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers)
/** The machine's own timer, as it is before any test holds the clock: some of what the backend does takes real time, the making of a key above all. */
const realTimeout = setTimeout
/**
 * What a mutation schedules is scheduled only if the mutation is kept: the backend forgets it
 * when the mutation fails. The stand-in backend these tests run on starts a timer for it all the
 * same, and that timer has nothing to run and fails when it fires. So where a test means a
 * mutation to fail after it has scheduled something (a limit it reached is written down that
 * way), the timers it left are cleared, and with them only what the test has no more use for.
 */
const dropWhatAFailedCallScheduled = () => {
  // Clearing the timers also puts the stand-in clock back to where the test began, which no test means: the time is kept
  const now = Date.now()
  vi.clearAllTimers()
  vi.setSystemTime(now)
}
/** Lets what is due run, without moving the clock: what a limit allows comes back with time. */
const runWhatIsDue = async (t: T) => {
  await vi.advanceTimersByTimeAsync(0)
  await t.finishInProgressScheduledFunctions()
}
// A refusal's code, however deep it was raised: an action passes on a mutation's refusal with
// its data serialized, sometimes more than once
function refusalCode(e: unknown): string {
  let data: unknown = e instanceof ConvexError ? e.data : undefined
  for (let i = 0; i < 3 && typeof data === 'string'; i++) {
    try {
      data = JSON.parse(data)
    } catch {
      break
    }
  }
  if (data && typeof data === 'object' && 'code' in data) return String((data as { code: unknown }).code)
  const text = String((e as Error)?.message ?? e)
  return /"code":"([a-z_]+)"/.exec(text)?.[1] ?? /\\"code\\":\\"([a-z_]+)/.exec(text)?.[1] ?? `threw: ${text.slice(0, 100)}`
}
// Calls are made one at a time: a list of them is a list of things to do, not of things already begun
const code = async (p: Promise<unknown> | (() => Promise<unknown>)) =>
  (typeof p === 'function' ? p() : p).then(
    () => 'ok',
    (e) => refusalCode(e),
  )
/** Whether the backend takes a caller for anybody: it lists the person's pages for a browser or a machine it knows, and for nobody else. */
const alive = async (as: Pick<T, 'query'>) => (await code(as.query(api.artifacts.list, {}))) === 'ok'
const envelope = (id: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  clientActionId: id,
  name: 'approve',
  payload: '{"n":1}',
  contentVersion: 1,
  ...over,
})
const SESSION = { harness: 'claude-code', id: 'sess-1' }
/** What a connector with that one conversation listening would be offered. */
const inbox = (m: { as: ReturnType<T['withIdentity']> }, listening = [SESSION], queues: string[] = []) => m.as.query(api.delivery.inbox, { listening, queues })
const stateOf = async (who: ReturnType<T['withIdentity']>, slug: string) => JSON.parse((await who.query(api.state.get, { slug })).json) as Record<string, any>
/** The first person's running totals. */
const totals = async (t: T) => {
  const [row] = await t.run((ctx) => ctx.db.query('tallies').collect())
  return { waiting: row?.waiting ?? 0, stagingCount: row?.stagingCount ?? 0, stagingBytes: row?.stagingBytes ?? 0 }
}
const PUSH = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`

/** What the site sends to the session routes: its own header, and the cookie the browser holds, if it holds one. */
const asSite = (cookie?: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-it-site': '1',
  'x-it-door': DOOR_KEY,
  ...(cookie ? { cookie } : {}),
})
const redeem = (t: T, code: string, headers = asSite()) => t.fetch('/session/redeem', { method: 'POST', body: JSON.stringify({ code }), headers })
const tokenFor = (t: T, cookie?: string) => t.fetch('/session/token', { method: 'POST', headers: asSite(cookie) })
/** A browser signing out: it names the session it holds, and sends the cookie it holds. */
const endOf = (t: T, held: { session: string; cookie?: string }) =>
  t.fetch('/session/end', { method: 'POST', body: JSON.stringify({ session: held.session }), headers: asSite(held.cookie) })
/** The cookie a reply sets first, as a browser would send it back: its name and its value. */
const cookieOf = (r: Response) => (r.headers.getSetCookie()[0] ?? '').split(';')[0]!
/** The name of the cookie a session is held in. */
const nameOf = (session: string) => `it_session_${session.replace(/[^A-Za-z0-9]/g, '_')}`
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, any>
/** The hash a code or a secret is kept as. */
const hashOf = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex')
/** A key a machine could enrol with: the public half, and the private half to prove it with. */
async function aKeyPair() {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const jwk = await exportJWK(pair.publicKey)
  return { publicKey: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey }
}
const aPublicKey = async () => (await aKeyPair()).publicKey
/** A backend as the service leaves it: the machine it runs on enrolled, which makes the one person. */
async function installed() {
  const t = backend()
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: KEY })
  if ('error' in made) throw new Error(made.error)
  return { t, machineId: made.machineId, machine: t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' }) }
}
/** Pairs a browser with a code, as the site does: what the browser then holds, what it was told, and what it calls the backend as. */
async function pair(t: T, code: string) {
  const redeemed = await redeem(t, code)
  if (redeemed.status !== 200) throw new Error(`the code was refused: ${redeemed.status}`)
  const cookie = cookieOf(redeemed)
  const said = (await (await tokenFor(t, cookie)).json()) as { token: string; expiresIn: number; user: string; session: string; role: 'owner' | 'screen' }
  // Exactly what the token says, and nothing the test makes up
  const { iss, sub, kind, sid, role } = claimsOf(said.token)
  return { cookie, ...said, browser: t.withIdentity({ issuer: iss, subject: sub, kind, sid, role }) }
}

describe('who a caller is', () => {
  test('asked how it is, the backend answers anybody that it is well, and marks the answer as It’s own', async () => {
    const said = await backend().fetch('/health')
    expect([said.status, await said.json()]).toEqual([200, { ok: true, it: true }])
  })

  test('nobody who is neither a paired browser nor an enrolled machine can call anything', async () => {
    const t = backend()
    const calls: (() => Promise<unknown>)[] = [
      () => t.query(api.artifacts.list, {}),
      () => t.query(api.displays.list, {}),
      () => t.query(api.machines.list, {}),
      () => t.query(api.delivery.inbox, { listening: [] }),
      () => t.query(api.delivery.inboxPage, { listening: [], after: [] }),
      () => t.query(api.delivery.get, { id: 'x' }),
      () => t.query(api.state.get, { slug: 'x' }),
      () => t.query(api.notifications.list, { key: displayKey('a') }),
      () => t.query(api.account.exportNotifications, { owner: 'x', cursor: null }),
      () => t.mutation(api.sessions.inviteOwner, {}),
      () => t.mutation(api.sessions.inviteScreen, {}),
      () => t.mutation(api.sessions.inviteMachine, {}),
      () => t.mutation(api.displays.register, { key: displayKey('a'), userAgent: '' }),
      () => t.mutation(api.state.patch, { slug: 'x', patch: '{}' }),
      () => t.mutation(api.notifications.send, { text: 'hi' }),
      () => t.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: 'x' }),
      () => t.mutation(api.account.exportStart, {}),
      () => t.action(api.publish.begin, { title: 'x', files: page }),
      () => t.action(api.mounts.ticket, { mountId: 'x' }),
      () => t.action(api.push.publicKey, {}),
    ]
    for (const c of calls) expect(await code(c)).toBe('unauthenticated')
  })

  test('a token from an issuer the backend does not know is nobody, and so is one of its own that names no machine and no session', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    expect(await alive(alice.browser)).toBe(true)
    const claims = { subject: alice.user, kind: 'browser', sid: alice.session, role: 'owner' }
    const stranger = t.withIdentity({ ...claims, issuer: 'https://evil.example' })
    expect(await code(stranger.query(api.artifacts.list, {}))).toBe('unauthenticated')
    for (const not of [{ kind: 'cli' }, { kind: undefined }, { sid: undefined }, { sid: 'no-such-session' }, { sid: alice.user }, { subject: 'somebody-else' }])
      expect(await code(t.withIdentity({ ...claims, issuer: SITE, ...not }).query(api.artifacts.list, {}))).toBe('unauthenticated')
    // The role is the session's own, whatever a token says: a screen is not made an owner by saying so
    const screen = await paired(t, 'alice', 'screen', 'alice-screen-key-001')
    const claiming = t.withIdentity({ issuer: SITE, subject: alice.user, kind: 'browser', sid: screen.session, role: 'owner' })
    expect(await code(claiming.query(api.machines.list, {}))).toBe('forbidden')
  })

  test('a revoked machine is nobody at once, whatever its token says', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    expect((await m.as.query(api.machines.me, {})).id).toBe(m.id)
    await alice.browser.mutation(api.machines.revoke, { machineId: m.id })
    expect(await code(m.as.query(api.machines.me, {}))).toBe('unauthenticated')
    expect(await code(m.as.action(api.publish.begin, { title: 'x', files: page }))).toBe('unauthenticated')
    expect(await t.query(internal.bridge.machine, { id: m.id })).toMatchObject({ revoked: true })
  })

  test('a person cannot do what only a machine may, and a machine cannot do what only a person may', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    for (const c of [
      () => alice.browser.action(api.publish.begin, { title: 'x', files: page }),
      () => alice.browser.mutation(api.state.patch, { slug: 'plan', patch: '{}' }),
      () => alice.browser.query(api.delivery.inbox, { listening: [] }),
      () => alice.browser.query(api.delivery.inboxPage, { listening: [], after: [] }),
      () => alice.browser.query(api.delivery.get, { id: 'x' }),
      () => alice.browser.mutation(api.notifications.send, { text: 'hi' }),
      () => alice.browser.mutation(api.displays.show, { slug: 'plan' }),
    ])
      expect(await code(c)).toBe('forbidden')
    for (const c of [
      () => m.as.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') }),
      () => m.as.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0001') }),
      () => m.as.mutation(api.machines.revoke, { machineId: m.id }),
      () => m.as.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: 'x' }),
      () => m.as.mutation(api.account.exportStart, {}),
      () => m.as.query(api.account.exportPage, { artifactId: p.artifactId }),
      () => m.as.query(api.machines.list, {}),
      () => m.as.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value: '1' }),
      () => m.as.action(api.push.publicKey, {}),
    ])
      expect(await code(c)).toBe('forbidden')
  })
})

describe('pairing a browser', () => {
  const kept = (t: T) => t.run(async (ctx) => ({ invites: await ctx.db.query('invites').collect(), sessions: await ctx.db.query('sessions').collect() }))

  test('a code the machine asks for lets one browser in as the owner’s, with a cookie named for its session and a token that says which session it is', async () => {
    const { t, machine } = await installed()
    const invited = await machine.mutation(api.sessions.inviteOwner, {})
    expect(invited.code).toMatch(/^[a-z2-7]{20}$/)
    expect(invited.expiresAt - Date.now()).toBe(600_000)
    const redeemed = await redeem(t, invited.code)
    expect([redeemed.status, await redeemed.json(), redeemed.headers.get('cache-control')]).toEqual([200, { ok: true }, 'no-store'])
    expect(redeemed.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^it_session_[A-Za-z0-9_]+=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/session; Max-Age=31536000$/),
    ])
    const cookie = cookieOf(redeemed)
    // The cookie's name says which session it is, and nothing of the secret it holds
    expect(cookie.split('=')[0]).toBe(nameOf((await kept(t)).sessions[0]!._id))
    // Neither the code nor the secret is kept anywhere: only a hash of each
    const records = JSON.stringify(await kept(t))
    expect([records.includes(invited.code), records.includes(cookie.split('=')[1]!)]).toEqual([false, false])
    const answered = await tokenFor(t, cookie)
    const said = (await answered.json()) as Record<string, string>
    expect([answered.status, answered.headers.get('cache-control'), Object.keys(said).sort()]).toEqual([
      200,
      'no-store',
      ['expiresIn', 'role', 'session', 'token', 'user'],
    ])
    const [user] = await t.run((ctx) => ctx.db.query('users').collect())
    expect(said).toMatchObject({ expiresIn: 300, role: 'owner', user: user!._id, session: (await kept(t)).sessions[0]!._id })
    // The token is the backend's own, for a browser and for nothing else, and good for five minutes
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(said.token!, jwks, { issuer: SITE, audience: 'it-browser' })
    expect(payload).toMatchObject({ sub: said.user, kind: 'browser', sid: said.session, role: 'owner' })
    expect(payload.exp! - payload.iat!).toBe(300)
    await expect(jwtVerify(said.token!, jwks, { issuer: SITE, audience: 'it-machine' })).rejects.toThrow()
    // With it the browser is the owner's, and may do what only the owner's may
    const { sub, kind, sid, role } = claimsOf(said.token!)
    const browser = t.withIdentity({ issuer: SITE, subject: sub, kind, sid, role })
    expect((await browser.query(api.machines.list, {})).map((m) => m.name)).toEqual(['this machine'])
    // The cookie is the same whatever a request says of how it came: the site is reached over plain http
    const again = await machine.mutation(api.sessions.inviteOwner, {})
    const overHttps = await redeem(t, again.code, { ...asSite(), 'x-forwarded-proto': 'https' })
    expect(overHttps.headers.get('set-cookie')).toMatch(/; Path=\/session; Max-Age=31536000$/)
  })

  test('a code is used once', async () => {
    const { t, machine } = await installed()
    const invited = await machine.mutation(api.sessions.inviteOwner, {})
    expect((await redeem(t, invited.code)).status).toBe(200)
    const again = await redeem(t, invited.code)
    expect([again.status, again.headers.get('set-cookie')]).toEqual([401, null])
    expect((await kept(t)).sessions.length).toBe(1)
  })

  test('a code is good for ten minutes and not a moment more, and its record goes at the next cleaning', async () => {
    const { t, machine } = await installed()
    const early = await machine.mutation(api.sessions.inviteOwner, {})
    await vi.advanceTimersByTimeAsync(599_000)
    const late = await machine.mutation(api.sessions.inviteOwner, {})
    expect((await pair(t, early.code)).role).toBe('owner')
    const unused = await machine.mutation(api.sessions.inviteOwner, {})
    void unused
    await vi.advanceTimersByTimeAsync(598_000)
    // Nine minutes and fifty-eight seconds old, and then ten minutes and a second
    expect((await redeem(t, late.code)).status).toBe(200)
    const last = await machine.mutation(api.sessions.inviteOwner, {})
    await vi.advanceTimersByTimeAsync(601_000)
    expect((await redeem(t, last.code)).status).toBe(401)
    expect((await kept(t)).sessions.length).toBe(2)
    await t.mutation(internal.retention.sweepRecords, {})
    expect((await kept(t)).invites).toEqual([])
  })

  test('a code stays good however many wrong codes are tried while it waits, and none of them is told to wait', async () => {
    const { t, machine } = await installed()
    const invited = await machine.mutation(api.sessions.inviteOwner, {})
    for (let i = 0; i < 25; i++) expect((await redeem(t, `not-the-code-${i}`)).status).toBe(401)
    expect([(await kept(t)).invites.map((i) => i.usedAt), (await kept(t)).sessions]).toEqual([[undefined], []])
    const redeemed = await redeem(t, invited.code)
    expect([redeemed.status, (await kept(t)).sessions.length]).toEqual([200, 1])
  })

  test('the session routes answer the site and nobody else, and take nothing that is not a code or a session’s secret', async () => {
    const { t, machine } = await installed()
    const invited = await machine.mutation(api.sessions.inviteOwner, {})
    // Without the site's own header nothing is done, and the code is not used
    const bare = await t.fetch('/session/redeem', { method: 'POST', body: JSON.stringify({ code: invited.code }) })
    expect([bare.status, bare.headers.get('set-cookie')]).toEqual([403, null])
    expect((await kept(t)).invites.map((i) => i.usedAt)).toEqual([undefined])
    // Nor is anything done with something that could not be a code
    for (const body of ['[]', '{}', 'not json', JSON.stringify({ code: 7 }), JSON.stringify({ code: 'x'.repeat(65) })])
      expect((await t.fetch('/session/redeem', { method: 'POST', body, headers: asSite() })).status).toBe(400)
    const { cookie } = await pair(t, invited.code)
    expect((await t.fetch('/session/token', { method: 'POST', headers: { cookie } })).status).toBe(403)
    expect((await t.fetch('/session/end', { method: 'POST', headers: { cookie } })).status).toBe(403)
    expect((await t.fetch('/session/token', { headers: asSite(cookie) })).status).toBe(404)
    // The session is as it was, and is found among whatever other cookies the browser sends
    expect((await tokenFor(t, `theme=dark; ${cookie}; other=1`)).status).toBe(200)
    // No cookie, something that is no secret, and a secret that is nobody's
    expect((await tokenFor(t)).status).toBe(401)
    expect((await tokenFor(t, `${cookie.split('=')[0]}=short`)).status).toBe(401)
    const nobodys = await tokenFor(t, `it_session_nobodys=${'A'.repeat(43)}`)
    // Refused, and no cookie is touched: it is no session this backend knows to be over
    expect([nobodys.status, nobodys.headers.getSetCookie()]).toEqual([401, []])
  })

  test('a browser that signs out is nobody at once: its token is refused on the next call, and its cookie earns no other', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const other = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    expect(await code(laptop.browser.query(api.artifacts.list, {}))).toBe('ok')
    const ended = await endOf(t, laptop)
    expect([ended.status, await ended.json(), ended.headers.getSetCookie()]).toEqual([
      200,
      { ok: true },
      [`${nameOf(laptop.session)}=; HttpOnly; SameSite=Strict; Path=/session; Max-Age=0`],
    ])
    // The token it was given has minutes left to run, and is refused all the same
    expect(claimsOf(laptop.token).exp * 1000).toBeGreaterThan(Date.now() + 200_000)
    expect(await code(laptop.browser.query(api.artifacts.list, {}))).toBe('unauthenticated')
    expect(await code(laptop.browser.mutation(api.displays.register, { key: displayKey('laptop'), userAgent: 'x' }))).toBe('unauthenticated')
    expect((await tokenFor(t, laptop.cookie)).status).toBe(401)
    // Signing out twice, or with no cookie to sign out with, finds nothing to end and says so
    expect((await endOf(t, laptop)).status).toBe(401)
    expect((await endOf(t, { session: laptop.session })).status).toBe(401)
    // And it was one browser that signed out, not the person
    expect(await code(other.browser.query(api.artifacts.list, {}))).toBe('ok')
    expect((await tokenFor(t, other.cookie)).status).toBe(200)
  })

  test('a browser that is paired again gives up the session it had, and one that tries a wrong code keeps it', async () => {
    const { t, machine } = await installed()
    const first = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    // `it site` is run again, and the same browser, still holding its cookie, redeems the new code
    const next = await machine.mutation(api.sessions.inviteOwner, {})
    const again = await redeem(t, next.code, asSite(first.cookie))
    expect(again.status).toBe(200)
    expect(cookieOf(again)).not.toBe(first.cookie)
    expect(await alive(first.browser)).toBe(false)
    expect((await tokenFor(t, first.cookie)).status).toBe(401)
    expect((await tokenFor(t, cookieOf(again))).status).toBe(200)
    expect((await kept(t)).sessions.map((x) => x.endedAt !== undefined)).toEqual([true, false])
    // A code that is refused begins nothing, and ends nothing
    expect((await redeem(t, next.code, asSite(cookieOf(again)))).status).toBe(401)
    expect((await tokenFor(t, cookieOf(again))).status).toBe(200)
  })

  test('a cookie of the family that is no session’s does not hide the real one, wherever it comes in what the browser sends', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    // Cookies of the family that are no session's, sent beside the real one and ahead of it
    const bogus = (n: number) => `it_session_bogus${n}=${String(n).repeat(43).slice(0, 43)}`
    const planted = `${bogus(1)}; ${bogus(2)}; it_session_misshapen=not-shaped-like-one; ${laptop.cookie}; ${bogus(3)}`
    const answered = await tokenFor(t, planted)
    expect([answered.status, ((await answered.json()) as { session: string }).session]).toEqual([200, laptop.session])
    // A hundred and fifty of them ahead of the real one change nothing
    const many = Array.from({ length: 150 }, (_, i) => `it_session_bogus${i}=${String(i).padStart(43, 'x')}`).join('; ')
    expect((await tokenFor(t, `${many}; ${laptop.cookie}`)).status).toBe(200)
    // With only such values, the answer is what any browser that is not paired is given, and no session begins or ends
    const only = await tokenFor(t, `${bogus(1)}; ${bogus(2)}`)
    expect([only.status, await only.json()]).toEqual([401, { error: 'This browser is not paired.' }])
    expect((await endOf(t, { session: laptop.session, cookie: `${bogus(1)}; ${bogus(2)}` })).status).toBe(401)
    expect((await kept(t)).sessions.map((x) => x.endedAt)).toEqual([undefined])
    // Signing out ends the real one, whatever was sent ahead of it
    expect((await endOf(t, { session: laptop.session, cookie: planted })).status).toBe(200)
    expect(await alive(laptop.browser)).toBe(false)
    // And pairing again ends the session the browser really held, whatever else it sent
    const next = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const again = await redeem(t, (await machine.mutation(api.sessions.inviteOwner, {})).code, asSite(`${bogus(1)}; ${next.cookie}`))
    expect(again.status).toBe(200)
    expect(await alive(next.browser)).toBe(false)
    expect((await tokenFor(t, cookieOf(again))).status).toBe(200)
  })

  test('a session’s secret counts only in the cookie named for that session, and under any other name is nobody’s', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const other = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const secret = laptop.cookie.split('=')[1]!
    // Under a name of the family that is no session's, under another session's name, and under the name no session's cookie has
    for (const name of ['it_session_another', nameOf(other.session), 'it_session', 'session'])
      expect([name, (await tokenFor(t, `${name}=${secret}`)).status]).toEqual([name, 401])
    expect((await endOf(t, { session: laptop.session, cookie: `it_session_another=${secret}` })).status).toBe(401)
    expect((await tokenFor(t, laptop.cookie)).status).toBe(200)
  })

  test('what is looked at of what a browser presents is bounded: only what is shaped like a session’s secret, and only so many', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const hashed = vi.spyOn(crypto.subtle, 'digest')
    try {
      // Nothing that is not shaped like a secret is hashed or looked up, whatever name it comes under
      const misshapen = ['short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`].map((value, i) => `it_session_misshapen${i}=${value}`)
      expect((await tokenFor(t, misshapen.join('; '))).status).toBe(401)
      expect(hashed).toHaveBeenCalledTimes(0)
      // Of well-shaped ones, two hundred are looked at and no more: a session's own cookie behind them is not reached
      const filler = (n: number) => Array.from({ length: n }, (_, i) => `it_session_filler${i}=${String(i).padStart(43, 'x')}`).join('; ')
      expect((await tokenFor(t, `${filler(250)}; ${laptop.cookie}`)).status).toBe(401)
      expect(hashed).toHaveBeenCalledTimes(200)
      expect((await tokenFor(t, `${filler(199)}; ${laptop.cookie}`)).status).toBe(200)
    } finally {
      hashed.mockRestore()
    }
  })

  test('a session is noted as seen once an hour and no oftener, and a browser may ask for a token only so often', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const other = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const seen = async () => (await kept(t)).sessions.find((x) => x._id === laptop.session)!.lastSeenAt
    const first = await seen()
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(300_000)
      await tokenFor(t, laptop.cookie)
      expect(await seen()).toBe(first)
    }
    await vi.advanceTimersByTimeAsync(300_000)
    await tokenFor(t, laptop.cookie)
    expect(await seen()).toBe(first + 3_600_000)
    // Thirty at once, and then it is told to wait
    await vi.advanceTimersByTimeAsync(60_000)
    const asked = []
    for (let i = 0; i < 40; i++) asked.push((await tokenFor(t, laptop.cookie)).status)
    expect([asked.filter((x) => x === 200).length, asked.slice(30).includes(200), asked.slice(30).includes(401)]).toEqual([30, false, false])
    const [name, secret] = laptop.cookie.split('=') as [string, string]
    expect(await code(t.mutation(internal.sessions._present, { presented: [{ name, hash: await hashOf(secret) }] }))).toBe('rate_limited')
    // One browser asking too often takes nothing from another
    expect((await tokenFor(t, other.cookie)).status).toBe(200)
  })

  test('a session that ended is kept a day, and one that nothing asked with for a year is ended and cleaned away', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const other = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const there = async () => (await kept(t)).sessions.map((x) => x._id)
    await endOf(t, laptop)
    await vi.advanceTimersByTimeAsync(23 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await there()).toEqual([laptop.session, other.session])
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await there()).toEqual([other.session])
    // A browser keeps its cookie for a year from when it was last given it, which this one was when it was paired
    await vi.advanceTimersByTimeAsync(364 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await there()).toEqual([other.session])
    await vi.advanceTimersByTimeAsync(2 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await there()).toEqual([])
    expect(await alive(other.browser)).toBe(false)
  })

  test('the owner’s browser asks for a screen’s code, and the browser that redeems it is a screen', async () => {
    const { t, machine } = await installed()
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const invited = await owner.browser.mutation(api.sessions.inviteScreen, {})
    const screen = await pair(t, invited.code)
    expect([screen.role, claimsOf(screen.token).role, screen.user]).toEqual(['screen', 'screen', owner.user])
    expect(await code(screen.browser.query(api.artifacts.list, {}))).toBe('ok')
    expect(await code(screen.browser.query(api.machines.list, {}))).toBe('forbidden')
  })

  test('a screen’s code opened in the owner’s own browser is refused there and left for the screen it was made for', async () => {
    const { t, machine } = await installed()
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const invited = await owner.browser.mutation(api.sessions.inviteScreen, {})
    const screensCode = async () => (await kept(t)).invites.filter((i) => i.role === 'screen').map((i) => i.usedAt !== undefined)
    // The owner opens the address where they are, to see it work
    const here = await redeem(t, invited.code, asSite(owner.cookie))
    expect([here.status, ((await here.json()) as { code: string }).code, here.headers.getSetCookie()]).toEqual([409, 'already_owner', []])
    // Found as the owner's among whatever other cookies of the family are sent, ahead of it
    const planted = await redeem(t, invited.code, asSite(`it_session_planted=${'1'.repeat(43)}; ${owner.cookie}`))
    expect(planted.status).toBe(409)
    // Their browser is the owner's as it was. The code is not used, and no session began
    expect(((await (await tokenFor(t, owner.cookie)).json()) as { role: string; session: string }).role).toBe('owner')
    expect(await code(owner.browser.query(api.machines.list, {}))).toBe('ok')
    expect([await screensCode(), (await kept(t)).sessions.length]).toEqual([[false], 1])
    // The screen it was made for redeems it
    const screen = await pair(t, invited.code)
    expect([screen.role, await screensCode()]).toEqual(['screen', [true]])
    // Used, it is refused in the owner's browser as it is anywhere
    expect((await redeem(t, invited.code, asSite(owner.cookie))).status).toBe(401)
    expect((await tokenFor(t, owner.cookie)).status).toBe(200)
    // A wrong code there is refused, as anywhere
    expect((await redeem(t, 'not-the-code', asSite(owner.cookie))).status).toBe(401)
  })

  test('a screen’s code is redeemed by a browser whose session as the owner’s is over, and by another screen’s browser, which stays a screen', async () => {
    const { t, machine } = await installed()
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const stays = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const first = await stays.browser.mutation(api.sessions.inviteScreen, {})
    const second = await stays.browser.mutation(api.sessions.inviteScreen, {})
    // Signed out, the browser still sends the cookie it held: it is nobody's, and the code makes it a screen
    expect((await endOf(t, owner)).status).toBe(200)
    const signedOut = await redeem(t, first.code, asSite(owner.cookie))
    expect(signedOut.status).toBe(200)
    const screen = (await (await tokenFor(t, cookieOf(signedOut))).json()) as { role: string; session: string }
    expect(screen.role).toBe('screen')
    // A screen that redeems another screen's code holds the new session, and the one it had is over
    const again = await redeem(t, second.code, asSite(cookieOf(signedOut)))
    expect(again.status).toBe(200)
    expect(((await (await tokenFor(t, cookieOf(again))).json()) as { role: string }).role).toBe('screen')
    expect((await tokenFor(t, cookieOf(signedOut))).status).toBe(401)
  })

  test('an owner’s code redeemed by a screen’s browser makes that browser the owner’s', async () => {
    const { t, machine } = await installed()
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const screen = await pair(t, (await owner.browser.mutation(api.sessions.inviteScreen, {})).code)
    const promoted = await redeem(t, (await machine.mutation(api.sessions.inviteOwner, {})).code, asSite(screen.cookie))
    expect(promoted.status).toBe(200)
    expect(((await (await tokenFor(t, cookieOf(promoted))).json()) as { role: string }).role).toBe('owner')
    // The session it had as a screen ended as the new one began
    expect(await alive(screen.browser)).toBe(false)
    expect(await code(owner.browser.query(api.machines.list, {}))).toBe('ok')
  })

  test('each kind of code is asked for only by who may, only so often, and is good only for what it was made for', async () => {
    const { t, machine } = await installed()
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const screen = await pair(t, (await owner.browser.mutation(api.sessions.inviteScreen, {})).code)
    // The owner's code comes from the machine itself, and a screen's from the owner's browser
    expect(await code(owner.browser.mutation(api.sessions.inviteOwner, {}))).toBe('forbidden')
    expect(await code(machine.mutation(api.sessions.inviteScreen, {}))).toBe('forbidden')
    for (const ask of [api.sessions.inviteOwner, api.sessions.inviteScreen, api.sessions.inviteMachine])
      expect(await code(screen.browser.mutation(ask, {}))).toBe('forbidden')
    // A machine's code pairs no browser, and a browser's enrols no machine
    const forMachine = await owner.browser.mutation(api.sessions.inviteMachine, {})
    expect((await redeem(t, forMachine.code)).status).toBe(401)
    const forBrowser = await machine.mutation(api.sessions.inviteOwner, {})
    const enrolled = await t.fetch('/bridge/enroll', {
      method: 'POST',
      body: JSON.stringify({ code: forBrowser.code, publicKey: await aPublicKey(), name: 'x' }),
    })
    expect(enrolled.status).toBe(401)
    expect((await t.run((ctx) => ctx.db.query('machines').collect())).length).toBe(1)
    // Ten codes a minute for one person, whoever asks
    const asked = []
    for (let i = 0; i < 8; i++) asked.push(await code(machine.mutation(api.sessions.inviteMachine, {})))
    expect([asked.filter((x) => x === 'ok').length, asked.at(-1)]).toEqual([6, 'rate_limited'])
  })
})

describe('what a paired screen may do, and what it may not', () => {
  const key = 'alice-screen-key-001'
  async function household() {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION, state: '{"a":1}' })
    const screen = await paired(t, 'alice', 'screen', key, 'Mozilla/5.0 (iPad) Safari/605')
    return { t, alice, m, p, screen, s: screen.browser }
  }

  test('a screen shows pages and answers them, is a display that names itself, takes and answers notifications, and signs itself out', async () => {
    const { m, p, screen, s } = await household()
    expect(await alive(s)).toBe(true)
    expect((await s.query(api.artifacts.list, {})).map((a) => a.slug)).toEqual(['plan'])
    expect((await s.query(api.artifacts.get, { slug: 'plan' })).version).toBe(1)
    expect(await stateOf(s, 'plan')).toEqual({ a: 1 })
    const mount = await s.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: key })
    expect(claimsOf((await s.action(api.mounts.ticket, { mountId: mount.mountId })).ticket).d).toBe(screen.display.id)
    const { actionId } = await s.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: key, envelope: envelope('click-0001') })
    expect((await inbox(m)).map((c) => c.id)).toEqual([actionId])
    expect((await s.query(api.actions.forArtifact, { slug: 'plan' })).map((x) => x.id)).toEqual([actionId])
    await s.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'draft', value: '"kept"' })
    // It is a display, and says what it is called
    expect((await s.query(api.displays.mine, { key }))?.id).toBe(screen.display.id)
    expect((await s.mutation(api.displays.heartbeat, { key })).now).toBe(Date.now())
    expect(await s.query(api.displays.wasForgotten, { key })).toBe(false)
    await s.mutation(api.displays.rename, { displayId: screen.display.id, name: 'Kitchen' })
    // It is sent notifications, and answers them
    expect(await s.action(api.push.publicKey, {})).toBe('the-key-a-browser-subscribes-with')
    await s.mutation(api.push.subscribe, { key, endpoint: PUSH('kitchen'), p256dh: 'p', auth: 'a' })
    const note = await m.as.mutation(api.notifications.send, { text: 'Deploy?', slug: 'plan', display: 'kitchen', buttons: [{ label: 'Yes', action: 'yes' }] })
    expect((await s.query(api.notifications.list, { key })).map((n) => n.id)).toEqual([note.id])
    await s.mutation(api.notifications.seen, { key, ids: [note.id] })
    expect((await s.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: key })).actionId).toBeTruthy()
    await s.mutation(api.notifications.dismiss, { key, ids: [note.id] })
    await s.mutation(api.push.unsubscribe, { key })
    // And it signs itself out
    expect((await s.action(api.displays.signOutToken, { key })).display).toBe(screen.display.id)
    const { job } = await s.mutation(api.displays.signOut, { key })
    expect(await s.query(api.displays.signOutConfirmed, { job })).toBe(false)
  })

  test('a screen that registers where there are as many displays as there may be makes room only by letting go of a display of its own', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    await vi.advanceTimersByTimeAsync(7000)
    const screen = await paired(t, 'alice', 'screen', key)
    for (let i = 3; i <= QUOTA.displays; i++) {
      await vi.advanceTimersByTimeAsync(7000)
      await alice.browser.mutation(api.displays.register, { key: `alice-extra-key-${String(i).padStart(4, '0')}`, userAgent: 'x' })
    }
    // None of them has been open for ten minutes, and nobody named any or turned notifications on for it: each is one that would be let go
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    const displays = async () => (await alice.browser.query(api.displays.list, {})).map((d) => d.id)
    const before = await displays()
    expect(before.length).toBe(QUOTA.displays)
    // A screen with no display of its own has none to let go, and is refused as it would be were every display in use
    const another = await browserOf(t, 'alice', 'screen')
    expect(await code(another.browser.mutation(api.displays.register, { key: 'alice-screen-key-002', userAgent: 'x' }))).toBe('limit')
    await settle(t)
    expect(await displays()).toEqual(before)
    expect(content.calls.filter((c) => c.op === 'revoke')).toEqual([])
    // One that has a display lets go of that one, though the owner's own has gone longer unopened
    expect(await code(screen.browser.mutation(api.displays.register, { key: 'alice-screen-key-003', userAgent: 'x' }))).toBe('ok')
    await settle(t)
    const after = await displays()
    expect([after.length, after.includes(alice.display.id), after.includes(screen.display.id)]).toEqual([QUOTA.displays, true, false])
    expect(content.calls.filter((c) => c.op === 'revoke').map((c) => c.body.displayId)).toEqual([screen.display.id])
  })

  test('a screen is refused whatever changes what the person has, or says what else they have, and nothing comes of its asking', async () => {
    const { t, alice, m, p, screen, s } = await household()
    const before = await t.run(async (ctx) =>
      JSON.stringify([
        await ctx.db.query('users').collect(),
        await ctx.db.query('displays').collect(),
        await ctx.db.query('machines').collect(),
        await ctx.db.query('artifacts').collect(),
        await ctx.db.query('sessions').collect(),
        await ctx.db.query('invites').collect(),
      ]),
    )
    const refused: (() => Promise<unknown>)[] = [
      () => s.query(api.displays.list, {}),
      () => s.mutation(api.displays.forget, { displayId: alice.display.id }),
      () => s.mutation(api.displays.forget, { displayId: screen.display.id }),
      () => s.query(api.machines.list, {}),
      () => s.mutation(api.machines.revoke, { machineId: m.id }),
      () => s.mutation(api.machines.rename, { machineId: m.id, name: 'mine' }),
      () => s.mutation(api.machines.toggle, { machineId: m.id, harness: 'codex', on: true }),
      () => s.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true }),
      () => s.mutation(api.artifacts.remove, { slug: 'plan' }),
      () => s.mutation(api.artifacts.organize, { artifactId: p.artifactId, pinned: true }),
      () => s.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 }),
      () => s.mutation(api.account.exportStart, {}),
      () => s.query(api.account.exportMachines, { owner: alice.user, cursor: null }),
      () => s.query(api.account.exportPage, { artifactId: p.artifactId }),
      () => s.query(api.account.exportActions, { artifactId: p.artifactId, cursor: null }),
      () => s.query(api.account.exportNotifications, { owner: alice.user, cursor: null }),
      () => s.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user }),
      () => s.mutation(api.sessions.inviteOwner, {}),
      () => s.mutation(api.sessions.inviteScreen, {}),
      () => s.mutation(api.sessions.inviteMachine, {}),
      // And, like any browser, what only a machine may do
      () => s.action(api.publish.begin, { title: 'x', files: page }),
      () => s.mutation(api.state.patch, { slug: 'plan', patch: '{}' }),
      () => s.mutation(api.notifications.send, { text: 'hi' }),
      () => s.mutation(api.displays.show, { slug: 'plan' }),
      () => s.query(api.delivery.inbox, { listening: [] }),
      () => s.query(api.machines.me, {}),
    ]
    for (const c of refused) expect(await code(c)).toBe('forbidden')
    // Another display is, to a screen, no display to name
    expect(await code(s.mutation(api.displays.rename, { displayId: alice.display.id, name: 'Mine now' }))).toBe('not_found')
    expect(
      await t.run(async (ctx) =>
        JSON.stringify([
          await ctx.db.query('users').collect(),
          await ctx.db.query('displays').collect(),
          await ctx.db.query('machines').collect(),
          await ctx.db.query('artifacts').collect(),
          await ctx.db.query('sessions').collect(),
          await ctx.db.query('invites').collect(),
        ]),
      ),
    ).toBe(before)
    // Every one of the person's own is the owner's browser's to do
    const o = alice.browser
    for (const c of [
      () => o.query(api.displays.list, {}),
      () => o.mutation(api.displays.rename, { displayId: screen.display.id, name: 'Kitchen' }),
      () => o.query(api.machines.list, {}),
      () => o.mutation(api.machines.rename, { machineId: m.id, name: 'laptop' }),
      () => o.mutation(api.artifacts.organize, { artifactId: p.artifactId, pinned: true }),
      () => o.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 }),
      () => o.mutation(api.account.exportStart, {}),
      () => o.mutation(api.sessions.inviteScreen, {}),
      () => o.mutation(api.displays.forget, { displayId: screen.display.id }),
      () => o.mutation(api.artifacts.remove, { slug: 'plan' }),
    ])
      expect(await code(c)).toBe('ok')
  })

  test('a screen is only ever the display it registered itself: naming another display’s key gets it nowhere', async () => {
    const { t, alice, m, p, screen, s } = await household()
    const theirs = displayKey('alice')
    const note = await m.as.mutation(api.notifications.send, {
      text: 'For the laptop',
      slug: 'plan',
      display: 'chrome on linux',
      buttons: [{ label: 'Yes', action: 'yes' }],
    })
    expect(await s.query(api.displays.mine, { key: theirs })).toBeNull()
    for (const c of [
      () => s.mutation(api.displays.heartbeat, { key: theirs }),
      () => s.mutation(api.displays.signOut, { key: theirs }),
      () => s.action(api.displays.signOutToken, { key: theirs }),
      () => s.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: theirs }),
      () => s.mutation(api.push.subscribe, { key: theirs, endpoint: PUSH('x'), p256dh: 'p', auth: 'a' }),
      () => s.mutation(api.push.unsubscribe, { key: theirs }),
      () => s.mutation(api.notifications.seen, { key: theirs, ids: [note.id] }),
      () => s.mutation(api.notifications.dismiss, { key: theirs, ids: [note.id] }),
      () => s.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: theirs }),
    ])
      expect(await code(c)).toBe('not_found')
    // What is addressed to the laptop alone is in the screen's tray under neither key, and is not the screen's to answer
    expect(await s.query(api.notifications.list, { key: theirs })).toEqual([])
    expect(await s.query(api.notifications.list, { key })).toEqual([])
    expect(await code(s.mutation(api.notifications.dismiss, { key, ids: [note.id] }))).toBe('not_found')
    expect(await code(s.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: key }))).toBe('not_found')
    // Nor is it given the ticket of a showing on the laptop, though it has come by the showing's id
    const onLaptop = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: theirs })
    expect(await code(s.action(api.mounts.ticket, { mountId: onLaptop.mountId }))).toBe('conflict')
    expect((await alice.browser.action(api.mounts.ticket, { mountId: onLaptop.mountId })).ticket).toBeTruthy()
    expect((await alice.browser.query(api.notifications.list, { key: theirs })).map((n) => [n.id, n.seen])).toEqual([[note.id, false]])
    // A click it sends under that key is still a click of the person's, noted against no display
    const { actionId } = await s.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: theirs, envelope: envelope('click-0001') })
    expect((await t.run((ctx) => ctx.db.get(actionId)))?.displayId).toBeUndefined()
    // The owner's browser speaks for any display the person has
    expect((await alice.browser.query(api.displays.mine, { key }))?.id).toBe(screen.display.id)
    expect((await alice.browser.mutation(api.displays.heartbeat, { key })).now).toBe(Date.now())
  })
})

describe("two people cannot see or touch each other's things", () => {
  test('every way in is closed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const am = await machineOf(t, 'alice')
    const bm = await machineOf(t, 'bob')
    const p = await publish(am, 'plan', { state: '{"secret":"alice only"}', session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    const mount = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    const note = await am.as.mutation(api.notifications.send, { text: 'approve?', slug: 'plan', buttons: [{ label: 'Yes', action: 'yes' }] })

    // Bob in a browser
    const b = bob.browser
    for (const c of [
      () => b.query(api.artifacts.get, { artifactId: p.artifactId }),
      () => b.query(api.state.get, { artifactId: p.artifactId }),
      () => b.query(api.actions.forArtifact, { artifactId: p.artifactId }),
      () => b.query(api.account.exportPage, { artifactId: p.artifactId }),
      () => b.query(api.account.exportActions, { artifactId: p.artifactId, cursor: null }),
      () => b.mutation(api.artifacts.remove, { artifactId: p.artifactId }),
      () => b.mutation(api.artifacts.organize, { artifactId: p.artifactId, pinned: true }),
      () => b.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('bob'), envelope: envelope('click-0002') }),
      () => b.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('bob') }),
      () => b.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value: '1' }),
      () => b.mutation(api.displays.rename, { displayId: alice.display.id, name: 'mine now' }),
      () => b.mutation(api.displays.forget, { displayId: alice.display.id }),
      () => b.mutation(api.machines.revoke, { machineId: am.id }),
      () => b.mutation(api.machines.rename, { machineId: am.id, name: 'mine' }),
      () => b.mutation(api.machines.toggle, { machineId: am.id, harness: 'codex', on: true }),
      () => b.mutation(api.machines.wake, { machineId: am.id, harness: 'claude-code', on: true }),
      () => b.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: displayKey('bob') }),
      () => b.mutation(api.notifications.dismiss, { ids: [note.id], key: displayKey('bob') }),
      () => b.query(api.artifacts.get, { slug: 'plan' }),
    ])
      expect(await code(c)).toBe('not_found')
    // Bob cannot take the ticket for Alice's mount, nor use Alice's display key
    expect(await code(b.action(api.mounts.ticket, { mountId: mount.mountId }))).toBe('conflict')
    expect(await code(b.mutation(api.displays.heartbeat, { key: displayKey('alice') }))).toBe('not_found')
    expect(await code(b.mutation(api.notifications.seen, { key: displayKey('alice'), ids: [note.id] }))).toBe('not_found')
    // Named with his own display, another person's notification is simply not his to mark
    await b.mutation(api.notifications.seen, { key: displayKey('bob'), ids: [note.id] })
    expect((await alice.browser.query(api.notifications.list, { key: displayKey('alice') }))[0]).toMatchObject({ seen: false })
    expect(await b.query(api.displays.mine, { key: displayKey('alice') })).toBeNull()

    // Bob's machine
    for (const c of [
      () => bm.as.query(api.artifacts.get, { artifactId: p.artifactId }),
      () => bm.as.query(api.state.get, { slug: 'plan' }),
      () => bm.as.mutation(api.state.patch, { slug: 'plan', patch: '{"x":1}' }),
      () => bm.as.query(api.delivery.waiting, { slug: 'plan' }),
      () => bm.as.query(api.delivery.get, { id: actionId }),
      () => bm.as.mutation(api.delivery.handedOff, { id: actionId, route: 'addon' }),
      () => bm.as.mutation(api.delivery.release, { id: actionId }),
      () => bm.as.mutation(api.displays.show, { slug: 'plan' }),
      () => bm.as.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 }),
      () => bm.as.action(api.publish.finish, { artifactId: p.artifactId, version: 1 }),
      () => bm.as.mutation(api.notifications.send, { text: 'x', slug: 'plan' }),
    ])
      expect(await code(c)).toBe('not_found')
    expect(await bm.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([])
    expect(await bm.as.mutation(api.delivery.renew, { ids: [actionId] })).toEqual([])
    // Even naming Alice's conversation, Bob's machine is offered nothing
    expect(await inbox(bm)).toEqual([])
    expect(await inbox(bm, [], ['claude-code'])).toEqual([])
    expect(await bm.as.query(api.delivery.allWaiting, {})).toEqual([])

    // What each of them lists is only their own
    expect((await b.query(api.artifacts.list, {})).length).toBe(0)
    expect((await bm.as.query(api.artifacts.list, {})).length).toBe(0)
    expect((await b.query(api.displays.list, {})).map((d) => d.id)).toEqual([bob.display.id])
    expect((await b.query(api.machines.list, {})).map((m) => m.id)).toEqual([bm.id])
    expect((await b.query(api.notifications.list, { key: displayKey('bob') })).length).toBe(0)
    const bobs = await b.mutation(api.account.exportStart, {})
    expect(bobs.pages).toEqual([])
    expect((await b.query(api.account.exportNotifications, { owner: bobs.owner, cursor: null })).notifications).toEqual([])

    // And nothing of Alice's was changed by any of it
    expect(await stateOf(alice.browser, 'plan')).toEqual({ secret: 'alice only' })
    expect((await alice.browser.query(api.artifacts.list, {})).map((a) => a.slug)).toEqual(['plan'])
    expect((await inbox(am)).map((c) => c.id)).toEqual([actionId])

    // Bob publishing under the same id makes a page of his own
    await publish(bm, 'plan')
    expect((await alice.browser.query(api.artifacts.list, {})).length).toBe(1)
    expect((await b.query(api.artifacts.list, {}))[0]?.id).not.toBe(p.artifactId)
  })
})

describe('publishing', () => {
  test('a page goes live only when the content service confirms the files, and the old version stays until then', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const first = await publish(m, 'plan')
    expect(first.version).toBe(1)
    // What is uploaded goes to the door on this machine, and the page is where the person at this machine opens the site
    expect([first.upload.url, first.url]).toEqual([`${DOOR}/upload/`, 'http://localhost:39000/p/plan'])
    const begun = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Plan, revised', files: page })
    // Neither the content nor the title changes until the new version is confirmed
    expect(await alice.browser.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ version: 1, title: 'Title of plan' })
    content.verifyOk = false
    expect(await code(m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: 2 }))).toBe('invalid')
    expect((await alice.browser.query(api.artifacts.get, { slug: 'plan' })).version).toBe(1)
    content.verifyOk = true
    expect((await m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: 2 })).version).toBe(2)
    expect(await alice.browser.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ version: 2, title: 'Plan, revised' })
    expect(await code(m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: 2 }))).toBe('ok')
    const verify = content.calls.filter((c) => c.op === 'verify').at(-1)!
    expect(verify.body.prefix).toMatch(/^u\/[^/]+\/[^/]+\/2\/$/)
  })

  test('the content service is told exactly which files to expect before a grant is given, and the grant names only the folder', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begun = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Plan', files: page })
    const stage = content.calls.find((c) => c.op === 'stage')!
    expect(stage.body).toEqual({ prefix: expect.stringMatching(/^u\/[^/]+\/[^/]+\/1\/$/), files: page })
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(begun.upload.grant, jwks, { issuer: SITE, audience: 'it-upload' })
    expect(payload.p).toBe(stage.body.prefix)
    expect(payload.exp! - payload.iat!).toBe(PUBLICATION.grantSeconds)
    await expect(jwtVerify(begun.upload.grant, jwks, { issuer: SITE, audience: 'it-content' })).rejects.toThrow()
  })

  test('every message to the content service is signed for that operation and for that exact body', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.action(api.publish.begin, { slug: 'plan', title: 'Plan', files: page })
    const stage = content.calls.find((c) => c.op === 'stage')!
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(stage.token, jwks, { issuer: SITE, audience: 'it-control' })
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stage.body)))).toString('hex')
    expect(payload).toMatchObject({ sub: 'stage', h: digest })
    expect(payload.exp! - payload.iat!).toBe(60)
    // And every one of them goes to the door on this machine, whatever it is about
    await publish(m, 'other')
    await m.as.mutation(api.artifacts.remove, { slug: 'other' })
    await settle(t)
    expect([...new Set(content.calls.map((c) => c.op))].sort()).toEqual(['delete', 'stage', 'verify'])
    for (const c of content.calls) expect(c.url).toBe(`${DOOR}/control/${c.op}`)
  })

  test('a slower publish that finishes late does not replace a newer one, even after a rollback', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    const slow = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Slow', files: page })
    const fast = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Fast', files: page })
    expect((await m.as.action(api.publish.finish, { artifactId: fast.artifactId, version: fast.version })).version).toBe(3)
    await m.as.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 })
    // And the one that was too slow is told so, not that it was published: nobody will ever see it
    expect(await code(m.as.action(api.publish.finish, { artifactId: slow.artifactId, version: slow.version }))).toBe('conflict')
    // The page is as it was rolled back to, title included
    expect(await alice.browser.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ version: 1, title: 'Title of plan' })
  })

  test('bad files are refused before anything is stored', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begin = (files: unknown, extra: Record<string, unknown> = {}) =>
      code(m.as.action(api.publish.begin, { title: 'x', files: files as typeof page, ...extra }))
    expect(await begin([{ path: 'other.html', size: 1, sha256: sha }])).toBe('invalid')
    expect(await begin([...page, { path: '../escape.html', size: 1, sha256: sha }])).toBe('invalid')
    expect(await begin([...page, { path: '/etc/passwd', size: 1, sha256: sha }])).toBe('invalid')
    expect(await begin([...page, { path: 'a/./b.js', size: 1, sha256: sha }])).toBe('invalid')
    expect(await begin([...page, page[0]])).toBe('invalid')
    expect(await begin([{ path: 'index.html', size: 1, sha256: 'not-a-hash' }])).toBe('invalid')
    expect(await begin([{ path: 'index.html', size: LIMITS.fileBytes + 1, sha256: sha }])).toBe('limit')
    expect(await begin([...page, ...Array.from({ length: 5 }, (_, i) => ({ path: `big${i}.bin`, size: LIMITS.fileBytes, sha256: sha }))])).toBe('limit')
    expect(await begin(page, { slug: 'Not A Slug' })).toBe('invalid')
    expect(await begin(page, { title: ' ' })).toBe('invalid')
    expect(await begin(page, { state: '[1,2]' })).toBe('invalid')
    expect(await begin(page, { state: 'not json' })).toBe('invalid')
    expect(await t.run((ctx) => ctx.db.query('artifacts').collect())).toEqual([])
  })

  test('a publish that was begun counts against the quota until it is finished or cleared away', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const big = [
      ...page,
      { path: 'video.mp4', size: LIMITS.fileBytes, sha256: sha },
      { path: 'b.mp4', size: LIMITS.fileBytes, sha256: sha },
      { path: 'c.mp4', size: LIMITS.fileBytes, sha256: sha },
    ]
    const each = 100 + 3 * LIMITS.fileBytes
    let begun = 0
    // Never finishing any of them: the quota still fills
    for (let i = 0; i < 40; i++) {
      const r = await code(m.as.action(api.publish.begin, { slug: `p${i}`, title: 'x', files: big }))
      if (r !== 'ok') {
        expect(r).toBe('limit')
        break
      }
      begun++
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect(begun).toBe(Math.floor(QUOTA.bytes / each))
    const user = () => totals(t)
    expect(await user()).toMatchObject({ stagingCount: begun, stagingBytes: begun * each })
    // An hour on, the sweep takes them away, gives the quota back, and has their bytes removed
    await vi.advanceTimersByTimeAsync(3_700_000)
    await t.mutation(internal.retention.sweepStaging, {})
    await settle(t)
    expect(await user()).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(begun)
    expect(await code(m.as.action(api.publish.begin, { slug: 'p-again', title: 'x', files: big }))).toBe('ok')
  })

  test('only so many publishes may be in progress at once, and an abandoned one for the same page is cleared by the next', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < QUOTA.staging; i++) {
      await m.as.action(api.publish.begin, { slug: `p${i}`, title: 'x', files: page })
      await vi.advanceTimersByTimeAsync(2500)
    }
    expect(await code(m.as.action(api.publish.begin, { slug: 'one-more', title: 'x', files: page }))).toBe('limit')
    // The grant for p0 ran out long ago, so beginning p0 again replaces its abandoned attempt
    await vi.advanceTimersByTimeAsync(PUBLICATION.grantTailMs)
    expect(await code(m.as.action(api.publish.begin, { slug: 'p0', title: 'x', files: page }))).toBe('ok')
    expect((await totals(t)).stagingCount).toBe(QUOTA.staging)
  })

  test('asking to finish again and again is rate limited, even when every attempt fails', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begun = await m.as.action(api.publish.begin, { slug: 'plan', title: 'x', files: page })
    content.verifyOk = false
    const results = []
    for (let i = 0; i < 35; i++) results.push(await code(m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: 1 })))
    expect(results.filter((r) => r === 'invalid').length).toBe(30)
    expect(results.at(-1)).toBe('rate_limited')
    expect(content.calls.filter((c) => c.op === 'verify').length).toBe(30)
  })

  test('only the newest versions are kept, however many were begun in between, and the rest have their bytes removed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < LIMITS.versionsKept + 3; i++) {
      await publish(m, 'plan')
      // Attempts that are never finished must not confuse the count
      await m.as.action(api.publish.begin, { slug: 'plan', title: 'abandoned', files: page })
      await vi.advanceTimersByTimeAsync(5000)
    }
    await settle(t)
    const got = await alice.browser.query(api.artifacts.get, { slug: 'plan' })
    const published = (await t.run((ctx) => ctx.db.query('versions').collect())).filter((x) => x.status !== 'staging')
    expect(published.length).toBe(LIMITS.versionsKept)
    expect(published.filter((x) => x.status === 'live').map((x) => x.n)).toEqual([got.version])
    expect((await t.run((ctx) => ctx.db.query('artifacts').collect()))[0]!.bytes).toBe(LIMITS.versionsKept * 100)
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(3)
    const kept = published.map((x) => x.n).sort((a, b) => a - b)
    expect((await m.as.mutation(api.artifacts.rollback, { slug: 'plan', version: kept[2]! })).version).toBe(kept[2])
    expect(await code(m.as.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 }))).toBe('not_found')
  })

  test('every version that can still be gone back to is listed, however many publishes were begun since and never finished', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < LIMITS.versionsKept; i++) {
      await publish(m, 'plan')
      await vi.advanceTimersByTimeAsync(5000)
    }
    // Twelve more are begun and left, which is as many as the list once held of every kind together
    for (let i = 0; i < 12; i++) {
      await m.as.action(api.publish.begin, { slug: 'plan', title: 'abandoned', files: page })
      await vi.advanceTimersByTimeAsync(5000)
    }
    const listed = (await alice.browser.query(api.artifacts.get, { slug: 'plan' })).versions
    const finished = listed.filter((x) => x.status !== 'staging').map((x) => x.n)
    expect(finished).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    // Newest first, with the newest few of the unfinished ones among them
    expect(listed.map((x) => x.n)).toEqual([...listed.map((x) => x.n)].sort((a, b) => b - a))
    expect(listed.filter((x) => x.status === 'staging').length).toBeLessThanOrEqual(2)
    // And each of them can be gone back to
    expect((await m.as.mutation(api.artifacts.rollback, { slug: 'plan', version: 1 })).version).toBe(1)
    expect((await alice.browser.query(api.artifacts.get, { slug: 'plan' })).versions.filter((x) => x.status !== 'staging').map((x) => [x.n, x.status])).toEqual(
      [
        [10, 'retired'],
        [9, 'retired'],
        [8, 'retired'],
        [7, 'retired'],
        [6, 'retired'],
        [5, 'retired'],
        [4, 'retired'],
        [3, 'retired'],
        [2, 'retired'],
        [1, 'live'],
      ],
    )
  })

  test('the conversation that made a page keeps it, unless its machine is revoked or another says it is taking the page', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const server = await machineOf(t, 'alice', 'server')
    // The one that makes it, and the same one publishing it again, are told nothing: the page is theirs
    expect((await publish(laptop, 'plan', { session: SESSION })).elsewhere).toBeUndefined()
    expect((await publish(laptop, 'plan', { session: SESSION })).elsewhere).toBeUndefined()
    // Another conversation that publishes it is told that the page stays where it was, on another machine or on the same one
    expect((await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-9' } })).elsewhere).toBe(true)
    expect((await publish(laptop, 'plan', { session: { harness: 'claude-code', id: 'sess-2' } })).elsewhere).toBe(true)
    // A script that is in no conversation has nothing to take the page to, and is told nothing
    expect((await publish(laptop, 'plan')).elsewhere).toBeUndefined()
    const owner = async () => {
      const got = await alice.browser.query(api.artifacts.get, { slug: 'plan' })
      return [got.machine, got.session]
    }
    expect(await owner()).toEqual(['laptop', SESSION])
    // Said explicitly, the page changes hands, and the one that took it is told that it has
    const taken = await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-9' }, take: true })
    expect([taken.elsewhere, taken.took]).toEqual([undefined, true])
    expect(await owner()).toEqual(['server', { harness: 'codex', id: 'thread-9' }])
    // Asked for again by the one that has it, nothing changes hands and nothing is said
    expect((await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-9' }, take: true })).took).toBeUndefined()
    // And a page whose machine is gone goes to whoever publishes it next
    await alice.browser.mutation(api.machines.revoke, { machineId: server.id })
    expect((await publish(laptop, 'plan', { session: { harness: 'claude-code', id: 'sess-2' } })).elsewhere).toBeUndefined()
    expect(await owner()).toEqual(['laptop', { harness: 'claude-code', id: 'sess-2' }])
  })

  test('a conversation that makes a page under an id that is another conversation’s page publishes nothing and is told so, also where the two began it at the same moment; its own page, one nobody has, and one whose machine is gone are made', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const server = await machineOf(t, 'alice', 'server')
    const other = { harness: 'pi', id: 'conversation-2' }
    /** What a refusal says of itself: its code, and that the page is another conversation's. */
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => 'published',
        (err) => [refusalCode(err), /anothers\\*":true/.test(JSON.stringify((err as { data?: unknown }).data ?? String(err)))],
      )
    const own = (m: typeof laptop, session: { harness: string; id: string } | undefined, slug = 'counter') => publish(m, slug, { session, own: true })
    const has = async (slug = 'counter') => {
      const got = await alice.browser.query(api.artifacts.get, { slug })
      return [got.machine, got.session, got.version]
    }
    // The one that makes it, and makes it again, has it
    await own(laptop, SESSION)
    expect((await own(laptop, SESSION)).version).toBe(2)
    // Another conversation that chose the same id, on another machine or on the same one, publishes nothing
    expect(await refused(own(server, other))).toEqual(['conflict', true])
    expect(await refused(own(laptop, other))).toEqual(['conflict', true])
    expect(await has()).toEqual(['laptop', SESSION, 2])
    // Nothing of what it began is left to be counted or cleaned: it was refused before anything was begun
    expect(await t.run((ctx) => ctx.db.query('versions').collect())).toHaveLength(2)
    // Said in so many words, it takes the page, as before
    expect((await publish(server, 'counter', { session: other, own: true, take: true })).took).toBe(true)
    expect(await has()).toEqual(['server', other, 3])
    // And the conversation that had it is now the one that is refused
    expect(await refused(own(laptop, SESSION))).toEqual(['conflict', true])
    // A page made from a plain terminal is nobody's, and the conversation that makes it under that id has it
    await publish(laptop, 'notes')
    await own(server, other, 'notes')
    expect(await has('notes')).toEqual(['server', other, 2])
    // From a plain terminal there is no conversation to keep a page for: what is shown changes, and the page stays where it was
    expect((await publish(laptop, 'notes', { own: true })).version).toBe(3)
    expect(await has('notes')).toEqual(['server', other, 3])
    // Two conversations begin a page of an id nobody has at the same moment: both are let begin, the first to finish has made it,
    // and the other is told that it is that one's, with nothing of its own shown or left behind
    const first = await laptop.as.action(api.publish.begin, { slug: 'board', title: 'Board', files: page, session: SESSION, own: true })
    const second = await server.as.action(api.publish.begin, { slug: 'board', title: 'Board too', files: page, session: other, own: true })
    await server.as.action(api.publish.finish, { artifactId: second.artifactId, version: second.version })
    expect(await refused(laptop.as.action(api.publish.finish, { artifactId: first.artifactId, version: first.version }))).toEqual(['conflict', true])
    expect(await has('board')).toEqual(['server', other, 2])
    expect((await alice.browser.query(api.artifacts.get, { slug: 'board' })).title).toBe('Board too')
    expect((await t.run((ctx) => ctx.db.query('versions').collect())).filter((x) => x.status === 'staging')).toEqual([])
    // A page whose machine is gone is nobody's to keep: the next conversation to make it has it
    await alice.browser.mutation(api.machines.revoke, { machineId: server.id })
    await settle(t)
    await own(laptop, SESSION)
    expect((await has())[0]).toBe('laptop')
  })

  test('a conversation that shows a page takes it, with what was waiting on it, and the one that has it already takes nothing', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const yesterday = { harness: 'claude-code', id: 'sess-yesterday' }
    const today = { harness: 'claude-code', id: 'sess-today' }
    const p = await publish(laptop, 'board', { session: yesterday })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    const owner = async () => (await alice.browser.query(api.artifacts.get, { slug: 'board' })).session
    expect(await laptop.as.mutation(api.artifacts.take, { slug: 'board', session: yesterday })).toEqual({ took: false })
    expect(await laptop.as.mutation(api.artifacts.take, { slug: 'board', session: today, agent: 'claude-code' })).toEqual({ took: true })
    expect(await owner()).toEqual(today)
    await settle(t)
    // What was done on it before it changed hands is today's conversation's to answer
    expect((await inbox(laptop, [today])).map((c) => c.id)).toEqual([actionId])
    expect((await inbox(laptop, [yesterday])).map((c) => c.id)).toEqual([])
    // A browser cannot hand a page to a conversation, and nor can another person's machine
    expect(await code(alice.browser.mutation(api.artifacts.take, { slug: 'board', session: today }))).toBe('forbidden')
    await person(t, 'bob')
    const theirs = await machineOf(t, 'bob', 'desk')
    expect(await code(theirs.as.mutation(api.artifacts.take, { slug: 'board', session: today }))).toBe('not_found')
  })

  test('a page is not taken for a conversation whose name is longer than one that publishes may have, and stays with the one it had', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const p = await publish(laptop, 'board', { session: SESSION })
    const take = (session: { harness: string; id: string }) => code(laptop.as.mutation(api.artifacts.take, { slug: 'board', session }))
    expect(await take({ harness: 'claude-code', id: 's'.repeat(201) })).toBe('invalid')
    expect(await take({ harness: 'h'.repeat(41), id: 'sess-2' })).toBe('invalid')
    expect((await alice.browser.query(api.artifacts.get, { slug: 'board' })).session).toEqual(SESSION)
    // One as long as publishing takes is taken
    expect(await take({ harness: 'h'.repeat(40), id: 's'.repeat(200) })).toBe('ok')
    // A run of that conversation is the page's run, so the page says it is running and can be stopped
    await laptop.as.mutation(api.machines.runBegan, { for: { harness: 'h'.repeat(40), id: 's'.repeat(200) } })
    expect((await alice.browser.query(api.artifacts.get, { slug: 'board' })).run).not.toBeNull()
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
  })

  test('a publish that cannot be prepared leaves nothing behind, and says it may be tried again', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    content.stageOk = false
    expect(await code(m.as.action(api.publish.begin, { title: 'New page', files: page }))).toBe('unavailable')
    expect(await t.run(async (ctx) => [(await ctx.db.query('artifacts').collect()).length, (await ctx.db.query('versions').collect()).length])).toEqual([0, 0])
    expect(await totals(t)).toEqual({ waiting: 0, stagingCount: 0, stagingBytes: 0 })
    // A page that is already live is not touched by a failed attempt to update it
    content.stageOk = true
    await publish(m, 'plan')
    content.stageOk = false
    expect(await code(m.as.action(api.publish.begin, { slug: 'plan', title: 'Second try', files: page }))).toBe('unavailable')
    expect((await t.run((ctx) => ctx.db.query('artifacts').collect())).map((a) => [a.slug, a.currentVersion])).toEqual([['plan', 1]])
  })

  test('a first publish that is abandoned takes its page record with it when it is swept', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.action(api.publish.begin, { title: 'Never finished', files: page })
    expect((await t.run((ctx) => ctx.db.query('artifacts').collect())).length).toBe(1)
    await vi.advanceTimersByTimeAsync(3_700_000)
    await t.mutation(internal.retention.sweepStaging, {})
    expect((await t.run((ctx) => ctx.db.query('artifacts').collect())).length).toBe(0)
  })

  test('taking a page over moves it only once the publish has succeeded, and takes its waiting clicks along', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const server = await machineOf(t, 'alice', 'server')
    const p = await publish(laptop, 'plan', { session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    const theirs = { harness: 'codex', id: 'thread-9' }
    expect(await code(server.as.action(api.publish.begin, { slug: 'plan', title: 'x', files: page, take: true }))).toBe('invalid')
    // The attempt fails: nothing about who owns the page changes
    const begun = await server.as.action(api.publish.begin, { slug: 'plan', title: 'x', files: page, session: theirs, take: true })
    content.verifyOk = false
    await code(server.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version }))
    expect((await alice.browser.query(api.artifacts.get, { slug: 'plan' })).machine).toBe('laptop')
    expect((await inbox(laptop)).map((c) => c.id)).toEqual([actionId])
    // It succeeds: the page and the click already waiting on it go to the new conversation
    content.verifyOk = true
    await server.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })
    await settle(t)
    expect((await alice.browser.query(api.artifacts.get, { slug: 'plan' })).machine).toBe('server')
    expect(await inbox(laptop)).toEqual([])
    expect((await inbox(server, [theirs])).map((c) => c.id)).toEqual([actionId])
  })

  test('file names are measured in bytes, each and all together', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begin = (files: typeof page) => code(m.as.action(api.publish.begin, { title: 'x', files }))
    // 150 characters of three bytes each is past the limit for one path
    expect(await begin([...page, { path: `${'長'.repeat(150)}.js`, size: 1, sha256: sha }])).toBe('invalid')
    // Short enough each, too long together
    const many = Array.from({ length: 400 }, (_, i) => ({ path: `${String(i).padStart(4, '0')}-${'x'.repeat(200)}.js`, size: 1, sha256: sha }))
    expect(await begin([...page, ...many])).toBe('limit')
    expect(await begin([...page, ...many.slice(0, 100)])).toBe('ok')
  })

  test('past the limit on projects a page is still published, just without one', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await t.run(async (ctx) => {
      const user = (await ctx.db.query('users').collect())[0]!
      for (let i = 0; i < QUOTA.projects; i++) await ctx.db.insert('projects', { userId: user._id, key: `k${i}`, name: 'n', createdAt: 0 })
    })
    await publish(m, 'plan', { project: { key: 'one-more', name: 'x' } })
    expect((await t.run((ctx) => ctx.db.query('projects').collect())).length).toBe(QUOTA.projects)
  })
})

describe('tour page ownership', () => {
  const start = (m: Awaited<ReturnType<typeof machineOf>>, name: string, state = '{}') =>
    m.as.action(api.publish.begin, { slug: `tour-${name}`, title: 'A checklist', files: page, state, tour: name })
  const finish = (m: Awaited<ReturnType<typeof machineOf>>, begun: { artifactId: any; version: number }) =>
    m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })
  const make = async (m: Awaited<ReturnType<typeof machineOf>>, name: string, state = '{}') => {
    const begun = await start(m, name, state)
    await finish(m, begun)
    return begun
  }

  test('a legacy page with the same id, title and state keys is adopted once and keeps its mark on later showings', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy-match')
    const old = await publish(m, 'tour-checklist', { title: 'A checklist', state: '{"note":"the rain","added":[{"text":"Umbrella"}]}' })
    // Earlier programs wrote no ownership field. A current ordinary publication is not a legacy page.
    await t.run((ctx) => ctx.db.patch(old.artifactId, { tour: undefined }))
    const adopted = await make(m, 'checklist', '{"added":[],"note":""}')
    const mark = (await t.run((ctx) => ctx.db.get(old.artifactId)))!.tour
    expect(mark).toEqual({ name: 'checklist', identity: expect.any(String) })
    expect(adopted.artifactId).toBe(old.artifactId)
    await m.as.mutation(api.state.patch, { slug: 'tour-checklist', patch: '{"note":"an answer"}' })
    await make(m, 'checklist', '{"added":[],"note":""}')
    expect((await t.run((ctx) => ctx.db.get(old.artifactId)))!.tour).toEqual(mark)
    const cleared = await m.as.mutation(api.tour.clear, {})
    expect(cleared).toEqual({
      requested: ['tour-checklist'].map((slug) => ({ slug, job: expect.any(String) })),
      kept: [],
      seen: 0,
    })
    const receipt = await m.as.query(api.deletions.get, { job: cleared.requested[0]!.job })
    expect(receipt).toMatchObject({ slug: 'tour-checklist', state: 'pending' })
  })

  test('an old tour menu with progress is adopted once and keeps the steps already seen', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy-progress')
    const title = 'The It tour'
    const old = await publish(m, 'tour-menu', { title, state: '{"status":"done","picked":"chess","seen":["chess"]}' })
    await t.run((ctx) => ctx.db.patch(old.artifactId, { tour: undefined }))
    const begun = await m.as.action(api.publish.begin, {
      slug: 'tour-menu',
      title,
      files: page,
      state: '{"seen":[],"picked":"","status":"open"}',
      tour: 'menu',
    })
    await finish(m, begun)
    expect(begun.artifactId).toBe(old.artifactId)
    expect(await m.as.query(api.tour.seen, {})).toEqual({ seen: ['chess'] })
    expect(JSON.parse((await m.as.query(api.state.get, { slug: 'tour-menu' })).json)).toEqual({ status: 'open', picked: '', seen: ['chess'] })
  })

  test.each([
    { difference: 'id', slug: 'tour-menu', title: 'A checklist', state: '{"added":[],"note":""}' },
    { difference: 'title', slug: 'tour-checklist', title: 'My checklist', state: '{"added":[],"note":""}' },
    { difference: 'missing state key', slug: 'tour-checklist', title: 'A checklist', state: '{"added":[]}' },
    { difference: 'state key', slug: 'tour-checklist', title: 'A checklist', state: '{"added":[],"note":"","extra":true}' },
  ])('a legacy page with a different $difference is reported and left untouched', async ({ slug, title, state }) => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy-different')
    const old = await publish(m, slug, { title, state })
    await t.run((ctx) => ctx.db.patch(old.artifactId, { tour: undefined }))
    const before = await m.as.query(api.artifacts.get, { slug })
    const beforeState = await m.as.query(api.state.get, { slug })
    await expect(
      m.as.action(api.publish.begin, { slug, title: 'A checklist', state: '{"added":[],"note":""}', files: page, tour: 'checklist' }),
    ).rejects.toThrow(slug === 'tour-checklist' ? 'tour does not own' : 'known tour page id')
    expect(await m.as.mutation(api.tour.clear, {})).toEqual({ requested: [], kept: [slug], seen: 0 })
    expect(await m.as.query(api.artifacts.get, { slug })).toEqual(before)
    expect(await m.as.query(api.state.get, { slug })).toEqual(beforeState)
    expect((await t.run((ctx) => ctx.db.get(old.artifactId)))!.tour).toBeUndefined()
  })

  test.each(['publish', 'take', 'rollback'])('a legacy page adopted once cannot be adopted again after an ordinary %s', async (how) => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy-once')
    const initial = { title: 'A checklist', state: '{"added":[],"note":""}' }
    const old = await publish(m, 'tour-checklist', initial)
    await t.run((ctx) => ctx.db.patch(old.artifactId, { tour: undefined }))
    await make(m, 'checklist', initial.state)
    if (how === 'publish') await publish(m, 'tour-checklist', initial)
    else if (how === 'take') await m.as.mutation(api.artifacts.take, { slug: 'tour-checklist', session: SESSION })
    else await m.as.mutation(api.artifacts.rollback, { slug: 'tour-checklist', version: old.version })
    await expect(start(m, 'checklist', initial.state)).rejects.toThrow('tour does not own')
    expect(await m.as.mutation(api.tour.clear, {})).toEqual({
      requested: [],
      kept: ['tour-checklist'],
      seen: 0,
    })
  })

  test('a state change while an adopted legacy page uploads refuses its stale reset', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy-race')
    const old = await publish(m, 'tour-checklist', { title: 'A checklist', state: '{"added":[],"note":""}' })
    await t.run((ctx) => ctx.db.patch(old.artifactId, { tour: undefined }))
    const pending = await start(m, 'checklist', '{"added":[],"note":""}')
    await m.as.mutation(api.state.patch, { slug: 'tour-checklist', patch: '{"note":"keep this answer"}' })
    const state = await m.as.query(api.state.get, { slug: 'tour-checklist' })
    await expect(finish(m, pending)).rejects.toThrow('Nothing was replaced')
    expect((await m.as.query(api.artifacts.get, { slug: 'tour-checklist' })).version).toBe(old.version)
    expect(await m.as.query(api.state.get, { slug: 'tour-checklist' })).toEqual(state)
  })

  test('matching titles and state keys never adopt personal or unfinished pages', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-legacy')
    const initial = { added: [{ text: 'Umbrella' }], note: 'the rain', extra: true }
    await publish(m, 'tour-checklist', { title: 'A checklist', state: JSON.stringify(initial) })
    await publish(m, 'tour-menu', { title: 'The It tour', state: '{"status":"open","picked":"","seen":["chess"]}' })
    await m.as.action(api.publish.begin, { slug: 'tour-chess', title: 'A chessboard', files: page })
    const before = await m.as.query(api.artifacts.get, { slug: 'tour-checklist' })
    for (const name of ['checklist', 'menu', 'chess']) await expect(start(m, name)).rejects.toThrow('tour does not own')
    expect(await m.as.query(api.tour.seen, {})).toEqual({ seen: [] })
    const cleared = await m.as.mutation(api.tour.clear, {})
    expect(cleared.requested.map((r) => r.slug)).toEqual([])
    expect(cleared.kept).toEqual(['tour-menu', 'tour-chess', 'tour-checklist'])
    expect(await m.as.query(api.artifacts.get, { slug: 'tour-checklist' })).toEqual(before)
    expect(JSON.parse((await m.as.query(api.state.get, { slug: 'tour-checklist' })).json)).toEqual(initial)
    expect((await m.as.query(api.tour.get, {})).doneAt).toBeNull()
  })

  test('publication resets the step and merges the current marked menu progress in its transaction', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-progress')
    await make(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    const chess = await start(m, 'chess', '{"reply":"","note":""}')
    const drums = await start(m, 'drums', '{"theirs":[],"note":""}')
    await finish(m, drums)
    await finish(m, chess)
    expect(await m.as.query(api.tour.seen, {})).toEqual({ seen: ['drums', 'chess'] })
    await m.as.mutation(api.state.patch, { slug: 'tour-chess', patch: '{"reply":"e7e5","note":"answer"}' })
    await make(m, 'chess', '{"reply":"","note":""}')
    expect(JSON.parse((await m.as.query(api.state.get, { slug: 'tour-chess' })).json)).toEqual({ reply: '', note: '' })
    await m.as.mutation(api.state.patch, { slug: 'tour-menu', patch: '{"picked":"chess","status":"done"}' })
    await make(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    expect(JSON.parse((await m.as.query(api.state.get, { slug: 'tour-menu' })).json)).toEqual({ status: 'open', picked: '', seen: ['drums', 'chess'] })
    expect((await m.as.mutation(api.tour.clear, {})).requested.map((r) => r.slug)).toEqual(['tour-menu', 'tour-chess', 'tour-drums'])
  })

  test('a personal publication committed after tour inspection survives both finish and cleanup', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-reauthored')
    await make(m, 'checklist', '{"added":[],"note":""}')
    // The personal publish starts first, but commits after the tour checked the mark.
    const personal = await m.as.action(api.publish.begin, { slug: 'tour-checklist', title: 'A checklist', files: page })
    const tour = await start(m, 'checklist', '{"added":[],"note":""}')
    await finish(m, personal)
    await m.as.mutation(api.state.patch, { slug: 'tour-checklist', patch: '{"added":["Umbrella"],"note":"keep","extra":true}', replace: true })
    const before = await m.as.query(api.artifacts.get, { slug: 'tour-checklist' })
    const state = await m.as.query(api.state.get, { slug: 'tour-checklist' })
    await expect(finish(m, tour)).rejects.toThrow('Nothing was replaced')
    expect(await m.as.mutation(api.tour.clear, {})).toEqual({
      requested: [],
      kept: ['tour-checklist'],
      seen: 0,
    })
    expect(await m.as.query(api.artifacts.get, { slug: 'tour-checklist' })).toEqual({
      ...before,
      versions: before.versions.filter((v) => v.n !== tour.version),
    })
    expect(await m.as.query(api.state.get, { slug: 'tour-checklist' })).toEqual(state)
    expect(await t.run((ctx) => ctx.db.query('starts').collect())).toEqual([])
    expect((await t.run((ctx) => ctx.db.query('tallies').first()))?.stagingCount).toBe(0)
  })

  test('a newer state revision refuses a stale reset and commits neither its content nor menu progress', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-state-race')
    await make(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    const page = await make(m, 'chess', '{"reply":"","note":""}')
    const pending = await start(m, 'chess', '{"reply":"","note":""}')
    await m.as.mutation(api.state.patch, { slug: 'tour-chess', patch: '{"reply":"e7e5","note":"keep this answer"}' })
    const state = await m.as.query(api.state.get, { slug: 'tour-chess' })
    const menu = await m.as.query(api.state.get, { slug: 'tour-menu' })
    await expect(finish(m, pending)).rejects.toThrow('Nothing was replaced')
    expect((await m.as.query(api.artifacts.get, { slug: 'tour-chess' })).version).toBe(page.version)
    expect(await m.as.query(api.state.get, { slug: 'tour-chess' })).toEqual(state)
    expect(await m.as.query(api.state.get, { slug: 'tour-menu' })).toEqual(menu)
  })

  test.each(['menu', 'chess', 'done'])('a saved navigation attempt on %s survives a stale tour reset', async (name) => {
    const t = backend()
    const m = await machineOf(t, `tour-navigation-${name}`)
    const p = await person(t, `tour-navigation-${name}`)
    const showing = await make(m, name)
    const pending = await start(m, name)
    const attempt = { version: showing.version, attempt: 2, attempt_display: 'page-load-b' }
    await p.browser.mutation(api.state.storeSet, { artifactId: showing.artifactId, key: 'tour-navigation', value: JSON.stringify(attempt) })
    const state = await m.as.query(api.state.get, { slug: `tour-${name}` })
    await expect(finish(m, pending)).rejects.toThrow('Nothing was replaced')
    expect(await m.as.query(api.state.get, { slug: `tour-${name}` })).toEqual(state)
    expect(JSON.parse(state.json)[STORE_KEY]['tour-navigation']).toEqual(attempt)
    expect((await m.as.query(api.artifacts.get, { slug: `tour-${name}` })).version).toBe(showing.version)
    if (name === 'menu') {
      await make(m, 'drums')
      const progressed = JSON.parse((await m.as.query(api.state.get, { slug: 'tour-menu' })).json)
      expect(progressed[STORE_KEY]['tour-navigation']).toEqual(attempt)
      expect(progressed.seen).toEqual(['drums'])
    }
    // A fresh showing has its own version, so its counter may start again.
    const next = await make(m, name)
    expect(next.version).toBeGreaterThan(showing.version)
    expect(JSON.parse((await m.as.query(api.state.get, { slug: `tour-${name}` })).json)[STORE_KEY]).toBeUndefined()
  })

  test('progress added during a menu upload survives a stale menu reset', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-menu-progress-race')
    await make(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    const pending = await start(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    await make(m, 'chess', '{"reply":"","note":""}')
    const state = await m.as.query(api.state.get, { slug: 'tour-menu' })
    await expect(finish(m, pending)).rejects.toThrow('Nothing was replaced')
    expect(await m.as.query(api.state.get, { slug: 'tour-menu' })).toEqual(state)
    expect(await m.as.query(api.tour.seen, {})).toEqual({ seen: ['chess'] })
  })

  test('clearing every marked page preserves an identified tour waiter and personal pages', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-clear-all')
    await m.as.mutation(api.tour.wait, { waitId: 'waiting-command', first: true })
    const waiting = await m.as.query(api.tour.get, {})
    for (const name of ['menu', 'whiteboard', 'chess', 'checklist', 'drums', 'button', 'done']) await make(m, name)
    await publish(m, 'tour-of-my-project')
    expect(await m.as.mutation(api.tour.clear, {})).toEqual({
      requested: ['tour-menu', 'tour-whiteboard', 'tour-chess', 'tour-checklist', 'tour-drums', 'tour-button', 'tour-done'].map((slug) => ({
        slug,
        job: expect.any(String),
      })),
      kept: [],
      seen: 5,
    })
    expect((await m.as.query(api.artifacts.list, {})).map((p) => p.slug)).toEqual(['tour-of-my-project'])
    expect((await m.as.query(api.tour.get, {})).waitingUntil).toBe(waiting.waitingUntil)
    expect(await m.as.mutation(api.tour.wait, { waitId: 'waiting-command' })).toEqual({ asked: false })
    expect((await m.as.query(api.tour.get, {})).doneAt).not.toBeNull()
  })

  test('a menu replaced during a step upload keeps all its personal state and supplies no progress', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-menu-race')
    await make(m, 'menu', '{"status":"open","picked":"","seen":[]}')
    const pending = await start(m, 'chess', '{"reply":"","note":""}')
    await publish(m, 'tour-menu', { title: 'The It tour' })
    await m.as.mutation(api.state.patch, { slug: 'tour-menu', patch: '{"status":"open","picked":"","seen":["Kyoto","Lima"]}', replace: true })
    const state = await m.as.query(api.state.get, { slug: 'tour-menu' })
    await finish(m, pending)
    expect(await m.as.query(api.state.get, { slug: 'tour-menu' })).toEqual(state)
    expect(await m.as.query(api.tour.seen, {})).toEqual({ seen: [] })
    expect(await m.as.mutation(api.tour.clear, {})).toEqual({
      requested: ['tour-chess'].map((slug) => ({ slug, job: expect.any(String) })),
      kept: ['tour-menu'],
      seen: 0,
    })
  })

  test.each(['take', 'shared take', 'shared transfer', 'rollback'] as const)('%s revokes tour ownership and a pending tour cannot restore it', async (how) => {
    const t = backend()
    const m = await machineOf(t, `tour-${how}`)
    const mine = { harness: 'pi', id: 'conversation-1' }
    await publish(m, 'tour-chess', { tour: 'chess', state: '{"reply":"","note":""}', session: mine })
    const pending = await start(m, 'chess')
    if (how === 'take') expect(await m.as.mutation(api.artifacts.take, { slug: 'tour-chess', session: mine })).toEqual({ took: false })
    else if (how === 'rollback') await m.as.mutation(api.artifacts.rollback, { slug: 'tour-chess', version: 1 })
    else
      expect(
        await t.run(async (ctx) => takePage(ctx, (await ctx.db.get(pending.artifactId))!, (await ctx.db.get(m.id))!, how === 'shared take' ? mine : SESSION)),
      ).toEqual({ took: how === 'shared transfer' })
    await expect(finish(m, pending)).rejects.toThrow('Nothing was replaced')
    expect((await m.as.mutation(api.tour.clear, {})).kept).toEqual(['tour-chess'])
    await expect(start(m, 'chess')).rejects.toThrow('tour does not own')
  })

  test('reusing an id after deletion never gives the replacement an old tour mark', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-reused')
    const pending = await start(m, 'chess')
    await m.as.mutation(api.artifacts.remove, { slug: 'tour-chess' })
    await publish(m, 'tour-chess', { title: 'A chessboard', state: '{"reply":"","note":""}' })
    const before = await m.as.query(api.artifacts.get, { slug: 'tour-chess' })
    await expect(finish(m, pending)).rejects.toThrow('No such page')
    expect((await m.as.mutation(api.tour.clear, {})).kept).toEqual(['tour-chess'])
    expect(await m.as.query(api.artifacts.get, { slug: 'tour-chess' })).toEqual(before)
  })

  test('tour ownership rejects unknown names and callers without machine authority', async () => {
    const t = backend()
    const m = await machineOf(t, 'tour-authority')
    const p = await person(t, 'tour-authority')
    await expect(start(m, 'personal')).rejects.toThrow('known tour page')
    await expect(m.as.action(api.publish.begin, { slug: 'personal', title: 'Page', files: page, tour: 'menu', state: '{}' })).rejects.toThrow('known tour page')
    await expect(p.browser.mutation(api.tour.clear, {})).rejects.toThrow('Only an enrolled machine')
    await expect(p.browser.query(api.tour.seen, {})).rejects.toThrow('Only an enrolled machine')
  })
})

describe('state', () => {
  test('a patch merges, null deletes, replace replaces, and a stale base is refused', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    const patch = (value: unknown, extra: Record<string, unknown> = {}) =>
      m.as.mutation(api.state.patch, { slug: 'plan', patch: JSON.stringify(value), ...extra })
    await patch({ a: 1, nested: { x: 1, y: 2 } })
    expect((await patch({ nested: { y: null, z: 3 } })).revision).toBe(2)
    expect(await stateOf(alice.browser, 'plan')).toEqual({ a: 1, nested: { x: 1, z: 3 } })
    expect(await code(patch({ a: 2 }, { baseRevision: 1 }))).toBe('conflict')
    await patch({ only: true }, { replace: true, baseRevision: 2 })
    expect(await stateOf(alice.browser, 'plan')).toEqual({ only: true })
    expect(await code(patch({ big: 'x'.repeat(LIMITS.stateBytes) }))).toBe('limit')
    expect(await code(patch([1, 2], { replace: true }))).toBe('invalid')
    expect(await code(m.as.mutation(api.state.patch, { slug: 'plan', patch: 'not json' }))).toBe('invalid')
  })

  test('state may use any keys a page likes: other alphabets, a leading dollar or underscore', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: '{"進捗":1}' })
    await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"$ref":{"_id":"x"},"":"empty key","__proto__":{"polluted":true}}' })
    expect(await stateOf(alice.browser, 'plan')).toEqual({ 進捗: 1, $ref: { _id: 'x' }, '': 'empty key' })
    await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001', { payload: '{"名前":"值","$set":1}' }),
    })
    expect((await m.as.query(api.delivery.waiting, { slug: 'plan' }))[0]!.payload).toBe('{"名前":"值","$set":1}')
  })

  test('what was sent to the bell about a page goes from the bell when the page is removed, and what was sent about another stays', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'tour-whiteboard')
    await publish(m, 'plan')
    const key = displayKey('alice')
    const about = await m.as.mutation(api.notifications.send, {
      text: 'Drew on yours. Next when you have had a look.',
      slug: 'tour-whiteboard',
      buttons: [{ label: 'Next', action: 'next' }],
    })
    const other = await m.as.mutation(api.notifications.send, { text: 'Deploy?', slug: 'plan' })
    const none = await m.as.mutation(api.notifications.send, { text: 'Done.' })
    const shown = async () => (await alice.browser.query(api.notifications.list, { key })).map((n) => n.id).sort()
    expect(await shown()).toEqual([about.id, other.id, none.id].sort())
    await m.as.mutation(api.artifacts.remove, { slug: 'tour-whiteboard' })
    expect(await shown()).toEqual([other.id, none.id].sort())
  })

  test('and so it does however much has been sent to the bell since', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    await publish(m, 'other')
    const key = displayKey('alice')
    const about = await m.as.mutation(api.notifications.send, { text: 'Deploy?', slug: 'plan', buttons: [{ label: 'Approve', action: 'approve' }] })
    const kept = await m.as.mutation(api.notifications.send, { text: 'Read this.', slug: 'other', buttons: [{ label: 'Read', action: 'read' }] })
    // Three hundred more since, each of them put away by now
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 1; i <= 300; i++)
        await ctx.db.insert('notifications', { userId: alice.user as never, text: `Note ${i}`, sticky: false, createdAt: now + i, dismissedAt: now + i })
    })
    const shown = async () => (await alice.browser.query(api.notifications.list, { key })).map((n) => n.id).sort()
    expect(await shown()).toEqual([about.id, kept.id].sort())
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    // Left there, it would offer a button that can only answer that the page is gone
    expect(await shown()).toEqual([kept.id])
    expect(await code(alice.browser.mutation(api.notifications.answer, { id: about.id, action: 'approve', displayKey: key }))).toBe('not_found')
  })

  test('when the page’s agent last changed the page is said, and what the page stores for itself does not count as that', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: '{"count":0}' })
    const answered = async () => (await alice.browser.query(api.artifacts.get, { slug: 'plan' })).answeredAt
    const published = await answered()
    expect(published).toBeGreaterThan(0)
    // The page keeping something for itself is not its agent answering
    vi.setSystemTime(Date.now() + 5000)
    await alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'draft', value: '"kept"' })
    expect(await answered()).toBe(published)
    // The agent writing the state is
    vi.setSystemTime(Date.now() + 5000)
    await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"count":1}' })
    expect(await answered()).toBe(Date.now())
    // And so is its publishing the page again
    vi.setSystemTime(Date.now() + 5000)
    await publish(m, 'plan')
    expect(await answered()).toBe(Date.now())
  })

  test('a page asked for without its history, as a screen that shows it asks, is told how its state stands without the state or any version’s list of files being read', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan', { state: '{"count":0}' })
    await publish(m, 'plan')
    vi.setSystemTime(Date.now() + 5000)
    await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"count":1}' })
    const changed = Date.now()
    vi.setSystemTime(Date.now() + 5000)
    // The page keeps something for itself afterwards, which is no answer of its agent's
    const p = await alice.browser.query(api.artifacts.get, { slug: 'plan' })
    await alice.browser.mutation(api.state.storeSet, { artifactId: p.id, key: 'draft', value: '"kept"' })
    const asked = (args: Record<string, unknown>) =>
      t.run(async (ctx) => {
        const { db, read } = watched(ctx.db)
        const identity = { issuer: SITE, subject: alice.user, kind: 'browser', sid: alice.session }
        const got = await (pageQuery as any)._handler({ ...ctx, db, auth: { getUserIdentity: async () => identity } }, args)
        return { got, states: read.filter((row) => typeof row.json === 'string').length, lists: read.filter((row) => Array.isArray(row.files)).length }
      })
    const light = await asked({ slug: 'plan', history: false })
    expect([light.states, light.lists]).toEqual([0, 0])
    expect(light.got).toMatchObject({ version: 2, stateRevision: 3, answeredAt: changed, versions: [] })
    // Asked for whole, as `it read` asks, it comes with its versions, and says the same of its state
    const whole = await asked({ slug: 'plan' })
    expect(whole.got.versions.map((x: { n: number }) => x.n)).toEqual([2, 1])
    expect(whole.got).toMatchObject({ stateRevision: 3, answeredAt: changed })
    expect(whole.states).toBe(0)
    // A page whose state was last written before that time was kept beside its revision has it read from the state, until it is written again
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query('revisions').collect()) await ctx.db.replace(r._id, { artifactId: r.artifactId, revision: r.revision })
    })
    const older = await asked({ slug: 'plan', history: false })
    expect(older.got).toMatchObject({ stateRevision: 3, answeredAt: changed })
    expect(older.states).toBe(1)
    await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"count":2}' })
    const again = await asked({ slug: 'plan', history: false })
    expect(again.got).toMatchObject({ stateRevision: 4, answeredAt: Date.now() })
    expect(again.states).toBe(0)
  })

  test('a page can only write under its own key, and what it stores under a name replaces what was there', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: '{"status":"draft"}' })
    const store = (key: string, value: unknown) => alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key, value: JSON.stringify(value) })
    await store('draft', { text: 'hello', extra: 1 })
    await store('draft', { text: 'again' })
    await store('status', 'hijacked')
    const json = await stateOf(alice.browser, 'plan')
    expect(json.status).toBe('draft')
    expect(json[STORE_KEY]).toEqual({ draft: { text: 'again' }, status: 'hijacked' })
    await store('draft', null)
    expect((await stateOf(alice.browser, 'plan'))[STORE_KEY]).toEqual({ status: 'hijacked' })
    for (const key of ['__proto__ x', 'a.b', '', 'x'.repeat(65), '__proto__', 'constructor', 'prototype']) expect(await code(store(key, 1))).toBe('invalid')
    expect(await code(alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value: 'not json' }))).toBe('invalid')
  })

  test('a publish whose starting state, with what the page stored for itself, would be over the limit is refused whole', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    // Published with no state, and the page then keeps a draft of its own
    const p = await publish(m, 'plan')
    await alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'draft', value: JSON.stringify('d'.repeat(32_000)) })
    // A starting state that is within the limit by itself, and not together with the draft
    const start = JSON.stringify({ text: 'x'.repeat(LIMITS.stateBytes - 2_000) })
    expect(new TextEncoder().encode(start).length).toBeLessThanOrEqual(LIMITS.stateBytes)
    const begun = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Title of plan', files: page, state: start })
    expect(await code(m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version }))).toBe('limit')
    dropWhatAFailedCallScheduled()
    // Nothing of it was kept: the page is as it was, and can still be changed
    const now = await stateOf(alice.browser, 'plan')
    expect(Object.keys(now)).toEqual([STORE_KEY])
    expect(new TextEncoder().encode(JSON.stringify(now)).length).toBeLessThan(LIMITS.stateBytes)
    expect(await code(m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"status":"fine"}' }))).toBe('ok')
    expect((await m.as.query(api.artifacts.get, { slug: 'plan' })).version).toBe(1)
  })
})

describe('clicks and their delivery', () => {
  async function setup() {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    // These delivery fixtures have connected apps whose reopening has not been switched on.
    await t.run((ctx) =>
      ctx.db.patch(m.id, { wanted: ['claude-code', 'codex'], harnesses: ['claude-code', 'codex'].map((id) => ({ id, addon: 'connected' })) }),
    )
    const p = await publish(m, 'plan', { session: SESSION })
    const click = (id: string, over = {}) =>
      alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope(id, over) })
    const counts = async () =>
      t.run(async (ctx) => [
        (await ctx.db.query('artifacts').collect()).find((a) => a.slug === 'plan')?.waiting ?? 0,
        (await ctx.db.query('tallies').collect())[0]?.waiting ?? 0,
      ])
    return { t, alice, m, p, click, counts }
  }

  test('the same click sent twice is one click, and a page cannot shadow another page’s click by reusing its id', async () => {
    const { alice, m, click } = await setup()
    const a = await click('click-0001')
    const b = await click('click-0001')
    expect(b.actionId).toBe(a.actionId)
    expect((await inbox(m)).length).toBe(1)
    const other = await publish(m, 'other', { session: SESSION })
    const c = await alice.browser.mutation(api.actions.submit, {
      artifactId: other.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    expect(c.actionId).not.toBe(a.actionId)
    expect((await inbox(m)).map((x) => x.artifact).sort()).toEqual(['other', 'plan'])
  })

  test('a click that is too big, misnamed, not JSON or in another protocol is refused', async () => {
    const { click } = await setup()
    expect(await code(click('click-0001', { payload: JSON.stringify('x'.repeat(LIMITS.actionPayloadBytes)) }))).toBe('limit')
    expect(await code(click('click-0002', { name: 'has spaces' }))).toBe('invalid')
    expect(await code(click('short'))).toBe('invalid')
    expect(await code(click('click-0003', { v: 2 }))).toBe('invalid')
    expect(await code(click('click-0004', { payload: '{not json' }))).toBe('invalid')
  })

  test('a click moves from waiting, to leased, to handed off, to done, and is counted as waiting only until it is handed off', async () => {
    const { alice, m, p, click, counts } = await setup()
    const { actionId } = await click('click-0001', { attended: true })
    expect(await counts()).toEqual([1, 1])
    const [offered] = await inbox(m)
    expect(offered).toMatchObject({ id: actionId, artifact: 'plan', name: 'approve', payload: '{"n":1}', attended: true, session: SESSION })
    expect(await m.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([actionId])
    expect(await inbox(m)).toEqual([])
    expect(await code(m.as.mutation(api.delivery.settle, { id: actionId, outcome: 'succeeded' }))).toBe('conflict')
    expect(await counts()).toEqual([1, 1])
    // The first report is the hand-over, and says so with what a machine needs to count it once:
    // when the click was made and for which harness. A second report of it says it is not new.
    const first = await m.as.mutation(api.delivery.handedOff, { id: actionId, route: 'addon' })
    expect(first).toEqual({ already: false, at: expect.any(Number), harness: SESSION.harness })
    expect(Date.now() - first.at).toBeLessThan(60_000)
    expect(await m.as.mutation(api.delivery.handedOff, { id: actionId, route: 'addon' })).toEqual({ ...first, already: true })
    expect(await counts()).toEqual([0, 0])
    await m.as.mutation(api.delivery.settle, { id: actionId, outcome: 'succeeded' })
    const [seen] = await alice.browser.query(api.actions.forArtifact, { artifactId: p.artifactId })
    expect(seen).toMatchObject({ delivery: 'handed_off', route: 'addon', outcome: 'succeeded' })
    expect(seen).not.toHaveProperty('payload')
    expect((await m.as.query(api.actions.forArtifact, { slug: 'plan' }))[0]).toHaveProperty('payload')
    // An agent told only the action's id can read it, whatever has become of it
    expect(await m.as.query(api.delivery.get, { id: actionId })).toMatchObject({ artifact: 'plan', payload: '{"n":1}', delivery: 'handed_off' })
  })

  test('an agent is told when a page sent an action and the site had seen no sign of anyone using it', async () => {
    const { m, click } = await setup()
    await click('click-0001', { attended: false })
    const [c] = await inbox(m)
    const text = describeClick({ ...c!, payload: JSON.parse(c!.payload), attended: c!.attended ?? undefined })
    expect(text).toBe(`[It] The page "Title of plan" (plan) sent this with no sign that anyone had just used it: approve {"n":1} [action ${c!.id}]`)
    expect(describeClick({ ...c!, payload: { n: 1 }, attended: true })).toBe(
      `[It] The page "Title of plan" (plan) sent this just after someone used it: approve {"n":1} [action ${c!.id}]`,
    )
    expect(describeClick({ ...c!, payload: { text: 'x'.repeat(5000) }, attended: true })).toContain(`run \`it action ${c!.id}\` to read all of it`)
  })

  test('a click whose connector died goes back in the queue, still addressed to the machine that owns the page', async () => {
    const { t, m, click } = await setup()
    const other = await machineOf(t, 'alice', 'server')
    const { actionId } = await click('click-0001')
    // Another of the person's machines borrows it (an agent there ran `it wait`) and then dies
    expect(await other.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([actionId])
    expect(await m.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([])
    expect(await code(m.as.mutation(api.delivery.handedOff, { id: actionId, route: 'addon' }))).toBe('conflict')
    await vi.advanceTimersByTimeAsync(LEASE_MS + 1000)
    expect(await t.mutation(internal.delivery.reap, {})).toBe(1)
    // The owner's connector sees it again, and the borrower's does not
    expect((await inbox(m)).map((c) => c.id)).toEqual([actionId])
    expect(await inbox(other)).toEqual([])
    expect((await other.as.query(api.delivery.waiting, { slug: 'plan' })).length).toBe(1)
    expect(await m.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([actionId])
  })

  test('a connector that starts is given back what its machine still holds, at once and in the order it was made, and nothing another machine holds', async () => {
    const { t, m, click } = await setup()
    const other = await machineOf(t, 'alice', 'server')
    const first = (await click('click-0001')).actionId
    const second = (await click('click-0002')).actionId
    const borrowed = (await click('click-0003')).actionId
    // The connector claimed the first and ended before it had handed it over. Another machine holds one of its own
    expect(await m.as.mutation(api.delivery.claim, { ids: [first] })).toEqual([first])
    expect(await other.as.mutation(api.delivery.claim, { ids: [borrowed] })).toEqual([borrowed])
    // Until the lease runs out, the one made after it is all that is offered
    expect((await inbox(m)).map((c) => c.id)).toEqual([second])
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [first], done: true })
    expect((await inbox(m)).map((c) => c.id)).toEqual([first, second])
    // The other machine's is still its own, and a second asking gives back nothing more
    expect(await m.as.mutation(api.delivery.claim, { ids: [borrowed] })).toEqual([])
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [], done: true })
    // It is a machine's to ask, and nobody else's
    const browser = t.withIdentity({ issuer: 'x', subject: 'nobody', kind: 'browser' })
    expect(await code(browser.mutation(api.delivery.giveBackBatch, {}))).not.toBe('ok')
  })

  test('recovery reads returned clicks directly and resolves stopped, deleted and reassigned actions', async () => {
    const { t, m, click } = await setup()
    const other = await machineOf(t, 'alice', 'other')
    const first = (await click('recover-first')).actionId
    const gone = (await click('recover-gone')).actionId
    const moved = (await click('recover-moved')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [first, gone, moved] })
    const batch = await m.as.mutation(api.delivery.giveBackBatch, {})
    expect(batch.routes).toHaveLength(3)
    await t.run(async (ctx) => {
      await ctx.db.delete(gone)
      const row = (await ctx.db.get(moved))!
      await ctx.db.patch(row.artifactId, { machineId: other.id })
    })
    // All actions share this page, so its reassignment resolves every remaining hold.
    expect(await m.as.query(api.delivery.recover, { ids: [first, gone, moved] })).toEqual([
      { id: first, click: null },
      { id: gone, click: null },
      { id: moved, click: null },
    ])
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(first))!
      await ctx.db.patch(row.artifactId, { machineId: m.id })
    })
    expect((await m.as.query(api.delivery.recover, { ids: [first] }))[0]?.click?.id).toBe(first)
    await m.as.mutation(api.delivery.claim, { ids: [first] })
    await m.as.mutation(api.delivery.handedOff, { id: first, route: 'queue' })
    expect(await m.as.query(api.delivery.recover, { ids: [first] })).toEqual([{ id: first, click: null }])
    const stranger = await machineOf(t, 'bob', 'stranger')
    expect(await stranger.as.query(api.delivery.recover, { ids: [moved] })).toEqual([{ id: moved, click: null }])
    expect(await m.as.query(api.delivery.recover, { ids: Array(40).fill('invalid') })).toHaveLength(32)
  })

  test('more than four thousand leases held by another machine cannot hide this machine’s lease when it starts', async () => {
    const { t, m, click } = await setup()
    const other = await machineOf(t, 'alice', 'server')
    const first = (await click('click-0001')).actionId
    expect(await m.as.mutation(api.delivery.claim, { ids: [first] })).toEqual([first])
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...base } = (await ctx.db.get(first))!
      for (let i = 0; i < 4001; i++)
        await ctx.db.insert('actions', { ...base, clientActionId: `foreign-${i}`, leaseMachineId: other.id, leaseExpiresAt: Date.now() })
    })
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [first], done: true })
    expect((await inbox(m)).map((c) => c.id)).toEqual([first])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('actions')
          .filter((q) => q.eq(q.field('delivery'), 'leased'))
          .collect(),
      ),
    ).toHaveLength(4001)
  })

  test('recovery visits more than five hundred maximum-size leases in bounded batches, oldest first', async () => {
    const { t, m, click } = await setup()
    const first = (await click('click-0001')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [first] })
    const ids = await t.run(async (ctx) => {
      const { _id, _creationTime, ...base } = (await ctx.db.get(first))!
      const payload = JSON.stringify('x'.repeat(LIMITS.actionPayloadBytes - 2))
      const createdAt = Date.now() - 10_000
      await ctx.db.patch(first, { payload, createdAt })
      const ids = [first]
      for (let i = 1; i < 513; i++)
        ids.push(
          await ctx.db.insert('actions', {
            ...base,
            clientActionId: `recover-${i}`,
            payload,
            createdAt: createdAt + i,
            // Lease expiry is unrelated to when the person acted.
            leaseExpiresAt: Date.now() + 1000 - i,
          }),
        )
      return ids
    })
    const back = []
    for (let i = 0; i < 9; i++) {
      const batch = await m.as.mutation(api.delivery.giveBackBatch, {})
      expect(batch.back.length).toBeLessThanOrEqual(64)
      expect(batch.done).toBe(i === 8)
      back.push(...batch.back)
    }
    expect(back).toEqual(ids)
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [], done: true })
    const browser = t.withIdentity({ issuer: 'x', subject: 'nobody', kind: 'browser' })
    expect(await code(browser.mutation(api.delivery.giveBackBatch, {}))).not.toBe('ok')
  })

  test('a full recovery batch of stopped clicks does not hide a later lease or revive a stopped click', async () => {
    const { t, m, click } = await setup()
    const first = (await click('click-0001')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [first] })
    const later = await t.run(async (ctx) => {
      const { _id, _creationTime, ...base } = (await ctx.db.get(first))!
      await ctx.db.patch(base.artifactId, { stoppedThrough: Date.now() })
      for (let i = 1; i < 64; i++) await ctx.db.insert('actions', { ...base, clientActionId: `stopped-${i}` })
      return ctx.db.insert('actions', { ...base, clientActionId: 'after-stop', createdAt: Date.now() + 1 })
    })
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [], done: false })
    expect(await t.run((ctx) => ctx.db.get(first))).toMatchObject({ delivery: 'handed_off', route: 'stopped' })
    expect(await m.as.mutation(api.delivery.giveBackBatch, {})).toMatchObject({ back: [later], done: true })
  })

  test('a connector keeps a click it is still delivering by renewing, and cannot renew what it has lost', async () => {
    const { t, m: laptop, click } = await setup()
    const { actionId: id } = await click('click-0001')
    const server = await machineOf(t, 'alice', 'server')
    await laptop.as.mutation(api.delivery.claim, { ids: [id] })
    vi.advanceTimersByTime(LEASE_MS - 5_000)
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [id] })).toEqual([id])
    expect(await server.as.mutation(api.delivery.renew, { ids: [id] })).toEqual([])
    // Renewed, so the original expiry passing changes nothing
    vi.advanceTimersByTime(10_000)
    expect(await server.as.mutation(api.delivery.claim, { ids: [id] })).toEqual([])
    // Not renewed again: the lease runs out, another machine takes it, and the first cannot take it back by renewing
    vi.advanceTimersByTime(LEASE_MS)
    expect(await server.as.mutation(api.delivery.claim, { ids: [id] })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [id] })).toEqual([])
  })

  test('a released click is waiting again', async () => {
    const { m, click } = await setup()
    const { actionId } = await click('click-0001')
    await m.as.mutation(api.delivery.claim, { ids: [actionId] })
    await m.as.mutation(api.delivery.release, { id: actionId })
    expect((await inbox(m)).length).toBe(1)
  })

  test('clicks nobody can take never hide a click that somebody can', async () => {
    const { t, alice, m } = await setup()
    // A page whose conversation is closed, pressed many times
    const dead = await publish(m, 'dead', { session: { harness: 'claude-code', id: 'gone' } })
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(dead.artifactId))!
      for (let i = 0; i < 80; i++)
        await ctx.db.insert('actions', {
          userId: a.userId,
          title: a.title,
          artifactId: a._id,
          clientActionId: `dead-${String(i).padStart(4, '0')}`,
          name: 'press',
          payload: '{}',
          contentVersion: 1,
          createdAt: i,
          delivery: 'pending',
          machineId: a.machineId,
          harness: 'claude-code',
          sessionId: 'gone',
        })
    })
    const live = await publish(m, 'live', { session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: live.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-live'),
    })
    expect((await inbox(m)).map((c) => c.id)).toEqual([actionId])
    // A harness with a queue of its own is offered its clicks whether or not a conversation is listening
    const queued = await publish(m, 'queued', { session: { harness: 'codex', id: 'thread-1' } })
    await alice.browser.mutation(api.actions.submit, { artifactId: queued.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-queued') })
    expect((await inbox(m, [SESSION], ['codex'])).map((c) => c.artifact).sort()).toEqual(['live', 'queued'])
  })

  test('a click its machine cannot deliver is set aside, so it does not stand in the way of ones it can', async () => {
    const { t, alice, m } = await setup()
    const dead = await publish(m, 'dead', { session: { harness: 'codex', id: 'deleted-thread' } })
    const live = await publish(m, 'live', { session: { harness: 'codex', id: 'thread-1' } })
    const stuck: string[] = []
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(dead.artifactId))!
      for (let i = 0; i < 25; i++)
        stuck.push(
          await ctx.db.insert('actions', {
            userId: a.userId,
            title: a.title,
            artifactId: a._id,
            clientActionId: `dead-${String(i).padStart(4, '0')}`,
            name: 'press',
            payload: '{}',
            contentVersion: 1,
            createdAt: Date.now() + i,
            delivery: 'pending',
            machineId: a.machineId,
            harness: 'codex',
            sessionId: 'deleted-thread',
          }),
        )
    })
    await vi.advanceTimersByTimeAsync(1000)
    const behind = await alice.browser.mutation(api.actions.submit, {
      artifactId: live.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-live'),
    })
    // A conversation that takes nothing is offered its oldest few, and stands in nobody's way
    const offered = await inbox(m, [], ['codex'])
    expect(offered.map((c) => c.id).sort()).toEqual([...stuck.slice(0, 2), behind.actionId].sort())
    for (const id of stuck) expect(await m.as.mutation(api.delivery.park, { id: id as never })).toBe(true)
    expect((await inbox(m, [], ['codex'])).map((c) => c.id)).toEqual([behind.actionId])
    // Set aside, not lost: still waiting, still listed
    expect((await m.as.query(api.delivery.waiting, { slug: 'dead' })).length).toBe(25)
    // The conversation is heard from again (its app is open, its folder is back): what this machine
    // set aside for it is its to deliver again, the oldest first, and nothing of another conversation's is touched
    expect(await m.as.mutation(api.delivery.unpark, { for: { harness: 'codex', id: 'some-other-thread' } })).toBe(0)
    expect((await inbox(m, [], ['codex'])).map((c) => c.id)).toEqual([behind.actionId])
    expect(await m.as.mutation(api.delivery.unpark, { for: { harness: 'codex', id: 'deleted-thread' } })).toBe(25)
    expect((await inbox(m, [], ['codex'])).map((c) => c.id).sort()).toEqual([...stuck.slice(0, 2), behind.actionId].sort())
    // Asked again, there is nothing left to give back
    expect(await m.as.mutation(api.delivery.unpark, { for: { harness: 'codex', id: 'deleted-thread' } })).toBe(0)
  })

  test('a closed conversation’s clicks are offered for reopening only where the owner switched it on, and what had waited longer than a day by then never hides what was done since', async () => {
    const { alice, m, click } = await setup()
    const DAY = 24 * 60 * 60_000
    const offered = async () => (await inbox(m, [], ['claude-code'])).map((c) => c.id)
    // Three clicks long ago, and one a few hours before the switch is turned
    const stale: string[] = []
    for (const id of ['click-old-0001', 'click-old-0002', 'click-old-0003']) stale.push((await click(id)).actionId)
    await vi.advanceTimersByTimeAsync(3 * DAY)
    const recent = (await click('click-recent-0001')).actionId
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    // Off, nothing of a closed conversation is offered, whatever the connector asks for
    expect(await offered()).toEqual([])
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    // On, the one from the day before is, and the three that are older stand in front of nothing
    expect(await offered()).toEqual([recent])
    await vi.advanceTimersByTimeAsync(60_000)
    const first = (await click('click-new-0001')).actionId
    const second = (await click('click-new-0002')).actionId
    // All of what may be reopened for, in the order it was done: one reopening carries it all
    expect(await offered()).toEqual([recent, first, second])
    await m.as.mutation(api.delivery.claim, { ids: [recent as never], for: SESSION })
    await m.as.mutation(api.delivery.handedOff, { id: recent as never, route: 'queue' })
    expect(await offered()).toEqual([first, second])
    // The older ones are still waiting, and a conversation that is open and listening is offered them as before
    expect((await inbox(m)).map((c) => c.id)).toEqual(stale.slice(0, 2))
    // Switched off, nothing is offered for reopening again
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: false })
    expect(await offered()).toEqual([])
  })

  test('one reopening is offered all that waits for a conversation, up to a few, and Codex’s queue is offered its two whatever is switched on', async () => {
    const { alice, m, click } = await setup()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    const made: string[] = []
    for (let i = 0; i < 11; i++) made.push((await click(`click-many-${String(i).padStart(4, '0')}`)).actionId)
    expect((await inbox(m, [], ['claude-code'])).map((c) => c.id)).toEqual(made.slice(0, 8))
    // Codex's clicks go to its own queue, switched on or not, the oldest two of a conversation at a time
    const codex = await publish(m, 'sketch', { session: { harness: 'codex', id: 'thr-1' } })
    const queued: string[] = []
    for (let i = 0; i < 4; i++)
      queued.push(
        (
          await alice.browser.mutation(api.actions.submit, {
            artifactId: codex.artifactId,
            displayKey: displayKey('alice'),
            envelope: envelope(`click-codex-${String(i).padStart(4, '0')}`),
          })
        ).actionId,
      )
    expect((await inbox(m, [], ['codex'])).map((c) => c.id)).toEqual(queued.slice(0, 2))
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'codex', on: true })
    expect((await inbox(m, [], ['codex'])).map((c) => c.id)).toEqual(queued.slice(0, 2))
  })

  test('a click that another machine handed over is lost to a machine that was at work on it, and one that its own agent said was done is not', async () => {
    const { t, m, click } = await setup()
    const other = await machineOf(t, 'alice', 'desktop')
    const first = (await click('click-0001')).actionId
    const second = (await click('click-0002')).actionId
    expect(await m.as.mutation(api.delivery.claim, { ids: [first, second], for: SESSION })).toEqual([first, second])
    expect(await m.as.query(api.delivery.lost, { ids: [first, second] })).toEqual([])
    // Its own agent says the first is done, as `it ack` does: held no more, and not lost
    await m.as.mutation(api.delivery.handedOff, { id: first, route: 'cli' })
    expect(await m.as.mutation(api.delivery.renew, { ids: [first, second] })).toEqual([second])
    expect(await m.as.query(api.delivery.lost, { ids: [first] })).toEqual([])
    // The hold on the second runs out, and an agent waiting on another machine is given it
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await m.as.query(api.delivery.lost, { ids: [second] })).toEqual([second])
    expect(await other.as.mutation(api.delivery.claim, { ids: [second] })).toEqual([second])
    await other.as.mutation(api.delivery.handedOff, { id: second, route: 'waiter' })
    expect(await m.as.mutation(api.delivery.renew, { ids: [second] })).toEqual([])
    expect(await m.as.query(api.delivery.lost, { ids: [second] })).toEqual([second])
    // And the machine that handed it over has not lost it
    expect(await other.as.query(api.delivery.lost, { ids: [second] })).toEqual([])
  })

  test('a stop drops what waits for the conversation on the machine it was stopped on, and nothing of a conversation of the same name on another machine', async () => {
    const { t, alice, m, p, click } = await setup()
    const other = await machineOf(t, 'alice', 'desktop')
    const theirs = await publish(other, 'elsewhere', { session: SESSION })
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    const here = (await click('click-0001')).actionId
    const there = (
      await alice.browser.mutation(api.actions.submit, { artifactId: theirs.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0002') })
    ).actionId
    await vi.advanceTimersByTimeAsync(1000)
    await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })
    await settle(t)
    const became = async (id: string) => {
      const x = await t.run((ctx) => ctx.db.get(id as never) as Promise<{ delivery: string; route?: string } | null>)
      return [x?.delivery, x?.route]
    }
    expect(await became(here)).toEqual(['handed_off', 'stopped'])
    expect(await became(there)).toEqual(['pending', undefined])
    expect(await other.as.mutation(api.delivery.claim, { ids: [there], for: SESSION })).toEqual([there])
  })

  test('a stop drops what waits on every page of the conversation, also a click that is addressed to nobody, and it stays dropped when its page is taken by another conversation', async () => {
    const { t, alice, m, p, click } = await setup()
    const second = await publish(m, 'second', { session: SESSION })
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    const here = (await click('click-0001')).actionId
    const there = (
      await alice.browser.mutation(api.actions.submit, { artifactId: second.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0002') })
    ).actionId
    // Each is addressed to nobody, as a click is while its page changes hands
    await t.run(async (ctx) => {
      for (const x of await ctx.db.query('actions').collect()) await ctx.db.patch(x._id, { machineId: undefined })
    })
    await vi.advanceTimersByTimeAsync(1000)
    // Stopped from the first page
    const stopped = Date.now()
    await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })
    // Before any later step has run, the other page already keeps the moment: taken by another conversation now, its click goes to nobody
    const other = { harness: 'claude-code', id: 'sess-2' }
    expect(await m.as.mutation(api.artifacts.take, { slug: 'second', session: other, agent: 'claude-code' })).toEqual({ took: true })
    expect(await m.as.mutation(api.delivery.claim, { ids: [there as never], for: other })).toEqual([])
    await settle(t)
    const became = async (id: string) => {
      const x = await t.run((ctx) => ctx.db.get(id as never) as Promise<{ delivery: string; route?: string } | null>)
      return [x?.delivery, x?.route]
    }
    expect(await became(here)).toEqual(['handed_off', 'stopped'])
    expect(await became(there)).toEqual(['handed_off', 'stopped'])
    expect((await alice.browser.query(api.artifacts.list, {})).map((x) => x.pending)).toEqual([0, 0])
    // The page that changed conversation still says when it was stopped, so that what was dropped there is said to have been stopped
    expect((await alice.browser.query(api.artifacts.get, { slug: 'second' }))?.stoppedAt).toBe(stopped)
    // What is done on it after the stop is its new conversation's
    await vi.advanceTimersByTimeAsync(1000)
    const next = (
      await alice.browser.mutation(api.actions.submit, { artifactId: second.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0003') })
    ).actionId
    expect(await m.as.mutation(api.delivery.claim, { ids: [next as never], for: other })).toEqual([next])
  })

  test('everything a machine had set aside for a conversation comes back when the conversation does, however much that is, and is let go of when the machine is revoked', async () => {
    const { t, alice, m, p } = await setup()
    const made = Date.now()
    const aside = () =>
      t.run(async (ctx) => (await ctx.db.query('actions').collect()).filter((x) => x.delivery === 'pending' && x.parkedBy !== undefined).length)
    const setAside = (n: number) =>
      t.run(async (ctx) => {
        const a = (await ctx.db.get(p.artifactId))!
        for (let i = 0; i < n; i++)
          await ctx.db.insert('actions', {
            userId: a.userId,
            title: a.title,
            artifactId: a._id,
            clientActionId: `aside-${made}-${String(i).padStart(4, '0')}-${Math.random().toString(36).slice(2)}`,
            name: 'press',
            payload: '{}',
            contentVersion: 1,
            createdAt: made + i,
            delivery: 'pending',
            parkedBy: m.id as never,
            harness: SESSION.harness,
            sessionId: SESSION.id,
          })
        await ctx.db.patch(a._id, { waiting: (a.waiting ?? 0) + n })
      })
    // More than one step brings back
    await setAside(61)
    expect(await m.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(50)
    await settle(t)
    expect(await aside()).toBe(0)
    expect((await inbox(m, [SESSION], [])).length).toBeGreaterThan(0)
    // Set aside again, and the machine is revoked: none of it stays tied to a machine that is gone
    await t.run(async (ctx) => {
      for (const x of await ctx.db.query('actions').collect()) await ctx.db.patch(x._id, { machineId: undefined, parkedBy: m.id as never })
    })
    expect(await aside()).toBe(61)
    await alice.browser.mutation(api.machines.revoke, { machineId: m.id })
    await settle(t)
    expect(await aside()).toBe(0)
  })

  test('a stop drops everything that was waiting for the conversation by then, however much that is, and nothing done on the page after it', async () => {
    const { t, alice, m, p } = await setup()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    // More waiting than one step drops: some that nobody has yet, and some a machine has in hand
    const made = Date.now()
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(p.artifactId))!
      for (let i = 0; i < 520; i++)
        await ctx.db.insert('actions', {
          userId: a.userId,
          title: a.title,
          artifactId: a._id,
          clientActionId: `waiting-${String(i).padStart(4, '0')}`,
          name: 'press',
          payload: '{}',
          contentVersion: 1,
          createdAt: made + i,
          delivery: i % 2 ? 'leased' : 'pending',
          ...(i % 2 ? { leaseMachineId: m.id as never, leaseExpiresAt: made + 600_000 } : {}),
          machineId: m.id as never,
          harness: SESSION.harness,
          sessionId: SESSION.id,
        })
      await ctx.db.patch(a._id, { waiting: 520 })
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
    // The stop has dropped its first step and no more yet. What the later steps have still to
    // come to is given to nobody meanwhile, by any way: asked for, it is not given, and one
    // that a machine had in hand and says it handed over counts as stopped all the same
    const yetToDrop = await t.run(async (ctx) => (await ctx.db.query('actions').collect()).filter((x) => x.route !== 'stopped'))
    // One step drops a hundred, of every way a click can be waiting taken together
    expect(yetToDrop.length).toBe(420)
    const waitingStill = yetToDrop.find((x) => x.delivery === 'pending')!
    const inHand = yetToDrop.find((x) => x.delivery === 'leased')!
    expect(await m.as.mutation(api.delivery.claim, { ids: [waitingStill._id], for: SESSION })).toEqual([])
    expect(await m.as.mutation(api.delivery.handedOff, { id: inHand._id, route: 'addon' })).toMatchObject({ already: true })
    expect((await t.run((ctx) => ctx.db.get(inHand._id)))?.route).toBe('stopped')
    // Nor where the page has been taken over by another conversation in between: what was done before the stop was
    // done for the conversation that was stopped, and is not the new one's to be given
    const other = { harness: SESSION.harness, id: 'another-conversation' }
    const carried = yetToDrop.find((x) => x.delivery === 'pending' && x._id !== waitingStill._id)!
    await t.run((ctx) => ctx.db.patch(p.artifactId, { session: other }))
    expect(await m.as.mutation(api.delivery.claim, { ids: [carried._id], for: other })).toEqual([])
    expect((await t.run((ctx) => ctx.db.get(carried._id)))?.route).toBe('stopped')
    await t.mutation(internal.actions.readdress, { artifactId: p.artifactId })
    expect((await t.run(async (ctx) => (await ctx.db.query('actions').collect()).filter((x) => x.sessionId === other.id))).length).toBe(0)
    await t.run((ctx) => ctx.db.patch(p.artifactId, { session: SESSION }))
    // The person does something more on the page, after stopping
    await vi.advanceTimersByTimeAsync(50)
    const after = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-after-stop'),
    })
    // That one is as good as any click: a machine may take it
    expect(await m.as.mutation(api.delivery.claim, { ids: [after.actionId], for: SESSION })).toEqual([after.actionId])
    await m.as.mutation(api.delivery.release, { id: after.actionId })
    await settle(t)
    const all = await t.run((ctx) => ctx.db.query('actions').collect())
    expect(all.filter((x) => x.route === 'stopped').length).toBe(520)
    expect(all.filter((x) => x.delivery === 'pending' || x.delivery === 'leased').map((x) => x._id)).toEqual([after.actionId])
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.waiting).toBe(1)
  })

  test('a stop takes a hundred of what is waiting in its own step, however it is waiting and on however many pages, and the rest in steps that follow', async () => {
    const { t, alice, m, p } = await setup()
    // Two earlier pages of the same conversation, and on each of the three as much as one step may take of each way a click can be waiting
    const oldest = await publish(m, 'oldest', { session: SESSION })
    const older = await publish(m, 'older', { session: SESSION })
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    const made = Date.now()
    // Each carries as much as an action may
    const payload = JSON.stringify({ text: 'x'.repeat(LIMITS.actionPayloadBytes - 11) })
    expect(new TextEncoder().encode(payload).length).toBe(LIMITS.actionPayloadBytes)
    await t.run(async (ctx) => {
      const put = async (artifactId: string, from: number, setAside: boolean) => {
        const a = (await ctx.db.get(artifactId as never)) as { _id: never; userId: never; title: string }
        for (let i = 0; i < 200; i++)
          await ctx.db.insert('actions', {
            userId: a.userId,
            title: a.title,
            artifactId: a._id,
            clientActionId: `waiting-${from}-${String(i).padStart(4, '0')}`,
            name: 'press',
            payload,
            contentVersion: 1,
            createdAt: made + from + i,
            delivery: i % 2 ? 'leased' : 'pending',
            ...(i % 2 ? { leaseMachineId: m.id as never, leaseExpiresAt: made + 600_000 } : {}),
            ...(setAside ? { parkedBy: m.id as never } : { machineId: m.id as never }),
            harness: SESSION.harness,
            sessionId: SESSION.id,
          })
        await ctx.db.patch(a._id, { waiting: 200 })
      }
      await put(oldest.artifactId, 0, true)
      await put(older.artifactId, 1000, false)
      await put(p.artifactId, 2000, false)
    })
    await vi.advanceTimersByTimeAsync(5000)
    const stopped = async () => (await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.route === 'stopped').length
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
    // The step that tells the machine to stop is the one that must be kept: it reads and writes
    // a hundred actions and no more, where six hundred of this size are more than the backend
    // lets one step read, and it would have been refused with the stop in it
    expect(await stopped()).toBe(100)
    expect((await alice.browser.query(api.artifacts.get, { slug: 'plan' })).run).toMatchObject({ stopping: true })
    await settle(t)
    expect(await stopped()).toBe(600)
    expect((await alice.browser.query(api.artifacts.list, {})).map((x) => x.pending)).toEqual([0, 0, 0])
  })

  test('a page deleted while a stop is still dropping what waited on it gives back what was waiting on it once, and what waits on another page goes on being counted', async () => {
    const { t, alice, m, p } = await setup()
    const another = { harness: 'claude-code', id: 'sess-2' }
    const other = await publish(m, 'other', { session: another })
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    const made = Date.now()
    await t.run(async (ctx) => {
      const put = async (artifactId: string, of: { harness: string; id: string }, n: number) => {
        const a = (await ctx.db.get(artifactId as never)) as { _id: never; userId: never; title: string }
        for (let i = 0; i < n; i++)
          await ctx.db.insert('actions', {
            userId: a.userId,
            title: a.title,
            artifactId: a._id,
            clientActionId: `waiting-${of.id}-${String(i).padStart(4, '0')}`,
            name: 'press',
            payload: '{}',
            contentVersion: 1,
            createdAt: made + i,
            delivery: 'pending',
            machineId: m.id as never,
            harness: of.harness,
            sessionId: of.id,
          })
        await ctx.db.patch(a._id, { waiting: n })
      }
      await put(p.artifactId, SESSION, 300)
      await put(other.artifactId, another, 40)
      const [tally] = await ctx.db.query('tallies').collect()
      await ctx.db.patch(tally!._id, { waiting: 340 })
    })
    await vi.advanceTimersByTimeAsync(1000)
    const at = Date.now()
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
    // The stop has dropped its first hundred, and two hundred of the page's are still to be dropped
    expect((await totals(t)).waiting).toBe(240)
    await alice.browser.mutation(api.artifacts.remove, { artifactId: p.artifactId })
    // Deleting the page gave back all that still counted as waiting on it
    expect((await totals(t)).waiting).toBe(40)
    // The stop's next step comes before the page's records have been cleared away, and finds them: it gives back none of them again
    await t.mutation(internal.artifacts.dropRest, { userId: alice.user as never, machineId: m.id, session: SESSION, at, artifactId: p.artifactId })
    expect((await totals(t)).waiting).toBe(40)
    await settle(t)
    expect((await totals(t)).waiting).toBe(40)
    expect((await alice.browser.query(api.artifacts.list, {})).map((x) => [x.slug, x.pending])).toEqual([['other', 40]])
  })

  test.each([false, true])(
    'the inbox stays within its byte and response limits with forty listeners and five queues of maximum payloads, paged: %s',
    async (paged) => {
      const t = backend()
      await person(t, 'alice')
      const m = await machineOf(t, 'alice')
      const queues = ['codex', 'claude-code', 'pi', 'opencode', 'hermes']
      const listening = Array.from({ length: 40 }, (_, i) => ({ harness: 'claude-code', id: `z-listener-${String(i).padStart(2, '0')}` }))
      const now = Date.now()
      // Each carries as much as an action may
      const payload = JSON.stringify({ text: 'x'.repeat(LIMITS.actionPayloadBytes - 11) })
      await t.run(async (ctx) => {
        const machine = (await ctx.db.get(m.id as never)) as { _id: never; userId: never }
        await ctx.db.patch(machine._id, { wakes: queues.map((harness) => ({ harness, since: now - 10_000 })) })
        let pages = 0
        const put = async (of: { harness: string; id: string }, n: number, at: number, addressed = true) => {
          const artifactId = await ctx.db.insert('artifacts', {
            userId: machine.userId,
            slug: `page-${++pages}`,
            title: 'Page',
            currentVersion: 1,
            lastVersion: 1,
            bytes: 1,
            createdAt: now,
            updatedAt: now,
            machineId: machine._id,
            session: of,
            waiting: n,
          })
          // The paged case must also pay for both attended-index reads beyond timer clicks.
          const attendedLookups = paged && addressed && !of.id.startsWith('z-listener')
          const count = attendedLookups ? Math.max(n, 10) : n
          for (let i = 0; i < count; i++)
            await ctx.db.insert('actions', {
              userId: machine.userId,
              title: 'Page',
              artifactId,
              clientActionId: `click-${pages}-${String(i).padStart(3, '0')}`,
              name: 'press',
              payload,
              ...(attendedLookups ? { attended: i === count - 1 ? undefined : i === count - 2 } : {}),
              contentVersion: 1,
              createdAt: at + i,
              delivery: 'pending',
              ...(addressed ? { machineId: machine._id } : {}),
              harness: of.harness,
              sessionId: of.id,
            })
        }
        for (const s of listening) {
          await put(s, 2, now - 500)
          // And two that are addressed to no machine, as a click is whose page was made on a machine that is gone
          await put(s, 2, now - 400, false)
        }
        for (const harness of queues) {
          // One conversation that has waited longest, one that was used last, and twelve more by their names
          await put({ harness, id: 'b-old' }, 40, now - 3000)
          await put({ harness, id: 'c-new' }, 20, now - 100)
          for (let n = 0; n < 12; n++) await put({ harness, id: `a-head${String(n).padStart(2, '0')}` }, 1, now - 1500)
        }
      })
      // The query itself, asked as the machine asks it, with everything it reads of a click counted: also what it reads twice
      const asked = await t.run(async (ctx) => {
        const { db, read } = watched(ctx.db)
        const identity = { issuer: SITE, subject: m.id, kind: 'machine' }
        const answer = await ((paged ? inboxPageQuery : inboxQuery) as any)._handler(
          { ...ctx, db, auth: { getUserIdentity: async () => identity } },
          { listening, queues, ...(paged ? { after: [{ harness: 'codex', id: 'a-head05' }] } : {}) },
        )
        const clicks: { id: string; at: number; attended: boolean | null; session: { harness: string; id: string } }[] = paged ? answer.clicks : answer
        const carried = read.filter((row) => typeof row.payload === 'string').map((row) => new TextEncoder().encode(row.payload).length)
        return { read: carried.reduce((sum, n) => sum + n + 2048, 0), clicks }
      })
      // The backend refuses a query that reads over 16 MB. Include every repeated read and
      // the allowance for each action's fields beside its maximum payload.
      expect(asked.read).toBeLessThanOrEqual(12 * 1024 * 1024)
      const of = (harness: string, id: string) => asked.clicks.filter((c) => c.session.harness === harness && c.session.id === id)
      // Listeners keep their oldest two. Each queue has room for a conversation's oldest
      // work and, in the paged case, its attended click beyond the timer backlog.
      for (const s of listening) expect(of(s.harness, s.id).map((c) => c.at)).toEqual([now - 500, now - 499])
      for (const harness of queues) {
        const id = paged ? (harness === 'codex' ? 'a-head06' : 'a-head00') : 'b-old'
        const oldest = of(harness, id).map((c) => c.at)
        expect(oldest.length).toBeGreaterThan(0)
        if (paged) {
          expect(oldest).toEqual([now - 1500, now - 1500 + 8])
          expect(of(harness, id).at(-1)?.attended).toBe(true)
        } else expect(oldest).toEqual(oldest.map((_, i) => now - 3000 + i))
      }
      expect(asked.clicks.length).toBeLessThanOrEqual(150)
      expect(new Set(asked.clicks.map((c) => c.id)).size).toBe(asked.clicks.length)
    },
  )

  test('a reopened conversation is said to be running for as long as its machine says so, and anyone who can use the page can stop it: what was waiting by then goes with the stop', async () => {
    const { t, alice, m, p, click } = await setup()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    const onPage = async () => (await alice.browser.query(api.artifacts.get, { slug: 'plan' })).run
    const offered = async () => (await inbox(m, [], ['claude-code'])).map((c) => c.id)
    expect(await onPage()).toBeNull()
    // Nothing is running, so there is nothing to stop
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: false })
    const first = (await click('click-run-0001')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [first as never], for: SESSION })
    const began = Date.now()
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    expect(await onPage()).toMatchObject({ since: began, stopping: false })
    expect((await m.as.query(api.machines.me, {})).runs).toEqual([{ harness: 'claude-code', sessionId: 'sess-1', since: began }])
    // Said twice, it is one run
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    expect((await m.as.query(api.machines.me, {})).runs.length).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    const waiting = (await click('click-run-0002')).actionId
    expect(await offered()).toEqual([waiting])
    expect((await alice.browser.query(api.artifacts.list, {})).find((x) => x.slug === 'plan')!.pending).toBe(2)
    // A screen can stop it, as it can click
    const screen = await paired(t, 'alice', 'screen', displayKey('screen'))
    expect(await screen.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
    expect(await onPage()).toMatchObject({ stopping: true })
    expect((await m.as.query(api.machines.me, {})).runs).toMatchObject([{ harness: 'claude-code', sessionId: 'sess-1', stop: true }])
    // What was waiting when it was stopped goes with the stop: it is not reopened for, it is not handed to the
    // conversation when that is next opened, and it no longer counts as waiting on the page
    expect(await offered()).toEqual([])
    expect((await inbox(m)).map((c) => c.id)).toEqual([])
    expect((await alice.browser.query(api.actions.forArtifact, { slug: 'plan' })).find((x) => x.id === waiting)).toMatchObject({
      delivery: 'handed_off',
      route: 'stopped',
      outcome: 'failed',
    })
    // And so does the one the stopped turn was given, and anything its machine held for the run's own add-on:
    // nothing of that conversation's is left waiting, and nothing of it comes back with the next click
    expect((await alice.browser.query(api.actions.forArtifact, { slug: 'plan' })).find((x) => x.id === first)).toMatchObject({
      delivery: 'handed_off',
      route: 'stopped',
    })
    // Each says when it was dropped, which is no earlier than the stop the page tells of: the site counts by that what this stop dropped
    const stoppedAt = (await alice.browser.query(api.artifacts.get, { slug: 'plan' }))!.stoppedAt!
    expect(
      (await alice.browser.query(api.actions.forArtifact, { slug: 'plan' })).filter((x) => x.route === 'stopped').map((x) => x.handedAt! >= stoppedAt),
    ).toEqual([true, true])
    expect((await alice.browser.query(api.artifacts.list, {})).find((x) => x.slug === 'plan')!.pending).toBe(0)
    // The machine saying afterwards that it had handed that one over changes nothing, and is no error
    expect(await m.as.mutation(api.delivery.handedOff, { id: first as never, route: 'queue' })).toMatchObject({ already: true })
    await m.as.mutation(api.machines.runEnded, { for: SESSION })
    expect(await onPage()).toBeNull()
    expect(await offered()).toEqual([])
    // What is done after it reopens the conversation as before
    await vi.advanceTimersByTimeAsync(1000)
    const next = (await click('click-run-0003')).actionId
    expect(await offered()).toEqual([next])
    // A machine with nothing named says that nothing it reopened is running
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    await m.as.mutation(api.machines.runEnded, {})
    expect((await m.as.query(api.machines.me, {})).runs).toEqual([])
    // Why a conversation could not be reopened is said on its page, and taken back once it has run
    const failedOn = async () => (await alice.browser.query(api.artifacts.get, { slug: 'plan' })).wakeFailed
    expect(await failedOn()).toBeNull()
    const at = Date.now()
    await m.as.mutation(api.machines.wakeFailed, { for: SESSION, why: 'Claude Code was not found' })
    expect(await failedOn()).toEqual({ at, why: 'Claude Code was not found' })
    await m.as.mutation(api.machines.wakeFailed, { for: SESSION, why: 'x'.repeat(500) })
    expect((await failedOn())?.why.length).toBe(300)
    // Ended without having run, it is still so
    await m.as.mutation(api.machines.runEnded, { for: SESSION })
    expect(await failedOn()).not.toBeNull()
    await m.as.mutation(api.machines.runEnded, { for: SESSION, ok: true })
    expect(await failedOn()).toBeNull()
    expect(await code(alice.browser.mutation(api.machines.wakeFailed, { for: SESSION, why: 'x' }))).toBe('forbidden')
    // Another person can stop nothing of it, and a machine cannot stop for a person
    const bob = await person(t, 'bob')
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    expect(await code(bob.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId }))).toBe('not_found')
    expect(await code(m.as.mutation(api.artifacts.stop, { artifactId: p.artifactId }))).toBe('forbidden')
    expect(await onPage()).toMatchObject({ stopping: false })
  })

  test('the ending of an earlier run of a conversation, told late, does not take away the run that has begun since, and an ending that names none is never that of a named run', async () => {
    const { m } = await setup()
    const runs = async () => (await m.as.query(api.machines.me, {})).runs.map((r) => (r as { run?: string }).run ?? null)
    await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'first' })
    // The same conversation is reopened again before the first run's ending has been heard
    await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'second' })
    expect(await runs()).toEqual(['second'])
    await m.as.mutation(api.machines.runEnded, { for: SESSION, run: 'first' })
    await m.as.mutation(api.machines.runEnded, { for: SESSION })
    expect(await runs()).toEqual(['second'])
    await m.as.mutation(api.machines.runEnded, { for: SESSION, run: 'second', ok: true })
    expect(await runs()).toEqual([])
    // A run begun with no name, as an earlier It begins them, is ended by an ending with none and by no other
    await m.as.mutation(api.machines.runBegan, { for: SESSION })
    await m.as.mutation(api.machines.runEnded, { for: SESSION, run: 'second' })
    expect(await runs()).toEqual([null])
    await m.as.mutation(api.machines.runEnded, { for: SESSION })
    expect(await runs()).toEqual([])
  })

  test('a run is not said to begin for something a stop has dropped meanwhile: the stop a person pressed beside the run before is not lost on the run that was being got ready', async () => {
    const { alice, m, p, click } = await setup()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    const listed = async () => (await m.as.query(api.machines.me, {})).runs.map((r) => [(r as { run?: string }).run ?? null, r.stop ?? false])
    // The run before is over on its machine, and It still has it down as running: its ending has not been heard
    await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'before' })
    // The next thing done on the page is taken by the machine, which gets a new run ready for it
    const waiting = (await click('click-0001')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [waiting as never], for: SESSION })
    await vi.advanceTimersByTimeAsync(1000)
    // The person presses Stop, beside the run that is still listed
    expect(await alice.browser.mutation(api.artifacts.stop, { artifactId: p.artifactId })).toEqual({ stopping: true })
    // Told now that the new run begins for that click, It says the click was stopped, and lists no new run
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'next', ids: [waiting] })).toEqual({ stopped: true })
    expect(await listed()).toEqual([['before', true]])
    // What is done after the stop is reopened for as before, and a run told of with nothing named begins as it always did
    await vi.advanceTimersByTimeAsync(1000)
    const after = (await click('click-0002')).actionId
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'next', ids: [after] })).toEqual({ stopped: false })
    expect(await listed()).toEqual([['next', false]])
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'another' })).toEqual({ stopped: false })
    // A click that is no longer there is not there to be reopened for: its page was deleted meanwhile, and what the stop said of it went with it
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'another', ids: ['not an id'] })).toEqual({ stopped: true })
    await alice.browser.mutation(api.artifacts.remove, { artifactId: p.artifactId })
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'another', ids: [after] })).toEqual({ stopped: true })
    expect(await listed()).toEqual([['another', false]])
  })

  test('a run is not said to begin where reopening was switched off for its app since the machine last heard', async () => {
    const { alice, m, click } = await setup()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    const waiting = (await click('click-0001')).actionId
    await m.as.mutation(api.delivery.claim, { ids: [waiting as never], for: SESSION })
    // The person switches it off, and the machine, which has not heard yet, says the run begins
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: false })
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'next', ids: [waiting] })).toEqual({ stopped: false, off: true })
    expect((await m.as.query(api.machines.me, {})).runs).toEqual([])
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    expect(await m.as.mutation(api.machines.runBegan, { for: SESSION, run: 'next', ids: [waiting] })).toEqual({ stopped: false })
  })

  test('clicks that were set aside, or are another machine’s, never hide one a listening machine may take', async () => {
    const { t, alice, m: old, p } = await setup()
    // Another of the person's machines, which stays enrolled and has clicks of its own for a
    // conversation of the same name
    const elsewhere = await machineOf(t, 'alice', 'desktop')
    // Clicks for the conversation that the machine about to listen may not deliver: some set
    // aside with no machine, as a revoked machine's are, and some that are the other machine's
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(p.artifactId))!
      const row = (i: number, extra: Record<string, unknown>) =>
        ctx.db.insert('actions', {
          userId: a.userId,
          title: a.title,
          artifactId: a._id,
          clientActionId: `stuck-${String(i).padStart(4, '0')}`,
          name: 'press',
          payload: '{}',
          contentVersion: 1,
          createdAt: Date.now() + i,
          delivery: 'pending',
          harness: SESSION.harness,
          sessionId: SESSION.id,
          ...extra,
        })
      for (let i = 0; i < 12; i++) await row(i, { parkedBy: old.id })
      for (let i = 12; i < 24; i++) await row(i, { machineId: elsewhere.id })
    })
    await vi.advanceTimersByTimeAsync(1000)
    // The person signs this computer in again, as a new machine that does not take the old one's place
    await alice.browser.mutation(api.machines.revoke, { machineId: old.id as never })
    await settle(t)
    const fresh = await machineOf(t, 'alice', 'laptop again')
    const pressed = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-fresh'),
    })
    // The conversation is here and listening on the new machine: the click just made is offered,
    // whatever stands before it in the order they were made
    expect((await inbox(fresh)).map((c) => c.id)).toEqual([pressed.actionId])
    expect(await fresh.as.mutation(api.delivery.claim, { ids: [pressed.actionId], for: SESSION })).toEqual([pressed.actionId])
  })

  test('a page whose machine is gone belongs, from the first click of it that another machine takes for its conversation, to that machine: clicks go there with nobody listening, and it can be reopened there', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const old = await machineOf(t, 'alice', 'laptop')
    const p = await publish(old, 'plan', { session: SESSION })
    const press = async (id: string) =>
      (await alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope(id) })).actionId
    const page = () => alice.browser.query(api.artifacts.get, { slug: 'plan' })
    const sentTo = async (id: string) => ((await t.run((ctx) => ctx.db.get(id as never))) as { machineId?: string } | null)?.machineId
    await alice.browser.mutation(api.machines.revoke, { machineId: old.id as never })
    await settle(t)
    // Its machine was removed: the site is told so, and there is nowhere to reopen its conversation
    expect(await page()).toMatchObject({ machine: 'laptop', machineGone: true, machineSeenAt: null, wake: null })
    // The computer joins again as a new machine that names no earlier identity, and another of the person's machines is there too
    const again = await machineOf(t, 'alice', 'laptop again')
    const other = await machineOf(t, 'alice', 'server')
    await again.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [{ id: 'claude-code', addon: 'connected' }] })
    const first = await press('click-first')
    expect(await sentTo(first)).toBeUndefined()
    // A machine that takes it for no conversation takes the click and not the page
    expect(await other.as.mutation(api.delivery.claim, { ids: [first as never] })).toEqual([first])
    await settle(t)
    expect(await page()).toMatchObject({ machine: 'laptop', machineGone: true })
    await other.as.mutation(api.delivery.release, { id: first as never })
    // Its conversation is open on the machine that joined again, which takes the click for it: the page is that machine's now
    expect(await again.as.mutation(api.delivery.claim, { ids: [first as never], for: SESSION })).toEqual([first])
    await settle(t)
    expect(await page()).toMatchObject({ machine: 'laptop again', machineGone: false, wake: null })
    await t.run((ctx) => ctx.db.patch(again.id, { wanted: ['claude-code'] }))
    expect((await page()).wake).toEqual({ machineId: again.id, harness: 'claude-code', on: false })
    expect((await page()).machineSeenAt).toBeGreaterThan(0)
    // The next click is that machine's with nobody listening, and no other machine is offered it
    const second = await press('click-second')
    expect(await sentTo(second)).toBe(again.id)
    expect((await inbox(other)).map((c) => c.id)).toEqual([])
    expect(await other.as.mutation(api.delivery.claim, { ids: [second as never], for: SESSION })).toEqual([])
  })

  test('nor do another person’s clicks for a conversation of the same name, however many, or clicks set aside on both sides of it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const hers = await machineOf(t, 'alice')
    const listener = await machineOf(t, 'alice', 'listener')
    const his = await machineOf(t, 'bob')
    const parker = await machineOf(t, 'alice', 'parker')
    const ap = await publish(hers, 'plan', { session: SESSION })
    const bp = await publish(his, 'plan', { session: SESSION })
    const set = await publish(parker, 'aside', { session: SESSION })
    // Both pages' machines are gone, so clicks on them belong to no machine
    await bob.browser.mutation(api.machines.revoke, { machineId: his.id })
    await alice.browser.mutation(api.machines.revoke, { machineId: hers.id })
    await settle(t)
    const press = async (who: typeof alice, name: string, artifactId: typeof ap.artifactId, id: string) => {
      await vi.advanceTimersByTimeAsync(1)
      return (await who.browser.mutation(api.actions.submit, { artifactId, displayKey: displayKey(name), envelope: envelope(id) })).actionId
    }
    const aside = async (id: string) =>
      expect(await parker.as.mutation(api.delivery.park, { id: (await press(alice, 'alice', set.artifactId, id)) as never, for: SESSION })).toBe(true)
    // Before hers: eight of his, and eight of her own that were set aside
    for (let i = 0; i < 8; i++) await press(bob, 'bob', bp.artifactId, `his-before-${i}`)
    for (let i = 0; i < 8; i++) await aside(`aside-before-${i}`)
    const first = await press(alice, 'alice', ap.artifactId, 'hers-first')
    const second = await press(alice, 'alice', ap.artifactId, 'hers-second')
    const third = await press(alice, 'alice', ap.artifactId, 'hers-third')
    // And after hers: as many again
    for (let i = 0; i < 8; i++) await press(bob, 'bob', bp.artifactId, `his-after-${i}`)
    for (let i = 0; i < 8; i++) await aside(`aside-after-${i}`)
    // Her listening machine is offered hers, the oldest first, and nothing of his
    expect((await inbox(listener)).map((c) => c.id)).toEqual([first, second])
    expect(await listener.as.mutation(api.delivery.claim, { ids: [first as never], for: SESSION })).toEqual([first])
    expect((await inbox(listener)).map((c) => c.id)).toEqual([second, third])
  })

  test('a computer enrolled again twice before the first hand-over ran still ends up with the pages its first identity made', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice', 'first')
    const thread = { harness: 'codex', id: 'closed-thread' }
    const p = await publish(first, 'plan', { session: thread })
    await first.as.mutation(api.machines.leave, {})
    const second = await machineOf(t, 'alice', 'second', first.id)
    // Signed in once more before anything scheduled has run
    await second.as.mutation(api.machines.leave, {})
    const third = await machineOf(t, 'alice', 'third', second.id)
    await settle(t)
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(third.id)
    const click = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('after-second-replace'),
    })
    // Codex's own queue on the newest identity is offered the click, with no conversation open
    expect((await inbox(third, [], ['codex'])).map((c) => c.id)).toEqual([click.actionId])
    // An identity that is someone else's, or still live, is never walked back through
    const bob = await person(t, 'bob')
    void bob
    const his = await machineOf(t, 'bob', 'his', third.id)
    await settle(t)
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(third.id)
    expect(((await t.run((ctx) => ctx.db.get(his.id as never))) as { replaces?: string } | null)?.replaces).toBeUndefined()
  })

  test('enrolled again six times before any hand-over ran, the computer’s newest identity still gets the pages its first one made', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    let last = first
    const thread = { harness: 'codex', id: 'closed-thread' }
    const p = await publish(first, 'plan', { session: thread })
    for (let i = 0; i < 6; i++) {
      await last.as.mutation(api.machines.leave, {})
      // Only the clock moves, so that enrolling again is allowed and nothing scheduled runs
      vi.setSystemTime(Date.now() + 12_001)
      last = await machineOf(t, 'alice', `again-${i}`, last.id)
    }
    await settle(t)
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(last.id)
    const click = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('after-six'),
    })
    expect((await inbox(last, [], ['codex'])).map((c) => c.id)).toEqual([click.actionId])
  })

  test('a computer that comes back after more than a month still gets its pages: cleanup keeps a revoked machine’s record while a page names it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const idle = await machineOf(t, 'alice', 'made nothing')
    const thread = { harness: 'codex', id: 'closed-thread' }
    const p = await publish(first, 'plan', { session: thread })
    await first.as.mutation(api.machines.leave, {})
    await idle.as.mutation(api.machines.leave, {})
    await settle(t)
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    // The one a page names is kept, and the one that made nothing is gone
    expect(await t.run((ctx) => ctx.db.get(first.id as never))).not.toBeNull()
    expect(await t.run((ctx) => ctx.db.get(idle.id as never))).toBeNull()
    const back = await machineOf(t, 'alice', 'back again', first.id)
    await settle(t)
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(back.id)
    const click = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('back-late'),
    })
    expect((await inbox(back, [], ['codex'])).map((c) => c.id)).toEqual([click.actionId])
    // With no page naming it any more, the old record goes at the next cleanup a month on
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.get(first.id as never))).toBeNull()
  })

  test('a click on a page whose machine was revoked waits where any of the person’s machines can take it', async () => {
    const { t, alice, m, p, click } = await setup()
    await alice.browser.mutation(api.machines.revoke, { machineId: m.id })
    const { actionId } = await click('click-0001')
    const other = await machineOf(t, 'alice', 'server')
    expect((await t.run((ctx) => ctx.db.get(actionId)))?.machineId).toBeUndefined()
    expect((await other.as.query(api.delivery.waiting, { slug: 'plan' })).map((c) => c.id)).toEqual([actionId])
    expect((await other.as.query(api.delivery.allWaiting, {})).length).toBe(1)
    void p
  })

  test('clicks are rate limited for one page, so that one page cannot use up what the others need', async () => {
    const { alice, m, click } = await setup()
    const results = []
    for (let i = 0; i < 40; i++) results.push(await code(click(`click-${String(i).padStart(4, '0')}`)))
    expect(results.filter((r) => r === 'ok').length).toBe(30)
    expect(results.at(-1)).toBe('rate_limited')
    const other = await publish(m, 'other', { session: SESSION })
    expect(
      await code(
        alice.browser.mutation(api.actions.submit, { artifactId: other.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-other') }),
      ),
    ).toBe('ok')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await code(click('click-later'))).toBe('ok')
  })

  test('the largest clicks cannot be sent at the fastest rate', async () => {
    const { t, click } = await setup()
    const big = JSON.stringify('x'.repeat(LIMITS.actionPayloadBytes - 100))
    const results = []
    // Just under one a second is within the count for a page. As small clicks that could go on for ever
    for (let i = 0; i < 240; i++) {
      results.push(await code(click(`big-${String(i).padStart(4, '0')}`, { payload: big })))
      // A limit that is reached is written down by a job of its own, which is let run before the clock moves
      if (results.at(-1) === 'ok') await runWhatIsDue(t)
      else dropWhatAFailedCallScheduled()
      await vi.advanceTimersByTimeAsync(1100)
    }
    // As the largest clicks allowed, the bytes run out: about 4 MB at once and half a megabyte a minute after
    const refused = results.filter((r) => r === 'rate_limited').length
    expect(refused).toBeGreaterThan(10)
    expect(results.slice(0, 100).every((r) => r === 'ok')).toBe(true)
  })

  test('a clock that is set back takes nothing away from what a limit allows', async () => {
    const { click } = await setup()
    expect(await code(click('click-0001'))).toBe('ok')
    // The machine It runs on has its clock set back an hour: counted on from a time that is now still to come, an hour's worth would be taken off
    vi.setSystemTime(Date.now() - 3_600_000)
    expect(await code(click('click-0002'))).toBe('ok')
  })

  test.each([0, 3, 59_999, 60_000])('a retry delay includes a refill time that is %i milliseconds ahead', async (ahead) => {
    const { t, click } = await setup()
    const countedAt = Date.now()
    for (let i = 0; i < 30; i++) await click(`click-${String(i).padStart(4, '0')}`)
    await runWhatIsDue(t)
    vi.setSystemTime(countedAt - ahead)
    await expect(click('click-refused')).rejects.toThrow(`"retryAfterMs":${ahead + 1000}`)

    // Waiting for the future baseline earns nothing. The next token needs another second.
    vi.setSystemTime(countedAt)
    await expect(click('click-at-baseline')).rejects.toThrow('"retryAfterMs":1000')
    vi.setSystemTime(countedAt + 999)
    await expect(click('click-before-ready')).rejects.toThrow('"retryAfterMs":1')
    vi.setSystemTime(countedAt + 1000)
    expect(await code(click('click-ready'))).toBe('ok')
    expect(await code(click('click-no-second-token'))).toBe('rate_limited')
  })

  test('callers that come a moment out of order are not given the limit afresh', async () => {
    const { click } = await setup()
    // As many small clicks as the limit lets through at once, each a few milliseconds "before" the one that came ahead of it,
    // as callers at once are when one that began earlier is answered later
    const results: string[] = []
    for (let i = 0; i < 400; i++) {
      vi.setSystemTime(Date.now() - 3)
      results.push(await code(click(`click-${String(i).padStart(4, '0')}`)))
      if (results.at(-1) !== 'ok') dropWhatAFailedCallScheduled()
    }
    // The limit is met all the same: counted afresh for each that came out of order, none would ever be refused
    expect(results.filter((r) => r === 'ok')).toHaveLength(30)
    expect(results.filter((r) => r === 'rate_limited')).toHaveLength(370)
  })

  test('only so many clicks may wait: on one page, and for one person', async () => {
    const { t, p, click } = await setup()
    await t.run((ctx) => ctx.db.patch(p.artifactId, { waiting: QUOTA.pendingActionsPerPage }))
    expect(await code(click('click-0001'))).toBe('limit')
    await t.run(async (ctx) => {
      await ctx.db.patch(p.artifactId, { waiting: 0 })
      const row = (await ctx.db.query('tallies').collect())[0]!
      await ctx.db.patch(row._id, { waiting: QUOTA.pendingActions })
    })
    expect(await code(click('click-0002'))).toBe('limit')
  })

  test('a click handed over after its page was deleted is not taken off the person’s count a second time', async () => {
    const { alice, m, click, counts } = await setup()
    const other = await publish(m, 'other', { session: SESSION })
    await alice.browser.mutation(api.actions.submit, { artifactId: other.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-other') })
    const { actionId } = await click('click-0001')
    await m.as.mutation(api.delivery.claim, { ids: [actionId] })
    // The page goes while its click is out for delivery; then the delivery is reported
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    await m.as.mutation(api.delivery.handedOff, { id: actionId, route: 'addon' })
    // One click is still waiting, on the other page, and the person's count still says so
    expect((await counts())[1]).toBe(1)
  })

  test('a click that was out for delivery when its page changed hands goes to the new owner when the lease ends', async () => {
    const { t, alice, m: laptop, p, click } = await setup()
    const server = await machineOf(t, 'alice', 'server')
    const theirs = { harness: 'codex', id: 'thread-9' }
    const lost = await click('click-0001')
    const given = await click('click-0002')
    await laptop.as.mutation(api.delivery.claim, { ids: [lost.actionId, given.actionId] })
    await publish(server, 'plan', { session: theirs, take: true })
    await settle(t)
    // The laptop gives one back, and dies holding the other
    await laptop.as.mutation(api.delivery.release, { id: given.actionId })
    await vi.advanceTimersByTimeAsync(LEASE_MS + 1000)
    await t.mutation(internal.delivery.reap, {})
    expect((await inbox(server, [theirs])).map((c) => c.id).sort()).toEqual([lost.actionId, given.actionId].sort())
    expect(await inbox(laptop)).toEqual([])
    void alice
    void p
  })

  test('when a page changes hands, every waiting click goes with it, however many were made at the same moment', async () => {
    const { t, m: laptop, p } = await setup()
    const server = await machineOf(t, 'alice', 'server')
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(p.artifactId))!
      // More than one batch of them, and all at one instant
      for (let i = 0; i < 120; i++)
        await ctx.db.insert('actions', {
          userId: a.userId,
          title: a.title,
          artifactId: a._id,
          clientActionId: `tied-${String(i).padStart(4, '0')}`,
          name: 'press',
          payload: '{}',
          contentVersion: 1,
          createdAt: 5000,
          delivery: 'pending',
          machineId: a.machineId,
          harness: 'claude-code',
          sessionId: 'sess-1',
        })
    })
    await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-9' }, take: true })
    await settle(t)
    const left = await t.run(async (ctx) => (await ctx.db.query('actions').collect()).filter((x) => x.sessionId !== 'thread-9').length)
    expect(left).toBe(0)
    void laptop
  })

  test('old clicks are removed, and one nobody ever took stops counting as waiting', async () => {
    const { t, m, click, counts } = await setup()
    const taken = await click('click-0001')
    await m.as.mutation(api.delivery.handedOff, { id: taken.actionId, route: 'manual' })
    await click('click-0002')
    expect(await counts()).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(8 * 86_400_000)
    await t.mutation(internal.retention.sweepActions, {})
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).map((x) => x.clientActionId)).toEqual(['click-0002'])
    await vi.advanceTimersByTimeAsync(23 * 86_400_000)
    await t.mutation(internal.retention.sweepActions, {})
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
    expect(await counts()).toEqual([0, 0])
  })
})

describe('showing a page', () => {
  /** Alice, a page of hers, and a way to ask for a showing of it and for that showing's ticket. */
  async function showing() {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    const show = () => alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    const open = (mountId: string) => alice.browser.action(api.mounts.ticket, { mountId })
    return { t, alice, p, show, open }
  }

  test('a showing gets a mount of its own and exactly one ticket, which names the showing', async () => {
    const { t, alice, p, show, open } = await showing()
    const one = await show()
    const two = await show()
    expect(one.mountId).toMatch(/^[0-9a-f]{32}$/)
    expect(Object.keys(one).sort()).toEqual(['mountId', 'version'])
    expect([one.version, two.mountId === one.mountId]).toEqual([1, false])
    const { ticket } = await open(one.mountId)
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(ticket, jwks, { issuer: SITE, audience: 'it-content' })
    expect(payload).toMatchObject({ sub: one.mountId, m: one.mountId, a: p.artifactId, v: '1', d: alice.display.id, e: 0 })
    // Who it is for, what it shows and where that is kept, and nothing else
    expect(Object.keys(payload).sort()).toEqual(['a', 'aud', 'd', 'e', 'exp', 'iat', 'iss', 'jti', 'm', 'p', 's', 'sub', 'u', 'v'])
    expect(payload.p).toMatch(/^u\/[^/]+\/[^/]+\/1\/$/)
    expect(payload.exp! - payload.iat!).toBe(60)
    expect(typeof payload.jti).toBe('string')
    expect(await code(open(one.mountId))).toBe('conflict')
    expect(await code(open('f'.repeat(32)))).toBe('conflict')
  })

  test('showings asked for at the same moment are each given a mount of their own', async () => {
    const { show } = await showing()
    const made = await Promise.all(Array.from({ length: 6 }, () => show()))
    expect(new Set(made.map((x) => x.mountId)).size).toBe(6)
  })

  test('any number of showings are open at once, and one made earlier is still given its ticket after many more were made', async () => {
    const { t, show, open } = await showing()
    const first = await show()
    const made = []
    for (let i = 0; i < 40; i++) {
      made.push(await show())
      await vi.advanceTimersByTimeAsync(1000)
    }
    // Every one of them opens, and none took anything from another
    for (const x of made) expect((await open(x.mountId)).ticket).toBeTruthy()
    // The first was asked for before all of them, and is opened last: it is still within its two minutes
    expect((await open(first.mountId)).ticket).toBeTruthy()
    const rows = await t.run((ctx) => ctx.db.query('mounts').collect())
    expect(rows.length).toBe(41)
    expect(rows.every((r) => r.ticketGiven)).toBe(true)
  })

  test('the cleanup removes a showing’s record once it is a day old, and not before', async () => {
    const { t, show, open } = await showing()
    const old = await show()
    await open(old.mountId)
    await vi.advanceTimersByTimeAsync(23 * 3_600_000)
    const later = await show()
    await t.mutation(internal.retention.sweepRecords, {})
    expect((await t.run((ctx) => ctx.db.query('mounts').collect())).map((r) => r.mountId).sort()).toEqual([old.mountId, later.mountId].sort())
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect((await t.run((ctx) => ctx.db.query('mounts').collect())).map((r) => r.mountId)).toEqual([later.mountId])
  })

  test('a mount left too long gives no ticket', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    const mount = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    await vi.advanceTimersByTimeAsync(121_000)
    expect(await code(alice.browser.action(api.mounts.ticket, { mountId: mount.mountId }))).toBe('conflict')
  })

  test("signing out raises the display's number, tells the content service, and later tickets carry it", async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    await settle(t)
    const call = content.calls.find((c) => c.op === 'revoke')!
    expect(call.body).toMatchObject({ displayId: alice.display.id, epoch: 1 })
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const control = await jwtVerify(call.token, jwks, { issuer: SITE, audience: 'it-control' })
    expect(control.payload.sub).toBe('revoke')
    const mount = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    const { ticket } = await alice.browser.action(api.mounts.ticket, { mountId: mount.mountId })
    expect((await jwtVerify(ticket, jwks, { audience: 'it-content' })).payload.e).toBe(1)
  })

  test('a display can be signed out by the token it was given, even once its browser is not paired', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('x'), p256dh: 'p', auth: 'a' })
    const { token } = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
    const present = (body: unknown) =>
      t.fetch('/display/signout', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    // The token says what it is for, and nothing else is accepted in its place
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    expect((await jwtVerify(token, jwks, { issuer: SITE, audience: 'it-signout' })).payload).toMatchObject({ sub: alice.display.id, e: 1 })
    const mount = await alice.browser.mutation(api.mounts.create, {
      artifactId: (await publish(await machineOf(t, 'alice'), 'plan')).artifactId,
      displayKey: displayKey('alice'),
    })
    const ticket = (await alice.browser.action(api.mounts.ticket, { mountId: mount.mountId })).ticket
    expect((await present({ token: ticket })).status).toBe(401)
    expect((await present({ token: 'nonsense' })).status).toBe(401)
    expect((await present({})).status).toBe(400)
    // Presented by a browser that is not paired, it signs that one display out: its number goes up, the
    // content service is told, and nothing more is pushed to it
    // The site asks at its own address, so nothing is said that would let a page elsewhere read the answer
    const done = await present({ token })
    expect([done.status, done.headers.get('access-control-allow-origin')]).toEqual([200, null])
    expect((await t.fetch('/display/signout', { method: 'OPTIONS' })).status).toBe(404)
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'revoke').map((c) => [c.body.displayId, c.body.epoch])).toEqual([[alice.display.id, 1]])
    expect((await alice.browser.query(api.displays.list, {}))[0]!.push).toBe(false)
    // Presenting it again does nothing more, and it never touches anyone else's display
    await present({ token })
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'revoke').length).toBe(1)
    expect((await t.run((ctx) => ctx.db.query('displays').collect())).find((d) => d._id === bob.display.id)?.epoch).toBe(0)
  })

  test('a revocation the content service did not hear is told again until it confirms', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    content.failNext = 3
    await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    await settle(t)
    const told = content.calls.filter((c) => c.op === 'revoke')
    expect(told.length).toBe(4)
    expect(told.every((c) => c.body.epoch === 1)).toBe(true)
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
  })

  test('a job whose retry was lost is started again', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    await t.run((ctx) =>
      ctx.db.insert('contentJobs', {
        op: 'delete',
        body: '{"prefix":"u/x/y/1/"}',
        attempts: 2,
        nextAt: Date.now() - 600_000,
        createdAt: 0,
        userId: alice.user as never,
      }),
    )
    expect(await t.mutation(internal.content.kick, {})).toBe(1)
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'delete').map((c) => c.body.prefix)).toEqual(['u/x/y/1/'])
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
  })

  test('an agent can bring a page up on one named display or on all of them', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    await alice.browser.mutation(api.displays.rename, { displayId: alice.display.id, name: 'Kitchen' })
    expect((await m.as.mutation(api.displays.show, { slug: 'plan', display: 'kitchen' })).displays).toEqual(['Kitchen'])
    expect((await alice.browser.query(api.displays.mine, { key: displayKey('alice') }))?.showing?.slug).toBe('plan')
    expect(await code(m.as.mutation(api.displays.show, { slug: 'plan', display: 'Garage' }))).toBe('not_found')
  })
})

describe('displays and machines', () => {
  test('a new browser is registered on the spot with a generated name, once', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    expect(alice.display).toMatchObject({ name: 'Chrome on Linux', named: false })
    const again = await alice.browser.mutation(api.displays.register, { key: displayKey('alice'), userAgent: 'whatever' })
    expect(again.id).toBe(alice.display.id)
    expect(await code(alice.browser.mutation(api.displays.register, { key: 'short', userAgent: '' }))).toBe('invalid')
    expect(await code(alice.browser.mutation(api.displays.rename, { displayId: alice.display.id, name: 'x'.repeat(LIMITS.displayName + 1) }))).toBe('invalid')
  })

  test('a second browser of the same kind is given a name of its own, so that a person and an agent can tell the two apart before either is named', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const names = async () => (await alice.browser.query(api.displays.list, {})).map((d) => d.name).sort()
    const second = await alice.browser.mutation(api.displays.register, { key: 'a-second-display-key-01', userAgent: ua })
    expect(second).toMatchObject({ name: 'Chrome on Linux 2', named: false })
    await alice.browser.mutation(api.displays.register, { key: 'a-third-display-key-0001', userAgent: ua })
    expect(await names()).toEqual(['Chrome on Linux', 'Chrome on Linux 2', 'Chrome on Linux 3'])
    // A name the person gave one of them is not given to the next, in whatever capitals
    await alice.browser.mutation(api.displays.rename, { displayId: second.id, name: 'chrome on linux 4' })
    await alice.browser.mutation(api.displays.register, { key: 'a-fourth-display-key-001', userAgent: ua })
    expect(await names()).toEqual(['Chrome on Linux', 'Chrome on Linux 2', 'Chrome on Linux 3', 'chrome on linux 4'])
    // So an agent that names one shows a page on that one and no other
    await publish(m, 'plan')
    expect((await m.as.mutation(api.displays.show, { slug: 'plan', display: 'Chrome on Linux 3' })).displays).toEqual(['Chrome on Linux 3'])
  })

  test('presence is written at most once a minute, and answers with the backend’s clock', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const seen = async () => (await alice.browser.query(api.displays.list, {}))[0]!.lastSeenAt
    const first = await seen()
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await alice.browser.mutation(api.displays.heartbeat, { key: displayKey('alice') })).now).toBe(Date.now())
    expect(await seen()).toBe(first)
    await vi.advanceTimersByTimeAsync(30_000)
    await alice.browser.mutation(api.displays.heartbeat, { key: displayKey('alice') })
    expect(await seen()).toBe(first + 60_000)
  })

  test('a forgotten display loses its pages, is removed, is signed out at once, and cannot register itself again', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const p = await publish(await machineOf(t, 'alice'), 'plan')
    const tablet = await paired(t, 'alice', 'screen', 'alice-tablet-key-001')
    expect((await tablet.browser.query(api.artifacts.list, {})).length).toBe(1)
    await alice.browser.mutation(api.displays.forget, { displayId: tablet.display.id })
    // The tablet still holds a token with minutes left to run. Its very next call is refused, whatever it asks.
    expect(await code(tablet.browser.query(api.artifacts.list, {}))).toBe('unauthenticated')
    expect(await code(tablet.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: 'alice-tablet-key-001' }))).toBe('unauthenticated')
    await settle(t)
    expect(content.calls.find((c) => c.op === 'revoke')?.body).toMatchObject({ displayId: tablet.display.id, epoch: 1 })
    expect((await alice.browser.query(api.displays.list, {})).map((d) => d.id)).toEqual([alice.display.id])
    // Paired again, the browser still keeps its old key, which is refused: the site lets go of it
    const back = await browserOf(t, 'alice', 'screen')
    expect(await code(back.browser.mutation(api.displays.register, { key: 'alice-tablet-key-001', userAgent: 'x' }))).toBe('not_found')
    // Under a new key it starts again as a new display
    expect(await code(back.browser.mutation(api.displays.register, { key: 'a-brand-new-key-0001', userAgent: 'x' }))).toBe('ok')
    // The refusal is not kept for ever
    await vi.advanceTimersByTimeAsync(91 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.query('forgotten').collect())).toEqual([])
  })

  test('forgetting a display ends the session its browser was paired into and no other, and whatever else that browser registered as stops with it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const tablet = await paired(t, 'alice', 'screen', 'alice-tablet-key-001')
    const phone = await paired(t, 'alice', 'screen', 'alice-phone-key-0001')
    // The tablet's browser lost what it kept and came back under another key: two displays, one browser
    const second = await tablet.browser.mutation(api.displays.register, { key: 'alice-tablet-key-002', userAgent: 'x' })
    await tablet.browser.mutation(api.push.subscribe, { key: 'alice-tablet-key-002', endpoint: PUSH('tablet'), p256dh: 'p', auth: 'a' })
    await alice.browser.mutation(api.displays.forget, { displayId: tablet.display.id })
    await settle(t)
    const ended = async () => (await t.run((ctx) => ctx.db.query('sessions').collect())).filter((x) => x.endedAt !== undefined).map((x) => x._id)
    expect(await ended()).toEqual([tablet.session])
    // The phone and the owner's own browser are as they were
    expect(await code(phone.browser.query(api.artifacts.list, {}))).toBe('ok')
    expect(await code(alice.browser.query(api.artifacts.list, {}))).toBe('ok')
    // The tablet's other display stops showing pages and is pushed nothing more, and its record stays for the person to see
    expect(
      content.calls
        .filter((c) => c.op === 'revoke')
        .map((c) => c.body.displayId)
        .sort(),
    ).toEqual([tablet.display.id, second.id].sort())
    expect((await alice.browser.query(api.displays.list, {})).find((d) => d.id === second.id)?.push).toBe(false)
    // A display goes with the session that registered it last: paired again, the same browser brings its display along
    const back = await browserOf(t, 'alice', 'screen')
    await back.browser.mutation(api.displays.register, { key: 'alice-tablet-key-002', userAgent: 'x' })
    await alice.browser.mutation(api.displays.forget, { displayId: second.id })
    expect(await alive(back.browser)).toBe(false)
    expect((await ended()).length).toBe(2)
    // The owner who forgets the display they are sitting at is signed out of it like anyone
    await alice.browser.mutation(api.displays.forget, { displayId: alice.display.id })
    expect(await code(alice.browser.query(api.displays.list, {}))).toBe('unauthenticated')
    expect(await code(phone.browser.query(api.artifacts.list, {}))).toBe('ok')
  })

  test('a person with as many displays as there may be makes room by letting go of one nobody has opened for a month', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const register = (i: number) =>
      code(alice.browser.mutation(api.displays.register, { key: `alice-extra-key-${String(i).padStart(4, '0')}`, userAgent: 'x' }))
    for (let i = 1; i < QUOTA.displays; i++) {
      expect(await register(i)).toBe('ok')
      await vi.advanceTimersByTimeAsync(7000)
    }
    // Every display was open recently: one more is refused
    expect(await register(100)).toBe('limit')
    await vi.advanceTimersByTimeAsync(31 * 86_400_000)
    expect(await register(101)).toBe('ok')
    await settle(t)
    const all = await alice.browser.query(api.displays.list, {})
    expect(all.length).toBe(QUOTA.displays)
    expect(all.some((d) => d.id === alice.display.id)).toBe(false)
    expect(content.calls.some((c) => c.op === 'revoke' && c.body.displayId === alice.display.id)).toBe(true)
  })

  test('signing out over and over is rate limited', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const results = []
    for (let i = 0; i < 12; i++) results.push(await code(alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })))
    expect(results.filter((r) => r === 'ok').length).toBe(10)
    expect(results.at(-1)).toBe('rate_limited')
  })

  test('a person can have only so many machines, and revoked ones do not count', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const made = []
    for (let i = 0; i < QUOTA.machines; i++) {
      made.push(await machineOf(t, 'alice', `m${i}`))
      await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(await t.mutation(internal.bridge.enroll, { subject: 'user_alice', name: 'one too many', publicKey: KEY })).toEqual({ error: 'limit' })
    await alice.browser.mutation(api.machines.revoke, { machineId: made[0]!.id })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await t.mutation(internal.bridge.enroll, { subject: 'user_alice', name: 'now it fits', publicKey: KEY })).toHaveProperty('machineId')
    // A revoked machine's record goes a month later
    await vi.advanceTimersByTimeAsync(31 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect((await t.run((ctx) => ctx.db.query('machines').collect())).some((m) => m.revoked)).toBe(false)
  })

  test('the first machine is enrolled by the service, on a backend that holds nothing, and that makes the one person', async () => {
    const t = backend()
    expect(await t.run(async (ctx) => [(await ctx.db.query('users').collect()).length, (await ctx.db.query('machines').collect()).length])).toEqual([0, 0])
    expect(await (await t.fetch('/cli/config')).json()).toEqual({ protocol: 1, issuer: SITE })
    const key = await aKeyPair()
    const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: key.publicKey })
    if ('error' in made) throw new Error(made.error)
    expect((await t.run((ctx) => ctx.db.query('users').collect())).map((u) => u.subject)).toEqual(['owner'])
    // The service starts again and enrols the same key: the same machine, and the same person
    expect(await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: key.publicKey })).toEqual(made)
    expect(await t.run(async (ctx) => [(await ctx.db.query('users').collect()).length, (await ctx.db.query('machines').collect()).length])).toEqual([1, 1])
    // The machine proves it holds its key, and is given a token that the backend takes it for a machine by
    const proof = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(made.machineId)
      .setAudience(`${SITE}/bridge/token`)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .sign(key.privateKey)
    const answered = await t.fetch('/bridge/token', { method: 'POST', body: JSON.stringify({ machine: made.machineId, proof }) })
    expect(answered.status).toBe(200)
    const { iss, sub, kind } = claimsOf(((await answered.json()) as { token: string }).token)
    const machine = t.withIdentity({ issuer: iss, subject: sub, kind })
    expect(await machine.query(api.machines.me, {})).toMatchObject({ id: made.machineId, name: 'this machine' })
    // And it is that machine that lets the first browser in
    const owner = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    expect((await owner.browser.query(api.machines.list, {})).map((m) => m.id)).toEqual([made.machineId])
  })

  test('another machine is enrolled over HTTP with a code made for that, once, and may name the identity it takes the place of', async () => {
    const { t, machine, machineId } = await installed()
    const enrol = (body: unknown) => t.fetch('/bridge/enroll', { method: 'POST', body: JSON.stringify(body) })
    const machines = () => t.run((ctx) => ctx.db.query('machines').collect())
    const invited = await machine.mutation(api.sessions.inviteMachine, {})
    const server = await aKeyPair()
    // With no code, or with something that is no public key, nothing is enrolled and the code is not touched
    expect((await enrol({ publicKey: server.publicKey, name: 'server' })).status).toBe(401)
    expect((await enrol({ code: invited.code, name: 'server' })).status).toBe(400)
    expect((await enrol({ code: invited.code, publicKey: { ...server.publicKey, d: 'a private half' }, name: 'server' })).status).toBe(400)
    expect((await enrol({ code: invited.code, publicKey: { ...server.publicKey, crv: 'P-384' }, name: 'server' })).status).toBe(400)
    expect((await t.run((ctx) => ctx.db.query('invites').collect())).map((i) => i.usedAt)).toEqual([undefined])
    const done = await enrol({ code: invited.code, publicKey: server.publicKey, name: 'server' })
    const { machine: serverId } = (await done.json()) as { machine: string }
    expect([done.status, (await machines()).map((m) => [m._id, m.name])]).toEqual([
      200,
      [
        [machineId, 'this machine'],
        [serverId, 'server'],
      ],
    ])
    expect(new Set((await machines()).map((m) => m.userId)).size).toBe(1)
    // The answer was lost on its way back, and the machine asks again with its code and its key: the same machine
    expect(await (await enrol({ code: invited.code, publicKey: server.publicKey, name: 'server' })).json()).toEqual({ machine: serverId })
    // Anyone else who comes by the code afterwards gets nothing with it
    expect((await enrol({ code: invited.code, publicKey: await aPublicKey(), name: 'another' })).status).toBe(401)
    expect((await machines()).length).toBe(2)
    // The same computer enrolling again names the identity it gave up, and is given what that one had
    const again = await machine.mutation(api.sessions.inviteMachine, {})
    await t.withIdentity({ issuer: SITE, subject: serverId, kind: 'machine' }).mutation(api.machines.leave, {})
    const replaced = await enrol({ code: again.code, publicKey: await aPublicKey(), name: 'server again', replaces: serverId })
    const { machine: newId } = (await replaced.json()) as { machine: string }
    expect((await machines()).find((m) => m._id === newId)?.replaces).toBe(serverId)
    await settle(t)
  })

  test('enrolling is rate limited per person, and the first enrolment is what makes the person', async () => {
    const t = backend()
    for (let i = 0; i < 5; i++) expect(await t.mutation(internal.bridge.enroll, { subject: 'user_new', name: 'm', publicKey: KEY })).toHaveProperty('machineId')
    expect(await code(t.mutation(internal.bridge.enroll, { subject: 'user_new', name: 'm', publicKey: KEY }))).toBe('rate_limited')
    expect((await t.run((ctx) => ctx.db.query('users').collect())).length).toBe(1)
  })

  test('the token bridge reads nothing large, whatever length a request claims', async () => {
    const t = backend()
    const big = JSON.stringify({ machine: 'x', proof: 'y'.repeat(50_000) })
    expect((await t.fetch('/bridge/token', { method: 'POST', body: big, headers: { 'content-length': String(big.length) } })).status).toBe(400)
    // No length stated at all: still given up on after a few kilobytes
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 64; i++) controller.enqueue(new TextEncoder().encode('z'.repeat(1024)))
        controller.close()
      },
    })
    expect((await t.fetch('/bridge/token', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).status).toBe(400)
    expect((await t.fetch('/bridge/enroll', { method: 'POST', body: big })).status).toBe(401)
  })

  test("a machine's proof is spent once, allows its clock to be a minute out, and not at all once it is too old", async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const nowS = Math.floor(Date.now() / 1000)
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'n'.repeat(20), issuedAt: nowS })).toBe('ok')
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'n'.repeat(20), issuedAt: nowS })).toBe('already_used')
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'p'.repeat(20), issuedAt: nowS - 100 })).toBe('ok')
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'o'.repeat(20), issuedAt: nowS - 140 })).toBe('too_old')
    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.query('spentProofs').collect())).toEqual([])
    // Cleaned away, the old proof still cannot be spent again: it is long past its age
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'n'.repeat(20), issuedAt: nowS })).toBe('too_old')
  })

  test('the connector reports what it found, and the person chooses what to connect', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.mutation(api.machines.report, {
      connectorVersion: '0.1.0',
      harnesses: [
        { id: 'claude-code', version: '2.1.287', addon: 'missing' },
        { id: 'made-up', addon: 'missing' },
      ],
    })
    // On the site, one box at a time: only an agent app It knows can be chosen
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: true })
    expect(await code(alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'made-up', on: true }))).toBe('invalid')
    expect(await m.as.query(api.machines.me, {})).toMatchObject({
      harnesses: [{ id: 'claude-code', version: '2.1.287', addon: 'missing' }],
      wanted: ['claude-code'],
    })
    // Ticked again it is chosen once, and unticked it is not chosen
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: true })
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'codex', on: true })
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: false })
    expect((await m.as.query(api.machines.me, {})).wanted).toEqual(['codex'])
    // And on the machine itself, by `it setup`: the same choice, with what It does not know left out
    await m.as.mutation(api.machines.choose, { harnesses: ['pi', 'made-up', 'pi'] })
    expect((await m.as.query(api.machines.me, {})).wanted).toEqual(['pi'])
  })

  test('reopening is on for an agent app from when it is connected on a machine, by the person or by setup there, and what the person switched off stays off whoever connects the app again', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.mutation(api.machines.inventory, { harnesses: ['claude-code', 'codex'].map((id) => ({ id, addon: 'connected' })) })
    const wakes = async () => (await m.as.query(api.machines.me, {})).wakes.map((w) => w.harness).sort()
    expect(await wakes()).toEqual([])
    // Connected by the person, on the Machines page
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: true })
    expect(await wakes()).toEqual(['claude-code'])
    // Chosen on the machine by setup, an app It cannot reopen among them: on for the ones it can, and setup is told which
    expect(await m.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex', 'openclaw'], system: 'linux' })).toEqual({
      wakes: ['claude-code', 'codex'],
    })
    expect(await wakes()).toEqual(['claude-code', 'codex'])
    // Setup run again, as every update runs it, changes nothing
    const before = (await m.as.query(api.machines.me, {})).wakes
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await m.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex', 'openclaw'], system: 'linux' })).toEqual({
      wakes: ['claude-code', 'codex'],
    })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual(before)
    // The person switches one off. It stays off when the app is disconnected and connected again, on the site
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'codex', on: false })
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'codex', on: false })
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'codex', on: true })
    expect(await wakes()).toEqual(['claude-code'])
    // And by the machine, which is to say by anything that runs on it: no agent switches it on for itself by connecting its app afresh
    await m.as.mutation(api.machines.choose, { harnesses: ['claude-code'] })
    expect(await m.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex'] })).toEqual({ wakes: ['claude-code'] })
    expect(await wakes()).toEqual(['claude-code'])
    // Only the person switches it on again
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'codex', on: true })
    expect(await wakes()).toEqual(['claude-code', 'codex'])
    // A machine that was set up before reopening came on by itself, its apps connected and nothing ever switched, is left as it is
    const old = await machineOf(t, 'alice', 'desktop')
    await t.run((ctx) => ctx.db.patch(old.id as never, { wanted: ['claude-code'] }))
    expect(await old.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'linux' })).toEqual({ wakes: [] })
    expect((await old.as.query(api.machines.me, {})).wakes).toEqual([])
    // On a machine that runs Windows nothing is switched on, and setup is told that nothing is
    const pc = await machineOf(t, 'alice', 'pc')
    expect(await pc.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'win32' })).toEqual({ wakes: [] })
    expect(((await t.run((ctx) => ctx.db.get(pc.id as never))) as { wakes?: unknown; system?: string }).wakes).toBeUndefined()
    // One that has not said what it runs has it noted, and nothing comes of that until it is known to be a system It reopens on
    const unknown = await machineOf(t, 'alice', 'server')
    await t.run((ctx) => ctx.db.patch(unknown.id as never, { system: undefined }))
    expect(await unknown.as.mutation(api.machines.choose, { harnesses: ['claude-code'] })).toEqual({ wakes: [] })
    expect((await unknown.as.query(api.machines.me, {})).wakes).toEqual([])
    await unknown.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], system: 'linux' })
    expect((await unknown.as.query(api.machines.me, {})).wakes.map((w) => w.harness)).toEqual(['claude-code'])
  })

  test('a machine on Windows has closed conversations reopened only where its own It says it does them there, and an It of another version that does not say takes that away', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const onPage = async (slug: string) => (await alice.browser.query(api.artifacts.get, { slug })).wake
    const wakes = async (m: { as: ReturnType<T['withIdentity']> }) => (await m.as.query(api.machines.me, {})).wakes.map((w) => w.harness).sort()
    // A new Windows machine whose setup says so: on for the apps it connects, as on any other system, and setup is told which
    const apps = ['claude-code', 'codex'].map((id) => ({ id, addon: 'connected' }))
    const pc = await machineOf(t, 'alice', 'pc')
    await t.run((ctx) => ctx.db.patch(pc.id, { system: undefined }))
    await pc.as.mutation(api.machines.inventory, { harnesses: apps })
    expect(await pc.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex'], system: 'win32', reopens: true })).toEqual({
      wakes: ['claude-code', 'codex'],
    })
    expect(await wakes(pc)).toEqual(['claude-code', 'codex'])
    expect((await alice.browser.query(api.machines.list, {})).find((x) => x.id === pc.id)).toMatchObject({ system: 'win32', reopens: true })
    await publish(pc, 'plan', { session: { harness: 'claude-code', id: 'c-1' } })
    expect(await onPage('plan')).toEqual({ machineId: pc.id, harness: 'claude-code', on: true })
    // Its connector's reports say so too. One of the same version that does not say, as the plainer report does not, leaves it as it was
    await pc.as.mutation(api.machines.report, { connectorVersion: '0.2.0', harnesses: apps, system: 'win32', reopens: true })
    await pc.as.mutation(api.machines.report, { connectorVersion: '0.2.0', harnesses: apps })
    expect(await wakes(pc)).toEqual(['claude-code', 'codex'])
    // Put back to an It that does not say: nothing is reopened there, and the switch is refused with why
    await pc.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: apps, system: 'win32' })
    expect(await wakes(pc)).toEqual([])
    expect(await onPage('plan')).toBeNull()
    expect((await alice.browser.query(api.machines.list, {})).find((x) => x.id === pc.id)).toMatchObject({ reopens: false, wakes: [] })
    await alice.browser.mutation(api.machines.wake, { machineId: pc.id, harness: 'claude-code', on: false })
    await expect(alice.browser.mutation(api.machines.wake, { machineId: pc.id, harness: 'claude-code', on: true })).rejects.toThrow(
      'This Windows machine runs an It that does not reopen closed conversations there.',
    )
    // Nor is anything handed to that machine to be reopened for: a closed conversation's click waits
    const runBegan = await pc.as.mutation(api.machines.runBegan, { for: { harness: 'codex', id: 'x-1' }, run: 'r-1', ids: [] })
    expect(runBegan).toEqual({ stopped: false, off: true })
    // Updated again, it says so once more, and what the person switched off stays off: only the switch puts it back
    await pc.as.mutation(api.machines.report, { connectorVersion: '0.2.0', harnesses: apps, system: 'win32', reopens: true })
    expect(await wakes(pc)).toEqual(['codex'])
    await alice.browser.mutation(api.machines.wake, { machineId: pc.id, harness: 'claude-code', on: true })
    expect(await wakes(pc)).toEqual(['claude-code', 'codex'])
    // A Windows machine set up with an It from before one said so keeps its apps as they were when an update says it: nothing comes on by itself
    const old = await machineOf(t, 'alice', 'laptop')
    await t.run((ctx) => ctx.db.patch(old.id, { system: 'win32' }))
    await old.as.mutation(api.machines.inventory, { harnesses: [{ id: 'claude-code', addon: 'connected' }] })
    expect(await old.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'win32' })).toEqual({ wakes: [] })
    expect(await old.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'win32', reopens: true })).toEqual({ wakes: [] })
    await old.as.mutation(api.machines.report, { connectorVersion: '0.2.0', harnesses: apps, system: 'win32', reopens: true })
    expect(await wakes(old)).toEqual([])
    await alice.browser.mutation(api.machines.wake, { machineId: old.id, harness: 'claude-code', on: true })
    expect(await wakes(old)).toEqual(['claude-code'])
    // On Linux and macOS the system is enough, whatever is said
    const box = await machineOf(t, 'alice', 'box')
    expect(await box.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'linux' })).toEqual({ wakes: ['claude-code'] })
  })

  test('a computer that is enrolled again keeps reopening switched off for the apps the person switched it off for there, and setup connecting them does not switch it on', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    expect(await first.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex'], system: 'linux' })).toEqual({ wakes: ['claude-code', 'codex'] })
    await alice.browser.mutation(api.machines.wake, { machineId: first.id, harness: 'claude-code', on: false })
    // The person revokes the machine and sets it up again, which is how the computer It runs on is brought back
    await alice.browser.mutation(api.machines.revoke, { machineId: first.id })
    await settle(t)
    const again = await machineOf(t, 'alice', 'laptop', first.id)
    // Setup finds both apps there and connects them: what was switched off stays off, and setup is told so
    expect(await again.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex'], system: 'linux' })).toEqual({ wakes: ['codex'] })
    expect((await again.as.query(api.machines.me, {})).wakes.map((w) => w.harness)).toEqual(['codex'])
    // And so it does for the identity that takes that one's place in its turn
    await alice.browser.mutation(api.machines.revoke, { machineId: again.id })
    await settle(t)
    const third = await machineOf(t, 'alice', 'laptop', again.id)
    await third.as.mutation(api.machines.inventory, { harnesses: [{ id: 'claude-code', addon: 'connected' }] })
    expect(await third.as.mutation(api.machines.choose, { harnesses: ['claude-code', 'codex'], system: 'linux' })).toEqual({ wakes: ['codex'] })
    // Only the person switches it on again
    await alice.browser.mutation(api.machines.wake, { machineId: third.id, harness: 'claude-code', on: true })
    expect((await third.as.query(api.machines.me, {})).wakes.map((w) => w.harness).sort()).toEqual(['claude-code', 'codex'])
    // A machine that names an identity that is not given up takes nothing from it
    const other = await machineOf(t, 'alice', 'desk')
    await other.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'linux' })
    await alice.browser.mutation(api.machines.wake, { machineId: other.id, harness: 'claude-code', on: false })
    const stranger = await machineOf(t, 'alice', 'server', other.id)
    expect(await stranger.as.mutation(api.machines.choose, { harnesses: ['claude-code'], system: 'linux' })).toEqual({ wakes: ['claude-code'] })
  })

  test('reopening a closed conversation is switched by the owner alone, for one agent app on one machine, and what a machine is told to connect leaves their switches as they set them', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.mutation(api.machines.inventory, { harnesses: ['claude-code', 'codex'].map((id) => ({ id, addon: 'connected' })) })
    await t.run((ctx) => ctx.db.patch(m.id, { wanted: ['claude-code'] }))
    const other = await machineOf(t, 'alice', 'desktop')
    await publish(m, 'plan', { session: { harness: 'claude-code', id: 'c-1' } })
    await publish(m, 'sketch', { session: { harness: 'openclaw', id: 'x-1' } })
    await publish(m, 'note')
    const onPage = async (slug: string) => (await alice.browser.query(api.artifacts.get, { slug })).wake
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    expect(await onPage('plan')).toEqual({ machineId: m.id, harness: 'claude-code', on: false })
    // A page whose agent app It cannot reopen, or that no conversation made, has nothing to switch on
    expect(await onPage('sketch')).toBeNull()
    expect(await onPage('note')).toBeNull()
    const at = Date.now()
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([{ harness: 'claude-code', since: at }])
    expect((await alice.browser.query(api.machines.list, {})).map((x) => [x.name, x.wakes.map((w) => w.harness)])).toEqual([
      ['laptop', ['claude-code']],
      ['desktop', []],
    ])
    expect((await other.as.query(api.machines.me, {})).wakes).toEqual([])
    expect(await onPage('plan')).toEqual({ machineId: m.id, harness: 'claude-code', on: true })
    // Switched on again while it is on, it is on since when it was: asking twice lets in nothing older
    await vi.advanceTimersByTimeAsync(60_000)
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([{ harness: 'claude-code', since: at }])
    // What the machine chooses for itself, as `it setup` does, leaves what the person switched as they set it.
    // The app that is newly connected by it has reopening on, which the person then switches off here
    const chose = Date.now()
    await m.as.mutation(api.machines.choose, { harnesses: ['codex'] })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([
      { harness: 'claude-code', since: at },
      { harness: 'codex', since: chose },
    ])
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'codex', on: false })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([{ harness: 'claude-code', since: at }])
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: true })
    // On a machine that runs Windows, or that has not said what it runs, reopening is not to be had:
    // the switch is refused with why, what was switched on before says nothing, and nothing is offered for reopening
    for (const [system, why] of [
      ['win32', 'This Windows machine runs an It that does not reopen closed conversations there.'],
      [undefined, 'This machine has not said which system it runs'],
    ] as const) {
      await t.run((ctx) => ctx.db.patch(m.id as never, { system }))
      expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
      expect(await onPage('plan')).toBeNull()
      await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: false })
      await expect(alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })).rejects.toThrow(why)
      await t.run((ctx) => ctx.db.patch(m.id as never, { system: 'linux' }))
      await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    }
    // A connector says what it runs on when it reports, and one that does not say leaves it as it was
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], system: 'darwin' })
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [] })
    expect(((await t.run((ctx) => ctx.db.get(m.id as never))) as { system?: string }).system).toBe('darwin')
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: false })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    expect(await onPage('plan')).toBeNull()
    // A connector that hands nothing over for now says so with its report, and why. The site is told beside
    // the machine and on its pages, until a report says it no more
    const paused = async () => [
      (await alice.browser.query(api.machines.list, {})).find((x) => x.id === m.id)?.paused,
      (await alice.browser.query(api.artifacts.get, { slug: 'plan' }))?.machinePaused,
    ]
    expect(await paused()).toEqual([null, null])
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], paused: 'unfit' })
    expect(await paused()).toEqual(['unfit', 'unfit'])
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], paused: 'unchecked' })
    expect(await paused()).toEqual(['unchecked', 'unchecked'])
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], paused: '' })
    expect(await paused()).toEqual([null, null])
    // A report that does not say leaves it as it was: a connector whose fuller report was refused for a
    // moment falls back on the plainer one for a while, and is as paused as it was before
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [], paused: 'unfit' })
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [] })
    expect(await paused()).toEqual(['unfit', 'unfit'])
    // A connector of another version that does not say, as an earlier one does not, is not paused
    await m.as.mutation(api.machines.report, { connectorVersion: '0.0.9', harnesses: [] })
    expect(await paused()).toEqual([null, null])
  })

  test.each([
    ['codex', false, 'connected', '0.160.0', 'disconnected', false],
    ['codex', true, 'connected', '0.160.0', 'connected', true],
    ['codex', true, 'needs_approval', '0.160.0', 'needs_approval', true],
    ['codex', true, 'needs_approval', '0.161.0', 'needs_approval', true],
    ['codex', true, 'needs_approval', 'v0.160.0', 'needs_approval', true],
    ['codex', true, 'needs_approval', '0.159.0', 'needs_approval', false],
    ['codex', true, 'connected', '0.159.0', 'connected', false],
    ['codex', true, 'needs_approval', undefined, 'needs_approval', false],
    ['codex', true, 'needs_approval', 'invalid', 'needs_approval', false],
    ['codex', true, 'needs_approval', '1000000.0.0', 'needs_approval', false],
    ['codex', true, 'needs_approval', '0.160.0-beta', 'needs_approval', false],
    ['codex', true, 'needs_approval', ' 0.160.0 ', 'needs_approval', false],
    ['codex', true, 'not_connected', '0.160.0', 'connecting', false],
    ['codex', true, undefined, undefined, 'unknown', false],
    ['codex', true, 'error', '0.160.0', 'error', false],
    ['codex', true, 'too_old', '0.160.0', 'too_old', false],
    ['codex', true, 'unavailable', '0.160.0', 'unavailable', false],
    ['codex', true, 'future-state', '0.160.0', 'unknown', false],
    ['claude-code', true, 'connected', '2.1.287', 'connected', false],
    ['openclaw', true, 'connected', '2026.9.6', 'connected', false],
    ['openclaw', false, 'connected', '2026.9.6', 'disconnected', false],
  ] as const)(
    'owners and screens read only the page app readiness for %s selected=%s report=%s version=%s',
    async (harness, wanted, addon, version, state, queue) => {
      const t = backend()
      const alice = await person(t, 'alice')
      const screen = await paired(t, 'alice', 'screen', 'readiness-screen-0001')
      const m = await machineOf(t, 'alice')
      const p = await publish(m, 'plan', { session: { harness, id: 'page-conversation' } })
      await t.run((ctx) =>
        ctx.db.patch(m.id, {
          wanted: wanted ? [harness] : [],
          harnesses: [
            ...(addon ? [{ id: harness, addon, ...(version ? { version } : {}), detail: 'private installation detail' }] : []),
            { id: 'unrelated-app', addon: 'error', detail: 'private unrelated detail' },
          ],
        }),
      )
      for (const reader of [alice.browser, screen.browser]) {
        const got = await reader.query(api.artifacts.get, { artifactId: p.artifactId, history: false })
        expect(got.connection).toEqual({ harness, state, queue })
        expect(got).not.toHaveProperty('harnesses')
        expect(got).not.toHaveProperty('wanted')
        expect(got).not.toHaveProperty('publicKey')
        expect(JSON.stringify(got)).not.toMatch(/private installation detail|private unrelated detail|unrelated-app/)
        if (harness === 'openclaw' || !wanted || !['connected', 'needs_approval'].includes(addon ?? '')) expect(got.wake).toBeNull()
      }
      expect(await code(screen.browser.query(api.machines.list, {}))).toBe('forbidden')
    },
  )

  test('page readiness follows a changed protocol minimum for the queue', async () => {
    vi.doMock('@it/protocol', async () => ({
      ...(await vi.importActual<typeof import('@it/protocol')>('@it/protocol')),
      CODEX_MIN_VERSION: '0.161.0',
    }))
    vi.resetModules()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      const m = await machineOf(t, 'alice')
      await publish(m, 'plan', { session: { harness: 'codex', id: 'page-conversation' } })
      for (const [version, queue] of [
        ['0.160.0', false],
        ['0.161.0', true],
      ] as const) {
        await t.run((ctx) => ctx.db.patch(m.id, { wanted: ['codex'], harnesses: [{ id: 'codex', addon: 'connected', version }] }))
        expect((await alice.browser.query(api.artifacts.get, { slug: 'plan', history: false })).connection).toEqual({
          harness: 'codex',
          state: 'connected',
          queue,
        })
      }
    } finally {
      vi.doUnmock('@it/protocol')
      vi.resetModules()
    }
  })

  test('page readiness accepts old machine records and is absent without an owning session or live machine', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const screen = await paired(t, 'alice', 'screen', 'readiness-screen-0001')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION })
    const expectConnection = async (connection: unknown) => {
      for (const reader of [alice.browser, screen.browser]) expect((await reader.query(api.artifacts.get, { slug: 'plan' })).connection).toEqual(connection)
    }
    await expectConnection({ harness: SESSION.harness, state: 'disconnected', queue: false })
    await t.run((ctx) => ctx.db.patch(m.id, { wanted: [SESSION.harness] }))
    await expectConnection({ harness: SESSION.harness, state: 'unknown', queue: false })
    await t.run((ctx) => ctx.db.patch(p.artifactId, { session: undefined }))
    await expectConnection(null)
    await t.run((ctx) => ctx.db.patch(p.artifactId, { session: SESSION, machineId: undefined }))
    await expectConnection(null)
    await t.run(async (ctx) => {
      await ctx.db.patch(p.artifactId, { machineId: m.id })
      await ctx.db.patch(m.id, { revoked: true })
    })
    await expectConnection(null)
    await t.run((ctx) => ctx.db.delete(m.id))
    await expectConnection(null)
  })

  test('only an owner can enable wake for a selected app, while turning it off preserves consent for an unselected app', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const screen = await paired(t, 'alice', 'screen', 'readiness-screen-0001')
    const m = await machineOf(t, 'alice')
    const args = { machineId: m.id, harness: 'codex', on: true }
    await t.run((ctx) => ctx.db.patch(m.id, { harnesses: [{ id: 'codex', addon: 'connected', version: '0.160.0' }] }))
    expect(await code(alice.browser.mutation(api.machines.wake, args))).toBe('invalid')
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    await alice.browser.mutation(api.machines.wake, { ...args, on: false })
    expect((await t.run((ctx) => ctx.db.get(m.id)))?.wakesOff).toEqual(['codex'])
    await m.as.mutation(api.machines.choose, { harnesses: ['codex'], system: 'linux' })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    for (const addon of [undefined, 'not_connected', 'error', 'too_old', 'unavailable']) {
      await m.as.mutation(api.machines.inventory, { harnesses: addon ? [{ id: 'codex', addon, version: '0.160.0' }] : [] })
      expect(await code(alice.browser.mutation(api.machines.wake, args))).toBe('invalid')
      expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    }
    await m.as.mutation(api.machines.inventory, { harnesses: [{ id: 'codex', addon: 'needs_approval', version: '0.160.0' }] })
    for (const reader of [screen.browser, m.as]) expect(await code(reader.mutation(api.machines.wake, args))).toBe('forbidden')
    await alice.browser.mutation(api.machines.wake, args)
    expect((await m.as.query(api.machines.me, {})).wakes).toMatchObject([{ harness: 'codex' }])
    await alice.browser.mutation(api.machines.toggle, { ...args, on: false })
    expect(await code(alice.browser.mutation(api.machines.wake, args))).toBe('invalid')
    await alice.browser.mutation(api.machines.wake, { ...args, on: false })
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
    expect((await t.run((ctx) => ctx.db.get(m.id)))?.wakesOff).toEqual(['codex'])
  })

  test('a machine cannot switch reopening on, so no agent switches it on for itself, and it is only for an agent app It can reopen', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    expect(await code(m.as.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true }))).toBe('forbidden')
    for (const harness of ['openclaw', 'made-up'])
      expect(await code(alice.browser.mutation(api.machines.wake, { machineId: m.id, harness, on: true }))).toBe('invalid')
    expect((await m.as.query(api.machines.me, {})).wakes).toEqual([])
  })

  test('what `it setup` found on a machine is shown without the machine counting as heard from: only a connector’s own report does that', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const onSite = async () => (await alice.browser.query(api.machines.list, {}))[0]!
    const signedInAt = (await onSite()).lastSeenAt
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await m.as.mutation(api.machines.inventory, {
      harnesses: [
        { id: 'codex', version: '0.159.0', addon: 'connected' },
        { id: 'made-up', addon: 'connected' },
      ],
    })
    // The site shows what was found, and still has no connector to call online
    expect(await onSite()).toMatchObject({
      harnesses: [{ id: 'codex', version: '0.159.0', addon: 'connected' }],
      connectorVersion: null,
      lastSeenAt: signedInAt,
    })
    // A connector that is really there says so itself, and only then is the machine heard from
    await m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [{ id: 'codex', version: '0.159.0', addon: 'connected' }] })
    const heardAt = (await onSite()).lastSeenAt
    expect(await onSite()).toMatchObject({ connectorVersion: '0.1.0' })
    expect(heardAt).toBeGreaterThan(signedInAt)
    // And setup run again, long after that connector went quiet, does not make it look alive
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await m.as.mutation(api.machines.inventory, { harnesses: [{ id: 'codex', version: '0.160.0', addon: 'connected' }] })
    expect(await onSite()).toMatchObject({ harnesses: [{ id: 'codex', version: '0.160.0' }], connectorVersion: '0.1.0', lastSeenAt: heardAt })
    // It is the machine's own to say, and nobody else's
    expect(await code(alice.browser.mutation(api.machines.inventory, { harnesses: [] }))).toBe('forbidden')
  })

  test('a joined machine cannot request a cached release below its host version', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const host = await machineOf(t, 'alice', 'the desk')
    const laptop = await machineOf(t, 'alice', 'the laptop')
    await t.run((ctx) => ctx.db.patch(laptop.id as never, { byMachine: host.id } as never))
    await host.as.mutation(api.machines.report, { connectorVersion: '0.10.0', harnesses: [] })
    await laptop.as.mutation(api.machines.report, { connectorVersion: '0.9.0', latest: '0.9.5', harnesses: [] })
    expect(await code(alice.browser.mutation(api.machines.upgrade, { machineId: laptop.id as never }))).toBe('conflict')
    expect((await laptop.as.query(api.machines.me, {})).upgrade).toBeNull()
  })

  test('a machine says which newer version of It it has learned is out, and only the owner’s own browser can have it brought to it, the machine It runs on first', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const host = await machineOf(t, 'alice', 'the desk')
    const report = (m: typeof host, version: string, latest?: string) =>
      m.as.mutation(api.machines.report, { connectorVersion: version, harnesses: [], ...(latest === undefined ? {} : { latest }) })
    const onSite = async (id: string) => (await alice.browser.query(api.machines.list, {})).find((m) => m.id === id)!
    const ask = (id: string, as = alice.browser) => as.mutation(api.machines.upgrade, { machineId: id as never })
    await report(host, '0.1.0')
    // It knows of none: there is nothing to bring it to
    expect(await onSite(host.id)).toMatchObject({ connectorVersion: '0.1.0', latest: null, upgrade: null })
    expect(await code(ask(host.id))).toBe('conflict')
    // It has learned of one, and a report that says nothing of it does not forget it
    await report(host, '0.1.0', '0.1.1')
    await report(host, '0.1.0')
    expect((await onSite(host.id)).latest).toBe('0.1.1')
    // A machine that joined, and has learned of it too, waits for the one It runs on
    const laptop = await machineOf(t, 'alice', 'the laptop')
    await t.run((ctx) => ctx.db.patch(laptop.id as never, { byMachine: host.id } as never))
    await report(laptop, '0.1.0', '0.1.1')
    expect(await code(ask(laptop.id))).toBe('conflict')
    expect((await onSite(laptop.id)).upgrade).toBeNull()
    // Asked for by the owner, it is asked of the machine, which says how far it has got
    expect(await code(ask(host.id))).toBe('ok')
    expect((await onSite(host.id)).upgrade).toMatchObject({ state: 'asked', version: '0.1.1' })
    expect((await host.as.query(api.machines.me, {})).upgrade).toMatchObject({ state: 'asked' })
    await host.as.mutation(api.machines.upgrading, { state: 'working' })
    expect((await onSite(host.id)).upgrade).toMatchObject({ state: 'working' })
    // It could not: why is kept for the site, cut to a length, and it can be asked for again
    await host.as.mutation(api.machines.upgrading, { state: 'failed', why: 'x'.repeat(1000) })
    expect((await onSite(host.id)).upgrade).toMatchObject({ state: 'failed', why: 'x'.repeat(300) })
    expect(await code(ask(host.id))).toBe('ok')
    // The connector that starts as the newer version reports it, and the asking is over
    await report(host, '0.1.1', '0.1.1')
    expect(await onSite(host.id)).toMatchObject({ connectorVersion: '0.1.1', upgrade: null })
    expect(await code(ask(host.id))).toBe('conflict')
    // And now that the machine It runs on is there, the one that joined can be brought to it
    expect(await code(ask(laptop.id))).toBe('ok')
    expect((await onSite(laptop.id)).upgrade).toMatchObject({ state: 'asked', version: '0.1.1' })
    // Neither a machine nor a screen can ask it of a machine, and a machine cannot speak of an upgrade nobody asked for
    await report(host, '0.1.1', '0.1.2')
    expect(await code(host.as.mutation(api.machines.upgrade, { machineId: host.id as never }))).toBe('forbidden')
    const screen = await browserOf(t, 'alice', 'screen')
    expect(await code(ask(host.id, screen.browser))).toBe('forbidden')
    await host.as.mutation(api.machines.upgrading, { state: 'working' })
    expect((await onSite(host.id)).upgrade).toBeNull()
    // Turned off on the machine, it says so with no version, and the site has none to speak of
    await report(host, '0.1.1', '')
    expect((await onSite(host.id)).latest).toBe('')
    expect(await code(ask(host.id))).toBe('conflict')
  })

  test('a machine is heard from each half minute its connector says so, and is off from the moment its connector says it is stopping, until the next one reports', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan', { session: SESSION })
    const onSite = async () => (await alice.browser.query(api.machines.list, {}))[0]!
    const page = () => alice.browser.query(api.artifacts.get, { slug: 'plan' })
    const report = () => m.as.mutation(api.machines.report, { connectorVersion: '0.1.0', harnesses: [] })
    await vi.advanceTimersByTimeAsync(1000)
    await report()
    const heardAt = (await onSite()).lastSeenAt
    expect(await onSite()).toMatchObject({ off: false, connectorVersion: '0.1.0' })
    expect((await page()).machineSeenAt).toBe(heardAt)
    // Said again too soon to be the next of them, it is not written a second time
    await vi.advanceTimersByTimeAsync(10_000)
    await report()
    expect((await onSite()).lastSeenAt).toBe(heardAt)
    // The next of them, half a minute after the first and a moment early, is
    await vi.advanceTimersByTimeAsync(ALIVE.everyMs - 10_000 - 500)
    await report()
    expect((await onSite()).lastSeenAt).toBe(heardAt + ALIVE.everyMs - 500)
    // So a machine that goes on saying so is never quiet for as long as the site takes to call it off
    expect(ALIVE.onlineMs).toBeGreaterThanOrEqual(3 * ALIVE.everyMs)
    // Asked to stop, its connector says so: the machine is off from then, and its pages wait for it
    await m.as.mutation(api.machines.stopping, {})
    expect(await onSite()).toMatchObject({ off: true, lastSeenAt: heardAt + ALIVE.everyMs - 500 })
    expect((await page()).machineSeenAt).toBeNull()
    // The connector that starts next reports at once, however soon after the last, and the machine is there again
    await vi.advanceTimersByTimeAsync(2000)
    await report()
    expect(await onSite()).toMatchObject({ off: false })
    expect((await page()).machineSeenAt).toBe(heardAt + ALIVE.everyMs + 1500)
    // It is the machine's own to say: a browser cannot say it of one
    expect(await code(alice.browser.mutation(api.machines.stopping, {}))).toBe('forbidden')
  })

  test('a machine can make the same choice for itself, and for no other machine', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const server = await machineOf(t, 'alice', 'server')
    await laptop.as.mutation(api.machines.choose, { harnesses: ['codex', 'codex', 'made-up'] })
    expect((await laptop.as.query(api.machines.me, {})).wanted).toEqual(['codex'])
    expect((await server.as.query(api.machines.me, {})).wanted).toEqual([])
    expect(await code(alice.browser.mutation(api.machines.choose, { harnesses: [] }))).toBe('forbidden')
  })

  test('a machine that gives up its own access is nobody from then on, and its key gets no more tokens', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.mutation(api.machines.leave, {})
    expect(await code(m.as.query(api.machines.me, {}))).toBe('unauthenticated')
    expect(await t.query(internal.bridge.machine, { id: m.id })).toMatchObject({ revoked: true })
  })
})

describe('notifications', () => {
  test('a button needs a page, and pressing it is one ordinary click however often it is pressed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan', { session: SESSION })
    expect(await code(m.as.mutation(api.notifications.send, { text: 'Deploy?', buttons: [{ label: 'Yes', action: 'yes' }] }))).toBe('invalid')
    const { id } = await m.as.mutation(api.notifications.send, {
      text: 'Deploy?',
      slug: 'plan',
      buttons: [
        { label: 'Yes', action: 'yes' },
        { label: 'No', action: 'no' },
      ],
    })
    expect((await alice.browser.query(api.notifications.list, { key: displayKey('alice') }))[0]).toMatchObject({ text: 'Deploy?', slug: 'plan', seen: false })
    expect(await code(alice.browser.mutation(api.notifications.answer, { id, action: 'maybe', displayKey: displayKey('alice') }))).toBe('invalid')
    const first = await alice.browser.mutation(api.notifications.answer, { id, action: 'yes', displayKey: displayKey('alice') })
    const second = await alice.browser.mutation(api.notifications.answer, { id, action: 'no', displayKey: displayKey('alice') })
    expect(first.actionId).toBeTruthy()
    expect(second.actionId).toBeNull()
    expect((await inbox(m)).map((c) => [c.name, c.attended])).toEqual([['yes', true]])
  })

  test('a notification is not sent with a button named as what a person types above a page is, which pressing it could never send', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan', { session: SESSION })
    const send = (action: string) => code(m.as.mutation(api.notifications.send, { text: 'Reply?', slug: 'plan', buttons: [{ label: 'Reply', action }] }))
    expect(await send('it:message')).toBe('invalid')
    expect(await alice.browser.query(api.notifications.list, { key: displayKey('alice') })).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([])
    // A name that only begins as that one does is a page's own
    expect(await send('it:message.read')).toBe('ok')
  })

  test('opening or clearing the tray on one display leaves alone what is addressed to another', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const phoneKey = 'alice-phone-key-0001'
    const phone = await alice.browser.mutation(api.displays.register, { key: phoneKey, userAgent: 'iPhone Safari/605' })
    await alice.browser.mutation(api.displays.rename, { displayId: phone.id, name: 'Phone' })
    const forPhone = await m.as.mutation(api.notifications.send, { text: 'for the phone', display: 'phone' })
    const forAll = await m.as.mutation(api.notifications.send, { text: 'for everyone' })
    const unseenByAnyone = await m.as.mutation(api.notifications.send, { text: 'not shown yet' })
    const laptop = { key: displayKey('alice') }
    // The laptop's tray says what it was showing. Even if it names the phone's, only its own are marked.
    await alice.browser.mutation(api.notifications.seen, { ...laptop, ids: [forAll.id, forPhone.id] })
    await alice.browser.mutation(api.notifications.dismiss, { ...laptop, ids: [forAll.id, forPhone.id] })
    expect(await code(alice.browser.mutation(api.notifications.dismiss, { ...laptop, ids: [forPhone.id] }))).toBe('not_found')
    // What the tray had not shown is untouched
    expect(await alice.browser.query(api.notifications.list, laptop)).toMatchObject([{ id: unseenByAnyone.id, seen: false }])
    await alice.browser.mutation(api.notifications.dismiss, { ...laptop, ids: [unseenByAnyone.id] })
    expect(await alice.browser.query(api.notifications.list, { key: phoneKey })).toMatchObject([{ text: 'for the phone', seen: false }])
  })

  test('only a real push service is accepted as a subscription', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const sub = (endpoint: string) => code(alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint, p256dh: 'p', auth: 'a' }))
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://push.example/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'not a url',
    ])
      expect(await sub(bad)).toBe('invalid')
    for (const good of [
      PUSH('x'),
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-by3p.notify.windows.com/w/?token=x',
    ])
      expect(await sub(good)).toBe('ok')
  })

  test('a display that is not open is pushed to, once, and a dead subscription is forgotten', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const second = await alice.browser.mutation(api.displays.register, { key: 'alice-phone-key-0001', userAgent: 'iPhone Safari/605' })
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'p', auth: 'a' })
    await alice.browser.mutation(api.push.subscribe, { key: 'alice-phone-key-0001', endpoint: PUSH('gone'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const later = await m.as.mutation(api.notifications.send, { text: 'later' })
    expect(await t.action(internal.push.deliver, { notificationId: later.id })).toBe(1)
    // The second look, a few minutes on, does not push it a second time
    expect(await t.action(internal.push.deliver, { notificationId: later.id })).toBe(0)
    const displays = await alice.browser.query(api.displays.list, {})
    expect(displays.find((d) => d.id === second.id)?.push).toBe(false)
    expect(displays.find((d) => d.id === alice.display.id)?.push).toBe(true)
  })

  test('a push is asked of the service on this machine, with a token made for sending that one message and for nothing else', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'the-p256dh', auth: 'the-auth' })
    await vi.advanceTimersByTimeAsync(200_000)
    const about = await m.as.mutation(api.notifications.send, { text: 'x'.repeat(400), slug: 'plan' })
    const general = await m.as.mutation(api.notifications.send, { text: 'about no page in particular' })
    expect(await t.action(internal.push.deliver, { notificationId: about.id })).toBe(1)
    expect(await t.action(internal.push.deliver, { notificationId: general.id })).toBe(1)
    const [first, second] = sender.asked
    expect(first).toMatchObject({ subscription: { endpoint: PUSH('alive'), p256dh: 'the-p256dh', auth: 'the-auth' }, ttl: 3600 })
    // What the display is sent is a line of text and where to go, as a path: it opens that at whatever address it reaches the site by
    expect(JSON.parse(first!.payload)).toEqual({ title: 'It', body: 'x'.repeat(180), url: '/p/plan', id: about.id })
    expect(JSON.parse(second!.payload)).toMatchObject({ body: 'about no page in particular', url: '/' })
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(first!.token, jwks, { issuer: SITE, audience: 'it-push' })
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(first!.body))).toString('hex')
    expect(payload).toMatchObject({ sub: 'send', h: digest })
    expect(payload.exp! - payload.iat!).toBe(60)
    await expect(jwtVerify(first!.token, jwks, { issuer: SITE, audience: 'it-control' })).rejects.toThrow()
  })

  test('the key a browser subscribes with is the one the service sends with, and is only asked for on behalf of a paired browser', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    expect(await code(t.action(api.push.publicKey, {}))).toBe('unauthenticated')
    expect(sender.keyAsked).toHaveLength(0)
    expect(await alice.browser.action(api.push.publicKey, {})).toBe('the-key-a-browser-subscribes-with')
    const jwks = createLocalJWKSet(await (await t.fetch('/.well-known/jwks.json')).json())
    const { payload } = await jwtVerify(sender.keyAsked[0]!, jwks, { issuer: SITE, audience: 'it-push' })
    expect([payload.sub, payload.exp! - payload.iat!]).toEqual(['key', 60])
    // The service does not answer: the browser is told to try again, and is given nothing in a key's place
    sender.down = true
    expect(await code(alice.browser.action(api.push.publicKey, {}))).toBe('unavailable')
    sender.down = false
    // Ten a minute, and no more
    const results = []
    for (let i = 0; i < 10; i++) results.push(await code(alice.browser.action(api.push.publicKey, {})))
    expect([results.filter((r) => r === 'ok').length, results.at(-1)]).toEqual([8, 'rate_limited'])
  })

  test('a subscription is forgotten when the push service says it is gone or was made for another key, and never because the sending failed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const n = await m.as.mutation(api.notifications.send, { text: 'hello' })
    const subscribed = async () => (await alice.browser.query(api.displays.list, {}))[0]!.push
    // The service cannot be asked, and then the push service is in trouble: nothing was sent, and the subscription stays
    sender.down = true
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(0)
    sender.down = false
    sender.answers = () => 503
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(0)
    expect(await subscribed()).toBe(true)
    // It was not counted as pushed either, so the next look sends it
    sender.answers = () => undefined
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(1)
    // The push service says the subscription was made for another key: it is no use any more
    const next = await m.as.mutation(api.notifications.send, { text: 'again' })
    sender.answers = () => 403
    expect(await t.action(internal.push.deliver, { notificationId: next.id })).toBe(0)
    expect(await subscribed()).toBe(false)
  })

  test('a display that was open a moment ago and has since closed is pushed to on the second look, unless someone saw it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'p', auth: 'a' })
    await m.as.mutation(api.notifications.send, { text: 'nobody saw this' })
    await t.finishInProgressScheduledFunctions()
    // The display said it was open a moment ago, so nothing is pushed yet
    expect(sender.asked).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(181_000)
    await t.finishInProgressScheduledFunctions()
    expect(sender.asked).toHaveLength(1)
    expect(sender.asked[0]!.payload).toContain('nobody saw this')
    // Had it been seen in the tray meanwhile, nothing is pushed
    await alice.browser.mutation(api.displays.heartbeat, { key: displayKey('alice') })
    await m.as.mutation(api.notifications.send, { text: 'seen in time' })
    const shown = await alice.browser.query(api.notifications.list, { key: displayKey('alice') })
    await alice.browser.mutation(api.notifications.seen, { key: displayKey('alice'), ids: shown.map((n) => n.id) })
    await vi.advanceTimersByTimeAsync(181_000)
    await t.finishInProgressScheduledFunctions()
    expect(sender.asked).toHaveLength(1)
  })

  test('signing out stops pushes to that browser, and a browser’s subscription belongs to one display at a time', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('shared-browser'), p256dh: 'p', auth: 'a' })
    // The same browser is paired for Bob, who turns notifications on: it stops being Alice's
    await bob.browser.mutation(api.push.subscribe, { key: displayKey('bob'), endpoint: PUSH('shared-browser'), p256dh: 'p', auth: 'a' })
    expect((await alice.browser.query(api.displays.list, {}))[0]!.push).toBe(false)
    expect((await bob.browser.query(api.displays.list, {}))[0]!.push).toBe(true)
    await bob.browser.mutation(api.displays.signOut, { key: displayKey('bob') })
    expect((await bob.browser.query(api.displays.list, {}))[0]!.push).toBe(false)
  })
})

describe('leaving', () => {
  test('an export includes every retained deletion receipt, with cleanup timestamps, only for its owner', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const screen = await paired(t, 'alice', 'screen', 'export-screen-key-001')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    const { job } = await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    const start = await alice.browser.mutation(api.account.exportStart, {})
    expect(start.pages).toEqual([])
    const original = (await t.run((ctx) => ctx.db.get(job)))!
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert('deletions', {
          userId: alice.user,
          artifactId: p.artifactId,
          slug: `gone-${i}`,
          title: `Gone ${i}`,
          requestedAt: 1000 + i,
          attempts: i % 3,
          ...(i % 3 === 1 ? { failedAt: 2000 + i, nextAt: 3000 + i } : {}),
          ...(i % 3 === 2 ? { contentAt: 2000 + i, recordsAt: 3000 + i, completedAt: 3000 + i } : {}),
        })
      }
      await ctx.db.insert('deletions', { userId: bob.user, artifactId: p.artifactId, slug: 'private', title: 'Another person', requestedAt: 1000, attempts: 0 })
    })
    const all = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const batch: FunctionReturnType<typeof api.account.exportDeletions> = await alice.browser.query(api.account.exportDeletions, {
        owner: start.owner,
        cursor,
      })
      all.push(...batch.deletions)
      if (batch.next === null) break
      cursor = batch.next
    }
    expect(all).toHaveLength(231)
    expect(all[0]).toEqual({
      job,
      artifactId: p.artifactId,
      slug: 'plan',
      title: original.title,
      requestedAt: original.requestedAt,
      state: 'pending',
      attempts: 0,
      contentAt: null,
      recordsAt: null,
      completedAt: null,
      failedAt: null,
      nextAt: null,
    })
    expect(all.find((d) => d.slug === 'gone-1')).toMatchObject({ state: 'retrying', failedAt: 2001, nextAt: 3001 })
    expect(all.find((d) => d.slug === 'gone-2')).toMatchObject({ state: 'completed', contentAt: 2002, recordsAt: 3002, completedAt: 3002 })
    expect(all.some((d) => d.slug === 'private')).toBe(false)
    expect(await code(bob.browser.query(api.account.exportDeletions, { owner: start.owner, cursor: null }))).toBe('not_found')
    expect(await code(screen.browser.query(api.account.exportDeletions, { owner: start.owner, cursor: null }))).toBe('forbidden')
    expect(await code(m.as.query(api.account.exportDeletions, { owner: start.owner, cursor: null }))).toBe('forbidden')
  })

  test("an export holds the person's pages, state and history in pieces, and is rate limited", async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: '{"status":"draft"}', session: SESSION })
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(p.artifactId))!
      for (let i = 0; i < 230; i++)
        await ctx.db.insert('actions', {
          userId: a.userId,
          title: a.title,
          artifactId: a._id,
          clientActionId: `c-${String(i).padStart(5, '0')}`,
          name: 'press',
          payload: '{}',
          contentVersion: 1,
          createdAt: 1000 + i,
          delivery: 'handed_off',
        })
    })
    const start = await alice.browser.mutation(api.account.exportStart, {})
    expect(start.pages).toEqual([p.artifactId])
    expect(JSON.stringify(start)).not.toContain('publicKey')
    // Attempts that were begun and never finished do not push the published version out of the export
    for (let i = 0; i < 20; i++) {
      await m.as.action(api.publish.begin, { slug: 'plan', title: 'unfinished', files: page })
      await vi.advanceTimersByTimeAsync(2500)
    }
    expect((await alice.browser.query(api.account.exportPage, { artifactId: p.artifactId })).versions.map((x) => [x.n, x.status])).toEqual([[1, 'live']])
    expect(await alice.browser.query(api.account.exportPage, { artifactId: p.artifactId })).toMatchObject({
      slug: 'plan',
      state: '{"status":"draft"}',
      versions: [{ n: 1, status: 'live' }],
    })
    // Every action, however many, a batch at a time
    let cursor: string | null = null
    let total = 0
    for (let i = 0; i < 10; i++) {
      const batch: { actions: unknown[]; next: string | null } = await alice.browser.query(api.account.exportActions, { artifactId: p.artifactId, cursor })
      total += batch.actions.length
      if (batch.next === null) break
      cursor = batch.next
    }
    expect(total).toBe(230)
    // Two a minute, and no more
    await alice.browser.mutation(api.account.exportStart, {})
    await alice.browser.mutation(api.account.exportStart, {})
    expect(await code(alice.browser.mutation(api.account.exportStart, {}))).toBe('rate_limited')
  })

  test('erasing everything ends access at once and removes every record, bytes included, the person’s own record last', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const m = await machineOf(t, 'alice')
    const bm = await machineOf(t, 'bob')
    const p = await publish(m, 'plan', { state: '{"a":1}' })
    await m.as.action(api.publish.begin, { slug: 'plan', title: 'never finished', files: page })
    await publish(bm, 'bobs')
    await alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0001') })
    await m.as.mutation(api.notifications.send, { text: 'hi' })
    await alice.browser.mutation(api.displays.register, { key: 'alice-second-key-001', userAgent: 'x' })
    await paired(t, 'alice', 'screen', 'alice-screen-key-001')
    const invited = await m.as.mutation(api.sessions.inviteOwner, {})
    await alice.browser.mutation(api.sessions.inviteScreen, {})
    const count = () =>
      t.run(async (ctx) => {
        const out: Record<string, number> = {}
        const tables = ['users', 'displays', 'machines', 'sessions', 'invites', 'artifacts', 'versions', 'states', 'actions', 'notifications', 'contentJobs']
        for (const table of tables as 'users'[]) out[table] = (await ctx.db.query(table).collect()).length
        return out
      })
    // The content service is unreachable when the files are to be deleted: the person's record waits for it
    content.failNext = 50
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    expect([await alive(alice.browser), await alive(m.as)]).toEqual([false, false])
    // And nothing new is let in for it while it is going: no machine, and no browser with a code made before
    expect(await t.mutation(internal.bridge.enroll, { subject: subjectOf('alice'), name: 'late', publicKey: KEY })).toEqual({ error: 'deleted' })
    expect((await redeem(t, invited.code)).status).toBe(401)
    await t.finishInProgressScheduledFunctions()
    await vi.advanceTimersByTimeAsync(1000)
    await t.finishInProgressScheduledFunctions()
    expect((await count()).users).toBe(2)
    content.failNext = 0
    await settle(t)
    expect(await count()).toEqual({
      users: 1,
      displays: 1,
      machines: 1,
      sessions: 1,
      invites: 0,
      artifacts: 1,
      versions: 1,
      states: 0,
      actions: 0,
      notifications: 0,
      contentJobs: 0,
    })
    expect(content.calls.some((c) => c.op === 'delete' && /^u\/[^/]+\/$/.test(c.body.prefix))).toBe(true)
    expect(content.calls.filter((c) => c.op === 'revoke').some((c) => c.body.epoch >= 1_000_000)).toBe(true)
    expect((await bob.browser.query(api.artifacts.list, {})).map((a) => a.slug)).toEqual(['bobs'])
  })

  test('once everything is erased, no record in any table names the person, a browser, a machine, a display or a page of theirs', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const m = await machineOf(t, 'alice')
    const bm = await machineOf(t, 'bob')
    const p = await publish(m, 'plan', { state: '{"a":1}' })
    await publish(bm, 'bobs')
    const screen = await paired(t, 'alice', 'screen', 'alice-screen-key-001')
    // A showing, a click, what a page keeps for itself, a notification, a code, and a proof a machine has used
    const showing = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    await alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0001') })
    await screen.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value: '1' })
    await m.as.mutation(api.notifications.send, { text: 'hi' })
    await alice.browser.mutation(api.sessions.inviteScreen, {})
    await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'a-proof-number-0001', issuedAt: Math.floor(Date.now() / 1000) })
    await t.mutation(internal.bridge.spend, { machineId: bm.id, jti: 'a-proof-number-0002', issuedAt: Math.floor(Date.now() / 1000) })
    // And a limit the person reached, which is written down by a job of the backend's
    await alice.browser.mutation(api.account.exportStart, {})
    await alice.browser.mutation(api.account.exportStart, {})
    // Everything of theirs that has an id
    const theirs = await t.run(async (ctx) => {
      const ids: string[] = [alice.user]
      for (const table of ['sessions', 'machines', 'displays', 'artifacts'] as const)
        for (const row of await ctx.db.query(table).collect()) if (row.userId === alice.user) ids.push(row._id)
      return ids
    })
    expect(theirs.length).toBe(7)
    const tables = Object.keys(schema.tables) as (keyof typeof schema.tables)[]
    /** For each table, how many of its records name one of those ids anywhere in them. */
    const naming = () =>
      t.run(async (ctx) => {
        const out: Record<string, number> = {}
        for (const table of tables) {
          const n = (await ctx.db.query(table).collect()).filter((row) => theirs.some((id) => JSON.stringify(row).includes(id))).length
          if (n) out[table] = n
        }
        return out
      })
    // Before: there is something of theirs in every table that holds anything of a person
    const before = await naming()
    for (const table of ['mounts', 'rateLimits', 'spentProofs', 'actions', 'states', 'notifications', 'invites', 'tallies'])
      expect([table, before[table] ?? 0]).toEqual([table, expect.any(Number)])
    expect([before.mounts, before.spentProofs, (before.rateLimits ?? 0) > 3]).toEqual([1, 1, true])
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    await settle(t)
    // After: nothing, in any table, though no hourly cleaning has run
    expect(await naming()).toEqual({})
    expect(await t.run((ctx) => ctx.db.get(alice.user as never))).toBeNull()
    // Nor was any job the backend ran started with the person's id, or with a browser's: the
    // backend program keeps what each job was started with for days after it has run
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(jobs.map((j) => j.name)).toEqual(expect.arrayContaining(['retention:purgeErased', 'logs:limitReached', 'content:run']))
    const whose = [alice.user, alice.session, screen.session]
    expect(jobs.filter((j) => whose.some((id) => JSON.stringify(j.args).includes(id))).map((j) => j.name)).toEqual([])
    // Another person's are as they were: their showing would be, and their machine's proof is
    expect((await t.run((ctx) => ctx.db.query('spentProofs').collect())).map((x) => x.key)).toEqual([`${bm.id}:a-proof-number-0002`])
    expect((await t.run((ctx) => ctx.db.query('rateLimits').collect())).some((x) => x.who === bob.user)).toBe(true)
    expect(showing.mountId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('a machine is kept until the last of the proofs it used has gone, however many there are', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    await person(t, 'bob')
    const m = await machineOf(t, 'alice')
    const bm = await machineOf(t, 'bob')
    // One spent as a machine spends it, and then as many more, kept the same way, as it takes several runs to remove
    const issuedAt = Math.floor(Date.now() / 1000)
    await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'a-proof-number-0000', issuedAt })
    await t.mutation(internal.bridge.spend, { machineId: bm.id, jti: 'a-proof-number-0000', issuedAt })
    await t.run(async (ctx) => {
      const [spent] = await ctx.db.query('spentProofs').collect()
      expect(spent!.key).toBe(`${m.id}:a-proof-number-0000`)
      for (let n = 1; n <= 450; n++)
        await ctx.db.insert('spentProofs', { key: `${m.id}:a-proof-number-${String(n).padStart(4, '0')}`, expiresAt: spent!.expiresAt })
    })
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    await settle(t)
    expect(await t.run((ctx) => ctx.db.get(m.id as never))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(alice.user as never))).toBeNull()
    // Every one of them went with the machine, and nobody else's did
    expect((await t.run((ctx) => ctx.db.query('spentProofs').collect())).map((x) => x.key)).toEqual([`${bm.id}:a-proof-number-0000`])
  })

  test('when the person’s own record goes, nothing still waiting to be asked of the content service names them', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const m = await machineOf(t, 'alice')
    const bm = await machineOf(t, 'bob')
    await publish(m, 'plan')
    await publish(m, 'gone')
    await publish(bm, 'bobs')
    // A page deleted a moment before, whose files are looked for again once an upload could no
    // more land, and a display whose signing out the content service has yet to hear of
    await m.as.mutation(api.artifacts.remove, { slug: 'gone' })
    await bm.as.mutation(api.artifacts.remove, { slug: 'bobs' })
    await runWhatIsDue(t)
    const waiting = async () => (await t.run((ctx) => ctx.db.query('contentJobs').collect())).map((j) => [j.op, j.body.includes(alice.user)])
    expect(await waiting()).toEqual([
      ['delete', true],
      ['delete', false],
    ])
    // And more signings out than one run lets go of, each put off as one is that the content service has not answered
    await t.run(async (ctx) => {
      const [job] = await ctx.db.query('contentJobs').collect()
      for (let n = 0; n < 250; n++) {
        const body = JSON.stringify({ userId: alice.user, displayId: alice.display.id, epoch: n + 2 })
        await ctx.db.insert('contentJobs', { op: 'revoke', body, attempts: 3, nextAt: Date.now() + 3_600_000, createdAt: Date.now(), userId: job!.userId })
      }
      expect(job!.userId).toBe(alice.user)
    })
    const before = content.calls.length
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    // Only what is due now is run, a millisecond at a time: the clock never reaches the moment anything was put off until
    for (let i = 0; i < 400 && (await t.run((ctx) => ctx.db.get(alice.user as never))); i++) {
      await vi.advanceTimersByTimeAsync(1)
      await t.finishInProgressScheduledFunctions()
    }
    expect(await t.run((ctx) => ctx.db.get(alice.user as never))).toBeNull()
    expect(content.calls.slice(before).some((c) => c.op === 'delete' && c.body.prefix === `u/${alice.user}/`)).toBe(true)
    // No table holds the person's id by then, and what waits for another person is as it was
    const naming = await t.run(async (ctx) => {
      const out: string[] = []
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[])
        if ((await ctx.db.query(table).collect()).some((row) => JSON.stringify(row).includes(alice.user))) out.push(table)
      return out
    })
    expect(naming).toEqual([])
    expect(await waiting()).toEqual([['delete', false]])
    // And nothing more is asked of the content service for them, however long after
    const asked = content.calls.length
    await settle(t)
    expect(content.calls.slice(asked).filter((c) => JSON.stringify(c.body).includes(alice.user))).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
    void bob
  })

  test('what was counted under a page’s id goes with the last of what hung off the page, however the page came to be removed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    /** The counts kept under an id, by the limit each is for. */
    const countedUnder = async (id: string) =>
      (await t.run((ctx) => ctx.db.query('rateLimits').collect())).filter((row) => row.who === id).map((row) => row.key.split(':')[0])
    // A page with a state it started with, a click and something it stored for itself: each is counted under the page's own id
    const removed = await publish(m, 'removed', { state: '{"a":1}' })
    await alice.browser.mutation(api.actions.submit, { artifactId: removed.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0001') })
    await alice.browser.mutation(api.state.storeSet, { artifactId: removed.artifactId, key: 'k', value: '1' })
    expect((await countedUnder(removed.artifactId)).sort()).toEqual(['stateKilobytesPage', 'storeKilobytesPage', 'storeSetPage', 'submitActionPage'])
    // And a first publish that is given up on, whose page record goes with it
    const abandoned = await m.as.action(api.publish.begin, { slug: 'abandoned', title: 'Never finished', files: page, state: '{"b":2}' })
    expect(await countedUnder(abandoned.artifactId)).toEqual(['stateKilobytesPage'])
    await m.as.mutation(api.artifacts.remove, { slug: 'removed' })
    await m.as.mutation(api.publish.abandon, { artifactId: abandoned.artifactId, version: abandoned.version })
    await runWhatIsDue(t)
    await runWhatIsDue(t)
    expect([await countedUnder(removed.artifactId), await countedUnder(abandoned.artifactId)]).toEqual([[], []])
    // So an erasing that follows finds nothing of either page to leave behind, though their records had gone before it began
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    await settle(t)
    const naming = await t.run(async (ctx) => {
      const out: string[] = []
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[])
        for (const row of await ctx.db.query(table).collect())
          if ([removed.artifactId, abandoned.artifactId, alice.user].some((id) => JSON.stringify(row).includes(id))) out.push(table)
      return out
    })
    expect(naming).toEqual([])
  })

  test('a machine that asks for a token after its record has gone is counted nowhere, and one that is revoked and still there is held to its pace', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const other = await machineOf(t, 'alice', 'desktop')
    const counted = async (id: string) => (await t.run((ctx) => ctx.db.query('rateLimits').collect())).filter((row) => row.who === id).length
    const issuedAt = () => Math.floor(Date.now() / 1000)
    // Revoked, and its record is kept: it is told so, and what it asks is counted, so that it is written down no faster than its pace
    await alice.browser.mutation(api.machines.revoke, { machineId: other.id as never })
    expect(await t.mutation(internal.bridge.spend, { machineId: other.id, jti: 'a-proof-number-0001', issuedAt: issuedAt() })).toBe('revoked')
    expect(await counted(other.id)).toBe(1)
    // The route has read the machine and is checking its proof when everything is erased
    expect(await t.query(internal.bridge.machine, { id: m.id })).not.toBeNull()
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    await settle(t)
    expect(await t.run((ctx) => ctx.db.get(m.id as never))).toBeNull()
    // The proof was good, and is spent against a machine that is not there: refused, and nothing is written under its id
    expect(await t.mutation(internal.bridge.spend, { machineId: m.id, jti: 'a-proof-number-0002', issuedAt: issuedAt() })).toBe('revoked')
    expect([await counted(m.id), await counted(other.id)]).toEqual([0, 0])
    expect(await t.run((ctx) => ctx.db.query('spentProofs').collect())).toEqual([])
  })

  test('an erasing that stopped part of the way is started again, and its files are never given up on', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    // The deletion was asked for, and the run that should have carried it out never happened
    await t.run(async (ctx) => {
      const user = (await ctx.db.query('users').collect())[0]!
      await ctx.db.patch(user._id, { deletedAt: Date.now() - 2 * 3_600_000 })
    })
    // The content service stays unreachable far longer than the usual number of tries covers,
    // for the deleting of the files and for the signing out of the display alike
    content.failNext = 120
    expect(await t.mutation(internal.retention.resumeDeletions, {})).toBe(1)
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'delete' && /^u\/[^/]+\/$/.test(c.body.prefix)).length).toBeGreaterThan(60)
    expect(await t.run(async (ctx) => [(await ctx.db.query('users').collect()).length, (await ctx.db.query('artifacts').collect()).length])).toEqual([0, 0])
    void alice
  })

  test('everything is erased all the same for a person with a page that was never finished publishing', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await m.as.action(api.publish.begin, { title: 'A first publish, never finished', files: page })
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    await settle(t)
    expect(
      await t.run(async (ctx) => [
        (await ctx.db.query('users').collect()).length,
        (await ctx.db.query('artifacts').collect()).length,
        (await ctx.db.query('versions').collect()).length,
      ]),
    ).toEqual([0, 0, 0])
  })

  test('deletion receipts distinguish requested, failed and confirmed cleanup without treating a missing receipt as success', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const screen = await browserOf(t, 'alice', 'screen')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    content.failNext = 1
    const { job } = await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    expect(await m.as.query(api.deletions.get, { job })).toMatchObject({ state: 'pending', completedAt: null })
    expect(await code(screen.browser.query(api.deletions.get, { job }))).toBe('forbidden')
    expect(await code(screen.browser.query(api.deletions.list, {}))).toBe('forbidden')
    expect(await code(bob.browser.query(api.deletions.get, { job }))).toBe('not_found')
    for (let i = 0; i < 4; i++) await runWhatIsDue(t)
    expect(await alice.browser.query(api.deletions.get, { job })).toMatchObject({
      state: 'retrying',
      attempts: 1,
      nextAt: Date.now() + 5000,
      completedAt: null,
    })
    // A restart loses an action in progress. Its durable job is restarted by the periodic sweep.
    vi.clearAllTimers()
    vi.setSystemTime(Date.now() + 3 * 60_000)
    expect(await t.mutation(internal.content.kick, {})).toBe(1)
    for (let i = 0; i < 4; i++) await runWhatIsDue(t)
    expect(await m.as.query(api.deletions.get, { job })).toMatchObject({ state: 'completed', completedAt: Date.now() })
    expect(await alice.browser.query(api.deletions.list, {})).toHaveLength(1)
    // Reusing a page name neither completes nor deletes a new incarnation of that page.
    await publish(m, 'plan')
    expect(await m.as.query(api.deletions.get, { slug: 'plan' })).toMatchObject({ job, state: 'completed' })
    expect(await m.as.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ slug: 'plan' })
    await t.run((ctx) => ctx.db.delete(job))
    expect(await code(m.as.query(api.deletions.get, { job }))).toBe('not_found')
  })

  test('content confirmation alone does not complete a deletion whose records remain', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    const { job } = await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    vi.clearAllTimers()
    const contentJob = await t.run((ctx) =>
      ctx.db
        .query('contentJobs')
        .filter((q) => q.eq(q.field('deletionId'), job))
        .first(),
    )
    await t.action(internal.content.run, { jobId: contentJob!._id })
    expect(await m.as.query(api.deletions.get, { job })).toMatchObject({ state: 'pending', completedAt: null })
    const receipt = await t.run((ctx) => ctx.db.get(job))
    await t.mutation(internal.retention.purgeArtifact, { artifactId: receipt!.artifactId, deletionId: job })
    expect(await m.as.query(api.deletions.get, { job })).toMatchObject({ state: 'completed' })
  })

  test('completed deletion receipts expire after a week, while unfinished ones stay until erasure', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'finished')
    const done = await m.as.mutation(api.artifacts.remove, { slug: 'finished' })
    await settle(t)
    await publish(m, 'waiting')
    const pending = await m.as.mutation(api.artifacts.remove, { slug: 'waiting' })
    vi.clearAllTimers()
    vi.setSystemTime(Date.now() + 8 * 86_400_000)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.get(done.job))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(pending.job))).not.toBeNull()
    await t.run((ctx) => ctx.db.patch(alice.user as never, { deletedAt: Date.now() }))
    await t.mutation(internal.retention.purgeErased, {})
    await settle(t)
    expect(await t.run((ctx) => ctx.db.query('deletions').collect())).toEqual([])
  })

  test('an answer from the content service that cannot be read is not taken for "done"', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    content.garbleNext = 2
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    await settle(t)
    // Twice unreadable, then a proper answer, and the later look: four askings, and nothing left to do
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(4)
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
  })

  test('a deletion the content service could only do part of is carried on until it is all gone', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    content.moreNext = 3
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    await settle(t)
    // Three times told there was more, a fourth that finished it, and the look twenty minutes
    // later that catches anything an upload already under way wrote meanwhile
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(5)
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
  })

  test('a deletion that is told there is more, and that nothing was removed, is not asked for again at once: it waits as one that failed does', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'plan')
    content.stuckNext = 3
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    for (let i = 0; i < 4; i++) await runWhatIsDue(t)
    // Asked once. Carried on at once, as a deletion that removed something is, it would be asked without end and without a pause where a folder cannot be removed
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(1)
    const [job] = (await t.run((ctx) => ctx.db.query('contentJobs').collect())).sort((a, b) => a.nextAt - b.nextAt)
    expect([job!.attempts, job!.nextAt - Date.now()]).toEqual([1, 5000])
    await settle(t)
    // Three times that got nowhere, each after a longer wait, the one that finished it, and the look twenty minutes later
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(5)
    expect(await t.run((ctx) => ctx.db.query('contentJobs').collect())).toEqual([])
  })

  test('deleting a page removes what hung off it, and gives back what it counted for', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: '{"a":1}' })
    await m.as.action(api.publish.begin, { slug: 'plan', title: 'never finished', files: page })
    await alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope('click-0001') })
    await m.as.mutation(api.artifacts.remove, { slug: 'plan' })
    await settle(t)
    expect(
      await t.run(async (ctx) => [
        (await ctx.db.query('versions').collect()).length,
        (await ctx.db.query('states').collect()).length,
        (await ctx.db.query('actions').collect()).length,
      ]),
    ).toEqual([0, 0, 0])
    expect(await totals(t)).toEqual({ waiting: 0, stagingCount: 0, stagingBytes: 0 })
    expect(content.calls.filter((c) => c.op === 'delete').at(-1)?.body.prefix).toMatch(/^u\/[^/]+\/[^/]+\/$/)
  })
})

describe('cases at the edges', () => {
  const insertClicks = (t: T, artifactId: string, n: number, over: Record<string, unknown> = {}, at = Date.now()) =>
    t.run(async (ctx) => {
      const a = (await ctx.db.get(artifactId as never)) as any
      const ids: string[] = []
      for (let i = 0; i < n; i++)
        ids.push(
          await ctx.db.insert('actions', {
            userId: a.userId,
            title: a.title,
            artifactId: a._id,
            clientActionId: `made-${Math.random().toString(36).slice(2)}-${i}`,
            name: `press-${i}`,
            payload: '{}',
            contentVersion: 1,
            createdAt: at + i,
            delivery: 'pending',
            machineId: a.machineId,
            harness: a.session?.harness,
            sessionId: a.session?.id,
            ...over,
          } as never),
        )
      return ids
    })

  test('inbox discovery reaches a middle conversation while twelve earlier names stay pending', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const now = Date.now()
    for (let i = 0; i < 12; i++) {
      const p = await publish(m, `busy-${i}`, { session: { harness: 'codex', id: `a-${String(i).padStart(2, '0')}` } })
      await insertClicks(t, p.artifactId, 4, {}, now - 1000)
      await insertClicks(t, p.artifactId, 2, {}, now + 1000)
    }
    const p = await publish(m, 'middle', { session: { harness: 'codex', id: 'z-middle' } })
    const [wanted] = await insertClicks(t, p.artifactId, 1, {}, now)
    const found = new Map<string, number>()
    let after: { harness: string; id: string }[] = []
    for (let cycle = 0; cycle < 4; cycle++) {
      const page = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['codex'], after })
      after = page.after
      for (const c of page.clicks) found.set(c.id, (found.get(c.id) ?? 0) + 1)
      if (cycle === 0) expect(after).toEqual([{ harness: 'codex', id: 'a-11' }])
    }
    expect(found.get(wanted!)).toBe(2)
    expect(after).toEqual([{ harness: 'codex', id: '' }])
  })

  test('an attended click behind eight timer clicks has a place in the first reopening batch', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION })
    await t.run((ctx) => ctx.db.patch(m.id, { wanted: ['claude-code'], harnesses: [{ id: 'claude-code', addon: 'connected' }] }))
    await alice.browser.mutation(api.machines.wake, { machineId: m.id, harness: 'claude-code', on: true })
    const timers = await insertClicks(t, p.artifactId, 8, { attended: false }, Date.now() - 1000)
    const [attended] = await insertClicks(t, p.artifactId, 1, { attended: true })
    const { clicks } = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['claude-code'], after: [] })
    expect(clicks.map((c) => c.id)).toEqual([...timers.slice(0, 7), attended])
    expect(await m.as.mutation(api.delivery.claim, { ids: clicks.map((c) => c.id), for: SESSION })).toEqual(clicks.map((c) => c.id))
    expect((await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['claude-code'], after: [] })).clicks.map((c) => c.id)).toEqual([timers[7]])
  })

  test('a deleted cursor and new earlier conversations do not reset discovery before it rolls over', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const made: { harness: string; id: string }[] = []
    for (let n = 0; n < 26; n++) {
      const of = { harness: 'codex', id: `thread-${String(n).padStart(2, '0')}` }
      const p = await publish(m, `page-${n}`, { session: of })
      await insertClicks(t, p.artifactId, 2)
      made.push(of)
    }
    const first = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['codex'], after: [] })
    expect(first.after).toEqual([{ harness: 'codex', id: 'thread-11' }])
    await m.as.mutation(api.artifacts.remove, { slug: 'page-11' })
    const early = await publish(m, 'new-early', { session: { harness: 'codex', id: 'a-new' } })
    await insertClicks(t, early.artifactId, 1)
    const second = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['codex'], after: first.after })
    expect(second.clicks.map((c) => c.session)).toEqual(made.slice(12, 24).flatMap((s) => [s, s]))
    const third = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['codex'], after: second.after })
    expect(third.clicks.map((c) => c.session)).toEqual(made.slice(24).flatMap((s) => [s, s]))
    expect(third.after).toEqual([{ harness: 'codex', id: '' }])
    const rolled = await m.as.query(api.delivery.inboxPage, { listening: [], queues: ['codex'], after: third.after })
    expect(rolled.clicks[0]?.artifact).toBe('new-early')
  })

  test.each([true, undefined])('attended discovery finds both stored forms beyond timer clicks and respects stops, attended: %s', async (attended) => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const now = Date.now()
    const p = await publish(m, 'plan', { session: SESSION })
    await t.run((ctx) =>
      ctx.db.patch(m.id, { wakes: [{ harness: SESSION.harness, since: now }], stops: [{ harness: SESSION.harness, sessionId: SESSION.id, at: now - 100 }] }),
    )
    await insertClicks(t, p.artifactId, 1, { attended }, now - 101)
    const timers = await insertClicks(t, p.artifactId, 80, { attended: false }, now)
    const [attendedId] = await insertClicks(t, p.artifactId, 1, { attended }, now + 100)
    const answer = await m.as.query(api.delivery.inboxPage, { listening: [], queues: [SESSION.harness], after: [] })
    expect(answer.clicks.map((c) => c.id)).toEqual([...timers.slice(0, 7), attendedId])
  })

  test('a queue with large old clicks still offers a recent conversation in its original order on every asking', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const queues = ['codex', 'claude-code', 'pi', 'opencode', 'hermes']
    const now = Date.now()
    const payload = JSON.stringify({ text: 'x'.repeat(LIMITS.actionPayloadBytes - 11) })
    expect(new TextEncoder().encode(payload).length).toBe(LIMITS.actionPayloadBytes)
    await t.run(async (ctx) => {
      await ctx.db.patch(m.id, { wakes: queues.slice(1).map((harness) => ({ harness, since: now - 10_000 })), wakesOff: ['codex'] })
    })
    const put = async (id: string, count: number, at: number) => {
      const p = await publish(m, id, { session: { harness: 'codex', id } })
      return insertClicks(t, p.artifactId, count, { payload }, at)
    }
    await put('b-closed', 40, now - 3000)
    const recent = await put('c-deliverable', 20, now - 100)
    for (let i = 0; i < 12; i++) await put(`a-middle-${i}`, 1, now - 1500)
    const ask = () => inbox(m, [], queues)
    const first = await ask()
    expect(first.filter((c) => c.session?.id === 'c-deliverable').map((c) => c.id)).toEqual(recent.slice(0, 2))
    expect((await ask()).map((c) => c.id)).toEqual(first.map((c) => c.id))
    const pending = await t.run((ctx) => ctx.db.query('actions').collect())
    for (const id of new Set(first.map((c) => c.session?.id))) {
      const returned = first.filter((c) => c.session?.id === id)
      expect(returned.map((c) => c.id)).toEqual(
        pending
          .filter((c) => c.sessionId === id)
          .slice(0, returned.length)
          .map((c) => c._id),
      )
    }
  })

  test('every conversation a connector may name is looked at, not only the first twenty', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const sessions = Array.from({ length: 40 }, (_, i) => ({ harness: 'claude-code', id: `sess-${String(i).padStart(2, '0')}` }))
    const last = await publish(m, 'last', { session: sessions[39] })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: last.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    expect((await inbox(m, sessions)).map((c) => c.id)).toEqual([actionId])
  })

  test('a harness’s own queue is offered the oldest clicks of each conversation, however many one of them has', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: { harness: 'codex', id: 'thread-1' } })
    const ids = await insertClicks(t, p.artifactId, 25)
    const other = await publish(m, 'other', { session: { harness: 'codex', id: 'thread-2' } })
    const late = await insertClicks(t, other.artifactId, 2, {}, Date.now() + 60_000)
    // Three hundred clicks for a conversation that takes none would not change this either
    expect((await inbox(m, [], ['codex'])).map((c) => c.id)).toEqual([...ids.slice(0, 2), ...late])
  })

  test('setting a click aside does not take it from another machine that holds it now', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice')
    const server = await machineOf(t, 'alice', 'server')
    const p = await publish(laptop, 'plan', { session: { harness: 'codex', id: 'thread-1' } })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    // The laptop's lease runs out while its command is still running, and the server takes the click
    await laptop.as.mutation(api.delivery.claim, { ids: [actionId] })
    await vi.advanceTimersByTimeAsync(LEASE_MS + 1000)
    await t.mutation(internal.delivery.reap, {})
    expect(await server.as.mutation(api.delivery.claim, { ids: [actionId] })).toEqual([actionId])
    // It says so, so that the laptop asks again later and does not take the click for set aside
    expect(await laptop.as.mutation(api.delivery.park, { id: actionId })).toBe(false)
    expect(await t.run((ctx) => ctx.db.get(actionId))).toMatchObject({ delivery: 'leased', leaseMachineId: server.id, machineId: laptop.id })
    // Once nobody holds it, it can be set aside
    await server.as.mutation(api.delivery.release, { id: actionId })
    expect(await laptop.as.mutation(api.delivery.park, { id: actionId })).toBe(true)
    expect((await t.run((ctx) => ctx.db.get(actionId)))?.machineId).toBeUndefined()
  })

  test('a connector about to deliver into a conversation cannot take a click that has since gone to another', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice')
    const server = await machineOf(t, 'alice', 'server')
    const p = await publish(laptop, 'plan', { session: { harness: 'codex', id: 'thread-1' } })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    // The page is taken over while the click stands in the laptop's own line for Codex
    await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-9' }, take: true })
    await settle(t)
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [actionId], for: { harness: 'codex', id: 'thread-1' } })).toEqual([])
    expect(await server.as.mutation(api.delivery.claim, { ids: [actionId], for: { harness: 'codex', id: 'thread-1' } })).toEqual([])
    expect(await server.as.mutation(api.delivery.claim, { ids: [actionId], for: { harness: 'codex', id: 'thread-9' } })).toEqual([actionId])
  })

  test('a conversation waiting for its own clicks is not held up by any number of clicks for others', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const mine = await publish(m, 'mine', { session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: mine.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    const other = await publish(m, 'other', { session: { harness: 'claude-code', id: 'sess-2' } })
    await insertClicks(t, other.artifactId, 60, {}, Date.now() + 1000)
    expect((await m.as.query(api.delivery.allWaiting, {})).some((c) => c.id === actionId)).toBe(false)
    expect((await m.as.query(api.delivery.waitingFor, { session: SESSION })).map((c) => c.id)).toEqual([actionId])
  })

  test('nor by any number waiting for a conversation of the same name on another of the person’s machines, which are that machine’s to take', async () => {
    const t = backend()
    await person(t, 'alice')
    const desk = await machineOf(t, 'alice', 'desk')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const theirs = await publish(desk, 'theirs', { session: SESSION })
    const mine = await publish(laptop, 'mine', { session: SESSION })
    const now = Date.now()
    // Fifty that are older, on the desk's page, and the desk is asleep
    await insertClicks(t, theirs.artifactId, 50, {}, now - 60_000)
    const [here] = await insertClicks(t, mine.artifactId, 1, {}, now)
    const waiting = async () => (await laptop.as.query(api.delivery.waitingFor, { session: SESSION })).map((c) => c.id)
    expect(await waiting()).toEqual([here])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [here as never], for: SESSION })).toEqual([here])
    await laptop.as.mutation(api.delivery.release, { id: here as never })
    // What this machine set aside waits for it still, and so does what is addressed to no machine: oldest first, whichever of the three it is
    const [aside] = await insertClicks(t, mine.artifactId, 1, { machineId: undefined, parkedBy: laptop.id }, now - 2000)
    const [loose] = await insertClicks(t, mine.artifactId, 1, { machineId: undefined }, now - 1000)
    expect(await waiting()).toEqual([aside, loose, here])
    // The desk's own waiter has the desk's, and no more than one asking gives
    expect((await desk.as.query(api.delivery.waitingFor, { session: SESSION })).length).toBe(50)
  })

  test('more than a batch of expired leases is put back in one go', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION })
    await insertClicks(t, p.artifactId, 130, { delivery: 'leased', leaseMachineId: m.id, leaseExpiresAt: Date.now() + 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    await t.mutation(internal.delivery.reap, {})
    await settle(t)
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.delivery === 'pending').length).toBe(130)
  })

  test('a click that waited a week and was then handed over is kept a week from the hand-over', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    await vi.advanceTimersByTimeAsync(8 * 86_400_000)
    await m.as.mutation(api.delivery.handedOff, { id: actionId, route: 'manual' })
    await vi.advanceTimersByTimeAsync(86_400_000)
    await t.mutation(internal.retention.sweepActions, {})
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).length).toBe(1)
    await vi.advanceTimersByTimeAsync(7 * 86_400_000)
    await t.mutation(internal.retention.sweepActions, {})
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).length).toBe(0)
  })

  test.each([60, 450])('deleting a page clears its %s notices so an older live notice can be shown and dismissed', async (count) => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const live = await publish(m, 'live')
    const dead = await publish(m, 'dead')
    const kept = await m.as.mutation(api.notifications.send, { text: 'Still useful', slug: 'live' })
    await t.run(async (ctx) => {
      const page = (await ctx.db.get(dead.artifactId))!
      for (let i = 0; i < count; i++) {
        await ctx.db.insert('notifications', { userId: page.userId, artifactId: dead.artifactId, text: 'Gone', sticky: false, createdAt: Date.now() + i + 1 })
      }
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('notifications', {
          userId: page.userId,
          text: 'Dismissed',
          sticky: false,
          createdAt: Date.now() + count + i + 1,
          dismissedAt: Date.now(),
        })
      }
    })
    await alice.browser.mutation(api.artifacts.remove, { artifactId: dead.artifactId })
    await settle(t)
    const listed = await alice.browser.query(api.notifications.list, { key: displayKey('alice') })
    expect(listed.map((n) => n.id)).toEqual([kept.id])
    expect(await t.run(async (ctx) => (await ctx.db.query('notifications').collect()).filter((n) => n.artifactId === dead.artifactId))).toEqual([])
    expect(await t.run((ctx) => ctx.db.get(live.artifactId))).not.toBeNull()
    await alice.browser.mutation(api.notifications.dismiss, { key: displayKey('alice'), ids: [kept.id] })
    expect(await alice.browser.query(api.notifications.list, { key: displayKey('alice') })).toEqual([])
  })

  test('a deleted page cannot be pushed while its old notices wait beyond the immediate cleanup batch', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const dead = await publish(m, 'dead')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const notices = await t.run(async (ctx) => {
      const p = (await ctx.db.get(dead.artifactId))!
      const ids = []
      for (let i = 0; i < 601; i++)
        ids.push(await ctx.db.insert('notifications', { userId: p.userId, artifactId: p._id, text: 'Gone', sticky: false, createdAt: Date.now() + i }))
      return ids
    })
    const newest = notices.at(-1)!
    const oldest = notices[0]!
    const still = (notificationId: typeof oldest) => t.query(internal.push._still, { notificationId, displayId: alice.display.id, endpoint: PUSH('phone') })
    for (const notificationId of [oldest, newest]) {
      expect((await t.query(internal.push._targets, { notificationId }))?.url).toBe('/p/dead')
      expect(await still(notificationId)).toBe(true)
    }
    await alice.browser.mutation(api.artifacts.remove, { artifactId: dead.artifactId })
    // Timers have not advanced. The oldest notice is still stored and was not dismissed by the immediate batch.
    expect((await t.run((ctx) => ctx.db.get(oldest)))?.dismissedAt).toBeUndefined()
    expect((await t.run((ctx) => ctx.db.get(newest)))?.dismissedAt).toBe(Date.now())
    for (const notificationId of [oldest, newest]) {
      expect(await t.query(internal.push._targets, { notificationId })).toBeNull()
      expect(await still(notificationId)).toBe(false)
      expect(await t.action(internal.push.deliver, { notificationId })).toBe(0)
    }
    expect(sender.asked).toHaveLength(0)
    const independent = await m.as.mutation(api.notifications.send, { text: 'Still useful' })
    expect((await t.query(internal.push._targets, { notificationId: independent.id }))?.url).toBe('/')
    expect(await still(independent.id)).toBe(true)
    await settle(t)
    expect(await t.run((ctx) => ctx.db.get(oldest))).toBeNull()
  })

  test('a page deleted during push delivery is not sent to the remaining displays before its older notices are purged', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    const phoneKey = 'alice-phone-key-0001'
    await alice.browser.mutation(api.displays.register, { key: phoneKey, userAgent: 'Phone' })
    for (const key of [displayKey('alice'), phoneKey]) await alice.browser.mutation(api.push.subscribe, { key, endpoint: PUSH(key), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const notificationId = await t.run(async (ctx) => {
      const userId = (await ctx.db.get(p.artifactId))!.userId
      const n = await ctx.db.insert('notifications', { userId, artifactId: p.artifactId, text: 'Old', sticky: false, createdAt: Date.now() })
      for (let i = 0; i < 301; i++)
        await ctx.db.insert('notifications', { userId, artifactId: p.artifactId, text: 'Newer', sticky: false, createdAt: Date.now() + i + 1 })
      return n
    })
    expect((await t.query(internal.push._targets, { notificationId }))?.targets).toHaveLength(2)
    sender.whileSending = async () => {
      await alice.browser.mutation(api.artifacts.remove, { artifactId: p.artifactId })
    }
    expect(await t.action(internal.push.deliver, { notificationId })).toBe(1)
    expect(sender.asked).toHaveLength(1)
    expect((await t.run((ctx) => ctx.db.get(notificationId)))?.dismissedAt).toBeUndefined()
    await settle(t)
  })

  test('a tray holds what is for its display, however much is addressed elsewhere or was dismissed since', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const phoneKey = 'alice-phone-key-0001'
    const phone = await alice.browser.mutation(api.displays.register, { key: phoneKey, userAgent: 'iPhone Safari/605' })
    const old = await m.as.mutation(api.notifications.send, { text: 'an old one for the laptop' })
    await vi.advanceTimersByTimeAsync(1000)
    const user = (await t.run((ctx) => ctx.db.query('users').collect()))[0]!
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++)
        await ctx.db.insert('notifications', {
          userId: user._id,
          text: `for the phone ${i}`,
          displayId: phone.id as never,
          sticky: false,
          createdAt: Date.now() + i,
        })
      for (let i = 0; i < 250; i++)
        await ctx.db.insert('notifications', {
          userId: user._id,
          text: `gone ${i}`,
          sticky: false,
          createdAt: Date.now() + 1000 + i,
          dismissedAt: Date.now() + 2000,
        })
    })
    expect((await alice.browser.query(api.notifications.list, { key: displayKey('alice') })).map((n) => n.id)).toEqual([old.id])
    // The phone's own tray holds its newest sixty, newest first, with the one for every display behind them
    const onPhone = await alice.browser.query(api.notifications.list, { key: phoneKey })
    expect([onPhone.length, onPhone[0]?.text, onPhone.some((n) => n.id === old.id)]).toEqual([60, 'for the phone 249', false])
  })

  test('nothing is pushed to a display forgotten while the push was on its way, and a refused subscription takes only itself', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const phoneKey = 'alice-phone-key-0001'
    const phone = (await paired(t, 'alice', 'screen', phoneKey, 'iPhone Safari/605')).display
    await alice.browser.mutation(api.push.subscribe, { key: phoneKey, endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const n = await m.as.mutation(api.notifications.send, { text: 'private' })
    const still = () => t.query(internal.push._still, { notificationId: n.id, displayId: phone.id, endpoint: PUSH('phone') })
    expect(await still()).toBe(true)
    // The push service refuses the old subscription after the browser has made a new one: the new one stays
    await alice.browser.mutation(api.push.subscribe, { key: phoneKey, endpoint: PUSH('phone-2'), p256dh: 'p', auth: 'a' })
    expect(await still()).toBe(false)
    await t.mutation(internal.push._pushed, { notificationId: n.id, sent: [], gone: [{ displayId: phone.id, endpoint: PUSH('phone') }] })
    expect((await alice.browser.query(api.displays.list, {})).find((d) => d.id === phone.id)?.push).toBe(true)
    // Forgotten while a send to another display was under way: this one is not sent to any more
    await alice.browser.mutation(api.displays.forget, { displayId: phone.id })
    expect(await t.query(internal.push._still, { notificationId: n.id, displayId: phone.id, endpoint: PUSH('phone-2') })).toBe(false)
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(0)
    expect(sender.asked).toHaveLength(0)
  })

  test('a machine that gives up on a publish gets its share of the quota back at once, and what reached storage is removed', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begun = await m.as.action(api.publish.begin, { title: 'Upload will fail', files: page })
    expect(await totals(t)).toMatchObject({ stagingCount: 1, stagingBytes: 100 })
    await m.as.mutation(api.publish.abandon, { artifactId: begun.artifactId, version: begun.version })
    expect(await totals(t)).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
    expect(await t.run(async (ctx) => [(await ctx.db.query('artifacts').collect()).length, (await ctx.db.query('versions').collect()).length])).toEqual([0, 0])
    // Removed now, and again once the upload grant has run out
    expect((await t.run((ctx) => ctx.db.query('contentJobs').collect())).map((j) => j.op)).toEqual(['delete', 'delete'])
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'delete').map((c) => c.body.prefix)).toEqual([expect.stringMatching(/\/1\/$/), expect.stringMatching(/\/1\/$/)])
    // A live version cannot be abandoned, and neither can someone else's
    const live = await publish(m, 'plan')
    await m.as.mutation(api.publish.abandon, { artifactId: live.artifactId, version: live.version })
    expect((await t.run((ctx) => ctx.db.query('artifacts').collect())).map((a) => a.currentVersion)).toEqual([1])
    await person(t, 'bob')
    const bobs = await machineOf(t, 'bob')
    await m.as.action(api.publish.begin, { slug: 'plan', title: 'second', files: page })
    await bobs.as.mutation(api.publish.abandon, { artifactId: live.artifactId, version: 2 })
    expect(await totals(t)).toMatchObject({ stagingCount: 1 })
    // A page deleted and made again under the same name is another page: giving up on a
    // publish of the first does not touch the second
    const first = await m.as.action(api.publish.begin, { slug: 'reused', title: 'first', files: page })
    await m.as.mutation(api.publish.abandon, { artifactId: first.artifactId, version: first.version })
    const second = await m.as.action(api.publish.begin, { slug: 'reused', title: 'second', files: page })
    await m.as.mutation(api.publish.abandon, { artifactId: first.artifactId, version: first.version })
    expect(await t.run((ctx) => ctx.db.get(second.artifactId))).not.toBeNull()
  })

  test('a publish that could not be prepared has its folder emptied, in case the declaration was stored all the same', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    content.stageOk = false
    expect(await code(m.as.action(api.publish.begin, { title: 'New page', files: page }))).toBe('unavailable')
    await settle(t)
    expect(content.calls.filter((c) => c.op === 'delete').length).toBe(2)
  })

  test('a click on a page that never went live is given back to the person’s count when the page is cleared away', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const begun = await m.as.action(api.publish.begin, { slug: 'plan', title: 'Never finished', files: page })
    const sent = await m.as.mutation(api.notifications.send, { text: 'Approve?', slug: 'plan', buttons: [{ label: 'Yes', action: 'yes' }] })
    await alice.browser.mutation(api.notifications.answer, { id: sent.id, action: 'yes', displayKey: displayKey('alice') })
    expect(await totals(t)).toMatchObject({ waiting: 1 })
    await m.as.mutation(api.publish.abandon, { artifactId: begun.artifactId, version: begun.version })
    await settle(t)
    expect(await totals(t)).toMatchObject({ waiting: 0 })
    expect(await t.run(async (ctx) => (await ctx.db.query('actions').collect()).length)).toBe(0)
  })

  test('state is limited by how much is written as well as how often, for a page and for an agent', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan')
    const big = JSON.stringify({ blob: 'x'.repeat(500 * 1024) })
    const results = []
    for (let i = 0; i < 20; i++) results.push(await code(m.as.mutation(api.state.patch, { slug: 'plan', patch: big, replace: true })))
    // Sixteen writes of half a megabyte fit in one page's allowance; the next is told to wait
    expect([results.filter((r) => r === 'ok').length, results.at(-1)]).toEqual([16, 'rate_limited'])
    // A page's own store takes values of modest size only
    const set = (value: string) => code(alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value }))
    expect(await set(JSON.stringify('y'.repeat(LIMITS.storeValueBytes)))).toBe('limit')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(await set('"small"')).toBe('ok')
  })

  test('a sign-out token that could not be dealt with is answered as trouble, not as a bad token', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const { token } = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
    const present = () => t.fetch('/display/signout', { method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } })
    // The backend's key cannot be read: the browser must keep its token and come back
    const [key] = await t.run((ctx) => ctx.db.query('signingKeys').collect())
    await t.run((ctx) => ctx.db.patch(key!._id, { publicJwk: null }))
    expect((await present()).status).toBe(503)
    expect(((await t.run((ctx) => ctx.db.get(alice.display.id as never))) as any).epoch).toBe(0)
    // When it can be read again, the same token does what it is for
    await t.run((ctx) => ctx.db.patch(key!._id, { publicJwk: key!.publicJwk }))
    expect((await present()).status).toBe(200)
    expect(((await t.run((ctx) => ctx.db.get(alice.display.id as never))) as any).epoch).toBe(1)
  })

  test('the site can tell a sign-out the content service has confirmed from one it has only been promised', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    content.failNext = 1
    const { job } = await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    expect(await alice.browser.query(api.displays.signOutConfirmed, { job })).toBe(false)
    await t.finishInProgressScheduledFunctions()
    // The content service refused the first time: still only promised
    expect(await alice.browser.query(api.displays.signOutConfirmed, { job })).toBe(false)
    await settle(t)
    expect(await alice.browser.query(api.displays.signOutConfirmed, { job })).toBe(true)
    // Nobody else learns anything from a job's id
    content.failNext = 5
    const again = await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    expect(await bob.browser.query(api.displays.signOutConfirmed, { job: again.job })).toBe(true)
    expect(await alice.browser.query(api.displays.signOutConfirmed, { job: again.job })).toBe(false)
  })

  test('an export asks for the pieces that belong to no one page by whose export it is, and lists every machine', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    const user = (await t.run((ctx) => ctx.db.query('users').collect()))[0]!
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++)
        await ctx.db.insert('machines', {
          userId: user._id,
          name: `old ${i}`,
          publicKey: KEY,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          revoked: true,
          revokedAt: Date.now(),
        } as never)
    })
    const start = await alice.browser.mutation(api.account.exportStart, {})
    let cursor: string | null = null
    let total = 0
    for (let i = 0; i < 10; i++) {
      const batch: { machines: unknown[]; next: string | null } = await alice.browser.query(api.account.exportMachines, { owner: start.owner, cursor })
      total += batch.machines.length
      if (batch.next === null) break
      cursor = batch.next
    }
    expect(total).toBe(230)
    // The same browser has been paired for someone else since: nothing of theirs is handed to this export
    expect(await code(bob.browser.query(api.account.exportNotifications, { owner: start.owner, cursor: null }))).toBe('not_found')
    expect(await code(bob.browser.query(api.account.exportMachines, { owner: start.owner, cursor: null }))).toBe('not_found')
  })

  test('every person whose erasing stood still gets a turn, however many there are', async () => {
    const t = backend()
    await t.run(async (ctx) => {
      for (let i = 0; i < 45; i++) await ctx.db.insert('users', { subject: `user_gone_${i}`, createdAt: Date.now(), deletedAt: Date.now() } as never)
    })
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)
    await t.mutation(internal.retention.resumeDeletions, {})
    await settle(t)
    expect((await t.run((ctx) => ctx.db.query('users').collect())).length).toBe(0)
    // One last job each, asked once, however often the purge ran
    expect(content.calls.filter((c) => c.op === 'delete' && /^u\/[^/]+\/$/.test(c.body.prefix)).length).toBe(45)
  })

  test('deleting pages is rate limited', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < 70; i++) {
      await publish(m, `page-${i}`)
      await vi.advanceTimersByTimeAsync(2500)
    }
    const results = []
    for (let i = 0; i < 70; i++) results.push(await code(m.as.mutation(api.artifacts.remove, { slug: `page-${i}` })))
    expect([results.filter((r) => r === 'ok').length, results.at(-1)]).toEqual([60, 'rate_limited'])
  })

  test('more unfinished publishes than one batch are all cleared', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < 25; i++) await m.as.action(api.publish.begin, { slug: `page-${i}`, title: 'Never finished', files: page })
    expect(await totals(t)).toMatchObject({ stagingCount: 25 })
    await vi.advanceTimersByTimeAsync(3_700_000)
    await t.mutation(internal.retention.sweepStaging, {})
    await settle(t)
    expect(await t.run(async (ctx) => [(await ctx.db.query('artifacts').collect()).length, (await ctx.db.query('versions').collect()).length])).toEqual([0, 0])
    expect(await totals(t)).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
  })

  test('the moment a page is taken over, its old conversation cannot claim a click on it any more, even before the click is addressed afresh', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice')
    const server = await machineOf(t, 'alice', 'server')
    const old = { harness: 'codex', id: 'thread-1' }
    const next = { harness: 'codex', id: 'thread-9' }
    const p = await publish(laptop, 'plan', { session: old })
    const submit = (id: string) =>
      alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope(id) })
    const first = await submit('click-0001')
    const second = await submit('click-0002')
    // The laptop is in the middle of its last try at the second click when the page changes hands
    await laptop.as.mutation(api.delivery.claim, { ids: [second.actionId], for: old })
    const begun = await server.as.action(api.publish.begin, { slug: 'plan', title: 'x', files: page, session: next, take: true })
    await server.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })
    // Nothing scheduled has run yet: the first click still carries its old address
    expect((await t.run((ctx) => ctx.db.get(first.actionId)))?.sessionId).toBe('thread-1')
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [first.actionId], for: old })).toEqual([])
    expect(await server.as.mutation(api.delivery.claim, { ids: [first.actionId], for: next })).toEqual([first.actionId])
    // The laptop's try fails and it sets the click aside: it goes to the page's new owner instead
    await settle(t)
    await laptop.as.mutation(api.delivery.park, { id: second.actionId })
    expect(await t.run((ctx) => ctx.db.get(second.actionId))).toMatchObject({ delivery: 'pending', machineId: server.id, sessionId: 'thread-9' })
    expect((await inbox(server, [], ['codex'])).map((c) => c.id)).toEqual([second.actionId])
  })

  test('nothing is pushed for a person once everything of theirs is being erased', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const n = await m.as.mutation(api.notifications.send, { text: 'private' })
    await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
    expect(await t.query(internal.push._targets, { notificationId: n.id })).toBeNull()
    expect(await t.query(internal.push._still, { notificationId: n.id, displayId: alice.display.id, endpoint: PUSH('alive') })).toBe(false)
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(0)
    expect(sender.asked).toHaveLength(0)
  })

  test('the state a page is first published with is counted by size like any other write of it', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const big = JSON.stringify({ blob: 'x'.repeat(500 * 1024) })
    // Ten writes of half a megabyte to one page use up five of the person's sixteen megabytes
    await publish(m, 'plan')
    for (let i = 0; i < 10; i++) await m.as.mutation(api.state.patch, { slug: 'plan', patch: big, replace: true })
    const results = []
    for (let i = 0; i < 26; i++) {
      const r = await m.as.action(api.publish.begin, { slug: `draft-${i}`, title: 'Never finished', files: page, state: big }).then(
        (b) => m.as.mutation(api.publish.abandon, { artifactId: b.artifactId, version: b.version }).then(() => 'ok'),
        (e) => refusalCode(e),
      )
      results.push(r)
    }
    // Twenty-two more half-megabyte states fit in what is left, though each draft was given up at once
    expect([results.filter((r) => r === 'ok').length, results.at(-1)]).toEqual([22, 'rate_limited'])
  })

  test('the backend makes its signing key the first time one is needed, keeps it, and gives out only its public half', async () => {
    const t = backend()
    const keys = async (of: T) => ((await (await of.fetch('/.well-known/jwks.json')).json()) as { keys: Record<string, string>[] }).keys
    expect(await t.run((ctx) => ctx.db.query('signingKeys').collect())).toEqual([])
    const first = await keys(t)
    expect(first.length).toBe(1)
    expect(Object.keys(first[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'])
    // Everything it signs from then on is signed with that key, under its name
    const alice = await person(t, 'alice')
    const { token } = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid).toBe(first[0]!.kid)
    expect(await keys(t)).toEqual(first)
    // Two requests that each find no key yet end up with the same one
    const other = backend()
    const [a, b] = await Promise.all([keys(other), keys(other)])
    expect(a).toEqual(b)
    expect((await other.run((ctx) => ctx.db.query('signingKeys').collect())).length).toBe(1)
  })

  test('a mount made before a sign-out gets no ticket after it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const p = await publish(await machineOf(t, 'alice'), 'plan')
    const before = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    expect(await code(alice.browser.action(api.mounts.ticket, { mountId: before.mountId }))).toBe('conflict')
    // One made after it is as good as ever, and carries the new number
    const after = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    const { ticket } = await alice.browser.action(api.mounts.ticket, { mountId: after.mountId })
    expect(JSON.parse(Buffer.from(ticket.split('.')[1]!, 'base64url').toString()).e).toBe(1)
  })

  test('the site is told the number its sign-out token raises the display to, and the number the display is at', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const kept = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
    expect([kept.raisesTo, (await alice.browser.query(api.displays.mine, { key: displayKey('alice') }))?.epoch]).toEqual([1, 0])
    // Once the display is there, by whatever route, the kept token is spent: the site can see that
    await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    expect((await alice.browser.query(api.displays.mine, { key: displayKey('alice') }))?.epoch).toBe(1)
  })

  test('after a computer is enrolled again, clicks on its earlier pages still reach the conversation that is listening there', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const p = await publish(first, 'plan', { session: SESSION })
    // The computer is enrolled again: the old machine is withdrawn and the computer gets a new identity
    await alice.browser.mutation(api.machines.revoke, { machineId: first.id })
    const again = await machineOf(t, 'alice', 'laptop again')
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    expect((await inbox(again)).map((c) => c.id)).toEqual([actionId])
    expect(await again.as.mutation(api.delivery.claim, { ids: [actionId], for: SESSION })).toEqual([actionId])
    // A conversation that is not listening there is offered nothing
    await again.as.mutation(api.delivery.release, { id: actionId })
    expect(await inbox(again, [{ harness: 'claude-code', id: 'another' }])).toEqual([])
  })

  test('an erasing is for the person who asked for it, and for nobody the browser was paired for afterwards', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const bob = await person(t, 'bob')
    // Alice confirmed; by the time the request is sent, that browser is paired for Bob
    expect(await code(bob.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user }))).toBe('conflict')
    expect((await t.run((ctx) => ctx.db.query('users').collect())).every((u) => !u.deletedAt)).toBe(true)
  })

  test('one box ticked and another, in quick succession, are both kept', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await Promise.all([
      alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'claude-code', on: true }),
      alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'codex', on: true }),
    ])
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'pi', on: true })
    await alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'pi', on: false })
    expect((await m.as.query(api.machines.me, {})).wanted.sort()).toEqual(['claude-code', 'codex'])
    expect(await code(alice.browser.mutation(api.machines.toggle, { machineId: m.id, harness: 'emacs', on: true }))).toBe('invalid')
  })

  test('a page saving for itself on every keystroke uses up what pages may write, and nothing of what its agent may', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { state: JSON.stringify({ blob: 'x'.repeat(400 * 1024) }) })
    const results = []
    for (let i = 0; i < 30; i++)
      results.push(await code(alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'draft', value: `"${i}"` })))
    expect(results.at(-1)).toBe('rate_limited')
    expect(await code(m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"status":"still writable"}' }))).toBe('ok')
  })

  test('a display forgotten while a push to another display is on its way is not sent to', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const phoneKey = 'alice-phone-key-0001'
    const phone = (await paired(t, 'alice', 'screen', phoneKey, 'iPhone Safari/605')).display
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('laptop'), p256dh: 'p', auth: 'a' })
    await alice.browser.mutation(api.push.subscribe, { key: phoneKey, endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const n = await m.as.mutation(api.notifications.send, { text: 'private' })
    // Both displays are closed, so both are to be pushed to. While the first send is under
    // way, the person forgets the other display.
    sender.whileSending = async (endpoint) => {
      const other = endpoint === PUSH('phone') ? alice.display.id : phone.id
      if (sender.asked.length === 1) await alice.browser.mutation(api.displays.forget, { displayId: other as never })
    }
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(1)
    expect(sender.asked).toHaveLength(1)
  })

  test('a person with as many displays as there may be lets go of one nobody named or subscribed that is closed, and keeps the ones they set up', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    await alice.browser.mutation(api.displays.rename, { displayId: alice.display.id as never, name: 'Kitchen TV' })
    const register = (i: number) => alice.browser.mutation(api.displays.register, { key: `alice-extra-key-${String(i).padStart(4, '0')}`, userAgent: 'x' })
    const phone = await register(1)
    await alice.browser.mutation(api.push.subscribe, { key: 'alice-extra-key-0001', endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(7000)
    const passing = await register(2)
    for (let i = 3; i < QUOTA.displays; i++) {
      await vi.advanceTimersByTimeAsync(7000)
      await register(i)
    }
    expect(await code(register(100))).toBe('limit')
    // A little later, a private window that has since been closed makes room
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await code(register(101))).toBe('ok')
    const ids = (await alice.browser.query(api.displays.list, {})).map((d) => d.id)
    expect([ids.length, ids.includes(passing.id), ids.includes(alice.display.id), ids.includes(phone.id)]).toEqual([QUOTA.displays, false, true, true])
    // The browser that was let go can tell that from having been forgotten, and comes back by registering again
    expect(await alice.browser.query(api.displays.wasForgotten, { key: 'alice-extra-key-0002' })).toBe(false)
    const elsewhere = await browserOf(t, 'alice', 'owner')
    await elsewhere.browser.mutation(api.displays.forget, { displayId: phone.id as never })
    expect(await elsewhere.browser.query(api.displays.wasForgotten, { key: 'alice-extra-key-0001' })).toBe(true)
  })

  test('a computer that is enrolled again keeps its pages: clicks already waiting, later ones, and Codex threads that are not open', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const thread = { harness: 'codex', id: 'thread-1' }
    const p = await publish(first, 'plan', { session: thread })
    const submit = (id: string) =>
      alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope(id) })
    // Pressed while the conversation was closed, and still waiting for the old identity
    const early = await submit('click-0001')
    // The computer is enrolled again: the old identity is given up, and the new one names it
    await first.as.mutation(api.machines.leave, {})
    const again = await machineOf(t, 'alice', 'laptop again', first.id)
    await settle(t)
    const late = await submit('click-0002')
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(again.id)
    // Codex is not open: its own queue is still offered both, oldest first
    expect((await inbox(again, [], ['codex'])).map((c) => c.id)).toEqual([early.actionId, late.actionId])
    expect(await again.as.mutation(api.delivery.claim, { ids: [early.actionId], for: thread })).toEqual([early.actionId])
    // Somebody else's old identity cannot be named, and neither can one that is still in use
    const bob = await person(t, 'bob')
    void bob
    const bobs = await machineOf(t, 'bob', 'bobs', again.id)
    const other = await machineOf(t, 'alice', 'server', again.id)
    await settle(t)
    expect((await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId).toBe(again.id)
    void bobs
    void other
  })

  test('a computer that enrols again as an identity that has already been replaced takes nothing from the identity that stands in its place, until the person revokes that one', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const thread = { harness: 'codex', id: 'thread-1' }
    const p = await publish(first, 'plan', { session: thread })
    const submit = (id: string) =>
      alice.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('alice'), envelope: envelope(id) })
    const machine = (id: string) => t.run((ctx) => ctx.db.get(id as never) as Promise<{ replaces?: string; replacedBy?: string; revoked: boolean } | null>)
    const pageIsWith = async () => (await t.run((ctx) => ctx.db.get(p.artifactId)))?.machineId
    // It left and joined again, and its pages went to the identity it has now
    await first.as.mutation(api.machines.leave, {})
    const second = await machineOf(t, 'alice', 'laptop', first.id)
    await second.as.mutation(api.machines.choose, { harnesses: ['codex'], system: 'linux' })
    await alice.browser.mutation(api.machines.wake, { machineId: second.id, harness: 'codex', on: false })
    await settle(t)
    expect(await pageIsWith()).toBe(second.id)
    // A copy of its folder from before then is put back, which holds the first identity and not the key of the second: it joins as the first once more
    const third = await machineOf(t, 'alice', 'laptop', first.id)
    await settle(t)
    // The second is still one of the person's machines, and nothing shows that it is not in use: its pages are its own, and its place is not given away
    expect(await pageIsWith()).toBe(second.id)
    expect((await machine(first.id))?.replacedBy).toBe(second.id)
    expect((await machine(second.id))?.revoked).toBe(false)
    const early = await submit('click-0001')
    expect((await inbox(third, [], ['codex'])).map((c) => c.id)).toEqual([])
    // What the person switched off for that computer is off for this identity of it too
    expect(await third.as.mutation(api.machines.choose, { harnesses: ['codex'], system: 'linux' })).toEqual({ wakes: [] })
    // The person revokes the one whose key is lost, and the computer that asked for its place has it, with its pages and what waits on them
    await alice.browser.mutation(api.machines.revoke, { machineId: second.id })
    await settle(t)
    expect(await pageIsWith()).toBe(third.id)
    expect((await machine(second.id))?.replacedBy).toBe(third.id)
    const late = await submit('click-0002')
    expect((await inbox(third, [], ['codex'])).map((c) => c.id)).toEqual([early.actionId, late.actionId])
    // Whoever enrols a machine that has to wait so is told the name of the machine it waits for, to say so to the person
    const waiting = await t.mutation(internal.bridge.enroll, {
      subject: subjectOf('alice'),
      name: 'laptop',
      publicKey: { ...KEY, x: 'put-back' },
      replaces: first.id,
    })
    expect(waiting).toMatchObject({ waitsFor: 'laptop' })
    expect(await pageIsWith()).toBe(third.id)
    // And where the identity that stands in its place was given up too, the one that names the first has that one's place at once
    await alice.browser.mutation(api.machines.revoke, { machineId: 'machineId' in waiting ? waiting.machineId : third.id })
    await third.as.mutation(api.machines.leave, {})
    const fifth = await machineOf(t, 'alice', 'laptop', first.id)
    await settle(t)
    expect(await pageIsWith()).toBe(fifth.id)
    expect((await machine(third.id))?.replacedBy).toBe(fifth.id)
  })

  test('clicks waiting for a machine that was revoked can be taken by a conversation listening on another of the person’s machines', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const p = await publish(first, 'plan', { session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    await alice.browser.mutation(api.machines.revoke, { machineId: first.id })
    await settle(t)
    const other = await machineOf(t, 'alice', 'server')
    expect((await t.run((ctx) => ctx.db.get(actionId)))?.machineId).toBeUndefined()
    expect((await inbox(other)).map((c) => c.id)).toEqual([actionId])
  })

  test('a click that was set aside stays set aside while its conversation is listening, until its page changes hands', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice')
    const server = await machineOf(t, 'alice', 'server')
    const thread = { harness: 'codex', id: 'thread-1' }
    const p = await publish(laptop, 'plan', { session: thread })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    expect(await laptop.as.mutation(api.delivery.park, { id: actionId })).toBe(true)
    // The thread is running hooks, so the connector names it as listening: still not offered
    expect(await inbox(laptop, [thread], ['codex'])).toEqual([])
    expect((await laptop.as.query(api.delivery.waiting, { slug: 'plan' })).map((c) => c.id)).toEqual([actionId])
    // Borrowed by a waiter that then gives it back: set aside as before
    await laptop.as.mutation(api.delivery.claim, { ids: [actionId] })
    await laptop.as.mutation(api.delivery.release, { id: actionId })
    expect(await inbox(laptop, [thread], ['codex'])).toEqual([])
    // Another conversation on the same machine takes the page over: the click is its to try
    const next = { harness: 'codex', id: 'thread-9' }
    await publish(laptop, 'plan', { session: next, take: true })
    await settle(t)
    expect((await inbox(laptop, [], ['codex'])).map((c) => [c.id, c.session?.id])).toEqual([[actionId, 'thread-9']])
    // Set aside there too, and then taken over from another machine: again the new owner's to try
    expect(await laptop.as.mutation(api.delivery.park, { id: actionId, for: next })).toBe(true)
    expect(await inbox(laptop, [next], ['codex'])).toEqual([])
    await publish(server, 'plan', { session: { harness: 'codex', id: 'thread-s' }, take: true })
    await settle(t)
    expect((await inbox(server, [], ['codex'])).map((c) => c.id)).toEqual([actionId])
  })

  test('a machine that asks to be enrolled a second time with the same key is the same machine', async () => {
    const t = backend()
    await person(t, 'alice')
    const key = { ...KEY, x: 'the-same-key' }
    const first = await t.mutation(internal.bridge.enroll, { subject: 'user_alice', name: 'laptop', publicKey: key })
    // The answer was lost on its way back, and the machine asks again
    const second = await t.mutation(internal.bridge.enroll, { subject: 'user_alice', name: 'laptop', publicKey: key })
    expect(second).toEqual(first)
    expect((await t.run((ctx) => ctx.db.query('machines').collect())).length).toBe(1)
  })

  test('a late request to set a click aside does nothing once the click belongs to another conversation on the same machine', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const old = { harness: 'codex', id: 'thread-1' }
    const next = { harness: 'codex', id: 'thread-9' }
    const p = await publish(m, 'plan', { session: old })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    await publish(m, 'plan', { session: next, take: true })
    await settle(t)
    // The request to set it aside was made for the old conversation, and arrives only now
    expect(await m.as.mutation(api.delivery.park, { id: actionId, for: old })).toBe(true)
    expect((await inbox(m, [], ['codex'])).map((c) => [c.id, c.session?.id])).toEqual([[actionId, 'thread-9']])
  })

  test('a conversation that takes nothing has everything waiting for it set aside at once, and thirty such conversations hide nobody', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const dead = await publish(m, 'dead', { session: { harness: 'codex', id: 'a-dead-thread' } })
    const ids = await insertClicks(t, dead.artifactId, 180)
    await m.as.mutation(api.delivery.park, { id: ids[0] as never, for: { harness: 'codex', id: 'a-dead-thread' }, all: true })
    await settle(t)
    expect(await inbox(m, [], ['codex'])).toEqual([])
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.parkedBy === m.id).length).toBe(180)
    expect((await m.as.query(api.delivery.waiting, { slug: 'dead' })).length).toBe(50)
    // Thirty conversations whose names sort first, each with clicks older than the live one's
    for (let i = 0; i < 30; i++) {
      const gone = await publish(m, `gone-${i}`, { session: { harness: 'codex', id: `a-gone-${String(i).padStart(2, '0')}` } })
      await insertClicks(t, gone.artifactId, 4, {}, Date.now() - 100_000)
      await vi.advanceTimersByTimeAsync(2500)
    }
    const live = await publish(m, 'live', { session: { harness: 'codex', id: 'z-live-thread' } })
    // Pressed just now: newer than everything waiting for the conversations that take nothing
    const [mine] = await insertClicks(t, live.artifactId, 1, {}, Date.now())
    expect((await inbox(m, [], ['codex'])).some((c) => c.id === mine)).toBe(true)
  })

  test('every listening conversation keeps its place however much is waiting for a harness’s own queue', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    for (let i = 0; i < 12; i++) {
      const q = await publish(m, `queued-${i}`, { session: { harness: 'codex', id: `thread-${String(i).padStart(2, '0')}` } })
      await insertClicks(t, q.artifactId, 10)
      await vi.advanceTimersByTimeAsync(2500)
    }
    const sessions = Array.from({ length: 40 }, (_, i) => ({ harness: 'claude-code', id: `sess-${String(i).padStart(2, '0')}` }))
    const last = await publish(m, 'last', { session: sessions[39] })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: last.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001'),
    })
    const offered = await inbox(m, sessions, ['codex'])
    expect(offered.some((c) => c.id === actionId)).toBe(true)
    expect(offered.filter((c) => c.session?.harness === 'codex').length).toBe(24)
  })

  test('a click made on a display whose record has been let go is still the person’s click', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { session: SESSION })
    // The tab was asleep while its display made room for another; what was clicked there is sent when it wakes
    const sent = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: 'a-display-that-was-let-go-01',
      envelope: envelope('click-0001'),
    })
    expect((await inbox(m)).map((c) => c.id)).toEqual([sent.actionId])
    // It is still only ever the person's own page
    const bob = await person(t, 'bob')
    expect(
      await code(bob.browser.mutation(api.actions.submit, { artifactId: p.artifactId, displayKey: displayKey('bob'), envelope: envelope('click-0002') })),
    ).toBe('not_found')
  })
})

describe('more cases at the edges', () => {
  test('a click says which version of the page it was made on, and that the page has moved on, in the words that version carried', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { title: 'Approve plan A', session: SESSION })
    // Made on version 1, where the display could see revision 0 of the state; it arrives after the agent has published again
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001', { contentVersion: 1, baseStateRevision: 0 }),
    })
    const [fresh] = await inbox(m)
    expect(fresh).toMatchObject({ id: actionId, version: 1, stateRevision: 0, title: 'Approve plan A' })
    expect(fresh!.nowVersion).toBeUndefined()
    expect(describeClick({ ...fresh!, payload: JSON.parse(fresh!.payload), attended: true })).toBe(
      `[It] The page "Approve plan A" (plan) sent this just after someone used it: approve {"n":1} [action ${actionId}]`,
    )
    await publish(m, 'plan', { title: 'Approve plan B', session: SESSION })
    await settle(t)
    const [late] = await inbox(m)
    // It is described by the title it was made under, and says so
    expect(late).toMatchObject({ id: actionId, version: 1, nowVersion: 2, title: 'Approve plan A' })
    expect(describeClick({ ...late!, payload: JSON.parse(late!.payload), attended: true })).toBe(
      `[It] The page "Approve plan A" (plan) sent this just after someone used it, as it was at version 1 (the page is now at version 2): approve {"n":1} [action ${actionId}]`,
    )
    expect(await m.as.query(api.delivery.get, { id: actionId })).toMatchObject({ version: 1, nowVersion: 2, stateRevision: 0 })
  })

  test('a click made on one state of a page, and delivered after the state has changed, says so', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { title: 'Approve the plan', state: '{"plan":"A"}', session: SESSION })
    // The person approves while the page shows plan A (revision 1 of its state); the page itself is never published again
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001', { contentVersion: 1, baseStateRevision: 1 }),
    })
    expect((await inbox(m))[0]).not.toHaveProperty('nowStateRevision')
    await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"plan":"B"}' })
    const [late] = await inbox(m)
    expect(late).toMatchObject({ id: actionId, version: 1, stateRevision: 1, nowStateRevision: 2 })
    expect(late).not.toHaveProperty('nowVersion')
    expect(describeClick({ ...late!, payload: JSON.parse(late!.payload), attended: true })).toBe(
      `[It] The page "Approve the plan" (plan) sent this just after someone used it, when its state was at revision 1 (it is now at revision 2): approve {"n":1} [action ${actionId}]`,
    )
    // A click made on the state as it is now says nothing of the kind
    await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0002', { contentVersion: 1, baseStateRevision: 2 }),
    })
    expect((await inbox(m))[1]).not.toHaveProperty('nowStateRevision')
  })

  test('a notification’s button answers what the page showed when the notification was sent', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await publish(m, 'release', { title: 'Deploy release A', state: '{"release":"A"}', session: SESSION })
    const note = await m.as.mutation(api.notifications.send, { text: 'Deploy?', slug: 'release', buttons: [{ label: 'Yes', action: 'yes' }] })
    // Before the person answers, the agent moves on to release B: a new version, and a new state
    await publish(m, 'release', { title: 'Deploy release B', session: SESSION })
    await m.as.mutation(api.state.patch, { slug: 'release', patch: '{"release":"B"}' })
    await settle(t)
    const { actionId } = await alice.browser.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: displayKey('alice') })
    const [click] = await inbox(m)
    // It is a yes to release A, at the version and the state the question was asked about, and says so
    expect(click).toMatchObject({ id: actionId, title: 'Deploy release A', version: 1, nowVersion: 2, stateRevision: 1, nowStateRevision: 2 })
    expect(describeClick({ ...click!, payload: JSON.parse(click!.payload), attended: true })).toContain(
      '"Deploy release A" (release) sent this just after someone used it, as it was at version 1 (the page is now at version 2), when its state was at revision 1 (it is now at revision 2): yes',
    )
  })

  test('a notification about a page whose state was never written, answered after the version it was about is gone, still says what it was about', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    // No starting state: the page's state has never been written, and is at revision 0
    await publish(m, 'release', { title: 'Deploy release A', session: SESSION })
    const note = await m.as.mutation(api.notifications.send, { text: 'Deploy?', slug: 'release', buttons: [{ label: 'Yes', action: 'yes' }] })
    // The state is written for the first time, and the page is published again more often than versions are kept
    await m.as.mutation(api.state.patch, { slug: 'release', patch: '{"release":"B"}' })
    for (let i = 0; i < LIMITS.versionsKept + 2; i++) await publish(m, 'release', { title: `Deploy release ${i}`, session: SESSION })
    await settle(t)
    await alice.browser.mutation(api.notifications.answer, { id: note.id, action: 'yes', displayKey: displayKey('alice') })
    expect((await inbox(m))[0]).toMatchObject({
      title: 'Deploy release A',
      version: 1,
      stateRevision: 0,
      nowStateRevision: 1,
      nowVersion: LIMITS.versionsKept + 3,
    })
  })

  test('a click keeps the title its page had, when that version is not kept any more, and reading a full inbox reads no version', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'plan', { title: 'Approve plan A', session: SESSION })
    const { actionId } = await alice.browser.mutation(api.actions.submit, {
      artifactId: p.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001', { contentVersion: 1 }),
    })
    // Published again more times than versions are kept: version 1 is gone
    for (let i = 0; i < LIMITS.versionsKept + 2; i++) await publish(m, 'plan', { title: `Approve plan ${i}`, session: SESSION })
    await settle(t)
    expect(await t.run((ctx) => ctx.db.query('versions').collect())).not.toContainEqual(expect.objectContaining({ artifactId: p.artifactId, n: 1 }))
    expect((await inbox(m))[0]).toMatchObject({ id: actionId, title: 'Approve plan A', version: 1, nowVersion: LIMITS.versionsKept + 3 })
  })

  test('a page that was begun and never shown takes its starting state from the publish that is shown', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    // A first attempt is cut off part of the way, and nothing takes it back
    await m.as.action(api.publish.begin, { slug: 'plan', title: 'First try', files: page, state: '{"plan":"from the attempt that died"}' })
    // The retry starts with another state, and is the one that is shown
    await publish(m, 'plan', { title: 'Second try', state: '{"plan":"from the one that was shown"}' })
    expect(await stateOf(alice.browser, 'plan')).toEqual({ plan: 'from the one that was shown' })
    // Once the page has been shown, a starting state given with a later publish changes nothing
    await publish(m, 'plan', { title: 'Third', state: '{"plan":"too late"}' })
    expect(await stateOf(alice.browser, 'plan')).toEqual({ plan: 'from the one that was shown' })
  })

  test('a starting state belongs to the publish that asked for it, and starts nothing unless that publish is shown', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    // Two attempts at a new page, each with a state of its own. The second is given up on; the first is shown.
    const a = await m.as.action(api.publish.begin, { slug: 'plan', title: 'From A', files: page, state: '{"plan":"A"}' })
    const b = await m.as.action(api.publish.begin, { slug: 'plan', title: 'From B', files: page, state: '{"plan":"B"}' })
    await m.as.mutation(api.publish.abandon, { artifactId: b.artifactId, version: b.version })
    await m.as.action(api.publish.finish, { artifactId: a.artifactId, version: a.version })
    await settle(t)
    expect(await stateOf(alice.browser, 'plan')).toEqual({ plan: 'A' })
    expect(await t.run((ctx) => ctx.db.query('starts').collect())).toEqual([])
    // A page that is live and has no state: an update that asks for one and is given up on leaves it with none
    await publish(m, 'bare')
    const update = await m.as.action(api.publish.begin, { slug: 'bare', title: 'Bare, updated', files: page, state: '{"from":"an update nobody saw"}' })
    await m.as.mutation(api.publish.abandon, { artifactId: update.artifactId, version: update.version })
    await settle(t)
    expect(await stateOf(alice.browser, 'bare')).toEqual({})
    // And one that is shown gives it its state, at revision 1, in the same step
    const shown = await m.as.action(api.publish.begin, { slug: 'bare', title: 'Bare, updated', files: page, state: '{"from":"the update that was shown"}' })
    await m.as.action(api.publish.finish, { artifactId: shown.artifactId, version: shown.version })
    expect(await m.as.query(api.state.get, { slug: 'bare' })).toMatchObject({ json: '{"from":"the update that was shown"}', revision: 1 })
    // A page whose only state is what the page stored for itself has no state of its agent's: a starting state goes in beside it
    await publish(m, 'stores')
    const stores = await alice.browser.query(api.artifacts.get, { slug: 'stores' })
    await alice.browser.mutation(api.state.storeSet, { artifactId: stores.id, key: 'draft', value: '"kept by the page"' })
    await publish(m, 'stores', { state: '{"plan":"from the agent"}' })
    expect(await stateOf(alice.browser, 'stores')).toEqual({ plan: 'from the agent', _page: { draft: 'kept by the page' } })
    // A publish that loses to a newer one starts nothing either
    const slow = await m.as.action(api.publish.begin, { slug: 'other', title: 'Slow', files: page, state: '{"from":"the slow one"}' })
    await publish(m, 'other', { title: 'Fast' })
    expect(await code(m.as.action(api.publish.finish, { artifactId: slow.artifactId, version: slow.version }))).toBe('conflict')
    expect(await stateOf(alice.browser, 'other')).toEqual({})
    expect(await t.run((ctx) => ctx.db.query('starts').collect())).toEqual([])
  })

  test('a page two conversations begin at once belongs to the one that finishes publishing it', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const laptop = await machineOf(t, 'alice', 'laptop')
    const server = await machineOf(t, 'alice', 'server')
    const A = { harness: 'claude-code', id: 'began-and-gave-up' }
    const B = { harness: 'claude-code', id: 'finished' }
    // A begins a page nobody has seen yet, and B begins the same id before A is done
    const a = await laptop.as.action(api.publish.begin, { slug: 'plan', title: 'From A', files: page, session: A })
    const b = await server.as.action(api.publish.begin, { slug: 'plan', title: 'From B', files: page, session: B })
    await server.as.action(api.publish.finish, { artifactId: b.artifactId, version: b.version })
    // A finishes after all, too late: it is told its publish was not shown, and nothing changes hands
    expect(await code(laptop.as.action(api.publish.finish, { artifactId: a.artifactId, version: a.version }))).toBe('conflict')
    await settle(t)
    // What is shown is B's, and so is the page: its clicks go to B's conversation, on B's machine
    expect(await alice.browser.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ title: 'From B', machine: 'server' })
    const sent = await alice.browser.mutation(api.actions.submit, {
      artifactId: b.artifactId,
      displayKey: displayKey('alice'),
      envelope: envelope('click-0001', { contentVersion: b.version }),
    })
    expect((await inbox(server, [B])).map((c) => c.id)).toEqual([sent.actionId])
    expect(await inbox(laptop, [A])).toEqual([])
    // Once it has been shown, the conversation that made it keeps it, as before
    const again = await laptop.as.action(api.publish.begin, { slug: 'plan', title: 'From A again', files: page, session: A })
    await laptop.as.action(api.publish.finish, { artifactId: again.artifactId, version: again.version })
    await settle(t)
    expect(await alice.browser.query(api.artifacts.get, { slug: 'plan' })).toMatchObject({ title: 'From A again', machine: 'server' })
  })
})

describe('a step of publishing that the backend gave up on because another touched the same record', () => {
  test('is asked again by the action itself, a few times, and nothing else is', async () => {
    const { overClashes, clashed } = await import('./lib/clash')
    vi.useRealTimers()
    const clash = () =>
      new Error('Documents read from or written to the "tallies" table changed while this mutation was being run and on every subsequent retry.')
    let asked = 0
    expect(
      await overClashes(async () => {
        if (++asked < 3) throw clash()
        return 'done'
      }),
    ).toBe('done')
    expect(asked).toBe(3)
    asked = 0
    await expect(
      overClashes(async () => {
        asked++
        throw clash()
      }),
    ).rejects.toSatisfy(clashed)
    expect(asked).toBe(4)
    asked = 0
    await expect(
      overClashes(async () => {
        asked++
        throw new ConvexError({ code: 'limit', message: 'no' })
      }),
    ).rejects.toBeInstanceOf(ConvexError)
    expect(asked).toBe(1)
  })
})

describe('a function that an action or a route runs, given up on by the backend because another caller touched the same record', () => {
  const put: (() => void)[] = []
  afterEach(() => {
    for (const back of put.splice(0)) back()
  })
  /**
   * Has one of the backend's own functions fail the next time it is run, as the backend program
   * fails one it gave up on, with nothing of it done. Answers with how often it has been run since.
   */
  function givenUpOnOnce(fn: unknown) {
    const held = fn as { _handler: (...all: unknown[]) => unknown }
    const real = held._handler
    let runs = 0
    held._handler = (...all) => {
      if (++runs === 1)
        throw new Error('Documents read from or written to the "rateLimits" table changed while this mutation was being run and on every subsequent retry.')
      return real(...all)
    }
    put.push(() => {
      held._handler = real
    })
    return () => runs
  }
  /**
   * Lets the clock go on, a little at a time, until something has come about. What is waited
   * for runs by itself and takes the machine's own time as well as the clock's, so each step
   * of the clock is given a moment of real time, and the clock is moved far less than the three
   * minutes after which a notification is looked at a second time.
   */
  async function comes(what: () => boolean | Promise<boolean>): Promise<void> {
    for (let steps = 0; steps < 3000 && !(await what()); steps++) {
      await vi.advanceTimersByTimeAsync(10)
      await new Promise((r) => realTimeout(r, 2))
    }
  }
  /** Lets the moment go by that is waited before a function is asked for again, until whatever was asked is answered. */
  async function answered<A>(asked: Promise<A>): Promise<A> {
    let over = false
    const done = () => {
      over = true
    }
    asked.then(done, done)
    await comes(() => over)
    return asked
  }

  test('the token a display signs out with is given all the same, the count against the person having been asked for again', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const runs = givenUpOnOnce((await import('./displays'))._signOutClaims)
    const given = await answered(alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') }))
    expect([claimsOf(given.token).sub, given.raisesTo, runs()]).toEqual([alice.display.id, 1, 2])
  })

  test('the key a browser subscribes to notifications with is given all the same', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const runs = givenUpOnOnce((await import('./push'))._gate)
    expect([await answered(alice.browser.action(api.push.publicKey, {})), runs()]).toEqual(['the-key-a-browser-subscribes-with', 2])
  })

  test('a showing is given its one ticket all the same', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const p = await publish(await machineOf(t, 'alice'), 'plan')
    const mount = await alice.browser.mutation(api.mounts.create, { artifactId: p.artifactId, displayKey: displayKey('alice') })
    const runs = givenUpOnOnce((await import('./mounts'))._take)
    const { ticket } = await answered(alice.browser.action(api.mounts.ticket, { mountId: mount.mountId }))
    expect([claimsOf(ticket).m, runs()]).toEqual([mount.mountId, 2])
  })

  test('the key the backend signs with is kept all the same, the first time one is needed', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const runs = givenUpOnOnce((await import('./keys')).keep)
    const given = await answered(alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') }))
    expect([claimsOf(given.token).sub, runs(), (await t.run((ctx) => ctx.db.query('signingKeys').collect())).length]).toEqual([alice.display.id, 2, 1])
  })

  test('a session a browser ends is ended, and the browser is told so and not to try again', async () => {
    const { t, machine } = await installed()
    const laptop = await pair(t, (await machine.mutation(api.sessions.inviteOwner, {})).code)
    const runs = givenUpOnOnce((await import('./sessions'))._end)
    const ended = await answered(endOf(t, laptop))
    expect([ended.status, runs(), await alive(laptop.browser)]).toEqual([200, 2, false])
  })

  test('a sign-out token a display presents is taken, and the display is signed out', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const { token } = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
    const runs = givenUpOnOnce((await import('./displays'))._signOutByToken)
    const presented = await answered(
      t.fetch('/display/signout', { method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } }),
    )
    expect([presented.status, runs(), ((await t.run((ctx) => ctx.db.get(alice.display.id as never))) as any).epoch]).toEqual([200, 2, 1])
  })

  test('what a notification was pushed to is recorded, so that it is pushed there once', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    await alice.browser.mutation(api.push.subscribe, { key: displayKey('alice'), endpoint: PUSH('alive'), p256dh: 'p', auth: 'a' })
    await vi.advanceTimersByTimeAsync(200_000)
    const runs = givenUpOnOnce((await import('./push'))._pushed)
    const n = await m.as.mutation(api.notifications.send, { text: 'later' })
    const pushedTo = async () => ((await t.run((ctx) => ctx.db.get(n.id as never))) as any).pushedTo ?? []
    // It is pushed by itself as soon as it is sent, and what was pushed to is asked to be recorded a moment after the first asking
    await comes(async () => (await pushedTo()).length > 0)
    expect([runs(), await pushedTo()]).toEqual([2, [alice.display.id]])
    expect(await t.action(internal.push.deliver, { notificationId: n.id })).toBe(0)
    expect(sender.asked.map((a) => a.subscription.endpoint)).toEqual([PUSH('alive')])
  }, 30_000)

  test('a job the content service has done is settled, and not left to be done over', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const runs = givenUpOnOnce((await import('./content'))._settle)
    await alice.browser.mutation(api.displays.signOut, { key: displayKey('alice') })
    const jobs = () => t.run((ctx) => ctx.db.query('contentJobs').collect())
    // The job runs by itself, and waits a moment of its own before it asks again
    await comes(async () => (await jobs()).length === 0)
    expect([runs(), await jobs(), content.calls.map((c) => c.op)]).toEqual([2, [], ['revoke']])
  }, 30_000)
})

describe('what is written down', () => {
  /** Everything the backend logs while a test runs: each line as it was written, and as the event it is. */
  function written() {
    const raw: string[] = []
    const events: Record<string, any>[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        raw.push(args.map(String).join(' '))
        try {
          events.push({ level, ...JSON.parse(String(args[0])) })
        } catch {}
      }),
    )
    return {
      raw,
      events,
      of: (event: string) => events.filter((e) => e.event === event),
      stop: () => {
        for (const spy of spies) spy.mockRestore()
      },
    }
  }

  test('a machine being enrolled, revoked, and asking again are each written down', async () => {
    const out = written()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      const m = await machineOf(t, 'alice', 'the laptop in the hall')
      expect(out.of('machine.enrolled')).toMatchObject([{ machineId: m.id, level: 'log' }])
      await alice.browser.mutation(api.machines.revoke, { machineId: m.id })
      await settle(t)
      expect(out.of('machine.revoked')).toMatchObject([{ machineId: m.id, by: 'person' }])
      // Its token is good for a few minutes yet, and it is refused all the same: that is worth a line
      expect(await code(m.as.query(api.machines.me, {}))).toBe('unauthenticated')
      expect(out.of('auth.refused')).toMatchObject([{ machineId: m.id, reason: 'machine_revoked', level: 'warn' }])
      // Knowing a revoked machine's id is not holding its key: asking with no proof of that is refused, and is not a line
      const asked = await t.fetch('/bridge/token', { method: 'POST', body: JSON.stringify({ machine: m.id, proof: 'x.y.z' }) })
      expect([asked.status, ((await asked.json()) as { reason?: string }).reason]).toEqual([401, 'signature'])
      expect(out.of('token.refused')).toEqual([])
      // A machine that does hold its key, revoked, and still asking: that is written down, once an hour and not each time
      const pair = await generateKeyPair('ES256', { extractable: true })
      const jwk = await exportJWK(pair.publicKey)
      const real = await t.mutation(internal.bridge.enroll, {
        subject: 'user_alice',
        name: 'held',
        publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
      })
      if ('error' in real) throw new Error(real.error)
      const proof = () =>
        new SignJWT({})
          .setProtectedHeader({ alg: 'ES256' })
          .setIssuer(real.machineId)
          .setAudience(`${SITE}/bridge/token`)
          .setIssuedAt()
          .setJti(crypto.randomUUID())
          .sign(pair.privateKey)
      const ask = async () => {
        const r = await t.fetch('/bridge/token', { method: 'POST', body: JSON.stringify({ machine: real.machineId, proof: await proof() }) })
        return [r.status, ((await r.json()) as { reason?: string }).reason]
      }
      expect((await ask())[0]).toBe(200)
      await alice.browser.mutation(api.machines.revoke, { machineId: real.machineId })
      await settle(t)
      for (let i = 0; i < 5; i++) expect(await ask()).toEqual([401, 'revoked'])
      expect(out.of('token.refused')).toMatchObject([{ machineId: real.machineId, reason: 'revoked' }])
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(await ask()).toEqual([401, 'revoked'])
      expect(out.of('token.refused')).toHaveLength(2)
      // What anyone can send, as often as they like, without being paired or enrolled, is not written down at all.
      // (The backend's own key is made the first time it is needed, which is said once.)
      await t.fetch('/.well-known/jwks.json')
      const lines = out.raw.length
      for (let i = 0; i < 20; i++) {
        expect((await t.fetch('/bridge/token', { method: 'POST', body: JSON.stringify({ machine: 'made-up-by-the-caller', proof: 'x.y.z' }) })).status).toBe(
          401,
        )
        expect((await t.fetch('/bridge/enroll', { method: 'POST', body: '{}' })).status).toBe(401)
        expect((await t.fetch('/bridge/enroll', { method: 'POST', body: JSON.stringify({ code: 'made-up-by-the-caller', publicKey: 'no key' }) })).status).toBe(
          400,
        )
        expect((await tokenFor(t, `it_session_nobodys=${'x'.repeat(43)}`)).status).toBe(401)
        expect((await t.fetch('/session/redeem', { method: 'POST', body: JSON.stringify({ code: 'made-up-by-the-caller' }) })).status).toBe(403)
        expect((await endOf(t, { session: 'made-up-by-the-caller', cookie: `it_session_nobodys=${'x'.repeat(43)}` })).status).toBe(401)
        expect((await t.fetch('/display/signout', { method: 'POST', body: JSON.stringify({ token: 'not.a.token' }) })).status).toBe(401)
      }
      expect(out.raw.slice(lines)).toEqual([])
      expect(out.raw.join('\n')).not.toContain('made-up-by-the-caller')
      expect(out.raw.join('\n')).not.toContain('the laptop in the hall')
    } finally {
      out.stop()
    }
  })

  test('a look at another person’s things is written down, though the one who looked is told only that there is no such thing', async () => {
    const out = written()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      const bob = await person(t, 'bob')
      const am = await machineOf(t, 'alice')
      const p = await publish(am, 'plan')
      expect(out.of('access.denied')).toEqual([])
      expect(await code(bob.browser.query(api.artifacts.get, { artifactId: p.artifactId }))).toBe('not_found')
      expect(await code(bob.browser.mutation(api.machines.revoke, { machineId: am.id }))).toBe('not_found')
      expect(await code(bob.browser.mutation(api.displays.forget, { displayId: alice.display.id }))).toBe('not_found')
      expect(out.of('access.denied')).toMatchObject([
        { what: 'page', id: p.artifactId, level: 'warn' },
        { what: 'machine', id: am.id },
        { what: 'display', id: alice.display.id },
      ])
      // Whoever looked is named by their own id, which is not the owner's
      const owner = await t.run((ctx) => ctx.db.get(p.artifactId).then((a) => a!.userId))
      for (const line of out.of('access.denied')) expect(line.userId).not.toBe(owner)
      // Something that does not exist at all is nobody's attempt on anybody
      await alice.browser.mutation(api.artifacts.remove, { artifactId: p.artifactId })
      await settle(t)
      expect(await code(bob.browser.query(api.artifacts.get, { artifactId: p.artifactId }))).toBe('not_found')
      expect(out.of('access.denied')).toHaveLength(3)
      await settle(t)
    } finally {
      out.stop()
    }
  })

  test('a limit that is reached is written down with its rule, once a minute however hard it is pressed', async () => {
    const out = written()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      await alice.browser.mutation(api.account.exportStart, {})
      await settle(t)
      expect(out.of('limit.reached')).toEqual([])
      // The call that takes the last of what was allowed is the one that is written down
      await alice.browser.mutation(api.account.exportStart, {})
      await settle(t)
      expect(out.of('limit.reached')).toMatchObject([{ rule: 'export', level: 'warn' }])
      const lines = out.raw.length
      // Every call after it is refused, and none of those is a line
      for (let i = 0; i < 50; i++) expect(await code(alice.browser.mutation(api.account.exportStart, {}))).toBe('rate_limited')
      await settle(t)
      expect(out.raw.length).toBe(lines)
      // Pressed for minutes on end, it is said once a minute at most: each time a little is allowed again and taken
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(15_000)
        await code(alice.browser.mutation(api.account.exportStart, {}))
        await settle(t)
      }
      expect(out.of('limit.reached').length).toBeGreaterThan(2)
      expect(out.of('limit.reached').length).toBeLessThanOrEqual(11)
      // Enrolling is counted against the person's subject, which is no id of the backend's own, and that is not written down
      for (let i = 0; i < 6; i++)
        await t.mutation(internal.bridge.enroll, { subject: subjectOf('alice'), name: 'm', publicKey: { ...KEY, x: `enroll${i}` } }).catch(() => {})
      await settle(t)
      expect(out.of('limit.reached').some((e) => e.rule === 'enroll' && e.who === undefined)).toBe(true)
      expect(out.raw.join('\n')).not.toContain('user_alice')
    } finally {
      out.stop()
    }
  })

  test.each([
    { correction: 'no clock change', setBack: 0, recovered: false },
    { correction: 'a one-hour clock correction', setBack: 3_600_000, recovered: false },
    { correction: 'a clock correction handled by a previous version', setBack: 3_600_000, recovered: true },
    { correction: 'a previous correction with its old warning now only three milliseconds ahead', setBack: 3, recovered: true },
  ])('limit warnings remain one minute apart after $correction', async ({ setBack, recovered }) => {
    const out = written()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      const ask = () => alice.browser.mutation(api.account.exportStart, {})
      await ask()
      await ask()
      await runWhatIsDue(t)
      expect(out.of('limit.reached')).toMatchObject([{ rule: 'export', level: 'warn' }])
      expect(out.of('limit.reached')).toHaveLength(1)

      const correctedAt = Date.now() - setBack
      vi.setSystemTime(correctedAt)
      if (setBack) {
        if (recovered) {
          // An older version restarted the count thirty seconds ago but kept the warning's old time.
          await t.run(async (ctx) => {
            const row = (await ctx.db.query('rateLimits').collect()).find((row) => row.key === `export:${alice.user}`)!
            await ctx.db.patch(row._id, { tokens: 1, updatedAt: correctedAt - 30_000 })
          })
        }
        // The bucket has two tokens after reset or refill. This call leaves one and writes no warning.
        await ask()
        const count = await t.run(async (ctx) => (await ctx.db.query('rateLimits').collect()).find((row) => row.key === `export:${alice.user}`))
        expect(count).toMatchObject({ tokens: 1, updatedAt: correctedAt, saidAt: correctedAt })
        await ask()
        await runWhatIsDue(t)
        expect(out.of('limit.reached')).toHaveLength(1)
      }

      for (const elapsed of [0, 15_000, 30_000, 45_000, 59_999, 60_000, 75_000, 90_000, 105_000, 119_999, 120_000]) {
        vi.setSystemTime(correctedAt + elapsed)
        // This bucket earns one token every thirty seconds. Refusals never add a log line.
        expect(await code(ask())).toBe(elapsed > 0 && elapsed % 30_000 === 0 ? 'ok' : 'rate_limited')
        for (let i = 0; i < 5; i++) expect(await code(ask())).toBe('rate_limited')
        await runWhatIsDue(t)
        expect(out.of('limit.reached')).toHaveLength(1 + Math.floor(elapsed / 60_000))
      }
    } finally {
      out.stop()
    }
  })

  test('a call that reaches a limit and then fails gives back what it took, and writes nothing, however often it is made', async () => {
    const out = written()
    try {
      const t = backend()
      await person(t, 'alice')
      const m = await machineOf(t, 'alice')
      // Fourteen notifications leave room for one more. (The clock is not moved in between: what is allowed comes back with time.)
      for (let i = 0; i < 14; i++) await m.as.mutation(api.notifications.send, { text: `note ${i}` })
      await runWhatIsDue(t)
      expect(out.of('limit.reached')).toEqual([])
      // The fifteenth, twenty times over, names a display that is not there: counted, then refused, then not counted after all
      for (let i = 0; i < 20; i++) expect(await code(m.as.mutation(api.notifications.send, { text: 'again', display: 'nowhere' }))).toBe('not_found')
      dropWhatAFailedCallScheduled()
      // One that is kept takes the last of what was allowed
      await m.as.mutation(api.notifications.send, { text: 'the fifteenth' })
      expect(await code(m.as.mutation(api.notifications.send, { text: 'one too many' }))).toBe('rate_limited')
      await runWhatIsDue(t)
      // And that one is the one line: none of the twenty that failed, and none of the refusals after
      expect(out.of('limit.reached')).toMatchObject([{ rule: 'notify' }])
      expect(out.of('limit.reached')).toHaveLength(1)
    } finally {
      out.stop()
    }
  })

  test('a limit counted in kilobytes is written down by the call that leaves too little for another like it', async () => {
    const out = written()
    try {
      const t = backend()
      await person(t, 'alice')
      const m = await machineOf(t, 'alice')
      const p = await publish(m, 'plan')
      // Each write stores about 480 KB, and the page may store 8192 KB at once
      const big = JSON.stringify({ text: 'x'.repeat(480 * 1024) })
      let wrote = 0
      for (; wrote < 40; wrote++) if ((await code(m.as.mutation(api.state.patch, { slug: 'plan', patch: big, replace: true }))) !== 'ok') break
      await settle(t)
      expect(wrote).toBeGreaterThan(10)
      expect(wrote).toBeLessThan(30)
      // It was said before the first refusal, by the last write that was taken, though plenty was left by the count of one
      expect(out.of('limit.reached').map((e) => e.rule)).toContain('stateKilobytesPage')
      const count = () => t.run(async (ctx) => (await ctx.db.query('rateLimits').collect()).find((row) => row.key === `stateKilobytesPage:${p.artifactId}`))
      const warned = (await count())!
      expect(warned.saidAt).toBe(warned.updatedAt)
      // A smaller write that arrived out of order can still fit, but must not move the warning backwards.
      vi.setSystemTime(warned.updatedAt - 3)
      await m.as.mutation(api.state.patch, { slug: 'plan', patch: '{"text":"small"}', replace: true })
      expect(await count()).toMatchObject({ updatedAt: warned.updatedAt, saidAt: warned.saidAt })
    } finally {
      out.stop()
    }
  })

  test('nothing written down holds a name, a title, a key, a token, or what a page or a person sent', async () => {
    const out = written()
    try {
      const t = backend()
      const alice = await person(t, 'alice')
      const m = await machineOf(t, 'alice', 'private machine name')
      await alice.browser.mutation(api.displays.rename, { displayId: alice.display.id, name: 'private display name' })
      const p = await publish(m, 'private-slug', { state: '{"note":"private state"}', session: SESSION })
      await alice.browser.mutation(api.actions.submit, {
        artifactId: p.artifactId,
        displayKey: displayKey('alice'),
        envelope: envelope('click-0001', { name: 'private-action', payload: '{"said":"private payload"}' }),
      })
      await alice.browser.mutation(api.state.storeSet, { artifactId: p.artifactId, key: 'k', value: '"private store"' })
      await m.as.mutation(api.notifications.send, { text: 'private notification', slug: 'private-slug' })
      await alice.browser.mutation(api.push.subscribe, {
        key: displayKey('alice'),
        endpoint: PUSH('gone-private-endpoint'),
        p256dh: 'private-p256dh',
        auth: 'private-auth',
      })
      await m.as.mutation(api.notifications.send, { text: 'private notification two', slug: 'private-slug' })
      await settle(t)
      const { token } = await alice.browser.action(api.displays.signOutToken, { key: displayKey('alice') })
      const post = (body: unknown) =>
        t.fetch('/display/signout', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
      expect((await post({ token })).status).toBe(200)
      expect((await post({ token: `${token}x` })).status).toBe(401)
      await alice.browser.mutation(api.account.exportStart, {})
      // A screen is paired with a code, after a wrong one was tried, and is later forgotten
      const invited = await alice.browser.mutation(api.sessions.inviteScreen, {})
      expect((await redeem(t, 'a-private-wrong-code')).status).toBe(401)
      const screen = await pair(t, invited.code)
      const tablet = await screen.browser.mutation(api.displays.register, { key: 'private-screen-key-01', userAgent: 'x' })
      await alice.browser.mutation(api.displays.forget, { displayId: tablet.id })
      const other = await pair(t, (await alice.browser.mutation(api.sessions.inviteScreen, {})).code)
      expect((await endOf(t, other)).status).toBe(200)
      await alice.browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user: alice.user })
      await settle(t)
      // The scenario did write things down, among them the ones a person would later ask about
      for (const event of [
        'machine.enrolled',
        'display.registered',
        'display.signed_out',
        'push.dropped',
        'account.export',
        'invite.made',
        'code.refused',
        'session.begun',
        'session.ended',
        'display.forgotten',
        'account.deletion_requested',
        'account.deleted',
      ])
        expect(out.of(event).length, event).toBeGreaterThan(0)
      const all = out.raw.join('\n')
      const credentials = [invited.code, screen.cookie.split('=')[1]!, screen.token, screen.token.split('.')[2]!, other.cookie.split('=')[1]!]
      for (const secret of ['private', token, token.split('.')[2], displayKey('alice'), 'user_alice', 'Title of', '"d":', ...credentials])
        expect(all.includes(secret), `the log holds ${secret.slice(0, 12)}`).toBe(false)
      // And every line is one event with a name
      for (const line of out.raw) expect(() => JSON.parse(line).event.length).not.toThrow()
    } finally {
      out.stop()
    }
  })
})

describe('publication transactions', () => {
  test('opening validates the display before ownership and showing commit together', async () => {
    const t = backend()
    await person(t, 'alice')
    const first = await machineOf(t, 'alice')
    const next = await machineOf(t, 'alice', 'next')
    const p = await publish(first, 'atomic', { session: SESSION })
    const mine = { harness: 'pi', id: 'new-conversation' }
    expect(await code(next.as.mutation(api.displays.show, { slug: 'atomic', display: 'missing', session: mine }))).toBe('not_found')
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ machineId: first.id, session: SESSION })
    const screen = await paired(t, 'alice', 'screen', displayKey('atomic'))
    const shown = await next.as.mutation(api.displays.show, { slug: 'atomic', display: screen.display.name, session: mine })
    expect(shown).toMatchObject({ took: true, displays: [screen.display.name] })
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ machineId: next.id, session: mine })
    expect(await t.run((ctx) => ctx.db.get(screen.display.id))).toMatchObject({ showing: { artifactId: p.artifactId } })
    const before = await t.run((ctx) => ctx.db.get(screen.display.id))
    // Validation reached after display writes still rolls back both parts of the mutation.
    expect(await code(first.as.mutation(api.displays.show, { slug: 'atomic', session: { harness: 'x'.repeat(41), id: 'bad' } }))).toBe('invalid')
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ machineId: next.id, session: mine })
    expect(await t.run((ctx) => ctx.db.get(screen.display.id))).toEqual(before)
  })

  test('only an explicit label from the owning conversation changes its label', async () => {
    const t = backend()
    await person(t, 'alice')
    const owner = await machineOf(t, 'alice')
    const other = await machineOf(t, 'alice', 'other')
    const p = await publish(owner, 'label', { session: SESSION, agent: 'Original' })
    await publish(owner, 'label', { session: SESSION, agent: 'Renamed', agentExplicit: true })
    await publish(owner, 'label', { session: SESSION, agent: SESSION.harness })
    await publish(other, 'label', { session: SESSION, agent: 'Foreign', agentExplicit: true })
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ agent: 'Renamed', machineId: owner.id, session: SESSION })
  })

  test('an automatic alias takeover refuses an owner changed before begin or during upload', async () => {
    const t = backend()
    await person(t, 'alice')
    const owner = await machineOf(t, 'alice')
    const other = await machineOf(t, 'alice', 'other')
    const p = await publish(owner, 'alias', { session: SESSION })
    const next = { harness: SESSION.harness, id: 'continued' }
    const expectedOwner = { machineId: owner.id, session: SESSION }
    const request = { slug: 'alias', title: 'continued', files: page, session: next, take: true, expectedOwner }
    const begun = await owner.as.action(api.publish.begin, request)
    await other.as.mutation(api.artifacts.take, { slug: 'alias', session: next })
    expect(await code(owner.as.action(api.publish.finish, { artifactId: p.artifactId, version: begun.version }))).toBe('conflict')
    expect(await code(owner.as.action(api.publish.begin, request))).toBe('conflict')
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ machineId: other.id, currentVersion: 1 })
    await publish(owner, 'alias', { session: next, take: true })
    expect(await t.run((ctx) => ctx.db.get(p.artifactId))).toMatchObject({ machineId: owner.id, session: next })
  })

  test('a lost completion is recovered after newer publications prune its content version', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const request = { slug: 'receipt', title: 'Original', files: page, operation: 'stable-publication-identity' }
    const begun = await m.as.action(api.publish.begin, request)
    const original = await m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })
    const checked = content.calls.filter((c) => c.op === 'verify').length
    expect(await m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })).toEqual(original)
    expect(content.calls.filter((c) => c.op === 'verify')).toHaveLength(checked)
    for (let n = 0; n < LIMITS.versionsKept + 1; n++) await publish(m, 'receipt')
    expect((await t.run((ctx) => ctx.db.query('versions').collect())).some((v) => v.artifactId === begun.artifactId && v.n === 1)).toBe(false)
    const live = await t.run((ctx) => ctx.db.get(begun.artifactId))
    const again = await m.as.action(api.publish.begin, request)
    expect(again).toMatchObject({ artifactId: begun.artifactId, version: 1, upload: { grant: '' } })
    expect(await m.as.action(api.publish.resume, { operation: request.operation })).toEqual(again)
    const other = await machineOf(t, 'alice', 'other')
    expect(await code(other.as.action(api.publish.resume, { operation: request.operation }))).toBe('not_found')
    expect(await m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: 1 })).toEqual(original)
    expect(await t.run((ctx) => ctx.db.get(begun.artifactId))).toEqual(live)
    expect(await code(m.as.action(api.publish.begin, { ...request, title: 'Different request' }))).toBe('conflict')
  })

  test('a failed preparation keeps a named publication available to recover', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const operation = 'preparation-can-be-retried'
    content.stageOk = false
    expect(await code(m.as.action(api.publish.begin, { slug: 'prepared', title: 'Prepared', files: page, operation }))).toBe('unavailable')
    content.stageOk = true
    const resumed = await m.as.action(api.publish.resume, { operation })
    expect(resumed.version).toBe(1)
    expect(await m.as.action(api.publish.finish, { artifactId: resumed.artifactId, version: resumed.version })).toMatchObject({ version: 1 })
    expect(await totals(t)).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
  })

  test('a delayed preparation failure cannot abandon a resumed publication', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    let reached!: () => void
    let release!: () => void
    const preparing = new Promise<void>((resolve) => (reached = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const fetchContent = vi.mocked(fetch).getMockImplementation()!
    let first = true
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/control/stage') && first) {
        first = false
        reached()
        await held
        return new Response(null, { status: 503 })
      }
      return fetchContent(...args)
    })
    const operation = 'concurrent-preparation-failure'
    const beginning = code(m.as.action(api.publish.begin, { slug: 'shared', title: 'Shared', files: page, operation }))
    try {
      await preparing
      const resumed = await m.as.action(api.publish.resume, { operation })
      release()
      expect(await beginning).toBe('unavailable')
      expect(await m.as.action(api.publish.finish, { artifactId: resumed.artifactId, version: resumed.version })).toMatchObject({ version: 1 })
      expect(await totals(t)).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
    } finally {
      release()
      await beginning
    }
  })

  test('a recorded completion is recovered when new finishes have exhausted their rate limit', async () => {
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const request = { slug: 'limited-receipt', title: 'Original', files: page, operation: 'limited-publication-identity' }
    const begun = await m.as.action(api.publish.begin, request)
    const args = { artifactId: begun.artifactId, version: begun.version }
    const original = await m.as.action(api.publish.finish, args)
    const next = await m.as.action(api.publish.begin, { ...request, operation: 'another-publication-identity' })
    const waiting = { artifactId: next.artifactId, version: next.version }
    for (let n = 0; n < 29; n++) await m.as.mutation(internal.publish._gate, waiting)
    expect(await code(m.as.action(api.publish.finish, waiting))).toBe('rate_limited')
    const checked = content.calls.filter((c) => c.op === 'verify').length
    expect(await m.as.action(api.publish.resume, { operation: request.operation })).toMatchObject({ version: 1, upload: { grant: '' } })
    for (let n = 0; n < 3; n++) expect(await m.as.action(api.publish.finish, args)).toEqual(original)
    expect(content.calls.filter((c) => c.op === 'verify')).toHaveLength(checked)
    expect(await code(m.as.action(api.publish.finish, waiting))).toBe('rate_limited')
    expect(await t.run((ctx) => ctx.db.get(begun.artifactId))).toMatchObject({ currentVersion: 1, lastVersion: 2 })
    vi.setSystemTime(Date.now() + 1000)
    expect(await m.as.action(api.publish.finish, waiting)).toMatchObject({ version: 2 })
  })

  test('publication outcomes leave with the page and expire after thirty days', async () => {
    const t = backend()
    const alice = await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const p = await publish(m, 'removed-receipt')
    expect(await t.run((ctx) => ctx.db.query('publications').collect())).toHaveLength(1)
    await alice.browser.mutation(api.artifacts.remove, { artifactId: p.artifactId })
    await settle(t)
    expect(await t.run((ctx) => ctx.db.query('publications').collect())).toEqual([])
    await publish(m, 'old-receipt')
    vi.setSystemTime(Date.now() + PUBLICATION.receiptDays * 86_400_000 + 1)
    await t.mutation(internal.retention.sweepRecords, {})
    expect(await t.run((ctx) => ctx.db.query('publications').collect())).toEqual([])
  })

  test('the fixed publication budget covers a slow full version and cannot be renewed', async () => {
    const { PUBLICATION, uploadBudgetMs } = await import('@it/protocol')
    const t = backend()
    await person(t, 'alice')
    const m = await machineOf(t, 'alice')
    const files = Array.from({ length: 100 }, (_, n) => ({ path: n ? `${n}.bin` : 'index.html', size: 1024 * 1024, sha256: sha }))
    const request = { slug: 'slow', title: 'Slow', files, operation: 'fixed-publication-budget' }
    const begun = await m.as.action(api.publish.begin, request)
    const time = Math.ceil((LIMITS.versionBytes / 100_000) * 1000)
    expect(uploadBudgetMs(LIMITS.fileBytes)).toBeGreaterThan((LIMITS.fileBytes / 35_000) * 1000)
    expect(PUBLICATION.budgetMs).toBeGreaterThan(time)
    expect(PUBLICATION.deletedSeconds * 1000).toBeGreaterThan(PUBLICATION.grantTailMs)
    vi.setSystemTime(Date.now() + time)
    expect((await m.as.action(api.publish.begin, request)).deadline).toBe(begun.deadline)
    expect((await m.as.action(api.publish.finish, { artifactId: begun.artifactId, version: begun.version })).version).toBe(1)
    const late = await m.as.action(api.publish.begin, { slug: 'slow', title: 'Too late', files: page })
    vi.setSystemTime(Date.now() + PUBLICATION.budgetMs)
    expect(await code(m.as.action(api.publish.finish, { artifactId: late.artifactId, version: late.version }))).toBe('conflict')
    await m.as.mutation(api.publish.abandon, { artifactId: late.artifactId, version: late.version })
    await m.as.mutation(api.publish.abandon, { artifactId: late.artifactId, version: late.version })
    expect(await totals(t)).toMatchObject({ stagingCount: 0, stagingBytes: 0 })
  })
})
