import { parseJson, TOUR } from '@it/protocol'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { write } from '../state'
import { artifactBySlug } from './authz'

/** Once a page has been checked, only its mark gives the tour ownership. */
export const isTourPage = (page: Doc<'artifacts'>, name: string): boolean => page.slug === `${TOUR.prefix}${name}` && page.tour?.name === name

/** JSON object order is immaterial, but every key and value must match, including nested ones. */
function sameState(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => sameState(value, b[i]))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(b)) return false
  const other = new Map<string, unknown>(Object.entries(b))
  return Object.keys(a).length === other.size && Object.entries(a).every(([key, value]) => other.has(key) && sameState(value, other.get(key)))
}

/**
 * Old programs left no mark. Those pages may join the tour once, only when
 * their id, title and entire state still match what the tour is publishing. Null records a
 * page already handled by a current program, so taking it over cannot make it eligible again.
 * The mark is written with the upload's version and state snapshot in the begin transaction.
 */
export async function adoptTourPage(ctx: MutationCtx, page: Doc<'artifacts'>, name: string, title: string, json: string): Promise<Doc<'artifacts'> | null> {
  if (page.tour !== undefined || page.slug !== `${TOUR.prefix}${name}` || page.title !== title || page.currentVersion === undefined) return null
  const state = await pageState(ctx, page._id)
  if (!state || !sameState(parseJson(state.json), parseJson(json))) return null
  const tour = { name, identity: crypto.randomUUID() }
  await ctx.db.patch(page._id, { tour })
  return { ...page, tour }
}

export function seenIn(state: unknown): string[] {
  const seen = state !== null && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>).seen : undefined
  return Array.isArray(seen)
    ? [...new Set(seen.filter((name): name is string => typeof name === 'string' && (TOUR.steps as readonly string[]).includes(name)))]
    : []
}

export const pageState = (ctx: QueryCtx, artifactId: Id<'artifacts'>) =>
  ctx.db
    .query('states')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .unique()

export async function progress(ctx: QueryCtx, userId: Id<'users'>): Promise<string[]> {
  const menu = await artifactBySlug(ctx, userId, `${TOUR.prefix}${TOUR.menu}`)
  if (!menu || !isTourPage(menu, TOUR.menu)) return []
  const state = await pageState(ctx, menu._id)
  return seenIn(state ? parseJson(state.json) : undefined)
}

/** Resets the step and merges progress while the publication still owns the transaction. */
export async function startTourPage(ctx: MutationCtx, page: Doc<'artifacts'>, name: string, json: string): Promise<void> {
  const fresh = parseJson(json) as Record<string, unknown>
  await write(ctx, page.userId, page._id, (current) => (name === TOUR.menu ? { ...fresh, seen: seenIn(current) } : fresh))
  if (!(TOUR.steps as readonly string[]).includes(name)) return
  const menu = await artifactBySlug(ctx, page.userId, `${TOUR.prefix}${TOUR.menu}`)
  if (!menu || !isTourPage(menu, TOUR.menu)) return
  await write(ctx, page.userId, menu._id, (current) => ({ ...current, seen: [...new Set([...seenIn(current), name])] }))
}
