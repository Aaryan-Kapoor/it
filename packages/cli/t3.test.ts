// What It makes of T3 Code's own account of its server and its threads: which server is asked,
// which threads are looked into first for a conversation, and which thread is the conversation's.
// The asking and the sending themselves need a T3 Code that is running, and are tried against one.
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { conversationsOf, holds, likeliest, type T3Search, t3Running, t3Server, t3ThreadOf } from './src/t3'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-t3-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the T3 Code server that is asked', () => {
  const home = (noted: unknown) => {
    const folder = mkdtempSync(path.join(scratch, 'home-'))
    mkdirSync(path.join(folder, 'userdata'), { recursive: true })
    if (noted !== undefined) writeFileSync(path.join(folder, 'userdata', 'server-runtime.json'), JSON.stringify(noted))
    return folder
  }
  test('is the one T3 Code notes in its own folder, where that program is running and answers on this machine', () => {
    const folder = home({ version: 1, pid: process.pid, host: '127.0.0.1', port: 3774, origin: 'http://127.0.0.1:3774' })
    expect(t3Server(folder)).toMatchObject({ origin: 'http://127.0.0.1:3774', home: folder })
    // The program is T3 Code's own where the system names it as that, and otherwise the one on the person's PATH: here it is the tests' runner
    expect(t3Server(folder)?.program).toBe('t3')
  })
  test('is none where T3 Code has noted nothing, where the program it noted is gone, and where what it noted is not on this machine', () => {
    expect(t3Server(home(undefined))).toBeUndefined()
    expect(t3Server(path.join(scratch, 'no-such-folder'))).toBeUndefined()
    // A number no process has
    expect(t3Server(home({ pid: 2 ** 22 + 12345, origin: 'http://127.0.0.1:3774' }))).toBeUndefined()
    for (const origin of [
      'http://10.0.0.5:3774',
      'https://t3.example.com',
      'http://127.0.0.1.evil.example:3774',
      'http://user:pass@127.0.0.1:3774',
      'http://127.0.0.1:3774/elsewhere',
    ])
      expect([origin, t3Server(home({ pid: process.pid, origin }))]).toEqual([origin, undefined])
    expect(t3Server(home({ pid: 'no number', origin: 'http://127.0.0.1:3774' }))).toBeUndefined()
    expect(t3Server(home('not what T3 Code writes'))).toBeUndefined()
  })
})

describe('the threads looked into for a conversation', () => {
  // As T3 Code lists them: each with its project, the agent app that runs it, and when it last changed
  const shell = {
    projects: [
      { id: 'site', workspaceRoot: '/home/someone/site' },
      { id: 'other', workspaceRoot: '/home/someone/other' },
    ],
    threads: [
      { id: 'old-in-project', projectId: 'site', providerInstanceId: 'claudeAgent', updatedAt: '2026-10-01T10:00:00.000Z' },
      { id: 'new-elsewhere', projectId: 'other', providerInstanceId: 'claudeAgent', updatedAt: '2026-10-08T10:00:00.000Z' },
      { id: 'new-in-project', projectId: 'site', providerInstanceId: 'claudeAgent', updatedAt: '2026-10-07T10:00:00.000Z' },
      { id: 'codex-in-project', projectId: 'site', providerInstanceId: 'codex', updatedAt: '2026-10-08T12:00:00.000Z' },
      {
        id: 'in-a-worktree',
        projectId: 'other',
        worktreePath: '/home/someone/site/pages',
        providerInstanceId: 'claudeAgent',
        updatedAt: '2026-10-02T10:00:00.000Z',
      },
      { id: 'archived', projectId: 'site', providerInstanceId: 'claudeAgent', updatedAt: '2026-10-08T13:00:00.000Z', archivedAt: '2026-10-08T14:00:00.000Z' },
      { id: 'deleted', projectId: 'site', providerInstanceId: 'claudeAgent', updatedAt: '2026-10-08T13:00:00.000Z', deletedAt: '2026-10-08T14:00:00.000Z' },
      { projectId: 'site', providerInstanceId: 'claudeAgent' },
    ],
  }
  test('are those of the project its folder is in and of its agent app first, the one that changed last before the others, and never one that was archived or deleted', () => {
    // The agent has moved into a folder inside the project, which is the folder It has noted
    expect(likeliest(shell, { harness: 'claude-code', cwd: '/home/someone/site/pages/round-two' })).toEqual([
      'new-in-project',
      'in-a-worktree',
      'old-in-project',
      'codex-in-project',
      'new-elsewhere',
    ])
    expect(likeliest(shell, { harness: 'codex', cwd: '/home/someone/site' })[0]).toBe('codex-in-project')
    // A folder that only begins as the project's does is not in it
    expect(likeliest(shell, { harness: 'claude-code', cwd: '/home/someone/site-two' })[0]).toBe('new-elsewhere')
  })
  test('are the latest of every project where the folder is not known, and no more than are asked for', () => {
    expect(likeliest(shell, { harness: 'claude-code' })).toEqual(['new-elsewhere', 'new-in-project', 'in-a-worktree', 'old-in-project', 'codex-in-project'])
    expect(likeliest(shell, { harness: 'pi' }, 2)).toEqual(['codex-in-project', 'new-elsewhere'])
    expect(likeliest({}, { harness: 'claude-code' })).toEqual([])
    expect(likeliest({ threads: 'none', projects: 3 }, { harness: 'claude-code' })).toEqual([])
  })

  test('on Windows a folder is the same folder with either stroke and in either case, and one whose name only begins alike is another', () => {
    const windows = (workspaceRoot: string) => ({
      projects: [{ id: 'site', workspaceRoot }],
      threads: [
        { id: 'in-project', projectId: 'site', providerInstanceId: 'codex', updatedAt: '2026-10-01T10:00:00.000Z' },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `newer-${i}`, projectId: 'other', providerInstanceId: 'codex', updatedAt: '2026-10-08T10:00:00.000Z' })),
      ],
    })
    const cwd = 'C:\\Users\\Jane Doe\\work\\site\\pages'
    for (const root of ['C:\\Users\\Jane Doe\\work\\site', 'C:/Users/Jane Doe/work/site', 'c:\\users\\jane doe\\work\\site', 'C:/Users/Jane Doe/work/site/'])
      expect([root, likeliest(windows(root), { harness: 'codex', cwd }, 24, 'win32')[0]]).toEqual([root, 'in-project'])
    expect(likeliest(windows('C:\\Users\\Jane Doe\\work\\si'), { harness: 'codex', cwd }, 24, 'win32')).not.toContain('in-project')
    // Elsewhere a name in another case is another folder
    expect(likeliest(windows('/home/Someone/site'), { harness: 'codex', cwd: '/home/someone/site/pages' }, 24, 'linux')).not.toContain('in-project')
  })
})

describe('the thread a conversation is held in', () => {
  // As T3 Code says of one thread: the conversation its agent app keeps for it, by the id that app gave it
  const snapshot = (nativeId: unknown) => ({
    projection: {
      providerThreads: [{ id: 'provider-thread:…', driver: 'claudeAgent', nativeThreadRef: { driver: 'claudeAgent', nativeId, strength: 'strong' } }],
    },
  })
  test('is the one whose agent conversation has one of the ids It knows the conversation by', () => {
    const id = '0873de1e-dec0-4e35-840e-b2f9cf0e0378'
    expect(holds(snapshot(id), [id])).toBe(true)
    expect(holds(snapshot(id), ['11111111-2222-4333-8444-555555555555', id])).toBe(true)
    expect(holds(snapshot(id), ['11111111-2222-4333-8444-555555555555'])).toBe(false)
    expect(holds(snapshot(id), [])).toBe(false)
  })
  test('and is not told from anything that is not what T3 Code says of a thread', () => {
    for (const not of [
      null,
      undefined,
      'a thread',
      {},
      { projection: {} },
      { projection: { providerThreads: 'none' } },
      { projection: { providerThreads: [null, {}, { nativeThreadRef: null }] } },
      snapshot(7),
    ])
      expect(holds(not, ['7', 'undefined', 'null'])).toBe(false)
  })
})

/**
 * What T3 Code says of a thread that has run Claude Code and then Codex, as its snapshot of the
 * thread has it: each conversation the thread ran, by the id its agent app gave it, and the one
 * it runs now.
 */
function switched(
  thread: string,
  conversations: { provider: string; driver: string; nativeId: string | null; owner?: string; of?: string; strength?: string }[],
  active: string | null,
) {
  return {
    projection: {
      thread: { id: thread, activeProviderThreadId: active },
      providerThreads: conversations.map((c) => ({
        id: c.provider,
        driver: c.driver,
        providerInstanceId: c.driver,
        appThreadId: c.of ?? thread,
        ownerNodeId: c.owner ?? null,
        nativeThreadRef: { driver: c.driver, nativeId: c.nativeId, strength: c.strength ?? 'strong' },
      })),
    },
  }
}

describe('the conversations a thread has run', () => {
  const claude = { provider: 'provider-thread:claude', driver: 'claudeAgent', nativeId: 'claude-conversation' }
  const codex = { provider: 'provider-thread:codex', driver: 'codex', nativeId: 'codex-conversation' }
  test('are the one it runs now, and those it ran before it was switched to another agent app', () => {
    expect(conversationsOf(switched('thread-a', [claude, codex], codex.provider), 'thread-a')).toEqual({
      now: { harness: 'codex', id: 'codex-conversation' },
      before: [{ harness: 'claude-code', id: 'claude-conversation' }],
    })
    // Switched back, the first is the one it runs, and the second is one it ran
    expect(conversationsOf(switched('thread-a', [claude, codex], claude.provider), 'thread-a')).toEqual({
      now: { harness: 'claude-code', id: 'claude-conversation' },
      before: [{ harness: 'codex', id: 'codex-conversation' }],
    })
  })
  test('are only the thread’s own: not a helper’s that one of its turns started, not another thread’s, and none whose id or agent app It cannot be sure of', () => {
    const others = [
      // A helper that a turn of the thread started has a conversation of its own
      { provider: 'provider-thread:helper', driver: 'codex', nativeId: 'helper-conversation', owner: 'node-1' },
      { provider: 'provider-thread:elsewhere', driver: 'claudeAgent', nativeId: 'another-threads-conversation', of: 'thread-b' },
      // One T3 Code has not yet been told the id of, one it only guessed, and one of an agent app It does not know
      { provider: 'provider-thread:pending', driver: 'claudeAgent', nativeId: null },
      { provider: 'provider-thread:weak', driver: 'claudeAgent', nativeId: 'a-guess', strength: 'weak' },
      { provider: 'provider-thread:opencode', driver: 'opencode', nativeId: 'opencode-conversation' },
      { provider: 'provider-thread:odd', driver: 'constructor', nativeId: 'odd-conversation' },
    ]
    expect(conversationsOf(switched('thread-a', [claude, ...others, codex], codex.provider), 'thread-a')).toEqual({
      now: { harness: 'codex', id: 'codex-conversation' },
      before: [{ harness: 'claude-code', id: 'claude-conversation' }],
    })
    // Where the thread runs one of those now, it runs none It knows
    for (const active of others) expect(conversationsOf(switched('thread-a', [claude, ...others], active.provider), 'thread-a').now).toBeNull()
    expect(conversationsOf(switched('thread-a', [claude, codex], null), 'thread-a').now).toBeNull()
  })
  test('are none of what T3 Code says of another thread, or of anything that is not what it says of a thread', () => {
    expect(conversationsOf(switched('thread-b', [claude, codex], codex.provider), 'thread-a')).toEqual({ now: null, before: [] })
    for (const not of [null, undefined, 'a thread', {}, { projection: {} }, { projection: { thread: { id: 'thread-a' }, providerThreads: 'none' } }])
      expect(conversationsOf(not, 'thread-a')).toEqual({ now: null, before: [] })
  })
})

// T3 Code's own command, which issues the session, and its server are stood in for: what is
// tried is what It makes of the answers
describe.skipIf(process.platform === 'win32')('the thread that runs a conversation that is heard from, asked of a server', () => {
  async function server(listed: Record<string, unknown>[], snapshots: Record<string, unknown>) {
    const folder = mkdtempSync(path.join(scratch, 'heard-'))
    const program = path.join(folder, 't3')
    writeFileSync(program, '#!/bin/sh\necho \'{"token":"a-session"}\'\n')
    chmodSync(program, 0o755)
    const read: string[] = []
    const answers = http.createServer((req, res) => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.url === '/api/orchestration/shell') return json(200, { projects: [{ id: 'site', workspaceRoot: '/work/site' }], threads: listed })
      const id = decodeURIComponent(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/.exec(req.url ?? '')?.[1] ?? '')
      read.push(id)
      return id in snapshots ? json(200, snapshots[id]) : json(404, {})
    })
    await new Promise<void>((r) => answers.listen(0, '127.0.0.1', r))
    return {
      t3: { origin: `http://127.0.0.1:${(answers.address() as AddressInfo).port}`, home: folder, program },
      read,
      close: () => {
        answers.closeAllConnections()
        answers.close()
      },
    }
  }
  const claude = { provider: 'provider-thread:claude', driver: 'claudeAgent', nativeId: 'claude-conversation' }
  const codex = { provider: 'provider-thread:codex', driver: 'codex', nativeId: 'codex-conversation' }
  const neighbour = { provider: 'provider-thread:neighbour', driver: 'codex', nativeId: 'neighbour-conversation' }
  const recently = () => new Date(Date.now() - 60_000).toISOString()

  test('is the thread that runs it now, with what that thread ran before, and never a neighbour in the same folder', async () => {
    const found = await server(
      [
        // In the same folder, running Codex, and changed last: read first, and not the one
        { id: 'neighbour', projectId: 'site', providerInstanceId: 'codex', activeRunId: 'run-9', updatedAt: recently() },
        { id: 'switched', projectId: 'site', providerInstanceId: 'codex', activeRunId: 'run-2', updatedAt: new Date(Date.now() - 120_000).toISOString() },
      ],
      {
        // The neighbour once ran a conversation too, which is its own and not the switched thread's
        neighbour: switched(
          'neighbour',
          [{ ...claude, provider: 'provider-thread:neighbours-claude', nativeId: 'neighbours-claude' }, neighbour],
          neighbour.provider,
        ),
        switched: switched('switched', [claude, codex], codex.provider),
      },
    )
    try {
      expect(await t3Running(found.t3, { harness: 'codex', id: 'codex-conversation', cwd: '/work/site' })).toEqual({
        thread: 'switched',
        before: [{ harness: 'claude-code', id: 'claude-conversation' }],
      })
      expect(await t3Running(found.t3, { harness: 'codex', id: 'neighbour-conversation', cwd: '/work/site' })).toEqual({
        thread: 'neighbour',
        before: [{ harness: 'claude-code', id: 'neighbours-claude' }],
      })
      // A conversation the thread ran before is not one it runs now: nothing is found for it
      expect(await t3Running(found.t3, { harness: 'claude-code', id: 'claude-conversation', cwd: '/work/site' })).toBeUndefined()
      // Nor for one with the same id under another agent app
      expect(await t3Running(found.t3, { harness: 'claude-code', id: 'codex-conversation', cwd: '/work/site' })).toBeUndefined()
    } finally {
      found.close()
    }
  })

  test('is asked of the thread It knows the conversation is in, and otherwise only of a few threads that are running or changed lately', async () => {
    const quiet = Array.from({ length: 20 }, (_, i) => ({
      id: `quiet-${i}`,
      projectId: 'site',
      providerInstanceId: 'codex',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    const lively = Array.from({ length: 20 }, (_, i) => ({ id: `lively-${i}`, projectId: 'site', providerInstanceId: 'codex', updatedAt: recently() }))
    const snapshots = Object.fromEntries([...quiet, ...lively].map((t) => [t.id, switched(t.id, [{ ...codex, nativeId: `other-${t.id}` }], codex.provider)]))
    snapshots['quiet-3'] = switched('quiet-3', [claude, codex], codex.provider)
    const found = await server([...quiet, ...lively], snapshots)
    try {
      // A quiet thread is not looked into, and no more than eight of the lively ones are
      expect(await t3Running(found.t3, { harness: 'codex', id: 'codex-conversation', cwd: '/work/site' })).toBeUndefined()
      expect(found.read).toHaveLength(8)
      expect(found.read.every((id) => id.startsWith('lively-'))).toBe(true)
      // The thread It already knows of is the one read, and only that one
      found.read.length = 0
      expect(await t3Running(found.t3, { harness: 'codex', id: 'codex-conversation' }, 'quiet-3')).toEqual({
        thread: 'quiet-3',
        before: [{ harness: 'claude-code', id: 'claude-conversation' }],
      })
      expect(found.read).toEqual(['quiet-3'])
      // And a thread that cannot be read says nothing
      expect(await t3Running(found.t3, { harness: 'codex', id: 'codex-conversation' }, 'gone')).toBeUndefined()
    } finally {
      found.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('which thread holds a conversation, asked of a server', () => {
  /** A server that lists threads and answers with a native id, an HTTP status, or no answer. */
  async function server(
    threads: Record<string, string | number | null>,
    listed?: { id: string; updatedAt?: string; archivedAt?: string; deletedAt?: string }[],
    shellStatus = 200,
  ) {
    const folder = mkdtempSync(path.join(scratch, 'asked-'))
    const program = path.join(folder, 't3')
    writeFileSync(program, '#!/bin/sh\necho \'{"token":"a-session"}\'\n')
    chmodSync(program, 0o755)
    const read: string[] = []
    let listings = 0
    const answers = http.createServer((req, res) => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.url === '/api/orchestration/shell') {
        listings++
        return json(shellStatus, { projects: [], threads: listed ?? Object.keys(threads).map((id) => ({ id })) })
      }
      const id = decodeURIComponent(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/.exec(req.url ?? '')?.[1] ?? '')
      read.push(id)
      const said = threads[id]
      if (said === null) return
      if (typeof said === 'number') return json(said, {})
      return json(200, { projection: { providerThreads: [{ nativeThreadRef: { nativeId: said } }] } })
    })
    await new Promise<void>((r) => answers.listen(0, '127.0.0.1', r))
    return {
      t3: { origin: `http://127.0.0.1:${(answers.address() as AddressInfo).port}`, home: folder, program },
      read,
      listings: () => listings,
      close: () => {
        answers.closeAllConnections()
        answers.close()
      },
    }
  }
  const of = { harness: 'codex', ids: ['conversation-1'] }

  const progress = (): T3Search => ({ pending: [], read: 0, attempted: new Set() })

  test('reaches an older match beyond two batches even when newer threads have similar folders and one cannot be read', async () => {
    const threads: Record<string, string | number> = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`thread-${i}`, `other-${i}`]))
    threads['thread-0'] = 503
    threads['thread-52'] = 'conversation-1'
    const listed = Object.keys(threads).map((id, i) => ({
      id,
      worktreePath: '/work/site',
      providerInstanceId: 'codex',
      updatedAt: new Date(10_000 - i).toISOString(),
    }))
    const found = await server(threads, listed)
    const search = progress()
    try {
      expect(await t3ThreadOf(found.t3, { ...of, cwd: '/work/site/pages' }, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(found.read).toHaveLength(24)
      // A thread added meanwhile waits for the next search; these passes keep one listing.
      listed.unshift({ id: 'new-thread', worktreePath: '/work/site', providerInstanceId: 'codex', updatedAt: new Date(20_000).toISOString() })
      threads['new-thread'] = 'another'
      expect(await t3ThreadOf(found.t3, { ...of, cwd: '/work/site/pages' }, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(found.read).toHaveLength(48)
      expect(await t3ThreadOf(found.t3, { ...of, cwd: '/work/site/pages' }, search)).toEqual({ status: 'found', thread: 'thread-52' })
      expect(found.read.filter((id) => id === 'thread-0')).toHaveLength(1)
      expect(found.listings()).toBe(1)
    } finally {
      found.close()
    }
  })

  test.each([false, true])('one search reads at most 96 threads including retries, with unread answers: %s', async (unread) => {
    const threads = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`thread-${i}`, unread ? 503 : 'another']))
    const found = await server(threads)
    const search = progress()
    try {
      for (let batch = 0; batch < 3; batch++) expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'limited' })
      expect(found.read).toHaveLength(96)
      expect(found.listings()).toBe(1)
      // Reusing an exhausted search cannot begin another traversal.
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'limited' })
      expect(found.read).toHaveLength(96)
      expect(found.listings()).toBe(1)
    } finally {
      found.close()
    }
  })

  test('retries share the search limit even when only one thread cannot be read', async () => {
    const found = await server({ unread: 503 })
    const search = progress()
    try {
      for (let read = 0; read < 95; read++) expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: read === 0 })
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'limited' })
      expect(found.read).toHaveLength(96)
      expect(found.listings()).toBe(1)
    } finally {
      found.close()
    }
  })

  test('reading the last candidate at the limit still proves absence, and a different conversation starts a new search', async () => {
    const threads = Object.fromEntries(Array.from({ length: 96 }, (_, i) => [`thread-${i}`, i === 0 ? 'conversation-2' : 'another']))
    const found = await server(threads)
    const search = progress()
    try {
      for (let batch = 0; batch < 3; batch++) expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'absent' })
      expect(found.read).toHaveLength(96)
      expect(found.listings()).toBe(1)
      expect(await t3ThreadOf(found.t3, { ...of, ids: ['conversation-2'] }, search)).toEqual({ status: 'found', thread: 'thread-0' })
      expect(found.read).toHaveLength(97)
      expect(found.listings()).toBe(2)
    } finally {
      found.close()
    }
  })

  test('says absent only after every listed candidate was read successfully, and a new search reads changed threads', async () => {
    const threads: Record<string, string | number> = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`thread-${i}`, 'another']))
    threads.archived = threads.deleted = 'conversation-1'
    threads['thread-0'] = 503
    const listed: { id: string; updatedAt?: string; archivedAt?: string; deletedAt?: string }[] = [
      ...Object.keys(threads)
        .filter((id) => id.startsWith('thread-'))
        .map((id) => ({ id, updatedAt: '2026-10-01T00:00:00Z' })),
      { id: 'archived', archivedAt: '2026-10-01T00:00:00Z' },
      { id: 'deleted', deletedAt: '2026-10-01T00:00:00Z' },
    ]
    const found = await server(threads, listed)
    const search = progress()
    try {
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      threads['thread-0'] = 'another'
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'absent' })
      expect(found.read).not.toContain('archived')
      expect(found.read).not.toContain('deleted')
      threads['thread-1'] = 'conversation-1'
      listed[1]!.updatedAt = '2026-10-02T00:00:00Z'
      expect(await t3ThreadOf(found.t3, of, progress())).toEqual({ status: 'found', thread: 'thread-1' })
      expect(found.listings()).toBe(2)
    } finally {
      found.close()
    }
  })

  test('distinguishes new batches and successful reads from permanently unread candidates', async () => {
    const threads: Record<string, string | number> = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`thread-${i}`, 503]))
    const found = await server(threads)
    const search = progress()
    try {
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(new Set(found.read).size).toBe(10)
      for (let retry = 0; retry < 2; retry++) {
        expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: false })
      }
      // A recovered read makes progress even though the rest still need retries.
      threads[search.pending[0]!] = 'another'
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: true })
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: false })
      const match = search.pending[0]!
      threads[match] = 'conversation-1'
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'found', thread: match })
    } finally {
      found.close()
    }
  })

  test.each(['session', 'shell'])('a failing %s does not count as progress', async (failure) => {
    const found = await server({ match: 'conversation-1' }, undefined, failure === 'shell' ? 503 : 200)
    if (failure === 'session') writeFileSync(found.t3.program, '#!/bin/sh\nexit 1\n')
    const search = progress()
    try {
      for (let retry = 0; retry < 2; retry++) {
        expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'incomplete', progressed: false })
      }
      expect(found.read).toEqual([])
    } finally {
      found.close()
    }
  })

  test('an expired pass leaves its unread candidate retryable and lets the next pass reach other candidates', async () => {
    const found = await server({ slow: null, match: 'conversation-1' })
    const search = progress()
    try {
      const started = performance.now()
      expect(await t3ThreadOf(found.t3, of, search, AbortSignal.timeout(150))).toEqual({ status: 'incomplete', progressed: true })
      expect(performance.now() - started).toBeLessThan(2000)
      expect(found.read).toEqual(['slow'])
      expect(await t3ThreadOf(found.t3, of, search)).toEqual({ status: 'found', thread: 'match' })
    } finally {
      found.close()
    }
  })

  test('the deadline also bounds a command that does not issue a session', async () => {
    const found = await server({ match: 'conversation-1' })
    writeFileSync(found.t3.program, '#!/bin/sh\nexec sleep 30\n')
    try {
      const started = performance.now()
      expect(await t3ThreadOf(found.t3, of, progress(), AbortSignal.timeout(150))).toEqual({ status: 'incomplete', progressed: false })
      expect(performance.now() - started).toBeLessThan(2000)
      expect(found.read).toEqual([])
    } finally {
      found.close()
    }
  })

  test('is the thread that carries the conversation’s id, and none where every thread was read and none carries it', async () => {
    const found = await server({ 'thread-a': 'another-conversation', 'thread-b': 'conversation-1' })
    const none = await server({ 'thread-a': 'another-conversation', 'thread-b': 'a-third' })
    try {
      expect(await t3ThreadOf(found.t3, of)).toEqual({ status: 'found', thread: 'thread-b' })
      expect(await t3ThreadOf(none.t3, of)).toEqual({ status: 'absent' })
    } finally {
      found.close()
      none.close()
    }
  })

  test('is asked of the server itself, though the environment names a proxy for everything', async () => {
    const found = await server({ 'thread-a': 'conversation-1' })
    // A proxy that would see the session and every answer, were anything sent its way
    let through = 0
    const proxy = http.createServer((_req, res) => {
      through++
      res.writeHead(502).end()
    })
    proxy.on('connect', (_req, socket) => {
      through++
      socket.destroy()
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const named = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy']
    const before = Object.fromEntries(named.map((name) => [name, process.env[name]]))
    for (const name of named.slice(0, 5)) process.env[name] = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    delete process.env.NO_PROXY
    delete process.env.no_proxy
    try {
      expect(await t3ThreadOf(found.t3, of)).toEqual({ status: 'found', thread: 'thread-a' })
      expect(through).toBe(0)
    } finally {
      for (const name of named) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
      proxy.close()
      found.close()
    }
  })

  // Bun is what the standalone program runs under, and takes a proxy named as it starts for
  // every request it makes by itself, one to this machine included. So the same is asked by a
  // program started under Bun with a proxy named, where Bun is here to start one.
  const bun =
    'Bun' in globalThis
      ? process.execPath
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .map((folder) => path.join(folder, 'bun'))
          .find((file) => existsSync(file))
  test.skipIf(!bun)('and so it is by the standalone program’s runtime, with a proxy named as it starts', async () => {
    const found = await server({ 'thread-a': 'conversation-1' })
    let through = 0
    const proxy = http.createServer((_req, res) => {
      through++
      res.writeHead(502).end()
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const named = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const asks = path.join(scratch, 'asks.ts')
    writeFileSync(
      asks,
      `import { t3ThreadOf } from ${JSON.stringify(path.join(__dirname, 'src', 't3.ts'))}
       console.log(JSON.stringify(await t3ThreadOf(${JSON.stringify(found.t3)}, ${JSON.stringify(of)})))`,
    )
    try {
      const said = await new Promise<string>((resolve) =>
        execFile(
          bun!,
          [asks],
          { env: { PATH: process.env.PATH, HOME: scratch, HTTP_PROXY: named, http_proxy: named, ALL_PROXY: named }, timeout: 30_000 },
          (_err, out) => resolve(String(out).trim()),
        ),
      )
      expect([said, through]).toEqual([JSON.stringify({ status: 'found', thread: 'thread-a' }), 0])
    } finally {
      proxy.close()
      found.close()
    }
  })

  test('is not said to be none where a thread could not be read: it may be that one, and is asked about again', async () => {
    const unread = await server({ 'thread-a': 'another-conversation', 'thread-b': 503 })
    const readElsewhere = await server({ 'thread-a': 503, 'thread-b': 'conversation-1' })
    try {
      expect(await t3ThreadOf(unread.t3, of)).toEqual({ status: 'incomplete', progressed: true })
      // One thread that cannot be read still says nothing of the others
      expect(await t3ThreadOf(readElsewhere.t3, of)).toEqual({ status: 'found', thread: 'thread-b' })
    } finally {
      unread.close()
      readElsewhere.close()
    }
  })
})
