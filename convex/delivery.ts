// Getting a click to the agent. A click is stored first (actions.ts) and then moves through
// pending -> leased -> handed off. A connector leases the clicks it is about to deliver; if it
// dies, the lease runs out and the click goes back in the queue. Delivery is at-least-once, and
// each click keeps one id, so whoever receives it can tell a repeat from a new one.
//
// Two things about a click never change while it is delivered: which machine it is for, and
// which conversation. Who holds the lease is recorded separately, so a machine that borrows a
// click and dies does not take it away from its owner.
import { LEASE_MS, LIMITS, LISTENING_MOST, QUEUES, WAKE_BACK_MS, WAKE_MOST, WAKES, wakesOn } from '@it/protocol'
import type { FilterBuilder, NamedTableInfo } from 'convex/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { DataModel, Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { destination, dropStopped, madeBefore, noLongerWaiting, type Seen, stoppedSince } from './actions'
import { artifactBySlug, requireMachine } from './lib/authz'
import { fail } from './lib/errors'
import { log } from './lib/log'
import { nextSequence } from './lib/tally'
import { session } from './schema'
import { revisionNow } from './state'

async function asClicks(ctx: QueryCtx, rows: Doc<'actions'>[]) {
  const pages = new Map<string, Doc<'artifacts'> | null>()
  // Which revision each page's state is at now: a small record of its own, never the state
  const revisions = new Map<string, number>()
  const out = []
  for (const x of rows) {
    if (!pages.has(x.artifactId)) pages.set(x.artifactId, await ctx.db.get(x.artifactId))
    const a = pages.get(x.artifactId)
    if (!a) continue
    // What the person acted on may have been replaced since: a click made while a display was
    // out of reach arrives later, and an agent that has published again, or changed the page's
    // state, in between must be told which version and which state it answers. The title is the
    // one that version had, kept with the click when it was made.
    const replaced = a.currentVersion !== undefined && a.currentVersion !== x.contentVersion
    if (x.baseStateRevision !== undefined && !revisions.has(x.artifactId)) revisions.set(x.artifactId, await revisionNow(ctx, x.artifactId))
    const stateNow = x.baseStateRevision === undefined ? undefined : revisions.get(x.artifactId)
    out.push({
      id: x._id,
      artifact: a.slug,
      // The title that version had, which is empty where it is not known: never the title the page has now
      title: x.title,
      name: x.name,
      /** JSON text. */
      payload: x.payload,
      at: x.createdAt,
      attended: x.attended ?? null,
      session: x.harness && x.sessionId ? { harness: x.harness, id: x.sessionId } : null,
      version: x.contentVersion,
      ...(x.baseStateRevision === undefined ? {} : { stateRevision: x.baseStateRevision }),
      // Only when it is another version, or another revision: what the person acted on has changed since
      ...(replaced ? { nowVersion: a.currentVersion } : {}),
      ...(stateNow !== undefined && stateNow !== x.baseStateRevision ? { nowStateRevision: stateNow } : {}),
      // The files it carried beside its data, as It received them: read one with `it action <id> --save`
      ...(x.files?.length ? { files: x.files.map((f) => ({ name: f.name, type: f.type, bytes: f.size })) } : {}),
    })
  }
  return out
}

/**
 * What of one conversation's clicks came after its last stop on this machine: as a test of a
 * click in hand, and as a filter for a read of them, so that what the stop dropped and its
 * steps have not yet come to stands in front of nothing that may be taken. By the stop's place
 * in the order the person's clicks and stops are written in, which no index on the clock can
 * read; by the clock only for a stop from before stops had a place, and only of the clicks of
 * that time.
 */
function afterStop(machine: Doc<'machines'>, harness: string, sessionId: string) {
  const stop = (machine.stops ?? []).find((s) => s.harness === harness && s.sessionId === sessionId)
  return {
    kept: (x: Doc<'actions'>) => !stop || !madeBefore(x, stop),
    filter: (q: FilterBuilder<NamedTableInfo<DataModel, 'actions'>>) =>
      !stop
        ? q.eq(true, true)
        : stop.sequence !== undefined
          ? q.gt(q.field('sequence'), stop.sequence)
          : q.or(q.neq(q.field('sequence'), undefined), q.gt(q.field('createdAt'), stop.at)),
  }
}

/**
 * Leaves out what was made before a stop of its conversation, which the stop's steps drop and
 * may not have come to yet: it is offered to nobody. Each page and machine is read once, however
 * many clicks name it.
 */
async function notStopped(ctx: QueryCtx, rows: Doc<'actions'>[]) {
  const seen: Seen = new Map()
  const out = []
  for (const x of rows) if (!(await stoppedSince(ctx, x, seen))) out.push(x)
  return out
}

/**
 * How much one asking for the inbox may read of clicks, in bytes. The backend lets a query read
 * 16 MB and past that refuses it whole, which to a connector is no inbox at all, for any of its
 * conversations. Every click that is read counts, also one that is read a second time, and
 * what is left over is for the pages the clicks are on.
 */
const READ_MOST = 12 * 1024 * 1024
/**
 * What a click's record holds beside what the click carried, at the most, and so the most one
 * click can come to. The list of the files it carried is counted in what it carried, which it
 * may not take past what an action may carry (actions.ts).
 */
const CLICK_BESIDE = 2048
const CLICK_MOST = LIMITS.actionPayloadBytes + CLICK_BESIDE
/** What a click's record came to, as what it carried, the list of its files, and the most of everything else. */
const carried = (bytes: TextEncoder, x: Doc<'actions'>) =>
  bytes.encode(x.payload).length + (x.files ? bytes.encode(JSON.stringify(x.files)).length : 0) + CLICK_BESIDE

async function listeningRows(
  ctx: QueryCtx,
  user: Doc<'users'>,
  machine: Doc<'machines'>,
  listening: { harness: string; id: string }[],
  read: (rows: Doc<'actions'>[]) => Doc<'actions'>[],
) {
  const rows: Doc<'actions'>[] = []
  // Every conversation the connector may name is looked at first, a few clicks each, oldest
  // first, so that each has its place whatever else is waiting. Read by the person and the
  // conversation: a click whose page belonged to a machine that is gone (the person signed
  // this computer in again, say) has no machine, and still belongs to the conversation that
  // is here and listening.
  for (const s of listening.slice(0, LISTENING_MOST)) {
    // This machine's own, and those with no machine, are each read by themselves: read
    // together with everything else waiting for the conversation, a few clicks that are
    // another machine's, or were set aside, could stand in front of one this machine may take.
    const route = (machineId: Id<'machines'>) =>
      ctx.db
        .query('actions')
        .withIndex('by_route', (q) => q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id))
    // These come first and are at most four for each of forty conversations, which is within what may be read whatever they carry
    // (What a stop of the conversation here dropped, and its steps have not yet come to, stands in front of none of them)
    const own = read(
      await route(machine._id)
        .filter(afterStop(machine, s.harness, s.id).filter)
        .take(2),
    )
    // Those with no machine are read as exactly the ones this machine may take: this
    // person's, and not set aside. One that a machine set aside has no machine either, and is
    // not offered again: it waits for `it wait` and the site, until its page changes hands.
    // Nothing is read and then left out, so no number of clicks that may not be taken,
    // another person's or set aside, can stand in front of one that may; and the oldest of
    // them are the ones offered.
    const loose = read(
      await ctx.db
        .query('actions')
        .withIndex('by_user_route', (q) =>
          q
            .eq('userId', user._id)
            .eq('delivery', 'pending')
            .eq('harness', s.harness)
            .eq('sessionId', s.id)
            .eq('machineId', undefined)
            .eq('parkedBy', undefined),
        )
        .take(2),
    )
    rows.push(...[...own, ...loose].sort((a, b) => a.createdAt - b.createdAt).slice(0, 2))
  }
  return rows
}

/**
 * The array inbox for connectors without paging. Listening conversations have reserved
 * places; queues use fixed samples. The paged inbox below advances through every name.
 */
export const inbox = query({
  args: { listening: v.array(session), queues: v.optional(v.array(v.string())) },
  handler: async (ctx, { listening, queues }) => {
    const { user, machine } = await requireMachine(ctx)
    const rows: Doc<'actions'>[] = []
    // Kept small enough in all that the largest clicks allowed still fit in one answer: never
    // more than this many rows read, however many conversations are listening
    const BUDGET = 150
    // And never more read than a query may read. A click is counted as what it came to once it
    // has been read, and before that as the most a click can be: so while clicks are small, as
    // nearly all are, everything below reads what it always did, and only where what waits is
    // very large is less of it read at one asking.
    let left = READ_MOST
    const bytes = new TextEncoder()
    const read = <T extends Doc<'actions'>[]>(got: T): T => {
      for (const x of got) left -= carried(bytes, x)
      return got
    }
    rows.push(...(await listeningRows(ctx, user, machine, listening, read)))
    // A harness with a queue of its own takes a click whether or not its conversation is open.
    // Read conversation by conversation, the oldest few of each: one conversation that takes
    // nothing (its thread is gone, say) then stands in the way of no other, and within each,
    // what was pressed first is delivered first. These fixed samples find conversations by
    // which have waited longest, by which were pressed most recently, and by their names.
    //
    // A harness whose closed conversations are reopened is read the same way, with three
    // things more. It is read only where the person has switched that on for it on this
    // machine, whatever the connector asks. Only what was done from about then on is read:
    // what had waited longer is not reopened for, and read with the rest, the oldest few of a
    // conversation, it would stand in front of every later click for good. The same holds for
    // what was waiting when the person stopped a conversation. And more of each conversation
    // is read, since one reopening carries all that is waiting for it.
    //
    // Where what may still be read is short, each queue yet to be read has the same share of
    // it, so that none goes unread behind another, and spends it on what has waited longest
    // first. What a queue then lacks is found at a later asking, once some of this has gone.
    const asked = (queues ?? []).slice(0, 8)
    for (const [nth, harness] of asked.entries()) {
      let from = 0
      const reopened = (WAKES as readonly string[]).includes(harness) && !(QUEUES as readonly string[]).includes(harness)
      if (reopened) {
        // And only on a system It reopens conversations on, whatever was switched on for this machine before that was asked
        const on = wakesOn(machine.system) ? (machine.wakes ?? []).find((w) => w.harness === harness) : undefined
        if (!on) continue
        from = on.since - WAKE_BACK_MS
      }
      const each = reopened ? WAKE_MOST : 2
      const found: string[] = []
      // How many clicks this queue may read now, of the `n` wanted, each taken to be as large as a click can be
      const until = left - left / (asked.length - nth)
      const may = (n: number, reserved = 0) => Math.max(0, Math.min(n, Math.floor((left - until) / CLICK_MOST) - reserved))
      // Discovery leaves room for the other ways of finding a conversation and for reading
      // its oldest click. Newest rows alone cannot be delivered without skipping earlier ones.
      const first = Math.min(40, Math.floor(may(80) / 2))
      const oldest = first
        ? read(
            await ctx.db
              .query('actions')
              .withIndex('by_harness', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gte('createdAt', from))
              .take(first),
          )
        : []
      // Fewer than were asked for are all there are in this queue: nothing of it need be read a second time
      const all = first > 0 && oldest.length < first
      for (const x of oldest) if (x.sessionId && !found.includes(x.sessionId) && found.length < 10) found.push(x.sessionId)
      // And the ones pressed most recently: a conversation somebody is using now
      const last = Math.min(20, Math.floor(may(40, found.length) / 2))
      const newest = last
        ? read(
            await ctx.db
              .query('actions')
              .withIndex('by_harness', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gte('createdAt', from))
              .order('desc')
              .take(last),
          )
        : []
      for (const x of newest) if (x.sessionId && !found.includes(x.sessionId) && found.length < 16) found.push(x.sessionId)
      let after = ''
      for (let named = 0; named < 12 && may(1, found.length + 1); named++) {
        const head = await ctx.db
          .query('actions')
          .withIndex('by_route', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gt('sessionId', after))
          .first()
        if (head) read([head])
        if (!head?.sessionId) break
        after = head.sessionId
        if (!found.includes(after)) found.push(after)
      }
      for (const [foundAt, sessionId] of found.entries()) {
        if (rows.length >= BUDGET) break
        const want = Math.min(each, BUDGET - rows.length)
        const since = from - 1
        const stopped = afterStop(machine, harness, sessionId)
        // What was read of the queue's oldest holds this conversation's own oldest, in their
        // order. Where that is all the queue has, or as many as are wanted, it is what reading
        // the conversation would give, and the conversation is not read.
        const known = oldest.filter((x) => x.sessionId === sessionId && x.createdAt > since && stopped.kept(x))
        if (all || known.length >= want) {
          rows.push(...known.slice(0, want))
          continue
        }
        // Where fewer may be read than are wanted, the oldest that may be are offered, or the
        // ones known already where those are more: the first of what is waiting for the
        // conversation either way, and the rest of it at a later asking
        // Every remaining conversation keeps room for its oldest eligible click, even when
        // an earlier conversation has enough waiting to use the rest of this queue's share.
        const now = may(want, found.length - foundAt - 1)
        if (now <= known.length) {
          rows.push(...known)
          continue
        }
        rows.push(
          ...read(
            await ctx.db
              .query('actions')
              .withIndex('by_route', (q) =>
                q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId).gt('createdAt', since),
              )
              .filter(stopped.filter)
              .take(now),
          ),
        )
      }
    }
    const seen = new Set<string>()
    return asClicks(
      ctx,
      await notStopped(
        ctx,
        rows.filter((x) => !seen.has(x._id) && seen.add(x._id)),
      ),
    )
  },
})

/**
 * A bounded page of the inbox. The connector keeps each app's last conversation name and
 * advances once a second, including while everything on the current page remains pending.
 * Names are keyset cursors: deleting a conversation or adding clicks to an earlier one never
 * moves the cursor backwards. Reaching the end starts the next pass at the beginning.
 */
export const inboxPage = query({
  args: {
    listening: v.array(session),
    queues: v.optional(v.array(v.string())),
    after: v.array(session),
  },
  handler: async (ctx, { listening, queues, after }) => {
    const { user, machine } = await requireMachine(ctx)
    let left = READ_MOST
    const bytes = new TextEncoder()
    const read = (rows: Doc<'actions'>[]) => {
      for (const x of rows) left -= carried(bytes, x)
      return rows
    }
    const rows = await listeningRows(ctx, user, machine, listening, read)
    const next: { harness: string; id: string }[] = []
    const asked = [...new Set(queues ?? [])].filter((h) => ([...QUEUES, ...WAKES] as readonly string[]).includes(h)).slice(0, 8)
    for (const [nth, harness] of asked.entries()) {
      const reopened = !(QUEUES as readonly string[]).includes(harness)
      const on = wakesOn(machine.system) ? (machine.wakes ?? []).find((w) => w.harness === harness) : undefined
      if (reopened && !on) continue
      const from = reopened ? on!.since - WAKE_BACK_MS : 0
      const each = reopened ? WAKE_MOST : 2
      // Every app keeps a share of both the response and the read allowance. A conversation
      // reserves five reads: discovery, its two oldest clicks, and the oldest attended click in
      // each of the two forms stored by current and older clients. It reserves two response
      // places so that a person's click can accompany the oldest timer click.
      const remaining = asked.length - nth
      const until = left - left / remaining
      const may = () => Math.max(0, Math.floor((left - until) / CLICK_MOST))
      let places = Math.floor((150 - rows.length) / remaining)
      const count = Math.min(12, Math.floor(places / 2), Math.floor(may() / 5))
      let cursor = after.find((s) => s.harness === harness)?.id ?? ''
      const found: string[] = []
      for (let n = 0; n < count; n++) {
        const head = await ctx.db
          .query('actions')
          .withIndex('by_route', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gt('sessionId', cursor))
          .first()
        if (!head?.sessionId) {
          cursor = ''
          break
        }
        read([head])
        cursor = head.sessionId
        found.push(cursor)
      }
      next.push({ harness, id: cursor })
      for (const [n, sessionId] of found.entries()) {
        const rest = found.length - n - 1
        const since = from - 1
        const stopped = afterStop(machine, harness, sessionId)
        // Leave four reads and two response places for each later conversation, and two
        // reads for this conversation's attended lookup. Extra places carry its oldest work.
        const want = Math.min(each, places - 2 * rest, may() - 4 * rest - 2)
        const batch = read(
          await ctx.db
            .query('actions')
            .withIndex('by_route', (q) =>
              q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId).gt('createdAt', since),
            )
            .filter(stopped.filter)
            .take(want),
        )
        if (batch.length && batch.every((c) => c.attended === false)) {
          const attended: Doc<'actions'>[] = []
          for (const present of [true, undefined]) {
            const first = await ctx.db
              .query('actions')
              .withIndex('by_attended_route', (q) =>
                q
                  .eq('machineId', machine._id)
                  .eq('delivery', 'pending')
                  .eq('harness', harness)
                  .eq('sessionId', sessionId)
                  .eq('attended', present)
                  .gt('createdAt', since),
              )
              .filter(stopped.filter)
              .first()
            if (first) attended.push(...read([first]))
          }
          attended.sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime)
          if (attended[0]) {
            // The oldest attended click may pass older timer clicks. All selected clicks
            // retain their order, and the omitted timers stay pending for the next batch.
            if (batch.length === want) batch.pop()
            batch.push(attended[0])
          }
        }
        places -= batch.length
        rows.push(...batch)
      }
    }
    const seen = new Set<string>()
    return {
      clicks: await asClicks(
        ctx,
        await notStopped(
          ctx,
          rows.filter((x) => !seen.has(x._id) && seen.add(x._id)),
        ),
      ),
      after: next,
    }
  },
})

/** The clicks waiting on one page, for `it wait`. Any of the person's machines may watch. */
export const waiting = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const { user } = await requireMachine(ctx)
    const a = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    const rows = await ctx.db
      .query('actions')
      .withIndex('by_artifact_delivery', (q) => q.eq('artifactId', a._id).eq('delivery', 'pending'))
      .take(50)
    return asClicks(ctx, rows)
  },
})

/**
 * What is waiting for one conversation that this machine may take, oldest first: what `it
 * wait` with no page named takes. Read by the conversation, so that other conversations'
 * clicks, however many, never stand in front of it.
 *
 * And read by whose they are to take, each kind by itself: the ones addressed to this machine,
 * the ones addressed to none, and the ones this machine set aside, which wait for `it wait`
 * still. A conversation of the same name on another of the person's machines is another
 * conversation, and its clicks are that machine's: read with these, fifty of them that were
 * older stood in front of every click this machine could take, were asked for, were refused,
 * and stood there again at the next asking.
 */
export const waitingFor = query({
  args: { session },
  handler: async (ctx, { session: s }) => {
    const { user, machine } = await requireMachine(ctx)
    const of = (machineId: Id<'machines'> | undefined, aside: Id<'machines'> | undefined) =>
      ctx.db
        .query('actions')
        .withIndex('by_user_route', (q) =>
          q.eq('userId', user._id).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id).eq('machineId', machineId).eq('parkedBy', aside),
        )
        .take(50)
    const rows = [...(await of(machine._id, undefined)), ...(await of(undefined, undefined)), ...(await of(undefined, machine._id))]
    return asClicks(ctx, rows.sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime).slice(0, 50))
  },
})

/** Everything still waiting, across all the person's pages, newest first: what `it actions` lists. */
export const allWaiting = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireMachine(ctx)
    const rows = await ctx.db
      .query('actions')
      .withIndex('by_user_delivery', (q) => q.eq('userId', user._id).eq('delivery', 'pending'))
      .order('desc')
      .take(50)
    return asClicks(ctx, rows)
  },
})

/** One action, whatever has become of it: for an agent told only its id. */
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const { user } = await requireMachine(ctx)
    const actionId = ctx.db.normalizeId('actions', id)
    const x = actionId ? await ctx.db.get(actionId) : null
    if (!x || x.userId !== user._id) fail('not_found', 'No such action.')
    const [click] = await asClicks(ctx, [x])
    if (!click) fail('not_found', 'The page that action was on is gone.')
    return { ...click, delivery: x.delivery, route: x.route ?? null, outcome: x.outcome ?? null }
  },
})

/**
 * A receipt: what one taking of a click to hand it over is known by. The machine that takes the
 * click makes it, before it asks, so that the answer to a taking that was lost on its way can be
 * asked for again under the same one. Every later step of that hand-over names it: keeping the
 * hold, giving the click back, setting it aside, and saying it was handed over. A step that
 * names another receipt, or none, does nothing to it.
 */
const receiptOf = v.string()
const RECEIPT = /^[A-Za-z0-9_-]{16,64}$/
/**
 * A taking with no receipt is one made by an It from before receipts, on a machine that joined
 * this It and has not been brought up to date. Such a machine is served as it was for one
 * release: what it says without a receipt is taken of a click it took without one, and of no
 * other. A click taken with a receipt is never given back, kept, set aside or said to be handed
 * over by anything that does not name that receipt, but an `it ack`.
 */
const unreceipted = (x: Doc<'actions'>) => x.claim?.receipt === undefined
/** Whether this machine's taking of a click, known by that receipt, is still the click's last one. */
const holds = (x: Doc<'actions'>, receipt: string, machine: Doc<'machines'>) => x.claim?.receipt === receipt && x.claim.machineId === machine._id
/**
 * When a conversation was last heard from again on a machine, as its place in the order the
 * person's clicks and stops are written in: nothing where it never has been, or not for a month.
 */
async function generationOf(ctx: QueryCtx, machineId: Id<'machines'>, harness: string | undefined, sessionId: string | undefined): Promise<number> {
  if (harness === undefined || sessionId === undefined) return 0
  return (await returnOf(ctx, machineId, harness, sessionId))?.generation ?? 0
}
const returnOf = (ctx: QueryCtx, machineId: Id<'machines'>, harness: string, sessionId: string) =>
  ctx.db
    .query('deliveryReturns')
    .withIndex('by_machine_session', (q) => q.eq('machineId', machineId).eq('harness', harness).eq('sessionId', sessionId))
    .unique()

/** The receipt one of a list names, where it names one. */
const receiptFor = (receipts: { id: Id<'actions'>; receipt: string }[] | undefined, id: Id<'actions'>) => receipts?.find((r) => r.id === id)?.receipt

/**
 * Leases clicks for delivery. Returns the ones this caller now holds. A connector that is about
 * to deliver into a conversation says which (`for`): a click that has since been addressed to
 * another conversation or another machine, because its page changed hands, is then left alone.
 *
 * The taking is known by the receipt the caller made for it. Asked again with the same receipt,
 * as after an answer that was lost, a click that taking still holds is held still; one it no
 * longer holds is not taken afresh under it, since what was done under it is over.
 */
export const claim = mutation({
  args: { ids: v.array(v.id('actions')), for: v.optional(session), receipt: v.optional(receiptOf) },
  handler: async (ctx, { ids, for: expected, receipt }) => {
    const { user, machine } = await requireMachine(ctx)
    if (receipt !== undefined && !RECEIPT.test(receipt)) fail('invalid', 'That is not a receipt.')
    const now = Date.now()
    const held = []
    const adopted = new Set<string>()
    // Which time of its conversation's being heard from again each taking is made in: a setting aside it ends in counts only if that is still the last
    const generations = new Map<string, number>()
    const generation = async (harness: string | undefined, sessionId: string | undefined) => {
      const key = `${harness}:${sessionId}`
      if (!generations.has(key)) generations.set(key, await generationOf(ctx, machine._id, harness, sessionId))
      return generations.get(key)!
    }
    for (const id of ids.slice(0, 50)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id) continue
      if (expected) {
        // Judged by who owns the page at this moment, not by what the click was addressed
        // with when it was made: a page can change hands a moment before its waiting clicks
        // are addressed afresh. A page whose machine is gone may be taken by any of the
        // person's machines, for the conversation it belongs to.
        const to = await destination(ctx, x.artifactId)
        if ((to.machineId !== undefined && to.machineId !== machine._id) || to.harness !== expected.harness || to.sessionId !== expected.id) continue
      }
      if (receipt !== undefined && holds(x, receipt, machine)) {
        // The same taking asked for again: held still where its hold has not run out, and otherwise over
        if (x.delivery === 'leased' && (x.leaseExpiresAt ?? 0) >= now) held.push(id)
        continue
      }
      const free = x.delivery === 'pending' || (x.delivery === 'leased' && (x.leaseExpiresAt ?? 0) < now)
      if (!free) continue
      // Stopped with its conversation, and not yet marked so: it is marked now, and not given out
      if (await stoppedSince(ctx, x)) {
        await dropStopped(ctx, x)
        continue
      }
      await ctx.db.patch(id, {
        delivery: 'leased',
        leaseMachineId: machine._id,
        leaseExpiresAt: now + LEASE_MS,
        claim: {
          ...(receipt === undefined ? {} : { receipt }),
          session: expected ?? null,
          machineId: machine._id,
          generation: await generation(expected?.harness ?? x.harness, expected?.id ?? x.sessionId),
        },
      })
      held.push(id)
      // A page whose machine is gone, taken for the conversation it belongs to, is this
      // machine's from now on: its conversation is here. Left with the machine that is gone, it
      // would be heard only while that conversation happened to be open, and could never be
      // reopened for.
      if (expected && !adopted.has(x.artifactId)) {
        const page = await ctx.db.get(x.artifactId)
        const owner = page?.machineId ? await ctx.db.get(page.machineId) : null
        if (page && (!owner || owner.revoked)) {
          adopted.add(x.artifactId)
          await ctx.db.patch(page._id, { machineId: machine._id })
          await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: page._id })
          log('page.adopted', { userId: user._id, artifactId: page._id, machineId: machine._id })
        }
      }
    }
    return held
  },
})

/** The receipts of the clicks a list names, each beside the click's id. */
const receipts = v.optional(v.array(v.object({ id: v.id('actions'), receipt: receiptOf })))

/**
 * Keeps hold of clicks this machine has leased and is still waiting to hand over, each by the
 * receipt of the taking that holds it. Returns the ones it still holds.
 */
export const renew = mutation({
  args: { ids: v.array(v.id('actions')), receipts },
  handler: async (ctx, { ids, receipts: named }) => {
    const { user, machine } = await requireMachine(ctx)
    const now = Date.now()
    const held = []
    for (const id of ids.slice(0, 50)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id || x.delivery !== 'leased' || x.leaseMachineId !== machine._id || (x.leaseExpiresAt ?? 0) < now) continue
      const receipt = receiptFor(named, id)
      if (receipt === undefined ? !unreceipted(x) : !holds(x, receipt, machine)) continue
      await ctx.db.patch(id, { leaseExpiresAt: now + LEASE_MS })
      held.push(id)
    }
    return held
  },
})

/**
 * Of clicks a machine was holding and no longer holds, the ones that are somebody else's to
 * deliver by now, or have been delivered by somebody else: waiting again, held by another
 * machine, held by this one past the time it had them for, or handed over by another machine
 * (to an agent that was waiting for it there). A click that this machine itself said was handed
 * over (as an agent on it does with `it ack`), that was stopped, or that is gone, is nobody
 * else's, and is not among them. A machine that is running something for a click asks this to
 * tell a click it has lost from one that is simply done with.
 */
export const lost = query({
  args: { ids: v.array(v.id('actions')), receipts },
  handler: async (ctx, { ids, receipts: named }) => {
    const { user, machine } = await requireMachine(ctx)
    const now = Date.now()
    const theirs = []
    for (const id of ids.slice(0, 50)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id) continue
      // Held by another taking, also one of this machine's own
      const receipt = receiptFor(named, id)
      const another = receipt !== undefined && !holds(x, receipt, machine)
      if (
        x.delivery === 'pending' ||
        (x.delivery === 'leased' && (x.leaseMachineId !== machine._id || (x.leaseExpiresAt ?? 0) < now || another)) ||
        (x.delivery === 'handed_off' && x.route !== 'stopped' && x.handedBy !== undefined && x.handedBy !== machine._id)
      )
        theirs.push(id)
    }
    return theirs
  },
})

/**
 * What a click goes back to once nobody holds it: waiting, addressed to whoever owns its page
 * now. One that the owner's machine had set aside stays set aside, unless the page has changed
 * hands since.
 */
async function backToWaiting(ctx: QueryCtx, x: Doc<'actions'>) {
  const to = await destination(ctx, x.artifactId)
  const stillAside = x.parkedBy !== undefined && to.machineId === x.parkedBy && to.harness === x.harness && to.sessionId === x.sessionId
  return {
    delivery: 'pending' as const,
    leaseMachineId: undefined,
    leaseExpiresAt: undefined,
    ...to,
    ...(stillAside ? { machineId: undefined } : { parkedBy: undefined }),
  }
}

async function mine(ctx: QueryCtx, id: Doc<'actions'>['_id']) {
  const { user, machine } = await requireMachine(ctx)
  const x = await ctx.db.get(id)
  if (!x || x.userId !== user._id) fail('not_found', 'No such action.')
  return { x, machine }
}

/**
 * The click reached the agent. `route` says how: an add-on, the harness's own queue, a waiting CLI.
 * The answer says whether it had already been handed over, with when the click was made and
 * which harness it was for: what a machine needs to count a delivery once, and nothing of the click.
 *
 * A hand-over is said by the receipt of the taking that made it, and counts only while that
 * taking is the click's last: one said late, after the click was given back and taken again,
 * also on the same machine, says nothing of the taking after it. It counts too where the hold
 * itself ran out or was given back meanwhile and nothing has taken the click since, as when
 * the connector that handed it over was started again. And only while the click is still for
 * the conversation it was taken for. `manual` is an agent or a person saying with `it ack`
 * that they have it, which needs no receipt.
 */
export const handedOff = mutation({
  args: { id: v.id('actions'), route: v.string(), receipt: v.optional(receiptOf) },
  handler: async (ctx, { id, route, receipt }) => {
    const { x, machine } = await mine(ctx, id)
    const said = (already: boolean) => ({ already, at: x.createdAt, harness: x.harness ?? null })
    const manual = route === 'manual'
    if (x.delivery === 'handed_off') {
      // The same hand-over said again, an `it ack`, or a click a stop took: there is nothing more to do
      if (manual || x.route === 'stopped' || (receipt === undefined ? unreceipted(x) : holds(x, receipt, machine))) return said(true)
      fail('conflict', 'That receipt is of another hand-over of this click.')
    }
    // Stopped with its conversation while it was on its way: it counts as stopped, and not as
    // something an agent was given, whatever way it was about to be handed over
    if (await stoppedSince(ctx, x)) {
      await dropStopped(ctx, x)
      return said(true)
    }
    if (!manual && receipt !== undefined) {
      if (!holds(x, receipt, machine)) fail('conflict', 'That receipt is of a hand-over that no longer holds this click.')
      const to = await destination(ctx, x.artifactId)
      const s = x.claim?.session
      if (s && ((to.machineId !== undefined && to.machineId !== machine._id) || to.harness !== s.harness || to.sessionId !== s.id))
        fail('conflict', 'This click belongs to another conversation now.')
    }
    // Said with no receipt by an It from before receipts, of a click taken with one: it is not
    // this hand-over's to say, and that It is to be brought up to date
    if (!manual && receipt === undefined && !unreceipted(x))
      fail('conflict', 'This click was taken with a receipt, and this report has none. Update It on this machine.')
    if (x.delivery === 'leased' && x.leaseMachineId !== machine._id && (x.leaseExpiresAt ?? 0) > Date.now())
      fail('conflict', 'Another machine is delivering this.')
    await ctx.db.patch(id, {
      delivery: 'handed_off',
      leaseMachineId: undefined,
      leaseExpiresAt: undefined,
      route: route.slice(0, 20),
      handedAt: Date.now(),
      handedBy: machine._id,
      outcome: 'running',
    })
    await noLongerWaiting(ctx, x)
    return said(false)
  },
})

/** What became of the work a click started, when that can be told. */
export const settle = mutation({
  args: { id: v.id('actions'), outcome: v.union(v.literal('succeeded'), v.literal('failed'), v.literal('unknown')) },
  handler: async (ctx, { id, outcome }) => {
    const { x } = await mine(ctx, id)
    if (x.delivery !== 'handed_off') fail('conflict', 'That action has not been handed to an agent.')
    await ctx.db.patch(id, { outcome })
    return null
  },
})

/** Gives a leased click back, when it could not be delivered after all: only the taking its receipt names, while it holds the click. */
export const release = mutation({
  args: { id: v.id('actions'), receipt: v.optional(receiptOf) },
  handler: async (ctx, { id, receipt }) => {
    const { x, machine } = await mine(ctx, id)
    // Back in the queue, addressed to whoever owns the page now: it may have changed hands meanwhile
    if (x.delivery === 'leased' && x.leaseMachineId === machine._id && (receipt === undefined ? unreceipted(x) : holds(x, receipt, machine))) {
      // Stopped with its conversation while this machine had it: it goes back to nobody
      if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
      else await ctx.db.patch(id, await backToWaiting(ctx, x))
    }
    return null
  },
})

/**
 * A connector that starts gives back whatever this machine still holds. The one before it may
 * have ended in the middle, and what it had claimed and not handed over would be out of what
 * It offers until its lease ran out, while what was done after it is offered at once: taken
 * first, that would reach its conversation ahead of what was done before it. The answer names
 * what went back, so that the connector takes nothing newer until it is offered these again.
 */
/** Resolves returned claims without waiting for a bounded inbox subscription to include them. */
export const recover = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const { user, machine } = await requireMachine(ctx)
    const rows = []
    for (const id of ids.slice(0, 32)) {
      const normalized = ctx.db.normalizeId('actions', id)
      const x = normalized ? await ctx.db.get(normalized) : null
      if (!x || x.userId !== user._id || x.delivery !== 'pending' || x.parkedBy || (await stoppedSince(ctx, x))) {
        rows.push({ id, click: null })
        continue
      }
      const to = await destination(ctx, x.artifactId)
      const [click] = to.machineId !== undefined && to.machineId !== machine._id ? [] : await asClicks(ctx, [{ ...x, ...to }])
      rows.push({ id, click: click ?? null })
    }
    return rows
  },
})

/** A bounded part of recovery, including whether every lease this machine held was examined. */
export const giveBackBatch = mutation({
  args: {},
  handler: async (ctx) => {
    const most = 64
    const { machine, user } = await requireMachine(ctx)
    // At most two MiB of action payloads, with room for the page and machine records read
    // with them. Foreign leases are excluded by the index, before anything is read. Every processed
    // row leaves this index range, so asking again progresses even if an entire batch was stopped.
    const leased = await ctx.db
      .query('actions')
      .withIndex('by_lease_machine', (q) => q.eq('leaseMachineId', machine._id).eq('delivery', 'leased'))
      .take(most)
    const back: Id<'actions'>[] = []
    const routes: { id: string; session: { harness: string; id: string } | null }[] = []
    for (const x of leased) {
      if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
      else {
        const waiting = await backToWaiting(ctx, x)
        await ctx.db.patch(x._id, waiting)
        back.push(x._id)
        routes.push({ id: x._id, session: waiting.harness && waiting.sessionId ? { harness: waiting.harness, id: waiting.sessionId } : null })
      }
    }
    if (back.length) log('lease.given_back', { machineId: machine._id, count: back.length })
    return { back, done: leased.length < most, routes, person: user._id }
  },
})

/**
 * A click this machine cannot deliver by itself (its conversation's own queue keeps refusing
 * it) is taken out of the machine's inbox, so it does not stand in the way of clicks that can
 * be delivered. It is still waiting, and still listed for the person and for `it wait`.
 */
export const park = mutation({
  args: {
    id: v.id('actions'),
    /** The receipt of the taking that gave up on it. Another taking since, also on this machine, has not given up on it. */
    receipt: v.optional(receiptOf),
    /** The conversation the machine was trying to deliver it into. If the click is for another by now, it is left as it is. */
    for: v.optional(session),
    /** The conversation takes nothing at all (its thread is gone): everything else waiting for it is set aside with this click. */
    all: v.optional(v.boolean()),
  },
  /**
   * True once the click has stopped being this machine's to deliver: set aside, gone elsewhere,
   * or handed over. False when another machine holds it now, and the asking has to be repeated.
   * `again` where it was not set aside and waits to be tried afresh: another taking has had it
   * since the one that gave up on it, or its conversation has been heard from again since that
   * one began.
   */
  handler: async (ctx, { id, for: tried, all, receipt }): Promise<boolean | 'again'> => {
    const { x, machine } = await mine(ctx, id)
    if (x.delivery === 'handed_off' || x.machineId !== machine._id) return true
    // Addressed to another conversation since this machine tried it (its page changed hands on
    // this same machine): it is that conversation's now, and has not been tried there
    if (tried && (x.harness !== tried.harness || x.sessionId !== tried.id)) return true
    // Another machine may have taken it meanwhile (this one's lease ran out while its command
    // was still running). What that machine holds is left exactly as it is.
    const live = x.delivery === 'leased' && (x.leaseExpiresAt ?? 0) > Date.now()
    if (live && x.leaseMachineId !== machine._id) return false
    // And so is what another taking on this machine holds, which has not given up on it: an
    // asking with no receipt waits for that hold to end, and one that names an earlier taking is
    // over, and the click is tried afresh
    if (receipt !== undefined ? !holds(x, receipt, machine) : live && !unreceipted(x)) return receipt === undefined ? false : 'again'
    // Stopped with its conversation while this machine was trying: it is marked so, and not
    // set aside or sent on under another address, where the stop would not be found again
    if (await stoppedSince(ctx, x)) {
      await dropStopped(ctx, x)
      return true
    }
    // The conversation has been heard from again since this machine's last taking of the click
    // began: it came back while that taking was ending. What stood in the way may well be over,
    // so the click is not set aside, and goes back to be tried afresh. A click this machine has
    // not taken since these times were counted is taken to have been tried before the first.
    // One that another machine took last, and let go of, was tried here before that, and is set
    // aside again as it was: what this machine heard since tells nothing of that machine's taking.
    const current = await generationOf(ctx, machine._id, x.harness, x.sessionId)
    const began = x.claim === undefined ? 0 : x.claim.machineId === machine._id ? (x.claim.generation ?? 0) : current
    if (began !== current) {
      if (x.delivery === 'leased' && x.leaseMachineId === machine._id) await ctx.db.patch(id, await backToWaiting(ctx, x))
      return 'again'
    }
    // The page may have changed hands while this machine was trying. Then the click is not
    // set aside at all: it goes to whoever owns the page now, who has not tried it yet.
    const to = await destination(ctx, x.artifactId)
    const moved = to.machineId !== machine._id || to.harness !== x.harness || to.sessionId !== x.sessionId
    await ctx.db.patch(id, {
      ...(moved ? { ...to, parkedBy: undefined, parkedGeneration: undefined } : { machineId: undefined, parkedBy: machine._id, parkedGeneration: current }),
      delivery: 'pending',
      leaseMachineId: undefined,
      leaseExpiresAt: undefined,
    })
    if (all && !moved && x.harness && x.sessionId)
      await ctx.scheduler.runAfter(0, internal.delivery.parkRest, { machineId: machine._id, harness: x.harness, sessionId: x.sessionId, generation: current })
    return true
  },
})

/**
 * Gives back to a machine what it had set aside for a conversation, when that conversation is
 * heard from again. A click is set aside after a few tries that came to nothing (its app could
 * not be started, the folder was gone, its account had lapsed), so that it does not stand in
 * front of clicks that can be delivered. What stood in the way is often over an hour later, and
 * the sign of that is the conversation itself: open again and asking for its clicks. Left
 * aside then, they would wait until the person told the agent to go and look.
 */
export const unpark = mutation({
  args: { for: session },
  handler: async (ctx, { for: s }): Promise<number> => {
    const { user, machine } = await requireMachine(ctx)
    // This time of its being heard from again, numbered in the order the person's clicks and
    // stops are written in, so that it comes after every setting aside that was written before
    // it and before every one written after it
    const generation = await nextSequence(ctx, user._id)
    const was = await returnOf(ctx, machine._id, s.harness, s.id)
    if (was) await ctx.db.patch(was._id, { generation, at: Date.now() })
    else
      await ctx.db.insert('deliveryReturns', {
        userId: user._id,
        machineId: machine._id,
        harness: s.harness,
        sessionId: s.id,
        generation,
        at: Date.now(),
      })
    const given = await giveBackAside(ctx, user._id, machine._id, s, generation)
    // However many there are: the rest follow a batch at a time, by themselves
    if (given === 50) await ctx.scheduler.runAfter(0, internal.delivery.unparkRest, { userId: user._id, machineId: machine._id, for: s, generation })
    return given
  },
})

/**
 * Gives back one batch of what a machine set aside for a conversation before the time it was
 * heard from again that `generation` names: this machine's again, as they were before it set
 * them aside. What was set aside after that time is left as it is. With no time named, as a
 * step scheduled before these were counted asks, what was set aside before they were counted.
 */
async function giveBackAside(
  ctx: MutationCtx,
  userId: Id<'users'>,
  machineId: Id<'machines'>,
  s: { harness: string; id: string },
  generation: number | undefined,
): Promise<number> {
  const aside = await ctx.db
    .query('actions')
    .withIndex('by_user_parked', (q) => {
      const of = q
        .eq('userId', userId)
        .eq('delivery', 'pending')
        .eq('harness', s.harness)
        .eq('sessionId', s.id)
        .eq('machineId', undefined)
        .eq('parkedBy', machineId)
      return generation === undefined ? of.eq('parkedGeneration', undefined) : of.lt('parkedGeneration', generation)
    })
    .take(50)
  for (const x of aside) {
    // What a stop dropped is not given back to be delivered, whatever was set aside
    if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
    else await ctx.db.patch(x._id, { machineId, parkedBy: undefined, parkedGeneration: undefined })
  }
  return aside.length
}

/**
 * The rest of what a machine had set aside for a conversation that is back, a batch at a time.
 * A later time of its being heard from again gives back all that this one would, and goes on by
 * itself: this one stops there.
 */
export const unparkRest = internalMutation({
  args: { userId: v.id('users'), machineId: v.id('machines'), for: session, generation: v.optional(v.number()) },
  handler: async (ctx, { userId, machineId, for: s, generation }) => {
    if (generation !== undefined && (await generationOf(ctx, machineId, s.harness, s.id)) !== generation) return null
    if ((await giveBackAside(ctx, userId, machineId, s, generation)) === 50)
      await ctx.scheduler.runAfter(0, internal.delivery.unparkRest, { userId, machineId, for: s, generation })
    return null
  },
})

/**
 * Sets aside everything else waiting for a conversation that takes nothing, a batch at a time,
 * however much there is: only for as long as the conversation has not been heard from again
 * since the click that took nothing was set aside. A step that comes after it has been, late,
 * sets nothing aside, and leaves what is waiting to be tried afresh. A step scheduled before
 * these times were counted is taken to be of the time before the first.
 */
export const parkRest = internalMutation({
  args: { machineId: v.id('machines'), harness: v.string(), sessionId: v.string(), generation: v.optional(v.number()) },
  handler: async (ctx, { machineId, harness, sessionId, generation }) => {
    if ((await generationOf(ctx, machineId, harness, sessionId)) !== (generation ?? 0)) return null
    const rest = await ctx.db
      .query('actions')
      .withIndex('by_route', (q) => q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId))
      .take(50)
    for (const other of rest) {
      if (await stoppedSince(ctx, other)) {
        await dropStopped(ctx, other)
        continue
      }
      // Only what is still for that conversation on that machine: a page that has changed
      // hands since has had its clicks addressed afresh, and they are gone from this list
      const to = await destination(ctx, other.artifactId)
      if (to.machineId === machineId && to.harness === harness && to.sessionId === sessionId)
        await ctx.db.patch(other._id, { machineId: undefined, parkedBy: machineId, parkedGeneration: generation ?? 0 })
      else await ctx.db.patch(other._id, { ...to, parkedBy: undefined, parkedGeneration: undefined })
    }
    // Each batch takes what it read out of the list it reads from, so the next starts afresh
    if (rest.length === 50) await ctx.scheduler.runAfter(0, internal.delivery.parkRest, { machineId, harness, sessionId, generation })
    return null
  },
})

/**
 * A machine was revoked or gave up its own access. The clicks waiting for it are from then on no
 * one machine's: a conversation still listening on another of the person's machines, or on the
 * same computer once it is enrolled again, can take them.
 */
export const orphan = internalMutation({
  args: { machineId: v.id('machines'), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { machineId, cursor }) => {
    const batch = await ctx.db
      .query('actions')
      .withIndex('by_route', (q) => q.eq('machineId', machineId).eq('delivery', 'pending'))
      .paginate({ cursor: cursor ?? null, numItems: 50 })
    for (const x of batch.page) {
      // Stopped with its conversation before the machine went: marked so, and addressed to nobody else
      if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
      else await ctx.db.patch(x._id, { machineId: undefined })
    }
    // Each batch moves what it read out of the list it is reading, so the next starts afresh
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.delivery.orphan, { machineId })
    // What the machine had set aside is addressed to no machine, and is not among the above: it
    // is found by the pages the machine owned, whose waiting clicks are each addressed afresh,
    // which lets go of what a machine that is gone had set aside. And when the machine heard
    // each conversation from again is of no more use.
    else {
      await ctx.scheduler.runAfter(0, internal.delivery.orphanPages, { machineId })
      await ctx.scheduler.runAfter(0, internal.delivery.forgetReturns, { machineId })
    }
    return null
  },
})

/** Lets go of when a machine that is gone heard each of its conversations from again, a batch at a time. */
export const forgetReturns = internalMutation({
  args: { machineId: v.id('machines') },
  handler: async (ctx, { machineId }) => {
    const machine = await ctx.db.get(machineId)
    if (machine && !machine.revoked) return null
    const rows = await ctx.db
      .query('deliveryReturns')
      .withIndex('by_machine_session', (q) => q.eq('machineId', machineId))
      .take(100)
    for (const r of rows) await ctx.db.delete(r._id)
    if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.delivery.forgetReturns, { machineId })
    return null
  },
})

/** Addresses afresh what waits on each page of a machine that is gone, a few pages at a time. */
export const orphanPages = internalMutation({
  args: { machineId: v.id('machines'), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { machineId, cursor }) => {
    const batch = await ctx.db
      .query('artifacts')
      .withIndex('by_machine', (q) => q.eq('machineId', machineId))
      .paginate({ cursor: cursor ?? null, numItems: 20 })
    for (const page of batch.page) if ((page.waiting ?? 0) > 0) await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: page._id })
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.delivery.orphanPages, { machineId, cursor: batch.continueCursor })
    return null
  },
})

/** Puts clicks whose lease ran out back in the queue. Run every minute. */
export const reap = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const stale = await ctx.db
      .query('actions')
      .withIndex('by_delivery_lease', (q) => q.eq('delivery', 'leased').lt('leaseExpiresAt', now))
      .take(100)
    for (const x of stale) {
      if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
      else await ctx.db.patch(x._id, await backToWaiting(ctx, x))
    }
    // More than one batch of them: carry on now, not a minute from now
    if (stale.length === 100) await ctx.scheduler.runAfter(0, internal.delivery.reap, {})
    // Each one is a click some connector took and did not hand over: it died, or lost its connection
    if (stale.length) log('lease.expired', { count: stale.length }, 'warn')
    return stale.length
  },
})
