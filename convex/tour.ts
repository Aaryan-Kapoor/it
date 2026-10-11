// The tour an agent gives of It, as far as the backend has a part in it: a person asks for it
// with a button on the site, and an agent that is waiting to give it hears that they did. So
// that someone whose agent has just installed It does not have to carry a sentence from the
// site back to the agent by hand. And whether a tour was ever finished, which is what the site
// goes by when it chooses what to show someone who has no pages.
import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireBrowser, requireCaller, requireMachine } from './lib/authz'
import { rateLimit } from './lib/limits'

/** How long an agent that said it is waiting is taken to be waiting still. It says so again every few seconds. */
export const WAITING_MS = 15_000
/** How long an asking that no agent has taken up is still good for one that comes to wait. */
export const ASKED_FOR_MS = 10 * 60_000

/** How things stand with the tour, for the site to show. Times are the backend's own. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireCaller(ctx)
    const tour = user.tour ?? {}
    return {
      waitingUntil: tour.waitingUntil ?? null,
      by: tour.by ?? null,
      askedAt: tour.askedAt ?? null,
      takenAt: tour.takenAt ?? null,
      doneAt: tour.doneAt ?? null,
    }
  },
})

/**
 * The person asks for the tour, on the site. The answer says whether an agent is waiting to
 * give it at this moment: where none is, the site hands the person the sentence to give their
 * agent, as it did before there was a button.
 */
export const ask = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireBrowser(ctx)
    await rateLimit(ctx, 'show', user._id)
    const now = Date.now()
    const tour = user.tour ?? {}
    await ctx.db.patch(user._id, { tour: { ...tour, askedAt: now } })
    return { waiting: (tour.waitingUntil ?? 0) > now, by: tour.by ?? null }
  },
})

/**
 * An agent says that it is waiting to give the tour, and is told whether the person has asked
 * for it. Called every few seconds for as long as it waits. An asking is taken up once: the
 * agent that hears of it gives the tour, and the next one to wait hears of nothing.
 */
export const wait = mutation({
  args: { harness: v.optional(v.string()) },
  handler: async (ctx, { harness }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const now = Date.now()
    const tour = user.tour ?? {}
    const asked = tour.askedAt !== undefined && tour.askedAt > (tour.takenAt ?? 0) && now - tour.askedAt < ASKED_FOR_MS
    const by = harness?.slice(0, 40) ?? tour.by
    await ctx.db.patch(user._id, {
      tour: asked
        ? { ...tour, takenAt: now, waitingUntil: undefined, ...(by ? { by } : {}) }
        : { ...tour, waitingUntil: now + WAITING_MS, ...(by ? { by } : {}) },
    })
    return { asked }
  },
})

/** An agent that was waiting stops, with nobody having asked: the site says so no longer. */
export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireMachine(ctx)
    if (user.tour?.waitingUntil !== undefined) await ctx.db.patch(user._id, { tour: { ...user.tour, waitingUntil: undefined } })
    return null
  },
})

/**
 * A tour is over: its agent took its pages away at the end of one, or the person said on the
 * site that they want none. From then on someone with no pages is shown things to ask for,
 * and not the way into the tour.
 */
export const done = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireCaller(ctx)
    await ctx.db.patch(user._id, { tour: { ...(user.tour ?? {}), doneAt: Date.now(), waitingUntil: undefined } })
    return null
  },
})
