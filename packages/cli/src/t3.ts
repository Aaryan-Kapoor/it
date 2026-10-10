// T3 Code runs agent apps' conversations inside threads of its own: it starts Claude Code or
// Codex for a thread, shows what the agent does there, and lets the program go again when the
// thread has been quiet, or when T3 Code itself is started anew. While T3 Code holds the
// program, It's add-on is alive inside it and hands a click over as it does in any open
// conversation. Once the program is gone, the conversation is closed as far as its agent app can
// tell, and reopening it with that app's own command would run the turn where the person does
// not see it: the thread in T3 Code would show nothing.
//
// So a click for such a conversation is handed to T3 Code itself, which starts a turn in the
// thread, in the mode the thread is held in, and shows it. This is everything It asks of T3
// Code, and all of it is asked of the server on this machine, as the person who runs both:
//
// - which server is running, from the note T3 Code keeps of it in its own folder;
// - a session of its own, for reading threads and sending to them, from T3 Code's own command
//   for issuing one (`t3 auth session issue`). It is kept in memory and never written down;
// - which thread a conversation is: T3 Code keeps, for each thread, the id the agent app gave
//   the conversation, and the thread whose conversation has this id is the one;
// - and that a message be put to that thread, which is what a person typing into it does.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson } from './lib'

/** The version of T3 Code's own protocol that this speaks. A server that speaks another refuses, and the click goes the way it went before. */
const PROTOCOL = '2'
/** How long T3 Code is given to answer anything. */
const ANSWER_MS = 20_000
/** How many threads are looked into for a conversation, the likeliest first. */
const LOOKED_INTO = 24

/** A T3 Code server that is running on this machine: where it answers, the folder it keeps its things in, and the program it is. */
export interface T3 {
  origin: string
  home: string
  program: string
}

/** The program a process is, by the name the system has for it, or nothing where it does not say. */
function programOf(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const exe = readlinkSync(`/proc/${pid}/exe`)
      // One that was replaced while it runs is named with a note that it is gone
      return exe.endsWith(' (deleted)') ? undefined : exe
    }
  } catch {}
  return undefined
}

/**
 * The T3 Code server running for this person on this machine, or nothing. T3 Code notes where
 * its server is in the folder it keeps its things in, which is `~/.t3` unless `T3CODE_HOME`
 * names another. Only a server that answers on this machine itself is ever asked anything.
 */
export function t3Server(home = process.env.T3CODE_HOME || path.join(os.homedir(), '.t3')): T3 | undefined {
  const noted = readJson<{ pid?: unknown; origin?: unknown }>(path.join(home, 'userdata', 'server-runtime.json'))
  if (!noted || typeof noted.pid !== 'number' || typeof noted.origin !== 'string') return undefined
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(noted.origin)) return undefined
  try {
    process.kill(noted.pid, 0)
  } catch {
    return undefined
  }
  // Its own program where the system names it and it is T3 Code's, and otherwise the one the person's PATH has
  const program = programOf(noted.pid)
  return { origin: noted.origin, home, program: program && /^t3(\.exe)?$/i.test(path.basename(program)) ? program : 't3' }
}

/** The session T3 Code issued to It, for as long as it lasts. Never written down. */
let session: { home: string; token: string; until: number } | undefined

/** Asks T3 Code's own command for a session that may read threads and send to them. Nothing where it gave none. */
function issued(t3: T3): Promise<string | undefined> {
  if (session && session.home === t3.home && Date.now() < session.until - 60_000) return Promise.resolve(session.token)
  return new Promise((resolve) => {
    execFile(
      t3.program,
      [
        'auth',
        'session',
        'issue',
        '--base-dir',
        t3.home,
        '--scope',
        'orchestration:read',
        '--scope',
        'orchestration:operate',
        '--ttl',
        '12h',
        '--label',
        'It',
        '--json',
      ],
      { timeout: ANSWER_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(undefined)
        try {
          const said = JSON.parse(String(stdout)) as { token?: unknown; expiresAt?: unknown }
          if (typeof said.token !== 'string' || !said.token) return resolve(undefined)
          const until = typeof said.expiresAt === 'string' ? Date.parse(said.expiresAt) : Number.NaN
          session = { home: t3.home, token: said.token, until: Number.isFinite(until) ? until : Date.now() + 3_600_000 }
          resolve(said.token)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}

/** Asks the server one thing over HTTP, as It's session. Nothing where it could not be asked or refused. */
async function ask<T>(t3: T3, method: 'GET' | 'POST', pathname: string): Promise<T | undefined> {
  for (let tried = 0; tried < 2; tried++) {
    const token = await issued(t3)
    if (!token) return undefined
    try {
      const answer = await fetch(`${t3.origin}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': PROTOCOL },
        signal: AbortSignal.timeout(ANSWER_MS),
      })
      // A session the server no longer knows (it was started anew, or the session was revoked) is asked for afresh, once
      if (answer.status === 401 && tried === 0) {
        session = undefined
        continue
      }
      if (!answer.ok) return undefined
      return (await answer.json()) as T
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The agent app's name for itself in T3 Code, where It knows it. Only how likely a thread is goes by this. */
const DRIVER: Record<string, string> = { 'claude-code': 'claudeAgent', codex: 'codex' }

interface ShellThread {
  id?: unknown
  projectId?: unknown
  providerInstanceId?: unknown
  worktreePath?: unknown
  updatedAt?: unknown
  deletedAt?: unknown
  archivedAt?: unknown
}

/**
 * The threads of a list that a conversation may be, the likeliest first: those of a project
 * the conversation's folder is in, then those run by the same agent app, and among equals the
 * one that changed last. A thread that was archived or deleted is none of them.
 */
export function likeliest(shell: { threads?: unknown; projects?: unknown }, of: { harness: string; cwd?: string }, most = LOOKED_INTO): string[] {
  const roots = new Map<string, string>()
  for (const p of Array.isArray(shell.projects) ? (shell.projects as { id?: unknown; workspaceRoot?: unknown }[]) : [])
    if (typeof p?.id === 'string' && typeof p.workspaceRoot === 'string') roots.set(p.id, p.workspaceRoot)
  // Windows takes either stroke between the parts of a folder's name, and T3 Code and an agent app need not write the same one
  const strokes = process.platform === 'win32' ? ['\\', '/'] : [path.sep]
  const within = (root: unknown) =>
    typeof root === 'string' &&
    root !== '' &&
    of.cwd !== undefined &&
    (of.cwd === root || (of.cwd.startsWith(root) && (strokes.some((s) => root.endsWith(s)) || strokes.includes(of.cwd[root.length]!))))
  return (Array.isArray(shell.threads) ? (shell.threads as ShellThread[]) : [])
    .filter((t): t is ShellThread & { id: string } => typeof t?.id === 'string' && !t.deletedAt && !t.archivedAt)
    .map((t) => ({
      id: t.id,
      score:
        (within(t.worktreePath) || within(roots.get(String(t.projectId))) ? 2 : 0) +
        (DRIVER[of.harness] !== undefined && t.providerInstanceId === DRIVER[of.harness] ? 1 : 0),
      at: typeof t.updatedAt === 'string' ? Date.parse(t.updatedAt) || 0 : 0,
    }))
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, most)
    .map((t) => t.id)
}

/** Whether what T3 Code says of a thread names one of these ids as the id its agent app gave the conversation. */
export function holds(snapshot: unknown, ids: readonly string[]): boolean {
  const threads = (snapshot as { projection?: { providerThreads?: unknown } } | null)?.projection?.providerThreads
  return (
    Array.isArray(threads) &&
    threads.some((p) => {
      const id = (p as { nativeThreadRef?: { nativeId?: unknown } } | null)?.nativeThreadRef?.nativeId
      return typeof id === 'string' && ids.includes(id)
    })
  )
}

/**
 * The thread of T3 Code that a conversation is held in: its id, null where T3 Code has no
 * thread of it, and nothing where T3 Code could not be asked. `ids` are the ids the agent app
 * has given the conversation, of which the thread carries the one it resumes from.
 */
export async function t3ThreadOf(t3: T3, of: { harness: string; ids: readonly string[]; cwd?: string }): Promise<string | null | undefined> {
  const shell = await ask<{ threads?: unknown; projects?: unknown }>(t3, 'GET', '/api/orchestration/shell')
  if (!shell || !Array.isArray(shell.threads)) return undefined
  for (const id of likeliest(shell, of)) {
    const snapshot = await ask<unknown>(t3, 'GET', `/api/orchestration/threads/${encodeURIComponent(id)}/bounded`)
    // One thread that cannot be read says nothing of the others
    if (snapshot !== undefined && holds(snapshot, of.ids)) return id
  }
  return null
}

/**
 * Puts a message to a thread, as a person typing into it does: T3 Code starts a turn there, or
 * keeps the message for when the turn that is running is over. Null once T3 Code has taken it,
 * and otherwise why it did not, in words that hold nothing of the message.
 */
export async function t3Send(t3: T3, thread: string, text: string): Promise<string | null> {
  const got = await ask<{ ticket?: unknown }>(t3, 'POST', '/api/auth/websocket-ticket')
  if (!got || typeof got.ticket !== 'string') return 'T3 Code did not let It in'
  const at = new URL(`${t3.origin.replace(/^http/, 'ws')}/ws`)
  at.searchParams.set('wsTicket', got.ticket)
  at.searchParams.set('orchestrationProtocol', PROTOCOL)
  return new Promise((resolve) => {
    let socket: WebSocket
    let done = false
    const end = (why: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(why)
    }
    const timer = setTimeout(() => end('T3 Code did not answer in time'), ANSWER_MS)
    try {
      socket = new WebSocket(at)
    } catch {
      return end('T3 Code could not be reached')
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'orchestration.dispatchCommand',
          payload: {
            type: 'message.dispatch',
            createdBy: 'agent',
            creationSource: 'mcp',
            commandId: randomUUID(),
            threadId: thread,
            messageId: randomUUID(),
            text,
            attachments: [],
            deliveryIntent: 'auto',
            dispatchMode: { type: 'start_immediately' },
          },
          headers: [],
        }),
      )
    socket.onerror = () => end('T3 Code could not be reached')
    socket.onclose = () => end('T3 Code closed the connection before it answered')
    socket.onmessage = (message) => {
      let frames: unknown[]
      try {
        frames = [JSON.parse(String(message.data))].flat()
      } catch {
        return
      }
      for (const frame of frames as { _tag?: string; requestId?: string; exit?: { _tag?: string } }[]) {
        if (frame?._tag === 'Ping') socket.send(JSON.stringify({ _tag: 'Pong' }))
        else if (frame?._tag === 'Defect') end('T3 Code failed at the message')
        else if (frame?._tag === 'Exit' && frame.requestId === '1') end(frame.exit?._tag === 'Success' ? null : 'T3 Code refused the message')
      }
    }
  })
}
