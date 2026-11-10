// Which displays an agent's page or notification goes to. Every way an agent puts something on a
// screen comes through `aim`, so that a display is addressed the same way by `it open`, by
// `--open` on `it create` and `it update`, by the tour, and by `it notify`.
//
// A display named by its id goes to that display, a name to every display of that name, and
// `everywhere` to every display agents may use. With none named it goes to the one display the
// person is most likely using: never to every display at once, which is what a person with a
// laptop, a phone and a TV paired does not want each time an agent shows them something.
import { QUOTA } from '@it/protocol'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { fail } from './errors'
import { log } from './log'

type Ctx = QueryCtx | MutationCtx

/** How an agent names where something goes: one display by its id, every display of a name, every display, or none. */
export type Target = { id: string } | { name: string } | { everywhere: true } | { none: true }

/**
 * Why something was not put on a display: its browser's pairing has ended, the person said that
 * agents may not use it, it is locked to another page, or, where no display was named, another
 * display was chosen.
 */
export type Reason = 'not_paired' | 'agents_off' | 'locked' | 'not_chosen'

export interface Aimed {
  /** Every display that was asked for, in the order they were found: for `none` and `everywhere`, every display. */
  asked: Doc<'displays'>[]
  /** The displays it goes to. */
  to: Doc<'displays'>[]
  /** Each display that was asked for and that it does not go to, with why. */
  notShown: { display: string; displayId: Id<'displays'>; reason: Reason }[]
  /**
   * Where no display was named and one was chosen: `open` where it had the site open and
   * visible, and `last_used` where none did and it was the one the person used last.
   */
  chosen?: 'open' | 'last_used'
}

export const nameOf = (d: Doc<'displays'>): string => d.name ?? d.generatedName

/**
 * How long what a display said of itself stands: what a tab said of itself (`displays.report`),
 * and the heartbeat of a site that says nothing of its tabs. A visible tab says so every minute.
 */
export const OPEN_MS = 150_000

/** What a display last said of itself as it was used: what each of its tabs said, and when the person last used it. */
export interface Seen {
  reports: NonNullable<Doc<'presence'>['reports']>
  usedAt?: number
}
/**
 * What a display last said of itself, from its own record of that (`presence`), which is kept
 * apart from the display's so that a report does not change what reads the display. Where there
 * is none yet, what an earlier build kept on the display, and when it was registered.
 */
export async function seenOf(ctx: Ctx, d: Doc<'displays'>): Promise<Seen> {
  const p = await ctx.db
    .query('presence')
    .withIndex('by_display', (q) => q.eq('displayId', d._id))
    .unique()
  return { reports: p?.reports ?? d.reports ?? [], usedAt: p?.usedAt ?? d.usedAt }
}

/**
 * Whether the site is open and visible on a display now, as far as what it last said tells.
 *
 * Open where any tab has said within the last two and a half minutes that it is visible. Where no
 * tab says so, the heartbeat stands in, which every site sends each minute while it is visible,
 * an earlier site among them, which says nothing of its tabs: the display is open if it was heard
 * within that time and since the last tab said it was hidden. So a tab that is hidden counts as
 * hidden at once, while a tab of an earlier site that goes on beating, beside a newer tab that was
 * hidden, counts as open again with its next heartbeat that is written down, within a minute.
 */
export function openNow(d: Doc<'displays'>, seen: Seen, now: number): boolean {
  const fresh = seen.reports.filter((r) => r.epoch === d.epoch && now - r.at < OPEN_MS && r.at <= now)
  if (fresh.some((r) => r.visible)) return true
  const hiddenAt = fresh.reduce((latest, r) => Math.max(latest, r.at), 0)
  return now - d.lastSeenAt < OPEN_MS && d.lastSeenAt > hiddenAt
}

/**
 * The display the person is most likely using, of those given. One with the site open and visible
 * comes before one without, then the one they last clicked, tapped or typed on, and then the one
 * last seen open. With `pushed`, a display that takes notifications comes first among those that
 * are not open, since a notification reaches a closed display only that way.
 */
export function likeliest(displays: { d: Doc<'displays'>; seen: Seen }[], now: number, pushed = false): Doc<'displays'> | null {
  const rank = ({ d, seen }: { d: Doc<'displays'>; seen: Seen }): number[] => {
    const open = openNow(d, seen, now)
    return [open ? 1 : 0, !open && pushed && d.push ? 1 : 0, seen.usedAt ?? 0, d.lastSeenAt]
  }
  const ahead = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
    return false
  }
  let best: { d: Doc<'displays'>; rank: number[] } | null = null
  for (const one of displays) {
    const r = rank(one)
    if (!best || ahead(r, best.rank)) best = { d: one.d, rank: r }
  }
  return best?.d ?? null
}

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
 * What a call names as where it goes, from its arguments. A display is named by its name, by its
 * id, or every display at once, and never two of these: a call that gave two would have to choose
 * which it meant. A name is always a name, "all" too: every display is asked for with
 * `everywhere`, so that no display a person called "all" is ever taken for every one. A name of
 * only spaces is a name no display has, as an earlier It answered a notification sent to one,
 * and never a call that named no display: that would send it somewhere else than was asked.
 * Only a name left out, or empty, names none.
 */
export function targetOf(args: { display?: string; displayId?: string; everywhere?: boolean }): Target {
  const given = [args.display !== undefined, args.displayId !== undefined, args.everywhere === true].filter(Boolean).length
  if (given > 1) fail('invalid', 'Name a display by its name or by its id, or ask for every display, and only one of these.')
  if (args.everywhere === true) return { everywhere: true }
  if (args.displayId !== undefined) return { id: args.displayId }
  if (args.display) {
    if (!args.display.trim()) fail('not_found', 'No display has that name.', { noSuchDisplay: true })
    return { name: args.display }
  }
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
 *
 * `pushed` is for a notification, which reaches a display whose site is closed only as a push.
 * `page` is the page to be shown. A lock is about pages alone: a display locked to another page
 * does not show this one, and where no display is named, a locked display is never the one
 * chosen to show a page, its own page included, since it keeps to the page it has. A
 * notification has no page, and a lock is nothing to it: a locked display takes one sent to it
 * by name or id, or to every display, and is the display in use for one sent with none named,
 * as any other display is.
 */
export async function aim(ctx: Ctx, userId: Id<'users'>, target: Target, opts: { pushed?: boolean; page?: Id<'artifacts'> } = {}): Promise<Aimed> {
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
  const why = new Map<Id<'displays'>, Reason | null>()
  const none = 'none' in target
  const locked = (d: Doc<'displays'>) => d.lockedTo !== undefined && opts.page !== undefined && (none || d.lockedTo.artifactId !== opts.page)
  for (const d of asked) why.set(d._id, !(await stillPaired(ctx, d)) ? 'not_paired' : d.agentsOff ? 'agents_off' : locked(d) ? 'locked' : null)
  const left = (d: Doc<'displays'>, reason: Reason) => ({ display: nameOf(d), displayId: d._id, reason })
  if (!none)
    return {
      asked,
      to: asked.filter((d) => why.get(d._id) === null),
      notShown: asked.flatMap((d) => {
        const reason = why.get(d._id)
        return reason ? [left(d, reason)] : []
      }),
    }
  const now = Date.now()
  const able = []
  for (const d of asked) if (why.get(d._id) === null) able.push({ d, seen: await seenOf(ctx, d) })
  const chosen = likeliest(able, now, opts.pushed)
  const seen = able.find((x) => x.d === chosen)?.seen
  return {
    asked,
    to: chosen ? [chosen] : [],
    notShown: asked.filter((d) => d !== chosen).map((d) => left(d, why.get(d._id) ?? 'not_chosen')),
    ...(chosen && seen ? { chosen: openNow(chosen, seen, now) ? ('open' as const) : ('last_used' as const) } : {}),
  }
}
