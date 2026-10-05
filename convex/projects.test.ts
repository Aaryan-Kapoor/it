/// <reference types="vite/client" />
// Whether a closed conversation may be reopened for a project's pages: it is the person's alone
// to allow, from a browser paired as their own. A machine may not, which is to say an agent may
// not allow it for itself, and neither may a screen.
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE

/** A backend with the one person and two projects of theirs, and what each kind of caller calls it as. */
async function household() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const as = async (role: 'owner' | 'screen') => {
    const { user, session } = await t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      const now = Date.now()
      const session = await ctx.db.insert('sessions', {
        userId: user._id,
        secretHash: `no-secret-${role}`,
        role,
        createdAt: now,
        lastSeenAt: now,
        cookieAt: now,
      })
      return { user: user._id as string, session: session as string }
    })
    return t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role })
  }
  const projects = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const site = await ctx.db.insert('projects', { userId: user._id, key: 'github.com/someone/site', name: 'site', createdAt: 1 })
    const api = await ctx.db.insert('projects', { userId: user._id, key: 'api', name: 'api', createdAt: 2 })
    return { site, api }
  })
  return {
    t,
    projects,
    machine: t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' }),
    owner: await as('owner'),
    screen: await as('screen'),
  }
}
const refusal = (asked: Promise<unknown>) =>
  asked.then(
    () => 'ok',
    (err) => /code\\*":\\*"([a-z_]+)/.exec(`${JSON.stringify((err as { data?: unknown }).data)} ${String(err)}`)?.[1] ?? String(err),
  )

describe('reopening closed conversations for a project', () => {
  test('is off for every project until the owner allows it, and is then on for that project alone', async () => {
    const { owner, projects } = await household()
    expect(await owner.query(api.projects.list, {})).toEqual([
      { id: projects.api, name: 'api', wake: false },
      { id: projects.site, name: 'site', wake: false },
    ])
    await owner.mutation(api.projects.setWake, { projectId: projects.site, wake: true })
    expect((await owner.query(api.projects.list, {})).map((p) => [p.name, p.wake])).toEqual([
      ['api', false],
      ['site', true],
    ])
    await owner.mutation(api.projects.setWake, { projectId: projects.site, wake: false })
    expect((await owner.query(api.projects.list, {})).every((p) => !p.wake)).toBe(true)
  })

  test('a machine cannot allow it, so no agent allows it for itself, and neither can a screen', async () => {
    const { owner, machine, screen, projects } = await household()
    for (const other of [machine, screen]) {
      expect(await refusal(other.mutation(api.projects.setWake, { projectId: projects.site, wake: true }))).toBe('forbidden')
      expect(await refusal(other.query(api.projects.list, {}))).toBe('forbidden')
    }
    expect((await owner.query(api.projects.list, {})).every((p) => !p.wake)).toBe(true)
  })

  test('a project that is not the person’s is not there to be changed', async () => {
    const { t, owner } = await household()
    const theirs = await t.run(async (ctx) => {
      const other = await ctx.db.insert('users', { subject: 'someone else', createdAt: 1 } as never)
      return ctx.db.insert('projects', { userId: other as Id<'users'>, key: 'theirs', name: 'theirs', createdAt: 1 })
    })
    expect(await refusal(owner.mutation(api.projects.setWake, { projectId: theirs, wake: true }))).toBe('not_found')
    expect((await t.run((ctx) => ctx.db.get(theirs)))?.wake).toBeUndefined()
  })
})
