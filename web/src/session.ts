// Whether this browser is paired with It, and what the rest of the site needs from that: who
// the person is, which session this is and what it may do, the token the live connection shows
// the backend, pairing with a code, and signing out.
//
// A browser is paired by redeeming a code, which leaves a cookie that no script can read. So
// the one way to know whether this browser is paired is to ask for a token: an answer means it
// is, and a refusal means it is not.
//
// A session's cookie is the only kind of cookie there is. The site keeps nothing in a cookie
// that a script could read: a browser keeps one set of cookies for a host name whatever the
// port, so whatever else is served under that name at another port, by any program on the
// machine, could read it. A page an agent made could not, since it is shown as a sandboxed
// document and has no cookies at all. What the site remembers is in the browser's storage,
// which is kept apart for each port.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { COOKIES, forgetAll, keepFor, keptFor, letGoElsewhere } from './lib'

/** What a session may do: everything, or what a screen may, which is to open any page and answer on it. */
export type Role = 'owner' | 'screen'

export interface Session {
  /** Whether the question has been answered yet. Until it has, nothing else here says anything. */
  loaded: boolean
  paired: boolean
  /** The person's id, this browser's session, and what the session may do. All null when not paired. */
  user: string | null
  session: string | null
  role: Role | null
  /**
   * What became of the last code this browser was given, when it did not pair: refused, never
   * put to the backend, left unused because it was for another screen and this browser is the
   * owner's, or, as `screen`, held until the person says that this browser is the screen it
   * was made for.
   */
  code: 'refused' | 'trouble' | 'owner' | 'screen' | null
  /**
   * In how many seconds a code may be tried again, when the last one was not tried at all: the
   * door has had too many wrong codes from this browser's address within a minute, and tries
   * none from it for the rest of that minute.
   */
  wait: number | null
}

const NOBODY = { paired: false, user: null, session: null, role: null } as const
let state: Session = { loaded: false, ...NOBODY, code: null, wait: null }
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
function set(next: Session): void {
  const same = (Object.keys(next) as (keyof Session)[]).every((k) => next[k] === state[k])
  if (same) return
  state = next
  for (const fn of listeners) fn()
}

/** How things stand at this moment. */
export const current = (): Session => state
export const useSession = (): Session => useSyncExternalStore(subscribe, current)

// ---------- asking the backend ----------

/**
 * How long the backend is given to say whether this browser is paired. An asking that is never
 * answered is given up and made again: the site shows nothing else until it is answered, and
 * a connection that hangs would otherwise leave it so for as long as the connection did.
 */
const ANSWER_MS = 20_000

/**
 * Every request about the session says that it comes from the site, in a header that a page on
 * another site cannot add without the browser first asking leave. The backend refuses any
 * that does not.
 */
const post = (path: string, body?: unknown, within?: number) =>
  fetch(path, {
    method: 'POST',
    headers: body === undefined ? { 'x-it-site': '1' } : { 'x-it-site': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
    ...(within === undefined ? {} : { signal: AbortSignal.timeout(within) }),
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- the person this browser was paired for ----------

// What the site keeps in a browser is kept for one person: which display the browser is, what
// was done on a page and not yet sent. When everything It held is erased, that person is no
// more, and what was kept for them is let go of. The browser that asked for the erasing does
// so itself. Any other learns of it here: it keeps the id of the person it was last paired
// for, and when it finds that it is not paired it asks whether It still holds anything for
// them. It learns of it too by being paired for somebody else.
//
// With the person's id it keeps the id of the session it holds, which is no secret. A session's
// cookie is out of a script's reach, and the backend clears one only by its name: so a browser
// that finds it is not paired names the session it last held, and the cookie goes with the rest.
const HELD = 'it.person.session'
const heldBefore = (): string | null => {
  try {
    return localStorage.getItem(HELD)
  } catch {
    return null
  }
}
/** The browser is paired, for this person and under this session. What it kept for anyone else was kept for a person whose records were erased. */
function pairedFor(user: string, session: string): void {
  const before = keptFor()
  if (before !== null && before !== user) forgetAll(before)
  keepFor(user)
  try {
    if (heldBefore() !== session) localStorage.setItem(HELD, session)
  } catch {}
  // A session the backend gives a token for is not over, whatever was noted of it
  if (owed().some((o) => o.id === session)) keepOwed(owed().filter((o) => o.id !== session))
}

// ---------- the cookies of sessions that are over ----------

// A session that is over leaves its cookie in the browser until the backend is asked, by the
// session's name, to clear it. One asking is not always enough. The request may fail, and the
// tab be closed before it is made again. And an answer that was on its way when the cookie was
// cleared, a token's that gives the cookie again for another year, can put it back afterwards.
// The cookie opens nothing by then, and it is still not left: the name of each session this
// browser held and holds no more is kept, apart from everything a letting go removes, and is
// named to the backend each time the browser finds it is not paired, once in each tab while it
// is paired, and whenever an answer arrives that was overtaken. A name is kept a day, which is
// longer than any answer could still be on its way to a tab of this browser, and goes once the
// backend has answered about it after that.
const OWED_MS = 86_400_000
/** How many such names are kept at the most, the oldest going first. */
const OWED_MOST = 20
interface Owed {
  id: string
  /** When the browser found that it held the session no more. */
  at: number
}
function owed(): Owed[] {
  try {
    const kept = JSON.parse(localStorage.getItem(COOKIES) ?? '[]') as unknown
    if (!Array.isArray(kept)) return []
    return kept.filter((o): o is Owed => typeof o?.id === 'string' && /^[A-Za-z0-9_;-]{1,64}$/.test(o.id) && typeof o.at === 'number')
  } catch {
    return []
  }
}
function keepOwed(list: Owed[]): void {
  try {
    if (list.length) localStorage.setItem(COOKIES, JSON.stringify(list.slice(-OWED_MOST)))
    else localStorage.removeItem(COOKIES)
  } catch {}
}
/** A session this browser held is over: its name is kept until its cookie is surely cleared, and is no more the session the browser holds. */
function retired(session: string): void {
  const list = owed()
  if (!list.some((o) => o.id === session)) keepOwed([...list, { id: session, at: Date.now() }])
  try {
    if (heldBefore() === session) localStorage.removeItem(HELD)
  } catch {}
}
/**
 * Names each session whose cookie is still to be cleared to the backend, which answers by
 * clearing the cookie of a session that is over or is no session at all, and touches no other.
 * The backend ends a session only for a request that comes with that session's own cookie, and
 * only a session that it has refused a token to, or has ended, is ever named here: so nothing
 * is ended by this, whatever session the browser holds by now.
 */
async function clearCookies(): Promise<void> {
  for (const { id } of owed()) {
    // Never the session this tab is under: it is not over
    if (id === state.session) continue
    try {
      const { status } = await post('/session/end', { session: id })
      // Answered, its name goes once it has been kept its day. Not answered, it is named again the next time
      if (status === 200 || status === 401 || status === 409) keepOwed(owed().filter((o) => o.id !== id || Date.now() - o.at < OWED_MS))
    } catch {
      // No connection
    }
  }
}
/** Whether the sessions that are over have been named from this tab since the browser was found to be paired. */
let clearedWhilePaired = false

/**
 * The browser is not paired. The cookies of the sessions it held are asked to be cleared. If
 * It holds nothing any more for the person it was last paired for, neither does this browser.
 * And where it was paired for nobody, it keeps nothing of the site's at all: whatever is here
 * was written by a tab that had yet to hear that everything was let go of.
 */
async function unpairedFrom(): Promise<void> {
  void clearCookies()
  const person = keptFor()
  if (person === null) return forgetAll(null)
  try {
    const r = await post('/session/person', { person })
    const said = r.ok ? ((await r.json().catch(() => null)) as { there?: unknown } | null) : null
    // Only on the backend's own word that they are gone, and only while this browser is still not paired and still keeps what was theirs
    if (said?.there === false && !state.paired && keptFor() === person) forgetAll(person)
  } catch {
    // No connection: it is asked again the next time the browser finds it is not paired
  }
}

// ---------- the token ----------

/**
 * How long before a token runs out a new one is wanted. One with less than this left is not
 * handed out, and the live connection is told to ask this long ahead. It is a whole minute
 * because a timer in a tab nobody is looking at may be that late.
 */
export const EARLY_MS = 60_000
let kept: { token: string; until: number } | null = null
// Moved on by every sign-out and every pairing. An answer that was asked for before either,
// and arrives after, is about the session that was here before, and is dropped.
let era = 0
/** What an asking came to. `overtaken` is no answer: the browser was paired or signed out while it was on its way, and it says nothing of how things stand now. */
type Said = 'paired' | 'unpaired' | 'trouble' | 'overtaken'
let asking: Promise<Said> | null = null
/** The session this browser had is over, or is about to be another: nothing kept or on its way is this one's. */
function letGo(): void {
  era++
  kept = null
  asking = null
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Asks for a token, once, and with it whether this browser is paired. Only a refusal means it
 * is not. Anything else that is not a token (no connection, the backend in trouble, being told
 * to slow down) says nothing about the pairing, and changes nothing here. Neither does an
 * answer that was overtaken, which is dropped.
 */
function askOnce(): Promise<Said> {
  if (asking) return asking
  const began = era
  const asked = Date.now()
  // The session this browser takes itself to hold, as this tab knows it or as the browser kept it, before it is asked about
  const held = state.session ?? heldBefore()
  const mine = (async (): Promise<Said> => {
    try {
      const r = await post('/session/token', undefined, ANSWER_MS)
      if (began !== era) {
        // An answer about the session that was here before may have given its cookie again, after it was cleared
        void clearCookies()
        return 'overtaken'
      }
      if (r.status === 401) {
        kept = null
        set({ loaded: true, ...NOBODY, code: state.code, wait: state.wait })
        if (held !== null) retired(held)
        void unpairedFrom()
        return 'unpaired'
      }
      if (!r.ok) return 'trouble'
      const a = (await r.json()) as { token?: unknown; expiresIn?: unknown; user?: unknown; session?: unknown; role?: unknown } | null
      if (began !== era) return 'overtaken'
      if (!a || !text(a.token) || !text(a.user) || !text(a.session) || typeof a.expiresIn !== 'number' || !(a.expiresIn > 0)) return 'trouble'
      // Counted from when it was asked for: the token was made after that, so it lasts at least this long
      kept = { token: a.token, until: asked + a.expiresIn * 1000 }
      // A role this site has not heard of is given the least a session may do
      const role = a.role === 'owner' ? 'owner' : 'screen'
      pairedFor(a.user, a.session)
      // The first time this tab finds the browser paired, what is left of the sessions it held before is seen to
      if (!clearedWhilePaired) {
        clearedWhilePaired = true
        void clearCookies()
      }
      const code = stillToSay(role)
      // What was said of waiting was said of a code that is still offered, or is said no more
      set({ loaded: true, paired: true, user: a.user, session: a.session, role, code, wait: code === 'screen' ? state.wait : null })
      return 'paired'
    } catch {
      return began === era ? 'trouble' : 'overtaken'
    }
  })()
  asking = mine
  void mine.finally(() => {
    if (asking === mine) asking = null
  })
  return mine
}

/**
 * Asks whether this browser is paired, and says what the answer is about the browser as it is
 * now. An asking that was overtaken by a pairing or a sign-out is not that: whatever overtook
 * it asks afresh, and that asking is the one waited for.
 */
async function ask(): Promise<Exclude<Said, 'overtaken'>> {
  for (;;) {
    const said = await askOnce()
    if (said !== 'overtaken') return said
  }
}

/**
 * The token the live connection shows the backend, or null when this browser is not paired. The
 * one last fetched is given while it has time left, and a new one is fetched before it runs
 * out, or at once when the connection says it needs one (`fresh`).
 *
 * When a new one cannot be fetched, and not because the pairing is over, the last one is given
 * again. If it has run out the backend refuses it and the connection asks again, at once.
 *
 * Null is given only on the backend's own word that the browser is not paired: the connection
 * takes it to mean exactly that, and does not ask again by itself. So where there is no token
 * to give and no such word (the one that was kept was let go of when the browser was paired
 * again or asked about afresh, and the backend could not be asked since), the connection is
 * kept waiting, and the backend is asked again, a little later each time, until it answers.
 */
export async function token(fresh: boolean): Promise<string | null> {
  if (!fresh && kept && kept.until - Date.now() > EARLY_MS) return kept.token
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    if ((await ask()) === 'unpaired') return null
    if (kept) return kept.token
    await sleep(wait)
  }
}

/** The same, for a connection that was begun under one session: it is given nothing once another session is the one here. */
export async function tokenFor(session: string | null, fresh: boolean): Promise<string | null> {
  const given = await token(fresh)
  return state.session === session ? given : null
}

/**
 * What the live connection asks of whatever gives it its token, in the shape Convex's
 * `ConvexProviderWithAuth` takes. The function that fetches the token is a new one for each
 * session, which is how the connection is told to show a token afresh when the session changes.
 */
export function useLiveSession(): {
  isLoading: boolean
  isAuthenticated: boolean
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>
} {
  const { loaded, paired, session } = useSession()
  const fetchAccessToken = useCallback(({ forceRefreshToken }: { forceRefreshToken: boolean }) => tokenFor(session, forceRefreshToken), [session])
  return useMemo(() => ({ isLoading: !loaded, isAuthenticated: paired, fetchAccessToken }), [loaded, paired, fetchAccessToken])
}

// ---------- the other tabs of this browser ----------

// A session's cookie is the whole browser's, so pairing or signing out in one tab changes what
// every other tab is. Each is told through a value they all can see, and asks for itself. So
// it does when another tab says that everything kept here was let go of: it lets go of what
// it keeps by itself first (lib.ts).
const CHANGED = 'it.session'
function tellOtherTabs(): void {
  try {
    localStorage.setItem(CHANGED, String(Date.now()))
  } catch {}
}
let listening = false
function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('storage', (e) => {
    if (!letGoElsewhere(e) && e.key !== CHANGED) return
    letGo()
    void ask()
  })
  // A tab left on the screen that says how to pair looks again when the person comes back to it, and when the connection does
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loaded && !state.paired) void ask()
  })
  window.addEventListener('online', () => {
    if (state.loaded && !state.paired) void ask()
  })
}

// ---------- pairing ----------

/** A code as it is shown to be read and typed: in fours. */
export const spaced = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1 ')
/**
 * A code as it is redeemed: as it was made, which is in small letters and digits, whatever
 * spaces it was shown with and whatever capitals a keyboard put in while it was typed.
 */
const bare = (code: string): string => code.replace(/\s+/g, '').toLowerCase().slice(0, 200)

/**
 * Takes a pairing code out of the address bar, and gives it back if there was one. A code
 * works once, so it is removed before anything is done with it: it is not left where it can be
 * read off the screen, copied with the address, or found in the browser's history.
 */
export function takeCode(): string | null {
  if (location.pathname !== '/pair') return null
  let code = location.hash.slice(1)
  history.replaceState(null, '', '/')
  try {
    code = decodeURIComponent(code)
  } catch {}
  return bare(code) || null
}

// A screen's code that came in the address, held until the person says that this browser is
// the screen it was made for. It is in no storage and no address: it goes with the tab.
let held: string | null = null

/**
 * What is still to be said of a code to a browser that is paired, as which it has just been
 * found to be. That a code was left unused because this browser is the owner's is said to the
 * browser that is. A screen's code that is held is still offered to any browser but the
 * owner's, where the backend would leave it unused: there it is let go of, and that is said.
 */
function stillToSay(role: Role): Session['code'] {
  if (role === 'owner' && (state.code === 'owner' || state.code === 'screen')) {
    held = null
    return 'owner'
  }
  return state.code === 'screen' && held !== null ? 'screen' : null
}

/** A code was not tried, and none will be from this browser's address for so many seconds. */
interface Wait {
  wait: number
}
/**
 * Whether an answer is the door's own for an address that has had too many codes refused in a
 * minute: it tries none from that address for the rest of the minute, and says for how many
 * seconds that is. Where it says less than a few, codes sent together are still being answered,
 * and that passes like any trouble.
 */
async function toldToWait(r: Response): Promise<Wait | null> {
  if (r.status !== 429) return null
  const said = (await r.json().catch(() => null)) as { error?: unknown } | null
  const seconds = Number(r.headers.get('retry-after'))
  if (said?.error !== 'too_many_wrong_codes' || !(seconds > 3)) return null
  return { wait: Math.min(Math.ceil(seconds), 60) }
}

/**
 * Asks the backend what a code is for, which uses nothing of it: `owner` for a code that pairs
 * this browser as the person's own, `screen` for any other code that would pair it.
 */
async function roleOf(code: string): Promise<'owner' | 'screen' | 'refused' | 'trouble' | Wait> {
  try {
    // Asking what a code is for uses nothing of it, so an asking that is never answered is given up and made again
    const r = await post('/session/code', { code }, ANSWER_MS)
    if (r.ok) return ((await r.json().catch(() => null)) as { role?: unknown } | null)?.role === 'owner' ? 'owner' : 'screen'
    return r.status === 401 || r.status === 400 ? 'refused' : ((await toldToWait(r)) ?? 'trouble')
  } catch {
    return 'trouble'
  }
}

/**
 * A code came in the address this browser was opened at. A code for the person's own browser
 * is redeemed at once, which is what `it site` opens the site for. A code for a screen is not:
 * an address can be opened anywhere, and the owner who opens it in their own browser, to look
 * at it, must not find that browser made a screen and the code spent. It is held, and the
 * site asks the person whether this browser is that screen (`pairAsScreen`).
 */
async function arrived(code: string): Promise<void> {
  let role: Awaited<ReturnType<typeof roleOf>> = 'trouble'
  // Trouble passes: it is asked again a few times, a little later each time
  for (let i = 0; i < 4 && role === 'trouble'; i++) {
    if (i > 0) await sleep(1000 * 2 ** (i - 1))
    role = await roleOf(code)
  }
  if (role === 'owner') return pair(code, 4)
  if (typeof role === 'object') return set({ ...state, code: null, wait: role.wait })
  if (role !== 'screen') return set({ ...state, code: role, wait: null })
  held = code
  set({ ...state, code: 'screen', wait: null })
}

/** The person says that this browser is the screen the code in its address was made for: the code that was held is redeemed. */
export async function pairAsScreen(): Promise<void> {
  const code = held
  if (code !== null) await pair(code, 4)
}

/**
 * Puts one code to the backend. The new session's cookie comes back with the answer when the
 * code is good. A code for a screen, put by the browser that is the owner's, is answered 409
 * `already_owner`: it was made for another screen, and the backend has left it for that one.
 */
async function redeem(code: string): Promise<'paired' | 'refused' | 'trouble' | 'owner' | Wait> {
  try {
    const r = await post('/session/redeem', { code })
    if (r.ok) return 'paired'
    if (r.status === 409) {
      const said = (await r.json().catch(() => null)) as { code?: unknown } | null
      return said?.code === 'already_owner' ? 'owner' : 'trouble'
    }
    // Wrong, used or expired, or not a code at all: asking again would get the same answer
    return r.status === 401 || r.status === 400 ? 'refused' : ((await toldToWait(r)) ?? 'trouble')
  } catch {
    return 'trouble'
  }
}

/**
 * Pairs this browser with a code, and then asks who it is paired as. What became of a code
 * that did not pair is kept in `code`, for the screen that says how to pair. A code the door
 * did not try, because too many wrong ones had come from this browser's address, is as good as
 * it was: `wait` says how long until it can be put again, and one that was held is held still.
 */
export async function pair(typed: string, tries = 1): Promise<void> {
  const code = bare(typed)
  let outcome: Awaited<ReturnType<typeof redeem>> = code ? 'trouble' : 'refused'
  // Trouble passes: the code is put again a few times, a little later each time
  for (let i = 0; code && i < tries && outcome === 'trouble'; i++) {
    if (i > 0) await sleep(1000 * 2 ** (i - 1))
    outcome = await redeem(code)
  }
  if (typeof outcome === 'object') return set({ ...state, code: held !== null && state.code === 'screen' ? 'screen' : null, wait: outcome.wait })
  // Whatever else came of it, a code that was held is held no more: it is spent, or was refused
  held = null
  if (outcome !== 'paired') return set({ ...state, code: outcome, wait: null })
  letGo()
  tellOtherTabs()
  set({ ...state, code: null, wait: null })
  await answered()
}

/** The person has read what became of the last code, or has declined one that was held, and it need not be said again. */
export function codeSeen(): void {
  held = null
  set({ ...state, code: null, wait: null })
}

/** Asks whether this browser is paired until the backend has said, one way or the other. */
async function answered(): Promise<void> {
  for (let wait = 1000; (await ask()) === 'trouble'; wait = Math.min(wait * 2, 15_000)) await sleep(wait)
}

/**
 * The backend refused something of this tab's as coming from nobody. Whether this browser is
 * paired, and as which session, is asked afresh, and the site is whatever the answer says. The
 * session may be over; or the browser may have been paired again in another tab, and every tab
 * of it holds that pairing by now. So nothing is ended on the strength of such a refusal.
 */
export async function recheck(): Promise<void> {
  letGo()
  await answered()
}

/**
 * Run once, when the site starts. A code in the address is seen to first: redeemed, where it
 * is the person's own, and held for the person's word where it is a screen's. Then the backend
 * is asked whether this browser is paired, and asked again until it answers one way or the other.
 */
export async function begin(): Promise<void> {
  listen()
  const code = takeCode()
  if (code !== null) await arrived(code)
  // Until it is known: an answer overtaken by a pairing or a sign-out in another tab is not one
  while (!state.loaded) await answered()
}

// ---------- signing out ----------

/** How long a tab that has signed out waits to hear what the browser is now, before it takes it to be unpaired. */
const SOON_MS = 4000

/**
 * Ends the session this tab is under, by naming it to the backend, which ends a session only
 * for a request that comes with that session's own cookie. True once this browser does not hold
 * that session. That is also so when the backend says there was none to end; and when it says
 * the browser holds another session, because it was paired again in another tab: nothing is
 * ended then. False when the backend could not be told: the browser is then still paired, and
 * whoever asked has to say so.
 *
 * The answer is about the session that was named, and may arrive after the browser has been
 * paired again in another tab. So it is never taken to say what this browser is now: that is
 * asked for, and followed. A tab that has moved on to another session meanwhile, or is finding
 * out which it is under, is left to that.
 */
export async function signOut(): Promise<boolean> {
  const ending = state.session
  const began = era
  let status: number
  try {
    status = (await post('/session/end', { session: ending })).status
  } catch {
    return false
  }
  if (status !== 200 && status !== 401 && status !== 409) return false
  // The session that was named is over, or was already: its cookie is cleared with the answer, and its name is kept in case an answer still on its way gives the cookie again
  if (ending !== null) retired(ending)
  if (status === 409 || era !== began || state.session !== ending) {
    await recheck()
    return true
  }
  letGo()
  const now = await Promise.race([ask(), sleep(SOON_MS).then(() => 'trouble' as const)])
  // Paired again while the answer was on its way: this tab is under that pairing, as `ask` has noted
  if (now !== 'paired') set({ loaded: true, ...NOBODY, code: null, wait: null })
  tellOtherTabs()
  return true
}
