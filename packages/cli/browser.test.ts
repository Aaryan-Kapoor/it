// Whether the address that pairs a browser is opened in the person's browser, and how it is
// handed to the system's opener. No real browser is opened by any of these: the opener is
// always stood in for.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { type Asked, launch, noScreen, OPENED_FOR_MS, opener, openPairing, type Start, type Surroundings, seenLately, takeOpening } from './src/browser'

const dir = mkdtempSync(path.join(os.tmpdir(), 'it-browser-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const noteIn = () => path.join(dir, `note-${n++}`, 'browser-opened.json')

const URL_ = 'http://localhost:4700/pair#Ab3dEf6hIj9kLm2nOp5q'
/** A desktop Linux with a screen and `xdg-open` on its PATH, and nothing else said. */
const linux = (env: NodeJS.ProcessEnv = {}, files: string[] = []): Surroundings => ({
  platform: 'linux',
  env: { DISPLAY: ':0', PATH: '/usr/bin', ...env },
  exists: (file) => file === '/usr/bin/xdg-open' || files.includes(file),
  release: '6.8.0-49-generic',
})
const mac = (env: NodeJS.ProcessEnv = {}): Surroundings => ({ platform: 'darwin', env, exists: () => false, release: '24.1.0' })
const windows = (env: NodeJS.ProcessEnv = {}): Surroundings => ({ platform: 'win32', env, exists: () => false, release: '10.0.26200' })

/** A stand-in for `spawn`, which notes what it was asked to start and ends as it is told. */
function starter(ends: { status?: number | null; error?: string; never?: boolean } = { status: 0 }) {
  const started: { cmd: string; args: string[]; options: object }[] = []
  const start: Start = (cmd, args, options) => {
    started.push({ cmd, args, options })
    const child = Object.assign(new EventEmitter(), { unref: () => {} })
    setImmediate(() => {
      if (ends.never) return
      if (ends.error) child.emit('error', Object.assign(new Error('no'), { code: ends.error }))
      else child.emit('exit', ends.status ?? null, ends.status === null ? 'SIGTERM' : null)
    })
    return child as never
  }
  return { start, started }
}

const asAgent = (more: Partial<Asked> = {}): Asked => ({ noOpen: false, terminal: false, agent: true, joined: false, displays: async () => [], ...more })
const asPerson = (more: Partial<Asked> = {}): Asked => ({ noOpen: false, terminal: true, agent: false, joined: false, displays: async () => [], ...more })

describe('where nobody is taken to be at the screen', () => {
  test('a desktop Linux, a Mac and Windows are places a person sits at', () => {
    expect(noScreen(linux())).toBeNull()
    expect(noScreen(linux({ DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' }))).toBeNull()
    expect(noScreen(mac())).toBeNull()
    expect(noScreen(windows())).toBeNull()
  })
  test('never over SSH, on any system', () => {
    for (const env of [{ SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }, { SSH_TTY: '/dev/pts/3' }, { SSH_CLIENT: '10.0.0.1 50000 22' }]) {
      expect(noScreen(linux(env))).toBe('ssh')
      expect(noScreen(mac(env))).toBe('ssh')
      expect(noScreen(windows(env))).toBe('ssh')
    }
  })
  test('never in CI, by the variable any of the common systems sets, and not where it plainly says no', () => {
    for (const name of [
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'BUILDKITE',
      'CIRCLECI',
      'TF_BUILD',
      'JENKINS_URL',
      'TEAMCITY_VERSION',
      'CONTINUOUS_INTEGRATION',
    ]) {
      expect(noScreen(linux({ [name]: 'true' }))).toBe('ci')
      expect(noScreen(mac({ [name]: '1' }))).toBe('ci')
      expect(noScreen(windows({ [name]: 'True' }))).toBe('ci')
    }
    expect(noScreen(linux({ CI: 'false' }))).toBeNull()
    expect(noScreen(linux({ CI: '' }))).toBeNull()
  })
  test('never in Codespaces, a dev container, Gitpod or Cloud Shell', () => {
    for (const name of ['CODESPACES', 'REMOTE_CONTAINERS', 'GITPOD_WORKSPACE_ID', 'CLOUD_SHELL']) expect(noScreen(linux({ [name]: 'true' }))).toBe('remote')
  })
  test('never in a container, told by its variable or by the file its engine leaves', () => {
    expect(noScreen(linux({ container: 'podman' }))).toBe('container')
    expect(noScreen(linux({}, ['/.dockerenv']))).toBe('container')
    expect(noScreen(linux({}, ['/run/.containerenv']))).toBe('container')
  })
  test('never inside WSL, where Windows would have to reach It at an address it may not', () => {
    expect(noScreen(linux({ WSL_DISTRO_NAME: 'Ubuntu' }))).toBe('wsl')
    expect(noScreen({ ...linux(), release: '6.6.87.2-microsoft-standard-WSL2' })).toBe('wsl')
  })
  test('never on a Linux with no screen, or with nothing to open a browser with', () => {
    expect(noScreen(linux({ DISPLAY: '', WAYLAND_DISPLAY: '' }))).toBe('no_screen')
    expect(noScreen({ ...linux(), exists: () => false })).toBe('no_opener')
  })
  test('a stand-in the tests name is the opener, and one that is no list of words opens nothing', () => {
    expect(noScreen({ ...linux({ IT_BROWSER_OPENER: '["/bin/true"]' }), exists: () => false })).toBeNull()
    for (const named of ['/bin/true', '[]', '[""]', '[1]', '{"cmd":"x"}']) {
      expect(noScreen(linux({ IT_BROWSER_OPENER: named }))).toBe('no_opener')
      expect(noScreen(mac({ IT_BROWSER_OPENER: named }))).toBe('no_opener')
    }
  })
})

describe('how the address is handed to the system', () => {
  test('as one word of its own, to the system’s own opener, and never to a shell', () => {
    expect(opener(URL_, mac())).toEqual(['open', [URL_]])
    expect(opener(URL_, linux())).toEqual(['xdg-open', [URL_]])
    expect(opener(URL_, windows())).toEqual(['rundll32.exe', ['url.dll,FileProtocolHandler', URL_]])
    expect(opener(URL_, linux({ IT_BROWSER_OPENER: '["node","stand-in.mjs"]' }))).toEqual(['node', ['stand-in.mjs', URL_]])
  })
  for (const s of [linux(), mac(), windows()])
    test(`is started without a shell on ${s.platform}, with an address that a shell would have read otherwise passed whole`, async () => {
      const { start, started } = starter()
      const odd = 'http://localhost:4700/pair#a&b;c|d$(e)`f`"g\'h'
      expect(await launch(odd, s, start)).toBe('opened')
      expect(started).toHaveLength(1)
      expect(started[0]!.args.at(-1)).toBe(odd)
      expect(started[0]!.args.filter((word) => word.includes('pair#'))).toHaveLength(1)
      expect(started[0]!.options).toMatchObject({ shell: false, stdio: 'ignore' })
    })
  test('says how it went by a code, and nothing of the address', async () => {
    expect(await launch(URL_, linux(), starter({ status: 3 }).start)).toBe('exit_3')
    expect(await launch(URL_, linux(), starter({ error: 'ENOENT' }).start)).toBe('ENOENT')
    expect(await launch(URL_, linux(), starter({ status: null }).start)).toBe('signal_SIGTERM')
    const throws: Start = () => {
      throw Object.assign(new Error(URL_), { code: 'EACCES' })
    }
    expect(await launch(URL_, linux(), throws)).toBe('EACCES')
    // An opener still running after a second has done its work, as one that waits for the browser does
    expect(await launch(URL_, linux(), starter({ never: true }).start)).toBe('opened')
  })
})

describe('what an agent’s commands are held to', () => {
  test('a paired display seen in the last ten minutes is a browser open to It already', () => {
    const now = 1_000_000_000
    expect(seenLately([], now)).toBe(false)
    expect(seenLately([{ paired: true, lastSeenAt: now - 60_000 }], now)).toBe(true)
    expect(seenLately([{ paired: true, lastSeenAt: now - 11 * 60_000 }], now)).toBe(false)
    expect(seenLately([{ paired: false, lastSeenAt: now - 60_000 }], now)).toBe(false)
    // Where It could not say, nothing is opened
    expect(seenLately(null, now)).toBe(true)
    expect(seenLately({ error: 'x' }, now)).toBe(true)
  })
  test('one opening in ten minutes: a second is refused, and so is any while the note cannot be read', () => {
    const file = noteIn()
    const now = 2_000_000_000_000
    expect(takeOpening(file, now)).toBe(true)
    expect(takeOpening(file, now + 1000)).toBe(false)
    expect(takeOpening(file, now + OPENED_FOR_MS - 1)).toBe(false)
    expect(takeOpening(file, now + OPENED_FOR_MS)).toBe(true)
    // A clock put back does not open another either
    expect(takeOpening(file, now + 5000)).toBe(false)
    for (const text of ['', '{', '{"at":"soon"}', 'null']) {
      writeFileSync(file, text)
      expect(takeOpening(file, now + 10 * OPENED_FOR_MS)).toBe(false)
    }
    expect(readFileSync(file, 'utf8')).toBe('null')
  })
  test('a folder that cannot be written opens nothing', () => {
    const blocked = path.join(dir, `file-${n++}`)
    writeFileSync(blocked, '')
    expect(takeOpening(path.join(blocked, 'browser-opened.json'), Date.now())).toBe(false)
  })
  test('commands that ask at once take turns: one that finds another holding the lock opens nothing, even with the note long out of date', () => {
    const file = noteIn()
    const now = 5_000_000_000_000
    expect(takeOpening(file, now)).toBe(true)
    expect(existsSync(`${file}.lock`)).toBe(false)
    // Another command holds the lock, as it does while it reads and writes the note
    mkdirSync(`${file}.lock`)
    expect(takeOpening(file, now + 10 * OPENED_FOR_MS)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: now })
    // A lock older than a minute was left by a command that ended: it is taken away, and that command still opens nothing
    const later = Date.now() + 2 * 60_000
    expect(takeOpening(file, now + 10 * OPENED_FOR_MS, () => later)).toBe(false)
    expect(existsSync(`${file}.lock`)).toBe(false)
    // The next one may
    expect(takeOpening(file, now + 10 * OPENED_FOR_MS)).toBe(true)
  })
})

describe('whether the pairing address is opened', () => {
  test('for an agent with no browser open to It, once, and the note says how it went and nothing of the address', async () => {
    const file = noteIn()
    const { start, started } = starter()
    const now = 3_000_000_000_000
    expect(await openPairing(URL_, asAgent(), linux(), start, file, now)).toBe(true)
    expect(started.map((s) => [s.cmd, s.args])).toEqual([['xdg-open', [URL_]]])
    const note = readFileSync(file, 'utf8')
    expect(JSON.parse(note)).toEqual({ at: now, result: 'opened' })
    expect(note).not.toContain('pair')
    // Three commands in a row open one tab
    expect(await openPairing(URL_, asAgent(), linux(), start, file, now + 5000)).toBe(false)
    expect(await openPairing(URL_, asAgent(), linux(), start, file, now + 9000)).toBe(false)
    expect(started).toHaveLength(1)
  })
  test('not for an agent where a paired browser was seen lately, or where It could not be asked', async () => {
    const { start, started } = starter()
    const now = Date.now()
    expect(await openPairing(URL_, asAgent({ displays: async () => [{ paired: true, lastSeenAt: now - 1000 }] }), linux(), start, noteIn(), now)).toBe(false)
    expect(
      await openPairing(
        URL_,
        asAgent({
          displays: async () => {
            throw new Error('offline')
          },
        }),
        linux(),
        start,
        noteIn(),
        now,
      ),
    ).toBe(false)
    expect(started).toEqual([])
  })
  test('never with --no-open, from a script that no agent runs, on a joined machine, or where nobody is at the screen', async () => {
    const { start, started } = starter()
    const file = noteIn()
    expect(await openPairing(URL_, asAgent({ noOpen: true }), linux(), start, file)).toBe(false)
    expect(await openPairing(URL_, asPerson({ noOpen: true }), linux(), start, file)).toBe(false)
    expect(await openPairing(URL_, asAgent({ agent: false, terminal: false }), linux(), start, file)).toBe(false)
    expect(await openPairing(URL_, asAgent({ joined: true }), linux(), start, file)).toBe(false)
    expect(await openPairing(URL_, asPerson({ joined: true }), linux(), start, file)).toBe(false)
    expect(await openPairing(URL_, asAgent(), linux({ SSH_CONNECTION: '1 2 3 4' }), start, file)).toBe(false)
    expect(await openPairing(URL_, asPerson(), linux({ CI: 'true' }), start, file)).toBe(false)
    expect(await openPairing(URL_, asAgent(), linux({}, ['/.dockerenv']), start, file)).toBe(false)
    expect(await openPairing(URL_, asAgent(), linux({ WSL_DISTRO_NAME: 'Ubuntu' }), start, file)).toBe(false)
    expect(started).toEqual([])
    expect(existsSync(file)).toBe(false)
  })
  test('an agent’s shell, whose output is no terminal, is where it opens; a person at a terminal is not held to the agent’s bounds', async () => {
    const { start, started } = starter()
    const file = noteIn()
    const seen = async () => [{ paired: true, lastSeenAt: Date.now() }]
    expect(await openPairing(URL_, asPerson({ displays: seen }), mac(), start, file)).toBe(true)
    expect(await openPairing(URL_, asPerson({ displays: seen }), mac(), start, file)).toBe(true)
    expect(started.map((s) => s.cmd)).toEqual(['open', 'open'])
    // But what the person opened counts for an agent that asks right after
    expect(await openPairing(URL_, asAgent(), mac(), start, file)).toBe(false)
    expect(started).toHaveLength(2)
  })
  test('a failure to open is said to nobody, and noted by its code', async () => {
    const file = noteIn()
    const now = 4_000_000_000_000
    expect(await openPairing(URL_, asAgent(), windows(), starter({ error: 'ENOENT' }).start, file, now)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: now, result: 'ENOENT' })
    // And it counts as the one opening of those ten minutes
    const { start, started } = starter()
    expect(await openPairing(URL_, asAgent(), windows(), start, file, now + 1000)).toBe(false)
    expect(started).toEqual([])
  })
})
