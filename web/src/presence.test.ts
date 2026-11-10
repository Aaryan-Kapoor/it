import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { learnClock, readClocks, reportClock } from './lib'
import { type Report, reportPage, startReports, USED_EVERY_MS, VISIBLE_EVERY_MS } from './presence'

let stop: (() => void) | undefined
let shown: 'visible' | 'hidden'
beforeEach(() => {
  vi.useFakeTimers()
  shown = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => shown)
})
afterEach(() => {
  reportPage('none')
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A reporter whose reports are kept, each answered at once unless `held` says otherwise. */
function reporter(opts: { takes?: () => boolean; answer?: (r: Report) => Promise<unknown> } = {}) {
  const sent: Report[] = []
  stop = startReports(
    (r) => {
      sent.push(r)
      // Answered as the backend answers: the use it said is taken
      return opts.answer ? opts.answer(r) : Promise.resolve({ accepted: true, used: r.used === true })
    },
    opts.takes ?? (() => true),
    { document, window, now: () => Date.now() },
  )
  return sent
}
const hide = () => {
  shown = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
}
const show = () => {
  shown = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
}
const click = () => window.dispatchEvent(new Event('pointerdown'))

test('a tab says it is visible at once and every minute, that it is hidden once, and counts each report up', async () => {
  const sent = reporter()
  expect(sent).toEqual([{ tab: expect.stringMatching(/^[0-9a-f]{32}$/), sequence: 1, phase: 'none', visible: true }])
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent).toHaveLength(2)
  hide()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ visible: false })
  // Hidden, it has said so, and says nothing more until it is shown again
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS * 3)
  expect(sent).toHaveLength(3)
  show()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ visible: true })
  expect(sent.map((r) => r.sequence)).toEqual([1, 2, 3, 4])
  expect(new Set(sent.map((r) => r.tab)).size).toBe(1)
})

test('a tab that is closed says it is hidden, at once, even while another report is on its way', async () => {
  const sent = reporter({ answer: () => new Promise(() => {}) })
  window.dispatchEvent(new Event('pagehide'))
  expect(sent.map((r) => r.visible)).toEqual([true, false])
})

test('a use is said at once, then at most once in ten seconds, and what came in between is said when they are up', async () => {
  const sent = reporter()
  await vi.advanceTimersByTimeAsync(0)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true, visible: true })
  const count = sent.length
  vi.advanceTimersByTime(1000)
  click()
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toHaveLength(count)
  await vi.advanceTimersByTimeAsync(USED_EVERY_MS)
  expect(sent).toHaveLength(count + 1)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // Nothing done since, so the minute's report says no use
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent.at(-1)).not.toHaveProperty('used')
})

test('one report at a time: what changes while one is on its way is said once, as it stands, when that one is answered', async () => {
  const answers: (() => void)[] = []
  const sent = reporter({ answer: () => new Promise<void>((done) => answers.push(done)) })
  hide()
  show()
  hide()
  expect(sent).toHaveLength(1)
  answers.shift()!()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({ visible: false, sequence: 2 })
})

test('a use whose report failed is said with the next, if that is within ten seconds of it, and not after', async () => {
  let fail = true
  const sent = reporter({ answer: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()) })
  await vi.advanceTimersByTimeAsync(0)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // The connection comes back a moment later
  fail = false
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // A use that failed to be said, long ago, is not said as if it were now
  fail = true
  click()
  await vi.advanceTimersByTimeAsync(USED_EVERY_MS)
  fail = false
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent.at(-1)).not.toHaveProperty('used')
})

test('nothing is sent while the backend does not name it, and reports begin once it does', async () => {
  let takes = false
  const sent = reporter({ takes: () => takes })
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  hide()
  show()
  expect(sent).toEqual([])
  takes = true
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent).toEqual([expect.objectContaining({ sequence: 1, visible: true })])
  // And stop again where it no longer does
  takes = false
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent).toHaveLength(1)
})

test('a tab reached over plain http, where the browser offers no randomUUID, still has an id of its own', () => {
  const before = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
  try {
    const sent = reporter()
    expect(sent[0]?.tab).toMatch(/^[0-9a-f]{32}$/)
  } finally {
    if (before) Object.defineProperty(crypto, 'randomUUID', before)
    else Reflect.deleteProperty(crypto, 'randomUUID')
  }
})

test('a reporter started afresh is a new tab, and a page in a frame cannot say anything in its name', () => {
  const first = reporter()
  window.dispatchEvent(new MessageEvent('message', { data: { tab: 'forged', visible: false, used: true } }))
  expect(first).toHaveLength(1)
  stop?.()
  const second = reporter()
  expect(second[0]!.tab).not.toBe(first[0]!.tab)
})

test('the page a tab shows is said with each report as it changes, and a tab that closes shows none', async () => {
  const sent = reporter()
  reportPage('loading', 'mount-1')
  await vi.advanceTimersByTimeAsync(0)
  reportPage('shown', 'mount-1')
  await vi.advanceTimersByTimeAsync(0)
  // Said again as it is, nothing has changed and nothing is sent
  reportPage('shown', 'mount-1')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.map((r) => [r.phase, r.mountId])).toEqual([
    ['none', undefined],
    ['loading', 'mount-1'],
    ['shown', 'mount-1'],
  ])
  // Every minute's report says it too
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent.at(-1)).toMatchObject({ phase: 'shown', mountId: 'mount-1' })
  window.dispatchEvent(new Event('pagehide'))
  expect(sent.at(-1)).toEqual(expect.objectContaining({ phase: 'none', visible: false }))
  expect(sent.at(-1)).not.toHaveProperty('mountId')
  // A page that is left shows none, and a phase with no showing is no page
  reportPage('none')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ phase: 'none' })
  reportPage('shown')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).not.toHaveProperty('mountId')
})

test('each report says when it was made, by the backend’s clock, and keeps that time however late it is sent', async () => {
  let backend = 1_000_000
  const sent: Report[] = []
  let answer: (() => void) | undefined
  stop = startReports(
    (r) => {
      sent.push(r)
      return new Promise<void>((done) => {
        answer = done
      })
    },
    () => true,
    { document, window, now: () => Date.now(), clock: { at: () => backend, ask: () => {}, learned: () => () => {} } },
  )
  expect(sent).toEqual([expect.objectContaining({ sequence: 1, observedAt: 1_000_000 })])
  // What is made while the first is held is made when it is sent, not when it came up
  click()
  backend += 60_000
  answer!()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ sequence: 2, observedAt: 1_060_000 })
  // The report itself never changes after it was made, so a connection that sends it again sends its time
  expect(sent[0]!.observedAt).toBe(1_000_000)
})

/** A clock this test sets: the backend's time where it is known closely enough, and word of when it is learned. */
function clockOf() {
  let at: number | undefined
  let asked = 0
  const told = new Set<() => void>()
  return {
    clock: {
      at: () => at,
      ask: () => void asked++,
      learned: (then: () => void) => {
        told.add(then)
        return () => told.delete(then)
      },
    },
    set: (to: number | undefined) => {
      at = to
    },
    learn: (to: number) => {
      at = to
      for (const then of told) then()
    },
    asked: () => asked,
  }
}

test('without the backend’s time known closely enough, a report says no time and no use, asks for it, and says the use once it is learned', async () => {
  const c = clockOf()
  const sent: Report[] = []
  stop = startReports(
    (r) => {
      sent.push(r)
      return Promise.resolve({ accepted: true, used: r.used === true })
    },
    () => true,
    { document, window, now: () => Date.now(), clock: c.clock },
  )
  expect(sent).toEqual([expect.objectContaining({ sequence: 1, visible: true })])
  expect(sent[0]).not.toHaveProperty('observedAt')
  await vi.advanceTimersByTimeAsync(USED_EVERY_MS)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).not.toHaveProperty('used')
  expect(sent.at(-1)).not.toHaveProperty('observedAt')
  expect(c.asked()).toBeGreaterThan(0)
  // The heartbeat it asked for is answered a moment later: the use is said, dated
  await vi.advanceTimersByTimeAsync(1000)
  c.learn(5_000_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true, observedAt: 5_000_000 })
  // Taken, it is not said again
  const count = sent.length
  c.learn(5_001_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toHaveLength(count)
})

test('a use the backend did not take is kept and said again while it is a use of a moment ago, and not after', async () => {
  const c = clockOf()
  c.set(1_000_000)
  let take = false
  const sent: Report[] = []
  stop = startReports(
    (r) => {
      sent.push(r)
      return Promise.resolve({ accepted: true, used: take && r.used === true })
    },
    () => true,
    { document, window, now: () => Date.now(), clock: c.clock },
  )
  await vi.advanceTimersByTimeAsync(USED_EVERY_MS)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  const asked = c.asked()
  expect(asked).toBeGreaterThan(0)
  // Learned afresh, the clock lets it be said again, and this time it is taken
  take = true
  c.learn(1_002_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true, observedAt: 1_002_000 })
  const count = sent.length
  c.learn(1_003_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toHaveLength(count)
  // One not taken, and not said again within ten seconds, is not said as a use after them
  take = false
  click()
  await vi.advanceTimersByTimeAsync(USED_EVERY_MS + 1000)
  c.learn(1_020_000)
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent.at(-1)).not.toHaveProperty('used')
})

test('after the machine slept, the backend’s time is not known closely enough to date a report until it is learned again', () => {
  // The browser's clocks, as this test moves them: the one that only goes forward stands still in sleep
  let mono = 1_000_000
  let wall = Date.now()
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  vi.spyOn(Date, 'now').mockImplementation(() => wall)
  learnClock(wall, { sent: { mono: mono - 100, wall: wall - 100 }, back: { mono, wall } })
  expect(reportClock()).toBe(Math.floor(wall + 50))
  // Three minutes asleep
  wall += 180_000
  expect(reportClock()).toBeUndefined()
  // A heartbeat on waking teaches it again
  const sent = readClocks()
  mono += 80
  wall += 80
  learnClock(wall - 40, { sent, back: readClocks() })
  expect(reportClock()).toBe(Math.floor(wall))
})

test('a use kept from before the machine slept is not said as a use after it, and one made on waking is', async () => {
  const c = clockOf()
  c.set(1_000_000)
  // The clock that only goes forward, as this test moves it: it stands still while the machine sleeps
  let mono = 0
  const sent: Report[] = []
  stop = startReports(
    (r) => {
      sent.push(r)
      // The backend does not take it: its clock was learned before the sleep, and this one's is not yet
      return Promise.resolve({ accepted: true, used: false })
    },
    () => true,
    { document, window, now: () => mono, wall: () => Date.now(), clock: c.clock },
  )
  await vi.advanceTimersByTimeAsync(0)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // Three minutes asleep, and a tenth of a second by the clock that stood still
  vi.setSystemTime(Date.now() + 180_000)
  mono += 100
  const count = sent.length
  c.learn(1_180_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.slice(count).filter((r) => r.used)).toEqual([])
  // A click on waking is a use
  mono += 100
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true, observedAt: 1_180_000 })
})

/** A reporter whose two clocks this test moves, and whose backend never takes a use, so that one stays kept. */
function keptAcross() {
  const c = clockOf()
  c.set(1_000_000)
  const clocks = { mono: 0, wall: 50_000_000 }
  const sent: Report[] = []
  stop = startReports(
    (r) => {
      sent.push(r)
      return Promise.resolve({ accepted: true, used: false })
    },
    () => true,
    { document, window, now: () => clocks.mono, wall: () => clocks.wall, clock: c.clock },
  )
  return { c, clocks, sent }
}

test('a use a second old is still a use where the browser’s clock is set back meanwhile', async () => {
  const { c, clocks, sent } = keptAcross()
  await vi.advanceTimersByTimeAsync(0)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // A second on, the browser's clock is put a minute back
  clocks.mono += 1000
  clocks.wall += 1000 - 60_000
  c.learn(1_001_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true, observedAt: 1_001_000 })
})

test('a use too old after a sleep stays too old where the browser’s clock is then set back to about when it was made', async () => {
  const { c, clocks, sent } = keptAcross()
  await vi.advanceTimersByTimeAsync(0)
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
  // Three minutes asleep, and a tenth of a second by the clock that stood still
  clocks.mono += 100
  clocks.wall += 180_000
  let count = sent.length
  c.learn(1_180_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.slice(count).filter((r) => r.used)).toEqual([])
  // The browser's clock is put back to a moment after the click: still no use, with nothing done since
  clocks.mono += 100
  clocks.wall -= 179_000
  count = sent.length
  c.learn(1_181_000)
  await vi.advanceTimersByTimeAsync(VISIBLE_EVERY_MS)
  expect(sent.length).toBeGreaterThan(count)
  expect(sent.slice(count).filter((r) => r.used)).toEqual([])
  // Only another use is said
  click()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.at(-1)).toMatchObject({ used: true })
})
