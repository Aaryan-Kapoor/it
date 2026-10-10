// Cleaning up: what a deleted page leaves behind, what there is to remove when everything is
// erased, and what is simply too old to keep.
// Every step removes a small batch and asks to be run again while a batch came back full, so
// no run reads more than it should and nothing is left behind because there was a lot of it.
import { RETENTION } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { noLongerWaiting } from './actions'
import { prefixOf } from './artifacts'
import { removeLater } from './content'
import { forgetCounts } from './lib/limits'
import { log } from './lib/log'
import { dropStaging, STAGING_MS } from './publish'
import { endSession, pairedOf, UNUSED_MS } from './sessions'

/** Rows that can each hold a lot (a click's data) are taken fewer at a time, and a version's record, which lists every file, fewer still. */
const HEAVY = 50
const VERSIONS = 10
const LIGHT = 200
const DAY = 86_400_000

/**
 * Removes one batch of what hung off a page. True when there may be more. With the last batch
 * goes what was counted under the page's id to hold it to a pace: every way a page is removed
 * comes through here, and a count left behind would name a page that is not there.
 */
async function removeHangers(ctx: MutationCtx, artifactId: Id<'artifacts'>): Promise<boolean> {
  const state = await ctx.db
    .query('states')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .take(2)
  for (const s of state) await ctx.db.delete(s._id)
  const revisions = await ctx.db
    .query('revisions')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .take(2)
  for (const r of revisions) await ctx.db.delete(r._id)
  const starts = await ctx.db
    .query('starts')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .take(VERSIONS)
  for (const st of starts) await ctx.db.delete(st._id)
  const versions = await ctx.db
    .query('versions')
    .withIndex('by_artifact_n', (q) => q.eq('artifactId', artifactId))
    .take(VERSIONS)
  for (const ver of versions) {
    // An unfinished publish also gives back its share of the quota
    // The page's own record is its caller's to remove
    if (ver.status === 'staging') await dropStaging(ctx, ver, { keepPage: true })
    else await ctx.db.delete(ver._id)
  }
  const actions = await ctx.db
    .query('actions')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .take(HEAVY)
  for (const x of actions) await ctx.db.delete(x._id)
  const more = versions.length === VERSIONS || actions.length === HEAVY
  if (!more) await forgetCounts(ctx, artifactId)
  return more
}

/** After a page is deleted: its state, versions and clicks. Its bytes are removed by the content service. */
export const purgeArtifact = internalMutation({
  args: { artifactId: v.id('artifacts') },
  handler: async (ctx, { artifactId }) => {
    if (await removeHangers(ctx, artifactId)) await ctx.scheduler.runAfter(0, internal.retention.purgeArtifact, { artifactId })
    return null
  },
})

/**
 * When everything is erased: one batch of the records that are the person's, and once there
 * are none, their files. The person's own record is the last thing to go, once the content
 * service has confirmed the files are gone, so there is always something left to finish the
 * job from. True while there is another batch to remove.
 */
async function purge(ctx: MutationCtx, userId: Id<'users'>): Promise<boolean> {
  // One page at a time: a page can bring a lot with it, and each run must stay small
  const artifact = await ctx.db
    .query('artifacts')
    .withIndex('by_user_slug', (q) => q.eq('userId', userId))
    .first()
  if (artifact) {
    if (!(await removeHangers(ctx, artifact._id))) await ctx.db.delete(artifact._id)
    return true
  }
  // Every session is ended as any session is, before its record and its displays' records go
  const paired = await pairedOf(ctx, userId)
  for (const s of paired) await endSession(ctx, s._id, 'erased')
  if (paired.length) return true
  // With each record goes what was kept under its id to hold it to a pace, and, for a machine,
  // the proofs it has used: none of it is left for the hourly cleaning to come to. A showing's
  // record is among what goes here, though its display and its page are gone already.
  for (const table of ['displays', 'machines', 'sessions', 'invites', 'mounts'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_user', (q: any) => q.eq('userId', userId))
      .take(LIGHT)
    for (const r of rows) {
      if (table === 'machines' || table === 'sessions') await forgetCounts(ctx, r._id)
      if (table === 'machines') {
        const proofs = await ctx.db
          .query('spentProofs')
          // Each is kept under the machine's id, a colon, and the proof's own number
          .withIndex('by_key', (q) => q.gte('key', `${r._id}:`).lt('key', `${r._id};`))
          .take(LIGHT)
        for (const proof of proofs) await ctx.db.delete(proof._id)
        // A machine's proofs are found by its id, so its record stays until the last of them has gone
        if (proofs.length === LIGHT) return true
      }
      await ctx.db.delete(r._id)
    }
    if (rows.length === LIGHT) return true
  }
  const notifications = await ctx.db
    .query('notifications')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(LIGHT)
  for (const n of notifications) await ctx.db.delete(n._id)
  if (notifications.length === LIGHT) return true
  for (const table of ['projects', 'forgotten'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_user_key', (q: any) => q.eq('userId', userId))
      .take(LIGHT)
    for (const r of rows) await ctx.db.delete(r._id)
    if (rows.length === LIGHT) return true
  }
  const tallies = await ctx.db
    .query('tallies')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(5)
  for (const t of tallies) await ctx.db.delete(t._id)
  await forgetCounts(ctx, userId)
  // Only one such job at a time, however often this is run. It is not asked a second time
  // later, as the deleting of one page is: nothing may name the person once their own record
  // has gone, and the content service takes no file for a version by itself once it has
  // removed what was declared for that version, whatever grant to upload is still good.
  const queued = await ctx.db
    .query('contentJobs')
    .withIndex('by_user_to_delete', (q) => q.eq('thenDeleteUser', userId))
    .first()
  if ((await ctx.db.get(userId)) && !queued) {
    await removeLater(ctx, `u/${userId}/`, { thenDeleteUser: userId })
    log('account.records_removed', { userId })
  }
  return false
}

/**
 * Carries on the erasing of everyone who is being erased: a batch for one of them in each
 * run, each in their turn, and round again for as long as any of them had more to remove. One
 * whose records are gone, and whose own record waits for the content service, is passed by.
 *
 * It is told nobody's id. The backend program keeps what a job was started with for days
 * after the job has run, and whoever is erased is not to be named there. So the place in the
 * list is said by when the last one's erasing was asked for and when their record was made.
 */
export const purgeErased = internalMutation({
  args: {
    /** Whose turn it was last, by those two times: this run is for whoever comes after them. */
    after: v.optional(v.object({ asked: v.number(), made: v.number() })),
    /** Whether anyone before that had more to remove. */
    more: v.optional(v.boolean()),
  },
  handler: async (ctx, { after, more }) => {
    const erasing = () => ctx.db.query('users').withIndex('by_deleted', (q) => q.gt('deletedAt', after?.asked ?? 0))
    const sameMoment = after
      ? await ctx.db
          .query('users')
          .withIndex('by_deleted', (q) => q.eq('deletedAt', after.asked).gt('_creationTime', after.made))
          .first()
      : null
    const next = sameMoment ?? (await erasing().first())
    // The end of the list: from its start again, if anyone on it had more to remove
    if (!next) {
      if (more) await ctx.scheduler.runAfter(0, internal.retention.purgeErased, {})
      return null
    }
    const again = (await purge(ctx, next._id)) || (more ?? false)
    await ctx.scheduler.runAfter(0, internal.retention.purgeErased, { after: { asked: next.deletedAt ?? 0, made: next._creationTime }, more: again })
    return null
  },
})

/** Publishes that were begun and never finished. */
export const sweepStaging = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query('versions')
      .withIndex('by_status_created', (q) => q.eq('status', 'staging').lt('createdAt', Date.now() - STAGING_MS))
      .take(VERSIONS)
    for (const s of old) {
      await dropStaging(ctx, s)
      await removeLater(ctx, prefixOf(s.userId, s.artifactId, s.n))
    }
    if (old.length === VERSIONS) await ctx.scheduler.runAfter(0, internal.retention.sweepStaging, {})
    if (old.length) log('sweep.staging', { removed: old.length })
    return old.length
  },
})

/** Clicks that are too old to keep: handled ones after a week, ones nobody took after a month. */
export const sweepActions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const handled = await ctx.db
      .query('actions')
      // Counted from when it was handed over, so that one which waited a long time is still
      // there to be read (`it action <id>`) for a week after its agent got it
      .withIndex('by_delivery_handed', (q) => q.eq('delivery', 'handed_off').lt('handedAt', now - RETENTION.handledActionDays * DAY))
      .take(HEAVY)
    for (const x of handled) await ctx.db.delete(x._id)
    const unclaimed = await ctx.db
      .query('actions')
      .withIndex('by_delivery_created', (q) => q.eq('delivery', 'pending').lt('createdAt', now - RETENTION.pendingActionDays * DAY))
      .take(HEAVY)
    for (const x of unclaimed) {
      await noLongerWaiting(ctx, x)
      await ctx.db.delete(x._id)
    }
    if (handled.length === HEAVY || unclaimed.length === HEAVY) await ctx.scheduler.runAfter(0, internal.retention.sweepActions, {})
    if (handled.length || unclaimed.length) log('sweep.actions', { handled: handled.length, neverTaken: unclaimed.length })
    return handled.length + unclaimed.length
  },
})

/** Bookkeeping that has expired: mounts, spent proofs, old notifications, idle rate-limit buckets, forgotten keys, codes, sessions that ended or went unused, revoked machines. */
export const sweepRecords = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    let full = false
    let removed = 0
    const drop = async (rows: { _id: Id<any> }[]) => {
      for (const r of rows) await ctx.db.delete(r._id)
      if (rows.length === LIGHT) full = true
      removed += rows.length
    }
    await drop(
      await ctx.db
        .query('mounts')
        .withIndex('by_created', (q) => q.lt('createdAt', now - RETENTION.mountHours * 3_600_000))
        .take(LIGHT),
    )
    await drop(
      await ctx.db
        .query('spentProofs')
        .withIndex('by_expiry', (q) => q.lt('expiresAt', now))
        .take(LIGHT),
    )
    await drop(
      await ctx.db
        .query('notifications')
        .withIndex('by_created', (q) => q.lt('createdAt', now - RETENTION.notificationDays * DAY))
        .take(LIGHT),
    )
    await drop(
      await ctx.db
        .query('rateLimits')
        .withIndex('by_updated', (q) => q.lt('updatedAt', now - 3_600_000))
        .take(LIGHT),
    )
    await drop(
      await ctx.db
        .query('forgotten')
        .withIndex('by_at', (q) => q.lt('at', now - 90 * DAY))
        .take(LIGHT),
    )
    // A code is good for ten minutes, and its record goes at the next cleaning after that
    await drop(
      await ctx.db
        .query('invites')
        .withIndex('by_expiry', (q) => q.lt('expiresAt', now))
        .take(LIGHT),
    )
    // A session that ended is kept a day. One that nothing has asked with for as long as a
    // session lasts is nobody's, and is ended as any session is, so that its displays are
    // signed out with it, and its record goes at once. A browser that presents such a session
    // before this has come to it is refused all the same (sessions.ts).
    await drop(
      await ctx.db
        .query('sessions')
        .withIndex('by_ended', (q) => q.gt('endedAt', 0).lt('endedAt', now - DAY))
        .take(LIGHT),
    )
    const unused = await ctx.db
      .query('sessions')
      .withIndex('by_seen', (q) => q.lt('lastSeenAt', now - UNUSED_MS))
      .take(HEAVY)
    for (const s of unused) await endSession(ctx, s._id, 'unused')
    await drop(unused)
    if (unused.length === HEAVY) full = true
    // A revoked machine's record is kept a month, so pages it made still show its name. It is
    // kept longer while a page still names it: the same computer enrolling again is given
    // those pages by naming this record, and with the record gone they would stay with nobody.
    // One that is kept is looked at again in a month, so that it stands in no other's way.
    const revoked = await ctx.db
      .query('machines')
      .withIndex('by_revoked', (q) => q.eq('revoked', true).lt('revokedAt', now - 30 * DAY))
      .take(LIGHT)
    const unnamed: typeof revoked = []
    for (const m of revoked) {
      const named = await ctx.db
        .query('artifacts')
        .withIndex('by_machine', (q) => q.eq('machineId', m._id))
        .first()
      if (named) await ctx.db.patch(m._id, { revokedAt: now })
      else unnamed.push(m)
    }
    await drop(unnamed)
    if (full) await ctx.scheduler.runAfter(0, internal.retention.sweepRecords, {})
    if (removed) log('sweep.records', { removed })
    return null
  },
})

/** Hourly: an erasing that stopped part of the way (a run failed, say) is started again. Says how many there were, of the first twenty. */
export const resumeDeletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query('users')
      .withIndex('by_deleted', (q) => q.gt('deletedAt', 0).lt('deletedAt', Date.now() - 3_600_000))
      .take(20)
    // Every person whose erasing stopped gets a turn, however many there are: the one job goes through all of them
    if (stuck.length) await ctx.scheduler.runAfter(0, internal.retention.purgeErased, {})
    // Records that have been "being erased" for over an hour: the erasing is failing somewhere
    if (stuck.length) log('account.deletion_resumed', { count: stuck.length, first: stuck[0]?._id }, 'warn')
    return stuck.length
  },
})

/** Hourly. Each kind of cleaning runs by itself, so trouble with one does not stop the others. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.retention.sweepStaging, {})
    await ctx.scheduler.runAfter(0, internal.retention.sweepActions, {})
    await ctx.scheduler.runAfter(0, internal.retention.sweepRecords, {})
    await ctx.scheduler.runAfter(0, internal.retention.resumeDeletions, {})
    await ctx.scheduler.runAfter(0, internal.counted.sweep, {})
    return null
  },
})
