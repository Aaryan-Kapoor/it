// Getting a click to the agent. A click is stored first (actions.ts) and then moves through
// pending -> leased -> handed off. A connector leases the clicks it is about to deliver; if it
// dies, the lease runs out and the click goes back in the queue. Delivery is at-least-once, and
// each click keeps one id, so whoever receives it can tell a repeat from a new one.
//
// Two things about a click never change while it is delivered: which machine it is for, and
// which conversation. Who holds the lease is recorded separately, so a machine that borrows a
// click and dies does not take it away from its owner.
import {
  type ActionPlace,
  actionCursor,
  LEASE_MS,
  LIMITS,
  LISTENING_MOST,
  NOUN,
  placeCursor,
  QUEUES,
  WAKE_BACK_MS,
  WAKE_MOST,
  WAKES,
  wakesOn,
} from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { destination, dropStopped, madeOf, noLongerWaiting, stoppedSince } from './actions'
import { artifactBySlug, requireMachine } from './lib/authz'
import { fail } from './lib/errors'
import { log } from './lib/log'
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
      // When the person made it, which for a click that waited in a browser is before It received it
      at: madeOf(x),
      attended: x.attended ?? null,
      session: x.harness && x.sessionId ? { harness: x.harness, id: x.sessionId } : null,
      version: x.contentVersion,
      ...(x.baseStateRevision === undefined ? {} : { stateRevision: x.baseStateRevision }),
      // Only when it is another version, or another revision: what the person acted on has changed since
      ...(replaced ? { nowVersion: a.currentVersion } : {}),
      ...(stateNow !== undefined && stateNow !== x.baseStateRevision ? { nowStateRevision: stateNow } : {}),
      // The files it carried beside its data, as It received them: save one with `it save <id> <file>`
      ...(x.files?.length ? { files: x.files.map((f) => ({ name: f.name, type: f.type, bytes: f.size })) } : {}),
      // When the person last asked for it to be tried again, where they have: a machine that had
      // given up on it before then tries it afresh. It is for the connector, never the agent
      ...(x.retriedAt !== undefined ? { retriedAt: x.retriedAt } : {}),
      // Which of the person's displays it was done on, where It knows: a page shown on several
      // can be answered on the one the person used
      ...(x.displayId !== undefined ? { displayId: x.displayId } : {}),
      // Why this machine said it holds it back, where it has: said once, and not again with every offer
      ...(x.heldBack && x.heldBack.by === x.machineId ? { heldBack: x.heldBack.why } : {}),
    })
  }
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
  /**
   * And for each, where it has one, the moment only what was made after is read, by when the
   * person made it (`madeAt`) and not when It received it, so that a click saved in a browser
   * before that moment and sent after it is left out with the rest of what came before.
   */
  listening: { harness: string; id: string; since?: number }[],
  read: (rows: Doc<'actions'>[]) => Doc<'actions'>[],
) {
  const rows: Doc<'actions'>[] = []
  // Every conversation the connector may name is looked at first, a few clicks each, oldest
  // first, so that each has its place whatever else is waiting. Read by the person and the
  // conversation: a click whose page belonged to a machine that is gone (the person signed
  // this computer in again, say) has no machine, and still belongs to the conversation that
  // is here and listening.
  //
  // A conversation named with a moment is read from that moment on, by when each click was
  // made, in the index itself: what was made before it is outside what is read, so no number of
  // older clicks can take the places of one that came after. A click kept before It kept when
  // clicks were made has no such time until `dateOld` gives it the time it arrived, which it
  // does within a minute, and is outside what is read until then.
  for (const s of listening.slice(0, LISTENING_MOST)) {
    // This machine's own, and those with no machine, are each read by themselves: read
    // together with everything else waiting for the conversation, a few clicks that are
    // another machine's, or were set aside, could stand in front of one this machine may take.
    const since = s.since
    const route = (machineId: Id<'machines'>) =>
      since === undefined
        ? ctx.db
            .query('actions')
            .withIndex('by_route', (q) => q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id))
        : madeAfter(ctx, machineId, s.harness, s.id, since)
    // These come first and are at most four for each of forty conversations, which is within what may be read whatever they carry
    const own = read(await route(machine._id).take(2))
    // Those with no machine are read as exactly the ones this machine may take: this
    // person's, and not set aside. One that a machine set aside has no machine either, and is
    // not offered again: it waits for `it wait` and the site, until its page changes hands.
    // Nothing is read and then left out, so no number of clicks that may not be taken,
    // another person's or set aside, can stand in front of one that may; and the oldest of
    // them are the ones offered.
    const loose = read(await looseFor(ctx, user._id, s.harness, s.id, since).take(2))
    // Oldest first by what each was read by
    const at = since === undefined ? (x: Doc<'actions'>) => x.createdAt : madeOf
    rows.push(...[...own, ...loose].sort((a, b) => at(a) - at(b)).slice(0, 2))
  }
  return rows
}

/**
 * What waits for one conversation with no machine and not set aside, which any of the person's
 * machines may take, oldest first: by when it arrived, or, after `since`, by when it was made.
 */
const looseFor = (ctx: QueryCtx, userId: Id<'users'>, harness: string, sessionId: string, since: number | undefined) =>
  since === undefined
    ? ctx.db
        .query('actions')
        .withIndex('by_user_route', (q) =>
          q
            .eq('userId', userId)
            .eq('delivery', 'pending')
            .eq('harness', harness)
            .eq('sessionId', sessionId)
            .eq('machineId', undefined)
            .eq('parkedBy', undefined),
        )
    : ctx.db
        .query('actions')
        .withIndex('by_user_route_made', (q) =>
          q
            .eq('userId', userId)
            .eq('delivery', 'pending')
            .eq('harness', harness)
            .eq('sessionId', sessionId)
            .eq('machineId', undefined)
            .eq('parkedBy', undefined)
            .gt('madeAt', since),
        )

/**
 * What waits for one conversation on a machine, oldest first by when it was made, and made after
 * `since`: the moment of a stop, or Auto-wake's cutoff. A click made before then is outside what
 * this reads, also where it arrived after, so no number of them can take the place of one made
 * since. With nothing to be after, as for a harness's own queue, it is everything waiting.
 */
const madeAfter = (ctx: QueryCtx, machineId: Id<'machines'>, harness: string, sessionId: string, since: number) =>
  ctx.db.query('actions').withIndex('by_route_made', (q) => {
    const all = q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId)
    return since > 0 ? all.gt('madeAt', since) : all
  })

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
        const on = wakesOn(machine.system, machine.reopens) ? (machine.wakes ?? []).find((w) => w.harness === harness) : undefined
        if (!on) continue
        from = on.since - WAKE_BACK_MS
      }
      const each = reopened ? WAKE_MOST : 2
      const stoppedAt = (sessionId: string) => (reopened ? ((machine.stops ?? []).find((s) => s.harness === harness && s.sessionId === sessionId)?.at ?? 0) : 0)
      const found: string[] = []
      // How many clicks this queue may read now, of the `n` wanted, each taken to be as large as a click can be
      const until = left - left / (asked.length - nth)
      const may = (n: number, reserved = 0) => Math.max(0, Math.min(n, Math.floor((left - until) / CLICK_MOST) - reserved))
      // Discovery leaves room for the other ways of finding a conversation and for reading
      // its oldest click. Newest rows alone cannot be delivered without skipping earlier ones.
      // Read by when each click was made, so that one made before the cutoff is not read
      // however late it arrived. With no cutoff, as for a harness's own queue, everything is.
      const madeSince = () =>
        ctx.db.query('actions').withIndex('by_harness_made', (q) => {
          const all = q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness)
          return from > 0 ? all.gte('madeAt', from) : all
        })
      const first = Math.min(40, Math.floor(may(80) / 2))
      const oldest = first ? read(await madeSince().take(first)) : []
      // Fewer than were asked for are all there are in this queue: nothing of it need be read a second time
      const all = first > 0 && oldest.length < first
      for (const x of oldest) if (x.sessionId && !found.includes(x.sessionId) && found.length < 10) found.push(x.sessionId)
      // And the ones pressed most recently: a conversation somebody is using now
      const last = Math.min(20, Math.floor(may(40, found.length) / 2))
      const newest = last ? read(await madeSince().order('desc').take(last)) : []
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
        const since = Math.max(from - 1, stoppedAt(sessionId))
        // What was read of the queue's oldest holds this conversation's own oldest, in their
        // order. Where that is all the queue has, or as many as are wanted, it is what reading
        // the conversation would give, and the conversation is not read.
        const known = oldest.filter((x) => x.sessionId === sessionId && madeOf(x) > since)
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
        rows.push(...read(await madeAfter(ctx, machine._id, harness, sessionId, since).take(now)))
      }
    }
    const seen = new Set<string>()
    return asClicks(
      ctx,
      rows.filter((x) => !seen.has(x._id) && seen.add(x._id)),
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
    /**
     * The conversations held in threads of T3 Code that the connector asks for whether or not
     * they are here and whether or not they may be reopened, each with since when it has asked
     * for them that way, by this backend's clock, which it tells at its door. Only what was
     * made after that is read for them, by `madeAt`, which is on the same clock: a click that had
     * waited for such a conversation from before, or was made before and arrived after, is left
     * where it is, for `it wait` and the site, and does not start a turn by itself. A connector
     * asks with this only where the backend names `TAKES.inboxHeld` at its door, since an older
     * one refuses it.
     */
    held: v.optional(v.array(v.object({ harness: v.string(), id: v.string(), since: v.number() }))),
  },
  handler: async (ctx, { listening, queues, after, held }) => {
    const { user, machine } = await requireMachine(ctx)
    let left = READ_MOST
    const bytes = new TextEncoder()
    const read = (rows: Doc<'actions'>[]) => {
      for (const x of rows) left -= carried(bytes, x)
      return rows
    }
    // After the ones that are here, which are read whole, and within the same forty
    const here = new Set(listening.map((s) => `${s.harness}:${s.id}`))
    const named = [...listening, ...(held ?? []).filter((s) => !here.has(`${s.harness}:${s.id}`))]
    const rows = await listeningRows(ctx, user, machine, named, read)
    const next: { harness: string; id: string }[] = []
    const asked = [...new Set(queues ?? [])].filter((h) => ([...QUEUES, ...WAKES] as readonly string[]).includes(h)).slice(0, 8)
    for (const [nth, harness] of asked.entries()) {
      const reopened = !(QUEUES as readonly string[]).includes(harness)
      const on = wakesOn(machine.system, machine.reopens) ? (machine.wakes ?? []).find((w) => w.harness === harness) : undefined
      if (reopened && !on) continue
      const from = reopened ? on!.since - WAKE_BACK_MS : 0
      // A conversation that may be reopened is offered as many clicks as one reopening carries:
      // a reopening takes everything waiting for its conversation in one message, and can take
      // only what it was offered. Codex's queue takes one at a time, and two let the next be seen
      // while the first is on its way, so a Codex conversation is offered more only where
      // Auto-wake is on for Codex.
      const each = on ? WAKE_MOST : 2
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
        const stopped = reopened ? ((machine.stops ?? []).find((s) => s.harness === harness && s.sessionId === sessionId)?.at ?? 0) : 0
        const since = Math.max(from - 1, stopped)
        // Leave four reads and two response places for each later conversation, and two
        // reads for this conversation's attended lookup. Extra places carry its oldest work.
        const want = Math.min(each, places - 2 * rest, may() - 4 * rest - 2)
        const batch = read(await madeAfter(ctx, machine._id, harness, sessionId, since).take(want))
        if (batch.length && batch.every((c) => c.attended === false)) {
          const attended: Doc<'actions'>[] = []
          for (const present of [true, undefined]) {
            const first = await ctx.db
              .query('actions')
              .withIndex('by_attended_route_made', (q) => {
                const all = q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId).eq('attended', present)
                return since > 0 ? all.gt('madeAt', since) : all
              })
              .first()
            if (first) attended.push(...read([first]))
          }
          attended.sort((a, b) => madeOf(a) - madeOf(b) || a._creationTime - b._creationTime)
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
        rows.filter((x) => !seen.has(x._id) && seen.add(x._id)),
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
 * How many of a page's waiting clicks one reading of `waitingPage` gives, and how much of what
 * they carried, by `carried`. A click by itself always fits, so a reading that has any to give
 * gives at least one. What is printed of them is bounded again where it is printed.
 */
const PAGE_MOST = 50
const PAGE_BYTES = 192 * 1024

/** Where a click stands among its page's waiting clicks (`ActionPlace` in the protocol says the order). */
const placeOfRow = (x: Doc<'actions'>): ActionPlace => (x.seq !== undefined ? { seq: x.seq } : { at: x._creationTime, id: x._id })
const byId = (x: Doc<'actions'>, y: Doc<'actions'>) => (x._id < y._id ? -1 : x._id > y._id ? 1 : 0)

/**
 * The clicks waiting on one page, a bounded page of them at a time: what `it actions --id` lists
 * and `it actions --id --follow` watches, on a backend that names it in `TAKES.waitingPage`.
 *
 * They are read in one order that puts every click in a place of its own, which it keeps for as
 * long as it exists (`ActionPlace`): by the number each was given on its page, under the page's
 * record, so that a click committed later always comes later, whatever the clocks said. Those
 * recorded before clicks were numbered come first, by when their records were made and then by
 * id; no more of them are ever made, so nothing can come in among them.
 *
 * Without `after` it is the newest of them, oldest first: a click that has just been made is
 * always among them, however many older ones wait unanswered. `from` is then the place just
 * before them, so that reading `after` it gives these and every later one, and `earlier` says
 * whether older ones wait that were left out.
 *
 * With `after`, it is those after that place, oldest first, and `more` says whether more wait
 * after the last of them. Each click carries its own place as `cursor`. Read after the last
 * one's, and again after the last of those, this reaches every click that waits, however many
 * there are; watched after it, it changes as soon as another one comes.
 *
 * It only reads, as `waiting` does: nothing is claimed, held or answered by reading it.
 */
export const waitingPage = query({
  args: { slug: v.string(), after: v.optional(v.string()) },
  handler: async (ctx, { slug, after }) => {
    const { user } = await requireMachine(ctx)
    const cursor = after === undefined ? undefined : actionCursor(after)
    if (cursor === undefined && after !== undefined)
      fail('invalid', 'That is not a place among the actions on a page: give the `cursor` of one that was listed, or 0 for the start.')
    // What names no page's record, or a record of something else, is no cursor of any page: it is
    // refused as that, and never taken for a cursor of a page that has since been deleted
    if (cursor?.page !== undefined && ctx.db.normalizeId('artifacts', cursor.page) === null)
      fail('invalid', 'That is not a place among the actions on a page: give the `cursor` of one that was listed, or 0 for the start.')
    const a = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    // A cursor of a page that was deleted, where another has been made under its id since: its
    // places are not this page's, whose actions are numbered afresh, and read as this page's
    // they would pass over its actions without a word
    if (cursor?.page !== undefined && cursor.page !== a._id)
      fail(
        'conflict',
        `That cursor is of a ${NOUN.one} that was deleted. The ${NOUN.one} under this id now is another one, and its actions are not after that cursor. Start again without --after.`,
        { staleCursor: true },
      )
    const place = cursor?.place
    /** The numbered ones, in order, after a number or from the first. */
    const numbered = (order: 'asc' | 'desc', after = 0) =>
      ctx.db
        .query('actions')
        .withIndex('by_artifact_seq', (q) => q.eq('artifactId', a._id).eq('delivery', 'pending').gt('seq', after))
        .order(order)
    /**
     * Those from before clicks were numbered, in order, from a place among them or from the
     * first. Records made in the same moment are read together and put in order by id: in the
     * index they stand in an order of the backend's own.
     */
    async function* older(order: 'asc' | 'desc', from?: { at: number; id: string }) {
      const rows = ctx.db
        .query('actions')
        .withIndex('by_artifact_seq', (q) => {
          const old = q.eq('artifactId', a._id).eq('delivery', 'pending').eq('seq', undefined)
          return from ? old.gte('_creationTime', from.at) : old
        })
        .order(order)
      let moment: Doc<'actions'>[] = []
      const together = function* () {
        moment.sort(order === 'asc' ? byId : (x, y) => byId(y, x))
        for (const x of moment) if (!from || x._creationTime !== from.at || x._id > from.id) yield x
        moment = []
      }
      for await (const x of rows) {
        if (moment.length && moment[0]!._creationTime !== x._creationTime) yield* together()
        moment.push(x)
      }
      yield* together()
    }
    const bytes = new TextEncoder()
    /** Takes rows in order while they fit, and gives back the first that did not, if any did not. */
    const fill = async (rows: AsyncIterable<Doc<'actions'>>, into: Doc<'actions'>[]): Promise<Doc<'actions'> | undefined> => {
      let used = 0
      for await (const x of rows) {
        const size = carried(bytes, x)
        if (into.length === PAGE_MOST || (into.length && used + size > PAGE_BYTES)) return x
        into.push(x)
        used += size
      }
      return undefined
    }
    const rows: Doc<'actions'>[] = []
    let earlier = false
    let more = false
    // Always of this page, so that a watch begun from it is refused, not misled, if the page is made again
    let from = placeCursor(a._id, place ?? null)
    if (place === undefined) {
      async function* newestFirst() {
        yield* numbered('desc')
        yield* older('desc')
      }
      const left = await fill(newestFirst(), rows)
      rows.reverse()
      if (left) {
        earlier = true
        from = placeCursor(a._id, placeOfRow(left))
      }
    } else {
      const at = place
      async function* later() {
        if (at === null || !('seq' in at)) yield* older('asc', at ?? undefined)
        yield* numbered('asc', at !== null && 'seq' in at ? at.seq : 0)
      }
      more = (await fill(later(), rows)) !== undefined
    }
    const clicks = await asClicks(ctx, rows)
    const places = new Map(rows.map((x) => [x._id as string, placeCursor(a._id, placeOfRow(x))]))
    return { actions: clicks.map((c) => ({ ...c, cursor: places.get(c.id)! })), from, more, earlier }
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

/**
 * What is still waiting across the person's pages, newest first: what `it actions` lists.
 *
 * Asked `for` a conversation, it is that conversation's alone, and what waits on pages that no
 * conversation has, which are everyone's to see. A conversation's are what `it wait` takes for
 * it: the ones addressed to this machine, to no machine, or set aside by this machine. Each is
 * read by itself, and newest first, so that no number of other conversations' clicks stands in
 * front of one of its own. Asked for no conversation, it is every click that waits: the
 * person's own view. This keeps an agent from being shown, and acting on, a click that another
 * conversation is to answer. It is no wall between agents: any agent on a machine can ask for
 * every click, as the person can.
 */
export const allWaiting = query({
  args: { for: v.optional(session) },
  handler: async (ctx, { for: s }) => {
    const { user, machine } = await requireMachine(ctx)
    if (!s) {
      const rows = await ctx.db
        .query('actions')
        .withIndex('by_user_delivery', (q) => q.eq('userId', user._id).eq('delivery', 'pending'))
        .order('desc')
        .take(50)
      return asClicks(ctx, rows)
    }
    // Four lists of at most 50 each, which is within what a query may read however much each click carries
    const of = (machineId: Id<'machines'> | undefined, aside: Id<'machines'> | undefined) =>
      ctx.db
        .query('actions')
        .withIndex('by_user_route', (q) =>
          q.eq('userId', user._id).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id).eq('machineId', machineId).eq('parkedBy', aside),
        )
        .order('desc')
        .take(50)
    const nobodys = ctx.db
      .query('actions')
      .withIndex('by_user_session', (q) => q.eq('userId', user._id).eq('delivery', 'pending').eq('harness', undefined).eq('sessionId', undefined))
      .order('desc')
      .take(50)
    const rows = [...(await of(machine._id, undefined)), ...(await of(undefined, undefined)), ...(await of(undefined, machine._id)), ...(await nobodys)]
    return asClicks(ctx, rows.sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime).slice(0, 50))
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
 * click makes it, before it asks, so that a taking whose answer was lost on its way can be asked
 * for again under the same one. Every later word of that hand-over names it: keeping the hold,
 * giving the click back, setting it aside, and saying that it was handed over. A word that names
 * another receipt, or none, says nothing of this taking. The click's id alone cannot tell two
 * takings apart: a machine that lost its hold and took the click again has taken the same click.
 */
const receiptOf = v.string()
const RECEIPT = /^[A-Za-z0-9_-]{16,64}$/
/** The receipts of the clicks a list names, each beside the click's id. */
const receipts = v.optional(v.array(v.object({ id: v.id('actions'), receipt: receiptOf })))
const receiptFor = (named: { id: Id<'actions'>; receipt: string }[] | undefined, id: Id<'actions'>) => named?.find((r) => r.id === id)?.receipt
/**
 * Whether a click's last taking was made with no receipt: by a machine whose It is from before
 * receipts, or before takings were kept at all. Such a machine goes on as it did. What it says
 * without a receipt is taken of a click that was last taken without one, and of no other: a
 * click taken with a receipt is not kept, given back, set aside or said to be handed over by
 * anything that does not name that receipt, but for an agent's or a person's own `it ack`.
 */
const unreceipted = (x: Doc<'actions'>) => x.claim?.receipt === undefined
/** Whether this machine's taking of a click that the receipt names is still the click's last. */
const holds = (x: Doc<'actions'>, receipt: string, machine: Doc<'machines'>) => x.claim?.receipt === receipt && x.claim.machineId === machine._id
/** Whether what a machine says of a click, by a receipt or by none, is said of the click's last taking. */
const lastTaking = (x: Doc<'actions'>, receipt: string | undefined, machine: Doc<'machines'>) =>
  receipt === undefined ? unreceipted(x) : holds(x, receipt, machine)

/** The record of when a conversation was last heard from again on a machine, where there is one. */
const returnOf = (ctx: QueryCtx, machineId: Id<'machines'>, harness: string, sessionId: string) =>
  ctx.db
    .query('deliveryReturns')
    .withIndex('by_machine_session', (q) => q.eq('machineId', machineId).eq('harness', harness).eq('sessionId', sessionId))
    .unique()
/**
 * Which time of a conversation being heard from again on a machine was the last, as the machine
 * numbers them: nothing where it never has been, or not for a month.
 */
async function generationOf(ctx: QueryCtx, machineId: Id<'machines'>, harness: string | undefined, sessionId: string | undefined): Promise<number> {
  if (harness === undefined || sessionId === undefined) return 0
  return (await returnOf(ctx, machineId, harness, sessionId))?.generation ?? 0
}

/**
 * Leases clicks for delivery. Returns the ones this caller now holds. A connector that is about
 * to deliver into a conversation says which (`for`): a click that has since been addressed to
 * another conversation or another machine, because its page changed hands, is then left alone.
 *
 * The taking is known by the receipt the caller made for it. Asked again under the same
 * receipt, as after an answer that was lost, a click that taking still holds is held still. One
 * it no longer holds is not taken afresh under it: what was done under that receipt is over.
 */
export const claim = mutation({
  args: { ids: v.array(v.id('actions')), for: v.optional(session), receipt: v.optional(receiptOf) },
  handler: async (ctx, { ids, for: expected, receipt }) => {
    const { user, machine } = await requireMachine(ctx)
    if (receipt !== undefined && !RECEIPT.test(receipt)) fail('invalid', 'That is not a receipt.')
    const now = Date.now()
    const held = []
    const adopted = new Set<string>()
    // Which time of its conversation being heard from again each taking is made under: a
    // setting aside it ends in counts only where that is still the last (`park`)
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
        if (x.delivery !== 'leased' || (x.leaseExpiresAt ?? 0) < now) continue
        // Unless its conversation was stopped since it was taken, and the stop's steps have not
        // come to it yet: it goes with the stop now, and is given out no more
        if (await stoppedSince(ctx, x)) {
          await dropStopped(ctx, x)
          continue
        }
        held.push(id)
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
        // This taking, in the place of whichever was the click's last: what is said by an earlier one's receipt is said of it no more
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

/**
 * Keeps hold of clicks this machine has leased and is still waiting to hand over, each by the
 * receipt of the taking that holds it. Returns the ones it still holds: a click this machine
 * has taken again since, under another receipt, is not kept by the earlier one.
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
      if (!lastTaking(x, receiptFor(named, id), machine)) continue
      // Stopped with its conversation while this machine held it, and the stop's steps have not
      // come to it yet: it goes with the stop, and the machine, told it holds it no more, gives it out no more
      if (await stoppedSince(ctx, x)) {
        await dropStopped(ctx, x)
        continue
      }
      await ctx.db.patch(id, { leaseExpiresAt: now + LEASE_MS })
      held.push(id)
    }
    return held
  },
})

/**
 * Of clicks a machine was holding and no longer holds, the ones that are somebody else's to
 * deliver by now, or have been delivered by somebody else: waiting again, held by another
 * machine, held by this one past the time it had them for or under a later taking than the one
 * the receipt names, or handed over by another machine
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
      // Held under another taking than the one asked about, also one of this machine's own
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
 * taking is the click's last. Said late, once the click has been taken again, on the same
 * machine or another, it says nothing of the later taking and is refused. It counts where the
 * hold itself has run out or was given back meanwhile and nothing has taken the click since, as
 * when the connector that handed it over was started again: the agent has the click, and what
 * was given back only waits to be told so. `manual` is an agent or a person saying with `it ack`
 * that they have it, which is no machine's word about a taking and needs no receipt.
 */
export const handedOff = mutation({
  args: { id: v.id('actions'), route: v.string(), receipt: v.optional(receiptOf) },
  handler: async (ctx, { id, route, receipt }) => {
    const { x, machine } = await mine(ctx, id)
    const said = (already: boolean) => ({ already, at: x.createdAt, harness: x.harness ?? null })
    const manual = route === 'manual'
    if (x.delivery === 'handed_off') {
      // The same hand-over said again, an `it ack`, or a click a stop took: there is nothing more to do
      if (manual || x.route === 'stopped' || lastTaking(x, receipt, machine)) return said(true)
      fail('conflict', 'That is said of another hand-over of this click than the one it was handed over by.')
    }
    if (x.delivery === 'leased' && x.leaseMachineId !== machine._id && (x.leaseExpiresAt ?? 0) > Date.now())
      fail('conflict', 'Another machine is delivering this.')
    // Stopped with its conversation while it was on its way: it counts as stopped, and not as
    // something an agent was given, whatever way it was about to be handed over
    if (await stoppedSince(ctx, x)) {
      await dropStopped(ctx, x)
      return said(true)
    }
    // Said of a taking that is not the click's last: by an earlier receipt, once the click was
    // taken again, or by none, of a click taken with one. The later taking has handed nothing over
    if (!manual && !lastTaking(x, receipt, machine))
      fail(
        'conflict',
        receipt === undefined
          ? 'This click was taken with a receipt, and this word of it has none. Update It on this machine.'
          : 'That receipt is of a hand-over that no longer holds this click.',
      )
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
    await ctx.db.patch(id, { outcome, settledAt: Date.now() })
    return null
  },
})

/** Gives a leased click back, when it could not be delivered after all: only the taking its receipt names, while that holds the click. */
export const release = mutation({
  args: { id: v.id('actions'), receipt: v.optional(receiptOf) },
  handler: async (ctx, { id, receipt }) => {
    const { x, machine } = await mine(ctx, id)
    // Back in the queue, addressed to whoever owns the page now: it may have changed hands meanwhile
    if (x.delivery === 'leased' && x.leaseMachineId === machine._id && lastTaking(x, receipt, machine)) {
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
   * `again` where it was not set aside and is to be tried afresh: the taking that gave up on it
   * is no longer its last, or its conversation has been heard from again since that taking was
   * made, so that what stood in the way may be over. Only a machine that names a receipt is
   * answered `again`: one from before receipts reads every answer but `false` as set aside, and
   * what it asks is done as it always was.
   */
  handler: async (ctx, { id, for: tried, all, receipt }): Promise<boolean | 'again'> => {
    const { x, machine } = await mine(ctx, id)
    if (x.delivery === 'handed_off' || x.machineId !== machine._id) return true
    // Addressed to another conversation since this machine tried it (its page changed hands on
    // this same machine): it is that conversation's now, and has not been tried there
    if (tried && (x.harness !== tried.harness || x.sessionId !== tried.id)) return true
    // Another machine may have taken it meanwhile (this one's lease ran out while its command
    // was still running). What that machine holds is left exactly as it is.
    if (x.delivery === 'leased' && x.leaseMachineId !== machine._id && (x.leaseExpiresAt ?? 0) > Date.now()) return false
    // And so is a click whose last taking is not the one that gave up on it, whether that later
    // taking still holds it or its hold has run out or been given back: the later one has had
    // its tries or is having them. Said by an earlier receipt, the click is to be tried afresh.
    // Said by none, of a click taken with one, it is not the asker's to set aside at all.
    if (!lastTaking(x, receipt, machine)) return receipt === undefined ? true : 'again'
    // Stopped with its conversation while this machine was trying: it is marked so, and not
    // set aside or sent on under another address, where the stop would not be found again
    if (await stoppedSince(ctx, x)) {
      await dropStopped(ctx, x)
      return true
    }
    // The conversation has been heard from again since the taking that gave up was made: it
    // came back while that delivery was ending. What stood in the way may well be over, so the
    // click is not set aside, and goes back to waiting to be tried afresh. A machine from before
    // receipts cannot be told so, and its click is set aside as it asks, under the number of the
    // last time, so that the next time the conversation is heard from gives it back.
    const current = await generationOf(ctx, machine._id, x.harness, x.sessionId)
    if (receipt !== undefined && (x.claim?.generation ?? 0) !== current) {
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
    // The rest are set aside by what was decided now: one the person asks to have tried again
    // after this, before the rest is reached, is tried again and not set aside by it. And only
    // for as long as the conversation is not heard from again: a step that comes after that sets nothing aside
    if (all && !moved && x.harness && x.sessionId)
      await ctx.scheduler.runAfter(0, internal.delivery.parkRest, {
        machineId: machine._id,
        harness: x.harness,
        sessionId: x.sessionId,
        decidedAt: Date.now(),
        generation: current,
      })
    return true
  },
})

/** How many clicks one machine says it holds back, or no longer holds back, in one call. */
const HOLD_MOST = 50

/**
 * The machine says why it will not start the conversation of some of the clicks it is to
 * deliver, so that their page says so for as long as they wait (`heldBack`), or with `why`
 * null that it no longer holds them back. Said again, it changes nothing. A click that is no
 * longer this machine's to deliver, or no longer waits (taken, or handed over), is left as it is. Answers with the clicks
 * it is done with, which is all of those asked about that are the person's.
 */
export const holdBack = mutation({
  args: { ids: v.array(v.id('actions')), why: v.union(v.string(), v.null()) },
  handler: async (ctx, { ids, why }): Promise<string[]> => {
    const { user, machine } = await requireMachine(ctx)
    if (ids.length > HOLD_MOST) fail('invalid', `At most ${HOLD_MOST} clicks at a time.`)
    const done: string[] = []
    for (const id of new Set(ids)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id) continue
      done.push(id)
      // Only while it waits for this machine: one an agent or a machine has taken is on its way, and
      // a word that arrives late leaves it as it is, to be said again should it come back
      if (x.delivery !== 'pending' || x.machineId !== machine._id) continue
      const next = why === null ? undefined : { by: machine._id, why: why.slice(0, 300) }
      if (x.heldBack?.by !== next?.by || x.heldBack?.why !== next?.why) await ctx.db.patch(id, { heldBack: next })
    }
    return done
  },
})

/**
 * Gives back to a machine what it had set aside for a conversation, when that conversation is
 * heard from again. A click is set aside after a few tries that came to nothing (its app could
 * not be started, the folder was gone, its account had lapsed), so that it does not stand in
 * front of clicks that can be delivered. What stood in the way is often over an hour later, and
 * the sign of that is the conversation itself: open again and asking for its clicks. Left
 * aside then, they would wait until the person told the agent to go and look.
 *
 * Each such time is numbered, by the machine's own count of them, and the number is kept for
 * the conversation. A delivery that was still ending as the conversation came back may set its
 * click aside, or schedule the rest to be set aside, after this has looked and found nothing:
 * so every taking of a click is made under the number that was the last by then, and a setting
 * aside that was decided under an earlier number than the last sets nothing aside (`park`,
 * `parkRest`). What is given back is what was set aside before this time, and what a later
 * setting aside puts there stays.
 */
export const unpark = mutation({
  args: { for: session },
  handler: async (ctx, { for: s }): Promise<number> => {
    const { user, machine } = await requireMachine(ctx)
    const generation = (machine.returns ?? 0) + 1
    await ctx.db.patch(machine._id, { returns: generation })
    const was = await returnOf(ctx, machine._id, s.harness, s.id)
    if (was) await ctx.db.patch(was._id, { generation, at: Date.now() })
    else await ctx.db.insert('deliveryReturns', { userId: user._id, machineId: machine._id, harness: s.harness, sessionId: s.id, generation, at: Date.now() })
    const given = await giveBackAside(ctx, user._id, machine._id, s, generation)
    // However many there are: the rest follow a batch at a time, by themselves
    if (given === 50) await ctx.scheduler.runAfter(0, internal.delivery.unparkRest, { userId: user._id, machineId: machine._id, for: s, generation })
    return given
  },
})

/**
 * Gives back one batch of what a machine set aside for a conversation before the time of its
 * being heard from again that `generation` numbers: this machine's again, as they were before
 * it set them aside. What was set aside since that time stays. With no time named, as a step
 * that was scheduled before they were numbered asks, everything that was set aside is given back.
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
      // What was set aside before these times were numbered carries no number, and stands before every number
      return generation === undefined ? of : of.lt('parkedGeneration', generation)
    })
    .take(50)
  for (const x of aside) {
    // What a stop took meanwhile is not given back to be delivered
    if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
    else await ctx.db.patch(x._id, { machineId, parkedBy: undefined, parkedGeneration: undefined })
  }
  return aside.length
}

/**
 * The rest of what a machine had set aside for a conversation that is back, a batch at a time.
 * Once the conversation has been heard from yet again, that later time gives back all that this
 * one would and goes on by itself, and this one stops.
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
 * however much there is, and only for as long as the conversation has not been heard from again
 * since the click that took nothing was set aside. A step that comes after it has been sets
 * nothing aside, and what is waiting is tried afresh.
 */
export const parkRest = internalMutation({
  args: {
    machineId: v.id('machines'),
    harness: v.string(),
    sessionId: v.string(),
    /** When the machine found that the conversation takes nothing. Absent from what was scheduled before this was carried. */
    decidedAt: v.optional(v.number()),
    /** Which time of the conversation being heard from again was the last when that was found. Absent from what was scheduled before these were numbered, which goes on as it was scheduled. */
    generation: v.optional(v.number()),
    /**
     * Where the last batch stopped, by when its last click was made and when its record was:
     * what is passed over below stays in the list, and the next batch starts after it.
     */
    after: v.optional(v.object({ made: v.number(), at: v.number() })),
  },
  handler: async (ctx, { machineId, harness, sessionId, decidedAt, generation, after }) => {
    // The conversation was heard from again since: what is waiting for it is tried, and not set aside by a decision from before that
    if (generation !== undefined && (await generationOf(ctx, machineId, harness, sessionId)) !== generation) return null
    // Those made at the same moment as the last one read, after it, and then those made later
    const rest = after
      ? await ctx.db
          .query('actions')
          .withIndex('by_route', (q) =>
            q
              .eq('machineId', machineId)
              .eq('delivery', 'pending')
              .eq('harness', harness)
              .eq('sessionId', sessionId)
              .eq('createdAt', after.made)
              .gt('_creationTime', after.at),
          )
          .take(50)
      : []
    if (rest.length < 50)
      rest.push(
        ...(await ctx.db
          .query('actions')
          .withIndex('by_route', (q) => {
            const route = q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId)
            return after ? route.gt('createdAt', after.made) : route
          })
          .take(50 - rest.length)),
      )
    for (const other of rest) {
      if (await stoppedSince(ctx, other)) {
        await dropStopped(ctx, other)
        continue
      }
      // The person asked to have it tried again since the machine gave up on the conversation:
      // it is to have its tries, and what was decided before that is not the last word on it
      if (decidedAt !== undefined && other.retriedAt !== undefined && other.retriedAt >= decidedAt) continue
      // Only what is still for that conversation on that machine: a page that has changed
      // hands since has had its clicks addressed afresh, and they are gone from this list
      const to = await destination(ctx, other.artifactId)
      if (to.machineId === machineId && to.harness === harness && to.sessionId === sessionId)
        await ctx.db.patch(other._id, { machineId: undefined, parkedBy: machineId, parkedGeneration: generation })
      else await ctx.db.patch(other._id, { ...to, parkedBy: undefined, parkedGeneration: undefined })
    }
    const last = rest.at(-1)
    if (last && rest.length === 50)
      await ctx.scheduler.runAfter(0, internal.delivery.parkRest, {
        machineId,
        harness,
        sessionId,
        decidedAt,
        generation,
        after: { made: last.createdAt, at: last._creationTime },
      })
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
    // which lets go of what a machine that is gone had set aside. When the machine heard each
    // of its conversations from again is of no more use either.
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

/**
 * Gives a waiting click that was kept before It kept when clicks were made the time it arrived
 * as that time, which is the time it went by until then, a batch at a time. A harness's queue
 * and a closed conversation are offered clicks by when they were made, and a click with no such
 * time would be outside what is read for them. Run every minute: once every waiting click has
 * one, it reads nothing.
 */
export const dateOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    let full = false
    for (const delivery of ['pending', 'leased'] as const) {
      const old = await ctx.db
        .query('actions')
        .withIndex('by_delivery_made', (q) => q.eq('delivery', delivery).eq('madeAt', undefined))
        .take(50)
      for (const x of old) await ctx.db.patch(x._id, { madeAt: x.createdAt })
      if (old.length === 50) full = true
    }
    // Each batch takes what it dated out of the list it reads from, so the next starts afresh
    if (full) await ctx.scheduler.runAfter(0, internal.delivery.dateOld, {})
    return null
  },
})
