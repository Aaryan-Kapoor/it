// The key the backend signs with. Nothing outside the backend can call these.
import { v } from 'convex/values'
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server'
import { log } from './lib/log'

/** The first key that was kept is the key. */
const kept = (ctx: QueryCtx | MutationCtx) => ctx.db.query('signingKeys').first()

export const current = internalQuery({ args: {}, handler: (ctx) => kept(ctx) })

/** Keeps the first key offered, so two requests racing to make one end up sharing it. */
export const keep = internalMutation({
  args: { kid: v.string(), privateJwk: v.any(), publicJwk: v.any() },
  handler: async (ctx, key) => {
    const existing = await kept(ctx)
    if (existing) return existing
    const id = await ctx.db.insert('signingKeys', { ...key, createdAt: Date.now() })
    log('key.made', { kid: key.kid })
    return (await ctx.db.get(id))!
  },
})
