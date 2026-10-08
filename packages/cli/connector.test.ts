// The connector itself, started in a folder of its own, with stand-ins for the backend, for
// Codex's own command and for usage reporting. What add-ons and `it wait` ask of it is asked for
// real, over its socket and over its port.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { conversationFolder, noteConversation } from './src/publish'

const stand = vi.hoisted(() => ({
  /** What the connector watches the backend for, by the name of the function, and how to tell it something new. */
  watching: new Map<string, (value: any) => void>(),
  /** What it last asked to be told of, for each function it watches. */
  asking: new Map<string, any>(),
  /** What a look at this machine finds of its agent apps. */
  found: [] as { id: string; version?: string; addon: string }[],
  /** Every call the connector made to the backend. */
  calls: [] as { name: string; args: any }[],
  /** What a call answers, when the test wants something other than the usual. Undefined leaves it to the usual. */
  answer: null as null | ((name: string, args: any) => unknown),
  /** Every time Codex's own command was started, and how the test ends it. */
  codex: [] as { args: string[]; end: (err?: unknown) => void }[],
  /** The Codex conversations that no Codex has open. Every other one is open somewhere, as it is in a window. */
  closed: new Set<string>(),
}))
// Whether some Codex has a conversation open is read from Codex's own folder and from the system
// (wake.test.ts tries that against real files). Here the test says which are closed.
vi.mock('./src/wake', async (original) => ({
  ...(await original<typeof import('./src/wake')>()),
  codexHeld: (thread: string) => !stand.closed.has(thread),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (_bin: string, args: string[], _options: unknown, done: (err: unknown) => void) => {
    stand.codex.push({ args, end: (err) => done(err ?? null) })
  },
}))
vi.mock('./src/setup', () => ({ detectAll: async () => stand.found, newerProgramSeen: () => false, reconcile: async () => {} }))
vi.mock('./src/usage', () => ({
  agentOf: (harness: unknown) => String(harness ?? 'unknown'),
  record: () => {},
  startSender: () => ({ stop: () => {} }),
  thisProgram: () => ({}),
  timeBand: () => '',
}))
vi.mock('./src/lib', async (original) => {
  const real = await original<typeof import('./src/lib')>()
  return {
    ...real,
    live: () => ({
      onUpdate: (fn: any, args: unknown, heard: (value: any) => void) => {
        stand.watching.set(getFunctionName(fn), heard)
        stand.asking.set(getFunctionName(fn), args)
        return () => {}
      },
      close: async () => {},
    }),
    call: async (_kind: string, fn: any, args: any) => {
      const name = getFunctionName(fn)
      stand.calls.push({ name, args })
      const said = await stand.answer?.(name, args)
      if (said !== undefined) return said
      // The backend as it answers when nothing is in the way: what is asked for is given
      if (name === 'delivery:claim' || name === 'delivery:renew') return args.ids
      if (name === 'delivery:lost') return []
      if (name === 'delivery:handedOff') return { already: false }
      return null
    },
  }
})

import { type ConnectorInfo, infoFile, local, mac, runConnector } from './src/connector'
import { readJson } from './src/lib'
import { alone, startOf } from './src/serve/backend'
import { identity, SINCE_TOLD, WAS_STOPPED } from './src/wake'

// The real clock, kept from before any test puts a stand-in in its place
const really = setTimeout
const reallyNext = setImmediate
const pause = (ms: number) => new Promise((r) => really(r, ms))
async function until(what: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = performance.now() + ms
  while (!(await what())) {
    if (performance.now() > end) throw new Error('what the test waited for did not happen')
    await pause(10)
  }
}
/**
 * Everything that is ready to run has run. Told something, the connector waits on nothing but
 * It's answers and Codex's own command before it has done all it does about it, and both of
 * those are a test's to give here. So by the end of a turn it has done what it does, and what
 * it has not done by then it does not do.
 */
const settled = () => new Promise((r) => reallyNext(r))
/** The connector's once-a-second timer is a stand-in, and its other waits too when asked: its passes run when a test says. To be called before it starts. */
const standIn = (waits = false) => vi.useFakeTimers({ toFake: [...(waits ? (['setTimeout', 'clearTimeout'] as const) : []), 'setInterval', 'clearInterval'] })
/** A second passes for the connector whose timer is a stand-in: it makes the pass it makes every second, and that pass is over. */
async function pass(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    vi.advanceTimersByTime(1000)
    await settled()
  }
}

const before = { ...process.env }
let home = ''
let stop: (() => Promise<void>) | null = null
/** What the connector wrote to its log. */
const said: string[] = []
/** Codex and Pi as a look finds them when the person has connected both. */
const CONNECTED = [
  { id: 'codex', version: '1.0.0', addon: 'connected' },
  { id: 'pi', version: '1.0.0', addon: 'connected' },
]
/**
 * Starts a connector in a folder of its own. It is stopped, and the folder removed, when the
 * test ends. Unless a test says otherwise, the person has chosen Codex and Pi and both have
 * It's add-on in them, which is what It tells the connector once it is watching.
 */
async function start(
  over: 'socket' | 'port' = 'socket',
  apps: { wanted?: string[]; found?: typeof stand.found } = {},
  /** What is put into the folder before the connector starts in it. */
  first: (home: string) => void = () => {},
): Promise<ConnectorInfo> {
  stand.found = apps.found ?? CONNECTED
  home = mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
  // Every folder a test starts a connector in is taken away when the test is over, and not only the last
  made.push(home)
  process.env.IT_HOME = home
  first(home)
  if (over === 'port') process.env.IT_CONNECTOR_PORT = '1'
  else delete process.env.IT_CONNECTOR_PORT
  const had = { SIGTERM: new Set(process.listeners('SIGTERM')), SIGINT: new Set(process.listeners('SIGINT')) }
  const running = runConnector((line) => said.push(line))
  // It is up once it answers, watches the backend, and can be told to stop
  const stopper = () => process.listeners('SIGTERM').find((l) => !had.SIGTERM.has(l)) as ((signal: string) => void) | undefined
  await until(() => existsSync(infoFile()) && stand.watching.has('delivery:inbox') && stand.watching.has('machines:me') && stopper() !== undefined)
  wants(apps.wanted ?? ['codex', 'pi'])
  stop = async () => {
    stopper()!('SIGTERM')
    await running
    for (const sig of ['SIGTERM', 'SIGINT'] as const) for (const l of process.listeners(sig)) if (!had[sig].has(l)) process.removeListener(sig, l)
  }
  return readJson<ConnectorInfo>(infoFile())!
}
/** What It tells the connector the person has chosen on this machine. */
const wants = (wanted: string[]) => stand.watching.get('machines:me')!({ wanted })
/** The folders this test's connectors were started in. */
const made: string[] = []
afterEach(async () => {
  // Whatever Codex command is still open is ended, so that nothing waits on it
  for (const c of stand.codex) c.end()
  try {
    await stop?.()
  } finally {
    // Whatever became of the stopping, nothing is left in the system's folder for scratch files
    for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
  }
  stop = null
  vi.useRealTimers()
  stand.watching.clear()
  stand.asking.clear()
  stand.calls.length = 0
  said.length = 0
  stand.codex.length = 0
  stand.closed.clear()
  stand.answer = null
  if (home) rmSync(home, { recursive: true, force: true })
  home = ''
  for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
  Object.assign(process.env, before)
})

/** How to reach a connector, and what proves a request is from someone who may ask: its token over the socket, a code made from it over a port. */
function reach(info: ConnectorInfo, method: string, pathname: string, body: string) {
  if (info.socket) return { where: { socketPath: info.socket }, proof: { 'x-it-token': info.token } }
  const nonce = randomBytes(16).toString('hex')
  return {
    where: { host: '127.0.0.1', port: info.port },
    proof: { 'x-it-nonce': nonce, 'x-it-mac': mac(info.token, nonce, `${method}\n${pathname}\n${body}`) },
  }
}
/** Sends a request whose body arrives in two pieces, cut at the byte the test chooses. Resolves with the status of the answer. */
function sentInTwoPieces(info: ConnectorInfo, pathname: string, body: string, cut: number): Promise<number> {
  const bytes = Buffer.from(body)
  const { where, proof } = reach(info, 'POST', pathname, body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...where, path: pathname, method: 'POST', headers: { ...proof, 'content-type': 'application/json', 'content-length': bytes.length } },
      (res) => {
        res.resume().on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.write(bytes.subarray(0, cut))
    setTimeout(() => req.end(bytes.subarray(cut)), 40)
  })
}

describe('the lock one connector holds for a folder', () => {
  const lock = () => path.join(home, 'connector.lock')
  const TOOK = (pid: number) => `took over from a connector that is gone and left its lock behind (pid ${pid})`
  /** A process number that no process has, and a process that lives and is no connector: the one this one was started by. */
  const NOBODY = 999_999_999
  const ALIVE = process.ppid
  const kept = () => JSON.parse(readFileSync(lock(), 'utf8')) as { pid: number; holder: string }
  /** A folder of this test's own, with nothing running in it yet. */
  const folder = () => {
    stand.found = CONNECTED
    home = mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
    process.env.IT_HOME = home
  }
  /** A lock as one is made on this machine, learnt by holding this folder's for a moment. */
  const aLock = async () => {
    let made: Record<string, unknown> = {}
    await alone('connector', async () => {
      made = JSON.parse(readFileSync(lock(), 'utf8'))
    })
    return made
  }
  /** The lock as a program that is gone left it, and as a program that lives holds it. */
  const leftBehind = (shape: Record<string, unknown>) => JSON.stringify({ ...shape, pid: NOBODY, started: 'never', holder: 'a'.repeat(16) })
  const heldByAnother = (shape: Record<string, unknown>) => JSON.stringify({ ...shape, pid: ALIVE, started: startOf(ALIVE) || '', holder: 'b'.repeat(16) })
  /** Starts a connector in the folder as it is, and gives how its start ended: the code it failed with, or that it is running. */
  const starting = async () => {
    const had = { SIGTERM: new Set(process.listeners('SIGTERM')), SIGINT: new Set(process.listeners('SIGINT')) }
    const stopper = () => process.listeners('SIGTERM').find((l) => !had.SIGTERM.has(l)) as ((signal: string) => void) | undefined
    let failed: { code?: string; message?: string } | undefined
    const running = runConnector((line) => said.push(line)).catch((err: { code?: string; message?: string }) => {
      failed = err
    })
    stop = async () => {
      stopper()?.('SIGTERM')
      await running
      for (const sig of ['SIGTERM', 'SIGINT'] as const) for (const l of process.listeners(sig)) if (!had[sig].has(l)) process.removeListener(sig, l)
    }
    await until(() => failed !== undefined || stopper() !== undefined)
    return failed ? { code: failed.code, message: failed.message } : 'running'
  }

  test('names its holder for as long as the connector runs, is let go when it stops, and leaves nothing beside it', async () => {
    await start()
    expect(kept().pid).toBe(process.pid)
    await stop?.()
    stop = null
    expect(readdirSync(home).filter((name) => name.startsWith('connector.'))).toEqual([])
  })

  test('is given its name only once it is whole: it is written under another name first, and nothing is ever under its own name that names no holder', async () => {
    // Whom the lock named at the moment it was given its name, and whether anything had that name then
    const given: { pid: unknown; there: boolean }[] = []
    const real = fs.linkSync
    fs.linkSync = ((from: string, to: string) => {
      if (path.basename(to) === 'connector.lock') given.push({ pid: JSON.parse(readFileSync(from, 'utf8')).pid, there: existsSync(to) })
      return real(from, to)
    }) as typeof fs.linkSync
    syncBuiltinESMExports()
    try {
      await start()
    } finally {
      fs.linkSync = real
      syncBuiltinESMExports()
    }
    expect(given).toEqual([{ pid: process.pid, there: false }])
  })

  test('one left behind by a connector that is gone is taken over, and that is written down', async () => {
    folder()
    writeFileSync(lock(), leftBehind(await aLock()))
    expect(await starting()).toBe('running')
    expect([kept().pid, said.includes(TOOK(NOBODY))]).toEqual([process.pid, true])
  })

  test('one whose holder lives is never taken from it, however long that holder has had it and whatever it answers: the connector that finds it gives up and says that one is already running', async () => {
    folder()
    const theirs = heldByAnother(await aLock())
    writeFileSync(lock(), theirs)
    // Held since long ago, by a program that answers nothing where a connector would
    const longAgo = new Date(Date.now() - 3_600_000)
    utimesSync(lock(), longAgo, longAgo)
    for (let n = 0; n < 2; n++) {
      expect(await starting()).toEqual({ code: 'already_running', message: `A connector is already running for this folder (pid ${ALIVE}).` })
      // Nothing of the holder's was touched, and nothing was opened in its place
      expect([readFileSync(lock(), 'utf8'), existsSync(infoFile()), existsSync(path.join(home, 'connector.sock'))]).toEqual([theirs, false, false])
    }
    expect(said.filter((line) => line.startsWith('took over'))).toEqual([])
  })

  for (const over of ['socket', 'port'] as const) {
    /** Runs a start of the connector with the lock made another's at a moment of the test's choosing, and gives how the start ended. */
    const lostAt = async (moment: 'before it listens' | 'before it writes its note') => {
      folder()
      if (over === 'port') process.env.IT_CONNECTOR_PORT = '1'
      else delete process.env.IT_CONNECTOR_PORT
      const theirs = heldByAnother(await aLock())
      const another = () => writeFileSync(lock(), theirs)
      const [read, listen] = [fs.readFileSync, http.Server.prototype.listen]
      /** How often anything was told to listen. */
      let listened = 0
      // The first thing a connector reads once the lock is its own is its note of conversations' earlier ids
      if (moment === 'before it listens')
        fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...more: unknown[]) => {
          if (typeof file === 'string' && path.basename(file) === 'aliases.json') another()
          return (read as (...given: unknown[]) => unknown)(file, ...more)
        }) as typeof fs.readFileSync
      // And the last thing before its note is written is that it has begun to listen
      http.Server.prototype.listen = function (this: http.Server, ...given: unknown[]) {
        listened++
        const listening = given.pop() as () => void
        return (listen as (...all: unknown[]) => http.Server).call(this, ...given, () => {
          if (moment === 'before it writes its note') another()
          listening()
        })
      } as typeof http.Server.prototype.listen
      syncBuiltinESMExports()
      try {
        return { ended: await starting(), theirs, listened }
      } finally {
        fs.readFileSync = read
        http.Server.prototype.listen = listen
        syncBuiltinESMExports()
      }
    }

    test(`a connector whose lock has come to be another’s before it listens on its ${over} does not listen, and leaves that other’s lock and note alone`, async () => {
      const { ended, theirs, listened } = await lostAt('before it listens')
      expect([ended, listened]).toEqual([expect.objectContaining({ code: 'lock_lost' }), 0])
      expect([readFileSync(lock(), 'utf8'), existsSync(infoFile()), existsSync(path.join(home, 'connector.sock'))]).toEqual([theirs, false, false])
    })

    test(`a connector whose lock has come to be another’s before it has written where it listens on its ${over} writes no note, and closes what it had opened`, async () => {
      const { ended, theirs, listened } = await lostAt('before it writes its note')
      expect([ended, listened]).toEqual([expect.objectContaining({ code: 'lock_lost' }), 1])
      expect([readFileSync(lock(), 'utf8'), existsSync(infoFile()), existsSync(path.join(home, 'connector.sock'))]).toEqual([theirs, false, false])
    })
  }
})

describe.skipIf(process.platform === 'win32')('text that arrives in pieces, cut in the middle of a character', () => {
  // Two characters of three bytes each: the cut falls after the first byte of the first
  const NAME = '支付-1'
  const body = JSON.stringify({ harness: 'pi', session: NAME })
  const cut = Buffer.from(body).indexOf(Buffer.from('支')) + 1

  for (const over of ['socket', 'port'] as const)
    test(`a request to the connector over its ${over} is read as it was sent`, async () => {
      const info = await start(over)
      expect(over === 'socket' ? typeof info.socket : typeof info.port).toBe(over === 'socket' ? 'string' : 'number')
      // Over a port the request is sealed, and a body read wrongly would not match its seal
      expect(await sentInTwoPieces(info, '/session', body, cut)).toBe(200)
      expect((await local<{ sessions: string[] }>('/health'))?.sessions).toEqual([`pi:${NAME}`])
    })

  for (const over of ['socket', 'port'] as const)
    test(`an answer from the connector over its ${over} is read as it was sent`, async () => {
      home = mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
      process.env.IT_HOME = home
      const token = 'ab'.repeat(24)
      const text = JSON.stringify({ clicks: [{ id: 'click-1', payload: { note: NAME } }] })
      const bytes = Buffer.from(text)
      const at = bytes.indexOf(Buffer.from('支')) + 1
      // Something answering as the connector would, in two pieces
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-it-mac': mac(token, String(req.headers['x-it-nonce'] ?? ''), `200\n${text}`) })
        res.write(bytes.subarray(0, at))
        setTimeout(() => res.end(bytes.subarray(at)), 40)
      })
      const socket = path.join(home, 'stand-in.sock')
      await new Promise<void>((r) => (over === 'socket' ? server.listen(socket, r) : server.listen(0, '127.0.0.1', r)))
      try {
        const where = over === 'socket' ? { socket } : { port: (server.address() as { port: number }).port }
        writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ ...where, token, pid: 1, version: 'x', startedAt: 0 }))
        expect(await local('/clicks?harness=pi&session=s')).toEqual({ clicks: [{ id: 'click-1', payload: { note: NAME } }] })
      } finally {
        await new Promise((r) => server.close(r))
      }
    })
})

describe.skipIf(process.platform === 'win32')('a request whose bytes are not text', () => {
  for (const over of ['socket', 'port'] as const)
    test(`is refused over the connector’s ${over}, though it is sealed as the text it would be read as`, async () => {
      const info = await start(over)
      // Read loosely, a byte that is no character becomes the mark that stands for any such byte
      const read = '{"harness":"pi","session":"\ufffd"}'
      const bytes = Buffer.from(read)
      const at = bytes.indexOf(Buffer.from('\ufffd'))
      const sent = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])
      const { where, proof } = reach(info, 'POST', '/session', read)
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ ...where, method: 'POST', path: '/session', headers: { ...proof, 'content-length': sent.length } }, (res) => {
          res.resume().on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        req.end(sent)
      })
      expect(status).toBe(400)
      expect((await local<{ sessions: string[] }>('/health'))?.sessions).toEqual([])
    })
})

describe.skipIf(process.platform === 'win32')('a click on its way into Codex’s own queue, and an agent that begins to wait for it', () => {
  const click = (n: number) => ({
    id: `click-${n}`,
    artifact: `page-${n}`,
    title: 'A page',
    name: 'approve',
    payload: '{"plan":"B"}',
    at: Date.now() - 10_000 + n,
    attended: true,
    session: { harness: 'codex', id: `thread-${n}` },
  })
  const offered = (...clicks: ReturnType<typeof click>[]) => stand.watching.get('delivery:inbox')!(clicks)
  const waitingFor = (n: number) =>
    local<{ ok: boolean; clicks?: { id: string }[] }>('/waiting', {
      method: 'POST',
      body: { id: `waiter-${n}`, session: { harness: 'codex', id: `thread-${n}` } },
    })
  const called = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])

  test('one that stood in line for a place is left for the waiter once its place comes', async () => {
    await start()
    // Three commands may run at once, so the fourth click waits for one of them to end
    offered(click(0), click(1), click(2), click(3))
    await until(() => stand.codex.length === 3)
    expect(called('delivery:claim')).not.toContain('click-3')
    expect(await waitingFor(3)).toMatchObject({ ok: true })
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-0'))
    await settled()
    // Its place came, and it was neither claimed nor given to Codex: the waiter takes it from It
    expect(called('delivery:claim')).not.toContain('click-3')
    expect(stand.codex.map((c) => c.args.find((a) => a.startsWith('--thread=')))).toEqual(['--thread=thread-0', '--thread=thread-1', '--thread=thread-2'])
  })

  test('one for a conversation no Codex has open is never put in Codex’s queue: it waits where the site shows it, unless the person has switched reopening on', async () => {
    await start()
    stand.closed.add('thread-1')
    // Open somewhere, the other conversation's goes into the queue as before
    offered(click(1), click(2))
    await until(() => stand.codex.length === 1)
    await settled()
    expect(stand.codex.map((c) => c.args.find((a) => a.startsWith('--thread=')))).toEqual(['--thread=thread-2'])
    // A message in the queue of a conversation nobody has open waits there until it is opened and a turn of it ends
    expect(called('delivery:claim')).toEqual(['click-2'])
    expect(stand.calls.filter((c) => c.name === 'machines:runBegan')).toEqual([])
  })

  test('the folder a Codex hook says its conversation is held in is noted, since Codex’s own commands cannot write it down', async () => {
    await start()
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    try {
      await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-7', folder } })
      expect(conversationFolder({ harness: 'codex', id: 'thread-7' })).toBe(folder)
      // What is no folder's whole address is not noted
      await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-8', folder: 'some/where' } })
      expect(conversationFolder({ harness: 'codex', id: 'thread-8' })).toBeUndefined()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('what the connector before it wrote down of the turns it cut off is kept until each conversation has been told, however often the connector is started again', async () => {
    const noted = () => JSON.parse(readFileSync(path.join(home, 'cut-off.json'), 'utf8'))
    await start('socket', {}, (home) => writeFileSync(path.join(home, 'cut-off.json'), JSON.stringify(['pi:conversation-1'])))
    expect(noted()).toEqual(['pi:conversation-1'])
    // Stopped before that conversation was reopened again, it is still owed the note
    await stop?.()
    stop = null
    expect(noted()).toEqual(['pi:conversation-1'])
  })

  test('with reopening switched on, a closed conversation is reopened with the click itself, and Codex’s queue is never used for it', async () => {
    await start()
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    // It goes the way of every other app's: claimed, and the conversation's own command run in its
    // folder. This machine was never told that conversation's folder, which is said in words and stops there.
    await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'))
    expect(stand.calls.find((c) => c.name === 'machines:wakeFailed')!.args).toMatchObject({
      for: { harness: 'codex', id: 'thread-1' },
      why: 'the folder its conversation was held in is not known on this machine, or is gone',
    })
    expect(stand.codex).toEqual([])
    expect(said.some((line) => line.includes('was not taken by the reopening of its conversation'))).toBe(true)
  })

  test.skipIf(process.platform === 'win32')(
    'a reopening that fails after its own add-on was heard from counts as a try, says the app’s last line on the page alone, and is not tried without end',
    async () => {
      // Codex's own command, as a program of its own: it says that it began, waits to be let go, prints why it cannot go on, and fails
      const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
      made.push(bin, folder)
      writeFileSync(
        path.join(bin, 'codex'),
        `#!/bin/sh\ncat > /dev/null\nn=$(ls ${bin} | grep -c began)\ntouch ${bin}/began-$n\nwhile [ ! -f ${bin}/go-$n ]; do sleep 0.05; done\necho 'ERROR: Missing environment variable: \`KEY\`.' >&2\nexit 1\n`,
        { mode: 0o755 },
      )
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
      await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
      stand.closed.add('thread-1')
      stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
      const failures = () => stand.calls.filter((c) => c.name === 'machines:wakeFailed')
      const oneTry = async (n: number) => {
        offered(click(1))
        await until(() => existsSync(path.join(bin, `began-${n}`)))
        // The add-on inside the reopened app says its conversation is listening, as it does when any conversation begins
        await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1' } })
        writeFileSync(path.join(bin, `go-${n}`), '')
        await until(() => failures().length === n + 1)
        await settled()
      }
      await oneTry(0)
      expect(failures()[0]!.args).toEqual({
        for: { harness: 'codex', id: 'thread-1' },
        why: 'Codex exited with 1, and its last words were: ERROR: Missing environment variable: `KEY`.',
      })
      expect(said.some((line) => line.includes('(Codex exited with 1); try 1 of 4'))).toBe(true)
      // What the app printed is for the page, and is in no line of the log
      expect(said.join('\n')).not.toContain('Missing environment')
      // Nothing of it was forgotten because the app's own add-on had spoken: the next try is the second, after its pause
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 11_000)
      await oneTry(1)
      expect(said.some((line) => line.includes('try 2 of 4'))).toBe(true)
      expect(said.filter((line) => line.includes('try 1 of 4'))).toHaveLength(1)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'a conversation whose last reopened turn a person stopped is told so the next time it is reopened, also by a connector started after the stop',
    async () => {
      // Codex's own command, as a program of its own: it keeps what it was given, and ends well
      const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
      made.push(bin, folder)
      writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given-$(ls ${bin} | grep -c given)\nexit 0\n`, { mode: 0o755 })
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
      // The connector before this one wrote down that the person had stopped thread-1's turn, and was then stopped itself
      await start('socket', {}, (home) => {
        noteConversation({ harness: 'codex', id: 'thread-1' }, folder)
        noteConversation({ harness: 'codex', id: 'thread-2' }, folder)
        writeFileSync(path.join(home, 'stopped.json'), JSON.stringify(['codex:thread-1']))
      })
      stand.closed.add('thread-1')
      stand.closed.add('thread-2')
      stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
      offered(click(1))
      await until(() => existsSync(path.join(bin, 'given-0')) && readFileSync(path.join(bin, 'given-0'), 'utf8').length > 0)
      const first = readFileSync(path.join(bin, 'given-0'), 'utf8')
      expect(first).toContain('[action click-1]')
      expect(first).toContain('The person stopped this conversation’s last turn')
      // Told once: the note is gone from the file, and a conversation nobody stopped is told nothing of the kind
      await until(() => !existsSync(path.join(home, 'stopped.json')))
      offered(click(2))
      await until(() => existsSync(path.join(bin, 'given-1')) && readFileSync(path.join(bin, 'given-1'), 'utf8').length > 0)
      expect(readFileSync(path.join(bin, 'given-1'), 'utf8')).not.toContain('The person stopped this conversation’s last turn')
    },
  )

  test('a conversation reopened for a click is ended when this machine’s hold on the click is lost, the click is not handed over from here, and the conversation is told the next time that its turn was cut off', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    // Codex's own command, which takes what it is given and then works for a long while
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nn=$(ls ${bin} | grep -c given)\ncat > ${bin}/given-$n\necho $$ > ${bin}/pid-$n\nexec sleep 120\n`, {
      mode: 0o755,
    })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    // The backend says, each time it is asked to keep the hold up, that the click is held here no more, and that it is another's by now
    stand.answer = (name, args) => (name === 'delivery:renew' ? [] : name === 'delivery:lost' ? args.ids : undefined)
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'pid-0')) && readFileSync(path.join(bin, 'pid-0'), 'utf8').trim() !== '')
    const its = Number(readFileSync(path.join(bin, 'pid-0'), 'utf8'))
    const gone = () => {
      try {
        process.kill(its, 0)
        return false
      } catch {
        return true
      }
    }
    // At the next renewal the run is ended, and said to have been ended for that
    for (let n = 0; n < 400 && !gone(); n++) await new Promise((r) => setTimeout(r, 50))
    expect(gone()).toBe(true)
    await until(() => said.some((line) => line.includes('hold on what it was reopened for was lost')))
    await until(() => stand.calls.some((c) => c.name === 'machines:runEnded'))
    // It is not this machine's any more: not said to be handed over. Giving it back is asked, which It answers by doing nothing where the click is another's
    expect(called('delivery:handedOff')).toEqual([])
    await until(() => called('delivery:release').includes('click-1'))
    // The turn was cut off, and that is owed to the conversation: written down, and said when it is reopened for the same thing again
    expect(JSON.parse(readFileSync(path.join(home, 'cut-off.json'), 'utf8'))).toEqual(['codex:thread-1'])
    stand.answer = null
    offered()
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given-1')) && readFileSync(path.join(bin, 'given-1'), 'utf8').length > 0, 20_000)
    expect(readFileSync(path.join(bin, 'given-1'), 'utf8')).toContain('was cut off before it ended')
  }, 60_000)

  test('a click that its agent said was done, with `it ack`, while the conversation it was reopened for is still at work is not taken for a hold that was lost: the turn goes on', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    // Codex's own command, at work for longer than it takes the hold to be asked about
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\necho $$ > ${bin}/pid\nsleep 13\necho done > ${bin}/finished\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    // As the backend answers once the click was handed over by the agent itself: held here no more, and nobody else's to deliver
    stand.answer = (name) => (name === 'delivery:renew' || name === 'delivery:lost' ? [] : undefined)
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'finished')), 30_000)
    expect(called('delivery:lost')).toEqual(['click-1'])
    expect(said.filter((line) => line.includes('hold on what it was reopened for was lost'))).toEqual([])
    // Asked about once, and not kept up from then on: there is nothing of it left to keep
    expect(called('delivery:renew')).toEqual(['click-1'])
  }, 60_000)

  test('an answer about a hold that comes after its turn is over ends nothing of the turn that is running by then', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    // The first turn outlasts one asking about its hold and then ends; the second is at work for a long while
    writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\nn=$(ls ${bin} | grep -c given)\ncat > ${bin}/given-$n\necho $$ > ${bin}/pid-$n\nif [ "$n" = 0 ]; then sleep 11; exit 0; fi\nexec sleep 120\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    // The first asking about the hold is not answered until the test says so
    let answerLate: ((kept: string[]) => void) | null = null
    stand.answer = (name) => (name === 'delivery:renew' && !answerLate ? new Promise<string[]>((r) => (answerLate = r)) : undefined)
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => answerLate !== null, 25_000)
    // The first turn ends by itself, and the conversation is reopened for something else
    await until(() => called('delivery:handedOff').includes('click-1'), 25_000)
    stand.answer = (name, args) => (name === 'delivery:lost' ? args.ids : undefined)
    offered({ ...click(2), session: click(1).session })
    await until(() => existsSync(path.join(bin, 'pid-1')) && readFileSync(path.join(bin, 'pid-1'), 'utf8').trim() !== '', 25_000)
    const second = Number(readFileSync(path.join(bin, 'pid-1'), 'utf8'))
    // Now the answer about the first turn's hold arrives: held no more, as it would be of a click that was handed over
    answerLate!([])
    await new Promise((r) => setTimeout(r, 1500))
    expect(() => process.kill(second, 0)).not.toThrow()
    expect(said.filter((line) => line.includes('hold on what it was reopened for was lost'))).toEqual([])
  }, 90_000)

  test('a connector that is stopping starts nothing that stood in line behind the turn it ends, and gives it back', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nn=$(ls ${bin} | grep -c given)\ncat > ${bin}/given-$n\nexec sleep 120\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given-0')) && readFileSync(path.join(bin, 'given-0'), 'utf8').length > 0)
    // Something else for the same conversation, done while it is at work: it stands in line behind the turn
    offered(click(1), { ...click(2), session: click(1).session })
    await new Promise((r) => setTimeout(r, 1500))
    await stop?.()
    stop = null
    // The turn that was running was ended and given back, and no second one was ever begun
    expect(existsSync(path.join(bin, 'given-1'))).toBe(false)
    expect(called('delivery:release')).toContain('click-1')
    expect(called('delivery:handedOff')).toEqual([])
    expect(JSON.parse(readFileSync(path.join(home, 'cut-off.json'), 'utf8'))).toEqual(['codex:thread-1'])
  }, 60_000)

  test('a conversation is not reopened where its run cannot be written down: the app is ended before it is given anything, and the page is told why', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexec sleep 120\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    // Where the note of runs is kept there is now a folder, so that no file can be given that name
    mkdirSync(path.join(home, 'runs.json', 'in-the-way'), { recursive: true })
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'), 25_000)
    expect(stand.calls.find((c) => c.name === 'machines:wakeFailed')!.args.why).toContain('could not be noted down')
    // It was given nothing: what it would have read is still unread, or it never got as far as reading
    expect(existsSync(path.join(bin, 'given')) ? readFileSync(path.join(bin, 'given'), 'utf8') : '').toBe('')
    expect(called('delivery:handedOff')).toEqual([])
  }, 60_000)

  test('a stop that It tells of is the stop of the run It names: one of the run before, heard late, does not end the run that has begun since', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexec sleep 120\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    stand.closed.add('thread-1')
    const me = (runs: unknown[]) => stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }], runs })
    me([])
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0, 25_000)
    // It was told of the run by a name of its own
    const name = stand.calls.find((c) => c.name === 'machines:runBegan')!.args.run as string
    expect(name).toMatch(/^[0-9a-f-]{36}$/)
    const ended = () => stand.calls.filter((c) => c.name === 'machines:runEnded').map((c) => c.args.run)
    // What It says of a stopped run of another name, or of none, is not about this one
    me([{ harness: 'codex', sessionId: 'thread-1', stop: true, run: 'the-run-before' }])
    me([{ harness: 'codex', sessionId: 'thread-1', stop: true }])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(ended()).toEqual([])
    expect(said.some((line) => line.includes('was stopped by the person'))).toBe(false)
    // The stop of this very run ends it, and It is told that the run of that name is over
    me([{ harness: 'codex', sessionId: 'thread-1', stop: true, run: name }])
    await until(() => ended().length > 0, 25_000)
    expect(ended()).toEqual([name])
    expect(said.some((line) => line.includes('was stopped by the person'))).toBe(true)
  }, 90_000)

  test('a conversation that a connector which died left running is ended, with what it had started, before anything is handed out, and is told that its turn was cut off', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given-$(ls ${bin} | grep -c given)\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    // What the connector before left: an agent in a group of its own, in the middle of a command of its own
    const mark = path.join(folder, 'its-command.pid')
    const left = spawn('sh', ['-c', `sh -c 'echo $$ > "${mark}"; exec sleep 300' & wait`], { detached: true, stdio: 'ignore' })
    left.unref()
    await until(() => existsSync(mark) && readFileSync(mark, 'utf8').trim() !== '')
    const its = Number(readFileSync(mark, 'utf8'))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // And a note of a process that is long gone, whose number another may have by now: nothing is done about that one
    await start('socket', {}, (home) => {
      noteConversation({ harness: 'codex', id: 'thread-1' }, folder)
      writeFileSync(
        path.join(home, 'runs.json'),
        JSON.stringify({
          'codex:thread-1': { pid: left.pid, since: identity([left.pid!]).get(left.pid!), told: SINCE_TOLD },
          'codex:thread-2': { pid: process.pid, since: 'Thu Jan  1 00:00:00 1970', told: SINCE_TOLD },
        }),
      )
    })
    // By the time it is up, both the agent and its command are gone, and this program, whose number the other note held, is not
    expect([alive(left.pid!), alive(its), alive(process.pid)]).toEqual([false, false, true])
    expect(existsSync(path.join(home, 'runs.json'))).toBe(false)
    expect(said.some((line) => /^a codex conversation \([0-9a-f]{8}\) was still running from before this started/.test(line))).toBe(true)
    // Reopened for the same thing, it is told that its turn was cut off
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given-0')) && readFileSync(path.join(bin, 'given-0'), 'utf8').length > 0)
    expect(readFileSync(path.join(bin, 'given-0'), 'utf8')).toContain('was cut off before it ended')
    // Told, it is owed the note no more. The other conversation, whose run was noted and is gone, is still owed it:
    // a run that was never said to be over did not end as a turn ends
    await until(() => JSON.stringify(readJson(path.join(home, 'cut-off.json'))) === JSON.stringify(['codex:thread-2']))
  }, 30_000)

  test('two things done for one conversation, under the id it had before it was cleared and the one it has now, are handed over one after the other', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    // Codex's own command, which takes a while over each turn and notes when each began and ended
    writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\nn=$(ls ${bin} | grep -c began)\ncat > /dev/null\ntouch ${bin}/began-$n\nsleep 1.5\ntouch ${bin}/ended-$n\nexit 0\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, (home) => {
      noteConversation({ harness: 'codex', id: 'thread-new' }, folder)
      writeFileSync(path.join(home, 'aliases.json'), JSON.stringify({ 'codex:thread-old': 'codex:thread-new' }))
    })
    stand.closed.add('thread-new')
    stand.closed.add('thread-old')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    const under = (id: string, session: string) => ({ ...click(1), id, session: { harness: 'codex', id: session } })
    offered(under('click-old', 'thread-old'), under('click-new', 'thread-new'))
    await until(() => existsSync(path.join(bin, 'began-0')), 20_000)
    // While the first is being handed over, the second is not so much as asked for: it stands in the same line
    expect(called('delivery:claim').filter((id) => id === 'click-old' || id === 'click-new')).toHaveLength(1)
    await until(() => existsSync(path.join(bin, 'ended-0')), 20_000)
    await until(() => existsSync(path.join(bin, 'began-1')), 30_000)
    expect(
      called('delivery:claim')
        .filter((id) => id === 'click-old' || id === 'click-new')
        .sort(),
    ).toEqual(['click-new', 'click-old'])
  }, 90_000)

  test('a machine whose clock is behind It’s reopens a conversation as soon as one whose clock is right, and does not wait out the difference', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    // By It's clock the click was made a moment ago, which by this machine's is three quarters of a minute from now
    const began = Date.now()
    offered({ ...click(1), at: began + 45_000 })
    await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0, 20_000)
    expect(Date.now() - began).toBeLessThan(15_000)
  }, 60_000)

  test('a run that a person stopped while no connector was there to hear is told, the next time, that it was stopped, and not that it was cut off', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    // The connector before died with a run noted, which is gone by now
    await start('socket', {}, (home) => {
      noteConversation({ harness: 'codex', id: 'thread-1' }, folder)
      writeFileSync(path.join(home, 'runs.json'), JSON.stringify({ 'codex:thread-1': { pid: 2 ** 22 - 3, since: 'tick 1', told: SINCE_TOLD } }))
    })
    expect(readJson(path.join(home, 'cut-off.json'))).toEqual(['codex:thread-1'])
    // It still has the run down, and as one a person asked to have stopped: they pressed Stop while this machine's connector was away
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({
      wanted: ['codex'],
      wakes: [{ harness: 'codex', since: Date.now() - 60_000 }],
      runs: [{ harness: 'codex', sessionId: 'thread-1', stop: true, run: 'the-run-before' }],
    })
    await until(() => JSON.stringify(readJson(path.join(home, 'stopped.json'))) === JSON.stringify(['codex:thread-1']))
    expect(existsSync(path.join(home, 'cut-off.json'))).toBe(false)
    // And It is told that the run is over, by its name
    await until(() => stand.calls.some((c) => c.name === 'machines:runEnded' && c.args.run === 'the-run-before'))
    // The next thing done reopens the conversation, which is told that its last turn was stopped
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0, 40_000)
    const given = readFileSync(path.join(bin, 'given'), 'utf8')
    expect(given).toContain(WAS_STOPPED)
    expect(given).not.toContain('was cut off before it ended')
  }, 90_000)

  test('a run from before stays noted, and its conversation held, for as long as the word that its turn was cut off cannot be written down', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    // A note of a run that is long gone, and a folder where the word of cut-off turns is kept, so that no file can be given that name
    await start('socket', {}, (home) => {
      noteConversation({ harness: 'codex', id: 'thread-1' }, folder)
      writeFileSync(
        path.join(home, 'runs.json'),
        JSON.stringify({ 'codex:thread-1': { pid: 2 ** 22 - 3, since: 'Thu Jan  1 00:00:00 1970', told: SINCE_TOLD } }),
      )
      mkdirSync(path.join(home, 'cut-off.json', 'in-the-way'), { recursive: true })
    })
    // The run is gone, and the note of it is all that says a turn was cut off: it is kept, and the conversation is held
    type Held = { held: { key: string }[] }
    expect(Object.keys(readJson<Record<string, unknown>>(path.join(home, 'runs.json')) ?? {})).toEqual(['codex:thread-1'])
    expect((await local<Held>('/runs'))?.held.map((r) => r.key)).toEqual(['codex:thread-1'])
    // A person cannot let it go either while that is so, and is told
    expect(await local('/runs', { method: 'POST', body: { clear: true, of: ['codex:thread-1'] } })).toEqual({ cleared: 0, unkept: true })
    expect((await local<Held>('/runs'))?.held.length).toBe(1)
    expect(existsSync(path.join(home, 'runs.json'))).toBe(true)
    // Once the word can be written, the next thing done for the conversation settles it, and its agent is told
    rmSync(path.join(home, 'cut-off.json'), { recursive: true, force: true })
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0, 40_000)
    expect(readFileSync(path.join(bin, 'given'), 'utf8')).toContain('was cut off before it ended')
    expect((await local<Held>('/runs'))?.held).toEqual([])
  }, 90_000)

  test('where the note of which conversations were running cannot be read, it is kept aside and no conversation is reopened until a person has taken it away', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    // A note with one line that is not as this program writes it: none of it is gone by
    await start('socket', {}, (home) => {
      noteConversation({ harness: 'codex', id: 'thread-1' }, folder)
      writeFileSync(path.join(home, 'runs.json'), JSON.stringify({ 'codex:thread-9': { pid: 'not a number' } }))
    })
    expect([existsSync(path.join(home, 'runs.json')), existsSync(path.join(home, 'runs.json.unreadable'))]).toEqual([false, true])
    expect(said.some((line) => line.includes('could not read its own note of which conversations were running'))).toBe(true)
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'), 25_000)
    expect(stand.calls.find((c) => c.name === 'machines:wakeFailed')!.args.why).toContain('run `it runs clear`')
    expect(existsSync(path.join(bin, 'given'))).toBe(false)
    // It says so when asked, and deleting the file alone changes nothing: the hold is this connector's own
    expect((await local<{ unread: boolean; held: unknown[] }>('/runs'))?.unread).toBe(true)
    rmSync(path.join(home, 'runs.json.unreadable'), { force: true })
    expect((await local<{ unread: boolean }>('/runs'))?.unread).toBe(true)
    // A word that names nothing the person was shown lets go of nothing
    expect(await local<{ cleared: number }>('/runs', { method: 'POST', body: { clear: true, of: [], unread: false } })).toEqual({ cleared: 0 })
    expect((await local<{ unread: boolean }>('/runs'))?.unread).toBe(true)
    // Let go of at the person's word, the conversation is reopened for what was waiting, and It is asked to give back what was set aside for it meanwhile
    const unparked = () => stand.calls.filter((c) => c.name === 'delivery:unpark').map((c) => c.args)
    const asked = unparked().length
    expect(await local<{ cleared: number }>('/runs', { method: 'POST', body: { clear: true, of: [], unread: true } })).toEqual({ cleared: 1 })
    expect((await local<{ unread: boolean }>('/runs'))?.unread).toBe(false)
    await until(() => unparked().length > asked)
    expect(unparked().at(-1)).toEqual({ for: { harness: 'codex', id: 'thread-1' } })
    offered()
    offered(click(1))
    await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0, 40_000)
  }, 90_000)

  test('a conversation is not reopened where reopening was switched off, or It could not be told of the run, while it was being got ready: nothing is started, and nothing is said to have been stopped', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    stand.closed.add('thread-1')
    const on = { wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] }
    stand.watching.get('machines:me')!(on)
    // The person switches reopening off while It is being told that the run begins
    let told = 0
    stand.answer = (name) => {
      if (name !== 'machines:runBegan') return undefined
      told++
      stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [] })
      return null
    }
    offered(click(1))
    await until(() => told === 1 && called('delivery:release').includes('click-1'))
    await new Promise((r) => setTimeout(r, 500))
    expect(existsSync(path.join(bin, 'given'))).toBe(false)
    expect([called('delivery:handedOff'), stand.calls.filter((c) => c.name === 'machines:wakeFailed').length]).toEqual([[], 0])
    expect(existsSync(path.join(home, 'stopped.json'))).toBe(false)
    expect(existsSync(path.join(home, 'cut-off.json'))).toBe(false)
    // Switched on again, and It cannot be told that the run begins: it is not started, and the page is told why
    stand.answer = (name) => (name === 'machines:runBegan' ? Promise.reject(new Error('no answer')) : undefined)
    stand.watching.get('machines:me')!(on)
    offered()
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'), 25_000)
    expect(stand.calls.find((c) => c.name === 'machines:wakeFailed')!.args.why).toContain('could not be told that the conversation was being reopened')
    expect(existsSync(path.join(bin, 'given'))).toBe(false)
  }, 60_000)

  test('a conversation is not reopened for something the person stopped while it was being got ready: It is told which clicks the run is for, and says so', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
    made.push(bin, folder)
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexit 0\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    stand.answer = (name) => (name === 'machines:runBegan' ? { stopped: true } : undefined)
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'machines:runBegan') && called('delivery:release').includes('click-1'))
    expect(stand.calls.find((c) => c.name === 'machines:runBegan')!.args.ids).toEqual(['click-1'])
    await new Promise((r) => setTimeout(r, 500))
    // Nothing was started, nothing is said to have failed, and nothing is noted as a turn that was stopped or cut off
    expect(existsSync(path.join(bin, 'given'))).toBe(false)
    expect([called('delivery:handedOff'), stand.calls.filter((c) => c.name === 'machines:wakeFailed').length]).toEqual([[], 0])
    expect(existsSync(path.join(home, 'stopped.json'))).toBe(false)
    expect(existsSync(path.join(home, 'cut-off.json'))).toBe(false)
  }, 60_000)

  test('a machine that joined an It of a version it does not fit hands nothing over and reopens nothing, can still be stopped, and goes on by itself once the two fit', async () => {
    // The It this machine joined, as its door says which version it speaks
    let speaks = PROTOCOL_VERSION + 1
    const door = http.createServer((req, res) =>
      req.url === '/cli/config'
        ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: speaks }))
        : res.writeHead(404).end(),
    )
    await new Promise<void>((r) => door.listen(0, '127.0.0.1', r))
    try {
      const at = `http://127.0.0.1:${(door.address() as { port: number }).port}`
      // That It has moved since this machine joined it: the address it joined at answers nobody, and
      // the machine has been told the new one, which is where it asks whether the two fit
      process.env.IT_URL = at
      await start('socket', {}, (home) => writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ at: 'http://127.0.0.1:9' })))
      expect(said.some((line) => line.includes('versions that do not work together') && line.includes('Nothing done on a page is handed to an agent'))).toBe(
        true,
      )
      expect((await local<{ ok: boolean; unfit?: string }>('/health'))?.unfit).toContain('versions that do not work together')
      // It is told with the machine's report, so that the site says it beside the machine and on its pages
      const reported = () => stand.calls.filter((c) => c.name === 'machines:report').map((c) => c.args.paused)
      await until(() => reported().includes('unfit'))
      // Something is done on a page whose conversation is open and listening: it is left where it is
      await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1' } })
      offered(click(1))
      await new Promise((r) => setTimeout(r, 2500))
      expect(called('delivery:claim')).toEqual([])
      // The It it joined is updated, or this machine is: asked again within the minute, and the click is taken
      speaks = PROTOCOL_VERSION
      await until(() => called('delivery:claim').includes('click-1'), 75_000)
      expect(said.some((line) => line.includes('fit again'))).toBe(true)
      expect((await local<{ ok: boolean; unfit?: string }>('/health'))?.unfit).toBeUndefined()
      await until(() => reported().at(-1) === '')
    } finally {
      delete process.env.IT_URL
      await new Promise((r) => door.close(r))
    }
  }, 120_000)

  test('the note of a stop is let go once a turn begins in that conversation which It did not start: the person is in it themselves, and what they stopped is no longer its last turn', async () => {
    await start('socket', {}, (home) => writeFileSync(path.join(home, 'stopped.json'), JSON.stringify(['codex:thread-1', 'codex:thread-2'])))
    const noted = () => JSON.parse(readFileSync(path.join(home, 'stopped.json'), 'utf8'))
    // An add-on that says only that its conversation is there, or that a turn has ended, lets go of nothing
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1' } })
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1', busy: false } })
    expect(noted()).toEqual(['codex:thread-1', 'codex:thread-2'])
    // A turn begins there, in a conversation the person opened: its note goes, and the other's stays
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1', busy: true } })
    expect(noted()).toEqual(['codex:thread-2'])
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-2', busy: true } })
    expect(existsSync(path.join(home, 'stopped.json'))).toBe(false)
  })

  test('asked to stop, the connector tells It that its machine is going, so that its pages wait for the machine at once', async () => {
    await start()
    expect(stand.calls.some((c) => c.name === 'machines:report')).toBe(true)
    expect(stand.calls.some((c) => c.name === 'machines:stopping')).toBe(false)
    await stop?.()
    stop = null
    expect(stand.calls.filter((c) => c.name === 'machines:stopping')).toHaveLength(1)
    expect(said.at(-1)).toBe('stopped')
  })

  test('a click whose reopening failed is put in Codex’s queue at once when its conversation is opened, without waiting out the pause', async () => {
    await start()
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'delivery:release'))
    await settled()
    expect(stand.codex).toEqual([])
    // The person opens the conversation in Codex. The click is still on offer, and the pause before the next reopening has ten seconds to run.
    stand.closed.clear()
    offered(click(1))
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain('--thread=thread-1')
  })

  test('what this machine gave up on for a conversation is tried again when that conversation is heard from, and It is asked to give back what was set aside', async () => {
    await start()
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    // Its reopening comes to nothing (this machine was never told its folder), and the pause before the next try has begun
    offered(click(1))
    await until(() => stand.calls.some((c) => c.name === 'delivery:release'))
    await settled()
    const tries = () => stand.calls.filter((c) => c.name === 'machines:wakeFailed').length
    expect(tries()).toBe(1)
    // The person opens the conversation in Codex, and a hook of its turn says so
    stand.calls.length = 0
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-1' } })
    await until(() => stand.calls.some((c) => c.name === 'delivery:unpark'))
    expect(stand.calls.find((c) => c.name === 'delivery:unpark')!.args).toEqual({ for: { harness: 'codex', id: 'thread-1' } })
    // And the click, still on offer, is tried at once: no pause is waited out
    offered(click(1))
    await until(() => tries() === 1 || stand.codex.length === 1)
    expect(tries() + stand.codex.length).toBe(1)
  })

  test('one whose claim is answered after the waiter began is given back, and never reaches Codex', async () => {
    await start()
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offered(click(7))
    await until(() => called('delivery:claim').includes('click-7'))
    expect(await waitingFor(7)).toMatchObject({ ok: true })
    answerClaim(['click-7'])
    await until(() => called('delivery:release').includes('click-7'))
    await settled()
    expect(stand.codex).toEqual([])
  })

  test('one that Codex’s command already has is given to the waiter as well, and a refusal by the command is then no failure', async () => {
    await start()
    offered(click(5))
    await until(() => stand.codex.length === 1)
    // The command has been started and has not answered: the waiter is given the click itself
    expect((await waitingFor(5))?.clicks?.map((c) => c.id)).toEqual(['click-5'])
    stand.codex[0]!.end(Object.assign(new Error('refused'), { code: 1 }))
    await settled()
    // Nothing is given back or set aside from here: the waiter has it, and says so to It itself
    expect(called('delivery:release')).toEqual([])
    expect(called('delivery:park')).toEqual([])
  })

  const turn = (n: number, busy: boolean) => local('/session', { method: 'POST', body: { harness: 'codex', session: `thread-${n}`, busy } })
  /** Offers a click, lets Codex's command take it, and waits until It has been told so. */
  const takenByTheQueue = async (n: number) => {
    const commands = stand.codex.length
    offered(click(n))
    await until(() => stand.codex.length === commands + 1)
    stand.codex[commands]!.end()
    await until(() => called('delivery:handedOff').includes(`click-${n}`))
    // It has stopped having the click down as waiting, so only the connector can still give it to anyone
    offered()
  }

  test('a Codex turn that ended with no hook to say so, its Codex closed in the middle of it, is not taken for running', async () => {
    await start()
    // A hook says a turn has begun, and none ever says that it ended: the person interrupted it and quit Codex
    await turn(1, true)
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    // The click goes the way of a closed conversation at once, which here ends at its folder not
    // being known. Kept for the hook of a turn that is not running, that came a minute later.
    await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'), 5000)
    expect(stand.codex).toEqual([])
  })

  test('more than one answer can carry is given to a waiter over several askings, each click once and none lost', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    // Thirty-four clicks that each carry as much as a click may, taken by Codex’s queue behind the turn that is running
    const carried = JSON.stringify('x'.repeat(31_000))
    const ids: string[] = []
    for (let i = 0; i < 34; i++) {
      const commands = stand.codex.length
      ids.push(`click-big-${i}`)
      offered({ ...click(6), id: ids[i]!, payload: carried })
      await until(() => stand.codex.length === commands + 1)
      stand.codex[commands]!.end()
      await until(() => called('delivery:handedOff').includes(ids[i]!))
      offered()
    }
    // Together they are over a megabyte, which is more than a waiter reads of one answer
    expect(ids.length * carried.length).toBeGreaterThan(1_000_000)
    const given: string[] = []
    for (let asked = 0; asked < 5 && given.length < ids.length; asked++) {
      const answer = await waitingFor(6)
      // Each answer is one the waiter can read: none is refused for its size
      expect(answer?.ok).toBe(true)
      given.push(...(answer?.clicks ?? []).map((c) => c.id))
    }
    expect(given.length).toBe(ids.length)
    expect([...given].sort()).toEqual([...ids].sort())
    // More than one asking was needed, and a further one is given nothing a second time
    expect((await waitingFor(6))?.clicks).toBeUndefined()
  }, 60_000)

  test('one that Codex’s queue took while the conversation’s turn was running is given to a waiter that begins in that turn, and only once', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    await takenByTheQueue(6)
    // Codex hands the click over only when the turn is done, and the turn is now waiting for the click
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    expect((await waitingFor(6))?.clicks).toBeUndefined()
    // It was told once, by the queue, that the click was handed over
    expect(called('delivery:handedOff')).toEqual(['click-6'])
  })

  test('one that Codex’s queue took is not given to a waiter once the turn has ended or another has begun, nor when no turn was running', async () => {
    await start()
    // The turn ends: Codex now starts one with the click, and the agent has it from Codex
    await turn(4, true)
    await takenByTheQueue(4)
    await turn(4, false)
    expect((await waitingFor(4))?.clicks).toBeUndefined()
    // Another turn begins, which is the one Codex started with the click
    await turn(2, true)
    await takenByTheQueue(2)
    await turn(2, true)
    expect((await waitingFor(2))?.clicks).toBeUndefined()
    // The conversation was not working, so Codex started a turn with the click at once
    await takenByTheQueue(1)
    expect((await waitingFor(1))?.clicks).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('an agent app that is not connected', () => {
  const click = (harness: string, n: number) => ({
    id: `click-${n}`,
    artifact: `page-${n}`,
    title: 'A page',
    name: 'approve',
    payload: '{}',
    at: Date.now() - 10_000 + n,
    attended: true,
    session: { harness, id: `conversation-${n}` },
  })
  const offered = (...clicks: ReturnType<typeof click>[]) => stand.watching.get('delivery:inbox')!(clicks)
  const called = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
  const session = (harness: string, n: number, more: Record<string, unknown> = {}) =>
    local('/session', { method: 'POST', body: { harness, session: `conversation-${n}`, ...more } })
  const clicksFor = (harness: string, n: number) => local<{ clicks: { id: string }[] }>(`/clicks?harness=${harness}&session=conversation-${n}`)

  test('with none connected, Codex’s own command is never run for a click, and the connector asks It for no click of Codex’s queue', async () => {
    standIn()
    // Codex is on the machine, with nothing of It's in it, and the person chose no app
    await start('socket', { wanted: [], found: [{ id: 'codex', version: '1.0.0', addon: 'not_connected' }] })
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [], queues: [] })
    // Should a click for a Codex conversation be offered all the same, it is left where it is:
    // when it is offered, and at each pass the connector makes afterwards
    offered(click('codex', 1))
    await settled()
    await pass(2)
    expect(stand.codex).toEqual([])
    expect(called('delivery:claim')).toEqual([])
  })

  test('before It has said which apps the person chose, none is taken to be connected', async () => {
    standIn()
    await start('socket', { wanted: ['codex'] })
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [], queues: ['codex'] })
    await stop?.()
    stop = null
    stand.watching.clear()
    stand.asking.clear()
    // The same machine, with It not yet heard from
    home = mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
    process.env.IT_HOME = home
    const had = new Set(process.listeners('SIGTERM'))
    const running = runConnector((line) => said.push(line))
    await until(() => existsSync(infoFile()) && stand.watching.has('delivery:inbox'))
    stop = async () => {
      ;(process.listeners('SIGTERM').find((l) => !had.has(l)) as (signal: string) => void)('SIGTERM')
      await running
    }
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [], queues: [] })
    offered(click('codex', 2))
    await settled()
    await pass(2)
    expect(stand.codex).toEqual([])
    expect(called('delivery:claim')).toEqual([])
  })

  test('an app the person chose is not run either while It’s add-on is not in it: one that is too old, or has the add-on switched off', async () => {
    standIn()
    for (const addon of ['too_old', 'not_connected', 'unavailable', 'error']) {
      await start('socket', { wanted: ['codex'], found: [{ id: 'codex', version: '1.0.0', addon }] })
      expect([addon, stand.asking.get('delivery:inbox')]).toEqual([addon, { listening: [], queues: [] }])
      offered(click('codex', 3))
      await settled()
      await pass(2)
      expect([addon, stand.codex.length, called('delivery:claim')]).toEqual([addon, 0, []])
      await stop?.()
      stop = null
    }
    // One whose hooks the person has still to approve is connected, and its queue is how a click reaches it until they have
    await start('socket', { wanted: ['codex'], found: [{ id: 'codex', version: '1.0.0', addon: 'needs_approval' }] })
    offered(click('codex', 4))
    await until(() => stand.codex.length === 1)
  })

  test('an add-on that asks from an app the person did not choose is answered and given nothing, and its conversation is not listened for', async () => {
    standIn()
    await start('socket', { wanted: ['codex'] })
    expect(await session('pi', 5)).toEqual({ ok: true })
    expect(await clicksFor('pi', 5)).toEqual({ clicks: [] })
    expect((await local<{ sessions: string[] }>('/health'))?.sessions).toEqual([])
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [], queues: ['codex'] })
    offered(click('pi', 5))
    await settled()
    await pass(2)
    expect(called('delivery:claim')).toEqual([])
    // It is said once, by the app's own name and nothing of the conversation's
    expect(said.filter((line) => line.includes('is not connected here'))).toEqual([
      'a pi conversation asked for its clicks, and that app is not connected here; it is given none',
    ])
    // Chosen, the same add-on is listened for and given its click
    wants(['codex', 'pi'])
    expect(await session('pi', 5)).toEqual({ ok: true })
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [{ harness: 'pi', id: 'conversation-5' }], queues: ['codex'] })
    offered(click('pi', 5))
    await until(() => called('delivery:claim').includes('click-5'))
    expect((await clicksFor('pi', 5))?.clicks.map((c) => c.id)).toEqual(['click-5'])
  })

  test('a click held for an add-on goes back to waiting when the person disconnects its app, and Codex’s command is not run for one that stood in line', async () => {
    await start()
    await session('pi', 6)
    offered(click('pi', 6))
    await until(() => called('delivery:claim').includes('click-6'))
    expect((await local<{ held: number }>('/health'))?.held).toBe(1)
    // Three of Codex's commands may run at once, so a fourth click stands in line behind them
    offered(click('pi', 6), click('codex', 10), click('codex', 11), click('codex', 12), click('codex', 13))
    await until(() => stand.codex.length === 3)
    wants([])
    await until(() => called('delivery:release').includes('click-6'))
    expect((await local<{ held: number }>('/health'))?.held).toBe(0)
    expect(stand.asking.get('delivery:inbox')).toEqual({ listening: [], queues: [] })
    expect((await clicksFor('pi', 6))?.clicks).toEqual([])
    // A place comes free for the click that stood in line, and Codex is not run for it
    stand.codex[0]!.end()
    await settled()
    expect(stand.codex.length).toBe(3)
    expect(called('delivery:claim')).not.toContain('click-13')
  })

  test('a click that was being claimed for an add-on when the person disconnected its app is not handed to the add-on that was asking, and goes back to waiting', async () => {
    await start()
    // The click is there before its conversation is heard from, so nothing is done with it yet
    offered(click('pi', 8))
    await settled()
    expect(called('delivery:claim')).toEqual([])
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    // The add-on asks, and its asking is what has the click claimed for it
    const asking = clicksFor('pi', 8)
    await until(() => called('delivery:claim').includes('click-8'))
    // While It is still answering the claim, the person disconnects the app
    wants(['codex'])
    answerClaim(['click-8'])
    expect((await asking)?.clicks).toEqual([])
    await until(() => called('delivery:release').includes('click-8'))
    expect((await local<{ held: number }>('/health'))?.held).toBe(0)
    expect((await clicksFor('pi', 8))?.clicks).toEqual([])
  })

  test('a click already kept for an add-on is not handed to it when the person disconnects its app while the add-on’s asking is being answered', async () => {
    // Every wait of the connector's is a stand-in here: no pass of its own runs unless the test
    // says, and an asking is answered when the test has the moment it is given go by
    standIn(true)
    await start()
    // One click is kept for a conversation that is listening, and another waits for a conversation not heard from yet
    await session('pi', 20)
    offered(click('pi', 20))
    await until(() => called('delivery:claim').includes('click-20'))
    offered(click('pi', 20), click('pi', 21))
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    // The second conversation is heard from, and the first one's add-on asks: answering it begins
    // with a pass that claims the second click, and It is slow to answer that
    await session('pi', 21)
    let answered = false
    const asking = clicksFor('pi', 20).finally(() => (answered = true))
    await until(() => called('delivery:claim').includes('click-21'))
    // The person disconnects the app, and then the moment the add-on's asking is given goes by with It still not heard from
    wants(['codex'])
    await settled()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(300)
    expect((await asking)?.clicks).toEqual([])
    // The click that was being claimed goes back when It answers, and the one that was kept at the connector's next pass
    answerClaim(['click-21'])
    await settled()
    expect(called('delivery:release')).toEqual(['click-21'])
    await pass()
    expect(called('delivery:release').sort()).toEqual(['click-20', 'click-21'])
    expect((await local<{ held: number }>('/health'))?.held).toBe(0)
  })

  test('a click that was being claimed for a running Codex turn’s next hook when the person disconnected Codex is not handed to that hook', async () => {
    await start()
    // A turn is running, and the click is fresh: it is kept for the turn's next hook, which asks as an add-on does
    await session('codex', 9, { busy: true })
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offered({ ...click('codex', 9), at: Date.now() })
    await until(() => called('delivery:claim').includes('click-9'))
    wants(['pi'])
    answerClaim(['click-9'])
    await until(() => called('delivery:release').includes('click-9'))
    expect((await clicksFor('codex', 9))?.clicks).toEqual([])
    expect((await local<{ held: number }>('/health'))?.held).toBe(0)
    expect(stand.codex).toEqual([])
  })

  test('a click that was being claimed for Codex’s own queue when the person disconnected Codex is given back, and Codex’s command is never run for it', async () => {
    await start()
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offered(click('codex', 14))
    await until(() => called('delivery:claim').includes('click-14'))
    wants(['pi'])
    answerClaim(['click-14'])
    await until(() => called('delivery:release').includes('click-14'))
    await settled()
    expect(stand.codex).toEqual([])
  })

  test('a click whose keeping was being renewed when the person disconnected its app goes back to waiting, and is handed to nothing', async () => {
    await start()
    await session('pi', 15)
    offered(click('pi', 15))
    await until(() => called('delivery:claim').includes('click-15'))
    // The add-on has asked and been given it, and goes on asking, so the click is kept and its keeping renewed
    expect((await clicksFor('pi', 15))?.clicks.map((c) => c.id)).toEqual(['click-15'])
    let answerRenewal: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:renew' ? new Promise<string[]>((r) => (answerRenewal = r)) : undefined)
    const asking = setInterval(() => void session('pi', 15), 500)
    try {
      await until(() => called('delivery:renew').includes('click-15'), 25_000)
      wants(['codex'])
      answerRenewal(['click-15'])
      await until(() => called('delivery:release').includes('click-15'))
      expect((await local<{ held: number }>('/health'))?.held).toBe(0)
      expect((await clicksFor('pi', 15))?.clicks).toEqual([])
    } finally {
      clearInterval(asking)
    }
  }, 40_000)

  test('an agent that waits for a click still gets it there, connected or not', async () => {
    await start('socket', { wanted: [] })
    const waiting = await local<{ ok: boolean; sessions?: { harness: string; id: string }[] }>('/waiting', {
      method: 'POST',
      body: { id: 'waiter-7', session: { harness: 'codex', id: 'conversation-7' } },
    })
    expect(waiting).toEqual({ ok: true, sessions: [{ harness: 'codex', id: 'conversation-7' }] })
    expect(await local('/waiting', { method: 'POST', body: { id: 'waiter-8', slug: 'page-8' } })).toEqual({ ok: true })
  })
})

describe.skipIf(process.platform === 'win32')('what the connector writes down when something goes wrong', () => {
  const session = { harness: 'pi', id: 'conversation-1' }
  const offer = () =>
    stand.watching.get('delivery:inbox')!([
      { id: 'click-1', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session },
    ])
  /** The line the connector writes when asking It for a click fails with this error. */
  const written = async (err: unknown) => {
    await start()
    await local('/session', { method: 'POST', body: { harness: 'pi', session: 'conversation-1' } })
    stand.answer = (name) => (name === 'delivery:claim' ? Promise.reject(err) : undefined)
    offer()
    await until(() => said.some((line) => line.startsWith('delivery: ')))
    const line = said.find((line) => line.startsWith('delivery: '))!
    await stop?.()
    stop = null
    said.length = 0
    return line
  }

  test('a refusal’s code, a system’s code and a kind of error are written as they are', async () => {
    expect(await written(Object.assign(new Error('no'), { data: { code: 'rate_limited' } }))).toBe('delivery: rate_limited')
    expect(await written(Object.assign(new Error('no'), { code: 'ECONNREFUSED' }))).toBe('delivery: ECONNREFUSED')
    expect(await written(new TypeError('/home/chris/plans could not be read'))).toBe('delivery: TypeError')
  })

  test('a code or a name that is not one word is not written: it could repeat a folder’s name or what a person typed', async () => {
    expect(await written(Object.assign(new Error('no'), { code: '/home/chris/My Plans' }))).toBe('delivery: Error')
    expect(await written(Object.assign(new Error('no'), { code: 'a b', name: 'Chris’s plan failed' }))).toBe('delivery: error')
    expect(await written(Object.assign(new Error('no'), { data: '{"code":"not_found","message":"C:\\Users\\Chris"}' }))).toBe('delivery: not_found')
    expect(await written('the plan for Chris')).toBe('delivery: error')
  })
})

describe.skipIf(process.platform === 'win32')('what a caller wrote as the thing it asks for', () => {
  const PRIVATE = 'PRIVATE-NAME-of-a-plan'
  /** Sends a request by the bytes, with the connector's token, and gives the status it was answered with. */
  const asked = (info: ConnectorInfo, first: string, body = '') =>
    new Promise<number>((resolve, reject) => {
      const socket = net.connect({ path: info.socket! })
      let got = ''
      socket
        .on('data', (piece) => (got += piece))
        .on('error', reject)
        .on('close', () => resolve(Number(got.split(' ')[1])))
      socket.write(
        `${first} HTTP/1.1\r\nHost: local\r\nConnection: close\r\nx-it-token: ${info.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    })

  test('is answered as no address when it is none, and is written into the log by neither that answer nor a fault', async () => {
    const info = await start()
    // Something that is no address at all, with a name in it that must go nowhere
    expect(await asked(info, `GET http://[${PRIVATE}`)).toBe(400)
    expect(await asked(info, `GET /${PRIVATE}?name=${PRIVATE}`)).toBe(404)
    // And a fault of the connector's own, on the way to answering a request that names the same thing: where it keeps the ids a conversation had cannot be written
    mkdirSync(path.join(home, 'aliases.json'))
    expect(await asked(info, `POST /session?name=${PRIVATE}`, JSON.stringify({ harness: 'pi', session: 'now', was: 'before' }))).toBe(500)
    const fault = said.find((line) => line.startsWith('a request to the connector failed'))
    expect(fault).toMatch(/^a request to the connector failed \(POST \/session: [A-Za-z][A-Za-z0-9_]*\)$/)
    expect(said.join('\n')).not.toContain(PRIVATE)
    expect(said.filter((line) => line.startsWith('a request to the connector failed'))).toHaveLength(1)
  })
})

describe.skipIf(process.platform === 'win32')('a click claimed for an add-on that is not the one to be given it after all', () => {
  test('one whose claim is answered after the waiter began is given back, and is not kept for the add-on', async () => {
    await start()
    const session = { harness: 'pi', id: 'conversation-1' }
    // The add-on is listening: it has just asked
    expect(await local('/session', { method: 'POST', body: { harness: 'pi', session: 'conversation-1' } })).toEqual({ ok: true })
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    stand.watching.get('delivery:inbox')!([
      { id: 'click-9', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session },
    ])
    const asked = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
    await until(() => asked('delivery:claim').includes('click-9'))
    expect(await local('/waiting', { method: 'POST', body: { id: 'waiter-9', session } })).toMatchObject({ ok: true })
    answerClaim(['click-9'])
    await until(() => asked('delivery:release').includes('click-9'))
    expect((await local<{ held: number }>('/health'))?.held).toBe(0)
  })

  test('a receipt for a click that is held here and has been given to nobody yet is not taken: it is an old one, from whoever had the click before it was claimed afresh', async () => {
    await start()
    const session = { harness: 'pi', id: 'conversation-1' }
    expect(await local('/session', { method: 'POST', body: { harness: 'pi', session: 'conversation-1' } })).toEqual({ ok: true })
    stand.watching.get('delivery:inbox')!([
      { id: 'click-5', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session },
    ])
    const asked = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
    for (let n = 0; n < 100 && (await local<{ held: number }>('/health'))?.held !== 1; n++) await new Promise((r) => setTimeout(r, 30))
    // Held for the conversation, which has not asked for it yet: a receipt that names it is not this hand-over's
    expect(await local('/ack', { method: 'POST', body: { ids: ['click-5'] } })).toEqual({ ok: true, acked: 0 })
    expect((await local<{ held: number }>('/health'))?.held).toBe(1)
    expect(asked('delivery:handedOff')).toEqual([])
    // Given out to its conversation, its receipt is taken
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=pi&session=conversation-1'))?.clicks.map((c) => c.id)).toEqual(['click-5'])
    expect(await local('/ack', { method: 'POST', body: { ids: ['click-5'] } })).toEqual({ ok: true, acked: 1 })
    await until(() => asked('delivery:handedOff').includes('click-5'))
  })

  test('a click held for a conversation is held no longer than It gives it, though this machine’s clock is set back meanwhile', async () => {
    await start()
    const session = { harness: 'pi', id: 'conversation-1' }
    expect(await local('/session', { method: 'POST', body: { harness: 'pi', session: 'conversation-1' } })).toEqual({ ok: true })
    stand.watching.get('delivery:inbox')!([
      { id: 'click-5', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session },
    ])
    for (let n = 0; n < 100 && (await local<{ held: number }>('/health'))?.held !== 1; n++) await new Promise((r) => setTimeout(r, 30))
    expect((await local<{ held: number }>('/health'))?.held).toBe(1)
    // From here It cannot be reached to make the hold good again, and gives the click to another machine when its half minute
    // is over: it is no longer among what It offers this one
    stand.answer = (name) => (name === 'delivery:renew' ? Promise.reject(new Error('no answer')) : undefined)
    stand.watching.get('delivery:inbox')!([])
    expect((await local<{ held: number }>('/health'))?.held).toBe(1)
    const began = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // The machine's clock is set back a minute, which a pass of the connector sees, and then more than half a minute goes by
      vi.setSystemTime(began - 60_000)
      await new Promise((r) => setTimeout(r, 1500))
      vi.setSystemTime(began - 60_000 + 31_000)
      await until(
        () =>
          said.some(
            (line) =>
              line.includes('click click-5 is not this machine’s to deliver any more') ||
              line.includes("click click-5 is not this machine's to deliver any more"),
          ),
        10_000,
      )
      // By its own clock the hold had most of a minute left. It is not believed: nothing is given to the add-on that asks
      expect((await local<{ held: number }>('/health'))?.held).toBe(0)
      expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=pi&session=conversation-1'))?.clicks).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  test('an add-on that went away while its asking was being answered is counted as given nothing: the click claimed for it meanwhile is not written down as handed over, and is handed to it when it asks again', async () => {
    const info = await start()
    const session = { harness: 'pi', id: 'conversation-1' }
    const click = { id: 'click-1', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session }
    const asked = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
    /** What the connector wrote down of the click, in the order it wrote it. */
    const journal = () =>
      (existsSync(path.join(home, 'journal.jsonl')) ? readFileSync(path.join(home, 'journal.jsonl'), 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; id: string })
        .filter((line) => line.id === 'click-1')
        .map((line) => line.event)
    // The click is there before its conversation is heard from, so nothing is done with it yet
    stand.watching.get('delivery:inbox')!([click])
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    // The add-on asks, by the bytes, on a connection of its own, and its asking is what has the click claimed for it
    const asking = net.connect({ path: info.socket! })
    asking.on('error', () => {})
    let answered = ''
    asking.on('data', (piece) => (answered += piece))
    asking.write(`GET /clicks?harness=pi&session=conversation-1 HTTP/1.1\r\nHost: local\r\nx-it-token: ${info.token}\r\n\r\n`)
    await until(() => asked('delivery:claim').includes('click-1'))
    // It goes away while It is still answering the claim, and the connector has heard that it has before the claim is answered
    asking.destroy()
    await local('/health')
    await local('/health')
    answerClaim(['click-1'])
    await until(async () => (await local<{ held: number }>('/health'))?.held === 1)
    // Whatever was to be done for that asking is done by the time another has been answered
    await local('/health')
    expect([journal(), answered]).toEqual([['claimed'], ''])
    // Asked again by an add-on that is there, the click is handed over, and that is written down
    stand.answer = null
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=pi&session=conversation-1'))?.clicks.map((c) => c.id)).toEqual(['click-1'])
    expect(journal()).toEqual(['claimed', 'served'])
  })
})
