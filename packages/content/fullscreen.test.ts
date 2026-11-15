// What the script It puts in every page does with an element of the page that is made
// fullscreen, in Chromium and in Firefox themselves: how a browser reads back a style, what it
// does with a popover that is moved or removed, and how it lays an element out are the browser's
// own, which no stand-in for one does. The page is shown here as a document of its own, and the
// test stands in for the site at the other end of its channel: it says It can go fullscreen,
// takes every request for fullscreen, and says It is fullscreen or not as it was asked.
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type BrowserType, chromium, firefox, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest'
import { RUNTIME } from './src/runtime.generated'

/** What the page below gives the tests that run in it. */
declare global {
  interface Window {
    asked: boolean[]
    bar(): void
    settle(): Promise<void>
    fills(el: Element): boolean
    itsStyles(root: ParentNode): number
    It: { isFullscreen: boolean }
  }
}

/** Whether Playwright has this browser on the machine, and can run it here. */
const here = (type: BrowserType): boolean => {
  if ('Bun' in globalThis) return false
  try {
    return existsSync(type.executablePath())
  } catch {
    return false
  }
}
const BROWSERS = [
  ['Chromium', chromium],
  ['Firefox', firefox],
] as const
for (const [name, type] of BROWSERS) {
  const why = 'Bun' in globalThis ? 'Playwright, which runs the browser, does not run under Bun' : `Playwright has no ${name} installed on this machine`
  if (!here(type)) console.log(`  skip  what ${name} makes of an element a page makes fullscreen: ${why}`)
}

/**
 * A page with It in it, whose channel to the site is the test's. The site it stands in for can
 * go fullscreen, and does whatever it is asked at once: `asked` keeps each request, and `bar()`
 * makes It fullscreen as the bar's button does.
 */
const PAGE = `<!doctype html><html><head>
<script>window.__IT__ = { app: location.origin, id: 'film', version: 1, keep: '/keep' }</script>
<script src="/runtime.js"></script>
<script>
  window.asked = []
  const channel = new MessageChannel()
  const say = (message) => channel.port1.postMessage(message)
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'it:fullscreen' || e.ports.length) return
    window.asked.push(e.data.on)
    say({ type: 'it:fullscreen', on: e.data.on, enabled: true })
    say({ type: 'it:result', requestId: e.data.requestId, ok: true })
  })
  window.bar = () => say({ type: 'it:fullscreen', on: true, enabled: true })
  window.postMessage({ type: 'it:port', v: 2 }, location.origin, [channel.port2])
  say({ type: 'it:fullscreen', on: false, enabled: true })
  /** Lets what was posted and what was watched be dealt with. */
  window.settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20))))
  /** Whether an element fills the window, as It's fullscreen makes it fill the page's frame. */
  window.fills = (el) => { const box = el.getBoundingClientRect(); return box.width === innerWidth && box.height === innerHeight }
  /** The styles It put in a document or a shadow root. */
  window.itsStyles = (root) => [...root.querySelectorAll('style')].filter((style) => style.textContent.includes('data-it-fullscreen')).length
</script></head><body></body></html>`

describe.each(BROWSERS)('an element a page makes fullscreen, in %s', (_name, type) => {
  let browser: Browser
  let server: http.Server
  let origin: string
  beforeAll(async () => {
    if (!here(type)) return
    server = http.createServer((req, res) => {
      if (req.url === '/runtime.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(RUNTIME)
      if (req.url === '/keep') return res.writeHead(204).end()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await type.launch({ timeout: 0 })
    // The first page a browser shows can take Firefox on Windows most of the time a test is
    // given, so one is shown here, where there is time for it
    const context = await browser.newContext()
    try {
      const tab = await context.newPage()
      await tab.goto(origin, { timeout: 0 })
      await tab.waitForFunction(() => document.fullscreenEnabled, undefined, { timeout: 0 })
    } finally {
      await context.close()
    }
  }, 300_000)
  // As page.test.ts does: the browser is closed first, and then every connection it left open to
  // the server is ended, since a server that is closed waits for those
  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }, 120_000)
  /** A tab with the page open in it, and It's channel there. */
  async function opened(): Promise<Page> {
    const context = await browser.newContext()
    onTestFinished(() => context.close())
    const tab = await context.newPage()
    await tab.goto(origin)
    await tab.waitForFunction(() => document.fullscreenEnabled)
    return tab
  }

  test.skipIf(!here(type))('a shorthand with a variable in it, in the element’s own style, is exactly as it was when fullscreen ends', async () => {
    const tab = await opened()
    const said = await tab.evaluate(async () => {
      const el = document.body.appendChild(document.createElement('div'))
      el.setAttribute('style', '--gap: 4px; margin: var(--gap) !important; inset: var(--gap); color: blue')
      const before = el.style.cssText
      await el.requestFullscreen()
      const filled = window.fills(el)
      await document.exitFullscreen()
      return { before, after: el.style.cssText, filled }
    })
    expect(said.filled).toBe(true)
    expect(said.after).toBe(said.before)
  })

  test.skipIf(!here(type))(
    'what the page writes to the element’s style while it is fullscreen is kept: what It holds stays It’s until fullscreen ends, and is then what the page wrote',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const el = document.body.appendChild(document.createElement('div'))
        el.setAttribute('style', 'width: 160px !important; height: 90px')
        await el.requestFullscreen()
        el.style.setProperty('width', '320px', 'important')
        el.style.color = 'red'
        await window.settle()
        const filled = window.fills(el)
        // And the page's own way of writing all of it at once, which says nothing of where It holds the element
        el.setAttribute('style', 'width: 320px !important; height: 50px; color: red; outline: 2px solid green')
        await window.settle()
        const filledStill = window.fills(el)
        await document.exitFullscreen()
        return {
          filled,
          filledStill,
          width: [el.style.getPropertyValue('width'), el.style.getPropertyPriority('width')],
          height: el.style.getPropertyValue('height'),
          color: el.style.color,
          outline: el.style.outline,
          position: el.style.position,
        }
      })
      expect(said).toEqual({
        filled: true,
        filledStill: true,
        width: ['320px', 'important'],
        height: '50px',
        color: 'red',
        outline: expect.stringContaining('green'),
        position: '',
      })
    },
  )

  test.skipIf(!here(type))(
    'an element moved while it is fullscreen, into another part of the page or into a shadow root, still fills the frame, and its look goes with it',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const el = document.body.appendChild(document.createElement('div'))
        await el.requestFullscreen()
        document.body.appendChild(document.createElement('section')).append(el)
        await window.settle()
        const movedInPage = window.fills(el)
        const host = document.body.appendChild(document.createElement('div'))
        const shadow = host.attachShadow({ mode: 'open' })
        shadow.append(el)
        await window.settle()
        const movedIntoShadow = { fills: window.fills(el), inShadow: window.itsStyles(shadow), inDocument: window.itsStyles(document) }
        await document.exitFullscreen()
        return {
          movedInPage,
          movedIntoShadow,
          after: { inShadow: window.itsStyles(shadow), inDocument: window.itsStyles(document), popover: el.hasAttribute('popover') },
        }
      })
      expect(said).toEqual({
        movedInPage: true,
        movedIntoShadow: { fills: true, inShadow: 1, inDocument: 0 },
        after: { inShadow: 0, inDocument: 0, popover: false },
      })
    },
  )

  test.skipIf(!here(type))(
    'a page that puts its own size back each time It holds the element is not fought without end: It holds it once a frame, timers and frames go on, and the page’s style is what it wrote once fullscreen ends',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const el = document.body.appendChild(document.createElement('div'))
        el.setAttribute('style', 'width: 200px; height: 100px')
        await el.requestFullscreen()
        // A page that watches the element's style and writes its own width back whenever it is not that
        let written = 0
        const watcher = new MutationObserver(() => {
          if (++written > 5000) return watcher.disconnect()
          if (el.style.width !== '200px') el.style.setProperty('width', '200px')
        })
        watcher.observe(el, { attributes: true, attributeFilter: ['style'] })
        el.style.setProperty('width', '200px')
        // Timers and frames still run all the while
        let ticks = 0
        let frames = 0
        const ticking = setInterval(() => ticks++, 10)
        const frame = () => {
          frames++
          if (frames < 1000) requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        const began = performance.now()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const took = performance.now() - began
        clearInterval(ticking)
        watcher.disconnect()
        const fullscreen = document.fullscreenElement === el
        await document.exitFullscreen()
        await window.settle()
        return {
          // About one write of the page's for each of It's, and one of It's in a frame at most
          writesPerFrame: written <= 2 * frames + 4,
          timersRan: ticks > 20,
          framesRan: frames > took / 100,
          fullscreen,
          asked: window.asked,
          style: [el.style.width, el.style.height, el.style.position],
          styles: window.itsStyles(document),
        }
      })
      expect(said).toEqual({
        writesPerFrame: true,
        timersRan: true,
        framesRan: true,
        fullscreen: true,
        asked: [true, false],
        style: ['200px', '100px', ''],
        styles: 0,
      })
    },
  )

  test.skipIf(!here(type))(
    'a page that animates the element’s size, or writes its whole style again as it draws, stays fullscreen, and its last writes are its style once fullscreen ends',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const el = document.body.appendChild(document.createElement('div'))
        el.setAttribute('style', 'width: 100px; height: 50px')
        await el.requestFullscreen()
        // A width animated on every frame for a second
        const began = performance.now()
        await new Promise<void>((resolve) => {
          const step = () => {
            const t = performance.now() - began
            el.style.width = `${100 + Math.round(t / 10)}px`
            if (t < 1000) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        })
        await window.settle()
        const afterAnimation = document.fullscreenElement === el && window.fills(el)
        // And a framework that writes the whole style attribute again every 100 ms for a second
        for (let i = 0; i < 10; i++) {
          el.setAttribute('style', `width: ${300 + i}px; height: 60px; color: rgb(${i}, 0, 0)`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        await window.settle()
        const afterRenders = document.fullscreenElement === el && window.fills(el)
        await document.exitFullscreen()
        await window.settle()
        return { afterAnimation, afterRenders, asked: window.asked, style: [el.style.width, el.style.height, el.style.color, el.style.position] }
      })
      expect(said).toEqual({ afterAnimation: true, afterRenders: true, asked: [true, false], style: ['309px', '60px', 'rgb(9, 0, 0)', ''] })
    },
  )

  test.skipIf(!here(type))(
    'a popover of the page’s own that is moved while it is fullscreen, which the move closes, is let go: it is not left fullscreen and unseen, and is not shown again by It',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const el = document.body.appendChild(document.createElement('div'))
        el.setAttribute('popover', 'manual')
        el.showPopover()
        await el.requestFullscreen()
        const filled = window.fills(el)
        document.body.appendChild(document.createElement('section')).append(el)
        await window.settle()
        return {
          filled,
          fullscreen: document.fullscreenElement,
          asked: window.asked,
          popover: [el.getAttribute('popover'), el.matches(':popover-open')],
          mark: el.hasAttribute('data-it-fullscreen'),
          styles: window.itsStyles(document),
        }
      })
      expect(said).toEqual({ filled: true, fullscreen: null, asked: [true, false], popover: ['manual', false], mark: false, styles: 0 })
    },
  )

  test.skipIf(!here(type))(
    'an element removed while it is fullscreen ends It’s fullscreen for it at once, as a browser’s own does, and the page hears so at its document',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const heard: string[] = []
        document.addEventListener('fullscreenchange', (e) => heard.push(e.target === document ? 'document' : (e.target as Element).localName))
        const el = document.body.appendChild(document.createElement('div'))
        await el.requestFullscreen()
        el.remove()
        await window.settle()
        return {
          heard,
          fullscreen: document.fullscreenElement,
          isFullscreen: window.It.isFullscreen,
          asked: window.asked,
          left: {
            mark: el.hasAttribute('data-it-fullscreen'),
            style: el.getAttribute('style'),
            popover: el.hasAttribute('popover'),
            styles: window.itsStyles(document),
          },
        }
      })
      expect(said).toEqual({
        heard: ['div', 'document'],
        fullscreen: null,
        isFullscreen: false,
        // It was asked to leave fullscreen, as the page's element is gone
        asked: [true, false],
        left: { mark: false, style: null, popover: false, styles: 0 },
      })
    },
  )

  test.skipIf(!here(type))(
    'where It’s fullscreen began with the page’s document, as from the bar, an element removed from it gives fullscreen back to the document',
    async () => {
      const tab = await opened()
      const said = await tab.evaluate(async () => {
        const heard: string[] = []
        window.bar()
        await window.settle()
        document.addEventListener('fullscreenchange', (e) => heard.push(e.target === document ? 'document' : (e.target as Element).localName))
        const el = document.body.appendChild(document.createElement('div'))
        await el.requestFullscreen()
        el.remove()
        await window.settle()
        return {
          heard,
          fullscreen: document.fullscreenElement === document.documentElement,
          marked: document.documentElement.hasAttribute('data-it-fullscreen'),
          asked: window.asked,
          styles: window.itsStyles(document),
        }
      })
      expect(said).toEqual({ heard: ['div', 'document'], fullscreen: true, marked: true, asked: [], styles: 0 })
    },
  )
})
