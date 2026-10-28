// One project agent's program, kept open from turn to turn: the agent app's own interface for
// that, started in the agent's folder, given what the person sends it a turn at a time, and
// ended with everything it started. Claude Code is run in its print mode, written to and read
// as a stream of JSON, which keeps the conversation open for as long as its input is. Codex is
// run as its app server, which holds a thread and takes turns on it. Either is resumed by the
// conversation's id where there is one. What either may do with nobody there is what Auto-wake
// gives a conversation it reopens (see `carrying` in wake.ts): edits in its own folder, `it`,
// and whatever the person's own settings for the app allow without asking.
import { type ChildProcess, spawn } from 'node:child_process'
import { AGENT_APPS } from '@it/protocol'
import { endTree, identity, lastWords, SINCE_TOLD } from './wake'

/**
 * What an agent It starts is told, beside its app's own instructions: where its messages come
 * from, where the person sees what it does, and that nobody is there to approve anything.
 */
export const AGENT_NOTE =
  'It started this conversation for the person, from It’s site, in this project’s folder, and keeps it open. Nobody is watching it as it runs. What the person sends you comes from It’s site, and what they do on a page of yours comes as an action, the same as anywhere else. They see the last thing you say at the end of each turn on the site, and they see your pages: show your work on a page with `it` where they are to look at it, use it or decide on it, and answer in a few sentences otherwise. Nobody can answer a question or approve anything while you work, so what your settings do not allow is refused: say on the site or on a page what you could not do, and leave it for them. Run `it` by that name alone: it is on your PATH.'

/** What a session says as it goes. */
export interface SessionEvents {
  /** The conversation the app made or resumed, as soon as it says which. */
  session(id: string): void
  /** A turn has ended, with the last thing the agent said in it, and why where the turn failed. */
  idle(said: string | null, failed: string | null): void
  /** The program ended without being asked to, with why in this program's own words, and its last line where it printed one. */
  exited(why: string, words: string | null): void
}

/** What a session is started with. */
export interface Launch {
  app: string
  folder: string
  /** The conversation to resume, or, for Claude Code, the id a new one is to have. Codex names a new thread itself. */
  session: string | null
  resume: boolean
  env: NodeJS.ProcessEnv
  /** It's folder, which Codex's sandbox is to let `it` write. */
  itHome: string
  /** Where `it` is installed, for Claude Code to be let run it by its whole path too. */
  itAt: string[]
  /** This run's own name, carried by everything it starts, by which what it left can be found and ended. */
  run: string
  /** The words that start the app, where they are not its own name: a test's stand-in, or Codex's program on a system where it needs more than its name. */
  command?: string[]
  /** Told which process it is, to write down, before it is given anything. Where that throws, it is ended having done nothing. */
  began?: (pid: number, since: string) => void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
/** Claude Code's way to allow `it` by its name, and by each place it is installed. */
const itAllowed = (itAt: string[]) => ['Bash(it:*)', ...itAt.filter((p) => /^[^\s()*]+$/.test(p)).map((p) => `Bash(${p}:*)`)]

/** The words Claude Code is started with: print mode, read and written as JSON lines, in the conversation named, which is a new one where it is not resumed. */
export function claudeArgv(l: Pick<Launch, 'session' | 'resume' | 'itAt' | 'command'>): string[] {
  if (!l.session || !UUID.test(l.session)) throw new Error('a Claude Code conversation is named by a UUID')
  return [
    ...(l.command ?? ['claude']),
    '--print',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    ...(l.resume ? ['--resume', l.session] : ['--session-id', l.session]),
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    AGENT_NOTE,
    // Last, since it takes every word after it
    '--allowedTools',
    ...itAllowed(l.itAt),
  ]
}

/** The words Codex's app server is started with: its sandbox for a workspace, with the network and It's folder open to it, and no asking. */
export function codexArgv(l: Pick<Launch, 'itHome' | 'command'>): string[] {
  return [
    ...(l.command ?? ['codex']),
    'app-server',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(l.itHome)}]`,
  ]
}

/** The most a line of what an app prints is let grow to before it is passed over. */
const LINE_MOST = 32 * 1024 * 1024

/** A program that holds one conversation open. */
export abstract class AgentSession {
  protected child: ChildProcess | null = null
  protected since: string | undefined
  /** The conversation, once known. */
  session: string | null
  /** Whether a turn is running. */
  busy = false
  /** Whether it is being ended, at someone's asking. */
  protected ending = false
  private over = false
  private exitedAt: Promise<void> | null = null
  private errTail = ''
  private outBuffer = ''
  private skipping = false

  constructor(
    protected readonly l: Launch,
    protected readonly on: SessionEvents,
  ) {
    this.session = l.session
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  protected abstract argv(): string[]
  protected abstract line(row: unknown): void
  /** What is done once the program is there and noted, before anything is sent. Resolves once it can take a turn. */
  protected abstract ready(): Promise<void>
  /** Hands the app a turn's message. */
  protected abstract give(text: string): Promise<void>

  /** Starts the program. Resolves once it can take a turn, and rejects with why where it cannot. */
  async start(): Promise<void> {
    const argv = this.argv()
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: this.l.folder,
      env: {
        ...Object.fromEntries(Object.entries(this.l.env).filter(([k]) => k !== 'OLDPWD')),
        // The folder is said here too: an app that believes PWD over the folder it is in would hold the conversation elsewhere
        PWD: this.l.folder,
        IT_RUN: this.l.run,
        // Claude Code's conversation is known before it starts, and is said the way any add-on says it. Codex names its own, and says it to what it runs
        ...(this.l.app === 'claude-code' && this.session ? { IT_HARNESS: 'claude-code', IT_SESSION: this.session } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // In a group of its own, so that ending it ends what it started
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.exitedAt = new Promise((resolve) => child.once('exit', () => resolve()))
    const failedToStart = new Promise<never>((_, reject) =>
      child.once('error', (err) =>
        reject(
          new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${appName(this.l.app)} was not found` : `${appName(this.l.app)} could not be started`),
        ),
      ),
    )
    failedToStart.catch(() => {})
    child.stdin?.on('error', () => {})
    child.stderr?.on('data', (piece: Buffer) => {
      this.errTail = (this.errTail + piece.toString('utf8')).slice(-4096)
    })
    child.stdout?.on('data', (piece: Buffer) => this.read(piece.toString('utf8')))
    child.once('exit', (code, signal) => {
      this.over = true
      this.busy = false
      if (this.ending) return
      this.on.exited(`${appName(this.l.app)} ended by itself, with ${signal ?? code ?? 'an error'}`, lastWords(this.errTail))
    })
    if (!child.pid) {
      await failedToStart
      throw new Error(`${appName(this.l.app)} could not be started`)
    }
    // Which process it is, captured while it is surely this one, and written down before it is given anything
    this.since = identity([child.pid]).get(child.pid)
    try {
      if (this.since === undefined) throw new Error('which process it is could not be told')
      this.l.began?.(child.pid, this.since)
    } catch (err) {
      await this.end()
      throw new Error(
        `${appName(this.l.app)} was started and could not be noted down, so it was ended before it was given anything (${(err as Error).message})`,
      )
    }
    const gone = this.exitedAt.then(() => {
      throw new Error(lastWords(this.errTail) ?? `${appName(this.l.app)} ended as it started`)
    })
    gone.catch(() => {})
    await Promise.race([this.ready(), failedToStart, gone])
  }

  /** Begins a turn with a message. Rejects where the program is not there to take it. */
  async send(text: string): Promise<void> {
    if (this.over || this.ending || !this.child) throw new Error(`${appName(this.l.app)} is not running`)
    this.busy = true
    try {
      await this.give(text)
    } catch (err) {
      this.busy = false
      throw err
    }
  }

  /** Whether the program is still there. */
  get alive(): boolean {
    return this.child !== null && !this.over
  }

  protected write(row: unknown): void {
    if (!this.child?.stdin || this.over) throw new Error(`${appName(this.l.app)} is not running`)
    this.child.stdin.write(`${JSON.stringify(row)}\n`)
  }

  private read(text: string): void {
    this.outBuffer += text
    for (;;) {
      const at = this.outBuffer.indexOf('\n')
      if (at === -1) break
      const one = this.outBuffer.slice(0, at)
      this.outBuffer = this.outBuffer.slice(at + 1)
      if (this.skipping) {
        this.skipping = false
        continue
      }
      if (!one.trim()) continue
      let row: unknown
      try {
        row = JSON.parse(one)
      } catch {
        continue
      }
      try {
        this.line(row)
      } catch {}
    }
    // A line longer than any It reads is let go of, up to where it ends
    if (this.outBuffer.length > LINE_MOST) {
      this.outBuffer = ''
      this.skipping = true
    }
  }

  /**
   * Ends the program and everything it started: its input is closed first, which each app takes
   * as its word to finish, and then whatever is left is asked to end and, a few seconds later,
   * made to. Answers as `endTree` does: `unknown` where something of it may still be there.
   */
  async end(): Promise<'ended' | 'gone' | 'unknown'> {
    this.ending = true
    const child = this.child
    if (!child?.pid) return 'gone'
    try {
      child.stdin?.end()
    } catch {}
    if (!this.over) await Promise.race([this.exitedAt, new Promise((r) => setTimeout(r, 2000))])
    if (process.platform === 'win32') {
      if (!this.over) child.kill()
      return 'unknown'
    }
    if (this.since === undefined) return 'unknown'
    return endTree(child.pid, this.since, { harness: this.l.app, session: this.session ?? '', run: this.l.run, told: SINCE_TOLD })
  }
}

/** Claude Code in print mode, read and written as JSON lines: one long-lived program, a user message a turn. */
export class ClaudeSession extends AgentSession {
  private said: string | null = null
  protected argv() {
    return claudeArgv(this.l)
  }
  protected async ready(): Promise<void> {
    // Claude Code says nothing until it is given its first message, and the conversation is the one it was started with
  }
  protected async give(text: string): Promise<void> {
    this.said = null
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  }
  protected line(row: unknown): void {
    const r = row as { type?: unknown; subtype?: unknown; session_id?: unknown; message?: { content?: unknown }; result?: unknown; is_error?: unknown }
    if (typeof r.session_id === 'string' && UUID.test(r.session_id) && r.session_id !== this.session) {
      this.session = r.session_id
      this.on.session(r.session_id)
    }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const text = (r.message.content as { type?: unknown; text?: unknown }[])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
        .trim()
      if (text) this.said = text
    }
    if (r.type === 'result') {
      this.busy = false
      const said = typeof r.result === 'string' && r.result.trim() ? r.result.trim() : this.said
      this.on.idle(r.is_error === true ? null : said, r.is_error === true ? (lastWords(String(r.result ?? '')) ?? 'its turn ended with an error') : null)
    }
  }
}

/** Codex's app server, spoken to in JSON lines: one long-lived program holding one thread, a turn at a time. */
export class CodexSession extends AgentSession {
  private next = 1
  private asked = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private said: string | null = null
  private turn: string | null = null
  protected argv() {
    return codexArgv(this.l)
  }
  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.asked.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        this.write({ id, method, params })
      } catch (err) {
        this.asked.delete(id)
        reject(err as Error)
      }
    })
  }
  protected async ready(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'it', title: 'It', version: '1' }, capabilities: null })
    this.write({ method: 'initialized' })
    const opened = await this.request<{ thread?: { id?: unknown } }>(
      this.l.resume ? 'thread/resume' : 'thread/start',
      this.l.resume
        ? { threadId: this.session, cwd: this.l.folder, developerInstructions: AGENT_NOTE }
        : { cwd: this.l.folder, developerInstructions: AGENT_NOTE },
    )
    const id = opened?.thread?.id
    if (typeof id !== 'string' || !THREAD.test(id)) throw new Error('Codex did not say which thread it opened')
    if (id !== this.session) {
      this.session = id
      this.on.session(id)
    }
  }
  protected async give(text: string): Promise<void> {
    this.said = null
    const started = await this.request<{ turn?: { id?: unknown } }>('turn/start', {
      threadId: this.session,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    this.turn = typeof started?.turn?.id === 'string' ? started.turn.id : null
  }
  protected line(row: unknown): void {
    const r = row as { id?: unknown; method?: unknown; params?: any; result?: unknown; error?: { message?: unknown } }
    // An answer to something asked
    if (typeof r.id === 'number' && r.method === undefined) {
      const waiting = this.asked.get(r.id)
      if (!waiting) return
      this.asked.delete(r.id)
      if (r.error) waiting.reject(new Error(lastWords(String(r.error.message ?? '')) ?? 'Codex refused'))
      else waiting.resolve(r.result)
      return
    }
    // Something Codex asks: nobody is there to approve anything, so what would need it is declined
    if (r.id !== undefined && typeof r.method === 'string') {
      const nobody = 'Nobody is watching this agent to answer that.'
      this.write(
        r.method === 'item/commandExecution/requestApproval' || r.method === 'item/fileChange/requestApproval'
          ? { id: r.id, result: { decision: 'decline' } }
          : r.method === 'applyPatchApproval' || r.method === 'execCommandApproval'
            ? { id: r.id, result: { decision: { denied: { rejection: nobody } } } }
            : { id: r.id, error: { code: -32601, message: nobody } },
      )
      return
    }
    if (r.params?.threadId !== undefined && r.params.threadId !== this.session) return
    if (r.method === 'item/completed' && r.params?.item?.type === 'agentMessage' && typeof r.params.item.text === 'string') {
      if (r.params.item.text.trim()) this.said = r.params.item.text.trim()
    }
    if (r.method === 'turn/started') this.busy = true
    if (r.method === 'turn/completed') {
      this.busy = false
      this.turn = null
      const turn = r.params?.turn as { status?: unknown; error?: { message?: unknown } | null } | undefined
      const failed = turn?.status === 'failed' ? (lastWords(String(turn.error?.message ?? '')) ?? 'its turn failed') : null
      this.on.idle(failed ? null : this.said, failed)
    }
  }
}

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
export const appName = (app: string) => NAMES[app] ?? app

/** The session for an app, or null for one It does not start agents with. */
export function sessionFor(l: Launch, on: SessionEvents): AgentSession | null {
  if (!(AGENT_APPS as readonly string[]).includes(l.app)) return null
  return l.app === 'claude-code' ? new ClaudeSession(l, on) : new CodexSession(l, on)
}
