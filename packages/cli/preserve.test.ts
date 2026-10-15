import fs, {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { changeWhole } from './src/lib'
import { keepOriginal, ORIGINAL_LIMIT, putAbsent } from './src/preserve'

let folder: string
let file: string
const original = { renameSync: fs.renameSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync }
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-preserve-')))
  file = path.join(folder, 'settings')
})
afterEach(() => {
  Object.assign(fs, original)
  syncBuiltinESMExports()
  rmSync(folder, { recursive: true, force: true })
})
const copy = () => path.join(`${file}.it-recovery`, '1', 'original')

test.each([false, true])('keeps a save at the final move recoverable when removing is %s', (removing) => {
  writeFileSync(file, 'It\n')
  fs.renameSync = (from, to) => {
    if (from === file) writeFileSync(file, 'It\nlast external save\n')
    return original.renameSync(from, to)
  }
  syncBuiltinESMExports()
  const kept: string[] = []
  expect(
    changeWhole(
      file,
      () => (removing ? null : 'changed\n'),
      (name) => kept.push(name),
    ),
  ).toBe(true)
  expect(kept).toEqual([copy()])
  expect(readFileSync(copy(), 'utf8')).toBe('It\nlast external save\n')
  expect(removing ? !existsSync(file) : readFileSync(file, 'utf8') === 'changed\n').toBe(true)
})

test('keeps an atomic editor save made immediately before the original moves', () => {
  writeFileSync(file, 'before')
  fs.renameSync = (from, to) => {
    if (from === file) {
      const saved = path.join(folder, 'editor-save')
      writeFileSync(saved, 'atomic save')
      original.renameSync(saved, file)
    }
    return original.renameSync(from, to)
  }
  syncBuiltinESMExports()
  changeWhole(file, () => 'updated')
  expect(readFileSync(copy(), 'utf8')).toBe('atomic save')
})

test('keeps writes through an already open handle in the recovery original', () => {
  writeFileSync(file, 'before')
  const handle = openSync(file, 'w')
  try {
    changeWhole(
      file,
      () => 'updated',
      () => writeFileSync(handle, 'late handle save'),
    )
    expect(readFileSync(file, 'utf8')).toBe('updated')
    expect(readFileSync(copy(), 'utf8')).toBe('late handle save')
  } finally {
    closeSync(handle)
  }
})

test('never overwrites a file another writer recreates after the original moves', () => {
  writeFileSync(file, 'before')
  fs.linkSync = (from, to) => {
    if (to === file && !existsSync(file)) writeFileSync(file, 'new save')
    return original.linkSync(from, to)
  }
  syncBuiltinESMExports()
  expect(() => changeWhole(file, () => 'It changed it')).toThrow(/original is kept/)
  expect(readFileSync(file, 'utf8')).toBe('new save')
  expect(readFileSync(copy(), 'utf8')).toBe('before')
})

test('restores the original after publication fails and keeps its recovery name', () => {
  writeFileSync(file, 'before')
  fs.linkSync = (from, to) => {
    if (String(from).endsWith('.part')) throw Object.assign(new Error('full'), { code: 'ENOSPC' })
    return original.linkSync(from, to)
  }
  syncBuiltinESMExports()
  expect(() => changeWhole(file, () => 'after')).toThrow(/original is kept/)
  expect(readFileSync(file, 'utf8')).toBe('before')
  expect(readFileSync(copy(), 'utf8')).toBe('before')
})

test('retains twenty originals without expiring any and refuses the next change', () => {
  for (let n = 0; n < ORIGINAL_LIMIT; n++) {
    writeFileSync(file, String(n))
    expect(changeWhole(file, () => 'updated')).toBe(true)
    expect(changeWhole(file, (text) => text)).toBe(false)
  }
  writeFileSync(file, 'newest')
  expect(() => changeWhole(file, () => 'over limit')).toThrow(/20 recovery slots/)
  expect(readFileSync(file, 'utf8')).toBe('newest')
  expect(readFileSync(copy(), 'utf8')).toBe('0')
  expect(readdirSync(`${file}.it-recovery`)).toHaveLength(ORIGINAL_LIMIT + 1)
})

test('leaves an unrecognized recovery folder and the original untouched', () => {
  writeFileSync(file, 'before')
  mkdirSync(`${file}.it-recovery`)
  writeFileSync(path.join(`${file}.it-recovery`, 'owner.json'), '{}')
  expect(() => changeWhole(file, () => 'after')).toThrow(/not a recovery folder/)
  expect(readFileSync(file, 'utf8')).toBe('before')
})

test.skipIf(process.platform === 'win32')('preserves a linked profile and the modes of its target and original', () => {
  writeFileSync(file, 'before')
  chmodSync(file, 0o640)
  const profile = path.join(folder, '.profile')
  symlinkSync(file, profile)
  const link = lstatSync(profile).ino
  changeWhole(profile, () => '')
  expect(lstatSync(profile).ino).toBe(link)
  expect(readFileSync(profile, 'utf8')).toBe('')
  expect(statSync(file).mode & 0o777).toBe(0o640)
  expect(statSync(copy()).mode & 0o777).toBe(0o640)
  expect(statSync(`${file}.it-recovery`).mode & 0o777).toBe(0o700)
})

test.skipIf(process.platform === 'win32')('moves a symlink itself without touching its target', () => {
  const target = path.join(folder, 'owned-elsewhere')
  writeFileSync(target, 'user content')
  symlinkSync(target, file)
  const kept = keepOriginal(file)
  expect(lstatSync(kept).isSymbolicLink()).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe('user content')
})

test('a staging cleanup failure does not turn a published file into a failed publication', () => {
  const part = `${file}.part`
  writeFileSync(part, 'installed')
  fs.unlinkSync = (name) => {
    if (name === part) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return original.unlinkSync(name)
  }
  syncBuiltinESMExports()
  expect(() => putAbsent(part, file)).not.toThrow()
  expect(readFileSync(file, 'utf8')).toBe('installed')
})
