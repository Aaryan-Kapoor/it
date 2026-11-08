// How It comes back as the program an upgrade asked for on the site has put in place: by the new
// program's setup on Linux and macOS, by ending with the restart code under the Windows launcher,
// and not by itself where a person started It by hand.
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { afterUpgrade } from './src/connector'
import { Problem } from './src/lib'
import { launcherAsWritten, launcherStartsAgain, RESTART_CODE, restartWay, windowsLauncher } from './src/service'

const stand = vi.hoisted(() => ({ connectorEnds: 0, refused: undefined as Error | undefined, ran: 0 }))
// The connector the service runs, as a stand-in that stops at once with the code a test gives it
vi.mock('./src/connector', async (original) => ({
  ...(await original<typeof import('./src/connector')>()),
  runConnector: async () => {
    if (stand.refused) throw stand.refused
    stand.ran++
    process.exitCode = stand.connectorEnds
  },
}))

const done = { from: '0.1.0', to: '0.1.1', program: path.join(os.tmpdir(), 'it-new', 'it.exe') }
/** What the connector told the site and how it stopped, for each way. */
const watch = (tell: (said: object) => Promise<unknown> = async () => {}) => {
  const said: object[] = []
  const lines: string[] = []
  const stops: number[] = []
  return {
    said,
    lines,
    stops,
    with: {
      say: (line: string) => void lines.push(line),
      tell: (s: object) => {
        said.push(s)
        return tell(s)
      },
      stop: (code: number) => void stops.push(code),
    },
  }
}

describe('what follows an upgrade asked for on the site, once the new program is in place', () => {
  afterEach(() => void vi.useRealTimers())

  test('under the Windows launcher, the site is told the machine is starting again, and the service stops with the restart code', async () => {
    const w = watch()
    const run = vi.fn()
    await afterUpgrade(done, 'launcher', { ...w.with, run: run as never })
    expect(w.said).toEqual([{ state: 'restarting', version: '0.1.1' }])
    expect(w.stops).toEqual([RESTART_CODE])
    // Nothing is started outside the task: the launcher starts the new program itself
    expect(run).not.toHaveBeenCalled()
    expect(w.lines).toEqual(['upgrade: starting again as 0.1.1'])
  })

  test('an It from before the restarting state refuses it, and is told that the machine is still at work instead', async () => {
    const w = watch(async (s) => {
      if ((s as { state: string }).state === 'restarting') throw Object.assign(new Error('ArgumentValidationError'), { code: 'invalid' })
    })
    await afterUpgrade(done, 'launcher', w.with)
    expect(w.said).toEqual([
      { state: 'restarting', version: '0.1.1' },
      { state: 'working', version: '0.1.1' },
    ])
    expect(w.stops).toEqual([RESTART_CODE])
  })

  test('a site that does not answer is waited for only a few seconds, and the service starts again as the new program all the same', async () => {
    vi.useFakeTimers()
    const w = watch(() => new Promise(() => {}))
    const after = afterUpgrade(done, 'launcher', w.with)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(w.stops).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    await after
    expect(w.stops).toEqual([RESTART_CODE])
  })

  test('started by hand, the program is in place and the site says so, and nothing is stopped or started', async () => {
    const w = watch()
    const run = vi.fn()
    await afterUpgrade(done, 'by hand', { ...w.with, run: run as never })
    expect(w.said).toEqual([{ state: 'installed', version: '0.1.1' }])
    expect(w.stops).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  test('on Linux and macOS, the new program’s setup is started as before, and a setup that fails is said on the site', async () => {
    const w = watch()
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const run = vi.fn(() => child)
    await afterUpgrade(done, 'setup', { ...w.with, run: run as never })
    expect(run).toHaveBeenCalledWith(done.program, ['setup'], expect.objectContaining({ detached: true, stdio: 'ignore' }))
    expect(w.stops).toEqual([])
    expect(w.said).toEqual([])
    child.emit('exit', 1, null)
    expect(w.said).toEqual([{ state: 'failed', why: 'It 0.1.1 is in place on that machine, and It could not be started again as it. Run `it setup` there.' }])
  })

  test('the Windows launcher is left as it was: cmd.exe reads it as it runs it', async () => {
    const before = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-restart-'))
    try {
      process.env.IT_HOME = folder
      const file = path.join(folder, 'bin', 'it-service.cmd')
      mkdirSync(path.dirname(file), { recursive: true })
      const launcher = windowsLauncher(['C:\\it\\bin\\it.exe', 'serve', '--supervised'], { IT_HOME: folder })
      writeFileSync(file, launcher)
      await afterUpgrade(done, 'launcher', watch().with)
      expect(readFileSync(file, 'utf8')).toBe(launcher)
    } finally {
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('which way It comes back after an upgrade', () => {
  test('a service nobody started with --supervised was started by hand, on every system', () => {
    const argv = process.argv
    try {
      process.argv = [process.execPath, 'it.mjs', 'serve']
      expect(restartWay()).toBe('by hand')
    } finally {
      process.argv = argv
    }
  })

  test('a Windows launcher starts the program again after it ends with a failure, and one without the loop is not counted on to', () => {
    const launcher = windowsLauncher(['C:\\it\\bin\\it.exe', 'serve', '--supervised'], { IT_HOME: 'C:\\it' })
    expect(launcherStartsAgain(launcher)).toBe(true)
    expect(launcherStartsAgain(launcher.replace('goto again\r\n', ''))).toBe(false)
    expect(launcherStartsAgain(launcher.replace('if %errorlevel% equ 0 exit /b 0\r\n', ''))).toBe(false)
    expect(launcherStartsAgain('@echo off\r\n"C:\\it\\bin\\it.exe" serve\r\n')).toBe(false)
    expect(launcherStartsAgain('')).toBe(false)
  })

  test('a launcher this version wrote is known as its own whatever settings it was given, and one an earlier version wrote another way is not', () => {
    const cmd = ['C:\\it\\bin\\it.exe', 'serve', '--supervised', '--log', 'C:\\it\\logs\\it.log']
    const launcher = windowsLauncher(cmd, { IT_HOME: 'C:\\it', PATH: 'C:\\a;C:\\b' })
    expect(launcherAsWritten(launcher, cmd)).toBe(true)
    expect(launcherAsWritten(launcher.replace('ping -n 6', 'ping -n 11'), cmd)).toBe(false)
    expect(launcherAsWritten(launcher, [...cmd.slice(0, -1), 'D:\\elsewhere.log'])).toBe(false)
  })
})

describe('the service, stopped to be started again as a newer It', () => {
  const before = { home: process.env.IT_HOME, url: process.env.IT_URL }
  let folder = ''
  afterEach(() => {
    process.exitCode = undefined
    for (const [name, was] of [
      ['IT_HOME', before.home],
      ['IT_URL', before.url],
    ] as const)
      if (was === undefined) delete process.env[name]
      else process.env[name] = was
    if (folder) rmSync(folder, { recursive: true, force: true })
  })
  /** Runs the service on a machine whose backend is elsewhere, with a connector that stops with `code`. */
  const served = async (code: number) => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-restart-serve-'))
    process.env.IT_HOME = folder
    process.env.IT_URL = 'http://127.0.0.1:9'
    writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', token: 'x' }))
    stand.connectorEnds = code
    const { serve } = await import('./src/serve')
    const lines: string[] = []
    await serve((line) => void lines.push(line))
    return { code: process.exitCode, lines }
  }

  test('ends with the restart code, which is what has its launcher start it again at once', async () => {
    const { code, lines } = await served(RESTART_CODE)
    expect(code).toBe(RESTART_CODE)
    expect(lines.at(-1)).toBe('service stopped, to be started again by its launcher as the program installed now')
  })

  test('and one that stops to make way for a newer It installed by another command still ends as a failure, as it did', async () => {
    const { code, lines } = await served(1)
    expect(code).toBe(1)
    expect(lines.at(-1)).toBe('service stopped')
  })
})

// The launcher as setup writes it, run by cmd.exe as the task runs it, with a stand-in for the
// program: it ends with the restart code the first time and well the second. The launcher starts
// it again after the first, and stops after the second.
describe.skipIf(process.platform !== 'win32')('the Windows launcher, run by cmd.exe', () => {
  test('starts the program again once it ends with the restart code, and stops once it ends well', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-launcher-'))
    try {
      const count = path.join(folder, 'count.txt')
      const program = path.join(folder, 'serve.cjs')
      writeFileSync(
        program,
        `const fs = require('node:fs')
const file = process.env.IT_TEST_COUNT
const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1
fs.writeFileSync(file, String(n))
process.exit(n === 1 ? ${RESTART_CODE} : 0)
`,
      )
      const launcher = path.join(folder, 'it-service.cmd')
      writeFileSync(launcher, windowsLauncher([process.execPath, program, 'serve', '--supervised'], { IT_TEST_COUNT: count }))
      const r = spawnSync('cmd.exe', ['/d', '/c', launcher], { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      expect(r.error).toBeUndefined()
      expect(readFileSync(count, 'utf8')).toBe('2')
      expect(r.status).toBe(0)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 90_000)
})

// #353: a second service for the same folder, started by a launcher of its own, finds the
// connector held by another, such as one a person started or a launcher a replaced task left
// running. It cannot tell which, so it never ends its own launcher: it waits, and once the other
// has gone it is started again by its launcher as the program installed now.
describe('a service that is the connector alone and finds another connector holding the folder', () => {
  const before = process.env.IT_HOME
  let folder = ''
  afterEach(() => {
    vi.useRealTimers()
    stand.refused = undefined
    stand.ran = 0
    stand.connectorEnds = 0
    process.exitCode = undefined
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
    if (folder) rmSync(folder, { recursive: true, force: true })
  })
  /** Another connector holds the folder, as a running one notes it there: this process stands in for it. */
  const holding = () => {
    writeFileSync(path.join(folder, 'connector.json'), JSON.stringify({ pid: process.pid }))
    writeFileSync(path.join(folder, 'connector.lock'), JSON.stringify({ pid: process.pid }))
  }
  /** And has gone, taking its notes with it. */
  const gone = () => {
    rmSync(path.join(folder, 'connector.json'), { force: true })
    rmSync(path.join(folder, 'connector.lock'), { force: true })
    stand.refused = undefined
  }
  const held = async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-restart-held-'))
    process.env.IT_HOME = folder
    writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', token: 'x' }))
    holding()
    stand.ran = 0
    stand.refused = new Problem('A connector is already running for this folder.', 'already_running')
    return (await import('./src/serve')).connector
  }

  test('under the Windows launcher, waits for the other to go, saying so seldom, then ends to be started again, and the next start takes over', async () => {
    vi.useFakeTimers()
    const connector = await held()
    const lines: string[] = []
    let over: boolean | undefined
    const ending = connector(
      (line) => void lines.push(line),
      new AbortController().signal,
      () => 'SIGTERM',
      true,
    ).then((failed) => {
      over = failed
      return failed
    })
    // Twenty minutes of the other holding it: waited out at longer and longer intervals, and said once
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(over).toBeUndefined()
    expect(lines).toEqual([
      'connector: could not start: already_running',
      'another It already runs the connector for this folder; this service waits for it to stop, and then starts again',
    ])
    // Half an hour on, that it is still waiting is said once more
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(over).toBeUndefined()
    expect(lines.at(-1)).toBe('another It still runs the connector for this folder; this service goes on waiting for it to stop')
    expect(lines).toHaveLength(3)
    // The other goes: within the longest wait, this one ends with the restart code, which its launcher answers, and has not run a connector itself
    gone()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await ending).toBe(true)
    expect(process.exitCode).toBe(RESTART_CODE)
    expect(lines.at(-1)).toBe('the connector that held this folder has stopped; this service ends to be started again as the program installed now')
    expect(stand.ran).toBe(0)
    // Started again by its launcher, as the program installed now, it takes the connector
    process.exitCode = undefined
    stand.connectorEnds = RESTART_CODE
    expect(
      await connector(
        () => {},
        new AbortController().signal,
        () => 'SIGTERM',
        true,
      ),
    ).toBe(true)
    expect(stand.ran).toBe(1)
  })

  test('anywhere else, waits for it as before, until it is asked to stop', async () => {
    const connector = await held()
    const lines: string[] = []
    const asked = new AbortController()
    const ending = connector(
      (line) => void lines.push(line),
      asked.signal,
      () => 'SIGTERM',
      false,
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(lines).toEqual(['connector: could not start: already_running'])
    asked.abort()
    expect(await ending).toBe(false)
  })

  test('under the launcher, a service asked to stop while it waits stops, and ends well', async () => {
    const connector = await held()
    const asked = new AbortController()
    const ending = connector(
      () => {},
      asked.signal,
      () => 'SIGTERM',
      true,
    )
    await new Promise((r) => setTimeout(r, 200))
    asked.abort()
    expect(await ending).toBe(false)
    expect(process.exitCode).toBeUndefined()
  })

  test('another failure to start is waited out under the launcher as before, and does not end the service', async () => {
    const connector = await held()
    stand.refused = new Problem('It could not be reached.', 'offline')
    const asked = new AbortController()
    const ending = connector(
      () => {},
      asked.signal,
      () => 'SIGTERM',
      true,
    )
    let over = false
    void ending.then(() => {
      over = true
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(over).toBe(false)
    asked.abort()
    expect(await ending).toBe(false)
  })
})
