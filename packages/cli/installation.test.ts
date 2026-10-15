import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LICENSE } from './src/addons.generated'
import { INSTALLATION, INSTALLATION_FILE, installationHome, legacyInstallation, markedInstallation, markInstallation } from './src/installation'
import { home } from './src/lib'
import { finishInstallationRemoval, removeInstallationFiles } from './src/uninstall-files'

const folders: string[] = []
const folder = () => {
  const at = mkdtempSync(path.join(os.tmpdir(), 'it-owner-'))
  folders.push(at)
  return at
}
function put(root: string, file: string, text = 'data') {
  const at = path.join(root, file)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, text)
  return at
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const at of folders.splice(0)) rmSync(at, { recursive: true, force: true })
})

describe('installation ownership', () => {
  test('setup writes a durable marker, keeps it unchanged, and refuses an unreadable record', () => {
    const at = folder()
    markInstallation(at)
    expect(markedInstallation(at)).toBe(true)
    expect(readFileSync(path.join(at, INSTALLATION_FILE), 'utf8')).toBe(INSTALLATION)
    markInstallation(at)
    expect(readdirSync(at)).toEqual([INSTALLATION_FILE])
    put(at, INSTALLATION_FILE, '{')
    expect(() => markInstallation(at)).toThrow('is not the installation record')
    expect(() => markedInstallation(at)).toThrow('is not the installation record')
    expect(readFileSync(path.join(at, INSTALLATION_FILE), 'utf8')).toBe('{')
  })

  test('each installed executable finds its own marked home and an explicit IT_HOME wins', () => {
    const first = folder()
    const second = folder()
    markInstallation(first)
    markInstallation(second)
    const one = put(first, 'bin/it')
    const two = put(second, 'bin/it.exe')
    expect(installationHome(one)).toBe(first)
    expect(installationHome(two)).toBe(second)
    expect(installationHome(put(first, 'it'))).toBeUndefined()
    const original = process.execPath
    const originalScript = process.argv[1]
    try {
      process.execPath = one
      process.argv[1] = one
      vi.stubEnv('IT_HOME', '')
      expect(home()).toBe(first)
      vi.stubEnv('IT_HOME', second)
      expect(home()).toBe(second)
      put(first, INSTALLATION_FILE, 'invalid')
      expect(home()).toBe(second)
      vi.stubEnv('IT_HOME', '')
      expect(() => home()).toThrow('is not the installation record')
    } finally {
      process.execPath = original
      process.argv[1] = originalScript!
    }
  })

  test('source and package invocations use the default home without IT_HOME', () => {
    vi.stubEnv('IT_HOME', '')
    expect(home()).toBe(path.join(os.homedir(), '.it'))
  })

  test.skipIf(process.platform === 'win32')('an executable symlink belongs to its real installation, while a marker symlink is refused', () => {
    const first = folder()
    const second = folder()
    markInstallation(first)
    markInstallation(second)
    const program = put(first, 'bin/it')
    put(first, 'LICENSE.md', LICENSE)
    put(first, 'THIRD_PARTY_NOTICES.md')
    mkdirSync(path.join(second, 'bin'))
    symlinkSync(program, path.join(second, 'bin', 'it'))
    expect(installationHome(path.join(second, 'bin', 'it'))).toBe(first)
    expect(legacyInstallation(second, program)).toBe(false)
    expect(legacyInstallation(first, program)).toBe(true)
    rmSync(path.join(first, INSTALLATION_FILE))
    symlinkSync(path.join(second, INSTALLATION_FILE), path.join(first, INSTALLATION_FILE))
    expect(() => markedInstallation(first)).toThrow('is not the installation record')
  })

  test('legacy recognition requires the running program in its real bin folder', () => {
    const at = folder()
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    expect(installationHome(program)).toBeUndefined()
    expect(legacyInstallation(at, program)).toBe(false)
    put(at, 'LICENSE.md', LICENSE)
    put(at, 'THIRD_PARTY_NOTICES.md')
    expect(legacyInstallation(at, program)).toBe(true)
    expect(legacyInstallation(at, program, '/checkout/it.mjs')).toBe(false)
    expect(installationHome(program)).toBe(at)
    expect(installationHome(program, '/checkout/it.mjs')).toBeUndefined()
    expect(legacyInstallation(at)).toBe(false)
    put(at, 'machine.json', '{"id":"other","key":{}}')
    put(at, 'addons/pi.json', '{"installs":[]}')
    expect(markedInstallation(at)).toBe(false)
    expect(legacyInstallation(at)).toBe(false)
  })

  test('cleanup removes recognized data and keys while keeping unknown siblings at every level', () => {
    const at = folder()
    markInstallation(at)
    for (const file of [
      'service.json',
      'machine.json',
      'token.json',
      'push.json',
      'conversations.json',
      'conversation-notes-erasing',
      'backend/db.sqlite3',
      'backend/db.sqlite3-wal',
      'backend/data.json',
      'content-data/content.sqlite',
      'bin/it',
    ])
      put(at, file)
    const backup = 'backend/before-functions-123456789abc'
    put(at, `${backup}/copy.json`, JSON.stringify({ copy: 'before-functions-123456789abc', id: '123456789abcdef0', order: 1, it: '0.1.22' }))
    put(at, `${backup}/db.sqlite3`)
    const prefix = 'u/person/page/version'
    const name = createHash('sha256').update('index.html').digest('hex')
    put(at, `content/manifest/${prefix}/files.json`, JSON.stringify([{ path: 'index.html', size: 4, sha256: 'a'.repeat(64) }]))
    put(at, `content/${prefix}/${name}`)
    const kept = [
      'project.txt',
      'backend/notes.txt',
      `${backup}/notes.txt`,
      'backend/storage/unknown',
      'content-data/notes.txt',
      `content/${prefix}/notes.txt`,
      'addons/pi/notes.txt',
      'bin/other',
    ]
    for (const file of kept) put(at, file, 'mine')
    expect(removeInstallationFiles(at, false)).toEqual(expect.arrayContaining(['project.txt', 'backend', 'content']))
    for (const file of kept) expect(readFileSync(path.join(at, file), 'utf8')).toBe('mine')
    for (const file of [
      'machine.json',
      'token.json',
      'push.json',
      'conversations.json',
      'conversation-notes-erasing',
      'backend/db.sqlite3',
      `${backup}/db.sqlite3`,
      `content/${prefix}/${name}`,
      'content-data/content.sqlite',
    ])
      expect(existsSync(path.join(at, file))).toBe(false)
  })

  test('a malformed page manifest and its files stay, while a clean installation can be removed completely', () => {
    const at = folder()
    markInstallation(at)
    put(at, 'content/manifest/u/a/b/c/files.json', '{')
    put(at, 'content/u/a/b/c/page', 'mine')
    expect(removeInstallationFiles(at, false)).toEqual(['content'])
    expect(readFileSync(path.join(at, 'content/u/a/b/c/page'), 'utf8')).toBe('mine')
    const clean = folder()
    markInstallation(clean)
    put(clean, 'backend/db.sqlite3')
    put(clean, 'machine.json')
    put(clean, 'bin/it')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)
  })

  test('cleanup keeps a held shutdown lock and removes only empty folders after its owner releases it', () => {
    const at = folder()
    markInstallation(at)
    put(at, 'backend/lock', 'owned by the shutdown barrier')
    put(at, 'backend/db.sqlite3')
    expect(removeInstallationFiles(at, false)).toEqual(['backend'])
    expect(readFileSync(path.join(at, 'backend/lock'), 'utf8')).toBe('owned by the shutdown barrier')
    rmSync(path.join(at, 'backend/lock'))
    expect(finishInstallationRemoval(at)).toEqual([])
    expect(existsSync(at)).toBe(false)
    const kept = folder()
    put(kept, 'backend/notes.txt', 'mine')
    expect(finishInstallationRemoval(kept)).toEqual(['backend'])
    expect(readFileSync(path.join(kept, 'backend/notes.txt'), 'utf8')).toBe('mine')
  })

  test.skipIf(process.platform === 'win32')('cleanup never follows linked directories or removes linked records', () => {
    const at = folder()
    const outside = folder()
    markInstallation(at)
    put(outside, 'db.sqlite3', 'mine')
    mkdirSync(path.join(outside, 'storage'))
    symlinkSync(outside, path.join(at, 'backend'), 'dir')
    symlinkSync(path.join(outside, 'db.sqlite3'), path.join(at, 'machine.json'))
    symlinkSync(path.join(outside, 'missing'), path.join(at, 'token.json'))
    expect(removeInstallationFiles(at, false).sort()).toEqual(['backend', 'machine.json', 'token.json'])
    expect(readFileSync(path.join(outside, 'db.sqlite3'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(outside, 'storage'))).toBe(true)
    expect(lstatSync(path.join(at, 'machine.json')).isSymbolicLink()).toBe(true)
  })
})
