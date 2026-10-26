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
  type PageToSite,
  SHRINK,
  type SiteToPage,
  STORE_EVERY_MS,
  STORE_KEY,
} from '@it/protocol'

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
    send(message)
  })
}

const isObject = (x: unknown): x is State => typeof x === 'object' && x !== null && !Array.isArray(x)
/** What a state says the page keeps for itself. */
const keptIn = (s: State): State => (isObject(s[STORE_KEY]) ? (s[STORE_KEY] as State) : {})
/** A state with what the page keeps put in place of what it said: under its own key, where the page keeps anything. */
function withKept(s: State, kept: State): State {
  const { [STORE_KEY]: _, ...rest } = s
  return Object.keys(kept).length > 0 ? { ...rest, [STORE_KEY]: kept } : rest
}

function receive(message: SiteToPage): void {
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
      else kept[key] = value
    }
    sent = withKept(message.state === undefined ? sent : isObject(message.state) ? message.state : {}, kept)
    revision = message.revision
    shown()
    emit()
  } else if (message.type === 'it:result') {
    const answer = waiting.get(message.requestId)
    if (!answer) return
    waiting.delete(message.requestId)
    answer(message)
  }
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
    else kept[key] = value
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

// The site answers the hello with a port. Only the window that framed this one is listened to,
// and only while what is in it is the site.
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.origin !== config.app || e.data?.type !== 'it:port' || !e.ports[0] || port) return
  port = e.ports[0]
  channel = typeof e.data.v === 'number' ? e.data.v : 0
  port.onmessage = (m) => receive(m.data as SiteToPage)
  for (const m of unsent.splice(0)) post(port, m)
  flush()
})
// This document's own name. The site answers each document once, however often it asks.
const doc = id()
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
new MutationObserver((changes) => {
  for (const change of changes) {
    if (change.type === 'attributes') quieten(change.target as Element)
    else
      for (const added of change.addedNodes) {
        if (added.nodeType !== Node.ELEMENT_NODE) continue
        quieten(added as Element)
        quietenWithin(added as Element)
      }
  }
}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['name', 'content', 'referrerpolicy', 'ping'] })
quietenWithin(document)
// A script can activate a link before the observer runs. Check it on the way to its handlers
// and again after them, including a link followed with the middle button.
for (const event of ['click', 'auxclick'])
  for (const capture of [true, false])
    window.addEventListener(
      event,
      (e) => {
        for (const el of e.composedPath()) if (el instanceof Element) stopAuditing(el)
      },
      capture,
    )
const openWindow = window.open
window.open = function (this: Window, ...given: Parameters<typeof window.open>) {
  quietenWithin(document)
  return openWindow.apply(this, given)
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
  stage,
  commit,
  staged: () => ({ ...staged }),
  clearStaged: () => {
    staged = {}
    for (const key of Object.keys(stagedAt)) delete stagedAt[key]
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
}

Object.defineProperty(window, 'It', { value: api, writable: false })
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBindings)
hello()
