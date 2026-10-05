// Pairing a browser. A browser is let in by a code that one of the person's
// machines asked for, or that a browser already let in as the owner's asked for. The code is
// traded once for a session, which the browser holds as a cookie of that session's own
// (http.ts), and which earns it a five-minute token as often as it asks. Neither a code nor a
// session's secret is kept: only the hash of each.
//
// A session is what the person sees of a paired browser, and what they end. Every code, and
// the session or the machine that comes of it, records what asked for it, so that the person
// can be told what let each browser in, and so that ending a browser or revoking a machine
// ends all that came of it.
//
// Ending is not the same as leaving. The owner ending a browser, forgetting its display, or
// revoking a machine ends what that browser or machine let in as well: the screens it paired,
// the machines it added, and theirs in turn. A browser that signs itself out, is paired again,
// goes unused for a year, or is ended to make room for another ends by itself, and what it let
// in stays: a person who signs out of their laptop does not expect the screen in the kitchen
// to go dark.
import { QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { revokeLater } from './content'
import { type Caller, ownSession, requireMachine, requireMachineOrOwner, requireOwner } from './lib/authz'
import { cookieFor } from './lib/cookie'
import { sha256 } from './lib/hash'
import { rateLimit, saidSeldom } from './lib/limits'
import { log } from './lib/log'

/** How long a code is good for. */
const CODE_MS = 600_000
/** Thirty-two characters, so that each character of a code is five bits of it: the lowercase letters and the digits 2 to 7, which leaves out the 0 and the 1 that are taken for an o and an l. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
/**
 * How many browsers may be paired at once. There is a most, so that every one of them can be
 * read and shown to the person: a paired browser nobody can be shown is one nobody can end.
 */
const PAIRED = 50
/** More codes than can be waiting at once: they are asked for only so often, and wait ten minutes. */
const WAITING = 200
/**
 * How long a session lasts with nothing asking with it. A browser keeps its cookie for a year
 * from when it was last given it, and is given it again while it is used.
 */
export const UNUSED_MS = 366 * 86_400_000
/** How many cookies of sessions that are over one answer clears. A browser that holds more is told of the rest the next time it asks. */
const CLEARED = 4

type Role = Doc<'invites'>['role']
/** What asked for a code, as it is kept with the code and with what comes of it (schema.ts). */
type InvitedBy = Pick<Doc<'invites'>, 'byMachine' | 'bySession'>
/** The same, as it is passed from a code to the session or the machine that comes of it. */
export const invitedBy = (from: InvitedBy): InvitedBy => ({
  ...(from.byMachine ? { byMachine: from.byMachine } : {}),
  ...(from.bySession ? { bySession: from.bySession } : {}),
})

async function invite(ctx: MutationCtx, c: Caller, role: Role): Promise<{ code: string; expiresAt: number }> {
  const userId = c.user._id
  await rateLimit(ctx, 'invite', userId)
  const code = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => ALPHABET[b & 31]).join('')
  const now = Date.now()
  // A machine that asks is what the code descends from. A browser that asks hands on the
  // machine it descends from itself, and is named beside it.
  const by = c.kind === 'machine' ? { byMachine: c.machine._id } : invitedBy({ byMachine: c.session.byMachine, bySession: c.session._id })
  await ctx.db.insert('invites', { userId, codeHash: await sha256(code), role, createdAt: now, expiresAt: now + CODE_MS, ...by })
  log('invite.made', { userId, role, by: c.kind })
  return { code, expiresAt: now + CODE_MS }
}

/** A code for the machine's own browser: `it site` asks for one and opens the site with it. Only a machine may ask. */
export const inviteOwner = mutation({
  args: {},
  handler: async (ctx) => invite(ctx, await requireMachine(ctx), 'owner'),
})

/** A code for another screen, which the owner's browser shows as an address and as a QR code. Only the owner's browser may ask. */
export const inviteScreen = mutation({
  args: {},
  handler: async (ctx) => invite(ctx, await requireOwner(ctx), 'screen'),
})

/** A code for another machine to enrol with. A machine may ask, or the owner's browser. */
export const inviteMachine = mutation({
  args: {},
  handler: async (ctx) => invite(ctx, await requireMachineOrOwner(ctx), 'machine'),
})

/**
 * The invite a code names, if it is one of these kinds and can still be used. The caller marks
 * it used once what it was for is done. What keeps a code from being come upon by trying is the
 * code itself: a hundred random bits, good for ten minutes, and good once. Whoever sends one is
 * nobody yet, so nothing is counted against anyone here: a wrong code, from anyone and however
 * often, takes nothing from a right one.
 */
export async function inviteFor(ctx: MutationCtx, codeHash: string, roles: readonly Role[]): Promise<Doc<'invites'> | null> {
  const now = Date.now()
  const named = await ctx.db
    .query('invites')
    .withIndex('by_code', (q) => q.eq('codeHash', codeHash))
    .first()
  if (named && roles.includes(named.role) && named.usedAt === undefined && named.expiresAt > now) return named
  // Why, for whoever is asked later why a display could not be paired. Never the code. Anyone
  // can send a wrong code as often as they like, so it is said once a minute and not each time.
  const reason = !named ? 'unknown' : !roles.includes(named.role) ? 'another_kind' : named.usedAt !== undefined ? 'used' : 'expired'
  if (await saidSeldom(ctx, 'code.refused')) log('code.refused', { reason }, 'warn')
  return null
}

/** What a request presented as a session: the name of each cookie of the family it carried, and the hash of what that cookie held. */
const presentedAs = v.array(v.object({ name: v.string(), hash: v.string() }))

/**
 * What a browser holds, among everything it presented: the sessions that are still paired, the
 * one paired last first, and the names of the cookies whose sessions are over, which the answer
 * clears. A cookie counts only under the name of the session its secret is: under any other
 * name it is no session's cookie. None of them is anybody until it is found to be a session.
 *
 * How long a session lasts is judged here, when it is used, and not only by the hourly
 * cleaning, which has not run while It was stopped: a session that nothing has asked with for
 * that long is ended now, as the cleaning would have ended it, and is one of those that are over.
 */
async function among(ctx: MutationCtx, presented: { name: string; hash: string }[]): Promise<{ paired: Doc<'sessions'>[]; over: string[] }> {
  const paired: Doc<'sessions'>[] = []
  const over: string[] = []
  const now = Date.now()
  for (const { name, hash } of presented) {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_secret', (q) => q.eq('secretHash', hash))
      .first()
    if (!session || cookieFor(session._id) !== name) continue
    const unused = session.endedAt === undefined && now - session.lastSeenAt > UNUSED_MS
    if (unused) await endSession(ctx, session._id, 'unused')
    if (session.endedAt === undefined && !unused) paired.push(session)
    else over.push(name)
  }
  paired.sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime)
  return { paired, over }
}

/**
 * Signs a display out: its number goes up, so that what the content service gave it before then
 * stops working, the content service is told so (and told again until it confirms), and nothing
 * more is pushed to it. Answers with the job, for a caller that wants to know when the content
 * service has confirmed.
 */
export async function signOutDisplay(ctx: MutationCtx, d: Doc<'displays'>): Promise<Id<'contentJobs'>> {
  const epoch = d.epoch + 1
  await ctx.db.patch(d._id, { epoch, push: undefined })
  return revokeLater(ctx, { userId: d.userId, displayId: d._id, epoch })
}

/**
 * What ended a session: the browser itself, its being paired again, one of its displays being
 * forgotten, the owner, the ending of the browser that paired it, the revoking of the machine
 * it descends from, room being made for another browser, everything being erased, or a year in
 * which nothing asked with it.
 */
type EndedBy = 'itself' | 'paired_again' | 'forgotten' | 'owner' | 'browser_ended' | 'machine_revoked' | 'room' | 'erased' | 'unused'
/**
 * The endings that take along what the session let in. A session ended with its machine is not
 * among them: everything it let in descends from that machine too, and is ended with it there.
 */
const TAKES_ALONG: ReadonlySet<EndedBy> = new Set(['owner', 'forgotten', 'browser_ended'])

/**
 * Ends a session, at once: the next call made with a token of it is refused, though the token
 * has minutes left to run. Whatever ends a session does it here, so that every ending is the
 * same ending. Each display the session registered is signed out with it, since no page stays
 * open, and nothing more is pushed, under a session that is over. And a code it asked for that
 * is still waiting lets nobody in. False when there was no such session to end.
 *
 * Where the session is ended by the owner, or with the display it is, what it let in is ended
 * with it: the screens paired with its codes, and the machines that joined with them, each
 * with everything that descends from it.
 *
 * `but` is a session that none of this ends, wherever among them it comes: the one the owner
 * asks from when they end every other.
 */
export async function endSession(ctx: MutationCtx, sessionId: Id<'sessions'>, by: EndedBy, but?: Id<'sessions'>): Promise<boolean> {
  if (sessionId === but) return false
  const session = await ctx.db.get(sessionId)
  if (!session || session.endedAt !== undefined) return false
  const now = Date.now()
  await ctx.db.patch(sessionId, { endedAt: now })
  const displays = await ctx.db
    .query('displays')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .take(QUOTA.displays + 1)
  for (const d of displays) await signOutDisplay(ctx, d)
  const waiting = await ctx.db
    .query('invites')
    .withIndex('by_session', (q) => q.eq('bySession', sessionId).gt('expiresAt', now))
    .take(WAITING)
  for (const i of waiting) if (i.usedAt === undefined) await ctx.db.delete(i._id)
  log('session.ended', { userId: session.userId, sessionId, by, displays: displays.length })
  if (!TAKES_ALONG.has(by)) return true
  const screens = await ctx.db
    .query('sessions')
    .withIndex('by_session', (q) => q.eq('bySession', sessionId).eq('endedAt', undefined))
    .take(PAIRED + 1)
  for (const s of screens) await endSession(ctx, s._id, 'browser_ended', but)
  const machines = await ctx.db
    .query('machines')
    .withIndex('by_session', (q) => q.eq('bySession', sessionId).eq('revoked', false))
    .take(QUOTA.machines)
  for (const m of machines) await revokeMachine(ctx, m, 'browser_ended', but)
  return true
}

/**
 * Ends everything a machine can do, at once, and everything that descends from it: the
 * sessions of the browsers paired with its codes and of the screens they added, the machines
 * that enrolled with a code of theirs, and what descends from those in their turn. A code any
 * of them asked for that is still waiting lets nobody in. A machine that an agent has made a
 * browser of its own from, or another machine, takes all of that with it.
 *
 * `by` is what revoked it: the person, the machine itself, the revoking of the machine it came
 * from, or the ending of the browser that added it. `but` is a session that stays paired
 * though it descends from the machine (see `endSession`).
 */
export async function revokeMachine(
  ctx: MutationCtx,
  m: Doc<'machines'>,
  by: 'person' | 'itself' | 'machine_revoked' | 'browser_ended',
  but?: Id<'sessions'>,
): Promise<void> {
  // One that a session's ending reached first, while the machine above it was being revoked, has nothing left to end
  if ((await ctx.db.get(m._id))?.revoked !== false) return
  const now = Date.now()
  await ctx.db.patch(m._id, { revoked: true, revokedAt: now })
  await ctx.scheduler.runAfter(0, internal.delivery.orphan, { machineId: m._id })
  const sessions = await ctx.db
    .query('sessions')
    .withIndex('by_machine', (q) => q.eq('byMachine', m._id).eq('endedAt', undefined))
    .take(PAIRED + 1)
  for (const s of sessions) await endSession(ctx, s._id, 'machine_revoked', but)
  const waiting = await ctx.db
    .query('invites')
    .withIndex('by_machine', (q) => q.eq('byMachine', m._id).gt('expiresAt', now))
    .take(WAITING)
  for (const i of waiting) if (i.usedAt === undefined) await ctx.db.delete(i._id)
  const machines = await ctx.db
    .query('machines')
    .withIndex('by_machine', (q) => q.eq('byMachine', m._id).eq('revoked', false))
    .take(QUOTA.machines)
  log('machine.revoked', { userId: m.userId, machineId: m._id, by, browsers: sessions.length, machines: machines.length })
  for (const x of machines) await revokeMachine(ctx, x, 'machine_revoked', but)
}

/**
 * The machines that descend from any of `from`, those included: every machine that enrolled
 * with a code one of them asked for, or that a browser descending from one of them asked for.
 */
export function lineOf(all: Doc<'machines'>[], from: Iterable<Id<'machines'>>): Set<Id<'machines'>> {
  const line = new Set(from)
  for (let more = true; more; ) {
    more = false
    for (const x of all) {
      if (!x.byMachine || !line.has(x.byMachine) || line.has(x._id)) continue
      line.add(x._id)
      more = true
    }
  }
  return line
}

/** The sessions of a person that have not ended. There are never more than may be paired at once. */
export const pairedOf = (ctx: QueryCtx | MutationCtx, userId: Id<'users'>): Promise<Doc<'sessions'>[]> =>
  ctx.db
    .query('sessions')
    .withIndex('by_user', (q) => q.eq('userId', userId).eq('endedAt', undefined))
    .take(PAIRED + 1)

/**
 * Every browser that is paired, for the owner's browser to show: which kind it is, when it was
 * paired and when it last asked for a token, whether it is the one asking, the displays it
 * registered (none, for a browser that never registered as one), and what asked for the code
 * it was paired with: a machine, or a browser, which is named by its display where it has one
 * and is said to be paired still or not. The asker's own comes first, and then the one seen
 * latest.
 *
 * `along` is what the owner ending it would end with it: the browsers and the machines that
 * came from it, each by its id, so that the site can say how many before the person confirms,
 * and whether the browser they are reading on is one of them.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user, session } = await requireOwner(ctx)
    const displays = await ctx.db
      .query('displays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(QUOTA.displays + 1)
    const machines = await ctx.db
      .query('machines')
      .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
      .take(QUOTA.machines)
    const paired = await pairedOf(ctx, user._id)
    /** The displays a session registered, each by its id and its name. */
    const shownBy = (id: Id<'sessions'>) => displays.filter((d) => d.sessionId === id).map((d) => ({ id: d._id, name: d.name ?? d.generatedName }))
    const out = []
    for (const s of paired) {
      const machine = s.byMachine && !s.bySession ? (machines.find((m) => m._id === s.byMachine)?.name ?? null) : null
      // The machines it added, with all that descend from them, and the browsers that it or any of those let in
      const line = lineOf(
        machines,
        machines.filter((m) => m.bySession === s._id).map((m) => m._id),
      )
      out.push({
        id: s._id,
        role: s.role,
        pairedAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        mine: s._id === session._id,
        displays: shownBy(s._id),
        // A machine by its name. A browser by the name of the display it is, where it is still
        // paired and is one: its own pairing may have ended since, and what it let in stayed
        invitedBy: s.bySession
          ? { kind: 'browser' as const, paired: paired.some((x) => x._id === s.bySession), name: shownBy(s.bySession)[0]?.name ?? null }
          : typeof machine === 'string'
            ? { kind: 'machine' as const, name: machine }
            : null,
        along: {
          browsers: paired.filter((x) => x.bySession === s._id || (x.byMachine !== undefined && line.has(x.byMachine))).map((x) => x._id),
          machines: [...line],
        },
      })
    }
    return out.sort((a, b) => Number(b.mine) - Number(a.mine) || b.lastSeenAt - a.lastSeenAt || b.pairedAt - a.pairedAt)
  },
})

/**
 * The owner ends one paired browser's session, which may be their own, and with it what that
 * browser let in. One that has ended already is ended no further.
 */
export const end = mutation({
  args: { session: v.id('sessions') },
  handler: async (ctx, { session }) => {
    const { user } = await requireOwner(ctx)
    await endSession(ctx, (await ownSession(ctx, user._id, session))._id, 'owner')
    return null
  },
})

/**
 * The owner ends every paired browser's session but the one they ask from, each with what it
 * let in. The one they ask from stays paired whatever it came from. Says how many browsers
 * were ended.
 *
 * Where the machine it came from went with one of the others, which added that machine, it is
 * from then on a browser of the nearest machine above that one which is still enrolled, so
 * that revoking that machine ends it as it ends every other browser that came from it.
 */
export const endOthers = mutation({
  args: {},
  handler: async (ctx) => {
    const { user, session } = await requireOwner(ctx)
    const before = await pairedOf(ctx, user._id)
    for (const s of before) await endSession(ctx, s._id, 'owner', session._id)
    let above = session.byMachine ? await ctx.db.get(session.byMachine) : null
    for (let up = 0; above?.revoked && up < QUOTA.machines; up++) above = above.byMachine ? await ctx.db.get(above.byMachine) : null
    const from = above && !above.revoked ? above._id : undefined
    if (from !== session.byMachine) await ctx.db.patch(session._id, { byMachine: from })
    return { ended: before.length - (await pairedOf(ctx, user._id)).length }
  },
})

/**
 * What a code is for, without using it: `owner` or `screen` for a code that would pair a
 * browser now, and null for any other. A site that is opened at an address with a code in it
 * asks this first, so that a screen's code is traded only when the person at that browser says
 * it is the screen: the address alone, opened in the owner's own browser at another of the
 * machine's names, makes nothing of that browser and uses nothing up. Nothing but the role is
 * said, and only to whoever holds the code, who could trade it.
 */
export const _codeFor = internalMutation({
  args: { codeHash: v.string() },
  handler: async (ctx, { codeHash }) => {
    const named = await inviteFor(ctx, codeHash, ['owner', 'screen'])
    if (!named || named.role === 'machine') return null
    const user = await ctx.db.get(named.userId)
    return user && !user.deletedAt ? named.role : null
  },
})

/**
 * Whether It still holds anything for the person with this id. A browser that finds it is not
 * paired asks this of the person it was last paired for, whose id it kept: when everything has
 * been erased there is no such person, and the browser lets go of what it kept for them. To
 * whoever does not have that id, which nobody could guess, every answer is the same.
 */
export const _personThere = internalQuery({
  args: { person: v.string() },
  handler: async (ctx, { person }) => {
    const id = ctx.db.normalizeId('users', person)
    const user = id ? await ctx.db.get(id) : null
    return user !== null && !user.deletedAt
  },
})

/**
 * Trades a code for a session. Null for a code that is wrong, used or expired. The
 * browser's secret is made by the caller, and only its hash comes here. The answer names the
 * new session, and with it the cookies of sessions that are over, for the route to clear.
 *
 * A code for a screen is not traded in the owner's own browser. The owner makes one for
 * another screen, and may open its address where they are, to look at it: redeemed there, it
 * would make their browser a screen, and they would have to pair it again from the machine. It
 * is refused as `owner`, and the code is left unspent for the screen it was made for.
 */
export const _redeem = internalMutation({
  args: {
    codeHash: v.string(),
    secretHash: v.string(),
    /** What the same browser presented as the sessions it held until now. */
    presented: presentedAs,
  },
  handler: async (ctx, { codeHash, secretHash, presented }) => {
    const named = await inviteFor(ctx, codeHash, ['owner', 'screen'])
    if (!named || named.role === 'machine') return null
    const user = await ctx.db.get(named.userId)
    if (!user || user.deletedAt) return null
    const { paired: before, over } = await among(ctx, presented)
    const here = before.filter((s) => s.userId === user._id)
    const owners = here.find((s) => s.role === 'owner')
    if (named.role === 'screen' && owners) {
      log('code.kept', { userId: user._id, sessionId: owners._id, reason: 'owner_here' })
      return { refused: 'owner' as const }
    }
    const now = Date.now()
    await ctx.db.patch(named._id, { usedAt: now })
    // A browser holds one session. Whatever it held ends as the new one begins, so that pairing
    // the same browser again and again leaves no session behind that nothing holds.
    for (const s of here) if (await endSession(ctx, s._id, 'paired_again')) over.unshift(cookieFor(s._id))
    // And only so many are paired at once. Room for one more is made by ending the one that
    // has gone longest without asking for a token: a browser that is open asks every few minutes.
    const paired = await pairedOf(ctx, user._id)
    if (paired.length >= PAIRED) await endSession(ctx, paired.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b))._id, 'room')
    const sessionId = await ctx.db.insert('sessions', {
      userId: user._id,
      secretHash,
      role: named.role,
      createdAt: now,
      lastSeenAt: now,
      cookieAt: now,
      ...invitedBy(named),
    })
    log('session.begun', { userId: user._id, sessionId, role: named.role })
    return { sessionId, over: over.slice(0, CLEARED) }
  },
})

/**
 * The session a browser holds, for a token to be made for it, and the cookies of sessions that
 * are over, for the route to clear. Counted against the session's own limit. When it was last
 * seen is noted once an hour and no oftener: every live query of that browser reads the session
 * to know who is asking, and would run again each time it changed.
 *
 * A browser holds one session. Where it presents more than one that is still paired, which two
 * tabs redeeming a code each at the same moment leave it with, it is the one paired last, and
 * the others end as they would have had the browser presented them when it was paired again.
 *
 * A browser that is used stays paired. Its cookie lasts a year from when it was given, so once
 * the one it holds is more than a day old it is to be given again: `renew` says so.
 */
export const _present = internalMutation({
  args: { presented: presentedAs },
  handler: async (ctx, { presented }) => {
    const { paired, over } = await among(ctx, presented)
    const [session, ...older] = paired
    const user = session ? await ctx.db.get(session.userId) : null
    if (!session || !user || user.deletedAt) return { session: null, over: over.slice(0, CLEARED) }
    for (const s of older) if (await endSession(ctx, s._id, 'paired_again')) over.unshift(cookieFor(s._id))
    await rateLimit(ctx, 'sessionToken', session._id)
    const now = Date.now()
    const renew = now - session.cookieAt > 86_400_000
    if (renew || now - session.lastSeenAt >= 3_600_000) await ctx.db.patch(session._id, { lastSeenAt: now, ...(renew ? { cookieAt: now } : {}) })
    return { session: { sessionId: session._id, userId: user._id, role: session.role, renew }, over: over.slice(0, CLEARED) }
  },
})

/**
 * The browser signs itself out. It names the session it means to end, and that session is ended
 * only when the browser presents that session's own cookie: `ended`. A tab left open from
 * before the browser was paired again names a session the browser holds no more, and ends
 * nothing: `another`. And where nothing presented is a session still paired, there is nothing
 * to end: `none`.
 *
 * Whichever it is, the cookie of the session it named is among those to clear once that
 * session is over, or is no session at all: a cookie is named for one session, so clearing it
 * takes nothing from whatever session the browser holds by then.
 */
export const _end = internalMutation({
  args: { presented: presentedAs, session: v.string() },
  handler: async (ctx, { presented, session }) => {
    const { paired, over } = await among(ctx, presented)
    const id = ctx.db.normalizeId('sessions', session)
    const mine = paired.find((s) => s._id === id)
    if (mine) await endSession(ctx, mine._id, 'itself')
    const named = id ? await ctx.db.get(id) : null
    if (id && (!named || named.endedAt !== undefined)) over.unshift(cookieFor(id))
    return { ended: mine ? ('ended' as const) : paired.length ? ('another' as const) : ('none' as const), over: [...new Set(over)].slice(0, CLEARED) }
  },
})
