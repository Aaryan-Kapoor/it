// Talking to the content service, which shows pages and keeps their files, at the door on this
// machine. The backend signs each message for the audience "it-control", naming the operation
// and the exact body, and the content service checks the signature against the backend's
// public key before it acts.
//
// Two kinds of message. Questions the backend needs answered now (declare a version's files,
// check they arrived) are asked directly. Things that must happen even if the content service
// cannot be reached at that moment (ending a display's showings, deleting stored bytes) are
// kept as jobs and tried again until it confirms, because a scheduled action runs at most once.
import { AUDIENCE } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { type ActionCtx, internalAction, internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { door } from './config'
import { overClashes } from './lib/clash'
import { kind, log } from './lib/log'
import { mint } from './lib/signing'
import { fileEntry } from './schema'

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

async function control(ctx: ActionCtx, op: string, body: string): Promise<Response> {
  const h = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  const token = await mint(ctx, AUDIENCE.control, op, { h }, 60)
  return fetch(`${door()}/control/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(25_000),
  })
}

// ---------- asked directly ----------

/** Tells the content service which files a version will have, before anyone is allowed to upload them. */
export const stage = internalAction({
  args: { prefix: v.string(), files: v.array(fileEntry) },
  handler: async (ctx, args) => {
    const r = await control(ctx, 'stage', JSON.stringify(args))
    if (!r.ok) log('content.stage_failed', { status: r.status }, 'error')
    if (!r.ok) throw new Error(`the content service could not prepare the upload: ${r.status}`)
    return null
  },
})

/** Asks the content service whether every file of a version arrived intact. */
export const verify = internalAction({
  args: { prefix: v.string(), files: v.array(fileEntry) },
  handler: async (ctx, args): Promise<{ ok: boolean; missing: string[] }> => {
    const r = await control(ctx, 'verify', JSON.stringify(args))
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
  opts: { thenDeleteUser?: Id<'users'>; inMs?: number } = {},
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
  })
  await ctx.scheduler.runAfter(wait, internal.content.run, { jobId })
  return jobId
}
/** Showings opened for a display before `epoch` are over, and tickets made for it before then open nothing. Answers with the job, for a caller that wants to know when the content service has confirmed. */
export const revokeLater = (ctx: MutationCtx, args: { userId: Id<'users'>; displayId: string; epoch: number }) => enqueue(ctx, 'revoke', args.userId, args)
/** How long after something is deleted an upload that was already under way could still land. */
const GRANT_TAIL_MS = 20 * 60_000
/**
 * Deletes stored bytes under a prefix, which begins with whose they are (`u/<person>/`): a
 * retired version, a deleted page, or everything one person has. Where a grant to upload there
 * may still be good, the deletion is done a second time once that grant has run out, so that
 * an upload which was already on its way leaves nothing behind.
 */
export async function removeLater(ctx: MutationCtx, prefix: string, opts: { thenDeleteUser?: Id<'users'>; grantMayBeLive?: boolean } = {}): Promise<void> {
  const person = ctx.db.normalizeId('users', prefix.split('/')[1] ?? '')
  if (!person) throw new Error('a prefix to delete under names nobody')
  await enqueue(ctx, 'delete', person, { prefix }, { thenDeleteUser: opts.thenDeleteUser })
  if (opts.grantMayBeLive) await enqueue(ctx, 'delete', person, { prefix }, { inMs: GRANT_TAIL_MS })
}

export const _job = internalQuery({ args: { jobId: v.id('contentJobs') }, handler: (ctx, { jobId }) => ctx.db.get(jobId) })

export const _settle = internalMutation({
  args: { jobId: v.id('contentJobs'), outcome: v.union(v.literal('done'), v.literal('more'), v.literal('failed')) },
  handler: async (ctx, { jobId, outcome }) => {
    const job = await ctx.db.get(jobId)
    if (!job) return null
    if (outcome === 'done') {
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
    await ctx.db.patch(jobId, { attempts, nextAt: Date.now() + wait })
    await ctx.scheduler.runAfter(wait, internal.content.run, { jobId })
    return null
  },
})

export const run = internalAction({
  args: { jobId: v.id('contentJobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.content._job, { jobId })
    if (!job) return null
    let outcome: 'done' | 'more' | 'failed' = 'failed'
    try {
      const r = await control(ctx, job.op, job.body)
      if (!r.ok) log('content_job.failed', { jobId, op: job.op, try: job.attempts + 1, status: r.status }, 'error')
      if (r.ok) {
        // Only a proper answer counts. One that cannot be read, or does not say what was asked,
        // is a failure, and the job is tried again.
        const said = (await r.json().catch(() => null)) as { more?: unknown; epoch?: unknown } | null
        if (job.op === 'delete' && typeof said?.more === 'boolean') outcome = said.more ? 'more' : 'done'
        if (job.op === 'revoke' && typeof said?.epoch === 'number') outcome = 'done'
        if (outcome === 'failed')
          log('content_job.failed', { jobId, op: job.op, try: job.attempts + 1, status: r.status, reason: 'unreadable_answer' }, 'error')
      }
    } catch (err) {
      // The content service could not be reached: tried again later
      log('content_job.failed', { jobId, op: job.op, try: job.attempts + 1, reason: 'unreachable', kind: kind(err) }, 'error')
    }
    await overClashes(() => ctx.runMutation(internal.content._settle, { jobId, outcome }))
    return null
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
