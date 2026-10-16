// Reopening a conversation that has been closed: each agent app's own command for carrying a
// conversation on without a window, how that command is run and stopped, and how often a
// conversation may be reopened. None of it is done for an app the person has not switched
// Auto-wake on for, which is the connector's to see to.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
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
  '[It] It reopened this conversation for what is above, which a page of yours sent while the conversation was closed: each part of it says whether someone had just used the page. You can do here what you could do while they were with you: the same commands, run the same way. The one difference is that nobody is watching, so nobody can answer a question or approve anything, and what you would have asked them about first still waits for them: say on the page that it does. Run `it` by that name alone, with no folder in front of it and no `export` before it: it is on your PATH, and in that form it is never held for approval. Do what was asked and nothing more, show on the page that you have, and then end your turn: do not wait for anything else to be done, since It reopens this conversation for whatever is done next. Try what the work needs before you conclude that you may not. Only if a command is in fact refused, say so where they will see it, with `it notify` or the page’s state, and run `it ack <action id> --failed`.'

/**
 * What a conversation is told when it is reopened for something a second time, because It
 * itself was stopped or restarted in the middle of its turn. The turn was ended with It, and
 * what it was reopened for is given again: without a word of that, an agent does again what
 * it had already done (a press counted twice, a message sent twice).
 */
export const WAS_CUT_OFF =
  '[It] An earlier turn of this conversation that It had reopened was cut off before it ended, so some of what it was working on may already be done. What is above may be that same work given again, or something new, or both: go by the action ids. Look at the page’s state, and at what you last did in this conversation, before you do any of it, and do not do twice what was already done.'

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
  '[It] One thing more. The person stopped this conversation’s last turn, from the page, before it had finished. That cancelled what they had done up to then and you had not finished: what that turn was working on, and anything else that reached this conversation while it worked, even where you see it earlier in this conversation with no answer after it. Leave all of that undone. What is at the top of this message was sent after they stopped it. It is new, and it is what this turn is for: do it, and only it.'

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
  /** `run` is this run's own name, which no other run of the conversation has: what the run starts carries it on, and is found by it wherever it goes. */
  marks: { harness: string; session: string; run?: string },
  opts: {
    patience?: number
    signal?: AbortSignal
    said?: (words: string) => void
    keepIn?: string
    began?: (pid: number) => void
    /** Called where the run was ended and the system would not say what of it was left: whoever noted it keeps the note. */
    unsure?: () => void
    /** Called where the run is being ended because its time is over: it was at work, and did not finish. */
    overtime?: () => void
  } = {},
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
          ...(marks.run ? { IT_RUN: marks.run } : {}),
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
    let over = false
    const end = (why: string | null, itsOwn = false) => {
      if (over) return
      over = true
      clearTimeout(timer)
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
    // The identity is captured while this child is ours. Every later signal checks it again.
    const since = child.pid ? identity([child.pid]).get(child.pid) : undefined
    let ending = false
    const quit = (why: string | null) => {
      if (ending) return
      ending = true
      if (process.platform === 'win32') {
        // Windows cannot inspect inherited marks. Keep the record if its tree command fails.
        if (!child.pid) return end(why)
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err) opts.unsure?.()
          end(why)
        })
        return
      }
      if (!child.pid || since === undefined) {
        opts.unsure?.()
        return end(why)
      }
      void endTree(child.pid, since, { ...marks, told: SINCE_TOLD }).then(
        (outcome) => {
          if (outcome === 'unknown') opts.unsure?.()
          end(why)
        },
        () => {
          opts.unsure?.()
          end(why)
        },
      )
    }
    const stop = () => {
      stopped = true
      quit(STOPPED)
    }
    opts.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      // Said before it is ended, to whoever keeps the notes: only where this is what ends it, and not a stop that came first
      if (!ending && !stopped) opts.overtime?.()
      quit(`${how.app} had not finished in fifteen minutes`)
    }, patience)
    child.once('error', (err) => end((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${how.app} was not found` : `${how.app} could not be started`))
    child.once('exit', (code, signal) =>
      ending ? undefined : stopped ? end(STOPPED) : code === 0 ? end(null) : end(`${how.app} exited with ${signal ?? code ?? 'an error'}`, signal === null),
    )
    child.stdin?.on('error', () => {})
    // Whoever started it is told which process it is, to write down, before it is given
    // anything to do: a connector that dies has no other way of knowing, when it next starts,
    // what it left running. Where it cannot be written down, the app is ended as it stands,
    // having done nothing: a run that nobody could find again is not left to run.
    if (child.pid && opts.began)
      try {
        opts.began(child.pid)
      } catch {
        return quit(`${how.app} was started and could not be noted down, so it was ended before it was given anything to do`)
      }
    child.stdin?.end(how.input)
  })
}

/**
 * Ends a process and everything it started, where it is still the process it was when it was
 * noted (`since`, as `identity` gave it): asked first, and ended for it a few seconds later.
 * Answers once nothing of it is left:
 *
 * - `ended`: it, or what it left behind, was there and is not any more.
 * - `gone`: there was nothing of it. Its number is nobody's, or is another process's by now,
 *   which is left alone; or the machine has been started again since it was noted.
 * - `unknown`: the system could not be asked which processes there are, or something of it is
 *   still there after being ended, or something is there that cannot be told to be its own.
 *   Whoever asked keeps its note, and asks again.
 *
 * The process was started in a group of its own, named by its number. Where it is gone and a
 * group of that number is there, the group may be what it started, or may belong to something
 * else that was given the number since. So each process in the group is asked which run it
 * belongs to, by the two marks every reopened run is started with and hands on to what it
 * starts (`of`), and only one that carries this run's marks is ended. Whatever in the group
 * carries none is left alone, and while it is there the answer is `unknown`: it may be a
 * command of the run's that was started with nothing handed on, or something else altogether.
 *
 * Nothing is done on Windows, where none of this can be told: the answer there is `unknown`.
 */
export async function endTree(
  pid: number,
  since: string,
  of?: { harness: string; session: string; boot?: string; told?: number; run?: string },
): Promise<'ended' | 'gone' | 'unknown'> {
  if (process.platform === 'win32') return 'unknown'
  // Noted before the machine was last started: nothing of it is left, whatever has its number now
  if (fromAnotherStart(of?.boot)) return 'gone'
  const now = processes([pid])
  if (now === null) return 'unknown'
  const itself = now.get(pid) === since
  // Noted by a program that told a process's start another way than this one does: what has
  // the number now cannot be told to be it or not to be, and is neither ended nor forgotten
  if (!itself && now.has(pid) && of !== undefined && of.told !== SINCE_TOLD) return 'unknown'
  // Another process has the number now: neither it nor its group is what was noted, and
  // neither is looked at or signalled. That says nothing of what the run left elsewhere,
  // which is found below by the run's own name where the note carries one.
  const reused = !itself && now.has(pid)
  let all: number[]
  let group = false
  // What is in its group and does not say whose it is: never signalled, and the run is not known to be over while any of it is there
  let others: number[] = []
  // Whatever carries this run's own name, wherever it is by now: a command the run started in
  // a group of its own is in neither the run's family nor its group once the run is gone, and
  // is the run's all the same. No other run has the name, so what carries it is ended with it.
  const markedNow = of?.run ? marked(of.run, since) : new Map<number, string>()
  // Failed discovery leaves uncertainty, but does not prevent ending processes whose
  // identities can still be checked. In particular, Stop still reaches a known leader.
  let uncertain = markedNow === null
  const strays = [...(markedNow?.keys() ?? [])]
  if (reused) {
    if (!strays.length) return uncertain ? 'unknown' : 'gone'
    all = strays
  } else if (itself) {
    const under = descendantsKnown(pid)
    if (under === null) uncertain = true
    all = [...new Set([pid, ...(under ?? []), ...strays])]
    group = true
  } else {
    const members = inGroup(pid)
    if (members === null) return 'unknown'
    if (!members.length && !strays.length) return uncertain ? 'unknown' : 'gone'
    if (!of) return 'unknown'
    const whose = members.map((p) => [p, strays.includes(p) ? true : belongs(p, of)] as const)
    all = [...new Set([...whose.filter(([, is]) => is === true).map(([p]) => p), ...strays])]
    // Whatever in the group does not say it is this run's may still be: a command started
    // with nothing handed on to it carries no mark. It is not signalled, since it may as well
    // be something else's, and while it is there the run is not known to be over.
    others = whose.filter(([, is]) => is !== true).map(([p]) => p)
    if (!all.length) return 'unknown'
  }
  let were = processes(all)
  if (were === null) {
    uncertain = true
    were = new Map([...now, ...(markedNow ?? [])].filter(([p]) => all.includes(p)))
  }
  for (const p of strays) if (were.get(p) !== markedNow!.get(p)) were.delete(p)
  // A failed inspection cannot be undone by an empty later snapshot. A detached command may
  // have lost its mark while the system would not let us read it.
  const signalled = new Map<number, string>()
  const left = (): Map<number, string> => {
    const found = of?.run ? marked(of.run, since) : new Map<number, string>()
    if (found === null) uncertain = true
    else for (const [p, at] of found) were.set(p, at)
    // One identity snapshot for the whole tick. On macOS each call runs ps, so asking for
    // every process separately would keep the connector from answering while Stop runs.
    const is = processes([...were.keys()])
    if (is === null) uncertain = true
    const still = new Map<number, string>()
    for (const [p, at] of were) {
      if (is?.get(p) === at) still.set(p, at)
    }
    return still
  }
  const signal = (how: 'SIGTERM' | 'SIGKILL', to: Map<number, string>) => {
    // The leader's number may already belong to someone else. Its group is signalled only
    // while the leader itself still proves whose group it is.
    let groupSignalled = false
    if (group && (how === 'SIGKILL' || signalled.get(pid) !== since) && to.get(pid) === since)
      try {
        process.kill(-pid, how)
        groupSignalled = true
      } catch {}
    for (const [p, at] of to) {
      if (groupSignalled && p === pid) {
        signalled.set(pid, since)
        continue
      }
      try {
        process.kill(p, how)
        signalled.set(p, at)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') uncertain = true
      }
    }
  }
  // Look for inherited run marks throughout both stages, including after the leader exits.
  // Two empty looks allow a child that is still starting to expose its environment.
  let empty = 0
  for (let waited = 0; waited <= 7000; waited += 250) {
    const still = left()
    if (still.size === 0) {
      if (++empty >= 2) {
        const members = inGroup(pid)
        if (members === null) return 'unknown'
        // A zombie cannot act. Anything else in the old group that could not be identified
        // remains a reason to keep the run, and is never signalled by its number alone.
        const remaining = processes(members)
        if (remaining === null || (!reused && remaining.size > 0) || others.some((p) => remaining.has(p))) return 'unknown'
        return uncertain ? 'unknown' : 'ended'
      }
    } else {
      empty = 0
      signal(waited >= 5000 ? 'SIGKILL' : 'SIGTERM', waited >= 5000 ? still : new Map([...still].filter(([p, at]) => signalled.get(p) !== at)))
    }
    if (waited < 7000) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return 'unknown'
}

/**
 * How this program tells when a process was started, as a number that goes into each note of
 * a run. On Linux it is the tick at which the system itself says the process started, which no
 * setting of the clock alters. On macOS it is `ps`'s own words for the time, in English and by
 * the clock at Greenwich. A note without the number, or with another, was written by a program
 * that told it another way.
 */
export const SINCE_TOLD = 3

/**
 * What says which start of this machine a process belongs to: one that was noted under another
 * is gone, whatever has its number now. Nothing where the system does not say.
 */
export function bootId(): string | undefined {
  try {
    const said =
      process.platform === 'linux'
        ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
        : process.platform === 'darwin'
          ? // The name macOS gives each start of the machine. The time it started at is not asked:
            // it is printed as a date in the time zone of the moment, and so reads differently
            // after a change of zone, with the machine never having stopped
            String(
              spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).stdout ??
                '',
            )
          : ''
    const id = said.trim().toLowerCase()
    return BOOT.test(id) ? id : undefined
  } catch {}
  return undefined
}
/** How each system names a start of the machine. Anything else that was noted as one says nothing. */
const BOOT = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
/**
 * Whether a run was noted under another start of this machine than the one it is in now. Only
 * where both are known and are told the same way: a note that names the start some other way,
 * as an earlier It did on macOS, says nothing, and what it noted is looked at as any other is.
 */
export const fromAnotherStart = (noted: string | undefined, now: string | undefined = bootId()): boolean =>
  noted !== undefined && now !== undefined && BOOT.test(noted) && BOOT.test(now) && noted !== now

/**
 * Asks `ps`, in a way that the one on macOS and the one on Linux both take. Each column is
 * asked for by an option of its own: given as one list, the `ps` of macOS takes everything
 * after the first `=` for a heading, and prints one column. And times are said the same way
 * whatever language and time zone this program was started in, since a time that is written
 * down by one start of the service is compared with what another reads. Null where it could
 * not be run, or ended in a way that is none of `ok`.
 */
function ps(args: string[], ok: number[] = [0]): string | null {
  const ran = spawnSync(process.platform === 'darwin' ? '/bin/ps' : 'ps', args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
  if (ran.error || ran.signal || !ok.includes(ran.status ?? -1)) return null
  return String(ran.stdout ?? '')
}

/**
 * Whether this machine has a `ps` that lists processes as this program asks it to. Without one
 * a reopened conversation can be started and cannot be looked after: what it left running when
 * it was stopped or cut off cannot be found. A small container often has none.
 */
export const listsProcesses = (): boolean => process.platform === 'win32' || ps(['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=']) !== null
/** What to do where it has none. */
export const NO_PS =
  'This machine has no `ps` command that It can list processes with, which it needs to look after the conversations it reopens. Install it (the package is called procps on most Linux systems, and procps-ng on some), then restart It.'

/** The processes in the group of this number, and null where the system could not be asked. */
function inGroup(group: number): number[] | null {
  const listed = ps(['-A', '-o', 'pid=', '-o', 'pgid='])
  if (listed === null) return null
  const found: number[] = []
  for (const line of listed.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pid && pgid === group) found.push(pid)
  }
  return found
}

/**
 * Whether a process carries the two marks a reopened run is started with, which say whose it
 * is: read from what the process was started with, as the system keeps it for the user whose
 * process it is. Null where that cannot be read.
 */
function belongs(pid: number, of: { harness: string; session: string }): boolean | null {
  const marks = [`IT_HARNESS=${of.harness}`, `IT_SESSION=${of.session}`]
  if (process.platform === 'linux')
    try {
      const has = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      return marks.every((mark) => has.includes(mark))
    } catch (err) {
      // Gone since it was listed: not there to belong to anything
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
    }
  // With what it was started with after its words, which macOS shows of one's own processes. One that is gone is nobody's.
  const said = ps(['-E', '-ww', '-o', 'command=', '-p', String(pid)], [0, 1])
  if (said === null) return null
  if (!said.trim()) return false
  const has = ` ${said.replace(/\n/g, ' ')} `
  return marks.every((mark) => has.includes(` ${mark} `))
}

/**
 * The processes that carry a run's own name in what they were started with, wherever they are.
 * Null where the system could not be asked. Another person's process cannot be read and is
 * passed over: it is not this run's, which runs as this person.
 */
function marked(run: string, since: string): Map<number, string> | null {
  const mark = `IT_RUN=${run}`
  const found = new Map<number, string>()
  if (process.platform === 'linux') {
    let listed: string[]
    try {
      listed = readdirSync('/proc')
    } catch {
      return null
    }
    for (const name of listed) {
      if (!/^\d+$/.test(name)) continue
      try {
        const pid = Number(name)
        const before = processes([pid])
        if (before === null) return null
        if (!before.has(pid)) continue
        // A child cannot predate its run. This also excludes older programs whose protected
        // environments this user cannot read. Unknown ages stay conservative.
        if (/^tick \d+$/.test(since) && Number(before.get(pid)!.slice(5)) < Number(since.slice(5))) continue
        if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(mark)) {
          const after = processes([pid])
          if (after === null) return null
          if (after.get(pid) === before.get(pid)) found.set(pid, before.get(pid)!)
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ESRCH') continue
        // The process may have exited between its stat and environment reads. A zombie's
        // environment is no longer readable, but it cannot start or continue any work.
        const after = processes([Number(name)])
        if (after !== null && after.size === 0) continue
        // Another user's environment is private. An unreadable process of our own may be
        // a detached command, so it prevents a claim that the run has finished.
        try {
          if (statSync(`/proc/${name}`).uid !== process.getuid?.()) continue
        } catch (gone) {
          if (['ENOENT', 'ESRCH'].includes((gone as NodeJS.ErrnoException).code ?? '')) continue
        }
        return null
      }
    }
  } else {
    // Read the identity and inherited marks together. Looking up each match again would
    // start several ps commands per child; the caller checks all identities together before
    // signalling, so a number reused since this listing is still left alone.
    const said = ps(['-A', '-E', '-ww', '-o', 'pid=', '-o', 'lstart=', '-o', 'command='])
    if (said === null) return null
    for (const line of said.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
      if (m && ` ${m[3]} `.includes(` ${mark} `)) found.set(Number(m[1]), m[2]!)
    }
  }
  found.delete(process.pid)
  return found
}

/**
 * Which of these processes there are now, each with when it was started: the two together are
 * one process and no other, where its number alone may come to be another's. None where the
 * system cannot be asked.
 */
export function identity(pids: number[]): Map<number, string> {
  return processes(pids) ?? new Map()
}

/**
 * The same, and null where the system could not be asked at all (it has no `ps`, or `ps` did
 * not answer in time): that is not the same as none of them being there, and whoever is about
 * to forget a process must know which of the two it is.
 */
export function processes(pids: number[]): Map<number, string> | null {
  const found = new Map<number, string>()
  if (process.platform === 'win32') return null
  if (pids.length === 0) return found
  // On Linux a process is told by the tick of the machine's own count at which it started, as
  // the system keeps it. The calendar time `ps` prints for it is worked out from when the
  // machine started, and reads differently once the machine's clock has been set right, as a
  // board with no clock battery sets its own when the network comes up: the same process
  // would then be taken for another, and a run that is still going for one that is gone.
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        // After the name, which stands in brackets and may hold anything, the twentieth word is the start
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (fields[0] === 'Z' || fields[0] === 'X') continue
        const ticks = fields[19]
        if (!ticks || !/^\d+$/.test(ticks)) return null
        found.set(pid, `tick ${ticks}`)
      } catch (err) {
        // No such process any more. Anything else is a system that would not say
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ESRCH') return null
      }
    }
    return found
  }
  // It says that none of them is there by ending with 1, with what it found before that in
  // what it printed. Anything else is a `ps` that could not be run, or was ended
  const listed = ps(['-o', 'pid=', '-o', 'lstart=', '-p', pids.join(',')], [0, 1])
  if (listed === null) return null
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
  return descendantsKnown(of) ?? []
}

/** The same, and null where the system could not be asked: not the same as there being none. */
export function descendantsKnown(of: number): number[] | null {
  if (process.platform === 'win32') return null
  const listed = ps(['-A', '-o', 'pid=', '-o', 'ppid='])
  if (listed === null) return null
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
 * The file Claude Code keeps of a conversation, or null where there is none. Claude Code files
 * a conversation under the folder it was begun in. The folder It has noted for a conversation
 * is the one its agent last ran `it` in, which is another as soon as the agent has moved into
 * a folder inside it. So where the file is not under the folder that was noted, it is looked
 * for under every folder Claude Code keeps conversations of: its name is the conversation's
 * id, which no other conversation has.
 */
function claudeRecord(session: string, cwd: string, configDir: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(session)) return null
  const projects = path.join(configDir, 'projects')
  const noted = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)
  if (existsSync(noted)) return noted
  try {
    for (const folder of readdirSync(projects)) {
      const file = path.join(projects, folder, `${session}.jsonl`)
      if (existsSync(file)) return file
    }
  } catch {}
  return null
}

/**
 * The permission mode the person last had a Claude Code conversation in, as Claude Code wrote
 * it down in the file it keeps of the conversation, or null where that cannot be told. A turn
 * that It started itself, by reopening the conversation, says nothing of what the person chose:
 * those are the turns begun with Claude Code's own command for running without a window, and
 * they are passed over.
 */
export function claudeModeOf(session: string, cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string | null {
  const file = claudeRecord(session, cwd, configDir)
  if (!file) return null
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
 * When Claude Code last wrote anything of a conversation, by the file it keeps of each one,
 * or null when there is no such file. A
 * conversation that is open where It's add-on is not loaded (one begun before the add-on was
 * installed, say) looks closed to It, and one that wrote a moment ago is at work: it is left
 * alone until it has been quiet.
 */
export function claudeWroteAt(session: string, cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): number | null {
  const file = claudeRecord(session, cwd, configDir)
  if (!file) return null
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}
