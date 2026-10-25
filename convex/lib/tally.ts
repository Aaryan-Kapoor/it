// Running totals for one person: clicks still waiting, publishes begun and not finished, and the
// bytes of the files sent with actions that It holds for them.
// They are kept in a row of their own, read only by the mutations that change them. Were they
// on the person's own record, every click would make every live query of that person run
// again, because every query reads that record to know who is asking.
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

export interface Tally {
  waiting: number
  stagingCount: number
  stagingBytes: number
  fileBytes: number
}
const ZERO: Tally = { waiting: 0, stagingCount: 0, stagingBytes: 0, fileBytes: 0 }

async function row(ctx: MutationCtx, userId: Id<'users'>): Promise<Doc<'tallies'> | null> {
  return ctx.db
    .query('tallies')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique()
}

export async function tally(ctx: MutationCtx, userId: Id<'users'>): Promise<Tally> {
  const t = await row(ctx, userId)
  return t ? { waiting: t.waiting, stagingCount: t.stagingCount, stagingBytes: t.stagingBytes, fileBytes: t.fileBytes ?? 0 } : ZERO
}

/** Adds to the person's totals (or takes away, with negative numbers). No total goes below nothing. */
export async function bump(ctx: MutationCtx, userId: Id<'users'>, by: Partial<Tally>): Promise<void> {
  const t = await row(ctx, userId)
  const next = {
    waiting: Math.max(0, (t?.waiting ?? 0) + (by.waiting ?? 0)),
    stagingCount: Math.max(0, (t?.stagingCount ?? 0) + (by.stagingCount ?? 0)),
    stagingBytes: Math.max(0, (t?.stagingBytes ?? 0) + (by.stagingBytes ?? 0)),
    fileBytes: Math.max(0, (t?.fileBytes ?? 0) + (by.fileBytes ?? 0)),
  }
  if (t) await ctx.db.patch(t._id, next)
  else await ctx.db.insert('tallies', { userId, ...next })
}

/**
 * The next number in the one order that a person's clicks and stops are given, as they are
 * written. A stop is after every click that was written before it and before every click that
 * is written after it, whatever the backend's clock says of either: the number is taken in the
 * same step that writes the click or the stop, and no two steps that take one both stand.
 */
export async function nextSequence(ctx: MutationCtx, userId: Id<'users'>): Promise<number> {
  const t = await row(ctx, userId)
  const sequence = (t?.sequence ?? 0) + 1
  if (t) await ctx.db.patch(t._id, { sequence })
  else await ctx.db.insert('tallies', { userId, ...ZERO, sequence })
  return sequence
}
