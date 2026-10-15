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
const of = (row: Doc<'tours'> | null): Tour => {
  if (!row) return {}
  const { _id, _creationTime, userId, ...tour } = row
  return tour
}
/** Old commands have no invocation identity, so their cancellation lasts only for their lease. */
const turnedAway = (tour: Tour): boolean =>
  tour.waitingId !== undefined
    ? tour.waitingCancelled === true
    : tour.doneAt !== undefined && tour.waitingUntil !== undefined && tour.waitingUntil - WAITING_MS <= tour.doneAt

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
 * Each command registers its identity once. Later polls must still own that registration,
 * even after its lease expires. Skip cancels that identity, and a new command can register
 * immediately. An older command cannot restore or clear the new command's registration.
 */
export const wait = mutation({
  args: { harness: v.optional(v.string()), waitId: v.optional(v.string()), first: v.optional(v.boolean()) },
  handler: async (ctx, { harness, waitId, first }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const now = Date.now()
    const was = await kept(ctx, user._id)
    const tour = of(was)
    const asked = tour.askedAt !== undefined && tour.askedAt > (tour.takenAt ?? 0) && now - tour.askedAt < ASKED_FOR_MS
    const by = harness?.slice(0, 40) ?? tour.by
    if (waitId !== undefined && (!waitId || waitId.length > 80)) fail('invalid', 'The tour wait needs an id of at most 80 characters.')
    if (first !== undefined && waitId === undefined) fail('invalid', 'The first tour poll needs a wait id.')
    const same = tour.waitingId === waitId
    if (same && turnedAway(tour) && (waitId !== undefined || tour.waitingUntil! > now))
      fail('conflict', 'The person said on the site that they want no tour, so there is nothing to wait for. Give the tour when they ask you for it.')
    if ((!same && !first && waitId !== undefined) || (waitId === undefined && tour.waitingId !== undefined))
      fail('conflict', 'This tour wait is no longer current. Run it tour --wait again if the person wants a tour.')
    if (asked) await keep(ctx, user._id, was, { ...tour, takenAt: now, waitingUntil: undefined, waitingId: undefined, waitingCancelled: undefined, by })
    else if (!same || (tour.waitingUntil ?? 0) < now + WAITING_MS / 2 || tour.by !== by)
      await keep(ctx, user._id, was, { ...tour, waitingUntil: now + WAITING_MS, waitingId: waitId, waitingCancelled: undefined, by })
    return { asked }
  },
})

/** An agent that was waiting stops, with nobody having asked: the site says so no longer. */
export const leave = mutation({
  args: { waitId: v.optional(v.string()) },
  handler: async (ctx, { waitId }) => {
    const { user } = await requireMachine(ctx)
    const was = await kept(ctx, user._id)
    if (was?.waitingUntil !== undefined && was.waitingId === waitId && !turnedAway(of(was)))
      await keep(ctx, user._id, was, { ...of(was), waitingUntil: undefined, waitingId: undefined, waitingCancelled: undefined })
    return null
  },
})

/**
 * A tour is over: its agent took its pages away at the end of one, or the person said on the
 * site that they want none. From then on someone with no pages is shown things to ask for,
 * and not the way into the tour. An asking that no agent had taken up is over with it.
 *
 * A browser cancels the registered command even if its last lease has expired. Its next
 * poll still ends, while a newly registered command is independent of that cancellation.
 * An agent ending a tour clears the registration without marking it as skipped.
 */
export const done = mutation({
  args: {},
  handler: async (ctx) => {
    const { kind, user } = await requireCaller(ctx)
    const now = Date.now()
    const was = await kept(ctx, user._id)
    const tour = of(was)
    const waitingUntil = kind === 'browser' && (tour.waitingId !== undefined || (tour.waitingUntil ?? 0) > now) ? tour.waitingUntil : undefined
    await keep(ctx, user._id, was, {
      ...tour,
      doneAt: now,
      askedAt: undefined,
      waitingUntil,
      waitingId: kind === 'browser' ? tour.waitingId : undefined,
      waitingCancelled: kind === 'browser' && tour.waitingId !== undefined ? true : undefined,
    })
    return null
  },
})
