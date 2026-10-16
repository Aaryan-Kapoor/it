import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ADDONS, LICENSE } from './src/addons.generated'
import { INSTALLATION, INSTALLATION_FILE, installationHome, legacyInstallation, markedInstallation, markInstallation } from './src/installation'
import { home } from './src/lib'
import { aloneAt } from './src/serve/backend'
import { unpack } from './src/setup'
import { finishInstallationRemoval, removeInstallationFiles, withInstallationLock } from './src/uninstall-files'

const folders: string[] = []
const folder = () => {
  const at = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-owner-')))
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

  test('a folder alias keeps the installation spelling used by its launcher and PATH', () => {
    const parent = folder()
    const physical = path.join(parent, 'physical')
    const alias = path.join(parent, 'installed')
    markInstallation(physical)
    put(physical, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    symlinkSync(physical, alias, 'junction')
    const executable = path.join(alias, 'bin', process.platform === 'win32' ? 'it.exe' : 'it')
    expect(installationHome(executable)).toBe(alias)
    expect(realpathSync(installationHome(executable)!)).toBe(physical)
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

  test.each([{ made: undefined }, { erased: false }])('cleanup retains backups with an incomplete ownership record: %j', (damaged) => {
    const at = folder()
    markInstallation(at)
    const copy = 'before-functions-123456789abc'
    const note = { copy, id: '123456789abcdef0', made: Date.now(), order: 1, it: '0.1.22', ...damaged }
    put(at, `backend/${copy}/copy.json`, JSON.stringify(note))
    const database = put(at, `backend/${copy}/db.sqlite3`, 'must remain')
    removeInstallationFiles(at, false)
    expect(readFileSync(database, 'utf8')).toBe('must remain')
    expect(JSON.parse(readFileSync(path.join(at, `backend/${copy}/copy.json`), 'utf8'))).toEqual(JSON.parse(JSON.stringify(note)))
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
      'heard.json',
      'addons/asked-for.json',
      'bin/it.old.1780000000000.exe',
      'backend/db.sqlite3',
      'backend/db.sqlite3-wal',
      'backend/data.json',
      'content-data/content.sqlite',
      'bin/it',
    ])
      put(at, file)
    const backup = 'backend/before-functions-123456789abc'
    put(at, `${backup}/copy.json`, JSON.stringify({ copy: 'before-functions-123456789abc', id: '123456789abcdef0', made: Date.now(), order: 1, it: '0.1.22' }))
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
      'bin/it.old.notes.exe',
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
      'heard.json',
      'addons/asked-for.json',
      'bin/it.old.1780000000000.exe',
      'backend/db.sqlite3',
      `${backup}/db.sqlite3`,
      `content/${prefix}/${name}`,
      'content-data/content.sqlite',
    ])
      expect(existsSync(path.join(at, file))).toBe(false)
  })

  test('cleanup removes quarantined run records and keeps similarly named files', () => {
    const clean = folder()
    markInstallation(clean)
    put(clean, 'runs.json.unreadable', '{')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)

    const kept = folder()
    markInstallation(kept)
    put(kept, 'runs.json.unreadable.notes', 'mine')
    expect(removeInstallationFiles(kept, false)).toEqual(['runs.json.unreadable.notes'])
    expect(readFileSync(path.join(kept, 'runs.json.unreadable.notes'), 'utf8')).toBe('mine')
  })

  test('cleanup removes reopened-run logs and keeps similarly named files', () => {
    const clean = folder()
    markInstallation(clean)
    put(clean, 'logs/reopened-123-4.txt', 'interrupted run')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)

    const kept = folder()
    markInstallation(kept)
    for (const name of ['reopened-notes.txt', 'reopened-123-4.txt.notes', 'reopened-123-4.txt/notes']) put(kept, `logs/${name}`, 'mine')
    expect(removeInstallationFiles(kept, false)).toEqual(['logs'])
    for (const name of ['reopened-notes.txt', 'reopened-123-4.txt.notes', 'reopened-123-4.txt/notes'])
      expect(readFileSync(path.join(kept, 'logs', name), 'utf8')).toBe('mine')
  })

  test.each(['upgrade', 'backend'])('cleanup removes abandoned %s downloads and preserves live or unknown files', (kind) => {
    const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const directory = kind === 'upgrade' ? 'bin' : 'backend/bin/precompiled-2026-01-01-1234567'
    const names = (pid: number) =>
      kind === 'upgrade'
        ? [`.it-upgrade-${pid}`, `.it-upgrade-${pid}.exe`, `.it-upgrade-${pid}.${pid}.part`, `.it-upgrade-${pid}.exe.${pid}.part`]
        : [`convex-local-backend.${pid}.part`, `convex-local-backend.exe.${pid}.part`]
    const clean = folder()
    markInstallation(clean)
    for (const name of names(dead)) put(clean, `${directory}/${name}`)
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)

    const kept = folder()
    markInstallation(kept)
    const unknown = [...names(process.pid), ...names(dead).map((name) => `${name}.notes`), `${names(dead)[0]}/notes`]
    if (kind === 'backend') unknown.push('../personal/convex-local-backend.123.part')
    for (const name of unknown) put(kept, `${directory}/${name}`, 'mine')
    expect(removeInstallationFiles(kept, false)).toEqual([kind === 'upgrade' ? 'bin' : 'backend'])
    for (const name of unknown) expect(readFileSync(path.join(kept, directory, name), 'utf8')).toBe('mine')
  })

  test.skipIf(process.platform === 'win32')('cleanup preserves linked upgrade and backend downloads and their targets', () => {
    const at = folder()
    const outside = put(folder(), 'mine', 'mine')
    const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const files = [`bin/.it-upgrade-${dead}`, `backend/bin/precompiled-2026-01-01-1234567/convex-local-backend.${dead}.part`]
    for (const file of files) {
      mkdirSync(path.dirname(path.join(at, file)), { recursive: true })
      symlinkSync(outside, path.join(at, file))
    }
    removeInstallationFiles(at, false)
    for (const file of files) expect(lstatSync(path.join(at, file)).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('mine')
  })

  test.each([false, true])('cleanup removes dead upgrade locks and their sidecars, with unknown files: %s', async (unknown) => {
    const at = folder()
    markInstallation(at)
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    const lock = `${program}.upgrade.lock`
    let owner: any
    await aloneAt(lock, async () => {
      owner = JSON.parse(readFileSync(lock, 'utf8'))
    })
    owner.pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const record = JSON.stringify(owner)
    const dead = [lock, `${lock}.after.${owner.holder}`, `${lock}.${owner.holder}.tmp`, `${lock}.after.${owner.holder}.${owner.holder}.tmp`]
    for (const file of dead) writeFileSync(file, file === `${lock}.after.${owner.holder}` ? JSON.stringify({ ...owner, holder: 'a'.repeat(16) }) : record)
    const kept = [`${lock}.notes`, `${lock}.after.1234567890abcdef`]
    if (unknown) for (const file of kept) writeFileSync(file, 'mine')
    await withInstallationLock(at, async () => {
      removeInstallationFiles(at, false)
      expect(existsSync(lock)).toBe(true)
    })
    for (const file of dead) expect(existsSync(file)).toBe(false)
    if (unknown) {
      for (const file of kept) expect(readFileSync(file, 'utf8')).toBe('mine')
      expect(finishInstallationRemoval(at)).toEqual(['bin'])
    } else {
      expect(finishInstallationRemoval(at)).toEqual([])
      expect(existsSync(at)).toBe(false)
    }
  })

  test('uninstall holds the standalone installer lock even when the bin folder is absent', async () => {
    const at = folder()
    markInstallation(at)
    await withInstallationLock(at, async () => {
      await expect(withInstallationLock(at, async () => 'overlapped')).rejects.toMatchObject({ code: 'busy' })
      expect(markedInstallation(at)).toBe(true)
    })
    expect(existsSync(path.join(at, '.installing'))).toBe(false)
  })

  test('the installer lock is released when uninstall fails', async () => {
    const at = folder()
    markInstallation(at)
    await expect(
      withInstallationLock(at, async () => {
        throw new Error('service refused')
      }),
    ).rejects.toThrow('service refused')
    expect(existsSync(path.join(at, '.installing'))).toBe(false)
    expect(markedInstallation(at)).toBe(true)
  })

  test('uninstall recovers an abandoned standalone installer lock and removes the installation', async () => {
    const at = folder()
    markInstallation(at)
    put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    if (process.platform === 'win32') put(at, '.installing', '')
    else {
      const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
      put(at, '.installing/owner', `${dead} ${os.hostname()}\n`)
    }
    await withInstallationLock(at, async () => removeInstallationFiles(at, false))
    expect(finishInstallationRemoval(at)).toEqual([])
    expect(existsSync(at)).toBe(false)
  })

  test.skipIf(process.platform === 'win32').each(['live', 'foreign', 'malformed', 'linked', 'taking', 'unknown file'])(
    'uninstall refuses a %s standalone installer lock without changing the installation',
    async (kind) => {
      const at = folder()
      markInstallation(at)
      const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
      const record = `${kind === 'live' ? process.pid : dead} ${kind === 'foreign' ? 'another-machine' : os.hostname()}\n`
      const owner = put(at, '.installing/owner', kind === 'malformed' ? 'mine' : record)
      if (kind === 'linked') {
        rmSync(owner)
        symlinkSync(put(folder(), 'owner', record), owner)
      }
      if (kind === 'taking') mkdirSync(path.join(at, '.installing.taking'))
      if (kind === 'unknown file') put(at, '.installing/notes', 'mine')
      let entered = false
      await expect(
        withInstallationLock(at, async () => {
          entered = true
        }),
      ).rejects.toMatchObject({ code: 'busy' })
      expect(entered).toBe(false)
      expect(markedInstallation(at)).toBe(true)
      expect(readFileSync(owner, 'utf8')).toBe(kind === 'malformed' ? 'mine' : record)
      if (kind === 'linked') expect(lstatSync(owner).isSymbolicLink()).toBe(true)
      if (kind === 'taking') expect(existsSync(path.join(at, '.installing.taking'))).toBe(true)
      if (kind === 'unknown file') expect(readFileSync(path.join(at, '.installing/notes'), 'utf8')).toBe('mine')
    },
  )

  test('uninstall waits for the program lock, and keeps live temporary records', async () => {
    const at = folder()
    markInstallation(at)
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    const lock = `${program}.upgrade.lock`
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = aloneAt(lock, async () => {
      const owner = JSON.parse(readFileSync(lock, 'utf8'))
      writeFileSync(`${lock}.${owner.holder}.tmp`, JSON.stringify(owner))
      entered()
      await waiting
    })
    await started
    let removed = false
    const removing = withInstallationLock(at, async () => {
      removed = true
      removeInstallationFiles(at, false)
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(removed).toBe(false)
      expect(existsSync(program)).toBe(true)
    } finally {
      release()
      await holding
      await removing
    }
    expect(removed).toBe(true)
    expect(readdirSync(path.join(at, 'bin'))).toEqual([expect.stringMatching(/\.upgrade\.lock\.[0-9a-f]{16}\.tmp$/)])
  })

  test.each([false, true])('cleanup removes abandoned command locks, with unknown and live records: %s', async (unknown) => {
    const at = folder()
    markInstallation(at)
    let live: any
    await aloneAt(path.join(at, 'connector.lock'), async () => {
      live = JSON.parse(readFileSync(path.join(at, 'connector.lock'), 'utf8'))
    })
    const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const dead = JSON.stringify({ ...live, pid })
    const removed: string[] = []
    for (const lock of ['connector.lock', 'setup.lock', 'enrol.lock', 'addons/setup.lock']) {
      for (const suffix of ['', `.after.${live.holder}`, `.${live.holder}.tmp`, `.after.${live.holder}.${live.holder}.tmp`])
        removed.push(put(at, lock + suffix, dead))
    }
    const kept = ['connector.lock.notes', 'setup.lock.after.1234567890abcdef', 'addons/setup.lock.notes']
    const activeOwner = { ...live, holder: 'b'.repeat(16) }
    const active = `enrol.lock.${activeOwner.holder}.tmp`
    if (unknown) {
      for (const name of kept) put(at, name, 'mine')
      put(at, active, JSON.stringify(activeOwner))
    }
    const left = removeInstallationFiles(at, false)
    for (const file of removed) expect(existsSync(file)).toBe(false)
    if (unknown) {
      for (const name of kept) expect(readFileSync(path.join(at, name), 'utf8')).toBe('mine')
      expect(readFileSync(path.join(at, active), 'utf8')).toBe(JSON.stringify(activeOwner))
    } else {
      expect(left).toEqual([])
      expect(existsSync(at)).toBe(false)
    }
  })

  test('an unrecognised program lock stops uninstall before any installation file is removed', async () => {
    const at = folder()
    markInstallation(at)
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    const lock = `${program}.upgrade.lock`
    writeFileSync(lock, 'mine')
    await expect(withInstallationLock(at, async () => removeInstallationFiles(at, false))).rejects.toThrow('not a recognised lock record')
    expect(readFileSync(lock, 'utf8')).toBe('mine')
    expect(existsSync(program)).toBe(true)
    expect(markedInstallation(at)).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('linked program locks and reopened logs remain untouched', async () => {
    const at = folder()
    const outside = put(folder(), 'mine', 'mine')
    markInstallation(at)
    const program = put(at, 'bin/it')
    symlinkSync(outside, `${program}.upgrade.lock`)
    mkdirSync(path.join(at, 'logs'))
    symlinkSync(outside, path.join(at, 'logs/reopened-123-4.txt'))
    await expect(withInstallationLock(at, async () => removeInstallationFiles(at, false))).rejects.toThrow('not a recognised lock record')
    expect(removeInstallationFiles(at, false)).toEqual(['bin', 'logs'])
    expect(lstatSync(`${program}.upgrade.lock`).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(at, 'logs/reopened-123-4.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('mine')
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

  test('cleanup recognizes the exact add-on sources and hook addresses generated for a custom home', () => {
    const at = folder()
    vi.stubEnv('IT_HOME', at)
    markInstallation(at)
    for (const id of ['pi', 'claude-code', 'codex', 'hermes', 'opencode', 'openclaw'] as const) unpack(id)
    expect(removeInstallationFiles(at, false)).toEqual([])
    expect(existsSync(at)).toBe(false)
    const changed = folder()
    vi.stubEnv('IT_HOME', changed)
    markInstallation(changed)
    const actual = path.join(unpack('pi'), Object.keys(ADDONS.pi!.files).find((name) => name.endsWith('.js'))!)
    writeFileSync(actual, 'the person changed this file')
    expect(removeInstallationFiles(changed, false)).toContain('addons')
    expect(readFileSync(actual, 'utf8')).toBe('the person changed this file')
  })

  test.each(['unchanged', 'extra field', 'reformatted'] as const)('cleanup checks the whole generated add-on home note: %s', (change) => {
    const at = folder()
    vi.stubEnv('IT_HOME', at)
    markInstallation(at)
    const addon = unpack('pi')
    const note = path.join(addon, 'it-home.json')
    const original = readFileSync(note, 'utf8')
    const value = JSON.parse(original)
    let text = original
    if (change === 'extra field') text = `${JSON.stringify({ ...value, personal: 'keep this' }, null, 1)}\n`
    if (change === 'reformatted') text = JSON.stringify(value)
    writeFileSync(note, text)
    if (change === 'reformatted') {
      expect(text).not.toBe(original)
      expect(JSON.parse(text)).toEqual(value)
    }
    if (change === 'unchanged') {
      expect(removeInstallationFiles(at, false)).toEqual([])
      expect(existsSync(at)).toBe(false)
    } else {
      expect(removeInstallationFiles(at, false)).toEqual(['addons'])
      expect(readFileSync(note, 'utf8')).toBe(text)
      expect(readdirSync(addon)).toEqual(['it-home.json'])
    }
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
