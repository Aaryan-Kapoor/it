// Reopening a conversation that has been closed: each agent app's own command for carrying a
// conversation on without a window, how that command is run and stopped, and how often a
// conversation may be reopened. None of it is done for an app the person has not switched
// Auto-wake on for, which is the connector's to see to.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
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
  '[It] It reopened this conversation for what is above, which someone did on a page of yours while it was closed. You can do here what you could do while they were with you: the same commands, run the same way. The one difference is that nobody is watching, so nobody can answer a question or approve anything. Run `it` by that name alone, with no folder in front of it and no `export` before it: it is on your PATH, and in that form it is never held for approval. Do what was asked and nothing more, show on the page that you have, and then end your turn: do not wait for anything else to be done, since It reopens this conversation for whatever is done next. Try what the work needs before you conclude that you may not. Only if a command is in fact refused, say so where they will see it, with `it notify` or the page’s state, and run `it ack <action id> --failed`.'

/**
 * What a conversation is told when it is reopened for something a second time, because It
 * itself was stopped or restarted in the middle of its turn. The turn was ended with It, and
 * what it was reopened for is given again: without a word of that, an agent does again what
 * it had already done (a press counted twice, a message sent twice).
 */
export const WAS_CUT_OFF =
  '[It] You were given what is above once before. It was restarted while you were working on it, and that turn was cut off before it ended, so you may have done part of it or all of it. Look at the page’s state, and at what you last did in this conversation, before you do any of it again, and do not do twice what was already done.'

/**
 * What a conversation is told, the next time it is reopened, when the person stopped its last
 * reopened turn from the page. Said so that nothing of that turn is taken up again: an app that
 * is ended in the middle of a turn leaves, in the conversation, what the turn was asked and
 * whatever reached it while it worked, each with no answer after it. Told only that its turn
 * was stopped, an agent read those as still owed and did them all, a slow job and two presses
 * among them, on top of the one thing it had been reopened for. Told to do none of it and
 * "only what is above", another did nothing at all, the new thing included: so what is new is
 * said last, as new, as wanted, and as the one thing to do.
 */
export const WAS_STOPPED =
  '[It] One thing more. The person stopped this conversation’s last turn, from the page, before it had finished. That cancelled what they had done up to then and you had not finished: what that turn was working on, and anything else that reached this conversation while it worked, even where you see it earlier in this conversation with no answer after it. Leave all of that undone. What is at the top of this message they did after stopping. It is new and it is wanted: do it, and only it.'

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

let runs = 0
/** The end of a file, as text: as much of it as a last line could be in. */
function tail(file: string, bytes = 4096): string {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(bytes, size))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
/**
 * The last line an app printed, as it may be shown to the person whose app it is: the last of
 * its closing lines that speaks of something going wrong, or else the very last, without the
 * colours of a terminal, cut to a line's length, and with anything long enough to be a key
 * left out. Null where it printed nothing.
 */
export function lastWords(text: string): string | null {
  const lines = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the colours and cursor moves a terminal is sent
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
  // A file read from its middle begins with part of a line
  const closing = (lines.length > 1 && text.length >= 4096 ? lines.slice(1) : lines).slice(-8)
  const last =
    [...closing].reverse().find((l) => /error|fail|denied|invalid|not found|missing|unauthori|forbidden|expired|limit|cannot|could not|no such/i.test(l)) ??
    closing.at(-1)
  if (!last) return null
  const plain = last.replace(/[A-Za-z0-9_+/=-]{24,}/g, '…')
  return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain
}

/**
 * Runs a command that carries a conversation on, in the folder the conversation was held in,
 * with its message on the command's input. Null when the command ran the turn. Otherwise why
 * it did not, for the log, in this program's own words: never what the command printed, which
 * may repeat the message. Where the command ended badly by itself, the last line it printed is
 * handed to `said`, for the person whose app it is and for nothing that is kept. Stopped by
 * the signal, it is ended and says so.
 */
export function carryOn(
  how: Carrying,
  cwd: string,
  marks: { harness: string; session: string },
  opts: { patience?: number; signal?: AbortSignal; said?: (words: string) => void; keepIn?: string; began?: (pid: number) => void } = {},
): Promise<string | null> {
  const patience = opts.patience ?? 15 * 60_000
  if (opts.signal?.aborted) return Promise.resolve(STOPPED)
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    // What the app prints goes to a file that is this run's alone, and is read only where the
    // app ends badly, for its last line. A file and not a pipe: something the app leaves
    // running would be ended by a pipe that nobody reads any more.
    const printed = opts.keepIn ? path.join(opts.keepIn, `reopened-${process.pid}-${++runs}.txt`) : null
    let into: number | null = null
    if (printed)
      try {
        mkdirSync(path.dirname(printed), { recursive: true, mode: 0o700 })
        into = openSync(printed, 'w', 0o600)
      } catch {}
    const forget = () => {
      if (printed)
        try {
          rmSync(printed, { force: true })
        } catch {}
    }
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
        stdio: ['pipe', into ?? 'ignore', into ?? 'ignore'],
        windowsHide: true,
        // In a group of its own, so that stopping it stops what it started as well: a command
        // an agent is in the middle of does not run on after the agent is gone
        detached: process.platform !== 'win32',
      })
    } catch {
      if (into !== null) closeSync(into)
      forget()
      return resolve(`${how.app} could not be started`)
    }
    if (into !== null) closeSync(into)
    // Whoever started it is told which process it is, to write down: a connector that dies
    // has no other way of knowing, when it next starts, what it left running
    if (child.pid) opts.began?.(child.pid)
    let over = false
    const end = (why: string | null, itsOwn = false) => {
      if (over) return
      over = true
      clearTimeout(timer)
      // The harder ending that was set going is left to come: whatever of this run is still
      // there in a few seconds is ended then, whether or not the run has been said to be over
      opts.signal?.removeEventListener('abort', stop)
      // Ended by itself and badly: what it printed last is the only word there is of why
      if (itsOwn && printed && opts.said)
        try {
          const words = lastWords(tail(printed))
          if (words) opts.said(words)
        } catch {}
      forget()
      resolve(why)
    }
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
    // Being ended: what of it is still there, and what it is to be said to have ended as. Nothing
    // of a run is said to be over while a process of it can still act: the click it was reopened
    // for would be tried again beside it.
    let ending: { left: () => number[]; why: string | null; hard: boolean } | null = null
    const quit = (why: string | null) => {
      if (ending) return
      if (process.platform === 'win32') {
        // Windows has no group to signal: its own command ends a process with everything it started
        ending = { left: () => [], why, hard: true }
        if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
        child.kill()
        return
      }
      const all = child.pid ? descendants(child.pid) : []
      // Each as the process it is now, so that a number the system has since given to another
      // process is not taken for one of these
      const were = identity(all)
      const left = () => [...identity(all)].filter(([pid, since]) => were.get(pid) === since).map(([pid]) => pid)
      ending = { left, why, hard: false }
      signal('SIGTERM', all)
      const harder = setTimeout(() => {
        signal('SIGKILL', left())
        if (ending) ending.hard = true
        // Ended that way, there is nothing left of it to wait for: said to be over, if its own ending did not say so
        setTimeout(() => end(why), 1500).unref?.()
      }, 5000)
      harder.unref?.()
    }
    /** Says the run is over once nothing of it is left, looking a few times a second until the harder ending has come. */
    const settle = () => {
      const state = ending
      if (!state) return
      if (state.hard || state.left().length === 0) return end(state.why)
      setTimeout(settle, 250).unref?.()
    }
    const stop = () => {
      stopped = true
      quit(STOPPED)
    }
    opts.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => quit(`${how.app} had not finished in fifteen minutes`), patience)
    child.once('error', (err) => end((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${how.app} was not found` : `${how.app} could not be started`))
    child.once('exit', (code, signal) =>
      ending ? settle() : stopped ? end(STOPPED) : code === 0 ? end(null) : end(`${how.app} exited with ${signal ?? code ?? 'an error'}`, signal === null),
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(how.input)
  })
}

/**
 * Ends a process and everything it started, where it is still the process it was when it was
 * noted (`since`, as `identity` gave it): asked first, and ended for it a few seconds later.
 * Answers once nothing of it is left, with whether there was anything to end. Nothing is done
 * on Windows, where a process cannot be told from another that was given its number since.
 */
export async function endTree(pid: number, since: string): Promise<boolean> {
  if (process.platform === 'win32' || identity([pid]).get(pid) !== since) return false
  const all = [pid, ...descendants(pid)]
  const were = identity(all)
  const left = () => [...identity(all)].filter(([p, at]) => were.get(p) === at).map(([p]) => p)
  const signal = (how: 'SIGTERM' | 'SIGKILL', to: number[]) => {
    // Its group too: it was started in one of its own, and what it started is in it unless it was moved out
    try {
      process.kill(-pid, how)
    } catch {}
    for (const p of to)
      try {
        process.kill(p, how)
      } catch {}
  }
  signal('SIGTERM', all)
  for (let waited = 0; waited < 5000 && left().length; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250))
  if (left().length) {
    signal('SIGKILL', left())
    for (let waited = 0; waited < 2000 && left().length; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return true
}

/**
 * Which of these processes there are now, each with when it was started: the two together are
 * one process and no other, where its number alone may come to be another's. None where the
 * system cannot be asked.
 */
export function identity(pids: number[]): Map<number, string> {
  const found = new Map<number, string>()
  if (process.platform === 'win32' || pids.length === 0) return found
  let listed: string
  try {
    listed = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    // It says that none of them is there by failing, with what it found before that in what it printed
    listed = String((err as { stdout?: unknown }).stdout ?? '')
  }
  for (const line of listed.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) found.set(Number(m[1]), m[2]!)
  }
  return found
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
