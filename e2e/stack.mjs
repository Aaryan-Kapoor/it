// Runs It on this machine the way a person's machine runs it, and nothing else: a fresh folder
// for It to live in, `it setup --none --no-service`, which makes its settings and enrols this
// machine and puts an add-on in no agent app, and then `it serve`. Where It looks for Claude Code
// or Codex it finds a stand-in, and never the app itself. Stop it with Ctrl-C, or with
// `node e2e/stop.mjs`, which waits for it and says how it stopped.
//
//   node e2e/stack.mjs
//
// Stopping asks the service to stop, as a person stops it, and waits. It, in its turn, never
// kills its backend program. This script is a test's tidying up and is not held to that: a
// service that has not stopped a minute after it was asked is made to, and so is a backend
// program left behind on this stack's folder, so that a run leaves nothing running. It never
// passes that over. Each time it happens it says so, notes it in stack.json, and ends as a
// failure: a run in which It did not stop when it was asked is not one that passed.
// IT_STACK_STOP_SECONDS says how long the wait is, where a minute is not what is wanted.
//
// IT_PORT names the port everything is counted from, and IT_HOME the folder, which must be a
// fresh one outside where the logs are kept; without them the stack picks a port clear of a
// person's own It and makes a folder of its own. IT_STACK_LOGS says where its log is kept.
// IT_BIN names the standalone program to run and IT_CLI a bundle; without either, the bundle
// is built here first. IT_BACKEND_BIN names a backend program to use as it is; without it It
// fetches the program itself the first time it is set up, from its release on GitHub.
// IT_STACK_BACKEND_ARCHIVES names a folder that holds the archive of the backend program for
// this system, as that release publishes it. The stack then stands in for the release on this
// machine and tells It that its releases are there, so that a first run that fetches the
// program can be made with nothing asked of any other machine. A program that does not take
// that address from IT_BACKEND_RELEASES would pass the stand-in by and ask GitHub, so one that
// does not hold the variable's name is not run at all; and an It that set itself up without
// asking the stand-in for anything is not served: it took the program from elsewhere.
//
// It notes where it is in stack.json beside its log, for the scripts that use it. Sent SIGUSR2,
// it stops the service and starts it again on the same folder, which is how a run sees that It
// keeps what it holds.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  backendLeftOn,
  backendRelease,
  COMMAND,
  couldNotNote,
  holdsTheName,
  it,
  itEnv,
  noteHome,
  noteWhenSeen,
  reachesAnApp,
  root,
  STACK_LOGS,
  STACK_MACHINE,
  STACK_PORT,
  sleep,
  stackNote,
  whereabouts,
} from './lib.mjs'
import { redact } from './logs.mjs'

/** Said in one sentence before anything has been started, and the stack does not start. */
const cannot = (why) => {
  console.error(`The stack cannot start: ${why}`)
  process.exit(1)
}

const logs = STACK_LOGS
mkdirSync(logs, { recursive: true })
// The note an earlier stack left says where that one was, and this one is not there
rmSync(stackNote(), { force: true })

const port = process.env.IT_PORT ? Number(process.env.IT_PORT) : STACK_PORT
if (!Number.isInteger(port) || port < 1 || port > 65_000) cannot(`IT_PORT is the port everything is counted from, and "${process.env.IT_PORT}" is not one.`)

// The folder It lives in holds its keys. It is never one that is kept with the logs, and never
// one that something is already in: a fresh one is what a person's first run starts from.
const given = process.env.IT_HOME ? path.resolve(process.env.IT_HOME) : null
if (given && !path.relative(path.resolve(logs), given).startsWith('..'))
  cannot(`IT_HOME is inside ${logs}, where the logs are kept, and the folder It lives in holds its keys.`)
if (given && existsSync(given) && readdirSync(given).length > 0) cannot(`It is started in a fresh folder, and ${given} is not empty.`)
if (given) mkdirSync(given, { recursive: true, mode: 0o700 })
const home = given ?? mkdtempSync(path.join(os.tmpdir(), 'it-e2e-home-'))
// Where the agent apps, and their settings, are looked for by everything started here: a
// made-up folder, with stand-ins for the apps in it (e2e/lib.mjs). So nothing of Claude Code's or
// Codex's own on this machine is run, read or changed. Were either app itself still in reach of
// what is started here, nothing would be started.
const apps = mkdtempSync(path.join(os.tmpdir(), 'it-e2e-apps-'))
process.env.IT_E2E_APPS = apps
const reaches = reachesAnApp(itEnv(home))
if (reaches) {
  rmSync(apps, { recursive: true, force: true })
  cannot(`${reaches}.`)
}
// What setup says and answers is kept with the log, where the check of what was written down reads it
process.env.IT_E2E_SAID = logs
// Where a folder of archives was named, the stack stands in for the backend program's release,
// and everything it starts is told that the releases are there. No backend program is named
// then: one that is named is used as it is, and nothing would be fetched.
const archives = process.env.IT_STACK_BACKEND_ARCHIVES ? path.resolve(process.env.IT_STACK_BACKEND_ARCHIVES) : null
if (archives && process.env.IT_BACKEND_BIN) {
  rmSync(apps, { recursive: true, force: true })
  cannot('IT_BACKEND_BIN names a backend program to use as it is, and IT_STACK_BACKEND_ARCHIVES a folder to fetch one from. Only one of the two can be meant.')
}
if (archives && !statSync(archives, { throwIfNoEntry: false })?.isDirectory()) {
  rmSync(apps, { recursive: true, force: true })
  cannot(`IT_STACK_BACKEND_ARCHIVES names the folder that holds the backend program’s archive, and ${archives} is no folder.`)
}
const release = archives ? await backendRelease(archives) : null
if (release) process.env.IT_BACKEND_RELEASES = release.url
const at = whereabouts({ home, port })
/** What did not stop when it was asked to, each time it happened, in the words it was said in. Empty in a run in which everything did. */
const forced = []
/** The service that is running now, by its process, and how the stack stopped once it has. */
const now = {}
/** The note of where this stack is: with the service that is running now, what has not stopped when asked so far, and at the end how the stack stopped. */
const noteStack = (more = {}) => {
  Object.assign(now, more)
  writeFileSync(
    stackNote(),
    `${JSON.stringify({ home, port, pid: process.pid, ...(release ? { release: release.url } : {}), ...now, ...(forced.length ? { forced } : {}) })}\n`,
  )
}
noteStack()

// ---------- stopping ----------

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Waits until a program has gone. False when it is still there after `ms`. */
async function gone(pid, ms) {
  for (const end = Date.now() + ms; alive(pid); await sleep(100)) if (Date.now() > end) return false
  return true
}
/** How long the service is given to stop: it closes its door, and asks the backend program to stop and waits for it. */
const STOP_MS = Number(process.env.IT_STACK_STOP_SECONDS ?? 60) * 1000
/** Says that something did not stop when it was asked to, and keeps it: the stack ends as a failure for it. */
const notStopped = (what) => {
  forced.push(what)
  console.error(what)
  noteStack()
}

/** The backend program that is still running on this stack's folder, if one is (e2e/lib.mjs): no other program is this stack's to stop. */
const leftBehind = () => backendLeftOn(home)

/**
 * Makes sure no backend program is left on this folder. The service stops its own, and lets go
 * of the folder's lock as it does. A lock that still names a running backend program of this
 * folder names one that outlived whatever started it: setup that was interrupted, a service
 * that had to be made to stop, or one that ended without stopping it. That is said, and fails
 * the stack. The program is then asked to stop as the service asks it, and made to when it has
 * not within the time a service is given. Whether nothing is left.
 */
async function noBackend() {
  const program = leftBehind()
  if (program === undefined) return true
  notStopped(`a backend program was left running when the service had ended (pid ${program}), and is asked to stop`)
  process.kill(program, 'SIGINT')
  if (await gone(program, STOP_MS)) return true
  notStopped(`the backend program did not stop when asked, and was made to (pid ${program})`)
  process.kill(program, 'SIGKILL')
  return gone(program, 5000)
}

let service
/** Stops the service and waits until it has gone, and its backend program with it. Whether nothing of it is left running. */
async function halt() {
  const child = service
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.kill('SIGTERM')
    if (!(await Promise.race([closed.then(() => true), sleep(STOP_MS).then(() => false)]))) {
      notStopped(`the service did not stop within ${STOP_MS / 1000} seconds of being asked, and was made to (pid ${child.pid})`)
      child.kill('SIGKILL')
      await closed
    }
  }
  return noBackend()
}

/** What is being done before the service is started, while it is: building, or setting up. */
let preparing
let stopping
/** Stops everything this program started, and then the program itself. Whatever asks for it a second time waits for the first. */
function stop(code = 0) {
  stopping ??= (async () => {
    // Setup that is under way is let finish, so that what it started is stopped by itself
    await Promise.race([Promise.resolve(preparing).catch(() => {}), sleep(120_000)])
    const nothingLeft = await halt()
    // What It's folder holds by now is noted before the folder goes: a connector's token, the key notifications are signed with
    const before = couldNotNote().length
    noteHome(home, noteWhenSeen)
    const unnoted = couldNotNote().length > before
    if (unnoted) console.error('A credential the stack held could not be noted where the check of what was written down looks.')
    rmSync(apps, { recursive: true, force: true })
    await release?.close()
    // The folder goes only when nothing is left running on it: a program that is still there is still writing to it
    if (!nothingLeft) console.error(`A backend program is still running on ${home}, which is left as it is.`)
    else if (!given) rmSync(home, { recursive: true, force: true })
    noteStack({ stopped: forced.length || !nothingLeft ? 'by force' : 'when asked' })
    console.log(forced.length || !nothingLeft ? 'stopped, and not everything stopped when it was asked to' : 'stopped')
    process.exit(unnoted || forced.length || !nothingLeft ? 1 : code)
  })()
  return stopping
}
/** Says why the stack cannot go on, and stops what it has started. */
const giveUp = (why) => {
  console.error(`The stack cannot start: ${why}`)
  return stop(1)
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
// Its terminal was closed: the service is in a group of its own and would outlive it
process.on('SIGHUP', () => stop())
// An error nothing caught ends the stack too, and is printed cleaned of anything that is a credential
for (const how of ['uncaughtException', 'unhandledRejection'])
  process.on(how, (err) => {
    console.error(redact(err?.stack ?? String(err)))
    stop(1)
  })

// ---------- starting ----------

/** Runs a command to its end. One that fails has said why itself, and the stack stops there with a sentence. */
const once = (cmd, args, what) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' })
    const asked = () => child.kill('SIGTERM')
    process.once('SIGTERM', asked)
    child.on('error', () => resolve(giveUp(`${what} could not be run.`)))
    child.on('close', (code) => {
      process.off('SIGTERM', asked)
      resolve(code === 0 || stopping ? undefined : giveUp(`${what} did not finish (it ended with ${code}). What it said is above.`))
    })
  })

// The bundle is built from what is in this repository now, unless another program was named
if (!process.env.IT_BIN && !process.env.IT_CLI) {
  preparing = once(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'generate'], '`npm run generate`')
  await preparing
}

// Where the stack stands in for the backend program's release, the program that is about to be
// set up has to be one that is told where the releases are by IT_BACKEND_RELEASES. One that is
// not would ask GitHub for the program. So it is looked through for the variable's name, and
// one that does not hold it is not run: nothing here reaches another machine by accident.
if (!stopping && release && !holdsTheName(COMMAND.at(-1), 'IT_BACKEND_RELEASES'))
  await giveUp(
    `${COMMAND.at(-1)} does not take the place its backend program is fetched from out of IT_BACKEND_RELEASES, and would ask GitHub for it. It is not run. Name a newer It with IT_BIN or IT_CLI, or a backend program to use as it is with IT_BACKEND_BIN.`,
  )

// A person's first run. `--none` connects no agent app, and `--no-service` registers nothing
// with the system: the backend is run only for as long as setup takes.
if (!stopping) {
  preparing = it(home, ['setup', '--none', '--no-service', '--name', STACK_MACHINE], { extraEnv: { IT_PORT: String(port) } }).then(
    () =>
      existsSync(path.join(home, 'service.json'))
        ? undefined
        : giveUp(`\`it setup --none --no-service\` ended well and left no settings in ${home}, so there is nothing for \`it serve\` to run.`),
    (err) => stopping || giveUp(`\`it setup --none --no-service\` did not finish (${err.message}).`),
  )
  await preparing
}
// Where the stack stands in for the backend program's release, setup has fetched the program
// from it. An It that set itself up and asked the stand-in for no archive has its program from
// somewhere else, and is not the first run that was meant.
if (!stopping && release && !release.asked.some((one) => one.status === 200))
  await giveUp(
    `\`it setup\` asked the stand-in for the backend program’s release for no archive that is in ${archives} (it asked for ${release.asked.map((one) => `${one.path}, answered ${one.status}`).join('; ') || 'nothing'}).`,
  )
// The keys setup made are among the credentials a run holds: noted, where a later check of
// what was written down is told what to look for
if (!stopping) noteHome(home)

const log = path.join(logs, 'service.log')
if (!stopping) writeFileSync(log, '')
let restarting
/** Starts the service, with what it says and what it writes down kept in the one log, after whatever is there. */
function start() {
  const out = openSync(log, 'a')
  // In a group of its own, so that Ctrl-C at the terminal reaches this program alone, which
  // then asks the service to stop and waits for it
  const child = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], { env: itEnv(home), stdio: ['ignore', out, out], detached: process.platform !== 'win32' })
  closeSync(out)
  service = child
  child.on('close', (code, signal) => {
    if (service !== child || stopping || restarting) return
    console.log(`the service stopped by itself (${signal ?? code}): see ${log}`)
    stop(1)
  })
  noteStack({ service: child.pid })
}

const up = (url) =>
  fetch(url, { signal: AbortSignal.timeout(3000) }).then(
    (r) => r.status === 200,
    () => false,
  )
/** Waits until the backend answers with its functions in place and the door serves the site. */
async function answering(seconds = 240) {
  for (const end = Date.now() + seconds * 1000; Date.now() < end && !stopping; await sleep(250))
    if ((await up(`${at.http}/health`)) && (await up(`${at.site}/`))) return true
  return false
}

process.on('SIGUSR2', () => {
  if (stopping || restarting || !service) return
  restarting = (async () => {
    console.log('stopping the service, to start it again')
    if (!(await halt())) return stop(1)
    if (stopping) return
    start()
    console.log((await answering()) ? 'started again' : `not answering after it was started again: see ${log}`)
  })().finally(() => {
    restarting = undefined
  })
})

if (!stopping) {
  start()
  // What It's folder comes to hold while the service runs is noted as it appears: its connector's
  // token, which is there only while it runs, each token the machine earns, and the key
  // notifications are signed with
  setInterval(() => noteHome(home, noteWhenSeen), 2000)
  const ready = await answering()
  if (!stopping)
    console.log(
      ready
        ? `ready: site ${at.site}  backend ${at.api}  It’s folder ${home}  (log in ${logs})`
        : `not ready after four minutes: see ${log}, or run node e2e/ready.mjs`,
    )
}
