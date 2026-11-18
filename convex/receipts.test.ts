/// <reference types="vite/client" />
// What a machine says of a click is said of one taking of it, and of no other. A machine that
// takes a click to hand it over makes a receipt for that taking, and keeps the hold, gives the
// click back, sets it aside and says it was handed over by that receipt: a word that arrives
// late, once the click has been taken again, also by the same machine, says nothing of the later
// taking. And a setting aside that was decided before the click's conversation was heard from
// again sets nothing aside. Every test goes through the functions a browser and a machine call.
import { LEASE_MS } from '@it/protocol'
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
const DAY = 86_400_000
/** Receipts as a machine makes them: one for each taking. */
const R1 = 'receipt-of-the-first-taking-0001'
const R2 = 'receipt-of-the-second-taking-002'
const R3 = 'receipt-of-the-third-taking-0003'

type T = ReturnType<typeof convexTest>
const begun: T[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'))
  // The content service, which erasing asks to remove a person's files: it says they are gone
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, removed: 1, more: false, epoch: 0 }))),
  )
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A backend with one person, two machines of theirs, a browser of theirs, and one page that a conversation on the first machine made. */
async function setup() {
  const t = convexTest(schema, modules)
  begun.push(t)
  let keys = 0
  const enrol = async (name: string) => {
    const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name, publicKey: { kty: 'EC', crv: 'P-256', x: `x${++keys}`, y: 'y' } })
    if ('error' in made) throw new Error(made.error)
    const id = made.machineId as Id<'machines'>
    await t.run((ctx) => ctx.db.patch(id, { system: 'linux', wanted: ['claude-code'], harnesses: [{ id: 'claude-code', addon: 'connected' }] }))
    return { id, as: t.withIdentity({ issuer: SITE, subject: id, kind: 'machine' }) }
  }
  const laptop = await enrol('laptop')
  const desktop = await enrol('desktop')
  const { user, session } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const now = Date.now()
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
  const pageOf = (slug: string, of = SESSION, machineId = laptop.id) =>
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
  // As the site does: a click is sent with the deadline the backend gave for sending it again
  browser.mutation = (async (fn, args) => {
    if (getFunctionName(fn) === 'actions:submit') return mutation(fn, { ...args, replayUntil: (await mutation(api.actions.replayGrant, {})).until })
    if (getFunctionName(fn) === 'artifacts:stop') {
      const shown = await browser.query(api.artifacts.get, args as { artifactId: Id<'artifacts'> })
      return mutation(fn, { ...args, expectedRun: shown.run?.identity })
    }
    return mutation(fn, args)
  }) as typeof mutation
  await browser.mutation(api.displays.register, { key: KEY, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0.0.0 Safari/537.36' })
  let clicks = 0
  const click = async (on = page) => {
    // Clicks made one after another, each a moment after the last
    await vi.advanceTimersByTimeAsync(10)
    return (
      await browser.mutation(api.actions.submit, {
        artifactId: on,
        displayKey: KEY,
        envelope: { v: 1, clientActionId: `click-${String(++clicks).padStart(6, '0')}`, name: 'approve', payload: '{"n":1}', contentVersion: 1 },
      })
    ).actionId as Id<'actions'>
  }
  const row = async (id: Id<'actions'>) => (await t.run((ctx) => ctx.db.get(id)))!
  /** What a connector with the conversation listening is offered. */
  const offered = async (m = laptop, of = SESSION) => (await m.as.query(api.delivery.inbox, { listening: [of], queues: [] })).map((c) => c.id)
  /** The code a call is refused with, or `ok`. */
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => /"code":"([a-z_]+)"/.exec(`${JSON.stringify((e as { data?: unknown }).data)} ${String(e)}`)?.[1] ?? `threw: ${String(e).slice(0, 80)}`,
    )
  /** Every step a function scheduled, run to the end. */
  const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers)
  /** The hold on a click runs out, and the minute's sweep puts it back to waiting. */
  const expire = async () => {
    await vi.advanceTimersByTimeAsync(LEASE_MS + 1000)
    await t.mutation(internal.delivery.reap, {})
  }
  /** A click as 0.1.45 kept it, with nothing of a taking or of when it was set aside. */
  const legacyClick = (over: Record<string, unknown> = {}, on = page) =>
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
        createdAt: Date.now(),
        madeAt: Date.now(),
        delivery: 'pending',
        machineId: laptop.id,
        harness: a.session!.harness,
        sessionId: a.session!.id,
        seq: (a.actionSeq ?? 0) + 1,
        ...over,
      } as never)
      await ctx.db.patch(on, { waiting: (a.waiting ?? 0) + 1, actionSeq: (a.actionSeq ?? 0) + 1 })
      const tally = await ctx.db.query('tallies').first()
      if (tally) await ctx.db.patch(tally._id, { waiting: tally.waiting + 1 })
      else await ctx.db.insert('tallies', { userId: user, waiting: 1, stagingCount: 0, stagingBytes: 0 })
      return id as Id<'actions'>
    })
  const returns = () => t.run((ctx) => ctx.db.query('deliveryReturns').collect())
  return { t, user, laptop, desktop, page, pageOf, browser, click, row, offered, code, settle, expire, legacyClick, returns }
}

describe('receipts, by which each taking of a click is told from every other', () => {
  test('a click whose hold ran out and that the same machine took again is kept, given back, set aside and confirmed by the second taking alone', async () => {
    const { laptop, click, row, code, expire } = await setup()
    const id = await click()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R1 })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [id], receipts: [{ id, receipt: R1 }] })).toEqual([id])
    await expire()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R2 })).toEqual([id])
    // What the first taking says now, late, changes nothing of the second: it does not keep the
    // hold, give the click back, set it aside or say that it was handed over
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [id], receipts: [{ id, receipt: R1 }] })).toEqual([])
    expect(await laptop.as.query(api.delivery.lost, { ids: [id], receipts: [{ id, receipt: R1 }] })).toEqual([id])
    await laptop.as.mutation(api.delivery.release, { id, receipt: R1 })
    expect(await laptop.as.mutation(api.delivery.park, { id, receipt: R1, for: SESSION, all: true })).toBe('again')
    expect(await code(laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R1 }))).toBe('conflict')
    expect(await row(id)).toMatchObject({ delivery: 'leased', leaseMachineId: laptop.id, claim: { receipt: R2, machineId: laptop.id, session: SESSION } })
    expect((await row(id)).parkedBy).toBeUndefined()
    // The second taking holds it, is not said to have lost it, and hands it over
    expect(await laptop.as.query(api.delivery.lost, { ids: [id], receipts: [{ id, receipt: R2 }] })).toEqual([])
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [id], receipts: [{ id, receipt: R2 }] })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R2 })).toMatchObject({ already: false })
    // Said again by the receipt it was handed over by, it is the same hand-over, and by the earlier one it is still another's
    expect(await laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R2 })).toMatchObject({ already: true })
    expect(await code(laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R1 }))).toBe('conflict')
    expect(await row(id)).toMatchObject({ delivery: 'handed_off', route: 'addon' })
  })

  test('a taking asked for again under its receipt, as after an answer that was lost, is the same taking, and is not made afresh once its hold is over', async () => {
    const { laptop, desktop, click, row, expire } = await setup()
    const [a, b] = [await click(), await click()]
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [a, b], for: SESSION, receipt: R1 })).toEqual([a, b])
    const until = (await row(a)).leaseExpiresAt
    await vi.advanceTimersByTimeAsync(5000)
    // The answer was lost, and the machine asks again: it holds both still, under the hold it had
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [a, b], for: SESSION, receipt: R1 })).toEqual([a, b])
    expect((await row(a)).leaseExpiresAt).toBe(until)
    // Another machine, or another taking of this one, is told it is held
    expect(await desktop.as.mutation(api.delivery.claim, { ids: [a], receipt: R2 })).toEqual([])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [a], for: SESSION, receipt: R3 })).toEqual([])
    // Given back, or with its hold run out, the taking is over: asked for again under its receipt it is not made afresh
    await laptop.as.mutation(api.delivery.release, { id: a, receipt: R1 })
    expect(await row(a)).toMatchObject({ delivery: 'pending' })
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [a], for: SESSION, receipt: R1 })).toEqual([])
    await expire()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [b], for: SESSION, receipt: R1 })).toEqual([])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [a, b], for: SESSION, receipt: R3 })).toEqual([a, b])
    // What is no receipt is refused as that
    await expect(laptop.as.mutation(api.delivery.claim, { ids: [a], receipt: 'short' })).rejects.toThrow()
  })

  test('a late word of a taking says nothing of a click that went on to another conversation or another machine and was taken there', async () => {
    const { t, laptop, desktop, page, click, row, code, expire } = await setup()
    const [toOther, toDesktop] = [await click(), await click()]
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [toOther, toDesktop], for: SESSION, receipt: R1 })).toEqual([toOther, toDesktop])
    await expire()
    // The page is taken over by another conversation on the same machine, which takes the first click
    await t.run((ctx) => ctx.db.patch(page, { session: OTHER }))
    await t.mutation(internal.actions.readdress, { artifactId: page })
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [toOther], for: OTHER, receipt: R2 })).toEqual([toOther])
    // And then by a conversation on another machine, which takes the second
    await t.run((ctx) => ctx.db.patch(page, { machineId: desktop.id, session: SESSION }))
    await t.mutation(internal.actions.readdress, { artifactId: page })
    expect(await desktop.as.mutation(api.delivery.claim, { ids: [toDesktop], for: SESSION, receipt: R3 })).toEqual([toDesktop])
    for (const id of [toOther, toDesktop]) {
      expect(await laptop.as.mutation(api.delivery.renew, { ids: [id], receipts: [{ id, receipt: R1 }] })).toEqual([])
      await laptop.as.mutation(api.delivery.release, { id, receipt: R1 })
      expect(await code(laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R1 }))).toBe('conflict')
      expect(await laptop.as.query(api.delivery.lost, { ids: [id], receipts: [{ id, receipt: R1 }] })).toEqual([id])
    }
    // Nor does one machine's receipt count in another's mouth
    expect(await code(laptop.as.mutation(api.delivery.handedOff, { id: toDesktop, route: 'addon', receipt: R3 }))).toBe('conflict')
    expect(await row(toOther)).toMatchObject({ delivery: 'leased', claim: { receipt: R2, session: OTHER } })
    expect(await row(toDesktop)).toMatchObject({ delivery: 'leased', leaseMachineId: desktop.id, claim: { receipt: R3, machineId: desktop.id } })
  })

  test('a connector that starts again confirms by its receipt what the one before handed over, and not once the click was taken again', async () => {
    const { laptop, click, row, code, offered } = await setup()
    const [handed, retaken] = [await click(), await click()]
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [handed], for: SESSION, receipt: R1 })).toEqual([handed])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [retaken], for: SESSION, receipt: R2 })).toEqual([retaken])
    // Both were handed to their agent, and the connector ended before it told It. The one that
    // starts gives back whatever this machine holds, as every one does
    expect((await laptop.as.mutation(api.delivery.giveBackBatch, {})).back.sort()).toEqual([handed, retaken].sort())
    expect(await row(handed)).toMatchObject({ delivery: 'pending', claim: { receipt: R1 } })
    // It kept the receipts, and tells It by them. Nothing has taken the first click since: that hand-over counts
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: handed, route: 'queue', receipt: R1 })).toMatchObject({ already: false })
    expect(await row(handed)).toMatchObject({ delivery: 'handed_off', route: 'queue', handedBy: laptop.id })
    // The second was taken again before the word of it came, by an agent waiting for it: the earlier hand-over is not that taking's
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [retaken], for: SESSION, receipt: R3 })).toEqual([retaken])
    expect(await code(laptop.as.mutation(api.delivery.handedOff, { id: retaken, route: 'queue', receipt: R2 }))).toBe('conflict')
    expect(await row(retaken)).toMatchObject({ delivery: 'leased', claim: { receipt: R3 } })
    expect(await offered()).toEqual([])
  })

  test('a click held under a receipt is given out no more once its conversation is stopped, though the stop’s steps have not come to it yet', async () => {
    const { t, laptop, browser, page, click, row, legacyClick } = await setup()
    await browser.mutation(api.machines.wake, { machineId: laptop.id, harness: 'claude-code', on: true })
    await laptop.as.mutation(api.machines.runBegan, { modes: ['claude-code'], for: SESSION })
    // More is waiting than the stop's own step drops, and the two held clicks are the last it would come to
    for (let i = 0; i < 120; i++) await legacyClick()
    const [asked, renewed] = [await click(), await click()]
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [asked], for: SESSION, receipt: R1 })).toEqual([asked])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [renewed], for: SESSION, receipt: R2 })).toEqual([renewed])
    expect(await browser.mutation(api.artifacts.stop, { artifactId: page })).toEqual({ stopping: true })
    expect((await row(asked)).delivery).toBe('leased')
    expect((await row(renewed)).delivery).toBe('leased')
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [asked], for: SESSION, receipt: R1 })).toEqual([])
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [renewed], receipts: [{ id: renewed, receipt: R2 }] })).toEqual([])
    for (const id of [asked, renewed]) expect(await row(id)).toMatchObject({ delivery: 'handed_off', route: 'stopped' })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  })
})

describe('a machine or a click from before receipts', () => {
  test('a machine that names no receipt goes on as it did with what it took, and what it says changes nothing of a click taken with one, but for it ack', async () => {
    const { laptop, desktop, click, row, code, expire } = await setup()
    const [own, given, aside, receipted, acked] = [await click(), await click(), await click(), await click(), await click()]
    // An It from before receipts, on a machine that joined this one: it takes, keeps, gives back, sets aside and confirms as it always did
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [own, given, aside], for: SESSION })).toEqual([own, given, aside])
    expect(await row(own)).toMatchObject({ delivery: 'leased', claim: { machineId: laptop.id, session: SESSION } })
    expect((await row(own)).claim?.receipt).toBeUndefined()
    expect(await laptop.as.mutation(api.delivery.renew, { ids: [own, given, aside] })).toEqual([own, given, aside])
    expect(await laptop.as.query(api.delivery.lost, { ids: [own] })).toEqual([])
    await laptop.as.mutation(api.delivery.release, { id: given })
    expect(await row(given)).toMatchObject({ delivery: 'pending' })
    expect(await laptop.as.mutation(api.delivery.park, { id: aside, for: SESSION })).toBe(true)
    expect(await row(aside)).toMatchObject({ delivery: 'pending', parkedBy: laptop.id })
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: own, route: 'addon' })).toMatchObject({ already: false })
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: own, route: 'addon' })).toMatchObject({ already: true })
    // A click taken with a receipt, on the same machine (by an agent waiting there with a newer It, say): nothing said
    // without one keeps it, gives it back, sets it aside or confirms it, while it is held, once its hold ran out, or once it was given back
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [receipted, acked], for: SESSION, receipt: R1 })).toEqual([receipted, acked])
    const untouched = async () => {
      expect(await laptop.as.mutation(api.delivery.renew, { ids: [receipted] })).toEqual([])
      await laptop.as.mutation(api.delivery.release, { id: receipted })
      // Answered as it can read: that the click is not its to set aside. Nothing is set aside
      expect(await laptop.as.mutation(api.delivery.park, { id: receipted, for: SESSION, all: true })).toBe(true)
      expect(await code(laptop.as.mutation(api.delivery.handedOff, { id: receipted, route: 'addon' }))).toBe('conflict')
      expect((await row(receipted)).claim?.receipt).toBe(R1)
      expect((await row(receipted)).parkedBy).toBeUndefined()
      expect((await row(receipted)).route).toBeUndefined()
    }
    await untouched()
    expect((await row(receipted)).delivery).toBe('leased')
    await expire()
    await untouched()
    expect((await row(receipted)).delivery).toBe('pending')
    // Once nothing holds it, that machine may take it afresh, as any machine may, and it is then its own
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [receipted], for: SESSION })).toEqual([receipted])
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: receipted, route: 'addon' })).toMatchObject({ already: false })
    // And the late word of the taking it replaced is refused, as any earlier taking's is
    expect(await code(laptop.as.mutation(api.delivery.handedOff, { id: receipted, route: 'addon', receipt: R1 }))).toBe('conflict')
    // An agent or a person saying with `it ack` that they have a click needs no receipt: on the
    // machine that holds it, and on another of the person's once the hand-over is made
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [acked], for: SESSION, receipt: R2 })).toEqual([acked])
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: acked, route: 'manual' })).toMatchObject({ already: false })
    expect(await row(acked)).toMatchObject({ delivery: 'handed_off', route: 'manual' })
    expect(await desktop.as.mutation(api.delivery.handedOff, { id: acked, route: 'manual' })).toMatchObject({ already: true })
  })

  test('what 0.1.45 left on its way is delivered once after the update: a click that waited, one a machine held, and one handed over and not yet confirmed', async () => {
    const { laptop, row, offered, legacyClick } = await setup()
    const waited = await legacyClick()
    const held = await legacyClick({ delivery: 'leased', leaseMachineId: laptop.id, leaseExpiresAt: Date.now() + LEASE_MS })
    const unconfirmed = await legacyClick({ delivery: 'leased', leaseMachineId: laptop.id, leaseExpiresAt: Date.now() + LEASE_MS })
    for (const id of [waited, held, unconfirmed]) expect((await row(id)).claim).toBeUndefined()
    // The connector that starts after the update gives back what the one before held, and what
    // that one had handed over and not confirmed it confirms with no receipt, since none was kept
    expect((await laptop.as.mutation(api.delivery.giveBackBatch, {})).back.sort()).toEqual([held, unconfirmed].sort())
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: unconfirmed, route: 'queue' })).toMatchObject({ already: false })
    expect(await laptop.as.mutation(api.delivery.handedOff, { id: unconfirmed, route: 'queue' })).toMatchObject({ already: true })
    // The other two are offered again, taken with a receipt, and handed over once
    expect((await offered()).sort()).toEqual([waited, held].sort())
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [waited, held], for: SESSION, receipt: R1 })).toEqual([waited, held])
    for (const id of [waited, held]) {
      expect(await laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R1 })).toMatchObject({ already: false })
      expect(await laptop.as.mutation(api.delivery.handedOff, { id, route: 'addon', receipt: R1 })).toMatchObject({ already: true })
    }
    expect(await offered()).toEqual([])
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [waited, held, unconfirmed], for: SESSION, receipt: R2 })).toEqual([])
  })
})

describe('setting aside and giving back, when a conversation comes back while a delivery is ending', () => {
  test('a delivery that gives up after its conversation was heard from again sets nothing aside, and the click is tried afresh', async () => {
    const { laptop, click, row, offered } = await setup()
    const id = await click()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R1 })).toEqual([id])
    // The delivery is about to give up. Meanwhile the person opens the conversation, and its
    // connector asks for what was set aside for it: there is nothing yet
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(0)
    // And now the delivery that was ending says it gave up, with everything else to be set aside too
    expect(await laptop.as.mutation(api.delivery.park, { id, receipt: R1, for: SESSION, all: true })).toBe('again')
    expect(await row(id)).toMatchObject({ delivery: 'pending', machineId: laptop.id })
    expect((await row(id)).parkedBy).toBeUndefined()
    expect(await offered()).toEqual([id])
    // Taken afresh under the time that is now the last, a delivery that gives up again does set it aside
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R2 })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.park, { id, receipt: R2, for: SESSION })).toBe(true)
    expect(await row(id)).toMatchObject({ delivery: 'pending', parkedBy: laptop.id })
    expect(await offered()).toEqual([])
  })

  test('a click set aside before its conversation is heard from again is given back when it is', async () => {
    const { laptop, click, row, offered, returns } = await setup()
    const id = await click()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R1 })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.park, { id, receipt: R1, for: SESSION })).toBe(true)
    expect(await offered()).toEqual([])
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(1)
    expect(await row(id)).toMatchObject({ delivery: 'pending', machineId: laptop.id })
    expect((await row(id)).parkedBy).toBeUndefined()
    expect(await offered()).toEqual([id])
    // One record for the conversation on the machine, numbered anew each time
    await laptop.as.mutation(api.delivery.unpark, { for: SESSION })
    expect(await returns()).toMatchObject([{ machineId: laptop.id, harness: SESSION.harness, sessionId: SESSION.id, generation: 2 }])
  })

  test('the rest of a conversation’s clicks are not set aside by a step that comes after the conversation was heard from again, however many there are', async () => {
    const { t, laptop, click, row, offered, settle } = await setup()
    const first = await click()
    const rest: Id<'actions'>[] = []
    for (let i = 0; i < 120; i++) rest.push(await click())
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [first], for: SESSION, receipt: R1 })).toEqual([first])
    // The conversation takes nothing: its click is set aside, and the rest are to follow a batch at a time
    expect(await laptop.as.mutation(api.delivery.park, { id: first, receipt: R1, for: SESSION, all: true })).toBe(true)
    // Before the first of those steps has run, the conversation is heard from again, and is given back what was set aside
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(1)
    await settle()
    const all = await t.run((ctx) => ctx.db.query('actions').collect())
    expect(all.filter((x) => x.parkedBy !== undefined).map((x) => x._id)).toEqual([])
    expect(all.every((x) => x.delivery === 'pending' && x.machineId === laptop.id)).toBe(true)
    expect(await offered()).toEqual([first, rest[0]])
    // Where nothing is heard from the conversation, the same steps set all of them aside
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [first], for: SESSION, receipt: R2 })).toEqual([first])
    expect(await laptop.as.mutation(api.delivery.park, { id: first, receipt: R2, for: SESSION, all: true })).toBe(true)
    await settle()
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.parkedBy === laptop.id).length).toBe(121)
    expect(await offered()).toEqual([])
    // And once it is, all of them are given back, in as many steps as it takes, also when it is heard from twice at once
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(50)
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(50)
    await settle()
    expect((await t.run((ctx) => ctx.db.query('actions').collect())).filter((x) => x.parkedBy !== undefined).length).toBe(0)
    expect((await row(first)).machineId).toBe(laptop.id)
  })

  test('what is set aside after a conversation was heard from is not given back by a step of that earlier time', async () => {
    const { t, user, laptop, click, row } = await setup()
    const id = await click()
    // Heard from, with more set aside than one step gives back: the rest is to follow in a step of its own
    await laptop.as.mutation(api.delivery.unpark, { for: SESSION })
    const [was] = await t.run((ctx) => ctx.db.query('deliveryReturns').collect())
    // Meanwhile a delivery made under that time gives up, and its click is set aside
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION, receipt: R1 })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.park, { id, receipt: R1, for: SESSION })).toBe(true)
    expect(await row(id)).toMatchObject({ parkedBy: laptop.id, parkedGeneration: was!.generation })
    // The step that follows from that time gives back what was set aside before it, and leaves this
    await t.mutation(internal.delivery.unparkRest, { userId: user, machineId: laptop.id, for: SESSION, generation: was!.generation })
    expect(await row(id)).toMatchObject({ parkedBy: laptop.id })
    // The next time the conversation is heard from gives it back, and a step left over from the time before does nothing more
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(1)
    expect((await row(id)).parkedBy).toBeUndefined()
  })

  test('another machine’s hold and a stop are left as they are by a setting aside that comes late', async () => {
    const { t, laptop, desktop, browser, page, click, row, expire } = await setup()
    const [theirs, stopped] = [await click(), await click()]
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [theirs, stopped], for: SESSION, receipt: R1 })).toEqual([theirs, stopped])
    await expire()
    // Another of the person's machines has the first in hand now (an agent waiting on the page there)
    expect(await desktop.as.mutation(api.delivery.claim, { ids: [theirs], receipt: R2 })).toEqual([theirs])
    expect(await laptop.as.mutation(api.delivery.park, { id: theirs, receipt: R1, for: SESSION, all: true })).toBe(false)
    expect(await row(theirs)).toMatchObject({ delivery: 'leased', leaseMachineId: desktop.id, claim: { receipt: R2 } })
    // The second was stopped with its conversation while its delivery was ending: it is stopped, and not set aside
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [stopped], for: SESSION, receipt: R3 })).toEqual([stopped])
    await browser.mutation(api.machines.wake, { machineId: laptop.id, harness: 'claude-code', on: true })
    await laptop.as.mutation(api.machines.runBegan, { modes: ['claude-code'], for: SESSION })
    await t.run(async (ctx) => {
      const machine = (await ctx.db.get(laptop.id))!
      await ctx.db.patch(laptop.id, { stops: [...(machine.stops ?? []), { harness: SESSION.harness, sessionId: SESSION.id, at: Date.now() }] })
      await ctx.db.patch(page, { stoppedThrough: Date.now() })
    })
    expect(await laptop.as.mutation(api.delivery.park, { id: stopped, receipt: R3, for: SESSION })).toBe(true)
    expect(await row(stopped)).toMatchObject({ delivery: 'handed_off', route: 'stopped' })
    // Nor is what a stop took given back when the conversation is heard from again
    const aside = await click()
    await vi.advanceTimersByTimeAsync(10)
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [aside], for: SESSION, receipt: R1 })).toEqual([aside])
    expect(await laptop.as.mutation(api.delivery.park, { id: aside, receipt: R1, for: SESSION })).toBe(true)
    await t.run((ctx) => ctx.db.patch(page, { stoppedThrough: Date.now() }))
    await laptop.as.mutation(api.delivery.unpark, { for: SESSION })
    expect(await row(aside)).toMatchObject({ delivery: 'handed_off', route: 'stopped' })
  })

  test('a machine from before receipts has its click set aside as it asks and is answered as it can read, and the next time the conversation is heard from gives the click back', async () => {
    const { laptop, click, row, offered } = await setup()
    const id = await click()
    expect(await laptop.as.mutation(api.delivery.claim, { ids: [id], for: SESSION })).toEqual([id])
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(0)
    // Its delivery gives up after the conversation was heard from. It reads every answer but
    // `false` as set aside, so the click is set aside, as it was before, and not left where that machine would overlook it
    expect(await laptop.as.mutation(api.delivery.park, { id, for: SESSION, all: true })).toBe(true)
    expect(await row(id)).toMatchObject({ delivery: 'pending', parkedBy: laptop.id })
    expect(await offered()).toEqual([])
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(1)
    expect(await offered()).toEqual([id])
  })

  test('what 0.1.45 set aside, and the steps it left scheduled, are given back and carried on after the update', async () => {
    const { t, user, laptop, row, offered, legacyClick } = await setup()
    // Set aside by 0.1.45, with no word of when
    const aside = [
      await legacyClick({ machineId: undefined, parkedBy: laptop.id }),
      await legacyClick({ machineId: undefined, parkedBy: laptop.id }),
      await legacyClick({ machineId: undefined, parkedBy: laptop.id }),
    ]
    // A step it scheduled to give the rest back, which names no time, gives back what is set aside
    await t.mutation(internal.delivery.unparkRest, { userId: user, machineId: laptop.id, for: SESSION })
    for (const id of aside) expect((await row(id)).parkedBy).toBeUndefined()
    expect(await offered()).toEqual(aside.slice(0, 2))
    // A step it scheduled to set the rest aside, which names no time either, sets them aside as it was scheduled to
    await t.mutation(internal.delivery.parkRest, { machineId: laptop.id, harness: SESSION.harness, sessionId: SESSION.id })
    for (const id of aside) expect(await row(id)).toMatchObject({ parkedBy: laptop.id })
    expect((await row(aside[0]!)).parkedGeneration).toBeUndefined()
    // And the first time the conversation is heard from after the update gives all of it back
    expect(await laptop.as.mutation(api.delivery.unpark, { for: SESSION })).toBe(3)
    expect(await offered()).toEqual(aside.slice(0, 2))
  })

  test('when a conversation was heard from again is kept for a month, and goes with its machine and with everything else when the person erases it', async () => {
    const { t, laptop, desktop, browser, user, returns } = await setup()
    await laptop.as.mutation(api.delivery.unpark, { for: SESSION })
    await laptop.as.mutation(api.delivery.unpark, { for: OTHER })
    await desktop.as.mutation(api.delivery.unpark, { for: SESSION })
    expect((await returns()).length).toBe(3)
    // A month on, with one of them heard from again meanwhile: the others are let go of, and the machine goes on counting from where it was
    await vi.advanceTimersByTimeAsync(20 * DAY)
    await laptop.as.mutation(api.delivery.unpark, { for: OTHER })
    await vi.advanceTimersByTimeAsync(11 * DAY)
    await t.mutation(internal.retention.sweepRecords, {})
    expect((await returns()).map((r) => [r.machineId, r.sessionId, r.generation])).toEqual([[laptop.id, OTHER.id, 3]])
    await laptop.as.mutation(api.delivery.unpark, { for: SESSION })
    expect((await returns()).find((r) => r.sessionId === SESSION.id)?.generation).toBe(4)
    // A machine that is revoked takes its own with it
    await desktop.as.mutation(api.delivery.unpark, { for: SESSION })
    await browser.mutation(api.machines.revoke, { machineId: desktop.id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await returns()).every((r) => r.machineId === laptop.id)).toBe(true)
    expect((await returns()).length).toBe(2)
    // And erasing everything leaves none
    await browser.mutation(api.account.requestDeletion, { confirm: 'erase everything', user })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await returns()).toEqual([])
  })
})
