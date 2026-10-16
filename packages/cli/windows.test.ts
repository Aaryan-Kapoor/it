import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { psQuote, WINDOWS_CLEANUP, windowsDeletionCommand } from './src/lib'
import { windowsLauncher, windowsRecovery, windowsRegisteredFolders, windowsRegisteredFor, windowsRemoval, windowsScript, windowsTask } from './src/service'

const powershell = (script: string) =>
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  )

test('deferred deletion carries a queue entry and refuses names that cannot fit RunOnce', () => {
  const line = windowsDeletionCommand('ItRemoved12345-abcdefgh')!
  expect(line.length).toBeLessThanOrEqual(260)
  expect(line).toContain('-LiteralPath')
  expect(line).not.toContain('cmd.exe')
  expect(windowsDeletionCommand(`ItRemoved1${'x'.repeat(260)}`)).toBeUndefined()
  expect(windowsDeletionCommand("ItRemoved1'; throw 'injected")).toBeUndefined()
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
  test('deferred deletion reads percent signs, quotes, Unicode and long paths as literal registry data', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-remove-'))
    const entry = `ItRemoved${process.pid}-${Date.now().toString(36)}`
    const line = windowsDeletionCommand(entry)!
    const nested = path.join(folder, 'x'.repeat(80))
    mkdirSync(nested)
    const file = path.join(nested, "%USERNAME% O'Neil 漢字 [literal].exe")
    const other = path.join(nested, `${process.env.USERNAME} O'Neil 漢字 [literal].exe`)
    writeFileSync(file, 'remove this')
    writeFileSync(other, 'keep this')
    try {
      expect(spawnSync('reg.exe', ['add', WINDOWS_CLEANUP, '/v', entry, '/t', 'REG_SZ', '/d', file, '/f']).status).toBe(0)
      // RunOnce starts the process directly. A shell here would add parsing Windows does not do.
      const ran = powershell(
        `$p = [Diagnostics.Process]::Start('powershell.exe', ${psQuote(line.slice('powershell.exe '.length))}); $p.WaitForExit(); exit $p.ExitCode`,
      )
      expect(ran.status, ran.stderr).toBe(0)
      expect(existsSync(file)).toBe(false)
      expect(readFileSync(other, 'utf8')).toBe('keep this')
      expect(spawnSync('reg.exe', ['query', WINDOWS_CLEANUP, '/v', entry]).status).not.toBe(0)
    } finally {
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
    const record = (changes = {}) => writeFileSync(note, JSON.stringify({ file: path.basename(previous), sha256: digest, pid: 2147483646, ...changes }))
    try {
      writeFileSync(previous, bytes)
      record({ pid: process.pid })
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

  test('a writer killed after moving the previous program leaves a recoverable file', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-interrupted-'))
    const program = path.join(folder, 'it.exe')
    const old = path.join(folder, 'it.old.456.exe')
    const reached = path.join(folder, 'moved')
    writeFileSync(program, 'the checked earlier executable')
    const move = `
$ErrorActionPreference = 'Stop'
$p = ${psQuote(program)}
$r = @{ file = 'it.old.456.exe'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower(); pid = $PID }
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
