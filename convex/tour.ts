// The tour an agent gives of It, as far as the backend has a part in it: a person asks for it
// with a button on the site, and an agent that is waiting to give it hears that they did. So
// that someone whose agent has just installed It does not have to carry a sentence from the
// site back to the agent by hand. And whether a tour was ever finished, which is what the site
// goes by when it chooses what to show someone who has no pages.
//
// All of it is kept in a record of its own, and not in the person's: see `tours` in the schema.
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { requireBrowser, requireCaller, requireMachine } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'

/** How long an agent that said it is waiting is taken to be waiting still. It says so again every few seconds. */
export const WAITING_MS = 15_000
/** How long an asking that no agent has taken up is still good for one that comes to wait. */
export const ASKED_FOR_MS = 10 * 60_000

type Tour = Omit<Doc<'tours'>, '_id' | '_creationTime' | 'userId'>
const kept = (ctx: QueryCtx, userId: Id<'users'>) =>
  ctx.db
    .query('tours')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first()
/** Writes how things stand now, in the one record a person has for it. */
async function keep(ctx: MutationCtx, userId: Id<'users'>, was: Doc<'tours'> | null, now: Tour): Promise<void> {
  if (was) await ctx.db.replace(was._id, { userId, ...now })
  else await ctx.db.insert('tours', { userId, ...now })
}
const of = (row: Doc<'tours'> | null): Tour =>
  row ? { waitingUntil: row.waitingUntil, by: row.by, askedAt: row.askedAt, takenAt: row.takenAt, doneAt: row.doneAt } : {}
/**
 * Whether the agent that is written down as waiting said so before the person said on the site
 * that they want no tour. Such an agent is waiting for nobody: the site is told that none
 * waits, and the agent is told why when it next asks. It is known by what is written alone,
 * since what an agent says of its waiting is written `WAITING_MS` ahead of when it said it.
 */
const turnedAway = (tour: Tour): boolean => tour.doneAt !== undefined && tour.waitingUntil !== undefined && tour.waitingUntil - WAITING_MS <= tour.doneAt

/** How things stand with the tour, for the site to show. Times are the backend's own. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireCaller(ctx)
    const tour = of(await kept(ctx, user._id))
    return {
      waitingUntil: turnedAway(tour) ? null : (tour.waitingUntil ?? null),
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
    const was = await kept(ctx, user._id)
    const tour = of(was)
    await keep(ctx, user._id, was, { ...tour, askedAt: now })
    return { waiting: !turnedAway(tour) && (tour.waitingUntil ?? 0) > now, by: tour.by ?? null }
  },
})

/**
 * An agent says that it is waiting to give the tour, and is told whether the person has asked
 * for it. Called every few seconds for as long as it waits. An asking is taken up once: the
 * agent that hears of it gives the tour, and the next one to wait hears of nothing. That it
 * waits is written down only when what is written is about to run out, and not at every
 * asking: the site asks again for what it shows of the tour each time this is written.
 *
 * An agent that was waiting when the person said they want no tour is refused, for as long as
 * what it last said of its waiting would have stood. Left to go on, it would be written down
 * as waiting again at its next asking, and the site would take the person's word back. The
 * refusal ends its command, and tells the agent why. One that comes to wait after that began
 * after the person said so, and waits as any does.
 */
export const wait = mutation({
  args: { harness: v.optional(v.string()) },
  handler: async (ctx, { harness }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const now = Date.now()
    const was = await kept(ctx, user._id)
    const tour = of(was)
    const asked = tour.askedAt !== undefined && tour.askedAt > (tour.takenAt ?? 0) && now - tour.askedAt < ASKED_FOR_MS
    const by = harness?.slice(0, 40) ?? tour.by
    if (turnedAway(tour) && tour.waitingUntil! > now)
      fail('conflict', 'The person said on the site that they want no tour, so there is nothing to wait for. Give the tour when they ask you for it.')
    if (asked) await keep(ctx, user._id, was, { ...tour, takenAt: now, waitingUntil: undefined, by })
    else if ((tour.waitingUntil ?? 0) < now + WAITING_MS / 2 || tour.by !== by) await keep(ctx, user._id, was, { ...tour, waitingUntil: now + WAITING_MS, by })
    return { asked }
  },
})

/** An agent that was waiting stops, with nobody having asked: the site says so no longer. */
export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireMachine(ctx)
    const was = await kept(ctx, user._id)
    if (was?.waitingUntil !== undefined) await keep(ctx, user._id, was, { ...of(was), waitingUntil: undefined })
    return null
  },
})

/**
 * A tour is over: its agent took its pages away at the end of one, or the person said on the
 * site that they want none. From then on someone with no pages is shown things to ask for,
 * and not the way into the tour. An asking that no agent had taken up is over with it.
 *
 * Where it is the person who says so and an agent is waiting, what that agent said of its
 * waiting is left as it is written, and is what the agent is turned away by when it next
 * asks: see `turnedAway`. An agent that ends a tour of its own turns nobody away.
 */
export const done = mutation({
  args: {},
  handler: async (ctx) => {
    const { kind, user } = await requireCaller(ctx)
    const now = Date.now()
    const was = await kept(ctx, user._id)
    const tour = of(was)
    const waitingUntil = kind === 'browser' && (tour.waitingUntil ?? 0) > now ? tour.waitingUntil : undefined
    await keep(ctx, user._id, was, { ...tour, doneAt: now, askedAt: undefined, waitingUntil })
    return null
  },
})
