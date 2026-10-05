// The script inside every page. The content service puts it first in the page, so `It` exists
// before any of the page's own scripts run.
//
// A page is a sandboxed document. Its origin is its own and is shared with nothing, it holds
// no credential, and it cannot talk to the backend. Everything goes through the site that
// framed it, over a message channel: actions and stored values go up, the page's state comes
// down. The site decides who the person is.
import type { ActionEnvelope, PageToSite, SiteToPage } from '@it/protocol'

interface Config {
  app: string
  id: string
  version: number
  /** Where this showing is kept going by being asked. */
  keep: string
}
type Listener = (state: Record<string, unknown>) => void

const STORE_KEY = '_page'
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
let state: Record<string, unknown> = {}
let revision = 0
const listeners: Listener[] = []
const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
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
function applyBindings(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-it-bind]')) {
    const value = get(state, el.getAttribute('data-it-bind') ?? '')
    if (value === undefined) continue
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
  const threw = () => console.error('[It] an onState handler threw')
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

function send(message: PageToSite): void {
  if (port) port.postMessage(message)
  else unsent.push(message)
}

function ask(message: PageToSite & { requestId: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    waiting.set(message.requestId, { resolve, reject })
    send(message)
  })
}

function receive(message: SiteToPage): void {
  if (message.type === 'it:state') {
    state = (message.state ?? {}) as Record<string, unknown>
    revision = message.revision
    emit()
  } else if (message.type === 'it:result') {
    const w = waiting.get(message.requestId)
    if (!w) return
    waiting.delete(message.requestId)
    if (message.ok) w.resolve({ ok: true, id: message.actionId })
    else w.reject(new Error(message.error))
  }
}

// The site answers the hello with a port. Only the window that framed this one is listened to,
// and only while what is in it is the site.
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.origin !== config.app || e.data?.type !== 'it:port' || !e.ports[0] || port) return
  port = e.ports[0]
  port.onmessage = (m) => receive(m.data as SiteToPage)
  for (const m of unsent.splice(0)) port.postMessage(m)
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
let lapsed = false
function keep(): void {
  // Asked whether or not the tab is showing: a tab the person has switched away from for a
  // while should still be as they left it when they come back
  if (lapsed) return
  fetch(config.keep, { cache: 'no-store' }).then(
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

/** Something the person did. Resolves once It has accepted it; rejects if it was refused. */
function action(name: string, data?: unknown): Promise<unknown> {
  if (!name) return Promise.reject(new Error('action(name): a name is required'))
  const envelope: ActionEnvelope = { v: 1, clientActionId: id(), name, payload: data ?? {}, contentVersion: config.version, baseStateRevision: revision }
  return ask({ type: 'it:action', requestId: id(), envelope })
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
function commit(name: string, extra?: Record<string, unknown>): Promise<unknown> {
  // What was sent is cleared only once the action is accepted, so a failure does not lose what
  // was chosen. Anything staged or changed while the answer was on its way was not sent, and stays.
  const sent = { ...stagedAt }
  return action(name, { ...staged, ...(extra ?? {}) }).then((res) => {
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
    if (revision > 0) queueMicrotask(() => tell(cb))
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
  /** Small things the page keeps for itself. They follow the page to every display. */
  store: {
    get: (key: string) => {
      const kept = state[STORE_KEY] as Record<string, unknown> | undefined
      // Only what was stored under that very name: never something every object has by nature
      return kept && Object.hasOwn(kept, key) ? kept[key] : undefined
    },
    set: (key: string, value: unknown) =>
      // The same rule the backend keeps, said here so that a page hears of a bad name at once
      /^[A-Za-z0-9_-]{1,64}$/.test(String(key)) && !['__proto__', 'constructor', 'prototype'].includes(key)
        ? ask({ type: 'it:store', requestId: id(), key, value })
        : Promise.reject(new Error('A store key is 1 to 64 letters, digits, dashes or underscores.')),
  },
}

Object.defineProperty(window, 'It', { value: api, writable: false })
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBindings)
hello()
