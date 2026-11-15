// What `it tour answer` does with an action of the tour's first page, and the picture It keeps
// for the agent: whose page has one written, what is written, where, and what takes it away
// again.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { deepMerge } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const stand = vi.hoisted(() => ({
  calls: [] as { name: string; args: any }[],
  action: null as any,
  saved: [] as { id: string; number: number; to: string }[],
  save: null as null | ((to: string) => void),
  /** What the file an action carried holds, as It would hand it over. */
  bytes: Buffer.alloc(0),
  /** Whether the backend says the action was done on the tour's first page as this machine published it. */
  ownTour: true,
  /** Whether the name beside a picture is made with no randomness. */
  fixedSuffix: false,
  /** Whether writing a private file of It's fails, and what to do as one is written. */
  failWrite: false,
  onWrite: null as null | (() => void),
  failAck: false,
  state: {} as Record<string, unknown>,
  revision: 6,
  clashes: 0,
}))
// The four random bytes the name beside a picture is made with are none where a test says, so that it can put a file of that name there first
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>()
  return { ...real, randomBytes: (size: number) => (size === 4 && stand.fixedSuffix ? Buffer.alloc(4) : real.randomBytes(size)) }
})
vi.mock('./src/lib', async (original) => {
  const real = await original<typeof import('./src/lib')>()
  return {
    ...real,
    writePrivate: (file: string, data: unknown) => {
      stand.onWrite?.()
      if (stand.failWrite) throw new Error('disk full')
      return real.writePrivate(file, data)
    },
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
      if (name === 'tour:picture') return stand.ownTour
      return null
    },
  }
})
// Reads the file an action carried into a file that is made anew, as the real one does, with what `stand.bytes` holds
vi.mock('./src/files', () => ({
  saveAttached: async (id: string, number: number, to: string) => {
    stand.saved.push({ id, number, to })
    if (stand.save) stand.save(to)
    writeFileSync(to, stand.bytes, { flag: 'wx', mode: 0o600 })
    return { file: to, number, name: 'sheet.png', type: 'image/png', bytes: stand.bytes.length }
  },
}))

import {
  answerAction,
  askedBy,
  dropPicture,
  dropPictures,
  isPng,
  keepPicture,
  keepPictureFor,
  keptPictures,
  MOST_BYTES,
  pictureName,
  picturesFile,
  replacing,
  START_SLUG,
} from './src/tour-answer'

/** A chunk of a PNG, with the checksum it carries, made with Node's own. */
const chunk = (type: string, data: Buffer, crc?: number) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc ?? crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, sum])
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const header = (width = 4, height = 3) => {
  const h = Buffer.alloc(13)
  h.writeUInt32BE(width, 0)
  h.writeUInt32BE(height, 4)
  h[8] = 8
  h[9] = 6
  return h
}
/** A real picture, as the whiteboard makes one: white, `width` by `height`, with `seed` in its pixels so that two can differ. */
const picture = (seed = 1, width = 4, height = 3) => {
  const rows = Buffer.alloc((width * 4 + 1) * height, 0xff)
  rows[1] = seed & 0xff
  return Buffer.concat([SIGNATURE, chunk('IHDR', header(width, height)), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const REQUEST = 'ab'.repeat(16)
const PNG = [{ name: 'sheet.png', type: 'image/png', bytes: 2048 }]
const action = (data: unknown, more: Record<string, unknown> = {}) => ({ id: 'act1', artifact: START_SLUG, payload: JSON.stringify(data), ...more })
let folder: string
let itHome: string
const wasHome = process.env.IT_HOME
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-tour-answer-'))
  itHome = mkdtempSync(path.join(os.tmpdir(), 'it-tour-home-'))
  process.env.IT_HOME = itHome
  stand.bytes = picture()
  stand.ownTour = true
  stand.failWrite = false
  stand.onWrite = null
  stand.fixedSuffix = false
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(itHome, { recursive: true, force: true })
  if (wasHome === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = wasHome
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
  stand.state = {
    board: { blind: true, hint: 'Count the rows', say: 'I cannot see it.', request: 'cd'.repeat(16), deep: { a: 1, b: 2 } },
    room: { lamp: true },
  }
  await answerAction('act1', { read: '144', right: true, say: 'Right.', deep: { a: 3 } })
  const patched = stand.calls.find((c) => c.name === 'state:patch')!.args
  // Held to the revision it was read at, and taking away, at every depth, what the new answer does not say. Another part is not touched
  expect(patched.baseRevision).toBe(6)
  expect(JSON.parse(patched.patch)).toEqual({
    board: { blind: null, hint: null, read: '144', right: true, say: 'Right.', request: REQUEST, deep: { a: 3, b: null } },
  })
  // Which, merged as the state merges a patch, leaves the new answer and nothing else
  expect(deepMerge(stand.state, JSON.parse(patched.patch))).toEqual({
    board: { read: '144', right: true, say: 'Right.', request: REQUEST, deep: { a: 3 } },
    room: { lamp: true },
  })
  expect(replacing('text', { a: 1 })).toEqual({ a: 1 })
  expect(replacing({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  expect(replacing({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: 'x' })
})

test('where the state changed between reading it and writing the answer, it is read again, and a refusal of another kind is not tried again', async () => {
  stand.action = action({ part: 'room', request: REQUEST })
  stand.clashes = 2
  await answerAction('act1', { say: 'There.' })
  expect(stand.calls.map((c) => c.name)).toEqual([
    'delivery:get',
    'state:get',
    'state:patch',
    'state:get',
    'state:patch',
    'state:get',
    'state:patch',
    'delivery:handedOff',
    'delivery:settle',
  ])
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
  await expect(answerAction('act1', { moves: [{ turn: 'right-column-down', say: 'Pull the right column down' }], say: 'One turn.' })).resolves.toMatchObject({
    part: 'cube',
  })
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

const at = (request = REQUEST, where = folder) => path.join(where, pictureName(request))
const recorded = () => keptPictures()?.map((k) => ({ file: k.file, bytes: k.bytes }))

test('a picture is a whole PNG, chunk by chunk, with the checksum each says and nothing after its end', () => {
  expect(isPng(picture())).toBe(true)
  const whole = picture()
  const bad = [
    Buffer.from('#!/bin/sh\necho this is no picture\n'),
    // Its signature and header alone, or cut short anywhere
    whole.subarray(0, 33),
    whole.subarray(0, 17),
    whole.subarray(0, whole.length - 1),
    // Anything after its end
    Buffer.concat([whole, Buffer.from('more')]),
    // A checksum that is not the chunk's
    Buffer.concat([SIGNATURE, chunk('IHDR', header(), 0), chunk('IDAT', deflateSync(Buffer.alloc(51))), chunk('IEND', Buffer.alloc(0))]),
    // No image data, a header that is not first, and a picture of no size or too large a size
    Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IEND', Buffer.alloc(0))]),
    Buffer.concat([SIGNATURE, chunk('IDAT', Buffer.alloc(4)), chunk('IHDR', header()), chunk('IEND', Buffer.alloc(0))]),
    Buffer.concat([SIGNATURE, chunk('IHDR', header(0, 3)), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]),
    Buffer.concat([SIGNATURE, chunk('IHDR', header(9000, 3)), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]),
  ]
  for (const bytes of bad) expect(isPng(bytes), bytes.subarray(0, 40).toString('hex')).toBe(false)
})

test('the picture an action carried is written into the folder under the name its request gives it, once, and noted as It’s own', async () => {
  const carried = action({ part: 'board', request: REQUEST, saved: pictureName(REQUEST) }, { files: PNG })
  expect(await keepPicture(carried, folder)).toBe(at())
  expect(readFileSync(at())).toEqual(picture())
  expect(stand.calls.filter((c) => c.name === 'tour:picture').map((c) => c.args)).toEqual([{ id: 'act1' }])
  expect(recorded()).toEqual([{ file: at(), bytes: picture().length }])
  // It is there already the second time, whichever of the connector and the agent's command wrote it
  expect(await keepPicture(carried, folder)).toBe(at())
  expect(stand.saved).toHaveLength(1)
  // And where both write it at once, the one that comes second takes the other's for the picture
  const other = action({ part: 'board', request: 'cd'.repeat(16) }, { files: PNG })
  expect(await Promise.all([keepPicture(other, folder), keepPicture(other, folder)])).toEqual([at('cd'.repeat(16)), at('cd'.repeat(16))])
  expect(readdirSync(folder).sort()).toEqual([pictureName(REQUEST), pictureName('cd'.repeat(16))].sort())
  expect(recorded()).toHaveLength(2)
  // Nothing is left of the copies It read them into first
  expect(readdirSync(path.join(itHome, 'tour-pictures'))).toEqual([])
  // And the record knows each for the file of the disk it is
  const [first] = keptPictures()!
  const seen = lstatSync(at(), { bigint: true })
  expect([first!.dev, first!.ino]).toEqual([String(seen.dev), String(seen.ino)])
})

test('nothing is written for a page the backend does not say this machine published as the tour’s, as one an agent or another machine published under its id', async () => {
  stand.ownTour = false
  expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)).toBeUndefined()
  expect(stand.saved).toEqual([])
  expect(readdirSync(folder)).toEqual([])
  expect(keptPictures()).toEqual([])
})

test('nothing is written for an action that is not the first page’s, has no request of the page’s making, carries no single PNG, or carries one too large', async () => {
  const good = { part: 'board', request: REQUEST }
  for (const carried of [
    action(good),
    action(good, { files: [] }),
    action(good, { files: [{ name: 'notes.txt', type: 'text/plain', bytes: 10 }] }),
    action(good, { files: [...PNG, ...PNG] }),
    action(good, { files: [{ name: 'huge.png', type: 'image/png', bytes: MOST_BYTES + 1 }] }),
    action({ part: 'board' }, { files: PNG }),
    action({ part: 'board', request: '../../escape' }, { files: PNG }),
    { ...action(good, { files: PNG }), artifact: 'my-own-page' },
  ])
    expect(await keepPicture(carried, folder)).toBeUndefined()
  // Nor into a folder that is not named from the root, or none at all
  expect(await keepPicture(action(good, { files: PNG }), 'relative/folder')).toBeUndefined()
  expect(await keepPicture(action(good, { files: PNG }), undefined)).toBeUndefined()
  expect(stand.saved).toEqual([])
  expect(readdirSync(folder)).toEqual([])
})

test('what is said to be a PNG and is not one, or is longer than the most that is kept, never reaches the folder at all', async () => {
  const carried = action({ part: 'board', request: REQUEST }, { files: PNG })
  // While it is read, nothing of it is in the folder: it is read into It's own
  stand.save = () => expect(readdirSync(folder)).toEqual([])
  for (const bytes of [
    Buffer.from('#!/bin/sh\necho this is no picture\n'),
    Buffer.alloc(0),
    picture().subarray(0, 40),
    Buffer.concat([picture(), Buffer.from('#!/bin/sh')]),
    Buffer.concat([picture(1, 1280, 1280).subarray(0, 33), Buffer.alloc(MOST_BYTES)]),
  ]) {
    stand.bytes = bytes
    expect(await keepPicture(carried, folder)).toBeUndefined()
    expect(readdirSync(folder)).toEqual([])
    expect(readdirSync(path.join(itHome, 'tour-pictures'))).toEqual([])
    expect(keptPictures()).toEqual([])
  }
  expect(stand.saved).toHaveLength(5)
})

test('a file that is there under the picture’s name and that It did not write is never written over, followed or said to be the picture', async () => {
  const carried = action({ part: 'board', request: REQUEST }, { files: PNG })
  // A file of the person's
  writeFileSync(at(), 'the person’s own')
  expect(await keepPicture(carried, folder)).toBeUndefined()
  expect(readFileSync(at(), 'utf8')).toBe('the person’s own')
  rmSync(at())
  // A link out of the folder, to a file and to nothing, where links can be made
  const outside = mkdtempSync(path.join(os.tmpdir(), 'it-tour-outside-'))
  try {
    const target = path.join(outside, 'target')
    writeFileSync(target, 'outside')
    let linked = true
    try {
      symlinkSync(target, at())
    } catch {
      linked = false
    }
    if (linked) {
      expect(await keepPicture(carried, folder)).toBeUndefined()
      expect(readFileSync(target, 'utf8')).toBe('outside')
      rmSync(at())
      symlinkSync(path.join(outside, 'not-there'), at())
      expect(await keepPicture(carried, folder)).toBeUndefined()
      expect(existsSync(path.join(outside, 'not-there'))).toBe(false)
      expect(readdirSync(outside)).toEqual(['target'])
      rmSync(at())
    }
    // A file that turned up under the name while the picture was on its way, which is not the picture
    stand.save = () => writeFileSync(at(), 'came meanwhile')
    expect(await keepPicture(carried, folder)).toBeUndefined()
    expect(readFileSync(at(), 'utf8')).toBe('came meanwhile')
    expect(keptPictures()).toEqual([])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('where the record of the pictures It wrote cannot be read, no picture is written, since none could be told for It’s own', async () => {
  writeFileSync(picturesFile(), 'not as It writes it')
  expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)).toBeUndefined()
  expect(readdirSync(folder)).toEqual([])
  expect(readFileSync(picturesFile(), 'utf8')).toBe('not as It writes it')
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
  await vi.waitFor(() => expect(existsSync(at())).toBe(true))
  expect(asked).toEqual([session])
  expect(stand.saved.map((s) => s.id)).toEqual(['heard-1'])
  // An action with no conversation, of another page, or with no file, asks nothing; and a folder that is not known writes nothing
  keepPictureFor({ ...carried, id: 'heard-2', session: null }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-3', artifact: 'plan' }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-4', files: [] }, folderOf)
  keepPictureFor({ ...carried, id: 'heard-5' }, () => undefined)
  // Nor for a page that is not the tour's own as this machine published it
  stand.ownTour = false
  keepPictureFor({ ...carried, id: 'heard-6', payload: JSON.stringify({ part: 'board', request: 'ef'.repeat(16) }) }, folderOf)
  // One that cannot be written is left for the agent's own command, and throws nothing here
  stand.ownTour = true
  stand.save = () => {
    throw new Error('disk full')
  }
  keepPictureFor({ ...carried, id: 'heard-7', payload: JSON.stringify({ part: 'board', request: 'cd'.repeat(16) }) }, folderOf)
  await vi.waitFor(() => expect(stand.saved.map((s) => s.id)).toEqual(['heard-1', 'heard-7']))
  await flush()
  expect(asked).toHaveLength(3)
  expect(readdirSync(folder)).toEqual([pictureName(REQUEST)])
})

test('an answer takes away only the picture It wrote for its request, and only while that file is still the picture', async () => {
  const carried = action({ part: 'board', request: REQUEST }, { files: PNG })
  await keepPicture(carried, folder)
  await dropPicture('../../sheet')
  await dropPicture(undefined)
  expect(existsSync(at())).toBe(true)
  await dropPicture(REQUEST)
  expect(existsSync(at())).toBe(false)
  expect(keptPictures()).toEqual([])
  // A file of that name that It did not write stays
  writeFileSync(at(), 'the person’s own')
  await dropPicture(REQUEST)
  expect(readFileSync(at(), 'utf8')).toBe('the person’s own')
  rmSync(at())
  // And so does the picture once something else has been written in its place
  await keepPicture(carried, folder)
  writeFileSync(at(), 'changed since')
  await dropPicture(REQUEST)
  expect(readFileSync(at(), 'utf8')).toBe('changed since')
})

test('clearing the tour takes away every picture It wrote that is still as It wrote it, and leaves anything else, saying what it left', async () => {
  const other = path.join(folder, 'elsewhere')
  mkdirSync(other)
  await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)
  await keepPicture(action({ part: 'board', request: 'cd'.repeat(16) }, { files: PNG }), other)
  await keepPicture(action({ part: 'board', request: '12'.repeat(16) }, { files: PNG }), other)
  // Changed since It wrote it
  writeFileSync(at('12'.repeat(16), other), 'changed since')
  // Named as the tour names its pictures, and never written by It
  const theirs = at('ef'.repeat(16))
  writeFileSync(theirs, 'x')
  const kept = ['sheet.png', '.it-tour-notes.png', `.it-tour-${REQUEST}.png.bak`, `it-tour-${REQUEST}.png`].map((name) => path.join(folder, name))
  for (const file of kept) writeFileSync(file, 'x')
  const cleared = await dropPictures([folder, undefined, path.join(folder, 'not-there')])
  expect(cleared).toEqual({ removed: 2, left: [theirs, at('12'.repeat(16), other)].sort() })
  expect([existsSync(at()), existsSync(at('cd'.repeat(16), other))]).toEqual([false, false])
  expect(readFileSync(at('12'.repeat(16), other), 'utf8')).toBe('changed since')
  for (const file of [theirs, ...kept]) expect(existsSync(file), file).toBe(true)
  expect(keptPictures()).toEqual([])
})

test('where the record cannot be read, clearing the tour removes no picture, and says so with every file it left', async () => {
  await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)
  writeFileSync(picturesFile(), '{"pictures": "not a list"}')
  expect(await dropPictures([folder])).toEqual({ removed: 0, left: [at()], unread: true })
  expect(existsSync(at())).toBe(true)
})

test('a file put in the place of a picture It wrote is not taken for it, though its bytes are the same', async () => {
  await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)
  // The same bytes, in another file of the disk, under the picture's name
  copyFileSync(at(), `${at()}.copy`)
  renameSync(`${at()}.copy`, at())
  expect(await dropPicture(REQUEST)).toEqual({ left: [at()] })
  expect(existsSync(at())).toBe(true)
  expect(keptPictures()).toEqual([])
  // And clearing the tour leaves it too, and says so
  expect(await dropPictures([folder])).toEqual({ removed: 0, left: [at()] })
  expect(existsSync(at())).toBe(true)
})

test('a picture that has its name and cannot be noted is taken away again, since nothing could tell it for It’s own', async () => {
  stand.failWrite = true
  expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)).toBeUndefined()
  expect(readdirSync(folder)).toEqual([])
})

test('the picture is a second name of the file It looked at in its own folder, given as it is noted, and nothing else is made in the person’s folder', async () => {
  const seen: string[][] = []
  stand.onWrite = () => seen.push(readdirSync(folder))
  expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)).toBe(at())
  // While the record was written the picture had its name already, and nothing else was there
  expect(seen.at(-1)).toEqual([pictureName(REQUEST)])
  expect(readdirSync(folder)).toEqual([pictureName(REQUEST)])
  expect(readdirSync(path.join(itHome, 'tour-pictures'))).toEqual([])
})

test('a file that is there under any name the picture might pass through is the person’s, and stays', async () => {
  // A name of the kind the picture is written under beside where it goes, made by someone else
  stand.fixedSuffix = true
  const theirs = path.join(folder, `${pictureName(REQUEST)}.00000000.part`)
  writeFileSync(theirs, 'theirs')
  expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)).toBe(at())
  expect(readFileSync(theirs, 'utf8')).toBe('theirs')
})

// Where the person's folder is on another disk than It's, which a file cannot have a second name across
const shm = '/dev/shm'
const otherDisk = process.platform === 'linux' && existsSync(shm) && lstatSync(shm).dev !== lstatSync(os.tmpdir()).dev
test.skipIf(!otherDisk)(
  'on another disk than It’s folder, Linux writes the picture beside where it goes, for the person alone, and notes that file',
  async () => {
    const there = mkdtempSync(path.join(shm, 'it-tour-other-'))
    try {
      expect(await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), there)).toBe(at(REQUEST, there))
      expect(readdirSync(there)).toEqual([pictureName(REQUEST)])
      expect(lstatSync(at(REQUEST, there)).mode & 0o077).toBe(0)
      expect(readFileSync(at(REQUEST, there))).toEqual(picture())
      expect(await dropPicture(REQUEST)).toEqual({ left: [] })
      expect(readdirSync(there)).toEqual([])
    } finally {
      rmSync(there, { recursive: true, force: true })
    }
  },
)

test('an answer says which picture it left, and that it could not tell, where the record cannot be read', async () => {
  await keepPicture(action({ part: 'board', request: REQUEST }, { files: PNG }), folder)
  writeFileSync(at(), 'changed since')
  expect(await dropPicture(REQUEST)).toEqual({ left: [at()] })
  writeFileSync(picturesFile(), 'not as It writes it')
  expect(await dropPicture('cd'.repeat(16))).toEqual({ left: [], unread: true })
})
