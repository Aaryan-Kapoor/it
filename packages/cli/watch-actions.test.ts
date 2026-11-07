import { afterEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  next: undefined as undefined | ((rows: any[]) => void),
  fail: undefined as undefined | (() => void),
  call: vi.fn(async () => ({})),
  handed: vi.fn(async () => true),
  close: vi.fn(async () => {}),
  unwatch: vi.fn(),
}))
vi.mock('./src/lib', () => ({
  api: { artifacts: { get: 'artifacts:get' }, delivery: { waiting: 'delivery:waiting' } },
  call: fixture.call,
  handed: fixture.handed,
  live: () => ({
    onUpdate: (_fn: unknown, _args: unknown, next: (rows: any[]) => void, fail: () => void) => {
      fixture.next = next
      fixture.fail = fail
      return fixture.unwatch
    },
    close: fixture.close,
  }),
  Problem: class extends Error {},
}))
vi.mock('./src/wait', () => ({ printed: (row: unknown) => row }))

import { watchActions } from './src/watch-actions'

afterEach(() => {
  vi.clearAllMocks()
})

test('A read-only stream prints pending IDs once and never claims, hands off, or acknowledges them.', async () => {
  const before = process.listeners('SIGTERM')
  const running = watchActions('isolated-page')
  await vi.waitFor(() => expect(fixture.next).toBeTypeOf('function'))
  fixture.next!([{ id: 'a1', page: 'isolated-page' }])
  fixture.next!([{ id: 'a1', page: 'isolated-page' }])
  await vi.waitFor(() => expect(fixture.handed).toHaveBeenCalledTimes(1))
  expect(fixture.call.mock.calls).toEqual([['query', 'artifacts:get', { slug: 'isolated-page' }]])
  const stop = process.listeners('SIGTERM').find((listener) => !before.includes(listener))!
  stop('SIGTERM')
  await running
  expect(fixture.unwatch).toHaveBeenCalledOnce()
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('A failed subscription closes the stream instead of silently claiming success.', async () => {
  fixture.next = undefined
  const running = watchActions('isolated-page')
  const rejection = expect(running).rejects.toThrow('observation stream ended unexpectedly')
  await vi.waitFor(() => expect(fixture.next).toBeTypeOf('function'))
  fixture.fail!()
  await rejection
  expect(fixture.handed).not.toHaveBeenCalled()
  expect(fixture.close).toHaveBeenCalledOnce()
})
