import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CODEX_SHUT_SAID } from './src/codex-settings'
import { INSTALLATION, INSTALLATION_FILE } from './src/installation'
import { keptFromHome, keptOut, notSetUp, psQuote, writePrivate, writePrivateAsync } from './src/lib'
import { keepFolderToOwner, keepingScript, keptFrom, ownerOnly, ownSid } from './src/owner'
import { itsEntries, keptSaid } from './src/serve/kept'

const windows = process.platform === 'win32'
const EVERYONE = 'S-1-1-0'

/** Who a file or a folder names, by the ids of the accounts it lets in, and whether it takes nothing from the folder above it. */
function permissionsOf(target: string): { protected: boolean; who: string[] } {
  const script = `$a = (Get-Item -LiteralPath ${psQuote(target)} -Force).GetAccessControl('Access')
$who = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value })
ConvertTo-Json -Compress @{ protected = $a.AreAccessRulesProtected; who = @($who | Sort-Object -Unique) }`
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (ran.status !== 0) throw new Error(ran.stderr)
  return JSON.parse(ran.stdout)
}
const icacls = (...args: string[]) => {
  const ran = spawnSync('icacls.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (ran.status !== 0) throw new Error(ran.stdout + ran.stderr)
}
/** Opens a folder, and everything in it that takes its permissions from it, to everyone, as another program might. */
const openToEveryone = (folder: string) => icacls(folder, '/grant', `*${EVERYONE}:(OI)(CI)(RX)`)
const keptToMe = () => [ownSid()!, 'S-1-5-18', 'S-1-5-32-544'].sort()

describe('what keeps a file to its owner on Windows', () => {
  test('icacls is told to take away what came from the folder and to give the person, the system and the administrators the whole of it', () => {
    expect(ownerOnly('C:\\it\\machine.json', 'S-1-5-21-1-2-3-1001', false)).toEqual([
      'C:\\it\\machine.json',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '*S-1-5-18:F',
      '*S-1-5-32-544:F',
      '/q',
    ])
    // A folder hands the same on to all that is made in it
    expect(ownerOnly('C:\\it\\addons', 'S-1-5-21-1-2-3-1001', true).slice(3, 6)).toEqual([
      '*S-1-5-21-1-2-3-1001:(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ])
  })

  test('the names a folder is kept by reach PowerShell as base64, nothing of them is read as PowerShell, and the folder itself comes last', () => {
    const folder = "C:\\Users\\o'brien\\.it"
    const script = keepingScript(folder, ['.', "x'; Remove-Item C:\\ -Recurse; '", 'logs'])
    expect(script).not.toContain('Remove-Item')
    expect(script).not.toContain("o'brien")
    const asked = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)![1]!
    // Kept first, the folder would take back what its entries had from it before they were looked at
    expect(JSON.parse(Buffer.from(asked, 'base64').toString('utf8'))).toEqual({ folder, names: ["x'; Remove-Item C:\\ -Recurse; '", 'logs', '.'] })
  })

  test('what the script prints is read line by line, and a line it would not print is no part of it', () => {
    expect(keptFrom('opened .\r\nopened machine.json\nkept logs\nfailed backend\nsomething else\n opened  \n')).toEqual({
      opened: ['.', 'machine.json'],
      kept: ['logs'],
      failed: ['backend'],
    })
  })

  test('only the entries that are It’s are kept, and the folder itself only where it is It’s alone', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-owner-'))
    try {
      // The usual folder is It's
      expect(itsEntries(folder, undefined)).toContain('.')
      // A folder that IT_HOME names may also hold a person's own files, until It has marked it as its own
      const entries = itsEntries(folder, folder)
      expect(entries).not.toContain('.')
      expect(entries).toEqual(
        expect.arrayContaining(['machine.json', 'token.json', 'service.json', 'connector.json', 'bin', 'backend', 'logs', INSTALLATION_FILE]),
      )
      writeFileSync(path.join(folder, INSTALLATION_FILE), INSTALLATION)
      expect(itsEntries(folder, folder)).toContain('.')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('the service says what it changed by counts and by It’s own names, says the folder itself once, and says when a key had been open', () => {
    const said = new Set<string>()
    const key = keptSaid({ opened: ['.', 'machine.json', 'logs'], kept: [], failed: [] }, said)
    expect(key).toHaveLength(2)
    expect(key[0]).toContain('revoked')
    expect(key[0]).toContain('2 of It')
    // Codex's sandbox opens the folder itself again with every command it runs: that is said once
    expect(keptSaid({ opened: ['.'], kept: [], failed: [] }, said)).toEqual([])
    expect(keptSaid({ opened: ['journal.jsonl'], kept: ['bin'], failed: [] }, said)).toEqual([
      "It's folder was open to another account of this computer. 1 of It's files and folders are kept to you again.",
    ])
    expect(keptSaid({ opened: [], kept: [], failed: ['backend'] }, said)).toEqual(["1 of It's files and folders could not be kept to you."])
    expect(keptSaid({ opened: [], kept: [], failed: ['backend'] }, said)).toEqual([])
    expect(keptSaid({ opened: [], kept: ['logs'], failed: [] }, new Set())).toEqual([])
  })
})

describe('a command that may not read It’s folder', () => {
  let folder: string
  const before = process.env.IT_HOME
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-kept-out-'))
    process.env.IT_HOME = folder
  })
  afterEach(() => {
    if (windows) spawnSync('icacls.exe', [path.join(folder, 'machine.json'), '/remove:d', `*${ownSid()}`], { windowsHide: true })
    else chmodSync(path.join(folder, 'machine.json'), 0o600)
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
    rmSync(folder, { recursive: true, force: true })
  })

  test('is told it is kept out of It’s folder, and not that It is not set up', (context) => {
    writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'm', name: 'here', key: {} }))
    expect(keptFromHome()).toBe(false)
    expect(notSetUp().code).toBe('not_set_up')
    // As Codex's sandbox on Windows runs a command: as an account the record is closed to
    if (windows) icacls(path.join(folder, 'machine.json'), '/deny', `*${ownSid()}:(RD)`)
    else chmodSync(path.join(folder, 'machine.json'), 0)
    // An account that reads past what a file says, as root does and as an administrator with the
    // right to make backups does, cannot be shown what another account is refused
    try {
      readFileSync(path.join(folder, 'machine.json'))
      return context.skip()
    } catch {}
    expect(keptFromHome()).toBe(true)
    const said = notSetUp()
    expect(said.code).toBe('blocked')
    expect(said.message).toContain('may not read It’s folder')
    expect(said.hint).not.toContain('network')
    // An agent in Codex is told to ask to run it outside the sandbox, and given the rule to pass on
    expect(keptOut({ CODEX_THREAD_ID: 'thr' }).hint).toContain(CODEX_SHUT_SAID)
  })
})

describe.skipIf(!windows)('on Windows, It’s files and folders are kept to the person', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-owner-'))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  test('a record is kept to the person when it is written, and what is opened in its folder later does not reach it', async () => {
    openToEveryone(folder)
    writePrivate(path.join(folder, 'machine.json'), { id: 'm', key: { d: 'secret' } })
    await writePrivateAsync(path.join(folder, 'receipts', 'one.json'), ['{"a":1}'], () => true)
    expect(JSON.parse(readFileSync(path.join(folder, 'machine.json'), 'utf8'))).toEqual({ id: 'm', key: { d: 'secret' } })
    expect(readFileSync(path.join(folder, 'receipts', 'one.json'), 'utf8')).toBe('{"a":1}')
    for (const kept of ['machine.json', 'receipts', path.join('receipts', 'one.json')]) {
      const found = permissionsOf(path.join(folder, kept))
      expect(found.who).toEqual(keptToMe())
    }
    expect(permissionsOf(path.join(folder, 'machine.json')).protected).toBe(true)
    expect(permissionsOf(path.join(folder, 'receipts')).protected).toBe(true)
    // Written again, it is still kept to the person
    writePrivate(path.join(folder, 'machine.json'), { id: 'm', key: { d: 'other' } })
    expect(permissionsOf(path.join(folder, 'machine.json'))).toEqual({ protected: true, who: keptToMe() })
    // Another program opens the folder again, as Codex's sandbox does each time it runs a command
    openToEveryone(folder)
    expect(permissionsOf(folder).who).toContain(EVERYONE)
    expect(permissionsOf(path.join(folder, 'machine.json')).who).toEqual(keptToMe())
    expect(permissionsOf(path.join(folder, 'receipts', 'one.json')).who).toEqual(keptToMe())
  })

  test('the service keeps the folder and It’s entries to the person, and leaves alone what is not It’s and what is kept already', async () => {
    openToEveryone(folder)
    writeFileSync(path.join(folder, 'journal.jsonl'), '{}\n')
    mkdirSync(path.join(folder, 'logs'))
    writeFileSync(path.join(folder, 'logs', 'service.log'), 'started\n')
    writeFileSync(path.join(folder, 'notes.txt'), 'a person’s own\n')
    writePrivate(path.join(folder, 'token.json'), { token: 't' })
    expect(permissionsOf(path.join(folder, 'journal.jsonl')).who).toContain(EVERYONE)
    const found = await keepFolderToOwner(folder, ['.', 'journal.jsonl', 'logs', 'token.json', 'machine.json'])
    expect(found).not.toBeNull()
    expect(found!.opened.sort()).toEqual(['.', 'journal.jsonl', 'logs'])
    // Already kept, and not there at all, are nothing to change
    expect(found!.kept).toEqual([])
    expect(found!.failed).toEqual([])
    for (const kept of ['.', 'journal.jsonl', 'logs']) expect(permissionsOf(path.join(folder, kept))).toEqual({ protected: true, who: keptToMe() })
    expect(permissionsOf(path.join(folder, 'logs', 'service.log')).who).toEqual(keptToMe())
    // A file that is not It's had only what it took from the folder, and takes what the folder has now
    expect(permissionsOf(path.join(folder, 'notes.txt'))).toEqual({ protected: false, who: keptToMe() })
    // Asked again, nothing is changed
    expect(await keepFolderToOwner(folder, ['.', 'journal.jsonl', 'logs', 'token.json'])).toEqual({ opened: [], kept: [], failed: [] })
  })
})
