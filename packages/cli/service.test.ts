// What the background service is given when it is registered, and what is kept of it when it
// is registered again: checked on the definitions themselves, with no system asked to take one.
import * as childProcess from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { alone, nothingLeft, startBackend } from './src/serve/backend'
import {
  againWith,
  askToStop,
  command,
  definedFor,
  environment,
  given,
  install,
  kept,
  launchdPlist,
  PS_QUIET,
  restartsAfterUpgrade,
  runningFor,
  stopFile,
  supervised,
  systemdUnit,
  uninstall,
  waitForLaunchdUnload,
  windowsLauncher,
  windowsRemoval,
  windowsScript,
} from './src/service'

vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()) }))

describe('what a service is given of the shell that registered it', () => {
  test('that the person’s shell is not to be asked is said to the service, which is what would ask it', () => {
    expect(environment({ PATH: '/bin', IT_SHELL_ENV: 'off' })).toEqual({ PATH: '/bin', IT_SHELL_ENV: 'off' })
  })
  test('that It is not to look for a newer version is not, since `it updates on` could then never turn it back on', () => {
    expect(environment({ PATH: '/bin', IT_UPDATE_CHECK: 'false' })).toEqual({ PATH: '/bin' })
  })
  test('marks the command that the supervisor launches without passing the marker to child commands', () => {
    expect(command()).toContain('--supervised')
    const argv = process.argv
    try {
      process.argv = [process.execPath, 'it.mjs', 'serve']
      expect(supervised()).toBe(false)
      process.argv.push('--supervised')
      expect(supervised()).toBe(true)
      process.argv = [process.execPath, 'it.mjs', 'serve', '--log', 'test.log']
      expect(supervised()).toBe(false)
    } finally {
      process.argv = argv
    }
  })
})

describe('what a registered service was given, read back from its definition', () => {
  const cmd = ['/home/a user/.it/bin/it', 'serve', '--log', '/home/a user/.it/logs/it.log']
  // Every character that one of the three definitions writes as something other than itself
  const env = {
    PATH: '/bin:/usr/bin',
    IT_HOME: '/home/a user/50% & <done> "it" \\ $HOME',
    IT_PORT: '4800',
    IT_BACKEND_BIN: '/opt/back^end/(convex)|local',
    IT_URL: 'http://127.0.0.1:23000',
  }
  test('is every setting as the shell gave it, on all three systems, whatever characters are in it', () => {
    expect(given(systemdUnit(cmd, env), 'linux')).toEqual(env)
    expect(given(launchdPlist(cmd, env), 'darwin')).toEqual(env)
    expect(given(windowsLauncher(['C:\\it\\bin\\it.exe', 'serve'], env), 'win32')).toEqual(env)
  })
  test('is nothing where the definition gives nothing, or is not one', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(given('', platform)).toEqual({})
      expect(given('not a definition\nset\nEnvironment=\n<key>IT_PORT</key>', platform)).toEqual({})
    }
    expect(given(systemdUnit(cmd, env), 'freebsd')).toEqual({})
  })
  test.skipIf(process.platform !== 'linux')(
    'is kept when the service is registered again from a shell that names less, as an upgrade registers it, and gives way to what that shell does name',
    () => {
      const user = mkdtempSync(path.join(os.tmpdir(), 'it-kept-'))
      const before = { home: process.env.IT_HOME, config: process.env.XDG_CONFIG_HOME }
      try {
        process.env.IT_HOME = path.join(user, 'it')
        process.env.XDG_CONFIG_HOME = path.join(user, 'config')
        const registered = path.join(user, 'config', 'systemd', 'user', 'it.service')
        mkdirSync(path.dirname(registered), { recursive: true })
        // Nothing is registered: nothing was given
        expect(kept()).toEqual({})
        expect(againWith({ PATH: '/bin', TERM: 'xterm' })).toEqual({ PATH: '/bin', TERM: 'xterm' })
        // Registered with a port and a backend program that only the shell of that day named
        const saved = { PATH: '/then/bin', IT_HOME: process.env.IT_HOME, IT_PORT: '4800', IT_BACKEND_BIN: '/opt/backend/convex-local-backend' }
        writeFileSync(registered, systemdUnit(command(), saved))
        const argv = process.argv
        try {
          process.argv = [process.execPath, 'it.mjs', 'serve']
          expect(restartsAfterUpgrade()).toBe(false)
          process.argv.push('--supervised')
          expect(restartsAfterUpgrade()).toBe(true)
          rmSync(registered)
          expect(restartsAfterUpgrade()).toBe(false)
          writeFileSync(registered, systemdUnit(command(), saved))
        } finally {
          process.argv = argv
        }
        // The PATH is each shell's own to give, and is not kept
        expect(kept()).toEqual({ IT_HOME: saved.IT_HOME, IT_PORT: '4800', IT_BACKEND_BIN: '/opt/backend/convex-local-backend' })
        // A terminal that names neither: both go on to the setup that registers the service again
        expect(againWith({ PATH: '/now/bin', TERM: 'xterm' })).toEqual({
          PATH: '/now/bin',
          TERM: 'xterm',
          IT_HOME: saved.IT_HOME,
          IT_PORT: '4800',
          IT_BACKEND_BIN: '/opt/backend/convex-local-backend',
        })
        // What the terminal does name is what it says, as it always was
        expect(againWith({ PATH: '/now/bin', IT_PORT: '4900' }).IT_PORT).toBe('4900')
        // A definition that is another folder's says nothing of this one
        process.env.IT_HOME = path.join(user, 'another')
        expect(kept()).toEqual({})
      } finally {
        for (const [name, was] of [
          ['IT_HOME', before.home],
          ['XDG_CONFIG_HOME', before.config],
        ] as const)
          if (was === undefined) delete process.env[name]
          else process.env[name] = was
        rmSync(user, { recursive: true, force: true })
      }
    },
  )
})

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('registering the service again on a Mac', () => {
  test.each(['delayed', 'timeout', 'unanswered'] as const)('waits for confirmed unload before loading a replacement (%s)', (outcome) => {
    const user = mkdtempSync(path.join(os.tmpdir(), 'it-launchd-wait-'))
    const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
    const commands = path.join(user, 'commands')
    const asked = path.join(user, 'asked')
    const polls = path.join(user, 'polls')
    const definition = path.join(user, 'Library', 'LaunchAgents', 'dev.it.plist')
    let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      mkdirSync(commands)
      mkdirSync(path.dirname(definition), { recursive: true })
      writeFileSync(
        path.join(commands, 'launchctl'),
        `#!/bin/sh
echo "$1" >> '${asked}'
case "$1" in
  print)
    n=0; [ ! -f '${polls}' ] || n=$(cat '${polls}')
    n=$((n + 1)); echo "$n" > '${polls}'
    ${outcome === 'unanswered' ? 'exit 1' : outcome === 'timeout' ? 'exit 0' : '[ "$n" -le 3 ] || exit 113'} ;;
esac
`,
        { mode: 0o755 },
      )
      process.env.IT_HOME = path.join(user, '.it')
      process.env.PATH = `${commands}:/usr/bin:/bin`
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const earlier = launchdPlist(command(), { PATH: '/earlier/path' })
      writeFileSync(definition, earlier)
      if (outcome === 'timeout') {
        let now = Date.now()
        clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 100_000))
      }
      if (outcome === 'delayed') {
        install()
        expect(readFileSync(asked, 'utf8').trim().split('\n').slice(0, 6)).toEqual(['bootout', 'print', 'print', 'print', 'print', 'bootstrap'])
      } else {
        expect(() => install()).toThrow(outcome === 'timeout' ? /still unloading/ : /could not confirm/)
        expect(readFileSync(definition, 'utf8')).toBe(earlier)
        expect(readFileSync(asked, 'utf8')).not.toContain('bootstrap')
      }
    } finally {
      clock?.mockRestore()
      homedir.mockRestore()
      Object.defineProperty(process, 'platform', before.platform)
      process.env.PATH = before.PATH
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(user, { recursive: true, force: true })
    }
  })

  test('bounds a launchd question that does not answer', () => {
    const user = mkdtempSync(path.join(os.tmpdir(), 'it-launchd-silent-'))
    const was = process.env.PATH
    try {
      writeFileSync(path.join(user, 'launchctl'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 })
      process.env.PATH = `${user}:/usr/bin:/bin`
      const began = Date.now()
      expect(() => waitForLaunchdUnload(100)).toThrow(/could not confirm/)
      expect(Date.now() - began).toBeLessThan(3000)
    } finally {
      process.env.PATH = was
      rmSync(user, { recursive: true, force: true })
    }
  })

  test.each([false, true])(
    'restores the earlier definition after loading fails, and says separately whether loading it again failed too (%s)',
    (recoveryFails) => {
      const user = mkdtempSync(path.join(os.tmpdir(), 'it-launchd-'))
      const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
      const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
      try {
        const commands = path.join(user, 'commands')
        const loaded = path.join(user, 'loaded')
        const asked = path.join(user, 'asked')
        mkdirSync(commands)
        writeFileSync(
          path.join(commands, 'launchctl'),
          `#!/bin/sh
echo "$1" >> '${asked}'
case "$1" in
  bootout) rm -f '${loaded}' ;;
  print) test -f '${loaded}' || exit 113 ;;
  bootstrap)
    if grep -q '/an/earlier/path' "$3"; then
      ${recoveryFails ? 'echo recovery refused; exit 1' : `touch '${loaded}'`}
    else
      echo replacement refused; exit 1
    fi ;;
esac
`,
          { mode: 0o755 },
        )
        process.env.IT_HOME = path.join(user, '.it')
        process.env.PATH = `${commands}:/usr/bin:/bin`
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        const definition = path.join(user, 'Library', 'LaunchAgents', 'dev.it.plist')
        mkdirSync(path.dirname(definition), { recursive: true })
        const earlier = launchdPlist(command(), { PATH: '/an/earlier/path' })
        writeFileSync(definition, earlier)
        writeFileSync(loaded, '')
        expect(() => install()).toThrow(recoveryFails ? /replacement refused.*restoring the earlier agent failed: recovery refused/ : /replacement refused/)
        expect(readFileSync(definition, 'utf8')).toBe(earlier)
        expect(readFileSync(asked, 'utf8').trim().split('\n')).toEqual(['bootout', 'print', 'bootstrap', 'bootstrap'])
        expect(existsSync(loaded)).toBe(!recoveryFails)
      } finally {
        homedir.mockRestore()
        Object.defineProperty(process, 'platform', before.platform)
        process.env.PATH = before.PATH
        if (before.home === undefined) delete process.env.IT_HOME
        else process.env.IT_HOME = before.home
        rmSync(user, { recursive: true, force: true })
      }
    },
  )

  test('where the new definition cannot be written, the service that is running is left running: launchd is told nothing until the definition is there', () => {
    const user = mkdtempSync(path.join(os.tmpdir(), 'it-launchd-'))
    const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
    const agents = path.join(user, 'Library', 'LaunchAgents')
    try {
      // What stands in for launchd's own command notes each thing it is asked
      const commands = path.join(user, 'commands')
      const asked = path.join(user, 'launchctl-was-asked')
      mkdirSync(commands)
      writeFileSync(path.join(commands, 'launchctl'), `#!/bin/sh\necho "$1" >> '${asked}'\n[ "$1" != print ] || exit 113\n`, { mode: 0o755 })
      const told = () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : [])
      process.env.IT_HOME = path.join(user, '.it')
      process.env.PATH = `${commands}:/usr/bin:/bin`
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      // A service is registered, and running
      mkdirSync(agents, { recursive: true })
      const definition = path.join(agents, 'dev.it.plist')
      writeFileSync(definition, launchdPlist(command(), { PATH: '/an/earlier/path' }))
      // The folder its definition is in takes no new file, as a disk that is full takes none
      chmodSync(agents, 0o555)
      expect(() => install()).toThrow(/EACCES|EPERM/)
      expect(told()).toEqual([])
      expect(readFileSync(definition, 'utf8')).toContain('/an/earlier/path')
      // Once it can be written, the old one is taken out of launchd and the new one given to it, in that order
      chmodSync(agents, 0o755)
      install()
      expect(told().slice(0, 3)).toEqual(['bootout', 'print', 'bootstrap'])
      expect(readFileSync(definition, 'utf8')).not.toContain('/an/earlier/path')
    } finally {
      chmodSync(agents, 0o755)
      homedir.mockRestore()
      Object.defineProperty(process, 'platform', before.platform)
      process.env.PATH = before.PATH
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(user, { recursive: true, force: true })
    }
  })
})

describe('taking the task away on Windows', () => {
  test.skipIf(process.platform === 'win32')('with no task and no lock, taking It away succeeds even when asking for a missing task would fail silently', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-no-task-'))
    const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    try {
      const commands = path.join(folder, 'commands')
      const asked = path.join(folder, 'asked')
      const launcher = path.join(folder, 'bin', 'it-service.cmd')
      mkdirSync(commands)
      mkdirSync(path.dirname(launcher))
      writeFileSync(launcher, '@echo off\r\n')
      // A failed cmdlet leaves PowerShell's success flag false, even when its error was silenced.
      writeFileSync(
        path.join(commands, 'powershell.exe'),
        `#!${process.execPath}
const fs = require('node:fs')
const script = Buffer.from(process.argv.at(-1), 'base64').toString('utf16le')
fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify(script) + '\\n')
const missing = script.includes("Get-ScheduledTask -TaskName 'it'")
process.exit(/exit 0\\s*$/.test(script) ? 0 : missing ? 1 : 0)
`,
        { mode: 0o755 },
      )
      process.env.IT_HOME = folder
      process.env.PATH = commands
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect([definedFor(), runningFor(folder)]).toEqual(['none', false])
      askToStop(folder, 50)
      expect(existsSync(stopFile(folder))).toBe(false)
      expect(() => uninstall(50)).not.toThrow()
      expect(existsSync(launcher)).toBe(false)
      const scripts = readFileSync(asked, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string)
      expect(scripts).toHaveLength(2)
      expect(scripts[1]).toContain(".Replace('/', '\\').TrimEnd('\\')")
      expect(scripts[1]).toMatch(/; exit 0$/)
      expect(scripts[1]).not.toContain("Get-ScheduledTask -TaskName 'it'")
    } finally {
      Object.defineProperty(process, 'platform', before.platform)
      process.env.PATH = before.PATH
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('only a task that is started in this folder is stopped and taken away: another account’s It, or something else of the person’s that is called `it`, is left as it is', () => {
    const script = windowsRemoval("C:\\Users\\O'Neil\\.it\\bin\\")
    expect(script).toContain("$name = 'it-' + $sid")
    expect(script).toContain('Test-ItTask $legacy')
    expect(script).toContain("-ieq 'C:\\Users\\O''Neil\\.it\\bin'")
    expect(script).toContain('Unregister-ScheduledTask -InputObject $owned')
    expect(windowsRemoval('C:/Users/Ada/.it/bin')).toContain("-ieq 'C:\\Users\\Ada\\.it\\bin'")
    expect(windowsScript('C:\\Users\\Ada\\.it\\bin', 'it-service.cmd')).toContain("-WorkingDirectory 'C:\\Users\\Ada\\.it\\bin'")
  })

  test.skipIf(process.platform !== 'win32').each(['absent', 'another folder', 'this folder'])(
    'does not confuse tasks in different scheduler folders when removing It (%s)',
    (root) => {
      // These functions replace the scheduler cmdlets, so no installed task is changed.
      // The other folder's task deliberately comes first and uses this installation's launcher.
      const script = `
${PS_QUIET}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function New-ItTestTask($taskPath, $folder) {
  [pscustomobject]@{ TaskName = 'it'; TaskPath = $taskPath; Principal = [pscustomobject]@{ UserId = $sid }; Actions = @([pscustomobject]@{ Execute = 'conhost.exe'; Arguments = '--headless cmd.exe /d /c .\\it-service.cmd'; WorkingDirectory = $folder }) }
}
$script:tasks = @(
  (New-ItTestTask '\\Other\\' 'C:\\it\\bin')
  ${root === 'absent' ? '' : `(New-ItTestTask '\\' '${root === 'this folder' ? 'C:\\it\\bin' : 'C:\\elsewhere\\bin'}')`}
)
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskPath, [string]$TaskName)
  $script:tasks | Where-Object { (!$TaskPath -or $_.TaskPath -eq $TaskPath) -and (!$TaskName -or $_.TaskName -eq $TaskName) }
}
function Stop-ScheduledTask {
  [CmdletBinding()] param($InputObject)
  $TaskName = $InputObject.TaskName; $TaskPath = $InputObject.TaskPath
  "stopped $TaskPath$TaskName"
}
function Unregister-ScheduledTask {
  [CmdletBinding(SupportsShouldProcess)] param($InputObject)
  $TaskName = $InputObject.TaskName; $TaskPath = $InputObject.TaskPath
  "removed $TaskPath$TaskName"
  $script:tasks = @($script:tasks | Where-Object { $_.TaskName -ne $TaskName -or $_.TaskPath -ne $TaskPath })
}
${windowsRemoval('C:\\it\\bin')}
`
      const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      })
      expect(ran.error).toBeUndefined()
      expect(ran.status).toBe(0)
      expect(ran.stderr).toBe('')
      expect(ran.stdout.trim().split(/\r?\n/).filter(Boolean)).toEqual(root === 'this folder' ? ['stopped \\it', 'removed \\it'] : [])
    },
  )
})

describe('migrating Windows tasks', () => {
  test('waits for both owned installations and this folder before ending either launcher', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-migrate-'))
    const before = { home: process.env.IT_HOME, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    const folders = ['account', 'legacy', 'current'].map((name) => path.join(folder, name))
    const checks = new Map<number, number>()
    const stopped = new Set<string>()
    const changed: string[] = []
    for (const [i, at] of folders.entries()) {
      mkdirSync(at)
      writeFileSync(path.join(at, 'connector.json'), JSON.stringify({ pid: 100_000 + i }))
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(signal).toBe(0)
      const at = folders[pid - 100_000]!
      expect(at).toBeDefined()
      if (existsSync(stopFile(at))) {
        const count = (checks.get(pid) ?? 0) + 1
        checks.set(pid, count)
        // Receiving the stop file is not enough: the service still has work to finish.
        if (count >= 2) {
          stopped.add(at)
          throw Object.assign(new Error('stopped'), { code: 'ESRCH' })
        }
      }
      return true
    })
    const run = vi.spyOn(childProcess, 'spawnSync').mockImplementation((_cmd, args) => {
      const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le')
      let stdout = ''
      if (script.includes('Register-ScheduledTask')) {
        changed.push(script)
        expect([...stopped].sort()).toEqual([...folders].sort())
      } else if (script.includes('GetBytes(')) {
        stdout = folders
          .slice(0, 2)
          .map((at) => Buffer.from(path.join(at, 'bin')).toString('base64'))
          .join('\r\n')
      } else stdout = 'it-test\r\nReady'
      return { status: 0, stdout, stderr: '', pid: 0, output: [], signal: null }
    })
    try {
      process.env.IT_HOME = folders[2]
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect(install().registered).toBe(true)
      expect(changed).toHaveLength(1)
      expect(folders.every((at) => existsSync(stopFile(at)))).toBe(true)
    } finally {
      run.mockRestore()
      kill.mockRestore()
      Object.defineProperty(process, 'platform', before.platform)
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('leaves both launchers alone when their folders cannot be discovered', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-unread-tasks-'))
    const before = { home: process.env.IT_HOME, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    const changed: string[] = []
    const run = vi.spyOn(childProcess, 'spawnSync').mockImplementation((_cmd, args) => {
      const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le')
      if (script.includes('Register-ScheduledTask')) changed.push(script)
      return { status: 1, stdout: '', stderr: 'scheduler unavailable', pid: 0, output: [], signal: null }
    })
    try {
      process.env.IT_HOME = folder
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect(() => install()).toThrow(/scheduler unavailable/)
      expect(changed).toEqual([])
      expect(existsSync(path.join(folder, 'bin', 'it-service.cmd'))).toBe(false)
    } finally {
      run.mockRestore()
      Object.defineProperty(process, 'platform', before.platform)
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

test('a backend cannot start while uninstall removes its folder, even after the inner lock has gone', async () => {
  const user = mkdtempSync(path.join(os.tmpdir(), 'it-removing-'))
  const folder = path.join(user, 'it')
  const before = process.env.IT_HOME
  const config = { port: 29000, network: false, instanceSecret: 'ab'.repeat(32), adminKey: 'test', sessionSecret: 'test' }
  try {
    mkdirSync(folder)
    process.env.IT_HOME = folder
    writeFileSync(path.join(folder, 'service.json'), JSON.stringify(config))
    await nothingLeft(
      () => {},
      async () => {
        await expect(startBackend(config, () => {})).rejects.toMatchObject({ code: 'already_running' })
        // The settings go before deletion can reach the inner lock, while the database is still there.
        rmSync(path.join(folder, 'service.json'))
        rmSync(path.join(folder, 'backend', 'lock'))
        await expect(startBackend(config, () => {})).rejects.toMatchObject({ code: 'settings' })
        rmSync(folder, { recursive: true })
      },
    )
    expect(existsSync(folder)).toBe(false)
  } finally {
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
    rmSync(user, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('whether a service is running for a folder', () => {
  test('is told by the very process its lock names, and a number that has come to be another process’s is not waited for', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-running-'))
    const before = process.env.IT_HOME
    try {
      process.env.IT_HOME = folder
      // A lock as It writes one, which says of this very process when it was started and where
      let mine = { pid: 0, started: '', where: '', holder: '' }
      await alone('connector', async () => {
        mine = JSON.parse(readFileSync(path.join(folder, 'connector.lock'), 'utf8'))
      })
      expect([mine.pid, typeof mine.started, typeof mine.where]).toEqual([process.pid, 'string', 'string'])
      mkdirSync(path.join(folder, 'backend'))
      const [backend, connector, note] = [path.join(folder, 'backend', 'lock'), path.join(folder, 'connector.lock'), path.join(folder, 'connector.json')]
      // A process that was started at another time under the same number, as one is after the service has died and its number was given out again
      const another = { ...mine, started: `${mine.started} and later` }
      for (const [lock, held] of [
        [mine, true],
        [another, false],
      ] as const) {
        // The service of a machine that runs It, by the backend's lock
        writeFileSync(backend, JSON.stringify(lock))
        expect(runningFor(folder)).toBe(held)
        rmSync(backend)
        // And of one that only joined an It, by the connector's note, whose lock says which process the note's number was
        writeFileSync(note, JSON.stringify({ pid: lock.pid, token: 'x', version: 'x', startedAt: 0 }))
        writeFileSync(connector, JSON.stringify(lock))
        expect(runningFor(folder)).toBe(held)
        rmSync(note)
        rmSync(connector)
      }
      // What is left of a service that is gone is not asked to stop, and nothing is waited for
      writeFileSync(backend, JSON.stringify(another))
      writeFileSync(note, JSON.stringify({ pid: another.pid, token: 'x', version: 'x', startedAt: 0 }))
      writeFileSync(connector, JSON.stringify(another))
      askToStop(folder, 50)
      expect(existsSync(stopFile(folder))).toBe(false)
      // A note with no lock beside it to say which process it meant is gone by as it always was: by its number alone
      rmSync(connector)
      expect(runningFor(folder)).toBe(true)
    } finally {
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
