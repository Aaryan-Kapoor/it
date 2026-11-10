// Which displays an agent's page or notification goes to. Every way an agent puts something on a
// screen comes through `aim`, so that a display is addressed the same way by `it open`, by
// `--open` on `it create` and `it update`, by the tour, and by `it notify`.
import { QUOTA } from '@it/protocol'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { fail } from './errors'
import { log } from './log'

type Ctx = QueryCtx | MutationCtx

/**
 * How an agent names where something goes: one display by its id, every display that has a
 * name, or none, which means as it always has, every display.
 */
export type Target = { id: string } | { name: string } | { none: true }

/** Why something was not put on a display that was asked for: its browser's pairing has ended. */
export type Reason = 'not_paired'

export interface Aimed {
  /** Every display that was asked for, in the order they were found. */
  asked: Doc<'displays'>[]
  /** The displays it goes to. */
  to: Doc<'displays'>[]
  /** Each display that was asked for and that it does not go to, with why. */
  notShown: { display: string; displayId: Id<'displays'>; reason: Reason }[]
}

export const nameOf = (d: Doc<'displays'>): string => d.name ?? d.generatedName

/**
 * Whether the browser a display is still holds the session it registered under. A display's
 * record stays when that session ends, so that the browser is the same display once it is
 * paired again. Until it is, the display shows nothing, and is said to be not paired wherever
 * displays are listed.
 */
export async function stillPaired(ctx: Ctx, d: Doc<'displays'>): Promise<boolean> {
  const session = await ctx.db.get(d.sessionId)
  return session !== null && session.endedAt === undefined
}

/**
 * What a call names as where it goes, from its arguments. A display is named by its name or by
 * its id, never by both: a call that gave both would have to choose which it meant.
 */
export function targetOf(args: { display?: string; displayId?: string }): Target {
  if (args.display !== undefined && args.displayId !== undefined) fail('invalid', 'Name a display by its name or by its id, not both.')
  if (args.displayId !== undefined) return { id: args.displayId }
  if (args.display?.trim()) return { name: args.display }
  return { none: true }
}

/**
 * The display of this person that an id names, or nothing. An id that is not a display's id at
 * all is no display, and so is a display of someone else's, which is answered exactly as one
 * that is not there: what the backend's log says of it is that it was asked.
 */
async function byId(ctx: Ctx, userId: Id<'users'>, raw: string): Promise<Doc<'displays'> | null> {
  const id = ctx.db.normalizeId('displays', raw)
  const d = id ? await ctx.db.get(id) : null
  if (d && d.userId !== userId) log('access.denied', { userId, what: 'display', id: d._id }, 'warn')
  return d && d.userId === userId ? d : null
}

/**
 * The displays something an agent sends goes to, and each display it was asked onto and does not
 * go to, with why. A display that no name or id names is refused, without the name or the id: a
 * refusal is kept in the backend's own record of what failed, and a display's name is the
 * person's. The machine that asked knows what it asked, and reads the displays with `it displays`.
 */
export async function aim(ctx: Ctx, userId: Id<'users'>, target: Target): Promise<Aimed> {
  let asked: Doc<'displays'>[]
  if ('id' in target) {
    const d = await byId(ctx, userId, target.id)
    if (!d) fail('not_found', 'No display has that id.', { noSuchDisplay: true })
    asked = [d]
  } else {
    const all = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(QUOTA.displays)
    if ('name' in target) {
      const wanted = target.name.trim().toLowerCase()
      asked = all.filter((d) => nameOf(d).toLowerCase() === wanted)
      if (asked.length === 0) fail('not_found', 'No display has that name.', { noSuchDisplay: true })
    } else asked = all
  }
  const to: Doc<'displays'>[] = []
  const notShown: Aimed['notShown'] = []
  for (const d of asked) {
    if (await stillPaired(ctx, d)) to.push(d)
    else notShown.push({ display: nameOf(d), displayId: d._id, reason: 'not_paired' })
  }
  return { asked, to, notShown }
}
