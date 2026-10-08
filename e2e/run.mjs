// The whole product, end to end, on one machine: the `it` command, the service it runs (the
// backend program, the door, and what shows pages), the site in a real browser, and the
// connector. It needs the stack running (node e2e/stack.mjs).
//
//   node e2e/run.mjs            everything, which takes about eleven minutes
//   node e2e/run.mjs --quick    skips what takes longest, and says so where it does: turning
//                               usage reporting off on a machine whose connector is running;
//                               the checks that wait out a lease, which are the connector
//                               killed while it holds a click and the one that takes its place
//                               and listens on a port; the connector of a machine that is
//                               enrolled anew; and the ten minutes after which a showing that
//                               nothing keeps alive has ended
//
// It opens the stack to this machine's network for a moment, to be reached from there, only
// where CI is set or IT_E2E_NETWORK=1 says it may.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  appCalls,
  ask,
  backendLeftOn,
  COMMAND,
  connectorTokenIn,
  couldNotKeep,
  couldNotNote,
  isBackendOn,
  it,
  itEnv,
  machineToken,
  needsStack,
  noteFound,
  noteHome,
  noteSecret,
  noteWhenSeen,
  patiently,
  reachesAnApp,
  root,
  STACK_LOGS,
  STACK_MACHINE,
  sleep,
  stack,
  standInApps,
  stopped,
  toldAboutUsage,
  usageReceiver,
  wrongWithUsage,
} from './lib.mjs'
import { inviteMachine, join } from './login.mjs'
import { leaks, PRIVATE_MARK, printCleanly, redact, stackLogs, verdict } from './logs.mjs'
import {
  APP,
  againstPolicy,
  BROWSER,
  becomeAScreen,
  cookieOf,
  exactly,
  expectations,
  launch,
  machineCommand,
  mayNotLeave,
  namingsHeld,
  noConnectionTo,
  notAsked,
  notLetRead,
  notMade,
  open,
  ownerAddress,
  pairAsOwner,
  pairAsScreen,
  paired,
  refusedWith,
  screenCode,
  showingOf,
  under,
} from './site.mjs'

printCleanly()
const QUICK = process.argv.includes('--quick')
const STACK = needsStack('The end-to-end run')
// Where the stack stands in for the release the backend program is fetched from, an It that
// the run sets up beside the stack's fetches its program there as well, unless this run was
// told of a program to use as it is
if (STACK.release && !process.env.IT_BACKEND_BIN) process.env.IT_BACKEND_RELEASES = STACK.release
const results = []
// What a failed check says is printed where nothing scans it afterwards (a CI step's own log),
// so anything in it that is, or is shaped like, a credential is taken out first
function check(name, ok, detail = '') {
  results.push({ name: redact(name), ok: Boolean(ok) })
  console.log(verdict(name, ok, detail))
}
const section = (title) => console.log(`\n${title}`)
async function until(fn, ms = 10_000, every = 200) {
  const end = Date.now() + ms
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(every)
  }
}
/**
 * Waits for something the run cannot go on without. When it does not come, the run stops there
 * with a sentence that says what was waited for, which is then the check that failed: nothing
 * after it is read from where it never came to be.
 */
async function awaited(what, fn, ms = 10_000, every = 200) {
  const v = await until(fn, ms, every)
  if (!v) throw new Error(`${what} within ${Math.round(ms / 1000)} seconds`)
  return v
}
const refused = (p) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `threw: ${e.message}`,
  )
/**
 * One request as a program that is no browser makes it: what is given is sent, and nothing is
 * added to it. Answers with the status, how many bytes came, and what they say.
 */
const plain = (url, { method = 'GET', headers = {}, body, localAddress } = {}) =>
  new Promise((resolve, reject) => {
    const sent = {
      method,
      // A connection of its own for each request. One kept from an earlier request may be closed by the door, for having
      // stood idle, in the moment the next request is written to it, and the request then fails with nothing of It's wrong:
      // a browser asks again by itself on a new connection, and this does not
      agent: false,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
      ...(localAddress ? { localAddress } : {}),
    }
    const req = http.request(url, sent, (res) => {
      const pieces = []
      res
        .on('data', (d) => pieces.push(d))
        .on('end', () => {
          const all = Buffer.concat(pieces)
          resolve({ status: res.statusCode, bytes: all.length, text: all.toString('utf8'), headers: res.headers })
        })
    })
    req.setTimeout(10_000, () => req.destroy(new Error('no answer in ten seconds')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })

const tmp = mkdtempSync(path.join(os.tmpdir(), 'it-e2e-'))
/** What a showing's address answers when it is asked for one of the page's files, and when it is asked to keep the showing alive, as the page itself asks. */
const servedAt = async (url) => [(await plain(new URL('app.js', url).href)).status, (await plain(new URL('../../__it/keep', url).href)).status].join()
const home = (name) => path.join(tmp, name)
// The machine It runs on, which the stack set up, and the folder it lives in
const A = STACK.home
const fixture = path.join(root, 'e2e/fixtures/plan')
const slug = `plan-${Date.now().toString(36)}`
// Named for this run, so that a machine left behind by an earlier run is never mistaken for it
// It carries the mark that the check of the logs looks for, as every name and title the run
// chooses does: a log that repeats a name a person typed is caught by it
const marked = (text) => `${text} ${PRIVATE_MARK}${slug.slice(-5)}`
const BOX = marked('e2e agent box')
const OTHER = marked('e2e other')
// And so are the displays the run names: one left behind by an earlier run is never taken for them
const WALL = marked('Test wall')
const SCREEN = marked('Test screen')
// What the run sets a page's state to, and what the fixture's own buttons send (e2e/fixtures/plan)
const DEPLOYING = `Deploying 3 of 7 ${PRIVATE_MARK}status`
const PLAN = `${PRIVATE_MARK}B`
const children = []
const browsers = []
// Where what each test machine wrote down is kept: for CI to keep, and for the checks at the end
const KEPT = process.env.IT_E2E_LOGS ?? path.join(tmp, 'logs')
mkdirSync(KEPT, { recursive: true })
// Everything the CLI prints in the run is kept there too (e2e/lib.mjs)
process.env.IT_E2E_SAID = KEPT
// Whatever the run's own programs ask of Claude Code or Codex is asked of stand-ins for them,
// which keep what they are given in made-up folders: never of the apps, or of the settings, of
// whoever runs the suite (e2e/lib.mjs)
process.env.IT_E2E_APPS = path.join(tmp, 'apps')
mkdirSync(process.env.IT_E2E_APPS)
// The usage counts the run's programs report go to a stand-in here, and what it is sent is kept
// with everything else the run wrote down, where the same check reads it
const usage = await usageReceiver(path.join(KEPT, 'usage.received.jsonl'))
process.env.IT_E2E_USAGE_URL = usage.url
// What the folders of the run's machines come to hold is noted as it appears, for as long as
// the run goes on: a token each time one is earned, a connector's token when it starts
const noting = setInterval(() => {
  for (const folder of [A, home('b'), home('c'), home('d')]) noteHome(folder, noteWhenSeen)
}, 500)
/** What the run's own programs and browsers wrote is put where it is read back, and where CI keeps it. Done however the run ends. */
function keep() {
  children.forEach((c, i) => {
    writeFileSync(path.join(KEPT, `connector-${i + 1}.log`), c.log)
  })
  opened.forEach((b, i) => {
    writeFileSync(path.join(KEPT, `browser-${i + 1}.console.log`), b.said.join('\n'))
    // What is kept of a console has been cleaned, so a credential that was in it is said here, for whoever reads the kept files afterwards
    noteFound(`the console of browser ${i + 1}`, b.leaked)
  })
  for (const [h, folder] of [
    ['a', A],
    ['b', home('b')],
    ['c', home('c')],
  ])
    if (existsSync(path.join(folder, 'journal.jsonl'))) writeFileSync(path.join(KEPT, `journal-${h}.jsonl`), readFileSync(path.join(folder, 'journal.jsonl')))
}
/** Whether that could be done at the run's end: what could not be kept was never read. */
let keptAll = true
/** Whether everything the run started had ended by the time what it wrote was read: one still running can write more. */
let allStopped = false
/** Every browser the run opened, in order. */
const opened = []
const began = (b) => {
  opened.push(b)
  browsers.push(b.browser)
  // The whiles in which the run takes this browser's pairing to be ending or over
  b.notPaired = []
  namesSessionsAt(b, APP)
  return b
}

// What a browser says by itself that the run expects of it, foreseen at the step that provokes
// it and held against what each browser reported when the run is done (e2e/site.mjs).
const { foresee, during, provoking, heldToAccount } = expectations()
// The site has one way to learn whether its browser is paired, which is to ask for a token: a
// cookie no script can read is all that says so, and a browser that is not paired is refused,
// which it writes down. And a browser that learns its pairing has ended names the session it
// held, once in each of its tabs, so that the backend clears that session's cookie, which no
// script can do: there is nothing left to end by then, and that is answered with a refusal too.
// A refused token is not foreseen of a browser the run takes to be paired. It is foreseen of
// one browser from the step that leaves it not paired until the step that pairs it or closes
// it, and no oftener than that step and what the run asks of the browser meanwhile can account
// for. A naming that is refused is foreseen of a browser as often as it named a session in a
// way the site may, with that answer, and not once more: every naming is held to that
// (`namingsHeld`, e2e/site.mjs), by what the browser sent and by these same whiles.
const notPairedNow = new Map()
/** Every naming of a session by a browser so far, held to what the site may do. */
const namingsOf = (b) => namingsHeld(b.exchanges, b.notPaired)
/** Foresees of a browser that it says by itself each refusal of a naming the site may make, at the site as that browser reaches it. */
function namesSessionsAt(b, site) {
  for (const status of [401, 409])
    foresee(b, {
      says: refusedWith(status),
      of: exactly(`${site}/session/end`),
      may: true,
      times: () => namingsOf(b).refused(site, status),
      because: 'a browser named a session to the site, to end it or to have its cookie cleared again',
    })
}
/**
 * Says that a browser is not paired from here on, and what left it so. `asks` is how often it
 * may be refused a token until it is paired or closed, and `at` the site as that browser
 * reaches it. What is given waits until the browser has found that out: a tab of it was
 * refused a token since, and has named a session after that and been answered, which is the
 * last thing a tab does on finding that its browser is not paired.
 */
function nowNotPaired(b, because, { asks = 6, at = APP } = {}) {
  notPairedNow.get(b)?.()
  const whilst = { from: Date.now(), until: Number.POSITIVE_INFINITY }
  b.notPaired.push(whilst)
  notPairedNow.set(
    b,
    during(b, [{ says: refusedWith(401), of: exactly(`${at}/session/token`), times: asks, because: `${because}, and it was refused a token` }]),
  )
  const named = (refusal) => b.exchanges.some((x) => x.path === '/session/end' && x.tab === refusal.tab && x.sent >= refusal.answered && x.answered !== null)
  return {
    foundOut: async () =>
      Boolean(await until(() => b.exchanges.some((x) => x.path === '/session/token' && x.status === 401 && x.sent >= whilst.from && named(x)), 20_000, 50)),
  }
}
/** Says that a browser is paired from here on, or closed: from then on it is foreseen to be refused nothing. */
function nowPairedOrClosed(b) {
  notPairedNow.get(b)?.()
  notPairedNow.delete(b)
  for (const whilst of b.notPaired) whilst.until = Math.min(whilst.until, Date.now())
}
/** What a browser may say while the door, or the whole service, is closed and opened again under a site that is open in it: that its live connection could not be made, and that a request to the site or to the pages could not. */
const closedUnder = (site, itsPages, because) => [
  { says: noConnectionTo(site), may: true, times: 20, because },
  { says: notMade('ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_EMPTY_RESPONSE'), of: under(`${site}/`), may: true, times: 20, because },
  { says: notMade('ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_EMPTY_RESPONSE'), of: under(`${itsPages}/`), may: true, times: 20, because },
]

// How much the stack's log held when this run began. The stack may have served runs before
// this one, and what one of those left in it is not to stand in for what this one must have caused.
const serviceLog = path.join(STACK_LOGS, 'service.log')
const begun = statSync(serviceLog, { throwIfNoEntry: false })?.size ?? 0
/** The events in a piece of a log: each is one line of JSON that begins with its name. */
const eventsIn = (text) => {
  const events = []
  for (const line of text.split('\n')) {
    const at = line.indexOf('{"event":')
    if (at < 0) continue
    // The backend's lines are printed quoted, and the service's as they are
    const said = line.slice(at).replace(/'$/, '')
    try {
      events.push(JSON.parse(said.slice(0, said.lastIndexOf('}') + 1)))
    } catch {}
  }
  return events
}
/** What the part of the service that shows pages has written down since this run began, read back from the stack's log. */
const shown = () => (existsSync(serviceLog) ? eventsIn(readFileSync(serviceLog).subarray(begun).toString('utf8')) : [])
/** How often that part has been told that a display's showings are over, by the display's id: it writes down each time it is. */
const toldItIsOver = (display) => shown().filter((e) => e.event === 'control.revoke' && e.d === display).length
/**
 * What a showing's address gives at the first asking after the part of It that shows pages was
 * told that its display's showings are over. `before` is how often it had been told so before
 * whatever ended them. A showing ends at once, so nothing is waited for but the telling, and
 * the address is asked once: an address that still gave something then is not asked again
 * until it does not.
 */
async function onceToldItIsOver(display, before, url, ms = 20_000) {
  const told = Boolean(display && (await until(() => toldItIsOver(display) > before, ms, 50)))
  return { told, gives: await servedAt(url) }
}

// The backend program keeps what It's functions write down, and what each of them failed with,
// where only its administrator can read it. The run reads it as that, with the key in It's
// settings, all the while: it is kept with everything else the run wrote down, where the same
// check reads it, and what it says happened is looked at when the run is done.
const adminKey = JSON.parse(readFileSync(path.join(A, 'service.json'), 'utf8')).adminKey
const backendLog = path.join(KEPT, 'backend.log')
const backendSaid = []
/** Every function the backend has run since the run began, by its name, with when: its own record says each, a question that only read something among them. */
const backendRan = []
let backendFrom = Date.now()
let backendKept = true
let readingBackend = false
async function readBackend() {
  if (readingBackend) return
  readingBackend = true
  try {
    const answered = await fetch(`${STACK.api}/api/stream_function_logs?cursor=${backendFrom}`, {
      headers: { authorization: `Convex ${adminKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!answered.ok) return
    const { entries, newCursor } = await answered.json()
    let text = ''
    for (const e of entries ?? []) {
      if (typeof e.timestamp === 'number') backendRan.push({ ran: String(e.identifier ?? e.udfPath ?? ''), at: e.timestamp * 1000 })
      for (const line of e.logLines ?? []) text += `${e.identifier ?? e.udfPath ?? ''}: ${typeof line === 'string' ? line : JSON.stringify(line)}\n`
      if (e.error) text += `${e.identifier ?? e.udfPath ?? ''}: failed: ${String(e.error).replace(/\n/g, ' ')}\n`
    }
    if (text) {
      try {
        appendFileSync(backendLog, text)
      } catch {
        backendKept = false
      }
      backendSaid.push(...eventsIn(text))
    }
    if (typeof newCursor === 'number') backendFrom = newCursor
  } catch {
    // The service is stopped and started again in the run: what the backend says next is read then
  } finally {
    readingBackend = false
  }
}
const backendReader = setInterval(() => void readBackend(), 1500)
/**
 * Whether the backend has run a function since a moment, by its own record of what it ran.
 * That is how the run knows that something it started has got as far as asking the backend.
 */
async function ranSince(name, since) {
  await readBackend()
  return backendRan.some((one) => one.ran === name && one.at >= since)
}
/**
 * Starts an agent waiting, as `it wait` does, and gives it back once it is there to be given a
 * click: it has told the connector of its machine what it waits for, and has asked the backend
 * what is waiting, which is the last thing it does before it waits. A click made before that
 * could go another way than the check means. `answered` is what it prints when a click
 * comes, or how it failed: it is given its handler the moment it is started, so that one that
 * failed before it was looked at does not end the run where it stood. One that has ended
 * before it came to wait is given back as it is, for the check that reads what it answered.
 */
async function waitingAgent(folder, words, options) {
  const since = Date.now()
  let ended = false
  const answered = it(folder, ['wait', ...words], options)
    .catch((e) => ({ failed: e.message }))
    .finally(() => {
      ended = true
    })
  // With a page named it asks what waits on that page, and with none what waits for its own conversation
  const asks = words.includes('--id') ? 'delivery:waiting' : 'delivery:waitingFor'
  await awaited(
    'an agent that was started to wait did not get as far as asking what was waiting',
    async () => ended || (await ranSince(asks, since)),
    30_000,
    50,
  )
  return { answered }
}
/**
 * When the backend last wrote down that a code was refused, if it did within the last minute.
 * It writes that down once a minute at most, however many codes it refuses. A stack that
 * served a run a moment ago may have written one down in that minute, and the first code this
 * run is refused would then go unwritten, with why.
 */
async function codeLastRefusedAt() {
  let last
  let from = Date.now() - 60_000
  // What it wrote down is read in pieces, up to where nothing more has been written
  for (let piece = 0; piece < 20; piece++) {
    const read = await fetch(`${STACK.api}/api/stream_function_logs?cursor=${from}`, {
      headers: { authorization: `Convex ${adminKey}` },
      signal: AbortSignal.timeout(3000),
    })
      .then((answered) => (answered.ok ? answered.json() : null))
      .catch(() => null)
    for (const entry of read?.entries ?? [])
      if ((entry.logLines ?? []).some((line) => String(line).includes('"event":"code.refused"'))) last = Math.max(last ?? 0, entry.timestamp * 1000)
    if (!read?.entries?.length || !(read.newCursor > from)) break
    from = read.newCursor
  }
  return last
}

// Codex, wherever one of the run's programs looks for it, is a stand-in that notes how it was
// called. So a click meant for Codex's own queue never reaches a real Codex, and what the
// connector put on its command line can be read back: the words of each call, in order.
const codexCalls = () =>
  appCalls()
    .filter((call) => call.app === 'codex')
    .map((call) => call.args)
/** The words Codex's own queue was called with, each time it was. */
const queuedInCodex = () => codexCalls().filter((args) => args[0] === 'queue')

/** Starts the service of a machine that joined, which is its connector and nothing else: It itself runs on the machine it joined. */
function startConnector(h, extraEnv = {}) {
  const child = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], {
    env: { ...itEnv(h), ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.log = ''
  child.stderr.on('data', (d) => (child.log += d))
  children.push(child)
  return child
}
/** Asks the connector something the way an add-on does: over its socket (or port), with its token. */
function askConnector(h, p, body, { token } = {}) {
  const c = JSON.parse(readFileSync(path.join(h, 'connector.json'), 'utf8'))
  const where = c.socket ? { socketPath: c.socket } : { host: '127.0.0.1', port: c.port }
  const text = body ? JSON.stringify(body) : undefined
  const method = body ? 'POST' : 'GET'
  // Over the socket the token is shown; over a port it never is, and the request is sealed with it
  const nonce = randomBytes(16).toString('hex')
  const proof = c.socket
    ? { 'x-it-token': token ?? c.token }
    : {
        'x-it-nonce': nonce,
        'x-it-mac': createHmac('sha256', token ?? c.token)
          .update(`${nonce}\n${method}\n${p}\n${text ?? ''}`)
          .digest('hex'),
      }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...where,
        path: p,
        method,
        headers: { ...proof, 'content-type': 'application/json', ...(text ? { 'content-length': Buffer.byteLength(text) } : {}) },
      },
      (res) => {
        let out = ''
        res
          .on('data', (d) => (out += d))
          .on('end', () => {
            // Over a port the answer is sealed too: whether this one was is noted for the checks
            if (!c.socket)
              sealedAnswers.push(res.headers['x-it-mac'] === createHmac('sha256', c.token).update(`${nonce}\n${res.statusCode}\n${out}`).digest('hex'))
            resolve(res.statusCode === 200 ? JSON.parse(out) : { status: res.statusCode })
          })
      },
    )
    req.on('error', reject)
    if (text) req.write(text)
    req.end()
  })
}
const sealedAnswers = []
/** Stands in for an add-on: asks the connector for one conversation's clicks, as the real ones do. */
function addon(h, harness, session) {
  return {
    clicks: () => askConnector(h, `/clicks?harness=${harness}&session=${encodeURIComponent(session)}`),
    ack: (ids) => askConnector(h, '/ack', { ids }),
    became: (next) => askConnector(h, '/session', { harness, session: next, was: session }),
    health: () => askConnector(h, '/health'),
  }
}
/**
 * An add-on that goes on asking its connector for clicks, once a second as a real one does,
 * and keeps what each asking was answered: when it was sent, and the clicks it was given. An
 * asking that could not be made is not kept, and the next is made all the same.
 * `given` is every click it has been given, each once, by its id. `askedSince` waits until it
 * has asked a number of times after a moment and been answered each time, which is how the
 * run knows that a click on its way to the add-on at that moment has been handed to it by
 * now: an asking sets the connector to look for the conversation's clicks, and the one after
 * it is given whatever that found.
 */
function asking(mod) {
  const askings = []
  let stopped = false
  let next
  let underWay = Promise.resolve()
  const ask = () => {
    const sent = Date.now()
    underWay = Promise.resolve()
      .then(() => mod.clicks())
      .then(
        (answered) =>
          askings.push({ sent, clicks: Array.isArray(answered?.clicks) ? answered.clicks : [], ...(Array.isArray(answered?.clicks) ? {} : { odd: answered }) }),
        () => {},
      )
      .finally(() => {
        if (!stopped) next = setTimeout(ask, 1000)
      })
  }
  ask()
  return {
    askings,
    given: () => [...new Map(askings.flatMap((one) => one.clicks).map((click) => [click.id, click])).values()],
    /** Every answer that was no list of clicks. */
    odd: () => askings.filter((one) => 'odd' in one).map((one) => one.odd),
    /** The first asking, of those sent after a moment, that was given a click: with every click it was given. */
    firstGiven: (since = 0) => askings.find((one) => one.sent >= since && one.clicks.length > 0),
    askedSince: (since, times = 2) =>
      awaited('an add-on that was asking its connector was not answered', () => askings.filter((one) => one.sent >= since).length >= times, 20_000, 50),
    /** Asks no more, once the asking that is under way has been answered. */
    stop: async () => {
      stopped = true
      clearTimeout(next)
      await underWay
    },
  }
}
/**
 * Listens to what a tab and the backend say to each other over the tab's live connection,
 * from now on, and tells when the tab has been given the answer to a question it keeps asked
 * there, by the question's name. The site has then got what it asked to be kept told of, and
 * hears of whatever changes it from that moment. It is begun before the tab is taken to the site.
 */
function keptToldOf(tab) {
  const answered = new Set()
  const read = (text) => {
    try {
      return JSON.parse(String(text))
    } catch {
      return undefined
    }
  }
  const onConnection = (connection) => {
    if (!new URL(connection.url()).pathname.endsWith('/sync')) return
    const asked = new Map()
    const parts = []
    const told = (said) => {
      if (said?.type !== 'Transition') return
      for (const change of said.modifications ?? []) if (change.type === 'QueryUpdated' && asked.has(change.queryId)) answered.add(asked.get(change.queryId))
    }
    connection.on('framesent', ({ payload }) => {
      const said = read(payload)
      if (said?.type === 'ModifyQuerySet') for (const change of said.modifications ?? []) if (change.type === 'Add') asked.set(change.queryId, change.udfPath)
    })
    connection.on('framereceived', ({ payload }) => {
      const said = read(payload)
      // A long answer comes in parts, which are read once the last of them is there
      if (said?.type !== 'TransitionChunk') return told(said)
      parts.push(said.chunk)
      if (said.partNumber === said.totalParts - 1) told(read(parts.splice(0).join('')))
    })
  }
  tab.on('websocket', onConnection)
  return { has: (name) => answered.has(name), stop: () => tab.off('websocket', onConnection) }
}
/** Keeps every address a tab is taken to from now on, in the order it went there, by its path on the site. */
function addressesOf(tab) {
  const went = []
  const note = (frame) => {
    if (frame === tab.mainFrame()) went.push(new URL(frame.url()).pathname)
  }
  tab.on('framenavigated', note)
  return { went, stop: () => tab.off('framenavigated', note) }
}
const reachable = (i) => Boolean(i.socket) || i.port > 0

/**
 * The frame a tab has a page in, if it has one at this moment. Its address is read off the
 * frame: it is whatever the site gave the frame, away from the site's own, and ends in the
 * version and the page's first file.
 */
const shownFrame = (p, site = APP) =>
  p
    .frames()
    .filter((f) => /^https?:\/\//.test(f.url()) && new URL(f.url()).origin !== site && /\/v\/\d+\/index\.html$/.test(new URL(f.url()).pathname))
    .at(-1)
/** The same, for where a page has already been seen to be shown: a tab that has none stops the run with a sentence. */
const frameOf = (p, site = APP) => {
  const frame = shownFrame(p, site)
  if (!frame) throw new Error(`no page is shown in the tab at ${new URL(p.url()).pathname}`)
  return frame
}
/**
 * The frame a tab is showing a page in, waited for. A page is shown once the site has put its
 * frame there and called it shown, which it does when It's script in the page has said hello;
 * the page has loaded in that frame at its showing's own address; and it is the page, and the
 * version, that was asked for. Nothing short of that proves there is a frame to read: the site
 * says other things about a page, such as how its last action fared, before it has shown it.
 * A page that is not shown in time stops the run with a sentence that says how far it got.
 */
async function pageIn(p, { id, version, site = APP, ms = 20_000 } = {}) {
  let got = 'the site had put no frame there'
  const frame = await until(async () => {
    if ((await p.locator('.mount iframe[data-shown="true"]').count()) !== 1) return undefined
    got = 'the site called its frame shown, and no page had loaded in it at a showing’s address'
    const f = shownFrame(p, site)
    if (!f) return undefined
    got = 'a page had loaded in the frame, and It was not there in it'
    const is = await f.evaluate(() => (typeof window.It?.action === 'function' ? { id: window.It.id, version: window.It.version } : null))
    if (!is) return undefined
    got = `the frame held version ${is.version} of the page ${is.id}`
    return (id === undefined || is.id === id) && (version === undefined || is.version === version) ? f : undefined
  }, ms)
  if (!frame)
    throw new Error(
      `${id ? `the page ${id}${version === undefined ? '' : `, at version ${version},`}` : 'a page'} was not shown in the tab at ${new URL(p.url()).pathname} within ${Math.round(ms / 1000)} seconds: ${got}`,
    )
  return frame
}
/** A content policy as its directives, each with what it allows. */
const policyOf = (header) =>
  Object.fromEntries(
    String(header ?? '')
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...allowed]) => [name, allowed]),
  )
/** A policy written out with its directives in order and what each allows in order, so that two that say the same read the same. */
const spelled = (policy) =>
  Object.keys(policy)
    .sort()
    .map((name) => [name, ...[...policy[name]].sort()].join(' '))
    .join('; ')
/** Whether a policy says exactly what it is meant to: every directive that is meant, each allowing exactly what is meant, and no other directive. */
const saysExactly = (header, meant) => spelled(policyOf(header)) === spelled(meant)
/**
 * Everything a port of this machine says to bytes sent to it just as they are, down to what is
 * no request at all: the status and the headers of each answer it gives, in order, until it
 * closes the connection or has said nothing more for a while. None, where it says nothing.
 */
const saidTo = (port, bytes, ms = 2500) =>
  new Promise((resolve) => {
    const pieces = []
    const socket = net.connect(port, '127.0.0.1')
    let over = false
    const done = () => {
      if (over) return
      over = true
      socket.destroy()
      const answers = []
      // An answer begins where a line says its status, and its headers run to the first empty line
      for (const [, status, lines] of Buffer.concat(pieces)
        .toString('latin1')
        .matchAll(/(?:^|\r\n)HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n((?:[^\r\n]+\r\n)*)\r\n/g))
        answers.push({
          status: Number(status),
          headers: Object.fromEntries(
            lines
              .split('\r\n')
              .filter(Boolean)
              .map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]),
          ),
        })
      resolve(answers)
    }
    socket.setTimeout(ms, done)
    socket.on('connect', () => socket.write(bytes))
    socket.on('data', (piece) => pieces.push(piece))
    for (const ending of ['end', 'close', 'error']) socket.on(ending, done)
  })
/** What a page's frame is allowed, and nothing else: its scripts, its forms, its dialogs, windows it opens, downloads, and holding the pointer. */
const PAGE_MAY = ['allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-downloads', 'allow-pointer-lock']
/** The whole policy every answer from where pages are shown carries, for a site reached at this address: the box a page is kept in, and that only that site may frame it. */
const pagesPolicy = (site) => ({ sandbox: PAGE_MAY, 'frame-ancestors': [site] })
/** The whole policy every answer of the site carries, for a site reached at this address whose pages are shown at that one. */
const sitePolicy = (site, pages) => ({
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'"],
  'connect-src': ["'self'", site.replace(/^http/, 'ws')],
  'frame-src': [pages],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
})
/**
 * A way through to the door on which the run can keep an answer back: a listener of the run's
 * own on this machine that passes on to the door whatever it is asked, and passes back whatever
 * the door answers. Told to, it keeps back the answer to the next request that names a given
 * function, until it is told to let it go: the door has answered by then, and whoever asked has
 * not heard. A machine that is told to reach It there is none the wiser.
 */
async function wayThrough(door) {
  const to = new URL(door)
  let wanted = null
  const server = http.createServer((req, res) => {
    const asked = []
    req
      .on('data', (piece) => asked.push(piece))
      .on('end', () => {
        const body = Buffer.concat(asked)
        const passedOn = http.request(
          { host: to.hostname, port: to.port, path: req.url, method: req.method, headers: { ...req.headers, host: to.host } },
          (answer) => {
            const answered = []
            answer
              .on('data', (piece) => answered.push(piece))
              .on('end', () => {
                const give = () => res.writeHead(answer.statusCode, answer.headers).end(Buffer.concat(answered))
                if (wanted && !wanted.kept && body.includes(wanted.names)) wanted.kept = give
                else give()
              })
          },
        )
        passedOn.on('error', () => res.destroy())
        passedOn.end(body)
      })
  })
  // A live connection is passed through as it is, byte for byte, once it has been asked for by the door's own name
  server.on('upgrade', (req, socket, head) => {
    const through = net.connect(Number(to.port), to.hostname, () => {
      const lines = Object.entries({ ...req.headers, host: to.host }).map(([name, value]) => `${name}: ${value}`)
      through.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      through.write(head)
      socket.pipe(through).pipe(socket)
    })
    for (const end of [socket, through])
      end.on('error', () => {
        socket.destroy()
        through.destroy()
      })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** Keeps back the answer to the next request whose body names this function. */
    keepBack: (names) => {
      wanted = { names, kept: null }
    },
    /** Whether that answer has come from the door, and is being kept. */
    keeping: () => Boolean(wanted?.kept),
    /** Lets the answer go to whoever asked, if one is kept, and keeps none back from then on. */
    letGo: () => {
      const give = wanted?.kept
      wanted = null
      give?.()
    },
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
/**
 * A way to the door from another of this machine's own addresses: a listener of the run's own
 * that a browser is told to make its requests through, and that makes each of them from the
 * address given. To the door, that browser is somebody at another address than everything else
 * the run sends from, and what the door counts against it is counted against nothing else.
 */
async function wayFrom(localAddress) {
  /** Where a request goes: to this machine at the address every address of its own reaches it by, and from the address given. */
  const to = (host, port) => ({ host: ['localhost', '127.0.0.1'].includes(host) ? '127.0.0.1' : host, port: Number(port), localAddress })
  const server = http.createServer((req, res) => {
    const asked = new URL(req.url)
    const passedOn = http.request(
      { ...to(asked.hostname, asked.port || 80), path: `${asked.pathname}${asked.search}`, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers)
        answer.pipe(res)
      },
    )
    passedOn.on('error', () => res.destroy())
    req.pipe(passedOn)
  })
  // A live connection is asked for as a tunnel, and passed through as it is
  server.on('connect', (req, socket, head) => {
    const [host, port] = req.url.split(':')
    const through = net.connect(to(host, port), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      through.write(head)
      socket.pipe(through).pipe(socket)
    })
    for (const end of [socket, through])
      end.on('error', () => {
        socket.destroy()
        through.destroy()
      })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    /** What a browser is told to make its requests through, this machine's own names among them. */
    proxy: { server: `http://127.0.0.1:${server.address().port}`, bypass: '<-loopback>' },
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
/**
 * A listener of the run's own at another address of this machine, which is another site to a
 * browser. It notes everything it is asked for. Asked for `/frames?<address>`, it answers with
 * a page that frames that address; asked for a script, with one that would leave a mark.
 */
async function anotherSite() {
  const asked = []
  const server = http.createServer((req, res) => {
    asked.push(req.url)
    const url = new URL(req.url, 'http://another.site')
    if (url.pathname === '/frames')
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<!doctype html><title>Another site</title><iframe id="framed" src="${url.search.slice(1).replace(/"/g, '')}"></iframe>`)
    if (url.pathname.endsWith('.js')) return res.writeHead(200, { 'content-type': 'text/javascript' }).end('window.ranFromAnotherSite = true\n')
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('from another site\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
/**
 * What becomes of an address when a page of another site frames it, in a tab of a browser: how
 * the address answered the browser, how much of what it answered with is shown in the frame,
 * and whether the browser said that it kept the answer out of the frame, in the words given.
 * The browser has done with the frame once it has said so, or has put the answer there.
 */
async function framedBy(other, browser, address, shows, keepsOut) {
  const since = Date.now()
  const saidSo = () => browser.problems.some((problem) => problem.own && problem.at >= since && keepsOut.test(problem.says))
  const tab = await browser.context.newPage()
  try {
    const answered = tab
      .waitForResponse((r) => r.url() === address, { timeout: 15_000 })
      .then(
        (r) => r.status(),
        () => 'no answer',
      )
    await tab.goto(`${other.origin}/frames?${address}`)
    const status = await answered
    const inTheFrame = () => tab.frameLocator('#framed').locator(shows).count()
    await until(async () => saidSo() || (await inTheFrame()) > 0, 15_000, 50)
    return { answered: status, shown: await inTheFrame(), keptOut: saidSo() }
  } finally {
    await tab.close()
  }
}
/**
 * The token a paired browser is given, asked for as the site asks, with what it says of the
 * session: one of the credentials a run holds. A tab that has not answered in half a minute is
 * waited for no more: the run stops there, and says what its browser had asked for and not
 * been answered, which is what the tab is waiting on.
 */
async function sessionOf(p) {
  const late = Symbol('late')
  const s = await Promise.race([
    p.evaluate(() => fetch('/session/token', { method: 'POST', headers: { 'x-it-site': '1' } }).then(async (r) => ({ status: r.status, ...(await r.json()) }))),
    sleep(30_000).then(() => late),
  ])
  if (s === late) {
    const its = opened.find((b) => b.context === p.context())
    throw new Error(
      `a tab at ${new URL(p.url()).pathname} that was asked whether its browser is paired did not answer in half a minute. Its browser had asked for, and not been answered: ${its?.unanswered().join('; ') || 'nothing'}`,
    )
  }
  noteSecret('a browser’s token', s.token)
  return s
}
/**
 * What a browser's cookies earn when a token is asked for with them, as the site asks: one
 * cookie, or all that a browser holds. The token is one of the credentials a run holds.
 * `answer` is the whole of what was answered, for what it does to the browser's cookies.
 */
async function tokenWith(cookies) {
  const answer = await plain(`${APP}/session/token`, { method: 'POST', headers: { 'x-it-site': '1', origin: APP, cookie: [cookies].flat().join('; ') } })
  const said = answer.status === 200 ? JSON.parse(answer.text) : {}
  noteSecret('a browser’s token', said.token)
  return { status: answer.status, token: said.token, session: said.session, role: said.role, answer }
}
/** Asks for a session to be ended as the site asks when a browser signs out: with the cookies the browser holds, and naming the session. */
const ending = (cookies, body) =>
  plain(`${APP}/session/end`, {
    method: 'POST',
    headers: { 'x-it-site': '1', origin: APP, 'content-type': 'application/json', cookie: [cookies].flat().join('; ') },
    body: JSON.stringify(body),
  })
/**
 * A browser that is only a script: the code in a pairing address is redeemed over HTTP, as the
 * site redeems it, and the cookie it is answered with is kept here. It holds a session, and
 * never opens the site or registers as a display. `holding` is the cookies the browser held
 * when it was paired, which it sends as a browser would. `redeemed` is the whole of what the
 * code was answered with.
 */
async function pairedByScript(address, { holding = [] } = {}) {
  const redeemed = await plain(`${APP}/session/redeem`, {
    method: 'POST',
    headers: { 'x-it-site': '1', origin: APP, 'content-type': 'application/json', ...(holding.length ? { cookie: holding.join('; ') } : {}) },
    body: JSON.stringify({ code: new URL(address).hash.slice(1) }),
  })
  // The new session's cookie is the first the answer sets. After it come the clearings of those that are over
  const cookie = String(redeemed.headers['set-cookie']?.[0] ?? '').split(';')[0]
  noteSecret('a browser’s session', cookie.slice(cookie.indexOf('=') + 1))
  return redeemed.status === 200 ? { cookie, redeemed, ...(await tokenWith(cookie)) } : { cookie, redeemed, status: redeemed.status }
}
/** A code a paired browser asks for, as the owner's does on its Displays and Machines pages: one that pairs a screen, or one that joins a machine. One of the credentials a run holds. */
async function codeFrom(browser, forWhat) {
  const made = await patiently(() => ask('mutation', forWhat === 'a machine' ? 'sessions:inviteMachine' : 'sessions:inviteScreen', {}, browser.token))
  if (typeof made.value?.code !== 'string') throw new Error(`a paired browser was given no code for ${forWhat} (${made.code ?? 'the answer held none'})`)
  noteSecret(forWhat === 'a machine' ? 'an invite for a machine' : 'a code that pairs a browser', made.value.code)
  return made.value.code
}
/**
 * What a code is said to be for, asked as the site asks before it uses one that came in its
 * address: the status, and with it `owner` or `screen` for a code that would pair a browser.
 * `at` is the site as whoever asks reaches it.
 */
const isFor = (code, at = APP) =>
  plain(`${at}/session/code`, {
    method: 'POST',
    headers: { 'x-it-site': '1', origin: at, 'content-type': 'application/json' },
    body: JSON.stringify(code === undefined ? {} : { code }),
  }).then((r) => `${r.status}${r.status === 200 ? ` ${JSON.parse(r.text).role}` : ''}`)
/** The name of the cookie one session is held in: every session's begins alike, and ends in the session's own id. */
/** How a session's cookie is kept, as the answer that sets it says: sent to the routes for a session and no others, out of any script's reach, never sent with a request another site caused, for a year. And how one is cleared. */
const SET_AS = 'HttpOnly; SameSite=Strict; Path=/session; Max-Age=31536000'
const CLEARED_AS = 'HttpOnly; SameSite=Strict; Path=/session; Max-Age=0'
/**
 * What an answer does to a browser's cookies, line by line: which session's cookie a line is
 * about, by the name the run gives that session, and whether the line sets it as a session's
 * cookie is set, or clears it. Nothing of what a cookie holds.
 */
const cookiesIn = (answer, sessions) =>
  (answer.headers['set-cookie'] ?? []).map((line) => {
    const [pair, ...kept] = line.split('; ')
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
    const whose = Object.keys(sessions).find((who) => cookieOf(sessions[who].session) === name) ?? 'a cookie under another name'
    if (value === '' && kept.join('; ') === CLEARED_AS) return `${whose} cleared`
    return /^[A-Za-z0-9_-]{43}$/.test(value) && kept.join('; ') === SET_AS ? `${whose} set` : `${whose} written in another way`
  })
/** What the backend answers a caller it refuses, or 'answered' when it does what was asked. */
const answerTo = async (kind, name, args, token) => {
  const said = await ask(kind, name, args, token)
  return said.ok ? 'answered' : said.code
}

/** What nothing but the CLI's own output may hold in full: a conversation's id is the agent's own to see, so the CLI may print it. */
const inFull = {}
/** Every place where what the run wrote down holds what it should not: each test machine's and browser's own record, what the CLI printed, what the backend kept, what was reported as usage, and the stack's log as it stands. */
async function whatIsHeld() {
  const held = await leaks([KEPT, ...stackLogs()])
  const notTheCli = readdirSync(KEPT)
    .filter((name) => !name.startsWith('cli.'))
    .map((name) => path.join(KEPT, name))
  held.found.push(
    ...(await leaks([...notTheCli, ...stackLogs().filter((file) => !path.basename(file).startsWith('cli.'))], inFull)).found.filter((f) =>
      Object.hasOwn(inFull, f.what),
    ),
  )
  return held
}
/** What a find of that kind is said as, when a check fails on it. */
const saidOf = (held) =>
  held.found
    .slice(0, 8)
    .map((f) => `${path.basename(f.file)}:${f.line} holds ${f.what}`)
    .join('; ')
/**
 * What a page or the site wrote to a browser's console that it should not have, by browser and
 * by kind. It was looked for in each thing as it was written, before the console was kept:
 * what is kept has had it taken out, and would not show it.
 */
const writtenToAConsole = () => opened.flatMap((b, i) => [...new Set(b.leaked)].map((what) => `the console of browser ${i + 1} was written ${what}`))

console.log(`site ${APP}, backend ${STACK.api}, browser ${BROWSER}`)
/** What became of a while with usage reporting turned off on a machine whose connector was running: how much had arrived before it and after, and what was kept to be sent. Null when that was not tried. */
let quietSince = null
// The agent whose conversation publishes in that while, and nowhere else in the run: whatever
// is reported of a page that agent published was counted while reporting was off
const QUIET_AGENT = 'hermes'
try {
  // Before anything is started: a program of the run's that looks for Claude Code or for Codex
  // finds the stand-in, and the app itself is in no folder it looks in. Were that not so, the
  // run would be about to run the apps of whoever started it, and it stops here instead.
  const reaches = reachesAnApp(itEnv(STACK.home))
  if (reaches) throw new Error(`The run starts nothing: ${reaches}.`)
  check('whatever the run starts finds a stand-in where it looks for Claude Code or for Codex, and neither app itself in any folder it looks in', !reaches)
  // The first code this run is refused is one that was used, and the run asks at its end that
  // the backend wrote that down. Where the stack wrote one down within the last minute, for a
  // run before this one, the rest of that minute is waited out first.
  const refusedLately = await codeLastRefusedAt()
  const quietIn = refusedLately ? refusedLately + 61_000 - Date.now() : 0
  if (quietIn > 0) {
    console.log(
      `  wait  ${Math.ceil(quietIn / 1000)} seconds: the stack was refused a code a moment ago, by a run before this one, and writes that down once a minute`,
    )
    await sleep(quietIn)
  }
  // The run's machines are installed by no script and run by no person at a terminal, so the
  // note the install script leaves is left for them: without it they would count nothing
  for (const h of ['b', 'c']) toldAboutUsage(home(h))
  // ------------------------------------------------------------------
  section('This machine, and one that joins')
  const B = home('b')
  const a = JSON.parse(readFileSync(path.join(A, 'machine.json'), 'utf8'))
  check(
    'the machine It runs on was enrolled when It was set up, and keeps only its own key',
    typeof a.id === 'string' && typeof a.key?.d === 'string' && Object.keys(a).sort().join() === 'id,key,name' && existsSync(path.join(A, 'service.json')),
    Object.keys(a).join(),
  )
  const me = await it(A, ['whoami'])
  check('the machine knows who it is', me.name === STACK_MACHINE && me.id === a.id)
  const invite = await inviteMachine()
  const b = await join(B, OTHER, { invite: async () => invite })
  const joined = JSON.parse(readFileSync(path.join(B, 'machine.json'), 'utf8'))
  check(
    'a second machine joins with an invite, with a key of its own, as another of the person’s machines',
    b.machine &&
      b.machine !== a.id &&
      joined.at === APP &&
      typeof joined.key?.d === 'string' &&
      joined.key.d !== a.key.d &&
      !existsSync(path.join(B, 'service.json')),
    JSON.stringify(b),
  )
  const late = await it(home('late'), ['login', '--url', APP, '--code', invite, '--name', marked('e2e late'), '--no-setup']).then(
    () => 'joined',
    (e) => e.code,
  )
  check('and an invite joins one machine, once', late === 'unauthenticated' && !existsSync(path.join(home('late'), 'machine.json')), late)
  const throughTheDoor = await it(B, ['whoami']).then(
    (m) => m.name,
    (e) => `refused: ${e.message}`,
  )
  check('a machine that joined reaches It through the door, with nothing but its own folder', throughTheDoor === OTHER, throughTheDoor)
  check('a folder where It was never set up is told to run setup', (await refused(it(home('nobody'), ['list']))) === 'not_set_up')
  const version = await it(A, ['version'], { raw: true })
  const help = await it(A, ['help'], { raw: true })
  const unknown = await it(A, ['no-such-command'], { raw: true })
  check(
    'the program says its version, lists its commands, and refuses one it does not have',
    version.code === 0 &&
      /^\d+\.\d+\.\d+$/.test(JSON.parse(version.out).version) &&
      help.code === 0 &&
      /it create/.test(help.out + help.err) &&
      unknown.code === 2 &&
      /"code":"invalid"/.test(unknown.err),
    JSON.stringify({ version: version.out.slice(0, 80), help: help.code, unknown: unknown.err.slice(0, 120) }),
  )

  // ------------------------------------------------------------------
  section('Publishing')
  const made = await it(A, [
    'create',
    marked('Deploy plan'),
    '--id',
    slug,
    '--dir',
    fixture,
    '--state',
    `{"status":"${PRIVATE_MARK}waiting","kept":"${PRIVATE_MARK}state"}`,
  ])
  check('a folder is published as a page', made.id === slug && made.version === 1 && made.url === `${APP}/p/${slug}`, JSON.stringify(made))
  const listed = await it(A, ['list'])
  check(
    'the page is listed by the id the agent chose',
    listed.some((p) => p.id === slug && p.title === marked('Deploy plan')),
  )
  // What is uploaded for a file is held to what was declared for it. A version is begun as the
  // command begins one, with one file declared, and the service is then sent, under the grant
  // it gave: other bytes of the declared length under the declared checksum, a file that was
  // not declared, and the declared bytes with no grant. Each is refused, and a version whose
  // file never arrived as declared is not published. The declared bytes are then taken.
  const uslug = `${slug}-up`
  const declared = Buffer.from(`<h1>What was declared ${PRIVATE_MARK}bytes</h1>`)
  const tampered = Buffer.from(declared.toString().replace('declared', 'tampered'))
  const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const asTheMachine = await machineToken(A)
  const begunByHand = await ask(
    'action',
    'publish:begin',
    { slug: uslug, title: marked('Uploaded by hand'), files: [{ path: 'index.html', size: declared.length, sha256: checksum(declared) }] },
    asTheMachine,
  )
  const grant = begunByHand.value?.upload?.grant
  noteSecret('a grant to upload a page’s files', grant)
  const sentUp = (name, bytes, by = grant) =>
    plain(`${begunByHand.value?.upload?.url}${name}`, {
      method: 'PUT',
      headers: { ...(by ? { authorization: `Bearer ${by}` } : {}), 'x-it-sha256': checksum(declared) },
      body: bytes,
    }).then(
      (r) => r.status,
      () => 'no answer',
    )
  const finishing = () => answerTo('action', 'publish:finish', { artifactId: begunByHand.value?.artifactId, version: begunByHand.value?.version }, asTheMachine)
  const uploads = {
    otherBytes: await sentUp('index.html', tampered),
    notDeclared: await sentUp('other.html', declared),
    noGrant: await sentUp('index.html', declared, null),
    finishedWithout: await finishing(),
    asDeclared: await sentUp('index.html', declared),
    finished: await finishing(),
  }
  check(
    'a file’s bytes are held to what was declared for it: other bytes of the same length, a file that was not declared, and an upload with no grant are each refused, a version whose file did not arrive as declared is not published, and the declared bytes are taken',
    begunByHand.ok &&
      tampered.length === declared.length &&
      JSON.stringify(uploads) ===
        JSON.stringify({ otherBytes: 400, notDeclared: 403, noGrant: 401, finishedWithout: 'invalid', asDeclared: 200, finished: 'answered' }) &&
      (await it(A, ['read', uslug])).version === 1,
    JSON.stringify({ begun: begunByHand.ok ? 'begun' : begunByHand.code, ...uploads }),
  )
  await it(A, ['delete', uslug])

  // ------------------------------------------------------------------
  section('A browser that is not paired')
  const one = began(await launch())
  const page = one.page
  // Each time it loads the site before it is paired, and each time the run asks as the site does
  nowNotPaired(one, 'a browser was opened that had not been paired yet', { asks: 8 })
  await page.goto(APP)
  const door = page.locator('main.door')
  check(
    'a browser that is not paired is shown how to pair it, and nothing else',
    (await until(() => door.isVisible())) && /it site/.test(await door.innerText()) && !(await paired(page)),
    (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200),
  )
  await page.goto(`${APP}/p/${slug}`)
  check(
    'and is shown no page at a page’s address',
    (await until(() => door.isVisible())) && (await page.locator('iframe').count()) === 0 && !(await page.content()).includes('Deploy plan'),
  )
  const asNobody = await page.evaluate(
    async (id) => ({
      token: await fetch('/session/token', { method: 'POST', headers: { 'x-it-site': '1' } }).then((r) => r.status),
      throughTheDoor: await fetch('/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'artifacts:get', args: { slug: id }, format: 'json' }),
      }).then(
        async (r) => (r.ok && (await r.json()).status === 'success' ? 'answered' : `refused (${r.status})`),
        () => 'refused (blocked)',
      ),
    }),
    slug,
  )
  const atTheBackend = [
    await answerTo('query', 'artifacts:list'),
    await answerTo('query', 'artifacts:get', { slug }),
    await answerTo('mutation', 'sessions:inviteOwner'),
    // Nor the one that gives the ticket a page is opened with
    await answerTo('action', 'mounts:ticket', { mountId: '0'.repeat(32) }),
  ]
  check(
    'it is given no session, and no function answers it: not through the door, and not at the backend itself',
    asNobody.token === 401 && asNobody.throughTheDoor.startsWith('refused') && atTheBackend.every((said) => said === 'unauthenticated'),
    JSON.stringify({ asNobody, atTheBackend }),
  )
  const SAYS_NO = 'That code is wrong, has already been used, or has run out.'
  await page.goto(APP)
  await page.getByLabel('Pairing code').fill('abcd efgh ijkl mnop qrst')
  // The code is put to the door, which answers that it is refused
  await provoking(one, [{ says: refusedWith(401), of: exactly(`${APP}/session/redeem`), because: 'a wrong code was typed' }], async () => {
    await page.getByRole('button', { name: 'Pair this browser' }).click()
    check('a wrong code is refused, and the browser is told so', (await until(() => page.getByText(SAYS_NO).isVisible())) && !(await paired(page)))
  })
  const pairs = await ownerAddress()
  await page.goto(pairs)
  check(
    'the address `it site` prints pairs the browser as the owner’s, and the code is gone from its address bar',
    (await until(() => paired(page), 20_000)) &&
      page.url() === `${APP}/` &&
      (await page.locator('header.bar nav a').allInnerTexts()).join() === 'Pages,Machines,Displays' &&
      (await sessionOf(page)).role === 'owner',
    (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200),
  )
  nowPairedOrClosed(one)
  const stranger = began(await launch())
  // It is never paired: it loads the site twice, and the run asks as the site does
  nowNotPaired(stranger, 'a second browser was opened and never paired', { asks: 8 })
  // The site asks what the code in its address is for, and is answered that it is refused
  await provoking(
    stranger,
    [{ says: refusedWith(401), of: exactly(`${APP}/session/code`), because: 'an address whose code was used was opened' }],
    async () => {
      await stranger.page.goto(pairs)
      check(
        'and the code works once: the same address pairs no second browser',
        (await until(() => stranger.page.getByText(SAYS_NO).isVisible(), 15_000)) &&
          !(await paired(stranger.page)) &&
          (await sessionOf(stranger.page)).status === 401,
      )
    },
  )
  // Where the browser has been is looked at: the address it is at, the one before and the one after
  const strangerWas = [stranger.page.url()]
  await stranger.page.goBack().catch(() => {})
  strangerWas.push(stranger.page.url())
  await stranger.page.goForward().catch(() => {})
  strangerWas.push(stranger.page.url())
  check(
    'and a refused code is left neither in the address nor in the browser’s history',
    !strangerWas.some((url) => url.includes('#')),
    strangerWas.map((url) => url.replace(/#.*/, '#…')).join(', '),
  )
  await stranger.page.goto(APP)

  // ------------------------------------------------------------------
  section('Showing')
  await page.goto(`${APP}/`)
  check('the site lists the page', await until(() => page.locator(`a.cover[href="/p/${slug}"]`).isVisible()))
  // Everything the first tab is answered from where pages are shown is noted, with the policy each answer carried
  const fromPages = []
  page.on('response', (r) => {
    if (new URL(r.url()).origin === APP) return
    void r.headerValue('content-security-policy').then(
      (policy) => fromPages.push({ origin: new URL(r.url()).origin, status: r.status(), policy: policy ?? '' }),
      () => {},
    )
  })
  await page.goto(`${APP}/p/${slug}`)
  const frame = page.frameLocator('.mount iframe')
  const frameUrl = (await pageIn(page, { id: slug })).url()
  check('the page shows inside the site', await frame.locator('h1').isVisible())
  // Where pages are shown, as the site was reached: read off the frame the page is in
  const pages = new URL(frameUrl).origin
  /** A showing's own address: where pages are shown, under a path made for that showing alone. */
  const SHOWING = /^http:\/\/[^/]+:\d+\/s\/[A-Za-z0-9_-]{43}\/v\/(\d+)\/index\.html$/
  check(
    'at an address of its own, away from the site’s, under a path that cannot be guessed and is that showing’s alone',
    SHOWING.test(frameUrl) && pages !== APP && SHOWING.exec(frameUrl)[1] === '1',
    frameUrl,
  )
  /** Runs something in whichever frame the first tab is showing a page in now. */
  const inShown = (fn, arg) => frameOf(page).evaluate(fn, arg)
  check(
    'its own script, stylesheet and image load',
    await until(() =>
      inShown(() => window.scriptLoaded === true && document.getElementById('logo').naturalWidth > 0 && getComputedStyle(document.body).marginLeft === '40px'),
    ),
  )
  check(
    'It is there before the page’s own script runs',
    await inShown(() => typeof window.It?.action === 'function' && window.It.id.startsWith('plan-') && window.It.version === 1),
  )
  check(
    'the starting state is bound into the page',
    await until(() => inShown((first) => document.getElementById('status').textContent === first, `${PRIVATE_MARK}waiting`)),
  )
  // The frame the site made, and what the browser was told with each answer for it
  const framed = await page.locator('.mount iframe').evaluate((f) => ({ src: f.src, sandbox: f.getAttribute('sandbox') ?? '' }))
  const refusedThere = [
    await plain(`${pages}/`),
    await plain(`${pages}/v/1/index.html`),
    await plain(frameUrl.replace(/\/s\/[^/]+\//, `/s/${'A'.repeat(43)}/`)),
    await plain(`${pages}/open/not-a-ticket`),
  ]
  // The same four, and the page's own first file, asked for by another of this machine's names
  const byItsAddress = (url) => url.replace('//localhost:', '//127.0.0.1:')
  const byTheOtherName = [...[`${pages}/`, `${pages}/v/1/index.html`, `${pages}/open/not-a-ticket`].map(byItsAddress), byItsAddress(frameUrl)]
  const answeredThere = []
  for (const url of byTheOtherName) answeredThere.push(await plain(url))
  const toldOf = (answers) => [...new Set(answers.map((r) => String(r.headers?.['content-security-policy'] ?? r.policy)))]
  check(
    'every answer from where pages are shown carries one policy, whole: the page is kept in a box of its own, which is never the site’s origin and can never move the tab, and only the site may frame it. A page’s files carry it, and each refusal',
    fromPages.length >= 5 &&
      fromPages.every((r) => r.origin === pages && saysExactly(r.policy, pagesPolicy(APP))) &&
      refusedThere.every((r) => saysExactly(r.headers['content-security-policy'], pagesPolicy(APP))) &&
      spelled({ sandbox: framed.sandbox.split(/\s+/) }) === spelled({ sandbox: PAGE_MAY }),
    JSON.stringify([...toldOf(fromPages), ...toldOf(refusedThere), framed.sandbox]),
  )
  check(
    'and reached by another of this machine’s names, they carry the same, naming the site by that name',
    answeredThere.at(-1).status === 200 && answeredThere.every((r) => saysExactly(r.headers['content-security-policy'], pagesPolicy(byItsAddress(APP)))),
    JSON.stringify(toldOf(answeredThere)),
  )
  // What the door answers by itself where pages are shown, to whatever is sent there: a request
  // to a name that is not the machine's, one that names nobody, one with more headers than are
  // taken, a WebSocket, a tunnel, a method there is none of, and what is no request at all. A
  // browser would show any answer from that port as a document at the pages' own address, so
  // each one says that it is a sandboxed document, or nothing is answered at all.
  const pagesAt = new URL(pages)
  const named = `Host: ${pagesAt.host}\r\n`
  const sentThere = {
    'a request to another name': `GET / HTTP/1.1\r\nHost: other.invalid:${pagesAt.port}\r\nConnection: close\r\n\r\n`,
    'a request that names nobody': 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n',
    'a request of the older kind that names nobody': 'GET / HTTP/1.0\r\n\r\n',
    'headers longer than are taken': `GET / HTTP/1.1\r\n${named}Cookie: x=${'A'.repeat(18_000)}\r\nConnection: close\r\n\r\n`,
    'a WebSocket asked for': `GET / HTTP/1.1\r\n${named}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
    'a body far longer than any is taken': `POST / HTTP/1.1\r\n${named}Content-Length: 1000000000\r\nConnection: close\r\n\r\n`,
    'a request that waits to be told to go on': `POST / HTTP/1.1\r\n${named}Expect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    'a tunnel asked for': `CONNECT ${pagesAt.host} HTTP/1.1\r\n${named}\r\n`,
    'a method there is none of': `XXXXX / HTTP/1.1\r\n${named}\r\n`,
    'a method the door does not take': `TRACE / HTTP/1.1\r\n${named}Connection: close\r\n\r\n`,
    'a header that is none': `GET / HTTP/1.1\r\n${named}Bad Header: x\r\n\r\n`,
    'a version there is none of': `GET / HTTP/9.9\r\n${named}\r\n`,
    'what is no request at all': Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03, 0x0d, 0x0a, 0x0d, 0x0a]),
  }
  const saidThere = await Promise.all(Object.entries(sentThere).map(async ([kind, bytes]) => [kind, await saidTo(Number(pagesAt.port), bytes)]))
  /** Whether an answer says it is a sandboxed document, allowed what a page's frame is and no more, that nothing but one site may frame, and sets no cookie. */
  const saysItIsBoxed = ({ headers }) => {
    const says = policyOf(headers['content-security-policy'])
    return spelled({ sandbox: says.sandbox ?? [] }) === spelled({ sandbox: PAGE_MAY }) && says['frame-ancestors']?.length === 1 && !('set-cookie' in headers)
  }
  // Nobody is told to go on before they are answered: what is said there carries no policy, so
  // a request that waits for it is answered as it stands, once, like any other
  const statusesThere = Object.fromEntries(saidThere.map(([kind, answers]) => [kind, answers.map((answer) => answer.status).join() || 'nothing']))
  check(
    'whatever is sent to where pages are shown, down to what is no request at all, the door answers once at most, and an answer says it is a sandboxed document that sets no cookie: a request to another name, a method the door does not take and a request that waits to be told to go on are answered so, and what it cannot answer so it answers with nothing',
    saidThere.every(([, answers]) => answers.length <= 1 && answers.every(saysItIsBoxed)) &&
      statusesThere['a request to another name'] === '421' &&
      statusesThere['a method the door does not take'] === '405' &&
      /^[2-5]\d\d$/.test(statusesThere['a request that waits to be told to go on']),
    JSON.stringify({
      statuses: statusesThere,
      notBoxed: saidThere
        .filter(([, answers]) => !answers.every(saysItIsBoxed))
        .map(([kind, answers]) => [kind, answers[0]?.headers['content-security-policy'] ?? 'no policy']),
    }),
  )
  // And a browser holds a page to it. A page of another site frames the address the page is
  // shown at, which answers it as it answers anyone who has the address, and nothing of the
  // page is put in that frame
  const anotherOne = await anotherSite()
  // The browser keeps what the address answers out of that frame, and says that it did
  const keepsAPageOut = againstPolicy(`Framing '${pages}/'`, `frame-ancestors ${APP}`)
  const framedElsewhere = await provoking(stranger, [{ says: keepsAPageOut, because: 'another site framed the address a page is shown at' }], () =>
    framedBy(anotherOne, stranger, frameUrl, 'h1', keepsAPageOut),
  )
  check(
    'a page of another site that frames the address a page is shown at is answered, and is shown nothing of the page: the browser keeps it out of that frame',
    framedElsewhere.answered === 200 && framedElsewhere.shown === 0 && framedElsewhere.keptOut,
    JSON.stringify(framedElsewhere),
  )
  // What a page has of the browser's, asked from inside it. Each thing is tried, and what became of the try is noted
  // The page asks the site for the browser's session and for a function's answer, which the
  // browser will not let it read, and for the live connection, which the door refuses it
  const askedOfTheSite = during(one, [
    { says: notLetRead(`${APP}/session/token`), because: 'a page asked the site for the browser’s session' },
    { says: notMade('ERR_FAILED'), of: exactly(`${APP}/session/token`), because: 'the browser gave the page no answer about the session' },
    { says: notLetRead(`${APP}/api/query`), because: 'a page asked the site for a function’s answer' },
    { says: notMade('ERR_FAILED'), of: exactly(`${APP}/api/query`), because: 'the browser gave the page no answer from a function' },
    { says: noConnectionTo(APP), because: 'a page asked the door for the live connection' },
  ])
  const has = await inShown(async (site) => {
    const tried = (fn) => {
      try {
        return String(fn())
      } catch (e) {
        return `refused: ${e.name}`
      }
    }
    const asked = (ask) =>
      ask().then(
        (r) => (typeof r === 'string' ? r : `answered ${r.status}`),
        (e) => `refused: ${e.name}`,
      )
    localStorage.setItem('kept', 'by the page')
    return {
      origin: self.origin,
      cookie: tried(() => document.cookie),
      settingOne: tried(() => {
        // biome-ignore lint/suspicious/noDocumentCookie: setting one this way is the very thing a page is to be refused
        document.cookie = 'mine=1'
        return document.cookie
      }),
      databases: tried(() => typeof indexedDB.open('mine')),
      caches: await asked(async () => `answered ${(await caches.keys()).length}`),
      leaving: await asked(async () => navigator.serviceWorker.register('left-behind.js').then(() => 'registered')),
      keptForNow: localStorage.getItem('kept'),
      inItsAddress: /[?#]/.test(location.href),
      theSite: tried(() => window.parent.location.href),
      theSitesStorage: tried(() => window.parent.localStorage.length),
      referrer: document.referrer,
      session: await asked(() => fetch(`${site}/session/token`, { method: 'POST', headers: { 'x-it-site': '1' }, credentials: 'include' })),
      call: await asked(() =>
        fetch(`${site}/api/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: '{"path":"artifacts:list","args":{},"format":"json"}',
        }),
      ),
      live: await new Promise((resolve) => {
        const ws = new WebSocket(`${site.replace(/^http/, 'ws')}/api/1.0.0/sync`)
        ws.onopen = () => resolve('opened')
        ws.onerror = () => resolve('refused')
        setTimeout(() => resolve('no answer'), 5000)
      }),
    }
  }, APP).catch((e) => ({ threw: String(e) }))
  askedOfTheSite()
  check(
    'a page’s origin is nobody’s: it cannot read or set a cookie, and has no database, cache or script of the browser’s to leave anything in',
    has.origin === 'null' &&
      has.cookie?.startsWith('refused') &&
      has.settingOne.startsWith('refused') &&
      has.databases.startsWith('refused') &&
      has.caches.startsWith('refused') &&
      has.leaving.startsWith('refused') &&
      has.inItsAddress === false,
    JSON.stringify(has),
  )
  check(
    'it cannot read the site that frames it, ask for the browser’s session, call a function or open the live connection',
    has.theSite?.startsWith('refused') &&
      has.theSitesStorage.startsWith('refused') &&
      has.referrer === '' &&
      has.session.startsWith('refused') &&
      has.call.startsWith('refused') &&
      has.live === 'refused',
    JSON.stringify(has),
  )
  const itsSession = (await sessionOf(page)).session
  const aYearOn = Date.now() / 1000 + 31_536_000
  const browsersCookies = (await one.context.cookies()).map((c) =>
    [
      c.name === cookieOf(itsSession) ? 'the cookie named for its session' : 'a cookie under another name',
      /^[A-Za-z0-9_-]{43}$/.test(c.value) ? 'which holds a session’s secret' : 'which holds something else',
      `for ${c.path}`,
      c.httpOnly ? 'out of any script’s reach' : 'in reach of a script',
      c.sameSite,
      Math.abs(c.expires - aYearOn) < 86_400 ? 'kept for a year' : 'kept for another while',
    ].join(', '),
  )
  check(
    'showing a page leaves no cookie: the only one the browser holds is its own session’s, named for that session, which goes to the routes for it and nowhere else',
    browsersCookies.length === 1 &&
      browsersCookies[0] ===
        'the cookie named for its session, which holds a session’s secret, for /session, out of any script’s reach, Strict, kept for a year',
    browsersCookies.join('; '),
  )
  const again = await plain(framed.src)
  check(
    'the ticket that opened the page opens nothing a second time',
    /\/open\/[^/]+$/.test(framed.src) && again.status === 401 && again.bytes === 0,
    again.status,
  )
  // The page asks for a file of another version, which is not at its showing's address, and
  // tries to take its tab elsewhere, which the browser does not let a page in that frame do
  const triedFromInside = during(one, [
    {
      says: refusedWith(404),
      of: exactly(`${pages}/s/[a showing’s address]/v/2/index.html`),
      showing: showingOf(frameOf(page).url()),
      because: 'a page asked for the first file of another version',
    },
    { says: mayNotLeave(`${APP}/p/${slug}`), because: 'a page tried to take its tab elsewhere' },
  ])
  const inside = await inShown(async () => ({
    big: await window.It.action('too-big', { text: 'x'.repeat(40_000) }).then(
      () => 'accepted',
      () => 'refused',
    ),
    otherVersion: await fetch('../2/index.html').then(
      (r) => r.status,
      () => 'refused',
    ),
    part: await fetch('img/e2e-private-logo.svg', { headers: { range: 'bytes=0-9' } }).then(async (r) => `${r.status} ${(await r.arrayBuffer()).byteLength}`),
    away: (() => {
      try {
        // An address on this machine where nothing listens: a tab that did leave would reach nobody
        window.top.location = 'http://127.0.0.1:9/'
        return 'allowed'
      } catch {
        return 'refused'
      }
    })(),
  })).catch((e) => ({ threw: String(e) }))
  // The browser says by itself that it refused each of the two, and the tab is looked at once it has
  const saidItRefused = await triedFromInside.said()
  triedFromInside()
  check(
    'from inside, a page cannot send more than an action may carry, read another version, or take the tab elsewhere',
    inside.big === 'refused' && inside.otherVersion === 404 && inside.away === 'refused' && saidItRefused && page.url() === `${APP}/p/${slug}`,
    JSON.stringify({ ...inside, saidItRefused, tabAt: new URL(page.url()).pathname }),
  )
  check('and may ask for part of a file', inside.part === '206 10', inside.part)
  // The same page shown again is another showing, and what the page kept in the first is not in it
  await page.goto(`${APP}/p/${slug}`)
  const shownAgain = (await pageIn(page, { id: slug })).url()
  check(
    'shown again, the page is at another address, and has nothing of what it kept for itself the first time',
    has.keptForNow === 'by the page' && SHOWING.test(shownAgain) && shownAgain !== frameUrl && (await inShown(() => localStorage.getItem('kept'))) === null,
    shownAgain,
  )
  // A page's files are at its showing's own path and nowhere else
  const atItsOwn = await plain(new URL('app.js', shownAgain).href)
  const refusals = {
    'at the root': (await plain(`${pages}/v/1/app.js`)).status,
    'under a path nobody was given': (await plain(new URL('app.js', shownAgain).href.replace(/\/s\/[^/]+\//, `/s/${'A'.repeat(43)}/`))).status,
    'as another version': (await plain(new URL('../2/app.js', shownAgain).href)).status,
    'by a ticket that is none': refusedThere[3].status,
  }
  check(
    'a page’s files are given at its showing’s own path, and at any other path are refused, with no bytes',
    atItsOwn.status === 200 &&
      atItsOwn.bytes > 0 &&
      Object.values(refusals).every((status) => status === 401 || status === 404) &&
      refusedThere.every((r) => r.bytes === 0),
    JSON.stringify({ 'at its own': atItsOwn.status, ...refusals }),
  )

  // Another page, shown at the same time in another tab of the same browser. It has a file the
  // first has not, and the first is asked from inside for what it can find of the other.
  const oslug = `${slug}-o`
  const otherPage = path.join(tmp, 'other-page')
  mkdirSync(otherPage)
  writeFileSync(path.join(otherPage, 'index.html'), `<h1>Other ${PRIVATE_MARK}page</h1><script src="only-here.js"></script>`)
  writeFileSync(path.join(otherPage, 'only-here.js'), 'window.onlyHere = true\n')
  await it(A, ['create', marked('Other page'), '--id', oslug, '--dir', otherPage])
  const beside = await one.context.newPage()
  await beside.goto(`${APP}/p/${oslug}`)
  const theOthers = (await pageIn(beside, { id: oslug })).url()
  // A channel that every document of one origin shares. The page listens on it, and is listening
  // before the other page says anything there.
  await inShown(() => {
    window.heardFromTheOther = 'nothing'
    window.betweenPages = new BroadcastChannel('between-pages')
    window.betweenPages.onmessage = () => {
      window.heardFromTheOther = 'heard'
    }
  })
  // The other page keeps something and speaks on the channel, and listens there itself on a
  // second channel of its own, which is told whatever any document of its origin says. Once it
  // has heard itself, what it said has gone to everyone it goes to.
  const theOtherHeardItself = await frameOf(beside).evaluate(
    () =>
      new Promise((resolve) => {
        localStorage.setItem('kept', 'by the other page')
        window.listensToItself = new BroadcastChannel('between-pages')
        window.listensToItself.onmessage = () => resolve(true)
        setTimeout(() => resolve(false), 10_000)
        new BroadcastChannel('between-pages').postMessage('from the other page')
      }),
  )
  // The page asks, where its own files are, for a file that only the other page has
  const askedForTheOthers = during(one, [
    {
      says: refusedWith(404),
      of: exactly(`${pages}/s/[a showing’s address]/v/1/only-here.js`),
      showing: showingOf(frameOf(page).url()),
      because: 'a page asked for another page’s file at its own address',
    },
  ])
  const between = await inShown(async () => {
    const tried = (fn) => {
      try {
        return String(fn())
      } catch (e) {
        return `refused: ${e.name}`
      }
    }
    return {
      // The other page's file, asked for where this page's own files are
      theOthersFile: await fetch('only-here.js').then(
        (r) => r.status,
        () => 'refused',
      ),
      whereTheSiteIs: tried(() => window.parent.location.href),
      kept: localStorage.getItem('kept'),
      heard: window.heardFromTheOther,
    }
  })
  askedForTheOthers()
  const theOthersOwn = await frameOf(beside).evaluate(() => window.onlyHere === true && fetch('only-here.js').then((r) => r.status))
  // What leaves a page says nothing of where it is shown. The page asks for something at
  // another address, which is a listener of the run's own on this machine, in each way a page
  // may: a fetch, a picture, and a link that is followed in a window of its own. And what the
  // site has said to the page since it loaded is looked through for an address.
  const leavesWith = []
  const elsewhere = http.createServer((req, res) => {
    leavesWith.push({ asked: req.url, referer: req.headers.referer ?? null })
    res.writeHead(204).end()
  })
  await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
  await inShown(async (to) => {
    await fetch(`${to}/fetched`, { mode: 'no-cors' }).catch(() => {})
    await new Promise((resolve) => {
      const picture = new Image()
      picture.onload = picture.onerror = resolve
      picture.src = `${to}/pictured`
    })
    const link = Object.assign(document.createElement('a'), { href: `${to}/followed`, target: '_blank', textContent: 'elsewhere' })
    document.body.append(link)
    link.click()
    link.remove()
  }, `http://127.0.0.1:${elsewhere.address().port}`)
  // Each of the three has left the page once the listener has been asked for it
  await until(() => ['/fetched', '/pictured', '/followed'].every((asked) => leavesWith.some((left) => left.asked === asked)), 15_000, 50)
  const heardFromTheSite = await inShown(() => window.heardFromTheSite)
  elsewhere.closeAllConnections()
  await new Promise((resolve) => elsewhere.close(resolve))
  // The window the link opened is closed again
  for (const opened_ of one.context.pages()) if (opened_ !== page && opened_ !== beside) await opened_.close().catch(() => {})
  check(
    'two pages shown at once in one browser are at the same port, at paths of their own, and one’s path does not lead to the other’s files',
    SHOWING.test(theOthers) &&
      new URL(theOthers).origin === pages &&
      theOthers.split('/')[4] !== shownAgain.split('/')[4] &&
      theOthersOwn === 200 &&
      between.theOthersFile === 404,
    JSON.stringify({ theOthers, theOthersOwn, theOthersFile: between.theOthersFile }),
  )
  check(
    'and one cannot see the site they are both shown in, hear the other, or read what it kept: each is alone in the browser',
    between.whereTheSiteIs.startsWith('refused') && between.kept === null && theOtherHeardItself && between.heard === 'nothing',
    JSON.stringify({ ...between, theOtherHeardItself }),
  )
  check(
    'nothing tells a page where another is shown, or tells anyone else where it is: what leaves it for another address says nothing of where it came from, and nothing the page’s own script hears from the site holds an address',
    ['/fetched', '/pictured', '/followed'].every((asked) => leavesWith.some((left) => left.asked === asked)) &&
      leavesWith.every((left) => left.referer === null) &&
      Array.isArray(heardFromTheSite) &&
      !heardFromTheSite.some((said) => /\/s\/|\/open\/|https?:/.test(said)),
    JSON.stringify({ leavesWith, heardFromTheSite }),
  )
  await beside.close()
  await it(A, ['delete', oslug])

  // Forty tabs, opened ten at a time and all left open: more than a person is likely to have
  // open at once
  const many = []
  const manyFrames = []
  // Ten tabs opened at one moment each ask for a token, which is more than a session is given
  // in one go: a tab that is told to wait asks again, and is shown its page all the same
  // No oftener than the browser was seen to ask for a token while they were open
  let tokensAsked = 0
  const tokenAsked = (request) => {
    if (request.method() === 'POST' && request.url() === `${APP}/session/token`) tokensAsked += 1
  }
  one.context.on('request', tokenAsked)
  const toldToWait = during(one, [
    { says: refusedWith(429), of: exactly(`${APP}/session/token`), times: () => tokensAsked, because: 'forty tabs asked for tokens at once' },
  ])
  for (let batch = 0; batch < 4; batch++) {
    const more = await Promise.all(Array.from({ length: 10 }, () => one.context.newPage()))
    many.push(...more)
    // A tab whose page is not shown in time has no frame, and is counted below as one that is not there
    manyFrames.push(
      ...(await Promise.all(
        more.map(async (tab) => {
          await tab.goto(`${APP}/p/${slug}`)
          return pageIn(tab, { id: slug, ms: 40_000 }).catch(() => null)
        }),
      )),
    )
  }
  const manyShown = manyFrames.map((f) => f?.url() ?? '')
  const manyAlive = await Promise.all(
    manyFrames.map((f) =>
      f
        ? f.evaluate(() =>
            fetch('app.js').then(
              (r) => r.status,
              () => 0,
            ),
          )
        : 0,
    ),
  )
  check(
    'forty pages are shown one after another and are all there at once, each at an address of its own',
    new Set(manyShown.filter((url) => SHOWING.test(url))).size === 40 &&
      manyAlive.every((status) => status === 200) &&
      (await inShown(() => fetch('app.js').then((r) => r.status))) === 200,
    `${new Set(manyShown.filter(Boolean)).size} addresses; ${manyAlive.filter((status) => status === 200).length} answering`,
  )
  await Promise.all(many.map((tab) => tab.close()))
  toldToWait()
  one.context.off('request', tokenAsked)
  // The last of them is the showing that nothing keeps alive from here on: its tab is closed,
  // and nothing asks for it again until the run is nearly done
  const leftAlone = { url: manyShown.at(-1), since: Date.now() }

  // ------------------------------------------------------------------
  section('State')
  await it(A, ['set', slug, 'status', DEPLOYING])
  check(
    'a state change reaches the open page without a reload',
    await until(() => inShown((now) => document.getElementById('status').textContent === now, DEPLOYING)),
  )
  check('and the page’s own listener hears it', await until(() => inShown((now) => document.title === `state ${JSON.stringify(now)}`, DEPLOYING)))
  const hiddenBefore = await inShown(() => getComputedStyle(document.getElementById('done')).display === 'none')
  await it(A, ['patch', slug, `{"finished":true,"steps":{"build":"${PRIVATE_MARK}done"}}`])
  check(
    'a patch merges, and a shown-when element appears that was hidden before',
    hiddenBefore && (await until(() => inShown(() => getComputedStyle(document.getElementById('done')).display !== 'none'))),
    `hidden before: ${hiddenBefore}`,
  )
  check(
    'a change made against a revision that has moved on is refused, and changes nothing',
    (await refused(it(A, ['patch', slug, `{"status":"${PRIVATE_MARK}overwritten"}`, '--if-revision', '1']))) === 'conflict' &&
      (await it(A, ['state', slug])).state.status === DEPLOYING,
  )
  const st = await it(A, ['state', slug])
  check(
    'the agent reads back the merged state',
    st.state.status === DEPLOYING && st.state.steps.build === `${PRIVATE_MARK}done` && st.revision === 3,
    JSON.stringify(st),
  )
  await it(A, ['patch', slug, '{"進捗":{"$step":3}}'])
  check('state may use keys in any alphabet', (await it(A, ['state', slug])).state.進捗?.$step === 3)

  // ------------------------------------------------------------------
  section('Clicks')
  // Before anyone has touched the page, its own script sends an action
  await page.locator('.page-title').click()
  await inShown((mark) => window.It.action('auto', { note: `${mark}nobody clicked` }), PRIVATE_MARK)
  const auto = await until(async () => (await it(A, ['actions', '--id', slug])).find((x) => x.action === 'auto'))
  check('an action a page sends by itself is marked as such for the agent', auto?.sentByThePageItself === true, JSON.stringify(auto))
  const full = auto ? await it(A, ['action', auto.id]) : {}
  check(
    'and reads so in the words the agent is given',
    /sent this with no sign that anyone had just used it: auto/.test(full.text ?? '') && full.text.endsWith(`[action ${auto?.id}]`),
    full.text,
  )
  if (auto) await it(A, ['ack', auto.id])
  const waiting = await waitingAgent(A, ['--id', slug, '--timeout', '30'])
  await frame.locator('#approve').click()
  const got = await waiting.answered
  check(
    'a click reaches a waiting agent, with its name and data, and which version of the page it was made on',
    got.action === 'approve' &&
      got.data?.plan === PLAN &&
      got.page === slug &&
      got.version === 1 &&
      got.pageIsNowAtVersion === undefined &&
      got.stateIsNowAtRevision === undefined,
    JSON.stringify(got),
  )
  check('and a click a person made is not marked as the page’s own', got.sentByThePageItself === undefined, JSON.stringify(got))
  check('the page is told its click was accepted', await until(() => inShown(() => document.getElementById('sent').textContent === 'accepted')))
  check('the site says the agent has it', await until(() => page.locator('.status', { hasText: 'Your agent has it' }).isVisible()))

  await frame.locator('#pick-a').click()
  await frame.locator('#pick-b').click()
  await frame.locator('#commit').click()
  const staged = await until(async () => (await it(A, ['actions', '--id', slug])).find((x) => x.action === 'configure'))
  check(
    'staged choices arrive as one action when committed',
    staged?.data?.region === `${PRIVATE_MARK}eu` && staged?.data?.size === `${PRIVATE_MARK}large`,
    JSON.stringify(staged),
  )
  check('and are cleared in the page only once accepted', await until(() => inShown(() => document.getElementById('committed').textContent === '{}')))
  check('the site says it is waiting for the agent', await until(() => page.locator('.status', { hasText: /Waiting for/ }).isVisible()))
  const acked = staged ? await it(A, ['ack', staged.id]) : {}
  check('an agent can mark an action handled', acked.outcome === 'succeeded' && !(await it(A, ['actions', '--id', slug])).some((x) => x.id === staged?.id))

  await frame.locator('#remember').click()
  check(
    'what a page stores for itself comes back through its state',
    await until(() => inShown((draft) => document.getElementById('draft').textContent === draft, `hello from the page ${PRIVATE_MARK}draft`)),
  )
  check('and lives under the page’s own key', (await it(A, ['state', slug])).state._page?.draft === `hello from the page ${PRIVATE_MARK}draft`)

  // ------------------------------------------------------------------
  section('Versions')
  const before2 = frameOf(page).url()
  const v2 = await it(A, ['update', slug, '--html', '<h1 id="v">version two</h1><p data-it-bind="status"></p>'])
  check('an update is a new version of the same page', v2.version === 2)
  // The site shows the new version by itself, in a frame of its own. Nothing here stops the run
  // when it does not: the checks say so
  const frame2 = await pageIn(page, { id: slug, version: 2 }).catch(() => undefined)
  check('the open page changes to it by itself', Boolean(frame2) && (await page.frameLocator('.mount iframe').locator('#v').isVisible()))
  const stateShown = await until(
    () =>
      page
        .frameLocator('.mount iframe')
        .locator('p')
        .evaluate((el, now) => el.textContent === now, DEPLOYING)
        .catch(() => false),
    15_000,
  )
  check(
    'in a showing of its own, at another address, and still with its state',
    frame2 && SHOWING.test(frame2.url()) && frame2.url().split('/')[4] !== before2.split('/')[4] && stateShown,
    `frames: ${page
      .frames()
      .map((f) => f.url())
      .join(' ')}; state shown: ${stateShown}`,
  )
  const back = await it(A, ['rollback', slug, '1'])
  check(
    'rolling back shows the earlier version again',
    back.version === 1 &&
      Boolean(await pageIn(page, { id: slug, version: 1 }).catch(() => undefined)) &&
      (await page.frameLocator('.mount iframe').locator('#approve').isVisible()),
  )

  // ------------------------------------------------------------------
  section('Displays and notifications')
  const displays = await it(A, ['displays'])
  check(
    'the browser registered itself as a display, with a generated name',
    displays.length >= 1 && displays.some((d) => /^(Chrome|Firefox) on /.test(d.name) && !d.named),
    JSON.stringify(displays),
  )
  await page.goto(`${APP}/`)
  await page.locator('.chip.ask', { hasText: 'Name this display' }).click()
  await page.locator('.reminders input').fill(WALL)
  await page.locator('.reminders button[type=submit]').click()
  check('the person names the display from the top bar', await until(async () => (await it(A, ['displays'])).some((d) => d.name === WALL && d.named)))
  const shownOnWall = await it(A, ['open', slug, '--on', WALL.toLowerCase()])
  check('an agent brings a page up on a display by name', shownOnWall.shownOn.includes(WALL) && (await until(() => page.url().endsWith(`/p/${slug}`))))
  const nowhere = await it(A, ['open', slug, '--on', 'nowhere']).then(
    () => ({}),
    (e) => e,
  )
  check(
    'a display that does not exist is refused, with the names that do',
    nowhere.code === 'not_found' && nowhere.stderr.includes('No display is called \\"nowhere\\"') && nowhere.stderr.includes(WALL),
    nowhere.stderr,
  )
  // A page published and then not shown is still published, and the agent is told its id as well as why
  const unshown = await it(A, ['create', marked('Not shown'), '--id', `${slug}-u`, '--html', '<p>u</p>', '--open', '--on', 'nowhere'], { raw: true })
  const answered = (() => {
    try {
      return JSON.parse(unshown.out)
    } catch {
      return {}
    }
  })()
  check(
    'a page that is published and cannot be shown where asked is still said to be published, with why it was not shown',
    unshown.code === 1 &&
      answered.id === `${slug}-u` &&
      answered.version === 1 &&
      answered.notShown?.code === 'not_found' &&
      (await it(A, ['read', `${slug}-u`])).id === `${slug}-u`,
    `${unshown.out} ${unshown.err}`.slice(0, 300),
  )
  await it(A, ['delete', `${slug}-u`])
  // A toast is for something that arrives while the site is open; what came earlier waits in
  // the tray. The site is open, for that, once it has been given its notifications and is told
  // of each new one, and the notification is sent then.
  const toldOfNotifications = keptToldOf(page)
  await page.goto(`${APP}/`)
  await until(() => page.locator('header.bar').isVisible())
  await awaited('the site that was opened was not given its notifications', () => toldOfNotifications.has('notifications:list'), 20_000, 50)
  toldOfNotifications.stop()
  const NOTE = `The deploy finished (${PRIVATE_MARK}${slug.slice(-5)})`
  await it(A, ['notify', NOTE, '--id', slug, '--button', 'Roll back=rollback', '--button', 'Fine=ok'])
  check('a notification appears as a toast', await until(() => page.locator('.toast', { hasText: NOTE }).isVisible()))
  check('and is counted on the bell', await until(() => page.locator('.bell .count').isVisible()))
  await page.locator('.toast button', { hasText: 'Roll back' }).click()
  const pressed = await until(async () => (await it(A, ['actions', '--id', slug])).find((x) => x.action === 'rollback'))
  check('pressing its button comes back as an action on the page', Boolean(pressed), JSON.stringify(pressed))
  if (pressed) await it(A, ['ack', pressed.id, '--failed'])
  await page.locator('.bell').click()
  check('and it is kept in the tray, where it can be read again', await until(() => page.locator('.tray-panel', { hasText: NOTE }).isVisible()))
  await page.keyboard.press('Escape')
  await page.goto(`${APP}/p/${slug}`)
  check(
    'an agent that could not do what was asked can say so, and the site tells the person',
    await until(() => page.locator('.status', { hasText: 'Your agent could not do that' }).isVisible(), 15_000),
  )
  // The site says that above the page, and may say it before it has shown the page. What follows reads the page's frame
  await pageIn(page, { id: slug })

  // ------------------------------------------------------------------
  section('The door')
  // By this machine's own address, under a name that is not this machine's: what a page on
  // some other site reaches when its name is made to point here
  const byName = (port, name) => plain(`http://127.0.0.1:${port}/`, { headers: { host: name } })
  const pagesPort = new URL(frameOf(page).url()).port
  const strangers = [
    await byName(STACK.port, 'evil.example'),
    await byName(STACK.port, `evil.example:${STACK.port}`),
    await byName(pagesPort, `evil.example:${pagesPort}`),
  ]
  const byItsOwn = await byName(STACK.port, `localhost:${STACK.port}`)
  check(
    'the door refuses a request sent to a name that is not this machine’s, on the site’s port and on a page’s, and shows it nothing of the site',
    strangers.every((s) => s.status === 421 && !s.text.includes('<')) && byItsOwn.status === 200,
    `${strangers.map((s) => s.status).join(', ')}; by its own name: ${byItsOwn.status}`,
  )
  const sessionAsked = (headers) => plain(`${APP}/session/token`, { method: 'POST', headers: { 'x-it-site': '1', ...headers } })
  const fromElsewhere = [
    await sessionAsked({ origin: 'http://evil.example' }),
    await sessionAsked({ origin: new URL(frameUrl).origin }),
    await sessionAsked({}),
    await plain(`${APP}/session/redeem`, {
      method: 'POST',
      headers: { 'x-it-site': '1', origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{"code":"abcdefghijklmnopqrst"}',
    }),
    await plain(`${APP}/session/end`, { method: 'POST', headers: { 'x-it-site': '1', origin: 'http://evil.example' } }),
    await plain(`${APP}/session/code`, {
      method: 'POST',
      headers: { 'x-it-site': '1', origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{"code":"abcdefghijklmnopqrst"}',
    }),
  ]
  const fromItself = await sessionAsked({ origin: APP })
  const notTheSite = await plain(`${APP}/session/token`, { method: 'POST', headers: { origin: APP } })
  // And a page being shown, which is at this machine's own name on another port, asks as the site would
  const fromAPage = await provoking(
    one,
    [
      { says: notLetRead(`${APP}/session/token`), because: 'a page asked the door for the session as the site would' },
      { says: notMade('ERR_FAILED'), of: exactly(`${APP}/session/token`), because: 'the browser gave the page no answer' },
    ],
    () =>
      frameOf(page)
        .evaluate(
          (site) =>
            fetch(`${site}/session/token`, { method: 'POST', headers: { 'x-it-site': '1' }, credentials: 'include' }).then(
              (r) => r.status,
              () => 'blocked',
            ),
          APP,
        )
        .catch((e) => String(e)),
  )
  check(
    'the routes a browser’s session is made, used and ended by, and the one a code is asked about by, are refused to another origin, to a page being shown, and to whatever does not say it is the site',
    fromElsewhere.every((r) => r.status === 403) && fromItself.status === 401 && notTheSite.status === 403 && (fromAPage === 'blocked' || fromAPage === 403),
    `${fromElsewhere.map((r) => r.status).join(', ')}; from the site’s own origin with no session: ${fromItself.status}; without the site’s header: ${notTheSite.status}; from a page: ${fromAPage}`,
  )
  // Under /api/ the backend has the routes that load functions into it and change its settings,
  // and others that only its administrator may use. Each is asked for through the door as the
  // service itself asks the backend, with the administrator's key.
  const asAdmin = { authorization: `Convex ${adminKey}`, 'content-type': 'application/json' }
  const NOT_PASSED = [
    '/api/deploy2/start_push',
    '/api/deploy2/wait_for_schema',
    '/api/deploy2/finish_push',
    '/api/update_environment_variables',
    '/api/stream_function_logs?cursor=0',
    '/api/function',
    '/api/run_test_function',
    '/api/storage/upload',
    '/api',
    '/api/',
  ]
  const notPassed = []
  for (const route of NOT_PASSED)
    for (const method of ['GET', 'POST'])
      notPassed.push([`${method} ${route}`, (await plain(`${APP}${route}`, { method, headers: asAdmin, ...(method === 'POST' ? { body: '{}' } : {}) })).status])
  const atTheBackendItself = await plain(`${STACK.api}/api/stream_function_logs?cursor=0`, { headers: asAdmin })
  const liveWithoutUpgrade = await plain(`${APP}/api/1.0.0/sync`)
  check(
    'nothing under /api/ that loads functions, changes settings or needs the administrator’s key is passed on, with that key or without: each answers 404',
    notPassed.every(([, status]) => status === 404) && atTheBackendItself.status === 200 && liveWithoutUpgrade.status === 426,
    `${JSON.stringify(notPassed.filter(([, status]) => status !== 404))}; the same at the backend itself: ${atTheBackendItself.status}; the live connection asked for plainly: ${liveWithoutUpgrade.status}`,
  )
  // The three addresses a function is called at are passed on to a program, which is how a
  // machine that joined asks. A page on another site is no program, and neither is a form; and
  // the administrator's key opens nothing here, on these addresses either.
  const CALLS = [
    ['/api/query', 'artifacts:list', {}],
    ['/api/mutation', 'sessions:inviteOwner', {}],
    ['/api/action', 'mounts:ticket', { mountId: 'none' }],
  ]
  const calls = []
  for (const [route, name, args] of CALLS) {
    const called = (headers, method = 'POST') => plain(`${APP}${route}`, { method, headers, body: JSON.stringify({ path: name, args, format: 'json' }) })
    calls.push({
      route,
      program: await called({ 'content-type': 'application/json' }),
      otherSite: (await called({ 'content-type': 'application/json', origin: 'http://evil.example' })).status,
      form: (await called({ 'content-type': 'text/plain' })).status,
      put: (await called({ 'content-type': 'application/json' }, 'PUT')).status,
      administrator: (await called(asAdmin)).status,
    })
  }
  check(
    'a function call is passed on to a caller that is no browser page, where it is answered as nobody’s, and is refused to another site’s page, to what is not JSON, to any other method and to the administrator’s key',
    calls.every(
      (c) =>
        c.program.status === 200 &&
        /"unauthenticated"/.test(c.program.text) &&
        c.otherSite === 403 &&
        c.form === 415 &&
        c.put === 405 &&
        c.administrator === 403,
    ),
    JSON.stringify(calls.map((c) => [c.route, c.program.status, c.otherSite, c.form, c.put, c.administrator])),
  )
  // The live connection is asked for as a browser or a program asks: one request that offers to
  // change to a WebSocket. What it is answered is noted, and nothing is said on it.
  const liveFor = (headers) =>
    new Promise((resolve) => {
      const req = http.request(`${APP}/api/1.0.0/sync`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
          ...headers,
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode)
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => resolve('no answer'))
      req.setTimeout(10_000, () => req.destroy())
      req.end()
    })
  const lives = {
    'the site': await liveFor({ origin: APP }),
    'a program': await liveFor({}),
    'another site': await liveFor({ origin: 'http://evil.example' }),
    'a page being shown': await liveFor({ origin: 'null' }),
    'a version nobody speaks': await liveFor({ origin: APP, 'sec-websocket-version': '12' }),
  }
  check(
    'the live connection is given to the site’s own pages and to a program, and is refused to another site’s page, to a page being shown, and in a version that is not the one spoken',
    JSON.stringify(lives) ===
      JSON.stringify({ 'the site': 101, 'a program': 101, 'another site': 403, 'a page being shown': 403, 'a version nobody speaks': 426 }),
    JSON.stringify(lives),
  )
  const tooMuch = await plain(`${APP}/`, { headers: { 'x-filler': 'x'.repeat(17_000) } }).catch(() => ({ status: 'no answer' }))
  check('and a request whose headers are longer than a request’s ever are is told so, and is not passed on', tooMuch.status === 431, tooMuch.status)
  // What the site says of itself with every answer, over plain http, which is how It is served
  const front = await plain(`${APP}/`)
  const byAddress = await plain(byItsAddress(`${APP}/`))
  // Every answer for the site: a file of it, an address that is one of its pages, and one that is nothing
  const otherAnswers = [
    await plain(`${APP}/sw.js`),
    await plain(`${APP}/p/${slug}`, { headers: { accept: 'text/html' } }),
    await plain(`${APP}/assets/nothing-there.js`),
  ]
  check(
    'the site is served saying what it may load, whole: its own files and nothing else, no script written into a page or made from text, no plug-in, no base address and no form sent anywhere, a frame only for where pages are shown, a connection only to itself, and that nothing may frame it',
    saysExactly(front.headers['content-security-policy'], sitePolicy(APP, pages)) &&
      otherAnswers.every((r) => saysExactly(r.headers['content-security-policy'], sitePolicy(APP, pages))),
    JSON.stringify(toldOf([front, ...otherAnswers])),
  )
  check(
    'and reached by another of this machine’s names, it says the same of that name: its own connection there, and its pages shown there',
    saysExactly(byAddress.headers['content-security-policy'], sitePolicy(byItsAddress(APP), byItsAddress(pages))),
    String(byAddress.headers['content-security-policy']),
  )
  // And a browser holds the site to it. In the browser that is not paired, which is shown the
  // site's own pairing screen, the site's document is made to ask for what it may not: a
  // script written into it, one made from text, and a script, a picture, a frame and an answer
  // from another site. None of it runs, and the other site is asked for nothing: a browser
  // says of a frame it would not fill that it loaded, so it is what the other site was asked
  // that tells.
  const askedBefore = anotherOne.asked.length
  // One thing for each that the document is made to try, by what the browser says was tried and which rule of the policy forbade it
  const itsOwn = "'self'"
  const heldToItsPolicy = during(stranger, [
    { says: againstPolicy('Executing inline script', `script-src ${itsOwn}`), because: 'a script was written into the site’s document' },
    { says: againstPolicy('Evaluating a string as JavaScript', `script-src ${itsOwn}`), because: 'the site’s document made a script from text' },
    {
      says: againstPolicy(`Loading the script '${anotherOne.origin}/script.js'`, `script-src ${itsOwn}`),
      because: 'the site’s document asked another site for a script',
    },
    {
      says: againstPolicy(`Loading the image '${anotherOne.origin}/picture.png'`, `img-src ${itsOwn}`),
      because: 'the site’s document asked another site for a picture',
    },
    { says: againstPolicy(`Framing '${anotherOne.origin}/'`, `frame-src ${pages}`), because: 'the site’s document framed another site' },
    {
      says: againstPolicy(`Connecting to '${anotherOne.origin}/answer'`, `connect-src ${itsOwn} ${APP.replace(/^http/, 'ws')}`),
      because: 'the site’s document asked another site for an answer',
    },
    { says: notAsked(`${anotherOne.origin}/answer`), because: 'the site’s document was not let ask another site for an answer' },
  ])
  const became = await stranger.page.evaluate(async (another) => {
    const written = document.createElement('script')
    written.textContent = 'window.ranWritten = true'
    document.head.append(written)
    // A timer given text makes a script of it when it runs, in the page's own world
    setTimeout('window.ranFromText = true', 0)
    const asked = (element, url) =>
      new Promise((resolve) => {
        element.onload = () => resolve('loaded')
        element.onerror = () => resolve('refused')
        setTimeout(() => resolve('nothing came'), 3000)
        element.src = url
        if (!(element instanceof Image)) document.body.append(element)
      })
    return {
      script: await asked(document.createElement('script'), `${another}/script.js`),
      picture: await asked(new Image(), `${another}/picture.png`),
      frame: await asked(document.createElement('iframe'), `${another}/frame`),
      answer: await fetch(`${another}/answer`).then(
        () => 'answered',
        () => 'refused',
      ),
    }
  }, anotherOne.origin)
  // The browser says by itself that it held the document to each rule, the timer's text among
  // them, which it says when the timer comes due. What ran is looked at once it has said them all.
  const saidItHeld = await heldToItsPolicy.said()
  heldToItsPolicy()
  const holds = {
    ...became,
    saidItHeld,
    ...(await stranger.page.evaluate(() => ({
      ranWritten: window.ranWritten === true,
      ranFromText: window.ranFromText === true,
      ranFromAnotherSite: window.ranFromAnotherSite === true,
    }))),
  }
  check(
    'a browser holds the site to that: nothing written into its document or made from text runs there, and it asks another site for no script, picture, frame or answer',
    holds.saidItHeld &&
      holds.ranWritten === false &&
      holds.ranFromText === false &&
      holds.ranFromAnotherSite === false &&
      holds.script === 'refused' &&
      holds.picture === 'refused' &&
      holds.answer === 'refused' &&
      anotherOne.asked.length === askedBefore,
    JSON.stringify({ ...holds, askedOfTheOtherSite: anotherOne.asked.slice(askedBefore) }),
  )
  const keepsTheSiteOut = againstPolicy(`Framing '${APP}/'`, "frame-ancestors 'none'")
  const siteFramed = await provoking(stranger, [{ says: keepsTheSiteOut, because: 'another site framed the site' }], () =>
    framedBy(anotherOne, stranger, `${APP}/`, 'main', keepsTheSiteOut),
  )
  check(
    'and a page of another site that frames the site is shown nothing of it',
    siteFramed.answered === 200 && siteFramed.shown === 0 && siteFramed.keptOut,
    JSON.stringify(siteFramed),
  )
  await anotherOne.close()
  // That browser has served, and is closed: nothing more is foreseen of it
  await stranger.context.close().catch(() => {})
  nowPairedOrClosed(stranger)
  check(
    'and with the other headers a private site needs, and none that would hold a home network to https',
    front.headers['x-frame-options'] === 'DENY' &&
      front.headers['x-content-type-options'] === 'nosniff' &&
      front.headers['referrer-policy'] === 'no-referrer' &&
      front.headers['cross-origin-opener-policy'] === 'same-origin' &&
      front.headers['cache-control'] === 'no-store' &&
      front.headers['strict-transport-security'] === undefined,
    JSON.stringify(front.headers),
  )

  // ------------------------------------------------------------------
  section('A screen')
  const forScreen = await screenCode(one)
  check(
    'the owner’s Displays page gives a code for another screen, in fours to be typed, and no address that only this machine could open',
    /^([a-z2-7]{4} ){4}[a-z2-7]{4}$/.test(forScreen.shown) && forScreen.address === null,
    `${forScreen.shown.replace(/[a-z2-7]/g, '·')}; address shown: ${forScreen.address !== null}`,
  )
  // What a code is for is asked before it is used, and asking uses nothing of it: the screen's
  // code pairs a screen below, and the owner's pairs a browser as the owner's after that
  const forOwner = await ownerAddress()
  const ownersCode = new URL(forOwner).hash.slice(1)
  const askedFirst = {
    aScreens: [await isFor(forScreen.code), await isFor(forScreen.code)].join(),
    theOwners: [await isFor(ownersCode), await isFor(ownersCode)].join(),
    aWrongOne: await isFor('abcdefghijklmnopqrst'),
    none: await isFor(undefined),
  }
  check(
    'asked what a code is for, It says whether it pairs a browser as a screen or as the owner’s, as often as it is asked, and says of a wrong code only that it is refused',
    JSON.stringify(askedFirst) === JSON.stringify({ aScreens: '200 screen,200 screen', theOwners: '200 owner,200 owner', aWrongOne: '401', none: '400' }),
    JSON.stringify(askedFirst),
  )
  // Opened in the owner's own browser, a screen's code would make that browser a screen
  const inTheOwners = await provoking(
    one,
    [{ says: refusedWith(409), of: exactly(`${APP}/session/redeem`), because: 'the owner’s own browser put a screen’s code' }],
    () =>
      page.evaluate(
        (code) =>
          fetch('/session/redeem', { method: 'POST', headers: { 'x-it-site': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then(
            async (r) => ({ status: r.status, code: (await r.json().catch(() => ({}))).code }),
          ),
        forScreen.code,
      ),
  )
  check(
    'a screen’s code put by the browser that is already the owner’s is refused, and that browser stays the owner’s',
    inTheOwners.status === 409 && inTheOwners.code === 'already_owner' && (await sessionOf(page)).role === 'owner',
    JSON.stringify(inTheOwners),
  )
  // The owner opens the screen's address in their own browser, to look at it
  const looking = await one.context.newPage()
  await looking.goto(`${APP}/pair#${forScreen.code}`)
  const looked = {
    toldItIsForTheOtherScreen: Boolean(await until(() => looking.getByText('so the code was not used here').isVisible(), 15_000)),
    offeredToBecomeAScreen: await becomeAScreen(looking).count(),
    address: looking.url(),
    role: (await sessionOf(looking)).role,
    theCodeIsStill: await isFor(forScreen.code),
  }
  await looking.close()
  check(
    'the owner who opens a screen’s address in their own browser is told it is for the other screen: the browser stays the owner’s, the code is gone from its address bar, and the code is not used',
    JSON.stringify(looked) ===
      JSON.stringify({ toldItIsForTheOtherScreen: true, offeredToBecomeAScreen: 0, address: `${APP}/`, role: 'owner', theCodeIsStill: '200 screen' }),
    JSON.stringify(looked),
  )
  // A browser that is not paired is opened at the screen's address. An address can be opened
  // anywhere, so nothing is made of the browser, and the code is not used, until whoever is at
  // it says that it is the screen.
  const third = began(await launch())
  nowNotPaired(third, 'a browser was opened at a screen’s address and never said it was the screen', { asks: 4 })
  await third.page.goto(`${APP}/pair#${forScreen.code}`)
  const askedThere = {
    offeredToBecomeAScreen: Boolean(await until(() => becomeAScreen(third.page).isVisible(), 15_000)),
    paired: await paired(third.page),
    address: third.page.url(),
    theCodeIsStill: await isFor(forScreen.code),
  }
  check(
    'a browser that is opened at a screen’s address is asked whether it is that screen, and until it says so it is not paired, and the code is gone from its address bar and is not used',
    JSON.stringify(askedThere) === JSON.stringify({ offeredToBecomeAScreen: true, paired: false, address: `${APP}/`, theCodeIsStill: '200 screen' }),
    JSON.stringify(askedThere),
  )
  const two = began(await launch())
  nowNotPaired(two, 'the screen’s browser was opened before its code was typed', { asks: 4 })
  await pairAsScreen(two.page, forScreen.shown, { typed: true })
  nowPairedOrClosed(two)
  const asScreen = await sessionOf(two.page)
  check(
    'a code typed by hand, as it is shown, pairs another browser as a screen, though it had been asked about and opened elsewhere first',
    (await paired(two.page)) && asScreen.role === 'screen',
    asScreen.role,
  )
  // The browser that was asked first says only now that it is the screen, with the code another has used
  const usedTwice = await provoking(
    third,
    [{ says: refusedWith(401), of: exactly(`${APP}/session/redeem`), because: 'a browser said it was the screen with a code another had used' }],
    async () => {
      await becomeAScreen(third.page).click()
      return (await until(() => third.page.getByText(SAYS_NO).isVisible(), 15_000)) && !(await paired(third.page))
    },
  )
  const askedOfAUsedOne = await isFor(forScreen.code)
  await third.browser.close()
  nowPairedOrClosed(third)
  check(
    'and that code, too, pairs one browser and no second, and is from then on answered as a wrong one is',
    usedTwice && askedOfAUsedOne === '401',
    askedOfAUsedOne,
  )
  // What the site offers a screen. Its pages are waited for first: that a card has nothing to pin
  // or delete it with says something only of a card that is there
  await awaited('the screen was not shown its pages', () => two.page.locator(`a.cover[href="/p/${slug}"]`).isVisible(), 20_000)
  const offered = {
    tabs: (await two.page.locator('header.bar nav a').allInnerTexts()).join(),
    pinOrDelete: await two.page.locator('.card .tray').count(),
  }
  for (const managing of ['machines', 'displays']) {
    await two.page.goto(`${APP}/${managing}`)
    offered[managing] = (await until(() => two.page.locator('main.grid-view').isVisible()))
      ? 'the pages'
      : (await two.page.locator('main h2').allTextContents()).join()
  }
  await two.page.goto(`${APP}/settings`)
  await awaited('the screen was not shown its settings', () => two.page.getByText('Paired as a screen').isVisible(), 20_000)
  offered.settings = (await two.page.locator('main h3').allTextContents()).join()
  offered.buttons = (await two.page.locator('main button').allInnerTexts()).join()
  check(
    'the site offers a screen its pages and its own settings, and nothing that manages: no machines, no other displays, no pinning or deleting, no export and no erasing',
    offered.tabs === 'Pages' &&
      offered.pinOrDelete === 0 &&
      offered.machines === 'the pages' &&
      offered.displays === 'the pages' &&
      offered.settings === 'This browser' &&
      !/Download|Erase|Forget|Revoke|Add a display/.test(offered.buttons),
    JSON.stringify(offered),
  )
  // And what the backend itself answers a screen's session that asks for those things all the same
  const wall = (await it(A, ['displays'])).find((d) => d.name === WALL)
  const asOwner = await sessionOf(page)
  const thePage = (await ask('query', 'artifacts:get', { slug }, asScreen.token)).value
  const ownersKey = await page.evaluate(() => localStorage.getItem('it.display'))
  const asksToManage = [
    ['query', 'machines:list', {}],
    ['mutation', 'machines:revoke', { machineId: a.id }],
    ['mutation', 'machines:rename', { machineId: a.id, name: `${PRIVATE_MARK}renamed` }],
    ['mutation', 'machines:toggle', { machineId: a.id, harness: 'codex', on: true }],
    ['query', 'displays:list', {}],
    ['mutation', 'displays:forget', { displayId: wall?.id }],
    // A screen is told of another display only that there is no such one
    ['mutation', 'displays:rename', { displayId: wall?.id, name: `${PRIVATE_MARK}renamed` }, 'not_found'],
    ['mutation', 'sessions:inviteScreen', {}],
    ['mutation', 'sessions:inviteMachine', {}],
    ['mutation', 'sessions:inviteOwner', {}],
    ['mutation', 'account:exportStart', {}],
    ['mutation', 'account:requestDeletion', { confirm: 'erase everything', user: asScreen.user }],
    ['query', 'sessions:list', {}],
    ['mutation', 'sessions:end', { session: asOwner.session }],
    ['mutation', 'sessions:endOthers', {}],
    ['mutation', 'artifacts:remove', { slug }],
    ['mutation', 'artifacts:rollback', { slug, version: 1 }],
    ['mutation', 'artifacts:organize', { artifactId: thePage?.id, pinned: true }],
    ['mutation', 'state:patch', { slug, patch: '{}' }],
    ['mutation', 'displays:show', { slug }],
    ['mutation', 'notifications:send', { text: `${PRIVATE_MARK}from a screen` }],
  ]
  const toldNo = []
  for (const [kind, name, args, refusedAs = 'forbidden'] of asksToManage) toldNo.push([name, await answerTo(kind, name, args, asScreen.token), refusedAs])
  check(
    'and the backend itself refuses a screen’s session each of those, and whatever only a machine may do',
    thePage?.id && wall?.id && toldNo.every(([, said, refusedAs]) => said === refusedAs),
    JSON.stringify(toldNo.filter(([, said, refusedAs]) => said !== refusedAs)),
  )
  const onAnother = await answerTo('mutation', 'mounts:create', { artifactId: thePage?.id, displayKey: ownersKey }, asScreen.token)
  check('nor is a screen given a showing on a display that is not itself', onAnother === 'not_found', onAnother)
  // What a screen is for
  const forTheScreen = await waitingAgent(A, ['--id', slug, '--timeout', '30'])
  await two.page.goto(`${APP}/p/${slug}`)
  const onScreen = two.page.frameLocator('.mount iframe')
  await pageIn(two.page, { id: slug })
  await onScreen.locator('#approve').click()
  const fromScreen = await forTheScreen.answered
  check(
    'a screen shows a page, and what is done on it there reaches the agent',
    fromScreen.action === 'approve' && fromScreen.data?.plan === PLAN,
    JSON.stringify(fromScreen),
  )
  await two.page.goto(`${APP}/`)
  await two.page.locator('.chip.ask', { hasText: 'Name this display' }).click()
  await two.page.locator('.reminders input').fill(SCREEN)
  await two.page.locator('.reminders button[type=submit]').click()
  check('a screen gives itself a name', await until(async () => (await it(A, ['displays'])).some((d) => d.name === SCREEN && d.named)))
  // The owner's display stands at the site's first page, and is told of whatever it is asked
  // to show before the agent asks for anything. From here on, every address either display
  // goes to is kept.
  const ownersIsTold = keptToldOf(page)
  await page.goto(`${APP}/`)
  await awaited('the owner’s display was not told what it is to show', () => ownersIsTold.has('displays:mine'), 20_000, 50)
  ownersIsTold.stop()
  const [ownersWent, screensWent] = [addressesOf(page), addressesOf(two.page)]
  const broughtUp = await it(A, ['open', slug, '--on', SCREEN])
  const onTheScreen = Boolean(await pageIn(two.page, { id: slug }).catch(() => undefined))
  // Another page is then brought up on the owner's display, which hears of it the way it would
  // have heard of the first. Once it shows that page it has heard everything it was told
  // before it, so every address it went to in the meantime is known.
  const wslug = `${slug}-w`
  await it(A, ['create', marked('Wall page'), '--id', wslug, '--html', '<p>w</p>'])
  const broughtUpThere = await it(A, ['open', wslug, '--on', WALL])
  const onTheWall = Boolean(await pageIn(page, { id: wslug }).catch(() => undefined))
  ownersWent.stop()
  screensWent.stop()
  check(
    'and an agent brings a page up on it by that name, and on no other display: the owner’s display goes nowhere until a page is asked for on it, and the screen stays at its own page when one is',
    broughtUp.shownOn.join() === SCREEN &&
      onTheScreen &&
      broughtUpThere.shownOn.join() === WALL &&
      onTheWall &&
      ownersWent.went.join() === `/p/${wslug}` &&
      screensWent.went.join() === `/p/${slug}`,
    JSON.stringify({ broughtUp, broughtUpThere, onTheScreen, onTheWall, theOwnersWentTo: ownersWent.went, theScreenWentTo: screensWent.went }),
  )
  await it(A, ['delete', wslug])
  await page.goto(`${APP}/p/${slug}`)
  await pageIn(page, { id: slug })

  // ------------------------------------------------------------------
  section('Paired browsers')
  /** The rows of the list of paired browsers, on the owner's Displays page. */
  const pairedRows = (p) => p.locator('section', { has: p.getByRole('heading', { name: 'Paired browsers' }) }).locator('li.row')
  /** Every paired browser there is, as the backend lists them for the owner: what the list on the page comes to show. */
  const pairedNow = async () => (await ask('query', 'sessions:list', {}, (await sessionOf(page)).token)).value ?? []
  /** The id of the display that a paired browser is, as the backend lists it beside the browser's session. */
  const displayOf = async (tab) => {
    const its = (await sessionOf(tab)).session
    return (await pairedNow()).find((row) => row.id === its)?.displays?.[0]?.id
  }
  /**
   * A paired browser lets in a screen, with a code of its own, and a machine, with another, as
   * the owner's browser does from its Displays and Machines pages. The code for the machine is
   * asked about first, as a code in an address is: It says nothing of it, and it joins the
   * machine all the same. Gives the screen, the machine with its folder, and what the browser is
   * then listed as taking along.
   */
  const letsIn = async (browser, name) => {
    const screen = await pairedByScript(`${APP}/pair#${await codeFrom(browser, 'a screen')}`)
    const invite = await codeFrom(browser, 'a machine')
    const askedAbout = await isFor(invite)
    const folder = home(name)
    const machine = await join(folder, marked(`e2e let in ${name}`), { invite: async () => invite }).catch((e) => ({ failed: e.code ?? e.message }))
    noteHome(folder, noteWhenSeen)
    const along = (await pairedNow()).find((row) => row.id === browser.session)?.along
    // Listed with exactly what it let in: the screen among the browsers that go with it, and the machine among the machines
    const listed =
      screen.role === 'screen' &&
      typeof machine.machine === 'string' &&
      JSON.stringify(along) === JSON.stringify({ browsers: [screen.session], machines: [machine.machine] })
    return { browser, screen, folder, machine, askedAbout, along, listed }
  }
  /** How each of the three stands: what the browser's cookie and the screen's earn, and what the machine is answered. */
  const standing = async (these) => ({
    browser: (await tokenWith(these.browser.cookie)).status,
    screen: (await tokenWith(these.screen.cookie)).status,
    machine: await refused(it(these.folder, ['whoami'])),
  })
  await page.goto(`${APP}/displays`)
  await pairedRows(page).first().waitFor({ timeout: 15_000 })
  const pairedAtFirst = await pairedRows(page).allInnerTexts()
  check(
    'the Displays page lists every paired browser: the one it is read on as the owner’s, and the screen',
    pairedAtFirst.filter((row) => /This browser/.test(row) && /Yours/.test(row)).length === 1 &&
      pairedAtFirst.some((row) => row.includes(SCREEN) && /Screen/.test(row)),
    `${pairedAtFirst.length} rows`,
  )
  // A browser that is only a script: it holds a session and never registers as a display. It is
  // paired with the owner's code that was asked about, twice, in the section before this one
  const byScript = await pairedByScript(forOwner)
  // It lets a screen and a machine in, which are no displays either
  const takenAlong = await letsIn(byScript, 'x1')
  const unseen = pairedRows(page).filter({ hasText: 'No display' }).filter({ hasText: 'Yours' })
  const unseenListed = await until(async () => (await unseen.count()) === 1)
  const itsRow = (await ask('query', 'sessions:list', {}, asOwner.token)).value?.find((s) => s.id === byScript.session)
  check(
    'a browser that was paired and never became a display is among them all the same, with what asked for the code that let it in: the code had been asked about and was not used by that, and is answered as a wrong one is now that it has paired a browser',
    byScript.status === 200 &&
      byScript.role === 'owner' &&
      (await isFor(ownersCode)) === '401' &&
      unseenListed &&
      itsRow?.displays.length === 0 &&
      itsRow.invitedBy?.kind === 'machine' &&
      /a code the machine/.test(await unseen.innerText()),
    JSON.stringify(itsRow),
  )
  let saidBeforeEnding = ''
  page.once('dialog', (d) => {
    saidBeforeEnding = d.message()
    void d.accept()
  })
  await unseen.getByRole('button', { name: 'End' }).click()
  check(
    'the owner ends it there, and from that moment its cookie earns no token and the token it holds is refused',
    (await until(async () => (await tokenWith(byScript.cookie)).status === 401)) &&
      (await answerTo('query', 'artifacts:list', {}, byScript.token)) === 'unauthenticated',
  )
  const allGone = { browser: 401, screen: 401, machine: 'unauthenticated' }
  let afterTheOwnersEnding
  await until(async () => {
    afterTheOwnersEnding = await standing(takenAlong)
    return JSON.stringify(afterTheOwnersEnding) === JSON.stringify(allGone)
  }, 25_000)
  check(
    'and what it let in goes with it: the site said first how many paired browsers and machines came from it, and the screen it paired and the machine it added are ended with it, at once',
    takenAlong.listed &&
      takenAlong.askedAbout === '401' &&
      /^End this paired browser\? .* 1 paired browser and 1 machine came from it, and are ended with it\.$/.test(saidBeforeEnding) &&
      JSON.stringify(afterTheOwnersEnding) === JSON.stringify(allGone) &&
      (await answerTo('query', 'artifacts:list', {}, takenAlong.screen.token)) === 'unauthenticated',
    JSON.stringify({ along: takenAlong.along, askedAbout: takenAlong.askedAbout, said: saidBeforeEnding.slice(0, 300), afterTheOwnersEnding }),
  )
  // Signing out names the session that is to end, so that a tab which still holds an earlier
  // one can end nothing but that
  const [leaves, stays] = [await pairedByScript(await ownerAddress()), await pairedByScript(await ownerAddress())]
  // The one that is to sign itself out has let a screen and a machine in first
  const leftBehind = await letsIn(leaves, 'x2')
  const signedOut = {
    namingNone: (await ending(leaves.cookie, {})).status,
    namingAnothers: await ending(leaves.cookie, { session: stays.session }).then((r) => `${r.status} ${JSON.parse(r.text || '{}').code}`),
    bothStillPaired: [(await tokenWith(leaves.cookie)).status, (await tokenWith(stays.cookie)).status].join(),
    namingItsOwn: (await ending(leaves.cookie, { session: leaves.session })).status,
    aSecondTime: (await ending(leaves.cookie, { session: leaves.session })).status,
    theOtherAfterwards: (await tokenWith(stays.cookie)).status,
  }
  check(
    'a browser signs out by naming its own session: with none named nothing is ended, naming another browser’s ends neither, and its own is ended once and leaves the other paired',
    JSON.stringify(signedOut) ===
      JSON.stringify({
        namingNone: 400,
        namingAnothers: '409 another_session',
        bothStillPaired: '200,200',
        namingItsOwn: 200,
        aSecondTime: 401,
        theOtherAfterwards: 200,
      }),
    JSON.stringify(signedOut),
  )
  const afterItsOwnSignOut = await standing(leftBehind)
  check(
    'and a browser that signs itself out ends only its own pairing: the screen it paired and the machine it added stay as they were',
    leftBehind.listed && JSON.stringify(afterItsOwnSignOut) === JSON.stringify({ browser: 401, screen: 200, machine: 'ok' }),
    JSON.stringify({ along: leftBehind.along, afterItsOwnSignOut }),
  )
  await ending(leftBehind.screen.cookie, { session: leftBehind.screen.session })
  await it(leftBehind.folder, ['logout']).catch(() => {})
  // Each session's cookie is named for that session, so that an answer about one session sets or
  // clears no other's, however late it comes. The browser that stayed paired is paired again
  // while it holds its cookie. Then answers about its earlier session, which is over, reach it
  // while it holds the later one.
  const secondPairing = await pairedByScript(await ownerAddress(), { holding: [stays.cookie] })
  const [earlier, later] = ['the earlier session’s', 'the later session’s']
  const theTwo = { [earlier]: stays, [later]: secondPairing }
  const lateEnding = await ending([stays.cookie, secondPairing.cookie], { session: stays.session })
  const lateToken = await tokenWith(stays.cookie)
  const withBoth = await tokenWith([stays.cookie, secondPairing.cookie])
  const cookiesSaid = {
    pairedAgain: cookiesIn(secondPairing.redeemed, theTwo).join(', '),
    endingTheEarlier: `${lateEnding.status} ${JSON.parse(lateEnding.text || '{}').code}: ${cookiesIn(lateEnding, theTwo).join(', ')}`,
    askedWithTheEarlier: `${lateToken.status}: ${cookiesIn(lateToken.answer, theTwo).join(', ')}`,
    askedWithBoth: `${withBoth.status} ${withBoth.session === secondPairing.session ? 'as the later session' : 'as another'}: ${cookiesIn(withBoth.answer, theTwo).join(', ')}`,
    theLaterAfterwards: (await tokenWith(secondPairing.cookie)).status,
  }
  check(
    'each session’s cookie is named for that session, and no answer sets or clears another’s: pairing a browser again sets the new session’s, first, and clears the one it held, and an answer about the session that is over clears that one’s alone, whenever it comes',
    JSON.stringify(cookiesSaid) ===
      JSON.stringify({
        pairedAgain: `${later} set, ${earlier} cleared`,
        endingTheEarlier: `409 another_session: ${earlier} cleared`,
        askedWithTheEarlier: `401: ${earlier} cleared`,
        askedWithBoth: `200 as the later session: ${earlier} cleared`,
        theLaterAfterwards: 200,
      }),
    JSON.stringify(cookiesSaid),
  )
  await ending(secondPairing.cookie, { session: secondPairing.session })
  // Two tabs of the owner's browser, and a fresh pairing in the second while the first is open.
  // The checks before this one asked for many tokens under this browser's session, and a
  // session is given them back at one a second: the step is begun once it has enough again
  // for two tabs to load and be asked about, so that neither is told to wait
  await sleep(15_000)
  const NOT_PAIRED = 'This browser is not paired with It yet.'
  const secondTab = await one.context.newPage()
  await secondTab.goto(APP)
  await awaited('the second tab was not shown the site as a paired browser', () => paired(secondTab), 20_000)
  const sessionBefore = await sessionOf(page)
  const pairedBefore = (await pairedNow()).length
  const endings = []
  const noteEnding = (r) => {
    if (new URL(r.url()).pathname === '/session/end') endings.push(r.method())
  }
  one.context.on('request', noteEnding)
  /** What a tab is answered the next time it asks the site, by itself, whether its browser is paired: a tab asks when it hears from another that the pairing changed. */
  const asksForItself = (tab) =>
    tab
      .waitForResponse((r) => r.url() === `${APP}/session/token`, { timeout: 30_000 })
      .then(
        (r) => r.status(),
        () => 'it did not ask',
      )
  const firstTabAsked = asksForItself(page)
  await secondTab.goto(await ownerAddress())
  await awaited('the second tab was not paired by the address `it site` printed', () => paired(secondTab), 20_000)
  // The first tab hears of the new pairing and asks for itself. Once it has its answer, and
  // has asked once more for the run, it has begun whatever it was going to do about it: ending
  // the new session, were it going to.
  const firstTabWasTold = await firstTabAsked
  const [sessionAfter, inTheFirstTab] = [await sessionOf(secondTab), await sessionOf(page)]
  const bothShow = [await page.locator('body').innerText(), await secondTab.locator('body').innerText()]
  check(
    'a second tab that pairs the browser afresh while the first is open leaves both paired: the browser has the new session, the first tab hears of it and is under it too, neither tab is sent back to the pairing screen, and neither asks for a session to be ended',
    sessionAfter.status === 200 &&
      sessionAfter.session !== sessionBefore.session &&
      firstTabWasTold === 200 &&
      inTheFirstTab.session === sessionAfter.session &&
      !bothShow.some((shows) => shows.includes(NOT_PAIRED)) &&
      endings.length === 0,
    JSON.stringify({
      status: sessionAfter.status,
      another: sessionAfter.session !== sessionBefore.session,
      firstTabWasTold,
      theFirstTabIsUnderIt: inTheFirstTab.session === sessionAfter.session,
      endings,
    }),
  )
  one.context.off('request', noteEnding)
  const pairedAfter = await pairedNow()
  await page.goto(`${APP}/displays`)
  // The list on the page is read once it shows as many as there are
  const rowsAfter = await until(async () => {
    const rows = await pairedRows(page).allInnerTexts()
    return rows.length === pairedAfter.length && rows.length > 0 ? rows : undefined
  }, 15_000)
  check(
    'and the first tab goes on as the owner’s under the session the browser has now, which took the place among the paired browsers of the one it had',
    pairedAfter.length === pairedBefore &&
      pairedAfter.filter((s) => s.mine).length === 1 &&
      pairedAfter.some((s) => s.id === sessionAfter.session) &&
      !pairedAfter.some((s) => s.id === sessionBefore.session) &&
      rowsAfter?.filter((row) => /This browser/.test(row)).length === 1 &&
      (await sessionOf(page)).session === sessionAfter.session &&
      (await answerTo('query', 'artifacts:list', {}, sessionBefore.token)) === 'unauthenticated',
    `${pairedBefore} paired before, ${pairedAfter.length} after; the page lists ${rowsAfter?.length ?? 'another number'}`,
  )
  await secondTab.close()

  // A browser of its own for what follows: it is signed out, paired again, and forgotten
  const lateOne = began(await launch())
  const [tabOne, tabTwo] = [lateOne.page, await lateOne.context.newPage()]
  await tabOne.goto(await ownerAddress())
  await awaited('the browser was not paired by the address `it site` printed', () => paired(tabOne), 20_000)
  await tabTwo.goto(APP)
  await awaited('the second tab of that browser was not shown the site as a paired browser', () => paired(tabTwo), 20_000)
  const signsOut = await sessionOf(tabOne)
  // The display the browser registered as, given a name so that it is told from every other
  const LATE = marked('Test late')
  const itsDisplay = await awaited(
    'the browser did not register as a display',
    async () => (await pairedNow()).find((row) => row.id === signsOut.session)?.displays[0],
    20_000,
  )
  await ask('mutation', 'displays:rename', { displayId: itsDisplay.id, name: LATE }, signsOut.token)
  await page.goto(`${APP}/displays`)
  const itsRowThere = page.locator('li.row', { has: page.locator('.row-name', { hasText: LATE }) })
  await awaited(
    'the owner’s Displays page did not list that browser’s display by its name',
    () => itsRowThere.getByRole('button', { name: 'Forget' }).isVisible(),
    20_000,
  )
  const pairsAfresh = await ownerAddress()
  // The first tab signs out. What It answers is kept from the browser for a while: the session
  // is over by then, and the browser has not heard.
  let heard
  const wasAnswered = new Promise((resolve) => {
    heard = resolve
  })
  let letGo
  const keptBack = new Promise((resolve) => {
    letGo = resolve
  })
  await lateOne.context.route('**/session/end', async (route) => {
    const response = await route.fetch()
    const lines = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value)
    heard({ status: response.status(), cookies: cookiesIn({ headers: { 'set-cookie': lines } }, { 'the session that signed out': signsOut }).join(', ') })
    await keptBack
    await route.fulfill({ response })
  })
  await tabOne.goto(`${APP}/settings`)
  // Its session is over from the moment It hears, and its other tab is refused a token until it pairs the browser again
  nowNotPaired(lateOne, 'a browser signed out in one of its two tabs', { asks: 6 })
  await tabOne.getByRole('button', { name: 'Sign out', exact: true }).click()
  const theAnswer = await Promise.race([wasAnswered, sleep(30_000)])
  if (!theAnswer) throw new Error('the browser that was told to sign out did not ask for its session to be ended within thirty seconds')
  // The browser's pairing has ended, and the display it was is still there. It is said to be
  // not paired wherever displays are listed, and a page asked onto it is reported as not shown.
  // The stack may have served runs before this one, and a display one of those left is no part of this: the three this run named are looked at
  const namedHere = { [LATE]: 'it', [WALL]: 'the owner’s', [SCREEN]: 'the screen’s' }
  const whileEnded = {
    listedAs: (await it(A, ['displays']))
      .filter((d) => d.name in namedHere)
      .map((d) => `${namedHere[d.name]}: ${d.paired}`)
      .sort(),
    askedOnto: await it(A, ['open', slug, '--on', LATE]).then(
      (said) => ({ shownOn: said.shownOn, notShownOn: said.notShownOn, saysWhy: /is not paired any more/.test(said.hint ?? '') }),
      (e) => ({ failed: e.code ?? e.message }),
    ),
    saidOnThePage: Boolean(await until(() => itsRowThere.getByText('Not paired').isVisible(), 10_000)),
  }
  // While the answer is on its way, the browser is paired again in its other tab
  await tabTwo.goto(pairsAfresh)
  await awaited(
    'the second tab was not paired afresh while the first was signing out',
    async () => (await paired(tabTwo)) && (await sessionOf(tabTwo)).session !== signsOut.session,
    20_000,
  )
  const pairedAfresh = await sessionOf(tabTwo)
  nowPairedOrClosed(lateOne)
  // Paired again, the browser is the display it was
  const sameDisplay = await until(
    async () => (await pairedNow()).find((row) => row.id === pairedAfresh.session)?.displays.some((d) => d.id === itsDisplay.id && d.name === LATE),
    20_000,
  )
  const listedAgain = (await it(A, ['displays'])).find((d) => d.name === LATE)?.paired
  check(
    'a display whose browser’s pairing has ended stays, and is said to be not paired where an agent lists the displays and on the owner’s Displays page; an agent that asks for a page on it is told it is not shown there, and why; and paired again, the browser is that same display',
    JSON.stringify(whileEnded) ===
      JSON.stringify({
        listedAs: ['it: false', 'the owner’s: true', 'the screen’s: true'],
        askedOnto: { shownOn: [], notShownOn: [{ display: LATE, reason: 'not_paired' }], saysWhy: true },
        saidOnThePage: true,
      }) &&
      sameDisplay &&
      listedAgain === true,
    JSON.stringify({ ...whileEnded, sameDisplay, listedAgain }),
  )
  // Now the answer reaches the first tab. It is about the session that was signed out, and the
  // browser holds another by now.
  const reachedIt = tabOne
    .waitForResponse((r) => new URL(r.url()).pathname === '/session/end', { timeout: 30_000 })
    .then(
      (r) => r.status(),
      () => 'never',
    )
  // The tab the answer reaches asks what the browser is now. Once it has its answer it has
  // begun whatever it was going to do about it: unpairing the browser, were it going to. The
  // other tab is then asked by the run.
  const tabOneAsked = asksForItself(tabOne)
  letGo()
  const lateAnswer = {
    was: `${theAnswer.status}: ${theAnswer.cookies}`,
    reachedTheTab: await reachedIt,
    // The first tab finds out what the browser is now, and shows the site under the new pairing within a few seconds
    firstTabShowsTheSite: Boolean(await until(() => paired(tabOne), 8000)),
    thatTabAskedForItself: await tabOneAsked,
  }
  const afterIt = await sessionOf(tabTwo)
  const [inTabOne, inTabTwo] = [await tabOne.locator('body').innerText(), await tabTwo.locator('body').innerText()]
  Object.assign(lateAnswer, {
    browserHolds: (await lateOne.context.cookies())
      .map((c) => (c.name === cookieOf(pairedAfresh.session) ? 'the new session’s cookie' : 'another cookie'))
      .join(', '),
    tokenUnder: `${afterIt.status} ${afterIt.session === pairedAfresh.session ? 'the new session' : 'another'}`,
    sentToThePairingScreen: [inTabOne, inTabTwo].filter((shows) => shows.includes(NOT_PAIRED)).length,
  })
  check(
    'an answer to signing out that reaches a browser after it was paired again in another tab takes nothing from the new pairing: it clears the cookie of the session that ended and no other, the browser goes on holding the new session’s and is given tokens under it, and neither tab is sent to the pairing screen',
    JSON.stringify(lateAnswer) ===
      JSON.stringify({
        was: '200: the session that signed out cleared',
        reachedTheTab: 200,
        firstTabShowsTheSite: true,
        thatTabAskedForItself: 200,
        browserHolds: 'the new session’s cookie',
        tokenUnder: '200 the new session',
        sentToThePairingScreen: 0,
      }),
    JSON.stringify(lateAnswer),
  )
  await lateOne.context.unroute('**/session/end')
  // That browser pairs a screen, and the owner then forgets the display it is. The site says
  // first what goes with it, and the browser's pairing and the screen's end with the display.
  const pairedByIt = await pairedByScript(`${APP}/pair#${await codeFrom(pairedAfresh, 'a screen')}`)
  await page.goto(`${APP}/displays`)
  await awaited(
    'the owner’s Displays page did not list that browser’s display once it was paired again',
    () => itsRowThere.getByRole('button', { name: 'Forget' }).isVisible(),
    20_000,
  )
  let saidBeforeForgetting = ''
  page.once('dialog', (d) => {
    saidBeforeForgetting = d.message()
    void d.accept()
  })
  // Each of its two tabs learns that the pairing has ended, and the run asks as the site does until it has
  nowNotPaired(lateOne, 'the display of a browser with two tabs open was forgotten', { asks: 10 })
  await itsRowThere.getByRole('button', { name: 'Forget' }).click()
  const forgotten = {
    theScreenItPaired: await until(async () => ((await tokenWith(pairedByIt.cookie)).status === 401 ? 401 : undefined), 20_000),
    theBrowser: await until(async () => ((await sessionOf(tabTwo)).status === 401 ? 401 : undefined), 20_000),
    stillListed: (await it(A, ['displays'])).filter((d) => d.name === LATE).length,
  }
  check(
    'forgetting a display ends its browser’s pairing and, with it, the screen that browser paired: the site says first that a paired browser goes with it, and the display is listed no more',
    pairedByIt.role === 'screen' &&
      /^Forget “.*”\? .* 1 paired browser came from it, and is ended with it\.$/.test(saidBeforeForgetting) &&
      JSON.stringify(forgotten) === JSON.stringify({ theScreenItPaired: 401, theBrowser: 401, stillListed: 0 }),
    JSON.stringify({ said: saidBeforeForgetting.replace(/“[^”]*”/, '“…”').slice(0, 300), ...forgotten }),
  )
  await lateOne.context.close()
  nowPairedOrClosed(lateOne)
  // A browser may still hold the cookies of many sessions that are over. None of them pairs it,
  // and what it is answered clears four of them at once, and no more
  const over = [byScript, takenAlong.screen, leaves, leftBehind.screen, stays, secondPairing, pairedByIt]
  const withMany = await tokenWith(over.map((ended) => ended.cookie))
  const clearedOfMany = cookiesIn(withMany.answer, Object.fromEntries(over.map((ended, n) => [`session ${n + 1}’s`, ended])))
  check(
    'a browser that holds the cookies of seven sessions that are over is paired by none of them, and the answer clears four of those cookies and touches nothing else',
    withMany.status === 401 &&
      clearedOfMany.length === 4 &&
      new Set(clearedOfMany).size === 4 &&
      clearedOfMany.every((line) => /^session \d’s cleared$/.test(line)),
    `${withMany.status}: ${clearedOfMany.join(', ')}`,
  )
  // The routes a browser's session is made, used and ended by are the door's to pass on: asked
  // of the backend's own port, which only this machine can reach, they answer nobody, whatever
  // the asking carries
  const pastTheDoor = []
  for (const [route, body] of [
    ['/session/code', { code: 'abcdefghijklmnopqrst' }],
    ['/session/redeem', { code: 'abcdefghijklmnopqrst' }],
    ['/session/token', undefined],
    ['/session/end', { session: asOwner.session }],
  ])
    pastTheDoor.push(
      (
        await plain(`${STACK.http}${route}`, {
          method: 'POST',
          headers: { 'x-it-site': '1', 'x-it-door': 'made-up', origin: APP, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      ).status,
    )
  check(
    'the backend’s own port answers none of the routes for a browser’s session: only what came through the door is answered',
    pastTheDoor.join() === '403,403,403,403',
    pastTheDoor.join(),
  )
  // Wrong codes, a hundred and twenty of them, through the door: put for a browser, put for a
  // machine, and asked about as the site asks before it uses one, by turns. The door stops
  // listening to an address after ten in a minute, whichever of the three they were, so they
  // come ten each from twelve of this machine's own addresses: each is refused, none is told to
  // wait, and a right code of either kind is as good afterwards as it was.
  const rightOne = await ownerAddress()
  const forAMachine = await inviteMachine()
  const { x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
  const atItsAddress = `http://127.0.0.1:${STACK.port}`
  /** One wrong code, sent from one of this machine's own addresses: put for a browser, put for a machine, or asked about, by turns. */
  const wrongFrom = (localAddress, n) =>
    plain(`${atItsAddress}${['/session/redeem', '/bridge/enroll', '/session/code'][n % 3]}`, {
      method: 'POST',
      localAddress,
      headers: { 'x-it-site': '1', origin: atItsAddress, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `wrong-code-${n}`,
        ...(n % 3 === 1 ? { publicKey: { kty: 'EC', crv: 'P-256', x, y }, name: `${PRIVATE_MARK}nobody` } : {}),
      }),
    }).then(
      (r) => `${r.status}${r.status === 429 ? ` ${JSON.parse(r.text || '{}').error ?? JSON.parse(r.text || '{}').code}` : ''}`,
      (e) => `no such address (${e.code})`,
    )
  const wrongOnes = []
  for (let from = 10; from < 22; from++) for (let n = 0; n < 10; n++) wrongOnes.push(await wrongFrom(`127.0.0.${from}`, from * 10 + n))
  // And an eleventh and a twelfth from one more address, which is the one the door stops
  // listening to. Three of its first ten were only asked about, and count as the others do;
  // the twelfth is one that is asked about, and is not passed on either.
  const atTheDoor = []
  for (let n = 0; n < 12; n++) atTheDoor.push(await wrongFrom('127.0.0.2', n))
  if (wrongOnes[0].startsWith('no such address'))
    console.log(
      '  skip  wrong codes in bulk, and the door’s count of them from one address: this system gives a program only the one address of its own to send from',
    )
  else {
    const afterThem = await pairedByScript(rightOne)
    const joinedAfterThem = await join(home('late'), marked('e2e after wrong codes'), { invite: async () => forAMachine }).catch((e) => ({ failed: e.code }))
    check(
      'a hundred and twenty wrong codes, put for a browser, put for a machine and asked about by turns, are each refused and none is told to wait, and take nothing from a right code of either kind',
      new Set(wrongOnes).size === 1 &&
        wrongOnes[0] === '401' &&
        afterThem.status === 200 &&
        afterThem.role === 'owner' &&
        typeof joinedAfterThem.machine === 'string',
      JSON.stringify({ wrongOnes: [...new Set(wrongOnes)], browser: afterThem.status, machine: joinedAfterThem }),
    )
    check(
      'the door refuses an address its eleventh wrong code in a minute without asking the backend, whether its codes were put or only asked about, while a right code from another address is still taken',
      atTheDoor.slice(0, 10).every((said) => said === '401') &&
        atTheDoor.slice(10).every((said) => said === '429 too_many_wrong_codes') &&
        afterThem.status === 200,
      JSON.stringify(atTheDoor),
    )
    // And typed in a browser, as a person types them. That browser's requests reach the door
    // from an address of their own, so that the address the door stops listening to is no
    // other browser's and nothing else's in the run.
    const fromItsOwn = await wayFrom('127.0.0.3')
    const typist = began(await launch({ context: { proxy: fromItsOwn.proxy } }))
    nowNotPaired(typist, 'a browser was opened to type wrong codes in, and never paired', { asks: 4 })
    const typedWrong = during(typist, [
      { says: refusedWith(401), of: exactly(`${APP}/session/redeem`), times: 10, because: 'ten wrong codes were typed in a browser' },
      { says: refusedWith(429), of: exactly(`${APP}/session/redeem`), because: 'an eleventh wrong code was typed within the minute' },
    ])
    await typist.page.goto(APP)
    const pairIt = typist.page.getByRole('button', { name: 'Pair this browser' })
    const eleven = { answered: [] }
    for (let n = 1; n <= 11; n++) {
      const answered = typist.page
        .waitForResponse((r) => new URL(r.url()).pathname === '/session/redeem', { timeout: 15_000 })
        .then(
          (r) => r.status(),
          () => 'no answer',
        )
      await typist.page.getByLabel('Pairing code').fill(`wrong code number ${n}`)
      await pairIt.click()
      eleven.answered.push(await answered)
      // The site has said what became of the code once the button can be pressed again
      await until(() => pairIt.isEnabled(), 5000, 20)
      if (n === 10) eleven.afterTheTenth = (await typist.page.locator('[role=alert]').allInnerTexts()).join(' ')
    }
    eleven.answered = eleven.answered.join()
    eleven.afterTheEleventh = (await typist.page.locator('[role=alert]').allInnerTexts()).join(' ')
    eleven.leftAsTyped = await typist.page.getByLabel('Pairing code').inputValue()
    eleven.paired = await paired(typist.page)
    typedWrong()
    check(
      'typed in a browser, ten wrong codes are each said to be wrong, and an eleventh within the minute is said not to have been tried, with how long to wait, and is left where it was typed',
      eleven.answered === '401,401,401,401,401,401,401,401,401,401,429' &&
        eleven.afterTheTenth.startsWith(SAYS_NO) &&
        /^Too many wrong codes have come from this device in the last minute, so this one was not tried\. Wait (a minute|\d+ seconds?), and then try it again\.$/.test(
          eleven.afterTheEleventh,
        ) &&
        eleven.leftAsTyped === 'wrong code number 11' &&
        eleven.paired === false,
      JSON.stringify(eleven),
    )
    await typist.context.close().catch(() => {})
    nowPairedOrClosed(typist)
    await fromItsOwn.close()
    await ending(afterThem.cookie, { session: afterThem.session })
    await it(home('late'), ['logout']).catch(() => {})
  }

  // ------------------------------------------------------------------
  section('What a machine may do')
  const asB = await machineToken(B)
  const asA = await machineToken(A)
  const seenByB = await it(B, ['list'])
  await it(B, ['set', slug, 'kept', `${PRIVATE_MARK}by the second machine`])
  check(
    'a second machine sees the pages the first sees, and may change one as any of the person’s machines may',
    seenByB.map((p) => p.id).join() === (await it(A, ['list'])).map((p) => p.id).join() &&
      seenByB.some((p) => p.id === slug) &&
      (await it(B, ['read', slug])).id === slug &&
      (await it(A, ['state', slug])).state.kept === `${PRIVATE_MARK}by the second machine`,
    JSON.stringify(seenByB.map((p) => p.id)),
  )
  const ownersOnly = [
    ['query', 'machines:list', {}],
    ['mutation', 'machines:revoke', { machineId: a.id }],
    ['mutation', 'machines:rename', { machineId: b.machine, name: `${PRIVATE_MARK}renamed` }],
    ['mutation', 'displays:forget', { displayId: wall?.id }],
    ['mutation', 'displays:rename', { displayId: wall?.id, name: `${PRIVATE_MARK}renamed` }],
    ['mutation', 'sessions:inviteScreen', {}],
    ['mutation', 'account:exportStart', {}],
    ['mutation', 'account:requestDeletion', { confirm: 'erase everything', user: asScreen.user }],
    ['query', 'sessions:list', {}],
    ['mutation', 'sessions:end', { session: asOwner.session }],
    ['mutation', 'sessions:endOthers', {}],
    ['mutation', 'artifacts:organize', { artifactId: thePage?.id, pinned: true }],
    ['mutation', 'mounts:create', { artifactId: thePage?.id, displayKey: ownersKey }],
    [
      'mutation',
      'actions:submit',
      {
        artifactId: thePage?.id,
        displayKey: ownersKey,
        envelope: { v: 1, clientActionId: randomBytes(16).toString('hex'), name: 'approve', payload: '{}', contentVersion: 1, attended: true },
      },
    ],
  ]
  const machinesToldNo = []
  for (const [who, token] of [
    ['the second', asB],
    ['the first', asA],
  ])
    for (const [kind, name, args] of ownersOnly) machinesToldNo.push([who, name, await answerTo(kind, name, args, token)])
  check(
    'and what only the owner’s browser may do, or only a browser at all, is refused to it as it is to the machine It runs on',
    machinesToldNo.every(([, , said]) => said === 'forbidden'),
    JSON.stringify(machinesToldNo.filter(([, , said]) => said !== 'forbidden')),
  )

  // ------------------------------------------------------------------
  section('Privacy')
  // Where a sign-out the backend could not be told about is presented later, by a browser that
  // may not be paired any more: the door passes it on, and it asks for nothing but the token
  const reached = await provoking(
    one,
    [{ says: refusedWith(401), of: exactly(`${APP}/display/signout`), because: 'the site presented a sign-out token that is none' }],
    () =>
      page.evaluate(() =>
        fetch('/display/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-a-token' }) }).then(
          (r) => r.status,
          (e) => `blocked: ${e.message}`,
        ),
      ),
  )
  check('the site can reach the address where a sign-out that was not recorded is presented later', reached === 401, String(reached))
  // ------------------------------------------------------------------
  section('The network')
  // Until it is told otherwise It answers this machine alone. Told to, it answers at every
  // address the machine has, to whoever on the network asks, and gives nothing but the pairing
  // screen to anyone without a code. It is turned off again when these checks are done,
  // whatever became of them.
  const offAtFirst = await it(A, ['network'])
  /** Every address this machine has on a network, as the system lists them: none that is the machine's own to itself, and none that reaches no further than one link. */
  const onANetwork = Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && !(address.family === 'IPv6' && /^fe80:/i.test(address.address)))
    .map((address) => address.address)
  /** Whether anything takes a connection at an address and a port of this machine. */
  const takesAConnection = (host, port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port) })
      const answer = (taken) => {
        socket.destroy()
        resolve(taken)
      }
      socket.setTimeout(1500, () => answer(false))
      socket.once('connect', () => answer(true))
      socket.once('error', () => answer(false))
    })
  /** What of It takes a connection at any of those addresses: the site, the pages, or either of the backend program's two ports. Nothing is asked of whatever answers. */
  const reachedFromANetwork = async () => {
    const reached = new Set()
    for (const host of onANetwork)
      for (const [what, port] of [
        ['the site', STACK.port],
        ['the pages', pagesPort],
        ['the backend', new URL(STACK.api).port],
        ['the backend’s own routes', new URL(STACK.http).port],
      ])
        if (await takesAConnection(host, port)) reached.add(what)
    return [...reached].join(', ')
  }
  const reachedAtFirst = await reachedFromANetwork()
  // A person who runs the suite on their own machine has not asked for It to be opened to
  // whatever network they are on: it is, where CI runs the suite or IT_E2E_NETWORK=1 says so
  const mayOpen = Boolean(process.env.CI) || process.env.IT_E2E_NETWORK === '1'
  if (!mayOpen)
    console.log(
      '  skip  turning the network on and reaching It from it: set IT_E2E_NETWORK=1 to have the run open its test stack to this machine’s network for a moment',
    )
  // The door closes and opens again as the network is turned on, and as it is turned off. A
  // browser that has the site open then may find, for that moment, nothing to connect to
  const doorMoved = [one, two].map((open_) => during(open_, closedUnder(APP, pages, 'the door was closed and opened under an open site')))
  /**
   * What the showing's address answers once something answers there. The door stops answering
   * for a moment as it is opened to the network or closed to it, at the site's port and at the
   * pages' each in its turn, and a connection made in that moment is dropped: so it is asked
   * until it is answered, whatever the answer is.
   */
  const answeredAt = async (url) => (await until(() => servedAt(url), 15_000, 250)) ?? 'nothing answered there'
  // A page is open on the screen of this machine all the while. Its showing is asked, as the
  // page itself asks, before the network is turned on, once it is on, and once it is off again
  const openAllTheWhile = shownFrame(two.page)?.url()
  const openThroughout = { before: openAllTheWhile ? await answeredAt(openAllTheWhile) : 'no page was open on the screen' }
  const turnedOn = mayOpen ? await it(A, ['network', 'on']) : { network: false, addresses: [] }
  if (mayOpen && openAllTheWhile) openThroughout.whenOn = await answeredAt(openAllTheWhile)
  /** This machine's own address on a network, where it has one: the first It names that is a plain numbered one. */
  const near = (turnedOn.addresses ?? []).find((address) => /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(address))
  let four
  let turnedOff
  try {
    check(
      'until it is told otherwise It answers this machine alone, and says so: nothing of it takes a connection at any address the machine has on a network',
      offAtFirst.network === false && offAtFirst.addresses.length === 0 && reachedAtFirst === '',
      `${JSON.stringify(offAtFirst)}; of ${onANetwork.length} address(es) on a network, reached: ${reachedAtFirst || 'nothing'}`,
    )
    if (mayOpen)
      check(
        '`it network on` says where on the network It then is',
        turnedOn.network === true && (await it(A, ['status'])).network?.on === true,
        JSON.stringify({ on: turnedOn.network, addresses: turnedOn.addresses?.length }),
      )
    if (mayOpen && !near) console.log('  skip  reaching It from the network: this machine has no address on one')
    if (near) {
      const there = await until(
        () =>
          plain(`${near}/`).then(
            (r) => r.status === 200,
            () => false,
          ),
        15_000,
        500,
      )
      const byAnotherName = await plain(`${near}/`, { headers: { host: 'evil.example' } }).catch(() => ({ status: 0 }))
      const withoutACode = {
        session: (await plain(`${near}/session/token`, { method: 'POST', headers: { 'x-it-site': '1', origin: near } })).status,
        call: (
          await plain(`${near}/api/query`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'artifacts:list', args: {}, format: 'json' }),
          })
        ).text,
        wrongCode: (
          await plain(`${near}/session/redeem`, {
            method: 'POST',
            headers: { 'x-it-site': '1', origin: near, 'content-type': 'application/json' },
            body: '{"code":"abcdefghijklmnopqrst"}',
          })
        ).status,
      }
      const reachedWhenOn = await reachedFromANetwork()
      check(
        'the door then answers at the machine’s own address on the network within a few seconds, and still not to a name that is not the machine’s; the site and the pages can be reached there, and the backend program still cannot',
        there && byAnotherName.status === 421 && reachedWhenOn === 'the site, the pages',
        `there: ${there}; by another name: ${byAnotherName.status}; reached: ${reachedWhenOn || 'nothing'}`,
      )
      check(
        'and whoever reaches it there without a code has no session, is answered by no function, and is not paired by a wrong code',
        withoutACode.session === 401 && /"unauthenticated"/.test(withoutACode.call) && withoutACode.wrongCode === 401,
        JSON.stringify({ ...withoutACode, call: withoutACode.call.slice(0, 120) }),
      )
      // The owner's browser, on the machine itself, now shows what another screen opens
      const forThere = await screenCode(one)
      check(
        'once the network is on, “Add a display” shows the address another screen opens, at this machine’s address on the network, with a picture of it for a camera',
        forThere.address === `${near}/pair#${forThere.code}` && forThere.pictured,
        `${String(forThere.address).replace(/#.*/, '#…')}; pictured: ${forThere.pictured}`,
      )
      // The owner opens that address in their own browser, to look at it. At the machine's
      // address on the network that browser holds no session, so nothing tells It that it is the
      // owner's: it is asked whether it is the screen, as any browser is, and until it says so
      // nothing is made of it and the code is left for the screen.
      const lookingThere = await one.context.newPage()
      // There that browser holds no session, and the site it loads there is refused a token
      const refusedThere = foresee(one, {
        says: refusedWith(401),
        of: exactly(`${near}/session/token`),
        times: 2,
        because: 'the owner’s browser opened the site at the machine’s address on the network, where it holds no session',
      })
      await lookingThere.goto(forThere.address)
      const lookedThere = {
        offeredToBecomeAScreen: Boolean(await until(() => becomeAScreen(lookingThere).isVisible(), 15_000)),
        pairedThere: await paired(lookingThere),
        theCodeIsStill: await isFor(forThere.code, near),
      }
      await lookingThere.close()
      refusedThere()
      lookedThere.onTheMachineItself = (await sessionOf(page)).role
      check(
        'the owner who opens that address in their own browser, where their session does not reach, is asked first and not made a screen: the code is not used, and their browser is the owner’s as before',
        JSON.stringify(lookedThere) ===
          JSON.stringify({ offeredToBecomeAScreen: true, pairedThere: false, theCodeIsStill: '200 screen', onTheMachineItself: 'owner' }),
        JSON.stringify(lookedThere),
      )
      four = began(await launch())
      namesSessionsAt(four, near)
      nowNotPaired(four, 'a screen opened the address before it said it was the screen', { asks: 4, at: near })
      await pairAsScreen(four.page, forThere.code, { at: near })
      nowPairedOrClosed(four)
      const waitingThere = await waitingAgent(A, ['--id', slug, '--timeout', '30'])
      await four.page.goto(`${near}/p/${slug}`)
      const whereThere = (await pageIn(four.page, { id: slug, site: near })).url()
      await four.page.frameLocator('.mount iframe').locator('#approve').click()
      const fromThere = await waitingThere.answered
      check(
        'a screen that opens that address afterwards, and says it is the screen, is paired as one, is shown a page at that same address of the machine’s, and what is done on it reaches the agent',
        (await sessionOf(four.page)).role === 'screen' &&
          SHOWING.test(whereThere) &&
          new URL(whereThere).hostname === new URL(near).hostname &&
          fromThere.action === 'approve',
        `${whereThere}; ${JSON.stringify(fromThere)}`,
      )
      // And what another computer runs to join
      const toJoin = await machineCommand(one)
      const D = home('d')
      const joinedThere = await join(D, marked('e2e elsewhere'), { invite: async () => toJoin.code, at: toJoin.url }).catch((e) => ({ failed: e.message }))
      const seenFromThere = await it(D, ['list']).then(
        (all) => all.map((p) => p.id),
        (e) => [`refused: ${e.message}`],
      )
      check(
        'and “Add a machine” shows the command another computer runs, naming that address: a machine that runs it joins there, and reaches It there',
        toJoin.url === near &&
          joinedThere.machine &&
          JSON.parse(readFileSync(path.join(D, 'machine.json'), 'utf8')).at === near &&
          seenFromThere.includes(slug),
        `${String(toJoin.command).replace(/--code \S+/, '--code …')}; ${JSON.stringify(joinedThere)}; ${JSON.stringify(seenFromThere)}`,
      )
      await it(D, ['logout']).catch(() => {})
    }
  } finally {
    // The screen that was paired at the machine's address on the network finds nothing there
    // once the network is off, and goes on trying for as long as it is open
    const itsPages = near?.replace(/:(\d+)$/, (_, port) => `:${Number(port) + 1}`)
    const closedToIt = four && during(four, closedUnder(near, itsPages, 'the network was turned off under a screen that reached It by it'))
    const offFrom = Date.now()
    turnedOff = mayOpen ? await it(A, ['network', 'off']).catch((e) => ({ failed: e.message })) : offAtFirst
    // That screen is closed once it has tried its address and said that nothing is there, or
    // after a few seconds in which it said nothing at all: it is not looked at again
    if (four) {
      await until(() => four.problems.some((problem) => problem.at >= offFrom), 8000, 50)
      await four.context.close().catch(() => {})
      closedToIt()
    }
  }
  const closedAgain =
    !near ||
    (await until(
      () =>
        plain(`${near}/`).then(
          () => false,
          () => true,
        ),
      15_000,
      500,
    ))
  if (mayOpen && openAllTheWhile) {
    openThroughout.whenOff = await answeredAt(openAllTheWhile)
    openThroughout.inTheSameFrame = shownFrame(two.page)?.url() === openAllTheWhile
    check(
      'a page that is open when the network is turned on or off goes on being shown at its address',
      JSON.stringify(openThroughout) === JSON.stringify({ before: '200,204', whenOn: '200,204', whenOff: '200,204', inTheSameFrame: true }),
      JSON.stringify(openThroughout),
    )
  }
  const reachedAtLast = await reachedFromANetwork()
  check(
    '`it network off` closes It to the network again within a few seconds, and it goes on answering the machine itself',
    turnedOff.network === false &&
      closedAgain &&
      reachedAtLast === '' &&
      (await until(
        () =>
          plain(`${APP}/`).then(
            (r) => r.status === 200,
            () => false,
          ),
        15_000,
        500,
      )),
    JSON.stringify(turnedOff),
  )
  // The owner's browser and the screen on this machine were open while the door was closed and opened: both carry on
  await page.goto(`${APP}/`)
  check(
    'and the browsers that were paired on the machine itself carry on as they were',
    (await until(() => page.locator(`a.cover[href="/p/${slug}"]`).isVisible(), 30_000)) &&
      (await sessionOf(page)).role === 'owner' &&
      (await sessionOf(two.page)).role === 'screen',
  )
  for (const settled of doorMoved) settled()

  // ------------------------------------------------------------------
  section('The connector and an add-on')
  const C = home('c')
  const boxed = await join(C, BOX)
  const session1 = `sess-${Date.now().toString(36)}`
  inFull['a conversation’s id in full'] = session1
  const cslug = `${slug}-c`
  await it(C, ['create', marked('Agent page'), '--id', cslug, '--dir', fixture], { extraEnv: { IT_HARNESS: 'claude-code', IT_SESSION: session1 } })
  // Codex, on this machine, already has an add-on under It's name in it, which no It folder has
  // a note of putting there. So when Codex's own command is not run for a click below, that is
  // because the person has not chosen Codex, and for no other reason. The stand-in is run here
  // by its own address, and never looked for by name.
  const codexItself = path.join(standInApps(process.env.IT_E2E_APPS), 'codex')
  for (const words of [
    ['plugin', 'marketplace', 'add', path.join(tmp, 'an-add-on-of-no-folder')],
    ['plugin', 'add', 'it-bridge@it'],
  ])
    execFileSync(codexItself, words, { env: itEnv(C) })
  const connector = startConnector(C)
  /** Where a machine's connector says add-ons can reach it, in the file it leaves for them, once it answers there. */
  const connectorOf = async (h) => {
    const says = (await it(h, ['status'])).connector
    return says?.ok === true ? { ...JSON.parse(readFileSync(path.join(h, 'connector.json'), 'utf8')), says } : undefined
  }
  const info = await until(async () => {
    const says = await connectorOf(C)
    return says && reachable(says) ? says : undefined
  }, 15_000)
  check('the connector starts and says where add-ons can reach it', Boolean(info), connector.log)
  if (!info) throw new Error('the connector of the machine that joined did not start, so nothing that follows has a connector to ask')
  const connectorToken = connectorTokenIn(C)
  noteSecret('a connector’s token', connectorToken)
  if (!QUICK) {
    // Usage reporting is turned off on this machine while its connector runs, and the machine
    // goes on being used. The connector's sender looks at the setting on each of its passes,
    // and when it finds reporting off it takes away whatever is kept to be sent. So a file is
    // put where the commands keep what they count, and once it is gone the sender has made a
    // pass and knows: from then on nothing may leave. This is the only connector that reports
    // here, so anything that arrives came from it.
    const turnedOff = await it(C, ['telemetry', 'off'])
    const keptToSend = path.join(C, 'usage.jsonl')
    const senderPassed = async () => {
      writeFileSync(keptToSend, '', { mode: 0o600 })
      return Boolean(await until(() => !existsSync(keptToSend), 30_000, 100))
    }
    const heardOfIt = await senderPassed()
    const before = usage.requests.length
    // A page is published, and published again, in a conversation of an agent that publishes
    // nothing else in the whole run
    const quietly = { extraEnv: { IT_HARNESS: QUIET_AGENT, IT_SESSION: session1 } }
    await it(C, ['create', marked('Quiet page'), '--id', `${cslug}-quiet`, '--html', '<p>made while reporting was off</p>'], quietly)
    await it(C, ['update', `${cslug}-quiet`, '--html', '<p>and published again</p>'], quietly)
    const keptByTheCommands = existsSync(keptToSend)
    // The sender makes another pass after that, and whatever it held went with it. What was
    // counted in this while can be told from everything else for the rest of the run, and is
    // looked for in all that was reported when the run is done.
    const passedAgain = await senderPassed()
    quietSince = { off: turnedOff.enabled === false, heardOfIt, before, after: usage.requests.length, keptByTheCommands, passedAgain }
    await it(C, ['telemetry', 'on'])
    await it(C, ['delete', `${cslug}-quiet`])
  }
  // Who may open the socket is what the system says of the file itself: nobody but its owner
  const others = info.socket ? (statSync(info.socket, { throwIfNoEntry: false })?.mode ?? 0o777) & 0o077 : null
  check(
    'on a socket only this user can open, where the system has them',
    process.platform === 'win32' ? info.port > 0 : info.socket === path.join(C, 'connector.sock') && others === 0,
    `${JSON.stringify(Object.keys(info).filter((k) => k !== 'token'))}; others may: ${others === null ? 'no socket' : others.toString(8)}`,
  )
  check(
    'and whoever asks the command how the connector is is not shown its token',
    !JSON.stringify(info.says).includes(connectorToken) && info.token === connectorToken,
  )
  const noToken = await askConnector(C, `/clicks?harness=claude-code&session=${session1}`, undefined, { token: 'wrong' })
  check('and even there, nothing is answered without its token', noToken.status === 401)
  const mod = addon(C, 'claude-code', session1)
  /** Waits until the connector counts a conversation as listening, which it does once an add-on has asked for it. */
  const listening = (session) =>
    awaited('the connector did not count the conversation as listening', async () => (await mod.health()).sessions?.includes(`claude-code:${session}`), 15_000)
  /** The person chooses an agent app for the machine, as the owner's browser does on the Machines page. */
  const chooses = async (harness) => answerTo('mutation', 'machines:toggle', { machineId: boxed.machine, harness, on: true }, (await sessionOf(page)).token)
  /** The clicks on a page that are waiting for an agent, as the machine lists them. */
  const waitingOn = async (id) => (await it(C, ['actions', '--id', id])).filter((x) => x.action === 'approve')
  // The machine joined with no agent app chosen for it, so none is connected there. An add-on
  // still running in a conversation that was open asks all the same: it is answered, given
  // nothing, and its conversation is not listened for. The click waits where the person sees it.
  await page.goto(`${APP}/p/${cslug}`)
  const cframe = page.frameLocator('.mount iframe')
  await pageIn(page, { id: cslug })
  await cframe.locator('#approve').click()
  await awaited('the click on the page did not come to wait for an agent', async () => (await waitingOn(cslug)).length === 1, 15_000)
  const NOT_CONNECTED = 'a claude-code conversation asked for its clicks, and that app is not connected here; it is given none'
  const unchosenAsks = asking(mod)
  // The connector says so once it has heard from It which apps the person chose, which is
  // none, and the add-on asks twice more after that
  const saidNotConnected = await until(() => connector.log.includes(NOT_CONNECTED), 15_000, 100)
  await unchosenAsks.askedSince(Date.now())
  await unchosenAsks.stop()
  const unchosen = {
    given: JSON.stringify({ clicks: unchosenAsks.given(), odd: unchosenAsks.odd() }),
    saidItIsThere: JSON.stringify(await askConnector(C, '/session', { harness: 'claude-code', session: session1 })),
    listenedFor: (await mod.health()).sessions?.length,
    stillWaiting: (await waitingOn(cslug)).length,
    saidSo: connector.log.split(NOT_CONNECTED).length - 1,
  }
  check(
    'with no agent app chosen for a machine, an add-on that asks its connector is answered and given no click, its conversation is not listened for, the click goes on waiting, and the connector says so once, by the app’s name alone',
    saidNotConnected &&
      JSON.stringify(unchosen) ===
        JSON.stringify({ given: '{"clicks":[],"odd":[]}', saidItIsThere: '{"ok":true}', listenedFor: 0, stillWaiting: 1, saidSo: 1 }),
    `${JSON.stringify(unchosen)} connector said: ${connector.log.slice(-600)}`,
  )
  // The person chooses Claude Code for the machine. Claude Code itself cannot be run here, so
  // its add-on cannot be installed; the add-on that asks has shown that it is there, and is answered.
  const choseClaude = await chooses('claude-code')
  // The conversation that made the page asks, and another conversation on the machine asks
  // beside it all the while: what each is given, until the click is acknowledged and after, is kept
  const firstAsks = asking(mod)
  const other = addon(C, 'claude-code', 'some-other-session')
  const otherAsks = asking(other)
  await listening(session1)
  await listening('some-other-session')
  const delivered = await until(() => firstAsks.firstGiven(), 15_000, 50)
  check(
    'once its app is chosen, the click on a page reaches the conversation that made it',
    choseClaude === 'answered' && delivered?.clicks.length === 1 && delivered.clicks[0].name === 'approve' && delivered.clicks[0].artifact === cslug,
    `chosen: ${choseClaude}; ${JSON.stringify(delivered)} connector said: ${connector.log.slice(-600)}`,
  )
  check(
    'in the one wording every add-on uses, which names the action and says only that someone had just used the page',
    delivered?.clicks[0]?.text ===
      `[It] The page "${marked('Agent page')}" (${cslug}) sent this just after someone used it: approve {"plan":"${PLAN}"} [action ${delivered?.clicks[0]?.id}]`,
    delivered?.clicks[0]?.text,
  )
  // In its first seconds it is waiting for the agent. Held by the add-on for longer than that
  // and not yet acknowledged, its agent is at something else, and the site says that instead.
  check(
    'until it is acknowledged the site says it is on its way',
    await until(() => page.locator('.status', { hasText: /Waiting for your agent|is busy, and gets it when it is free/ }).isVisible()),
  )
  if (!delivered) throw new Error('no click reached the conversation that made the page, so there is nothing for its add-on to acknowledge')
  await mod.ack(delivered.clicks.map((c) => c.id))
  const acknowledged = Date.now()
  check('once the add-on has it, the site says so', await until(() => page.locator('.status', { hasText: 'Your agent has it' }).isVisible()))
  // Both conversations have asked twice more since then, and been answered
  await firstAsks.askedSince(acknowledged)
  await otherAsks.askedSince(acknowledged)
  await firstAsks.stop()
  check(
    'and it is not offered again',
    firstAsks.askings.filter((one) => one.sent >= acknowledged).every((one) => one.clicks.length === 0) && firstAsks.given().length === 1,
    JSON.stringify(firstAsks.given().map((c) => c.id)),
  )
  check(
    'and no other conversation on the machine is offered it',
    otherAsks.given().length === 0 && otherAsks.odd().length === 0,
    JSON.stringify({ given: otherAsks.given().map((c) => c.id), odd: otherAsks.odd() }),
  )

  // A conversation that was cleared carries on under a new id. The other conversation goes on
  // asking beside it through this click as well. Nothing asks under the id the conversation
  // had before: whatever asks under an id is taken for the conversation of that id, and the
  // connector then leads nothing on from it to the new one.
  const session2 = `${session1}-cleared`
  await mod.became(session2)
  const mod2 = addon(C, 'claude-code', session2)
  const secondAsks = asking(mod2)
  await listening(session2)
  await cframe.locator('#approve').click()
  const followed = await until(() => secondAsks.firstGiven(), 15_000, 50)
  if (followed) await mod2.ack(followed.clicks.map((c) => c.id))
  const followedAndDone = Date.now()
  await secondAsks.askedSince(followedAndDone)
  await otherAsks.askedSince(followedAndDone)
  await otherAsks.stop()
  check(
    'after /clear, clicks on its pages follow the conversation to its new id: the one click reaches it there, once, and no other conversation is offered it',
    followed?.clicks.length === 1 &&
      followed.clicks[0].name === 'approve' &&
      followed.clicks[0].id !== delivered.clicks[0].id &&
      secondAsks.given().length === 1 &&
      otherAsks.given().length === 0,
    JSON.stringify({
      followed: followed?.clicks.map((c) => [c.name, c.id]),
      given: secondAsks.given().map((c) => c.id),
      theOther: otherAsks.given().map((c) => c.id),
    }),
  )

  // An agent that is blocked on `it wait` gets the click itself. The add-on goes on asking
  // all the while, as a real one does, and what it is given is kept.
  const blocked = await waitingAgent(C, ['--id', cslug, '--timeout', '30'])
  await cframe.locator('#approve').click()
  const viaWait = await blocked.answered
  // The add-on has asked twice more since the agent was answered: a click that was on its way
  // to the add-on as well would have been handed to it by now
  await secondAsks.askedSince(Date.now())
  const besideTheWaiter = {
    givenToTheAddOn: secondAsks.given().length,
    heldForAnAddOn: (await mod2.health()).held,
    stillWaiting: (await waitingOn(cslug)).length,
  }
  check(
    'a waiting agent gets the click, and the add-on is not also given it',
    viaWait.action === 'approve' &&
      !secondAsks.given().some((c) => c.id === viaWait.id) &&
      JSON.stringify(besideTheWaiter) === JSON.stringify({ givenToTheAddOn: 1, heldForAnAddOn: 0, stillWaiting: 0 }),
    `${JSON.stringify(viaWait)}; ${JSON.stringify(besideTheWaiter)}; the add-on was given ${JSON.stringify(secondAsks.given().map((c) => c.id))}`,
  )
  // An agent in another conversation waits with no page named: for its own clicks, and nobody else's
  const inAnother = await waitingAgent(C, ['--timeout', '9'], { extraEnv: { IT_HARNESS: 'claude-code', IT_SESSION: 'some-other-session' } })
  const pressedBesideIt = Date.now()
  await cframe.locator('#approve').click()
  const stillDelivered = await until(() => secondAsks.firstGiven(pressedBesideIt), 8000, 50)
  // The agent in the other conversation waits its whole while out, and is given nothing
  const theOtherWaited = await inAnother.answered
  check(
    'an agent waiting for its own clicks does not hold up, or take, another conversation’s',
    stillDelivered?.clicks.length === 1 && stillDelivered.clicks[0].name === 'approve' && theOtherWaited.timedOut === true,
    `${JSON.stringify(stillDelivered)}; the agent that waited: ${JSON.stringify(theOtherWaited)}`,
  )
  if (stillDelivered) await mod2.ack(stillDelivered.clicks.map((c) => c.id))
  // And the conversation that made the page, waiting with no page named, gets the click on it:
  // under the id it has now, though the page was made under the one it had before it was cleared
  const ownWait = await waitingAgent(C, ['--timeout', '30'], { extraEnv: { IT_HARNESS: 'claude-code', IT_SESSION: session2 } })
  await cframe.locator('#approve').click()
  const viaOwn = await ownWait.answered
  check(
    'and waiting with no page named, a conversation gets the clicks on its own pages',
    viaOwn.action === 'approve' && viaOwn.page === cslug,
    JSON.stringify(viaOwn),
  )
  await secondAsks.askedSince(Date.now())

  // A page made in a Codex conversation. Codex here is the stand-in, which notes how it was
  // called. The person has chosen Claude Code for this machine and not Codex, so Codex's own
  // command is not run for a click on the page, though Codex is there with an add-on under
  // It's name in it: the click waits.
  const xslug = `${slug}-x`
  const thread = `thr-${slug.slice(-6)}`
  await it(C, ['create', `Codex page ${PRIVATE_MARK}title`, '--id', xslug, '--dir', fixture], { extraEnv: { IT_HARNESS: 'codex', IT_SESSION: thread } })
  // The page of the Claude Code conversation stays open in a tab of its own, for one more click
  const besideCodex = await one.context.newPage()
  await besideCodex.goto(`${APP}/p/${cslug}`)
  await pageIn(besideCodex, { id: cslug })
  await page.goto(`${APP}/p/${xslug}`)
  const xframe = page.frameLocator('.mount iframe')
  const deletedAt = (await pageIn(page, { id: xslug })).url()
  await xframe.locator('#approve').click()
  // The click has reached It once the machine lists it as waiting, or once Codex's command has been run for it
  await until(async () => (await waitingOn(xslug)).length === 1 || queuedInCodex().length > 0, 15_000)
  // A click is then made on the Claude Code conversation's page, and that conversation's add-on
  // is given it. The connector was told of that click by It when the one for Codex had been
  // waiting there a while, and it takes what it is told of oldest first: had it been told of
  // the click for Codex too, it would have started Codex's command for it before it handed
  // this one over. The add-on asks twice more before what Codex was asked is looked at, and how
  // often its command was run in all is counted again further down.
  const pressedAfterCodexs = Date.now()
  await besideCodex.frameLocator('.mount iframe').locator('#approve').click()
  const handedOnAfterIt = await until(() => secondAsks.firstGiven(pressedAfterCodexs), 15_000, 50)
  if (handedOnAfterIt) await mod2.ack(handedOnAfterIt.clicks.map((c) => c.id))
  await secondAsks.askedSince(Date.now())
  await secondAsks.stop()
  await besideCodex.close()
  const notChosen = {
    queued: queuedInCodex().length,
    waiting: (await waitingOn(xslug)).length,
    codexWasLookedAt: codexCalls().some((args) => args[0] === '--version'),
  }
  check(
    'while Codex is not chosen for the machine, a click on a page a Codex conversation made waits, and Codex’s own command is never run for it',
    handedOnAfterIt?.clicks.length === 1 && notChosen.queued === 0 && notChosen.waiting === 1 && notChosen.codexWasLookedAt,
    `${JSON.stringify({ handedOnAfterIt: handedOnAfterIt?.clicks.length, ...notChosen })} connector said: ${connector.log.slice(-400)}`,
  )
  // Six times the Claude Code conversation's page was clicked. Each click has an id of its
  // own, and went one way: the four that an add-on was given were given to no waiting agent,
  // the two that a waiting agent was given were given to no add-on, and no add-on was given
  // anything else in all the time it asked.
  const wentToAnAddOn = [...firstAsks.given(), ...secondAsks.given()].map((c) => c.id)
  const wentToAnAgent = [viaWait.id, viaOwn.id]
  check(
    'every click on that page was handed over once, to the add-on of its conversation or to the agent that waited for it, and to nothing besides',
    JSON.stringify(wentToAnAddOn) ===
      JSON.stringify([delivered.clicks[0].id, followed?.clicks[0]?.id, stillDelivered?.clicks[0]?.id, handedOnAfterIt?.clicks[0]?.id]) &&
      wentToAnAgent.every((id) => typeof id === 'string') &&
      new Set([...wentToAnAddOn, ...wentToAnAgent]).size === 6,
    JSON.stringify({ wentToAnAddOn, wentToAnAgent }),
  )
  // Chosen, with no hook running, the click goes into Codex's own queue for that conversation.
  // That queue is for a conversation some Codex has open, which Codex says with a file it keeps
  // open for as long as the conversation is being written. This run stands in for that Codex.
  const locks = path.join(process.env.IT_E2E_APPS, 'codex', 'thread-writer-locks')
  mkdirSync(locks, { recursive: true })
  writeFileSync(path.join(locks, `${thread}.lock`), '')
  openSync(path.join(locks, `${thread}.lock`), 'r')
  const choseCodex = await chooses('codex')
  const queued = await until(() => queuedInCodex()[0], 25_000)
  const message = queued?.find((arg) => arg.startsWith('--message=')) ?? ''
  check(
    'once Codex is chosen, the click on a page a Codex conversation made is put in Codex’s own queue, for that conversation',
    choseCodex === 'answered' && queued?.includes(`--thread=${thread}`) && /\(.*-x\) sent this just after someone used it: approve /.test(message),
    `chosen: ${choseCodex}; ${JSON.stringify(queued)} connector said: ${connector.log.slice(-400)}`,
  )
  check(
    'naming the action and where to read what it carried, and never putting that on a command line',
    /run `it action [a-z0-9]+` to read what it carried/.test(message) && !message.includes('{') && !JSON.stringify(codexCalls()).includes('\\"plan\\"'),
    message,
  )
  const viaQueue = await until(async () => {
    const id = /\[action ([a-z0-9]+)\]/.exec(message)?.[1]
    const read = id ? await it(C, ['action', id]) : undefined
    return read?.route === 'queue' ? read : undefined
  }, 15_000)
  // Codex's command has answered for it and It has been told so: the command was run for this
  // click once, and for nothing else
  check(
    'and the agent reads the rest by its id, with the way it arrived noted, and Codex’s command was run for it once',
    viaQueue?.data?.plan === PLAN && viaQueue.delivery === 'handed_off' && queuedInCodex().length === 1,
    `${JSON.stringify(viaQueue)}; Codex's queue was asked ${queuedInCodex().length} time(s)`,
  )
  // The page goes while it is open, and the person is told
  await it(C, ['delete', xslug])
  check('a page deleted while it is open is taken off the screen', await until(() => page.getByText('No such page').isVisible(), 15_000))
  const afterDeleting = await until(async () => ((await plain(deletedAt)).status !== 200 ? (await plain(deletedAt)).status : undefined), 20_000, 1000)
  check(
    'and the address it was shown at gives its files no more',
    afterDeleting === 401 || afterDeleting === 404,
    afterDeleting ?? (await plain(deletedAt)).status,
  )
  check('and is gone for the agent that made it', (await refused(it(C, ['read', xslug]))) === 'not_found')
  await page.goto(`${APP}/p/${cslug}`)
  await pageIn(page, { id: cslug })

  // Nothing is listening: the click waits, visibly. The add-on has stopped asking, and the
  // connector stops counting its conversation as listening a few seconds after it last asked
  await awaited(
    'the connector went on counting a conversation as listening after its add-on had stopped asking',
    async () => (await mod.health()).sessions?.length === 0,
    20_000,
  )
  await cframe.locator('#approve').click()
  const parked = await until(async () => (await it(C, ['actions', '--id', cslug])).find((x) => x.action === 'approve'), 10_000)
  check('with nothing listening, a click waits and is listed', Boolean(parked))
  const report = await until(async () => {
    const m = await it(C, ['whoami'])
    return m.connectorVersion ? m : undefined
  })
  check(
    'the connector reports itself and what it found on the machine',
    report?.harnesses?.some((h) => h.id === 'codex' && h.version === '0.160.0'),
    JSON.stringify(report),
  )
  await page.goto(`${APP}/machines`)
  check(
    'the site lists the machine as online',
    await until(() => page.locator('.panel', { hasText: BOX }).locator('.status', { hasText: 'Online' }).isVisible()),
  )

  // A connector holds what it has counted for a little while before it sends it, and what it
  // still holds when it is stopped or killed is not sent. The run asks, at its end, for what
  // this connector counted: that it started, the pages that were published, the clicks its
  // add-on heard, and the click that Codex's queue took, counted as having woken the
  // conversation. The machine is revoked below, which stops its connector, and in the whole run
  // the connector is killed before that. So it is left running, in either form of the run,
  // until all of that has been sent. In the whole run reporting was turned off while this
  // connector ran, and what it had counted until then went with that, as it should: that it
  // started is asked there of the connector that takes its place.
  const counted = () => usage.batches.flatMap((batch) => batch.events ?? [])
  const allCounted = () =>
    (QUICK ? ['service.started', 'page.published'] : ['page.published']).every((name) => counted().some((e) => e.name === name)) &&
    counted().some((e) => e.name === 'answer.delivered' && e.properties?.agent === 'claude-code' && e.properties.path === 'heard') &&
    counted().some((e) => e.name === 'answer.delivered' && e.properties?.agent === 'codex' && e.properties.path === 'woke') &&
    counted().some((e) => e.name === 'agent.woken' && e.properties?.agent === 'codex')
  check(
    'the connector sends what it has counted within the while it holds it, down to the click that Codex’s queue took',
    await until(allCounted, 60_000, 1000),
    JSON.stringify(counted().map((e) => [e.name, e.properties?.agent, e.properties?.path])),
  )
  // The connector of this machine that is running when the machine is revoked: this one, or in the whole run the one that takes its place
  let connectorAtTheEnd = connector
  if (!QUICK) {
    // A connector that dies holding a click loses nothing
    const poll3 = setInterval(() => void mod2.clicks().catch(() => {}), 1000)
    const held = await until(async () => ((await mod2.health()).held > 0 ? true : undefined), 10_000)
    clearInterval(poll3)
    connector.kill('SIGKILL')
    check('(the connector was holding the click when it was killed)', held)
    const returned = await until(async () => parked && (await it(C, ['actions', '--id', cslug])).find((x) => x.id === parked.id), 100_000, 3000)
    check('a click its connector died holding goes back to waiting within two minutes', Boolean(returned))
    // The new one listens on a port, as it does where there are no sockets (Windows). There
    // the token is never sent: each request and each answer carries a seal made with it.
    const next = startConnector(C, { IT_CONNECTOR_PORT: '1' })
    connectorAtTheEnd = next
    const onPort = await until(async () => {
      const i = await connectorOf(C).catch(() => undefined)
      return i?.port > 0 ? { port: i.port } : undefined
    }, 15_000)
    noteSecret('a connector’s token', connectorTokenIn(C))
    sealedAnswers.length = 0
    const poll4 = setInterval(() => void mod2.clicks().catch(() => {}), 1000)
    const redelivered = await until(async () => {
      const r = await mod2.clicks()
      return parked && r.clicks?.find((c) => c.id === parked.id) ? r : undefined
    }, 15_000)
    clearInterval(poll4)
    check('and a new connector delivers it', Boolean(redelivered), next.log)
    if (redelivered) await mod2.ack([parked.id])
    const unsealed = await askConnector(C, '/health', undefined, { token: 'wrong' })
    check(
      'over a port, where any program on the machine could ask, every answer is sealed and nothing is answered without the seal',
      Boolean(onPort) && sealedAnswers.length > 2 && sealedAnswers.slice(0, -1).every(Boolean) && unsealed.status === 401,
      `${JSON.stringify(onPort)} sealed: ${sealedAnswers.join(',')}`,
    )
    // The new connector counted that it started, and holds that for a little while before it
    // sends it. The machine is revoked next, which stops its connector, so that is waited for first.
    check(
      'and the connector that took its place sends that it started within the while it holds that',
      await until(() => counted().some((e) => e.name === 'service.started'), 60_000, 1000),
      JSON.stringify(counted().map((e) => e.name)),
    )
  } else
    console.log(
      '  skip  a connector killed while it holds a click, and the one that takes its place and listens on a port: the quick run does not wait out a lease',
    )

  // An app that is disconnected while a click is on its way to its add-on. Another machine joins,
  // and its connector reaches It by a way on which the run can keep an answer back. Its add-on
  // has not asked for so long that the connector has stopped counting it as listening,
  // and a click is made on its page. The add-on asks again, and the connector claims the click
  // for it: that answer is kept back, the person disconnects the app, the connector hears of
  // it, and only then is the answer let go. The add-on must be handed nothing.
  const R = home('r')
  const relayed = await join(R, marked('e2e disconnected'))
  noteHome(R, noteWhenSeen)
  const way = await wayThrough(APP)
  const rslug = `${slug}-r`
  const sessionR = `sess-r-${Date.now().toString(36)}`
  inFull['a conversation’s id in full, on the machine whose app is disconnected'] = sessionR
  await it(R, ['create', marked('Disconnected page'), '--id', rslug, '--dir', fixture], { extraEnv: { IT_HARNESS: 'claude-code', IT_SESSION: sessionR } })
  const connectorR = startConnector(R, { IT_URL: way.origin })
  await awaited('the connector of the machine whose app is to be disconnected did not start', async () => reachable((await connectorOf(R)) ?? {}), 15_000)
  noteSecret('a connector’s token', connectorTokenIn(R))
  /** The person chooses, or disconnects, Claude Code for that machine, as the owner's browser does. */
  const claudeOnR = (on, asOwner) => answerTo('mutation', 'machines:toggle', { machineId: relayed.machine, harness: 'claude-code', on }, asOwner)
  const modR = addon(R, 'claude-code', sessionR)
  /** Whether the connector listens for a conversation that has never asked before and says now that it is there: it does while the app is chosen, and not once it has heard that it is not. */
  let neverSeen = 0
  const listensForANewOne = async () => {
    const conversation = `${sessionR}-asks-${++neverSeen}`
    await askConnector(R, '/session', { harness: 'claude-code', session: conversation })
    return Boolean((await modR.health()).sessions?.includes(`claude-code:${conversation}`))
  }
  /** How many clicks on the page are waiting for an agent, claimed by nothing: those are the ones the machine lists. */
  const waitingOnR = async () => (await it(R, ['actions', '--id', rslug])).length
  // An add-on's asking waits a moment for the click to be claimed, and is answered with what
  // there is when the moment is over. The disconnecting has to fall inside that moment, with
  // the asking still unanswered when the claim's answer is let go: where it did not, the click
  // has gone back to waiting, and it is tried again, five times at most. A machine that is
  // busy with other things may miss the moment once or twice, and hardly five times running.
  const disconnectings = []
  for (let attempt = 1; attempt <= 5 && !disconnectings.at(-1)?.inTheMoment; attempt++) {
    const asOwner = (await sessionOf(page)).token
    const disconnecting = { chosen: await claudeOnR(true, asOwner) }
    await awaited('the connector did not hear that the app was chosen', listensForANewOne, 15_000, 250)
    // The conversation that made the page has not asked for long enough that it is not counted
    // as listening, so a click on its page waits until it asks
    await awaited(
      'the connector went on counting a conversation as listening after its add-on had stopped asking',
      async () => !(await modR.health()).sessions?.includes(`claude-code:${sessionR}`),
      20_000,
    )
    if (attempt === 1) {
      await page.goto(`${APP}/p/${rslug}`)
      await pageIn(page, { id: rslug })
      await page.frameLocator('.mount iframe').locator('#approve').click()
    }
    await awaited('the click on the page did not come to wait for an agent', async () => (await waitingOnR()) === 1, 30_000, 500)
    way.keepBack('delivery:claim')
    let answeredAlready = false
    const askedWhileClaiming = modR.clicks().then((given) => {
      answeredAlready = true
      return given
    })
    disconnecting.claimKeptBack = Boolean(await until(() => way.keeping(), 2000, 2))
    disconnecting.disconnected = await claudeOnR(false, asOwner)
    disconnecting.heard = Boolean(await until(async () => !(await listensForANewOne()), 3000, 2))
    disconnecting.inTheMoment = disconnecting.claimKeptBack && disconnecting.heard && !answeredAlready
    way.letGo()
    disconnecting.handed = (await askedWhileClaiming).clicks?.length
    disconnecting.handedAfterwards = (await modR.clicks()).clicks?.length
    disconnecting.waitsAgain = Boolean(await until(async () => (await waitingOnR()) === 1, 30_000, 500))
    disconnectings.push(disconnecting)
  }
  check(
    'an add-on whose app is disconnected while a click is being claimed for it is handed nothing, then or afterwards, and the click goes back to waiting',
    JSON.stringify(disconnectings.at(-1)) ===
      JSON.stringify({
        chosen: 'answered',
        claimKeptBack: true,
        disconnected: 'answered',
        heard: true,
        inTheMoment: true,
        handed: 0,
        handedAfterwards: 0,
        waitsAgain: true,
      }),
    `${JSON.stringify(disconnectings)} connector said: ${connectorR.log.slice(-400)}`,
  )
  await stopped(connectorR)
  await way.close()
  await it(R, ['delete', rslug]).catch(() => {})
  await it(R, ['logout']).catch(() => {})

  // ------------------------------------------------------------------
  section('Revoking and signing out')
  // The site asks before revoking. What it asked, and that it was answered, is noted, so that a
  // failure here says which step did not happen.
  // An agent on the machine that is about to be revoked has paired a browser for itself, with a
  // code the machine asked for, and that browser has a code for another machine waiting
  const itsOwnBrowser = await pairedByScript(await ownerAddress({ home: C }))
  const itsWaitingCode = await codeFrom(itsOwnBrowser, 'a machine')
  const asked = []
  const answer = (d) => {
    asked.push(d.message())
    void d.accept()
  }
  page.on('dialog', answer)
  await page.goto(`${APP}/machines`)
  const box = page.locator('.panel', { hasText: BOX })
  await box.getByRole('button', { name: 'Revoke' }).click()
  const revokedOnSite = await until(async () => (await box.getByRole('button', { name: 'Revoke' }).count()) === 0, 15_000)
  page.off('dialog', answer)
  let lastSaid
  check(
    'a revoked machine can do nothing at once',
    revokedOnSite &&
      (await until(async () => {
        lastSaid = await refused(it(C, ['list']))
        return lastSaid === 'unauthenticated'
      }, 25_000)),
    `the site asked ${asked.length} time(s); the machine's panel then read: ${(await box.innerText().catch(() => '(gone)')).replace(/\s+/g, ' ').slice(0, 300)}; the machine was last told: ${lastSaid}`,
  )
  const joinsLate = await join(home('late'), marked('e2e too late'), { invite: async () => itsWaitingCode }).then(
    () => 'joined',
    (e) => e.code,
  )
  check(
    'the site said before it was confirmed what would go with the machine, and it went: the browser that was paired with the machine’s own code has no session, its token is refused, and the code it had waiting joins no machine',
    /1 paired browser came from it, and is ended with it\./.test(asked[0] ?? '') &&
      itsOwnBrowser.status === 200 &&
      (await tokenWith(itsOwnBrowser.cookie)).status === 401 &&
      (await answerTo('mutation', 'sessions:inviteMachine', {}, itsOwnBrowser.token)) === 'unauthenticated' &&
      joinsLate === 'unauthenticated',
    JSON.stringify({ asked: (asked[0] ?? '').replace(/“[^”]*”/, '“…”').slice(0, 260), paired: itsOwnBrowser.status, joinsLate }),
  )
  check('and the other machines carry on', (await it(A, ['list'])).length >= 1 && (await it(B, ['list'])).length >= 1)
  check(
    'and the owner’s own browser is as it was',
    (await sessionOf(page)).role === 'owner' && (await answerTo('query', 'machines:list', {}, (await sessionOf(page)).token)) === 'answered',
  )
  // What is pressed on a page whose machine is gone is not lost with it: any of the person's
  // other machines that asks for it gets it
  const orphaned = await waitingAgent(B, ['--id', cslug, '--timeout', '30'])
  await page.goto(`${APP}/p/${cslug}`)
  await pageIn(page, { id: cslug })
  await page.frameLocator('.mount iframe').locator('#approve').click()
  const adopted = await orphaned.answered
  check('a click on a page whose machine was revoked goes to another of the person’s machines that asks', adopted.action === 'approve', JSON.stringify(adopted))

  /** Opens a page in a tab, and gives its frame and the address it is shown at once the site has shown it. */
  const shownIn = async (p, id = slug) => {
    await p.goto(`${APP}/p/${id}`)
    const f = await pageIn(p, { id })
    return { frame: f, url: f.url() }
  }

  // A display that is forgotten from another one, while it has a page open: the screen that was lost
  const lost = await shownIn(two.page)
  check('while its display is paired, the open page can fetch its own files', (await lost.frame.evaluate(() => fetch('app.js').then((r) => r.status))) === 200)
  const servedBefore = await servedAt(lost.url)
  const theScreens = await displayOf(two.page)
  const toldOfTheScreen = toldItIsOver(theScreens)
  // The token the screen's session earned it a moment before it is forgotten, which has minutes left to run
  const screensToken = (await sessionOf(two.page)).token
  page.once('dialog', (d) => d.accept())
  await page.goto(`${APP}/displays`)
  // Its one tab learns that its pairing has ended, and the run asks as the site does whether it has a session
  nowNotPaired(two, 'the screen’s display was forgotten from the owner’s browser', { asks: 6 })
  await page.locator('.row', { hasText: SCREEN }).getByRole('button', { name: 'Forget' }).click()
  check(
    'a display forgotten from another one is signed out where it stands, its page taken off the screen',
    await until(() => two.page.locator('.door').isVisible(), 30_000),
  )
  const afterForget = await onceToldItIsOver(theScreens, toldOfTheScreen, lost.url)
  check(
    'and the address its page was shown at gives nothing from then on: not a file, and not another while of being kept alive',
    servedBefore === '200,204' && afterForget.told && afterForget.gives === '401,401',
    `before: ${servedBefore}; after: ${JSON.stringify(afterForget)}`,
  )
  check(
    'and it is not one of the displays any more, and its browser has no session',
    !(await it(A, ['displays'])).some((d) => d.name === SCREEN) &&
      (await sessionOf(two.page)).status === 401 &&
      (await answerTo('query', 'artifacts:list', {}, screensToken)) === 'unauthenticated',
  )
  // The screen has served, and its browser is closed: nothing more is foreseen of it
  await two.context.close().catch(() => {})
  nowPairedOrClosed(two)

  // Signing out where It cannot be reached to end the pairing. A browser of its own is paired
  // for this, and what it sends to have its session ended is kept from leaving it, as a
  // connection that has gone keeps it. The site then says that the browser could not be signed
  // out and is still paired, and offers to try again or to stay.
  const staying = began(await open('owner'))
  const stayingAs = await sessionOf(staying.page)
  const COULD_NOT =
    'This browser could not be signed out, because It could not be reached to end its pairing. It is still paired with It: try again when the connection is back, or stay paired.'
  const saysItCouldNot = () => until(() => staying.page.getByRole('alert').filter({ hasText: COULD_NOT }).isVisible(), 30_000)
  const asksToSignOut = async () => {
    await staying.page.locator('button[aria-label="More"]').click()
    await staying.page.getByRole('menuitem', { name: 'Sign out' }).click()
  }
  await staying.context.route(`${APP}/session/end`, (route) => route.abort('connectionfailed'))
  // From here until it is signed out it names the session it holds, to end it
  staying.notPaired.push({ from: Date.now(), until: Number.POSITIVE_INFINITY })
  const couldNotBeSent = during(staying, [
    {
      says: notMade('ERR_CONNECTION_FAILED'),
      of: exactly(`${APP}/session/end`),
      times: 2,
      because: 'a browser asked to be signed out while what it sent to end its session could not leave it',
    },
  ])
  await asksToSignOut()
  const couldNot = { saidSo: Boolean(await saysItCouldNot()) }
  await staying.page.getByRole('button', { name: 'Stay paired' }).click()
  couldNot.stayingShowsTheSite = Boolean(await until(() => paired(staying.page), 15_000))
  couldNot.underTheSessionItHad = (await sessionOf(staying.page)).session === stayingAs.session
  await staying.page.goto(`${APP}/p/${slug}`)
  couldNot.andShowsAPage = Boolean(await pageIn(staying.page, { id: slug }).catch(() => undefined))
  await staying.page.goto(`${APP}/`)
  await awaited('the browser that stayed paired did not show the site again', () => paired(staying.page), 20_000)
  await asksToSignOut()
  couldNot.saidSoAgain = Boolean(await saysItCouldNot())
  await couldNotBeSent.said()
  couldNotBeSent()
  // It is in reach again, and the person tries again
  await staying.context.unroute(`${APP}/session/end`)
  nowNotPaired(staying, 'a browser was signed out when the person tried again', { asks: 4 })
  await staying.page.getByRole('button', { name: 'Try again' }).click()
  couldNot.triedAgainItIsSignedOut = Boolean(await until(() => staying.page.locator('.door').isVisible(), 20_000))
  couldNot.andHasNoSession = (await sessionOf(staying.page)).status
  check(
    'a browser that cannot reach It to end its pairing is not signed out, and is told so, with what it can do: staying, it is paired under the session it had and shows a page; trying again once It is in reach, it is signed out',
    JSON.stringify(couldNot) ===
      JSON.stringify({
        saidSo: true,
        stayingShowsTheSite: true,
        underTheSessionItHad: true,
        andShowsAPage: true,
        saidSoAgain: true,
        triedAgainItIsSignedOut: true,
        andHasNoSession: 401,
      }),
    JSON.stringify(couldNot),
  )
  await staying.context.close().catch(() => {})
  nowPairedOrClosed(staying)

  // Signing out, in another tab of the same browser, so the frame is still there to try
  const mine = await shownIn(page)
  const theOwners = await displayOf(page)
  const toldOfTheOwners = toldItIsOver(theOwners)
  const second = await one.context.newPage()
  await second.goto(`${APP}/`)
  await second.locator('button[aria-label="More"]').click()
  // Its other tab learns that the browser has signed out, and names the session it held
  nowNotPaired(one, 'the owner’s browser signed out in one of its tabs', { asks: 8 })
  const signedOutFrom = Date.now()
  await second.getByRole('menuitem', { name: 'Sign out' }).click()
  check('signing out in a tab shows there how to pair the browser', await until(() => second.locator('.door').isVisible(), 15_000))
  check('signing out in one tab takes the page off the screen in the other', await until(() => page.locator('.door').isVisible(), 15_000))
  const after = await onceToldItIsOver(theOwners, toldOfTheOwners, mine.url)
  check('and the address the page was shown at is closed from then on', after.told && after.gives === '401,401', JSON.stringify(after))
  // The tab that was asked names the session to It twice: to end it, and once more on finding
  // the browser not paired, so that its cookie is cleared again should an answer that was on
  // its way have put it back. The other tab names it on finding the same, and once more for
  // each asking of its own that word from the first tab overtook, for the same reason: how
  // many that is depends on how the two tabs' requests fall, and each is told there is nothing
  // to end. This browser has signed out of no session before, so one session is all that is named.
  const namedIn = (tab) => one.exchanges.filter((x) => x.path === '/session/end' && x.tab === tab && x.sent >= signedOutFrom)
  await until(() => namedIn(second).filter((x) => x.answered !== null).length >= 2 && namedIn(page).some((x) => x.answered !== null), 15_000, 50)
  const namedOnSigningOut = {
    whereItWasAsked: namedIn(second)
      .map((x) => x.status)
      .join(),
    inTheOtherTab: namedIn(page)
      .map((x) => x.status)
      .join(),
    sessionsNamed: new Set([...namedIn(second), ...namedIn(page)].map((x) => x.named)).size,
  }
  check(
    'signing out names the session to It twice from the tab it was asked in, which is told that it is ended and then that there is nothing to end, and from the other tab, which is only ever told the same',
    namedOnSigningOut.whereItWasAsked === '200,401' && /^401(,401){0,3}$/.test(namedOnSigningOut.inTheOtherTab) && namedOnSigningOut.sessionsNamed === 1,
    JSON.stringify(namedOnSigningOut),
  )
  await second.close()
  // The person pairs the same browser again, from the machine
  const pairedAgainFrom = Date.now()
  await pairAsOwner(page)
  nowPairedOrClosed(one)
  check(
    'a browser that signed out is paired again with a new address from `it site`, and is the display it was',
    (await sessionOf(page)).role === 'owner' &&
      (await until(() => page.locator('.reminders .chip', { hasText: WALL }).isVisible())) &&
      (await it(A, ['displays'])).filter((d) => d.name === WALL).length === 1,
    JSON.stringify(await it(A, ['displays'])),
  )
  // The tab that finds the browser paired names the session it signed out of once more, which
  // is over: its cookie is cleared again, and nothing is ended
  const namedOncePaired = () => one.exchanges.filter((x) => x.path === '/session/end' && x.tab === page && x.sent >= pairedAgainFrom)
  await until(() => namedOncePaired().some((x) => x.answered !== null), 15_000, 50)
  const oncePaired = {
    answered: namedOncePaired()
      .map((x) => x.status)
      .join(),
    theSessionItSignedOutOf: namedOncePaired().every((x) => x.named === namedIn(second)[0]?.named),
    stillPaired: (await sessionOf(page)).status,
  }
  check(
    'and the tab that finds the browser paired again names the session it signed out of once, and is told that the browser holds another: nothing is ended by it',
    JSON.stringify(oncePaired) === JSON.stringify({ answered: '409', theSessionItSignedOutOf: true, stillPaired: 200 }),
    JSON.stringify(oncePaired),
  )

  // A page made on the second machine, for what follows
  const sslug = `${slug}-s`
  await it(B, ['create', marked('Second machine’s page'), '--id', sslug, '--dir', fixture])
  // From here this browser's connection to the backend can be made to go silent: open, and
  // carrying nothing either way, which is what a connection that has died looks like
  let silent = false
  // A connection that went silent stays silent: one that dropped part of what was said and
  // then carried on would be a fault no real connection has
  const silenced = new Set()
  const open_ = new Set()
  // What is carried is listened to on its way: when each connection was made and whether the
  // backend has answered on it what the tab keeps asked there, and each sending of a click with
  // whether the backend has answered it
  const connections = []
  const clicksSent = []
  const onTheWay = (m) => {
    try {
      return JSON.parse(String(m))
    } catch {
      return undefined
    }
  }
  await one.context.routeWebSocket(
    (url) => url.pathname.endsWith('/sync'),
    (ws) => {
      const server = ws.connectToServer()
      open_.add(ws)
      const connection = { made: Date.now(), answeredOn: false }
      connections.push(connection)
      const carries = () => {
        if (silent) silenced.add(ws)
        return !silenced.has(ws)
      }
      ws.onMessage((m) => {
        if (!carries()) return
        const said = onTheWay(m)
        if (said?.type === 'Mutation' && said.udfPath === 'actions:submit') clicksSent.push({ ws, request: said.requestId, answered: false })
        server.send(m)
      })
      server.onMessage((m) => {
        if (!carries()) return
        const said = onTheWay(m)
        if (said?.type === 'TransitionChunk' || (said?.type === 'Transition' && said.modifications?.some((change) => change.type === 'QueryUpdated')))
          connection.answeredOn = true
        if (said?.type === 'MutationResponse') for (const sent of clicksSent) if (sent.ws === ws && sent.request === said.requestId) sent.answered = true
        ws.send(m)
      })
    },
  )
  const goSilent = () => {
    silent = true
    for (const ws of open_) silenced.add(ws)
  }
  /** The connection comes back: what went silent is closed, as a dead connection is in the end, and the next one carries again. */
  const mend = () => {
    silent = false
    for (const ws of silenced) {
      open_.delete(ws)
      void Promise.resolve(ws.close()).catch(() => {})
    }
  }
  await page.goto(`${APP}/`)
  await awaited('the browser that was paired again was not shown its pages', () => page.locator('main.grid-view').isVisible(), 20_000)

  // Signing out while the backend cannot be told. The display keeps a token for exactly this,
  // and presents it itself, by another road, as soon as it can.
  const theirs = await shownIn(page, sslug)

  // A click made while the connection is down, in a tab that is then closed: the phone in a
  // pocket. It is kept in the browser, and sent, once, when the site is next open with a connection.
  const phoneFrom = Date.now()
  const phone = await one.context.newPage()
  await shownIn(phone, sslug)
  // The click is to go out over a connection that has died, and not while one is still being
  // made: the tab's connection is there, and the backend has answered on it
  await awaited(
    'the tab that was opened did not come to have its live connection',
    () => connections.some((c) => c.made >= phoneFrom && c.answeredOn),
    20_000,
    50,
  )
  // What this browser may already be keeping is from before: a click whose answer never came,
  // which is no part of this
  const already = new Set((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('it.outbox.')))) ?? [])
  goSilent()
  await phone.frameLocator('.mount iframe').locator('#approve').click()
  const keptHere = await until(() => phone.locator('.status', { hasText: 'Saved on this browser, not sent yet' }).isVisible(), 20_000)
  /** What this browser is keeping to send later, without what any of it carries. */
  const saved = () =>
    page.evaluate(
      (before) =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith('it.outbox.') && !before.includes(k))
          .map((k) => {
            const e = JSON.parse(localStorage.getItem(k))
            return { name: e.envelope.name, attended: e.envelope.attended ?? null, left: e.left === true, id: e.envelope.clientActionId.slice(0, 8) }
          }),
      [...already],
    )
  const keys = async () => (await saved()).length
  // A click is kept the moment it is made, and whether the person was there is filled in a few
  // seconds later. The tab is closed after that, as a person who pockets their phone would.
  const judged = await until(async () => (await saved()).some((e) => e.attended === true), 15_000)
  const savedBefore = await saved()
  // What the bar under the page says of the click at the last, for when it is not what it should be
  const barSaid = (await phone.locator('.status').allInnerTexts()).join(' | ')
  await phone.close()
  check(
    'a click made with the connection down is kept in the browser, and the person is told it has not been sent',
    keptHere && judged && savedBefore.length === 1 && (await it(B, ['actions', '--id', sslug])).length === 0,
    `said so: ${Boolean(keptHere)}; the bar under the page said: “${barSaid}”; kept: ${JSON.stringify(savedBefore)}`,
  )
  const mended = clicksSent.length
  mend()
  const arrived = await until(
    async () => {
      const all = await it(B, ['actions', '--id', sslug])
      return all.length ? all : undefined
    },
    60_000,
    500,
  )
  // The browser keeps nothing to send again, and the backend has answered every sending of the
  // click that the site began: whatever was going to arrive of it has arrived
  const keptNoMore = Boolean(await until(async () => (await keys()) === 0, 15_000, 100))
  const sendings = clicksSent.slice(mended)
  const allAnswered = Boolean(await until(() => sendings.length > 0 && sendings.every((sent) => sent.answered || !open_.has(sent.ws)), 15_000, 50))
  const afterwards = await it(B, ['actions', '--id', sslug])
  check(
    'and when the connection is back it is sent from another tab of the site, once, as the person’s own click, and is not kept any more',
    arrived?.length === 1 &&
      keptNoMore &&
      allAnswered &&
      afterwards.length === 1 &&
      afterwards[0].action === 'approve' &&
      afterwards[0].sentByThePageItself === undefined,
    JSON.stringify({ afterwards, keptNoMore, allAnswered, sendings: sendings.length }),
  )
  if (afterwards[0]) await it(B, ['ack', afterwards[0].id])
  const hasToken = await until(() => page.evaluate(() => localStorage.getItem('it.signout') !== null), 20_000)
  // In another tab, as before, so that the page stays open to be tried afterwards
  const leavingTab = await one.context.newPage()
  await leavingTab.goto(`${APP}/`)
  // The tab signs out with what it knows of its own display, which it has once it shows the
  // display's name. Until then it has nothing to leave behind for the backend, and says it cannot sign out
  await awaited('the tab did not come to know its own display', () => leavingTab.locator('.reminders .chip').first().isVisible(), 20_000)
  const itsDisplayThen = await displayOf(page)
  const toldOfItThen = toldItIsOver(itsDisplayThen)
  goSilent()
  await leavingTab.locator('button[aria-label="More"]').click()
  nowNotPaired(one, 'the owner’s browser signed out in one of its tabs with the backend out of reach', { asks: 8 })
  await leavingTab.getByRole('menuitem', { name: 'Sign out' }).click()
  check(
    'with the backend out of reach, signing out still signs out, and says a page may take a while to stop',
    hasToken && (await until(() => leavingTab.locator('.door', { hasText: 'close its tab to be sure' }).isVisible(), 40_000)),
    `token kept: ${hasToken}; the tab says: ${(await leavingTab.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`,
  )
  const afterSilent = await onceToldItIsOver(itsDisplayThen, toldOfItThen, theirs.url, 45_000)
  check(
    'and the browser tells the backend itself, so the page that was open stops all the same',
    afterSilent.told && afterSilent.gives === '401,401',
    JSON.stringify(afterSilent),
  )
  mend()
  await leavingTab.close()
  await it(B, ['delete', sslug])

  // ------------------------------------------------------------------
  section('Taking data away, and forgetting a display')
  await pairAsOwner(page)
  nowPairedOrClosed(one)
  await it(B, ['create', marked('Second page'), '--id', `${slug}-b`, '--html', '<p>b</p>', '--state', `{"k":"${PRIVATE_MARK}v"}`])
  await page.goto(`${APP}/settings`)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByRole('button', { name: 'Download my data' }).click()])
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'))
  check(
    'an export holds the pages with their state, the machines, the revoked one among them, and the displays, and says it is complete',
    exported.complete === true &&
      exported.pages.some((p) => p.slug === `${slug}-b` && p.state.k === `${PRIVATE_MARK}v`) &&
      exported.pages.some((p) => p.slug === slug && p.state.status === DEPLOYING) &&
      exported.machines.some((m) => m.name === BOX && m.revoked === true) &&
      exported.machines.some((m) => m.name === OTHER && m.revoked === false) &&
      exported.displays.some((d) => d.name === WALL),
    JSON.stringify(exported).slice(0, 300),
  )
  const before = (await it(A, ['displays'])).length
  page.once('dialog', (d) => d.accept())
  await page.goto(`${APP}/displays`)
  const forgetsItself = nowNotPaired(one, 'the owner’s browser forgot the display it is', { asks: 4 })
  await page.locator('.row', { hasText: 'This display' }).getByRole('button', { name: 'Forget' }).click()
  check('a display that is forgotten is signed out', await until(() => page.locator('.door').isVisible(), 20_000))
  // The browser has found out that it is not paired, and has done what it does about that:
  // had it been going to make itself a display again, it would have by now
  const foundOutItWasForgotten = await forgetsItself.foundOut()
  check(
    'and is not one of the displays any more, nor comes back by itself',
    foundOutItWasForgotten && (await it(A, ['displays'])).length === before - 1,
    `the browser found out: ${foundOutItWasForgotten}`,
  )
  await pairAsOwner(page)
  nowPairedOrClosed(one)
  check(
    'paired again, the browser that was forgotten is a display anew, with no name',
    await until(async () => {
      const all = await it(A, ['displays'])
      return all.length === before && !all.some((d) => d.name === WALL) && all.some((d) => !d.named)
    }),
    JSON.stringify(await it(A, ['displays'])),
  )
  await it(B, ['delete', `${slug}-b`])

  // ------------------------------------------------------------------
  section('Limits')
  // Far more than a machine may ask in one go: some of it is done, and the rest is refused by name
  const flood = await Promise.all(Array.from({ length: 24 }, () => refused(it(B, ['notify', `again and again ${PRIVATE_MARK}note`]))))
  check(
    'a machine that asks too fast is told to slow down, by name, and what it asked within the limit is done',
    flood.includes('rate_limited') && flood.includes('ok') && flood.every((x) => x === 'ok' || x === 'rate_limited' || x === 'unavailable'),
    JSON.stringify(flood),
  )

  // ------------------------------------------------------------------
  section('Stopping and starting again')
  // The stack is asked to stop its service and start it on the same folder, as a machine that
  // is turned off and on again does. The service that answers afterwards is another program.
  await page.goto(`${APP}/`)
  await awaited('the owner’s browser was not shown its pages', () => page.locator(`a.cover[href="/p/${slug}"]`).isVisible(), 20_000)
  const serviceBefore = stack()?.service
  // What the backend program has kept of what happened is in its memory, and is read before it
  // stops: down to the last thing the run made happen, which is the limit that was just reached
  await until(
    async () => {
      await readBackend()
      return backendSaid.some((e) => e.event === 'limit.reached' && e.rule === 'notify')
    },
    15_000,
    500,
  )
  // While the service is stopped there is nothing for the owner's browser to connect to
  const serviceMoved = during(one, closedUnder(APP, pages, 'the service was stopped and started under an open site'))
  process.kill(STACK.pid, 'SIGUSR2')
  const startedAgain = await until(
    async () => {
      const now = stack()?.service
      return (
        now &&
        now !== serviceBefore &&
        (await plain(`${STACK.http}/health`).then(
          (r) => r.status === 200,
          () => false,
        )) &&
        (await plain(`${APP}/`).then(
          (r) => r.status === 200,
          () => false,
        ))
      )
    },
    120_000,
    500,
  )
  // The stack notes what did not stop when it was asked to: a service it had to make stop is not one that stopped
  check(
    'the service stops when asked and starts again on the same folder',
    Boolean(startedAgain) && !stack()?.forced?.length,
    `the service was ${serviceBefore} and is ${stack()?.service}${stack()?.forced?.length ? `; ${stack().forced.join('; ')}` : ''}`,
  )
  const kept = {
    pages: (await until(() => it(A, ['list']), 30_000, 1000))?.map((p) => p.id) ?? [],
    first: await it(A, ['whoami']).then(
      (m) => m.id,
      (e) => e.code,
    ),
    second: await it(B, ['whoami']).then(
      (m) => m.id,
      (e) => e.code,
    ),
    state: await it(A, ['state', slug]).then(
      (s) => s.state.status,
      (e) => e.code,
    ),
  }
  check(
    'it keeps the pages and their state, the machine it enrolled and the one that joined',
    kept.pages.includes(slug) && kept.pages.includes(cslug) && kept.first === a.id && kept.second === b.machine && kept.state === DEPLOYING,
    JSON.stringify(kept),
  )
  await page.goto(`${APP}/`)
  check(
    'and the paired browser, which is still the owner’s and still lists the pages, with nothing typed or opened again',
    (await until(() => page.locator(`a.cover[href="/p/${slug}"]`).isVisible(), 30_000)) && (await paired(page)) && (await sessionOf(page)).role === 'owner',
    (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200),
  )
  serviceMoved()
  const again2 = await shownIn(page)
  check('and a page is shown again', Boolean(again2.frame) && (await again2.frame.evaluate(() => fetch('app.js').then((r) => r.status))) === 200)

  // ------------------------------------------------------------------
  section('Deleting')
  await page.goto(`${APP}/`)
  // The front page draws each page it lists as a small live picture of it, which asks for that
  // page's files as any showing of it does. The pictures are let finish first: a page deleted
  // while its picture is loading is refused a file, and the browser says so by itself
  await until(async () => {
    const listed = await page.locator('a.cover').count()
    return listed > 0 && (await page.locator('a.cover iframe').count()) >= listed
  }, 15_000)
  await Promise.all(
    page
      .frames()
      .filter((f) => f !== page.mainFrame())
      .map((f) => f.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})),
  )
  await it(A, ['delete', slug])
  check('a deleted page is gone for its agent', (await refused(it(A, ['read', slug]))) === 'not_found')
  // A page whose machine was revoked is still the person's, and another of their machines can remove it
  await it(B, ['delete', cslug])
  check('and so is one whose own machine was revoked, removed from another of the person’s machines', (await refused(it(A, ['read', cslug]))) === 'not_found')
  // The token its key earned it a moment before it leaves, which has minutes left to run
  const asBThen = await machineToken(B)
  await it(B, ['logout'])
  check(
    'a machine that leaves keeps nothing and is nobody',
    !existsSync(path.join(B, 'machine.json')) &&
      !existsSync(path.join(B, 'token.json')) &&
      (await refused(it(B, ['list']))) === 'not_set_up' &&
      (await answerTo('query', 'artifacts:list', {}, asBThen)) === 'unauthenticated',
  )
  check(
    'and the machine It runs on has nothing to leave, and is told so',
    (await refused(it(A, ['logout']))) === 'invalid' && existsSync(path.join(A, 'machine.json')),
  )

  // ------------------------------------------------------------------
  section('Erasing everything')
  const eslug = `${slug}-e`
  await it(A, ['create', marked('Leaving'), '--id', eslug, '--dir', fixture])
  const besideIt = await one.context.newPage()
  const leaving = await shownIn(besideIt, eslug)
  // Two more browsers are paired. One has a click on its way when everything is erased: what
  // it sends of the click is kept back from the backend, and let go only once the browser has
  // let go of everything, so that the answer finds nothing left to answer.
  const underWay = began(await launch())
  const sentLate = []
  // The answer to each is noted as it passes back to the tab, by the number the tab gave what it sent
  const answeredLate = new Set()
  const saidOnTheWay = (message) => {
    try {
      return JSON.parse(String(message))
    } catch {
      return undefined
    }
  }
  await underWay.context.routeWebSocket(
    (url) => url.pathname.endsWith('/sync'),
    (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const asks = saidOnTheWay(message)
        if (asks?.type === 'Mutation' && asks.udfPath === 'actions:submit') sentLate.push({ server, message, request: asks.requestId })
        else server.send(message)
      })
      server.onMessage((message) => {
        const answers = saidOnTheWay(message)
        if (answers?.type === 'MutationResponse') answeredLate.add(answers.requestId)
        ws.send(message)
      })
    },
  )
  await pairAsOwner(underWay.page)
  await shownIn(underWay.page, eslug)
  await underWay.page.frameLocator('.mount iframe').locator('#approve').click()
  await awaited('the click that was to be on its way was not sent', () => sentLate.length > 0, 15_000, 50)
  // The other has shown a page and is closed: it hears nothing of the erasing until it is opened again
  const closedAllTheWhile = began(await launch())
  await pairAsOwner(closedAllTheWhile.page)
  await shownIn(closedAllTheWhile.page, eslug)
  await closedAllTheWhile.page.close()
  /**
   * What the site keeps in a tab, by the kind of thing each is, for every tab of the browser
   * and for this one alone; and how many sessions' cookies the browser holds. One thing stays
   * when everything else is let go of, for a day: the names of the sessions the browser held
   * that are over, with which it asks for their cookies to be cleared again. A name is no
   * secret and opens nothing. It is said apart from the rest, as what it is: a list of names
   * and times and nothing besides, each the name of a session this browser held.
   */
  const stillHolds = async (b, tab) => {
    const kept = await tab.evaluate(() => {
      const kinds = (store) =>
        [
          ...new Set(
            Object.keys(store)
              .filter((name) => name.startsWith('it.') && name !== 'it.cookies')
              .map((name) => name.split('.').slice(0, 2).join('.')),
          ),
        ].sort()
      let names = null
      try {
        const list = JSON.parse(localStorage.getItem('it.cookies') ?? '[]')
        const onlyNamesAndTimes =
          Array.isArray(list) && list.every((one) => one && Object.keys(one).sort().join() === 'at,id' && typeof one.id === 'string' && Number.isFinite(one.at))
        names = onlyNamesAndTimes ? list.map((one) => one.id) : null
      } catch {}
      return { forEveryTab: kinds(localStorage), forThisTab: kinds(sessionStorage), names }
    })
    await Promise.allSettled(b.exchanges.map((x) => x.read))
    const held = namingsOf(b).held
    return {
      forEveryTab: kept.forEveryTab,
      forThisTab: kept.forThisTab,
      ofSessionsOver:
        kept.names === null
          ? 'something that is no list of names and times'
          : kept.names.length === 0
            ? 'no names'
            : kept.names.every((name) => held.includes(cookieOf(name)))
              ? 'names of sessions it held, with when each was over'
              : 'a name of no session it held',
      cookies: (await b.context.cookies()).filter((cookie) => cookie.name.startsWith('it_session_')).length,
    }
  }
  const NOTHING = JSON.stringify({ forEveryTab: [], forThisTab: [], ofSessionsOver: 'names of sessions it held, with when each was over', cookies: 0 })
  /** What a tab and its browser hold in the end: only those names, or what they still held when twenty seconds were over. */
  const holdsAtLast = async (b, tab) => {
    let last
    await until(
      async () => {
        last = JSON.stringify(await stillHolds(b, tab))
        return last === NOTHING
      },
      20_000,
      250,
    )
    return last === NOTHING ? 'only those names' : last
  }
  // Beside the database lie three folders that are not It's to remove, and one that is. A copy
  // of the database from before an update is a folder It names in a way of its own, with a note
  // inside that says it is the copy of that name, and an update is what makes one. Here one is
  // made up, as It makes them. The others are a person's own: one under a name that only begins
  // as a copy's does, and one named exactly as a copy is that does not say it is one.
  const besideTheDatabase = (name, ...more) => path.join(A, 'backend', name, ...more)
  const [aPersonsOwn, namedAsACopyIs, madeUpAsACopy] = ['before-family-notes', 'before-functions-0123456789ab', 'before-functions-ba9876543210']
  for (const name of [aPersonsOwn, namedAsACopyIs, madeUpAsACopy]) {
    // Put there afresh: the stack may have served a run before this one, which may have ended before it took its own away
    rmSync(besideTheDatabase(name), { recursive: true, force: true })
    mkdirSync(besideTheDatabase(name), { mode: 0o700 })
    writeFileSync(besideTheDatabase(name, 'notes.txt'), 'kept here by a person', { mode: 0o600 })
  }
  writeFileSync(
    besideTheDatabase(madeUpAsACopy, 'copy.json'),
    JSON.stringify({ copy: madeUpAsACopy, id: randomBytes(8).toString('hex'), made: Date.now(), order: 1, it: '0.0.0' }),
    { mode: 0o600 },
  )
  const displayAtTheLast = await displayOf(page)
  const toldOfItAtTheLast = toldItIsOver(displayAtTheLast)
  await page.goto(`${APP}/settings`)
  await page.getByRole('button', { name: 'Erase…' }).click()
  await page.getByLabel('Type erase everything to confirm').fill('erase everything')
  // Every browser that was paired learns that it is not: each tab that is open asks, and names
  // the session it held; the one that is closed does when it is opened again; and the run asks
  // each, as the site does, what it still holds
  nowNotPaired(one, 'everything was erased from the owner’s browser, which had two tabs open', { asks: 16 })
  nowNotPaired(underWay, 'everything was erased while a browser had a click on its way', { asks: 6 })
  nowNotPaired(closedAllTheWhile, 'everything was erased while a browser was closed, and it was opened again', { asks: 4 })
  await page.getByRole('button', { name: 'Erase everything' }).click()
  check('erasing everything signs its browser out', await until(() => page.locator('.door').isVisible(), 40_000))
  let toldAfter
  check(
    'the machine is nobody from that moment',
    await until(async () => {
      toldAfter = await refused(it(A, ['list']))
      return toldAfter === 'unauthenticated'
    }, 20_000),
    toldAfter,
  )
  const afterErasing = await onceToldItIsOver(displayAtTheLast, toldOfItAtTheLast, leaving.url, 30_000)
  check('and a page that was open is not served any more', afterErasing.told && afterErasing.gives === '401,401', JSON.stringify(afterErasing))
  // Every browser that was paired lets go of what the site kept in it, and of its session's cookie
  const letsGo = { whereItWasAsked: await holdsAtLast(one, page), inItsOtherTab: await holdsAtLast(one, besideIt) }
  await until(() => underWay.page.locator('.door').isVisible(), 30_000)
  letsGo.withAClickOnItsWay = await holdsAtLast(underWay, underWay.page)
  // Now what it had sent of the click reaches the backend, which refuses it: the click is nobody's any more
  const letGoLate = sentLate.splice(0)
  for (const { server, message } of letGoLate) {
    try {
      server.send(message)
    } catch {}
  }
  // The answer passes back to the tab, and the tab is looked at once it has: had the click been
  // going to be written back, it would be there
  letsGo.itsAnswerCame = Boolean(await until(() => letGoLate.length > 0 && letGoLate.every((sent) => answeredLate.has(sent.request)), 20_000, 50))
  letsGo.onceItsAnswerCame = JSON.stringify(await stillHolds(underWay, underWay.page))
  await underWay.page.reload()
  await until(() => underWay.page.locator('.door').isVisible(), 20_000)
  letsGo.loadedAfresh = JSON.stringify(await stillHolds(underWay, underWay.page))
  const openedAgain = await closedAllTheWhile.context.newPage()
  await openedAgain.goto(APP)
  await until(() => openedAgain.locator('.door').isVisible(), 20_000)
  letsGo.closedAllTheWhile = await holdsAtLast(closedAllTheWhile, openedAgain)
  check(
    'and every browser that was paired lets go of all that the site kept in it and of its session’s cookie, but for the names of the sessions it held, which it keeps a day more: the one that asked, in each of its tabs; one that had a click on its way, which is not written back when its answer comes late; and one that was closed all the while, once it is opened again',
    JSON.stringify(letsGo) ===
      JSON.stringify({
        whereItWasAsked: 'only those names',
        inItsOtherTab: 'only those names',
        withAClickOnItsWay: 'only those names',
        itsAnswerCame: true,
        onceItsAnswerCame: NOTHING,
        loadedAfresh: NOTHING,
        closedAllTheWhile: 'only those names',
      }),
    JSON.stringify(letsGo),
  )
  await besideIt.close()
  await underWay.context.close().catch(() => {})
  await closedAllTheWhile.context.close().catch(() => {})
  for (const closed of [underWay, closedAllTheWhile]) nowPairedOrClosed(closed)
  // The person sets It up again on the machine, which enrols it anew once what was held is gone
  const erased = await until(() => backendSaid.some((e) => e.event === 'account.deleted'), 90_000, 500)
  // The copy of the database goes with the erasing, since it holds what was erased, and the service says how many went
  const SAID_OF_COPIES = /backend: everything was erased, and the copies of the database from before an update went with it \((\d+)\)/
  const copiesWent = await until(
    () => !existsSync(besideTheDatabase(madeUpAsACopy)) && SAID_OF_COPIES.exec(readFileSync(serviceLog).subarray(begun).toString('utf8'))?.[1],
    30_000,
    250,
  )
  const stayed = [aPersonsOwn, namedAsACopyIs].filter(
    (name) => existsSync(besideTheDatabase(name, 'notes.txt')) && readFileSync(besideTheDatabase(name, 'notes.txt'), 'utf8') === 'kept here by a person',
  )
  check(
    'with everything erased the service removes the copy of the database it kept from before an update, which here is a folder made up as one, and says that one went; and it removes nothing else that lies beside the database: a folder a person put there under such a name, and one named exactly as a copy is that does not say it is one, stay with what is in them',
    copiesWent === '1' && stayed.length === 2,
    `the copy went, and how many the service said: ${copiesWent ?? `no, and ${existsSync(besideTheDatabase(madeUpAsACopy)) ? 'it is still there' : 'nothing was said'}`}; stayed: ${stayed.join(', ') || 'neither'}`,
  )
  // What the run put there it takes away again, so that the stack is left as a person's folder is
  for (const name of [aPersonsOwn, namedAsACopyIs, madeUpAsACopy]) rmSync(besideTheDatabase(name), { recursive: true, force: true })
  let setUpAgain
  const enrolledAgain = await until(
    () =>
      it(A, ['setup', '--none', '--no-service']).then(
        () => true,
        (e) => {
          setUpAgain = e.message
          return false
        },
      ),
    60_000,
    15_000,
  )
  const anew = await it(A, ['whoami']).catch((e) => ({ failed: e.code }))
  check(
    'setting It up again enrols the machine anew, under the name it had',
    erased && enrolledAgain && anew.name === STACK_MACHINE && anew.id !== a.id,
    `erased: ${Boolean(erased)}; set up again: ${enrolledAgain ?? setUpAgain}; ${JSON.stringify(anew)}`,
  )
  if (!QUICK)
    check(
      'and its connector is the newly enrolled machine’s, within the minute or so in which a connector looks again',
      await until(async () => Boolean((await it(A, ['whoami'])).connectorVersion), 100_000, 3000),
    )
  else console.log('  skip  the connector of the machine that was enrolled anew: the quick run does not wait for a connector to look again')
  const three = began(await open('owner'))
  check(
    'and a browser paired after that finds nothing left of what was there',
    (await until(
      async () => (await three.page.getByText('What should I make?').isVisible()) && (await three.page.locator('a.cover').count()) === 0,
      60_000,
      1000,
    )) &&
      (await it(A, ['list'])).length === 0 &&
      (await it(A, ['displays'])).length === 1,
    (await three.page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200),
  )
  // Ending every other browser never ends the one that asks. That browser adds a machine, and
  // the browser everything was erased from is paired again with a code that machine asks for,
  // so that it comes from a machine the other browser added. It then ends all others: the
  // other browser goes, and the machine it added with it, and the one that asked stays paired
  // though it came from that machine.
  const X3 = home('x3')
  const itsInvite = await codeFrom(await sessionOf(three.page), 'a machine')
  const addedByTheOther = await join(X3, marked('e2e let in x3'), { invite: async () => itsInvite }).catch((e) => ({ failed: e.code ?? e.message }))
  noteHome(X3, noteWhenSeen)
  await page.goto(await ownerAddress({ home: X3 }))
  await awaited('the browser was not paired by an address that the added machine asked for', () => paired(page), 20_000)
  nowPairedOrClosed(one)
  await page.goto(`${APP}/displays`)
  const endAllOthers = page.getByRole('button', { name: 'End all others' })
  await awaited('the Displays page did not offer to end all other browsers', () => endAllOthers.isEnabled(), 20_000)
  let saidBeforeEndingAll = ''
  page.once('dialog', (d) => {
    saidBeforeEndingAll = d.message()
    void d.accept()
  })
  // The other browser learns that its pairing has ended, and the run asks as the site does until it has
  nowNotPaired(three, 'a browser was ended by another that ended all others', { asks: 6 })
  await endAllOthers.click()
  const endedAllOthers = {
    theOtherBrowser: await until(async () => ((await sessionOf(three.page)).status === 401 ? 401 : undefined), 20_000),
    theMachineItAdded: await until(async () => {
      const told = await refused(it(X3, ['whoami']))
      return told === 'unauthenticated' ? told : undefined
    }, 25_000),
  }
  // The other browser and its machine are ended, so whatever was going to be ended with them
  // has been. The one that asked is then the only browser that is paired, by the backend's own list.
  const itself = await sessionOf(page)
  endedAllOthers.theOneThatAsked = `${itself.status} ${itself.role}`
  endedAllOthers.stillShowsTheSite = await paired(page)
  endedAllOthers.pairedNow = (await pairedNow()).map((row) => (row.id === itself.session ? 'the one that asked' : 'another')).join()
  check(
    'a browser that ends every other stays paired itself, though it came from a machine that one of the others had added: the site says so before it is confirmed, the other browser and that machine are ended, and the one that asked goes on as the owner’s',
    typeof addedByTheOther.machine === 'string' &&
      /^End all others\? .* This browser came from one of them, and stays paired\.$/.test(saidBeforeEndingAll) &&
      JSON.stringify(endedAllOthers) ===
        JSON.stringify({
          theOtherBrowser: 401,
          theMachineItAdded: 'unauthenticated',
          theOneThatAsked: '200 owner',
          stillShowsTheSite: true,
          pairedNow: 'the one that asked',
        }),
    JSON.stringify({ added: addedByTheOther.machine ? 'a machine' : addedByTheOther, said: saidBeforeEndingAll.slice(0, 320), ...endedAllOthers }),
  )
  await it(X3, ['logout', '--force']).catch(() => {})
  // That browser has served, and is closed: nothing more is foreseen of it
  await three.context.close().catch(() => {})
  nowPairedOrClosed(three)

  // ------------------------------------------------------------------
  section('Setting It up')
  // Another It, in a folder of its own and on ports of its own beside the stack's. Setting it
  // up starts the backend program for as long as the setup takes: nothing else of It runs there.
  if (process.platform === 'win32')
    console.log('  skip  a setup that is ended half way, and two at once: the run ends a setup with a signal, and tells a backend program by what `ps` shows')
  else {
    const S2 = home('set-up')
    const itsPort = STACK.port + 50
    // The backend program is the one this run was told to use, or else the one the stack fetched: none is fetched for this
    const fetched = path.join(A, 'backend', 'bin')
    const itsProgram =
      process.env.IT_BACKEND_BIN ??
      (existsSync(fetched) ? readdirSync(fetched).map((release) => path.join(fetched, release, 'convex-local-backend')) : []).find((file) => existsSync(file))
    if (!itsProgram) throw new Error('no backend program was found to set another It up with: neither IT_BACKEND_BIN names one nor has the stack fetched one')
    const there = { IT_PORT: String(itsPort), IT_BACKEND_BIN: itsProgram }
    /** Whether something answers at a port of this machine as It does when it is asked how it is. */
    const answersAt = (port) =>
      plain(`http://127.0.0.1:${port}/health`).then(
        (r) => r.status === 200,
        () => false,
      )
    /** How often a stand-in for an agent app has been asked which version it is: a setup asks once it has enrolled its machine. */
    const askedTheApps = () => appCalls().filter((call) => call.args[0] === '--version').length
    const setUps = []
    /**
     * Starts a setup there. It is kept at the step where it asks the agent apps how they are,
     * for as long as the file it is given is there. Gives the program, what it has said so
     * far, and how it ended once it has.
     */
    const setUp = (keptBy) => {
      writeFileSync(keptBy, '')
      const one_ = { said: '' }
      one_.ended = it(S2, ['setup', '--none', '--no-service', '--name', marked('e2e set up beside')], {
        raw: true,
        extraEnv: { ...there, E2E_APPS_HOLD: keptBy },
        onStart: (program) => {
          one_.program = program
        },
        onStderr: (text) => {
          one_.said += text
        },
      })
      setUps.push(one_)
      return one_
    }
    const [keepsTheFirst, keepsTheSecond] = [path.join(tmp, 'keeps-a-setup'), path.join(tmp, 'keeps-another-setup')]
    /** Every backend program that was seen running on that folder, by its number. */
    const seenRunning = new Set()
    const runningThere = () => {
      const program = backendLeftOn(S2)
      if (program !== undefined) seenRunning.add(program)
      return program
    }
    try {
      // A setup is ended while it is at work: it has enrolled its machine, and is asking the agent apps
      let asked = askedTheApps()
      const cutShort = setUp(keepsTheFirst)
      await awaited(
        'the setup that was to be ended half way did not get as far as asking the agent apps',
        () => askedTheApps() > asked && existsSync(path.join(S2, 'machine.json')) && runningThere() !== undefined,
        90_000,
        50,
      )
      noteHome(S2, noteWhenSeen)
      const enrolledAs = JSON.parse(readFileSync(path.join(S2, 'machine.json'), 'utf8')).id
      const left = runningThere()
      cutShort.program.kill('SIGTERM')
      await cutShort.ended
      rmSync(keepsTheFirst, { force: true })
      const halfWay = {
        itsBackendProgramAnswers: await answersAt(itsPort + 41),
        itsDoorAnswers: await answersAt(itsPort),
        status: await it(S2, ['status'], { extraEnv: there }).then(
          (said) => ({ running: said.running, saysOnlyTheBackendIs: /only its backend program is/.test(said.hint ?? '') }),
          (e) => ({ failed: e.code ?? e.message }),
        ),
        site: await refused(it(S2, ['site', '--no-open'], { extraEnv: there })),
      }
      check(
        'a setup that is ended while it is at work leaves its backend program running, and It is not said to be running for that: `it status` says that only the backend program is, and `it site` gives no address for a site that is not there',
        JSON.stringify(halfWay) ===
          JSON.stringify({ itsBackendProgramAnswers: true, itsDoorAnswers: false, status: { running: false, saysOnlyTheBackendIs: true }, site: 'offline' }),
        JSON.stringify(halfWay),
      )
      // Two setups at once. The first stops the program that was left, starts one of its own
      // and is kept asking the agent apps; the second is started beside it.
      asked = askedTheApps()
      const first = setUp(keepsTheFirst)
      const firstAtWork = Boolean(await until(() => askedTheApps() > asked && runningThere() !== undefined && runningThere() !== left, 90_000, 50))
      const second = setUp(keepsTheSecond)
      const secondWaited = Boolean(
        await until(
          () => second.said.includes('Another `it setup` or `it login` is at work in this folder. This one goes on when that one has finished.'),
          15_000,
          50,
        ),
      )
      rmSync(keepsTheFirst, { force: true })
      const firstEnded = await first.ended
      rmSync(keepsTheSecond, { force: true })
      const secondEnded = await second.ended
      const bothAtOnce = {
        theFirstGotToWork: firstAtWork,
        stoppedWhatWasLeft:
          first.said.includes('A backend program that an earlier `it setup` had left running on this machine was stopped.') && !isBackendOn(S2, left),
        theSecondWaited: secondWaited,
        ended: [firstEnded.code, secondEnded.code].join(),
        enrolledOnce: JSON.parse(readFileSync(path.join(S2, 'machine.json'), 'utf8')).id === enrolledAs,
        aBackendProgramAnswers: await answersAt(itsPort + 41),
        leftRunning: [...seenRunning].filter((program) => isBackendOn(S2, program)).length + (runningThere() === undefined ? 0 : 1),
      }
      check(
        'the next setup stops the backend program that was left, and says so; a second setup started beside it waits until the first is done, and says so; both end well, with the machine enrolled once; and no backend program is left running',
        JSON.stringify(bothAtOnce) ===
          JSON.stringify({
            theFirstGotToWork: true,
            stoppedWhatWasLeft: true,
            theSecondWaited: true,
            ended: '0,0',
            enrolledOnce: true,
            aBackendProgramAnswers: false,
            leftRunning: 0,
          }),
        `${JSON.stringify(bothAtOnce)}; the second said: ${second.said.replace(/\s+/g, ' ').slice(-300)}`,
      )
      // It is set up there and not running. Another program now answers at the port its site
      // would be at: first with plain words, then with word that all is well, which many a
      // program gives and which does not say that it is It. Neither is taken for It, and the
      // person is told what is in the way.
      const ANOTHER = `It is not running on this machine: another program answers at port ${itsPort}, where It’s site would be.`
      const saidOfIt = async () => {
        const [status, service] = [await it(S2, ['status'], { extraEnv: there }), await it(S2, ['service', 'status'], { extraEnv: there })]
        return `${status.running}, ${service.running}, ${(status.hint ?? '').includes(ANOTHER) ? 'another program is in the way' : (status.hint ?? '').startsWith('It is not running on this machine.') ? 'not running' : 'something else'}${/\bIT_PORT\b/.test(status.hint ?? '') ? ', with the way round it' : ''}`
      }
      const withAnother = {}
      for (const [answering, answer] of [
        ['plain words', (res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')],
        ['that all is well, and not that it is It', (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')],
      ]) {
        const another = http.createServer((_req, res) => answer(res))
        await new Promise((resolve) => another.listen(itsPort, '127.0.0.1', resolve))
        try {
          withAnother[answering] = await saidOfIt()
        } finally {
          another.closeAllConnections()
          await new Promise((resolve) => another.close(resolve))
        }
      }
      withAnother['nothing there'] = await saidOfIt()
      check(
        'where another program answers at the port It’s site would be, `it status` and `it service status` do not take it for It, whatever it answers short of saying that it is It, and `it status` says that another program is there and what to do about it; with nothing there it says only that It is not running',
        JSON.stringify(withAnother) ===
          JSON.stringify({
            'plain words': 'false, false, another program is in the way, with the way round it',
            'that all is well, and not that it is It': 'false, false, another program is in the way, with the way round it',
            'nothing there': 'false, false, not running',
          }),
        JSON.stringify(withAnother),
      )
    } finally {
      // Whatever became of the checks: no setup is left at work, and no backend program on that folder
      for (const kept of [keepsTheFirst, keepsTheSecond]) rmSync(kept, { force: true })
      for (const each of setUps) if (each.program && each.program.exitCode === null && each.program.signalCode === null) each.program.kill('SIGTERM')
      await Promise.all(setUps.map((each) => each.ended.catch(() => {})))
      runningThere()
      for (const program of seenRunning) {
        if (!isBackendOn(S2, program)) continue
        // Asked to stop as the service asks it, and made to when it has not within twenty seconds
        process.kill(program, 'SIGINT')
        if (!(await until(() => !isBackendOn(S2, program), 20_000, 100)) && isBackendOn(S2, program)) process.kill(program, 'SIGKILL')
      }
    }
  }

  // ------------------------------------------------------------------
  section('Usage reporting')
  const LINE = /It reports usage counts under a random id for this installation/
  const U = home('u')
  // Nobody is watching these commands: they are not run at a terminal
  const unwatched = await it(U, ['list'], { raw: true })
  await it(U, ['list'], { raw: true })
  check(
    'a command nobody is watching says nothing about usage reporting, and counts nothing',
    !LINE.test(unwatched.err) && !existsSync(path.join(U, 'usage.jsonl')) && !existsSync(path.join(U, 'telemetry.json')),
    unwatched.err.slice(0, 300),
  )
  const on = await it(U, ['telemetry'])
  const off = await it(U, ['telemetry', 'off'])
  const told = () => JSON.parse(readFileSync(path.join(U, 'telemetry.json'), 'utf8'))
  // Off is a file of its own, holding one word that says what turned reporting off
  const offBy = () => (existsSync(path.join(U, 'telemetry-off')) ? readFileSync(path.join(U, 'telemetry-off'), 'utf8').trim() : null)
  check(
    'it is on until it is turned off, and turning it off is kept in a file of its own and forgets the installation’s id',
    on.enabled === true &&
      on.because === 'the default' &&
      off.enabled === false &&
      off.because === 'it telemetry off' &&
      offBy() === 'command' &&
      !told().installation,
    JSON.stringify({ on, off, offBy: offBy(), kept: told() }),
  )
  // Whoever turned it off has plainly been told, and is not told again on turning it back on.
  // Someone whose first command turns it on has not been, and is
  const backOn = await it(U, ['telemetry', 'on'], { raw: true })
  const first = told().installation
  const onAgain = offBy()
  const neverTold = await it(home('n'), ['telemetry', 'on'], { raw: true })
  // A command run where the variable is set: it is the background service that sends, and it never sees this
  const withVariable = await it(U, ['telemetry'], { extraEnv: { IT_TELEMETRY_ENABLED: 'false' } })
  const withoutIt = await it(U, ['telemetry'])
  // And turning it on where the variable is still set changes nothing, and says why not
  const onUnderIt = await refused(it(U, ['telemetry', 'on'], { extraEnv: { IT_TELEMETRY_ENABLED: 'false' } }))
  check(
    'turned on by someone who was never told, it says the line, and says it once; and a variable that turns it off is written down for the service, which stays off without it, and is not turned on over it',
    LINE.test(neverTold.err) &&
      !LINE.test(backOn.err) &&
      /^[0-9a-f-]{36}$/.test(first) &&
      onAgain === null &&
      withVariable.enabled === false &&
      withVariable.because === 'IT_TELEMETRY_ENABLED' &&
      withoutIt.enabled === false &&
      withoutIt.because === 'IT_TELEMETRY_ENABLED' &&
      onUnderIt === 'refused' &&
      offBy() === 'IT_TELEMETRY_ENABLED' &&
      !told().installation,
    JSON.stringify({ said: neverTold.err.slice(0, 120), again: backOn.err.slice(0, 120), withVariable, withoutIt, onUnderIt, offBy: offBy(), kept: told() }),
  )
  const doNotTrack = await it(home('q'), ['telemetry'], { extraEnv: { DO_NOT_TRACK: '1' } })
  check('DO_NOT_TRACK=1 turns it off too', doNotTrack.enabled === false && doNotTrack.because === 'DO_NOT_TRACK', JSON.stringify(doNotTrack))
  const reported = () => usage.batches.flatMap((b) => b.events ?? [])
  const names = () => new Set(reported().map((e) => e.name))
  check(
    'the connector reports that it started, a page that was published and an answer that was delivered',
    await until(() => ['service.started', 'page.published', 'answer.delivered'].every((n) => names().has(n)), 45_000, 1000),
    JSON.stringify([...names()]),
  )
  const wrong = wrongWithUsage(usage)
  check(
    'every batch is exactly what the page about usage reporting says: a hash for the installation, and events of a name, an hour, an id of their own and properties from the fixed lists; and each is sent to the one address, with headers that say only that it is It',
    usage.batches.length > 0 && wrong.length === 0 && new Set(reported().map((e) => e.id)).size === reported().length,
    wrong.slice(0, 3).join('; '),
  )
  const allOfIt = JSON.stringify([usage.batches, usage.requests])
  check(
    'nothing the run named, titled or typed is in any of it, nor in how it was sent',
    ![PRIVATE_MARK, slug, session1].some((mine_) => allOfIt.includes(mine_)),
    JSON.stringify(usage.requests[0] ?? {}).slice(0, 300),
  )
  const pathsFor = (agent) =>
    reported()
      .filter((e) => e.name === 'answer.delivered' && e.properties.agent === agent)
      .map((e) => e.properties.path)
  const woken = reported()
    .filter((e) => e.name === 'agent.woken')
    .map((e) => `${e.properties.agent} ${e.properties.result}`)
  check(
    'an answer an add-on took in a conversation that was listening is counted as heard, and one Codex’s queue took as having woken it',
    pathsFor('claude-code').includes('heard') &&
      !pathsFor('claude-code').includes('woke') &&
      pathsFor('codex').includes('woke') &&
      woken.includes('codex resumed'),
    JSON.stringify({ claude: pathsFor('claude-code'), codex: pathsFor('codex'), woken }),
  )
  if (quietSince)
    check(
      'and a machine where reporting was turned off while its connector ran sent nothing more, and kept nothing to send later',
      quietSince.off &&
        quietSince.heardOfIt &&
        quietSince.after === quietSince.before &&
        !quietSince.keptByTheCommands &&
        quietSince.passedAgain &&
        !reported().some((e) => e.properties?.agent === QUIET_AGENT),
      JSON.stringify({ ...quietSince, reportedOfThatWhile: reported().filter((e) => e.properties?.agent === QUIET_AGENT).length }),
    )
  // Said, and not counted as a check that passed
  else console.log('  skip  turning reporting off on a machine whose connector is running: the quick run does not try it')

  if (!QUICK) {
    // A showing lasts ten minutes with nothing asked under it. The one whose tab was closed
    // early in the run has had most of that already, and the rest is waited out.
    await sleep(Math.max(0, leftAlone.since + 10 * 60_000 + 15_000 - Date.now()))
    const afterTenMinutes = await until(async () => ((await servedAt(leftAlone.url)) === '401,401' ? '401,401' : undefined), 90_000, 5000)
    check(
      'a showing that nothing has kept alive for ten minutes has ended by itself: its address gives nothing',
      afterTenMinutes === '401,401',
      await servedAt(leftAlone.url),
    )
  } else console.log('  skip  a showing that nothing keeps alive ending by itself: the quick run does not wait ten minutes')

  // ------------------------------------------------------------------
  section('What was written down')
  keep()
  // What the backend program keeps on the machine, the database above all, is the person's
  // alone. Who may open a file is what the system says of it, where the system says such things.
  if (process.platform !== 'win32') {
    const itsFolder = path.join(A, 'backend')
    const keptThere = ['.', ...readdirSync(itsFolder, { recursive: true })]
      .map((name) => ({ name: path.join('backend', name), entry: statSync(path.join(itsFolder, name), { throwIfNoEntry: false }) }))
      .filter(({ entry }) => entry)
    // Each one that is open to others is said by where it is under It's folder, which is no secret
    const openToOthers = keptThere
      .filter(({ entry }) => entry.mode & 0o077)
      .map(({ name, entry }) => `${name}, ${entry.isDirectory() ? 'a folder' : 'a file'} others may use (${(entry.mode & 0o777).toString(8)})`)
    // Where the stack stood in for the backend program's release, the program that runs is one It fetched, and is kept with the rest
    if (STACK.release)
      check(
        'the backend program was fetched when It was first set up, and is kept in It’s folder',
        keptThere.some(({ name, entry }) => entry.isFile() && /^backend[\\/]bin[\\/][^\\/]+[\\/]convex-local-backend(\.exe)?$/.test(name)),
        keptThere
          .map(({ name }) => name)
          .filter((name) => /^backend[\\/]bin\b/.test(name))
          .join(', '),
      )
    check(
      'what the backend program keeps on the machine is the person’s alone: nobody else may read, change or look into any file or folder of it',
      keptThere.filter(({ entry }) => entry.isFile()).length >= 2 && openToOthers.length === 0,
      `${keptThere.length} files and folders; ${openToOthers.length ? `${openToOthers.length} open to others: ${openToOthers.slice(0, 3).join('; ')}` : 'none open to others'}`,
    )
  }
  const said = children.map((c) => c.log).join('\n')
  check(
    'the connector wrote down when it started, which conversation was listening, by a shortened id, and that it stopped because its machine was revoked',
    /connector \d+\.\d+\.\d+ started \(pid \d+\)/.test(said) &&
      /a claude-code conversation is listening \([0-9a-f]{8}\)/.test(said) &&
      /connector listening on (its socket|127\.0\.0\.1:\d+)\n/.test(said) &&
      !said.includes(C) &&
      !said.includes(session1) &&
      (await until(
        () => /this machine is not one of It.s machines any more; stopping/.test(connectorAtTheEnd.log) && /Z stopped\n/.test(connectorAtTheEnd.log),
        70_000,
        1000,
      )),
    said.slice(-800),
  )
  const journal = (existsSync(path.join(C, 'journal.jsonl')) ? readFileSync(path.join(C, 'journal.jsonl'), 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const steps = journal.filter((e) => e.id === delivered?.clicks[0]?.id).map((e) => e.event)
  check('and its journal has each step of a hand-over, in order', steps.join(' ') === 'claimed served acked confirmed', JSON.stringify(steps))
  const wholeLog = existsSync(serviceLog) ? readFileSync(serviceLog, 'utf8') : ''
  check(
    'the service wrote down that it started, and that when it was asked to stop it stopped its connector, closed its door and stopped the backend program before it started again',
    (wholeLog.match(/ service started \(pid \d+\); the site is on port \d+\n/g) ?? []).length >= 2 &&
      / stopping \(SIGTERM\)\n[\s\S]* door closed\n[\s\S]* backend: stopped\n[\s\S]* service stopped\n[\s\S]* backend: started \(pid \d+\)\n[\s\S]* service started/.test(
        wholeLog.slice(begun),
      ),
    wholeLog.slice(-800),
  )
  check(
    'and the door, each kind of request it refused: one sent to another name, one from another origin, and one for a part of the backend it does not pass on',
    ['unknown_host', 'foreign_origin', 'api_path'].every((code) => wholeLog.includes(`door refused a request (${code})`)),
    (wholeLog.match(/door refused a request \([a-z_]+\)/g) ?? []).join(', '),
  )
  await readBackend()
  const wanted = [
    'invite.made',
    'session.begun',
    'session.ended',
    'code.refused',
    'code.kept',
    'machine.enrolled',
    'display.registered',
    'machine.revoked',
    'display.forgotten',
    'display.signed_out',
    'account.export',
    'limit.reached',
    'account.deletion_requested',
    'account.deleted',
  ]
  // By the ids of this run's own machines where a line carries one, so that it is this run's
  // enrolments and its revocation that are on record, and not some other's
  const machines = { other: b.machine, box: boxed.machine, 'first, enrolled anew': anew.id }
  const missing = () => {
    const have = new Set(backendSaid.map((e) => e.event))
    const enrolled = new Set(backendSaid.filter((e) => e.event === 'machine.enrolled').map((e) => e.machineId))
    return [
      ...wanted.filter((w) => !have.has(w)),
      ...Object.entries(machines).flatMap(([which, id]) => (enrolled.has(id) ? [] : [`the enrolment of the ${which} machine`])),
      ...(backendSaid.some((e) => e.event === 'machine.revoked' && e.machineId === boxed.machine && e.by === 'person')
        ? []
        : ['the revocation of the box machine']),
      ...(backendSaid.some((e) => e.event === 'machine.revoked' && e.machineId === b.machine && e.by === 'itself') ? [] : ['the leaving of the other machine']),
      ...(['owner', 'screen', 'machine'].every((role) => backendSaid.some((e) => e.event === 'invite.made' && e.role === role))
        ? []
        : ['an invite of each kind']),
      ...(['owner', 'screen'].every((role) => backendSaid.some((e) => e.event === 'session.begun' && e.role === role)) ? [] : ['a session of each kind']),
      ...(['itself', 'forgotten', 'paired_again', 'erased'].every((by) => backendSaid.some((e) => e.event === 'session.ended' && e.by === by))
        ? []
        : ['a session ended in each way']),
      ...(backendSaid.some((e) => e.event === 'code.refused' && e.reason === 'used') ? [] : ['a code refused because it was used']),
      ...(backendSaid.some((e) => e.event === 'code.kept' && e.reason === 'owner_here') ? [] : ['a screen’s code kept from the owner’s own browser']),
    ]
  }
  check(
    'the backend wrote down the enrolment of each machine that joined or was enrolled anew, the revocation of the one a person revoked and the leaving of the one that left, each invite, each session begun and ended and each code refused, and a display registered, forgotten and signed out, an export, a limit reached and the erasing of everything',
    await until(
      async () => {
        await readBackend()
        return missing().length === 0
      },
      30_000,
      1000,
    ),
    `missing: ${missing().join(', ')}`,
  )
  check(
    'the sign-out the browser had to present itself is on record as done that way',
    backendSaid.some((e) => e.event === 'display.signed_out' && e.by === 'token' && e.applied === true),
  )
  check(
    'since the run began the service wrote down a showing that opened, the ticket that was tried twice, a showing that was asked for after its display was signed out, and a sign-out it was told of',
    await until(
      () =>
        shown().some((e) => e.event === 'showing.opened') &&
        shown().some((e) => e.event === 'ticket.refused' && e.reason === 'already_used') &&
        shown().some((e) => e.event === 'showing.refused' && e.reason === 'signed_out') &&
        shown().some((e) => e.event === 'control.revoke'),
      15_000,
    ),
    JSON.stringify([...new Set(shown().map((e) => `${e.event}${e.reason ? ` (${e.reason})` : ''}`))]),
  )
  const held = await whatIsHeld()
  check(
    'and no log, nothing the backend kept and nothing the CLI printed holds a credential, a code that pairs a browser, a conversation’s id in full, a name or title a person chose, or what a page sent',
    held.read > 0 && held.found.length === 0,
    saidOf(held),
  )
  check(
    'and nothing a page or the site wrote to a browser’s console, or threw there, held a credential or the address a page is shown at',
    writtenToAConsole().length === 0,
    writtenToAConsole().join('; '),
  )
  check(
    'and every credential the run was given was noted where the check that is made again afterwards looks',
    couldNotNote().length === 0,
    couldNotNote().join(', '),
  )

  // What each browser reported, held against what the run foresaw of it where it provoked it:
  // the same browser, at that time, in those words, about that address. Anything else a browser
  // said by itself is an error of its own, and so is every error a script wrote or threw.
  // First what each browser named a session for, from everything it sent the site about its
  // session: each refusal of a naming that the site may make is one the browser may say
  await Promise.allSettled(opened.flatMap((b) => b.exchanges.map((x) => x.read)))
  const namedWrongly = opened.flatMap((b, i) => namingsOf(b).wrong.map((what) => `browser ${i + 1}: ${what}`))
  const namedAtAll = opened.reduce((sum, b) => sum + b.exchanges.filter((x) => x.path === '/session/end').length, 0)
  check(
    'a browser named a session to It only to end the one it held, where its pairing was ending, or to have the cookie of one that was over cleared again, and that no oftener than once each time a tab was answered about its token; and each naming was answered as it is: ended, nothing to end, or the browser holds another',
    namedAtAll > 0 && namedWrongly.length === 0,
    `${namedAtAll} namings; ${[...new Set(namedWrongly)].slice(0, 4).join('; ')}`,
  )
  const { own, neverSaid } = heldToAccount(opened)
  check('no browser reported an error of its own', opened.length >= 4 && own.length === 0, own.join(' | '))
  // And nothing is foreseen that does not happen: an excuse for what no browser said is one the
  // run does not need. The words are Chromium's, so it is asked where the run is made in that.
  if (/^chrom/.test(BROWSER))
    check(
      'and everything the run foresaw a browser saying by itself was said, so that nothing is excused that did not happen',
      neverSaid.length === 0,
      neverSaid.join('; '),
    )
  else console.log(`  skip  whether everything foreseen of a browser was said: what is foreseen is in Chromium’s words, and this run was made in ${BROWSER}`)
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  // Everything the run started is stopped first, and what each wrote down is put where it is
  // read back only then: what a connector says as it stops is part of what it wrote. Each is
  // asked to stop, made to when it has not, and waited for until nothing more can come from it.
  await Promise.all(children.map((c) => stopped(c)))
  allStopped = children.every((c) => c.exitCode !== null || c.signalCode !== null)
  for (const b of browsers) await b.close().catch(() => {})
  try {
    keep()
  } catch {
    keptAll = false
  }
  // The machines this run joined leave again, so that run after run does not fill the stack's
  // It with machines nobody uses
  for (const h of ['b', 'c', 'd'])
    await it(home(h), ['logout']).catch(() =>
      // One that It does not know any more cannot tell it, and need not
      it(home(h), ['logout', '--force']).catch(() => {}),
    )
}

await usage.close()
clearInterval(backendReader)
await readBackend()
clearInterval(noting)
for (const folder of [A, home('b'), home('c'), home('d')]) noteHome(folder, noteWhenSeen)
// Read once more, now that everything the run started has stopped and has said its last: what
// a connector wrote as it stopped, what the CLI printed as each machine left, and the last of
// what was reported as usage. The stack is not this run's to stop, so its log is read as it
// stands: `node e2e/logs.mjs` reads it whole once the stack has been stopped.
const atTheEnd = await whatIsHeld().catch(() => ({ read: 0, found: [] }))
check(
  'and with everything the run started stopped, all that it leaves behind was kept to be read, and holds none of that either',
  allStopped &&
    keptAll &&
    backendKept &&
    couldNotKeep() === 0 &&
    couldNotNote().length === 0 &&
    atTheEnd.read > 0 &&
    atTheEnd.found.length === 0 &&
    writtenToAConsole().length === 0,
  `stopped: ${allStopped}; kept: ${keptAll}; kept from the backend: ${backendKept}; not kept from the CLI: ${couldNotKeep()}; credentials not noted: ${couldNotNote().join(', ')}; read: ${atTheEnd.read}; ${[saidOf(atTheEnd), ...writtenToAConsole()].filter(Boolean).join('; ')}`,
)
// And what was reported as usage is checked again, whole, now that nothing more can be sent:
// what a connector reported as it stopped is held to what a batch may be as well
const wrongAtTheEnd = wrongWithUsage(usage)
const reportedInAll = usage.batches.flatMap((b) => b.events ?? [])
check(
  'and everything reported as usage, down to what a connector sent as it stopped, is what a batch may be and was sent as one may be sent, with no event there twice',
  wrongAtTheEnd.length === 0 && new Set(reportedInAll.map((e) => e.id)).size === reportedInAll.length,
  wrongAtTheEnd.slice(0, 3).join('; '),
)
// The connector that ran while reporting was off went on to report what it counted afterwards,
// and has stopped since: had it kept anything from that while, it would be among all this
if (quietSince)
  check(
    'and in all of it there is nothing that was counted while reporting was off',
    !reportedInAll.some((e) => e.properties?.agent === QUIET_AGENT),
    JSON.stringify(reportedInAll.filter((e) => e.properties?.agent === QUIET_AGENT).map((e) => [e.name, e.properties])),
  )
rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
if (failed.length) console.log(failed.map((f) => `  failed: ${f.name}`).join('\n'))
// Ended here, and not left to end by itself: nothing a run started may keep it from finishing
process.exit(failed.length ? 1 : 0)
