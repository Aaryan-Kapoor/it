// Which cards on the grid show a live preview of their page, and when. Each live preview is the
// page itself, running in the browser, so only so many are shown at once: as many as the screen's
// own setting says, sixteen unless it says otherwise. Every card on the screen comes first, in
// the order a person reads them, and then the cards just above and below it, while there is
// room. Previews are begun a few at a time, so that a fast scroll does not begin dozens at once,
// and a card that has gone by before its turn is never begun. A card that leaves the screen keeps
// its preview for a minute while only a few others do, so that scrolling back finds it as it
// was, without a new showing. The rest show their cover.
//
// Where the backend does not name `TAKES.pictures`, as when It runs older functions, the grid is
// as it was before: nine at once, none kept off the screen, and asked for as a page opened.
import { TAKES } from '@it/protocol'
import { useSyncExternalStore } from 'react'
import { backendTakes, watchTakes } from './lib'

/** How far beyond the screen a card is near enough to be shown before it is on it. */
const NEAR = '200px 0px'
/** How long a preview that has been begun may take to say hello before the next is begun beside it. */
const LOAD_MS = 8000
/** How long a card off the screen keeps its preview. */
const KEPT_MS = 60_000

// ---------- the screen's setting ----------

/** How many live previews this screen shows at once. */
export type PreviewChoice = 'all' | 'nine' | 'sixteen' | 'none'
export const PREVIEW_CHOICES: readonly { value: PreviewChoice; label: string }[] = [
  { value: 'all', label: 'All on screen' },
  { value: 'nine', label: 'Nine' },
  { value: 'sixteen', label: '16' },
  { value: 'none', label: 'Pictures only' },
]
const DEFAULT_CHOICE: PreviewChoice = 'sixteen'
/** Kept in this browser, which is the screen: a setting of the screen's, and not of the person's. */
const CHOICE = 'it.previews'
let currentChoice: PreviewChoice | undefined
const choiceWatchers = new Set<() => void>()

/** What this screen was set to show. */
export function previewChoice(): PreviewChoice {
  if (currentChoice !== undefined) return currentChoice
  try {
    const kept = localStorage.getItem(CHOICE)
    return PREVIEW_CHOICES.some((c) => c.value === kept) ? (kept as PreviewChoice) : DEFAULT_CHOICE
  } catch {
    return DEFAULT_CHOICE
  }
}
export function choosePreviews(choice: PreviewChoice): void {
  currentChoice = choice
  try {
    localStorage.setItem(CHOICE, choice)
  } catch {
    // Kept for as long as the site is open, all the same
  }
  for (const fn of choiceWatchers) fn()
}
const watchChoice = (fn: () => void) => {
  choiceWatchers.add(fn)
  // Set in another tab of the same browser, which is the same screen
  const fromElsewhere = (e: StorageEvent) => {
    if (e.key !== CHOICE && e.key !== null) return
    currentChoice = undefined
    fn()
  }
  window.addEventListener('storage', fromElsewhere)
  return () => {
    choiceWatchers.delete(fn)
    window.removeEventListener('storage', fromElsewhere)
  }
}
export const usePreviewChoice = (): PreviewChoice => useSyncExternalStore(watchChoice, previewChoice)

// ---------- how many, for a choice ----------

export interface Plan {
  /** How many cards show their page at once. */
  most: number
  /** How many of them are begun at a time. */
  loading: number
  /** How many cards off the screen keep their preview. */
  keptAway: number
}

/**
 * What a choice comes to, with `onScreen` cards on the screen now, where the backend does or
 * does not take previews as such. "All on screen" gives every card on the screen its preview, and
 * never fewer than sixteen to the cards on and near it. Without the backend's word, it is nine at
 * once whatever the choice, and none for "Pictures only".
 */
export function planFor(choice: PreviewChoice, pictures: boolean, onScreen: number): Plan {
  if (choice === 'none') return { most: 0, loading: 0, keptAway: 0 }
  if (!pictures) return { most: 9, loading: 9, keptAway: 0 }
  const most = choice === 'nine' ? 9 : choice === 'sixteen' ? 16 : Math.max(16, onScreen)
  return { most, loading: 8, keptAway: 6 }
}

// ---------- the cards ----------

/** One card's place among the rest. */
export interface Slot {
  /** The page in the card's frame said hello and is shown: the next card may be begun. */
  shown(): void
  /** The backend said that previews came too fast: this card lets go of its preview, and none is begun for this long. */
  later(ms: number): void
  /** No preview can be had for this card. It keeps its cover and is not asked for again. */
  failed(): void
  /** The card has left the grid. */
  leave(): void
}

export interface Slots {
  /** Takes a card into account. `tell` is told whether the card is to show its page now. */
  join(el: Element, tell: (live: boolean) => void): Slot
  /** Arranges the cards again, as when the plan has changed. */
  arrange(): void
}

interface Card {
  el: Element
  tell: (live: boolean) => void
  /** On the screen, and near it. */
  inView: boolean
  near: boolean
  live: boolean
  /** While its preview has been begun and has not yet said hello. */
  loading: ReturnType<typeof setTimeout> | null
  /** When it was last on the screen or near it, or left it. */
  seenAt: number
  failed: boolean
}

/** The order cards are read in: the grid's own order, row by row. */
const byPlace = (a: Card, b: Card) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)

/**
 * Cards arranged by `plan`, asked again each time with how many cards are on the screen, and kept
 * off the screen for `keptMs`.
 */
export function slots(plan: (onScreen: number) => Plan, keptMs = KEPT_MS): Slots {
  const cards = new Map<Element, Card>()
  let pausedUntil = 0
  let resume: ReturnType<typeof setTimeout> | undefined
  /** When the card kept off the screen longest is to let go of its preview. */
  let expire: ReturnType<typeof setTimeout> | undefined

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
  // Where it cannot be told what is on the screen, every card is taken to be on it, and "All on
  // screen" is taken to be sixteen
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
  /** Which live card lets go first: one off the screen, the one seen longest ago, then one only near it, then the last on the screen in reading order. */
  const lettingGo = (a: Card, b: Card) => Number(a.inView) - Number(b.inView) || Number(a.near) - Number(b.near) || a.seenAt - b.seenAt || byPlace(b, a)

  function arrange(): void {
    const all = [...cards.values()]
    const now = Date.now()
    const { most, loading, keptAway } = plan(watched ? all.filter((c) => c.inView).length : 0)
    // Off the screen, a card keeps its preview for a while, and while few enough others do: past
    // either, it lets go of it, the one seen longest ago first
    const away = all.filter((c) => c.live && !c.inView && !c.near).sort((a, b) => a.seenAt - b.seenAt)
    const over = away.length - keptAway
    const kept = away.filter((card, i) => {
      if (i >= over && now - card.seenAt < keptMs) return true
      drop(card)
      return false
    })
    clearTimeout(expire)
    if (kept[0]) expire = setTimeout(arrange, kept[0].seenAt + keptMs - now)
    // Fewer than are shown now, as when the setting was lowered or the backend no longer takes
    // previews as such: the ones that matter least let go
    const live = all.filter((c) => c.live).sort(lettingGo)
    for (const card of live.slice(0, Math.max(0, live.length - most))) drop(card)
    if (now < pausedUntil) return
    let begun = all.filter((c) => c.loading).length
    let showing = Math.min(live.length, most)
    const wanted = all.filter((c) => !c.live && !c.failed && (c.inView || c.near)).sort((a, b) => Number(b.inView) - Number(a.inView) || byPlace(a, b))
    for (const card of wanted) {
      if (begun >= loading) return
      if (showing >= most) {
        // A card on the screen takes the place of one off it, or else of one only near it; a card near it only of one off it
        const room = all.filter((c) => c.live && !c.inView && (card.inView || !c.near)).sort(lettingGo)[0]
        if (!room) return
        drop(room)
        showing--
      }
      begin(card)
      begun++
      showing++
    }
  }

  return {
    arrange,
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
/**
 * The grid's slots, made the first time a card asks. The plan is read again each time the cards
 * are arranged, and they are arranged again when the setting or what the backend takes changes.
 */
export function gridSlots(): Slots {
  if (grid) return grid
  const made = slots((onScreen) => planFor(previewChoice(), backendTakes(TAKES.pictures), onScreen))
  watchTakes(made.arrange)
  watchChoice(made.arrange)
  grid = made
  return made
}
