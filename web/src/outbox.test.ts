// The site's outbox: a click is kept in this browser only while nobody knows what became of it.
import { ConvexError } from 'convex/values'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { forgetAll, keepFor, letGoElsewhere } from './lib'
import { drain, dropOld, outboxBelongsTo, type Sent, submit, unsaved, unsent } from './outbox'

const envelope = (id: string, over: Partial<Sent> = {}): Sent => ({ v: 1, clientActionId: id, name: 'approve', payload: '{"n":1}', contentVersion: 1, ...over })
const refuse = (code: string, extra: Record<string, unknown> = {}) => new ConvexError({ code, message: code, ...extra })
/** A stand-in for the connection to the backend: each call is answered by the next thing in `answers`. */
function backend(answers: (unknown | Error | 'never')[]) {
  const calls: { artifactId: string; envelope: Sent }[] = []
  const mutation = vi.fn((_fn: unknown, args: { artifactId: string; envelope: Sent }) => {
    calls.push(args)
    const next = answers.shift()
    if (next === 'never') return new Promise(() => {})
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? { actionId: 'a1' })
  })
  return { client: { mutation, connectionState: () => ({ isWebSocketConnected: connected }) } as never, calls }
}
let connected = true
const keep = (user: string, id: string, at = Date.now() - 60_000, artifactId = 'page1') =>
  localStorage.setItem(`it.outbox.${user}.${artifactId}.${id}`, JSON.stringify({ user, artifactId, envelope: envelope(id), at }))
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
    keep('alice', 'click-old-0001', Date.now() - WEEK - 60_000)
    keep('alice', 'click-new-0001', Date.now() - WEEK + 60_000)
    // Kept for people who are not paired here, and may never be again
    keep('bob', 'click-old-0002', Date.now() - 30 * 86_400_000)
    keep('bob', 'click-new-0002')
    // And one that cannot be read at all
    localStorage.setItem('it.outbox.carol.page1.click-0003', '{not json')
    outboxBelongsTo(null)
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

  test('told to slow down, it waits and tries again, since the person did click', async () => {
    const b = backend([refuse('rate_limited', { retryAfterMs: 300 }), refuse('rate_limited', { retryAfterMs: 300 }), { actionId: 'a2' }])
    expect(await submit(b.client, 'alice', 'page1', envelope('click-0002'))).toEqual({ actionId: 'a2' })
    expect(b.calls.length).toBe(3)
    expect(stored()).toEqual([])
  })

  test('a click the page is told has failed is not kept to be sent later behind the person’s back', async () => {
    const slow = backend(Array.from({ length: 10 }, () => refuse('rate_limited', { retryAfterMs: 250 })))
    await expect(submit(slow.client, 'alice', 'page1', envelope('click-0003'))).rejects.toBeInstanceOf(ConvexError)
    expect(slow.calls.length).toBe(4)
    expect(stored()).toEqual([])
    const bad = backend([refuse('invalid')])
    await expect(submit(bad.client, 'alice', 'page1', envelope('click-0004'))).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toEqual([])
    // Told to wait a long time: not waited for at all
    const long = backend([refuse('rate_limited', { retryAfterMs: 60_000 })])
    await expect(submit(long.client, 'alice', 'page1', envelope('click-0005'))).rejects.toBeInstanceOf(ConvexError)
    expect(long.calls.length).toBe(1)
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
      expect(stored()).toEqual(['it.outbox.alice.page1.click-0090'])
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

  test('if the browser is paired for someone else while clicks are being sent, sending stops and nothing of theirs is removed', async () => {
    keep('alice', 'click-0012')
    keep('alice', 'click-0013')
    const calls: string[] = []
    const client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      mutation: vi.fn(async (_fn: unknown, args: { envelope: Sent }) => {
        calls.push(args.envelope.clientActionId)
        // While the first is on its way, the browser is paired for Bob. The answer that comes
        // back is the one Bob would get: there is no such page of his.
        outboxBelongsTo('bob')
        throw refuse('not_found')
      }),
    } as never
    await drain(client, 'alice')
    expect(calls).toEqual(['click-0012'])
    expect(stored().length).toBe(2)
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

  test('what a page may send is checked before anything is stored', async () => {
    const b = backend([])
    await expect(submit(b.client, 'alice', 'page1', envelope('short'))).rejects.toThrow()
    await expect(submit(b.client, 'alice', 'page1', envelope('click-0020', { name: 'x'.repeat(100_000) }))).rejects.toThrow()
    await expect(submit(b.client, 'alice', 'page1', envelope('click-0021', { payload: JSON.stringify('x'.repeat(40_000)) }))).rejects.toThrow(/at most/)
    expect(stored()).toEqual([])
    expect(b.calls).toEqual([])
  })

  test('with far too many unanswered already, one more is refused and none is pushed out', async () => {
    for (let i = 0; i < 100; i++) keep('alice', `old-${String(i).padStart(5, '0')}`)
    await expect(submit(backend([]).client, 'alice', 'page1', envelope('click-0022'))).rejects.toThrow(/Too many/)
    expect(stored().length).toBe(100)
    // Another person on the same browser is not affected by that
    outboxBelongsTo('bob')
    expect(await submit(backend([{ actionId: 'b1' }]).client, 'bob', 'page2', envelope('click-0023'))).toEqual({ actionId: 'b1' })
  })

  test('one page can hold only part of what the browser keeps, so it cannot crowd out the others', async () => {
    for (let i = 0; i < 30; i++) keep('alice', `old-${String(i).padStart(5, '0')}`, Date.now() - 60_000, 'page1')
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
      const first = { connectionState: () => ({ isWebSocketConnected: true }), mutation: vi.fn(() => new Promise((r) => (answer = r))) } as never
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
      const client = { connectionState: () => ({ isWebSocketConnected: true }), mutation: vi.fn(() => new Promise((r) => (answer = r))) } as never
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
      const client = { connectionState: () => ({ isWebSocketConnected: true }), mutation: vi.fn(() => new Promise((r) => (release = r))) } as never
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
    return { client: { mutation, connectionState: () => ({ isWebSocketConnected: true }) } as never, mutation, accept, refuseWith }
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
