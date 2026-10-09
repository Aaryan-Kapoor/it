// What It makes of T3 Code's own account of its server and its threads: which server is asked,
// which threads are looked into first for a conversation, and which thread is the conversation's.
// The asking and the sending themselves need a T3 Code that is running, and are tried against one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { holds, likeliest, t3Server } from './src/t3'

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
