import { AUDIENCE, LIMITS, parseJson, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { revokeLater } from './content'
import {
  artifactBySlug,
  displayByKey,
  findDisplay,
  ownDisplay,
  requireBrowser,
  requireMachine,
  requireMachineOrOwner,
  requireOwner,
  speaksFor,
} from './lib/authz'
import { overClashes } from './lib/clash'
import { fail } from './lib/errors'
import { quota, rateLimit } from './lib/limits'
import { log } from './lib/log'
import { mint } from './lib/signing'
import { endSession, signOutDisplay } from './sessions'

const KEY = /^[A-Za-z0-9_-]{16,128}$/

/** "Chrome on Linux", from what the browser says about itself. */
function generatedName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'this device'
  return `${browser} on ${system}`
}
const view = (d: Doc<'displays'>) => ({
  id: d._id,
  name: d.name ?? d.generatedName,
  named: d.name !== undefined,
  lastSeenAt: d.lastSeenAt,
  push: d.push !== undefined,
})

/** A browser that has just been paired registers itself on the spot. The person can name it later. */
export const register = mutation({
  args: { key: v.string(), userAgent: v.string() },
  handler: async (ctx, { key, userAgent }) => {
    const { user, session } = await requireBrowser(ctx)
    if (!KEY.test(key)) fail('invalid', 'That is not a display key.')
    const existing = await ctx.db
      .query('displays')
      .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', key))
      .unique()
    if (existing) {
      if (existing.sessionId !== session._id) {
        // The key only selects. While the session the display is with has not ended, the display
        // is that browser's, and to anyone else who names its key there is no such display. Once
        // that session has ended, the display goes with the session its browser has now, which
        // is the caller's own and never one the browser names: that is the session forgetting
        // the display will end.
        const holder = await ctx.db.get(existing.sessionId)
        if (holder && holder.endedAt === undefined) fail('not_found', 'This display is not registered.')
        await ctx.db.patch(existing._id, { sessionId: session._id })
      }
      return view(existing)
    }
    // A display the person told It to forget does not come back under the key it had. The key
    // is refused, and the browser starts again as a new display once it has been paired again.
    // That the display was forgotten is said to the owner's browser alone. What became of a
    // display is not a screen's to be told: a screen is refused in the very words it is refused
    // in when it names the key of a display that is another browser's still.
    const gone = await ctx.db
      .query('forgotten')
      .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', key))
      .first()
    if (gone) {
      // The browser that was forgotten, asking to be a display again: what a lost device does
      log('display.refused', { userId: user._id, reason: 'forgotten' }, 'warn')
      if (session.role !== 'owner') fail('not_found', 'This display is not registered.')
      fail('forbidden', 'This display was forgotten. Pair this browser again to add it back.', { forgotten: true })
    }
    await rateLimit(ctx, 'registerDisplay', user._id)
    const mine = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(QUOTA.displays + 1)
    const now = Date.now()
    if (mine.length >= QUOTA.displays) {
      // A browser whose site data was cleared, or a private window, comes back as a new display
      // each time, so that a person could have as many displays as there may be, none of which
      // they still use, and be unable to add one. Room is made by letting one go: first one that nobody
      // gave a name or turned notifications on for and that is not open now (it has not been
      // for ten minutes), and failing that any display that has not been open for a month.
      // Such a browser loses nothing: if it comes back still paired, it is simply registered again.
      const leastRecent = (of: typeof mine) => of.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b))
      const passing = mine.filter((d) => !d.name && !d.push && now - d.lastSeenAt > 600_000)
      const oldest = leastRecent(mine)
      const going = passing.length ? leastRecent(passing) : now - oldest.lastSeenAt >= 30 * 86_400_000 ? oldest : null
      if (!going) quota(mine.length, QUOTA.displays, 'displays', user._id)
      else {
        await signOutDisplay(ctx, going)
        await ctx.db.delete(going._id)
        log('display.let_go', { userId: user._id, displayId: going._id, idleMs: now - going.lastSeenAt })
      }
    }
    const id = await ctx.db.insert('displays', {
      userId: user._id,
      key,
      generatedName: generatedName(userAgent.slice(0, 400)),
      createdAt: now,
      lastSeenAt: now,
      epoch: 0,
      sessionId: session._id,
    })
    log('display.registered', { userId: user._id, displayId: id, sessionId: session._id, role: session.role })
    return view((await ctx.db.get(id))!)
  },
})

/**
 * Whether the person told It to forget this display. A display whose record is gone asks this
 * to tell that apart from having been let go to make room, which it recovers from by itself.
 *
 * A display that is forgotten has the session of its browser ended with it. So a screen that is
 * still paired, and asks, was not forgotten itself, and what became of any other display is not
 * a screen's to be told: it is answered as it would be about a key no display ever had.
 */
export const wasForgotten = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const { user, session } = await requireBrowser(ctx)
    if (session.role !== 'owner') return false
    const gone = await ctx.db
      .query('forgotten')
      .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', key))
      .first()
    return gone !== null
  },
})

/** This display, and what an agent last asked it to show. */
export const mine = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await findDisplay(ctx, await requireBrowser(ctx), key)
    if (!d) return null
    const shown = d.showing ? await ctx.db.get(d.showing.artifactId) : null
    // The revocation number goes along, so that the site knows when the sign-out token it
    // keeps for this display has been used up and fetches another
    return { ...view(d), epoch: d.epoch, showing: d.showing && shown ? { slug: shown.slug, at: d.showing.at } : null }
  },
})

/**
 * Whether the browser a display is still holds the session it registered under. A display's
 * record stays when that session ends, so that the browser is the same display once it is
 * paired again. Until it is, the display shows nothing, and is said to be not paired wherever
 * displays are listed.
 */
async function stillPaired(ctx: QueryCtx | MutationCtx, d: Doc<'displays'>): Promise<boolean> {
  const session = await ctx.db.get(d.sessionId)
  return session !== null && session.endedAt === undefined
}

/**
 * Every display the person has: for the owner's browser, and for a machine that is to show
 * something on one. `paired` is false for a display whose browser's pairing has ended.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireMachineOrOwner(ctx)
    const all = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(QUOTA.displays)
    const out = []
    for (const d of all) out.push({ ...view(d), paired: await stillPaired(ctx, d) })
    return out
  },
})

export const rename = mutation({
  args: { displayId: v.id('displays'), name: v.string() },
  handler: async (ctx, { displayId, name }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    // A screen names itself, and no other display: to it another display is no display at all
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    const clean = name.trim()
    if (!clean || clean.length > LIMITS.displayName) fail('invalid', `A display name is 1 to ${LIMITS.displayName} characters.`)
    await ctx.db.patch(d._id, { name: clean })
    return null
  },
})

/**
 * Presence. Written at most once a minute, however often it is called. Answers with the
 * backend's clock, so a display whose own clock is wrong can still tell what is recent.
 */
export const heartbeat = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    const now = Date.now()
    if (now - d.lastSeenAt > 55_000) await ctx.db.patch(d._id, { lastSeenAt: now })
    return { now }
  },
})

/** What a sign-out token for this display says: whose it is, which display, and the number its sessions are to be raised to. */
export const _signOutClaims = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const c = await requireBrowser(ctx)
    await rateLimit(ctx, 'signOutToken', c.user._id)
    const d = await displayByKey(ctx, c, key)
    return { userId: c.user._id, displayId: d._id, epoch: d.epoch + 1 }
  },
})

/**
 * A token that does one thing: sign this display out. The site fetches one while the browser
 * is paired and keeps it there. If, when the person signs out, the backend cannot be
 * told (the connection is down, say), the browser presents the token as soon as it can, and by
 * then it does not need to prove who it is. Anyone holding the token can do nothing with it
 * but end that display's sessions.
 */
export const signOutToken = action({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ token: string; raisesTo: number; display: string }> => {
    const c = await overClashes(() => ctx.runMutation(internal.displays._signOutClaims, { key }))
    // `raisesTo` is the number the token raises the display to. Once the display is already
    // there, the token does nothing, and the site must not count on it.
    return { token: await mint(ctx, AUDIENCE.signOut, c.displayId, { u: c.userId, e: c.epoch }, 14 * 86_400), raisesTo: c.epoch, display: c.displayId }
  },
})

/** A sign-out token was presented. Raises the display's number to what the token says, if it is not there already. */
export const _signOutByToken = internalMutation({
  args: { displayId: v.string(), userId: v.string(), epoch: v.number() },
  handler: async (ctx, { displayId, userId, epoch }) => {
    const id = ctx.db.normalizeId('displays', displayId)
    const d = id ? await ctx.db.get(id) : null
    // A token for a display that is gone, or one already used: nothing to do. Not written
    // down: whoever holds a used token can present it again for as long as it lasts.
    if (!d || d.userId !== userId || d.epoch >= epoch || epoch > d.epoch + 1) return false
    await ctx.db.patch(d._id, { epoch, push: undefined })
    await revokeLater(ctx, { userId: d.userId, displayId: d._id, epoch })
    log('display.signed_out', { by: 'token', applied: true, userId: d.userId, displayId: d._id, epoch })
    return true
  },
})

/** Called by the site just before it signs the person out: pages already open here stop working, and nothing more is pushed here. */
export const signOut = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ job: Id<'contentJobs'> }> => {
    const c = await requireBrowser(ctx)
    const { user } = c
    await rateLimit(ctx, 'signOut', user._id)
    const d = await displayByKey(ctx, c, key)
    const job = await signOutDisplay(ctx, d)
    log('display.signed_out', { by: 'person', applied: true, userId: user._id, displayId: d._id })
    return { job }
  },
})

/**
 * Whether the content service has confirmed a sign-out, so that the site can tell "pages on
 * this display have stopped working" from "they will, as soon as the content service hears of
 * it". The job is gone once it has confirmed; until then the backend goes on telling it.
 */
export const signOutConfirmed = query({
  args: { job: v.id('contentJobs') },
  handler: async (ctx, { job }) => {
    const c = await requireBrowser(ctx)
    const j = await ctx.db.get(job)
    if (j?.op !== 'revoke') return true
    // Only a browser that may speak for the display is told anything about it. To any other
    // the job is one that is not there, which is what a confirmed one is.
    const about = parseJson(j.body) as { displayId?: unknown } | undefined
    const id = typeof about?.displayId === 'string' ? ctx.db.normalizeId('displays', about.displayId) : null
    const d = id ? await ctx.db.get(id) : null
    return !(d && d.userId === c.user._id && speaksFor(c, d))
  },
})

/**
 * "Forget this display": its pages stop working, it stops being a place agents can show things,
 * its key is refused from now on, and the session its browser was paired into ends at once, so
 * that the browser is signed out wherever it is.
 */
export const forget = mutation({
  args: { displayId: v.id('displays') },
  handler: async (ctx, { displayId }) => {
    const { user } = await requireOwner(ctx)
    const d = await ownDisplay(ctx, user._id, displayId)
    await signOutDisplay(ctx, d)
    await ctx.db.insert('forgotten', { userId: user._id, key: d.key, at: Date.now() })
    await ctx.db.delete(d._id)
    // Whatever else that same browser had registered as is signed out as its session ends
    await endSession(ctx, d.sessionId, 'forgotten')
    log('display.forgotten', { userId: user._id, displayId: d._id, sessionId: d.sessionId })
    return null
  },
})

/**
 * An agent asks for a page to be brought up: on one named display, or on all of them. The
 * answer names the displays it is shown on, and, in `notShown`, each one it was asked onto and
 * is not shown on, with why: `not_paired` for a display whose browser's pairing has ended,
 * which shows nothing until that browser is paired again.
 */
export const show = mutation({
  args: { slug: v.string(), display: v.optional(v.string()) },
  handler: async (ctx, { slug, display }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'show', user._id)
    const artifact = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    const all = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(QUOTA.displays)
    const wanted = display?.trim().toLowerCase()
    const targets = wanted ? all.filter((d) => (d.name ?? d.generatedName).toLowerCase() === wanted) : all
    // Said without the name that was asked for and without the names there are: a refusal is
    // kept in the backend's own record of what failed, and a display's name is the person's.
    // The machine that asked knows what it asked, and reads the names with `it displays`.
    if (wanted && targets.length === 0) fail('not_found', 'No display has that name.', { noSuchDisplay: true })
    const shown: string[] = []
    const notShown: { display: string; reason: 'not_paired' }[] = []
    for (const d of targets) {
      const name = d.name ?? d.generatedName
      if (await stillPaired(ctx, d)) {
        await ctx.db.patch(d._id, { showing: { artifactId: artifact._id, at: Date.now() } })
        shown.push(name)
      } else notShown.push({ display: name, reason: 'not_paired' })
    }
    return { displays: shown, notShown }
  },
})
