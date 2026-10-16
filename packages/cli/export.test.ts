import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { chromium, firefox } from 'playwright'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { doorKey, type ServiceConfig } from './src/serve/config'
import { type Arrival, type Door, type DoorParts, makeDoor, startDoor } from './src/serve/door'
import { bases } from './test-ports'

const ports = bases(18400, 10)
const config: ServiceConfig = { port: 0, network: false, instanceSecret: 'fixture', sessionSecret: 'fixture', adminKey: 'fixture' }
const content = { close: async () => {} } as DoorParts['content']
let door: Door
let backend: net.Server
const sockets = new Set<net.Socket>()
let origin: string
let upstream: string
let clock: number
let revoked: boolean
let slow: boolean
let stalled: boolean
let cancelled: boolean
let broken: boolean
let actionCalls: number
let tokens: number
let batches: number
const calls: string[] = []
const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
const until = async (condition: () => boolean) => {
  for (let n = 0; !condition(); n++) {
    if (n > 500) throw new Error('The expected event did not happen.')
    await pause()
  }
}
const arrival = (target: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown): Arrival => ({
  method,
  target,
  port: config.port,
  address: '127.0.0.1',
  headers: new Headers({ host: `127.0.0.1:${config.port}`, cookie: 'owner', ...headers }),
  body: body === undefined ? null : new Response(JSON.stringify(body)).body,
})
const prepare = (headers: Record<string, string> = {}, session = 'owner') =>
  door.answer(arrival('/session/export/start', 'POST', { origin, 'x-it-site': '1', ...headers }, { session }))
const link = async () => {
  const response = await prepare()
  expect(response.status).toBe(200)
  return (await response.json()).download as string
}

beforeEach(async () => {
  config.port = await ports.next()
  origin = `http://127.0.0.1:${config.port}`
  clock = Date.now()
  revoked = slow = stalled = cancelled = false
  actionCalls = tokens = 0
  batches = 3
  broken = false
  calls.length = 0
  // A raw TCP backend also observes disconnects under Bun, whose node:http compatibility
  // layer does not report the close of a request after its body has been consumed.
  backend = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let bytes = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      const end = bytes.indexOf('\r\n\r\n')
      if (end < 0) return
      const [first, ...lines] = bytes.subarray(0, end).toString().split('\r\n')
      const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]))
      if (bytes.length < end + 4 + Number(headers['content-length'] ?? 0)) return
      socket.removeAllListeners('data')
      const request = { url: first!.split(' ')[1], headers, socket }
      const body = JSON.parse(bytes.subarray(end + 4).toString() || '{}')
      let status = 200
      const answer = (value: unknown) => {
        const body = JSON.stringify(value)
        socket.end(`HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      }
      if (request.url === '/session/token') {
        expect(request.headers['x-it-door']).toBe(doorKey(config))
        expect(request.headers['x-it-site']).toBe('1')
        tokens++
        if (!request.headers.cookie || revoked) {
          status = 401
          return answer({ error: 'not paired' })
        }
        const id = request.headers.cookie.replace(/^it_test=/, '')
        return answer({ token: id, session: id, user: 'person', role: id === 'screen' ? 'screen' : 'owner' })
      }
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBe('Bearer owner')
      expect(body.format).toBe('json')
      const name = body.path as string
      calls.push(name)
      if (revoked) return answer({ status: 'error' })
      let value: unknown
      switch (name) {
        case 'account:exportStart':
          value = { owner: 'person', exportedAt: 1_800_000_000_000, displays: [{ name: 'Kitchen' }], pages: ['page'] }
          break
        case 'account:exportMachines':
          value = { machines: [{ name: 'Laptop', revoked: true }], next: null }
          break
        case 'account:exportPage':
          value = { slug: 'plan', state: '{"step":2}', versions: [] }
          break
        case 'account:exportActions': {
          actionCalls++
          if (slow) {
            stalled = true
            request.socket.on('close', () => {
              cancelled = true
            })
            return
          }
          const n = Number(body.args.cursor ?? 0)
          if (broken && n === 1) return answer({ status: 'error' })
          value = {
            actions: Array.from({ length: 100 }, (_, i) => ({ name: 'pick', payload: JSON.stringify({ n: n * 100 + i, text: 'x'.repeat(1024) }) })),
            next: n + 1 < batches ? String(n + 1) : null,
          }
          break
        }
        case 'account:exportNotifications':
          value = { notifications: [{ text: 'Done', answer: 'yes' }], next: null }
          break
      }
      answer({ status: 'success', value })
    })
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  upstream = `http://127.0.0.1:${(backend.address() as { port: number }).port}`
  door = makeDoor(config, { site: upstream, api: upstream } as never, () => {}, { content, now: () => clock })
})
afterEach(async () => {
  await door.close()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => backend.close(() => resolve()))
  await ports.release()
})

describe('streamed record downloads', () => {
  test('only the owner on the same origin can prepare a link, and a link still needs its original session', async () => {
    expect((await prepare({ origin: 'http://elsewhere.test' })).status).toBe(403)
    expect((await prepare({ 'x-it-site': '' })).status).toBe(403)
    expect((await prepare({ cookie: '' })).status).toBe(401)
    expect((await prepare({ cookie: 'screen' }, 'screen')).status).toBe(403)
    expect((await prepare({}, 'earlier-session')).status).toBe(409)
    const path = await link()
    expect((await door.answer(arrival(path, 'GET', { origin: 'http://elsewhere.test' }))).status).toBe(403)
    expect((await door.answer(arrival(path, 'GET', { 'sec-fetch-site': 'same-site' }))).status).toBe(403)
    expect((await door.answer(arrival(path, 'GET', { cookie: 'another' }))).status).toBe(403)
    expect((await door.answer(arrival(path))).status).toBe(404)
    const next = await link()
    expect((await door.answer(arrival(next, 'GET', { cookie: '', authorization: 'Bearer owner' }))).status).toBe(401)
  })

  test('an unused link expires and a session can hold only one export', async () => {
    const path = await link()
    expect((await prepare()).status).toBe(429)
    clock += 60_001
    expect((await door.answer(arrival(path))).status).toBe(404)
    expect((await prepare()).status).toBe(200)
  })

  test('the first bytes arrive before any history is read, no more than one batch is kept, and every record reaches valid JSON', async () => {
    const response = await door.answer(arrival(await link()))
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="it-export-2027-01-15.json"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const reader = response.body!.getReader()
    let text = new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('exportedAt')
    expect(actionCalls).toBe(0)
    for (let i = 0; i < 20; i++) text += new TextDecoder().decode((await reader.read()).value)
    expect(actionCalls).toBe(1)
    await pause()
    expect(actionCalls).toBe(1)
    // A download longer than a token's lifetime renews the original session without changing owners.
    clock += 300_000
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    const data = JSON.parse(text)
    expect(tokens).toBe(3)
    expect(data).toMatchObject({ displays: [{ name: 'Kitchen' }], machines: [{ name: 'Laptop', revoked: true }], complete: true })
    expect(data.pages[0].state).toEqual({ step: 2 })
    expect(data.pages[0].actions).toHaveLength(300)
    expect(data.pages[0].actions[299].payload.n).toBe(299)
    expect(data.notifications).toEqual([{ text: 'Done', answer: 'yes' }])
  })

  test('revocation or a failed batch breaks the response without a completion marker', async () => {
    const response = await door.answer(arrival(await link()))
    const reader = response.body!.getReader()
    const first = await reader.read()
    revoked = true
    // Await the socket-driven rejection before asserting. Bun's promise matchers can
    // re-enter its socket event loop and crash on macOS and Windows.
    const error = await reader.read().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ status: 409 })
    expect(new TextDecoder().decode(first.value)).not.toContain('"complete"')
  })

  test('cancelling a download aborts a pending backend read and releases its slot', async () => {
    const response = await door.answer(arrival(await link()))
    const reader = response.body!.getReader()
    slow = true
    const drain = (async () => {
      while (!(await reader.read()).done) {}
    })()
    await until(() => stalled)
    await reader.cancel()
    await drain
    await until(() => cancelled)
    slow = false
    expect((await prepare()).status).toBe(200)
  })

  for (const browserType of [chromium, firefox]) {
    test.skipIf(!existsSync(browserType.executablePath()))(
      `${browserType.name()} downloads over HTTP before the last batch, cancels a stalled read, and never completes a broken stream`,
      async () => {
        const running = await startDoor(config, { site: upstream, api: upstream } as never, () => {}, {
          content,
          site: { 'index.html': { type: 'text/html', bytes: Buffer.from('<!doctype html><title>Download test</title>').toString('base64') } },
        })
        const browser = await browserType.launch({ headless: true })
        try {
          const context = await browser.newContext({ acceptDownloads: true })
          await context.addCookies([{ name: 'it_test', value: 'owner', url: origin }])
          const page = await context.newPage()
          await page.goto(origin)
          slow = true
          const begin = async () => {
            const download = page.waitForEvent('download')
            await page.evaluate(async () => {
              const response = await fetch('/session/export/start', {
                method: 'POST',
                headers: { 'x-it-site': '1' },
                body: JSON.stringify({ session: 'owner' }),
              })
              const { download } = await response.json()
              const link = Object.assign(document.createElement('a'), { href: download, download: '' })
              document.body.append(link)
              link.click()
            })
            return download
          }
          const file = await begin()
          await until(() => stalled)
          expect(file.suggestedFilename()).toMatch(/^it-export-\d{4}-\d{2}-\d{2}\.json$/)
          expect(calls).not.toContain('account:exportNotifications')
          await file.cancel()
          expect(await file.failure()).not.toBeNull()
          await until(() => cancelled)
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect(actionCalls).toBe(1)
          slow = false
          const complete = await begin()
          expect(await complete.failure()).toBeNull()
          const data = JSON.parse(readFileSync((await complete.path())!, 'utf8'))
          expect(data.complete).toBe(true)
          expect(data.pages[0].actions).toHaveLength(300)
          broken = true
          const failed = await begin()
          // Gecko's automation driver may leave an interrupted download pending. Neither
          // a pending download nor a failed one may be reported as a successfully saved file.
          const outcome =
            browserType === chromium
              ? await failed.failure()
              : await Promise.race([failed.failure(), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000))])
          expect(outcome).not.toBeNull()
          if (outcome === 'pending') await failed.cancel()
        } finally {
          await browser.close()
          await running.stop()
        }
      },
      30_000,
    )
  }
})
