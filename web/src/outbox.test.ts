// The site's outbox: a click is kept in this browser only while nobody knows what became of it.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { forgetAll, keepFor, letGoElsewhere } from './lib'
import {
  drain,
  dropOld,
  givenUpFor,
  onItsWay,
  outboxBelongsTo,
  outcomeOf,
  recoverLeftovers,
  type Sent,
  seenGivenUp,
  submit,
  unsaved,
  unsent,
  watchOutbox,
} from './outbox'

const envelope = (id: string, over: Partial<Sent> = {}): Sent => ({ v: 1, clientActionId: id, name: 'approve', payload: '{"n":1}', contentVersion: 1, ...over })
const refuse = (code: string, extra: Record<string, unknown> = {}) => new ConvexError({ code, message: code, ...extra })
/** A stand-in for the connection to the backend: each call is answered by the next thing in `answers`. */
function backend(answers: (unknown | Error | 'never')[]) {
  const calls: { artifactId: string; envelope: Sent }[] = []
  const mutation = vi.fn((_fn: unknown, args: { artifactId: string; envelope: Sent }) => {
    if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
    calls.push(args)
    const next = answers.shift()
    if (next === 'never') return new Promise(() => {})
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? { actionId: 'a1' })
  })
  return { client: { mutation, connectionState: () => ({ isWebSocketConnected: connected }) } as never, calls }
}
/** A stand-in for the backend that answers each click by its id: with what `answers` holds for it, or as accepted. */
function byId(answers: Record<string, unknown | Error>) {
  const mutation = vi.fn((_fn: unknown, args: { envelope: Sent }) => {
    if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
    const next = answers[args.envelope.clientActionId]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? { actionId: 'a1' })
  })
  return { mutation, connectionState: () => ({ isWebSocketConnected: true }) } as never
}
/**
 * A page sends a click and has gone before It answers, which It refuses for now: the click is
 * kept here, as that sending, to be sent later. It is refused for now while the outbox at once
 * tries again what it keeps, and that try is let finish, so that the test's own sending is the next.
 */
async function leftBehind(id: string) {
  const busy = {
    mutation: vi.fn((fn: unknown) =>
      getFunctionName(fn as never) === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * 86400_000 }) : Promise.reject(refuse('unavailable')),
    ),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never
  await expect(submit(busy, 'alice', 'page1', envelope(id), () => false)).rejects.toBeInstanceOf(ConvexError)
  await new Promise((resolve) => setTimeout(resolve, 50))
}
let connected = true
const keep = (user: string, id: string, at = Date.now() - 60_000, artifactId = 'page1') =>
  localStorage.setItem(`it.outbox.${user}.${artifactId}.${id}`, JSON.stringify({ user, artifactId, envelope: envelope(id), at }))
// A heartbeat's round trip that ended now, `ms` long by the clock that only goes forward and `wall` long by the browser's own
const trip = (ms: number, wall = ms) => ({
  sent: { mono: performance.now() - ms, wall: Date.now() - wall },
  back: { mono: performance.now(), wall: Date.now() },
})
const stored = () => Object.keys(localStorage).filter((k) => k.startsWith('it.outbox.'))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  connected = true
  outboxBelongsTo(null)
  outboxBelongsTo('alice')
})

describe('the outbox', () => {
  test('a click too old to send is dropped when the site starts, whoever it was kept for and whoever is paired here now', async () => {
    const WEEK = 7 * 86_400_000
    outboxBelongsTo(null)
    keep('alice', 'click-old-0001', Date.now() - WEEK - 60_000)
    keep('alice', 'click-new-0001', Date.now() - WEEK + 60_000)
    // Kept for people who are not paired here, and may never be again
    keep('bob', 'click-old-0002', Date.now() - 30 * 86_400_000)
    keep('bob', 'click-new-0002')
    // And one that cannot be read at all
    localStorage.setItem('it.outbox.carol.page1.click-0003', '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    dropOld()
    expect(stored().sort()).toEqual(['it.outbox.alice.page1.click-new-0001', 'it.outbox.bob.page1.click-new-0002'])
    // Nothing else the browser keeps is touched
    expect(localStorage.getItem('it.display')).toBe('a-display-key-000001')
    vi.restoreAllMocks()
  })

  test('a click that is accepted leaves nothing behind', async () => {
    const b = backend([{ actionId: 'a1' }])
    expect(await submit(b.client, 'alice', 'page1', envelope('click-0001'))).toEqual({ actionId: 'a1' })
    expect(stored()).toEqual([])
    expect(b.calls[0]).toMatchObject({ artifactId: 'page1', envelope: { clientActionId: 'click-0001' } })
  })

  test('a click is said to be on its way while it is being sent and while it is kept here to be sent, by the id its page gave it, and not once it is accepted', async () => {
    const answer: { done?: () => void } = {}
    // A backend that answers the click only when the test says
    const slow = {
      mutation: (fn: unknown) =>
        getFunctionName(fn as never) === 'actions:replayGrant'
          ? Promise.resolve({ until: Date.now() + 6 * 86400_000 })
          : new Promise((resolve) => {
              answer.done = () => resolve({ actionId: 'a1' })
            }),
      connectionState: () => ({ isWebSocketConnected: true }),
    } as never
    const sent = submit(slow, 'alice', 'page1', envelope('click-0090'))
    await new Promise((r) => setTimeout(r, 10))
    expect(onItsWay('alice', 'page1', 'click-0090')).toBe(true)
    expect(onItsWay('alice', 'page1', 'click-0091')).toBe(false)
    expect(onItsWay('alice', 'page2', 'click-0090')).toBe(false)
    answer.done?.()
    await sent
    expect(onItsWay('alice', 'page1', 'click-0090')).toBe(false)
    // One kept here from before, to be sent when it can be
    keep('alice', 'click-0092')
    expect(onItsWay('alice', 'page1', 'click-0092')).toBe(true)
  })

  test('a click a page of this tab sent, kept here and sent later, is remembered by how it ended: accepted, as the action It made of it, or refused for good, with why', async () => {
    await leftBehind('click-0095')
    await leftBehind('click-0096')
    expect(outcomeOf('alice', 'page1', 'click-0095')).toBeUndefined()
    await drain(byId({ 'click-0095': { actionId: 'a95' }, 'click-0096': refuse('invalid') }), 'alice')
    expect(outcomeOf('alice', 'page1', 'click-0095')).toEqual({ actionId: 'a95' })
    expect(outcomeOf('alice', 'page1', 'click-0096')).toEqual({ refused: 'invalid' })
    expect(outcomeOf('alice', 'page2', 'click-0095')).toBeUndefined()
    // And nothing is said of a click kept here that no page of this tab sent, such as one from before the site was opened
    keep('alice', 'click-0094')
    await drain(byId({ 'click-0094': { actionId: 'a94' } }), 'alice')
    expect(outcomeOf('alice', 'page1', 'click-0094')).toBeUndefined()
  })

  test('how a sending of a click ended is not said of a later sending under the same id, nor once the pairing it was made under is let go of', async () => {
    await leftBehind('click-0098')
    await drain(byId({ 'click-0098': { actionId: 'a98' } }), 'alice')
    expect(outcomeOf('alice', 'page1', 'click-0098')).toEqual({ actionId: 'a98' })
    // Sent again under the same id: what became of the first sending is not what becomes of this one
    const again = submit(byId({ 'click-0098': { actionId: 'a98-b' } }), 'alice', 'page1', envelope('click-0098'))
    expect(outcomeOf('alice', 'page1', 'click-0098')).toBeUndefined()
    await again
    expect(outcomeOf('alice', 'page1', 'click-0098')).toBeUndefined()
    // And what became of a click is forgotten with the pairing it was sent under
    await leftBehind('click-0099')
    await drain(byId({ 'click-0099': { actionId: 'a99' } }), 'alice')
    expect(outcomeOf('alice', 'page1', 'click-0099')).toEqual({ actionId: 'a99' })
    try {
      forgetAll('alice')
      expect(outcomeOf('alice', 'page1', 'click-0099')).toBeUndefined()
    } finally {
      // Paired for her again, as every other test here begins
      keepFor('alice')
      outboxBelongsTo('alice')
    }
  })

  test('a sending of what was kept before that ends after a new sending under the same id began does not say what became of the new one', async () => {
    keep('alice', 'click-0100')
    // The click kept from before is being sent, and its answer is held
    let answerOld: (err: Error) => void = () => {}
    const calls: string[] = []
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn((fn: unknown, args: { envelope: Sent }) => {
        if (getFunctionName(fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
        calls.push(args.envelope.clientActionId)
        if (calls.length === 1)
          return new Promise((_, reject) => {
            answerOld = reject
          })
        return Promise.reject(refuse('unavailable'))
      }),
    } as never
    const draining = drain(client, 'alice')
    await vi.waitFor(() => expect(calls).toEqual(['click-0100']))
    // A page sends a click under the same id meanwhile, which It refuses for now
    await expect(submit(client, 'alice', 'page1', envelope('click-0100'))).rejects.toBeInstanceOf(ConvexError)
    // Only now is the one from before refused for good: that is not what became of the new one
    answerOld(refuse('invalid'))
    await draining
    expect(outcomeOf('alice', 'page1', 'click-0100')).toBeUndefined()
  })

  test('a sending of what was kept before, whose lock is given only after a page began a new sending under the same id, does not say what became of the new one', async () => {
    keep('alice', 'click-0102')
    // The browser's locks, given a moment after they are asked for, one holder at a time
    const taken = new Set<string>()
    const later = {
      request: async (name: string, options: { ifAvailable?: boolean }, work: (lock: unknown) => Promise<unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        if (taken.has(name)) {
          if (options.ifAvailable) return work(null)
          while (taken.has(name)) await new Promise((resolve) => setTimeout(resolve, 5))
        }
        taken.add(name)
        try {
          return await work({ name })
        } finally {
          taken.delete(name)
        }
      },
    }
    Object.defineProperty(navigator, 'locks', { configurable: true, value: later })
    try {
      // What was kept asks for the lock first, and a page sends the same id before it is given
      const b = backend([refuse('invalid'), refuse('unavailable')])
      const draining = drain(b.client, 'alice')
      const sent = submit(b.client, 'alice', 'page1', envelope('click-0102'))
      // The one kept from before is refused for good; the page's is refused for now, and it was told
      await expect(sent).rejects.toBeInstanceOf(ConvexError)
      await draining
      expect(b.calls.length).toBe(2)
      expect(outcomeOf('alice', 'page1', 'click-0102')).toBeUndefined()
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })

  test('what became of a kept click is forgotten when the browser is paired under another session, of the same person or another', async () => {
    await leftBehind('click-0101')
    await drain(byId({ 'click-0101': { actionId: 'a101' } }), 'alice')
    expect(outcomeOf('alice', 'page1', 'click-0101')).toEqual({ actionId: 'a101' })
    outboxBelongsTo('alice', 'session-2')
    expect(outcomeOf('alice', 'page1', 'click-0101')).toBeUndefined()
  })

  test('a kept click refused for good, and kept only so that the person is told, is not on its way', async () => {
    // Kept from before the upgrade, and refused as a conflict when it is sent: kept to say so, and never sent again
    keep('alice', 'click-0097')
    await drain(byId({ 'click-0097': refuse('conflict') }), 'alice')
    expect(stored()).toContain('it.outbox.alice.page1.click-0097')
    expect(onItsWay('alice', 'page1', 'click-0097')).toBe(false)
  })

  test('told to slow down, it waits and tries again, since the person did click', async () => {
    const b = backend([refuse('rate_limited', { retryAfterMs: 300 }), refuse('rate_limited', { retryAfterMs: 300 }), { actionId: 'a2' }])
    expect(await submit(b.client, 'alice', 'page1', envelope('click-0002'))).toEqual({ actionId: 'a2' })
    expect(b.calls.length).toBe(3)
    expect(stored()).toEqual([])
  })

  test('a click the page is told has failed is not kept to be sent later behind the person’s back', async () => {
    const full = backend(Array.from({ length: 10 }, () => refuse('limit', { retryAfterMs: 250 })))
    await expect(submit(full.client, 'alice', 'page1', envelope('click-0003'))).rejects.toBeInstanceOf(ConvexError)
    expect(full.calls.length).toBe(4)
    expect(stored()).toEqual([])
    const bad = backend([refuse('invalid')])
    await expect(submit(bad.client, 'alice', 'page1', envelope('click-0004'))).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toEqual([])
    // Told to wait a long time for its agent: not waited for at all
    const long = backend([refuse('limit', { retryAfterMs: 60_000 })])
    await expect(submit(long.client, 'alice', 'page1', envelope('click-0005'))).rejects.toBeInstanceOf(ConvexError)
    expect(long.calls.length).toBe(1)
  })

  test('told it came too fast, a click waits its turn as often as it is told to, and is sent', async () => {
    const slow = backend([...Array.from({ length: 8 }, () => refuse('rate_limited', { retryAfterMs: 250 })), { actionId: 'late' }])
    expect(await submit(slow.client, 'alice', 'page1', envelope('click-0050'))).toEqual({ actionId: 'late' })
    expect(slow.calls.length).toBe(9)
    expect(stored()).toEqual([])
  })

  test('clicks that come faster than It takes them are all sent, one at a time and in the order they were made, and not each sent again and again', async () => {
    // It takes three at once, and then one each 200 milliseconds
    let tokens = 3
    let filled = Date.now()
    const taken: string[] = []
    let refused = 0
    const mutation = vi.fn((fn: unknown, args: { envelope: Sent }) => {
      if (getFunctionName(fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
      tokens = Math.min(3, tokens + (Date.now() - filled) / 200)
      filled = Date.now()
      if (tokens < 1) {
        refused++
        return Promise.reject(refuse('rate_limited', { retryAfterMs: Math.ceil((1 - tokens) * 200) }))
      }
      tokens -= 1
      taken.push(args.envelope.clientActionId)
      return Promise.resolve({ actionId: args.envelope.clientActionId })
    })
    const client = { mutation, connectionState: () => ({ isWebSocketConnected: true }) } as never
    const ids = Array.from({ length: 12 }, (_, i) => `click-01${String(i).padStart(2, '0')}`)
    const sent = []
    for (const id of ids) {
      sent.push(submit(client, 'alice', 'page1', envelope(id)))
      await new Promise((r) => setTimeout(r, 5))
    }
    expect((await Promise.all(sent)).map((r) => r.actionId)).toEqual(ids)
    expect(taken).toEqual(ids)
    // Each click that waited was refused about once, and not once for each other click that waited with it
    expect(refused).toBeLessThan(2 * ids.length)
    expect(stored()).toEqual([])
  })

  test('a click that is refused and not kept is said in its page’s bar, and one kept for later is not', async () => {
    const { refusedLately } = await import('./outbox')
    const bad = backend([refuse('invalid')])
    await expect(submit(bad.client, 'alice', 'page-said', envelope('click-0060'))).rejects.toBeInstanceOf(ConvexError)
    expect(refusedLately('alice', 'page-said')).toMatchObject({ fast: 0, other: 1, why: 'invalid' })
    expect(refusedLately('alice', 'another-page')).toBeNull()
    expect(refusedLately('bob', 'page-said')).toBeNull()
    // Refused while the page that sent it had gone: kept, and sent later, and nothing is said of it
    const gone = backend([refuse('rate_limited', { retryAfterMs: 250 }), 'never'])
    await expect(submit(gone.client, 'alice', 'page-kept', envelope('click-0061'), () => false)).rejects.toBeInstanceOf(ConvexError)
    await new Promise((r) => setTimeout(r, 400))
    expect(gone.calls.length).toBe(2)
    expect(refusedLately('alice', 'page-kept')).toBeNull()
    // And it is said for a while, and then not
    expect(refusedLately('alice', 'page-said', Date.now() + 31_000)).toBeNull()
  })

  test('a click nobody ever answered is sent on that person’s next visit, and nobody else’s', async () => {
    const lost = backend(['never'])
    void submit(lost.client, 'alice', 'page1', envelope('click-0006'))
    await new Promise((r) => setTimeout(r, 10))
    expect(stored()).toEqual(['it.outbox.alice.page1.click-0006'])
    expect(unsent('alice', 'page1')).toBe(1)
    expect(unsent('alice', 'another-page')).toBe(0)
    expect(unsent('bob', 'page1')).toBe(0)
    // The browser is paired for someone else: Alice's click is neither sent as them nor thrown away
    outboxBelongsTo('bob')
    const bob = backend([])
    await drain(bob.client, 'bob')
    await drain(bob.client, 'alice')
    expect(bob.calls).toEqual([])
    expect(stored()).toEqual(['it.outbox.alice.page1.click-0006'])
    // Alice comes back, some time later
    const k = 'it.outbox.alice.page1.click-0006'
    // The tab that was sending it is long gone, and so is its hold on it
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), at: Date.now() - 60_000, held: Date.now() - 45_000 }))
    outboxBelongsTo('alice')
    const alice = backend([{ actionId: 'a6' }])
    await drain(alice.client, 'alice')
    expect(alice.calls[0]).toMatchObject({ envelope: { clientActionId: 'click-0006' } })
    expect(stored()).toEqual([])
  })

  test('a click is sent with when it was done, by the backend’s clock as the browser knew it then, the same each time it is sent, and with nothing where that clock was not known', async () => {
    const HOUR = 3_600_000
    // A site just opened, which has not yet heard the backend's clock
    vi.resetModules()
    const lib = await import('./lib')
    const site = await import('./outbox')
    site.outboxBelongsTo('alice')
    try {
      const unknown = backend([{ actionId: 'a1' }])
      await site.submit(unknown.client, 'alice', 'page1', envelope('click-made-0001'))
      expect(unknown.calls[0]).not.toHaveProperty('madeAt')
      // A heartbeat's answer was taken in twenty seconds after it was asked, as one is in a tab held back from running: it is not learned from
      lib.learnClock(Date.now() - HOUR, trip(20_000))
      const slow = backend([{ actionId: 'a0' }])
      await site.submit(slow.client, 'alice', 'page1', envelope('click-made-0003'))
      expect(slow.calls[0]).not.toHaveProperty('madeAt')
      // Nor is one the machine slept through, which the clock that only goes forward took for a tenth of a second, as it stands still while asleep in some browsers
      lib.learnClock(Date.now() - HOUR, trip(100, 20_000))
      const slept = backend([{ actionId: 'a5' }])
      await site.submit(slept.client, 'alice', 'page1', envelope('click-made-0004'))
      expect(slept.calls[0]).not.toHaveProperty('madeAt')
      // The backend's clock is an hour behind this browser's, as a heartbeat that took a tenth of a second says, and It cannot be reached
      lib.learnClock(Date.now() - HOUR, trip(100))
      lib.learnTakes(['actions.madeAt'])
      const lost = backend(['never'])
      void site.submit(lost.client, 'alice', 'page1', envelope('click-made-0002'))
      await new Promise((r) => setTimeout(r, 10))
      const { madeAt: made, madeWithin } = lost.calls[0] as unknown as { madeAt: number; madeWithin: number }
      expect(Math.abs(made - (Date.now() - HOUR))).toBeLessThan(1000)
      expect(madeWithin).toBeGreaterThanOrEqual(50)
      expect(madeWithin).toBeLessThan(1000)
      // The tab is closed, and the click is sent on a later visit, a while on, saying the same
      const k = 'it.outbox.alice.page1.click-made-0002'
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), at: Date.now() - 60_000, held: Date.now() - 45_000 }))
      vi.resetModules()
      ;(await import('./lib')).learnTakes(['actions.madeAt'])
      const later = await import('./outbox')
      later.outboxBelongsTo('alice')
      const back = backend([{ actionId: 'a2' }])
      await later.drain(back.client, 'alice')
      later.outboxBelongsTo(null)
      expect(back.calls[0]).toMatchObject({ envelope: { clientActionId: 'click-made-0002' }, madeAt: made, madeWithin })
      // A message typed above a page, and a notification's button, say when they were done too
      const said = backend([{ actionId: 'a3' }, { actionId: 'a4' }])
      await site.message(said.client, 'alice', 'page1', 'typed-made-0001', 'Go ahead')
      await site.answerNotification(said.client, 'note-1', 'yes')
      for (const call of said.calls) {
        expect(Math.abs((call as unknown as { madeAt: number }).madeAt - (Date.now() - HOUR))).toBeLessThan(1000)
        expect(call).toHaveProperty('madeWithin')
      }
      expect(said.calls.length).toBe(2)
    } finally {
      site.outboxBelongsTo(null)
    }
  })

  test('a backend that has not said it takes when a click was made is not sent it, and takes the click, which keeps that time here for a backend that does', async () => {
    vi.resetModules()
    const lib = await import('./lib')
    const site = await import('./outbox')
    site.outboxBelongsTo('alice')
    try {
      lib.learnClock(Date.now(), trip(100))
      // An older backend, which refuses a call with an argument it does not know
      const older = (answers: unknown[]) => {
        const b = backend(answers)
        const mutation = b.client as unknown as { mutation: ReturnType<typeof vi.fn> }
        const inner = mutation.mutation.getMockImplementation()!
        mutation.mutation.mockImplementation((fn: unknown, args: Record<string, unknown>) =>
          'madeAt' in args || 'madeWithin' in args
            ? Promise.reject(new Error('ArgumentValidationError: Object contains extra field `madeAt`'))
            : inner(fn, args),
        )
        return b
      }
      lib.learnTakes(undefined)
      const now = older([{ actionId: 'a1' }, { actionId: 'a2' }, { actionId: 'a3' }])
      expect(await site.submit(now.client, 'alice', 'page1', envelope('click-older-0001'))).toEqual({ actionId: 'a1' })
      expect(await site.message(now.client, 'alice', 'page1', 'typed-older-0001', 'Go ahead')).toEqual({ actionId: 'a2' })
      expect(await site.answerNotification(now.client, 'note-1', 'yes')).toEqual({ actionId: 'a3' })
      expect(now.calls).toHaveLength(3)
      for (const call of now.calls) {
        expect(call).not.toHaveProperty('madeAt')
        expect(call).not.toHaveProperty('madeWithin')
      }
      // One saved while It cannot be reached keeps when it was made here all the same
      const lost = older(['never'])
      void site.submit(lost.client, 'alice', 'page1', envelope('click-older-0002'))
      await new Promise((r) => setTimeout(r, 10))
      const k = 'it.outbox.alice.page1.click-older-0002'
      const kept = JSON.parse(localStorage.getItem(k)!)
      expect(kept).toMatchObject({ madeAt: expect.any(Number), madeWithin: expect.any(Number) })
      // And sends it to a backend that has said it takes it, on a later visit
      localStorage.setItem(k, JSON.stringify({ ...kept, at: Date.now() - 60_000, held: Date.now() - 45_000 }))
      vi.resetModules()
      ;(await import('./lib')).learnTakes(['actions.madeAt'])
      const later = await import('./outbox')
      later.outboxBelongsTo('alice')
      const back = backend([{ actionId: 'a4' }])
      await later.drain(back.client, 'alice')
      later.outboxBelongsTo(null)
      expect(back.calls[0]).toMatchObject({ envelope: { clientActionId: 'click-older-0002' }, madeAt: kept.madeAt, madeWithin: kept.madeWithin })
    } finally {
      site.outboxBelongsTo(null)
    }
  })

  test('two pages that choose the same id for a click do not overwrite each other’s', async () => {
    const lost = backend(['never', 'never'])
    void submit(lost.client, 'alice', 'page1', envelope('submit-0001'))
    void submit(lost.client, 'alice', 'page2', envelope('submit-0001'))
    await new Promise((r) => setTimeout(r, 10))
    expect(stored().sort()).toEqual(['it.outbox.alice.page1.submit-0001', 'it.outbox.alice.page2.submit-0001'])
  })

  test('on a later visit it carries on until nothing is left, waiting when told to slow down', async () => {
    for (const id of ['click-0007', 'click-0008', 'click-0009']) keep('alice', id)
    // The first is refused for good, the second is told to slow down and then accepted, the third accepted
    const b = backend([refuse('not_found'), refuse('rate_limited', { retryAfterMs: 300 }), { actionId: 'a8' }, { actionId: 'a9' }])
    await drain(b.client, 'alice')
    expect(stored()).toEqual([])
    // The page was told to slow down, so everything for it waits its time, in order
    expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0007', 'click-0008', 'click-0008', 'click-0009'])
  })

  test('nor one that was passed by for a moment: it goes as soon as that moment is over, while the other page is still being told to slow down', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-a1', Date.now() - 63_000, 'page-a')
      // Another tab holds B's click for one more second
      localStorage.setItem(
        'it.outbox.alice.page-b.click-b1',
        JSON.stringify({ user: 'alice', artifactId: 'page-b', envelope: envelope('click-b1'), at: Date.now() - 61_000, held: Date.now() + 1000 }),
      )
      const calls: string[] = []
      const client = {
        mutation: vi.fn((_fn: unknown, args: { artifactId: string; envelope: Sent }) => {
          if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
          calls.push(args.envelope.clientActionId)
          return args.artifactId === 'page-a' ? Promise.reject(refuse('rate_limited', { retryAfterMs: 1000 })) : Promise.resolve({ actionId: 'b1' })
        }),
        connectionState: () => ({ isWebSocketConnected: true }),
      } as never
      const draining = drain(client, 'alice')
      await vi.advanceTimersByTimeAsync(500)
      expect(calls).toEqual(['click-a1'])
      // B's hold is over a second in. It is sent then, and not minutes later when A's turn ends
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls.filter((c) => c === 'click-b1')).toHaveLength(1)
      expect(stored()).toEqual(['it.outbox.alice.page-a.click-a1'])
      outboxBelongsTo(null)
      await vi.advanceTimersByTimeAsync(2000)
      await draining
    } finally {
      vi.useRealTimers()
    }
  })

  test('nor one that met trouble once: it is tried again a few seconds later, however long the other page goes on being told to slow down', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-a1', Date.now() - 63_000, 'page-a')
      keep('alice', 'click-b1', Date.now() - 61_000, 'page-b')
      const calls: string[] = []
      let troubleLeft = 1
      const client = {
        mutation: vi.fn((_fn: unknown, args: { artifactId: string; envelope: Sent }) => {
          if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
          calls.push(args.envelope.clientActionId)
          if (args.artifactId === 'page-a') return Promise.reject(refuse('rate_limited', { retryAfterMs: 1000 }))
          // B's first try meets trouble that has passed by the next
          return troubleLeft-- > 0 ? Promise.reject(new Error('the backend is in trouble')) : Promise.resolve({ actionId: 'b1' })
        }),
        connectionState: () => ({ isWebSocketConnected: true }),
      } as never
      const draining = drain(client, 'alice')
      await vi.advanceTimersByTimeAsync(500)
      expect(calls.filter((c) => c === 'click-b1')).toHaveLength(1)
      expect(stored().sort()).toEqual(['it.outbox.alice.page-a.click-a1', 'it.outbox.alice.page-b.click-b1'])
      // Tried again within ten seconds, and sent, while A is still being refused
      await vi.advanceTimersByTimeAsync(9000)
      expect(calls.filter((c) => c === 'click-b1')).toHaveLength(2)
      expect(stored()).toEqual(['it.outbox.alice.page-a.click-a1'])
      outboxBelongsTo(null)
      await vi.advanceTimersByTimeAsync(2000)
      await draining
    } finally {
      vi.useRealTimers()
    }
  })

  test('a click whose lock is given only after the browser has been paired for someone else is not sent as them', async () => {
    keep('alice', 'click-0090')
    let work!: (lock: object) => Promise<unknown>
    let give!: (v: unknown) => void
    const given = new Promise((r) => {
      give = r
    })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_key: unknown, _options: unknown, fn: (lock: object) => Promise<unknown>) => {
          work = fn
          return given
        },
      },
    })
    try {
      const b = backend([{ actionId: 'never-asked' }])
      const draining = drain(b.client, 'alice')
      // The lock is asked for as Alice. Before it is given, the browser is paired for Bob
      outboxBelongsTo('bob')
      give(await work({ name: 'lock' }))
      await draining
      expect(b.calls).toEqual([])
      expect(stored()).toEqual([])
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })

  test('a page that is told to slow down, again and again, holds up no other page’s clicks', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-a1', Date.now() - 63_000, 'page-a')
      keep('alice', 'click-a2', Date.now() - 62_000, 'page-a')
      keep('alice', 'click-b1', Date.now() - 61_000, 'page-b')
      const calls: string[] = []
      const client = {
        mutation: vi.fn((_fn: unknown, args: { artifactId: string; envelope: Sent }) => {
          if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
          calls.push(args.envelope.clientActionId)
          // Page A has used up what it is allowed, and goes on being refused. Page B has not.
          return args.artifactId === 'page-a' ? Promise.reject(refuse('rate_limited', { retryAfterMs: 1000 })) : Promise.resolve({ actionId: 'b1' })
        }),
        connectionState: () => ({ isWebSocketConnected: true }),
      } as never
      const draining = drain(client, 'alice')
      await vi.advanceTimersByTimeAsync(50)
      // B's click went at once, behind one try for A, and A's second click was not tried ahead of its first
      expect(calls).toEqual(['click-a1', 'click-b1'])
      expect(stored().sort()).toEqual(['it.outbox.alice.page-a.click-a1', 'it.outbox.alice.page-a.click-a2'])
      // A is tried again when it said to come back, and only then, however long this goes on
      await vi.advanceTimersByTimeAsync(3000)
      expect(calls.filter((c) => c === 'click-b1')).toHaveLength(1)
      expect(calls.filter((c) => c === 'click-a1').length).toBeGreaterThanOrEqual(3)
      expect(calls).not.toContain('click-a2')
      outboxBelongsTo(null)
      await vi.advanceTimersByTimeAsync(2000)
      await draining
    } finally {
      vi.useRealTimers()
    }
  })

  test('not being paired at that moment, or the backend being in trouble, removes nothing', async () => {
    keep('alice', 'click-0010')
    keep('alice', 'click-0011')
    await drain(backend([refuse('unauthenticated'), refuse('unauthenticated')]).client, 'alice')
    await drain(backend([new Error('Server Error'), new Error('Server Error')]).client, 'alice')
    expect(stored().length).toBe(2)
    // A week on, nobody wants them any more
    keep('alice', 'click-0010', Date.now() - 8 * 86_400_000)
    keep('alice', 'click-0011', Date.now() - 8 * 86_400_000)
    await drain(backend([]).client, 'alice')
    expect(stored()).toEqual([])
  })

  test('if the browser is paired for someone else while legacy clicks are being sent, sending stops and their saved payloads are discarded', async () => {
    keep('alice', 'click-0012')
    keep('alice', 'click-0013')
    const calls: string[] = []
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn(async (_fn: unknown, args: { envelope: Sent }) => {
        if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
        calls.push(args.envelope.clientActionId)
        // While the first is on its way, the browser is paired for Bob. The answer that comes
        // back is the one Bob would get: there is no such page of his.
        outboxBelongsTo('bob')
        throw refuse('not_found')
      }),
    } as never
    await drain(client, 'alice')
    expect(calls).toEqual(['click-0012'])
    expect(stored()).toEqual([])
  })

  test('a "not now" that comes back after the page has gone leaves the click to be sent later', async () => {
    let there = true
    const b = backend([refuse('rate_limited', { retryAfterMs: 400 }), refuse('rate_limited', { retryAfterMs: 400 }), { actionId: 'late' }])
    const sent = submit(b.client, 'alice', 'page1', envelope('click-0014'), () => there)
    there = false
    await expect(sent).rejects.toBeInstanceOf(ConvexError)
    // Nobody was told it failed, so it is still here, and the drain that follows sends it
    await new Promise((r) => setTimeout(r, 700))
    expect(b.calls.length).toBe(3)
    expect(stored()).toEqual([])
  })

  test('when the browser will not store a click, it is sent if there is a connection and refused plainly if there is not', async () => {
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      expect(await submit(backend([{ actionId: 'x1' }]).client, 'alice', 'page1', envelope('click-0015'))).toEqual({ actionId: 'x1' })
      connected = false
      const offline = backend(['never'])
      await expect(submit(offline.client, 'alice', 'page1', envelope('click-0016'))).rejects.toThrow(/could not be saved or sent/)
      expect(offline.calls).toEqual([])
    } finally {
      full.mockRestore()
    }
  })

  test.each(['invalid', 'not_found', 'conflict'])('unsaved clicks refused with %s leave room for another request', async (code) => {
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const b = backend(Array.from({ length: 100 }, () => refuse(code)))
    try {
      // Each refusal settles its request, so none may keep a place in the browser's limit of 100 grants.
      for (let i = 0; i < 100; i++) {
        await expect(submit(b.client, 'alice', 'page1', envelope(`refused-click-${i}`))).rejects.toThrow(code)
      }
      await expect(submit(b.client, 'alice', 'page1', envelope('accepted-click'))).resolves.toEqual({ actionId: 'a1' })
      expect(b.calls).toHaveLength(101)
      expect(stored()).toEqual([])
      expect(unsaved('alice', 'page1')).toBe(0)
    } finally {
      full.mockRestore()
    }
  })

  test('a retry reuses its original deadline after storage recovers from an unconfirmed request', async () => {
    outboxBelongsTo('alice', 'session-1')
    const b = backend([new Error('answer lost'), { actionId: 'already-accepted' }])
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await expect(submit(b.client, 'alice', 'page1', envelope('click-unrecorded'))).rejects.toThrow('answer lost')
    full.mockRestore()
    const deadline = (b.calls[0] as unknown as { replayUntil: number }).replayUntil
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1)
    try {
      await submit(b.client, 'alice', 'page1', envelope('click-unrecorded'))
      expect((b.calls[1] as unknown as { replayUntil: number }).replayUntil).toBe(deadline)
    } finally {
      now.mockRestore()
    }
  })

  test.each(['legacy', 'session-bound'] as const)('a cold unpaired start discards %s work only after the pairing has been answered', (kind) => {
    outboxBelongsTo(null)
    const key = 'it.outbox.alice.page1.old-session-click'
    const saved = {
      user: 'alice',
      artifactId: 'page1',
      envelope: envelope('old-session-click'),
      ...(kind === 'session-bound' ? { format: 2, session: 'ended-session' } : {}),
      at: Date.now(),
    }
    localStorage.setItem(key, JSON.stringify(saved))
    outboxBelongsTo(null, null, false)
    expect(localStorage.getItem(key)).not.toBeNull()
    outboxBelongsTo(null, null, true)
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem('it.display')).toBe('a-display-key-000001')
  })

  test('what a page may send is checked before anything is stored', async () => {
    const b = backend([])
    await expect(submit(b.client, 'alice', 'page1', envelope('short'))).rejects.toThrow()
    await expect(submit(b.client, 'alice', 'page1', envelope('click-0020', { name: 'x'.repeat(100_000) }))).rejects.toThrow()
    await expect(submit(b.client, 'alice', 'page1', envelope('click-0021', { payload: JSON.stringify('x'.repeat(40_000)) }))).rejects.toThrow(/at most/)
    expect(stored()).toEqual([])
    expect(b.calls).toEqual([])
  })

  test('with far too many unanswered already, one more is refused and none is pushed out', async () => {
    for (let i = 0; i < 200; i++) keep('alice', `old-${String(i).padStart(5, '0')}`, Date.now() - 60_000, `page${i % 4}`)
    await expect(submit(backend([]).client, 'alice', 'page9', envelope('click-0022'))).rejects.toThrow(/Too many/)
    expect(stored().length).toBe(200)
    // Another person on the same browser is not affected by that
    outboxBelongsTo('bob')
    expect(await submit(backend([{ actionId: 'b1' }]).client, 'bob', 'page2', envelope('click-0023'))).toEqual({ actionId: 'b1' })
  })

  test('one page can hold only part of what the browser keeps, so it cannot crowd out the others', async () => {
    for (let i = 0; i < 99; i++) keep('alice', `old-${String(i).padStart(5, '0')}`, Date.now() - 60_000, 'page1')
    // A page has room for a hundred, more than It takes from a page at once
    expect(await submit(backend([{ actionId: 'p1' }]).client, 'alice', 'page1', envelope('click-0029'))).toEqual({ actionId: 'p1' })
    keep('alice', 'old-00099', Date.now() - 60_000, 'page1')
    await expect(submit(backend([]).client, 'alice', 'page1', envelope('click-0030'))).rejects.toThrow(/Too many/)
    expect(await submit(backend([{ actionId: 'p2' }]).client, 'alice', 'page2', envelope('click-0031'))).toEqual({ actionId: 'p2' })
  })

  test('a click being sent when the browser is paired for someone else is neither sent as them nor thrown away', async () => {
    const b = backend([refuse('rate_limited', { retryAfterMs: 300 }), { actionId: 'as-bob' }])
    const sent = submit(b.client, 'alice', 'page1', envelope('click-0040'))
    await new Promise((r) => setTimeout(r, 50))
    // The browser is paired for Bob while Alice's click is waiting to be tried again
    outboxBelongsTo('bob')
    await expect(sent).rejects.toThrow('This browser’s pairing has ended.')
    expect(b.calls.length).toBe(1)
    expect(stored()).toEqual(['it.outbox.alice.page1.click-0040'])
    // And one whose answer comes back after the change is kept too, whatever the answer was
    outboxBelongsTo('alice')
    localStorage.clear()
    localStorage.setItem('it.display', 'a-display-key-000001')
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn(async () => {
        outboxBelongsTo('bob')
        throw refuse('not_found')
      }),
    } as never
    await expect(submit(client, 'alice', 'page1', envelope('click-0041'))).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toEqual(['it.outbox.alice.page1.click-0041'])
  })

  test('any refusal that comes back after the page has gone leaves the click, unless it would be the same every time', async () => {
    const trouble = backend([new Error('Server Error'), new Error('Server Error')])
    await expect(submit(trouble.client, 'alice', 'page1', envelope('click-0050'), () => false)).rejects.toThrow()
    // The drain that follows finds the backend still in trouble, and leaves it for later
    await new Promise((r) => setTimeout(r, 20))
    expect(stored()).toEqual(['it.outbox.alice.page1.click-0050'])
    localStorage.removeItem('it.outbox.alice.page1.click-0050')
    const final = backend([refuse('invalid')])
    await expect(submit(final.client, 'alice', 'page1', envelope('click-0051'), () => false)).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toEqual([])
  })

  test('a click that cannot be sent just now does not hold up the ones behind it, and is tried again by itself', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-0060', Date.now() - 63_000)
      keep('alice', 'click-0061', Date.now() - 62_000)
      const b = backend([new Error('Server Error'), { actionId: 'a61' }, { actionId: 'a60' }])
      await drain(b.client, 'alice')
      expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0060', 'click-0061'])
      expect(stored()).toEqual(['it.outbox.alice.page1.click-0060'])
      // Nobody reloads the site or reconnects: it is tried again all the same
      await vi.advanceTimersByTimeAsync(6000)
      expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0060', 'click-0061', 'click-0060'])
      expect(stored()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a click for a page whose queue is full at the moment is kept, tried again later, and holds up nothing behind it', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-0070', Date.now() - 63_000, 'full-page')
      keep('alice', 'click-0071', Date.now() - 62_000, 'other-page')
      const b = backend([refuse('limit'), { actionId: 'a71' }, { actionId: 'a70' }])
      await drain(b.client, 'alice')
      // The click for the full page waits; the one behind it, for another page, is not held up
      expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0070', 'click-0071'])
      expect(stored()).toEqual(['it.outbox.alice.full-page.click-0070'])
      await vi.advanceTimersByTimeAsync(6000)
      expect(b.calls.length).toBe(3)
      expect(stored()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a drain asked for while one is running is run again afterwards, and one person’s never blocks another’s', async () => {
    keep('alice', 'click-0080')
    let release: (v: unknown) => void = () => {}
    const calls: string[] = []
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn((_fn: unknown, args: { envelope: Sent }) => {
        if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
        calls.push(args.envelope.clientActionId)
        return calls.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ actionId: 'x' })
      }),
    } as never
    const first = drain(client, 'alice')
    await new Promise((r) => setTimeout(r, 10))
    // Saved while the first drain is under way, and a drain is asked for
    keep('alice', 'click-0081', Date.now() - 30_000)
    await drain(client, 'alice')
    release({ actionId: 'a80' })
    await first
    expect(calls).toEqual(['click-0080', 'click-0081'])
    expect(stored()).toEqual([])
  })

  test('a click is saved before anything that takes time, and what is judged meanwhile is filled in before it is sent', async () => {
    const b = backend([{ actionId: 'a95' }])
    let decide: (v: boolean) => void = () => {}
    const sent = submit(
      b.client,
      'alice',
      'page1',
      { ...envelope('click-0095'), attended: false },
      () => true,
      () => new Promise((r) => (decide = r)),
    )
    await new Promise((r) => setTimeout(r, 10))
    // Still being judged: nothing has been sent, and it is already kept, as one the page sent by itself
    expect(b.calls).toEqual([])
    expect(JSON.parse(localStorage.getItem('it.outbox.alice.page1.click-0095') ?? '{}').envelope).toMatchObject({
      clientActionId: 'click-0095',
      attended: false,
    })
    decide(true)
    await sent
    expect(b.calls[0]!.envelope).toMatchObject({ clientActionId: 'click-0095', attended: true })
    expect(stored()).toEqual([])
  })

  test('a click saved a moment ago is left to the page that is still sending it, and picked up later if it never was', async () => {
    vi.useFakeTimers()
    try {
      keep('alice', 'click-0097', Date.now() - 2000)
      const b = backend([{ actionId: 'a97' }])
      await drain(b.client, 'alice')
      // Its page may still be judging whether the person was there: it is not sent from here yet
      expect(b.calls).toEqual([])
      expect(stored()).toEqual(['it.outbox.alice.page1.click-0097'])
      await vi.advanceTimersByTimeAsync(12_000)
      expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0097'])
      expect(stored()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a click this tab is still sending is not also sent by the replay, however long the sending takes', async () => {
    let answer: (v: unknown) => void = () => {}
    const calls: string[] = []
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn((_fn: unknown, args: { envelope: Sent }) => {
        if (getFunctionName(_fn as never) === 'actions:replayGrant') return Promise.resolve({ until: Date.now() + 6 * 86400_000 })
        calls.push(args.envelope.clientActionId)
        return new Promise((r) => (answer = r))
      }),
    } as never
    const sent = submit(client, 'alice', 'page1', envelope('click-0098'))
    await new Promise((r) => setTimeout(r, 10))
    // The connection has been slow for more than the ten seconds a saved click is left alone for
    const k = 'it.outbox.alice.page1.click-0098'
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), at: Date.now() - 60_000 }))
    void drain(client, 'alice')
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toEqual(['click-0098'])
    answer({ actionId: 'a98' })
    expect(await sent).toEqual({ actionId: 'a98' })
    outboxBelongsTo(null)
  })

  test('a click another tab is still sending is left to that tab, and taken up only if that tab has gone', async () => {
    vi.useFakeTimers()
    try {
      // Saved a minute ago by another tab, which is still sending it and says so
      const k = 'it.outbox.alice.page1.click-0099'
      localStorage.setItem(
        k,
        JSON.stringify({ user: 'alice', artifactId: 'page1', envelope: envelope('click-0099'), at: Date.now() - 60_000, held: Date.now() + 12_000 }),
      )
      const b = backend([{ actionId: 'a99' }])
      await drain(b.client, 'alice')
      expect(b.calls).toEqual([])
      // That tab renews its hold: still left alone
      await vi.advanceTimersByTimeAsync(10_000)
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), held: Date.now() + 12_000 }))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(b.calls).toEqual([])
      // The tab is closed, and its hold runs out: the click is sent from here
      await vi.advanceTimersByTimeAsync(20_000)
      expect(b.calls.map((c) => c.envelope.clientActionId)).toEqual(['click-0099'])
      expect(stored()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('where the browser has locks its tabs share, a tab whose timers have stopped still keeps the click it is sending', async () => {
    // A stand-in for the browser's own locks, shared by every "tab" in this test
    const taken = new Set<string>()
    const shared = {
      request: async (name: string, options: { ifAvailable?: boolean }, work: (lock: unknown) => Promise<unknown>) => {
        if (taken.has(name)) {
          if (options.ifAvailable) return work(null)
          await new Promise<void>((free) => {
            const t = setInterval(() => {
              if (!taken.has(name)) {
                clearInterval(t)
                free()
              }
            }, 5)
          })
        }
        taken.add(name)
        try {
          return await work({ name })
        } finally {
          taken.delete(name)
        }
      },
    }
    Object.defineProperty(navigator, 'locks', { configurable: true, value: shared })
    try {
      // One tab is sending a click, and the answer is slow in coming
      let answer: (v: unknown) => void = () => {}
      const first = {
        connectionState: () => ({ isWebSocketConnected: true }),
        mutation: vi.fn((fn: unknown) =>
          getFunctionName(fn as never) === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * 86400_000 }) : new Promise((r) => (answer = r)),
        ),
      } as never
      const sent = submit(first, 'alice', 'page1', envelope('click-0101'))
      await new Promise((r) => setTimeout(r, 20))
      // The browser put that tab to sleep: its hold, kept up by a timer, has run out
      const k = 'it.outbox.alice.page1.click-0101'
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), at: Date.now() - 60_000, held: Date.now() - 30_000 }))
      // Another tab of the site looks at what is waiting to be sent
      vi.resetModules()
      const otherTab = await import('./outbox')
      otherTab.outboxBelongsTo('alice')
      const second = backend([{ actionId: 'from-the-other-tab' }])
      await otherTab.drain(second.client, 'alice')
      expect(second.calls).toEqual([])
      otherTab.outboxBelongsTo(null)
      // The first tab wakes and is told to slow down for good: the page is told it failed, and nothing else was ever sent
      answer(Promise.reject(refuse('limit')))
      await expect(sent).rejects.toBeInstanceOf(ConvexError)
      expect(stored()).toEqual([])
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
      outboxBelongsTo(null)
    }
  })

  test('a tab keeps up its hold on a click for as long as it is sending it', async () => {
    vi.useFakeTimers()
    try {
      let answer: (v: unknown) => void = () => {}
      const client = {
        connectionState: () => ({ isWebSocketConnected: true }),
        mutation: vi.fn((fn: unknown) =>
          getFunctionName(fn as never) === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * 86400_000 }) : new Promise((r) => (answer = r)),
        ),
      } as never
      const sent = submit(client, 'alice', 'page1', envelope('click-0100'))
      await vi.advanceTimersByTimeAsync(10)
      const heldAt = () => JSON.parse(localStorage.getItem('it.outbox.alice.page1.click-0100') ?? '{}').held as number
      const first = heldAt()
      expect(first).toBeGreaterThan(Date.now())
      await vi.advanceTimersByTimeAsync(40_000)
      expect(heldAt()).toBeGreaterThan(first + 30_000)
      expect(heldAt()).toBeGreaterThan(Date.now())
      answer({ actionId: 'a100' })
      await sent
      expect(stored()).toEqual([])
    } finally {
      vi.useRealTimers()
      outboxBelongsTo(null)
    }
  })

  test('while a click is on its way with no copy kept, that is said', async () => {
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      let release: (v: unknown) => void = () => {}
      const client = {
        connectionState: () => ({ isWebSocketConnected: true }),
        mutation: vi.fn((fn: unknown) =>
          getFunctionName(fn as never) === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * 86400_000 }) : new Promise((r) => (release = r)),
        ),
      } as never
      const sent = submit(client, 'alice', 'page1', envelope('click-0090'))
      await new Promise((r) => setTimeout(r, 10))
      expect([unsaved('alice', 'page1'), unsaved('alice', 'page2')]).toEqual([1, 0])
      release({ actionId: 'a90' })
      await sent
      expect(unsaved('alice', 'page1')).toBe(0)
    } finally {
      full.mockRestore()
    }
  })
})

describe('a click that is on its way when everything this browser keeps is let go of', () => {
  /** A stand-in for the connection whose one answer the test gives when it chooses. */
  function waiting() {
    let accept!: (v: unknown) => void
    let refuseWith!: (e: unknown) => void
    const answer = new Promise((yes, no) => {
      accept = yes
      refuseWith = no
    })
    const mutation = vi.fn(() => answer)
    const dispatch = (fn: unknown) =>
      getFunctionName(fn as never) === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * 86400_000 }) : mutation()
    return { client: { mutation: dispatch, connectionState: () => ({ isWebSocketConnected: true }) } as never, mutation, accept, refuseWith }
  }
  const PRIVATE = '{"typed":"what the person wrote"}'
  const everything = () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]

  beforeEach(() => {
    sessionStorage.clear()
    // Each of these is paired here afresh: what was let go of for a person in one test says nothing of the next
    for (const person of ['alice', 'bob']) keepFor(person)
    localStorage.clear()
    localStorage.setItem('it.display', 'a-display-key-000001')
  })

  test('it is not put back by a refusal that arrives afterwards, while the tab still takes itself for the person’s or once it does not', async () => {
    for (const unpairedBy of ['then', 'never'] as const) {
      localStorage.setItem('it.display', 'a-display-key-000001')
      keepFor('alice')
      outboxBelongsTo('alice', 'session-1')
      const b = waiting()
      // The page has gone by the time the answer comes, so a refusal would leave the click to be sent later
      const sent = submit(b.client, 'alice', 'page1', envelope(`click-late-${unpairedBy}`, { payload: PRIVATE }), () => false).catch((e) => e)
      await Promise.resolve()
      expect(stored()).toEqual([`it.outbox.alice.page1.click-late-${unpairedBy}`])
      expect(everything().sort()).toEqual(['it.display', `it.outbox.alice.page1.click-late-${unpairedBy}`, 'it.person'])
      // Everything It held is erased: this browser lets go of what it kept, and its session is over
      forgetAll('alice')
      if (unpairedBy === 'then') outboxBelongsTo(null)
      expect(everything()).toEqual([])
      b.refuseWith(refuse('unauthenticated'))
      expect(await sent).toBeInstanceOf(Error)
      expect(everything()).toEqual([])
      expect(JSON.stringify({ ...localStorage })).not.toContain('what the person wrote')
    }
  })

  test('nor is it written again once the site has worked out whether the person was at the page, and it is not sent', async () => {
    outboxBelongsTo('alice', 'session-1')
    const b = waiting()
    let judged!: (attended: boolean) => void
    const judge = () => new Promise<boolean>((r) => (judged = r))
    const sent = submit(b.client, 'alice', 'page1', envelope('click-judged-01', { payload: PRIVATE }), () => true, judge).catch((e) => e)
    await Promise.resolve()
    expect(stored()).toEqual(['it.outbox.alice.page1.click-judged-01'])
    forgetAll('alice')
    judged(true)
    expect(String(await sent)).toMatch(/pairing has ended/)
    expect(everything()).toEqual([])
    expect(b.mutation).not.toHaveBeenCalled()
  })

  test('nor by the hold its tab keeps up on it every few seconds', async () => {
    vi.useFakeTimers()
    try {
      outboxBelongsTo('alice', 'session-1')
      const b = waiting()
      const sent = submit(b.client, 'alice', 'page1', envelope('click-held-001', { payload: PRIVATE })).catch((e) => e)
      await vi.advanceTimersByTimeAsync(10)
      forgetAll('alice')
      // Another tab keeps a click of the same name for whoever the browser is paired for next: it is not this tab's to renew
      localStorage.setItem('it.outbox.alice.page1.click-held-001', 'another tab’s')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(localStorage.getItem('it.outbox.alice.page1.click-held-001')).toBe('another tab’s')
      localStorage.clear()
      b.accept({ actionId: 'a1' })
      await sent
      expect(everything()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a click the backend takes all the same is answered as taken, and leaves nothing behind', async () => {
    outboxBelongsTo('alice', 'session-1')
    const b = waiting()
    const sent = submit(b.client, 'alice', 'page1', envelope('click-taken-01'))
    await Promise.resolve()
    forgetAll('alice')
    b.accept({ actionId: 'a1' })
    expect(await sent).toEqual({ actionId: 'a1' })
    expect(everything()).toEqual([])
  })

  test('in a tab that hears of it from another tab, it is not put back either, and no click is kept there for that person again', async () => {
    outboxBelongsTo('alice', 'session-1')
    const b = waiting()
    const sent = submit(b.client, 'alice', 'page1', envelope('click-other-01', { payload: PRIVATE }), () => false).catch((e) => e)
    await Promise.resolve()
    // The other tab removed everything, and said for whom
    localStorage.clear()
    expect(letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' }))).toBe(true)
    b.refuseWith(refuse('unauthenticated'))
    await sent
    expect(everything()).toEqual([])
    // This tab has yet to find out that the browser is not paired, and a page in it sends another
    const later = backend([{ actionId: 'never-asked' }])
    await expect(submit(later.client, 'alice', 'page1', envelope('click-other-02'))).rejects.toThrow(/pairing has ended/)
    expect(later.calls).toEqual([])
    expect(everything()).toEqual([])
  })

  test('what this tab was going to try again later, and what it counted as on its way with no copy kept, goes with the rest', async () => {
    vi.useFakeTimers()
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      outboxBelongsTo('alice', 'session-1')
      const b = waiting()
      const sent = submit(b.client, 'alice', 'page1', envelope('click-unkept-1')).catch((e) => e)
      await vi.advanceTimersByTimeAsync(10)
      expect(unsaved('alice', 'page1')).toBe(1)
      full.mockRestore()
      forgetAll('alice')
      expect(unsaved('alice', 'page1')).toBe(0)
      b.refuseWith(refuse('unauthenticated'))
      await sent
      expect(unsaved('alice', 'page1')).toBe(0)
      // Nothing is left that would send for them later
      const calls = b.mutation.mock.calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(b.mutation.mock.calls.length).toBe(calls)
    } finally {
      full.mockRestore()
      vi.useRealTimers()
    }
  })

  test('a click of the person whom the browser is now paired for is kept as before when what was an erased person’s is let go of late', async () => {
    // It was set up again and the browser paired for Bob, who has a click on its way from a page that has gone
    keepFor('bob')
    outboxBelongsTo('bob', 'session-2')
    const b = waiting()
    const sent = submit(b.client, 'bob', 'page1', envelope('click-bobs-001', { payload: PRIVATE }), () => false).catch((e) => e)
    await Promise.resolve()
    // Word that Alice's things are to go comes only now: from the tab that erased them, and from another tab that says so
    localStorage.setItem('it.outbox.alice.page1.click-late-9', 'written late')
    forgetAll('alice')
    letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' }))
    expect(stored()).toEqual(['it.outbox.bob.page1.click-bobs-001'])
    // Bob's click meets trouble, and is kept to be sent later, as it would have been
    b.refuseWith(new Error('the connection went'))
    await sent
    expect(stored()).toEqual(['it.outbox.bob.page1.click-bobs-001'])
    expect(JSON.parse(localStorage.getItem('it.outbox.bob.page1.click-bobs-001')!)).toMatchObject({ user: 'bob', left: true })
  })

  test('a person the browser is paired for again, on the backend’s word, has their clicks kept as before', async () => {
    outboxBelongsTo('bob', 'session-1')
    forgetAll('bob')
    await expect(submit(backend([]).client, 'bob', 'page1', envelope('click-again-01'))).rejects.toThrow(/pairing has ended/)
    // The backend gives the browser a token for them: they are there, and this browser is theirs
    keepFor('bob')
    const lost = backend(['never'])
    void submit(lost.client, 'bob', 'page1', envelope('click-again-02'))
    await Promise.resolve()
    expect(stored()).toEqual(['it.outbox.bob.page1.click-again-02'])
  })
})

describe('a click another tab of this browser leaves behind', () => {
  const at = (id: string) => `it.outbox.alice.page1.${id}`
  /** Another tab keeps a click of Alice's, or renews its hold on it, and the browser says so to this one. */
  function elsewhere(id: string, over: Record<string, unknown> = {}) {
    const value = JSON.stringify({
      user: 'alice',
      artifactId: 'page1',
      envelope: envelope(id),
      format: 2,
      session: 'session-1',
      replayUntil: Date.now() + 86400_000,
      at: Date.now(),
      held: Date.now() + 15_000,
      ...over,
    })
    localStorage.setItem(at(id), value)
    window.dispatchEvent(new StorageEvent('storage', { key: at(id), newValue: value }))
  }
  /** The ids of what was sent from here, a typed message's as well as a click's. */
  const sent = (b: ReturnType<typeof backend>) => b.calls.map((c) => c.envelope?.clientActionId ?? (c as unknown as { clientActionId: string }).clientActionId)
  let deaf = () => {}
  beforeEach(() => {
    vi.useFakeTimers()
    outboxBelongsTo('alice', 'session-1')
  })
  afterEach(() => {
    deaf()
    outboxBelongsTo(null)
    vi.useRealTimers()
  })

  test('is sent from a tab that had nothing left to send, once the tab that kept it has closed', async () => {
    const b = backend([{ actionId: 'a1' }])
    deaf = recoverLeftovers(b.client, 'alice')
    // This tab sent what it had, and has nothing to look at again
    await drain(b.client, 'alice')
    expect(b.calls).toEqual([])
    // Another tab keeps a click, and is closed before it has sent it: it says nothing more
    elsewhere('click-left-01')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(b.calls).toEqual([])
    // Its hold runs out, and the click goes from here
    await vi.advanceTimersByTimeAsync(11_000)
    expect(sent(b)).toEqual(['click-left-01'])
    expect(stored()).toEqual([])
  })

  test('is left to that tab for as long as it keeps up its hold on it', async () => {
    const b = backend([{ actionId: 'a1' }])
    deaf = recoverLeftovers(b.client, 'alice')
    const made = Date.now()
    elsewhere('click-held-01', { at: made })
    // A slow backend: the other tab is still sending it a minute later, and renews its hold every few seconds
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      elsewhere('click-held-01', { at: made })
    }
    expect(b.calls).toEqual([])
    // That tab is closed now
    await vi.advanceTimersByTimeAsync(16_000)
    expect(sent(b)).toEqual(['click-held-01'])
  })

  test('is sent once its hold runs out, from a tab whose only time to look again is when a refused message of its own expires', async () => {
    const b = backend([refuse('invalid'), { actionId: 'a1' }])
    deaf = recoverLeftovers(b.client, 'alice')
    // This tab keeps a typed message that was refused, and looks again only when it expires, in a week
    localStorage.setItem(
      at('message-kept-01'),
      JSON.stringify({
        user: 'alice',
        artifactId: 'page1',
        envelope: envelope('message-kept-01'),
        operation: { kind: 'message', text: 'hello' },
        format: 2,
        session: 'session-1',
        replayUntil: Date.now() + 86400_000,
        at: Date.now() - 60_000,
        left: true,
      }),
    )
    await drain(b.client, 'alice')
    expect(sent(b)).toEqual(['message-kept-01'])
    expect(stored()).toEqual([at('message-kept-01')])
    // Another tab keeps a click, and is closed before it has sent it
    elsewhere('click-left-02')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent(b)).toEqual(['message-kept-01'])
    // Its hold runs out, and the click goes from here, once
    await vi.advanceTimersByTimeAsync(11_000)
    expect(sent(b)).toEqual(['message-kept-01', 'click-left-02'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sent(b)).toEqual(['message-kept-01', 'click-left-02'])
    expect(stored()).toEqual([at('message-kept-01')])
  })

  test('begins nothing for what is let go of, refused, someone else’s or another pairing’s, and leaves nothing running once sent', async () => {
    const b = backend([{ actionId: 'a1' }, { actionId: 'a2' }])
    deaf = recoverLeftovers(b.client, 'alice')
    // Said many times at once, as a tab says when it keeps several clicks: one sending, for all of them
    for (let i = 0; i < 20; i++) elsewhere('click-burst-01', { at: Date.now() - 60_000, held: undefined, left: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(sent(b)).toEqual(['click-burst-01'])
    // This tab's own sending removed the click. The other tabs that hear of that, and of what they
    // remove or keep as refused in turn, set nothing going here again
    window.dispatchEvent(new StorageEvent('storage', { key: at('click-burst-01'), newValue: null }))
    elsewhere('message-refused', { refused: 'No.', held: undefined, left: true, at: Date.now() - 60_000 })
    // A click from before the browser was paired again, and one of Bob's
    elsewhere('click-old-pairing', { session: 'session-0', held: undefined, left: true, at: Date.now() - 60_000 })
    const bobs = JSON.stringify({ user: 'bob', artifactId: 'page1', envelope: envelope('click-bobs-01'), format: 2, session: 'session-1', at: 0 })
    localStorage.setItem('it.outbox.bob.page1.click-bobs-01', bobs)
    window.dispatchEvent(new StorageEvent('storage', { key: 'it.outbox.bob.page1.click-bobs-01', newValue: bobs }))
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sent(b)).toEqual(['click-burst-01'])
    // Nothing is waiting to look again, here or for anyone
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a click or typed message given up with nobody there to be told', () => {
  const TYPED_TEXT = 'what-the-person-typed'
  /** A click or typed message kept for later under a pairing, as a page leaves it. */
  const left = (user: string, session: string, id: string, over: Record<string, unknown> = {}) =>
    localStorage.setItem(
      `it.outbox.${user}.page1.${id}`,
      JSON.stringify({
        user,
        artifactId: 'page1',
        envelope: envelope(id, { payload: JSON.stringify({ typed: TYPED_TEXT }) }),
        format: 2,
        session,
        replayUntil: Date.now() + 86400_000,
        at: Date.now() - 60_000,
        left: true,
        ...over,
      }),
    )
  const typed = { operation: { kind: 'message', text: TYPED_TEXT } }
  const TOO_OLD = Date.now() - 8 * 86_400_000
  const counts = () => Object.keys(localStorage).filter((k) => k.startsWith('it.givenup.'))
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    outboxBelongsTo(null)
  })

  test('too old to send when the site starts, it is said to its person under the pairing it was made under, with nothing of what it carried', () => {
    // The site starts, and does not know yet whether the browser is paired
    outboxBelongsTo(null)
    left('alice', 'session-1', 'click-old-0001', { at: TOO_OLD })
    left('alice', 'session-1', 'typed-old-0001', { at: TOO_OLD, ...typed })
    // One the person was already shown as refused is not said again
    left('alice', 'session-1', 'typed-old-0002', { at: TOO_OLD, ...typed, refused: 'No.' })
    left('alice', 'session-1', 'click-new-0001')
    left('bob', 'session-7', 'click-old-0002', { at: TOO_OLD })
    dropOld()
    expect(stored()).toEqual(['it.outbox.alice.page1.click-new-0001'])
    // Nothing of what any of them carried, nor which they were, is kept for saying so
    for (const k of counts()) expect(localStorage.getItem(k)).not.toMatch(/what-the-person-typed|click-old|typed-old/)
    // The browser is Alice's, under the pairing those were made under
    outboxBelongsTo('alice', 'session-1')
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 1 })
    expect(givenUpFor('bob')).toBeNull()
    // Bob's is never said here, and is not kept to be
    expect(counts()).toEqual(['it.givenup.alice'])
    // Seen: it is said no more
    seenGivenUp('alice')
    expect(givenUpFor('alice')).toBeNull()
    expect(counts()).toEqual([])
  })

  test('too old to send under two pairings when the site starts, it is said under the one the browser turns out to have, and under no other', () => {
    outboxBelongsTo(null)
    // Given up in this order, the later under the earlier pairing
    left('alice', 'session-1', 'click-old-0011', { at: TOO_OLD })
    dropOld()
    left('alice', 'session-0', 'click-old-0012', { at: TOO_OLD })
    left('alice', 'session-0', 'typed-old-0011', { at: TOO_OLD, ...typed })
    dropOld()
    outboxBelongsTo('alice', 'session-1')
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    // The other pairing's is let go of, and is never said
    for (const k of counts()) expect(localStorage.getItem(k)).not.toMatch(/session-0/)
    outboxBelongsTo('alice', 'session-0')
    expect(givenUpFor('alice')).toBeNull()
    expect(counts()).toEqual([])
  })

  test('refused for good once its page had gone, it is said, and a typed message stays shown as refused instead', async () => {
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-gone-0001')
    left('alice', 'session-1', 'typed-gone-0001', typed)
    const b = backend([refuse('invalid'), refuse('invalid')])
    await drain(b.client, 'alice')
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    expect(stored()).toEqual(['it.outbox.alice.page1.typed-gone-0001'])
    // And one refused for good just after its page went, before it was ever left for later
    const late = backend([refuse('not_found')])
    await expect(submit(late.client, 'alice', 'page1', envelope('click-gone-0002'), () => false)).rejects.toBeInstanceOf(ConvexError)
    expect(givenUpFor('alice')).toEqual({ clicks: 2, messages: 0 })
    // A page still there is told itself, and nothing more is said
    const told = backend([refuse('not_found')])
    await expect(submit(told.client, 'alice', 'page1', envelope('click-told-0001'))).rejects.toBeInstanceOf(ConvexError)
    expect(givenUpFor('alice')).toEqual({ clicks: 2, messages: 0 })
  })

  test('is said under no other pairing, nor once the browser is signed out, and brings back nothing', async () => {
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-old-0003', { at: TOO_OLD })
    dropOld()
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    // The browser is paired again for Alice: that was another pairing's, and goes
    outboxBelongsTo('alice', 'session-2')
    expect(givenUpFor('alice')).toBeNull()
    expect(counts()).toEqual([])
    // A tab still under the old pairing gives up another and counts it: still not said under this one
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-old-0004', { at: TOO_OLD })
    dropOld()
    outboxBelongsTo('alice', 'session-2')
    expect(givenUpFor('alice')).toBeNull()
    // Nor to someone else the browser is paired for, nor to nobody
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-old-0005', { at: TOO_OLD })
    dropOld()
    outboxBelongsTo('bob', 'session-1')
    expect([givenUpFor('alice'), givenUpFor('bob')]).toEqual([null, null])
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-old-0006', { at: TOO_OLD })
    dropOld()
    outboxBelongsTo(null)
    expect(counts()).toEqual([])
    // And paired again under that same pairing, nothing given up comes back, to be said or to be sent
    outboxBelongsTo('alice', 'session-1')
    expect(givenUpFor('alice')).toBeNull()
    expect(stored()).toEqual([])
    const b = backend([])
    await drain(b.client, 'alice')
    expect(b.calls).toEqual([])
  })

  test('another tab’s saying it was seen is heard here, and sends nothing', async () => {
    vi.useFakeTimers()
    try {
      outboxBelongsTo('alice', 'session-1')
      const b = backend([])
      const deaf = recoverLeftovers(b.client, 'alice')
      const heard = vi.fn()
      const unwatch = watchOutbox(heard)
      localStorage.setItem('it.givenup.alice', JSON.stringify({ session: 'session-1', clicks: 1, messages: 0 }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'it.givenup.alice', newValue: localStorage.getItem('it.givenup.alice') }))
      localStorage.removeItem('it.givenup.alice')
      window.dispatchEvent(new StorageEvent('storage', { key: 'it.givenup.alice', newValue: null }))
      expect(heard).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(b.calls).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      unwatch()
      deaf()
    } finally {
      vi.useRealTimers()
    }
  })

  /** Storage with no room for anything more until something kept in it is let go of. */
  const fullUntilGone = (key: string) => {
    const setItem = Storage.prototype.setItem
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this.getItem(key) !== null) throw new Error('QuotaExceededError')
      setItem.call(this, k, v)
    })
  }
  /** Storage with no room for anything more at all. */
  const full = () =>
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

  test('too old to send with storage full, it is let go of first and the room it took is used to say so', async () => {
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-full-0001', { at: TOO_OLD })
    fullUntilGone('it.outbox.alice.page1.click-full-0001')
    const heard = vi.fn(() => givenUpFor('alice'))
    const unwatch = watchOutbox(heard)
    dropOld()
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    expect(counts()).toEqual(['it.givenup.alice'])
    // Whatever shows it is told only once the count is there to show
    expect(heard).toHaveReturnedWith({ clicks: 1, messages: 0 })
    unwatch()
    // And the same when it is found too old while the outbox is being sent
    left('alice', 'session-1', 'click-full-0002', { at: TOO_OLD })
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fullUntilGone('it.outbox.alice.page1.click-full-0002')
    const b = backend([])
    await drain(b.client, 'alice')
    expect(b.calls).toEqual([])
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 2, messages: 0 })
  })

  test('too old to send with storage that takes nothing, it is still said in this page, and kept once storage has room', () => {
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-full-0003', { at: TOO_OLD })
    let refusing = full()
    dropOld()
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    expect(counts()).toEqual([])
    // Said under this pairing only, as one kept would be
    outboxBelongsTo('alice', 'session-2')
    expect(givenUpFor('alice')).toBeNull()
    outboxBelongsTo('alice', 'session-1')
    refusing.mockRestore()
    left('alice', 'session-1', 'click-full-0004', { at: TOO_OLD })
    refusing = full()
    dropOld()
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    // Storage has room again: the next change writes it, with nothing of what it carried
    refusing.mockRestore()
    left('alice', 'session-1', 'click-old-0099', { at: TOO_OLD })
    dropOld()
    expect(givenUpFor('alice')).toEqual({ clicks: 2, messages: 0 })
    expect(JSON.parse(localStorage.getItem('it.givenup.alice') ?? 'null')).toEqual([{ session: 'session-1', clicks: 2, messages: 0 }])
    seenGivenUp('alice')
    expect(givenUpFor('alice')).toBeNull()
  })

  test('refused for good once its page had gone with storage full, it is said, and is gone', async () => {
    outboxBelongsTo('alice', 'session-1')
    left('alice', 'session-1', 'click-gone-0011')
    fullUntilGone('it.outbox.alice.page1.click-gone-0011')
    const b = backend([refuse('invalid')])
    await drain(b.client, 'alice')
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    expect(counts()).toEqual(['it.givenup.alice'])
    // With storage that takes nothing at all, it is still said in this page
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seenGivenUp('alice')
    left('alice', 'session-1', 'click-gone-0012')
    full()
    const again = backend([refuse('invalid')])
    await drain(again.client, 'alice')
    expect(stored()).toEqual([])
    expect(givenUpFor('alice')).toEqual({ clicks: 1, messages: 0 })
    expect(counts()).toEqual([])
    // Seen in another tab: what this page held of it goes too
    const unwatch = watchOutbox(() => {})
    window.dispatchEvent(new StorageEvent('storage', { key: 'it.givenup.alice', newValue: null }))
    unwatch()
    expect(givenUpFor('alice')).toBeNull()
  })
})
