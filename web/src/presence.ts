// What a tab of a display says of itself, so that It knows which display the person is using:
// whether the site is visible in this tab, whether the person used it a moment ago, and the page
// it shows. An agent's page goes to that display when the agent names none. Nothing of what the
// person did is said: only that they did something, at most once in ten seconds.

import { askClock, onClockLearned, reportClock } from './lib'

/** How often a tab whose site is visible says so. */
export const VISIBLE_EVERY_MS = 60_000
/**
 * How long after it last said that the person used it a tab says so again. What they do in
 * between is said when that time is up, so that which display was used last is known to within it.
 */
export const USED_EVERY_MS = 10_000
/** How often the site looks whether the browser says the person has just acted, which covers what they do inside a page's frame. */
export const LOOK_EVERY_MS = 2000
/**
 * How long, at the most, a browser goes on saying that the person has just acted after one click,
 * tap or key: five seconds in Chromium, Firefox and Safari, and a second more here for the timers'
 * leeway. Once this long has passed since a use that was counted, the browser saying so again
 * means the person has acted since.
 */
export const ACTIVATION_MS = 6000

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
   * When they last did, by the backend's clock as this browser has learned it, said with `used`
   * where the backend takes it: a use that waited for the ten seconds to be up is then kept as of
   * when it happened, and not as of when it was said.
   */
  usedAt?: number
  /**
   * When this report was made, by the backend's clock as this browser has learned it. The
   * connection holds a call through an outage and sends it again as it was, so this is how the
   * backend tells a report made a moment ago from one that waited, and keeps the second as of then.
   * Left out where the browser does not know that time closely enough, and then `used` is too.
   */
  observedAt?: number
}

/** The backend's clock, as a reporter goes by it: its time where it is known closely enough, a way to ask for it at once, and word of when it is learned. */
export interface ReportClock {
  at: () => number | undefined
  ask: () => void
  learned: (then: () => void) => () => void
}
export const backendClock: ReportClock = { at: reportClock, ask: askClock, learned: onClockLearned }

/**
 * Sends a report as the last thing a tab does, as a call of its own that the browser keeps going
 * after the tab is closed (\`keepalive\`), to the backend's address for calling a function, which
 * the site's own address passes on. The connection the site keeps open seldom gets a report out
 * before a closing tab is gone, and a tab that is closed would then be taken for open until what it
 * said last ran out. Nothing is sent without the token this browser holds now.
 */
export function lastWord(report: Report, about: { key: string; epoch: number; expectedSession: string }, token: string | null): void {
  if (!token) return
  try {
    void fetch('/api/mutation', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: 'displays:report', args: { ...about, ...report }, format: 'json' }),
    }).catch(() => {})
  } catch {}
}

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
 * it, and is said again, within those ten seconds, until the backend answers that it took it.
 *
 * A report says when it was made, by the backend's clock, only where this browser knows that
 * clock closely enough (`clock`). Where it does not, as before the first heartbeat is answered and
 * after the machine slept, the report says no time and no use, the backend's clock is asked for at
 * once, and once it is learned a report is made again with the use that was kept. A use says when
 * it happened as well (`usedAt`), where the backend takes that (`takesUsedAt`), so that one said
 * once the ten seconds are up is not taken for a use at the moment it was said.
 *
 * Nothing is sent while `takes()` is false, which is asked each time: a backend whose functions
 * are older than the site has nowhere to take a report, and one that is updated while the site is
 * open names it from then on.
 *
 * A click, tap, key or wheel on the site itself is seen here. What the person does inside a
 * page's frame is not, since the frame is another origin: the browser's own word that the person
 * has just acted, which covers every frame, stands in for it, and so does the keyboard going into
 * a frame. The browser keeps saying that for a few seconds after a click on the site too, and
 * that is not counted as another use.
 */
export function startReports(
  send: (report: Report) => Promise<unknown>,
  takes: () => boolean,
  at: {
    document: Document
    window: Window
    now: () => number
    wall?: () => number
    clock?: ReportClock
    last?: (report: Report) => void
    /** Whether the backend takes when a use happened (`usedAt`), asked each time a use is said. */
    takesUsedAt?: () => boolean
  } = {
    document,
    window,
    now: () => performance.now(),
    clock: backendClock,
  },
): () => void {
  const { document: doc, window: win, now, clock } = at
  const wall = at.wall ?? (() => Date.now())
  /** Whether the last report could say no time, so that one is made again once the clock is learned. */
  let untimed = false
  const tab = tabId()
  let sequence = 0
  /**
   * When this tab last learned that the person used the site here, by a clock that only goes
   * forward, which is what a use is a use of a moment ago by.
   */
  let usedAt = Number.NEGATIVE_INFINITY
  /**
   * How long before it was learned that use can have happened: nothing for one seen on the site,
   * and up to a few seconds for one learned from the browser's word that the person has just
   * acted. It is said that much earlier, and is still a use of a moment ago for the ten seconds
   * after it was learned, so that a use learned late is not too old by the time it is said.
   */
  let usedLead = 0
  /**
   * The same, by the browser's own clock. Where the machine sleeps, the clock that only goes
   * forward may stand still, and a use from before the sleep would look as if it were a moment
   * ago. So a use is as old as the longer of the two says, where the browser's clock went forward:
   * one that was set back says nothing of how long ago it was. Once either says it is too old to be
   * a use of a moment ago, it is that for good (`spent`), whatever a clock is set to after, and
   * only another use is said.
   */
  let usedWallAt = Number.NEGATIVE_INFINITY
  let spent = true
  /** How long ago the last use was, by whichever of the two clocks says it was longer. */
  const age = () => Math.max(now() - usedAt, wall() - usedWallAt, 0)
  const fresh = () => {
    if (!spent && age() >= USED_EVERY_MS) spent = true
    return !spent
  }
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
    const observedAt = clock?.at()
    untimed = clock !== undefined && observedAt === undefined
    if (untimed) clock!.ask()
    const used = !untimed && shown && usedAt > saidUseOf && fresh()
    const what = closing ? { phase: 'none' as const } : page
    // When the use was, as long ago as the clock that says longer has it, so never later than it was
    const when = used && observedAt !== undefined && at.takesUsedAt?.() ? { usedAt: Math.floor(observedAt - age() - usedLead) } : {}
    return {
      tab,
      sequence: ++sequence,
      ...what,
      visible: shown,
      ...(used ? { used: true as const, ...when } : {}),
      ...(observedAt !== undefined ? { observedAt } : {}),
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
        (answer) => {
          if (!r.used) return
          // Said, but not taken, as by a backend whose clock this one had wrong: kept, and said
          // again once the clock is learned afresh, while it is still a use of a moment ago
          if ((answer as { used?: unknown } | undefined)?.used !== true) return clock?.ask()
          saidUseOf = use
          toldUsedAt = now()
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
  /** The person used the site here, now or at `when` a moment ago, by the clock that only goes forward. */
  const used = (when?: number, t = now()) => {
    if (!visible()) return
    const then = Math.min(when ?? t, t)
    // A use from before the one kept says nothing new
    if (!spent && then <= usedAt - usedLead) return
    usedAt = t
    usedWallAt = wall()
    usedLead = t - then
    spent = false
    const wait = toldUsedAt + USED_EVERY_MS - t
    if (wait <= 0) tell()
    else if (later === undefined)
      later = win.setTimeout(() => {
        later = undefined
        tell()
      }, wait)
  }
  /**
   * Up to when, by the clock that only goes forward, every time the person acted is already
   * counted: as of each click, tap, key or wheel seen on the site, the keyboard going into a frame,
   * and each time the browser's word that the person has just acted was counted.
   */
  let counted = Number.NEGATIVE_INFINITY
  /** A use seen on the site itself, which is counted at once and as of then. */
  const seen = () => {
    counted = now()
    used()
  }
  /** The end of a tap or a click, which the browser counts as acting, and which the use seen as it began has counted. */
  const ended = () => {
    counted = now()
  }
  const intoFrame = () => {
    if (doc.activeElement?.tagName !== 'IFRAME') return
    counted = now()
    used()
  }
  const activation = (win.navigator as { userActivation?: { isActive: boolean } }).userActivation
  // The browser goes on saying that the person has just acted for a few seconds after they did, so
  // its word is counted only where it means something done since the last use counted: where it
  // did not say so when last asked, or where it says so longer after that use than it would for
  // that use alone. What was done is then counted as of the earliest moment it can have been, so
  // that one click is one use, and never a use later than it was
  let lookedAt = now()
  let wasActive = activation?.isActive === true
  const look = () => {
    const t = now()
    const active = activation?.isActive === true
    if (active) {
      const since = Math.max(t - ACTIVATION_MS, wasActive ? Number.NEGATIVE_INFINITY : lookedAt)
      if (since >= counted) {
        counted = t
        used(since, t)
      }
    }
    wasActive = active
    lookedAt = t
  }
  // A tab that is closed shows nothing any more: said at once, whatever else is on its way
  const closing = () => {
    if (stopped) return
    const r = report(true)
    if (!r) return
    void send(r).catch(() => {})
    // The connection seldom gets it out before the tab is gone: it goes the way a closing tab's
    // last word does as well. Where both arrive, the second is the same report, and is ignored
    at.last?.(r)
  }
  const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
  const ends = ['pointerup', 'touchend'] as const
  for (const kind of kinds) win.addEventListener(kind, seen, { capture: true, passive: true })
  for (const kind of ends) win.addEventListener(kind, ended, { capture: true, passive: true })
  win.addEventListener('blur', intoFrame)
  doc.addEventListener('visibilitychange', tell)
  win.addEventListener('pagehide', closing)
  win.addEventListener('pageshow', tell)
  win.addEventListener('online', tell)
  pageChanged.add(tell)
  // Learned afresh, the clock lets a report say when it was made, and the use that was kept with it
  const unlearn = clock?.learned(() => {
    if (untimed || (usedAt > saidUseOf && fresh())) tell()
  })
  const beat = win.setInterval(() => visible() && tell(), VISIBLE_EVERY_MS)
  const looking = win.setInterval(look, LOOK_EVERY_MS)
  tell()
  return () => {
    closing()
    stopped = true
    for (const kind of kinds) win.removeEventListener(kind, seen, { capture: true })
    for (const kind of ends) win.removeEventListener(kind, ended, { capture: true })
    win.removeEventListener('blur', intoFrame)
    doc.removeEventListener('visibilitychange', tell)
    win.removeEventListener('pagehide', closing)
    win.removeEventListener('pageshow', tell)
    win.removeEventListener('online', tell)
    pageChanged.delete(tell)
    unlearn?.()
    win.clearInterval(beat)
    win.clearInterval(looking)
    win.clearTimeout(later)
  }
}
