// Web push: how a notification reaches a display that does not have the site open. Each display
// keeps its own subscription. The sending itself is done by the service that runs the backend,
// which keeps the keys a push service knows this installation by: the backend asks it on this
// machine, with a token made for that and nothing else.
import { AUDIENCE, isPushEndpoint } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { type ActionCtx, action, internalAction, internalMutation, internalQuery, mutation, type QueryCtx } from './_generated/server'
import { door } from './config'
import { displayByKey, requireBrowser } from './lib/authz'
import { overClashes } from './lib/clash'
import { fail } from './lib/errors'
import { sha256 } from './lib/hash'
import { rateLimit } from './lib/limits'
import { kind, log } from './lib/log'
import { mint } from './lib/signing'

/** A display that has not said it is open for this long is taken to be closed. */
const QUIET_MS = 150_000

export const subscribe = mutation({
  args: { key: v.string(), endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, { key, endpoint, p256dh, auth }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    // Only a real push service: the backend will be making requests to this address
    if (endpoint.length > 1000 || p256dh.length > 200 || auth.length > 100 || !isPushEndpoint(endpoint)) fail('invalid', 'That is not a push subscription.')
    // One browser, one display. If this browser's subscription is still on another display, of
    // this person or of anyone else, it is taken off there, so what is meant for someone who
    // used this browser before never shows up for whoever uses it now.
    const others = await ctx.db
      .query('displays')
      .withIndex('by_push_endpoint', (q) => q.eq('push.endpoint', endpoint))
      .take(20)
    for (const other of others) {
      if (other._id === d._id) continue
      await ctx.db.patch(other._id, { push: undefined })
      // The same browser, now someone else's display, or this person's under another key.
      // Only where it went is said: where it came from may be another person's.
      log('push.moved', { to: d._id })
    }
    await ctx.db.patch(d._id, { push: { endpoint, p256dh, auth } })
    return null
  },
})

export const unsubscribe = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    await ctx.db.patch(d._id, { push: undefined })
    return null
  },
})

/** Before the key a browser subscribes with is handed out: a paired browser, and not too often. */
export const _gate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireBrowser(ctx)
    await rateLimit(ctx, 'pushKey', user._id)
    return null
  },
})

/**
 * Whether the browser a display is still holds the session it registered under. Nothing is
 * pushed to one whose session has ended: its subscription is removed as the session ends, and
 * this is asked all the same wherever it is chosen who is sent a notification.
 */
async function paired(ctx: QueryCtx, d: Doc<'displays'>): Promise<boolean> {
  const session = await ctx.db.get(d.sessionId)
  return session !== null && session.endedAt === undefined
}

/**
 * Who should be pushed a notification: the displays it is for that are closed right now and
 * have not been pushed it already. Nobody, once someone has seen or dismissed it.
 */
export const _targets = internalQuery({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const n = await ctx.db.get(notificationId)
    if (!n || n.seenAt || n.dismissedAt || n.answeredAt) return null
    // Nothing is sent for a person whose records are being erased, or are gone
    const owner = await ctx.db.get(n.userId)
    if (!owner || owner.deletedAt) return null
    const displays = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', n.userId))
      .take(50)
    const slug = n.artifactId ? ((await ctx.db.get(n.artifactId))?.slug ?? null) : null
    const quiet = Date.now() - QUIET_MS
    const already = new Set<string>(n.pushedTo ?? [])
    const targets = []
    for (const d of displays) {
      if (!d.push || d.lastSeenAt >= quiet || already.has(d._id) || (n.displayId && n.displayId !== d._id)) continue
      if (await paired(ctx, d)) targets.push({ displayId: d._id, push: d.push })
    }
    return {
      id: n._id,
      body: n.text,
      // A path, and never a whole address: the display opens it at whatever address it reaches the site by
      url: slug ? `/p/${slug}` : '/',
      targets,
    }
  },
})

/** Whether a push that is about to be sent should still be sent: same display, same subscription, its browser still paired, and nobody has seen it. */
export const _still = internalQuery({
  args: { notificationId: v.id('notifications'), displayId: v.id('displays'), endpoint: v.string() },
  handler: async (ctx, { notificationId, displayId, endpoint }) => {
    const n = await ctx.db.get(notificationId)
    if (!n || n.seenAt || n.dismissedAt || n.answeredAt) return false
    const owner = await ctx.db.get(n.userId)
    if (!owner || owner.deletedAt) return false
    const d = await ctx.db.get(displayId)
    return Boolean(d && d.userId === n.userId && d.push?.endpoint === endpoint && (await paired(ctx, d)))
  },
})

/** Records where a notification was pushed, and forgets subscriptions the push service says are gone. */
export const _pushed = internalMutation({
  args: {
    notificationId: v.id('notifications'),
    sent: v.array(v.id('displays')),
    gone: v.array(v.object({ displayId: v.id('displays'), endpoint: v.string() })),
  },
  handler: async (ctx, { notificationId, sent, gone }) => {
    const n = await ctx.db.get(notificationId)
    if (n && sent.length) await ctx.db.patch(n._id, { pushedTo: [...new Set([...(n.pushedTo ?? []), ...sent])].slice(0, 50) })
    for (const g of gone) {
      const d = await ctx.db.get(g.displayId)
      // Only the subscription that was refused: the browser may have made a new one since
      if (d && d.push?.endpoint === g.endpoint) await ctx.db.patch(d._id, { push: undefined })
    }
    return null
  },
})

/** Asks the service for one thing. The token names that thing and, where something is sent, the exact body. */
async function service(ctx: ActionCtx, op: 'send' | 'key', body?: string): Promise<Response> {
  const claims = body === undefined ? {} : { h: await sha256(body) }
  const token = await mint(ctx, AUDIENCE.push, op, claims, 60)
  return fetch(`${door()}/internal/push${op === 'key' ? '/key' : ''}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(15_000),
  })
}

/** The key a browser needs in order to subscribe. Public by nature, but only handed to a paired browser. */
export const publicKey = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    await overClashes(() => ctx.runMutation(internal.push._gate, {}))
    try {
      const r = await service(ctx, 'key')
      const said = r.ok ? ((await r.json()) as { key?: unknown } | null) : null
      if (typeof said?.key === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(said.key)) return said.key
      log('push.no_key', { status: r.status }, 'error')
    } catch (err) {
      log('push.no_key', { kind: kind(err) }, 'error')
    }
    return fail('unavailable', 'Notifications cannot be turned on just now. Try again in a moment.')
  },
})

export const deliver = internalAction({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const job = await ctx.runQuery(internal.push._targets, { notificationId })
    if (!job || job.targets.length === 0) return 0
    const sent: Id<'displays'>[] = []
    const gone: { displayId: Id<'displays'>; endpoint: string }[] = []
    for (const t of job.targets) {
      // Checked when it was stored, and again here: this address is about to be requested
      if (!isPushEndpoint(t.push.endpoint)) {
        log('push.dropped', { notificationId, displayId: t.displayId, reason: 'not_a_push_service' }, 'warn')
        gone.push({ displayId: t.displayId, endpoint: t.push.endpoint })
        continue
      }
      // Looked at again just before each send, since the one before may have taken a while: a
      // display that was forgotten or signed out in the meantime, or a notification that was
      // seen, is not sent to.
      if (!(await ctx.runQuery(internal.push._still, { notificationId, displayId: t.displayId, endpoint: t.push.endpoint }))) continue
      // What the push service itself answered, as the service on this machine passes it on
      let status: number
      try {
        const r = await service(
          ctx,
          'send',
          JSON.stringify({
            subscription: { endpoint: t.push.endpoint, p256dh: t.push.p256dh, auth: t.push.auth },
            // Kept to a line of text and the address to open. The push service cannot read it.
            payload: JSON.stringify({ title: 'It', body: job.body.slice(0, 180), url: job.url, id: job.id }),
            ttl: 3600,
          }),
        )
        const said = r.ok ? ((await r.json().catch(() => null)) as { status?: unknown } | null) : null
        if (typeof said?.status !== 'number') {
          // The service could not try at all, or answered something else: nothing is learned about the subscription
          log('push.failed', { notificationId, displayId: t.displayId, reason: 'not_tried', status: r.status }, 'error')
          continue
        }
        status = said.status
      } catch (err) {
        // Never the error itself: it may carry the subscription's address, which is a credential
        log('push.failed', { notificationId, displayId: t.displayId, reason: 'unreachable', kind: kind(err) }, 'error')
        continue
      }
      if (status >= 200 && status < 300) sent.push(t.displayId)
      // 404 and 410 mean the subscription is gone for good; 401 and 403 that it was made for another key
      else if (status === 404 || status === 410 || status === 401 || status === 403) {
        // 401 and 403 for many displays at once means the key this installation sends with has changed
        log('push.dropped', { notificationId, displayId: t.displayId, status }, status === 401 || status === 403 ? 'error' : 'info')
        gone.push({ displayId: t.displayId, endpoint: t.push.endpoint })
      } else log('push.failed', { notificationId, displayId: t.displayId, status }, 'error')
    }
    await overClashes(() => ctx.runMutation(internal.push._pushed, { notificationId, sent, gone }))
    return sent.length
  },
})
