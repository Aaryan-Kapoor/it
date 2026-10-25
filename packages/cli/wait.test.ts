import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const stand = vi.hoisted(() => ({
  requests: [] as any[],
  lines: [] as any[],
  errors: [] as string[],
  exits: [] as number[],
  counted: [] as (string | undefined)[],
  updates: null as null | ((rows: any[]) => void),
  fail: null as null | ((error: Error) => void),
  announce: null as null | (() => Promise<any>),
  output: null as null | (() => Promise<boolean>),
  calls: [] as string[],
  args: [] as { name: string; args: any }[],
}))
vi.mock('./src/connector', () => ({
  local: async (_path: string, { body }: any) => {
    stand.requests.push(body)
    return body.done ? { ok: true } : stand.announce ? stand.announce() : { ok: true }
  },
}))
vi.mock('./src/usage', () => ({ record: () => {}, agentOf: () => '', timeBand: () => '' }))
vi.mock('./src/lib', async (original) => ({
  ...(await original<typeof import('./src/lib')>()),
  call: async (_kind: string, fn: any, args: any) => {
    const name = getFunctionName(fn)
    stand.calls.push(name)
    stand.args.push({ name, args })
    return name === 'delivery:claim' ? args.ids : name === 'delivery:handedOff' ? { already: false } : []
  },
  live: () => ({
    onUpdate: (_fn: any, _args: any, update: any, fail: any) => {
      stand.updates = update
      stand.fail = fail
    },
    close: async () => {},
  }),
  sessionAsked: () => undefined,
  handed: async (_stream: unknown, text: string) => {
    const ok = stand.output ? await stand.output() : true
    if (ok) stand.lines.push(JSON.parse(text))
    return ok
  },
  written: (_stream: unknown, text: string) => stand.errors.push(text),
  end: (code: number) => {
    stand.exits.push(code)
    return new Promise(() => {})
  },
}))

import { type Listed, wait } from './src/wait'

const click = (id: string): Listed => ({ id, artifact: 'board', title: 'Board', name: 'yes', payload: '{}', at: 1, attended: true, session: null })
const barrier = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
let signals: Record<string, Set<(...args: any[]) => void>>
beforeEach(() => {
  vi.useFakeTimers()
  signals = Object.fromEntries((['SIGINT', 'SIGTERM'] as const).map((s) => [s, new Set(process.listeners(s))]))
})
afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    for (const handler of process.listeners(signal)) if (!signals[signal]!.has(handler)) process.removeListener(signal, handler)
  vi.clearAllTimers()
  vi.useRealTimers()
  stand.counted.length = stand.requests.length = stand.lines.length = stand.errors.length = stand.exits.length = stand.calls.length = stand.args.length = 0
  stand.announce = stand.output = stand.updates = stand.fail = null
})
async function begin(timeout = '3') {
  void wait({ _: [], flags: { id: 'board', timeout }, many: {} }, (code) => stand.counted.push(code))
  await flush()
}

test.each(['timeout', 'error', 'earlier click'] as const)('an in-flight handback is printed exactly once when completion begins through %s', async (ending) => {
  await begin()
  const handback = barrier<any>()
  stand.announce = () => handback.promise
  await vi.advanceTimersByTimeAsync(2000)
  expect(stand.requests).toHaveLength(2)
  if (ending === 'timeout') {
    await vi.advanceTimersByTimeAsync(1000)
    expect(stand.calls).toContain('delivery:waiting')
  } else if (ending === 'error') stand.fail!(new Error('offline'))
  else stand.updates!([click('earlier')])
  await flush()
  expect(stand.exits).toEqual([])
  expect(stand.requests.some((r) => r.done)).toBe(false)
  handback.resolve({ clicks: [click('handback'), click('handback')] })
  await flush()
  expect(stand.lines.map((c) => c.id)).toEqual(ending === 'earlier click' ? ['earlier', 'handback'] : ['handback'])
  expect(stand.lines.some((c) => c.timedOut)).toBe(false)
  expect(stand.requests.find((r) => r.done)?.got).toEqual(['handback'])
  expect(stand.exits).toEqual([0])
  expect(stand.counted).toEqual([undefined])
})

test('blocked output prevents receipts and ending until the complete line has been written', async () => {
  const output = barrier<boolean>()
  stand.output = () => output.promise
  stand.announce = async () => ({ clicks: [click('blocked')] })
  await begin('5')
  await vi.advanceTimersByTimeAsync(2000)
  expect(stand.requests.every((r) => !r.got)).toBe(true)
  stand.fail!(new Error('interrupted'))
  await flush()
  expect(stand.exits).toEqual([])
  output.resolve(true)
  await vi.advanceTimersByTimeAsync(20)
  expect(stand.lines.map((c) => c.id)).toEqual(['blocked'])
  expect(stand.requests.find((r) => r.done)?.got).toEqual(['blocked'])
  expect(stand.exits).toEqual([0])
  expect(stand.counted).toEqual([undefined])
})

test('an interrupted output write never acknowledges an unprinted waiter copy', async () => {
  const output = barrier<boolean>()
  stand.output = () => output.promise
  stand.announce = async () => ({ clicks: [click('interrupted')] })
  await begin()
  output.resolve(false)
  await flush()
  await vi.advanceTimersByTimeAsync(20)
  expect(stand.lines).toEqual([])
  expect(stand.requests.every((r) => !r.got)).toBe(true)
  expect(stand.calls).not.toContain('delivery:handedOff')
  expect(stand.exits).toEqual([1])
  expect(stand.counted).toEqual(['error'])
})

test('an interrupted output write for a newly claimed click ends without confirming delivery', async () => {
  stand.output = async () => false
  await begin()
  stand.updates!([click('unprinted')])
  await flush()
  await vi.advanceTimersByTimeAsync(20)
  expect(stand.lines).toEqual([])
  expect(stand.calls).not.toContain('delivery:handedOff')
  expect(stand.exits).toEqual([1])
  expect(stand.counted).toEqual(['error'])
})

test('a click this wait takes is said to be handed over by the receipt of its own taking, one the connector hands on by the connector’s, and neither is printed', async () => {
  stand.announce = async () => ({ clicks: [{ ...click('handed-on'), receipt: 'the-connector-receipt-0001' }] })
  void wait({ _: [], flags: { id: 'board', follow: true }, many: {} }, (code) => stand.counted.push(code))
  await flush()
  stand.announce = null
  stand.updates!([click('taken-here')])
  await flush()
  const claimed = stand.args.find((c) => c.name === 'delivery:claim')!.args
  expect(claimed.receipt).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  const said = stand.args.filter((c) => c.name === 'delivery:handedOff').map((c) => c.args)
  expect(said).toEqual([
    { id: 'handed-on', route: 'waiter', receipt: 'the-connector-receipt-0001' },
    { id: 'taken-here', route: 'waiter', receipt: claimed.receipt },
  ])
  expect(stand.lines.map((c) => c.id)).toEqual(['handed-on', 'taken-here'])
  expect(JSON.stringify(stand.lines)).not.toContain('receipt')
})
