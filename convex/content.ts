// Talking to the content service, which shows pages and keeps their files, at the door on this
// machine. The backend signs each message for the audience "it-control", naming the operation
// and the exact body, and the content service checks the signature against the backend's
// public key before it acts.
//
// Two kinds of message. Questions the backend needs answered now (declare a version's files,
// check they arrived) are asked directly. Things that must happen even if the content service
// cannot be reached at that moment (ending a display's showings, deleting stored bytes) are
// kept as jobs and tried again until it confirms, because a scheduled action runs at most once.
import { AUDIENCE, PUBLICATION, STORAGE, sizeSaid } from '@it/protocol'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { type ActionCtx, internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server'
import { door } from './config'
import { confirmed } from './deletions'
import { overClashes } from './lib/clash'
import { kind, log } from './lib/log'
import { mint } from './lib/signing'
import { fileEntry } from './schema'

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

async function control(ctx: ActionCtx, op: string, body: string, ms = 25_000): Promise<Response> {
  const h = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  const token = await mint(ctx, AUDIENCE.control, op, { h }, 60)
  return fetch(`${door()}/control/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(ms),
  })
}
/**
 * How long a check of a version's files is waited for. The content service reads back every file
 * it did not see arrive itself, which it has not when it was started again in between, and a
 * slow disk reads a version of the largest at no more than 50 MB a second. It is never waited
 * for as long as the command that asked waits for its answer.
 */
const checkMs = (files: { size: number }[]) => Math.min(80_000, 25_000 + Math.ceil(files.reduce((n, f) => n + f.size, 0) / 50_000))

// ---------- asked directly ----------

/**
 * Tells the content service which files a version will have, before anyone is allowed to upload
 * them. Where the disk it keeps them on has too little room for them beside what It leaves free,
 * that is refused as a limit, which asking again does not mend.
 */
export const stage = internalAction({
  args: { prefix: v.string(), files: v.array(fileEntry) },
  handler: async (ctx, args) => {
    const r = await control(ctx, 'stage', JSON.stringify(args))
    if (r.status === 507) {
      const said = (await r.json().catch(() => ({}))) as { keepFree?: unknown }
      log('content.no_room', { bytes: args.files.reduce((n, f) => n + f.size, 0) }, 'warn')
      throw noRoom(typeof said.keepFree === 'number' ? said.keepFree : STORAGE.keepFree.bytes)
    }
    if (!r.ok) log('content.stage_failed', { status: r.status }, 'error')
    if (!r.ok) throw new Error(`the content service could not prepare the upload: ${r.status}`)
    return null
  },
})
/** What is said where the disk has no room for files: whoever asked is told, and nothing is asked again. */
export const noRoom = (keepFree: number) =>
  new ConvexError({
    code: 'limit',
    message: `The disk It keeps its files on has too little room left for these: It always leaves ${sizeSaid(keepFree)} of it free. Make room on that disk, or delete some pages.`,
  })
/** Whether what went wrong is that refusal. What a function that was run from another throws arrives with its data as text. */
export function isNoRoom(err: unknown): boolean {
  if (!(err instanceof ConvexError)) return false
  let data: unknown = err.data
  try {
    if (typeof data === 'string') data = JSON.parse(data)
  } catch {}
  return (data as { code?: unknown } | null)?.code === 'limit'
}

/** Asks the content service whether every file of a version arrived intact. */
export const verify = internalAction({
  args: { prefix: v.string(), files: v.array(fileEntry) },
  handler: async (ctx, args): Promise<{ ok: boolean; missing: string[] }> => {
    const r = await control(ctx, 'verify', JSON.stringify(args), checkMs(args.files))
    if (!r.ok) log('content.verify_failed', { status: r.status }, 'error')
    if (!r.ok) throw new Error(`the content service could not verify: ${r.status}`)
    return (await r.json()) as { ok: boolean; missing: string[] }
  },
})

// ---------- kept until done ----------

const MAX_ATTEMPTS = 40
/** 5 s, 10 s, 20 s … up to an hour between tries: about a day and a half in all. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** attempts, 3_600_000)

/** How many jobs are looked at in one run. */
const BATCH = 100

async function enqueue(
  ctx: MutationCtx,
  op: 'revoke' | 'delete',
  /** Whose display or files it is about. */
  userId: Id<'users'>,
  body: unknown,
  opts: { thenDeleteUser?: Id<'users'>; inMs?: number; deletionId?: Id<'deletions'>; displayId?: string } = {},
): Promise<Id<'contentJobs'>> {
  const now = Date.now()
  const wait = opts.inMs ?? 0
  const jobId = await ctx.db.insert('contentJobs', {
    op,
    body: JSON.stringify(body),
    attempts: 0,
    nextAt: now + wait,
    createdAt: now,
    userId,
    thenDeleteUser: opts.thenDeleteUser,
    deletionId: opts.deletionId,
    ...(opts.displayId === undefined ? {} : { displayId: opts.displayId }),
  })
  await ctx.scheduler.runAfter(wait, internal.content.run, { jobId })
  return jobId
}
/** Showings opened for a display before `epoch` are over, and tickets made for it before then open nothing. Answers with the job, for a caller that wants to know when the content service has confirmed. */
export const revokeLater = (ctx: MutationCtx, args: { userId: Id<'users'>; displayId: string; epoch: number }, opts: { inMs?: number } = {}) =>
  enqueue(ctx, 'revoke', args.userId, args, { ...opts, displayId: args.displayId })
/** How long after something is deleted an upload that was already under way could still land. */
const GRANT_TAIL_MS = PUBLICATION.grantTailMs
/**
 * Deletes stored bytes under a prefix, which begins with whose they are (`u/<person>/`): a
 * retired version, a deleted page, or everything one person has. Where a grant to upload there
 * may still be good, the deletion is done a second time once that grant has run out, so that
 * an upload which was already on its way leaves nothing behind.
 */
export async function removeLater(
  ctx: MutationCtx,
  prefix: string,
  opts: { thenDeleteUser?: Id<'users'>; grantMayBeLive?: boolean; deletionId?: Id<'deletions'> } = {},
): Promise<void> {
  const person = ctx.db.normalizeId('users', prefix.split('/')[1] ?? '')
  if (!person) throw new Error('a prefix to delete under names nobody')
  await enqueue(ctx, 'delete', person, { prefix }, { thenDeleteUser: opts.thenDeleteUser, deletionId: opts.deletionId })
  if (opts.grantMayBeLive) await enqueue(ctx, 'delete', person, { prefix }, { inMs: GRANT_TAIL_MS })
}

export const _job = internalQuery({ args: { jobId: v.id('contentJobs') }, handler: (ctx, { jobId }) => ctx.db.get(jobId) })

/** What a revocation is about: which display, and the number it raises that display to. */
const revokeOf = (job: { op: string; body: string }): { displayId: string; epoch: number } | null => {
  if (job.op !== 'revoke') return null
  const said = JSON.parse(job.body) as { displayId?: unknown; epoch?: unknown }
  return typeof said.displayId === 'string' && typeof said.epoch === 'number' ? { displayId: said.displayId, epoch: said.epoch } : null
}
/**
 * The revocations not yet confirmed for any of these displays of a person's, read by display, so
 * that no number of other jobs stands in front of them. A display has few: one per lock or
 * sign-out still being tried, and a confirmed one settles every lower one. One an earlier It
 * queued names no display here, and is for a number no higher than the display has now, which
 * a lock confirms for itself before it says anything was revoked.
 */
export async function pendingRevokes(ctx: QueryCtx | MutationCtx, userId: Id<'users'>, displayIds: string[]) {
  const out = []
  for (const displayId of displayIds) {
    const jobs = await ctx.db
      .query('contentJobs')
      .withIndex('by_display', (q) => q.eq('displayId', displayId))
      .take(BATCH)
    for (const job of jobs) {
      const r = revokeOf(job)
      if (r && job.userId === userId && r.displayId === displayId) out.push({ job, ...r })
    }
  }
  return out
}
/** How many revocations are not yet confirmed for these displays: none, once the content service has taken in what each one's number now is. */
export const _pendingRevokes = internalQuery({
  args: { userId: v.id('users'), displayIds: v.array(v.string()) },
  handler: async (ctx, { userId, displayIds }) => (await pendingRevokes(ctx, userId, displayIds)).length,
})

export const _settle = internalMutation({
  args: { jobId: v.id('contentJobs'), outcome: v.union(v.literal('done'), v.literal('more'), v.literal('failed')) },
  handler: async (ctx, { jobId, outcome }) => {
    const job = await ctx.db.get(jobId)
    if (!job) return null
    if (outcome === 'done') {
      if (job.deletionId) await confirmed(ctx, job.deletionId, 'contentAt')
      // A display raised to a number has been raised past every lower one: what was still to
      // be asked for it, to a number no higher, is asked for nothing that is not done
      const raised = revokeOf(job)
      if (raised)
        for (const other of await pendingRevokes(ctx, job.userId, [raised.displayId]))
          if (other.job._id !== jobId && other.epoch <= raised.epoch) await ctx.db.delete(other.job._id)
      const person = job.thenDeleteUser
      if (person) {
        // Everything the content service had of the person's is gone, so whatever else was still
        // to be asked of it for them asks for nothing that is left: a display to sign out, a
        // page's files to look for once more. Each names the person, and is let go of before
        // their own record is, a batch at a time.
        const others = await ctx.db
          .query('contentJobs')
          .withIndex('by_user', (q) => q.eq('userId', person))
          .take(BATCH)
        for (const other of others) if (other._id !== jobId) await ctx.db.delete(other._id)
        if (others.length === BATCH) {
          await ctx.scheduler.runAfter(0, internal.content._settle, { jobId, outcome })
          return null
        }
      }
      await ctx.db.delete(jobId)
      // The last thing to go when a person erases everything is the person's own record
      if (job.thenDeleteUser && (await ctx.db.get(job.thenDeleteUser))) {
        await ctx.db.delete(job.thenDeleteUser)
        log('account.deleted', { userId: job.thenDeleteUser })
      }
      // Only one that had to be tried more than once is worth a line when it does get through
      if (job.attempts > 0) log('content_job.done', { jobId, op: job.op, tries: job.attempts + 1 })
      return null
    }
    const attempts = outcome === 'more' ? 0 : job.attempts + 1
    // A deletion is never given up on: what it was to delete would otherwise stay for good, and
    // erasing everything a person has would stay half done. Past the usual number of tries it is
    // simply tried once an hour. Only a revocation is let go, since the next ticket for that
    // display carries it to the content service anyway.
    if (attempts > MAX_ATTEMPTS && job.op === 'revoke') {
      log('content_job.given_up', { jobId, op: job.op, tries: job.attempts }, 'error')
      await ctx.db.delete(jobId)
      return null
    }
    if (attempts > MAX_ATTEMPTS && attempts % 24 === 0) log('content_job.still_failing', { jobId, op: job.op, tries: attempts }, 'error')
    const wait = outcome === 'more' ? 0 : backoff(Math.min(job.attempts, MAX_ATTEMPTS))
    const nextAt = Date.now() + wait
    await ctx.db.patch(jobId, { attempts, nextAt })
    if (job.deletionId) {
      const d = await ctx.db.get(job.deletionId)
      if (d && d.contentAt === undefined) await ctx.db.patch(d._id, { attempts, nextAt, failedAt: outcome === 'failed' ? Date.now() : undefined })
    }
    await ctx.scheduler.runAfter(wait, internal.content.run, { jobId })
    return null
  },
})

/** Asks the content service for what a job asks, once, and says how that went. Nothing is noted of the job here. */
async function attempt(ctx: ActionCtx, jobId: Id<'contentJobs'>, job: { op: string; body: string; attempts: number }): Promise<'done' | 'more' | 'failed'> {
  let outcome: 'done' | 'more' | 'failed' = 'failed'
  try {
    const r = await control(ctx, job.op, job.body)
    if (!r.ok) log('content_job.failed', { jobId, op: job.op, try: job.attempts + 1, status: r.status }, 'error')
    if (r.ok) {
      // Only a proper answer counts. One that cannot be read, or does not say what was asked,
      // is a failure, and the job is tried again.
      const said = (await r.json().catch(() => null)) as { more?: unknown; removed?: unknown; epoch?: unknown } | null
      // A deletion that says there is more and that it removed nothing got nowhere. It is no
      // step on the way, to be followed by the next at once: it waits as a failure does, so
      // that what cannot be removed is not asked for without end and without a pause.
      const stuck = job.op === 'delete' && said?.more === true && said.removed === 0
      if (job.op === 'delete' && typeof said?.more === 'boolean' && !stuck) outcome = said.more ? 'more' : 'done'
      if (job.op === 'revoke' && typeof said?.epoch === 'number') outcome = 'done'
      if (outcome === 'failed')
        log(
          'content_job.failed',
          { jobId, op: job.op, try: job.attempts + 1, status: r.status, reason: stuck ? 'nothing_removed' : 'unreadable_answer' },
          'error',
        )
    }
  } catch (err) {
    // The content service could not be reached: tried again later
    log('content_job.failed', { jobId, op: job.op, try: job.attempts + 1, reason: 'unreachable', kind: kind(err) }, 'error')
  }
  return outcome
}

export const run = internalAction({
  args: { jobId: v.id('contentJobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.content._job, { jobId })
    if (!job) return null
    const outcome = await attempt(ctx, jobId, job)
    await overClashes(() => ctx.runMutation(internal.content._settle, { jobId, outcome }))
    return null
  },
})

/**
 * A revocation asked for now, by a caller that waits for it, as locking a display does: true
 * once the content service has said it took it in, and the job is then done. Where it did not,
 * the job is left to be tried as it was going to be, and the caller is told so.
 */
export const revokeNow = internalAction({
  args: { jobId: v.id('contentJobs') },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    const job = await ctx.runQuery(internal.content._job, { jobId })
    // Already done, by its own run
    if (!job) return true
    if (job.op !== 'revoke') return false
    if ((await attempt(ctx, jobId, job)) !== 'done') return false
    await overClashes(() => ctx.runMutation(internal.content._settle, { jobId, outcome: 'done' }))
    return true
  },
})

/** Every few minutes: starts again any job whose own retry was lost, for instance to a restart mid-run. */
export const kick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const overdue = await ctx.db
      .query('contentJobs')
      .withIndex('by_next', (q) => q.lt('nextAt', Date.now() - 120_000))
      .take(50)
    for (const job of overdue) {
      await ctx.db.patch(job._id, { nextAt: Date.now() })
      await ctx.scheduler.runAfter(0, internal.content.run, { jobId: job._id })
    }
    if (overdue.length) log('content_job.restarted', { count: overdue.length }, 'warn')
    return overdue.length
  },
})
