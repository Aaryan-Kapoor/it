// What the script It puts in every page makes of a photo the page sends, in Chromium and in
// Firefox themselves: decoding and drawing a picture is the browser's own work, which no
// stand-in for one does. The page is shown here as a document of its own, and the test stands
// in for the site at the other end of its channel.
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type BrowserType, chromium, firefox } from 'playwright'
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
  if (!here(type)) console.log(`  skip  what ${name} makes of a photo a page sends: ${why}`)
}

/** A page with It in it, whose channel to the site is the test's: what It sends up is kept in `heard`, and every action is accepted. */
const PAGE = `<!doctype html><html><head>
<script>window.__IT__ = { app: location.origin, id: 'receipts', version: 1, keep: '/keep' }</script>
<script src="/runtime.js"></script>
<script>
  window.heard = []
  const channel = new MessageChannel()
  channel.port1.onmessage = (m) => {
    window.heard.push(m.data)
    if (m.data.type === 'it:action') channel.port1.postMessage({ type: 'it:result', requestId: m.data.requestId, ok: true, actionId: 'a' + window.heard.length })
  }
  window.postMessage({ type: 'it:port' }, location.origin, [channel.port2])
</script></head><body></body></html>`

describe.each(BROWSERS)('a photo a page sends, as %s makes it', (_name, type) => {
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
  }, 300_000)
  afterAll(async () => {
    await browser?.close()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test.skipIf(!here(type))(
    'is made smaller to 1600 pixels as a JPEG, beside a file of another kind that goes as it is; and goes as it is where the page asks for that, or where it is small already',
    async () => {
      const tab = await browser.newPage()
      await tab.goto(origin)
      const said = await tab.evaluate(async () => {
        const It = (window as unknown as { It: { action: (name: string, data: unknown, sending?: unknown) => Promise<unknown> } }).It
        const heard = (window as unknown as { heard: { type: string; envelope: { payload: Record<string, File> } }[] }).heard
        /** A picture of so many pixels with grain in it, as a camera's is, made by the browser. */
        const made = async (width: number, height: number, kind: string, quality?: number) => {
          const c = document.createElement('canvas')
          c.width = width
          c.height = height
          const g = c.getContext('2d')!
          const grain = g.createImageData(width, height)
          for (let i = 0; i < grain.data.length; i += 4) {
            const n = 90 + ((i * 2654435761) >>> 24) / 4
            grain.data.set([n, n * 0.9, n * 0.8, 255], i)
          }
          g.putImageData(grain, 0, 0)
          return new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), kind, quality))
        }
        const camera = new File([await made(4032, 3024, 'image/jpeg', 0.92)], 'IMG_0001.JPG', { type: 'image/jpeg' })
        const small = new File([await made(800, 600, 'image/png')], 'sketch.png', { type: 'image/png' })
        const scan = new File([new Uint8Array(5000).fill(7)], 'scan.pdf', { type: 'application/pdf' })
        await It.action('receipt', { photo: camera, scan, small })
        await It.action('original', { photo: camera }, { original: true })
        const [shrunk, original] = heard.filter((m) => m.type === 'it:action').map((m) => m.envelope.payload)
        const picture = await createImageBitmap(shrunk!.photo!)
        return {
          camera: camera.size,
          photo: {
            name: shrunk!.photo!.name,
            type: shrunk!.photo!.type,
            smaller: shrunk!.photo!.size < camera.size,
            width: picture.width,
            height: picture.height,
          },
          scan: { name: shrunk!.scan!.name, type: shrunk!.scan!.type, size: shrunk!.scan!.size },
          small: { name: shrunk!.small!.name, type: shrunk!.small!.type, same: shrunk!.small!.size === small.size },
          original: { name: original!.photo!.name, size: original!.photo!.size },
        }
      })
      expect(said.photo).toEqual({ name: 'IMG_0001.jpg', type: 'image/jpeg', smaller: true, width: 1600, height: 1200 })
      expect(said.scan).toEqual({ name: 'scan.pdf', type: 'application/pdf', size: 5000 })
      expect(said.small).toEqual({ name: 'sketch.png', type: 'image/png', same: true })
      expect(said.original).toEqual({ name: 'IMG_0001.JPG', size: said.camera })
      expect(said.camera).toBeGreaterThan(1024 * 1024)
    },
    120_000,
  )
})
