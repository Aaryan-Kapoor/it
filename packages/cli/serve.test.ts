// The service that runs the backend: its settings file, the backend program it fetches, and
// what it does with the program once it has it. Where a test starts the backend, that is the
// real program, in a folder of its own, on ports the system gave. Nothing here reaches a
// remote: a small server on this machine stands in for the release the program is fetched from.
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PORTS } from '@it/protocol'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { build } from 'esbuild'
import { zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { FUNCTIONS, FUNCTIONS_HASH } from './src/functions.generated'
import { ask, backendAt, Problem, VERSION } from './src/lib'
import { asAdmin, endOf, fetchProgram, type Running, startBackend } from './src/serve/backend'
import { cannotRunHere, doorKey, instanceName, makeConfig, noteLoaded, programFile, RELEASE, readConfig, type ServiceConfig } from './src/serve/config'
import { startDoor } from './src/serve/door'
import { erasing, standsAs, teller } from './src/serve/index'
import { environment, launchdPlist, logFile, systemdUnit } from './src/service'
import * as usage from './src/usage'
import { bases } from './test-ports'

// Where this machine keeps its settings is nothing to these tests, which make a person's folder
// of their own and look for the service's definition there. The tests are started without it
// (see vitest.config.ts), and it is taken away here as well, since this file is also run by
// Bun's own runner, which does not read that.
delete process.env.XDG_CONFIG_HOME

/** The backend program on this machine: the one IT_BACKEND_BIN names, or the one the `convex` package keeps. */
const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, 'convex-local-backend')].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)

/** Something that has a port and says nothing on it. Null when the port is not free. */
const listening = (port: number, address = '127.0.0.1') =>
  new Promise<net.Server | null>((resolve) => {
    const server = net.createServer((socket) => socket.destroy())
    server.once('error', () => resolve(null)).listen(port, address, () => resolve(server))
  })
const closed = (server: net.Server | http.Server) => new Promise<void>((resolve) => server.close(() => resolve()))
/**
 * The base ports this file's tests take: each from a block of the file's own, below the ports
 * the system hands out by itself to whatever asks for one, and each held from when a test takes
 * it until the test is over, so that no other run of the tests on this machine has the same one.
 */
const ports = bases(14_000, 40)

const KEPT = ['IT_HOME', 'IT_PORT', 'IT_BACKEND_BIN', 'IT_URL', 'IT_SITE_URL'] as const
let before: Record<string, string | undefined>
let folder: string
/** Each test has an It folder of its own and a base port of its own, and nothing of whoever runs the tests. */
beforeEach(async () => {
  before = Object.fromEntries(KEPT.map((name) => [name, process.env[name]]))
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-serve-'))
  process.env.IT_HOME = folder
  process.env.IT_PORT = String(await ports.next())
  if (program) process.env.IT_BACKEND_BIN = program
  delete process.env.IT_URL
  delete process.env.IT_SITE_URL
})
afterEach(async () => {
  for (const name of KEPT) {
    if (before[name] === undefined) delete process.env[name]
    else process.env[name] = before[name]
  }
  rmSync(folder, { recursive: true, force: true })
  // Given back last, when everything the test started on them has stopped
  await ports.release()
})
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (err) => (err instanceof Problem ? err.code : `not a refusal: ${String(err)}`),
  )
/**
 * A refusal's code, and with it what the refusal says of itself: for a backend program that
 * ended, that is what the program said. Where a start is refused for another reason than the
 * one a test looks for, what the test prints then says which.
 */
const refused = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (err) => (err instanceof Problem ? { code: err.code, hint: err.hint } : { code: `not a refusal: ${String(err)}` }),
  )
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (what: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await what()) return true
  return false
}

describe.skipIf(process.platform === 'win32')('the look at whether a port is free, before the service starts', () => {
  /** Where each runtime the program runs under is on this machine. The standalone program runs under Bun, which hands a listener its connections at another moment than Node does. */
  const bun = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, 'bun'))
    .find((file) => existsSync(file))
  let scratch = ''
  let probe = ''
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'it-look-'))
    probe = path.join(scratch, 'probe.mjs')
    // Looks at one port over and over for a while, as the service looks once when it starts, and says how long the slowest look took
    const contents = `
      import { portFree } from ${JSON.stringify(path.join(__dirname, 'src/serve/index'))}
      const [port, forMs] = process.argv.slice(2).map(Number)
      let looks = 0
      let slowest = 0
      let said = true
      process.stdout.write('looking\\n')
      for (const until = Date.now() + forMs; said === true && Date.now() < until; looks++) {
        const began = Date.now()
        said = await Promise.race([portFree(port), new Promise((held) => setTimeout(() => held('held up'), 3000))])
        slowest = Math.max(slowest, Date.now() - began)
      }
      process.stdout.write(JSON.stringify({ looks, slowest, said }), () => process.exit(0))
    `
    await build({
      stdin: { contents, resolveDir: __dirname, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: probe,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  for (const [name, runtime] of [
    ['Node', process.execPath],
    ['Bun', bun],
  ] as const)
    test.skipIf(!runtime)(
      `under ${name}, something that connects while the port is being looked at, and waits there for an answer, never holds the look up`,
      async () => {
        const port = Number(process.env.IT_PORT)
        const child = spawn(runtime!, [probe, String(port), '1500'], { stdio: ['ignore', 'pipe', 'inherit'] })
        let out = ''
        child.stdout.on('data', (piece) => (out += piece))
        const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        // Something that asks the port over and over, as a check of whether It is up does, and never lets go of a connection it was given
        const sockets: net.Socket[] = []
        let given = 0
        const knock = setInterval(() => {
          if (!out.startsWith('looking')) return
          const socket = net.connect(port, '127.0.0.1')
          sockets.push(socket)
          socket.on('error', () => {}).once('connect', () => given++)
        }, 1)
        try {
          await ended
          const { looks, slowest, said } = JSON.parse(out.slice(out.indexOf('\n') + 1)) as { looks: number; slowest: number; said: unknown }
          expect([said, slowest < 3000, looks > 0]).toEqual([true, true, true])
          // Bun hands a listener its connections while the look is still under way, so some were given to it in that time
          if (name === 'Bun') expect(given).toBeGreaterThan(0)
        } finally {
          clearInterval(knock)
          for (const socket of sockets) socket.destroy()
          child.kill('SIGKILL')
        }
      },
      30_000,
    )
})

describe('what the service tells the backend of how it stands', () => {
  const stands = { on: false, wanted: false, addresses: [] as string[], background: true, usage: true }
  /** Something that is told, which notes what it was told and refuses what the test says it refuses. */
  const backendThat = (refuses: (said: Record<string, unknown>) => boolean = () => false) => {
    const told: Record<string, unknown>[] = []
    const failed: Record<string, unknown>[] = []
    return {
      told,
      failed,
      tell: async (said: Record<string, unknown>) => {
        if (refuses(said)) {
          failed.push(said)
          throw Object.assign(new Error('refused'), { code: 'refused' })
        }
        told.push(said)
      },
    }
  }

  test('it says how its door stands, whether It starts by itself from this folder, and whether usage counts are being sent', () => {
    // A folder that was only just made: nothing is registered for it, and nobody has been told of usage reporting
    expect(standsAs({ network: false }, true, 21000)).toEqual({ on: false, wanted: true, addresses: [], background: false, usage: false })
    const open = standsAs({ network: true }, true, 21000)
    expect([open.on, open.addresses.every((address) => address.endsWith(':21000'))]).toEqual([true, true])
  })

  test.skipIf(process.platform === 'win32')(
    'whether It starts by itself and whether usage counts are sent are each said as they are at that moment, and differently as soon as they are different',
    () => {
      const user = mkdtempSync(path.join(os.tmpdir(), 'it-stands-'))
      const kept = { PATH: process.env.PATH, off: process.env.IT_TELEMETRY_ENABLED, track: process.env.DO_NOT_TRACK }
      const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
      const said = () => {
        const { background, usage } = standsAs({ network: false }, false, 21000)
        return { background, usage }
      }
      try {
        // Nothing where this runs turns usage reporting off, and systemd, asked, says that the service is enabled
        delete process.env.IT_TELEMETRY_ENABLED
        delete process.env.DO_NOT_TRACK
        mkdirSync(path.join(user, 'commands'))
        writeFileSync(path.join(user, 'commands', 'systemctl'), '#!/bin/sh\ncase " $* " in *" is-enabled "*) echo enabled ;; esac\nexit 0\n', { mode: 0o755 })
        process.env.PATH = path.join(user, 'commands')
        expect(said()).toEqual({ background: false, usage: false })
        // Counting begins with a first command, which makes the id counts are sent under
        usage.begin()
        expect(said()).toEqual({ background: false, usage: true })
        // They turn it off, and on again
        usage.set(false)
        expect(said()).toEqual({ background: false, usage: false })
        usage.set(true)
        expect(said()).toEqual({ background: false, usage: true })
        // The service is registered for this folder, and taken away again
        const registered =
          process.platform === 'linux' ? path.join(user, '.config/systemd/user/it.service') : path.join(user, 'Library/LaunchAgents/dev.it.plist')
        const command = ['/bin/it', 'serve', '--log', logFile()]
        mkdirSync(path.dirname(registered), { recursive: true })
        writeFileSync(registered, process.platform === 'linux' ? systemdUnit(command, environment()) : launchdPlist(command, environment()))
        expect(said()).toEqual({ background: true, usage: true })
        rmSync(registered)
        expect(said()).toEqual({ background: false, usage: true })
      } finally {
        homedir.mockRestore()
        process.env.PATH = kept.PATH
        if (kept.off !== undefined) process.env.IT_TELEMETRY_ENABLED = kept.off
        if (kept.track !== undefined) process.env.DO_NOT_TRACK = kept.track
        rmSync(user, { recursive: true, force: true })
      }
    },
  )

  test('it is said once, and again only when something of it has changed', async () => {
    const backend = backendThat()
    const report = teller(backend.tell, false)
    await report(stands)
    await report({ ...stands })
    expect(backend.told).toEqual([stands])
    // Usage reporting is turned off, and then the service is registered no more
    await report({ ...stands, usage: false })
    await report({ ...stands, usage: false, background: false })
    expect(backend.told.slice(1)).toEqual([
      { ...stands, usage: false },
      { ...stands, usage: false, background: false },
    ])
  })

  test('a backend that serves the functions of an earlier version is told how the door stands and nothing more, so that the network still follows its setting', async () => {
    const backend = backendThat((said) => 'background' in said || 'usage' in said)
    const report = teller(backend.tell, true)
    await report(stands)
    await report({ ...stands, on: true, wanted: true, addresses: ['http://192.168.1.20:21000'] })
    // What it does not take is never said to it, and what it does take is said as it changes
    expect(backend.failed).toEqual([])
    expect(backend.told).toEqual([
      { on: false, wanted: false, addresses: [] },
      { on: true, wanted: true, addresses: ['http://192.168.1.20:21000'] },
    ])
    await report({ ...stands, on: true, wanted: true, addresses: ['http://192.168.1.20:21000'], usage: false })
    expect(backend.told).toHaveLength(2)
  })

  test('a backend that refuses everything said and takes how the door stands is told that much, and everything again a while later', async () => {
    let takesAll = false
    const backend = backendThat((said) => !takesAll && 'background' in said)
    let now = 1_000_000
    const report = teller(backend.tell, false, () => now)
    await report(stands)
    expect([backend.failed, backend.told]).toEqual([[stands], [{ on: false, wanted: false, addresses: [] }]])
    // For a while it is told only what it takes, and nothing while that has not changed
    now += 60_000
    await report(stands)
    await report({ ...stands, usage: false })
    expect([backend.failed.length, backend.told.length]).toEqual([1, 1])
    // After that it is told everything once more, and takes it this time
    takesAll = true
    now += 600_000
    await report(stands)
    expect(backend.told.at(-1)).toEqual(stands)
  })

  test('a backend that cannot be told at all fails the telling with what it failed with, and is told again the next time', async () => {
    let reachable = false
    const backend = backendThat(() => !reachable)
    const report = teller(backend.tell, false)
    await expect(report(stands)).rejects.toMatchObject({ code: 'refused' })
    expect(backend.failed).toEqual([stands, { on: false, wanted: false, addresses: [] }])
    reachable = true
    await report(stands)
    expect(backend.told).toEqual([stands])
  })
})

describe.skipIf(!program)('It’s settings file', () => {
  test('is made on a first run with secrets of its own, for this person alone, and is never made a second time', () => {
    expect(readConfig()).toBeNull()
    const made = makeConfig()
    expect(made).toEqual({
      port: Number(process.env.IT_PORT),
      network: false,
      instanceSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      adminKey: expect.stringMatching(/^it-[0-9a-f]{12}\|[0-9a-f]{40,}$/),
      sessionSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    // The key is the one the backend program makes for this folder's own name
    expect(made.adminKey.startsWith(`${instanceName(made.instanceSecret)}|`)).toBe(true)
    const file = path.join(folder, 'service.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(made)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // Nothing is left beside it of how it was written
    expect(readdirSync(folder)).toEqual(['service.json'])
    expect(readConfig()).toEqual(made)
    expect(makeConfig()).toEqual(made)
    // Another folder has other secrets
    const other = mkdtempSync(path.join(os.tmpdir(), 'it-serve-'))
    try {
      process.env.IT_HOME = other
      const theirs = makeConfig()
      for (const secret of ['instanceSecret', 'adminKey', 'sessionSecret'] as const) expect(theirs[secret]).not.toBe(made[secret])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('counts from the usual port unless IT_PORT names another, and IT_PORT is believed over the file from then on', () => {
    delete process.env.IT_PORT
    expect(makeConfig().port).toBe(PORTS.base)
    process.env.IT_PORT = '25000'
    expect(readConfig()!.port).toBe(25000)
    // What was loaded is noted beside settings that stay as the file has them
    noteLoaded({ functions: 'a-hash', backend: 'a-release' })
    expect(JSON.parse(readFileSync(path.join(folder, 'service.json'), 'utf8'))).toMatchObject({ port: PORTS.base, functions: 'a-hash', backend: 'a-release' })
    expect(readConfig()).toMatchObject({ port: 25000, functions: 'a-hash', backend: 'a-release' })
    // A port with no room above it for the backend's two is no port to count from
    for (const bad of ['65530', '0', '-1', '21000.5', 'port']) {
      process.env.IT_PORT = bad
      expect(() => readConfig(), bad).toThrow(/IT_PORT/)
    }
    // Nor is one that no browser opens a page on, for the site or for the pages one port up: It would run there and could never be opened
    process.env.IT_PORT = '6000'
    expect(() => readConfig()).toThrow('IT_PORT=6000 would put It’s site on port 6000, which browsers refuse to open.')
    process.env.IT_PORT = '5999'
    expect(() => readConfig()).toThrow('IT_PORT=5999 would put the pages agents make on port 6000, which browsers refuse to open.')
    for (const fine of ['5998', '6001', '6100', '8080']) {
      process.env.IT_PORT = fine
      expect(readConfig()!.port, fine).toBe(Number(fine))
    }
  })

  test('that is not as It wrote it is refused, and its secrets are not replaced with new ones', () => {
    const file = path.join(folder, 'service.json')
    const good = makeConfig()
    for (const damaged of ['{"port":', JSON.stringify({ ...good, instanceSecret: 'short' }), JSON.stringify({ ...good, adminKey: undefined }), '[]']) {
      writeFileSync(file, damaged)
      expect(() => readConfig()).toThrow(/are not as It wrote them/)
      expect(() => makeConfig()).toThrow(/are not as It wrote them/)
      expect(readFileSync(file, 'utf8')).toBe(damaged)
    }
  })

  test('cannot be made before the backend program is on the machine, since the program makes the key', () => {
    process.env.IT_BACKEND_BIN = path.join(folder, 'no-such-program')
    expect(() => makeConfig()).toThrow(/could not make the key/)
    expect(existsSync(path.join(folder, 'service.json'))).toBe(false)
    expect(programFile()).toBe(path.join(folder, 'no-such-program'))
  })
})

describe('what the service does when it is told that a person has erased everything', () => {
  test('where the copies of the database cannot be removed it says so by the fixed code, and fails, so that it is told of the erasing again', () => {
    const lines: string[] = []
    const erased = erasing((line) => lines.push(line))
    // With no copy to remove there is nothing to say
    erased('the person who erased everything')
    expect(lines).toEqual([])
    // What It keeps of the erasings is there, and is not as It wrote it: nothing is removed without knowing which copies are whose
    mkdirSync(path.join(folder, 'backend'), { recursive: true })
    writeFileSync(path.join(folder, 'backend', 'erased.json'), 'something else than It wrote')
    expect(() => erased('the person who erased everything')).toThrow(expect.objectContaining({ code: 'record_unread' }))
    expect(lines).toEqual([
      'backend: everything was erased, and the copies of the database from before an update could not be removed (record_unread); it will be tried when the backend asks again',
    ])
    // Neither the file's name nor a word of what went wrong is in the line
    expect(lines.join('\n')).not.toContain(folder)
    expect(lines.join('\n')).not.toContain('erased.json')
  })
})

describe('fetching the backend program', () => {
  const name = `convex-local-backend${process.platform === 'win32' ? '.exe' : ''}`
  const made = Buffer.from(`#!/bin/sh\necho made up\n${'x'.repeat(100_000)}`)
  const archive = Buffer.from(zipSync({ [name]: new Uint8Array(made) }))
  const sum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  let release: http.Server
  let at: string
  beforeAll(async () => {
    // What stands in for the release: one archive, one that holds something else, and an address that answers with nothing
    const other = Buffer.from(zipSync({ 'something-else': new Uint8Array(made) }))
    release = http.createServer((req, res) => {
      if (req.url === '/archive.zip') return res.writeHead(200, { 'content-type': 'application/zip' }).end(archive)
      if (req.url === '/other.zip') return res.writeHead(200, { 'content-type': 'application/zip' }).end(other)
      if (req.url === '/moved.zip') return res.writeHead(302, { location: '/archive.zip' }).end()
      res.writeHead(404).end('not here')
    })
    await new Promise<void>((resolve) => release.listen(0, '127.0.0.1', resolve))
    at = `http://127.0.0.1:${(release.address() as net.AddressInfo).port}`
  })
  afterAll(() => closed(release))

  test('an archive with the checksum written down for it is unpacked into place, as a program that can be run', async () => {
    const file = path.join(folder, 'backend', 'bin', 'a-release', name)
    // The release answers with a redirect to where the file is, which is followed
    await fetchProgram({ url: `${at}/moved.zip`, sha256: sum(archive) }, file)
    expect(readFileSync(file).equals(made)).toBe(true)
    // It is the person's alone, to run as well as to read
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file))).toEqual([name])
  })

  test('an archive that is not the one expected is refused, and nothing of it is left behind', async () => {
    const file = path.join(folder, 'backend', 'bin', 'a-release', name)
    // One byte of the checksum is another: the file fetched is not the file that was meant
    const wrong = sum(archive).replace(/^./, (c) => (c === '0' ? '1' : '0'))
    expect(await refusal(fetchProgram({ url: `${at}/archive.zip`, sha256: wrong }, file))).toBe('checksum')
    expect(existsSync(path.join(folder, 'backend'))).toBe(false)
    // An archive that checks out and does not hold the program is refused as well
    const other = Buffer.from(await (await fetch(`${at}/other.zip`)).arrayBuffer())
    expect(await refusal(fetchProgram({ url: `${at}/other.zip`, sha256: sum(other) }, file))).toBe('backend_program')
    expect(readdirSync(path.dirname(file))).toEqual([])
  })

  test('a release that cannot be reached, or answers with no file, is said to be that', async () => {
    const file = path.join(folder, 'backend', 'bin', 'a-release', name)
    expect(await refusal(fetchProgram({ url: `${at}/missing.zip`, sha256: sum(archive) }, file))).toBe('offline')
    expect(await refusal(fetchProgram({ url: 'http://127.0.0.1:9/archive.zip', sha256: sum(archive) }, file))).toBe('offline')
    expect(existsSync(path.join(folder, 'backend'))).toBe(false)
  })
})

describe.skipIf(!program)('the backend program, started by the service', () => {
  // How long a test here is given. On Windows every start asks the system which programs are
  // running, through a program of its own that takes seconds to begin, and every stop gives the
  // backend program a while to go before it is ended
  const LONG = process.platform === 'win32' ? 300_000 : 60_000
  const HOOK = 120_000
  let running: Running[]
  let said: string[]
  const say = (line: string) => void said.push(line)
  const start = async (config: ServiceConfig) => {
    const backend = await startBackend(config, say)
    running.push(backend)
    return backend
  }
  const lock = () => path.join(folder, 'backend', 'lock')
  const healthy = (site: string) =>
    fetch(`${site}/health`).then(
      (r) => r.ok,
      () => false,
    )
  beforeEach(() => {
    running = []
    said = []
  })
  // Whatever a test started is stopped before its folder is removed. On Windows a backend
  // program is given a while to go before it is ended, and each one a test started is waited for
  afterEach(async () => {
    for (const backend of running) await backend.stop()
  }, HOOK)

  test(
    'answers on this machine only, at the two ports counted from the base, with It’s functions and settings loaded',
    async () => {
      const config = makeConfig()
      const backend = await start(config)
      expect(backend).toMatchObject({ ...backendAt(config.port), adminKey: config.adminKey })
      expect(backend.api).toBe(`http://127.0.0.1:${config.port + PORTS.backendApi}`)
      expect(backend.site).toBe(`http://127.0.0.1:${config.port + PORTS.backendSite}`)
      expect(await (await fetch(`${backend.api}/instance_name`)).text()).toBe(instanceName(config.instanceSecret))
      // The functions answer, which they do only once they are loaded
      expect(await healthy(backend.site)).toBe(true)
      // The settings they read are the backend's
      const settings = (await (
        await fetch(`${backend.api}/api/list_environment_variables`, { headers: { authorization: `Convex ${config.adminKey}` } })
      ).json()) as {
        environmentVariables: Record<string, string>
      }
      expect(settings.environmentVariables).toEqual({ IT_PORT: String(config.port), IT_DOOR_KEY: doorKey(config) })
      // The backend signs under its own HTTP address, which is where this machine reaches it
      const signs = (await (await fetch(`${backend.site}/cli/config`)).json()) as { issuer?: string }
      if (signs.issuer !== undefined) expect(signs.issuer).toBe(backend.site)
      // What was loaded is written down, with the release that ran
      expect(readConfig()).toMatchObject({ functions: expect.stringMatching(/^[0-9a-f]{64}$/), backend: RELEASE })
      expect(said).toEqual([expect.stringMatching(/^backend: started \(pid \d+\)$/), `backend: functions loaded (${FUNCTIONS_HASH.slice(0, 12)})`])
      // No other machine can reach it: it listens on this machine's own address and no other
      for (const address of Object.values(os.networkInterfaces()).flatMap((all) => all ?? [])) {
        if (address.internal || address.family !== 'IPv4') continue
        const reached = await new Promise<boolean>((resolve) => {
          const socket = net.connect(config.port + PORTS.backendApi, address.address)
          socket.once('connect', () => resolve(true)).once('error', () => resolve(false))
          socket.setTimeout(1000, () => resolve(false))
        }).finally(() => {})
        expect([address.address, reached]).toEqual([address.address, false])
      }
    },
    LONG,
  )

  test(
    'runs a function as its administrator, the internal ones included, and refuses whoever has no key',
    async () => {
      const config = makeConfig()
      const backend = await start(config)
      const key = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }
      const made = (await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'a machine', publicKey: key })) as { machineId: string }
      expect(made.machineId).toEqual(expect.any(String))
      // The same function named with a dot is the same function, and the same key is the same machine
      expect(await asAdmin(backend, 'bridge.enroll', { subject: 'owner', name: 'a machine', publicKey: key })).toEqual(made)
      expect(await asAdmin(backend, 'bridge:machine', { id: made.machineId })).toMatchObject({ id: made.machineId, revoked: false })
      // With no key, or a key that is not this backend's, an internal function is not run
      await expect(
        asAdmin({ api: backend.api, adminKey: `${instanceName(config.instanceSecret)}|${'00'.repeat(40)}` }, 'bridge:machine', { id: made.machineId }),
      ).rejects.toThrow()
      const open = await fetch(`${backend.api}/api/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'bridge:machine', args: { id: made.machineId }, format: 'json' }),
      })
      expect(await open.text()).not.toContain(made.machineId)
    },
    LONG,
  )

  test(
    'is one at a time for a folder: a second service says so and stops, and the first goes on',
    async () => {
      const config = makeConfig()
      const first = await start(config)
      expect(await refusal(startBackend(readConfig()!, say))).toBe('already_running')
      // Nor on other ports: it is the folder that is taken
      process.env.IT_PORT = String(await ports.next())
      expect(await refusal(startBackend(readConfig()!, say))).toBe('already_running')
      expect(await healthy(first.site)).toBe(true)
      expect(JSON.parse(readFileSync(lock(), 'utf8'))).toMatchObject({ pid: process.pid, program: expect.any(Number), api: first.api })
      await first.stop()
      // Stopped, it lets the folder go, and another may start
      expect(existsSync(lock())).toBe(false)
      process.env.IT_PORT = String(config.port)
      const again = await start(readConfig()!)
      expect(await healthy(again.site)).toBe(true)
    },
    LONG,
  )

  test(
    'stops its backend when another service has taken the folder from it, and leaves that one’s lock alone',
    async () => {
      const backend = await start(makeConfig())
      // Another service could take the folder only from one it could not tell was alive. Its lock is then the one that stands.
      const theirs = JSON.stringify({ pid: process.pid, holder: 'another-service' })
      writeFileSync(lock(), theirs)
      // Seen the next time this one looks at its lock, which is every few seconds
      await backend.ended
      await backend.stop()
      // On Windows a line may come between the two, which says that the program was ended
      expect(said.filter((line) => !line.startsWith('backend: did not stop when asked')).slice(-2)).toEqual([
        'backend: another service has taken this folder; stopping',
        'backend: stopped',
      ])
      expect(readFileSync(lock(), 'utf8')).toBe(theirs)
      rmSync(lock())
    },
    LONG,
  )

  test(
    'a lock left by a service that is gone is taken over',
    async () => {
      const config = makeConfig()
      mkdirSync(path.join(folder, 'backend'), { recursive: true })
      // The lock of a service from before the machine was last started, which nothing has touched for a while
      writeFileSync(lock(), JSON.stringify({ pid: process.pid, started: 'then', where: 'before the machine was last started', holder: '0123456789abcdef' }))
      const then = new Date(Date.now() - 60_000)
      utimesSync(lock(), then, then)
      const backend = await start(config)
      expect(await healthy(backend.site)).toBe(true)
      expect(JSON.parse(readFileSync(lock(), 'utf8'))).toMatchObject({ pid: process.pid, holder: expect.not.stringMatching(/^0123456789abcdef$/) })
      // A lock from elsewhere is watched for half a minute before it is nobody's, and only then is the program started
    },
    LONG + 60_000,
  )

  test(
    'loads nothing when started again with the same functions, and loads again when they are not the ones last loaded',
    async () => {
      const config = makeConfig()
      await (await start(config)).stop()
      const loaded = readConfig()!.functions
      said = []
      const again = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/)])
      expect(await healthy(again.site)).toBe(true)
      await again.stop()
      // The note beside the database says the functions went in with other settings: they go in again
      const note = path.join(folder, 'backend', 'data.json')
      writeFileSync(note, JSON.stringify({ ...JSON.parse(readFileSync(note, 'utf8')), load: 'another-load' }))
      said = []
      const third = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(readConfig()!.functions).toBe(loaded)
      await third.stop()
      // And where the database is gone, they go into the new one whatever the settings file says
      rmSync(path.join(folder, 'backend'), { recursive: true, force: true })
      said = []
      const fourth = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/), expect.stringMatching(/^backend: functions loaded/)])
      expect(await healthy(fourth.site)).toBe(true)
    },
    LONG * 2,
  )

  test(
    'stops when it is asked to, and what it wrote is all there for the next one',
    async () => {
      const config = makeConfig()
      const backend = await start(config)
      const pid = JSON.parse(readFileSync(lock(), 'utf8')).program as number
      expect(alive(pid)).toBe(true)
      const key = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }
      const made = (await asAdmin(backend, 'bridge:enroll', { subject: 'owner', name: 'written last', publicKey: key })) as { machineId: string }
      await backend.stop()
      // Away from Windows it ended by itself: with the code of a program that finished, or by the
      // abort it sometimes leaves with once its database is shut. No signal that ends a program
      // from outside was sent. On Windows it may have been ended, which the backend's own tests look at.
      if (process.platform !== 'win32') expect(['code 0', 'SIGABRT']).toContain(endOf(await backend.ended))
      expect(alive(pid)).toBe(false)
      expect(existsSync(lock())).toBe(false)
      expect(said.at(-1)).toBe('backend: stopped')
      expect(await healthy(backend.site)).toBe(false)
      // Asked a second time, there is nothing more to stop
      await backend.stop()
      // What it wrote in its last moment is there for the next one, which has nothing to load
      said = []
      const next = await start(readConfig()!)
      expect(said).toEqual([expect.stringMatching(/^backend: started/)])
      expect(await asAdmin(next, 'bridge:machine', { id: made.machineId })).toMatchObject({ id: made.machineId, revoked: false })
    },
    LONG,
  )

  test(
    'a database that will not open is left as it is, before anything was loaded into it and after',
    async () => {
      const config = makeConfig()
      const database = path.join(folder, 'backend', 'db.sqlite3')
      mkdirSync(path.dirname(database), { recursive: true })
      const broken = Buffer.from('this is not a database\n'.repeat(1000))
      writeFileSync(database, broken)
      expect(await refusal(startBackend(config, say))).toBe('backend_exited')
      expect(readFileSync(database).equals(broken)).toBe(true)
      // Nothing was known of it, so a copy of it was kept before the program was started on it
      expect(said).toEqual([
        'backend: a copy of the database was kept before it is changed (database_copied)',
        'backend: the program ended as soon as it was started (code 1)',
      ])
      rmSync(path.dirname(database), { recursive: true })
      await (await start(config)).stop()
      // Now functions have been loaded, and what the database holds is the person's
      writeFileSync(database, broken)
      said = []
      expect(await refusal(startBackend(readConfig()!, say))).toBe('backend_exited')
      expect(readFileSync(database).equals(broken)).toBe(true)
      expect(said).toEqual(['backend: the program ended as soon as it was started (code 1)'])
      // What the program said is for a person at a terminal, and is in no line that is written down
      expect(said.join('\n')).not.toContain(folder)
      expect(existsSync(lock())).toBe(false)
    },
    LONG,
  )

  test(
    'a load that was begun and not finished leaves a database that is not replaced either',
    async () => {
      const config = makeConfig()
      const database = path.join(folder, 'backend', 'db.sqlite3')
      mkdirSync(path.dirname(database), { recursive: true })
      // What the service notes beside a database it began, once it has begun to load functions into it
      writeFileSync(path.join(folder, 'backend', 'data.json'), JSON.stringify({ made: Date.now(), release: RELEASE, it: VERSION, loading: FUNCTIONS_HASH }))
      writeFileSync(database, 'this is not a database\n')
      expect(await refusal(startBackend(readConfig()!, say))).toBe('backend_exited')
      expect(readFileSync(database, 'utf8')).toBe('this is not a database\n')
      expect(config.functions).toBeUndefined()
    },
    LONG,
  )

  test(
    'says that another program has its port, and replaces no database for that',
    async () => {
      const config = makeConfig()
      const taken = (await listening(config.port + PORTS.backendApi))!
      try {
        expect(await refused(startBackend(config, say))).toMatchObject({ code: 'port_in_use' })
        expect(said).toEqual([])
        expect(existsSync(lock())).toBe(false)
      } finally {
        await closed(taken)
      }
    },
    LONG,
  )

  test(
    'of everything the backend program answers under /api/, the door passes on the three calls of a function and the live connection, and nothing else',
    async () => {
      const config = makeConfig()
      const backend = await start(config)
      const door = await startDoor(config, backend, say)
      try {
        const at = `http://127.0.0.1:${config.port}`
        const routes: [method: string, route: string][] = []
        // What the program itself lists as its routes, in the three lists it publishes
        for (const [list, under] of [
          ['public_openapi.json', ''],
          ['dashboard_openapi.json', ''],
          ['v1/openapi.json', '/v1'],
        ] as const) {
          const listed = (await (await fetch(`${backend.api}/api/${list}`)).json()) as { paths: Record<string, Record<string, unknown>> }
          for (const [route, methods] of Object.entries(listed.paths))
            for (const method of Object.keys(methods)) routes.push([method.toUpperCase(), `/api${under}${route.replace(/\{[^}]*\}/g, 'x')}`])
        }
        expect(routes.length).toBeGreaterThan(30)
        // And what it answers besides: how functions are loaded into it, how its settings are
        // changed, and how what it stores is read and written by whoever holds its key
        const POST = `query_at_ts query_ts query_batch function run/artifacts:list push_config prepare_schema deploy2/start_push deploy2/evaluate_push
        deploy2/evaluate_schema deploy2/wait_for_schema deploy2/finish_push deploy2/report_push_completed run_test_function get_config get_config_hashes
        import import/start_upload import/upload_part import/finish_upload perform_import cancel_import export/request/zip export/zip/x/token
        export/set_expiration/x export/cancel/x storage/upload actions/query actions/mutation actions/action actions/schedule_job actions/vector_search
        actions/cancel_job actions/create_function_handle actions/storage_generate_upload_url actions/storage_get_metadata actions/storage_delete
        update_environment_variables update_canonical_url cancel_all_jobs cancel_job delete_tables delete_component list_snapshot document_deltas
        streaming_import/import_airbyte_records streaming_import/apply_fivetran_operations streaming_import/replace_tables
        streaming_import/fivetran_truncate_table streaming_import/fivetran_create_table data_sync_cursor_from_deltas`
        const GET = `sync schema_state/x stream_udf_execution stream_function_logs export/zip/x storage/x list_environment_variables shapes2 get_indexes
        check_admin_key app_metrics/udf_rate app_metrics/table_rate app_metrics/latency_percentiles app_metrics/scheduled_job_lag list_snapshot
        document_deltas json_schemas get_table_column_names test_streaming_export_connection streaming_import/get_schema
        streaming_import/primary_key_indexes_ready public_openapi.json dashboard_openapi.json v1/openapi.json`
        for (const route of POST.split(/\s+/)) routes.push(['POST', `/api/${route}`])
        for (const route of GET.split(/\s+/)) routes.push(['GET', `/api/${route}`])

        const asked = (to: string, method: string, route: string, key = false) =>
          fetch(`${to}${route}`, {
            method,
            headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Convex ${config.adminKey}` } : {}) },
            body: method === 'GET' ? undefined : '{}',
          })
        const calls = ['/api/query', '/api/mutation', '/api/action']
        let refused = 0
        for (const [method, route] of routes) {
          // The program has such a route: asked itself, it does not say that there is no such thing
          const itself = await asked(backend.api, method, route)
          await itself.body?.cancel()
          expect([method, route, itself.status === 404]).toEqual([method, route, false])
          if (method === 'POST' && calls.includes(route)) continue
          // Through the door it is refused, to whoever holds the administrator's key as to anyone
          for (const key of [false, true]) {
            const through = await asked(at, method, route, key)
            const said = await through.text()
            expect([method, route, through.status, said]).toEqual(
              calls.includes(route) ? [method, route, 405, '{"error":"call_method"}'] : [method, route, 404, '{"error":"api_path"}'],
            )
          }
          refused++
        }
        expect(refused).toBe(routes.length - calls.length)

        // The three calls are answered through the door as the backend answers them itself
        const call = (to: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
          fetch(`${to}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        const nobody = { path: 'artifacts:list', args: [{}], format: 'json' }
        for (const [route, body] of [
          ['/api/query', nobody],
          ['/api/mutation', { path: 'sessions:inviteOwner', args: [{}], format: 'json' }],
          ['/api/action', { path: 'mounts:ticket', args: [{ mountId: 'x' }], format: 'json' }],
        ] as const) {
          const [itself, through] = [await call(backend.api, route, body), await call(at, route, body, { origin: at })]
          // Each answer has a number of its own in it, and is otherwise the same
          const said = async (answer: Response) => (await answer.text()).replace(/Request ID: \w+/, 'Request ID')
          expect([route, through.status, await said(through)]).toEqual([route, itself.status, await said(itself)])
          // The backend tells whichever origin asks that it may read the answer. Through the door nobody is told so
          expect([itself.headers.has('access-control-allow-credentials'), through.headers.has('access-control-allow-credentials')]).toEqual([true, false])
          expect(through.headers.get('access-control-allow-origin')).toBeNull()
        }
        // A caller that is not paired is answered by the backend's own refusal, passed on as it was
        expect(await (await call(at, '/api/query', nobody)).json()).toMatchObject({ status: 'error', errorData: { code: 'unauthenticated' } })
        // The administrator's key runs an internal function when the backend is asked itself, and is passed on by the door for nothing
        const internal = { path: 'bridge:machine', args: [{ id: 'x' }], format: 'json' }
        const admin = { authorization: `Convex ${config.adminKey}` }
        expect(await (await call(backend.api, '/api/query', internal, admin)).json()).toEqual({ status: 'success', value: null })
        const kept = await call(at, '/api/query', internal, admin)
        expect([kept.status, await kept.json()]).toEqual([403, { error: 'call_as' }])
        // And a program opens the live connection through the door
        const live = new WebSocket(`ws://127.0.0.1:${config.port}/api/1.46.0/sync`)
        const opened = await new Promise<string>((resolve) => {
          live.onopen = () => resolve('opened')
          live.onclose = () => resolve('closed')
          setTimeout(() => resolve('nothing'), 10_000)
        })
        live.close()
        expect(opened).toBe('opened')
      } finally {
        await door.stop()
      }
    },
    LONG * 2,
  )

  test('carries the functions as the backend takes them, with no key in them', () => {
    const request = JSON.parse(FUNCTIONS) as { adminKey?: unknown; appDefinition: { changedModules: { path: string }[] } }
    expect(request.adminKey).toBeUndefined()
    expect(request.appDefinition.changedModules.map((m) => m.path)).toEqual(expect.arrayContaining(['bridge.js', 'http.js']))
    expect(FUNCTIONS_HASH).toBe(createHash('sha256').update(FUNCTIONS).digest('hex'))
  })
})

describe.skipIf(!program || process.platform === 'win32')('the service, run as the program itself', () => {
  let scratch: string
  let it: string
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'it-svc-'))
    it = path.join(scratch, 'it.mjs')
    // Bundled the way `build.mjs` bundles it, into a folder that is thrown away afterwards
    await build({
      entryPoints: [path.join(__dirname, 'src/main.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: it,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const children: ChildProcess[] = []
  /**
   * Runs the program with only what is given here in its environment. On its PATH is `node`
   * and nothing else: no agent app of whoever runs the tests is found, and the backend program
   * finds the one thing a function of It's may ask it for.
   */
  const run = (args: string[], env: Record<string, string> = {}, elsewhere?: string, runtime = process.execPath) => {
    const commands = path.join(scratch, 'commands')
    if (!existsSync(commands)) {
      mkdirSync(commands)
      symlinkSync(process.execPath, path.join(commands, 'node'))
    }
    // `elsewhere` is another machine's folder: a command run there is told that folder and
    // nothing of where It is, which port it counts from or which backend program it runs
    const child = spawn(runtime, [it, ...args], {
      cwd: elsewhere ?? folder,
      env: elsewhere
        ? { PATH: commands, HOME: elsewhere, IT_HOME: elsewhere, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', IT_SHELL_ENV: 'off', ...env }
        : {
            PATH: commands,
            HOME: folder,
            IT_HOME: folder,
            IT_PORT: process.env.IT_PORT!,
            IT_BACKEND_BIN: program!,
            IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
            IT_HARNESSES: 'none',
            // The shell of whoever runs these tests is not asked what it would give a program
            IT_SHELL_ENV: 'off',
            ...env,
          },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout!.on('data', (c: Buffer) => (out += c))
    child.stderr!.on('data', (c: Buffer) => (err += c))
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    return { child, ended, out: () => out, err: () => err }
  }
  /** Zero when a command ended well, and otherwise how it ended with what it said, so that a failure shows why. */
  const well = async (ran: ReturnType<typeof run>) => {
    const code = await ran.ended
    return code === 0 ? 0 : { code, said: ran.err() }
  }
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    }
    // A service that a test had started in the background is asked to stop, and waited for
    try {
      const { pid } = JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')) as { pid: number }
      process.kill(pid, 'SIGTERM')
      await until(() => !alive(pid))
    } catch {}
  })
  const health = () =>
    fetch(`${backendAt(Number(process.env.IT_PORT)).site}/health`).then(
      (r) => r.ok,
      () => false,
    )
  const kept = (name: string) => JSON.parse(readFileSync(path.join(folder, name), 'utf8'))
  const log = () => (existsSync(path.join(folder, 'service.log')) ? readFileSync(path.join(folder, 'service.log'), 'utf8') : '')
  const lines = () =>
    log()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^\S+ /, ''))

  test('`it serve` on a machine where It was never set up says to run `it setup`, and starts nothing', async () => {
    const ran = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await ran.ended).toBe(1)
    expect(lines()).toEqual(['could not start: not_set_up'])
    expect(JSON.parse(ran.err().trim().split('\n').pop()!).error).toEqual({
      code: 'not_set_up',
      message: 'It could not start.',
      hint: 'Run `it serve` in a terminal to read why.',
    })
    expect(existsSync(path.join(folder, 'backend'))).toBe(false)
  })

  test('the first `it setup` makes the settings and enrols this machine, and with `--no-service` runs the backend only for as long as that takes', async () => {
    const ran = run(['setup', '--yes', '--no-service', '--name', 'the desk'])
    expect(await well(ran)).toBe(0)
    const config = readConfig()!
    expect(config).toEqual({
      port: Number(process.env.IT_PORT),
      network: false,
      instanceSecret: expect.any(String),
      adminKey: expect.any(String),
      sessionSecret: expect.any(String),
      functions: expect.stringMatching(/^[0-9a-f]{64}$/),
      backend: RELEASE,
    })
    const machine = kept('machine.json')
    expect(machine).toEqual({ id: expect.any(String), name: 'the desk', key: expect.objectContaining({ kty: 'EC', d: expect.any(String) }) })
    for (const file of ['service.json', 'machine.json']) expect([file, statSync(path.join(folder, file)).mode & 0o777]).toEqual([file, 0o600])
    expect(ran.err()).toContain('This machine is enrolled as "the desk".')
    expect(ran.err()).toContain('It is not running in the background. Run `it serve`, in a terminal or under a supervisor of your own, to keep it going.')
    expect(ran.err().trimEnd().split('\n').pop()).toBe(
      `It’s site is at http://localhost:${config.port}. No browser is let in until it is paired: \`it site\` opens the site in a browser on this machine and pairs that browser, and \`it site --no-open\` prints the link that does.`,
    )
    expect(JSON.parse(ran.out())).toEqual({ harnesses: [], service: { registered: false, state: 'not installed' } })
    // Nothing is left running, and no secret was said
    expect(existsSync(path.join(folder, 'backend', 'lock'))).toBe(false)
    expect(await health()).toBe(false)
    for (const secret of [config.instanceSecret, config.adminKey, config.sessionSecret, machine.key.d]) expect(ran.err() + ran.out()).not.toContain(secret)
    // Run again, it finds all of that done, and makes nothing a second time
    const again = run(['setup', '--yes', '--no-service', '--name', 'another name'])
    expect(await well(again)).toBe(0)
    expect(readConfig()).toEqual(config)
    expect(kept('machine.json')).toEqual(machine)
    expect(again.err()).not.toContain('enrolled')
    // With no service running, a command says where it looked and what to check
    const list = run(['list'])
    expect(await list.ended).toBe(1)
    expect(JSON.parse(list.err().trim().split('\n').pop()!).error).toMatchObject({
      code: 'offline',
      message: 'It is not running on this machine.',
      hint: 'Start it with `it serve`, or run `it setup` to keep it running in the background.',
    })
  }, 120_000)

  test('the first `it setup --none` sets It up as any first run does, and connects no agent app', async () => {
    const ran = run(['setup', '--none', '--no-service', '--name', 'the desk'])
    expect(await well(ran)).toBe(0)
    const config = readConfig()!
    expect(config).toMatchObject({ port: Number(process.env.IT_PORT), network: false, functions: expect.stringMatching(/^[0-9a-f]{64}$/), backend: RELEASE })
    const machine = kept('machine.json')
    expect(machine).toMatchObject({ id: expect.any(String), name: 'the desk' })
    expect(ran.err()).toContain('This machine is enrolled as "the desk".')
    // The person is told where the site is, as after any first run
    expect(ran.err().trimEnd().split('\n').pop()).toBe(
      `It’s site is at http://localhost:${config.port}. No browser is let in until it is paired: \`it site\` opens the site in a browser on this machine and pairs that browser, and \`it site --no-open\` prints the link that does.`,
    )
    expect(JSON.parse(ran.out())).toEqual({ harnesses: [], service: { registered: false, state: 'not installed' } })
    expect(await health()).toBe(false)
    // What it made is what the service then runs from
    const service = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
    const who = run(['whoami'])
    expect(await well(who)).toBe(0)
    expect(JSON.parse(who.out())).toMatchObject({ id: machine.id, name: 'the desk' })
    // Run again where It is set up, it makes nothing a second time and is no first run
    const again = run(['setup', '--none', '--no-service'])
    expect(await well(again)).toBe(0)
    expect([readConfig(), kept('machine.json')]).toEqual([config, machine])
    expect(again.err()).not.toMatch(/enrolled|It’s site is at/)
    service.child.kill('SIGTERM')
    expect(await well(service)).toBe(0)
  }, 120_000)

  /** Bun, where it is on this machine: the standalone program runs under it. */
  const bun = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, 'bun'))
    .find((file) => existsSync(file))
  const RUNTIMES: [name: string, runtime: string | undefined][] = [
    ['Node', process.execPath],
    ['Bun', bun],
  ]
  /**
   * What a setup is run with to have it take a while: a folder of commands with a stand-in for
   * Pi in it, which waits as long as PI_DELAY says before it gives its version, and Pi as the
   * one agent app that is looked for. A setup asks for that version twice.
   */
  const slowly = (seconds: number): Record<string, string> => {
    const commands = path.join(scratch, 'slow-commands')
    if (!existsSync(commands)) {
      mkdirSync(commands)
      symlinkSync(process.execPath, path.join(commands, 'node'))
      writeFileSync(path.join(commands, 'pi'), '#!/bin/sh\ncase "$1" in --version) /bin/sleep "$PI_DELAY"; echo 0.82.0 ;; esac\nexit 0\n', { mode: 0o755 })
    }
    return { PATH: commands, IT_HARNESSES: 'pi', PI_DELAY: String(seconds) }
  }
  /** The backend program a lock names, asked to stop and waited for, should a test have left one running. */
  const stopped = async (pid: number | undefined) => {
    if (pid === undefined || !alive(pid)) return
    process.kill(pid, 'SIGINT')
    await until(() => !alive(pid), 60_000)
  }

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, of two setups run at once the second waits for the first, and neither has the backend program stopped under it`,
      async () => {
        const first = run(['setup', '--none', '--no-service'], slowly(1), undefined, runtime)
        expect(await until(() => existsSync(path.join(folder, 'machine.json')), 60_000)).toBe(true)
        // The first has enrolled this machine and is still looking at its agent apps, with the backend program it started
        const second = run(['setup', '--none', '--no-service'], slowly(2), undefined, runtime)
        expect([await well(first), await well(second)]).toEqual([0, 0])
        expect(second.err()).toContain('Another `it setup` or `it login` is at work in this folder. This one goes on when that one has finished.')
        expect(first.err()).not.toContain('Another `it setup`')
        // Each said what it found, and the second went on to the end as the first did
        for (const ran of [first, second]) expect(JSON.parse(ran.out())).toMatchObject({ harnesses: [{ id: 'pi', addon: 'not_connected' }] })
        // And nothing is left running, nor any lock of either
        expect(await health()).toBe(false)
        expect(['backend/lock', 'setup.lock'].filter((file) => existsSync(path.join(folder, file)))).toEqual([])
      },
      180_000,
    )

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, a backend program left running by a setup that was ended is not taken for a running It, and the next setup stops it`,
      async () => {
        const first = run(['setup', '--none', '--no-service'], slowly(30), undefined, runtime)
        expect(await until(() => existsSync(path.join(folder, 'machine.json')), 60_000)).toBe(true)
        const left = (kept('backend/lock') as { program: number }).program
        try {
          // Ended while it was looking at its agent apps, with no chance to stop what it had started
          first.child.kill('SIGTERM')
          await first.ended
          expect([alive(left), await health()]).toEqual([true, true])
          // The backend program answers and nothing else of It is there: It is not said to be running, and why is said
          const status = run(['status'], {}, undefined, runtime)
          expect(await well(status)).toBe(0)
          expect(JSON.parse(status.out())).toMatchObject({ running: false, enrolled: true })
          expect(JSON.parse(status.out()).hint).toMatch(/^It is not running on this machine: only its backend program is, /)
          const site = run(['site', '--no-open'], {}, undefined, runtime)
          expect([await site.ended, site.out()]).toEqual([1, ''])
          // The next setup stops it, and leaves nothing running in its turn
          const next = run(['setup', '--none', '--no-service'], slowly(0), undefined, runtime)
          expect(await well(next)).toBe(0)
          expect(next.err()).toContain('A backend program that an earlier `it setup` had left running on this machine was stopped.')
          expect([alive(left), await health()]).toEqual([false, false])
          expect(['backend/lock', 'setup.lock'].filter((file) => existsSync(path.join(folder, file)))).toEqual([])
          const after = run(['status'], {}, undefined, runtime)
          expect(await well(after)).toBe(0)
          expect(JSON.parse(after.out())).toMatchObject({
            running: false,
            hint: 'It is not running on this machine. Start it with `it serve`, or run `it setup` to keep it running in the background.',
          })
        } finally {
          await stopped(left)
        }
      },
      180_000,
    )

  /**
   * Something that answers as the door of an It on another computer does to a machine that asks
   * to join it. The answer to the asking is held until the test lets it go, and what was asked
   * with is kept.
   */
  const anotherIt = async () => {
    const asked: { publicKey?: { x?: string } }[] = []
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    const server = http.createServer((req, res) => {
      const pieces: Buffer[] = []
      req
        .on('data', (piece: Buffer) => pieces.push(piece))
        .on('end', async () => {
          const json = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
          if (req.url === '/cli/config') return json({ protocol: 1, issuer: 'http://127.0.0.1:1' })
          asked.push(JSON.parse(Buffer.concat(pieces).toString('utf8')))
          await held
          json({ machine: 'machine-far' })
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, asked, letGo, close: () => closed(server) }
  }

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, a setup that begins while this machine is joining another It waits for the joining, and then sets up no It here: the machine keeps the identity it joined with, and its key`,
      async () => {
        const far = await anotherIt()
        try {
          const login = run(['login', '--url', far.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--name', 'the laptop', '--no-setup'], {}, undefined, runtime)
          // The machine has made its key and asked, and the It it asked has not answered yet
          expect(await until(() => far.asked.length === 1)).toBe(true)
          const setup = run(['setup', '--none', '--no-service'], {}, undefined, runtime)
          expect(await until(() => setup.err().includes('This one goes on when that one has finished.'))).toBe(true)
          expect(existsSync(path.join(folder, 'service.json'))).toBe(false)
          far.letGo()
          expect(await well(login)).toBe(0)
          // The setup decides again now that the folder is its own, and finds a machine that has joined an It
          expect([await setup.ended, setup.out()]).toEqual([1, ''])
          expect(JSON.parse(setup.err().trim().split('\n').pop()!).error).toEqual({
            code: 'joined',
            message: `This machine joined the It at ${far.url} while this setup was waiting, so no It was set up here.`,
            hint: 'Run `it setup` again to connect its agent apps to that It. To have It run on this machine instead, run `it logout` first, and then `it setup`.',
          })
          const identity = kept('machine.json') as { id: string; at: string; key: { x: string; d: string } }
          expect([identity.id, identity.at, identity.key.x, typeof identity.key.d]).toEqual(['machine-far', far.url, far.asked[0]!.publicKey!.x, 'string'])
          // Nothing of an It of this machine's own was made or started
          expect(['service.json', 'backend', 'machine.pending.json', 'setup.lock'].filter((file) => existsSync(path.join(folder, file)))).toEqual([])
          expect(await health()).toBe(false)
        } finally {
          far.letGo()
          await far.close()
        }
      },
      120_000,
    )

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, a joining that begins while It is being set up on this machine waits for the setup, and then joins nothing and spends no invite`,
      async () => {
        const far = await anotherIt()
        try {
          const setup = run(['setup', '--none', '--no-service'], slowly(1), undefined, runtime)
          expect(await until(() => existsSync(path.join(folder, 'machine.json')), 60_000)).toBe(true)
          const login = run(['login', '--url', far.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--no-setup'], {}, undefined, runtime)
          expect(await well(setup)).toBe(0)
          expect([await login.ended, login.out()]).toEqual([2, ''])
          expect(JSON.parse(login.err().trim().split('\n').pop()!).error).toMatchObject({
            code: 'invalid',
            message: 'This machine runs an It of its own, so it cannot join another one.',
          })
          expect(far.asked).toEqual([])
          expect((kept('machine.json') as { at?: string }).at).toBeUndefined()
        } finally {
          far.letGo()
          await far.close()
        }
      },
      120_000,
    )

  test('`it setup` enrols a machine again when It does not know it any more, as after its data was removed', async () => {
    expect(await well(run(['setup', '--yes', '--no-service']))).toBe(0)
    const before = kept('machine.json')
    rmSync(path.join(folder, 'backend'), { recursive: true, force: true })
    const again = run(['setup', '--yes', '--no-service'])
    expect(await well(again)).toBe(0)
    expect(again.err()).toContain('It had stopped knowing this machine, so it was enrolled again.')
    const after = kept('machine.json')
    expect(after.name).toBe(before.name)
    expect(after.key.d).not.toBe(before.key.d)
  }, 120_000)

  test('the first `it setup` registers It as a background service, waits for it, enrols this machine, and finds its connector answering', async () => {
    // What stands in for the system's own way to keep a program running: asked to start the
    // service, it starts the program with the settings `it setup` ran with
    const commands = mkdtempSync(path.join(scratch, 'manager-'))
    symlinkSync(process.execPath, path.join(commands, 'node'))
    // It notes each thing it was asked, so that what a later setup asked of the system can be read
    const manager = `#!/bin/sh\necho "$*" >> "$IT_HOME/system-was-asked"\ncase " $* " in\n*" restart "*|*" bootstrap "*) "$IT_TEST_NODE" "$IT_TEST_IT" serve --log "$IT_HOME/logs/it.log" >/dev/null 2>&1 & ;;\n*" is-active "*) echo active ;;\n*" is-enabled "*) echo enabled ;;\nesac\nexit 0\n`
    for (const name of ['systemctl', 'launchctl', 'loginctl']) writeFileSync(path.join(commands, name), manager, { mode: 0o755 })
    // Where a backend program would be fetched from, were this shell's not there: an address on this machine that nothing is asked at
    const releases = `http://127.0.0.1:${Number(process.env.IT_PORT) + 30}/releases`
    const ran = run(['setup', '--yes'], { PATH: commands, IT_TEST_NODE: process.execPath, IT_TEST_IT: it, IT_BACKEND_RELEASES: releases })
    expect(await well(ran)).toBe(0)
    expect(ran.err()).toContain(`This machine is enrolled as "${os.hostname()}".`)
    expect(ran.err()).toMatch(/^It runs in the background \(\w+\)\.$/m)
    expect(ran.err()).not.toContain('It is not running in the background')
    expect(JSON.parse(ran.out())).toMatchObject({ service: { registered: true } })
    // What was registered runs the whole of It for this folder, on the port and with the program
    // this shell named, and would fetch a program from where this shell was told to
    const registered =
      process.platform === 'linux' ? path.join(folder, '.config/systemd/user/it.service') : path.join(folder, 'Library/LaunchAgents/dev.it.plist')
    const definition = readFileSync(registered, 'utf8')
    for (const word of [
      'serve',
      path.join(folder, 'logs', 'it.log'),
      `IT_PORT`,
      process.env.IT_PORT!,
      'IT_BACKEND_BIN',
      program!,
      'IT_BACKEND_RELEASES',
      releases,
    ])
      expect(definition).toContain(word)
    // It is the service that answers, and goes on answering once setup has ended
    expect(await health()).toBe(true)
    const who = run(['whoami'])
    expect(await well(who)).toBe(0)
    expect(JSON.parse(who.out())).toMatchObject({ id: kept('machine.json').id, name: os.hostname() })
    const status = run(['status'])
    expect(await well(status)).toBe(0)
    expect(JSON.parse(status.out())).toMatchObject({
      running: true,
      enrolled: true,
      site: `http://localhost:${process.env.IT_PORT}`,
      connector: { ok: true },
    })
    // `it setup --none`, run where It is set up, takes add-ons out and leaves the rest as it is:
    // the system is asked how the service is and to do nothing, and the service that runs is the same one
    const holder = () => (JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')) as { pid: number }).pid
    const asked = () => readFileSync(path.join(folder, 'system-was-asked'), 'utf8').trim().split('\n')
    const [running, before] = [holder(), asked().length]
    const none = run(['setup', '--none'], { PATH: commands, IT_TEST_NODE: process.execPath, IT_TEST_IT: it })
    expect(await well(none)).toBe(0)
    expect(
      asked()
        .slice(before)
        .filter((words) => !/ (is-active|is-enabled|print) /.test(` ${words} `)),
    ).toEqual([])
    expect([holder(), await health(), readFileSync(registered, 'utf8')]).toEqual([running, true, definition])
    expect(JSON.parse(none.out())).toMatchObject({ harnesses: [], service: { registered: true } })
    expect(none.err()).not.toMatch(/It runs in the background|enrolled|It’s site is at/)
  }, 120_000)

  test('`it serve` starts the backend and then the connector, and stops them in the opposite order when it is asked to', async () => {
    const config = makeConfig()
    const at = backendAt(config.port)
    const ran = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(
      await until(() =>
        fetch(`${at.site}/health`).then(
          (r) => r.ok,
          () => false,
        ),
      ),
    ).toBe(true)
    // The connector starts once the machine is enrolled, which on a first run is a moment after the service has started
    expect(await until(() => lines().some((line) => line.startsWith('service started')))).toBe(true)
    expect(lines().some((line) => line.startsWith('connector'))).toBe(false)
    const second = run(['setup', '--yes', '--no-service'])
    expect(await well(second)).toBe(0)
    expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
    // A second service for the same folder says that one is running, and leaves it running
    const other = run(['serve', '--log', path.join(folder, 'other.log')])
    expect(await other.ended).toBe(1)
    expect(readFileSync(path.join(folder, 'other.log'), 'utf8')).toMatch(/ could not start: already_running\n$/)
    expect(await fetch(`${at.site}/health`).then((r) => r.ok)).toBe(true)
    // This machine's own commands reach the backend as this machine
    const who = run(['whoami'])
    expect(await well(who)).toBe(0)
    expect(JSON.parse(who.out())).toMatchObject({ name: os.hostname() })
    const program = (JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')) as { program: number }).program
    ran.child.kill('SIGTERM')
    expect(await well(ran)).toBe(0)
    const order = lines().filter((line) => /^(backend: started|service started|connector \S+ started|stopped$|backend: stopped|service stopped)/.test(line))
    expect(order.map((line) => line.replace(/ \(pid.*$/, '').replace(/^connector \S+ started.*$/, 'connector started'))).toEqual([
      'backend: started',
      'service started',
      'connector started',
      'stopped',
      'backend: stopped',
      'service stopped',
    ])
    expect(alive(program)).toBe(false)
    expect(existsSync(path.join(folder, 'backend', 'lock'))).toBe(false)
    // Nothing the service wrote down names the person's folder or holds a secret
    for (const secret of [folder, config.instanceSecret, config.adminKey, config.sessionSecret]) expect(log()).not.toContain(secret)
  }, 120_000)

  test('a machine in a folder of its own joins through the door, told nothing but that folder, and does there what the first machine does', async () => {
    expect(await well(run(['setup', '--none', '--no-service', '--name', 'the desk']))).toBe(0)
    run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
    const port = Number(process.env.IT_PORT)
    const door = `http://127.0.0.1:${port}`
    const fn = (name: string) => makeFunctionReference<'mutation'>(name)
    // The first machine asks for an invite for another
    expect(await well(run(['whoami']))).toBe(0)
    const first = new ConvexHttpClient(backendAt(port).api, { logger: false })
    first.setAuth(kept('token.json').token)
    const invite = (await first.mutation(fn('sessions:inviteMachine'), {})) as { code: string }
    // And a browser is paired as the owner's, through the door as a browser is: it is what a person acts on a page with
    const site = run(['site', '--no-open'])
    expect(await well(site)).toBe(0)
    const asSite = { origin: door, 'x-it-site': '1', 'content-type': 'application/json' }
    const redeemed = await fetch(`${door}/session/redeem`, {
      method: 'POST',
      headers: asSite,
      body: JSON.stringify({ code: new URL(JSON.parse(site.out()).url).hash.slice(1) }),
    })
    expect(redeemed.status).toBe(200)
    const cookie = redeemed.headers.getSetCookie()[0]!.split(';')[0]!
    // The same asked of the backend's own port, where the door looked at nothing, is refused,
    // and so is a browser's asking whether it may send the site's header there
    const direct = backendAt(port).site
    expect((await fetch(`${direct}/session/token`, { method: 'POST', headers: { ...asSite, cookie } })).status).toBe(403)
    expect(
      (
        await fetch(`${direct}/session/token`, {
          method: 'OPTIONS',
          headers: { origin: door, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-it-site' },
        })
      ).status,
    ).toBe(404)
    const session = (await (await fetch(`${door}/session/token`, { method: 'POST', headers: { ...asSite, cookie } })).json()) as { token: string }
    const browser = new ConvexHttpClient(door, { logger: false })
    browser.setAuth(session.token)
    const displayKey = 'a-display-key-000001'
    await browser.mutation(fn('displays:register'), { key: displayKey, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0' })
    const press = async (slug: string, id: string) => {
      const page = (await browser.query(makeFunctionReference<'query'>('artifacts:get'), { slug })) as { id: string }
      return browser.mutation(fn('actions:submit'), {
        artifactId: page.id,
        displayKey,
        envelope: { v: 1, clientActionId: id, name: 'approve', payload: '{"n":1}', contentVersion: 1 },
      })
    }

    const other = mkdtempSync(path.join(os.tmpdir(), 'it-joined-'))
    const second = (args: string[], env: Record<string, string> = {}) => run(args, env, other)
    let connector: ReturnType<typeof run> | undefined
    const said = async (args: string[], env: Record<string, string> = {}) => {
      const ran = second(args, env)
      expect([args[0], await well(ran)]).toEqual([args[0], 0])
      return JSON.parse(ran.out())
    }
    try {
      expect(await said(['login', '--url', door, '--code', invite.code, '--name', 'the laptop', '--no-setup'])).toEqual({
        machine: expect.any(String),
        name: 'the laptop',
      })
      const laptop = JSON.parse(readFileSync(path.join(other, 'machine.json'), 'utf8')) as { id: string; at: string; issuer: string }
      expect(laptop).toMatchObject({ at: door, issuer: backendAt(port).site })
      expect(await said(['whoami'])).toMatchObject({ id: laptop.id, name: 'the laptop' })

      // A page of several files, one of them large, published from the second machine
      const files: Record<string, Buffer> = {
        'index.html': Buffer.from('<!doctype html><h1>Plan</h1><script src="assets/app.js"></script>'),
        'assets/app.js': Buffer.from('console.log("plan")'),
        'assets/data.json': Buffer.from(JSON.stringify({ rows: [1, 2, 3] })),
        'assets/picture.bin': Buffer.alloc(300_000, 7),
      }
      mkdirSync(path.join(other, 'page', 'assets'), { recursive: true })
      for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(other, 'page', name), bytes)
      // Its files go to the door it joined at, and the page's address is the site's as this machine reaches it
      expect(await said(['create', 'Plan', '--id', 'plan', '--dir', path.join(other, 'page'), '--state', '{"step":1}'])).toEqual({
        id: 'plan',
        version: 1,
        url: `${door}/p/plan`,
      })
      // Read back from the second machine, it is all there
      expect(await said(['read', 'plan'])).toMatchObject({
        id: 'plan',
        title: 'Plan',
        version: 1,
        machine: 'the laptop',
        state: { step: 1 },
        versions: [{ n: 1, files: 4, bytes: Object.values(files).reduce((n, bytes) => n + bytes.length, 0), status: 'live' }],
      })
      expect((await said(['list'])).map((page: { id: string }) => page.id)).toEqual(['plan'])
      expect(await said(['set', 'plan', 'step', '2'])).toMatchObject({ revision: 2 })
      expect(await said(['state', 'plan'])).toEqual({ state: { step: 2 }, revision: 2 })
      // And every file is with the service on the first machine, byte for byte
      const sum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
      const stored = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? stored(path.join(dir, entry.name)) : [sum(readFileSync(path.join(dir, entry.name)))],
        )
      expect(stored(path.join(folder, 'content'))).toEqual(expect.arrayContaining(Object.values(files).map(sum)))
      // Every address the command gives is one this machine can open
      expect(await said(['status'])).toMatchObject({ running: true, enrolled: true, machine: { name: 'the laptop' }, site: door })
      expect((await said(['site', '--no-open'])).url).toMatch(new RegExp(`^${door}/pair#[a-z2-7]{20}$`))

      // What a person does on the page reaches `it wait` there, over the live connection through the door
      const waiting = second(['wait', '--id', 'plan', '--timeout', '30'])
      await press('plan', 'click-0001')
      expect(await well(waiting)).toBe(0)
      expect(JSON.parse(waiting.out().trim().split('\n')[0]!)).toMatchObject({ page: 'plan', action: 'approve', data: { n: 1 } })

      // Its connector runs there as the whole of the service, says through the door that it is alive, and hears what it is to deliver
      connector = second(['serve', '--log', path.join(other, 'connector.log')])
      const heard = () => (existsSync(path.join(other, 'connector.log')) ? readFileSync(path.join(other, 'connector.log'), 'utf8') : '')
      expect(await until(() => /connector \S+ started/.test(heard()))).toBe(true)
      expect(
        await until(async () => {
          const machines = (await browser.query(makeFunctionReference<'query'>('machines:list'), {})) as { name: string; connectorVersion: string | null }[]
          return machines.find((m) => m.name === 'the laptop')?.connectorVersion != null
        }),
      ).toBe(true)
      // A page made by a Codex conversation there, where no agent app is connected: a click on it is nobody's to deliver, and it waits
      expect(await said(['create', 'Queued', '--id', 'queued', '--html', '<p>hi</p>'], { CODEX_THREAD_ID: 'thread-1' })).toMatchObject({ id: 'queued' })
      const waits = (await press('queued', 'click-0002')) as { actionId: string }
      // The person connects Pi for that machine on the site, and a Pi conversation there makes a page
      await browser.mutation(fn('machines:toggle'), { machineId: laptop.id, harness: 'pi', on: true })
      expect(await said(['create', 'Heard', '--id', 'heard', '--html', '<p>hi</p>'], { IT_HARNESS: 'pi', IT_SESSION: 'conversation-1' })).toMatchObject({
        id: 'heard',
      })
      const pressed = (await press('heard', 'click-0003')) as { actionId: string }
      // Pi's add-on asks the connector for its conversation's clicks, as the add-on does, and is given the one that was pressed
      const { socket, token } = JSON.parse(readFileSync(path.join(other, 'connector.json'), 'utf8')) as { socket: string; token: string }
      const given = async () => {
        const answered = await ask({ path: socket }, { path: '/clicks?harness=pi&session=conversation-1', headers: { 'x-it-token': token } })
        return (JSON.parse(answered.body.toString('utf8')) as { clicks: { id: string; artifact: string }[] }).clicks
      }
      expect(await until(async () => (await given()).some((click) => click.id === pressed.actionId && click.artifact === 'heard'))).toBe(true)
      // For the click on the Codex conversation's page nothing was run and nothing asked: it is still waiting, for whoever comes for it
      expect(heard()).not.toMatch(/Codex/)
      expect((await said(['actions', '--id', 'queued'])).map((click: { id: string }) => click.id)).toEqual([waits.actionId])
      // Nothing it wrote down names the door's refusals: it was refused nothing
      expect(heard()).not.toMatch(/foreign_origin|api_path|refused/)
    } finally {
      // Its connector is stopped, and waited for, before its folder is taken away
      connector?.child.kill('SIGTERM')
      await connector?.ended
      rmSync(other, { recursive: true, force: true })
    }
  }, 180_000)

  test('`it serve` where another program has one of the door’s ports says so at once, before the backend program is started', async () => {
    makeConfig()
    // The port of a page, which the door listens on beside the site's
    const taken = (await listening(Number(process.env.IT_PORT) + 1))!
    try {
      const ran = run(['serve', '--log', path.join(folder, 'service.log')])
      expect(await ran.ended).toBe(1)
      expect(lines()).toEqual(['could not start: port_taken'])
      // Nothing of the backend was begun: no program was started on the folder, and nothing was loaded
      expect(existsSync(path.join(folder, 'backend'))).toBe(false)
      expect(readConfig()!.functions).toBeUndefined()
    } finally {
      await closed(taken)
    }
  }, 120_000)

  test('a door that cannot be opened once the backend is running stops the backend, and nothing is written down of a backend that ended by itself', async () => {
    makeConfig()
    // Taken under IPv6 only, where the door listens as well and nothing looks beforehand. A machine without IPv6 has no such port to take.
    const taken = await new Promise<net.Server | null>((resolve) => {
      const server = net.createServer((socket) => socket.destroy())
      server.once('error', () => resolve(null)).listen({ port: Number(process.env.IT_PORT), host: '::1', ipv6Only: true }, () => resolve(server))
    })
    if (!taken) return
    try {
      const ran = run(['serve', '--log', path.join(folder, 'service.log')])
      expect(await ran.ended).toBe(1)
      expect(lines().map((line) => line.replace(/ \(.*$/, ''))).toEqual([
        'backend: started',
        'backend: functions loaded',
        'backend: stopped',
        'could not start: port_taken',
      ])
      expect(log()).not.toContain('ended by itself')
      expect(existsSync(path.join(folder, 'backend', 'lock'))).toBe(false)
    } finally {
      await closed(taken)
    }
  }, 120_000)

  test('a connector that cannot start is written down by one fixed word, and nothing of the reason’s own words, which name the folder', async () => {
    expect(await well(run(['setup', '--none', '--no-service']))).toBe(0)
    // A connector is already running for this folder, by itself, as on a machine whose backend is elsewhere: the service's own cannot take its place
    const alone = run(['serve', '--log', path.join(folder, 'alone.log')], { IT_URL: backendAt(Number(process.env.IT_PORT)).api })
    expect(await until(() => existsSync(path.join(folder, 'connector.json')))).toBe(true)
    const service = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => line.startsWith('connector: could not start')))).toBe(true)
    expect(lines().filter((line) => line.startsWith('connector'))).toEqual(['connector: could not start: already_running'])
    // What the refusal itself says is for a person at a terminal: none of it is in the line, nor anywhere else in what was written down
    expect(log()).not.toMatch(/A connector is already running|for this folder/)
    expect(log()).not.toContain(folder)
    // The rest of the service goes on: the site is served meanwhile
    expect(await health()).toBe(true)
    expect(service.child.exitCode).toBeNull()
    alone.child.kill('SIGTERM')
    await alone.ended
  }, 120_000)

  test('a service asked to stop by the file in its folder, as a system that has no signal asks it, stops as it does for a signal: the backend program by being asked, and nothing killed', async () => {
    expect(await well(run(['setup', '--none', '--no-service']))).toBe(0)
    // A request left from before the service began asks nothing of it
    writeFileSync(path.join(folder, 'service.stop'), '')
    const ran = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
    expect(existsSync(path.join(folder, 'service.stop'))).toBe(false)
    const program = (JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')) as { program: number }).program
    writeFileSync(path.join(folder, 'service.stop'), '')
    expect(await well(ran)).toBe(0)
    const after = lines().slice(lines().indexOf('asked to stop'))
    expect(after).toEqual(['asked to stop', 'stopping (SIGTERM)', 'stopped', 'door closed', 'backend: stopped', 'service stopped'])
    expect(alive(program)).toBe(false)
    expect(existsSync(path.join(folder, 'backend', 'lock'))).toBe(false)
    expect(existsSync(path.join(folder, 'service.stop'))).toBe(false)
  }, 120_000)

  test('`it serve` asked to stop before this machine is enrolled, with no connector yet to stop, stops the backend and ends well', async () => {
    makeConfig()
    const ran = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => line.startsWith('service started')))).toBe(true)
    ran.child.kill('SIGINT')
    expect(await ran.ended).toBe(0)
    expect(lines().map((line) => line.replace(/ \(pid.*$/, ''))).toEqual([
      'backend: started',
      expect.stringMatching(/^backend: functions loaded/),
      expect.stringMatching(/^door open on port \d+/),
      'service started',
      'door closed',
      'backend: stopped',
      'service stopped',
    ])
  }, 120_000)

  test('`it serve` ends as a failure when the backend program ends by itself, having stopped the connector, so that whatever keeps it running starts it again', async () => {
    expect(await well(run(['setup', '--yes', '--no-service']))).toBe(0)
    const ran = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
    // The backend program is ended from outside, as a fault in it or in the machine would end it
    process.kill((kept('backend/lock') as { program: number }).program, 'SIGKILL')
    expect(await ran.ended).toBe(1)
    const after = lines().slice(lines().findIndex((line) => line.startsWith('backend: ended by itself')))
    expect(after[0]).toBe('backend: ended by itself (SIGKILL); stopping')
    // The connector was told to stop, though no signal came, and did
    expect(after).toContain('stopped')
    expect(after.at(-1)).toBe('service stopped')
    expect(existsSync(path.join(folder, 'backend', 'lock'))).toBe(false)
    expect(existsSync(path.join(folder, 'connector.json'))).toBe(false)
  }, 120_000)

  test('a backend program left running by a service that was killed is asked to stop before another is started on its data', async () => {
    const config = makeConfig()
    const at = backendAt(config.port)
    const first = run(['serve', '--log', path.join(folder, 'service.log')])
    expect(
      await until(() =>
        fetch(`${at.site}/health`).then(
          (r) => r.ok,
          () => false,
        ),
      ),
    ).toBe(true)
    const left = (JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')) as { program: number }).program
    // Killed, the service stops nothing: the backend program goes on by itself
    first.child.kill('SIGKILL')
    await first.ended
    expect(alive(left)).toBe(true)
    const said: string[] = []
    const backend = await startBackend(config, (line) => void said.push(line))
    try {
      expect(said[0]).toBe(`backend: one left running by a service that is gone is asked to stop (pid ${left})`)
      expect(alive(left)).toBe(false)
      expect(await fetch(`${at.site}/health`).then((r) => r.ok)).toBe(true)
    } finally {
      await backend.stop()
    }
  }, 120_000)
})

describe('a backend program that cannot be run on this system at all', () => {
  test('is said as that, with the version of the C library it needs, and nothing is guessed where it failed another way', () => {
    // What the system's loader says of a program built against a newer library, as Rocky Linux 9 says it of this one
    const older = [
      "/home/u/.it/backend/bin/x/convex-local-backend: /lib64/libm.so.6: version `GLIBC_2.35' not found (required by /home/u/.it/backend/bin/x/convex-local-backend)",
      "/home/u/.it/backend/bin/x/convex-local-backend: /lib64/libc.so.6: version `GLIBC_2.33' not found (required by /home/u/.it/backend/bin/x/convex-local-backend)",
    ].join('\n')
    expect(cannotRunHere(older, undefined, true)).toMatch(/needs version 2\.35 of the system’s C library \(glibc\)/)
    // The program is there and the system says no such file: its loader is what is missing, as with musl
    expect(cannotRunHere('', 'ENOENT', true)).toMatch(/built for the GNU C library/)
    // Not there at all, or failed with words of its own: not this
    expect(cannotRunHere('', 'ENOENT', false)).toBeNull()
    expect(cannotRunHere('error: unexpected argument', undefined, true)).toBeNull()
  })
})
