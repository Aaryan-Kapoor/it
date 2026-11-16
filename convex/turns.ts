// Whether the agent a page belongs to is at work, as the machine its conversation runs on says.
//
// A page says that its agent is at work for as long as a turn of its conversation runs, and
// shows a line that moves for as long as something done on it is with its agent. What the agent
// does to the page says nothing of whether it has finished: it may change the page at once and
// work on for minutes. So the machine says when a turn of the conversation is running and when
// it has ended, for a conversation it has handed something to and for one whose add-on says a
// turn of it is running, and the page goes by that where it is known. All of it is kept in a record of its own: see `turns` in the schema.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx } from './_generated/server'
import { requireMachine } from './lib/authz'
import { rateLimit } from './lib/limits'
import { session } from './schema'

/** How many of a machine's records are removed in one step: more than it may have, so that one step mostly does. */
const BATCH = 250
/**
 * How many conversations a machine may have a record for at once. Its connector listens for
 * forty conversations at a time and tells of each under up to three ids, its own and the ones it
 * had before it was cleared, so that every one that is running has its record however many have
 * ended. A record of a turn that ended is kept for a week, so this is room for what a machine
 * does in that time and no more than a faulty one can fill.
 */
export const TURNS_MOST = 200

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
 * one said to have ended that was never said to be running is nothing to keep, so that an
 * ending said twice is the first one. `untold` says that the turn which ended is one the
 * machine never said was running, as a short one can be over before its machine has heard
 * that it began: that is kept as a turn that began and ended at this moment, in the place of
 * whatever was kept of an earlier one. A machine has room for `TURNS_MOST` records, and a new
 * one past that takes the place of the turn that ended longest ago, or of the one that has
 * been running longest where none has ended.
 */
export const say = mutation({
  args: { for: v.optional(session), running: v.optional(v.boolean()), untold: v.optional(v.boolean()) },
  handler: async (ctx, { for: s, running, untold }) => {
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
      if (!row) {
        await makeRoom(ctx, machine._id)
        await ctx.db.insert('turns', { userId: user._id, machineId: machine._id, harness, sessionId, since: now })
      } else if (row.endedAt !== undefined) await ctx.db.replace(row._id, { userId: row.userId, machineId: row.machineId, harness, sessionId, since: now })
    } else if (row && row.endedAt === undefined) await ctx.db.patch(row._id, { endedAt: now })
    else if (untold && row) await ctx.db.patch(row._id, { since: now, endedAt: now })
    else if (untold) {
      await makeRoom(ctx, machine._id)
      await ctx.db.insert('turns', { userId: user._id, machineId: machine._id, harness, sessionId, since: now, endedAt: now })
    }
    return null
  },
})

/**
 * That the turn of a conversation a machine reopened is over, because the run that carried it
 * ended, as the machine saw: kept as ended now, whatever the conversation's add-on said or did not
 * say, so that its page does not go on saying that its agent has what was done there. A turn kept
 * as running is ended now; one kept as ended before, or none kept, is kept as one that began and
 * ended now, as a short one is whose beginning its machine never heard.
 */
export async function endedTurn(ctx: MutationCtx, userId: Id<'users'>, machineId: Id<'machines'>, s: { harness: string; id: string }): Promise<void> {
  const harness = s.harness.slice(0, 40)
  const sessionId = s.id.slice(0, 200)
  const row = await kept(ctx, machineId, harness, sessionId)
  const now = Date.now()
  if (row && row.endedAt === undefined) await ctx.db.patch(row._id, { endedAt: now })
  else if (row) await ctx.db.patch(row._id, { since: now, endedAt: now })
  else {
    await makeRoom(ctx, machineId)
    await ctx.db.insert('turns', { userId, machineId, harness, sessionId, since: now, endedAt: now })
  }
}

/** Makes room for one more record of a machine's, where it has as many as it may. */
async function makeRoom(ctx: MutationCtx, machineId: Id<'machines'>): Promise<void> {
  const rows = await ctx.db
    .query('turns')
    .withIndex('by_conversation', (q) => q.eq('machineId', machineId))
    .take(TURNS_MOST + 1)
  // Oldest first: those that ended, by when, and then those still running, by since when
  const oldest = rows.sort((a, b) => (a.endedAt ?? Number.POSITIVE_INFINITY) - (b.endedAt ?? Number.POSITIVE_INFINITY) || a.since - b.since)
  for (const row of oldest.slice(0, Math.max(0, rows.length - TURNS_MOST + 1))) await ctx.db.delete(row._id)
}

/**
 * Removes what a machine said of its conversations' turns, a batch at a time: when its
 * connector starts and knows of none of them, and when the machine is revoked.
 */
export async function forgetTurns(ctx: MutationCtx, machineId: Id<'machines'>, before = Date.now()): Promise<void> {
  const rows = await ctx.db
    .query('turns')
    .withIndex('by_conversation', (q) => q.eq('machineId', machineId))
    .take(BATCH)
  // Only what was there when the machine said so: what it says after that, before a later step
  // has run, is of turns it knows of, and stays
  const old = rows.filter((row) => row.since <= before)
  for (const row of old) await ctx.db.delete(row._id)
  if (rows.length === BATCH && old.length > 0) await ctx.scheduler.runAfter(0, internal.turns.forget, { machineId, before })
}

export const forget = internalMutation({
  args: { machineId: v.id('machines'), before: v.optional(v.number()) },
  handler: async (ctx, { machineId, before }) => {
    await forgetTurns(ctx, machineId, before)
    return null
  },
})
