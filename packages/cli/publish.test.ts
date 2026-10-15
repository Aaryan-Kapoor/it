// The local note that lets a closed conversation be reopened in the folder it last used.
import { execFileSync } from 'node:child_process'
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
  vi.restoreAllMocks()
  if (before === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = before
  rmSync(scratch, { recursive: true, force: true })
})

describe('the conversation folders It remembers', () => {
  test('leaves the record untouched when a live writer holds its lock beyond the acquisition budget', () => {
    const record = { 'pi:holder': { cwd: scratch, at: Date.now() } }
    writeFileSync(conversationsFile(), JSON.stringify(record))
    const lock = `${conversationsFile()}.lock`
    const holder = JSON.stringify({ pid: process.pid, holder: 'a'.repeat(16) })
    writeFileSync(lock, holder)
    utimesSync(lock, 0, 0)
    noteConversation({ harness: 'pi', id: 'contender' }, scratch)
    expect(JSON.parse(readFileSync(conversationsFile(), 'utf8'))).toEqual(record)
    expect(readFileSync(lock, 'utf8')).toBe(holder)
  })

  test('recovers a lock only after its process has exited', () => {
    const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']))
    writeFileSync(`${conversationsFile()}.lock`, JSON.stringify({ pid, holder: 'b'.repeat(16) }))
    noteConversation({ harness: 'pi', id: 'next' }, scratch)
    expect(conversationFolder({ harness: 'pi', id: 'next' })).toBe(scratch)
  })

  test('does not release a replacement lock when its original owner finishes', () => {
    const lock = `${conversationsFile()}.lock`
    const replacement = JSON.stringify({ pid: process.pid, holder: 'c'.repeat(16) })
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      rename(from, to)
      if (to === conversationsFile()) writeFileSync(lock, replacement)
    }
    syncBuiltinESMExports()
    try {
      noteConversation({ harness: 'pi', id: 'original' }, scratch)
      expect(readFileSync(lock, 'utf8')).toBe(replacement)
    } finally {
      fs.renameSync = rename
      syncBuiltinESMExports()
    }
  })

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('cleans only its own published lock after temporary cleanup fails, recovery %s and replacement %s', (recovering, replacing) => {
    const lock = `${conversationsFile()}.lock`
    const previous = JSON.stringify({
      pid: Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])),
      holder: 'b'.repeat(16),
    })
    if (recovering) writeFileSync(lock, previous)
    const claimed = recovering ? `${lock}.after.${'b'.repeat(16)}` : lock
    const replacement = JSON.stringify({ pid: process.pid, holder: 'c'.repeat(16) })
    const remove = fs.rmSync
    let failed = false
    fs.rmSync = (file, options) => {
      if (!failed && String(file).endsWith('.tmp') && fs.existsSync(claimed)) {
        failed = true
        if (replacing) writeFileSync(claimed, replacement)
        throw Object.assign(new Error('temporary file is busy'), { code: 'EBUSY' })
      }
      return remove(file, options)
    }
    syncBuiltinESMExports()
    try {
      noteConversation({ harness: 'pi', id: 'interrupted' }, scratch)
      expect(failed).toBe(true)
      if (replacing) expect(readFileSync(claimed, 'utf8')).toBe(replacement)
      else expect(fs.existsSync(claimed)).toBe(false)
      if (recovering) expect(readFileSync(lock, 'utf8')).toBe(previous)
      if (!replacing) {
        noteConversation({ harness: 'pi', id: 'next' }, scratch)
        expect(conversationFolder({ harness: 'pi', id: 'next' })).toBe(scratch)
      }
    } finally {
      fs.rmSync = remove
      syncBuiltinESMExports()
    }
  })

  test('keeps a conversation used again in the same folder when the oldest unused one is forgotten', () => {
    const used = { harness: 'pi', id: 'used-again' }
    const kept = Object.fromEntries(Array.from({ length: 299 }, (_, n) => [`pi:other-${n}`, { cwd: scratch, at: n + 2 }]))
    writeFileSync(conversationsFile(), JSON.stringify({ 'pi:used-again': { cwd: scratch, at: 1 }, ...kept }))
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
