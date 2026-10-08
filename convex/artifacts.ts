import { LIMITS, QUOTA, WAKES, wakesOn } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { removeLater } from './content'
import { artifactBySlug, ownArtifact, requireBrowser, requireCaller, requireMachine, requireMachineOrOwner, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { bump } from './lib/tally'
import { session } from './schema'

export const prefixOf = (userId: Id<'users'>, artifactId: Id<'artifacts'>, n?: number) => `u/${userId}/${artifactId}/${n === undefined ? '' : `${n}/`}`

const card = (a: Doc<'artifacts'>, pending: number, machineName: string | null) => ({
  id: a._id,
  slug: a.slug,
  title: a.title,
  version: a.currentVersion ?? null,
  updatedAt: a.updatedAt,
  agent: a.agent ?? null,
  machine: machineName,
  session: a.session ?? null,
  pending,
  pinned: a.pinned ?? false,
  folder: a.folder ?? null,
  order: a.order ?? null,
})

async function resolve(ctx: QueryCtx, userId: Id<'users'>, ref: { slug?: string; artifactId?: Id<'artifacts'> }) {
  if (ref.artifactId) return ownArtifact(ctx, userId, ref.artifactId)
  if (ref.slug) return (await artifactBySlug(ctx, userId, ref.slug)) ?? fail('not_found', 'No such page.')
  return fail('invalid', 'Say which page, by slug or id.')
}
export const ref = { slug: v.optional(v.string()), artifactId: v.optional(v.id('artifacts')) }
export { resolve as resolveArtifact }

/** Every page the caller has, newest first, each with how many clicks are waiting. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireCaller(ctx)
    const all = await ctx.db
      .query('artifacts')
      .withIndex('by_user_updated', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(QUOTA.artifacts)
    const names = new Map<string, string | null>()
    for (const a of all) {
      if (a.machineId && !names.has(a.machineId)) names.set(a.machineId, (await ctx.db.get(a.machineId))?.name ?? null)
    }
    return all.filter((a) => a.currentVersion !== undefined).map((a) => card(a, a.waiting ?? 0, a.machineId ? (names.get(a.machineId) ?? null) : null))
  },
})

export const get = query({
  args: ref,
  handler: async (ctx, args) => {
    const { user } = await requireCaller(ctx)
    const a = await resolve(ctx, user._id, args)
    const versions = await ctx.db
      .query('versions')
      .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id))
      .order('desc')
      .take(LIMITS.versionsKept + 2)
    const state = await ctx.db
      .query('states')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .unique()
    const machine = a.machineId ? await ctx.db.get(a.machineId) : null
    return {
      ...card(a, a.waiting ?? 0, machine?.name ?? null),
      // Where the page's conversation is in an agent app It can reopen a closed conversation of:
      // the machine that would do it, and whether the person has switched that on there
      wake:
        machine !== null && !machine.revoked && wakesOn(machine.system) && a.session && (WAKES as readonly string[]).includes(a.session.harness)
          ? { machineId: machine._id, harness: a.session.harness, on: (machine.wakes ?? []).some((w) => w.harness === a.session?.harness) }
          : null,
      // When the page's agent last changed it: published it, or wrote its state. What was done on
      // the page before then has, as far as can be seen from here, been answered there.
      answeredAt: Math.max(a.updatedAt, state?.agentAt ?? 0),
      // Whether the page's conversation is running now because It reopened it, which is what can be stopped from here
      run: running(machine, a),
      // Why it could not be reopened, the last time that was tried and did not work, and when
      wakeFailed: failed(machine, a),
      // And when a person last stopped it, so that the page can say so of what was done before then
      stoppedAt:
        (machine &&
          !machine.revoked &&
          a.session &&
          (machine.stops ?? []).find((s) => s.harness === a.session?.harness && s.sessionId === a.session?.id)?.at) ||
        null,
      // When the machine whose agent made this page was last heard from, for the site to judge
      // whether it is there to hear a click. Null when it has no connector, its connector said
      // it was stopping, or it was revoked.
      machineSeenAt: machine !== null && !machine.revoked && machine.connectorVersion !== undefined && machine.offAt === undefined ? machine.lastSeenAt : null,
      // The machine it was made on is no longer one of the person's. What is done on it reaches
      // its conversation only where that is open on one of their machines.
      machineGone: a.machineId !== undefined && (machine === null || machine.revoked),
      stateRevision: state?.revision ?? 0,
      versions: versions.map((x) => ({ n: x.n, bytes: x.bytes, files: x.files.length, status: x.status, createdAt: x.createdAt })),
    }
  },
})

/** Deletes a page: its record at once, and everything that hung off it, bytes included, soon after. */
export const remove = mutation({
  args: ref,
  handler: async (ctx, args) => {
    const { user } = await requireMachineOrOwner(ctx)
    const a = await resolve(ctx, user._id, args)
    await rateLimit(ctx, 'remove', user._id)
    // Its waiting clicks stop counting against the person the moment it is gone
    if (a.waiting) await bump(ctx, user._id, { waiting: -a.waiting })
    // What was sent to the bell about the page goes from the bell with it. Left there, it
    // offers a button for a page that is gone: the tour's last notice outlived the tour so.
    // The newest few hundred are looked through, which is more than a tray ever holds.
    const told = await ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(300)
    for (const n of told) if (n.artifactId === a._id && !n.dismissedAt) await ctx.db.patch(n._id, { dismissedAt: Date.now() })
    await ctx.db.delete(a._id)
    await ctx.scheduler.runAfter(0, internal.retention.purgeArtifact, { artifactId: a._id })
    // A publish of this page may be under way, with a grant that is still good
    await removeLater(ctx, prefixOf(user._id, a._id), { grantMayBeLive: true })
    return null
  },
})

/**
 * Gives a page to the conversation that is showing it. A conversation that brings a page up for
 * its person is the one they are talking to, also where another conversation made the page
 * the day before: what they then do on it must come to the one in front of them, and not to
 * one that is closed. Asked by the conversation that has it already, nothing changes.
 */
export const take = mutation({
  args: { ...ref, session, agent: v.optional(v.string()) },
  handler: async (ctx, { session: mine, agent, ...which }) => {
    const { user, machine } = await requireMachine(ctx)
    const a = await resolve(ctx, user._id, which)
    if (a.machineId === machine._id && a.session?.harness === mine.harness && a.session?.id === mine.id) return { took: false }
    await rateLimit(ctx, 'take', user._id)
    await ctx.db.patch(a._id, { machineId: machine._id, session: mine, agent: agent?.slice(0, 60) ?? a.agent })
    // Clicks already waiting on the page go where the page went
    await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: a._id })
    return { took: true }
  },
})

/** The reopened run of a page's conversation, where its machine says one is under way. */
function running(machine: Doc<'machines'> | null, a: Doc<'artifacts'>): { since: number; stopping: boolean } | null {
  if (!machine || machine.revoked || !a.session) return null
  const run = (machine.runs ?? []).find((r) => r.harness === a.session?.harness && r.sessionId === a.session?.id)
  return run ? { since: run.since, stopping: run.stop === true } : null
}

/** Why a page's conversation could not be reopened, where its machine last said that it could not. */
function failed(machine: Doc<'machines'> | null, a: Doc<'artifacts'>): { at: number; why: string } | null {
  if (!machine || machine.revoked || !a.session) return null
  const f = (machine.fails ?? []).find((x) => x.harness === a.session?.harness && x.sessionId === a.session?.id)
  return f ? { at: f.at, why: f.why } : null
}

/** How many stopped conversations a machine remembers: the last few, which is as many as anyone stops in a day. */
const STOPS_KEPT = 40

/**
 * Stops the agent that It reopened for a page: the machine running it is told, and ends it.
 * What was waiting for that conversation by now is not reopened for either, so that stopping
 * stops, and the next thing done on the page reopens it as before. Any browser that can use the
 * page can stop it, since stopping asks less of an agent than a click does. A machine cannot,
 * so no agent stops another.
 */
export const stop = mutation({
  args: { artifactId: v.id('artifacts') },
  handler: async (ctx, { artifactId }) => {
    const { user } = await requireBrowser(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    const machine = a.machineId ? await ctx.db.get(a.machineId) : null
    if (!machine || !running(machine, a)) return { stopping: false }
    const is = (r: { harness: string; sessionId: string }) => r.harness === a.session?.harness && r.sessionId === a.session?.id
    await ctx.db.patch(machine._id, {
      runs: (machine.runs ?? []).map((r) => (is(r) ? { ...r, stop: true } : r)),
      stops: [...(machine.stops ?? []).filter((r) => !is(r)), { harness: a.session!.harness, sessionId: a.session!.id, at: Date.now() }].slice(-STOPS_KEPT),
    })
    // What was still waiting for that conversation goes with the stop: the person stopped the
    // agent, and did not mean it to take up, an hour later, what they had done before that.
    // Left waiting, each such thing was counted on the page for a month with no way to clear
    // it, and was handed over all the same the next time its conversation was opened.
    // Whether nobody has them yet or the machine has them in hand: while a conversation runs
    // because It reopened it, everything of its that a machine holds is held for that very
    // run, as what it was started with or as what its add-on is about to be given. Both are
    // what the person is stopping. Left out, what the add-on held came back with the next click.
    // A page may have hundreds waiting, and one step drops so many: the rest follow in steps of
    // their own, up to the moment of the stop and no later, so that what the person does on the
    // page after stopping is kept.
    const at = Date.now()
    const dropped = await dropWaiting(ctx, user._id, machine._id, a.session!, at)
    if (dropped.more) await ctx.scheduler.runAfter(0, internal.artifacts.dropRest, { userId: user._id, machineId: machine._id, session: a.session!, at })
    const waiting = { length: dropped.count }
    log('run.stop_asked', { userId: user._id, artifactId, dropped: waiting.length })
    return { stopping: true }
  },
})

/** How many waiting clicks one step drops, of each of the two ways a click can be waiting. */
const DROP_AT_ONCE = 100

/**
 * Drops what is waiting for a conversation that the person stopped, as far as one step goes:
 * the clicks made up to the stop, whether nobody has them yet or a machine has them in hand.
 * Says how many it dropped, and whether there may be more.
 *
 * Only what is addressed to the machine the conversation was stopped on, or was set aside by
 * it: a conversation of the same name on another of the person's machines is another
 * conversation, which nobody stopped.
 */
async function dropWaiting(
  ctx: MutationCtx,
  userId: Id<'users'>,
  machineId: Id<'machines'>,
  of: { harness: string; id: string },
  at: number,
): Promise<{ count: number; more: boolean }> {
  let count = 0
  let more = false
  for (const delivery of ['pending', 'leased'] as const)
    for (const [addressed, aside] of [
      [machineId, undefined],
      [undefined, machineId],
    ] as const) {
      const batch = await ctx.db
        .query('actions')
        .withIndex('by_user_route', (q) =>
          q
            .eq('userId', userId)
            .eq('delivery', delivery)
            .eq('harness', of.harness)
            .eq('sessionId', of.id)
            .eq('machineId', addressed)
            .eq('parkedBy', aside)
            // Made after the stop: the person did that knowing the agent was stopped, and it is kept
            .lte('createdAt', at),
        )
        .take(DROP_AT_ONCE)
      if (batch.length === DROP_AT_ONCE) more = true
      for (const x of batch) {
        await ctx.db.patch(x._id, {
          delivery: 'handed_off',
          route: 'stopped',
          handedAt: Date.now(),
          outcome: 'failed',
          leaseMachineId: undefined,
          leaseExpiresAt: undefined,
        })
        count++
        // It stops counting as waiting, on its page and for the person, as any click does that is no longer waiting
        const page = await ctx.db.get(x.artifactId)
        if (page) await ctx.db.patch(page._id, { waiting: Math.max(0, (page.waiting ?? 0) - 1) })
      }
    }
  if (count) await bump(ctx, userId, { waiting: -count })
  return { count, more: more && count > 0 }
}

/** The rest of what a stop drops, a step at a time, until none that was waiting at the stop is left. */
export const dropRest = internalMutation({
  args: { userId: v.id('users'), machineId: v.id('machines'), session, at: v.number() },
  handler: async (ctx, { userId, machineId, session: of, at }) => {
    const dropped = await dropWaiting(ctx, userId, machineId, of, at)
    if (dropped.more) await ctx.scheduler.runAfter(0, internal.artifacts.dropRest, { userId, machineId, session: of, at })
    return null
  },
})

/** Pinning, folders and order: how the person arranges their pages. */
export const organize = mutation({
  args: { artifactId: v.id('artifacts'), pinned: v.optional(v.boolean()), folder: v.optional(v.union(v.string(), v.null())), order: v.optional(v.number()) },
  handler: async (ctx, { artifactId, pinned, folder, order }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    if (typeof folder === 'string' && folder.length > 60) fail('invalid', 'A folder name is at most 60 characters.')
    await ctx.db.patch(a._id, {
      ...(pinned === undefined ? {} : { pinned }),
      ...(folder === undefined ? {} : { folder: folder === null ? undefined : folder }),
      ...(order === undefined ? {} : { order }),
    })
    return null
  },
})

/** Goes back to an earlier version whose bytes are still kept. */
export const rollback = mutation({
  args: { slug: v.string(), version: v.number() },
  handler: async (ctx, { slug, version }) => {
    const { user } = await requireMachineOrOwner(ctx)
    const a = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    const target = await ctx.db
      .query('versions')
      .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', version))
      .unique()
    if (!target || target.status === 'staging') fail('not_found', 'That version is not kept.')
    if (a.currentVersion !== undefined && a.currentVersion !== version) {
      const live = await ctx.db
        .query('versions')
        .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', a.currentVersion!))
        .unique()
      if (live) await ctx.db.patch(live._id, { status: 'retired' })
    }
    await ctx.db.patch(target._id, { status: 'live' })
    // The page takes the title that version was published with
    await ctx.db.patch(a._id, { currentVersion: version, updatedAt: Date.now(), title: target.title ?? a.title })
    return { version }
  },
})
