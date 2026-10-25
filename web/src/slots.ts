// Which cards on the grid show their page, and when. Each card's picture is the page itself,
// running in the browser, so only so many are shown at once, and how many follows what the
// device can bear. Every card on the screen comes first, in the order a person reads them, and
// then the cards just above and below it, while there is room. Pictures are begun a few at a
// time, so that a fast scroll does not begin dozens at once, and a card that has gone by before
// its turn is never begun. A card that leaves the screen keeps its picture while only a few
// others do, so that scrolling back finds it as it was, without a new showing.

/** How far beyond the screen a card is near enough to be shown before it is on it. */
const NEAR = '200px 0px'
/** How long a picture that has been begun may take to say hello before the next is begun beside it. */
const LOAD_MS = 8000

/**
 * How many cards may show their page at once, on a device with this much memory, in gigabytes,
 * and this many cores: eight to a gigabyte and six to a core, and never fewer than eight or
 * more than sixty-four. A browser that does not say what it has is taken by its cores alone.
 */
export function mostFor(memory: number | undefined, cores: number | undefined): number {
  const byCores = (cores && cores > 0 ? cores : 4) * 6
  const most = memory && memory > 0 ? Math.min(memory * 8, byCores) : byCores
  return Math.max(8, Math.min(64, Math.round(most)))
}

/** One card's place among the rest. */
export interface Slot {
  /** The page in the card's frame said hello and is shown: the next card may be begun. */
  shown(): void
  /** The backend said that pictures came too fast: this card lets go of its picture, and none is begun for this long. */
  later(ms: number): void
  /** No picture can be had for this card. It keeps its cover and is not asked for again. */
  failed(): void
  /** The card has left the grid. */
  leave(): void
}

export interface Slots {
  /** Takes a card into account. `tell` is told whether the card is to show its page now. */
  join(el: Element, tell: (live: boolean) => void): Slot
}

interface Card {
  el: Element
  tell: (live: boolean) => void
  /** On the screen, and near it. */
  inView: boolean
  near: boolean
  live: boolean
  /** While its picture has been begun and has not yet said hello. */
  loading: ReturnType<typeof setTimeout> | null
  /** When it was last on the screen or near it, or left it. */
  seenAt: number
  failed: boolean
}

/** The order cards are read in: the grid's own order, row by row. */
const byPlace = (a: Card, b: Card) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)

export function slots({ most, loading, keptAway }: { most: number; loading: number; keptAway: number }): Slots {
  const cards = new Map<Element, Card>()
  let pausedUntil = 0
  let resume: ReturnType<typeof setTimeout> | undefined

  const seen = (which: 'inView' | 'near') => (entries: IntersectionObserverEntry[]) => {
    const now = Date.now()
    for (const e of entries) {
      const card = cards.get(e.target)
      if (!card) continue
      card[which] = e.isIntersecting
      card.seenAt = now
    }
    arrange()
  }
  // Where it cannot be told what is on the screen, every card is taken to be on it
  const watched = typeof IntersectionObserver !== 'undefined'
  const onScreen = watched ? new IntersectionObserver(seen('inView')) : null
  const nearby = watched ? new IntersectionObserver(seen('near'), { rootMargin: NEAR }) : null

  const begin = (card: Card) => {
    card.live = true
    card.loading = setTimeout(() => {
      card.loading = null
      arrange()
    }, LOAD_MS)
    card.tell(true)
  }
  const drop = (card: Card, tell = true) => {
    card.live = false
    clearTimeout(card.loading ?? undefined)
    card.loading = null
    if (tell) card.tell(false)
  }

  function arrange(): void {
    const all = [...cards.values()]
    // Off the screen, a card keeps its picture while few enough others do: past that, the one seen longest ago lets go
    const away = all.filter((c) => c.live && !c.inView && !c.near).sort((a, b) => a.seenAt - b.seenAt)
    for (const card of away.slice(0, Math.max(0, away.length - keptAway))) drop(card)
    if (Date.now() < pausedUntil) return
    let begun = all.filter((c) => c.loading).length
    let live = all.filter((c) => c.live).length
    const wanted = all.filter((c) => !c.live && !c.failed && (c.inView || c.near)).sort((a, b) => Number(b.inView) - Number(a.inView) || byPlace(a, b))
    for (const card of wanted) {
      if (begun >= loading) return
      if (live >= most) {
        // A card on the screen takes the place of one off it, or else of one only near it; a card near it only of one off it
        const room = all
          .filter((c) => c.live && !c.inView && (card.inView || !c.near))
          .sort((a, b) => Number(a.near) - Number(b.near) || a.seenAt - b.seenAt)[0]
        if (!room) return
        drop(room)
        live--
      }
      begin(card)
      begun++
      live++
    }
  }

  return {
    join(el, tell) {
      const card: Card = { el, tell, inView: !watched, near: !watched, live: false, loading: null, seenAt: Date.now(), failed: false }
      cards.set(el, card)
      onScreen?.observe(el)
      nearby?.observe(el)
      arrange()
      return {
        shown() {
          if (!card.loading) return
          clearTimeout(card.loading)
          card.loading = null
          arrange()
        },
        later(ms) {
          if (!cards.has(el)) return
          drop(card)
          pausedUntil = Math.max(pausedUntil, Date.now() + ms)
          clearTimeout(resume)
          resume = setTimeout(arrange, pausedUntil - Date.now())
        },
        failed() {
          if (!cards.has(el)) return
          card.failed = true
          drop(card)
          arrange()
        },
        leave() {
          if (!cards.delete(el)) return
          drop(card, false)
          onScreen?.unobserve(el)
          nearby?.unobserve(el)
          arrange()
        },
      }
    },
  }
}

let grid: Slots | undefined
/** The grid's slots, as many as this device can bear, made the first time a card asks. */
export function gridSlots(): Slots {
  const device = navigator as Navigator & { deviceMemory?: number }
  grid ??= slots({ most: mostFor(device.deviceMemory, navigator.hardwareConcurrency), loading: 4, keptAway: 12 })
  return grid
}
