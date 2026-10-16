/// <reference types="vite/client" />
// What the backend notes for the counts of how It is used: a display that is paired and one
// that opens the site, only while counts are being sent, each note once, in nothing but the
// fixed words the program may send, and what the service is told of how much this It holds.
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { screenOf } from './lib/counted'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'
const LAPTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
const key = (who: string) => `display-key-of-${who}-0123456789`

/** A backend with the one person, and a browser of theirs for each name asked for. */
async function household() {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const browser = async (who: string) => {
    const { user, session } = await t.run(async (ctx) => {
      const user = (await ctx.db.query('users').first())!
      const now = Date.now()
      const session = await ctx.db.insert('sessions', {
        userId: user._id,
        secretHash: `no-secret-${who}`,
        role: 'owner',
        createdAt: now,
        lastSeenAt: now,
        cookieAt: now,
      })
      return { user: user._id as string, session: session as string }
    })
    return t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role: 'owner' })
  }
  /** The service says that counts are being sent, or that they are not. */
  const counting = (usage: boolean) => t.mutation(internal.network.report, { on: false, wanted: false, addresses: [], usage })
  const notes = async () => (await t.run((ctx) => ctx.db.query('counted').collect())).map((n) => ({ name: n.name, ...JSON.parse(n.properties) }))
  return { t, browser, counting, notes }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('what kind of screen a browser is on', () => {
  test('is told from the name it gives itself, as one of four words', () => {
    for (const [userAgent, kind] of [
      [PHONE, 'phone'],
      ['Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36', 'phone'],
      ['Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1', 'tablet'],
      ['Mozilla/5.0 (Linux; Android 16; SM-X910) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36', 'tablet'],
      ['Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0) AppleWebKit/537.36 Chrome/120.0.0.0 TV Safari/537.36', 'tv'],
      ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 WebAppManager', 'tv'],
      [LAPTOP, 'computer'],
      ['', 'computer'],
    ] as const)
      expect(screenOf(userAgent), userAgent).toBe(kind)
  })
})

describe('what the backend notes of a display', () => {
  test('nothing, while counts are not being sent', async () => {
    const { browser, counting, notes } = await household()
    const phone = await browser('phone')
    // The service has said nothing yet of whether counts are sent
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect(await notes()).toEqual([])
    // And it says that they are not
    await counting(false)
    const laptop = await browser('laptop')
    await laptop.mutation(api.displays.register, { key: key('laptop'), userAgent: LAPTOP })
    await laptop.mutation(api.displays.reached, { key: key('laptop'), local: true })
    expect(await notes()).toEqual([])
  })

  test('that it was paired, the first time it says it has the site open, and that it opened the site, each time it comes back after being away', async () => {
    const { browser, counting, notes } = await household()
    await counting(true)
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    // Registering alone notes nothing: where the display reached It from is not known yet
    expect(await notes()).toEqual([])
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect(await notes()).toEqual([
      { name: 'display.paired', screen: 'phone', sameMachine: false, first: true },
      { name: 'screen.connected', screen: 'phone', sameMachine: false },
    ])
    // The page loaded again a moment later is the same opening
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect(await notes()).toHaveLength(2)
    // Back after a quarter of an hour, it has opened the site again, and is not paired again
    vi.advanceTimersByTime(15 * 60_000)
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect((await notes()).map((n) => n.name)).toEqual(['display.paired', 'screen.connected', 'screen.connected'])
    // A second display, on the machine It runs on, is not the first
    const laptop = await browser('laptop')
    await laptop.mutation(api.displays.register, { key: key('laptop'), userAgent: LAPTOP })
    await laptop.mutation(api.displays.reached, { key: key('laptop'), local: true })
    expect((await notes()).slice(3)).toEqual([
      { name: 'display.paired', screen: 'computer', sameMachine: true, first: false },
      { name: 'screen.connected', screen: 'computer', sameMachine: true },
    ])
  })

  test('nothing for a key that is no display, and nothing of the display’s name or the browser’s own', async () => {
    const { browser, counting, notes, t } = await household()
    await counting(true)
    const phone = await browser('phone')
    expect(await phone.mutation(api.displays.reached, { key: key('nobody'), local: false })).toBeNull()
    expect(await phone.mutation(api.displays.reached, { key: 'not a key', local: false })).toBeNull()
    expect(await notes()).toEqual([])
    const display = await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.rename, { displayId: display.id, name: 'Aaryan’s phone' })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    const kept = JSON.stringify(await t.run((ctx) => ctx.db.query('counted').collect()))
    for (const word of ['Aaryan', 'iPhone', 'Mozilla', key('phone')]) expect(kept).not.toContain(word)
  })
})

describe('what the service takes', () => {
  test('is every note, oldest first and once, and nothing where counts were turned off meanwhile', async () => {
    const { browser, counting, t } = await household()
    await counting(true)
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    const first = await t.mutation(internal.counted.take, {})
    expect(first.notes.map((n) => n.name)).toEqual(['display.paired', 'screen.connected'])
    expect(JSON.parse(first.notes[0]!.properties)).toEqual({ screen: 'phone', sameMachine: false, first: true })
    expect(first.more).toBe(false)
    expect((await t.mutation(internal.counted.take, {})).notes).toEqual([])
    // Noted, and then the person turns the counts off before the service comes: they are removed and not given
    vi.advanceTimersByTime(15 * 60_000)
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect((await t.mutation(internal.counted.take, { keep: false })).notes).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('counted').collect())).toEqual([])
  })

  test('what was noted before the service said counts are off is removed then, and is not given once they are on again', async () => {
    const { browser, counting, notes, t } = await household()
    await counting(true)
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    expect((await notes()).map((n) => n.name)).toEqual(['display.paired', 'screen.connected'])
    // The person turns the counts off and on again between two of the service's comings: it has said each, and has taken nothing
    await counting(false)
    expect(await notes()).toEqual([])
    await counting(true)
    vi.advanceTimersByTime(15 * 60_000)
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    // What it is given is what happened since they were turned on
    expect((await t.mutation(internal.counted.take, {})).notes.map((n) => n.name)).toEqual(['screen.connected'])
  })

  test('and so are more notes than one step removes, none of what was noted since among them', async () => {
    const { browser, counting, notes, t } = await household()
    await counting(true)
    await t.run(async (ctx) => {
      for (let i = 0; i < 1100; i++) await ctx.db.insert('counted', { name: 'page.shown', properties: '{"screen":"phone","by":"person"}', at: Date.now() })
    })
    vi.advanceTimersByTime(1000)
    await counting(false)
    // Turned on again, and something noted, before the later steps have run
    await counting(true)
    vi.advanceTimersByTime(1000)
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await notes()).map((n) => n.name)).toEqual(['display.paired', 'screen.connected'])
  })

  test.each([0, -300_000])('old notes cannot be collected before the purge finishes, even with a clock change of %s milliseconds', async (clockChange) => {
    const { browser, counting, t } = await household()
    await counting(true)
    await t.run(async (ctx) => {
      for (let i = 0; i < 1100; i++) await ctx.db.insert('counted', { name: 'page.shown', properties: '{}', at: Date.now() })
    })
    vi.setSystemTime(Date.now() + clockChange)
    await counting(false)
    await counting(true)
    try {
      expect((await t.mutation(internal.counted.take, { keep: true })).notes).toEqual([])
      const phone = await browser('phone')
      await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
      await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect((await t.mutation(internal.counted.take, { keep: true })).notes.map((n) => n.name)).toEqual(['display.paired', 'screen.connected'])
    } finally {
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    }
  })

  test('a note nobody came for is removed after a week', async () => {
    const { browser, counting, t } = await household()
    await counting(true)
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    await phone.mutation(api.displays.reached, { key: key('phone'), local: false })
    await t.mutation(internal.counted.sweep, {})
    expect(await t.run((ctx) => ctx.db.query('counted').collect())).toHaveLength(2)
    vi.advanceTimersByTime(8 * 86_400_000)
    await t.mutation(internal.counted.sweep, {})
    expect(await t.run((ctx) => ctx.db.query('counted').collect())).toEqual([])
  })

  test('how much this It holds is told as numbers, and of the displays only whether any has notifications on', async () => {
    const { browser, t } = await household()
    expect(await t.query(internal.counted.picture, {})).toEqual({ pages: 0, displays: 0, machines: 1, conversations: 0, push: false })
    const phone = await browser('phone')
    await phone.mutation(api.displays.register, { key: key('phone'), userAgent: PHONE })
    const laptop = await browser('laptop')
    await laptop.mutation(api.displays.register, { key: key('laptop'), userAgent: LAPTOP })
    expect(await t.query(internal.counted.picture, {})).toEqual({ pages: 0, displays: 2, machines: 1, conversations: 0, push: false })
  })

  test('conversations beyond hundreds of pages in one conversation are counted without sending their identities', async () => {
    const { t } = await household()
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query('users').first())!._id
      const page = { userId, title: 'A private page title', lastVersion: 1, bytes: 0, createdAt: 1, updatedAt: 1 }
      for (let i = 0; i < 1200; i++) {
        await ctx.db.insert('artifacts', { ...page, slug: `same-${i}`, session: { harness: 'claude-code', id: 'private-conversation' } })
      }
      for (const [harness, id] of [
        ['claude-code', 'another-private-conversation'],
        ['codex', 'private-conversation'],
        ['pi', 'private-conversation'],
      ]) {
        await ctx.db.insert('artifacts', { ...page, slug: `${harness}-${id}`, session: { harness: harness!, id: id! } })
      }
      await ctx.db.insert('artifacts', { ...page, slug: 'without-a-conversation' })
      const other = await ctx.db.insert('users', { subject: 'another-person', createdAt: 1 })
      await ctx.db.insert('artifacts', { ...page, userId: other, slug: 'another-person', session: { harness: 'codex', id: 'another-person' } })
    })
    expect(await t.query(internal.counted.picture, {})).toEqual({ pages: 101, displays: 0, machines: 1, conversations: 4, push: false })
  })

  test('conversation counting stops once the highest band is known', async () => {
    const { t } = await household()
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query('users').first())!._id
      for (let i = 0; i < 130; i++) {
        await ctx.db.insert('artifacts', {
          userId,
          slug: `page-${i}`,
          title: 'Private',
          lastVersion: 1,
          bytes: 0,
          createdAt: 1,
          updatedAt: 1,
          session: { harness: i % 2 ? 'codex' : 'claude-code', id: `private-${i}` },
        })
      }
    })
    expect(await t.query(internal.counted.picture, {})).toEqual({ pages: 101, displays: 0, machines: 1, conversations: 101, push: false })
  })
})
