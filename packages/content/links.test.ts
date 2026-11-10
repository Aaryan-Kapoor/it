// What the script It puts in every page does to the links and forms a page follows, in Chromium
// and in Firefox themselves: which window a target finds, and whether a window keeps a hold on the
// page that opened it, are the browser's own to decide, which no stand-in for one does. The page is
// shown here as a document of its own, and another server stands in for another site.
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type BrowserType, chromium, firefox, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { RUNTIME } from './src/runtime.generated'

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
  if (!here(type)) console.log(`  skip  where ${name} follows a page's links: ${why}`)
}

/** A page with It in it, and whatever the test puts in its body. */
const page = (body: string) => `<!doctype html><html><head>
<script>window.__IT__ = { app: location.origin, id: 'links', version: 1, keep: '/keep' }</script>
<script src="/runtime.js"></script>
</head><body>${body}</body></html>`

const serve = (answer: (url: string) => string) =>
  new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/runtime.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(RUNTIME)
      if (req.url === '/keep') return res.writeHead(204).end()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(answer(req.url ?? '/'))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })

describe.each(BROWSERS)('a link or a form a page follows, in %s', (_name, type) => {
  let browser: Browser
  const servers: http.Server[] = []
  let home = ''
  let away = ''
  const pages = new Map<string, string>()
  beforeAll(async () => {
    if (!here(type)) return
    const it = await serve((url) => pages.get(url) ?? page(''))
    const other = await serve(() => '<!doctype html><p>another site</p>')
    servers.push(it.server, other.server)
    home = it.origin
    // Another site, at another port: another origin
    away = other.origin
    browser = await type.launch({ timeout: 0 })
  }, 300_000)
  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }, 120_000)

  /** Opens a page with this body, clicks `#go` as a person would, and says whether the window that opened has a hold on the page. */
  async function opened(body: string): Promise<{ opener: boolean; url: string }> {
    const path = `/${pages.size}.html`
    pages.set(path, page(body.replaceAll('AWAY', away)))
    const context = await browser.newContext()
    try {
      const tab: Page = await context.newPage()
      await tab.goto(home + path)
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15_000 }), tab.click('#go')])
      await popup.waitForLoadState()
      return { opener: await popup.evaluate(() => window.opener !== null), url: popup.url() }
    } finally {
      await context.close()
    }
  }

  test.skipIf(!here(type))('a target with spaces around a frame’s name finds no frame, and opens a tab of its own with no hold on the page', async () => {
    const said = await opened('<iframe name="inside"></iframe><a id="go" href="AWAY/a" target=" inside ">out</a>')
    expect(said).toEqual({ opener: false, url: `${away}/a` })
  })

  test.skipIf(!here(type))('a form whose submit handler aims it at a window and asks for a hold, sent by script from a click, opens with no hold', async () => {
    const said = await opened(
      `<form id="form" action="AWAY/f"></form><button id="go" type="button">go</button>
       <script>
         const form = document.getElementById('form')
         form.addEventListener('submit', (e) => {
           form.target = 'fresh'
           form.setAttribute('rel', 'opener')
           e.stopPropagation()
         })
         document.getElementById('go').addEventListener('click', () => form.requestSubmit())
       </script>`,
    )
    expect(said).toEqual({ opener: false, url: `${away}/f?` })
  })

  test.skipIf(!here(type))('a form with no target of its own goes to the page’s `<base target>` with no hold on the page', async () => {
    const said = await opened(`<base target="fresh"><form action="AWAY/b"><button id="go">go</button></form>`)
    expect(said).toEqual({ opener: false, url: `${away}/b?` })
  })

  test.skipIf(!here(type))(
    'a link in a closed shadow root that its own handler sends to another site, with a hold, and stops there, opens with no hold',
    async () => {
      const said = await opened(
        `<div id="host"></div><button id="go" type="button">go</button>
       <script>
         const root = document.getElementById('host').attachShadow({ mode: 'closed' })
         root.innerHTML = '<a id="inner" href="#here">here</a>'
         const link = root.getElementById('inner')
         link.addEventListener('click', (e) => {
           link.href = 'AWAY/s'
           link.target = 'fresh'
           link.rel = 'opener'
           e.stopPropagation()
         })
         document.getElementById('go').addEventListener('click', () => link.click())
       </script>`,
      )
      expect(said).toEqual({ opener: false, url: `${away}/s` })
    },
  )

  test.skipIf(!here(type))(
    'a `<base target>` a link’s own handler puts in, before the link is clicked by script, gives the window it opens no hold on the page',
    async () => {
      const said = await opened(
        `<a id="inner" href="/file.html">a file of the page’s</a><button id="go" type="button">go</button>
       <script>
         const link = document.getElementById('inner')
         link.addEventListener('click', (e) => {
           document.head.insertAdjacentHTML('beforeend', '<base target="fresh">')
           e.stopPropagation()
         })
         document.getElementById('go').addEventListener('click', () => link.click())
       </script>`,
      )
      expect(said).toEqual({ opener: false, url: `${home}/file.html` })
    },
  )

  test.skipIf(!here(type))('a form sent by a button that names a window, whose formdata handler asks for a hold, opens with no hold', async () => {
    const said = await opened(
      `<form id="form" target="_self" action="AWAY/d"><button id="go" formtarget="fresh">send</button></form>
       <script>
         const form = document.getElementById('form')
         form.onformdata = () => {
           form.rel = 'opener'
         }
       </script>`,
    )
    expect(said).toEqual({ opener: false, url: `${away}/d?` })
  })

  test.skipIf(!here(type))('a form written into a closed shadow root and sent at once, aimed at a window with a hold, opens with no hold', async () => {
    const said = await opened(
      `<div id="host"></div><button id="go" type="button">go</button>
       <script>
         document.getElementById('go').addEventListener('click', () => {
           const root = document.getElementById('host').attachShadow({ mode: 'closed' })
           root.innerHTML = '<form action="AWAY/r" target="fresh" rel="opener"></form>'
           root.querySelector('form').requestSubmit()
         })
       </script>`,
    )
    expect(said).toEqual({ opener: false, url: `${away}/r?` })
  })

  test.skipIf(!here(type))(
    'a link given a hold by an attribute name that only turns into `rel` when the browser makes it a string opens with no hold',
    async () => {
      const said = await opened(
        `<a id="inner" href="/named.html" target="fresh">a file of the page’s</a><button id="go" type="button">go</button>
       <script>
         const link = document.getElementById('inner')
         link.addEventListener('click', (e) => {
           link.setAttribute({ toString: () => 'rel' }, 'opener')
           e.stopPropagation()
         })
         document.getElementById('go').addEventListener('click', () => link.click())
       </script>`,
      )
      expect(said).toEqual({ opener: false, url: `${home}/named.html` })
    },
  )
})
