// The local note that lets a closed conversation be reopened in the folder it last used.
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { conversationFolder, conversationsFile, noteConversation } from './src/publish'

let scratch: string
let before: string | undefined
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-publish-'))
  before = process.env.IT_HOME
  process.env.IT_HOME = path.join(scratch, 'home')
  mkdirSync(process.env.IT_HOME)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (before === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = before
  rmSync(scratch, { recursive: true, force: true })
})

describe('the conversation folders It remembers', () => {
  test.each([9999, 10_000, 10_001])('recovers an empty legacy lock only after ten seconds, at %s milliseconds', async (age) => {
    vi.useFakeTimers()
    const lock = `${conversationsFile()}.lock`
    const record = { 'pi:earlier': { cwd: scratch, at: 1 } }
    writeFileSync(conversationsFile(), JSON.stringify(record))
    writeFileSync(lock, '')
    utimesSync(lock, 1000, 1000)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + age)
    const noted = noteConversation({ harness: 'pi', id: 'next' }, scratch)
    await vi.runAllTimersAsync()
    await noted
    expect(conversationFolder({ harness: 'pi', id: 'earlier' })).toBe(scratch)
    if (age > 10_000) {
      expect(conversationFolder({ harness: 'pi', id: 'next' })).toBe(scratch)
      expect(fs.existsSync(lock)).toBe(false)
    } else {
      expect(JSON.parse(readFileSync(conversationsFile(), 'utf8'))).toEqual(record)
      expect(readFileSync(lock, 'utf8')).toBe('')
    }
  })

  test('leaves an unchanged conversation note alone without taking a lock or flushing a file', () => {
    const session = { harness: 'codex', id: 'unchanged' }
    noteConversation(session, scratch)
    const before = readFileSync(conversationsFile(), 'utf8')
    const link = vi.spyOn(fs, 'linkSync')
    const flush = vi.spyOn(fs, 'fsyncSync')
    syncBuiltinESMExports()
    try {
      noteConversation(session, scratch)
      expect(readFileSync(conversationsFile(), 'utf8')).toBe(before)
      expect(link).not.toHaveBeenCalled()
      expect(flush).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    }
  })

  test('lets the event loop run while another writer holds the lock and keeps both notes when it is released', async () => {
    const lock = `${conversationsFile()}.lock`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, holder: 'a'.repeat(16) }))
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('the event loop must not wait')
    })
    const noted = noteConversation({ harness: 'codex', id: 'busy' }, scratch)
    expect(wait).not.toHaveBeenCalled()
    expect(conversationFolder({ harness: 'codex', id: 'busy' })).toBeUndefined()
    await new Promise<void>((resolve) => setImmediate(resolve))
    writeFileSync(conversationsFile(), JSON.stringify({ 'pi:other': { cwd: scratch, at: 1 } }))
    rmSync(lock)
    await noted
    expect(conversationFolder({ harness: 'codex', id: 'busy' })).toBe(scratch)
    expect(conversationFolder({ harness: 'pi', id: 'other' })).toBe(scratch)
  })

  test('does not rewrite a note that another writer kept while it waited', async () => {
    vi.useFakeTimers()
    const lock = `${conversationsFile()}.lock`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, holder: 'a'.repeat(16) }))
    const noted = noteConversation({ harness: 'codex', id: 'waiting' }, scratch)
    const record = JSON.stringify({ 'codex:waiting': { cwd: scratch, at: 1 } })
    writeFileSync(conversationsFile(), record)
    rmSync(lock)
    const flush = vi.spyOn(fs, 'fsyncSync')
    syncBuiltinESMExports()
    try {
      await vi.runAllTimersAsync()
      await noted
      expect(readFileSync(conversationsFile(), 'utf8')).toBe(record)
      expect(flush).not.toHaveBeenCalled()
    } finally {
      flush.mockRestore()
      syncBuiltinESMExports()
    }
  })

  test('keeps a conversation whose folder changed when the oldest unchanged one is forgotten', () => {
    const used = { harness: 'pi', id: 'used-again' }
    const kept = Object.fromEntries(Array.from({ length: 299 }, (_, n) => [`pi:other-${n}`, { cwd: scratch, at: n + 2 }]))
    writeFileSync(conversationsFile(), JSON.stringify({ 'pi:used-again': { cwd: path.join(scratch, 'old'), at: 1 }, ...kept }))
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    noteConversation(used, scratch)
    now.mockReturnValue(1001)
    noteConversation({ harness: 'pi', id: 'new' }, scratch)
    const saved = JSON.parse(readFileSync(conversationsFile(), 'utf8'))
    expect(Object.keys(saved)).toHaveLength(300)
    expect(conversationFolder(used)).toBe(scratch)
    expect(saved['pi:used-again'].at).toBe(1000)
    expect(conversationFolder({ harness: 'pi', id: 'other-0' })).toBeUndefined()
  })
})
