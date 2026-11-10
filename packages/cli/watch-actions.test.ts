// `it actions --id` and `it actions --id --follow`, with the backend and the live connection
// stood in for: what is printed, what is asked of It (only ever reads), and how a watch ends.
// The program itself, its live connection and its token kept fresh over a long watch are in
// follow.test.ts.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const stand = vi.hoisted(() => ({
  /** Every function asked of It by a call, with its arguments. */
  calls: [] as { kind: string; name: string; args: any }[],
  /** What a call answers, by function: a value, or an error to throw. */
  answer: (_name: string, _args: any): unknown => null,
  /** What the backend says it takes at its door: true, false, or unknown where it could not be asked. */
  takes: true as boolean | undefined,
  /** Each live watch made, with what it watches and how to tell it something. */
  watches: [] as { name: string; args: any; update: (v: any) => void; fail: (e: unknown) => void; removed: boolean }[],
  notKnown: null as null | (() => void),
  closed: 0,
  lines: [] as any[],
  output: true,
}))
vi.mock('./src/lib', async (original) => {
  const real = await original<typeof import('./src/lib')>()
  return {
    ...real,
    call: async (kind: string, fn: any, args: any = {}) => {
      const name = getFunctionName(fn)
      stand.calls.push({ kind, name, args })
      const said = stand.answer(name, args)
      if (said instanceof Error) throw said
      return said
    },
    backendTakes: async () => stand.takes,
    machine: () => ({ id: 'machine-1', name: 'test', key: {} }),
    live: (onNotKnown?: () => void) => {
      stand.notKnown = onNotKnown ?? null
      return {
        onUpdate: (fn: any, args: any, update: any, fail: any) => {
          const watch = { name: getFunctionName(fn), args, update, fail, removed: false }
          stand.watches.push(watch)
          return () => {
            watch.removed = true
          }
        },
        close: async () => {
          stand.closed++
        },
      }
    },
    handed: async (_stream: unknown, text: string) => {
      if (!stand.output) return false
      stand.lines.push(JSON.parse(text))
      return true
    },
  }
})

import { Problem } from './src/lib'
import { bounded, LISTED_MOST, listActions, watchActions } from './src/watch-actions'

/** An action as `delivery.waitingPage` gives it, its place being its number. */
const action = (n: number, over: Record<string, unknown> = {}) => ({
  id: `a${n}`,
  artifact: 'board',
  title: 'Board',
  name: 'press',
  payload: JSON.stringify({ n }),
  at: 1_000 + n,
  attended: true,
  session: null,
  cursor: `pg1.${1_000 + n}`,
  ...over,
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => action(from + i))
const page = (actions: ReturnType<typeof action>[], more = false, from = 'pg1.0', earlier = false) => ({ actions, more, from, earlier })
/** What an older backend answers a function it does not have: why is kept to itself. */
const unexplained = () => new Problem('[Request ID: 5f3c] Server Error', 'error')
const flush = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}
const live = () => stand.watches.filter((w) => !w.removed)

let signals: Record<string, Set<(...args: any[]) => void>>
beforeEach(() => {
  signals = Object.fromEntries((['SIGINT', 'SIGTERM'] as const).map((s) => [s, new Set(process.listeners(s))]))
  // As the backend answers: the place these begin after, always of the page's record
  stand.answer = (name, args) =>
    name === 'delivery:waitingPage'
      ? page([], false, args.after && args.after !== '0' ? args.after : 'pg1.0')
      : name === 'artifacts:get'
        ? { slug: 'board' }
        : null
})
afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    for (const handler of process.listeners(signal)) if (!signals[signal]!.has(handler)) process.removeListener(signal, handler)
  stand.calls.length = stand.watches.length = stand.lines.length = 0
  stand.takes = true
  stand.output = true
  stand.closed = 0
  stand.notKnown = null
})
/** Starts a watch, and gives what it ended with: nothing, for a watch that ended well, or its error. */
function follow(after?: string) {
  const notes: string[] = []
  const ended = watchActions('board', after, (line) => notes.push(line)).then(
    () => null,
    (err: Problem) => err,
  )
  return { ended, notes }
}
const stop = (signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') => {
  for (const handler of process.listeners(signal)) if (!signals[signal]!.has(handler)) handler(signal)
}

describe('following the actions on a page', () => {
  test('each action is printed once, however often It says it is waiting, and nothing is ever claimed or answered', async () => {
    const { ended } = follow()
    await flush()
    expect(live().map((w) => [w.name, w.args])).toEqual([['delivery:waitingPage', { slug: 'board', after: 'pg1.0' }]])
    const [w] = live()
    w!.update(page(range(1, 3)))
    w!.update(page(range(1, 3)))
    w!.update(page(range(2, 4)))
    await flush()
    expect(stand.lines.map((l) => l.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // One line each, as an agent is printed an action, with its place
    expect(stand.lines[0]).toMatchObject({ id: 'a1', page: 'board', action: 'press', data: { n: 1 }, cursor: 'pg1.1001' })
    stop()
    expect(await ended).toBeNull()
    // Only reads: the page, and the first page of its actions
    expect(stand.calls.map((c) => [c.kind, c.name])).toEqual([
      ['query', 'artifacts:get'],
      ['query', 'delivery:waitingPage'],
    ])
    expect(live()).toEqual([])
    expect(stand.closed).toBe(1)
  })

  test('the 51st action is printed while fifty older ones wait unanswered', async () => {
    const { ended } = follow()
    await flush()
    live()[0]!.update(page(range(1, 50)))
    await flush()
    expect(stand.lines.length).toBe(50)
    // A 51st comes. The page after where the watch began is full of what was printed, and says more wait
    live()[0]!.update(page(range(1, 50), true))
    await flush()
    // So the watch moves on past them, and is told the new one there
    expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.1050' }])
    live()[0]!.update(page([action(51)]))
    await flush()
    expect(stand.lines.map((l) => l.id)).toEqual(range(1, 51).map((a) => a.id))
    // And so on past the next fifty, however many wait
    live()[0]!.update(page(range(51, 100), true))
    await flush()
    expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.1100' }])
    live()[0]!.update(page(range(101, 102)))
    await flush()
    expect(stand.lines.map((l) => l.id)).toEqual(range(1, 102).map((a) => a.id))
    expect(new Set(stand.lines.map((l) => l.id)).size).toBe(102)
    stop()
    expect(await ended).toBeNull()
  })

  test('it begins with the newest that wait, from the place It says is before them', async () => {
    stand.answer = (name) => (name === 'delivery:waitingPage' ? page(range(151, 200), false, 'pg1.1150', true) : null)
    const { ended } = follow()
    await flush()
    expect(live()[0]!.args).toEqual({ slug: 'board', after: 'pg1.1150' })
    stop()
    expect(await ended).toBeNull()
  })

  test('given a cursor, it begins after it, so a watch started again misses nothing', async () => {
    const { ended } = follow('pg1.1020')
    await flush()
    expect(stand.calls.find((c) => c.name === 'delivery:waitingPage')!.args).toEqual({ slug: 'board', after: 'pg1.1020' })
    expect(live()[0]!.args).toEqual({ slug: 'board', after: 'pg1.1020' })
    live()[0]!.update(page(range(21, 22)))
    await flush()
    expect(stand.lines.map((l) => l.id)).toEqual(['a21', 'a22'])
    stop('SIGINT')
    expect(await ended).toBeNull()
  })

  test('what a replaced watch still had on its way is printed, and moves nothing on', async () => {
    const { ended } = follow()
    await flush()
    const first = live()[0]!
    first.update(page(range(1, 50), true))
    // Before the watch is replaced, the old one says more again, from a later moment
    first.update(page(range(3, 52), true))
    await flush()
    expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.1050' }])
    expect(stand.lines.map((l) => l.id)).toEqual(range(1, 52).map((a) => a.id))
    stop()
    expect(await ended).toBeNull()
  })

  test('a watch that runs for days goes on through It reconnecting and a fresh token, and prints nothing twice', async () => {
    vi.useFakeTimers()
    try {
      const { ended } = follow()
      await flush()
      for (let day = 0; day < 3; day++) {
        // The connection is made again with a fresh token, and It says everything that waits once more
        live()[0]!.update(page(range(1, 3 + day)))
        await vi.advanceTimersByTimeAsync(86_400_000)
      }
      expect(stand.lines.map((l) => l.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
      stop()
      expect(await ended).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('it ends with an error when the stream fails, with what It said where It refused, and as offline otherwise', async () => {
    for (const [err, code] of [
      [new Error('[Request ID: 1] Server Error'), 'offline'],
      [new ConvexError(JSON.stringify({ code: 'not_found', message: 'No such page.' })), 'not_found'],
    ] as const) {
      const { ended } = follow()
      await flush()
      live()[0]!.fail(err)
      expect((await ended)?.code).toBe(code)
      expect(live()).toEqual([])
      stand.watches.length = 0
    }
  })

  test('it ends with an error when It no longer knows this machine, or what it prints cannot be written', async () => {
    let { ended } = follow()
    await flush()
    stand.notKnown!()
    expect((await ended)?.code).toBe('unauthenticated')
    ;({ ended } = follow())
    await flush()
    stand.output = false
    live()
      .at(-1)!
      .update(page(range(1, 2)))
    expect((await ended)?.code).toBe('output_failed')
  })

  test('a page deleted and made again under its id ends the watch, as a deleted page does, and says to start again', async () => {
    // It refuses the watch, the page having become another record
    let { ended } = follow()
    await flush()
    live()[0]!.update(page(range(1, 2)))
    await flush()
    live()[0]!.fail(
      new ConvexError(
        JSON.stringify({ code: 'conflict', staleCursor: true, message: 'That cursor is of a page that was deleted. Start again without --after.' }),
      ),
    )
    let err = await ended
    expect(err?.code).toBe('conflict')
    expect(err?.message).toMatch(/Start again without --after/)
    expect(stand.lines.map((l) => l.id)).toEqual(['a1', 'a2'])
    // Or an action of another record comes, however it came: nothing of it is printed
    stand.watches.length = stand.lines.length = 0
    ;({ ended } = follow())
    await flush()
    live()[0]!.update(page([action(1), { ...action(2), cursor: 'pg2.1' }]))
    err = await ended
    expect(err?.code).toBe('conflict')
    expect(err?.message).toMatch(/deleted, and another made under its id\. Start again without --after/)
    expect(stand.lines.map((l) => l.id)).toEqual(['a1'])
    // Where the page is deleted and not made again, it ends with what It said of that
    stand.watches.length = 0
    ;({ ended } = follow())
    await flush()
    live()[0]!.fail(new ConvexError(JSON.stringify({ code: 'not_found', message: 'No such page.' })))
    expect((await ended)?.code).toBe('not_found')
  })

  test('a watch begun after a cursor begins where It says, which names the page, so a stale cursor is refused before anything is watched', async () => {
    stand.answer = (name) =>
      name === 'delivery:waitingPage' ? new Problem('That cursor is of a page that was deleted. Start again without --after.', 'conflict') : null
    const { ended } = follow('pg0.12')
    expect((await ended)?.code).toBe('conflict')
    expect(stand.watches).toEqual([])
  })

  test('a page that is not there is said at once, and nothing is watched', async () => {
    stand.answer = (name) => (name === 'artifacts:get' ? new Problem('No such page.', 'not_found') : null)
    const { ended } = follow()
    expect((await ended)?.code).toBe('not_found')
    expect(stand.watches).toEqual([])
  })

  test('against an older It it watches the oldest 50 and says so, never asking for the newer read', async () => {
    stand.answer = (name) => (name === 'delivery:waitingPage' ? unexplained() : name === 'delivery:waiting' ? range(1, 2) : null)
    stand.takes = false
    let { ended, notes } = follow()
    await flush()
    expect(live().map((w) => [w.name, w.args])).toEqual([['delivery:waiting', { slug: 'board' }]])
    expect(JSON.parse(notes[0]!).note).toMatch(/earlier version.*oldest 50/)
    live()[0]!.update(range(1, 2))
    live()[0]!.update(range(1, 3))
    await flush()
    expect(stand.lines.map((l) => l.id)).toEqual(['a1', 'a2', 'a3'])
    stop()
    expect(await ended).toBeNull()
    expect(stand.calls.map((c) => c.name)).not.toContain('delivery:waitingPage')
    // With a cursor there is nothing to fall back on
    ;({ ended } = follow('pg1.1001'))
    expect((await ended)?.code).toBe('invalid')
    expect(stand.calls.map((c) => c.name)).not.toContain('delivery:waitingPage')
  })

  test('where It cannot be asked what it takes, nothing is asked for or watched, and that is said as what it is', async () => {
    stand.takes = undefined
    const { ended } = follow()
    expect((await ended)?.code).toBe('offline')
    expect(stand.calls.map((c) => c.name)).toEqual(['artifacts:get'])
    expect(stand.watches).toEqual([])
  })

  test('before it moves on to a new watch it asks It again: it keeps its watch while It cannot be asked, and ends where It says it no longer has the read', async () => {
    vi.useFakeTimers()
    try {
      let { ended } = follow()
      await flush()
      live()[0]!.update(page(range(1, 50)))
      await flush()
      stand.takes = undefined
      live()[0]!.update(page(range(1, 50), true))
      await vi.advanceTimersByTimeAsync(1000)
      // Not moved on, and the watch there was goes on
      expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.0' }])
      await vi.advanceTimersByTimeAsync(5000)
      expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.0' }])
      // It answers again, and the watch moves on at the next asking
      stand.takes = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(live().map((w) => w.args)).toEqual([{ slug: 'board', after: 'pg1.1050' }])
      live()[0]!.update(page([action(51)]))
      await flush()
      expect(stand.lines.map((l) => l.id)).toEqual(range(1, 51).map((a) => a.id))
      // It says it no longer has the read: the watch ends, and says why
      stand.takes = false
      live()[0]!.update(page(range(51, 100), true))
      expect((await ended)?.code).toBe('unavailable')
      expect(live()).toEqual([])
      stand.watches.length = 0
      stand.takes = true
      ;({ ended } = follow())
      await flush()
      stop()
      expect(await ended).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an action printed, taken, and back to waiting after five thousand others is not printed again', async () => {
    const { ended } = follow()
    await flush()
    const [w] = live()
    w!.update(page([action(1)]))
    await flush()
    // Taken for delivery, and five thousand and two more come and are taken in turn, never filling a page
    for (let n = 2; n <= 5003; n++) w!.update(page([action(n)]))
    await vi.waitFor(() => expect(stand.lines.length).toBe(5003), { timeout: 10_000 })
    // The first comes back to waiting, behind everything printed since
    w!.update(page([action(1), action(5003)]))
    await flush()
    expect(stand.lines.length).toBe(5003)
    expect(new Set(stand.lines.map((l) => l.id)).size).toBe(5003)
    expect(stand.lines.at(-1)!.id).toBe('a5003')
    stop()
    expect(await ended).toBeNull()
  })
})

describe('listing the actions on a page', () => {
  test('the newest are listed, with where to read older ones', async () => {
    stand.answer = (name) => (name === 'delivery:waitingPage' ? page(range(151, 200), false, 'pg1.1150', true) : null)
    const { list, notes } = await listActions('board')
    expect(list.map((x) => x.id)).toEqual(range(151, 200).map((a) => a.id))
    expect(list[0]).toMatchObject({ cursor: 'pg1.1151' })
    expect(notes).toEqual([expect.stringContaining('it actions --id board --after 0')])
    expect(stand.calls).toEqual([{ kind: 'query', name: 'delivery:waitingPage', args: { slug: 'board' } }])
  })

  test('after a cursor, the ones that came after it, with how to go on', async () => {
    stand.answer = (name, args) => (name === 'delivery:waitingPage' && args.after === 'pg1.1010' ? page(range(11, 60), true, 'pg1.1010') : null)
    const { list, notes } = await listActions('board', 'pg1.1010')
    expect(list.map((x) => x.id)).toEqual(range(11, 60).map((a) => a.id))
    expect(notes).toEqual(['More actions wait after these: run `it actions --id board --after pg1.1060`.'])
  })

  test('what is printed stays within 256 KB however much the actions carried, keeping the newest, or the first after a cursor', async () => {
    // Fifty that each carried all an action may, laid out over many lines when printed
    const big = (n: number) => action(n, { payload: JSON.stringify(Array.from({ length: 3600 }, () => [10, 10])) })
    const fifty = Array.from({ length: 50 }, (_, i) => big(i + 1))
    expect(fifty.reduce((sum, a) => sum + a.payload.length, 0)).toBeGreaterThan(1024 * 1024)
    for (const after of [undefined, '0']) {
      stand.answer = (name) => (name === 'delivery:waitingPage' ? page(fifty, false, '0', false) : null)
      const { list, notes } = await listActions('board', after)
      const printed = `${JSON.stringify(list, null, 2)}\n`
      expect(Buffer.byteLength(printed)).toBeLessThanOrEqual(LISTED_MOST)
      expect(list.length).toBeGreaterThan(0)
      expect(list.length).toBeLessThan(50)
      if (after === undefined) {
        expect(list.at(-1)!.id).toBe('a50')
        expect(notes[0]).toMatch(/--after 0/)
      } else {
        expect(list[0]!.id).toBe('a1')
        expect(notes[0]).toBe(`More actions wait after these: run \`it actions --id board --after ${list.at(-1)!.cursor}\`.`)
      }
    }
  })

  test('one that does not fit by itself is listed without its data, with how to read it', () => {
    const deep = { id: 'a1', data: Array.from({ length: 30_000 }, () => [[[1]]]) }
    const { list, left } = bounded([deep, { id: 'a2', data: 1 }], 'oldest')
    expect(left).toBe(0)
    expect(list[0]).toEqual({ id: 'a1', data: null, dataLeftOut: 'Too long to list here: run `it action a1` to read all of it.' })
    expect(list[1]).toEqual({ id: 'a2', data: 1 })
    expect(Buffer.byteLength(JSON.stringify(list, null, 2))).toBeLessThanOrEqual(LISTED_MOST)
  })

  test('against an older It, its oldest 50, within the same bound, with a note where there may be more', async () => {
    const old = (from: number, to: number) => range(from, to).map(({ cursor: _, ...x }) => x)
    stand.answer = (name) => (name === 'delivery:waitingPage' ? unexplained() : name === 'delivery:waiting' ? old(1, 50) : null)
    stand.takes = false
    let { list, notes } = await listActions('board')
    expect(list.map((x) => x.id)).toEqual(range(1, 50).map((a) => a.id))
    expect(list[0]).not.toHaveProperty('cursor')
    expect(notes[0]).toMatch(/earlier version.*oldest 50/)
    stand.answer = (name) => (name === 'delivery:waitingPage' ? unexplained() : name === 'delivery:waiting' ? old(1, 3) : null)
    ;({ list, notes } = await listActions('board'))
    expect(list.length).toBe(3)
    expect(notes).toEqual([])
    // A cursor such an It cannot take is refused, never ignored
    expect(await listActions('board', '0').catch((err: Problem) => err.code)).toBe('invalid')
    // The newer read was never asked of it
    expect(stand.calls.map((c) => c.name)).not.toContain('delivery:waitingPage')
    // And where It could not be asked what it takes, that is what is said, and nothing is read
    stand.takes = undefined
    stand.calls.length = 0
    expect(await listActions('board').catch((err: Problem) => err.code)).toBe('offline')
    expect(stand.calls).toEqual([])
  })
})
