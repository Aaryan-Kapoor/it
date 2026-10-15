import { getFunctionName } from 'convex/server'
import { afterEach, expect, test, vi } from 'vitest'
import { deletePage } from './src/delete'
import { call } from './src/lib'

vi.mock('./src/lib', async () => ({ ...(await vi.importActual('./src/lib')), call: vi.fn() }))
const asking = vi.mocked(call)
afterEach(() => {
  asking.mockReset()
  vi.useRealTimers()
})

test('a deletion still pending after the brief wait reports its receipt even if the wall clock goes backward', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  asking.mockResolvedValueOnce({ job: 'receipt-1' }).mockResolvedValue({ job: 'receipt-1', state: 'pending', completedAt: null, attempts: 0, nextAt: null })
  const pending = deletePage('plan')
  await vi.advanceTimersByTimeAsync(250)
  vi.setSystemTime(Date.now() - 86_400_000)
  await vi.advanceTimersByTimeAsync(4750)
  expect(await pending).toMatchObject({ requested: 'plan', job: 'receipt-1', state: 'pending' })
  expect(await pending).not.toHaveProperty('deleted')
  expect(asking.mock.calls.filter(([, fn]) => getFunctionName(fn as never) === 'artifacts:remove')).toHaveLength(1)
})

test('losing the connection after requesting deletion preserves the receipt and leaves completion unknown', async () => {
  asking.mockResolvedValueOnce({ job: 'receipt-1' }).mockRejectedValueOnce(new Error('connection failed'))
  expect(await deletePage('plan')).toMatchObject({ job: 'receipt-1', state: 'pending', hint: expect.stringContaining('could not be checked') })
})

test('an absent status receipt is an error and never a confirmation', async () => {
  asking.mockRejectedValueOnce(new Error('No deletion record was found.'))
  await expect(deletePage('plan', true)).rejects.toThrow('No deletion record')
  expect(asking.mock.calls.map(([kind]) => kind)).toEqual(['query'])
})
