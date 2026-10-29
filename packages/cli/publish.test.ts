// The local note that lets a closed conversation be reopened in the folder it last used.
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { profileOf } from './src/profiles'
import { conversationFolder, conversationProfile, conversationsFile, noteConversation } from './src/publish'

const HOUR = 60 * 60_000
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

  test('keeps a changed profile at the same folder after yielding for the conversation lock', async () => {
    const session = { harness: 'codex', id: 'profile-changed' }
    const first = profileOf('codex', { CODEX_HOME: path.join(scratch, 'first') })!
    const second = profileOf('codex', { CODEX_HOME: path.join(scratch, 'second') })!
    await noteConversation(session, scratch, first)
    const lock = `${conversationsFile()}.lock`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, holder: 'a'.repeat(16) }))
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('the event loop must not wait')
    })
    const noted = noteConversation(session, scratch, second)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(wait).not.toHaveBeenCalled()
    expect(conversationProfile(session)).toEqual(first)
    rmSync(lock)
    await noted
    expect(conversationProfile(session)).toEqual(second)
    // An older hook sends no profile. Its folder report keeps the last recorded one.
    await noteConversation(session, path.join(scratch, 'moved'), null)
    expect(conversationProfile(session)).toEqual(second)
    expect(JSON.parse(readFileSync(conversationsFile(), 'utf8'))['codex:profile-changed'].cwd).toBe(path.join(scratch, 'moved'))
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
    const record = JSON.stringify({ 'codex:waiting': { cwd: scratch, at: Date.now(), profile: profileOf('codex') } })
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

  test.each([
    { age: HOUR - 1, written: false },
    { age: HOUR, written: true },
    { age: -(HOUR - 1), written: false },
    { age: -HOUR, written: true },
  ])(
    'writes the time of a conversation used again in the same folder only when its note is an hour or more from the clock, at $age milliseconds',
    async ({ age, written }) => {
      const session = { harness: 'codex', id: 'used-again' }
      const now = vi.spyOn(Date, 'now').mockReturnValue(100 * HOUR)
      await noteConversation(session, scratch)
      const before = readFileSync(conversationsFile(), 'utf8')
      now.mockReturnValue(100 * HOUR + age)
      const flush = vi.spyOn(fs, 'fsyncSync')
      syncBuiltinESMExports()
      try {
        await noteConversation(session, scratch)
        expect(flush.mock.calls.length > 0).toBe(written)
      } finally {
        flush.mockRestore()
        syncBuiltinESMExports()
      }
      if (written) expect(JSON.parse(readFileSync(conversationsFile(), 'utf8'))['codex:used-again']).toMatchObject({ cwd: scratch, at: 100 * HOUR + age })
      else expect(readFileSync(conversationsFile(), 'utf8')).toBe(before)
    },
  )

  test('reads the note once and takes no lock, writes nothing and flushes nothing for each hook event within the hour', async () => {
    const session = { harness: 'codex', id: 'busy-hooks' }
    const others = Object.fromEntries(Array.from({ length: 299 }, (_, n) => [`codex:other-${n}`, { cwd: scratch, at: n + 1 }]))
    writeFileSync(conversationsFile(), JSON.stringify(others))
    const now = vi.spyOn(Date, 'now').mockReturnValue(100 * HOUR)
    await noteConversation(session, scratch)
    const before = readFileSync(conversationsFile(), 'utf8')
    const read = vi.spyOn(fs, 'readFileSync')
    const touched = [vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'linkSync'), vi.spyOn(fs, 'renameSync'), vi.spyOn(fs, 'fsyncSync')]
    syncBuiltinESMExports()
    try {
      // A busy conversation's hooks, every few seconds for most of an hour
      for (let at = 0; at < HOUR; at += 12_000) {
        now.mockReturnValue(100 * HOUR + at)
        await noteConversation(session, scratch)
      }
      expect(read.mock.calls.filter(([file]) => file === conversationsFile())).toHaveLength(HOUR / 12_000)
      for (const spy of touched) expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    }
    expect(readFileSync(conversationsFile(), 'utf8')).toBe(before)
    expect(existsSync(`${conversationsFile()}.lock`)).toBe(false)
  })

  test('keeps a conversation used again in the same folder when the oldest unused one is forgotten', async () => {
    const used = { harness: 'pi', id: 'used-again' }
    const kept = Object.fromEntries(Array.from({ length: 299 }, (_, n) => [`pi:other-${n}`, { cwd: scratch, at: n + 2 }]))
    writeFileSync(conversationsFile(), JSON.stringify({ 'pi:used-again': { cwd: scratch, at: 1 }, ...kept }))
    // Used again a day later, in the folder it was noted in, and then another conversation publishes for the first time
    const now = vi.spyOn(Date, 'now').mockReturnValue(1 + 24 * HOUR)
    await noteConversation(used, scratch, null)
    now.mockReturnValue(2 + 24 * HOUR)
    await noteConversation({ harness: 'pi', id: 'new' }, scratch, null)
    const saved = JSON.parse(readFileSync(conversationsFile(), 'utf8'))
    expect(Object.keys(saved)).toHaveLength(300)
    expect(saved['pi:used-again']).toEqual({ cwd: scratch, at: 1 + 24 * HOUR })
    expect(conversationFolder(used)).toBe(scratch)
    expect(conversationFolder({ harness: 'pi', id: 'new' })).toBe(scratch)
    expect(conversationFolder({ harness: 'pi', id: 'other-0' })).toBeUndefined()
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
