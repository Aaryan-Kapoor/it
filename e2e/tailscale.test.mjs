// The stand-in for Tailscale's own server (e2e/tailscale.mjs): what it hands the door is what
// Tailscale hands it, whatever the caller said of itself, and a connection the door takes over
// is joined through it.
import http from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { askThrough, standInTailscale, TAILNET_CALLER } from './tailscale.mjs'

const started = []
afterEach(async () => {
  for (const stop of started.splice(0)) await stop()
})
/** A stand-in door on a port of its own, which keeps what it was asked and answers as `answer` does, and the stand-in in front of it. */
async function inFrontOf(answer = (_req, res) => res.end('the site'), upgrade) {
  const asked = []
  const door = http.createServer((req, res) => {
    asked.push({ method: req.method, target: req.url, headers: req.headers })
    answer(req, res)
  })
  if (upgrade)
    door.on('upgrade', (req, socket) => {
      asked.push({ method: req.method, target: req.url, headers: req.headers })
      upgrade(req, socket)
    })
  await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve))
  started.push(() => {
    door.closeAllConnections()
    return new Promise((resolve) => door.close(resolve))
  })
  const front = await standInTailscale({ door: door.address().port })
  started.push(front.stop)
  return { asked, front, port: door.address().port }
}
const HOST = 'laptop.tail-e2e.ts.net:4702'

describe('the stand-in for Tailscale’s own server', () => {
  test('hands a request on at the path it was asked for, with the Host it was sent to, as one that came over https from the tailnet', async () => {
    const { asked, front } = await inFrontOf()
    const got = await askThrough(front.port, HOST, '/p/plan?x=1')
    expect(got).toMatchObject({ status: 200, body: 'the site' })
    expect(asked).toHaveLength(1)
    expect(asked[0].target).toBe('/p/plan?x=1')
    expect(asked[0].headers).toMatchObject({ host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': TAILNET_CALLER, 'x-forwarded-host': HOST })
  })

  test('writes those headers itself, whatever the caller sent in them', async () => {
    const { asked, front } = await inFrontOf()
    await askThrough(front.port, HOST, '/', {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-host': 'elsewhere.example',
      cookie: 'kept=1',
    })
    expect(asked[0].headers).toMatchObject({ 'x-forwarded-proto': 'https', 'x-forwarded-for': TAILNET_CALLER, 'x-forwarded-host': HOST, cookie: 'kept=1' })
  })

  test('gives back the door’s own answer, a refusal as well', async () => {
    const { front } = await inFrontOf((_req, res) => res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad_request"}'))
    expect(await askThrough(front.port, HOST, '/')).toEqual({ status: 400, type: 'application/json', body: '{"error":"bad_request"}' })
  })

  const UPGRADE = { connection: 'Upgrade', upgrade: 'websocket', origin: `https://${HOST}` }
  test('joins a connection the door takes over, and hands the asking on as it does any other', async () => {
    const { asked, front } = await inFrontOf(undefined, (_req, socket) =>
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'),
    )
    expect((await askThrough(front.port, HOST, '/api/1.0.0/sync', UPGRADE)).status).toBe(101)
    expect(asked[0].target).toBe('/api/1.0.0/sync')
    expect(asked[0].headers).toMatchObject({
      host: HOST,
      origin: `https://${HOST}`,
      upgrade: 'websocket',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': TAILNET_CALLER,
    })
  })

  test('and gives back the door’s refusal of one it does not take over', async () => {
    const { front } = await inFrontOf(undefined, (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
    expect((await askThrough(front.port, HOST, '/api/1.0.0/sync', UPGRADE)).status).toBe(403)
  })

  test('answers 502 where there is no door to hand anything to', async () => {
    // A port that was listened on a moment ago, and is not now
    const closed = http.createServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address()
    await new Promise((resolve) => closed.close(resolve))
    const front = await standInTailscale({ door: port })
    started.push(front.stop)
    expect((await askThrough(front.port, HOST, '/')).status).toBe(502)
  })
})
