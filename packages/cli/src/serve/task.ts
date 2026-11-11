// On Windows the service is started by a scheduled task, through its launcher: the task starts
// `conhost.exe --headless`, which starts cmd.exe running `it-service.cmd`, which starts this
// program. Told to stop the task, as `Stop-ScheduledTask`, Task Scheduler's End and
// `schtasks /end` tell it, Task Scheduler ends the first of those and nothing else. The launcher
// and this program would go on running, unseen, with the task said to be ready, and a task
// started again would start a second launcher beside them that could never take over from the
// first. So the service watches the two processes above it, and once either has gone it stops
// as it does when it is asked to, and ends well, which ends its launcher too.
import { spawn } from 'node:child_process'

/** A process as Windows says it is: its number, its parent's, when it was started, its program and its command line. */
export interface Seen {
  pid: number
  parent: number
  started: bigint
  name: string
  line: string
}
/** The two processes the task started above this one, each by its number and when it was started. */
export interface Launcher {
  console: { pid: number; started: bigint }
  shell: { pid: number; started: bigint }
}
/**
 * What was found above this program: the task's launcher, or that it has gone (and why), or
 * that this program was not started by one (as `it serve --supervised` typed at a prompt is
 * not), or that Windows could not be asked.
 */
export type Found = { launcher: Launcher } | { ended: string } | { none: string } | { failed: string }

/**
 * The script that asks Windows for this program, its parent and its parent's parent, a line
 * each: number, parent's number, when it was started as a Windows file time, the program's
 * name, and its command line in base64, read as UTF-8. A process that is not there is a `-`.
 */
export function askScript(pid: number): string {
  return `$ErrorActionPreference = 'Stop'
function Get-ItProcess($id) { if ($id) { Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [uint32]$id) } }
$me = Get-ItProcess ${pid}
$shell = if ($me) { Get-ItProcess $me.ParentProcessId }
$console = if ($shell) { Get-ItProcess $shell.ParentProcessId }
foreach ($p in @($me, $shell, $console)) {
  if ($p) { [string]$p.ProcessId + ' ' + [string]$p.ParentProcessId + ' ' + $p.CreationDate.ToFileTimeUtc() + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.Name)) + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine)) } else { '-' }
}`
}

const word = (b64: string | undefined) => (b64 && /^[A-Za-z0-9+/]*={0,2}$/.test(b64) ? Buffer.from(b64, 'base64').toString('utf8') : undefined)
function seen(line: string | undefined): Seen | null | undefined {
  const said = line?.trim()
  if (said === '-') return null
  const [pid, parent, started, name, cmd] = said?.split(' ') ?? []
  if (!pid || !/^\d+$/.test(pid) || !parent || !/^\d+$/.test(parent) || !started || !/^\d+$/.test(started)) return undefined
  const named = word(name)
  const commandLine = word(cmd ?? '')
  if (named === undefined || commandLine === undefined) return undefined
  return { pid: Number(pid), parent: Number(parent), started: BigInt(started), name: named, line: commandLine }
}

/**
 * Reads what `askScript` printed, and says what it found. The launcher is the shell above this
 * program, cmd.exe running `it-service.cmd`, and the task's console above that, conhost.exe
 * started with `--headless`: the very shape the task's action has, which a prompt a person
 * opened never has, since there conhost is started by the shell and is not its parent. A
 * parent that is not there, or that was started after its child, has gone: Windows gives a
 * number that has come free to the next process, which is then no parent of this one.
 */
export function judge(out: string, pid: number): Found {
  const lines = out.trim().split(/\r?\n/)
  if (lines.length !== 3) return { failed: 'Windows gave an answer that could not be read' }
  const [me, shell, console] = lines.map(seen)
  if (me === undefined || shell === undefined || console === undefined) return { failed: 'Windows gave an answer that could not be read' }
  if (!me || me.pid !== pid) return { failed: 'Windows did not know this program' }
  if (!shell || shell.pid !== me.parent || shell.started > me.started) return { ended: 'the launcher that started it has gone' }
  if (shell.name.toLowerCase() !== 'cmd.exe' || !/(^|[\\\s])it-service\.cmd"?\s*$/i.test(shell.line))
    return { none: 'it was not started by the launcher of a scheduled task' }
  if (!console || console.pid !== shell.parent || console.started > shell.started) return { ended: 'the scheduled task it runs under has ended' }
  if (console.name.toLowerCase() !== 'conhost.exe' || !/\s--headless\s/i.test(` ${console.line} `))
    return { none: 'its launcher was not started by a scheduled task' }
  return { launcher: { console: { pid: console.pid, started: console.started }, shell: { pid: shell.pid, started: shell.started } } }
}

/** How long Windows is given to say, through PowerShell, which takes a while to start. */
const ASK_MS = 30_000
/** Asks Windows what is above this program, without holding up anything else the service does meanwhile. */
export function find(pid = process.pid): Promise<Found> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (found: Found) => {
      if (done) return
      done = true
      clearTimeout(limit)
      resolve(found)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(askScript(pid), 'utf16le').toString('base64')], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (err) {
      resolve({ failed: `PowerShell could not be started (${(err as NodeJS.ErrnoException).code ?? 'error'})` })
      return
    }
    const limit = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ failed: `PowerShell did not answer within ${ASK_MS / 1000} seconds and was ended` })
    }, ASK_MS)
    let err = ''
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      out += d
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      err += d
    })
    child.on('error', (e: NodeJS.ErrnoException) => finish({ failed: `PowerShell could not be started (${e.code ?? 'error'})` }))
    child.on('close', (code) => {
      if (code !== 0) {
        const printed = `${out}${err}`.trim().split(/\r?\n/)[0]
        return finish({ failed: `PowerShell ended with exit code ${code}${printed ? `, and printed: ${printed}` : ', and printed nothing'}` })
      }
      finish(judge(out, pid))
    })
  })
}

/** Whether a process of this number is running. One this program may not look into is running all the same. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How often the two processes are looked at: each look costs next to nothing. */
export const LOOK_MS = 2000
/**
 * How often Windows is asked again whether they are the very ones found at first. A number is
 * given again once its process has ended, and a process given the console's number before the
 * next look would otherwise be taken for the console for as long as it ran.
 */
export const AGAIN_MS = 15 * 60_000
/** And how long after Windows could not be asked it is asked again. */
export const RETRY_MS = 60_000

export interface Watching {
  find: () => Promise<Found>
  alive: (pid: number) => boolean
  look: number
  again: number
  retry: number
}
/**
 * Watches the scheduled task's launcher above this program, and calls `ended` once, with why,
 * when it has gone. Where this program was not started by a launcher there is nothing to watch.
 * Gives a function that stops the watch. Nothing it waits for keeps the program running.
 */
export function watchTask(
  ended: (why: string) => void,
  say: (line: string) => void,
  { find: ask = find, alive: running = alive, look = LOOK_MS, again = AGAIN_MS, retry = RETRY_MS }: Partial<Watching> = {},
): () => void {
  let stopped = false
  let looking: ReturnType<typeof setInterval> | undefined
  let later: ReturnType<typeof setTimeout> | undefined
  let found: Launcher | undefined
  let failedSaid = false
  const end = (why: string) => {
    if (stopped) return
    stop()
    ended(why)
  }
  const stop = () => {
    stopped = true
    clearInterval(looking)
    clearTimeout(later)
  }
  const after = (ms: number, then: () => void) => {
    later = setTimeout(then, ms)
    later.unref?.()
  }
  const same = (a: Launcher, b: Launcher) =>
    a.console.pid === b.console.pid && a.console.started === b.console.started && a.shell.pid === b.shell.pid && a.shell.started === b.shell.started
  const asked = async () => {
    const now = await ask()
    if (stopped) return
    if ('ended' in now) return end(now.ended)
    if ('none' in now) {
      // Found once, the launcher it had is not what is there any longer
      if (found) return end('the scheduled task it runs under has ended')
      return stop()
    }
    if ('failed' in now) {
      if (!failedSaid) say(`could not tell whether its scheduled task is running (${now.failed}); it asks again in ${Math.round(retry / 1000)} seconds`)
      failedSaid = true
      return after(found ? again : retry, () => void asked())
    }
    if (found && !same(found, now.launcher)) return end('the scheduled task it runs under has ended')
    if (!found) {
      found = now.launcher
      say('it runs under its scheduled task, and stops by itself once that has ended')
      const { console, shell } = found
      looking = setInterval(() => {
        if (!running(console.pid)) end('the scheduled task it runs under has ended')
        else if (!running(shell.pid)) end('the launcher that started it has gone')
      }, look)
      looking.unref?.()
    }
    after(again, () => void asked())
  }
  void asked()
  return stop
}
