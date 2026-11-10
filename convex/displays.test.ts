/// <reference types="vite/client" />
// Where an agent's page and notification go, and what a display says of itself: a display named
// by its id, a name that another display already has, and what each tab of a display reports.
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { REPORT_MS, REPORT_SKEW_MS } from './displays'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

type T = ReturnType<typeof convexTest>
const begun: T[] = []

beforeEach(() => {
  vi.useFakeTimers()
  // The content service, which a sign-out tells: nothing listens, and it answers as it would
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? '{}'))
      return new Response(JSON.stringify({ epoch: body.epoch, removed: 0, more: false, ok: true }))
    }),
  )
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** What a refusal said, however deep it was raised. */
function refusalOf(e: unknown): Record<string, unknown> {
  let data: unknown = e instanceof ConvexError ? e.data : undefined
  for (let i = 0; i < 3 && typeof data === 'string'; i++) {
    try {
      data = JSON.parse(data)
    } catch {
      break
    }
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : { code: `threw: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'ok' }) as Record<string, unknown>,
    (e) => refusalOf(e),
  )
const code = async (p: Promise<unknown>) => String((await refused(p)).code)

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0'
let made = 0

/**
 * A person with an agent's machine, and a way to pair browsers for them, as the owner's or as
 * screens. What pairing makes is made here directly: the tests of pairing go through its routes.
 */
async function household(t: T = convexTest(schema, modules), who = 'owner') {
  begun.push(t)
  const { user, machine } = await t.run(async (ctx) => {
    const now = Date.now()
    const user = await ctx.db.insert('users', { subject: `user_${who}`, createdAt: now })
    const machine = await ctx.db.insert('machines', {
      userId: user,
      name: `${who}'s laptop`,
      publicKey: { kty: 'EC', crv: 'P-256', x: `x${++made}`, y: 'y' },
      revoked: false,
      createdAt: now,
      lastSeenAt: now,
    })
    return { user, machine }
  })
  const agent = t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' })
  /** A browser paired for this person, registered as a display with that key. */
  const browser = async (role: 'owner' | 'screen', key: string) => {
    const session = await t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('sessions', { userId: user, secretHash: `secret-${++made}`, role, createdAt: now, lastSeenAt: now, cookieAt: now })
    })
    const as = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role })
    const display = await as.mutation(api.displays.register, { key, userAgent: UA })
    return { as, session: session as string, key, id: display.id as Id<'displays'> }
  }
  /** A page of this person's, with something published. */
  const page = (slug: string) =>
    t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('artifacts', {
        userId: user,
        slug,
        title: `Title of ${slug}`,
        currentVersion: 1,
        lastVersion: 1,
        bytes: 10,
        createdAt: now,
        updatedAt: now,
      })
    })
  const row = (id: Id<'displays'>): Promise<Doc<'displays'>> => t.run(async (ctx) => (await ctx.db.get(id))!)
  return { t, user, agent, browser, page, row }
}
const key = (n: number) => `display-key-number-${String(n).padStart(4, '0')}`

describe('a display named by its id', () => {
  test('a page shown by id goes to that display alone, and the answer names it by name and by id', async () => {
    const { agent, browser, page, row } = await household()
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    await page('plan')
    expect(await agent.mutation(api.displays.show, { slug: 'plan', displayId: tv.id })).toEqual({
      displays: ['Chrome on Linux 2'],
      displayIds: [tv.id],
      notShown: [],
      took: false,
    })
    expect((await row(tv.id)).showing).toBeDefined()
    expect((await row(laptop.id)).showing).toBeUndefined()
  })

  test('an id that is no display, a malformed one, and another person’s are each refused as no such display, never as an error', async () => {
    const t = convexTest(schema, modules)
    const mine = await household(t)
    const theirs = await household(t, 'someone-else')
    await mine.browser('owner', key(1))
    const elsewhere = await theirs.browser('owner', key(2))
    await mine.page('plan')
    // A display of someone else's, by its very id
    expect(await refused(mine.agent.mutation(api.displays.show, { slug: 'plan', displayId: elsewhere.id }))).toMatchObject({
      code: 'not_found',
      noSuchDisplay: true,
    })
    expect(await refused(mine.agent.mutation(api.displays.show, { slug: 'plan', displayId: 'not an id at all' }))).toMatchObject({
      code: 'not_found',
      noSuchDisplay: true,
    })
    // And a notification, likewise
    expect(await refused(mine.agent.mutation(api.notifications.send, { text: 'hi', displayId: elsewhere.id }))).toMatchObject({
      code: 'not_found',
      noSuchDisplay: true,
    })
    expect((await theirs.row(elsewhere.id)).showing).toBeUndefined()
  })

  test('a display named both by its name and by its id is refused, and nothing is shown', async () => {
    const { agent, browser, page, row } = await household()
    const laptop = await browser('owner', key(1))
    await page('plan')
    expect(await code(agent.mutation(api.displays.show, { slug: 'plan', display: 'Chrome on Linux', displayId: laptop.id }))).toBe('invalid')
    expect(await code(agent.mutation(api.notifications.send, { text: 'hi', display: 'Chrome on Linux', displayId: laptop.id }))).toBe('invalid')
    expect((await row(laptop.id)).showing).toBeUndefined()
  })

  test('a display whose pairing ended is named as not shown, with its id', async () => {
    const { t, agent, browser, page } = await household()
    await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    await page('plan')
    await t.run((ctx) => ctx.db.patch(tv.session as Id<'sessions'>, { endedAt: Date.now() }))
    expect(await agent.mutation(api.displays.show, { slug: 'plan', displayId: tv.id })).toEqual({
      displays: [],
      displayIds: [],
      notShown: [{ display: 'Chrome on Linux 2', displayId: tv.id, reason: 'not_paired' }],
      took: false,
    })
  })

  test('a notification sent by id is for that display alone', async () => {
    const { t, agent, browser } = await household()
    await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    const { id } = await agent.mutation(api.notifications.send, { text: 'hi', displayId: tv.id })
    expect((await t.run((ctx) => ctx.db.get(id)))?.displayId).toBe(tv.id)
  })

  test('a name that is only spaces is no display: refused, never taken as every display', async () => {
    const { t, agent, browser, page, row } = await household()
    const laptop = await browser('owner', key(1))
    await page('plan')
    // An older CLI sent `--on "   "` as it was typed, and the backend refused it as no such display
    expect(await refused(agent.mutation(api.notifications.send, { text: 'hi', display: '   ' }))).toMatchObject({
      code: 'not_found',
      noSuchDisplay: true,
    })
    expect(await refused(agent.mutation(api.displays.show, { slug: 'plan', display: ' \t ' }))).toMatchObject({
      code: 'not_found',
      noSuchDisplay: true,
    })
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([])
    expect((await row(laptop.id)).showing).toBeUndefined()
  })

  test('a display that shares its name with another is still reached alone by its id', async () => {
    const { t, agent, browser, page, row } = await household()
    const a = await browser('owner', key(1))
    const b = await browser('screen', key(2))
    // Two displays of one name, as an earlier It let a person make
    await t.run(async (ctx) => {
      await ctx.db.patch(a.id, { name: 'TV' })
      await ctx.db.patch(b.id, { name: 'TV' })
    })
    await page('plan')
    expect((await agent.mutation(api.displays.show, { slug: 'plan', display: 'tv' })).displayIds).toEqual([a.id, b.id])
    await t.run((ctx) => ctx.db.patch(a.id, { showing: undefined }))
    expect((await agent.mutation(api.displays.show, { slug: 'plan', displayId: b.id })).displayIds).toEqual([b.id])
    expect((await row(a.id)).showing).toBeUndefined()
  })
})

describe('a name that another display has', () => {
  test('is refused in any letter case, generated names too, while a display keeps or recases its own', async () => {
    const { t, browser, row } = await household()
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    await laptop.as.mutation(api.displays.rename, { displayId: laptop.id, name: 'Living room' })
    expect(await refused(tv.as.mutation(api.displays.rename, { displayId: tv.id, name: 'living ROOM' }))).toMatchObject({ code: 'conflict', nameTaken: true })
    expect(await refused(laptop.as.mutation(api.displays.rename, { displayId: tv.id, name: '  Living room ' }))).toMatchObject({ code: 'conflict' })
    // The name another display was given when it registered is its name too
    const phone = await browser('screen', key(3))
    expect((await row(tv.id)).generatedName).toBe('Chrome on Linux 2')
    expect(await code(laptop.as.mutation(api.displays.rename, { displayId: laptop.id, name: 'Chrome on Linux 2' }))).toBe('conflict')
    expect((await row(phone.id)).generatedName).toBe('Chrome on Linux')
    expect(await code(phone.as.mutation(api.displays.rename, { displayId: phone.id, name: 'chrome on linux' }))).toBe('ok')
    // Its own name, again or in other letters, is no other display's
    expect(await code(laptop.as.mutation(api.displays.rename, { displayId: laptop.id, name: 'Living room' }))).toBe('ok')
    expect(await code(laptop.as.mutation(api.displays.rename, { displayId: laptop.id, name: 'LIVING ROOM' }))).toBe('ok')
    expect((await row(laptop.id)).name).toBe('LIVING ROOM')
    // Names that already clash stay as they are, and a third display cannot take them
    await t.run(async (ctx) => {
      await ctx.db.patch(tv.id, { name: 'Kitchen' })
      await ctx.db.patch(phone.id, { name: 'Kitchen' })
    })
    expect(await code(laptop.as.mutation(api.displays.rename, { displayId: laptop.id, name: 'kitchen' }))).toBe('conflict')
    expect(await code(tv.as.mutation(api.displays.rename, { displayId: tv.id, name: 'Kitchen' }))).toBe('ok')
  })
})

describe('what each tab of a display says of itself', () => {
  const said = (b: { key: string; session: string }, tab: string, sequence: number, visible: boolean, extra: Record<string, unknown> = {}) => ({
    key: b.key,
    epoch: 0,
    tab,
    sequence,
    phase: 'none' as const,
    visible,
    expectedSession: b.session,
    // Made as it is sent, by the backend's clock
    observedAt: Date.now(),
    ...extra,
  })
  const TAB = 'a'.repeat(32)
  const OTHER = 'b'.repeat(32)

  test('is kept per tab, by the backend’s clock, and one older than what the tab said last is ignored', async () => {
    const { browser, row } = await household()
    const laptop = await browser('owner', key(1))
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true))).toEqual({ accepted: true, now: Date.now() })
    await laptop.as.mutation(api.displays.report, said(laptop, OTHER, 1, false))
    vi.advanceTimersByTime(1000)
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, false))).toMatchObject({ accepted: true })
    // Sent before the last, it arrives after: what it says is no longer so
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 2, true))).toMatchObject({ accepted: false })
    const reports = (await row(laptop.id)).reports!
    expect(reports.map((r) => [r.tab, r.sequence, r.visible])).toEqual(
      expect.arrayContaining([
        [TAB, 3, false],
        [OTHER, 1, false],
      ]),
    )
    expect(reports).toHaveLength(2)
    expect(reports.find((r) => r.tab === TAB)!.at).toBe(Date.now())
  })

  test('is said only by the display’s own browser: not by the owner’s for a screen, not under a pairing that ended, nor across accounts', async () => {
    const t = convexTest(schema, modules)
    const { browser, row } = await household(t)
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    // The owner's browser acts for every display, but says how things are only of its own
    expect(await code(laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 1, true), key: tv.key }))).toBe('not_found')
    // A screen naming the owner's display is told there is no such display
    expect(await code(tv.as.mutation(api.displays.report, { ...said(tv, TAB, 1, true), key: laptop.key }))).toBe('not_found')
    // A report that waited out a new pairing of this browser belongs to the one that ended
    expect(await code(tv.as.mutation(api.displays.report, { ...said(tv, TAB, 1, true), expectedSession: laptop.session }))).toBe('conflict')
    // Someone else's browser naming this display's key is told there is none
    const other = await household(t, 'someone-else')
    const theirs = await other.browser('owner', key(3))
    expect(await code(theirs.as.mutation(api.displays.report, { ...said(theirs, TAB, 1, true), key: tv.key }))).toBe('not_found')
    expect((await row(tv.id)).reports).toBeUndefined()
    expect((await row(laptop.id)).reports).toBeUndefined()
  })

  test('a report made before a sign-out is not taken after it', async () => {
    const { t, browser, row } = await household()
    const laptop = await browser('owner', key(1))
    await t.run((ctx) => ctx.db.patch(laptop.id, { epoch: 1 }))
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true))).toMatchObject({ accepted: false })
    expect(await laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 1, true), epoch: 1 })).toMatchObject({ accepted: true })
    expect((await row(laptop.id)).reports!.map((r) => r.epoch)).toEqual([1])
  })

  test('a tab id or a count that is not one is refused', async () => {
    const { browser } = await household()
    const laptop = await browser('owner', key(1))
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, 'short', 1, true)))).toBe('invalid')
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 0, true)))).toBe('invalid')
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 1.5, true)))).toBe('invalid')
  })

  test('sixteen tabs are kept, and a seventeenth, visible or not, puts out the one that spoke longest ago; stale ones go first', async () => {
    const { browser, row } = await household()
    const laptop = await browser('owner', key(1))
    const tab = (n: number) => `tab-${String(n).padStart(28, '0')}`
    for (let n = 0; n < 16; n++) {
      await laptop.as.mutation(api.displays.report, said(laptop, tab(n), 1, false))
      vi.advanceTimersByTime(10)
    }
    expect(await laptop.as.mutation(api.displays.report, said(laptop, tab(16), 1, true))).toMatchObject({ accepted: true })
    let tabs = (await row(laptop.id)).reports!.map((r) => r.tab)
    expect(tabs).toHaveLength(16)
    expect(tabs).not.toContain(tab(0))
    expect(tabs).toContain(tab(16))
    // Long after, one tab speaks: what the others said has run out and is dropped
    vi.advanceTimersByTime(REPORT_MS)
    await laptop.as.mutation(api.displays.report, said(laptop, tab(5), 2, true))
    tabs = (await row(laptop.id)).reports!.map((r) => r.tab)
    expect(tabs).toEqual([tab(5)])
  })

  test('a use is kept as a time, at most once in five seconds, and only from a tab that is visible', async () => {
    const { browser, row } = await household()
    const laptop = await browser('owner', key(1))
    const registered = (await row(laptop.id)).usedAt
    // Someone paired it there a moment ago
    expect(registered).toBe(Date.now())
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, false, { used: true }))
    expect((await row(laptop.id)).usedAt).toBe(registered)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 2, true, { used: true }))
    const used = Date.now()
    expect((await row(laptop.id)).usedAt).toBe(used)
    vi.advanceTimersByTime(2000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, true, { used: true }))
    expect((await row(laptop.id)).usedAt).toBe(used)
    vi.advanceTimersByTime(4000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { used: true }))
    expect((await row(laptop.id)).usedAt).toBe(Date.now())
  })

  test('a report held back through an outage longer than a use stands is kept as of when it was made, and is no use now', async () => {
    const { browser, row } = await household()
    const laptop = await browser('owner', key(1))
    const registered = (await row(laptop.id)).usedAt!
    vi.advanceTimersByTime(60_000)
    // The person used the display, and the report of it was made then, but the connection was
    // down: it is sent again, unchanged, a minute later, when the connection is back
    const made = said(laptop, TAB, 1, true, { used: true })
    vi.advanceTimersByTime(60_000)
    expect(await laptop.as.mutation(api.displays.report, made)).toMatchObject({ accepted: true })
    let d = await row(laptop.id)
    expect(d.usedAt).toBe(registered)
    expect(d.reports!.find((r) => r.tab === TAB)!.at).toBe(made.observedAt)
    // One that waited longer than a report stands is not taken at all
    const older = said(laptop, OTHER, 1, true, { used: true })
    vi.advanceTimersByTime(REPORT_MS)
    expect(await laptop.as.mutation(api.displays.report, older)).toMatchObject({ accepted: false })
    // One that arrives within the clock's leeway of when it was made is a use, as of then
    const timely = said(laptop, TAB, 2, true, { used: true })
    vi.advanceTimersByTime(REPORT_SKEW_MS)
    await laptop.as.mutation(api.displays.report, timely)
    d = await row(laptop.id)
    expect(d.usedAt).toBe(timely.observedAt)
    expect(d.reports!.map((r) => r.tab)).toEqual([TAB])
    // A time from a clock that runs ahead is taken as now, never later, and one that says no time is never a use
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, true, { observedAt: Date.now() + 3_600_000 }))
    expect((await row(laptop.id)).reports!.find((r) => r.tab === TAB)!.at).toBe(Date.now())
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { used: true, observedAt: undefined }))
    d = await row(laptop.id)
    expect(d.usedAt).toBe(timely.observedAt)
    expect(d.reports!.find((r) => r.tab === TAB)!.at).toBe(Date.now())
  })

  test('names only a showing this display made, since its last sign-out, and a page shown only once its ticket was given', async () => {
    const t = convexTest(schema, modules)
    const { browser, page, row } = await household(t)
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    const plan = await page('plan')
    const mount = (on: { as: typeof laptop.as; key: string }) =>
      on.as.mutation(api.mounts.create, { artifactId: plan, displayKey: on.key }).then((m) => m.mountId)
    const mine = await mount(laptop)
    const theirs = await mount(tv)
    // Loading, before its ticket: the page and its version are kept beside what the tab said
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true, { phase: 'loading', mountId: mine }))).toMatchObject({ accepted: true })
    expect((await row(laptop.id)).reports![0]).toMatchObject({ phase: 'loading', artifactId: plan, version: 1 })
    // Shown is said only of a showing whose ticket was given
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 2, true, { phase: 'shown', mountId: mine })))).toBe('not_found')
    await t.run(async (ctx) => {
      const m = (await ctx.db.query('mounts').collect()).find((x) => x.mountId === mine)!
      await ctx.db.patch(m._id, { ticketGiven: true })
    })
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, true, { phase: 'shown', mountId: mine })))).toBe('ok')
    // Another display's showing, one that is no showing, and another person's are each no showing of this display
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { phase: 'loading', mountId: theirs })))).toBe('not_found')
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { phase: 'loading', mountId: 'f'.repeat(32) })))).toBe('not_found')
    const other = await household(t, 'someone-else')
    const elsewhere = await other.browser('owner', key(3))
    const foreign = await elsewhere.as.mutation(api.mounts.create, { artifactId: await other.page('plan'), displayKey: elsewhere.key })
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { phase: 'loading', mountId: foreign.mountId })))).toBe('not_found')
    // A showing made before a sign-out is no showing after it
    await t.run((ctx) => ctx.db.patch(laptop.id, { epoch: 1 }))
    expect(await code(laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 5, true, { phase: 'loading', mountId: mine }), epoch: 1 }))).toBe(
      'not_found',
    )
    // Showing nothing names no showing, and a page names its showing
    expect(await code(laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 5, true, { mountId: mine }), epoch: 1 }))).toBe('invalid')
    expect(await code(laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 5, true, { phase: 'shown' }), epoch: 1 }))).toBe('invalid')
    expect((await row(laptop.id)).reports![0]).toMatchObject({ phase: 'shown', sequence: 3 })
  })

  test('is held to a pace per display, so that one display cannot use up another’s', async () => {
    const { browser } = await household()
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    let limited = 0
    for (let n = 1; n <= 70 && !limited; n++)
      if ((await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, n, true)))) === 'rate_limited') limited = n
    expect(limited).toBeGreaterThan(50)
    expect(await code(tv.as.mutation(api.displays.report, said(tv, TAB, 1, true)))).toBe('ok')
  })
})
