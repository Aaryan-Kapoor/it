// The local note that lets a closed conversation be reopened in the folder it last used.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
