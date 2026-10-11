/// <reference types="vite/client" />
// The tour, as far as the backend has a part in it: the button on the site that an agent
// waiting to give the tour hears of, once, and whether a tour was ever finished.
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import { ASKED_FOR_MS, WAITING_MS } from './tour'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

async function household() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const { user, session, machine } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const machine = (await ctx.db.query('machines').first())!
    const now = Date.now()
    const session = await ctx.db.insert('sessions', {
      userId: user._id,
      secretHash: 'no-secret',
      role: 'owner',
      createdAt: now,
      lastSeenAt: now,
      cookieAt: now,
    })
    return { user: user._id as string, session: session as string, machine: machine._id as string }
  })
  return {
    browser: t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role: 'owner' }),
    agent: t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('asking for the tour on the site', () => {
  test('with no agent waiting, the site is told so, and nothing says that one is', async () => {
    const { browser } = await household()
    expect(await browser.query(api.tour.get, {})).toEqual({ waitingUntil: null, by: null, askedAt: null, takenAt: null, doneAt: null })
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: false, by: null })
  })

  test('an agent that waits is said to be waiting for a little while each time it says so, and no longer', async () => {
    const { browser, agent } = await household()
    expect(await agent.mutation(api.tour.wait, { harness: 'claude-code' })).toEqual({ asked: false })
    const said = await browser.query(api.tour.get, {})
    expect(said).toMatchObject({ waitingUntil: Date.now() + WAITING_MS, by: 'claude-code' })
    vi.advanceTimersByTime(WAITING_MS + 1)
    // It has gone quiet: the button would reach nobody, and the site is told so when it asks
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: false, by: 'claude-code' })
  })

  test('the agent that is waiting hears of the asking, once, and is then no longer said to wait', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'codex' })
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: true, by: 'codex' })
    expect(await agent.mutation(api.tour.wait, { harness: 'codex' })).toEqual({ asked: true })
    expect((await browser.query(api.tour.get, {})).waitingUntil).toBeNull()
    // The next one to wait hears of nothing: the asking was taken up
    expect(await agent.mutation(api.tour.wait, { harness: 'codex' })).toEqual({ asked: false })
  })

  test('an asking made a moment before the agent came to wait is heard, and one from long ago is not', async () => {
    const { browser, agent } = await household()
    await browser.mutation(api.tour.ask, {})
    vi.advanceTimersByTime(30_000)
    expect(await agent.mutation(api.tour.wait, {})).toEqual({ asked: true })
    await browser.mutation(api.tour.ask, {})
    vi.advanceTimersByTime(ASKED_FOR_MS + 1)
    expect(await agent.mutation(api.tour.wait, {})).toEqual({ asked: false })
  })

  test('an agent that gives up waiting is no longer said to wait', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'pi' })
    await agent.mutation(api.tour.leave, {})
    expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: null, by: 'pi' })
  })

  test('only a paired browser asks, and only an enrolled machine waits', async () => {
    const { browser, agent } = await household()
    await expect(agent.mutation(api.tour.ask, {})).rejects.toThrow(/paired browser/)
    await expect(browser.mutation(api.tour.wait, {})).rejects.toThrow(/enrolled machine/)
  })
})

describe('a tour that is over', () => {
  test('is noted when its agent says so, and when the person says they want none', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.done, {})
    const first = (await browser.query(api.tour.get, {})).doneAt
    expect(first).toBe(Date.now())
    vi.advanceTimersByTime(1000)
    await browser.mutation(api.tour.done, {})
    expect((await browser.query(api.tour.get, {})).doneAt).toBe(first! + 1000)
  })
})
