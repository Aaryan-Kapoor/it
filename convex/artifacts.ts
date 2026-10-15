import { LIMITS, newer, QUOTA, WAKES, wakesOn } from '@it/protocol'
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

/**
 * A page, as the site shows it and as `it read` prints it. A screen that shows the page asks
 * this again after every change to it, to its state and to its machine's record, and a machine
 * says it is alive every half minute: so no more is read here than is told. With `history`
 * false the versions are not read at all, each of which holds the list of its files, and how
 * the state stands is read from the small record of its revision, never from the state.
 */
export const get = query({
  args: { ...ref, history: v.optional(v.boolean()) },
  handler: async (ctx, { history, ...args }) => {
    const { user } = await requireCaller(ctx)
    const a = await resolve(ctx, user._id, args)
    // The versions that can be gone back to are read by themselves: the one that is shown and
    // the ones kept from before it, which are never more than may be kept. Read together with
    // the publishes that were begun and not finished, a few of those hid them, and a dozen hid
    // every one. Of the unfinished, the newest two are listed with them.
    const ofStatus = (status: Doc<'versions'>['status'], most: number) =>
      ctx.db
        .query('versions')
        .withIndex('by_artifact_status', (q) => q.eq('artifactId', a._id).eq('status', status))
        .order('desc')
        .take(most)
    const versions =
      history === false
        ? []
        : [...(await ofStatus('live', 1)), ...(await ofStatus('retired', LIMITS.versionsKept)), ...(await ofStatus('staging', 2))].sort((x, y) => y.n - x.n)
    const noted = await ctx.db
      .query('revisions')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .unique()
    // A record of the revision from before it kept when the agent last wrote, or none at all,
    // says nothing of that: the state is read for it then, until it is next written
    const state =
      noted?.agentAt !== undefined
        ? { revision: noted.revision, agentAt: noted.agentAt }
        : await ctx.db
            .query('states')
            .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
            .unique()
    const machine = a.machineId ? await ctx.db.get(a.machineId) : null
    return {
      ...card(a, a.waiting ?? 0, machine?.name ?? null),
      // Only this page's app readiness is shared with its readers, including paired screens.
      connection: connection(machine, a),
      // Where the page's conversation is in an agent app It can reopen a closed conversation of:
      // the machine that would do it, and whether the person has switched that on there
      wake:
        machine !== null && !machine.revoked && wakesOn(machine.system) && a.session && (WAKES as readonly string[]).includes(a.session.harness)
          ? { machineId: machine._id, harness: a.session.harness, on: (machine.wakes ?? []).some((w) => w.harness === a.session?.harness) }
          : null,
      // When the page's agent last changed it: published it, or wrote its state. What was done on
      // the page before then has, as far as can be seen from here, been answered there.
      answeredAt: Math.max(a.updatedAt, state?.agentAt ?? 0, a.said?.at ?? 0),
      // What its agent last said above the page, for an answer that has no place on the page itself
      said: a.said ?? null,
      // Whether the page's conversation is running now because It reopened it, which is what can be stopped from here
      run: running(machine, a),
      // Why it could not be reopened, the last time that was tried and did not work, and when
      wakeFailed: failed(machine, a),
      // And when a person last stopped it, so that the page can say so of what was done before
      // then. The page keeps that moment itself, and goes on saying it when it has changed
      // conversation or machine since: what was dropped by the stop was stopped, and did not fail.
      stoppedAt:
        Math.max(
          a.stoppedThrough ?? 0,
          (machine &&
            !machine.revoked &&
            a.session &&
            (machine.stops ?? []).find((s) => s.harness === a.session?.harness && s.sessionId === a.session?.id)?.at) ||
            0,
        ) || null,
      // When the machine whose agent made this page was last heard from, for the site to judge
      // whether it is there to hear a click. Null when it has no connector, its connector said
      // it was stopping, or it was revoked.
      machineSeenAt: machine !== null && !machine.revoked && machine.connectorVersion !== undefined && machine.offAt === undefined ? machine.lastSeenAt : null,
      // Its machine is there and hands nothing to an agent for now, and why: what is done on the
      // page waits for that to change, and neither opening the conversation nor reopening it helps
      machinePaused: machine !== null && !machine.revoked ? (machine.paused ?? null) : null,
      // The machine it was made on is no longer one of the person's. What is done on it reaches
      // its conversation only where that is open on one of their machines.
      machineGone: a.machineId !== undefined && (machine === null || machine.revoked),
      stateRevision: state?.revision ?? 0,
      versions: versions.map((x) => ({ n: x.n, bytes: x.bytes, files: x.files.length, status: x.status, createdAt: x.createdAt })),
    }
  },
})

/**
 * An agent says something above a page, in a line of its own words: an answer that has no
 * place on the page itself, shown where the person is looking. Each one takes the place of the
 * one before, and saying nothing takes it away.
 */
export const say = mutation({
  args: { slug: v.string(), text: v.string() },
  handler: async (ctx, { slug, text }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolve(ctx, user._id, { slug })
    const said = text.trim()
    if (said.length > LIMITS.saidText)
      fail('limit', `What is said above a page is at most ${LIMITS.saidText} characters. Put anything longer on the page itself.`)
    await ctx.db.patch(a._id, { said: said ? { text: said, at: Date.now() } : undefined })
    return { said: said !== '' }
  },
})

/** Requests deletion and returns its receipt. Completion waits for the records and files to be removed. */
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
    // The rest go in the bounded cleanup of this page, however old they are.
    const told = await ctx.db
      .query('notifications')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .order('desc')
      .take(300)
    for (const n of told) if (n.artifactId === a._id && !n.dismissedAt) await ctx.db.patch(n._id, { dismissedAt: Date.now() })
    const job = await ctx.db.insert('deletions', { userId: user._id, artifactId: a._id, slug: a.slug, title: a.title, requestedAt: Date.now(), attempts: 0 })
    await ctx.db.delete(a._id)
    await ctx.scheduler.runAfter(0, internal.retention.purgeArtifact, { artifactId: a._id, deletionId: job })
    // A publish of this page may be under way, with a grant that is still good
    await removeLater(ctx, prefixOf(user._id, a._id), { grantMayBeLive: true, deletionId: job })
    return { job }
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
    // A conversation is named here in as many characters as publishing takes one in. A longer
    // name is kept whole on the page and cut short where the machine says the conversation is
    // running, so the page would never be seen to run and could not be stopped; and it is read
    // with every page of the person's, each time they are listed.
    if (mine.harness.length > 40 || mine.id.length > 200) fail('invalid', 'That is not a session.')
    const a = await resolve(ctx, user._id, which)
    if (a.machineId === machine._id && a.session?.harness === mine.harness && a.session?.id === mine.id) return { took: false }
    await rateLimit(ctx, 'take', user._id)
    await ctx.db.patch(a._id, { machineId: machine._id, session: mine, agent: agent?.slice(0, 60) ?? a.agent })
    // Clicks already waiting on the page go where the page went
    await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: a._id })
    return { took: true }
  },
})

type Connection = {
  harness: string
  state: 'disconnected' | 'connecting' | 'needs_approval' | 'error' | 'unavailable' | 'too_old' | 'connected' | 'unknown'
  queue: boolean
}

/** The owning app's reported capability, without claiming that this conversation is open. */
function connection(machine: Doc<'machines'> | null, a: Doc<'artifacts'>): Connection | null {
  if (!machine || machine.revoked || !a.session) return null
  const harness = a.session.harness
  if (!(machine.wanted ?? []).includes(harness)) return { harness, state: 'disconnected', queue: false }
  const report = machine.harnesses?.find((h) => h.id === harness)
  let state: Connection['state'] = 'unknown'
  switch (report?.addon) {
    case 'not_connected':
      state = 'connecting'
      break
    case 'needs_approval':
    case 'error':
    case 'unavailable':
    case 'too_old':
    case 'connected':
      state = report.addon
  }
  // This minimum matches Codex's supported version in setup. An unreadable version proves nothing.
  const queue =
    harness === 'codex' &&
    (state === 'connected' || state === 'needs_approval') &&
    /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(report?.version ?? '') &&
    !newer('0.160.0', report?.version)
  return { harness, state, queue }
}

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
    // A conversation may have made several pages, and it is the conversation that is stopped:
    // what waits on any of them goes. Each page keeps the moment for good: what was done on it
    // up to now is delivered to nobody, also where the page changes hands before the steps
    // below have come to all of it.
    const pages = (
      await ctx.db
        .query('artifacts')
        .withIndex('by_machine', (q) => q.eq('machineId', machine._id))
        .collect()
    ).filter((p) => p._id !== a._id && p.session !== undefined && is({ harness: p.session.harness, sessionId: p.session.id }))
    for (const p of [a, ...pages]) await ctx.db.patch(p._id, { stoppedThrough: at })
    const dropped = await dropWaiting(ctx, user._id, machine._id, a.session!, at, a._id)
    if (dropped.more)
      await ctx.scheduler.runAfter(0, internal.artifacts.dropRest, { userId: user._id, machineId: machine._id, session: a.session!, at, artifactId: a._id })
    // And what waits on each of its other pages, read by the page in a step of its own: a click
    // there may be addressed to nobody for the moment, and is then found no other way
    for (const p of pages)
      if ((p.waiting ?? 0) > 0)
        await ctx.scheduler.runAfter(0, internal.artifacts.dropRest, { userId: user._id, machineId: machine._id, session: a.session!, at, artifactId: p._id })
    const waiting = { length: dropped.count }
    log('run.stop_asked', { userId: user._id, artifactId, dropped: waiting.length })
    return { stopping: true }
  },
})

/**
 * How many waiting clicks one step drops, of every way a click can be waiting taken together.
 * A click carries up to 32 KB, and the backend counts it once when it is read and once more
 * when it is changed, against the 16 MB it lets one step read: a hundred of the largest are
 * well within that. A hundred of each way, which is what a step once took, came to six hundred,
 * and the backend refused the step whole, the word to the machine to stop with it.
 */
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
  /** The page the stop was asked from: everything that waits on it from before the stop goes, however it is addressed. */
  artifactId?: Id<'artifacts'>,
): Promise<{ count: number; more: boolean }> {
  let count = 0
  // How many of them still counted as waiting for the person: all but those of a page that has
  // been deleted meanwhile, which gave back everything that was waiting on it when it went
  let tallied = 0
  let more = false
  for (const delivery of ['pending', 'leased'] as const)
    for (const [addressed, aside] of [
      [machineId, undefined],
      [undefined, machineId],
    ] as const) {
      // What this step may take has been taken: whatever waits in the ways not yet looked at is the next step's
      const room = DROP_AT_ONCE - count
      if (room <= 0) {
        more = true
        break
      }
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
        .take(room)
      if (batch.length === room) more = true
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
        if (page) {
          await ctx.db.patch(page._id, { waiting: Math.max(0, (page.waiting ?? 0) - 1) })
          tallied++
        }
      }
    }
  // And whatever else waits on the page the stop was asked from, from before the stop: a click
  // that is addressed to nobody for the moment, as one is while its page changes hands, or
  // that has been addressed afresh since. Read by the page, so that nothing of another page
  // stands in front of it.
  if (artifactId)
    for (const delivery of ['pending', 'leased'] as const) {
      const room = DROP_AT_ONCE - count
      if (room <= 0) {
        more = true
        break
      }
      const batch = await ctx.db
        .query('actions')
        .withIndex('by_artifact_delivery', (q) => q.eq('artifactId', artifactId).eq('delivery', delivery).lte('createdAt', at))
        .take(room)
      if (batch.length === room) more = true
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
        const page = await ctx.db.get(x.artifactId)
        if (page) {
          await ctx.db.patch(page._id, { waiting: Math.max(0, (page.waiting ?? 0) - 1) })
          tallied++
        }
      }
    }
  if (tallied) await bump(ctx, userId, { waiting: -tallied })
  return { count, more: more && count > 0 }
}

/** The rest of what a stop drops, a step at a time, until none that was waiting at the stop is left. */
export const dropRest = internalMutation({
  args: { userId: v.id('users'), machineId: v.id('machines'), session, at: v.number(), artifactId: v.optional(v.id('artifacts')) },
  handler: async (ctx, { userId, machineId, session: of, at, artifactId }) => {
    const dropped = await dropWaiting(ctx, userId, machineId, of, at, artifactId)
    if (dropped.more) await ctx.scheduler.runAfter(0, internal.artifacts.dropRest, { userId, machineId, session: of, at, artifactId })
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
