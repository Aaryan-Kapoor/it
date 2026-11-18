// @vitest-environment node
// A player's own fullscreen being made the site's, in Chromium and in Firefox themselves: when a
// browser answers a request to leave fullscreen or to enter it, and in which order it says so
// by a promise and by an event, are the browser's own, which no stand-in for one does. The
// site's fullscreen is loaded here as it is written, in a document that stands in for the site,
// with a frame of another origin in it that stands in for a player: its button makes it
// fullscreen as a player's own button does. The test hosts that player, and stops hosting it at
// a moment of its choosing, as the site does when the player's page is closed or replaced.
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { type Browser, type BrowserType, chromium, firefox, type Page } from 'playwright'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest'

/** When the test's site stops hosting its player, or loses the player alone, and never if it is neither. */
type Ends =
  | 'never'
  | 'host, while the player’s own fullscreen is left'
  | 'player, while the player’s own fullscreen is left'
  | 'host, once the site’s fullscreen is asked for'
/** What the document below gives the tests that run in it. */
interface Site {
  /** When the player's page ends, which the test says before the click. */
  ends: Ends
  /** What the host of the player was told, in order. */
  told: string[]
  /** What the browser was asked and what it answered, and what it had fullscreen at each change, in order. */
  seen: string[]
  itsFullscreen: { fullscreenOn(): boolean }
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
  if (!here(type)) console.log(`  skip  what ${name} makes of a player’s fullscreen whose page has gone: ${why}`)
}

/** A player from elsewhere, with a fullscreen button of its own. */
const PLAYER = `<!doctype html><html><body>
<button id="full" onclick="document.documentElement.requestFullscreen().catch(() => {})">Full screen</button>
</body></html>`

/**
 * The site, as far as its fullscreen goes: the module under test, a player in a frame that has
 * no origin of the site's, and a host for that player. The host stops, or loses its player, at
 * the moment `ends` names: in the very turn the browser says the player went fullscreen, which
 * is when the site asks to leave that, or in the turn the site asks for its own fullscreen.
 */
const SITE = `<!doctype html><html><body>
<script src="/fullscreen.js"></script>
<iframe id="player" src="/player" sandbox="allow-scripts" allow="fullscreen *" style="width: 320px; height: 180px"></iframe>
<script>
  window.ends = 'never'
  window.told = []
  window.seen = []
  const player = document.getElementById('player')
  let has = true
  const stop = itsFullscreen.hostPlayers({
    owns: (frame) => has && frame === player,
    fill: (frame) => told.push(frame === player ? 'fill' : 'fill another'),
    unfill: () => told.push('unfill'),
  })
  // Added after the module's own listener, so it runs just after the site asked to leave the player's fullscreen
  document.addEventListener('fullscreenchange', () => {
    const now = document.fullscreenElement
    seen.push(now === document.documentElement ? 'site' : now === player ? 'player' : now ? 'another' : 'nothing')
    if (now !== player) return
    if (ends.startsWith('host, while')) stop()
    if (ends.startsWith('player, while')) has = false
  })
  const whole = document.documentElement
  const ask = whole.requestFullscreen
  whole.requestFullscreen = function (...how) {
    seen.push('site asked')
    const answer = ask.apply(this, how)
    answer.then(() => seen.push('granted'), () => seen.push('refused'))
    if (ends.startsWith('host, once')) stop()
    return answer
  }
</script></body></html>`

describe.each(BROWSERS)('a player’s own fullscreen made the site’s, in %s', (_name, type) => {
  let browser: Browser
  let server: http.Server
  let origin: string
  beforeAll(async () => {
    if (!here(type)) return
    // The module as the site has it, with what it imports, as one script that names it `itsFullscreen`
    const built = await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('./fullscreen.ts', import.meta.url)), formats: ['iife'], name: 'itsFullscreen' },
      },
    })
    const output = Array.isArray(built) ? built[0] : built
    if (!output || !('output' in output)) throw new Error('The site’s fullscreen was not built.')
    const script = output.output[0].code
    server = http.createServer((req, res) => {
      if (req.url === '/fullscreen.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(script)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/player' ? PLAYER : SITE)
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
  // The browser is closed first, and then every connection it left open to the server is ended,
  // since a server that is closed waits for those
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

  /** What the site has fullscreen, and what its host and the test's own listeners wrote down. */
  const state = (tab: Page) =>
    tab.evaluate(() => {
      const site = window as unknown as Site
      const now = document.fullscreenElement
      return {
        fullscreen: now === document.documentElement ? 'site' : now ? 'another' : 'nothing',
        on: site.itsFullscreen.fullscreenOn(),
        told: [...site.told],
        seen: [...site.seen],
      }
    })
  /** A tab with the site in it, whose player's own fullscreen button the person has just pressed. */
  async function pressed(ends: Ends): Promise<Page> {
    const context = await browser.newContext()
    onTestFinished(() => context.close())
    const tab = await context.newPage()
    await tab.goto(origin)
    await tab.waitForFunction(() => document.fullscreenEnabled)
    await tab.evaluate((when) => {
      ;(window as unknown as Site).ends = when
    }, ends)
    await tab.frameLocator('#player').locator('#full').click()
    // The browser made the player fullscreen by itself, over the whole of the site
    await tab.waitForFunction(() => (window as unknown as Site).seen.includes('player'))
    return tab
  }
  /** Waits until the browser has nothing fullscreen, and then for as long again as it could take to be asked for more. */
  async function nothingFullscreen(tab: Page) {
    await tab.waitForFunction(() => document.fullscreenElement === null)
    await tab.waitForTimeout(500)
  }

  test.skipIf(!here(type))(
    'a player whose page is still there is given the site’s fullscreen in place of its own, and is laid over the page',
    async () => {
      const tab = await pressed('never')
      await tab.waitForFunction(() => (window as unknown as Site).told.length > 0)
      await tab.waitForFunction(() => (window as unknown as Site).itsFullscreen.fullscreenOn())
      const { fullscreen, told, seen } = await state(tab)
      expect({ fullscreen, told }).toEqual({ fullscreen: 'site', told: ['fill'] })
      expect(seen.filter((s) => s === 'site asked')).toHaveLength(1)
    },
    60_000,
  )

  test.skipIf(!here(type)).each(['host, while the player’s own fullscreen is left', 'player, while the player’s own fullscreen is left'] as const)(
    'the site is not made fullscreen for a player that has gone by the time the browser has left the player’s own fullscreen: the %s',
    async (ends) => {
      const tab = await pressed(ends)
      await nothingFullscreen(tab)
      expect(await state(tab)).toEqual({ fullscreen: 'nothing', on: false, told: [], seen: ['player', 'nothing'] })
    },
    60_000,
  )

  test.skipIf(!here(type))(
    'a fullscreen that the browser grants for a player once its page has gone is left again, and no player is laid in it',
    async () => {
      const tab = await pressed('host, once the site’s fullscreen is asked for')
      // The browser answers the request the site made for the player, which the site can no longer withdraw
      await tab.waitForFunction(() => (window as unknown as Site).seen.some((s) => s === 'granted' || s === 'refused'))
      await nothingFullscreen(tab)
      const { fullscreen, on, told, seen } = await state(tab)
      expect({ fullscreen, on, told }).toEqual({ fullscreen: 'nothing', on: false, told: [] })
      expect(seen.filter((s) => s === 'site asked')).toHaveLength(1)
    },
    60_000,
  )
})
