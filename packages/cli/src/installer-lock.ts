import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Problem, psQuote } from './lib'
import { startOf } from './serve/backend'

const busy = () => new Problem('An installer may still be changing this installation. Nothing was removed. Try again after it has finished.', 'busy')

/** Uses the install scripts' existing lock, before uninstall changes services or files. */
export async function withInstallerLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const lock = path.join(folder, '.installing')
  if (process.platform === 'win32') return withWindowsInstallerLock(lock, run)
  const owner = path.join(lock, 'owner')
  const readOwner = () => {
    if (!lstatSync(lock, { throwIfNoEntry: false })?.isDirectory()) return undefined
    const stat = lstatSync(owner, { throwIfNoEntry: false })
    return stat?.isFile() && stat.size <= 4096 ? readFileSync(owner, 'utf8') : undefined
  }
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch {
    // The installer uses this second directory to give just one process the right to
    // recover a dead owner. An unknown record or another recovery stays untouched.
    const taking = `${lock}.taking`
    try {
      mkdirSync(taking, { mode: 0o700 })
    } catch {
      throw busy()
    }
    try {
      const record = readOwner()
      const held = record && /^([1-9]\d*) ([^\r\n]+)\n$/.exec(record)
      if (
        !held ||
        held[2] !== os.hostname() ||
        !Number.isSafeInteger(Number(held[1])) ||
        startOf(Number(held[1])) !== null ||
        readdirSync(lock).some((name) => name !== 'owner') ||
        readOwner() !== record
      )
        throw busy()
      unlinkSync(owner)
      rmdirSync(lock)
      mkdirSync(lock, { mode: 0o700 })
    } catch {
      throw busy()
    } finally {
      rmdirSync(taking)
    }
  }
  const me = `${process.pid} ${os.hostname()}\n`
  try {
    writeFileSync(owner, me, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    try {
      rmdirSync(lock)
    } catch {}
    throw err
  }
  try {
    return await run()
  } finally {
    if (readOwner() === me) {
      unlinkSync(owner)
      rmdirSync(lock)
    }
  }
}

/** Windows' installer holds an exclusive, delete-on-close file. Keep that same handle open until the callback ends. */
async function withWindowsInstallerLock<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const script = `
$ErrorActionPreference = 'Stop'
$at = ${psQuote(lock)}
function Open-Lock { [IO.FileStream]::new($at, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose) }
try {
  try { $lock = Open-Lock } catch {
    $old = Get-Item -LiteralPath $at -Force
    if ($old.PSIsContainer -or ($old.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $old.Length -ne 0) { exit 1 }
    [IO.File]::Delete($at)
    $lock = Open-Lock
  }
  try {
    [Console]::Out.WriteLine('locked')
    [Console]::Out.Flush()
    [Console]::In.ReadLine() | Out-Null
  } finally { $lock.Dispose() }
} catch { exit 1 }
`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  let ready!: () => void
  let failed!: (err: Error) => void
  const acquired = new Promise<void>((resolve, reject) => {
    ready = resolve
    failed = reject
  })
  let output = ''
  child.stdout.on('data', (bytes) => {
    output = (output + String(bytes)).slice(-128)
    if (output.trim() === 'locked') ready()
  })
  child.on('error', () => failed(busy()))
  child.stdin.on('error', () => failed(busy()))
  const ended = new Promise<void>((resolve) => {
    child.once('close', () => {
      failed(busy())
      resolve()
    })
  })
  const timer = setTimeout(() => {
    failed(busy())
    child.kill()
  }, 30_000)
  try {
    await acquired
    clearTimeout(timer)
    return await run()
  } finally {
    clearTimeout(timer)
    child.stdin.end('\n')
    await ended
  }
}
