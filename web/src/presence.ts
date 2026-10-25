// What a display says of itself, so that It knows which display the person is using: that the
// site is open here, whether it is visible, and whether the person has used it lately. An
// agent's page goes to that display when the agent names none. Nothing of what the person did
// is said: only that they did something, at most once in ten seconds.

/** How often a display whose site is visible says that it is open. */
export const OPEN_EVERY_MS = 60_000
/**
 * How long after it last said that the person used it a display says so again. What they do in
 * between is said when that time is up, so that which display was used last is known to within it.
 */
export const USED_EVERY_MS = 10_000
/** How often the site looks whether the browser says the person has just acted, which covers what they do inside a page's frame. */
const LOOK_EVERY_MS = 2000

export interface Said {
  visible: boolean
  used: boolean
}

/**
 * Says what `say` is to send whenever there is something to say: every minute while the site is
 * visible, at once when it is hidden or shown again, and when the person uses it: at once where
 * that was last said ten seconds ago or more, and otherwise once those ten seconds are up. One
 * saying at a time: what comes up while one is on its way is said when it has been answered.
 * Returns what stops it.
 *
 * A click, tap, key or wheel on the site itself is seen here. What the person does inside a
 * page's frame is not, since the frame is another origin: the browser's own word that the person
 * has just acted, which covers every frame, stands in for it, and so does the keyboard going into
 * a frame.
 */
export function presence(say: (said: Said) => Promise<unknown>, at: { document: Document; window: Window } = { document, window }): () => void {
  const { document: doc, window: win } = at
  let usedSince = false
  let toldUsedAt = Number.NEGATIVE_INFINITY
  let toldVisible: boolean | null = null
  let asking = false
  let again = false
  let stopped = false
  let later: number | undefined
  const visible = () => doc.visibilityState === 'visible'
  const tell = () => {
    if (stopped) return
    if (asking) {
      again = true
      return
    }
    const shown = visible()
    // A display that has said it is hidden has nothing more to say until it is shown again
    if (!shown && toldVisible === false) return
    const used = shown && usedSince
    usedSince = false
    asking = true
    void say({ visible: shown, used })
      .then(
        () => {
          toldVisible = shown
          if (used) toldUsedAt = Date.now()
        },
        () => {
          if (used) usedSince = true
        },
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
    usedSince = true
    const wait = toldUsedAt + USED_EVERY_MS - Date.now()
    if (wait <= 0) tell()
    else if (later === undefined)
      later = win.setTimeout(() => {
        later = undefined
        if (usedSince) tell()
      }, wait)
  }
  const intoFrame = () => {
    if (doc.activeElement?.tagName === 'IFRAME') used()
  }
  const activation = (win.navigator as { userActivation?: { isActive: boolean } }).userActivation
  const look = () => {
    if (activation?.isActive) used()
  }
  const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
  for (const kind of kinds) win.addEventListener(kind, used, { capture: true, passive: true })
  win.addEventListener('blur', intoFrame)
  doc.addEventListener('visibilitychange', tell)
  const beat = win.setInterval(() => visible() && tell(), OPEN_EVERY_MS)
  const looking = win.setInterval(look, LOOK_EVERY_MS)
  tell()
  return () => {
    stopped = true
    for (const kind of kinds) win.removeEventListener(kind, used, { capture: true })
    win.removeEventListener('blur', intoFrame)
    doc.removeEventListener('visibilitychange', tell)
    win.clearInterval(beat)
    win.clearInterval(looking)
    win.clearTimeout(later)
  }
}
