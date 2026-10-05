// What the site writes to the browser's console when something asked of the backend failed: an
// error for trouble, and nothing for a refusal the backend gave, which whoever asked sees to.
import { ConvexReactClient } from 'convex/react'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { askTwice, caught, connect } from './backend'
import { api } from './lib'

const written = { error: [] as unknown[][], warn: [] as unknown[][] }
beforeEach(() => {
  written.error.length = 0
  written.warn.length = 0
  vi.spyOn(console, 'error').mockImplementation((...said: unknown[]) => void written.error.push(said))
  vi.spyOn(console, 'warn').mockImplementation((...said: unknown[]) => void written.warn.push(said))
})
afterEach(() => vi.restoreAllMocks())

/** A refusal as the backend gives one, and a failure as the client reports one that came with no word of why. */
const refused = (code: string) => new ConvexError({ code, message: 'A sentence for the person.' })
const TROUBLE = '[CONVEX M(displays:heartbeat)] [Request ID: 0123456789abcdef] Server Error'
const troubled = () => new Error(`${TROUBLE}\n  Called by client`)
/** A connection whose calls of a function all come to this. */
function connectionWhere(calls: () => Promise<unknown>) {
  vi.spyOn(ConvexReactClient.prototype, 'mutation').mockImplementation(calls as never)
  vi.spyOn(ConvexReactClient.prototype, 'action').mockImplementation(calls as never)
  return connect('http://localhost:39000')
}
const came = (asked: Promise<unknown>) =>
  asked.then(
    (value) => ({ value }),
    (err) => ({ err }),
  )

describe('a call of one of the backend’s functions', () => {
  test('that the backend refused, with its code, is given to whoever called and written to the console by nobody', async () => {
    // As nobody, which every call of a tab meets once its session is over or the browser has been paired again, and any other refusal
    for (const code of ['unauthenticated', 'not_found', 'forbidden', 'rate_limited', 'invalid']) {
      const refusal = refused(code)
      const client = connectionWhere(() => Promise.reject(refusal))
      expect(await came(client.mutation(api.displays.heartbeat, { key: 'k' }))).toEqual({ err: refusal })
      expect(await came(client.action(api.displays.signOutToken, { key: 'k' }))).toEqual({ err: refusal })
    }
    expect(written).toEqual({ error: [], warn: [] })
  })

  test('that failed with no word of why is trouble, and is written as an error once: the function, the request’s number, and nothing else', async () => {
    const err = troubled()
    const client = connectionWhere(() => Promise.reject(err))
    expect(await came(client.mutation(api.displays.heartbeat, { key: 'k' }))).toEqual({ err })
    expect(written.error).toEqual([[TROUBLE]])
  })

  test('that was answered is given its answer, with everything it was asked with passed on as it was', async () => {
    const asked: unknown[][] = []
    const client = connectionWhere((...all: unknown[]) => {
      asked.push(all)
      return Promise.resolve({ now: 7 })
    })
    expect(await came(client.mutation(api.displays.heartbeat, { key: 'k' }))).toEqual({ value: { now: 7 } })
    expect(asked).toEqual([[api.displays.heartbeat, { key: 'k' }]])
    expect(written).toEqual({ error: [], warn: [] })
  })

  test('is not also written by the client itself, which would write an error whatever the failure was, and what else the client writes is written', () => {
    const { logger } = connect('http://localhost:39000')
    logger.error(TROUBLE)
    logger.error('[CONVEX A(displays:signOutToken)] [Request ID: 0123456789abcdef] Server Error')
    expect(written.error).toEqual([])
    logger.error('Failed to authenticate: "the token ran out", check your server auth config')
    logger.warn('Refetching auth token immediately')
    expect(written).toEqual({
      error: [['Failed to authenticate: "the token ran out", check your server auth config']],
      warn: [['Refetching auth token immediately']],
    })
  })
})

describe('something that is harmless to ask for twice, asked for with `askTwice`', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  /** A connection whose calls come to each of these in turn, and how many there were. */
  function connectionThat(...turns: (() => Promise<unknown>)[]) {
    const calls = vi.fn(() => turns[Math.min(calls.mock.calls.length, turns.length) - 1]!())
    return { client: connectionWhere(calls), calls }
  }
  const token = (client: ConvexReactClient, wanted?: () => boolean) =>
    came(askTwice(client, (calls) => calls.action(api.displays.signOutToken, { key: 'k' }), wanted))

  test('is asked for once more where it met trouble, a second or two later, and trouble the second asking got past is written nowhere', async () => {
    const { client, calls } = connectionThat(
      () => Promise.reject(troubled()),
      () => Promise.resolve({ token: 'a-token' }),
    )
    const asking = token(client)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await asking).toEqual({ value: { token: 'a-token' } })
    expect(calls.mock.calls).toEqual([
      [api.displays.signOutToken, { key: 'k' }],
      [api.displays.signOutToken, { key: 'k' }],
    ])
    expect(written).toEqual({ error: [], warn: [] })
  })

  test('is given to whoever asked as trouble where it met trouble both times, and that is written as an error once', async () => {
    const err = troubled()
    const { client, calls } = connectionThat(() => Promise.reject(err))
    const asking = token(client)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await asking).toEqual({ err })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(written.error).toEqual([[TROUBLE]])
  })

  test('is not asked for again where the backend refused it: a refusal is given at once, and written by nobody', async () => {
    const refusal = refused('rate_limited')
    const { client, calls } = connectionThat(() => Promise.reject(refusal))
    expect(await token(client)).toEqual({ err: refusal })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(written).toEqual({ error: [], warn: [] })
  })

  test('is not asked for again where whoever asked wants it no more by then, and nothing is written of it', async () => {
    const err = troubled()
    const { client, calls } = connectionThat(() => Promise.reject(err))
    const asking = token(client, () => false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await asking).toEqual({ err })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(written).toEqual({ error: [], warn: [] })
  })

  test('is asked for with whatever connection it is given, where that is not one the site made', async () => {
    const asked = vi.fn(() => (asked.mock.calls.length === 1 ? Promise.reject(troubled()) : Promise.resolve('a-key')))
    const asking = came(askTwice({ action: asked, mutation: asked } as never, (calls) => calls.action(api.push.publicKey, {})))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await asking).toEqual({ value: 'a-key' })
    expect(written).toEqual({ error: [], warn: [] })
  })
})

describe('something a view threw, caught and shown as what it is', () => {
  test('is not written when it is a refusal of the backend’s, and is written as an error when it is anything else', () => {
    for (const code of ['unauthenticated', 'not_found', 'forbidden']) caught(refused(code))
    expect(written.error).toEqual([])
    const bug = new TypeError('something of the site’s own')
    const failure = troubled()
    caught(bug)
    caught(failure)
    expect(written.error).toEqual([[bug], [failure]])
  })
})
