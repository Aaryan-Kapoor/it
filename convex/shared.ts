// A page that several conversations share. The page still belongs to one conversation, which
// is where what a person does on it goes. Other conversations of the same person join it under
// a name, and every member may post to the others on it and read what was posted. A post is
// never the person's word: it is kept under the name of the member that made it, apart from
// what the person does on the page.
//
// Every function here takes the conversation it is called for as an argument, so that whatever
// carries an agent's call (the `it` command, or anything else a machine of the person's runs)
// says the same thing in the same way.
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { ownArtifact, requireCaller, requireMachine, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { session } from './schema'
import { write } from './state'

/** The most conversations that may share one page, the one it belongs to among them. */
export const MEMBERS = 8
/** The most a post may be long, in characters. */
export const POST_TEXT = 2000
/** How many of the last posts a page is given in its state. */
export const SHOWN = 30
/** The name the conversation a page belongs to has until it joins under another. */
export const OWNER = 'owner'
/** Names no member may take: they would read as the person, or as every member. */
const TAKEN = ['person', 'all', 'everyone', 'it']

type Session = { harness: string; id: string }
type Member = { name: string; owner: boolean; machineId?: Id<'machines'>; session: Session; joinedAt: number }

const same = (a: Session | undefined, b: Session) => a !== undefined && a.harness === b.harness && a.id === b.id

/** Everyone on a page: the conversation it belongs to first, under the name it joined as or else `owner`, and then those that joined. */
export function membersOf(a: Doc<'artifacts'>): Member[] {
  const joined = a.members ?? []
  const owning = a.session
  const listed = joined.map((m) => ({ ...m, owner: m.machineId === a.machineId && same(owning, m.session) }))
  if (!owning || listed.some((m) => m.owner)) return listed.sort((x, y) => Number(y.owner) - Number(x.owner))
  return [{ name: OWNER, owner: true, machineId: a.machineId, session: owning, joinedAt: a.createdAt }, ...listed]
}

const memberFor = (a: Doc<'artifacts'>, machineId: Id<'machines'>, s: Session) => membersOf(a).find((m) => m.machineId === machineId && same(m.session, s))

/** What a page is given of its members and their last posts, under `shared` in its state. */
async function show(ctx: MutationCtx, a: Doc<'artifacts'>): Promise<void> {
  const page = (await ctx.db.get(a._id))!
  const last = await ctx.db
    .query('posts')
    .withIndex('by_artifact_seq', (q) => q.eq('artifactId', a._id))
    .order('desc')
    .take(SHOWN)
  const shared = {
    members: membersOf(page).map((m) => ({ name: m.name, owner: m.owner })),
    posts: last.reverse().map((p) => ({ seq: p.seq, from: p.from, ...(p.to ? { to: p.to } : {}), text: p.text, at: p.at })),
  }
  await write(ctx, a.userId, a._id, (current) => ({ ...current, shared }))
}

/** A conversation joins a page under a name, or takes another name on a page it is on already. */
export const join = mutation({
  args: { slug: v.string(), session, name: v.string() },
  handler: async (ctx, { slug, session: s, name }) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolveArtifact(ctx, user._id, { slug })
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(name) || TAKEN.includes(name))
      fail('invalid', 'A member’s name is 1 to 24 lowercase letters, digits or dashes, begins with a letter, and is not person, all, everyone or it.')
    if (!a.session) fail('invalid', 'This page belongs to no conversation, so there is nobody to share it with.')
    if ((a.removed ?? []).some((r) => r.machineId === machine._id && same(r.session, s)))
      fail('forbidden', 'This conversation was taken off this page by the person, and may not join it again.')
    const everyone = membersOf(a)
    const me = everyone.find((m) => m.machineId === machine._id && same(m.session, s))
    if (everyone.some((m) => m.name === name && m !== me)) fail('conflict', `Another conversation on this page is called ${name}. Join under another name.`)
    if (!me && everyone.length >= MEMBERS) fail('limit', `A page is shared by at most ${MEMBERS} conversations.`)
    const others = (a.members ?? []).filter((m) => !(m.machineId === machine._id && same(m.session, s)))
    const members = [...others, { name, machineId: machine._id, session: s, joinedAt: me?.joinedAt ?? Date.now() }]
    await ctx.db.patch(a._id, { members })
    // Written down by id and count: never the name it joined under
    log('shared.joined', { artifactId: a._id, machineId: machine._id, members: membersOf({ ...a, members }).length })
    await show(ctx, a)
    return { id: a.slug, name, members: membersOf({ ...a, members }).map((m) => ({ name: m.name, owner: m.owner })) }
  },
})

/** A conversation leaves a page it joined. The conversation the page belongs to cannot leave it: the page is its own. */
export const leave = mutation({
  args: { slug: v.string(), session },
  handler: async (ctx, { slug, session: s }) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolveArtifact(ctx, user._id, { slug })
    const members = (a.members ?? []).filter((m) => !(m.machineId === machine._id && same(m.session, s)))
    const left = members.length !== (a.members ?? []).length
    if (left) {
      await ctx.db.patch(a._id, { members })
      log('shared.left', { artifactId: a._id, machineId: machine._id, members: membersOf({ ...a, members }).length })
      await show(ctx, a)
    }
    return { id: a.slug, left }
  },
})

/** A member posts to the others on the page, or to one of them by name. Only a member may. */
export const post = mutation({
  args: { slug: v.string(), session, text: v.string(), to: v.optional(v.string()) },
  handler: async (ctx, { slug, session: s, text, to }) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolveArtifact(ctx, user._id, { slug })
    const me = memberFor(a, machine._id, s) ?? fail('forbidden', 'Only a conversation that has joined this page may post on it. Join it first.')
    const said = text.trim()
    if (!said) fail('invalid', 'There is nothing to post.')
    if (said.length > POST_TEXT) fail('limit', `A post is at most ${POST_TEXT} characters. Put anything longer on the page itself.`)
    if (to !== undefined && !membersOf(a).some((m) => m.name === to)) fail('not_found', `Nobody on this page is called ${to}.`)
    if (to === me.name) fail('invalid', 'A post is for another member of the page.')
    // Numbered under the page's record, so that of two posts made at once the one committed later has the higher number
    const seq = (a.postSeq ?? 0) + 1
    await ctx.db.patch(a._id, { postSeq: seq })
    await ctx.db.insert('posts', { userId: user._id, artifactId: a._id, seq, from: me.name, ...(to ? { to } : {}), text: said, at: Date.now() })
    // Counted and never quoted
    log('shared.posted', { artifactId: a._id, machineId: machine._id, seq, named: to !== undefined })
    await show(ctx, a)
    return { id: a.slug, seq, from: me.name }
  },
})

/** Who is on a page and what was posted on it after a given post, oldest first. Reading marks nothing as handled. */
export const read = query({
  args: { ...ref, after: v.optional(v.number()), session: v.optional(session) },
  handler: async (ctx, { after, session: s, ...which }) => {
    const c = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, c.user._id, which)
    const posts = await ctx.db
      .query('posts')
      .withIndex('by_artifact_seq', (q) => q.eq('artifactId', a._id).gt('seq', after ?? 0))
      .take(100)
    const everyone = membersOf(a)
    const me = c.kind === 'machine' && s ? everyone.find((m) => m.machineId === c.machine._id && same(m.session, s)) : undefined
    return {
      id: a.slug,
      // The name the asking conversation has here, where it is a member
      ...(me ? { you: me.name } : {}),
      members: everyone.map((m) => ({
        name: m.name,
        owner: m.owner,
        harness: m.session.harness,
        // Which machine and conversation each is, is the person's to see and nothing a page is told
        ...(c.kind === 'browser' ? { machineId: m.machineId ?? null, sessionId: m.session.id } : {}),
      })),
      posts: posts.map((p) => ({ seq: p.seq, from: p.from, to: p.to ?? null, text: p.text, at: p.at })),
      through: posts.length ? posts[posts.length - 1]!.seq : (after ?? 0),
    }
  },
})

/**
 * The person takes a member off a page, from a browser of their own. That conversation may not
 * post on the page or join it again. The conversation the page belongs to is not taken off so:
 * stopping it, or another conversation taking the page, is how the person ends its part.
 */
export const remove = mutation({
  args: { artifactId: v.id('artifacts'), name: v.string(), expectedSession: v.optional(v.string()) },
  handler: async (ctx, { artifactId, name, expectedSession }) => {
    const c = await requireOwner(ctx, expectedSession)
    const a = await ownArtifact(ctx, c.user._id, artifactId)
    const gone = (a.members ?? []).find((m) => m.name === name)
    if (!gone) fail('not_found', `Nobody who joined this page is called ${name}.`)
    if (gone.machineId === a.machineId && same(a.session, gone.session))
      fail('invalid', 'This page belongs to that conversation. Stop it from the page, or have another conversation take the page.')
    const members = (a.members ?? []).filter((m) => m !== gone)
    // The last fifty taken off are remembered, which is more than a page has members
    const removed = [...(a.removed ?? []), { machineId: gone.machineId, session: gone.session, at: Date.now() }].slice(-50)
    await ctx.db.patch(a._id, { members, removed })
    log('shared.removed', { artifactId: a._id, machineId: gone.machineId, members: membersOf({ ...a, members }).length })
    await show(ctx, a)
    return { removed: true }
  },
})
