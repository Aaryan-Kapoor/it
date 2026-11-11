import type fs from 'node:fs'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Stands in for a system that cannot refuse a link as it opens a file, as Windows cannot: the open
// follows links, and a test can swap the file for a link in the moment between the look and the open
const swap: { before?: () => void } = {}
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const openSync = ((file: fs.PathLike, flags: number, ...rest: unknown[]) => {
    swap.before?.()
    swap.before = undefined
    return (real.openSync as (...a: unknown[]) => number)(file, flags & ~(real.constants.O_NOFOLLOW ?? 0), ...rest)
  }) as typeof real.openSync
  return { ...real, default: { ...real, openSync }, openSync }
})

const { fileText } = await import('./src/args')

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('JSON read from a file, where the system cannot refuse a link as it opens one', () => {
  test('a file swapped for a link after it was looked at is refused, and the other file is not read', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'it-file-text-'))
    made.push(dir)
    const secret = path.join(dir, 'secret.json')
    writeFileSync(secret, '{"token":"made-up-private"}')
    const file = path.join(dir, 'state.json')
    writeFileSync(file, '{"plain":true}')
    swap.before = () => {
      renameSync(file, path.join(dir, 'moved.json'))
      symlinkSync(secret, file)
    }
    expect(() => fileText(file, 'the patch')).toThrow(/is a link/)
  })

  test('a file left as it was is read', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'it-file-text-'))
    made.push(dir)
    const file = path.join(dir, 'state.json')
    writeFileSync(file, '{"plain":true}')
    expect(fileText(file, 'the patch')).toBe('{"plain":true}')
  })
})
