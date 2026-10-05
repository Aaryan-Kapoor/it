// A request to It on a connection of the program's own: what is sent, how the answer is read,
// how a failure is told, and that no proxy named in the environment is ever part of it. The
// last is checked as the program meets it, in a process started with the proxy's variables set,
// under each runtime that is on this machine.
//
// Nothing here depends on which runtime runs it: `bun test ./packages/cli/direct.test.ts` runs
// the same tests as the standalone program would.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ask, bodyOf, direct, headIn, live } from './src/lib'

const here = path.dirname(fileURLToPath(import.meta.url))
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; !what(); await pause(10)) if (Date.now() > end) return false
  return true
}
/** Everything that is ready to run has run, and whatever it set going has got as far as it can without waiting on something outside. */
const turn = () => new Promise((r) => setImmediate(r))
/** What a failed request failed with: its code, its name and its kind, which is all a caller tells failures apart by. */
const failure = (run: Promise<unknown>) =>
  run.then(
    () => ({ code: undefined, name: 'answered', type: false }),
    (err: { code?: unknown; name?: string }) => ({ code: err.code, name: err.name, type: err instanceof TypeError }),
  )

// ---------- something that answers ----------

interface Asked {
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}
/** What a test sends a stand-in to ask whether everything sent before has been read. */
const ALL_READ = 'IS ALL OF IT READ\r\n\r\n'
/**
 * Something that listens and answers by the bytes: it reads one request off each connection and
 * hands it over with the connection itself, so that a test says exactly what is written back,
 * and when the connection ends. It is the same under both runtimes, which a server of the
 * runtime's own is not.
 */
async function listening(answer: (asked: Asked, socket: net.Socket) => void, host = '127.0.0.1') {
  const asked: Asked[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket)).on('error', () => {})
    let got = Buffer.alloc(0)
    let done = false
    socket.on('data', (piece: Buffer) => {
      if (done) return
      got = Buffer.concat([got, piece])
      // A test's own asking whether everything sent before it has been read, which is no request and is answered at once
      if (got.subarray(0, ALL_READ.length).toString('latin1') === ALL_READ) {
        done = true
        socket.end('yes')
        return
      }
      const end = got.indexOf('\r\n\r\n')
      if (end === -1) return
      const [first = '', ...lines] = got.subarray(0, end).toString('latin1').split('\r\n')
      const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]))
      const length = Number(headers['content-length'] ?? 0)
      if (got.length < end + 4 + length) return
      done = true
      const one = { method: first.split(' ')[0]!, path: first.split(' ')[1]!, headers, body: got.subarray(end + 4, end + 4 + length) }
      asked.push(one)
      answer(one, socket)
    })
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, host, resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    asked,
    /** How many connections are open at this moment. */
    open: () => sockets.size,
    /**
     * Whatever was sent here before this was called has been read. It is asked on a connection
     * of its own, in words no request has, and the answer is waited for: connections are taken
     * in the order they came, and what was written on the earlier ones before they were closed
     * is read no later than the pass in which this one is. The answer is read a pass after
     * that, here in the same program, and a turn more is given.
     */
    allRead: async () => {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, host)
        socket.on('error', reject)
        socket.once('data', () => {
          socket.destroy()
          resolve()
        })
        socket.write(ALL_READ)
      })
      await turn()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
/** An answer written whole, with its length said. */
const whole = (socket: net.Socket, status: number, body: string, headers: string[] = []) =>
  socket.end(`HTTP/1.1 ${status} X\r\n${[...headers, `Content-Length: ${Buffer.byteLength(body)}`].join('\r\n')}\r\n\r\n${body}`)

const closing: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const close of closing) await close()
})
/** Starts something that answers, and stops it when the tests are over. */
async function standIn(answer: (asked: Asked, socket: net.Socket) => void, host?: string) {
  const made = await listening(answer, host)
  closing.push(made.close)
  return made
}

// ---------- reading an answer ----------

describe('an answer, read from the bytes that have arrived', () => {
  const bytes = (text: string) => Buffer.from(text, 'latin1')
  /** The answer in the bytes, read as the program reads it once they are all there, with no more of its body kept than `most`. */
  const read = (text: string, method = 'GET', ended = false, most = 1_000_000) => {
    const got = bytes(text)
    const head = headIn(got, method)
    if (!head) return null
    const take = bodyOf(head, most)
    const body = take(got.subarray(head.from)) ?? (ended ? take(null) : null)
    return body ? { status: head.status, type: head.headers.get('content-type'), body: body.toString('latin1') } : null
  }
  /** The body of the same answer when what follows its first lines arrives so many bytes at a time. */
  const readBy = (text: string, step: number) => {
    const got = bytes(text)
    const head = headIn(got, 'GET')!
    const take = bodyOf(head, 1_000_000)
    for (let at = head.from; at < got.length; at += step) {
      const body = take(got.subarray(at, at + step))
      if (body) return body.toString('latin1')
    }
    return null
  }
  const code = (run: () => unknown) => {
    try {
      run()
    } catch (err) {
      return (err as { code?: unknown }).code
    }
    return 'read'
  }

  test('one that says its length is whole when that many bytes have come, and not a byte sooner', () => {
    const text = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}'
    expect(read(text)).toEqual({ status: 200, type: 'application/json', body: '{"ok":true}' })
    for (let cut = 0; cut < text.length; cut++) expect([cut, read(text.slice(0, cut))]).toEqual([cut, null])
    // What comes after it is no part of it
    expect(read(`${text}more`)?.body).toBe('{"ok":true}')
    expect(readBy(`${text}more`, 3)).toBe('{"ok":true}')
  })

  test('one sent in pieces is put together from them, whatever its sender says beside a piece’s length or after the last piece', () => {
    const plain = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n7\r\n, world\r\n0\r\n\r\n'
    expect(read(plain)?.body).toBe('hello, world')
    for (let cut = 0; cut < plain.length; cut++) expect([cut, read(plain.slice(0, cut))]).toEqual([cut, null])
    const more = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\nA;name=value\r\n0123456789\r\n0 ; last\r\nExpires: never\r\nX: y\r\n\r\n'
    expect(read(more)?.body).toBe('0123456789')
    for (let cut = 0; cut < more.length; cut++) expect([cut, read(more.slice(0, cut))]).toEqual([cut, null])
  })

  test('one sent in pieces is the same body however its bytes arrive, a byte at a time or many', () => {
    const text = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n7;x=y\r\n, world\r\n1\r\n!\r\n0\r\nExpires: never\r\n\r\nmore'
    for (const step of [1, 2, 3, 5, 7, 11, 1000]) expect([step, readBy(text, step)]).toEqual([step, 'hello, world!'])
  })

  test('one that says nothing of its length lasts until the connection ends', () => {
    const text = 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nall there is'
    expect(read(text)).toBeNull()
    expect(read(text, 'GET', true)).toEqual({ status: 200, type: 'text/plain', body: 'all there is' })
  })

  test('one with no body is whole with its first lines: an answer to HEAD, and one that says there is nothing or nothing new', () => {
    expect(read('HTTP/1.1 204 No Content\r\n\r\n')).toEqual({ status: 204, type: null, body: '' })
    expect(read('HTTP/1.1 304 Not Modified\r\nContent-Length: 40\r\n\r\n')?.body).toBe('')
    expect(read('HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n', 'HEAD')?.body).toBe('')
    expect(read('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n', 'HEAD')?.body).toBe('')
  })

  test('one that only says to go on is passed over for the answer that follows it', () => {
    expect(read('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok')).toEqual({ status: 201, type: null, body: 'ok' })
    expect(read('HTTP/1.1 100 Continue\r\n\r\n')).toBeNull()
  })

  test('what is not an answer is refused as that, and one cut short by the end of its connection as lost', () => {
    for (const text of [
      'SSH-2.0-OpenSSH_9.6\r\n\r\n',
      'HTTP/2 200\r\n\r\n',
      'HTTP/1.1 OK\r\n\r\n',
      'HTTP/1.1 200 OK\r\nno colon here\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Length: many\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nhello\r\n0\r\n\r\n',
      `HTTP/1.1 200 OK\r\nX: ${'x'.repeat(70_000)}`,
    ])
      expect([text.slice(0, 40), code(() => read(text))]).toEqual([text.slice(0, 40), 'EPROTO'])
    expect(code(() => read('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"ok":', 'GET', true))).toBe('ECONNRESET')
    expect(code(() => read('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel', 'GET', true))).toBe('ECONNRESET')
  })

  test('what is no answer is known for that by how it begins, before its first lines are all there', () => {
    for (const begun of ['S', 'SSH-2.0', 'HTTP ', 'http/1.1 200 OK\r\n', 'HTTP/1.1 200 OK\nContent-Length: 2\n\nok', 'HTTP/1.1 200 OK\r\nX: y\nZ'])
      expect([begun, code(() => read(begun))]).toEqual([begun, 'EPROTO'])
    for (const begun of ['', 'H', 'HTTP/', 'HTTP/1.1 200 OK\r', 'HTTP/1.1 200 OK\r\nX: y\r']) expect([begun, read(begun)]).toEqual([begun, null])
  })

  test('first lines that are not written as an answer’s are refused, and nothing is made of them by guessing', () => {
    for (const lines of [
      // A header is a name, a colon and a value
      'X : spaced',
      ' folded: on',
      'X: one\r\n two',
      ': nameless',
      'X: a\x01b',
      'X: a\x7fb',
      'X: a\rb',
      'X(y): z',
      // A length is one number, said once
      'Content-Length: -1',
      'Content-Length: +2',
      'Content-Length: 0x2',
      'Content-Length: 2\r\nContent-Length: 2',
      'Content-Length: 2\r\nContent-Length: 3',
      'Content-Length: 2, 3',
      // A body is sent in pieces or by its length, and in no other way, and not in both
      'Transfer-Encoding: not-real\r\nContent-Length: 2',
      'Transfer-Encoding: gzip, chunked',
      'Transfer-Encoding: chunked, chunked',
      'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked',
      'Transfer-Encoding: chunked\r\nContent-Length: 2',
      'Transfer-Encoding: identity',
    ])
      expect([lines, code(() => read(`HTTP/1.1 200 OK\r\n${lines}\r\n\r\nok`, 'GET', true))]).toEqual([lines, 'EPROTO'])
    // Nor is the first line anything but a version, a status of three digits and what may be printed after it
    for (const first of [
      'HTTP/1.1 200OK',
      'HTTP/1.1 20 OK',
      'HTTP/1.1 2000 OK',
      'HTTP/1.1 000 OK',
      'HTTP/1.1  200 OK',
      'HTTP/1.1 200 O\x01K',
      'HTTP/1.2 200 OK',
    ])
      expect([first, code(() => read(`${first}\r\nContent-Length: 2\r\n\r\nok`))]).toEqual([first, 'EPROTO'])
    // An answer from before pieces were known cannot be sent in them
    expect(code(() => read('HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n'))).toBe('EPROTO')
    // What is written as it should be is read: a value with a tab in it or with nothing in it, and a status with nothing after it
    expect(read('HTTP/1.1 200\r\nContent-Type:\ttext/plain \r\nX-Empty:\r\nX-Tab: a\tb\r\nContent-Length: 2\r\n\r\nok')).toEqual({
      status: 200,
      type: 'text/plain',
      body: 'ok',
    })
  })

  test('a body in pieces that is not framed as one is refused: a piece that does not end with the end of a line, a length that is not one, a line too long', () => {
    const framed = (body: string) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`
    for (const body of [
      '2\r\nokXX0\r\n\r\n',
      '2\r\nok\n0\r\n\r\n',
      '2\r\nok\r0\r\n\r\n',
      '2\nok\r\n0\r\n\r\n',
      ' 2\r\nok\r\n0\r\n\r\n',
      '+2\r\nok\r\n0\r\n\r\n',
      '0x2\r\nok\r\n0\r\n\r\n',
      '2 2\r\nok\r\n0\r\n\r\n',
      '\r\n2\r\nok\r\n0\r\n\r\n',
      '2;a\x01b\r\nok\r\n0\r\n\r\n',
      '1234567890abc\r\n',
      `2;${'x'.repeat(2000)}`,
      '2\r\nok\r\n0\r\nno colon here\r\n\r\n',
      '2\r\nok\r\n0\r\nX : y\r\n\r\n',
      `2\r\nok\r\n0\r\n${`X: ${'y'.repeat(900)}\r\n`.repeat(80)}`,
    ])
      expect([body.slice(0, 30), code(() => read(framed(body)))]).toEqual([body.slice(0, 30), 'EPROTO'])
    // And the same is refused when it arrives a byte at a time
    expect(code(() => readBy(framed('2\r\nokXX0\r\n\r\n'), 1))).toBe('EPROTO')
    expect(code(() => readBy(framed('2\r\nok\r\n0\r\nno colon here\r\n\r\n'), 1))).toBe('EPROTO')
  })

  test('a body is kept up to the most that was asked for and not a byte beyond, however it is sent, and the first lines are not counted against it', () => {
    const most = 1000
    const long = `X-Long: ${'x'.repeat(20_000)}\r\n`
    const sent = (n: number): Record<string, [text: string, ended: boolean]> => ({
      length: [`HTTP/1.1 200 OK\r\n${long}Content-Length: ${n}\r\n\r\n${'b'.repeat(n)}`, false],
      pieces: [
        `HTTP/1.1 200 OK\r\n${long}Transfer-Encoding: chunked\r\n\r\n${(n - 10).toString(16)}\r\n${'b'.repeat(n - 10)}\r\na\r\n${'b'.repeat(10)}\r\n0\r\n\r\n`,
        false,
      ],
      end: [`HTTP/1.1 200 OK\r\n${long}\r\n${'b'.repeat(n)}`, true],
    })
    for (const [how, [text, ended]] of Object.entries(sent(most))) expect([how, read(text, 'GET', ended, most)?.body.length]).toEqual([how, most])
    for (const [how, [text, ended]] of Object.entries(sent(most + 1))) expect([how, code(() => read(text, 'GET', ended, most))]).toEqual([how, 'EMSGSIZE'])
  })

  test('a body that says beforehand that it is longer than was asked for is refused as soon as it has said so', () => {
    expect(code(() => read('HTTP/1.1 200 OK\r\nContent-Length: 1001\r\n\r\n', 'GET', false, 1000))).toBe('EMSGSIZE')
    expect(code(() => read('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3e9\r\n', 'GET', false, 1000))).toBe('EMSGSIZE')
    expect(code(() => read('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3e8\r\n', 'GET', false, 1000))).toBe('read')
    // A piece that would take a body past it, after pieces that did not
    expect(code(() => read(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3e8\r\n${'b'.repeat(1000)}\r\n1\r\n`, 'GET', false, 1000))).toBe('EMSGSIZE')
    // Where the body is to have no length at all, what it says of one is not held against it
    expect(read('HTTP/1.1 200 OK\r\nContent-Length: 1001\r\n\r\n', 'HEAD', false, 1000)?.body).toBe('')
  })
})

// ---------- sending a request ----------

describe('a request sent on a connection of the program’s own', () => {
  test('a body given whole arrives as it was given, as text and as bytes, with the method, the path and the headers it was sent with', async () => {
    const it = await standIn((_asked, socket) => whole(socket, 200, '{"taken":true}', ['Content-Type: application/json']))
    const answered = await direct(`${it.url}/bridge/token?x=1&y=%20z`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer a-token' },
      body: '{"machine":"m","note":"支付"}',
    })
    expect([answered.status, answered.ok, await answered.json()]).toEqual([200, true, { taken: true }])
    const bytes = randomBytes(70_000)
    expect((await direct(new URL(`${it.url}/upload/a`), { method: 'PUT', headers: [['x-it-sha256', 'abc']], body: bytes })).status).toBe(200)
    expect((await direct(`${it.url}/upload/b`, { method: 'PUT', body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 10) })).status).toBe(200)
    expect(it.asked.map((a) => [a.method, a.path, a.headers.host, a.headers['content-length'], a.headers.connection])).toEqual([
      ['POST', '/bridge/token?x=1&y=%20z', `127.0.0.1:${it.port}`, String(Buffer.byteLength('{"machine":"m","note":"支付"}')), 'close'],
      ['PUT', '/upload/a', `127.0.0.1:${it.port}`, '70000', 'close'],
      ['PUT', '/upload/b', `127.0.0.1:${it.port}`, '10', 'close'],
    ])
    expect(it.asked[0]!.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer a-token' })
    expect(it.asked[0]!.body.toString('utf8')).toBe('{"machine":"m","note":"支付"}')
    expect(it.asked[1]!.headers['x-it-sha256']).toBe('abc')
    expect([it.asked[1]!.body.equals(bytes), it.asked[2]!.body.equals(bytes.subarray(0, 10))]).toEqual([true, true])
    // A request with nothing to send says so where a body would be expected, and says nothing of one where it would not
    await direct(`${it.url}/a`, { method: 'POST' })
    await direct(`${it.url}/b`)
    expect([it.asked[3]!.headers['content-length'], it.asked[4]!.headers['content-length']]).toEqual(['0', undefined])
  })

  test('a body given as a stream is sent as its pieces come, and is never held whole: 25 MiB reach the other end piece by piece', async () => {
    // The other end is a server of the runtime's own, which reads the body as it arrives
    const seen = { bytes: 0, sha256: '' }
    const server = http.createServer((req, res) => {
      const hash = createHash('sha256')
      req
        .on('data', (piece: Buffer) => {
          seen.bytes += piece.length
          hash.update(piece)
        })
        .on('end', () => {
          seen.sha256 = hash.digest('hex')
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closing.push(() => new Promise<void>((r) => void server.close(() => r())))
    const piece = randomBytes(64 * 1024)
    const count = 400
    const sent = createHash('sha256')
    /** How much had reached the other end when the last piece was made. */
    let arrivedBeforeTheLast = 0
    async function* pieces() {
      for (let n = 0; n < count; n++) {
        // The last piece is made only once the other end has most of what came before it
        if (n === count - 1) {
          await until(() => seen.bytes > (count / 2) * piece.length)
          arrivedBeforeTheLast = seen.bytes
        }
        sent.update(piece)
        yield piece
      }
    }
    const answered = await direct(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/upload/big`, {
      method: 'PUT',
      headers: { 'content-length': String(count * piece.length) },
      body: pieces(),
    })
    expect([answered.status, seen.bytes, seen.sha256]).toEqual([200, count * piece.length, sent.digest('hex')])
    expect(arrivedBeforeTheLast).toBeGreaterThan((count / 2) * piece.length)
  }, 60_000)

  test('a stream as a browser’s request gives one is sent the same way', async () => {
    const it = await standIn((_asked, socket) => whole(socket, 200, ''))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first, '))
        controller.enqueue(new TextEncoder().encode('second'))
        controller.close()
      },
    })
    expect((await direct(`${it.url}/upload/c`, { method: 'PUT', headers: { 'content-length': '13' }, body })).status).toBe(200)
    expect(it.asked[0]!.body.toString('utf8')).toBe('first, second')
  })

  test('a stream that is not as long as it said, or says no length, is refused, and the other end is never given a whole request', async () => {
    const it = await standIn((_asked, socket) => whole(socket, 200, ''))
    async function* three() {
      yield Buffer.from('abc')
    }
    for (const said of ['5', '2'])
      expect(await failure(direct(`${it.url}/upload/d`, { method: 'PUT', headers: { 'content-length': said }, body: three() }))).toMatchObject({ type: true })
    expect(await failure(direct(`${it.url}/upload/d`, { method: 'PUT', body: three() }))).toMatchObject({ type: true })
    await it.allRead()
    // The one that said five waited for bytes that never came, and the one that said two was given none of the three
    expect(it.asked).toEqual([])
  })

  test('of a stream longer than it said, not one byte of the piece that takes it past its length is sent', async () => {
    // Everything each connection was sent, by the bytes
    const sent: string[] = []
    let closed = 0
    const server = net.createServer((socket) => {
      const n = sent.push('') - 1
      socket
        .on('error', () => {})
        .on('data', (piece: Buffer) => (sent[n] += piece.toString('latin1')))
        .on('close', () => closed++)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closing.push(() => new Promise<void>((r) => void server.close(() => r())))
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    async function* pieces() {
      yield Buffer.from('ab')
      yield Buffer.from('cde')
      // Whatever makes the pieces may take its time over what comes next, and is not waited for
      await pause(40)
    }
    expect(await failure(direct(`${url}/upload/e`, { method: 'PUT', headers: { 'content-length': '4' }, body: pieces() }))).toMatchObject({ type: true })
    // The connection is closed, so everything that was ever sent on it is here
    expect(await until(() => closed === 1)).toBe(true)
    expect([sent.length, sent[0]!.split('\r\n\r\n')[1]]).toEqual([1, 'ab'])
  })

  test('a request that ends before its body was all sent lets go of what the body came from: a stream is cancelled, and an iterator is told to stop', async () => {
    // It takes what it is sent and answers nothing, or answers at once that it will take no more, or goes away
    const it = await standIn(() => {})
    const early = net.createServer((socket) => {
      socket.on('error', () => {}).once('data', () => socket.end('HTTP/1.1 413 Too Much\r\nContent-Length: 0\r\n\r\n'))
    })
    const gone = net.createServer((socket) => {
      socket.on('error', () => {}).once('data', () => socket.destroy())
    })
    for (const server of [early, gone]) {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      closing.push(() => new Promise<void>((r) => void server.close(() => r())))
    }
    const at = (server: net.Server) => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/upload/f`
    /** A stream that gives eight bytes of the hundred it is to give, and then has a read of it wait for ever. */
    const stream = () => {
      const seen = { cancelled: 0 }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8))
        },
        cancel() {
          seen.cancelled++
        },
      })
      return { body, seen }
    }
    /** The same from something that is read a piece at a time, which is told to stop by its `return`. */
    const iterator = () => {
      const seen = { returned: 0 }
      let given = false
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (given) return new Promise<IteratorResult<Uint8Array>>(() => {})
            given = true
            return Promise.resolve({ done: false, value: new Uint8Array(8) })
          },
          return: async () => {
            seen.returned++
            return { done: true, value: undefined }
          },
        }),
      }
      return { body, seen }
    }
    const headers = { 'content-length': '100' }
    const ends: [how: string, url: string, name: string | undefined, status: number | undefined][] = [
      ['a time limit', `${it.url}/upload/f`, 'TimeoutError', undefined],
      ['an answer that came first', at(early), undefined, 413],
      ['a connection that was lost', at(gone), 'Error', undefined],
    ]
    for (const [how, url, name, status] of ends) {
      const s = stream()
      const ended = await direct(url, { method: 'PUT', headers, body: s.body, signal: AbortSignal.timeout(200) }).then(
        (answered) => ({ status: answered.status }),
        (err: Error) => ({ name: err.name }),
      )
      expect([how, ended]).toEqual([how, status ? { status } : { name }])
      expect([how, await until(() => s.seen.cancelled === 1 && !s.body.locked, 2000), s.seen.cancelled, s.body.locked]).toEqual([how, true, 1, false])
      const i = iterator()
      await direct(url, { method: 'PUT', headers, body: i.body, signal: AbortSignal.timeout(200) }).catch(() => {})
      expect([how, await until(() => i.seen.returned === 1, 2000), i.seen.returned]).toEqual([how, true, 1])
    }
    // A body that was sent to its end is told nothing: it has ended by itself
    const whole100 = iterator()
    let left = 2
    const all: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        ...whole100.body[Symbol.asyncIterator](),
        next: async () => (left-- > 0 ? { done: false, value: new Uint8Array(50) } : { done: true, value: undefined }),
      }),
    }
    const taken = await standIn((_asked, socket) => whole(socket, 200, ''))
    expect((await direct(`${taken.url}/upload/f`, { method: 'PUT', headers, body: all })).status).toBe(200)
    await turn()
    expect(whole100.seen.returned).toBe(0)
    // And a stream that nothing was ever sent from is left as it was given
    const unsent = stream()
    const nothing = await listening(() => {})
    await nothing.close()
    expect(await failure(direct(`${nothing.url}/upload/f`, { method: 'PUT', headers, body: unsent.body }))).toMatchObject({ code: 'ECONNREFUSED' })
    expect([unsent.seen.cancelled, unsent.body.locked]).toEqual([0, false])
  })

  test('a signal that many requests are given is listened to by none of them once each has ended, however it ended', async () => {
    const it = await standIn((asked, socket) => {
      if (asked.path === '/answered') return whole(socket, 200, 'ok')
      if (asked.path === '/lost') return socket.destroy()
      socket.end('SSH-2.0-OpenSSH_9.6\r\n')
    })
    const shared = new AbortController()
    for (let n = 0; n < 30; n++)
      for (const path of ['/answered', '/lost', '/not-it']) await direct(`${it.url}${path}`, { signal: shared.signal }).catch(() => {})
    // One that could not be sent at all, and one to where nothing listens
    await direct(`${it.url}/x`, { signal: shared.signal, headers: { 'transfer-encoding': 'chunked' } }).catch(() => {})
    const gone = await listening(() => {})
    await gone.close()
    await direct(`${gone.url}/x`, { signal: shared.signal }).catch(() => {})
    expect(getEventListeners(shared.signal, 'abort').length).toBe(0)
    expect(await until(() => it.open() === 0)).toBe(true)
  })

  test('an answer is read whole whether it says its length, is sent in pieces, or has no body, and its headers are as `fetch` gives them', async () => {
    const big = 'x'.repeat(300_000)
    const it = await standIn((asked, socket) => {
      if (asked.path === '/length')
        return whole(socket, 200, '{"with":"a length"}', ['Content-Type: application/json', 'Set-Cookie: a=1; Path=/session', 'Set-Cookie: b=2'])
      if (asked.path === '/pieces') {
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n')
        // In pieces that arrive apart, cut where a piece's own length is written
        const chunks = [`${(100_000).toString(16)}\r\n${big.slice(0, 100_000)}\r\n${(200_000).toString(16)}`, `\r\n${big.slice(100_000)}\r\n0\r\n`, '\r\n']
        const next = () => {
          const chunk = chunks.shift()
          if (chunk === undefined) return
          socket.write(chunk)
          setTimeout(next, 20)
        }
        return next()
      }
      if (asked.path === '/none') return socket.end('HTTP/1.1 204 No Content\r\nX-It: nothing\r\n\r\n')
      if (asked.path === '/same') return socket.end('HTTP/1.1 304 Not Modified\r\nETag: "v1"\r\n\r\n')
      if (asked.path === '/refused') return whole(socket, 403, '{"error":"foreign_origin"}', ['Content-Type: application/json'])
      // And one that keeps its connection open once it has answered, as a server may
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nkept')
    })
    const length = await direct(`${it.url}/length`)
    expect([length.status, await length.text()]).toEqual([200, '{"with":"a length"}'])
    expect([length.headers.get('Content-Type'), length.headers.get('content-type'), length.headers.has('x-nothing')]).toEqual([
      'application/json',
      'application/json',
      false,
    ])
    expect(length.headers.getSetCookie()).toEqual(['a=1; Path=/session', 'b=2'])
    const pieces = await direct(`${it.url}/pieces`)
    expect([pieces.status, (await pieces.text()) === big]).toEqual([200, true])
    const none = await direct(`${it.url}/none`)
    expect([none.status, none.headers.get('x-it'), await none.text()]).toEqual([204, 'nothing', ''])
    expect((await direct(`${it.url}/same`)).status).toBe(304)
    expect((await direct(`${it.url}/length`, { method: 'HEAD' })).status).toBe(200)
    const refused = await direct(`${it.url}/refused`)
    expect([refused.status, refused.ok, await refused.json()]).toEqual([403, false, { error: 'foreign_origin' }])
    expect(await (await direct(`${it.url}/kept`)).text()).toBe('kept')
    // Each connection was for one request, and is closed once its answer is whole
    expect(await until(() => it.open() === 0)).toBe(true)
  })

  test('a server of the runtime’s own is answered the same way, whichever way it sends', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/pieces') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('in ')
        return void setTimeout(() => res.end('pieces'), 20)
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '8' }).end('{"ok":1}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closing.push(() => new Promise<void>((r) => void server.close(() => r())))
    const at = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    expect(await (await direct(`${at}/pieces`)).text()).toBe('in pieces')
    expect(await (await direct(`${at}/length`)).json()).toEqual({ ok: 1 })
  })

  test('an answer that points somewhere else is given back as it is, and nothing is sent on to where it names', async () => {
    const elsewhere = await standIn((_asked, socket) => whole(socket, 200, 'reached'))
    const it = await standIn((_asked, socket) => whole(socket, 302, '', [`Location: ${elsewhere.url}/taken`]))
    const answered = await direct(`${it.url}/bridge/token`, { method: 'POST', headers: { authorization: 'Bearer a-token' }, body: '{}' })
    expect([answered.status, answered.headers.get('location')]).toEqual([302, `${elsewhere.url}/taken`])
    await elsewhere.allRead()
    expect(elsewhere.asked).toEqual([])
  })

  test('a time limit that passes and a signal that is aborted both end the request, each with what it was ended with, and close its connection', async () => {
    // It takes the request and never answers
    const it = await standIn(() => {})
    const began = Date.now()
    expect(await failure(direct(`${it.url}/slow`, { signal: AbortSignal.timeout(150) }))).toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - began).toBeLessThan(5000)
    const gaveUp = new AbortController()
    const asked = failure(direct(`${it.url}/slow`, { signal: gaveUp.signal }))
    await until(() => it.asked.length === 2)
    gaveUp.abort()
    expect(await asked).toMatchObject({ name: 'AbortError' })
    // One that was given up on before it began sends nothing
    expect(await failure(direct(`${it.url}/slow`, { signal: gaveUp.signal }))).toMatchObject({ name: 'AbortError' })
    expect(await until(() => it.open() === 0)).toBe(true)
    expect(it.asked.length).toBe(2)
  })

  test('a failure says which it was: nothing listening, a connection lost before the answer was whole, or something that is not It answering', async () => {
    // A port that was listened on a moment ago, and is not now
    const gone = await listening(() => {})
    await gone.close()
    expect(await failure(direct(`${gone.url}/health`))).toMatchObject({ code: 'ECONNREFUSED' })
    const it = await standIn((asked, socket) => {
      if (asked.path === '/nothing') return socket.destroy()
      if (asked.path === '/first-lines') return socket.end('HTTP/1.1 200 OK\r\nContent-Type: applic')
      if (asked.path === '/length') return socket.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{"half":')
      if (asked.path === '/pieces') return socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n')
      socket.end('SSH-2.0-OpenSSH_9.6\r\n')
    })
    for (const lost of ['/nothing', '/first-lines', '/length', '/pieces'])
      expect([lost, await failure(direct(`${it.url}${lost}`))]).toEqual([lost, expect.objectContaining({ code: 'ECONNRESET' })])
    expect(await failure(direct(`${it.url}/not-it`))).toMatchObject({ code: 'EPROTO' })
    // An answer longer than was asked for is given up on, and not read to its end
    const long = await standIn((_asked, socket) => whole(socket, 200, 'x'.repeat(200_000)))
    expect(await failure(ask({ host: '127.0.0.1', port: long.port }, { path: '/long', most: 1000 }))).toMatchObject({ code: 'EMSGSIZE' })
  })

  test('an address under IPv6 is asked at that address, and named to it as it was written', async () => {
    let it: Awaited<ReturnType<typeof standIn>>
    try {
      it = await standIn((_asked, socket) => whole(socket, 200, 'six'), '::1')
    } catch {
      // A machine with no IPv6 has no such address to ask
      return
    }
    expect(await (await direct(`${it.url}/health`)).text()).toBe('six')
    expect([it.url, it.asked[0]!.headers.host]).toEqual([`http://[::1]:${it.port}`, `[::1]:${it.port}`])
  })

  test.skipIf(process.platform === 'win32')('a socket in a folder is asked the same way, and a port by its number', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-direct-'))
    const socket = path.join(folder, 'it.sock')
    const server = net.createServer((s) => {
      s.on('error', () => {}).once('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    })
    await new Promise<void>((r) => server.listen(socket, r))
    try {
      const answered = await ask({ path: socket }, { method: 'POST', path: '/waiting', headers: { 'x-it-token': 'a-token' }, body: '{"id":"w"}' })
      expect([answered.status, answered.body.toString('utf8')]).toEqual([200, 'ok'])
      expect(await failure(ask({ path: path.join(folder, 'none.sock') }, { path: '/health' }))).toMatchObject({ code: 'ENOENT' })
    } finally {
      await new Promise<void>((r) => void server.close(() => r()))
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('what cannot be sent as one request is refused before a connection is made', async () => {
    const it = await standIn((_asked, socket) => whole(socket, 200, ''))
    const to = { host: '127.0.0.1', port: it.port }
    const runs: (() => Promise<unknown>)[] = [
      () => direct(it.url.replace('http:', 'https:')),
      () => direct('ftp://127.0.0.1/x'),
      () => direct(new Request(`${it.url}/x`)),
      () => direct(`${it.url}/x`, { headers: { 'x-it': 'one\r\nx-injected: two' } }),
      () => direct(`${it.url}/x`, { method: 'GET /y HTTP/1.1\r\nx:' }),
      () => direct(`${it.url}/x`, { method: 'POST', body: new URLSearchParams({ a: '1' }) }),
      () => ask(to, { path: '/x y' }),
      () => ask(to, { path: '/x\r\nx-injected: two' }),
      () => ask(to, { path: 'x' }),
      // A header's value is what can be printed, and tabs: nothing that ends a line, no other byte of that kind, and no letter that is more than one byte
      ...['a\nb', 'a\rb', 'a\0b', 'a\x01b', 'a\x1bb', 'a\x7fb', 'aĊb', 'ačb', '支付'].map((value) => () => ask(to, { path: '/x', headers: { 'x-it': value } })),
      () => ask(to, { path: '/x', headers: [['x it', 'a name with a space in it']] }),
      // Where the request ends is not a header's to say
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'transfer-encoding': 'chunked' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'transfer-encoding': 'chunked', 'content-length': '3' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'transfer-encoding': 'identity' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { headers: { upgrade: 'websocket', connection: 'upgrade' } }),
      // And a length that is given is the length of the body, said once
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'content-length': '999' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'content-length': '2' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'content-length': '3, 3' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'content-length': '-3' }, body: 'abc' }),
      () => direct(`${it.url}/x`, { method: 'POST', headers: { 'content-length': '1' } }),
      () => direct(`${it.url}/x`, { headers: { 'content-length': '123' } }),
      () => direct(`${it.url}/x`, { method: 'HEAD', headers: { 'content-length': '123' } }),
    ]
    for (const [n, run] of runs.entries()) expect([n, await failure(Promise.resolve().then(run))]).toEqual([n, expect.objectContaining({ type: true })])
    await it.allRead()
    expect(it.asked).toEqual([])
  })

  test('an address that names a port nothing can be asked at is refused before any connection is opened, and is never taken for the port a plain address means', async () => {
    // Every connection this program asks for, by where it is to. One to the port a plain address
    // means is noted and not opened: whatever listens there on this machine is nothing of this test's
    const opened: unknown[] = []
    const connect = net.connect
    net.connect = ((...given: unknown[]) => {
      opened.push(given[0])
      if ((given[0] as { port?: number }).port === 80) throw new Error('not opened by this test')
      return (connect as (...all: unknown[]) => net.Socket)(...given)
    }) as typeof net.connect
    try {
      const runs: (() => Promise<unknown>)[] = [
        () => direct('http://127.0.0.1:0/check', { headers: { authorization: 'Bearer a-token' } }),
        () => direct('http://[::1]:0/check', { headers: { authorization: 'Bearer a-token' } }),
        () => direct(new URL('http://localhost:0')),
        ...[0, -1, 65536, 1.5, Number.NaN].map((port) => () => ask({ host: '127.0.0.1', port }, { path: '/check' })),
        () => ask({ host: '127.0.0.1', port: '80' as unknown as number }, { path: '/check' }),
      ]
      for (const [n, run] of runs.entries()) expect([n, await failure(Promise.resolve().then(run))]).toEqual([n, expect.objectContaining({ type: true })])
      expect(opened).toEqual([])
      // An address that names no port means the one plain http is asked at, and one that names a port means that port
      const it = await standIn((_asked, socket) => whole(socket, 200, 'ok'))
      await direct('http://127.0.0.1/check').catch(() => {})
      expect((await direct(`${it.url}/check`)).status).toBe(200)
      expect(opened).toEqual([
        { host: '127.0.0.1', port: 80 },
        { host: '127.0.0.1', port: it.port },
      ])
    } finally {
      net.connect = connect
    }
  })

  test('what a caller says truly of a body’s length is sent as the one length there is, and a header’s value goes as it was given', async () => {
    const it = await standIn((_asked, socket) => whole(socket, 200, ''))
    await direct(`${it.url}/a`, { method: 'POST', headers: { 'Content-Length': '3', 'x-tab': 'a\tb', 'x-latin': 'café', 'x-empty': '' }, body: 'abc' })
    await direct(`${it.url}/b`, { headers: { 'content-length': '0' } })
    await direct(`${it.url}/c`, { method: 'POST', headers: { 'content-length': '0' } })
    expect(it.asked.map((a) => [a.path, a.headers['content-length'], a.body.toString('latin1')])).toEqual([
      ['/a', '3', 'abc'],
      ['/b', undefined, ''],
      ['/c', '0', ''],
    ])
    expect(it.asked[0]!.headers).toMatchObject({ 'x-tab': 'a\tb', 'x-latin': 'café', 'x-empty': '' })
  })

  test('the backend’s own client takes it as its `fetch`, and calls a function through it', async () => {
    const it = await standIn((_asked, socket) =>
      whole(socket, 200, JSON.stringify({ status: 'success', value: [{ slug: 'plan' }], logLines: [] }), ['Content-Type: application/json']),
    )
    const client = new ConvexHttpClient(it.url, { fetch: direct, logger: false })
    client.setAuth('a-token')
    expect(await client.query(anyApi.artifacts!.list!, {})).toEqual([{ slug: 'plan' }])
    expect([it.asked[0]!.method, it.asked[0]!.path, it.asked[0]!.headers.authorization]).toEqual(['POST', '/api/query', 'Bearer a-token'])
    expect(JSON.parse(it.asked[0]!.body.toString('utf8'))).toMatchObject({ path: 'artifacts:list', args: [{}] })
  })
})

// ---------- a live connection ----------

describe('a live connection that is closed', () => {
  test('asks for no token again and waits for nothing more: neither while It is slow to answer, nor between one try and the next', async () => {
    let tokens = 0
    // An It that has trouble answering: it takes the request for a token and says only that it cannot just now
    const it = await standIn((asked, socket) => {
      if (asked.headers.upgrade) return socket.destroy()
      if (asked.path === '/bridge/token') tokens++
      whole(socket, 503, '')
    })
    const home = mkdtempSync(path.join(os.tmpdir(), 'it-live-'))
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: await exportJWK(privateKey) }))
    const before = { IT_HOME: process.env.IT_HOME, IT_URL: process.env.IT_URL, IT_SITE_URL: process.env.IT_SITE_URL }
    Object.assign(process.env, { IT_HOME: home, IT_URL: it.url })
    delete process.env.IT_SITE_URL
    try {
      // Closed while a token is being asked for again after the first trouble
      const first = live()
      expect(await until(() => tokens === 1)).toBe(true)
      await first.close()
      const atClose = tokens
      // For half as long again as the second it would have waited before its next try
      await pause(1500)
      expect(tokens).toBe(atClose)
      // And closed between one try and the next, once the trouble has been said
      let troubles = 0
      const second = live(undefined, () => troubles++)
      expect(await until(() => troubles === 1, 20_000)).toBe(true)
      await second.close()
      const then = tokens
      await pause(1500)
      expect([tokens, troubles]).toEqual([then, 1])
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})

// ---------- with a proxy named in the environment ----------

describe('with a proxy named in the environment', () => {
  /** Where each runtime is on this machine: the one running these tests, and the other where it is on the PATH. */
  const onPath = (name: string) =>
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, process.platform === 'win32' ? `${name}.exe` : name))
      .find((file) => existsSync(file))
  const underBun = 'Bun' in globalThis
  const node = underBun ? onPath('node') : process.execPath
  const bun = underBun ? process.execPath : onPath('bun')

  let scratch = ''
  let probe = ''
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'it-proxy-'))
    probe = path.join(scratch, 'probe.mjs')
    // What a command does when it asks It: a request, a call of a function through the backend's
    // own client, and the live connection, opened as every command opens it. Before them, one
    // request by the runtime's own `fetch`, which shows that the proxy is in force.
    const contents = `
      import { ConvexHttpClient } from 'convex/browser'
      import { anyApi } from 'convex/server'
      import { direct, live } from ${JSON.stringify(path.join(here, 'src/lib'))}
      const target = process.argv[2]
      const said = {}
      said.plain = await fetch(target + '/plain').then((r) => r.status, () => 'failed')
      said.direct = await direct(target + '/direct', { method: 'POST', headers: { authorization: 'Bearer a-token' }, body: '{}' }).then((r) => r.text(), (err) => 'failed: ' + (err.code ?? err.name))
      const client = new ConvexHttpClient(target, { fetch: direct, logger: false })
      client.setAuth('a-token')
      said.called = await client.query(anyApi.artifacts.list, {}).catch((err) => 'failed: ' + err.message)
      // As a Node would be whose dispatcher is of a kind this program does not know: it sends through the proxy as before
      if (process.argv[3] === 'hidden')
        for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
          const using = globalThis[symbol]
          if (symbol.description?.startsWith('undici.globalDispatcher.')) globalThis[symbol] = { dispatch: (...given) => using.dispatch(...given) }
        }
      let watching
      try {
        watching = live()
        watching.onUpdate(anyApi.artifacts.list, {}, () => {})
        // Until the other end has seen the connection asked for, or it is plain that it will not
        for (let n = 0; n < 200 && (await direct(target + '/connected').then((r) => r.text())) !== 'yes'; n++) await new Promise((r) => setTimeout(r, 50))
      } catch (err) {
        said.live = 'failed: ' + (err.code ?? err.message)
      }
      process.stdout.write(JSON.stringify(said), () => process.exit(0))
    `
    await build({
      stdin: { contents, resolveDir: here, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: probe,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** Runs the probe under a runtime, with a proxy named in every variable either runtime reads, and gives what the probe said, what the proxy was asked, and what It's stand-in was. */
  async function probed(runtime: string, env: Record<string, string>, ...more: string[]) {
    /** The first line of everything the proxy was asked: a request to pass on, or a tunnel to open. */
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
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    let upgrades = 0
    const it = await listening((asked, socket) => {
      // The live connection begins as a request to become one. That it was asked for here is all the test needs of it
      if (asked.headers.upgrade?.toLowerCase() === 'websocket') {
        upgrades++
        return socket.destroy()
      }
      if (asked.path === '/connected') return whole(socket, 200, upgrades ? 'yes' : 'no')
      if (asked.path === '/api/query')
        return whole(socket, 200, JSON.stringify({ status: 'success', value: ['a page'], logLines: [] }), ['Content-Type: application/json'])
      whole(socket, 200, 'answered by It')
    })
    const home = mkdtempSync(path.join(scratch, 'home-'))
    writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
    writeFileSync(
      path.join(home, 'token.json'),
      JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: it.url }),
    )
    const through = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
    try {
      const ran = await new Promise<{ out: string; err: string }>((resolve) =>
        execFile(
          runtime,
          [probe, it.url, ...more],
          {
            env: {
              PATH: process.env.PATH ?? '',
              IT_HOME: home,
              IT_URL: it.url,
              HTTP_PROXY: through,
              http_proxy: through,
              HTTPS_PROXY: through,
              https_proxy: through,
              ALL_PROXY: through,
              all_proxy: through,
              NO_PROXY: '',
              no_proxy: '',
              ...env,
            },
            timeout: 60_000,
          },
          (_err, out, err) => resolve({ out: String(out), err: String(err) }),
        ),
      )
      let said: Record<string, unknown> = {}
      try {
        said = JSON.parse(ran.out)
      } catch {
        said = { unread: ran.out, err: ran.err.slice(-2000) }
      }
      return { said, proxied, upgrades, asked: it.asked.filter((a) => a.path !== '/connected').map((a) => a.path) }
    } finally {
      await it.close()
      await new Promise<void>((r) => void proxy.close(() => r()))
    }
  }
  /** What is asked of It reaches It, and the proxy is asked for nothing but the one request the runtime's own `fetch` made. */
  const wentToIt = (ran: Awaited<ReturnType<typeof probed>>) => {
    expect(ran.said).toMatchObject({ direct: 'answered by It', called: ['a page'] })
    expect(ran.said.live).toBeUndefined()
    expect(ran.asked.filter((p) => !p.endsWith('/sync'))).toEqual(['/direct', '/api/query'])
    expect(ran.upgrades).toBeGreaterThan(0)
    expect(ran.proxied.length).toBe(1)
  }

  test.skipIf(!bun)(
    'under Bun, which sends its own `fetch` through the proxy, a request to It, a call of a function and the live connection all go to It itself',
    async () => {
      const ran = await probed(bun!, {})
      expect(ran.proxied[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/plain HTTP\/1\.1$/)
      wentToIt(ran)
    },
    90_000,
  )

  test.skipIf(!node)(
    'under Node told to use the environment’s proxy, which sends its own `fetch` and its live connections through it, all three go to It itself',
    async () => {
      const ran = await probed(node!, { NODE_USE_ENV_PROXY: '1' })
      expect(ran.proxied[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1$/)
      wentToIt(ran)
    },
    90_000,
  )

  test.skipIf(!node)(
    'under a Node that uses the proxy and gives this program no way to open a live connection without it, the connection is refused and never opened',
    async () => {
      const ran = await probed(node!, { NODE_USE_ENV_PROXY: '1' }, 'hidden')
      expect(ran.said).toMatchObject({ direct: 'answered by It', called: ['a page'], live: 'failed: unsupported' })
      expect([ran.proxied.length, ran.upgrades]).toEqual([1, 0])
    },
    90_000,
  )

  test.skipIf(!node)(
    'under Node as it is by default, nothing is sent to the proxy at all',
    async () => {
      const ran = await probed(node!, {})
      expect([ran.proxied, ran.said.plain, ran.said.direct, ran.said.called, ran.upgrades > 0]).toEqual([[], 200, 'answered by It', ['a page'], true])
    },
    90_000,
  )
})
