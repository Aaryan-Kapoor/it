// The script inside every page. The content service puts it first in the page, so `It` exists
// before any of the page's own scripts run.
//
// A page is a sandboxed document. Its origin is its own and is shared with nothing, it holds
// no credential, and it cannot talk to the backend. Everything goes through the site that
// framed it, over a message channel: actions and stored values go up, the page's state comes
// down. The site decides who the person is.
import {
  type ActionEnvelope,
  CHANNEL_VERSION,
  isStoreKey,
  jsonText,
  LIMITS,
  OPENED_FOR_A_PAGE,
  openedForAPage,
  type PageToSite,
  SHRINK,
  type SiteToPage,
  STORE_EVERY_MS,
  STORE_KEY,
} from '@it/protocol'
import { embeds } from './embeds'

interface Config {
  app: string
  id: string
  version: number
  /** Where this showing is kept going by being asked. */
  keep: string
}
type Listener = (state: Record<string, unknown>) => void
type State = Record<string, unknown>
type Result = Extract<SiteToPage, { type: 'it:result' }>

const config = (window as unknown as { __IT__: Config }).__IT__

// A sandboxed document has none of the browser's storage: reading `localStorage` or
// `sessionStorage` there throws. A page written without a thought for that would stop at its
// first line. So where they throw, each is stood in for by one that keeps what it is given
// while the document is open, and not after. What a page means to keep goes in `It.store`.
function standIn(): Storage {
  const kept = new Map<string, string>()
  const does: Record<string, unknown> = {
    getItem: (key: unknown) => kept.get(String(key)) ?? null,
    setItem: (key: unknown, value: unknown) => void kept.set(String(key), String(value)),
    removeItem: (key: unknown) => void kept.delete(String(key)),
    clear: () => kept.clear(),
    key: (n: number) => [...kept.keys()][n] ?? null,
  }
  // Read and written as an object too, the way the real one is: `localStorage.draft = 'x'`
  return new Proxy(does, {
    get: (_, name) => (name === 'length' ? kept.size : typeof name === 'string' && !(name in does) ? kept.get(name) : does[name as string]),
    set: (_, name, value) => {
      kept.set(String(name), String(value))
      return true
    },
    deleteProperty: (_, name) => {
      kept.delete(String(name))
      return true
    },
    has: (_, name) => name in does || kept.has(String(name)),
    ownKeys: () => [...kept.keys()],
    getOwnPropertyDescriptor: (_, name) =>
      kept.has(String(name)) ? { value: kept.get(String(name)), writable: true, enumerable: true, configurable: true } : undefined,
  }) as unknown as Storage
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    void window[name]
  } catch {
    Object.defineProperty(window, name, { value: standIn(), configurable: true })
  }
}
let port: MessagePort | null = null
/** What the site's channel says it speaks: see CHANNEL_VERSION. */
let channel = 0
/**
 * What the site that framed the page says it does, as it hands over the channel: null until it
 * has. A site from before It opened the microphone or the camera, or links, for a page, as
 * 0.1.38 was, says none of it, and one from before it passed a page the microphone's sound, as
 * 0.1.39 was, does not say that. Each drops what it does not know, so a page that waited on its
 * answer would wait for ever. A site open on a screen since before It was updated is one, since
 * nothing reloads it.
 */
let siteDoes: { media: boolean; sound: boolean; opens: boolean } | null = null
/** What a page is told where the site that framed it does not do what it asked of the microphone or the camera. */
const RELOAD_FOR_MEDIA = 'Reload It in this browser to use the microphone and camera: It was updated while it was open here.'
/** What opens the microphone or the camera, which such a site would never answer: each is refused there instead. */
const BEGINS_MEDIA: ReadonlySet<string> = new Set(['it:photo', 'it:camera', 'it:microphone'])
/** Whether the site, having said what it does, does not take this: anything of the microphone or the camera, or the microphone's sound alone. */
const siteCannot = (message: PageToSite): boolean =>
  siteDoes !== null &&
  BEGINS_MEDIA.has(message.type) &&
  (!siteDoes.media ||
    (!siteDoes.sound && (message.type === 'it:microphone' || (message.type === 'it:camera' && message.audio !== undefined && message.audio !== false))))
/** Whether the site opens the mail, phone, messages and other links a page sends it. Until it has said, it is taken to, as a current site does. */
const siteOpens = () => siteDoes?.opens !== false
/** Answers a request for a photo, the live camera or the live microphone, which the site does not take, with what to do. */
function refuseMedia(requestId: string): void {
  const answer = waiting.get(requestId)
  waiting.delete(requestId)
  answer?.({ type: 'it:result', requestId, ok: false, error: RELOAD_FOR_MEDIA })
}
/** The state as It last sent it. */
let sent: State = {}
/** What the page sees: that, with the values the page has set and It has not yet sent back over what the page keeps. */
let state: State = {}
let revision = 0
/** Whether the state has arrived. Its revision does not say: a page made with no state is sent an empty one at revision zero. */
let arrived = false
const listeners: Listener[] = []
/** What is waiting for the site's answer, by the request it answers. */
const waiting = new Map<string, (result: Result) => void>()
/**
 * The actions sent and not yet answered, as they were sent, by the request each is. Where the
 * channel is lost, each is sent again as it was over the next one, under the same id: the site and
 * the backend know an action by that id, so it is one action however often it is sent, and the
 * page is told what became of it.
 */
const actionsOnTheirWay = new Map<string, PageToSite>()
const unsent: PageToSite[] = []
let staged: Record<string, unknown> = {}

const id = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`

function get(obj: unknown, path: string): unknown {
  let cur = obj as Record<string, unknown> | undefined | null
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[part] as Record<string, unknown>
  }
  return cur
}

// data-it-bind="path" puts a value from the state into an element; data-it-show="path" (or
// "!path") shows or hides one.
/** The elements a value from the state has been put into. What the page itself wrote in one, before any value came, is left as it is. */
const filled = new WeakSet<Element>()
const written = new WeakMap<Element, { state: unknown; value: string }>()
const edited = new WeakSet<Element>()
// Typing may begin before the first state arrives, when there is no value from a binding to compare it with.
for (const event of ['input', 'change'])
  document.addEventListener(
    event,
    (e) => {
      if (e.target instanceof Element) edited.add(e.target)
    },
    true,
  )
function applyBindings(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-it-bind]')) {
    const value = get(state, el.getAttribute('data-it-bind') ?? '')
    if ((el instanceof HTMLInputElement && el.type !== 'checkbox') || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const last = written.get(el)
      const text = value === undefined ? '' : String(value)
      // A matching snapshot confirms the edit. Later changes can follow this new baseline,
      // including when typing began before any state arrived.
      if (el.value === text) {
        written.set(el, { state: value, value: el.value })
        edited.delete(el)
        if (value === undefined) filled.delete(el)
        else filled.add(el)
        continue
      }
      // A snapshot may change only a status or a stored value. It must not replace an edit,
      // even when the agent also changes or removes the value this field was bound to.
      if (last ? el.value !== last.value || Object.is(value, last.state) : edited.has(el)) continue
      if (value === undefined && !filled.has(el)) continue
      el.value = text
      written.set(el, { state: value, value: el.value })
      if (value === undefined) filled.delete(el)
      else filled.add(el)
      continue
    }
    if (value === undefined) {
      // The value it showed has been taken out of the state: it shows it no longer. Left up, a
      // status the agent had removed went on saying what it said, and an answer it had cleared stayed
      if (!filled.has(el)) continue
      filled.delete(el)
      if (el instanceof HTMLProgressElement || el instanceof HTMLMeterElement) el.value = 0
      else if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox') el.checked = false
        else el.value = ''
      } else if (el instanceof HTMLImageElement || el instanceof HTMLIFrameElement) el.removeAttribute('src')
      else el.textContent = ''
      continue
    }
    filled.add(el)
    if (el instanceof HTMLProgressElement || el instanceof HTMLMeterElement) el.value = Number(value) || 0
    else if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') el.checked = Boolean(value)
      else if (el.value !== String(value)) el.value = String(value)
    } else if (el instanceof HTMLImageElement || el instanceof HTMLIFrameElement) {
      if (el.getAttribute('src') !== String(value)) el.src = String(value)
    } else {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
      if (el.textContent !== text) el.textContent = text
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-it-show]')) {
    const expr = el.getAttribute('data-it-show') ?? ''
    const negate = expr.startsWith('!')
    const value = get(state, negate ? expr.slice(1) : expr)
    el.style.display = (negate ? !value : Boolean(value)) ? '' : 'none'
  }
}

/**
 * Calls one of the page's own listeners. What it throws may be anything of the page's, its
 * state or what a person typed, and an error's name is the page's to set as well: so that it
 * threw is written to the console, and nothing of what it threw is read.
 */
function tell(l: Listener): void {
  const threw = () => {
    console.error('[It] an onState handler threw')
    // And said above the page and to its agent, as any error in the page's script is: this is
    // where a page draws itself, and one that fails here stays as it was with no word of why.
    // Only that it failed, in words of this program's own
    fault('A function the page gave to It.onState failed, so the page may not show what its state says')
  }
  try {
    // A listener may be one that answers later. What it fails with then is held in the same way
    const later = l(state) as unknown
    if (later && typeof (later as { then?: unknown }).then === 'function') (later as Promise<unknown>).then(undefined, threw)
  } catch {
    threw()
  }
}

function emit(): void {
  applyBindings()
  for (const l of [...listeners]) tell(l)
}

/**
 * Hands one message to the site. A port sends a copy, and what cannot be copied (a function, an
 * element of the page) it refuses by throwing. Whoever asked is told so, as of any refusal, and
 * nothing else is held up by it: thrown on from here, it ended the sending of everything that
 * had been held for the port, and what came after it was never sent or answered.
 */
function post(to: MessagePort, message: PageToSite): void {
  try {
    to.postMessage(message)
  } catch {
    if (!('requestId' in message)) return
    const answer = waiting.get(message.requestId)
    waiting.delete(message.requestId)
    actionsOnTheirWay.delete(message.requestId)
    answer?.({
      type: 'it:result',
      requestId: message.requestId,
      ok: false,
      error: 'That could not be sent: what an action or a stored value carries is plain data, with no function or element in it.',
    })
  }
}

function send(message: PageToSite): void {
  if (port) post(port, message)
  else unsent.push(message)
}

/** Sends a request to the site, and is answered with what the site answered. */
function ask(message: PageToSite & { requestId: string }): Promise<Result> {
  return new Promise((answered) => {
    waiting.set(message.requestId, answered)
    // A site that has said it does not do this for a page is not asked: it would never answer
    if (siteCannot(message)) return refuseMedia(message.requestId)
    if (message.type === 'it:action') actionsOnTheirWay.set(message.requestId, message)
    send(message)
  })
}
/** A request whose refusal the page is told of by a rejection: a photo, or the opening of the camera or the microphone, whose callers await what it gives. */
const done = (message: PageToSite & { requestId: string }): Promise<Extract<Result, { ok: true }>> =>
  ask(message).then((result) => (result.ok ? result : Promise.reject(new Error(result.error))))

const isObject = (x: unknown): x is State => typeof x === 'object' && x !== null && !Array.isArray(x)
/** What a state says the page keeps for itself. */
const keptIn = (s: State): State => (isObject(s[STORE_KEY]) ? (s[STORE_KEY] as State) : {})
/**
 * Puts a value under a name as the object's own, whatever the name. A plain assignment under
 * `__proto__` would change what the object is made from instead, and a state written before It
 * held names to its rules can hold one.
 */
const putOwn = (o: State, key: string, value: unknown) => Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true })
/** A state with what the page keeps put in place of what it said: under its own key, where the page keeps anything. */
function withKept(s: State, kept: State): State {
  const { [STORE_KEY]: _, ...rest } = s
  return Object.keys(kept).length > 0 ? { ...rest, [STORE_KEY]: kept } : rest
}

function receive(message: SiteToPage): void {
  if (players.received(message)) return
  if (message.type === 'it:state') {
    sent = isObject(message.state) ? message.state : {}
    revision = message.revision
    arrived = true
    shown()
    emit()
  } else if (message.type === 'it:changed') {
    // What changed since the state that was sent last, which is built on. Anything older than that is passed over
    if (!arrived || message.revision <= revision) return
    const kept = { ...keptIn(sent) }
    for (const [key, value] of message.kept) {
      if (value === null) delete kept[key]
      else putOwn(kept, key, value)
    }
    sent = withKept(message.state === undefined ? sent : isObject(message.state) ? message.state : {}, kept)
    revision = message.revision
    shown()
    emit()
  } else if (message.type === 'it:result') {
    const answer = waiting.get(message.requestId)
    if (!answer) return
    waiting.delete(message.requestId)
    actionsOnTheirWay.delete(message.requestId)
    answer(message)
  } else if (message.type === 'it:camera-frame' || message.type === 'it:camera-state') seen(message)
  else if (message.type === 'it:microphone-sound' || message.type === 'it:microphone-state') heard(message)
  else if (message.type === 'it:fullscreen') fullscreenSaid(message.on === true, message.enabled === true)
}

// What the page keeps for itself (It.store). What is set within a moment goes to the site as
// one write, with the last value set under each name, and one write at a time: the next is
// sent when the last is answered, and no sooner than STORE_EVERY_MS after it, with whatever was
// set in between. So a page that sets a value on every movement of the pen sends a few writes
// a second, and one that sets a value now and then sends it at once.
//
// The page sees what it set at once, in It.store.get and in It.state, and goes on seeing it
// until the state It sends back has it. A write It refuses for coming too fast is sent again
// once It says it may be, with anything set under the same names meanwhile, so nothing set is
// lost for being set quickly. One It refuses for good, as too large, is not kept, and what the
// page sees goes back to what It has.
interface Setting {
  /** The value as JSON text, as it is sent, and as it was when it was set. */
  text: string
  value: unknown
  /** Each It.store.set that this value answers: the one that set it, and any before it under the same name that were not yet sent. */
  answers: { resolve: (v: unknown) => void; reject: (e: Error) => void }[]
}
/** Set, and not yet sent. */
const toSend = new Map<string, Setting>()
/** Sent, and not yet answered. */
let sending: Map<string, Setting> | null = null
/** Kept, at the revision of the state that has them, until a state that has them has arrived. */
const keptAt = new Map<string, { value: unknown; revision: number }>()
/** Whether a write was sent too lately to send another, and whether It asked the page to wait. */
let resting = false
let holding = false
let flushing = false

/** What the page sees: the state as It sent it, with what the page set and It has not yet sent back, newest last. */
function shown(): void {
  for (const [key, at] of keptAt) if (at.revision <= revision) keptAt.delete(key)
  if (keptAt.size === 0 && !sending && toSend.size === 0) {
    state = sent
    return
  }
  const kept = { ...keptIn(sent) }
  const over = (key: string, value: unknown) => {
    if (value === null) delete kept[key]
    else putOwn(kept, key, value)
  }
  for (const [key, at] of keptAt) over(key, at.value)
  if (sending) for (const [key, setting] of sending) over(key, setting.value)
  for (const [key, setting] of toSend) over(key, setting.value)
  state = withKept(sent, kept)
}

/** Sends what was set, once nothing is on its way, the last write is long enough ago, and It has not asked the page to wait. */
function flush(): void {
  flushing = false
  if (!port || sending || resting || holding || toSend.size === 0) return
  const batch = new Map<string, Setting>()
  for (const [key, setting] of toSend) {
    if (batch.size >= LIMITS.storeKeysAtOnce) break
    batch.set(key, setting)
    toSend.delete(key)
  }
  sending = batch
  resting = true
  setTimeout(() => {
    resting = false
    flush()
  }, STORE_EVERY_MS)
  const from = revision
  if (channel >= CHANNEL_VERSION) {
    void ask({ type: 'it:store', requestId: id(), changes: [...batch].map(([key, setting]) => [key, setting.text]) }).then((result) =>
      answered(batch, result, result.ok ? (result.revision ?? from + 1) : from),
    )
    return
  }
  // A site that takes one value at a time, as one still open from before may: each is sent by
  // itself, and the next write waits for all of them
  let left = batch.size
  const kept = new Map<string, Setting>()
  for (const [key, setting] of batch)
    void ask({ type: 'it:store', requestId: id(), key, value: setting.value }).then((result) => {
      if (result.ok) kept.set(key, setting)
      else for (const answer of setting.answers) answer.reject(new Error(result.error))
      if (--left > 0) return
      const before = state
      answered(kept, { type: 'it:result', requestId: '', ok: true }, from + 1)
      // What was refused is no longer shown
      if (
        seenOtherwise(
          before,
          [...batch.keys()].filter((key) => !kept.has(key)),
        )
      )
        emit()
    })
}

/** What became of a write: kept, at a revision; to be sent again later; or refused. */
function answered(batch: Map<string, Setting>, result: Result, at: number): void {
  sending = null
  if (result.ok) {
    for (const [key, setting] of batch) {
      if (at > revision) keptAt.set(key, { value: setting.value, revision: at })
      for (const answer of setting.answers) answer.resolve({ ok: true })
    }
  } else if (result.retryAfterMs !== undefined) {
    // Too fast: sent again once the wait is over, under each name with whatever was set since
    for (const [key, setting] of batch) {
      const later = toSend.get(key)
      if (later) later.answers.unshift(...setting.answers)
      else toSend.set(key, setting)
    }
    holding = true
    setTimeout(
      () => {
        holding = false
        flush()
      },
      Math.min(Math.max(result.retryAfterMs, STORE_EVERY_MS), 60_000),
    )
  } else {
    for (const setting of batch.values()) for (const answer of setting.answers) answer.reject(new Error(result.error))
  }
  const before = state
  shown()
  // What the page sees changed where It refused a value, or where the state It sent while the
  // value was on its way was already past it, and had something else under that name
  if (seenOtherwise(before, batch.keys())) emit()
  flush()
}

/** Whether any of these values is now seen otherwise than it was in that state. */
function seenOtherwise(before: State, keys: Iterable<string>): boolean {
  const was = keptIn(before)
  const now = keptIn(state)
  for (const key of keys) if (was[key] !== now[key] && JSON.stringify(was[key]) !== JSON.stringify(now[key])) return true
  return false
}

function store(key: string, value: unknown): Promise<unknown> {
  // The same rules the site and the backend keep, said here so that a page hears of a bad name or value at once
  if (!isStoreKey(key)) return Promise.reject(new Error('A store key is 1 to 64 letters, digits, dashes or underscores.'))
  let text: string
  try {
    text = jsonText(value, LIMITS.storeValueBytes)
    if (new TextEncoder().encode(text).length > LIMITS.storeValueBytes) throw new Error(`A stored value is at most ${LIMITS.storeValueBytes / 1024} KB.`)
  } catch (err) {
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    // Taken as it is now: a change the page makes to it afterwards is not what was set
    const setting: Setting = { text, value: JSON.parse(text), answers: [{ resolve, reject }] }
    const earlier = toSend.get(key)
    if (earlier) setting.answers.unshift(...earlier.answers)
    toSend.set(key, setting)
    shown()
    if (!flushing) {
      flushing = true
      queueMicrotask(flush)
    }
  })
}

// Players and maps from the providers on It's list, which the site hosts over the page where the
// site says that it does (embeds.ts)
const players = embeds(send, id)

/** What a page is told of a value it kept with a site that takes one at a time, which was on its way when its channel to the site was lost. */
const LOST = 'The page lost its channel to It for a moment, so this may not have been kept. Keep it again.'
/**
 * The site took this document to be gone, as it does when the document does not say in time that
 * it is the one the channel was made for, and closed the channel. This document is here after all,
 * only slow: it lets go of the channel, and says hello again under a new name, so that it is given
 * another. Nothing it was waiting on is refused for that. Each action that was on its way is sent
 * again over the new channel as it was, under the same id, which the site and the backend take as
 * the same action, so that it is done once and the page is told what became of it. A value kept
 * with It.store is sent again with whatever was set since.
 */
function lost(): void {
  if (!port) return
  port.onmessage = null
  port.close()
  port = null
  players.lost()
  for (const [requestId, answer] of [...waiting]) {
    if (actionsOnTheirWay.has(requestId)) continue
    waiting.delete(requestId)
    answer({ type: 'it:result', requestId, ok: false, error: LOST, retryAfterMs: 0 })
  }
  // Marked as sent again, so that the site takes each as the action it is, and never as new work
  unsent.unshift(...[...actionsOnTheirWay.values()].map((message) => ({ ...message, again: true }) as PageToSite))
  doc = id()
  hello()
}

// The site answers the hello with a port. Only the window that framed this one is listened to,
// and only while what is in it is the site. The site also asks that window, each time a document
// has loaded in it, whether this is the document the channel was made for (`it:who`), and says so
// when it has taken this document to be gone (`it:gone`).
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.origin !== config.app) return
  const type = e.data?.type
  if (type === 'it:who') {
    if (typeof e.data.nonce === 'string') window.parent.postMessage({ type: 'it:here', nonce: e.data.nonce.slice(0, 64), doc } satisfies PageToSite, config.app)
    return
  }
  if (type === 'it:gone') return lost()
  if (type !== 'it:port' || !e.ports[0] || port) return
  port = e.ports[0]
  channel = typeof e.data.v === 'number' ? e.data.v : 0
  siteDoes = { media: e.data.media === true, sound: e.data.sound === true, opens: e.data.opens === true }
  port.onmessage = (m) => receive(m.data as SiteToPage)
  // What was asked before the site answered goes now, but for what it has said it does not take
  for (const m of unsent.splice(0)) {
    if (siteCannot(m) && 'requestId' in m) refuseMedia(m.requestId)
    else post(port, m)
  }
  players.hosted(e.data.embeds === true)
  flush()
})
// This document's own name. The site answers each document once, however often it asks. It is
// named afresh only when the site has taken it to be gone, and it asks for a channel again.
let doc = id()
function hello(attempt = 0): void {
  if (port || attempt > 40) return
  window.parent.postMessage({ type: 'it:hello', v: 1, doc } satisfies PageToSite, config.app)
  setTimeout(() => hello(attempt + 1), 250)
}

// A page that sits still asks for nothing, and its showing would run out. Asking this keeps it,
// and a refusal means it is over: the site is told, and shows the page again.
// The address is given as a path, and it holds the showing's token. It is made whole here, from
// where this document was shown from, before anything of the page's own has been read: a page
// may name another site in a <base>, and a path asked for after that would be asked of that
// site, token and all.
const keepAt = new URL(config.keep, window.location.href).href
let lapsed = false
function keep(): void {
  // Asked whether or not the tab is showing: a tab the person has switched away from for a
  // while should still be as they left it when they come back
  if (lapsed) return
  fetch(keepAt, { cache: 'no-store' }).then(
    (r) => {
      if (r.status !== 401 || lapsed) return
      lapsed = true
      send({ type: 'it:lapsed' })
    },
    () => {}, // offline: the next one will tell
  )
}

setInterval(keep, 180_000)
document.addEventListener('visibilitychange', keep)
window.addEventListener('online', keep)

// The address a page is shown from holds its showing's token, so nothing of it is to be told to
// another site. Every answer from the pages' port says so, with `referrer-policy: no-referrer`,
// but a page's own markup can say otherwise: in a <meta name="referrer">, or in a
// `referrerpolicy` on a link. Where it does, Firefox sends the whole address, token and all, to
// a site the page opens in a window of its own. So what a page says of it is put back to
// telling nothing, as soon as it is in the document, and once more before the page's script
// opens a window. This makes the leak hard to come by and does not rule it out: it is done a
// moment after the markup is read and not before, and a document the page makes inside itself
// is not watched.
const TELLS_NOTHING = 'no-referrer'
// A link's auditing request carries this address in its own headers, whatever its referrer policy says.
function stopAuditing(el: Element): void {
  if ((el.localName === 'a' || el.localName === 'area') && el.hasAttribute('ping')) el.removeAttribute('ping')
}
function quieten(el: Element): void {
  stopAuditing(el)
  if (el.localName === 'meta' && el.getAttribute('name')?.toLowerCase() === 'referrer' && el.getAttribute('content') !== TELLS_NOTHING)
    el.setAttribute('content', TELLS_NOTHING)
  if (el.hasAttribute('referrerpolicy') && el.getAttribute('referrerpolicy') !== TELLS_NOTHING) el.setAttribute('referrerpolicy', TELLS_NOTHING)
}
function quietenWithin(root: ParentNode): void {
  for (const el of root.querySelectorAll('meta[name], [referrerpolicy], a[ping], area[ping]')) quieten(el)
}

// Where a link leads. The page's frame may show only the pages' port, so a link that would load
// another site in it turns the page into the browser's error page. A link to another site opens
// in a tab of its own instead, whatever target the page gave it, unless it names a frame inside
// the page. A link within the page, or to another of its own files, stays as the page wrote it.
//
// A window the page opens leaves the sandbox, so every way out is made to leave no hold either
// way: the window has no opener, the page is given no handle on it, and no referrer is sent.
// Where the site is reached at this machine's own name, such as localhost, the browser cuts the
// opener by itself, since the site sends `Cross-Origin-Opener-Policy` there; anywhere else only
// this does. A window of a kind that would hold
// what the page made, `javascript:`, `data:` or `blob:`, is not opened at all. An address that
// only the person's system can open, a mail, phone or messages link, is one a sandboxed frame
// cannot hand to the system, so the site is asked to open it.
//
// Like the referrer rules above, this is done as links appear and again on the way to a click,
// and a document the page makes inside itself is not watched.

/** Where this page's own files are, taken before anything of the page's own can name another. */
const home = new URL(window.location.href).origin
const XLINK = 'http://www.w3.org/1999/xlink'
/** The kinds of address a window is never opened to. */
const REFUSED = new Set(['javascript:', 'data:', 'blob:'])
/** The kinds of address only the person's system opens. */
const SYSTEM = new Set(['mailto:', 'tel:', 'sms:'])
const isLink = (el: Element) => el.localName === 'a' || el.localName === 'area'
/** An address as the page means it: read against where it says its addresses begin, or `null` where it is none. */
function addressOf(said: string | null | undefined): URL | null {
  if (said === null || said === undefined) return null
  try {
    return new URL(said, document.baseURI)
  } catch {
    return null
  }
}
/** Where a link leads, or `null` where it names nowhere. */
const leadsTo = (el: Element) => addressOf(el.getAttribute('href') ?? el.getAttributeNS(XLINK, 'href'))
/** Whether an address is another site's: one on the web that is not where this page's own files are. */
const elsewhere = (to: URL) => (to.protocol === 'http:' || to.protocol === 'https:') && to.origin !== home
/** The targets that name the frame a link is in, or one around it: `_parent` and `_top` are refused to a page, which cannot move the tab it is shown in. */
const IN_PLACE = new Set(['', '_self', '_parent', '_top'])
/**
 * The target a link or a form is followed in, as the browser takes it: its own, or else the page's
 * `<base target>`, as it is written. The browser trims nothing from a name, and compares the
 * keywords alone without regard to case: ` inside ` is no frame's name `inside`, and ` _self ` is
 * a name, not `_self`. A name with a line break and a `<` in it is taken as `_blank`, as the
 * browser takes it.
 */
function targetOf(el: Element): string {
  const said = el.hasAttribute('target') ? el.getAttribute('target') : document.querySelector('base[target]')?.getAttribute('target')
  const target = said ?? ''
  return /[\t\n\r]/.test(target) && target.includes('<') ? '_blank' : target
}
/** The shadow roots a script made, in which a frame can be as well as in the document. */
const shadowRoots: WeakRef<ShadowRoot>[] = []
/**
 * The browser's own lookup of the page's frames by the names they go by now, which nothing of
 * the page's can stand in for or change, taken before anything of the page's runs.
 */
const BY_NAME: object | null = Object.getPrototypeOf(Window.prototype)
const describe = Object.getOwnPropertyDescriptor
/**
 * Whether a frame of the page's goes by a name now, which is the name a link's target finds it
 * by. A document of the page's own in the frame has a name that can be read, and may have changed
 * it since. Another site's document hides it, and the browser's own lookup by name says instead:
 * it reaches the frames of the document, and a frame of another site's inside a shadow root
 * cannot be told.
 */
function goesBy(frame: Element, target: string, inDocument: boolean): boolean {
  const shown = (frame as HTMLIFrameElement).contentWindow
  if (!shown) return false
  try {
    return shown.name === target
  } catch {}
  if (!inDocument || !BY_NAME) return false
  try {
    return describe(BY_NAME, target)?.value === shown
  } catch {
    return false
  }
}
/**
 * Whether a target names a frame inside the page, which the page means a link to be followed
 * in: a frame of the page's, in the document or in a shadow root a script made, whose document
 * goes by that name now. An element that merely has the name, such as an `embed` or an `object`
 * that shows a picture, holds no document, and a property of the page's window that leads to a
 * frame does not name it: a link aimed at either would open a window instead.
 */
function namesAFrame(target: string): boolean {
  if (target === '' || IN_PLACE.has(target.toLowerCase()) || target.toLowerCase() === '_blank') return false
  const FRAMES = 'iframe, frame, object'
  for (const frame of document.querySelectorAll(FRAMES)) if (goesBy(frame, target, true)) return true
  for (let n = shadowRoots.length - 1; n >= 0; n--) {
    const root = shadowRoots[n]!.deref()
    if (!root) {
      shadowRoots.splice(n, 1)
      continue
    }
    for (const frame of root.querySelectorAll(FRAMES)) if (goesBy(frame, target, false)) return true
  }
  return false
}
/** The browser's own ways of writing an attribute, which It writes by: the page's are wrapped below, to set right what the page writes. */
const setAttr = Element.prototype.setAttribute
const removeAttr = Element.prototype.removeAttribute
/**
 * Gives a link or a form `noopener` and `noreferrer`, and takes `opener` away: any window it
 * opens and the page have no hold on each other. Every link and form has them, whatever its
 * target, so that no reckoning of which target opens a window, from its own, its button's or the
 * page's `<base>`, as they are now or as a handler makes them, can leave one with a hold. They
 * change nothing where a link or a form is followed in place or in a frame of the page's, which
 * the browser follows as before.
 */
function withNoHold(el: Element): void {
  const said = el.getAttribute('rel')
  const words = (said ?? '').split(/\s+/).filter(Boolean)
  const kept = words.filter((word) => word.toLowerCase() !== 'opener')
  for (const word of ['noopener', 'noreferrer']) if (!kept.some((w) => w.toLowerCase() === word)) kept.push(word)
  if (said === null || kept.length !== words.length || kept.some((word, n) => word !== words[n])) setAttr.call(el, 'rel', kept.join(' '))
}
/** What a link's own target and rel were before It sent it to a tab of its own, to be put back once it leads to another site no longer. */
const pageSaid = new WeakMap<Element, { target: string | null; rel: string | null }>()
const put = (el: Element, name: string, value: string | null) => (value === null ? removeAttr.call(el, name) : setAttr.call(el, name, value))
/** What It does to a link: one to another site opens in a tab of its own, and none leaves a hold. */
function guide(el: Element): void {
  if (!isLink(el)) return
  const to = leadsTo(el)
  const target = targetOf(el)
  if (to && elsewhere(to)) {
    if (target.toLowerCase() !== '_blank' && !namesAFrame(target)) {
      pageSaid.set(el, { target: el.getAttribute('target'), rel: pageSaid.get(el)?.rel ?? el.getAttribute('rel') })
      setAttr.call(el, 'target', '_blank')
    }
  } else {
    // It leads within the page now, or to one of its files: it is followed as the page wrote it
    const said = pageSaid.get(el)
    if (said) {
      pageSaid.delete(el)
      put(el, 'target', said.target)
      put(el, 'rel', said.rel)
    }
  }
  withNoHold(el)
}
/** What It does to a form: wherever its answer opens, it leaves no hold. */
function guideForm(form: Element): void {
  if (form.localName !== 'form') return
  withNoHold(form)
}
/** Everything It does to an element of the page as it appears or changes. */
function tend(el: Element): void {
  quieten(el)
  guide(el)
  guideForm(el)
}
function tendWithin(root: ParentNode): void {
  quietenWithin(root)
  for (const el of root.querySelectorAll('a, area, form')) {
    guide(el)
    guideForm(el)
  }
}
const watcher = new MutationObserver((changes) => {
  for (const change of changes) {
    if (change.type === 'attributes') tend(change.target as Element)
    else
      for (const added of change.addedNodes) {
        if (added.nodeType !== Node.ELEMENT_NODE) continue
        tend(added as Element)
        tendWithin(added as Element)
        reachWithin(added as Element)
      }
  }
})
const WATCHED: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['name', 'content', 'referrerpolicy', 'ping', 'href', 'target', 'rel'],
}
tendWithin(document)

// What the page writes of what It looks after on an element is set right at once, and not only
// when the observer next runs: a handler of the page's can change a link, a form or the page's
// `<base>` and have the browser follow it in the same turn, before any observer is told, and
// whether or not the event goes on to where It hears it. So every way of writing such an
// attribute tends the element as it returns: the methods and the attribute nodes, the properties
// that reflect them, and a link's or a form's `relList`.
const LOOKED_AFTER = new Set([...(WATCHED.attributeFilter ?? []), 'formtarget'])
const looksAfter = (name: unknown) => typeof name === 'string' && LOOKED_AFTER.has(name.replace(/^.*:/, '').toLowerCase())
let tendingNow = false
function tendNow(el: unknown): void {
  if (tendingNow || !(el instanceof Element)) return
  tendingNow = true
  try {
    if (el.localName === 'base') {
      tendWithin(document)
      for (const ref of shadowRoots) {
        const root = ref.deref()
        if (root) tendWithin(root)
      }
    } else if (el.localName === 'button' || el.localName === 'input') {
      const form = (el as HTMLButtonElement).form
      if (form) guideForm(form)
    } else tend(el)
  } finally {
    tendingNow = false
  }
}
type Given = unknown[]
/** What a browser's prototype holds, read by name. */
type Loose = any
/**
 * Wraps a method so that the element it wrote to is tended as it returns, where it wrote something
 * It looks after. The attribute name it was given, at `named`, is made a string once, before the
 * browser's own method has it, so that what It reads is what the browser wrote: a name that says
 * one thing to It and another to the browser cannot pass by.
 */
function afterCalling(
  owner: Loose,
  name: string,
  elementOf: (self: Loose, given: Given) => unknown,
  wrote: (self: Loose, given: Given) => boolean,
  named?: number,
): void {
  const native = owner?.[name]
  if (typeof native !== 'function') return
  owner[name] = function (this: unknown, ...given: Given) {
    if (named !== undefined && given.length > named) given[named] = `${given[named]}`
    const out = native.apply(this, given)
    if (wrote(this, given)) tendNow(elementOf(this, given))
    return out
  }
}
/** Wraps a property's setter so that the element it wrote to is tended as it returns. */
function afterSetting(owner: Loose, name: string, elementOf: (self: Loose) => unknown = (self) => self): void {
  const said = owner && Object.getOwnPropertyDescriptor(owner, name)
  if (!said?.set) return
  const set = said.set
  Object.defineProperty(owner, name, {
    ...said,
    set(this: unknown, value: unknown) {
      set.call(this, value)
      tendNow(elementOf(this))
    },
  })
}
/** Whose each attribute map, rel list and SVG link's target or address is, as the page is given it. */
const ownersOf = new WeakMap<object, Element>()
function noteOwner(owner: Loose, name: string): void {
  const said = owner && Object.getOwnPropertyDescriptor(owner, name)
  if (!said?.get) return
  const get = said.get
  Object.defineProperty(owner, name, {
    ...said,
    get(this: Element) {
      const it = get.call(this)
      if (it && typeof it === 'object') ownersOf.set(it, this)
      return it
    },
  })
}
const itself = (it: unknown) => it
const E = Element.prototype
afterCalling(E, 'setAttribute', itself, (_, given) => looksAfter(given[0]), 0)
afterCalling(E, 'setAttributeNS', itself, (_, given) => looksAfter(given[1]), 1)
afterCalling(E, 'removeAttribute', itself, (_, given) => looksAfter(given[0]), 0)
afterCalling(E, 'removeAttributeNS', itself, (_, given) => looksAfter(given[1]), 1)
afterCalling(E, 'toggleAttribute', itself, (_, given) => looksAfter(given[0]), 0)
for (const name of ['setAttributeNode', 'setAttributeNodeNS', 'removeAttributeNode'])
  afterCalling(E, name, itself, (_, given) => looksAfter((given[0] as Attr | null)?.name))
// An attribute node written by itself, or put in or taken out of an element's attributes
const ownerOfAttr = (it: Loose) => (it?.nodeType === 2 && looksAfter(it.name) ? it.ownerElement : null)
afterSetting(Attr.prototype, 'value', ownerOfAttr)
afterSetting(Node.prototype, 'nodeValue', ownerOfAttr)
afterSetting(Node.prototype, 'textContent', ownerOfAttr)
noteOwner(E, 'attributes')
const MAP = typeof NamedNodeMap === 'function' ? NamedNodeMap.prototype : undefined
const mapOwner = (it: object) => ownersOf.get(it)
for (const name of ['setNamedItem', 'setNamedItemNS']) afterCalling(MAP, name, mapOwner, (_, given) => looksAfter((given[0] as Attr | null)?.name))
afterCalling(MAP, 'removeNamedItem', mapOwner, (_, given) => looksAfter(given[0]), 0)
afterCalling(MAP, 'removeNamedItemNS', mapOwner, (_, given) => looksAfter(given[1]), 1)
// The properties that reflect them
const LINKS = ['target', 'rel', 'href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'referrerPolicy', 'ping']
const REFLECTING: [string, string[]][] = [
  ['HTMLAnchorElement', LINKS],
  ['HTMLAreaElement', LINKS],
  ['HTMLFormElement', ['target', 'rel']],
  ['HTMLBaseElement', ['target', 'href']],
  ['HTMLButtonElement', ['formTarget']],
  ['HTMLInputElement', ['formTarget']],
  ['HTMLMetaElement', ['content', 'name']],
]
const kinds = window as unknown as Record<string, { prototype: object } | undefined>
for (const [kind, names] of REFLECTING) for (const name of names) afterSetting(kinds[kind]?.prototype, name)
// A link's or a form's rel as a list of words, and an SVG link's target and address
for (const kind of ['HTMLAnchorElement', 'HTMLAreaElement', 'HTMLFormElement']) noteOwner(kinds[kind]?.prototype, 'relList')
const TOKENS = typeof DOMTokenList === 'function' ? DOMTokenList.prototype : undefined
for (const name of ['add', 'remove', 'toggle', 'replace']) afterCalling(TOKENS, name, mapOwner, (it) => ownersOf.has(it))
afterSetting(TOKENS, 'value', (it) => ownersOf.get(it) ?? null)
for (const name of ['target', 'href']) noteOwner(kinds.SVGAElement?.prototype, name)
afterSetting(kinds.SVGAnimatedString?.prototype, 'baseVal', (it) => ownersOf.get(it) ?? null)

/** Asks the site to open an address in a tab of its own. Sent on the window, so that the browser still counts the person's click when the site opens it. */
function openedBySite(href: string): void {
  window.parent.postMessage({ type: 'it:open', url: href } satisfies PageToSite, config.app)
}
/** The link a click or a key followed, which is the nearest one around what was clicked. */
const linkIn = (path: EventTarget[]) => path.find((el): el is Element => el instanceof Element && isLink(el))
/**
 * Whether a link, followed now, would open a window of a kind that is never opened. `aside` is
 * a way of following it that opens a window of its own whatever its target says: the middle
 * button, a click with a key that asks for a new tab or window, the link's menu, and dragging it
 * out of the page. A `javascript:` link opened so is nothing, and its menu is left to it.
 */
function opensRefused(link: Element, aside = false): boolean {
  const to = leadsTo(link)
  if (!to || !REFUSED.has(to.protocol) || link.hasAttribute('download')) return false
  if (aside) return to.protocol !== 'javascript:'
  const target = targetOf(link)
  // Followed in the frame, `javascript:` runs the page's own script, as it does on any page. A
  // refused `_top` or `_parent` is counted with the windows, since WebKit opens one for it
  return target.toLowerCase() !== '' && target.toLowerCase() !== '_self' && !namesAFrame(target)
}
/** Whether an event follows a link aside, in a window of its own whatever its target says. */
const aside = (e: Event) => e.type !== 'click' || (e instanceof MouseEvent && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey))
/** Every way a link is followed, and the key that follows the one that has the focus. */
const FOLLOWING = ['click', 'auxclick', 'contextmenu', 'dragstart', 'keydown']
/** The link each of those was on, as deep as It has seen it: a shadow root that hides its inside from the window tells It of the link there itself. */
const followedIn = new WeakMap<Event, Element>()
/**
 * What It does on the way to a link being followed, before the page's own handlers (`capture`)
 * and again after them, since a script can change a link or activate it before the observer has
 * run. The window hears of every link in the document, and each shadow root a script makes
 * hears of its own.
 */
function onTheWay(e: Event, capture: boolean, sends = true): void {
  const path = e.composedPath()
  for (const el of path)
    if (el instanceof Element) {
      stopAuditing(el)
      guide(el)
    }
  // Seen from outside in, so that each listener that sees deeper says which link it was
  const seen = linkIn(path)
  if (capture && seen) followedIn.set(e, seen)
  const link = followedIn.get(e) ?? seen
  // A closed shadow root hides the link from the window's path: it is set right as it stands now, after the page's handlers too
  if (link && !path.includes(link)) {
    stopAuditing(link)
    guide(link)
  }
  if (e.type === 'keydown' || !link) return
  if (opensRefused(link, aside(e))) {
    e.preventDefault()
    return
  }
  // After the page's own handlers, which may have taken the click for themselves. Only the
  // window sends a link to the site, once, and after every handler of the page's
  if (capture || !sends || e.type !== 'click' || e.defaultPrevented) return
  const to = leadsTo(link)
  // Left to the browser where the site does not open links, as before it did
  if (to && SYSTEM.has(to.protocol) && !link.hasAttribute('download') && siteOpens()) {
    e.preventDefault()
    openedBySite(to.href)
  }
}
/** What hears links followed: in the window, before the page's handlers and after them, and in a root, after the handlers there. Each is one function, so that putting it back where it is already does nothing. */
const followedBefore = (e: Event) => onTheWay(e, true)
const followedAfter = (e: Event) => onTheWay(e, false)
const followedAfterInRoot = (e: Event) => onTheWay(e, false, false)
/**
 * A form is checked on its way out too, and again once every handler of the submit event has
 * run, as its data is gathered, just before the browser reads its target and rel. Neither event
 * leaves a shadow root, so each root It reaches hears them for its own forms, as the window does
 * for the document's.
 */
const FORMS = ['submit', 'formdata']
const onItsWayOut = (e: Event) => {
  if (e.target instanceof Element) guideForm(e.target)
}
/** Whatever the page's own markup declares, once it is all parsed. */
const reachAll = () => reachWithin(document)
/**
 * What the window hears of links and forms, what each root It reached hears, and what the
 * observer watches. Opening a document again, as `document.open` does, and `document.write` once
 * the page has loaded, takes every listener away from the window and from everything in that
 * document, its roots too: so they are all put back each time, and putting back one that is there
 * already does nothing.
 */
function listen(): void {
  for (const event of FOLLOWING) {
    window.addEventListener(event, followedBefore, true)
    window.addEventListener(event, followedAfter)
  }
  for (const event of FORMS) window.addEventListener(event, onItsWayOut, true)
  document.addEventListener('DOMContentLoaded', reachAll)
  watcher.observe(document, WATCHED)
  for (const ref of shadowRoots) {
    const root = ref.deref()
    if (root) hearIn(root)
  }
}
listen()
/**
 * A shadow root hides what is in it from the document's observer, and a closed one hides it from
 * the window's listeners as well. So each root It can reach is watched as the document is and
 * hears of the links and forms followed in it, before the handlers inside it and again after
 * them, since a handler there may change a link and keep the event from going further. It reaches
 * every root a script makes, open or closed, and every open one declared in markup: as the page is
 * parsed, set with `setHTMLUnsafe`, parsed with `Document.parseHTMLUnsafe` or written. A closed
 * root declared in markup is given to no script, and is the one It cannot reach.
 */
const reached = new WeakSet<ShadowRoot>()
function reach(root: ShadowRoot): void {
  if (reached.has(root)) return
  reached.add(root)
  shadowRoots.push(new WeakRef(root))
  hearIn(root)
  tendWithin(root)
  reachWithin(root)
}
/** What a root hears and how it is watched: put again wherever opening a document took it away. */
function hearIn(root: ShadowRoot): void {
  watcher.observe(root, WATCHED)
  for (const event of FOLLOWING) {
    root.addEventListener(event, followedBefore, true)
    root.addEventListener(event, followedAfterInRoot)
  }
  for (const event of FORMS) root.addEventListener(event, onItsWayOut, true)
}
/** Reaches every open root declared within, and within those, walking the elements once. */
function reachWithin(within: Node): void {
  if (within instanceof Element && within.shadowRoot) reach(within.shadowRoot)
  const walk = document.createTreeWalker(within, NodeFilter.SHOW_ELEMENT)
  for (let el = walk.nextNode() as Element | null; el; el = walk.nextNode() as Element | null) if (el.shadowRoot) reach(el.shadowRoot)
}
const attachShadow = Element.prototype.attachShadow
Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
  const root = attachShadow.call(this, init)
  reach(root)
  return root
}
// Markup with declared roots in it, set into an element or a root, or parsed into a document of its own
for (const owner of [Element.prototype, typeof ShadowRoot === 'function' ? ShadowRoot.prototype : undefined] as Loose[]) {
  const native = owner?.setHTMLUnsafe
  if (typeof native !== 'function') continue
  owner.setHTMLUnsafe = function (this: ParentNode, ...given: Given) {
    const out = native.apply(this, given)
    tendWithin(this)
    reachWithin(this)
    return out
  }
}
const parseUnsafe = (Document as Loose).parseHTMLUnsafe
if (typeof parseUnsafe === 'function')
  (Document as Loose).parseHTMLUnsafe = function (this: unknown, ...given: Given) {
    const parsed = parseUnsafe.apply(this, given)
    tendWithin(parsed)
    reachWithin(parsed)
    return parsed
  }
// A link or a form the page made and never put in the document is activated with no event
// reaching the window: it is checked here instead, on its way
/**
 * What a script makes follow a link or send a form, by a click it sends, `click()`,
 * `requestSubmit()` or `submit()`, is set right first: from the element up through every root it
 * is in, each root is reached, so that it hears what follows, and each link and form on the way,
 * and the form of a button, is given what It gives them. So nothing a script follows depends on It
 * having reached the root it was made in, however that root came about, nor on the window's
 * listeners being there at that moment, as they are not while a document is being written again.
 */
function beforeFollowing(target: unknown): void {
  for (let node = target instanceof Node ? target : null; node; ) {
    if (node instanceof ShadowRoot) {
      reach(node)
      node = node.host
      continue
    }
    if (node instanceof Element) {
      guide(node)
      guideForm(node)
      const form = (node as HTMLButtonElement).form
      if (form instanceof Element) guideForm(form)
    }
    node = node.parentNode
  }
}
const dispatch = EventTarget.prototype.dispatchEvent
EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
  if (event?.type === 'click') beforeFollowing(this)
  return dispatch.call(this, event)
}
const requestSubmit = HTMLFormElement.prototype.requestSubmit
if (typeof requestSubmit === 'function')
  HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement, ...given: [HTMLElement?]) {
    beforeFollowing(this)
    if (given[0]) beforeFollowing(given[0])
    return requestSubmit.apply(this, given)
  }
const clickElement = HTMLElement.prototype.click
HTMLElement.prototype.click = function (this: HTMLElement) {
  beforeFollowing(this)
  if (!this.isConnected) {
    if (isLink(this)) {
      const to = leadsTo(this)
      if (opensRefused(this)) return
      if (to && SYSTEM.has(to.protocol) && !this.hasAttribute('download') && siteOpens()) return openedBySite(to.href)
    }
  }
  return clickElement.call(this)
}
const submitForm = HTMLFormElement.prototype.submit
HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
  beforeFollowing(this)
  return submitForm.call(this)
}

const openWindow = window.open
function openOut(this: Window, url?: string | URL, target?: string, features?: string): WindowProxy | null {
  quietenWithin(document)
  const said = url === undefined || url === null ? '' : String(url)
  const to = said === '' ? null : addressOf(said)
  if (to && REFUSED.has(to.protocol)) return null
  if (to && SYSTEM.has(to.protocol)) {
    if (siteOpens()) {
      openedBySite(to.href)
      return null
    }
    // A site that does not open links leaves it to the browser, in a tab of its own with no hold
    return openWindow.call(this, said, '_blank', 'noopener,noreferrer')
  }
  const named = target === undefined || target === null ? '' : String(target)
  const asked = features === undefined || features === null ? '' : String(features)
  // Each is made a string once, and that string is what the browser is given: an address, a name or
  // features that said one thing to It and another to the browser could not pass by
  // A frame inside the page is the page's own to follow a link in, as it asked
  const address = url === undefined ? undefined : said
  if (namesAFrame(named)) return openWindow.call(this, address, named, features === undefined ? undefined : asked)
  // One to another site opens in a tab of its own, as a link to one does
  const where = to && elsewhere(to) ? '_blank' : named || '_blank'
  // What is said last of a feature is what is taken
  return openWindow.call(this, address, where, `${asked}${asked.trim() ? ',' : ''}noopener,noreferrer`)
}
window.open = openOut
// Given an address, a name and features, `document.open` opens a window as `window.open` does,
// and in Firefox hands the page that window, of the page's own origin, with all of its own
// functions. It is held to the same.
const openDocument = Document.prototype.open as (...given: unknown[]) => unknown
Document.prototype.open = function (this: Document, ...given: unknown[]) {
  if (given.length > 2) return openOut.call(window, given[0] as string | URL, given[1] as string, given[2] as string)
  const out = openDocument.apply(this, given)
  // Any document opened again, the page's or one a host was moved into, has lost its listeners
  listen()
  return out
} as typeof Document.prototype.open
// Writing to a document once it has been parsed may open it again first, which takes every
// listener away: they are put back as the writing returns, and what was written, roots declared
// in it too, is set right then, as it is after any writing to a document other than the page's,
// which the page's observer does not watch. Meanwhile what a script written in it follows is set
// right as it is followed (beforeFollowing). The browser's own writing is left as it is, writes it
// ignores included
for (const name of ['write', 'writeln'] as const) {
  const native = Document.prototype[name]
  Document.prototype[name] = function (this: Document, ...given: string[]) {
    const parsed = this.readyState !== 'loading'
    const out = native.apply(this, given)
    if (parsed || this !== document) {
      listen()
      tendWithin(this)
      reachWithin(this)
    }
    return out
  }
}

// What the page's own script fails with is said to the site, which says it above the page. The
// person cannot see a script fail: they see a button that does nothing, and take it for an
// agent that does not answer. Only the first few are said: a script that fails on every
// frame would otherwise say it sixty times a second.
let faults = 0
function fault(message: unknown): void {
  if (faults >= 3) return
  faults++
  const text = typeof message === 'string' && message ? message : 'a script on this page failed'
  send({ type: 'it:fault', message: text.slice(0, 300) })
}
window.addEventListener('error', (e) => {
  // A picture or a stylesheet that did not load raises an event here too, with no message: that is not a script failing
  if (e instanceof ErrorEvent && e.message) fault(e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  const why = (e as PromiseRejectionEvent).reason
  fault(why instanceof Error ? `${why.name}: ${why.message}` : typeof why === 'string' ? why : undefined)
})

// A file put anywhere in what an action carries (a `File` from an input or a drop, a `Blob` a
// canvas made) goes with the action, beside what it carries, and its agent saves it as a file.
// A photo is made smaller first, to about what a model reads a picture at, unless the page asks
// for the file as it is. That is done here, in the page's own frame, so that the site never
// opens a file a page chose.

/** What a page may say of an action beside its name and what it carries. */
interface Sending {
  /** Send every file as it is, a photo included, which is otherwise made smaller first. */
  original?: boolean
}

/** A picture made smaller, as a JPEG of no more than so many pixels on its longer side, or the file as it was where it is no such picture, is small already, or cannot be read here. */
async function smaller(file: Blob): Promise<Blob> {
  if (!(SHRINK.types as readonly string[]).includes(file.type.toLowerCase()) || typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    // Turned the way the camera said it was held, as a person sees it
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    return file
  }
  try {
    const longer = Math.max(bitmap.width, bitmap.height)
    if (longer <= SHRINK.side && file.size <= SHRINK.smallBytes) return file
    const scale = Math.min(1, SHRINK.side / longer)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
    const draw = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!draw) return file
    // On white, as on paper: what was clear would otherwise be black in a JPEG
    draw.fillStyle = '#fff'
    draw.fillRect(0, 0, width, height)
    draw.drawImage(bitmap, 0, 0, width, height)
    const made =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: SHRINK.quality })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', SHRINK.quality))
    // Only where it is smaller in the end: a picture small enough in pixels may be one JPEG would make larger
    if (!made || (made.size >= file.size && longer <= SHRINK.side)) return file
    const named = typeof (file as File).name === 'string' && (file as File).name ? (file as File).name.replace(/\.[^.]*$/, '') : 'picture'
    return new File([made], `${named}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}

/** Whether something is a plain object, as JSON has them, of this document or of another the page made. */
const plain = (v: object): boolean => {
  const kind = Object.getPrototypeOf(v)
  return kind === null || Object.getPrototypeOf(kind) === null
}
/** Whether what an action carries holds a file, looked for within a fixed amount of work: past it, it is sent as it is, for the site to refuse. */
function holdsFile(data: unknown): boolean {
  let looks = 20_000
  const look = (v: unknown, depth: number): boolean => {
    if (--looks < 0 || depth > 40 || typeof v !== 'object' || v === null) return false
    if (v instanceof Blob) return true
    if (Array.isArray(v)) return v.some((x) => look(x, depth + 1))
    if (!plain(v)) return false
    return Object.values(v).some((x) => look(x, depth + 1))
  }
  return look(data, 0)
}

/**
 * A copy of what an action carries as it is at this moment, within a fixed amount of work: its
 * objects and lists are copied, and a file is the same file, which nothing can change. Anything
 * else stands as it is, for the channel to copy or refuse. Past the work, it throws: what is
 * that large is more than the site takes.
 */
function takenNow(data: unknown): unknown {
  let looks = 40_000
  const copy = (v: unknown, depth: number): unknown => {
    if (--looks < 0) throw new Error('too much to look through')
    if (v instanceof Blob || depth > 40 || typeof v !== 'object' || v === null) return v
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1))
    if (!plain(v)) return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]))
  }
  return copy(data, 0)
}

/**
 * What an action carries, with each picture in it made smaller: a copy, in which each file stands
 * where the page put it. Within the same amount of work as the looking: past it, what the page
 * gave is sent as it is.
 */
async function withSmallerPictures(data: unknown): Promise<unknown> {
  const found = new Set<Blob>()
  let looks = 40_000
  const copy = (v: unknown, depth: number, swap: (file: Blob) => Blob): unknown => {
    if (--looks < 0) throw new Error('too much to look through')
    if (v instanceof Blob) return swap(v)
    if (depth > 40 || typeof v !== 'object' || v === null) return v
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1, swap))
    if (!plain(v)) return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1, swap)]))
  }
  try {
    copy(data, 0, (file) => {
      found.add(file)
      return file
    })
  } catch {
    return data
  }
  // Each file once, however often it is named, and one after another: a photo is drawn whole
  // before it is made smaller, and a phone has room for so many of them at once
  const done = new Map<Blob, Blob>()
  for (const file of found) done.set(file, await smaller(file))
  // The same walk again, which the first has shown to fit
  looks = Number.POSITIVE_INFINITY
  return copy(data, 0, (file) => done.get(file) ?? file)
}

// Actions reach the site in the order they were made, though a picture takes a moment to be made
// smaller: while one is being made smaller, each made after it waits for it to be on its way.
// What It answers is not waited for. An action with no picture to make smaller, made while none
// is, is sent at once, as it always was.
let line: Promise<unknown> = Promise.resolve()
let preparing = 0

/** Something the person did. Resolves once It has accepted it, files and all; rejects if it was refused. */
function action(name: string, data?: unknown, sending?: Sending): Promise<unknown> {
  if (!name) return Promise.reject(new Error('action(name): a name is required'))
  // What the person was looking at is as it was when they acted, not when the action leaves
  const at = { clientActionId: id(), contentVersion: config.version, baseStateRevision: revision }
  const carried = data ?? {}
  const post = (payload: unknown) => {
    const envelope: ActionEnvelope = { v: 1, ...at, name, payload }
    return ask({ type: 'it:action', requestId: id(), envelope }).then((result) =>
      result.ok ? { ok: true, id: result.actionId } : Promise.reject(new Error(result.error)),
    )
  }
  const shrinking = sending?.original !== true && holdsFile(carried)
  if (!shrinking && preparing === 0) return post(carried)
  // An action that waits is sent as it was when the person acted: what it carries is copied now,
  // and a change the page makes to it afterwards is not sent with it
  let taken: unknown
  try {
    taken = takenNow(carried)
  } catch {
    return Promise.reject(new Error('That is too large to send.'))
  }
  preparing++
  // Its pictures are begun only once the action before it is on its way, so that a phone holds
  // one photo drawn whole at a time, however many actions are sent at once
  const turn = line.then(() => (shrinking ? withSmallerPictures(taken) : taken))
  line = turn.then(
    () => {},
    () => {},
  )
  return turn.then(
    (payload) => {
      preparing--
      return post(payload)
    },
    (err) => {
      preparing--
      throw err
    },
  )
}

// Stage and commit: clicks along the way (picking options, toggling) stay in the page, and one
// commit sends the whole picture as a single action, so the agent wakes once, on what the
// person actually decided.
// Every time something is staged under a name it gets the next number. A commit clears only
// what still has the number it had when the commit was sent, so a choice changed while the
// commit was on its way is kept, even if it is the same object changed in place.
let stageCount = 0
const stagedAt: Record<string, number> = {}
function stage(key: string, value: unknown): Record<string, unknown> {
  if (value === undefined) {
    delete staged[key]
    delete stagedAt[key]
  } else {
    staged[key] = value
    stagedAt[key] = ++stageCount
  }
  return { ...staged }
}
function commit(name: string, extra?: Record<string, unknown>, sending?: Sending): Promise<unknown> {
  // What was sent is cleared only once the action is accepted, so a failure does not lose what
  // was chosen. Anything staged or changed while the answer was on its way was not sent, and stays.
  const sent = { ...stagedAt }
  return action(name, { ...staged, ...(extra ?? {}) }, sending).then((res) => {
    for (const key of Object.keys(sent)) {
      if (stagedAt[key] !== sent[key]) continue
      delete staged[key]
      delete stagedAt[key]
    }
    return res
  })
}

// The microphone and the camera. No browser gives either to a sandboxed document, which a page
// is, so the site opens them for the page, and passes it what they give as it comes: the camera's
// pictures and the microphone's sound, of which the page makes a stream of its own. A page's call
// is its asking: It asks the person at the screen, once, in It's own bar, and the browser asks
// too the first time. It's bar says what is live for as long as it is, and the person can stop it
// there.

/**
 * It does not record for a page. A page that hears the microphone or sees the camera live records
 * the stream it holds itself, and one that calls for a recording is told so.
 */
function record(): Promise<never> {
  return Promise.reject(
    new Error(
      'It does not record for a page. Open the microphone with It.microphone(), or the camera with It.camera({ audio: true }), and record the stream it gives with a MediaRecorder of the page’s own.',
    ),
  )
}

let photos = 0
/**
 * A photo from the camera. It shows the person its own view of the camera, they take the photo
 * there or close it, and the page is given the photo as a JPEG file, to send with `It.action`.
 * The person allows the camera for the page on each screen, as for `It.camera`. `facing` is `user` for the camera that faces the person, and `environment`
 * for the one on the back of a phone.
 */
async function photo(options: { facing?: 'user' | 'environment' } = {}): Promise<File> {
  const said = await done({ type: 'it:photo', requestId: id(), ...(options.facing ? { facing: options.facing } : {}) })
  if (!said.file) throw new Error('No photo was taken.')
  // The kind alone: a file's kind is kept as a kind and nothing more
  const type = (said.file.type || 'image/jpeg').split(';')[0]!.trim()
  return new File([said.file], `photo-${++photos}.jpg`, { type })
}

// Sound, live. The site sends the microphone's sound in small pieces, each a run of samples of
// one channel, and the page plays each straight after the one before into a stream of its own:
// for an audio element, a meter, a recorder, or a call the page makes itself with
// RTCPeerConnection. A browser starts sound for a page only once the person has done something
// in it, so what plays the pieces is made in the page's own call, which is to come from a click.
// Each piece is said to be taken once it is, and the site sends more only then, so a page that
// falls behind is sent less sound and never a pile of it.

/**
 * How the pieces are played. `slackS`: how far ahead of now the first piece, and the first after a
 * gap, is played, so that the next has come by the time it is due. `behindS`: how near to now the
 * next piece's moment may come before that counts as a gap. `aheadS`: how far ahead of now sound
 * may be waiting to play before a piece is passed over, so that pieces that come in a rush do not
 * leave the page hearing later and later. `startMs`: how long the browser is given to start sound.
 */
const SOUND = { slackS: 0.04, behindS: 0.01, aheadS: 0.2, startMs: 400, mostSamples: 16_384 } as const
/** What plays the pieces of sound a page is sent into a stream the page holds. */
interface Player {
  readonly stream: MediaStream
  /** Plays one piece after the last, or passes it over where too much is waiting already. */
  play(samples: ArrayLike<number>, sampleRate: number): void
  close(): void
}
/**
 * Makes what plays the sound, and starts it. It is made and started in the turn of the page's own
 * call, before anything is waited for, which is when a browser still counts the person's click.
 * Rejects where this browser has no way to do it, and where it would not start, which it does not
 * for a page nobody has clicked or typed in. `by` is the call it is for, as the page is told.
 */
async function playerFor(by: string): Promise<Player> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let context: AudioContext | null = null
  try {
    if (typeof Context === 'function') context = new Context()
  } catch {}
  if (!context || typeof context.createMediaStreamDestination !== 'function') {
    void context?.close().catch(() => {})
    throw new Error('This browser cannot make a stream of the microphone’s sound.')
  }
  const made = context
  if (made.state !== 'running') {
    // Asked to start now, within the person's click. Where the browser will not, it leaves this waiting, so it is given a moment and no longer
    const started = made.resume().catch(() => {})
    await Promise.race([started, new Promise((resolve) => setTimeout(resolve, SOUND.startMs))])
  }
  if (made.state !== 'running') {
    void made.close().catch(() => {})
    throw new Error(
      `${by} was not called from a click or a key in the page, and a browser starts sound for a page only once the user has done something in it. Call it from something the user does on the page, such as a button.`,
    )
  }
  const out = made.createMediaStreamDestination()
  /** When the next piece is to play, by the clock of what plays them. */
  let next = 0
  let closed = false
  return {
    stream: out.stream,
    play(samples, sampleRate) {
      if (closed) return
      const now = made.currentTime
      // Nothing is waiting: this piece plays a moment from now, so that the next has come when it is due
      if (next < now + SOUND.behindS) next = now + SOUND.slackS
      // Too much is waiting: this piece is passed over, and the page does not fall further behind
      else if (next - now > SOUND.aheadS) return
      try {
        const piece = made.createBuffer(1, samples.length, sampleRate)
        piece.getChannelData(0).set(samples)
        const source = made.createBufferSource()
        source.buffer = piece
        source.connect(out)
        source.start(next)
        next += piece.duration
      } catch {
        // A piece this browser cannot play, as at a rate it does not take, is passed over
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const t of out.stream.getTracks()) t.stop()
      void made.close().catch(() => {})
    },
  }
}
/** What takes the sound the site sends, by the id the page named its microphone, or its camera with sound, by: a piece is handed to it, and a microphone is told how it stands. */
const hearing = new Map<
  string,
  { sound: (chunk: number, sampleRate: number, samples: Float32Array) => void; told?: (state: MicrophoneState, why?: string) => void }
>()
/** What the site sent of a live microphone, or of the sound of a camera opened with it. Sound for nothing the page holds is let go. */
function heard(message: Extract<SiteToPage, { type: 'it:microphone-sound' | 'it:microphone-state' }>): void {
  const held = hearing.get(message.microphone)
  if (!held) return
  if (message.type === 'it:microphone-state') held.told?.(message.state, message.why)
  else {
    const samples = message.samples as unknown as Float32Array | null
    // Only a run of samples of a sensible length is played; whatever it is, it is said to be taken, so that the next comes
    if (
      Object.prototype.toString.call(samples) === '[object Float32Array]' &&
      samples !== null &&
      samples.length > 0 &&
      samples.length <= SOUND.mostSamples &&
      message.sampleRate > 0
    )
      held.sound(message.chunk, message.sampleRate, samples)
    send({ type: 'it:microphone-heard', microphone: message.microphone, chunk: message.chunk })
  }
}

// The camera, live. The site opens it and sends the page each picture it gives, and the page
// draws each onto a canvas of its own, whose stream is the camera's picture as the page has it:
// for a video element, or for a call the page makes itself with RTCPeerConnection. Each picture
// is said to be drawn once it is, and the site sends the next only then, so a page that is slow
// to draw is sent fewer pictures and never a pile of them. Opened with sound, the microphone's
// sound is played into the same stream, as a live microphone's is into its own.

type CameraState = 'live' | 'paused' | 'ended'
/** Why the live camera ended without the page asking, as the site says it. */
const CAMERA_ENDED: Record<string, string> = {
  person: 'The person stopped the camera in It’s bar.',
  taken_back: 'The person took back what they had allowed this page.',
  not_shown: 'The page was closed while the camera was live.',
  replaced: 'The page loaded another document while the camera was live.',
  device: 'The camera stopped giving pictures.',
  taken_over: 'Another conversation took this page over.',
}
interface Camera {
  /** The camera's picture, as a stream: for a video element's `srcObject`, or a track to send in a call. Opened with sound, it has the microphone's sound as well. */
  readonly stream: MediaStream
  /** The size of the last picture, or 0 before the first. */
  readonly width: number
  readonly height: number
  /** Live, paused (while the screen does not show It), or ended. */
  readonly state: CameraState
  /** Called with each picture, as an ImageBitmap, once it is drawn into the stream. It is closed when the call returns. */
  onframe: ((picture: ImageBitmap) => void) | null
  /** Called each time the state changes without the page asking, with the reason where it ended. */
  onchange: ((state: CameraState, why?: string) => void) | null
  /** Closes the camera. */
  stop(): Promise<void>
}
/** The live cameras the page holds, by the id the page named each by: what the site sends is handed to them. */
const cameras = new Map<string, { picture: (frame: number, picture: ImageBitmap) => void; heard: (state: CameraState, why?: string) => void }>()
/** What the site sent of a live camera. A picture for no camera the page holds is closed, and nothing more is done with it. */
function seen(message: Extract<SiteToPage, { type: 'it:camera-frame' | 'it:camera-state' }>): void {
  const held = cameras.get(message.camera)
  if (message.type === 'it:camera-state') held?.heard(message.state, message.why)
  else if (held) held.picture(message.frame, message.picture as unknown as ImageBitmap)
  else message.picture?.close?.()
}

/**
 * Opens the camera live, and gives its picture as a stream the page holds. Resolves once the
 * camera is open. The person allows the camera for the page on each screen, as for `It.photo`.
 * `facing` is `user` for the camera that faces the person and `environment` for the one on the
 * back of a phone; `width`, `height` and `frameRate` are what the camera is asked for, and it
 * gives what it can. With `audio`, which is `true` or what is asked of the microphone, such as
 * `{ echoCancellation: false }`, the stream has the microphone's sound too, the person allows
 * both, and the call is to come from a click or a key in the page.
 */
async function camera(
  options: {
    facing?: 'user' | 'environment'
    facingMode?: 'user' | 'environment'
    width?: number
    height?: number
    frameRate?: number
    audio?: boolean | Record<string, unknown>
  } = {},
): Promise<Camera> {
  const canvas = document.createElement('canvas')
  const drawing = canvas.getContext('2d')
  if (!drawing || typeof canvas.captureStream !== 'function') throw new Error('This browser cannot make a stream of the camera’s pictures.')
  const audio = options.audio === undefined || options.audio === null || options.audio === false ? undefined : options.audio
  // What plays the microphone's sound is made first, and at once, while the browser still counts the click that called
  const sound = audio === undefined ? null : await playerFor('It.camera with audio')
  // A frame of the stream each time a picture is drawn, as the camera gives them
  const stream = canvas.captureStream()
  if (sound) for (const t of sound.stream.getAudioTracks()) stream.addTrack(t)
  const named = id()
  let state: CameraState = 'live'
  let why: string | undefined
  let width = 0
  let height = 0
  /** Lets go of the stream: a video element that shows it, and a call that sends it, see it end. */
  const over = () => {
    state = 'ended'
    cameras.delete(named)
    hearing.delete(named)
    for (const t of stream.getTracks()) t.stop()
    sound?.close()
  }
  // Made before the camera is asked for: a picture can come before the answer does
  const live: Camera = {
    stream,
    get width() {
      return width
    },
    get height() {
      return height
    },
    get state() {
      return state
    },
    onframe: null,
    onchange: null,
    stop: async () => {
      if (state === 'ended') return
      over()
      // Refused only where the site has closed it already, which is what was asked
      await done({ type: 'it:camera-stop', requestId: id(), camera: named }).catch(() => {})
    },
  }
  cameras.set(named, {
    picture: (frame, picture) => {
      if (state === 'ended') return picture.close()
      if (width !== picture.width || height !== picture.height) {
        canvas.width = width = picture.width
        canvas.height = height = picture.height
      }
      drawing.drawImage(picture, 0, 0)
      const call = live.onframe
      if (typeof call === 'function')
        try {
          call(picture)
        } catch {
          console.error('[It] a camera’s onframe handler threw')
        }
      picture.close()
      send({ type: 'it:camera-drawn', camera: named, frame })
    },
    heard: (now, said) => {
      if (state === 'ended') return
      if (now === 'ended') {
        why = said
        over()
      } else state = now
      const call = live.onchange
      if (typeof call !== 'function') return
      try {
        call(now, said === undefined ? undefined : (CAMERA_ENDED[said] ?? said))
      } catch {
        console.error('[It] a camera’s onchange handler threw')
      }
    },
  })
  // The camera's sound comes under the camera's own name
  if (sound) hearing.set(named, { sound: (_chunk, sampleRate, samples) => sound.play(samples, sampleRate) })
  const facing = options.facing ?? options.facingMode
  const video = {
    ...(facing === 'user' || facing === 'environment' ? { facingMode: facing } : {}),
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
  }
  try {
    await done({ type: 'it:camera', requestId: id(), camera: named, video, ...(audio === undefined ? {} : { audio }) })
  } catch (err) {
    over()
    throw err
  }
  // Ended by the site while it was being opened: said as that, and not as a camera that is live
  if (live.state === 'ended' && why) throw new Error(CAMERA_ENDED[why] ?? 'The camera has ended.')
  return live
}

// The microphone, live: its sound as a stream the page holds, and each piece of it as it comes.

type MicrophoneState = 'live' | 'paused' | 'ended'
/** Why the live microphone ended without the page asking, as the site says it. */
const MICROPHONE_ENDED: Record<string, string> = {
  person: 'The person stopped the microphone in It’s bar.',
  taken_back: 'The person took back what they had allowed this page.',
  not_shown: 'The page was closed while the microphone was live.',
  replaced: 'The page loaded another document while the microphone was live.',
  device: 'The microphone stopped giving sound.',
  taken_over: 'Another conversation took this page over.',
}
interface Microphone {
  /** The microphone's sound, as a stream: for a meter, a recorder, or a track to send in a call. */
  readonly stream: MediaStream
  /** How many samples of the sound there are in a second. */
  readonly sampleRate: number
  /** Live, paused (while the screen does not show It), or ended. */
  readonly state: MicrophoneState
  /** Called with each piece of sound as it comes: its samples, of one channel, each from -1 to 1, and how many there are in a second. */
  onsound: ((samples: Float32Array, sampleRate: number) => void) | null
  /** Called each time the state changes without the page asking, with the reason where it ended. */
  onchange: ((state: MicrophoneState, why?: string) => void) | null
  /** Closes the microphone. */
  stop(): Promise<void>
}

/**
 * Opens the microphone live, and gives its sound as a stream the page holds. Resolves once the
 * microphone is open. It is to be called from a click or a key in the page, which is when a
 * browser lets a page start sound. The person allows the microphone for the page on each screen:
 * It asks once, in its bar, and the browser asks too the first time. `echoCancellation`,
 * `noiseSuppression` and `autoGainControl` are what the microphone is asked for.
 */
async function microphone(options: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean } = {}): Promise<Microphone> {
  // Made first, and at once, while the browser still counts the click that called
  const sound = await playerFor('It.microphone')
  const named = id()
  let state: MicrophoneState = 'live'
  let why: string | undefined
  let sampleRate = 0
  /** Lets go of the stream: whatever listens to it, and a call that sends it, hear it end. */
  const over = () => {
    state = 'ended'
    hearing.delete(named)
    sound.close()
  }
  // Made before the microphone is asked for: sound can come before the answer does
  const live: Microphone = {
    stream: sound.stream,
    get sampleRate() {
      return sampleRate
    },
    get state() {
      return state
    },
    onsound: null,
    onchange: null,
    stop: async () => {
      if (state === 'ended') return
      over()
      // Refused only where the site has closed it already, which is what was asked
      await done({ type: 'it:microphone-stop', requestId: id(), microphone: named }).catch(() => {})
    },
  }
  hearing.set(named, {
    sound: (_chunk, rate, samples) => {
      if (state === 'ended') return
      sampleRate = rate
      sound.play(samples, rate)
      const call = live.onsound
      if (typeof call !== 'function') return
      try {
        call(samples, rate)
      } catch {
        console.error('[It] a microphone’s onsound handler threw')
      }
    },
    told: (now, said) => {
      if (state === 'ended') return
      if (now === 'ended') {
        why = said
        over()
      } else state = now
      const call = live.onchange
      if (typeof call !== 'function') return
      try {
        call(now, said === undefined ? undefined : (MICROPHONE_ENDED[said] ?? said))
      } catch {
        console.error('[It] a microphone’s onchange handler threw')
      }
    },
  })
  const audio = {
    ...(typeof options.echoCancellation === 'boolean' ? { echoCancellation: options.echoCancellation } : {}),
    ...(typeof options.noiseSuppression === 'boolean' ? { noiseSuppression: options.noiseSuppression } : {}),
    ...(typeof options.autoGainControl === 'boolean' ? { autoGainControl: options.autoGainControl } : {}),
  }
  try {
    const said = await done({ type: 'it:microphone', requestId: id(), microphone: named, audio })
    if (typeof said.sound?.sampleRate === 'number' && !sampleRate) sampleRate = said.sound.sampleRate
  } catch (err) {
    over()
    throw err
  }
  // Ended by the site while it was being opened: said as that, and not as a microphone that is live
  if (live.state === 'ended' && why) throw new Error(MICROPHONE_ENDED[why] ?? 'The microphone has ended.')
  return live
}

// Fullscreen. A page in a sandboxed frame cannot count on going fullscreen by itself: Safari holds
// such a frame to an origin that no permission names, and refuses it. So It goes fullscreen for
// the page. The site makes the whole of itself fullscreen, with It's bar above the page, and
// Escape leaves it as usual. `It.fullscreen()` asks for that, and so does the page's own
// `requestFullscreen()` on any of its elements, which is what a page written without It in mind
// calls: such a request goes to the site, and what the page reads of fullscreen says what It's
// is. An element other than the page's document or its body is made to fill the page's frame,
// as a browser would fill the screen with it, so that nothing of the page is ever drawn over
// It's bar. What the browser makes fullscreen in the page by itself, as a film's own controls
// can, is left at once and asked of It in the same way.
//
// A request goes to the site on the window and not on the channel: Safari carries the click that
// asked across a window's message but not across a channel's, and a browser goes fullscreen only
// just after a click. The answer comes on the channel. Until the site has said what its
// fullscreen is, the page's requests are the browser's own, as they are where the site is one
// from before it took them.

/** What the site last said of its fullscreen: nothing, until it has. */
let itsFullscreen: { on: boolean; enabled: boolean } | null = null
/** What the page reads as fullscreen while It is: the element it asked for, which is its document unless it asked for another. */
let fullElement: Element | null = null
/** The element a request on its way asked for. */
let askingFor: Element | null = null
/** What It's fullscreen was entered for: the page's document, where the bar made It fullscreen. */
let began: Element | null = null
/** Whether It's fullscreen is over for the page, as when what was fullscreen left the page, while the site has yet to say so. */
let over = false
const NO_FULLSCREEN = 'This browser has no fullscreen.'
/**
 * Put on whatever the page reads as fullscreen while It is: its document where It's bar made It
 * so. The browser's `:fullscreen` never matches inside the page, so this is what a page styles.
 */
const FULL_MARK = 'data-it-fullscreen'

/** The browser's own answer to something a document says of fullscreen, which the page reads instead as below. */
function browsers(name: string): unknown {
  for (let kind = Object.getPrototypeOf(document); kind; kind = Object.getPrototypeOf(kind)) {
    const said = Object.getOwnPropertyDescriptor(kind, name)
    if (said) return said.get ? said.get.call(document) : said.value
  }
  return undefined
}
const browsersFullscreen = (): Element | null => (browsers('fullscreenElement') ?? browsers('webkitFullscreenElement') ?? null) as Element | null
const isWhole = (el: unknown) => el === document.documentElement || el === document.body
/** What the page reads as fullscreen of It's: nothing while It is not. */
const itsElement = (): Element | null => (itsFullscreen?.on && !over ? (fullElement ?? document.documentElement) : null)

/**
 * How an element fills the page's frame while it is what the page has fullscreen: over
 * everything else of the page and as large as the frame, as a browser's own fullscreen makes it.
 * These are put in the element's own style, with the priority that nothing of the page's can
 * outweigh, so that they hold wherever the element is, a shadow root included.
 */
const FILLS: [string, string][] = [
  ['position', 'fixed'],
  ['top', '0'],
  ['right', '0'],
  ['bottom', '0'],
  ['left', '0'],
  ['width', '100%'],
  ['height', '100%'],
  ['min-width', '0'],
  ['min-height', '0'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin-top', '0'],
  ['margin-right', '0'],
  ['margin-bottom', '0'],
  ['margin-left', '0'],
  ['box-sizing', 'border-box'],
  ['transform', 'none'],
  ['translate', 'none'],
  ['rotate', 'none'],
  ['scale', 'none'],
  ['z-index', '2147483647'],
]
/** What fills the frame in groups: each with the shorthand that can say the whole of it, where there is one. */
const FILL_GROUPS: [string | null, string[]][] = [
  ['inset', ['top', 'right', 'bottom', 'left']],
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  ...FILLS.filter(([name]) => !['top', 'right', 'bottom', 'left'].includes(name) && !name.startsWith('margin-')).map(([name]): [string | null, string[]] => [
    null,
    [name],
  ]),
]
/**
 * What the element looks like besides, where the page says nothing of it: a film whole within
 * it, on black, and nothing of the look a browser gives a popover. Said with no weight at all,
 * so that anything of the page's comes first, and put where the element is, in the document or
 * in its shadow root, for as long as it is fullscreen.
 */
const LOOKS = `:where([${FULL_MARK}]:not(html):not(body)){background:#000;color:inherit;padding:0;border:none;overflow:visible;object-fit:contain}[${FULL_MARK}]::backdrop{background:#000}`
/**
 * The element that fills the frame now. While it does, It holds the properties above in its
 * style and nothing else of it. What the page writes to those is kept as what it means them to
 * be once fullscreen ends, and It's are put back at once; whatever else the page writes stays.
 */
interface Filling {
  el: Element
  style: CSSStyleDeclaration
  /** The element's own style as the page means it, as text: what it was before, with all the page has written since. */
  meant: string
  hadStyle: boolean
  /** Each property It holds, as the browser reads it back once It has set it. */
  ours: Map<string, string>
  looks: HTMLStyleElement
  lifted: boolean
  /** Whether it was a popover of the page's own, shown, when it was made fullscreen. */
  pagesPopover: boolean
  /** The frame in which It's properties are to be put back, where the page has written over them. */
  due: number
  /** What hears the page write to the element's style, and where the element is moved to or taken from. */
  writes: MutationObserver
  moves: MutationObserver
}
let filling: Filling | null = null
/** A style that belongs to nothing, which the browser reads and writes as it would an element's own. */
const loose = (text: string): CSSStyleDeclaration => {
  const style = document.createElement('div').style
  style.cssText = text
  return style
}
/** Whether an element is in the top layer as a popover, or where the browser cannot say, taken to be. */
const shownAbove = (el: Element): boolean => {
  try {
    return el.matches(':popover-open')
  } catch {
    return true
  }
}
const holds = (f: Filling, name: string) => f.style.getPropertyValue(name) === f.ours.get(name) && f.style.getPropertyPriority(name) === 'important'

/** Puts back whatever of It's the page's style no longer says, and passes over what that writes. */
function hold(f: Filling): void {
  for (const [name, value] of FILLS) if (!holds(f, name)) f.style.setProperty(name, value, 'important')
  f.writes.takeRecords()
}

/**
 * Puts It's properties back once the page has written over them: once in a frame at most, before
 * the frame is drawn, so that nothing is drawn without them. A page that writes them back each
 * time, as one that watches the element's style may, then costs a write of each in a frame, and
 * never more: the two do not write at each other without end, and timers and drawing go on. It
 * does not give up and let the element go, since a page that only animates the element's size,
 * or writes its whole style again as it draws, writes over them just as often.
 */
function holdSoon(f: Filling): void {
  if (f.due || typeof requestAnimationFrame !== 'function') return
  f.due = requestAnimationFrame(() => {
    f.due = 0
    if (filling === f) hold(f)
  })
}

/** The page wrote to the element's style: what it wrote of It's properties is what it means them to be afterwards, and the rest stands. */
function pageWrote(f: Filling): void {
  const meant = loose(f.meant)
  for (const [shorthand, parts] of FILL_GROUPS) {
    if (parts.every((part) => holds(f, part))) continue
    // A shorthand the page wrote with a variable in it, whose parts read as nothing by themselves
    const whole = shorthand ? f.style.getPropertyValue(shorthand) : ''
    if (shorthand && whole && parts.every((part) => !f.style.getPropertyValue(part))) {
      meant.setProperty(shorthand, whole, f.style.getPropertyPriority(shorthand))
      continue
    }
    for (const part of parts) {
      if (holds(f, part)) continue
      const value = f.style.getPropertyValue(part)
      if (value) meant.setProperty(part, value, f.style.getPropertyPriority(part))
      else meant.removeProperty(part)
    }
  }
  // Everything else as the page has it now, and It's properties as the page means them
  const now = loose(f.style.cssText)
  for (const [shorthand, parts] of FILL_GROUPS) {
    const whole = shorthand ? meant.getPropertyValue(shorthand) : ''
    if (shorthand && whole) {
      now.setProperty(shorthand, whole, meant.getPropertyPriority(shorthand))
      continue
    }
    for (const part of parts) {
      const value = meant.getPropertyValue(part)
      if (value) now.setProperty(part, value, meant.getPropertyPriority(part))
      else now.removeProperty(part)
    }
  }
  f.meant = now.cssText
}

/** Where the element is now: its look goes with it into whatever root holds it, and it is shown in the top layer again, which a move takes it out of. */
function placed(f: Filling, moved: boolean): void {
  const root = f.el.getRootNode()
  const home = root instanceof ShadowRoot ? root : (document.head ?? document.documentElement)
  if (f.looks.parentNode !== home) home.append(f.looks)
  // A popover of the page's own that the move closed is the page's to show again, and not It's:
  // It lets the element go, as a browser's fullscreen ends for an element that is moved
  if (moved && f.pagesPopover && !shownAbove(f.el)) {
    fullscreenLetGo(f.el)
    return
  }
  if (moved && f.lifted && !shownAbove(f.el))
    try {
      ;(f.el as HTMLElement).showPopover()
    } catch {
      // The browser would not: it is laid over the page all the same
    }
  // Every root between the element and the document, where a move or a removal of it or of what holds it is seen
  f.moves.disconnect()
  for (let at: Node = root; ; at = (at as ShadowRoot).host.getRootNode()) {
    f.moves.observe(at, { childList: true, subtree: true })
    if (!(at instanceof ShadowRoot)) break
  }
}

/**
 * Makes an element fill the page's frame, or lets it go, putting back its style as the page
 * means it. Where the browser has a top layer for a page to use, the element is put there too,
 * above anything the page draws, whatever holds it; where it has none, it is laid over the rest
 * of the page.
 */
function fill(el: Element | null, on: boolean): void {
  if (!el) return
  if (!on) {
    el.removeAttribute(FULL_MARK)
    const f = filling
    if (f?.el !== el) return
    filling = null
    if (f.due) cancelAnimationFrame(f.due)
    if (f.writes.takeRecords().length > 0) pageWrote(f)
    f.writes.disconnect()
    f.moves.disconnect()
    f.looks.remove()
    if (f.lifted) {
      try {
        ;(el as HTMLElement).hidePopover()
      } catch {
        // Out of the top layer already
      }
      el.removeAttribute('popover')
    }
    if (f.hadStyle || f.meant) f.style.cssText = f.meant
    else {
      // Chromium writes the attribute from the style when it is next read, and would write back
      // an empty one after it was removed: so it is read first, and then removed
      el.getAttribute('style')
      el.removeAttribute('style')
    }
    return
  }
  el.setAttribute(FULL_MARK, '')
  const style = (el as Element & { style?: CSSStyleDeclaration }).style
  if (isWhole(el) || !style) return
  fill(filling?.el ?? null, false)
  const f: Filling = {
    el,
    style,
    meant: style.cssText,
    hadStyle: el.hasAttribute('style'),
    ours: new Map(),
    looks: Object.assign(document.createElement('style'), { textContent: LOOKS }),
    lifted: false,
    pagesPopover: el.hasAttribute('popover') && shownAbove(el),
    due: 0,
    writes: new MutationObserver(() => {
      if (filling !== f) return
      pageWrote(f)
      holdSoon(f)
    }),
    moves: new MutationObserver(() => {
      if (filling !== f) return
      if (el.isConnected) placed(f, true)
      else fullscreenLetGo(el)
    }),
  }
  filling = f
  for (const [name, value] of FILLS) {
    style.setProperty(name, value, 'important')
    f.ours.set(name, style.getPropertyValue(name))
  }
  f.writes.observe(el, { attributes: true, attributeFilter: ['style'] })
  // A popover of the page's own is left as the page made it
  if (el instanceof HTMLElement && typeof el.showPopover === 'function' && !el.hasAttribute('popover'))
    try {
      el.setAttribute('popover', 'manual')
      el.showPopover()
      f.lifted = true
    } catch {
      el.removeAttribute('popover')
    }
  placed(f, false)
}

/** Tells the page's listeners what a browser would have told them, at the element that went fullscreen or left it, or at the document where that element is gone. */
function fullscreenEvent(at: Node, what: 'change' | 'error'): void {
  for (const prefix of ['', 'webkit'])
    if (prefix === '' || `on${prefix}fullscreen${what}` in document)
      at.dispatchEvent(new Event(`${prefix}fullscreen${what}`, { bubbles: true, composed: true }))
}

/** What the site says of its fullscreen, from which the page hears that it changed. */
function fullscreenSaid(on: boolean, enabled: boolean): void {
  const was = itsFullscreen?.on === true && !over
  itsFullscreen = { on, enabled }
  // Over for the page already, which has heard so
  if (over && !on) {
    over = false
    return
  }
  over = false
  if (on === was) return
  const at = on ? (askingFor ?? document.documentElement) : (fullElement ?? document.documentElement)
  fill(fullElement, false)
  fullElement = on ? at : null
  began = fullElement
  fill(fullElement, true)
  fullscreenEvent(at, 'change')
}

/**
 * It lets go of what was fullscreen, as a browser's own fullscreen ends for an element that is
 * removed: at once, with everything It put on the element taken off, and told to the page at the
 * element, or at its document where the element is no longer in it. That is so when the page
 * removes the element, and when it moves a popover of its own that the move closed. Where It's
 * fullscreen began with the page's document, as from the bar, that is fullscreen again; and
 * otherwise It leaves fullscreen.
 */
function fullscreenLetGo(el: Element): void {
  if (fullElement !== el) return
  fill(el, false)
  const at = el.isConnected ? el : document
  if (began && began !== el && isWhole(began) && began.isConnected) {
    fullElement = began
    fill(began, true)
    fullscreenEvent(at, 'change')
    return
  }
  fullElement = null
  over = true
  fullscreenEvent(at, 'change')
  askFullscreen(false, document.documentElement).catch(() => {})
}

/** Another element of the page is what it has fullscreen, while It is fullscreen already. */
function fullscreenMoved(el: Element): void {
  if (over) {
    over = false
    fullElement = null
  }
  if (fullElement === el) return
  fill(fullElement, false)
  fullElement = el
  fill(el, true)
  fullscreenEvent(el, 'change')
}

/** Asks the site for It's fullscreen, or to leave it, for this element of the page. */
function askFullscreen(on: boolean, el: Element): Promise<void> {
  const known = itsFullscreen
  if (!known) return Promise.reject(new TypeError(NO_FULLSCREEN))
  if (on && known.on) {
    fullscreenMoved(el)
    return Promise.resolve()
  }
  if (on === known.on) return Promise.resolve()
  if (on && !known.enabled) {
    fullscreenEvent(el, 'error')
    return Promise.reject(new TypeError(NO_FULLSCREEN))
  }
  const requestId = id()
  if (on) askingFor = el
  return new Promise((resolve, reject) => {
    waiting.set(requestId, (result) => {
      if (result.ok) fullscreenSaid(on, itsFullscreen?.enabled ?? known.enabled)
      if (askingFor === el) askingFor = null
      if (result.ok) return resolve()
      fullscreenEvent(el, 'error')
      reject(new TypeError(result.error))
    })
    window.parent.postMessage({ type: 'it:fullscreen', requestId, on } satisfies PageToSite, config.app)
  })
}

// The page's own requests, for any of its elements and by either name a browser gives them. The
// older name answers with nothing and tells what became of the request by events alone.
for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
  const own = Object.getOwnPropertyDescriptor(Element.prototype, name)
  if (typeof own?.value !== 'function') continue
  const theBrowsers = own.value as (...given: unknown[]) => unknown
  Object.defineProperty(Element.prototype, name, {
    ...own,
    value(this: Element, ...given: unknown[]) {
      if (!itsFullscreen) return theBrowsers.apply(this, given)
      const asked = askFullscreen(true, this)
      if (name === 'requestFullscreen') return asked
      asked.catch(() => {})
      return undefined
    },
  })
}
for (const name of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen']) {
  const theBrowsers = browsers(name)
  if (typeof theBrowsers !== 'function') continue
  Object.defineProperty(document, name, {
    configurable: true,
    writable: true,
    value(...given: unknown[]) {
      // What the browser made fullscreen itself it leaves itself
      if (itsElement() === null || browsersFullscreen() !== null) return theBrowsers.apply(document, given)
      const asked = askFullscreen(false, document.documentElement)
      if (name === 'exitFullscreen') return asked
      asked.catch(() => {})
      return undefined
    },
  })
}
// What the browser makes fullscreen in the page by itself, which no request of the page's asked
// for, as a film's own controls or a frame inside the page can: it would be drawn over It's bar.
// So it is left at once, and It's fullscreen is asked for it instead, on the click that made it.
// The site leaves it too, should this not.
function grantedByTheBrowser(): void {
  const el = browsersFullscreen()
  if (!el || !itsFullscreen) return
  const leave = browsers('exitFullscreen') ?? browsers('webkitExitFullscreen')
  Promise.resolve()
    .then(() => (typeof leave === 'function' ? leave.call(document) : undefined))
    .catch(() => {})
    .then(() => askFullscreen(true, el))
    .catch(() => {})
}
for (const kind of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(kind, grantedByTheBrowser, true)
// What a page reads of fullscreen: the browser's own where the browser has something
// fullscreen in the page, and otherwise It's
const fullscreenReads: [string, () => unknown][] = [
  ['fullscreenElement', () => browsers('fullscreenElement') ?? itsElement()],
  ['webkitFullscreenElement', () => browsers('webkitFullscreenElement') ?? itsElement()],
  ['webkitCurrentFullScreenElement', () => browsers('webkitCurrentFullScreenElement') ?? itsElement()],
  ['fullscreen', () => Boolean(browsers('fullscreen')) || itsElement() !== null],
  ['webkitIsFullScreen', () => Boolean(browsers('webkitIsFullScreen')) || itsElement() !== null],
  // Where the site can go fullscreen, the page can too, though the browser would not let its frame
  ['fullscreenEnabled', () => Boolean(browsers('fullscreenEnabled')) || itsFullscreen?.enabled === true],
  ['webkitFullscreenEnabled', () => Boolean(browsers('webkitFullscreenEnabled')) || itsFullscreen?.enabled === true],
]
for (const [name, read] of fullscreenReads) if (name in document) Object.defineProperty(document, name, { configurable: true, enumerable: true, get: read })

/** Makes It fullscreen, with It's bar above the page. Before the site has said what its fullscreen is, the browser is asked instead. */
function fullscreen(): Promise<void> {
  const whole = document.documentElement
  if (itsFullscreen) return askFullscreen(true, whole)
  if (typeof whole.requestFullscreen === 'function') return whole.requestFullscreen()
  return Promise.reject(new TypeError(NO_FULLSCREEN))
}
/** Leaves It's fullscreen, and does nothing where It is not fullscreen. */
function exitFullscreen(): Promise<void> {
  if (itsFullscreen) return askFullscreen(false, document.documentElement)
  return browsersFullscreen() !== null && typeof document.exitFullscreen === 'function' ? document.exitFullscreen() : Promise.resolve()
}

const api = {
  id: config.id,
  version: config.version,
  get state() {
    return state
  },
  get revision() {
    return revision
  },
  onState(cb: Listener) {
    listeners.push(cb)
    if (arrived) queueMicrotask(() => tell(cb))
    return () => {
      const i = listeners.indexOf(cb)
      if (i !== -1) listeners.splice(i, 1)
    }
  },
  action,
  record,
  photo,
  camera,
  microphone,
  stage,
  commit,
  staged: () => ({ ...staged }),
  clearStaged: () => {
    staged = {}
    for (const key of Object.keys(stagedAt)) delete stagedAt[key]
  },
  /**
   * Opens an address in a tab of its own, as a link to it would: an http or https address, or a
   * mail, phone or messages link. The site opens it, with no hold either way and no referrer,
   * and only while the browser counts a click or key of the person's in the page, so call it
   * from the handler of one.
   */
  open(url: string | URL): void {
    const href = openedForAPage(addressOf(String(url))?.href)
    if (!href) throw new Error(`It.open opens an address of one of these kinds: ${OPENED_FOR_A_PAGE.map((kind) => kind.slice(0, -1)).join(', ')}.`)
    // A site that does not open links leaves it to the browser, in a tab of its own with no hold
    if (!siteOpens()) openWindow.call(window, href, '_blank', 'noopener,noreferrer')
    else openedBySite(href)
  },
  /** Things the page keeps for itself. They follow the page to every display. */
  store: {
    get: (key: string) => {
      const kept = keptIn(state)
      // Only what was stored under that very name: never something every object has by nature
      return Object.hasOwn(kept, key) ? kept[key] : undefined
    },
    set: store,
  },
  /** A player or a map from a provider on It's list, hosted by the site over an element of the page. */
  embed: players.embed,
  /** Makes It fullscreen, with It's bar above the page. Call it from a click: a browser allows fullscreen only then. */
  fullscreen,
  exitFullscreen,
  /** Whether It is fullscreen. The page hears `fullscreenchange` on its document whenever this changes. */
  get isFullscreen() {
    return itsFullscreen ? itsElement() !== null : browsersFullscreen() !== null
  },
}

Object.defineProperty(window, 'It', { value: api, writable: false })
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBindings)
hello()
