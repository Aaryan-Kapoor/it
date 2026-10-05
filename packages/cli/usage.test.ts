// Usage reporting: what may be sent, when nothing is, and that a batch which cannot be sent is
// given up on. Every test has a folder of its own and a fresh copy of the module, which keeps
// what is waiting to be sent in memory.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { environment } from './src/service'

type Usage = typeof import('./src/usage')
type Line = { id: string; name: string; at: string; properties: Record<string, unknown>; tag: string }
let home: string
let usage: Usage
const spool = () => path.join(home, 'usage.jsonl')
const settingsFile = () => path.join(home, 'telemetry.json')
const offFile = () => path.join(home, 'telemetry-off')
const kept = () => JSON.parse(readFileSync(settingsFile(), 'utf8')) as { enabled?: boolean; told?: number; installation?: string }
const linesIn = (file: string): Line[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const lines = () => linesIn(spool())
/** Whatever is waiting to be sent, under any name it may have. */
const waiting = () => readdirSync(home).filter((f) => f.startsWith('usage.jsonl'))
/** Every file in It's folder and what it holds, to tell whether anything was changed. */
const folder = () => Object.fromEntries(readdirSync(home).map((f) => [f, readFileSync(path.join(home, f), 'utf8')]))
/** A person at a terminal runs a first command. */
const told = () => usage.tellOnce(() => {}, true)
const published = (as: Usage = usage) => as.record('page.published', { agent: 'claude-code', change: 'new', kind: 'custom', size: 'under 10 KB' })
/** A line as the program writes one this moment, to be made into others. */
const aLine = (): Line => {
  published()
  const line = lines().pop()!
  rmSync(spool())
  return line
}
const hourOf = (ms: number) => {
  const hour = new Date(ms)
  hour.setUTCMinutes(0, 0, 0)
  return hour.toISOString()
}
/** A sender whose sends are noted and succeed. */
const noting = (posts: string[], now: () => number = () => 0, as: Usage = usage) =>
  as.startSender({ post: async (_a, body) => posts.push(body) > 0, now, everyMs: 0 })
const sent = (posts: string[]) => posts.map((p) => JSON.parse(p) as { v: number; installation: string; events: { id: string; name: string }[] })
/** Another program on the same machine: a copy of the module of its own, which shares nothing with the first but the folder. */
/** Waits until a send that a pass of the sender makes has begun: until the stand-in it posts through has been given it. */
const begun = async (what: () => boolean) => {
  const end = performance.now() + 10_000
  while (!what()) {
    if (performance.now() > end) throw new Error('the send did not begin')
    await new Promise((r) => setTimeout(r, 2))
  }
}
const another = async (): Promise<Usage> => {
  vi.resetModules()
  return import('./src/usage')
}
/**
 * Runs something with some of the file functions the program calls replaced, the way a full disk
 * or another program at the wrong moment would get in its way, and puts the real ones back.
 */
type FileFunction = 'openSync' | 'readSync' | 'readFileSync' | 'renameSync' | 'lstatSync' | 'readdirSync' | 'opendirSync' | 'rmSync'
async function withFiles(
  replaced: { [K in FileFunction]?: (real: (...args: any[]) => any) => (...args: any[]) => unknown },
  run: () => unknown,
): Promise<void> {
  const real = Object.fromEntries(Object.keys(replaced).map((name) => [name, (fs as any)[name]]))
  for (const [name, make] of Object.entries(replaced)) (fs as any)[name] = make(real[name])
  syncBuiltinESMExports()
  try {
    await run()
  } finally {
    Object.assign(fs, real)
    syncBuiltinESMExports()
  }
}
/** The clock that timers and waits go by is the test's own, and so is the time of day. */
const ownClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
// Every variable by which an agent app says that a command is run in one of its conversations.
// These tests may themselves be run by an agent.
const CONVERSATION = [
  'CLAUDE_CODE_SESSION_ID',
  'IT_SESSION',
  'IT_HARNESS',
  'CODEX_THREAD_ID',
  'OPENCLAW_SESSION_ID',
  'HERMES_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'PI_SESSION_ID',
]

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'it-usage-test-'))
  process.env.IT_HOME = home
  delete process.env.IT_TELEMETRY_ENABLED
  delete process.env.DO_NOT_TRACK
  for (const name of CONVERSATION) delete process.env[name]
  process.env.IT_TELEMETRY_URL = 'http://127.0.0.1:9/usage'
  vi.resetModules()
  usage = await import('./src/usage')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
  delete process.env.IT_TELEMETRY_ENABLED
  delete process.env.DO_NOT_TRACK
  for (const name of CONVERSATION) delete process.env[name]
})

describe('telling the person', () => {
  test('it is on until someone turns it off, and a command at a terminal says so once', () => {
    expect(usage.status()).toMatchObject({ enabled: true, because: 'the default' })
    const said: string[] = []
    usage.tellOnce((line) => said.push(line), true)
    usage.tellOnce((line) => said.push(line), true)
    expect(said).toEqual([usage.NOTICE])
    expect(usage.NOTICE).toMatch(/it telemetry off/)
    expect(usage.NOTICE).toMatch(/IT_TELEMETRY_ENABLED=false/)
    expect(usage.NOTICE).toMatch(/usage-reporting\.md/)
    // The word that would be the easiest to hold against it is not used
    expect(usage.NOTICE).not.toMatch(/anonymous/i)
    // What is kept is when the person was told and a random id, and nothing else
    expect(Object.keys(kept()).sort()).toEqual(['installation', 'told'])
  })
  test('counts are said to be sent only once a person has been told, and for as long as reporting is on', () => {
    // On, and nobody has been told: nothing is counted yet
    expect([usage.status().enabled, usage.counting()]).toEqual([true, false])
    told()
    expect(usage.counting()).toBe(true)
    usage.set(false)
    expect(usage.counting()).toBe(false)
    usage.set(true, () => {})
    expect(usage.counting()).toBe(true)
    // Turned off where this program runs, which is how a service started by hand is told
    process.env.DO_NOT_TRACK = '1'
    expect(usage.counting()).toBe(false)
    delete process.env.DO_NOT_TRACK
    expect(usage.counting()).toBe(true)
    // Someone the install script told has no id until a first command makes one, and until then nothing is counted
    writeFileSync(settingsFile(), JSON.stringify({ told: 1 }))
    expect(usage.counting()).toBe(false)
  })
  test('a command that nobody is watching says nothing and counts nothing, and the next one at a terminal says it', () => {
    const said: string[] = []
    // An agent, a script or a service runs the first commands
    usage.tellOnce((line) => said.push(line), false)
    published()
    usage.tellOnce((line) => said.push(line), false)
    expect(said).toEqual([])
    expect(lines()).toEqual([])
    expect(existsSync(settingsFile())).toBe(false)
    // Then a person does
    usage.tellOnce((line) => said.push(line), true)
    expect(said).toEqual([usage.NOTICE])
    published()
    expect(lines()).toHaveLength(1)
  })
  test.each([
    ['CLAUDE_CODE_SESSION_ID', {}],
    ['CODEX_THREAD_ID', {}],
    ['IT_SESSION', { IT_HARNESS: 'pi' }],
  ])('a command an agent runs is not a person being told, though the agent app gives it a terminal (%s)', (name, more) => {
    Object.assign(process.env, { [name]: 'a-conversation', ...more })
    const said: string[] = []
    usage.tellOnce((line) => said.push(line), true)
    published()
    expect(said).toEqual([])
    expect(lines()).toEqual([])
    expect(existsSync(settingsFile())).toBe(false)
    // The person's own command, in a terminal no agent runs, is still the one that says it
    for (const each of CONVERSATION) delete process.env[each]
    usage.tellOnce((line) => said.push(line), true)
    expect(said).toEqual([usage.NOTICE])
  })
  test('nothing is recorded before the person has been told', () => {
    published()
    expect(lines()).toEqual([])
    told()
    published()
    expect(lines()).toHaveLength(1)
  })
  test('someone the install script told is not told again, and is given an id by the first command', () => {
    // What install.sh and install.ps1 leave, having printed the line themselves
    writeFileSync(settingsFile(), `{"told": ${Date.now()}}\n`)
    const said: string[] = []
    usage.tellOnce((line) => said.push(line), false)
    expect(said).toEqual([])
    expect(kept().installation).toMatch(/^[0-9a-f-]{36}$/)
    published()
    expect(lines()).toHaveLength(1)
  })
  test('both install scripts say the same line the program says, and leave the same note', () => {
    const sentence = usage.NOTICE.split('. ')[0]!
    for (const script of ['install.sh', 'install.ps1']) {
      const text = readFileSync(path.join(__dirname, '../../install', script), 'utf8')
      expect(text, script).toContain(sentence)
      expect(text, script).toContain('telemetry off')
      expect(text, script).toContain('telemetry.json')
      expect(text, script).toMatch(/"told"/)
    }
  })
  test.each([
    ['an id and no telling', (s: { told: number; installation: string }) => ({ installation: s.installation })],
    ['a telling and no id', (s: { told: number; installation: string }) => ({ told: s.told })],
    ['a telling that is not a time', (s: { told: number; installation: string }) => ({ told: 'yesterday', installation: s.installation })],
    ['an id that is not one It makes', (s: { told: number; installation: string }) => ({ told: s.told, installation: 'the-office-laptop' })],
    ['a list where the settings belong', () => [1, 2, 3]],
  ])('settings that hold %s are settings under which nothing is recorded or sent', async (_what, settings) => {
    told()
    for (let i = 0; i < 20; i++) published()
    expect(lines()).toHaveLength(20)
    writeFileSync(settingsFile(), JSON.stringify(settings(kept() as { told: number; installation: string })))
    const service = await another()
    const posts: string[] = []
    const sender = noting(posts, () => 0, service)
    for (let i = 0; i < 20; i++) published(service)
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
    // Nor by a command, which reads the same settings
    const command = await another()
    rmSync(spool(), { force: true })
    published(command)
    expect(lines()).toEqual([])
  })
})

describe('turning it off', () => {
  test.each([
    ['IT_TELEMETRY_ENABLED', 'false'],
    ['IT_TELEMETRY_ENABLED', 'FALSE'],
    ['IT_TELEMETRY_ENABLED', '0'],
    ['IT_TELEMETRY_ENABLED', 'off'],
    ['IT_TELEMETRY_ENABLED', 'no'],
    ['IT_TELEMETRY_ENABLED', 'n'],
    ['IT_TELEMETRY_ENABLED', 'Disabled'],
    ['IT_TELEMETRY_ENABLED', ' false '],
    // What a quoted line in a unit file or an env file delivers
    ['IT_TELEMETRY_ENABLED', '"false"'],
    ['IT_TELEMETRY_ENABLED', "'0'"],
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['DO_NOT_TRACK', 'yes'],
    ['DO_NOT_TRACK', 'on'],
    ['DO_NOT_TRACK', '2'],
    ['DO_NOT_TRACK', 'y'],
    ['DO_NOT_TRACK', '"1"'],
  ])('%s=%s turns it off: nothing is said, recorded or sent', async (name, value) => {
    told()
    process.env[name] = value
    expect(usage.status()).toMatchObject({ enabled: false, because: name })
    const said: string[] = []
    usage.tellOnce((line) => said.push(line), true)
    published()
    expect(lines()).toEqual([])
    const posts: string[] = []
    const sender = noting(posts)
    published()
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
    expect(said).toEqual([])
  })
  test.each([
    ['IT_TELEMETRY_ENABLED', ''],
    ['IT_TELEMETRY_ENABLED', 'true'],
    ['IT_TELEMETRY_ENABLED', '1'],
    ['IT_TELEMETRY_ENABLED', 'on'],
    ['DO_NOT_TRACK', ''],
    ['DO_NOT_TRACK', '0'],
    ['DO_NOT_TRACK', 'false'],
    ['DO_NOT_TRACK', 'FALSE'],
    ['DO_NOT_TRACK', 'no'],
    ['DO_NOT_TRACK', 'off'],
    ['DO_NOT_TRACK', '"0"'],
  ])('%s=%s leaves it on', (name, value) => {
    process.env[name] = value
    expect(usage.status()).toMatchObject({ enabled: true, because: 'the default' })
  })
  test('a variable set in one shell stops the background service, which never sees that shell', async () => {
    told()
    published()
    expect(lines()).toHaveLength(1)
    // A command is run in a shell that has the variable. This is what `it` does first, every time.
    process.env.IT_TELEMETRY_ENABLED = 'false'
    usage.heed()
    // The service is another process, started by the system with no such variable
    delete process.env.IT_TELEMETRY_ENABLED
    const service = await another()
    expect(service.status()).toMatchObject({ enabled: false, because: 'IT_TELEMETRY_ENABLED' })
    // Off is a file of its own, which says what turned it off, and the settings say nothing of it
    expect(readFileSync(offFile(), 'utf8')).toBe('IT_TELEMETRY_ENABLED')
    expect(kept()).not.toHaveProperty('enabled')
    // What was waiting is gone, and the id with it
    expect(waiting()).toEqual([])
    expect(kept().installation).toBeUndefined()
    const posts: string[] = []
    const sender = noting(posts, () => 0, service)
    service.record('service.started', service.thisProgram())
    for (let i = 0; i < 25; i++) service.record('page.published', { agent: 'codex', change: 'new', kind: 'custom', size: 'under 10 KB' })
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
    expect(existsSync(spool())).toBe(false)
    // It stays off until someone says otherwise, where the variable is not set
    expect(service.set(true)).toMatchObject({ enabled: true, because: 'it telemetry on' })
  })
  test('the service is given where to report when it is installed, and never an off switch of its own to undo a later `it telemetry on`', () => {
    const env = environment({ PATH: '/bin', IT_TELEMETRY_ENABLED: 'false', IT_TELEMETRY_URL: 'http://127.0.0.1:1/x', DO_NOT_TRACK: '1' })
    expect(env).toEqual({ PATH: '/bin', IT_TELEMETRY_URL: 'http://127.0.0.1:1/x' })
    expect(environment({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })
  test('`it telemetry off` is remembered, discards what was waiting and forgets the id; `on` starts a new one', () => {
    told()
    const first = kept().installation
    published()
    // What a connector had taken and was stopped before sending goes too
    writeFileSync(`${spool()}.taken`, readFileSync(spool()))
    expect(usage.set(false)).toMatchObject({ enabled: false, because: 'it telemetry off' })
    expect(waiting()).toEqual([])
    expect(readFileSync(offFile(), 'utf8')).toBe('command')
    expect(Object.keys(kept())).toEqual(['told'])
    published()
    expect(lines()).toEqual([])
    expect(usage.set(true)).toMatchObject({ enabled: true, because: 'it telemetry on' })
    expect(existsSync(offFile())).toBe(false)
    expect(kept().installation).toMatch(/^[0-9a-f-]{36}$/)
    expect(kept().installation).not.toBe(first)
    expect(usage.status()).toMatchObject({ enabled: true, because: 'the default' })
    // The variable still wins over `on` wherever it is set
    process.env.IT_TELEMETRY_ENABLED = 'false'
    expect(usage.status().enabled).toBe(false)
  })
  test('someone turned off by DO_NOT_TRACK is told that it was DO_NOT_TRACK, wherever they ask', async () => {
    process.env.DO_NOT_TRACK = '1'
    usage.heed()
    expect(usage.status()).toMatchObject({ enabled: false, because: 'DO_NOT_TRACK' })
    // Asked in a shell that does not have the variable
    delete process.env.DO_NOT_TRACK
    expect((await another()).status()).toMatchObject({ enabled: false, because: 'DO_NOT_TRACK' })
    expect(readFileSync(offFile(), 'utf8')).toBe('DO_NOT_TRACK')
  })
  test.each([
    ['IT_TELEMETRY_ENABLED', 'false'],
    ['DO_NOT_TRACK', '1'],
  ])('`it telemetry on` where %s is set is refused, says why, and changes no file', async (name, value) => {
    told()
    process.env[name] = value
    usage.heed()
    const before = folder()
    let refusal: { code?: string; message?: string } = {}
    try {
      usage.set(true)
    } catch (err) {
      refusal = err as { code?: string; message?: string }
    }
    expect(refusal.code).toBe('refused')
    expect(refusal.message).toContain(name)
    expect(refusal.message).toMatch(/stays off/)
    expect(refusal.message).toMatch(/again without it/)
    expect(folder()).toEqual(before)
    // So the service, which has no such variable, was not turned on behind the person's back
    delete process.env[name]
    const service = await another()
    expect(service.status()).toMatchObject({ enabled: false, because: name })
    const posts: string[] = []
    const sender = noting(posts, () => 0, service)
    for (let i = 0; i < 20; i++) published(service)
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
  })
  test('a variable that could not be written down is still obeyed here, and `it telemetry` says the service was not told', async () => {
    told()
    published()
    process.env.DO_NOT_TRACK = '1'
    // The disk is full: the off file cannot be made
    await withFiles(
      {
        openSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            if (String(file).startsWith(offFile())) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
            return real(file, ...rest)
          },
      },
      () => {
        usage.heed()
        expect(existsSync(offFile())).toBe(false)
        // What was waiting is discarded all the same
        expect(waiting()).toEqual([])
        const here = usage.status()
        expect(here).toMatchObject({ enabled: false, because: 'DO_NOT_TRACK' })
        expect(here.note).toMatch(/background service has not been told/)
        published()
        expect(waiting()).toEqual([])
      },
    )
    // Once it can be written, nothing more is said of it
    usage.heed()
    expect(readFileSync(offFile(), 'utf8')).toBe('DO_NOT_TRACK')
    expect(usage.status().note ?? '').not.toMatch(/has not been told/)
  })
  test('`it telemetry off` that cannot make the off file says that reporting is still on, and still discards what was waiting', async () => {
    told()
    published()
    let failure: { code?: string; message?: string } = {}
    await withFiles(
      {
        openSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            if (String(file).startsWith(offFile())) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
            return real(file, ...rest)
          },
      },
      () => {
        try {
          usage.set(false)
        } catch (err) {
          failure = err as { code?: string; message?: string }
        }
      },
    )
    expect(failure.message).toMatch(/still on/)
    expect(failure.code).toBe('error')
    expect(waiting()).toEqual([])
    expect((await another()).status()).toMatchObject({ enabled: true })
    // Once the file can be made, it is off, and is said to be
    expect(usage.set(false)).toMatchObject({ enabled: false, because: 'it telemetry off' })
  })
  test('`it telemetry` says that the service may send somewhere else when the address is set only for this command', () => {
    expect(usage.status()).toMatchObject({ sendsTo: 'http://127.0.0.1:9/usage' })
    expect(usage.status().note).toMatch(/the address it was installed with/)
    delete process.env.IT_TELEMETRY_URL
    expect(usage.status()).toMatchObject({ sendsTo: usage.DEFAULT_URL })
    expect(usage.status().note).toBeUndefined()
  })
  test('every time it is turned on the installation has a new id, also when it was on already', () => {
    told()
    const ids = [kept().installation]
    usage.set(true)
    ids.push(kept().installation)
    usage.set(true)
    ids.push(kept().installation)
    usage.set(false)
    usage.set(true)
    ids.push(kept().installation)
    expect(new Set(ids).size).toBe(4)
  })
  test('`it telemetry on` says the line to someone who has not been told before it writes anything down', async () => {
    // Where the line cannot be said, nothing is changed
    expect(() =>
      usage.set(true, () => {
        throw new Error('closed')
      }),
    ).toThrow()
    expect(readdirSync(home)).toEqual([])
    // Nor is it said, or anything changed, where a variable keeps reporting off
    const said: string[] = []
    process.env.DO_NOT_TRACK = '1'
    expect(() => usage.set(true, (line) => said.push(line))).toThrow(/DO_NOT_TRACK/)
    expect(said).toEqual([])
    expect(readdirSync(home)).toEqual([])
    delete process.env.DO_NOT_TRACK
    // Turned on with nothing to say the line with, nobody has been told, and nothing is recorded until someone is
    usage.set(true)
    expect(usage.wasTold()).toBe(false)
    published()
    expect(lines()).toEqual([])
    // Said first, and only then written down that it was
    const order: string[] = []
    await withFiles(
      {
        renameSync:
          (real) =>
          (...args: any[]) => {
            order.push('written')
            return real(...args)
          },
      },
      () => usage.set(true, () => order.push('said')),
    )
    expect(order).toEqual(['said', 'written'])
    expect(usage.wasTold()).toBe(true)
    published()
    expect(lines()).toHaveLength(1)
    // And not said a second time
    usage.set(true, (line) => said.push(line))
    expect(said).toEqual([])
  })
  test('turning it off by the command counts as having been told, so nothing is said afterwards', () => {
    usage.set(false)
    usage.set(true)
    const said: string[] = []
    usage.tellOnce((line) => said.push(line), true)
    expect(said).toEqual([])
  })
  test('a program that writes the settings from an old view of them cannot turn reporting back on', async () => {
    // The install script told the person. The first command reads that, and is about to write the id it made
    writeFileSync(settingsFile(), `{"told": ${Date.now()}}\n`)
    const other = await another()
    let turnedOff: unknown
    let paused = false
    await withFiles(
      {
        renameSync: (real) => (from: fs.PathLike, to: fs.PathLike) => {
          // At that instant another program runs `it telemetry off`, start to finish
          if (to === settingsFile() && !paused) {
            paused = true
            turnedOff = other.set(false)
          }
          return real(from, to)
        },
      },
      () => usage.tellOnce(() => {}, false),
    )
    expect(turnedOff).toMatchObject({ enabled: false, because: 'it telemetry off' })
    // The first command's settings are what is on disk now, and reporting is off all the same
    expect(kept().installation).toMatch(/^[0-9a-f-]{36}$/)
    for (const program of [usage, other, await another()]) expect(program.status()).toMatchObject({ enabled: false, because: 'it telemetry off' })
    published()
    expect(waiting()).toEqual([])
    // Nor can settings written by hand that say it is on: whether it is on is nothing the settings say
    writeFileSync(settingsFile(), JSON.stringify({ enabled: true, told: 1, installation: randomUUID() }))
    const service = await another()
    expect(service.status()).toMatchObject({ enabled: false, because: 'it telemetry off' })
    const posts: string[] = []
    const sender = noting(posts, () => 0, service)
    for (let i = 0; i < 20; i++) published(service)
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
  })
  test('whether reporting is off is the off file’s alone to say: settings that hold more than It writes there are read for what It writes, and turn nothing off or on', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ told: 1791000000000, installation: randomUUID(), enabled: false, offBy: 'environment' }))
    expect(usage.status()).toMatchObject({ enabled: true, because: 'the default' })
    usage.heed()
    expect(existsSync(offFile())).toBe(false)
    published()
    expect(waiting().length).toBe(1)
    // And an off file that holds a word It does not write is still an off file
    writeFileSync(offFile(), 'variable')
    expect((await another()).status()).toMatchObject({ enabled: false, because: 'the file telemetry-off' })
  })
  test('anything standing where the off file would be turns reporting off, and `on` takes it away', () => {
    told()
    mkdirSync(offFile())
    expect(usage.status()).toMatchObject({ enabled: false, because: 'the file telemetry-off' })
    published()
    expect(lines()).toEqual([])
    expect(usage.set(true)).toMatchObject({ enabled: true })
    // An empty file, made by hand
    writeFileSync(offFile(), '')
    expect(usage.status()).toMatchObject({ enabled: false, because: 'the file telemetry-off' })
    // One that cannot be taken away is said to be still there, and reporting stays off
    rmSync(offFile())
    mkdirSync(offFile())
    writeFileSync(path.join(offFile(), 'kept'), '')
    expect(() => usage.set(true)).toThrow(/still off/)
    expect(usage.status().enabled).toBe(false)
  })
  test('turned off by another program while a pass is sending, nothing more of that pass is sent', async () => {
    told()
    const posts: string[] = []
    const sender = usage.startSender({
      post: async (_a, body) => {
        posts.push(body)
        // `it telemetry off`, run as another process, lands while the first batch is on its way
        writeFileSync(offFile(), 'command')
        return true
      },
      now: () => 0,
      everyMs: 0,
    })
    for (let i = 0; i < 60; i++) published()
    await sender.tick()
    expect(posts).toHaveLength(1)
    // And nothing the sender does afterwards turns it back on
    await sender.tick()
    sender.stop()
    expect(posts).toHaveLength(1)
    expect(usage.status()).toMatchObject({ enabled: false })
    expect(waiting()).toEqual([])
  })
  test('turned off while a send is on its way, the send is given up at the sender’s next regular pass', async () => {
    told()
    ownClock()
    const given: AbortSignal[] = []
    const sender = usage.startSender({
      // An address that takes the request and never answers
      post: (_a, _b, signal) =>
        new Promise<boolean>((resolve) => {
          given.push(signal)
          signal.addEventListener('abort', () => resolve(false))
        }),
    })
    for (let i = 0; i < 20; i++) published()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(given).toHaveLength(1)
    expect(given[0]!.aborted).toBe(false)
    writeFileSync(offFile(), 'command')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(given[0]!.aborted).toBe(true)
    // Nothing is left to try again, and nothing is
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(given).toHaveLength(1)
    sender.stop()
    expect(waiting()).toEqual([])
  })
  test('turned off and on again between two passes, nothing recorded before is sent, under the old id or the new', async () => {
    told()
    const before = kept().installation!
    const stale = { ...aLine(), id: randomUUID() }
    // Some left by commands, and some the connector recorded itself
    for (let i = 0; i < 3; i++) published()
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    for (let i = 0; i < 3; i++) published()
    await sender.tick()
    for (let i = 0; i < 3; i++) published()
    // Another program: `it telemetry off`, then `it telemetry on`, before the sender looks again
    const other = await another()
    other.set(false)
    // A command that had looked for the off file a moment before leaves its line after that, under the id it knew
    writeFileSync(spool(), `${JSON.stringify(stale)}\n`)
    other.set(true)
    expect(kept().installation).not.toBe(before)
    now += 30_000
    await sender.tick()
    now += 30_000
    await sender.tick()
    expect(posts).toEqual([])
    expect(waiting()).toEqual([])
    // What is recorded from then on is sent, under the new id
    for (let i = 0; i < 20; i++) published()
    await sender.tick()
    expect(sent(posts)).toHaveLength(1)
    expect(sent(posts)[0]!.events).toHaveLength(20)
    expect(posts[0]).not.toContain(stale.id)
    sender.stop()
    expect(lines()).toEqual([])
  })
  test('given a new id while a send is on its way, the send is given up and what it carried is never tried again', async () => {
    told()
    let given: AbortSignal | undefined
    const posts: string[] = []
    let now = 0
    const sender = usage.startSender({
      post: (_a, body, signal) =>
        new Promise<boolean>((resolve) => {
          posts.push(body)
          given = signal
          signal.addEventListener('abort', () => resolve(false))
        }),
      now: () => now,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    const pass = sender.tick()
    await begun(() => posts.length === 1)
    const other = await another()
    other.set(false)
    other.set(true)
    // The sender's next regular pass, while the first is still waiting for its answer
    await sender.tick()
    expect(given?.aborted).toBe(true)
    await pass
    // Long after any wait before another try would have ended
    for (now = 1000; now <= 1_200_000; now += 1000) await sender.tick()
    sender.stop()
    expect(posts).toHaveLength(1)
    expect(waiting()).toEqual([])
  })
  test.each([
    ['looked for the off file', 'the off file'],
    ['read the settings', 'the settings'],
  ])(
    'turned off and on again by another program just after the sender has %s for the last time before a send, nothing recorded before is sent',
    async (_when, what) => {
      told()
      const posts: string[] = []
      const sender = noting(posts)
      for (let i = 0; i < 20; i++) published()
      const other = await another()
      let looks = 0
      let switched = false
      const settings = new Set<number>()
      /** The other program's two commands, each run to its end, at the sender's second look of the pass, which is its last before it sends. */
      const after = (looked: boolean) => {
        if (!looked || switched || ++looks < 2) return
        switched = true
        other.set(false)
        other.set(true)
      }
      await withFiles(
        {
          lstatSync:
            (real) =>
            (file: fs.PathLike, ...rest: any[]) => {
              const seen = real(file, ...rest)
              after(what === 'the off file' && String(file) === offFile())
              return seen
            },
          openSync:
            (real) =>
            (file: fs.PathLike, ...rest: any[]) => {
              const fd = real(file, ...rest) as number
              if (String(file) === settingsFile()) settings.add(fd)
              else settings.delete(fd)
              return fd
            },
          readSync:
            (real) =>
            (fd: number, ...rest: any[]) => {
              const n = real(fd, ...rest)
              after(what === 'the settings' && settings.has(fd))
              return n
            },
        },
        () => sender.tick(),
      )
      expect(switched).toBe(true)
      expect(posts).toEqual([])
      await sender.tick()
      sender.stop()
      expect(posts).toEqual([])
      expect(waiting()).toEqual([])
    },
  )
  test('the id is read after the look for the off file, so that a new id written down between the two is the one the sender goes by', async () => {
    told()
    const posts: string[] = []
    const sender = noting(posts)
    for (let i = 0; i < 20; i++) published()
    const { told: when, installation: before } = kept()
    let looks = 0
    await withFiles(
      {
        lstatSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            const seen = real(file, ...rest)
            // The sender's second look of the pass is its last before it sends. The folder is left as
            // another program's turning off and on again leaves it: no off file, and a new id
            if (String(file) === offFile() && ++looks === 2) writeFileSync(settingsFile(), JSON.stringify({ told: when, installation: randomUUID() }))
            return seen
          },
      },
      () => sender.tick(),
    )
    expect(looks).toBeGreaterThanOrEqual(2)
    expect(kept().installation).not.toBe(before)
    expect(posts).toEqual([])
    await sender.tick()
    sender.stop()
    expect(posts).toEqual([])
  })
  test('turning reporting on, which makes a new id, waits for a sender that is deciding under the old one', async () => {
    told()
    const deciding = path.join(home, 'telemetry-sending')
    writeFileSync(deciding, '')
    const before = kept().installation
    let looks = 0
    let idWhenTheSenderWasDone: string | undefined
    await withFiles(
      {
        lstatSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            // The sender's request has begun by the third time the command looks
            if (String(file) === deciding && ++looks === 3) {
              idWhenTheSenderWasDone = kept().installation
              rmSync(deciding)
            }
            return real(file, ...rest)
          },
      },
      () => usage.set(true),
    )
    expect(looks).toBeGreaterThanOrEqual(3)
    // The new id was already written down while the command waited, so a sender that looks afterwards reads it
    expect(idWhenTheSenderWasDone).toBe(kept().installation)
    expect(kept().installation).not.toBe(before)
  })
  test('while the sender decides whether to send, a file in It’s folder says so, and it is gone once the request has begun', async () => {
    told()
    const deciding = path.join(home, 'telemetry-sending')
    const atSend: boolean[] = []
    const sender = usage.startSender({
      post: async () => {
        atSend.push(existsSync(deciding))
        return true
      },
      now: () => 0,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    let atLook = false
    await withFiles(
      {
        lstatSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            if (String(file) === offFile() && existsSync(deciding)) atLook = true
            return real(file, ...rest)
          },
      },
      () => sender.tick(),
    )
    sender.stop()
    expect(atLook).toBe(true)
    expect(atSend).toEqual([true])
    expect(existsSync(deciding)).toBe(false)
  })
  test('`it telemetry off` run as another program while the sender is deciding does not return before the sender’s request has begun', async () => {
    told()
    // The module as another program runs it, and a command that turns reporting off and says when it had
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-usage-test-'))
    await build({
      entryPoints: [path.join(__dirname, 'src/usage.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: path.join(scratch, 'usage.mjs'),
      logLevel: 'silent',
    })
    const command = path.join(scratch, 'off.mjs')
    writeFileSync(command, "import { set } from './usage.mjs'\nset(false)\nprocess.stdout.write(String(Date.now()))\n")
    const begun: number[] = []
    const sender = usage.startSender({
      post: async () => {
        begun.push(Date.now())
        return true
      },
      now: () => 0,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    let other: ChildProcess | undefined
    let reads = 0
    const settings = new Set<number>()
    try {
      await withFiles(
        {
          openSync:
            (real) =>
            (file: fs.PathLike, ...rest: any[]) => {
              const fd = real(file, ...rest) as number
              if (String(file) === settingsFile()) settings.add(fd)
              else settings.delete(fd)
              return fd
            },
          readSync:
            (real) =>
            (fd: number, ...rest: any[]) => {
              const n = real(fd, ...rest)
              // The sender's second read of the settings in the pass is the last thing it looks at
              // before it sends, and it has found no off file. The other program is started then, and
              // the sender stands still for a tenth of a second: long enough for the other program to
              // make the off file, and short enough for the sender still to send on what it saw
              if (settings.has(fd) && ++reads === 2) {
                other = spawn(process.execPath, [command], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
              }
              return n
            },
        },
        () => sender.tick(),
      )
      expect(other).toBeDefined()
      const returned = await new Promise<number>((resolve) => {
        let said = ''
        other!.stdout!.on('data', (text) => {
          said += text
        })
        other!.on('exit', () => resolve(Number(said)))
      })
      sender.stop()
      expect(existsSync(offFile())).toBe(true)
      expect(begun.length).toBeLessThanOrEqual(1)
      // Whatever the sender sent on what it had seen, it had begun before the command said reporting was off
      for (const at of begun) expect(returned).toBeGreaterThanOrEqual(at)
      // And nothing begins afterwards
      await sender.tick()
      expect(begun.length).toBeLessThanOrEqual(1)
    } finally {
      other?.kill()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
  test('a sender that cannot make the file that says it is deciding does not send', async () => {
    told()
    const deciding = path.join(home, 'telemetry-sending')
    // Something that can be neither written nor removed stands where the file would be
    mkdirSync(deciding)
    writeFileSync(path.join(deciding, 'kept'), '')
    const posts: string[] = []
    const sender = noting(posts)
    for (let i = 0; i < 20; i++) published()
    await sender.tick()
    expect(posts).toEqual([])
    // Once it is out of the way, what was waiting is sent
    rmSync(deciding, { recursive: true })
    await sender.tick()
    sender.stop()
    expect(sent(posts).flatMap((b) => b.events)).toHaveLength(20)
  })
  test('turning reporting off waits for a sender that is deciding, and for a second at most for one that never finishes', async () => {
    told()
    const deciding = path.join(home, 'telemetry-sending')
    writeFileSync(deciding, '')
    let looks = 0
    await withFiles(
      {
        lstatSync:
          (real) =>
          (file: fs.PathLike, ...rest: any[]) => {
            // The sender's request has begun by the third time the command looks
            if (String(file) === deciding && ++looks === 3) rmSync(deciding)
            return real(file, ...rest)
          },
      },
      () => usage.set(false),
    )
    expect(looks).toBeGreaterThanOrEqual(3)
    expect(usage.status().enabled).toBe(false)
    // One left by a sender that was killed in the middle of deciding
    writeFileSync(deciding, '')
    const began = performance.now()
    usage.set(false)
    const took = performance.now() - began
    expect(took).toBeGreaterThanOrEqual(900)
    expect(took).toBeLessThan(3000)
    expect(existsSync(deciding)).toBe(false)
  })
  test('left with no id while a send is on its way, what the send carried is dropped, and is not tried again though the same id comes back', async () => {
    told()
    const settings = readFileSync(settingsFile(), 'utf8')
    const posts: string[] = []
    let now = 0
    const sender = usage.startSender({
      post: (_a, body, signal) =>
        new Promise<boolean>((resolve) => {
          posts.push(body)
          signal.addEventListener('abort', () => resolve(false))
        }),
      now: () => now,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    const pass = sender.tick()
    await begun(() => posts.length === 1)
    // The settings are deleted, and the sender's next regular pass finds no id
    rmSync(settingsFile())
    await sender.tick()
    await pass
    writeFileSync(settingsFile(), settings)
    for (now = 1000; now <= 20_000; now += 1000) await sender.tick()
    sender.stop()
    expect(posts).toHaveLength(1)
    expect(waiting()).toEqual([])
  })
  test('a command still running when reporting is turned off records nothing more, and does not bring back what was discarded', async () => {
    told()
    published()
    expect(lines()).toHaveLength(1)
    ;(await another()).set(false)
    expect(waiting()).toEqual([])
    // The first command goes on, as `it wait` does, and something it would count happens
    published()
    published()
    expect(waiting()).toEqual([])
  })
  test('the program that sends never writes the settings or the off file, so it cannot undo what another program wrote', async () => {
    told()
    const before = folder()
    const sender = noting([])
    for (let i = 0; i < 20; i++) published()
    await sender.tick()
    sender.stop()
    expect(folder()).toEqual(before)
  })
})

describe('what an event may hold', () => {
  test('a name, the hour, an id of its own, and properties from the fixed sets', async () => {
    told()
    published()
    usage.record('answer.delivered', { path: 'woke', after: '1 to 10 seconds', agent: 'codex' })
    const [a, b] = lines()
    // The last is a mark of the id it was made under, which stays on this machine
    expect(Object.keys(a!).sort()).toEqual(['at', 'id', 'name', 'properties', 'tag'])
    expect(a!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/)
    expect(a!.id).not.toBe(b!.id)
    expect(a!.tag).toMatch(/^[0-9a-f]{12}$/)
    expect(b).toMatchObject({ name: 'answer.delivered', properties: { path: 'woke', after: '1 to 10 seconds', agent: 'codex' } })
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    expect(sent(posts)[0]!.events.map((e) => Object.keys(e).sort())).toEqual([
      ['at', 'id', 'name', 'properties'],
      ['at', 'id', 'name', 'properties'],
    ])
    expect(posts[0]).not.toContain(a!.tag)
  })
  test('anything outside those sets is not recorded at all', () => {
    told()
    const record = usage.record as (name: string, properties: Record<string, unknown>) => void
    // A title where a band should be, a property nobody defined, one left out, and an event nobody defined
    record('page.published', { agent: 'claude-code', change: 'new', kind: 'custom', size: 'Deploy plan for acme' })
    record('page.published', { agent: 'claude-code', change: 'new', kind: 'custom', size: 'under 10 KB', title: 'Deploy plan' })
    record('page.published', { agent: 'claude-code', change: 'new', kind: 'custom' })
    record('page.read', { agent: 'claude-code' })
    record('service.started', { version: '0.1.0; rm -rf', os: 'linux', arch: 'x64', installed: 'script' })
    expect(lines()).toEqual([])
  })
  test('an agent app It does not know is "other", and never its own name', () => {
    expect(usage.agentOf('claude-code')).toBe('claude-code')
    expect(usage.agentOf('acme-internal-agent')).toBe('other')
    expect(usage.agentOf(undefined)).toBe('unknown')
    expect(usage.agentOf(null)).toBe('unknown')
    expect(usage.agentOf('unknown')).toBe('unknown')
  })
  test('sizes and times are bands', () => {
    expect([0, 9_999, 10_000, 99_999, 100_000, 999_999, 1_000_000, 10_000_000].map(usage.sizeBand)).toEqual([
      'under 10 KB',
      'under 10 KB',
      '10 to 100 KB',
      '10 to 100 KB',
      '100 KB to 1 MB',
      '100 KB to 1 MB',
      '1 to 10 MB',
      'over 10 MB',
    ])
    // A clock that is behind gives a time before the click was made: the shortest band, never an error
    expect([-5000, 0, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000, 86_400_000].map(usage.timeBand)).toEqual([
      'under 1 second',
      'under 1 second',
      'under 1 second',
      '1 to 10 seconds',
      '10 to 60 seconds',
      '1 to 10 minutes',
      '10 to 60 minutes',
      '1 to 24 hours',
      'over 24 hours',
    ])
  })
  test('this program says which system it is on, and whether the install script put it there', () => {
    const real = process.execPath
    const as = (program: string) => {
      Object.defineProperty(process, 'execPath', { value: program, configurable: true })
      try {
        return usage.thisProgram()
      } finally {
        Object.defineProperty(process, 'execPath', { value: real, configurable: true })
      }
    }
    const here = usage.thisProgram()
    expect(here.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(here.os).toBe(process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'other')
    expect(here.arch).toBe(process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'other')
    expect(as(path.join(home, 'bin', 'it')).installed).toBe('script')
    expect(as('/usr/local/bin/node').installed).toBe('source')
    expect(as(path.join(os.tmpdir(), 'somewhere', 'it')).installed).toBe('other')
  })
  test.each([
    ['0.2.0-rc.1', '0.2.0'],
    ['1.4.12+build.7', '1.4.12'],
    ['0.3.1', '0.3.1'],
  ])('a version of %s is counted as %s, and the service starting is still recorded', async (version, counted) => {
    vi.resetModules()
    vi.doMock('./src/lib', async (original) => ({ ...(await original<typeof import('./src/lib')>()), VERSION: version }))
    try {
      const released = await import('./src/usage')
      released.tellOnce(() => {}, true)
      expect(released.thisProgram().version).toBe(counted)
      released.record('service.started', released.thisProgram())
      expect(lines().map((l) => l.properties.version)).toEqual([counted])
    } finally {
      vi.doUnmock('./src/lib')
    }
  })
  test('the page that tells people what is sent names every event, property and value', () => {
    const page = readFileSync(path.join(__dirname, '../../docs/usage-reporting.md'), 'utf8')
    for (const [name, shape] of Object.entries(usage.ALLOWED)) {
      expect(page, name).toContain(`\`${name}\``)
      for (const [property, may] of Object.entries(shape)) {
        expect(page, `${name}.${property}`).toContain(`\`${property}\``)
        if (Array.isArray(may)) for (const value of may) expect(page, `${name}.${property}: ${value}`).toContain(`\`${value}\``)
      }
    }
    // And no event that does not exist
    const named = [...page.matchAll(/^\| `([a-z]+\.[a-z]+)` \|/gm)].map((m) => m[1])
    expect(named.sort()).toEqual(Object.keys(usage.ALLOWED).sort())
    expect(page).toContain(usage.DEFAULT_URL)
    // Both variables that turn it off, the file that off is, and the header the request carries, are on the page
    for (const said of ['IT_TELEMETRY_ENABLED=false', 'DO_NOT_TRACK=1', 'it telemetry off', '`telemetry-off`', 'IT_TELEMETRY_URL', '`it/'])
      expect(page, said).toContain(said)
    // Every wait between tries is the one the program keeps
    for (const wait of ['2 seconds', '15 seconds', '1 minute', '5 minutes']) expect(page, wait).toContain(wait)
    expect(page).not.toMatch(/anonymous/i)
  })
})

describe('sending', () => {
  test('a command that exits leaves a line, and the connector sends it with what it recorded itself', async () => {
    told()
    published()
    expect(lines()).toHaveLength(1)
    const posts: string[] = []
    let now = 1_000_000
    const sender = noting(posts, () => now)
    usage.record('service.started', usage.thisProgram())
    // Held a while so that events go together, and not past it
    await sender.tick()
    expect(posts).toEqual([])
    expect(existsSync(spool())).toBe(false)
    now += 30_000
    await sender.tick()
    sender.stop()
    const [batch] = sent(posts)
    expect(posts).toHaveLength(1)
    expect(batch!.v).toBe(1)
    expect(batch!.events.map((e) => e.name).sort()).toEqual(['page.published', 'service.started'])
    // The installation is named by a hash of its id, and the id itself is not in what is sent
    expect(batch!.installation).toMatch(/^[0-9a-f]{64}$/)
    expect(posts[0]).not.toContain(kept().installation)
  })
  test('what a connector had taken and was stopped before sending is sent by the next one', async () => {
    told()
    published()
    // Taken by a connector that was then killed
    writeFileSync(`${spool()}.taken`, readFileSync(spool()))
    rmSync(spool())
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    expect(sent(posts).flatMap((b) => b.events)).toHaveLength(1)
    expect(waiting()).toEqual([])
  })
  test('batches hold twenty at most, each event once, and go without waiting when one is full', async () => {
    told()
    const posts: string[] = []
    const sender = noting(posts, () => 5_000)
    for (let i = 0; i < 45; i++) published()
    await sender.tick()
    const batches = sent(posts)
    expect(batches.map((b) => b.events.length)).toEqual([20, 20])
    const ids = batches.flatMap((b) => b.events.map((e) => e.id))
    expect(new Set(ids).size).toBe(40)
    expect(new Set(batches.map((b) => b.installation)).size).toBe(1)
    // The five left over were never tried: they go back as lines for the next start
    sender.stop()
    expect(lines()).toHaveLength(5)
  })
  test('a batch that cannot be sent is tried five times, less and less often, and then dropped', async () => {
    told()
    let now = 0
    const tries: number[] = []
    const sender = usage.startSender({
      post: async () => {
        tries.push(now)
        return false
      },
      now: () => now,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    // A pass every second for twenty minutes
    for (; now <= 1_200_000; now += 1000) await sender.tick()
    expect(tries).toEqual([0, 2_000, 17_000, 77_000, 377_000])
    expect(usage.WAITS).toEqual([2_000, 15_000, 60_000, 300_000])
    // Nothing is left of it, and a later batch is sent as usual
    const posts: string[] = []
    sender.stop()
    expect(lines()).toEqual([])
    const again = noting(posts, () => now)
    for (let i = 0; i < 20; i++) published()
    await again.tick()
    again.stop()
    expect(posts).toHaveLength(1)
  })
  test('left to its own timers, the sender tries a failed batch again as each wait ends, five times in all', async () => {
    told()
    ownClock()
    const began = performance.now()
    const tries: number[] = []
    // No clock and no pace is given: the sender keeps its own, as the connector's does
    const sender = usage.startSender({
      post: async () => {
        tries.push(performance.now() - began)
        return false
      },
    })
    for (let i = 0; i < 20; i++) published()
    await vi.advanceTimersByTimeAsync(1_800_000)
    sender.stop()
    // The first regular pass, and then each wait counted from the try before it
    expect(tries).toEqual([5_000, 7_000, 22_000, 82_000, 382_000])
  })
  test.each([
    ['back', -86_400_000],
    ['forward', 86_400_000],
  ])('a clock that is set a day %s while a batch waits to be tried again moves no try', async (_where, by) => {
    told()
    ownClock()
    const began = performance.now()
    const tries: number[] = []
    const sender = usage.startSender({
      post: async () => {
        tries.push(performance.now() - began)
        return false
      },
    })
    for (let i = 0; i < 20; i++) published()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(tries).toEqual([5_000, 7_000])
    // The machine's clock is corrected, a long way, in the middle of the fifteen seconds before the third try
    vi.setSystemTime(Date.now() + by)
    await vi.advanceTimersByTimeAsync(1_800_000)
    sender.stop()
    expect(tries).toEqual([5_000, 7_000, 22_000, 82_000, 382_000])
  })
  test.each([
    [
      'throws at once',
      () => {
        throw new Error('no network')
      },
    ],
    ['fails later', () => Promise.reject(new Error('no network'))],
  ])('a send that %s is a try that failed: five tries, and the batch is dropped', async (_how, fail) => {
    told()
    let now = 0
    const tries: number[] = []
    const sender = usage.startSender({
      post: () => {
        tries.push(now)
        return fail()
      },
      now: () => now,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    for (; now <= 1_200_000; now += 1000) await expect(sender.tick()).resolves.toBeUndefined()
    sender.stop()
    expect(tries).toEqual([0, 2_000, 17_000, 77_000, 377_000])
    expect(lines()).toEqual([])
  })
  test('stopping does not wait for a send that is under way', async () => {
    told()
    let given: AbortSignal | undefined
    const sender = usage.startSender({
      // An address that never answers: the send ends only when it is given up
      post: (_a, _b, signal) =>
        new Promise<boolean>((resolve) => {
          given = signal
          signal.addEventListener('abort', () => resolve(false))
        }),
      now: () => 0,
      everyMs: 0,
    })
    for (let i = 0; i < 20; i++) published()
    const pass = sender.tick()
    await begun(() => given !== undefined)
    expect(given?.aborted).toBe(false)
    sender.stop()
    await expect(Promise.race([pass.then(() => 'ended'), new Promise((r) => setTimeout(() => r('still waiting'), 500))])).resolves.toBe('ended')
    expect(given?.aborted).toBe(true)
  })
  test('an answer whose end never comes is not waited for: the connection is closed once it is known whether the batch was taken', async () => {
    told()
    let closed = () => {}
    const gone = new Promise<string>((resolve) => {
      closed = () => resolve('closed')
    })
    // Says at once that the batch was taken, and never finishes saying the rest
    const server = http.createServer((req, res) => {
      req.socket.on('close', closed)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000000000' })
        res.flushHeaders()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.IT_TELEMETRY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`
    try {
      const sender = usage.startSender({ now: () => 0, everyMs: 0 })
      for (let i = 0; i < 20; i++) published()
      await sender.tick()
      sender.stop()
      await expect(Promise.race([gone, new Promise((r) => setTimeout(() => r('still open'), 1500))])).resolves.toBe('closed')
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
  test('the request says only that it is It, and its version', async () => {
    told()
    const seen: http.IncomingHttpHeaders[] = []
    const server = http.createServer((req, res) => {
      seen.push(req.headers)
      req.resume()
      req.on('end', () => res.writeHead(204).end())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.IT_TELEMETRY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`
    try {
      const sender = usage.startSender({ now: () => 0, everyMs: 0 })
      for (let i = 0; i < 20; i++) published()
      await sender.tick()
      sender.stop()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]!['user-agent']).toMatch(/^it\/\d+\.\d+\.\d+$/)
    expect(seen[0]!['content-type']).toBe('application/json')
    expect(seen[0]!.cookie).toBeUndefined()
    expect(seen[0]!.authorization).toBeUndefined()
  })
  test('an answer that points to another address is a send that failed, and nothing is sent on to that address', async () => {
    told()
    const reached: string[] = []
    const listen = async (name: string, answer: (res: http.ServerResponse) => void) => {
      const server = http.createServer((req, res) => {
        reached.push(name)
        req.resume()
        req.on('end', () => answer(res))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return { server, address: `http://127.0.0.1:${(server.address() as { port: number }).port}/usage` }
    }
    const elsewhere = await listen('elsewhere', (res) => res.writeHead(204).end())
    const receiver = await listen('receiver', (res) => res.writeHead(307, { location: elsewhere.address }).end())
    process.env.IT_TELEMETRY_URL = receiver.address
    try {
      let now = 0
      const sender = usage.startSender({ now: () => now, everyMs: 0 })
      for (let i = 0; i < 20; i++) published()
      await sender.tick()
      // It counts as a try that failed, and is tried again where it was sent the first time
      now += 2_000
      await sender.tick()
      sender.stop()
    } finally {
      for (const { server } of [receiver, elsewhere]) {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    }
    expect(reached).toEqual(['receiver', 'receiver'])
  })
  test('a line in the file that is not an event It would have written lately, under this id, is not sent', async () => {
    told()
    const good = aLine()
    const other = () => ({ ...good, id: randomUUID() })
    writeFileSync(
      spool(),
      [
        JSON.stringify(good),
        'not json',
        'null',
        JSON.stringify({ ...other(), properties: { ...good.properties, size: 'the plan for acme' } }),
        // A time finer than the hour
        JSON.stringify({ ...other(), at: new Date(Date.parse(good.at) + 13 * 60_000 + 27_123).toISOString() }),
        // An id that is not a random one: a word, and the letters of an address written as an id
        JSON.stringify({ ...other(), id: 'deploy-plan' }),
        JSON.stringify({ ...other(), id: '616c6963-6540-6578-616d-706c652e636f' }),
        // An hour this machine's clock could not have given it in the last week
        JSON.stringify({ ...other(), at: '1987-06-05T04:00:00.000Z' }),
        JSON.stringify({ ...other(), at: hourOf(Date.now() - 8 * 86_400_000) }),
        JSON.stringify({ ...other(), at: hourOf(Date.now() + 3 * 3_600_000) }),
        // Made under another id, or under none
        JSON.stringify({ ...other(), tag: '0123456789ab' }),
        JSON.stringify({ ...other(), tag: undefined }),
        JSON.stringify({ ...other(), title: 'Deploy plan' }),
        '',
      ].join('\n'),
    )
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    const events = sent(posts).flatMap((b) => b.events)
    // The one It wrote, and the last, whose extra field is left behind
    expect(events).toHaveLength(2)
    expect(posts.join('')).not.toMatch(/acme|Deploy plan|deploy-plan|616c6963|1987|:13:27|tag/)
  })
  test('an event taken from the file is sent under an id made as it is taken, and never under what the line gave as its id', async () => {
    told()
    const good = aLine()
    const installation = kept().installation!
    // An id that is the installation's own, and one that ends in the tag, which is never sent
    const tagged = `12345678-1234-4234-8234-${good.tag}`
    writeFileSync(spool(), [good, { ...good, id: installation }, { ...good, id: tagged }].map((line) => JSON.stringify(line)).join('\n'))
    const posts: string[] = []
    let now = 0
    // The first send fails, and the second is taken
    const sender = usage.startSender({ post: async (_a, body) => posts.push(body) > 1, now: () => now, everyMs: 0 })
    await sender.tick()
    now += 30_000
    await sender.tick()
    now += 2_000
    await sender.tick()
    sender.stop()
    const [first, second] = sent(posts).map((batch) => batch.events.map((e) => e.id))
    expect(first).toHaveLength(3)
    expect(new Set(first).size).toBe(3)
    for (const given of [good.id, installation, tagged]) expect(first).not.toContain(given)
    expect(posts.join('')).not.toContain(installation)
    expect(posts.join('')).not.toContain(good.tag)
    // Tried again, each event keeps the id it was first sent under, so that the receiver can count it once
    expect(second).toEqual(first)
  })
  test('an hour that is a few days old is still sent, and so is one the clock is just coming to', async () => {
    told()
    const good = aLine()
    const hours = [hourOf(Date.now() - 6 * 86_400_000), hourOf(Date.now() + 3_500_000)]
    writeFileSync(spool(), hours.map((at) => `${JSON.stringify({ ...good, id: randomUUID(), at })}\n`).join(''))
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    expect(
      sent(posts)
        .flatMap((b) => b.events as unknown as Line[])
        .map((e) => e.at)
        .sort(),
    ).toEqual([...hours].sort())
  })
  test('recording never throws, whatever is wrong with the folder', () => {
    told()
    // It's folder is a file: nothing can be written in it
    const file = path.join(home, 'not-a-folder')
    writeFileSync(file, '')
    process.env.IT_HOME = file
    expect(() => published()).not.toThrow()
    expect(() => usage.tellOnce(() => {}, true)).not.toThrow()
    expect(() => usage.heed()).not.toThrow()
    process.env.DO_NOT_TRACK = '1'
    expect(() => usage.heed()).not.toThrow()
    expect(usage.status()).toMatchObject({ enabled: false, because: 'DO_NOT_TRACK' })
  })
  test('recording in a command reads nothing: it looks once for the off file and adds one line', async () => {
    told()
    published()
    const opened: string[] = []
    const looked: string[] = []
    let read = 0
    const named =
      (into: string[]) =>
      (real: (...args: any[]) => any) =>
      (file: fs.PathLike, ...rest: any[]) => {
        into.push(path.basename(String(file)))
        return real(file, ...rest)
      }
    const counted =
      (real: (...args: any[]) => any) =>
      (...args: any[]) => {
        read += 1
        return real(...args)
      }
    await withFiles({ openSync: named(opened), lstatSync: named(looked), readSync: counted, readFileSync: counted }, () => published())
    expect(opened).toEqual(['usage.jsonl'])
    // Where a file cannot be opened so as to refuse a link, the name is looked at before and after it is opened
    expect(looked).toEqual(process.platform === 'win32' ? ['telemetry-off', 'usage.jsonl', 'usage.jsonl'] : ['telemetry-off'])
    expect(read).toBe(0)
    expect(lines()).toHaveLength(2)
  })
})

describe('what cannot be trusted', () => {
  const posted = (posts: string[]) => posts.map((p) => JSON.parse(p) as { events: { name: string; properties: unknown }[] }).flatMap((b) => b.events)

  test('a line naming something every object has, with a number where properties belong, is not an event', async () => {
    told()
    const { id, at, tag } = aLine()
    const lines = [
      { id, name: '__proto__', at, properties: 123456789012345, tag },
      { id, name: 'constructor', at, properties: {}, tag },
      { id, name: 'toString', at, properties: 'account 4242', tag },
      { id, name: 'page.published', at, properties: ['claude-code', 'new', 'custom', 'under 10 KB'], tag },
      { id, name: 'page.published', at, properties: null, tag },
      { id, name: 42, at, properties: {}, tag },
    ]
    writeFileSync(spool(), lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    expect(posted(posts)).toEqual([])
    expect(posts.join('')).not.toMatch(/123456789012345|4242/)
  })
  test('what is sent is built from the table of what is allowed, and from nothing else in the line', async () => {
    told()
    const { id, at, tag } = aLine()
    // Properties that are allowed, on an object of a kind that carries more than its own keys
    writeFileSync(
      spool(),
      `{"id":"${id}","name":"agent.woken","at":"${at}","properties":{"result":"resumed","agent":"codex"},"tag":"${tag}","note":"for acme"}\n`,
    )
    const posts: string[] = []
    let now = 0
    const sender = noting(posts, () => now)
    await sender.tick()
    now += 30_000
    await sender.tick()
    sender.stop()
    // The id is one made as the line was taken, and the rest is the line's
    expect(posted(posts)).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'agent.woken', at, properties: { result: 'resumed', agent: 'codex' } },
    ])
    expect(posts.join('')).not.toContain(id)
  })
  test('something that is not an ordinary file where the lines are kept is neither written to nor read', async () => {
    told()
    // A folder stands where the file would be: reading or writing it as a file could never end well
    mkdirSync(spool())
    expect(() => published()).not.toThrow()
    const posts: string[] = []
    const sender = noting(posts)
    await expect(sender.tick()).resolves.toBeUndefined()
    sender.stop()
    expect(posts).toEqual([])
  })
  // A pipe with nobody at its other end holds whoever opens it in the ordinary way, for ever.
  // Windows has no such thing to put in a folder.
  test.skipIf(process.platform === 'win32')('a pipe where the settings, the off file or the lines would be is never waited on', async () => {
    told()
    const good = JSON.stringify(aLine())
    const settings = readFileSync(settingsFile(), 'utf8')
    const pipe = (file: string) => {
      rmSync(file, { force: true })
      execFileSync('mkfifo', [file])
    }
    // Where the lines are kept: a command neither writes to it nor waits, and the connector neither reads it nor waits
    pipe(spool())
    published()
    let posts: string[] = []
    let sender = noting(posts)
    for (let i = 0; i < 25; i++) published()
    await sender.tick()
    expect(posts).toHaveLength(1)
    // Taken to be read, found to be no file, and removed. Stopping puts what is left back, and does not wait either
    expect(waiting()).toEqual([])
    pipe(spool())
    sender.stop()
    rmSync(spool())
    // Where a connector that died would have left what it took
    pipe(`${spool()}.taken`)
    writeFileSync(spool(), `${good}\n`.repeat(20))
    posts = []
    sender = noting(posts)
    await sender.tick()
    sender.stop()
    expect(posts).toHaveLength(1)
    expect(waiting()).toEqual([])
    // Where the settings are: nothing is known, so nobody has been told and nothing is recorded
    pipe(settingsFile())
    const command = await another()
    expect(command.wasTold()).toBe(false)
    expect(command.status()).toMatchObject({ enabled: true })
    command.heed()
    command.tellOnce(() => {}, false)
    published(command)
    expect(waiting()).toEqual([])
    rmSync(settingsFile())
    writeFileSync(settingsFile(), settings)
    // Where the off file is: it is off, since something is there, and what it says is not waited for
    pipe(offFile())
    expect(command.status()).toMatchObject({ enabled: false, because: 'the file telemetry-off' })
  })
  test.skipIf(process.platform === 'win32')('a link where the settings or the lines would be is never followed', async () => {
    told()
    const good = JSON.stringify(aLine())
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-usage-test-'))
    try {
      // The lines: a link to a file somewhere else, which holds events exactly as It writes them
      const target = path.join(elsewhere, 'lines')
      writeFileSync(target, `${good}\n`.repeat(20))
      symlinkSync(target, spool())
      published()
      expect(readFileSync(target, 'utf8')).toBe(`${good}\n`.repeat(20))
      const posts: string[] = []
      const sender = noting(posts)
      await sender.tick()
      sender.stop()
      expect(posts).toEqual([])
      // The link is taken away, and what it pointed to is left alone
      expect(waiting()).toEqual([])
      expect(readFileSync(target, 'utf8')).toBe(`${good}\n`.repeat(20))
      // A link to nowhere, which writing through would make into a file somewhere else
      symlinkSync(path.join(elsewhere, 'made'), spool())
      published()
      expect(existsSync(path.join(elsewhere, 'made'))).toBe(false)
      rmSync(spool())
      // The settings: a link to settings that say a person was told
      const real = path.join(elsewhere, 'settings')
      writeFileSync(real, readFileSync(settingsFile()))
      rmSync(settingsFile())
      symlinkSync(real, settingsFile())
      const command = await another()
      expect(command.wasTold()).toBe(false)
      published(command)
      expect(waiting()).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  test('where a file cannot be opened so as to refuse a link, as on Windows, a link is still neither written nor read through', async () => {
    told()
    const good = JSON.stringify(aLine())
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-usage-test-'))
    // Away from Windows the two flags are taken away, which leaves the program what Windows gives it
    if (process.platform !== 'win32') {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      const constants = { ...actual.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined }
      vi.doMock('node:fs', () => ({ ...actual, constants, default: { ...actual, constants } }))
    }
    try {
      const program = await another()
      // The lines: a link to a file somewhere else, which holds events exactly as It writes them
      const target = path.join(elsewhere, 'lines')
      writeFileSync(target, `${good}\n`.repeat(20))
      try {
        symlinkSync(target, spool())
      } catch {
        // This user may not make links on this machine, so there is no link to refuse
        return
      }
      published(program)
      expect(readFileSync(target, 'utf8')).toBe(`${good}\n`.repeat(20))
      const posts: string[] = []
      const sender = noting(posts, () => 0, program)
      await sender.tick()
      sender.stop()
      expect(posts).toEqual([])
      // The link is taken away, and what it pointed to is left alone
      expect(waiting()).toEqual([])
      expect(readFileSync(target, 'utf8')).toBe(`${good}\n`.repeat(20))
      // A link to nowhere, which writing through would make into a file somewhere else
      symlinkSync(path.join(elsewhere, 'made'), spool())
      published(program)
      expect(existsSync(path.join(elsewhere, 'made'))).toBe(false)
      rmSync(spool())
      // Without a link in the way, the same program records as it should
      published(program)
      expect(lines()).toHaveLength(1)
      // The settings: a link to settings that say a person was told
      const real = path.join(elsewhere, 'settings')
      writeFileSync(real, readFileSync(settingsFile()))
      rmSync(settingsFile())
      symlinkSync(real, settingsFile())
      expect(program.wasTold()).toBe(false)
    } finally {
      vi.doUnmock('node:fs')
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  // What a look at a name cannot guard against: the file is replaced after any look and before
  // it is opened. Whatever looks first is given an ordinary file to see.
  test.skipIf(process.platform === 'win32').each([
    ['a pipe', (file: string) => execFileSync('mkfifo', [file])],
    ['a link to a file somewhere else', (file: string, target: string) => symlinkSync(target, file)],
  ])('%s put in a file’s place at the moment it is opened is neither waited on nor followed', async (_what, put) => {
    told()
    const good = JSON.stringify(aLine())
    const settings = readFileSync(settingsFile(), 'utf8')
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-usage-test-'))
    const target = path.join(elsewhere, 'target')
    let replaced: string | null = null
    /** For as long as `run` takes, the file of this name is replaced the instant before it is opened, once. */
    const replacing = async (name: string, holding: string, run: () => unknown) => {
      writeFileSync(target, holding)
      replaced = null
      const now = (file: unknown) => {
        if (replaced !== null || path.basename(String(file)) !== name) return
        replaced = String(file)
        rmSync(replaced, { force: true })
        put(replaced, target)
      }
      await withFiles(
        {
          openSync:
            (real) =>
            (file: fs.PathLike, ...rest: any[]) => {
              now(file)
              return real(file, ...rest)
            },
          lstatSync:
            (real) =>
            (file: fs.PathLike, ...rest: any[]) => {
              const seen = real(file, ...rest)
              now(file)
              return seen
            },
        },
        run,
      )
      expect(replaced).not.toBeNull()
      expect(readFileSync(target, 'utf8')).toBe(holding)
      rmSync(replaced!, { force: true })
    }
    try {
      // The settings, as a command reads them
      const command = await another()
      await replacing('telemetry.json', settings, () => expect(command.wasTold()).toBe(false))
      writeFileSync(settingsFile(), settings)
      // The lines, as a command adds one
      await replacing('usage.jsonl', '', () => published())
      // The lines a connector has taken, as they are read
      writeFileSync(`${spool()}.taken`, `${good}\n`.repeat(20))
      const posts: string[] = []
      const sender = noting(posts)
      await replacing('usage.jsonl.taken', `${good}\n`.repeat(20), () => sender.tick())
      sender.stop()
      expect(posts).toEqual([])
      expect(waiting()).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  test('however many files stand in It’s folder, a pass and a turning off touch only the two they know by name', async () => {
    told()
    const good = aLine()
    const one = Array.from({ length: 400 }, () => `${JSON.stringify({ ...good, id: randomUUID() })}\n`).join('')
    for (let i = 0; i < 300; i++) writeFileSync(`${spool()}.${10_000 + i}`, '')
    // One a connector had taken and was stopped before sending, and one the commands have left since
    writeFileSync(`${spool()}.taken`, one)
    writeFileSync(spool(), one)
    const posts: string[] = []
    const sender = noting(posts)
    const opened = new Set<string>()
    let bytes = 0
    let listed = 0
    let removed = 0
    const lines = (file: unknown) => path.basename(String(file)).startsWith('usage.jsonl')
    const counting = {
      openSync:
        (real: (...args: any[]) => any) =>
        (file: fs.PathLike, ...rest: any[]) => {
          if (lines(file)) opened.add(String(file))
          return real(file, ...rest)
        },
      readSync:
        (real: (...args: any[]) => any) =>
        (...args: any[]) => {
          const n = real(...args) as number
          bytes += n
          return n
        },
      // The folder is never listed, in either of the ways there are to list one
      readdirSync:
        (real: (...args: any[]) => any) =>
        (...args: any[]) => {
          listed += 1
          return real(...args)
        },
      opendirSync:
        (real: (...args: any[]) => any) =>
        (...args: any[]) => {
          listed += 1
          return real(...args)
        },
      rmSync:
        (real: (...args: any[]) => any) =>
        (file: fs.PathLike, ...rest: any[]) => {
          if (lines(file)) removed += 1
          return real(file, ...rest)
        },
    }
    await withFiles(counting, () => sender.tick())
    // Settled before any of it is read: two files, a fixed number of bytes, and no more events than may wait
    expect(listed).toBe(0)
    expect([...opened].map((f) => path.basename(f)).sort()).toEqual(['usage.jsonl.taken'])
    expect(bytes).toBeLessThanOrEqual(2 * 256 * 1024 + 16 * 1024)
    expect(removed).toBeLessThanOrEqual(2)
    expect(sent(posts).flatMap((b) => b.events)).toHaveLength(800)
    expect(existsSync(spool())).toBe(false)
    expect(existsSync(`${spool()}.taken`)).toBe(false)
    // Turned off, the sender removes what was waiting under those two names and nothing else
    writeFileSync(`${spool()}.taken`, one)
    writeFileSync(spool(), one)
    writeFileSync(offFile(), 'command')
    removed = 0
    await withFiles(counting, () => sender.tick())
    sender.stop()
    expect(listed).toBe(0)
    expect(removed).toBeLessThanOrEqual(2)
    expect(existsSync(spool())).toBe(false)
    expect(existsSync(`${spool()}.taken`)).toBe(false)
    expect(waiting()).toHaveLength(300)
  })
  test('a folder left where a taken file would be keeps nothing else from being read or removed', async () => {
    told()
    const good = JSON.stringify(aLine())
    // One that cannot be removed, since it is not empty
    const stuck = `${spool()}.taken`
    mkdirSync(stuck)
    writeFileSync(path.join(stuck, 'kept'), '')
    writeFileSync(spool(), `${good}\n`.repeat(20))
    const posts: string[] = []
    const sender = noting(posts)
    await sender.tick()
    sender.stop()
    expect(posts).toHaveLength(1)
    expect(waiting()).toEqual(['usage.jsonl.taken'])
    // And turning reporting off removes everything that can be
    published()
    usage.set(false)
    expect(waiting()).toEqual(['usage.jsonl.taken'])
  })
  test('stopping puts back no more than the file is ever let hold', () => {
    told()
    const sender = noting([])
    for (let i = 0; i < 1000; i++) published()
    sender.stop()
    expect(statSync(spool()).size).toBeLessThanOrEqual(256 * 1024)
    // And again and again, as a service restarted every minute would
    for (let round = 0; round < 5; round++) {
      const next = noting([])
      for (let i = 0; i < 1000; i++) published()
      next.stop()
    }
    expect(statSync(spool()).size).toBeLessThanOrEqual(256 * 1024)
  })
})
