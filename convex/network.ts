// Whether It answers other devices on the person's network, and at which addresses. The
// service that runs the backend is what listens, so it is the one that knows: it says so here
// when it starts and whenever it changes. The owner's browser reads it, to show where another
// screen or another machine opens It, and it changes under that browser's eyes when the network
// is turned on or off. A paired screen and a browser that is not paired are told nothing of it.
//
// With the same word the service says two things of itself that only the computer it runs on
// can know: whether It is registered there to start by itself, and whether counts of its use
// are being sent. The owner's settings say them as they are, and say neither as a fact while
// the service has not said.
import { v } from 'convex/values'
import { internalMutation, internalQuery, type QueryCtx, query } from './_generated/server'
import { basePort } from './config'
import { requireOwner } from './lib/authz'
import { log } from './lib/log'

/** An address as the service gives one: plain http, a host that is a name or an address, and a port, with nothing after it. */
const ADDRESS = /^http:\/\/(\[[0-9a-f:.]{2,45}\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?):[0-9]{1,5}$/
/** The most addresses that are kept. */
const MOST = 16

async function said(ctx: QueryCtx): Promise<{ on: boolean; wanted: boolean; addresses: string[] }> {
  const row = await ctx.db.query('network').first()
  return { on: row?.on ?? false, wanted: row?.wanted ?? false, addresses: row?.on ? row.addresses : [] }
}

/**
 * The service says how its door stands, and what its settings asked for: the two differ where
 * it was asked to listen on the network and could not. With it, when it knows them, it says
 * whether It is registered with the system to start by itself (`background`) and whether counts
 * of its use are being sent (`usage`). What is kept is what it said last: a word that leaves
 * either out leaves it unsaid. Only what has changed is written, so that nothing that reads it
 * runs again for nothing.
 */
export const report = internalMutation({
  args: { on: v.boolean(), wanted: v.boolean(), addresses: v.array(v.string()), background: v.optional(v.boolean()), usage: v.optional(v.boolean()) },
  handler: async (ctx, { on, wanted, addresses, background, usage }) => {
    const kept = on ? [...new Set(addresses.filter((a) => a.length <= 300 && ADDRESS.test(a)))].slice(0, MOST) : []
    const row = await ctx.db.query('network').first()
    if (
      row &&
      row.on === on &&
      row.wanted === wanted &&
      row.background === background &&
      row.usage === usage &&
      JSON.stringify(row.addresses) === JSON.stringify(kept)
    )
      return null
    const stands = { on, wanted, addresses: kept, background, usage }
    if (row) await ctx.db.patch(row._id, stands)
    else await ctx.db.insert('network', stands)
    // How many, and never which: an address is the person's own
    log('network.reported', { on, wanted, addresses: kept.length, background, usage })
    return null
  },
})

/** How the door stands and what was asked of it, for the command on the machine It runs on, which asks as the service does. */
export const current = internalQuery({ args: {}, handler: (ctx) => said(ctx) })

/** How the door stands, for the owner's browser. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx)
    const { on, addresses } = await said(ctx)
    return { on, addresses }
  },
})

/**
 * What the service says of itself on the computer It runs on, for the owner's settings: the
 * port everything is counted from, whether It is registered there to start by itself, and
 * whether counts of its use are being sent. Each of the last two is null while the service has
 * not said.
 */
export const service = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx)
    const row = await ctx.db.query('network').first()
    return { port: basePort(), background: row?.background ?? null, usage: row?.usage ?? null }
  },
})
