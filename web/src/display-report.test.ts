import { afterEach, expect, test, vi } from 'vitest'
import { type DisplayReport, reportPage, startDisplayReports } from './display-report'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  reportPage('none')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('The host reports readiness, navigation away, visibility and closure with increasing sequence numbers.', async () => {
  vi.useFakeTimers()
  const reports: DisplayReport[] = []
  stop = startDisplayReports(async (r) => {
    reports.push(r)
  })
  reportPage('loading', 'verified-mount')
  reportPage('shown', 'verified-mount')
  expect(reports.at(-1)).toMatchObject({ phase: 'shown', mountId: 'verified-mount', visible: true })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(reports.at(-1)?.visible).toBe(false)
  reportPage('none')
  expect(reports.at(-1)).not.toHaveProperty('mountId')
  await vi.advanceTimersByTimeAsync(30_000)
  const count = reports.length
  window.dispatchEvent(new Event('pagehide'))
  expect(reports.at(-1)).toMatchObject({ phase: 'none', visible: false })
  stop()
  stop = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reports.length).toBe(count + 2)
  expect(reports.map((r) => r.sequence)).toEqual(reports.map((_, i) => i + 1))
})

test('A page message cannot supply another tab or display identity.', () => {
  const reports: DisplayReport[] = []
  stop = startDisplayReports(async (r) => {
    reports.push(r)
  })
  window.dispatchEvent(new MessageEvent('message', { data: { tab: 'forged', displayId: 'other', phase: 'shown' } }))
  expect(reports).toHaveLength(1)
  expect(reports[0]?.tab).not.toBe('forged')
  expect(reports[0]).not.toHaveProperty('displayId')
})

test('A restarted reporter has a new tab identity and failed requests do not stop later reports.', async () => {
  vi.useFakeTimers()
  const reports: DisplayReport[] = []
  stop = startDisplayReports(async (r) => {
    reports.push(r)
    throw new Error('offline')
  })
  const first = reports[0]?.tab
  await vi.advanceTimersByTimeAsync(30_000)
  expect(reports).toHaveLength(2)
  stop()
  stop = startDisplayReports(async (r) => {
    reports.push(r)
  })
  expect(reports.at(-1)?.tab).not.toBe(first)
})

test('A display that reached It over plain http, where a browser offers no randomUUID, still reports.', () => {
  const before = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
  try {
    const reports: DisplayReport[] = []
    stop = startDisplayReports(async (r) => {
      reports.push(r)
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.tab).toMatch(/^[0-9a-f]{32}$/)
  } finally {
    if (before) Object.defineProperty(crypto, 'randomUUID', before)
    else Reflect.deleteProperty(crypto, 'randomUUID')
  }
})
