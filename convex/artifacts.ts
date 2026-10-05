import { LIMITS, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { mutation, type QueryCtx, query } from './_generated/server'
import { removeLater } from './content'
import { artifactBySlug, ownArtifact, requireCaller, requireMachineOrOwner, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { bump } from './lib/tally'

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
      // When the machine whose agent made this page was last heard from, for the site to judge
      // whether it is there to hear a click. Null when it has no connector, or was revoked.
      machineSeenAt: machine !== null && !machine.revoked && machine.connectorVersion !== undefined ? machine.lastSeenAt : null,
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
    await ctx.db.delete(a._id)
    await ctx.scheduler.runAfter(0, internal.retention.purgeArtifact, { artifactId: a._id })
    // A publish of this page may be under way, with a grant that is still good
    await removeLater(ctx, prefixOf(user._id, a._id), { grantMayBeLive: true })
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
