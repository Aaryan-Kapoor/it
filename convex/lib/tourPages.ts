import { parseJson, TOUR } from '@it/protocol'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { write } from '../state'
import { artifactBySlug } from './authz'

/** A title, slug or state never proves that the tour made a page. */
export const isTourPage = (page: Doc<'artifacts'>, name: string): boolean => page.slug === `${TOUR.prefix}${name}` && page.tour?.name === name

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
