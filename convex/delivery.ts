// Getting a click to the agent. A click is stored first (actions.ts) and then moves through
// pending -> leased -> handed off. A connector leases the clicks it is about to deliver; if it
// dies, the lease runs out and the click goes back in the queue. Delivery is at-least-once, and
// each click keeps one id, so whoever receives it can tell a repeat from a new one.
//
// Two things about a click never change while it is delivered: which machine it is for, and
// which conversation. Who holds the lease is recorded separately, so a machine that borrows a
// click and dies does not take it away from its owner.
import { LEASE_MS, LISTENING_MOST, QUEUES, WAKE_BACK_MS, WAKE_MOST, WAKES, wakesOn } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, type QueryCtx, query } from './_generated/server'
import { destination, dropStopped, noLongerWaiting, stoppedSince } from './actions'
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
      at: x.createdAt,
      attended: x.attended ?? null,
      session: x.harness && x.sessionId ? { harness: x.harness, id: x.sessionId } : null,
      version: x.contentVersion,
      ...(x.baseStateRevision === undefined ? {} : { stateRevision: x.baseStateRevision }),
      // Only when it is another version, or another revision: what the person acted on has changed since
      ...(replaced ? { nowVersion: a.currentVersion } : {}),
      ...(stateNow !== undefined && stateNow !== x.baseStateRevision ? { nowStateRevision: stateNow } : {}),
    })
  }
  return out
}

/**
 * The clicks this machine can deliver right now. Its connector subscribes to this, and says
 * which conversations are listening. Clicks for conversations that are not are left out, so
 * that a pile of clicks nobody can take never hides one that somebody can.
 */
export const inbox = query({
  args: { listening: v.array(session), queues: v.optional(v.array(v.string())) },
  handler: async (ctx, { listening, queues }) => {
    const { user, machine } = await requireMachine(ctx)
    const rows: Doc<'actions'>[] = []
    // Kept small enough in all that the largest clicks allowed still fit in one answer: never
    // more than this many rows read, however many conversations are listening
    const BUDGET = 150
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
      const own = await route(machine._id).take(2)
      // Those with no machine are read as exactly the ones this machine may take: this
      // person's, and not set aside. One that a machine set aside has no machine either, and is
      // not offered again: it waits for `it wait` and the site, until its page changes hands.
      // Nothing is read and then left out, so no number of clicks that may not be taken,
      // another person's or set aside, can stand in front of one that may; and the oldest of
      // them are the ones offered.
      const loose = await ctx.db
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
        .take(2)
      rows.push(...[...own, ...loose].sort((a, b) => a.createdAt - b.createdAt).slice(0, 2))
    }
    // A harness with a queue of its own takes a click whether or not its conversation is open.
    // Read conversation by conversation, the oldest few of each: one conversation that takes
    // nothing (its thread is gone, say) then stands in the way of no other, and within each,
    // what was pressed first is delivered first. The conversations are found three ways, so that
    // no number of them that take nothing can hide one that would: by which have waited
    // longest, by which were pressed most recently, and in the order of their names.
    //
    // A harness whose closed conversations are reopened is read the same way, with three
    // things more. It is read only where the person has switched that on for it on this
    // machine, whatever the connector asks. Only what was done from about then on is read:
    // what had waited longer is not reopened for, and read with the rest, the oldest few of a
    // conversation, it would stand in front of every later click for good. The same holds for
    // what was waiting when the person stopped a conversation. And more of each conversation
    // is read, since one reopening carries all that is waiting for it.
    for (const harness of (queues ?? []).slice(0, 8)) {
      let from = 0
      const reopened = (WAKES as readonly string[]).includes(harness) && !(QUEUES as readonly string[]).includes(harness)
      if (reopened) {
        // And only on a system It reopens conversations on, whatever was switched on for this machine before that was asked
        const on = wakesOn(machine.system) ? (machine.wakes ?? []).find((w) => w.harness === harness) : undefined
        if (!on) continue
        from = on.since - WAKE_BACK_MS
      }
      const each = reopened ? WAKE_MOST : 2
      const stoppedAt = (sessionId: string) => (reopened ? ((machine.stops ?? []).find((s) => s.harness === harness && s.sessionId === sessionId)?.at ?? 0) : 0)
      const found: string[] = []
      const oldest = await ctx.db
        .query('actions')
        .withIndex('by_harness', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gte('createdAt', from))
        .take(40)
      for (const x of oldest) if (x.sessionId && !found.includes(x.sessionId) && found.length < 10) found.push(x.sessionId)
      // And the ones pressed most recently: a conversation somebody is using now
      const newest = await ctx.db
        .query('actions')
        .withIndex('by_harness', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gte('createdAt', from))
        .order('desc')
        .take(20)
      for (const x of newest) if (x.sessionId && !found.includes(x.sessionId) && found.length < 16) found.push(x.sessionId)
      let after = ''
      for (let named = 0; named < 12; named++) {
        const head = await ctx.db
          .query('actions')
          .withIndex('by_route', (q) => q.eq('machineId', machine._id).eq('delivery', 'pending').eq('harness', harness).gt('sessionId', after))
          .first()
        if (!head?.sessionId) break
        after = head.sessionId
        if (!found.includes(after)) found.push(after)
      }
      for (const sessionId of found) {
        if (rows.length >= BUDGET) break
        rows.push(
          ...(await ctx.db
            .query('actions')
            .withIndex('by_route', (q) =>
              q
                .eq('machineId', machine._id)
                .eq('delivery', 'pending')
                .eq('harness', harness)
                .eq('sessionId', sessionId)
                .gt('createdAt', Math.max(from - 1, stoppedAt(sessionId))),
            )
            .take(Math.min(each, BUDGET - rows.length))),
        )
      }
    }
    const seen = new Set<string>()
    return asClicks(
      ctx,
      rows.filter((x) => !seen.has(x._id) && seen.add(x._id)),
    )
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
 * What is waiting for one conversation, on any of the person's machines, oldest first: what
 * `it wait` with no page named takes. Read by the conversation, so that other conversations'
 * clicks, however many, never stand in front of it.
 */
export const waitingFor = query({
  args: { session },
  handler: async (ctx, { session: s }) => {
    const { user } = await requireMachine(ctx)
    const rows = await ctx.db
      .query('actions')
      .withIndex('by_user_session', (q) => q.eq('userId', user._id).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id))
      .take(50)
    return asClicks(ctx, rows)
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
 * Leases clicks for delivery. Returns the ones this caller now holds. A connector that is about
 * to deliver into a conversation says which (`for`): a click that has since been addressed to
 * another conversation or another machine, because its page changed hands, is then left alone.
 */
export const claim = mutation({
  args: { ids: v.array(v.id('actions')), for: v.optional(session) },
  handler: async (ctx, { ids, for: expected }) => {
    const { user, machine } = await requireMachine(ctx)
    const now = Date.now()
    const held = []
    const adopted = new Set<string>()
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
      const free = x.delivery === 'pending' || (x.delivery === 'leased' && (x.leaseExpiresAt ?? 0) < now)
      if (!free) continue
      // Stopped with its conversation, and not yet marked so: it is marked now, and not given out
      if (await stoppedSince(ctx, x)) {
        await dropStopped(ctx, x)
        continue
      }
      await ctx.db.patch(id, { delivery: 'leased', leaseMachineId: machine._id, leaseExpiresAt: now + LEASE_MS })
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

/** Keeps hold of clicks this machine has leased and is still waiting to hand over. Returns the ones it still holds. */
export const renew = mutation({
  args: { ids: v.array(v.id('actions')) },
  handler: async (ctx, { ids }) => {
    const { user, machine } = await requireMachine(ctx)
    const now = Date.now()
    const held = []
    for (const id of ids.slice(0, 50)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id || x.delivery !== 'leased' || x.leaseMachineId !== machine._id || (x.leaseExpiresAt ?? 0) < now) continue
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
  args: { ids: v.array(v.id('actions')) },
  handler: async (ctx, { ids }) => {
    const { user, machine } = await requireMachine(ctx)
    const now = Date.now()
    const theirs = []
    for (const id of ids.slice(0, 50)) {
      const x = await ctx.db.get(id)
      if (!x || x.userId !== user._id) continue
      if (
        x.delivery === 'pending' ||
        (x.delivery === 'leased' && (x.leaseMachineId !== machine._id || (x.leaseExpiresAt ?? 0) < now)) ||
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
 */
export const handedOff = mutation({
  args: { id: v.id('actions'), route: v.string() },
  handler: async (ctx, { id, route }) => {
    const { x, machine } = await mine(ctx, id)
    const said = (already: boolean) => ({ already, at: x.createdAt, harness: x.harness ?? null })
    if (x.delivery === 'handed_off') return said(true)
    if (x.delivery === 'leased' && x.leaseMachineId !== machine._id && (x.leaseExpiresAt ?? 0) > Date.now())
      fail('conflict', 'Another machine is delivering this.')
    // Stopped with its conversation while it was on its way: it counts as stopped, and not as
    // something an agent was given, whatever way it was about to be handed over
    if (await stoppedSince(ctx, x)) {
      await dropStopped(ctx, x)
      return said(true)
    }
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

/** Gives a leased click back, when it could not be delivered after all. */
export const release = mutation({
  args: { id: v.id('actions') },
  handler: async (ctx, { id }) => {
    const { x, machine } = await mine(ctx, id)
    // Back in the queue, addressed to whoever owns the page now: it may have changed hands meanwhile
    if (x.delivery === 'leased' && x.leaseMachineId === machine._id) {
      // Stopped with its conversation while this machine had it: it goes back to nobody
      if (await stoppedSince(ctx, x)) await dropStopped(ctx, x)
      else await ctx.db.patch(id, await backToWaiting(ctx, x))
    }
    return null
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
    /** The conversation the machine was trying to deliver it into. If the click is for another by now, it is left as it is. */
    for: v.optional(session),
    /** The conversation takes nothing at all (its thread is gone): everything else waiting for it is set aside with this click. */
    all: v.optional(v.boolean()),
  },
  /** True once the click has stopped being this machine's to deliver: set aside, gone elsewhere, or handed over. False when another machine holds it now, and the asking has to be repeated. */
  handler: async (ctx, { id, for: tried, all }): Promise<boolean> => {
    const { x, machine } = await mine(ctx, id)
    if (x.delivery === 'handed_off' || x.machineId !== machine._id) return true
    // Addressed to another conversation since this machine tried it (its page changed hands on
    // this same machine): it is that conversation's now, and has not been tried there
    if (tried && (x.harness !== tried.harness || x.sessionId !== tried.id)) return true
    // Another machine may have taken it meanwhile (this one's lease ran out while its command
    // was still running). What that machine holds is left exactly as it is.
    if (x.delivery === 'leased' && x.leaseMachineId !== machine._id && (x.leaseExpiresAt ?? 0) > Date.now()) return false
    // The page may have changed hands while this machine was trying. Then the click is not
    // set aside at all: it goes to whoever owns the page now, who has not tried it yet.
    const to = await destination(ctx, x.artifactId)
    const moved = to.machineId !== machine._id || to.harness !== x.harness || to.sessionId !== x.sessionId
    await ctx.db.patch(id, {
      ...(moved ? { ...to, parkedBy: undefined } : { machineId: undefined, parkedBy: machine._id }),
      delivery: 'pending',
      leaseMachineId: undefined,
      leaseExpiresAt: undefined,
    })
    if (all && !moved && x.harness && x.sessionId)
      await ctx.scheduler.runAfter(0, internal.delivery.parkRest, { machineId: machine._id, harness: x.harness, sessionId: x.sessionId })
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
    const aside = await ctx.db
      .query('actions')
      .withIndex('by_user_route', (q) =>
        q
          .eq('userId', user._id)
          .eq('delivery', 'pending')
          .eq('harness', s.harness)
          .eq('sessionId', s.id)
          .eq('machineId', undefined)
          .eq('parkedBy', machine._id),
      )
      .take(50)
    // This machine's again, as they were before it set them aside
    for (const x of aside) await ctx.db.patch(x._id, { machineId: machine._id, parkedBy: undefined })
    // However many there are: the rest follow a batch at a time, by themselves
    if (aside.length === 50) await ctx.scheduler.runAfter(0, internal.delivery.unparkRest, { userId: user._id, machineId: machine._id, for: s })
    return aside.length
  },
})

/** The rest of what a machine had set aside for a conversation that is back, a batch at a time. */
export const unparkRest = internalMutation({
  args: { userId: v.id('users'), machineId: v.id('machines'), for: session },
  handler: async (ctx, { userId, machineId, for: s }) => {
    const aside = await ctx.db
      .query('actions')
      .withIndex('by_user_route', (q) =>
        q.eq('userId', userId).eq('delivery', 'pending').eq('harness', s.harness).eq('sessionId', s.id).eq('machineId', undefined).eq('parkedBy', machineId),
      )
      .take(50)
    for (const x of aside) await ctx.db.patch(x._id, { machineId, parkedBy: undefined })
    if (aside.length === 50) await ctx.scheduler.runAfter(0, internal.delivery.unparkRest, { userId, machineId, for: s })
    return null
  },
})

/** Sets aside everything else waiting for a conversation that takes nothing, a batch at a time, however much there is. */
export const parkRest = internalMutation({
  args: { machineId: v.id('machines'), harness: v.string(), sessionId: v.string() },
  handler: async (ctx, { machineId, harness, sessionId }) => {
    const rest = await ctx.db
      .query('actions')
      .withIndex('by_route', (q) => q.eq('machineId', machineId).eq('delivery', 'pending').eq('harness', harness).eq('sessionId', sessionId))
      .take(50)
    for (const other of rest) {
      // Only what is still for that conversation on that machine: a page that has changed
      // hands since has had its clicks addressed afresh, and they are gone from this list
      const to = await destination(ctx, other.artifactId)
      if (to.machineId === machineId && to.harness === harness && to.sessionId === sessionId)
        await ctx.db.patch(other._id, { machineId: undefined, parkedBy: machineId })
      else await ctx.db.patch(other._id, { ...to, parkedBy: undefined })
    }
    // Each batch takes what it read out of the list it reads from, so the next starts afresh
    if (rest.length === 50) await ctx.scheduler.runAfter(0, internal.delivery.parkRest, { machineId, harness, sessionId })
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
    for (const x of batch.page) await ctx.db.patch(x._id, { machineId: undefined })
    // Each batch moves what it read out of the list it is reading, so the next starts afresh
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.delivery.orphan, { machineId })
    // What the machine had set aside is addressed to no machine, and is not among the above: it
    // is found by the pages the machine owned, whose waiting clicks are each addressed afresh,
    // which lets go of what a machine that is gone had set aside
    else await ctx.scheduler.runAfter(0, internal.delivery.orphanPages, { machineId })
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
