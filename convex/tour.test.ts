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
    t,
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
    const { t, browser, agent } = await household()
    expect(await agent.mutation(api.tour.wait, { harness: 'claude-code' })).toEqual({ asked: false })
    const said = await browser.query(api.tour.get, {})
    expect(said).toMatchObject({ waitingUntil: Date.now() + WAITING_MS, by: 'claude-code' })
    // Said again a moment later, nothing is written: what is written is good for a while yet, and
    // each writing has the site ask again for what it shows. Said again when it is about to run out, it is
    const written = () => t.run(async (ctx) => (await ctx.db.query('tours').first())!.waitingUntil)
    const first = await written()
    vi.advanceTimersByTime(2500)
    await agent.mutation(api.tour.wait, { harness: 'claude-code' })
    expect(await written()).toBe(first)
    vi.advanceTimersByTime(WAITING_MS / 2)
    await agent.mutation(api.tour.wait, { harness: 'claude-code' })
    expect(await written()).toBe(Date.now() + WAITING_MS)
    // And none of it is written in the person's own record, which every function reads
    expect(await t.run(async (ctx) => (await ctx.db.query('users').first())!.tour ?? null)).toBeNull()
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

  test('an agent that was waiting when the person said they want none is said to wait no longer, and is told so when it next asks', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'codex' })
    vi.advanceTimersByTime(2500)
    await agent.mutation(api.tour.wait, { harness: 'codex' })
    vi.advanceTimersByTime(1000)
    await browser.mutation(api.tour.done, {})
    const skipped = Date.now()
    expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: null, doneAt: skipped })
    // It asks again every few seconds, and each asking before what it last said has run out is refused, with nothing written
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(2500)
      await expect(agent.mutation(api.tour.wait, { harness: 'codex' })).rejects.toThrow(/The person said on the site that they want no tour/)
      expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: null, doneAt: skipped })
    }
    // Nor would the button reach it, were it pressed
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: false, by: 'codex' })
  })

  test('an asking the person made before they said they want none is not taken up after it', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'codex' })
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: true, by: 'codex' })
    vi.advanceTimersByTime(1000)
    await browser.mutation(api.tour.done, {})
    vi.advanceTimersByTime(1500)
    await expect(agent.mutation(api.tour.wait, { harness: 'codex' })).rejects.toThrow(/want no tour/)
    // And an agent that comes to wait once that one has gone hears of nothing
    vi.advanceTimersByTime(WAITING_MS)
    expect(await agent.mutation(api.tour.wait, { harness: 'codex' })).toEqual({ asked: false })
    // Nor is an asking that a tour has since answered, where no agent was waiting to take it up
    await browser.mutation(api.tour.ask, {})
    vi.advanceTimersByTime(60_000)
    await agent.mutation(api.tour.done, {})
    expect(await agent.mutation(api.tour.wait, { harness: 'codex' })).toEqual({ asked: false })
  })

  test('an agent that comes to wait after that is said to wait, and hears of an asking, as before there was a tour', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'pi' })
    vi.advanceTimersByTime(1000)
    await browser.mutation(api.tour.done, {})
    // What the one that was turned away last said has run out: whoever waits now began after the person said so
    vi.advanceTimersByTime(WAITING_MS)
    expect(await agent.mutation(api.tour.wait, { harness: 'pi' })).toEqual({ asked: false })
    expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: Date.now() + WAITING_MS, by: 'pi' })
    vi.advanceTimersByTime(WAITING_MS / 2 + 2500)
    expect(await agent.mutation(api.tour.wait, { harness: 'pi' })).toEqual({ asked: false })
    expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: Date.now() + WAITING_MS })
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: true, by: 'pi' })
    expect(await agent.mutation(api.tour.wait, { harness: 'pi' })).toEqual({ asked: true })
    // An agent that ends a tour of its own turns nobody away: one that waits meanwhile goes on waiting
    await agent.mutation(api.tour.wait, { harness: 'pi' })
    vi.advanceTimersByTime(1000)
    await agent.mutation(api.tour.done, {})
    vi.advanceTimersByTime(1500)
    expect(await agent.mutation(api.tour.wait, { harness: 'pi' })).toEqual({ asked: false })
    expect(await browser.query(api.tour.get, {})).toMatchObject({ waitingUntil: Date.now() + WAITING_MS })
  })
})

describe('the identity of a tour wait', () => {
  test('an agent finishing its tour preserves a concurrent identified waiter, including its cancellation', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { waitId: 'current', first: true, harness: 'pi' })
    vi.advanceTimersByTime(1000)
    await agent.mutation(api.tour.done, {})
    expect(await agent.mutation(api.tour.wait, { waitId: 'current' })).toEqual({ asked: false })
    expect(await browser.mutation(api.tour.ask, {})).toEqual({ waiting: true, by: 'pi' })
    await browser.mutation(api.tour.done, {})
    await agent.mutation(api.tour.done, {})
    await expect(agent.mutation(api.tour.wait, { waitId: 'current' })).rejects.toThrow(/want no tour/)
  })

  test('Skip survives an expired lease and a backward clock, while a new command can wait immediately', async () => {
    for (const elapsed of [0, WAITING_MS * 3, -60_000]) {
      const { browser, agent } = await household()
      await agent.mutation(api.tour.wait, { waitId: 'old', first: true, harness: 'codex' })
      await browser.mutation(api.tour.done, {})
      vi.setSystemTime(Date.now() + elapsed)
      // Retrying the initial registration must also preserve its cancellation.
      for (const first of [undefined, true]) await expect(agent.mutation(api.tour.wait, { waitId: 'old', first })).rejects.toThrow(/want no tour/)
      await expect(agent.mutation(api.tour.wait, { waitId: 'new', first: true, harness: 'pi' })).resolves.toEqual({ asked: false })
      const waiting = await browser.query(api.tour.get, {})
      expect(waiting).toMatchObject({ waitingUntil: Date.now() + WAITING_MS, by: 'pi' })
      await expect(agent.mutation(api.tour.wait, { waitId: 'old' })).rejects.toThrow(/no longer current/)
      await agent.mutation(api.tour.leave, { waitId: 'old' })
      await agent.mutation(api.tour.leave, {})
      expect(await browser.query(api.tour.get, {})).toEqual(waiting)
      await browser.mutation(api.tour.ask, {})
      await expect(agent.mutation(api.tour.wait, { waitId: 'old' })).rejects.toThrow(/no longer current/)
      await expect(agent.mutation(api.tour.wait, { waitId: 'new' })).resolves.toEqual({ asked: true })
    }
  })

  test('a command that is superseded or has left cannot register again through a later poll', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { waitId: 'old', first: true })
    await agent.mutation(api.tour.wait, { waitId: 'new', first: true })
    vi.advanceTimersByTime(WAITING_MS * 2)
    await expect(agent.mutation(api.tour.wait, { waitId: 'old' })).rejects.toThrow(/no longer current/)
    await agent.mutation(api.tour.leave, { waitId: 'old' })
    await agent.mutation(api.tour.wait, { waitId: 'new' })
    expect((await browser.query(api.tour.get, {})).waitingUntil).toBe(Date.now() + WAITING_MS)
    await agent.mutation(api.tour.leave, { waitId: 'new' })
    expect((await browser.query(api.tour.get, {})).waitingUntil).toBeNull()
    await expect(agent.mutation(api.tour.wait, { waitId: 'new' })).rejects.toThrow(/no longer current/)
  })

  test('a new wait on another machine can start while the skipped command is still polling', async () => {
    const { t, browser, agent } = await household()
    const machine = await t.run(async (ctx) => {
      const { _id, _creationTime, ...first } = (await ctx.db.query('machines').first())!
      return ctx.db.insert('machines', { ...first, name: 'another machine' })
    })
    const another = t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' })
    await agent.mutation(api.tour.wait, { waitId: 'old', first: true })
    await browser.mutation(api.tour.done, {})
    await another.mutation(api.tour.wait, { waitId: 'new', first: true })
    await agent.mutation(api.tour.leave, { waitId: 'old' })
    expect((await browser.mutation(api.tour.ask, {})).waiting).toBe(true)
    await expect(agent.mutation(api.tour.wait, { waitId: 'old' })).rejects.toThrow(/no longer current/)
    expect(await another.mutation(api.tour.wait, { waitId: 'new' })).toEqual({ asked: true })
  })

  test('old rows and commands still work, and an identified command can replace a cancelled legacy wait', async () => {
    const { browser, agent } = await household()
    await agent.mutation(api.tour.wait, { harness: 'pi' })
    await browser.mutation(api.tour.done, {})
    await expect(agent.mutation(api.tour.wait, {})).rejects.toThrow(/want no tour/)
    await agent.mutation(api.tour.wait, { waitId: 'new', first: true })
    // A command without an id cannot overwrite an identified registration.
    await expect(agent.mutation(api.tour.wait, {})).rejects.toThrow(/no longer current/)
    await agent.mutation(api.tour.leave, { waitId: 'new' })
    vi.advanceTimersByTime(1)
    await expect(agent.mutation(api.tour.wait, {})).resolves.toEqual({ asked: false })
  })
})
