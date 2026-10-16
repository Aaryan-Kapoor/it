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
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const at of folders.splice(0)) rmSync(at, { recursive: true, force: true })
})

describe('installation ownership', () => {
  test('a damaged marker is kept aside and said once, and the installed program still finds its home', () => {
    const at = folder()
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    put(at, 'LICENSE.md', LICENSE)
    put(at, 'THIRD_PARTY_NOTICES.md')
    put(at, INSTALLATION_FILE, '{')
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(installationHome(program)).toBe(at)
    expect(installationHome(program)).toBe(at)
    expect(readFileSync(path.join(at, `${INSTALLATION_FILE}.unreadable`), 'utf8')).toBe('{')
    expect(said).toHaveBeenCalledTimes(1)
    expect(said.mock.calls[0]![0]).toContain('installation.json.unreadable')
    expect(markedInstallation(at)).toBe(false)
  })

  test('a damaged marker never proves ownership and does not overwrite an earlier unreadable record', () => {
    const at = folder()
    const program = put(at, process.platform === 'win32' ? 'bin/it.exe' : 'bin/it')
    put(at, INSTALLATION_FILE, '{')
    put(at, `${INSTALLATION_FILE}.unreadable`, 'earlier record')
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(installationHome(program)).toBeUndefined()
    expect(markedInstallation(at)).toBe(false)
    expect(markedInstallation(at)).toBe(false)
    expect(legacyInstallation(at, program)).toBe(false)
    expect(readFileSync(path.join(at, INSTALLATION_FILE), 'utf8')).toBe('{')
    expect(readFileSync(path.join(at, `${INSTALLATION_FILE}.unreadable`), 'utf8')).toBe('earlier record')
    expect(said).toHaveBeenCalledTimes(1)
    expect(() => markInstallation(at)).toThrow('is not the installation record')
  })

  test('setup writes a durable marker, keeps it unchanged, and replaces a damaged record after keeping it aside', () => {
    const at = folder()
    markInstallation(at)
    expect(markedInstallation(at)).toBe(true)
    expect(readFileSync(path.join(at, INSTALLATION_FILE), 'utf8')).toBe(INSTALLATION)
    markInstallation(at)
    expect(readdirSync(at)).toEqual([INSTALLATION_FILE])
    put(at, INSTALLATION_FILE, '{')
    markInstallation(at)
    expect(markedInstallation(at)).toBe(true)
    expect(readFileSync(path.join(at, `${INSTALLATION_FILE}.unreadable`), 'utf8')).toBe('{')
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
      expect(home()).toBe(path.join(os.homedir(), '.it'))
    } finally {
      process.execPath = original
      process.argv[1] = originalScript!
    }
  })

  test('source and package invocations use the default home without IT_HOME', () => {
    vi.stubEnv('IT_HOME', '')
    expect(home()).toBe(path.join(os.homedir(), '.it'))
  })

  test.skipIf(process.platform === 'win32')(
    'an executable symlink belongs to its real installation, while a marker symlink gives no proof of ownership',
    () => {
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
      expect(markedInstallation(first)).toBe(false)
      expect(lstatSync(path.join(first, `${INSTALLATION_FILE}.unreadable`)).isSymbolicLink()).toBe(true)
      expect(markedInstallation(second)).toBe(true)
    },
  )

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

  test.each([{ made: undefined }, { erased: false }])('cleanup removes backups even with an incomplete ownership record: %j', (damaged) => {
    const at = folder()
    markInstallation(at)
    const copy = 'before-functions-123456789abc'
    const note = { copy, id: '123456789abcdef0', made: Date.now(), order: 1, it: '0.1.22', ...damaged }
    put(at, `backend/${copy}/copy.json`, JSON.stringify(note))
    const database = put(at, `backend/${copy}/db.sqlite3`, 'must remain')
    removeInstallationFiles(at, false)
    expect(existsSync(database)).toBe(false)
    expect(existsSync(path.join(at, 'backend'))).toBe(false)
  })

  test('cleanup removes data folders whole while keeping unknown top-level siblings', () => {
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
    const removed = [
      'backend/notes.txt',
      `${backup}/notes.txt`,
      'backend/storage/unknown',
      'content-data/notes.txt',
      `content/${prefix}/notes.txt`,
      'addons/pi/notes.txt',
      'bin/other',
      'bin/it.old.notes.exe',
    ]
    for (const file of removed) put(at, file, 'private data')
    put(at, 'project.txt', 'mine')
    expect(removeInstallationFiles(at, false)).toEqual(['project.txt'])
    expect(readFileSync(path.join(at, 'project.txt'), 'utf8')).toBe('mine')
    for (const file of removed) expect(existsSync(path.join(at, file))).toBe(false)
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

  test.each(['runs.json', 'installation.json', 'startup.json', 'delivery-recovery.json'])(
    'cleanup removes a quarantined %s and keeps similarly named files',
    (record) => {
      const clean = folder()
      markInstallation(clean)
      put(clean, `${record}.unreadable`, '{')
      expect(removeInstallationFiles(clean, false)).toEqual([])
      expect(existsSync(clean)).toBe(false)

      const kept = folder()
      markInstallation(kept)
      put(kept, `${record}.unreadable.notes`, 'mine')
      expect(removeInstallationFiles(kept, false)).toEqual([`${record}.unreadable.notes`])
      expect(readFileSync(path.join(kept, `${record}.unreadable.notes`), 'utf8')).toBe('mine')
    },
  )

  test('cleanup removes the whole log folder, including unrecognised files', () => {
    const clean = folder()
    markInstallation(clean)
    put(clean, 'logs/reopened-123-4.txt', 'interrupted run')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)

    const kept = folder()
    markInstallation(kept)
    for (const name of ['reopened-notes.txt', 'reopened-123-4.txt.notes', 'reopened-123-4.txt/notes']) put(kept, `logs/${name}`, 'mine')
    expect(removeInstallationFiles(kept, false)).toEqual([])
    expect(existsSync(kept)).toBe(false)
  })

  test('cleanup removes abandoned atomic-write sidecars only for fixed records', () => {
    const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const clean = folder()
    markInstallation(clean)
    for (const record of [
      'machine.json',
      'telemetry.json',
      'conversation-notes-erasing',
      INSTALLATION_FILE,
      'addons/asked-for.json',
      'addons/pi.json',
      'backend/erased.json',
    ])
      put(clean, `${record}.${dead}.tmp`, '{')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)

    const kept = folder()
    markInstallation(kept)
    const names = [
      `machine.json.${process.pid}.tmp`,
      `notes.json.${dead}.tmp`,
      `LICENSE.md.${dead}.tmp`,
      `machine.json.${dead}.tmp.notes`,
      `machine.json.${dead}.tmp/notes`,
      'machine.json.0.tmp',
      'machine.json.-1.tmp',
      'machine.json.9007199254740992.tmp',
      `project/machine.json.${dead}.tmp`,
    ]
    for (const name of names) put(kept, name, 'mine')
    removeInstallationFiles(kept, false)
    for (const name of names) expect(readFileSync(path.join(kept, name), 'utf8')).toBe('mine')
  })

  test.skipIf(process.platform === 'win32')('cleanup preserves linked atomic-write sidecars and their targets', () => {
    const at = folder()
    markInstallation(at)
    const outside = put(folder(), 'mine', 'mine')
    const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    const name = `machine.json.${dead}.tmp`
    symlinkSync(outside, path.join(at, name))
    expect(removeInstallationFiles(at, false)).toEqual([name])
    expect(lstatSync(path.join(at, name)).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('mine')
  })

  test.skipIf(process.platform === 'win32').each(['content', 'tmp', 'staging', 'holder'])('cleanup never follows a linked %s inside a data folder', (kind) => {
    const at = folder()
    const outside = folder()
    markInstallation(at)
    const relative = { content: 'content', tmp: 'content/tmp', staging: 'content/tmp/staging', holder: 'content/tmp/staging/holder' }[kind]!
    const target = put(outside, 'holder', 'outside')
    put(outside, 'part', 'mine')
    mkdirSync(path.dirname(path.join(at, relative)), { recursive: true })
    symlinkSync(kind === 'holder' ? target : outside, path.join(at, relative), kind === 'holder' ? 'file' : 'dir')
    expect(removeInstallationFiles(at, false)).toEqual(kind === 'content' ? ['content'] : [])
    if (kind === 'content') expect(lstatSync(path.join(at, relative)).isSymbolicLink()).toBe(true)
    else expect(existsSync(path.join(at, 'content'))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('outside')
    expect(readFileSync(path.join(outside, 'part'), 'utf8')).toBe('mine')
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
    const kept = [`${lock}.after.1234567890abcdef`]
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

  test.each(['setup.lock', 'addons/setup.lock'])('uninstall refuses a live %s before changing the installation', async (name) => {
    const at = folder()
    markInstallation(at)
    let entered = false
    await aloneAt(path.join(at, name), async () => {
      await expect(
        withInstallationLock(at, async () => {
          entered = true
        }),
      ).rejects.toMatchObject({ code: 'busy' })
      expect(markedInstallation(at)).toBe(true)
      expect(existsSync(path.join(at, name))).toBe(true)
    })
    expect(entered).toBe(false)
  })

  test.each(['setup.lock', 'addons/setup.lock'])('uninstall keeps an unrecognised %s and never enters removal', async (name) => {
    const at = folder()
    markInstallation(at)
    put(at, name, 'mine')
    let entered = false
    await expect(
      withInstallationLock(at, async () => {
        entered = true
      }),
    ).rejects.toThrow('not a recognised lock record')
    expect(entered).toBe(false)
    expect(readFileSync(path.join(at, name), 'utf8')).toBe('mine')
  })

  test('cleanup holds the setup and add-on locks until removal has finished', async () => {
    const at = folder()
    markInstallation(at)
    put(at, 'addons/pi/private', 'private data')
    await withInstallationLock(at, async () => {
      removeInstallationFiles(at, false)
      for (const name of ['setup.lock', 'addons/setup.lock']) expect(existsSync(path.join(at, name))).toBe(true)
      expect(existsSync(path.join(at, 'addons/pi'))).toBe(false)
    })
    expect(finishInstallationRemoval(at)).toEqual([])
    expect(existsSync(at)).toBe(false)
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

  test('uninstall removes downloads left by a dead local installer', () => {
    const at = folder()
    markInstallation(at)
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    put(at, '.install.abandoned/owner', `${dead} ${os.hostname()}\n`)
    put(at, '.install.abandoned/program')
    expect(removeInstallationFiles(at, false)).toEqual([])
    expect(existsSync(at)).toBe(false)
  })

  test.each(['live', 'foreign', 'malformed', 'missing', 'recovery'])('uninstall keeps staging downloads it cannot remove safely (%s)', (kind) => {
    const at = folder()
    markInstallation(at)
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    const stage = '.install.kept'
    if (kind !== 'missing') {
      const record = `${kind === 'live' ? process.pid : dead} ${kind === 'foreign' ? 'another-machine' : os.hostname()}\n`
      put(at, `${stage}/owner`, kind === 'malformed' ? 'mine' : record)
    }
    put(at, `${stage}/program`)
    if (kind === 'recovery') put(at, `${stage}/old.license`, 'original terms')
    expect(removeInstallationFiles(at, false)).toEqual([stage])
    expect(readFileSync(path.join(at, stage, 'program'), 'utf8')).toBe('data')
    if (kind === 'recovery') expect(readFileSync(path.join(at, stage, 'old.license'), 'utf8')).toBe('original terms')
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
    const kept = ['connector.lock.notes', 'setup.lock.after.1234567890abcdef', 'addons-notes']
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

  test.skipIf(process.platform === 'win32')('linked program locks remain while linked logs are removed without following their targets', async () => {
    const at = folder()
    const outside = put(folder(), 'mine', 'mine')
    markInstallation(at)
    const program = put(at, 'bin/it')
    symlinkSync(outside, `${program}.upgrade.lock`)
    mkdirSync(path.join(at, 'logs'))
    symlinkSync(outside, path.join(at, 'logs/reopened-123-4.txt'))
    await expect(withInstallationLock(at, async () => removeInstallationFiles(at, false))).rejects.toThrow('not a recognised lock record')
    expect(removeInstallationFiles(at, false)).toEqual(['bin'])
    expect(lstatSync(`${program}.upgrade.lock`).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(at, 'logs'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('mine')
  })

  test('a malformed page manifest does not leave page files behind', () => {
    const at = folder()
    markInstallation(at)
    put(at, 'content/manifest/u/a/b/c/files.json', '{')
    put(at, 'content/u/a/b/c/page', 'mine')
    expect(removeInstallationFiles(at, false)).toEqual([])
    expect(existsSync(at)).toBe(false)
    const clean = folder()
    markInstallation(clean)
    put(clean, 'backend/db.sqlite3')
    put(clean, 'machine.json')
    put(clean, 'bin/it')
    expect(removeInstallationFiles(clean, false)).toEqual([])
    expect(existsSync(clean)).toBe(false)
  })

  test('cleanup removes add-on sources whole, including changes inside its own folder', () => {
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
    expect(removeInstallationFiles(changed, false)).toEqual([])
    expect(existsSync(actual)).toBe(false)
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
