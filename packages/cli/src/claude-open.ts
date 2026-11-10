// Which Claude Code conversations are open on this machine now, as Claude Code itself keeps note
// of them. Each Claude Code that runs writes a file of its own in its folder's `sessions`, named
// by its process id, which says which conversation it has open, when it began, what kind of
// session it is and what started it, and removes the file when it ends. A file left by one that
// did not end cleanly names a process that is gone, or one that is another program by now, and
// is passed over.
import { spawnSync } from 'node:child_process'
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

/** When a process began, by this machine's clock, as `ps` says how long it has run, to the second. */
function beganAt(pid: number): number | undefined {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, windowsHide: true })
  const ran = r.status === 0 ? ranFor(r.stdout) : undefined
  return ran === undefined ? undefined : Date.now() - ran
}

/** How much later than its process a Claude Code may say its session began, as the two clocks are read: a few seconds. */
const SLACK_MS = 5_000

/**
 * Whether the running process a note names is the Claude Code that wrote it, and not another
 * program that has been given its number since that Claude Code ended without taking its note
 * away. On Linux the moment it began is the one the note says, exactly. On macOS it began no
 * later than the note's session did, as a process given the number afterwards cannot have. On
 * Windows its program is Claude Code's. A note that cannot be checked is passed over.
 */
export function sameProcess(pid: number, note: { procStart?: unknown; startedAt: number }): boolean {
  if (process.platform === 'linux' && typeof note.procStart === 'string') return startOf(pid) === note.procStart
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const began = beganAt(pid)
    return began !== undefined && began <= note.startedAt + SLACK_MS
  }
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const image = r.status === 0 ? /^"([^"]+)"/.exec(r.stdout.trim())?.[1] : undefined
    return image !== undefined && /^claude(\.exe)?$/i.test(image)
  }
  return false
}

/**
 * The conversations that are open now in Claude Code at a person's keyboard, in each of the
 * folders given. Only where a person can type to it: a session run for a script, or by It
 * itself to reopen a conversation, has no prompt for a person to type `/reload-plugins` at, and
 * neither has a Claude Code that T3 Code runs, whose clicks reach it through T3 Code's own thread.
 */
export function openClaude(
  folders: readonly string[],
  alive: (pid: number) => boolean = running,
  same: (pid: number, note: { procStart?: unknown; startedAt: number }) => boolean = sameProcess,
): OpenClaude[] {
  const open = new Map<string, OpenClaude>()
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
      try {
        const file = path.join(dir, name)
        if (statSync(file).size > LONGEST) continue
        const s = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const pid = Number(name.slice(0, -5))
        if (s.pid !== pid || typeof s.sessionId !== 'string' || !UUID.test(s.sessionId) || typeof s.startedAt !== 'number') continue
        if (s.kind !== 'interactive' || s.entrypoint === 't3-code') continue
        if (!alive(pid) || !same(pid, { procStart: s.procStart, startedAt: s.startedAt })) continue
        const id = s.sessionId.toLowerCase()
        const was = open.get(id)
        if (!was || was.startedAt < s.startedAt) open.set(id, { id, startedAt: s.startedAt })
      } catch {
        // A file being written or removed this moment is read the next time
      }
    }
  }
  return [...open.values()]
}

/** The folder Claude Code keeps its settings in where nothing names another. */
export const claudeDefaultFolder = (): string => path.join(os.homedir(), '.claude')
