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
import { launcherAsWritten, launcherStartsAgain, RESTART_CODE, restartWay, windowsLauncher } from './src/service'

const stand = vi.hoisted(() => ({ connectorEnds: 0 }))
// The connector the service runs, as a stand-in that stops at once with the code a test gives it
vi.mock('./src/connector', async (original) => ({
  ...(await original<typeof import('./src/connector')>()),
  runConnector: async () => {
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
    expect(lines.at(-1)).toBe('service stopped, to be started again as the newer It')
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

