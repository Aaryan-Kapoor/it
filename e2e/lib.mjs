// What the end-to-end scripts share: where the repository and the running stack are, how the
// `it` command is run as one machine or another, what a run notes of the credentials it holds,
// and the checks of what was reported as usage and of an agent app's add-on.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { accessSync, appendFileSync, constants, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORTS } from '../packages/protocol/src/index.ts'
import { foundNote } from './logs.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = path.join(root, 'packages/cli/dist/it.mjs')
/**
 * How the CLI is started: as the standalone program when IT_BIN names one, and otherwise under
 * Node, from the bundle IT_CLI names or else from the one this repository builds.
 */
export const COMMAND = process.env.IT_BIN ? [process.env.IT_BIN] : [process.execPath, process.env.IT_CLI ?? CLI]
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Asks for something It gives one person only so often, a code above all, and asks again a
 * little later where It says to try again shortly. A run asks for more codes in a minute than a
 * person would, and It lets one more be had every few seconds: so what is asked is asked up to
 * six times, two seconds apart. Whatever else it is answered, or refused with, is passed on.
 */
export async function patiently(asking, { tries = 6, wait = 2000 } = {}) {
  for (let n = 1; ; n++) {
    const got = await asking().then(
      (value) => ({ value }),
      (err) => ({ err }),
    )
    const toldToWait = (got.err ?? got.value)?.code === 'rate_limited'
    if (toldToWait && n < tries) await sleep(wait)
    else if (got.err) throw got.err
    else return got.value
  }
}

/** What the end-to-end suite puts in the payloads, state, names and titles it sends, so that a log that repeats them is caught. */
export const PRIVATE_MARK = 'e2e-private-'

// ---------- the stack ----------

/** Where the stack (e2e/stack.mjs) keeps its log, and beside it the note of where it is itself. */
export const STACK_LOGS = process.env.IT_STACK_LOGS ?? '/tmp/it-e2e'
export const stackNote = () => path.join(STACK_LOGS, 'stack.json')
/** What the stack names the machine It runs on: as a person would name it, with the mark that the check of the logs looks for. */
export const STACK_MACHINE = `e2e laptop ${PRIVATE_MARK}stack`
/** The port a stack counts from when IT_PORT names none: well clear of the one a person's own It uses, so that the two can run side by side. */
export const STACK_PORT = PORTS.base + 1000

/**
 * Everything that follows from the folder a stack's It lives in and the port it counts from:
 * the site as a person opens it, and the backend's own two addresses, which only this machine
 * can reach. Where a page is shown is not among them: that is read off the frame it is shown in.
 */
export const whereabouts = (noted) => ({
  ...noted,
  site: `http://localhost:${noted.port}`,
  api: `http://127.0.0.1:${noted.port + PORTS.backendApi}`,
  http: `http://127.0.0.1:${noted.port + PORTS.backendSite}`,
})

/** The stack that is running, as it noted itself when it started: null when none has. */
export function stack(file = stackNote()) {
  try {
    const noted = JSON.parse(readFileSync(file, 'utf8'))
    return typeof noted.home === 'string' && Number.isInteger(noted.port) ? whereabouts(noted) : null
  } catch {
    return null
  }
}
/** The stack these scripts speak to: the one that was running when the script began. */
export const STACK = stack()

/** What to tell whoever started a script that needs a stack when none is running: where one was looked for, and how to start one. */
export const noStack = (file = stackNote()) =>
  `no stack is running: none has noted itself in ${file}. Start one with \`node e2e/stack.mjs\`, with IT_STACK_LOGS set as it is here, and wait for it with \`node e2e/ready.mjs\`.`
/** Stops a script that needs a stack when none is running, with that sentence and nothing else. */
export function needsStack(what) {
  if (STACK) return STACK
  console.error(`${what} cannot start: ${noStack()}`)
  process.exit(2)
}

// ---------- what a run holds ----------

// What this run holds that is a credential and that nothing else knows: the keys in It's
// settings, a machine's key, a connector's token, a code that pairs a browser, a browser's
// session. Each is noted the moment it exists, in this process and, where IT_E2E_INVENTORY names
// a file, there too: the check of what the run wrote down is made again by another program
// afterwards (CI's own step), and must look for the very same things. The file is kept outside
// what is uploaded.
const noted = new Map()
/** The ones that have been written to the file as well. */
const written = new Set()
export function noteSecret(what, value) {
  if (typeof value !== 'string' || value.length < 12) return
  // Known to this program from this moment, each one once, whatever becomes of the writing:
  // what it prints is cleaned of it, and its own check looks for it
  if (![...noted.values()].includes(value)) noted.set(`${what} (${noted.size + 1})`, value)
  if (!process.env.IT_E2E_INVENTORY || written.has(value)) return
  // Counted as written only once it is: if the writing fails, the next noting of the same
  // value tries again, and is not passed over as already done.
  // Not caught: a credential the later check is not told about is one it cannot look for, and
  // a run that could not note one must not go on as if it had
  appendFileSync(process.env.IT_E2E_INVENTORY, `${JSON.stringify({ what, value })}\n`, { mode: 0o600 })
  written.add(value)
}
export const notedSecrets = () => Object.fromEntries(noted)

const unnoted = []
/**
 * Notes a credential from where a failure can stop nothing: what a browser was answered, a
 * timer. One that could not be written down is remembered here by its kind, and the run fails
 * on it at its end (`couldNotNote`).
 */
export function noteWhenSeen(what, value) {
  try {
    noteSecret(what, value)
  } catch {
    if (!unnoted.includes(what)) unnoted.push(what)
  }
}
export const couldNotNote = () => [...unnoted]

/** What has been said of findings so far, each line once however often the same finding is told of. */
const found = new Set()
/**
 * Says that a run found something that nothing written down may hold, in a place where no
 * file will show it again. What a browser's console was given is such a place: it is cleaned
 * before it is kept, so whoever reads the kept files afterwards cannot find it a second time.
 * Where IT_E2E_INVENTORY names a file, the finding is added to the note beside it that the scan
 * keeps (`foundNote`, e2e/logs.mjs), which is where the scan that is made afterwards looks before
 * it vouches for anything: found once is found. What is written is where it was found, each kind of thing, and how often: never
 * anything of what was found. A finding that could not be noted fails the run at its end,
 * as a credential that could not be noted does.
 */
export function noteFound(where, kinds) {
  const note = foundNote()
  if (!kinds.length || note === null) return
  const lines = [...new Set(kinds)].map((kind) => `${where} held ${kind} (${kinds.filter((one) => one === kind).length})`).filter((line) => !found.has(line))
  if (!lines.length) return
  try {
    appendFileSync(note, `${lines.join('\n')}\n`, { mode: 0o600 })
    for (const line of lines) found.add(line)
  } catch {
    if (!unnoted.includes('what a browser’s console held')) unnoted.push('what a browser’s console held')
  }
}

const kept = (home, name) => {
  try {
    return JSON.parse(readFileSync(path.join(home, name), 'utf8'))
  } catch {
    return undefined
  }
}
/** The token of the connector whose folder this is, once it has written one down. */
export function connectorTokenIn(home) {
  const token = kept(home, 'connector.json')?.token
  return typeof token === 'string' && token ? token : undefined
}
/** Notes the token of the connector whose folder this is. False while it has not written one down. */
export function noteConnector(home) {
  const token = connectorTokenIn(home)
  noteSecret('a connector’s token', token)
  return token !== undefined
}
/**
 * Every credential one of It's folders holds as it stands, each by its kind: the three keys in
 * It's settings on the machine It runs on, the machine's own key, the token it last earned, its
 * connector's token, and the key its notifications are signed with. A file that is not there
 * yet holds nothing, and the folder is read again later.
 */
export const secretsIn = (home) =>
  [
    ['the secret It’s backend makes its keys from', kept(home, 'service.json')?.instanceSecret],
    ['the backend’s admin key', kept(home, 'service.json')?.adminKey],
    ['the secret a showing’s session is sealed with', kept(home, 'service.json')?.sessionSecret],
    ['a machine’s key', kept(home, 'machine.json')?.key?.d],
    ['a machine’s token', kept(home, 'token.json')?.token],
    ['a connector’s token', connectorTokenIn(home)],
    ['the key notifications are signed with', kept(home, 'push.json')?.privateKey],
  ].filter(([, value]) => typeof value === 'string' && value)
/** Notes every credential one of It's folders holds. `note` is `noteSecret`, or `noteWhenSeen` where a failure can stop nothing. */
export function noteHome(home, note = noteSecret) {
  for (const [what, value] of secretsIn(home)) note(what, value)
}

// ---------- usage reporting ----------

/**
 * Where the programs a run starts send their usage counts: a stand-in on this machine when the
 * run has started one, and otherwise an address where nothing listens. Never the real one.
 */
export const usageUrl = () => process.env.IT_E2E_USAGE_URL ?? 'http://127.0.0.1:9/usage'

/**
 * Whether a program holds a name anywhere in it, read as the bytes it is: a bundle is text, and
 * the standalone program carries the same text inside it. A program that does not hold the name
 * of a variable does not read that variable.
 */
export function holdsTheName(program, name) {
  try {
    return readFileSync(program).includes(Buffer.from(name))
  } catch {
    return false
  }
}

/**
 * A stand-in, on this machine, for the release the backend program is fetched from. It is laid
 * out as that release is: `<address>/<a release's name>/<an archive's name>` gives the archive
 * of that name from the folder, whatever the release is called, and every other address gives
 * nothing. So It, told that its backend program's releases are here, fetches the program as it
 * does on a machine it has never run on, and nothing is asked of any other machine. The
 * archive has to be the one the release publishes: It keeps nothing whose checksum is not the
 * one it expects. `asked` holds each path that was asked for with the status it was answered.
 */
export function backendRelease(folder) {
  const asked = []
  const server = http.createServer((req, res) => {
    const answer = (status) => {
      asked.push({ path: req.url, status })
      return status
    }
    const [, name] = /^\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+)$/.exec(req.url ?? '') ?? []
    const file = name && !name.startsWith('.') ? statSync(path.join(folder, name), { throwIfNoEntry: false }) : undefined
    if (req.method !== 'GET' || !file?.isFile()) return res.writeHead(answer(req.method === 'GET' ? 404 : 405)).end()
    res.writeHead(answer(200), { 'content-type': 'application/zip', 'content-length': file.size })
    createReadStream(path.join(folder, name))
      .on('error', () => res.destroy())
      .pipe(res)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        asked,
        close: () => {
          server.closeAllConnections()
          return new Promise((done) => server.close(done))
        },
      }),
    ),
  )
}

/**
 * A stand-in for where usage counts are sent. Everything it is sent is written to `file` as it
 * arrived, whether or not it can be read, for the check of what a run wrote down: the address
 * asked for and every header as well as what was carried, since any of them can say something.
 * What can be read is kept in `batches`, what cannot in `unreadable`, and how each was asked
 * for in `requests`.
 */
export function usageReceiver(file) {
  const batches = []
  const unreadable = []
  const requests = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => {
      // Kept first, as it came: something sent that is not a batch is still something that was sent
      appendFileSync(file, `${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${text}\n`)
      requests.push({ method: req.method, address: req.url, headers: req.headers })
      try {
        batches.push(JSON.parse(text))
      } catch {
        unreadable.push(text)
      }
      res.writeHead(204).end()
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/usage`,
        host: `127.0.0.1:${server.address().port}`,
        batches,
        unreadable,
        requests,
        // Closed with the run, so that a run that has finished can end
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  )
}

/**
 * Leaves in a test machine's folder what the install script leaves: the note that the person
 * was told about usage reporting. A program nobody is watching says nothing and counts nothing
 * until someone has been told, and these machines are installed by no script.
 */
export function toldAboutUsage(home) {
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, 'telemetry.json'), `{"told": ${Date.now()}}\n`, { mode: 0o600 })
}

/** Everything a usage event may be, said again here and not read from the program: a check of its own. */
export const USAGE_MAY_BE = {
  'service.started': {
    version: /^\d+\.\d+\.\d+$/,
    os: ['linux', 'macos', 'windows', 'other'],
    arch: ['x64', 'arm64', 'other'],
    installed: ['script', 'source', 'other'],
  },
  'page.published': {
    agent: ['claude-code', 'codex', 'openclaw', 'hermes', 'opencode', 'pi', 'other', 'unknown'],
    change: ['new', 'update'],
    kind: ['custom'],
    size: ['under 10 KB', '10 to 100 KB', '100 KB to 1 MB', '1 to 10 MB', 'over 10 MB'],
  },
  'answer.delivered': {
    path: ['heard', 'woke', 'waited'],
    after: ['under 1 second', '1 to 10 seconds', '10 to 60 seconds', '1 to 10 minutes', '10 to 60 minutes', '1 to 24 hours', 'over 24 hours'],
    agent: ['claude-code', 'codex', 'openclaw', 'hermes', 'opencode', 'pi', 'other', 'unknown'],
  },
  'agent.woken': { result: ['resumed', 'declined', 'failed'], agent: ['claude-code', 'codex', 'openclaw', 'hermes', 'opencode', 'pi', 'other', 'unknown'] },
}
/** Whether this is an object with fields of its own and nothing behind them: not a list, not nothing, and made by no class. */
const plain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const fields = (v) => Object.keys(v).sort().join()
/** Whether this is text of the given shape. Asked of the kind of thing first: a list of one text reads as that text to a pattern. */
const shaped = (v, shape) => typeof v === 'string' && shape.test(v)
/** What is wrong with a batch, if anything: null when it is exactly what the page about usage reporting says a batch is. */
export function wrongWithBatch(batch) {
  if (!plain(batch)) return 'it is not an object'
  if (fields(batch) !== 'events,installation,v') return `its fields are ${fields(batch)}`
  if (batch.v !== 1 || !shaped(batch.installation, /^[0-9a-f]{64}$/)) return 'its version or its installation is not as it should be'
  if (!Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 20) return 'it does not hold between one and twenty events'
  for (const e of batch.events) {
    if (!plain(e)) return 'an event is not an object'
    if (fields(e) !== 'at,id,name,properties') return `an event's fields are ${fields(e)}`
    if (!shaped(e.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)) return 'an event’s id is not a random id of its own'
    if (!shaped(e.at, /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/)) return 'an event’s time is finer than the hour'
    // Only a name the list itself holds. Every object answers to "constructor" and the like as
    // well, and those are no events
    const may = typeof e.name === 'string' && Object.hasOwn(USAGE_MAY_BE, e.name) ? USAGE_MAY_BE[e.name] : null
    if (!may) return `there is no event called ${String(e.name).slice(0, 30)}`
    if (!plain(e.properties)) return `${e.name} has properties that are not an object`
    if (fields(e.properties) !== fields(may)) return `${e.name} has the properties ${fields(e.properties)}`
    for (const [k, v] of Object.entries(e.properties))
      if (typeof v !== 'string' || !(may[k] instanceof RegExp ? may[k].test(v) : may[k].includes(v))) return `${e.name}.${k} is not one of the values it may be`
  }
  return null
}

// The headers a request for usage may carry, and what each may say. Two are It's own: what kind
// of thing is sent, and that it is It, at which version. The rest are what Node's and Bun's own
// way of sending adds to every request, each of which says one fixed thing.
const USAGE_HEADERS = {
  'content-type': /^application\/json$/,
  'user-agent': /^it\/\d+\.\d+\.\d+$/,
  'content-length': /^\d+$/,
  connection: /^(keep-alive|close)$/,
  accept: /^\*\/\*$/,
  'accept-language': /^\*$/,
  'accept-encoding': /^(gzip|deflate|br|zstd)(, (gzip|deflate|br|zstd))*$/,
  'sec-fetch-mode': /^cors$/,
}
/** What is wrong with how a batch was sent, if anything: it is posted to the one address, with nothing after it, and its headers say nothing of their own. */
export function wrongWithRequest(request, host) {
  if (request.method !== 'POST') return `it was sent with ${String(request.method).slice(0, 10)}`
  if (request.address !== '/usage') return 'it was sent to an address that says more than /usage'
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' ? value !== host : !Object.hasOwn(USAGE_HEADERS, name)) return `it carried a ${name.slice(0, 30)} header that is not one it may carry`
    if (name !== 'host' && !shaped(value, USAGE_HEADERS[name])) return `its ${name} header says something it may not`
  }
  for (const needed of ['content-type', 'user-agent']) if (!Object.hasOwn(request.headers, needed)) return `it had no ${needed} header`
  return null
}
/** Everything wrong with what a stand-in for usage reporting was sent. Nothing, when every request was sent as one may be and carried a batch that is what a batch may be. */
export function wrongWithUsage(received) {
  return [
    ...received.requests.map((r) => wrongWithRequest(r, received.host)),
    ...received.batches.map(wrongWithBatch),
    ...received.unreadable.map(() => 'something was sent that is not a batch'),
  ].filter(Boolean)
}

// ---------- the agent apps ----------

/**
 * What the CLI and the agent apps it asks are started with: everything this program has, except
 * what would point them at another installation of It or at the conversation of an agent that
 * this program may itself be running inside.
 */
export const surroundings = (from = process.env) =>
  Object.fromEntries(Object.entries(from).filter(([k]) => !/^(CLAUDE|CODEX|IT_|PI_SESSION|HERMES_SESSION|OPENCLAW_SESSION|OPENCODE_SESSION)/.test(k)))

/**
 * Made-up folders for Claude Code and Codex to keep their settings in. A program given these
 * reads and writes nothing of the settings of whoever runs the suite, whatever it asks of those
 * apps. The runs that drive a real agent app are not given them: they need the person's own.
 */
export const madeUpApps = (folder) => ({ CLAUDE_CONFIG_DIR: path.join(folder, 'claude'), CODEX_HOME: path.join(folder, 'codex') })

/** The command each of the two agent apps is run by, and so the names a stand-in is put under. */
const APP_COMMANDS = ['claude', 'codex']
/** Every name a folder may hold an app's command under: the command itself and, on Windows, the kinds of file a command may be there. */
const namesOf = (command) => (process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']).map((kind) => command + kind)
/**
 * The one program behind both stand-ins. It notes how it was called, in `calls.jsonl` beside
 * it, and touches nothing outside the made-up folders.
 *
 * As Claude Code it fails whatever it is asked, as an app that cannot be run does. As Codex it
 * is a Codex new enough for It, which keeps what it is given of add-ons in its made-up settings
 * folder: a place that was added and an add-on added from it are listed as Codex lists them,
 * until they are removed. Anything else it is asked, `queue` among it, it takes and does
 * nothing with.
 *
 * Where E2E_APPS_HOLD names a file, either stand-in waits for as long as that file is there
 * before it answers, and for half a minute at most: a program that asks an app something is
 * kept at that step for as long as a test needs it there.
 */
const STAND_IN = String.raw`import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [app, ...args] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ app, args }) + '\n')
const hold = process.env.E2E_APPS_HOLD
for (let waited = 0; hold && waited < 600 && existsSync(hold); waited++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
if (app !== 'codex') process.exit(1)
if (args[0] === '--version') console.log('codex-cli 0.160.0')
if (args[0] !== 'plugin') process.exit(0)
const kept = path.join(process.env.CODEX_HOME ?? here, 'stand-in.json')
let has = { from: null, added: false }
try {
  has = JSON.parse(readFileSync(kept, 'utf8'))
} catch {}
const keep = (next) => {
  mkdirSync(path.dirname(kept), { recursive: true })
  writeFileSync(kept, JSON.stringify(next))
}
const [, what, how, where] = args
if (what === 'marketplace' && how === 'add') keep({ from: where, added: false })
else if (what === 'marketplace' && how === 'remove') keep({ from: null, added: false })
else if (what === 'add' && !has.from) process.exit(1)
else if (what === 'add') keep({ ...has, added: true })
else if (what === 'remove') keep({ ...has, added: false })
else if (what === 'list') console.log(has.from ? 'it-bridge@it  ' + (has.added ? 'installed, enabled' : 'not installed') + '  0.1.0  ' + has.from : 'No plugins.')
`
/** A word as a shell takes it for one word, whatever is in it. */
const quoted = (word) => `'${word.replaceAll("'", `'\\''`)}'`
const standing = new Set()
/**
 * Stand-ins for the two agent apps' own commands, in a folder of their own inside the made-up
 * one, and the folder they are in. Whatever a run starts finds these where it looks for Claude
 * Code or Codex, so the apps of whoever runs the suite are never run. They are written once
 * for each made-up folder, and a folder they cannot be run from stops the run before anything
 * is started.
 */
export function standInApps(folder) {
  const bin = path.join(folder, 'bin')
  if (standing.has(bin)) return bin
  mkdirSync(bin, { recursive: true })
  const program = path.join(bin, 'stand-in.mjs')
  writeFileSync(program, STAND_IN)
  for (const command of APP_COMMANDS) {
    // Started by this Node at its own address, so that nothing is looked for by name to run a stand-in
    if (process.platform === 'win32') writeFileSync(path.join(bin, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "${program}" ${command} %*\r\n`)
    else {
      writeFileSync(path.join(bin, command), `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(program)} ${command} "$@"\n`, { mode: 0o755 })
      accessSync(path.join(bin, command), constants.X_OK)
    }
  }
  standing.add(bin)
  return bin
}
/** How each stand-in has been called so far, in the order it was: which app's it was, and with which words. */
export function appCalls(folder = process.env.IT_E2E_APPS) {
  const file = path.join(folder, 'bin', 'calls.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
/** Whether a folder holds either agent app's command under any name it may have. */
const holdsAnApp = (dir) => APP_COMMANDS.some((command) => namesOf(command).some((name) => existsSync(path.join(dir, name))))
/**
 * The folders programs are looked for in, as everything a run starts is given them: the
 * stand-ins' first, and then each folder this program was given that holds neither agent app.
 * A folder that holds one is left out whole, so that the app itself could not be found even
 * were its stand-in gone. So is one that is not written from the root, which a program would
 * read from wherever it happened to be.
 */
export const pathWithStandIns = (folder, given = process.env.PATH ?? '') =>
  [standInApps(folder), ...given.split(path.delimiter).filter((dir) => path.isAbsolute(dir) && !holdsAnApp(dir))].join(path.delimiter)
/**
 * Where a program given these surroundings finds each agent app's command, looked for as the
 * system looks: in each folder of its PATH in turn. For each command, every place it is found
 * at, the one a program would run first.
 */
export function appsFoundBy(env) {
  const dirs = (env[pathName(env)] ?? '').split(path.delimiter)
  return Object.fromEntries(
    APP_COMMANDS.map((command) => [
      command,
      dirs.flatMap((dir) =>
        namesOf(command)
          .map((name) => path.join(dir, name))
          .filter((file) => existsSync(file)),
      ),
    ]),
  )
}
/**
 * What is wrong with where a program given these surroundings would find the agent apps, in a
 * sentence, and nothing when each app's command is found in one place, which is its stand-in
 * in the made-up folder. The sentence names the command and no folder.
 */
export function reachesAnApp(env, folder = process.env.IT_E2E_APPS) {
  const standIns = folder ? path.join(folder, 'bin') : null
  for (const [command, places] of Object.entries(appsFoundBy(env))) {
    if (!places.some((file) => path.dirname(file) === standIns)) return `a program given these surroundings would find no stand-in for \`${command}\``
    if (places.some((file) => path.dirname(file) !== standIns))
      return `a program given these surroundings could find \`${command}\` itself, in a folder that is not the stand-ins’`
  }
  return null
}
/** The name the folders programs are looked for in go by in these surroundings: Windows may write it in other letters. */
const pathName = (env) => Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'

/** Asks an agent app something with its own command, in the surroundings the CLI is given, so that both speak of the same installation. */
const askApp = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { env: surroundings(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) =>
      resolve({ ok: !err, out: String(out ?? '') }),
    ),
  )
/**
 * What a listing by Codex says of It's add-on. Codex lists what a place offers as well as what
 * is installed from it, so an add-on that is merely on offer ("not installed") is not in Codex,
 * and one named in any other way is. Where the add-on is not named, it is absent only if what
 * Codex printed is a listing: rows of other add-ons, or its sentence that there are none.
 * Anything else is an answer this cannot read, and says nothing either way.
 */
const inCodexListing = (out) => {
  const ours = out.split('\n').filter((line) => /\bit-bridge\b/.test(line))
  if (ours.length) return ours.some((line) => !/not installed/.test(line)) ? 'present' : 'absent'
  return /^No plugins\b/m.test(out) || /^\S+@\S+\s+\S/m.test(out) ? 'absent' : 'unknown'
}
/**
 * Whether It's add-on is in an agent app at all, switched on or off, asked of the app itself:
 * 'present', 'absent', or 'unknown' when the app could not be asked or its answer could not be
 * read. `it status` cannot say: to it an add-on that is switched off, one that is not there and
 * an app that would not answer are all not connected.
 */
export async function addonIn(app, ask = askApp) {
  if (app === 'claude-code') {
    const listed = await ask('claude', ['plugin', 'list', '--json'])
    if (!listed.ok) return 'unknown'
    try {
      const plugins = JSON.parse(listed.out)
      if (!Array.isArray(plugins)) return 'unknown'
      return plugins.some((p) => p?.id === 'it-bridge@it') ? 'present' : 'absent'
    } catch {
      return 'unknown'
    }
  }
  if (app === 'codex') {
    const ofOurs = await ask('codex', ['plugin', 'list', '--marketplace', 'it'])
    if (ofOurs.ok) return inCodexListing(ofOurs.out)
    // It may not know that place at all. Then everything it has is looked through
    const ofAll = await ask('codex', ['plugin', 'list'])
    return ofAll.ok ? inCodexListing(ofAll.out) : 'unknown'
  }
  return 'unknown'
}
/**
 * Why a run that installs It's add-on into an agent app, and removes it again at its end, is
 * not to be started on this machine; null when it may be. `status` is what `it status` says of
 * the app, which is nothing when it did not find it, and `inApp` what the app itself says of
 * the add-on (`addonIn`). Only an app that is known not to have the add-on is installed into:
 * one that has it in any state would have it replaced and then taken away.
 */
export function whyNotInstall(label, status, inApp) {
  if (!status) return `${label} was not found on this machine, so this run has nothing to drive and has not been started.`
  const said = status.detail ? ` (${status.detail})` : ''
  if (status.addon === 'too_old') return `This machine’s ${label} is too old for It’s add-on${said}, so this run has not been started.`
  if (status.addon === 'unavailable') return `This build of It has no add-on for ${label}${said}, so this run has not been started.`
  const replaced = 'This run would replace it and then remove it, so it has not been started.'
  if (status.addon === 'connected' || status.addon === 'needs_approval') return `This machine’s ${label} already has It’s add-on. ${replaced}`
  if (status.addon !== 'not_connected')
    return `It says of this machine’s ${label} only “${String(status.addon).slice(0, 40)}”${said}, so this run has not been started.`
  if (inApp === 'present') return `This machine’s ${label} already has It’s add-on, switched off. ${replaced}`
  if (inApp !== 'absent')
    return `This machine’s ${label} could not be asked whether it already has It’s add-on. This run would replace one that is there and then remove it, so it has not been started.`
  return null
}

/** Each agent app's own commands for taking It's add-on out: the add-on first, and then the place it was offered from. */
const TAKE_OUT = {
  'claude-code': {
    label: 'Claude Code',
    cmd: 'claude',
    steps: [
      ['plugin', 'uninstall', 'it-bridge@it'],
      ['plugin', 'marketplace', 'remove', 'it'],
    ],
  },
  codex: {
    label: 'Codex',
    cmd: 'codex',
    steps: [
      ['plugin', 'remove', 'it-bridge@it'],
      ['plugin', 'marketplace', 'remove', 'it'],
    ],
  },
}
/**
 * Takes It's add-on out of an agent app at the end of a run that put it there, and says
 * whether it is out, which only the app itself can say. `it setup --none` is asked first, as
 * that is what the run is testing. It puts the machine right before it tells the backend, and
 * fails when the backend cannot be told; then, or when the app still has the add-on, the app's
 * own commands are asked. Only a run that put the add-on in may call this: asked of an app that
 * had one before, it would take away the person's own.
 *
 * `setup` is what `it setup --none` answered, or the error it ended with; `out` is whether the
 * app now says it has no add-on; and `left`, when it is not out, says what is still on this
 * machine and how to remove it. The run's It folder holds the note of what was put where, and
 * is the folder that `it setup --none` must be run with again: a run keeps it until `out`.
 */
export async function takeOut(app, home, { run = it, ask = askApp } = {}) {
  const how = TAKE_OUT[app]
  const setup = await run(home, ['setup', '--none', '--no-service']).catch((e) => ({ error: e.message }))
  let inApp = await addonIn(app, ask)
  if (inApp !== 'absent') {
    for (const step of how.steps) await ask(how.cmd, step)
    inApp = await addonIn(app, ask)
  }
  if (inApp === 'absent') return { setup, out: true, left: null }
  const own = how.steps.map((step) => `\`${how.cmd} ${step.join(' ')}\``).join(' and then ')
  return {
    setup,
    out: false,
    left: [
      `It’s add-on ${inApp === 'present' ? 'is still in' : 'may still be in'} this machine’s ${how.label}, where this run put it, and the run could not take it out.`,
      `The run’s It folder has been kept, still one of the test stack’s machines, because it holds the note of what was put where: ${home}`,
      `To take the add-on out, run \`IT_HOME='${home}' ${COMMAND.join(' ')} setup --none --no-service\`, or ask ${how.label} itself with ${own}.`,
      `Then ask it whether the add-on has gone, with \`${how.cmd} plugin list\`, and remove ${home}.`,
    ].join('\n'),
  }
}

// ---------- programs a run starts ----------

/**
 * Stops a program a run started and waits until it has gone: asked first, and made to when it
 * has not gone within `ms`. Resolves at once for one that was never started or has already
 * ended. What a program wrote is read, and its files removed, only after this.
 */
export function stopped(child, ms = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const made = setTimeout(() => child.kill('SIGKILL'), ms)
    // One that could not be started at all never closes
    const never = setTimeout(resolve, ms + 4000)
    child.once('close', () => {
      clearTimeout(made)
      clearTimeout(never)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/**
 * What every program of It's that a run starts is given: the surroundings, with nothing of the
 * person's own It, the two agent apps it may look for, and where its usage counts go. The
 * backend program is the one this process was told to use, when it was told, and is fetched
 * from where this process was told its releases are, when it was told that. Where
 * IT_E2E_APPS names a folder, the agent apps' settings are looked for there and nowhere else,
 * and the apps themselves are stand-ins in it: no program given this can find, and so run,
 * the Claude Code or the Codex of whoever runs the suite.
 * Nothing says where It is: the machine It runs on finds it in its own folder, and a machine
 * that joined finds there the door it joined at.
 */
export function itEnv(home) {
  const given = surroundings()
  const apps = process.env.IT_E2E_APPS
  return {
    ...given,
    IT_HOME: home,
    ...(process.env.IT_BACKEND_BIN ? { IT_BACKEND_BIN: process.env.IT_BACKEND_BIN } : {}),
    ...(process.env.IT_BACKEND_RELEASES ? { IT_BACKEND_RELEASES: process.env.IT_BACKEND_RELEASES } : {}),
    ...(apps ? { ...madeUpApps(apps), [pathName(given)]: pathWithStandIns(apps, given[pathName(given)]) } : {}),
    IT_HARNESSES: 'claude-code,codex',
    IT_TELEMETRY_URL: usageUrl(),
    // The T3 Code of whoever runs this is nothing to an It that a run starts: it would be asked for a session and for its threads
    T3CODE_HOME: path.join(home, 'no-t3-code'),
  }
}

/** A code that pairs a browser, where an address carries one: `it site` answers with such an address. */
const PAIRS = /\/pair#([a-z2-7]{8,64})/g

let unkept = 0
/** How many times what the CLI printed could not be kept where the run's check of what it wrote down reads it. */
export const couldNotKeep = () => unkept

/**
 * Runs the CLI as one machine (its own IT_HOME). Resolves with its parsed output. What it
 * printed is kept where IT_E2E_SAID says. A code that pairs a browser is a credential: it is
 * noted as one, and is taken out of what is kept. `onStart` is given the program as soon as it
 * has been started, for whoever means to end it before it is done.
 */
export function it(home, args, { input, extraEnv = {}, onStderr, onStart, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(COMMAND[0], [...COMMAND.slice(1), ...args], {
      env: { ...itEnv(home), ...extraEnv },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    onStart?.(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => {
      err += d
      onStderr?.(String(d), child)
    })
    if (input !== undefined) child.stdin.end(input)
    child.on('error', reject)
    child.on('close', (code) => {
      for (const [, pairs] of `${out}\n${err}`.matchAll(PAIRS)) noteWhenSeen('a code that pairs a browser', pairs)
      // Everything the program printed is kept where the run's log check reads it: what it
      // said to the person in one file, what it answered in another
      if (process.env.IT_E2E_SAID) {
        const cleaned = (text) => text.replace(PAIRS, '/pair#[a code that pairs a browser]')
        try {
          if (err) appendFileSync(path.join(process.env.IT_E2E_SAID, 'cli.said.log'), `$ it ${args[0]}\n${cleaned(err)}\n`)
          if (out) appendFileSync(path.join(process.env.IT_E2E_SAID, 'cli.answers.txt'), `$ it ${args[0]}\n${cleaned(out)}\n`)
        } catch {
          // The command itself is not failed by this, and the run is: what could not be kept
          // was never read by the check of what the run wrote down
          unkept += 1
        }
      }
      if (raw) return resolve({ code, out, err })
      if (code !== 0) {
        let parsed
        try {
          parsed = JSON.parse(err.trim().split('\n').pop())
        } catch {}
        // What the program printed is kept on the error for whoever asks for it, and is not one
        // of the things printed with an error that nothing caught
        const failed = Object.assign(new Error(parsed?.error?.message ?? `it ${args[0]} exited ${code}`), { code: parsed?.error?.code, exit: code })
        Object.defineProperty(failed, 'stderr', { value: err, enumerable: false })
        return reject(failed)
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve(out)
      }
    })
  })
}

// ---------- a backend program that was left running ----------

/** Whether a program is running, by its number. */
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/**
 * Whether a program, by its number, is the backend program of a folder of It's: one that is
 * running, that the system shows to be the backend program, and that was started with that
 * folder as where its data is. A number may since have been given to another program, and to
 * another folder's backend program among them, and neither is this folder's.
 */
export function isBackendOn(home, program) {
  if (!Number.isInteger(program) || program <= 1 || !running(program)) return false
  let command = ''
  try {
    command = execFileSync('ps', ['-ww', '-p', String(program), '-o', 'command='], { encoding: 'utf8' })
  } catch {}
  return command.includes('convex-local-backend') && command.includes(path.join(home, 'backend'))
}
/** The backend program that is running on a folder of It's, if one is: the program the folder's lock names, where it is that folder's backend program. */
export function backendLeftOn(home) {
  let program
  try {
    program = JSON.parse(readFileSync(path.join(home, 'backend', 'lock'), 'utf8')).program
  } catch {}
  return isBackendOn(home, program) ? program : undefined
}

// ---------- the backend, asked directly ----------

/**
 * The token a machine's key earns it, good for a few minutes: the machine is asked something,
 * which leaves the token it was given in its folder. It is one of the credentials a run holds.
 */
export async function machineToken(home, { run = it } = {}) {
  await run(home, ['whoami'])
  const token = kept(home, 'token.json')?.token
  if (typeof token !== 'string' || !token) throw new Error('the machine kept no token')
  noteSecret('a machine’s token', token)
  return token
}

/**
 * Asks the backend to run one of It's functions, at its own address and not through the door,
 * as whoever the token says, or as nobody. Answers with what the function returned, or with
 * the code it refused with: `{ ok: true, value }` or `{ ok: false, code }`.
 */
export async function ask(kind, name, args = {}, token = undefined, at = STACK?.api) {
  const answered = await fetch(`${at}/api/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path: name, args, format: 'json' }),
    signal: AbortSignal.timeout(20_000),
  })
  const said = await answered.json().catch(() => null)
  if (answered.ok && said?.status === 'success') return { ok: true, value: said.value }
  // A refusal of It's own carries its code. Anything else is the backend's, and is told apart by the status it answered with
  return { ok: false, code: said?.errorData?.code ?? said?.code ?? `status ${answered.status}` }
}
