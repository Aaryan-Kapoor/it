// A project agent's program, against stand-ins for Claude Code's print mode and Codex's app
// server that speak each one's JSON lines: started in its folder with the words and marks It
// gives it, a turn at a time, resumed by its conversation's id, told nothing it may not be told,
// and ended with everything it started.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AGENT_NOTE, type AgentSession, ClaudeSession, CodexSession, claudeArgv, codexArgv, type Launch } from './src/agent-session'
import { processes } from './src/wake'
import { CLAUDE, CODEX } from './stand-in-agents'

let dir: string
let folder: string
const sessions: AgentSession[] = []
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-asess-')))
  folder = path.join(dir, 'garden')
  mkdirSync(folder)
  for (const [name, body] of [
    ['claude.js', CLAUDE],
    ['codex.js', CODEX],
  ] as const) {
    writeFileSync(path.join(dir, name), body)
    chmodSync(path.join(dir, name), 0o755)
  }
})
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.end()
  rmSync(dir, { recursive: true, force: true })
})

/** What a session said, as it said it. */
function heard() {
  const said: { idle: [string | null, string | null][]; sessions: string[]; exited: [string, string | null][] } = { idle: [], sessions: [], exited: [] }
  let wake: () => void = () => {}
  return {
    said,
    next: () => new Promise<void>((resolve) => (wake = resolve)),
    on: {
      session: (id: string) => said.sessions.push(id),
      idle: (text: string | null, failed: string | null) => {
        said.idle.push([text, failed])
        wake()
      },
      exited: (why: string, words: string | null) => {
        said.exited.push([why, words])
        wake()
      },
    },
  }
}

const launch = (app: string, extra: Partial<Launch> = {}): Launch => ({
  app,
  folder,
  session: app === 'claude-code' ? '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11' : null,
  resume: false,
  env: { ...process.env, SEEN: path.join(dir, `${app}.seen`) },
  itHome: path.join(dir, 'it-home'),
  itAt: ['/home/sam/.it/bin/it'],
  run: 'run-0123456789',
  command: [process.execPath, path.join(dir, app === 'claude-code' ? 'claude.js' : 'codex.js')],
  ...extra,
})
const seen = (app: string) => JSON.parse(readFileSync(path.join(dir, `${app}.seen`), 'utf8'))
/** Waits a little for a stand-in to have written down what it was sent. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20))
}

describe('Claude Code in print mode, as a project agent', () => {
  test('is started in its folder with its conversation, the note, edits and `it` allowed, and its marks', () => {
    const fresh = claudeArgv({ session: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11', resume: false, itAt: ['/home/sam/.it/bin/it', 'has space/it'] })
    expect(fresh).toEqual([
      'claude',
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--session-id',
      '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
      AGENT_NOTE,
      '--allowedTools',
      'Bash(it:*)',
      'Bash(/home/sam/.it/bin/it:*)',
    ])
    expect(claudeArgv({ session: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11', resume: true, itAt: [] })).toContain('--resume')
    // Nothing but a conversation id Claude Code would make is put on its command line
    expect(() => claudeArgv({ session: '--dangerously-skip-permissions', resume: true, itAt: [] })).toThrow(/UUID/)
  })

  test('takes a turn at a time, says what the agent said, and is noted before it is given anything', async () => {
    const h = heard()
    const noted: number[] = []
    const s = new ClaudeSession(launch('claude-code', { began: (pid) => noted.push(pid) }), h.on)
    sessions.push(s)
    await s.start()
    expect(noted).toEqual([s.pid])
    const turn = h.next()
    await s.send('tidy the beds')
    expect(s.busy).toBe(true)
    await turn
    expect([s.busy, h.said.idle]).toEqual([false, [['heard: tidy the beds', null]]])
    const ran = seen('claude-code')
    expect(ran.cwd).toBe(folder)
    expect(ran.env).toEqual({ IT_RUN: 'run-0123456789', IT_SESSION: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11', IT_HARNESS: 'claude-code', PWD: folder })
    const failing = h.next()
    await s.send('fail')
    await failing
    expect(h.said.idle.at(-1)).toEqual([null, 'API Error: overloaded'])
  })

  test('is not started where it cannot be noted down', async () => {
    const h = heard()
    const s = new ClaudeSession(
      launch('claude-code', {
        began: () => {
          throw new Error('the disk is full')
        },
      }),
      h.on,
    )
    sessions.push(s)
    await expect(s.start()).rejects.toThrow(/could not be noted down/)
    expect(s.alive).toBe(false)
  })

  test('says why where it ends by itself, with its last line', async () => {
    const h = heard()
    const s = new ClaudeSession(launch('claude-code'), h.on)
    sessions.push(s)
    await s.start()
    const ended = h.next()
    await s.send('crash')
    await ended
    expect(h.said.exited).toEqual([['Claude Code ended by itself, with 3', 'error: the model could not be reached']])
    await expect(s.send('more')).rejects.toThrow(/not running/)
  })

  test.skipIf(process.platform === 'win32')('is ended with what it started', async () => {
    const h = heard()
    const s = new ClaudeSession(launch('claude-code'), h.on)
    await s.start()
    const turn = h.next()
    await s.send('leave something')
    await turn
    const left = Number(readFileSync(path.join(dir, 'claude-code.seen.left'), 'utf8'))
    expect(processes([left])?.has(left)).toBe(true)
    const pid = s.pid!
    // `unknown` where some process of this user could not be read while it looked, which a busy machine has now and then
    expect(['ended', 'unknown']).toContain(await s.end())
    expect([processes([left])?.has(left), processes([pid])?.has(pid)]).toEqual([false, false])
    // And says nothing of having ended by itself
    expect(h.said.exited).toEqual([])
  })

  test('is not found, and says so, where the app is not there', async () => {
    const s = new ClaudeSession(launch('claude-code', { command: [path.join(dir, 'no-such-claude')] }), heard().on)
    await expect(s.start()).rejects.toThrow(/Claude Code was not found/)
  })
})

describe('Codex’s app server, as a project agent', () => {
  test('is started in its sandbox for a workspace, with It’s folder open to it and no asking', () => {
    expect(codexArgv({ itHome: '/home/sam/.it' })).toEqual([
      'codex',
      'app-server',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'sandbox_workspace_write.writable_roots=["/home/sam/.it"]',
    ])
  })

  test('opens a thread in its folder, takes a turn, and declines what nobody is there to approve', async () => {
    const h = heard()
    const s = new CodexSession(launch('codex'), h.on)
    sessions.push(s)
    await s.start()
    expect([s.session, h.said.sessions]).toEqual(['thread-made-1', ['thread-made-1']])
    const turn = h.next()
    await s.send('water the beans')
    await turn
    // What another thread said is not this one's
    expect(h.said.idle).toEqual([['did: water the beans', null]])
    await until(() => seen('codex').answered.length >= 2)
    const ran = seen('codex')
    expect(ran.asked.map((a: { method: string }) => a.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(ran.asked[2].params).toEqual({ cwd: folder, developerInstructions: AGENT_NOTE })
    expect(ran.asked[3].params).toEqual({ threadId: 'thread-made-1', input: [{ type: 'text', text: 'water the beans', text_elements: [] }] })
    expect(ran.answered).toEqual([
      { id: 'ask-1', result: { decision: 'decline' } },
      { id: 'ask-2', error: { code: -32601, message: 'Nobody is watching this agent to answer that.' } },
    ])
    const failing = h.next()
    await s.send('fail')
    await failing
    expect(h.said.idle.at(-1)).toEqual([null, 'stream disconnected'])
  })

  test('resumes the thread it is given, and says why where Codex cannot', async () => {
    const h = heard()
    const s = new CodexSession(launch('codex', { session: 'thread-old-7', resume: true }), h.on)
    sessions.push(s)
    await s.start()
    expect(s.session).toBe('thread-old-7')
    expect(h.said.sessions).toEqual([])
    expect(seen('codex').asked[2]).toEqual({ method: 'thread/resume', params: { threadId: 'thread-old-7', cwd: folder, developerInstructions: AGENT_NOTE } })
    const lost = new CodexSession(launch('codex', { session: 'thread-lost', resume: true }), heard().on)
    sessions.push(lost)
    await expect(lost.start()).rejects.toThrow(/no rollout found/)
  })

  test('ends when its input is closed', async () => {
    const s = new CodexSession(launch('codex'), heard().on)
    await s.start()
    const pid = s.pid!
    // `unknown` where some process of this user could not be read while it looked, which a busy machine has now and then
    expect(['ended', 'gone', 'unknown']).toContain(await s.end())
    expect(processes([pid])?.has(pid)).toBe(false)
    expect(existsSync(path.join(dir, 'codex.seen'))).toBe(true)
  })
})
