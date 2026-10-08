// The parts of the CLI that can be checked without a backend: reading a command line, the
// service definitions, and what `it setup` writes for a harness to install.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs, {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
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
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describeClick, PORTS } from '@it/protocol'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { ADDONS, SKILL } from './src/addons.generated'
import { agentApp, agentAppsAbove, appsFrom, linuxProc, type Proc, psAbove, psTable, psWords } from './src/ancestry'
import { loose, nested, parse } from './src/args'
import { codexCommand, codexQueue, local, mac } from './src/connector'
import {
  backend,
  clashed,
  currentSession,
  forgetMachine,
  harnessEnv,
  notReached,
  overClashes,
  Problem,
  sessionAsked,
  sessionNote,
  siteAddress,
  textOf,
  throughDoor,
  windowsPathCommand,
  withoutTables,
  writePrivate,
} from './src/lib'
import { doorAddress } from './src/login'
import { gather, projectKey, read } from './src/publish'
import {
  askToStop,
  command,
  definedFor,
  environment,
  installedHere,
  launchdPlist,
  logFile,
  runningFor,
  sameWindowsFolder,
  status as serviceStatus,
  uninstall as serviceUninstall,
  startsByItself,
  stopFile,
  systemdUnit,
  windowsLauncher,
  windowsRegisteredFor,
  windowsScript,
} from './src/service'

describe('command line', () => {
  test('positional words, flags with values, and switches', () => {
    const a = parse(['Deploy plan', '--id', 'deploy-plan', '--open', '--file=plan.html', '--button', 'Yes=yes', '--button', 'No=no'])
    expect(a._).toEqual(['Deploy plan'])
    expect(a.flags).toMatchObject({ id: 'deploy-plan', open: true, file: 'plan.html' })
    expect(a.many.button).toEqual(['Yes=yes', 'No=no'])
  })
  test('everything after -- is a word, even if it looks like a flag', () => {
    expect(parse(['--', '--not-a-flag'])._).toEqual(['--not-a-flag'])
  })
  test('a switch takes no value, and --force is one', () => {
    expect(parse(['logout', '--force']).flags).toMatchObject({ force: true })
  })
  test('a switch written with a value is on or off as the value says, and anything else is refused', () => {
    expect(parse(['--force=false', '--replace=no', '--take=0', '--open=true', '--sticky=YES', '--all=1']).flags).toEqual({
      force: false,
      replace: false,
      take: false,
      open: true,
      sticky: true,
      all: true,
    })
    for (const odd of ['--force=', '--force=maybe', '--replace=off', '--take=2']) expect(() => parse([odd])).toThrow(/is a switch/)
    // What is not a switch keeps whatever it was given
    expect(parse(['--id=false']).flags).toEqual({ id: 'false' })
  })
  test('a flag with no value is refused', () => {
    expect(() => parse(['--id'])).toThrow(/needs a value/)
  })
  test('a dotted key becomes a nested patch', () => {
    expect(nested('steps.build.status', 'done')).toEqual({ steps: { build: { status: 'done' } } })
  })
  test('keys that would reach into the object prototype are refused', () => {
    for (const key of ['__proto__.x', 'a.constructor', 'prototype', 'a..b']) expect(() => nested(key, 1)).toThrow()
  })
  test('a value that parses as JSON is JSON, and anything else is text', () => {
    expect(loose('3')).toBe(3)
    expect(loose('{"a":1}')).toEqual({ a: 1 })
    expect(loose('null')).toBe(null)
    expect(loose('Deploying 3 of 7')).toBe('Deploying 3 of 7')
  })
})

describe('text that is piped in', () => {
  test('is read whole, however its bytes were cut into pieces on the way', async () => {
    const page = '<p>支付 naïve 👍</p>'
    const bytes = Buffer.from(page)
    // Cut at every byte in turn, so that every character is at some point in two pieces
    for (let cut = 1; cut < bytes.length; cut++) {
      const pieces = (async function* () {
        yield bytes.subarray(0, cut)
        yield bytes.subarray(cut)
      })()
      expect(await textOf(pieces)).toBe(page)
    }
  })
})

describe('the words an agent reads for an action', () => {
  const action = { id: 'k57', artifact: 'plan', title: 'Deploy plan', name: 'approve', payload: { plan: 'B' }, at: 1 }
  test('say whether the site saw someone use the page just before it sent the action, and never that the person chose it or that the page acted alone', () => {
    expect(describeClick({ ...action, attended: true })).toBe(
      '[It] The page "Deploy plan" (plan) sent this just after someone used it: approve {"plan":"B"} [action k57]',
    )
    expect(describeClick({ ...action, attended: false })).toBe(
      '[It] The page "Deploy plan" (plan) sent this with no sign that anyone had just used it: approve {"plan":"B"} [action k57]',
    )
    // Where it was not recorded whether anyone was there, nothing is said about it
    expect(describeClick(action)).toBe('[It] The page "Deploy plan" (plan) sent this: approve {"plan":"B"} [action k57]')
    // A page can wait for any touch and then send what it likes, so no wording says who chose the action
    for (const attended of [true, false, undefined])
      for (const max of [undefined, 0])
        expect(describeClick({ ...action, attended, version: 1, nowVersion: 2, stateRevision: 1, nowStateRevision: 3 }, max)).not.toMatch(
          /user|person|clicked|chose|acted/i,
        )
  })
  test('leave out a picture the action carried, say that one stood there, and say how it is written to a file', () => {
    const png = `data:image/png;base64,${'iVBORw0KGgo'.repeat(400)}`
    const drawn = { ...action, name: 'snapshot', payload: { png, strokes: [{ points: [[0.1, 0.2]], width: 4 }], note: 'data:text/plain;base64,aGk=' } }
    const said = describeClick({ ...drawn, attended: true })
    expect(said).toBe(
      '[It] The page "Deploy plan" (plan) sent this just after someone used it: snapshot {"png":"(a picture, image/png, 3 KB, left out of this message)","strokes":[{"points":[[0.1,0.2]],"width":4}],"note":"data:text/plain;base64,aGk="} (`it action k57 --save <file>` writes it to a file you can open) [action k57]',
    )
    expect(said).not.toContain('iVBOR')
    // Two of them: the command writes the first, and says so
    expect(describeClick({ ...drawn, payload: [png, { again: png }] })).toContain('writes the first of them to a file')
    // And where none of what it carried is shown, nothing is said of pictures either
    expect(describeClick(drawn, 0)).toBe('[It] The page "Deploy plan" (plan) sent this: snapshot (run `it action k57` to read what it carried) [action k57]')
  })
  test('say which version and which state the page was at when the page has since come to show another', () => {
    expect(describeClick({ ...action, attended: true, version: 1, nowVersion: 2, stateRevision: 1, nowStateRevision: 3 }, 0)).toBe(
      '[It] The page "Deploy plan" (plan) sent this just after someone used it, as it was at version 1 (the page is now at version 2), when its state was at revision 1 (it is now at revision 3): approve (run `it action k57` to read what it carried) [action k57]',
    )
  })
})

describe('where the backend is', () => {
  const NAMES = ['IT_HOME', 'IT_PORT', 'IT_URL', 'IT_SITE_URL'] as const
  let before: Record<string, string | undefined>
  let folder: string
  beforeAll(() => {
    before = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-where-'))
  })
  afterAll(() => {
    for (const name of NAMES) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
    rmSync(folder, { recursive: true, force: true })
  })
  const refused = (run: () => unknown) => {
    try {
      run()
    } catch (err) {
      return err instanceof Problem ? { code: err.code, message: err.message, hint: err.hint } : err
    }
  }

  test('on the machine It runs on it is two ports of that machine, counted from the one in It’s settings, and the site is at that one', () => {
    process.env.IT_HOME = folder
    for (const name of ['IT_PORT', 'IT_URL', 'IT_SITE_URL']) delete process.env[name]
    // Where It was never set up there is no backend to find, and every command says the same one sentence
    expect(refused(backend)).toEqual({ code: 'not_set_up', message: 'It has not been set up on this machine, so run `it setup` first.', hint: undefined })
    expect(siteAddress()).toBeUndefined()
    writeFileSync(path.join(folder, 'service.json'), JSON.stringify({ port: 21000 }))
    expect(backend()).toEqual({ api: `http://127.0.0.1:${21000 + PORTS.backendApi}`, site: `http://127.0.0.1:${21000 + PORTS.backendSite}` })
    expect(siteAddress()).toBe('http://localhost:21000')
    // IT_PORT names another port to count from, and one that is no port is refused out loud
    process.env.IT_PORT = '22000'
    expect(backend()).toEqual({ api: `http://127.0.0.1:${22000 + PORTS.backendApi}`, site: `http://127.0.0.1:${22000 + PORTS.backendSite}` })
    expect(siteAddress()).toBe('http://localhost:22000')
    process.env.IT_PORT = 'eighty'
    expect(refused(backend)).toMatchObject({ code: 'invalid', message: expect.stringContaining('IT_PORT') })
  })

  test('IT_URL names another address, with IT_SITE_URL beside it where the address for HTTP is not the same one', () => {
    process.env.IT_HOME = folder
    delete process.env.IT_PORT
    process.env.IT_URL = 'http://127.0.0.1:23000/'
    delete process.env.IT_SITE_URL
    expect(backend()).toEqual({ api: 'http://127.0.0.1:23000', site: 'http://127.0.0.1:23000' })
    process.env.IT_SITE_URL = 'http://127.0.0.1:23001/'
    expect(backend()).toEqual({ api: 'http://127.0.0.1:23000', site: 'http://127.0.0.1:23001' })
  })

  test('on a machine that joined an It running on another, it is the address that machine joined at', () => {
    const joined = mkdtempSync(path.join(os.tmpdir(), 'it-where-'))
    try {
      process.env.IT_HOME = joined
      for (const name of ['IT_PORT', 'IT_URL', 'IT_SITE_URL']) delete process.env[name]
      writeFileSync(path.join(joined, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'laptop', key: {}, at: 'http://192.168.1.20:21000' }))
      expect(backend()).toEqual({ api: 'http://192.168.1.20:21000', site: 'http://192.168.1.20:21000' })
      expect(siteAddress()).toBe('http://192.168.1.20:21000')
    } finally {
      rmSync(joined, { recursive: true, force: true })
    }
  })

  test('an address the backend gives for its door is asked for where this machine reaches the door: as given on the machine It runs on, and on any other at the address it was told, or else the one it joined at', () => {
    // The backend names its door as its own machine reaches it
    const upload = 'http://127.0.0.1:21000/upload/u/a/b/1/'
    const page = 'http://localhost:21000/p/plan?x=1'
    const joined = mkdtempSync(path.join(os.tmpdir(), 'it-where-'))
    try {
      process.env.IT_HOME = joined
      for (const name of ['IT_PORT', 'IT_URL', 'IT_SITE_URL']) delete process.env[name]
      // Where nothing is known of a door, the address is left as it was given
      expect(throughDoor(upload)).toBe(upload)
      writeFileSync(path.join(joined, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'laptop', key: {}, at: 'http://192.168.1.20:21000' }))
      expect([throughDoor(upload), throughDoor(page)]).toEqual(['http://192.168.1.20:21000/upload/u/a/b/1/', 'http://192.168.1.20:21000/p/plan?x=1'])
      expect(throughDoor('not an address')).toBe('not an address')
      // An address the machine is told is believed over the one it joined at, which is how it follows an It that has moved
      process.env.IT_URL = 'http://192.168.1.20:23000/'
      expect([throughDoor(upload), throughDoor(page), siteAddress()]).toEqual([
        'http://192.168.1.20:23000/upload/u/a/b/1/',
        'http://192.168.1.20:23000/p/plan?x=1',
        'http://192.168.1.20:23000',
      ])
      // Where it is told another address for HTTP beside it, that one is the door
      process.env.IT_SITE_URL = 'http://192.168.1.20:23001'
      expect([throughDoor(upload), siteAddress()]).toEqual(['http://192.168.1.20:23001/upload/u/a/b/1/', 'http://192.168.1.20:23001'])
      delete process.env.IT_SITE_URL
      // And the same on a machine that was only told an address, and joined nowhere
      rmSync(path.join(joined, 'machine.json'))
      expect([throughDoor(page), siteAddress()]).toEqual(['http://192.168.1.20:23000/p/plan?x=1', 'http://192.168.1.20:23000'])
      delete process.env.IT_URL
      // And on the machine It runs on, the backend's word for its door is the door, whatever address its commands were told to ask
      process.env.IT_HOME = folder
      expect([throughDoor(upload), throughDoor(page)]).toEqual([upload, page])
      process.env.IT_URL = 'http://127.0.0.1:23000'
      expect([throughDoor(upload), throughDoor(page), siteAddress()]).toEqual([upload, page, 'http://localhost:21000'])
      delete process.env.IT_URL
    } finally {
      rmSync(joined, { recursive: true, force: true })
    }
  })
})

describe('an It that could not be reached', () => {
  test('is told by the code of the failure, as a connection of the program’s own gives it and as each runtime’s `fetch` does, and never by its words', () => {
    // As the system says it of a connection this program opened itself
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPROTO'])
      expect([code, notReached(Object.assign(new Error('whatever it says'), { code }))]).toEqual([code, true])
    // As Node's own `fetch` says it, under the error's cause, and as Bun's does, under a name of its own
    expect(notReached(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) }))).toBe(
      true,
    )
    expect(notReached(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }))).toBe(true)
    // Words that sound like it are not it, and neither is a refusal, a time limit or anything that is no error
    expect(notReached(new Error('fetch failed: ECONNREFUSED, the network is unreachable'))).toBe(false)
    expect(notReached(Object.assign(new Error('no'), { code: 'not_found' }))).toBe(false)
    expect(notReached(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false)
    for (const nothing of [undefined, null, 'ECONNREFUSED', 7]) expect(notReached(nothing)).toBe(false)
  })
})

describe('a call the backend gave up on because another touched the same record', () => {
  const clash = () =>
    new Error('Documents read from or written to the "rateLimits" table changed while this mutation was being run and on every subsequent retry.')

  test('is asked again, a few times, and no other failure is', async () => {
    let asked = 0
    const pauses: number[] = []
    const pause = async (n: number) => void pauses.push(n)
    expect(
      await overClashes(async () => {
        if (++asked < 3) throw clash()
        return 'done'
      }, pause),
    ).toBe('done')
    expect(asked).toBe(3)
    expect(pauses).toEqual([1, 2])
    // One that keeps clashing is given up on after four tries, with the clash as the reason
    asked = 0
    await expect(
      overClashes(async () => {
        asked++
        throw clash()
      }, pause),
    ).rejects.toSatisfy(clashed)
    expect(asked).toBe(4)
    // A production backend may say no more than this of a clash, and a mutation that failed did nothing: asked again too
    asked = 0
    expect(
      await overClashes(async () => {
        if (++asked < 2) throw new Error('[Request ID: 0123456789abcdef] Server Error')
        return 'done'
      }, pause),
    ).toBe('done')
    expect(asked).toBe(2)
    // Anything else is not asked again: it may have been done
    asked = 0
    await expect(
      overClashes(async () => {
        asked++
        throw new Error('fetch failed')
      }, pause),
    ).rejects.toThrow('fetch failed')
    expect(asked).toBe(1)
  })
})

describe('an add-on that is wanted', () => {
  const never = async () => {
    throw new Error('the harness was asked when nothing turned on its answer')
  }
  test('is installed again when it is connected at an older version, so that fixes reach those who have it', async () => {
    const { whatToDo } = await import('./src/setup')
    expect(await whatToDo('connected', 'an-older-version', 'this-version', never)).toBe('install')
    expect(await whatToDo('connected', undefined, 'this-version', never)).toBe('install')
    expect(await whatToDo('connected', 'this-version', 'this-version', never)).toBe('nothing')
  })
  test('is left to a newer copy of the program that installed it after this one started, and not put back as it was', async () => {
    const { whatToDo } = await import('./src/setup')
    // A connector that has been running since before the program was brought up to date
    const started = 1_000_000
    expect(await whatToDo('connected', 'a-newer-version', 'this-version', never, started + 5000, started)).toBe('leave to the newer program')
    // One installed before this program started is merely old, and is installed again
    expect(await whatToDo('connected', 'an-older-version', 'this-version', never, started - 5000, started)).toBe('install')
    // This program's own is left as it is, whenever it was installed
    expect(await whatToDo('connected', 'this-version', 'this-version', never, started + 5000, started)).toBe('nothing')
    // And an install that stopped half way is finished
    expect(await whatToDo('connected', 'installing', 'this-version', never, started + 5000, started)).toBe('install')
  })
  test('is left alone when this program installed it and the person switched it off inside the harness, at any version', async () => {
    const { whatToDo } = await import('./src/setup')
    expect(await whatToDo('not_connected', 'an-older-version', 'this-version', async () => true)).toBe('leave switched off')
    expect(await whatToDo('not_connected', 'this-version', 'this-version', async () => true)).toBe('leave switched off')
  })
  test('is installed when it is not there, was never installed by this program, or an install stopped half way', async () => {
    const { whatToDo } = await import('./src/setup')
    expect(await whatToDo('not_connected', 'this-version', 'this-version', async () => false)).toBe('install')
    expect(await whatToDo('not_connected', 'this-version', 'this-version', async () => null)).toBe('install')
    expect(await whatToDo('not_connected', undefined, 'this-version', never)).toBe('install')
    expect(await whatToDo('not_connected', 'installing', 'this-version', never)).toBe('install')
  })
})

describe('a message Codex cannot be started with', () => {
  test('is a refusal like any other, said in words that do not repeat the message', async () => {
    // Nothing on the path, so that no Codex could be started here whatever the message
    const before = process.env.PATH
    process.env.PATH = mkdtempSync(path.join(os.tmpdir(), 'it-no-codex-'))
    try {
      const said = await codexQueue('thr-1', '[It] The page "PRIVATE TITLE\u0000x" (plan) sent this just after someone used it: approve')
      expect(said).toBe(process.platform === 'win32' ? 'Codex was not found' : 'Codex could not be started with that message')
      expect(await codexQueue('thr-1', 'an ordinary message')).toBe('Codex was not found')
      expect(await codexQueue('not a thread id', 'x')).toMatch(/conversation id/)
    } finally {
      rmSync(process.env.PATH, { recursive: true, force: true })
      process.env.PATH = before
    }
  })
})

describe('joining an It that runs on another machine', () => {
  test('the address to join is where its site is opened, and is kept as that and nothing more', () => {
    expect(doorAddress('http://192.168.1.20:21000')).toBe('http://192.168.1.20:21000')
    expect(doorAddress('http://192.168.1.20:21000/')).toBe('http://192.168.1.20:21000')
    expect(doorAddress('https://it.home.example')).toBe('https://it.home.example')
    for (const bad of [
      'http://192.168.1.20:21000/pair#an-invite',
      'http://192.168.1.20:21000/?a=1',
      'http://someone:a-password@192.168.1.20:21000',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '192.168.1.20:21000',
      'not an address',
      '',
    ])
      expect([bad, doorAddress(bad)]).toEqual([bad, null])
  })
})

/**
 * Whether whoever runs the tests may make a link at all. Windows lets only some users, and a
 * test that has to make one to show what is done about it has nothing to show where none can
 * be made: it is left out there, and no product code is at fault for that.
 */
const canLink = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-link-'))
  try {
    symlinkSync(dir, path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('gathering a folder to publish', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'it-gather-'))
    writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>')
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'assets/app.js'), 'x')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('files are listed by their path inside the folder, with sizes and checksums', () => {
    const files = gather({ dir })
    expect(files.map((f) => f.entry.path)).toEqual(['assets/app.js', 'index.html'])
    expect(files[1]!.entry).toMatchObject({ size: 11, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
  test.skipIf(!canLink)('a link is never followed: a folder cannot be made to publish a file from elsewhere on the machine', () => {
    const secret = path.join(os.tmpdir(), `it-secret-${process.pid}`)
    writeFileSync(secret, 'a private key')
    symlinkSync(secret, path.join(dir, 'assets/key.json'))
    try {
      expect(() => gather({ dir })).toThrow(/is a link/)
    } finally {
      rmSync(path.join(dir, 'assets/key.json'))
      rmSync(secret)
    }
  })
  test.skipIf(!canLink)('a folder swapped for a link after it was listed cannot bring in a file from elsewhere', () => {
    // What the check would meet if `assets` became a link to another folder between being
    // listed and its file being opened: the file opens, and is found to be somewhere else
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-elsewhere-'))
    const root = mkdtempSync(path.join(os.tmpdir(), 'it-swap-'))
    try {
      writeFileSync(path.join(elsewhere, 'machine.json'), '{"key":"private"}')
      symlinkSync(elsewhere, path.join(root, 'assets'))
      mkdirSync(path.join(root, 'real'))
      writeFileSync(path.join(root, 'real', 'machine.json'), 'fine')
      const inside = realpathSync(root)
      expect(() => read(path.join(root, 'assets', 'machine.json'), 'assets/machine.json', 17, { bytes: 0 }, inside)).toThrow(/outside the folder/)
      expect(read(path.join(root, 'real', 'machine.json'), 'real/machine.json', 4, { bytes: 0 }, inside).data.toString()).toBe('fine')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canLink)('a folder swapped for a link at the very moment it is entered is found out, however the swap is timed', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-elsewhere-'))
    const root = mkdtempSync(path.join(os.tmpdir(), 'it-swap-'))
    const before = process.cwd()
    const chdir = process.chdir.bind(process)
    try {
      writeFileSync(path.join(elsewhere, 'machine.json'), '{"key":"private"}')
      writeFileSync(path.join(root, 'index.html'), '<p>ok</p>')
      mkdirSync(path.join(root, 'assets'))
      writeFileSync(path.join(root, 'assets', 'machine.json'), 'harmless')
      // Just as the folder is about to be entered, after it was listed and found to be an
      // ordinary folder, someone swaps it for a link to another folder that has a file of the same name
      process.chdir = ((to: string) => {
        if (to === 'assets') {
          rmSync(path.join(root, 'assets'), { recursive: true })
          symlinkSync(elsewhere, path.join(root, 'assets'))
        }
        chdir(to)
      }) as typeof process.chdir
      expect(() => gather({ dir: root })).toThrow(/outside the folder/)
      // And the program is back where it stood, whatever happened
      expect(process.cwd()).toBe(before)
    } finally {
      process.chdir = chdir
      chdir(before)
      rmSync(elsewhere, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canLink)('the folder named may itself be a link to a folder, and is published as that folder', () => {
    const real = mkdtempSync(path.join(os.tmpdir(), 'it-real-'))
    const holder = mkdtempSync(path.join(os.tmpdir(), 'it-holder-'))
    try {
      writeFileSync(path.join(real, 'index.html'), '<p>built</p>')
      symlinkSync(real, path.join(holder, 'dist'))
      expect(gather({ dir: path.join(holder, 'dist') }).map((f) => f.entry.path)).toEqual(['index.html'])
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(holder, { recursive: true, force: true })
    }
  })

  test('a file that is too large is refused before it is read', () => {
    const big = path.join(dir, 'big.bin')
    // A sparse file: its size is what counts, and nothing this large is ever loaded
    const fd = openSync(big, 'w')
    ftruncateSync(fd, 26 * 1024 * 1024)
    closeSync(fd)
    try {
      expect(() => gather({ dir })).toThrow(/larger than 25 MB/)
    } finally {
      rmSync(big)
    }
  })
})

describe('naming the project a page belongs to', () => {
  test('only the owner and repository are taken from a git remote, in any of its forms', () => {
    expect(projectKey('https://github.com/acme/site.git')).toBe('acme/site')
    expect(projectKey('git@github.com:acme/site.git')).toBe('acme/site')
    expect(projectKey('ssh://git@host.example:2222/acme/site')).toBe('acme/site')
    expect(projectKey('https://gitlab.example/group/sub/site/')).toBe('sub/site')
  })
  test('a password or token in the remote is never part of it', () => {
    expect(projectKey('https://x-access-token:ghp_SECRET@github.com/acme/site.git')).toBe('acme/site')
    // With nothing but a repository after the host, there is no owner to name: the folder's name is used instead
    expect(projectKey('https://user:hunter2@host.example/site.git')).toBeUndefined()
    for (const remote of [
      'https://user:hun/ter2@host.example/acme/site',
      'https://user:hun@ter2@host.example/acme/site',
      '/srv/git/site.git',
      'not a remote',
      '',
    ])
      expect(projectKey(remote) ?? '').not.toMatch(/hun|ter2|user/)
  })
})

describe('starting Codex to queue a click', () => {
  const having =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f)
  test('anywhere but Windows it is the plain command', () => {
    expect(codexCommand('linux', '/usr/bin', () => false)).toEqual(['codex'])
  })
  test('on Windows it is the program itself, never the .cmd file a shell would have to start', () => {
    const PATH = 'C:\\tools;C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs'
    const cmd = 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd'
    const script = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    expect(codexCommand('win32', PATH, having('C:\\tools\\codex.exe', cmd, script, node))).toEqual(['C:\\tools\\codex.exe'])
    expect(codexCommand('win32', PATH, having(cmd, script, node))).toEqual([node, script])
    // Nothing that can be started without a shell: the click waits instead
    expect(codexCommand('win32', PATH, having(cmd, script))).toBeNull()
    expect(codexCommand('win32', PATH, having(cmd, node))).toBeNull()
    expect(codexCommand('win32', '', having(cmd, script, node))).toBeNull()
  })
})

describe('a machine that leaves', () => {
  test('keeps nothing of the identity it had: neither its key nor a token made with it', () => {
    const before = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-left-'))
    process.env.IT_HOME = folder
    try {
      writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'laptop', key: { d: 'private' } }))
      writeFileSync(path.join(folder, 'token.json'), JSON.stringify({ token: 'a-token', exp: 0, machine: 'machine-1', site: 'http://127.0.0.1:9' }))
      forgetMachine()
      expect(readdirSync(folder)).toEqual([])
      // With nothing to forget, nothing happens
      forgetMachine()
      expect(readdirSync(folder)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('a file It keeps for this person alone', () => {
  let folder: string
  beforeAll(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-kept-'))
  })
  afterAll(() => rmSync(folder, { recursive: true, force: true }))
  /**
   * Runs something with every step the program takes on a file noted in the order it takes
   * them: opened, wrote, flushed, closed, and named when it is given another name. `takes`
   * says how many bytes the system takes of those it is given in one go, as a disk that is
   * nearly full takes fewer than it is given and says so without failing.
   */
  const watching = (run: () => void, takes: (given: number, already: number) => number = (given) => given) => {
    const real = {
      openSync: fs.openSync,
      writeSync: fs.writeSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      renameSync: fs.renameSync,
      writeFileSync: fs.writeFileSync,
    }
    const open = new Map<number, string>()
    const steps: string[] = []
    let already = 0
    const named = (file: unknown) => path.relative(folder, String(file))
    fs.openSync = ((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = real.openSync(file, flags ?? 'r', mode)
      open.set(fd, named(file))
      steps.push(`opened ${named(file)}`)
      return fd
    }) as typeof fs.openSync
    fs.writeSync = ((fd: number, bytes: Uint8Array, at?: number, length?: number) => {
      // A program that goes on giving the system what it does not take would never end
      if (steps.length > 5000) throw new Error('the program went on writing what the system did not take')
      const from = at ?? 0
      const taken = takes(length ?? bytes.length - from, already)
      if (taken > 0) real.writeSync(fd, bytes, from, taken)
      already += taken
      steps.push(`wrote ${open.get(fd)}`)
      return taken
    }) as typeof fs.writeSync
    fs.fsyncSync = (fd: number) => {
      real.fsyncSync(fd)
      steps.push(`flushed ${open.get(fd)}`)
    }
    fs.closeSync = (fd: number) => {
      real.closeSync(fd)
      steps.push(`closed ${open.get(fd)}`)
      open.delete(fd)
    }
    fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
      real.renameSync(from, to)
      steps.push(`named ${named(from)} ${named(to)}`)
    }
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
      real.writeFileSync(file, data, options)
      steps.push(`wrote ${named(file)}`)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    try {
      run()
    } finally {
      Object.assign(fs, real)
      syncBuiltinESMExports()
    }
    return steps
  }

  test('is written with every byte it is to have, though the system takes them a few at a time, and is on the disk before it is given its name', () => {
    const file = path.join(folder, 'whole', 'machine.json')
    const kept = { id: 'machine-1', name: 'the desk', key: { d: 'the only copy of this machine’s key' } }
    const steps = watching(
      () => writePrivate(file, kept),
      (given) => Math.min(given, 7),
    )
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(kept)
    expect(readdirSync(path.dirname(file))).toEqual(['machine.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // It was written under another name, flushed there after the last of it was written, and only then given its own
    const giving = steps.findIndex((step) => step.startsWith('named ') && step.endsWith(` ${path.join('whole', 'machine.json')}`))
    expect(giving).toBeGreaterThan(-1)
    const under = steps[giving]!.split(' ')[1]!
    expect(under).not.toBe(path.join('whole', 'machine.json'))
    const before = steps.slice(0, giving)
    expect(before.filter((step) => step === `wrote ${under}`).length).toBeGreaterThan(5)
    expect(before.lastIndexOf(`flushed ${under}`)).toBeGreaterThan(before.lastIndexOf(`wrote ${under}`))
    expect(before.lastIndexOf(`closed ${under}`)).toBeGreaterThan(before.lastIndexOf(`flushed ${under}`))
  })

  test('is not given its name when the disk takes only a part of it, and what the file held before is still there', () => {
    const file = path.join(folder, 'part', 'machine.json')
    writePrivate(file, { id: 'machine-1', key: { d: 'the key it had' } })
    let failed: unknown
    watching(
      () => {
        try {
          writePrivate(file, { id: 'machine-2', key: { d: 'a key the disk has no room for' } })
        } catch (err) {
          failed = err
        }
      },
      // The disk takes the first ten bytes, and after those none
      (given, already) => Math.min(given, Math.max(0, 10 - already)),
    )
    expect(failed).toMatchObject({ code: 'ENOSPC' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: 'machine-1', key: { d: 'the key it had' } })
    expect(readdirSync(path.dirname(file))).toEqual(['machine.json'])
  })
})

describe('which conversation a command is run in', () => {
  // The processes above the command hold no agent app, or cannot be seen
  const unseen = () => []
  test('Claude Code’s own word for it is believed over what the add-on last noted', () => {
    // The person has just resumed conversation B; the add-on's note still says A for a moment
    expect(currentSession({ CLAUDE_CODE_SESSION_ID: 'B', IT_HARNESS: 'claude-code', IT_SESSION: 'A' }, unseen)).toEqual({ harness: 'claude-code', id: 'B' })
    expect(currentSession({ CLAUDE_CODE_SESSION_ID: 'B' }, unseen)).toEqual({ harness: 'claude-code', id: 'B' })
    // Where Claude Code says nothing, the add-on's note is what there is
    expect(currentSession({ IT_HARNESS: 'claude-code', IT_SESSION: 'A' }, unseen)).toEqual({ harness: 'claude-code', id: 'A' })
  })
  test('one app’s marks alone are believed without looking at what started the command', () => {
    const never = () => {
      throw new Error('the processes above were looked at when only one app had marked the command')
    }
    expect(currentSession({ CODEX_THREAD_ID: 'T' }, never)).toEqual({ harness: 'codex', id: 'T' })
    expect(currentSession({ PI_SESSION_ID: 'P' }, never)).toEqual({ harness: 'pi', id: 'P' })
    expect(currentSession({ HERMES_SESSION_ID: 'H' }, never)).toEqual({ harness: 'hermes', id: 'H' })
    expect(currentSession({ IT_HARNESS: 'opencode', IT_SESSION: 'O' }, never)).toEqual({ harness: 'opencode', id: 'O' })
    // A pair that someone set for an app is believed over that app's own variable
    expect(currentSession({ IT_HARNESS: 'codex', IT_SESSION: 'said', CODEX_THREAD_ID: 'T' }, never)).toEqual({ harness: 'codex', id: 'said' })
    expect(currentSession({}, never)).toBeUndefined()
    // Half a pair is no pair
    expect(currentSession({ IT_HARNESS: 'pi' }, never)).toBeUndefined()
  })

  // What each app leaves in the environment of the commands its agent runs. Claude Code is
  // there twice: with It's add-on, which notes the conversation as a pair, and without it.
  const marks: Record<string, { app: string; env: (id: string) => Record<string, string> }> = {
    'Claude Code': { app: 'claude-code', env: (id) => ({ CLAUDE_CODE_SESSION_ID: id, IT_HARNESS: 'claude-code', IT_SESSION: id }) },
    'Claude Code without the add-on': { app: 'claude-code', env: (id) => ({ CLAUDE_CODE_SESSION_ID: id }) },
    Codex: { app: 'codex', env: (id) => ({ CODEX_THREAD_ID: id }) },
    Pi: { app: 'pi', env: (id) => ({ PI_SESSION_ID: id }) },
    Hermes: { app: 'hermes', env: (id) => ({ HERMES_SESSION_ID: id }) },
    OpenCode: { app: 'opencode', env: (id) => ({ IT_HARNESS: 'opencode', IT_SESSION: id }) },
    OpenClaw: { app: 'openclaw', env: (id) => ({ IT_HARNESS: 'openclaw', IT_SESSION: id }) },
  }
  // With no pair and nothing seen, the order in which an app's own variable is taken
  const order = ['codex', 'openclaw', 'hermes', 'opencode', 'pi', 'claude-code']
  for (const [outer, o] of Object.entries(marks))
    for (const [inner, i] of Object.entries(marks))
      if (o.app !== i.app) {
        // The inner app's marks are put over whatever it inherited from the outer one
        const env: Record<string, string | undefined> = { ...o.env('the-outer-one'), ...i.env('the-inner-one') }
        test(`a command run by ${inner}, which was itself started from inside ${outer}, belongs to the inner conversation`, () => {
          expect(sessionAsked(env, () => [i.app, o.app])).toEqual({ session: { harness: i.app, id: 'the-inner-one' }, unsettled: [] })
        })
        test(`when what started it cannot be seen, a command run by ${inner} inside ${outer} goes by the pair, or failing a pair by a fixed order, and every other app that marked it is named`, () => {
          const present = order.filter(
            (app) =>
              env.IT_HARNESS === app ||
              env[{ codex: 'CODEX_THREAD_ID', pi: 'PI_SESSION_ID', hermes: 'HERMES_SESSION_ID', 'claude-code': 'CLAUDE_CODE_SESSION_ID' }[app] ?? ''],
          )
          const chosen = env.IT_HARNESS ?? present[0]!
          const others = present.filter((app) => app !== chosen)
          const asked = sessionAsked(env, unseen)!
          expect(asked.session).toEqual({ harness: chosen, id: chosen === i.app ? 'the-inner-one' : 'the-outer-one' })
          expect([...asked.unsettled].sort()).toEqual([...others].sort())
          // Said whenever another app had marked the command, and only then
          const note = sessionNote(asked, 'This page was given to', 'say so.')
          if (others.length) expect(note).toContain(`conversation ${asked.session.id}.`)
          else expect(note).toBeUndefined()
        })
      }

  test('an inner Claude Code conversation keeps its page when it was started from inside Codex and neither can be seen above', () => {
    const env = { CODEX_THREAD_ID: 'outer-codex', CLAUDE_CODE_SESSION_ID: 'inner-claude', IT_HARNESS: 'claude-code', IT_SESSION: 'inner-claude' }
    expect(sessionAsked(env, unseen)).toEqual({ session: { harness: 'claude-code', id: 'inner-claude' }, unsettled: ['codex'] })
    // An inherited pair for OpenCode cannot be told from one OpenCode wrote for this command, and the answer says so
    expect(sessionAsked({ IT_HARNESS: 'opencode', IT_SESSION: 'outer-opencode', CODEX_THREAD_ID: 'inner-codex' }, unseen)).toEqual({
      session: { harness: 'opencode', id: 'outer-opencode' },
      unsettled: ['codex'],
    })
    // Naming the conversation by hand settles it wherever nothing can be seen
    expect(currentSession({ ...env, IT_HARNESS: 'codex', IT_SESSION: 'outer-codex' }, unseen)).toEqual({ harness: 'codex', id: 'outer-codex' })
  })

  test('with no pair and nothing seen above, another app’s own variable is taken before Claude Code’s, and the answer says it is a choice', () => {
    for (const [name, harness] of [
      ['CODEX_THREAD_ID', 'codex'],
      ['PI_SESSION_ID', 'pi'],
      ['HERMES_SESSION_ID', 'hermes'],
    ] as const)
      expect(sessionAsked({ CLAUDE_CODE_SESSION_ID: 'parent', [name]: 'child' }, unseen)).toEqual({
        session: { harness, id: 'child' },
        unsettled: ['claude-code'],
      })
    // An agent app above the command that left no mark on it settles nothing either
    expect(sessionAsked({ CLAUDE_CODE_SESSION_ID: 'parent', CODEX_THREAD_ID: 'child' }, () => ['opencode'])).toEqual({
      session: { harness: 'codex', id: 'child' },
      unsettled: ['claude-code'],
    })
  })

  test('a pair set by hand for an app that is nowhere above is believed over the app that is, and the answer says the other had marked the command', () => {
    for (const app of ['pi', 'openclaw', 'a-name-of-their-own'])
      expect(sessionAsked({ CLAUDE_CODE_SESSION_ID: 'B', IT_HARNESS: app, IT_SESSION: 'P' }, () => ['claude-code'])).toEqual({
        session: { harness: app, id: 'P' },
        unsettled: ['claude-code'],
      })
    // Claude Code's pair is inherited by whatever is started from inside its conversation, so the app seen above is believed over it
    expect(
      sessionAsked({ CLAUDE_CODE_SESSION_ID: 'outer', IT_HARNESS: 'claude-code', IT_SESSION: 'outer', CODEX_THREAD_ID: 'inner' }, () => ['codex']),
    ).toEqual({
      session: { harness: 'codex', id: 'inner' },
      unsettled: [],
    })
  })

  test('the note names the conversation chosen and every other app that had marked the command, and there is none when the conversation is known', () => {
    expect(
      sessionNote({ session: { harness: 'claude-code', id: 'inner-claude' }, unsettled: ['codex'] }, 'This page was given to', 'publish it again with --take.'),
    ).toBe(
      'This page was given to the Claude Code conversation inner-claude. This command also carried the marks of Codex, and which of them ran it could not be told. If that is not the conversation you are in, publish it again with --take.',
    )
    expect(sessionNote({ session: { harness: 'pi', id: 'p' }, unsettled: ['codex', 'hermes', 'their-own'] }, 'It was given to', 'say so.')).toContain(
      'the marks of Codex, Hermes and their-own,',
    )
    // A name of the person's own is said as they wrote it, whatever it is
    expect(sessionNote({ session: { harness: 'constructor', id: 'c' }, unsettled: ['toString'] }, 'It was given to', 'say so.')).toBe(
      'It was given to the constructor conversation c. This command also carried the marks of toString, and which of them ran it could not be told. If that is not the conversation you are in, say so.',
    )
    expect(sessionNote({ session: { harness: 'codex', id: 'T' }, unsettled: [] }, 'It was given to', 'say so.')).toBeUndefined()
    expect(sessionNote(undefined, 'It was given to', 'say so.')).toBeUndefined()
  })
})

describe('the agent apps a command was started from', () => {
  test('an app is known by its own program, or by the script a runtime was given, and a mention of its name is not the app', () => {
    const apps = [
      [['claude', '--output-format', 'stream-json'], 'claude-code'],
      [['/Users/Chris Work/.local/bin/claude'], 'claude-code'],
      [['node', '/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js'], 'claude-code'],
      [['node', '--require', '/work/preload.js', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], 'claude-code'],
      [['/opt/node/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex', 'app-server'], 'codex'],
      [['node', '/opt/node/bin/codex', '-c', 'features.x=true'], 'codex'],
      [['node', '/work/app/node_modules/.bin/codex', 'app-server'], 'codex'],
      [['node', '--no-warnings', '/usr/local/bin/pi'], 'pi'],
      [['bun', 'run', '/home/a/.bun/bin/pi'], 'pi'],
      [['/home/a/.hermes/venv/bin/python3', '/home/a/.local/bin/hermes'], 'hermes'],
      [['python3.12', '-X', 'utf8', '/home/a/.local/bin/hermes', 'chat'], 'hermes'],
      [['C:\\Users\\a\\AppData\\Local\\opencode\\opencode.exe'], 'opencode'],
      [['/opt/node/bin/node', '/opt/node/lib/node_modules/openclaw/dist/index.js', 'gateway'], 'openclaw'],
    ] as const
    for (const [argv, app] of apps) expect([argv.join(' '), agentApp({ argv: [...argv] })]).toEqual([argv.join(' '), app])
    for (const argv of [
      ['/bin/bash', '-c', 'codex exec "say hello"'],
      // A script of someone's own that is called after an app, wherever it is kept
      ['node', '/work/scripts/codex.js'],
      ['node', '/work/scripts/codex.mjs'],
      ['node', '/work/codex'],
      ['node', '/work/codex/scripts/build.js'],
      ['/usr/bin/python3', '/home/a/projects/openclaw-task-command-center/command_center.py', 'serve'],
      // Code written on the command line that mentions a launcher
      ['node', '-e', 'spawn("/opt/node/bin/codex")', '/opt/node/bin/codex'],
      ['python3', '-m', 'http.server', '/home/a/.local/bin/hermes'],
      // What a switch is followed by is not the script
      ['node', '--require', '/opt/node/bin/codex', '/work/server.js'],
      ['npm', 'exec', 'it', 'create'],
      ['/opt/node/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host'],
      // A program that is in a folder called after an app
      ['/Users/claude tools/editor'],
      ['/Users/Chris/claude tools/wrapper'],
      ['node'],
      [],
    ])
      expect([argv.join(' '), agentApp({ argv })]).toEqual([argv.join(' '), undefined])
    // A program named after something every object has is still not an app
    expect(agentApp({ argv: ['constructor'] })).toBeUndefined()
  })

  test('the nearest app comes first, however many shells and launchers stand in between', () => {
    // A command run by Codex, which Claude Code's agent started: the shell, Codex, the script that launches it, another shell, Claude Code
    const table = new Map<number, Proc>([
      [900, { parent: 800, argv: ['/bin/sh', '-c', 'it create "Plan" --file plan.html'] }],
      [800, { parent: 700, argv: ['/opt/node/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex', 'exec'] }],
      [700, { parent: 600, argv: ['node', '/opt/node/bin/codex', 'exec'] }],
      [600, { parent: 500, argv: ['/bin/bash', '-c', 'codex exec "make a page"'] }],
      [500, { parent: 400, argv: ['claude'] }],
      [400, { parent: 1, argv: ['-zsh'] }],
    ])
    const look = (pid: number) => table.get(pid)
    expect(appsFrom(900, look)).toEqual(['codex', 'claude-code'])
    // The same two the other way round
    table.set(800, { parent: 700, argv: ['claude', '-p', 'make a page'] })
    table.set(700, { parent: 600, argv: ['/bin/bash', '-lc', 'claude -p "make a page"'] })
    table.set(600, { parent: 500, argv: ['codex'] })
    table.set(500, { parent: 400, argv: ['node', '/opt/node/bin/codex'] })
    expect(appsFrom(900, look)).toEqual(['claude-code', 'codex'])
    // And so the conversation is the inner app's, with the very same marks in the environment
    const env = { CLAUDE_CODE_SESSION_ID: 'claude-1', IT_HARNESS: 'claude-code', IT_SESSION: 'claude-1', CODEX_THREAD_ID: 'codex-1' }
    expect(currentSession(env, () => appsFrom(900, look))).toEqual({ harness: 'claude-code', id: 'claude-1' })
  })

  test('a helper of the project’s own that is called after an app, standing between the command and the app that ran it, does not take the page from that app', () => {
    const table = new Map<number, Proc>([
      [900, { parent: 800, argv: ['node', '/work/probe.mjs'] }],
      [800, { parent: 700, argv: ['node', '/work/codex.mjs'] }],
      [700, { parent: 600, argv: ['claude'] }],
      [600, { parent: 500, argv: ['/bin/bash', '-c', 'claude'] }],
      [500, { parent: 1, argv: ['/opt/node/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex'] }],
    ])
    const env = { CODEX_THREAD_ID: 'outer-codex', CLAUDE_CODE_SESSION_ID: 'inner-claude', IT_HARNESS: 'claude-code', IT_SESSION: 'inner-claude' }
    expect(sessionAsked(env, () => appsFrom(900, (pid) => table.get(pid)))).toEqual({ session: { harness: 'claude-code', id: 'inner-claude' }, unsettled: [] })
  })

  test('the walk ends at the top, at a process that cannot be read, in a ring of processes, and after so many steps', () => {
    const ring = new Map<number, Proc>([
      [10, { parent: 11, argv: ['sh'] }],
      [11, { parent: 10, argv: ['node', '/usr/local/bin/pi'] }],
    ])
    expect(appsFrom(10, (pid) => ring.get(pid))).toEqual(['pi'])
    expect(appsFrom(10, () => undefined)).toEqual([])
    expect(appsFrom(1, () => ({ parent: 0, argv: ['claude'] }))).toEqual([])
    // A chain longer than the walk goes: the app at its far end is not reached
    const long = (pid: number): Proc => (pid === 5 ? { parent: 4, argv: ['codex'] } : { parent: pid - 1, argv: ['sh'] })
    expect(appsFrom(1000, long)).toEqual([])
    expect(appsFrom(30, long)).toEqual(['codex'])
  })

  test('what `ps` prints is read into the same table, where a program in a folder with a space in its name is read whole', () => {
    const table = psTable(
      [
        '    1     0 /sbin/launchd',
        '  501     1 -zsh',
        '  600   501 /usr/local/bin/codex',
        '  612   600 /Users/Chris Work/.local/bin/claude',
        '  700   612 /bin/zsh',
        '  701   700 node',
        '  800   701 /Users/claude tools/editor',
        '  810   800 /Users/a b/My Tools/node',
        '',
      ].join('\n'),
    )
    expect(table.get(612)).toEqual({ parent: 600, argv: ['/Users/Chris Work/.local/bin/claude'] })
    // The words after a runtime say what it runs; the program is taken off the front whole
    psWords(table, ['  701 node --no-warnings /opt/homebrew/bin/pi chat', '  810 /Users/a b/My Tools/node /Users/a b/bin/pi', '  999 gone'].join('\n'))
    expect(table.get(701)).toEqual({ parent: 700, argv: ['node', '--no-warnings', '/opt/homebrew/bin/pi', 'chat'] })
    expect(table.get(810)!.argv).toEqual(['/Users/a b/My Tools/node', '/Users/a', 'b/bin/pi'])
    // A folder called after an app is not the app, and the app in a folder with a space in its name is found
    expect(appsFrom(800, (pid) => table.get(pid))).toEqual(['pi', 'claude-code', 'codex'])
    expect(agentApp(table.get(810)!)).toBeUndefined()
    // Only words that are themselves a launcher before the space are taken for an app
    psWords(table, '  701 node /opt/tools/bin/pi tools/run.js')
    expect(agentApp(table.get(701)!)).toBe('pi')
  })

  test.skipIf(process.platform === 'win32' || !existsSync('/bin/ps'))(
    'the real `ps` of this system gives a table that holds this process and what started it',
    () => {
      const table = psAbove(process.pid)
      expect(table.get(process.pid)?.parent).toBe(process.ppid)
      expect(table.get(process.ppid)?.argv[0]).toEqual(expect.any(String))
      // This process is a runtime, so its words were asked for, and none of them was put in the place of its program
      expect(table.get(process.pid)!.argv.length).toBeGreaterThan(0)
    },
  )

  test.skipIf(process.platform !== 'linux')('on Linux a process is read from /proc: what started it, and the first words of its command', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'a word that is never run'])
    try {
      await new Promise((r) => child.once('spawn', r))
      expect(linuxProc(child.pid!)).toEqual({
        parent: process.pid,
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)', 'a word that is never run'],
      })
    } finally {
      child.kill()
    }
    expect(linuxProc(process.pid)?.parent).toBe(process.ppid)
    expect(linuxProc(2 ** 30)).toBeUndefined()
    // And looking for real never fails, whatever machine the tests run on
    expect(Array.isArray(agentAppsAbove())).toBe(true)
  })
})

describe('the line a person on Windows is given to put It’s folder on their PATH', () => {
  const line = windowsPathCommand("C:\\Users\\O’Neil\\it's\\bin")
  test('reads the PATH as Windows keeps it, with a name such as %JAVA_HOME% left as a name, and writes it back as the kind of value it was', () => {
    expect(line).toContain("$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')")
    expect(line).toContain("$k.GetValueKind('Path')")
    expect(line).toContain("$k.SetValue('Path', ")
    // Read the usual way, every such name comes back as what it stands for today, and would be written back as that for good
    expect(line).not.toContain("GetEnvironmentVariable('Path'")
    expect(line).not.toContain("SetEnvironmentVariable('Path'")
    expect(line).not.toContain('\n')
  })
  test('adds the folder only where it is not there already, and writes every mark PowerShell reads as an apostrophe twice', () => {
    const folder = "'C:\\Users\\O’’Neil\\it''s\\bin'"
    expect(line).toContain(`if (($p -split ';') -notcontains ${folder}) {`)
    expect(line).toContain(`(@(${folder}, $p) | Where-Object { $_ }) -join ';'`)
  })
})

describe('running a harness’s own commands', () => {
  test('what marks this conversation is left out, and where the person keeps a harness’s settings is kept', () => {
    const before = { ...process.env }
    try {
      Object.assign(process.env, {
        CLAUDE_CODE_SESSION_ID: 's1',
        CLAUDECODE: '1',
        CODEX_THREAD_ID: 't1',
        IT_SESSION: 's1',
        IT_HARNESS: 'claude-code',
        CODEX_HOME: '/work/codex',
        CLAUDE_CONFIG_DIR: '/work/claude',
        HERMES_HOME: '/work/hermes',
      })
      const env = harnessEnv()
      expect([env.CLAUDE_CODE_SESSION_ID, env.CLAUDECODE, env.CODEX_THREAD_ID, env.IT_SESSION, env.IT_HARNESS]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ])
      expect([env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.HERMES_HOME]).toEqual(['/work/codex', '/work/claude', '/work/hermes'])
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
      Object.assign(process.env, before)
    }
  })
})

describe('reaching the connector over a port', () => {
  const TOKEN = 'ab'.repeat(24)
  let home: string
  let server: http.Server
  let seen: { headers: http.IncomingHttpHeaders; url: string; body: string }[]
  let answer: (req: { nonce: string }) => { status?: number; text: string; mac?: string | null; dribble?: boolean }
  const before = process.env.IT_HOME
  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'it-port-'))
    process.env.IT_HOME = home
    server = http.createServer((req, res) => {
      let body = ''
      req
        .on('data', (c) => (body += c))
        .on('end', () => {
          seen.push({ headers: req.headers, url: req.url ?? '', body })
          const a = answer({ nonce: String(req.headers['x-it-nonce']) })
          const status = a.status ?? 200
          const sealed = a.mac === undefined ? mac(TOKEN, String(req.headers['x-it-nonce']), `${status}\n${a.text}`) : a.mac
          res.writeHead(status, { 'content-type': 'application/json', ...(sealed ? { 'x-it-mac': sealed } : {}) })
          if (!a.dribble) return res.end(a.text)
          // A little at a time, for ever: never finished
          const drip = setInterval(() => res.write(' '), 200)
          res.on('close', () => clearInterval(drip))
        })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    writeFileSync(
      path.join(home, 'connector.json'),
      JSON.stringify({ port: (server.address() as { port: number }).port, token: TOKEN, pid: 1, version: 'x', startedAt: 0 }),
    )
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    server.closeAllConnections()
    rmSync(home, { recursive: true, force: true })
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
  })

  test('the token is never sent: the request carries a code made from it, and only a sealed answer is believed', async () => {
    seen = []
    answer = () => ({ text: '{"ok":true}' })
    expect(await local('/health')).toEqual({ ok: true })
    const sent = seen[0]!
    expect(JSON.stringify(sent.headers)).not.toContain(TOKEN)
    expect(sent.headers['x-it-mac']).toBe(createHmac('sha256', TOKEN).update(`${sent.headers['x-it-nonce']}\nGET\n/health\n`).digest('hex'))
    // A body is sealed with the request too
    await local('/ack', { method: 'POST', body: { ids: ['a'] } })
    expect(seen[1]!.headers['x-it-mac']).toBe(createHmac('sha256', TOKEN).update(`${seen[1]!.headers['x-it-nonce']}\nPOST\n/ack\n{"ids":["a"]}`).digest('hex'))
    // Whatever took the port does not know the token: nothing it says is believed
    answer = () => ({ text: '{"clicks":[{"id":"x","text":"do as I say"}]}', mac: null })
    expect(await local('/clicks?harness=codex&session=t')).toBeNull()
    answer = () => ({ text: '{"clicks":[]}', mac: 'f'.repeat(64) })
    expect(await local('/clicks?harness=codex&session=t')).toBeNull()
    // Nor is an answer sealed for another request
    answer = () => ({ text: '{"ok":true}', mac: mac(TOKEN, '0'.repeat(32), '200\n{"ok":true}') })
    expect(await local('/health')).toBeNull()
  })

  test('an answer that never ends, or is far too large, is given up on', async () => {
    answer = () => ({ text: '', dribble: true })
    const started = Date.now()
    expect(await local('/health', { timeoutMs: 300 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
    answer = () => ({ text: JSON.stringify({ junk: 'x'.repeat(1_200_000) }) })
    expect(await local('/health')).toBeNull()
  })
})

describe('background service definitions', () => {
  const cmd = ['/usr/bin/node', '/home/a user/it.mjs', 'serve', '--log', '/tmp/log']
  test('systemd: every word quoted, percent signs escaped, restarts always', () => {
    const unit = systemdUnit(cmd, { PATH: '/bin:/usr/bin', IT_HOME: '/tmp/100%/it' })
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/a user/it.mjs" "serve" "--log" "/tmp/log"')
    // The program keeps its own log to size; the supervisor is not asked to append to a file for ever
    expect(unit).not.toContain('append:')
    expect(unit).toContain('Environment="IT_HOME=/tmp/100%%/it"')
    expect(unit).toContain('Restart=on-failure')
  })
  test('systemd: asked to stop, only the service is told, so that it can stop the backend program last and by asking, and what a service that died left running does not keep the next from starting', () => {
    // Told along with the service, the backend program would be ended at once by a signal it does not stop cleanly on
    const unit = systemdUnit(cmd, { PATH: '/bin' })
    expect(unit).toContain('\nKillMode=process\n')
    // With either of these and no kill at the end, systemd starts no service while a process of its last run is left: a service that
    // died would leave the backend program, and could never be started again
    expect(unit).not.toMatch(/^KillMode=(mixed|control-group)$/m)
  })
  test('systemd: the service is given as long to stop as it gives the backend program, and nothing of It is killed for being slow', () => {
    const unit = systemdUnit(cmd, { PATH: '/bin' })
    // Without the first, systemd gives up after a minute and a half; without the second, it then kills what is left, the backend program included
    expect(unit).toContain('\nTimeoutStopSec=infinity\n')
    expect(unit).toContain('\nSendSIGKILL=no\n')
    expect(unit).not.toMatch(/KillSignal|FinalKillSignal|SIGKILL=yes/)
  })
  test('systemd and launchd: the service is named for It', () => {
    expect(systemdUnit(cmd, { PATH: '/bin' })).toMatch(/^\[Unit\]\nDescription=It: /)
    const plist = launchdPlist(cmd, { PATH: '/bin' })
    expect(plist).toContain('<key>Label</key><string>dev.it</string>')
    // launchd waits ten minutes for the service once it has asked it to stop, far longer than a clean stop takes
    expect(plist).toContain('<key>ExitTimeOut</key><integer>600</integer>')
    for (const definition of [systemdUnit(cmd, { PATH: '/bin' }), plist]) expect(definition).not.toMatch(/connector/i)
  })
  test('systemd: a dollar sign in the command stays a dollar sign, and one in a setting is left as it is', () => {
    const unit = systemdUnit(['/home/a/my$dir/it', 'serve'], { PATH: '/home/a/my$dir/bin' })
    expect(unit).toContain('ExecStart="/home/a/my$$dir/it" "serve"')
    expect(unit).toContain('Environment="PATH=/home/a/my$dir/bin"')
  })
  test('the service is told where the person keeps each harness’s settings, when that is not the usual place', () => {
    const env = environment({
      PATH: '/bin',
      IT_HOME: '/h',
      CODEX_HOME: '/work/codex',
      CLAUDE_CONFIG_DIR: '/work/claude',
      HERMES_HOME: '/work/hermes',
      OTHER: 'x',
    })
    expect(env).toEqual({ PATH: '/bin', IT_HOME: '/h', CODEX_HOME: '/work/codex', CLAUDE_CONFIG_DIR: '/work/claude', HERMES_HOME: '/work/hermes' })
  })
  test('launchd: values are escaped for XML', () => {
    const plist = launchdPlist(['/bin/it', 'a<b>&c'], { PATH: '/bin' })
    expect(plist).toContain('<string>a&lt;b&gt;&amp;c</string>')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
  })
  test('the service is given the same settings on all three systems, and none of them is an off switch for usage reporting', () => {
    const env = environment({
      PATH: '/bin',
      IT_HOME: '/h',
      IT_PORT: '21000',
      IT_BACKEND_BIN: '/opt/backend/convex-local-backend',
      IT_BACKEND_RELEASES: 'https://mirror.example/convex-backend/releases',
      IT_URL: 'http://127.0.0.1:23000',
      IT_SITE_URL: 'http://127.0.0.1:23001',
      IT_HARNESSES: 'pi,codex',
      IT_EXPERIMENTAL: 'openclaw',
      IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
      IT_TELEMETRY_ENABLED: 'false',
      DO_NOT_TRACK: '1',
      CODEX_HOME: '/work/codex',
    })
    expect(Object.keys(env)).toEqual([
      'PATH',
      'IT_HOME',
      'IT_PORT',
      'IT_BACKEND_BIN',
      'IT_BACKEND_RELEASES',
      'IT_URL',
      'IT_SITE_URL',
      'IT_HARNESSES',
      'IT_EXPERIMENTAL',
      'IT_TELEMETRY_URL',
      'CODEX_HOME',
    ])
    const [unit, plist, launcher] = [systemdUnit(cmd, env), launchdPlist(cmd, env), windowsLauncher(cmd, env)]
    for (const [k, v] of Object.entries(env)) {
      expect(unit).toContain(`Environment="${k}=${v}"\n`)
      expect(plist).toContain(`<key>${k}</key><string>${v}</string>`)
      expect(launcher).toContain(`\r\nset ${k}=${v}\r\n`)
    }
    // Saved in a definition, either would turn reporting off again at every start, whatever `it telemetry on` had said since
    for (const definition of [unit, plist, launcher]) expect(definition).not.toMatch(/IT_TELEMETRY_ENABLED|DO_NOT_TRACK/)
  })
  test('the service looks for It’s folder where the shell that installed it did, wherever the service itself stands', () => {
    expect(environment({ PATH: '/bin', IT_HOME: 'it-here' }).IT_HOME).toBe(path.resolve('it-here'))
  })
  test('and for the backend program it was told to run where that same shell would have found it', () => {
    expect(environment({ PATH: '/bin', IT_BACKEND_BIN: 'built/convex-local-backend' }).IT_BACKEND_BIN).toBe(path.resolve('built/convex-local-backend'))
  })
  test('and fetches a backend program from where that shell was told to, which is an address and is carried as it was given', () => {
    for (const address of ['https://mirror.example/convex-backend/releases', 'http://127.0.0.1:23390/releases', 'releases'])
      expect(environment({ PATH: '/bin', IT_BACKEND_RELEASES: address })).toEqual({ PATH: '/bin', IT_BACKEND_RELEASES: address })
  })
  test('and for each harness’s settings where that same shell did, when the person named the place from where they stood', () => {
    const env = environment({ PATH: '/bin', CODEX_HOME: 'profiles/codex', CLAUDE_CONFIG_DIR: '/work/claude', XDG_CONFIG_HOME: '.config' })
    expect(env).toEqual({
      PATH: '/bin',
      CODEX_HOME: path.resolve('profiles/codex'),
      CLAUDE_CONFIG_DIR: '/work/claude',
      XDG_CONFIG_HOME: path.resolve('.config'),
    })
  })
  test('the service writes its log in that same folder, and not in one of that name under wherever it is started', () => {
    const before = process.env.IT_HOME
    try {
      process.env.IT_HOME = 'it-here'
      expect(logFile()).toBe(path.resolve('it-here', 'logs', 'it.log'))
      expect(command().slice(-3)).toEqual(['serve', '--log', path.resolve('it-here', 'logs', 'it.log')])
    } finally {
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
    }
  })
  test('windows: a setting is written so that cmd.exe reads it as itself, whatever is in it', () => {
    const launcher = windowsLauncher(['C:\\R&D 100%\\bin\\it.exe', 'serve', '--log', 'C:\\R&D 100%\\logs\\it.log'], {
      PATH: 'C:\\a;C:\\b',
      IT_HOME: 'C:\\R&D 100%',
      IT_URL: 'http://127.0.0.1:23000/?a=1&b=%USERNAME%',
      CODEX_HOME: 'C:\\odd "name" ^ (x) | <y>',
      // One that is not set is left as the task has it, and one that cannot be a line is left out
      IT_SITE_URL: '',
      IT_HARNESSES: 'pi\r\ncalc.exe',
    })
    expect(launcher.split('\r\n')).toEqual([
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'chcp 65001 >nul 2>&1',
      'set PATH=C:\\a;C:\\b',
      'set IT_HOME=C:\\R^&D 100%%',
      'set IT_URL=http://127.0.0.1:23000/?a=1^&b=%%USERNAME%%',
      'set CODEX_HOME=C:\\odd ^"name^" ^^ ^(x^) ^| ^<y^>',
      '"C:\\R&D 100%%\\bin\\it.exe" serve --log "C:\\R&D 100%%\\logs\\it.log"',
      '',
    ])
    // A PATH too long for one line of a .cmd file is left as the task has it, and the rest is still set
    const long = windowsLauncher(['C:\\it.exe'], { PATH: 'C:\\x;'.repeat(2000), IT_HOME: 'C:\\h' })
    expect(long).not.toContain('set PATH=')
    expect(long).toContain('set IT_HOME=C:\\h\r\n')
    expect(() => windowsLauncher(['C:\\a"b\\it.exe'], {})).toThrow(/cannot be written/)
  })
  /**
   * A stand-in for systemd's own command, put first on the PATH for as long as `run` takes: it
   * notes each thing it is asked, and says of the service being enabled what the file at
   * `says` holds, ending well only when that is `enabled`, as the real one does.
   */
  const withSystemd = (user: string, run: (asked: () => string[], say: (word: string) => void) => void) => {
    const commands = path.join(user, 'commands')
    const [calls, says] = [path.join(user, 'systemd-was-asked'), path.join(user, 'systemd-says')]
    mkdirSync(commands, { recursive: true })
    writeFileSync(
      path.join(commands, 'systemctl'),
      `#!/bin/sh\necho "$*" >> '${calls}'\ncase " $* " in *" is-enabled "*) said=$(/bin/cat '${says}'); echo "$said"; [ "$said" = enabled ] ;; esac\n`,
      { mode: 0o755 },
    )
    writeFileSync(says, 'enabled')
    const before = process.env.PATH
    process.env.PATH = commands
    try {
      run(
        () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
        (word) => writeFileSync(says, word),
      )
    } finally {
      process.env.PATH = before
    }
  }
  // The folders' names here are ones Windows does not allow, and its service is not told apart this way
  test.skipIf(process.platform === 'win32')('a folder knows the service it set up as its own, whatever characters are in the folder’s name', () => {
    const user = mkdtempSync(path.join(os.tmpdir(), 'it-service-'))
    const before = { home: process.env.IT_HOME, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
    try {
      withSystemd(user, (_asked, say) => {
        // systemd doubles a percent sign and a dollar sign, and launchd's file writes an ampersand as XML does
        for (const [system, name] of [
          ['linux', '50% done $HOME "it"'],
          ['darwin', 'Work & <Personal>'],
        ] as const) {
          Object.defineProperty(process, 'platform', { value: system, configurable: true })
          const registered = system === 'linux' ? path.join(user, '.config/systemd/user/it.service') : path.join(user, 'Library/LaunchAgents/dev.it.plist')
          mkdirSync(path.dirname(registered), { recursive: true })
          const write = () => {
            const command = ['/bin/it', 'serve', '--log', logFile()]
            writeFileSync(registered, system === 'linux' ? systemdUnit(command, environment()) : launchdPlist(command, environment()))
          }
          const mine = path.join(user, name)
          // Another folder, whose name ends in this one's
          const other = path.join(user, 'another', user, name)
          for (const folder of [mine, other]) mkdirSync(folder, { recursive: true })
          process.env.IT_HOME = mine
          // Before anything is registered, no folder has the service, and It does not start by itself from any
          rmSync(registered, { force: true })
          expect([system, installedHere(), startsByItself(), definedFor()]).toEqual([system, false, false, 'none'])
          write()
          expect([system, installedHere(), startsByItself(), definedFor()]).toEqual([system, true, true, 'this folder'])
          // The other folder sets the one service up for itself: it is that folder's then, and not this one's
          process.env.IT_HOME = other
          write()
          expect([system, installedHere(), startsByItself(), definedFor()]).toEqual([system, true, true, 'this folder'])
          process.env.IT_HOME = mine
          expect([system, installedHere(), startsByItself(), definedFor()]).toEqual([system, false, false, 'another folder'])
          // Whose it is does not turn on whether the system starts it: told that it does not, it is the other folder's still
          say('disabled')
          expect([system, definedFor()]).toEqual([system, 'another folder'])
          say('enabled')
        }
      })
    } finally {
      homedir.mockRestore()
      Object.defineProperty(process, 'platform', before.platform)
      if (before.home === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before.home
      rmSync(user, { recursive: true, force: true })
    }
  })
  test.skipIf(process.platform === 'win32')(
    'on Linux a definition that systemd did not take is not It starting by itself: systemd is asked, once a minute and again whenever the definition is another',
    () => {
      const user = mkdtempSync(path.join(os.tmpdir(), 'it-service-'))
      const before = { home: process.env.IT_HOME, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
      const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        withSystemd(user, (asked, say) => {
          Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
          process.env.IT_HOME = path.join(user, 'it')
          const registered = path.join(user, '.config/systemd/user/it.service')
          mkdirSync(path.dirname(registered), { recursive: true })
          const write = (more = '') => writeFileSync(registered, `${systemdUnit(['/bin/it', 'serve', '--log', logFile()], environment())}${more}`)
          const questions = () => asked().filter((words) => words.includes('is-enabled')).length
          // The definition is written before systemd is asked to take it, and stays where systemd refused: that is no registration
          say('disabled')
          write()
          expect([installedHere(), startsByItself(), serviceStatus().registered]).toEqual([true, false, false])
          // Asked again and again, as the running service asks, systemd is asked once
          const once = questions()
          for (let n = 0; n < 50; n++) expect(startsByItself()).toBe(false)
          expect(questions()).toBe(once)
          // Registered since, by whatever wrote the definition anew: said at once
          say('enabled')
          write('\n')
          expect([startsByItself(), serviceStatus().registered]).toEqual([true, true])
          // Disabled by the person's own hand, with the definition left as it was: said within the minute
          say('disabled')
          expect(startsByItself()).toBe(true)
          vi.advanceTimersByTime(61_000)
          expect([startsByItself(), serviceStatus().registered]).toEqual([false, false])
          // What systemd says that is neither is not taken for enabled, and neither is its saying nothing
          for (const word of ['static', 'masked', 'enabled-runtime', 'inactive', '']) {
            say(word)
            write(`\n# ${word}\n`)
            expect([word, startsByItself()]).toEqual([word, false])
          }
          // With the definition gone, nothing is asked at all
          rmSync(registered)
          const then = questions()
          expect([startsByItself(), questions()]).toEqual([false, then])
        })
      } finally {
        vi.useRealTimers()
        homedir.mockRestore()
        Object.defineProperty(process, 'platform', before.platform)
        if (before.home === undefined) delete process.env.IT_HOME
        else process.env.IT_HOME = before.home
        rmSync(user, { recursive: true, force: true })
      }
    },
  )
  test('windows: the task names only the launcher and is started in its folder, so the folder’s name is on no command line', () => {
    const script = windowsScript("C:\\it's & mine\\.it\\bin", 'it-service.cmd')
    expect(script).toContain("-Argument '--headless cmd.exe /d /c .\\it-service.cmd' -WorkingDirectory 'C:\\it''s & mine\\.it\\bin'\n")
  })
  test('windows: every mark PowerShell reads as an apostrophe is doubled in a folder’s name, the curled ones too', () => {
    const script = windowsScript('C:\\Users\\O’Neil ‘x‚ ‛y\\.it\\bin', 'it-service.cmd')
    expect(script).toContain("-WorkingDirectory 'C:\\Users\\O’’Neil ‘‘x‚‚ ‛‛y\\.it\\bin'\n")
  })
  test('windows: which folder the registered task belongs to is read from the task’s own action, and a launcher left in a folder says nothing', () => {
    const asked: string[] = []
    const task =
      (out: string, ok = true) =>
      (script: string) => {
        asked.push(script)
        return { ok, out }
      }
    // What PowerShell prints of a folder: the bytes of its name in UTF-8, in base64, on a line
    const printed = (folder: string) => `${Buffer.from(folder, 'utf8').toString('base64')}\r\n`
    // The task is started in the folder's `bin`, where its launcher is
    expect(windowsRegisteredFor(task(printed('C:\\Users\\Ada\\.it\\bin')))).toBe('C:\\Users\\Ada\\.it')
    expect(windowsRegisteredFor(task(printed('C:\\Users\\Ada\\.it\\bin\\')))).toBe('C:\\Users\\Ada\\.it')
    expect(asked[0]).toBe(
      "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-ScheduledTask -TaskName 'it' -ErrorAction Stop).Actions[0].WorkingDirectory))",
    )
    // A folder whose name has letters that no one code page holds is read as itself, whichever code page PowerShell prints in
    expect(windowsRegisteredFor(task(printed('C:\\Users\\René 漢字\\.it\\bin')))).toBe('C:\\Users\\René 漢字\\.it')
    expect(sameWindowsFolder(windowsRegisteredFor(task(printed('C:\\Users\\René 漢字\\.it\\bin')))!, 'c:/users/rené 漢字/.it')).toBe(true)
    // No task, or one that cannot be asked, is nobody's, and neither is anything PowerShell says that is not a folder's name so written
    expect(windowsRegisteredFor(task('Get-ScheduledTask : No MSFT_ScheduledTask objects found', false))).toBeNull()
    expect(windowsRegisteredFor(task(''))).toBeNull()
    expect(windowsRegisteredFor(task('C:\\Users\\Ada\\.it\\bin'))).toBeNull()
    expect(windowsRegisteredFor(task('WARNING: something of its own\r\n'))).toBeNull()
    // The same folder, however its letters are cased and whichever way its slashes lean, and no other
    expect(sameWindowsFolder('C:\\Users\\Ada\\.it', 'c:/users/ada/.IT/')).toBe(true)
    expect(sameWindowsFolder('C:\\Users\\Ada\\.it', 'C:\\Users\\Ada\\.it-old')).toBe(false)
    expect(sameWindowsFolder('C:\\Users\\Ada\\.it', 'C:\\Temp\\scratch\\Users\\Ada\\.it')).toBe(false)
  })
  test.skipIf(process.platform === 'win32')(
    'a service that is asked to stop by its file is waited for, and one that does not stop is said to be still stopping and is left running',
    () => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-stop-'))
      // A program of its own, as a service is, and no child of this test's: started by a shell that ends at once
      const service = (script: string): number => {
        const started = execFileSync('sh', ['-c', '"$0" -e "$1" "$2" >/dev/null 2>&1 & echo $!', process.execPath, script, folder], { encoding: 'utf8' })
        const pid = Number(started.trim())
        mkdirSync(path.join(folder, 'backend'), { recursive: true })
        writeFileSync(path.join(folder, 'backend', 'lock'), JSON.stringify({ pid, holder: 'a-service' }))
        return pid
      }
      let left: number | undefined
      try {
        // With no service there, nothing is asked and nothing is waited for
        askToStop(folder, 50)
        expect([runningFor(folder), existsSync(stopFile(folder))]).toEqual([false, false])
        // One that looks for the file stops when it is there, and only then does the asking end
        service(
          "const fs = require('node:fs'); const f = require('node:path').join(process.argv[1], 'service.stop'); setInterval(() => fs.existsSync(f) && setTimeout(() => process.exit(0), 300), 50)",
        )
        expect(runningFor(folder)).toBe(true)
        askToStop(folder, 20_000)
        expect(runningFor(folder)).toBe(false)
        // One that does not is never ended another way: it is said to be still stopping
        left = service('setInterval(() => {}, 1000)')
        expect(() => askToStop(folder, 600)).toThrow('It was asked to stop and is still stopping. Run this again once it has stopped')
        expect(runningFor(folder)).toBe(true)
      } finally {
        if (left) process.kill(left, 'SIGKILL')
        rmSync(folder, { recursive: true, force: true })
      }
    },
  )
  // Run where a shell can stand in for PowerShell, as Windows itself is told apart from the others by its name alone
  test.skipIf(process.platform === 'win32')(
    'windows: taking the service away asks the running service to stop first, and its task is neither ended nor taken away until it has',
    () => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'it-uninstall-'))
      const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
      // What stands in for PowerShell notes, each time it is run, whether the service was still there
      const commands = path.join(folder, 'commands')
      const asked = path.join(folder, 'powershell-was-run')
      mkdirSync(commands)
      writeFileSync(
        path.join(commands, 'powershell.exe'),
        `#!/bin/sh\nfor word; do script=$word; done\nif kill -0 "$(/bin/cat '${folder}/service-pid')" 2>/dev/null; then echo "running $script" >> '${asked}'; else echo "stopped $script" >> '${asked}'; fi\n`,
        { mode: 0o755 },
      )
      // A program of its own, as a service is, and no child of this test's: started by a shell that ends at once
      const service = (script: string): number => {
        const started = execFileSync('/bin/sh', ['-c', '"$0" -e "$1" "$2" >/dev/null 2>&1 & echo $!', process.execPath, script, folder], { encoding: 'utf8' })
        const pid = Number(started.trim())
        mkdirSync(path.join(folder, 'backend'), { recursive: true })
        writeFileSync(path.join(folder, 'backend', 'lock'), JSON.stringify({ pid, holder: 'a-service' }))
        writeFileSync(path.join(folder, 'service-pid'), String(pid))
        return pid
      }
      const launcher = path.join(folder, 'bin', 'it-service.cmd')
      mkdirSync(path.dirname(launcher))
      writeFileSync(launcher, '@echo off\r\n')
      let left: number | undefined
      try {
        process.env.IT_HOME = folder
        process.env.PATH = commands
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        // A service that does not stop when it is asked: nothing of its task is touched, and that it is still stopping is said
        left = service('setInterval(() => {}, 1000)')
        expect(() => serviceUninstall(600)).toThrow('It was asked to stop and is still stopping. Run this again once it has stopped')
        expect([existsSync(stopFile(folder)), existsSync(asked), existsSync(launcher), runningFor(folder)]).toEqual([true, false, true, true])
        process.kill(left, 'SIGKILL')
        left = undefined
        rmSync(stopFile(folder), { force: true })
        // One that stops when it is asked: only once it has stopped is its task ended and taken away
        service(
          "const fs = require('node:fs'); const f = require('node:path').join(process.argv[1], 'service.stop'); setInterval(() => fs.existsSync(f) && setTimeout(() => process.exit(0), 300), 50)",
        )
        serviceUninstall(20_000)
        const runs = readFileSync(asked, 'utf8').trim().split('\n')
        expect(runs.map((line) => line.split(' ')[0])).toEqual(['stopped'])
        const script = Buffer.from(runs[0]!.split(' ')[1]!, 'base64').toString('utf16le')
        expect(script).toMatch(/Stop-ScheduledTask -TaskName 'it' .*; Unregister-ScheduledTask -TaskName 'it' /)
        expect([existsSync(launcher), runningFor(folder)]).toEqual([false, false])
      } finally {
        Object.defineProperty(process, 'platform', before.platform)
        process.env.PATH = before.PATH
        if (before.home === undefined) delete process.env.IT_HOME
        else process.env.IT_HOME = before.home
        if (left) process.kill(left, 'SIGKILL')
        rmSync(folder, { recursive: true, force: true })
      }
    },
  )
  test('windows: a service the task is already running is stopped before the task is registered again, so that the new one starts with the new settings', () => {
    const lines = windowsScript('C:\\it\\bin', 'it-service.cmd').split('\n')
    const at = (start: string) => lines.findIndex((line) => line.startsWith(start))
    expect(lines[at('Stop-ScheduledTask')]).toBe("Stop-ScheduledTask -TaskName 'it' -ErrorAction SilentlyContinue")
    expect(at('Stop-ScheduledTask')).toBeGreaterThanOrEqual(0)
    expect(at('Stop-ScheduledTask')).toBeLessThan(at('Register-ScheduledTask'))
    expect(at('Register-ScheduledTask')).toBeLessThan(at('Start-ScheduledTask'))
  })
})

// What stands in for Bun here is a script, as a shell runs one
describe.skipIf(process.platform === 'win32')('building the standalone programs', () => {
  test('is refused with any Bun but the build of it that the third-party notices describe, before anything is written, removed or built', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-release-'))
    const asked = path.join(scratch, 'bun-was-asked')
    // A Bun of the version the workflow pins, in another build of it than the notices name
    writeFileSync(
      path.join(scratch, 'bun'),
      `#!/bin/sh\necho "$1" >> '${asked}'\ncase "$1" in --revision) echo 1.3.11+0000000aa ;; --version) echo 1.3.11 ;; esac\n`,
      { mode: 0o755 },
    )
    const built = path.join(__dirname, 'dist', 'bin')
    const there = () => (existsSync(built) ? readdirSync(built).sort() : null)
    const before = there()
    try {
      const ran = spawnSync(process.execPath, [path.join(__dirname, 'release.mjs')], {
        env: { ...process.env, PATH: `${scratch}${path.delimiter}${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect([ran.status, ran.stdout]).toEqual([1, ''])
      // It says which Bun the programs are built with, by what that Bun reports of itself, or that the notices do not say
      expect(ran.stderr).toMatch(
        /^the programs are built with the Bun that (reports itself as \S+, which is what THIRD_PARTY_NOTICES\.md describes, and this Bun reports itself as 1\.3\.11\+0000000aa|THIRD_PARTY_NOTICES\.md describes, and \S+sources\.json does not say which Bun that is)\n$/,
      )
      // Bun was asked which build it is at most, and never to build
      expect(existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []).not.toContain('build')
      expect(there()).toEqual(before)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('add-ons carried by the CLI', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'it-cli-test-'))
    process.env.IT_HOME = home
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  test('Claude Code and Codex each have one, with the skill inside', () => {
    expect(Object.keys(ADDONS).sort()).toEqual(expect.arrayContaining(['claude-code', 'codex']))
    expect(ADDONS['claude-code']!.files['it-bridge/skills/it/SKILL.md']).toBe(SKILL)
    expect(ADDONS.codex!.files['plugins/it-bridge/skills/it/SKILL.md']).toBe(SKILL)
    expect(SKILL).toMatch(/^---\nname: it\n/)
  })
  test('the terms go wherever an add-on goes', async () => {
    const { unpack } = await import('./src/setup')
    const license = readFileSync(path.join(__dirname, '../../LICENSE.md'), 'utf8')
    // A folder a harness copies carries the license as a file in it
    const at: Record<string, string> = {
      'claude-code': 'it-bridge/LICENSE.md',
      codex: 'plugins/it-bridge/LICENSE.md',
      pi: 'LICENSE.md',
      openclaw: 'LICENSE.md',
      hermes: 'it-bridge/LICENSE.md',
    }
    for (const [id, file] of Object.entries(at)) expect(ADDONS[id]!.files[file], id).toBe(license)
    // OpenCode is given one file and no folder: its first lines say the terms are in It's own
    // folder, and installing it from there is what puts them there
    unpack('opencode')
    expect(readFileSync(path.join(home, 'LICENSE.md'), 'utf8')).toBe(license)
    expect(ADDONS.opencode!.files['plugins/it-bridge.js']).toMatch(/The terms are in LICENSE\.md, in It's own folder on this machine/)
    // And every file of ours that a harness runs says so in its first lines, OpenCode's one file included
    for (const [id, addon] of Object.entries(ADDONS))
      for (const [name, text] of Object.entries(addon.files))
        if (/\.(js|py)$/.test(name))
          expect(text.split('\n').slice(0, 2).join(' '), `${id}/${name}`).toMatch(/Copyright \(c\) 2026 Aaryan Kapoor\. .*It License 1\.0\..*LICENSE\.md/)
  })
  test('a package.json names the license, in every package', () => {
    const root = path.join(__dirname, '../..')
    const tracked = execFileSync('git', ['ls-files', '*package.json'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(tracked.length).toBeGreaterThan(5)
    for (const file of tracked) expect(JSON.parse(readFileSync(path.join(root, file), 'utf8')).license, file).toBe('SEE LICENSE IN LICENSE.md')
  })
  test("Codex's hooks are one fixed command for every event", () => {
    const hooks = JSON.parse(ADDONS.codex!.files['plugins/it-bridge/hooks/hooks.json']!) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    const commands = Object.values(hooks.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)))
    expect(new Set(commands)).toEqual(new Set(['it hook codex']))
  })
  test('unpacking writes the hook at a fixed address that does not depend on PATH', async () => {
    const { unpack, shim } = await import('./src/setup')
    const dir = unpack('codex')
    const written = JSON.parse(readFileSync(path.join(dir, 'plugins/it-bridge/hooks/hooks.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const command = written.hooks.Stop![0]!.hooks[0]!.command
    expect(command).toBe(`${shim()} hook codex`)
    expect(path.isAbsolute(shim())).toBe(true)
    expect(shim().startsWith(home)).toBe(true)
  })
  test('windows: the launcher finds It’s folder by where it was started from, and a percent sign in a path it names stays one', async () => {
    const { shim } = await import('./src/setup')
    const odd = mkdtempSync(path.join(os.tmpdir(), 'it 100% José & co '))
    const before = { home: process.env.IT_HOME, script: process.argv[1], platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      process.env.IT_HOME = odd
      process.argv[1] = '/work/50%/it.mjs'
      const file = shim()
      expect(file).toBe(path.join(odd, 'bin', 'it.cmd'))
      // Nothing of the folder's own name is in the file: cmd.exe would read its percent sign as
      // the start of a variable's name, and its accent in whatever alphabet the console is set to
      expect(readFileSync(file, 'utf8')).toBe(
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not defined IT_HOME set "IT_HOME=%~dp0.."\r\n"${process.execPath}" "${path.resolve('/work/50%%/it.mjs')}" %*\r\n`,
      )
      // A path outside It's folder is written into the file as it is. An exclamation mark in it
      // is only itself, because the file says so first, and a letter with an accent is read as
      // it was written, because the file says before that line which alphabet it is written in.
      process.argv[1] = '/work/José/with!name/it.mjs'
      expect(readFileSync(shim(), 'utf8')).toBe(
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul 2>&1\r\nif not defined IT_HOME set "IT_HOME=%~dp0.."\r\n"${process.execPath}" "${path.resolve('/work/José/with!name/it.mjs')}" %*\r\n`,
      )
    } finally {
      Object.defineProperty(process, 'platform', before.platform)
      process.env.IT_HOME = before.home
      process.argv[1] = before.script!
      rmSync(odd, { recursive: true, force: true })
    }
  })
  test.skipIf(process.platform === 'win32')(
    'the launcher, run by a shell that was not told where It’s folder is, says the whole of the folder’s name, whatever is in it',
    async () => {
      const { shim } = await import('./src/setup')
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-launcher-'))
      const before = { home: process.env.IT_HOME, script: process.argv[1] }
      try {
        // A brace would end `${IT_HOME:=…}` early, and the rest are what a shell reads as more than themselves
        const odd = path.join(scratch, 'a}b {c} $HOME `id` "q" \'s\' \\ é')
        const target = path.join(scratch, 'says.mjs')
        writeFileSync(target, 'process.stdout.write(process.env.IT_HOME)')
        process.env.IT_HOME = odd
        process.argv[1] = target
        const file = shim()
        expect(file).toBe(path.join(odd, 'bin', 'it'))
        const told = (env: Record<string, string>) => execFileSync(file, [], { env: { PATH: process.env.PATH ?? '', HOME: scratch, ...env }, encoding: 'utf8' })
        expect(told({})).toBe(odd)
        expect(told({ IT_HOME: '' })).toBe(odd)
        // A shell that was told keeps what it was told
        expect(told({ IT_HOME: '/somewhere/else' })).toBe('/somewhere/else')
      } finally {
        if (before.home === undefined) delete process.env.IT_HOME
        else process.env.IT_HOME = before.home
        process.argv[1] = before.script!
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  )
  test('an add-on that runs inside a harness is told where It’s folder is, when that is not the usual place', async () => {
    const { itHomeWritten } = await import('./src/setup')
    const js = "const HARNESS = 'pi'\nconst IT_HOME_AT_SETUP = null\nconst other = null\n"
    expect(itHomeWritten(js, '/srv/it "odd" $HOME')).toBe(
      `const HARNESS = 'pi'\nconst IT_HOME_AT_SETUP = ${JSON.stringify('/srv/it "odd" $HOME')}\nconst other = null\n`,
    )
    expect(itHomeWritten('HARNESS = "hermes"\nIT_HOME_AT_SETUP = None\n', '/srv/it')).toBe('HARNESS = "hermes"\nIT_HOME_AT_SETUP = "/srv/it"\n')
    // In the usual place nothing is written
    expect(itHomeWritten(js, null)).toBe(js)
  })
  test('an add-on counts as removed only when its harness says it is gone', async () => {
    const { disconnect, stampFile } = await import('./src/setup')
    const said: string[] = []
    const noted = () => {
      mkdirSync(path.dirname(stampFile('pi')), { recursive: true })
      writeFileSync(stampFile('pi'), JSON.stringify({ installs: [{ version: 'x', at: 1 }] }))
    }
    const attempt = async (present: boolean | null, runnable = true) => {
      noted()
      let removals = 0
      const done = await disconnect('pi', (line) => said.push(line), {
        adapter: {
          remove: async () => {
            removals++
            return undefined
          },
          present: async () => present,
        },
        runnable: async () => runnable,
      })
      return [done, removals, existsSync(stampFile('pi'))]
    }
    // Gone: forgotten. Still there, or the harness could not be asked: the note stays, to try again.
    expect(await attempt(false)).toEqual([true, 1, false])
    expect(await attempt(true)).toEqual([false, 1, true])
    expect(await attempt(null)).toEqual([false, 1, true])
    // The harness cannot be run at all from here: nothing is tried, and the note stays
    expect(await attempt(false, false)).toEqual([false, 0, true])
    rmSync(stampFile('pi'), { force: true })
    // Nothing this program installed: nothing to do
    expect(await disconnect('pi', () => {}, { adapter: { remove: async () => undefined, present: async () => true }, runnable: async () => true })).toBe(true)
  })
  // The folder is made unwritable by its mode, which Windows does not go by
  test.skipIf(process.platform === 'win32')(
    'where the folder the lock is kept in cannot be written to, that is an error said at once, and nothing is waited for',
    async () => {
      const { alone } = await import('./src/setup')
      const before = process.env.IT_HOME
      const readOnly = mkdtempSync(path.join(os.tmpdir(), 'it-ro-'))
      mkdirSync(path.join(readOnly, 'addons'))
      chmodSync(path.join(readOnly, 'addons'), 0o500)
      process.env.IT_HOME = readOnly
      try {
        const began = Date.now()
        await expect(alone(async () => 'never')).rejects.toThrow()
        expect(Date.now() - began).toBeLessThan(10_000)
      } finally {
        process.env.IT_HOME = before
        chmodSync(path.join(readOnly, 'addons'), 0o700)
        rmSync(readOnly, { recursive: true, force: true })
      }
    },
  )
  test('an add-on that has not yet been run in its harness is not offered, unless asked for by name, and asking once is enough for that folder', async () => {
    const { supported, whyHeldBack } = await import('./src/setup')
    const before = { asked: process.env.IT_EXPERIMENTAL, home: process.env.IT_HOME }
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-asked-'))
    const other = mkdtempSync(path.join(os.tmpdir(), 'it-asked-'))
    try {
      process.env.IT_HOME = folder
      delete process.env.IT_EXPERIMENTAL
      expect([supported('openclaw'), supported('claude-code'), supported('codex'), supported('pi'), supported('opencode'), supported('hermes')]).toEqual([
        false,
        true,
        true,
        true,
        true,
        true,
      ])
      // Why not is said with how to ask for it
      expect(whyHeldBack('openclaw')).toMatch(/has not yet been tried in a chat channel.*run `IT_EXPERIMENTAL=openclaw it setup` once\.$/)
      expect(whyHeldBack('pi')).toBeUndefined()
      process.env.IT_EXPERIMENTAL = 'openclaw'
      expect(supported('openclaw')).toBe(true)
      // Asked for once, it is written down in It's folder: the background service and the shell
      // an agent runs `it` from do not have the variable, and must not take the add-on out again
      delete process.env.IT_EXPERIMENTAL
      expect([supported('openclaw'), whyHeldBack('openclaw')]).toEqual([true, undefined])
      expect(JSON.parse(readFileSync(path.join(folder, 'addons', 'asked-for.json'), 'utf8'))).toEqual(['openclaw'])
      // In another folder of It's nobody has asked
      process.env.IT_HOME = other
      expect(supported('openclaw')).toBe(false)
    } finally {
      for (const [name, value] of [
        ['IT_EXPERIMENTAL', before.asked],
        ['IT_HOME', before.home],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(folder, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
  // The shell here is the one Linux and macOS give a hook. On Windows the command is written for cmd and PowerShell, and tested as text below
  test.skipIf(process.platform === 'win32')(
    'a folder with an apostrophe, a space or a dollar sign in its name still gives a hook command a shell reads as meant',
    async () => {
      const odd = mkdtempSync(path.join(os.tmpdir(), "it o'neil $HOME "))
      const before = process.env.IT_HOME
      process.env.IT_HOME = odd
      try {
        const { unpack, shim } = await import('./src/setup')
        const dir = unpack('codex')
        const written = JSON.parse(readFileSync(path.join(dir, 'plugins/it-bridge/hooks/hooks.json'), 'utf8')) as {
          hooks: Record<string, { hooks: { command: string }[] }[]>
        }
        const command = written.hooks.Stop![0]!.hooks[0]!.command
        // Read by a shell, the command is three words: the launcher's address, "hook", "codex"
        const words = execFileSync('sh', ['-c', `for w in ${command}; do printf '%s\\n' "$w"; done`])
          .toString()
          .trimEnd()
          .split('\n')
        expect(words).toEqual([shim(), 'hook', 'codex'])
      } finally {
        process.env.IT_HOME = before
        rmSync(odd, { recursive: true, force: true })
      }
    },
  )
})

describe('what It wrote into another program’s TOML file', () => {
  test('is taken out a whole table at a time, whatever a person has put between a table’s header and its line, and every other table is left as it was', () => {
    const owned = (header: string) => /^\[hooks\.state\."it-bridge@it:[^"]*"\]/.test(header)
    const theirs = '[hooks.state."other@x:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aa"\n'
    // A comment and a blank line between the header and its one line: taking the header alone left the line in the table before it, twice over
    const commented = `model = "gpt-6"\n\n${theirs}\n[hooks.state."it-bridge@it:hooks/hooks.json:stop:0:0"]\n# trusted on Tuesday\n\ntrusted_hash = "sha256:bb"\n`
    expect(withoutTables(commented, owned)).toBe(`model = "gpt-6"\n\n${theirs}`)
    // Between two tables of other things, with a comment that introduces the next one, and with Windows line ends
    const between = `${theirs}\n[hooks.state."it-bridge@it:a"]\ntrusted_hash = "sha256:bb"\nextra = 1\n\n# the next one is mine\n[profiles.mine]\nmodel = "x"\n`
    const left = `${theirs}\n\n# the next one is mine\n[profiles.mine]\nmodel = "x"\n`
    expect(withoutTables(between, owned)).toBe(left)
    expect(withoutTables(between.replaceAll('\n', '\r\n'), owned)).toBe(left.replaceAll('\n', '\r\n'))
    // Nothing of It's in it: not a byte is changed
    expect(withoutTables(`${theirs}# end`, owned)).toBe(`${theirs}# end`)
  })
})
