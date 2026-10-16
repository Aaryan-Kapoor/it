import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { claimLock } from './src/legacy-lock'

let scratch: string
let file: string
const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']))
const take = (age = 10_000) => claimLock(file, age, randomBytes(8).toString('hex'))
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-lock-'))
  file = path.join(scratch, 'lock')
})
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  rmSync(scratch, { recursive: true, force: true })
})

describe('the lock shared by conversation notes and telemetry decisions', () => {
  test.each([10_000, 600_000])('recovers an empty legacy file only after its %s millisecond recovery age', (age) => {
    writeFileSync(file, '')
    utimesSync(file, 1000, 1000)
    const now = vi.spyOn(Date, 'now')
    for (const elapsed of [age - 1, age]) {
      now.mockReturnValue(1_000_000 + elapsed)
      expect(take(age)).toBeUndefined()
      expect(readFileSync(file, 'utf8')).toBe('')
    }
    now.mockReturnValue(1_000_000 + age + 1)
    const release = take(age)
    expect(release).toBeTypeOf('function')
    release!()
    expect(fs.readdirSync(scratch)).toEqual([])
  })

  test.each(['{', JSON.stringify({ pid: dead, holder: '../elsewhere' })])('leaves an unreadable owner record alone regardless of age: %s', (text) => {
    writeFileSync(file, text)
    utimesSync(file, 0, 0)
    expect(take()).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  test.each(['live owner', 'younger empty file'])('leaves a %s that replaces a legacy file before its claim is taken', (kind) => {
    writeFileSync(file, '')
    utimesSync(file, 0, 0)
    const replacement = kind === 'live owner' ? JSON.stringify({ pid: process.pid, holder: randomUUID() }) : ''
    const link = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).startsWith(`${file}.after.`)) {
        rmSync(file)
        writeFileSync(file, replacement)
      }
      return link(from, to)
    })
    syncBuiltinESMExports()
    expect(take()).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(replacement)
    expect(fs.readdirSync(scratch)).toEqual(['lock'])
  })

  test.each(['alive', 'uncertain'])('leaves an old lock whose process is %s, without waiting', (state) => {
    const owner = JSON.stringify({ pid: process.pid, holder: randomUUID() })
    writeFileSync(file, owner)
    utimesSync(file, 0, 0)
    if (state === 'uncertain')
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('cannot inspect'), { code: 'EPERM' })
      })
    const wait = vi.spyOn(Atomics, 'wait')
    expect(take()).toBeUndefined()
    expect(wait).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(owner)
  })

  test.each(['hex', 'uuid'])('recovers a dead owner with a %s holder and lets only one competing recoverer in', (format) => {
    const holder = format === 'hex' ? 'b'.repeat(16) : randomUUID()
    const previous = JSON.stringify({ pid: dead, holder })
    writeFileSync(file, previous)
    writeFileSync(`${file}.after.${holder}`, JSON.stringify({ pid: dead, holder: randomUUID() }))
    const link = fs.linkSync
    let interleaved = false
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      link(from, to)
      if (String(to).startsWith(`${file}.after.`) && !interleaved) {
        interleaved = true
        expect(take()).toBeUndefined()
        expect(readFileSync(file, 'utf8')).toBe(previous)
      }
    })
    syncBuiltinESMExports()
    const release = take()
    expect(release).toBeTypeOf('function')
    expect(interleaved).toBe(true)
    release!()
    expect(fs.readdirSync(scratch)).toEqual([])
  })

  test('leaves a replacement owner that appears before recovery takes its claim', () => {
    writeFileSync(file, JSON.stringify({ pid: dead, holder: randomUUID() }))
    const replacement = JSON.stringify({ pid: process.pid, holder: randomUUID() })
    const link = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).startsWith(`${file}.after.`)) writeFileSync(file, replacement)
      return link(from, to)
    })
    syncBuiltinESMExports()
    expect(take()).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(replacement)
    expect(fs.readdirSync(scratch)).toEqual(['lock'])
  })

  test('does not adopt a replacement found when opening the lock it just published', () => {
    const replacement = JSON.stringify({ pid: process.pid, holder: randomUUID() })
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      if (name === file) {
        rmSync(file)
        writeFileSync(file, replacement)
      }
      return open(name, flags, mode)
    })
    syncBuiltinESMExports()
    expect(take()).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(replacement)
  })

  test('leaves a replacement owner when the original invocation finishes', () => {
    const release = take()
    expect(release).toBeTypeOf('function')
    const replacement = JSON.stringify({ pid: process.pid, holder: randomUUID() })
    writeFileSync(file, replacement)
    release!()
    expect(readFileSync(file, 'utf8')).toBe(replacement)
  })

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('cleans only its own published lock when temporary cleanup fails, with recovery %s and replacement %s', (recovering, replacing) => {
    const holder = 'b'.repeat(16)
    const previous = JSON.stringify({ pid: dead, holder })
    if (recovering) writeFileSync(file, previous)
    const claimed = recovering ? `${file}.after.${holder}` : file
    const replacement = JSON.stringify({ pid: process.pid, holder: randomUUID() })
    const remove = fs.rmSync
    let failed = false
    vi.spyOn(fs, 'rmSync').mockImplementation((name, options) => {
      if (!failed && String(name).endsWith('.tmp') && existsSync(claimed)) {
        failed = true
        if (replacing) writeFileSync(claimed, replacement)
        throw Object.assign(new Error('temporary file is busy'), { code: 'EBUSY' })
      }
      return remove(name, options)
    })
    syncBuiltinESMExports()
    expect(take).toThrow()
    expect(failed).toBe(true)
    if (replacing) expect(readFileSync(claimed, 'utf8')).toBe(replacement)
    else expect(existsSync(claimed)).toBe(false)
    if (recovering) expect(readFileSync(file, 'utf8')).toBe(previous)
    if (!replacing) {
      const release = take()
      expect(release).toBeTypeOf('function')
      release!()
      expect(fs.readdirSync(scratch)).toEqual([])
    }
  })

  test('releases the published lock if the final temporary-file cleanup fails', () => {
    const remove = fs.rmSync
    let temporaryRemovals = 0
    vi.spyOn(fs, 'rmSync').mockImplementation((name, options) => {
      if (String(name).endsWith('.tmp') && ++temporaryRemovals === 2) {
        throw Object.assign(new Error('temporary file cleanup was denied'), { code: 'EPERM' })
      }
      return remove(name, options)
    })
    syncBuiltinESMExports()
    expect(take).toThrow()
    expect(existsSync(file)).toBe(false)
    const release = take()
    expect(release).toBeTypeOf('function')
    release!()
  })

  test.each([false, true])('recovers its own finished invocation after removal is temporarily denied, with recovery %s', (recovering) => {
    const holder = 'b'.repeat(16)
    if (recovering) writeFileSync(file, JSON.stringify({ pid: dead, holder }))
    const claimed = recovering ? `${file}.after.${holder}` : file
    const remove = fs.rmSync
    let denied = true
    vi.spyOn(fs, 'rmSync').mockImplementation((name, options) => {
      if (denied && (name === claimed || (String(name).endsWith('.tmp') && existsSync(claimed)))) {
        throw Object.assign(new Error('deletion is temporarily denied'), { code: 'EPERM' })
      }
      return remove(name, options)
    })
    syncBuiltinESMExports()
    expect(take).toThrow()
    expect(existsSync(claimed)).toBe(true)
    denied = false
    const release = take()
    expect(release).toBeTypeOf('function')
    release!()
    expect(existsSync(claimed)).toBe(false)
  })
})
