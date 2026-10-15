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
  const client = backend(async () => ({ actionId: 'unexpected' }))
  await expect(box.message(client.client, 'person', 'page', 'typed-original', 'Keep my words')).rejects.toThrow(/could not be saved/)
  expect(client.mutation).toHaveBeenCalledTimes(1)
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
