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
import { MARK, PROTOCOL_VERSION, WAKE_BACK_MS } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ADDONS } from './src/addons.generated'
import { conversationFolder, conversationProfile, noteConversation } from './src/publish'
import * as wake from './src/wake'

const stand = vi.hoisted(() => ({
  /** What the connector watches the backend for, by the name of the function, and how to tell it something new. */
  watching: new Map<string, (value: any) => void>(),
  /** What it last asked to be told of, for each function it watches. */
  asking: new Map<string, any>(),
  /** What a look at this machine finds of its agent apps. */
  found: [] as { id: string; version?: string; addon: string }[],
  /** Every call the connector made to the backend. */
  calls: [] as { name: string; args: any }[],
  saving: new Set<Promise<void>>(),
  /** What a call answers, when the test wants something other than the usual. Undefined leaves it to the usual. */
  answer: null as null | ((name: string, args: any) => unknown),
  /** Every time Codex's own command was started, and how the test ends it. */
  codex: [] as { args: string[]; env?: NodeJS.ProcessEnv; end: (err?: unknown) => void }[],
  /** The Codex conversations that no Codex has open. Every other one is open somewhere, as it is in a window. */
  closed: new Set<string>(),
  failedWrites: new Set<string>(),
  savedRuns: [] as Record<string, unknown>[],
  unknown: new Set<string>(),
  profiles: true,
  /**
   * T3 Code as a test has it, which is not running unless the test says so: the thread each
   * conversation is held in, by the conversation's id; every time it was asked which thread
   * holds one, with how the test answers where it has told T3 Code to keep its answer back;
   * and what was put to its threads.
   */
  t3: {
    running: false,
    threads: new Map<string, string>(),
    slow: false,
    asked: [] as { ids: string[]; answer: (thread: string | null | undefined | Error | { status: 'limited' }, progressed?: boolean) => void }[],
    sent: [] as { thread: string; text: string }[],
    /** What T3 Code says where it will not take a message, and what it refused. */
    refusing: null as string | null,
    refused: [] as { thread: string; text: string }[],
    /** By each thread, the conversation it runs now and those it ran before, and every time it was asked which thread runs one. */
    runs: new Map<string, { now: { harness: string; id: string }; before: { harness: string; id: string }[] }>(),
    looked: [] as { harness: string; ids: string[]; known?: string }[],
  },
}))
// T3 Code is asked over its own server and its own command (t3.test.ts tries what is read from
// them). Here it is a stand-in, so that the way a click goes can be tried with T3 Code running.
vi.mock('./src/t3', () => ({
  t3Server: () => (stand.t3.running ? { origin: 'http://127.0.0.1:1', home: '/no-t3-code', program: 't3' } : undefined),
  t3ThreadOf: (_t3: unknown, of: { ids: readonly string[] }) =>
    new Promise<{ thread: string | null | undefined | Error | { status: 'limited' }; progressed: boolean }>((resolve) => {
      const answer = (thread: string | null | undefined | Error | { status: 'limited' }, progressed = true) => resolve({ thread, progressed })
      stand.t3.asked.push({ ids: [...of.ids], answer })
      if (!stand.t3.slow) answer(of.ids.map((id) => stand.t3.threads.get(id)).find((thread) => thread !== undefined) ?? null)
    }).then(({ thread, progressed }) => {
      if (thread instanceof Error) throw thread
      if (typeof thread === 'object' && thread !== null) return thread
      return thread === undefined ? { status: 'incomplete', progressed } : thread === null ? { status: 'absent' } : { status: 'found', thread }
    }),
  t3Running: async (_t3: unknown, of: { harness: string; ids: readonly string[] }, known?: string) => {
    stand.t3.looked.push({ harness: of.harness, ids: [...of.ids], ...(known === undefined ? {} : { known }) })
    for (const [thread, run] of stand.t3.runs) if (run.now.harness === of.harness && of.ids.includes(run.now.id)) return { thread, before: run.before }
    return undefined
  },
  t3Send: async (_t3: unknown, thread: string, text: string) => {
    if (stand.t3.refusing !== null) {
      stand.t3.refused.push({ thread, text })
      return stand.t3.refusing
    }
    stand.t3.sent.push({ thread, text })
    return null
  },
}))
// Whether some Codex has a conversation open is read from Codex's own folder and from the system
// (wake.test.ts tries that against real files). Here the test says which are closed.
vi.mock('./src/wake', async (original) => ({
  ...(await original<typeof import('./src/wake')>()),
  codexHeld: (thread: string) => (stand.unknown.has(thread) ? null : !stand.closed.has(thread)),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }, done: (err: unknown) => void) => {
    stand.codex.push({ args, env: options.env, end: (err) => done(err ?? null) })
  },
}))
vi.mock('./src/setup', () => ({ detectAll: async () => stand.found, newerProgramSeen: () => false, reconcile: async () => {} }))
vi.mock('./src/usage', () => ({
  agentOf: (harness: unknown) => String(harness ?? 'unknown'),
  begin: () => {},
  record: () => {},
  startSender: () => ({ stop: () => {} }),
  thisMachine: () => ({}),
  thisProgram: () => ({}),
  three: (version: string) => version,
  timeBand: () => '',
}))
vi.mock('./src/lib', async (original) => {
  const real = await original<typeof import('./src/lib')>()
  return {
    ...real,
    writePrivate: (...args: Parameters<typeof real.writePrivate>) => {
      if (stand.failedWrites.has(path.basename(args[0]))) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      real.writePrivate(...args)
      if (path.basename(args[0]) === 'runs.json') stand.savedRuns.push(JSON.parse(JSON.stringify(args[1])))
    },
    writePrivateAsync: (...args: Parameters<typeof real.writePrivateAsync>) => {
      const saving = stand.failedWrites.has(path.basename(args[0])) ? Promise.reject(new Error('disk full')) : real.writePrivateAsync(...args)
      stand.saving.add(saving)
      void saving.finally(() => stand.saving.delete(saving)).catch(() => {})
      return saving
    },
    live: () => ({
      onUpdate: (fn: any, args: unknown, heard: (value: any) => void) => {
        stand.watching.set(getFunctionName(fn), (value) => {
          const page = getFunctionName(fn) === 'delivery:inboxPage' && Array.isArray(value) ? { clicks: value, after: [] } : value
          // Pages in these delivery fixtures were published by a known app profile. The working folder may still be unknown.
          if (getFunctionName(fn) === 'delivery:inboxPage' && stand.profiles)
            for (const click of page?.clicks ?? []) {
              if (click.session && !conversationProfile(click.session)) noteConversation(click.session, '/not-a-recorded-working-folder')
            }
          heard(page)
        })
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
      if (name === 'delivery:giveBackBatch') return { back: [], done: true }
      if (name === 'delivery:handedOff') return { already: false }
      return null
    },
  }
})

import { type ConnectorInfo, infoFile, local, mac, runConnector, wayOf } from './src/connector'
import { DeliveryRecovery, eraseDeliveryRecovery } from './src/delivery-recovery'
import * as files from './src/lib'
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
const settled = async () => {
  // The connector now flushes receipts asynchronously. A pass is not settled merely
  // because its microtasks ran; wait for its real disk writes without advancing time.
  do {
    await Promise.allSettled([...stand.saving])
    await new Promise((r) => reallyNext(r))
  } while (stand.saving.size)
}
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
  apps: { wanted?: string[]; found?: typeof stand.found; deferSettings?: boolean } = {},
  /** What is put into the folder before the connector starts in it. */
  first: (home: string) => void = () => {},
  existing?: string,
): Promise<ConnectorInfo> {
  stand.found = apps.found ?? CONNECTED
  home = existing ?? mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
  // Every folder a test starts a connector in is taken away when the test is over, and not only the last
  made.push(home)
  process.env.IT_HOME = home
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'HERMES_HOME']) {
    process.env[key] = path.join(home, key)
    mkdirSync(process.env[key]!, { recursive: true })
  }
  first(home)
  if (over === 'port') process.env.IT_CONNECTOR_PORT = '1'
  else delete process.env.IT_CONNECTOR_PORT
  const had = { SIGTERM: new Set(process.listeners('SIGTERM')), SIGINT: new Set(process.listeners('SIGINT')) }
  const running = runConnector((line) => said.push(line))
  // It is up once it answers, watches the backend, and can be told to stop
  const stopper = () => process.listeners('SIGTERM').find((l) => !had.SIGTERM.has(l)) as ((signal: string) => void) | undefined
  await until(() => existsSync(infoFile()) && stand.watching.has('delivery:inboxPage') && stand.watching.has('machines:me') && stopper() !== undefined)
  if (!apps.deferSettings) wants(apps.wanted ?? ['codex', 'pi'])
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
  stand.failedWrites.clear()
  stand.savedRuns.length = 0
  stand.unknown.clear()
  stand.profiles = true
  stand.answer = null
  // A lookup a test left unanswered is answered, so that nothing of it outlasts the test
  for (const asked of stand.t3.asked) asked.answer(null)
  Object.assign(stand.t3, { running: false, slow: false, refusing: null })
  stand.t3.threads.clear()
  stand.t3.asked.length = 0
  stand.t3.sent.length = 0
  stand.t3.refused.length = 0
  stand.t3.runs.clear()
  stand.t3.looked.length = 0
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

  test.skipIf(process.platform === 'win32')(
    'a connector that cannot write down where it listens closes what it opened, and leaves no socket behind',
    async () => {
      folder()
      // Where the note goes there is a folder with something in it, which nothing can be written in place of
      mkdirSync(path.join(home, 'connector.json', 'in-the-way'), { recursive: true })
      const started = await starting()
      expect(started).not.toBe('running')
      expect(existsSync(path.join(home, 'connector.sock'))).toBe(false)
      // And the lock is let go, for the next try
      expect(existsSync(lock())).toBe(false)
    },
  )

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
  const offered = (...clicks: ReturnType<typeof click>[]) => stand.watching.get('delivery:inboxPage')!(clicks)
  // The connector tells that a run it reopened has ended by looking at every process on the
  // machine, and a process of the same person's that began after the run and cannot be read
  // may be a command the run started and let go of. While one is there the run is not known to
  // be over, so the connector keeps it noted and does not tell It that it ended. On a machine
  // that runs other things at the same time such processes come and go by themselves: a crash
  // reporter, an `ssh`, another test's program as it starts. So the processes these tests'
  // connector finds on Linux are this test process and the ones it started, however far down,
  // and none of whatever else the machine runs. A test that makes the look fail still can.
  const readdir = fs.readdirSync
  /** This process and every process it started, by the names /proc gives them. */
  const ours = (): Set<string> => {
    const parents = new Map<string, string>()
    for (const name of readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        // After the name, which stands in brackets and may hold anything, the second word is the parent
        parents.set(name, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]!)
      } catch {}
    }
    const tree = new Set([String(process.pid)])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, parent] of parents)
        if (!tree.has(pid) && tree.has(parent)) {
          tree.add(pid)
          grew = true
        }
    }
    return tree
  }
  beforeEach(() => {
    if (process.platform !== 'linux') return
    fs.readdirSync = ((where: unknown, ...args: unknown[]) => {
      const listed = (readdir as (...a: unknown[]) => (string | fs.Dirent)[])(where, ...args)
      if (where !== '/proc') return listed
      const tree = ours()
      return listed.filter((entry) => {
        const name = typeof entry === 'string' ? entry : entry.name
        return !/^\d+$/.test(name) || tree.has(name)
      })
    }) as typeof fs.readdirSync
    syncBuiltinESMExports()
  })
  afterEach(() => {
    fs.readdirSync = readdir
    syncBuiltinESMExports()
  })
  test('Unknown Codex liveness never queues or reopens a conversation, and a waiter can still take its click.', async () => {
    standIn()
    await start()
    stand.unknown.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await pass(2)
    expect(stand.codex).toEqual([])
    expect(stand.calls.filter((c) => c.name === 'delivery:handedOff' || c.name === 'machines:runBegan')).toEqual([])
    expect((await waitingFor(1))?.ok).toBe(true)
  })

  test('A legacy conversation with no profile receives its click through Codex’s queue in the service’s environment.', async () => {
    stand.profiles = false
    await start('socket', {}, (home) => {
      writeFileSync(path.join(home, 'conversations.json'), JSON.stringify({ 'codex:thread-1': { cwd: home, at: Date.now() } }))
    })
    offered(click(1))
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain('--thread=thread-1')
    expect(stand.codex[0]!.env?.CODEX_HOME).toBe(process.env.CODEX_HOME)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-1'))
    expect(conversationProfile({ harness: 'codex', id: 'thread-1' })).toBeUndefined()
  })

  test('Auto-wake reopens a legacy conversation with no profile in the service’s environment and gives it the click.', async () => {
    stand.profiles = false
    await start('socket', {}, (home) => {
      writeFileSync(path.join(home, 'conversations.json'), JSON.stringify({ 'codex:thread-1': { cwd: home, at: Date.now() } }))
      const bin = path.join(home, 'bin')
      mkdirSync(bin)
      writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'%s\' "$CODEX_HOME" > "$IT_HOME/profile-used"\ncat > "$IT_HOME/given"\n', { mode: 0o755 })
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    })
    stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await until(() => called('delivery:handedOff').includes('click-1'))
    expect(readFileSync(path.join(home, 'profile-used'), 'utf8')).toBe(process.env.CODEX_HOME)
    expect(readFileSync(path.join(home, 'given'), 'utf8')).toContain('[action click-1]')
    expect(stand.codex).toEqual([])
    expect(conversationProfile({ harness: 'codex', id: 'thread-1' })).toBeUndefined()
  })

  test.each(['open', 'closed'])('A Codex conversation that is %s and whose recorded profile is gone is neither queued nor reopened.', async (state) => {
    standIn()
    stand.profiles = false
    await start()
    const session = { harness: 'codex', id: 'thread-1' }
    noteConversation(session, home)
    const profile = process.env.CODEX_HOME!
    rmSync(profile, { recursive: true })
    process.env.CODEX_HOME = path.join(home, 'another-profile')
    mkdirSync(process.env.CODEX_HOME)
    if (state === 'closed') stand.closed.add('thread-1')
    stand.watching.get('machines:me')!({ wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] })
    offered(click(1))
    await pass(2)
    expect(stand.codex).toEqual([])
    expect(stand.calls.filter((c) => c.name === 'delivery:claim' || c.name === 'machines:runBegan')).toEqual([])
    expect(conversationProfile(session)).toMatchObject({ paths: { CODEX_HOME: profile } })
  })

  test('an incompatible build keeps an authenticated session move without listening for clicks', async () => {
    standIn()
    await start()
    const profile = { version: 1 as const, paths: { PI_CODING_AGENT_DIR: home } }
    noteConversation({ harness: 'pi', id: 'session-old' }, home, profile)
    const report = {
      harness: 'pi',
      session: 'session-new',
      was: 'session-old',
      instance: 'loaded-one',
      addon: { api: 1, version: 'old-build', delivery: true, idle: true },
    }
    expect(await local('/session', { method: 'POST', body: report })).toMatchObject({ ok: false })
    expect(readJson<Record<string, string>>(path.join(home, 'aliases.json'))?.['pi:session-old']).toBe('pi:session-new')
    expect(conversationProfile({ harness: 'pi', id: 'session-new' })).toEqual(profile)
    expect(conversationFolder({ harness: 'pi', id: 'session-new' })).toBe(home)
    expect((await local<{ sessions: unknown[] }>('/health'))?.sessions).toEqual([])
    expect(stand.calls.filter((c) => c.name === 'delivery:claim')).toEqual([])
  })

  test('Stale loaded code receives no clicks and its status names the repair.', async () => {
    standIn()
    await start()
    const report = { harness: 'pi', session: 'session-one', instance: 'loaded-one', addon: { api: 1, version: 'old-build', delivery: true, idle: true } }
    offered({ ...click(1), session: { harness: 'pi', id: 'session-one' } })
    expect(await local('/clicks', { method: 'POST', body: report })).toMatchObject({ ok: false, clicks: [], runtime: { state: 'incompatible' } })
    const health = await local<{ addons: Record<string, { detail: string }> }>('/health')
    expect(health?.addons.pi?.detail).toMatch(/restart the agent app/)
    expect(stand.calls.filter((c) => c.name === 'delivery:claim')).toEqual([])
    report.addon.version = ADDONS.pi!.version
    const heard = await local<{ clicks: unknown[] }>('/clicks', { method: 'POST', body: report })
    expect(heard?.clicks).toHaveLength(1)
  })

  test('An open host without idle discovery leaves unknown conversations in the inbox.', async () => {
    standIn()
    await start('socket', { wanted: ['opencode'], found: [{ id: 'opencode', addon: 'connected' }] })
    stand.watching.get('machines:me')!({ wanted: ['opencode'], wakes: [{ harness: 'opencode', since: Date.now() - 60_000 }] })
    await local('/addon', {
      method: 'POST',
      body: { harness: 'opencode', instance: 'open-app', addon: { api: 1, version: ADDONS.opencode!.version, delivery: true, idle: false } },
    })
    offered({ ...click(1), session: { harness: 'opencode', id: 'ses_idle' } })
    await pass(2)
    expect(stand.calls.filter((c) => c.name === 'delivery:claim' || c.name === 'machines:runBegan')).toEqual([])
    expect((await local<{ sessions: unknown[] }>('/health'))?.sessions).toEqual([])
  })

  /** What each waiter has been given, which it says with its next asking, as `it wait` does once it has printed it. */
  const printed = new Map<number, string[]>()
  beforeEach(() => printed.clear())
  /** A waiter asks. `lost` is an answer that never reached it: it has printed nothing of it, and says nothing of it next time. */
  const waitingFor = async (n: number, lost = false) => {
    const answer = await local<{ ok: boolean; clicks?: { id: string }[] }>('/waiting', {
      method: 'POST',
      body: { id: `waiter-${n}`, session: { harness: 'codex', id: `thread-${n}` }, ...(printed.has(n) ? { got: printed.get(n) } : {}) },
    })
    if (!lost && answer?.clicks?.length) printed.set(n, [...(printed.get(n) ?? []), ...answer.clicks.map((c) => c.id)])
    return answer
  }
  const called = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])

  const recoveryClaims = () => readJson<{ returning: string[]; targets: [string, string][] }>(path.join(home, 'delivery-recovery.json'))!

  test.each(['lost', 'failed write', 'unanswered'] as const)(
    'a held lease %s retires its durable claim only after confirmed loss and a successful save',
    async (outcome) => {
      standIn()
      let now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      let blocked: string | undefined
      try {
        await start()
        await turn(6, true)
        offered({ ...click(6), at: now })
        await until(async () => (await local<{ held: number }>('/health'))?.held === 1)
        offered()
        await pass()
        expect(recoveryClaims().returning).toEqual(['click-6'])
        stand.answer = (name) => {
          if (name !== 'delivery:renew') return undefined
          if (outcome === 'unanswered') throw new Error('offline')
          return []
        }
        if (outcome === 'failed write') {
          blocked = `${path.join(home, 'delivery-recovery.json')}.${process.pid}.tmp`
          mkdirSync(blocked)
        }
        now += outcome === 'unanswered' ? 31_000 : 11_000
        await pass(2)
        expect(called('delivery:renew')).toContain('click-6')
        expect((await local<{ held: number }>('/health'))?.held).toBe(0)
        if (outcome === 'failed write') {
          expect(recoveryClaims().returning).toEqual(['click-6'])
          rmSync(blocked!, { recursive: true })
          blocked = undefined
          await pass()
        }
        expect(recoveryClaims().returning).toEqual(outcome === 'unanswered' ? ['click-6'] : [])
        expect(recoveryClaims().targets).toEqual(outcome === 'unanswered' ? [['click-6', 'codex:thread-6']] : [])
        expect(called('delivery:release')).toEqual([])
        expect(called('delivery:handedOff')).toEqual([])
      } finally {
        if (blocked) rmSync(blocked, { recursive: true, force: true })
        clock.mockRestore()
      }
    },
  )

  test.each([false, true])('acknowledged releases and parks retire durable claims, with recovery write failure %s', async (diskFails) => {
    standIn()
    await start()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let releaseFails = true
    let parkFails = true
    stand.answer = (name) => {
      if (name === 'delivery:release' && releaseFails) throw new Error('offline')
      if (name === 'delivery:park') return !parkFails
      return undefined
    }
    try {
      offered(click(1))
      await until(() => stand.codex.length === 1)
      stand.codex[0]!.end(new Error('declined'))
      await until(() => called('delivery:release').length === 1)
      await settled()
      expect(recoveryClaims().returning).toEqual(['click-1'])
      releaseFails = false
      for (let n = 2; n <= 4; n++) {
        now += 601_000
        await pass()
        await until(() => stand.codex.length === n)
        stand.codex[n - 1]!.end(new Error('declined'))
        await until(() => called(n === 4 ? 'delivery:park' : 'delivery:release').length >= (n === 4 ? 1 : n))
        await settled()
        expect(recoveryClaims().returning).toEqual(n === 4 ? ['click-1'] : [])
        if (n < 4) expect(recoveryClaims().targets).toEqual([])
      }
      parkFails = false
      if (diskFails) {
        const saving = vi.spyOn(DeliveryRecovery.prototype, 'retire').mockImplementation(() => {
          throw new Error('disk unavailable')
        })
        try {
          await pass()
          await settled()
          expect(recoveryClaims().returning).toEqual(['click-1'])
        } finally {
          saving.mockRestore()
        }
      }
      await pass()
      await until(() => recoveryClaims().returning.length === 0)
      expect(recoveryClaims().targets).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  test('a delayed release acknowledgement cannot retire a newer claim of the same click', async () => {
    standIn()
    await start()
    await turn(6, true)
    offered({ ...click(6), at: Date.now() })
    await pass()
    await until(() => called('delivery:claim').length === 1)
    let acknowledge!: (value: null) => void
    stand.answer = (name) =>
      name === 'delivery:release'
        ? new Promise((resolve) => {
            acknowledge = resolve
          })
        : undefined
    await waitingFor(6)
    await until(() => acknowledge !== undefined)
    await local('/waiting', { method: 'POST', body: { id: 'waiter-6', done: true } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    try {
      await pass()
      await until(() => called('delivery:claim').length === 2)
      acknowledge(null)
      stand.answer = null
      await settled()
      expect(recoveryClaims().returning).toEqual(['click-6'])
      expect(recoveryClaims().targets).toEqual([['click-6', 'codex:thread-6']])
    } finally {
      acknowledge(null)
      stand.answer = null
      clock.mockRestore()
    }
  })

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

  test('answers a hook while its conversation note waits for another writer, then keeps the note after the writer finishes', async () => {
    await start()
    const lock = path.join(home, 'conversations.json.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, holder: 'a'.repeat(16) }))
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('a hook must not block the connector')
    })
    const session = { harness: 'codex', id: 'waiting-for-note' }
    try {
      expect(await local('/session', { method: 'POST', body: { harness: session.harness, session: session.id, folder: home } })).toMatchObject({ ok: true })
      expect(wait).not.toHaveBeenCalled()
      expect(conversationFolder(session)).toBeUndefined()
    } finally {
      rmSync(lock, { force: true })
      wait.mockRestore()
    }
    await until(() => conversationFolder(session) === home)
  })

  test('writes nothing for the hooks of a conversation noted in the same folder within the hour, and notes its time again once the note is an hour old', async () => {
    await start()
    const file = path.join(home, 'conversations.json')
    const report = () => local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-busy', folder: home } })
    await report()
    const noted = readFileSync(file, 'utf8')
    const written = fs.statSync(file).ino
    for (let n = 0; n < 50; n++) await report()
    expect(readFileSync(file, 'utf8')).toBe(noted)
    expect(fs.statSync(file).ino).toBe(written)
    expect(existsSync(`${file}.lock`)).toBe(false)
    // The same note an hour old, as it is once the conversation has been at work for an hour
    const hourAgo = Date.now() - 60 * 60_000
    writeFileSync(file, JSON.stringify({ 'codex:thread-busy': { ...JSON.parse(noted)['codex:thread-busy'], at: hourAgo } }))
    await report()
    await until(() => JSON.parse(readFileSync(file, 'utf8'))['codex:thread-busy'].at > hourAgo)
    expect(conversationFolder({ harness: 'codex', id: 'thread-busy' })).toBe(home)
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
    await until(() => said.some((line) => line.includes('was stopped by the person')))
  }, 90_000)

  test.skipIf(process.platform === 'win32').each([false, true])(
    'a Stop whose notice cannot be saved keeps its evidence through a restart with run writes failing %s',
    async (failRun) => {
      const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
      made.push(bin, folder)
      const command = path.join(bin, 'codex')
      writeFileSync(command, `#!/bin/sh\ncat > ${bin}/given\nexec sleep 120\n`, { mode: 0o755 })
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
      await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
      stand.closed.add('thread-1')
      const on = { wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] }
      stand.watching.get('machines:me')!(on)
      offered(click(1))
      await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0)
      const run = stand.calls.find((c) => c.name === 'machines:runBegan')!.args.run
      stand.failedWrites.add('stopped.json')
      if (failRun) stand.failedWrites.add('runs.json')
      stand.watching.get('machines:me')!({ ...on, runs: [{ harness: 'codex', sessionId: 'thread-1', stop: true, run }] })
      // An answer that did not come in time, on a busy machine, is asked for again
      await until(async () => (await local<{ held: unknown[] }>('/runs'))?.held.length === 1)
      expect(stand.calls.filter((c) => c.name === 'machines:runEnded')).toEqual([])
      expect(readJson<Record<string, unknown>>(path.join(home, 'runs.json'))?.['codex:thread-1']).toMatchObject(failRun ? { unsure: true } : { stopped: true })
      const previousHome = home
      await stop?.()
      stop = null
      stand.failedWrites.clear()
      stand.calls.length = 0
      stand.watching.clear()
      writeFileSync(command, `#!/bin/sh\ncat > ${bin}/next\nexit 0\n`, { mode: 0o755 })
      await start('socket', {}, () => {}, previousHome)
      if (!failRun) {
        expect(readJson(path.join(home, 'stopped.json'))).toEqual(['codex:thread-1'])
        expect(existsSync(path.join(home, 'runs.json'))).toBe(false)
      }
      stand.watching.get('machines:me')!({ ...on, runs: [{ harness: 'codex', sessionId: 'thread-1', stop: true, run }] })
      expect((await local<{ held: unknown[] }>('/runs'))!.held).toEqual([])
      await until(() => stand.calls.some((c) => c.name === 'machines:runEnded' && c.args.run === run))
      offered({ ...click(1), id: 'click-after-stop' })
      await until(() => existsSync(path.join(bin, 'next')) && readFileSync(path.join(bin, 'next'), 'utf8').length > 0)
      const given = readFileSync(path.join(bin, 'next'), 'utf8')
      expect(given).toContain(WAS_STOPPED)
      expect(given).toContain('[action click-after-stop]')
      expect(given).not.toContain('[action click-1]')
    },
    30_000,
  )

  test.skipIf(process.platform !== 'linux').each([false, true])(
    'failed run and cutoff writes preserve the record, and restart holds it only while inspection still fails: %s',
    async (inspectionFails) => {
      const bin = mkdtempSync(path.join(os.tmpdir(), 'it-codex-bin-'))
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-held-'))
      made.push(bin, folder)
      writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat > ${bin}/given\nexec sleep 120\n`, { mode: 0o755 })
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
      await start('socket', {}, () => noteConversation({ harness: 'codex', id: 'thread-1' }, folder))
      stand.closed.add('thread-1')
      const on = { wanted: ['codex'], wakes: [{ harness: 'codex', since: Date.now() - 60_000 }] }
      stand.watching.get('machines:me')!(on)
      offered(click(1))
      await until(() => existsSync(path.join(bin, 'given')) && readFileSync(path.join(bin, 'given'), 'utf8').length > 0)
      const file = path.join(home, 'runs.json')
      const original = readFileSync(file, 'utf8')
      const record = JSON.parse(original)['codex:thread-1'] as { pid: number; unsure: boolean }
      expect(record.unsure).toBe(true)
      const previousHome = home
      const read = fs.readdirSync
      try {
        stand.failedWrites.add('runs.json')
        stand.failedWrites.add('cut-off.json')
        fs.readdirSync = ((where: unknown, ...args: unknown[]) => {
          if (where === '/proc') throw Object.assign(new Error('inspection failed'), { code: 'EIO' })
          return (read as any)(where, ...args)
        }) as typeof fs.readdirSync
        syncBuiltinESMExports()
        await stop?.()
        stop = null
        expect(readFileSync(file, 'utf8')).toBe(original)
        stand.failedWrites.clear()
        stand.calls.length = 0
        stand.watching.clear()
        if (!inspectionFails) {
          fs.readdirSync = read
          syncBuiltinESMExports()
        }
        await start('socket', {}, () => {}, previousHome)
        if (inspectionFails) {
          expect((await local<{ held: { key: string }[] }>('/runs'))!.held.map((r) => r.key)).toEqual(['codex:thread-1'])
          expect(readJson<Record<string, unknown>>(file)?.['codex:thread-1']).toMatchObject({ unsure: true })
          stand.watching.get('machines:me')!(on)
          offered({ ...click(1), id: 'new-click' })
          await until(() => stand.calls.some((c) => c.name === 'machines:wakeFailed'))
          expect(stand.calls.filter((c) => c.name === 'machines:runBegan')).toEqual([])
          expect(await local('/runs', { method: 'POST', body: { clear: true, of: ['codex:thread-1'] } })).toEqual({ cleared: 1 })
        } else {
          expect(existsSync(file)).toBe(false)
          expect(readJson(path.join(home, 'cut-off.json'))).toEqual(['codex:thread-1'])
        }
        expect((await local<{ held: unknown[] }>('/runs'))!.held).toEqual([])
      } finally {
        fs.readdirSync = read
        syncBuiltinESMExports()
        stand.failedWrites.clear()
        // The test ends the process whose inspection it made fail, by that process's own id.
        if (identity([record.pid]).has(record.pid)) process.kill(record.pid, 'SIGTERM')
        await until(() => !identity([record.pid]).has(record.pid))
      }
    },
    30_000,
  )

  test.each(['ended', 'gone', 'unknown'] as const)(
    'a run saved before a connector crash is held only when recovery answers unknown, rather than %s',
    async (outcome) => {
      const ended = vi.spyOn(wake, 'endTree').mockResolvedValue(outcome)
      try {
        await start('socket', {}, (home) => {
          writeFileSync(
            path.join(home, 'runs.json'),
            JSON.stringify({ 'codex:thread-1': { pid: 900_001, since: 'tick 1', told: SINCE_TOLD, run: 'interrupted-run', unsure: true } }),
          )
        })
        expect(ended).toHaveBeenCalledWith(900_001, 'tick 1', {
          harness: 'codex',
          session: 'thread-1',
          run: 'interrupted-run',
          told: SINCE_TOLD,
          boot: undefined,
        })
        expect((await local<{ held: unknown[] }>('/runs'))!.held).toHaveLength(outcome === 'unknown' ? 1 : 0)
        expect(existsSync(path.join(home, 'runs.json'))).toBe(outcome === 'unknown')
        if (outcome !== 'unknown') expect(readJson(path.join(home, 'cut-off.json'))).toEqual(['codex:thread-1'])
      } finally {
        ended.mockRestore()
      }
    },
  )

  test('an uncertain legacy run without a run mark stays held when its leader is gone', async () => {
    await start('socket', {}, (home) => {
      writeFileSync(
        path.join(home, 'runs.json'),
        JSON.stringify({
          'codex:thread-1': { pid: process.pid, since: 'Thu Jan  1 00:00:00 1970', told: SINCE_TOLD, unsure: true, boot: wake.bootId() },
        }),
      )
    })
    expect((await local<{ held: { key: string }[] }>('/runs'))!.held.map((run) => run.key)).toEqual(['codex:thread-1'])
    expect(readJson<Record<string, unknown>>(path.join(home, 'runs.json'))?.['codex:thread-1']).toMatchObject({ unsure: true })
    expect(await local('/runs', { method: 'POST', body: { clear: true, of: ['codex:thread-1'] } })).toEqual({ cleared: 1 })
    expect((await local<{ held: unknown[] }>('/runs'))!.held).toEqual([])
  })

  test.skipIf(process.platform === 'win32')('recovery leaves a legacy run alive when its conservative checkpoint cannot be saved', async () => {
    const leader = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    const exited = new Promise((resolve) => leader.once('exit', resolve))
    const record = { 'codex:thread-1': { pid: leader.pid!, since: identity([leader.pid!]).get(leader.pid!)!, told: SINCE_TOLD } }
    try {
      await start('socket', {}, (home) => {
        writeFileSync(path.join(home, 'runs.json'), JSON.stringify(record))
        stand.failedWrites.add('runs.json')
      })
      expect(identity([leader.pid!]).has(leader.pid!)).toBe(true)
      expect(readJson(path.join(home, 'runs.json'))).toEqual(record)
      expect((await local<{ held: unknown[] }>('/runs'))!.held).toHaveLength(1)
    } finally {
      stand.failedWrites.clear()
      if (identity([leader.pid!]).has(leader.pid!)) leader.kill('SIGKILL')
      await exited
    }
  })

  test.skipIf(process.platform !== 'linux')('a known reboot releases uncertainty while keeping the Stop notice', async () => {
    await start('socket', {}, (home) => {
      writeFileSync(
        path.join(home, 'runs.json'),
        JSON.stringify({
          'codex:thread-1': {
            pid: process.pid,
            since: identity([process.pid]).get(process.pid),
            told: SINCE_TOLD,
            boot: '00000000-0000-4000-8000-000000000000',
            unsure: true,
            stopped: true,
          },
        }),
      )
    })
    expect((await local<{ held: unknown[] }>('/runs'))!.held).toEqual([])
    expect(existsSync(path.join(home, 'runs.json'))).toBe(false)
    expect(readJson(path.join(home, 'stopped.json'))).toEqual(['codex:thread-1'])
  })

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
    // The first recovery checkpoint still names every run that has not been examined.
    expect(Object.keys(stand.savedRuns[0]!)).toEqual(['codex:thread-1', 'codex:thread-2'])
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
    // While the first is being handed over, the second is not so much as asked for: it stays with It until that hand-over is over
    const claimed = () => called('delivery:claim').filter((id) => id === 'click-old' || id === 'click-new')
    expect(claimed()).toHaveLength(1)
    // It has the first down as handed over by now, and offers only the other
    const other = claimed()[0] === 'click-old' ? under('click-new', 'thread-new') : under('click-old', 'thread-old')
    offered(other)
    await new Promise((r) => setTimeout(r, 800))
    expect(claimed()).toHaveLength(1)
    await until(() => existsSync(path.join(bin, 'ended-0')), 20_000)
    await until(() => existsSync(path.join(bin, 'began-1')), 30_000)
    expect(claimed().sort()).toEqual(['click-new', 'click-old'])
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

  test('only the latest 200 stopped conversations are kept, including after a restart', async () => {
    const keys = Array.from({ length: 205 }, (_, n) => `codex:stopped-${n}`)
    await start('socket', {}, (home) => writeFileSync(path.join(home, 'stopped.json'), JSON.stringify(keys.slice(0, 200))))
    stand.watching.get('machines:me')!({
      wanted: ['codex'],
      runs: keys.slice(200).map((key) => ({ harness: 'codex', sessionId: key.slice(6), stop: true })),
    })
    expect(readJson(path.join(home, 'stopped.json'))).toEqual(keys.slice(5))
    const previousHome = home
    await stop?.()
    stop = null
    stand.watching.clear()
    await start('socket', {}, () => {}, previousHome)
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'stopped-204', busy: true } })
    expect(readJson(path.join(home, 'stopped.json'))).toEqual(keys.slice(5, -1))
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
    stand.unknown.clear()
    stand.profiles = true
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

  test.each([-60_000, 60_000])('a first observation is fresh for a running Codex turn when the host clock differs by %i milliseconds', async (skew) => {
    await start()
    await turn(6, true)
    offered({ ...click(6), at: Date.now() + skew })
    await until(() => called('delivery:claim').includes('click-6'))
    expect(stand.codex).toEqual([])
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-6'))?.clicks.map((c) => c.id)).toEqual(['click-6'])
  })

  test('new clicks stay fresh after the observation table fills with clicks taken elsewhere', async () => {
    standIn()
    await start()
    // An unconnected app leaves the observations here without this connector confirming any.
    const elsewhere = Array.from({ length: 5000 }, (_, n) => ({ ...click(n + 100), session: { harness: 'other', id: 'elsewhere' } }))
    offered(...elsewhere)
    await pass()
    offered()
    await pass()
    expect(called('delivery:handedOff')).toEqual([])
    await turn(6, true)
    offered(click(6))
    await until(() => called('delivery:claim').includes('click-6'))
    expect(stand.codex).toEqual([])
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-6'))?.clicks.map((c) => c.id)).toEqual(['click-6'])
  })

  test('repeated offers keep their first observation after the local wall clock is corrected backwards', async () => {
    await start()
    await turn(6, true)
    const first = { ...click(6), at: Date.now() + 60_000 }
    const elapsed = performance.now()
    // The first claim loses a race, so the same click is offered again later.
    stand.answer = (name) => (name === 'delivery:claim' ? [] : undefined)
    offered(first)
    await until(() => called('delivery:claim').includes('click-6'))
    await settled()
    stand.answer = null
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000)
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(elapsed + 9_000)
    try {
      offered(first)
      await until(() => stand.codex.length === 1)
      expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-6'))?.clicks).toEqual([])
    } finally {
      wall.mockRestore()
      monotonic.mockRestore()
    }
  })

  test.each([
    { harness: 'codex', id: 'thread-6' },
    { harness: 'pi', id: 'thread-7' },
  ])('a pending click gets a fresh hook window when its page moves from $harness:$id to another conversation', async (session) => {
    standIn()
    await start()
    await turn(7, true)
    stand.closed.add('thread-6')
    const first = { ...click(6), session }
    const elapsed = performance.now()
    offered(first)
    await pass()
    expect(called('delivery:claim')).toEqual([])
    // The same click is offered to the new owner after its old hook window has expired.
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(elapsed + 9_000)
    try {
      offered({ ...first, session: { harness: 'codex', id: 'thread-7' } })
      await until(() => called('delivery:claim').includes('click-6'))
      expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-7'))?.clicks.map((c) => c.id)).toEqual(['click-6'])
      expect(stand.codex).toEqual([])
    } finally {
      monotonic.mockRestore()
    }
  })

  /** The first observation happened before the routing pass, which now runs past its hook window. */
  const offeredEarlier = (...clicks: ReturnType<typeof click>[]) => {
    const time = vi.spyOn(performance, 'now').mockReturnValue(performance.now() - 9_000)
    offered(...clicks)
    time.mockRestore()
  }
  /** Offers a click, lets Codex's command take it, and waits until It has been told so. */
  const takenByTheQueue = async (n: number) => {
    const commands = stand.codex.length
    offeredEarlier(click(n))
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
    standIn()
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    // Thirty-four clicks that each carry as much as a click may, taken by Codex’s queue behind the turn that is running
    const carried = JSON.stringify('x'.repeat(31_000))
    const ids: string[] = []
    // A failed wait says how far the hand-over got.
    const sofar = (step: string, i: number) => (err: unknown) => {
      throw new Error(
        `${step} of click ${i} did not come about: ${JSON.stringify({
          codex: stand.codex.length,
          claimed: called('delivery:claim').length,
          released: called('delivery:release').length,
          handedOff: called('delivery:handedOff').length,
          calls: [...new Set(stand.calls.map((c) => c.name))],
          said: said.slice(-12),
        })}`,
        { cause: err },
      )
    }
    for (let i = 0; i < 34; i++) {
      const commands = stand.codex.length
      ids.push(`click-big-${i}`)
      offeredEarlier({ ...click(6), id: ids[i]!, payload: carried })
      await until(() => stand.codex.length === commands + 1, 30_000).catch(sofar('Codex’s command', i))
      // A claimed click is no longer on offer from the backend. Withdraw it before the
      // command ends, so a timer cannot submit the stale offer again after confirmation.
      offered()
      stand.codex[commands]!.end()
      await until(() => called('delivery:handedOff').includes(ids[i]!), 30_000).catch(sofar('telling It', i))
      // Exercise the timer between hand-overs, even when the runner finishes them quickly.
      await pass()
      expect(stand.codex.length).toBe(commands + 1)
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
  }, 240_000)

  test('what is done between two waits of a conversation never heard from is left for its next wait, and one that is heard from is not held up for a waiter that has gone', async () => {
    await start()
    const ended = (n: number) => local('/waiting', { method: 'POST', body: { id: `waiter-${n}`, done: true } })
    // Its agent waited and was given nothing, and the wait ended: it is thinking, and waits again in a moment.
    // No hook has ever said anything of this conversation, as of one that was open before It's add-on was there
    expect(await waitingFor(7)).toMatchObject({ ok: true })
    await ended(7)
    const commands = stand.codex.length
    offered(click(7))
    // Codex's own command would be started at once for a conversation with nothing to do
    await new Promise((r) => setTimeout(r, 900))
    expect(stand.codex.length).toBe(commands)
    expect(called('delivery:claim')).not.toContain('click-7')
    // A conversation whose add-on is heard from: its wait ended, and what is done next goes the usual way, at once
    await turn(8, false)
    expect(await waitingFor(8)).toMatchObject({ ok: true })
    await ended(8)
    offered(click(7), click(8))
    await until(() => stand.codex.length === commands + 1)
    expect(called('delivery:claim')).toContain('click-8')
    expect(called('delivery:claim')).not.toContain('click-7')
  })

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

  test('an unreadable recovery record is kept aside once and does not stop click delivery', async () => {
    await start('socket', {}, (folder) => writeFileSync(path.join(folder, 'delivery-recovery.json'), '{broken'))
    expect(readFileSync(path.join(home, 'delivery-recovery.json.unreadable'), 'utf8')).toBe('{broken')
    expect(said.filter((line) => line.includes('recovery record could not be read'))).toHaveLength(1)
    await takenByTheQueue(6)
    expect(called('delivery:handedOff')).toEqual(['click-6'])
    expect(said.filter((line) => line.includes('recovery record could not be read'))).toHaveLength(1)
  })

  test('a failed waiter cleanup save does not prevent connector startup or its next answer', async () => {
    standIn()
    stand.failedWrites.add('delivery-recovery.json')
    await start('socket', {}, (folder) => {
      const expired = { ...click(6), at: Date.now() - WAKE_BACK_MS }
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({
          version: 1,
          waiters: [[expired.id, { click: expired, key: 'codex:thread-6' }]],
          marks: [],
          accepted: [],
          returning: [],
        }),
      )
    })
    await pass(2)
    expect(await local('/waiting', { method: 'POST', body: { id: 'finished', done: true } })).toEqual({ ok: true })
    expect(said.filter((line) => line.includes('could not save waiter cleanup'))).toHaveLength(1)
    stand.failedWrites.clear()
    await pass()
    expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
  })

  test('a failed waiter cleanup save leaves lease renewal and confirmation running', async () => {
    standIn()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await start()
      stand.answer = (name) => {
        if (name === 'delivery:handedOff') throw new Error('offline')
      }
      await turn(7, true)
      await takenByTheQueue(7)
      await turn(6, true)
      offered({ ...click(6), at: now })
      await until(async () => (await local<{ held: number }>('/health'))?.held === 1)
      offered()
      await pass()
      stand.calls.length = 0
      stand.answer = null
      stand.closed.add('thread-7')
      stand.failedWrites.add('delivery-recovery.json')
      now += 11_000
      await pass(2)
      expect(called('delivery:renew')).toContain('click-6')
      expect(called('delivery:handedOff')).toContain('click-7')
      expect(said.filter((line) => line.includes('could not save waiter cleanup'))).toHaveLength(1)
      stand.failedWrites.clear()
      await pass()
      expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
    } finally {
      stand.failedWrites.clear()
      clock.mockRestore()
    }
  })

  test('a failed save of a printed waiter receipt still answers and retries its cleanup', async () => {
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    stand.failedWrites.add('delivery-recovery.json')
    const done = () => local('/waiting', { method: 'POST', body: { id: 'waiter-6', got: ['click-6'], done: true } })
    expect(await done()).toEqual({ ok: true })
    expect(await done()).toEqual({ ok: true })
    expect(said.filter((line) => line.includes('could not save waiter cleanup'))).toHaveLength(1)
    stand.failedWrites.clear()
    expect(await done()).toEqual({ ok: true })
    expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
  })

  test('closing Codex without an ending hook removes copies made for its running turn', async () => {
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    stand.closed.add('thread-6')
    expect((await waitingFor(6, true))?.clicks).toBeUndefined()
    expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
    expect(called('delivery:handedOff')).toEqual(['click-6'])
  })

  test('a live copy is removed when its quiet turn and its remembered session have both expired', async () => {
    standIn()
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001)
    try {
      // Both timers become due before the queued recovery write runs. The session is gone,
      // but this connector made the copy itself and knows the turn it was kept behind.
      vi.advanceTimersByTime(60_000)
      await settled()
      expect((await waitingFor(6, true))?.clicks).toBeUndefined()
      expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  test('asking again for an unanswered copy keeps its first receipt without rewriting the record', async () => {
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    const file = path.join(home, 'delivery-recovery.json')
    const before = readFileSync(file, 'utf8')
    const blocked = `${file}.${process.pid}.tmp`
    mkdirSync(blocked)
    try {
      expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(blocked, { recursive: true })
    }
  })

  test.each(['/session', '/marked', '/waiting'])('a nearly full restored record still answers %s and keeps its receipts', async (endpoint) => {
    await start('socket', {}, (folder) => {
      const old = { ...click(1), id: 'old', at: Date.now() - 20_000, payload: '' }
      const record = {
        version: 1,
        accepted: [],
        returning: [],
        targets: [],
        marks: [['codex:thread-6', [{ id: 'mark', texts: ['Private text'], at: Date.now() }]]],
        waiters: [
          ['old', { key: 'codex:thread-1', click: old }],
          ['click-6', { key: 'codex:thread-6', click: click(6) }],
        ],
      }
      old.payload = 'x'.repeat(16_000_000 - Buffer.byteLength(JSON.stringify(record)) - 1)
      writeFileSync(path.join(folder, 'delivery-recovery.json'), JSON.stringify(record))
    })
    const body =
      endpoint === '/session'
        ? { harness: 'codex', session: 'longer-thread-6', was: 'thread-6' }
        : endpoint === '/marked'
          ? { harness: 'codex', session: 'thread-6', taken: ['not-this-mark'] }
          : { id: 'waiter-6', session: { harness: 'codex', id: 'thread-6' } }
    expect(await local(endpoint, { method: 'POST', body })).toMatchObject({ ok: true })
    const kept = readJson<{ waiters: [string, unknown][]; marks: unknown[] }>(path.join(home, 'delivery-recovery.json'))!
    expect(kept.marks).toHaveLength(1)
    if (endpoint !== '/marked') expect(kept.waiters.map(([id]) => id)).toEqual(['click-6'])
  })

  test('a slow recovery save leaves the add-on answer free to meet its 300 millisecond deadline', async () => {
    standIn(true)
    await start('socket', {}, (folder) =>
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({
          version: 1,
          accepted: [],
          returning: [],
          marks: [],
          waiters: [['large', { key: 'codex:other', click: { ...click(6), id: 'large', payload: 'x'.repeat(15_000_000) } }]],
        }),
      ),
    )
    const write = files.writePrivateAsync
    let resume = () => {}
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    let began = false
    const saving = vi.spyOn(files, 'writePrivateAsync').mockImplementation(async (...args) => {
      began = true
      await blocked
      await write(...args)
    })
    try {
      offered({ ...click(8), session: { harness: 'pi', id: 'thread-8' } })
      let answered = false
      const asking = local<{ clicks: unknown[] }>('/clicks?harness=pi&session=thread-8').finally(() => {
        answered = true
      })
      await until(() => began)
      expect(called('delivery:claim')).toEqual([])
      expect(answered).toBe(false)
      vi.advanceTimersByTime(300)
      expect((await asking)?.clicks).toEqual([])
      // The claim is not sent until its receipt has actually reached the disk.
      expect(called('delivery:claim')).toEqual([])
      resume()
      await until(() => called('delivery:claim').includes('click-8'))
    } finally {
      resume()
      saving.mockRestore()
    }
  })

  test('a waiter copy and its receipt survive consecutive connector restarts', async () => {
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    const restart = async () => {
      const previous = home
      await stop!()
      stop = null
      await start('socket', {}, (folder) => {
        for (const name of ['delivery-recovery.json', 'aliases.json', 'heard.json']) {
          if (existsSync(path.join(previous, name))) writeFileSync(path.join(folder, name), readFileSync(path.join(previous, name)))
        }
      })
    }
    await restart()
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    await waitingFor(6)
    await restart()
    expect((await waitingFor(6))?.clicks).toBeUndefined()
  })

  test.each(['codex', 't3'])('restored copies at one conversation limit do not block another %s queue', async (via) => {
    if (via === 't3') {
      stand.t3.running = true
      stand.t3.threads.set('thread-6', 't3-6')
      stand.t3.threads.set('thread-7', 't3-7')
    }
    await start('socket', {}, (folder) => {
      const waiters = Array.from({ length: 200 }, (_, n) => {
        const id = `old-${n}`
        return [id, { click: { ...click(6), id }, key: 'codex:thread-6' }]
      })
      writeFileSync(path.join(folder, 'delivery-recovery.json'), JSON.stringify({ version: 1, waiters, marks: [], accepted: [], returning: [] }))
    })
    await turn(7, true)
    offeredEarlier(click(6), click(7))
    await until(() => (via === 't3' ? stand.t3.sent.length === 1 : stand.codex.length === 1))
    if (via === 'codex') stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-7'))
    expect(called('delivery:claim')).toEqual(['click-7'])
    const kept = readJson<{ waiters: [string, unknown][] }>(path.join(home, 'delivery-recovery.json'))!
    expect(kept.waiters).toHaveLength(200)
    expect((await waitingFor(7))?.clicks?.map((c) => c.id)).toEqual(['click-7'])
  })

  test.each(['confirmed', 'unconfirmed', 'pending'] as const)('an expired restored copy leaves its %s click on the existing restart path', async (state) => {
    standIn()
    const expired = { ...click(6), at: Date.now() - WAKE_BACK_MS - 1 }
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch') return { back: state === 'pending' ? [expired.id] : [], done: true }
      if (name === 'delivery:recover') return [{ id: expired.id, click: expired }]
      return undefined
    }
    await start('socket', {}, (folder) => {
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({
          version: 1,
          waiters: [[expired.id, { click: expired, key: 'codex:thread-6' }]],
          marks: [],
          accepted: state === 'unconfirmed' ? [expired.id] : [],
          returning: state === 'confirmed' ? [] : [expired.id],
        }),
      )
      // Before durable copies, a queued receipt was recovered from the journal alone.
      const event = state === 'confirmed' ? 'confirmed' : state === 'unconfirmed' ? 'queued' : 'queueing'
      writeFileSync(path.join(folder, 'journal.jsonl'), `${JSON.stringify({ event, id: expired.id })}\n`)
    })
    await pass(3)
    expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
    if (state === 'pending') {
      await until(() => stand.codex.length === 1)
      stand.codex[0]!.end()
      await until(() => called('delivery:handedOff').includes(expired.id))
      expect(called('delivery:claim')).toEqual([expired.id])
    } else {
      expect(stand.codex).toHaveLength(0)
      expect(called('delivery:claim')).toEqual([])
      expect(called('delivery:handedOff')).toEqual(state === 'unconfirmed' ? [expired.id] : [])
    }
    expect((await waitingFor(6))?.clicks).toBeUndefined()
    expect(called('delivery:release')).toEqual([])
    expect(called('delivery:park')).toEqual([])
  })

  test('an unexpired restored copy is kept until its age limit, even without another restart', async () => {
    standIn()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const kept = { ...click(6), at: now - WAKE_BACK_MS + 1000 }
      await start('socket', {}, (folder) =>
        writeFileSync(
          path.join(folder, 'delivery-recovery.json'),
          JSON.stringify({
            version: 1,
            waiters: [[kept.id, { click: kept, key: 'codex:thread-6' }]],
            marks: [],
            accepted: [],
            returning: [],
          }),
        ),
      )
      expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual([kept.id])
      now += 1000
      await pass()
      expect(readJson<{ waiters: unknown[] }>(path.join(home, 'delivery-recovery.json'))!.waiters).toEqual([])
      expect((await waitingFor(6))?.clicks).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })

  test('a returned click cannot be overtaken after more than three seconds without visibility', async () => {
    standIn()
    stand.answer = (name) => (name === 'delivery:giveBackBatch' ? { back: ['click-left'], done: true } : undefined)
    await start()
    offered(click(6))
    await settled()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    try {
      await pass(5)
      expect(called('delivery:claim')).toEqual([])
    } finally {
      clock.mockRestore()
    }
    offered({ ...click(6), id: 'click-left', at: Date.now() - 20_000 }, click(6))
    await pass()
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')[0]).toBe('click-left')
  })

  test('a failed legacy release stays unresolved until it succeeds', async () => {
    standIn()
    let failed = true
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch' || name === 'delivery:giveBack') throw new Error(`Could not find public function for '${name}'.`)
      if (name === 'delivery:release' && failed) throw new Error('offline')
      return undefined
    }
    await start('socket', {}, (folder) => writeFileSync(path.join(folder, 'journal.jsonl'), `${JSON.stringify({ event: 'claimed', id: 'click-left' })}\n`))
    offered(click(6))
    await pass(5)
    expect(called('delivery:claim')).toEqual([])
    failed = false
    await pass(5)
    expect(called('delivery:claim')).toEqual([])
    offered({ ...click(6), id: 'click-left', at: Date.now() - 20_000 }, click(6))
    await pass()
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')[0]).toBe('click-left')
  })

  test('recovery fetches an older click omitted by the inbox and lets unrelated conversations progress', async () => {
    standIn()
    let reachable = false
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch')
        return { back: ['click-left'], done: true, routes: [{ id: 'click-left', session: { harness: 'codex', id: 'thread-6' } }] }
      if (name === 'delivery:recover') {
        if (!reachable) throw new Error('offline')
        return [{ id: 'click-left', click: { ...click(6), id: 'click-left', at: Date.now() - 20_000 } }]
      }
      return undefined
    }
    await start()
    offered(click(6), click(7))
    await pass()
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')).toEqual(['click-7'])
    reachable = true
    await pass()
    await until(() => stand.codex.length === 2)
    expect(called('delivery:claim')[1]).toBe('click-left')
    stand.codex[1]!.end()
    await pass()
    await until(() => called('delivery:claim').includes('click-6'))
  })

  test('a returned click intentionally excluded from subscriptions never holds another conversation', async () => {
    stand.answer = (name) =>
      name === 'delivery:giveBackBatch'
        ? { back: ['disconnected'], done: true }
        : name === 'delivery:recover'
          ? [{ id: 'disconnected', click: { ...click(9), id: 'disconnected', session: { harness: 'opencode', id: 'closed' } } }]
          : undefined
    await start()
    offered(click(6))
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')).toEqual(['click-6'])
    expect(recoveryClaims().returning).not.toContain('disconnected')
    expect(recoveryClaims().targets.some(([id]) => id === 'disconnected')).toBe(false)
  })

  test.each([false, true])('a refused recovered claim drops its stale snapshot, including when cleanup fails: %s', async (diskFails) => {
    standIn()
    let available = false
    let blocked: string | undefined
    stand.answer = (name, args) => {
      if (name === 'delivery:giveBackBatch') return { back: ['stale'], done: true }
      if (name === 'delivery:recover') return [{ id: 'stale', click: { ...click(6), id: 'stale' } }]
      if (name === 'delivery:claim' && args.ids.includes('stale') && !available) {
        if (diskFails && !blocked) {
          blocked = `${path.join(home, 'delivery-recovery.json')}.${process.pid}.tmp`
          mkdirSync(blocked)
        }
        return []
      }
      return undefined
    }
    await start('socket', { wanted: ['pi'] })
    await pass()
    wants(['codex'])
    await pass()
    expect(called('delivery:claim')).toEqual(['stale'])
    await pass(5)
    expect(called('delivery:claim')).toEqual(['stale'])
    if (blocked) {
      expect(recoveryClaims().returning).toEqual(['stale'])
      rmSync(blocked, { recursive: true })
      blocked = undefined
      await pass()
    }
    expect(recoveryClaims().returning).toEqual([])
    available = true
    offered({ ...click(6), id: 'stale', name: 'offered again' })
    await pass()
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args.join(' ')).toContain('offered again')
  })

  test('a legacy pending result is not delivered until the inbox proves it is no longer parked', async () => {
    standIn()
    const parked = { ...click(6), id: 'parked' }
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch') return { back: ['parked'], done: true, routes: [{ id: 'parked', session: parked.session }] }
      if (name === 'delivery:recover') throw new Error('Could not find public function for delivery:recover')
      // Older get answers omit parkedBy. A pending result alone is not permission to deliver.
      if (name === 'delivery:get') return { ...parked, delivery: 'pending' }
      return undefined
    }
    await start()
    await pass(5)
    expect(stand.codex).toHaveLength(0)
    expect(called('delivery:claim')).toEqual([])
    offered(click(7))
    await pass()
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')).toEqual(['click-7'])
    // Reopening or reviving the conversation makes its click visible in the real inbox.
    offered(parked, click(7))
    await pass()
    await until(() => stand.codex.length === 2)
    expect(called('delivery:claim')).toEqual(['click-7', 'parked'])
  })

  test('an accepted queue receipt still prevents resubmission after its backend confirmation was lost', async () => {
    await start()
    await turn(6, true)
    stand.answer = (name) => {
      if (name === 'delivery:handedOff') throw new Error('offline')
      return undefined
    }
    offeredEarlier(click(6))
    await until(() => stand.codex.length === 1)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-6'))
    const previous = home
    await stop!()
    stop = null
    stand.answer = (name) => (name === 'delivery:giveBackBatch' ? { back: ['click-6'], done: true } : undefined)
    await start('socket', {}, (folder) => {
      writeFileSync(path.join(folder, 'delivery-recovery.json'), readFileSync(path.join(previous, 'delivery-recovery.json')))
    })
    offered(click(6))
    await until(() => called('delivery:handedOff').length >= 2)
    expect(stand.codex).toHaveLength(1)
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
  })

  test.each(['codex', 't3'] as const)('a successful %s handoff is still confirmed when its durable receipt cannot be saved', async (via) => {
    standIn()
    const t3 = await import('./src/t3')
    const send = t3.t3Send
    const temporary = () => `${path.join(home, 'delivery-recovery.json')}.${process.pid}.tmp`
    const sending = vi.spyOn(t3, 't3Send').mockImplementation(async (...args) => {
      const result = await send(...args)
      mkdirSync(temporary())
      return result
    })
    let reachable = false
    stand.answer = (name) => {
      if (name === 'delivery:handedOff' && !reachable) throw new Error('offline')
      return undefined
    }
    try {
      if (via === 't3') {
        stand.t3.running = true
        stand.t3.threads.set('thread-6', 't3-6')
      }
      await start()
      await turn(6, true)
      const clicks = via === 't3' ? [click(6), { ...click(7), session: click(6).session }] : [click(6)]
      const ids = clicks.map((c) => c.id)
      offeredEarlier(...clicks)
      for (let i = 0; i < 5 && stand.codex.length + stand.t3.sent.length === 0; i++) await pass()
      expect(stand.codex.length + stand.t3.sent.length).toBe(1)
      if (via === 'codex') {
        mkdirSync(temporary())
        stand.codex[0]!.end()
      }
      offered()
      await pass(2)
      expect([...new Set(called('delivery:handedOff'))]).toEqual(ids)
      expect(called('delivery:release')).toEqual([])
      expect(recoveryClaims().returning).toEqual(ids)
      rmSync(temporary(), { recursive: true })
      reachable = true
      await pass(2)
      expect(recoveryClaims().returning).toEqual([])
      expect(recoveryClaims().targets).toEqual([])
      offered(...clicks)
      await pass(2)
      expect(stand.codex.length + stand.t3.sent.length).toBe(1)
      expect(called('delivery:claim')).toEqual(ids)
      expect(called('delivery:release')).toEqual([])
      expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(ids)
    } finally {
      sending.mockRestore()
      rmSync(temporary(), { recursive: true, force: true })
    }
  })

  test('a restored accepted receipt is reconciled even when the backend already removed the click from its inbox', async () => {
    standIn()
    await start('socket', {}, (folder) =>
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({ version: 1, waiters: [], marks: [], accepted: ['accepted'], returning: ['accepted'] }),
      ),
    )
    stand.answer = (name) => (name === 'delivery:recover' ? [{ id: 'accepted', click: null }] : undefined)
    offered()
    await pass()
    expect(called('delivery:handedOff')).toContain('accepted')
    expect(JSON.parse(readFileSync(path.join(home, 'delivery-recovery.json'), 'utf8')).accepted).toEqual([])
    expect(stand.codex).toHaveLength(0)
  })

  test('outstanding queue commands reserve durable receipt space before another app can accept a click', async () => {
    stand.answer = (name) => {
      if (name === 'delivery:handedOff') throw new Error('offline')
      return undefined
    }
    await start('socket', {}, (folder) =>
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({ version: 1, waiters: [], marks: [], accepted: Array.from({ length: 199 }, (_, n) => `accepted-${n}`), returning: [] }),
      ),
    )
    offered(click(1), click(2), click(3))
    await until(() => stand.codex.length > 0)
    await settled()
    expect(stand.codex).toHaveLength(1)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-1'))
    expect(JSON.parse(readFileSync(path.join(home, 'delivery-recovery.json'), 'utf8')).accepted).toHaveLength(200)
    expect(stand.codex).toHaveLength(1)
  })

  test('a queue is never used when its waiter recovery copy could not be persisted', async () => {
    await start()
    await turn(6, true)
    const file = path.join(home, 'delivery-recovery.json')
    rmSync(file, { force: true })
    mkdirSync(file)
    offered(click(6))
    await settled()
    await settled()
    expect(stand.codex).toHaveLength(0)
    expect(called('delivery:claim')).toEqual([])
    rmSync(file, { recursive: true })
  })

  test('a connector started anew has It give back what this machine still holds, and takes nothing that was done after until it is offered that again', async () => {
    // The connector before this one claimed a click and ended before it had handed it over: It
    // holds that click back until its lease runs out, and offers the next one meanwhile
    stand.answer = (name) => (name === 'delivery:giveBackBatch' ? { back: ['click-left'], done: true } : undefined)
    await start()
    offered(click(6))
    await until(() => stand.calls.some((c) => c.name === 'delivery:giveBackBatch'))
    await new Promise((r) => setTimeout(r, 600))
    expect(called('delivery:claim')).toEqual([])
    // It offers the earlier one again, and they go in the order they were made
    offered({ ...click(6), id: 'click-left', at: Date.now() - 20_000 }, click(6))
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')[0]).toBe('click-left')
  })

  test('where It cannot be asked for them yet, nothing is taken, and it is asked again', async () => {
    let refuses = true
    stand.answer = (name) => {
      if (name !== 'delivery:giveBackBatch') return undefined
      if (refuses) throw new Error('It did not answer in time, so whether that went through is not known.')
      return { back: [], done: true }
    }
    await start()
    offered(click(6))
    await until(() => stand.calls.filter((c) => c.name === 'delivery:giveBackBatch').length >= 2, 10_000)
    expect(called('delivery:claim')).toEqual([])
    expect(stand.codex).toEqual([])
    refuses = false
    await until(() => stand.codex.length === 1, 10_000)
    expect(called('delivery:claim')).toEqual(['click-6'])
  }, 30_000)

  test('recovery finishes every batch before routing, including empty batches and a later batch that cannot yet be read', async () => {
    standIn(true)
    let batches = 0
    let readable = false
    stand.answer = (name) => {
      if (name !== 'delivery:giveBackBatch') return undefined
      batches++
      if (batches === 1) return { back: ['click-left'], done: false }
      // Stopped clicks fill a batch but none goes back to waiting.
      if (batches === 2) return { back: [], done: false }
      if (!readable) throw new Error('The next recovery batch could not be read.')
      return { back: [], done: true }
    }
    await start()
    offered({ ...click(6), id: 'click-left', at: Date.now() - 20_000 }, click(6))
    await pass(3)
    expect(batches).toBeGreaterThan(2)
    // Even after the old initial-retry deadline, an incomplete batch sequence is not complete.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 40_000)
    try {
      await pass(2)
      expect(called('delivery:claim')).toEqual([])
      expect(stand.codex).toEqual([])
      readable = true
      await pass(2)
      await until(() => stand.codex.length === 1)
      expect(called('delivery:claim')[0]).toBe('click-left')
    } finally {
      clock.mockRestore()
    }
  })

  test('an unanswered first recovery batch still blocks routing after old leases expire', async () => {
    standIn(true)
    let readable = false
    stand.answer = (name) => {
      if (name !== 'delivery:giveBackBatch') return undefined
      if (!readable) throw new Error('Recovery is temporarily unavailable.')
      return { back: [], done: true }
    }
    await start()
    offered(click(6))
    await pass(2)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90_000)
    try {
      await pass(2)
      expect(called('delivery:claim')).toEqual([])
      expect(stand.codex).toEqual([])
      readable = true
      await pass(2)
      await until(() => stand.codex.length === 1)
      expect(called('delivery:claim')).toEqual(['click-6'])
    } finally {
      clock.mockRestore()
    }
  })

  test('an It from before it could be asked that is asked to give back each click the journal names, a record that was cut short among them or not', async () => {
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch') throw new Error(`Could not find public function for '${name}'.`)
      return undefined
    }
    await start('socket', {}, (folder) =>
      writeFileSync(
        path.join(folder, 'journal.jsonl'),
        [
          `${JSON.stringify({ t: Date.now() - 5000, event: 'claimed', id: 'click-done' })}\n`,
          `${JSON.stringify({ t: Date.now() - 4000, event: 'acked', id: 'click-done' })}\n`,
          // A record that a crash cut short, with nothing to end its line: it is passed over, and says nothing of what was written after it
          '{"t":17,"event":"cla',
          `\n${JSON.stringify({ t: Date.now() - 2000, event: 'claimed', id: 'click-left' })}\n`,
        ].join(''),
      ),
    )
    offered(click(6))
    await until(() => called('delivery:release').includes('click-left'))
    expect(called('delivery:release')).toEqual(['click-left'])
    expect(stand.calls.some((c) => c.name === 'delivery:giveBack')).toBe(false)
    expect(called('delivery:claim')).toEqual([])
    offered({ ...click(6), id: 'click-left', at: Date.now() - 20_000 }, click(6))
    await until(() => stand.codex.length === 1)
    expect(called('delivery:claim')[0]).toBe('click-left')
  })

  test('a click made while Codex’s queue holds an earlier one behind the running turn follows it into the queue, and is not given to the turn’s next hook ahead of it', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    await takenByTheQueue(6)
    const commands = stand.codex.length
    // Made this moment, which by itself would have it kept for the turn's next hook
    offered({ ...click(6), id: 'click-6-later', at: Date.now() })
    await until(() => stand.codex.length === commands + 1)
    expect(called('delivery:claim')).toContain('click-6-later')
    // The hook that comes next is handed nothing: the earlier click is read first, when the turn is done, and this one after it
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-6'))?.clicks).toEqual([])
  })

  test('nor is it given to the next hook while the earlier one has only its place in line for the queue, and nothing has been asked for it yet', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    // The earlier click's claim is not answered yet: it is in neither of Codex's hands nor behind the turn
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name, args) => (name === 'delivery:claim' && args.ids.includes('click-6') ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offeredEarlier(click(6))
    await until(() => called('delivery:claim').includes('click-6'))
    offered(click(6), { ...click(6), id: 'click-6-later', at: Date.now() })
    await new Promise((r) => setTimeout(r, 300))
    expect((await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-6'))?.clicks).toEqual([])
    expect(called('delivery:claim')).not.toContain('click-6-later')
    answerClaim(['click-6'])
    await until(() => stand.codex.length === 1)
  })

  test('an older click’s reserved queue place still precedes a new hook click after the conversation changes its id', async () => {
    await start()
    await turn(6, true)
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name, args) => (name === 'delivery:claim' && args.ids.includes('click-6') ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offeredEarlier(click(6))
    await until(() => called('delivery:claim').includes('click-6'))
    try {
      expect(await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-60', was: 'thread-6', busy: true } })).toEqual({ ok: true })
      offered({ ...click(60), at: Date.now() })
      const hook = await local<{ clicks: { id: string }[] }>('/clicks?harness=codex&session=thread-60')
      expect(hook?.clicks).toEqual([])
      expect(called('delivery:claim')).not.toContain('click-60')
      // The running turn ends before the old claim answers, so the queued click uses a mark.
      await turn(60, false)
    } finally {
      answerClaim(['click-6'])
    }
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain('--thread=thread-60')
    expect((await local<{ texts: string[] }>('/marked', { method: 'POST', body: { harness: 'codex', session: 'thread-60' } }))?.texts[0]).toContain('click-6')
    stand.codex[0]!.end()
    await until(() => stand.codex.length === 2)
    expect(called('delivery:claim')).toEqual(['click-6', 'click-60'])
  })

  test('a queued click is not repeated to a waiter when a new turn also changes the conversation id', async () => {
    await start()
    await turn(6, true)
    await takenByTheQueue(6)
    await turn(7, true)
    await takenByTheQueue(7)
    // Codex has advanced the queued click into a turn and reports the new conversation id with it.
    expect(await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-60', was: 'thread-6', busy: true } })).toEqual({ ok: true })
    expect((await waitingFor(60))?.clicks).toBeUndefined()
    expect(readJson<{ waiters: [string, unknown][] }>(path.join(home, 'delivery-recovery.json'))!.waiters.map(([id]) => id)).toEqual(['click-7'])
    // Another conversation is still in its earlier turn, so its waiter can still have its queued click.
    expect((await waitingFor(7))?.clicks?.map((c) => c.id)).toEqual(['click-7'])
    expect(called('delivery:handedOff')).toEqual(['click-6', 'click-7'])
  })

  test.each([false, true])('a turn begun while Codex is taking a click keeps its waiter copy, unless already printed: %s', async (printedEarly) => {
    standIn()
    await start()
    await turn(6, false)
    offered(click(6))
    await until(() => stand.codex.length === 1)
    // The queue command has started against an idle conversation. A new turn starts before
    // it accepts the click, which now waits behind that turn in Codex's queue.
    await turn(6, true)
    if (printedEarly) {
      expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
      expect((await waitingFor(6))?.clicks).toBeUndefined()
    }
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-6'))
    offered()
    await settled()
    expect(readJson<{ waiters: [string, unknown][] }>(path.join(home, 'delivery-recovery.json'))!.waiters.map(([id]) => id)).toEqual(
      printedEarly ? [] : ['click-6'],
    )
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(printedEarly ? undefined : ['click-6'])
  })

  test('a waiter that says it has a click while Codex’s command for it is still to answer is not given it again once the command has', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    offeredEarlier(click(6))
    await until(() => stand.codex.length === 1)
    // Codex's command has been started and has not answered: the waiter of the running turn is given the click meanwhile
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    // It prints it and says so, and only then does the command answer
    expect((await waitingFor(6))?.clicks).toBeUndefined()
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-6'))
    offered()
    // The next wait of the turn, by another waiter and well after, is given nothing of it
    const next = () =>
      local<{ ok: boolean; clicks?: { id: string }[] }>('/waiting', {
        method: 'POST',
        body: { id: 'waiter-6-next', session: { harness: 'codex', id: 'thread-6' } },
      })
    expect((await next())?.clicks).toBeUndefined()
    await new Promise((r) => setTimeout(r, 10_200))
    expect((await next())?.clicks).toBeUndefined()
  }, 30_000)

  test('a waiter that an answer never reached is given the click again when it next asks, and no more once it says that it has it', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    await takenByTheQueue(6)
    // The answer that carried the click is lost on its way. The wait has printed nothing, and asks again two seconds on
    expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    expect((await waitingFor(6))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    // It has printed it now, and says so with its next asking
    expect((await waitingFor(6))?.clicks).toBeUndefined()
    expect(called('delivery:handedOff')).toEqual(['click-6'])
  })

  test('a waiter that went away without saying it had the click leaves it for the next wait of that turn, though not at once', async () => {
    await start()
    expect(await turn(6, true)).toEqual({ ok: true })
    await takenByTheQueue(6)
    const next = () =>
      local<{ ok: boolean; clicks?: { id: string }[] }>('/waiting', {
        method: 'POST',
        body: { id: 'waiter-6-next', session: { harness: 'codex', id: 'thread-6' } },
      })
    expect((await waitingFor(6, true))?.clicks?.map((c) => c.id)).toEqual(['click-6'])
    // The first may be printing it this moment, so another wait is not given it yet
    expect((await next())?.clicks).toBeUndefined()
    // Ten seconds on the first has not said that it has it: it never did, or is gone
    await new Promise((r) => setTimeout(r, 10_200))
    expect((await next())?.clicks?.map((c) => c.id)).toEqual(['click-6'])
  }, 30_000)

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
  const offered = (...clicks: ReturnType<typeof click>[]) => stand.watching.get('delivery:inboxPage')!(clicks)
  const called = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
  const session = (harness: string, n: number, more: Record<string, unknown> = {}) =>
    local('/session', { method: 'POST', body: { harness, session: `conversation-${n}`, ...more } })
  const clicksFor = (harness: string, n: number) => local<{ clicks: { id: string }[] }>(`/clicks?harness=${harness}&session=conversation-${n}`)

  test('inbox discovery advances without new clicks and keeps its cursor through listener changes', async () => {
    standIn()
    await start()
    const cursor = () => (stand.asking.get('delivery:inboxPage') as { after: { harness: string; id: string }[] }).after
    const first = stand.watching.get('delivery:inboxPage')!
    first({ clicks: [], after: [{ harness: 'codex', id: 'thread-12' }] })
    await pass()
    expect(cursor()).toEqual([{ harness: 'codex', id: 'thread-12' }])
    // A late answer from the old subscription cannot rewind the next page.
    first({ clicks: [], after: [{ harness: 'codex', id: 'thread-01' }] })
    await pass()
    expect(cursor()).toEqual([{ harness: 'codex', id: 'thread-12' }])
    stand.watching.get('delivery:inboxPage')!({ clicks: [], after: [{ harness: 'codex', id: 'thread-24' }] })
    await session('pi', 5)
    expect(cursor()).toEqual([{ harness: 'codex', id: 'thread-24' }])
    // A subscription that has no answer yet leaves its place unchanged.
    await session('pi', 6)
    expect(cursor()).toEqual([{ harness: 'codex', id: 'thread-24' }])
    stand.watching.get('delivery:inboxPage')!({ clicks: [], after: [{ harness: 'codex', id: '' }] })
    await pass()
    expect(cursor()).toEqual([{ harness: 'codex', id: '' }])
    // Even after rollover recreates the original arguments, its old callback stays obsolete.
    stand.watching.get('delivery:inboxPage')!({ clicks: [], after: [{ harness: 'codex', id: 'thread-36' }] })
    first({ clicks: [], after: [{ harness: 'codex', id: 'thread-01' }] })
    await pass()
    expect(cursor()).toEqual([{ harness: 'codex', id: 'thread-36' }])
  })

  test('with none connected, Codex’s own command is never run for a click, and the connector asks It for no click of Codex’s queue', async () => {
    standIn()
    // Codex is on the machine, with nothing of It's in it, and the person chose no app
    await start('socket', { wanted: [], found: [{ id: 'codex', version: '1.0.0', addon: 'not_connected' }] })
    expect(stand.asking.get('delivery:inboxPage')).toEqual({ listening: [], queues: [], after: [] })
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
    expect(stand.asking.get('delivery:inboxPage')).toEqual({ listening: [], queues: ['codex'], after: [{ harness: 'codex', id: '' }] })
    await stop?.()
    stop = null
    stand.watching.clear()
    stand.asking.clear()
    // The same machine, with It not yet heard from
    home = mkdtempSync(path.join(os.tmpdir(), 'it-connector-'))
    process.env.IT_HOME = home
    const had = new Set(process.listeners('SIGTERM'))
    const running = runConnector((line) => said.push(line))
    await until(() => existsSync(infoFile()) && stand.watching.has('delivery:inboxPage'))
    stop = async () => {
      ;(process.listeners('SIGTERM').find((l) => !had.has(l)) as (signal: string) => void)('SIGTERM')
      await running
    }
    expect(stand.asking.get('delivery:inboxPage')).toEqual({ listening: [], queues: [], after: [] })
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
      expect([addon, stand.asking.get('delivery:inboxPage')]).toEqual([addon, { listening: [], queues: [], after: [] }])
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

  test('an add-on that speaks after its app was found waiting for the person’s yes has the machine looked at again at once, and what is found then is reported', async () => {
    standIn()
    await start('socket', { wanted: ['codex'], found: [{ id: 'codex', version: '1.0.0', addon: 'needs_approval' }] })
    const reportedOfCodex = () =>
      stand.calls
        .filter((c) => c.name === 'machines:report')
        .map((c) => (c.args.harnesses as { id: string; addon: string }[]).find((h) => h.id === 'codex')?.addon)
    await until(() => reportedOfCodex().length > 0)
    expect(new Set(reportedOfCodex())).toEqual(new Set(['needs_approval']))
    // The person has said yes since, at the app's own asking, and the app now runs the add-on's hooks: the first of them is heard
    stand.found = [{ id: 'codex', version: '1.0.0', addon: 'connected' }]
    expect(await session('codex', 9)).toEqual({ ok: true })
    await until(() => reportedOfCodex().at(-1) === 'connected')
    // Found connected, it has no more looks made for it: what it says next is not answered with one
    const reports = reportedOfCodex().length
    stand.found = [{ id: 'codex', version: '1.0.0', addon: 'error' }]
    expect(await session('codex', 9)).toEqual({ ok: true })
    await settled()
    await pass(2)
    expect(
      reportedOfCodex()
        .slice(reports)
        .filter((addon) => addon !== 'connected'),
    ).toEqual([])
  })

  test('an add-on that asks from an app the person did not choose is answered and given nothing, and its conversation is not listened for', async () => {
    standIn()
    await start('socket', { wanted: ['codex'] })
    expect(await session('pi', 5)).toEqual({ ok: true })
    expect(await clicksFor('pi', 5)).toEqual({ clicks: [] })
    expect((await local<{ sessions: string[] }>('/health'))?.sessions).toEqual([])
    expect(stand.asking.get('delivery:inboxPage')).toEqual({ listening: [], queues: ['codex'], after: [{ harness: 'codex', id: '' }] })
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
    expect(stand.asking.get('delivery:inboxPage')).toEqual({
      listening: [{ harness: 'pi', id: 'conversation-5' }],
      queues: ['codex'],
      after: [{ harness: 'codex', id: '' }],
    })
    offered(click('pi', 5))
    await until(() => called('delivery:claim').includes('click-5'))
    expect((await clicksFor('pi', 5))?.clicks.map((c) => c.id)).toEqual(['click-5'])
  })

  test.each(['current', 'stale'])('a click already held follows a session move reported by a %s build', async (build) => {
    await start()
    await session('pi', 6)
    offered(click('pi', 6))
    await until(() => called('delivery:claim').includes('click-6'))
    // Given, and waiting to go in with a command's result when the person clears the conversation
    expect((await clicksFor('pi', 6))?.clicks.map((c) => c.id)).toEqual(['click-6'])
    const runtime = { instance: 'loaded-pi', addon: { api: 1, version: ADDONS.pi!.version, delivery: true, idle: true } }
    expect(
      await session('pi', 60, {
        was: 'conversation-6',
        ...runtime,
        addon: { ...runtime.addon, version: build === 'stale' ? 'old-build' : runtime.addon.version },
      }),
    ).toMatchObject({ ok: build === 'current' })
    // After the current build loads, the held click is immediately available under the new id.
    const answer = await local<{ clicks: { id: string }[] }>('/clicks', {
      method: 'POST',
      body: { harness: 'pi', session: 'conversation-60', ...runtime },
    })
    expect(answer?.clicks.map((c) => c.id)).toEqual(['click-6'])
    expect(called('delivery:release')).toEqual([])
  })

  test('what a connector that has stopped was still in the middle of is written down nowhere: its notes are no longer its own', async () => {
    await start()
    await session('pi', 6)
    // The claim of a click is on its way to It when the connector is stopped
    let answerClaim: (ids: string[]) => void = () => {}
    stand.answer = (name) => (name === 'delivery:claim' ? new Promise<string[]>((r) => (answerClaim = r)) : undefined)
    offered(click('pi', 6))
    await until(() => called('delivery:claim').includes('click-6'))
    const folder = home
    await stop?.()
    stop = null
    // The service clears what the connector had noted, as it does when everything is erased
    rmSync(path.join(folder, 'journal.jsonl'), { force: true })
    // The answer comes after all, and what the connector does with it then leaves no note behind
    answerClaim(['click-6'])
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(path.join(folder, 'journal.jsonl'))).toBe(false)
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
    expect(stand.asking.get('delivery:inboxPage')).toEqual({ listening: [], queues: [], after: [] })
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
    stand.watching.get('delivery:inboxPage')!([
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
    stand.watching.get('delivery:inboxPage')!([
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
    stand.watching.get('delivery:inboxPage')!([
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
    stand.watching.get('delivery:inboxPage')!([
      { id: 'click-5', artifact: 'plan', title: 'A page', name: 'approve', payload: '{}', at: Date.now() - 1000, attended: true, session },
    ])
    for (let n = 0; n < 100 && (await local<{ held: number }>('/health'))?.held !== 1; n++) await new Promise((r) => setTimeout(r, 30))
    expect((await local<{ held: number }>('/health'))?.held).toBe(1)
    // From here It cannot be reached to make the hold good again, and gives the click to another machine when its half minute
    // is over: it is no longer among what It offers this one
    stand.answer = (name) => (name === 'delivery:renew' ? Promise.reject(new Error('no answer')) : undefined)
    stand.watching.get('delivery:inboxPage')!([])
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
    stand.watching.get('delivery:inboxPage')!([click])
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

describe.skipIf(process.platform === 'win32')('a click for a Codex conversation, where T3 Code is running', () => {
  const click = (n: number, thread = n) => ({
    id: `click-${n}`,
    artifact: `page-${n}`,
    title: 'A page',
    name: 'approve',
    payload: '{"plan":"B"}',
    at: Date.now() - 10_000 + n,
    attended: true,
    session: { harness: 'codex', id: `thread-${thread}` },
  })
  const offered = (...clicks: ReturnType<typeof click>[]) => stand.watching.get('delivery:inboxPage')!(clicks)
  const called = (name: string) => stand.calls.filter((c) => c.name === name).flatMap((c) => c.args.ids ?? [c.args.id])
  const turn = (n: number, busy: boolean) => local('/session', { method: 'POST', body: { harness: 'codex', session: `thread-${n}`, busy } })
  /**
   * T3 Code is running, and It answers as it does: a click it has been told was handed over is
   * given to no machine again, whatever a list of what is waiting still says for a moment.
   */
  const withT3Code = () => {
    stand.t3.running = true
    const handed = new Set<string>()
    stand.answer = (name, args) => {
      if (name === 'delivery:handedOff') handed.add(args.id)
      if (name === 'delivery:claim') return (args.ids as string[]).filter((id) => !handed.has(id))
      return undefined
    }
  }
  /** What each waiter has been given, which it says with its next asking, as `it wait` does once it has printed it. */
  const printed = new Map<number, string[]>()
  beforeEach(() => printed.clear())
  const waitingFor = async (n: number, page?: number) => {
    const answer = await local<{ ok: boolean; clicks?: { id: string }[] }>('/waiting', {
      method: 'POST',
      body: {
        id: `waiter-${n}`,
        session: { harness: 'codex', id: `thread-${n}` },
        ...(page === undefined ? {} : { slug: `page-${page}` }),
        ...(printed.has(n) ? { got: printed.get(n) } : {}),
      },
    })
    if (answer?.clicks?.length) printed.set(n, [...(printed.get(n) ?? []), ...answer.clicks.map((c) => c.id)])
    return answer
  }

  test.each([false, true])('an attended ninth click is delivered after timer turns exhaust their budget, while discovery advances: %s', async (rotate) => {
    withT3Code()
    standIn()
    stand.t3.threads.set('thread-30', 't3-thread-budget')
    await start()
    for (let n = 1; n <= 3; n++) {
      offered({ ...click(n, 30), attended: false })
      await until(() => called('delivery:handedOff').includes(`click-${n}`))
    }
    expect(stand.t3.sent).toHaveLength(3)
    const timers = Array.from({ length: 8 }, (_, i) => ({ ...click(10 + i, 30), attended: false }))
    offered(...timers)
    await pass(2)
    expect(stand.t3.sent).toHaveLength(3)
    const attended = click(18, 30)
    const answer = stand.answer!
    let resume: (() => void) | undefined
    stand.answer = (name, args) => {
      if (rotate && name === 'delivery:claim' && args.ids[0] === timers[0]!.id && !resume)
        return new Promise((resolve) => {
          resume = () => resolve(answer(name, args) ?? args.ids)
        })
      return answer(name, args)
    }
    stand.watching.get('delivery:inboxPage')!({ clicks: [...timers, attended], after: [{ harness: 'codex', id: 'thread-30' }] })
    if (rotate) {
      await until(() => resume !== undefined)
      await pass()
      offered()
      resume!()
    }
    await pass(2)
    expect(stand.t3.sent).toHaveLength(4)
    const sent = stand.t3.sent[3]!.text
    expect([...sent.matchAll(/\[action ([^\]]+)\]/g)].map((m) => m[1])).toEqual([...timers.slice(0, 7), attended].map((c) => c.id))
    for (const c of [...timers.slice(0, 7), attended]) expect(sent).toContain(`[action ${c.id}]`)
    expect(sent).not.toContain(`[action ${timers[7]!.id}]`)
    expect(called('delivery:handedOff')).toContain(attended.id)
    expect(called('delivery:handedOff')).not.toContain(timers[7]!.id)
    offered(timers[7]!)
    await pass(2)
    expect(stand.t3.sent).toHaveLength(4)
  })

  test('one whose conversation is held in a thread is put to the thread, though some Codex has the conversation open, and Codex’s queue is not used', async () => {
    withT3Code()
    stand.t3.threads.set('thread-1', 't3-thread-a')
    await start()
    offered(click(1))
    await until(() => stand.t3.sent.length >= 1)
    await until(() => called('delivery:handedOff').includes('click-1'))
    // What stands in the thread is one short line: the page, what was done, and the id the rest is read by
    expect(stand.t3.sent[0]).toEqual({ thread: 't3-thread-a', text: '[It] "A page" (page-1): approve, with details [action click-1]' })
    // The Codex that T3 Code holds has the conversation open, and its queue would have taken it
    expect(stand.closed.has('thread-1')).toBe(false)
    expect(stand.codex).toEqual([])
    // And it was put to the thread once, however long the list of what is waiting goes on naming it
    await pause(2500)
    expect(stand.t3.sent.length).toBe(1)
  })

  test('what a person typed above a page stands in the thread as they typed it, with none of It’s words to the agent, and is kept off Codex’s command line', async () => {
    withT3Code()
    stand.t3.threads.set('thread-6', 't3-thread-f')
    await start()
    const typed = (n: number) => ({ ...click(n), name: 'it:message', payload: '{"text":"Make the board bigger"}' })
    offered(typed(6))
    await until(() => stand.t3.sent.length >= 1)
    expect(stand.t3.sent[0]!.text).toBe('[It] "A page" (page-6), typed above it: Make the board bigger [action click-6]')
    // In Codex's queue the line is an argument of a command, which others on the machine can read
    offered(typed(7))
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain('--message=[It] "A page" (page-7), typed above it: read it with `it action click-7` [action click-7]')
    expect(JSON.stringify(stand.codex[0]!.args)).not.toContain('bigger')
  })

  /** The conversation's hooks are heard from, as they are once a turn of it has run with It's add-on there. */
  const heard = (n: number) => turn(n, false)
  /** What a hook of the conversation is handed when it asks what the marks put into it stand for: the words, and the names it says afterwards that it has them by. */
  const asksBehind = (n: number, more: Record<string, unknown> = {}) =>
    local<{ texts: string[]; marks: string[] }>('/marked', { method: 'POST', body: { harness: 'codex', session: `thread-${n}`, ...more } })
  const behindMarks = async (n: number) => (await asksBehind(n))?.texts
  /** The hook says that the agent has what it was handed. */
  const hasThem = async (n: number) =>
    local('/marked', { method: 'POST', body: { harness: 'codex', session: `thread-${n}`, taken: (await asksBehind(n))?.marks } })
  const inFull = (n: number, name = 'approve {"plan":"B"}') =>
    `[It] The page "A page" (page-${n}) sent this just after someone used it: ${name} [action click-${n}]`

  test.each(['codex', 't3-codex', 't3-claude'])('a full mark record uses the normal short line through %s without losing older marks', async (via) => {
    const harness = via === 't3-claude' ? 'claude-code' : 'codex'
    if (via !== 'codex') {
      withT3Code()
      stand.t3.threads.set('thread-9', 't3-thread-9')
    }
    const marks = Array.from({ length: 200 }, (_, n) => ({
      id: `old-mark-${n}`,
      texts: [`Saved text ${n}`],
      at: Date.now(),
      fallback: { via: 'codex', text: 'Saved short line' },
      retry: { attempts: 4, nextAt: null },
    }))
    await start('socket', { wanted: ['codex', 'claude-code'], found: [...CONNECTED, { id: 'claude-code', addon: 'connected' }] }, (folder) => {
      writeFileSync(path.join(folder, 'heard.json'), JSON.stringify({ [`${harness}:thread-9`]: 1 }))
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({
          version: 1,
          waiters: [],
          marks: [['codex:thread-6', marks]],
          accepted: [],
          returning: [],
        }),
      )
    })
    offered({ ...click(9), session: { harness, id: 'thread-9' }, name: 'it:message', payload: '{"text":"Make the board bigger"}' })
    if (via === 'codex') {
      await until(() => stand.codex.length === 1)
      expect(stand.codex[0]!.args).toContain('--message=[It] "A page" (page-9), typed above it: read it with `it action click-9` [action click-9]')
      expect(JSON.stringify(stand.codex[0]!.args)).not.toContain('bigger')
      stand.codex[0]!.end()
    } else {
      await until(() => stand.t3.sent.length === 1)
      expect(stand.t3.sent[0]).toEqual({ thread: 't3-thread-9', text: '[It] "A page" (page-9), typed above it: Make the board bigger [action click-9]' })
    }
    await until(() => called('delivery:handedOff').includes('click-9'))
    expect(readJson<{ marks: unknown }>(path.join(home, 'delivery-recovery.json'))!.marks).toEqual([['codex:thread-6', marks]])
    expect(await behindMarks(6)).toEqual(marks.flatMap((m) => m.texts))
  })

  test('a conversation whose hooks are heard from is given the mark alone in its thread, and its hook is handed what the mark stands for, once', async () => {
    withT3Code()
    stand.t3.threads.set('thread-8', 't3-thread-h')
    await start()
    await heard(8)
    offered(click(8))
    await until(() => stand.t3.sent.length >= 1)
    expect(stand.t3.sent[0]).toEqual({ thread: 't3-thread-h', text: MARK })
    await until(() => called('delivery:handedOff').includes('click-8'))
    // The hook that runs as the turn begins asks, and is given the click in full
    expect(await behindMarks(8)).toEqual([inFull(8)])
    // Its answer may be lost on the way, or the hook may die with it unread: asked again, it is given again
    expect(await behindMarks(8)).toEqual([inFull(8)])
    // A turn the person began with a message of their own is not handed it: the mark's own turn is still to come
    expect((await asksBehind(8, { own: true }))?.texts).toEqual([])
    // Once the hook has said that the agent has it, it is let go of
    await hasThem(8)
    expect(await behindMarks(8)).toEqual([])
    // Another conversation's hook is given nothing of it
    offered({ ...click(8), id: 'click-8-next' })
    await until(() => stand.t3.sent.length >= 2)
    expect(await behindMarks(1)).toEqual([])
    expect((await behindMarks(8))?.length).toBe(1)
    expect(stand.codex).toEqual([])
  })

  test('an accepted mark survives restart without being submitted again and only its own receipt removes it', async () => {
    await start()
    await heard(9)
    offered(click(9))
    await until(() => stand.codex.length === 1)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-9'))
    const before = await asksBehind(9)
    const previous = home
    await stop!()
    stop = null
    await start('socket', {}, (folder) => {
      for (const name of ['delivery-recovery.json', 'heard.json']) {
        if (existsSync(path.join(previous, name))) writeFileSync(path.join(folder, name), readFileSync(path.join(previous, name)))
      }
    })
    expect(await asksBehind(9)).toEqual(before)
    wants([])
    expect((await asksBehind(9))?.texts).toEqual([])
    wants(['codex'])
    await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-99', was: 'thread-9' } })
    expect(await asksBehind(99)).toEqual(before)
    expect(await asksBehind(1, { taken: before!.marks })).toEqual({ ok: true })
    expect(await asksBehind(9)).toEqual(before)
    expect(stand.codex).toHaveLength(1)
    await asksBehind(9, { taken: before!.marks })
    expect((await asksBehind(9))?.texts).toEqual([])
  })

  test.each(['codex', 't3'] as const)('a restored %s mark sends its short-line fallback after settings and recovery answer', async (via) => {
    standIn(true)
    if (via === 't3') {
      withT3Code()
      stand.t3.threads.set('thread-9', 't3-thread-nine')
    }
    await start()
    await heard(9)
    offered({ ...click(9), name: 'it:message', payload: '{"text":"Private fallback message"}' })
    for (let i = 0; i < 5 && stand.codex.length + stand.t3.sent.length < 1; i++) await pass()
    if (via === 'codex') stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-9'))
    offered()
    const previous = home
    await stop!()
    stop = null
    let reconciled = false
    stand.answer = (name) => {
      if (name === 'delivery:giveBackBatch' && !reconciled) throw new Error('offline')
      return undefined
    }
    await start('socket', { deferSettings: true }, (folder) => {
      for (const name of ['delivery-recovery.json', 'heard.json']) writeFileSync(path.join(folder, name), readFileSync(path.join(previous, name)))
    })
    await pass(25)
    expect(stand.codex.length + stand.t3.sent.length).toBe(1)
    wants(['codex'])
    await pass(25)
    expect(stand.codex.length + stand.t3.sent.length).toBe(1)
    reconciled = true
    await pass(25)
    await until(() => stand.codex.length + stand.t3.sent.length === 2)
    if (via === 'codex') {
      expect(stand.codex[1]!.args).toContain('--message=[It] "A page" (page-9), typed above it: read it with `it action click-9` [action click-9]')
      expect(JSON.stringify(stand.codex)).not.toContain('Private fallback message')
      stand.codex[1]!.end()
    } else {
      expect(stand.t3.sent[1]).toEqual({ thread: 't3-thread-nine', text: '[It] "A page" (page-9), typed above it: Private fallback message [action click-9]' })
      expect(stand.codex).toEqual([])
    }
    await until(async () => (await behindMarks(9))?.length === 0)
  })

  const savedMark = () =>
    readJson<{ marks: [string, { retry?: { attempts: number; nextAt: number | null } }[]][] }>(path.join(home, 'delivery-recovery.json'))!.marks[0]![1][0]!
  const restartMarks = async () => {
    const previous = home
    await stop!()
    stop = null
    await start('socket', {}, (folder) => {
      for (const name of ['delivery-recovery.json', 'heard.json']) writeFileSync(path.join(folder, name), readFileSync(path.join(previous, name)))
    })
    await pass()
  }

  test.each(['codex', 't3'] as const)('a %s mark keeps its backoff and retry limit across consecutive restarts', async (via) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    if (via === 't3') {
      withT3Code()
      stand.t3.threads.set('thread-9', 't3-thread-nine')
    }
    await start()
    await heard(9)
    offered(click(9))
    for (let i = 0; i < 5 && stand.codex.length + stand.t3.sent.length < 1; i++) await pass()
    if (via === 'codex') stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-9'))
    offered()
    stand.t3.refusing = 'offline'
    const attempts = () => (via === 'codex' ? stand.codex.length - 1 : stand.t3.refused.length)
    await pass(20)
    for (let n = 1; n <= 4; n++) {
      expect(attempts()).toBe(n)
      if (via === 'codex') stand.codex[n]!.end(new Error('declined'))
      await settled()
      const retry = savedMark().retry!
      expect(retry.attempts).toBe(n)
      if (n === 4) expect(retry.nextAt).toBeNull()
      else expect(retry.nextAt).toBe(Date.now() + [20_000, 60_000, 300_000][n - 1]!)
      await restartMarks()
      expect(savedMark().retry).toEqual(retry)
      expect(attempts()).toBe(n)
      if (n < 4) {
        await vi.advanceTimersByTimeAsync(retry.nextAt! - Date.now() - 1)
        expect(attempts()).toBe(n)
        await vi.advanceTimersByTimeAsync(1)
        await settled()
      }
    }
    await pass(600)
    expect(attempts()).toBe(4)
    expect(await behindMarks(9)).toEqual([inFull(9)])
    await hasThem(9)
    expect(await behindMarks(9)).toEqual([])
  })

  test('an interrupted fallback attempt is already counted when the connector restarts', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await start()
    await heard(9)
    offered(click(9))
    await pass()
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-9'))
    offered()
    await pass(20)
    expect(stand.codex).toHaveLength(2)
    const retry = savedMark().retry!
    expect(retry).toEqual({ attempts: 1, nextAt: Date.now() + 20_000 })
    await restartMarks()
    // A late answer from the stopped connector cannot change the restored progress.
    stand.codex[1]!.end(new Error('declined'))
    await settled()
    expect(savedMark().retry).toEqual(retry)
    await vi.advanceTimersByTimeAsync(retry.nextAt! - Date.now() - 1)
    expect(stand.codex).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await settled()
    expect(stand.codex).toHaveLength(3)
    expect(savedMark().retry?.attempts).toBe(2)
  })

  test('a fallback waits for durable progress and retries after a failed atomic write', async () => {
    standIn(true)
    await start()
    await heard(9)
    offered(click(9))
    await pass()
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-9'))
    offered()
    // Confirmation now flushes its receipt asynchronously. Finish it before making
    // the next atomic save fail, rather than racing its temporary file.
    await settled()
    const file = path.join(home, 'delivery-recovery.json')
    const before = readFileSync(file, 'utf8')
    const blocked = `${file}.${process.pid}.tmp`
    mkdirSync(blocked)
    await pass(20)
    expect(stand.codex).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(before)
    rmSync(blocked, { recursive: true })
    await pass(20)
    expect(stand.codex).toHaveLength(2)
    expect(savedMark().retry?.attempts).toBe(1)
    stand.codex[1]!.end(new Error('declined'))
    await settled()
    await pass(20)
    expect(stand.codex).toHaveLength(3)
    expect(savedMark().retry?.attempts).toBe(2)
  })

  test.each(['acknowledged', 'disconnected', 'closed', 'erased'] as const)('a restored mark is not sent after it is %s', async (state) => {
    standIn(true)
    await start('socket', {}, (folder) =>
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({
          version: 1,
          waiters: [],
          accepted: [],
          returning: [],
          marks: [
            [
              'codex:thread-9',
              [
                {
                  id: 'restored-mark',
                  texts: ['Private text'],
                  at: Date.now(),
                  fallback: { via: 'codex', text: '[It] safe short line' },
                },
              ],
            ],
          ],
        }),
      ),
    )
    if (state === 'acknowledged') await asksBehind(9, { taken: ['restored-mark'] })
    if (state === 'disconnected') wants([])
    if (state === 'closed') stand.closed.add('thread-9')
    if (state === 'erased') {
      eraseDeliveryRecovery()
      await stop!()
      stop = null
    }
    await pass(25)
    expect(stand.codex).toEqual([])
    if (state === 'erased') expect(existsSync(path.join(home, 'delivery-recovery.json'))).toBe(false)
    else if (state !== 'acknowledged') expect(readJson<{ marks: unknown[] }>(path.join(home, 'delivery-recovery.json'))?.marks).toHaveLength(1)
  })

  test('the mark goes into Codex’s queue as well, and what a person typed is handed over behind it and kept off the command line', async () => {
    await start()
    await heard(9)
    offered({ ...click(9), name: 'it:message', payload: '{"text":"Make the board bigger"}' })
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain(`--message=${MARK}`)
    expect(JSON.stringify(stand.codex[0]!.args)).not.toContain('bigger')
    const behind = await behindMarks(9)
    expect(behind?.length).toBe(1)
    expect(behind![0]).toContain('The user typed this to you in the box above the page "A page" (page-9)')
    expect(behind![0]).toContain('"Make the board bigger"')
  })

  test('a conversation that was heard from before the connector was started anew is given the mark as well', async () => {
    withT3Code()
    stand.t3.threads.set('thread-10', 't3-thread-j')
    await start('socket', {}, (home) => writeFileSync(path.join(home, 'heard.json'), JSON.stringify({ 'codex:thread-10': 1 })))
    offered(click(10))
    await until(() => stand.t3.sent.length >= 1)
    expect(stand.t3.sent[0]).toEqual({ thread: 't3-thread-j', text: MARK })
  })

  test.each([false, true])('an unanswered Codex mark retries in its recorded profile unless that profile has gone: %s', async (gone) => {
    standIn(true)
    await start()
    const profile = path.join(home, 'conversation-profile')
    mkdirSync(profile)
    await noteConversation({ harness: 'codex', id: 'thread-11' }, home, { version: 1, paths: { CODEX_HOME: profile } })
    const held = vi.spyOn(wake, 'codexHeld').mockImplementation((_thread, folder) => folder === profile)
    try {
      await heard(11)
      offered(click(11))
      await pass(2)
      expect(stand.codex).toHaveLength(1)
      expect(stand.codex[0]!.args).toContain(`--message=${MARK}`)
      stand.codex[0]!.end()
      await until(() => called('delivery:handedOff').includes('click-11'))
      offered()
      if (gone) rmSync(profile, { recursive: true })
      await pass(21)
      expect(stand.codex).toHaveLength(gone ? 1 : 2)
      if (!gone) {
        expect(stand.codex[1]!.env?.CODEX_HOME).toBe(profile)
        expect(stand.codex[1]!.args).toContain('--message=[It] "A page" (page-11): approve, with details [action click-11]')
      }
    } finally {
      held.mockRestore()
    }
  })

  test('a mark that no hook asks about is followed by the short line, so that the agent is told after all, and the conversation is given no mark again', async () => {
    withT3Code()
    stand.t3.threads.set('thread-11', 't3-thread-k')
    standIn(true)
    await start()
    await heard(11)
    offered(click(11))
    for (let i = 0; i < 5 && stand.t3.sent.length < 1; i++) await pass()
    expect(stand.t3.sent).toEqual([{ thread: 't3-thread-k', text: MARK }])
    await until(() => called('delivery:handedOff').includes('click-11'))
    offered()
    // For as long as a hook is given to ask, nothing more is put to the thread
    await pass(18)
    expect(stand.t3.sent.length).toBe(1)
    await pass(3)
    await until(() => stand.t3.sent.length === 2)
    expect(stand.t3.sent[1]).toEqual({ thread: 't3-thread-k', text: '[It] "A page" (page-11): approve, with details [action click-11]' })
    expect(said.some((line) => /was given a mark and none of its hooks said it had what the mark stood for/.test(line))).toBe(true)
    // What the mark stood for is no longer kept for a hook that comes late: the agent has it in the line
    expect(await behindMarks(11)).toEqual([])
    // And the next thing done goes as the short line at once
    offered({ ...click(11), id: 'click-11-next' })
    for (let i = 0; i < 5 && stand.t3.sent.length < 3; i++) await pass()
    expect(stand.t3.sent[2]).toEqual({ thread: 't3-thread-k', text: '[It] "A page" (page-11): approve, with details [action click-11-next]' })
  })

  test('a conversation that let a mark time out keeps receiving the short line after its id changes', async () => {
    withT3Code()
    stand.t3.threads.set('thread-11', 't3-thread-k')
    standIn(true)
    await start()
    await heard(11)
    offered(click(11))
    for (let i = 0; i < 5 && stand.t3.sent.length < 1; i++) await pass()
    expect(stand.t3.sent).toEqual([{ thread: 't3-thread-k', text: MARK }])
    await until(() => called('delivery:handedOff').includes('click-11'))
    offered()
    await pass(21)
    await until(() => stand.t3.sent.length === 2)
    expect(stand.t3.sent[1]!.text).toContain('[action click-11]')
    expect(await behindMarks(11)).toEqual([])

    expect(await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-110', was: 'thread-11' } })).toEqual({ ok: true })
    stand.t3.threads.set('thread-110', 't3-thread-k')
    offered(click(110))
    // The next click goes as the short line without another mark or another wait for a hook.
    for (let i = 0; i < 5 && stand.t3.sent.length < 3; i++) await pass()
    await until(() => stand.t3.sent.length === 3)
    expect(stand.t3.sent[2]).toEqual({ thread: 't3-thread-k', text: '[It] "A page" (page-110): approve, with details [action click-110]' })
    expect(await behindMarks(110)).toEqual([])
  })

  test('once the person has disconnected the app, no hook of it is handed what a mark stood for, and no short line follows the mark', async () => {
    withT3Code()
    stand.t3.threads.set('thread-13', 't3-thread-m')
    standIn(true)
    await start()
    await heard(13)
    offered(click(13))
    for (let i = 0; i < 5 && stand.t3.sent.length < 1; i++) await pass()
    expect(stand.t3.sent).toEqual([{ thread: 't3-thread-m', text: MARK }])
    await until(() => called('delivery:handedOff').includes('click-13'))
    offered()
    expect(await behindMarks(13)).toEqual([inFull(13)])
    // The person disconnects Codex before any hook has said that it has it
    stand.watching.get('machines:me')!({ wanted: [] })
    await settled()
    expect(await behindMarks(13)).toEqual([])
    await pass(25)
    expect(stand.t3.sent.length).toBe(1)
    // Connected again, the next hook of the conversation is handed it after all
    stand.watching.get('machines:me')!({ wanted: ['codex'] })
    await settled()
    expect(await behindMarks(13)).toEqual([inFull(13)])
  })

  test('a mark goes with its conversation to the id it carries on under, and is still followed by the short line there', async () => {
    withT3Code()
    stand.t3.threads.set('thread-14', 't3-thread-n')
    standIn(true)
    await start()
    await heard(14)
    offered(click(14))
    for (let i = 0; i < 5 && stand.t3.sent.length < 1; i++) await pass()
    expect(stand.t3.sent).toEqual([{ thread: 't3-thread-n', text: MARK }])
    await until(() => called('delivery:handedOff').includes('click-14'))
    offered()
    // The conversation is cleared before any hook has asked: it carries on under another id
    expect(await local('/session', { method: 'POST', body: { harness: 'codex', session: 'thread-140', was: 'thread-14' } })).toEqual({ ok: true })
    expect(await behindMarks(140)).toEqual([inFull(14)])
    // No hook says that it has it, so the short line follows as it would have
    await pass(21)
    await until(() => stand.t3.sent.length === 2)
    expect(stand.t3.sent[1]!.text).toContain('[action click-14]')
    expect(await behindMarks(140)).toEqual([])
  })

  test('where the short line is not taken either, it is tried again, and what the mark stood for is kept for a hook all the while', async () => {
    withT3Code()
    stand.t3.threads.set('thread-12', 't3-thread-l')
    standIn(true)
    await start()
    await heard(12)
    offered(click(12))
    for (let i = 0; i < 5 && stand.t3.sent.length < 1; i++) await pass()
    expect(stand.t3.sent).toEqual([{ thread: 't3-thread-l', text: MARK }])
    await until(() => called('delivery:handedOff').includes('click-12'))
    offered()
    // T3 Code goes away before any hook has asked, and the short line is refused
    stand.t3.refusing = 'T3 Code could not be reached'
    await pass(21)
    await until(() => stand.t3.refused.length === 1)
    expect(stand.t3.refused[0]!.text).toBe('[It] "A page" (page-12): approve, with details [action click-12]')
    // Nothing was lost by that: a hook that runs now is still handed the click
    expect(await behindMarks(12)).toEqual([inFull(12)])
    // It is tried again, and once T3 Code takes the line the agent has it there
    await pass(21)
    await until(() => stand.t3.refused.length === 2)
    stand.t3.refusing = null
    await pass(61)
    await until(() => stand.t3.sent.length === 2)
    expect(stand.t3.sent[1]!.text).toBe('[It] "A page" (page-12): approve, with details [action click-12]')
    expect(await behindMarks(12)).toEqual([])
  })

  test('one whose conversation is in no thread goes into Codex’s queue, once T3 Code has said so, and T3 Code is not asked again for the next', async () => {
    withT3Code()
    await start()
    offered(click(2))
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain('--thread=thread-2')
    // The same short line as a thread is given
    expect(stand.codex[0]!.args).toContain('--message=[It] "A page" (page-2): approve, with details [action click-2]')
    expect(stand.t3.asked.map((a) => a.ids)).toEqual([['thread-2']])
    expect(stand.t3.sent).toEqual([])
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-2'))
    offered({ ...click(2), id: 'click-2-again' })
    await until(() => stand.codex.length === 2)
    expect(stand.t3.asked.length).toBe(1)
  })

  test('a search at its read limit uses the fallback route and starts afresh only after six hours', async () => {
    withT3Code()
    stand.t3.slow = true
    await start()
    offered(click(3))
    await until(() => stand.t3.asked.length === 1)
    stand.t3.asked[0]!.answer({ status: 'limited' })
    await until(() => stand.codex.length === 1)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-3'))
    offered({ ...click(3), id: 'before-next-search' })
    await until(() => stand.codex.length === 2)
    expect(stand.t3.asked).toHaveLength(1)
    stand.codex[1]!.end()
    await until(() => called('delivery:handedOff').includes('before-next-search'))
    offered()
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 3_600_000 + 1000)
    try {
      offered({ ...click(3), id: 'after-search-limit' })
      await until(() => stand.t3.asked.length === 2)
      stand.t3.asked[1]!.answer('t3-thread-c')
      await until(() => stand.t3.sent.length === 1)
      expect(stand.t3.sent[0]!.thread).toBe('t3-thread-c')
      expect(stand.codex).toHaveLength(2)
    } finally {
      wall.mockRestore()
    }
  })

  test('an incomplete thread search continues before using another route, also with Auto-wake off', async () => {
    withT3Code()
    stand.t3.slow = true
    await start()
    offered(click(3))
    await until(() => stand.t3.asked.length === 1)
    stand.t3.asked[0]!.answer(undefined)
    await until(() => stand.t3.asked.length === 2)
    expect(stand.codex).toEqual([])
    stand.t3.asked[1]!.answer('t3-thread-c')
    await until(() => stand.t3.sent.length === 1)
    expect(stand.t3.sent[0]!.thread).toBe('t3-thread-c')
    expect(stand.codex).toEqual([])
    expect(stand.calls.some((c) => c.name === 'machines:runStarted')).toBe(false)
  })

  test.each(['unread', 'failed'] as const)('a persistently %s search backs off up to a minute and resets when a batch makes progress', async (failure) => {
    standIn(true)
    withT3Code()
    stand.t3.slow = true
    await start()
    let now = Date.now()
    const wall = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      offered(click(3))
      await until(() => stand.t3.asked.length === 1)
      // Continuation must obey its retry time even after the original click leaves the inbox.
      offered()
      await settled()
      const advance = async (ms: number) => {
        now += ms
        await vi.advanceTimersByTimeAsync(ms)
        offered()
        await settled()
      }
      const retry = async (delay: number, progressed = false) => {
        const count = stand.t3.asked.length
        stand.t3.asked.at(-1)!.answer(failure === 'failed' && !progressed ? new Error('unavailable') : undefined, progressed)
        await settled()
        await advance(delay - 1)
        expect(stand.t3.asked).toHaveLength(count)
        await advance(1)
        expect(stand.t3.asked).toHaveLength(count + 1)
      }
      for (const delay of [300, 600, 1200, 2400, 4800, 9600, 19_200, 38_400, 60_000, 60_000]) await retry(delay)
      // Finite batches continue quickly; a successful batch clears earlier failures.
      await retry(300, true)
      await retry(300, true)
      await retry(300)
      await retry(600)
      stand.t3.asked.at(-1)!.answer('t3-thread-c')
      await settled()
      offered({ ...click(3), id: 'after-recovery' })
      await advance(10)
      await until(() => stand.t3.sent.length === 1)
      expect(stand.t3.sent[0]!.thread).toBe('t3-thread-c')
      expect(stand.codex).toEqual([])
    } finally {
      wall.mockRestore()
    }
  })

  test('a long discovery backoff does not delay another conversation’s shorter routing timer', async () => {
    standIn(true)
    withT3Code()
    stand.t3.slow = true
    await start()
    let now = Date.now()
    let elapsed = 0
    const wall = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const advance = async (ms: number) => {
      now += ms
      elapsed += ms
      await vi.advanceTimersByTimeAsync(ms)
      await settled()
    }
    try {
      offered(click(3))
      await until(() => stand.t3.asked.length === 1)
      offered()
      await settled()
      for (const delay of [300, 600, 1200, 2400, 4800, 9600, 19_200, 38_400]) {
        const asked = stand.t3.asked.length
        stand.t3.asked.at(-1)!.answer(undefined, false)
        await settled()
        await advance(delay + 10)
        expect(stand.t3.asked).toHaveLength(asked + 1)
      }
      // Move just past a heartbeat, so the new click's settle pass must run before the next
      // one-second fallback. The stalled search now asks for another pass a minute away.
      await advance(1000 - (elapsed % 1000))
      stand.t3.asked.at(-1)!.answer(undefined, false)
      await settled()
      offered({ ...click(4), at: now })
      await until(() => stand.t3.asked.at(-1)?.ids.includes('thread-4') === true)
      stand.t3.asked.at(-1)!.answer('t3-thread-d')
      await settled()
      await advance(10)
      expect(stand.t3.sent).toEqual([])
      await advance(300)
      expect(stand.t3.sent).toHaveLength(1)
      expect(stand.t3.sent[0]!.thread).toBe('t3-thread-d')
    } finally {
      wall.mockRestore()
    }
  })

  test('another incomplete batch does not restart the delivery wait', async () => {
    withT3Code()
    stand.t3.slow = true
    await start()
    offered(click(3))
    await until(() => stand.t3.asked.length === 1)
    stand.t3.asked[0]!.answer(undefined)
    await until(() => stand.t3.asked.length === 2)
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000)
    try {
      stand.t3.asked[1]!.answer(undefined)
      await until(() => stand.codex.length === 1)
    } finally {
      wall.mockRestore()
    }
  })

  test('an incomplete search finishes after its click left the inbox through the fallback route', async () => {
    withT3Code()
    stand.t3.slow = true
    await start()
    offered(click(3))
    await until(() => stand.t3.asked.length === 1)
    await until(() => stand.codex.length === 1, 12_000)
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-3'))
    offered()
    stand.t3.asked[0]!.answer(undefined)
    await until(() => stand.t3.asked.length === 2)
    stand.t3.asked[1]!.answer('t3-thread-c')
    await settled()
    offered({ ...click(3), id: 'click-after-search' })
    await until(() => stand.t3.sent.length === 1)
    expect(stand.codex.length).toBe(1)
    expect(stand.t3.sent[0]!.thread).toBe('t3-thread-c')
  }, 30_000)

  test('a T3 Code that does not say which thread holds a conversation is waited for only so long: the click then goes into Codex’s queue, and what T3 Code says in the end holds for the next', async () => {
    withT3Code()
    stand.t3.slow = true
    stand.t3.threads.set('thread-3', 't3-thread-c')
    await start()
    offered(click(3))
    await until(() => stand.t3.asked.length === 1)
    // For as long as it is given, nothing else is tried
    await pause(1500)
    expect(stand.codex).toEqual([])
    expect(called('delivery:claim')).not.toContain('click-3')
    // Past that the click is not kept from the Codex that has the conversation open
    await until(() => stand.codex.length === 1, 12_000)
    expect(stand.codex[0]!.args).toContain('--thread=thread-3')
    expect(stand.t3.sent).toEqual([])
    stand.codex[0]!.end()
    await until(() => called('delivery:handedOff').includes('click-3'))
    // T3 Code answers at last: the conversation is in a thread, and the next click goes there
    stand.t3.asked[0]!.answer('t3-thread-c')
    await settled()
    offered({ ...click(3), id: 'click-3-next' })
    await until(() => stand.t3.sent.length >= 1)
    expect(stand.t3.sent[0]).toMatchObject({ thread: 't3-thread-c' })
    expect(stand.t3.sent.length).toBe(1)
    expect(stand.codex.length).toBe(1)
    expect(stand.t3.asked.length).toBe(1)
  }, 30_000)

  test('every click that T3 Code took in one message while the thread’s turn was running is given to an agent that begins to wait in that turn, and each only once', async () => {
    withT3Code()
    stand.t3.threads.set('thread-4', 't3-thread-d')
    await start()
    expect(await turn(4, true)).toEqual({ ok: true })
    // Two things done on two pages of the one conversation, which go to the thread together
    const first = click(4)
    const second = { ...click(5, 4), id: 'click-5' }
    const time = vi.spyOn(performance, 'now').mockReturnValue(performance.now() - 9_000)
    offered(first, second)
    time.mockRestore()
    await until(() => stand.t3.sent.length >= 1)
    expect(stand.t3.sent[0]!.text).toBe(
      '[It] "A page" (page-4): approve, with details [action click-4]\n[It] "A page" (page-5): approve, with details [action click-5]',
    )
    await until(() => ['click-4', 'click-5'].every((id) => called('delivery:handedOff').includes(id)))
    offered()
    // The agent of the running turn waits for the second page: T3 Code holds its click behind this very turn
    expect((await waitingFor(4, 5))?.clicks?.map((c) => c.id)).toEqual(['click-5'])
    expect((await waitingFor(4, 5))?.clicks).toBeUndefined()
    // And one that waits for whatever its conversation has is given the other, once
    expect((await waitingFor(4))?.clicks?.map((c) => c.id)).toEqual(['click-4'])
    expect((await waitingFor(4))?.clicks).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('a thread of T3 Code that is switched to another agent app', () => {
  const claude = { harness: 'claude-code', id: 'claude-in-the-thread' }
  const codex = { harness: 'codex', id: 'codex-in-the-thread' }
  /** The person has chosen Claude Code and Codex, and both have It's add-on in them. */
  const BOTH = {
    wanted: ['claude-code', 'codex'],
    found: [
      { id: 'claude-code', version: '1.0.0', addon: 'connected' },
      { id: 'codex', version: '1.0.0', addon: 'connected' },
    ],
  }
  /** What the connector told It carries on as what. */
  const carried = () => stand.calls.filter((c) => c.name === 'artifacts:carryOn').map((c) => c.args)
  /** It answers as the backend does, with how many pages went. */
  const handing = (pages: number) => {
    stand.answer = (name) => (name === 'artifacts:carryOn' ? { moved: pages } : undefined)
  }
  const codexTurn = (busy: boolean, id = codex.id) => local('/session', { method: 'POST', body: { harness: 'codex', session: id, busy } })
  /** Claude Code's add-on asks for its clicks, as it does every second while its program runs. */
  const claudeAsks = (id = claude.id) => local<{ clicks: { id: string }[] }>(`/clicks?harness=claude-code&session=${id}`)
  const click = (session: { harness: string; id: string }) => ({
    id: 'click-1',
    artifact: 'board',
    title: 'Board',
    name: 'approve',
    payload: '{}',
    at: Date.now() - 10_000,
    attended: true,
    session,
  })
  /** The time that passes for the connector, which goes by the system's clock. */
  const realNow = Date.now.bind(Date)
  let ahead = 0
  const later = (ms: number) => {
    ahead += ms
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead)
  }
  afterEach(() => {
    ahead = 0
    vi.restoreAllMocks()
  })

  test('a switch from Claude Code to Codex in one thread hands the Claude conversation’s pages, and what waits here for it, to the Codex conversation', async () => {
    stand.t3.running = true
    const mark = { id: 'mark-1', texts: ['[It] The page "Board" (board) sent this just after someone used it: approve [action click-0]'], at: Date.now() }
    await start('socket', BOTH, (folder) =>
      writeFileSync(
        path.join(folder, 'delivery-recovery.json'),
        JSON.stringify({ version: 1, waiters: [], marks: [[`claude-code:${claude.id}`, [mark]]], accepted: [], returning: [] }),
      ),
    )
    handing(1)
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    // The Codex conversation's first hook, as the first turn after the switch begins
    expect(await codexTurn(true)).toEqual({ ok: true })
    await until(() => carried().length === 1)
    expect(carried()).toEqual([{ from: claude, to: codex }])
    await until(() => said.some((line) => line.includes('carries on as a codex conversation')))
    // What a mark put into the thread for the Claude conversation stands for is handed to the Codex conversation's hook
    expect((await local<{ texts: string[] }>('/marked', { method: 'POST', body: { harness: 'codex', session: codex.id } }))?.texts).toEqual(mark.texts)
    // The click that waited on the page is offered for the Codex conversation from then on, and the running turn's next hook is handed it
    stand.watching.get('delivery:inboxPage')!([click(codex)])
    await until(() => stand.calls.some((c) => c.name === 'delivery:claim'))
    expect((await local<{ clicks: { id: string }[] }>(`/clicks?harness=codex&session=${codex.id}`))?.clicks.map((c) => c.id)).toEqual(['click-1'])
    // Heard from again, nothing more is asked of T3 Code for a minute, and nothing more is told to It
    await codexTurn(false)
    await settled()
    expect([stand.t3.looked.length, carried().length]).toEqual([1, 1])
  })

  test('a conversation that is in use keeps its pages until it is quiet, and switched back and forth the pages follow the thread', async () => {
    stand.t3.running = true
    await start('socket', BOTH)
    handing(2)
    // Claude Code's program is still running when the Codex conversation is first heard from
    await claudeAsks()
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    await codexTurn(true)
    await until(() => stand.t3.looked.some((l) => l.harness === 'codex'))
    await settled()
    expect(carried()).toEqual([])
    // Once it has gone quiet, the next hook of the Codex conversation has its pages handed over
    later(25_000)
    await codexTurn(false)
    await until(() => carried().length === 1)
    expect(carried()).toEqual([{ from: claude, to: codex }])
    // Switched back to Claude Code, the thread runs the first conversation again, and its pages go back to it
    stand.t3.runs.set('t3-thread', { now: claude, before: [codex] })
    later(10_000)
    await claudeAsks()
    await until(() => carried().length === 2)
    expect(carried()[1]).toEqual({ from: codex, to: claude })
    // And switched to Codex once more, they go to Codex once more
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    later(65_000)
    await codexTurn(true)
    await until(() => carried().length === 3)
    expect(carried()[2]).toEqual({ from: claude, to: codex })
  })

  test('switched from Codex to Claude Code and back to the same Codex conversation within a minute, a short returning turn takes the pages back', async () => {
    stand.t3.running = true
    await start('socket', BOTH)
    handing(1)
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    await codexTurn(true)
    await until(() => carried().length === 1)
    await codexTurn(false)
    // Switched to Claude Code a few seconds after that turn: the pages go to the Claude conversation
    stand.t3.runs.set('t3-thread', { now: claude, before: [codex] })
    later(10_000)
    await claudeAsks()
    await until(() => carried().length === 2)
    expect(carried()[1]).toEqual({ from: codex, to: claude })
    // And back to the same Codex conversation, well within a minute of its last look, for one short turn
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    later(10_000)
    await codexTurn(true)
    await codexTurn(false)
    await until(() => carried().length === 3)
    expect(carried()[2]).toEqual({ from: claude, to: codex })
  })

  test('where the first look cannot see the new conversation yet and nothing more is heard from it, its pages go when the connector looks again by itself', async () => {
    stand.t3.running = true
    standIn(true)
    await start('socket', BOTH)
    handing(1)
    // T3 Code has switched the thread to Codex, and has not yet been told the Codex conversation's id
    stand.t3.runs.set('t3-thread', { now: { harness: 'codex', id: 'not-told-yet' }, before: [claude] })
    expect(await codexTurn(true)).toEqual({ ok: true })
    await until(() => stand.t3.looked.length === 1)
    await settled()
    // The turn is over before the next look is due, and its last hook is the last thing heard
    await codexTurn(false)
    await settled()
    expect([stand.t3.looked.length, carried()]).toEqual([1, []])
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    vi.advanceTimersByTime(20_000)
    await until(() => carried().length === 1)
    expect(carried()).toEqual([{ from: claude, to: codex }])
    expect(stand.t3.looked).toHaveLength(2)
    // Followed, the conversation is not looked for again until it is heard from
    vi.advanceTimersByTime(70_000)
    await settled()
    expect(stand.t3.looked).toHaveLength(2)
  })

  test('an earlier conversation still in use when the new one is first heard from hands its pages over at the look the connector has again by itself', async () => {
    stand.t3.running = true
    standIn(true)
    await start('socket', BOTH)
    handing(1)
    await claudeAsks()
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    await codexTurn(true)
    await until(() => stand.t3.looked.some((l) => l.harness === 'codex'))
    await settled()
    expect(carried()).toEqual([])
    // Claude Code's program has gone and asks no more, and nothing is heard from Codex either
    later(25_000)
    vi.advanceTimersByTime(20_000)
    await until(() => carried().length === 1)
    expect(carried()).toEqual([{ from: claude, to: codex }])
  })

  test('a conversation in no thread is looked for again by the connector itself three times at most, and not at all once the connector has stopped', async () => {
    stand.t3.running = true
    standIn(true)
    await start('socket', BOTH)
    await codexTurn(true, 'in-no-thread')
    await until(() => stand.t3.looked.length === 1)
    await settled()
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000)
      await settled()
    }
    expect(stand.t3.looked).toHaveLength(4)
    // Another is to be looked for again when the connector stops: it is not
    await codexTurn(true, 'another-in-no-thread')
    await until(() => stand.t3.looked.length === 5)
    await settled()
    await stop!()
    stop = null
    vi.advanceTimersByTime(60_000)
    await settled()
    expect(stand.t3.looked).toHaveLength(5)
  })

  test('a conversation of another thread, in the same folder or not, is handed nothing, and nor is one the thread no longer runs', async () => {
    stand.t3.running = true
    await start('socket', BOTH)
    handing(1)
    const neighbour = { harness: 'codex', id: 'codex-next-door' }
    const neighboursClaude = { harness: 'claude-code', id: 'claude-next-door' }
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    stand.t3.runs.set('t3-next-door', { now: neighbour, before: [neighboursClaude] })
    await codexTurn(true, neighbour.id)
    await until(() => carried().length === 1)
    expect(carried()).toEqual([{ from: neighboursClaude, to: neighbour }])
    // The Claude conversation the first thread ran before, heard from again outside T3 Code, runs in no thread: nothing goes to it
    await claudeAsks()
    await until(() => stand.t3.looked.some((l) => l.harness === 'claude-code'))
    await settled()
    expect(carried()).toEqual([{ from: neighboursClaude, to: neighbour }])
    // Asked by every id It knows the conversation by, and of no thread in particular
    expect(stand.t3.looked).toEqual([
      { harness: 'codex', ids: [neighbour.id] },
      { harness: 'claude-code', ids: [claude.id] },
    ])
    // A click for the conversation, while no turn of it runs, goes to the thread found for it, with no search for one
    await codexTurn(false, neighbour.id)
    stand.watching.get('delivery:inboxPage')!([click(neighbour)])
    await until(() => stand.t3.sent.length === 1)
    expect([stand.t3.sent[0]!.thread, stand.t3.asked]).toEqual(['t3-next-door', []])
  })

  test('where T3 Code is not running nothing is asked of it and nothing changes hands, and a click on a page that went goes where the page went', async () => {
    await start('socket', BOTH)
    handing(1)
    stand.t3.runs.set('t3-thread', { now: codex, before: [claude] })
    await codexTurn(true)
    await codexTurn(false)
    await claudeAsks()
    await settled()
    expect([stand.t3.looked, carried()]).toEqual([[], []])
    // The pages handed over while T3 Code was running are the Codex conversation's still: a click
    // on one goes to Codex, here through its own queue, since some Codex has the conversation open
    stand.watching.get('delivery:inboxPage')!([click(codex)])
    await until(() => stand.codex.length === 1)
    expect(stand.codex[0]!.args).toContain(`--thread=${codex.id}`)
    expect(carried()).toEqual([])
  })
})

describe('the way a click goes when no add-on is there to take it', () => {
  /** The way, and what was asked to find it, in the order it was asked. */
  const way = (has: { inT3: boolean; codexOpen: boolean; reopens: boolean }) => {
    const asked: string[] = []
    const says = (name: keyof typeof has) => () => {
      asked.push(name)
      return has[name]
    }
    return { way: wayOf({ inT3: says('inT3'), codexOpen: says('codexOpen'), reopens: says('reopens') }), asked }
  }

  test('a conversation held in a thread of T3 Code goes to the thread, also while T3 Code still holds its Codex', () => {
    // Codex's queue would take it, and start the turn inside the Codex that T3 Code holds: the
    // page changed and the thread showed nothing. So Codex is not even asked.
    expect(way({ inT3: true, codexOpen: true, reopens: true })).toEqual({ way: 't3', asked: ['inT3'] })
  })

  test('one that is in no thread of T3 Code and that some Codex has open goes into Codex’s queue', () => {
    expect(way({ inT3: false, codexOpen: true, reopens: true })).toEqual({ way: 'queue', asked: ['inT3', 'codexOpen'] })
  })

  test('one that nothing has open is reopened, where reopening is switched on', () => {
    expect(way({ inT3: false, codexOpen: false, reopens: true })).toEqual({ way: 'reopen', asked: ['inT3', 'codexOpen', 'reopens'] })
  })

  test('and otherwise it goes no way: it waits, in view', () => {
    expect(way({ inT3: false, codexOpen: false, reopens: false }).way).toBeUndefined()
  })
})
