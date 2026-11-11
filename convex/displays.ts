import { AUDIENCE, LIMITS, parseJson, QUOTA, TAKES } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { takePage } from './artifacts'
import { site } from './config'
import { revokeLater } from './content'
import { aim, nameOf, seenOf, stillPaired, targetOf } from './lib/aim'
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
import { linkNow } from './network'
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
/** The later forms of a call this backend takes, which the site sends only where they are named here. */
const takes = Object.values(TAKES)
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
      await oneLock(ctx, (await ctx.db.get(existing._id))!)
      return { ...view(existing), takes }
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
      // gave a name or turned notifications on for, that nobody locked to a page, and that is not
      // open now (it has not been for ten minutes), and failing that any display that has not been
      // open for a month.
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
        await dropDisplay(ctx, going._id)
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
      // Someone paired it a moment ago, there, and is standing at it
      usedAt: now,
      epoch: 0,
      sessionId: session._id,
      screen: screenOf(userAgent),
    })
    // A browser that comes back as a new display, under a pairing that has a display locked,
    // is locked as that one is: its site data was cleared, say, or a key was made by hand
    await oneLock(ctx, (await ctx.db.get(id))!, { fresh: true })
    log('display.registered', { userId: user._id, displayId: id, sessionId: session._id, role: session.role })
    return { ...view((await ctx.db.get(id))!), takes }
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

/**
 * A name that another display already goes by, in any letter case, is refused: an agent asks for
 * a display by its name, and two displays of one name could not be told apart. Displays that
 * already share a name keep it, and each is still reached by its id. Kept apart here so that what
 * becomes of a name already taken can be changed in one place.
 */
async function refuseTakenName(ctx: MutationCtx, d: Doc<'displays'>, name: string): Promise<void> {
  const wanted = name.toLowerCase()
  // Its own name, said again or in other letters, is kept, even where another display shares it
  if (nameOf(d).toLowerCase() === wanted) return
  const all = await ctx.db
    .query('displays')
    .withIndex('by_user', (q) => q.eq('userId', d.userId))
    .take(QUOTA.displays)
  if (all.some((other) => other._id !== d._id && nameOf(other).toLowerCase() === wanted))
    fail('conflict', 'Another screen already has that name. Pick another name.', { nameTaken: true })
}

export const rename = mutation({
  args: { displayId: v.id('displays'), name: v.string() },
  handler: async (ctx, { displayId, name }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    // A screen names itself, and no other display: to it another display is no display at all
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    const clean = name.trim()
    if (!clean || clean.length > LIMITS.displayName) fail('invalid', `A display name is 1 to ${LIMITS.displayName} characters.`)
    await refuseTakenName(ctx, d, clean)
    await ctx.db.patch(d._id, { name: clean })
    return null
  },
})

/**
 * Presence. Written at most once a minute, however often it is called. Answers with the
 * backend's clock, so a display whose own clock is wrong can still tell what is recent, and with
 * the later forms of a call this backend takes.
 */
export const heartbeat = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const d = await displayByKey(ctx, await requireBrowser(ctx), key)
    const now = Date.now()
    if (now - d.lastSeenAt > 55_000) await ctx.db.patch(d._id, { lastSeenAt: now })
    return { now, takes }
  },
})

/** Removes a display's record, and what it said of itself with it. */
async function dropDisplay(ctx: MutationCtx, displayId: Id<'displays'>): Promise<void> {
  const kept = await ctx.db
    .query('presence')
    .withIndex('by_display', (q) => q.eq('displayId', displayId))
    .unique()
  if (kept) await ctx.db.delete(kept._id)
  await ctx.db.delete(displayId)
}

/** A tab's own id, made afresh each time the site is loaded there. */
const TAB = /^[A-Za-z0-9_-]{16,64}$/
/** How long what a tab last said of itself stands. A visible tab says so again every minute. */
export const REPORT_MS = 150_000
/** How many tabs of one display are kept. A tab past this many puts out the one that spoke longest ago. */
const TABS = 16
/**
 * How far a tab's word of when it said something, by the backend's clock as the tab learned it,
 * may be from when it arrives, and still be a use the person made a moment ago. A report that
 * waited longer, as one does that the connection held through an outage and sent again with the
 * arguments it had, says what was so then, and is kept as said then.
 */
export const REPORT_SKEW_MS = 10_000
/**
 * How long before its report a tab's use can have been. A tab says a use within ten seconds of
 * learning of it, and a use it learned of from the browser's word that the person has just acted
 * may have been up to six seconds before that, so a use said that late is still kept as of when
 * it was, and never moved later.
 */
export const USED_WITHIN_MS = 16_000

/**
 * What one tab of a display says of itself: whether it is visible, whether the person used it a
 * moment ago, and what it shows. Only the display's own browser says it, under the pairing and
 * the sign-out number it said it under: a report that waited out a sign-out or a new pairing is
 * refused, and one older than what the tab last said is ignored. Kept per tab, so that one window
 * in the back does not hide another of the same browser that is in front of the person. Each tab
 * says this every minute while it is visible, once when it is hidden, and whenever what it shows
 * changes.
 *
 * What it shows is a showing (`mountId`) that this display made itself, under its sign-out number
 * now: `loading`, `shown` once its ticket was given, or `failed`, and `none` with no showing.
 * Nothing of what the person did is kept, only when: `usedAt`, as of when the tab says the use
 * happened (`usedAt` in the report), where it says so. All of it is the browser's word, and never
 * proof of what is on the glass.
 *
 * Each report says when the tab made it (`observedAt`), by the backend's clock as the tab learned
 * it, and is kept as of then, never later than now: a report that was held back, as the
 * connection holds a call through an outage and sends it again unchanged, does not say what was
 * so then as what is so now. One that is already too old to stand is not taken, and a use is
 * taken only from one that arrives within `REPORT_SKEW_MS` of when it was made, and that was not
 * made more than that ahead of now. A report that
 * says no time, as from a site of before reports said it, is kept as of now and is never taken
 * for a use. The answer says whether the use was taken (`used`), so that a tab keeps one that was
 * not and says it again.
 */
export const report = mutation({
  args: {
    key: v.string(),
    epoch: v.number(),
    tab: v.string(),
    sequence: v.number(),
    phase: v.union(v.literal('none'), v.literal('loading'), v.literal('shown'), v.literal('failed')),
    visible: v.boolean(),
    mountId: v.optional(v.string()),
    used: v.optional(v.boolean()),
    observedAt: v.optional(v.number()),
    usedAt: v.optional(v.number()),
    expectedSession: v.string(),
  },
  handler: async (ctx, a) => {
    const c = await requireBrowser(ctx, a.expectedSession)
    const d = await displayByKey(ctx, c, a.key)
    // The owner's browser may act for every display, but says how it is only of its own
    if (d.sessionId !== c.session._id) fail('not_found', 'This display is not registered.')
    if (!TAB.test(a.tab) || !Number.isSafeInteger(a.sequence) || a.sequence < 1) fail('invalid', 'That is not what a tab says of itself.')
    if (a.phase === 'none' && a.mountId !== undefined) fail('invalid', 'A tab that shows nothing names no showing.')
    if (a.phase !== 'none' && a.mountId === undefined) fail('invalid', 'A tab that shows a page names its showing.')
    if (a.observedAt !== undefined && !Number.isFinite(a.observedAt)) fail('invalid', 'That is not what a tab says of itself.')
    if (a.usedAt !== undefined && (!Number.isFinite(a.usedAt) || a.used !== true || a.observedAt === undefined))
      fail('invalid', 'That is not what a tab says of itself.')
    const now = Date.now()
    if (a.epoch !== d.epoch) return { accepted: false, now }
    // As of when the tab made it, which no clock can make later than now
    const at = Math.min(now, a.observedAt ?? now)
    if (now - at >= REPORT_MS) return { accepted: false, now }
    // Within the leeway of the clocks either way: one made further ahead than that is from a
    // clock that runs fast, and is kept as of now, but is no use. A report is the browser's own
    // word, so this keeps a clock that is wrong from saying a use is newer than it was; a paired
    // browser that meant to could still say it was used when it was not
    const timely = a.observedAt !== undefined && Math.abs(now - a.observedAt) <= REPORT_SKEW_MS
    const kept = await ctx.db
      .query('presence')
      .withIndex('by_display', (q) => q.eq('displayId', d._id))
      .unique()
    const seen = await seenOf(ctx, d)
    const fresh = seen.reports.filter((r) => r.epoch === d.epoch && now - r.at < REPORT_MS && r.at <= now)
    const before = fresh.find((r) => r.tab === a.tab)
    if (before && a.sequence <= before.sequence) return { accepted: false, now }
    await rateLimit(ctx, 'reportDisplay', d._id)
    let page: { artifactId: Id<'artifacts'>; version: number } | undefined
    if (a.mountId !== undefined) {
      const mountId = a.mountId
      const m = await ctx.db
        .query('mounts')
        .withIndex('by_mount', (q) => q.eq('mountId', mountId))
        .unique()
      // A showing of this display's own, made since its last sign-out, and shown only once its
      // ticket was given. A card's live preview on the grid is no page shown (`picture`): what the
      // display shows is the page it has open, and never one of the pictures beside it
      if (!m || m.userId !== c.user._id || m.displayId !== d._id || m.epoch !== d.epoch || (a.phase === 'shown' && !m.ticketGiven))
        fail('not_found', 'No such showing on this display.')
      if (m.picture) fail('invalid', 'A card’s live preview is no page shown.')
      page = { artifactId: m.artifactId, version: m.version }
    }
    // Never one refused for want of room: the tabs that spoke longest ago make way
    const others = fresh
      .filter((r) => r.tab !== a.tab)
      .sort((x, y) => y.at - x.at)
      .slice(0, TABS - 1)
    const reports = [...others, { tab: a.tab, sequence: a.sequence, at, epoch: d.epoch, phase: a.phase, visible: a.visible, ...page }]
    // Written to the display's presence, and never to the display itself, whose record a tray and
    // much of the site read: a report a few times a minute would have them all read again
    const change: Partial<Doc<'presence'>> = { reports, reportedAt: Math.max(...reports.map((r) => r.at)) }
    // Whether the use it said was taken, which the tab goes by to say it again or not. It is kept
    // as of when it happened, where the tab says so, within the time a tab says a use in
    // (`USED_WITHIN_MS`) and never after the report was made: a use the tab said once its ten seconds were up is not
    // taken for one at the moment it was said. One no newer than the use kept is taken, and needs
    // no writing
    const used = a.visible && a.used === true && timely
    const usedAt = Math.max(at - USED_WITHIN_MS, Math.min(at, a.usedAt ?? at))
    if (used && usedAt > (seen.usedAt ?? 0)) change.usedAt = usedAt
    if (kept) await ctx.db.patch(kept._id, change)
    else await ctx.db.insert('presence', { userId: d.userId, displayId: d._id, ...change })
    return { accepted: true, now, used }
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
    await dropDisplay(ctx, d._id)
    // Whatever else that same browser had registered as is signed out as its session ends
    for (const id of [d.sessionId, ...(d.previousSessions ?? [])]) await endSession(ctx, id, 'forgotten')
    log('display.forgotten', { userId: user._id, displayId: d._id, sessionId: d.sessionId })
    return null
  },
})

/** Every display one browser's pairing registered, which share one lock. */
const ofPairing = (ctx: MutationCtx, sessionId: Id<'sessions'>) =>
  ctx.db
    .query('displays')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .take(QUOTA.displays)

/**
 * Puts a display under a lock, or none. A display put under a lock to another page than it had
 * is signed out of what it showed, as a sign-out does it: a showing it already has, and a ticket
 * it was given and has not used, stop working, and what it asked for before cannot be given a
 * ticket after. The page it is locked to is asked onto it at once, and shown afresh.
 */
async function putUnder(
  ctx: MutationCtx,
  d: Doc<'displays'>,
  lock: Doc<'displays'>['lockedTo'],
  opts: { fresh?: boolean; revokeInMs?: number; confirm?: boolean } = {},
): Promise<Id<'contentJobs'> | null> {
  const now = Date.now()
  const change: Partial<Doc<'displays'>> = { lockedTo: lock, lockEnded: undefined }
  if (lock) change.showing = { artifactId: lock.artifactId, at: Math.max(now, (d.showing?.at ?? 0) + 1) }
  let job: Id<'contentJobs'> | null = null
  if (lock && !opts.fresh && d.lockedTo?.artifactId !== lock.artifactId) {
    change.epoch = d.epoch + 1
    job = await revokeLater(ctx, { userId: d.userId, displayId: d._id, epoch: d.epoch + 1 }, { inMs: opts.revokeInMs })
  } else if (lock && opts.confirm) {
    // Locked to the page it is locked to already: nothing it shows is ended, and its number is
    // not raised. What is asked for is that the content service has its number as it is now,
    // which an earlier lock may not have got through to it, so that what is said of it is so
    job = await revokeLater(ctx, { userId: d.userId, displayId: d._id, epoch: d.epoch }, { inMs: opts.revokeInMs })
  }
  await ctx.db.patch(d._id, change)
  return job
}

/**
 * Keeps every display of one browser's pairing under one lock, after a display has joined that
 * pairing: registered anew, or come back under it. Of the locks its displays have, the one set
 * last is the pairing's, and a display under none is put under it: so a key made afresh, by
 * clearing the site's data or by hand, is no way out of a lock. A pairing none of whose displays
 * is locked leaves them as they are.
 */
async function oneLock(ctx: MutationCtx, d: Doc<'displays'>, opts: { fresh?: boolean } = {}): Promise<void> {
  const all = await ofPairing(ctx, d.sessionId)
  const lock = all.flatMap((x) => (x.lockedTo ? [x.lockedTo] : [])).sort((a, b) => b.at - a.at)[0]
  if (!lock) return
  for (const x of all) if (x.lockedTo?.artifactId !== lock.artifactId || x.lockedTo.at !== lock.at) await putUnder(ctx, x, lock, x._id === d._id ? opts : {})
}

/**
 * How long the revocation a lock asks for waits before it is tried by itself: the lock asks for
 * it at once and waits for the answer, and this is what is left to try again where that failed.
 */
const LOCK_REVOKE_BACKUP_MS = 5_000

/** The lock itself, as one transaction: answers with the revocations it asked for, which `lock` waits for. */
export const _lock = internalMutation({
  args: { displayId: v.id('displays'), artifactId: v.id('artifacts') },
  handler: async (ctx, { displayId, artifactId }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    const page = await ownArtifact(ctx, c.user._id, artifactId)
    if (page.currentVersion === undefined) fail('not_found', 'That page has nothing published yet.')
    const lock = { artifactId: page._id, at: Date.now() }
    const jobs: Id<'contentJobs'>[] = []
    const displayIds: Id<'displays'>[] = []
    for (const x of await ofPairing(ctx, d.sessionId)) {
      const job = await putUnder(ctx, x, lock, { revokeInMs: LOCK_REVOKE_BACKUP_MS, confirm: true })
      if (job) jobs.push(job)
      displayIds.push(x._id)
    }
    log('display.locked', { userId: c.user._id, displayId: d._id, by: c.session.role })
    return { jobs, userId: c.user._id, displayIds }
  },
})

/**
 * Locks a display to one of the person's pages: from then on no agent brings another page up
 * there, it is never the display chosen where an agent names none, a screen is let open no other
 * page there, and the site on it keeps to that page. The page is brought up there at once.
 *
 * Asked by a paired browser and never by an agent: the owner's browser locks any display, and a
 * screen itself and no other. Every display of the same browser's pairing is locked with it.
 *
 * A display locked to another page than it showed is signed out of what it showed, and this
 * answers only once the content service has said so: from then on a showing the display had of
 * another page, and a ticket it was given for one, open nothing. `revoked` is false where the
 * content service could not be told just now, or has yet to take in any revocation of the
 * display's, by this lock or another. The display is locked all the same, and It goes on telling
 * the content service until it hears, as it does for a sign-out. A lock to the page a display is
 * locked to already ends nothing, and asks the content service only to confirm the number the
 * display has now.
 */
export const lock = action({
  args: { displayId: v.id('displays'), artifactId: v.id('artifacts') },
  handler: async (ctx, args): Promise<{ revoked: boolean }> => {
    const { jobs, userId, displayIds } = await overClashes(() => ctx.runMutation(internal.displays._lock, args))
    const told = await Promise.all(jobs.map((jobId) => ctx.runAction(internal.content.revokeNow, { jobId })))
    // Said only where the content service has taken in each display's number as it is now, and
    // nothing is still to be asked of it for any of them: a lock asked for a moment before, or
    // one whose revocation is still being tried, may have left something
    const pending = await ctx.runQuery(internal.content._pendingRevokes, { userId, displayIds })
    return { revoked: told.every(Boolean) && pending === 0 }
  },
})

/** Unlocks a display, and every display of the same browser's pairing: the owner's browser any display, and a screen itself. */
export const unlock = mutation({
  args: { displayId: v.id('displays') },
  handler: async (ctx, { displayId }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    for (const x of await ofPairing(ctx, d.sessionId)) if (x.lockedTo) await putUnder(ctx, x, undefined)
    log('display.unlocked', { userId: c.user._id, displayId: d._id, by: c.session.role })
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
 * Whether agents may show pages and send notifications on a display. The owner's browser says so
 * for any display, and a screen for itself and no other: to a screen another display is none.
 * Agents have no way to change it.
 */
export const allowAgents = mutation({
  args: { displayId: v.id('displays'), allowed: v.boolean() },
  handler: async (ctx, { displayId, allowed }) => {
    const c = await requireBrowser(ctx)
    const d = await ownDisplay(ctx, c.user._id, displayId)
    if (!speaksFor(c, d)) fail('not_found', 'No such display.')
    if ((d.agentsOff === true) === !allowed) return null
    await ctx.db.patch(d._id, { agentsOff: allowed ? undefined : true })
    log('display.agents', { userId: c.user._id, displayId: d._id, allowed })
    return null
  },
})

/**
 * An agent asks for a page to be brought up: on one display named by its id, on every display of
 * a name, on every display agents may use with `everywhere`, or, where it names none, on the one
 * display the person is most likely using (`lib/aim.ts`). The answer names the displays it is
 * shown on, with their ids in `displayIds`, says in `chosen` why a display was chosen where none
 * was named, and lists in `notShown` each other display with why it was not shown there:
 * `not_paired` for a display whose browser's pairing has ended, which shows nothing until that
 * browser is paired again; `agents_off` for one the person said agents may not use; `locked` for
 * one locked to another page, or, where none was named, to any page; and `not_chosen` for one
 * passed over for the display in use.
 */
export const show = mutation({
  args: {
    slug: v.string(),
    display: v.optional(v.string()),
    displayId: v.optional(v.string()),
    everywhere: v.optional(v.boolean()),
    session: v.optional(session),
    agent: v.optional(v.string()),
  },
  handler: async (ctx, { slug, display, displayId, everywhere, session: mine, agent }) => {
    const { user, machine } = await requireMachine(ctx)
    const target = targetOf({ display, displayId, everywhere })
    await rateLimit(ctx, 'show', user._id)
    const artifact = (await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')
    const aimed = await aim(ctx, user._id, target, { page: artifact._id })
    for (const d of aimed.to) {
      // The time of a showing is what a display goes by to tell a new asking from one it has
      // seen, and so it never goes back: a clock that was set back would otherwise have every
      // display ignore what it is asked to show until the clock had caught up again
      await ctx.db.patch(d._id, { showing: { artifactId: artifact._id, at: Math.max(Date.now(), (d.showing?.at ?? 0) + 1) } })
    }
    // A page changes owner only if at least one requested display can show it. All display
    // changes and ownership changes commit together, including the rate-limit checks.
    const took = mine && aimed.to.length ? (await takePage(ctx, artifact, machine, mine, agent)).took : false
    // The page's address, as a publish gives it: the site's on this computer, and the link at
    // the place the owner chose for links where It can be reached there. An agent gives it to the
    // person where no display brought the page up, or where it went to one they may not be at
    const at = await linkNow(ctx)
    return {
      displays: aimed.to.map(nameOf),
      displayIds: aimed.to.map((d) => d._id),
      notShown: aimed.notShown,
      took,
      ...(aimed.chosen ? { chosen: aimed.chosen } : {}),
      url: `${site()}/p/${artifact.slug}`,
      ...(at && 'at' in at ? { link: `${at.at}/p/${artifact.slug}` } : at ? { unlinked: at.unlinked } : {}),
    }
  },
})
