// Whether the agent a page belongs to is at work, as the machine its conversation runs on says.
//
// A page shows a line that moves for as long as something done on it is with its agent. What
// the agent does to the page says nothing of whether it has finished: it may change the page at
// once and work on for minutes. So the machine says when a turn of the conversation is running
// and when it has ended, for a conversation it has handed something to, and the page goes by
// that where it is known. All of it is kept in a record of its own: see `turns` in the schema.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx } from './_generated/server'
import { requireMachine } from './lib/authz'
import { rateLimit } from './lib/limits'
import { session } from './schema'

/** How many of a machine's records are removed in one step. */
const BATCH = 200

const kept = (ctx: QueryCtx, machineId: Id<'machines'>, harness: string, sessionId: string) =>
  ctx.db
    .query('turns')
    .withIndex('by_conversation', (q) => q.eq('machineId', machineId).eq('harness', harness).eq('sessionId', sessionId))
    .unique()

/**
 * What is known of the turn of a page's conversation, for the page: since when one has been
 * running, and when it ended, where it has. Nothing where the machine has said nothing of that
 * conversation, or is no longer one of the person's.
 */
export async function turnOf(
  ctx: QueryCtx,
  machine: Doc<'machines'> | null,
  conversation: { harness: string; id: string } | undefined,
): Promise<{ since: number; endedAt: number | null } | null> {
  if (!machine || machine.revoked || !conversation) return null
  const row = await kept(ctx, machine._id, conversation.harness, conversation.id)
  return row ? { since: row.since, endedAt: row.endedAt ?? null } : null
}

/**
 * The machine says how the turn of one of its conversations stands: running, ended, or, with
 * neither said, not known any more, as when the conversation's add-on has gone quiet in the
 * middle of a turn. With no conversation named, that none of its turns is known any more, which
 * is so when its connector starts.
 *
 * A turn said to be running that is running already keeps the moment it was first said, and
 * one said to have ended that was never said to be running is nothing to keep.
 */
export const say = mutation({
  args: { for: v.optional(session), running: v.optional(v.boolean()) },
  handler: async (ctx, { for: s, running }) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'turn', machine._id)
    if (!s) {
      await forgetTurns(ctx, machine._id)
      return null
    }
    const harness = s.harness.slice(0, 40)
    const sessionId = s.id.slice(0, 200)
    const row = await kept(ctx, machine._id, harness, sessionId)
    const now = Date.now()
    if (running === undefined) {
      if (row) await ctx.db.delete(row._id)
    } else if (running) {
      if (!row) await ctx.db.insert('turns', { userId: user._id, machineId: machine._id, harness, sessionId, since: now })
      else if (row.endedAt !== undefined) await ctx.db.replace(row._id, { userId: row.userId, machineId: row.machineId, harness, sessionId, since: now })
    } else if (row && row.endedAt === undefined) await ctx.db.patch(row._id, { endedAt: now })
    return null
  },
})

/**
 * Removes what a machine said of its conversations' turns, a batch at a time: when its
 * connector starts and knows of none of them, and when the machine is revoked.
 */
export async function forgetTurns(ctx: MutationCtx, machineId: Id<'machines'>): Promise<void> {
  const rows = await ctx.db
    .query('turns')
    .withIndex('by_conversation', (q) => q.eq('machineId', machineId))
    .take(BATCH)
  for (const row of rows) await ctx.db.delete(row._id)
  if (rows.length === BATCH) await ctx.scheduler.runAfter(0, internal.turns.forget, { machineId })
}

export const forget = internalMutation({
  args: { machineId: v.id('machines') },
  handler: async (ctx, { machineId }) => {
    await forgetTurns(ctx, machineId)
    return null
  },
})
