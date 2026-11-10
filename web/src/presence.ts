// What a tab of a display says of itself, so that It knows which display the person is using:
// whether the site is visible in this tab, whether the person used it a moment ago, and the page
// it shows. An agent's page goes to that display when the agent names none. Nothing of what the
// person did is said: only that they did something, at most once in ten seconds.

import { backendNow, serverNow } from './lib'

/** How often a tab whose site is visible says so. */
export const VISIBLE_EVERY_MS = 60_000
/**
 * How long after it last said that the person used it a tab says so again. What they do in
 * between is said when that time is up, so that which display was used last is known to within it.
 */
export const USED_EVERY_MS = 10_000
/** How often the site looks whether the browser says the person has just acted, which covers what they do inside a page's frame. */
const LOOK_EVERY_MS = 2000

/** Where the page a tab shows has got to: none shown, loading, shown, or failed to show. */
export type PagePhase = 'none' | 'loading' | 'shown' | 'failed'

/**
 * The page this tab shows, as its showing (the mount it made) and how far it has got. Said by the
 * view that shows one page whole, and by nothing else: a card's picture on the grid is no page
 * shown. A page in a frame has no way to set it.
 */
let page: { phase: PagePhase; mountId?: string } = { phase: 'none' }
const pageChanged = new Set<() => void>()
export function reportPage(phase: PagePhase, mountId?: string): void {
  const next = phase === 'none' || mountId === undefined ? { phase: 'none' as const } : { phase, mountId }
  if (next.phase === page.phase && next.mountId === page.mountId) return
  page = next
  for (const changed of pageChanged) changed()
}

export interface Report {
  /** This tab's own id, made afresh each time the site is loaded. */
  tab: string
  /** Counted up by one with each report of this tab, so that one that arrives late is not taken for the newest. */
  sequence: number
  phase: PagePhase
  /** The showing of the page this tab shows, where it shows one. */
  mountId?: string
  visible: boolean
  /** That the person clicked, tapped, typed or scrolled here within the last ten seconds. */
  used?: true
  /**
   * When this report was made, by the backend's clock as this browser has learned it. The
   * connection holds a call through an outage and sends it again as it was, so this is how the
   * backend tells a report made a moment ago from one that waited, and keeps the second as of then.
   */
  observedAt?: number
}

/** The backend's time now, as closely as this browser knows it. */
const backendTime = (): number => backendNow()?.at ?? serverNow()

/** 16 random bytes, in hex: made with `getRandomValues`, which a site reached over plain http has too, and `randomUUID` not. */
export const tabId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Says what `send` is to send, whenever there is something to say: every minute while the site is
 * visible, at once when it is hidden or shown again or the page it shows changes, once more when
 * the tab is closed, and when
 * the person uses it, at once where that was last said ten seconds ago or more and otherwise once
 * those ten seconds are up. Returns what stops it.
 *
 * One report at a time: what comes up while one is on its way is said, as it stands then, once
 * that one is answered, so that a connection that was down sends one report when it is back and
 * not every one it missed. A report that failed is not sent again by itself: the next is sent
 * when there is something to say, or at the next minute. A use is said only within ten seconds of
 * it, and a use said once is not said again.
 *
 * Nothing is sent while `takes()` is false, which is asked each time: a backend whose functions
 * are older than the site has nowhere to take a report, and one that is updated while the site is
 * open names it from then on.
 *
 * A click, tap, key or wheel on the site itself is seen here. What the person does inside a
 * page's frame is not, since the frame is another origin: the browser's own word that the person
 * has just acted, which covers every frame, stands in for it, and so does the keyboard going into
 * a frame.
 */
export function startReports(
  send: (report: Report) => Promise<unknown>,
  takes: () => boolean,
  at: { document: Document; window: Window; now: () => number; observed?: () => number } = {
    document,
    window,
    now: () => performance.now(),
    observed: backendTime,
  },
): () => void {
  const { document: doc, window: win, now, observed } = at
  const tab = tabId()
  let sequence = 0
  /** When the person last used the site here, by a clock that only goes forward, and when the last use that was said happened. */
  let usedAt = Number.NEGATIVE_INFINITY
  let saidUseOf = Number.NEGATIVE_INFINITY
  let toldUsedAt = Number.NEGATIVE_INFINITY
  let asking = false
  let again = false
  let stopped = false
  let later: number | undefined
  const visible = () => doc.visibilityState === 'visible'
  const report = (closing = false): Report | null => {
    if (!takes()) return null
    const shown = !closing && visible()
    const used = shown && usedAt > saidUseOf && now() - usedAt < USED_EVERY_MS
    const what = closing ? { phase: 'none' as const } : page
    return {
      tab,
      sequence: ++sequence,
      ...what,
      visible: shown,
      ...(used ? { used: true as const } : {}),
      ...(observed ? { observedAt: observed() } : {}),
    }
  }
  const tell = () => {
    if (stopped) return
    if (asking) {
      again = true
      return
    }
    const r = report()
    if (!r) return
    const use = usedAt
    asking = true
    void send(r)
      .then(
        () => {
          if (r.used) {
            saidUseOf = use
            toldUsedAt = now()
          }
        },
        () => {},
      )
      .finally(() => {
        asking = false
        if (again) {
          again = false
          tell()
        }
      })
  }
  const used = () => {
    if (!visible()) return
    usedAt = now()
    const wait = toldUsedAt + USED_EVERY_MS - usedAt
    if (wait <= 0) tell()
    else if (later === undefined)
      later = win.setTimeout(() => {
        later = undefined
        tell()
      }, wait)
  }
  const intoFrame = () => {
    if (doc.activeElement?.tagName === 'IFRAME') used()
  }
  const activation = (win.navigator as { userActivation?: { isActive: boolean } }).userActivation
  const look = () => {
    if (activation?.isActive) used()
  }
  // A tab that is closed shows nothing any more: said at once, whatever else is on its way
  const closing = () => {
    if (stopped) return
    const r = report(true)
    if (r) void send(r).catch(() => {})
  }
  const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
  for (const kind of kinds) win.addEventListener(kind, used, { capture: true, passive: true })
  win.addEventListener('blur', intoFrame)
  doc.addEventListener('visibilitychange', tell)
  win.addEventListener('pagehide', closing)
  win.addEventListener('pageshow', tell)
  win.addEventListener('online', tell)
  pageChanged.add(tell)
  const beat = win.setInterval(() => visible() && tell(), VISIBLE_EVERY_MS)
  const looking = win.setInterval(look, LOOK_EVERY_MS)
  tell()
  return () => {
    closing()
    stopped = true
    for (const kind of kinds) win.removeEventListener(kind, used, { capture: true })
    win.removeEventListener('blur', intoFrame)
    doc.removeEventListener('visibilitychange', tell)
    win.removeEventListener('pagehide', closing)
    win.removeEventListener('pageshow', tell)
    win.removeEventListener('online', tell)
    pageChanged.delete(tell)
    win.clearInterval(beat)
    win.clearInterval(looking)
    win.clearTimeout(later)
  }
}
