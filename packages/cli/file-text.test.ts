import type fs from 'node:fs'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Stands in for a system that cannot refuse a link as it opens a file, as Windows cannot: there is
// no O_NOFOLLOW, the open follows links, a test can swap the file for a link in the moment between
// the look and the open, and a file system may give a file an id that tells it apart from no other
const sim: { before?: () => void; ino?: bigint } = {}
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const { O_NOFOLLOW: _, ...constants } = real.constants
  const withIno = <T>(stat: T): T => (sim.ino === undefined || stat === undefined ? stat : (Object.assign(stat as object, { ino: sim.ino }) as T))
  const openSync = ((file: fs.PathLike, flags: number, ...rest: unknown[]) => {
    sim.before?.()
    sim.before = undefined
    return (real.openSync as (...a: unknown[]) => number)(file, flags, ...rest)
  }) as typeof real.openSync
  const lstatSync = ((...a: unknown[]) => withIno((real.lstatSync as (...b: unknown[]) => unknown)(...a))) as typeof real.lstatSync
  const fstatSync = ((...a: unknown[]) => withIno((real.fstatSync as (...b: unknown[]) => unknown)(...a))) as typeof real.fstatSync
  const mocked = { ...real, constants, openSync, lstatSync, fstatSync }
  return { ...mocked, default: mocked }
})

const { fileText } = await import('./src/args')

const made: string[] = []
afterEach(() => {
  sim.before = undefined
  sim.ino = undefined
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-file-text-'))
  made.push(dir)
  return dir
}

describe.skipIf(process.platform === 'win32')('JSON read from a file, where the system cannot refuse a link as it opens one', () => {
  test('a file swapped for a link after it was looked at is refused, and the other file is not read', () => {
    const dir = folder()
    const secret = path.join(dir, 'secret.json')
    writeFileSync(secret, '{"token":"made-up-private"}')
    const file = path.join(dir, 'state.json')
    writeFileSync(file, '{"plain":true}')
    sim.before = () => {
      renameSync(file, path.join(dir, 'moved.json'))
      symlinkSync(secret, file)
    }
    expect(() => fileText(file, 'the patch')).toThrow(/is a link/)
  })

  for (const [said, ino] of [
    ['0, kept by no file system', 0n],
    ['every bit set, made unique by none', 0xffffffffffffffffn],
  ] as const)
    test(`a file whose id is ${said} is not read, swapped for a link or not`, () => {
      const dir = folder()
      const secret = path.join(dir, 'secret.json')
      writeFileSync(secret, '{"token":"made-up-private"}')
      const file = path.join(dir, 'state.json')
      writeFileSync(file, '{"plain":true}')
      sim.ino = ino
      sim.before = () => {
        renameSync(file, path.join(dir, 'moved.json'))
        symlinkSync(secret, file)
      }
      expect(() => fileText(file, 'the patch')).toThrow(/cannot tell on this drive/)
      // And left as it was, it is refused all the same, since nothing tells it apart
      writeFileSync(path.join(dir, 'other.json'), '{"plain":true}')
      sim.ino = ino
      expect(() => fileText(path.join(dir, 'other.json'), 'the patch')).toThrow(/cannot tell on this drive/)
    })

  test('a file left as it was, with an id of its own, is read', () => {
    const file = path.join(folder(), 'state.json')
    writeFileSync(file, '{"plain":true}')
    expect(fileText(file, 'the patch')).toBe('{"plain":true}')
  })
})
