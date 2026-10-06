// The script inside every page, as it is built and served, run in a stand-in for a browser:
// a fresh page for every test. The site that frames the page is stood in for by hand: it
// receives the hello, hands over a port, and answers on it.
import { JSDOM } from 'jsdom'
import { describe, expect, test } from 'vitest'
import { RUNTIME } from '../content/src/runtime.generated'

interface Port {
  sent: any[]
  postMessage: (m: unknown) => void
  onmessage: ((e: { data: unknown }) => void) | null
  close: () => void
}
const APP = 'http://app.test'
/** Where the page is told to ask to keep its showing going. */
const KEEP = '/s/a-token/__it/keep'

/** Loads the script into a fresh page, with a clock the test moves by hand. `before` is done to the page first, as a browser would have. */
function load(html = '', before: (w: any) => void = () => {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: 'http://content.test/s/a-token/v/3/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window as any
  const hellos: any[] = []
  const fetched: { url: string; init: unknown }[] = []
  const page = { keepStatus: 204, port: null as Port | null }
  let now = 0
  let timers: { at: number; every?: number; fn: () => void }[] = []
  w.setTimeout = (fn: () => void, ms: number) => timers.push({ at: now + ms, fn })
  w.setInterval = (fn: () => void, ms: number) => timers.push({ at: now + ms, every: ms, fn })
  w.__IT__ = { app: APP, id: 'plan', version: 3, keep: KEEP }
  w.parent.postMessage = (m: unknown, origin: string) => origin === APP && hellos.push(m)
  w.fetch = async (url: string, init: unknown) => {
    fetched.push({ url, init })
    return { status: page.keepStatus }
  }
  before(w)
  w.eval(RUNTIME)
  return {
    It: w.It,
    w,
    hellos,
    fetched,
    page,
    /** Moves the clock on, running whatever comes due, and lets promises settle. */
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        if (due.every) due.at += due.every
        else timers = timers.filter((t) => t !== due)
        due.fn()
        await new Promise((r) => setImmediate(r))
      }
      now = until
    },
    /** The site answers the hello, as mount.tsx does: from the window that framed the page. */
    answer(origin = APP, source: unknown = w.parent) {
      const port: Port = { sent: [], postMessage: (m) => port.sent.push(m), onmessage: null, close: () => {} }
      page.port = port
      w.dispatchEvent(Object.assign(new w.Event('message'), { origin, source, data: { type: 'it:port' }, ports: [port] }))
      return port
    },
    fromSite: (data: unknown) => page.port?.onmessage?.({ data }),
  }
}

describe('the script inside a page', () => {
  test('it says hello to the site that framed it, as one named document, until it is answered', async () => {
    const p = load()
    await p.advance(600)
    expect(p.hellos.length).toBeGreaterThanOrEqual(3)
    expect(new Set(p.hellos.map((h) => h.doc)).size).toBe(1)
    expect(p.hellos[0]).toMatchObject({ type: 'it:hello', v: 1 })
    expect(p.hellos[0].doc.length).toBeGreaterThan(8)
    p.answer()
    const before = p.hellos.length
    await p.advance(2000)
    expect(p.hellos.length).toBe(before)
    // Another page is another document
    expect(load().hellos[0].doc).not.toBe(p.hellos[0].doc)
  })

  test('a port is taken only from the window that framed the page, and only while the site is what is in it', async () => {
    const p = load()
    void p.It.action('approve', {})
    // From the window above, with something other than the site in it: a sandboxed page has no origin to give
    for (const origin of ['https://evil.example', 'null', 'http://content.test']) expect([origin, p.answer(origin).sent]).toEqual([origin, []])
    // From the site's origin, in any other window: one the page opened, one it framed, or itself
    const elsewhere = new JSDOM('', { url: APP }).window
    for (const source of [elsewhere, null, {}]) expect(p.answer(APP, source).sent).toEqual([])
    expect(p.answer().sent).toHaveLength(1)
  })

  test('an action resolves when the site says It accepted it, and rejects when it was refused', async () => {
    const p = load()
    // Sent before the port arrives: held, then sent
    const accepted = p.It.action('approve', { plan: 'B' })
    const port = p.answer()
    const sent = port.sent[0]
    expect(sent).toMatchObject({ type: 'it:action', envelope: { v: 1, name: 'approve', payload: { plan: 'B' }, contentVersion: 3 } })
    expect(sent.envelope.clientActionId.length).toBeGreaterThanOrEqual(8)
    p.fromSite({ type: 'it:result', requestId: sent.requestId, ok: true, actionId: 'a1' })
    await expect(accepted).resolves.toEqual({ ok: true, id: 'a1' })
    const refused = p.It.action('approve')
    p.fromSite({ type: 'it:result', requestId: port.sent[1].requestId, ok: false, error: 'Too many requests.' })
    await expect(refused).rejects.toThrow('Too many requests.')
    await expect(p.It.action('')).rejects.toThrow()
  })

  test('a commit sends what was staged, and clears only that: choices made while it was on its way stay', async () => {
    const p = load()
    const port = p.answer()
    p.It.stage('region', 'eu')
    p.It.stage('size', 'large')
    const done = p.It.commit('configure', { note: 'x' })
    expect(port.sent[0].envelope).toMatchObject({ name: 'configure', payload: { region: 'eu', size: 'large', note: 'x' } })
    // While the answer is on its way the person changes one choice and adds another
    p.It.stage('region', 'us')
    p.It.stage('extra', true)
    p.fromSite({ type: 'it:result', requestId: port.sent[0].requestId, ok: true })
    await done
    expect(p.It.staged()).toEqual({ region: 'us', extra: true })
    // The same holds for an object changed in place and staged again while a commit is on its way
    const choice = { answer: 'A' }
    p.It.clearStaged()
    p.It.stage('choice', choice)
    const second = p.It.commit('answer')
    choice.answer = 'B'
    p.It.stage('choice', choice)
    p.fromSite({ type: 'it:result', requestId: port.sent[1].requestId, ok: true })
    await second
    expect(p.It.staged()).toEqual({ choice: { answer: 'B' } })
    p.It.clearStaged()
    p.It.stage('region', 'us')
    p.It.stage('extra', true)
    // A refused commit clears nothing
    const again = p.It.commit('configure')
    p.fromSite({ type: 'it:result', requestId: port.sent[2].requestId, ok: false, error: 'no' })
    await expect(again).rejects.toThrow()
    expect(p.It.staged()).toEqual({ region: 'us', extra: true })
  })

  test('state from the site fills bound elements, shows and hides, and reaches listeners', async () => {
    const p = load(
      '<b id="s" data-it-bind="status"></b><i id="d" data-it-show="done"></i><u id="n" data-it-show="!done"></u><input id="i" data-it-bind="steps.count">',
    )
    p.answer()
    const heard: unknown[] = []
    p.It.onState((s: unknown) => heard.push(s))
    p.fromSite({ type: 'it:state', state: { status: 'Deploying', done: true, steps: { count: 3 } }, revision: 4 })
    const el = (id: string) => p.w.document.getElementById(id)
    expect(el('s').textContent).toBe('Deploying')
    expect(el('i').value).toBe('3')
    expect(el('d').style.display).toBe('')
    expect(el('n').style.display).toBe('none')
    expect(heard).toEqual([{ status: 'Deploying', done: true, steps: { count: 3 } }])
    expect(p.It.revision).toBe(4)
  })

  test('what the page stores for itself is read back by its exact name', async () => {
    const p = load()
    const port = p.answer()
    p.fromSite({ type: 'it:state', state: { _page: { draft: 'hello', 'a.b': 'dotted' }, a: { b: 'not this' } }, revision: 1 })
    expect(p.It.store.get('draft')).toBe('hello')
    expect(p.It.store.get('a.b')).toBe('dotted')
    expect(p.It.store.get('missing')).toBeUndefined()
    void p.It.store.set('draft', { text: 'new' })
    expect(port.sent[0]).toMatchObject({ type: 'it:store', key: 'draft', value: { text: 'new' } })
    // A name that reaches into what every object has is neither read nor sent
    expect(p.It.store.get('constructor')).toBeUndefined()
    expect(p.It.store.get('__proto__')).toBeUndefined()
    for (const bad of ['__proto__', 'constructor', 'prototype', 'a.b', '', 'x'.repeat(65)]) await expect(p.It.store.set(bad, 1)).rejects.toThrow(/store key/)
    expect(port.sent.length).toBe(1)
  })

  test('a page cannot replace It with something of its own', async () => {
    const p = load()
    p.w.eval('try { window.It = { action: () => "fake" } } catch {}')
    expect(typeof p.w.It.commit).toBe('function')
  })

  test('a page that sits still keeps its showing by asking, hidden or not, and tells the site once when it is over', async () => {
    const p = load()
    const port = p.answer()
    Object.defineProperty(p.w.document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await p.advance(180_000)
    // At the address it was told, which holds its showing's token, and with nothing of the browser's sent along
    expect(p.fetched).toEqual([{ url: KEEP, init: { cache: 'no-store' } }])
    expect(port.sent).toEqual([])
    p.page.keepStatus = 401
    await p.advance(180_000)
    await p.advance(180_000)
    expect(port.sent).toEqual([{ type: 'it:lapsed' }])
  })

  test('what the page’s own script fails with is said to the site, the first few times, and a picture that did not load is not', async () => {
    const p = load()
    const port = p.answer()
    const fails = (message: string) => p.w.dispatchEvent(new p.w.ErrorEvent('error', { message }))
    fails('ReferenceError: yes is not defined')
    expect(port.sent).toEqual([{ type: 'it:fault', message: 'ReferenceError: yes is not defined' }])
    // Something that did not load raises an event with no message: no script failed
    p.w.dispatchEvent(new p.w.Event('error'))
    expect(port.sent.length).toBe(1)
    // A promise nobody caught, with the error it was refused with
    p.w.dispatchEvent(Object.assign(new p.w.Event('unhandledrejection'), { reason: new p.w.TypeError('move is not a function') }))
    expect(port.sent[1]).toEqual({ type: 'it:fault', message: 'TypeError: move is not a function' })
    // A script that fails over and over says so three times in all, and no message is longer than a line
    for (let n = 0; n < 10; n++) fails('x'.repeat(1000))
    expect(port.sent.length).toBe(3)
    expect((port.sent[2] as { message: string }).message.length).toBe(300)
  })

  test('a document the page frames inside itself has the page above it and not the site, and is given no port', async () => {
    // Its hello is for the site and reaches nobody: the page above it is a sandboxed document, with no origin for a message to be sent to
    const inner = load()
    expect(inner.hellos.length).toBeGreaterThan(0)
    // Whatever the page above it posts back is not the site's
    expect(inner.answer('null').sent).toEqual([])
    void inner.It.action('approve', {})
    expect(inner.page.port!.sent).toEqual([])
  })
})

describe('the browser’s storage, which a sandboxed page has none of', () => {
  /** A page as a sandbox leaves it: reading either storage throws. */
  const sandboxed = (w: any) => {
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(w, name, {
        configurable: true,
        get() {
          throw new w.DOMException('The document is sandboxed.', 'SecurityError')
        },
      })
  }

  test('where reading it throws, a page finds one in its place that keeps what it is given while the page is open', async () => {
    const p = load('', sandboxed)
    // What a page written without a thought for the sandbox does on its first line
    const first = p.w.eval(`
      localStorage.setItem('draft', 'hello')
      const theme = localStorage.getItem('theme') || 'light'
      sessionStorage.step = 3
      ;[localStorage.getItem('draft'), theme, sessionStorage.getItem('step'), localStorage.length, sessionStorage.length]
    `)
    expect([...first]).toEqual(['hello', 'light', '3', 1, 1])
    const local = p.w.localStorage
    // The whole of what a storage does: every value is text, a missing one is null
    local.setItem('n', 7)
    local.setItem('o', { a: 1 })
    expect([local.getItem('n'), local.getItem('o'), local.getItem('missing'), local.length]).toEqual(['7', '[object Object]', null, 3])
    expect([local.key(0), local.key(2), local.key(3)]).toEqual(['draft', 'o', null])
    // Read and written as an object too
    local.theme = 'dark'
    expect([local.theme, local.draft, local.getItem('theme'), 'theme' in local, 'nothing' in local, local.nothing]).toEqual([
      'dark',
      'hello',
      'dark',
      true,
      false,
      undefined,
    ])
    expect(Object.keys(local)).toEqual(['draft', 'n', 'o', 'theme'])
    expect(JSON.parse(JSON.stringify(local))).toEqual({ draft: 'hello', n: '7', o: '[object Object]', theme: 'dark' })
    delete local.theme
    local.removeItem('n')
    local.removeItem('never there')
    expect([local.getItem('theme'), local.getItem('n'), local.length]).toEqual([null, null, 2])
    // The two are apart, as the real ones are
    expect([p.w.sessionStorage.getItem('draft'), local.getItem('step')]).toEqual([null, null])
    local.clear()
    expect([local.length, local.getItem('draft'), p.w.sessionStorage.getItem('step')]).toEqual([0, null, '3'])
    // A name that is one of its own methods' is kept like any other, and the method still works
    local.setItem('getItem', 'a value')
    expect([local.getItem('getItem'), typeof local.getItem, local.length]).toEqual(['a value', 'function', 1])
    // Nothing is kept past the page: another document begins with nothing
    expect(load('', sandboxed).w.localStorage.length).toBe(0)
  })

  test('where the browser’s own works, it is left as it is', async () => {
    const p = load()
    expect(p.w.localStorage).toBeInstanceOf(p.w.Storage)
    expect(p.w.sessionStorage).toBeInstanceOf(p.w.Storage)
    // And only what throws is stood in for
    const half = load('', (w) =>
      Object.defineProperty(w, 'localStorage', {
        configurable: true,
        get() {
          throw new w.DOMException('The document is sandboxed.', 'SecurityError')
        },
      }),
    )
    expect(half.w.localStorage).not.toBeInstanceOf(half.w.Storage)
    expect(half.w.sessionStorage).toBeInstanceOf(half.w.Storage)
  })
})

describe('what the script writes to the console', () => {
  test('when a page’s own handler throws, only that it threw, and nothing of what it threw', async () => {
    const p = load('<b data-it-bind="status"></b>')
    p.answer()
    const said: unknown[][] = []
    p.w.console.error = (...args: unknown[]) => said.push(args)
    // Whatever the script lets past it reaches the browser's own report of errors
    const escaped: unknown[] = []
    p.w.addEventListener('error', (e: { error?: unknown; preventDefault(): void }) => {
      escaped.push(e.error)
      e.preventDefault()
    })
    // A handler that throws the whole state, one that throws an error whose words hold a draft,
    // and one whose error is named by the page: an error's name is the page's to set too
    p.It.onState((s: unknown) => {
      throw s
    })
    p.It.onState(() => {
      throw new p.w.TypeError('draft: a private note for acme')
    })
    p.It.onState(() => {
      throw Object.assign(new p.w.Error('ordinary'), { name: 'a private note for acme' })
    })
    const heard: unknown[] = []
    p.It.onState((s: unknown) => heard.push(s))
    p.fromSite({ type: 'it:state', state: { status: 'private status', draft: 'a private note for acme' }, revision: 2 })
    // The handlers after the ones that threw still ran
    expect(heard).toHaveLength(1)
    expect(said).toHaveLength(3)
    expect(JSON.stringify(said)).not.toMatch(/private|acme|draft/)
    expect(said.every((line) => line.length === 1 && line[0] === '[It] an onState handler threw')).toBe(true)
    // A handler added once the state is already there is called by itself a moment later, and
    // what it throws is held in the same way
    p.It.onState(() => {
      throw new p.w.Error('a private note for acme, late')
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(said).toHaveLength(4)
    expect(JSON.stringify(said)).not.toMatch(/private|acme|draft/)
    expect(escaped).toEqual([])
    // A handler that answers later, and fails then, is held the same way: nothing it failed
    // with is left for the browser to report as a failure nobody dealt with
    const unhandled: unknown[] = []
    p.w.addEventListener('unhandledrejection', (e: { reason?: unknown; preventDefault(): void }) => {
      unhandled.push(e.reason)
      e.preventDefault()
    })
    p.It.onState(async () => {
      await Promise.resolve()
      throw new p.w.Error('a private note for acme, later still')
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(said).toHaveLength(5)
    expect(said.every((line) => line.length === 1 && line[0] === '[It] an onState handler threw')).toBe(true)
    expect(unhandled).toEqual([])
  })
})

describe('the script itself', () => {
  test('says whose it is and under what terms, in its first line', () => {
    expect(RUNTIME.split('\n')[0]).toMatch(/^\/\*! It\. Copyright \(c\) 2026 Aaryan Kapoor\. Source-available under the It License 1\.0\./)
  })
})
