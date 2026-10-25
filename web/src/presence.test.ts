// What a display says of itself so that It can tell which display the person is using: that it
// is open, whether it is visible, and that the person used it, and how seldom it says each.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OPEN_EVERY_MS, presence, type Said, USED_EVERY_MS } from './presence'

let hidden = false
let said: Said[]
let stop: () => void
/** Hides the site or shows it again, as a browser does when its tab goes to the back or comes forward. */
const shown = (visible: boolean) => {
  hidden = !visible
  document.dispatchEvent(new Event('visibilitychange'))
}
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  said = []
  stop = presence(async (one) => {
    said.push(one)
  })
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('what a display says of itself', () => {
  test('that it is open, at once and every minute while it is visible, and nothing more while it is hidden', async () => {
    await settle()
    expect(said).toEqual([{ visible: true, used: false }])
    await vi.advanceTimersByTimeAsync(OPEN_EVERY_MS)
    expect(said).toHaveLength(2)
    shown(false)
    await settle()
    expect(said.at(-1)).toEqual({ visible: false, used: false })
    // Hidden, it has said so, and says nothing more until it is shown again
    await vi.advanceTimersByTimeAsync(OPEN_EVERY_MS * 3)
    window.dispatchEvent(new Event('pointerdown'))
    await settle()
    expect(said).toHaveLength(3)
    shown(true)
    await settle()
    expect(said.at(-1)).toEqual({ visible: true, used: false })
  })

  test('that the person used it, at once, and then at most once in ten seconds however much they do', async () => {
    await settle()
    window.dispatchEvent(new Event('pointerdown'))
    await settle()
    expect(said).toEqual([
      { visible: true, used: false },
      { visible: true, used: true },
    ])
    for (const kind of ['keydown', 'wheel', 'pointerdown']) window.dispatchEvent(new Event(kind))
    await vi.advanceTimersByTimeAsync(USED_EVERY_MS - 1000)
    expect(said).toHaveLength(2)
    // What they did meanwhile is said once the ten seconds are up, once, and nothing of what it was
    await vi.advanceTimersByTimeAsync(1000)
    expect(said).toEqual([
      { visible: true, used: false },
      { visible: true, used: true },
      { visible: true, used: true },
    ])
    // Nothing done since: nothing more is said of it
    await vi.advanceTimersByTimeAsync(USED_EVERY_MS * 2)
    expect(said).toHaveLength(3)
  })

  test('that the person used a page in its frame, which the browser says by its word that they have just acted', async () => {
    const activation = { isActive: false }
    stop()
    said = []
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation })
    stop = presence(async (one) => {
      said.push(one)
    })
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(said).toEqual([{ visible: true, used: false }])
    activation.isActive = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(said.at(-1)).toEqual({ visible: true, used: true })
    Reflect.deleteProperty(navigator, 'userActivation')
  })

  test('one thing at a time: what comes up while it is being said is said once that has been answered, and what failed is said again', async () => {
    stop()
    said = []
    const answers: (() => void)[] = []
    let fail = true
    stop = presence(
      (one) =>
        new Promise<void>((done, refused) => {
          said.push(one)
          answers.push(() => (fail ? refused(new Error('no')) : done()))
        }),
    )
    window.dispatchEvent(new Event('pointerdown'))
    shown(false)
    shown(true)
    await settle()
    expect(said).toEqual([{ visible: true, used: false }])
    answers.shift()!()
    await settle()
    // The use came up while the first was on its way, and is said in the one that follows it
    expect(said).toEqual([
      { visible: true, used: false },
      { visible: true, used: true },
    ])
    answers.shift()!()
    await settle()
    // That failed, so it is still owed, and goes with the next thing said
    fail = false
    await vi.advanceTimersByTimeAsync(OPEN_EVERY_MS)
    expect(said.at(-1)).toEqual({ visible: true, used: true })
  })
})
