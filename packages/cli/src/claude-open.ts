// Which Claude Code conversations are open on this machine now, as Claude Code itself keeps note
// of them. Each Claude Code that runs writes a file of its own in its folder's `sessions`, named
// by its process id, which says which conversation it has open, when it began, what kind of
// session it is and what started it, and removes the file when it ends. A file left by one that
// did not end cleanly names a process that is gone, or one that is another program by now, and
// is passed over.
import { type ChildProcess, execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface OpenClaude {
  /** The conversation's id, as Claude Code's own commands and It's add-on know it. */
  id: string
  /** When the Claude Code that has it open began, by its own clock. */
  startedAt: number
}

/** How many files are read of one folder, at most: far more Claude Codes than anyone runs at once. */
const MOST = 200
/** And how long one may be: the file is a few hundred bytes. */
const LONGEST = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a process is running, as the system says: one it will not let this program signal is running all the same. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * When a process began, as Linux counts it, which is what Claude Code writes as `procStart`
 * there: a process id that has been given to another program since is told by it. Undefined
 * where the system does not say it this way.
 */
export function startOf(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The program's name, in brackets, may hold spaces and brackets of its own: the fields are counted after the last
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

/** How long `ps` says a process has run, `[[dd-]hh:]mm:ss`, in milliseconds: undefined where it is not that. */
export function ranFor(etime: string): number | undefined {
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(etime)
  if (!m) return undefined
  const [, d = '0', h = '0', min, sec] = m
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min!)) * 60 + Number(sec!)) * 1000
}

/** How long stopping discovery waits for its children to be gone, so that a child that cannot be killed never holds up shutdown. */
const STOP_WAIT_MS = 2_000

/** Discovery belongs to one connector lifetime; stopping it cannot stop a later connector. */
export class ClaudeDiscovery {
  private ended = false
  private children = new Map<ChildProcess, { cancel: () => void; exited: Promise<void> }>()
  /** What the last look at Windows' Claude processes found, when, and for which notes. */
  private windowsSeen?: { at: number; starts: ReadonlyMap<number, number>; for: ReadonlySet<string>; read: boolean }

  get stopped(): boolean {
    return this.ended
  }

  /**
   * Kill only discovery's own child PIDs, settle scans as unknown, and wait until the PIDs are gone, for at most
   * STOP_WAIT_MS: a child the system would not kill, or that never says it ended, is left, and stopping goes on.
   */
  async stop(): Promise<void> {
    this.ended = true
    const waits: Promise<void>[] = []
    for (const [child, scan] of [...this.children]) {
      scan.cancel()
      const running = child.exitCode === null && child.signalCode === null
      // A kill the system refused leaves nothing to wait for
      if (!running || child.kill('SIGKILL')) waits.push(scan.exited)
      else this.children.delete(child)
    }
    if (!waits.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(waits), new Promise<void>((done) => (timer = setTimeout(done, STOP_WAIT_MS)))])
    clearTimeout(timer)
  }

  /**
   * Windows' Claude processes and their starts, for the notes given, each named `pid:startedAt`.
   * PowerShell is started only where the last look did not cover one of these notes, failed a
   * while ago, or is older than WINDOWS_FRESH_MS: a process's start never changes, and a note
   * whose Claude Code has ended is told by `running` on every scan. What a look that is kept
   * cannot see is a number given to another program after a Claude Code ended without taking
   * its note away, and that is seen at the next look.
   */
  async windowsStarts(notes: readonly string[]): Promise<ReadonlyMap<number, number>> {
    const seen = this.windowsSeen
    const now = performance.now()
    if (seen && now - seen.at < (seen.read ? WINDOWS_FRESH_MS : WINDOWS_RETRY_MS) && notes.every((note) => seen.for.has(note))) return seen.starts
    const starts = await readWindowsStarts(this)
    if (!this.ended) this.windowsSeen = { at: performance.now(), starts: starts ?? new Map(), for: new Set(notes), read: starts !== undefined }
    return starts ?? new Map()
  }

  output(file: string, args: string[], timeout: number): Promise<string | undefined> {
    if (this.ended) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let answered = false
      let didExit = false
      const child = execFile(file, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024 }, (err, out) => {
        answered = true
        if (didExit) this.children.delete(child)
        resolve(this.ended || err ? undefined : out)
      })
      // Spawn failures have no PID. Their callback still settles the scan as unknown.
      if (child.pid !== undefined) {
        const exited = new Promise<void>((gone) => {
          // A child that fails, a kill refused among them, may say so without ever saying it ended
          const ended = () => {
            didExit = true
            if (answered) this.children.delete(child)
            gone()
          }
          child.once('exit', ended)
          child.once('error', ended)
        })
        this.children.set(child, { cancel: () => resolve(undefined), exited })
      }
    })
  }
}

/** When a process began, by this machine's clock, as `ps` says how long it has run, to the second. */
async function beganAt(pid: number, discovery: ClaudeDiscovery): Promise<number | undefined> {
  const out = await discovery.output('ps', ['-o', 'etime=', '-p', String(pid)], 2000)
  const ran = out === undefined ? undefined : ranFor(out)
  return ran === undefined ? undefined : Date.now() - ran
}

/** How much later than its process a Claude Code may say its session began, as the two clocks are read: a few seconds. */
const SLACK_MS = 5_000

/** How long one look at Windows' Claude processes is gone by while the notes it was taken for are all that is open. */
export const WINDOWS_FRESH_MS = 5 * 60_000
/** And how long a look that could not be read is, before PowerShell is tried again. */
export const WINDOWS_RETRY_MS = 30_000

/** Claude processes and their starts, read together as the backend reads Windows process identity: undefined where they could not be read. */
async function readWindowsStarts(discovery: ClaudeDiscovery): Promise<Map<number, number> | undefined> {
  const found = new Map<number, number>()
  const script =
    "$ProgressPreference = 'SilentlyContinue'; Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }"
  const out = await discovery.output(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    5000,
  )
  if (out === undefined) return undefined
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(line.trim())
    if (!m) continue
    // FILETIME counts 100ns ticks since 1601. Divide before converting to preserve milliseconds.
    const began = Number(BigInt(m[2]!) / 10_000n - 11_644_473_600_000n)
    if (Number.isSafeInteger(began) && began > 0) found.set(Number(m[1]), began)
  }
  return found
}

/**
 * Whether the running process a note names is the Claude Code that wrote it, and not another
 * program that has been given its number since that Claude Code ended without taking its note
 * away. On Linux the moment it began is the one the note says, exactly. On macOS it began no
 * later than the note's session did, as a process given the number afterwards cannot have. On
 * Windows its program is Claude Code's and began no later than the session did. A note that cannot be checked is passed over.
 */
export async function sameProcess(
  pid: number,
  note: { procStart?: unknown; startedAt: number },
  windows?: ReadonlyMap<number, number>,
  discovery = new ClaudeDiscovery(),
): Promise<boolean> {
  if (discovery.stopped) return false
  if (process.platform === 'linux' && typeof note.procStart === 'string') return startOf(pid) === note.procStart
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const began = await beganAt(pid, discovery)
    return began !== undefined && began <= note.startedAt + SLACK_MS
  }
  if (process.platform === 'win32') {
    const began = (windows ?? (await readWindowsStarts(discovery)))?.get(pid)
    return began !== undefined && began <= note.startedAt + SLACK_MS
  }
  return false
}

/**
 * The conversations that are open now in Claude Code at a person's keyboard, in each of the
 * folders given. Only where a person can type to it: a session run for a script, or by It
 * itself to reopen a conversation, has no prompt for a person to type `/reload-plugins` at, and
 * neither has a Claude Code that T3 Code runs, whose clicks reach it through T3 Code's own thread.
 */
export async function openClaude(
  folders: readonly string[],
  alive: (pid: number) => boolean = running,
  same: (pid: number, note: { procStart?: unknown; startedAt: number }) => boolean | Promise<boolean> = sameProcess,
  discovery = new ClaudeDiscovery(),
): Promise<OpenClaude[]> {
  const open = new Map<string, OpenClaude>()
  // Every note is read first, so that on Windows one look at the processes is taken for all of them, and only where one is live
  const live: { pid: number; id: string; procStart: unknown; startedAt: number }[] = []
  for (const folder of new Set(folders)) {
    const dir = path.join(folder, 'sessions')
    let names: string[]
    try {
      names = readdirSync(dir)
        .filter((name) => /^\d{1,10}\.json$/.test(name))
        .slice(0, MOST)
    } catch {
      continue
    }
    for (const name of names) {
      if (discovery.stopped) return []
      try {
        const file = path.join(dir, name)
        if (statSync(file).size > LONGEST) continue
        const s = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const pid = Number(name.slice(0, -5))
        if (s.pid !== pid || typeof s.sessionId !== 'string' || !UUID.test(s.sessionId) || typeof s.startedAt !== 'number') continue
        if (s.kind !== 'interactive' || s.entrypoint === 't3-code') continue
        if (alive(pid)) live.push({ pid, id: s.sessionId.toLowerCase(), procStart: s.procStart, startedAt: s.startedAt })
      } catch {
        // A file being written or removed this moment is read the next time
      }
    }
  }
  const windows =
    same === sameProcess && process.platform === 'win32' && live.length
      ? await discovery.windowsStarts(live.map((note) => `${note.pid}:${note.startedAt}`))
      : undefined
  for (const note of live) {
    if (discovery.stopped) return []
    try {
      const ok =
        same === sameProcess
          ? await sameProcess(note.pid, note, windows, discovery)
          : await same(note.pid, { procStart: note.procStart, startedAt: note.startedAt })
      if (!ok) continue
    } catch {
      continue
    }
    const was = open.get(note.id)
    if (!was || was.startedAt < note.startedAt) open.set(note.id, { id: note.id, startedAt: note.startedAt })
  }
  return discovery.stopped ? [] : [...open.values()]
}

/** The folder Claude Code keeps its settings in where nothing names another. */
export const claudeDefaultFolder = (): string => path.join(os.homedir(), '.claude')
