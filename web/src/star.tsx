import { useLayoutEffect, useRef, useState } from 'react'

/** How many pages an It holds before its site asks, once, for a star on GitHub. */
export const STAR_AFTER = 5
/** Where the ask leads: the repository alone, with nothing of this It in the address. */
export const STAR_URL = 'https://github.com/Aaryan-Kapoor/it'
/** What the ask says. */
export const STAR_WORDS = 'Enjoying It? Star it on GitHub'
/** Where this browser remembers that the ask was answered, by a click or by being put away. */
const KEY = 'it.starAsked'

/** Whether this browser has answered the ask. A browser that keeps nothing is taken to have answered, so it is never asked again and again. */
function answered(): boolean {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return true
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // A browser that keeps nothing still lets the ask go for as long as the site is open
  }
}

export interface Where {
  /** How many pages the It has, or nothing while they are not known yet. */
  pages: number | undefined
  /** Whether this browser is the owner's. A screen, such as a television, is never asked. */
  owner: boolean
  /** Whether this display is locked to a page. */
  locked: boolean
  /** The address being looked at: only the grid of pages asks. */
  path: string
  /** Whether a code in the address is being paired, offered or traded. */
  pairing: boolean
  /** Whether the connection to It is up: while it is not, the bar says so, and nothing sits beside it. */
  live: boolean
}

/** Whether the ask may be shown here, leaving aside whether it was answered. */
export function starWanted(w: Where): boolean {
  return w.owner && !w.locked && !w.pairing && w.live && w.path === '/' && (w.pages ?? 0) >= STAR_AFTER
}

/**
 * The one quiet line in the bar that asks for a star on GitHub, and the button that puts it away
 * for good. It takes only the room the bar has to spare, before the search, and where that room
 * is too small for it, it is hidden, and nothing else in the bar moves for it.
 */
export function StarAsk(where: Where) {
  const [done, setDone] = useState(answered)
  const [fits, setFits] = useState(true)
  const room = useRef<HTMLDivElement>(null)
  const ask = useRef<HTMLSpanElement>(null)
  const shown = !done && starWanted(where)
  useLayoutEffect(() => {
    const r = room.current
    const a = ask.current
    if (!shown || !r || !a || typeof ResizeObserver === 'undefined') return
    const measure = () => setFits(a.offsetWidth <= r.clientWidth)
    const watch = new ResizeObserver(measure)
    watch.observe(r)
    watch.observe(a)
    measure()
    return () => watch.disconnect()
  }, [shown])
  if (!shown) return null
  const finish = () => {
    remember()
    // Put away once the click is over, so that the link it was on still opens
    setTimeout(() => setDone(true))
  }
  return (
    <div className="star-room" ref={room}>
      {/* Hidden, where it does not fit, from sight, from the keyboard and from a screen reader alike */}
      <span className="chip-pair star-ask" ref={ask} style={fits ? undefined : { visibility: 'hidden' }}>
        <a className="chip ask" href={STAR_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={finish}>
          {STAR_WORDS}
        </a>
        <button type="button" className="chip x" aria-label="No thanks, do not ask for a star again" title="Do not ask again" onClick={finish}>
          ×
        </button>
      </span>
    </div>
  )
}
