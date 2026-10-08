// What keeps a person's data whole in the part of the service that runs the backend program:
// that no database is ever moved, replaced or removed, that one backend program at a time has
// a folder's data, that one enrolment at a time has a folder's key, on the machine It runs on
// and on one that joins, and what is kept before a newer program or newer functions touch the
// database. Where a test starts the backend, that is the real program, in a folder of its own,
// on ports of this file's own. Nothing here reaches a remote, but for the one test that runs
// only on Windows, which fetches the program from its release where CI has not put one on the
// machine.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PORTS } from '@it/protocol'
import { build, type Plugin } from 'esbuild'
import { zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { FUNCTIONS, FUNCTIONS_HASH } from './src/functions.generated'
import { api, backendAt, call, type Machine, machineFile, type Problem, readJson, VERSION } from './src/lib'
import { login } from './src/login'
import {
  alone,
  asAdmin,
  program as fetched,
  fetchProgram,
  programsHere,
  type Running,
  removeCopies,
  removeOtherPrograms,
  standing,
  startBackend,
  startedWith,
  startOf,
} from './src/serve/backend'
import { doorKey, instanceName, makeConfig, programFile, RELEASE, readConfig, type ServiceConfig } from './src/serve/config'
import { startDoor } from './src/serve/door'
import { begin } from './src/serve/firstrun'
import { bases } from './test-ports'

const windows = process.platform === 'win32'
/** The backend program on this machine: the one IT_BACKEND_BIN names, or the one the `convex` package keeps. */
const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, `convex-local-backend${windows ? '.exe' : ''}`)].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)

/** How long what is done before and after a test is given: a base port may have to be waited for, programs are made, and what a test started is stopped and waited for. */
const HOOK_MS = 120_000
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const until = async (what: () => boolean | Promise<boolean>, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(25)) if (await what()) return true
  return false
}
/** Waits for something for a generous while, and where it has not come by the end of that, says what was there in its place. */
const comes = async (what: () => boolean | Promise<boolean>, seen: () => unknown, ms = 120_000) => {
  if (await until(what, ms)) return
  throw new Error(`What was waited for had not come after ${ms / 1000} seconds. What was there: ${JSON.stringify(await seen())}`)
}
/** The code of a refusal, or nothing when what was run went through. */
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (err) => (typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : `not a refusal: ${String(err)}`),
  )

// The base ports this file counts from. They lie below the ports the system hands to outgoing
// connections, so none of them is taken by a connection a test itself opens. A test holds each
// base it takes until it is over, so that no other run of the tests on this machine is given
// the same one meanwhile.
const ports = bases(30_500, 40)

const KEPT = ['IT_HOME', 'IT_PORT', 'IT_BACKEND_BIN', 'IT_BACKEND_RELEASES', 'IT_URL', 'IT_SITE_URL'] as const
let before: Record<string, string | undefined>
let folder: string
let scratch: string
/** Each test has an It folder of its own and a base port of its own, and nothing of whoever runs the tests. */
beforeEach(async () => {
  before = Object.fromEntries(KEPT.map((name) => [name, process.env[name]]))
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-backend-'))
  process.env.IT_HOME = folder
  process.env.IT_PORT = String(await ports.next())
  if (program) process.env.IT_BACKEND_BIN = program
  delete process.env.IT_BACKEND_RELEASES
  delete process.env.IT_URL
  delete process.env.IT_SITE_URL
}, HOOK_MS)
afterEach(async () => {
  // A backend the test left running in this program is stopped first: the two runtimes do not
  // run what follows a test in the same order, and this has to come before the folder goes
  // and the ports are given back under both
  for (const backend of running ?? []) await backend.stop()
  for (const name of KEPT) {
    if (before[name] === undefined) delete process.env[name]
    else process.env[name] = before[name]
  }
  rmSync(folder, { recursive: true, force: true })
  await ports.release()
}, HOOK_MS)
beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-backend-scratch-'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const inBackend = (...parts: string[]) => path.join(folder, 'backend', ...parts)
const database = () => inBackend('db.sqlite3')
const lock = () =>
  readJson<{ pid: number; started: string; where: string; holder: string; api?: string; program?: number; programStarted?: string }>(inBackend('lock'))
/** What is noted of the database, in the file beside it. */
const note = () => JSON.parse(readFileSync(inBackend('data.json'), 'utf8')) as Record<string, unknown>
const noted = (change: Record<string, unknown>) => writeFileSync(inBackend('data.json'), JSON.stringify({ ...note(), ...change }))
const copies = () => readdirSync(inBackend()).filter((name) => name.startsWith('before-'))
/**
 * A copy of the database as It makes one, under the name of its folder: inside it is the file
 * that says which copy it is, by a word of its own, when it was made, and which place it has
 * among the copies as they were made. `left` is what follows the copy's name while it is being
 * made or is making way for another. Unless it is given another place, a copy made longer ago
 * was made before one made more lately.
 */
const copied = (
  name: string,
  ago = 0,
  left = '',
  id = createHash('sha256')
    .update(name + left)
    .digest('hex')
    .slice(0, 16),
  order = 1_000_000_000 - ago,
) => {
  mkdirSync(inBackend(name + left), { recursive: true })
  writeFileSync(inBackend(name + left, 'db.sqlite3'), name)
  writeFileSync(inBackend(name + left, 'copy.json'), JSON.stringify({ copy: name, id, made: Date.now() - ago, order, it: VERSION }))
  return id
}
/**
 * Everything under a folder: each folder by its name, each file by its name and what it holds,
 * and each link by where it leads. A file that was there when the folder was listed and is gone
 * when it is read, as a database's journal is between two looks, is not there.
 */
const within = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) return [`${file} -> ${readlinkSync(file)}`]
        return entry.isDirectory() ? [`${file}/`, ...within(file)] : [`${file} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`]
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    })
    .sort()
const healthy = (base: number) =>
  fetch(`${backendAt(base).site}/health`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  )
/** Whether the backend program answers at the first of its ports, which it does as soon as it is up, before any function is loaded into it. */
const answering = (base: number) =>
  fetch(`${backendAt(base).api}/instance_name`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  )
/** The backend programs that run on a folder, as the system lists them. Each column is asked for by itself, which is the one way every `ps` takes. */
function programsOn(home: string): number[] {
  return execFileSync('ps', ['-axww', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(path.join(home, 'backend', 'db.sqlite3')) && line.includes('--instance-name'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
}
const KEY = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }
const writePending = (file: string, pending: unknown) => writeFileSync(file, JSON.stringify(pending), { mode: 0o600 })
/** The three ways the program is known to end over a database that is not whole, as one is whose first making was cut short. */
const CUT_SHORT = [
  'Error: missing _tables.by_id global',
  'Error: missing _index.by_id global',
  'Error: bootstrap index mTkbPANobdWT7wV5zrBQ-g has no `_index` document',
]

/** A program of its own, made of what it is given and of the service's own source, and put among this file's scratch files under a name. */
const bundled = (name: string, contents: string, plugins: Plugin[] = []) =>
  build({
    stdin: { contents, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(scratch, name),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    loader: { '.md': 'text', '.txt': 'text' },
    logLevel: 'silent',
    plugins,
  })

/**
 * A program that stands in for the backend program: it does what `script` says, and where that
 * comes to its end it becomes the real one, with the arguments it was given.
 */
function standIn(script: string): string {
  const file = path.join(scratch, `stand-in-${Math.random().toString(36).slice(2)}`)
  writeFileSync(file, `#!/bin/sh\n${script}\nexec '${program}' "$@"\n`, { mode: 0o700 })
  return file
}
/** A stand-in that fails once, saying `words` and ending with the code 1, and is the real program the next time. */
function failingOnce(words: string): string {
  const once = path.join(scratch, `failed-${Math.random().toString(36).slice(2)}`)
  return standIn(`if [ ! -e '${once}' ]; then touch '${once}'; echo '${words}' >&2; exit 1; fi`)
}

/**
 * What stands between a command and where it asks, as a network between two machines does:
 * every request that comes to one port is passed on to another and its answer passed back.
 * `lost` is shown each request with its answer, and an answer it says is lost never arrives:
 * the connection is ended with nothing sent on it.
 */
async function between(from: number, to: number, lost: (path: string, body: string, answer: string) => boolean = () => false) {
  const server = http.createServer((req, res) => {
    const pieces: Buffer[] = []
    req.on('data', (piece: Buffer) => pieces.push(piece))
    req.on('end', () => {
      const body = Buffer.concat(pieces)
      const passed = http.request(
        { host: '127.0.0.1', port: to, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${to}`, connection: 'close' } },
        (answer) => {
          const got: Buffer[] = []
          answer.on('data', (piece: Buffer) => got.push(piece))
          answer.on('end', () => {
            const whole = Buffer.concat(got)
            if (lost(req.url ?? '', body.toString(), whole.toString())) return void res.destroy()
            const { 'transfer-encoding': _, ...headers } = answer.headers
            res.writeHead(answer.statusCode ?? 502, { ...headers, 'content-length': String(whole.length) }).end(whole)
          })
        },
      )
      passed.on('error', () => res.destroy())
      passed.end(body)
    })
  })
  // The port was looked at a moment ago and found free, and a system may take a moment more to give it out again
  for (let tries = 0; ; tries++) {
    const refused = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once('error', resolve)
      server.listen(from, '127.0.0.1', () => resolve(undefined))
    })
    server.removeAllListeners('error')
    if (!refused) break
    if (refused.code !== 'EADDRINUSE' || tries >= 40) throw refused
    await pause(50)
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/**
 * Erases everything, as the person does from their own browser, and gives the person's id. The
 * browser is paired with a code this machine asks for, at the backend's own port and with what
 * the door sends with such a request, and it asks for the erasing with the token its pairing
 * earns it. This machine has to be enrolled, and no door has to be there.
 */
async function eraseEverything(config: ServiceConfig): Promise<string> {
  const { code } = await call<{ code: string }>('mutation', api.sessions.inviteOwner)
  const at = backendAt(config.port)
  const asTheDoor = { 'content-type': 'application/json', 'x-it-site': '1', 'x-it-door': doorKey(config) }
  const paired = await fetch(`${at.site}/session/redeem`, { method: 'POST', headers: asTheDoor, body: JSON.stringify({ code }) })
  const cookie = paired.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  const earned = await fetch(`${at.site}/session/token`, { method: 'POST', headers: { ...asTheDoor, cookie }, body: '{}' })
  const browser = (await earned.json()) as { token: string; user: string; role: string }
  expect([paired.status, earned.status, browser.role]).toEqual([200, 200, 'owner'])
  const erased = await fetch(`${at.api}/api/mutation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${browser.token}` },
    body: JSON.stringify({ path: 'account:requestDeletion', args: { confirm: 'erase everything', user: browser.user }, format: 'json' }),
  })
  expect(await erased.json()).toMatchObject({ status: 'success' })
  return browser.user
}

/** Every backend a test started in this program, stopped before the test's folder is removed. */
let running: Running[]
let said: string[]
const say = (line: string) => void said.push(line)
const start = async (config: ServiceConfig) => {
  const backend = await startBackend(config, say)
  running.push(backend)
  return backend
}
beforeEach(() => {
  running = []
  said = []
})

const COPIED = 'backend: a copy of the database was kept before it is changed (database_copied)'
const ENDED = 'backend: the program ended as soon as it was started (code 1)'

describe.skipIf(!program || windows)('the database of a folder', () => {
  /** A folder with a database in it that holds what a person made, and the backend stopped. */
  const peopled = async () => {
    const backend = await start(makeConfig())
    const made = (await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'what a person made', publicKey: KEY })) as { machineId: string }
    await backend.stop()
    return { id: made.machineId, bytes: readFileSync(database()) }
  }
  const stillThere = async (config: ServiceConfig, id: string) => {
    const again = await start(config)
    expect(await asAdmin(again, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    await again.stop()
  }
  /**
   * Everything in the backend's folder, each file by its name and by what it holds: the database,
   * the files the backend keeps for it, and what is noted of it. A start that is refused leaves
   * all of it as it was. The copies the service keeps beside the database are its own, and are
   * not counted.
   */
  const everything = () => {
    const under = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => dir !== inBackend() || !entry.name.startsWith('before-'))
        .flatMap((entry) => {
          const file = path.join(dir, entry.name)
          return entry.isDirectory() ? under(file) : [`${path.relative(inBackend(), file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`]
        })
    return under(inBackend()).sort()
  }
  const moved = () => readdirSync(inBackend()).filter((name) => name.startsWith('unfinished-'))

  test('that holds what a person made is left as it is when the program cannot open it or fails to start, though the settings handed over say nothing was ever loaded', async () => {
    // The settings as they were read before anything was loaded, which is how a command that
    // waited for another to start the service still has them
    const early = { ...makeConfig() }
    expect(early.functions).toBeUndefined()
    const { id } = await peopled()
    const before = everything()
    // The program fails once, for a reason of its own, and then in each way it fails over a
    // database that is not whole
    for (const words of ['Error: something passing went wrong', ...CUT_SHORT]) {
      process.env.IT_BACKEND_BIN = failingOnce(words)
      said = []
      const refused = (await startBackend({ ...early }, say).catch((err) => err)) as Problem
      expect([words, refused.code]).toEqual([words, CUT_SHORT.includes(words) ? 'database_unopened' : 'backend_exited'])
      // Functions were loaded into it, which the note beside it says. So the person is told that
      // it could not be opened and that nothing was touched, and is not told to move anything.
      if (CUT_SHORT.includes(words))
        expect([refused.message, refused.hint]).toEqual([
          `The backend program could not open the database in ${inBackend()}. Nothing there was moved or removed.`,
          `The program said: ${words}`,
        ])
      expect(said).toEqual([ENDED])
      expect(everything()).toEqual(before)
      expect(existsSync(inBackend('lock'))).toBe(false)
    }
    expect(copies()).toEqual([])
    await stillThere({ ...early }, id)
  }, 180_000)

  test('is noted beside itself as having had functions loaded, which holds when the settings file is lost and made anew', async () => {
    const { id, bytes } = await peopled()
    expect(note()).toEqual({
      made: expect.any(Number),
      release: RELEASE,
      it: VERSION,
      functions: FUNCTIONS_HASH,
      functionsOf: VERSION,
      load: expect.stringMatching(/^[0-9a-f]{64}$/),
      port: Number(process.env.IT_PORT),
    })
    if (!windows) expect(statSync(inBackend('data.json')).mode & 0o777).toBe(0o600)
    rmSync(path.join(folder, 'service.json'))
    const anew = makeConfig()
    expect(anew.functions).toBeUndefined()
    process.env.IT_BACKEND_BIN = failingOnce(CUT_SHORT[0]!)
    expect(await refusal(startBackend(anew, say))).toBe('database_unopened')
    expect(readFileSync(database()).equals(bytes)).toBe(true)
    await stillThere(anew, id)
  }, 180_000)

  test('that holds what a person made is not moved, replaced or removed when the note beside it says, wrongly, that nothing was ever loaded into it', async () => {
    const { id } = await peopled()
    const config = readConfig()!
    const whole = note()
    const copy = `before-functions-${FUNCTIONS_HASH.slice(0, 12)}`
    // The note as it was before the first load, and a note that was never this database's
    const wrong = [
      { made: whole.made, release: RELEASE, it: VERSION },
      { made: Date.now() + 100_000, release: RELEASE, it: VERSION },
    ]
    for (const stale of wrong) {
      writeFileSync(inBackend('data.json'), JSON.stringify(stale))
      const before = everything()
      // The program ends over it as it does over a database whose first making was cut short
      process.env.IT_BACKEND_BIN = failingOnce(CUT_SHORT[0]!)
      said = []
      const refused = (await startBackend(config, say).catch((err) => err)) as Problem
      // The person is told what the note says, and what they can do if it is true. Nothing is done for them.
      expect(refused.code).toBe('database_unfinished')
      expect(refused.hint).toBe(`If It was never used on this machine, move the folder ${inBackend()} out of the way and run \`it setup\` again.`)
      expect(said).toEqual([COPIED, ENDED])
      expect(everything()).toEqual(before)
      expect(moved()).toEqual([])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect(programsOn(folder)).toEqual([])
      // And whatever the note said, a whole copy of the database was kept before the program was started on it
      expect(copies()).toEqual([copy])
      expect(readFileSync(inBackend(copy, 'db.sqlite3')).equals(readFileSync(database()))).toBe(true)
    }
    // Where the program can open it, all that such a note costs is that copy and a load: what the person made is there
    process.env.IT_BACKEND_BIN = program!
    said = []
    await stillThere(config, id)
    expect(said).toEqual([COPIED, expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/), 'backend: stopped'])
    expect(note()).toMatchObject({ functions: FUNCTIONS_HASH })
  }, 180_000)

  test('what is noted of the database is never taken for nothing when it is there and cannot be read: no program is started on the database, no copy is kept, and nothing is written over the note', async () => {
    const { id } = await peopled()
    const config = readConfig()!
    for (const held of ['', '{ "release": ', '[]', '"a note"']) {
      writeFileSync(inBackend('data.json'), held)
      const before = everything()
      said = []
      const refused = (await startBackend(config, say).catch((err) => err)) as Problem
      expect([held, refused.code, refused.message]).toEqual([
        held,
        'record_unread',
        `What It notes of its database, in ${inBackend('data.json')}, is not as It wrote it.`,
      ])
      expect(refused.hint).toBe(
        'It says there which It and which backend program the database is at, and It does not start on the database without knowing. Put the file back as it was. If that cannot be done, move it away: It then takes the database for one it knows nothing of, and keeps a copy of it before it goes on.',
      )
      expect(said).toEqual([])
      expect(everything()).toEqual(before)
      expect(copies()).toEqual([])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect(programsOn(folder)).toEqual([])
      // Whoever tells a person how the database stands says nothing of it then
      expect(standing()).toBeNull()
    }
    // Moved away, as the person was told they may: the database is one of which nothing is known, a copy of it is kept first, and what the person made is there
    rmSync(inBackend('data.json'))
    said = []
    await stillThere(config, id)
    expect(said[0]).toBe(COPIED)
    expect(copies()).toEqual([`before-${RELEASE}-functions-${FUNCTIONS_HASH.slice(0, 12)}`])
  }, 180_000)

  test('whose first making was cut short is left where it is with nothing of it moved or removed, a copy of it as it was found is kept, and the person is told what was found and what they can do about it', async () => {
    const config = makeConfig()
    let refused = false
    for (let attempt = 0; attempt < 40 && !refused; attempt++) {
      // The program is killed in the moment it first writes its database, as a machine that
      // lost power would end it
      const first = startBackend(config, () => {})
      for (const end = Date.now() + 10_000; Date.now() < end && !(existsSync(database()) && lock()?.program); )
        await new Promise((resolve) => setImmediate(resolve))
      const pid = lock()?.program
      if (pid) process.kill(pid, 'SIGKILL')
      const ended = await refusal(first)
      if (ended === undefined) await (await first).stop()
      else expect(ended).toBe('backend_exited')
      // No function was loaded, which the note beside the database says by saying nothing of any
      if (ended !== undefined) expect(note()).toEqual({ made: expect.any(Number), release: RELEASE, it: VERSION })
      const before = everything()
      said = []
      const again = await startBackend(config, say).catch((err) => err as Problem)
      if ('stop' in again) {
        // The program was ended before it had written anything it cannot go on from: the next one goes on
        await again.stop()
        rmSync(inBackend(), { recursive: true, force: true })
        continue
      }
      // A refusal this file does not know fails the test with what the program itself said, which is the only way to learn of such an ending
      if (again.code !== 'database_unfinished') throw new Error(`${again.code}: ${again.hint ?? again.message}`)
      refused = true
      expect([again.message, again.hint]).toEqual([
        `The database in ${inBackend()} was begun and never finished, so the backend program cannot open it. Nothing there was moved or removed.`,
        `If It was never used on this machine, move the folder ${inBackend()} out of the way and run \`it setup\` again.`,
      ])
      // The service moved, replaced and removed nothing: the database and what is noted of it are where they were
      const there = () => everything().map((file) => file.split(' ')[0])
      expect(there()).toEqual(expect.arrayContaining(['data.json', 'db.sqlite3']))
      expect(moved()).toEqual([])
      expect(said).toEqual([COPIED, ENDED])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect(programsOn(folder)).toEqual([])
      // The program itself writes into a database it tries to open, and clears away what it had
      // kept beside one for a change it never finished. So everything as it was found, byte for
      // byte, is in the copy that was kept before the program was started.
      const copy = inBackend(`before-functions-${FUNCTIONS_HASH.slice(0, 12)}`)
      const sum = (name: string) =>
        createHash('sha256')
          .update(readFileSync(path.join(copy, name)))
          .digest('hex')
      expect(
        readdirSync(copy)
          .filter((name) => name !== 'copy.json')
          .map((name) => `${name} ${sum(name)}`)
          .sort(),
      ).toEqual(before.filter((file) => !file.includes(path.sep)))
      // And it says of itself that it is a copy It made, under that name
      expect(JSON.parse(readFileSync(path.join(copy, 'copy.json'), 'utf8'))).toEqual({
        copy: path.basename(copy),
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        made: expect.any(Number),
        order: 1,
        it: VERSION,
      })
      // Asked again, it says the same, and still moves nothing
      expect(await refusal(startBackend(config, say))).toBe('database_unfinished')
      expect(there()).toEqual(expect.arrayContaining(['data.json', 'db.sqlite3']))
      expect(moved()).toEqual([])
      // The person does what they were told they can, and It is set up as on a machine that never had it
      rmSync(inBackend(), { recursive: true, force: true })
      said = []
      const anew = await start(config)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(await healthy(config.port)).toBe(true)
      await anew.stop()
    }
    expect(refused).toBe(true)
  }, 420_000)

  test('what the program says of a database it cannot open is read a whole line at a time, in however many pieces the line arrives', async () => {
    const config = makeConfig()
    mkdirSync(inBackend(), { recursive: true })
    const bytes = Buffer.from('a database whose making was cut short\n')
    writeFileSync(database(), bytes)
    writeFileSync(inBackend('data.json'), JSON.stringify({ made: Date.now(), release: RELEASE, it: VERSION }))
    // The line that names the ending comes in two writes with a moment between them, as it does on a busy machine
    const once = path.join(scratch, `pieces-${Math.random().toString(36).slice(2)}`)
    process.env.IT_BACKEND_BIN = standIn(
      `if [ ! -e '${once}' ]; then touch '${once}'; echo 'a line before it' >&2; printf 'Error: ' >&2; sleep 0.3; printf 'missing _tables.by_id global\\n' >&2; exit 1; fi`,
    )
    expect(await refusal(startBackend(config, say))).toBe('database_unfinished')
    expect(said).toEqual([COPIED, ENDED])
    expect(readFileSync(database()).equals(bytes)).toBe(true)
    expect(moved()).toEqual([])
  }, 180_000)

  test('that this program is not known to have begun is left as it is, whatever the program says of it, and nobody is told that it may be moved', async () => {
    const config = makeConfig()
    mkdirSync(inBackend(), { recursive: true })
    const bytes = Buffer.from('this is not a database\n'.repeat(1000))
    for (const words of CUT_SHORT) {
      writeFileSync(database(), bytes)
      process.env.IT_BACKEND_BIN = failingOnce(words)
      said = []
      expect(await refusal(startBackend(config, say))).toBe('database_unopened')
      expect(said.at(-1)).toBe(ENDED)
      expect(readFileSync(database()).equals(bytes)).toBe(true)
    }
    // Nor is one into which a load was begun: from then on it may hold what a person made
    writeFileSync(inBackend('data.json'), JSON.stringify({ made: Date.now(), release: RELEASE, it: VERSION, loading: FUNCTIONS_HASH }))
    process.env.IT_BACKEND_BIN = failingOnce(CUT_SHORT[0]!)
    expect(await refusal(startBackend(config, say))).toBe('database_unopened')
    expect(readFileSync(database()).equals(bytes)).toBe(true)
    expect(moved()).toEqual([])
  }, 180_000)

  test('that this program began is left as it is when the program is missing, cannot be run, finds its port taken, aborts, or fails for a reason of its own', async () => {
    const config = makeConfig()
    mkdirSync(inBackend(), { recursive: true })
    const bytes = Buffer.from('a database whose making was cut short\n')
    const begun = JSON.stringify({ made: Date.now(), release: RELEASE, it: VERSION })
    const copy = `before-functions-${FUNCTIONS_HASH.slice(0, 12)}`
    const unrunnable = path.join(scratch, 'not-a-program')
    writeFileSync(unrunnable, 'not a program\n', { mode: 0o600 })
    // What a program writes after it has said why it ends, as one does that says where in itself it was: sixty lines of it
    const MORE = 'n=0; while [ $n -lt 60 ]; do echo "   at a place of its own, $n" >&2; n=$((n+1)); done'
    const ways: [string, string, string | RegExp | undefined][] = [
      [path.join(scratch, 'no-such-program'), 'backend_program', undefined],
      [unrunnable, 'backend_program', undefined],
      [standIn("echo 'Error: Address already in use (os error 98)' >&2; exit 1"), 'port_in_use', undefined],
      // The same words, with more written after them than is kept of what the program writes
      [standIn(`echo 'Error: Address already in use (os error 98)' >&2; ${MORE}; exit 1`), 'port_in_use', undefined],
      [standIn('kill -ABRT $$'), 'backend_exited', 'backend: the program ended as soon as it was started (SIGABRT)'],
      [standIn("echo 'Error: database disk image is malformed' >&2; exit 1"), 'backend_exited', ENDED],
      // The words of a database cut short, which are the last it says of why, however much it writes after them
      [standIn(`echo '${CUT_SHORT[0]}' >&2; ${MORE}; exit 1`), 'database_unfinished', ENDED],
      // The words of a database cut short, and another end than the one the program then comes to
      [standIn(`echo '${CUT_SHORT[0]}' >&2; exit 2`), 'backend_exited', 'backend: the program ended as soon as it was started (code 2)'],
    ]
    for (const [file, code, line] of ways) {
      rmSync(inBackend(copy), { recursive: true, force: true })
      writeFileSync(database(), bytes)
      writeFileSync(inBackend('data.json'), begun)
      process.env.IT_BACKEND_BIN = file
      said = []
      expect([file, await refusal(startBackend(config, say))]).toEqual([file, code])
      // Where there is no program to start, nothing is done at all. Anywhere else a copy was kept first, and that is all that was added.
      const kept = existsSync(file) ? [copy] : []
      expect(said).toEqual([...kept.map(() => COPIED), ...(line ? [line] : [])])
      expect(readFileSync(database()).equals(bytes)).toBe(true)
      expect(readFileSync(inBackend('data.json'), 'utf8')).toBe(begun)
      expect(readdirSync(inBackend()).sort()).toEqual([...kept, 'data.json', 'db.sqlite3'])
    }
  }, 180_000)
})

describe.skipIf(!program || windows)('one backend program at a time on a folder', () => {
  let little: string
  let faulty: string
  let listing: string
  let contender: string
  /** The source of the service in little, for a test that makes one of its own. */
  let source: string
  beforeAll(async () => {
    // How a program waits to be let go in the same instant as the others that wait on the same
    // file. It says that it is ready, in a file of its own. Told to stand by, it says so as
    // well, and from then on looks for the file without a pause, so that every one of them
    // goes on in the moment the file is made.
    const together = `
      const together = async (go) => {
        fs.writeFileSync(go + '.ready.' + process.pid, '')
        while (!fs.existsSync(go + '.set')) await new Promise((resolve) => setTimeout(resolve, 1))
        fs.writeFileSync(go + '.set.' + process.pid, '')
        while (!fs.existsSync(go)) {}
      }
    `
    // A service in little: it starts the backend for the folder and the port its environment
    // names, together with the others that wait on the file `TOGETHER` names if it is given
    // one, says what the backend says, and stops the backend when it is asked to. Told to, it
    // makes the folder's settings first, stops the backend the way a service on the system
    // `STOP_AS` names does, or, with `LINGER`, ends only when it has nothing left to wait for,
    // as a command does, and says as it ends for how long it stayed once the backend had stopped.
    const service = `
      import fs from 'node:fs'
      import { startBackend } from './src/serve/backend'
      import { makeConfig, readConfig } from './src/serve/config'
      ${together}
      let backend
      let asked = false
      const idle = setInterval(() => {}, 1000)
      const stop = async () => {
        asked = true
        if (backend) {
          if (process.env.STOP_AS) Object.defineProperty(process, 'platform', { value: process.env.STOP_AS })
          await backend.stop()
          if (process.env.LINGER) {
            const stopped = Date.now()
            process.on('exit', () => fs.writeSync(1, 'STAYED ' + (Date.now() - stopped) + '\\n'))
            return clearInterval(idle)
          }
          process.exit(0)
        }
      }
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
      try {
        const config = process.env.MAKE ? makeConfig() : readConfig()
        if (process.env.TOGETHER) await together(process.env.TOGETHER)
        backend = await startBackend(config, (line) => console.log(line))
        console.log('READY')
        if (asked) await stop()
      } catch (err) {
        console.log('ERROR ' + err.code)
        process.exit(1)
      }
    `
    little = path.join(scratch, 'little.mjs')
    source = service
    await bundled('little.mjs', service)
    // The same service, standing on a system with a fault in it, which its environment names:
    // `gone`, the service is killed in the moment after it started the backend program, before
    // it has noted anything of it; `no-note`, the disk has no room for the lock's note from
    // the moment the program is started; `no-links`, the disk cannot give a file a second name;
    // `kill-refused`, the system refuses to end the backend program. With `HIDDEN`, the system
    // keeps this account from reading what the process of that number was started with, and
    // with `HIDDEN_OF` it says that the process is the account's of that number. On this
    // system no PowerShell is to be had: asked to list what runs, it says what `POWERSHELL_SAYS`
    // holds, and the helper that asks a program on Windows to stop answers as it does of a
    // program with no console. With `PS_SAYS`, that is what `ps` says when it is asked to
    // list what runs. Either says what its `_NEXT` holds from the second asking on.
    // The fault is in what the service is given as the system's own files and processes, and
    // nothing of the service itself is other than it is.
    const faults: Plugin = {
      name: 'faults',
      setup(b) {
        b.onResolve({ filter: /^node:(fs|child_process)$/ }, (asked) => (asked.namespace === 'faults' ? undefined : { path: asked.path, namespace: 'faults' }))
        b.onLoad({ filter: /.*/, namespace: 'faults' }, (asked) => ({
          loader: 'js',
          contents:
            asked.path === 'node:fs'
              ? `
                import * as real from 'node:fs'
                export * from 'node:fs'
                export { default } from 'node:fs'
                export const openSync = (file, ...rest) => {
                  if (process.env.FAULT === 'no-note' && globalThis.programStarted && String(file).endsWith('.tmp') && String(file).includes('lock.'))
                    throw Object.assign(new Error('no room'), { code: 'ENOSPC' })
                  return real.openSync(file, ...rest)
                }
                export const linkSync = (from, to) => {
                  if (process.env.FAULT === 'no-links') throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' })
                  return real.linkSync(from, to)
                }
                export const readFileSync = (file, ...rest) => {
                  if (process.env.HIDDEN && String(file) === '/proc/' + process.env.HIDDEN + '/cmdline') throw Object.assign(new Error('not permitted'), { code: 'EACCES' })
                  return real.readFileSync(file, ...rest)
                }
                export const statSync = (file, ...rest) => {
                  const stat = real.statSync(file, ...rest)
                  if (process.env.HIDDEN_OF && String(file) === '/proc/' + process.env.HIDDEN) return { uid: Number(process.env.HIDDEN_OF) }
                  return stat
                }
              `
              : `
                import * as real from 'node:child_process'
                export * from 'node:child_process'
                export { default } from 'node:child_process'
                export const spawn = (file, args, options) => {
                  const child = real.spawn(file, args, options)
                  if (args?.includes('--local-storage')) {
                    globalThis.programStarted = true
                    if (process.env.FAULT === 'gone') process.kill(process.pid, 'SIGKILL')
                    if (process.env.FAULT === 'kill-refused')
                      child.kill = () => {
                        child.emit('error', Object.assign(new Error('refused'), { code: 'EPERM' }))
                        return false
                      }
                  }
                  return child
                }
                let asked = 0
                const said = (first, next) => (asked++ === 0 || next === undefined ? first : next)
                export const spawnSync = (file, args, ...rest) => {
                  if (file === 'powershell.exe')
                    return process.env.POWERSHELL_SAYS === undefined
                      ? { status: 3, stdout: '', stderr: '' }
                      : { status: 0, stdout: said(process.env.POWERSHELL_SAYS, process.env.POWERSHELL_SAYS_NEXT), stderr: '' }
                  if (process.env.PS_SAYS !== undefined && (file === 'ps' || file === '/bin/ps') && args.includes('-axww'))
                    return {
                      status: 0,
                      stdout: said(process.env.PS_SAYS, process.env.PS_SAYS_NEXT).replaceAll('SELF', String(process.pid)).replaceAll('MINE', String(process.geteuid())),
                      stderr: '',
                    }
                  return real.spawnSync(file, args, ...rest)
                }
              `,
        }))
      },
    }
    faulty = path.join(scratch, 'faulty.mjs')
    await bundled('faulty.mjs', service, [faults])
    // Something that looks through what runs for the backend programs on a folder, or under
    // the name `NAMED`, as the system `AS` names lists it, standing on a system with those same
    // faults in it, and says which it found or why it could not tell
    listing = path.join(scratch, 'listing.mjs')
    await bundled(
      'listing.mjs',
      `
        import { programsHere } from './src/serve/backend'
        try {
          console.log(JSON.stringify(programsHere(process.env.NAMED, process.env.AS)))
        } catch (err) {
          console.log('ERROR ' + err.code)
        }
      `,
      [faults],
    )
    // A program that takes a lock of the folder's, having waited to be let go together with the
    // others like it. While it holds the lock it leaves its number in a file, and writes down
    // any other program that it finds there at the same time as itself, and then that it has
    // had a turn. In one way of running it takes turn after turn with the others until they
    // have had as many between them as it is told, and is gone while it holds the lock, as a
    // program that was killed is, at every turn of so many. In the other it tries once: where
    // another has the lock it gives up, and where it takes it, it holds it until it is told
    // that the others are done, and is then gone while it holds it.
    contender = path.join(scratch, 'contender.mjs')
    await bundled(
      'contender.mjs',
      `
        import fs from 'node:fs'
        import { alone, startOf } from './src/serve/backend'
        ${together}
        const [mark, tally, go, most, each] = process.argv.slice(2)
        const inside = () => {
          try {
            return Number(fs.readFileSync(mark, 'utf8'))
          } catch {
            return 0
          }
        }
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const wrote = (line) => fs.appendFileSync(tally, line + '\\n')
        // How many turns have been had by all of them, which whoever has the lock can count
        const turns = () => fs.readFileSync(tally, 'utf8').split('\\n').filter((line) => line.startsWith('turn ')).length
        const turn = async (held) => {
          const other = inside()
          if (other && other !== process.pid && startOf(other) !== null) wrote('two')
          fs.writeFileSync(mark, String(process.pid))
          await held()
          if (inside() !== process.pid) wrote('two')
          wrote('turn ' + process.pid)
          return turns()
        }
        const gone = () => {
          wrote('gone ' + process.pid)
          process.exit(0)
        }
        // What kept it from the lock is written down: that another had it, which is no fault, or anything else, which ends it
        const kept = (err) => {
          if (err?.code === 'busy') return wrote('gave up ' + process.pid)
          wrote('failed ' + process.pid + ' ' + String(err?.code))
          process.exit(1)
        }
        await together(go)
        if (!most) {
          const over = async () => {
            while (!fs.existsSync(go + '.over')) await pause(2)
          }
          await alone('stress', async () => gone(await turn(over)), 0).catch(kept)
        } else {
          for (let done = false; done !== true; ) {
            done = await alone('stress', async () => {
              if (turns() >= Number(most)) return true
              const had = await turn(() => pause(Math.random() * 3))
              if (had % Number(each) === 0) gone()
              fs.rmSync(mark, { force: true })
              return had >= Number(most)
            }).catch(kept)
            // The others are given a moment to have the next turn
            await pause(Math.random() * 20)
          }
        }
      `,
    )
  }, HOOK_MS)

  const children: ChildProcess[] = []
  /** The base ports a test has taken for services it starts several of at once. */
  let several: number[] = []
  /**
   * Starts the service in little on a base port, and gives what it has said so far and how it
   * ended. With `go`, it waits on that file before it starts the backend. With `fault`, it is
   * the one that stands on a system with that fault in it.
   */
  const serve = (base: number, go?: string, fault?: string, more: Record<string, string> = {}, service = fault ? faulty : little) => {
    const child = spawn(process.execPath, [service], {
      env: {
        PATH: process.env.PATH,
        IT_HOME: folder,
        IT_PORT: String(base),
        IT_BACKEND_BIN: program!,
        ...(go ? { TOGETHER: go } : {}),
        ...(fault ? { FAULT: fault } : {}),
        ...more,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    child.stdout!.on('data', (c: Buffer) => (out += c))
    child.stderr!.on('data', (c: Buffer) => (out += c))
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    return { base, child, ended, out: () => out, lines: () => out.split('\n').filter(Boolean) }
  }
  afterEach(async () => {
    several = []
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(15_000)])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
    // A backend program a test left on the folder, or on a folder it made inside it, is woken, asked to stop, and waited for
    const left = execFileSync('ps', ['-axww', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(`${folder}${path.sep}`) && line.includes('--instance-name'))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
    for (const pid of new Set([...programsOn(folder), ...left])) {
      try {
        process.kill(pid, 'SIGCONT')
        process.kill(pid, 'SIGINT')
      } catch {}
      await until(() => startOf(pid) === null)
    }
  }, HOOK_MS)
  /** The ways the system's list of what runs is read that this system can be made to give. */
  const systems = (process.platform === 'linux' ? ['linux', 'darwin'] : [process.platform]) as NodeJS.Platform[]
  /** Whether the list is read here as Linux gives it, a process to a folder under `/proc`, with the folder each runs in and the files it has open. */
  const proc = process.platform === 'linux' && existsSync('/proc/self/stat')
  /** What a lock made on this machine, as it runs now, says of where it is from. */
  const here = async () => {
    const mark = path.join(scratch, `here-${Math.random().toString(36).slice(2)}`)
    const before = process.env.IT_HOME
    process.env.IT_HOME = mark
    try {
      let where = ''
      await alone('here', async () => {
        where = readJson<{ where: string }>(path.join(mark, 'here.lock'))!.where
      })
      return where
    } finally {
      process.env.IT_HOME = before
    }
  }
  /** A service that was killed, and the backend program it left running on the folder. */
  const orphan = async () => {
    const base = Number(process.env.IT_PORT)
    const first = serve(base)
    expect(await until(() => healthy(base))).toBe(true)
    const [left] = programsOn(folder)
    first.child.kill('SIGKILL')
    await first.ended
    expect(startOf(left!)).toEqual(expect.any(String))
    return left!
  }
  /**
   * Lets programs that wait on a file go on in the same instant. Each has said that it is
   * ready by then, however long it took to be. They are told to stand by, each says that it
   * looks for the file and does nothing else, and the file is made.
   */
  const letGo = async (go: string, waiting: ChildProcess[]) => {
    const said = (what: string) => waiting.filter((one) => existsSync(`${go}.${what}.${one.pid}`)).length
    const seen = () => ({ ready: said('ready'), set: said('set'), ended: waiting.filter((one) => one.exitCode !== null || one.signalCode !== null).length })
    await comes(() => said('ready') === waiting.length, seen)
    writeFileSync(`${go}.set`, '')
    await comes(() => said('set') === waiting.length, seen)
    writeFileSync(go, '')
  }
  /**
   * Starts several services for the folder in the same instant, each on ports of its own, and
   * waits until each has the folder or has given up. A test that does so again gives them the
   * ports it took the first time, which the ones before have let go of by then.
   */
  const atOnce = async (count: number) => {
    while (several.length < count) several.push(await ports.next())
    const go = path.join(scratch, `go-${Math.random().toString(36).slice(2)}`)
    const all = several.slice(0, count).map((base) => serve(base, go))
    await letGo(
      go,
      all.map((one) => one.child),
    )
    await comes(
      () => all.every((one) => /READY|ERROR/.test(one.out())),
      () => all.map((one) => one.lines()),
      240_000,
    )
    return all
  }
  /** That of several services exactly one has the folder, the others having said that it is taken, and that one backend program runs on it. */
  const oneHolds = async (all: Awaited<ReturnType<typeof atOnce>>) => {
    const outcomes = all.map((one) => one.lines().at(-1)).sort()
    expect(outcomes).toEqual([...Array.from({ length: all.length - 1 }, () => 'ERROR already_running'), 'READY'])
    const holder = all.find((one) => one.out().includes('READY'))!
    expect(programsOn(folder)).toEqual([lock()!.program])
    expect(lock()).toMatchObject({ pid: holder.child.pid, api: backendAt(holder.base).api })
    expect(await Promise.all(all.map((one) => healthy(one.base)))).toEqual(all.map((one) => one === holder))
    // Nothing is left of how the lock was taken
    expect(readdirSync(inBackend()).filter((name) => name.startsWith('lock'))).toEqual(['lock'])
    return holder
  }

  test('the lock names the service and the backend program each by its number and when it was started, and is gone when the service has stopped', async () => {
    const backend = await start(makeConfig())
    const held = lock()!
    expect(held).toEqual({
      pid: process.pid,
      started: startOf(process.pid),
      where: expect.any(String),
      holder: expect.stringMatching(/^[0-9a-f]{16}$/),
      api: backend.api,
      program: expect.any(Number),
      programStarted: startOf(held.program!),
    })
    expect(programsOn(folder)).toEqual([held.program])
    // The time a process was started is told in the same words whenever it is asked, and of no process that is gone
    expect(startOf(process.pid)).toBe(held.started)
    expect(held.started).toEqual(expect.any(String))
    await backend.stop()
    expect(startOf(held.program!)).toBeNull()
    expect(existsSync(inBackend('lock'))).toBe(false)
  }, 180_000)

  test('a backend program that outlived its service, and does not stop when it is asked to, keeps another from being started on its data', async () => {
    makeConfig()
    const left = await orphan()
    // The program hangs: asked to stop, it does not hear
    process.kill(left, 'SIGSTOP')
    // Another service for the same folder, on other ports, as one would be whose settings were changed
    const second = serve(await ports.next())
    expect(await until(() => second.out().includes(`backend: one left running by a service that is gone is asked to stop (pid ${left})`))).toBe(true)
    await pause(3000)
    expect(programsOn(folder)).toEqual([left])
    expect(await healthy(second.base)).toBe(false)
    expect(second.out()).not.toContain('READY')
    // A third finds the second at it, and gives up without touching anything
    const third = serve(await ports.next())
    expect(await third.ended).toBe(1)
    expect(third.lines()).toEqual(['ERROR already_running'])
    // Once the program that was left has stopped, the folder is free, and the second service has it
    process.kill(left, 'SIGCONT')
    expect(await until(() => second.out().includes('READY'))).toBe(true)
    expect(startOf(left)).toBeNull()
    expect(await healthy(second.base)).toBe(true)
    expect(programsOn(folder)).toEqual([lock()!.program])
  }, 300_000)

  test('a backend program on the folder is found in the system’s own list of what runs, whatever the lock says of it and where there is no lock at all, and is asked to stop before another is started', async () => {
    const config = makeConfig()
    const asked = (pid: number) => `backend: one left running by a service that is gone is asked to stop (pid ${pid})`
    // The lock does not say when the program was started
    let left = await orphan()
    const { programStarted: _, ...vague } = lock()!
    writeFileSync(inBackend('lock'), JSON.stringify(vague))
    let backend = await start(config)
    expect(said).toEqual([asked(left), expect.stringMatching(/^backend: started/)])
    expect(startOf(left)).toBeNull()
    expect(programsOn(folder)).toEqual([lock()!.program])
    await backend.stop()
    // The lock names no program: its service was gone before it had noted one
    left = await orphan()
    const { program: __, programStarted: ___, ...unnoted } = lock()!
    writeFileSync(inBackend('lock'), JSON.stringify(unnoted))
    said = []
    process.env.IT_PORT = String(await ports.next())
    backend = await start(readConfig()!)
    expect(said).toEqual([asked(left), expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
    expect(startOf(left)).toBeNull()
    await backend.stop()
    // There is no lock: nothing on the folder says that a program was ever started on it
    left = await orphan()
    rmSync(inBackend('lock'))
    said = []
    backend = await start(readConfig()!)
    expect(said[0]).toBe(asked(left))
    expect(startOf(left)).toBeNull()
    expect(programsOn(folder)).toEqual([lock()!.program])
    await backend.stop()
    expect(programsOn(folder)).toEqual([])
  }, 300_000)

  /**
   * A program of the person's own that is no backend program, started with the words it is
   * given and in the folder it is given. It notes when it is interrupted, and answers when it
   * is asked whether it is there.
   */
  const bystander = async (words: string[] = [], cwd?: string) => {
    const file = path.join(scratch, 'bystander.mjs')
    writeFileSync(
      file,
      "process.on('SIGINT', () => console.log('INT')); process.stdin.on('data', () => console.log('HERE')); console.log('READY'); setInterval(() => {}, 1000)",
    )
    const child = spawn(process.execPath, [file, ...words], { stdio: ['pipe', 'pipe', 'ignore'], ...(cwd ? { cwd } : {}) })
    children.push(child)
    let out = ''
    child.stdout!.on('data', (c: Buffer) => (out += c))
    expect(await until(() => out.includes('READY'))).toBe(true)
    return {
      pid: child.pid!,
      /** Whether it has been interrupted. It is asked something first and has answered, so whatever was sent to it before has reached it. */
      interrupted: async () => {
        const answers = out.split('HERE').length
        child.stdin!.write('are you there\n')
        expect(await until(() => out.split('HERE').length > answers)).toBe(true)
        return out.includes('INT')
      },
      end: async () => {
        child.kill('SIGKILL')
        expect(await until(() => startOf(child.pid!) === null)).toBe(true)
      },
    }
  }
  const UNTOLD = (pid: number) =>
    `backend: a program that may be one left on this folder cannot be told to be the backend program, and is not asked to stop (pid ${pid})`

  test('a process under the number the lock names that is not a backend program on this folder is never signalled: it keeps another from being started where it cannot be told from the one the lock means, and is passed over where it can', async () => {
    const config = makeConfig()
    await (await start(config)).stop()
    said = []
    // A program of the person's own, which the system gave the number the backend program once had, and which runs in the backend's folder
    const other = await bystander([], inBackend())
    const gone = { pid: process.pid, started: 'at another time', where: await here(), holder: '0123456789abcdef', api: backendAt(config.port).api }
    // The lock does not say when its program was started, so the number could be that program's
    const vague = { ...gone, program: other.pid }
    writeFileSync(inBackend('lock'), JSON.stringify(vague))
    expect(await refusal(startBackend(config, say))).toBe('still_running')
    expect(said).toEqual([])
    expect(lock()).toEqual(vague)
    expect(programsOn(folder)).toEqual([])
    // It says when, and that is not when this process was started: the number has been given out anew
    writeFileSync(inBackend('lock'), JSON.stringify({ ...vague, programStarted: 'at another time' }))
    const backend = await start(config)
    expect(said).toEqual([expect.stringMatching(/^backend: started/)])
    await backend.stop()
    expect(await other.interrupted()).toBe(false)
    // It says when, and that is when this very process was started: what runs there is still not the backend program, as the system shows it
    const exact = { ...vague, programStarted: startOf(other.pid) }
    writeFileSync(inBackend('lock'), JSON.stringify(exact))
    said = []
    const refused = (await startBackend(config, say).catch((err) => err)) as Problem
    expect([refused.code, refused.message, refused.hint]).toEqual([
      'still_running',
      `A program on this machine may be a backend program left on this folder (pid ${other.pid}), and It cannot tell that what runs there is the backend program. It is not asked to stop, and no backend program is started beside it.`,
      'If it is a backend program, end it with an interrupt, as Ctrl-C at a terminal would. If it is something else, end it or wait until it has ended. Then start It again.',
    ])
    expect(said).toEqual([UNTOLD(other.pid)])
    expect(lock()).toEqual(exact)
    expect(await other.interrupted()).toBe(false)
    await other.end()
    // A lock that was copied here with its folder names the program of the folder it came from, by its number and when it was started.
    // Where the system shows that this program runs somewhere else and has nothing of this folder open, it is passed over.
    if (proc) {
      const theirs = await bystander()
      writeFileSync(inBackend('lock'), JSON.stringify({ ...gone, program: theirs.pid, programStarted: startOf(theirs.pid) }))
      said = []
      await (await start(config)).stop()
      expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
      expect(await theirs.interrupted()).toBe(false)
    }
  }, 300_000)

  test('a program that was only started with what a backend program on this folder is started with is not asked to stop: nothing is signalled that the system does not show to be the backend program, and no backend program is started beside one that runs in the backend’s folder', async () => {
    const config = makeConfig()
    await (await start(config)).stop()
    said = []
    const words = ['--instance-name', instanceName(config.instanceSecret), database()]
    // A program of the person's own that runs in the backend's folder
    const other = await bystander(words, inBackend())
    for (let round = 0; round < 3; round++) {
      said = []
      expect(await refusal(startBackend(config, say))).toBe('still_running')
      expect(said).toEqual([UNTOLD(other.pid)])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect(programsOn(folder)).toEqual([other.pid])
    }
    expect(await other.interrupted()).toBe(false)
    await other.end()
    // Once it has ended, the folder is free
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
    // One that runs somewhere else and has nothing of this folder open is, where the system shows that, no program on this folder, whatever it was started with
    if (proc) {
      const elsewhere = await bystander(words)
      said = []
      await (await start(config)).stop()
      expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
      expect(await elsewhere.interrupted()).toBe(false)
      await elsewhere.end()
    }
    // And one that runs in the backend's folder under a name of its own, and was not started with the database, is none either
    const beside = await bystander(['--instance-name', 'a-name-of-its-own'], inBackend())
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
    expect(await beside.interrupted()).toBe(false)
  }, 300_000)

  test('a backend program whose service was gone in the moment after it started it, before anything was noted of it, keeps another from being started for as long as it runs, though it answers nowhere', async () => {
    makeConfig()
    const base = Number(process.env.IT_PORT)
    const first = serve(base, undefined, 'gone')
    await first.ended
    expect(first.child.signalCode).toBe('SIGKILL')
    const [left, ...more] = programsOn(folder)
    expect(more).toEqual([])
    expect(startOf(left!)).toEqual(expect.any(String))
    // The lock says where a program was to answer, and names none
    expect(lock()).toEqual({
      pid: first.child.pid,
      started: expect.any(String),
      where: expect.any(String),
      holder: expect.any(String),
      api: backendAt(base).api,
    })
    // The program is up, and then it hangs: it answers on no port, and asked to stop, it does not hear
    expect(await until(() => answering(base))).toBe(true)
    process.kill(left!, 'SIGSTOP')
    expect(await answering(base)).toBe(false)
    const second = serve(await ports.next())
    expect(await until(() => second.out().includes(`backend: one left running by a service that is gone is asked to stop (pid ${left})`))).toBe(true)
    // For far longer than a program takes to begin answering, nothing else is started on its data
    await pause(15_000)
    expect(programsOn(folder)).toEqual([left])
    expect(second.out()).not.toContain('READY')
    expect(await healthy(second.base)).toBe(false)
    // Once it has gone, the folder is free
    process.kill(left!, 'SIGCONT')
    expect(await until(() => second.out().includes('READY'))).toBe(true)
    expect(startOf(left!)).toBeNull()
    expect(programsOn(folder)).toEqual([lock()!.program])
  }, 300_000)

  // These two are of the list as Linux gives it, where each process's command line is a file that this account may be kept from reading.
  // Of the list `ps` gives, and the one Windows gives, the same is held further down, by rows such a list would have.
  test.skipIf(!proc)(
    'a backend program left on the folder that this account is kept from reading the command line of keeps another from being started: a list that cannot show it does not say the folder is free',
    async () => {
      makeConfig()
      const base = Number(process.env.IT_PORT)
      // Its service was gone before it had noted anything of it, and it answers on no port
      const first = serve(base, undefined, 'gone')
      await first.ended
      const [left] = programsOn(folder)
      expect(startOf(left!)).toEqual(expect.any(String))
      expect(await until(() => answering(base))).toBe(true)
      process.kill(left!, 'SIGSTOP')
      const found = lock()
      for (let round = 0; round < 3; round++) {
        const second = serve(await ports.next(), undefined, 'hidden', { HIDDEN: String(left) })
        expect(await second.ended).toBe(1)
        expect(second.lines()).toEqual(['ERROR cannot_list_processes'])
        // Nothing was started beside it, it was not signalled, and the lock is as the first service left it
        expect(programsOn(folder)).toEqual([left])
        expect(lock()).toEqual(found)
      }
      // A service that is let read it finds it, asks it to stop, and has the folder once it has gone
      process.kill(left!, 'SIGCONT')
      const third = serve(await ports.next())
      expect(await until(() => third.out().includes('READY'))).toBe(true)
      expect(third.lines()[0]).toBe(`backend: one left running by a service that is gone is asked to stop (pid ${left})`)
      expect(startOf(left!)).toBeNull()
      expect(programsOn(folder)).toEqual([lock()!.program])
    },
    300_000,
  )

  test.skipIf(!proc)(
    'of the processes whose command line cannot be read, one of this account’s own keeps a backend program from being started, and another account’s, or one that has ended, does not',
    async () => {
      makeConfig()
      const base = Number(process.env.IT_PORT)
      const other = spawn('sleep', ['120'], { stdio: 'ignore' })
      children.push(other)
      const ended = spawn('true', [], { stdio: 'ignore' })
      await new Promise((resolve) => ended.once('exit', resolve))
      const mine = serve(base, undefined, 'hidden', { HIDDEN: String(other.pid) })
      expect(await mine.ended).toBe(1)
      expect(mine.lines()).toEqual(['ERROR cannot_list_processes'])
      expect(programsOn(folder)).toEqual([])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect([other.exitCode, other.signalCode]).toEqual([null, null])
      // The same process, as another account's: it cannot be a backend program on this person's folder
      const passed: Record<string, string>[] = [{ HIDDEN: String(other.pid), HIDDEN_OF: String(process.getuid!() + 1) }, { HIDDEN: String(ended.pid) }]
      for (const more of passed) {
        const theirs = serve(base, undefined, 'hidden', more)
        expect(await until(() => /READY|ERROR/.test(theirs.out()))).toBe(true)
        expect(theirs.lines().at(-1)).toBe('READY')
        theirs.child.kill('SIGTERM')
        expect(await theirs.ended).toBe(0)
      }
      expect([other.exitCode, other.signalCode]).toEqual([null, null])
    },
    300_000,
  )

  test('in the list `ps` gives, a process of this account’s own that is shown by the backend program’s name alone keeps a backend program from being started, and one shown by another name, another account’s, or one that has ended does not', async () => {
    // It's folder, for whoever reads the list, with a space in its name
    const home = path.join(folder, 'a person')
    mkdirSync(path.join(home, 'backend'), { recursive: true })
    // What `ps` says is given here as a list of this test's own, a row to a process: its number, whose it is, how it is, and
    // what it was started with. `SELF` stands for the program that reads the list, and `MINE` for the account it runs as.
    const listed = (rows: string[], next?: string[]) =>
      execFileSync(process.execPath, [listing], {
        env: {
          PATH: process.env.PATH,
          IT_HOME: home,
          IT_BACKEND_BIN: program!,
          AS: 'darwin',
          NAMED: 'it-000000000000',
          PS_SAYS: `${rows.join('\n')}\n`,
          ...(next ? { PS_SAYS_NEXT: `${next.join('\n')}\n` } : {}),
        },
        encoding: 'utf8',
      }).trim()
    const self = 'SELF  MINE S+   /usr/local/bin/node /somewhere/listing.mjs'
    const others = [
      '    1     0 Ss   /sbin/launchd',
      '  312     0 Ss   /usr/libexec/logd',
      '  501  MINE S    /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
      '  502  MINE Ss   -zsh',
      // A program whose own first word is a name between brackets, as some are started
      '  777  MINE S    (sd-pam)',
    ]
    expect(listed([...others, self])).toBe('[]')
    // A process `ps` was told nothing of is shown by its name between brackets, and a system keeps the first fifteen or sixteen letters of a name
    for (const name of ['(convex-local-bac)', '(convex-local-ba)', '[convex-local-ba]', '(convex-local-backend)'])
      expect([name, listed([...others, `  900  MINE S    ${name}`, self])]).toEqual([name, 'ERROR cannot_list_processes'])
    // Another account's cannot be a backend program on this person's folder, one that has ended has nothing open, and another name is another program's
    expect(
      listed([
        ...others,
        '  900     0 Ss   (convex-local-bac)',
        '  901  MINE Z    (convex-local-bac)',
        '  902  MINE S    (convex-local)',
        '  903  MINE S    (some-other-program)',
        self,
      ]),
    ).toBe('[]')
    // A backend program on this folder's database is read out of such a row, with the spaces in its folder's name and under whatever name it runs
    const backend = `  950  MINE S    ${home}/backend/bin/a release/convex-local-backend --interface 127.0.0.1 --instance-name it-ffffffffffff --instance-secret x --local-storage ${home}/backend/storage --disable-beacon ${home}/backend/db.sqlite3`
    expect(listed([...others, backend, self])).toBe('[950]')
    // One that runs under this folder's name on a database that is nowhere to be found may be this folder's or a copy's: nothing is started beside it
    const alike =
      '  960  MINE S    /Users/a person/.it/backend/bin/a release/convex-local-backend --interface 127.0.0.1 --instance-name it-000000000000 --instance-secret x --local-storage /Users/a person/.it/backend/storage --disable-beacon /Users/a person/.it/backend/db.sqlite3'
    expect(listed([...others, alike, self])).toBe('ERROR still_running')
    expect(listed([...others, alike.replace('it-000000000000', 'it-ffffffffffff'), self])).toBe('[]')
    // A process that is on its way out is shown by its name alone for a moment: looked for again, it is gone, and has kept nothing back
    expect(listed([...others, '  900  MINE R    (convex-local-bac)', backend, self], [...others, backend, self])).toBe('[950]')
    expect(listed([...others, '  900  MINE R    (convex-local-bac)', self], [...others, '  900  MINE Z    (convex-local-bac)', self])).toBe('[]')
    // A list that does not show the very program that reads it is not the whole list
    expect(listed([...others, backend])).toBe('ERROR cannot_list_processes')
    expect(listed([])).toBe('ERROR cannot_list_processes')
  }, 180_000)

  test('what Windows lists is taken for the whole list only when it ends as It asked and shows this very program, and a program of the backend program’s name whose command line Windows keeps back is passed over only where it is another account’s', async () => {
    const config = makeConfig()
    const listed = (says: string[], next?: string[]) =>
      execFileSync(process.execPath, [listing], {
        env: {
          PATH: process.env.PATH,
          IT_HOME: folder,
          IT_BACKEND_BIN: program!,
          AS: 'win32',
          NAMED: instanceName(config.instanceSecret),
          POWERSHELL_SAYS: says.join('\r\n'),
          ...(next ? { POWERSHELL_SAYS_NEXT: next.join('\r\n') } : {}),
        },
        encoding: 'utf8',
      }).trim()
    const coded = (line: string) => Buffer.from(line).toString('base64')
    const backend = `seen 4242 ${coded(`"${program}" --port 1 --instance-name ${instanceName(config.instanceSecret)} --instance-secret x "${database()}"`)}`
    const another = `seen 4343 ${coded(`"${program}" --port 1 --instance-name it-000000000000 --instance-secret x "${path.join(scratch, 'backend', 'db.sqlite3')}"`)}`
    expect(listed(['self', 'end'])).toBe('[]')
    expect(listed(['self', another, backend, 'end'])).toBe('[4242]')
    // A command line too long to be the name of any file is read like any other
    const long = `seen 4747 ${coded(`/bin/sh -c "echo ${'a long line '.repeat(500)}" --instance-name it-000000000000 /nowhere/backend/db.sqlite3`)}`
    expect(listed(['self', long, backend, 'end'])).toBe('[4242]')
    // It is known by this folder's database under whatever name. One that only runs under this folder's name, on a database that is nowhere
    // to be found, may be this folder's from when it was called something else, or a copy's: it is asked nothing, and nothing is started beside it
    const remade = `seen 4444 ${coded(`"${program}" --instance-name it-000000000000 "${database()}"`)}`
    const renamed = `seen 4545 ${coded(`C:\\it\\convex-local-backend.exe --instance-name ${instanceName(config.instanceSecret)} --instance-secret x "C:\\Users\\A person\\.it\\backend\\db.sqlite3"`)}`
    expect(listed(['self', remade, 'end'])).toBe('[4444]')
    expect(listed(['self', remade, renamed, 'end'])).toBe('ERROR still_running')
    // The same goes for one under this folder's name that was started on a database that is there and is not this folder's, as a copy's is
    mkdirSync(path.join(scratch, 'a copy', 'backend'), { recursive: true })
    writeFileSync(path.join(scratch, 'a copy', 'backend', 'db.sqlite3'), 'another database')
    const copy = `seen 4646 ${coded(`"${program}" --instance-name ${instanceName(config.instanceSecret)} "${path.join(scratch, 'a copy', 'backend', 'db.sqlite3')}"`)}`
    expect(listed(['self', copy, 'end'])).toBe('ERROR still_running')
    // Cut short, or without this very program in it, it is no list to go by
    expect(listed(['self', backend])).toBe('ERROR cannot_list_processes')
    expect(listed([backend, 'end'])).toBe('ERROR cannot_list_processes')
    expect(listed([])).toBe('ERROR cannot_list_processes')
    // A program named as the backend program is, of which Windows will not say what it was started with
    expect(listed(['self', backend, 'unseen 77 other 1', 'unseen 78 other 0', 'unseen 79 unknown 0', 'end'])).toBe('[4242]')
    expect(listed(['self', backend, 'unseen 77 mine 0', 'end'])).toBe('ERROR cannot_list_processes')
    expect(listed(['self', backend, 'unseen 77 mine 1', 'end'])).toBe('ERROR cannot_list_processes')
    expect(listed(['self', 'unseen 77 unknown 1', 'end'])).toBe('ERROR cannot_list_processes')
    // One that is so only for the moment it takes to end is gone when Windows is asked again
    expect(listed(['self', backend, 'unseen 77 mine 1', 'end'], ['self', backend, 'end'])).toBe('[4242]')
  }, 180_000)

  test('a backend program that was started is stopped again, and only then is the lock let go, when what is to be noted of it cannot be written', async () => {
    makeConfig()
    const base = Number(process.env.IT_PORT)
    for (let round = 0; round < 3; round++) {
      const first = serve(base, undefined, 'no-note')
      expect(await first.ended).toBe(1)
      // It was started, and was asked to stop and waited for by the service that could not note it
      expect(first.lines().at(-1)).toBe('ERROR ENOSPC')
      expect(programsOn(folder)).toEqual([])
      expect(readdirSync(inBackend()).filter((name) => name === 'lock' || name.startsWith('lock.after.'))).toEqual([])
      // What the program had begun of a database in the moment it ran is not what is looked at here
      rmSync(inBackend(), { recursive: true, force: true })
    }
    // The folder is free, and the next service finds nothing on it to stop
    const backend = await start(readConfig()!)
    expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
    await backend.stop()
  }, 300_000)

  test('a backend program that Windows would not end is not taken to have gone: the lock stays, the service says that it could not end it, and the next service finds the program', async () => {
    makeConfig()
    const base = Number(process.env.IT_PORT)
    const first = serve(base, undefined, 'kill-refused', { STOP_AS: 'win32' })
    expect(await until(() => first.out().includes('READY'))).toBe(true)
    const pid = lock()!.program!
    first.child.kill('SIGTERM')
    expect(await first.ended).toBe(0)
    // It could not be asked, having no console, and was then to be ended, which the system refused
    expect(first.lines().slice(-3)).toEqual([
      'READY',
      `backend: did not stop when asked, and is ended (pid ${pid}, no_console)`,
      `backend: could not be ended, and is left running (pid ${pid})`,
    ])
    // The program lives, so the lock is still there, and says which process the program is
    expect(startOf(pid)).toEqual(expect.any(String))
    expect(await answering(base)).toBe(true)
    expect(lock()).toMatchObject({ pid: first.child.pid, program: pid })
    // The next service finds it on the folder, asks it to stop, and only then starts its own
    const backend = await start(readConfig()!)
    expect(said[0]).toBe(`backend: one left running by a service that is gone is asked to stop (pid ${pid})`)
    expect(startOf(pid)).toBeNull()
    expect(programsOn(folder)).toEqual([lock()!.program])
    await backend.stop()
  }, 300_000)

  test('a stop on Windows that goes well leaves nothing waited for: a command that started the backend only for as long as it needed ends as soon as the program has', async () => {
    makeConfig()
    const first = serve(Number(process.env.IT_PORT), undefined, 'none', { STOP_AS: 'win32', LINGER: '1' })
    expect(await until(() => first.out().includes('READY'))).toBe(true)
    const pid = lock()!.program!
    first.child.kill('SIGTERM')
    // It ends by itself, having nothing left to wait for
    let ended: number | null | undefined
    void first.ended.then((code) => (ended = code))
    await comes(() => ended !== undefined, first.lines)
    expect([ended, first.lines().slice(-3)]).toEqual([
      0,
      [`backend: did not stop when asked, and is ended (pid ${pid}, no_console)`, 'backend: stopped', expect.stringMatching(/^STAYED \d+$/)],
    ])
    // By its own measure it stayed a moment once the backend had stopped, and nothing like the
    // ten seconds or the thirty that a stop on Windows may wait for
    expect(Number(first.lines().at(-1)!.slice(7))).toBeLessThan(5000)
    expect(startOf(pid)).toBeNull()
    expect(existsSync(inBackend('lock'))).toBe(false)
  }, 180_000)

  /**
   * A later version of It, as a program of its own: the service in little under another number,
   * with functions that ask something more of every person's record, in a word `more` gives
   * after the record's own. Gives the program and the hash of its functions.
   */
  const laterIt = async (name: string, version: string, more: (v: string) => string) => {
    const request = JSON.parse(FUNCTIONS) as { appDefinition: { schema: { source: string } } }
    request.appDefinition.schema.source = request.appDefinition.schema.source.replace(
      /subject:\s*(\w+)\.string\(\),/,
      (whole, v: string) => `${whole} ${more(v)},`,
    )
    const other = JSON.stringify(request)
    expect(other).not.toBe(FUNCTIONS)
    const hash = createHash('sha256').update(other).digest('hex')
    await bundled(name, source, [
      {
        name: 'a later version',
        setup(b) {
          b.onLoad({ filter: /functions\.generated\.ts$/ }, () => ({
            loader: 'ts',
            contents: `export const FUNCTIONS = ${JSON.stringify(other)}\nexport const FUNCTIONS_HASH = '${hash}'`,
          }))
          b.onLoad({ filter: /[\\/]src[\\/]lib\.ts$/ }, (asked) => ({
            loader: 'ts',
            contents: readFileSync(asked.path, 'utf8').replace(`export const VERSION = '${VERSION}'`, `export const VERSION = '${version}'`),
          }))
        },
      },
    ])
    return { program: path.join(scratch, name), hash }
  }
  const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1))
  const NEWEST = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 2))

  test('a newer It whose functions the database refuses serves with the ones that are there, and the It those came with is started on the database again', async () => {
    const config = makeConfig()
    const first = await start(config)
    const made = (await asAdmin(first, 'bridge:enroll', { subject: 'owner', name: 'what a person made', publicKey: KEY })) as { machineId: string }
    await first.stop()
    // The next version of It: its functions ask of every person's record something that the one there has not
    const { program: next, hash } = await laterIt('newer.mjs', NEWER, (v) => `somethingNew: ${v}.string()`)
    const newer = serve(config.port, undefined, undefined, {}, next)
    expect(await until(() => /READY|ERROR/.test(newer.out()))).toBe(true)
    expect(newer.lines().slice(-3)).toEqual([
      'backend: functions not loaded (schema failed)',
      'backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)',
      'READY',
    ])
    // The newer It is the one that last ran, and the functions in the database are still this version's
    expect(note()).toMatchObject({ it: NEWER, functions: FUNCTIONS_HASH, functionsOf: VERSION, behind: { functions: hash, why: 'refused' } })
    newer.child.kill('SIGTERM')
    expect(await newer.ended).toBe(0)
    // This version is started on it again, finds its own functions there, and what the person made
    said = []
    const again = await start(readConfig()!)
    expect(said).toEqual([expect.stringMatching(/^backend: started/)])
    expect(again.behind).toBeUndefined()
    expect(standing()).toEqual({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })
    expect(await asAdmin(again, 'bridge:machine', { id: made.machineId })).toMatchObject({ id: made.machineId, revoked: false })
    await again.stop()
  }, 300_000)

  test('a loading whose end was never learned stays unlearned when a later It’s functions are refused, or cannot be loaded for want of a copy: the It from before both is not started on a database that may have the functions of the It between in it', async () => {
    const config = makeConfig()
    const first = await start(config)
    const made = (await asAdmin(first, 'bridge:enroll', { subject: 'owner', name: 'what a person made', publicKey: KEY })) as { machineId: string }
    await first.stop()
    const before = note()
    // The next It, whose functions fit what is there, and the one after it, whose functions do not
    const second = await laterIt('second.mjs', NEWER, (v) => `somethingNew: ${v}.optional(${v}.string())`)
    const third = await laterIt('third.mjs', NEWEST, (v) => `somethingElse: ${v}.string()`)
    /** Runs one of them as the service until it is ready, and stops it again. What it said. */
    const ran = async (program: string) => {
      const service = serve(config.port, undefined, undefined, {}, program)
      expect(await until(() => /READY|ERROR/.test(service.out()))).toBe(true)
      service.child.kill('SIGTERM')
      await service.ended
      return service.lines()
    }
    // The next It loads its functions, and they go in
    expect(await ran(second.program)).toEqual(expect.arrayContaining([`backend: functions loaded (${second.hash.slice(0, 12)})`, 'READY']))
    expect(note()).toMatchObject({ it: NEWER, functions: second.hash, functionsOf: NEWER })
    const { load: loadOfTheNext } = note()
    // What is noted is put back as it stood in the moment they were in and its service was gone before it had noted so
    writeFileSync(inBackend('data.json'), JSON.stringify({ ...before, it: NEWER, loading: second.hash }))
    const refusedFor = async () => {
      said = []
      const refused = (await startBackend(readConfig()!, say).catch((err) => err)) as Problem
      expect(said).toEqual([])
      expect(programsOn(folder)).toEqual([])
      return [refused.code, refused.message]
    }
    const older = [
      'backend_older',
      `It ${NEWER} began to load its functions into what It keeps in ${inBackend()}, and how that ended was never learned. It is newer than this It ${VERSION}, and an older It is not started on what may have a newer one’s functions in it.`,
    ]
    expect(await refusedFor()).toEqual(older)
    // The It after it is refused its functions, and serves with the ones that are there: that says nothing of whether the next It's went in
    expect(await ran(third.program)).toEqual(
      expect.arrayContaining(['backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)', 'READY']),
    )
    expect(note()).toMatchObject({
      it: NEWEST,
      functions: FUNCTIONS_HASH,
      functionsOf: VERSION,
      unsettled: { it: NEWER, functions: [second.hash] },
      behind: { functions: third.hash, why: 'refused' },
    })
    expect(note()).not.toHaveProperty('loading')
    expect(await refusedFor()).toEqual(older)
    // Nor does its going on for want of a copy, where something It did not make has the name its copy would have
    rmSync(inBackend(`before-functions-${third.hash.slice(0, 12)}`), { recursive: true })
    mkdirSync(inBackend(`before-functions-${third.hash.slice(0, 12)}`))
    expect(await ran(third.program)).toEqual(
      expect.arrayContaining([
        'backend: for want of a copy, other functions were not loaded, and the ones already loaded go on serving (copy_failed)',
        'READY',
      ]),
    )
    expect(note()).toMatchObject({ unsettled: { it: NEWER, functions: [second.hash] }, behind: { why: 'no_copy' } })
    expect(await refusedFor()).toEqual(older)
    // The next It itself is started on it, loads its functions though what was last noted as loaded is its own, and nothing is left unlearned
    writeFileSync(inBackend('data.json'), JSON.stringify({ ...note(), load: loadOfTheNext, functions: second.hash }))
    expect(await ran(second.program)).toEqual(expect.arrayContaining([`backend: functions loaded (${second.hash.slice(0, 12)})`, 'READY']))
    expect(note()).toMatchObject({ it: NEWER, functions: second.hash, functionsOf: NEWER })
    expect(note()).not.toHaveProperty('unsettled')
    // And what the person made is there
    const again = serve(config.port, undefined, undefined, {}, second.program)
    expect(await until(() => /READY|ERROR/.test(again.out()))).toBe(true)
    expect(await asAdmin({ ...backendAt(config.port), adminKey: config.adminKey }, 'bridge:machine', { id: made.machineId })).toMatchObject({
      id: made.machineId,
      revoked: false,
    })
  }, 420_000)

  test('a loading of this It’s own functions whose end was never learned is done again, though what was last noted as loaded is the same', async () => {
    const config = makeConfig()
    await (await start(config)).stop()
    // The functions were being loaded anew, for another port, and the service was gone before it learned how that ended
    noted({ loading: FUNCTIONS_HASH })
    said = []
    await (await start(readConfig()!)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), `backend: functions loaded (${FUNCTIONS_HASH.slice(0, 12)})`, 'backend: stopped'])
    expect(note()).toEqual({
      made: expect.any(Number),
      release: RELEASE,
      it: VERSION,
      functions: FUNCTIONS_HASH,
      functionsOf: VERSION,
      load: expect.any(String),
      port: config.port,
    })
  }, 180_000)

  test('what was left of taking a lock is cleared away by whoever comes to hold it, and nothing else beside the lock is, whatever it is called', async () => {
    const config = makeConfig()
    mkdirSync(inBackend(), { recursive: true })
    const long = new Date(Date.now() - 600_000)
    const aLock = JSON.stringify({ pid: 1, started: 'long ago', where: 'somewhere', holder: 'fedcba9876543210' })
    // What the taking of a lock leaves when it is cut short: a lock that was never given its name, and the files that say who may replace one that was left
    const its = ['lock.fedcba9876543210.tmp', 'lock.after.fedcba9876543210', 'lock.after.unread-12-34', 'lock.after.fedcba9876543210.0123456789abcdef.tmp']
    for (const name of its) writeFileSync(inBackend(name), aLock)
    // What a person may keep there: names that begin as those do, and files under those very names that hold no lock
    const theirs = ['lock.notes.tmp', 'lock.after.party.txt', 'lock.txt', 'lock.0123456789abcdef.tmp', 'lock.after.0123456789abcdef', 'lock.after.unread-56-78']
    for (const name of theirs) writeFileSync(inBackend(name), `not made by It: ${name}`)
    mkdirSync(inBackend('lock.after.aaaaaaaaaaaaaaaa'))
    writeFileSync(inBackend('lock.after.aaaaaaaaaaaaaaaa', 'kept.txt'), 'a folder of the person’s')
    for (const name of [...its, ...theirs]) utimesSync(inBackend(name), long, long)
    const beside = () => within(inBackend()).filter((file) => path.basename(file.split(' ')[0]!) !== 'lock' && file.startsWith(inBackend('lock')))
    const before = beside()
    const backend = await start(config)
    expect(beside()).toEqual(before.filter((file) => !its.some((name) => file.startsWith(`${inBackend(name)} `))))
    expect(beside()).toHaveLength(theirs.length + 2)
    await backend.stop()
    expect(beside()).toHaveLength(theirs.length + 2)
  }, 180_000)

  test('on a disk that cannot give a file a second name, nothing is made in another way: the settings are not made, no lock is taken, no program is started, and the person is told where It’s folder has to be', async () => {
    // The settings, on a first run
    const first = serve(Number(process.env.IT_PORT), undefined, 'no-links', { MAKE: '1' })
    expect(await first.ended).toBe(1)
    expect(first.lines()).toEqual(['ERROR home_unfit'])
    expect(readdirSync(folder)).toEqual([])
    // And the lock, in a folder whose settings were made where a file can be given one
    const config = makeConfig()
    const second = serve(config.port, undefined, 'no-links')
    expect(await second.ended).toBe(1)
    expect(second.lines()).toEqual(['ERROR home_unfit'])
    expect(readdirSync(folder).sort()).toEqual(['backend', 'service.json'])
    expect(readdirSync(inBackend())).toEqual([])
    expect(programsOn(folder)).toEqual([])
    expect(readConfig()).toEqual(config)
  }, 180_000)

  test('the system’s list is read in the way macOS gives it as in the way Linux does, for a folder with a space in its name, and for one reached by another name', async () => {
    const spaced = path.join(folder, 'a folder of its own')
    const linked = path.join(folder, 'another-name')
    mkdirSync(spaced)
    symlinkSync(spaced, linked)
    process.env.IT_HOME = spaced
    const config = makeConfig()
    const backend = await start(config)
    const pid = readJson<{ program: number }>(path.join(spaced, 'backend', 'lock'))!.program
    // The name the folder's settings give its backend, and the name another folder's would
    const [named, other] = [instanceName(config.instanceSecret), 'it-000000000000']
    for (const home of [spaced, linked]) {
      process.env.IT_HOME = home
      // It is known by the folder's database, whatever name the settings there now give
      for (const system of systems)
        for (const name of [named, other]) expect([home, system, name, programsHere(name, system)]).toEqual([home, system, name, [pid]])
    }
    // Another folder's programs are not this folder's
    process.env.IT_HOME = folder
    for (const system of systems) expect(programsHere(other, system)).toEqual([])
    process.env.IT_HOME = spaced
    await backend.stop()
    for (const system of systems) expect(programsHere(named, system)).toEqual([])
  }, 180_000)

  /** What is said of a program that runs under this folder's name where nothing shows that it is on this folder's database. */
  const ALIKE = (pid: number) =>
    `A backend program runs under the name this folder’s settings give its backend (pid ${pid}), and nothing It can see says that it runs on this folder’s database. A copy of this folder gives its backend the same name, so It asks the program nothing, and starts no backend program beside it.`

  test('a backend program left on a folder that has been given another name since is found by the folder it runs in, where the system shows that, and is asked to stop before another is started. Where only its command line is to be had, it is known by the name its folder’s settings give it, which a copy of the folder would give its own too: it is asked nothing, and nothing is started beside it', async () => {
    const first = path.join(folder, 'as it was called')
    const moved = path.join(folder, 'as it is called now')
    mkdirSync(first)
    process.env.IT_HOME = first
    const config = makeConfig()
    const base = Number(process.env.IT_PORT)
    // Its service is gone and the program hangs, and then the folder is given another name. A
    // program that does not hang ends by itself when its folder is called something else.
    const gone = serve(base, undefined, undefined, { IT_HOME: first })
    expect(await until(() => healthy(base))).toBe(true)
    const pid = readJson<{ program: number }>(path.join(first, 'backend', 'lock'))!.program
    gone.child.kill('SIGKILL')
    await gone.ended
    process.kill(pid, 'SIGSTOP')
    renameSync(first, moved)
    process.env.IT_HOME = moved
    const named = instanceName(config.instanceSecret)
    // As macOS gives the list, the program's command line names a database that is nowhere, and the name alone does not say whose it is
    expect(() => programsHere(named, 'darwin')).toThrow(ALIKE(pid))
    // Under another name than this folder's, nothing in a command line in one piece says it is this folder's
    expect(programsHere('it-000000000000', 'darwin')).toEqual([])
    // The lock is of no use for it either: there is none
    rmSync(path.join(moved, 'backend', 'lock'))
    process.env.IT_PORT = String(await ports.next())
    if (!proc) {
      const refused = (await startBackend(readConfig()!, say).catch((err) => err)) as Problem
      expect([refused.code, refused.message, said]).toEqual(['still_running', ALIKE(pid), []])
      return
    }
    // As Linux gives it, the program runs in this folder, whatever name its settings give and whatever its command line calls the folder
    for (const name of [named, 'it-000000000000']) expect(programsHere(name, 'linux')).toEqual([pid])
    const starting = startBackend(readConfig()!, say)
    expect(await until(() => said.includes(`backend: one left running by a service that is gone is asked to stop (pid ${pid})`))).toBe(true)
    await pause(1000)
    expect(said).toHaveLength(1)
    expect(startOf(pid)).toEqual(expect.any(String))
    // Once it has gone, the folder is free
    process.kill(pid, 'SIGCONT')
    const backend = await starting
    running.push(backend)
    expect(startOf(pid)).toBeNull()
    expect(said[1]).toMatch(/^backend: started/)
    await backend.stop()
  }, 180_000)

  test.skipIf(!proc)(
    'a backend program whose folder was given another name, with another database then put under the old name, is not taken for a program on that database: its command line still names the old place, and the system shows that it runs and has its files somewhere else',
    async () => {
      const first = path.join(folder, 'the name both have had')
      const moved = path.join(folder, 'where the first one is now')
      mkdirSync(first)
      process.env.IT_HOME = first
      const config = makeConfig()
      const base = Number(process.env.IT_PORT)
      // The program hangs, so that it does not end by itself when its folder is called something else
      const service = serve(base, undefined, undefined, { IT_HOME: first })
      expect(await until(() => healthy(base))).toBe(true)
      const pid = readJson<{ program: number }>(path.join(first, 'backend', 'lock'))!.program
      service.child.kill('SIGKILL')
      await service.ended
      process.kill(pid, 'SIGSTOP')
      renameSync(first, moved)
      // Another It is set up under the old name, with settings and a database of its own
      mkdirSync(first)
      process.env.IT_PORT = String(await ports.next())
      const other = makeConfig()
      expect(other.instanceSecret).not.toBe(config.instanceSecret)
      mkdirSync(path.join(first, 'backend'))
      for (const name of [instanceName(other.instanceSecret), instanceName(config.instanceSecret)]) expect(programsHere(name, 'linux')).toEqual([])
      // It is started, and the program of the folder that was moved is asked nothing
      const backend = await start(other)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(startOf(pid)).toEqual(expect.any(String))
      await backend.stop()
      // From the folder it runs in, it is found, and is that folder's to stop
      process.env.IT_HOME = moved
      expect(programsHere(instanceName(config.instanceSecret), 'linux')).toEqual([pid])
    },
    180_000,
  )

  test.skipIf(!proc)(
    'a backend program that has this folder’s database open from another folder, where the file has a second name, keeps a backend program from being started on it here, and is asked nothing: a database with two names is one database',
    async () => {
      const original = path.join(folder, 'original')
      const second = path.join(folder, 'second')
      mkdirSync(original)
      process.env.IT_HOME = original
      const config = makeConfig()
      const made = await start(config)
      const { machineId } = (await asAdmin(made, 'bridge:enroll', { subject: 'owner', name: 'what a person made', publicKey: KEY })) as { machineId: string }
      await made.stop()
      // The folder is copied, and in the copy the database is the original's own file under a second name
      cpSync(original, second, { recursive: true })
      rmSync(path.join(second, 'backend', 'db.sqlite3'))
      linkSync(path.join(original, 'backend', 'db.sqlite3'), path.join(second, 'backend', 'db.sqlite3'))
      said = []
      const first = await start(config)
      const pid = readJson<{ program: number }>(path.join(original, 'backend', 'lock'))!.program
      process.env.IT_HOME = second
      process.env.IT_PORT = String(await ports.next())
      const LINKED = `A backend program that runs in another folder has this folder’s database (pid ${pid}): the database has a second name there. It is not this folder’s to stop, and no backend program is started on the database beside it.`
      // Whichever way the list is read, and whatever name this folder's settings give
      for (const system of systems)
        for (const name of [instanceName(config.instanceSecret), 'it-000000000000']) expect(() => programsHere(name, system)).toThrow(LINKED)
      for (let round = 0; round < 3; round++) {
        said = []
        const refused = (await startBackend(readConfig()!, say).catch((err) => err)) as Problem
        expect([refused.code, refused.message, said]).toEqual(['still_running', LINKED, []])
        expect(existsSync(path.join(second, 'backend', 'lock'))).toBe(false)
      }
      // The original's program was asked nothing, and has what the person made
      expect(startOf(pid)).toEqual(expect.any(String))
      expect(await asAdmin(first, 'bridge:machine', { id: machineId })).toMatchObject({ id: machineId, revoked: false })
      process.env.IT_HOME = original
      await first.stop()
      // Once no program has the database, one is started on it from the second folder: a database is not refused for having two names
      process.env.IT_HOME = second
      said = []
      const there = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(await asAdmin(there, 'bridge:machine', { id: machineId })).toMatchObject({ id: machineId, revoked: false })
      await there.stop()
    },
    180_000,
  )

  test('the list `ps` gives is read with every letter of a folder’s name in it, so a backend program is known by its database in a folder whose name is not written in English letters', async () => {
    const home = path.join(folder, 'René 漢字 \u0434\u043e\u043c')
    mkdirSync(home)
    process.env.IT_HOME = home
    const backend = await start(makeConfig())
    const pid = readJson<{ program: number }>(path.join(home, 'backend', 'lock'))!.program
    // By the database alone: the name is another folder's
    for (const system of systems) expect([system, programsHere('it-000000000000', system)]).toEqual([system, [pid]])
    await backend.stop()
  }, 180_000)

  test('a backend program that runs for a copy of this folder, under the same settings, is not asked to stop: Linux shows which folder it runs in, and where only its command line is to be had nothing is started beside it', async () => {
    const original = path.join(folder, 'original')
    const copy = path.join(folder, 'copy')
    mkdirSync(original)
    process.env.IT_HOME = original
    const config = makeConfig()
    await (await start(config)).stop()
    // The folder is copied whole, with its settings and its database, and It then runs for the original
    cpSync(original, copy, { recursive: true })
    said = []
    const first = await start(config)
    const pid = readJson<{ program: number }>(path.join(original, 'backend', 'lock'))!.program
    process.env.IT_HOME = copy
    const named = instanceName(config.instanceSecret)
    expect(instanceName(readConfig()!.instanceSecret)).toBe(named)
    expect(() => programsHere(named, 'darwin')).toThrow(ALIKE(pid))
    expect(await refusal((async () => programsHere(named, 'darwin'))())).toBe('still_running')
    if (proc) {
      expect(programsHere(named, 'linux')).toEqual([])
      // On Linux the copy is started beside the original, which is not signalled and goes on answering
      process.env.IT_PORT = String(await ports.next())
      said = []
      const second = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(startOf(pid)).toEqual(expect.any(String))
      expect(await healthy(config.port)).toBe(true)
      await second.stop()
    }
    expect(startOf(pid)).toEqual(expect.any(String))
    process.env.IT_HOME = original
    await first.stop()
  }, 180_000)

  test('a lock is asked after on this machine’s own address and on no other, whatever it names, and a backend that answers there for this folder keeps another from being started', async () => {
    const config = makeConfig()
    const where = await here()
    // What stands at an address a lock may name: it counts who asks, and says whose backend it is
    let asked = 0
    let name = 'another-folder'
    const stranger = http.createServer((_req, res) => {
      asked++
      res.end(name)
    })
    await new Promise<void>((resolve) => stranger.listen(0, resolve))
    const port = (stranger.address() as net.AddressInfo).port
    /** The lock of a service that is gone, which says where its backend program was to answer. */
    const leftAt = (api: string) => {
      mkdirSync(inBackend(), { recursive: true })
      writeFileSync(inBackend('lock'), JSON.stringify({ pid: process.pid, started: 'long ago', where, holder: '0123456789abcdef', api }))
    }
    try {
      const names = [
        `http://localhost:${port}`,
        `http://127.0.0.2:${port}`,
        `http://[::1]:${port}`,
        `http://127.0.0.1:${port}/x`,
        `http://127.0.0.1:${port}@localhost:${port}`,
      ]
      for (const api of [...names, `http://127.0.0.1:${port}`]) {
        leftAt(api)
        const backend = await start(config)
        expect([api, asked]).toEqual([api, api === `http://127.0.0.1:${port}` ? 1 : 0])
        await backend.stop()
      }
      // What answers there says it is this folder's backend: the system's list did not show it, and it is there all the same
      name = instanceName(config.instanceSecret)
      leftAt(`http://127.0.0.1:${port}`)
      expect(await refusal(startBackend(config, say))).toBe('still_running')
      expect(lock()).toMatchObject({ holder: '0123456789abcdef' })
      expect(programsOn(folder)).toEqual([])
    } finally {
      await new Promise((resolve) => stranger.close(resolve))
    }
  }, 300_000)

  test('a lock from another machine is watched for as long as its holder is given to touch it: touched, it is believed, and only one left alone for the whole of that time is taken over, whatever time it says it was touched at', async () => {
    const config = makeConfig()
    mkdirSync(inBackend(), { recursive: true })
    const theirs = JSON.stringify({ pid: process.pid, started: 'on another machine', where: 'another machine', holder: 'fedcba9876543210' })
    const hour = 3_600_000
    const WATCHED = 'backend: the lock on the folder is from elsewhere, and is watched for half a minute in case its holder lives'
    // Its holder touches it, as a service that is alive does: by a clock like this machine's, by one an hour ahead, and by one an hour behind
    for (const ahead of [0, hour, -hour]) {
      writeFileSync(inBackend('lock'), theirs)
      // Each time it touches the lock, that is by a later time than the time before
      let last = 0
      const touch = () => {
        last = Math.max(last + 2000, Date.now() + ahead)
        utimesSync(inBackend('lock'), new Date(last), new Date(last))
      }
      touch()
      said = []
      const refused = refusal(startBackend(config, say))
      // It touches the lock again once the lock is being watched, however long that took to begin
      await comes(
        () => said.includes(WATCHED),
        () => said,
      )
      touch()
      expect([ahead, await refused]).toEqual([ahead, 'already_running'])
      expect(readFileSync(inBackend('lock'), 'utf8')).toBe(theirs)
    }
    // Left alone, a lock that says it was touched an hour from now is watched for as long as any other, and then it is nobody's
    const then = new Date(Date.now() + hour)
    utimesSync(inBackend('lock'), then, then)
    said = []
    const began = Date.now()
    const backend = await start(config)
    expect(Date.now() - began).toBeGreaterThan(29_000)
    expect(said[0]).toBe(WATCHED)
    expect(lock()).toMatchObject({ pid: process.pid, program: expect.any(Number) })
    await backend.stop()
  }, 300_000)

  test('of several services that find a backend program left on the folder in the same instant, one asks it to stop and starts its own, and the others give up', async () => {
    makeConfig()
    const left = await orphan()
    const all = await atOnce(4)
    const holder = await oneHolds(all)
    expect(startOf(left)).toBeNull()
    // The program that was left was asked once, by the one service that then took the folder
    expect(all.flatMap((one) => one.lines()).filter((line) => line.includes('is asked to stop'))).toEqual([
      `backend: one left running by a service that is gone is asked to stop (pid ${left})`,
    ])
    expect(holder.lines()[0]).toContain('is asked to stop')
  }, 300_000)

  test('of several services that find the lock of a service that is gone in the same instant, one takes it and the others give up', async () => {
    makeConfig()
    await (await start(readConfig()!)).stop()
    for (let round = 0; round < 3; round++) {
      // A service that was killed with its backend program: the lock is left, and names nothing that runs
      const first = serve(Number(process.env.IT_PORT))
      expect(await until(() => first.out().includes('READY'))).toBe(true)
      const { program: left } = lock()!
      first.child.kill('SIGKILL')
      process.kill(left!, 'SIGKILL')
      await first.ended
      expect(await until(() => startOf(left!) === null)).toBe(true)
      const holder = await oneHolds(await atOnce(4))
      holder.child.kill('SIGTERM')
      expect(await holder.ended).toBe(0)
      expect(existsSync(inBackend('lock'))).toBe(false)
    }
  }, 420_000)

  /** Where such programs leave their numbers, where they write down what they did, and what they have written there so far. */
  const contended = () => {
    const [mark, tally] = [path.join(folder, 'inside'), path.join(folder, 'tally')]
    if (!existsSync(tally)) writeFileSync(tally, '')
    const wrote = (what: string) =>
      readFileSync(tally, 'utf8')
        .split('\n')
        .filter((line) => line !== '' && line.startsWith(what))
    return { mark, tally, wrote }
  }
  /** One such program, started with what it is given after the two files, and when it has ended. */
  const contends = (...given: string[]) => {
    const { mark, tally } = contended()
    const child = spawn(process.execPath, [contender, mark, tally, ...given], { env: { PATH: process.env.PATH, IT_HOME: folder }, stdio: 'ignore' })
    children.push(child)
    return { child, ended: new Promise<void>((resolve) => child.once('exit', () => resolve())) }
  }

  test('a lock of the folder is held by one program at a time, through hundreds of turns and through holders that are gone without letting go', async () => {
    const { wrote } = contended()
    // Three hundred turns between eight of them, and at every thirtieth the one that has the lock is gone while it holds it
    const [most, each] = [300, 30]
    const go = path.join(folder, 'go')
    let started = 0
    // One takes the place of each that is gone, for as long as there are turns to be had. Were more of them to end than are to be gone, none is started in their place.
    const one = (): Promise<void> => {
      started++
      const { child, ended } = contends(go, String(most), String(each))
      first.push(child)
      return ended.then(() => (wrote('turn ').length < most && started < 8 + 2 * (most / each) ? one() : undefined))
    }
    const first: ChildProcess[] = []
    const all = Array.from({ length: 8 }, one)
    await letGo(go, first.slice(0, 8))
    await Promise.all(all)
    expect(wrote('two')).toEqual([])
    expect(wrote('failed')).toEqual([])
    // Every turn was had, by one program at a time, and each holder that was gone had the lock taken from it by another
    expect(wrote('turn ')).toHaveLength(most)
    expect(wrote('gone ')).toHaveLength(most / each)
    // The last of them was gone while it held the lock too, and the others took it from it and let it go
    expect(existsSync(path.join(folder, 'stress.lock'))).toBe(false)
  }, 300_000)

  test('a lock that was left is taken by one program, though eight find it left in the same instant, time after time', async () => {
    const { wrote } = contended()
    const held = () => readJson<{ pid: number }>(path.join(folder, 'stress.lock'))?.pid
    /** Lets so many of them go at the lock in the same instant, tells the one that took it that the others are done once they are, and gives what each of them wrote down. */
    const round = async (count: number, nth: number) => {
      const before = wrote('').length
      const go = path.join(folder, `go-${nth}`)
      const all = Array.from({ length: count }, () => contends(go))
      let over = 0
      for (const one of all) void one.ended.then(() => over++)
      await letGo(
        go,
        all.map((one) => one.child),
      )
      // All but one give up, and the one that has the lock has it for as long as that takes
      await comes(
        () => over >= count - 1 || wrote('two').length > 0,
        () => ({ over, wrote: wrote('').slice(before) }),
      )
      writeFileSync(`${go}.over`, '')
      await Promise.all(all.map((one) => one.ended))
      return wrote('').slice(before)
    }
    // A lock that nobody has is taken by a program that is gone while it holds it
    const [took] = (await round(1, 0)).map((line) => Number(line.split(' ')[1]))
    expect([wrote(''), held(), startOf(took!)]).toEqual([[`turn ${took}`, `gone ${took}`], took, null])
    for (let nth = 1; nth <= 8; nth++) {
      const left = held()
      const lines = await round(8, nth)
      // One of the eight took the lock that was left, and was gone in its turn. The seven others found it taken, and gave up.
      const [turn, ...more] = lines.filter((line) => line.startsWith('turn '))
      const winner = Number(turn?.split(' ')[1])
      expect([nth, more, lines.filter((line) => line.startsWith('gone ')), lines.filter((line) => line.startsWith('gave up ')).length]).toEqual([
        nth,
        [],
        [`gone ${winner}`],
        7,
      ])
      expect(lines).toHaveLength(9)
      // The lock is now that of the one that took it, which has left it as the one before had
      expect([held() !== left, held(), startOf(winner)]).toEqual([true, winner, null])
    }
    expect(wrote('two')).toEqual([])
    expect(wrote('turn ')).toHaveLength(9)
    expect(wrote('gone ')).toHaveLength(9)
  }, 300_000)
})

describe.skipIf(!program || windows)('enrolling this machine', () => {
  /**
   * Starts the backend on ports of its own, and puts where a setup looks for it something that
   * passes every request on, keeping the machine each enrolment was answered with. `lose` says
   * which of those answers are lost on their way back.
   */
  const watched = async (lose: (nth: number) => boolean = () => false) => {
    const config = makeConfig()
    const backend = await start(config)
    const shown = await ports.next()
    const answered: string[] = []
    const ways = [
      await between(shown + PORTS.backendApi, config.port + PORTS.backendApi, (asked, body, answer) => {
        if (asked !== '/api/function' || (JSON.parse(body) as { path?: string }).path !== 'bridge:enroll') return false
        const made = (JSON.parse(answer) as { value?: { machineId?: string } }).value?.machineId
        if (made) answered.push(made)
        return lose(answered.length)
      }),
      await between(shown + PORTS.backendSite, config.port + PORTS.backendSite),
    ]
    process.env.IT_PORT = String(shown)
    return { backend, answered, close: () => Promise.all(ways.map((way) => way.close())) }
  }

  test('is done once when two setups run at the same moment: one key is kept, and it is the key of the one machine that was made', async () => {
    const { backend, answered, close } = await watched()
    try {
      const both = await Promise.all([begin({ background: false, say: () => {}, name: 'one' }), begin({ background: false, say: () => {}, name: 'two' })])
      expect(both.map((begun) => begun.enrolled).sort()).toEqual([false, true])
      expect(answered).toHaveLength(1)
      const machine = readJson<Machine>(machineFile())!
      expect(machine.id).toBe(answered[0])
      // The key that is kept is the key the backend has for that machine
      expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: machine.key.x, y: machine.key.y }, revoked: false })
      expect(readdirSync(folder).sort()).toEqual(['backend', 'machine.json', 'service.json'])
    } finally {
      await close()
    }
  }, 180_000)

  test('a first setup begins nothing where the ports It would use are taken: it says by what, names a first port that is free, writes no settings, and goes through once they are free', async () => {
    const port = Number(process.env.IT_PORT)
    const listening = async (at: number, answer: string) => {
      const server = http.createServer((_asked, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(answer))
      await new Promise<void>((resolve) => server.listen(at, '127.0.0.1', resolve))
      return () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    }
    const refused = async () => (await begin({ background: false, say: () => {}, name: 'the desk' }).catch((err) => err)) as Problem
    const HINT =
      /^Nothing was set up\. Give this It ports of its own by naming another first port: `IT_PORT=(\d+) it setup`\. The port is written into its settings, so it is named this once\.$/
    // Another program has one of the backend program's two
    let close = await listening(port + PORTS.backendApi, '{}')
    try {
      const said = await refused()
      expect([said.code, said.message]).toEqual([
        'port_taken',
        `Port ${port + PORTS.backendApi} is in use on this machine, and It would use it: it counts its ports from ${port}.`,
      ])
      // The first port it names is one It could count from, and none of the four from it is taken
      const offered = Number(HINT.exec(said.hint ?? '')?.[1])
      expect(offered).toBeGreaterThan(port)
      expect(offered % 100).toBe(port % 100)
    } finally {
      await close()
    }
    // Another It has them: its site says that it is It, and its backend answers as this one's would
    const closeBackend = await listening(port + PORTS.backendSite, '{"ok":true}')
    close = await listening(port, '{"ok":true,"it":true}')
    try {
      const said = await refused()
      expect([said.code, said.message]).toEqual([
        'port_taken',
        `Another It is already running on this machine at port ${port}, which this one would use too: another person’s here, or one set up in another folder.`,
      ])
      expect(said.hint).toMatch(HINT)
    } finally {
      await close()
      await closeBackend()
    }
    // Neither time was anything written that would hold this It to those ports, or any key made
    expect(readdirSync(folder).filter((name) => name !== 'backend')).toEqual([])
    // With the ports free, the same setup goes through
    const begun = await begin({ background: false, say: () => {}, name: 'the desk' })
    expect([begun.enrolled, begun.own]).toEqual([true, true])
    await begun.done()
  }, 180_000)

  test('two setups that both find nothing running start one backend between them, and enrol one machine', async () => {
    const both = await Promise.all([begin({ background: false, say: () => {}, name: 'one' }), begin({ background: false, say: () => {}, name: 'two' })])
    expect(both.map((begun) => begun.own).sort()).toEqual([false, true])
    expect(both.map((begun) => begun.enrolled).sort()).toEqual([false, true])
    expect(programsOn(folder)).toHaveLength(1)
    // The one machine that was made is the one whose key is kept
    const machine = readJson<Machine>(machineFile())!
    const backend = { ...backendAt(Number(process.env.IT_PORT)), adminKey: readConfig()!.adminKey }
    expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: machine.key.x, y: machine.key.y }, revoked: false })
    for (const begun of both) await begun.done()
    expect(programsOn(folder)).toEqual([])
  }, 180_000)

  test('keeps its key before the backend is asked, and when the answer is lost asks again with the same key and comes to hold the machine that was made', async () => {
    const { backend, answered, close } = await watched((nth) => nth === 1)
    try {
      await expect(begin({ background: false, say: () => {}, name: 'the desk' })).rejects.toThrow()
      // The backend made a machine, and this one never heard: the key is kept for the next time
      expect(answered).toHaveLength(1)
      expect(existsSync(machineFile())).toBe(false)
      const kept = JSON.parse(readFileSync(path.join(folder, 'machine.pending.json'), 'utf8')) as { name: string; key: { d: string; x: string } }[]
      expect(kept).toEqual([{ name: 'the desk', key: expect.objectContaining({ kty: 'EC', d: expect.any(String) }) }])
      const pending = kept[0]!
      if (!windows) expect(statSync(path.join(folder, 'machine.pending.json')).mode & 0o777).toBe(0o600)
      const again = await begin({ background: false, say: () => {}, name: 'another name' })
      expect(again.enrolled).toBe(true)
      expect(answered).toEqual([answered[0], answered[0]])
      const machine = readJson<Machine>(machineFile())!
      expect(machine).toMatchObject({ id: answered[0], name: 'the desk', key: { d: pending.key.d } })
      expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: pending.key.x }, revoked: false })
      expect(existsSync(path.join(folder, 'machine.pending.json'))).toBe(false)
    } finally {
      await close()
    }
  }, 180_000)

  test('is not done with a key that was kept for joining an It on another machine, and that key is left where it is kept', async () => {
    const backend = await start(makeConfig())
    const elsewhere = { name: 'kept for something else', at: 'http://127.0.0.1:9', key: { ...KEY, d: 'bm90IGEga2V5' } }
    writePending(path.join(folder, 'machine.pending.json'), [elsewhere])
    expect((await begin({ background: false, say: () => {}, name: 'the desk' })).enrolled).toBe(true)
    const machine = readJson<Machine>(machineFile())!
    expect(machine.name).toBe('the desk')
    expect(machine.key.x).not.toBe(KEY.x)
    expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: machine.key.x }, revoked: false })
    // The joining of that other It is not settled by anything done here
    expect(JSON.parse(readFileSync(path.join(folder, 'machine.pending.json'), 'utf8'))).toEqual([elsewhere])
  }, 180_000)

  test('a key that this machine has since kept as its own is let go by the next setup, and every other key that is waiting stays', async () => {
    await start(makeConfig())
    expect((await begin({ background: false, say: () => {}, name: 'the desk' })).enrolled).toBe(true)
    const machine = readJson<Machine>(machineFile())!
    // Setup was ended between keeping the machine and letting go of the key it had asked with
    const elsewhere = { name: 'kept for something else', at: 'http://127.0.0.1:9', key: { ...KEY, d: 'bm90IGEga2V5' } }
    const another = { name: 'asked for here, and never heard of', replaces: 'an identity this machine once had', key: { ...KEY, d: 'YW5vdGhlciBrZXk' } }
    writePending(path.join(folder, 'machine.pending.json'), [{ name: 'the desk', key: machine.key }, elsewhere, another])
    expect((await begin({ background: false, say: () => {} })).enrolled).toBe(false)
    expect(JSON.parse(readFileSync(path.join(folder, 'machine.pending.json'), 'utf8'))).toEqual([elsewhere, another])
    expect(readJson<Machine>(machineFile())).toEqual(machine)
  }, 180_000)

  test('keys that are not as It wrote them are not written over: setup stops, says so, and leaves the file as it is', async () => {
    await start(makeConfig())
    // It writes a list of keys and nothing else, so a key that stands in the file by itself is not one of its own
    const alone = JSON.stringify({ name: 'the desk', key: { ...KEY, d: 'bm90IGEga2V5' } })
    for (const held of ['{ "name": "the desk", "key": ', JSON.stringify([{ name: 'the desk' }]), JSON.stringify('a key'), alone]) {
      writeFileSync(path.join(folder, 'machine.pending.json'), held)
      const refused = (await begin({ background: false, say: () => {}, name: 'the desk' }).catch((err) => err)) as Problem
      expect([refused.code, refused.message]).toEqual([
        'record_unread',
        `The keys this machine has asked to be enrolled with, in ${path.join(folder, 'machine.pending.json')}, are not as It wrote them.`,
      ])
      expect(readFileSync(path.join(folder, 'machine.pending.json'), 'utf8')).toBe(held)
      expect(existsSync(machineFile())).toBe(false)
    }
    expect(programsOn(folder)).toHaveLength(1)
    // A setup that has no use for a key, on a machine that is enrolled, goes on past them and leaves them as they are
    rmSync(path.join(folder, 'machine.pending.json'))
    expect((await begin({ background: false, say: () => {}, name: 'the desk' })).enrolled).toBe(true)
    writeFileSync(path.join(folder, 'machine.pending.json'), 'not as It wrote them')
    expect((await begin({ background: false, say: () => {}, name: 'the desk' })).enrolled).toBe(false)
    expect(readFileSync(path.join(folder, 'machine.pending.json'), 'utf8')).toBe('not as It wrote them')
  }, 180_000)

  test('an identity that is there and cannot be read is not taken for none: setup enrols no machine over it, says which file it is, and leaves the file as it is', async () => {
    const config = makeConfig()
    await start(config)
    for (const held of ['', '{ "id": ', '[]', JSON.stringify({ id: 'a machine with no key' })]) {
      writeFileSync(machineFile(), held)
      const refused = (await begin({ background: false, say: () => {}, name: 'the desk' }).catch((err) => err)) as Problem
      expect([held, refused.code, refused.message]).toEqual([held, 'record_unread', `This machine’s identity, in ${machineFile()}, is not as It wrote it.`])
      expect(refused.hint).toBe(
        'It holds the key this machine is known by, so It does not enrol the machine anew over it. Put the file back as it was, or move it away to have this machine enrolled again.',
      )
      expect(readFileSync(machineFile(), 'utf8')).toBe(held)
      expect(existsSync(path.join(folder, 'machine.pending.json'))).toBe(false)
    }
    // Moved away, as the person was told they may, it is in the way of nothing
    rmSync(machineFile())
    expect((await begin({ background: false, say: () => {}, name: 'the desk' })).enrolled).toBe(true)
    expect(readJson<Machine>(machineFile())).toMatchObject({ name: 'the desk' })
  }, 180_000)

  test('removes the token that was kept for the identity this machine had before', async () => {
    await start(makeConfig())
    const token = path.join(folder, 'token.json')
    writeFileSync(token, JSON.stringify({ token: 'of the machine this was', exp: Date.now() / 1000 + 300, machine: 'an earlier machine', site: 'here' }))
    expect((await begin({ background: false, say: () => {} })).enrolled).toBe(true)
    expect(existsSync(token)).toBe(false)
    // One kept for the machine it is, is left where it is by a setup that enrols nothing
    writeFileSync(token, '{}')
    expect((await begin({ background: false, say: () => {} })).enrolled).toBe(false)
    expect(existsSync(token)).toBe(true)
  }, 180_000)

  test('says where the backend program is fetched from, and that a newer It fetches a newer one', async () => {
    // No program is on the machine, and the release cannot be reached: nothing is asked of any remote here
    delete process.env.IT_BACKEND_BIN
    const real = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = async (input) => {
      asked.push(String(input))
      throw new TypeError('fetch failed')
    }
    try {
      const heard: string[] = []
      const refused = await begin({ background: false, say: (line) => void heard.push(line) }).catch((err) => err as { code: string; hint: string })
      expect(heard).toEqual([
        'Fetching the backend program that It runs on this machine, from its release on GitHub. It is about 60 MB. It is fetched the first time It is set up, and again when a newer It runs a newer one.',
      ])
      expect(refused).toMatchObject({
        code: 'offline',
        hint: 'It is fetched from its release on GitHub, the first time It is set up and again when a newer It runs a newer one. Check that this machine is online, then try again.',
      })
      expect(asked).toEqual([expect.stringContaining(`/releases/download/${RELEASE}/`)])
    } finally {
      globalThis.fetch = real
    }
    // Where a program is named to be used as it is, nothing is fetched, and nothing is said of fetching
    process.env.IT_BACKEND_BIN = path.join(scratch, 'no-such-program')
    const heard: string[] = []
    expect(await refusal(begin({ background: false, say: (line) => void heard.push(line) }))).toBe('backend_program')
    expect(heard).toEqual([])
  })
})

describe.skipIf(!program || windows)('joining an It from another machine', () => {
  /** The folder of the machine that joins, which is told nothing of the It it joins but its address. */
  let other: string
  /**
   * The door of the It that is joined, in the test's own folder. The machine that joins reaches
   * it at `at`, through something that passes every request on to it, as the network between
   * the two would. The machines that enrolments were answered with are kept, and with `lose`
   * set, the answer to the first of them is lost on its way back.
   */
  let door: { stop(): Promise<void> }
  let way: { close(): Promise<void> }
  let at: string
  let backend: Running
  let answered: string[]
  let lose: boolean
  beforeEach(async () => {
    const config = makeConfig()
    backend = await start(config)
    await begin({ background: false, say: () => {}, name: 'the desk' })
    door = await startDoor(config, backend, () => {})
    const shown = await ports.next()
    answered = []
    lose = false
    way = await between(shown, config.port, (asked, _body, answer) => {
      if (asked !== '/bridge/enroll') return false
      const made = (JSON.parse(answer) as { machine?: string }).machine
      if (made) answered.push(made)
      const lost = lose && made !== undefined
      if (lost) lose = false
      return lost
    })
    at = `http://127.0.0.1:${shown}`
    other = mkdtempSync(path.join(os.tmpdir(), 'it-joining-'))
  }, HOOK_MS)
  afterEach(async () => {
    process.env.IT_HOME = folder
    await way.close()
    await door.stop()
    rmSync(other, { recursive: true, force: true })
  }, HOOK_MS)
  /** An invite for one machine, asked for by the machine It runs on. What follows is run in the folder of the machine that joins. */
  const invite = async () => {
    process.env.IT_HOME = folder
    const made = await call<{ code: string }>('mutation', api.sessions.inviteMachine)
    process.env.IT_HOME = other
    return made.code
  }
  const pending = () => path.join(other, 'machine.pending.json')

  test('keeps its key before the It is asked, and when the answer is lost asks again with the same key and comes to hold the machine that was made', async () => {
    const code = await invite()
    lose = true
    expect(await refusal(login({ url: at, code, name: 'the laptop' }))).toBe('offline')
    // The It made a machine, and this one never heard: the key is kept for the next time, with where it was asked
    expect(answered).toHaveLength(1)
    expect(existsSync(path.join(other, 'machine.json'))).toBe(false)
    const all = JSON.parse(readFileSync(pending(), 'utf8')) as { name: string; at: string; key: { d: string; x: string } }[]
    expect(all).toEqual([{ name: 'the laptop', at, key: expect.objectContaining({ kty: 'EC', d: expect.any(String) }) }])
    const kept = all[0]!
    if (!windows) expect(statSync(pending()).mode & 0o777).toBe(0o600)
    expect(readdirSync(other)).toEqual(['machine.pending.json'])
    // The same command again, as the person would run it: the same invite, which is spent, with the same key
    expect(await login({ url: at, code, name: 'another name' })).toEqual({ machine: answered[0], name: 'the laptop' })
    expect(answered).toEqual([answered[0], answered[0]])
    const machine = readJson<Machine>(path.join(other, 'machine.json'))!
    expect(machine).toMatchObject({ id: answered[0], name: 'the laptop', at, issuer: backend.site, key: { d: kept.key.d } })
    expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: kept.key.x }, revoked: false })
    expect(readdirSync(other)).toEqual(['machine.json'])
    // And the key is one the It believes: this machine is given a token for it
    expect(await call('query', api.machines.me)).toMatchObject({ id: machine.id, name: 'the laptop' })
  }, 180_000)

  test('asks with the key it kept under a new invite as well, when the first has run out or been used, and is the machine that was made the first time', async () => {
    const first = await invite()
    lose = true
    expect(await refusal(login({ url: at, code: first }))).toBe('offline')
    // An invite that is wrong is refused, and the key stays where it is kept
    expect(await refusal(login({ url: at, code: 'aaaaaaaaaaaaaaaaaaaa' }))).toBe('unauthenticated')
    expect(existsSync(pending())).toBe(true)
    const second = await invite()
    expect((await login({ url: at, code: second })).machine).toBe(answered[0])
    expect(new Set(answered).size).toBe(1)
    expect(readdirSync(other)).toEqual(['machine.json'])
  }, 180_000)

  test('is done once when two are run at the same moment: one joins, the other finds that this machine has joined and spends no invite, and the key that is kept is the key of the machine that was made', async () => {
    const codes = [await invite(), await invite()]
    const both = await Promise.all(codes.map((code, n) => login({ url: at, code, name: `machine ${n}` }).catch((err) => err as Problem)))
    const joined = both.filter((one): one is { machine: string; name: string } => 'machine' in one)
    expect(joined).toHaveLength(1)
    expect(both.filter((one) => !('machine' in one)).map((one) => [(one as Problem).code, (one as Problem).message])).toEqual([
      ['invalid', 'This machine has already joined an It.'],
    ])
    const machine = readJson<Machine>(path.join(other, 'machine.json'))!
    expect(machine.id).toBe(joined[0]!.machine)
    expect(await asAdmin(backend, 'bridge:machine', { id: machine.id })).toMatchObject({ publicKey: { x: machine.key.x, y: machine.key.y }, revoked: false })
    expect(readdirSync(other)).toEqual(['machine.json'])
    // The invite the other was given is still good: no machine was made that nobody holds the key of
    const spare = mkdtempSync(path.join(os.tmpdir(), 'it-joining-'))
    try {
      process.env.IT_HOME = spare
      const again = await Promise.all(codes.map((code) => login({ url: at, code }).catch((err) => err as Problem)))
      expect(again.filter((one) => 'machine' in one)).toHaveLength(1)
    } finally {
      rmSync(spare, { recursive: true, force: true })
    }
  }, 180_000)

  test('an address that is not plain http is refused before anything is asked or kept', async () => {
    const code = await invite()
    for (const url of ['https://it.home.example', 'ftp://127.0.0.1', `${at}/pair`, 'not an address']) {
      expect([url, await refusal(login({ url, code }))]).toEqual([url, 'invalid'])
      expect(readdirSync(other)).toEqual([])
    }
    expect(answered).toEqual([])
  }, 180_000)

  test('a key kept for joining another It, or for enrolling on this machine, is not the key to ask with, and is left where it is kept', async () => {
    // A key this folder kept while it asked an It somewhere else, and one kept by a first run that was begun here
    for (const kept of [{ at: 'http://127.0.0.1:9' }, {}]) {
      const code = await invite()
      rmSync(path.join(other, 'machine.json'), { force: true })
      const waiting = { name: 'kept for something else', key: { ...KEY, d: 'bm90IGEga2V5' }, ...kept }
      writePending(pending(), [waiting])
      const done = await login({ url: at, code, name: 'the laptop' })
      const machine = readJson<Machine>(path.join(other, 'machine.json'))!
      expect(machine).toMatchObject({ id: done.machine, name: 'the laptop' })
      expect(machine.key.x).not.toBe(KEY.x)
      expect(readdirSync(other).sort()).toEqual(['machine.json', 'machine.pending.json'])
      expect(JSON.parse(readFileSync(pending(), 'utf8'))).toEqual([waiting])
    }
  }, 180_000)

  test('the key to a joining that was never settled is kept through an attempt to join another It and through the joining of one, and is the key the first It knows this machine by when it is asked again', async () => {
    // The first It made a machine for this one, and this one never heard
    lose = true
    expect(await refusal(login({ url: at, code: await invite(), name: 'the laptop' }))).toBe('offline')
    const [first] = JSON.parse(readFileSync(pending(), 'utf8')) as { name: string; at: string; key: { d: string; x: string } }[]
    expect(await asAdmin(backend, 'bridge:machine', { id: answered[0] })).toMatchObject({ publicKey: { x: first!.key.x }, revoked: false })
    // Another It, at an address of its own. It refuses an invite it does not know, and takes the one it made.
    const asked: { code: string; x: string }[] = []
    const another = http.createServer((req, res) => {
      const pieces: Buffer[] = []
      req.on('data', (piece: Buffer) => pieces.push(piece))
      req.on('end', () => {
        const answer = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (req.url === '/cli/config') return answer(200, { issuer: 'http://127.0.0.1:9' })
        const sent = JSON.parse(Buffer.concat(pieces).toString()) as { code: string; publicKey: { x: string } }
        asked.push({ code: sent.code, x: sent.publicKey.x })
        return sent.code === 'the invite it made' ? answer(200, { machine: 'a machine of the other It' }) : answer(401, { error: 'unauthenticated' })
      })
    })
    await new Promise<void>((resolve) => another.listen(0, '127.0.0.1', resolve))
    const there = `http://127.0.0.1:${(another.address() as net.AddressInfo).port}`
    try {
      // Refused there, with a key of its own: the key kept for the first It is as it was
      expect(await refusal(login({ url: there, code: 'an invite it does not know' }))).toBe('unauthenticated')
      let kept = JSON.parse(readFileSync(pending(), 'utf8')) as { at: string; key: { d: string; x: string } }[]
      expect(kept.map((one) => one.at)).toEqual([at, there])
      expect(kept[0]).toEqual(first)
      expect(asked.map((one) => one.x)).toEqual([kept[1]!.key.x])
      expect(kept[1]!.key.x).not.toBe(first!.key.x)
      // Joined there, with that same key of its own: that joining is settled, and the first one is not
      expect(await login({ url: there, code: 'the invite it made' })).toMatchObject({ machine: 'a machine of the other It' })
      expect(asked.map((one) => one.x)).toEqual([kept[1]!.key.x, kept[1]!.key.x])
      kept = JSON.parse(readFileSync(pending(), 'utf8'))
      expect(kept).toEqual([first])
      expect(readJson<Machine>(path.join(other, 'machine.json'))).toMatchObject({ id: 'a machine of the other It', at: there })
    } finally {
      await new Promise((resolve) => another.close(resolve))
    }
    // Having left the other It, this machine asks the first again, under a new invite, and is the machine that was made for it the first time
    rmSync(path.join(other, 'machine.json'))
    expect(await login({ url: at, code: await invite() })).toEqual({ machine: answered[0], name: 'the laptop' })
    expect(readJson<Machine>(path.join(other, 'machine.json'))).toMatchObject({ id: answered[0], at, key: { d: first!.key.d } })
    expect(readdirSync(other)).toEqual(['machine.json'])
    expect(await call('query', api.machines.me)).toMatchObject({ id: answered[0], name: 'the laptop' })
  }, 180_000)
})

describe.skipIf(!program || windows)('a newer backend program, and newer functions', () => {
  /** A folder with a database in it that holds what a person made, and the backend stopped. */
  const peopled = async () => {
    const config = makeConfig()
    const backend = await start(config)
    const made = (await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'what a person made', publicKey: KEY })) as { machineId: string }
    await backend.stop()
    said = []
    return { config: readConfig()!, id: made.machineId, bytes: readFileSync(database()) }
  }
  test('before a program of another release than the one that last ran is started on the database, a whole copy of it is kept beside it', async () => {
    const { config, id, bytes } = await peopled()
    expect(copies()).toEqual([])
    noted({ release: 'precompiled-2026-01-15-0000000', it: '0.0.9' })
    const earlier = readFileSync(inBackend('data.json'))
    const backend = await start(config)
    expect(said).toEqual([COPIED, expect.stringMatching(/^backend: started/)])
    expect(copies()).toEqual([`before-${RELEASE}`])
    // The database as it was, the files the backend keeps for it, and what was noted of it
    expect(readFileSync(inBackend(`before-${RELEASE}`, 'db.sqlite3')).equals(bytes)).toBe(true)
    expect(readFileSync(inBackend(`before-${RELEASE}`, 'data.json')).equals(earlier)).toBe(true)
    expect(existsSync(inBackend(`before-${RELEASE}`, 'storage'))).toBe(true)
    if (!windows) expect(statSync(inBackend(`before-${RELEASE}`)).mode & 0o777).toBe(0o700)
    expect(note()).toMatchObject({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH })
    expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    await backend.stop()
    // The same release the next time, and nothing more is copied
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
  }, 180_000)

  test('an It older than the one whose functions are in the database, or one whose backend program is older than the one that last ran on it, is not started on it, and the person is told which It is needed', async () => {
    const { config, bytes } = await peopled()
    const sameDay = RELEASE.replace(/[0-9a-f]+$/, 'fffffff')
    expect(sameDay).not.toBe(RELEASE)
    const next = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1))
    // What is noted of the database, and what the person is then told
    const refused: [Record<string, unknown>, RegExp][] = [
      // The functions of a newer It, with the very same backend program
      [
        { it: '9.9.9', functionsOf: '9.9.9' },
        /has the functions of It 9\.9\.9 in it, which is newer than this It \S+\. An older It is not started on it\. Install It 9\.9\.9 or a newer one\./,
      ],
      // A newer It with a newer backend program
      [
        { release: 'precompiled-2027-03-01-fffffff', it: '9.9.9', functionsOf: '9.9.9' },
        /has the functions of It 9\.9\.9 in it, which is newer than this It \S+\. .* Install It 9\.9\.9 or a newer one\./,
      ],
      // The very next version
      [{ it: next, functionsOf: next }, /An older It is not started on it\./],
      // A newer It that began to load its functions, and of whose loading the end was never learned
      [
        { it: next, loading: 'the functions of the next version' },
        new RegExp(
          `^It ${next.replaceAll('.', '\\.')} began to load its functions into what It keeps in .*, and how that ended was never learned\\. It is newer than this It`,
        ),
      ],
      [{ unsettled: { it: next, functions: ['the functions of the next version'] } }, /and how that ended was never learned\. It is newer than this It/],
      // A version that is not written as It writes them cannot be told to be older
      [
        { it: 'the next one', functionsOf: 'the next one' },
        /has the functions of It the next one in it, which cannot be told to be older than this It \S+\. An older It is not started on it\./,
      ],
      // A newer backend program, whichever It ran it
      [
        { release: 'precompiled-2027-03-01-fffffff' },
        /was last run by It \S+, with a backend program that is newer than the one this It \S+ runs\. An older program is not started on it\. Install the newest It\./,
      ],
      [{ release: 'precompiled-2027-03-01-fffffff', it: undefined }, /was last run by another It, with a backend program that is newer/],
      // Another build of the backend program from the same day, run by this same It or by nobody that is known: which is the newer cannot be told
      [{ release: sameDay }, /with a backend program that cannot be told to be older than the one this It \S+ runs\. An older program is not started on it\./],
      [{ release: sameDay, it: undefined }, /with a backend program that cannot be told to be older/],
      [{ release: 'a build with no day in its name' }, /with a backend program that cannot be told to be older/],
      // And one run by a newer It, which served with the functions this It's version came with: its program ran all the same
      [
        { release: sameDay, it: next },
        new RegExp(
          `was last run by It ${next.replaceAll('.', '\\.')}, with a backend program that cannot be told to be older .* Install It ${next.replaceAll('.', '\\.')} or a newer one\\.`,
        ),
      ],
    ]
    const whole = note()
    for (const [change, told] of refused) {
      writeFileSync(inBackend('data.json'), JSON.stringify({ ...whole, ...change }))
      const noted = readFileSync(inBackend('data.json'))
      said = []
      const err = (await startBackend(config, say).catch((err) => err)) as Problem
      expect([change, err.code]).toEqual([change, 'backend_older'])
      expect(`${err.message} ${err.hint}`).toMatch(told)
      expect(err.hint).toContain(
        'A copy of the database from before that It changed it, if it made one, is in a folder there whose name begins with "before-".',
      )
      // Nothing was started, nothing copied, and nothing noted
      expect(said).toEqual([])
      expect(readFileSync(database()).equals(bytes)).toBe(true)
      expect(readFileSync(inBackend('data.json')).equals(noted)).toBe(true)
      expect(copies()).toEqual([])
      expect(existsSync(inBackend('lock'))).toBe(false)
      expect(programsOn(folder)).toEqual([])
    }
  }, 180_000)

  test('an It newer than the one that last ran is started on the database, after a copy where its backend program is another, and notes itself as the one that last ran and the one whose functions are in it', async () => {
    const { config, id } = await peopled()
    const sameDay = RELEASE.replace(/[0-9a-f]+$/, 'fffffff')
    // An older It, or one made before this release, with the same backend program: nothing in the database changes, and nothing is copied
    for (const it of ['0.0.9', `${VERSION}-rc.1`]) {
      noted({ it, functionsOf: it })
      said = []
      const backend = await start(config)
      expect([it, said]).toEqual([it, [expect.stringMatching(/^backend: started/)]])
      expect(note()).toMatchObject({ release: RELEASE, it: VERSION, functionsOf: VERSION })
      await backend.stop()
    }
    expect(copies()).toEqual([])
    // A newer It that ran on it with the functions this version came with, its own having been refused: this version is started on it again
    noted({ it: '9.9.9', functionsOf: VERSION, behind: { functions: 'the functions of that It', why: 'refused', at: Date.now() } })
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
    expect(note()).toMatchObject({ release: RELEASE, it: VERSION, functionsOf: VERSION })
    expect(note()).not.toHaveProperty('behind')
    // An older It whose backend program was another build of the same day: this It is the newer, so its program is, and a copy is kept first
    noted({ release: sameDay, it: '0.0.9' })
    said = []
    const backend = await start(config)
    expect(said).toEqual([COPIED, expect.stringMatching(/^backend: started/)])
    expect(copies()).toEqual([`before-${RELEASE}`])
    expect(note()).toMatchObject({ release: RELEASE, it: VERSION })
    expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    await backend.stop()
  }, 180_000)

  test('every copy kept from before a change is removed when the person has erased everything, and the database itself is left', async () => {
    const { bytes } = await peopled()
    for (const name of [
      'before-functions-000000000000',
      'before-precompiled-2026-01-15-0000000',
      'before-precompiled-2026-01-15-0000000-functions-222222222222',
    ])
      copied(name)
    // What was left of a copy that was being made, and of one that was making way for another, is removed with the rest, and is not counted as a copy
    copied('before-functions-111111111111', 0, '.0123456789abcdef.part')
    copied('before-functions-000000000000', 0, '.0123456789abcdef.old')
    expect(removeCopies()).toBe(3)
    expect(readdirSync(inBackend()).filter((name) => name.startsWith('before-'))).toEqual([])
    expect(readFileSync(database()).equals(bytes)).toBe(true)
    // Asked again, as it is when the backend repeats what it said, it finds nothing to remove
    expect(removeCopies()).toBe(0)
  }, 180_000)

  /**
   * Tells of an erasing as a service does that was started for the purpose: whatever is
   * remembered of an earlier telling, it is not remembered by this program.
   */
  const erased = async (person: string) => {
    if (!existsSync(path.join(scratch, 'erasing.mjs')))
      await bundled('erasing.mjs', "import { removeCopies } from './src/serve/backend'\nconsole.log(removeCopies(process.argv[2]))")
    const told = execFileSync(process.execPath, [path.join(scratch, 'erasing.mjs'), person], {
      env: { PATH: process.env.PATH, IT_HOME: folder },
      encoding: 'utf8',
    })
    return Number(told)
  }

  test('a record that the disk takes only a part of is not given its name: what was kept of the erasings is still what the file holds, and the erasing that was to be written down removes no copy', async () => {
    await peopled()
    // What was kept of forty erasings, which is more than the system is about to let one file hold
    const told = Object.fromEntries(
      Array.from({ length: 40 }, (_, n) => [createHash('sha256').update(`an erasing ${n}`).digest('hex'), { at: 1_700_000_000_000 + n, copies: [] }]),
    )
    writeFileSync(inBackend('erased.json'), JSON.stringify({ told, ran: 0 }, null, 1))
    const before = readFileSync(inBackend('erased.json'))
    expect(before.length).toBeGreaterThan(2048)
    expect(await erased('somebody else, who had no copy')).toBe(0)
    const whole = readFileSync(inBackend('erased.json'))
    copied('before-functions-000000000000')
    // The same program, where the system lets no file grow past its first kilobyte or half of
    // one: it takes the beginning of what is written, says how much it took, and refuses the rest
    const ran = spawnSync(
      'sh',
      ['-c', 'trap "" XFSZ; ulimit -f 1; exec "$0" "$@"', process.execPath, path.join(scratch, 'erasing.mjs'), 'the person who erased everything'],
      {
        env: { PATH: process.env.PATH, IT_HOME: folder },
        encoding: 'utf8',
      },
    )
    // It does not say that the erasing is done, and nothing was done for it
    expect(ran.status).not.toBe(0)
    expect(readFileSync(inBackend('erased.json')).equals(whole)).toBe(true)
    expect(whole.length).toBeGreaterThan(before.length)
    expect(copies()).toEqual(['before-functions-000000000000'])
    expect(readdirSync(inBackend()).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // Told again where there is room, it is written down whole, and its copy goes
    expect(await erased('the person who erased everything')).toBe(1)
    expect(Object.keys(JSON.parse(readFileSync(inBackend('erased.json'), 'utf8')).told)).toHaveLength(42)
    expect(copies()).toEqual([])
  }, 180_000)

  test('what is kept of the erasings is never taken for nothing when it is there and cannot be read: told of an erasing, the service removes no copy, writes nothing over the file, and says which file it is', async () => {
    await peopled()
    copied('before-functions-000000000000')
    const key = createHash('sha256').update('the person who erased everything').digest('hex')
    const unreadable = [
      '',
      '{ "',
      '[]',
      'null',
      JSON.stringify({ told: { [key]: { at: 'some time ago', copies: [] } }, ran: 0 }),
      JSON.stringify({ told: { [key]: null }, ran: 0 }),
      JSON.stringify({ told: {} }),
      JSON.stringify({ told: {}, ran: 'for a long time' }),
    ]
    for (const held of unreadable) {
      writeFileSync(inBackend('erased.json'), held)
      let refused: Problem | undefined
      try {
        removeCopies('the person who erased everything')
      } catch (err) {
        refused = err as Problem
      }
      expect([held, refused?.code, refused?.message]).toEqual([
        held,
        'record_unread',
        `What It keeps of the erasings it was told of, in ${inBackend('erased.json')}, is not as It wrote it.`,
      ])
      expect(refused?.hint).toBe(
        'It says there which copies of the database each erasing removes, and It removes none without knowing. Put the file back as it was. If that cannot be done, move it away, and with it every folder there whose name begins with "before-": those are the copies, and It cannot tell which of them hold what was erased.',
      )
      expect(readFileSync(inBackend('erased.json'), 'utf8')).toBe(held)
      expect(copies()).toEqual(['before-functions-000000000000'])
    }
    // Moved away, the erasing is one the service hears of for the first time
    rmSync(inBackend('erased.json'))
    expect(removeCopies('the person who erased everything')).toBe(1)
    expect(copies()).toEqual([])
  }, 180_000)

  test('a folder named as a copy whose own word of which copy it is cannot be read is left as it is, and keeps an erasing from being written down or taken for done until the person has seen to it', async () => {
    const { config } = await peopled()
    copied('before-functions-000000000000')
    copied('before-functions-111111111111')
    for (const held of ['', '{ "copy": ', JSON.stringify({ copy: 'before-functions-111111111111' })]) {
      writeFileSync(inBackend('before-functions-111111111111', 'copy.json'), held)
      let refused: Problem | undefined
      try {
        removeCopies('the person who erased everything')
      } catch (err) {
        refused = err as Problem
      }
      expect([held, refused?.code, refused?.message]).toEqual([
        held,
        'record_unread',
        `The folder ${inBackend('before-functions-111111111111')} is named as a copy It made of its database, and the file in it that says which copy it is, copy.json, is not as It wrote it.`,
      ])
      expect(copies().sort()).toEqual(['before-functions-000000000000', 'before-functions-111111111111'])
      expect(existsSync(inBackend('erased.json'))).toBe(false)
    }
    // A start that keeps a copy of its own leaves it as it is, and is not kept from starting by it
    noted({ release: 'precompiled-2026-01-15-0000000' })
    await (await start(config)).stop()
    expect(said[0]).toBe(COPIED)
    expect(readFileSync(inBackend('before-functions-111111111111', 'db.sqlite3'), 'utf8')).toBe('before-functions-111111111111')
    // The person removes the folder, as they were told they may, and the erasing goes through
    rmSync(inBackend('before-functions-111111111111'), { recursive: true })
    expect(removeCopies('the person who erased everything')).toBe(2)
    expect(copies()).toEqual([])
  }, 180_000)

  /** For how long the backend program has to have run after an erasing before the database's own file holds nothing of it: two hours and a half. */
  const HELD_MS = 9_000_000
  /** What is kept of the erasings, with the program's running since the last of them counted as given. */
  const ranFor = (ran: number) => {
    const kept = JSON.parse(readFileSync(inBackend('erased.json'), 'utf8')) as { told: Record<string, unknown>; ran: number }
    writeFileSync(inBackend('erased.json'), JSON.stringify({ ...kept, ran }))
  }
  const ran = () => (JSON.parse(readFileSync(inBackend('erased.json'), 'utf8')) as { ran: number }).ran
  const GONE = 'backend: the database has let go of what was erased, and the copies of it made while it had not went with that (1)'

  test('a copy made while the database still holds what was erased holds it too and says so of itself, and it goes once the backend program has run for as long as the database keeps such, though no other copy is there', async () => {
    const config = makeConfig()
    let backend = await start(config)
    const marker = `a desk named ${Math.random().toString(36).slice(2)}`
    expect((await begin({ background: false, say: () => {}, name: marker })).enrolled).toBe(true)
    const machine = readJson<Machine>(machineFile())!
    // Everything is erased for real, and the service is told so, as its door tells it when the person's files are gone
    const person = await eraseEverything(config)
    expect(await until(async () => (await asAdmin(backend, 'bridge:machine', { id: machine.id })) === null)).toBe(true)
    expect(removeCopies(person)).toBe(0)
    await backend.stop()
    // What was erased is still a row in the database's file, as it is for the hour the program keeps such
    expect(readFileSync(database()).includes(marker)).toBe(true)
    // A newer backend program is about to be started on the database, so a copy of it is kept
    noted({ release: 'precompiled-2026-01-15-0000000' })
    said = []
    backend = await start(config)
    const copy = `before-${RELEASE}`
    expect(said[0]).toBe(COPIED)
    expect(readFileSync(inBackend(copy, 'db.sqlite3')).includes(marker)).toBe(true)
    expect(JSON.parse(readFileSync(inBackend(copy, 'copy.json'), 'utf8'))).toMatchObject({ copy, erased: true })
    // Told of that erasing again, the service leaves the copy: it was made after the telling
    expect(removeCopies(person)).toBe(0)
    await backend.stop()
    expect(copies()).toEqual([copy])
    // The program's running is counted, and while the time is not over the copy stays through a start
    expect(ran()).toBeGreaterThan(0)
    ranFor(HELD_MS - 600_000)
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
    expect(copies()).toEqual([copy])
    // With a second of the time left, the copy is there when the service starts, and goes while it runs
    ranFor(HELD_MS - 1000)
    said = []
    backend = await start(config)
    expect(copies()).toEqual([copy])
    expect(await until(() => copies().length === 0, 60_000)).toBe(true)
    expect(said).toEqual([expect.stringMatching(/^backend: started/), GONE])
    await backend.stop()
    // A copy made from then on holds nothing of what was erased, and does not say that it does
    noted({ release: 'precompiled-2026-01-15-0000000' })
    await (await start(config)).stop()
    expect(JSON.parse(readFileSync(inBackend(copy, 'copy.json'), 'utf8'))).not.toHaveProperty('erased')
    expect(copies()).toEqual([copy])
  }, 420_000)

  test('a copy that says it holds what was erased is removed when the service starts and the time is over, whatever other copies there are, and a copy that does not say so is never removed for it', async () => {
    const { config } = await peopled()
    const erasedCopy = (name: string, ago: number) => {
      copied(name, ago)
      const said = JSON.parse(readFileSync(inBackend(name, 'copy.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(inBackend(name, 'copy.json'), JSON.stringify({ ...said, erased: true }))
    }
    copied('before-functions-000000000000', 3000)
    erasedCopy('before-functions-111111111111', 2000)
    erasedCopy('before-functions-222222222222', 1000)
    copied('before-functions-333333333333', 0, '.0123456789abcdef.part')
    // An erasing was told of, and the program has run for all of the time but a minute since
    writeFileSync(inBackend('erased.json'), JSON.stringify({ told: {}, ran: HELD_MS - 60_000 }))
    await (await start(config)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), 'backend: stopped'])
    expect(copies()).toHaveLength(4)
    expect(ran()).toBeGreaterThan(HELD_MS - 60_000)
    // And then for all of it: the two that hold what was erased go, the newest copy among them, and the others stay
    ranFor(HELD_MS)
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([GONE.replace('(1)', '(2)'), expect.stringMatching(/^backend: started/), 'backend: stopped'])
    expect(copies().sort()).toEqual(['before-functions-000000000000', 'before-functions-333333333333.0123456789abcdef.part'])
    // It is counted no further once it is over
    expect(ran()).toBe(HELD_MS)
    // Where what is kept of the erasings cannot be read, no copy is kept or removed by it, and the service says so and starts nothing
    writeFileSync(inBackend('erased.json'), '{ "told": ')
    said = []
    const refused = (await startBackend(config, say).catch((err) => err)) as Problem
    expect([refused.code, refused.message]).toEqual([
      'record_unread',
      `What It keeps of the erasings it was told of, in ${inBackend('erased.json')}, is not as It wrote it.`,
    ])
    expect(said).toEqual([])
    expect(existsSync(inBackend('lock'))).toBe(false)
    expect(programsOn(folder)).toEqual([])
  }, 180_000)

  test('an erasing removes the copies there were when the service was first told of it, and told of it again, a while later or by a service started since, it leaves the copies made for whoever began again', async () => {
    const { config, bytes } = await peopled()
    copied('before-functions-000000000000', 3000)
    copied('before-precompiled-2026-01-15-0000000', 2000)
    copied('before-functions-111111111111', 0, '.0123456789abcdef.part')
    expect(await erased('the person who erased everything')).toBe(2)
    expect(copies()).toEqual([])
    // What is remembered of it is the person's alone to read, and names nobody
    if (!windows) expect(statSync(inBackend('erased.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(inBackend('erased.json'), 'utf8')).not.toContain('the person who erased everything')
    // The person begins again, and a newer It keeps a copy of what they have made since
    noted({ release: 'precompiled-2026-01-15-0000000' })
    await (await start(config)).stop()
    expect(copies()).toEqual([`before-${RELEASE}`])
    // The first erasing is told of again, as it is twenty minutes on and whenever its answer was lost
    expect(await erased('the person who erased everything')).toBe(0)
    expect(removeCopies('the person who erased everything')).toBe(0)
    expect(copies()).toEqual([`before-${RELEASE}`])
    // A copy made since is not that erasing's, though the clock was set back and it says it was made a day earlier
    copied('before-functions-222222222222', 86_400_000)
    expect(await erased('the person who erased everything')).toBe(0)
    expect(copies().sort()).toEqual(['before-functions-222222222222', `before-${RELEASE}`])
    expect(readFileSync(inBackend(`before-${RELEASE}`, 'db.sqlite3')).equals(bytes)).toBe(true)
    // Whoever began again erases everything in their turn, and these copies go with it
    expect(await erased('the person who began again')).toBe(2)
    expect(copies()).toEqual([])
    expect(await erased('the person who began again')).toBe(0)
    expect(readFileSync(database()).length).toBeGreaterThan(0)
  }, 180_000)

  // Whoever runs the machine can clear any folder, so run as that, nothing here keeps a copy from being removed
  test.skipIf(process.getuid?.() === 0)(
    'a copy that could not be removed when an erasing was first told of is removed when it is told of again, and a copy made in between is not',
    async () => {
      await peopled()
      copied('before-functions-000000000000', 3000)
      mkdirSync(inBackend('before-functions-000000000000', 'held'))
      writeFileSync(inBackend('before-functions-000000000000', 'held', 'file'), '')
      chmodSync(inBackend('before-functions-000000000000', 'held'), 0o500)
      let stays: string[] = []
      try {
        // The telling fails, so whoever told is told so, and tells again
        expect(() => removeCopies('the person who erased everything')).toThrow()
        stays = copies()
        expect(stays).toEqual([expect.stringMatching(/^before-functions-000000000000\.[0-9a-f]{16}\.old$/)])
      } finally {
        chmodSync(inBackend(stays[0] ?? 'before-functions-000000000000', 'held'), 0o700)
      }
      // A copy made since, under the very name the one that stayed had: nothing of that one is in its way
      copied('before-functions-000000000000', 0, '', '0123456789abcdef')
      await erased('the person who erased everything')
      expect(copies()).toEqual(['before-functions-000000000000'])
    },
    180_000,
  )

  test('before functions other than the ones last loaded are loaded, a copy of the database is kept, and of such copies the last two', async () => {
    const { config, id, bytes } = await peopled()
    // Two copies from changes before this one
    for (const [name, age] of [
      ['before-functions-000000000000', 3000],
      ['before-precompiled-2026-01-15-0000000', 2000],
    ] as const) {
      copied(name, age * 1000)
      // When a folder was last changed says nothing of when the copy in it was made
      utimesSync(inBackend(name), new Date(Date.now() - (5000 - age) * 1000), new Date(Date.now() - (5000 - age) * 1000))
    }
    noted({ functions: 'the functions of an earlier version', load: 'their load' })
    const backend = await start(config)
    const name = `before-functions-${FUNCTIONS_HASH.slice(0, 12)}`
    expect(said).toEqual([COPIED, expect.stringMatching(/^backend: started/), `backend: functions loaded (${FUNCTIONS_HASH.slice(0, 12)})`])
    expect(copies().sort()).toEqual([name, 'before-precompiled-2026-01-15-0000000'].sort())
    expect(readFileSync(inBackend(name, 'db.sqlite3')).equals(bytes)).toBe(true)
    expect(note()).toMatchObject({ functions: FUNCTIONS_HASH })
    expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    await backend.stop()
    // A change of the settings alone loads the same functions again, and that needs no copy
    rmSync(inBackend(name), { recursive: true })
    process.env.IT_PORT = String(await ports.next())
    said = []
    await (await start(readConfig()!)).stop()
    expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/), 'backend: stopped'])
    expect(copies()).toEqual(['before-precompiled-2026-01-15-0000000'])
  }, 180_000)

  test('the two copies made last are kept by the order they were made in, whatever time each says it was made at: after the clock was set back, the copy made just before this one stays, and the one made before that goes', async () => {
    const { config, bytes } = await peopled()
    // The first was made while the clock was a day ahead, and the second after it had been put right
    copied('before-functions-000000000000', -86_400_000, '', 'aaaaaaaaaaaaaaaa', 1)
    copied('before-functions-111111111111', 3_600_000, '', 'bbbbbbbbbbbbbbbb', 2)
    noted({ release: 'precompiled-2026-01-15-0000000' })
    await (await start(config)).stop()
    expect(said[0]).toBe(COPIED)
    expect(copies().sort()).toEqual(['before-functions-111111111111', `before-${RELEASE}`].sort())
    expect(readFileSync(inBackend(`before-${RELEASE}`, 'db.sqlite3')).equals(bytes)).toBe(true)
    // The one made now says that it is the third
    expect(JSON.parse(readFileSync(inBackend(`before-${RELEASE}`, 'copy.json'), 'utf8'))).toMatchObject({ order: 3 })
  }, 180_000)

  test('a copy from before a load whose end is not known is not replaced by one made after it', async () => {
    const { config, bytes } = await peopled()
    const name = `before-functions-${FUNCTIONS_HASH.slice(0, 12)}`
    noted({ functions: 'the functions of an earlier version', load: 'their load', loading: FUNCTIONS_HASH })
    copied(name)
    writeFileSync(inBackend(name, 'db.sqlite3'), 'the database as it was before that load')
    await (await start(config)).stop()
    expect(readFileSync(inBackend(name, 'db.sqlite3'), 'utf8')).toBe('the database as it was before that load')
    expect(note()).toEqual({
      made: expect.any(Number),
      release: RELEASE,
      it: VERSION,
      functions: FUNCTIONS_HASH,
      functionsOf: VERSION,
      load: expect.any(String),
      port: config.port,
    })
    expect(bytes.length).toBeGreaterThan(0)
  }, 180_000)

  // Whoever runs the machine can clear any folder, so run as that, nothing here is in the way of a copy
  test.skipIf(process.getuid?.() === 0)(
    'where no copy can be kept, a newer program is not started, and other functions are not loaded: the ones in the database go on serving',
    async () => {
      const { config, id, bytes } = await peopled()
      // A file beside the database, kept as the database's own are, that cannot be read, and so cannot be copied
      const held = inBackend('db.sqlite3-held')
      writeFileSync(held, 'held')
      chmodSync(held, 0o000)
      try {
        noted({ release: 'precompiled-2026-01-15-0000000' })
        const earlier = readFileSync(inBackend('data.json'))
        const refused = (await startBackend(config, say).catch((err) => err)) as Problem
        expect([refused.code, refused.hint]).toEqual(['copy_failed', 'Check that the disk has room for a second copy of the database, then start It again.'])
        expect(said).toEqual([expect.stringMatching(/^backend: no copy of the database could be kept \(E[A-Z]+\)$/)])
        said = []
        expect(programsOn(folder)).toEqual([])
        expect(readFileSync(database()).equals(bytes)).toBe(true)
        expect(readFileSync(inBackend('data.json')).equals(earlier)).toBe(true)
        // Nothing is left of the copy that could not be finished
        expect(copies()).toEqual([])

        noted({ release: RELEASE, functions: 'the functions of an earlier version', load: 'their load' })
        const backend = await start(config)
        expect(said).toEqual([
          expect.stringMatching(/^backend: no copy of the database could be kept \(E[A-Z]+\)$/),
          expect.stringMatching(/^backend: started/),
          'backend: for want of a copy, other functions were not loaded, and the ones already loaded go on serving (copy_failed)',
        ])
        expect(backend.behind).toEqual({ functions: FUNCTIONS_HASH, why: 'no_copy', at: expect.any(Number) })
        expect(standing()).toMatchObject({ functions: 'the functions of an earlier version', behind: backend.behind })
        expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
        await backend.stop()
        expect(copies()).toEqual([])
      } finally {
        chmodSync(held, 0o600)
      }
    },
    180_000,
  )

  test('nothing beside the database that It did not make is removed, given another name or written into, whatever it is called: not when a copy is kept, not when the copies before the last two go, and not when everything is erased', async () => {
    const { config, bytes } = await peopled()
    // What a person may keep there: things whose names begin as a copy's does, and folders named
    // exactly as It names a copy, or what is left of making one, that do not say they are one
    const theirs = [
      'before-family-notes',
      'before-other-files',
      'before-functions-000000000000',
      'before-precompiled-2026-01-15-0000000',
      'before-functions-111111111111.0123456789abcdef.part',
      'before-functions-222222222222.0123456789abcdef.old',
      'before-functions-333333333333.part',
      'before-functions-444444444444.old',
    ]
    for (const name of theirs) {
      mkdirSync(inBackend(name, 'kept'), { recursive: true })
      writeFileSync(inBackend(name, 'precious.txt'), `not made by It: ${name}`)
      writeFileSync(inBackend(name, 'kept', 'db.sqlite3'), name)
    }
    // One of them holds a copy It made of something else, taken out of another folder
    copied('before-functions-555555555555')
    rmSync(inBackend('before-precompiled-2026-01-15-0000000'), { recursive: true })
    renameSync(inBackend('before-functions-555555555555'), inBackend('before-precompiled-2026-01-15-0000000'))
    writeFileSync(inBackend('before-notes.txt'), 'a file, and no folder')
    symlinkSync(inBackend('before-family-notes'), inBackend('before-functions-666666666666'))
    for (const name of [...theirs, 'before-notes.txt']) utimesSync(inBackend(name), new Date(1000), new Date(1000))
    const kept = () =>
      within(inBackend()).filter((file) => [...theirs, 'before-notes.txt', 'before-functions-666666666666'].some((name) => file.startsWith(inBackend(name))))
    const before = kept()
    // And three copies It made itself, and what was left of making two more
    copied('before-functions-777777777777', 3000)
    copied('before-functions-888888888888', 2000)
    copied('before-functions-999999999999', 4000)
    copied(`before-${RELEASE}`, 9000, '.0123456789abcdef.part')
    copied('before-functions-777777777777', 9000, '.fedcba9876543210.old')
    noted({ release: 'precompiled-2026-01-15-0000000' })
    await (await start(config)).stop()
    // The copy was kept, with the one It made last before it, and the rest of It's own are gone
    expect(said[0]).toBe(COPIED)
    expect(
      copies()
        .filter((name) => !theirs.includes(name) && !/notes|666666666666/.test(name))
        .sort(),
    ).toEqual(['before-functions-888888888888', `before-${RELEASE}`])
    expect(readFileSync(inBackend(`before-${RELEASE}`, 'db.sqlite3')).equals(bytes)).toBe(true)
    expect(kept()).toEqual(before)
    // Everything is erased: It's copies go, and nothing else does
    expect(removeCopies()).toBe(2)
    expect(copies().sort()).toEqual([...theirs, 'before-functions-666666666666', 'before-notes.txt'].sort())
    expect(kept()).toEqual(before)
    expect(removeCopies()).toBe(0)
    expect(readFileSync(database()).length).toBeGreaterThan(0)
  }, 180_000)

  // Whoever runs the machine can clear any folder, so run as that, nothing here keeps a copy from being removed
  test.skipIf(process.getuid?.() === 0)(
    'a copy of It’s own that cannot be removed whole is still known for one and goes the next time: that keeps no newer copy from being kept, and it fails the erasing of everything once the other copies have gone',
    async () => {
      const { config } = await peopled()
      const stuck = 'before-functions-000000000000'
      copied(stuck, 3000)
      copied('before-functions-111111111111', 2000)
      let held = inBackend(stuck, 'held')
      mkdirSync(held)
      writeFileSync(path.join(held, 'file'), '')
      chmodSync(held, 0o500)
      try {
        // It is the one before the last two, and cannot go: that is said, and the copy is kept and the program started all the same
        noted({ release: 'precompiled-2026-01-15-0000000' })
        await (await start(config)).stop()
        expect(said.slice(0, 2)).toEqual([expect.stringMatching(/^backend: an earlier copy of the database could not be removed \(E[A-Z]+\)$/), COPIED])
        // What stays of it has given up its name, and still says that it is a copy It made
        const aside = () => copies().filter((name) => name.startsWith(`${stuck}.`))
        expect(aside()).toEqual([expect.stringMatching(/^before-functions-000000000000\.[0-9a-f]{16}\.old$/)])
        expect(copies().sort()).toEqual([...aside(), 'before-functions-111111111111', `before-${RELEASE}`].sort())
        expect(JSON.parse(readFileSync(inBackend(aside()[0]!, 'copy.json'), 'utf8'))).toMatchObject({ copy: stuck })
        // Everything is erased: the others go, and the one that cannot is what the erasing fails with
        expect(() => removeCopies()).toThrow()
        expect(copies()).toEqual(aside())
        expect(existsSync(inBackend(aside()[0]!, 'copy.json'))).toBe(true)
        held = inBackend(aside()[0]!, 'held')
      } finally {
        chmodSync(held, 0o700)
      }
      // It was already making way, so it is cleared as what was left of a copy and not counted as one
      expect(removeCopies()).toBe(0)
      expect(copies()).toEqual([])
    },
    180_000,
  )

  test('something It did not make under the very name a copy would be given is left as it is, and counts as no copy: a newer program is not started, and other functions are not loaded', async () => {
    const { config, id, bytes } = await peopled()
    const program = `before-${RELEASE}`
    const functions = `before-functions-${FUNCTIONS_HASH.slice(0, 12)}`
    for (const name of [program, functions]) {
      mkdirSync(inBackend(name))
      writeFileSync(inBackend(name, 'precious.txt'), `not made by It: ${name}`)
    }
    const before = [...within(inBackend(program)), ...within(inBackend(functions))]
    noted({ release: 'precompiled-2026-01-15-0000000' })
    const earlier = readFileSync(inBackend('data.json'))
    const refused = (await startBackend(config, say).catch((err) => err)) as Problem
    expect([refused.code, refused.hint]).toEqual([
      'copy_failed',
      `Something that It did not make is at ${inBackend(program)}, where the copy goes, and It leaves it as it is. Move it somewhere else, then start It again.`,
    ])
    expect(said).toEqual(['backend: no copy of the database could be kept (in_the_way)'])
    expect(programsOn(folder)).toEqual([])
    expect(readFileSync(database()).equals(bytes)).toBe(true)
    expect(readFileSync(inBackend('data.json')).equals(earlier)).toBe(true)
    // Where only the functions are other ones, the ones in the database go on serving
    noted({ release: RELEASE, functions: 'the functions of an earlier version', load: 'their load' })
    said = []
    const backend = await start(config)
    expect(said).toEqual([
      'backend: no copy of the database could be kept (in_the_way)',
      expect.stringMatching(/^backend: started/),
      'backend: for want of a copy, other functions were not loaded, and the ones already loaded go on serving (copy_failed)',
    ])
    expect(backend.behind).toMatchObject({ why: 'no_copy' })
    expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    await backend.stop()
    expect([...within(inBackend(program)), ...within(inBackend(functions))]).toEqual(before)
    expect(copies().sort()).toEqual([functions, program].sort())
    // Moved somewhere else, as the person was told to, it is in the way of nothing
    renameSync(inBackend(functions), path.join(folder, 'moved'))
    said = []
    await (await start(config)).stop()
    expect(said).toEqual([COPIED, expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/), 'backend: stopped'])
    expect(JSON.parse(readFileSync(inBackend(functions, 'copy.json'), 'utf8'))).toMatchObject({ copy: functions })
  }, 180_000)

  // The functions of another version are put in this program's place by the test runner, which Bun's does not do
  test.skipIf('Bun' in globalThis)(
    'functions that the database does not fit are refused, and the backend goes on serving with the ones it has, which it says in a fixed word and notes for whoever tells the person',
    async () => {
      const { config, id } = await peopled()
      // The functions of another version: every person's record must have something that the one there has not
      const request = JSON.parse(FUNCTIONS) as { appDefinition: { schema: { source: string } } }
      const fitted = request.appDefinition.schema.source
      request.appDefinition.schema.source = fitted.replace(/subject:\s*(\w+)\.string\(\),/, (whole, v: string) => `${whole} somethingNew: ${v}.string(),`)
      expect(request.appDefinition.schema.source).not.toBe(fitted)
      const other = JSON.stringify(request)
      const hash = createHash('sha256').update(other).digest('hex')
      // And they are the functions of the version of It that comes after this one
      const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1))
      expect(NEWER).not.toBe(VERSION)
      vi.resetModules()
      vi.doMock('./src/functions.generated', () => ({ FUNCTIONS: other, FUNCTIONS_HASH: hash }))
      vi.doMock('./src/lib', async (original) => ({ ...(await original<typeof import('./src/lib')>()), VERSION: NEWER }))
      try {
        const newer = await import('./src/serve/backend')
        const backend = await newer.startBackend(config, say)
        running.push(backend)
        expect(said).toEqual([
          COPIED,
          expect.stringMatching(/^backend: started/),
          'backend: functions not loaded (schema failed)',
          'backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)',
        ])
        expect(backend.behind).toEqual({ functions: hash, why: 'refused', at: expect.any(Number) })
        // Noted beside the database, where `it status` and the site can read it, with the functions that are in it:
        // the newer It is the one that last ran, and the functions are still those of the version before it
        expect(newer.standing()).toEqual({ release: RELEASE, it: NEWER, functions: FUNCTIONS_HASH, functionsOf: VERSION, behind: backend.behind })
        expect(note()).not.toHaveProperty('loading')
        // What the person made is there, and the functions that were there answer
        expect(await healthy(config.port)).toBe(true)
        expect(await asAdmin(backend, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
        expect(copies()).toEqual([`before-functions-${hash.slice(0, 12)}`])
        // The settings file still says what is loaded
        expect(readConfig()!.functions).toBe(config.functions)
        await backend.stop()

        // From another port the functions in the database cannot go on: what they believe of their
        // own address was fixed when they were loaded, and every command would be refused. So It
        // stops, says which port to put back, and does not say that it goes on.
        process.env.IT_PORT = String(await ports.next())
        said = []
        const moved = (await newer.startBackend(readConfig()!, say).catch((err) => err)) as Problem
        expect([moved.code, moved.message, moved.hint]).toEqual([
          'port_changed',
          `The functions in It’s database were loaded when It counted from port ${config.port}, and the functions of this version could not take their place, so It cannot run from port ${process.env.IT_PORT}.`,
          `Put the port back: start It with IT_PORT=${config.port}.`,
        ])
        expect(said).toEqual([
          COPIED,
          expect.stringMatching(/^backend: started/),
          'backend: functions not loaded (schema failed)',
          'backend: the functions of this version were not loaded, and the ones already loaded were loaded for another port (port_changed)',
        ])
        expect(newer.standing()).toEqual({ release: RELEASE, it: NEWER, functions: FUNCTIONS_HASH, functionsOf: VERSION })
        expect(await healthy(Number(process.env.IT_PORT))).toBe(false)
        expect(programsOn(folder)).toEqual([])
        expect(existsSync(inBackend('lock'))).toBe(false)
        // With the port put back, it goes on as before
        process.env.IT_PORT = String(config.port)
        said = []
        const back = await newer.startBackend(readConfig()!, say)
        running.push(back)
        expect(said.at(-1)).toBe('backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)')
        expect(back.behind).toMatchObject({ functions: hash, why: 'refused' })
        expect(await asAdmin(back, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
        await back.stop()
      } finally {
        vi.doUnmock('./src/functions.generated')
        vi.doUnmock('./src/lib')
        vi.resetModules()
      }
      // The version whose functions are the ones in the database is run on it again, though a newer one has run on it
      // since: it finds nothing to load and nothing behind, and is the one that last ran
      expect(note()).toMatchObject({ it: NEWER, functionsOf: VERSION })
      said = []
      const again = await start(config)
      expect(said).toEqual([expect.stringMatching(/^backend: started/)])
      expect(again.behind).toBeUndefined()
      expect(standing()).toEqual({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })
      expect(await asAdmin(again, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
      await again.stop()
      // And this version at another port loads its own functions again, for that port
      process.env.IT_PORT = String(await ports.next())
      said = []
      const elsewhere = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(note()).toMatchObject({ port: Number(process.env.IT_PORT) })
      expect(await asAdmin(elsewhere, 'bridge:machine', { id })).toMatchObject({ id, revoked: false })
    },
    300_000,
  )

  test('why functions were not loaded is written down as one fixed word, and never in the backend’s own words', async () => {
    const config = makeConfig()
    // A key that is not this backend's: it refuses the functions, and says why at length
    const wrong = { ...config, adminKey: `${instanceName(config.instanceSecret)}|${'00'.repeat(40)}` }
    const refused = await startBackend(wrong, say).catch((err) => err as { code: string; hint?: string })
    expect(refused).toMatchObject({ code: 'functions_refused' })
    expect(said).toEqual([
      expect.stringMatching(/^backend: started \(pid \d+\)$/),
      expect.stringMatching(/^backend: functions not loaded \([A-Za-z][A-Za-z0-9_]{0,59}\)$/),
    ])
    // What the backend said at length is for a person at a terminal
    const sentence = (refused as { hint?: string }).hint
    expect(sentence).toEqual(expect.any(String))
    expect(said.join('\n')).not.toContain(sentence)
    expect(existsSync(inBackend('lock'))).toBe(false)
    expect(programsOn(folder)).toEqual([])
  }, 180_000)
})

describe.skipIf(!program || windows)('what is written, as the disk has it when it is given its name', () => {
  // A program that does one thing the service does, on a system whose files are the system's
  // own, with one thing more: each time the program asks for a file to be opened, written,
  // flushed, closed, copied or given a name, that is written down in the file `CALLS` names,
  // in the order it was asked. A folder that is given a name is written down with every file
  // in it. Nothing of the service itself is other than it is.
  const watched: Plugin = {
    name: 'watched',
    setup(b) {
      b.onResolve({ filter: /^node:fs$/ }, (asked) => (asked.namespace === 'watched' ? undefined : { path: asked.path, namespace: 'watched' }))
      b.onLoad({ filter: /.*/, namespace: 'watched' }, () => ({
        loader: 'js',
        contents: `
          import * as real from 'node:fs'
          export * from 'node:fs'
          export { default } from 'node:fs'
          const called = (...call) => process.env.CALLS && real.appendFileSync(process.env.CALLS, JSON.stringify(call) + '\\n')
          const filesIn = (file) => {
            const kind = real.lstatSync(file, { throwIfNoEntry: false })
            if (!kind || kind.isSymbolicLink()) return []
            return kind.isDirectory() ? real.readdirSync(file).flatMap((name) => filesIn(file + '/' + name)) : [file]
          }
          export const openSync = (file, flags, ...rest) => {
            const opened = real.openSync(file, flags, ...rest)
            called('opened', opened, String(file), String(flags ?? 'r'))
            return opened
          }
          export const writeSync = (to, ...rest) => {
            called('written', to)
            return real.writeSync(to, ...rest)
          }
          export const fsyncSync = (of) => {
            real.fsyncSync(of)
            called('flushed', of)
          }
          export const closeSync = (of) => {
            called('closed', of)
            return real.closeSync(of)
          }
          const whole = (name) => (...given) => {
            called('put', String(given[name === 'writeFileSync' || name === 'appendFileSync' ? 0 : 1]))
            return real[name](...given)
          }
          export const writeFileSync = whole('writeFileSync')
          export const appendFileSync = whole('appendFileSync')
          export const copyFileSync = whole('copyFileSync')
          export const cpSync = whole('cpSync')
          export const renameSync = (from, to) => {
            const files = filesIn(String(from))
            real.renameSync(from, to)
            called('named', String(from), String(to), files)
          }
          export const linkSync = (from, to) => {
            real.linkSync(from, to)
            called('named', String(from), String(to), [String(from)])
          }
        `,
      }))
    },
  }
  let doing: string
  beforeAll(async () => {
    doing = path.join(scratch, 'doing.mjs')
    await bundled(
      'doing.mjs',
      `
        import { fetchProgram, removeCopies, startBackend } from './src/serve/backend'
        import { makeConfig, noteLoaded, noteNetwork } from './src/serve/config'
        import { keepPending } from './src/login'
        const [what, ...given] = process.argv.slice(2)
        try {
          if (what === 'serve') await (await startBackend(makeConfig(), () => {})).stop()
          if (what === 'settings') noteLoaded({ functions: given[0], backend: given[1] }), noteNetwork(true)
          if (what === 'erasing') removeCopies(given[0])
          if (what === 'key') keepPending(JSON.parse(given[0]))
          if (what === 'fetch') await fetchProgram({ url: given[0], sha256: given[1] }, given[2])
        } catch (err) {
          console.log('ERROR ' + err.code)
          process.exitCode = 1
        }
      `,
      [watched],
    )
  }, HOOK_MS)
  /**
   * Has the program do one thing on this test's folder, and gives how it ended and what it said.
   * With no file to write down in, it runs on a disk that lets no file hold more than `most`
   * blocks of 512 bytes, and takes what it is given of a file up to there without failing.
   */
  const does = (calls: string | { most: number }, ...words: string[]) =>
    new Promise<[number | null, string]>((resolve) => {
      const env = { PATH: process.env.PATH, IT_HOME: folder, IT_PORT: process.env.IT_PORT, IT_BACKEND_BIN: program! }
      const child =
        typeof calls === 'string'
          ? spawn(process.execPath, [doing, ...words], { env: { ...env, CALLS: calls }, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn('sh', ['-c', `trap "" XFSZ; ulimit -f ${calls.most}; exec "$0" "$@"`, process.execPath, doing, ...words], {
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
      let out = ''
      child.stdout!.on('data', (c: Buffer) => (out += c))
      child.stderr!.on('data', (c: Buffer) => (out += c))
      child.once('exit', (code) => resolve([code, out.trim()]))
    })
  /**
   * Every name the program gave to something it had written, and with each the files of it
   * that were not on the disk in that moment: written to, and not flushed since. What was
   * written and flushed under one name is so under the name it is given.
   */
  const names = (calls: string) => {
    const open = new Map<number, string>()
    const written = new Map<string, number>()
    const flushed = new Map<string, number>()
    const of = (file: string, kept: Map<string, number>) =>
      Math.max(-1, ...[...kept].filter(([name]) => name === file || file.startsWith(`${name}/`)).map(([, when]) => when))
    const given: { name: string; files: string[]; late: string[] }[] = []
    const all = readFileSync(calls, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as [string, ...unknown[]])
    all.forEach(([what, ...on], when) => {
      if (what === 'opened') {
        open.set(on[0] as number, on[1] as string)
        if (/[wa]/.test(on[2] as string)) written.set(on[1] as string, when)
      }
      const file = open.get(on[0] as number)
      if (what === 'written' && file) written.set(file, when)
      if (what === 'flushed' && file) flushed.set(file, when)
      if (what === 'closed') open.delete(on[0] as number)
      if (what === 'put') written.set(on[0] as string, when)
      if (what !== 'named') return
      const [from, to, files] = on as [string, string, string[]]
      const its = files.filter((one) => of(one, written) >= 0)
      const under = (some: string[]) => some.map((one) => path.relative(from, one))
      // The word a copy has in its name while it is being made, or makes way, is another each time
      const name = path.relative(folder, to).replace(/\.[0-9a-f]{16}\.(part|old)/, '.a-word.$1')
      if (its.length) given.push({ name, files: under(its), late: under(its.filter((one) => (flushed.get(one) ?? -1) < of(one, written))) })
      for (const kept of [written, flushed])
        for (const [name, at] of [...kept]) if (name === from || name.startsWith(`${from}/`)) kept.set(to + name.slice(from.length), at)
    })
    return given
  }

  test('each record the service keeps, and a copy of the database with every file in it, is flushed before it is given its name', async () => {
    const calls = path.join(folder, 'calls')
    expect(await does(calls, 'serve')).toEqual([0, ''])
    // A file is among those the backend keeps for the database, and the program that last ran on it was of another release
    writeFileSync(inBackend('storage', 'a file the backend keeps'), 'x'.repeat(100_000))
    noted({ release: 'precompiled-2026-01-15-0000000', it: '0.0.9' })
    expect(await does(calls, 'serve')).toEqual([0, ''])
    expect(await does(calls, 'settings', FUNCTIONS_HASH, RELEASE)).toEqual([0, ''])
    expect(await does(calls, 'erasing', 'the person who erased everything')).toEqual([0, ''])
    expect(await does(calls, 'key', JSON.stringify({ name: 'the desk', key: { ...KEY, d: 'bm90IGEga2V5' } }))).toEqual([0, ''])
    const given = names(calls)
    expect(given.filter((one) => one.late.length)).toEqual([])
    // Each of the records was among what was given a name, and the copy with everything in it
    const copy = `backend/before-${RELEASE}`
    expect([...new Set(given.map((one) => one.name))].sort()).toEqual([
      copy,
      `${copy}.a-word.old`,
      `${copy}.a-word.part/copy.json`,
      'backend/data.json',
      'backend/erased.json',
      'backend/lock',
      'machine.pending.json',
      'service.json',
    ])
    expect(given.find((one) => one.name === copy)!.files).toEqual(
      expect.arrayContaining(['copy.json', 'data.json', 'db.sqlite3', 'storage/a file the backend keeps']),
    )
  }, 300_000)

  test('the backend program that is fetched is flushed before it is given its name, and one that the disk takes only a part of is not given it', async () => {
    // What stands in for the release: an archive of a program that no packing makes smaller
    const made = randomBytes(2000)
    const archive = Buffer.from(zipSync({ 'convex-local-backend': new Uint8Array(made) }))
    const release = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'application/zip' }).end(archive))
    await new Promise<void>((resolve) => release.listen(0, '127.0.0.1', resolve))
    const from = [`http://127.0.0.1:${(release.address() as net.AddressInfo).port}/archive.zip`, createHash('sha256').update(archive).digest('hex')]
    try {
      const file = inBackend('bin', 'a-release', 'convex-local-backend')
      const calls = path.join(folder, 'calls')
      expect(await does(calls, 'fetch', ...from, file)).toEqual([0, ''])
      expect(readFileSync(file).equals(made)).toBe(true)
      expect(names(calls)).toEqual([{ name: 'backend/bin/a-release/convex-local-backend', files: [''], late: [] }])
      // The disk takes the first 1024 bytes of a file, and says that it took so many. What stands
      // in for the disk counts the writes as Linux makes them, so this half is held there
      if (process.platform === 'linux') {
        const short = inBackend('bin', 'another-release', 'convex-local-backend')
        expect(await does({ most: 2 }, 'fetch', ...from, short)).toEqual([1, 'ERROR backend_program'])
        expect(readdirSync(path.dirname(short))).toEqual([])
      }
    } finally {
      await new Promise<void>((resolve) => release.close(() => resolve()))
    }
  }, 180_000)
})

/** Every way a proxy is named to a program, and to one that is to pass a proxy by. */
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
/** Runs something with a proxy named to this program in every way there is, and with nothing excepted from it. */
const toldOfProxy = async (proxy: string, run: () => Promise<void>) => {
  const before = Object.fromEntries(PROXIES.map((name) => [name, process.env[name]]))
  for (const name of PROXIES) process.env[name] = /^no_/i.test(name) ? '' : proxy
  try {
    await run()
  } finally {
    for (const name of PROXIES) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
}

describe.skipIf(windows)('where the backend program is fetched from', () => {
  /** Something on this machine that notes what it is asked and answers as it is told to. */
  const place = async (answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
    const heard: string[] = []
    const server = http.createServer((req, res) => {
      heard.push(`${req.method} ${req.url}`)
      answer(req, res)
    })
    server.on('connect', (req, socket) => {
      heard.push(`CONNECT ${req.url}`)
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return { heard, port, at: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }
  const sum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  /** The archive of this release as a place for the releases is asked for it: under the release's name, and under the name it has for this system. */
  const ASKED = new RegExp(`^GET /${RELEASE}/convex-local-backend-[a-z0-9_-]+\\.zip$`)
  // No program is named, so one is fetched. Nothing here is asked of anywhere but this machine,
  // whatever is done with the variable: what would be asked of another fails as it does offline.
  let real: typeof fetch
  beforeEach(() => {
    delete process.env.IT_BACKEND_BIN
    real = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const to = new URL(input instanceof Request ? input.url : String(input))
      if (to.hostname !== '127.0.0.1' && to.hostname !== 'localhost') throw new TypeError('fetch failed')
      return real(input, init)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = real
  })

  test('IT_BACKEND_RELEASES names another place for the releases, laid out as they are: the archive of this release is asked for there, directly whatever proxy is named, and what answers is taken only if it is the archive It expects', async () => {
    const made = Buffer.from(`#!/bin/sh\necho made up\n${'x'.repeat(100_000)}`)
    const archive = Buffer.from(zipSync({ 'convex-local-backend': new Uint8Array(made) }))
    const release = await place((_, res) => res.writeHead(200, { 'content-type': 'application/zip' }).end(archive))
    const proxy = await place((_, res) => res.writeHead(502).end('nothing is passed on from here'))
    try {
      await toldOfProxy(proxy.at, async () => {
        // What answers is not the archive this It expects of its release: asked for where the variable says, and not kept
        for (const base of [release.at, `${release.at}/`, `${release.at}/a/mirror`, `http://localhost:${release.port}`]) {
          process.env.IT_BACKEND_RELEASES = base
          release.heard.length = 0
          const refused = (await fetched(() => {}).catch((err) => err)) as Problem
          expect([base, refused.code, refused.hint]).toEqual([
            base,
            'checksum',
            'What IT_BACKEND_RELEASES names does not hold the archive this It expects of its release. Point it at a place that does, or unset it to fetch from the program’s own releases.',
          ])
          expect(release.heard).toHaveLength(1)
          expect(release.heard[0]!.replace('/a/mirror', '')).toMatch(ASKED)
          expect(existsSync(inBackend())).toBe(false)
        }
        // The archive that is expected is taken from such a place, and the program in it is the person's alone to run
        const file = inBackend('bin', 'a-release', 'convex-local-backend')
        await fetchProgram({ url: `${release.at}/a-release/an-archive.zip`, sha256: sum(archive), plain: true }, file)
        expect(readFileSync(file).equals(made)).toBe(true)
        expect(statSync(file).mode & 0o777).toBe(0o700)
      })
      expect(proxy.heard).toEqual([])
    } finally {
      await release.close()
      await proxy.close()
    }
  }, 60_000)

  test('an archive that never ends is given up when the time for fetching it is over, and said as that', async () => {
    // Its first bytes come, and then one now and again for as long as anyone listens
    const release = await place((_, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' })
      res.write('PK')
      const drip = setInterval(() => res.write('.'), 40)
      res.once('close', () => clearInterval(drip))
    })
    try {
      const began = Date.now()
      const slow = (await fetchProgram(
        { url: `${release.at}/a-release/an-archive.zip`, sha256: '0'.repeat(64), plain: true },
        programFile(),
        undefined,
        undefined,
        600,
      ).catch((err) => err)) as Problem
      expect([slow.code, slow.message]).toEqual(['offline', 'The backend program had not been fetched after 0 minutes, so it was given up.'])
      expect(Date.now() - began).toBeLessThan(5000)
      expect(existsSync(programFile())).toBe(false)
    } finally {
      await release.close()
    }
  }, 30_000)

  test('what a place on this machine answers with is followed nowhere else, and a place that does not have the release is said to be the one the variable names', async () => {
    const elsewhere = await place((_, res) => res.writeHead(200).end('somewhere else'))
    const release = await place((req, res) =>
      req.url?.startsWith('/moved') ? res.writeHead(302, { location: `${elsewhere.at}/archive.zip` }).end() : res.writeHead(404).end('not here'),
    )
    try {
      for (const base of [`${release.at}/moved`, release.at]) {
        process.env.IT_BACKEND_RELEASES = base
        const refused = (await fetched(() => {}).catch((err) => err)) as Problem
        expect([base, refused.code, refused.hint]).toEqual([
          base,
          'offline',
          'It is fetched from the place IT_BACKEND_RELEASES names. Check that the release is there, laid out as the program’s own releases are, then try again.',
        ])
      }
      expect(release.heard).toHaveLength(2)
      // Setup says where it fetches from, which is where the variable says
      const said: string[] = []
      expect(await refusal(begin({ background: false, say: (line) => void said.push(line) }))).toBe('offline')
      expect(said).toEqual([
        'Fetching the backend program that It runs on this machine, from the place IT_BACKEND_RELEASES names. It is about 60 MB. It is fetched the first time It is set up, and again when a newer It runs a newer one.',
      ])
      expect(release.heard).toHaveLength(3)
      expect(elsewhere.heard).toEqual([])
      expect(existsSync(inBackend())).toBe(false)
    } finally {
      await release.close()
      await elsewhere.close()
    }
  }, 60_000)

  test('a place that is neither an https address nor this machine itself is refused before anything is asked of it', async () => {
    const release = await place((_, res) => res.writeHead(200).end('an archive'))
    try {
      const refusedAt = [
        'http://example.invalid/releases',
        // Read as a browser reads it, each of these is somewhere else than it looks
        `http://127.0.0.1:80@127.0.0.1:${release.port}`,
        `http://someone:a-password@127.0.0.1:${release.port}`,
        `http://localhost:${release.port}.example.invalid`,
        `http://127.0.0.1.example.invalid:${release.port}`,
        // This machine with no port, by another of its names, and with more than a path after it
        'http://127.0.0.1',
        `http://[::1]:${release.port}`,
        `http://127.0.0.1:${release.port}?to=somewhere`,
        `ftp://127.0.0.1:${release.port}`,
        `//127.0.0.1:${release.port}`,
        'not an address',
      ]
      for (const base of refusedAt) {
        process.env.IT_BACKEND_RELEASES = base
        const refused = (await fetched(() => {}).catch((err) => err)) as Problem
        expect([base, refused.code, refused.message]).toEqual([
          base,
          'backend_releases',
          'IT_BACKEND_RELEASES does not name a place the backend program may be fetched from.',
        ])
        // What the variable holds may have a name and a password in it, and nothing of it is said back
        for (const held of ['a-password', 'someone', 'example.invalid', 'somewhere', 'not an address', String(release.port)])
          expect(`${refused.message} ${refused.hint}`).not.toContain(held)
      }
      expect(release.heard).toEqual([])
      // An https address is asked, whatever it is: nothing answers this one as https does, which is the place’s fault and not the address’s
      process.env.IT_BACKEND_RELEASES = `https://127.0.0.1:${release.port}`
      expect(await refusal(fetched(() => {}))).toBe('offline')
      expect(existsSync(inBackend())).toBe(false)
    } finally {
      await release.close()
    }
  }, 60_000)

  test.skipIf(!program)(
    'the program that is fetched, and each folder made for it, is the person’s alone like everything else a first run makes for the backend, whatever the service itself is allowed to make',
    async () => {
      // The service makes its own files as most programs do: readable by everyone
      const before = process.umask(0o022)
      // What stands in for the release holds a program that becomes the real one, so the folder is made as a first run makes it, with the program fetched into it
      const archive = Buffer.from(zipSync({ 'convex-local-backend': new Uint8Array(readFileSync(standIn(''))) }))
      const release = await place((_, res) => res.writeHead(200, { 'content-type': 'application/zip' }).end(archive))
      try {
        await fetchProgram({ url: `${release.at}/${RELEASE}/an-archive.zip`, sha256: sum(archive), plain: true }, programFile())
        const backend = await start(makeConfig())
        await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'written', publicKey: KEY })
        // The program makes and removes files of its own while it runs, so one that was listed may be gone when it is looked at
        const under = (dir: string): [string, number][] =>
          readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const file = path.join(dir, entry.name)
            const found = statSync(file, { throwIfNoEntry: false })
            if (!found) return []
            const mode = found.mode & 0o777
            return entry.isDirectory()
              ? [[`${path.relative(inBackend(), file)}/`, mode] as [string, number], ...under(file)]
              : [[path.relative(inBackend(), file), mode]]
          })
        const fetchedTo = path.relative(inBackend(), programFile())
        const made = under(inBackend())
        expect(made.map(([name]) => name)).toEqual(
          expect.arrayContaining(['bin/', `bin/${RELEASE}/`, fetchedTo, 'db.sqlite3', 'storage/', 'data.json', 'lock']),
        )
        // Every file is its owner's to read and write and nobody else's, the program its owner's to run as well, and every folder its owner's to enter
        const meant = (name: string) => (name.endsWith('/') || name === fetchedTo ? 0o700 : 0o600)
        expect(made.filter(([name, mode]) => mode !== meant(name))).toEqual([])
        expect(statSync(inBackend()).mode & 0o777).toBe(0o700)
        await backend.stop()
        expect(under(inBackend()).filter(([name, mode]) => mode !== meant(name))).toEqual([])
      } finally {
        process.umask(before)
        await release.close()
      }
    },
    180_000,
  )
})

describe('the backend programs fetched for earlier releases', () => {
  test.skipIf(windows)('the one that is in use is left where the person named it themselves, though it was fetched here for an earlier release', () => {
    const bin = (...parts: string[]) => inBackend('bin', ...parts)
    const put = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'a program')
    }
    const chosen = bin('precompiled-2026-01-15-0000000', 'convex-local-backend')
    put(chosen)
    put(bin('precompiled-2025-12-01-abcdef0', 'convex-local-backend'))
    removeOtherPrograms(chosen)
    expect([existsSync(chosen), existsSync(bin('precompiled-2025-12-01-abcdef0'))]).toEqual([true, false])
  })

  test.skipIf(windows)('are removed once this release’s is in place, and nothing else under the folder they are kept in is, whatever it is called', () => {
    const bin = (...parts: string[]) => inBackend('bin', ...parts)
    const put = (file: string, holds = 'a program') => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, holds)
    }
    // This release's program, the programs of two earlier ones, and what a fetch that was cut short left beside one of them
    put(bin(RELEASE, 'convex-local-backend'))
    put(bin('precompiled-2026-01-15-0000000', 'convex-local-backend'))
    put(bin('precompiled-2026-01-15-0000000', 'convex-local-backend.4242.part'))
    put(bin('precompiled-2025-12-01-abcdef0', 'convex-local-backend.exe'))
    // What a person may keep there: a file in an earlier release's folder, a folder and a file of their own, a folder that
    // is not named as a release is, and a link named as one that leads to a folder of theirs
    put(bin('precompiled-2025-12-01-abcdef0', 'notes.txt'), 'not made by It')
    put(bin('precompiled-2025-11-01-abcdef0', 'convex-local-backend', 'a folder under the program’s name'), 'not made by It')
    put(bin('my-tools', 'convex-local-backend'), 'not made by It')
    put(bin('notes.txt'), 'not made by It')
    put(path.join(folder, 'elsewhere', 'convex-local-backend'), 'not made by It')
    symlinkSync(path.join(folder, 'elsewhere'), bin('precompiled-2025-10-01-abcdef0'))
    removeOtherPrograms()
    const left = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const name = path.relative(bin(), path.join(dir, entry.name))
        return entry.isDirectory() ? [`${name}/`, ...left(path.join(dir, entry.name))] : [name]
      })
    expect(left(bin()).sort()).toEqual(
      [
        `${RELEASE}/`,
        `${RELEASE}/convex-local-backend`,
        'my-tools/',
        'my-tools/convex-local-backend',
        'notes.txt',
        'precompiled-2025-10-01-abcdef0',
        'precompiled-2025-11-01-abcdef0/',
        'precompiled-2025-11-01-abcdef0/convex-local-backend/',
        'precompiled-2025-11-01-abcdef0/convex-local-backend/a folder under the program’s name',
        'precompiled-2025-12-01-abcdef0/',
        'precompiled-2025-12-01-abcdef0/notes.txt',
      ].sort(),
    )
    expect(readFileSync(path.join(folder, 'elsewhere', 'convex-local-backend'), 'utf8')).toBe('not made by It')
  })
})

describe('the backend program, as it is started', () => {
  test('on Windows it is not detached, has no window, and is handed none of the service’s own streams', () => {
    expect(startedWith('win32')).toEqual({ detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // Elsewhere it is in a group of its own, where a signal meant for the service does not reach it
    for (const system of ['linux', 'darwin'] as const) expect(startedWith(system)).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  })

  test.skipIf(!program || windows)(
    'is told to report to nobody, to keep what it logs from its callers, and to listen on this machine only',
    async () => {
      const config = makeConfig()
      const passed = path.join(scratch, 'passed')
      process.env.IT_BACKEND_BIN = standIn(`printf '%s\\n' "$@" > '${passed}'`)
      const backend = await start(config)
      const args = readFileSync(passed, 'utf8').trimEnd().split('\n')
      const at = backendAt(config.port)
      expect(args).toEqual([
        '--interface',
        '127.0.0.1',
        '--port',
        String(config.port + PORTS.backendApi),
        '--site-proxy-port',
        String(config.port + PORTS.backendSite),
        '--convex-origin',
        at.api,
        '--convex-site',
        at.site,
        '--instance-name',
        instanceName(config.instanceSecret),
        '--instance-secret',
        config.instanceSecret,
        '--local-storage',
        inBackend('storage'),
        '--disable-beacon',
        '--redact-logs-to-client',
        database(),
      ])
      // They are what the program runs with, as the system has it
      const [pid] = programsOn(folder)
      const running = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      for (const word of ['--interface 127.0.0.1', '--disable-beacon', '--redact-logs-to-client']) expect(running).toContain(word)
      await backend.stop()
    },
    180_000,
  )

  test.skipIf(!program || windows)(
    'is started with nothing around it that names a proxy, and told to keep the earlier versions of what it holds, and its notes of the jobs it has run, for an hour',
    async () => {
      const config = makeConfig()
      const around = path.join(scratch, 'around')
      process.env.IT_BACKEND_BIN = standIn(`env > '${around}'`)
      await toldOfProxy('http://127.0.0.1:9', async () => {
        const backend = await start(config)
        const given = readFileSync(around, 'utf8').trimEnd().split('\n')
        expect(given.filter((line) => /^(https?|all|no)_proxy=/i.test(line))).toEqual([])
        expect(given).toContain('DOCUMENT_RETENTION_DELAY=3600')
        expect(given).toContain('SCHEDULED_JOB_RETENTION=3600')
        // The rest of what the service has around it is the program's too
        expect(given).toContain(`IT_HOME=${folder}`)
        await backend.stop()
      })
    },
    180_000,
  )

  test.skipIf(!program || windows)(
    'told how long to keep its notes of the jobs it has run, the program removes each note, with what the job was given, a little after that long, and leaves a job that is still to run as it is, however long ago it was given: that job runs when it is due',
    async () => {
      /** The records a table of the program's holds, read from a copy of its database that is made while no program has the database. */
      const held = (table: string): Record<string, any>[] => {
        const copy = path.join(scratch, `look-${Math.random().toString(36).slice(2)}.sqlite3`)
        copyFileSync(database(), copy)
        const bun = 'Bun' in globalThis
        const sqlite = process.getBuiltinModule(bun ? 'bun:sqlite' : 'node:sqlite') as any
        const db = bun ? new sqlite.Database(copy, { readonly: true }) : new sqlite.DatabaseSync(copy, { readOnly: true })
        try {
          const [named] = db
            .prepare(`SELECT hex(id) AS id FROM documents WHERE deleted = 0 AND json_value LIKE '%"name":"${table}"%' AND json_value LIKE '%"state":"active"%'`)
            .all() as { id: string }[]
          if (!named) return []
          // What a record is now is the last that was written of it, and one that was removed has a mark written after it
          const rows = db
            .prepare(
              'SELECT json_value FROM documents d WHERE hex(d.table_id) = ? AND d.deleted = 0 AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.table_id = d.table_id AND n.id = d.id AND n.ts > d.ts)',
            )
            .all(named.id) as { json_value: string }[]
          return rows.map((row) => JSON.parse(row.json_value))
        } finally {
          db.close()
          rmSync(copy, { force: true })
        }
      }
      /** The program's notes of jobs: each by the function it runs, how it stands, and its own id. */
      const notes = () => held('_scheduled_jobs').map((job) => ({ id: String(job._id), runs: String(job.udfPath), stands: String(job.state?.type) }))
      // The real program, told to keep such notes for three seconds where It tells it an hour
      const KEPT_S = 3
      const config = makeConfig()
      process.env.IT_BACKEND_BIN = standIn(`export SCHEDULED_JOB_RETENTION=${KEPT_S}`)
      let backend = await start(config)
      await begin({ background: false, say: () => {}, name: 'the desk' })
      // A page is begun, and no door is there to take its files. So it is given up, and whatever
      // of it may have reached storage is deleted by a job that runs at once, and by another
      // that runs twenty minutes on.
      expect(await refusal(call('action', api.publish.begin, { title: 'a page', files: [{ path: 'index.html', size: 5, sha256: 'a'.repeat(64) }] }))).toBe(
        'unavailable',
      )
      // The person then erases everything, as they do from their own browser
      const person = await eraseEverything(config)
      const asked = Date.now()
      // The hourly cleaning is run as well, which is four jobs more
      await asAdmin(backend, 'retention:sweep', {})
      /**
       * Stops the program, and gives its notes of jobs once they are as waited for. Where they
       * are not so yet, the program is started again and they are looked at a little later,
       * for a generous while, and what they were at the last look is said where it does not come.
       */
      const looked = async (as: (found: ReturnType<typeof notes>) => boolean) => {
        for (const end = Date.now() + 90_000; ; await pause(2000)) {
          await backend.stop()
          const found = notes()
          if (as(found)) return found
          if (Date.now() > end) throw new Error(`The program’s notes of its jobs did not come to be as waited for. At the last look: ${JSON.stringify(found)}`)
          backend = await start(config)
        }
      }
      const run = (found: ReturnType<typeof notes>) => found.filter((note) => note.stands !== 'pending')
      // The person's records go in a few jobs that follow one another, and their files are
      // deleted by a job that runs at once. No door is there to answer that one, or the one
      // for the page, so each is given again and again, later every time: five seconds on,
      // then ten, then twenty. The first look is between the second try and the third, by
      // when a program with time to spare has cleared the notes of everything that ran before.
      await pause(Math.max(0, asked + 10_000 - Date.now()))
      const first = await looked((found) => run(found).length < 3 && !found.some((note) => note.runs.startsWith('retention.js:')))
      const jobs = held('contentJobs')
      const [files, later] = [jobs.find((job) => job.thenDeleteUser !== undefined)!, jobs.find((job) => job.nextAt - Date.now() > 15 * 60_000)!]
      // The person's files, and the page's now and twenty minutes on
      expect([jobs.length, files.attempts > 0, later.attempts, later.thenDeleteUser]).toEqual([3, true, 0, undefined])
      expect(held('users').map((one) => [one._id, typeof one.deletedAt])).toEqual([[person, 'number']])
      // The jobs that are still to run are noted as they were: the next try of each deletion, and the one twenty minutes on
      expect(first.filter((note) => note.stands === 'pending').map((note) => note.runs)).toEqual(['content.js:run', 'content.js:run', 'content.js:run'])
      // Of the jobs that have run, the cleaning's four, the ones that removed the person's records and the tries so far,
      // no note is older than the program was told to keep them, give or take the moment it takes to clear one
      const ran = run(first)
      expect(ran.length).toBeLessThan(3)
      expect(first.some((note) => note.runs.startsWith('retention.js:'))).toBe(false)
      expect(held('_scheduled_job_args').length).toBe(first.length)
      // The program is started anew, and the try that was still to come is made when it is due,
      // though it was given longer ago than notes are kept
      backend = await start(config)
      const tries = async () => ((await asAdmin(backend, 'content:_job', { jobId: files._id })) as { attempts: number } | null)?.attempts
      await comes(async () => ((await tries()) ?? 0) > files.attempts, tries)
      // The notes are looked at again once they have been kept for as long as the program was told to keep them
      await pause((KEPT_S + 3) * 1000)
      const last = await looked((found) => !found.some((note) => ran.some((one) => one.id === note.id)))
      // Every note of a job that had run by the first look is gone, and the job twenty minutes on is still to run
      expect(last.filter((note) => ran.some((one) => one.id === note.id))).toEqual([])
      expect(last.filter((note) => note.stands === 'pending').length).toBe(3)
      expect(held('contentJobs').find((job) => job._id === later._id)).toMatchObject({ attempts: 0 })
      expect(held('_scheduled_job_args').length).toBe(last.length)
    },
    420_000,
  )

  test.skipIf(!program || windows)(
    'asks nothing by way of a proxy, though the service that starts it is told of one: a token is checked against the program’s own keys, and the proxy hears nothing',
    async () => {
      // What stands where a proxy would: it notes what it is asked, and passes nothing on
      const heard: string[] = []
      const proxy = http.createServer((req, res) => {
        heard.push(`${req.method} ${req.url}`)
        res.writeHead(502).end('nothing is passed on from here')
      })
      proxy.on('connect', (req, socket) => {
        heard.push(`CONNECT ${req.url}`)
        socket.destroy()
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      try {
        await toldOfProxy(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, async () => {
          const begun = await begin({ background: false, say: () => {}, name: 'the desk' })
          expect(begun.own).toBe(true)
          try {
            // This machine earns a token with its key, and the program checks the token against the keys it publishes at its own address
            expect(await call('query', api.machines.me)).toMatchObject({ name: 'the desk' })
            expect(heard).toEqual([])
          } finally {
            await begun.done()
          }
        })
      } finally {
        await new Promise((resolve) => proxy.close(resolve))
      }
    },
    180_000,
  )

  test.skipIf(!program || windows)(
    'makes its database, and every file and folder it keeps beside it, for the person alone, whatever the service itself is allowed to make',
    async () => {
      // The service makes its own files as most programs do: readable by everyone
      const before = process.umask(0o022)
      try {
        const backend = await start(makeConfig())
        await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'written', publicKey: KEY })
        // The program makes and removes files of its own while it runs, so one that was listed may be gone when it is looked at
        const under = (dir: string): [string, number][] =>
          readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const file = path.join(dir, entry.name)
            const found = statSync(file, { throwIfNoEntry: false })
            if (!found) return []
            const mode = found.mode & 0o777
            return entry.isDirectory()
              ? [[`${path.relative(inBackend(), file)}/`, mode] as [string, number], ...under(file)]
              : [[path.relative(inBackend(), file), mode]]
          })
        const made = under(inBackend())
        expect(made.map(([name]) => name)).toEqual(expect.arrayContaining(['db.sqlite3', 'storage/', 'data.json', 'lock']))
        // Every file is its owner's to read and write and nobody else's, and every folder its owner's to enter
        expect(made.filter(([name, mode]) => mode !== (name.endsWith('/') ? 0o700 : 0o600))).toEqual([])
        expect(statSync(inBackend()).mode & 0o777).toBe(0o700)
        // The service's own mask is what it was: only the program was started under a narrower one
        expect(process.umask()).toBe(0o022)
        await backend.stop()
        expect(under(inBackend()).filter(([name, mode]) => mode !== (name.endsWith('/') ? 0o700 : 0o600))).toEqual([])
      } finally {
        process.umask(before)
      }
    },
    180_000,
  )

  // On Windows the program is asked to stop as a console would ask it, and ended where that does
  // not reach it, or where it has not gone a short while after. Which of the two happens is for
  // a real start and a real stop there to show, and what follows holds either way: the program
  // has gone, the lock has gone, and the next start finds everything the program had answered for.
  test.skipIf(!windows)(
    'on Windows it has gone a short while after it is stopped, whether it heard or was ended, and what it had answered for is there for the next one',
    async (context) => {
      // Where CI has put no program on the machine, this test fetches it, as a first run does. Anywhere else it is left out.
      if (!program) {
        if (!process.env.CI) return context.skip()
        delete process.env.IT_BACKEND_BIN
        await fetched(() => {})
      }
      const config = makeConfig()
      const backend = await start(config)
      const pid = lock()!.program!
      expect(startOf(pid)).toEqual(expect.any(String))
      // The system's own list of what runs shows it as the program on this folder
      expect(programsHere(instanceName(config.instanceSecret))).toEqual([pid])
      // It runs as it was told to
      const ran = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: 'utf8' },
      )
      for (const word of ['--interface 127.0.0.1', '--disable-beacon', '--redact-logs-to-client']) expect(ran).toContain(word)
      const made = (await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'written last', publicKey: KEY })) as { machineId: string }
      // Stopping has an end: a moment for what was in flight, the asking, a short while to go, and
      // the ending. What the service said is shown with the outcome, since it says whether the
      // program was ended, and in a word why it could not be asked.
      const stopped = await Promise.race([backend.stop().then(() => true), pause(120_000).then(() => false)])
      const ended = said.filter((line) => /^backend: did not stop when asked, and is ended \(pid \d+(, no_console|, no_event|, no_helper)?\)$/.test(line))
      expect({ stopped, said }).toEqual({
        stopped: true,
        said: [expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/), ...ended, 'backend: stopped'],
      })
      expect(ended.length).toBeLessThan(2)
      expect(startOf(pid)).toBeNull()
      expect(programsHere(instanceName(config.instanceSecret))).toEqual([])
      expect(existsSync(inBackend('lock'))).toBe(false)
      said = []
      const next = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/)])
      expect(await asAdmin(next, 'bridge:machine', { id: made.machineId })).toMatchObject({ id: made.machineId, revoked: false })
      await next.stop()
    },
    300_000,
  )
})
