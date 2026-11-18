/// <reference types="vite/client" />
// The order of clicks and stops, which the backend's clock does not decide. A person who stops a
// page's agent stops what was waiting for it by then, and what they do on the page afterwards is
// delivered: which of the two a click is, is told by the order the click and the stop were
// written in, so that a clock that is set back in between changes nothing. Every test goes
// through the functions a browser and a machine call, with the backend's clock set as the test says.
import { getFunctionName } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'
const KEY = 'display-key-of-the-laptop-0123456789'
const SESSION = { harness: 'claude-code', id: 'conversation-1' }
const OTHER = { harness: 'claude-code', id: 'conversation-2' }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type T = ReturnType<typeof convexTest>
const begun: T[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'))
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.useRealTimers()
})

/**
 * A backend with one person, a machine of theirs on which Auto-wake is on for Claude Code, a
 * browser of theirs, and one page that a conversation on that machine made.
 */
async function setup() {
  const t = convexTest(schema, modules)
  begun.push(t)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const machineId = made.machineId as Id<'machines'>
  const { user, session } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const now = Date.now()
    await ctx.db.patch(machineId, { system: 'linux', wanted: ['claude-code'], harnesses: [{ id: 'claude-code', addon: 'connected' }] })
    const session = await ctx.db.insert('sessions', {
      userId: user._id,
      secretHash: 'no-secret',
      role: 'owner',
      createdAt: now,
      lastSeenAt: now,
      cookieAt: now,
    })
    return { user: user._id, session }
  })
  /** A page of a conversation on the machine, as publishing leaves it. */
  const pageOf = (slug: string, of = SESSION) =>
    t.run((ctx) =>
      ctx.db.insert('artifacts', {
        userId: user,
        slug,
        title: slug,
        currentVersion: 1,
        lastVersion: 1,
        bytes: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        machineId,
        session: of,
        agent: of.harness,
      }),
    )
  const page = await pageOf('plan')
  const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role: 'owner' })
  const mutation = browser.mutation
  // As the site does: a click is sent with the deadline the backend gave for sending it again,
  // and a stop names the run the person was shown
  browser.mutation = (async (fn, args) => {
    if (getFunctionName(fn) === 'actions:submit') return mutation(fn, { ...args, replayUntil: (await mutation(api.actions.replayGrant, {})).until })
    if (getFunctionName(fn) === 'artifacts:stop') {
      const shown = await browser.query(api.artifacts.get, args as { artifactId: Id<'artifacts'> })
      return mutation(fn, { ...args, expectedRun: shown.run?.identity })
    }
    return mutation(fn, args)
  }) as typeof mutation
  const machine = t.withIdentity({ issuer: SITE, subject: machineId, kind: 'machine' })
  await browser.mutation(api.displays.register, { key: KEY, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0.0.0 Safari/537.36' })
  await browser.mutation(api.machines.wake, { machineId, harness: 'claude-code', on: true })
  let clicks = 0
  /** Something the person does on a page, sent by their browser: at once, or saying when it was made where the browser held it. */
  const click = async (on = page, held?: { madeAt: number; madeWithin?: number }) =>
    (
      await browser.mutation(api.actions.submit, {
        artifactId: on,
        displayKey: KEY,
        envelope: { v: 1, clientActionId: `click-${String(++clicks).padStart(6, '0')}`, name: 'approve', payload: '{"n":1}', contentVersion: 1 },
        ...(held ? { madeAt: held.madeAt, madeWithin: held.madeWithin ?? 0 } : {}),
      })
    ).actionId as Id<'actions'>
  /** The machine reopens the page's conversation, and the person stops it from the page. */
  const run = (of = SESSION) => machine.mutation(api.machines.runBegan, { modes: ['claude-code'], for: of })
  const stop = async (on = page) => expect(await browser.mutation(api.artifacts.stop, { artifactId: on })).toEqual({ stopping: true })
  const row = async (id: Id<'actions'>) => (await t.run((ctx) => ctx.db.get(id)))!
  const stoppedOf = async (ids: Id<'actions'>[]) => Promise.all(ids.map(async (id) => (await row(id)).route === 'stopped'))
  /**
   * What every way of offering clicks to a machine gives: to a conversation that is open, to one
   * that may be reopened, and a page at a time. Which clicks, and not in which order: each way
   * orders them by their times, which a clock that was set back makes another order.
   */
  const offered = async (of = SESSION) => ({
    listening: (await machine.query(api.delivery.inbox, { listening: [of], queues: [] })).map((c) => c.id).sort(),
    reopened: (await machine.query(api.delivery.inbox, { listening: [], queues: [of.harness] }))
      .filter((c) => c.session?.id === of.id)
      .map((c) => c.id)
      .sort(),
    paged: (await machine.query(api.delivery.inboxPage, { listening: [], queues: [of.harness], after: [] })).clicks
      .filter((c) => c.session?.id === of.id)
      .map((c) => c.id)
      .sort(),
  })
  const everyWay = (ids: Id<'actions'>[]) => ({ listening: [...ids].sort(), reopened: [...ids].sort(), paged: [...ids].sort() })
  /** The stop the machine keeps for the conversation. */
  const stopOf = async (of = SESSION) => (await t.run((ctx) => ctx.db.get(machineId)))!.stops!.find((s) => s.harness === of.harness && s.sessionId === of.id)!
  /** Every step a function scheduled, run to the end with the clock where the test left it. */
  const settle = async () => {
    const now = Date.now()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.setSystemTime(now)
  }
  /** The clock of the machine the backend runs on is corrected. */
  const setClock = (by: number) => vi.setSystemTime(Date.now() + by)
  /** A click as It before clicks had a place in the order kept it: waiting, with none. */
  const legacyClick = (on: Id<'artifacts'>, at: number, of = SESSION) =>
    t.run(async (ctx) => {
      const a = (await ctx.db.get(on))!
      const id = await ctx.db.insert('actions', {
        userId: user,
        artifactId: on,
        clientActionId: `legacy-${String(++clicks).padStart(6, '0')}`,
        name: 'approve',
        payload: '{"n":1}',
        contentVersion: 1,
        title: a.title,
        createdAt: at,
        madeAt: at,
        delivery: 'pending',
        machineId,
        harness: of.harness,
        sessionId: of.id,
        seq: (a.actionSeq ?? 0) + 1,
      })
      await ctx.db.patch(on, { waiting: (a.waiting ?? 0) + 1, actionSeq: (a.actionSeq ?? 0) + 1 })
      const tally = await ctx.db.query('tallies').first()
      if (tally) await ctx.db.patch(tally._id, { waiting: tally.waiting + 1 })
      else await ctx.db.insert('tallies', { userId: user, waiting: 1, stagingCount: 0, stagingBytes: 0 })
      return id
    })
  return { t, user, machineId, page, pageOf, browser, machine, click, run, stop, stopOf, row, stoppedOf, offered, everyWay, settle, setClock, legacyClick }
}

describe('the order of clicks and stops, which the clock does not decide', () => {
  test('a click made after Stop is delivered though the backend’s clock was set back past the stop, and what was waiting at the stop is not', async () => {
    const { machine, browser, page, click, run, stop, row, offered, everyWay, settle, setClock } = await setup()
    await run()
    const before = await click()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    await stop()
    await settle()
    expect(await row(before)).toMatchObject({ delivery: 'handed_off', route: 'stopped' })
    // A minute later the clock of the machine It runs on is corrected by an hour, backward: from
    // now on every time it gives is earlier than the stop's
    await vi.advanceTimersByTimeAsync(MINUTE)
    setClock(-HOUR)
    const stopped = (await browser.query(api.artifacts.get, { artifactId: page })).stoppedAt!
    expect(Date.now()).toBeLessThan(stopped)
    // The person does something more on the page. It carries an earlier time than the stop, and was done after it
    const after = await click()
    expect((await row(after)).createdAt).toBeLessThan(stopped)
    expect(await row(after)).toMatchObject({ delivery: 'pending' })
    expect((await row(after)).route).toBeUndefined()
    // It is offered by every way a click is, a machine may take it, and it is handed over
    expect(await offered()).toEqual(everyWay([after]))
    expect(await machine.mutation(api.machines.runBegan, { modes: ['claude-code'], for: SESSION, ids: [after] })).toMatchObject({ stopped: false })
    expect(await machine.mutation(api.delivery.claim, { ids: [after], for: SESSION })).toEqual([after])
    expect(await machine.mutation(api.delivery.renew, { ids: [after] })).toEqual([after])
    expect(await machine.mutation(api.delivery.handedOff, { id: after, route: 'addon' })).toMatchObject({ already: false })
    expect(await row(after)).toMatchObject({ delivery: 'handed_off', route: 'addon' })
    // And the page tells the two apart by their places: the one before the stop went with it, and the one after did not
    const shown = await browser.query(api.artifacts.get, { artifactId: page })
    const recent = await browser.query(api.actions.forArtifact, { artifactId: page })
    expect(recent.map((x) => x.id)).toEqual([after, before])
    expect(recent[0]!.sequence!).toBeGreaterThan(shown.stoppedSequence!)
    expect(recent[1]).toMatchObject({ route: 'stopped', stoppedSequence: shown.stoppedSequence })
    expect(recent[1]!.sequence!).toBeLessThan(shown.stoppedSequence!)
  })

  test('of a click, a stop and a click in the same millisecond, the first goes with the stop and the second is delivered', async () => {
    const { machine, click, run, stop, stopOf, stoppedOf, offered, everyWay, settle, row } = await setup()
    await run()
    const first = await click()
    await stop()
    const second = await click()
    await settle()
    expect(new Set([(await row(first)).createdAt, (await row(second)).createdAt, (await stopOf()).at]).size).toBe(1)
    expect(await stoppedOf([first, second])).toEqual([true, false])
    expect(await offered()).toEqual(everyWay([second]))
    expect(await machine.mutation(api.delivery.claim, { ids: [first, second], for: SESSION })).toEqual([second])
  })

  test('a stop drops all that was waiting in steps that go by its place in the order, though the clock is set back a day between them, and nothing made since', async () => {
    const { t, machine, page, click, run, stop, stopOf, row, offered, everyWay, settle, setClock, legacyClick, pageOf } = await setup()
    const second = await pageOf('second')
    await run()
    // More than one step drops, on two pages of the conversation: some from before clicks had a place in the order
    const waiting: Id<'actions'>[] = []
    for (let i = 0; i < 120; i++) waiting.push(await legacyClick(i % 2 ? second : page, Date.now() - HOUR + i))
    for (let i = 0; i < 130; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      waiting.push(await click(i % 2 ? second : page))
    }
    // One of them a machine has in hand
    expect(await machine.mutation(api.delivery.claim, { ids: [waiting.at(-1)!], for: SESSION })).toEqual([waiting.at(-1)])
    await stop()
    // The stop's own step dropped a hundred. Before the rest of its steps run, the clock is set back a day, and the person does two things more
    const droppedAtOnce = (await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.route === 'stopped').length
    expect(droppedAtOnce).toBe(100)
    setClock(-DAY)
    const after = [await click(page), await click(second)]
    // What the steps have not come to yet is given to nobody meanwhile, and what was made since is
    expect((await offered()).listening).toEqual(after)
    expect(await machine.mutation(api.delivery.claim, { ids: [waiting.find((id) => !after.includes(id))!, waiting.at(-2)!], for: SESSION })).toEqual([])
    await settle()
    const all = await t.run((ctx) => ctx.db.query('actions').collect())
    expect(
      all
        .filter((x) => x.route === 'stopped')
        .map((x) => x._id)
        .sort(),
    ).toEqual([...waiting].sort())
    for (const id of after) expect(await row(id)).toMatchObject({ delivery: 'pending' })
    expect(await offered()).toEqual(everyWay(after))
    // What went with the stop says which stop, and counts as waiting nowhere
    expect(new Set(all.filter((x) => x.route === 'stopped').map((x) => x.stoppedSequence))).toEqual(new Set([(await stopOf()).sequence]))
    expect((await t.run((ctx) => ctx.db.get(page)))!.waiting).toBe(1)
    expect((await t.run((ctx) => ctx.db.get(second)))!.waiting).toBe(1)
    expect((await t.run((ctx) => ctx.db.query('tallies').first()))!.waiting).toBe(2)
  })

  test('a click a browser held from before Stop still goes with the stop when it arrives, one made after it is delivered, and so is one that arrives once the clock was set back', async () => {
    const { click, run, stop, stoppedOf, offered, everyWay, settle, setClock } = await setup()
    await run()
    const made = Date.now()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    await stop()
    await settle()
    const stopped = Date.now()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    // Held in the browser since before the stop, since a minute after it, and since its very moment
    const before = await click(undefined, { madeAt: made })
    const at = await click(undefined, { madeAt: stopped })
    const since = await click(undefined, { madeAt: stopped + MINUTE })
    expect(await stoppedOf([before, at, since])).toEqual([true, true, false])
    // The clock is set back past the stop. What a browser now sends with a time before the stop
    // may have been made after it, by a clock that no longer agrees with the one the stop was
    // noted by: it is delivered
    setClock(-HOUR)
    const unsure = await click(undefined, { madeAt: Date.now() - MINUTE })
    expect(await stoppedOf([unsure])).toEqual([false])
    expect(await offered()).toEqual(everyWay([since, unsure]))
  })

  test('a page that changes hands after a stop takes along what was done on it since, though the clock was set back, and nothing from before', async () => {
    const { t, machine, page, click, run, stop, stoppedOf, offered, everyWay, settle, setClock } = await setup()
    await run()
    const before = [await click(), await click()]
    // The stop's steps have come to neither yet when the page is taken over by another conversation
    await t.run(async (ctx) => {
      for (const id of before) await ctx.db.patch(id, { machineId: undefined })
    })
    await stop()
    setClock(-HOUR)
    const after = await click()
    await t.run((ctx) => ctx.db.patch(page, { session: OTHER }))
    await t.mutation(internal.actions.readdress, { artifactId: page })
    await settle()
    expect(await stoppedOf([...before, after])).toEqual([true, true, false])
    expect(await offered(OTHER)).toEqual(everyWay([after]))
    expect(await machine.mutation(api.delivery.claim, { ids: [...before, after], for: OTHER })).toEqual([after])
  })
})

describe('clicks and stops kept before they had a place in the order', () => {
  test('a click that was waiting when It was brought up to date is delivered once, and a stop made since takes one that is still waiting', async () => {
    const { machine, page, click, run, stop, row, stoppedOf, offered, everyWay, settle, legacyClick } = await setup()
    const waited = [await legacyClick(page, Date.now() - HOUR), await legacyClick(page, Date.now() - HOUR + 1)]
    expect((await row(waited[0]!)).sequence).toBeUndefined()
    // It is offered as it was, taken, and handed over, and a second word of the hand-over is the same one
    expect(await offered()).toEqual(everyWay(waited))
    expect(await machine.mutation(api.delivery.claim, { ids: [waited[0]!], for: SESSION })).toEqual([waited[0]])
    expect(await machine.mutation(api.delivery.handedOff, { id: waited[0]!, route: 'addon' })).toMatchObject({ already: false })
    expect(await machine.mutation(api.delivery.handedOff, { id: waited[0]!, route: 'addon' })).toMatchObject({ already: true })
    expect(await machine.mutation(api.delivery.claim, { ids: [waited[0]!], for: SESSION })).toEqual([])
    expect(await offered()).toEqual(everyWay([waited[1]!]))
    // The other is still waiting when the person stops the conversation: it was there before the stop, and goes with it
    await run()
    await stop()
    await settle()
    const after = await click()
    expect(await stoppedOf([waited[0]!, waited[1]!, after])).toEqual([false, true, false])
    expect(await row(waited[0]!)).toMatchObject({ delivery: 'handed_off', route: 'addon' })
    expect(await offered()).toEqual(everyWay([after]))
  })

  test('a stop from before stops had a place takes what was made up to it by the clock, as it did, and nothing made since, also once the clock was set back', async () => {
    const { t, machine, machineId, user, page, click, stoppedOf, offered, everyWay, setClock, legacyClick, browser } = await setup()
    // As It before this kept them: a stop noted by its time alone, with the page and with the
    // machine, a click from before it that its steps have not come to, and one made after it
    const stopped = Date.now() - 10 * MINUTE
    const before = await legacyClick(page, stopped - MINUTE)
    const since = await legacyClick(page, stopped + MINUTE)
    await t.run(async (ctx) => {
      await ctx.db.patch(machineId, { stops: [{ harness: SESSION.harness, sessionId: SESSION.id, at: stopped }] })
      await ctx.db.patch(page, { stoppedThrough: stopped })
    })
    expect(await browser.query(api.artifacts.get, { artifactId: page })).toMatchObject({ stoppedAt: stopped, stoppedSequence: null })
    expect(await offered()).toMatchObject({ reopened: [since], paged: [since] })
    expect(await machine.mutation(api.delivery.claim, { ids: [before, since], for: SESSION })).toEqual([since])
    expect(await stoppedOf([before, since])).toEqual([true, false])
    await machine.mutation(api.delivery.release, { id: since })
    // The step of that stop that was still to run when It was brought up to date carries no
    // place. It takes what is left of that time, and nothing that has a place, whatever the clock says
    setClock(-HOUR)
    const late = await legacyClick(page, stopped - 2 * MINUTE)
    const after = await click()
    await t.mutation(internal.artifacts.dropRest, { userId: user, machineId, session: SESSION, at: stopped, artifactId: page })
    expect(await stoppedOf([late, since, after])).toEqual([true, false, false])
    expect(await offered()).toEqual(everyWay([since, after]))
    expect(await machine.mutation(api.delivery.claim, { ids: [since, after], for: SESSION })).toEqual([since, after])
  })
})
