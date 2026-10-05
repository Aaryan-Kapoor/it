import { deepMerge, isStoreKey, LIMITS, parseJson, STORE_KEY } from '@it/protocol'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { ownArtifact, requireBrowser, requireCaller, requireMachine } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'

type State = Record<string, unknown>
const isObject = (x: unknown): x is State => typeof x === 'object' && x !== null && !Array.isArray(x)

/** A page's state, as JSON text, and its revision. The site forwards this into the page's frame. */
export const get = query({
  args: ref,
  handler: async (ctx, args) => {
    const { user } = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, user._id, args)
    const s = await ctx.db
      .query('states')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .unique()
    return { json: s?.json ?? '{}', revision: s?.revision ?? 0 }
  },
})

async function write(
  ctx: MutationCtx,
  userId: Id<'users'>,
  artifactId: Id<'artifacts'>,
  next: (current: State) => unknown,
  baseRevision?: number,
  by: 'agent' | 'page' = 'agent',
) {
  const s = await ctx.db
    .query('states')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .unique()
  if (baseRevision !== undefined && baseRevision !== (s?.revision ?? 0)) {
    fail('conflict', 'The state changed since you read it.', { revision: s?.revision ?? 0 })
  }
  const current = s ? parseJson(s.json) : {}
  const after = next(isObject(current) ? current : {})
  const json = JSON.stringify(isObject(after) ? after : {})
  const bytes = new TextEncoder().encode(json).length
  if (bytes > LIMITS.stateBytes) fail('limit', `A page's state is at most ${LIMITS.stateBytes / 1024} KB.`)
  // Counted by size as well as by number: a large state written over and over is refused
  const kilobytes = Math.ceil(bytes / 1024)
  // An agent's writes and a page's own are counted apart: a page that saves on every keystroke
  // uses up what pages may write, and never what its agent may
  await rateLimit(ctx, by === 'page' ? 'storeKilobytesPage' : 'stateKilobytesPage', artifactId, kilobytes)
  await rateLimit(ctx, by === 'page' ? 'storeKilobytes' : 'stateKilobytes', userId, kilobytes)
  const revision = (s?.revision ?? 0) + 1
  if (s) await ctx.db.patch(s._id, { json, revision })
  else await ctx.db.insert('states', { artifactId, userId, json, revision })
  await noteRevision(ctx, artifactId, revision)
  return { revision }
}

/** Keeps the small record of which revision a page's state is at beside the state itself. */
export async function noteRevision(ctx: MutationCtx, artifactId: Id<'artifacts'>, revision: number): Promise<void> {
  const r = await ctx.db
    .query('revisions')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .unique()
  if (r) await ctx.db.patch(r._id, { revision })
  else await ctx.db.insert('revisions', { artifactId, revision })
}
/**
 * The revision a page's state is at, read from the small record of it and without reading the
 * state. A page with no state at all is at revision 0, which is where the script in a page
 * starts counting too.
 */
export async function revisionNow(ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>): Promise<number> {
  return (
    (
      await ctx.db
        .query('revisions')
        .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
        .unique()
    )?.revision ?? 0
  )
}

/** An agent changes a page's state: a merge by default, a replacement when asked. Never republishes anything. */
export const patch = mutation({
  args: { slug: v.string(), /** JSON text of an object. */ patch: v.string(), replace: v.optional(v.boolean()), baseRevision: v.optional(v.number()) },
  handler: async (ctx, { slug, patch, replace, baseRevision }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolveArtifact(ctx, user._id, { slug })
    if (patch.length > LIMITS.stateBytes * 2) fail('limit', 'That patch is too large.')
    const change = parseJson(patch)
    if (!isObject(change)) fail('invalid', 'A patch is a JSON object.')
    return write(ctx, user._id, a._id, (current) => (replace ? change : deepMerge(current, change)), baseRevision)
  },
})

/** The page keeps something of its own (It.store). It can only write under one reserved key. */
export const storeSet = mutation({
  args: { artifactId: v.id('artifacts'), key: v.string(), /** JSON text. */ value: v.string() },
  handler: async (ctx, { artifactId, key, value }) => {
    const { user } = await requireBrowser(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    await rateLimit(ctx, 'storeSetPage', a._id)
    await rateLimit(ctx, 'storeSet', user._id)
    if (!isStoreKey(key)) fail('invalid', 'A store key is 1 to 64 letters, digits, dashes or underscores.')
    if (new TextEncoder().encode(value).length > LIMITS.storeValueBytes) fail('limit', `A stored value is at most ${LIMITS.storeValueBytes / 1024} KB.`)
    const parsed = parseJson(value)
    if (parsed === undefined) fail('invalid', 'A stored value must be JSON.')
    // The value replaces whatever was under the key; null removes it
    return write(
      ctx,
      user._id,
      a._id,
      (current) => {
        // Built entry by entry, so that no name a page chooses can be anything but a plain entry
        const own = new Map(Object.entries(isObject(current[STORE_KEY]) ? (current[STORE_KEY] as State) : {}))
        if (parsed === null) own.delete(key)
        else own.set(key, parsed)
        return { ...current, [STORE_KEY]: Object.fromEntries(own) }
      },
      undefined,
      'page',
    )
  },
})
