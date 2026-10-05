// Taking away a copy of the records It holds, and erasing everything It holds. Both are the
// owner's browser's to do, and no screen's.
//
// An export is read a piece at a time (the person's lists, then each page, then each page's
// history a batch at a time) and put together in the browser, so that no single read has to hold
// everything at once.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { mutation, query } from './_generated/server'
import { revokeLater } from './content'
import { ownArtifact, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { endSession, pairedOf } from './sessions'

/** Starts an export: counts it against the limit, and answers with what there is to fetch. */
export const exportStart = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireOwner(ctx)
    await rateLimit(ctx, 'export', user._id)
    const artifacts = await ctx.db
      .query('artifacts')
      .withIndex('by_user_slug', (q) => q.eq('userId', user._id))
      .take(600)
    const displays = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(100)
    log('account.export', { userId: user._id, pages: artifacts.length })
    return {
      exportedAt: Date.now(),
      /** Whose export this is. The pieces that belong to no one page are asked for by this, so that an export never mixes two people's. */
      owner: user._id,
      pages: artifacts.map((a) => a._id),
      displays: displays.map((d) => ({ name: d.name ?? d.generatedName, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt })),
    }
  },
})

/** The person's machines, revoked ones included for as long as they are kept, a batch at a time. */
export const exportMachines = query({
  args: { owner: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { owner, cursor }) => {
    const { user } = await requireOwner(ctx)
    // The browser has been paired for someone else since the export began
    if (user._id !== owner) fail('not_found', 'That export cannot be carried on from here. Start it again.')
    const batch = await ctx.db
      .query('machines')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .paginate({ cursor, numItems: 200 })
    return {
      machines: batch.page.map((m) => ({ name: m.name, createdAt: m.createdAt, revoked: m.revoked })),
      next: batch.isDone ? null : batch.continueCursor,
    }
  },
})

/** One page of an export: what it is, its state, and its versions with their file lists. */
export const exportPage = query({
  args: { artifactId: v.id('artifacts') },
  handler: async (ctx, { artifactId }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    const state = await ctx.db
      .query('states')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .unique()
    // Every version that was published and is still kept: there are never more than a handful.
    // Attempts that were never finished are not part of the page and are left out.
    const versions = []
    for (const status of ['live', 'retired'] as const) {
      versions.push(
        ...(await ctx.db
          .query('versions')
          .withIndex('by_artifact_status', (q) => q.eq('artifactId', a._id).eq('status', status))
          .take(40)),
      )
    }
    versions.sort((x, y) => y.n - x.n)
    return {
      slug: a.slug,
      title: a.title,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      currentVersion: a.currentVersion ?? null,
      agent: a.agent ?? null,
      /** JSON text. */
      state: state?.json ?? '{}',
      versions: versions.map((x) => ({ n: x.n, status: x.status, bytes: x.bytes, files: x.files })),
    }
  },
})

/** What was done on one page, oldest first, a batch at a time. `next` is where to carry on from, or null at the end. */
export const exportActions = query({
  args: { artifactId: v.id('artifacts'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { artifactId, cursor }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    // The database's own paging, which never skips a record, however many share a moment
    const batch = await ctx.db
      .query('actions')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .paginate({ cursor, numItems: 100 })
    return {
      actions: batch.page.map((x) => ({ name: x.name, payload: x.payload, at: x.createdAt, delivery: x.delivery, outcome: x.outcome ?? null })),
      next: batch.isDone ? null : batch.continueCursor,
    }
  },
})

/** The person's notifications, oldest first, a batch at a time. */
export const exportNotifications = query({
  args: { owner: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { owner, cursor }) => {
    const { user } = await requireOwner(ctx)
    if (user._id !== owner) fail('not_found', 'That export cannot be carried on from here. Start it again.')
    const batch = await ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .paginate({ cursor, numItems: 200 })
    return {
      notifications: batch.page.map((n) => ({ text: n.text, at: n.createdAt, answer: n.answer ?? null })),
      next: batch.isDone ? null : batch.continueCursor,
    }
  },
})

/** Erases everything It holds for the person. Access ends at once; the records and files are removed in the background. */
export const requestDeletion = mutation({
  // `user` is who confirmed the erasing, as the site knew them at that moment: the id it was
  // given with its token. A request that arrives after the browser has been paired for someone
  // else erases nothing.
  args: { confirm: v.literal('erase everything'), user: v.string() },
  handler: async (ctx, { user: confirmedBy }) => {
    const { user } = await requireOwner(ctx)
    if (user._id !== confirmedBy) {
      log('account.deletion_refused', { userId: user._id, reason: 'paired_for_another_person' }, 'warn')
      fail('conflict', 'This browser has been paired again since you confirmed. Nothing was erased.')
    }
    await ctx.db.patch(user._id, { deletedAt: Date.now() })
    // Every paired browser is unpaired at this moment, and not when the erasing gets to it
    for (const s of await pairedOf(ctx, user._id)) await endSession(ctx, s._id, 'erased')
    const machines = await ctx.db
      .query('machines')
      .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
      .take(100)
    for (const m of machines) await ctx.db.patch(m._id, { revoked: true, revokedAt: Date.now() })
    const displays = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(100)
    // Far above anything a display has reached, so every session it ever had is over. And
    // nothing more is pushed to any of them, from this moment.
    for (const d of displays) {
      await revokeLater(ctx, { userId: user._id, displayId: d._id, epoch: d.epoch + 1_000_000 })
      if (d.push) await ctx.db.patch(d._id, { push: undefined })
    }
    await ctx.scheduler.runAfter(0, internal.retention.purgeErased, {})
    log('account.deletion_requested', { userId: user._id, machines: machines.length, displays: displays.length })
    return null
  },
})
