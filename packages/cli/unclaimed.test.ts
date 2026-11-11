// A page made by an OpenCode that had not loaded It's add-on names no conversation. It is noted
// on this machine, and the OpenCode conversation that next names it is given it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type Backend, claimUnclaimed, inUnloadedOpenCode, noteUnclaimed, unclaimed, unclaimedFile } from './src/unclaimed'

const opencode = { harness: 'opencode', id: 'ses_0123456789abcdef' }
let home: string
let before: string | undefined

beforeEach(() => {
  before = process.env.IT_HOME
  home = mkdtempSync(path.join(os.tmpdir(), 'it-unclaimed-'))
  process.env.IT_HOME = home
})
afterEach(() => {
  if (before === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = before
  rmSync(home, { recursive: true, force: true })
})

/** An It that says who has each page, and keeps what it was asked to give to whom. */
function fake(owners: Record<string, { harness: string; id: string } | null>) {
  const taken: [string, { harness: string; id: string }][] = []
  const ask: Backend = {
    owner: async (slug) => (slug in owners ? { session: owners[slug] } : null),
    take: async (slug, session) => {
      taken.push([slug, session])
      owners[slug] = session
    },
  }
  return { ask, taken }
}

describe('a command that names no conversation', () => {
  test('is OpenCode’s where OpenCode is the agent app nearest above it', () => {
    expect(inUnloadedOpenCode(undefined, () => ['opencode'])).toBe(true)
    expect(inUnloadedOpenCode(undefined, () => ['opencode', 'claude-code'])).toBe(true)
  })

  test('is not OpenCode’s from a plain terminal, from inside another app, or where a conversation is named', () => {
    expect(inUnloadedOpenCode(undefined, () => [])).toBe(false)
    expect(inUnloadedOpenCode(undefined, () => ['codex', 'opencode'])).toBe(false)
    expect(inUnloadedOpenCode({ session: opencode, unsettled: [] }, () => ['opencode'])).toBe(false)
  })
})

describe('a page made in an OpenCode that had not loaded the add-on', () => {
  test('is given to the OpenCode conversation that next names it, once', async () => {
    noteUnclaimed('ping')
    expect(unclaimed('ping')).toBe(true)
    const { ask, taken } = fake({ ping: null })
    expect(await claimUnclaimed('ping', opencode, ask)).toBe(true)
    expect(taken).toEqual([['ping', opencode]])
    expect(unclaimed('ping')).toBe(false)
    // Another conversation that names it afterwards is given nothing
    expect(await claimUnclaimed('ping', { harness: 'opencode', id: 'ses_other' }, ask)).toBe(false)
    expect(taken).toHaveLength(1)
  })

  test('stays with a conversation that took it meanwhile, and the note goes', async () => {
    noteUnclaimed('ping')
    const { ask, taken } = fake({ ping: { harness: 'opencode', id: 'ses_shown_it' } })
    expect(await claimUnclaimed('ping', opencode, ask)).toBe(false)
    expect(taken).toEqual([])
    expect(unclaimed('ping')).toBe(false)
  })

  test('is given to no conversation of another app, and to no command without a conversation', async () => {
    noteUnclaimed('ping')
    const { ask, taken } = fake({ ping: null })
    expect(await claimUnclaimed('ping', { harness: 'claude-code', id: 'c1' }, ask)).toBe(false)
    expect(await claimUnclaimed('ping', undefined, ask)).toBe(false)
    expect(await claimUnclaimed(undefined, opencode, ask)).toBe(false)
    expect(taken).toEqual([])
    expect(unclaimed('ping')).toBe(true)
  })

  test('a page that was never noted is never given this way, whoever has it', async () => {
    const { ask, taken } = fake({ board: null })
    expect(await claimUnclaimed('board', opencode, ask)).toBe(false)
    expect(taken).toEqual([])
  })

  test('where It cannot be asked, nothing is given and the note is kept for the next time', async () => {
    noteUnclaimed('ping')
    const ask: Backend = {
      owner: async () => {
        throw new Error('offline')
      },
      take: async () => {
        throw new Error('never asked')
      },
    }
    expect(await claimUnclaimed('ping', opencode, ask)).toBe(false)
    expect(unclaimed('ping')).toBe(true)
  })

  test('only the pages noted last are remembered', () => {
    for (let i = 0; i < 60; i++) noteUnclaimed(`page-${i}`, i)
    const kept = Object.keys(JSON.parse(readFileSync(unclaimedFile(), 'utf8')))
    expect(kept).toHaveLength(50)
    expect(unclaimed('page-0')).toBe(false)
    expect(unclaimed('page-59')).toBe(true)
  })
})
