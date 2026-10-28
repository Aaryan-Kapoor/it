import { LIMITS, MESSAGE, PROTOCOL_VERSION, parseJson, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { type Browser, findDisplay, ownArtifact, requireBrowser, requireCaller } from './lib/authz'
import { counted } from './lib/counted'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { bump, nextSequence, tally } from './lib/tally'

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
    /** Typed by a person in the site's own box above the page, which only the function for that box says. */
    typed?: boolean
    /** The files it carries beside its data, taken for this very click before it was sent (files.ts). */
    attachment?: Id<'attachments'>
  },
): Promise<{ actionId: Id<'actions'>; duplicate: boolean }> {
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(input.clientActionId)) fail('invalid', 'That is not an action id.')
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(input.name))
    fail('invalid', `An action name is 1 to ${LIMITS.actionName} letters, digits, dots, colons, dashes or underscores.`)
  // The name what a person typed above a page is kept under is the site's own. A page that
  // sends an action of that name is refused: its agent would read the page's words as the person's
  if (input.name === MESSAGE && !input.typed) fail('invalid', `A page may not send an action named ${MESSAGE}.`)
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
  // Its files were taken for this click on this page, and are all there whole: an agent is never
  // told of a file that has not arrived. Where they have not all arrived yet the click is sent
  // again, and its files with it, once they have
  const attachment = input.attachment ? await ctx.db.get(input.attachment) : null
  if (input.attachment) {
    if (!attachment || attachment.artifactId !== artifact._id || attachment.clientActionId !== input.clientActionId || attachment.actionId)
      fail('invalid', 'Those files were not sent with this action.')
    if (!attachment.stored) fail('unavailable', 'The files of this action have not all arrived yet.')
    // The list of its files is kept with what it carries, and counted in it, so that a click's
    // record is never more than the most a click may come to
    if (bytes + new TextEncoder().encode(JSON.stringify(attachment.files)).length > LIMITS.actionPayloadBytes)
      fail('limit', `An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB, with the names of its files counted in.`)
  }
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
    // Its place among the person's clicks and stops, taken as it is written: what tells whether a stop came before it or after
    sequence: await nextSequence(ctx, artifact.userId),
    delivery: 'pending',
    ...to,
    ...(attachment ? { attachment: attachment._id, files: attachment.files } : {}),
  })
  if (attachment) await ctx.db.patch(attachment._id, { actionId })
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
 * Whether a click was made up to a stop, in the order the person's clicks and stops are written
 * in, which no clock that is set back can change. A stop with a number in that order is judged
 * by number alone, and comes after every click without one: those were all made before clicks
 * and stops had numbers. A stop without one was made then too, and is judged by the clock, as
 * it always was, against the clicks of that time: every click with a number came after it.
 */
export function madeBefore(x: Pick<Doc<'actions'>, 'sequence' | 'createdAt'>, stop: { at?: number; sequence?: number }): boolean {
  if (stop.sequence !== undefined) return x.sequence === undefined || x.sequence <= stop.sequence
  return x.sequence === undefined && stop.at !== undefined && x.createdAt <= stop.at
}

/**
 * The stop a click was made before, where the person stopped the conversation it is for after
 * the click was made: the earliest of those that are known, by its number where it has one.
 * Such a click is delivered by no way at all from that moment, though the step that marks it
 * so may not have come to it yet: a stop drops what was waiting in steps, and what a step has
 * not reached must not be taken, or moved out of its reach, in between.
 *
 * A stop is noted with the machine the conversation ran on. It is looked for under the
 * conversation the click is addressed to as it stands, and under the one its page belongs to
 * now: a page that has changed hands since takes its waiting clicks along a step at a time,
 * and one made before the stop is stopped whichever of the two it is found under.
 */
export async function stoppedBy(ctx: QueryCtx, x: Doc<'actions'>, seen?: Seen): Promise<{ sequence?: number } | null> {
  const found: { sequence?: number }[] = []
  const get = async (id: Id<'machines'> | Id<'artifacts'>) => {
    if (!seen) return ctx.db.get(id)
    if (!seen.has(id)) seen.set(id, await ctx.db.get(id))
    return seen.get(id) ?? null
  }
  const noted = async (machineId: Id<'machines'> | undefined, harness: string | undefined, sessionId: string | undefined) => {
    if (!machineId || !harness || !sessionId) return
    const machine = (await get(machineId)) as Doc<'machines'> | null
    for (const s of machine?.stops ?? []) if (s.harness === harness && s.sessionId === sessionId && madeBefore(x, s)) found.push(s)
  }
  // The page itself keeps when it was last stopped from, which stands whoever it belongs to by now
  const page = (await get(x.artifactId)) as Doc<'artifacts'> | null
  if (page && madeBefore(x, { at: page.stoppedThrough, sequence: page.stoppedSequence })) found.push({ sequence: page.stoppedSequence })
  await noted(x.machineId ?? x.parkedBy, x.harness, x.sessionId)
  await noted(page?.machineId, page?.session?.harness, page?.session?.id)
  if (!found.length) return null
  const numbered = found.flatMap((s) => (s.sequence === undefined ? [] : [s.sequence]))
  return numbered.length ? { sequence: Math.min(...numbered) } : {}
}
/** The pages and machines a query has read already, by their ids: one that reads many clicks counts each record once against what it may read. */
export type Seen = Map<string, Doc<'machines'> | Doc<'artifacts'> | null>
export async function stoppedSince(ctx: QueryCtx, x: Doc<'actions'>, seen?: Seen): Promise<boolean> {
  return (await stoppedBy(ctx, x, seen)) !== null
}
/** Marks a click as stopped with its conversation, as the stop itself does for what it reaches: handed over to nobody, and waiting no more. */
export async function dropStopped(ctx: MutationCtx, x: Doc<'actions'>): Promise<void> {
  await ctx.db.patch(x._id, {
    delivery: 'handed_off',
    route: 'stopped',
    // Which stop it went with, so that the page can say how many went with that one
    stoppedSequence: (await stoppedBy(ctx, x))?.sequence,
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

const DAY = 86_400_000
/** Each browser may replay a saved request until a deadline issued by the backend. */
export const replayGrant = mutation({
  args: {},
  handler: async (ctx) => {
    const c = await requireBrowser(ctx)
    const now = Date.now()
    const until = Math.floor(now / DAY) * DAY + 7 * DAY
    const kept = (c.session.replayUntil ?? []).filter((at) => at > now)
    if (!kept.includes(until)) await ctx.db.patch(c.session._id, { replayUntil: [...kept, until] })
    return { until }
  },
})
/**
 * A deadline is fixed before dispatch and checked against server time. Handled actions remain
 * for seven days after acceptance, so their receipt cannot disappear while a grant is valid.
 * Old clients have no grant: an existing receipt can be confirmed, but an unknown old id
 * cannot safely be accepted because its previous receipt may already have expired.
 */
export async function replayAllowed(ctx: MutationCtx, c: Browser, artifactId: Id<'artifacts'>, clientActionId: string, until?: number) {
  const existing = await ctx.db
    .query('actions')
    .withIndex('by_artifact_client', (q) => q.eq('artifactId', artifactId).eq('clientActionId', clientActionId))
    .first()
  if (existing) return
  if (until === undefined)
    fail(
      'conflict',
      'Reload It before sending new requests. This saved request has no replay deadline. Check what your agent received before sending it again.',
      { reload: true },
    )
  if (until <= Date.now() || !(c.session.replayUntil ?? []).includes(until))
    fail('conflict', 'This saved request is too old to retry safely. Check what your agent received before sending it again.')
}

/** A person acted on a page. The site sends this on the page's behalf, as the browser it is paired as. */
export const submit = mutation({
  args: {
    artifactId: v.id('artifacts'),
    displayKey: v.string(),
    replayUntil: v.optional(v.number()),
    expectedSession: v.optional(v.string()),
    /** The files the action carries beside its data, taken for it beforehand (files.ts). */
    attachment: v.optional(v.id('attachments')),
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
  handler: async (ctx, { artifactId, displayKey, envelope, replayUntil, expectedSession, attachment }) => {
    const c = await requireBrowser(ctx, expectedSession)
    if (envelope.v !== PROTOCOL_VERSION) fail('invalid', 'This page speaks a version of the protocol the site does not.')
    const artifact = await ownArtifact(ctx, c.user._id, artifactId)
    // Which display it was made on is noted when that display is registered. A click is the
    // person's own whether or not it is: a display's record can be let go to make room while
    // its tab sleeps, and what the person did there before must not be lost for that.
    await replayAllowed(ctx, c, artifactId, envelope.clientActionId, replayUntil)
    const display = await findDisplay(ctx, c, displayKey)
    const { actionId, duplicate } = await record(ctx, artifact, {
      ...envelope,
      ...(display ? { displayId: display._id } : {}),
      ...(attachment ? { attachment } : {}),
    })
    // Counted: that something was sent from a page, and from what kind of screen. Never its name or what it carried
    if (!duplicate) await counted(ctx, 'answer.sent', { screen: display?.screen ?? 'computer', from: 'page' })
    return { actionId }
  },
})

/**
 * A person typed something to a page's agent, in the box the site has above the page. It is
 * kept and delivered as anything done on the page is, under a name of the site's own, so that
 * its agent is told it as the person's words. Nothing in a page can call this: a page has no
 * session of the browser's, and reaches It only through what the site sends for it.
 */
export const message = mutation({
  args: {
    artifactId: v.id('artifacts'),
    displayKey: v.string(),
    clientActionId: v.string(),
    text: v.string(),
    replayUntil: v.optional(v.number()),
    expectedSession: v.optional(v.string()),
  },
  handler: async (ctx, { artifactId, displayKey, clientActionId, text, replayUntil, expectedSession }) => {
    const c = await requireBrowser(ctx, expectedSession)
    const artifact = await ownArtifact(ctx, c.user._id, artifactId)
    const typed = text.trim()
    if (!typed) fail('invalid', 'There is nothing to send.')
    if (typed.length > LIMITS.messageText) fail('limit', `A message is at most ${LIMITS.messageText} characters.`)
    if (artifact.currentVersion === undefined) fail('invalid', 'This page has nothing published yet.')
    await replayAllowed(ctx, c, artifactId, clientActionId, replayUntil)
    const display = await findDisplay(ctx, c, displayKey)
    const { actionId, duplicate } = await record(ctx, artifact, {
      ...(display ? { displayId: display._id } : {}),
      clientActionId,
      name: MESSAGE,
      payload: JSON.stringify({ text: typed }),
      contentVersion: artifact.currentVersion,
      // Typed on the site itself, where no page's script can type
      attended: true,
      typed: true,
    })
    // Counted: that something was typed to an agent above a page, and from what kind of screen. Never the words
    if (!duplicate) await counted(ctx, 'answer.sent', { screen: display?.screen ?? 'computer', from: 'message' })
    return { actionId }
  },
})

/** What became of the recent clicks on a page: accepted, handed to the agent, done. */
export const forArtifact = query({
  args: ref,
  handler: async (ctx, args) => {
    const c = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, c.user._id, args)
    // The latest by the order they were written in, which a clock that was set back does not change
    const recent = await ctx.db
      .query('actions')
      .withIndex('by_artifact_sequence', (q) => q.eq('artifactId', a._id))
      .order('desc')
      .take(30)
    return recent.map((x) => ({
      id: x._id,
      name: x.name,
      at: x.createdAt,
      // Where it stands among the person's clicks and stops, and which stop it went with, where it went with one that has a number
      sequence: x.sequence ?? null,
      stoppedSequence: x.stoppedSequence ?? null,
      delivery: x.delivery,
      route: x.route ?? null,
      outcome: x.outcome ?? null,
      attended: x.attended ?? null,
      // When it was handed over, or dropped by a stop: the site tells by it which stop dropped what
      handedAt: x.handedAt ?? null,
      // What a click carried is for the agent; the site only needs to show where it got to
      ...(c.kind === 'machine' ? { payload: x.payload } : {}),
    }))
  },
})
