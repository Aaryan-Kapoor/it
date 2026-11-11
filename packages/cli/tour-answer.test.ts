// What `it tour answer` does with an action of the tour's first page, and the picture It keeps
// for the agent: where it is written, when, and what takes it away again.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deepMerge } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const stand = vi.hoisted(() => ({
  calls: [] as { name: string; args: any }[],
  action: null as any,
  saved: [] as { id: string; number: number; to: string }[],
  save: null as null | ((to: string) => void),
  failAck: false,
  state: {} as Record<string, unknown>,
  revision: 6,
  clashes: 0,
}))
vi.mock('./src/lib', async (original) => ({
  ...(await original<typeof import('./src/lib')>()),
  call: async (_kind: string, fn: any, args: any) => {
    const name = getFunctionName(fn)
    stand.calls.push({ name, args })
    if (name === 'delivery:get') return stand.action
    if (name === 'state:get') return { json: JSON.stringify(stand.state), revision: stand.revision }
    if (name === 'state:patch') {
      // Held to the revision it was read at, as the backend holds it, and refused as a clash a set number of times
      if (stand.clashes > 0) {
        stand.clashes--
        stand.revision++
        throw Object.assign(new Error('The state changed since you read it.'), { code: 'conflict' })
      }
      if (args.baseRevision !== stand.revision) throw Object.assign(new Error('The state changed since you read it.'), { code: 'conflict' })
      return { revision: 7 }
    }
    if (name === 'delivery:handedOff' && stand.failAck) throw new Error('offline')
    return null
  },
}))
vi.mock('./src/files', () => ({
  saveAttached: async (id: string, number: number, to: string) => {
    stand.saved.push({ id, number, to })
    if (stand.save) stand.save(to)
    else writeFileSync(to, 'png', { flag: 'wx' })
    return { file: to, number, name: 'sheet.png', type: 'image/png', bytes: 3 }
  },
}))

import { answerAction, askedBy, replacing, dropPicture, dropPictures, keepPicture, keepPictureFor, pictureName, START_SLUG } from './src/tour-answer'

const REQUEST = 'ab'.repeat(16)
const PNG = [{ name: 'sheet.png', type: 'image/png', bytes: 2048 }]
const action = (data: unknown, more: Record<string, unknown> = {}) => ({ id: 'act1', artifact: START_SLUG, payload: JSON.stringify(data), ...more })
let folder: string
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-tour-answer-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  stand.calls.length = stand.saved.length = 0
  stand.action = stand.save = null
  stand.failAck = false
  stand.state = {}
  stand.revision = 6
  stand.clashes = 0
})
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('the part an action came from and the request it waits on are read from the action itself, and from no page but the tour’s first', () => {
  expect(askedBy(action({ part: 'room', request: REQUEST, free: [] }))).toEqual({ part: 'room', request: REQUEST })
  expect(askedBy(action({ part: 'chess' }))).toEqual({ part: 'chess' })
  // Neither is taken where it is not shaped as the page makes it: they become a key of the state and the name of a file
  expect(askedBy(action({ part: '../x', request: '../../etc/passwd' }))).toEqual({})
  expect(askedBy(action({ part: '__proto__', request: `${REQUEST}0` }))).toEqual({})
  expect(askedBy(action(['room']))).toEqual({})
  expect(askedBy({ artifact: 'tour-start', payload: 'not json' })).toEqual({})
  expect(askedBy({ artifact: 'my-own-page', payload: JSON.stringify({ part: 'room', request: REQUEST }) })).toEqual({})
})

test('an answer is set under the action’s own part with the action’s own request, whatever the answer says of one, and the action is acknowledged', async () => {
  stand.action = action({ part: 'room', request: REQUEST })
  const done = await answerAction('act1', { armchair: [419, 309], lamp: true, say: 'There.', request: 'someone-elses' })
  expect(done).toEqual({ part: 'room', request: REQUEST, revision: 7 })
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get', 'state:get', 'state:patch', 'delivery:handedOff', 'delivery:settle'])
  const patched = stand.calls[2]!.args
  expect(patched.slug).toBe('tour-start')
  expect(JSON.parse(patched.patch)).toEqual({ room: { armchair: [419, 309], lamp: true, say: 'There.', request: REQUEST } })
  expect(stand.calls[3]!.args).toEqual({ id: 'act1', route: 'manual' })
  expect(stand.calls[4]!.args).toEqual({ id: 'act1', outcome: 'succeeded' })
})

test('an answer takes the place of the answer before it, so that nothing an earlier answer said is read as part of this one', async () => {
  stand.action = action({ part: 'board', request: REQUEST })
  stand.state = { board: { blind: true, hint: 'Count the rows', say: 'I cannot see it.', request: 'cd'.repeat(16), deep: { a: 1, b: 2 } }, room: { lamp: true } }
  await answerAction('act1', { read: '144', right: true, say: 'Right.', deep: { a: 3 } })
  const patched = stand.calls.find((c) => c.name === 'state:patch')!.args
  // Held to the revision it was read at, and taking away, at every depth, what the new answer does not say. Another part is not touched
  expect(patched.baseRevision).toBe(6)
  expect(JSON.parse(patched.patch)).toEqual({ board: { blind: null, hint: null, read: '144', right: true, say: 'Right.', request: REQUEST, deep: { a: 3, b: null } } })
  // Which, merged as the state merges a patch, leaves the new answer and nothing else
  expect(deepMerge(stand.state, JSON.parse(patched.patch))).toEqual({ board: { read: '144', right: true, say: 'Right.', request: REQUEST, deep: { a: 3 } }, room: { lamp: true } })
  expect(replacing('text', { a: 1 })).toEqual({ a: 1 })
  expect(replacing({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  expect(replacing({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: 'x' })
})

test('where the state changed between reading it and writing the answer, it is read again, and a refusal of another kind is not tried again', async () => {
  stand.action = action({ part: 'room', request: REQUEST })
  stand.clashes = 2
  await answerAction('act1', { say: 'There.' })
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get', 'state:get', 'state:patch', 'state:get', 'state:patch', 'state:get', 'state:patch', 'delivery:handedOff', 'delivery:settle'])
  // A clash that goes on is given up on in the end, with nothing acknowledged
  stand.calls.length = 0
  stand.clashes = 99
  await expect(answerAction('act1', { say: 'There.' })).rejects.toThrow('The state changed since you read it.')
  expect(stand.calls.filter((c) => c.name === 'state:patch')).toHaveLength(5)
  expect(stand.calls.some((c) => c.name.startsWith('delivery:') && c.name !== 'delivery:get')).toBe(false)
})

test('an answer that is on the page stands where the action could not be acknowledged', async () => {
  stand.action = action({ part: 'cube', request: REQUEST })
  stand.failAck = true
  await expect(answerAction('act1', { moves: [{ turn: 'right-column-down', say: 'Pull the right column down' }], say: 'One turn.' })).resolves.toMatchObject({ part: 'cube' })
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get', 'state:get', 'state:patch', 'delivery:handedOff'])
})

test('with no answer an action is acknowledged alone, and an answer with nowhere to go is refused before anything is set', async () => {
  stand.action = action({ part: 'chess' })
  expect(await answerAction('act1', undefined)).toEqual({ part: 'chess' })
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get', 'delivery:handedOff', 'delivery:settle'])
  stand.calls.length = 0
  stand.action = action({ from: 'somewhere' })
  await expect(answerAction('act1', { say: 'Hello.' })).rejects.toThrow('does not say which part of the page it is from')
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get'])
  // And an action of another page is none of the tour's to answer
  stand.calls.length = 0
  stand.action = { ...action({ part: 'room', request: REQUEST }), artifact: 'tour-chess' }
  await expect(answerAction('act1', { move: 'e7e5' })).rejects.toThrow('answers the tour’s first page, tour-start')
  expect(stand.calls.map((c) => c.name)).toEqual(['delivery:get'])
})

test('the picture an action carried is written into the folder under the name its request gives it, once', async () => {
  const carried = action({ part: 'board', request: REQUEST, saved: pictureName(REQUEST) }, { files: PNG })
  const at = await keepPicture(carried, folder)
  expect(at).toBe(path.join(folder, `.it-tour-${REQUEST}.png`))
  expect(stand.saved).toEqual([{ id: 'act1', number: 1, to: at }])
  // It is there already the second time, whichever of the connector and the agent's command wrote it
  expect(await keepPicture(carried, folder)).toBe(at)
  expect(stand.saved).toHaveLength(1)
  // Where the other wrote it while this was writing, this one's refusal is no failure
  rmSync(at!)
  stand.save = (to) => {
    writeFileSync(to, 'png')
    throw new Error('there already')
  }
  expect(await keepPicture(carried, folder)).toBe(at)
  // And where it could not be written at all, that is said
  rmSync(at!)
  stand.save = () => {
    throw new Error('disk full')
  }
  await expect(keepPicture(carried, folder)).rejects.toThrow('disk full')
})

test('nothing is written for an action that is not the first page’s, has no request of the page’s making, or carries no picture', async () => {
  const good = { part: 'board', request: REQUEST }
  for (const carried of [
    action(good),
    action(good, { files: [] }),
    action(good, { files: [{ name: 'notes.txt', type: 'text/plain', bytes: 10 }] }),
    action(good, { files: [{ name: 'huge.png', type: 'image/png', bytes: 9 * 1024 * 1024 }] }),
    action({ part: 'board' }, { files: PNG }),
    action({ part: 'board', request: '../../escape' }, { files: PNG }),
    { ...action(good, { files: PNG }), artifact: 'my-own-page' },
  ])
    expect(await keepPicture(carried, folder)).toBeUndefined()
  expect(stand.saved).toEqual([])
  expect(readdirSync(folder)).toEqual([])
})

test('the connector has a picture written as it hears of the action, once for an action, into the folder its conversation works in, and holds nothing up for it', async () => {
  const session = { harness: 'claude-code', id: 'c1' }
  const carried = { ...action({ part: 'board', request: REQUEST }, { files: PNG }), id: 'heard-1', session }
  const asked: unknown[] = []
  const folderOf = (s: { harness: string; id: string }) => {
    asked.push(s)
    return folder
  }
  expect(keepPictureFor(carried, folderOf)).toBeUndefined()
  keepPictureFor(carried, folderOf)
  await flush()
  expect(asked).toEqual([session])
  expect(stand.saved).toEqual([{ id: 'heard-1', number: 1, to: path.join(folder, pictureName(REQUEST)) }])
  // An action with no conversation, of another page, or with no file, asks nothing; and a folder that is not known writes nothing
  keepPictureFor({ ...carried, id: 'heard-2', session: null }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-3', artifact: 'plan' }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-4', files: [] }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-5' }, () => undefined)
  // One that cannot be written is left for the agent's own command, and throws nothing here
  stand.save = () => {
    throw new Error('disk full')
  }
  keepPictureFor({ ...carried, id: 'heard-6', payload: JSON.stringify({ part: 'board', request: 'cd'.repeat(16) }) }, folderOf)
  await flush()
  expect(asked).toHaveLength(2)
  expect(stand.saved.map((s) => s.id)).toEqual(['heard-1', 'heard-6'])
})

test('an answer takes its own picture away, and clearing the tour takes every picture the tour kept, and neither takes anything else', () => {
  const other = path.join(folder, 'elsewhere')
  mkdirSync(other)
  const mine = path.join(folder, pictureName(REQUEST))
  const theirs = path.join(other, pictureName('cd'.repeat(16)))
  const kept = ['sheet.png', '.it-tour-notes.png', `.it-tour-${REQUEST}.png.bak`, `it-tour-${REQUEST}.png`].map((name) => path.join(folder, name))
  for (const file of [mine, theirs, ...kept]) writeFileSync(file, 'x')
  // A folder named as a picture is named is no picture
  mkdirSync(path.join(other, pictureName('ef'.repeat(16))))
  dropPicture('../../sheet', [folder])
  dropPicture(undefined, [folder])
  expect(existsSync(mine)).toBe(true)
  dropPicture(REQUEST, [folder, undefined, folder])
  expect(existsSync(mine)).toBe(false)
  writeFileSync(mine, 'x')
  dropPictures([folder, other, undefined, path.join(folder, 'not-there')])
  expect([existsSync(mine), existsSync(theirs)]).toEqual([false, false])
  for (const file of kept) expect(existsSync(file), file).toBe(true)
  expect(existsSync(path.join(other, pictureName('ef'.repeat(16))))).toBe(true)
})
