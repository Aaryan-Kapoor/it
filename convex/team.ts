// The team. A teammate is someone the person works with, who has browsers of their own in this
// It: each is a screen paired for that teammate, which is shown the pages shared with the team
// and the pages sent to the teammate, and nothing else of the person's. It is built on what
// pairing already is: a code that works once and for ten minutes, a session that can be seen on
// the Displays page and ended, and an ending that takes along whatever came from it.
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { ownArtifact, requireBrowser, requireCaller, requireMachineOrOwner, requireOwner, shownTo, teammateOf } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { endSession, invite as inviteCode } from './sessions'

/** The most teammates a team has. */
export const TEAMMATES = 20

const teamOf = async (ctx: QueryCtx, userId: Id<'users'>) =>
  (
    await ctx.db
      .query('teammates')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
  ).filter((t) => t.removedAt === undefined)

async function named(ctx: QueryCtx, userId: Id<'users'>, name: string): Promise<Doc<'teammates'>> {
  return (await teamOf(ctx, userId)).find((t) => t.name === name) ?? fail('not_found', 'Nobody on the team has that name.')
}

/** The browsers that are paired for a teammate now. */
const browsersOf = async (ctx: QueryCtx, t: Doc<'teammates'>) =>
  (
    await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', t.userId).eq('endedAt', undefined))
      .collect()
  ).filter((s) => s.teammate === t._id)

/**
 * The person invites a teammate, or asks for one more code for a teammate there is: a code
 * that pairs one browser as that teammate's, as a screen's code pairs a screen. Only the
 * person's own browser may ask.
 */
export const invite = mutation({
  args: { name: v.string(), expectedSession: v.optional(v.string()) },
  handler: async (ctx, { name, expectedSession }) => {
    const c = await requireOwner(ctx, expectedSession)
    const called = name.trim()
    if (!called || called.length > 40) fail('invalid', 'A teammate’s name is 1 to 40 characters.')
    const team = await teamOf(ctx, c.user._id)
    let teammate = team.find((t) => t.name === called)?._id
    if (!teammate) {
      if (team.length >= TEAMMATES) fail('limit', `A team has at most ${TEAMMATES} teammates.`)
      teammate = await ctx.db.insert('teammates', { userId: c.user._id, name: called, createdAt: Date.now() })
      // By id and count, never by the name the person typed
      log('team.invited', { userId: c.user._id, teammate, teammates: team.length + 1 })
    }
    return { teammate, ...(await inviteCode(ctx, c, 'screen', teammate)) }
  },
})

/**
 * The person removes a teammate. Every browser paired for them is ended as the person ends a
 * paired browser on the Displays page, which takes along whatever came from it, a code of
 * theirs that still waits lets nobody in, and every page that was out with them for review
 * is theirs no more.
 */
export const remove = mutation({
  args: { teammate: v.id('teammates'), expectedSession: v.optional(v.string()) },
  handler: async (ctx, { teammate, expectedSession }) => {
    const c = await requireOwner(ctx, expectedSession)
    const t = await ctx.db.get(teammate)
    if (!t || t.userId !== c.user._id || t.removedAt !== undefined) fail('not_found', 'Nobody on the team is that teammate.')
    await ctx.db.patch(t._id, { removedAt: Date.now() })
    const browsers = await browsersOf(ctx, t)
    for (const s of browsers) await endSession(ctx, s._id, 'owner')
    const waiting = (
      await ctx.db
        .query('invites')
        .withIndex('by_user', (q) => q.eq('userId', c.user._id))
        .collect()
    ).filter((i) => i.teammate === t._id && i.usedAt === undefined)
    for (const i of waiting) await ctx.db.delete(i._id)
    const pages = await ctx.db
      .query('artifacts')
      .withIndex('by_user_updated', (q) => q.eq('userId', c.user._id))
      .collect()
    for (const a of pages)
      if ((a.sentTo ?? []).some((x) => x.teammate === t._id)) await ctx.db.patch(a._id, { sentTo: (a.sentTo ?? []).filter((x) => x.teammate !== t._id) })
    log('team.removed', { userId: c.user._id, teammate: t._id, browsers: browsers.length })
    return { removed: true, browsers: browsers.length }
  },
})

/** The team, for the person: each teammate, how many browsers are paired for them, and how many pages are out with them. A teammate's browser is told its own name and nothing of the others. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const c = await requireCaller(ctx)
    const mine = teammateOf(c)
    const team = await teamOf(ctx, c.user._id)
    if (c.kind === 'browser' && c.session.role !== 'owner') return { you: team.find((t) => t._id === mine)?.name ?? null, teammates: [] }
    const pages = await ctx.db
      .query('artifacts')
      .withIndex('by_user_updated', (q) => q.eq('userId', c.user._id))
      .collect()
    const teammates = []
    for (const t of team)
      teammates.push({
        id: t._id,
        name: t.name,
        since: t.createdAt,
        browsers: (await browsersOf(ctx, t)).length,
        reviewing: pages.filter((a) => (a.sentTo ?? []).some((x) => x.teammate === t._id && x.backAt === undefined)).length,
      })
    return { you: null, teammates }
  },
})

/** A page is shared with the whole team, or made private again. The person may say, or an agent of theirs: an agent is a full member of the team's work. */
export const share = mutation({
  args: { ...ref, team: v.boolean() },
  handler: async (ctx, { team, ...which }) => {
    const c = await requireMachineOrOwner(ctx)
    await rateLimit(ctx, 'patchState', c.user._id)
    const a = await resolveArtifact(ctx, c.user._id, which)
    await ctx.db.patch(a._id, { team })
    log('team.shared', { artifactId: a._id, team, by: c.kind })
    return { id: a.slug, team }
  },
})

/** A page is sent to a teammate for review, by the person or by an agent of theirs. It is theirs to open and act on until they send it back. */
export const send = mutation({
  args: { ...ref, to: v.string() },
  handler: async (ctx, { to, ...which }) => {
    const c = await requireMachineOrOwner(ctx)
    await rateLimit(ctx, 'patchState', c.user._id)
    const a = await resolveArtifact(ctx, c.user._id, which)
    const t = await named(ctx, c.user._id, to)
    const sentTo = [...(a.sentTo ?? []).filter((x) => x.teammate !== t._id), { teammate: t._id, at: Date.now() }]
    await ctx.db.patch(a._id, { sentTo })
    log('team.sent', { artifactId: a._id, teammate: t._id, by: c.kind })
    return { id: a.slug, sent: true }
  },
})

async function back(ctx: MutationCtx, a: Doc<'artifacts'>, teammate: Id<'teammates'>): Promise<void> {
  const now = Date.now()
  await ctx.db.patch(a._id, { sentTo: (a.sentTo ?? []).map((x) => (x.teammate === teammate && x.backAt === undefined ? { ...x, backAt: now } : x)) })
}

/** A teammate sends a page back that was sent to them. From then it is no page of theirs, unless it is the team's. */
export const sendBack = mutation({
  args: { artifactId: v.id('artifacts'), expectedSession: v.optional(v.string()) },
  handler: async (ctx, { artifactId, expectedSession }) => {
    const c = await requireBrowser(ctx, expectedSession)
    const teammate = teammateOf(c) ?? fail('forbidden', 'Only a teammate sends back a page that was sent to them.')
    const a = await ownArtifact(ctx, c.user._id, artifactId)
    if (!(a.sentTo ?? []).some((x) => x.teammate === teammate && x.backAt === undefined)) fail('invalid', 'This page was not sent to you.')
    await back(ctx, a, teammate)
    log('team.sent_back', { artifactId: a._id, teammate })
    return { back: true }
  },
})

/**
 * What was sent for review. To a teammate's browser: the pages out with them, newest first. To
 * the person and their agents: every page that is out with anyone or has come back, with whom
 * and since when.
 */
export const inbox = query({
  args: {},
  handler: async (ctx) => {
    const c = await requireCaller(ctx)
    const mine = teammateOf(c)
    if (c.kind === 'browser' && c.session.role !== 'owner' && mine === null) return []
    const names = new Map((await teamOf(ctx, c.user._id)).map((t) => [t._id as string, t.name]))
    const pages = await ctx.db
      .query('artifacts')
      .withIndex('by_user_updated', (q) => q.eq('userId', c.user._id))
      .order('desc')
      .collect()
    const out = []
    for (const a of pages)
      for (const x of a.sentTo ?? []) {
        if (mine !== null ? x.teammate !== mine || x.backAt !== undefined || !shownTo(mine, a) : !names.has(x.teammate)) continue
        out.push({ id: a._id, slug: a.slug, title: a.title, at: x.at, back: x.backAt ?? null, ...(mine === null ? { to: names.get(x.teammate)! } : {}) })
      }
    return out.sort((x, y) => y.at - x.at)
  },
})
