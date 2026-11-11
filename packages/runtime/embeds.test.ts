// Players and maps from the providers on It's list, as the script inside a page asks the site to
// host them: frames of the page's own that name one are taken up, `It.embed` asks outright, and
// where each one's element is goes to the site on each frame that it changes. The script runs as
// it is built and served, in a stand-in for a browser that lays nothing out, so where an element
// is on the screen is said by the test.

import { EMBED } from '@it/protocol'
import { JSDOM } from 'jsdom'
import { describe, expect, test, vi } from 'vitest'
import { RUNTIME } from '../content/src/runtime.generated'

const APP = 'http://app.test'
const YOUTUBE = 'https://www.youtube.com/embed/aqz-KE-bpKQ'
const VIMEO = 'https://player.vimeo.com/video/76979871'

interface Port {
  sent: any[]
  postMessage: (m: unknown) => void
  onmessage: ((e: { data: unknown }) => void) | null
  close: () => void
}

/** Where an element is on the screen, as a browser that lays things out would say. */
function lay(el: Element, { x = 0, y = 0, width = 0, height = 0, border = 0, scale = 1 } = {}) {
  // Laid out at its own size, and drawn `scale` times that on the screen, as a transform draws it
  const [w, h] = [width * scale, height * scale]
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect
  for (const [name, value] of Object.entries({
    offsetWidth: width,
    offsetHeight: height,
    clientWidth: Math.max(0, width - 2 * border),
    clientHeight: Math.max(0, height - 2 * border),
    clientLeft: border,
    clientTop: border,
  }))
    Object.defineProperty(el, name, { value, configurable: true })
}

/** Loads the script into a fresh page that the test lays out by hand, with the drawing of each frame held until the test runs it. */
function load(html = '') {
  const dom = new JSDOM(`<!doctype html><head></head><body>${html}</body>`, {
    url: 'http://content.test/s/a-token/v/3/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window as any
  w.__IT__ = { app: APP, id: 'film', version: 3, keep: '/s/a-token/__it/keep' }
  /** What the script posted to the window that framed it: its hellos, and its answers to the site's asking which document it is. */
  const toParent: any[] = []
  w.parent.postMessage = (m: unknown) => toParent.push(m)
  w.fetch = async () => ({ status: 204 })
  w.setInterval = () => 0
  let drawing: (() => void)[] = []
  w.requestAnimationFrame = (fn: () => void) => drawing.push(fn)
  // The window is 800 by 600, without scroll bars
  Object.defineProperty(w.document.documentElement, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(w.document.documentElement, 'clientHeight', { value: 600, configurable: true })
  w.eval(RUNTIME)
  let port: Port | null = null
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return {
    w,
    It: w.It,
    toParent,
    doc: w.document as Document,
    /** Something the site posts to the page's own window, as it does its asking and its word that a document is gone. */
    toWindow: (data: unknown) => w.dispatchEvent(Object.assign(new w.Event('message'), { origin: APP, source: w.parent, data, ports: [] })),
    /** The site hands over its channel, saying whether it hosts embeds. */
    async answer(embeds = true) {
      const p: Port = { sent: [], postMessage: (m) => p.sent.push(structuredClone(m)), onmessage: null, close: () => {} }
      port = p
      w.dispatchEvent(Object.assign(new w.Event('message'), { origin: APP, source: w.parent, data: { type: 'it:port', v: 2, embeds }, ports: [p] }))
      await settle()
      return p
    },
    /** What was sent to the site about embeds. */
    said: () => (port?.sent ?? []).filter((m) => String(m.type).startsWith('it:embed')),
    /** Draws a frame, as the browser does. */
    async draw() {
      const now = drawing
      drawing = []
      for (const fn of now) fn()
      await settle()
    },
    fromSite: (data: unknown) => port?.onmessage?.({ data }),
    settle,
  }
}

describe('frames of the page’s own that name an embed on the list', () => {
  test('one in the markup keeps its place, is given an empty document of its own, and is asked of the site by its address once the site says it hosts embeds', async () => {
    const p = load(`<iframe id="film" width="560" height="315" src="${YOUTUBE}"></iframe><iframe id="other" src="https://example.com/"></iframe>`)
    await p.settle()
    const film = p.doc.getElementById('film')!
    expect(film.getAttribute('srcdoc')).toBe('')
    expect(film.getAttribute('src')).toBe(YOUTUBE)
    // A frame that names anything else is left as it is
    expect(p.doc.getElementById('other')!.hasAttribute('srcdoc')).toBe(false)
    // Nothing is asked before there is a channel to the site
    expect(p.said()).toEqual([])
    await p.answer()
    expect(p.said()).toEqual([{ type: 'it:embed', id: expect.any(String), url: YOUTUBE }])
  })

  test('where the site does not host embeds, as a card’s small picture of the page does not, each frame’s place is left empty, and its player is not loaded inside the page', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe><iframe id="other" src="https://example.com/"></iframe>`)
    await p.settle()
    await p.answer(false)
    expect(p.doc.getElementById('film')!.getAttribute('srcdoc')).toBe('')
    expect(p.said()).toEqual([])
    // And one added later is left empty too, while a frame that names anything else loads it
    const later = p.doc.body.appendChild(p.doc.createElement('iframe'))
    later.src = VIMEO
    await p.settle()
    expect(later.getAttribute('srcdoc')).toBe('')
    expect(p.doc.getElementById('other')!.hasAttribute('srcdoc')).toBe(false)
    expect(p.said()).toEqual([])
  })

  test('one added by the page’s script is taken up, and one whose address changes is asked for anew, or let go of where the new address is no embed', async () => {
    const p = load()
    await p.answer()
    const frame = p.doc.createElement('iframe')
    frame.src = YOUTUBE
    p.doc.body.append(frame)
    await p.settle()
    const [first] = p.said()
    expect(first).toMatchObject({ type: 'it:embed', url: YOUTUBE })
    frame.src = VIMEO
    await p.settle()
    const [, ended, second] = p.said()
    expect(ended).toEqual({ type: 'it:embed-end', id: first.id })
    expect(second).toMatchObject({ type: 'it:embed', url: VIMEO })
    expect(second.id).not.toBe(first.id)
    // The same address again asks for nothing
    frame.setAttribute('src', VIMEO)
    await p.settle()
    expect(p.said().length).toBe(3)
    // An address that is no embed is the page's own to load
    frame.src = 'https://example.com/'
    await p.settle()
    expect(p.said().at(-1)).toEqual({ type: 'it:embed-end', id: second.id })
    expect(frame.hasAttribute('srcdoc')).toBe(false)
  })

  test('an address written as a path from the page, or on http, is read as a browser reads it, and an address on the list is taken in its one spelling', async () => {
    const p = load(
      '<base href="https://www.youtube.com/"><iframe id="a" src="embed/abc?start=10"></iframe><iframe id="b" src="http://WWW.YouTube.com/embed/def"></iframe>',
    )
    await p.answer()
    expect(p.said().map((m) => m.url)).toEqual(['https://www.youtube.com/embed/abc?start=10', 'https://www.youtube.com/embed/def'])
  })

  test('a frame whose own document is written into it is not taken up', async () => {
    const p = load(`<iframe srcdoc="<p>hello</p>" src="${YOUTUBE}"></iframe>`)
    await p.answer()
    expect(p.said()).toEqual([])
  })

  test('a frame taken out of the page takes its embed with it, at the next frame drawn', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe>`)
    const film = p.doc.getElementById('film')!
    lay(film, { x: 10, y: 20, width: 560, height: 315 })
    await p.answer()
    const id = p.said()[0].id
    await p.draw()
    film.remove()
    await p.draw()
    expect(p.said().at(-1)).toEqual({ type: 'it:embed-end', id })
  })

  test('no more than a page may have are asked of the site, and the rest are left empty', async () => {
    const frames = Array.from({ length: EMBED.most + 2 }, (_, i) => `<iframe src="${YOUTUBE}${i}"></iframe>`).join('')
    const p = load(frames)
    await p.answer()
    expect(p.said().length).toBe(EMBED.most)
    expect([...p.doc.querySelectorAll('iframe')].every((f) => f.getAttribute('srcdoc') === '')).toBe(true)
  })

  test('a document that is going takes its embeds with it', async () => {
    const p = load(`<iframe src="${YOUTUBE}"></iframe><iframe src="${VIMEO}"></iframe>`)
    await p.answer()
    const ids = p.said().map((m) => m.id)
    p.w.dispatchEvent(new p.w.Event('pagehide'))
    expect(
      p
        .said()
        .filter((m) => m.type === 'it:embed-end')
        .map((m) => m.id),
    ).toEqual(ids)
  })

  test('one the site refuses is left empty, and the page’s console says why', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe>`)
    await p.answer()
    const warned = vi.spyOn(p.w.console, 'warn').mockImplementation(() => {})
    p.fromSite({ type: 'it:embed-refused', id: p.said()[0].id, error: 'This page is asking for players and maps too fast. Try again in a moment.' })
    expect(p.doc.getElementById('film')!.getAttribute('srcdoc')).toBe('')
    expect(warned).toHaveBeenCalledWith('[It] This page is asking for players and maps too fast. Try again in a moment.')
  })
})

describe('a channel that the site took to be gone', () => {
  test('told that the site took it to be gone, the script lets go of its channel, says hello again under a new name, and over the new channel sends again the action that was on its way, under the same id, keeps what it was keeping and asks for its players again', async () => {
    const p = load('<div id="slot"></div>')
    const slot = p.doc.getElementById('slot')!
    lay(slot, { x: 0, y: 0, width: 320, height: 180 })
    const first = await p.answer()
    const player = p.It.embed(slot, YOUTUBE)
    await p.draw()
    const kept = p.It.store.set('volume', 7)
    const sent = p.It.action('approve', {})
    await p.settle()
    expect(first.sent.map((m) => m.type).sort()).toEqual(['it:action', 'it:embed', 'it:embed-at', 'it:store'])
    const named = p.toParent.filter((m) => m.type === 'it:hello').map((m) => m.doc)
    expect(new Set(named).size).toBe(1)
    let settled = 'waiting'
    sent.then(
      () => (settled = 'accepted'),
      () => (settled = 'refused'),
    )
    p.toWindow({ type: 'it:gone' })
    await p.settle()
    // The action is not refused for that: it may still be done, and it is sent again rather than tried again under a new id
    expect(settled).toBe('waiting')
    // Nothing more goes over the old channel, and nothing piles up while there is none
    player.post('{"event":"listening"}')
    await p.draw()
    expect(first.sent.length).toBe(4)
    const again = p.toParent.filter((m) => m.type === 'it:hello').at(-1)
    expect(again.doc).not.toBe(named[0])
    const second = await p.answer()
    await new Promise((r) => setTimeout(r, 150))
    await p.draw()
    const types = second.sent.map((m) => m.type)
    expect(types).toContain('it:embed')
    expect(second.sent.find((m) => m.type === 'it:embed')).toEqual({ type: 'it:embed', id: first.sent[0].id, url: YOUTUBE })
    expect(second.sent.find((m) => m.type === 'it:embed-at')).toMatchObject({ id: first.sent[0].id, width: 320, shown: true })
    const store = second.sent.find((m) => m.type === 'it:store')
    expect(store.changes).toEqual([['volume', '7']])
    second.onmessage?.({ data: { type: 'it:result', requestId: store.requestId, ok: true, revision: 2 } })
    await expect(kept).resolves.toEqual({ ok: true })
    // The action goes again as it was, the first thing over the new channel: the same request, and the same id the site and the backend know it by
    const before = first.sent.find((m) => m.type === 'it:action')
    expect(second.sent[0]).toEqual({ ...before, again: true })
    expect(second.sent.filter((m) => m.type === 'it:action').length).toBe(1)
    second.onmessage?.({ data: { type: 'it:result', requestId: before.requestId, ok: true, actionId: 'action-1' } })
    await expect(sent).resolves.toEqual({ ok: true, id: 'action-1' })
  })
})

describe('where an embed’s element is, as the site is told it', () => {
  test('its inside, within its border, in the page’s own pixels, sent once for each change and not for a frame where nothing changed', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe>`)
    const film = p.doc.getElementById('film')!
    lay(film, { x: 40, y: 100, width: 564, height: 319, border: 2 })
    await p.answer()
    await p.draw()
    const id = p.said()[0].id
    expect(p.said()[1]).toEqual({ type: 'it:embed-at', id, x: 42, y: 102, width: 560, height: 315, cut: [0, 0, 0, 0], round: 0, shown: true })
    await p.draw()
    expect(p.said().length).toBe(2)
    lay(film, { x: 40, y: 60, width: 564, height: 319, border: 2 })
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ type: 'it:embed-at', y: 62, shown: true })
  })

  test('cut where the window cuts it, and hidden once none of it is in the window', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe>`)
    const film = p.doc.getElementById('film')!
    lay(film, { x: 0, y: -100, width: 400, height: 300 })
    await p.answer()
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ cut: [100, 0, 0, 0], shown: true })
    lay(film, { x: 700, y: 500, width: 400, height: 300 })
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ cut: [0, 300, 200, 0], shown: true })
    lay(film, { x: 0, y: -400, width: 400, height: 300 })
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ shown: false })
  })

  test('cut where a box that holds it and clips what it holds cuts it, across or down as that box clips', async () => {
    // Both ways said outright: a browser makes a box that scrolls one way clip the other too, and the stand-in does not
    const p = load(
      `<div id="list" style="overflow-x: hidden; overflow-y: auto"><div><iframe id="film" src="${YOUTUBE}"></iframe></div></div><div id="strip" style="overflow-x: clip"><iframe id="map" src="https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4"></iframe></div>`,
    )
    lay(p.doc.getElementById('list')!, { x: 100, y: 100, width: 300, height: 200 })
    lay(p.doc.getElementById('film')!, { x: 50, y: 250, width: 400, height: 100 })
    // A box that clips only across leaves what reaches out below it uncut
    lay(p.doc.getElementById('strip')!, { x: 0, y: 400, width: 200, height: 50 })
    lay(p.doc.getElementById('map')!, { x: 100, y: 420, width: 200, height: 100 })
    await p.answer()
    await p.draw()
    const [film, map] = p.said().filter((m) => m.type === 'it:embed-at')
    expect(film).toMatchObject({ x: 50, y: 250, cut: [0, 50, 50, 50], shown: true })
    expect(map).toMatchObject({ cut: [0, 100, 0, 0], shown: true })
  })

  test('cut where a box that holds it is drawn smaller than it is laid out, at the box’s size on the screen', async () => {
    // A box 400 by 400 as laid out, drawn at half that size: 200 by 200 on the screen
    const p = load(`<div id="small" style="overflow-x: hidden; overflow-y: hidden"><iframe id="film" src="${YOUTUBE}"></iframe></div>`)
    lay(p.doc.getElementById('small')!, { x: 100, y: 100, width: 400, height: 400, border: 10, scale: 0.5 })
    lay(p.doc.getElementById('film')!, { x: 100, y: 100, width: 600, height: 600, scale: 0.5 })
    await p.answer()
    await p.draw()
    // The box's inside on the screen runs from 105 to 295 each way, within its border of 5 pixels drawn
    expect(p.said().at(-1)).toMatchObject({ x: 100, y: 100, width: 300, height: 300, cut: [5, 105, 105, 5], shown: true })
  })

  test('hidden while it is hidden, and its corners rounded as its own are', async () => {
    // Each corner said by itself: the stand-in does not take the shorthand apart, as a browser does
    const p = load(
      `<iframe id="film" style="border-top-left-radius: 12px; border-top-right-radius: 12px; border-bottom-right-radius: 12px; border-bottom-left-radius: 12px" src="${YOUTUBE}"></iframe>`,
    )
    const film = p.doc.getElementById('film')!
    lay(film, { x: 0, y: 0, width: 300, height: 200 })
    await p.answer()
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ round: 12, shown: true })
    film.style.visibility = 'hidden'
    await p.draw()
    expect(p.said().at(-1)).toMatchObject({ shown: false })
  })
})

describe('It.embed', () => {
  test('hosts an embed over any element, and gives back its provider, its address and a way to talk to it', async () => {
    const p = load('<div id="slot"></div>')
    const slot = p.doc.getElementById('slot')!
    lay(slot, { x: 0, y: 0, width: 640, height: 360 })
    const player = p.It.embed(slot, `${YOUTUBE}?enablejsapi=1`)
    expect([player.provider, player.url]).toEqual(['YouTube', `${YOUTUBE}?enablejsapi=1`])
    // Posted before the site has said anything: held, and sent once it has
    player.post('{"event":"listening"}')
    await p.answer()
    const id = p.said()[0].id
    expect(p.said()).toEqual([
      { type: 'it:embed', id, url: `${YOUTUBE}?enablejsapi=1` },
      { type: 'it:embed-post', id, data: '{"event":"listening"}' },
    ])
    player.post({ event: 'command', func: 'playVideo', args: [] })
    expect(p.said().at(-1)).toEqual({ type: 'it:embed-post', id, data: { event: 'command', func: 'playVideo', args: [] } })
    // What the player says, and that its frame loaded, come back to the page
    const heard: unknown[] = []
    player.onmessage = (e: { data: unknown }) => heard.push(e.data)
    player.onload = () => heard.push('loaded')
    p.fromSite({ type: 'it:embed-loaded', id })
    p.fromSite({ type: 'it:embed-message', id, data: '{"event":"onReady"}' })
    p.fromSite({ type: 'it:embed-message', id: 'another', data: 'not this one' })
    expect(heard).toEqual(['loaded', '{"event":"onReady"}'])
    player.remove()
    expect(p.said().at(-1)).toEqual({ type: 'it:embed-end', id })
    expect(() => player.post('x')).toThrow('This embed has been taken away.')
  })

  test('refuses an address that is not the embed of a provider on the list, and a message that is not plain data or is too large', async () => {
    const p = load('<div id="slot"></div>')
    const slot = p.doc.getElementById('slot')!
    expect(() => p.It.embed(slot, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')).toThrow(
      'It.embed hosts players and maps from YouTube, Vimeo, Spotify, SoundCloud, Google Maps, OpenStreetMap and Twitch only',
    )
    expect(() => p.It.embed(slot, 'https://evil.example/embed/x')).toThrow('It.embed hosts')
    expect(() => p.It.embed('#slot', YOUTUBE)).toThrow('the first argument is an element')
    await p.answer()
    const player = p.It.embed(slot, YOUTUBE)
    expect(() => player.post({ go: () => {} })).toThrow('That cannot be sent.')
    expect(() => player.post('x'.repeat(EMBED.messageBytes + 1))).toThrow('too large')
    expect(p.said().filter((m) => m.type === 'it:embed-post')).toEqual([])
  })

  test('given a frame the page wrote, it is the embed that frame names, already hosted, and the frame is not taken up a second time', async () => {
    const p = load(`<iframe id="film" src="${YOUTUBE}"></iframe>`)
    await p.answer()
    const film = p.doc.getElementById('film')!
    const player = p.It.embed(film)
    expect(player.url).toBe(YOUTUBE)
    expect(p.said().length).toBe(1)
    // Now that the page has asked for it, a new address for the frame is the page's to give through It.embed
    film.setAttribute('src', VIMEO)
    await p.settle()
    expect(p.said().length).toBe(1)
    // And another embed asked of the same element takes the place of the first
    const other = p.It.embed(film, VIMEO)
    expect(p.said().slice(1)).toEqual([
      { type: 'it:embed-end', id: p.said()[0].id },
      { type: 'it:embed', id: expect.any(String), url: VIMEO },
    ])
    expect(other.provider).toBe('Vimeo')
  })

  test('what the page’s own message handler throws is said as any error of the page’s script is, and the next message still arrives', async () => {
    const p = load('<div id="slot"></div>')
    await p.answer()
    const player = p.It.embed(p.doc.getElementById('slot')!, YOUTUBE)
    const id = p.said()[0].id
    const thrown: unknown[] = []
    p.w.setTimeout = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        thrown.push(err)
      }
    }
    const heard: unknown[] = []
    player.onmessage = (e: { data: unknown }) => {
      heard.push(e.data)
      if (e.data === 'first') throw new Error('the page’s own mistake')
    }
    p.fromSite({ type: 'it:embed-message', id, data: 'first' })
    p.fromSite({ type: 'it:embed-message', id, data: 'second' })
    expect(heard).toEqual(['first', 'second'])
    expect(thrown.map((e) => (e as Error).message)).toEqual(['the page’s own mistake'])
  })
})
