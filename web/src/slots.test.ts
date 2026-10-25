// Which cards on the grid show their page, with a stand-in for what the browser says is on the
// screen. What must hold: every card on the screen is shown, up to what the device bears and
// before any card that is only near it; pictures are begun a few at a time, and a card that went
// by before its turn is never begun; a card that leaves keeps its picture while only a few
// others do; and pictures that came too fast wait for the backend's moment, and are not lost.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mostFor, type Slot, slots } from './slots'

/** The two watchers the slots make, one for the screen and one for what is near it, as the test drives them. */
const watchers: { near: boolean; callback: IntersectionObserverCallback; watched: Set<Element> }[] = []
class Watcher {
  watched = new Set<Element>()
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    watchers.push({ near: Boolean(options?.rootMargin), callback, watched: this.watched })
  }
  observe(el: Element) {
    this.watched.add(el)
  }
  unobserve(el: Element) {
    this.watched.delete(el)
  }
  disconnect() {
    this.watched.clear()
  }
}

/** A grid of cards in a row, each with what it was told: whether it is to show its page now. */
function grid(count: number, options: { most: number; loading: number; keptAway: number; keptMs?: number }) {
  const s = slots({ keptMs: 120_000, ...options })
  const cards = Array.from({ length: count }, (_, i) => {
    const el = document.body.appendChild(document.createElement('span'))
    const card = { i, el, live: false, told: 0, slot: undefined as unknown as Slot }
    card.slot = s.join(el, (live) => {
      card.live = live
      card.told++
    })
    return card
  })
  /** The browser says which cards are on the screen now, and which are near it. */
  const scroll = (inView: number[], near: number[] = []) => {
    for (const w of watchers) {
      const entries = cards
        .filter((c) => w.watched.has(c.el))
        .map(
          (c) =>
            ({
              target: c.el,
              isIntersecting: w.near ? inView.includes(c.i) || near.includes(c.i) : inView.includes(c.i),
            }) as unknown as IntersectionObserverEntry,
        )
      w.callback(entries, w as never)
    }
  }
  const live = () => cards.filter((c) => c.live).map((c) => c.i)
  /** Every picture that has been begun says hello. */
  const allShown = () => {
    for (const c of cards) if (c.live) c.slot.shown()
  }
  /** Shows every picture there is room for, a few at a time, as the pages in their frames say hello. */
  const settle = () => {
    for (let round = 0; round < 50; round++) {
      const before = live().join()
      allShown()
      if (live().join() === before) return
    }
  }
  return { cards, scroll, live, allShown, settle }
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

beforeEach(() => {
  watchers.length = 0
  vi.stubGlobal('IntersectionObserver', Watcher)
  vi.useFakeTimers()
})
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('which cards show their page', () => {
  test('every card on the screen is shown, however many there are, up to what the device bears', () => {
    // A large display, with forty-eight cards on the screen at once
    const g = grid(60, { most: 64, loading: 4, keptAway: 12 })
    g.scroll(range(0, 48))
    g.settle()
    expect(g.live()).toEqual(range(0, 48))
  })

  test('cards on the screen come before cards that are only near it, and the near ones have only the room that is left', () => {
    const g = grid(30, { most: 10, loading: 4, keptAway: 12 })
    // Cards 8 to 11 are on the screen, and 0 to 7 and 12 to 19 only near it
    g.scroll(range(8, 12), [...range(0, 8), ...range(12, 20)])
    expect(g.live()).toEqual(range(8, 12))
    g.settle()
    // The six that were left of the ten go to the near cards, in the order they are read
    expect(g.live()).toEqual([...range(0, 6), ...range(8, 12)])
  })

  test('where there is more on the screen than the device bears, the first cards in reading order are shown', () => {
    const g = grid(20, { most: 8, loading: 4, keptAway: 12 })
    g.scroll(range(0, 20))
    g.settle()
    expect(g.live()).toEqual(range(0, 8))
  })

  test('pictures are begun a few at a time, the next only once one before it has said hello or taken too long', () => {
    const g = grid(12, { most: 64, loading: 4, keptAway: 12 })
    g.scroll(range(0, 12))
    expect(g.live()).toEqual([0, 1, 2, 3])
    g.cards[1]!.slot.shown()
    expect(g.live()).toEqual([0, 1, 2, 3, 4])
    // A page that never says hello holds its place among those being begun for eight seconds at most
    vi.advanceTimersByTime(8000)
    expect(g.live()).toEqual(range(0, 9))
  })

  test('a card that went by in a fast scroll, before its turn came, is never begun', () => {
    const g = grid(40, { most: 64, loading: 4, keptAway: 12 })
    g.scroll(range(0, 8))
    expect(g.live()).toEqual([0, 1, 2, 3])
    // Scrolled past 8 to 31 before anything said hello, and come to rest on 32 to 39
    g.scroll(range(8, 16))
    g.scroll(range(16, 24))
    g.scroll(range(32, 40))
    g.settle()
    expect(g.cards.slice(4, 32).filter((c) => c.told > 0)).toEqual([])
    expect(g.live()).toEqual([0, 1, 2, 3, ...range(32, 40)])
  })
})

describe('a card that leaves the screen', () => {
  test('keeps its picture, so that scrolling back finds it as it was and asks for no new showing', () => {
    const g = grid(24, { most: 64, loading: 4, keptAway: 12 })
    g.scroll(range(0, 12))
    g.settle()
    g.scroll(range(12, 24))
    g.settle()
    expect(g.live()).toEqual(range(0, 24))
    g.scroll(range(0, 12))
    g.settle()
    // Each was told once that it was to be shown, and never that it was not
    expect(g.cards.map((c) => c.told)).toEqual(g.cards.map(() => 1))
  })

  test('lets go of its picture two minutes after it left the screen, and not before', () => {
    const g = grid(12, { most: 64, loading: 4, keptAway: 12, keptMs: 120_000 })
    g.scroll(range(0, 6))
    g.settle()
    g.scroll(range(6, 12))
    g.settle()
    vi.advanceTimersByTime(60_000)
    // Back to the first six for a moment, and away from them again: they left the screen once more just now
    g.scroll(range(0, 6))
    g.scroll(range(6, 12))
    vi.advanceTimersByTime(119_999)
    expect(g.live()).toEqual(range(0, 12))
    vi.advanceTimersByTime(1)
    expect(g.live()).toEqual(range(6, 12))
  })

  test('lets go of its picture once more cards than a few are kept off the screen, the one seen longest ago first', () => {
    const g = grid(30, { most: 64, loading: 4, keptAway: 4 })
    g.scroll(range(0, 6))
    g.settle()
    vi.advanceTimersByTime(1000)
    g.scroll(range(6, 12))
    g.settle()
    vi.advanceTimersByTime(1000)
    g.scroll(range(12, 18))
    g.settle()
    // Of the twelve off the screen, the four that left it last are kept
    expect(g.live()).toEqual([...range(8, 12), ...range(12, 18)])
  })

  test('gives its place to a card on the screen once the device bears no more, and a card on the screen is never let go for another', () => {
    const g = grid(16, { most: 8, loading: 4, keptAway: 12 })
    g.scroll(range(0, 8))
    g.settle()
    g.scroll(range(8, 16))
    g.settle()
    expect(g.live()).toEqual(range(8, 16))
    // Back at the top, the first eight take the places of those that are now off the screen
    g.scroll(range(0, 8))
    g.settle()
    expect(g.live()).toEqual(range(0, 8))
  })

  test('that leaves the grid lets its place go to the next card', () => {
    const g = grid(10, { most: 8, loading: 8, keptAway: 12 })
    g.scroll(range(0, 10))
    g.settle()
    expect(g.live()).toEqual(range(0, 8))
    g.cards[0]!.slot.leave()
    g.cards[0]!.el.remove()
    expect(g.live().filter((i) => i !== 0)).toEqual(range(1, 9))
    // It is not told it was let go: it is gone, and nothing is told to it again
    expect(g.cards[0]!.told).toBe(1)
  })
})

describe('when the backend says no', () => {
  test('pictures that came too fast are begun again once the backend’s moment has passed, and none before', () => {
    const g = grid(8, { most: 64, loading: 8, keptAway: 12 })
    g.scroll(range(0, 8))
    expect(g.live()).toEqual(range(0, 8))
    for (const c of g.cards.slice(5)) c.slot.later(3000)
    expect(g.live()).toEqual(range(0, 5))
    vi.advanceTimersByTime(2999)
    g.allShown()
    expect(g.live()).toEqual(range(0, 5))
    vi.advanceTimersByTime(1)
    expect(g.live()).toEqual(range(0, 8))
  })

  test('a card whose picture cannot be had keeps its cover, is not asked for again, and lets its place go', () => {
    const g = grid(3, { most: 2, loading: 2, keptAway: 12 })
    g.scroll(range(0, 3))
    expect(g.live()).toEqual([0, 1])
    g.cards[0]!.slot.failed()
    g.settle()
    expect(g.live()).toEqual([1, 2])
    g.scroll([])
    g.scroll(range(0, 3))
    g.settle()
    expect(g.cards[0]!.told).toBe(2)
  })
})

describe('without a way to tell what is on the screen', () => {
  test('every card is taken to be on it, as many as the device bears', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('IntersectionObserver', undefined)
    const g = grid(12, { most: 9, loading: 4, keptAway: 12 })
    g.settle()
    expect(g.live()).toEqual(range(0, 9))
  })
})

describe('how many the device bears', () => {
  test('eight to a gigabyte and six to a core, between eight and sixty-four, and by the cores alone where the memory is not said', () => {
    expect([mostFor(8, 12), mostFor(8, 8), mostFor(4, 8), mostFor(2, 4), mostFor(1, 2), mostFor(0.5, 8), mostFor(undefined, 8), mostFor(undefined, 2)]).toEqual(
      [64, 48, 32, 16, 8, 8, 48, 12],
    )
    // A browser that says nothing of either is taken for four cores
    expect(mostFor(undefined, undefined)).toBe(24)
  })
})
