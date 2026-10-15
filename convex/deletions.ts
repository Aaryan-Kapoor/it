import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, query } from './_generated/server'
import { requireMachineOrOwner, requireOwner } from './lib/authz'
import { fail } from './lib/errors'

/** A receipt is kept after its jobs finish, so absence never means success. */
const receipt = (d: Doc<'deletions'>) => ({
  job: d._id,
  slug: d.slug,
  title: d.title,
  requestedAt: d.requestedAt,
  state: d.completedAt !== undefined ? ('completed' as const) : d.failedAt !== undefined ? ('retrying' as const) : ('pending' as const),
  completedAt: d.completedAt ?? null,
  failedAt: d.failedAt ?? null,
  nextAt: d.nextAt ?? null,
  attempts: d.attempts,
})

/** Only the content service and the record cleanup together can confirm completion. */
export async function confirmed(ctx: MutationCtx, id: Id<'deletions'>, part: 'contentAt' | 'recordsAt') {
  const d = await ctx.db.get(id)
  if (!d || d.completedAt !== undefined) return
  const now = Date.now()
  const other = part === 'contentAt' ? d.recordsAt : d.contentAt
  await ctx.db.patch(id, {
    [part]: now,
    ...(part === 'contentAt' ? { failedAt: undefined, nextAt: undefined } : {}),
    ...(other !== undefined ? { completedAt: now } : {}),
  })
}

export const get = query({
  args: { job: v.optional(v.id('deletions')), slug: v.optional(v.string()) },
  handler: async (ctx, { job, slug }) => {
    const { user } = await requireMachineOrOwner(ctx)
    const d = job
      ? await ctx.db.get(job)
      : slug
        ? await ctx.db
            .query('deletions')
            .withIndex('by_user_slug', (q) => q.eq('userId', user._id).eq('slug', slug))
            .order('desc')
            .first()
        : null
    if (!d || d.userId !== user._id) return fail('not_found', 'No deletion record was found. Its completion is unknown.')
    return receipt(d)
  },
})

/** Pending deletions stay visible across reloads, with the ten most recent completions. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireOwner(ctx)
    const pending = await ctx.db
      .query('deletions')
      .withIndex('by_user_completed', (q) => q.eq('userId', user._id).eq('completedAt', undefined))
      .take(100)
    const completed = await ctx.db
      .query('deletions')
      .withIndex('by_user_completed', (q) => q.eq('userId', user._id).gt('completedAt', 0))
      .order('desc')
      .take(10)
    return [...pending, ...completed].map(receipt)
  },
})
