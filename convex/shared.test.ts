/// <reference types="vite/client" />
// A page that several conversations share. What it must get right: only a conversation that
// joined may post, a post is kept under its member's name and never as something the person
// did, each member reads the others' posts in order, and the person can take a member off.
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

const WRITER = { harness: 'claude-code', id: 'conversation-1' }
const REVIEWER = { harness: 'codex', id: 'conversation-2' }
const STRANGER = { harness: 'codex', id: 'conversation-3' }

/** A backend with one person, a machine of theirs, a browser of theirs and a screen, and one page that the writer's conversation made. */
async function withPage() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const { user, owner, screen, machine, page } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const machine = (await ctx.db.query('machines').first())!
    const now = Date.now()
    const paired = (role: 'owner' | 'screen') =>
      ctx.db.insert('sessions', { userId: user._id, secretHash: `no-secret-${role}`, role, createdAt: now, lastSeenAt: now, cookieAt: now })
    const page = await ctx.db.insert('artifacts', {
      userId: user._id,
      slug: 'review',
      title: 'Review',
      currentVersion: 1,
      lastVersion: 1,
      bytes: 10,
      createdAt: now,
      updatedAt: now,
      machineId: machine._id,
      session: WRITER,
      agent: 'claude-code',
    })
    return { user: user._id as string, owner: (await paired('owner')) as string, screen: (await paired('screen')) as string, machine: machine._id as string, page }
  })
  const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: owner, role: 'owner' })
  const display = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: screen, role: 'screen' })
  const agent = t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' })
  const state = async () => JSON.parse((await agent.query(api.state.get, { slug: 'review' })).json)
  const actions = () => t.run((ctx) => ctx.db.query('actions').collect())
  return { t, browser, display, agent, page, state, actions }
}

describe('a page that several conversations share', () => {
  test('has the conversation it belongs to as its first member before anyone joins', async () => {
    const { agent } = await withPage()
    const r = await agent.query(api.shared.read, { slug: 'review', session: WRITER })
    expect(r.members).toEqual([{ name: 'owner', owner: true, harness: 'claude-code' }])
    expect(r.you).toBe('owner')
    expect(r.posts).toEqual([])
  })

  test('lets two conversations each post and each read what the other posted, in order', async () => {
    const { agent, actions } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: WRITER, name: 'writer' })
    const joined = await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    expect(joined.members).toEqual([
      { name: 'writer', owner: true },
      { name: 'reviewer', owner: false },
    ])
    expect(await agent.mutation(api.shared.post, { slug: 'review', session: WRITER, text: ' the patch is ready ', to: 'reviewer' })).toMatchObject({ seq: 1, from: 'writer' })
    expect(await agent.mutation(api.shared.post, { slug: 'review', session: REVIEWER, text: 'line 12 leaks a handle' })).toMatchObject({ seq: 2, from: 'reviewer' })
    // The reviewer reads what the writer said, and the writer what the reviewer said after it
    const all = await agent.query(api.shared.read, { slug: 'review', session: REVIEWER })
    expect(all.you).toBe('reviewer')
    expect(all.posts.map((p) => [p.seq, p.from, p.to, p.text])).toEqual([
      [1, 'writer', 'reviewer', 'the patch is ready'],
      [2, 'reviewer', null, 'line 12 leaks a handle'],
    ])
    const later = await agent.query(api.shared.read, { slug: 'review', session: WRITER, after: 1 })
    expect(later.posts.map((p) => p.seq)).toEqual([2])
    expect(later.through).toBe(2)
    // A post is nothing the person did on the page: it is no action, and reaches no conversation as one
    expect(await actions()).toEqual([])
  })

  test('gives the page its members and their posts under `shared` in its state, and keeps what its agents put there', async () => {
    const { agent, state } = await withPage()
    await agent.mutation(api.state.patch, { slug: 'review', patch: JSON.stringify({ step: 2 }) })
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    await agent.mutation(api.shared.post, { slug: 'review', session: REVIEWER, text: 'looks right' })
    const s = await state()
    expect(s.step).toBe(2)
    expect(s.shared.members).toEqual([
      { name: 'owner', owner: true },
      { name: 'reviewer', owner: false },
    ])
    expect(s.shared.posts).toMatchObject([{ seq: 1, from: 'reviewer', text: 'looks right' }])
  })

  test('refuses a post from a conversation that has not joined', async () => {
    const { agent } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    await expect(agent.mutation(api.shared.post, { slug: 'review', session: STRANGER, text: 'let me in' })).rejects.toThrow(/Only a conversation that has joined/)
    expect((await agent.query(api.shared.read, { slug: 'review' })).posts).toEqual([])
  })

  test('refuses a name another member has, a name that reads as the person, and a post to nobody', async () => {
    const { agent } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    await expect(agent.mutation(api.shared.join, { slug: 'review', session: STRANGER, name: 'reviewer' })).rejects.toThrow(/Another conversation/)
    await expect(agent.mutation(api.shared.join, { slug: 'review', session: STRANGER, name: 'owner' })).rejects.toThrow(/Another conversation/)
    await expect(agent.mutation(api.shared.join, { slug: 'review', session: STRANGER, name: 'person' })).rejects.toThrow(/member’s name/)
    await expect(agent.mutation(api.shared.post, { slug: 'review', session: REVIEWER, text: 'hello', to: 'nobody' })).rejects.toThrow(/Nobody on this page/)
  })

  test('lets a member that leaves post no more', async () => {
    const { agent } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    expect(await agent.mutation(api.shared.leave, { slug: 'review', session: REVIEWER })).toMatchObject({ left: true })
    await expect(agent.mutation(api.shared.post, { slug: 'review', session: REVIEWER, text: 'one more' })).rejects.toThrow(/Only a conversation that has joined/)
  })

  test('lets the person take a member off, who may then neither post nor join again', async () => {
    const { agent, browser, page, state } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    // The person sees which conversation each member is
    const seen = await browser.query(api.shared.read, { artifactId: page })
    expect(seen.members[1]).toMatchObject({ name: 'reviewer', harness: 'codex', sessionId: 'conversation-2' })
    expect(await browser.mutation(api.shared.remove, { artifactId: page, name: 'reviewer' })).toEqual({ removed: true })
    await expect(agent.mutation(api.shared.post, { slug: 'review', session: REVIEWER, text: 'still here' })).rejects.toThrow(/Only a conversation that has joined/)
    await expect(agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })).rejects.toThrow(/taken off this page/)
    expect((await state()).shared.members).toEqual([{ name: 'owner', owner: true }])
  })

  test('lets only the person’s own browser take a member off: not a machine, and not a screen', async () => {
    const { agent, display, page } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    await expect(agent.mutation(api.shared.remove, { artifactId: page, name: 'reviewer' })).rejects.toThrow(/Only a paired browser/)
    await expect(display.mutation(api.shared.remove, { artifactId: page, name: 'reviewer' })).rejects.toThrow(/it site/)
    expect((await agent.query(api.shared.read, { slug: 'review' })).members.map((m) => m.name)).toEqual(['owner', 'reviewer'])
  })

  test('does not take the conversation the page belongs to off its own page', async () => {
    const { agent, browser, page } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: WRITER, name: 'writer' })
    await expect(browser.mutation(api.shared.remove, { artifactId: page, name: 'writer' })).rejects.toThrow(/belongs to that conversation/)
  })

  test('does not move the page to a conversation that joins it', async () => {
    const { t, agent, page } = await withPage()
    await agent.mutation(api.shared.join, { slug: 'review', session: REVIEWER, name: 'reviewer' })
    const to = await t.run(async (ctx) => (await ctx.db.get(page))!.session)
    expect(to).toEqual(WRITER)
  })
})
