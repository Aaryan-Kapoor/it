// What the end-to-end scripts lean on to tell a good run from a bad one. On a healthy run each
// of these finds nothing wrong, so nothing else would show if one stopped being able to.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import {
  addonIn,
  appCalls,
  appsFoundBy,
  ask,
  backendRelease,
  couldNotKeep,
  holdsTheName,
  it,
  itEnv,
  machineToken,
  noStack,
  noteFound,
  noteHome,
  patiently,
  reachesAnApp,
  secretsIn,
  stack,
  standInApps,
  stopped,
  takeOut,
  usageReceiver,
  whyNotInstall,
  wrongWithBatch,
  wrongWithUsage,
} from './lib.mjs'
import { foundNote, leaks, redact } from './logs.mjs'

const dir = mkdtempSync(path.join(os.tmpdir(), 'it-lib-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A batch as the program sends one, with one event, changed by whatever is given. */
const batch = (event = {}, over = {}) => ({
  v: 1,
  installation: 'a'.repeat(64),
  events: [
    {
      id: '0b7f6a52-5c0e-4e0b-9d1c-2f1f3f0a8d11',
      at: '2026-10-04T05:00:00.000Z',
      name: 'page.published',
      properties: { agent: 'claude-code', change: 'new', kind: 'custom', size: 'under 10 KB' },
      ...event,
    },
  ],
  ...over,
})

describe('the check of a batch of usage counts', () => {
  test('finds nothing wrong with a batch that is what the page about usage reporting says', () => {
    expect(wrongWithBatch(batch())).toBeNull()
    expect(wrongWithBatch(batch({ name: 'service.started', properties: { version: '0.1.0', os: 'linux', arch: 'x64', installed: 'script' } }))).toBeNull()
  })

  test('an event named after something every object has is not an event', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
      expect(wrongWithBatch(batch({ name, properties: {} })), name).toMatch(/there is no event called/)
    expect(wrongWithBatch(batch({ name: ['page.published'] }))).toMatch(/there is no event called/)
  })

  test('an event’s properties are an object of exactly the listed names, each with a listed value', () => {
    const good = batch().events[0].properties
    const wrong = [
      { ...good, title: 'e2e-private-title' },
      { agent: 'claude-code', change: 'new', kind: 'custom' },
      { ...good, size: 'e2e-private-size' },
      { ...good, change: ['new'] },
      { ...good, size: 7 },
      Object.entries(good),
      null,
      'under 10 KB',
      Object.assign(Object.create(good), {}),
      Object.assign(Object.create({ size: 'under 10 KB' }), { agent: 'claude-code', change: 'new', kind: 'custom' }),
      JSON.parse('{"agent":"claude-code","change":"new","kind":"custom","size":"under 10 KB","__proto__":{"title":"e2e-private-title"}}'),
    ]
    for (const properties of wrong) expect(wrongWithBatch(batch({ properties })), JSON.stringify(properties)).toEqual(expect.any(String))
    expect(wrongWithBatch(batch({ name: 'service.started', properties: { version: ['0.1.0'], os: 'linux', arch: 'x64', installed: 'script' } }))).toMatch(
      /version/,
    )
  })

  test('nothing but text passes for an id, a time or an installation, and nothing but an object for a batch or an event', () => {
    const { id, at } = batch().events[0]
    expect(wrongWithBatch(batch({ id: [id] }))).toMatch(/id/)
    expect(wrongWithBatch(batch({ at: [at] }))).toMatch(/time/)
    expect(wrongWithBatch(batch({ at: '2026-10-04T05:12:00.000Z' }))).toMatch(/time/)
    expect(wrongWithBatch(batch({}, { installation: ['a'.repeat(64)] }))).toMatch(/installation/)
    expect(wrongWithBatch(batch({ path: '/home/e2e-private-person' }))).toMatch(/fields/)
    expect(wrongWithBatch(batch({}, { machine: 'e2e-private-laptop' }))).toMatch(/fields/)
    for (const not of [null, undefined, 'a batch', 7, [batch()]]) expect(wrongWithBatch(not), String(not)).toEqual(expect.any(String))
    for (const not of [null, 'an event', [batch().events[0]]]) expect(wrongWithBatch(batch({}, { events: [not] })), String(not)).toEqual(expect.any(String))
    expect(wrongWithBatch(batch({}, { events: [] }))).toMatch(/between one and twenty/)
  })
})

describe('the stand-in that usage counts are sent to', () => {
  const sent = (to, headers = {}, body = JSON.stringify(batch())) =>
    fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'it/0.1.0', ...headers }, body })

  test('finds nothing wrong with a batch sent as the program sends one', async () => {
    const file = path.join(dir, 'as-sent.jsonl')
    const usage = await usageReceiver(file)
    await sent(usage.url)
    await usage.close()
    expect(usage.batches).toHaveLength(1)
    expect(wrongWithUsage(usage)).toEqual([])
    expect((await leaks([file])).found).toEqual([])
  })

  test('what a request says beside its batch is kept and checked too: where it was sent, and every header', async () => {
    const file = path.join(dir, 'beside.jsonl')
    const usage = await usageReceiver(file)
    await sent(`${usage.url}?email=e2e-private-owner@example.invalid`)
    await sent(usage.url, { 'x-project': 'e2e-private-repository' })
    await sent(usage.url, { 'user-agent': 'it/0.1.0 (e2e-private-laptop)' })
    await sent(usage.url, { cookie: 'session=e2e-private-cookie' })
    await fetch(usage.url, { method: 'PUT', headers: { 'content-type': 'application/json', 'user-agent': 'it/0.1.0' }, body: JSON.stringify(batch()) })
    await usage.close()
    // Each batch is one a batch may be: it is the request around it that says too much
    expect(usage.batches.map(wrongWithBatch)).toEqual([null, null, null, null, null])
    expect(wrongWithUsage(usage)).toEqual([
      expect.stringMatching(/address/),
      expect.stringMatching(/x-project/),
      expect.stringMatching(/user-agent/),
      expect.stringMatching(/cookie/),
      expect.stringMatching(/PUT/),
    ])
    // And all of it is where the check of what a run wrote down reads it
    const kept = readFileSync(file, 'utf8')
    for (const said of ['e2e-private-owner', 'e2e-private-repository', 'e2e-private-laptop', 'e2e-private-cookie']) expect(kept).toContain(said)
    expect((await leaks([file])).found.length).toBeGreaterThanOrEqual(4)
  })

  test('something sent that is not a batch is kept, and is wrong', async () => {
    const file = path.join(dir, 'not-a-batch.jsonl')
    const usage = await usageReceiver(file)
    await sent(usage.url, {}, 'not a batch: e2e-private-text')
    await usage.close()
    expect(usage.unreadable).toHaveLength(1)
    expect(wrongWithUsage(usage)).toEqual([expect.stringMatching(/not a batch/)])
    expect((await leaks([file])).found).toHaveLength(1)
  })
})

describe('the stand-in for the release the backend program is fetched from', () => {
  const folder = mkdtempSync(path.join(dir, 'archives-'))
  const archive = Buffer.from(`an archive, as its release publishes it\n${'x'.repeat(70_000)}`)
  writeFileSync(path.join(folder, 'the-archive.zip'), archive)
  writeFileSync(path.join(folder, '.kept-out'), 'not an archive')
  mkdirSync(path.join(folder, 'inside'))
  writeFileSync(path.join(folder, 'inside', 'deeper.zip'), 'not at the top of the folder')
  writeFileSync(path.join(dir, 'beside-the-archives.zip'), 'outside the folder')

  test('gives an archive of the folder under any release’s name, whole, and notes what it was asked for', async () => {
    const release = await backendRelease(folder)
    try {
      expect(release.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      for (const named of ['precompiled-2026-01-01-0123abc', 'another-release']) {
        const answer = await fetch(`${release.url}/${named}/the-archive.zip`)
        expect(answer.status).toBe(200)
        expect(Buffer.from(await answer.arrayBuffer()).equals(archive)).toBe(true)
      }
      expect(release.asked).toEqual([
        { path: '/precompiled-2026-01-01-0123abc/the-archive.zip', status: 200 },
        { path: '/another-release/the-archive.zip', status: 200 },
      ])
    } finally {
      await release.close()
    }
  })

  test('a program is known to read the variable that names the releases by holding its name, whether it is text or not, and a file that is not there holds nothing', () => {
    const text = path.join(dir, 'a-bundle.mjs')
    const bytes = path.join(dir, 'a-program')
    writeFileSync(text, 'const from = process.env.IT_BACKEND_RELEASES ?? theRelease\n')
    writeFileSync(bytes, Buffer.concat([Buffer.from([0, 255, 1, 254]), Buffer.from('env.IT_BACKEND_RELEASES'), Buffer.from([0, 0, 7])]))
    expect(holdsTheName(text, 'IT_BACKEND_RELEASES')).toBe(true)
    expect(holdsTheName(bytes, 'IT_BACKEND_RELEASES')).toBe(true)
    expect(holdsTheName(text, 'IT_BACKEND_ELSEWHERE')).toBe(false)
    expect(holdsTheName(path.join(dir, 'not-there'), 'IT_BACKEND_RELEASES')).toBe(false)
  })

  test('gives nothing at any other address: a file that is not there, one deeper in the folder, above it or hidden in it, an archive asked for under no release, or one that is sent to', async () => {
    const release = await backendRelease(folder)
    try {
      const statuses = {}
      for (const asked of [
        '/a-release/not-there.zip',
        '/a-release/inside/deeper.zip',
        '/a-release/..%2Fbeside-the-archives.zip',
        '/a-release/%2e%2e/beside-the-archives.zip',
        '/a-release/.kept-out',
        '/a-release/inside',
        '/the-archive.zip',
        '/',
      ])
        statuses[asked] = (await fetch(`${release.url}${asked}`)).status
      expect([...new Set(Object.values(statuses))]).toEqual([404])
      expect((await fetch(`${release.url}/a-release/the-archive.zip`, { method: 'POST', body: 'x' })).status).toBe(405)
      expect(release.asked.every((one) => one.status !== 200)).toBe(true)
    } finally {
      await release.close()
    }
  })
})

describe('where the stack is, for the scripts that use it', () => {
  const lib = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib.mjs')).href

  test('is read from the note the stack left: the folder It lives in and the port it counts from, and from those the site and the backend’s own addresses', () => {
    const note = path.join(dir, 'stack.json')
    writeFileSync(note, JSON.stringify({ home: '/tmp/a-stack’s-folder', port: 20000, pid: 1, service: 2 }))
    expect(stack(note)).toEqual({
      home: '/tmp/a-stack’s-folder',
      port: 20000,
      pid: 1,
      service: 2,
      site: 'http://localhost:20000',
      api: 'http://127.0.0.1:20040',
      http: 'http://127.0.0.1:20041',
    })
  })

  test('a note that is not there, is cut short, or names no folder or port is no stack', () => {
    expect(stack(path.join(dir, 'no-such-note.json'))).toBeNull()
    const note = path.join(dir, 'torn.json')
    for (const torn of ['{"home":"/tmp/x","po', '{"port":20000}', '{"home":"/tmp/x","port":"20000"}', '[]', '']) {
      writeFileSync(note, torn)
      expect(stack(note), torn).toBeNull()
    }
  })

  test('a script that needs a stack says, in one sentence, where it looked and how to start one, and stops there', () => {
    const logs = mkdtempSync(path.join(dir, 'no-stack-'))
    expect(noStack(path.join(logs, 'stack.json'))).toMatch(
      /^no stack is running: none has noted itself in .*stack\.json\. Start one with `node e2e\/stack\.mjs`/,
    )
    const script = `import { needsStack } from ${JSON.stringify(lib)}; needsStack('The end-to-end run'); console.log('went on')`
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, IT_STACK_LOGS: logs } })
    expect(ran.status).toBe(2)
    expect(ran.stdout).toBe('')
    expect(ran.stderr.trim().split('\n')).toEqual([expect.stringMatching(/^The end-to-end run cannot start: no stack is running: none has noted itself in /)])
  })

  test('and one that has a stack is given it, and goes on', () => {
    const logs = mkdtempSync(path.join(dir, 'a-stack-'))
    writeFileSync(path.join(logs, 'stack.json'), JSON.stringify({ home: '/tmp/x', port: 20000 }))
    const script = `import { needsStack } from ${JSON.stringify(lib)}; console.log(needsStack('The end-to-end run').site)`
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, IT_STACK_LOGS: logs } })
    expect([ran.status, ran.stdout.trim()]).toEqual([0, 'http://localhost:20000'])
  })
})

describe('the credentials one of It’s folders holds', () => {
  const made = (n) => String.fromCharCode(97 + n).repeat(40)
  const folder = () => {
    const home = mkdtempSync(path.join(dir, 'folder-'))
    writeFileSync(
      path.join(home, 'service.json'),
      JSON.stringify({ port: 20000, network: false, instanceSecret: made(0), adminKey: made(1), sessionSecret: made(2) }),
    )
    writeFileSync(
      path.join(home, 'machine.json'),
      JSON.stringify({ id: 'j57abc', name: 'a name', key: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: made(3) } }),
    )
    writeFileSync(path.join(home, 'token.json'), JSON.stringify({ token: made(4), exp: 1, machine: 'j57abc' }))
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ token: made(5), pid: 1 }))
    writeFileSync(path.join(home, 'push.json'), JSON.stringify({ publicKey: 'not-a-secret', privateKey: made(6) }))
    return home
  }

  test('are the three keys in its settings, the machine’s key, its token, its connector’s token and the key notifications are signed with, and nothing that is public', () => {
    const held = secretsIn(folder())
    expect(held.map(([, value]) => value)).toEqual([0, 1, 2, 3, 4, 5, 6].map(made))
    expect(new Set(held.map(([what]) => what)).size).toBe(7)
    expect(JSON.stringify(held)).not.toMatch(/not-a-secret|j57abc|a name/)
  })

  test('a folder that holds only some of them yet, or a file that is cut short, gives what is there', () => {
    const home = mkdtempSync(path.join(dir, 'joined-'))
    expect(secretsIn(home)).toEqual([])
    writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ id: 'j57abc', name: 'a name', key: { d: made(7) }, at: 'http://localhost:20000' }))
    writeFileSync(path.join(home, 'token.json'), '{"token":')
    expect(secretsIn(home)).toEqual([[expect.stringContaining('machine’s key'), made(7)]])
  })

  test('and each is noted, so that nothing printed afterwards holds it', () => {
    const home = folder()
    noteHome(home)
    for (const [, value] of secretsIn(home)) expect(redact(`the service said ${value} and went on`)).toMatch(/^the service said \[[^\]]+\] and went on$/)
  })
})

describe('a finding that no kept file will show again', () => {
  const beside = path.join(dir, 'found-holds.jsonl')
  const before = process.env.IT_E2E_INVENTORY
  afterAll(() => {
    if (before === undefined) delete process.env.IT_E2E_INVENTORY
    else process.env.IT_E2E_INVENTORY = before
  })

  test('is noted beside what the run holds, by where it was found, its kind and how often, each once however often it is told of', () => {
    process.env.IT_E2E_INVENTORY = beside
    noteFound('the console of browser 2', ['a showing’s address', 'a signed token', 'a showing’s address'])
    noteFound('the console of browser 2', ['a showing’s address', 'a signed token', 'a showing’s address'])
    // In the note the scan itself keeps, and looks for when it is run afterwards
    expect(readFileSync(foundNote(), 'utf8')).toBe('the console of browser 2 held a showing’s address (2)\nthe console of browser 2 held a signed token (1)\n')
  })

  test('makes the scan that is made afterwards refuse to vouch for the run, though every kept file is clean', () => {
    const clean = mkdtempSync(path.join(dir, 'clean-'))
    writeFileSync(path.join(clean, 'browser-2.console.log'), 'log: [a showing’s address]\n')
    writeFileSync(beside, '')
    const scanned = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs.mjs'), clean], {
      env: { ...process.env, IT_E2E_INVENTORY: beside },
      encoding: 'utf8',
    })
    expect(scanned.status).toBe(1)
    expect(scanned.stderr).toMatch(/found a credential/)
  })

  test('is nothing where the run found none, or where it keeps no note of what it holds', () => {
    const none = path.join(dir, 'none-found.jsonl')
    process.env.IT_E2E_INVENTORY = none
    const itsNote = foundNote()
    noteFound('the console of browser 1', [])
    expect(existsSync(itsNote)).toBe(false)
    delete process.env.IT_E2E_INVENTORY
    noteFound('the console of browser 1', ['a signed token'])
    expect(existsSync(itsNote)).toBe(false)
  })
})

describe('what a program a run starts is given', () => {
  const before = { ...process.env }
  /** The folders programs are looked for in, as some surroundings name them: Windows may write the name in other letters. */
  const pathOf = (env) => env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH')]
  const givenPath = pathOf(before)
  afterEach(() => {
    for (const name of ['IT_URL', 'IT_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'IT_E2E_APPS', 'IT_BACKEND_BIN', 'IT_BACKEND_RELEASES'])
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    process.env.PATH = givenPath
  })
  /** A folder that holds a file under the name of an agent app's own command, as the folder an app is installed in does. */
  const holding = (command) => {
    const folder = mkdtempSync(path.join(dir, 'holds-'))
    writeFileSync(path.join(folder, process.platform === 'win32' ? `${command}.cmd` : command), '', { mode: 0o755 })
    return folder
  }

  test('its own folder, the two agent apps it may look for and where its usage counts go, and nothing of another It or of the conversation this program is run from', () => {
    Object.assign(process.env, { IT_URL: 'http://another.invalid', IT_SESSION: 'made-up', CLAUDE_CODE_SESSION_ID: 'made-up', CODEX_THREAD_ID: 'made-up' })
    delete process.env.IT_E2E_APPS
    delete process.env.IT_BACKEND_BIN
    delete process.env.IT_BACKEND_RELEASES
    const env = itEnv('/tmp/a-machine')
    expect(
      Object.keys(env)
        .filter((name) => /^(IT_|CLAUDE|CODEX)/.test(name))
        .sort(),
    ).toEqual(['IT_HARNESSES', 'IT_HOME', 'IT_TELEMETRY_URL'])
    expect(env.IT_HOME).toBe('/tmp/a-machine')
    expect(env.IT_TELEMETRY_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/usage$/)
    // With no made-up folder named, programs are looked for where this one looks: the runs that drive a real agent app need that
    expect(pathOf(env)).toBe(givenPath)
  })

  test('the backend program this one was told to use, and made-up folders for the agent apps’ settings where the run has named one', () => {
    const apps = mkdtempSync(path.join(dir, 'apps-'))
    Object.assign(process.env, { IT_E2E_APPS: apps, IT_BACKEND_BIN: '/tmp/a-backend-program' })
    expect(itEnv('/tmp/a-machine')).toMatchObject({
      IT_BACKEND_BIN: '/tmp/a-backend-program',
      CLAUDE_CONFIG_DIR: path.join(apps, 'claude'),
      CODEX_HOME: path.join(apps, 'codex'),
    })
  })

  test('where the backend program’s releases are, when this one was told: a stand-in on this machine, for a first run that fetches the program', () => {
    delete process.env.IT_BACKEND_BIN
    process.env.IT_BACKEND_RELEASES = 'http://127.0.0.1:20999'
    const env = itEnv('/tmp/a-machine')
    expect(env.IT_BACKEND_RELEASES).toBe('http://127.0.0.1:20999')
    expect(env.IT_BACKEND_BIN).toBeUndefined()
  })

  test('where the run has named a made-up folder, the stand-ins for the agent apps come first where programs are looked for, and no folder that holds Claude Code or Codex is looked in at all', () => {
    const apps = mkdtempSync(path.join(dir, 'apps-'))
    const [withClaude, withCodex, withNeither] = [holding('claude'), holding('codex'), mkdtempSync(path.join(dir, 'holds-'))]
    process.env.IT_E2E_APPS = apps
    // A folder that is not written from the root, and the empty one, are read from wherever a program happens to be
    process.env.PATH = [withClaude, withNeither, '', 'somewhere/of/its/own', withCodex].join(path.delimiter)
    const env = itEnv('/tmp/a-machine')
    expect(pathOf(env).split(path.delimiter)).toEqual([path.join(apps, 'bin'), withNeither])
    const found = appsFoundBy(env)
    expect(Object.keys(found)).toEqual(['claude', 'codex'])
    for (const places of Object.values(found)) expect(places.map((file) => path.dirname(file))).toEqual([path.join(apps, 'bin')])
    expect(reachesAnApp(env)).toBeNull()
  })

  test.skipIf(process.platform === 'win32')(
    'a program given them that runs Claude Code or Codex by name runs the stand-in, and never one that lies in a folder this program was given',
    () => {
      const apps = mkdtempSync(path.join(dir, 'apps-'))
      // Folders as the ones the apps are installed in, each with a program under the app's name that leaves a mark when it is run
      const ran = path.join(dir, `ran-${path.basename(apps)}`)
      const real = ['claude', 'codex'].map((command) => {
        const folder = mkdtempSync(path.join(dir, 'real-'))
        writeFileSync(path.join(folder, command), `#!/bin/sh\necho ${command} >> '${ran}'\n`, { mode: 0o755 })
        return folder
      })
      process.env.IT_E2E_APPS = apps
      process.env.PATH = [...real, givenPath].join(path.delimiter)
      const env = itEnv('/tmp/a-machine')
      for (const command of ['claude', 'codex']) spawnSync(command, ['--version'], { env, encoding: 'utf8' })
      expect(existsSync(ran)).toBe(false)
      expect(appCalls().map((call) => `${call.app} ${call.args.join(' ')}`)).toEqual(['claude --version', 'codex --version'])
    },
  )

  test('surroundings in which an agent app itself could be found, or its stand-in could not, are said to be so', () => {
    const apps = mkdtempSync(path.join(dir, 'apps-'))
    const [standIns, withCodex] = [standInApps(apps), holding('codex')]
    expect(reachesAnApp({ PATH: [standIns, withCodex].join(path.delimiter) }, apps)).toBe(
      'a program given these surroundings could find `codex` itself, in a folder that is not the stand-ins’',
    )
    expect(reachesAnApp({ PATH: withCodex }, apps)).toBe('a program given these surroundings would find no stand-in for `claude`')
    expect(reachesAnApp({ PATH: standIns }, apps)).toBeNull()
    // With no made-up folder there are no stand-ins to find
    expect(reachesAnApp({ PATH: standIns }, undefined)).toMatch(/would find no stand-in/)
  })

  test.skipIf(process.platform === 'win32')(
    'the stand-in for Claude Code fails whatever it is asked, the one for Codex lists an add-on of It’s once one was added and until it is removed, and every call is noted',
    () => {
      const apps = mkdtempSync(path.join(dir, "an owner's apps-"))
      process.env.IT_E2E_APPS = apps
      const env = itEnv('/tmp/a-machine')
      const asked = (app, ...words) => {
        const ran = spawnSync(path.join(apps, 'bin', app), words, { env, encoding: 'utf8' })
        return ran.status === 0 ? ran.stdout.trim() : `failed (${ran.status})`
      }
      const from = path.join(dir, 'an add-on')
      mkdirSync(from, { recursive: true })
      expect([asked('claude', '--version'), asked('claude', 'plugin', 'list', '--json')]).toEqual(['failed (1)', 'failed (1)'])
      expect(asked('codex', '--version')).toBe('codex-cli 0.159.0')
      expect(asked('codex', 'plugin', 'list', '--marketplace', 'it')).toBe('No plugins.')
      // Nothing is added from a place that was never named
      expect(asked('codex', 'plugin', 'add', 'it-bridge@it')).toBe('failed (1)')
      asked('codex', 'plugin', 'marketplace', 'add', from)
      expect(asked('codex', 'plugin', 'list', '--marketplace', 'it')).toBe(`it-bridge@it  not installed  0.1.0  ${from}`)
      asked('codex', 'plugin', 'add', 'it-bridge@it')
      expect(asked('codex', 'plugin', 'list', '--marketplace', 'it')).toBe(`it-bridge@it  installed, enabled  0.1.0  ${from}`)
      expect(asked('codex', 'queue', '--thread=a-conversation', '--message=two words')).toBe('')
      asked('codex', 'plugin', 'remove', 'it-bridge@it')
      expect(asked('codex', 'plugin', 'list', '--marketplace', 'it')).toBe(`it-bridge@it  not installed  0.1.0  ${from}`)
      asked('codex', 'plugin', 'marketplace', 'remove', 'it')
      expect(asked('codex', 'plugin', 'list', '--marketplace', 'it')).toBe('No plugins.')
      // What it was given is kept in the made-up folder for Codex's settings, and nowhere else
      expect(JSON.parse(readFileSync(path.join(apps, 'codex', 'stand-in.json'), 'utf8'))).toEqual({ from: null, added: false })
      const calls = appCalls()
      expect(calls).toHaveLength(14)
      expect(calls.slice(0, 2)).toEqual([
        { app: 'claude', args: ['--version'] },
        { app: 'claude', args: ['plugin', 'list', '--json'] },
      ])
      expect(calls).toContainEqual({ app: 'codex', args: ['queue', '--thread=a-conversation', '--message=two words'] })
    },
  )

  test.skipIf(process.platform === 'win32')(
    'a stand-in that is told of a file waits to answer for as long as the file is there, and answers once it is gone',
    async () => {
      const apps = mkdtempSync(path.join(dir, 'apps-'))
      process.env.IT_E2E_APPS = apps
      const keepsIt = path.join(apps, 'keeps-a-stand-in')
      writeFileSync(keepsIt, '')
      const asked = spawn(path.join(apps, 'bin', 'codex'), ['--version'], {
        env: { ...itEnv('/tmp/a-machine'), E2E_APPS_HOLD: keepsIt },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let said = ''
      asked.stdout.on('data', (piece) => (said += piece))
      const ended = new Promise((resolve) => asked.once('close', resolve))
      // It notes that it was asked before it waits, and says nothing while the file is there
      for (let waited = 0; waited < 100 && appCalls().length === 0; waited++) await new Promise((resolve) => setTimeout(resolve, 50))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect([appCalls().length, said]).toEqual([1, ''])
      rmSync(keepsIt)
      expect(await ended).toBe(0)
      expect(said.trim()).toBe('codex-cli 0.159.0')
    },
  )
})

describe('asking for what It gives only so often', () => {
  test('is done again where It says to try again shortly, whether that is answered or thrown, and gives what is had in the end', async () => {
    let times = 0
    const answered = async () => (++times < 3 ? { ok: false, code: 'rate_limited' } : { ok: true, value: 'had' })
    expect(await patiently(answered, { wait: 1 })).toEqual({ ok: true, value: 'had' })
    expect(times).toBe(3)
    times = 0
    const thrown = async () => {
      if (++times < 4) throw Object.assign(new Error('Too many requests. Try again shortly.'), { code: 'rate_limited' })
      return 'had'
    }
    expect(await patiently(thrown, { wait: 1 })).toBe('had')
    expect(times).toBe(4)
  })

  test('is given up after six askings, with what the last was told, and anything else it is told is passed on at once', async () => {
    let times = 0
    const never = async () => {
      times += 1
      throw Object.assign(new Error('Too many requests. Try again shortly.'), { code: 'rate_limited' })
    }
    await expect(patiently(never, { wait: 1 })).rejects.toMatchObject({ code: 'rate_limited' })
    expect(times).toBe(6)
    times = 0
    const refused = async () => {
      times += 1
      throw Object.assign(new Error('No.'), { code: 'forbidden' })
    }
    await expect(patiently(refused, { wait: 1 })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await patiently(async () => ({ ok: false, code: 'forbidden' }), { wait: 1 })).toEqual({ ok: false, code: 'forbidden' })
    expect(times).toBe(1)
  })
})

describe('asking the backend directly', () => {
  /** A stand-in for the backend: it answers each function as given, and notes how it was asked. */
  const backend = async (answers) => {
    const asked = []
    const server = createServer((req, res) => {
      let text = ''
      req.on('data', (c) => (text += c))
      req.on('end', () => {
        const body = JSON.parse(text)
        asked.push({ at: req.url, as: req.headers.authorization, body })
        const [status, said] = answers[body.path] ?? [404, {}]
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(said))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { at: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((done) => server.close(done)) }
  }

  test('gives what a function returned, or the code it refused with, and says who asks only when there is a token', async () => {
    const b = await backend({
      'artifacts:list': [200, { status: 'success', value: [{ id: 'a-page' }] }],
      'machines:list': [200, { status: 'error', errorMessage: 'Server Error', errorData: { code: 'forbidden', message: 'Only the owner.' } }],
      'no:code': [200, { status: 'error', errorMessage: 'Server Error' }],
      'bad:token': [401, { code: 'InvalidAuthHeader', message: 'not a token' }],
    })
    try {
      expect(await ask('query', 'artifacts:list', {}, 'its-token', b.at)).toEqual({ ok: true, value: [{ id: 'a-page' }] })
      expect(await ask('query', 'machines:list', { all: true }, undefined, b.at)).toEqual({ ok: false, code: 'forbidden' })
      expect(await ask('mutation', 'no:code', {}, undefined, b.at)).toEqual({ ok: false, code: 'status 200' })
      expect(await ask('mutation', 'bad:token', {}, 'not-a-token', b.at)).toEqual({ ok: false, code: 'InvalidAuthHeader' })
      expect(b.asked.map((a) => [a.at, a.as, a.body])).toEqual([
        ['/api/query', 'Bearer its-token', { path: 'artifacts:list', args: {}, format: 'json' }],
        ['/api/query', undefined, { path: 'machines:list', args: { all: true }, format: 'json' }],
        ['/api/mutation', undefined, { path: 'no:code', args: {}, format: 'json' }],
        ['/api/mutation', 'Bearer not-a-token', { path: 'bad:token', args: {}, format: 'json' }],
      ])
    } finally {
      await b.close()
    }
  })

  test('a machine’s token is the one its folder holds once it has been asked something, and is noted as a credential', async () => {
    const home = mkdtempSync(path.join(dir, 'machine-'))
    const earned = 'earned-by-the-key-0123456789'
    const ran = []
    const run = async (folder, args) => {
      ran.push([folder, args])
      writeFileSync(path.join(folder, 'token.json'), JSON.stringify({ token: earned, exp: 1 }))
    }
    expect(await machineToken(home, { run })).toBe(earned)
    expect(ran).toEqual([[home, ['whoami']]])
    expect(redact(`asked as ${earned}`)).not.toContain(earned)
    // A machine that was asked and kept nothing has no token to give
    await expect(machineToken(mkdtempSync(path.join(dir, 'machine-')), { run: async () => {} })).rejects.toThrow('the machine kept no token')
  })
})

describe('whether a run that installs It’s add-on, and removes it at its end, may be started', () => {
  /** An agent app that answers each of its commands as given: text for one that worked, null for one that failed. */
  const app = (answers) => async (_cmd, args) => {
    const said = answers[args.join(' ')]
    return typeof said === 'string' ? { ok: true, out: said } : { ok: false, out: '' }
  }
  const claude = (said) => addonIn('claude-code', app({ 'plugin list --json': said }))
  const codex = (ofOurs, ofAll = null) => addonIn('codex', app({ 'plugin list --marketplace it': ofOurs, 'plugin list': ofAll }))

  test('Claude Code has the add-on when it lists it, switched on or off', async () => {
    expect(await claude(JSON.stringify([{ id: 'it-bridge@it', enabled: true }]))).toBe('present')
    expect(
      await claude(
        JSON.stringify([
          { id: 'something@else', enabled: true },
          { id: 'it-bridge@it', enabled: false },
        ]),
      ),
    ).toBe('present')
    expect(await claude(JSON.stringify([{ id: 'something@else', enabled: true }]))).toBe('absent')
    expect(await claude('[]')).toBe('absent')
  })

  test('and when Claude Code cannot be asked, or answers something else, it is not known', async () => {
    expect(await claude(null)).toBe('unknown')
    expect(await claude('Usage: claude plugin <command>')).toBe('unknown')
    expect(await claude('{"plugins":[]}')).toBe('unknown')
    expect(await claude('')).toBe('unknown')
  })

  test('Codex has the add-on when it lists it as anything but not installed', async () => {
    expect(await codex('it-bridge@it  installed, enabled\n')).toBe('present')
    expect(await codex('it-bridge@it  installed, disabled\n')).toBe('present')
    expect(await codex('it-bridge@it  not installed\n')).toBe('absent')
    expect(await codex('No plugins found in marketplace `it`.\n')).toBe('absent')
  })

  test('and an answer from Codex that is no listing is not taken to say the add-on is not there', async () => {
    expect(await codex('Usage: codex plugin list [OPTIONS]\n')).toBe('unknown')
    expect(await codex('')).toBe('unknown')
    expect(await codex(null, 'Usage: codex plugin list [OPTIONS]\n')).toBe('unknown')
    expect(await codex(null, '')).toBe('unknown')
  })

  test('where Codex does not know the place the add-on comes from, everything it has is looked through', async () => {
    expect(await codex(null, 'another@market  installed, enabled\n')).toBe('absent')
    expect(await codex(null, 'No plugins found.\n')).toBe('absent')
    expect(await codex(null, 'another@market  installed, enabled\nit-bridge@it  installed, disabled\n')).toBe('present')
    // Listed in some other way than the one expected: it is there all the same
    expect(await codex(null, 'it-bridge (it)  disabled\n')).toBe('present')
    expect(await codex(null, 'it-bridge@it  not installed\n')).toBe('absent')
    expect(await codex(null, null)).toBe('unknown')
  })

  test('an app that is not one of the two is not known', async () => {
    expect(await addonIn('pi', app({}))).toBe('unknown')
  })

  test.skipIf(process.platform === 'win32')('the app is asked with its own command, found the way the CLI finds it', async () => {
    const bin = mkdtempSync(path.join(dir, 'bin-'))
    writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh\n[ "$1 $2 $3" = "plugin list --json" ] || exit 2\n[ -z "$IT_SESSION$CLAUDE_CODE_SESSION_ID" ] || exit 3\necho '[{"id":"it-bridge@it","enabled":false}]'\n`,
      { mode: 0o755 },
    )
    // The app is told nothing of the conversation this program may itself be run from
    const marks = ['IT_SESSION', 'CLAUDE_CODE_SESSION_ID']
    const before = Object.fromEntries(['PATH', ...marks].map((name) => [name, process.env[name]]))
    process.env.PATH = `${bin}${path.delimiter}${before.PATH}`
    for (const name of marks) process.env[name] = 'made-up'
    try {
      expect(await addonIn('claude-code')).toBe('present')
    } finally {
      for (const [name, value] of Object.entries(before))
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
  })

  test('it may be started only where the app is there, can take the add-on, and is known not to have it', () => {
    expect(whyNotInstall('Claude Code', { id: 'claude-code', version: '2.1.0', addon: 'not_connected' }, 'absent')).toBeNull()
    const refused = [
      [undefined, undefined, /^Claude Code was not found on this machine/],
      [{ addon: 'too_old', detail: 'Needs Claude Code 2.1 or newer.' }, undefined, /is too old for It’s add-on \(Needs Claude Code 2\.1 or newer\.\)/],
      [
        { addon: 'unavailable', detail: 'It cannot connect to Claude Code yet.' },
        undefined,
        /has no add-on for Claude Code \(It cannot connect to Claude Code yet\.\)/,
      ],
      [{ addon: 'connected' }, undefined, /already has It’s add-on\. This run would replace it and then remove it/],
      [{ addon: 'needs_approval' }, undefined, /already has It’s add-on\. This run would replace it and then remove it/],
      [{ addon: 'not_connected' }, 'present', /already has It’s add-on, switched off\. This run would replace it and then remove it/],
      [{ addon: 'not_connected' }, 'unknown', /could not be asked whether it already has It’s add-on/],
      [{ addon: 'not_connected' }, undefined, /could not be asked whether it already has It’s add-on/],
      [{ addon: 'error' }, 'absent', /error/],
    ]
    for (const [status, inApp, says] of refused) {
      const why = whyNotInstall('Claude Code', status, inApp)
      expect(why, JSON.stringify(status)).toMatch(says)
      expect(why).toMatch(/has not been started\.$/)
    }
  })
})

describe('what the CLI prints in a run', () => {
  test('is kept where the run’s check reads it, and each time it cannot be kept is counted', async () => {
    const home = mkdtempSync(path.join(dir, 'home-'))
    const said = mkdtempSync(path.join(dir, 'said-'))
    process.env.IT_E2E_SAID = said
    try {
      // Whoever runs it is given the program as soon as it has been started
      let started
      expect((await it(home, ['version'], { onStart: (program) => (started = program.pid) })).version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(started).toEqual(expect.any(Number))
      expect(readFileSync(path.join(said, 'cli.answers.txt'), 'utf8')).toMatch(/^\$ it version\n\{/)
      expect(couldNotKeep()).toBe(0)
      process.env.IT_E2E_SAID = path.join(said, 'no-such-folder')
      // The command is answered all the same: it is the run that fails on what was not kept
      expect((await it(home, ['version'])).version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(couldNotKeep()).toBe(1)
    } finally {
      delete process.env.IT_E2E_SAID
    }
  })

  test('a code that pairs a browser, in the address `it site` answers with, is noted as a credential and is not in what is kept', () => {
    const lib = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib.mjs')).href
    const logs = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs.mjs')).href
    const said = mkdtempSync(path.join(dir, 'said-'))
    const code = 'abcdefghijklmnopqrst'
    // A stand-in for the program, which answers `site` as the program does and says the address to the person as well
    const standIn = path.join(dir, 'stand-in.mjs')
    writeFileSync(standIn, `const url = 'http://localhost:20000/pair#${code}'\nconsole.error('open ' + url)\nconsole.log(JSON.stringify({ url }))\n`)
    const script = [
      `import { it } from ${JSON.stringify(lib)}`,
      `import { redact } from ${JSON.stringify(logs)}`,
      `const answered = await it(${JSON.stringify(said)}, ['site', '--no-open'])`,
      `console.log(JSON.stringify({ url: answered.url, printed: redact('the address was ' + answered.url) }))`,
    ].join('\n')
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, IT_BIN: '', IT_CLI: standIn, IT_E2E_SAID: said },
    })
    expect(ran.status, ran.stderr).toBe(0)
    const { url, printed } = JSON.parse(ran.stdout)
    // Whoever asked is given the address whole, to open it
    expect(url).toBe(`http://localhost:20000/pair#${code}`)
    expect(printed).not.toContain(code)
    for (const file of ['cli.answers.txt', 'cli.said.log']) {
      const kept = readFileSync(path.join(said, file), 'utf8')
      expect(kept).toContain('/pair#[a code that pairs a browser]')
      expect(kept).not.toContain(code)
    }
  })
})

describe('stopping a program a run started', () => {
  const program = (source) => spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
  /** Started, and far enough along to have said so. */
  const running = async (source) => {
    const child = program(`${source}; console.log('up'); setInterval(() => {}, 1000)`)
    await new Promise((resolve) => child.stdout.once('data', resolve))
    return child
  }

  test('is waited for: it has gone by the time anything it wrote is read', async () => {
    const child = await running('0')
    await stopped(child)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('one that does not go when asked is made to', async () => {
    const child = await running("process.on('SIGTERM', () => {})")
    const began = Date.now()
    await stopped(child, 300)
    expect(child.signalCode).toBe('SIGKILL')
    expect(Date.now() - began).toBeLessThan(4000)
  })

  test('one that was never started, or has already ended, is not waited for', async () => {
    await stopped(undefined)
    const child = program('0')
    await new Promise((resolve) => child.once('close', resolve))
    await stopped(child)
    expect(child.exitCode).toBe(0)
  })
})

describe('taking It’s add-on out of an agent app at the end of a run that put it there', () => {
  /** A stand-in for Claude Code that has the add-on, and whose own command takes it out or does not. */
  const claude = ({ uninstalls }) => {
    const app = { there: true, asked: [] }
    app.ask = async (cmd, args) => {
      const said = `${cmd} ${args.join(' ')}`
      app.asked.push(said)
      if (said === 'claude plugin list --json') return { ok: true, out: JSON.stringify(app.there ? [{ id: 'it-bridge@it' }] : []) }
      if (said === 'claude plugin uninstall it-bridge@it' && uninstalls) app.there = false
      return { ok: uninstalls, out: '' }
    }
    return app
  }
  const home = '/tmp/a-run’s-folder'

  test('where setup takes it out, it is out, and the app’s own commands are not asked to', async () => {
    const app = claude({ uninstalls: true })
    const run = async () => {
      app.there = false
      return { harnesses: [] }
    }
    const taken = await takeOut('claude-code', home, { run, ask: app.ask })
    expect(taken).toEqual({ setup: { harnesses: [] }, out: true, left: null })
    expect(app.asked).toEqual(['claude plugin list --json'])
  })

  test('where setup fails, as it does when the backend cannot be reached, the app’s own command takes it out, and the run is told that setup failed', async () => {
    const app = claude({ uninstalls: true })
    const run = async () => {
      throw new Error('the backend did not answer')
    }
    const taken = await takeOut('claude-code', home, { run, ask: app.ask })
    expect(taken.setup).toEqual({ error: 'the backend did not answer' })
    expect(taken.out).toBe(true)
    expect(taken.left).toBeNull()
    expect(app.asked).toContain('claude plugin uninstall it-bridge@it')
    expect(app.asked).toContain('claude plugin marketplace remove it')
  })

  test('where neither can take it out, it is not out, and what is left names the folder that was kept and the commands that remove the add-on', async () => {
    const app = claude({ uninstalls: false })
    const run = async () => {
      throw new Error('the backend did not answer')
    }
    const taken = await takeOut('claude-code', home, { run, ask: app.ask })
    expect(taken.out).toBe(false)
    expect(taken.left).toContain(home)
    expect(taken.left).toContain('`claude plugin uninstall it-bridge@it`')
    expect(taken.left).toContain('`claude plugin marketplace remove it`')
    expect(taken.left).toContain('setup --none --no-service')
  })

  test('where setup says it is out and the app still has it, it is not taken for out', async () => {
    const app = claude({ uninstalls: false })
    const taken = await takeOut('claude-code', home, { run: async () => ({ harnesses: [] }), ask: app.ask })
    expect(taken.out).toBe(false)
    expect(taken.left).toContain('is still in this machine’s Claude Code')
  })

  test('an app that cannot be asked is not taken to be without it, and Codex is asked with Codex’s own commands', async () => {
    const asked = []
    const ask = async (cmd, args) => {
      asked.push(`${cmd} ${args.join(' ')}`)
      return { ok: false, out: '' }
    }
    const taken = await takeOut('codex', home, { run: async () => ({ harnesses: [] }), ask })
    expect(taken.out).toBe(false)
    expect(taken.left).toContain('may still be in this machine’s Codex')
    expect(asked).toContain('codex plugin remove it-bridge@it')
    expect(asked).toContain('codex plugin marketplace remove it')
  })
})
