// The door itself, opened on ports of its own, with stand-ins for the backend's two ports, for
// the content package, for the site's files and for notifications. Every request is written
// out byte for byte and sent over this machine's own network, so that what the door is sent is
// exactly what the test says, the Host header included.
//
// Nothing here depends on which runtime runs it. Under vitest it is the door as Node listens;
// `bun test packages/cli/door.test.ts` runs the same tests on the door as it listens inside the
// standalone program.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIENCE, contentPort, LIMITS, SANDBOX } from '@it/protocol'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Problem } from './src/lib'
import { doorKey } from './src/serve/config'
import { type Arrival, type DoorParts, makeContent, makeDoor, startDoor } from './src/serve/door'
import { answerSite, type Site } from './src/serve/site'

type ServiceConfig = Parameters<typeof startDoor>[0]
type Backend = Parameters<typeof startDoor>[1]
type Content = NonNullable<DoorParts['content']>

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('what the test waited for did not happen')
    await pause(10)
  }
}

// ---------- a client that sends exactly what it is told ----------

interface Ask {
  method?: string
  path?: string
  /** The Host header. Left out, it is the address the request is sent to; null sends none. */
  host?: string | null
  headers?: [string, string][]
  body?: string | Buffer
  /** Sends the body in pieces that do not say how long the whole is. */
  chunked?: boolean
  /** Says a length, whatever is sent. */
  length?: number
  /** The address to connect to. */
  to?: string
  /** Asks for the connection to become something else, as a WebSocket's first request does. */
  upgrade?: boolean
}
interface Answer {
  status: number
  headers: Record<string, string>
  cookies: string[]
  body: string
}
/** An answer as it was sent, or null while it has not all arrived. `ended` says the connection closed, which ends an answer that does not say how long it is. */
function read(all: Buffer, bodiless: boolean, ended: boolean): Answer | null {
  const cut = all.indexOf('\r\n\r\n')
  if (cut < 0) return null
  const [first = '', ...lines] = all.subarray(0, cut).toString('latin1').split('\r\n')
  const status = Number(first.split(' ')[1])
  const headers: Record<string, string> = {}
  const cookies: string[] = []
  for (const line of lines) {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon).trim().toLowerCase()
    if (name === 'set-cookie') cookies.push(line.slice(colon + 1).trim())
    else headers[name] = line.slice(colon + 1).trim()
  }
  let rest = all.subarray(cut + 4)
  const answer = (body: Buffer): Answer => ({ status, headers, cookies, body: body.toString('utf8') })
  if (bodiless || status === 204 || status === 304) return answer(Buffer.alloc(0))
  if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
    const pieces: Buffer[] = []
    for (;;) {
      const end = rest.indexOf('\r\n')
      if (end < 0) return ended ? answer(Buffer.concat(pieces)) : null
      const size = Number.parseInt(rest.subarray(0, end).toString('latin1'), 16)
      if (!size) return answer(Buffer.concat(pieces))
      if (rest.length < end + 2 + size + 2) return ended ? answer(Buffer.concat(pieces)) : null
      pieces.push(rest.subarray(end + 2, end + 2 + size))
      rest = rest.subarray(end + 2 + size + 2)
    }
  }
  if (headers['content-length'] !== undefined)
    return rest.length >= Number(headers['content-length']) || ended ? answer(rest.subarray(0, Number(headers['content-length']))) : null
  return ended ? answer(rest) : null
}
function ask(port: number, o: Ask = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, o.to ?? '127.0.0.1')
    const lines = [`${o.method ?? 'GET'} ${o.path ?? '/'} HTTP/1.1`]
    if (o.host !== null) lines.push(`Host: ${o.host ?? `127.0.0.1:${port}`}`)
    for (const [name, value] of o.headers ?? []) lines.push(`${name}: ${value}`)
    const body = o.body === undefined ? null : Buffer.from(o.body)
    if (o.length !== undefined) lines.push(`Content-Length: ${o.length}`)
    else if (body && o.chunked) lines.push('Transfer-Encoding: chunked')
    else if (body) lines.push(`Content-Length: ${body.length}`)
    lines.push(o.upgrade ? 'Connection: Upgrade' : 'Connection: close')
    let got = Buffer.alloc(0)
    // The answer is taken as soon as it has all arrived, whether or not the connection is then closed
    const look = (ended: boolean) => {
      const answer = read(got, o.method === 'HEAD', ended)
      if (answer) {
        resolve(answer)
        socket.destroy()
      } else if (ended) reject(new Error('the door closed the connection without an answer'))
    }
    socket.on('connect', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (body) socket.write(o.chunked ? Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]) : body)
    })
    socket.on('data', (piece: Buffer) => {
      got = Buffer.concat([got, piece])
      look(false)
    })
    socket.on('error', (err) => (got.length ? look(true) : reject(err)))
    socket.on('close', () => look(true))
    socket.setTimeout(15_000, () => socket.destroy(new Error('the door did not answer')))
  })
}

// ---------- stand-ins ----------

/**
 * What the backend sets when a session begins or ends: the cookie of the session, under a name
 * of its own, and a line for each cookie of a session that is over, to clear it. A date in one
 * of them has a comma in it, as dates in cookies do.
 */
const SET = [
  'it_session_k17a=s3cret; HttpOnly; SameSite=Strict; Path=/session; Max-Age=31536000',
  ...['k17b', 'k17c', 'k17d', 'k17e'].map((id) => `it_session_${id}=; HttpOnly; SameSite=Strict; Path=/session; Expires=Thu, 01 Jan 1970 00:00:00 GMT`),
]

/** The backend's HTTP port: it writes down what it was asked, and answers as the test needs. */
const site = {
  asked: [] as { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[],
  // The backend takes headers far longer than a browser sends
  server: http.createServer({ maxHeaderSize: 256 * 1024 }, (req, res) => {
    const pieces: Buffer[] = []
    req.on('data', (piece: Buffer) => pieces.push(piece))
    req.on('end', () => {
      site.asked.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(pieces).toString('utf8') })
      const sent = site.asked.at(-1)!.body
      if (['/session/redeem', '/session/code', '/bridge/enroll'].includes(req.url ?? '') && sent.includes('"wrong')) {
        // A code that is wrong, used or run out
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"That code is wrong, used or expired. Ask for a new one."}')
      } else if (req.url === '/session/code') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"role":"owner"}')
      } else if (req.url === '/session/redeem' || req.url === '/session/end') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': SET })
        res.end('{"ok":true}')
      } else if (req.url === '/session/token') {
        // A session that is over: its cookie is cleared with the refusal
        res.writeHead(401, { 'content-type': 'application/json', 'set-cookie': SET.slice(1) })
        res.end('{"error":"no session"}')
      } else if (req.url === '/bridge/moved') {
        // Sent elsewhere, to an address that would answer if anyone went there
        res.writeHead(302, { location: `http://${req.headers.host}/health`, 'content-type': 'text/plain' })
        res.end('moved')
      } else if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'POST' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ backend: req.url }))
      }
    })
  }),
}

/**
 * The backend's port for function calls. Asked for a WebSocket, it agrees, greets, and says
 * back what it is told. Sent a call, it keeps what arrived and answers as the backend does:
 * with a word to whichever origin asked that it may read the answer, which the door must not
 * pass on.
 */
const api = {
  /** What each connection first sent, whatever it was. */
  heads: [] as string[],
  /** Every call that arrived: where it was sent, each header by its name, and its body. */
  calls: [] as { path: string; headers: Record<string, string>; body: string }[],
  /** The code each connection was closed with from the other end. */
  closes: [] as number[],
  sockets: new Set<net.Socket>(),
  server: net.createServer((socket) => {
    api.sockets.add(socket)
    socket.on('close', () => api.sockets.delete(socket))
    socket.on('error', () => {})
    const frame = (body: Buffer, op = 1) =>
      Buffer.concat([
        body.length < 126
          ? Buffer.from([0x80 | op, body.length])
          : body.length < 65536
            ? Buffer.from([0x80 | op, 126, body.length >> 8, body.length & 255])
            : Buffer.from([0x80 | op, 127, 0, 0, 0, 0, 0, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]),
        body,
      ])
    let held = Buffer.alloc(0)
    let open = false
    socket.on('data', (piece: Buffer) => {
      held = Buffer.concat([held, piece])
      // Calls, one after another on the one connection
      while (!open && held.subarray(0, 5).toString('latin1') === 'POST ') {
        const end = held.indexOf('\r\n\r\n')
        if (end < 0) return
        const [first = '', ...lines] = held.subarray(0, end).toString('latin1').split('\r\n')
        const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]))
        const length = Number(headers['content-length'] ?? 0)
        if (held.length < end + 4 + length) return
        const body = held.subarray(end + 4, end + 4 + length).toString('utf8')
        held = held.subarray(end + 4 + length)
        const called = first.split(' ')[1] ?? ''
        api.calls.push({ path: called, headers, body })
        // A function that refuses is answered with a status of the backend's own
        const refuses = body.includes('"refuses"')
        // And one that is sent elsewhere, to an address that would answer if anyone went there
        const moved = body.includes('"moved"')
        const answer = JSON.stringify(refuses ? { status: 'error', errorMessage: 'refused' } : moved ? { moved: true } : { status: 'success', value: called })
        socket.write(
          [
            `HTTP/1.1 ${refuses ? '560 Function Failed' : moved ? '307 Temporary Redirect' : '200 OK'}`,
            ...(moved ? [`location: ${backend.site}/health`] : []),
            'content-type: application/json',
            `access-control-allow-origin: ${headers.origin ?? '*'}`,
            'access-control-allow-credentials: true',
            'vary: origin, access-control-request-method, access-control-request-headers',
            'set-cookie: from=backend',
            `content-length: ${Buffer.byteLength(answer)}`,
            '',
            answer,
          ].join('\r\n'),
        )
      }
      if (!open) {
        const end = held.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = held.subarray(0, end).toString('latin1')
        held = held.subarray(end + 4)
        api.heads.push(head)
        const key = /^sec-websocket-key: *(\S+)/im.exec(head)?.[1]
        if (!key) return void socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        open = true
        socket.write(frame(Buffer.from('hello from the backend')))
      }
      for (;;) {
        if (held.length < 2) return
        const short = held[1]! & 127
        const at = short === 126 ? 4 : short === 127 ? 10 : 2
        if (held.length < at) return
        const length = short === 126 ? held.readUInt16BE(2) : short === 127 ? held.readUInt32BE(6) : short
        if (held.length < at + 4 + length) return
        const mask = held.subarray(at, at + 4)
        const body = Buffer.from(held.subarray(at + 4, at + 4 + length))
        for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!
        const op = held[0]! & 15
        held = held.subarray(at + 4 + length)
        if (op === 8) {
          if (body.length >= 2) api.closes.push(body.readUInt16BE(0))
          return void socket.end(frame(body.subarray(0, 2), 8))
        }
        // Told "close 4321 done", it closes the connection with that code and that reason
        const close = op === 1 ? /^close (\d+) (.*)$/.exec(body.toString()) : null
        if (close) {
          const said = Buffer.alloc(2 + Buffer.byteLength(close[2]!))
          said.writeUInt16BE(Number(close[1]), 0)
          said.write(close[2]!, 2)
          socket.write(frame(said, 8))
        } else if (op === 1) socket.write(frame(Buffer.from(`back: ${body.toString()}`)))
      }
    })
  }),
}

/** The content package: it says back which of its three it was asked for, on which port, by whom, and what arrived. */
const content = {
  asked: [] as { which: string; port: number; address: string; method: string; path: string }[],
  closed: 0,
  /** How many answers were let go of, part of the way through, by whoever was reading them. */
  letGo: 0,
  /** How many of the large answers were read to their end. */
  readOut: 0,
  /** How many answers are waiting for a piece that never comes, and how many pieces such answers gave after their first. */
  stalled: 0,
  later: 0,
  as(which: 'showing' | 'upload' | 'control') {
    return async (request: Request, asked: { port: number; address: string }) => {
      const url = new URL(request.url)
      // A file as large as a file may be, read a piece at a time as a file is
      if (url.pathname === '/large') {
        let pieces = 400
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await pause(1)
              if (pieces-- > 0) return controller.enqueue(new Uint8Array(64 * 1024))
              content.readOut += 1
              controller.close()
            },
            cancel: () => {
              content.letGo += 1
            },
          }),
          { headers: { 'content-type': 'video/mp4' } },
        )
      }
      // A file whose first piece comes and whose next never does, as from a disk that has stopped answering
      if (url.pathname === '/stalled') {
        let pieces = 0
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pieces++ === 0) return controller.enqueue(new Uint8Array(64 * 1024))
              if (pieces > 2) content.later += 1
              content.stalled += 1
              return new Promise<void>(() => {})
            },
            cancel: () => {
              content.letGo += 1
            },
          }),
          { headers: { 'content-type': 'video/mp4' } },
        )
      }
      const body = Buffer.from(await request.arrayBuffer())
      // Every header as it arrived, each under its name
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => {
        headers[name] = value
      })
      const seen = { which, port: asked.port, address: asked.address, method: request.method, path: url.pathname + url.search }
      content.asked.push(seen)
      return new Response(
        JSON.stringify({
          ...seen,
          host: url.host,
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          cookie: request.headers.get('cookie'),
          headers,
        }),
        {
          status: which === 'showing' ? 200 : 201,
          headers: { 'content-type': 'application/json', 'x-from': 'content' },
        },
      )
    }
  },
}
const contentStandIn: Content = {
  showing: content.as('showing'),
  upload: content.as('upload'),
  control: content.as('control'),
  close: async () => {
    content.closed += 1
  },
}

const file = (type: string, text: string) => ({ type, bytes: Buffer.from(text).toString('base64') })
const siteStandIn: Site = {
  'index.html': file('text/html; charset=utf-8', '<!doctype html><title>It</title>'),
  'assets/app-1a2b3c4d.js': file('text/javascript; charset=utf-8', 'console.log("the site")'),
  'sw.js': file('text/javascript; charset=utf-8', '// the service worker'),
  'icon.svg': file('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  'LICENSE.md': file('text/plain; charset=utf-8', 'The terms.'),
}

const pushStandIn = {
  asked: [] as { method: string; path: string; address: string; body: string }[],
  async answer(request: Request, asked: { address: string }) {
    pushStandIn.asked.push({ method: request.method, path: new URL(request.url).pathname, address: asked.address, body: await request.text() })
    return new Response('{"status":201}', { headers: { 'content-type': 'application/json' } })
  },
}

/** One whole frame of a WebSocket, of the kind given. A caller's frames are masked, here with a mask that changes nothing. */
function framed(body: Buffer, op: number, masked = false): Buffer {
  const length = Buffer.alloc(body.length < 126 ? 1 : body.length < 65536 ? 3 : 9)
  if (length.length === 1) length[0] = body.length
  else if (length.length === 3) length.writeUInt16BE(body.length, 1)
  else length.writeBigUInt64BE(BigInt(body.length), 1)
  if (length.length > 1) length[0] = length.length === 3 ? 126 : 127
  if (masked) length[0] = length[0]! | 0x80
  return Buffer.concat([Buffer.from([0x80 | op]), length, masked ? Buffer.alloc(4) : Buffer.alloc(0), body])
}
/**
 * The whole frames at the front of what has arrived on a WebSocket, what is left after them,
 * and how long what is left has to become before there is another whole frame, as far as it
 * says. Only what a short frame says is unmasked.
 */
function unframed(held: Buffer): { frames: { op: number; body: Buffer }[]; rest: Buffer; need: number } {
  const frames: { op: number; body: Buffer }[] = []
  let need = 2
  for (;;) {
    if (held.length < 2) break
    const short = held[1]! & 127
    const at = short === 126 ? 4 : short === 127 ? 10 : 2
    need = at
    if (held.length < at) break
    const length = short === 126 ? held.readUInt16BE(2) : short === 127 ? Number(held.readBigUInt64BE(2)) : short
    const start = at + (held[1]! & 128 ? 4 : 0)
    need = start + length
    if (held.length < need) break
    const body = Buffer.from(held.subarray(start, start + length))
    if (start > at && length < 126) for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ held[at + (i % 4)]!
    frames.push({ op: held[0]! & 15, body })
    held = held.subarray(start + length)
    need = 2
  }
  return { frames, rest: held, need }
}

/** How a backend of the test's own answers a WebSocket's first request. */
type Does = 'agrees' | 'agrees and takes nothing' | 'agrees to another key' | 'refuses' | 'never finishes' | 'says nothing'
/**
 * The backend's port for function calls, for one test alone. It keeps everything each
 * connection sent it before it agreed to a WebSocket, byte for byte. When it refuses it goes on
 * as the backend does: the connection stays open, and whatever request follows on it is
 * answered. When it agrees it answers a ping as a WebSocket must, and counts what it is sent.
 */
async function backendThat(does: Does) {
  const heard: Buffer[] = []
  const sockets = new Set<net.Socket>()
  const state = { took: 0, answered: -1, taking: does !== 'agrees and takes nothing', ended: 0 }
  const server = net.createServer((socket) => {
    const mine = heard.push(Buffer.alloc(0)) - 1
    sockets.add(socket)
    // A connection has ended when its other end is found closed, however that is told: as an
    // end, as an error or as the connection's own closing, whichever a runtime and a system say first
    let over = false
    const ended = () => {
      if (over) return
      over = true
      state.ended += 1
    }
    socket.on('error', ended)
    socket.on('end', ended)
    socket.on('close', () => {
      sockets.delete(socket)
      ended()
    })
    let agreed = false
    let answers = 0
    // What has arrived of a frame that is not whole yet, put together only once all of it is here
    let rest: Buffer[] = []
    let [have, need] = [0, 2]
    socket.on('data', (piece: Buffer) => {
      if (agreed) {
        rest.push(piece)
        have += piece.length
        if (have < need) return
        const taken = unframed(Buffer.concat(rest))
        rest = [taken.rest]
        ;[have, need] = [taken.rest.length, taken.need]
        for (const { op, body } of taken.frames) {
          if (op === 9) {
            // Answered once everything sent before it has been read, as a WebSocket must
            state.answered = state.took
            socket.write(framed(body, 10))
          } else if (op === 8) socket.end(framed(body.subarray(0, 2), 8))
          else if (op < 8) state.took += body.length
        }
        return
      }
      heard[mine] = Buffer.concat([heard[mine]!, piece])
      const head = heard[mine]!.toString('latin1')
      if (!head.includes('\r\n\r\n') || does === 'says nothing') return
      if (does === 'refuses') {
        // Once for each request that has all arrived
        for (; answers < head.split('\r\n\r\n').length - 1; answers++)
          socket.write(
            answers
              ? 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'
              : 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 24\r\n\r\n{"code":"NotAHandshake"}',
          )
        return
      }
      if (does === 'never finishes') {
        if (answers++) return
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n')
        const more = setInterval(() => (socket.destroyed ? clearInterval(more) : socket.write(`X-More: ${'a'.repeat(4000)}\r\n`)), 5)
        return
      }
      const key = does === 'agrees to another key' ? 'YW5vdGhlciBrZXkgZW50aXJlbHk=' : (/^sec-websocket-key: *(\S+)/im.exec(head)?.[1] ?? '')
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      // What the backend says of its own beside its agreement is no part of what the caller is told
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\nset-cookie: from=backend\r\naccess-control-allow-credentials: true\r\n\r\n`,
      )
      agreed = true
      if (!state.taking) socket.pause()
      else socket.write(framed(Buffer.from('hello from the backend'), 1))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    behind: { ...backend, api: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` },
    /** What each connection sent before a WebSocket was agreed to on it. */
    heard: () => heard.map((bytes) => bytes.toString('latin1')),
    /** How many bytes of messages have been taken off the WebSockets, and how many connections have ended. */
    took: () => state.took,
    ended: () => state.ended,
    /** How many bytes of messages it had taken when it last answered a ping, or -1 when it has answered none. */
    answered: () => state.answered,
    /** Says something of its own on every WebSocket it has. */
    say(text: string) {
      for (const socket of sockets) socket.write(framed(Buffer.from(text), 1))
    },
    /** Begins to take what it is sent, having taken nothing so far. It asks whether the other end is there as well, since an end that was closed while nothing was read is not everywhere told to one that only reads. */
    take() {
      state.taking = true
      for (const socket of sockets) {
        socket.resume()
        if (!socket.destroyed) socket.write(framed(Buffer.alloc(0), 9))
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------- a backend that signs ----------

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
let signing: Promise<{
  issuer: string
  signed(audience: string, subject: string, claims: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}> | null = null
/**
 * The backend's HTTP port as far as the content package asks it anything: it gives the public
 * half of a key pair, and `signed` signs with the other half as the backend would. It is made
 * the first time a test asks for it.
 */
function signs() {
  signing ??= (async () => {
    const pair = await generateKeyPair('ES256')
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }
    const keys = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => keys.listen(0, '127.0.0.1', resolve))
    const issuer = `http://127.0.0.1:${(keys.address() as net.AddressInfo).port}`
    return {
      issuer,
      signed: (audience: string, subject: string, claims: Record<string, unknown>) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime('60s')
          .setJti(randomUUID())
          .sign(pair.privateKey),
      close: async () => {
        keys.closeAllConnections()
        await new Promise((resolve) => keys.close(resolve))
      },
    }
  })()
  return signing
}
afterAll(async () => {
  await (await signing)?.close()
})

// ---------- doors ----------

let backend: Backend
const config = (port: number, network = false): ServiceConfig => ({ port, network, instanceSecret: 'x', adminKey: 'x', sessionSecret: 'x' })
const parts = (more: DoorParts = {}): DoorParts => ({ content: contentStandIn, site: siteStandIn, push: pushStandIn, ...more })

interface Opened {
  base: number
  said: string[]
  stop(): Promise<void>
}
/**
 * Opens a door on a base port nothing is using, with the one after it. The ports are picked from
 * a range that the system never hands out by itself, and another base is tried when one of the
 * two turns out to be taken.
 */
async function open(network = false, more: DoorParts = {}, behind: Backend = backend): Promise<Opened> {
  for (let tries = 0; ; tries++) {
    const base = 20_000 + Math.floor(Math.random() * 9_000)
    const said: string[] = []
    try {
      const door = await startDoor(config(base, network), behind, (line) => said.push(line), parts(more))
      return { base, said, stop: () => door.stop() }
    } catch (err) {
      if (!(err instanceof Problem) || err.code !== 'port_taken' || tries > 20) throw err
    }
  }
}

/**
 * Whether a test may have the door it opens listen on every address this machine has. With the
 * network on, the door answers, for a moment, on the machine's network addresses, on ports of
 * its own. Running the unit tests has not asked for that, so what turns the network on runs
 * only where `CI` is set or `IT_E2E_NETWORK=1` says it may, and a line says so where it is left out.
 */
const mayOpen = Boolean(process.env.CI) || process.env.IT_E2E_NETWORK === '1'
if (!mayOpen)
  console.log(
    '  skip  the tests that turn the network on for a door of their own: set IT_E2E_NETWORK=1 to have them open the door they start to this machine’s network for a moment',
  )

let door: Opened
/** Whether this machine has IPv6 at all: the door listens on it only where it does. */
let six = false
beforeAll(async () => {
  await new Promise<void>((resolve) => site.server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  backend = {
    api: `http://127.0.0.1:${(api.server.address() as net.AddressInfo).port}`,
    site: `http://127.0.0.1:${(site.server.address() as net.AddressInfo).port}`,
    adminKey: 'x',
    stop: async () => {},
  }
  door = await open()
  six = await ask(door.base, { to: '::1', host: `[::1]:${door.base}` }).then(
    () => true,
    () => false,
  )
})
afterAll(async () => {
  await door?.stop()
  for (const socket of api.sockets) socket.destroy()
  await new Promise((resolve) => api.server.close(resolve))
  site.server.closeAllConnections?.()
  await new Promise((resolve) => site.server.close(resolve))
})
afterEach(() => {
  site.asked.length = 0
  api.heads.length = 0
  api.calls.length = 0
  api.closes.length = 0
  content.asked.length = 0
  pushStandIn.asked.length = 0
})

const own = (base = door.base): [string, string] => ['Origin', `http://127.0.0.1:${base}`]
/** Asks for a WebSocket by hand, and gives the status the door answered with. */
const upgrade = (port: number, pathname: string, headers: [string, string][] = []) =>
  ask(port, {
    path: pathname,
    upgrade: true,
    headers: [['Upgrade', 'websocket'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='], ...headers],
  }).then((answer) => answer.status)

/** A WebSocket's first request as a browser writes it, with whatever of it the test changes, leaves out or adds. */
function handshake(
  port: number,
  o: { path?: string; host?: string; origin?: string | null; version?: string | null; key?: string | null; more?: string[] } = {},
): string {
  const lines = [`GET ${o.path ?? '/api/1.46.0/sync'} HTTP/1.1`, `Host: ${o.host ?? `127.0.0.1:${port}`}`, 'Connection: Upgrade', 'Upgrade: websocket']
  if (o.origin !== null) lines.push(`Origin: ${o.origin ?? `http://127.0.0.1:${port}`}`)
  if (o.version !== null) lines.push(`Sec-WebSocket-Version: ${o.version ?? '13'}`)
  if (o.key !== null) lines.push(`Sec-WebSocket-Key: ${o.key ?? 'dGhlIHNhbXBsZSBub25jZQ=='}`)
  return `${[...lines, ...(o.more ?? [])].join('\r\n')}\r\n\r\n`
}
/** A connection of the test's own to the door: what is written to it goes as it is, and everything that comes back is kept. */
function wire(port: number) {
  const socket = net.connect(port, '127.0.0.1')
  let got = Buffer.alloc(0)
  let closed = false
  socket.on('data', (piece: Buffer) => {
    got = Buffer.concat([got, piece])
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    closed = true
  })
  return {
    socket,
    send: (bytes: string | Buffer) => socket.write(bytes),
    got: () => got,
    text: () => got.toString('latin1'),
    closed: () => closed,
    /** The status of the first answer, once all of its headers are here. */
    async status(ms = 5000): Promise<number> {
      await until(() => got.includes('\r\n\r\n') || closed, ms)
      return got.includes('\r\n\r\n') ? Number(got.toString('latin1').split(' ')[1]) : 0
    },
    end: () => socket.destroy(),
  }
}
/**
 * Waits until nothing more can come of what a caller has sent: the door has closed the
 * connection, or has answered a second time on it, which is all that anything sent behind a
 * first request could bring.
 */
const nothingMoreFor = (caller: ReturnType<typeof wire>) => until(() => caller.closed() || (caller.text().match(/HTTP\/1\.1 \d{3} /g) ?? []).length > 1)
/** What a WebSocket's first request is answered with, the connection then being let go of. */
async function answered(port: number, request: string): Promise<number> {
  const caller = wire(port)
  caller.send(request)
  try {
    return await caller.status()
  } finally {
    caller.end()
  }
}
/**
 * Everything the door says on a connection that was sent these bytes and nothing after them,
 * taken apart into the answers it holds: the status and the headers of each. It is read until
 * the door closes the connection, or until a second has passed with nothing more said.
 */
async function everyAnswer(port: number, bytes: string | Buffer, to = '127.0.0.1'): Promise<{ status: number; headers: Record<string, string> }[]> {
  const socket = net.connect(port, to)
  let got = Buffer.alloc(0)
  let [closed, last] = [false, Date.now()]
  socket.on('data', (piece: Buffer) => {
    got = Buffer.concat([got, piece])
    last = Date.now()
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    closed = true
  })
  socket.on('connect', () => socket.write(bytes))
  await until(() => closed || (got.length > 0 && Date.now() - last > 1000), 10_000)
  socket.destroy()
  const answers: { status: number; headers: Record<string, string> }[] = []
  let rest = got
  while (rest.length) {
    const cut = rest.indexOf('\r\n\r\n')
    // Whatever the door says is an answer, from its first byte
    if (cut < 0 || !/^HTTP\/1\.1 \d{3} /.test(rest.subarray(0, 13).toString('latin1'))) throw new Error('the door said something that is no answer')
    const [first = '', ...lines] = rest.subarray(0, cut).toString('latin1').split('\r\n')
    const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]))
    const status = Number(first.split(' ')[1])
    answers.push({ status, headers })
    rest = rest.subarray(cut + 4)
    if (status < 200 || status === 204 || status === 304) continue
    if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
      for (;;) {
        const end = rest.indexOf('\r\n')
        const size = Number.parseInt(rest.subarray(0, Math.max(end, 0)).toString('latin1'), 16)
        if (end < 0 || Number.isNaN(size)) throw new Error('an answer of the door’s was cut short')
        rest = rest.subarray(end + 2 + size + 2)
        if (!size) break
      }
    } else rest = rest.subarray(headers['content-length'] === undefined ? rest.length : Number(headers['content-length']))
  }
  return answers
}

describe('The names the door answers to', () => {
  test('A request sent to localhost, to 127.0.0.1 or to [::1] on the port it arrived at is answered', async () => {
    for (const host of [`localhost:${door.base}`, `127.0.0.1:${door.base}`, `[::1]:${door.base}`, `LocalHost:${door.base}`]) {
      const answer = await ask(door.base, { host })
      expect([host, answer.status]).toEqual([host, 200])
      expect(answer.body).toContain('<title>It</title>')
    }
    if (six) expect((await ask(door.base, { to: '::1', host: `[::1]:${door.base}` })).status).toBe(200)
  })

  test('A name is taken for what it means and not for how it is spelled, in the Host, in an address written out in full and in an Origin', async () => {
    const short = `[::1]:${door.base}`
    const long = `[0:0:0:0:0:0:0:1]:${door.base}`
    const longest = `[0000:0000:0000:0000:0000:0000:0000:0001]:${door.base}`
    for (const host of [long, longest]) {
      const answer = await ask(door.base, { host })
      expect([host, answer.status]).toEqual([host, 200])
      expect(answer.body).toContain('<title>It</title>')
    }
    // The place a request names in full is the place it was sent to when the two mean the same
    for (const [host, full] of [
      [short, `http://${long}/LICENSE.md`],
      [long, `http://${short}/LICENSE.md`],
      [longest, `HTTP://${long}/LICENSE.md`],
      [`LOCALHOST:${door.base}`, `http://localhost:${door.base}/LICENSE.md`],
    ] as const) {
      const answer = await ask(door.base, { host, path: full })
      expect([host, full, answer.status, answer.body]).toEqual([host, full, 200, 'The terms.'])
    }
    // And so is the origin of the door's own page
    const signIn = (host: string, origin: string) =>
      ask(door.base, { method: 'POST', path: '/session/redeem', host, headers: [['Origin', origin]], body: '{}' }).then((answer) => answer.status)
    for (const [host, origin] of [
      [long, `http://${short}`],
      [short, `http://${long}`],
      [longest, `http://${long}`],
      [`localhost:${door.base}`, `HTTP://LocalHost:${door.base}`],
    ] as const) {
      expect([host, origin, await signIn(host, origin)]).toEqual([host, origin, 200])
      expect([host, origin, await answered(door.base, handshake(door.base, { host, origin }))]).toEqual([host, origin, 101])
    }
    // Another place is still another, however like this one it is written
    for (const [host, full] of [
      [short, `http://[0:0:0:0:0:0:0:2]:${door.base}/LICENSE.md`],
      [short, `http://[::1]:${door.base + 1}/LICENSE.md`],
      [short, `https://${short}/LICENSE.md`],
      [short, `http://user@${short}/LICENSE.md`],
      [short, `http://${short}`],
      [`127.0.0.1:${door.base}`, `http://127.1:${door.base}/LICENSE.md`],
    ] as const)
      expect([host, full, (await ask(door.base, { host, path: full })).status]).toEqual([host, full, 400])
    for (const origin of [
      `http://[::2]:${door.base}`,
      `http://[::1]:${door.base + 1}`,
      `https://${short}`,
      `http://${short}/`,
      `http://user@${short}`,
      'http://[::1]',
    ])
      expect([origin, await signIn(long, origin)]).toEqual([origin, 403])
  })

  test('A request sent to any other name is refused before anything else is looked at', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && !a.internal && a.family === 'IPv4')?.address
    const others = [
      `evil.example:${door.base}`,
      `localhost.evil.example:${door.base}`,
      `127.0.0.1.evil.example:${door.base}`,
      // This machine's own names on its networks, while the network is off
      ...(os.hostname().toLowerCase() === 'localhost' ? [] : [`${os.hostname()}:${door.base}`]),
      ...(lan ? [`${lan}:${door.base}`] : []),
      // A right name on a port the request did not arrive at, and on none
      `localhost:${door.base + 1}`,
      'localhost',
      `localhost:${door.base}, evil.example`,
      `evil.example/:${door.base}`,
      null,
    ]
    for (const host of others) {
      // Each is something the door would otherwise have passed on or handed over
      for (const [method, pathname] of [
        ['GET', '/'],
        ['GET', '/health'],
        ['POST', '/control/stage'],
        ['PUT', '/upload/a.txt'],
      ] as const) {
        const answer = await ask(door.base, { host, method, path: pathname, body: method === 'GET' ? undefined : 'x' })
        // A request that names nobody at all may be refused by whatever reads requests, before the door sees it
        expect([host, pathname, answer.status === 400 && host === null ? 421 : answer.status]).toEqual([host, pathname, 421])
        expect(answer.body).not.toContain('<title>It</title>')
      }
    }
    expect(site.asked).toEqual([])
    expect(content.asked).toEqual([])
  })

  test('An address written out in full is answered when it names the place the request was sent to, and refused when it names another', async () => {
    const here = await ask(door.base, { path: `http://127.0.0.1:${door.base}/sw.js` })
    expect([here.status, here.body]).toEqual([200, '// the service worker'])
    for (const elsewhere of [
      'http://evil.example/sw.js',
      `http://evil.example:${door.base}/sw.js`,
      `http://localhost:${door.base}/sw.js`,
      `http://127.0.0.1:${door.base + 1}/sw.js`,
    ])
      expect([elsewhere, (await ask(door.base, { path: elsewhere })).status]).toEqual([elsewhere, 400])
    expect(JSON.parse((await ask(door.base + 1, { path: `http://127.0.0.1:${door.base + 1}/open/t` })).body)).toMatchObject({
      which: 'showing',
      path: '/open/t',
    })
    expect((await ask(door.base + 1, { path: `http://127.0.0.1:${door.base}/open/t` })).status).toBe(400)
  })

  test('A name that is not this machine’s is refused on the pages’ port, and for a WebSocket', async () => {
    expect((await ask(door.base + 1, { host: `evil.example:${door.base + 1}`, path: '/open/t' })).status).toBe(421)
    expect((await ask(door.base + 1, { host: `localhost:${door.base}`, path: '/open/t' })).status).toBe(421)
    expect(content.asked).toEqual([])
    const refused = await ask(door.base, {
      host: `evil.example:${door.base}`,
      path: '/api/1.46.0/sync',
      upgrade: true,
      headers: [
        ['Upgrade', 'websocket'],
        ['Sec-WebSocket-Version', '13'],
        ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
        ['Origin', `http://evil.example:${door.base}`],
      ],
    })
    expect(refused.status).toBe(421)
    expect(api.heads).toEqual([])
  })

  // Left out where a test may not turn the network on: see `mayOpen`
  test.skipIf(!mayOpen)('With the network on, the door answers to this machine’s host name and to its addresses, and still to no other name', async () => {
    const wide = await open(true)
    try {
      const names = [os.hostname(), ...(os.hostname().includes('.') ? [] : [`${os.hostname()}.local`])]
      for (const a of Object.values(os.networkInterfaces()).flat()) if (a && !a.internal) names.push(a.family === 'IPv6' ? `[${a.address}]` : a.address)
      for (const name of names) expect([name, (await ask(wide.base, { host: `${name}:${wide.base}` })).status]).toEqual([name, 200])
      expect((await ask(wide.base, { host: `localhost:${wide.base}` })).status).toBe(200)
      expect((await ask(wide.base, { host: `evil.example:${wide.base}` })).status).toBe(421)
      expect(wide.said[0]).toContain('the network is on')
    } finally {
      await wide.stop()
    }
  })
})

describe('What the door passes on to the backend', () => {
  test('The session’s routes, the machines’ routes, the public keys and the rest of the named routes reach the backend’s HTTP port and are answered as it answers', async () => {
    const redeemed = await ask(door.base, {
      method: 'POST',
      path: '/session/redeem',
      headers: [own(), ['x-it-site', '1'], ['x-it-door', 'a-callers-own-word'], ['Content-Type', 'application/json']],
      body: '{"code":"abc"}',
    })
    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toBe('{"ok":true}')
    // Every cookie the backend sets arrives as a line of its own, in the order it set them
    expect(redeemed.cookies).toEqual(SET)
    expect(redeemed.headers['cache-control']).toBe('no-store')
    expect(site.asked[0]).toMatchObject({ method: 'POST', path: '/session/redeem', body: '{"code":"abc"}' })
    expect(site.asked[0]!.headers['x-it-site']).toBe('1')
    // What the door shows the backend goes with it, and is the door's own whatever the caller sent as it
    expect(site.asked[0]!.headers['x-it-door']).toBe(doorKey(config(door.base)))
    expect(doorKey(config(door.base))).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // The backend's own refusal is the answer, with its status
    const token = await ask(door.base, { method: 'POST', path: '/session/token', headers: [own(), ['Cookie', 'it_session_k17a=s3cret; it_session_k17b=0ld']] })
    expect([token.status, token.body, token.cookies]).toEqual([401, '{"error":"no session"}', SET.slice(1)])
    expect(site.asked[1]!.headers.cookie).toBe('it_session_k17a=s3cret; it_session_k17b=0ld')
    const ended = await ask(door.base, {
      method: 'POST',
      path: '/session/end',
      headers: [own(), ['Content-Type', 'application/json']],
      body: '{"session":"k17a"}',
    })
    expect([ended.status, ended.cookies]).toEqual([200, SET])

    for (const [method, pathname] of [
      ['POST', '/bridge/token'],
      ['POST', '/bridge/enroll'],
      ['POST', '/display/signout'],
      ['GET', '/.well-known/jwks.json'],
      ['GET', '/cli/config'],
      ['GET', '/health?x=1'],
    ] as const) {
      const answer = await ask(door.base, { method, path: pathname, body: method === 'POST' ? '{}' : undefined })
      expect([pathname, answer.status, answer.body]).toEqual([pathname, 200, JSON.stringify({ backend: pathname })])
      expect(site.asked.at(-1)).toMatchObject({ method, path: pathname })
    }
    const allowed = await ask(door.base, { method: 'OPTIONS', path: '/display/signout' })
    expect([allowed.status, allowed.headers['access-control-allow-methods']]).toEqual([204, 'POST'])
  })

  test('The backend is told how the request arrived, and what a caller says about that or about who it is goes no further', async () => {
    await ask(door.base, {
      method: 'POST',
      path: '/session/redeem',
      headers: [
        own(),
        ['X-Forwarded-Proto', 'https'],
        ['x-forwarded-proto', 'https'],
        ['X-Forwarded-For', '203.0.113.9'],
        ['X-Forwarded-Host', 'evil.example'],
        ['Forwarded', 'proto=https;for=203.0.113.9'],
        ['X-Real-IP', '203.0.113.9'],
      ],
      body: '{}',
    })
    const seen = site.asked[0]!.headers
    expect(seen['x-forwarded-proto']).toBe('http')
    expect(seen['x-forwarded-for']).toBeUndefined()
    expect(seen['x-forwarded-host']).toBeUndefined()
    expect(seen.forwarded).toBeUndefined()
    expect(seen['x-real-ip']).toBeUndefined()
  })

  test('What a request or an answer says about the one connection it came on goes no further, the headers a Connection header names among them', async () => {
    const passed = await ask(door.base, {
      method: 'POST',
      path: '/bridge/token',
      headers: [
        ['Connection', 'X-Caller-Hop, x-also-named'],
        ['X-Caller-Hop', 'must-not-pass'],
        ['X-Also-Named', 'must-not-pass'],
        ['Keep-Alive', 'timeout=5'],
        ['Proxy-Authorization', 'Basic c3ludGhldGlj'],
        ['Proxy-Connection', 'keep-alive'],
        ['TE', 'trailers'],
        ['Trailer', 'x-after'],
        ['Via', '1.1 another'],
        ['Authorization', 'Bearer its.token'],
        ['Content-Type', 'application/json'],
        ['X-Kept', 'yes'],
      ],
      body: '{}',
    })
    expect(passed.status).toBe(200)
    const sent = site.asked[0]!.headers
    expect(Object.keys(sent).filter((name) => /^(x-caller-hop|x-also-named|keep-alive|proxy-.*|te|via|trailer|upgrade|expect)$/.test(name))).toEqual([])
    // What is the request's own goes on as it was
    expect(sent).toMatchObject({ authorization: 'Bearer its.token', 'content-type': 'application/json', 'x-kept': 'yes' })
    expect(site.asked[0]!.body).toBe('{}')
    // A header named by Connection that is not a header at all changes nothing
    const odd = await ask(door.base, { path: '/health', headers: [['Connection', ', ,x y, x-kept,']] })
    expect([odd.status, odd.body]).toEqual([200, JSON.stringify({ backend: '/health' })])

    // A backend that says such things of its own connection, by the names every proxy knows and by one it names itself
    const talkative = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () =>
        socket.end(
          [
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            'Connection: X-Backend-Hop, close',
            'X-Backend-Hop: must-not-pass',
            'Keep-Alive: timeout=5',
            'Proxy-Authenticate: Basic realm="backend"',
            'Proxy-Authentication-Info: nextnonce="backend"',
            'Trailer: x-after',
            'Upgrade: h2c',
            'X-Kept: yes',
            'Transfer-Encoding: chunked',
            '',
            'b',
            '{"ok":true}',
            '0',
            'x-after: said-last',
            '',
            '',
          ].join('\r\n'),
        ),
      )
    })
    await new Promise<void>((resolve) => talkative.listen(0, '127.0.0.1', resolve))
    const other = await open(false, {}, { ...backend, site: `http://127.0.0.1:${(talkative.address() as net.AddressInfo).port}` })
    try {
      const answer = await ask(other.base, { path: '/health' })
      expect([answer.status, answer.body]).toEqual([200, '{"ok":true}'])
      expect(Object.keys(answer.headers).filter((name) => /^(x-backend-hop|keep-alive|proxy-.*|trailer|upgrade|x-after)$/.test(name))).toEqual([])
      expect(answer.headers).toMatchObject({ 'content-type': 'application/json', 'x-kept': 'yes', 'content-length': '11' })
    } finally {
      await other.stop()
      await new Promise((resolve) => talkative.close(resolve))
    }
  })

  test('A caller that waits to be told to go on before it sends its body is answered as any other', async () => {
    const caller = wire(door.base)
    caller.send(
      `POST /bridge/token HTTP/1.1\r\nHost: 127.0.0.1:${door.base}\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 13\r\nConnection: close\r\n\r\n`,
    )
    await until(() => caller.text().includes('100 Continue'))
    caller.send('{"proof":"p"}')
    await until(() => caller.closed() || /\r\n\r\n[\s\S]*\r\n\r\n[\s\S]*backend/.test(caller.text()))
    caller.end()
    expect(caller.text()).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 /)
    expect(caller.text()).toContain(JSON.stringify({ backend: '/bridge/token' }))
    expect(site.asked).toHaveLength(1)
    expect(site.asked[0]).toMatchObject({ method: 'POST', path: '/bridge/token', body: '{"proof":"p"}' })
    expect(site.asked[0]!.headers.expect).toBeUndefined()
  })

  test('An answer of the backend’s that sends the caller elsewhere is passed on as it is, and the door goes nowhere itself', async () => {
    const answer = await ask(door.base, { method: 'POST', path: '/bridge/moved', body: '{}' })
    expect([answer.status, answer.body]).toEqual([302, 'moved'])
    expect(answer.headers.location).toBe(`${backend.site}/health`)
    expect(site.asked.map((asked) => asked.path)).toEqual(['/bridge/moved'])
  })

  test('A call of a function that the backend answers by sending the caller elsewhere is answered with that, and the door goes nowhere itself', async () => {
    for (const pathname of ['/api/query', '/api/mutation', '/api/action']) {
      const answer = await ask(door.base, { method: 'POST', path: pathname, headers: [['Content-Type', 'application/json']], body: '{"path":"moved"}' })
      expect([pathname, answer.status, answer.body]).toEqual([pathname, 307, '{"moved":true}'])
      // Where it was sent is the backend's own business, and is not said to the caller
      expect([pathname, answer.headers.location]).toEqual([pathname, undefined])
    }
    expect(api.calls.map((call) => call.path)).toEqual(['/api/query', '/api/mutation', '/api/action'])
    expect(site.asked).toEqual([])
  })

  test('A session’s route is refused to a page of another origin, to a request that names no origin, and to anything but a POST', async () => {
    const elsewhere = [
      `http://evil.example:${door.base}`,
      'http://evil.example',
      `http://localhost:${door.base + 1}`,
      `https://127.0.0.1:${door.base}`,
      `http://127.0.0.1:${door.base}.evil.example`,
      'null',
    ]
    for (const origin of elsewhere) {
      const answer = await ask(door.base, {
        method: 'POST',
        path: '/session/token',
        headers: [
          ['Origin', origin],
          ['x-it-site', '1'],
        ],
        body: '{}',
      })
      expect([origin, answer.status]).toEqual([origin, 403])
    }
    expect((await ask(door.base, { method: 'POST', path: '/session/token', headers: [['x-it-site', '1']], body: '{}' })).status).toBe(403)
    // The origin is the door's own address as the request names it: a right origin for another of the door's names is not this request's
    expect((await ask(door.base, { method: 'POST', path: '/session/token', host: `localhost:${door.base}`, headers: [own()], body: '{}' })).status).toBe(403)
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const answer = await ask(door.base, { method, path: '/session/token', headers: [own()] })
      expect([method, answer.status]).toEqual([method, 405])
    }
    expect(site.asked).toEqual([])
  })

  test('A machine’s route is refused to a page of another site, by the origin its browser names, and passed on for the command, which names none', async () => {
    for (const pathname of ['/bridge/enroll', '/bridge/token']) {
      for (const origin of [
        `http://evil.example:${door.base}`,
        'http://evil.example',
        `http://127.0.0.1:${door.base + 1}`,
        `https://127.0.0.1:${door.base}`,
        'null',
      ]) {
        // As a page's form or request arrives: with nothing a browser would have to ask leave for
        const answer = await ask(door.base, {
          method: 'POST',
          path: pathname,
          headers: [
            ['Origin', origin],
            ['Content-Type', 'text/plain'],
          ],
          body: '{"code":"wrong-0","publicKey":{}}',
        })
        expect([pathname, origin, answer.status, answer.body]).toEqual([pathname, origin, 403, '{"error":"foreign_origin"}'])
      }
      // A right origin for another of the door's names is not this request's
      expect((await ask(door.base, { method: 'POST', path: pathname, host: `localhost:${door.base}`, headers: [own()], body: '{}' })).status).toBe(403)
      expect(site.asked).toEqual([])
      // The command names no origin, and the site's own page names the door's
      expect((await ask(door.base, { method: 'POST', path: pathname, body: '{}' })).status).toBe(200)
      expect((await ask(door.base, { method: 'POST', path: pathname, headers: [own()], body: '{}' })).status).toBe(200)
      expect(site.asked.map((asked) => asked.path)).toEqual([pathname, pathname])
      site.asked.length = 0
    }
  })

  test('An address that has had ten codes refused in a minute is asked to wait out the rest of it without the backend being asked, and no other address is slowed by that', async () => {
    let time = 1_000_000
    const said: string[] = []
    const counting = makeDoor(config(door.base), backend, (line) => said.push(line), parts({ now: () => time }))
    /** A code put by a browser, or by a machine that asks to join, from one address. */
    const put = async (address: string, pathname: '/session/redeem' | '/session/code' | '/bridge/enroll', code: string, more: Record<string, string> = {}) => {
      const answer = await counting.answer({
        method: 'POST',
        target: pathname,
        headers: new Headers({
          host: `127.0.0.1:${door.base}`,
          'content-type': 'application/json',
          ...(pathname === '/bridge/enroll' ? {} : { origin: `http://127.0.0.1:${door.base}` }),
          ...more,
        }),
        body: new Response(JSON.stringify({ code })).body,
        port: door.base,
        address,
      } satisfies Arrival)
      return { status: answer.status, body: await answer.text(), wait: answer.headers.get('retry-after') }
    }
    const [A, B, C] = ['192.168.1.50', '192.168.1.51', 'fd00::51']
    // Refused where a browser pairs and where it asks what a code is for, and a tenth where a machine joins: they are one count
    for (let n = 0; n < 5; n++) expect((await put(A, '/session/redeem', `wrong-${n}`)).status).toBe(401)
    for (let n = 5; n < 9; n++) expect((await put(A, '/session/code', `wrong-${n}`)).status).toBe(401)
    time += 20_000
    expect((await put(A, '/bridge/enroll', 'wrong-9')).status).toBe(401)
    const asked = site.asked.length
    // From then on it is answered here, right code or wrong, on every one of them, and told how long is left of the minute
    expect(await put(A, '/session/redeem', 'the-right-code')).toEqual({ status: 429, body: '{"error":"too_many_wrong_codes"}', wait: '40' })
    expect((await put(A, '/session/code', 'the-right-code')).status).toBe(429)
    expect((await put(A, '/bridge/enroll', 'the-right-code')).status).toBe(429)
    expect(site.asked.length).toBe(asked)
    // What it says of who is asking changes nothing: it is counted by where it really comes from
    expect((await put(A, '/bridge/enroll', 'the-right-code', { 'x-forwarded-for': B, forwarded: `for=${B}` })).status).toBe(429)
    // Every other address is answered as ever, and has a count of its own
    expect((await put(B, '/session/redeem', 'the-right-code')).status).toBe(200)
    expect(await put(B, '/session/code', 'the-right-code')).toMatchObject({ status: 200, body: '{"role":"owner"}' })
    expect((await put(C, '/bridge/enroll', 'the-right-code')).status).toBe(200)
    expect((await put(B, '/session/redeem', 'wrong-b')).status).toBe(401)
    expect((await put(B, '/session/redeem', 'the-right-code')).status).toBe(200)
    // Until the minute that began with its first refusal is over
    time += 39_000
    expect(await put(A, '/session/redeem', 'the-right-code')).toMatchObject({ status: 429, wait: '1' })
    time += 1_000
    expect((await put(A, '/session/redeem', 'the-right-code')).status).toBe(200)
    // Fewer than ten in a minute are never held against it in the next, and a code that is taken is no refusal
    for (let n = 0; n < 9; n++) expect((await put(C, '/bridge/enroll', `wrong-${n}`)).status).toBe(401)
    time += 60_000
    for (let n = 0; n < 9; n++) expect((await put(C, '/bridge/enroll', `wrong-${n}`)).status).toBe(401)
    for (let n = 0; n < 30; n++) expect((await put(B, '/session/redeem', 'the-right-code')).status).toBe(200)
    expect((await put(C, '/bridge/enroll', 'the-right-code')).status).toBe(200)
    // It is written down that it happened, by its code and with no address
    expect(said.filter((line) => line.includes('too_many_wrong_codes'))).toEqual(['door refused a request (too_many_wrong_codes)'])
    expect(said.join('\n')).not.toMatch(/192\.168|fd00/)
    await counting.close()
  })

  test('A refusal that is not of a code is no part of that count: a browser with no session may ask whether it has one as often as it likes', async () => {
    for (let n = 0; n < 15; n++) expect((await ask(door.base, { method: 'POST', path: '/session/token', headers: [own()] })).status).toBe(401)
    const redeemed = await ask(door.base, {
      method: 'POST',
      path: '/session/redeem',
      headers: [own(), ['Content-Type', 'application/json']],
      body: '{"code":"abc"}',
    })
    expect(redeemed.status).toBe(200)
  })

  test('However many codes an address sends together, no more of them reach the backend than it has left of its ten, and each is waited for only until it is answered', async () => {
    const time = 1_000_000
    // A backend that answers only when the test lets it
    const held: (() => void)[] = []
    const arrived: string[] = []
    const slow = http.createServer((req, res) => {
      const pieces: Buffer[] = []
      req.on('data', (piece: Buffer) => pieces.push(piece))
      req.on('end', () => {
        const sent = Buffer.concat(pieces).toString('utf8')
        arrived.push(`${req.url} ${sent}`)
        held.push(() => {
          res.writeHead(sent.includes('"wrong') ? 401 : 200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const behind = { ...backend, site: `http://127.0.0.1:${(slow.address() as net.AddressInfo).port}` }
    const counting = makeDoor(config(door.base), behind, () => {}, parts({ now: () => time, patience: 300 }))
    const routes = ['/session/redeem', '/session/code', '/bridge/enroll'] as const
    /** A code sent from an address, with the body the test gives it: whole, or still to be finished. */
    const put = (address: string, n: number, code: string, body: ReadableStream<Uint8Array> | null = new Response(JSON.stringify({ code })).body) => {
      const pathname = routes[n % routes.length]!
      return counting
        .answer({
          method: 'POST',
          target: pathname,
          headers: new Headers({
            host: `127.0.0.1:${door.base}`,
            'content-type': 'application/json',
            ...(pathname === '/bridge/enroll' ? {} : { origin: `http://127.0.0.1:${door.base}` }),
          }),
          body,
          port: door.base,
          address,
        } satisfies Arrival)
        .then((answer) => ({ status: answer.status, wait: answer.headers.get('retry-after') }))
    }
    const answerAll = async (count: number) => {
      await until(() => held.length === count)
      for (const answer of held.splice(0)) answer()
    }
    /** How many of the answers had each status. */
    const tally = (answers: { status: number }[]) => {
      const seen: Record<number, number> = {}
      for (const { status } of answers) seen[status] = (seen[status] ?? 0) + 1
      return seen
    }
    const [A, B, C, D, E] = ['192.168.1.60', '192.168.1.61', 'fd00::61', '192.168.1.62', '192.168.1.63']
    try {
      // Forty wrong codes at once from one address, over all three routes: ten reach the backend, and the rest are told to wait a moment
      let told = 0
      const forty = Array.from({ length: 40 }, (_, n) =>
        put(A, n, `wrong-${n}`).then((answer) => {
          told += 1
          return answer
        }),
      )
      // Every one of the forty has gone one way or the other: ten are with the backend, and thirty have been answered
      await until(() => arrived.length >= 10 && told === 30)
      expect(arrived).toHaveLength(10)
      // While they wait, another address is answered as ever, and has ten of its own
      const other = put(B, 0, 'the-right-code')
      await answerAll(11)
      expect((await other).status).toBe(200)
      const answers = await Promise.all(forty)
      expect(tally(answers)).toEqual({ 401: 10, 429: 30 })
      expect(answers.filter((answer) => answer.status === 429).every((answer) => answer.wait === '1')).toBe(true)
      // The ten were refused, so the address now waits out its minute
      expect(await put(A, 0, 'the-right-code')).toEqual({ status: 429, wait: '60' })
      expect(arrived).toHaveLength(11)

      // Seven refused one after another, then five together: three are sent on, and two are not
      for (let n = 0; n < 7; n++) {
        const one = put(C, n, `wrong-${n}`)
        await answerAll(1)
        expect((await one).status).toBe(401)
      }
      const five = Array.from({ length: 5 }, (_, n) => put(C, n, `wrong-more-${n}`))
      await answerAll(3)
      expect(tally(await Promise.all(five))).toEqual({ 401: 3, 429: 2 })

      // Codes that are taken are waited for only until they are answered: ten together, and ten more after them
      for (let round = 0; round < 2; round++) {
        const ten = Array.from({ length: 12 }, (_, n) => put(D, n, 'the-right-code'))
        await answerAll(10)
        expect(tally(await Promise.all(ten))).toEqual({ 200: 10, 429: 2 })
      }

      // Nor is one waited for whose body never arrives, or whose sender goes away before it has: each is given up on, and the address has its ten again
      const before = arrived.length
      const never = Array.from({ length: 5 }, (_, n) => put(E, n, '', new ReadableStream<Uint8Array>()))
      const cut = Array.from({ length: 5 }, (_, n) =>
        put(
          E,
          n,
          '',
          new ReadableStream<Uint8Array>({
            pull: (controller) => pause(50).then(() => controller.error(new Error('the sender went away'))),
          }),
        ),
      )
      expect((await put(E, 0, 'the-right-code')).status).toBe(429)
      expect(tally(await Promise.all([...never, ...cut]))).toEqual({ 408: 10 })
      expect(arrived).toHaveLength(before)
      const again = Array.from({ length: 10 }, (_, n) => put(E, n, 'the-right-code'))
      await answerAll(10)
      expect(tally(await Promise.all(again))).toEqual({ 200: 10 })
    } finally {
      await counting.close()
      slow.closeAllConnections()
      await new Promise((resolve) => slow.close(resolve))
    }
    // And a backend that cannot be reached at all leaves nothing waited for
    const lonely = makeDoor(config(door.base), { ...backend, site: 'http://127.0.0.1:9' }, () => {}, parts())
    for (let round = 0; round < 2; round++) {
      const ten = await Promise.all(
        Array.from({ length: 10 }, () =>
          lonely.answer({
            method: 'POST',
            target: '/bridge/enroll',
            headers: new Headers({ host: `127.0.0.1:${door.base}`, 'content-type': 'application/json' }),
            body: new Response('{"code":"wrong"}').body,
            port: door.base,
            address: A,
          } satisfies Arrival),
        ),
      )
      expect(ten.map((answer) => answer.status)).toEqual(Array.from({ length: 10 }, () => 502))
    }
    await lonely.close()
  })

  test('Thirty wrong codes that arrive on thirty connections at once are held to the same ten', async () => {
    const lone = await open()
    try {
      const callers = Array.from({ length: 30 }, (_, n) => {
        const caller = wire(lone.base)
        const body = JSON.stringify({ code: `wrong-${n}` })
        const pathname = n % 2 ? '/session/redeem' : '/session/code'
        // Everything but the last of the body, so that all thirty are being read at the same moment
        caller.send(
          `POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${lone.base}\r\nOrigin: http://127.0.0.1:${lone.base}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, -1)}`,
        )
        return { caller, last: body.slice(-1) }
      })
      // A request sent after them all is answered: the door has had its turn at every one of them by then
      expect((await ask(lone.base)).status).toBe(200)
      for (const { caller, last } of callers) caller.send(last)
      const statuses: number[] = []
      for (const { caller } of callers) statuses.push(await caller.status(10_000))
      for (const { caller } of callers) caller.end()
      expect(statuses.filter((status) => status === 401)).toHaveLength(10)
      expect(statuses.filter((status) => status === 429)).toHaveLength(20)
      expect(site.asked).toHaveLength(10)
      // And the next is not sent on either, right code or wrong
      const next = await ask(lone.base, { method: 'POST', path: '/session/redeem', headers: [own(lone.base)], body: '{"code":"abc"}' })
      expect([next.status, next.body]).toEqual([429, '{"error":"too_many_wrong_codes"}'])
      expect(site.asked).toHaveLength(10)
    } finally {
      await lone.stop()
    }
  }, 30_000)

  test('Every path under /api/ but the live connection and the three calls of a function is refused, the backend’s routes for loading functions and changing settings among them', async () => {
    const refused = [
      // Loading functions
      '/api/deploy2/start_push',
      '/api/deploy2/wait_for_schema',
      '/api/deploy2/finish_push',
      '/api/deploy2/evaluate_push',
      '/api/deploy2/report_push_completed',
      '/api/push_config',
      '/api/prepare_schema',
      // Changing settings
      '/api/update_environment_variables',
      '/api/v1/update_environment_variables',
      '/api/v1/list_environment_variables',
      '/api/update_canonical_url',
      // Running functions any other way, and reading and writing what is stored
      '/api/function',
      '/api/query_at_ts',
      '/api/query_ts',
      '/api/query_batch',
      '/api/run/bridge/enroll',
      '/api/actions/mutation',
      '/api/actions/action',
      '/api/run_test_function',
      '/api/get_config',
      '/api/get_config_hashes',
      '/api/import',
      '/api/perform_import',
      '/api/export/request/zip',
      '/api/storage/upload',
      '/api/list_snapshot',
      '/api/document_deltas',
      '/api/json_schemas',
      '/api/shapes2',
      '/api/check_admin_key',
      '/api/stream_udf_execution',
      '/api/stream_function_logs',
      '/api/delete_component',
      '/api/delete_scheduled_functions_table',
      '/api/actions/query',
      '/api/streaming_import/import_airbyte_records',
      // The address of a call, bent
      '/api/query/',
      '/api/query/extra',
      '/api/Query',
      '/api/mutation/../function',
      '/api/query%2f..%2ffunction',
      '/api//query',
      // The live connection's own address, bent
      '/api',
      '/api/',
      '/api/sync',
      '/api//sync',
      '/api/1.46.0/sync/',
      '/api/1.46.0/sync/extra',
      '/api/1.46.0/sync/../../deploy2/start_push',
      '/api/1.46.0/sync/%2e%2e/%2e%2e/update_environment_variables',
      '/api/1.46.0/../update_environment_variables',
      '/api/1.46.0%2fsync',
      '/api/deploy2%2fstart_push/sync',
    ]
    for (const pathname of refused) {
      for (const method of ['GET', 'POST']) {
        const answer = await ask(door.base, {
          method,
          path: pathname,
          headers: [own(), ['Content-Type', 'application/json']],
          body: method === 'POST' ? '{"adminKey":"x"}' : undefined,
        })
        expect([method, pathname, answer.status]).toEqual([method, pathname, 404])
      }
      // And as a WebSocket, from the door's own origin
      expect([pathname, await upgrade(door.base, pathname, [own()])]).toEqual([pathname, 404])
    }
    // An address that climbs out of /api/ is the site's, which has no such file
    expect((await ask(door.base, { path: '/api/%2e%2e/sync', headers: [own()] })).status).toBe(404)
    expect(await upgrade(door.base, '/api/%2e%2e/sync', [own()])).toBe(404)
    // The address itself is a WebSocket's and nothing else's
    expect((await ask(door.base, { method: 'POST', path: '/api/1.46.0/sync', headers: [own()], body: '{}' })).status).toBe(404)
    expect((await ask(door.base, { path: '/api/1.46.0/sync', headers: [own()] })).status).toBe(426)
    expect(api.heads).toEqual([])
    expect(api.calls).toEqual([])
    expect(site.asked).toEqual([])
    expect(content.asked).toEqual([])
  })

  test('A call of one of the backend’s functions is passed on to the backend’s port for them and answered as it answers, with only what a call is made of', async () => {
    for (const pathname of ['/api/query', '/api/mutation', '/api/action']) {
      const body = JSON.stringify({ path: 'artifacts:list', args: [{}], format: 'json' })
      // As a program on another machine sends it: it names no origin
      const answer = await ask(door.base, {
        method: 'POST',
        path: pathname,
        headers: [
          ['Content-Type', 'application/json'],
          ['Authorization', 'Bearer its.token'],
          ['Convex-Client', 'npm-1.46.0'],
          ['Cookie', 'it_session_k17a=s3cret; another=sealed'],
          ['X-Forwarded-For', '203.0.113.9'],
        ],
        body,
      })
      expect([pathname, answer.status, answer.body]).toEqual([pathname, 200, JSON.stringify({ status: 'success', value: pathname })])
      const arrived = api.calls.at(-1)!
      expect([arrived.path, arrived.body]).toEqual([pathname, body])
      expect(arrived.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer its.token', 'convex-client': 'npm-1.46.0' })
      // No cookie of the browser's goes to the backend, and nothing a caller says about who it is
      expect(Object.keys(arrived.headers).filter((name) => /cookie|forwarded|origin/.test(name))).toEqual([])
      // Of what the backend answered, only the answer comes back: not its word that any origin may read it, and no cookie
      expect(Object.keys(answer.headers).filter((name) => /^access-control|^vary$/.test(name))).toEqual([])
      expect(answer.cookies).toEqual([])
      expect(answer.headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    }
    expect(api.calls).toHaveLength(3)
    // The site's own page may call too, and says where it is from
    const fromSite = await ask(door.base, {
      method: 'POST',
      path: '/api/query',
      headers: [own(), ['Content-Type', 'application/json; charset=utf-8']],
      body: '{}',
    })
    expect(fromSite.status).toBe(200)
    // A refusal of the backend's own comes back with the status it gave
    const failed = await ask(door.base, { method: 'POST', path: '/api/mutation', headers: [['Content-Type', 'application/json']], body: '{"path":"refuses"}' })
    expect([failed.status, failed.body]).toEqual([560, JSON.stringify({ status: 'error', errorMessage: 'refused' })])
    // And a query string is no part of a call
    await ask(door.base, { method: 'POST', path: '/api/query?adminKey=x', headers: [['Content-Type', 'application/json']], body: '{}' })
    expect(api.calls.at(-1)!.path).toBe('/api/query')
  })

  test('A call is refused to a page of another site: by the origin it names, and by what a page can send without asking leave', async () => {
    const json: [string, string] = ['Content-Type', 'application/json']
    for (const pathname of ['/api/query', '/api/mutation', '/api/action']) {
      // Another site, another port of this machine where a page is shown, and a page with no origin of its own
      for (const origin of [
        `http://evil.example:${door.base}`,
        'http://evil.example',
        `http://127.0.0.1:${door.base + 1}`,
        `https://127.0.0.1:${door.base}`,
        'null',
      ]) {
        const answer = await ask(door.base, { method: 'POST', path: pathname, headers: [['Origin', origin], json], body: '{}' })
        expect([pathname, origin, answer.status, answer.body]).toEqual([pathname, origin, 403, '{"error":"foreign_origin"}'])
      }
      // A right origin for another of the door's names is not this request's
      expect((await ask(door.base, { method: 'POST', path: pathname, host: `localhost:${door.base}`, headers: [own(), json], body: '{}' })).status).toBe(403)
      // What a form or a plain request can carry is not JSON by its own word, whoever sends it
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json', null]) {
        const answer = await ask(door.base, { method: 'POST', path: pathname, headers: type ? [['Content-Type', type]] : [], body: '{}' })
        expect([pathname, type, answer.status, answer.body]).toEqual([pathname, type, 415, '{"error":"call_type"}'])
      }
      // The backend's administrator is the service, which asks the backend itself: its key goes nowhere from here
      for (const as of [`Convex ${['it', '0123456789ab'].join('-')}|${'0123456789abcdef'}`, 'convex x', 'Basic eDp5', 'Bearer', 'Bearer a b', 'x']) {
        const answer = await ask(door.base, { method: 'POST', path: pathname, headers: [json, ['Authorization', as]], body: '{}' })
        expect([pathname, as, answer.status, answer.body]).toEqual([pathname, as, 403, '{"error":"call_as"}'])
      }
      // A browser that asks first whether another site may is not told that it may
      const asked = await ask(door.base, {
        method: 'OPTIONS',
        path: pathname,
        headers: [
          ['Origin', 'http://evil.example'],
          ['Access-Control-Request-Method', 'POST'],
          ['Access-Control-Request-Headers', 'content-type, authorization'],
        ],
      })
      expect([pathname, asked.status, Object.keys(asked.headers).filter((name) => name.startsWith('access-control'))]).toEqual([pathname, 405, []])
      // And it is a POST and nothing else: the backend takes a query as a plain read too
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
        const answer = await ask(door.base, { method, path: `${pathname}?path=artifacts:list&args=%7B%7D`, headers: [json] })
        expect([pathname, method, answer.status, answer.headers.allow]).toEqual([pathname, method, 405, 'POST'])
      }
      // Nor on the port pages are shown from, where everything is the content package's
      const onShowing = await ask(door.base + 1, { method: 'POST', path: pathname, headers: [json], body: '{}' })
      expect(JSON.parse(onShowing.body)).toMatchObject({ which: 'showing' })
    }
    expect(api.calls).toEqual([])
    expect(api.heads).toEqual([])
  })

  test('A call longer than a call may be is refused, and one as long as a page’s state arrives whole', async () => {
    const json: [string, string] = ['Content-Type', 'application/json']
    const state = JSON.stringify({ path: 'state:patch', args: [{ patch: 'x'.repeat(1024 * 1024) }] })
    expect((await ask(door.base, { method: 'POST', path: '/api/mutation', headers: [json], body: state })).status).toBe(200)
    expect(api.calls.at(-1)!.body.length).toBe(state.length)
    const before = api.calls.length
    const long = 'x'.repeat(4 * 1024 * 1024 + 1)
    expect((await ask(door.base, { method: 'POST', path: '/api/mutation', headers: [json], body: long })).status).toBe(413)
    expect((await ask(door.base, { method: 'POST', path: '/api/mutation', headers: [json], body: long, chunked: true })).status).toBe(413)
    expect(api.calls.length).toBe(before)
  })

  test('The live connection is passed on to the backend’s port for function calls, both ways, with nothing of the browser’s cookies', async () => {
    const heard: string[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${door.base}/api/1.46.0/sync`, {
      headers: { origin: `http://127.0.0.1:${door.base}`, cookie: 'it_session_k17a=s3cret; another=sealed' },
    } as unknown as string[])
    const long = 'y'.repeat(100_000)
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.onmessage = (event) => {
        heard.push(String(event.data))
        if (heard.length === 1) socket.send('one')
        if (heard.length === 2) socket.send(long)
        if (heard.length === 3) socket.send('close 4321 done')
      }
      socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
      setTimeout(() => reject(new Error('the live connection said nothing')), 10_000)
    })
    // The backend closes it, with a reason of its own, which arrives as it was said
    expect(await closed).toEqual({ code: 4321, reason: 'done' })
    expect(heard).toEqual(['hello from the backend', 'back: one', `back: ${long}`])
    expect(api.heads).toHaveLength(1)
    expect(api.heads[0]!.split('\r\n')[0]).toBe('GET /api/1.46.0/sync HTTP/1.1')
    expect(api.heads[0]).not.toMatch(/cookie|sealed|x-forwarded/i)
  })

  test('How the live connection ends is passed on as it was said, from the backend to the browser and from the browser to the backend', async () => {
    const opened = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${door.base}/api/1.46.0/sync`, {
          headers: { origin: `http://127.0.0.1:${door.base}` },
        } as unknown as string[])
        socket.onmessage = () => resolve(socket)
        socket.onerror = () => reject(new Error('the live connection did not open'))
      })
    const ended = (socket: WebSocket) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
      })
    // The backend asks the browser to come back later, in the words the client library waits by
    const busy = await opened()
    busy.send('close 1013 SubscriptionsWorkerFullError')
    expect(await ended(busy)).toEqual({ code: 1013, reason: 'SubscriptionsWorkerFullError' })
    // The browser leaves, and the backend is told with what code
    const leaving = await opened()
    leaving.close(4000, 'bye')
    expect((await ended(leaving)).code).toBe(4000)
    await until(() => api.closes.includes(4000))
  })

  test('The live connection is refused to a page of another origin, and passed on for a program, which names none', async () => {
    for (const origin of [`http://evil.example:${door.base}`, `http://127.0.0.1:${door.base + 1}`, `https://127.0.0.1:${door.base}`, 'null'])
      expect([origin, await upgrade(door.base, '/api/1.46.0/sync', [['Origin', origin]])]).toEqual([origin, 403])
    // A right origin for another of the door's names is not this request's
    expect(
      await ask(door.base, { path: '/api/1.46.0/sync', upgrade: true, host: `localhost:${door.base}`, headers: [['Upgrade', 'websocket'], own()] }).then(
        (a) => a.status,
      ),
    ).toBe(403)
    expect(api.heads).toEqual([])
    // The command on a machine that joined from elsewhere, and its connector, open it as a program does
    const program = new WebSocket(`ws://127.0.0.1:${door.base}/api/1.46.0/sync`)
    const greeted = await new Promise<string>((resolve) => {
      program.onmessage = (event) => resolve(String(event.data))
      program.onclose = () => resolve('closed')
      setTimeout(() => resolve('nothing'), 10_000)
    })
    expect(greeted).toBe('hello from the backend')
    program.close()
    expect(api.heads.every((head) => !/^origin:/im.test(head))).toBe(true)
    api.heads.length = 0
    // As a browser's own WebSocket meets it: it never opens
    const socket = new WebSocket(`ws://127.0.0.1:${door.base}/api/1.46.0/sync`, { headers: { origin: 'http://evil.example' } } as unknown as string[])
    const how = await new Promise<string>((resolve) => {
      socket.onopen = () => resolve('opened')
      socket.onclose = () => resolve('closed')
      setTimeout(() => resolve('nothing'), 10_000)
    })
    expect(how).toBe('closed')
    expect(api.heads).toEqual([])
  })

  /** A request for one of the backend's own routes, which the door refuses when it is asked for it, written to follow something else on a connection. */
  const smuggled = (port: number) =>
    `POST /api/update_environment_variables HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`

  test('What is not a WebSocket’s first request is refused before the backend is asked, and nothing that follows it reaches the backend', async () => {
    const lone = await backendThat('refuses')
    const other = await open(false, {}, lone.behind)
    try {
      const key = 'dGhlIHNhbXBsZSBub25jZQ=='
      const not: [Parameters<typeof handshake>[1], number, string?][] = [
        // Another version than the one there is, several, none
        [{ version: '12' }, 426],
        [{ version: '13, 12' }, 426],
        [{ version: '8' }, 426],
        [{ version: 'nope' }, 426],
        [{ version: null }, 426],
        [{ more: ['Sec-WebSocket-Version: 13'] }, 426],
        // No key, one that is not sixteen bytes in base64, two
        [{ key: null }, 400],
        [{ key: 'c2hvcnQ=' }, 400],
        [{ key: `${key.slice(0, -2)}AA` }, 400],
        [{ key: 'dGhlIHNhbXBsZSBub25jZQ!=' }, 400],
        [{ more: [`Sec-WebSocket-Key: ${key}`] }, 400],
        // A body, or word of one
        [{ more: ['Content-Length: 0'] }, 400],
        [{ more: ['Content-Length: 5'] }, 400, 'hello'],
        [{ more: ['Transfer-Encoding: chunked'] }, 400, '0\r\n\r\n'],
      ]
      for (const [changed, status, body = ''] of not) {
        const caller = wire(other.base)
        caller.send(handshake(other.base, changed) + body + smuggled(other.base))
        expect([changed, await caller.status()]).toEqual([changed, status])
        await nothingMoreFor(caller)
        caller.end()
        expect([changed, caller.text().includes(' 200 ')]).toEqual([changed, false])
        // Whoever speaks another version is told which one is spoken here
        if (status === 426) expect(caller.text().split('\r\n\r\n')[0]).toMatch(/\r\nsec-websocket-version: 13(\r\n|$)/i)
      }
      // A request that offers a WebSocket and does not ask for the connection to become one is the plain request it also is
      const plain = handshake(other.base).replace('Connection: Upgrade', 'Connection: keep-alive')
      expect(await answered(other.base, plain + smuggled(other.base))).toBe(426)
      // A whole and proper first request with something on its heels: it is refused, or the
      // connection is closed with no answer, and nothing of what followed goes on either way
      const hasty = wire(other.base)
      hasty.send(handshake(other.base) + smuggled(other.base))
      expect([400, 0]).toContain(await hasty.status())
      await nothingMoreFor(hasty)
      hasty.end()
      expect(hasty.text()).not.toContain(' 200 ')
      expect(lone.heard().join('')).not.toMatch(/POST|update_environment_variables/)
      expect(lone.heard().filter((asked) => !asked.startsWith('GET /api/1.46.0/sync HTTP/1.1\r\n'))).toEqual([])
      expect(other.said.join('\n')).toMatch(/door refused a request \(websocket_version\)/)
      expect(other.said.join('\n')).toMatch(/door refused a request \(websocket_key\)/)
      expect(other.said.join('\n')).toMatch(/door refused a request \(handshake_body\)/)
      expect(lone.ended()).toBe(lone.heard().length)
    } finally {
      await other.stop()
      await lone.close()
    }
  })

  test('A WebSocket the backend does not agree to is refused with the door’s own answer, the backend’s connection is closed, and nothing sent after the first request reaches the backend', async () => {
    for (const does of ['refuses', 'agrees to another key', 'never finishes', 'says nothing'] as const) {
      const lone = await backendThat(does)
      const other = await open(false, { patience: 400 }, lone.behind)
      try {
        const began = Date.now()
        const caller = wire(other.base)
        caller.send(handshake(other.base))
        expect([does, await caller.status()]).toEqual([does, 502])
        expect(Date.now() - began).toBeLessThan(4000)
        expect(caller.text()).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/)
        // The same again, with a request for one of the backend's own routes sent after it. It
        // goes on a segment of its own, so that it is not there yet when the first request is
        // read. Where the door is still waiting for the backend when it arrives, the connection
        // may be closed with no answer at all.
        const second = wire(other.base)
        second.send(handshake(other.base))
        // The door has read the first request by the time it has asked the backend for it
        await until(() => lone.heard().length === 2 && lone.heard()[1]!.includes('\r\n\r\n'))
        second.send(smuggled(other.base))
        expect([502, 0]).toContain(await second.status())
        // The backend was sent the door's own request each time and nothing else, and its connections are closed
        await until(() => lone.ended() === 2)
        await nothingMoreFor(second)
        for (const asked of lone.heard()) {
          expect(asked).toMatch(/^GET \/api\/1\.46\.0\/sync HTTP\/1\.1\r\n/)
          expect(asked).not.toMatch(/POST|update_environment_variables|\r\n\r\n./)
        }
        expect(lone.heard()).toHaveLength(2)
        // And neither caller is told anything of what the backend said
        for (const told of [caller, second]) {
          told.end()
          expect(told.text()).not.toMatch(/ 200 | 101 |NotAHandshake|X-More/)
        }
        expect(other.said.slice(1, 2)).toEqual(['door refused a request (backend_no_websocket)'])
      } finally {
        await other.stop()
        await lone.close()
      }
    }
  })

  test('A backend whose agreement to a WebSocket goes on without end is given up on once it has said more than an agreement comes to, long before its time is up', async () => {
    const lone = await backendThat('never finishes')
    // Given far longer than the test waits, so that it is not the time that ends it
    const other = await open(false, { patience: 9000 }, lone.behind)
    try {
      const began = Date.now()
      const caller = wire(other.base)
      caller.send(handshake(other.base))
      expect(await caller.status(8000)).toBe(502)
      expect(Date.now() - began).toBeLessThan(3000)
      await until(() => lone.ended() === 1)
      caller.end()
      expect(other.said.slice(1)).toEqual(['door refused a request (backend_no_websocket)'])
    } finally {
      await other.stop()
      await lone.close()
    }
  }, 15_000)

  test('A WebSocket the backend agrees to is answered in the door’s own words, with nothing else of what the backend said', async () => {
    const lone = await backendThat('agrees')
    const other = await open(false, {}, lone.behind)
    try {
      const caller = wire(other.base)
      caller.send(handshake(other.base))
      expect(await caller.status()).toBe(101)
      await until(() => caller.text().includes('hello from the backend'))
      const head = caller.text().split('\r\n\r\n')[0]!
      expect(head).toMatch(/\r\nsec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=(\r\n|$)/i)
      expect(head).not.toMatch(/cookie|access-control/i)
      // And from then on what the caller sends is the backend's
      caller.send(framed(Buffer.from('to the backend'), 1, true))
      await until(() => lone.took() === 14)
      caller.end()
      expect(lone.heard()).toHaveLength(1)
    } finally {
      await other.stop()
      await lone.close()
    }
  })

  test('What a caller goes on sending while the backend takes nothing is not kept without end: the door stops taking it, or closes both ends', async () => {
    const lone = await backendThat('agrees and takes nothing')
    const other = await open(false, {}, lone.behind)
    try {
      const caller = wire(other.base)
      caller.send(handshake(other.base))
      expect(await caller.status()).toBe(101)
      // Eighty messages of a megabyte each, each sent once the one before it has gone
      const message = framed(Buffer.alloc(1024 * 1024, 65), 2, true)
      const most = 80
      let [sent, went] = [0, 0]
      /** What the door closed the WebSocket with, once it has. */
      const closing = () => unframed(caller.got().subarray(caller.got().indexOf('\r\n\r\n') + 4)).frames.find((frame) => frame.op === 8)
      /** Sends until the door closes the connection or a message does not go, and answers whether it was the second. */
      const goOn = async (): Promise<boolean> => {
        while (sent < most && !closing() && !caller.closed()) {
          sent += 1
          const gone = new Promise<boolean>((resolve) =>
            caller.socket.write(message, () => {
              went += 1
              resolve(true)
            }),
          )
          // One that does not go is still waiting to, and nothing more is sent behind it meanwhile
          if (!(await Promise.race([gone, pause(1500).then(() => false)]))) return true
        }
        return false
      }
      // Where every message went, the door was taking them as messages, and has by now been sent
      // more than it lets wait: its closing of the connection is waited for, and not a moment
      if (!(await goOn())) await until(() => Boolean(closing()) || caller.closed(), 20_000)
      expect(lone.took()).toBe(0)
      if (closing() || caller.closed()) {
        // Where the door passes messages on, it has closed both ends, the caller's with a word to come back later
        expect(closing()?.body.readUInt16BE(0)).toBe(1013)
        expect(sent).toBeLessThan(most)
        // The backend finds its own end closed when it next reads or writes, with less than was sent
        lone.take()
        await until(() => lone.ended() > 0, 20_000).catch(() => {})
        expect([lone.ended(), lone.took() < sent * 1024 * 1024]).toEqual([1, true])
        expect(other.said.slice(1)).toEqual(['door refused a request (backend_slow)'])
      } else {
        // Where it passes bytes on, it has stopped taking them: what went is no more than the
        // system itself holds on the way, and the rest goes when the backend takes again
        expect(went).toBeLessThan(most / 2)
        lone.take()
        await goOn()
        await until(() => went === most && lone.took() === most * 1024 * 1024, 20_000)
        expect(other.said).toHaveLength(1)
      }
      caller.end()
    } finally {
      await other.stop()
      await lone.close()
    }
  }, 60_000)

  test('What a caller sends is passed on whole for as long as the backend takes it, however much it comes to', async () => {
    const lone = await backendThat('agrees')
    const other = await open(false, {}, lone.behind)
    try {
      const caller = wire(other.base)
      caller.send(handshake(other.base))
      expect(await caller.status()).toBe(101)
      // More in all than may ever be waiting at once, each message sent once the backend has
      // taken the one before it: a caller that sent them faster than this backend takes them
      // would be one whose backend does not take them, which is the test above
      const each = 4 * 1024 * 1024
      const message = framed(Buffer.alloc(each, 66), 2, true)
      for (let n = 1; n <= 24; n++) {
        caller.socket.write(message)
        await until(() => lone.took() === n * each || caller.closed(), 20_000)
        expect([n, caller.closed()]).toEqual([n, false])
      }
      // And then one message as long as a message may be, for which nothing else may be
      // waiting. Where the door counts what the backend has yet to say it has taken, it has
      // heard by now that all of it was: the backend said so, and what it said after that has
      // reached the caller, which it does only behind the answer.
      if (underBun) await until(() => lone.answered() === 24 * each, 20_000)
      lone.say('all of it taken')
      await until(() => caller.text().includes('all of it taken') || caller.closed())
      caller.socket.write(framed(Buffer.alloc(64 * 1024 * 1024, 67), 2, true))
      await until(() => lone.took() === 24 * each + 64 * 1024 * 1024 || caller.closed(), 20_000)
      expect(caller.closed()).toBe(false)
      expect(other.said).toHaveLength(1)
      caller.end()
    } finally {
      await other.stop()
      await lone.close()
    }
  }, 60_000)

  test('A backend that does not answer is said as that, and not as a fault of whoever asked', async () => {
    const lonely = await open(false, {}, { ...backend, site: 'http://127.0.0.1:9' })
    try {
      const answer = await ask(lonely.base, { path: '/health' })
      expect([answer.status, answer.body]).toEqual([502, '{"error":"backend_unreachable"}'])
    } finally {
      await lonely.stop()
    }
  })
})

// ---------- the door as a program of its own ----------
//
// A runtime decides when it starts whether its requests go through a proxy, and a browser has
// to be shown the door as each runtime opens it. So the door is also opened in a program of its
// own, under each runtime there is on this machine, with the content package and the notifier
// it makes for itself and the stand-ins above behind it.

const here = path.dirname(fileURLToPath(import.meta.url))
const onPath = (name: string) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, process.platform === 'win32' ? `${name}.exe` : name))
    .find((file) => existsSync(file))
const underBun = 'Bun' in globalThis
const node = underBun ? onPath('node') : process.execPath
const bun = underBun ? process.execPath : onPath('bun')
// A test that opens the door under a runtime is left out where this machine has not got that
// runtime, and the tests that drive a browser are left out under Bun: a line says so each time
if (!bun) console.log('  skip  the tests that open the door under Bun: there is no `bun` on the PATH of this machine')
if (!node) console.log('  skip  the tests that open the door under Node: there is no `node` on the PATH of this machine')
if (underBun) console.log('  skip  the tests of a page shown in a browser: Playwright, which drives the browsers, does not run under Bun')

let scratch = ''
let built: Promise<string> | null = null
/** The program, built the first time it is asked for. It is given the backend's two addresses, and a file of the site's files when the site is not to be empty. */
function doorProgram(): Promise<string> {
  built ??= (async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'it-door-program-'))
    const program = path.join(scratch, 'door.mjs')
    // Before the door, one request by the runtime's own `fetch`, which shows whether a proxy is in force
    const contents = `
      import { readFileSync } from 'node:fs'
      import { startDoor } from ${JSON.stringify(path.join(here, 'src/serve/door'))}
      const [site, api, files] = process.argv.slice(2)
      const plain = await fetch(site + '/plain').then((r) => r.status, () => 'failed')
      const backend = { api, site, adminKey: 'x', stop: async () => {} }
      const parts = { site: files ? JSON.parse(readFileSync(files, 'utf8')) : {} }
      for (let tries = 0; ; tries++) {
        const base = 20000 + Math.floor(Math.random() * 9000)
        try {
          const door = await startDoor({ port: base, network: false, instanceSecret: 'x', adminKey: 'x', sessionSecret: 'x' }, backend, () => {}, parts)
          const stop = () => void door.stop().then(() => process.exit(0), () => process.exit(1))
          process.on('SIGTERM', stop)
          // Whoever started it holds the other end of this. When they are gone, however they went, so is the door
          process.stdin.on('end', stop).on('close', stop).resume()
          process.stdout.write(JSON.stringify({ plain, base }) + '\\n')
          break
        } catch (err) {
          if (err?.code !== 'port_taken' || tries > 20) throw err
        }
      }
    `
    await build({
      stdin: { contents, resolveDir: here, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: program,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
    return program
  })()
  return built
}
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/** Starts the program under a runtime, in a folder of its own, and waits for its door to be open. */
async function program(runtime: string, env: Record<string, string>, behind: { site: string; api: string }, files?: Site) {
  const file = await doorProgram()
  const home = mkdtempSync(path.join(scratch, 'home-'))
  const given = [behind.site, behind.api]
  if (files) {
    writeFileSync(path.join(home, 'site.json'), JSON.stringify(files))
    given.push(path.join(home, 'site.json'))
  }
  const child = spawn(runtime, [file, ...given], { env: { PATH: process.env.PATH ?? '', IT_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const stop = async () => {
    child.kill('SIGTERM')
    await Promise.race([exited, pause(10_000).then(() => child.kill('SIGKILL'))])
  }
  let [out, err] = ['', '']
  child.stdout.on('data', (piece: Buffer) => {
    out += piece.toString('utf8')
  })
  child.stderr.on('data', (piece: Buffer) => {
    err += piece.toString('utf8')
  })
  try {
    await Promise.race([until(() => out.includes('\n'), 30_000), exited.then(() => Promise.reject(new Error(`the door did not open: ${err.slice(-2000)}`)))])
  } catch (failed) {
    await stop()
    throw failed
  }
  return { ...(JSON.parse(out) as { plain: number | string; base: number }), stop }
}

describe('With a proxy named in the environment', () => {
  /** A token that is written as the backend writes one, and signed by nobody: enough to send whoever checks it for the backend's keys. */
  const unsigned = ['{"alg":"ES256","kid":"k"}', '{"sub":"key"}', 'not a signature'].map((part) => Buffer.from(part).toString('base64url')).join('.')

  /**
   * Opens the door under a runtime with a proxy named in every variable either runtime reads,
   * asks it for everything that makes it ask the backend, and gives what the proxy was asked
   * and what the backend was. The proxy passes nothing on, and writes down the first line of
   * whatever it is asked.
   */
  async function behindProxy(runtime: string, env: Record<string, string>) {
    const proxied: string[] = []
    const proxy = net.createServer((socket) => {
      socket.on('error', () => {})
      let got = ''
      socket.on('data', (piece: Buffer) => {
        const fresh = !got.includes('\r\n')
        got += piece.toString('latin1')
        if (!fresh || !got.includes('\r\n')) return
        proxied.push(got.split('\r\n')[0]!)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const through = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
    const named = { HTTP_PROXY: through, http_proxy: through, HTTPS_PROXY: through, https_proxy: through, ALL_PROXY: through, all_proxy: through }
    const opened = await program(runtime, { ...named, NO_PROXY: '', no_proxy: '', ...env }, backend).catch(async (failed) => {
      await new Promise<void>((resolve) => void proxy.close(() => resolve()))
      throw failed
    })
    try {
      const { plain, base } = opened
      const json: [string, string] = ['Content-Type', 'application/json']
      const answers = {
        // A route passed on, and one with the browser's cookie beside the door's own key
        health: (await ask(base, { path: '/health' })).status,
        token: (await ask(base, { method: 'POST', path: '/session/token', headers: [own(base), ['Cookie', 'it_session_k17a=s3cret']] })).status,
        // A call of a function, with the caller's token
        call: (await ask(base, { method: 'POST', path: '/api/query', headers: [json, ['Authorization', 'Bearer its.token']], body: '{}' })).status,
        // The live connection
        live: await answered(base, handshake(base)),
        // And the backend's public keys, which the content package and the notifier each read when they are shown something signed
        ticket: (await ask(base + 1, { path: `/open/${unsigned}` })).status,
        push: (await ask(base, { path: '/internal/push/key', headers: [['Authorization', `Bearer ${unsigned}`]] })).status,
      }
      return {
        plain,
        answers,
        proxied,
        asked: site.asked.map((asked) => asked.path),
        key: site.asked.find((asked) => asked.path === '/health')?.headers['x-it-door'],
        expected: doorKey(config(base)),
        calls: api.calls.map((call) => [call.path, call.headers.authorization]),
        lives: api.heads.length,
      }
    } finally {
      await opened.stop()
      await new Promise<void>((resolve) => void proxy.close(() => resolve()))
    }
  }
  /** Everything reached the backend itself, the door's key with it, and the proxy was asked for nothing but the one request the runtime's own `fetch` made. */
  const wentToTheBackend = (ran: Awaited<ReturnType<typeof behindProxy>>, plain: string[]) => {
    // The keys the stand-in gives are no keys, which is answered as the backend's trouble: what is held here is where they were asked for
    expect(ran.answers).toEqual({ health: 200, token: 401, call: 200, live: 101, ticket: 503, push: 503 })
    expect(ran.asked.filter((asked) => asked !== '/plain')).toEqual(['/health', '/session/token', '/.well-known/jwks.json', '/.well-known/jwks.json'])
    expect(ran.key).toBe(ran.expected)
    expect(ran.calls).toEqual([['/api/query', 'Bearer its.token']])
    expect(ran.lives).toBe(1)
    expect(ran.proxied.length).toBe(plain.length)
  }

  test.skipIf(!bun)(
    'Under Bun, which sends its own `fetch` through the proxy, everything the door asks of the backend goes to the backend itself: what it passes on, a call of a function, the live connection, and the backend’s public keys',
    async () => {
      const ran = await behindProxy(bun!, {})
      expect(ran.proxied[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/plain HTTP\/1\.1$/)
      wentToTheBackend(ran, ['/plain'])
    },
    90_000,
  )

  test.skipIf(!node)(
    'Under Node told to use the environment’s proxy, which sends its own `fetch` through it, everything the door asks of the backend goes to the backend itself',
    async () => {
      const ran = await behindProxy(node!, { NODE_USE_ENV_PROXY: '1' })
      expect(ran.proxied[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1$/)
      wentToTheBackend(ran, ['/plain'])
    },
    90_000,
  )

  test.skipIf(!node)(
    'Under Node as it is by default, nothing is sent to the proxy at all',
    async () => {
      const ran = await behindProxy(node!, {})
      expect([ran.plain, ran.proxied]).toEqual([200, []])
      wentToTheBackend(ran, [])
    },
    90_000,
  )
})

describe('What the door will wait for', () => {
  test('A body longer than the door allows is refused, whether or not it says how long it is', async () => {
    const long = 'x'.repeat(70_000)
    expect((await ask(door.base, { method: 'POST', path: '/bridge/token', body: long })).status).toBe(413)
    expect((await ask(door.base, { method: 'POST', path: '/bridge/token', body: long, chunked: true })).status).toBe(413)
    expect((await ask(door.base, { method: 'POST', path: '/session/redeem', headers: [own()], body: long })).status).toBe(413)
    expect((await ask(door.base + 1, { method: 'POST', path: '/open/t', host: `127.0.0.1:${door.base + 1}`, body: long })).status).toBe(413)
    expect((await ask(door.base, { method: 'POST', path: '/control/stage', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
    // An upload says how long it is, and is not longer than a file may be
    expect((await ask(door.base, { method: 'PUT', path: '/upload/a.bin', body: 'abc', chunked: true })).status).toBe(411)
    expect((await ask(door.base, { method: 'PUT', path: '/upload/a.bin', length: LIMITS.fileBytes + 1 })).status).toBe(413)
    expect(site.asked).toEqual([])
    expect(content.asked).toEqual([])
  })

  test('A request whose headers come to more than the door takes is answered that they do, and is not left without an answer', async () => {
    const cookies = (length: number): [string, string] => ['Cookie', `it_session_k17a=s3cret; another=${'c'.repeat(length)}`]
    // What a browser sends with a cookie or two of some other program's on this machine is well within it
    expect((await ask(door.base, { headers: [cookies(12_000)] })).status).toBe(200)
    for (const length of [20_000, 70_000]) {
      const answer = await ask(door.base, { headers: [cookies(length)] })
      expect([length, answer.status]).toEqual([length, 431])
      // Where it is the door that answers, and not what reads requests for it, it says why by its fixed word
      expect(['', '{"error":"headers_too_large"}']).toContain(answer.body)
    }
    expect((await ask(door.base, { method: 'POST', path: '/session/token', headers: [own(), cookies(20_000)], body: '{}' })).status).toBe(431)
    expect(await answered(door.base, handshake(door.base, { more: [`Cookie: ${cookies(20_000)[1]}`] }))).toBe(431)
    expect(site.asked).toEqual([])
    expect(api.heads).toEqual([])
    // And the next request is answered as ever
    expect((await ask(door.base)).status).toBe(200)
  })

  test('A request that is answered before its body has arrived keeps its connection only for a moment, whatever its method and whichever port it came to', async () => {
    /** Says a body of ten megabytes, and goes on sending a little of it for as long as the door keeps the connection. */
    const drips = async (port: number, first: string, more: string[] = []) => {
      const caller = wire(port)
      const began = Date.now()
      caller.send(`${[first, `Host: 127.0.0.1:${port}`, ...more, 'Content-Length: 10485760', 'Connection: keep-alive'].join('\r\n')}\r\n\r\n`)
      const sending = setInterval(() => caller.closed() || caller.send(Buffer.alloc(1024, 65)), 100)
      try {
        await until(() => caller.closed(), 12_000)
        return { status: await caller.status(), seconds: Math.round((Date.now() - began) / 1000) }
      } finally {
        clearInterval(sending)
        caller.end()
      }
    }
    const foreign = ['Origin: http://foreign.invalid']
    const pages = door.base + 1
    const tried: [string, number, string, string[], number[]][] = [
      // Refused before any of it is read, by each method
      ['a pairing from another site', door.base, 'POST /session/redeem HTTP/1.1', foreign, [403]],
      ['a pairing that is a read', door.base, 'GET /session/redeem HTTP/1.1', foreign, [405]],
      ['a pairing that asks only for headers', door.base, 'HEAD /session/redeem HTTP/1.1', foreign, [405]],
      ['a pairing that asks whether it may', door.base, 'OPTIONS /session/redeem HTTP/1.1', foreign, [405]],
      ['a machine’s route from another site', door.base, 'POST /bridge/enroll HTTP/1.1', foreign, [403]],
      ['a path the door does not pass on', door.base, 'DELETE /api/deploy2/start_push HTTP/1.1', [], [404]],
      ['a call that is not JSON', door.base, 'POST /api/mutation HTTP/1.1', ['Content-Type: text/plain'], [415]],
      ['an upload by another method', door.base, 'POST /upload/a.bin HTTP/1.1', [], [405]],
      // Answered in full, with a body nobody asked for behind it
      ['a file of the site', door.base, 'GET /LICENSE.md HTTP/1.1', [], [200]],
      ['the headers of a file of the site', door.base, 'HEAD /LICENSE.md HTTP/1.1', [], [200]],
      // A WebSocket's first request carries no body. Where it is refused before the door sees it, nothing is said
      [
        'a WebSocket with a body',
        door.base,
        'GET /api/1.46.0/sync HTTP/1.1',
        ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13'],
        [400, 0],
      ],
      // And on the pages' port, where more than a little is more than is taken
      ['a page’s file', pages, 'GET /s/a-token/v/1/index.html HTTP/1.1', [], [200]],
      ['the headers of a page’s file', pages, 'HEAD /s/a-token/v/1/index.html HTTP/1.1', [], [200]],
      ['whether a page may read', pages, 'OPTIONS /s/a-token/v/1/index.html HTTP/1.1', [], [413]],
      ['something sent to a page’s address', pages, 'POST /s/a-token/v/1/index.html HTTP/1.1', [], [413]],
      ['a request to another name', pages, 'DELETE /open/t HTTP/1.1', ['Host: evil.example'], [421, 400, 0]],
    ]
    const went = await Promise.all(tried.map(([, port, first, more]) => drips(port, first, more)))
    for (const [n, [kind, , , , may]] of tried.entries()) {
      expect([kind, went[n]!.status, may.includes(went[n]!.status)]).toEqual([kind, went[n]!.status, true])
      // Two seconds where the door closes the connection itself, and a few more where it can only ask for that
      expect([kind, went[n]!.seconds <= 9]).toEqual([kind, true])
    }
    expect(site.asked).toEqual([])
    expect(api.calls).toEqual([])
    // A request that had all arrived keeps its connection, and the next one on it is answered:
    // one with a body where the door takes bodies, and one that carries none where pages are shown
    for (const [port, first, next] of [
      [door.base, 'POST /bridge/token HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}', 'GET /LICENSE.md HTTP/1.1\r\n\r\n'],
      [pages, 'GET /open/t HTTP/1.1\r\n\r\n', 'GET /s/a-token/v/1/index.html HTTP/1.1\r\n\r\n'],
    ] as const) {
      const caller = wire(port)
      const named = (request: string) => request.replace('\r\n', `\r\nHost: 127.0.0.1:${port}\r\n`)
      caller.send(named(first))
      await until(() => /^HTTP\/1\.1 200 /.test(caller.text()))
      // Another caller is answered meanwhile: whatever the door does to a connection once it has answered on it, it has done by then
      expect((await ask(door.base)).status).toBe(200)
      caller.send(named(next))
      await until(() => caller.closed() || (caller.text().match(/HTTP\/1\.1 200 /g) ?? []).length === 2)
      expect([port, caller.closed()]).toEqual([port, false])
      caller.end()
    }
  }, 30_000)

  test('A caller that asked for its connection to be closed after the answer, and is refused before what it sends has all arrived, is not reset in the middle of sending: all of it is taken, the answer is there whole, and the connection is then ended', async () => {
    const pages = door.base + 1
    // More than a connection holds by itself, so that most of it is still on its way when the door has answered
    const body = Buffer.alloc(4 * 1024 * 1024 + 1, 120)
    for (const [kind, port, first, status] of [
      ['a call longer than a call may be', door.base, 'POST /api/mutation HTTP/1.1\r\nContent-Type: application/json', 413],
      ['something sent to a page’s address', pages, 'POST /s/a-token/v/1/index.html HTTP/1.1', 413],
      ['a pairing from another site', door.base, 'POST /session/redeem HTTP/1.1\r\nOrigin: http://foreign.invalid', 403],
    ] as const) {
      const caller = wire(port)
      const errors: unknown[] = []
      let ended = false
      caller.socket.on('error', (err: NodeJS.ErrnoException) => errors.push(err.code))
      caller.socket.on('end', () => {
        ended = true
      })
      caller.send(`${first}\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`)
      // The whole of it at once, as most callers send: it has gone when the system has taken every byte of it for the door
      const went = await new Promise<unknown>((resolve) =>
        caller.socket.write(body, (err) => resolve((err as NodeJS.ErrnoException | null | undefined)?.code ?? 'all of it')),
      )
      await until(() => ended || caller.closed())
      expect([kind, went, errors, ended]).toEqual([kind, 'all of it', [], true])
      expect([kind, read(caller.got(), false, false)?.status]).toEqual([kind, status])
      caller.end()
    }
    expect(api.calls).toEqual([])
  }, 30_000)

  test('A caller that is slow to take its answer, or takes none of it, keeps the connection of a request that had not all arrived for no more time than any other', async () => {
    // A backend whose answer is far more than a connection holds by itself, for the site's port to pass on
    const LARGE = 24 * 1024 * 1024
    const generous = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(LARGE, 66))
    })
    await new Promise<void>((resolve) => generous.listen(0, '127.0.0.1', resolve))
    const opened = await open(false, {}, { ...backend, site: `http://127.0.0.1:${(generous.address() as net.AddressInfo).port}` })
    try {
      const before = content.letGo + content.readOut
      /** Says a body of ten megabytes and goes on sending a little of it, while it takes its answer a little at a time or not at all. */
      const slow = async (port: number, asked: string, takes: 'none of it' | 'a little at a time') => {
        const socket = net.connect(port, '127.0.0.1')
        let [closed, got] = [false, 0]
        socket.on('error', () => {})
        socket.on('close', () => {
          closed = true
        })
        if (takes === 'a little at a time')
          socket.on('data', (piece: Buffer) => {
            got += piece.length
            socket.pause()
            setTimeout(() => socket.resume(), 250)
          })
        const began = Date.now()
        socket.write(`GET ${asked} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 10485760\r\nConnection: keep-alive\r\n\r\n`)
        const sending = setInterval(() => closed || socket.write(Buffer.alloc(1024, 65)), 100)
        try {
          await until(() => closed, 15_000)
          return { seconds: (Date.now() - began) / 1000, got }
        } finally {
          clearInterval(sending)
          socket.destroy()
        }
      }
      const tried = [
        ['a page’s file', opened.base + 1, '/large'],
        ['what the backend answered', opened.base, '/health'],
      ] as const
      for (const takes of ['none of it', 'a little at a time'] as const) {
        const went = await Promise.all(tried.map(([, port, asked]) => slow(port, asked, takes)))
        for (const [n, [what]] of tried.entries()) {
          // Two seconds where the door closes the connection itself, and a few more where it can only ask for that
          expect([what, takes, went[n]!.seconds <= 9]).toEqual([what, takes, true])
          // And the caller was not given the whole of it meanwhile
          expect([what, takes, went[n]!.got < LARGE]).toEqual([what, takes, true])
        }
      }
      // What each of the pages' answers was being read from is left open by neither: it was let go of, though
      // nobody was taking the answer, or, where the answer is taken whole before it is sent, read to its end
      await until(() => content.letGo + content.readOut === before + 2)
    } finally {
      await opened.stop()
      generous.closeAllConnections()
      await new Promise((resolve) => generous.close(resolve))
    }
  }, 60_000)

  test('A request whose body stops arriving is given up on', async () => {
    const impatient = await open(false, { patience: 300 })
    try {
      const began = Date.now()
      // It says fifty bytes and sends five
      const answer = await ask(impatient.base, { method: 'POST', path: '/bridge/token', body: 'five!', length: 50 })
      expect(answer.status).toBe(408)
      expect(Date.now() - began).toBeLessThan(8000)
      expect(site.asked).toEqual([])
    } finally {
      await impatient.stop()
    }
  })
})

describe('Pages', () => {
  test('A request on the pages’ port reaches the content package with that port and the caller’s own address', async () => {
    const port = door.base + 1
    const opened = await ask(port, {
      host: `localhost:${port}`,
      path: '/open/a-ticket?x=1',
      headers: [
        ['X-Forwarded-For', '203.0.113.9'],
        ['X-Real-IP', '203.0.113.9'],
      ],
    })
    expect(opened.status).toBe(200)
    expect(opened.headers['x-from']).toBe('content')
    expect(JSON.parse(opened.body)).toMatchObject({
      which: 'showing',
      port,
      address: '127.0.0.1',
      method: 'GET',
      path: '/open/a-ticket?x=1',
      host: `localhost:${port}`,
    })

    // What a page's files are given out by reaches the content package as the browser sent it
    const sent: [string, string][] = [
      ['Origin', 'null'],
      ['Range', 'bytes=0-99'],
      ['Accept', 'video/mp4'],
    ]
    const file = await ask(port, { host: `localhost:${port}`, path: '/s/a-token/v/3/film.mp4', headers: sent })
    expect(JSON.parse(file.body).headers).toMatchObject({
      host: `localhost:${port}`,
      ...Object.fromEntries(sent.map(([name, value]) => [name.toLowerCase(), value])),
    })
    for (const method of ['HEAD', 'OPTIONS']) {
      await ask(port, { method, path: '/s/a-token/v/3/film.mp4' })
      expect(content.asked.at(-1)).toMatchObject({ which: 'showing', port, method, path: '/s/a-token/v/3/film.mp4' })
    }

    if (six) {
      const answer = await ask(port, { to: '::1', host: `[::1]:${port}`, path: '/open/a-ticket' })
      expect(JSON.parse(answer.body)).toMatchObject({ which: 'showing', port, address: '::1' })
    }
    // What is the base port's is not the pages', and the other way round
    expect(JSON.parse((await ask(port, { path: '/health' })).body)).toMatchObject({ which: 'showing', path: '/health' })
    expect(site.asked).toEqual([])
    // No WebSocket is carried from that port: it is refused, or its connection closed with nothing said
    expect([404, 0]).toContain(await answered(port, handshake(port)))
    expect(api.heads).toEqual([])
    // And the door listens for pages on that one port and no other
    await expect(ask(door.base + 2, { path: '/open/a-ticket' })).rejects.toThrow()
  })

  // Left out where a test may not turn the network on: see `mayOpen`
  test.skipIf(!mayOpen)(
    'With the network on, the pages’ port answers a caller of either family, and tells the content package the address the caller has',
    async () => {
      const wide = await open(true)
      try {
        const port = wide.base + 1
        const lan = Object.values(os.networkInterfaces())
          .flat()
          .find((a) => a && !a.internal && a.family === 'IPv4')?.address
        for (const to of ['127.0.0.1', ...(lan ? [lan] : [])]) {
          const answer = await ask(port, { to, host: `${to}:${port}`, path: '/open/a-ticket' })
          expect([to, answer.status]).toEqual([to, 200])
          expect(JSON.parse(answer.body)).toMatchObject({ which: 'showing', port, address: to })
        }
        if (six) {
          const answer = await ask(port, { to: '::1', host: `[::1]:${port}`, path: '/open/a-ticket' })
          expect(JSON.parse(answer.body)).toMatchObject({ which: 'showing', port, address: '::1' })
        }
      } finally {
        await wide.stop()
      }
    },
  )

  test('Every answer from the pages’ port tells the browser that it is a sandboxed document and sets no cookie, whatever made the answer and whatever it said', async () => {
    // A content package that says none of what it should, and everything it never may
    const careless: Content = {
      ...contentStandIn,
      showing: async (request) => {
        const named = new URL(request.url).pathname.slice(1)
        if (named === 'throws') throw new Error('a fault in the content package')
        const status = Number(named)
        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'x-from': 'content' })
        if (named !== '200-and-says-nothing') headers.set('content-security-policy', 'sandbox allow-scripts allow-same-origin allow-top-navigation')
        headers.append('set-cookie', 'it_session=planted; Path=/session')
        headers.append('set-cookie', 'another=1; Path=/')
        if (status === 303) headers.set('location', '/s/a-token/v/1/index.html')
        const bare = request.method === 'HEAD' || [204, 303, 304].includes(status)
        return new Response(bare ? null : '<script>document.cookie = "from=a-page"</script>', { status: status || 200, headers })
      },
    }
    const careful = await open(false, { content: careless })
    try {
      const port = careful.base + 1
      const policy = (site: string) => `sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock; frame-ancestors ${site}`
      const here = policy(`http://localhost:${careful.base}`)
      const to = (path: string, more: Ask = {}): Ask => ({ host: `localhost:${port}`, path, ...more })
      const kinds: Record<string, { ask: Ask; status: number; policy?: string }> = {
        'a file': { ask: to('/200'), status: 200 },
        'a file whose answer names no policy': { ask: to('/200-and-says-nothing'), status: 200 },
        'only the headers of a file': { ask: to('/200', { method: 'HEAD' }), status: 200 },
        'a part of a file': { ask: to('/206'), status: 206 },
        'the way on from a ticket': { ask: to('/303'), status: 303 },
        'a showing kept': { ask: to('/204'), status: 204 },
        'whether a page may read': { ask: to('/204', { method: 'OPTIONS' }), status: 204 },
        'a refused token': { ask: to('/401'), status: 401 },
        'a missing file': { ask: to('/404'), status: 404 },
        'a method that is not reading': { ask: to('/405', { method: 'POST', body: 'x' }), status: 405 },
        'a page slowed down': { ask: to('/429'), status: 429 },
        'a fault the content package answered': { ask: to('/500'), status: 500 },
        'a fault the content package did not answer': { ask: to('/throws'), status: 500 },
        // The door's own answers, which the content package never sees
        'a method the door does not take': { ask: to('/200', { method: 'PROPFIND' }), status: 405 },
        'an address written out in full that names another place': { ask: to(`http://localhost:${careful.base}/200`), status: 400 },
        'a body longer than a page may send': { ask: to('/200', { method: 'POST', body: 'x'.repeat(100_000) }), status: 413 },
        // A name that is not this machine's is answered by nothing that may be framed at all
        'a name that is not this machine’s': { ask: to('/200', { host: `evil.example:${port}` }), status: 421, policy: policy("'none'") },
        'the site’s own name and port': { ask: to('/200', { host: `localhost:${careful.base}` }), status: 421, policy: policy("'none'") },
        'this machine by its address': { ask: to('/200', { host: `127.0.0.1:${port}` }), status: 200, policy: policy(`http://127.0.0.1:${careful.base}`) },
        // A policy cannot name an IPv6 address, so the site reached by one is named as any host on its port
        'this machine by its IPv6 address': { ask: to('/200', { host: `[::1]:${port}` }), status: 200, policy: policy(`http://*:${careful.base}`) },
        'a refusal by its IPv6 address': {
          ask: to('/200', { host: `[0:0:0:0:0:0:0:1]:${port}`, method: 'PROPFIND' }),
          status: 405,
          policy: policy(`http://*:${careful.base}`),
        },
      }
      for (const [kind, expected] of Object.entries(kinds)) {
        const answer = await ask(port, expected.ask)
        const said = answer.headers['content-security-policy'] ?? ''
        expect([kind, answer.status, said]).toEqual([kind, expected.status, expected.policy ?? here])
        for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox'])
          expect([kind, word, said.includes(word)]).toEqual([kind, word, false])
        expect([kind, answer.cookies, 'set-cookie' in answer.headers]).toEqual([kind, [], false])
      }
      // What the content package answered is otherwise as it was
      const file = await ask(port, to('/200'))
      expect([file.headers['x-from'], file.headers['content-type'], file.body]).toEqual([
        'content',
        'text/html; charset=utf-8',
        '<script>document.cookie = "from=a-page"</script>',
      ])
      expect((await ask(port, to('/303'))).headers.location).toBe('/s/a-token/v/1/index.html')
      // The site's port is not the pages': it is given no sandbox, and the cookie signing in sets there is set
      const home = await ask(careful.base, { host: `localhost:${careful.base}` })
      expect([home.status, (home.headers['content-security-policy'] ?? '').includes('sandbox')]).toEqual([200, false])
      const redeemed = await ask(careful.base, { method: 'POST', path: '/session/redeem', headers: [own(careful.base)], body: '{"code":"c"}' })
      expect(redeemed.cookies).toEqual(SET)
    } finally {
      await careful.stop()
    }
  })

  test('Whatever is sent to the pages’ port, down to what is no request at all, an answer from it says that it is a sandboxed document, and where the door cannot say so nothing is answered', async () => {
    const port = door.base + 1
    const host = `Host: 127.0.0.1:${port}\r\n`
    const sandbox = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock; frame-ancestors '
    /** What is sent, and the statuses it may be answered with. A status of 0 is a connection closed with nothing said on it. */
    const sent: Record<string, [string | Buffer, number[]]> = {
      'a plain request': [`GET /missing HTTP/1.1\r\n${host}Connection: close\r\n\r\n`, [200]],
      'a request to another name': [`GET /missing HTTP/1.1\r\nHost: other.invalid:${port}\r\nConnection: close\r\n\r\n`, [421]],
      'a request that names nobody': ['GET / HTTP/1.1\r\nConnection: close\r\n\r\n', [421, 0]],
      'a request of the older kind that names nobody': ['GET / HTTP/1.0\r\n\r\n', [421, 0]],
      'two names': [`GET / HTTP/1.1\r\n${host}Host: evil.example\r\nConnection: close\r\n\r\n`, [421, 0]],
      'a name that cannot be read': ['GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n', [421, 0]],
      'headers longer than are taken, in one header': [`GET / HTTP/1.1\r\n${host}Cookie: x=${'A'.repeat(18_000)}\r\nConnection: close\r\n\r\n`, [431, 0]],
      'headers far longer than are taken': [`GET / HTTP/1.1\r\n${host}X-Large: ${'a'.repeat(70_000)}\r\nConnection: close\r\n\r\n`, [431, 0]],
      'headers longer than are taken, in many': [
        `GET / HTTP/1.1\r\n${host}${Array.from({ length: 2000 }, (_, n) => `X-${n}: ${n}\r\n`).join('')}Connection: close\r\n\r\n`,
        [431, 0],
      ],
      'an expectation the door does not know of': [`POST / HTTP/1.1\r\n${host}Expect: not-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, [200]],
      'an expectation to be told to go on': [`POST / HTTP/1.1\r\n${host}Expect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, [200]],
      'a WebSocket asked for': [handshake(port), [404, 0]],
      'a WebSocket asked for at a page’s own address': [handshake(port, { path: '/s/a-token/v/1/index.html', origin: 'null' }), [404, 0]],
      'a WebSocket asked for by another name': [handshake(port, { host: `evil.example:${port}` }), [421, 0]],
      'a WebSocket asked for with too much': [handshake(port, { more: [`Cookie: x=${'A'.repeat(18_000)}`] }), [431, 0]],
      'another protocol asked for': [`GET / HTTP/1.1\r\n${host}Connection: Upgrade\r\nUpgrade: h2c\r\n\r\n`, [200, 404, 0]],
      'a body far longer than any is taken': [`POST / HTTP/1.1\r\n${host}Content-Length: 1000000000\r\nConnection: close\r\n\r\n`, [413]],
      'a tunnel asked for': [`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n${host}\r\n`, [405, 0]],
      'a method there is none of': [`XXXXX / HTTP/1.1\r\n${host}\r\n`, [405, 0]],
      'a method the door does not take': [`TRACE / HTTP/1.1\r\n${host}Connection: close\r\n\r\n`, [405]],
      'a header that is none': [`GET / HTTP/1.1\r\n${host}Bad Header: x\r\n\r\n`, [0]],
      'a line that is no header': [`GET / HTTP/1.1\r\n${host}no colon here\r\n\r\n`, [0]],
      'two lengths': [`POST / HTTP/1.1\r\n${host}Content-Length: 1\r\nContent-Length: 2\r\n\r\nab`, [200, 0]],
      'a length and no length': [`POST / HTTP/1.1\r\n${host}Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`, [0]],
      'a length that is no number': [`POST / HTTP/1.1\r\n${host}Content-Length: many\r\n\r\n`, [0]],
      'a version there is none of': [`GET / HTTP/9.9\r\n${host}\r\n`, [0]],
      'an address with a space in it': [`GET /a b HTTP/1.1\r\n${host}\r\n`, [0]],
      'what is not a request at all': [Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03, 0x0d, 0x0a, 0x0d, 0x0a]), [0]],
    }
    const seen: Record<string, number> = {}
    for (const [kind, [bytes, may]] of Object.entries(sent)) {
      const answers = await everyAnswer(port, bytes)
      // One answer at the most, and nothing before it: nobody is told to go on from this port
      expect([kind, answers.map((answer) => answer.status), answers.length <= 1]).toEqual([kind, answers.map((answer) => answer.status), true])
      const status = answers[0]?.status ?? 0
      seen[kind] = status
      expect([kind, status, may.includes(status)]).toEqual([kind, status, true])
      for (const answer of answers) {
        const said = answer.headers['content-security-policy'] ?? ''
        expect([kind, said.startsWith(sandbox), /allow-same-origin|allow-top-navigation/.test(said)]).toEqual([kind, true, false])
        expect([kind, 'set-cookie' in answer.headers]).toEqual([kind, false])
      }
    }
    // An answer the door did not make for the request's own name may be framed by nothing
    const overflow = await everyAnswer(port, sent['headers longer than are taken, in one header']![0])
    for (const answer of overflow) expect(answer.headers['content-security-policy']).toBe(`${sandbox}'none'`)
    // The same over IPv6, where the door listens on it
    if (six)
      for (const kind of ['a plain request', 'headers longer than are taken, in one header', 'a WebSocket asked for', 'a header that is none']) {
        const answers = await everyAnswer(port, sent[kind]![0], '::1')
        for (const answer of answers) expect([kind, (answer.headers['content-security-policy'] ?? '').startsWith(sandbox)]).toEqual([kind, true])
        expect([kind, answers.at(-1)?.status ?? 0]).toEqual([kind, seen[kind]])
      }
    // And the port goes on answering as ever
    expect((await ask(port, { path: '/open/t' })).status).toBe(200)
  }, 60_000)

  test('A caller of the pages’ port that waits to be told to go on is never told so: its request is answered as it stands, as a sandboxed document, and none of its body is waited for', async () => {
    const port = door.base + 1
    const sandbox = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock; frame-ancestors '
    for (const [what, method, more] of [
      ['a body it has yet to send', 'POST', 'Content-Length: 13\r\n'],
      ['a body it will send in pieces', 'PUT', 'Transfer-Encoding: chunked\r\n'],
      ['no body at all', 'POST', 'Content-Length: 0\r\n'],
      ['a question of whether it may read', 'OPTIONS', 'Content-Length: 5\r\n'],
      ['a request for a page’s file', 'GET', 'Content-Length: 5\r\n'],
    ] as const) {
      const began = Date.now()
      const caller = wire(port)
      caller.send(`${method} /s/a-token/v/1/index.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: 100-continue\r\n${more}\r\n`)
      // The answer comes at once, with nothing sent after the headers
      expect([what, await caller.status(), Date.now() - began < 1500]).toEqual([what, 200, true])
      // Another caller of the port is answered meanwhile, by the door itself: whatever more the door had to say to this one, it has said by then
      expect((await ask(port, { host: `other.invalid:${port}` })).status).toBe(421)
      caller.end()
      const said = caller.text()
      expect([what, said.startsWith('HTTP/1.1 200 '), said.includes('100 Continue'), (said.match(/HTTP\/1\.1 /g) ?? []).length]).toEqual([what, true, false, 1])
      expect([what, said.toLowerCase().includes(`content-security-policy: ${sandbox}`), /set-cookie/i.test(said)]).toEqual([what, true, false])
    }
    // The content package was asked each time, and was handed no body to read
    expect(content.asked.map((asked) => asked.method)).toEqual(['POST', 'PUT', 'POST', 'OPTIONS', 'GET'])
    // On the site's port such a caller is told to go on, as ever, and what it then sends is read
    const caller = wire(door.base)
    caller.send(
      `POST /bridge/token HTTP/1.1\r\nHost: 127.0.0.1:${door.base}\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
    )
    await until(() => caller.text().includes('100 Continue'))
    caller.send('{}')
    await until(() => caller.closed() || caller.text().includes('backend'))
    caller.end()
    expect(caller.text()).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 /)
  })

  test('What the content package writes down is said where the door says its own lines', async () => {
    const before = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-door-content-'))
    process.env.IT_HOME = folder
    const said: string[] = []
    // The door with the content package it makes for itself, in a folder of its own
    const real = makeDoor(config(door.base), backend, (line) => said.push(line), { site: siteStandIn, push: pushStandIn })
    try {
      const port = door.base + 1
      const refused = await real.answer({
        method: 'GET',
        target: '/open/not.a.ticket',
        headers: new Headers({ host: `localhost:${port}` }),
        body: null,
        port,
        address: '127.0.0.1',
      })
      expect(refused.status).toBe(401)
      expect(said.map((line) => JSON.parse(line))).toEqual([{ event: 'ticket.refused', level: 'warn', reason: 'ERR_JWS_INVALID' }])
    } finally {
      await real.close()
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('Whoever opened the door is told when the backend has had everything of one person’s deleted', async () => {
    const before = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-door-erased-'))
    process.env.IT_HOME = folder
    const { issuer, signed } = await signs()
    const told: string[] = []
    // The door with the content package it makes for itself, which is what is told first
    const real = makeDoor(config(door.base), { ...backend, site: issuer }, () => {}, {
      site: siteStandIn,
      push: pushStandIn,
      erased: (person) => void told.push(person),
    })
    try {
      const asks = async (prefix: string) => {
        const body = JSON.stringify({ prefix })
        const answer = await real.answer({
          method: 'POST',
          target: '/control/delete',
          headers: new Headers({
            host: `127.0.0.1:${door.base}`,
            authorization: `Bearer ${await signed(AUDIENCE.control, 'delete', { h: sha256(body) })}`,
            'content-type': 'application/json',
            'content-length': String(body.length),
          }),
          body: new Response(body).body,
          port: door.base,
          address: '127.0.0.1',
        })
        return answer.status
      }
      expect([await asks('u/someone/page/'), told]).toEqual([200, []])
      expect([await asks('u/someone/'), told]).toEqual([200, ['someone']])
    } finally {
      await real.close()
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('An upload on the base port reaches the content package whole, and only as a PUT', async () => {
    const bytes = Buffer.alloc(300_000, 7)
    const answer = await ask(door.base, {
      method: 'PUT',
      path: '/upload/pictures/a%20b.png',
      headers: [
        ['Authorization', 'Bearer grant'],
        ['x-it-sha256', 'abc'],
      ],
      body: bytes,
    })
    expect(answer.status).toBe(201)
    expect(JSON.parse(answer.body)).toMatchObject({
      which: 'upload',
      port: door.base,
      address: '127.0.0.1',
      method: 'PUT',
      path: '/upload/pictures/a%20b.png',
      bytes: 300_000,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    // What it carried is what the content package reads, its length as it was said included
    expect(JSON.parse(answer.body).headers).toMatchObject({ authorization: 'Bearer grant', 'x-it-sha256': 'abc', 'content-length': '300000' })
    expect(JSON.parse((await ask(door.base, { method: 'PUT', path: '/upload/empty.txt', body: '' })).body)).toMatchObject({ which: 'upload', bytes: 0 })
    content.asked.length = 0
    for (const method of ['GET', 'POST', 'DELETE'])
      expect([method, (await ask(door.base, { method, path: '/upload/a.txt', body: method === 'GET' ? undefined : 'x' })).status]).toEqual([method, 405])
    expect(content.asked).toEqual([])
  })

  test('What the backend asks of the content package is passed on from this machine, and refused to a caller anywhere else', async () => {
    const answer = await ask(door.base, {
      method: 'POST',
      path: '/control/stage',
      headers: [['Authorization', 'Bearer signed']],
      body: '{"prefix":"u/a/b/1/"}',
    })
    expect(answer.status).toBe(201)
    expect(JSON.parse(answer.body)).toMatchObject({
      which: 'control',
      port: door.base,
      address: '127.0.0.1',
      method: 'POST',
      path: '/control/stage',
      bytes: 21,
    })
    expect((await ask(door.base, { path: '/control/stage' })).status).toBe(405)
    content.asked.length = 0

    // The same request as it would arrive from another machine. What it says about itself in a header changes nothing.
    const inner = makeDoor(config(door.base), backend, () => {}, parts())
    const from = (address: string, method: string, pathname: string): Arrival => ({
      method,
      target: pathname,
      headers: new Headers({ host: `127.0.0.1:${door.base}`, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' }),
      body: null,
      port: door.base,
      address,
    })
    for (const address of ['192.168.7.20', '10.0.0.5', '203.0.113.9', 'fe80::1', '2001:db8::7', '', '128.0.0.1', '::ffff:10.0.0.5']) {
      expect([address, (await inner.answer(from(address, 'POST', '/control/stage'))).status]).toEqual([address, 403])
      expect([address, (await inner.answer(from(address, 'POST', '/internal/push'))).status]).toEqual([address, 403])
      expect([address, (await inner.answer(from(address, 'GET', '/internal/push/key'))).status]).toEqual([address, 403])
      // Everything else is for any caller the door answers at all
      expect([address, (await inner.answer(from(address, 'GET', '/'))).status]).toEqual([address, 200])
    }
    for (const address of ['127.0.0.1', '::1', '127.0.0.2'])
      expect([address, (await inner.answer(from(address, 'POST', '/control/stage'))).status]).toEqual([address, 201])
    expect(content.asked.map((asked) => asked.address)).toEqual(['127.0.0.1', '::1', '127.0.0.2'])
    expect(pushStandIn.asked).toEqual([])
  })

  test('When whoever asked goes away part of the way through an answer, what was being sent is let go of', async () => {
    const before = content.letGo
    const socket = net.connect(door.base + 1, '127.0.0.1')
    socket.on('error', () => {})
    socket.on('connect', () => socket.write(`GET /large HTTP/1.1\r\nHost: 127.0.0.1:${door.base + 1}\r\n\r\n`))
    let got = 0
    socket.on('data', (piece: Buffer) => {
      got += piece.length
      if (got > 200_000) socket.destroy()
    })
    await until(() => content.letGo === before + 1)
    expect(got).toBeGreaterThan(200_000)
  })

  test('When whoever asked goes away while the next piece of an answer is still being waited for, what was being sent is let go of then, and not when the piece comes', async () => {
    const before = { letGo: content.letGo, stalled: content.stalled, later: content.later }
    const socket = net.connect(door.base + 1, '127.0.0.1')
    socket.on('error', () => {})
    socket.on('connect', () => socket.write(`GET /stalled HTTP/1.1\r\nHost: 127.0.0.1:${door.base + 1}\r\n\r\n`))
    let got = 0
    socket.on('data', (piece: Buffer) => {
      got += piece.length
    })
    // The first piece has arrived, and the door is waiting for a second that never comes
    await until(() => got > 64 * 1024 && content.stalled === before.stalled + 1)
    expect(content.letGo).toBe(before.letGo)
    socket.destroy()
    await until(() => content.letGo === before.letGo + 1)
    // Nothing more was read from it to find that out
    expect([content.stalled, content.later]).toEqual([before.stalled + 1, before.later])
  })

  test('A notification the backend asks for is handed to the part that sends it, with what was sent', async () => {
    const sent = await ask(door.base, { method: 'POST', path: '/internal/push', headers: [['Authorization', 'Bearer signed']], body: '{"payload":"hello"}' })
    expect([sent.status, sent.body]).toEqual([200, '{"status":201}'])
    expect((await ask(door.base, { path: '/internal/push/key' })).status).toBe(200)
    expect(pushStandIn.asked).toEqual([
      { method: 'POST', path: '/internal/push', address: '127.0.0.1', body: '{"payload":"hello"}' },
      { method: 'GET', path: '/internal/push/key', address: '127.0.0.1', body: '' },
    ])
  })
})

describe('The site', () => {
  const page: [string, string] = ['Accept', 'text/html,application/xhtml+xml,*/*;q=0.8']

  test('A file of the site is served as what it is, and an address that is one of the site’s pages is answered with index.html', async () => {
    const script = await ask(door.base, { path: '/assets/app-1a2b3c4d.js' })
    expect([script.status, script.headers['content-type'], script.body]).toEqual([200, 'text/javascript; charset=utf-8', 'console.log("the site")'])
    const icon = await ask(door.base, { path: '/icon.svg' })
    expect([icon.status, icon.headers['content-type']]).toEqual([200, 'image/svg+xml'])
    expect((await ask(door.base, { path: '/LICENSE.md' })).body).toBe('The terms.')

    for (const pathname of ['/', '/index.html', '/p/a-page', '/p/report.v2.html', '/machines', '/displays', '/settings', '/pair', '/display']) {
      const answer = await ask(door.base, { path: pathname, headers: [page] })
      expect([pathname, answer.status, answer.headers['content-type']]).toEqual([pathname, 200, 'text/html; charset=utf-8'])
      expect(answer.body).toBe('<!doctype html><title>It</title>')
    }
    const head = await ask(door.base, { method: 'HEAD' })
    expect([head.status, head.headers['content-length'], head.body]).toEqual([200, '32', ''])
  })

  test('What is asked for as a file and is not there is not found, and is never answered with the page', async () => {
    for (const [pathname, headers] of [
      ['/assets/app-00000000.js', [page]],
      ['/assets/', [page]],
      ['/missing.png', [['Accept', 'image/avif,image/webp,*/*']]],
      ['/p/a-page', [['Accept', '*/*']]],
      ['/p/a-page', []],
      ['/%', [page]],
      ['/__proto__', []],
      ['/constructor', []],
    ] as [string, [string, string][]][]) {
      const answer = await ask(door.base, { path: pathname, headers })
      expect([pathname, answer.status, answer.body]).toEqual([pathname, 404, ''])
    }
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect([method, (await ask(door.base, { method, path: '/p/a-page', headers: [page], body: 'x' })).status]).toEqual([method, 405])
  })

  test('index.html is never kept, a file named after what is in it is kept, and the rest is asked about again and sent only when it has changed', async () => {
    for (const pathname of ['/', '/index.html', '/p/a-page'])
      expect((await ask(door.base, { path: pathname, headers: [page] })).headers['cache-control']).toBe('no-store')
    expect((await ask(door.base, { path: '/assets/app-1a2b3c4d.js' })).headers['cache-control']).toBe('public, max-age=31536000, immutable')
    for (const pathname of ['/sw.js', '/icon.svg', '/LICENSE.md']) {
      const first = await ask(door.base, { path: pathname })
      expect([pathname, first.headers['cache-control']]).toEqual([pathname, 'no-cache'])
      expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/)
      const again = await ask(door.base, { path: pathname, headers: [['If-None-Match', first.headers.etag!]] })
      expect([pathname, again.status, again.body]).toEqual([pathname, 304, ''])
      expect((await ask(door.base, { path: pathname, headers: [['If-None-Match', '"another"']] })).status).toBe(200)
    }
    expect((await ask(door.base, { headers: [page] })).headers.etag).toBeUndefined()
  })

  test('Every answer for the site says that nobody may frame it and that a file is only what its type says', async () => {
    for (const [pathname, status] of [
      ['/', 200],
      ['/assets/app-1a2b3c4d.js', 200],
      ['/sw.js', 200],
      ['/missing.png', 404],
    ] as const) {
      const answer = await ask(door.base, { path: pathname })
      expect([pathname, answer.status]).toEqual([pathname, status])
      expect(answer.headers).toMatchObject({
        'x-frame-options': 'DENY',
        'content-security-policy': expect.stringMatching(/; frame-ancestors 'none'$/),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'cross-origin-opener-policy': 'same-origin',
      })
      // The site is reached plainly, so no browser is told to insist on anything else
      expect(answer.headers['strict-transport-security']).toBeUndefined()
    }
  })

  test('Every answer for the site says what the site may load: itself, its own live connection and the pages’ ports of the same machine, by the name it was reached by, and nothing written into a page', async () => {
    /** A policy taken apart: what each kind of thing may come from. */
    const parts = (policy: string) => Object.fromEntries(policy.split('; ').map((part) => [part.split(' ')[0]!, part.split(' ').slice(1)]))
    // A policy cannot name an IPv6 address. Reached by one, the site may frame the pages' port of any host, and its own address covers its live connection
    const six = (name: string) => name.startsWith('[')
    const pages = (name: string, base: number) => [`http://${six(name) ? '*' : name}:${contentPort(base)}`]
    // By the names this machine has for itself, and, where a test may turn the network on, by its host name and its addresses on a network as well
    const wide = await open(mayOpen)
    try {
      const names = ['localhost', '127.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]']
      if (mayOpen) names.push(os.hostname().toLowerCase())
      for (const a of Object.values(os.networkInterfaces()).flat())
        if (mayOpen && a && !a.internal) names.push(a.family === 'IPv6' ? `[${a.address.split('%')[0]}]` : a.address)
      for (const name of names) {
        for (const pathname of ['/', '/displays', '/assets/app-1a2b3c4d.js', '/sw.js', '/missing.png']) {
          const answer = await ask(wide.base, { host: `${name}:${wide.base}`, path: pathname, headers: [['Accept', 'text/html']] })
          expect([name, pathname, parts(answer.headers['content-security-policy']!)]).toEqual([
            name,
            pathname,
            {
              'default-src': ["'self'"],
              'script-src': ["'self'"],
              'style-src': ["'self'"],
              'img-src': ["'self'"],
              // Its own address, and its live connection there, which not every browser takes the first to cover
              'connect-src': six(name) ? ["'self'"] : ["'self'", `ws://${name}:${wide.base}`],
              // A page being shown, on its own port of this same machine by this same name, and nothing else
              'frame-src': pages(name, wide.base),
              'worker-src': ["'self'"],
              'manifest-src': ["'self'"],
              'object-src': ["'none'"],
              'base-uri': ["'none'"],
              'form-action': ["'none'"],
              'frame-ancestors': ["'none'"],
            },
          ])
        }
      }
      // An answer that is no file of the site carries it as well
      expect((await ask(wide.base, { method: 'POST', path: '/' })).headers['content-security-policy']).toContain("default-src 'self'")
    } finally {
      await wide.stop()
    }
    // Nowhere does it let a page's own script or style run, or anything be read as script
    const policy = (await ask(door.base)).headers['content-security-policy']!
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|blob:|https?:\/\/(?!127\.0\.0\.1:)/)
    // Reached on the port a browser leaves out of the name, the site frames the port after it and connects to its own
    const { answerSite } = await import('./src/serve/site')
    const said = (host: string) => parts(answerSite(siteStandIn, 'GET', '/', new Headers({ host })).headers.get('content-security-policy')!)
    for (const [host, frames, connects] of [
      ['localhost', 'http://localhost:81', 'ws://localhost:80'],
      ['localhost:80', 'http://localhost:81', 'ws://localhost:80'],
      ['Kitchen-PC.local', 'http://kitchen-pc.local:81', 'ws://kitchen-pc.local:80'],
      ['192.168.1.20', 'http://192.168.1.20:81', 'ws://192.168.1.20:80'],
      ['[::1]', 'http://*:81', null],
      ['[FD00::12:34]:4700', 'http://*:4701', null],
      // Nor can a policy name a host with an underscore in it, which a machine's own name may have.
      // It names every host under as much of the name's ending as it can say, and any host where it can say none
      ['Living_Room:4700', 'http://*:4701', null],
      ['living_room.local:4700', 'http://*.local:4701', null],
      ['It_Review.localhost', 'http://*.localhost:81', null],
      ['my_tv.kitchen.home.arpa:4700', 'http://*.kitchen.home.arpa:4701', null],
      ['tv.living_room.local:4700', 'http://*.local:4701', null],
      ['tv.living_room:4700', 'http://*:4701', null],
    ] as const)
      expect([host, said(host)['frame-src'], said(host)['connect-src']]).toEqual([host, [frames], connects ? ["'self'", connects] : ["'self'"]])
    // What is no host gives no address to frame or to connect to
    for (const host of ['a b:1', 'x:1 ; script-src *', 'localhost:', ':80', 'localhost:123456', '[::1', 'http://localhost', ''])
      expect([host, said(host)['frame-src'], said(host)['connect-src'], said(host)['script-src']]).toEqual([host, ["'none'"], ["'self'"], ["'self'"]])
  })

  test('The site as it is built has nothing in its page for that to stop: every script and style is a file of its own, from the site itself', async () => {
    const { BUILT } = await import('./src/serve/site')
    const built = BUILT['index.html']
    // A program built before the site was has none to look at. Where `CI` is set the site is
    // built before the tests are run, and its not being there is a failure; anywhere else the
    // test looks at nothing, and a line says so.
    if (!built) {
      expect(process.env.CI ?? '').toBe('')
      console.log('  skip  the test of the site as it is built: it has not been built here, which `npm run generate` does')
      return
    }
    const page = Buffer.from(built.bytes, 'base64').toString('utf8')
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, inside] of scripts) expect([/\bsrc="\/[^/"][^"]*"/.test(attributes!), inside!.trim()]).toEqual([true, ''])
    expect(page).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=|javascript:/i)
    // Whatever it names, it names by a path of the site's own
    for (const [, address] of page.matchAll(/\b(?:src|href)="([^"]*)"/g)) expect([address, /^\/[^/]/.test(address!)]).toEqual([address, true])
    // And nothing in its scripts is made into script from text
    for (const [name, file] of Object.entries(BUILT))
      if (name.endsWith('.js')) expect([name, /\beval\(|new Function\(/.test(Buffer.from(file.bytes, 'base64').toString('utf8'))]).toEqual([name, false])
  })

  test('That a window the site opens can do nothing to it is said where a browser takes it: by this machine’s own name, and not at an address on the network, where a browser would write it down as a fault', async () => {
    // An address on the network is asked by only where a test may turn the network on; this machine's own names are asked by everywhere
    const wide = await open(mayOpen)
    try {
      const names = mayOpen ? [os.hostname()] : []
      for (const a of Object.values(os.networkInterfaces()).flat())
        if (mayOpen && a && !a.internal) names.push(a.family === 'IPv6' ? `[${a.address}]` : a.address)
      for (const name of names) {
        for (const pathname of ['/', '/assets/app-1a2b3c4d.js', '/missing.png']) {
          const answer = await ask(wide.base, { host: `${name}:${wide.base}`, path: pathname })
          expect([name, pathname, answer.headers['cross-origin-opener-policy']]).toEqual([name, pathname, undefined])
          // Everything else it carries, it carries there too
          expect(answer.headers).toMatchObject({
            'x-frame-options': 'DENY',
            'content-security-policy': expect.stringMatching(/; frame-ancestors 'none'$/),
            'x-content-type-options': 'nosniff',
          })
        }
      }
      for (const name of ['localhost', '127.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]', 'LocalHost'])
        expect([name, (await ask(wide.base, { host: `${name}:${wide.base}` })).headers['cross-origin-opener-policy']]).toEqual([name, 'same-origin'])
    } finally {
      await wide.stop()
    }
    // A name that only looks like this machine's own is not one
    const { answerSite } = await import('./src/serve/site')
    for (const host of ['localhost.evil.example:80', '127.0.0.1.evil.example', '10.0.0.20:4700', 'evil.example', ''])
      expect([host, answerSite(siteStandIn, 'GET', '/', new Headers({ host })).headers.get('cross-origin-opener-policy')]).toEqual([host, null])
    // With or without a port in it, which a browser leaves out when it is the one plain http has
    for (const host of ['it.localhost:4700', 'localhost', '127.0.0.1', '[::1]'])
      expect([host, answerSite(siteStandIn, 'GET', '/', new Headers({ host })).headers.get('cross-origin-opener-policy')]).toEqual([host, 'same-origin'])
  })

  test('A program built without its site says so, and still answers everything else', () => {
    const answer = answerSite({}, 'GET', '/', new Headers())
    expect(answer.status).toBe(503)
    expect(answerSite({}, 'GET', '/assets/a.js', new Headers()).status).toBe(404)
  })

  test('The script that packs the site writes each file’s path, type and bytes, and leaves source maps out', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-site-'))
    try {
      const built = path.join(folder, 'dist')
      mkdirSync(path.join(built, 'assets'), { recursive: true })
      const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 254, 13, 10])
      writeFileSync(path.join(built, 'index.html'), '<!doctype html>é')
      writeFileSync(path.join(built, 'assets', 'index-abc123.js'), 'let a = 1')
      writeFileSync(path.join(built, 'assets', 'index-abc123.js.map'), '{}')
      writeFileSync(path.join(built, 'assets', 'index-abc123.css'), 'a{}')
      writeFileSync(path.join(built, 'icon-192.png'), picture)
      writeFileSync(path.join(built, 'manifest.webmanifest'), '{}')
      writeFileSync(path.join(built, 'install.sh'), '#!/bin/sh')
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site.mjs')
      const packed = (from: string): Site => {
        const to = path.join(folder, 'site.generated.ts')
        execFileSync(process.execPath, [script, `--from=${from}`, `--to=${to}`], { stdio: 'pipe' })
        const written = readFileSync(to, 'utf8')
        return JSON.parse(written.slice(written.indexOf(' = ') + 3)) as Site
      }
      const table = packed(built)
      expect(Object.keys(table).sort()).toEqual([
        'assets/index-abc123.css',
        'assets/index-abc123.js',
        'icon-192.png',
        'index.html',
        'install.sh',
        'manifest.webmanifest',
      ])
      expect(Object.fromEntries(Object.entries(table).map(([name, entry]) => [name, entry.type]))).toEqual({
        'assets/index-abc123.css': 'text/css; charset=utf-8',
        'assets/index-abc123.js': 'text/javascript; charset=utf-8',
        'icon-192.png': 'image/png',
        'index.html': 'text/html; charset=utf-8',
        'install.sh': 'text/plain; charset=utf-8',
        'manifest.webmanifest': 'application/manifest+json',
      })
      expect(Buffer.from(table['icon-192.png']!.bytes, 'base64').equals(picture)).toBe(true)
      // And the door serves what was packed, byte for byte
      const served = answerSite(table, 'GET', '/', new Headers())
      expect(served.headers.get('content-length')).toBe(String(Buffer.byteLength('<!doctype html>é')))
      // A site that has not been built packs to nothing, and that is not a failure of the build
      expect(packed(path.join(folder, 'nothing-here'))).toEqual({})
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

// Chromium and Firefox are driven from Node, so these run under Node alone: but the door they
// are shown is opened under each runtime there is, as a program of its own.
describe.skipIf(underBun)('A page shown in a browser', () => {
  /** A page as an agent writes one: it says what it shows, and what its own origin is, as soon as It is there to say it to. */
  const PAGE =
    '<!doctype html><html><head><title>Plan</title></head><body><h1>Shown</h1><script>It.action("seen", { words: document.querySelector("h1").textContent, origin: self.origin })</script></body></html>'
  const PREFIX = 'u/user1/page1/1/'
  /**
   * A site that does what the site does to show a page: it frames the ticket's address on the
   * pages' port of the name it was itself reached by, answers the page's hello with a channel,
   * and opens its live connection. It keeps what the page said, what its policy stopped, and
   * whether the live connection opened.
   */
  const shows: Site = {
    'index.html': file('text/html; charset=utf-8', '<!doctype html><title>It</title><body><script src="/assets/site.js"></script></body>'),
    'assets/site.js': file(
      'text/javascript; charset=utf-8',
      `
      window.heard = []
      window.stopped = []
      window.live = 'waiting'
      addEventListener('securitypolicyviolation', (e) => window.stopped.push(e.effectiveDirective + ' ' + e.blockedURI))
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', ${JSON.stringify(SANDBOX)})
      frame.referrerPolicy = 'no-referrer'
      frame.src = 'http://' + location.hostname + ':' + (Number(location.port) + 1) + '/open/' + location.hash.slice(1)
      let answered = false
      addEventListener('message', (e) => {
        if (e.source !== frame.contentWindow || !e.data || e.data.type !== 'it:hello' || answered) return
        answered = true
        const channel = new MessageChannel()
        channel.port1.onmessage = (m) => window.heard.push(m.data)
        frame.contentWindow.postMessage({ type: 'it:port' }, '*', [channel.port2])
      })
      document.body.append(frame)
      const socket = new WebSocket('ws://' + location.host + '/api/1.46.0/sync')
      socket.onmessage = () => { window.live = 'open' }
      socket.onerror = () => { window.live = 'refused' }
      `,
    ),
  }
  /** Publishes the page through the door, as the backend and a machine do between them. */
  async function publish(base: number): Promise<void> {
    const { signed } = await signs()
    const declared = JSON.stringify({ prefix: PREFIX, files: [{ path: 'index.html', size: Buffer.byteLength(PAGE), sha256: sha256(PAGE) }] })
    const staged = await ask(base, {
      method: 'POST',
      path: '/control/stage',
      headers: [
        ['Authorization', `Bearer ${await signed(AUDIENCE.control, 'stage', { h: sha256(declared) })}`],
        ['Content-Type', 'application/json'],
      ],
      body: declared,
    })
    const uploaded = await ask(base, {
      method: 'PUT',
      path: '/upload/index.html',
      headers: [
        ['Authorization', `Bearer ${await signed(AUDIENCE.upload, PREFIX, { p: PREFIX })}`],
        ['x-it-sha256', sha256(PAGE)],
      ],
      body: PAGE,
    })
    expect([staged.status, uploaded.status]).toEqual([200, 200])
  }
  /** A ticket for one showing of it, which works once. */
  const ticket = async () => {
    const mount = randomBytes(16).toString('hex')
    return (await signs()).signed(AUDIENCE.ticket, mount, { m: mount, a: 'page1', s: 'plan', v: '1', u: 'user1', d: 'display1', e: 0, p: PREFIX })
  }

  type Kind = 'chromium' | 'firefox'
  type Browser = Awaited<ReturnType<typeof import('playwright')[Kind]['launch']>>
  /** Whether Playwright has a browser of a kind on this machine. */
  const has = async (kind: Kind) => existsSync((await import('playwright'))[kind].executablePath())
  /**
   * A wait that ran out. It is the one failure a case is tried again for: a browser on a machine
   * that is busy may be slower than any wait a test can give it. What a case saw, and did not
   * expect, is never this, and is never tried again.
   */
  class Late extends Error {}
  /**
   * Does one thing a case has to wait for. When it is not done in its time, the case fails
   * there and says which thing it was and what was last seen of it, and not that the whole
   * case ran out of time.
   */
  async function stage<T>(what: string, ms: number, work: () => Promise<T>, seen: () => unknown = () => undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const last = seen()
        reject(new Late(`${what} did not happen in ${ms / 1000} seconds${last === undefined ? '' : `. Last seen: ${JSON.stringify(last)}`}`))
      }, ms)
    })
    try {
      return await Promise.race([work(), late])
    } finally {
      clearTimeout(timer)
    }
  }
  /**
   * One browser of each kind for every case that is shown in it. It is started, and has shown
   * an empty page, before any case begins: what a browser does the first time it is run is slow
   * on a machine that is busy, and is no part of what a case waits for.
   */
  const started = new Map<Kind, Promise<Browser>>()
  const browserOf = (kind: Kind): Promise<Browser> => {
    if (!started.has(kind))
      started.set(
        kind,
        (async () => {
          const browser = await (await import('playwright'))[kind].launch({ timeout: 0 })
          await (await browser.newPage()).close()
          return browser
        })(),
      )
    return started.get(kind)!
  }
  /** Closes the browser of a kind, waiting only so long for one that does not answer, so that whatever wants one next starts its own. */
  async function discard(kind: Kind): Promise<void> {
    const browser = started.get(kind)
    started.delete(kind)
    if (!browser) return
    await Promise.race([browser.then((b) => b.close()).catch(() => {}), pause(30_000)])
  }
  beforeAll(async () => {
    const kinds: Kind[] = []
    for (const kind of ['chromium', 'firefox'] as const) if (await has(kind).catch(() => false)) kinds.push(kind)
    // Each is given minutes to start. One that has not started by then is left to the case that wants it, which waits for it by name
    await Promise.race([Promise.allSettled(kinds.map(browserOf)), pause(280_000)])
  }, 300_000)
  afterAll(async () => {
    await Promise.all([...started.keys()].map(discard))
  }, 90_000)
  /** What the site that frames the page has kept: what the page said, what its policy stopped, and whether the live connection opened. */
  interface Seen {
    heard: unknown[]
    stopped: string[]
    live: string
  }

  /**
   * Shows the page in a browser of one kind, through a door opened under one runtime, by each
   * name the site is reached by, and gives what the site kept for each. Every wait in it is a
   * stage of its own. The first load of the site in the browser is given two minutes, and each
   * after it less.
   */
  async function shown(kind: Kind, under: string, runtime: string): Promise<[string, Seen | null][]> {
    const browser = await stage(`${kind} starting`, 200_000, () => browserOf(kind))
    const opened = await stage(`the door opening under ${under}`, 60_000, async () =>
      program(runtime, {}, { site: (await signs()).issuer, api: backend.api }, shows),
    )
    const kept: [string, Seen | null][] = []
    try {
      await stage('the page being published through the door', 30_000, () => publish(opened.base))
      let first = true
      for (const name of ['127.0.0.1', 'localhost', ...(six ? ['[::1]'] : [])]) {
        const patience = first ? 120_000 : 45_000
        first = false
        // A window of its own for each name, with what it wrote down and what it could not fetch kept for whoever reads a failure
        const context = await stage(`a window opening in ${kind}`, 30_000, () => browser.newContext())
        const said: string[] = []
        let last: Seen | null = null
        try {
          const page = await stage(`a tab opening in ${kind}`, 30_000, () => context.newPage())
          page.on('console', (message) => said.push(`${message.type()}: ${message.text().slice(0, 200)}`))
          page.on('pageerror', (error) => said.push(`error: ${String(error).slice(0, 200)}`))
          page.on('requestfailed', (request) =>
            said.push(`not fetched: ${request.method()} ${new URL(request.url()).origin} ${request.failure()?.errorText ?? ''}`),
          )
          const look = async () => {
            last = await page
              .evaluate(() => {
                const w = window as unknown as Partial<Seen>
                return w.heard && w.stopped && w.live ? { heard: w.heard, stopped: w.stopped, live: w.live } : null
              })
              .catch(() => null)
            return last
          }
          await stage(
            `the site loading at ${name}`,
            patience,
            async () => {
              await page.goto(`http://${name}:${opened.base}/#${await ticket()}`, { waitUntil: 'domcontentloaded', timeout: 0 })
            },
            () => said,
          )
          // Waited for by what it is waiting for: the site's own script, then the page in its frame saying what it shows, and the live connection answering
          await stage(
            `the page being heard from and the live connection answering at ${name}`,
            patience,
            async () => {
              for (;;) {
                const seen = await look()
                if (seen && seen.heard.length > 0 && seen.live !== 'waiting') return
                await pause(50)
              }
            },
            () => ({ site: last, said }),
          )
        } finally {
          // A window of a browser that has stopped answering is not waited for: the browser is closed whole when the try is given up
          await Promise.race([context.close().catch(() => {}), pause(15_000)])
        }
        kept.push([name, last])
      }
    } finally {
      await opened.stop()
    }
    return kept
  }

  for (const [under, runtime] of [
    ['Node', node],
    ['Bun', bun],
  ] as const)
    for (const kind of ['chromium', 'firefox'] as const)
      test.skipIf(!runtime)(
        `In ${kind === 'chromium' ? 'Chromium' : 'Firefox'}, with the door opened under ${under}, a page is shown and heard from by whichever name the site was reached, an IPv6 address among them`,
        async ({ skip }) => {
          if (!(await has(kind))) {
            console.log(
              `  skip  the test of a page shown in ${kind === 'chromium' ? 'Chromium' : 'Firefox'} with the door opened under ${under}: Playwright has not that browser installed on this machine`,
            )
            return skip()
          }
          // A try that ran out of time, and only that, is made once more, in a browser of its own: the one it had is closed first
          const kept = await shown(kind, under, runtime!).catch(async (failed) => {
            if (!(failed instanceof Late)) throw failed
            await discard(kind)
            return shown(kind, under, runtime!)
          })
          for (const [name, seen] of kept) {
            // The page ran with It in it, as a document with an origin of its own, and reached the site that framed it
            expect([name, seen?.stopped, seen?.live]).toEqual([name, [], 'open'])
            expect([name, seen?.heard]).toEqual([
              name,
              [
                expect.objectContaining({
                  type: 'it:action',
                  envelope: expect.objectContaining({ name: 'seen', payload: { words: 'Shown', origin: 'null' } }),
                }),
              ],
            ])
          }
        },
        // Longer than every stage of two tries together, so that a stage that stands still is what fails, by its name
        1_500_000,
      )
})

describe('Kept to the tailnet', () => {
  /** What a door answers a caller at an address who asks for the site by a name the machine always answers to. */
  const asked = async (kept: ServiceConfig, address: string, port = door.base) => {
    const answer = await makeDoor(kept, backend, () => {}, parts()).answer({
      method: 'GET',
      target: '/',
      headers: new Headers({ host: `localhost:${port}` }),
      body: null,
      port,
      address,
    } satisfies Arrival)
    return answer.status
  }

  test('The door answers this machine and callers from a tailnet, and no caller from any other network the machine is on', async () => {
    const tailnet = { ...config(door.base, true), tailnet: true }
    for (const here of ['127.0.0.1', '::1']) expect(await asked(tailnet, here), here).not.toBe(421)
    for (const there of ['100.101.42.17', '100.64.0.9', 'fd7a:115c:a1e0::ab12:4843']) expect(await asked(tailnet, there), there).not.toBe(421)
    // The home network, an address of the wider internet, and a private range that is not a tailnet's
    for (const other of ['192.168.1.50', '10.0.0.20', '203.0.113.9', '2001:db8:100:c690::4f1a', 'fd00::51', '100.128.0.1'])
      expect(await asked(tailnet, other), other).toBe(421)
    // The pages' port is held to the same
    expect(await asked(tailnet, '192.168.1.50', contentPort(door.base))).toBe(421)
    expect(await asked(tailnet, '100.101.42.17', contentPort(door.base))).not.toBe(421)
  })

  test('Open to every network, the same callers are answered', async () => {
    const open = config(door.base, true)
    for (const anyone of ['192.168.1.50', '100.101.42.17', '2001:db8:100:c690::4f1a']) expect(await asked(open, anyone), anyone).not.toBe(421)
  })
})

describe('Opening and closing', () => {
  /** Holds a port, as some other program would. */
  const hold = (port: number) =>
    new Promise<net.Server>((resolve, reject) => {
      const holder = net.createServer(() => {})
      holder.once('error', reject).listen(port, '127.0.0.1', () => resolve(holder))
    })
  const refusedAt = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => resolve(true))
    })

  test('A port that is already taken is said plainly, with the port and how to choose another, and nothing is left listening', async () => {
    for (const offset of [0, 1]) {
      // A base whose two ports are free is found by opening a door there and closing it again
      const free = await open()
      await free.stop()
      const holder = await hold(free.base + offset)
      try {
        const failed = await startDoor(config(free.base), backend, () => {}, parts()).then(
          () => null,
          (err: unknown) => err,
        )
        expect(failed).toBeInstanceOf(Problem)
        expect(failed).toMatchObject({ code: 'port_taken' })
        expect((failed as Problem).message).toContain(`Port ${free.base + offset} `)
        expect((failed as Problem).hint).toContain('IT_PORT')
        // What it had opened before it met the taken port is closed again
        for (const port of [free.base, free.base + 1].filter((p) => p !== free.base + offset)) expect([port, await refusedAt(port)]).toEqual([port, true])
      } finally {
        await new Promise((resolve) => holder.close(resolve))
      }
    }
  })

  test('Whoever connects to the door’s look at which addresses this machine has, and holds on, does not keep the door from opening', async () => {
    const close = net.Server.prototype.close
    const holding: net.Socket[] = []
    // The first listener to be closed is that look. Before it is, something connects to it and says nothing more
    net.Server.prototype.close = function (this: net.Server, ...rest: Parameters<net.Server['close']>) {
      net.Server.prototype.close = close
      const at = this.address()
      if (!at || typeof at !== 'object') return close.apply(this, rest)
      const socket = net.connect(at.port, at.address)
      holding.push(socket)
      socket.on('error', () => {})
      // Closed only once the connection has been taken on the other side
      socket.once('connect', () => setTimeout(() => close.apply(this, rest), 100))
      return this
    }
    try {
      const opened = await Promise.race([open(), pause(4000).then(() => null)])
      expect(holding).toHaveLength(1)
      expect(opened).not.toBeNull()
      expect((await ask(opened!.base)).status).toBe(200)
      await opened!.stop()
    } finally {
      net.Server.prototype.close = close
      for (const socket of holding) socket.destroy()
    }
  })

  test('The door says one line when it opens and one when it closes, and a refusal seldom, by its code, and never by anything that was sent', async () => {
    const quiet = await open()
    expect(quiet.said).toEqual([`door open on port ${quiet.base} (the network is off: this machine only)`])
    await ask(quiet.base, { host: `secret-name.example:${quiet.base}`, path: '/secret-path?secret=query', headers: [['X-Secret', 'secret-header']] })
    await ask(quiet.base, { path: '/api/secret-path', headers: [['Authorization', 'Bearer made-up']] })
    await ask(quiet.base, { method: 'POST', path: '/session/secret-path', headers: [['Origin', 'http://secret-origin.example']], body: 'secret-body' })
    expect(quiet.said.slice(1)).toEqual([
      'door refused a request (unknown_host)',
      'door refused a request (api_path)',
      'door refused a request (foreign_origin)',
    ])
    // The same again, as often as anyone likes, says nothing more
    for (let i = 0; i < 5; i++) await ask(quiet.base, { host: `secret-name.example:${quiet.base}` })
    expect(quiet.said).toHaveLength(4)
    await quiet.stop()
    expect(quiet.said.at(-1)).toBe('door closed')
    expect(quiet.said).toHaveLength(5)
    expect(quiet.said.join('\n')).not.toMatch(/secret|made-up/)
    expect(await refusedAt(quiet.base)).toBe(true)
    expect(await refusedAt(quiet.base + 1)).toBe(true)
  })

  test('Closing the door ends the live connections it was carrying, and leaves open a content package it was given', async () => {
    const carrying = await open()
    const before = content.closed
    const socket = new WebSocket(`ws://127.0.0.1:${carrying.base}/api/1.46.0/sync`, {
      headers: { origin: `http://127.0.0.1:${carrying.base}` },
    } as unknown as string[])
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve()
    })
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = () => resolve()
      socket.onerror = () => reject(new Error('the live connection did not open'))
    })
    await carrying.stop()
    await Promise.race([closed, pause(5000).then(() => Promise.reject(new Error('the live connection was left open')))])
    expect(content.closed).toBe(before)
  })

  test('A page that is open stays shown when the door is closed and opened anew with the one content package, which only whoever made it closes', async () => {
    const kept = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-door-reopened-'))
    process.env.IT_HOME = folder
    const { issuer, signed } = await signs()
    const behind = { ...backend, site: issuer }
    // A base whose two ports are free is found by opening a door there and closing it again
    const free = await open()
    await free.stop()
    const base = free.base
    const pages = contentPort(base)
    const PREFIX = 'u/user1/page1/1/'
    const PAGE = '<!doctype html><title>Plan</title><p>Still shown</p>'
    /** How many content packages have this folder open: each keeps what is arriving at it in a folder of its own, until it is closed. */
    const holding = () => readdirSync(path.join(folder, 'content', 'tmp')).length
    const ticket = async () => {
      const mount = randomBytes(16).toString('hex')
      return signed(AUDIENCE.ticket, mount, { m: mount, a: 'page1', s: 'plan', v: '1', u: 'user1', d: 'display1', e: 0, p: PREFIX })
    }
    /** Opens a showing through whatever door is open, and gives the path its files are under. */
    const shown = async () => {
      const opened = await ask(pages, { path: `/open/${await ticket()}` })
      expect(opened.status).toBe(303)
      return opened.headers.location!.replace(/v\/1\/index\.html$/, '')
    }
    const still = async (under: string) => [
      (await ask(pages, { path: `${under}__it/keep` })).status,
      (await ask(pages, { path: `${under}v/1/index.html` })).body,
    ]
    // Made once, by whoever runs the service, and given to each door it opens
    const one = makeContent(config(base), behind, () => {})
    const given = { content: one, site: siteStandIn, push: pushStandIn }
    try {
      const first = await startDoor(config(base), behind, () => {}, given)
      const declared = JSON.stringify({ prefix: PREFIX, files: [{ path: 'index.html', size: Buffer.byteLength(PAGE), sha256: sha256(PAGE) }] })
      const staged = await ask(base, {
        method: 'POST',
        path: '/control/stage',
        headers: [
          ['Authorization', `Bearer ${await signed(AUDIENCE.control, 'stage', { h: sha256(declared) })}`],
          ['Content-Type', 'application/json'],
        ],
        body: declared,
      })
      const uploaded = await ask(base, {
        method: 'PUT',
        path: '/upload/index.html',
        headers: [
          ['Authorization', `Bearer ${await signed(AUDIENCE.upload, PREFIX, { p: PREFIX })}`],
          ['x-it-sha256', sha256(PAGE)],
        ],
        body: PAGE,
      })
      expect([staged.status, uploaded.status]).toEqual([200, 200])
      const under = await shown()
      expect(await still(under)).toEqual([204, PAGE])
      // The door is closed, as it is when the network is turned on or off, and the package it was given is not
      await first.stop()
      expect(holding()).toBe(1)
      const second = await startDoor(config(base), behind, () => {}, given)
      try {
        // The showing that was open answers its keep and its files through the new door, and another can be opened beside it
        expect(await still(under)).toEqual([204, PAGE])
        expect(await still(await shown())).toEqual([204, PAGE])
      } finally {
        await second.stop()
      }
      // A door that is given none makes its own, which knows nothing of that showing, and closes its own
      const alone = await startDoor(config(base), behind, () => {}, { site: siteStandIn, push: pushStandIn })
      expect(holding()).toBe(2)
      expect((await ask(pages, { path: `${under}__it/keep` })).status).toBe(401)
      await alone.stop()
      expect(holding()).toBe(1)
      // The one that was given is still whole, and is closed by whoever made it
      expect((await one.showing(new Request(`http://localhost:${pages}${under}__it/keep`), { port: pages, address: '127.0.0.1' })).status).toBe(204)
    } finally {
      await one.close()
      expect(holding()).toBe(0)
      if (kept === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = kept
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('A caller whose WebSocket was refused and who holds on to the connection does not keep the door from closing', async () => {
    const holding = await open()
    // Each keeps its own end open whatever the door does, and one goes on sending
    const callers = [0, 300_000].map((more) => {
      const caller = { socket: net.connect({ port: holding.base, host: '127.0.0.1', allowHalfOpen: true }), got: '', ended: false, closed: false }
      caller.socket.on('data', (piece: Buffer) => {
        caller.got += piece.toString('latin1')
      })
      caller.socket.on('error', () => {})
      caller.socket.on('end', () => {
        caller.ended = true
      })
      caller.socket.on('close', () => {
        caller.closed = true
      })
      caller.socket.write(handshake(holding.base, { path: '/api/somewhere/else' }) + 'x'.repeat(more))
      return caller
    })
    await until(() => callers.every((caller) => caller.got.startsWith('HTTP/1.1 404 ')))
    // A connection the door has not ended is an ordinary one still, on which it answers
    for (const caller of callers.filter((caller) => !caller.ended && !caller.closed)) {
      caller.socket.write(`GET /LICENSE.md HTTP/1.1\r\nHost: 127.0.0.1:${holding.base}\r\n\r\n`)
      await until(() => caller.ended || caller.closed || caller.got.includes('The terms.'))
    }
    await Promise.race([holding.stop(), pause(4000).then(() => Promise.reject(new Error('the door did not close')))])
    await until(() => callers.every((caller) => caller.closed || caller.ended))
    for (const caller of callers) caller.socket.destroy()
  }, 15_000)
})
