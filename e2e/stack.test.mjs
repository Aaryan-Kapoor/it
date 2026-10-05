// How the stack (e2e/stack.mjs) stops, and what it says of it. On a healthy run the service
// stops when it is asked and nothing is left behind, so nothing else would show if the stack
// stopped noticing when that is not so. Nothing of It runs here: the program the stack starts
// is a stand-in, which sets up and serves as little as the stack looks for, and stops, or does
// not, as each test tells it to.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { reachesAnApp } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(path.join(os.tmpdir(), 'it-stack-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The stand-in for the `it` program. `setup` leaves the settings the stack looks for. `serve`
// answers where the stack waits for an answer, notes where it was told to look for programs and
// for the agent apps' settings, and stops when it is asked unless it was told to pass that over.
// Told to leave a backend program behind, it starts a stand-in for one, names it in the
// folder's lock as the service does, and ends without stopping it. Told to fetch, its `setup`
// asks the release it was told of for an archive, as It does on a first run, and keeps what it
// was given with what it was told about the backend program.
const standIn = path.join(dir, 'it.mjs')
writeFileSync(
  standIn,
  `import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
const home = process.env.IT_HOME
const how = process.env.E2E_STAND_IN
if (process.argv[2] === 'setup') {
  mkdirSync(home, { recursive: true })
  if (how.startsWith('fetches')) {
    const told = { releases: process.env.IT_BACKEND_RELEASES ?? null, program: process.env.IT_BACKEND_BIN ?? null }
    const answer = await fetch(told.releases + '/a-release/' + (how === 'fetches' ? 'the-archive.zip' : 'another.zip'))
    writeFileSync(path.join(home, 'fetched'), Buffer.from(await answer.arrayBuffer()))
    writeFileSync(path.join(home, 'told.json'), JSON.stringify({ ...told, status: answer.status }))
  }
  writeFileSync(path.join(home, 'service.json'), JSON.stringify({ port: Number(process.env.IT_PORT) }))
  console.log('{}')
} else if (process.argv[2] === 'serve') {
  const { port } = JSON.parse(readFileSync(path.join(home, 'service.json'), 'utf8'))
  for (const at of [port, port + 41]) http.createServer((_req, res) => res.writeHead(200).end('ok')).listen(at, '127.0.0.1')
  const given = { path: process.env.PATH.split(path.delimiter), claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }
  writeFileSync(path.join(home, 'given.json'), JSON.stringify(given))
  if (how.startsWith('leaves')) {
    const data = path.join(how === 'leaves another folder’s' ? home + '-of-another' : home, 'backend', 'storage')
    const left = spawn(process.execPath, [process.env.E2E_STAND_IN_BACKEND, data, how], { detached: true, stdio: 'ignore' })
    left.unref()
    mkdirSync(path.join(home, 'backend'), { recursive: true })
    writeFileSync(path.join(home, 'backend', 'lock'), JSON.stringify({ pid: process.pid, program: left.pid }))
  }
  process.on('SIGTERM', () => how === 'does not stop' || process.exit(0))
}
`,
)
// The stand-in for the backend program, named as that program is. It stops when it is asked as
// the service asks it, unless it was told not to hear.
const backendStandIn = path.join(dir, 'convex-local-backend.mjs')
writeFileSync(backendStandIn, `process.on('SIGINT', () => process.argv[3].endsWith('that does not hear') || process.exit(0))\nsetInterval(() => {}, 1000)\n`)

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (fn, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const v = await fn()
    if (v) return v
  }
  return undefined
}
/** Whether nothing listens on a port of this machine. */
const free = (port) =>
  new Promise((resolve) => {
    const tried = net.createServer()
    tried.once('error', () => resolve(false))
    tried.listen(port, '127.0.0.1', () => tried.close(() => resolve(true)))
  })
/** A port the system has free, whose forty-first after it is free too: the two the stack waits for an answer on. */
async function freeBase() {
  for (let n = 0; n < 20; n++) {
    const port = await new Promise((resolve) => {
      const asked = net.createServer()
      asked.listen(0, '127.0.0.1', () => {
        const { port } = asked.address()
        asked.close(() => resolve(port))
      })
    })
    if (port < 60_000 && (await free(port + 41))) return port
  }
  throw new Error('no two free ports were found for the stand-in to answer on')
}

const started = []
/** The made-up folders for the agent apps that the stacks of a test were given: a stack removes its own when it stops, and one that was ended before it could leaves it. */
const madeUp = []
afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  for (const apps of madeUp.splice(0)) rmSync(apps, { recursive: true, force: true })
})

/** What a stack is started with here: nothing of whoever runs the tests, a stand-in for the program, and a second in place of a minute to wait for it to stop. */
const surroundings = (logs) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('IT_'))),
  IT_STACK_LOGS: logs,
  IT_STACK_STOP_SECONDS: '1',
})
/**
 * Starts the stack with the stand-in, told how to behave, and waits until it says it is ready.
 * Gives what is needed to stop it and to see how it ended.
 */
async function startStack(how, more = {}) {
  const folder = mkdtempSync(path.join(dir, 'stack-'))
  const [logs, home] = [path.join(folder, 'logs'), path.join(folder, 'home')]
  const port = await freeBase()
  const child = spawn(process.execPath, [path.join(here, 'stack.mjs')], {
    env: { ...surroundings(logs), IT_CLI: standIn, IT_HOME: home, IT_PORT: String(port), E2E_STAND_IN: how, E2E_STAND_IN_BACKEND: backendStandIn, ...more },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(child.pid)
  let said = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (piece) => (said += piece))
  const ended = new Promise((resolve) => child.once('close', (code, signal) => resolve(signal ?? code)))
  const note = () => {
    try {
      return JSON.parse(readFileSync(path.join(logs, 'stack.json'), 'utf8'))
    } catch {
      return null
    }
  }
  if (!(await until(() => /^ready: /m.test(said) || child.exitCode !== null))) throw new Error(`the stack did not say it was ready: ${said}`)
  if (!/^ready: /m.test(said)) throw new Error(`the stack ended before it was ready: ${said}`)
  started.push(note().service)
  // Where the service was told to look for the agent apps' settings, once it has noted it
  const given = await until(() => {
    try {
      return JSON.parse(readFileSync(path.join(home, 'given.json'), 'utf8'))
    } catch {
      return undefined
    }
  }, 5000)
  if (given?.claude) madeUp.push(path.dirname(given.claude))
  // The program the service left behind, once it has named it in the folder's lock
  const left = () => {
    try {
      return JSON.parse(readFileSync(path.join(home, 'backend', 'lock'), 'utf8')).program
    } catch {
      return undefined
    }
  }
  if (how.startsWith('leaves')) started.push(await until(left))
  return { child, logs, home, note, ended, said: () => said, left }
}
/** Asks a stack to stop with `node e2e/stop.mjs`, and gives how that ended and what it said. */
const stop = (logs, seconds = '20') =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'stop.mjs'), seconds], { env: surroundings(logs), stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (piece) => (said += piece))
    child.once('close', (status) => resolve({ status, said }))
  })

describe.skipIf(process.platform === 'win32')('what the stack starts', () => {
  test('looks for Claude Code and Codex among stand-ins, which come first where it looks for programs, and for their settings in made-up folders that go when the stack stops', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('stops')
    const given = JSON.parse(readFileSync(path.join(stack.home, 'given.json'), 'utf8'))
    const apps = path.dirname(given.claude)
    expect(given).toMatchObject({ claude: path.join(apps, 'claude'), codex: path.join(apps, 'codex') })
    expect(given.path[0]).toBe(path.join(apps, 'bin'))
    expect(reachesAnApp({ PATH: given.path.join(path.delimiter) }, apps)).toBeNull()
    expect((await stop(stack.logs)).status).toBe(0)
    expect(existsSync(apps)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('a stack that stands in for the release the backend program is fetched from', () => {
  const archives = path.join(dir, 'archives')
  mkdirSync(archives)
  writeFileSync(path.join(archives, 'the-archive.zip'), 'an archive, as its release publishes it')

  test('tells what it starts where the releases are and of no program to use as it is, gives it the archive it asks for, and notes where it stood in', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('fetches', { IT_STACK_BACKEND_ARCHIVES: archives })
    const told = JSON.parse(readFileSync(path.join(stack.home, 'told.json'), 'utf8'))
    expect(told).toEqual({ releases: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), program: null, status: 200 })
    expect(readFileSync(path.join(stack.home, 'fetched'), 'utf8')).toBe('an archive, as its release publishes it')
    expect(stack.note().release).toBe(told.releases)
    expect((await stop(stack.logs)).status).toBe(0)
    expect(await stack.ended).toBe(0)
    // The stand-in went with the stack
    expect(
      await fetch(`${told.releases}/a-release/the-archive.zip`).then(
        () => 'answered',
        () => 'nothing there',
      ),
    ).toBe('nothing there')
  })

  test('does not serve an It that set itself up without being given an archive by it, and says what it was asked for', { timeout: 60_000 }, async () => {
    for (const [how, saidOfIt] of [
      ['stops', /asked the stand-in for the backend program’s release for no archive that is in .* \(it asked for nothing\)\./],
      ['fetches another', /\(it asked for \/a-release\/another\.zip, answered 404\)\./],
    ]) {
      const refusedToServe = await startStack(how, { IT_STACK_BACKEND_ARCHIVES: archives }).then(
        () => 'it was served',
        (err) => err.message,
      )
      expect(refusedToServe).toMatch(/^the stack ended before it was ready: /)
      expect(refusedToServe).toMatch(saidOfIt)
    }
  })

  test('does not run a program that does not hold the name of the variable that says where the releases are: it would ask GitHub for the backend program', {
    timeout: 60_000,
  }, async () => {
    // A program that would leave a mark if it were run at all, and that reads no such variable
    const unknowing = path.join(dir, 'it-that-asks-github.mjs')
    const mark = path.join(dir, 'was-run')
    writeFileSync(
      unknowing,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(mark)}, process.argv.slice(2).join(' '))\nconsole.log('{}')\n`,
    )
    const refusedToRun = await startStack('fetches', { IT_STACK_BACKEND_ARCHIVES: archives, IT_CLI: unknowing }).catch((err) => err.message)
    expect(refusedToRun).toMatch(
      /does not take the place its backend program is fetched from out of IT_BACKEND_RELEASES, and would ask GitHub for it\. It is not run\./,
    )
    expect(existsSync(mark)).toBe(false)
  })

  test('does not start when it is told of a program to use as it is as well, or of a folder that is none', { timeout: 60_000 }, async () => {
    const both = await startStack('fetches', { IT_STACK_BACKEND_ARCHIVES: archives, IT_BACKEND_BIN: backendStandIn }).catch((err) => err.message)
    expect(both).toMatch(
      /The stack cannot start: IT_BACKEND_BIN names a backend program to use as it is, and IT_STACK_BACKEND_ARCHIVES a folder to fetch one from\./,
    )
    const noFolder = await startStack('fetches', { IT_STACK_BACKEND_ARCHIVES: path.join(archives, 'the-archive.zip') }).catch((err) => err.message)
    expect(noFolder).toMatch(
      /The stack cannot start: IT_STACK_BACKEND_ARCHIVES names the folder that holds the backend program’s archive, and .* is no folder\./,
    )
  })
})

describe.skipIf(process.platform === 'win32')('stopping the stack', () => {
  test('a service that stops when it is asked ends the stack well, and the stack notes that everything stopped when asked', { timeout: 60_000 }, async () => {
    const stack = await startStack('stops')
    const { service } = stack.note()
    expect(await stop(stack.logs)).toEqual({ status: 0, said: 'the stack has stopped, and everything stopped when it was asked to\n' })
    expect(await stack.ended).toBe(0)
    expect(stack.said()).toMatch(/\nstopped\n$/)
    expect(stack.note()).toMatchObject({ stopped: 'when asked' })
    expect(stack.note().forced).toBeUndefined()
    expect(alive(service)).toBe(false)
  })

  test('a service that has not stopped in the time it is given is made to, which the stack says, notes, and ends as a failure for', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('does not stop')
    const { service } = stack.note()
    const stopped = await stop(stack.logs)
    expect(stopped.status).toBe(1)
    expect(stopped.said).toMatch(
      /^The stack has stopped, and not everything stopped when it was asked to: the service did not stop within 1 seconds of being asked, and was made to \(pid \d+\)\.\n$/,
    )
    expect(await stack.ended).toBe(1)
    expect(stack.said()).toMatch(/the service did not stop within 1 seconds of being asked, and was made to \(pid \d+\)\n/)
    expect(stack.said()).toMatch(/\nstopped, and not everything stopped when it was asked to\n$/)
    expect(stack.note()).toMatchObject({ stopped: 'by force', forced: [expect.stringMatching(/^the service did not stop/)] })
    expect(alive(service)).toBe(false)
  })

  test('a backend program left on the stack’s folder when the service has ended is asked to stop, and that is a failure though it stops', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('leaves a backend program')
    const left = stack.left()
    expect(alive(left)).toBe(true)
    expect((await stop(stack.logs)).status).toBe(1)
    expect(await stack.ended).toBe(1)
    expect(stack.note().forced).toEqual([`a backend program was left running when the service had ended (pid ${left}), and is asked to stop`])
    expect(alive(left)).toBe(false)
  })

  test('and one that does not stop when asked is made to, which is said as well', { timeout: 60_000 }, async () => {
    const stack = await startStack('leaves a backend program that does not hear')
    const left = stack.left()
    expect((await stop(stack.logs)).status).toBe(1)
    expect(await stack.ended).toBe(1)
    expect(stack.note().forced).toEqual([
      `a backend program was left running when the service had ended (pid ${left}), and is asked to stop`,
      `the backend program did not stop when asked, and was made to (pid ${left})`,
    ])
    expect(await until(() => !alive(left))).toBe(true)
  })

  test('a backend program of another folder, which the lock names by a number that has passed to it, is left alone', { timeout: 60_000 }, async () => {
    const stack = await startStack('leaves another folder’s')
    const left = stack.left()
    expect((await stop(stack.logs)).status).toBe(0)
    expect(await stack.ended).toBe(0)
    expect(stack.note()).toMatchObject({ stopped: 'when asked' })
    expect(alive(left)).toBe(true)
  })

  test('asked to, the stack stops the service and starts it again on the same folder, and still ends well', { timeout: 60_000 }, async () => {
    const stack = await startStack('stops')
    const before = stack.note().service
    stack.child.kill('SIGUSR2')
    const after = await until(() => (/\nstarted again\n/.test(stack.said()) && stack.note().service !== before ? stack.note().service : undefined))
    started.push(after)
    expect(after).toEqual(expect.any(Number))
    expect(alive(before)).toBe(false)
    expect((await stop(stack.logs)).status).toBe(0)
    expect(await stack.ended).toBe(0)
  })

  test('a service that had to be made to stop before it was started again fails the stack at its end, however well the next one stops', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('does not stop')
    const before = stack.note().service
    stack.child.kill('SIGUSR2')
    // The service that is started again is the same stand-in, which is asked to stop once more at the end
    started.push(await until(() => (/\nstarted again\n/.test(stack.said()) && stack.note().service !== before ? stack.note().service : undefined)))
    expect(stack.note().forced).toHaveLength(1)
    expect((await stop(stack.logs)).status).toBe(1)
    expect(await stack.ended).toBe(1)
    expect(stack.note().forced).toHaveLength(2)
  })

  test('a stack that went without saying how it stopped did not stop as it does when asked, and where there is no stack that is said', {
    timeout: 60_000,
  }, async () => {
    const stack = await startStack('stops')
    const { service } = stack.note()
    stack.child.kill('SIGKILL')
    await stack.ended
    const stopped = await stop(stack.logs)
    expect(stopped.status).toBe(1)
    expect(stopped.said).toMatch(/^The stack has gone without saying how it stopped, so it did not stop as it does when it is asked\./)
    process.kill(service, 'SIGTERM')
    const nowhere = path.join(dir, 'no-stack')
    mkdirSync(nowhere, { recursive: true })
    const none = await stop(nowhere)
    expect(none.status).toBe(2)
    expect(none.said).toMatch(/^no stack is running: none has noted itself in /)
  })
})
