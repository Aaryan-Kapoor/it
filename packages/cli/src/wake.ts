// Reopening a conversation that has been closed: each agent app's own command for carrying a
// conversation on without a window, how that command is run and stopped, and how often a
// conversation may be reopened. None of it is done for an app the person has not switched
// Auto-wake on for, which is the connector's to see to.
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_BACK_MS, WAKES } from '@it/protocol'
import { harnessEnv } from './lib'

/** Why a reopened conversation ended, where a person stopped it. It is not a failure, and nothing is tried again for it. */
export const STOPPED = 'it was stopped'

/**
 * Whether a closed conversation of an agent app may be reopened for a click made at a moment,
 * given what the person has switched on for this machine and since when. Only an app It has a
 * way to reopen, only where the person has switched that on for it, and only for what they did
 * from about then on: what had been waiting longer is not all run at once the moment the
 * switch is turned.
 */
export function mayWake(switched: ReadonlyMap<string, number>, harness: string, at: number): boolean {
  const since = switched.get(harness)
  return (WAKES as readonly string[]).includes(harness) && since !== undefined && at >= since - WAKE_BACK_MS
}

/** What each app is called where something is said of it. */
const APP: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode', hermes: 'Hermes', openclaw: 'OpenClaw' }

/**
 * What a conversation is told when It reopens it, before what was done on its page: that it can
 * do what it could do with the person there, that nobody is there to answer or approve, how `it`
 * is run so that it is never held for approval, and what to do where a command is in fact
 * refused, which is to say so where the person will see it. A woken conversation that is
 * refused a command and says so only in its own reply has told nobody.
 *
 * It must not read as a rule that only `it` may run. An earlier wording did, to a real agent:
 * "a command you are not already allowed to run is refused. Run `it` … it is allowed" had a
 * woken Pi, which may run anything, decline three times to try anything else.
 */
export const WOKEN =
  '[It] It reopened this conversation for what follows, which someone did on a page of yours while it was closed. You can do here what you could do while they were with you: the same commands, run the same way. The one difference is that nobody is watching, so nobody can answer a question or approve anything. Run `it` by that name alone, with no folder in front of it and no `export` before it: it is on your PATH, and in that form it is never held for approval. Do what was asked and nothing more, and show on the page that you have. Try what the work needs before you conclude that you may not. Only if a command is in fact refused, say so where they will see it, with `it notify` or the page’s state, and run `it ack <action id> --failed`.'

/** What a conversation is told, the next time it is reopened, when the person stopped its last reopened turn from the page. */
export const WAS_STOPPED =
  '[It] The turn before this one in this conversation was stopped by the person, from the page, before it had finished. Whatever it was in the middle of was not wanted any more: do not carry on with it unless what follows asks for it.'

/** A command that carries a conversation on: the words it is started with, and what it is given on its input. */
export interface Carrying {
  argv: string[]
  input: string
  app: string
}

/**
 * The command that carries one conversation of an agent app on with a message, or, as a string,
 * why there is none for this conversation. The conversation's id came with the page, which is
 * to say from whatever published it, and it is put on a command line: one of any other shape
 * than the app itself makes is not put there, since the command would read a word that begins
 * with dashes as an option of its own. The message is never put there: other users of the
 * machine can read a command line, so it goes on the command's input.
 *
 * What the conversation may do by itself is, for each app, what the person's own settings for
 * that app allow without asking, and running `it`:
 *
 * - Claude Code is told that `it` may run, by its name or by where it is installed, and is run
 *   in the permission mode the person last had this conversation in, where that is a mode that
 *   does not ask: a conversation they held with full access is reopened with full access, and
 *   one they held in the mode that asks is reopened with `it` and whatever their own settings
 *   allow. It does what it could do with them there, and no more.
 * - Codex is run in its sandbox for a workspace, with the network allowed and It's own folder
 *   writable, which is what `it` needs. It can write in the conversation's folder and nowhere
 *   else, and nothing can ask the person for more, since they are not there.
 * - Pi, OpenCode and Hermes are run as they are in a window, with whatever their own settings
 *   allow there. Nothing can ask the person for more, since they are not there.
 */
export function carrying(
  harness: string,
  session: string,
  text: string,
  has: { codex?: string[] | null; itHome: string; command?: string; mode?: string | null; itAt?: string[] },
): Carrying | string {
  const app = APP[harness] ?? harness
  const odd = `its conversation id is not one ${app} would have made`
  if (harness === 'claude-code') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) return odd
    // `it` by its name, and by each place it is installed: an agent that learned to run it by
    // its whole path, when its window had no PATH for it, is not refused for that
    const it = ['Bash(it:*)', ...(has.itAt ?? []).filter((p) => /^[^\s()*]+$/.test(p)).map((p) => `Bash(${p}:*)`)]
    const mode = has.mode && (CLAUDE_MODES as readonly string[]).includes(has.mode) ? ['--permission-mode', has.mode] : []
    return { argv: [has.command ?? 'claude', '--resume', session, '--print', ...mode, '--allowedTools', ...it], input: text, app }
  }
  if (harness === 'codex') {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(session)) return odd
    const codex = has.command ? [has.command] : has.codex
    if (!codex) return 'Codex was not found'
    return {
      argv: [
        ...codex,
        'exec',
        'resume',
        '--skip-git-repo-check',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        `sandbox_workspace_write.writable_roots=[${JSON.stringify(has.itHome)}]`,
        session,
        '-',
      ],
      input: text,
      app,
    }
  }
  if (harness === 'pi') {
    // Pi names a conversation with a UUID, and takes the whole of one or its beginning
    if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(session)) return odd
    return { argv: [has.command ?? 'pi', '--print', '--session', session], input: text, app }
  }
  if (harness === 'opencode') {
    if (!/^ses_[A-Za-z0-9]{1,120}$/.test(session)) return odd
    return { argv: [has.command ?? 'opencode', 'run', '--session', session], input: text, app }
  }
  if (harness === 'hermes') {
    // Hermes names a conversation by when it began and a few hex digits. Any other word is not
    // put there: it would be read as a title to look for, or as `latest`.
    if (!/^[0-9]{8}_[0-9]{6}_[0-9a-f]{4,32}$/.test(session)) return odd
    return { argv: [has.command ?? 'hermes', 'chat', '--resume', session, '--query-file', '-'], input: text, app }
  }
  return `It has no way to reopen a conversation of ${app}`
}

/**
 * Runs a command that carries a conversation on, in the folder the conversation was held in,
 * with its message on the command's input. Null when the command ran the turn. Otherwise why
 * it did not, for the log, in this program's own words: never what the command printed, which
 * may repeat the message. Stopped by the signal, it is ended and says so.
 */
export function carryOn(
  how: Carrying,
  cwd: string,
  marks: { harness: string; session: string },
  opts: { patience?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const patience = opts.patience ?? 15 * 60_000
  if (opts.signal?.aborted) return Promise.resolve(STOPPED)
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(how.argv[0]!, how.argv.slice(1), {
        cwd,
        // The folder is said in the environment as well. This program's own PWD is wherever it
        // was started, and an app that believes PWD over the folder it is in (OpenCode does)
        // would hold the conversation in one folder and wait for it in another, and never end.
        env: {
          ...Object.fromEntries(Object.entries(harnessEnv()).filter(([k]) => k !== 'OLDPWD')),
          PWD: cwd,
          IT_HARNESS: marks.harness,
          IT_SESSION: marks.session,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        // In a group of its own, so that stopping it stops what it started as well: a command
        // an agent is in the middle of does not run on after the agent is gone
        detached: process.platform !== 'win32',
      })
    } catch {
      return resolve(`${how.app} could not be started`)
    }
    let over = false
    const end = (why: string | null) => {
      if (over) return
      over = true
      clearTimeout(timer)
      clearTimeout(harder)
      opts.signal?.removeEventListener('abort', stop)
      resolve(why)
    }
    let harder: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    // Asked to end, and ended for it a few seconds later if it has not: a turn that is stopped stops
    // Everything it started is ended with it, so that a command an agent is in the middle of
    // does not run on after the agent is gone. Its group is signalled, and so is every process
    // that descends from it, since an app may start a tool's command in a group of its own.
    // Those are found before anything is ended: once a parent is gone, its children are no
    // longer known as its own.
    const signal = (how: 'SIGTERM' | 'SIGKILL', all: number[]) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, how)
        else child.kill(how)
      } catch {
        child.kill(how)
      }
      for (const pid of all)
        try {
          process.kill(pid, how)
        } catch {}
    }
    const quit = () => {
      const all = child.pid ? descendants(child.pid) : []
      signal('SIGTERM', all)
      harder = setTimeout(() => signal('SIGKILL', all), 5000)
      harder.unref?.()
    }
    const stop = () => {
      stopped = true
      quit()
    }
    opts.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      quit()
      end(`${how.app} had not finished in fifteen minutes`)
    }, patience)
    child.once('error', (err) => end((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${how.app} was not found` : `${how.app} could not be started`))
    child.once('exit', (code, signal) => end(stopped ? STOPPED : code === 0 ? null : `${how.app} exited with ${signal ?? code ?? 'an error'}`))
    child.stdin?.on('error', () => {})
    child.stdin?.end(how.input)
  })
}

/**
 * Every process that descends from one, however far down, as the system lists them now. None
 * where the system cannot be asked, and none on Windows, where a process has no such family.
 */
export function descendants(of: number): number[] {
  if (process.platform === 'win32') return []
  let listed: string
  try {
    listed = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of listed.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid || !Number.isInteger(ppid)) continue
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid])
  }
  const out: number[] = []
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (out.includes(child) || out.length > 2000) continue
      out.push(child)
      walk(child)
    }
  }
  walk(of)
  return out
}

/**
 * Reopens a Claude Code conversation that has been closed, with a click as what it is asked:
 * Claude Code's own command for carrying a conversation on without a window, run in the folder
 * the conversation was held in. Null when Claude Code ran the turn, and otherwise why it did not.
 */
export function claudeResume(session: string, cwd: string, text: string, command = 'claude', patience = 15 * 60_000): Promise<string | null> {
  const how = carrying('claude-code', session, text, { itHome: '', command })
  return typeof how === 'string' ? Promise.resolve(how) : carryOn(how, cwd, { harness: 'claude-code', session }, { patience })
}

/**
 * How often something may be done: so many at once, and one more for each while that passes.
 * A conversation that is used steadily is never held up by it, and one that is sent a great
 * deal at once, by a person or by a page that sends by itself, is reopened a few times and then
 * only as fast as this allows. Nothing is lost for it: what waits goes with the next reopening.
 */
export class Budget {
  private left: number
  private at: number
  constructor(
    private readonly most: number,
    private readonly everyMs: number,
    now = Date.now(),
  ) {
    this.left = most
    this.at = now
  }
  private fill(now: number): void {
    const more = Math.floor((now - this.at) / this.everyMs)
    if (more <= 0) return
    this.left = Math.min(this.most, this.left + more)
    this.at = this.left === this.most ? now : this.at + more * this.everyMs
  }
  /** Whether there is room for one more now. */
  has(now = Date.now()): boolean {
    this.fill(now)
    return this.left > 0
  }
  /** Uses one up. False, and nothing is used, when there is no room. */
  take(now = Date.now()): boolean {
    if (!this.has(now)) return false
    this.left--
    return true
  }
}

const heldAsked = new Map<string, { at: number; held: boolean }>()
/**
 * Whether some Codex on this machine has a conversation open: in its window, in an editor or
 * another app that runs Codex, or for the minute after it was closed. Such a Codex takes a
 * message from Codex's queue by itself, at once when it is idle and after its turn when it is
 * not. One that nobody has open takes nothing until it is opened, and then only when a turn
 * of it ends, so a message put in its queue would wait for that, and be cut off if the turn
 * that ended was one this program ran.
 *
 * Codex lets one program at a time write a conversation, and says which conversations are
 * being written with a file each: `thread-writer-locks/<id>.lock` in its folder, there for as
 * long as the conversation is open in some Codex. A Codex that was ended without warning
 * leaves its file behind, so where the system says who has a file open, that is asked too.
 */
export function codexHeld(thread: string, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), now = Date.now()): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(thread)) return false
  const lock = path.join(codexHome, 'thread-writer-locks', `${thread}.lock`)
  // Asked for every action that waits, on every pass: what was found is good for a moment
  const asked = heldAsked.get(lock)
  if (asked && now - asked.at < 1500) return asked.held
  const held = existsSync(lock) && openSomewhere(lock) !== false
  if (heldAsked.size > 500) heldAsked.clear()
  heldAsked.set(lock, { at: now, held })
  return held
}

/**
 * Whether any program of this person's has a file open, as the system tells it. Null where it
 * cannot be asked: the file being there is then all that is known.
 */
export function openSomewhere(file: string): boolean | null {
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    let pids: string[]
    try {
      pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
    } catch {
      return null
    }
    const me = process.getuid?.()
    let looked = 0
    for (const pid of pids) {
      try {
        if (me !== undefined && statSync(`/proc/${pid}`).uid !== me) continue
        const dir = `/proc/${pid}/fd`
        for (const fd of readdirSync(dir)) {
          looked++
          try {
            if (readlinkSync(`${dir}/${fd}`) === real) return true
          } catch {}
        }
      } catch {}
    }
    // Nothing of this person's could be looked into at all: that is not knowing, and is not "nobody"
    return looked === 0 ? null : false
  }
  if (process.platform === 'darwin') {
    try {
      return execFileSync('lsof', ['-t', '--', real], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''
    } catch (err) {
      // lsof ends with 1 and prints nothing when nobody has the file open
      return (err as { status?: number }).status === 1 ? false : null
    }
  }
  return null
}

/**
 * When Codex last wrote anything of a conversation, by the file it keeps of each one, or null
 * when no such file is found. Codex has no command that says whether a conversation is open
 * somewhere, and one that is open takes a queued message by itself: so whether Codex wrote of
 * it since the message was queued is how It tells that someone took it.
 */
export function codexWroteAt(thread: string, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): number | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(thread)) return null
  const kept = `${codexHome}\n${thread}`
  const known = found.get(kept)
  if (known) {
    try {
      return statSync(known).mtimeMs
    } catch {
      found.delete(kept)
    }
  }
  const newestFirst = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  // Kept by the day it began: sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl. The
  // newest days are looked in first, and no more than a year's worth of them.
  const root = path.join(codexHome, 'sessions')
  let looked = 0
  for (const year of newestFirst(root))
    for (const month of newestFirst(path.join(root, year)))
      for (const day of newestFirst(path.join(root, year, month))) {
        if (++looked > 400) return null
        const dir = path.join(root, year, month, day)
        const file = newestFirst(dir).find((name) => name.startsWith('rollout-') && name.endsWith(`-${thread}.jsonl`))
        if (!file) continue
        const full = path.join(dir, file)
        if (found.size > 500) found.clear()
        found.set(kept, full)
        try {
          return statSync(full).mtimeMs
        } catch {
          return null
        }
      }
  return null
}
const found = new Map<string, string>()

/** The permission modes of Claude Code that do not ask a person: a conversation last held in one of these is reopened in it. Any other is reopened in the mode that asks, where what would be asked is refused. */
export const CLAUDE_MODES = ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const

/**
 * The permission mode the person last had a Claude Code conversation in, as Claude Code wrote
 * it down in the file it keeps of the conversation, or null where that cannot be told. A turn
 * that It started itself, by reopening the conversation, says nothing of what the person chose:
 * those are the turns begun with Claude Code's own command for running without a window, and
 * they are passed over.
 */
export function claudeModeOf(session: string, cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(session)) return null
  const file = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    // Read from its end, a piece at a time, and no further back than a few megabytes: what the
    // person chose last is near the end, however long the conversation is
    const size = statSync(file).size
    const PIECE = 256 * 1024
    let end = size
    let rest = ''
    for (let read = 0; end > 0 && read < 16 * 1024 * 1024; read += PIECE) {
      const from = Math.max(0, end - PIECE)
      const piece = Buffer.alloc(end - from)
      readSync(fd, piece, 0, piece.length, from)
      const lines = (piece.toString('utf8') + rest).split('\n')
      // The first line of a piece may be the end of a line that begins before it
      rest = from > 0 ? lines.shift()! : ''
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line.includes('"permissionMode"')) continue
        try {
          const row = JSON.parse(line) as { type?: string; permissionMode?: unknown; entrypoint?: unknown }
          if (row.type !== 'user' || typeof row.permissionMode !== 'string' || row.entrypoint === 'sdk-cli') continue
          return row.permissionMode
        } catch {}
      }
      end = from
    }
    return null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * When Claude Code last wrote anything of a conversation, by the file it keeps of each one
 * under the folder the conversation was held in, or null when there is no such file. A
 * conversation that is open where It's add-on is not loaded (one begun before the add-on was
 * installed, say) looks closed to It, and one that wrote a moment ago is at work: it is left
 * alone until it has been quiet.
 */
export function claudeWroteAt(session: string, cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): number | null {
  if (!/^[0-9a-f-]{36}$/i.test(session)) return null
  try {
    return statSync(path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)).mtimeMs
  } catch {
    return null
  }
}
