// Which displays an agent's page or notification goes to. A display named goes to that display,
// "all" to every display, and nothing named to the one display the person is most likely
// looking at: never to every display at once, which is what a person with a laptop, a phone and
// a TV paired does not want each time an agent shows them something.
import { QUOTA } from '@it/protocol'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { fail } from './errors'

/**
 * A display that said it was visible within this long is taken to have the site open now. The
 * site says so every minute while it is visible, and at once when it is hidden.
 */
export const OPEN_MS = 150_000
/** What an agent names to have something put on every display at once. No display may be called this. */
export const EVERY_DISPLAY = 'all'

/**
 * Why something was not put on a display: its browser's pairing has ended, the person said that
 * agents may not use it, or another display was chosen for it when the agent named none.
 */
export type NotShownReason = 'not_paired' | 'agents_off' | 'not_chosen'

export interface Aimed {
  to: Doc<'displays'>[]
  notShown: { display: string; reason: NotShownReason }[]
  /**
   * Where the agent named no display and one was chosen: `open` where it had the site open and
   * visible, and `last_used` where no display did and it was the one the person used last.
   */
  chosen?: 'open' | 'last_used'
}

export const nameOf = (d: Doc<'displays'>): string => d.name ?? d.generatedName

/** Whether the site is open and visible on a display now, as far as what it last said tells. */
export const openNow = (d: Doc<'displays'>, now: number): boolean => d.hidden !== true && now - d.lastSeenAt < OPEN_MS

/**
 * The display the person is most likely looking at, of those given. One with the site open and
 * visible comes before one without, then the one they last clicked, tapped or typed on, and then
 * the one last seen open. With `pushed`, a display that takes notifications comes first among
 * those that are not open, since a notification reaches a closed display only that way.
 */
export function likeliest(displays: Doc<'displays'>[], now: number, pushed = false): Doc<'displays'> | null {
  const rank = (d: Doc<'displays'>): number[] => {
    const open = openNow(d, now)
    return [open ? 1 : 0, !open && pushed && d.push ? 1 : 0, d.usedAt ?? 0, d.lastSeenAt]
  }
  const ahead = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
    return false
  }
  let best: { d: Doc<'displays'>; rank: number[] } | null = null
  for (const d of displays) {
    const r = rank(d)
    if (!best || ahead(r, best.rank)) best = { d, rank: r }
  }
  return best?.d ?? null
}

/**
 * Whether the browser a display is still holds the session it registered under. A display's
 * record stays when that session ends, so that the browser is the same display once it is
 * paired again. Until it is, the display shows nothing.
 */
export async function stillPaired(ctx: QueryCtx | MutationCtx, d: Doc<'displays'>): Promise<boolean> {
  const session = await ctx.db.get(d.sessionId)
  return session !== null && session.endedAt === undefined
}

/**
 * The displays something an agent sends goes to, and each display it does not go to with why.
 * `display` is the name the agent gave, `all` for every display, or nothing for the one the
 * person is most likely looking at. A name no display has is refused, without the name: a
 * refusal is kept in the backend's own record of what failed, and a display's name is the
 * person's. The machine that asked knows what it asked, and reads the names with `it displays`.
 */
export async function aim(ctx: QueryCtx | MutationCtx, userId: Id<'users'>, display: string | undefined, pushed = false): Promise<Aimed> {
  const all = await ctx.db
    .query('displays')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(QUOTA.displays)
  const away = new Map<Id<'displays'>, NotShownReason | null>()
  for (const d of all) away.set(d._id, !(await stillPaired(ctx, d)) ? 'not_paired' : d.agentsOff ? 'agents_off' : null)
  const wanted = display?.trim().toLowerCase()
  if (wanted) {
    const asked = wanted === EVERY_DISPLAY ? all : all.filter((d) => nameOf(d).toLowerCase() === wanted)
    if (wanted !== EVERY_DISPLAY && asked.length === 0) fail('not_found', 'No display has that name.', { noSuchDisplay: true })
    return {
      to: asked.filter((d) => away.get(d._id) === null),
      notShown: asked.flatMap((d) => {
        const reason = away.get(d._id)
        return reason ? [{ display: nameOf(d), reason }] : []
      }),
    }
  }
  const now = Date.now()
  const chosen = likeliest(
    all.filter((d) => away.get(d._id) === null),
    now,
    pushed,
  )
  return {
    to: chosen ? [chosen] : [],
    notShown: all.filter((d) => d !== chosen).map((d) => ({ display: nameOf(d), reason: away.get(d._id) ?? 'not_chosen' })),
    ...(chosen ? { chosen: openNow(chosen, now) ? ('open' as const) : ('last_used' as const) } : {}),
  }
}
