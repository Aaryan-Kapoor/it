import { LIMITS, PROTOCOL_VERSION, parseJson, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { findDisplay, ownArtifact, requireBrowser, requireCaller } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { bump, tally } from './lib/tally'

/** Stores a click. Shared by the page's own actions and by a notification's buttons. */
export async function record(
  ctx: MutationCtx,
  artifact: Doc<'artifacts'>,
  input: {
    displayId?: Id<'displays'>
    clientActionId: string
    name: string
    /** JSON text. */
    payload: string
    contentVersion: number
    baseStateRevision?: number
    attended?: boolean
    /** The page's title as whoever is recording this knew it then, where they kept it: a notification's button knows the title its page had when it was sent. */
    title?: string
  },
): Promise<{ actionId: Id<'actions'>; duplicate: boolean }> {
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(input.clientActionId)) fail('invalid', 'That is not an action id.')
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(input.name))
    fail('invalid', `An action name is 1 to ${LIMITS.actionName} letters, digits, dots, colons, dashes or underscores.`)
  const bytes = new TextEncoder().encode(input.payload).length
  if (bytes > LIMITS.actionPayloadBytes) fail('limit', `An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB.`)
  if (parseJson(input.payload) === undefined) fail('invalid', 'What an action carries must be JSON.')
  // The same click sent twice, after a dropped connection, is one click. The id is the page's
  // own, so it only means something within that page.
  const again = await ctx.db
    .query('actions')
    .withIndex('by_artifact_client', (q) => q.eq('artifactId', artifact._id).eq('clientActionId', input.clientActionId))
    .first()
  if (again) return { actionId: again._id, duplicate: true }
  await rateLimit(ctx, 'submitActionPage', artifact._id)
  await rateLimit(ctx, 'submitAction', artifact.userId)
  await rateLimit(ctx, 'actionKilobytes', artifact.userId, Math.max(1, Math.ceil(bytes / 1024)))
  if ((artifact.waiting ?? 0) >= QUOTA.pendingActionsPerPage) {
    log('quota.reached', { what: 'actions waiting on a page', who: artifact._id, max: QUOTA.pendingActionsPerPage }, 'warn')
    fail('limit', 'Too many actions on this page are waiting for its agent.')
  }
  if ((await tally(ctx, artifact.userId)).waiting >= QUOTA.pendingActions) {
    log('quota.reached', { what: 'actions waiting', who: artifact.userId, max: QUOTA.pendingActions }, 'warn')
    fail('limit', 'Too many actions are waiting for your agents.')
  }
  // It goes to the machine that owns the page, unless that machine has been revoked: then it
  // waits where any of the person's machines can pick it up
  const to = await destination(ctx, artifact._id)
  // The title the page had at the version the person acted on is kept with the click: by the
  // time it is delivered the page may have another, and that version may be gone
  const title =
    input.title !== undefined
      ? input.title
      : input.contentVersion === artifact.currentVersion
        ? artifact.title
        : // A version that is not kept any more: its title is not known, and the page's present one is not put in its place
          ((
            await ctx.db
              .query('versions')
              .withIndex('by_artifact_n', (q) => q.eq('artifactId', artifact._id).eq('n', input.contentVersion))
              .first()
          )?.title ?? '')
  const actionId = await ctx.db.insert('actions', {
    userId: artifact.userId,
    artifactId: artifact._id,
    displayId: input.displayId,
    clientActionId: input.clientActionId,
    name: input.name,
    payload: input.payload,
    contentVersion: input.contentVersion,
    baseStateRevision: input.baseStateRevision,
    title,
    attended: input.attended,
    createdAt: Date.now(),
    delivery: 'pending',
    ...to,
  })
  await ctx.db.patch(artifact._id, { waiting: (artifact.waiting ?? 0) + 1 })
  await bump(ctx, artifact.userId, { waiting: 1 })
  return { actionId, duplicate: false }
}

/** A click stops counting as waiting: it was handed to an agent, or removed. */
export async function noLongerWaiting(ctx: MutationCtx, x: Doc<'actions'>): Promise<void> {
  const artifact = await ctx.db.get(x.artifactId)
  // A page that has been deleted already gave back everything that was waiting on it
  if (!artifact) return
  await ctx.db.patch(artifact._id, { waiting: Math.max(0, (artifact.waiting ?? 0) - 1) })
  if (await ctx.db.get(x.userId)) await bump(ctx, x.userId, { waiting: -1 })
}

/**
 * Whether the person stopped the conversation a click is for after the click was made. Such a
 * click is delivered by no way at all from that moment, though the step that marks it so may
 * not have come to it yet: a stop drops what was waiting in steps, and what a step has not
 * reached must not be taken, or moved out of its reach, in between.
 *
 * A stop is noted with the machine the conversation ran on. It is looked for under the
 * conversation the click is addressed to as it stands, and under the one its page belongs to
 * now: a page that has changed hands since takes its waiting clicks along a step at a time,
 * and one made before the stop is stopped whichever of the two it is found under.
 */
export async function stoppedSince(ctx: QueryCtx, x: Doc<'actions'>): Promise<boolean> {
  const noted = async (machineId: Id<'machines'> | undefined, harness: string | undefined, sessionId: string | undefined) => {
    if (!machineId || !harness || !sessionId) return false
    const machine = await ctx.db.get(machineId)
    return (machine?.stops ?? []).some((s) => s.harness === harness && s.sessionId === sessionId && s.at >= x.createdAt)
  }
  // The page itself keeps when it was last stopped from, which stands whoever it belongs to by now
  const page = await ctx.db.get(x.artifactId)
  if ((page?.stoppedThrough ?? 0) >= x.createdAt) return true
  if (await noted(x.machineId ?? x.parkedBy, x.harness, x.sessionId)) return true
  return noted(page?.machineId, page?.session?.harness, page?.session?.id)
}
/** Marks a click as stopped with its conversation, as the stop itself does for what it reaches: handed over to nobody, and waiting no more. */
export async function dropStopped(ctx: MutationCtx, x: Doc<'actions'>): Promise<void> {
  await ctx.db.patch(x._id, {
    delivery: 'handed_off',
    route: 'stopped',
    handedAt: Date.now(),
    outcome: 'failed',
    leaseMachineId: undefined,
    leaseExpiresAt: undefined,
  })
  await noLongerWaiting(ctx, x)
}

/** Where a click on a page should go now: the machine and conversation that own the page at this moment. */
export async function destination(ctx: QueryCtx, artifactId: Id<'artifacts'>) {
  const artifact = await ctx.db.get(artifactId)
  const owner = artifact?.machineId ? await ctx.db.get(artifact.machineId) : null
  return { machineId: owner && !owner.revoked ? owner._id : undefined, harness: artifact?.session?.harness, sessionId: artifact?.session?.id }
}

/**
 * A page changed hands (its machine was revoked, or another conversation took it over). The
 * clicks already waiting on it go where the page went, a batch at a time, so they are offered
 * to the conversation that now owns the page and not left addressed to one that will never ask.
 */
export const readdress = internalMutation({
  args: { artifactId: v.id('artifacts'), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { artifactId, cursor }) => {
    if (!(await ctx.db.get(artifactId))) return null
    const to = await destination(ctx, artifactId)
    // The database's own paging, which never skips a record, however many share a moment.
    // Clicks that are out on a lease are sent on their way when the lease ends (see delivery.ts).
    const batch = await ctx.db
      .query('actions')
      .withIndex('by_artifact_delivery', (q) => q.eq('artifactId', artifactId).eq('delivery', 'pending'))
      .paginate({ cursor: cursor ?? null, numItems: 50 })
    for (const x of batch.page) {
      // Stopped with the conversation it was waiting for, before the page changed hands: it
      // is marked so here, and not carried over to a conversation the stop was never about
      if (await stoppedSince(ctx, x)) {
        await dropStopped(ctx, x)
        continue
      }
      // A click its old machine had set aside is the new owner's to try afresh
      // A click set aside for the very conversation that still owns the page stays so. One set
      // aside for an earlier owner, on another machine or the same one, is the new owner's to try.
      const aside = x.parkedBy !== undefined && x.parkedBy === to.machineId && x.harness === to.harness && x.sessionId === to.sessionId
      if (!aside && (x.machineId !== to.machineId || x.harness !== to.harness || x.sessionId !== to.sessionId || x.parkedBy))
        await ctx.db.patch(x._id, { ...to, parkedBy: undefined })
    }
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId, cursor: batch.continueCursor })
    return null
  },
})

/** A person acted on a page. The site sends this on the page's behalf, as the browser it is paired as. */
export const submit = mutation({
  args: {
    artifactId: v.id('artifacts'),
    displayKey: v.string(),
    envelope: v.object({
      v: v.number(),
      clientActionId: v.string(),
      name: v.string(),
      /** JSON text: a page may use any keys it likes. */
      payload: v.string(),
      contentVersion: v.number(),
      baseStateRevision: v.optional(v.number()),
      attended: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { artifactId, displayKey, envelope }) => {
    const c = await requireBrowser(ctx)
    if (envelope.v !== PROTOCOL_VERSION) fail('invalid', 'This page speaks a version of the protocol the site does not.')
    const artifact = await ownArtifact(ctx, c.user._id, artifactId)
    // Which display it was made on is noted when that display is registered. A click is the
    // person's own whether or not it is: a display's record can be let go to make room while
    // its tab sleeps, and what the person did there before must not be lost for that.
    const display = await findDisplay(ctx, c, displayKey)
    const { actionId } = await record(ctx, artifact, { ...envelope, ...(display ? { displayId: display._id } : {}) })
    return { actionId }
  },
})

/** What became of the recent clicks on a page: accepted, handed to the agent, done. */
export const forArtifact = query({
  args: ref,
  handler: async (ctx, args) => {
    const c = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, c.user._id, args)
    const recent = await ctx.db
      .query('actions')
      .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
      .order('desc')
      .take(30)
    return recent.map((x) => ({
      id: x._id,
      name: x.name,
      at: x.createdAt,
      delivery: x.delivery,
      route: x.route ?? null,
      outcome: x.outcome ?? null,
      attended: x.attended ?? null,
      // What a click carried is for the agent; the site only needs to show where it got to
      ...(c.kind === 'machine' ? { payload: x.payload } : {}),
    }))
  },
})
