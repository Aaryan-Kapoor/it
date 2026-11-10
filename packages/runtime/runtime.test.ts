// The script inside every page, as it is built and served, run in a stand-in for a browser:
// a fresh page for every test. The site that frames the page is stood in for by hand: it
// receives the hello, hands over a port, and answers on it.

import { CHANNEL_VERSION, STORE_EVERY_MS } from '@it/protocol'
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
    // Written down as the address a browser would ask at: what it is given, read against what the page says its addresses begin with
    fetched.push({ url: new w.URL(url, w.document.baseURI).href, init })
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
    /** The site answers the hello, as mount.tsx does: from the window that framed the page. A site whose channel says no version (`null`) is one from before it said any. */
    answer(origin = APP, source: unknown = w.parent, v: number | null = CHANNEL_VERSION) {
      // A port sends a copy of what it is given, and refuses what cannot be copied: the stand-in does as a real one does
      const port: Port = { sent: [], postMessage: (m) => port.sent.push(structuredClone(m)), onmessage: null, close: () => {} }
      page.port = port
      const data = v === null ? { type: 'it:port' } : { type: 'it:port', v }
      w.dispatchEvent(Object.assign(new w.Event('message'), { origin, source, data, ports: [port] }))
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

  test('something that cannot be sent is refused by itself, and what was asked beside it is still sent', async () => {
    const p = load()
    // Asked before the site has answered, and so held: one that holds a function, which no port can send, between two that can be sent
    const first = p.It.action('first', { n: 1 })
    const bad = p.It.action('bad', { fn() {} })
    const stored = p.It.store.set('draft', 'kept')
    const port = p.answer()
    expect(port.sent.map((m) => m.envelope?.name ?? m.changes?.[0]?.[0])).toEqual(['first', 'draft'])
    await expect(bad).rejects.toThrow(/could not be sent/)
    // The two that were sent are answered as any are
    p.fromSite({ type: 'it:result', requestId: port.sent[0].requestId, ok: true, actionId: 'a1' })
    p.fromSite({ type: 'it:result', requestId: port.sent[1].requestId, ok: true })
    await expect(first).resolves.toEqual({ ok: true, id: 'a1' })
    await expect(stored).resolves.toMatchObject({ ok: true })
    // Asked once the port is there, it is refused in the same way, and the next thing asked goes
    await expect(p.It.action('bad again', { fn() {} })).rejects.toThrow(/could not be sent/)
    void p.It.action('after', {})
    expect(port.sent.map((m) => m.envelope?.name ?? m.changes?.[0]?.[0])).toEqual(['first', 'draft', 'after'])
  })

  describe('a file in what an action carries', () => {
    /** The site's end of the channel, holding what it is given as it is: the file a page sends crosses as the file it is. */
    const raw = (p: ReturnType<typeof load>) => {
      const port: Port = { sent: [], postMessage: (m) => port.sent.push(m), onmessage: null, close: () => {} }
      p.page.port = port
      p.w.dispatchEvent(Object.assign(new p.w.Event('message'), { origin: APP, source: p.w.parent, data: { type: 'it:port' }, ports: [port] }))
      return port
    }
    const settle = () => new Promise((r) => setImmediate(r))

    test('goes to the site as the file it is, wherever the page put it, beside the rest of what the action carries', async () => {
      const p = load()
      const port = raw(p)
      const photo = new p.w.File([new Uint8Array([1, 2, 3])], 'receipt.jpg', { type: 'image/jpeg' })
      const notes = new p.w.Blob(['a,b'], { type: 'text/csv' })
      const sent = p.It.action('receipt', { photo, more: [{ notes }], table: 4 })
      await settle()
      const payload = port.sent[0].envelope.payload
      // A browser that cannot read the picture here sends it as it is, which this stand-in for one is
      expect(payload.table).toBe(4)
      expect(payload.photo).toBe(photo)
      expect(payload.more[0].notes).toBe(notes)
      p.fromSite({ type: 'it:result', requestId: port.sent[0].requestId, ok: true, actionId: 'a1' })
      await expect(sent).resolves.toEqual({ ok: true, id: 'a1' })
    })

    test('is waited for by the actions made after it, which reach the site in the order they were made, and a click with none made while none is waits for nothing', async () => {
      const p = load()
      const port = raw(p)
      // With no file anywhere, sent before the call has even returned, as it always was
      void p.It.action('first', { n: 1 })
      expect(port.sent.map((m) => m.envelope.name)).toEqual(['first'])
      void p.It.action('photo', { photo: new p.w.File([new Uint8Array(10)], 'a.png', { type: 'image/png' }) })
      void p.It.action('after', { n: 2 })
      // The click made after the picture does not overtake it
      expect(port.sent.map((m) => m.envelope.name)).toEqual(['first'])
      await settle()
      expect(port.sent.map((m) => m.envelope.name)).toEqual(['first', 'photo', 'after'])
      // And with nothing being made smaller any more, a click is sent at once again
      void p.It.action('later', {})
      expect(port.sent.map((m) => m.envelope.name)).toEqual(['first', 'photo', 'after', 'later'])
    })

    test('is sent as it is, at once, where the page asks for the original, and a commit takes the same', async () => {
      const p = load()
      const port = raw(p)
      const scan = new p.w.File([new Uint8Array(10)], 'scan.png', { type: 'image/png' })
      void p.It.action('scan', { scan }, { original: true })
      expect(port.sent[0].envelope.payload.scan).toBe(scan)
      p.It.stage('page', scan)
      void p.It.commit('pages', { count: 1 }, { original: true })
      expect(port.sent[1].envelope.payload).toEqual({ page: scan, count: 1 })
    })

    test('sends what it carries as it was when the page sent it, and so does an action that waits behind it, whatever the page changes meanwhile', async () => {
      const p = load()
      const port = raw(p)
      const answer = { choice: 'A', more: ['x'] }
      const counter = { n: 1 }
      void p.It.action('photo', { photo: new p.w.File([new Uint8Array(1)], 'a.jpg', { type: 'image/jpeg' }), answer })
      void p.It.action('count', { counter })
      p.It.stage('pick', answer)
      void p.It.commit('picked')
      // The page goes on, and changes what it sent
      answer.choice = 'B'
      answer.more.push('y')
      counter.n = 2
      await settle()
      expect(port.sent.map((m) => m.envelope.payload.answer ?? m.envelope.payload.counter ?? m.envelope.payload.pick)).toEqual([
        { choice: 'A', more: ['x'] },
        { n: 1 },
        { choice: 'A', more: ['x'] },
      ])
    })

    test('is drawn one at a time, across actions sent at once as within one, so that a phone holds one photo drawn whole at a time', async () => {
      let drawing = 0
      let most = 0
      const p = load('', (w) => {
        // A browser that takes its time drawing a picture, and is watched for how many it draws at once
        w.createImageBitmap = async () => {
          most = Math.max(most, ++drawing)
          await new Promise((r) => setImmediate(r))
          drawing--
          return { width: 100, height: 100, close() {} }
        }
      })
      const port = raw(p)
      const photo = (name: string) => new p.w.File([new Uint8Array(10)], name, { type: 'image/jpeg' })
      void p.It.action('first', { a: photo('a.jpg'), b: photo('b.jpg') })
      void p.It.action('second', { c: photo('c.jpg') })
      for (let i = 0; i < 20; i++) await settle()
      expect(port.sent.map((m) => m.envelope.name)).toEqual(['first', 'second'])
      expect(most).toBe(1)
    })

    test('keeps what the person was looking at as it was when they acted, not when the file was ready', async () => {
      const p = load()
      const port = raw(p)
      p.fromSite({ type: 'it:state', state: { a: 1 }, revision: 7 })
      void p.It.action('photo', { photo: new p.w.File([new Uint8Array(1)], 'a.jpg', { type: 'image/jpeg' }) })
      p.fromSite({ type: 'it:state', state: { a: 2 }, revision: 8 })
      await settle()
      expect(port.sent[0].envelope.baseStateRevision).toBe(7)
    })
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

  test('a listener given after the state has arrived is called with it, an empty state that nothing has changed yet included', async () => {
    const p = load()
    p.answer()
    const heard: unknown[] = []
    // Before anything has arrived there is nothing to call it with
    p.It.onState((s: unknown) => heard.push(['early', s]))
    await new Promise((r) => setTimeout(r, 5))
    expect(heard).toEqual([])
    // A page made with no state is sent an empty one, at revision zero, and that is its state having arrived
    p.fromSite({ type: 'it:state', state: {}, revision: 0 })
    expect(heard).toEqual([['early', {}]])
    // A script that loads later, or one that waits for something first, gives its listener only now
    p.It.onState((s: unknown) => heard.push(['late', s]))
    await new Promise((r) => setTimeout(r, 5))
    expect(heard).toEqual([
      ['early', {}],
      ['late', {}],
    ])
    expect(p.It.revision).toBe(0)
  })

  test('a bound element shows a value no longer once it has been taken out of the state, and what the page wrote in one itself stays until a value comes', async () => {
    const p = load(
      '<b id="s" data-it-bind="status">as the page wrote it</b><input id="i" data-it-bind="answer"><input id="c" type="checkbox" data-it-bind="agreed"><img id="p" data-it-bind="picture"><progress id="g" max="10" data-it-bind="done"></progress><em id="w" data-it-bind="never">placeholder</em>',
    )
    p.answer()
    const el = (id: string) => p.w.document.getElementById(id)
    // Before any value, the page's own words stand
    p.fromSite({ type: 'it:state', state: {}, revision: 1 })
    expect([el('s').textContent, el('w').textContent]).toEqual(['as the page wrote it', 'placeholder'])
    p.fromSite({
      type: 'it:state',
      state: { status: 'Working', answer: 'old answer', agreed: true, picture: 'https://example.com/a.png', done: 7 },
      revision: 2,
    })
    expect([el('s').textContent, el('i').value, el('c').checked, el('p').getAttribute('src'), el('g').value]).toEqual([
      'Working',
      'old answer',
      true,
      'https://example.com/a.png',
      7,
    ])
    // The agent takes them out, as `it patch` does with null and `it set --replace` by leaving them out
    p.fromSite({ type: 'it:state', state: {}, revision: 3 })
    expect([el('s').textContent, el('i').value, el('c').checked, el('p').getAttribute('src'), el('g').value]).toEqual(['', '', false, null, 0])
    // And what was never given a value is as the page wrote it still
    expect(el('w').textContent).toBe('placeholder')
  })

  test('a bound dropdown keeps its options, and an unedited text box and dropdown follow changes to their values', async () => {
    const p = load(
      '<select id="r" data-it-bind="region"><option value="">Choose</option><option value="us">United States</option><option value="eu">Europe</option></select><textarea id="t" data-it-bind="reply">as the page wrote it</textarea>',
    )
    p.answer()
    const el = (id: string) => p.w.document.getElementById(id)
    const shown = () => [el('r').options.length, el('r').value, el('t').value]
    p.fromSite({ type: 'it:state', state: { region: 'eu', reply: 'first answer' }, revision: 1 })
    expect(shown()).toEqual([3, 'eu', 'first answer'])
    p.fromSite({ type: 'it:state', state: { region: 'us', reply: 'second answer' }, revision: 2 })
    expect(shown()).toEqual([3, 'us', 'second answer'])
    // Taken out of the state, an unedited field is cleared.
    p.fromSite({ type: 'it:state', state: {}, revision: 3 })
    expect(shown()).toEqual([3, '', ''])
  })

  describe.each([
    ['text area', '<textarea data-it-bind="reply"></textarea>'],
    ['text input', '<input data-it-bind="reply">'],
    ['dropdown', '<select data-it-bind="reply"><option value=""></option><option>first</option><option>edited</option><option>second</option></select>'],
  ])('a bound %s', (_name, markup) => {
    test.each([false, true])('follows later state after a matching snapshot confirms an edit made before first state: %s', (early) => {
      const p = load(markup)
      p.answer()
      const field = p.w.document.querySelector('[data-it-bind]')
      if (!early) p.fromSite({ type: 'it:state', state: { reply: 'first' }, revision: 1 })
      field.value = 'edited'
      field.dispatchEvent(new p.w.Event('input', { bubbles: true }))
      p.fromSite({ type: 'it:state', state: { reply: 'edited' }, revision: 2 })
      expect(field.value).toBe('edited')
      p.fromSite({ type: 'it:state', state: { reply: 'second' }, revision: 3 })
      expect(field.value).toBe('second')
      p.fromSite({ type: 'it:state', state: {}, revision: 4 })
      expect(field.value).toBe('')
    })

    test('keeps an unsent edit when another key changes, its own key changes, or its value is removed', () => {
      const p = load(markup)
      p.answer()
      const field = p.w.document.querySelector('[data-it-bind]')
      const send = (state: unknown) => p.fromSite({ type: 'it:state', state, revision: 1 })
      send({ reply: 'first', status: 'Ready' })
      expect(field.value).toBe('first')
      field.value = 'edited'
      field.dispatchEvent(new p.w.Event('input', { bubbles: true }))
      send({ reply: 'first', status: 'Working' })
      expect(field.value).toBe('edited')
      send({ reply: 'first', status: 'Working', _page: { draft: 'stored' } })
      expect(field.value).toBe('edited')
      send({ reply: 'second' })
      expect(field.value).toBe('edited')
      send({})
      expect(field.value).toBe('edited')
      // Returning to what the binding wrote lets a later change fill the field again.
      field.value = 'first'
      send({ reply: 'second' })
      expect(field.value).toBe('second')
      send({})
      expect(field.value).toBe('')
    })

    test('keeps an edit made before the first state arrives', () => {
      const p = load(markup)
      p.answer()
      const field = p.w.document.querySelector('[data-it-bind]')
      field.value = 'edited'
      field.dispatchEvent(new p.w.Event('change', { bubbles: true }))
      p.fromSite({ type: 'it:state', state: { reply: 'first' }, revision: 1 })
      expect(field.value).toBe('edited')
      p.fromSite({ type: 'it:state', state: { reply: 'second' }, revision: 2 })
      expect(field.value).toBe('edited')
    })
  })

  test('what the page stores for itself is read back by its exact name', async () => {
    const p = load()
    const port = p.answer()
    p.fromSite({ type: 'it:state', state: { _page: { draft: 'hello', 'a.b': 'dotted' }, a: { b: 'not this' } }, revision: 1 })
    expect(p.It.store.get('draft')).toBe('hello')
    expect(p.It.store.get('a.b')).toBe('dotted')
    expect(p.It.store.get('missing')).toBeUndefined()
    void p.It.store.set('draft', { text: 'new' })
    await p.advance(0)
    expect(port.sent[0]).toMatchObject({ type: 'it:store', changes: [['draft', '{"text":"new"}']] })
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
    expect(p.fetched).toEqual([{ url: `http://content.test${KEEP}`, init: { cache: 'no-store' } }])
    expect(port.sent).toEqual([])
    p.page.keepStatus = 401
    await p.advance(180_000)
    await p.advance(180_000)
    expect(port.sent).toEqual([{ type: 'it:lapsed' }])
  })

  test('a page that names another site as where its addresses begin still asks at its own, where its showing is', async () => {
    // The address it asks at holds the showing's token, which is for the service that showed the page and for nobody else
    const p = load('<base href="https://elsewhere.invalid/assets/">')
    expect(p.w.document.baseURI).toBe('https://elsewhere.invalid/assets/')
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'))
    p.w.dispatchEvent(new p.w.Event('online'))
    await p.advance(180_000)
    expect(p.fetched.map((f) => f.url)).toEqual(Array(3).fill(`http://content.test${KEEP}`))
  })

  test('a link has its auditing attribute removed, whether it is already there, added later, or changed later', async () => {
    const p = load('<a ping="https://elsewhere.invalid/ping" href="#end">go</a><map><area ping="https://elsewhere.invalid/ping" href="#end"></map>')
    const doc = p.w.document
    expect(doc.querySelectorAll('[ping]').length).toBe(0)
    doc.body.insertAdjacentHTML('beforeend', '<div><a ping="https://elsewhere.invalid/ping" href="#end">later</a></div>')
    await new Promise((r) => setTimeout(r, 5))
    expect(doc.querySelectorAll('[ping]').length).toBe(0)
    for (const link of doc.querySelectorAll('a, area')) link.setAttribute('ping', 'https://elsewhere.invalid/ping')
    await new Promise((r) => setTimeout(r, 5))
    expect(doc.querySelectorAll('[ping]').length).toBe(0)
    expect([...doc.querySelectorAll('a, area')].map((link: any) => link.getAttribute('href'))).toEqual(['#end', '#end', '#end'])
  })

  test('what a page says of telling other sites its address is put back to telling nothing, when it is said and again before a window is opened', async () => {
    // What the page had said at the moment its script opened a window
    const saidWhenOpened: unknown[] = []
    const p = load('', (w) => {
      w.open = (url: string) => {
        saidWhenOpened.push([url, w.document.querySelector('meta[name="Referrer"]')?.getAttribute('content')])
        return null
      }
    })
    const doc = p.w.document
    const settled = () => new Promise((r) => setTimeout(r, 5))
    // As the page's markup is read, which is after this script has run
    doc.head.insertAdjacentHTML('beforeend', '<meta name="Referrer" content="unsafe-url"><meta name="viewport" content="width=device-width">')
    doc.body.insertAdjacentHTML(
      'beforeend',
      '<p><a id="a" referrerpolicy="unsafe-url" href="https://elsewhere.invalid/">out</a></p><img id="i" referrerpolicy="origin"><a id="b">plain</a>',
    )
    await settled()
    const said = () => [
      doc.querySelector('meta[name="Referrer"]').getAttribute('content'),
      doc.getElementById('a').getAttribute('referrerpolicy'),
      doc.getElementById('i').getAttribute('referrerpolicy'),
    ]
    expect(said()).toEqual(['no-referrer', 'no-referrer', 'no-referrer'])
    // Nothing else of the page's is touched
    expect([doc.querySelector('meta[name="viewport"]').getAttribute('content'), doc.getElementById('b').hasAttribute('referrerpolicy')]).toEqual([
      'width=device-width',
      false,
    ])
    // Said again later by the page's script, on what is already there
    doc.querySelector('meta[name="Referrer"]').setAttribute('content', 'no-referrer-when-downgrade')
    doc.getElementById('a').setAttribute('referrerpolicy', 'unsafe-url')
    doc.getElementById('b').setAttribute('referrerpolicy', 'unsafe-url')
    await settled()
    expect([...said(), doc.getElementById('b').getAttribute('referrerpolicy')]).toEqual(Array(4).fill('no-referrer'))
    // And said in the very moment before a window is opened: it is put back before the window is
    doc.querySelector('meta[name="Referrer"]').setAttribute('content', 'unsafe-url')
    p.w.open('https://elsewhere.invalid/next')
    expect(saidWhenOpened).toEqual([['https://elsewhere.invalid/next', 'no-referrer']])
  })

  describe('a way out of the page', () => {
    const settled = () => new Promise((r) => setTimeout(r, 5))
    /** What the page asked the site to open, in order. */
    const openedFor = (p: ReturnType<typeof load>) => p.hellos.filter((m) => m.type === 'it:open').map((m) => m.url)
    /** Clicks an element as a person would, and keeps the page's frame where it is, as the page itself would have done nothing to: the stand-in browser follows no link. */
    const click = (p: ReturnType<typeof load>, el: Element, init: MouseEventInit = {}) => {
      const seen: { target: string | null; rel: string | null }[] = []
      const note = (e: Event) => {
        seen.push({ target: el.getAttribute('target'), rel: el.getAttribute('rel') })
        e.preventDefault()
      }
      el.addEventListener('click', note, { once: true })
      const followed = el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
      return { followed, seen: seen[0] }
    }

    test('a link to another site opens in a tab of its own with no hold either way, and a link within the page or to its own files stays as the page wrote it', async () => {
      const p = load(
        [
          '<a id="plain" href="https://elsewhere.invalid/a">plain</a>',
          '<a id="self" href="https://elsewhere.invalid/b" target="_SELF">self</a>',
          '<a id="top" href="https://elsewhere.invalid/c" target="_top">top</a>',
          '<a id="named" href="https://elsewhere.invalid/d" target="_new">a window by a name</a>',
          '<a id="opener" href="https://elsewhere.invalid/e" target="_blank" rel="opener External">with an opener</a>',
          '<a id="port" href="http://content.test:8080/">another port of the same machine</a>',
          '<map><area id="area" href="https://elsewhere.invalid/f"></map>',
          '<svg><a id="drawn" href="https://elsewhere.invalid/g"><text>drawn</text></a></svg>',
          '<a id="fragment" href="#end">within the page</a>',
          '<a id="own" href="other.html">another of its own files</a>',
          '<a id="whole" href="http://content.test/s/a-token/v/3/b.html">the same, written whole</a>',
          '<a id="ownTab" href="other.html" target="_blank" rel="opener">its own file in a tab</a>',
          '<iframe name="inside"></iframe><a id="inside" href="https://elsewhere.invalid/h" target="inside">in a frame of the page</a>',
          '<a id="mail" href="mailto:someone@example.com">mail</a>',
          '<a id="none">no address</a>',
        ].join(''),
      )
      const doc = p.w.document
      const said = (id: string) => [doc.getElementById(id).getAttribute('target'), doc.getElementById(id).getAttribute('rel')]
      const OUT = ['_blank', 'noopener noreferrer']
      for (const id of ['plain', 'self', 'top', 'named', 'port', 'area', 'drawn']) expect([id, said(id)]).toEqual([id, OUT])
      expect(said('opener')).toEqual(['_blank', 'External noopener noreferrer'])
      for (const id of ['fragment', 'own', 'whole', 'inside', 'mail', 'none'])
        expect([id, said(id)]).toEqual([id, [doc.getElementById(id).getAttribute('target'), null]])
      expect(said('inside')).toEqual(['inside', null])
      expect(said('ownTab')).toEqual(['_blank', 'noopener noreferrer'])
      // Added later, and changed later by the page's own script
      doc.body.insertAdjacentHTML('beforeend', '<div><a id="later" href="https://elsewhere.invalid/later">later</a></div>')
      doc.getElementById('fragment').setAttribute('href', 'https://elsewhere.invalid/now')
      doc.getElementById('plain').setAttribute('target', '_self')
      doc.getElementById('opener').setAttribute('rel', 'opener')
      await settled()
      for (const id of ['later', 'fragment', 'plain', 'opener']) expect([id, said(id)]).toEqual([id, OUT])
      // Each address as the page means it, read against where it says its addresses begin
      doc.head.insertAdjacentHTML('beforeend', '<base href="https://elsewhere.invalid/assets/">')
      doc.body.insertAdjacentHTML('beforeend', '<a id="based" href="next.html">next</a>')
      await settled()
      expect(said('based')).toEqual(OUT)
    })

    test('a link is set right on its way to a click too, before anything else has seen the change', async () => {
      const p = load('<a id="a" href="#top">go</a><a id="b" href="other.html">own</a>')
      const doc = p.w.document
      // Changed by the page and clicked at once, before the document's watcher has run
      const a = doc.getElementById('a')
      a.setAttribute('href', 'https://elsewhere.invalid/')
      expect(click(p, a).seen).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
      const b = doc.getElementById('b')
      b.setAttribute('rel', 'opener')
      b.setAttribute('target', '_blank')
      expect(click(p, b, { button: 1 }).seen).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
      // And from the keyboard, on its way to the click a key gives
      const c = doc.createElement('a')
      doc.body.append(c)
      c.setAttribute('href', 'https://elsewhere.invalid/key')
      c.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect([c.getAttribute('target'), c.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
      // A link the page made and never put in the document is set right on its way as well
      const loose = doc.createElement('a')
      loose.href = 'https://elsewhere.invalid/loose'
      loose.addEventListener('click', (e: Event) => e.preventDefault())
      loose.click()
      expect([loose.getAttribute('target'), loose.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
    })

    test('a mail, phone or messages link is opened by the site from the click, and not followed in the frame, unless the page took the click for itself', async () => {
      const p = load(
        '<a id="mail" href="mailto:someone@example.com?subject=Hi">mail</a><a id="tel" href="tel:+15551234567"><b id="inner">call</b></a><a id="sms" href="sms:+15551234567">text</a><a id="kept" href="mailto:kept@example.com">kept</a>',
      )
      const doc = p.w.document
      const follow = (el: Element) => el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }))
      expect([follow(doc.getElementById('mail')), follow(doc.getElementById('inner')), follow(doc.getElementById('sms'))]).toEqual([false, false, false])
      // The page's own handler took this one, and it is left to the page
      doc.getElementById('kept').addEventListener('click', (e: Event) => e.preventDefault())
      follow(doc.getElementById('kept'))
      // And a link the page made and never put in the document, and a window it asked for
      const loose = doc.createElement('a')
      loose.href = 'mailto:loose@example.com'
      loose.click()
      expect(p.w.open('tel:+15550000000')).toBeNull()
      expect(openedFor(p)).toEqual([
        'mailto:someone@example.com?subject=Hi',
        'tel:+15551234567',
        'sms:+15551234567',
        'mailto:loose@example.com',
        'tel:+15550000000',
      ])
    })

    test('a link that would open a window holding what the page made is not followed, and one followed in the frame is', async () => {
      const p = load(
        '<a id="script" href="javascript:void(0)" target="_blank">script</a><a id="data" href="data:text/html,hi" target="w">data</a><a id="blob" href="blob:http://content.test/0f0" target="_top">blob</a><a id="here" href="javascript:void(0)">here</a><a id="saved" href="blob:http://content.test/0f1" target="_blank" download="notes.txt">saved</a>',
      )
      const doc = p.w.document
      // Whether the click was to be followed once It had seen it: a handler of the page's own, after It's, says, and then keeps the stand-in browser from following it
      const followed: boolean[] = []
      p.w.addEventListener('click', (e: Event) => {
        followed.push(!e.defaultPrevented)
        e.preventDefault()
      })
      for (const id of ['script', 'data', 'blob', 'here', 'saved'])
        doc.getElementById(id).dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }))
      // In the frame, `javascript:` is the page's own script, and a download opens no window
      expect(followed).toEqual([false, false, false, true, true])
      expect(openedFor(p)).toEqual([])
    })

    test('a window the page opens is given no opener and no referrer, one to another site opens in a tab of its own, and one of what the page made is not opened', async () => {
      const asked: unknown[][] = []
      const p = load('<iframe name="inside"></iframe>', (w) => {
        w.open = (...given: unknown[]) => {
          asked.push(given)
          return null
        }
      })
      const w = p.w
      w.open('https://elsewhere.invalid/a')
      w.open('https://elsewhere.invalid/b', '_self', 'popup')
      w.open(new w.URL('https://elsewhere.invalid/c'), 'help', 'noopener=0, noreferrer=no')
      w.open('other.html', '_self')
      w.open('other.html', 'help')
      w.open()
      w.open('https://elsewhere.invalid/d', 'inside')
      for (const refused of [
        'javascript:alert(1)',
        ' JAVA\tSCRIPT:alert(1)',
        'data:text/html,<p>hi',
        'blob:http://content.test/0f0',
        'BLOB:http://content.test/0f1',
      ])
        expect([refused, w.open(refused)]).toEqual([refused, null])
      expect(asked.map(([url, ...rest]) => [url === undefined ? url : String(url), ...rest])).toEqual([
        ['https://elsewhere.invalid/a', '_blank', 'noopener,noreferrer'],
        ['https://elsewhere.invalid/b', '_blank', 'popup,noopener,noreferrer'],
        ['https://elsewhere.invalid/c', '_blank', 'noopener=0, noreferrer=no,noopener,noreferrer'],
        ['other.html', '_self', 'noopener,noreferrer'],
        ['other.html', 'help', 'noopener,noreferrer'],
        [undefined, '_blank', 'noopener,noreferrer'],
        // A frame inside the page is the page's own, and the link is followed there as it asked
        ['https://elsewhere.invalid/d', 'inside', undefined],
      ])
      expect(openedFor(p)).toEqual([])
    })

    test('a form whose answer opens in a window of its own leaves no hold either way, as it appears and on its way out', async () => {
      const p = load(
        '<form id="out" target="_blank" action="https://elsewhere.invalid/"></form><form id="opener" target="_blank" rel="opener"></form><form id="here"><button id="send" formtarget="_blank">send</button></form>',
      )
      const doc = p.w.document
      expect(['out', 'opener', 'here'].map((id) => doc.getElementById(id).getAttribute('rel'))).toEqual(['noopener noreferrer', 'noopener noreferrer', null])
      // Sent by a button that names a window of its own
      const here = doc.getElementById('here')
      let relWhenSent: string | null = 'not sent'
      here.addEventListener('submit', (e: Event) => {
        relWhenSent = here.getAttribute('rel')
        e.preventDefault()
      })
      here.requestSubmit(doc.getElementById('send'))
      expect(relWhenSent).toBe('noopener noreferrer')
      // Changed later by the page's script
      doc.getElementById('opener').setAttribute('rel', 'opener')
      await settled()
      expect(doc.getElementById('opener').getAttribute('rel')).toBe('noopener noreferrer')
    })

    test('It.open asks the site to open an address, read as a link would be, and refuses an address of any other kind', async () => {
      const p = load()
      p.It.open('https://elsewhere.invalid/a?b=c#d')
      p.It.open('next.html')
      p.It.open(new p.w.URL('mailto:someone@example.com'))
      p.It.open('tel:+15551234567')
      p.It.open('sms:+15551234567')
      for (const refused of [
        'javascript:alert(1)',
        'data:text/html,hi',
        'blob:http://content.test/0f0',
        'file:///etc/hosts',
        'ftp://elsewhere.invalid/',
        'http://[not an address',
      ])
        expect(() => p.It.open(refused)).toThrow('It.open opens an address of one of these kinds: http, https, mailto, tel, sms.')
      // Sent to the site alone: the stand-in hears only what is posted to the site's origin
      expect(openedFor(p)).toEqual([
        'https://elsewhere.invalid/a?b=c#d',
        'http://content.test/s/a-token/v/3/next.html',
        'mailto:someone@example.com',
        'tel:+15551234567',
        'sms:+15551234567',
      ])
    })

    test('a link aimed at a name that holds no document, such as an embed or an object that shows a picture, opens a tab of its own with no hold either way, and one aimed at a frame that holds a document is followed there', async () => {
      const asked: unknown[][] = []
      const p = load(
        [
          '<embed name="help" type="image/png"><object name="picture" type="image/png"></object><iframe name="inside"></iframe>',
          '<a id="embed" href="https://elsewhere.invalid/a" target="help">a named embed</a>',
          '<a id="picture" href="https://elsewhere.invalid/b" target="picture">a picture in an object</a>',
          '<a id="own" href="other.html" target="help">its own file, at a named embed</a>',
          '<a id="global" href="https://elsewhere.invalid/c" target="lookalike">a name the page’s script gave something of its own</a>',
          '<a id="inside" href="https://elsewhere.invalid/d" target="inside">a frame of the page</a>',
        ].join(''),
        (w) => {
          w.open = (...given: unknown[]) => {
            asked.push(given)
            return null
          }
          // Something of the page's own under a name, made to look like a frame's window
          w.lookalike = { parent: w }
        },
      )
      const doc = p.w.document
      const said = (id: string) => [doc.getElementById(id).getAttribute('target'), doc.getElementById(id).getAttribute('rel')]
      for (const id of ['embed', 'picture', 'global']) expect([id, said(id)]).toEqual([id, ['_blank', 'noopener noreferrer']])
      // Its own file opens in a window by that name, with no hold either way
      expect(said('own')).toEqual(['help', 'noopener noreferrer'])
      expect(said('inside')).toEqual(['inside', null])
      // And a window the page's script opens at such a name is held to the same
      p.w.open('other.html', 'help')
      p.w.open('https://elsewhere.invalid/e', 'picture')
      p.w.open('https://elsewhere.invalid/f', 'inside')
      expect(asked).toEqual([
        ['other.html', 'help', 'noopener,noreferrer'],
        ['https://elsewhere.invalid/e', '_blank', 'noopener,noreferrer'],
        ['https://elsewhere.invalid/f', 'inside', undefined],
      ])
    })
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

describe('what the page keeps for itself', () => {
  /** The writes the page sent the site of what it keeps, each as its names and values. */
  const writes = (port: Port) =>
    port.sent.filter((m) => m.type === 'it:store').map((m) => Object.fromEntries(m.changes.map(([k, v]: string[]) => [k, JSON.parse(v!)])))
  const lastWrite = (port: Port) => port.sent.filter((m) => m.type === 'it:store').at(-1)

  test('what is set together goes as one write, with the last value under each name, and the next waits for it and for a moment after', async () => {
    const p = load()
    const port = p.answer()
    p.fromSite({ type: 'it:state', state: {}, revision: 1 })
    const answers = [p.It.store.set('a', 1), p.It.store.set('b', 2), p.It.store.set('a', 3)]
    await p.advance(0)
    expect(writes(port)).toEqual([{ a: 3, b: 2 }])
    // Set while that one is on its way: held, and gathered
    void p.It.store.set('c', 4)
    void p.It.store.set('c', 5)
    void p.It.store.set('a', 6)
    await p.advance(0)
    expect(writes(port)).toHaveLength(1)
    p.fromSite({ type: 'it:result', requestId: port.sent[0].requestId, ok: true, revision: 2 })
    await p.advance(0)
    for (const answer of answers) await expect(answer).resolves.toEqual({ ok: true })
    // Answered at once, it is still sent no sooner than a moment after the one before
    expect(writes(port)).toHaveLength(1)
    await p.advance(STORE_EVERY_MS)
    expect(writes(port)).toEqual([
      { a: 3, b: 2 },
      { c: 5, a: 6 },
    ])
    // Once a moment has passed with nothing on its way, what is set goes at once
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: true, revision: 3 })
    await p.advance(STORE_EVERY_MS * 2)
    void p.It.store.set('d', 7)
    await p.advance(0)
    expect(writes(port).at(-1)).toEqual({ d: 7 })
  })

  test('the page sees what it set at once, over any state that does not have it yet, and no handler of its is called for it', async () => {
    const p = load('<p data-it-bind="_page.draft"></p>')
    const port = p.answer()
    const told: unknown[] = []
    p.It.onState((s: any) => told.push(s._page?.draft))
    p.fromSite({ type: 'it:state', state: { status: 'open', _page: { draft: 'old', other: 'o' } }, revision: 1 })
    expect(told).toEqual(['old'])
    void p.It.store.set('draft', 'new')
    void p.It.store.set('other', null)
    // Seen in It.store.get and in It.state at once, and nothing was called for it
    expect(p.It.store.get('draft')).toBe('new')
    expect(p.It.store.get('other')).toBeUndefined()
    expect(p.It.state).toEqual({ status: 'open', _page: { draft: 'new' } })
    expect(told).toEqual(['old'])
    await p.advance(0)
    // A state that does not have it yet, from someone else's change, is shown with it
    p.fromSite({ type: 'it:changed', revision: 2, state: { status: 'busy' }, kept: [] })
    expect(told).toEqual(['old', 'new'])
    expect(p.w.document.querySelector('p').textContent).toBe('new')
    expect(p.It.state.status).toBe('busy')
    // Kept, at revision 3: shown as it is until the state of revision 3 arrives, which has it
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: true, revision: 3 })
    await p.advance(0)
    p.fromSite({ type: 'it:changed', revision: 2, kept: [['draft', 'stale']] })
    expect(p.It.store.get('draft')).toBe('new')
    p.fromSite({
      type: 'it:changed',
      revision: 3,
      kept: [
        ['draft', 'new'],
        ['other', null],
      ],
    })
    expect(p.It.state).toEqual({ status: 'busy', _page: { draft: 'new' } })
    expect(p.It.revision).toBe(3)
    // And from then on it shows what It sends, another display's change included
    p.fromSite({ type: 'it:changed', revision: 4, kept: [['draft', 'theirs']] })
    expect(p.It.store.get('draft')).toBe('theirs')
    expect(told.at(-1)).toBe('theirs')
  })

  test('a write refused for coming too fast is sent again when It says, with what was set meanwhile, and nothing set is lost', async () => {
    const p = load()
    const port = p.answer()
    p.fromSite({ type: 'it:state', state: {}, revision: 1 })
    const first = p.It.store.set('a', 1)
    const second = p.It.store.set('b', 1)
    await p.advance(0)
    void p.It.store.set('b', 2)
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: false, error: 'Too many requests.', retryAfterMs: 900 })
    await p.advance(0)
    // Still shown, still waiting, and not sent again before the wait is over
    expect(p.It.store.get('a')).toBe(1)
    expect(p.It.store.get('b')).toBe(2)
    await p.advance(800)
    expect(writes(port)).toHaveLength(1)
    await p.advance(100)
    expect(writes(port).at(-1)).toEqual({ b: 2, a: 1 })
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: true, revision: 2 })
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: true })
  })

  test('a write refused for good is not kept: its promises reject, and the page sees what It has again', async () => {
    const p = load()
    const port = p.answer()
    const told: unknown[] = []
    p.It.onState((s: any) => told.push(s._page?.draft))
    p.fromSite({ type: 'it:state', state: { _page: { draft: 'kept' } }, revision: 1 })
    const refused = p.It.store.set('draft', 'too much')
    await p.advance(0)
    expect(p.It.store.get('draft')).toBe('too much')
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: false, error: "A page's state is at most 512 KB." })
    await expect(refused).rejects.toThrow("A page's state is at most 512 KB.")
    expect(p.It.store.get('draft')).toBe('kept')
    expect(told).toEqual(['kept', 'kept'])
  })

  test('a value It would not take is refused when it is set, by itself, and one taken as it was then', async () => {
    const p = load()
    const port = p.answer()
    p.fromSite({ type: 'it:state', state: {}, revision: 1 })
    await expect(p.It.store.set('photo', new p.w.Blob(['x']))).rejects.toThrow('A file cannot be kept with It.store.')
    await expect(p.It.store.set('big', 'x'.repeat(40 * 1024))).rejects.toThrow('That is too large to send.')
    await expect(p.It.store.set('fn', { go() {} })).rejects.toThrow('That cannot be sent.')
    await expect(p.It.store.set('when', new p.w.Date())).rejects.toThrow('That cannot be sent.')
    const value = { points: [1, 2] }
    const fine = p.It.store.set('fine', value)
    value.points.push(3)
    await p.advance(0)
    expect(writes(port)).toEqual([{ fine: { points: [1, 2] } }])
    expect(p.It.store.get('fine')).toEqual({ points: [1, 2] })
    p.fromSite({ type: 'it:result', requestId: lastWrite(port).requestId, ok: true, revision: 2 })
    await expect(fine).resolves.toEqual({ ok: true })
  })

  test('what is set before the site has answered is held, and sent as one write once it has', async () => {
    const p = load()
    void p.It.store.set('a', 1)
    void p.It.store.set('b', 2)
    await p.advance(0)
    expect(p.It.store.get('a')).toBe(1)
    const port = p.answer()
    expect(writes(port)).toEqual([{ a: 1, b: 2 }])
  })

  test('a site whose channel takes one value at a time is sent one at a time, and what it refuses is not kept', async () => {
    const p = load()
    const port = p.answer(APP, p.w.parent, null)
    p.fromSite({ type: 'it:state', state: { _page: { b: 'was' } }, revision: 1 })
    const a = p.It.store.set('a', { n: 1 })
    const b = p.It.store.set('b', 'new')
    await p.advance(0)
    expect(port.sent.filter((m) => m.type === 'it:store').map((m) => [m.key, m.value])).toEqual([
      ['a', { n: 1 }],
      ['b', 'new'],
    ])
    const [first, second] = port.sent.filter((m) => m.type === 'it:store')
    p.fromSite({ type: 'it:result', requestId: first.requestId, ok: true })
    p.fromSite({ type: 'it:result', requestId: second.requestId, ok: false, error: 'Too many requests.' })
    await expect(a).resolves.toEqual({ ok: true })
    await expect(b).rejects.toThrow('Too many requests.')
    expect(p.It.store.get('b')).toBe('was')
    // Such a site sends the whole state each time, which is taken as it is
    p.fromSite({ type: 'it:state', state: { _page: { a: { n: 1 }, b: 'was' } }, revision: 2 })
    expect(p.It.state).toEqual({ _page: { a: { n: 1 }, b: 'was' } })
  })

  test('a value kept under a name every object has, as a state written before can hold, is the page’s own value and changes nothing else', async () => {
    const p = load()
    p.answer()
    p.fromSite({ type: 'it:state', state: JSON.parse('{"_page":{"__proto__":{"x":1},"prototype":2}}'), revision: 1 })
    expect(p.It.store.get('__proto__')).toEqual({ x: 1 })
    expect(p.It.store.get('prototype')).toBe(2)
    p.fromSite({ type: 'it:changed', revision: 2, kept: [['__proto__', null]] })
    expect(p.It.store.get('__proto__')).toBeUndefined()
    expect(p.It.state).toEqual({ _page: { prototype: 2 } })
    // Put back by a change, where the object has no such value of its own to change
    p.fromSite({ type: 'it:changed', revision: 3, kept: [['__proto__', { x: 2 }]] })
    const kept = p.It.state._page
    expect(p.It.store.get('__proto__')).toEqual({ x: 2 })
    expect(Object.getPrototypeOf(kept)).toBe(p.w.Object.prototype)
    expect(Object.keys(kept).sort()).toEqual(['__proto__', 'prototype'])
  })

  test('what changed is put together with the state that came before, and anything older is passed over', async () => {
    const p = load('<p data-it-bind="status"></p>')
    p.answer()
    const told: any[] = []
    p.It.onState((s: any) => told.push(s))
    // Before the whole state, what changed has nothing to be put with
    p.fromSite({ type: 'it:changed', revision: 4, kept: [['x', 1]] })
    expect(told).toEqual([])
    p.fromSite({ type: 'it:state', state: { status: 'one', _page: { a: 1, b: 2 } }, revision: 5 })
    const before = p.It.state
    p.fromSite({
      type: 'it:changed',
      revision: 6,
      kept: [
        ['a', null],
        ['c', 3],
      ],
    })
    expect(p.It.state).toEqual({ status: 'one', _page: { b: 2, c: 3 } })
    // A new state each time: what the page was given before is as it was
    expect(before).toEqual({ status: 'one', _page: { a: 1, b: 2 } })
    p.fromSite({ type: 'it:changed', revision: 7, state: { status: 'two' }, kept: [] })
    expect(p.It.state).toEqual({ status: 'two', _page: { b: 2, c: 3 } })
    expect(p.w.document.querySelector('p').textContent).toBe('two')
    p.fromSite({ type: 'it:changed', revision: 7, kept: [['b', 'late']] })
    p.fromSite({
      type: 'it:changed',
      revision: 8,
      kept: [
        ['b', null],
        ['c', null],
      ],
    })
    expect(p.It.state).toEqual({ status: 'two' })
    expect(told.map((s) => p.It.revision && s.status)).toEqual(['one', 'one', 'two', 'two'])
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
    const port = p.answer()
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
    // That a handler failed is said to the site, which says it above the page and to the page's agent: in
    // this program's own words, with nothing of what was thrown, and only the first few times
    const faults = (port.sent as { type: string; message?: string }[]).filter((m) => m.type === 'it:fault')
    expect(faults).toHaveLength(3)
    expect(new Set(faults.map((m) => m.message))).toEqual(
      new Set(['A function the page gave to It.onState failed, so the page may not show what its state says']),
    )
    expect(JSON.stringify(faults)).not.toMatch(/private|acme|draft/)
  })
})

describe('the script itself', () => {
  test('says whose it is and under what terms, in its first line', () => {
    expect(RUNTIME.split('\n')[0]).toMatch(/^\/\*! It\. Copyright \(c\) 2026 Aaryan Kapoor\. Source-available under the It License 1\.1\./)
  })
})
