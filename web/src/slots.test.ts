// Which cards on the grid show a live preview, with a stand-in for what the browser says is on
// the screen. What must hold: every card on the screen is shown, up to what the screen's setting
// allows and before any card that is only near it; previews are begun a few at a time, and a card
// that went by before its turn is never begun; a card that leaves keeps its preview briefly while
// only a few others do; previews that came too fast wait for the backend's moment; and the four
// choices, and a backend that does not take previews as such, come to what they say.
import { TAKES } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { learnTakes } from './lib'
import { choosePreviews, type Plan, planFor, previewChoice, type Slot, slots } from './slots'

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
function grid(count: number, plan: Partial<Plan> | ((onScreen: number) => Plan), keptMs = 60_000) {
  const s = slots(typeof plan === 'function' ? plan : () => ({ most: 16, loading: 8, keptAway: 6, ...plan }), keptMs)
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
  /** Every preview that has been begun says hello. */
  const allShown = () => {
    for (const c of cards) if (c.live) c.slot.shown()
  }
  /** Shows every preview there is room for, a few at a time, as the pages in their frames say hello. */
  const settle = () => {
    for (let round = 0; round < 50; round++) {
      const before = live().join()
      allShown()
      if (live().join() === before) return
    }
  }
  return { s, cards, scroll, live, allShown, settle }
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

beforeEach(() => {
  watchers.length = 0
  vi.stubGlobal('IntersectionObserver', Watcher)
  vi.useFakeTimers()
  localStorage.clear()
})
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  learnTakes([])
})

describe('which cards show their page', () => {
  test('every card on the screen is shown, up to sixteen, the first in reading order', () => {
    const g = grid(60, { most: 16 })
    g.scroll(range(0, 48))
    g.settle()
    expect(g.live()).toEqual(range(0, 16))
  })

  test('with "All on screen", every card on the screen is shown, however many there are', () => {
    const g = grid(60, (onScreen) => planFor('all', true, onScreen))
    g.scroll(range(0, 48))
    g.settle()
    expect(g.live()).toEqual(range(0, 48))
    // And never fewer than sixteen, for the cards near a small screen
    g.scroll(range(0, 4), range(4, 30))
    g.settle()
    expect(g.live()).toEqual(range(0, 16))
  })

  test('cards on the screen come before cards that are only near it, and the near ones have only the room that is left', () => {
    const g = grid(30, { most: 10, loading: 4 })
    // Cards 8 to 11 are on the screen, and 0 to 7 and 12 to 19 only near it
    g.scroll(range(8, 12), [...range(0, 8), ...range(12, 20)])
    expect(g.live()).toEqual(range(8, 12))
    g.settle()
    // The six that were left of the ten go to the near cards, in the order they are read
    expect(g.live()).toEqual([...range(0, 6), ...range(8, 12)])
  })

  test('previews are begun a few at a time, the next only once one before it has said hello or taken too long', () => {
    const g = grid(12, { loading: 4 })
    g.scroll(range(0, 12))
    expect(g.live()).toEqual([0, 1, 2, 3])
    g.cards[1]!.slot.shown()
    expect(g.live()).toEqual([0, 1, 2, 3, 4])
    // A page that never says hello holds its place among those being begun for eight seconds at most
    vi.advanceTimersByTime(8000)
    expect(g.live()).toEqual(range(0, 9))
  })

  test('a card that went by in a fast scroll, before its turn came, is never begun', () => {
    const g = grid(40, { loading: 4 })
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

  test('fewer at once, as when the setting is lowered, lets go of those that matter least: off the screen first, then the last on it', () => {
    let most = 16
    const g = grid(24, () => ({ most, loading: 8, keptAway: 6 }))
    g.scroll(range(0, 4))
    g.settle()
    g.scroll(range(4, 16))
    g.settle()
    expect(g.live()).toEqual(range(0, 16))
    most = 9
    g.s.arrange()
    expect(g.live()).toEqual(range(4, 13))
    most = 0
    g.s.arrange()
    expect(g.live()).toEqual([])
  })
})

describe('a card that leaves the screen', () => {
  test('keeps its preview, so that scrolling back finds it as it was and asks for no new showing', () => {
    const g = grid(12, { most: 16 })
    g.scroll(range(0, 6))
    g.settle()
    g.scroll(range(6, 12))
    g.settle()
    expect(g.live()).toEqual(range(0, 12))
    g.scroll(range(0, 6))
    g.settle()
    // Each was told once that it was to be shown, and never that it was not
    expect(g.cards.map((c) => c.told)).toEqual(g.cards.map(() => 1))
  })

  test('lets go of its preview a minute after it left the screen, and not before', () => {
    const g = grid(12, { most: 16 })
    g.scroll(range(0, 6))
    g.settle()
    g.scroll(range(6, 12))
    g.settle()
    vi.advanceTimersByTime(30_000)
    // Back to the first six for a moment, and away from them again: they left the screen once more just now
    g.scroll(range(0, 6))
    g.scroll(range(6, 12))
    vi.advanceTimersByTime(59_999)
    expect(g.live()).toEqual(range(0, 12))
    vi.advanceTimersByTime(1)
    expect(g.live()).toEqual(range(6, 12))
  })

  test('lets go of its preview once more than six are kept off the screen, the one seen longest ago first', () => {
    // A small screen, two cards at a time
    const g = grid(12, { most: 16 })
    for (let at = 0; at < 10; at += 2) {
      g.scroll(range(at, at + 2))
      g.settle()
      vi.advanceTimersByTime(1000)
    }
    // Of the eight off the screen, the six that left it last are kept
    expect(g.live()).toEqual(range(2, 10))
  })

  test('gives its place to a card on the screen once no more may be shown, and a card on the screen is never let go for another', () => {
    const g = grid(18, { most: 9 })
    g.scroll(range(0, 9))
    g.settle()
    g.scroll(range(9, 18))
    g.settle()
    expect(g.live()).toEqual(range(9, 18))
    // Back at the top, the first nine take the places of those that are now off the screen
    g.scroll(range(0, 9))
    g.settle()
    expect(g.live()).toEqual(range(0, 9))
  })

  test('that leaves the grid lets its place go to the next card', () => {
    const g = grid(10, { most: 8, loading: 8 })
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
  test('previews that came too fast are begun again once the backend’s moment has passed, and none before', () => {
    const g = grid(8, { loading: 8 })
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

  test('a card whose preview cannot be had keeps its cover, is not asked for again, and lets its place go', () => {
    const g = grid(3, { most: 2, loading: 2 })
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
  test('every card is taken to be on it, as many as the setting allows, and "All on screen" is taken as sixteen', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('IntersectionObserver', undefined)
    const g = grid(40, (onScreen) => planFor('all', true, onScreen))
    g.settle()
    expect(g.live()).toEqual(range(0, 16))
  })
})

describe('the screen’s setting', () => {
  test('is sixteen unless the screen chose otherwise, and is kept in this browser', () => {
    expect(previewChoice()).toBe('sixteen')
    choosePreviews('nine')
    expect([previewChoice(), localStorage.getItem('it.previews')]).toEqual(['nine', 'nine'])
    localStorage.setItem('it.previews', 'forty-eight')
    expect(previewChoice()).toBe('sixteen')
  })

  test('each of the four choices comes to what it says', () => {
    expect(planFor('all', true, 40)).toEqual({ most: 40, loading: 8, keptAway: 6 })
    expect(planFor('all', true, 3)).toEqual({ most: 16, loading: 8, keptAway: 6 })
    expect(planFor('nine', true, 40)).toEqual({ most: 9, loading: 8, keptAway: 6 })
    expect(planFor('sixteen', true, 40)).toEqual({ most: 16, loading: 8, keptAway: 6 })
    expect(planFor('none', true, 40)).toEqual({ most: 0, loading: 0, keptAway: 0 })
  })

  test('without the backend’s word, every choice is today’s nine at once, with none kept off the screen, and "Pictures only" is none', () => {
    for (const choice of ['all', 'nine', 'sixteen'] as const) expect(planFor(choice, false, 40)).toEqual({ most: 9, loading: 9, keptAway: 0 })
    expect(planFor('none', false, 40)).toEqual({ most: 0, loading: 0, keptAway: 0 })
  })
})

describe('the grid’s own slots', () => {
  async function theGrid(count: number) {
    vi.resetModules()
    const lib = await import('./lib')
    const { gridSlots, choosePreviews } = await import('./slots')
    const cards = Array.from({ length: count }, () => {
      const card = { el: document.body.appendChild(document.createElement('span')), live: false, slot: undefined as unknown as Slot }
      card.slot = gridSlots().join(card.el, (live) => {
        card.live = live
      })
      return card
    })
    const scroll = (inView: number) => {
      for (const w of watchers) {
        w.callback(
          cards.filter((c) => w.watched.has(c.el)).map((c, i) => ({ target: c.el, isIntersecting: i < inView }) as unknown as IntersectionObserverEntry),
          w as never,
        )
      }
    }
    const settle = () => {
      for (let round = 0; round < 50; round++) for (const c of cards) if (c.live) c.slot.shown()
    }
    const live = () => cards.filter((c) => c.live).length
    return { lib, choosePreviews, scroll, settle, live }
  }

  test('show nine until the backend names previews, sixteen once it does, and nine again if it stops', async () => {
    const g = await theGrid(30)
    g.scroll(30)
    g.settle()
    expect(g.live()).toBe(9)
    g.lib.learnTakes([TAKES.pictures])
    g.settle()
    expect(g.live()).toBe(16)
    g.lib.learnTakes([])
    expect(g.live()).toBe(9)
  })

  test('follow the setting as soon as it changes', async () => {
    const g = await theGrid(30)
    g.lib.learnTakes([TAKES.pictures])
    g.scroll(30)
    g.settle()
    expect(g.live()).toBe(16)
    g.choosePreviews('none')
    expect(g.live()).toBe(0)
    g.choosePreviews('all')
    g.settle()
    expect(g.live()).toBe(30)
    g.choosePreviews('nine')
    expect(g.live()).toBe(9)
  })
})
