import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const DAY = 86_400_000
const saved = () => Object.keys(localStorage).filter((key) => key.startsWith('it.outbox.'))
const read = () => JSON.parse(localStorage.getItem(saved()[0]!)!)
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 15, 12))
  localStorage.clear()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function backend(complete: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const mutation = vi.fn((fn: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(fn as never)
    return name === 'actions:replayGrant' ? Promise.resolve({ until: Date.now() + 6 * DAY }) : complete(name, args)
  })
  return { client: { mutation, connectionState: () => ({ isWebSocketConnected: true }) } as never, mutation }
}

test.each(['message', 'answer'] as const)('%s survives tab closure and replays its original identity after a lost success response', async (kind) => {
  let box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const accepted: Record<string, unknown>[] = []
  const first = backend(async (_name, args) => {
    accepted.push(args)
    return new Promise(() => {})
  })
  if (kind === 'message') void box.message(first.client, 'person', 'page', 'typed-original', 'Keep this request')
  else void box.answerNotification(first.client, 'notification', 'approve')
  await flush()
  expect(saved()).toHaveLength(1)
  expect(read().session).toBe('session')
  if (kind === 'message') expect(read().replayUntil).toBe(accepted[0]!.replayUntil)
  // A new document has the same storage and session, but none of the previous tab's memory.
  vi.resetModules()
  vi.setSystemTime(Date.now() + 20_000)
  box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  if (kind === 'message') expect(box.pendingMessage('person', 'page')?.text).toBe('Keep this request')
  else expect(box.pendingAnswer('notification')).toBe('approve')
  const second = backend(async (_name, args) => {
    expect(args).toEqual(accepted[0])
    return { actionId: 'same-receipt' }
  })
  await box.drain(second.client, 'person')
  expect(saved()).toEqual([])
  expect(second.mutation).toHaveBeenCalledTimes(1)
})

test('a saved grant is never renewed after a backward clock change or a permanent refusal', async () => {
  let box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const first = backend(async () => new Promise(() => {}))
  void box.message(first.client, 'person', 'page', 'typed-original', 'Keep my words')
  await flush()
  const original = read()
  localStorage.setItem(saved()[0]!, JSON.stringify({ ...original, left: true }))
  vi.resetModules()
  vi.setSystemTime(Date.now() - 2 * DAY)
  box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const second = backend(async (_name, args) => {
    expect(args.replayUntil).toBe(original.replayUntil)
    throw new ConvexError({ code: 'conflict', message: 'Too old to retry safely.' })
  })
  await box.drain(second.client, 'person')
  expect(second.mutation).toHaveBeenCalledTimes(1)
  expect(box.pendingMessage('person', 'page')).toEqual({ id: 'typed-original', text: 'Keep my words', refused: 'Too old to retry safely.' })
  await box.drain(second.client, 'person')
  expect(second.mutation).toHaveBeenCalledTimes(1)
})

test.each(['signout', 'repair', 'erase'] as const)('%s discards the old pairing and a late answer cannot restore its requests', async (ending) => {
  const box = await import('./outbox')
  const { forgetAll, keepFor } = await import('./lib')
  keepFor('person')
  box.outboxBelongsTo('person', 'old-session')
  let refuse!: (why: unknown) => void
  const old = backend(
    async () =>
      new Promise((_, no) => {
        refuse = no
      }),
  )
  const request = box.answerNotification(old.client, 'notification', 'approve').catch(() => {})
  await flush()
  if (ending === 'erase') forgetAll('person')
  else box.outboxBelongsTo(ending === 'signout' ? null : 'person', ending === 'signout' ? null : 'new-session')
  expect(saved()).toEqual([])
  refuse(new Error('The previous connection closed'))
  await request
  expect(saved()).toEqual([])
  const fresh = backend(async () => ({ actionId: 'unexpected' }))
  await box.drain(fresh.client, 'person')
  expect(fresh.mutation).not.toHaveBeenCalled()
})

test('storage failure during grant persistence dispatches nothing under an unrecorded deadline', async () => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const write = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (String(value).includes('replayUntil')) throw new DOMException('Full', 'QuotaExceededError')
    write.call(this, key, value)
  })
  const dispatch = vi.fn(async () => ({ actionId: 'unexpected' }))
  const client = backend(dispatch)
  await expect(box.message(client.client, 'person', 'page', 'typed-original', 'Keep my words')).rejects.toThrow(/could not be saved/)
  await flush()
  expect(dispatch).not.toHaveBeenCalled()
  expect(box.pendingMessage('person', 'page')).toMatchObject({ id: 'typed-original', text: 'Keep my words' })
})

test.each(['message', 'page'])('a saved %s survives a failed grant write and is sent when storage has room again', async (kind) => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const key = 'it.outbox.person.page.saved-request'
  const entry = {
    user: 'person',
    artifactId: 'page',
    format: 2,
    session: 'session',
    at: Date.now() - 60_000,
    envelope: { v: 1, clientActionId: 'saved-request', name: 'approve', payload: '{}', contentVersion: 1 },
    ...(kind === 'message' ? { operation: { kind: 'message', text: 'Keep my words' } } : {}),
  }
  // The tab closed after saving the request, before it could obtain and save a replay grant.
  localStorage.setItem(key, JSON.stringify(entry))
  const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError')
  })
  const dispatch = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    expect(read().replayUntil).toBe(args.replayUntil)
    return { actionId: 'accepted' }
  })
  const client = backend(dispatch)
  await box.drain(client.client, 'person')
  expect(dispatch).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBe(JSON.stringify(entry))
  full.mockRestore()
  await box.drain(client.client, 'person')
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(dispatch.mock.calls[0]?.[1]).toMatchObject(
    kind === 'message' ? { clientActionId: 'saved-request', text: 'Keep my words' } : { envelope: entry.envelope },
  )
  expect(saved()).toEqual([])
})

test('an unresolved old drain does not block work from a replacement pairing', async () => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'old-session')
  const unresolved = backend(async () => new Promise(() => {}))
  void box.message(unresolved.client, 'person', 'page', 'typed-old', 'Old words')
  await flush()
  localStorage.setItem(saved()[0]!, JSON.stringify({ ...read(), left: true }))
  vi.resetModules()
  const restored = await import('./outbox')
  restored.outboxBelongsTo('person', 'old-session')
  void restored.drain(unresolved.client, 'person')
  await flush()
  restored.outboxBelongsTo('person', 'new-session')
  const fresh = backend(async (_name, args) => {
    expect(args.expectedSession).toBe('new-session')
    return { actionId: 'new-receipt' }
  })
  localStorage.setItem(
    'it.outbox.person.page.typed-new',
    JSON.stringify({
      user: 'person',
      artifactId: 'page',
      format: 2,
      session: 'new-session',
      at: Date.now(),
      left: true,
      operation: { kind: 'message', text: 'New words' },
      envelope: { v: 1, clientActionId: 'typed-new', name: 'message', payload: '{}', contentVersion: 1 },
    }),
  )
  await restored.drain(fresh.client, 'person')
  expect(fresh.mutation).toHaveBeenCalledTimes(2)
  expect(saved()).toEqual([])
})

test.each(['message', 'answer', 'page'] as const)('%s waiting for a browser lock cannot move to a replacement pairing', async (kind) => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'old-session')
  let enter!: () => unknown
  const client = backend(async () => ({ actionId: 'unexpected' }))
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_key: string, _options: unknown, work: () => unknown) =>
        new Promise((yes, no) => {
          enter = () => Promise.resolve().then(work).then(yes, no)
        }),
    },
  })
  try {
    const work =
      kind === 'message'
        ? box.message(client.client, 'person', 'page', 'old-intent', 'Old words')
        : kind === 'answer'
          ? box.answerNotification(client.client, 'notification', 'approve')
          : box.submit(client.client, 'person', 'page', { v: 1, clientActionId: 'old-intent', name: 'approve', payload: '{}', contentVersion: 1 }, () => true)
    expect(box.anyUnsaved()).toBe(true)
    const refused = expect(work).rejects.toThrow(/pairing has ended/)
    box.outboxBelongsTo('person', 'new-session')
    await enter()
    await refused
    expect(client.mutation).not.toHaveBeenCalled()
    expect(saved()).toEqual([])
  } finally {
    Reflect.deleteProperty(navigator, 'locks')
  }
})

test.each(['signout', 'repair'] as const)('%s also discards requests written before pairing identities were stored', async (ending) => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'old-session')
  localStorage.setItem(
    'it.outbox.person.page.legacy-old',
    JSON.stringify({ user: 'person', artifactId: 'page', at: Date.now(), envelope: { clientActionId: 'legacy-old' } }),
  )
  box.outboxBelongsTo(ending === 'signout' ? null : 'person', ending === 'signout' ? null : 'new-session')
  expect(saved()).toEqual([])
})

test('a refused message expires in an open tab without being sent again', async () => {
  const box = await import('./outbox')
  box.outboxBelongsTo('person', 'session')
  const client = backend(async () => {
    throw new ConvexError({ code: 'invalid', message: 'Refused' })
  })
  await expect(box.message(client.client, 'person', 'page', 'typed-expired', 'Keep for one week')).rejects.toThrow()
  await flush()
  expect(box.pendingMessage('person', 'page')?.refused).toBe('Refused')
  const calls = client.mutation.mock.calls.length
  await vi.advanceTimersByTimeAsync(7 * DAY + 1)
  expect(saved()).toEqual([])
  expect(box.pendingMessage('person', 'page')).toBeNull()
  expect(client.mutation).toHaveBeenCalledTimes(calls)
})
