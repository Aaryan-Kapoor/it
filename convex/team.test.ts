/// <reference types="vite/client" />
// The team. What it must get right: a teammate's browser is shown the team's pages and what was
// sent to its teammate and nothing else of the person's, what it does on a page it was sent
// reaches the conversation the page belongs to, and removing a teammate ends every browser
// paired for them.
import { getFunctionName } from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { sha256 } from './lib/hash'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'
const KEY = 'display-key-of-the-teammate-0123456789'

/** A backend with one person, a machine and a browser of theirs, a private page and a second page, each made by a conversation of the person's. */
async function withTeam() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const { user, owner, machine, diary, plan } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const machine = (await ctx.db.query('machines').first())!
    const now = Date.now()
    const owner = await ctx.db.insert('sessions', { userId: user._id, secretHash: 'no-secret', role: 'owner', createdAt: now, lastSeenAt: now, cookieAt: now })
    const page = (slug: string, id: string) =>
      ctx.db.insert('artifacts', {
        userId: user._id,
        slug,
        title: slug,
        currentVersion: 1,
        lastVersion: 1,
        bytes: 10,
        createdAt: now,
        updatedAt: now,
        machineId: machine._id,
        session: { harness: 'claude-code', id },
        agent: 'claude-code',
      })
    return {
      user: user._id as string,
      owner: owner as string,
      machine: machine._id as string,
      diary: await page('diary', 'conversation-1'),
      plan: await page('plan', 'conversation-2'),
    }
  })
  const person = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: owner, role: 'owner' })
  const agent = t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' })
  /** Invites a teammate and pairs one browser with the code, as the site does: the browser it gives is the teammate's. */
  const join = async (name: string) => {
    const { code, teammate } = await person.mutation(api.team.invite, { name })
    const paired = await t.mutation(internal.sessions._redeem, { codeHash: await sha256(code), secretHash: `secret-of-${name}-${code}`, presented: [] })
    if (!paired || 'refused' in paired) throw new Error('not paired')
    const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: paired.sessionId as string, role: 'screen' })
    const mutation = browser.mutation
    browser.mutation = (async (fn, args) => {
      if (getFunctionName(fn) === 'actions:submit') return mutation(fn, { ...args, replayUntil: (await mutation(api.actions.replayGrant, {})).until })
      return mutation(fn, args)
    }) as typeof mutation
    return { browser, teammate, session: paired.sessionId as Id<'sessions'> }
  }
  const slugs = async (who: typeof person) => (await who.query(api.artifacts.list, {})).map((a: { slug: string }) => a.slug).sort()
  return { t, person, agent, join, slugs, diary, plan }
}

describe('a teammate’s browser', () => {
  test('is shown none of the person’s pages until one is shared with the team or sent to them', async () => {
    const { person, join, slugs, diary } = await withTeam()
    const { browser } = await join('Ada')
    expect(await slugs(person)).toEqual(['diary', 'plan'])
    expect(await slugs(browser)).toEqual([])
    // A private page is no page at all to it, by its id or by its name
    await expect(browser.query(api.state.get, { artifactId: diary })).rejects.toThrow(/No such page/)
    await expect(browser.query(api.state.get, { slug: 'diary' })).rejects.toThrow(/No such page/)
    await expect(browser.query(api.actions.forArtifact, { slug: 'diary' })).rejects.toThrow(/No such page/)
  })

  test('cannot act on a private page', async () => {
    const { join, diary, t } = await withTeam()
    const { browser } = await join('Ada')
    const envelope = { v: 1, clientActionId: 'click-0123456789ab', name: 'approve', payload: '{}', contentVersion: 1 }
    await expect(browser.mutation(api.actions.submit, { artifactId: diary, displayKey: KEY, envelope })).rejects.toThrow(/No such page/)
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
  })

  test('is shown a page shared with the team, and is shown it no more once it is private again', async () => {
    const { person, agent, join, slugs } = await withTeam()
    const { browser } = await join('Ada')
    // An agent of the person's shares it, as the person could
    await agent.mutation(api.team.share, { slug: 'plan', team: true })
    expect(await slugs(browser)).toEqual(['plan'])
    await person.mutation(api.team.share, { slug: 'plan', team: false })
    expect(await slugs(browser)).toEqual([])
  })

  test('sees a page that was sent to its teammate arrive, acts on it for the conversation it belongs to, and sends it back', async () => {
    const { t, agent, person, join, slugs, plan } = await withTeam()
    const ada = await join('Ada')
    const grace = await join('Grace')
    await agent.mutation(api.team.send, { slug: 'plan', to: 'Ada' })
    expect(await ada.browser.query(api.team.inbox, {})).toMatchObject([{ slug: 'plan', back: null }])
    expect(await slugs(ada.browser)).toEqual(['plan'])
    // Another teammate was sent nothing, and is shown nothing
    expect(await slugs(grace.browser)).toEqual([])
    expect(await grace.browser.query(api.team.inbox, {})).toEqual([])
    const envelope = { v: 1, clientActionId: 'click-0123456789ab', name: 'approve', payload: '{"ok":true}', contentVersion: 1 }
    await ada.browser.mutation(api.actions.submit, { artifactId: plan, displayKey: KEY, envelope })
    const [click] = await t.run((ctx) => ctx.db.query('actions').collect())
    expect(click).toMatchObject({ name: 'approve', harness: 'claude-code', sessionId: 'conversation-2', delivery: 'pending' })
    expect(await ada.browser.mutation(api.team.sendBack, { artifactId: plan })).toEqual({ back: true })
    expect(await slugs(ada.browser)).toEqual([])
    expect(await ada.browser.query(api.team.inbox, {})).toEqual([])
    // The person sees that it came back, and from whom
    expect(await person.query(api.team.inbox, {})).toMatchObject([{ slug: 'plan', to: 'Ada' }])
    expect((await person.query(api.team.inbox, {}))[0]!.back).toBeTypeOf('number')
  })

  test('may not invite, remove, share or send, and is told nothing of the other teammates', async () => {
    const { join, plan } = await withTeam()
    const ada = await join('Ada')
    const grace = await join('Grace')
    await expect(ada.browser.mutation(api.team.invite, { name: 'Mallory' })).rejects.toThrow(/it site/)
    await expect(ada.browser.mutation(api.team.remove, { teammate: grace.teammate })).rejects.toThrow(/it site/)
    await expect(ada.browser.mutation(api.team.share, { artifactId: plan, team: true })).rejects.toThrow(/it site/)
    await expect(ada.browser.mutation(api.team.send, { artifactId: plan, to: 'Ada' })).rejects.toThrow(/it site/)
    expect(await ada.browser.query(api.team.list, {})).toEqual({ you: 'Ada', teammates: [] })
  })
})

describe('removing a teammate', () => {
  test('ends every browser paired for them, lets a waiting code of theirs in nobody, and takes back what was out with them', async () => {
    const { t, person, agent, join, slugs } = await withTeam()
    const ada = await join('Ada')
    const second = await join('Ada')
    expect(second.teammate).toBe(ada.teammate)
    const waiting = await person.mutation(api.team.invite, { name: 'Ada' })
    await agent.mutation(api.team.send, { slug: 'plan', to: 'Ada' })
    expect(await person.query(api.team.list, {})).toMatchObject({ teammates: [{ name: 'Ada', browsers: 2, reviewing: 1 }] })
    expect(await person.mutation(api.team.remove, { teammate: ada.teammate })).toEqual({ removed: true, browsers: 2 })
    for (const s of [ada.session, second.session]) expect((await t.run((ctx) => ctx.db.get(s)))!.endedAt).toBeTypeOf('number')
    await expect(slugs(ada.browser)).rejects.toThrow(/not paired/)
    expect(await t.mutation(internal.sessions._redeem, { codeHash: await sha256(waiting.code), secretHash: 'late', presented: [] })).toBeNull()
    expect(await person.query(api.team.list, {})).toEqual({ you: null, teammates: [] })
    expect(await person.query(api.team.inbox, {})).toEqual([])
  })
})
