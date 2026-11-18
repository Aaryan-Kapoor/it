/// <reference types="vite/client" />
// A change to thousands of the values a page keeps. The backend program lets one function read
// the database in at most 4,096 places, and looking a record up by its name, changing it and
// removing it are each one of them. So a change that reaches more than a couple of thousand of
// the records there are writes everything the page keeps afresh, as records that are added,
// and the records from before it are no part of the state from then on: they are removed
// afterwards. What these hold: that the state reads the same whichever way it was written, that
// the records left behind are never read as part of it, that a change the page may not hold
// writes nothing, and how many places the largest change reads. They run on the stand-in
// backend, which counts nothing itself: `bulk.test.ts` makes the same changes against the
// backend program.
import { LIMITS, STORE_KEY } from '@it/protocol'
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'
import { startState, write } from './state'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

type T = ReturnType<typeof convexTest>
const begun: T[] = []
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  for (const t of begun.splice(0)) await t.finishInProgressScheduledFunctions().catch(() => {})
  vi.useRealTimers()
})

/** A backend with one person, a machine of theirs whose agent made one page, and a browser of theirs. */
async function withPage() {
  const t = convexTest(schema, modules)
  begun.push(t)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'this machine', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const { user, session, machine, page } = await t.run(async (ctx) => {
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
    const page = await ctx.db.insert('artifacts', {
      userId: user._id,
      slug: 'plan',
      title: 'Plan',
      currentVersion: 1,
      lastVersion: 1,
      bytes: 10,
      createdAt: now,
      updatedAt: now,
      machineId: machine._id,
      session: { harness: 'claude-code', id: 'conversation-1' },
      agent: 'claude-code',
    })
    return { user: user._id, session: session as string, machine: machine._id as string, page }
  })
  const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role: 'owner' })
  const agent = t.withIdentity({ issuer: SITE, subject: machine, kind: 'machine' })
  /** The agent changes the state, as `it patch` does, and with `replace` as `it patch --replace` does. */
  const patch = (body: unknown, replace = false) =>
    agent.mutation(api.state.patch, { slug: 'plan', patch: JSON.stringify(body), ...(replace ? { replace } : {}) })
  /** The page keeps values for itself, as It.store does. */
  const store = (changes: Record<string, unknown>) =>
    browser.mutation(api.state.store, { artifactId: page, changes: Object.entries(changes).map(([key, value]) => ({ key, value: JSON.stringify(value) })) })
  const state = async () => JSON.parse((await agent.query(api.state.get, { slug: 'plan' })).json) as Record<string, any>
  const live = (since?: number) => browser.query(api.state.live, { artifactId: page, ...(since === undefined ? {} : { since }) })
  const records = () => t.run((ctx) => ctx.db.query('stored').collect())
  const noted = async () => (await t.run((ctx) => ctx.db.query('revisions').collect()))[0]!
  /** Lets what was left behind be removed, however many batches that takes. */
  const removed = () => t.finishAllScheduledFunctions(vi.runAllTimers)
  return { t, user, page, agent, patch, store, state, live, records, noted, removed }
}

/** The code a refusal carries, or `ok`. */
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => {
      if (!(e instanceof ConvexError)) throw e
      // A refusal comes as it was made, or as JSON text of it, once or twice over
      let data: any = e.data
      while (typeof data === 'string') data = JSON.parse(data)
      return [data.code, data.message]
    },
  )
const names = (count: number, value: (i: number) => unknown, prefix = 'k') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, value(i)]))
/** More of a page's values than one change writes to where they are. */
const MANY = 2100

describe('a change to thousands of the values a page keeps', () => {
  test('is written afresh, reads as the same state, and leaves nothing of the records from before it in what is read', async () => {
    const { patch, store, state, live, records, noted, removed } = await withPage()
    const first = await patch({ title: 'a plan', [STORE_KEY]: names(MANY, (i) => ({ n: i })) })
    // Nothing was there to change: every value is a record that was added, where it is
    expect([(await records()).length, (await noted()).keptFrom]).toEqual([MANY, undefined])

    // Merged into every one of them: each value is the one that was there with the change in it
    const merged = await patch({ [STORE_KEY]: names(MANY, (i) => ({ m: i })) })
    expect(merged.revision).toBe(first.revision + 1)
    expect(await state()).toEqual({ title: 'a plan', [STORE_KEY]: names(MANY, (i) => ({ n: i, m: i })) })
    // The records from before are still there, and are no part of the state from this revision on
    const after = await records()
    expect([after.length, after.filter((r) => r.revision >= merged.revision).length]).toEqual([2 * MANY, MANY])
    const counted = await noted()
    expect(counted).toMatchObject({ keys: MANY, gone: 0, keptFrom: merged.revision, floor: merged.revision })
    expect(counted.keptBytes).toBe(after.filter((r) => r.revision >= merged.revision).reduce((n, r) => n + r.bytes, 0))
    // A display that had the state from before is sent the whole of it, once
    const sent = await live(first.revision)
    expect([sent.whole, sent.kept?.length, sent.revision]).toEqual([true, MANY, merged.revision])
    expect(Object.fromEntries(sent.kept!.map(([key, json]) => [key, JSON.parse(json!)]))).toEqual(names(MANY, (i) => ({ n: i, m: i })))
    expect(await live(merged.revision)).toEqual({ revision: merged.revision })

    // Before anything is removed, the page changes a value that was written afresh, keeps a new
    // one and takes one away: each is found under its name once, beside the record left behind
    const kept = await store({ k0: 'changed', fresh: true, k1: null })
    expect(kept.revision).toBe(merged.revision + 1)
    const now = await state()
    expect([now[STORE_KEY].k0, now[STORE_KEY].fresh, 'k1' in now[STORE_KEY], Object.keys(now[STORE_KEY]).length]).toEqual(['changed', true, false, MANY])
    // And a display that is one revision behind is sent those three alone
    expect([...(await live(merged.revision)).kept!].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['fresh', 'true'],
      ['k0', '"changed"'],
      ['k1', null],
    ])
    expect(await noted()).toMatchObject({ keys: MANY, gone: 1 })

    // What was left behind is removed afterwards, a batch at a time, and the state is as it was
    await removed()
    const left = await records()
    expect([left.length, left.every((r) => r.revision >= merged.revision), left.filter((r) => r.gone).map((r) => r.key)]).toEqual([MANY + 1, true, ['k1']])
    expect(await state()).toEqual(now)
  }, 120_000)

  test('puts thousands of others in place of them, and takes them all away', async () => {
    const { patch, state, live, records, noted, removed } = await withPage()
    await patch({ [STORE_KEY]: names(MANY, (i) => i) })
    // In place of all of them, with the agent's part
    const replaced = await patch({ title: 'others', [STORE_KEY]: names(MANY, (i) => `other ${i}`, 'o') }, true)
    expect(await state()).toEqual({ title: 'others', [STORE_KEY]: names(MANY, (i) => `other ${i}`, 'o') })
    expect(await noted()).toMatchObject({ keys: MANY, gone: 0, keptFrom: replaced.revision })
    // The same again changes none of what the page keeps, and writes none of it
    const before = (await records()).length
    const again = await patch({ title: 'others', [STORE_KEY]: names(MANY, (i) => `other ${i}`, 'o') }, true)
    expect([(await records()).length, (await noted()).keptFrom]).toEqual([before, replaced.revision])
    // A few changed among thousands are written where they are, and a display is sent those alone
    const few = await patch({ [STORE_KEY]: { ...names(MANY, (i) => `other ${i}`, 'o'), o7: 'seven', o8: null } })
    expect([(await records()).length, (await noted()).keptFrom, (await live(again.revision)).kept?.length]).toEqual([before, replaced.revision, 2])
    // All of it taken away: the page keeps nothing, at once
    const none = await patch({ [STORE_KEY]: null })
    expect(none.revision).toBe(few.revision + 1)
    expect(await state()).toEqual({ title: 'others' })
    expect(await noted()).toMatchObject({ keys: 0, keptBytes: 0, gone: 0, keptFrom: none.revision })
    expect(await live(few.revision)).toMatchObject({ whole: true, kept: [] })
    await removed()
    expect(await records()).toEqual([])
    // And it keeps values again as any page does
    await patch({ [STORE_KEY]: { o7: 'back' } })
    expect(await state()).toEqual({ title: 'others', [STORE_KEY]: { o7: 'back' } })
  }, 120_000)

  test('is refused whole where the page may not hold what it comes to, with nothing of it written', async () => {
    const { patch, state, records, noted } = await withPage()
    const held = await patch({ [STORE_KEY]: names(MANY, (i) => i) })
    const most = `A page keeps at most ${LIMITS.storeKeys} values with It.store.`
    // More names than a page may keep a value under, in one change: merged in, and put in place of what is there
    for (const replace of [false, true]) {
      expect(await code(patch({ [STORE_KEY]: names(LIMITS.storeKeys + 1, (i) => i + 1) }, replace))).toEqual(['limit', most])
      expect([(await records()).length, (await noted()).revision, (await state())[STORE_KEY].k5]).toEqual([MANY, held.revision, 5])
    }
    // And more bytes than a state may be, in values that are each no more than one may be
    const large = names(MANY, () => 'x'.repeat(Math.ceil(LIMITS.stateBytes / MANY)))
    expect(await code(patch({ [STORE_KEY]: large }))).toEqual(['limit', `A page's state is at most ${LIMITS.stateBytes / 1024} KB.`])
    expect([(await records()).length, (await noted()).revision, (await state())[STORE_KEY].k5]).toEqual([MANY, held.revision, 5])
  }, 120_000)

  test('reads the database in a few places, however many values it changes', async () => {
    const { t, user, page, patch, state } = await withPage()
    await patch({ [STORE_KEY]: names(LIMITS.storeKeys, (i) => i) })
    /** Every place a function reads the database at: a query, and each record it reads, changes or removes by its id. */
    const counting = (real: any) => {
      const places = { read: 0, written: 0 }
      const db = new Proxy(real, {
        get(target: any, name) {
          const value = target[name]
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (['query', 'get', 'patch', 'replace', 'delete'].includes(String(name))) places.read++
            if (['insert', 'patch', 'replace', 'delete'].includes(String(name))) places.written++
            return value.apply(target, args)
          }
        },
      })
      return { db, places }
    }
    const changed = (merge: boolean, value: (i: number) => unknown, prefix?: string) =>
      t.run(async (ctx) => {
        const { db, places } = counting(ctx.db)
        const kept = merge ? { merge: names(LIMITS.storeKeys, value, prefix) } : { replace: names(LIMITS.storeKeys, value, prefix) }
        await write({ ...ctx, db } as typeof ctx, user, page, (current) => current, { kept })
        return places
      })
    // Every value a page may keep, changed in one change: the backend program refuses a function at 4,096 places read and at 16,000 records written
    const merged = await changed(true, (i) => -1 - i)
    expect(merged.read).toBeLessThan(50)
    expect(merged.written).toBeLessThan(LIMITS.storeKeys + 50)
    expect((await state())[STORE_KEY]).toEqual(names(LIMITS.storeKeys, (i) => -1 - i))
    // And every one of them put out for another
    const replaced = await changed(false, (i) => i, 'other')
    expect(replaced.read).toBeLessThan(50)
    expect(replaced.written).toBeLessThan(LIMITS.storeKeys + 50)
    expect((await state())[STORE_KEY]).toEqual(names(LIMITS.storeKeys, (i) => i, 'other'))
  }, 240_000)

  test('a state to start with is held to how many values a page may keep, and one with as many as it may keep is taken', async () => {
    const { t, user, page, agent, state, records } = await withPage()
    const start = (count: number) => JSON.stringify({ title: 'start', [STORE_KEY]: names(count, (i) => i) })
    const most = ['limit', `A page keeps at most ${LIMITS.storeKeys} values with It.store.`]
    // A publish that brings one is refused when it begins, before any of the page's files are sent
    const begins = (count: number) =>
      agent.action(api.publish.begin, {
        slug: 'another',
        title: 'Another',
        files: [{ path: 'index.html', size: 100, sha256: 'a'.repeat(64) }],
        state: start(count),
      })
    expect(await code(begins(LIMITS.storeKeys + 1))).toEqual(most)
    expect(await t.run((ctx) => ctx.db.query('artifacts').collect())).toHaveLength(1)
    // And where it is put in, should it ever come that far
    const starts = (count: number) => t.run((ctx) => startState(ctx, user, page as Id<'artifacts'>, start(count)))
    expect(await code(starts(LIMITS.storeKeys + 1))).toEqual(most)
    expect([await state(), (await records()).length]).toEqual([{}, 0])
    await starts(MANY)
    expect(await state()).toEqual({ title: 'start', [STORE_KEY]: names(MANY, (i) => i) })
  }, 120_000)

  test('values kept inside the agent’s part, as they once were, are moved out into records of their own however many they are', async () => {
    const { t, user, page, patch, state, records, noted } = await withPage()
    const inside = names(MANY, (i) => ({ n: i }))
    await t.run((ctx) => ctx.db.insert('states', { artifactId: page, userId: user, json: JSON.stringify({ title: 'old', [STORE_KEY]: inside }), revision: 7 }))
    expect(await state()).toEqual({ title: 'old', [STORE_KEY]: inside })
    const moved = await patch({ title: 'new' })
    expect(moved.revision).toBe(8)
    expect(await state()).toEqual({ title: 'new', [STORE_KEY]: inside })
    expect([(await records()).length, (await noted()).keys]).toEqual([MANY, MANY])
    expect(JSON.parse((await t.run((ctx) => ctx.db.query('states').collect()))[0]!.json)).toEqual({ title: 'new' })
  }, 120_000)

  test('values kept inside the agent’s part are moved out and all put out for others by one change, and none of them is left in the state', async () => {
    const { t, user, page, patch, state, live, records, noted, removed } = await withPage()
    await t.run((ctx) => ctx.db.insert('states', { artifactId: page, userId: user, json: JSON.stringify({ [STORE_KEY]: names(MANY, (i) => i) }), revision: 7 }))
    // Moved out at one revision, and put out for the others at the next
    const others = { title: 'others', [STORE_KEY]: names(MANY, (i) => -1 - i, 'o') }
    expect(await patch(others, true)).toEqual({ revision: 9 })
    expect(await state()).toEqual(others)
    expect(await noted()).toMatchObject({ revision: 9, keys: MANY, gone: 0, keptFrom: 9 })
    expect(await live(7)).toMatchObject({ revision: 9, whole: true })
    await removed()
    expect((await records()).map((r) => r.revision)).toEqual(Array.from({ length: MANY }, () => 9))
    // And the same where all of it is taken away
    const { t: t2, user: user2, page: page2, patch: patch2, state: state2, records: records2, removed: removed2 } = await withPage()
    await t2.run((ctx) =>
      ctx.db.insert('states', { artifactId: page2, userId: user2, json: JSON.stringify({ a: 1, [STORE_KEY]: names(MANY, (i) => i) }), revision: 3 }),
    )
    expect(await patch2({ [STORE_KEY]: null })).toEqual({ revision: 5 })
    expect(await state2()).toEqual({ a: 1 })
    await removed2()
    expect(await records2()).toEqual([])
  }, 120_000)
})
