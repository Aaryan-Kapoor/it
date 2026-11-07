// Which app holds a conversation, as far as It can tell, and whether the program that held it
// has gone. A conversation that an app holds is handed to that app and to nothing else: reopened
// beside it, its turn would run where the app does not show it. And a conversation is reopened
// only where It knows that it is closed: one that is quiet may be open in a window that It
// cannot see into.

import { holderRuns, processOf } from './serve/backend'

/** The apps It knows by name that hold the conversations they run. */
export type HostApp = 't3-code' | 'claude-desktop'

/**
 * The entrypoint Claude Code writes for each app It knows that holds a conversation. Claude's
 * desktop app writes `claude-desktop` for its Code tab and `local-agent` for its agent mode, as
 * was seen on Windows, and T3 Code sets `t3-code`. An app that is added here, with its name in
 * `HOST_NAMES`, is waited for by that name.
 */
export const HOST_ENTRYPOINTS: Readonly<Record<string, HostApp>> = {
  't3-code': 't3-code',
  'claude-desktop': 'claude-desktop',
  'local-agent': 'claude-desktop',
}

/**
 * Claude Code's entrypoints for a terminal (`cli`) and for running without a window
 * (`sdk-cli`), which is also how It reopens a conversation. Every other one is taken to be an
 * app that holds the conversation, though It does not know it by name: an app that embeds Claude
 * Code with its SDK writes `sdk-ts`, and VS Code writes `claude-vscode`.
 */
export const TERMINAL_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'sdk-cli'])

/** Each app's name as a person knows it. */
export const HOST_NAMES: Readonly<Record<HostApp, string>> = { 't3-code': 'T3 Code', 'claude-desktop': 'Claude’s desktop app' }

/**
 * Where a conversation is held: in an app It knows (with T3 Code's thread, where that is known),
 * in an app It does not know by name (`host`, with the entrypoint Claude Code wrote for it), or
 * in no app, which is a terminal or a run with no window.
 */
export type Held = { by: 't3-code'; thread?: string } | { by: 'claude-desktop' } | { by: 'host'; entrypoint: string } | { by: 'terminal' }

/** The program that held a conversation, as a lock names a process: see `processOf`. */
export interface Holder {
  pid: number
  started: string
  where: string
}

/** A thread id as T3 Code gives one: a line of reasonable length. Anything else is no thread. */
const threadId = (t: unknown): string | undefined => (typeof t === 'string' && t.length > 0 && t.length <= 512 && !/\p{Cc}/u.test(t) ? t : undefined)
const entrypoint = (e: unknown): e is string => typeof e === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(e)

/**
 * Where a conversation is held, by the entrypoints Claude Code wrote in it, in the order it wrote
 * them. A conversation that any app It knows has held is that app's, the last of them where it
 * was in two, however it was run since: one that T3 Code held and It then reopened outside it
 * was T3 Code's all the same. Otherwise one that an app It does not know has held is that app's.
 * Only a conversation that nothing but a terminal or a run with no window has held is held by
 * no app. Nothing where no entrypoint is known.
 */
export function heldBy(entrypoints: Iterable<string>): Held | undefined {
  let host: HostApp | undefined
  let other: string | undefined
  let terminal = false
  for (const e of entrypoints) {
    if (!entrypoint(e)) continue
    if (Object.hasOwn(HOST_ENTRYPOINTS, e)) host = HOST_ENTRYPOINTS[e]
    else if (TERMINAL_ENTRYPOINTS.has(e)) terminal = true
    else other = e
  }
  if (host) return { by: host }
  if (other) return { by: 'host', entrypoint: other }
  return terminal ? { by: 'terminal' } : undefined
}

/**
 * Where the conversation that runs a command is held, by what its app sets for the command. T3
 * Code sets `T3CODE_THREAD_ID` for the commands of the Claude Code and Codex it runs, so the
 * thread is known from the first page. Claude Code sets `CLAUDE_CODE_ENTRYPOINT`.
 */
export function heldHere(harness: string, env: NodeJS.ProcessEnv): Held | undefined {
  if (harness !== 'claude-code' && harness !== 'codex') return undefined
  const thread = threadId(env.T3CODE_THREAD_ID)
  if (thread) return { by: 't3-code', thread }
  if (harness !== 'claude-code') return undefined
  return heldBy(env.CLAUDE_CODE_ENTRYPOINT ? [env.CLAUDE_CODE_ENTRYPOINT] : [])
}

const rank = (h: Held): number => ({ 't3-code': 3, 'claude-desktop': 2, host: 1, terminal: 0 })[h.by]

/**
 * The most telling of several things known of where a conversation is held: any app over none,
 * an app It knows over one it does not, and T3 Code with its thread over T3 Code without. Of
 * two that tell as much, the first.
 */
export function together(...all: (Held | undefined)[]): Held | undefined {
  let best: Held | undefined
  for (const h of all) {
    if (!h) continue
    if (!best || rank(h) > rank(best) || (h.by === 't3-code' && best.by === 't3-code' && !best.thread && h.thread)) best = h
  }
  return best
}

/** What was noted of where a conversation is held, as it was written down. Anything that is not such a note is nothing. */
export function heldOf(noted: unknown): Held | undefined {
  if (!noted || typeof noted !== 'object') return undefined
  const n = noted as { by?: unknown; thread?: unknown; entrypoint?: unknown }
  if (n.by === 't3-code') {
    const thread = threadId(n.thread)
    return thread ? { by: 't3-code', thread } : { by: 't3-code' }
  }
  if (n.by === 'claude-desktop' || n.by === 'terminal') return { by: n.by }
  if (n.by === 'host' && entrypoint(n.entrypoint)) return { by: 'host', entrypoint: n.entrypoint }
  return undefined
}

/** The program that was noted to hold a conversation, as it was written down. Anything else is nothing. */
export function holderOf(noted: unknown): Holder | undefined {
  if (!noted || typeof noted !== 'object') return undefined
  const n = noted as { pid?: unknown; started?: unknown; where?: unknown }
  return typeof n.pid === 'number' && Number.isInteger(n.pid) && n.pid > 1 && typeof n.started === 'string' && typeof n.where === 'string'
    ? { pid: n.pid, started: n.started, where: n.where }
    : undefined
}

/**
 * The Claude Code program that holds the conversation running a command, by what Claude Code
 * sets for its commands: its own process id, `CLAUDE_PID`, beside the conversation's id. Only
 * where that id is the conversation's, so that a Claude Code started from inside another is
 * not taken for the other. Nothing where no process has that number now.
 */
export function holderHere(session: { harness: string; id: string }, env: NodeJS.ProcessEnv): Holder | undefined {
  if (session.harness !== 'claude-code' || env.CLAUDE_CODE_SESSION_ID !== session.id) return undefined
  const pid = Number(env.CLAUDE_PID)
  return Number.isInteger(pid) && pid > 1 ? processOf(pid) : undefined
}

/**
 * Whether It knows that the program that held a conversation has gone: no process has its number
 * now, or the one that has it was started at another time, or since the machine was started
 * again. Where the system will not say, it has not gone.
 */
export const holderGone = (h: Holder): boolean => !holderRuns(h)

/** Where the conversation running a command is held, and the program that holds it, to be noted with the conversation. */
export const heldNow = (session: { harness: string; id: string }, env: NodeJS.ProcessEnv = process.env): { held?: Held; holder?: Holder } => {
  const held = heldHere(session.harness, env)
  const holder = holderHere(session, env)
  return { ...(held ? { held } : {}), ...(holder ? { holder } : {}) }
}
