import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { psQuote, RUN_ONCE, WINDOWS_CLEANUP, WINDOWS_PATH_MOST, windowsDeletionCommand } from './src/lib'
import { startOf } from './src/serve/backend'
import {
  PS_QUIET,
  windowsLauncher,
  windowsRecovery,
  windowsRegisteredFolders,
  windowsRegisteredFor,
  windowsRemoval,
  windowsScript,
  windowsTask,
} from './src/service'
import { deleteAtSignIn } from './src/uninstall-files'

const powershell = (script: string) =>
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${PS_QUIET}\n$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  )

test('deferred deletion carries a queue entry and refuses names that cannot fit RunOnce', () => {
  const file = 'C:\\Users\\%USERNAME%\\it.exe'
  const line = windowsDeletionCommand('ItRemoved12345-abcdefgh', file)!
  expect(line.length).toBeLessThanOrEqual(260)
  expect(line).toContain('-LiteralPath')
  expect(line).not.toContain('cmd.exe')
  // Nothing in the line is a name Windows could put something else in place of
  expect(line).not.toContain('%')
  expect(windowsDeletionCommand(`ItRemoved1${'x'.repeat(260)}`, file)).toBeUndefined()
  expect(windowsDeletionCommand("ItRemoved1'; throw 'injected", file)).toBeUndefined()
})

test('deferred deletion refuses a path longer than Windows PowerShell can be counted on to delete, counted as Windows counts it', () => {
  const longest = `C:\\${'x'.repeat(WINDOWS_PATH_MOST - 3)}`
  expect(longest.length).toBe(259)
  expect(windowsDeletionCommand('ItRemoved1-a', longest)).toBeDefined()
  expect(windowsDeletionCommand('ItRemoved1-a', `${longest}x`)).toBeUndefined()
  // A letter outside the Basic Multilingual Plane is two UTF-16 code units, and Windows counts both
  const wide = `C:\\${'𝒳'.repeat((WINDOWS_PATH_MOST - 3) / 2)}`
  expect(windowsDeletionCommand('ItRemoved1-a', wide)).toBeDefined()
  expect(windowsDeletionCommand('ItRemoved1-a', `${wide}x`)).toBeUndefined()
})

test('the launcher repairs a missing standalone program before attempting to start it', () => {
  const launcher = windowsLauncher(['C:\\it\\bin\\it.exe', 'serve'], {})
  expect(launcher.indexOf('if not exist')).toBeLessThan(launcher.indexOf('it.exe" serve'))
  expect(windowsLauncher(['C:\\node.exe', 'it.mjs', 'serve'], {})).not.toContain('EncodedCommand')
})

test('task discovery reads every folder, deduplicates Windows spellings and refuses partial answers', () => {
  const encoded = (folder: string) => Buffer.from(folder).toString('base64')
  const ask = () => ({ ok: true, out: ['C:\\account\\bin', 'C:\\legacy 漢字\\bin', 'c:/ACCOUNT/bin/'].map(encoded).join('\r\n') })
  expect(windowsRegisteredFolders(ask)).toEqual(['C:\\account', 'C:\\legacy 漢字'])
  expect(windowsRegisteredFolders(() => ({ ok: true, out: '' }))).toEqual([])
  expect(() => windowsRegisteredFolders(() => ({ ok: true, out: `${ask().out}\r\nWARNING: incomplete answer` }))).toThrow(/could not be read/)
  expect(() => windowsRegisteredFolders(() => ({ ok: false, out: 'scheduler unavailable' }))).toThrow(/scheduler unavailable/)
  const before = process.env.IT_HOME
  try {
    const folder = path.join(os.tmpdir(), 'it-legacy-registration')
    process.env.IT_HOME = folder
    expect(windowsRegisteredFor(() => ({ ok: true, out: `${encoded('C:\\account\\bin')}\r\n${encoded(path.join(folder, 'bin'))}` }))).toBe(folder)
  } finally {
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
  }
})

describe.skipIf(process.platform !== 'win32')('Windows scripts run by Windows PowerShell', () => {
  /** Runs a line as Windows starts what it was left to run: the whole line, as it is, is the new program's command line. */
  const asLeft = (line: string) =>
    spawnSync('powershell.exe', [], { argv0: line, windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  /** A registry value as it is kept, with its kind, and with nothing in it expanded. */
  const kept = (key: string, name: string) => {
    const at = psQuote(key.replace(/^HKCU\\/, 'HKCU:\\'))
    const ran = powershell(
      `$k = Get-Item -LiteralPath ${at}; $k.GetValueKind(${psQuote(name)}).ToString(); [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$k.GetValue(${psQuote(name)}, $null, 'DoNotExpandEnvironmentNames')))`,
    )
    const [kind, value] = ran.stdout.trim().split(/\r?\n/)
    return { kind, value: value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf16le') }
  }
  /** Puts a path in the queue as uninstall does, and gives back the line RunOnce would have been given, which it is not given. */
  const queued = (file: string, entry: string) => {
    let line: string | undefined
    const asked = deleteAtSignIn(file, entry, (args) => {
      if (args[1] !== RUN_ONCE) return spawnSync('reg.exe', args, { windowsHide: true, timeout: 15_000 }).status === 0
      line = args[7]
      return true
    })
    return asked ? line : undefined
  }
  const everything = (folder: string) => readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort()

  test('deferred deletion reads percent signs, carets, ampersands, parentheses, quotes and Unicode as literal registry data', () => {
    const folder = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'it-remove-')))
    const entry = `ItRemoved${process.pid}-${Date.now().toString(36)}`
    // A backslash before a 0 is how reg.exe writes the null between the strings of a list
    const nested = path.join(folder, '0 %PATH% ^ & (x86)')
    mkdirSync(nested)
    const file = path.join(nested, "%USERNAME% O'Neil ^& (copy) 漢字 [literal].exe")
    // What a shell would have deleted in its place: the name with what %USERNAME% stands for, the name without its caret, and a program beside the folder
    const others = [
      path.join(nested, `${process.env.USERNAME} O'Neil ^& (copy) 漢字 [literal].exe`),
      path.join(nested, "%USERNAME% O'Neil & (copy) 漢字 [literal].exe"),
      path.join(folder, 'it.exe'),
    ]
    for (const at of [file, ...others]) writeFileSync(at, 'a program')
    const before = everything(folder)
    try {
      const line = queued(file, entry)!
      expect(line).toBeDefined()
      expect(kept(WINDOWS_CLEANUP, entry)).toEqual({ kind: 'String', value: file })
      const ran = asLeft(line)
      expect(ran.status, ran.stderr).toBe(0)
      expect(everything(folder)).toEqual(before.filter((name) => path.join(folder, name) !== file))
      expect(spawnSync('reg.exe', ['query', WINDOWS_CLEANUP, '/v', entry]).status).not.toBe(0)
    } finally {
      spawnSync('reg.exe', ['delete', WINDOWS_CLEANUP, '/v', entry, '/f'])
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('deferred deletion deletes a path as long as It allows, and a path one longer only where long paths are on', () => {
    const folder = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'it-longest-')))
    const entry = `ItRemoved${process.pid}-${Date.now().toString(36)}`
    const name = `it-removed-${process.pid}-${Date.now().toString(36)}.exe`
    // Each in a folder whose name makes the whole path as long as It allows, or one longer
    const [longest, longer] = [0, 1].map((more) => path.join(folder, 'x'.repeat(WINDOWS_PATH_MOST - folder.length - name.length - 2 + more), name))
    for (const at of [longest!, longer!]) {
      mkdirSync(path.dirname(at))
      writeFileSync(at, 'a program')
    }
    try {
      expect(longest!.length).toBe(WINDOWS_PATH_MOST)
      expect(queued(longer!, entry)).toBeUndefined()
      expect(spawnSync('reg.exe', ['query', WINDOWS_CLEANUP, '/v', entry]).status).not.toBe(0)
      const line = queued(longest!, entry)!
      const ran = asLeft(line)
      expect(ran.status, ran.stderr).toBe(0)
      expect(existsSync(longest!)).toBe(false)
      // The same line, with the longer path put in the queue by hand. What decides it is the
      // LongPathsEnabled policy, which GitHub's runners turn on and which is off unless someone
      // turned it on: Windows PowerShell deletes the longer path where it is on, and not where it is off
      expect(spawnSync('reg.exe', ['add', WINDOWS_CLEANUP, '/v', entry, '/t', 'REG_SZ', '/d', longer!, '/f']).status).toBe(0)
      const over = asLeft(line)
      const policy = spawnSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], {
        encoding: 'utf8',
      }).stdout
      const longPaths = /LongPathsEnabled\s+REG_DWORD\s+0x1\s/.test(policy)
      expect(over.status === 0, over.stderr).toBe(longPaths)
      expect(existsSync(longer!)).toBe(!longPaths)
    } finally {
      spawnSync('reg.exe', ['delete', WINDOWS_CLEANUP, '/v', entry, '/f'])
      rmSync(folder, { recursive: true, force: true })
    }
  })

  // Only on a runner, which is made for one run and never signed in to again: on a person's own
  // machine a value the test could not take out would run the next time they signed in
  test.skipIf(!process.env.CI)('a RunOnce value left as uninstall leaves it, read back and run as it was kept, deletes its file and nothing else', () => {
    const folder = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'it-runonce-')))
    // A name uninstall never makes, so that nothing but this test takes it out
    const entry = `ItRemoved${process.pid}-test-${Date.now().toString(36)}`
    const file = path.join(folder, '%USERNAME% %PATH% ^& (it) 漢字.exe')
    const other = path.join(folder, `${process.env.USERNAME} %PATH% ^& (it) 漢字.exe`)
    for (const at of [file, other]) writeFileSync(at, 'a program')
    try {
      expect(deleteAtSignIn(file, entry)).toBe(true)
      const left = kept(RUN_ONCE, entry)
      expect(left).toEqual({ kind: 'String', value: windowsDeletionCommand(entry, file) })
      expect(kept(WINDOWS_CLEANUP, entry)).toEqual({ kind: 'String', value: file })
      // Windows takes a RunOnce value out before it runs what the value says
      expect(spawnSync('reg.exe', ['delete', RUN_ONCE, '/v', entry, '/f']).status).toBe(0)
      const ran = asLeft(left.value!)
      expect(ran.status, ran.stderr).toBe(0)
      expect(existsSync(file)).toBe(false)
      expect(readFileSync(other, 'utf8')).toBe('a program')
      expect(spawnSync('reg.exe', ['query', WINDOWS_CLEANUP, '/v', entry]).status).not.toBe(0)
    } finally {
      spawnSync('reg.exe', ['delete', RUN_ONCE, '/v', entry, '/f'])
      spawnSync('reg.exe', ['delete', WINDOWS_CLEANUP, '/v', entry, '/f'])
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('recovery restores only the recorded file after its writer has died', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-recover-'))
    const program = path.join(folder, 'it.exe')
    const previous = path.join(folder, 'it.old.123.exe')
    const note = `${program}.recovery.json`
    const bytes = 'the previous checked program'
    const digest = createHash('sha256').update(bytes).digest('hex')
    const record = (changes = {}) =>
      writeFileSync(note, JSON.stringify({ file: path.basename(previous), sha256: digest, pid: 2147483646, started: '1', ...changes }))
    try {
      writeFileSync(previous, bytes)
      record({ pid: process.pid, started: startOf(process.pid) })
      expect(powershell(windowsRecovery(program)).status).not.toBe(0)
      expect(existsSync(program)).toBe(false)
      record({ sha256: '0'.repeat(64) })
      expect(powershell(windowsRecovery(program)).status).not.toBe(0)
      record({ file: '..\\unrelated.exe' })
      expect(powershell(windowsRecovery(program)).status).not.toBe(0)
      record()
      const recovered = powershell(windowsRecovery(program))
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(program, 'utf8')).toBe(bytes)
      expect(existsSync(previous)).toBe(false)
      expect(existsSync(note)).toBe(false)
      // A completed placement is never overwritten by an older recovery record.
      renameSync(program, previous)
      writeFileSync(program, 'the completed new program')
      record()
      expect(powershell(windowsRecovery(program)).status).toBe(0)
      expect(readFileSync(program, 'utf8')).toBe('the completed new program')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('recovery ignores a live process whose PID was reused after the writer stopped', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-reused-pid-'))
    const program = path.join(folder, 'it.exe')
    const previous = path.join(folder, 'it.old.123.exe')
    const note = `${program}.recovery.json`
    const bytes = 'the previous checked program'
    const started = startOf(process.pid)
    expect(started).toMatch(/^[0-9]+$/)
    try {
      writeFileSync(previous, bytes)
      const record = { file: path.basename(previous), sha256: createHash('sha256').update(bytes).digest('hex'), pid: process.pid, started }
      writeFileSync(note, JSON.stringify(record))
      const waiting = powershell(windowsRecovery(program))
      expect(waiting.status).not.toBe(0)
      expect(waiting.stderr).toContain('An install or update is still running')
      expect(existsSync(program)).toBe(false)
      // The process is still alive, but the record names a previous holder of its PID.
      record.started = (BigInt(started!) - 1n).toString()
      writeFileSync(note, JSON.stringify(record))
      const recovered = powershell(windowsRecovery(program))
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(program, 'utf8')).toBe(bytes)
      expect(existsSync(previous)).toBe(false)
      expect(existsSync(note)).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('a writer killed after moving the previous program leaves a recoverable file', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-interrupted-'))
    const program = path.join(folder, 'it.exe')
    const old = path.join(folder, 'it.old.456.exe')
    const reached = path.join(folder, 'moved')
    writeFileSync(program, 'the checked earlier executable')
    const move = `
$ErrorActionPreference = 'Stop'
$p = ${psQuote(program)}
$r = @{ file = 'it.old.456.exe'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower(); pid = $PID; started = (Get-Process -Id $PID).StartTime.ToFileTimeUtc().ToString() }
[IO.File]::WriteAllText($p + '.recovery.json', (ConvertTo-Json $r -Compress))
[IO.File]::Move($p, ${psQuote(old)})
[IO.File]::WriteAllText(${psQuote(reached)}, 'moved')
Start-Sleep -Seconds 60
`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(move, 'utf16le').toString('base64')], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const ended = new Promise((resolve) => child.once('close', resolve))
    try {
      const until = Date.now() + 10_000
      while (!existsSync(reached) && child.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
      expect(existsSync(reached)).toBe(true)
      expect(existsSync(program)).toBe(false)
      expect(powershell(windowsRecovery(program)).status).not.toBe(0)
      child.kill()
      await ended
      const recovered = powershell(windowsRecovery(program))
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(program, 'utf8')).toBe('the checked earlier executable')
    } finally {
      if (child.exitCode === null) child.kill()
      await ended
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('task selection rejects foreign principals and launchers and discovers this account’s legacy installation', () => {
    const folder = 'C:\\it-test\\bin'
    const fixture = `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = [pscustomobject]@{ Execute = 'conhost.exe'; Arguments = '--headless cmd.exe /d /c .\\it-service.cmd'; WorkingDirectory = ${psQuote(folder)} }
$candidate = [pscustomobject]@{ TaskName = 'it'; Principal = [pscustomobject]@{ UserId = $sid }; Actions = @($action) }
function Get-ScheduledTask { param($TaskPath, $ErrorAction); $candidate }
`
    const selected = (change: string) => powershell(`${fixture}\n${change}\n${windowsTask()}\nif ($task) { $task.TaskName }`)
    expect(selected('').stdout.trim()).toBe('it')
    expect(selected("$candidate.Principal.UserId = 'S-1-5-18'").stdout.trim()).toBe('')
    expect(selected("$action.WorkingDirectory = 'C:\\another\\bin'").stdout.trim()).toBe('it')
    expect(selected("$action.Execute = 'unrelated.exe'").stdout.trim()).toBe('')
    expect(selected("$candidate.TaskName = 'it-' + $sid; $action.Execute = 'unrelated.exe'").status).not.toBe(0)
    expect(selected("$candidate.TaskName = 'it-' + $sid").stdout.trim()).toMatch(/^it-S-1-/)
  })

  test.each(['legacy only', 'both', 'same folder', 'foreign legacy', 'another scheduler folder'])(
    'native discovery lists every owned installation (%s)',
    (state) => {
      const fixture = `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function New-ItTestTask($name, $folder, $owner, $taskPath) {
  [pscustomobject]@{ TaskName = $name; TaskPath = $taskPath; Principal = [pscustomobject]@{ UserId = $owner }; Actions = @([pscustomobject]@{ Execute = 'conhost.exe'; Arguments = '--headless cmd.exe /d /c .\\it-service.cmd'; WorkingDirectory = $folder }) }
}
$fixtures = @(
  ${state === 'legacy only' ? '' : "(New-ItTestTask ('it-' + $sid) 'C:\\account\\bin' $sid '\\')"}
  (New-ItTestTask 'it' '${state === 'same folder' ? 'c:\\ACCOUNT\\bin' : 'C:\\legacy 漢字\\bin'}' ${state === 'foreign legacy' ? "'S-1-5-18'" : '$sid'} '${state === 'another scheduler folder' ? '\\Other\\' : '\\'}')
)
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskPath)
  $fixtures | Where-Object { $_.TaskPath -eq $TaskPath }
}
`
      const folders = windowsRegisteredFolders((script) => {
        const ran = powershell(`${fixture}\n${script}`)
        return { ok: ran.status === 0, out: `${ran.stdout}${ran.stderr}`.trim() }
      })
      expect(folders).toEqual(state === 'legacy only' ? ['C:\\legacy 漢字'] : state === 'both' ? ['C:\\account', 'C:\\legacy 漢字'] : ['C:\\account'])
    },
  )

  test.skipIf(!process.env.CI)('the scheduler migrates and removes only isolated test registrations', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-task-'))
    const bin = path.join(folder, 'bin')
    const nextBin = path.join(folder, 'next', 'bin')
    for (const at of [bin, nextBin]) {
      mkdirSync(at, { recursive: true })
      writeFileSync(path.join(at, 'it-service.cmd'), '@echo off\r\nexit /b 0\r\n')
    }
    const prefix = `it-test-${process.pid}-${Date.now().toString(36)}`
    const scoped = (script: string) => script.replaceAll("'it-'", psQuote(`${prefix}-`)).replaceAll("'it'", psQuote(prefix))
    try {
      const legacy = scoped(windowsScript(bin, 'it-service.cmd')).replace(`$name = '${prefix}-' + $sid`, `$name = '${prefix}'`)
      const madeLegacy = powershell(legacy)
      expect(madeLegacy.status, madeLegacy.stderr).toBe(0)
      const installed = powershell(scoped(windowsScript(nextBin, 'it-service.cmd')))
      expect(installed.status, installed.stderr).toBe(0)
      const selected = powershell(`${scoped(windowsTask())}\nif ($legacy) { throw 'legacy task remains' }; $task.TaskName`)
      expect(selected.stdout.trim()).toMatch(new RegExp(`^${prefix}-S-1-`))
      // An older installation can recreate its legacy task after migration. Both owned
      // registrations must be discovered, and only the matching folder may remove one.
      const recreated = powershell(legacy)
      expect(recreated.status, recreated.stderr).toBe(0)
      const registered = windowsRegisteredFolders((script) => {
        const ran = powershell(scoped(script))
        return { ok: ran.status === 0, out: `${ran.stdout}${ran.stderr}`.trim() }
      })
      expect(registered).toEqual([path.dirname(nextBin), path.dirname(bin)])
      const left = powershell(scoped(windowsRemoval(bin)))
      expect(left.status, left.stderr).toBe(0)
      expect(powershell(`${scoped(windowsTask())}\n$task.Actions[0].WorkingDirectory`).stdout.trim()).toBe(nextBin)
      const removed = powershell(scoped(windowsRemoval(nextBin)))
      expect(removed.status, removed.stderr).toBe(0)
      expect(powershell(`${scoped(windowsTask())}\nif ($task) { throw 'still registered' }`).status).toBe(0)
    } finally {
      powershell(`Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -like '${prefix}*' } | Unregister-ScheduledTask -Confirm:$false`)
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
