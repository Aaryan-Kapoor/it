// `it actions --id <page> --follow`, and the paged `it actions --id`, as the program runs them:
// built from the source as it stands, started in folders of its own, against a stand-in for the
// backend that answers calls and speaks the backend's live protocol over a WebSocket. Through
// that the real client of the backend keeps the watch, and keeps its token fresh, as it would
// over a watch of days: here the tokens live thirteen seconds, so a fresh one is fetched every
// few seconds.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { TAKES } from '@it/protocol'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair } from 'jose'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { INSTALLATION, INSTALLATION_FILE } from './src/installation'

vi.setConfig({ testTimeout: 60_000 })

let scratch: string
let program: string
let key: Record<string, unknown>
beforeAll(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-follow-'))
  program = path.join(scratch, 'it.mjs')
  await build({
    entryPoints: [path.join(__dirname, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: program,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    loader: { '.md': 'text', '.txt': 'text' },
    logLevel: 'silent',
  })
  // A key of the machine's own, so that it proves who it is each time it asks for a token
  key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), alg: 'ES256' }
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A machine that has joined It: a home, an It folder, and nothing else. */
function machine() {
  const home = mkdtempSync(path.join(scratch, 'h-'))
  const it = path.join(home, '.it')
  mkdirSync(it)
  writeFileSync(path.join(it, INSTALLATION_FILE), INSTALLATION)
  writeFileSync(path.join(it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key }))
  return { home, it }
}

/** An action waiting on the page, as the backend gives it, its place being its number. */
const action = (n: number, payload = JSON.stringify({ n })) => ({
  id: `a${n}`,
  artifact: 'board',
  title: 'Board',
  name: 'press',
  payload,
  at: 1_000 + n,
  attended: true,
  session: null,
  cursor: `${1_000 + n}:${1_000 + n}`,
})
type Action = ReturnType<typeof action>
const placeOf = (cursor: string) => (cursor === '0' ? 0 : Number(cursor.split(':')[0]))

/** A token as the backend makes one: a JWT, which the live client reads to know when to fetch the next. */
function jwt(n: number, lifetime: number) {
  const part = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ iat: now, exp: now + lifetime, n })}.c2lnbmVk`
}

/** A timestamp of the live protocol: a number of eight bytes, low first, in base64. */
const u64 = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b.toString('base64')
}

/** One WebSocket connection's frames, read and written by hand: text, ping and close are all the live client sends. */
function frames(socket: Duplex, onText: (text: string) => void) {
  let got = Buffer.alloc(0)
  let message: Buffer[] = []
  const send = (opcode: number, body: Buffer) => {
    const head =
      body.length < 126
        ? Buffer.from([0x80 | opcode, body.length])
        : body.length < 65536
          ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
          : Buffer.concat([
              Buffer.from([0x80 | opcode, 127]),
              (() => {
                const n = Buffer.alloc(8)
                n.writeBigUInt64BE(BigInt(body.length))
                return n
              })(),
            ])
    if (!socket.destroyed) socket.write(Buffer.concat([head, body]))
  }
  socket.on('data', (piece: Buffer) => {
    got = Buffer.concat([got, piece])
    for (;;) {
      if (got.length < 2) return
      const fin = (got[0]! & 0x80) !== 0
      const opcode = got[0]! & 0x0f
      let length = got[1]! & 0x7f
      let at = 2
      if (length === 126) {
        if (got.length < 4) return
        length = got.readUInt16BE(2)
        at = 4
      } else if (length === 127) {
        if (got.length < 10) return
        length = Number(got.readBigUInt64BE(2))
        at = 10
      }
      const masked = (got[1]! & 0x80) !== 0
      const mask = masked ? got.subarray(at, at + 4) : null
      if (masked) at += 4
      if (got.length < at + length) return
      const body = Buffer.from(got.subarray(at, at + length))
      if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
      got = got.subarray(at + length)
      if (opcode === 8) {
        send(8, Buffer.alloc(0))
        socket.end()
        return
      }
      if (opcode === 9) {
        send(10, body)
        continue
      }
      if (opcode === 1 || opcode === 0) {
        message.push(body)
        if (fin) {
          const text = Buffer.concat(message).toString('utf8')
          message = []
          onText(text)
        }
      }
    }
  })
  return { text: (value: unknown) => send(1, Buffer.from(JSON.stringify(value))), close: () => socket.destroy() }
}

interface Query {
  udfPath: string
  args: Record<string, unknown>
}
/** What a function answers: a value, or a failure with what It said, as a refusal of its own carries it. */
type Answer = { value: unknown } | { error: string; data?: unknown }

/**
 * Something that answers as the backend does: calls over HTTP, a token for a machine's proof, and
 * the live protocol, through which it tells every watch again whenever `changed` is called.
 */
async function backend(options: { takes?: string[] | null; lifetime?: number } = {}) {
  const pending: Action[] = []
  const said = { mutations: [] as string[], calls: [] as Query[], tokens: 0, authenticated: [] as string[], connections: 0 }
  /** What a function answers, by its name; `waitingPage` and `waiting` read what is pending, as the backend does. */
  const answers: Record<string, (args: any) => Answer> = {
    'artifacts:get': () => ({ value: { slug: 'board', title: 'Board' } }),
    'delivery:waiting': () => ({ value: pending.slice(0, 50).map(({ cursor: _, ...x }) => x) }),
    'delivery:waitingPage': ({ after }: { after?: string }) => {
      if (after === undefined) {
        const newest = pending.slice(-50)
        const left = pending.length - newest.length
        return { value: { actions: newest, from: left ? pending[left - 1]!.cursor : '0', more: false, earlier: left > 0 } }
      }
      const later = pending.filter((x) => placeOf(x.cursor) > placeOf(after))
      return { value: { actions: later.slice(0, 50), from: after, more: later.length > 50, earlier: false } }
    },
  }
  const sockets = new Set<ReturnType<typeof live>>()
  let ts = 0
  function live(socket: Duplex) {
    said.connections++
    const queries = new Map<number, Query>()
    const removed: number[] = []
    let version = { querySet: 0, identity: 0, ts: 0 }
    let querySet = 0
    let identity = 0
    let lastAuth = 0
    const transition = () => {
      const end = { querySet, identity, ts: ++ts }
      const modifications = [
        ...removed.splice(0).map((queryId) => ({ type: 'QueryRemoved', queryId })),
        ...[...queries].map(([queryId, q]) => {
          const got = (answers[q.udfPath] ?? (() => ({ value: null })))(q.args)
          return 'value' in got
            ? { type: 'QueryUpdated', queryId, value: got.value, logLines: [], journal: null }
            : { type: 'QueryFailed', queryId, errorMessage: got.error, logLines: [], journal: null, ...(got.data ? { errorData: got.data } : {}) }
        }),
      ]
      ws.text({
        type: 'Transition',
        startVersion: { ...version, ts: u64(version.ts) },
        endVersion: { ...end, ts: u64(end.ts) },
        modifications,
      })
      version = end
    }
    const ws = frames(socket, (text) => {
      const m = JSON.parse(text)
      if (m.type === 'Mutation' || m.type === 'Action') said.mutations.push(m.udfPath)
      if (m.type === 'Authenticate') {
        lastAuth = m.baseVersion
        said.authenticated.push(m.value)
        identity = m.baseVersion + 1
        transition()
      }
      if (m.type === 'ModifyQuerySet') {
        for (const x of m.modifications) {
          if (x.type === 'Add') queries.set(x.queryId, { udfPath: x.udfPath, args: x.args[0] ?? {} })
          if (x.type === 'Remove') {
            queries.delete(x.queryId)
            removed.push(x.queryId)
          }
        }
        querySet = m.newVersion
        transition()
      }
    })
    const one = {
      transition,
      queries,
      /** Says that the token it has is no longer good, as the backend does when one runs out. */
      expire: () => ws.text({ type: 'AuthError', error: 'Token expired', baseVersion: lastAuth, authUpdateAttempted: false }),
    }
    socket.on('close', () => sockets.delete(one))
    sockets.add(one)
    return one
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => {
        const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.url === '/cli/config') {
          if (options.takes === null) return json({}, 500)
          return json({ protocol: 1, issuer: 'http://127.0.0.1:23001', takes: options.takes ?? Object.values(TAKES), now: Date.now() })
        }
        if (req.url === '/bridge/token') return json({ token: jwt(++said.tokens, options.lifetime ?? 13), expires_in: options.lifetime ?? 13 })
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { path: string; args: [Record<string, unknown>] }
        if (req.url === '/api/mutation' || req.url === '/api/action') said.mutations.push(call.path)
        const q = { udfPath: call.path, args: call.args?.[0] ?? {} }
        said.calls.push(q)
        const got = (answers[q.udfPath] ?? (() => ({ value: null })))(q.args)
        if ('value' in got) return json({ status: 'success', value: got.value, logLines: [] })
        if (got.data) return json({ status: 'error', errorMessage: got.error, errorData: got.data, logLines: [] })
        json({ status: 'error', errorMessage: got.error, logLines: [] }, 560)
      })
  })
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
    live(socket)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url,
    pending,
    said,
    answers,
    sockets,
    env: { IT_URL: url, IT_SITE_URL: url },
    /** Tells every watch what it watches as it is now, as the backend does when what it read changes. */
    changed: () => {
      for (const s of sockets) s.transition()
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  }
}

/** Runs the program to its end. */
function run(m: { home: string; it: string }, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    execFile(
      process.execPath,
      [program, ...args],
      { cwd: m.home, env: { PATH: '/usr/bin:/bin', HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', ...env }, timeout: 30_000 },
      (err, out, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? null) : 0, out: String(out), err: String(stderr) }),
    ),
  )
}

/** Starts the program and keeps it running, with each line it prints as it prints it. */
function started(m: { home: string; it: string }, args: string[], env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, [program, ...args], {
    cwd: m.home,
    env: { PATH: '/usr/bin:/bin', HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: any[] = []
  let rest = ''
  let err = ''
  child.stdout!.on('data', (piece: Buffer) => {
    rest += piece.toString('utf8')
    const whole = rest.split('\n')
    rest = whole.pop()!
    for (const line of whole) lines.push(JSON.parse(line))
  })
  child.stderr!.on('data', (piece: Buffer) => {
    err += piece.toString('utf8')
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, lines, err: () => err, exited }
}

/** Waits until something is so, or says what was waited for. */
async function until(what: string, ok: () => boolean, ms = 20_000) {
  const by = Date.now() + ms
  while (!ok()) {
    if (Date.now() > by) throw new Error(`Waited ${ms} ms for ${what}.`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `a${from + i}`)
const lastError = (err: string) => JSON.parse(err.trim().split('\n').pop()!).error

describe.skipIf(process.platform === 'win32')('following the actions on a page, as the program does it', () => {
  test('every action is printed once, the 51st and later too while fifty wait unanswered, through fresh tokens and an expired one, and nothing is claimed', async () => {
    const m = machine()
    const b = await backend()
    try {
      for (let n = 1; n <= 50; n++) b.pending.push(action(n))
      const f = started(m, ['actions', '--id', 'board', '--follow'], b.env)
      await until('the fifty waiting to be printed', () => f.lines.length === 50)
      expect(f.lines.map((l) => l.id)).toEqual(ids(1, 50))
      expect(f.lines[0]).toMatchObject({ id: 'a1', page: 'board', action: 'press', data: { n: 1 }, cursor: '1001:1001' })
      // A 51st, with the fifty older ones still waiting
      b.pending.push(action(51))
      b.changed()
      await until('the 51st', () => f.lines.length === 51)
      // Over several seconds the client fetches a fresh token every few, and the watch goes on through each
      for (let n = 52; n <= 60; n++) {
        await new Promise((r) => setTimeout(r, 700))
        b.pending.push(action(n))
        b.changed()
      }
      await until('the 60th', () => f.lines.length === 60)
      await until('a fresh token or two', () => new Set(b.said.authenticated).size >= 4)
      // The backend says the token has run out: the client fetches another and carries on
      const before = b.said.authenticated.length
      for (const s of b.sockets) s.expire()
      await until('a token fetched after the last expired', () => b.said.authenticated.length > before)
      b.pending.push(action(61))
      b.changed()
      await until('the 61st', () => f.lines.length === 61)
      await new Promise((r) => setTimeout(r, 300))
      expect(f.lines.map((l) => l.id)).toEqual(ids(1, 61))
      expect(f.lines.every((l) => l.page === 'board')).toBe(true)
      // Only read: nothing was claimed, held, handed off or answered
      expect(b.said.mutations).toEqual([])
      f.child.kill('SIGTERM')
      expect(await f.exited).toBe(0)
      expect(f.err()).toBe('')
    } finally {
      await b.close()
    }
  })

  test('told to stop by SIGINT it ends well, and a stream that fails ends it with an error', async () => {
    const m = machine()
    const b = await backend()
    try {
      b.pending.push(action(1))
      let f = started(m, ['actions', '--id', 'board', '--follow'], b.env)
      await until('the first', () => f.lines.length === 1)
      f.child.kill('SIGINT')
      expect(await f.exited).toBe(0)
      for (const [answer, code] of [
        [{ error: '[Request ID: 5f3c] Server Error' }, 'offline'],
        [{ error: 'refused', data: { code: 'not_found', message: 'No such page.' } }, 'not_found'],
      ] as const) {
        f = started(m, ['actions', '--id', 'board', '--follow'], b.env)
        await until('the first', () => f.lines.length === 1)
        const real = b.answers['delivery:waitingPage']!
        b.answers['delivery:waitingPage'] = () => answer
        b.changed()
        expect(await f.exited).toBe(1)
        expect(lastError(f.err())).toMatchObject({ code })
        b.answers['delivery:waitingPage'] = real
      }
    } finally {
      await b.close()
    }
  })

  test('given a cursor it begins after it, and it refuses what is no single page', async () => {
    const m = machine()
    const b = await backend()
    try {
      for (let n = 1; n <= 5; n++) b.pending.push(action(n))
      const f = started(m, ['actions', '--id', 'board', '--follow', '--after', '1003:1003'], b.env)
      await until('those after the cursor', () => f.lines.length === 2)
      expect(f.lines.map((l) => l.id)).toEqual(['a4', 'a5'])
      f.child.kill('SIGTERM')
      expect(await f.exited).toBe(0)
      for (const args of [['--follow'], ['--follow', '--all', '--id', 'board'], ['--after', '0']]) {
        const ran = await run(m, ['actions', ...args], b.env)
        expect(ran.code).toBe(2)
        expect(lastError(ran.err).code).toBe('invalid')
      }
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('the actions on a page against an older It', () => {
  test('it lists and follows the oldest 50 that such an It gives, says so, and refuses a cursor', async () => {
    const m = machine()
    const b = await backend({ takes: [TAKES.conversationsWaiting, TAKES.madeAt, TAKES.inboxHeld] })
    b.answers['delivery:waitingPage'] = () => ({ error: '[Request ID: 5f3c] Server Error' })
    try {
      for (let n = 1; n <= 60; n++) b.pending.push(action(n))
      const listed = await run(m, ['actions', '--id', 'board'], b.env)
      expect(listed.code).toBe(0)
      expect(JSON.parse(listed.out).map((x: { id: string }) => x.id)).toEqual(ids(1, 50))
      expect(JSON.parse(listed.err.trim()).note).toMatch(/earlier version.*oldest 50/)
      const f = started(m, ['actions', '--id', 'board', '--follow'], b.env)
      await until('the oldest fifty', () => f.lines.length === 50)
      expect(JSON.parse(f.err().trim()).note).toMatch(/earlier version.*oldest 50/)
      f.child.kill('SIGTERM')
      expect(await f.exited).toBe(0)
      for (const args of [
        ['--after', '0'],
        ['--follow', '--after', '0'],
      ]) {
        const ran = await run(m, ['actions', '--id', 'board', ...args], b.env)
        expect(ran.code).toBe(2)
        expect(lastError(ran.err)).toMatchObject({ code: 'invalid', message: expect.stringMatching(/earlier version/) })
      }
    } finally {
      await b.close()
    }
  })

  test('where It cannot be asked what it takes, the refusal is what is said, and nothing older is read in its place', async () => {
    const m = machine()
    const b = await backend({ takes: null })
    b.answers['delivery:waitingPage'] = () => ({ error: '[Request ID: 5f3c] Server Error' })
    try {
      b.pending.push(action(1))
      const ran = await run(m, ['actions', '--id', 'board'], b.env)
      expect(ran.code).toBe(1)
      expect(lastError(ran.err).message).toMatch(/Server Error/)
      expect(b.said.calls.map((c) => c.udfPath)).toEqual(['delivery:waitingPage'])
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('listing the actions on a page', () => {
  test('what is printed stays within 256 KB, however much fifty actions carried, keeping the newest', async () => {
    const m = machine()
    const b = await backend()
    try {
      for (let n = 1; n <= 50; n++) b.pending.push(action(n, JSON.stringify({ n, rows: Array.from({ length: 3000 }, () => [10, 10]) })))
      const ran = await run(m, ['actions', '--id', 'board'], b.env)
      expect(ran.code).toBe(0)
      expect(Buffer.byteLength(ran.out)).toBeLessThanOrEqual(256 * 1024)
      const listed = JSON.parse(ran.out) as { id: string; cursor: string }[]
      expect(listed.length).toBeGreaterThan(0)
      expect(listed.at(-1)!.id).toBe('a50')
      expect(JSON.parse(ran.err.trim()).note).toMatch(/--after 0/)
      // Paged through from the start, a page at a time, every one of them is read
      const seen: string[] = []
      for (let after = '0', n = 0; n < 60; n++) {
        const page = await run(m, ['actions', '--id', 'board', '--after', after], b.env)
        expect(page.code).toBe(0)
        expect(Buffer.byteLength(page.out)).toBeLessThanOrEqual(256 * 1024)
        const got = JSON.parse(page.out) as { id: string; cursor: string }[]
        seen.push(...got.map((x) => x.id))
        if (!page.err.trim()) break
        after = got.at(-1)!.cursor
      }
      expect(seen).toEqual(ids(1, 50))
    } finally {
      await b.close()
    }
  })
})
