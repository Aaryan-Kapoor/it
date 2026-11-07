// Which app holds a conversation, as It reads it from what an app sets for a command and from
// what Claude Code writes of a conversation, and whether the program that held it has gone.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { heldBy, heldHere, heldNow, holderGone, holderHere, together } from './src/hosts'
import { conversationHeld, conversationHolder, conversationsFile, noteConversation } from './src/publish'
import { claudeEntrypoints } from './src/wake'

let scratch: string
let before: string | undefined
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-hosts-'))
  before = process.env.IT_HOME
  process.env.IT_HOME = path.join(scratch, 'home')
  mkdirSync(process.env.IT_HOME)
})
afterEach(() => {
  if (before === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = before
  rmSync(scratch, { recursive: true, force: true })
})

describe('where a conversation is held, by what Claude Code wrote in it', () => {
  test('one that any app It knows has held is that app’s, however it was run since, and It’s own runs never make it a terminal’s', () => {
    // Seen on a real machine: T3 Code held it, and Auto-wake then reopened it outside T3 Code
    expect(heldBy(['t3-code', 'sdk-cli'])).toEqual({ by: 't3-code' })
    // Begun in an app that embeds Claude Code, and then taken up by T3 Code, or by the desktop app
    expect(heldBy(['sdk-ts', 't3-code'])).toEqual({ by: 't3-code' })
    expect(heldBy(['sdk-ts', 'claude-desktop'])).toEqual({ by: 'claude-desktop' })
    // The desktop app's agent mode is the desktop app
    expect(heldBy(['local-agent'])).toEqual({ by: 'claude-desktop' })
    expect(heldBy(['cli', 'claude-desktop', 'cli'])).toEqual({ by: 'claude-desktop' })
    // Of two apps It knows, the one that held it last
    expect(heldBy(['t3-code', 'claude-desktop'])).toEqual({ by: 'claude-desktop' })
  })

  test('one that an app It does not know has held waits for that app, and only one that nothing but a terminal held is held by no app', () => {
    expect(heldBy(['sdk-ts'])).toEqual({ by: 'host', entrypoint: 'sdk-ts' })
    expect(heldBy(['cli', 'claude-vscode', 'sdk-cli'])).toEqual({ by: 'host', entrypoint: 'claude-vscode' })
    expect(heldBy(['cli', 'sdk-cli'])).toEqual({ by: 'terminal' })
    expect(heldBy(['sdk-cli'])).toEqual({ by: 'terminal' })
    expect(heldBy([])).toBeUndefined()
    // Words that are no entrypoint are passed over
    expect(heldBy(['cli', 'a b', ''])).toEqual({ by: 'terminal' })
  })

  test('is read from the conversation’s file, only what was written since being read the next time, and a tool’s words are not taken for the line’s own', () => {
    const config = path.join(scratch, 'claude')
    const id = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'
    const dir = path.join(config, 'projects', '-home-someone-board')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.jsonl`)
    const row = (entrypoint: string, over: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' }, ...over, entrypoint, sessionId: id })}\n`
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toBeNull()
    writeFileSync(file, row('sdk-ts') + row('sdk-ts'))
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toEqual(['sdk-ts'])
    // A line that was half written when it was read is read whole once it is
    const next = row('t3-code')
    appendFileSync(file, next.slice(0, 20))
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toEqual(['sdk-ts'])
    appendFileSync(file, next.slice(20))
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toEqual(['sdk-ts', 't3-code'])
    // A tool's output that holds such words as an object of its own is not the line's entrypoint
    appendFileSync(file, row('sdk-cli', { toolUseResult: { entrypoint: 'claude-desktop' } }))
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toEqual(['sdk-ts', 't3-code', 'sdk-cli'])
    expect(heldBy(claudeEntrypoints(id, '/home/someone/board', config)!)).toEqual({ by: 't3-code' })
    // A file put in its place is read from its start
    rmSync(file)
    writeFileSync(file, row('cli'))
    expect(claudeEntrypoints(id, '/home/someone/board', config)).toEqual(['cli'])
    expect(readFileSync(file, 'utf8')).toContain('"cli"')
  })
})

describe('where a conversation is held, by what its app sets for the commands it runs', () => {
  test('T3 Code names its thread for the Claude Code and the Codex it runs, and the thread is known from the first page', () => {
    expect(heldHere('claude-code', { T3CODE_THREAD_ID: 'thread-a', CLAUDE_CODE_ENTRYPOINT: 't3-code' })).toEqual({ by: 't3-code', thread: 'thread-a' })
    expect(heldHere('codex', { T3CODE_THREAD_ID: 'thread-b', CODEX_THREAD_ID: 'c' })).toEqual({ by: 't3-code', thread: 'thread-b' })
    // An older T3 Code that names no thread is T3 Code all the same, for Claude Code
    expect(heldHere('claude-code', { CLAUDE_CODE_ENTRYPOINT: 't3-code' })).toEqual({ by: 't3-code' })
    expect(heldHere('claude-code', { T3CODE_THREAD_ID: 'two\nlines', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toEqual({ by: 'terminal' })
  })

  test('Claude Code’s entrypoint says which app runs it, and what an app It does not know runs waits for that app', () => {
    expect(heldHere('claude-code', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toEqual({ by: 'claude-desktop' })
    expect(heldHere('claude-code', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toEqual({ by: 'host', entrypoint: 'sdk-ts' })
    expect(heldHere('claude-code', { CLAUDE_CODE_ENTRYPOINT: 'cli' })).toEqual({ by: 'terminal' })
    expect(heldHere('claude-code', {})).toBeUndefined()
    expect(heldHere('codex', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toBeUndefined()
    expect(heldHere('pi', { T3CODE_THREAD_ID: 'thread-a' })).toBeUndefined()
  })

  test('of what is known, an app tells more than none, an app It knows more than one it does not, and a thread more than none', () => {
    expect(together({ by: 'terminal' }, { by: 't3-code' })).toEqual({ by: 't3-code' })
    expect(together({ by: 't3-code' }, { by: 't3-code', thread: 't' })).toEqual({ by: 't3-code', thread: 't' })
    expect(together({ by: 't3-code', thread: 'new' }, { by: 't3-code', thread: 'old' })).toEqual({ by: 't3-code', thread: 'new' })
    expect(together({ by: 'host', entrypoint: 'sdk-ts' }, { by: 'claude-desktop' })).toEqual({ by: 'claude-desktop' })
    expect(together(undefined, undefined)).toBeUndefined()
  })
})

describe('the program that holds a Claude Code conversation', () => {
  const program = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    return { child, gone: new Promise<void>((resolve) => child.on('exit', () => resolve())) }
  }

  test('is the Claude Code process the conversation’s commands name, and is known to have gone once it has ended', async () => {
    const { child, gone } = program()
    try {
      const session = { harness: 'claude-code', id: 'session-1' }
      const holder = holderHere(session, { CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_PID: String(child.pid) })!
      expect(holder.pid).toBe(child.pid)
      expect(holderGone(holder)).toBe(false)
      // Another conversation's process, or none named, is not this one's
      expect(holderHere(session, { CLAUDE_CODE_SESSION_ID: 'session-2', CLAUDE_PID: String(child.pid) })).toBeUndefined()
      expect(holderHere(session, { CLAUDE_CODE_SESSION_ID: 'session-1' })).toBeUndefined()
      expect(holderHere({ harness: 'codex', id: 'session-1' }, { CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_PID: String(child.pid) })).toBeUndefined()
      child.kill()
      await gone
      expect(holderGone(holder)).toBe(true)
    } finally {
      child.kill()
    }
  })

  test('is not taken for another program that has its number: one started at another time is not the one that held the conversation', async () => {
    const { child } = program()
    try {
      const holder = holderHere({ harness: 'claude-code', id: 's' }, { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: String(child.pid) })!
      expect(holderGone(holder)).toBe(false)
      // Where the system would not say when it was started, it is believed by its number alone
      expect(holderGone({ ...holder, started: `${holder.started} and then some` })).toBe(holder.started !== '')
    } finally {
      child.kill()
    }
  })

  test('is noted with where the conversation is held when a page is made, and a later page or hook does not let an app’s hold go', async () => {
    const { child, gone } = program()
    try {
      const session = { harness: 'claude-code', id: 'held' }
      const env = { T3CODE_THREAD_ID: 'thread-a', CLAUDE_CODE_ENTRYPOINT: 't3-code', CLAUDE_CODE_SESSION_ID: 'held', CLAUDE_PID: String(child.pid) }
      await noteConversation(session, scratch, null, heldNow(session, env))
      expect(conversationHeld(session)).toEqual({ by: 't3-code', thread: 'thread-a' })
      expect(conversationHolder(session)?.holder.pid).toBe(child.pid)
      // A hook's report of the folder says neither, and keeps both
      await noteConversation(session, path.join(scratch, 'moved'), null)
      expect(conversationHeld(session)).toEqual({ by: 't3-code', thread: 'thread-a' })
      expect(conversationHolder(session)?.holder.pid).toBe(child.pid)
      // A page made later from a terminal names a new program, and T3 Code still holds the conversation
      child.kill()
      await gone
      await noteConversation(
        session,
        scratch,
        null,
        heldNow(session, { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'held', CLAUDE_PID: String(process.pid) }),
      )
      expect(conversationHeld(session)).toEqual({ by: 't3-code', thread: 'thread-a' })
      expect(conversationHolder(session)?.holder.pid).toBe(process.pid)
      expect(JSON.parse(readFileSync(conversationsFile(), 'utf8'))['claude-code:held'].held).toEqual({ by: 't3-code', thread: 'thread-a' })
    } finally {
      child.kill()
    }
  })
})
