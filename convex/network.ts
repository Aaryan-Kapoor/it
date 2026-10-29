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
//
// The owner also chooses here where the links that agents give are: at this computer's own
// name, at the machine's name on the tailnet, or at its address on the network. Only a place It
// can be reached at as the network stands is offered, and a link is never given at one It cannot
// be reached at.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, internalQuery, mutation, type QueryCtx, query } from './_generated/server'
import { basePort, site } from './config'
import { requireOwner } from './lib/authz'
import { forgetNoted } from './lib/counted'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'

/** The three ways the network can be: off, on for every network the machine is on, or on for the person's tailnet alone. */
const way = v.union(v.literal('off'), v.literal('on'), v.literal('tailscale'))
/** How long an asking that the service has not taken up is still acted on. One left from before the service was stopped is not carried out hours later. */
export const ASKED_FOR_MS = 60_000

/** An address as the service gives one: plain http, a host that is a name or an address, and a port, with nothing after it. */
const ADDRESS = /^http:\/\/(\[[0-9a-f:.]{2,45}\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?):[0-9]{1,5}$/
/** The most addresses that are kept. */
const MOST = 16
/** A machine's name on a tailnet as the service gives one: parts of letters, digits and hyphens, joined by dots, as Tailscale's own command says it. */
const TAILNET_NAME = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/

/** Where the links that agents give can be: at this computer's own name, at the machine's name on its tailnet, or at its first address on the network. */
const linkWay = v.union(v.literal('local'), v.literal('tailnet'), v.literal('network'))
type LinkWay = 'local' | 'tailnet' | 'network'
/** Why the links cannot be at a place just now, in a word: It answers its own machine alone, that machine is on no tailnet, Tailscale does not say its name there, It is kept to the tailnet, or the machine has no address on a network. */
export type Unlinked = 'off' | 'no_tailnet' | 'no_name' | 'kept_to_tailnet' | 'no_address'

/**
 * The address It can be reached at for each place the links can be, as the service last said
 * how its door stands: this computer's own always, the machine's name on the tailnet where the
 * door answers to it, and its first address on the network where the door answers every
 * network. That first address is the one another device is given to open the site at.
 */
function linkable(row: Doc<'network'> | null): { local: string; tailnet?: string; network?: string } {
  const tailnet = httpsAt(row) ?? (row?.on && row.tailnetName ? `http://${row.tailnetName}:${basePort()}` : undefined)
  return {
    local: site(),
    ...(tailnet ? { tailnet } : {}),
    ...(row?.on && !row.tailnet && row.addresses[0] ? { network: row.addresses[0] } : {}),
  }
}
/** Why the links cannot be at a place as the network stands, or nothing where they can. */
function unlinkable(row: Doc<'network'> | null, to: LinkWay): Unlinked | undefined {
  if (linkable(row)[to]) return undefined
  if (!row?.on) return 'off'
  if (to === 'tailnet') return row.canTailnet === false ? 'no_tailnet' : 'no_name'
  return row.tailnet ? 'kept_to_tailnet' : 'no_address'
}
/** What the owner is told of a place the links cannot be at, by why. */
const NOT_LINKABLE: Record<Unlinked, string> = {
  off: 'It answers only the machine it runs on, so no other device could open a link there. Choose who else can reach It first.',
  no_tailnet: 'The machine It runs on is on no tailnet.',
  no_name: 'Tailscale has not said the machine’s name on the tailnet, so there is no name to give links at.',
  kept_to_tailnet: 'It is kept to your tailnet, and answers nothing at its address on the network.',
  no_address: 'The machine It runs on has no address on a network just now.',
}

/**
 * Where another device opens It over https, through Tailscale on the machine It runs on, as the
 * service last said: at the machine's name on the tailnet, on the site's own port. It goes on
 * working whether or not the network is on, since Tailscale hands every request to It on that
 * machine itself.
 */
const httpsAt = (row: Doc<'network'> | null): string | undefined => (row?.https ? `https://${row.https}:${basePort()}` : undefined)

async function said(ctx: QueryCtx): Promise<{ on: boolean; wanted: boolean; addresses: string[]; tailnet?: boolean; https?: string }> {
  const row = await ctx.db.query('network').first()
  const secure = httpsAt(row)
  return {
    on: row?.on ?? false,
    wanted: row?.wanted ?? false,
    // The address over https first: there a browser lets a page It records for use the microphone
    addresses: [...(secure ? [secure] : []), ...(row?.on ? row.addresses : [])],
    ...(typeof row?.tailnet === 'boolean' ? { tailnet: row.on && row.tailnet } : {}),
    ...(row?.https ? { https: row.https } : {}),
  }
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
  args: {
    on: v.boolean(),
    wanted: v.boolean(),
    addresses: v.array(v.string()),
    background: v.optional(v.boolean()),
    usage: v.optional(v.boolean()),
    // What the site needs to offer the network as a switch: whether the door answers the tailnet
    // alone, whether the machine is on one, and why "on" would mean the internet there
    tailnet: v.optional(v.boolean()),
    canTailnet: v.optional(v.boolean()),
    exposed: v.optional(v.string()),
    // The machine's name on the tailnet, where the door answers to it: a link an agent gives can be at it
    tailnetName: v.optional(v.string()),
    // The same name, where It answers there over https through Tailscale, whether or not the network is on
    https: v.optional(v.string()),
  },
  handler: async (ctx, { on, wanted, addresses, background, usage, tailnet, canTailnet, exposed, tailnetName, https }) => {
    const kept = on ? [...new Set(addresses.filter((a) => a.length <= 300 && ADDRESS.test(a)))].slice(0, MOST) : []
    const why = exposed?.slice(0, 300)
    const named = on && tailnetName !== undefined && tailnetName.length <= 253 && TAILNET_NAME.test(tailnetName) ? tailnetName : undefined
    const secure = https !== undefined && https.length <= 253 && TAILNET_NAME.test(https) ? https : undefined
    const row = await ctx.db.query('network').first()
    if (
      row &&
      row.on === on &&
      row.wanted === wanted &&
      row.background === background &&
      row.usage === usage &&
      row.tailnet === tailnet &&
      row.canTailnet === canTailnet &&
      row.exposed === why &&
      row.tailnetName === named &&
      row.https === secure &&
      JSON.stringify(row.addresses) === JSON.stringify(kept)
    )
      return null
    const stopped = row?.usage === true && usage !== true
    const usageGeneration = (row?.usageGeneration ?? 0) + (stopped ? 1 : 0)
    const stands = { on, wanted, addresses: kept, background, usage, usageGeneration, tailnet, canTailnet, exposed: why, tailnetName: named, https: secure }
    if (row) await ctx.db.patch(row._id, stands)
    else await ctx.db.insert('network', stands)
    // Counts were being sent and are no more. What was noted for them goes now, and is not left
    // until the service next comes for it: by then the person may have turned the counts on
    // again, and what was noted before they turned them off would be sent under the new id.
    if (stopped) {
      const upTo = Date.now()
      if (await forgetNoted(ctx, upTo, usageGeneration)) await ctx.scheduler.runAfter(0, internal.counted.forget, { upTo, generation: usageGeneration })
    }
    // How many, and never which: an address is the person's own
    log('network.reported', { on, wanted, addresses: kept.length, background, usage, ...(secure ? { https: true } : {}) })
    return null
  },
})

/**
 * The owner asks, on the site, for the network to be off, on, or on for their tailnet alone.
 * Nothing is changed here: the service that listens is what opens its door anew, and it takes
 * the asking up within a second or two (`taken`), does it as `it network` would, and says what
 * became of it (`answer`). An asking takes the place of one that was still waiting. The answer
 * names the asking, by when it was made, so that a browser can tell the answer to its own from
 * the answer to one made in another tab.
 */
export const ask = mutation({
  args: { to: way },
  handler: async (ctx, { to }) => {
    const { user } = await requireOwner(ctx)
    await rateLimit(ctx, 'network', user._id)
    const row = await ctx.db.query('network').first()
    // Asked for where it cannot be had: said at once, and not after the service has found the same
    if (to === 'tailscale' && row?.canTailnet !== true) fail('invalid', 'The machine It runs on is on no tailnet, so there is none to keep It to.')
    // Never the name of the one before it, though two are made within the same moment
    const at = Math.max(Date.now(), (row?.asked?.at ?? 0) + 1, (row?.answered?.asked ?? 0) + 1)
    const asked = { to, at }
    if (row) await ctx.db.patch(row._id, { asked })
    else await ctx.db.insert('network', { on: false, wanted: false, addresses: [], asked })
    log('network.asked', { to })
    return { asked: at }
  },
})

/** What the owner asked for and the service has not yet answered, for the service, which looks every second. Nothing where nothing waits. */
export const waiting = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query('network').first())?.asked ?? null,
})

/**
 * The service takes an asking up, and is given what was asked and the asking's name. It stays
 * with the backend, as taken, until the service has answered for it: taken away here, one the
 * service could not answer for would have left the site waiting for ever. Asked for again while
 * it is taken, it is given again. One that has waited too long without being taken up is let go
 * of and answered as that, and not carried out: the person may have forgotten it by the time
 * the service is running again.
 */
export const taken = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query('network').first()
    if (!row?.asked) return null
    const { to, at } = row.asked
    if (row.asked.taken) return { to, at }
    if (Date.now() - at > ASKED_FOR_MS) {
      await ctx.db.patch(row._id, { asked: undefined, answered: { to, at: Date.now(), ok: false, why: 'too_late', asked: at } })
      return null
    }
    await ctx.db.patch(row._id, { asked: { to, at, taken: true } })
    return { to, at }
  },
})

/**
 * The service says what became of an asking it took up, by the asking's name. The asking is
 * done with only now, and only if it is still the one that waits: another may have taken its
 * place meanwhile, and that one is the service's to take up next.
 */
export const answer = internalMutation({
  args: { asked: v.number(), to: way, ok: v.boolean(), why: v.optional(v.string()) },
  handler: async (ctx, { asked, to, ok, why }) => {
    const row = await ctx.db.query('network').first()
    if (!row) return null
    await ctx.db.patch(row._id, {
      answered: { to, at: Date.now(), ok, ...(why ? { why: why.slice(0, 40) } : {}), asked },
      ...(row.asked?.at === asked ? { asked: undefined } : {}),
    })
    log('network.answered', { to, ok, why })
    return null
  },
})

/** How the door stands and what was asked of it, for the command on the machine It runs on, which asks as the service does. */
export const current = internalQuery({ args: {}, handler: (ctx) => said(ctx) })

/**
 * How the door stands, for the owner's browser, with what it needs to offer the network as a
 * switch: whether It is kept to the tailnet, whether it can be, why "on" would mean the
 * internet on that machine, and what was asked here and what became of it.
 */
export const get = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx)
    const { on, addresses } = await said(ctx)
    const row = await ctx.db.query('network').first()
    return {
      on,
      addresses,
      // The machine's name on the tailnet where It answers there over https, through Tailscale, or nothing
      https: row?.https ?? null,
      tailnet: on && row?.tailnet === true,
      // Null while the service has not said, as from a service of an earlier It: the switch is then not offered
      canTailnet: row?.canTailnet ?? null,
      exposed: row?.exposed ?? null,
      asked: row?.asked ?? null,
      answered: row?.answered ?? null,
      // Where the links agents give are to be, and each place they can be at as the network stands, by its address
      link: row?.link ?? 'local',
      links: linkable(row),
    }
  },
})

/**
 * The owner chooses, on the site, where the links that agents give are. Only a place It can be
 * reached at as the network stands is taken: a link anywhere else would open nothing, and the
 * owner is told why in a sentence. This computer's own name is always taken.
 */
export const link = mutation({
  args: { to: linkWay },
  handler: async (ctx, { to }) => {
    const { user } = await requireOwner(ctx)
    await rateLimit(ctx, 'network', user._id)
    const row = await ctx.db.query('network').first()
    const why = unlinkable(row, to)
    if (why) fail('invalid', NOT_LINKABLE[why])
    // This computer, chosen where nothing is said yet, is where the links already are
    if (row) await ctx.db.patch(row._id, { link: to === 'local' ? undefined : to })
    log('network.linked', { to })
    return null
  },
})

/**
 * Where the link to a page that an agent is given is, for publishing: at the place the owner
 * chose, where It can be reached at it. Nothing where that is this computer, whose address each
 * machine has for itself: the machine It runs on calls it localhost, and one that joined from
 * another computer reaches it at the door it joined at. Where It cannot be reached at the place
 * chosen, which place that is and why not, so that the agent can say why its link is the other.
 */
export const linkFor = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ at: string } | { unlinked: { to: 'tailnet' | 'network'; why: Unlinked } } | null> => {
    const row = await ctx.db.query('network').first()
    const to = row?.link
    if (!to) return null
    const why = unlinkable(row, to)
    return why ? { unlinked: { to, why } } : { at: linkable(row)[to]! }
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
