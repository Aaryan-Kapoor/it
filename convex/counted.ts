// What the service asks of the notes the backend keeps for the counts of how It is used
// (`lib/counted.ts`): the notes themselves, which it takes away, and once a day how much this
// It holds, as numbers that it turns into bands before anything is sent.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'
import { forgetNoted } from './lib/counted'

/** The most notes given at one asking. */
const AT_ONCE = 200
/** How long a note is kept for a service that does not come for it. */
export const KEPT_MS = 7 * 86_400_000

/**
 * Gives the service the oldest notes and removes them, so that each is counted once. With
 * `keep` false nothing is given: every note is removed, which is what the service asks for
 * when the person has turned the counts off.
 */
export const take = internalMutation({
  args: { keep: v.optional(v.boolean()) },
  handler: async (ctx, { keep }) => {
    const generation = (await ctx.db.query('network').first())?.usageGeneration ?? 0
    const rows = await ctx.db.query('counted').order('asc').take(AT_ONCE)
    for (const row of rows) await ctx.db.delete(row._id)
    return {
      notes:
        keep === false
          ? []
          : rows.filter((row) => (row.generation ?? 0) === generation).map((row) => ({ name: row.name, properties: row.properties, at: row.at })),
      more: rows.length === AT_ONCE,
    }
  },
})

/** Removes earlier reporting generations a step at a time. The timestamp also accepts tasks scheduled before generations were recorded. */
export const forget = internalMutation({
  args: { upTo: v.number(), generation: v.optional(v.number()) },
  handler: async (ctx, { upTo, generation }) => {
    if (await forgetNoted(ctx, upTo, generation)) await ctx.scheduler.runAfter(0, internal.counted.forget, { upTo, generation })
    return null
  },
})

/** Removes notes nobody came for. Run with the hourly sweep. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query('counted')
      .withIndex('by_at', (q) => q.lt('at', Date.now() - KEPT_MS))
      .take(500)
    for (const row of old) await ctx.db.delete(row._id)
    return null
  },
})

/** Counting stops at this many: past it the band is "over 100" whatever the number. */
const ENOUGH = 101

/**
 * How much this It holds: its pages, its displays, its machines and the conversations that
 * have made a page, each counted up to a little past a hundred, and whether any display has
 * notifications turned on. Numbers only, of the person the It is for.
 */
export const picture = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_deleted', (q) => q.eq('deletedAt', undefined))
      .first()
    if (!user) return { pages: 0, displays: 0, machines: 0, conversations: 0, push: false }
    const [pages, displays, machines] = await Promise.all([
      ctx.db
        .query('artifacts')
        .withIndex('by_user_updated', (q) => q.eq('userId', user._id))
        .take(ENOUGH),
      ctx.db
        .query('displays')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .take(ENOUGH),
      ctx.db
        .query('machines')
        .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
        .take(ENOUGH),
    ])
    // Seek past each conversation's pages, including pages without a conversation. Each
    // successful seek reads one representative, so even a conversation with thousands of
    // pages cannot hide the next one or exhaust the query's document budget. There are at
    // most 101 representatives and two seeks per conversation, regardless of page count.
    let conversation = await ctx.db
      .query('artifacts')
      .withIndex('by_user_conversation', (q) => q.eq('userId', user._id).gt('session.harness', undefined))
      .first()
    let conversations = 0
    while (conversation?.session) {
      conversations++
      if (conversations === ENOUGH) break
      const { harness, id } = conversation.session
      conversation = await ctx.db
        .query('artifacts')
        .withIndex('by_user_conversation', (q) => q.eq('userId', user._id).eq('session.harness', harness).gt('session.id', id))
        .first()
      if (!conversation) {
        conversation = await ctx.db
          .query('artifacts')
          .withIndex('by_user_conversation', (q) => q.eq('userId', user._id).gt('session.harness', harness))
          .first()
      }
    }
    return {
      pages: pages.length,
      displays: displays.length,
      machines: machines.length,
      conversations,
      push: displays.some((d) => d.push !== undefined),
    }
  },
})
