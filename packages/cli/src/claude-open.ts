// Which Claude Code conversations are open on this machine now, as Claude Code itself keeps note
// of them. Each Claude Code that runs writes a file of its own in its folder's `sessions`, named
// by its process id, which says which conversation it has open, when it began, what kind of
// session it is and what started it, and removes the file when it ends. A file left by one that
// did not end cleanly names a process that is gone, or one that is another program by now, and
// is passed over.
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
function startOf(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The program's name, in brackets, may hold spaces and brackets of its own: the fields are counted after the last
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
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
  started: (pid: number) => string | undefined = startOf,
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
        if (!alive(pid)) continue
        const begun = started(pid)
        if (begun !== undefined && typeof s.procStart === 'string' && s.procStart !== begun) continue
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
