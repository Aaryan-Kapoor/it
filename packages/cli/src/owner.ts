// What keeps a file or a folder to the person who runs It, on Windows. Elsewhere a file is made
// for its owner alone by its mode, and nothing here does anything.
//
// Windows takes no mode from a program. A file is given the permissions of the folder it is made
// in, and a folder is open to whomever a program has added to it since: Codex's sandbox, for one,
// runs commands as accounts of its own, adds those accounts to each folder of the person's
// profile, the one It keeps its records in among them, and adds them again each time one of its
// commands runs. Whatever is in the folder and takes its permissions from it is open to them with
// it. So each of It's files and folders is given permissions of its own, which name the person
// and the system alone, and is closed to what is added to the folder above it.
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'

/** One of the system's own programs, by where the system keeps it: one of the same name on PATH (Git's `whoami`, say) is not it. */
const system = (...parts: string[]) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)
/** The system itself, and the computer's administrators, who can make themselves any file's owner in any case. */
const SYSTEM = 'S-1-5-18'
const ADMINISTRATORS = 'S-1-5-32-544'

let me: string | null | undefined
/** The id of the account this program runs as, once for each run of it. Null where it could not be asked. */
export function ownSid(): string | null {
  if (me !== undefined) return me
  try {
    const said = execFileSync(system('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    me = /"(S-1-[0-9-]+)"\s*$/.exec(said.trim())?.[1] ?? null
  } catch {
    me = null
  }
  return me
}

/**
 * What `icacls` is told so that something this program has just made is kept to `sid`: what it
 * took from the folder it is in is taken away, and the person, the system and the computer's
 * administrators are given it whole, a folder with all that will be in it. Something just made
 * has nothing of its own that names anyone else.
 */
export const ownerOnly = (target: string, sid: string, folder: boolean): string[] => [
  target,
  '/inheritance:r',
  '/grant:r',
  ...[sid, SYSTEM, ADMINISTRATORS].map((who) => `*${who}:${folder ? '(OI)(CI)' : ''}F`),
  '/q',
]

/**
 * Keeps a file or a folder this program has just made to the person, before anything is written
 * into it. False where that could not be done: on a disk that keeps no permissions, and in a
 * sandbox that lets no other program be started, where what is written is as private as the
 * folder it is in, as it always was.
 */
export function keepToOwner(target: string, folder = false): boolean {
  if (process.platform !== 'win32') return true
  const sid = ownSid()
  if (!sid) return false
  try {
    execFileSync(system('icacls.exe'), ownerOnly(target, sid, folder), { windowsHide: true, timeout: 15_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/** The same, for a writer that must not hold everything else up while it is done. */
export function keepToOwnerAsync(target: string, folder = false): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true)
  const sid = ownSid()
  if (!sid) return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile(system('icacls.exe'), ownerOnly(target, sid, folder), { windowsHide: true, timeout: 15_000 }, (err) => resolve(!err)),
  )
}

/**
 * The script that keeps It's folder and each of the entries in it that are It's to the person,
 * where they are not already: each that names anyone else, takes its permissions from the folder
 * above it, or does not give the person everything is given permissions that name the person,
 * the system and the administrators alone, and a folder hands them on to all that is in it. A
 * link is passed over, since what it leads to is not It's. It prints a line for each it changed,
 * `opened` where anyone else was given it and `kept` where only the rest was missing, and
 * `failed` for each it could not change. The names come in as base64, so nothing of them is
 * read as PowerShell.
 */
export function keepingScript(folder: string, names: readonly string[]): string {
  // The folder itself last: kept first, it would take back what its entries had from it before
  // they were looked at, and an entry that had been open would not be said to have been
  const order = [...names.filter((name) => name !== '.'), ...names.filter((name) => name === '.')]
  const asked = Buffer.from(JSON.stringify({ folder, names: order })).toString('base64')
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$asked = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${asked}')) | ConvertFrom-Json
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ours = @($me, '${SYSTEM}', '${ADMINISTRATORS}')
$full = [Security.AccessControl.FileSystemRights]::FullControl
foreach ($name in @($asked.names)) {
  $at = if ($name -eq '.') { $asked.folder } else { Join-Path -Path $asked.folder -ChildPath $name }
  $item = Get-Item -LiteralPath $at -Force -ErrorAction SilentlyContinue
  if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
  try {
    $acl = $item.GetAccessControl('Access')
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
    $others = @($rules | Where-Object { $ours -notcontains $_.IdentityReference.Value })
    $mine = @($rules | Where-Object { $_.IdentityReference.Value -eq $me -and ($_.FileSystemRights -band $full) -eq $full })
    if ($acl.AreAccessRulesProtected -and $others.Count -eq 0 -and $mine.Count -gt 0) { continue }
    $on = if ($item.PSIsContainer) { 'OICI' } else { '' }
    $kept = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $kept.SetSecurityDescriptorSddlForm("D:PAI(A;$on;FA;;;SY)(A;$on;FA;;;BA)(A;$on;FA;;;$me)", 'Access')
    $item.SetAccessControl($kept)
    if ($others.Count) { "opened $name" } else { "kept $name" }
  } catch { "failed $name" }
}
# An entry that is not there is passed over, and leaves PowerShell to say it failed unless told otherwise
exit 0`
}

/** What keeping a folder to the person changed: the entries anyone else had been given, the ones that only lacked the rest, and the ones that could not be changed. `.` is the folder itself. */
export interface Kept {
  opened: string[]
  kept: string[]
  failed: string[]
}
/** What the script said, line by line. A line it would not print is no part of it. */
export function keptFrom(said: string): Kept {
  const found: Kept = { opened: [], kept: [], failed: [] }
  for (const line of said.split(/\r?\n/)) {
    const words = /^(opened|kept|failed) (.+)$/.exec(line.trim())
    if (words) found[words[1] as keyof Kept].push(words[2]!)
  }
  return found
}

/**
 * Keeps a folder, and those of its entries that are named, to the person, on Windows. Null
 * elsewhere, and where Windows PowerShell could not be run or did not finish.
 */
export function keepFolderToOwner(folder: string, names: readonly string[]): Promise<Kept | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = keepingScript(folder, names)
  return new Promise((resolve) =>
    execFile(
      system('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 120_000, encoding: 'utf8' },
      (err, out) => resolve(err ? null : keptFrom(out)),
    ),
  )
}
