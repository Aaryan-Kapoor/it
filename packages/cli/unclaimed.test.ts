// A page made by an OpenCode that had not loaded It's add-on names no conversation. It is noted
// on this machine, and the OpenCode conversation that next names it is given it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Problem } from './src/lib'
import { claimUnclaimed, inUnloadedOpenCode, noteUnclaimed, type Take, unclaimed, unclaimedFile } from './src/unclaimed'

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

type Session = { harness: string; id: string }
/**
 * An It that keeps who has each page, by It's own record of the page, and gives a page only
 * while no conversation has it, in one step, as the backend's `artifacts.take` with `unowned`
 * does. It keeps what it gave to whom.
 */
function fake(owners: Record<string, Session | null>) {
  const taken: [string, Session][] = []
  const take: Take = async (page, session) => {
    if (!(page in owners)) throw new Problem('No such page.', 'not_found')
    if (owners[page]) return { took: false }
    owners[page] = session
    taken.push([page, session])
    return { took: true }
  }
  return { take, taken, owners }
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

  test.runIf(process.platform === 'win32')('is never taken for OpenCode’s on Windows, where the processes above a command are not looked up', () => {
    expect(inUnloadedOpenCode(undefined)).toBe(false)
  })
})

describe('a page made in an OpenCode that had not loaded the add-on', () => {
  test('is given to the OpenCode conversation that next names it, once', async () => {
    await noteUnclaimed('ping', 'page-1')
    expect(unclaimed('ping')).toBe(true)
    const { take, taken } = fake({ 'page-1': null })
    expect(await claimUnclaimed('ping', opencode, take)).toBe('took')
    expect(taken).toEqual([['page-1', opencode]])
    expect(unclaimed('ping')).toBe(false)
    // Another conversation that names it afterwards is given nothing
    expect(await claimUnclaimed('ping', { harness: 'opencode', id: 'ses_other' }, take)).toBe('not')
    expect(taken).toHaveLength(1)
  })

  test('stays with a conversation that took it meanwhile, and the note goes', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take, taken } = fake({ 'page-1': { harness: 'opencode', id: 'ses_shown_it' } })
    expect(await claimUnclaimed('ping', opencode, take)).toBe('not')
    expect(taken).toEqual([])
    expect(unclaimed('ping')).toBe(false)
  })

  test('is given to one conversation alone where two name it at once', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take, taken, owners } = fake({ 'page-1': null })
    const other = { harness: 'opencode', id: 'ses_other' }
    const both = await Promise.all([claimUnclaimed('ping', opencode, take), claimUnclaimed('ping', other, take)])
    expect(both.sort()).toEqual(['not', 'took'])
    expect(taken).toHaveLength(1)
    expect(owners['page-1']).toEqual(taken[0]![1])
  })

  test('is not taken from a conversation that showed it in the moment before It was asked', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take: give, owners } = fake({ 'page-1': null })
    const shown = { harness: 'opencode', id: 'ses_shown_it' }
    // Another conversation shows the page just as this one names it
    const take: Take = async (page, session) => {
      owners[page] = shown
      return give(page, session)
    }
    expect(await claimUnclaimed('ping', opencode, take)).toBe('not')
    expect(owners['page-1']).toEqual(shown)
  })

  test('a page deleted and made again under the same id is not taken for it, and the note goes', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take, taken } = fake({ 'page-2': null })
    expect(await claimUnclaimed('ping', opencode, take)).toBe('not')
    expect(taken).toEqual([])
    expect(unclaimed('ping')).toBe(false)
  })

  test('is given to no conversation of another app, and to no command without a conversation', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take, taken } = fake({ 'page-1': null })
    expect(await claimUnclaimed('ping', { harness: 'claude-code', id: 'c1' }, take)).toBe('not')
    expect(await claimUnclaimed('ping', undefined, take)).toBe('not')
    expect(await claimUnclaimed(undefined, opencode, take)).toBe('not')
    expect(taken).toEqual([])
    expect(unclaimed('ping')).toBe(true)
  })

  test('a page that was never noted is never given this way, whoever has it', async () => {
    const { take, taken } = fake({ 'page-1': null })
    expect(await claimUnclaimed('board', opencode, take)).toBe('not')
    expect(taken).toEqual([])
  })

  test('where It cannot be asked, nothing is given and the note is kept for the next time', async () => {
    await noteUnclaimed('ping', 'page-1')
    const take: Take = async () => {
      throw new Problem('It is not running.', 'offline')
    }
    expect(await claimUnclaimed('ping', opencode, take)).toBe('unanswered')
    expect(unclaimed('ping')).toBe(true)
    // As where an It of an earlier build does not know what it is asked: it never gives the page unasked
    const older: Take = async () => {
      throw new Problem('ArgumentValidationError: Object contains extra field `unowned`', 'invalid')
    }
    expect(await claimUnclaimed('ping', opencode, older)).toBe('unanswered')
    expect(unclaimed('ping')).toBe(true)
  })

  test('a note that is not as It writes it is no note', async () => {
    writeFileSync(unclaimedFile(), JSON.stringify({ ping: { at: 1 }, board: 'yes' }))
    expect(unclaimed('ping')).toBe(false)
    expect(unclaimed('board')).toBe(false)
    const { take, taken } = fake({ 'page-1': null })
    expect(await claimUnclaimed('ping', opencode, take)).toBe('not')
    expect(taken).toEqual([])
  })

  test('two commands noting pages at once each keep the other’s note', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => noteUnclaimed(`page-${i}`, `record-${i}`)))
    for (let i = 0; i < 12; i++) expect(unclaimed(`page-${i}`)).toBe(true)
  })

  test('the note of a page made again under the same id, meanwhile, is not taken away with the old one', async () => {
    await noteUnclaimed('ping', 'page-1')
    const { take: give } = fake({ 'page-1': null })
    // While this conversation is given the first page, another command notes a new one under that id
    const take: Take = async (page, session) => {
      const answer = await give(page, session)
      await noteUnclaimed('ping', 'page-2')
      return answer
    }
    expect(await claimUnclaimed('ping', opencode, take)).toBe('took')
    expect(unclaimed('ping')).toBe(true)
  })

  test('only the pages noted last are remembered', async () => {
    for (let i = 0; i < 60; i++) await noteUnclaimed(`page-${i}`, `record-${i}`, i)
    const kept = Object.keys(JSON.parse(readFileSync(unclaimedFile(), 'utf8')))
    expect(kept).toHaveLength(50)
    expect(unclaimed('page-0')).toBe(false)
    expect(unclaimed('page-59')).toBe(true)
  })
})
