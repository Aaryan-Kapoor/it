// Fullscreen for a page that is shown. It is the site that goes fullscreen, and never the page's
// frame by itself: the whole of the site, so that It's bar stays above the page, and whatever
// the site lays over the page, a notification or a dialog among them, is still seen. A page's
// own frame cannot count on going fullscreen in every browser, since Safari holds a sandboxed
// frame to an origin that no permission names. So a page asks the site instead (mount.tsx), and
// the script It puts in the page sends the page's own requests there.
import { useSyncExternalStore } from 'react'

type Prefixed = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => void
}
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => void }

/** What a page is told when the browser would not go fullscreen. */
export const NOT_FULLSCREEN = 'The browser did not go fullscreen. It goes fullscreen only just after a click or a key in the page.'
/** How long after fullscreen ends an Escape is still taken for the one that ended it. */
const ESCAPE_MS = 500
/** How long after fullscreen ends a page's asking for it again is refused. */
const JUST_LEFT_MS = 1000

const doc = () => document as Prefixed
/** What goes fullscreen: the whole of the site. */
const whole = () => document.documentElement as PrefixedElement
/** What the browser has fullscreen now, if anything. */
const shownWhole = () => doc().fullscreenElement ?? doc().webkitFullscreenElement ?? null

/** Whether this browser can make the site fullscreen. An iPhone cannot: it makes a film fullscreen and nothing else. */
export function fullscreenAvailable(): boolean {
  const el = whole()
  return (
    Boolean(doc().fullscreenEnabled || doc().webkitFullscreenEnabled) &&
    (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function')
  )
}

/**
 * Whether It is fullscreen: the site went fullscreen and has not left it. Something that the
 * browser makes fullscreen above it, such as a film in the page's frame, leaves it so beneath.
 */
let on = shownWhole() === whole()
let endedAt = Number.NEGATIVE_INFINITY
const listeners = new Set<() => void>()
function changed(): void {
  const now = shownWhole()
  // Nothing here is fullscreen but the site itself. A page's frame that the browser made
  // fullscreen by itself, as a film's own controls can, would be drawn over It's bar, so it is
  // left at once; the script in the page asks It's fullscreen for what it wanted instead
  if (now !== null && now !== whole()) leaveTop()
  const was = on
  if (now === whole()) on = true
  else if (now === null) on = false
  if (was === on) return
  if (!on) endedAt = performance.now()
  for (const listener of [...listeners]) listener()
}
for (const kind of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(kind, changed)

/** Leaves whatever is fullscreen on top, and only that. */
function leaveTop(): void {
  const d = doc()
  try {
    if (typeof d.exitFullscreen === 'function') void Promise.resolve(d.exitFullscreen()).catch(() => {})
    else d.webkitExitFullscreen?.()
  } catch {
    // Left already, in the moment between looking and asking
  }
}

export const fullscreenOn = (): boolean => on
/**
 * Whether It left fullscreen a moment ago. A page is not made fullscreen again then: the person
 * has just left, and a page that asks again whenever It leaves would otherwise come back at once.
 */
export const fullscreenJustLeft = (): boolean => performance.now() - endedAt < JUST_LEFT_MS
/** Asks to be told whenever It goes fullscreen or leaves it, and gives back what stops that. */
export function onFullscreenChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
/** Whether It is fullscreen, drawn again whenever that changes. */
export const useFullscreen = (): boolean => useSyncExternalStore(onFullscreenChange, fullscreenOn)

/**
 * Makes the site fullscreen. A browser allows it only just after a click or a key, so this is
 * called in the same turn as the click on the bar, or as the message that a click in the page sent.
 */
export function enterFullscreen(): Promise<void> {
  if (on) return Promise.resolve()
  const el = whole()
  try {
    if (typeof el.requestFullscreen === 'function')
      return Promise.resolve(el.requestFullscreen()).then(undefined, () => {
        throw new Error(NOT_FULLSCREEN)
      })
    const older = el.webkitRequestFullscreen
    if (typeof older === 'function') return webkitEnter(() => older.call(el))
  } catch {
    return Promise.reject(new Error(NOT_FULLSCREEN))
  }
  return Promise.reject(new Error('This browser has no fullscreen.'))
}

/** An older Safari's way, which answers by an event and not by a promise. */
function webkitEnter(ask: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      document.removeEventListener('webkitfullscreenchange', went)
      document.removeEventListener('webkitfullscreenerror', refused)
    }
    const went = () => {
      done()
      resolve()
    }
    const refused = () => {
      done()
      reject(new Error(NOT_FULLSCREEN))
    }
    // A browser that says neither is taken to have refused, so that whoever asked is answered
    const timer = setTimeout(refused, 3000)
    document.addEventListener('webkitfullscreenchange', went)
    document.addEventListener('webkitfullscreenerror', refused)
    ask()
  })
}

/** What a page is told when the browser would not leave fullscreen. */
export const STILL_FULLSCREEN = 'The browser did not leave fullscreen.'

/** Waits until an older Safari says that fullscreen changed, or for so long, whichever comes first. */
const webkitChange = (ms: number) =>
  new Promise<boolean>((resolve) => {
    // Whether the browser said that fullscreen changed: an error, or nothing said in time, is not that
    const done = (heard: boolean) => () => {
      clearTimeout(timer)
      document.removeEventListener('webkitfullscreenchange', changed)
      document.removeEventListener('webkitfullscreenerror', failed)
      resolve(heard)
    }
    const changed = done(true)
    const failed = done(false)
    const timer = setTimeout(failed, ms)
    document.addEventListener('webkitfullscreenchange', changed)
    document.addEventListener('webkitfullscreenerror', failed)
  })

/**
 * Leaves It's fullscreen, where It is fullscreen, and does nothing where it is not. A browser
 * leaves one thing at a time, from the top: something it made fullscreen above It, such as a
 * film in the page's frame, is left first, and It's own last. Nothing made fullscreen after It's
 * own was left is left as well. This fails only where the browser leaves nothing however often
 * it is asked.
 */
export async function leaveFullscreen(): Promise<void> {
  if (!on) return
  const d = doc()
  for (let times = 0; times < 4; times++) {
    const top = shownWhole()
    if (top === null) return
    let refused = false
    try {
      if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
      else if (typeof d.webkitExitFullscreen === 'function') {
        const changed = webkitChange(1000)
        d.webkitExitFullscreen()
        // An older Safari refuses by an error, or by saying nothing at all
        if (!(await changed)) refused = true
      } else return
    } catch {
      // Left already, in the moment between looking and asking; or refused
      refused = true
    }
    if (top === whole()) {
      // Refused, with the site still fullscreen: it is asked again, and neither the page nor the bar
      // is told that It left. Otherwise It's own fullscreen is left, and whatever was made
      // fullscreen after that is not left as well
      if (refused && shownWhole() === whole()) continue
      return
    }
  }
  throw new Error(STILL_FULLSCREEN)
}

/**
 * Whether an Escape pressed now is the one that leaves fullscreen. The browser leaves
 * fullscreen on Escape, and some browsers still give the key to the site, just before or just
 * after, where it would otherwise take the person off the page as well.
 */
export const escapeLeavesFullscreen = (): boolean => on || shownWhole() !== null || performance.now() - endedAt < ESCAPE_MS
