// What It says when a program of the system's own that it started and waited for did not do what
// it was asked (#404): to a person in words, with what the program printed, and to its log in a
// code and a number. The questions put to Windows about the service's task are asked here through
// the program's own functions, with a stand-in for PowerShell that fails in each way.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { helped } from './src/serve/backend'
import { endedAs, failure, notStarted } from './src/serve/ended'
import { install, installedHere, installedHereOr, status } from './src/service'

/** What stands in for PowerShell: what `spawnSync` gives of it, for as long as a test says so, and how often it was started. */
const stand = vi.hoisted(() => ({ powershell: undefined as (() => unknown) | undefined, started: 0 }))
vi.mock('./src/child', async (original) => {
  const real = await original<typeof import('./src/child')>()
  return {
    ...real,
    runSync: (file: string, ...rest: unknown[]) => {
      if (!stand.powershell || file !== 'powershell.exe') return (real.runSync as (...given: unknown[]) => unknown)(file, ...rest)
      stand.started++
      return stand.powershell()
    },
  }
})

const error = (code: string) => Object.assign(new Error(`spawnSync powershell.exe ${code} at C:\\Users\\a person`), { code })
/** PowerShell that ended with a code of its own, having printed something. */
const exited = () => ({ pid: 1, output: [], status: 5, signal: null, stdout: 'Get-ScheduledTask : Access is denied.\r\n', stderr: '' })
/** PowerShell that was ended at its time limit, having printed nothing. */
const atLimit = () => ({ pid: 1, output: [], status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: error('ETIMEDOUT') })
/** PowerShell that could not be started. */
const missing = () => ({ pid: 0, output: null, status: null, signal: null, stdout: null, stderr: null, error: error('ENOENT') })

describe('how a helper ended, as the log says it', () => {
  test('is a word and the numbers that go with it, and never the words of an error', () => {
    expect(endedAs(exited(), 2812, 30_000)).toBe('exit_5')
    expect(endedAs({ status: 3221225786, signal: null }, 500)).toBe('exit_3221225786')
    expect(endedAs(atLimit() as never, 30_004, 30_000)).toBe('timed_out after 30004 ms')
    // A limit that ended the helper before its time, as the runtime's fault on Windows does
    expect(endedAs(atLimit() as never, 41.4, 30_000)).toBe('cut_short after 41 of 30000 ms')
    expect(endedAs({ status: null, signal: 'SIGTERM' }, 120, 30_000)).toBe('ended_by SIGTERM after 120 ms')
    expect(endedAs(missing(), 3, 30_000)).toBe('not_started ENOENT')
    // An error that names no code of the system's is said as an error, and nothing of what it says is kept
    expect(endedAs({ status: null, signal: null, error: new Error('C:\\Users\\a person could not be read') }, 3)).toBe('not_started error')
    expect(endedAs({ status: null, signal: null, error: error('C:\\Users\\a person') }, 3)).toBe('not_started error')
    expect(endedAs({ status: null, signal: null }, 3)).toBe('unknown')
    expect([notStarted(missing()), notStarted(atLimit() as never), notStarted(exited())]).toEqual([true, false, false])
  })

  test('the same failure is told to a person in words, with what was printed', () => {
    expect(failure('PowerShell', { ...exited(), out: 'Access is denied.' }, 2812, 30_000)).toBe(
      'PowerShell ended with exit code 5 after 2.8 seconds, and printed: Access is denied.',
    )
  })
})

describe('what became of the helper that asks a program on Windows to stop', () => {
  test('a helper that says how far it got is gone by: the program was asked, or it could not be', () => {
    expect(helped({ status: 0, signal: null }, 1300, 30_000)).toBeUndefined()
    expect(helped({ status: 3, signal: null }, 900, 30_000)).toEqual({ code: 'no_console', maybe: false })
    expect(helped({ status: 4, signal: null }, 900, 30_000)).toEqual({ code: 'no_event', maybe: false })
  })

  test('a helper that failed in another way is said with how it ended, and only one that never started is known to have asked nothing', () => {
    expect(helped(exited(), 1100, 30_000)).toEqual({ code: 'no_helper, exit_5', maybe: true })
    expect(helped(atLimit() as never, 30_011, 30_000)).toEqual({ code: 'no_helper, timed_out after 30011 ms', maybe: true })
    expect(helped(atLimit() as never, 70, 30_000)).toEqual({ code: 'no_helper, cut_short after 70 of 30000 ms', maybe: true })
    expect(helped({ status: null, signal: 'SIGKILL' }, 250, 30_000)).toEqual({ code: 'no_helper, ended_by SIGKILL after 250 ms', maybe: true })
    expect(helped(missing(), 2, 30_000)).toEqual({ code: 'no_helper, not_started ENOENT', maybe: false })
  })
})

describe('a question to Windows about the service’s task that PowerShell does not answer', () => {
  const before = { home: process.env.IT_HOME, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-asked-'))
    process.env.IT_HOME = path.join(folder, '.it')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    stand.started = 0
  })
  afterEach(() => {
    stand.powershell = undefined
    Object.defineProperty(process, 'platform', before.platform)
    if (before.home === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before.home
    rmSync(folder, { recursive: true, force: true })
  })

  const TOOK = String.raw`after \d+\.\d seconds`
  /** Why, as it is said of a question that was put twice: once with "(twice)" where both failures read the same, and both where their times differ. */
  const twice = (why: string) => new RegExp(`^reading the registered tasks failed: ${why}( \\(twice\\)|; asked once before, ${why})$`)
  const ways: [string, () => unknown, RegExp, number][] = [
    [
      'ended with a code of its own, having printed why',
      exited,
      twice(String.raw`PowerShell ended with exit code 5 ${TOOK}, and printed: Get-ScheduledTask : Access is denied\.`),
      2,
    ],
    // One that was ended at its limit is not asked again: a second try would only wait the limit out once more
    [
      'was ended at its time limit',
      atLimit,
      new RegExp(`^reading the registered tasks failed: PowerShell was ended at its limit of 30 seconds, ${TOOK}, and printed nothing$`),
      1,
    ],
    ['could not be started', missing, twice(String.raw`PowerShell could not be started \(ENOENT\), and printed nothing`), 2],
  ]

  test.each(ways)('setup says why where PowerShell %s, and the failed question is never taken for there being no task', (_how, powershell, said, started) => {
    stand.powershell = powershell
    // What `it setup` prints after "It could not be registered as a background service: "
    expect(() => install()).toThrow(said)
    expect(stand.started).toBe(started)
    expect(() => installedHere()).toThrow(said)
    // What setup goes by to say whether the service or an `it serve` started by hand is what runs: neither
    expect(installedHereOr(undefined)).toBeUndefined()
    // And `it service status` says that it is not known, with why, and not that nothing is registered
    const now = status()
    expect([now.registered, now.state]).toEqual([false, 'unknown'])
    expect(now.note).toMatch(/^Windows could not be asked about this account's scheduled tasks: PowerShell /)
    // Nothing was written for a task that could not be read
    expect(existsSync(path.join(process.env.IT_HOME!, 'bin', 'it-service.cmd'))).toBe(false)
  })
})
