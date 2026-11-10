/// <reference types="vite/client" />
// Where an agent's page and notification go, and what a display says of itself: a display named
// by its id, a name that another display already has, and what each tab of a display reports.
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
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
  /** What a display said of itself, kept apart from its record, and when it was last used, which is when it was registered until it is used. */
  const seen = (id: Id<'displays'>) =>
    t.run(async (ctx) => {
      const p = (await ctx.db.query('presence').collect()).find((x) => x.displayId === id) as Doc<'presence'> | undefined
      return { reports: p?.reports, reportedAt: p?.reportedAt, usedAt: p?.usedAt ?? (await ctx.db.get(id))!.usedAt }
    })
  return { t, user, agent, browser, page, row, seen }
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
    const { browser, seen } = await household()
    const laptop = await browser('owner', key(1))
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true))).toEqual({ accepted: true, now: Date.now(), used: false })
    await laptop.as.mutation(api.displays.report, said(laptop, OTHER, 1, false))
    vi.advanceTimersByTime(1000)
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, false))).toMatchObject({ accepted: true })
    // Sent before the last, it arrives after: what it says is no longer so
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 2, true))).toMatchObject({ accepted: false })
    const reports = (await seen(laptop.id)).reports!
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
    const { browser, seen } = await household(t)
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
    expect((await seen(tv.id)).reports).toBeUndefined()
    expect((await seen(laptop.id)).reports).toBeUndefined()
  })

  test('a report made before a sign-out is not taken after it', async () => {
    const { t, browser, seen } = await household()
    const laptop = await browser('owner', key(1))
    await t.run((ctx) => ctx.db.patch(laptop.id, { epoch: 1 }))
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true))).toMatchObject({ accepted: false })
    expect(await laptop.as.mutation(api.displays.report, { ...said(laptop, TAB, 1, true), epoch: 1 })).toMatchObject({ accepted: true })
    expect((await seen(laptop.id)).reports!.map((r) => r.epoch)).toEqual([1])
  })

  test('a tab id or a count that is not one is refused', async () => {
    const { browser } = await household()
    const laptop = await browser('owner', key(1))
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, 'short', 1, true)))).toBe('invalid')
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 0, true)))).toBe('invalid')
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 1.5, true)))).toBe('invalid')
  })

  test('sixteen tabs are kept, and a seventeenth, visible or not, puts out the one that spoke longest ago; stale ones go first', async () => {
    const { browser, seen } = await household()
    const laptop = await browser('owner', key(1))
    const tab = (n: number) => `tab-${String(n).padStart(28, '0')}`
    for (let n = 0; n < 16; n++) {
      await laptop.as.mutation(api.displays.report, said(laptop, tab(n), 1, false))
      vi.advanceTimersByTime(10)
    }
    expect(await laptop.as.mutation(api.displays.report, said(laptop, tab(16), 1, true))).toMatchObject({ accepted: true })
    let tabs = (await seen(laptop.id)).reports!.map((r) => r.tab)
    expect(tabs).toHaveLength(16)
    expect(tabs).not.toContain(tab(0))
    expect(tabs).toContain(tab(16))
    // Long after, one tab speaks: what the others said has run out and is dropped
    vi.advanceTimersByTime(REPORT_MS)
    await laptop.as.mutation(api.displays.report, said(laptop, tab(5), 2, true))
    tabs = (await seen(laptop.id)).reports!.map((r) => r.tab)
    expect(tabs).toEqual([tab(5)])
  })

  test('a use is kept as a time, at most once in five seconds, and only from a tab that is visible', async () => {
    const { browser, seen } = await household()
    const laptop = await browser('owner', key(1))
    const registered = (await seen(laptop.id)).usedAt
    // Someone paired it there a moment ago
    expect(registered).toBe(Date.now())
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, false, { used: true }))
    expect((await seen(laptop.id)).usedAt).toBe(registered)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 2, true, { used: true }))
    const used = Date.now()
    expect((await seen(laptop.id)).usedAt).toBe(used)
    vi.advanceTimersByTime(2000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, true, { used: true }))
    expect((await seen(laptop.id)).usedAt).toBe(used)
    vi.advanceTimersByTime(4000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { used: true }))
    expect((await seen(laptop.id)).usedAt).toBe(Date.now())
  })

  test('a report held back through an outage longer than a use stands is kept as of when it was made, and is no use now', async () => {
    const { browser, seen } = await household()
    const laptop = await browser('owner', key(1))
    const registered = (await seen(laptop.id)).usedAt!
    vi.advanceTimersByTime(60_000)
    // The person used the display, and the report of it was made then, but the connection was
    // down: it is sent again, unchanged, a minute later, when the connection is back
    const made = said(laptop, TAB, 1, true, { used: true })
    vi.advanceTimersByTime(60_000)
    expect(await laptop.as.mutation(api.displays.report, made)).toMatchObject({ accepted: true, used: false })
    let d = await seen(laptop.id)
    expect(d.usedAt).toBe(registered)
    expect(d.reports!.find((r) => r.tab === TAB)!.at).toBe(made.observedAt)
    // One that waited longer than a report stands is not taken at all
    const older = said(laptop, OTHER, 1, true, { used: true })
    vi.advanceTimersByTime(REPORT_MS)
    expect(await laptop.as.mutation(api.displays.report, older)).toMatchObject({ accepted: false })
    // One that arrives within the clock's leeway of when it was made is a use, as of then
    const timely = said(laptop, TAB, 2, true, { used: true })
    vi.advanceTimersByTime(REPORT_SKEW_MS)
    expect(await laptop.as.mutation(api.displays.report, timely)).toMatchObject({ accepted: true, used: true })
    d = await seen(laptop.id)
    expect(d.usedAt).toBe(timely.observedAt)
    expect(d.reports!.map((r) => r.tab)).toEqual([TAB])
    // A time from a clock that runs ahead is taken as now, never later, and is no use, used or not
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 3, true, { used: true, observedAt: Date.now() + 3_600_000 }))
    d = await seen(laptop.id)
    expect(d.reports!.find((r) => r.tab === TAB)!.at).toBe(Date.now())
    expect(d.usedAt).toBe(timely.observedAt)
    // Ahead by no more than the clocks' leeway, it is a use, as of now
    vi.advanceTimersByTime(60_000)
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { used: true, observedAt: Date.now() + REPORT_SKEW_MS }))
    expect((await seen(laptop.id)).usedAt).toBe(Date.now())
    // One that says no time is never a use
    vi.advanceTimersByTime(60_000)
    const before = (await seen(laptop.id)).usedAt
    await laptop.as.mutation(api.displays.report, said(laptop, TAB, 5, true, { used: true, observedAt: undefined }))
    d = await seen(laptop.id)
    expect(d.usedAt).toBe(before)
    expect(d.reports!.find((r) => r.tab === TAB)!.at).toBe(Date.now())
  })

  test('what a display that was closed said last goes at the hourly cleaning, and what a display in use says now stays', async () => {
    const { t, browser, seen } = await household()
    const closed = await browser('owner', key(1))
    const open = await browser('screen', key(2))
    const quiet = await browser('screen', key(3))
    await closed.as.mutation(api.displays.report, said(closed, TAB, 1, false))
    expect((await seen(closed.id)).reportedAt).toBe(Date.now())
    // An hour on, the one display still open says so again, a moment before the cleaning
    vi.advanceTimersByTime(3_600_000)
    await open.as.mutation(api.displays.report, said(open, TAB, 1, true))
    await t.mutation(internal.retention.sweepRecords, {})
    const gone = await seen(closed.id)
    expect([gone.reports, gone.reportedAt]).toEqual([undefined, undefined])
    expect((await seen(open.id)).reports!.map((r) => r.tab)).toEqual([TAB])
    expect((await seen(open.id)).reportedAt).toBe(Date.now())
    // A display that never said anything is as it was, and so is when the person last used the closed one
    expect((await seen(quiet.id)).reports).toBeUndefined()
    expect(gone.usedAt).toBeDefined()
    // And the display that was closed is heard again as soon as it speaks
    await closed.as.mutation(api.displays.report, said(closed, TAB, 2, true))
    expect((await seen(closed.id)).reports!.map((r) => r.sequence)).toEqual([2])
  })

  test('changes nothing in the display’s own record, which a tray and the site read, so that none of them is read again for it', async () => {
    const { agent, browser, row, seen } = await household()
    const laptop = await browser('owner', key(1))
    await agent.mutation(api.notifications.send, { text: 'hello', everywhere: true })
    const tray = () => laptop.as.query(api.notifications.list, { key: laptop.key })
    const [record, before] = [await row(laptop.id), await tray()]
    for (let n = 1; n <= 3; n++) {
      vi.advanceTimersByTime(10_000)
      await laptop.as.mutation(api.displays.report, said(laptop, TAB, n, n !== 2, { used: true }))
    }
    // What the tabs said and the use are kept, apart from the display
    expect((await seen(laptop.id)).reports!.map((r) => r.sequence)).toEqual([3])
    expect((await seen(laptop.id)).usedAt).toBe(Date.now())
    // The display's record is as it was, field for field, and so is what its tray reads from it
    expect(await row(laptop.id)).toEqual(record)
    expect(await tray()).toEqual(before)
  })

  test('names only a showing this display made, since its last sign-out, and a page shown only once its ticket was given', async () => {
    const t = convexTest(schema, modules)
    const { browser, page, seen } = await household(t)
    const laptop = await browser('owner', key(1))
    const tv = await browser('screen', key(2))
    const plan = await page('plan')
    const mount = (on: { as: typeof laptop.as; key: string }) =>
      on.as.mutation(api.mounts.create, { artifactId: plan, displayKey: on.key }).then((m) => m.mountId)
    const mine = await mount(laptop)
    const theirs = await mount(tv)
    // Loading, before its ticket: the page and its version are kept beside what the tab said
    expect(await laptop.as.mutation(api.displays.report, said(laptop, TAB, 1, true, { phase: 'loading', mountId: mine }))).toMatchObject({ accepted: true })
    expect((await seen(laptop.id)).reports![0]).toMatchObject({ phase: 'loading', artifactId: plan, version: 1 })
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
    expect((await seen(laptop.id)).reports![0]).toMatchObject({ phase: 'shown', sequence: 3 })
  })

  test('never names a card’s live preview on the grid as the page shown, loading or shown', async () => {
    const t = convexTest(schema, modules)
    const { browser, page, row } = await household(t)
    const laptop = await browser('owner', key(1))
    const plan = await page('plan')
    const picture = (await laptop.as.mutation(api.mounts.create, { artifactId: plan, displayKey: laptop.key, picture: true })).mountId
    await t.run(async (ctx) => {
      const m = (await ctx.db.query('mounts').collect()).find((x) => x.mountId === picture)!
      expect(m.picture).toBe(true)
      await ctx.db.patch(m._id, { ticketGiven: true })
    })
    for (const [sequence, phase] of [
      [1, 'loading'],
      [2, 'shown'],
      [3, 'failed'],
    ] as const)
      expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, sequence, true, { phase, mountId: picture })))).toBe('invalid')
    expect((await row(laptop.id)).reports).toBeUndefined()
    // The page opened whole on the same display is named as shown
    const whole = (await laptop.as.mutation(api.mounts.create, { artifactId: plan, displayKey: laptop.key })).mountId
    expect(await code(laptop.as.mutation(api.displays.report, said(laptop, TAB, 4, true, { phase: 'loading', mountId: whole })))).toBe('ok')
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

describe('which display an agent’s page goes to where it names none', () => {
  const TAB = 'c'.repeat(32)
  const OTHER = 'd'.repeat(32)
  const tell = (b: { as: any; key: string; session: string }, tab: string, sequence: number, visible: boolean, used = false) =>
    b.as.mutation(api.displays.report, {
      key: b.key,
      epoch: 0,
      tab,
      sequence,
      phase: 'none',
      visible,
      expectedSession: b.session,
      observedAt: Date.now(),
      ...(used ? { used: true } : {}),
    })
  /** Three displays, each last heard long ago: what they say next decides. */
  async function three() {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    const tv = await h.browser('screen', key(2))
    const phone = await h.browser('screen', key(3))
    await h.page('plan')
    vi.advanceTimersByTime(10 * 60_000)
    return { ...h, laptop, tv, phone }
  }
  const shown = (h: Awaited<ReturnType<typeof three>>) => h.agent.mutation(api.displays.show, { slug: 'plan' })

  test('goes to the open display used last, then to another open one when that one is hidden, then to the one used last when none is open', async () => {
    const h = await three()
    await tell(h.laptop, TAB, 1, true, true)
    vi.advanceTimersByTime(6000)
    await tell(h.tv, TAB, 1, true, true)
    expect(await shown(h)).toMatchObject({ displays: ['Chrome on Linux 2'], displayIds: [h.tv.id], chosen: 'open' })
    const said = await shown(h)
    expect(said.notShown).toEqual(
      expect.arrayContaining([
        { display: 'Chrome on Linux', displayId: h.laptop.id, reason: 'not_chosen' },
        { display: 'Chrome on Linux 3', displayId: h.phone.id, reason: 'not_chosen' },
      ]),
    )
    // The TV's tab is hidden: it counts as closed at once
    await tell(h.tv, TAB, 2, false)
    expect((await shown(h)).displayIds).toEqual([h.laptop.id])
    // Nothing is open: the one used last, and the answer says the site was not open there
    await tell(h.laptop, TAB, 2, false)
    expect(await shown(h)).toMatchObject({ displayIds: [h.tv.id], chosen: 'last_used' })
    // Only the chosen display is asked to bring the page up
    expect((await h.row(h.phone.id)).showing).toBeUndefined()
  })

  test('one visible tab of several keeps a display open, all hidden close it, and stale reports give way to the heartbeat', async () => {
    const h = await three()
    await tell(h.tv, TAB, 1, true)
    await tell(h.tv, OTHER, 1, false)
    await tell(h.laptop, TAB, 1, true, true)
    // The laptop was used more lately, both are open: the laptop
    expect((await shown(h)).displayIds).toEqual([h.laptop.id])
    await tell(h.laptop, TAB, 2, false)
    // The TV has one visible tab and one hidden: open
    expect(await shown(h)).toMatchObject({ displayIds: [h.tv.id], chosen: 'open' })
    await tell(h.tv, TAB, 2, false)
    expect((await shown(h)).chosen).toBe('last_used')
    // Long after, the reports have run out; the phone's site, of an earlier version, beats and says nothing of its tabs
    vi.advanceTimersByTime(200_000)
    await h.phone.as.mutation(api.displays.heartbeat, { key: h.phone.key })
    expect(await shown(h)).toMatchObject({ displayIds: [h.phone.id], chosen: 'open' })
  })

  test('a tab of an earlier site that goes on beating, beside a newer tab that was hidden, counts as open again with its next heartbeat', async () => {
    const h = await three()
    await h.tv.as.mutation(api.displays.heartbeat, { key: h.tv.key })
    vi.advanceTimersByTime(1000)
    await tell(h.tv, TAB, 1, false)
    expect((await shown(h)).chosen).toBe('last_used')
    // The earlier tab's next beat that is written down, under a minute on
    vi.advanceTimersByTime(56_000)
    await h.tv.as.mutation(api.displays.heartbeat, { key: h.tv.key })
    expect(await shown(h)).toMatchObject({ displayIds: [h.tv.id], chosen: 'open' })
  })

  test('a display closed to agents is never chosen, is refused by name with why, and is left out of every display', async () => {
    const h = await three()
    await tell(h.tv, TAB, 1, true, true)
    await h.tv.as.mutation(api.displays.allowAgents, { displayId: h.tv.id, allowed: false })
    expect((await h.row(h.tv.id)).agentsOff).toBe(true)
    expect((await shown(h)).displayIds).not.toContain(h.tv.id)
    expect((await shown(h)).notShown).toContainEqual({ display: 'Chrome on Linux 2', displayId: h.tv.id, reason: 'agents_off' })
    expect(await h.agent.mutation(api.displays.show, { slug: 'plan', displayId: h.tv.id })).toMatchObject({
      displays: [],
      notShown: [{ displayId: h.tv.id, reason: 'agents_off' }],
    })
    expect((await h.agent.mutation(api.displays.show, { slug: 'plan', everywhere: true })).displayIds.sort()).toEqual([h.laptop.id, h.phone.id].sort())
    expect((await h.row(h.tv.id)).showing).toBeUndefined()
    // A screen switches itself and no other; the owner's browser switches any
    expect(await code(h.phone.as.mutation(api.displays.allowAgents, { displayId: h.tv.id, allowed: true }))).toBe('not_found')
    await h.laptop.as.mutation(api.displays.allowAgents, { displayId: h.tv.id, allowed: true })
    expect((await h.row(h.tv.id)).agentsOff).toBeUndefined()
    // And an agent has no way to: the switch takes only a paired browser
    expect(await code(h.agent.mutation(api.displays.allowAgents, { displayId: h.tv.id, allowed: false }))).toBe('forbidden')
    // Listed, it says so
    expect((await h.agent.query(api.displays.list, {})).map((d: { agents: boolean }) => d.agents)).toEqual([true, true, true])
  })

  test('“all” is a display’s name like any other, and every display is asked for in so many words', async () => {
    const h = await three()
    await h.tv.as.mutation(api.displays.rename, { displayId: h.tv.id, name: 'All' })
    expect((await h.agent.mutation(api.displays.show, { slug: 'plan', display: 'all' })).displayIds).toEqual([h.tv.id])
    expect((await h.agent.mutation(api.displays.show, { slug: 'plan', everywhere: true })).displayIds).toHaveLength(3)
    expect(await code(h.agent.mutation(api.displays.show, { slug: 'plan', everywhere: true, display: 'All' }))).toBe('invalid')
    expect(await code(h.agent.mutation(api.displays.show, { slug: 'plan', everywhere: true, displayId: h.tv.id }))).toBe('invalid')
  })

  test('with none that can take it, nothing is asked, and the answer lists each display with why', async () => {
    const h = await three()
    for (const b of [h.laptop, h.tv, h.phone]) await h.laptop.as.mutation(api.displays.allowAgents, { displayId: b.id, allowed: false })
    expect(await shown(h)).toMatchObject({ displays: [], displayIds: [] })
    expect((await shown(h)).notShown.map((n: { reason: string }) => n.reason)).toEqual(['agents_off', 'agents_off', 'agents_off'])
  })
})

describe('where an agent’s notification goes', () => {
  const TAB = 'e'.repeat(32)
  const tell = (b: { as: any; key: string; session: string }, sequence: number, visible: boolean) =>
    b.as.mutation(api.displays.report, {
      key: b.key,
      epoch: 0,
      tab: TAB,
      sequence,
      phase: 'none',
      visible,
      expectedSession: b.session,
      used: true,
      observedAt: Date.now(),
    })
  const tray = (b: { as: any; key: string }) => b.as.query(api.notifications.list, { key: b.key }).then((all: { text: string }[]) => all.map((n) => n.text))
  const PUSH = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`

  test('with none named, to the display in use alone; where none is open, a display that takes notifications first', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    const phone = await h.browser('screen', key(2))
    vi.advanceTimersByTime(10 * 60_000)
    await tell(laptop, 1, true)
    const sent = await h.agent.mutation(api.notifications.send, { text: 'hello' })
    expect(sent).toMatchObject({ displays: ['Chrome on Linux'], displayIds: [laptop.id], chosen: 'open' })
    expect([await tray(laptop), await tray(phone)]).toEqual([['hello'], []])
    // The laptop is closed and was used last, but the phone takes notifications: the phone
    await tell(laptop, 2, false)
    await phone.as.mutation(api.push.subscribe, { key: phone.key, endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    expect((await h.agent.mutation(api.notifications.send, { text: 'again' })).displayIds).toEqual([phone.id])
  })

  test('to a display named that cannot take it, or with none that can, nothing is sent and the refusal says why', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    const tv = await h.browser('screen', key(2))
    await laptop.as.mutation(api.displays.allowAgents, { displayId: tv.id, allowed: false })
    expect(await refused(h.agent.mutation(api.notifications.send, { text: 'hi', displayId: tv.id }))).toMatchObject({
      code: 'forbidden',
      notSent: 'agents_off',
    })
    await h.t.run((ctx) => ctx.db.patch(laptop.session as Id<'sessions'>, { endedAt: Date.now() }))
    expect(await refused(h.agent.mutation(api.notifications.send, { text: 'hi', displayId: laptop.id }))).toMatchObject({
      code: 'forbidden',
      notSent: 'not_paired',
    })
    expect(await refused(h.agent.mutation(api.notifications.send, { text: 'hi' }))).toMatchObject({ code: 'forbidden', notSent: 'nowhere' })
    expect(await refused(h.agent.mutation(api.notifications.send, { text: 'hi', everywhere: true }))).toMatchObject({ code: 'forbidden', notSent: 'nowhere' })
    expect(await h.t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([])
  })

  test('to every display, it reaches the displays there when it was sent and no display paired later', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    const tv = await h.browser('screen', key(2))
    const sent = await h.agent.mutation(api.notifications.send, { text: 'for all', everywhere: true })
    expect(sent.displayIds.sort()).toEqual([laptop.id, tv.id].sort())
    vi.advanceTimersByTime(1000)
    const phone = await h.browser('screen', key(3))
    await phone.as.mutation(api.push.subscribe, { key: phone.key, endpoint: PUSH('phone'), p256dh: 'p', auth: 'a' })
    expect([await tray(laptop), await tray(tv), await tray(phone)]).toEqual([['for all'], ['for all'], []])
    // Nor can it be marked, put away or answered from there, nor is it pushed there
    expect(await code(phone.as.mutation(api.notifications.dismiss, { key: phone.key, ids: [sent.id] }))).toBe('not_found')
    vi.advanceTimersByTime(200_000)
    expect((await h.t.query(internal.push._targets, { notificationId: sent.id, now: Date.now() }))?.targets).toEqual([])
    // A display closed to agents after it was sent is shown none of it
    await laptop.as.mutation(api.displays.allowAgents, { displayId: tv.id, allowed: false })
    expect(await tray(tv)).toEqual([])
  })

  test('what went to every display stays in a display’s tray however many went to the others while it was closed to agents', async () => {
    const h = await household()
    const a = await h.browser('owner', key(1))
    const b = await h.browser('screen', key(2))
    const kept = await h.agent.mutation(api.notifications.send, { text: 'for both, kept up', sticky: true, everywhere: true })
    expect(kept.displayIds.sort()).toEqual([a.id, b.id].sort())
    await a.as.mutation(api.displays.allowAgents, { displayId: a.id, allowed: false })
    // Far more than a tray's worth, and more than any number of them a tray could read past, goes
    // to every display while the first is closed to agents, which is the second alone. Written as
    // a send writes them: the notification, and a row in the tray of each display it is for
    await h.t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      for (let i = 0; i < 1200; i++) {
        const createdAt = Date.now() + 1 + i
        const id = await ctx.db.insert('notifications', { userId: user._id, text: `for b ${i}`, sticky: false, to: [b.id], listed: true, createdAt })
        await ctx.db.insert('recipients', { userId: user._id, notificationId: id, displayId: b.id, createdAt })
      }
    })
    vi.advanceTimersByTime(1000)
    await a.as.mutation(api.displays.allowAgents, { displayId: a.id, allowed: true })
    expect(await tray(a)).toEqual(['for both, kept up'])
    const theirs = await tray(b)
    expect(theirs).toHaveLength(60)
    expect(theirs[0]).toBe('for b 1199')
    expect(theirs).not.toContain('for both, kept up')
    // Put away on one display, it is put away from every tray it was in
    await a.as.mutation(api.notifications.dismiss, { key: a.key, ids: [kept.id] })
    expect(await tray(a)).toEqual([])
    const rows = await h.t.run(async (ctx) => (await ctx.db.query('recipients').collect()).filter((r) => r.notificationId === kept.id))
    expect(rows.map((r) => r.dismissedAt !== undefined)).toEqual([true, true])
  })

  test('one sent to every display before trays had rows of their own still shows where it did, a tray’s worth at most', async () => {
    const h = await household()
    const a = await h.browser('owner', key(1))
    await h.t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      for (let i = 0; i < 70; i++)
        await ctx.db.insert('notifications', { userId: user._id, text: `from before ${i}`, sticky: false, createdAt: Date.now() + i })
    })
    vi.advanceTimersByTime(1000)
    const fresh = await h.agent.mutation(api.notifications.send, { text: 'new', everywhere: true })
    const shown = await tray(a)
    expect(shown).toHaveLength(60)
    expect(shown.slice(0, 2)).toEqual(['new', 'from before 69'])
    // Neither kind is shown to a display closed to agents
    await a.as.mutation(api.displays.allowAgents, { displayId: a.id, allowed: false })
    expect(await tray(a)).toEqual([])
    expect(fresh.displayIds).toEqual([a.id])
  })

  test('one an earlier It sent to every display, which kept no list of whom, is not shown on a display registered after it', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    await h.t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      await ctx.db.insert('notifications', { userId: user._id, text: 'from before', sticky: false, createdAt: Date.now() })
    })
    vi.advanceTimersByTime(1000)
    const tv = await h.browser('screen', key(2))
    expect([await tray(laptop), await tray(tv)]).toEqual([['from before'], []])
  })

  test('to a name two displays share, nothing is sent, and the refusal says to name one by its id', async () => {
    const h = await household()
    const a = await h.browser('owner', key(1))
    const b = await h.browser('screen', key(2))
    await h.t.run(async (ctx) => {
      await ctx.db.patch(a.id, { name: 'TV' })
      await ctx.db.patch(b.id, { name: 'TV' })
    })
    const said = await refused(h.agent.mutation(api.notifications.send, { text: 'hi', display: 'tv' }))
    expect(said).toMatchObject({ code: 'conflict', sharedName: true })
    expect(String(said.message)).toContain('--on-id')
    expect(await h.t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([])
    // Each is reached by its id
    expect((await h.agent.mutation(api.notifications.send, { text: 'hi', displayId: b.id })).displayIds).toEqual([b.id])
  })

  test('a push is not sent to a display closed to agents after it was chosen, and the later look judges by its own time', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    await laptop.as.mutation(api.push.subscribe, { key: laptop.key, endpoint: PUSH('laptop'), p256dh: 'p', auth: 'a' })
    await tell(laptop, 1, true)
    const sent = await h.agent.mutation(api.notifications.send, { text: 'hi' })
    // Open now: nobody to push to. A few minutes on, with nothing written since, it is closed, and pushed
    expect((await h.t.query(internal.push._targets, { notificationId: sent.id, now: Date.now() }))?.targets).toEqual([])
    vi.advanceTimersByTime(200_000)
    const later = await h.t.query(internal.push._targets, { notificationId: sent.id, now: Date.now() })
    expect(later?.targets.map((x: { displayId: string }) => x.displayId)).toEqual([laptop.id])
    await laptop.as.mutation(api.displays.allowAgents, { displayId: laptop.id, allowed: false })
    expect(await h.t.query(internal.push._still, { notificationId: sent.id, displayId: laptop.id, endpoint: PUSH('laptop') })).toBe(false)
  })

  test('a push is not sent to a display closed to agents while its push was being signed, after the look before it', async () => {
    const h = await household()
    const laptop = await h.browser('owner', key(1))
    await laptop.as.mutation(api.push.subscribe, { key: laptop.key, endpoint: PUSH('laptop'), p256dh: 'p', auth: 'a' })
    const sent = await h.agent.mutation(api.notifications.send, { text: 'hi' })
    // Its own two looks, at once and a few minutes on, are over before anything here
    await h.t.finishAllScheduledFunctions(vi.runAllTimers)
    // The service on this machine, which passes a push on, and says the push service took it
    const pushed: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).endsWith('/internal/push')) pushed.push(JSON.parse(String(init.body)).subscription.endpoint)
        return new Response(JSON.stringify({ status: 201 }))
      }),
    )
    // Asked now, the push would go: the display is closed and takes notifications
    expect(await h.t.query(internal.push._still, { notificationId: sent.id, displayId: laptop.id, endpoint: PUSH('laptop') })).toBe(true)
    // The person closes the display to agents while the push is being signed, which is after
    // the push was chosen and after the display was last looked at in an order that looked first
    await h.t.run(async (ctx) => {
      for (const k of await ctx.db.query('signingKeys').collect()) await ctx.db.delete(k._id)
    })
    const making = crypto.subtle.generateKey.bind(crypto.subtle)
    let closed = false
    vi.spyOn(crypto.subtle, 'generateKey').mockImplementation((async (...args: Parameters<typeof making>) => {
      if (!closed) {
        closed = true
        await laptop.as.mutation(api.displays.allowAgents, { displayId: laptop.id, allowed: false })
      }
      return making(...args)
    }) as typeof crypto.subtle.generateKey)
    expect(await h.t.action(internal.push.deliver, { notificationId: sent.id })).toBe(0)
    expect(closed).toBe(true)
    expect(pushed).toEqual([])
    // Open to agents again, it is pushed as before
    await laptop.as.mutation(api.displays.allowAgents, { displayId: laptop.id, allowed: true })
    expect(await h.t.action(internal.push.deliver, { notificationId: sent.id })).toBe(1)
    expect(pushed).toEqual([PUSH('laptop')])
  })
})
