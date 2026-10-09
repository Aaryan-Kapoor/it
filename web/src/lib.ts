// Small things the whole site shares: the backend's functions, this browser's display key,
// where a page is shown, the address bar, and how a refusal from the backend reads.
import { ConvexError } from 'convex/values'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export { api } from '../../convex/_generated/api'
export type { Id } from '../../convex/_generated/dataModel'

// ---------- this display ----------

const DISPLAY = 'it.display'
const REGISTERED = 'it.display.session'
/**
 * What tells one registered browser from another. It is a selector, not a credential: every
 * request is authorized by the session this browser is paired under, and the backend checks
 * the display is the person's own.
 */
export function displayKey(): string {
  let key = localStorage.getItem(DISPLAY)
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    localStorage.setItem(DISPLAY, key)
  }
  return key
}

/** Forgets which display this browser was, so that it registers afresh the next time it is paired. */
export const forgetDisplayKey = () => {
  localStorage.removeItem(DISPLAY)
  localStorage.removeItem(REGISTERED)
}

/** Notes the session under which this browser last registered as the display it is. */
export const noteRegistered = (session: string) => localStorage.setItem(REGISTERED, session)
/**
 * Whether this browser has been paired again since it last registered as the display it is. A
 * display the person forgot does not come back by itself, under the session it had. Pairing the
 * browser again is the person bringing it back, and it then starts afresh as a new display.
 */
export const pairedSinceRegistering = (session: string): boolean => localStorage.getItem(REGISTERED) !== session

// While a browser is on its way out (signing out, or told it was forgotten) it must not register
// itself as a display again in the moment before its session ends.
let leaving = false
export const startLeaving = () => {
  leaving = true
}
export const doneLeaving = () => {
  leaving = false
}
export const isLeaving = () => leaving

/** Whether a name means only the machine a browser is itself on, so that no other screen could open it. */
const onlyThisMachine = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]'

/**
 * The address another screen opens to pair itself with a code: the site as this browser reached
 * it, with the code after the `#`, where it is sent to nobody. Nothing, when this browser
 * reached the site by a name that only means this machine: another screen cannot open that.
 */
export function pairingAddress(code: string, at: { origin: string; hostname: string } = location): string | null {
  return onlyThisMachine(at.hostname) ? null : `${at.origin}/pair#${encodeURIComponent(code)}`
}

// ---------- letting go of what this browser keeps ----------

/** What the name of everything the site keeps in this browser begins with. */
const KEPT = 'it.'
/** Where the id of the person this browser was last paired for is kept. Everything else the site keeps here is kept for them. */
const PERSON = 'it.person'
/** What a tab that lets go of everything writes, and at once removes, so that the browser tells its other tabs for whom. */
const LET_GO = 'it.letgo'
/**
 * Where the names of sessions this browser held, and whose cookies are still to be cleared, are
 * kept (session.ts). It is the one thing of the site's that a letting go leaves: a session's
 * cookie is out of a script's reach, the backend clears one only for a browser that names its
 * session, and a cookie can be put back by an answer that was on its way when it was cleared.
 * A name is no secret, opens nothing, and says nothing of whose the session was.
 */
export const COOKIES = 'it.cookies'

/** The person this browser was last paired for, by their id, or nobody. */
export const keptFor = (): string | null => {
  try {
    return localStorage.getItem(PERSON)
  } catch {
    return null
  }
}

// How often this tab has let go of what the site keeps: of everything, and of what was one
// person's. Something that was under way for a person when it did, and would keep a thing here
// once it ends, notes the count when it begins and keeps nothing if the count has moved. And
// nothing is begun for a person whose things were let go of: a tab may go on taking itself for
// theirs a moment longer than the browser is.
let everything = 0
const lettings = new Map<string, number>()
const gone = new Set<string>()
const tellers = new Set<(person: string | null, whole: boolean) => void>()
/** How many times this tab has let go of what the site keeps for this person, whether theirs alone or everything. */
export const timesLetGo = (person: string): number => everything + (lettings.get(person) ?? 0)
/** Whether what was kept for this person has been let go of, so that nothing more is kept for them. */
export const letGoOf = (person: string): boolean => gone.has(person)
/**
 * Calls `fn` each time what the site keeps is let go of, for whatever holds some of it in the
 * tab's memory: with whose it was, and whether that was everything here or only what was theirs.
 */
export const whenLetGo = (fn: (person: string | null, whole: boolean) => void): void => void tellers.add(fn)

/** The browser is paired for this person, on the backend's own word: what it keeps from now on is kept for them. */
export function keepFor(person: string): void {
  gone.delete(person)
  // Whatever was erased from here before, a browser that is paired has nothing to say of it
  erased = false
  try {
    if (localStorage.getItem(PERSON) !== person) localStorage.setItem(PERSON, person)
  } catch {}
}

/** Removes what the site keeps in one of the browser's two stores: all of it, or what `only` picks. */
function emptied(store: Storage, only: (name: string) => boolean = () => true): void {
  const names: string[] = []
  for (let i = 0; i < store.length; i++) names.push(store.key(i) ?? '')
  for (const name of names) if (name.startsWith(KEPT) && name !== COOKIES && only(name)) store.removeItem(name)
}
/** What is kept under a name that has a person's id as one of its parts, which is how a thing kept for one person among others is told. */
const namedFor =
  (person: string | null) =>
  (name: string): boolean =>
    person !== null && name.split('.').includes(person)

/**
 * Whether everything the site keeps in this browser is this person's to let go of: the browser
 * is kept for them, or for nobody. Where it has been paired for somebody else since, what is
 * here is that person's, and only what is named for the one let go of is theirs. Word that a
 * person's things are to go can come late: an erasing's answer that was held up, or another
 * tab's saying so, may arrive after the browser has been set up and paired anew.
 */
const allTheirs = (person: string | null): boolean => {
  const now = keptFor()
  return now === null || now === person
}

/**
 * What each tab does for itself when something is let go of, whichever tab began it: what it
 * keeps apart from the others goes, and what it has under way for that person keeps nothing.
 * `whole` says that everything here was theirs.
 */
function letGoHere(person: string | null, whole: boolean): void {
  if (whole) everything++
  else if (person !== null) lettings.set(person, (lettings.get(person) ?? 0) + 1)
  if (person !== null) gone.add(person)
  emptied(sessionStorage, whole ? undefined : namedFor(person))
  for (const fn of tellers) fn(person, whole)
}

/**
 * Lets go of what the site keeps in this browser for a person: which display it is, what was
 * done on a page and has not been sent yet, a sign-out still owed, and what the person chose
 * here. This is done when everything It held has been erased: none of it is of use then, and
 * what was done on a page is the person's own. `person` is whose it was, or nobody when the
 * browser finds itself keeping things for nobody.
 *
 * It is everything, while the browser is kept for that person or for nobody. Once the browser
 * has been paired for somebody else, what is here is theirs, and only what is named for the
 * person let go of is removed.
 *
 * Nothing that was under way for that person writes any of it back, in this tab or in another.
 * Every other tab of the browser is told for whom, lets go of what it keeps by itself, and
 * removes again whatever it wrote before it heard. The session's cookie is not the site's to
 * remove: the backend clears it when the browser names that session, and the names of the
 * sessions whose cookies are still to be cleared are all that is left here (session.ts).
 */
export function forgetAll(person: string | null): void {
  const whole = allTheirs(person)
  letGoHere(person, whole)
  emptied(localStorage, whole ? undefined : namedFor(person))
  if (person === null) return
  try {
    localStorage.setItem(LET_GO, person)
    localStorage.removeItem(LET_GO)
  } catch {}
}

/**
 * What a tab does when the browser says that another tab changed something the site keeps. If
 * that was the other tab saying it had let go of a person's things, this one does the same for
 * itself. What the browser keeps for all its tabs went in the tab that said so, and whatever
 * this tab wrote there before it heard goes now: all of it while the browser is kept for
 * nobody, and what is named for that person where it has been paired for another since, as
 * with what the tab keeps to itself. True when that is what was said.
 */
export function letGoElsewhere(e: StorageEvent): boolean {
  if (e.key !== LET_GO || !e.newValue) return false
  const person = e.newValue
  const whole = allTheirs(person)
  letGoHere(person, whole)
  emptied(localStorage, whole ? undefined : namedFor(person))
  return true
}

// That this tab has just had everything erased, for the screen it then shows to say so. Kept in
// the tab's memory and nowhere else: it is said once, to the person who asked for it.
let erased = false
export const noteErased = () => {
  erased = true
}
export const wasErasedHere = () => erased

// ---------- starting again ----------

let reloading = false
/**
 * Loads the site afresh, once whatever serves it answers. The site and the backend come from
 * the one program on the person's machine, and that program may be stopped, or starting. A
 * reload asked for while it is away leaves the browser's own error page, and a display nobody
 * is standing at would stay on it. So it is asked first, and asked again until it answers.
 */
export function reloadWhenThere(): void {
  if (reloading) return
  reloading = true
  const attempt = () =>
    fetch('/', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15_000) }).then(
      (r) => (r.ok ? location.reload() : void setTimeout(attempt, 5000)),
      () => void setTimeout(attempt, 5000),
    )
  void attempt()
}

// ---------- signing a display out when the backend could not be told at the time ----------

const SIGN_OUT = 'it.signout'
const PENDING = 'it.signout.pending.'
/** The token that signs this display out, kept while the browser is paired, with whose it is. One that arrives for a person whose things were let go of is not kept. */
export const keepSignOutToken = (token: string, user: string, raisesTo: number, display: string) => {
  if (!letGoOf(user)) localStorage.setItem(SIGN_OUT, JSON.stringify({ user, token, raisesTo, display }))
}
function keptSignOutToken(): { user: string; token: string; raisesTo: number; display: string } | null {
  try {
    const kept = JSON.parse(localStorage.getItem(SIGN_OUT) ?? 'null') as { user?: unknown; token?: unknown; raisesTo?: unknown; display?: unknown } | null
    return kept && typeof kept.user === 'string' && typeof kept.token === 'string' && typeof kept.raisesTo === 'number' && typeof kept.display === 'string'
      ? { user: kept.user, token: kept.token, raisesTo: kept.raisesTo, display: kept.display }
      : null
  } catch {
    return null
  }
}
/**
 * A token is kept for this person that does nothing any more for the display this browser
 * is now: the display has reached the number the token raises to, or the token is for a display
 * record that has since been replaced by another.
 */
export function signOutTokenSpent(user: string, display: { id: string; epoch: number }): boolean {
  const kept = keptSignOutToken()
  return kept !== null && kept.user === user && (kept.display !== display.id || kept.raisesTo <= display.epoch)
}
/**
 * Whether there is a token to leave behind for this person that would still do something. One
 * fetched for someone else does not count, and neither does one that raises the display's
 * number to where it already is: the display has been signed out since by some other route,
 * and the token is spent.
 */
export function hasSignOutToken(user: string, display: { id: string; epoch: number } | null | undefined): boolean {
  const kept = keptSignOutToken()
  return kept !== null && kept.user === user && (!display || (kept.display === display.id && kept.raisesTo > display.epoch))
}

/**
 * Signing out went ahead without the backend's confirmation: the token is put where the next
 * visit will present it. Each sign-out that is owed is kept by itself, so that one person's
 * never replaces, or is cleared away with, another's on the same browser. False when there was
 * no token to leave behind.
 */
export function signOutLater(): boolean {
  const kept = keptSignOutToken()
  localStorage.removeItem(SIGN_OUT)
  if (!kept) return false
  // Named by random bytes and not by `randomUUID`, which a browser offers only to a site it
  // counts as secure: signing out has to work wherever the site is being shown
  const name = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  localStorage.setItem(`${PENDING}${name}`, kept.token)
  return true
}
export const signOutConfirmed = () => localStorage.removeItem(SIGN_OUT)
/**
 * Presents every sign-out that is still owed. The browser need not be paired: a token says
 * which display, and does nothing else. Each is kept until the backend has taken it, and only
 * that one is removed.
 */
export async function presentPendingSignOut(): Promise<void> {
  const owed: [string, string][] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PENDING)) owed.push([key, localStorage.getItem(key) ?? ''])
  }
  for (const [key, token] of owed) {
    try {
      const r = await fetch('/display/signout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      // Taken, or refused for good (it is not a token the backend knows any more): either way
      // it is done with. Trouble on the backend's side is neither: it is presented again.
      if (r.ok || r.status === 401 || r.status === 400) localStorage.removeItem(key)
    } catch {
      // No connection yet: it is presented again the next time
    }
  }
}

// ---------- the backend's clock ----------

// What is "recent" is judged against times the backend recorded, so it is judged by the
// backend's clock: this browser's own may be minutes out. The difference is learned from each
// heartbeat's answer.
let skew = 0
export const learnClock = (serverNow: number) => {
  skew = Date.now() - serverNow
}
export const serverNow = () => Date.now() - skew

// ---------- the address bar ----------

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  window.addEventListener('popstate', fn)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('popstate', fn)
  }
}
export function navigate(path: string, replace = false): void {
  if (path === location.pathname) return
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
  for (const fn of listeners) fn()
}
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname)

// ---------- refusals ----------

export interface Refusal {
  code: string
  message: string
  /** Set when a display's key is refused because the person removed that display. */
  forgotten?: boolean
}
/**
 * Something went wrong that the person is told little or nothing about, and that someone
 * helping them would need to know. Said in the browser's console and nowhere else: a name for
 * what happened and a code, never what a page sent or anything that identifies a person.
 */
export function note(what: string, code?: string | number): void {
  console.warn('[It]', what, code ?? '')
}

export function refusal(err: unknown): Refusal {
  if (err instanceof ConvexError) {
    let data: unknown = err.data
    for (let i = 0; i < 3 && typeof data === 'string'; i++) {
      try {
        data = JSON.parse(data)
      } catch {
        break
      }
    }
    if (data && typeof data === 'object' && 'code' in data) return data as Refusal
  }
  return { code: 'error', message: 'Something went wrong. Try again.' }
}

// ---------- time ----------

export function ago(at: number, now = serverNow()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`
  return new Date(at).toLocaleDateString()
}
/** Re-renders now and then, so "3 min ago" stays true. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

/** A value kept in this browser, such as a reminder that was dismissed. */
export function useStored(key: string, initial = ''): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial)
  const set = useCallback(
    (v: string) => {
      localStorage.setItem(key, v)
      setValue(v)
    },
    [key],
  )
  return [value, set]
}

/** Each agent app as a person knows it, by the name It has for it. */
const AGENTS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes', opencode: 'OpenCode', pi: 'Pi' }
export const agentName = (a: string | null) => (a ? (AGENTS[a] ?? a) : null)
