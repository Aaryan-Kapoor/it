import { AUDIENCE, LIMITS, parseJson, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, mutation, type QueryCtx, query } from './_generated/server'
import { takePage } from './artifacts'
import { revokeLater } from './content'
import { aim, EVERY_DISPLAY, stillPaired } from './lib/aim'
import {
  artifactBySlug,
  displayByKey,
  findDisplay,
  ownArtifact,
  ownDisplay,
  requireBrowser,
  requireMachine,
  requireMachineOrOwner,
  requireOwner,
  speaksFor,
} from './lib/authz'
import { overClashes } from './lib/clash'
import { counted, screenOf } from './lib/counted'
import { fail } from './lib/errors'
import { quota, rateLimit } from './lib/limits'
import { log } from './lib/log'
import { mint } from './lib/signing'
import { session } from './schema'
import { endSession, signOutDisplay } from './sessions'

const KEY = /^[A-Za-z0-9_-]{16,128}$/
/** A display that has not been seen for this long has closed the site, and opens it anew when it comes back. */
const AWAY_MS = 600_000
/**
 * Eight earlier pairings per display keep removal counts to at most 200 historical roots
 * across the 25 displays. Before an older pairing leaves this list, what it let in is ended,
 * so the bound never leaves invited access that forgetting the display cannot reach.
 */
const PREVIOUS_PAIRINGS = 8

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
  agents: d.agentsOff !== true,
})

/** A browser that has just been paired registers itself on the spot. The person can name it later. */
export const register = mutation({
  args: { key: v.string(), userAgent: v.string() },
  handler: async (ctx, { key, userAgent }) => {
    const c = await requireBrowser(ctx)
    const { user, session } = c
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
        // is the caller's own and never one the browser names. Earlier pairings stay with the
        // display so that forgetting it also ends what those pairings let in.
        const holder = await ctx.db.get(existing.sessionId)
        if (holder && holder.endedAt === undefined) fail('not_found', 'This display is not registered.')
        const previous = [...(existing.previousSessions ?? []), existing.sessionId]
        await ctx.db.patch(existing._id, { sessionId: session._id, previousSessions: previous.slice(-PREVIOUS_PAIRINGS) })
        // The browser registering now may descend from an earlier pairing. It stays paired,
        // just as the browser asking to end every other session does.
        for (const id of previous.slice(0, -PREVIOUS_PAIRINGS)) await endSession(ctx, id, 'forgotten', session._id)
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
    let letGo: Id<'displays'> | null = null
    if (mine.length >= QUOTA.displays) {
      // A browser whose site data was cleared, or a private window, comes back as a new display
      // each time, so that a person could have as many displays as there may be, none of which
      // they still use, and be unable to add one. Room is made by letting one go: first one that nobody
      // gave a name or turned notifications on for and that is not open now (it has not been
      // for ten minutes) and that nobody locked to a page, and failing that any display that has
      // not been open for a month.
      // A browser that comes back still paired is simply registered again. What its earlier
      // pairings let in ends now, since deleting the display would lose the way to end it later.
      // The one to go is one the caller may act for, which for a screen is a display of its own
      // and no other: letting a display go signs it out, and a screen that could make room among
      // all of them would sign out the owner's by registering itself anew.
      const leastRecent = (of: typeof mine) => of.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b))
      const itsOwn = mine.filter((d) => speaksFor(c, d))
      const passing = itsOwn.filter((d) => !d.name && !d.push && !d.lockedTo && now - d.lastSeenAt > 600_000)
      const oldest = itsOwn.length ? leastRecent(itsOwn) : null
      const going = passing.length ? leastRecent(passing) : oldest && now - oldest.lastSeenAt >= 30 * 86_400_000 ? oldest : null
      if (!going) quota(mine.length, QUOTA.displays, 'displays', user._id)
      else {
        await signOutDisplay(ctx, going)
        await ctx.db.delete(going._id)
        for (const id of going.previousSessions ?? []) await endSession(ctx, id, 'forgotten', session._id)
        letGo = going._id
        log('display.let_go', { userId: user._id, displayId: going._id, idleMs: now - going.lastSeenAt })
      }
    }
    // Two browsers of one kind would go by one name until the person named them, and neither
    // they nor an agent could say which of the two a page was to be shown on: the second is
    // "Chrome on Linux 2"
    const named = new Set(mine.filter((d) => d._id !== letGo).map((d) => (d.name ?? d.generatedName).toLowerCase()))
    const kind = generatedName(userAgent.slice(0, 400))
    let unlike = kind
    for (let n = 2; named.has(unlike.toLowerCase()) && n <= QUOTA.displays + 1; n++) unlike = `${kind} ${n}`
    const id = await ctx.db.insert('displays', {
      userId: user._id,
      key,
      generatedName: unlike,
      createdAt: now,
      lastSeenAt: now,
      // Someone paired it a moment ago, there, and is looking at it
      usedAt: now,
      epoch: 0,
      sessionId: session._id,
      screen: screenOf(userAgent),
    })
    log('display.registered', { userId: user._id, displayId: id, sessionId: session._id, role: session.role })
    return view((await ctx.db.get(id))!)
  },
})

/**
 * A display says that it has the site open, and whether it reached It at this machine's own
 * address. This is for the counts of how It is used and for nothing else: that a display was
 * paired, the first time one that was just registered says so, and that a display opened the
 * site, each time one says so after having been away. A display that is not registered is
 * answered and nothing is noted.
 */
export const reached = mutation({
  args: { key: v.string(), local: v.boolean() },
  handler: async (ctx, { key, local }) => {
    const c = await requireBrowser(ctx)
    const display = KEY.test(key) ? await findDisplay(ctx, c, key) : null
    if (!display) return null
    const now = Date.now()
    if (display.reachedAt !== undefined && now - display.reachedAt <= AWAY_MS) return null
    const what = { screen: display.screen ?? 'computer', sameMachine: local }
    if (display.reachedAt === undefined && now - display.createdAt <= AWAY_MS) {
      const others = await ctx.db
        .query('displays')
        .withIndex('by_user', (q) => q.eq('userId', c.user._id))
        .take(2)
      await counted(ctx, 'display.paired', { ...what, first: others.length < 2 })
    }
    await counted(ctx, 'screen.connected', what)
    await ctx.db.patch(display._id, { reachedAt: now, local })
    return null
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

/** The page a display is locked to, as the site and an agent name it, or null. */
async function lockOf(ctx: QueryCtx, d: Doc<'displays'>): Promise<{ id: Id<'artifacts'>; slug: string; title: string } | null> {
  const page = d.lockedTo ? await ctx.db.get(d.lockedTo.artifactId) : null
  return page ? { id: page._id, slug: page.slug, title: page.title } : null
}

/**
 * This display, what an agent last asked it to show, the page it is locked to, and whether a
 * lock it had ended because its page was deleted, which it has yet to say.
 */
export const mine = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await findDisplay(ctx, await requireBrowser(ctx), key)
    if (!d) return null
    const shown = d.showing ? await ctx.db.get(d.showing.artifactId) : null
    // The revocation number goes along, so that the site knows when the sign-out token it
    // keeps for this display has been used up and fetches another
    return {
      ...view(d),
      epoch: d.epoch,
      showing: d.showing && shown ? { slug: shown.slug, at: d.showing.at } : null,
      lockedTo: await lockOf(ctx, d),
      lockEnded: d.lockEnded !== undefined,
    }
  },
})

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
    for (const d of all) out.push({ ...view(d), paired: await stillPaired(ctx, d), lockedTo: await lockOf(ctx, d) })
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
    // An agent names it to show a page on every display at once
    if (clean.toLowerCase() === EVERY_DISPLAY)
      fail('invalid', `An agent asks for every display at once with “${EVERY_DISPLAY}”, so no display can be called that.`)
    await ctx.db.patch(d._id, { name: clean })
    return null
  },
})

/**
 * Whether agents may show pages and send notifications on a display. The owner's browser says so
 * for any display, and a screen for itself and no other.
 */
export const allowAgents = mutation({
  args: { displayId: v.id('displays'), allowed: v.boolean() },
  handler: async (ctx, { displayId, allowed }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    if ((d.agentsOff === true) === !allowed) return null
    await ctx.db.patch(d._id, { agentsOff: allowed ? undefined : true })
    return null
  },
})

/**
 * Locks a display to one of the person's pages: from then on nothing an agent does brings
 * another page up there, it is never the display chosen when an agent names none, and the site
 * on it keeps to that page. The page is brought up there at once. The owner's browser locks any
 * display, and a screen itself and no other. Only the owner's browser unlocks one (`unlock`).
 */
export const lock = mutation({
  args: { displayId: v.id('displays'), artifactId: v.id('artifacts') },
  handler: async (ctx, { displayId, artifactId }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    const page = await ownArtifact(ctx, c.user._id, artifactId)
    const now = Date.now()
    await ctx.db.patch(d._id, {
      lockedTo: { artifactId: page._id, at: now },
      lockEnded: undefined,
      showing: { artifactId: page._id, at: Math.max(now, (d.showing?.at ?? 0) + 1) },
    })
    return null
  },
})

/**
 * Unlocks a display. Only the browser paired as the owner's may: a lock is the owner's word that
 * a screen keeps to one page, which whoever is at a paired screen does not undo.
 */
export const unlock = mutation({
  args: { displayId: v.id('displays') },
  handler: async (ctx, { displayId }) => {
    const { user } = await requireOwner(ctx)
    const d = await ownDisplay(ctx, user._id, displayId)
    if (d.lockedTo) await ctx.db.patch(d._id, { lockedTo: undefined })
    return null
  },
})

/** The display has said that the lock it had ended because its page was deleted. */
export const lockEndedSeen = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    if (d.lockEnded !== undefined) await ctx.db.patch(d._id, { lockEnded: undefined })
    return null
  },
})

/**
 * Presence: that the site is open here, whether it is visible, and whether the person has used
 * it since the display last said so. When it was last seen open is written at most once a
 * minute, and when it was last used at most once in five seconds, however often this is called;
 * that it was hidden or shown again is written as it changes. Answers with the backend's clock,
 * so a display whose own clock is wrong can still tell what is recent. A site that sends
 * neither `visible` nor `used` calls this only while it is visible.
 */
export const heartbeat = mutation({
  args: { key: v.string(), visible: v.optional(v.boolean()), used: v.optional(v.boolean()) },
  handler: async (ctx, { key, visible, used }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    const now = Date.now()
    const shown = visible !== false
    const change: Partial<Doc<'displays'>> = {}
    if (shown && now - d.lastSeenAt > 55_000) change.lastSeenAt = now
    if (shown && d.hidden) change.hidden = undefined
    if (!shown && !d.hidden) change.hidden = true
    if (shown && used && now - (d.usedAt ?? 0) > 5000) change.usedAt = now
    if (Object.keys(change).length) await ctx.db.patch(d._id, change)
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
    for (const id of [d.sessionId, ...(d.previousSessions ?? [])]) await endSession(ctx, id, 'forgotten')
    log('display.forgotten', { userId: user._id, displayId: d._id, sessionId: d.sessionId })
    return null
  },
})

/**
 * An agent asks for a page to be brought up: on one named display, on all of them with `all`,
 * or, where it names none, on the one display the person is most likely looking at (see
 * `lib/aim.ts`). The answer names the displays it is shown on, says in `chosen` why a display
 * was chosen where none was named, and lists in `notShown` each other display with why it was
 * not shown there: `not_paired` for a display whose browser's pairing has ended, which shows
 * nothing until that browser is paired again; `agents_off` for one the person said agents may
 * not use; `locked` for one the person locked to another page; and `not_chosen` for one that
 * was passed over for the display that was chosen.
 */
export const show = mutation({
  args: { slug: v.string(), display: v.optional(v.string()), session: v.optional(session), agent: v.optional(v.string()) },
  handler: async (ctx, { slug, display, session: mine, agent }) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'show', user._id)
    const artifact = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    const aimed = await aim(ctx, user._id, display, { page: artifact._id })
    const shown: string[] = []
    for (const d of aimed.to) {
      // The time of a showing is what a display goes by to tell a new asking from one it has
      // seen, and so it never goes back: a clock that was set back would otherwise have every
      // display ignore what it is asked to show until the clock had caught up again
      await ctx.db.patch(d._id, { showing: { artifactId: artifact._id, at: Math.max(Date.now(), (d.showing?.at ?? 0) + 1) } })
      shown.push(d.name ?? d.generatedName)
    }
    // A page changes owner only if at least one requested display can show it. All display
    // changes and ownership changes commit together, including the rate-limit checks.
    const took = mine && shown.length ? (await takePage(ctx, artifact, machine, mine, agent)).took : false
    return { displays: shown, notShown: aimed.notShown, took, ...(aimed.chosen ? { chosen: aimed.chosen } : {}) }
  },
})
