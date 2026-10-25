// The connector: one background program on each machine where agents run. It holds a live
// connection to It, hears about clicks on pages this machine's agents made, and gets each one
// into the conversation that owns the page, by the best route that harness offers:
//
//   1. the add-on inside that conversation, which asks this program for its clicks
//   2. the harness's own queue (Codex), which delivers when the conversation is next idle
//   3. otherwise the click waits, visibly, until something listens (`it wait`, or the site)
//
// A click is leased before anything is done with it, so a connector that dies mid-delivery
// loses nothing: the lease runs out and the click is offered again. Delivery is at least once.
// Every click carries its own id in the text the agent reads, so a repeat can be told apart.
import { execFile, spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ALIVE, briefClick, type Click, describeClick, LEASE_MS, LISTENING_MOST, MARK, newer, parseJson, QUEUES, WAKE_MOST, WAKES, wakesOn } from '@it/protocol'
import { AddonRuntimes } from './addon-runtime'
import {
  DeliveryRecovery,
  eraseDeliveryRecovery,
  type Given,
  MARK_AGAIN_MS,
  type MarkCopy,
  type MarkFallback,
  type Offered,
  RECEIPTS_MOST,
} from './delivery-recovery'
import {
  api,
  ask,
  backend,
  call,
  direct,
  elsewhere,
  enrolledHere,
  harnessEnv,
  home,
  inHome,
  live,
  Problem,
  readJson,
  shellLearned,
  shellMayHaveChanged,
  VERSION,
  why,
  writePrivate,
} from './lib'
import { incompatible } from './login'
import { profileEnvironment, readProfile } from './profiles'
import { conversationFolder, conversationProfile, noteConversation } from './publish'
import { alone } from './serve/backend'
import * as service from './service'
import { detectAll, type HarnessStatus, newerProgramSeen, reconcile } from './setup'
import { type T3, type T3Search, t3Send, t3Server, t3ThreadOf } from './t3'
import { fetchNewer, LOOKS_EVERY_MS, latest, watching as looksForNewer } from './upgrade'
import { agentOf, begin, record, startSender, thisMachine, thisProgram, three, timeBand } from './usage'
import {
  Budget,
  bootId,
  carrying,
  carryOn,
  claudeModeOf,
  claudeWroteAt,
  codexHeld,
  endTree,
  fromAnotherStart,
  identity,
  listsProcesses,
  mayWake,
  NO_PS,
  SINCE_TOLD,
  STOPPED,
  WAS_CUT_OFF,
  WAS_STOPPED,
  WOKEN,
} from './wake'

/** A click as an add-on receives it: its data as a value, the one wording agents read, and the few words a person is shown where an app has another place for the rest. */
export interface Delivered extends Click {
  text: string
  brief: string
  /** The receipt of the taking this machine holds it by, which the add-on says it has the click by. Given to an add-on that asks with receipts. */
  receipt?: string
}
/**
 * One taking of clicks to hand them over, known to It by its receipt. Every step of that
 * hand-over names the receipt: keeping the hold, giving the clicks back, setting them aside, and
 * saying they were handed over. It names no other taking, however late it comes.
 */
interface Attempt {
  receipt: string
}
/** A receipt for a taking about to be asked for: nobody else's, and nothing anyone could guess. */
const newAttempt = (): Attempt => ({ receipt: randomBytes(16).toString('base64url') })
interface Held {
  click: Offered
  /** The taking this machine holds it by. */
  attempt: Attempt
  /**
   * It was given to an add-on from before receipts, which says it has a click by its id alone.
   * Such an add-on is believed for a click it was given in this taking, for one release.
   */
  legacy?: boolean
  key: string
  claimedAt: number
  /** Until when the backend has confirmed this machine holds the click. Nothing is served past it. */
  leaseUntil: number
  /** Held for a running Codex turn's next hook, not for an add-on that is asking. */
  forHook: boolean
  /** An add-on has been given it and may be handing it to its agent this moment. */
  served: boolean
}
export interface ConnectorInfo {
  /** A socket only this user can open, where the system has them. */
  socket?: string
  port?: number
  token: string
  pid: number
  version: string
  startedAt: number
}

const LIVE_MS = 5_000 // an add-on that asked this recently is listening
const KNOWN_MS = 90_000 // and one that asked this recently is still worth watching clicks for
const HOLD_MS = 6_000 // how long a claimed click waits for an add-on that has stopped asking: one that is there asks every second
const RENEW_MS = 10_000 // how often the lease on a held click is extended
const FRESH_MS = 8_000 // a click this new, in a running Codex turn, is held for the turn's next hook
const HOOK_HOLD_MS = 60_000 // and this is how long it is held before Codex's queue gets it instead
const TURN_QUIET_MS = 30 * 60_000 // a turn that has run no hook for this long is taken to be over
const WAIT_MS = 5_000 // an `it wait` that said so this recently is still waiting
const WAIT_AGAIN_MS = 120_000 // how long after an `it wait` ended its conversation, where it is one never heard from, is taken to be coming to wait again
const QUEUE_WAITS = [0, 10_000, 60_000, 600_000] // how long before each try at a harness's own queue; after the last, the click is left waiting
const QUEUE_AT_ONCE = 3 // how many of a harness's queue commands run at the same time
const RUNS_AT_ONCE = 3 // and how many conversations are reopened and running at the same time
// How often one conversation is reopened: so many at once, then one more for each while that
// passes. What a page sent with nobody at it is held to much less, so that a page that sends by
// itself cannot keep an agent running. And all of a machine's conversations together.
const WAKE_RATE = { most: 10, everyMs: 20_000 }
const WAKE_RATE_UNATTENDED = { most: 3, everyMs: 5 * 60_000 }
const WAKE_RATE_MACHINE = { most: 30, everyMs: 10_000 }
/** How long Claude Code must have written nothing of a conversation that is not listening before it is taken to be closed and not at work in a window It cannot see into. */
const CLAUDE_QUIET_MS = 20_000
/**
 * How long a click for a conversation that is not listening waits before the conversation is
 * reopened: a moment, so that a few things done in quick succession go in the one message. No
 * longer than that. A conversation that is open asks for its clicks every second, and one that
 * has not asked for five is not listening, which is known the instant the click arrives: there
 * is nothing more to wait for.
 */
const SETTLE_MS = 300
const SERVE_MOST = 8 // how many clicks one answer to an add-on carries
const SERVE_BYTES = 200_000 // and how large that answer may be: an add-on reads no more than a quarter of a megabyte
const WAITER_BYTES = 700_000 // and how large the clicks in one answer to a waiter may be together: `it wait` reads no more than a megabyte
const keyOf = (harness: string, id: string) => `${harness}:${id}`
/** Everything an add-on or a command asks the connector for. */
const ROUTES = ['/health', '/addon', '/session', '/clicks', '/waiting', '/ack', '/runs']
/** What was asked for, as it may be written down: one of the connector's own routes, or one fixed word for anything else. */
const routeOf = (asked: string | undefined): string => {
  const route = (asked ?? '').split('?')[0]!
  return ROUTES.includes(route) ? route : 'unknown_route'
}
export const infoFile = () => inHome('connector.json')
const socketFile = () => inHome('connector.sock')
const journalFile = () => inHome('journal.jsonl')
const aliasFile = () => inHome('aliases.json')
/** The conversations whose hooks have been heard from, so that it is known across a restart where a hook of It's runs. */
const heardFile = () => inHome('heard.json')
/** Where a connector that is stopping writes down which conversations it cut off in the middle of a turn. */
const cutOffFile = () => inHome('cut-off.json')
/** The conversations this connector has reopened and that are running now, each with the process that is it: read by the connector that starts next, if this one dies. */
const runsFile = () => inHome('runs.json')
/** Where the conversations whose last reopened turn a person stopped are kept until each has been told so. */
const stoppedFile = () => inHome('stopped.json')
/** A word with the article it takes: "an opencode conversation", "a codex conversation". */
const a = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
const lockFile = () => inHome('connector.lock')

function journalWrite(event: string, id: string): void {
  try {
    // Cut down to its last records once it is large, into a file beside it that then takes its
    // place: cut down where it lies, a disk that filled in the middle left it with nothing
    if (existsSync(journalFile()) && statSync(journalFile()).size > 1_000_000) {
      const fewer = `${journalFile()}.${process.pid}.tmp`
      writeFileSync(fewer, `${readFileSync(journalFile(), 'utf8').split('\n').filter(Boolean).slice(-500).join('\n')}\n`, { mode: 0o600 })
      renameSync(fewer, journalFile())
    }
    // Begun on a line of its own, whatever the record before it ended with: one that was cut
    // short, by a crash or a full disk, would otherwise take this one with it
    appendFileSync(journalFile(), `\n${JSON.stringify({ t: Date.now(), event, id })}\n`, { mode: 0o600 })
  } catch {}
}
/** What the journal holds, in the order it was written. A line that cannot be read, as one cut short is, is passed over and says nothing of the lines after it. */
function journalled(): { event: string; id: string }[] {
  let text = ''
  try {
    text = readFileSync(journalFile(), 'utf8')
  } catch {}
  const out: { event: string; id: string }[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line) as { event?: unknown; id?: unknown } | null
      if (typeof e?.event === 'string' && typeof e.id === 'string') out.push({ event: e.event, id: e.id })
    } catch {}
  }
  return out
}
/** Clicks the journal says a harness's queue accepted, but which were never confirmed to It. */
function queuedButUnconfirmed(): Set<string> {
  const out = new Set<string>()
  for (const e of journalled()) {
    // "queueing" is only the intent. If nothing follows it, the command may never have run,
    // so the click is sent again: a repeat can be told apart by its id, a loss cannot be undone.
    if (e.event === 'queued') out.add(e.id)
    if (e.event === 'confirmed') out.delete(e.id)
  }
  return out
}

/**
 * Clicks the journal says this machine claimed, with nothing after to say what became of them.
 * A connector that ended in the middle left them leased, which is to say out of what It offers
 * until the lease runs out, while what was done after them is offered at once.
 */
function claimedAndLeft(): string[] {
  const out = new Set<string>()
  for (const e of journalled()) {
    if (e.event === 'claimed' || e.event === 'queueing' || e.event === 'served') out.add(e.id)
    else out.delete(e.id)
  }
  return [...out]
}

/**
 * The words that start Codex with no shell in between. Elsewhere that is just `codex`. On
 * Windows, Codex installed through npm is a .cmd file, which only a shell can start, and a
 * shell would read a page's title as part of the command. So the program behind the .cmd file
 * is started directly: Codex's own .exe when there is one, or Node with Codex's script.
 * Null when neither is found; the click then waits where the person can see it.
 */
export function codexCommand(platform: string, pathVar: string, exists: (file: string) => boolean): string[] | null {
  if (platform !== 'win32') return ['codex']
  const dirs = pathVar.split(';').filter(Boolean)
  const find = (name: string) => dirs.map((d) => path.win32.join(d, name)).find(exists)
  const exe = find('codex.exe')
  if (exe) return [exe]
  const cmd = find('codex.cmd')
  const node = find('node.exe')
  if (!cmd || !node) return null
  const script = path.win32.join(path.win32.dirname(cmd), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return exists(script) ? [node, script] : null
}

/**
 * Bytes as the text they are, or null when they are not UTF-8. Read loosely, a byte that is no
 * character becomes a mark that stands for any such byte: the text would then not be what was
 * sent, and a seal made over the text would hold for bytes it was never made over.
 */
function textOfBytes(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The way a click goes when no add-on is there to take it, of the three that start a turn for
 * it. The order is the point of this, and each is asked only where the one before said no:
 *
 * - `t3`: the conversation is held in a thread of T3 Code, which starts the turn and shows it.
 *   It comes before Codex's queue, because a message put in that queue starts its turn inside
 *   the very Codex that T3 Code holds for the thread, and T3 Code shows the turns it started
 *   itself: the agent did the work, the page changed, and the thread showed nothing.
 * - `queue`: some Codex has the conversation open, and takes a message from its own queue.
 * - `reopen`: the conversation is closed, and reopening is switched on for its agent app.
 *
 * Nothing where none of them holds: the click waits, and the site shows it.
 */
export function wayOf(of: { inT3: () => boolean; codexOpen: () => boolean; reopens: () => boolean }): 't3' | 'queue' | 'reopen' | undefined {
  if (of.inT3()) return 't3'
  if (of.codexOpen()) return 'queue'
  if (of.reopens()) return 'reopen'
  return undefined
}

/** Null when Codex took the message. Otherwise why it did not, for the log: never what Codex printed, which may repeat the message. */
export function codexQueue(thread: string, text: string, env: NodeJS.ProcessEnv = harnessEnv()): Promise<string | null> {
  // A thread id is letters, digits and dashes. Anything else is not one, and is never put on a command line.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(thread)) return Promise.resolve('its conversation id is not one Codex would have made')
  const codex = codexCommand(process.platform, env.PATH ?? env.Path ?? '', existsSync)
  if (!codex) return Promise.resolve('Codex was not found')
  // No shell, ever: the text holds a page's title and what a person typed into it
  return new Promise((resolve) => {
    try {
      execFile(codex[0]!, [...codex.slice(1), 'queue', `--thread=${thread}`, `--message=${text}`], { env, timeout: 30_000, windowsHide: true }, (err) => {
        if (!err) return resolve(null)
        const e = err as { code?: unknown; signal?: unknown; killed?: boolean }
        resolve(
          e.killed
            ? 'Codex did not answer in thirty seconds'
            : e.code === 'ENOENT'
              ? 'Codex was not found'
              : `Codex exited with ${e.signal ?? e.code ?? 'an error'}`,
        )
      })
    } catch {
      // Refused before it started: a message that cannot be an argument at all, which a title
      // with a character no command line can carry makes it. Said in words of this program's
      // own, since the error's words repeat the message, and counted like any other refusal.
      resolve('Codex could not be started with that message')
    }
  })
}

const asClick = (c: Offered): Click => ({
  id: c.id,
  artifact: c.artifact,
  title: c.title,
  name: c.name,
  payload: parseJson(c.payload) ?? null,
  at: c.at,
  ...(c.attended === null ? {} : { attended: c.attended }),
  ...(c.version === undefined ? {} : { version: c.version }),
  ...(c.stateRevision === undefined ? {} : { stateRevision: c.stateRevision }),
  ...(c.nowVersion === undefined ? {} : { nowVersion: c.nowVersion }),
  ...(c.nowStateRevision === undefined ? {} : { nowStateRevision: c.nowStateRevision }),
  ...(c.files?.length ? { files: c.files } : {}),
})
const asDelivered = (c: Offered): Delivered => ({ ...asClick(c), text: describeClick(asClick(c)), brief: briefClick(asClick(c)) })

/** Whether a connector is already answering for this folder. */
async function alreadyRunning(): Promise<number | null> {
  const existing = readJson<ConnectorInfo>(infoFile())
  if (!existing || existing.pid === process.pid) return null
  return (await local<{ ok: boolean }>('/health'))?.ok ? existing.pid : null
}

// A connector that cannot start says why as a Problem. Its code is one of a few fixed words, and
// is all that is written to the connector's log; its message is for the person who ran the
// command, and may name their folders.
const alreadyThere = (pid?: number) => new Problem(`A connector is already running for this folder${pid ? ` (pid ${pid})` : ''}.`, 'already_running')
/** Whom the lock names at this moment, where there is one that says. */
const lockHolder = (): number | undefined => {
  const pid = readJson<{ pid?: unknown }>(lockFile())?.pid
  return typeof pid === 'number' ? pid : undefined
}
/** Whether the lock is this program's at this moment. */
const holdsLock = () => lockHolder() === process.pid
/** What a connector stops with when the lock it took has come to be another's: it does nothing more as the folder's connector. */
const lockLost = () => new Problem('Another connector has taken this folder’s lock, so this one goes no further.', 'lock_lost')

/**
 * One connector for a folder, for as long as it runs. The lock is a file in It's folder, taken
 * as the backend's is, by the one exclusion there is for a lock that is free and for one that
 * was left behind: of however many programs come for it at the same moment, one has it.
 *
 * A lock is taken from its holder only when the holder is shown to be gone. One whose holder
 * lives is that holder's, however long it takes to begin answering, and a connector that finds
 * it so gives up and says that one is already running. And the lock is looked at again before
 * anything is done as the folder's connector that another could not undo: before it listens,
 * and before it writes down where it listens.
 */
export async function runConnector(say: (line: string) => void): Promise<void> {
  const other = await alreadyRunning()
  if (other) throw alreadyThere(other)
  const left = lockHolder()
  let mine = false
  try {
    await alone(
      'connector',
      () => {
        mine = true
        if (left !== undefined && left !== process.pid) say(`took over from a connector that is gone and left its lock behind (pid ${left})`)
        return connecting(say)
      },
      0,
    )
  } catch (err) {
    // Another has the lock, and lives
    if (!mine && err instanceof Problem && err.code === 'busy') throw alreadyThere(lockHolder())
    throw err
  }
}

/**
 * On a machine that joined an It: what is wrong where that It and this program speak different
 * versions of the way machines talk to It, as that It says at its door, or where that It does
 * not take the receipts this program hands clicks over by. Null where they fit, or where this
 * machine runs It itself. Undefined where the door could not be asked: that says nothing
 * either way, and whoever asked goes on as they were.
 */
async function unfit(): Promise<Problem | null | undefined> {
  if (!joined()) return null
  // Asked where everything else this machine says to that It goes: the address it joined at,
  // or the one it has been told to use since (IT_URL), where that It has moved
  let door: string
  try {
    door = backend().site
  } catch {
    return undefined
  }
  return direct(`${door}/cli/config`, { signal: AbortSignal.timeout(10_000) })
    .then(async (answer) => {
      if (!answer.ok) return undefined
      const said = (await answer.json()) as { protocol?: unknown; receipts?: unknown } | null
      return incompatible(said?.protocol) ?? (said?.receipts === true ? null : NO_RECEIPTS)
    })
    .catch(() => undefined)
}
/**
 * The It this machine joined is from before receipts: it would refuse every taking of a click
 * this program asks for, and the click would wait for nothing. Nothing is handed over until it
 * is brought up to date, which is said.
 */
const NO_RECEIPTS = new Problem(
  'That It is older than the It on this machine, and does not take the receipts this one hands clicks over by.',
  'invalid',
  'Update It on the machine it runs on, with `it upgrade` there or the Update button on its Machines page.',
)
/**
 * What `carry` answers where the conversation was not reopened after all, for a reason that is
 * nobody's fault and no failure of its app: this connector is stopping, the machine does not
 * fit the It it joined, the hold on what it was to be reopened for was lost, or the person
 * switched reopening off, all while the run was being got ready. Nothing was started, so
 * nothing is said to have been stopped or cut off, and what it was for is given back as it was.
 */
const NOT_STARTED = '\u0000 not started'
/** Whether this machine joined an It that runs on another computer. */
const joined = (): boolean => typeof readJson<{ at?: unknown }>(inHome('machine.json'))?.at === 'string'
/** What stands in the way of handing anything over before a machine that joined has first asked whether the two fit: nothing is known yet. */
const NOT_ASKED = new Problem('Whether this machine and the It it joined fit has not been asked yet.', 'invalid')
/** How often a machine that does not fit the It it joined asks again whether it does, and one that fits whether it still does. */
const FITS_EVERY_MS = 60_000

/** Everything the connector does once the folder's lock is its own. */
async function connecting(say: (line: string) => void): Promise<void> {
  // Something that goes wrong again and again (the backend cannot be reached, say) is said once
  // every ten minutes for each thing it is about, however many other lines come in between
  const saidAt = new Map<string, number>()
  const seldom = (about: string, line: string) => {
    if (Date.now() - (saidAt.get(about) ?? 0) < 600_000) return
    if (saidAt.size > 500) saidAt.clear()
    saidAt.set(about, Date.now())
    say(line)
  }
  /** A conversation's id as it is written down: a short hash of it, enough to tell two apart in this log and to say nothing else, since some harnesses put a chat's own name in the id. */
  const short = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8)

  // Which agent apps the person has connected on this machine, as It says, and what was found
  // of each app the last time the machine was looked at. Nothing has been heard yet, and until
  // It has said, no app is taken to be connected.
  let wantedNow: string[] | null = null
  let found: HarnessStatus[] = []
  const runtimes = new AddonRuntimes()
  // When an add-on's speaking last had the machine looked at again, and what does the looking, once the connector has begun to report
  let lookedAgainAt = 0
  let lookAgain: () => Promise<void> = async () => {}
  /**
   * Whether the person has chosen this agent app, in `it setup` or on the site. The connector
   * does nothing for an app that was not chosen: its conversations are not listened for, its
   * add-on is given no click, and no command of its own is ever run. A click on a page such an
   * app made waits, where the person sees it and `it wait` takes it.
   */
  const chosen = (harness: string) => wantedNow?.includes(harness) === true
  /**
   * Whether the app is connected as `it status` says it: chosen, and with It's add-on in it
   * when it was last looked at. That is what running the app's own command rests on. An add-on
   * that asks for its clicks has shown that it is there, and is answered once its app is chosen.
   */
  const connected = (harness: string) => chosen(harness) && found.some((h) => h.id === harness && (h.addon === 'connected' || h.addon === 'needs_approval'))
  // The agent apps the person has switched reopening on for on this machine, and since when, as
  // It says. Until It has said, none is.
  let wakesNow = new Map<string, number>()
  // And never on a system It does not reopen conversations on, whatever It says is switched on
  const wakes = (harness: string, at: number) => wakesOn(process.platform) && mayWake(wakesNow, harness, at)

  const sessions = new Map<string, { seen: number; busy: boolean; busyAt: number }>()
  // A conversation that was cleared carries on under a new id; its pages follow it
  const aliases = new Map<string, string>(Object.entries(readJson<Record<string, string>>(aliasFile()) ?? {}))
  const follow = (key: string) => {
    for (let hops = 0; hops < 10 && aliases.has(key); hops++) key = aliases.get(key)!
    return key
  }
  // `it wait` on this machine: the agent is blocked on the click, so it goes there and nowhere
  // else. A waiter names a page, or, naming none, waits for its own conversation's clicks only.
  // The ids a waiter watches are the ones it was told (its own and its latest few earlier ones),
  // and only clicks recorded under exactly those are left for it.
  //
  // A waiter that has ended is kept a while longer, with when it ended. An agent in a
  // conversation this connector has never heard from waits for each thing in turn, with a
  // command of its own each time, and thinks in between: such a conversation was open before
  // It's add-on was there, or its app has not yet been let run the add-on, and says nothing
  // of its turns. What is done on a page between two of its waits is the next wait's. Taken
  // for a conversation with nothing to do, it went into Codex's own queue, which hands it
  // over only when the turn is done, behind the very turn that then waited for it for ever.
  // A conversation that is heard from needs none of this: what it is told by its add-on is
  // not held up for a waiter that has gone.
  const waiters = new Map<string, { slug: string | null; sessions: Set<string>; seen: number; endedAt?: number }>()
  const waitedFor = (w: { slug: string | null; sessions: Set<string> }, click: Offered) =>
    w.slug === null ? click.session !== null && w.sessions.has(keyOf(click.session.harness, click.session.id)) : w.slug === click.artifact
  /** Whether this connector has heard, from its add-on, of the conversation a click is for. */
  const heardFrom = (click: Offered) => click.session !== null && sessions.has(follow(keyOf(click.session.harness, click.session.id)))
  const awaited = (click: Offered, now: number) =>
    [...waiters.values()].some(
      // Waiting now; or, where the conversation is one never heard from, ended or gone quiet a little while ago
      (w) => waitedFor(w, click) && (now - w.seen < WAIT_MS || (now - (w.endedAt ?? w.seen) < WAIT_AGAIN_MS && !heardFrom(click))),
    )
  const held = new Map<string, Held>()
  /** Handed to an agent, and not yet confirmed to It: confirmed again and again until it is. */
  const toConfirm = new Map<string, { route: string; receipt?: string }>()
  const confirmed = new Set<string>()
  /**
   * For usage reporting, which counts a delivery once It has confirmed it: when the click was
   * made, which harness it was for, and whether it joined a running turn or started one.
   */
  const counting = new Map<string, { at: number; harness: string | undefined; path: 'heard' | 'woke' }>()
  /** Given up on by this machine, and It has not yet been told to set it aside. Told again until it has. */
  const toPark = new Map<string, { for: { harness: string; id: string } | null; tag: string; receipt?: string }>()
  /** Set aside, and It has confirmed it. Should one come back on offer, it is left alone. */
  const parked = new Set<string>()
  /** Being put in a harness's queue right now; how often that has been tried, and when last. */
  const queueing = new Set<string>()
  /**
   * Claimed, and given to the harness's own command, which has not yet said whether it took it.
   * An agent that begins to wait for such a click is given it as well (see `/waiting`), and
   * that is noted here, so that a refusal by the command is then no failure.
   */
  const submitting = new Map<string, { click: Offered; toWaiter: boolean; given?: Given; printed?: boolean }>()
  /**
   * Taken by Codex's queue, or by T3 Code for a thread of Codex, while the conversation's turn
   * was running. Either hands such a click over only when that turn is done, so an agent that
   * begins to wait for it in the same turn would wait for a message that stands behind its own
   * turn. It is given the click as well (see `/waiting`). Kept, by the conversation it is for,
   * until the conversation is heard to end the turn or begin another, which is when the click
   * is handed over.
   *
   * One that was given to a waiter is kept until that waiter says it has printed it. It has
   * been reported to It as handed over, so nothing else would bring it back: were it let go of
   * as it is given, an answer that never reached the waiter would leave the turn waiting for a
   * message that stands behind it.
   */
  const recovery = new DeliveryRecovery(say)
  // Removing old copies is bookkeeping, so a failed save must not prevent delivery.
  // The unchanged saved record remains available for the next cleanup to retry.
  const cleanupFailed = (err: unknown) => seldom('waiter-cleanup', `could not save waiter cleanup (${why(err)}); trying again`)
  await recovery.pruneWaiters().catch(cleanupFailed)
  // Each by the receipt of the taking that handed it over, where it was kept: one kept with none is of a taking made without one
  for (const id of recovery.accepted) toConfirm.set(id, { route: 'queue', receipt: recovery.receipts.get(id) })
  /**
   * For how long a click given to one waiter is not given to another. The first is printing it
   * and says so in a moment. One that has not said so by then never had it, or is gone.
   */
  const GIVEN_MS = 10_000
  /** Outstanding queue acceptance receipts, independent of waiter copies. */
  const ACCEPTED_MOST = RECEIPTS_MOST
  const waiterRoom = (key: string) => {
    const pending = new Map<string, string>()
    for (const [id, sent] of submitting) {
      const session = sent.click.session
      if (session) pending.set(id, keyOf(session.harness, session.id))
    }
    // Reserve space even while another queue command is waiting for its claim to answer.
    for (const [id, target] of queueReceipts) pending.set(id, target)
    return recovery.waiterRoom(key, pending, follow)
  }
  const turnRunning = (key: string, now: number) => {
    const s = sessions.get(key)
    if (!(s?.busy === true && now - s.busyAt < TURN_QUIET_MS)) return false
    // A Codex turn that was interrupted, or whose Codex was closed in the middle of it, ends
    // with no hook to say so. No Codex holds its conversation from then on, so no turn is
    // running there. Taken for running, each click of the next half hour was kept a minute
    // for a hook that could not come, while the page said the agent was busy.
    if (key.startsWith('codex:') && codexOpen(key) === false) {
      s.busy = false
      return false
    }
    return true
  }
  const queueTries = new Map<string, { n: number; at: number; reopening: boolean }>()
  /**
   * What is known of the thread in T3 Code that a conversation is held in: the thread, that T3
   * Code has none of it or the search reached its read limit (asked again after a while,
   * since a conversation may be brought into T3 Code later), or that it is being asked for
   * at this moment. A conversation T3 Code could not take a message for is not offered to it
   * again for a while: `t3Refused`.
   */
  const t3Known = new Map<string, { thread: string | null; at: number } | 'asking'>()
  /** When each conversation that is being asked for was first asked for, by the clock that only goes forward. */
  const t3Asked = new Map<string, number>()
  const t3Searches = new Map<string, T3Search>()
  const t3Pending = new Map<string, { harness: string; id: string }>()
  const t3Retries = new Map<string, { at: number; delay: number }>()
  const t3Refused = new Map<string, number>()
  let t3Seen: { at: number; server: T3 | undefined } | undefined
  /** How long before another search after none matched or its read limit was reached. */
  const T3_AGAIN_MS = 6 * 3_600_000
  /** How long a conversation is kept from T3 Code after it could not take a message for it. */
  const T3_REFUSED_MS = 10 * 60_000
  /**
   * How long T3 Code is given to say which thread holds a conversation, before a click for it
   * goes the way it would without T3 Code. It says so in a fifth of a second to two seconds
   * where it is well. Later batches keep their progress but do not restart this wait.
   * What it says in the end is kept for the clicks that come after.
   */
  const T3_ASKED_MS = 5_000
  /**
   * The thread of T3 Code that a conversation is held in, with the server to send to:
   * `asking` while that is being found out, and nothing where it is in none, where T3 Code
   * is not running here, where it has just failed to take something for it, and where it has
   * been asked for longer than it is given to say. Then the click goes the way it would
   * without T3 Code.
   */
  function t3For(key: string, session: { harness: string; id: string }): { server: T3; thread: string } | 'asking' | undefined {
    const now = Date.now()
    const refused = t3Refused.get(key)
    if (refused !== undefined) {
      if (now - refused < T3_REFUSED_MS) return undefined
      t3Refused.delete(key)
    }
    // Whether it is running is asked of a small file and of the system, and no oftener than every few seconds
    if (!t3Seen || now - t3Seen.at > 5000) t3Seen = { at: now, server: t3Server() }
    const server = t3Seen.server
    if (!server) return undefined
    const known = t3Known.get(key)
    if (known === 'asking') return steady() - (t3Asked.get(key) ?? 0) < T3_ASKED_MS ? 'asking' : undefined
    if (known?.thread) return { server, thread: known.thread }
    if (known && now - known.at < T3_AGAIN_MS) return undefined
    const waiting = () => steady() - (t3Asked.get(key) ?? steady()) < T3_ASKED_MS
    if (steady() < (t3Retries.get(key)?.at ?? 0)) return waiting() ? 'asking' : undefined
    if (t3Known.size + t3Searches.size > 2000) {
      t3Known.clear()
      t3Asked.clear()
      t3Searches.clear()
      t3Pending.clear()
      t3Retries.clear()
    }
    t3Known.set(key, 'asking')
    if (!t3Asked.has(key)) t3Asked.set(key, steady())
    const search = t3Searches.get(key) ?? { pending: [], read: 0, attempted: new Set() }
    t3Searches.set(key, search)
    t3Pending.set(key, session)
    // By the id its pages name and by the one it has now: T3 Code keeps the one it resumes from
    const ids = [...new Set([session.id, threadOf(key)])]
    void t3ThreadOf(server, { harness: session.harness, ids, cwd: conversationFolder(session) }, search)
      .catch(() => ({ status: 'incomplete' as const, progressed: false }))
      .then((result) => {
        if (t3Searches.get(key) !== search) return
        let again = 10
        if (result.status === 'incomplete') {
          // More candidates, unread answers and expired budgets are not evidence of absence.
          // Keep the first deadline while continuing through later batches on subsequent passes.
          t3Known.delete(key)
          // New batches keep moving. Repeated failures wait longer, up to a minute, until
          // another candidate is reached or read successfully. A later failure starts afresh.
          const delay = result.progressed ? 0 : Math.min((t3Retries.get(key)?.delay || 150) * 2, 60_000)
          t3Retries.set(key, { at: steady() + (delay || 300), delay })
          again = (delay || 300) + 10
        } else {
          t3Asked.delete(key)
          t3Searches.delete(key)
          t3Pending.delete(key)
          t3Retries.delete(key)
          const thread = result.status === 'found' ? result.thread : null
          t3Known.set(key, { thread, at: Date.now() })
          if (thread) say(`${a(session.harness)} conversation (${short(session.id)}) is held in a thread of T3 Code`)
        }
        soon(again)
      })
    return waiting() ? 'asking' : undefined
  }
  /**
   * What each mark that was put into a conversation stands for, by the conversation: the
   * words for its clicks in full, kept until one of the conversation's own hooks asks for
   * them, which it does as the turn begins that the mark started, or at the next moment one
   * of them runs. A mark nobody asks about in time was put where no hook of It's runs.
   */
  /** The conversations a mark went unasked about: they are given the short line from then on, for as long as this connector runs. */
  const unmarked = new Set<string>()
  /** How long a conversation's hooks are given to ask what a mark stands for, and to say that they have it. An agent app that has to be started first takes ten seconds or so. */
  const MARK_ASKED_MS = 20_000
  const markTimers = new Set<ReturnType<typeof setTimeout>>()
  /**
   * The conversations whose add-on has been heard from on this machine, kept across a restart
   * of the connector: those are the ones a hook of It's is known to run in. Only so many.
   */
  const heardBefore = new Set<string>(Object.keys(readJson<Record<string, number>>(heardFile()) ?? {}))
  const HEARD_MOST = 300
  const noteHeard = (key: string) => {
    if (heardBefore.has(key)) return
    heardBefore.add(key)
    while (heardBefore.size > HEARD_MOST) heardBefore.delete(heardBefore.values().next().value!)
    try {
      if (!over) writePrivate(heardFile(), Object.fromEntries([...heardBefore].map((k) => [k, 1])))
    } catch {
      // Not kept: it is heard from again soon enough
    }
  }
  /**
   * Whether a conversation is given the mark alone. Its agent app has to have a hook of It's
   * that runs as a turn begins (Codex and Claude Code have). The conversation's add-on has to
   * have been heard from, so that its hooks are known to run there. No turn of it may be
   * running, since a mark put into a running turn starts none, and no hook runs for it as one
   * begins. And it must not have left a mark unasked about before.
   */
  const marks = (key: string, harness: string) =>
    (harness === 'codex' || harness === 'claude-code') && (sessions.has(key) || heardBefore.has(key)) && !unmarked.has(key) && !turnRunning(key, Date.now())
  /**
   * Notes what a mark stands for, before the mark is sent. Given back: how to take the note
   * away again, where the mark was not taken, and how to start the wait for a hook to say that
   * it has what the mark stood for.
   *
   * A note is kept until a hook says it has it, and not only until one has asked: an answer
   * that is lost on its way, or a hook that dies with it unread, would otherwise have used up
   * what the click was, when It has long been told that the click was handed over. Should no
   * hook say so in time, the short line is sent after the mark, so that the agent is told
   * after all, and the conversation is given no mark again. Where the app does not take the
   * line either, it is tried again a few times, and the note stays for the conversation's
   * next hook whatever becomes of that.
   */
  const markReceipt = (key: string, entry: MarkCopy) => {
    const harness = key.slice(0, key.indexOf(':'))
    // Looked for wherever it is kept by now: a conversation that carries on under a new id takes its marks along
    const where = () => [...recovery.marks].find(([, kept]) => kept.some((m) => m.id === entry.id))?.[0]
    const kept = () => where() !== undefined
    // Entries are replaced only after a durable save. Look up the current retry progress.
    const current = () => recovery.marks.get(where() ?? key)?.find((m) => m.id === entry.id)
    const takeAway = async () => {
      if (recovery.erased || over) return
      const under = where()
      if (under === undefined) return
      await recovery.removeMark(entry.id)
    }
    const who = `${a(agentOf(harness))} conversation (${short(threadOf(key))})`
    const after = (ms: number, what: () => void) => {
      const timer = setTimeout(() => {
        markTimers.delete(timer)
        if (!closing && !recovery.stopped && kept()) what()
      }, ms)
      markTimers.add(timer)
    }
    const line = async () => {
      const copy = current()
      if (!copy || copy.retry?.nextAt === null) return
      // Not into an app the person has disconnected since: what the mark stood for stays as it is, for a hook of the app once it is connected again
      if (!chosen(harness)) return
      // Recovery and the current machine settings must have answered before a restored mark can send anything.
      if (unfitting || givingBack !== 'done' || !connected(harness)) return after(MARK_ASKED_MS, line)
      const fallback = copy.fallback
      if (!fallback) return
      const keyNow = follow(where() ?? key)
      // A fallback never reopens a closed Codex conversation. Its next hook can still read the note.
      if (fallback.via === 'codex' && !codexOpen(keyNow)) return
      const server = fallback.via === 't3' ? t3Server() : undefined
      const tried = copy.retry?.attempts ?? 0
      const next = MARK_AGAIN_MS[tried]
      try {
        // Reserve the attempt before sending, so even an interrupted send cannot reset its budget.
        await recovery.retryMark(entry.id, { attempts: tried + 1, nextAt: next === undefined ? null : Date.now() + next })
      } catch (err) {
        seldom('mark-receipt', `could not keep the mark retry (${why(err)}); trying again`)
        return after(MARK_ASKED_MS, line)
      }
      // The disk may have taken time. A hook, disconnection or shutdown that arrived
      // meanwhile takes precedence over sending the fallback whose attempt was reserved.
      if (closing || unfitting || recovery.stopped || !kept() || !chosen(harness) || !connected(harness)) return
      if (fallback.via === 'codex' && !codexOpen(follow(where() ?? key))) return
      void (
        fallback.via === 't3'
          ? server
            ? t3Send(server, fallback.thread, fallback.text)
            : Promise.resolve('T3 Code could not be reached')
          : codexPut(threadOf(follow(where() ?? key)), fallback.text)
      )
        .catch(() => 'it could not be sent')
        .then(async (refused) => {
          if (closing || recovery.stopped || !kept()) return
          // Taken: the agent has it in the line, and the note is done with
          if (refused === null) return takeAway()
          if (next === undefined) {
            say(`${who} did not take the short line either, ${tried + 1} times; what its mark stood for is kept for the next of its hooks that runs`)
            return
          }
          try {
            // Measure the next delay from the refusal, including time spent awaiting the app.
            await recovery.retryMark(entry.id, { attempts: tried + 1, nextAt: Date.now() + next })
          } catch (err) {
            seldom('mark-receipt', `could not keep the next mark retry (${why(err)}); the reserved attempt remains`)
          }
          after(next, line)
        })
        .catch((err) => seldom('mark-receipt', `could not keep the mark receipt (${why(err)}); its text remains available`))
    }
    const wait = (ms = MARK_ASKED_MS): void => {
      if (current()?.retry?.attempts) unmarked.add(where() ?? key)
      if (current()?.retry?.nextAt === null) return
      after(ms, () => {
        if (!chosen(harness)) return
        if (unfitting || givingBack !== 'done' || !connected(harness)) return wait()
        unmarked.add(where() ?? key)
        say(`${who} was given a mark and none of its hooks said it had what the mark stood for; it is given the short line now, and from here on`)
        line()
      })
    }
    return { takeAway, wait }
  }
  const noteMark = async (key: string, texts: string[], fallback: MarkFallback) => {
    // Exhausted marks still belong to their hooks. Keep them and use the normal short line
    // for this click when no durable slot is free, rather than holding up another conversation.
    const entry = { id: randomBytes(8).toString('hex'), texts, at: Date.now(), fallback }
    if (!(await recovery.addMark(key, entry))) return undefined
    return markReceipt(key, entry)
  }
  // Old records without routing data remain available to hooks. Never guess a command line from their full text.
  const restoredMarks = new Set(
    [...recovery.marks.values()]
      .flat()
      .filter((m) => m.fallback)
      .map((m) => m.id),
  )
  const restoreMarks = () => {
    for (const [key, entries] of recovery.marks) {
      if (!chosen(key.slice(0, key.indexOf(':')))) continue
      for (const entry of entries) {
        if (!restoredMarks.delete(entry.id)) continue
        markReceipt(key, entry).wait(Math.max(0, (entry.retry?.nextAt ?? entry.at + MARK_ASKED_MS) - Date.now()))
      }
    }
  }
  /** One at a time for each conversation, oldest first, so that clicks arrive in the order they were made. */
  const queues = new Map<string, Promise<void>>()
  /** Room for the durable receipt is reserved before an app is asked to accept a click. */
  const queueReceipts = new Map<string, string>()
  const unconfirmed = new Set([...queuedButUnconfirmed(), ...recovery.accepted])
  /**
   * What the connector before this one left claimed is given back before anything is taken,
   * and nothing is taken until It has offered it again: taken first, a click made after one of
   * those would reach its conversation before it. It is asked for all that this machine holds,
   * since a claim may have been made that this machine never heard the answer to. An It from
   * before it could be asked that is asked for each click the journal names instead.
   */
  let givingBack: 'due' | 'asked' | 'done' = 'due'
  /** Returned claims are reconciled by id, independently of subscription visibility. */
  const comingBack = new Set(recovery.returning)
  const recoveredClicks = new Map<string, Offered>()
  let legacyGiveBack = false
  let legacyRecover = false
  let legacyLeft: Set<string> | undefined
  // The backend accepts at most 32 recovery ids. Older backends need one call per id;
  // use the same batch there so recovery cannot flood the backend with requests.
  const RECOVERY_BATCH = 32
  async function recoverBatch(): Promise<{
    back: string[]
    done: boolean
    person?: string
    routes?: { id: string; session: { harness: string; id: string } | null }[]
  } | null> {
    const missing = (err: unknown) => /could not find/i.test(String((err as Error)?.message ?? err))
    if (!legacyGiveBack) {
      try {
        const result = await call<{
          back: string[]
          done: boolean
          person?: string
          routes?: { id: string; session: { harness: string; id: string } | null }[]
        }>('mutation', api.delivery.giveBackBatch, {})
        if (!result || !Array.isArray(result.back) || !result.back.every((id) => typeof id === 'string') || typeof result.done !== 'boolean') return null
        return result
      } catch (err) {
        if (!missing(err)) return null
        legacyGiveBack = true
      }
    }
    // Older backends are asked about every locally recorded claim, a bounded batch at a time.
    legacyLeft ??= new Set([...claimedAndLeft(), ...recovery.returning])
    const gone = await Promise.all(
      [...legacyLeft].slice(0, RECOVERY_BATCH).map((id) =>
        call('mutation', api.delivery.release, { id }).then(
          () => id,
          (err) => ((err as { code?: string }).code === 'not_found' ? id : null),
        ),
      ),
    )
    const back = gone.filter((id): id is string => id !== null)
    for (const id of back) legacyLeft.delete(id)
    return { back, done: legacyLeft.size === 0 }
  }
  // A late answer about a previous hold must not erase the receipt for a newer claim of the same click.
  const claimAttempts = new Map<string, Attempt>()
  const retireClaim = async (id: string, attempt: Attempt | undefined) => {
    if (recovery.stopped || claimAttempts.get(id) !== attempt) return
    await recovery.retire([id], () => claimAttempts.get(id) === attempt)
    if (claimAttempts.get(id) === attempt) claimAttempts.delete(id)
  }
  /** Confirmed lease losses whose durable cleanup may still need a successful write. */
  const lostClaims = new Map<string, Attempt | undefined>()
  const retireLostClaims = async () => {
    for (const [id, attempt] of lostClaims) {
      try {
        await retireClaim(id, attempt)
        lostClaims.delete(id)
      } catch (err) {
        seldom('recovery-lost', `could not retire the lost claim (${why(err)}); trying again`)
      }
    }
  }
  /** Gives a click back, as the taking that holds it: by default the last this machine made of it. */
  const release = async (id: string, attempt = claimAttempts.get(id)) => {
    try {
      await call('mutation', api.delivery.release, { id, ...(attempt ? { receipt: attempt.receipt } : {}) })
    } catch (err) {
      if ((err as { code?: string }).code !== 'not_found') throw err
    }
    await retireClaim(id, attempt)
  }
  /** The receipts of the clicks a renewal or a question names, each by the taking that holds it. */
  const receiptsOf = (ids: string[], attempts: ReadonlyMap<string, Attempt>) =>
    ids.flatMap((id) => {
      const attempt = attempts.get(id)
      return attempt ? [{ id, receipt: attempt.receipt }] : []
    })
  /**
   * Takes clicks for a conversation, as one taking with a receipt of its own. The receipt is kept
   * before It is asked, so that a connector that ends before the answer comes still knows it.
   */
  const claim = async (ids: string[], session: { harness: string; id: string }) => {
    const attempt = newAttempt()
    await recovery.claim(ids, keyOf(session.harness, session.id), attempt.receipt)
    for (const id of ids) claimAttempts.set(id, attempt)
    const got = await call<string[]>('mutation', api.delivery.claim, { ids, for: session, receipt: attempt.receipt })
    const refused = ids.filter((id) => !got.includes(id))
    for (const id of refused) {
      // A recovered row is only a snapshot. A waiter or another machine may have taken
      // it since; only a fresh inbox offer can make it eligible for another claim.
      recoveredClicks.delete(id)
      lostClaims.set(id, attempt)
    }
    if (refused.length) await retireLostClaims()
    return { got, attempt }
  }
  let inbox: Offered[] = []
  let routing = false
  let stopping: ((code: number) => void) | null = null

  let confirming = false
  async function confirmAll(): Promise<void> {
    if (confirming) return
    confirming = true
    try {
      await confirmEach()
    } finally {
      confirming = false
    }
  }
  async function confirmEach(): Promise<void> {
    for (const [id, { route, receipt }] of toConfirm) {
      const attempt = claimAttempts.get(id)
      try {
        const done = await call<{ already: boolean } | null>('mutation', api.delivery.handedOff, { id, route, ...(receipt ? { receipt } : {}) })
        if (recovery.accepted.has(id) || recovery.returning.has(id)) await recovery.confirm(id, () => claimAttempts.get(id) === attempt)
        if (claimAttempts.get(id) === attempt) claimAttempts.delete(id)
        if (done) {
          confirmed.add(id)
          if (confirmed.size > 5000) confirmed.delete(confirmed.values().next().value!)
        }
        journal('confirmed', id)
        toConfirm.delete(id)
        hookSeen.delete(id)
        const how = counting.get(id)
        counting.delete(id)
        // Counted once: not when It already had it down as handed over
        if (how && done && !done.already) record('answer.delivered', { path: how.path, after: timeBand(Date.now() - how.at), agent: agentOf(how.harness) })
      } catch (err) {
        // Another machine took it over, or it is gone: either way it is not this one's to confirm
        if (/conflict|not_found/.test(String((err as { code?: string }).code))) {
          try {
            await recovery.confirm(id, () => claimAttempts.get(id) === attempt)
            if (claimAttempts.get(id) === attempt) claimAttempts.delete(id)
          } catch (error) {
            seldom('recovery', `could not keep the delivery receipt (${why(error)}); trying again`)
            continue
          }
          toConfirm.delete(id)
          counting.delete(id)
        }
        // Otherwise it is tried again a second from now, for as long as it takes
        else seldom('confirm', `could not tell It that click ${id} was handed over (${why(err)}); trying again`)
      }
    }
  }
  // What this machine remembers about a click (how often it was tried, that it was set aside)
  // is about the click for one conversation. If its page changes hands, even to another
  // conversation on this machine, it is a fresh click for the new one.
  const tag = (click: Offered) => `${click.id}|${click.session ? keyOf(click.session.harness, click.session.id) : ''}`
  const taken = (click: Offered) =>
    confirmed.has(click.id) || held.has(click.id) || toConfirm.has(click.id) || queueing.has(click.id) || toPark.has(click.id) || parked.has(tag(click))
  /** Tells It to set aside the clicks this machine has given up on, until It has heard. */
  let parking = false
  async function parkAll(): Promise<void> {
    if (parking) return
    parking = true
    try {
      for (const [id, pending] of toPark) {
        const { for: tried, tag: which, receipt } = pending
        const attempt = claimAttempts.get(id)
        // The backend says whether it is set aside. While another machine holds the click it is
        // not, and it is asked about again. A conversation that took nothing in all its tries
        // has everything else that is waiting for it set aside with this click. Asked by the
        // taking that gave up on it, where one did: another since has not given up on it.
        const answer = await call<boolean | 'again'>('mutation', api.delivery.park, {
          id,
          ...(receipt ? { receipt } : {}),
          ...(tried ? { for: tried, all: true } : {}),
        }).then(
          (set) => (set === 'again' ? ('again' as const) : set !== false),
          (err) => {
            if (/not_found/.test(String((err as { code?: string }).code))) return true
            seldom('park', `could not tell It that click ${id} was set aside (${why(err)}); trying again`)
            return false
          },
        )
        if (!answer) continue
        if (answer === 'again') {
          // Not set aside: its conversation was heard from again while this was ending, or
          // another taking has had it since. It is tried afresh, with no try counted against it.
          try {
            await retireClaim(id, attempt)
          } catch (err) {
            seldom('recovery', `could not keep the delivery receipt (${why(err)}); trying again`)
            continue
          }
          if (toPark.get(id) !== pending) continue
          toPark.delete(id)
          queueTries.delete(which)
          journal('released', id)
          continue
        }
        try {
          await retireClaim(id, attempt)
        } catch (err) {
          seldom('recovery', `could not keep the parked delivery receipt (${why(err)}); trying again`)
          continue
        }
        if (toPark.get(id) !== pending) continue
        toPark.delete(id)
        parked.add(which)
        journal('parked', id)
        if (parked.size > 2000) parked.delete(parked.values().next().value!)
      }
    } finally {
      parking = false
    }
  }

  /** For each conversation, the click that failed and is waiting to be tried again: nothing behind it goes first. */
  const stalled = new Map<string, string>()
  const stalledAt = new Map<string, number>()
  /**
   * A conversation is heard from again: its app is open and its add-on is asking, or a hook of
   * its turn has run. Whatever kept its clicks from being delivered before may well be over,
   * so what this machine remembers of having given up on them is forgotten, and It is asked to
   * give back what was set aside for it. They are then tried like any click that has just come.
   */
  function revive(harness: string, id: string): void {
    const here = follow(keyOf(harness, id))
    const its = (tagged: string) => follow(tagged.slice(tagged.indexOf('|') + 1)) === here
    for (const t of [...parked]) if (its(t)) parked.delete(t)
    for (const t of [...queueTries.keys()]) if (its(t)) queueTries.delete(t)
    for (const [line, clickId] of [...stalled]) {
      if (follow(keyOf(harness, line)) !== here) continue
      stalled.delete(line)
      stalledAt.delete(clickId)
    }
    // Under its own id, and under each earlier id its pages were made under
    const ids = [id, ...[...aliases].filter(([, to]) => follow(to) === here).map(([from]) => from.slice(from.indexOf(':') + 1))]
    for (const one of new Set(ids)) {
      heardAgain.delete(keyOf(harness, one))
      heardAgain.set(keyOf(harness, one), { harness, id: one, named: id })
    }
    while (heardAgain.size > 200) heardAgain.delete(heardAgain.keys().next().value!)
    void giveBackAside()
  }
  /**
   * The conversations heard from again that It has not yet been told of: told again at each
   * pass until it has answered, so that a word lost on its way leaves nothing of theirs aside.
   * It numbers each time a conversation is heard from again, and what this machine set aside
   * for it before then comes back, while a setting aside that was decided before then sets
   * nothing aside, whichever reaches It first.
   */
  const heardAgain = new Map<string, { harness: string; id: string; named: string }>()
  let tellingHeard = false
  async function giveBackAside(): Promise<void> {
    if (tellingHeard) return
    tellingHeard = true
    try {
      for (const [key, s] of [...heardAgain]) {
        const given = await call<number>('mutation', api.delivery.unpark, { for: { harness: s.harness, id: s.id } }).catch(() => null)
        if (given === null) continue
        if (heardAgain.get(key) === s) heardAgain.delete(key)
        if (given > 0)
          say(
            `${a(agentOf(s.harness))} conversation (${short(s.named)}) is back: ${given} thing${given === 1 ? '' : 's'} set aside for it ${given === 1 ? 'is' : 'are'} tried again`,
          )
      }
    } finally {
      tellingHeard = false
    }
  }
  /** The conversations this machine has reopened and that are running now, each with the way to stop it. */
  /**
   * The time by which this machine's holds on clicks are counted: its own clock, forward by
   * however far that clock has been set back since this program started. A hold lasts half a
   * minute by It's clock, and a machine whose own was set back a minute would go on believing
   * in a hold that It gave to another long since. Set forward, as it is when the machine wakes
   * from sleep, the clock counts as it is: that time did pass. It is looked at every second
   * at least, by the turn that routes what is waiting, so that a setting back is seen within one.
   */
  let setBack = 0
  let clockSeen = Date.now()
  const steady = (): number => {
    const now = Date.now()
    // Earlier than when it was last looked at, by more than a moment: the clock was set back by that much
    if (now < clockSeen - 1000) setBack += clockSeen - now
    clockSeen = now
    return now + setBack
  }
  /** When this machine first saw each click that waits for a closed conversation, by the clock that is never set back. */
  const firstSeen = new Map<string, number>()
  /**
   * Hook freshness starts when this connector first sees a click for its current conversation.
   * performance.now() ignores wall-clock corrections, but on Linux and macOS it pauses during
   * sleep, so that time does not age the click here. These observations live only in memory.
   * After a connector restart, pending clicks get a new window when they are offered again.
   */
  const hookSeen = new Map<string, { tag: string; at: number }>()
  const reopenedNow = new Map<string, AbortController>()
  /** The name each of them has with It, by which It says which run a person stopped. */
  const runNames = new Map<string, string>()
  /** Whether this connector is stopping: what it reopened is then ended with it, and is not taken for something a person stopped. */
  let closing = false
  /**
   * Whether this connector has stopped. Something it began may still be on its way then: a
   * turn it was ending, whose answer comes seconds later. What that then does is written
   * nowhere, since the notes are no longer this connector's to keep: the service may have
   * cleared them for an erase, or another connector may have them by now.
   */
  let over = false
  recovery.onErase = () => {
    lostClaims.clear()
    closing = true
    over = true
    stopping?.(0)
  }
  const journal = (event: string, id: string): void => {
    if (!over) journalWrite(event, id)
  }
  /**
   * Why this machine and the It it joined do not fit, while they do not: the two speak
   * different versions of how machines talk to It, and what one of them means by a request is
   * not what the other takes it for. Nothing is handed to an agent meanwhile, and nothing is
   * reopened. Everything else goes on: what was left running from before is still ended, this
   * connector can still be stopped, and it goes on by itself once the two fit.
   */
  let unfitting: Problem | null = joined() ? NOT_ASKED : null
  /**
   * The conversations whose reopened turn was cut off when the connector before this one
   * stopped, as that connector wrote them down. Each is told so when it is reopened for the
   * same thing again, once.
   */
  const cutOff = new Set<string>(readJson<string[]>(cutOffFile()) ?? [])
  // Each is owed until its conversation has been told, which may be several starts of this
  // connector later: so the list is kept in its file for as long as anything is on it
  /** Whether the notes as they stand are on the disk: where they could not be written, a run's own note is kept in their place. */
  let cutOffKept = true
  const keepCutOff = () => {
    try {
      while (cutOff.size > 200) cutOff.delete(cutOff.values().next().value!)
      if (over) return
      if (cutOff.size) writePrivate(cutOffFile(), [...cutOff])
      else rmSync(cutOffFile(), { force: true })
      cutOffKept = true
    } catch {
      cutOffKept = false
    }
  }
  /**
   * The conversations whose last reopened turn the person stopped from the page. An app that is
   * ended in the middle of a turn writes nothing of that into the conversation, so the agent
   * that is next reopened there would read a turn that simply breaks off, and might carry on
   * with it. It is told once, with what it is next reopened for. That may be after this
   * connector has been started again, so the list is kept in a file: forgotten with a restart,
   * the next reopening told the agent nothing, and it did what the person had stopped.
   */
  const stoppedByPerson = new Set<string>(readJson<string[]>(stoppedFile()) ?? [])
  const pendingStops = new Set<string>()
  const keepStopped = (): boolean => {
    try {
      if (over) return false
      // Keep the latest 200 notices, as before: conversations that are never reopened must
      // not make this file grow for the lifetime of the installation.
      while (stoppedByPerson.size > 200) stoppedByPerson.delete(stoppedByPerson.values().next().value!)
      if (stoppedByPerson.size) writePrivate(stoppedFile(), [...stoppedByPerson])
      else rmSync(stoppedFile(), { force: true })
      pendingStops.clear()
      return true
    } catch {
      return false
    }
  }
  // A connector that died, where one that is stopped ends what it reopened, left its reopened
  // conversations running with nobody to stop them, and It offering the same click again
  // beside them. Each is ended now, with what it had started, before anything is handed out:
  // the process it was is known by its number and by when it began, so that no other process
  // that has since been given the number is touched. Its conversation is told, the next time
  // it is reopened, that its turn was cut off.
  type Run = { pid: number; since: string; boot?: string; told?: number; unsure?: true; stopped?: true; run?: string }
  /** The note of runs from before could not be read, as this connector found when it started: it reopens nothing, whatever became of the file since. */
  let unread = false
  /** And it could not be moved aside either, so it is still where the note of runs is written. */
  let unreadWhereItWas = false
  const running = new Map<string, Run>()
  /**
   * The runs from before this connector started that could not be checked on, or could not be
   * ended: each is still noted, is looked at again when its conversation is next to be
   * reopened, and until it is known to be gone that conversation is reopened for nothing.
   */
  const unsettled = new Map<string, Run>()
  /** Writes down which runs there are. `must` is for a run that is about to be given something to do: not written down, it is not to run. */
  const keepRuns = (must = false) => {
    // A note that could be neither read nor moved aside is left exactly as it is: it is the
    // only word there is of what was running, and nothing is written over it
    if (unreadWhereItWas) {
      if (must) throw new Error('the note of runs cannot be written while the one from before stands unread')
      return
    }
    try {
      const all = { ...Object.fromEntries(unsettled), ...Object.fromEntries(running) }
      if (over) {
        if (must) throw new Error('this connector has stopped')
        return
      }
      if (Object.keys(all).length) writePrivate(runsFile(), all)
      else rmSync(runsFile(), { force: true })
    } catch (err) {
      if (must) throw err
    }
  }
  /**
   * Ends a run that was noted before this connector started. True once nothing of it is left.
   * Its conversation is owed the word that its turn was cut off either way: a run that was
   * noted and never said to be over did not end as a turn ends, whether it was still there to
   * be ended now or went with the machine being started again.
   */
  const settling = new Map<string, Promise<boolean>>()
  const settleOld = (key: string, was: Run): Promise<boolean> => {
    const pending = settling.get(key)
    if (pending) return pending
    const task = settleRun(key, was).finally(() => settling.delete(key))
    settling.set(key, task)
    return task
  }
  const settleRun = async (key: string, was: Run): Promise<boolean> => {
    const colon = key.indexOf(':')
    if (was.stopped) {
      stoppedByPerson.add(key)
      pendingStops.add(key)
      keepStopped()
    }
    // Older records have no conservative marker. Save one before recovery sends any signal,
    // or leave the process and its record alone until the disk can keep that evidence.
    if (!was.unsure) {
      unsettled.set(key, { ...was, unsure: true })
      try {
        keepRuns(true)
      } catch {
        unsettled.set(key, was)
        return false
      }
    }
    const became = await endTree(was.pid, was.since, {
      harness: key.slice(0, colon),
      session: key.slice(colon + 1),
      boot: was.boot,
      told: was.told,
      run: was.run,
    }).catch(() => 'unknown' as const)
    if (became === 'unknown') return false
    // An older uncertain record may have no run mark. With its leader gone, there is then
    // nothing by which to find a detached child missed before. Only a known reboot or the
    // person's explicit clearance can settle that record.
    if (was.unsure && !was.run && !fromAnotherStart(was.boot)) return false
    // The saved uncertainty makes recovery inspect the run again. Once that inspection has
    // accounted for its marked processes, a connector crash alone is no reason to hold it.
    const { unsure: _unsure, ...settled } = unsettled.get(key) ?? was
    unsettled.set(key, settled)
    was = settled
    if (became === 'ended')
      say(`${a(key.slice(0, colon))} conversation (${short(key)}) was still running from before this started, with nothing looking after it, and was ended`)
    // The word that its turn was cut off is written down before the note of the run is let go
    // of. Where it cannot be (a disk that is full), the note of the run stays and the
    // conversation stays held: let go of, nothing would be left to say that a turn was cut off
    if (was.stopped) {
      if (pendingStops.has(key)) return false
      if (cutOff.delete(key)) keepCutOff()
    } else {
      cutOff.add(key)
      keepCutOff()
      if (!cutOffKept) return false
    }
    if (over) return false
    unsettled.delete(key)
    // What was set aside for it while it was held is tried again
    revive(key.slice(0, colon), key.slice(colon + 1))
    return true
  }
  /**
   * The note of runs from before could not be read, and was kept aside as it was. Which
   * conversations were running is then not known, so none is reopened until a person has seen
   * to it and taken the file away: reopened for the same thing, an agent might work beside
   * one that is still at it.
   */
  const unreadRuns = () => `${runsFile()}.unreadable`
  const UNREAD =
    'It could not read its own note of which conversations were running when it last stopped, so it reopens none until that is seen to: check that no agent It started is still running on this machine, and then run `it runs clear` there'
  {
    let noted: Record<string, Run> = {}
    if (existsSync(runsFile()))
      try {
        const read: unknown = JSON.parse(readFileSync(runsFile(), 'utf8'))
        // All of it, or none: a note with one line that cannot be read says nothing sure about the others
        if (!read || typeof read !== 'object' || Array.isArray(read)) throw new Error('not a note of runs')
        for (const [key, was] of Object.entries(read as Record<string, { pid?: unknown; since?: unknown; boot?: unknown }>)) {
          if (!key.includes(':') || typeof was?.pid !== 'number' || typeof was.since !== 'string') throw new Error('not a note of runs')
          noted[key] = {
            pid: was.pid,
            since: was.since,
            ...(typeof was.boot === 'string' ? { boot: was.boot } : {}),
            ...(typeof (was as { told?: unknown }).told === 'number' ? { told: (was as { told: number }).told } : {}),
            ...((was as { unsure?: unknown }).unsure === true ? { unsure: true as const } : {}),
            ...((was as { stopped?: unknown }).stopped === true ? { stopped: true as const } : {}),
            ...(typeof (was as { run?: unknown }).run === 'string' ? { run: (was as { run: string }).run } : {}),
          }
        }
      } catch {
        noted = {}
        unread = true
        try {
          // Never over one that was kept aside before and has not been seen to
          if (existsSync(unreadRuns())) throw new Error('one is kept aside already')
          renameSync(runsFile(), unreadRuns())
        } catch {
          unreadWhereItWas = true
        }
      }
    // Said once as it starts, where it is so: everything else about reopening looks ready
    if (!listsProcesses()) say(NO_PS.replace(/^This machine/, 'this machine'))
    if (existsSync(unreadRuns())) unread = true
    if (unread)
      say(`${UNREAD.replace(/^It could/, 'it could')} (the note is kept as ${unreadWhereItWas ? 'runs.json' : 'runs.json.unreadable'} in It’s folder)`)
    // Every old run must be in the next durable copy before the first one is ended.
    for (const [key, run] of Object.entries(noted)) unsettled.set(key, run)
    for (const [key, run] of Object.entries(noted)) {
      if (!(await settleOld(key, run)))
        say(
          `${a(key.slice(0, key.indexOf(':')))} conversation (${short(key)}) may still be running from before this started, and could not be checked on or ended: it is reopened for nothing until it can be, or until \`it runs clear\` says nothing of it is running`,
        )
    }
    keepRuns()
  }
  /** Preserve both the local notice and the backend Stop until one durable copy carries it. */
  const rememberStopped = (key: string) => {
    stoppedByPerson.add(key)
    pendingStops.add(key)
    keepStopped()
    for (const run of [running.get(key), unsettled.get(key)]) if (run) run.stopped = true
    keepRuns()
  }
  const pendingEnds = new Map<string, { for: { harness: string; id: string }; run?: string; ok?: true }>()
  let finishing = false
  const finishRuns = async () => {
    if (finishing || over) return
    finishing = true
    try {
      if (pendingStops.size) keepStopped()
      for (const [key, ended] of pendingEnds) {
        if (over || reopenedNow.has(key) || pendingStops.has(key)) continue
        const held = unsettled.get(key)
        // A completed process tree held only for an unsaved notice can be released once the
        // disk works again. Process uncertainty is checked before the next reopening.
        if (held && !held.unsure && (await settleOld(key, held))) keepRuns()
        if (over || unsettled.has(key)) continue
        await call('mutation', api.machines.runEnded, ended).then(
          () => {
            if (pendingEnds.get(key) === ended) pendingEnds.delete(key)
          },
          () => {},
        )
      }
    } finally {
      finishing = false
    }
  }
  /**
   * The hand-overs whose reopened turn is being ended because this machine's hold on what it
   * was reopened for was lost: It was out of reach for as long as a hold lasts, and may have
   * given the click to another machine by now. A run that went on would act on it a second
   * time beside whoever has it. Each is noted by the hand-over's own mark, and by nothing a
   * second hand-over of the same conversation shares with it: noted by the conversation, one
   * hand-over's note was read, and let go of, by another's.
   */
  const lostHold = new Set<object>()
  /** The hand-over whose run each reopened conversation's is, by its own mark. */
  const handing = new Map<string, object>()
  /** The run of each conversation that a person stopped, by its name with It: by this a run that is ending is told to be ending for that reason. */
  const stoppedRun = new Map<string, string>()
  /** The conversations whose hold was lost while their run was still being got ready: it is not started. */
  const lostBefore = new Set<string>()
  /** When each conversation this machine reopened last ended. */
  const ranUntil = new Map<string, number>()
  /** Clicks that went with an earlier click of their conversation, in the same message: each is done with when its own turn in line comes. */
  const rode = new Set<string>()
  const budgets = new Map<string, { all: Budget; unattended: Budget }>()
  const machineBudget = new Budget(WAKE_RATE_MACHINE.most, WAKE_RATE_MACHINE.everyMs)
  /**
   * Whether a conversation may be reopened now, for clicks that someone was at the page for or
   * was not. With `use`, one reopening is counted. Where there is no room the clicks wait, and
   * go together with the next reopening: nothing is lost for it.
   */
  function room(key: string, attended: boolean, use = false): boolean {
    let b = budgets.get(key)
    if (!b) {
      if (budgets.size > 500) budgets.delete(budgets.keys().next().value!)
      b = { all: new Budget(WAKE_RATE.most, WAKE_RATE.everyMs), unattended: new Budget(WAKE_RATE_UNATTENDED.most, WAKE_RATE_UNATTENDED.everyMs) }
      budgets.set(key, b)
    }
    const now = Date.now()
    if (!machineBudget.has(now) || !b.all.has(now) || (!attended && !b.unattended.has(now))) {
      seldom(
        `rate:${key}`,
        `${a(key.slice(0, key.indexOf(':')))} conversation (${short(key)}) has been reopened as often as it may be for now; what was done waits and goes with the next reopening`,
      )
      return false
    }
    if (use) {
      machineBudget.take(now)
      b.all.take(now)
      if (!attended) b.unattended.take(now)
    }
    return true
  }
  /**
   * Runs an app's own command that carries a conversation on, in the folder the conversation
   * was held in, and says so to It for as long as it runs, so that the person sees it and can
   * stop it. Null when it ran, STOPPED when they stopped it, and otherwise why it did not run.
   */
  /** The last line a reopened app printed where it ended badly, by conversation, until its next reopening. */
  const saidLast = new Map<string, string>()
  // What a reopened app printed is kept in a file only while it runs. One that was left by a
  // connector that was ended in the middle of a run goes now.
  try {
    for (const name of readdirSync(inHome('logs'))) if (/^reopened-\d+-\d+\.txt$/.test(name)) rmSync(inHome('logs', name), { force: true })
  } catch {}
  async function carry(
    session: { harness: string; id: string },
    text: string,
    wanted: () => boolean = () => true,
    /** The clicks it is reopened for, which It looks at once more as it is told that the run begins. */
    ids: string[] = [],
    /** The mark of the hand-over this is for, by which it is told whether that hand-over's hold was lost. */
    owner: object = {},
  ): Promise<string | null> {
    const key = follow(keyOf(session.harness, session.id))
    // A conversation that was cleared carries on under another id, and it is that one which is carried on
    const now = { harness: session.harness, id: key.slice(key.indexOf(':') + 1) }
    const cwd = conversationFolder(now) ?? conversationFolder(session)
    if (runtimes.blocksWake(now.harness))
      return 'an open app cannot confirm which idle conversations it holds; send a message in the conversation to start listening'
    if (!cwd) return 'the folder its conversation was held in is not known on this machine, or is gone'
    // With what the person's shell gives a program, where this is the background service: an
    // app that takes its key from there cannot be reopened without it
    await shellLearned()
    const env = profileEnvironment(now.harness, conversationProfile(now) ?? conversationProfile(session), harnessEnv())
    if (typeof env === 'string') return env
    const how = carrying(now.harness, now.id, text, {
      codex: codexCommand(process.platform, env.PATH ?? env.Path ?? '', existsSync),
      itHome: home(),
      // The mode the person last had the conversation in, and where `it` is installed
      mode: now.harness === 'claude-code' ? (claudeModeOf(now.id, cwd, env.CLAUDE_CONFIG_DIR) ?? claudeModeOf(session.id, cwd, env.CLAUDE_CONFIG_DIR)) : null,
      itAt: [
        ...new Set([path.join(home(), 'bin', process.platform === 'win32' ? 'it.exe' : 'it'), process.execPath].filter((p) => /[\\/]it(\.exe)?$/.test(p))),
      ],
    })
    if (typeof how === 'string') return how
    if (reopenedNow.has(key)) return 'it is being reopened already'
    // This connector is stopping, or does not fit the It it joined: nothing is started
    if (closing || unfitting) return NOT_STARTED
    // Which conversations were running when It last stopped is not known: none is reopened
    if (unread || existsSync(unreadRuns())) return UNREAD
    // A run of it from before this connector started may still be there
    // (Seen to once, before this turn's message was written: not again here, where settling
    // it would make a note that the message could no longer carry)
    if (unsettled.has(key) || pendingStops.has(key))
      return `a turn of it from before may still be running on its machine, and could not be checked on or ended. It is reopened again once that machine has been started again, or once you have looked that nothing of it is running there and run \`it runs clear\`${listsProcesses() ? '' : `. ${NO_PS}`}`
    if (closing || unfitting) return NOT_STARTED
    const stop = new AbortController()
    reopenedNow.set(key, stop)
    // This run's own name with It, so that the ending of the run before it, told late, does not take this one's place away
    const runId = randomUUID()
    runNames.set(key, runId)
    let ended: string | null = 'it did not end'
    try {
      // It is told first, and nothing is started where it could not be told: it is by that
      // word that the page says the agent is working, and offers to stop it
      const told = await call<{ stopped?: boolean; off?: boolean } | null>('mutation', api.machines.runBegan, { for: session, run: runId, ids }).then(
        // Stopped meanwhile, or reopening switched off since this machine last heard: either way nothing is started
        (said) => (said?.stopped || said?.off ? ('stopped' as const) : true),
        () => false,
      )
      if (!told) {
        ended = 'It could not be told that the conversation was being reopened, so it was not'
        return ended
      }
      // The person stopped the conversation while this was being got ready, and what it was
      // to be reopened for went with the stop: nothing is started for it
      if (told === 'stopped') {
        ended = NOT_STARTED
        return ended
      }
      // Everything that could have changed while this was being got ready is looked at once
      // more, at the last moment before anything runs: the connector stopping, the machine
      // ceasing to fit, the hold on what it is reopened for being lost, and the person
      // switching reopening off or disconnecting the app
      // And the person opening the conversation themselves: its own add-on is asking by now,
      // and is given the click in the open app, where another turn begun beside it would cross it
      const open = sessions.get(key)
      if (
        closing ||
        unfitting ||
        runtimes.blocksWake(now.harness) ||
        lostBefore.delete(key) ||
        !wanted() ||
        (open !== undefined && Date.now() - open.seen < LIVE_MS)
      ) {
        ended = NOT_STARTED
        return ended
      }
      saidLast.delete(key)
      ended = await carryOn(
        how,
        cwd,
        { harness: now.harness, session: now.id, run: runId },
        {
          env,
          signal: stop.signal,
          // Ended without the system saying what of it was left: it stays noted, and is looked at again before its conversation is next reopened
          unsure: () => {
            const run = running.get(key)
            if (run) unsettled.set(key, { ...run, unsure: true })
          },
          // Ended because its fifteen minutes were over, in the middle of whatever it was
          // doing: what it was reopened for is tried again, and the turn that tries it is told
          // that an earlier one was cut off and may have done part of the work
          overtime: () => {
            cutOff.add(key)
            keepCutOff()
          },
          keepIn: inHome('logs'),
          said: (words) => saidLast.set(key, words),
          // Written down before it is given anything to do, or it is not to run: see `carryOn`
          began: (pid) => {
            const since = identity([pid]).get(pid)
            if (since === undefined) throw new Error('which process it is could not be told')
            const boot = bootId()
            // This conservative copy predates every signal and every possible disk failure.
            // Only a verified ending removes it. A crash cannot turn missing evidence into
            // permission to reopen beside a detached command.
            running.set(key, { pid, since, told: SINCE_TOLD, run: runId, unsure: true, ...(boot ? { boot } : {}) })
            try {
              keepRuns(true)
            } catch (err) {
              running.delete(key)
              throw err
            }
          },
        },
      )
      // It ran: what was set aside for this conversation after too many tries is its to be given again
      if (ended === null) revive(now.harness, now.id)
      // It ended badly by itself: a key it lacked may be in the person's shell by the next try
      else if (ended !== STOPPED && ended !== NOT_STARTED) shellMayHaveChanged()
      // Ended because its hold on what it was reopened for was lost: nobody stopped it. Its
      // conversation is told, if it is reopened for the same thing again, that its turn was cut off.
      if (ended === STOPPED && lostHold.has(owner)) {
        cutOff.add(key)
        keepCutOff()
      }
      // Stopped by the person, and not by this connector closing: its next turn is told so
      if (ended === STOPPED && !closing && !lostHold.has(owner)) {
        rememberStopped(key)
        // What this machine was keeping for the run's own add-on went with the stop, in It as
        // here: kept on, it would be handed to the add-on of the next reopening
        for (const [id, h] of held) {
          if (h.key !== key) continue
          held.delete(id)
          journal('stopped', id)
        }
      }
      return ended
    } finally {
      reopenedNow.delete(key)
      runNames.delete(key)
      stoppedRun.delete(key)
      // Its turn was cut off, and the word of that could not be written down (a disk that is
      // full): the note of the run itself is kept on, which says as much to whichever
      // connector starts next, where letting go of it would leave no sign of the turn at all
      // (What is already held for it says more than the note of the run does, and is left as it is)
      const noted = running.get(key)
      if (noted && !unsettled.has(key) && ((cutOff.has(key) && !cutOffKept) || pendingStops.has(key))) {
        // Termination was verified in this process. Only its notice still needs saving.
        const { unsure: _unsure, ...settled } = noted
        unsettled.set(key, settled)
      }
      if (running.delete(key)) keepRuns()
      if (ranUntil.size > 500) ranUntil.delete(ranUntil.keys().next().value!)
      ranUntil.set(key, Date.now())
      // The conversation is closed again from this moment. While it ran, the add-on inside it
      // asked for its clicks, and for a few seconds after an add-on last asked its conversation
      // counts as listening: left so, the next thing the person did would be kept for an add-on
      // that is gone, and they would wait for nothing. What was being kept for it goes back now.
      sessions.delete(key)
      for (const [id, h] of held) {
        if (h.key !== key || h.served) continue
        held.delete(id)
        journal('released', id)
        void release(id, h.attempt)
          .catch(() => {})
          .then(() => route())
      }
      // That it ran, or was stopped, takes back anything said earlier of why it could not be reopened
      pendingEnds.set(key, {
        for: session,
        run: runId,
        ...(ended === null || ended === STOPPED || ended === NOT_STARTED ? { ok: true } : {}),
      })
      await finishRuns()
    }
  }
  /**
   * Says to It why a conversation could not be reopened, so that the page can say so to the
   * person: in this program's own words, and with the last line the app itself printed where
   * it ended badly, which is often the only word there is of why. That line is the person's
   * own app speaking to them, and goes to the page alone: never into the log.
   */
  const notReopened = (session: { harness: string; id: string }, why: string) => {
    const words = saidLast.get(follow(keyOf(session.harness, session.id)))
    void call('mutation', api.machines.wakeFailed, { for: session, why: words ? `${why}, and its last words were: ${words}` : why }).catch(() => {})
  }
  /** Whether anybody was at the page for any click that is waiting for a click's conversation. One such, and the conversation is reopened as for a person, whatever else waits in front of it. */
  const someoneThere = (click: Offered, offered = inbox) =>
    click.attended !== false ||
    offered.some((c) => c.id !== click.id && c.attended !== false && c.session?.harness === click.session?.harness && c.session?.id === click.session?.id)
  /** Whether a conversation that is not listening is at work all the same, in a window It cannot see into: Claude Code wrote of it a moment ago. */
  const atWork = (session: { harness: string; id: string }, now: number) => {
    if (session.harness !== 'claude-code') return false
    const cwd = conversationFolder(session)
    const env = profileEnvironment(session.harness, conversationProfile(session), harnessEnv())
    const wrote = cwd && typeof env !== 'string' ? claudeWroteAt(session.id, cwd, env.CLAUDE_CONFIG_DIR) : null
    if (wrote === null || now - wrote >= CLAUDE_QUIET_MS) return false
    // What this machine's own reopening of it wrote is not somebody at work in it
    const ours = ranUntil.get(follow(keyOf(session.harness, session.id)))
    return ours === undefined || wrote > ours + 3000
  }
  /** The id Codex knows a conversation by now: the one it carries on under, if it was cleared. */
  const threadOf = (key: string) => key.slice(key.indexOf(':') + 1)
  const codexOpen = (key: string) => {
    const env = profileEnvironment('codex', conversationProfile({ harness: 'codex', id: threadOf(key) }), harnessEnv())
    return typeof env === 'string' ? null : codexHeld(threadOf(key), env.CODEX_HOME)
  }
  const codexPut = (thread: string, text: string) => {
    const env = profileEnvironment('codex', conversationProfile({ harness: 'codex', id: thread }), harnessEnv())
    return typeof env === 'string' ? Promise.resolve(env) : codexQueue(thread, text, env)
  }
  async function queueNow(click: Offered, reopening: boolean, offered: Offered[], t3?: { server: T3; thread: string }): Promise<void> {
    let keeping: ReturnType<typeof setInterval> | undefined
    const receiptSlots: string[] = []
    /** This hand-over is finished: what its renewals are answered from now on is about nothing that is running. */
    let over = false
    /** This hand-over's own mark on a note that its hold was lost, by which it lets go of that note and of no other's. */
    const mine = {}
    const line = click.session!.id
    const harness = click.session!.harness
    // What the route is called where it is written down: Codex's own queue, the thread T3 Code holds the conversation in, or the reopening of a conversation that was closed
    const route = reopening ? 'the reopening of its conversation' : t3 ? 'its thread in T3 Code' : 'Codex’s queue'
    // T3 Code starts a turn for what it is given, as a reopening does, and is given it no oftener than a conversation may be reopened
    const starting = reopening || t3 !== undefined
    const key = follow(keyOf(harness, line))
    /** The other clicks waiting for the same conversation, which go with this one in the same message. */
    let withIt: Offered[] = []
    /** The taking each click of this hand-over is held by. Every step of the hand-over names that one, however late it comes. */
    const attempts = new Map<string, Attempt>()
    /** A click of this hand-over as the waiter it is given to has it: with the receipt it is held by, which the waiter says it was handed over by. */
    const receipted = (c: Offered): Offered => {
      const attempt = attempts.get(c.id)
      return attempt ? { ...c, receipt: attempt.receipt } : c
    }
    const giveBack = async () => {
      for (const c of withIt) {
        journal('released', c.id)
        await release(c.id, attempts.get(c.id)).catch(() => {})
      }
      withIt = []
    }
    try {
      // This connector is stopping: what stood in line behind a run it has just ended is left for the connector that starts next
      if (closing || unfitting) return
      // It went with an earlier click of its conversation, in the same message
      if (rode.delete(click.id)) return
      // An earlier click for this conversation failed while this one was already in line
      // behind it: this one waits its turn, and is put in line again on a later pass
      if (stalled.has(line) && stalled.get(line) !== click.id) return
      // While this click stood in line (behind an earlier one, or for one of the few places a
      // command may run in), its agent may have begun to wait for it with `it wait`. The agent
      // is then blocked on the click, and Codex's queue would only hand it over once that turn
      // is done: so it is left where the waiter takes it.
      if (awaited(click, Date.now())) return
      // Nor is the app's command run once the app is not connected any more: the person may have
      // disconnected it while the click stood in line
      if (!connected(harness)) return
      // Nor is a conversation reopened once the person has switched that off, or more often than it may be
      if ((reopening && !wakes(harness, click.at)) || (starting && !room(key, someoneThere(click, offered)))) return
      // Codex's queue is for a conversation some Codex has open. One that was closed while this
      // click stood in line is not given it: the click is looked at afresh on the next pass.
      if (!reopening && !t3 && codexOpen(key) !== true) return
      // Only if it is still for this conversation on this machine: the page may have changed
      // hands while the click stood in line here
      // The hold is counted from before it was asked for: It starts counting when it gives it,
      // which may be long before its answer is here
      if (!reopening && waiterRoom(key) === 0) return
      if (recovery.accepted.size + queueReceipts.size >= ACCEPTED_MOST) return
      queueReceipts.set(click.id, key)
      receiptSlots.push(click.id)
      const claimedAt = steady()
      const taken = await claim([click.id], click.session!)
      if (!taken.got.includes(click.id)) return
      attempts.set(click.id, taken.attempt)
      // And looked at once more, now that the claim is answered: a waiter that began while it
      // was being asked for cannot take what this machine holds, so it is given back to it. It
      // is given back as well when Codex was disconnected in that time.
      if (closing || unfitting || awaited(click, Date.now()) || !connected(harness) || (reopening && !wakes(harness, click.at))) {
        journal('released', click.id)
        await release(click.id, taken.attempt).catch(() => {})
        return
      }
      if (starting) {
        // Everything else that is waiting for the conversation goes with it, in the one
        // message: a conversation reopened for five clicks is reopened once, and reads all five
        const eligible = offered
          .filter(
            (c) =>
              c.id !== click.id &&
              c.session?.harness === harness &&
              c.session.id === line &&
              !held.has(c.id) &&
              !toConfirm.has(c.id) &&
              !confirmed.has(c.id) &&
              !toPark.has(c.id) &&
              !parked.has(tag(c)) &&
              !rode.has(c.id) &&
              (t3 !== undefined || wakes(harness, c.at)) &&
              !awaited(c, Date.now()),
          )
          .sort((a, b) => a.at - b.at)
        const most = Math.min(
          WAKE_MOST - 1,
          Math.max(0, ACCEPTED_MOST - recovery.accepted.size - queueReceipts.size),
          reopening ? Infinity : Math.max(0, waiterRoom(follow(key)) - 1),
        )
        const more = eligible.slice(0, most)
        // A person may pass older timer clicks, but must be in the batch that spends the
        // attended allowance. The remaining timers keep their order and stay pending.
        if (most > 0 && click.attended === false && more.every((c) => c.attended === false)) {
          const attended = eligible.find((c) => c.attended !== false)
          if (attended) {
            if (more.length === most) more.pop()
            more.push(attended)
            more.sort((a, b) => a.at - b.at)
          }
        }
        if (more.length) {
          for (const c of more) {
            queueReceipts.set(c.id, key)
            receiptSlots.push(c.id)
          }
          const together = await claim(
            more.map((c) => c.id),
            click.session!,
          ).catch(() => null)
          withIt = together ? more.filter((c) => together.got.includes(c.id)) : []
          for (const c of withIt) attempts.set(c.id, together!.attempt)
        }
        // Taken now, and only now: several conversations may have been found to have room at the
        // same moment, while each was asking for its click, and the last place goes to one of
        // them. The others give back what they were given, which goes with a later reopening.
        if (
          !room(
            key,
            [click, ...withIt].some((c) => c.attended !== false),
            true,
          )
        ) {
          await giveBack()
          journal('released', click.id)
          await release(click.id, attempts.get(click.id)).catch(() => {})
          return
        }
      }
      // Getting this far may have taken most of the time the hold is good for (a slow answer,
      // twice over). Then it is made good again before anything is started on the strength of
      // it, and where it cannot be, nothing is started: the click may be another machine's.
      let heldFrom = claimedAt
      if (steady() - claimedAt > LEASE_MS / 3) {
        const again = steady()
        const ids = [click.id, ...withIt.map((c) => c.id)]
        const kept = await call<string[]>('mutation', api.delivery.renew, { ids, receipts: receiptsOf(ids, attempts) }).catch(() => [] as string[])
        if (!ids.every((id) => kept.includes(id))) {
          say(`click ${click.id} was not this machine’s any more by the time it could be handed over; it is left where it is`)
          await giveBack()
          journal('released', click.id)
          await release(click.id, attempts.get(click.id)).catch(() => {})
          return
        }
        heldFrom = again
        // A waiter may have begun while the hold was being made good, as one may while it is
        // first asked for: what goes into Codex's queue now would stand behind the very turn
        // that is waiting for it, so it is given back for the waiter to take
        if (!reopening && awaited(click, Date.now())) {
          await giveBack()
          journal('released', click.id)
          await release(click.id, attempts.get(click.id)).catch(() => {})
          return
        }
      }
      // The command can take as long as a lease lasts, so the lease is kept up while it runs.
      // Only a renewal the backend confirmed keeps it. Told that a click of this hand-over is
      // somebody else's to deliver by now, or told nothing for as long as a hold lasts, a
      // conversation that was reopened for it is ended. A click that is no longer held because
      // it is done with (its agent said so with `it ack`, or it was dropped) is no loss: it
      // is renewed no more, and the run goes on with the rest.
      let heldUntil = heldFrom + LEASE_MS
      const keptUp = new Set([click.id, ...withIt.map((c) => c.id)])
      /** The hold is gone, or may be: a conversation that was reopened for this is ended, once. */
      const lose = () => {
        if (over || !reopening || closing || lostHold.has(mine)) return
        const run = reopenedNow.get(follow(key))
        // Nothing is running yet: getting it ready takes a moment, and it is not to start
        if (!run) return void lostBefore.add(key)
        lostHold.add(mine)
        say(
          `${a(harness)} conversation (${short(line)}) is ended: this machine’s hold on what it was reopened for was lost, and that may be with another machine by now`,
        )
        run.abort()
      }
      // Asked again a while after it was last asked for, however long the answer to that took
      let renewedAt = heldFrom
      keeping = setInterval(() => {
        const asked = steady()
        const ids = [...keptUp]
        if (!ids.length) return
        // By the clock too, every second, and not only when an answer comes: an asking that hangs is no hold
        if (asked > heldUntil) return lose()
        if (asked - renewedAt < RENEW_MS) return
        renewedAt = asked
        void call<string[]>('mutation', api.delivery.renew, { ids, receipts: receiptsOf(ids, attempts) })
          .then(async (kept) => {
            const not = ids.filter((id) => !kept.includes(id))
            // An It from before this could be asked says nothing: what is not held is then taken for lost, as it was
            const lost = not.length
              ? await call<string[]>('query', api.delivery.lost, { ids: not, receipts: receiptsOf(not, attempts) }).then(
                  (theirs) => (Array.isArray(theirs) ? theirs : not),
                  () => not,
                )
              : []
            return { not, lost }
          })
          .catch(() => null)
          .then((said) => {
            // An answer that comes after this hand-over is over says nothing of whatever is running by then
            if (over) return
            if (said && !said.lost.length) {
              heldUntil = asked + LEASE_MS
              for (const id of said.not) keptUp.delete(id)
              return
            }
            if (!said && steady() <= heldUntil) return
            lose()
          })
      }, 1000)
      journal('queueing', click.id)
      // A run of this conversation from before this connector started is seen to first: ending
      // it now is what makes the note that this turn is owed
      if (reopening) {
        const before = unsettled.get(key)
        if (before) {
          await settleOld(key, before).catch(() => false)
          keepRuns()
        }
      }
      // Still not settled, it is reopened for nothing: said below, by `carry`, as why
      /** Whether this turn is told that the one before it was cut off: decided before it begins, since its own ending may make such a note anew. */
      const toldCutOff = cutOff.has(key)
      const sent: { click: Offered; toWaiter: boolean; given?: Given; printed?: boolean } = { click: receipted(click), toWaiter: false }
      submitting.set(click.id, sent)
      // What is put into a conversation that is open, or into a thread: the mark alone, where a
      // hook of It's hands the agent the rest, and otherwise one short line for each click
      const lines = () => (t3 ? [click, ...withIt].map((c) => briefClick(asClick(c))).join('\n') : briefClick(asClick(click), false))
      const put = (text: string) => (t3 ? t3Send(t3.server, t3.thread, text) : codexPut(threadOf(follow(key)), text))
      if (!reopening && turnRunning(follow(key), Date.now())) {
        await recovery.keepWaiters([click, ...withIt].map(receipted), follow(key))
      }
      const mark =
        !reopening && marks(follow(key), harness)
          ? await noteMark(
              follow(key),
              [click, ...(t3 ? withIt : [])].map((c) => describeClick(asClick(c))),
              t3 ? { via: 't3', thread: t3.thread, text: lines() } : { via: 'codex', text: lines() },
            )
          : undefined
      // Whose run it will be, where one is started: should every run be ended at once, as when
      // the machine is found not to fit, the note of that is this hand-over's to let go of
      if (reopening && !reopenedNow.has(key)) handing.set(key, mine)
      // What the person chose or typed is not put on a command line, where other users of the
      // machine could read it: the agent is told the action, and where to read what it carried
      const refused = reopening
        ? // Given on the command's input, where nobody else on the machine reads it, so in full.
          // What was done comes first and the note about it after: an app that lists its
          // conversations by how each last message begins then shows what was pressed, and
          // not the same note every time.
          await carry(
            click.session!,
            `${[click, ...withIt].map((c) => describeClick(asClick(c))).join('\n\n')}\n\n${WOKEN}${stoppedByPerson.has(key) ? `\n\n${WAS_STOPPED}` : ''}${toldCutOff ? `\n\n${WAS_CUT_OFF}` : ''}`,
            // Still wanted at the moment it would start: the app connected, and reopening switched on for it
            () => connected(harness) && wakes(harness, click.at),
            [click, ...withIt].map((c) => c.id),
            mine,
          ).then((ended) => {
            // Told, where the conversation was in fact reopened: one that could not be is told the next time
            if (ended === null || ended === STOPPED) {
              // The note it was given is used up. A turn that was itself cut off, by a hold
              // that was lost or by this connector stopping, is owed the note again
              if (toldCutOff && !(ended === STOPPED && (lostHold.has(mine) || closing))) {
                cutOff.delete(key)
                keepCutOff()
              }
              // Stopped again, it is owed the note again, which the stopping itself has written down
              if (ended === null && stoppedByPerson.delete(key)) keepStopped()
            }
            return ended
          })
        : // Not once this connector is stopping or the machine has ceased to fit, which may have come while the hold was made good again
          closing || unfitting
          ? NOT_STARTED
          : // What stands in the thread, or in the conversation, is the person's to look at: the
            // mark alone, or the short line for each click, and never It's words to the agent.
            // In a thread the line holds what they typed themselves, since it goes to T3 Code
            // on this machine alone. In Codex's queue it does not: that one is put on a
            // command line.
            await put(mark ? MARK : lines())
      // A mark that was not taken stands for nothing. One that was is waited on: a hook asks
      if (mark && refused !== null) await mark.takeAway()
      else mark?.wait()
      // A conversation the person stopped had what was done all the same: it is handed over,
      // and nothing is tried again for it
      // Ended because this connector is stopping, it is given back, to be reopened for by the
      // connector that starts next: nobody stopped it, and nothing is counted against it
      // Never started: given back as it was, with nothing counted against the conversation and no note used up
      if (refused === NOT_STARTED) {
        lostHold.delete(mine)
        await giveBack()
        journal('released', click.id)
        await release(click.id, attempts.get(click.id)).catch(() => {})
        return
      }
      if (refused === STOPPED && (closing || (unfitting && !lostHold.has(mine)))) {
        await giveBack()
        journal('released', click.id)
        await release(click.id, attempts.get(click.id)).catch(() => {})
        return
      }
      // Ended because the hold on it was lost: it is not this machine's to hand over or to give
      // back, and nothing is counted against the conversation. Whatever else was held with it goes back.
      if (refused === STOPPED && lostHold.delete(mine)) {
        await giveBack()
        journal('lost', click.id)
        // It may be a click that went with this one that was lost, and this one still held
        // here: given back, it is reopened for again, with the note that its turn was cut
        // off. Where it is not this machine's, the giving back does nothing.
        await release(click.id, attempts.get(click.id)).catch(() => {})
        return
      }
      const handed = refused === null || refused === STOPPED
      if (!handed) {
        await recovery.dropWaiters([click, ...withIt].map((c) => c.id))
        await giveBack()
      }
      // Refused by the command, and given meanwhile to an agent that is waiting for it: the
      // waiter has it and says so to It itself, so there is nothing to try again or set aside
      if (!handed && sent.toWaiter) return
      if (handed) {
        // The app has already taken these clicks. A failed receipt write must not turn
        // that handoff into a refusal or release the rest of its batch for redelivery.
        if (!recovery.stopped) {
          try {
            // A turn may have begun while the queue command was running. The click then
            // waits behind it, so keep its waiter copy with the acceptance receipt as well.
            await recovery.accept(
              [click, ...withIt].map((c) => c.id),
              { id: click.id, printed: sent.printed, given: sent.given },
              !reopening && turnRunning(follow(key), Date.now()) ? { clicks: [click, ...withIt].map(receipted), key: follow(key) } : undefined,
            )
          } catch (err) {
            seldom('recovery', `could not keep the delivery receipt (${why(err)}); confirming the accepted clicks`)
          }
        }
        if (refused === STOPPED) say(`${a(harness)} conversation (${short(line)}) was stopped by the person`)
        for (const c of [click, ...withIt]) {
          journal('queued', c.id)
          toConfirm.set(c.id, { route: 'queue', receipt: attempts.get(c.id)?.receipt })
          // The queue, or the reopening, starts a turn in a conversation that was not working
          counting.set(c.id, { at: c.at, harness, path: 'woke' })
          if (c !== click) {
            if (rode.size > 500) rode.delete(rode.values().next().value!)
            rode.add(c.id)
          }
        }
        record('agent.woken', { result: 'resumed', agent: agentOf(harness) })
        if (stalled.get(line) === click.id) stalled.delete(line)
        await confirmAll()
      } else {
        const n = (queueTries.get(tag(click))?.n ?? 0) + 1
        queueTries.set(tag(click), { n, at: Date.now(), reopening })
        stalled.set(line, click.id)
        stalledAt.set(click.id, Date.now())
        record('agent.woken', { result: n >= QUEUE_WAITS.length ? 'failed' : 'declined', agent: agentOf(harness) })
        if (reopening) notReopened(click.session!, refused)
        // T3 Code could not take it: the conversation is reopened as any other for a while, and that is tried at once
        if (t3) {
          t3Refused.set(key, Date.now())
          soon(10)
        }
        if (n >= QUEUE_WAITS.length) {
          stalled.delete(line)
          // Given up on from here. It is set aside so that it does not hide clicks that can be
          // delivered; it is still waiting, and the person and `it wait` still see it.
          say(`click ${click.id} was not taken by ${route} after ${n} tries (${refused}); it stays waiting`)
          toPark.set(click.id, { for: click.session, tag: tag(click), receipt: attempts.get(click.id)?.receipt })
          await parkAll()
        } else {
          say(`click ${click.id} was not taken by ${route} (${refused}); try ${n} of ${QUEUE_WAITS.length}`)
          await release(click.id, attempts.get(click.id)).catch(() => {})
        }
      }
    } catch (err) {
      say(`queue: click ${click.id}: ${why(err)}`)
      await giveBack()
    } finally {
      over = true
      // What was noted for a run that never came to be started is not left for the next one.
      // Nor is the note that this hand-over's hold was lost, however the hand-over ended: a
      // run that had run out of its time when the hold went ended as one that ran out, and the
      // note it left kept the conversation's next run from being ended when its own hold was lost
      lostBefore.delete(key)
      // (Only the note this hand-over made itself. Another hand-over of the same conversation
      // may have a run going whose hold has just been lost, and that note is still to end it)
      lostHold.delete(mine)
      if (handing.get(key) === mine) handing.delete(key)
      clearInterval(keeping)
      submitting.delete(click.id)
      queueing.delete(click.id)
      for (const id of receiptSlots) queueReceipts.delete(id)
    }
  }
  // Only a few such commands at a time, however many clicks are waiting. A queue's command is
  // over in a moment and a reopened conversation runs for as long as its turn does, so each has
  // places of its own, and neither waits behind the other.
  const places = (most: number) => {
    let running = 0
    const waitingForOne: (() => void)[] = []
    return async (work: () => Promise<void>) => {
      if (running >= most) await new Promise<void>((go) => waitingForOne.push(go))
      running++
      try {
        await work()
      } finally {
        running--
        waitingForOne.shift()?.()
      }
    }
  }
  const withSlot = places(QUEUE_AT_ONCE)
  const withRunSlot = places(RUNS_AT_ONCE)
  /**
   * Puts a click in its harness's own queue, behind any earlier click for the same conversation.
   * False when it has to wait before it is tried again: the clicks behind it for the same
   * conversation then wait too, so that what was pressed first still arrives first.
   */
  function queue(click: Offered, reopening: boolean, t3?: { server: T3; thread: string }): boolean {
    if (closing || unfitting) return false
    const key = follow(keyOf(click.session!.harness, click.session!.id))
    // A conversation's copies can hold back only its own queue. Restored copies expire
    // independently of session evidence; a missing session does not prove a turn ended.
    if (recovery.accepted.size >= ACCEPTED_MOST) return false
    if (!reopening && !queueing.has(click.id) && waiterRoom(key) === 0) return false
    let tried = queueTries.get(tag(click))
    if (queueing.has(click.id)) return true
    // Tried one way and now to go the other: its conversation was closed and is open, or was
    // open and is closed. What stood in the way of the one says nothing of the other, so it is
    // tried at once, and nothing behind it waits out a pause that was for something else.
    if (tried && tried.reopening !== reopening) {
      queueTries.delete(tag(click))
      tried = undefined
    }
    // Its tries are used up and it is on offer again (the machine that had taken it let it
    // go): it is set aside again, and does not hold up its conversation's later clicks
    if (tried && tried.n >= QUEUE_WAITS.length) {
      toPark.set(click.id, { for: click.session, tag: tag(click) })
      return true
    }
    if (queueing.size >= 50 || (tried && Date.now() - tried.at < QUEUE_WAITS[tried.n]!)) return false
    // In line by the conversation as it is now, whichever of its ids the click names: a
    // conversation that was cleared carries on under another id, and its pages still name the
    // old one. Two hand-overs of one conversation side by side read and let go of each other's
    // notes of how a run ended, and each of four repairs to that left another way for it to
    // happen. One at a time, there is no other hand-over's note to meet.
    // Every line that is this conversation's by now: also one that was begun under an id the
    // conversation has since been found to have had
    const before = [...queues].filter(([line]) => follow(line) === key).map(([, pending]) => pending)
    // A reopening does not stand in line behind another hand-over of its conversation. It
    // stays with It, where the add-on of the app that is being reopened can take it as soon
    // as it asks, and is looked at again when that hand-over is over.
    if (reopening && before.length) return false
    queueing.add(click.id)
    // Discovery advances while a command waits for its place. Keep this conversation's
    // offers with it, especially the attended click that permits this turn. Claims still
    // check ownership and whether each click is pending when the command gets its place.
    const offered = inbox.filter((c) => c.session?.harness === click.session!.harness && c.session?.id === click.session!.id)
    const next = Promise.all(before).then(() => (reopening ? withRunSlot : withSlot)(() => queueNow(click, reopening, offered, t3)))
    queues.set(key, next)
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
    return true
  }

  /** Looks at what is waiting again in a moment, and not only at the next second: what is reopened at once is not kept waiting for the clock. */
  let sooner: ReturnType<typeof setTimeout> | undefined
  let soonerAt = 0
  const soon = (ms: number) => {
    const at = steady() + ms
    if (sooner && soonerAt <= at) return
    // A discovery retry may be a minute away. A click whose route is ready sooner keeps
    // its earlier pass, rather than waiting for that retry or the next one-second tick.
    if (sooner) clearTimeout(sooner)
    soonerAt = at
    sooner = setTimeout(() => {
      sooner = undefined
      void route()
    }, ms)
    sooner.unref?.()
  }
  async function route(): Promise<void> {
    if (routing || closing || unfitting || recovery.erased) return
    routing = true
    try {
      // Discovery outlives the click that started it, including a completed fallback delivery.
      for (const [key, session] of t3Pending) if (connected(session.harness)) t3For(key, session)
      await retireLostClaims()
      await recovery
        .pruneWaiters(Date.now(), (key, restored) => (!restored || sessions.has(follow(key))) && !turnRunning(follow(key), Date.now()))
        .catch(cleanupFailed)
      if (givingBack === 'due') {
        const asked = await recoverBatch()
        if (asked === null) {
          // An expired lease is still hidden until the backend requeues it. Only a complete
          // recovery answer proves that older work no longer waits behind a newer click.
          soon(1000)
          return
        } else {
          await recovery.recover(
            asked.back,
            (asked.routes ?? []).flatMap((row) => (row.session ? [[row.id, keyOf(row.session.harness, row.session.id)]] : [])),
            asked.person,
          )
          for (const id of asked.back) comingBack.add(id)
          for (const id of asked.back) journal('released', id)
          if (!asked.done) {
            soon(1000)
            return
          }
          givingBack = 'asked'
        }
      }
      if (givingBack === 'asked') {
        // A current inbox row is evidence too, including for an older backend.
        const seen = inbox.filter((c) => comingBack.has(c.id))
        if (seen.length) {
          await recovery.retire(seen.map((c) => c.id))
          for (const c of seen) comingBack.delete(c.id)
        }
        if (comingBack.size) {
          const ids = [...comingBack].slice(0, RECOVERY_BATCH)
          try {
            const rows = legacyRecover
              ? await Promise.all(
                  ids.map(async (id) => {
                    try {
                      const click = await call<Offered & { delivery: string }>('query', api.delivery.get, { id })
                      if (!click) throw new Error('unanswered')
                      if (click.delivery === 'pending') {
                        // Older get answers do not say whether a pending click is parked.
                        // Keep its ordering hold until the inbox actually offers it, without
                        // preventing unrelated conversations from receiving their clicks.
                        if (click.session && !recovery.targets.has(id)) await recovery.recover([], [[id, keyOf(click.session.harness, click.session.id)]])
                        throw new Error('waiting for the recovered click to be offered')
                      }
                      return { id, click: null }
                    } catch (err) {
                      if ((err as { code?: string }).code === 'not_found') return { id, click: null }
                      throw err
                    }
                  }),
                )
              : await call<{ id: string; click: Offered | null }[]>('query', api.delivery.recover, { ids })
            if (!Array.isArray(rows) || rows.length !== ids.length || rows.some((r, i) => r.id !== ids[i] || (r.click !== null && r.click?.id !== r.id)))
              throw new Error('incomplete recovery')
            await recovery.retire(rows.map((row) => row.id))
            for (const row of rows) comingBack.delete(row.id)
            for (const row of rows) if (row.click) recoveredClicks.set(row.id, row.click)
          } catch (err) {
            if (/could not find/i.test(String((err as Error)?.message ?? err))) legacyRecover = true
            for (const id of ids) {
              comingBack.delete(id)
              comingBack.add(id)
            }
          }
          if (comingBack.size) {
            soon(1000)
            if ([...comingBack].some((id) => !recovery.targets.has(id))) return
          }
        }
        if (!comingBack.size) givingBack = 'done'
      }
      const now = Date.now()
      // Telling It what was handed over is done beside this, never ahead of it: a slow answer
      // there must not hold up renewing leases or taking new clicks
      void confirmAll()
      void parkAll()
      void giveBackAside()
      // A held click stays held while something will come for it: an add-on that is asking, or
      // a Codex turn that is still running and will reach a hook. Otherwise it goes back, so
      // another route can have it.
      /** Gives back a click that is held for an app the person has since disconnected: it is given to nothing there. Whether it was. */
      const disconnected = async (id: string, h: Held): Promise<boolean> => {
        if (!h.click.session || chosen(h.click.session.harness)) return false
        held.delete(id)
        journal('released', id)
        say(`click ${id} was kept for an agent app that is not connected any more; it goes back to waiting`)
        await release(id, h.attempt).catch(() => {})
        return true
      }
      // How long each has been held is counted by the clock that is never set back
      const at = steady()
      for (const [id, h] of held) {
        if (await disconnected(id, h)) continue
        const s = sessions.get(h.key)
        const listening = !h.forHook && s !== undefined && now - s.seen < LIVE_MS
        const hookComing = h.forHook && turnRunning(h.key, now) && at - h.claimedAt < HOOK_HOLD_MS
        if (listening || hookComing) {
          if (at < h.leaseUntil - LEASE_MS + RENEW_MS) continue
          // Only a renewal the backend confirmed extends the lease. Past it the click may be
          // someone else's, so serving it from here stops.
          // Counted from before the request went out: the backend's clock started no later than that
          const asked = steady()
          const attempt = h.attempt
          const kept = await call<string[]>('mutation', api.delivery.renew, { ids: [id], receipts: [{ id, receipt: attempt.receipt }] }).catch(() => null)
          // While that was being asked, the click may have been handed over or given to a waiting
          // agent: it is not held here then, and nothing about it is lost
          if (held.get(id) !== h) continue
          // Or the person may have disconnected its app, and then it is not kept a moment longer
          if (await disconnected(id, h)) continue
          if (kept?.includes(id)) h.leaseUntil = asked + LEASE_MS
          else if (kept !== null || at > h.leaseUntil - 2000) {
            held.delete(id)
            // A refused renewal proves this claim is over. An unanswered renewal does not.
            // Stop serving it even if saving the cleanup fails, and retry that save separately.
            if (kept !== null) {
              lostClaims.set(id, attempt)
              await retireLostClaims()
            }
            journal('lost', id)
            say(
              `click ${id} is not this machine's to deliver any more (${kept === null ? 'It could not be reached to keep it' : 'It says this machine no longer holds it'})`,
            )
          }
        } else if (at - h.claimedAt > HOLD_MS && !h.served) {
          held.delete(id)
          journal('released', id)
          say(`click ${id} was kept for ${h.forHook ? 'a Codex turn that ended without taking it' : 'an add-on that stopped asking'}; it goes back to waiting`)
          await release(id, h.attempt).catch(() => {})
        } else if (at > h.leaseUntil - 2000) {
          held.delete(id)
          journal('lost', id)
        }
      }
      // Oldest first, so that what was pressed first arrives first. A conversation whose earlier
      // click is waiting to be tried again has its later ones wait behind it.
      const waitingBehind = new Set<string>()
      // A click that held its conversation's line holds it until it is known to be done with:
      // delivered, set aside, or so long gone from what is offered that something else has it.
      // Being absent for a moment proves nothing: it is absent while its lease is given back.
      for (const [line, id] of stalled) {
        const done = toConfirm.has(id) || toPark.has(id) || [...parked].some((p) => p.startsWith(`${id}|`))
        const longGone = !queueing.has(id) && !inbox.some((c) => c.id === id) && now - (stalledAt.get(id) ?? 0) > LEASE_MS + 90_000
        if (done || longGone) {
          stalled.delete(line)
          stalledAt.delete(id)
        }
      }
      /**
       * How long a click has been there. That is told by when this machine first saw it, as well
       * as by when It says it was made: the second is by It's clock, and a joined machine whose
       * own is three quarters of a minute behind waited that long before every reopening.
       */
      const beenThere = (click: Offered, now: number): number => {
        const here = steady()
        if (!firstSeen.has(click.id)) {
          if (firstSeen.size > 5000) firstSeen.clear()
          firstSeen.set(click.id, here)
        }
        return Math.max(now - click.at, here - firstSeen.get(click.id)!)
      }
      for (const click of [...new Map([...inbox, ...recoveredClicks.values()].map((c) => [c.id, c])).values()].sort((a, b) => a.at - b.at)) {
        if (taken(click)) {
          recoveredClicks.delete(click.id)
          continue
        }
        if (unconfirmed.has(click.id)) {
          // Its harness's queue took it before a restart; all that was missing was telling It,
          // by the receipt of the taking it was handed over by, where that was kept
          unconfirmed.delete(click.id)
          toConfirm.set(click.id, { route: 'queue', receipt: recovery.receipts.get(click.id) })
          continue
        }
        if (!click.session || awaited(click, now)) continue
        // A click for an app that is not connected is left where it is, for the person and `it wait`
        if (!chosen(click.session.harness)) continue
        const key = follow(keyOf(click.session.harness, click.session.id))
        if (waitingBehind.has(key) || [...comingBack].some((id) => follow(recovery.targets.get(id) ?? '') === key)) continue
        // The thread of T3 Code the conversation is held in, asked for only where no step before it has taken the click
        const session = click.session
        let thread: ReturnType<typeof t3For>
        const heldInT3 = (): boolean => {
          thread = connected(session.harness) && !reopenedNow.has(key) ? t3For(key, session) : undefined
          return thread !== undefined
        }
        const s = sessions.get(key)
        const codex = click.session.harness === 'codex'
        // An add-on that asks every second is listening. Codex's hooks only run at moments in a
        // turn, so having heard from one says nothing about the next.
        const listening = !codex && s !== undefined && now - s.seen < LIVE_MS
        // A Codex turn that is running will reach a hook: after its next command, or when it stops
        const inTurn = codex && turnRunning(key, now)
        // Codex's queue may hold an earlier click of the conversation behind this very turn, or
        // one may have its place in line for the queue, from the moment it was given that place
        // and before anything was asked for it. Given to the turn's next hook, this one would
        // be read before it: so it follows the earlier one, and is handed over after it.
        const queuedBefore =
          inTurn && ([...queues.keys()].some((line) => follow(line) === key) || [...recovery.waiters.values()].some((b) => follow(b.key) === key))
        const seen = hookSeen.get(click.id)
        const fresh = seen?.tag === tag(click) && performance.now() - seen.at < FRESH_MS
        const forAddOn = listening || (inTurn && fresh && !queuedBefore)
        // Which of the other ways it goes, asked only where the first does not take it
        const way = forAddOn
          ? undefined
          : wayOf({
              inT3: heldInT3,
              codexOpen: () => codex && connected('codex') && !reopenedNow.has(key) && codexOpen(key) === true,
              reopens: () =>
                wakes(session.harness, click.at) && connected(session.harness) && (!codex || codexOpen(key) === false) && !runtimes.blocksWake(session.harness),
            })
        if (forAddOn) {
          // Route 1: the add-on will ask for it, or the running turn's next hook will
          const asked = steady()
          const { got, attempt } = await claim([click.id], click.session)
          const holds = got.includes(click.id)
          // An agent may have begun to wait for it while the claim was being asked for. A waiter
          // cannot take what this machine holds, so the click is given back for it to take. It
          // is given back as well when the person disconnected its app in that time.
          if (holds && (unfitting || closing || awaited(click, Date.now()) || !chosen(click.session.harness))) {
            journal('released', click.id)
            await release(click.id, attempt).catch(() => {})
          } else if (holds) {
            // Under the id the conversation has by now: it may have carried on under another while the claim was being asked for
            held.set(click.id, { click, attempt, key: follow(key), claimedAt: at, leaseUntil: asked + LEASE_MS, forHook: inTurn, served: false })
            journal('claimed', click.id)
          }
        } else if (way === 't3') {
          // Route 2: the conversation is held in a thread of T3 Code. The click is put to the
          // thread, where T3 Code starts a turn for it and shows it, in the mode the thread is
          // held in. That is so whether T3 Code still holds the conversation's program or has
          // let it go, as it does when a thread has been quiet or T3 Code is started anew: the
          // person has closed nothing, and the thread is where it was. Any other way runs the
          // turn where they do not see it. Reopened with the agent app's own command, it runs
          // outside T3 Code. And put in Codex's own queue while T3 Code holds Codex, it runs
          // inside the very program T3 Code holds, and the thread still shows nothing: T3
          // Code shows the turns it started. This is not a reopening, and is not asked of the
          // switch for one. Not for a conversation this machine is itself running at this
          // moment, and not until a few things done together can go together.
          const left = SETTLE_MS - beenThere(click, now)
          if (thread === 'asking') {
            waitingBehind.add(key)
            soon(300)
          } else if (left > 0) {
            waitingBehind.add(key)
            soon(left + 10)
          } else if (atWork(click.session, now) || !queue(click, false, thread)) waitingBehind.add(key)
        } else if (way === 'queue') {
          // Route 2b: some Codex has the conversation open, in a window or an app that is not
          // T3 Code, and takes a message from Codex's own queue by itself: at once when it is
          // idle, after its turn when it is not. Not waited for here: one slow command must
          // not hold up every other click. A conversation this machine is itself running is
          // not given one that way: that run ends with its turn, and would cut off whatever
          // Codex began for the message.
          if (!queue(click, false)) waitingBehind.add(key)
        } else if (way === 'reopen') {
          // Route 3: the conversation is not listening, which is to say closed, and the person
          // has switched on reopening for its agent app on this machine. It is reopened at once,
          // but for the moment that lets a few things done together go together. It is run in
          // line like a queue, one click of a conversation at a time. And only so often: past
          // that the click waits, and goes with the next reopening. Nor while it is at work in a
          // window It cannot see into: it is looked at again once it is quiet.
          const left = SETTLE_MS - beenThere(click, now)
          if (left > 0) {
            waitingBehind.add(key)
            soon(left + 10)
          } else if (atWork(click.session, now) || !room(key, someoneThere(click)) || !queue(click, true)) waitingBehind.add(key)
        }
        // Route 4: nothing to do. The click stays waiting and the site shows it.
      }
    } catch (err) {
      if (!closing) seldom('delivery', `delivery: ${why(err)}`)
    } finally {
      routing = false
    }
  }

  // ---- what add-ons on this machine ask ----
  const token = randomBytes(24).toString('hex')
  const handle = async (req: http.IncomingMessage, bodyText: string, gone: () => boolean): Promise<[number, unknown]> => {
    // Who is asking comes first: nothing about the request is looked at before that. Over the
    // socket, which only this user can open, knowing the token is enough. Over a port, which
    // any program on the machine can connect to, the token itself is never sent: the request
    // carries a code made from it, and so does the answer (see `sealed` below).
    const known = info.socket
      ? req.headers['x-it-token'] === token
      : macOk(token, String(req.headers['x-it-nonce'] ?? ''), `${req.method}\n${req.url}\n${bodyText}`, String(req.headers['x-it-mac'] ?? ''))
    if (!known) {
      // Something on this machine that does not know the token: an add-on from before a
      // restart, for a moment, or something that should not be asking at all
      seldom('stranger', 'a request to the connector without its token was refused')
      return [401, { error: 'not for you' }]
    }
    // What was asked for is whatever the caller wrote. Something that is no address is answered as that, and nothing is made of it
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://local')
    } catch {
      return [400, { error: 'that is no address' }]
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const now = Date.now()
      return [
        200,
        {
          ok: true,
          addons: Object.fromEntries(found.map((h) => [h.id, runtimes.status(h.id)])),
          ...(unfitting && unfitting !== NOT_ASKED ? { unfit: `${unfitting.message} ${unfitting.hint ?? ''}`.trim() } : {}),
          ...(unfitting === NOT_ASKED ? { unchecked: true } : {}),
          ...(unread || unsettled.size ? { heldRuns: (unread ? 1 : 0) + unsettled.size } : {}),
          version: VERSION,
          pid: process.pid,
          waiting: inbox.length,
          held: held.size,
          sessions: [...sessions].filter(([, v]) => now - v.seen < LIVE_MS).map(([k]) => k),
        },
      ]
    }
    let body: Record<string, any> = {}
    if (req.method === 'POST') {
      const parsed = parseJson(bodyText || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [400, { error: 'send a JSON object' }]
      body = parsed as Record<string, any>
    }
    const harness = String(url.searchParams.get('harness') ?? body.harness ?? '').slice(0, 40)
    const id = String(url.searchParams.get('session') ?? body.session ?? '').slice(0, 200)
    // What the marks put into a conversation stand for: asked by the conversation's own hook
    // as the turn begins that a mark started, or at the next moment one of its hooks runs.
    // Given for as long as no hook has said that it has it, so that an answer lost on its way
    // is asked for again and given again.
    if (req.method === 'POST' && url.pathname === '/marked') {
      if (recovery.erased) return [200, { ok: true, marks: [], texts: [] }]
      if (!harness || !id) return [400, { error: 'say which harness and session' }]
      const key = follow(keyOf(harness, id))
      // The hook has what it was given, and says which: only then is it let go of
      if (Array.isArray(body.taken)) {
        await recovery.removeMarks(key, body.taken)
        return [200, { ok: true }]
      }
      // A hook of an app the person has disconnected is handed nothing, as its add-on is given
      // no clicks, and nor is any hook by a machine that hands nothing over. What the marks
      // stood for is kept as it is.
      if (!chosen(harness) || unfitting || closing) return [200, { ok: true, marks: [], texts: [] }]
      // For a turn the person started with a message of their own, only what has waited past
      // its time is handed over: a mark's own turn is still to come, and has first claim
      const due = (recovery.marks.get(key) ?? []).filter((m) => body.own !== true || Date.now() - m.at > MARK_ASKED_MS)
      return [200, { ok: true, marks: due.map((m) => m.id), texts: due.flatMap((m) => m.texts) }]
    }
    if (req.method === 'POST' && url.pathname === '/addon') {
      const runtime = runtimes.hear(harness, body.instance, body.addon)
      return runtime ? [200, { ok: runtime.state === 'active', api: 1, runtime }] : [400, { error: 'invalid add-on report' }]
    }
    if (url.pathname === '/session' || url.pathname === '/clicks') {
      if (!harness || !id) return [400, { error: 'say which harness and session' }]
      // An add-on in an app that is not connected (one the person has disconnected, still
      // running in a conversation that was open) is answered, given nothing, and not listened for
      if (!chosen(harness)) {
        if (wantedNow !== null)
          seldom(
            `unconnected:${agentOf(harness)}`,
            `${a(agentOf(harness))} conversation asked for its clicks, and that app is not connected here; it is given none`,
          )
        return [200, url.pathname === '/session' ? { ok: true } : { clicks: [] }]
      }
      const runtime = body.addon === undefined ? undefined : runtimes.hear(harness, body.instance, body.addon)
      const blocked = body.addon !== undefined && runtime?.state !== 'active'
      // The session metadata still uses this API when only the loaded build is stale.
      if (blocked && (!runtime || body.addon.api !== 1)) return [200, { ok: false, clicks: [], runtime }]
      const key = keyOf(harness, id)
      // An add-on that can see which folder its conversation is held in says so, and it is noted
      // here: where the app runs the agent's commands with It's folder shut to them (Codex does),
      // the `it` that publishes a page cannot note it itself, and without it the conversation
      // could never be reopened.
      const previous = typeof body.was === 'string' && body.was && body.was !== id && body.was.length <= 200 ? { harness, id: body.was } : undefined
      const profile =
        readProfile(harness, body.profile) ??
        readProfile(harness, conversationProfile({ harness, id })) ??
        (previous ? readProfile(harness, conversationProfile(previous)) : undefined)
      if (typeof body.folder === 'string' && body.folder.length <= 4096 && path.isAbsolute(body.folder))
        void noteConversation({ harness, id }, body.folder, profile ?? null)
      else if (previous && !conversationProfile({ harness, id })) {
        const folder = conversationFolder(previous)
        if (folder && profile) void noteConversation({ harness, id }, folder, profile)
      }
      let changed = false
      // A conversation that is here under its own id is not somewhere else under another
      if (aliases.delete(key)) changed = true
      if (typeof body.was === 'string' && body.was && body.was !== id && body.was.length <= 200) {
        const was = keyOf(harness, body.was)
        // Whatever led to the old id leads straight to the new one, so no chain grows
        for (const [from, to] of aliases) if (to === was) aliases.set(from, key)
        aliases.set(was, key)
        // And whatever is kept here for the conversation under its old id is kept for it under
        // the new one: a click it was given and has not said it has, which it now asks for
        // by the new id and would not be given again until its hold ran out; and what a mark
        // put into it stands for
        for (const h of held.values()) if (h.key === was) h.key = key
        if (unmarked.delete(was)) unmarked.add(key)
        while (aliases.size > 500) aliases.delete(aliases.keys().next().value!)
        changed = true
      }
      // A turn has ended or a new one has begun: Codex now hands over what its queue held
      // behind the turn. Clear those copies after moving anything kept under the old id.
      if ((changed && typeof body.was === 'string') || (url.pathname === '/session' && typeof body.busy === 'boolean'))
        await recovery.session(
          key,
          typeof body.was === 'string' ? keyOf(harness, body.was) : undefined,
          url.pathname === '/session' && typeof body.busy === 'boolean',
        )
      if (changed && !over) writePrivate(aliasFile(), Object.fromEntries(aliases))
      if (blocked) {
        if (changed) watch()
        return [200, { ok: false, clicks: [], runtime }]
      }
      // An add-on that speaks is one its app lets run. Where the last look found it waiting for
      // the person's yes, as Codex has an add-on's hooks wait, that has been given since: the
      // machine is looked at again now, and not at the next half hour, until when `it status`
      // would go on saying that something is left for the person to do. Not more often than
      // every quarter of a minute, since a look runs every app's own command.
      if (found.some((h) => h.id === harness && h.addon === 'needs_approval') && Date.now() - lookedAgainAt > 15_000) {
        lookedAgainAt = Date.now()
        void lookAgain()
      }
      const s = sessions.get(key) ?? { seen: 0, busy: false, busyAt: 0 }
      const isNew = Date.now() - s.seen > KNOWN_MS
      s.seen = Date.now()
      if (typeof body.busy === 'boolean') {
        s.busy = body.busy
        s.busyAt = Date.now()
        // A turn has begun in a conversation that It is not reopening: the person is in it
        // themselves, and what they stopped is no longer its last turn. The note of the stop
        // is let go, where it would otherwise be told to the agent at some later reopening,
        // of a turn that by then was long over.
        if (body.busy && !reopenedNow.has(follow(key)) && [key, follow(key)].map((k) => stoppedByPerson.delete(k)).some(Boolean)) keepStopped()
      }
      sessions.set(key, s)
      if (isNew && (harness === 'codex' || harness === 'claude-code')) noteHeard(key)
      // The harness as It knows it, and never as whoever asked spelled it
      if (isNew) say(`${a(agentOf(harness))} conversation is listening (${short(id)})`)
      if (changed && typeof body.was === 'string') say(`${a(agentOf(harness))} conversation carries on under a new id (${short(body.was)} is now ${short(id)})`)
      if (isNew || changed) watch()
      // Heard from after a while: what was set aside for it, here and in It, is its to be given
      // again. Not where it is this machine's own reopening that is heard from: that is a try
      // like the ones before it, and forgetting them there would have it tried without end.
      if (isNew && !reopenedNow.has(follow(key))) revive(harness, id)
      if (url.pathname === '/session') return [200, { ok: true }]
      // A pass is started, and waited for only a moment: an add-on must have its answer at
      // once, whatever the backend is doing, and what was claimed meanwhile is there next time
      await Promise.race([route(), new Promise((r) => setTimeout(r, 300))])
      // The person may have disconnected the app while that pass was asking It. Whether the app
      // is connected is what counts at the moment a click is handed over, so it is looked at
      // again here: nothing is handed to it now, and what was claimed for it goes back.
      if (!chosen(harness)) return [200, { clicks: [] }]
      // Nor while this machine does not fit the It it joined, or once this connector is stopping: what it held is given back by then
      if (unfitting || closing) return [200, { clicks: [] }]
      // Whether each is still held is told by the clock that is never set back
      const at = steady()
      // A few at a time, oldest first, and never more than an add-on will read: the rest are
      // given on its next asking, a second later
      const mine: Held[] = []
      // Measured as it will be sent, in bytes: a click in another alphabet takes three bytes a letter
      let size = 20
      for (const h of [...held.values()].filter((h) => h.key === key && at < h.leaseUntil - 1000).sort((a, b) => a.click.at - b.click.at)) {
        size += Buffer.byteLength(JSON.stringify(asDelivered(h.click))) + 1
        if (mine.length >= SERVE_MOST || (mine.length > 0 && size > SERVE_BYTES)) break
        mine.push(h)
      }
      // Counted as given only if whoever asked is still there to be answered
      if (gone()) return [200, { clicks: [] }]
      // An add-on says it has a click by the receipt of the taking it was given it in. One from
      // before receipts asks without them, and is believed of a click by its id alone, of what
      // it was given in the taking that holds the click now: as it always was, for one release
      const receipts = url.searchParams.get('receipts') === '1'
      for (const h of mine) {
        if (!h.served) journal('served', h.click.id)
        h.served = true
        if (!receipts) h.legacy = true
      }
      return [200, { clicks: mine.map((h) => (receipts ? { ...asDelivered(h.click), receipt: h.attempt.receipt } : asDelivered(h.click))) }]
    }
    // The runs from before that are held, for `it runs`, and letting go of them at the person's word, for `it runs clear`
    if (url.pathname === '/runs') {
      if (req.method === 'POST' && body.clear === true) {
        // Only what the person was shown is let go of: a run that came to be held while they
        // were being asked is one they have not looked for. (A command from before this was
        // sent names none, and means all of them)
        const shown = Array.isArray(body.of) ? new Set(body.of.filter((k: unknown): k is string => typeof k === 'string')) : null
        const keys = [...unsettled.keys()].filter((key) => !shown || shown.has(key))
        const unreadToo = unread && (shown === null || body.unread === true)
        // Each is still owed the word that a turn of its was cut off, and that is written down
        // first: where it cannot be, nothing is let go of, and the person is told so
        for (const key of keys) {
          if (unsettled.get(key)?.stopped || stoppedByPerson.has(key)) rememberStopped(key)
          else cutOff.add(key)
        }
        keepCutOff()
        if ((keys.length && !cutOffKept) || keys.some((key) => pendingStops.has(key))) return [200, { cleared: 0, unkept: true }]
        const clearing = keys.map((key) => [key, unsettled.get(key)!] as const)
        for (const key of keys) unsettled.delete(key)
        try {
          if (keys.length) keepRuns(true)
        } catch {
          for (const [key, run] of clearing) unsettled.set(key, run)
          return [200, { cleared: 0, unkept: true }]
        }
        // What was set aside meanwhile is tried again: for each conversation that was held,
        // and where none was reopened at all, for every conversation this machine had given up on
        const back = new Set(keys)
        if (unreadToo) {
          // The note that could not be read is taken away first, and nothing is said to be let
          // go of where it cannot be: it is by that file that every reopening is refused
          try {
            rmSync(unreadRuns(), { force: true })
            // And where it could not be moved aside when it was found, it is still where the note of runs is written
            if (unreadWhereItWas) rmSync(runsFile(), { force: true })
          } catch {
            return [200, { cleared: 0, unkept: true }]
          }
          for (const tagged of [...parked, ...queueTries.keys()]) back.add(tagged.slice(tagged.indexOf('|') + 1))
          for (const { for: tried } of toPark.values()) if (tried) back.add(keyOf(tried.harness, tried.id))
          unread = false
          unreadWhereItWas = false
        }
        for (const [id, { for: tried }] of [...toPark]) if (tried && back.has(keyOf(tried.harness, tried.id))) toPark.delete(id)
        for (const key of back) revive(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1))
        keepRuns()
        const n = keys.length + (unreadToo ? 1 : 0)
        if (n) say(`${n} note${n === 1 ? '' : 's'} of a run from before ${n === 1 ? 'was' : 'were'} let go of at the person’s word`)
        void route()
        return [200, { cleared: n }]
      }
      return [
        200,
        {
          unread,
          held: [...unsettled].map(([key, run]) => ({
            key,
            agent: key.slice(0, key.indexOf(':')),
            conversation: key.slice(key.indexOf(':') + 1),
            pid: run.pid,
            since: run.since,
          })),
          running: [...running.keys()].map((key) => ({ agent: key.slice(0, key.indexOf(':')), conversation: key.slice(key.indexOf(':') + 1) })),
        },
      ]
    }
    if (req.method === 'POST' && url.pathname === '/waiting') {
      if (recovery.erased) return [200, { ok: true, clicks: [] }]
      await recovery
        .pruneWaiters(Date.now(), (key, restored) => (!restored || sessions.has(follow(key))) && !turnRunning(follow(key), Date.now()))
        .catch(cleanupFailed)
      const who = String(body.id ?? '')
      if (!who) return [400, { error: 'say who is waiting' }]
      // What the waiter says it has printed, of what was kept for a turn that waits, is let go of
      const got: string[] = Array.isArray(body.got) ? body.got.slice(0, 1000).filter((id: unknown): id is string => typeof id === 'string') : []
      await recovery.printed(who, got).catch(cleanupFailed)
      for (const id of got) {
        const sent = submitting.get(id)
        if (sent?.given?.who === who) sent.printed = true
      }
      if (body.done) {
        // Kept, as one that has ended: see `waiters`
        const ended = waiters.get(who)
        if (ended) ended.endedAt = Date.now()
      } else {
        const slug = typeof body.slug === 'string' ? body.slug : null
        // With no page named, the waiter says which conversation it is, and only that
        // conversation's clicks are left for it: everyone else's are delivered as usual. A
        // conversation that was cleared made its earlier pages under earlier ids; the waiter is
        // told the latest few, and waits for clicks on those pages too.
        const s = body.session as { harness?: unknown; id?: unknown } | undefined
        const session =
          slug === null && typeof s?.harness === 'string' && typeof s?.id === 'string' ? follow(keyOf(s.harness.slice(0, 40), s.id.slice(0, 200))) : null
        const watched = session
          ? [
              session,
              ...[...aliases]
                .filter(([, to]) => follow(to) === session)
                .map(([from]) => from)
                .slice(-5),
            ]
          : []
        const waiter = { slug, sessions: new Set(watched), seen: Date.now() }
        waiters.set(who, waiter)
        // A machine that does not fit the It it joined hands nothing over, to a waiter either, and nor does a connector that is stopping
        if (unfitting || closing) return [200, { ok: true, clicks: [] }]
        const handedBack: Offered[] = []
        // Only so much in one answer. Whoever asked reads no more than a megabyte, and an
        // answer larger than that was taken from here and read by nobody: thirty clicks that
        // each carry as much as a click may are enough. What does not fit stays as it is, and
        // is given at the waiter's next asking, two seconds on.
        let size = 0
        const fits = (c: Offered): boolean => {
          const bytes = Buffer.byteLength(JSON.stringify(c)) + 1
          if (handedBack.length > 0 && size + bytes > WAITER_BYTES) return false
          size += bytes
          return true
        }
        for (const [clickId, h] of held) {
          if (!waitedFor(waiter, h.click)) continue
          // What an add-on has been given and has not reported may be something it can only
          // hand over with a command's result, and the command now running is the waiter. So
          // the waiter is given it too, still held for this machine. Should the add-on hand it
          // over as well, the agent can tell by its id that it is the same click.
          const given = h.served && steady() < h.leaseUntil - 1000
          if (given && !fits(h.click)) continue
          held.delete(clickId)
          // With the receipt it is held by, which the waiter says it was handed over by
          if (given) handedBack.push({ ...h.click, receipt: h.attempt.receipt })
          // Anything set aside for an add-on and not yet given to it goes back, so the waiter
          // can have it. Not waited for: the waiter must have its answer at once.
          else void release(clickId, h.attempt).catch(() => {})
        }
        // A click that Codex's own command has been started with, and has not yet answered for,
        // cannot be taken back: Codex may have it already, and would hand it over only
        // after the turn that is now waiting. So the waiter is given it too, still held for
        // this machine. Should Codex hand it over as well, its id shows it is the same click.
        for (const sent of submitting.values()) {
          // Once: an agent that took it, dealt with it and waits again is not given it a second
          // time. Unless it never had it: the same waiter asking again with no word of it was
          // sent an answer that did not arrive
          if (sent.printed || (sent.toWaiter && sent.given?.who !== who) || !waitedFor(waiter, sent.click) || !fits(sent.click)) continue
          sent.toWaiter = true
          if (sent.given?.who !== who) sent.given = { who, at: Date.now() }
          handedBack.push(sent.click)
        }
        // And a click that Codex's queue has taken, and holds until the turn now running is
        // done: the waiter is that turn, so it is given the click too. Given once to a waiter
        // that says it has it. One that asks again and has not said so was sent an answer that
        // never arrived, and is given it again; and one that went quiet without saying so
        // leaves it for the next waiter of the turn.
        const now = Date.now()
        await recovery.giveWaiters(who, now, (b, clickId) => {
          // Asking again keeps a waiter's hold in memory; it does not rewrite the saved
          // receipt's timestamp. After a restart its original timestamp is the fallback.
          if (handedBack.some((c) => c.id === clickId)) return true
          const seen = b.given ? (waiters.get(b.given.who)?.seen ?? b.given.at) : 0
          if (!waitedFor(waiter, b.click) || (b.given && b.given.who !== who && now - seen <= GIVEN_MS) || !fits(b.click)) return false
          handedBack.push(b.click)
          return true
        })
        const sessions = watched.map((k) => ({ harness: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) }))
        return [200, { ok: true, ...(session ? { sessions } : {}), ...(handedBack.length ? { clicks: handedBack } : {}) }]
      }
      return [200, { ok: true }]
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      // The agent has it. It is never offered again from here, whatever happens to the report of that.
      // Only a click that was given out from here is taken as received, and only by the receipt
      // of the taking it was given out in. One that is held and not yet given to anyone was
      // claimed afresh, for a conversation that has not asked for it yet; and one given out
      // again, in a later taking, is not that later taking's to be said of by an earlier one.
      // Taking either would mark the click as handed to an agent that never saw it.
      const said: { id: string; receipt: string }[] | null = Array.isArray(body.receipts)
        ? body.receipts.filter((r: unknown): r is { id: string; receipt: string } => {
            const x = r as { id?: unknown; receipt?: unknown } | null
            return typeof x?.id === 'string' && typeof x.receipt === 'string'
          })
        : null
      const ids: string[] = [
        ...new Set<string>(
          said
            ? said.filter((r) => held.get(r.id)?.served === true && held.get(r.id)?.attempt.receipt === r.receipt).map((r) => r.id)
            : // An add-on from before receipts says it by the ids alone, and is believed of what it was given in this taking
              Array.isArray(body.ids)
              ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && held.get(x)?.served === true && held.get(x)?.legacy === true)
              : [],
        ),
      ]
      // An add-on that knows says whether the click started a turn or joined one that was
      // running. One that does not say is taken to have been heard at once.
      const woke = body.woke === true
      // One report is one turn, however many clicks it carried: counted as one waking
      if (woke && ids.length) record('agent.woken', { result: 'resumed', agent: agentOf(held.get(ids[0]!)!.click.session?.harness) })
      for (const clickId of ids) {
        const { click, attempt } = held.get(clickId)!
        counting.set(clickId, { at: click.at, harness: click.session?.harness, path: woke ? 'woke' : 'heard' })
        if (counting.size > 2000) counting.delete(counting.keys().next().value!)
        held.delete(clickId)
        toConfirm.set(clickId, { route: 'addon', receipt: attempt.receipt })
        journal('acked', clickId)
      }
      void confirmAll()
      return [200, { ok: true, acked: ids.length }]
    }
    return [404, { error: 'no such thing' }]
  }
  const server = http.createServer((req, res) => {
    // What is sent is kept as bytes and read as text once it is all here. It arrives in pieces
    // that can end in the middle of a character, and a piece read by itself would turn that
    // character into another: the text would then be neither what was sent nor what was sealed.
    const pieces: Buffer[] = []
    let size = 0
    let tooLarge = false
    // Whoever asked hung up before being answered
    let hungUp = false
    res.on('close', () => {
      if (!res.writableFinished) hungUp = true
    })
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) tooLarge = true
      else pieces.push(chunk)
    })
    req.on('end', () => {
      const sent = tooLarge ? null : textOfBytes(Buffer.concat(pieces))
      ;(tooLarge
        ? Promise.resolve<[number, unknown]>([413, { error: 'too large' }])
        : sent === null
          ? Promise.resolve<[number, unknown]>([400, { error: 'send text' }])
          : handle(req, sent, () => hungUp)
      )
        .catch((err): [number, unknown] => {
          // A fault of the connector's own, and the only trace of it: an add-on is told nothing more than "that did not work".
          // What was asked for is written as one of the connector's own words for it, and never as the caller wrote it
          const asked = `${req.method === 'GET' || req.method === 'POST' ? req.method : 'other'} ${routeOf(req.url)}`
          seldom(`fault:${asked}`, `a request to the connector failed (${asked}: ${why(err)})`)
          return [500, { error: 'that did not work' }]
        })
        .then(([status, body]) => {
          const text = JSON.stringify(body)
          // The answer is sealed with the token too, so whoever asked can tell it came from the
          // real connector and not from something else that took its port
          const nonce = String(req.headers['x-it-nonce'] ?? '')
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(status !== 401 && nonce ? { 'x-it-mac': mac(token, nonce, `${status}\n${text}`) } : {}),
          })
          res.end(text)
        })
    })
  })
  server.on('clientError', (_err, socket) => socket.destroy())

  // On systems that have them, a socket in It's own folder, which only this user can open: no
  // other user of the machine can take its place if this program stops. Elsewhere, a port on
  // this machine only, and the token.
  const info: ConnectorInfo = { token, pid: process.pid, version: VERSION, startedAt: Date.now() }
  // IT_CONNECTOR_PORT=1 is for testing the port route on a system that has sockets
  const useSocket = process.platform !== 'win32' && process.env.IT_CONNECTOR_PORT !== '1'
  // A socket's path can only be so long. Falling back to a port would give up what the socket
  // is for, so a folder too deep for one is refused instead.
  if (useSocket && Buffer.byteLength(socketFile()) > 100)
    throw new Problem(`${home()} is too long a path for the connector's socket.`, 'home_too_long', 'Set IT_HOME to a shorter one.')
  if (useSocket) {
    rmSync(socketFile(), { force: true })
    // Where the socket is, is where add-ons ask: only the holder of the lock may be found there
    if (!holdsLock()) throw lockLost()
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketFile(), resolve))
    chmodSync(socketFile(), 0o600)
    info.socket = socketFile()
  } else {
    if (!holdsLock()) throw lockLost()
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    info.port = (server.address() as { port: number }).port
  }
  // The note says to every add-on and command where the folder's connector is. One that has
  // come to be another's meanwhile is not written over: this one closes what it opened and stops
  if (!holdsLock()) {
    server.close()
    if (info.socket) rmSync(info.socket, { force: true })
    throw lockLost()
  }
  try {
    writePrivate(infoFile(), info)
  } catch (err) {
    // Where the note cannot be written, on a disk that is full say, nothing can find this
    // connector. What it opened is closed, so that the next try, half a minute on, does not
    // leave one more listener open behind it each time
    server.close()
    if (info.socket) rmSync(info.socket, { force: true })
    throw err
  }
  // Where it listens is said by kind: the socket's own address would name the person's home folder
  say(`connector ${VERSION} started (pid ${process.pid}); connector listening on ${info.socket ? 'its socket' : `127.0.0.1:${info.port}`}`)
  // Usage counts are sent from here, in the background, for every command on this machine.
  // Counting begins here where no command has begun it: an installation an agent made, where
  // no person ever ran a command, is counted like any other.
  begin()
  const usage = startSender()
  /** What is counted as this service starts, and once a day while it runs: that it runs, and what kind of machine this is. */
  const countMachine = () => {
    record('service.started', thisProgram())
    record('machine.seen', thisMachine(elsewhere() ? 'joined' : 'serves'))
  }
  countMachine()
  let countedAt = Date.now()
  /**
   * Counts the agent apps this machine was last found to have: which app, how its add-on
   * stands, the three numbers of its version, and whether its closed conversations are
   * reopened here. Once the machine has first been looked at, and once a day after.
   */
  const countApps = () => {
    for (const h of found)
      record('app.seen', {
        agent: agentOf(h.id),
        addon: h.addon,
        version: /^\d{1,4}\.\d{1,4}\.\d{1,4}/.exec(h.version ?? '')?.[0] ?? 'unknown',
        wake: wakesOn(process.platform) && wakesNow.has(h.id),
      })
  }

  // ---- what It says ----
  let notOurs = false
  /** It does not take this machine for one of the person's machines any more: it was revoked on the site, or everything It held was erased. Nothing more can be done from here, so the connector stops. */
  const notOursNow = () => {
    if (notOurs) return
    say("this machine is not one of It's machines any more; stopping")
    notOurs = true
    eraseDeliveryRecovery()
    stopping?.(0)
  }
  const client = live(
    notOursNow,
    // Waited out, and said: with no network, a busy backend or a clock that is wrong, nothing
    // else would show why no click arrives
    (err) => seldom('token', `could not get a token from It (${why(err)}); trying again`),
  )
  // Clicks are watched for the conversations that are here, and for harnesses with a queue of
  // their own, of the apps the person has connected. When who is here changes, or which apps are
  // connected, so does what is watched.
  let watching = ''
  let watchingScope = ''
  let watchGeneration = 0
  const inboxAfter = new Map<string, string>()
  let nextInbox: { harness: string; id: string }[] | null = null
  let saidTooMany = false
  let unwatch: (() => void) | null = null
  function watch(advance = false): void {
    const now = Date.now()
    // The conversations that are here, the one heard from most recently first
    const here = [...sessions]
      .filter(([k, s]) => chosen(k.slice(0, k.indexOf(':'))) && (now - s.seen < KNOWN_MS || (s.busy && now - s.busyAt < TURN_QUIET_MS)))
      .sort((a, b) => b[1].seen - a[1].seen)
      .map(([k]) => k)
    // A page made before a conversation was cleared is still recorded under its old id. Those
    // ids come after every conversation that is here, so they never take a live one's place.
    const before = [...aliases].filter(([from, to]) => here.includes(follow(to)) && !here.includes(from)).map(([from]) => from)
    const named = [...here, ...before.reverse()]
    if (named.length > LISTENING_MOST && !saidTooMany) {
      saidTooMany = true
      say(`more than ${LISTENING_MOST} conversations are open here; clicks for the ones heard from least recently wait until there is room`)
    }
    const listening = named
      .slice(0, LISTENING_MOST)
      // In a fixed order, so that the same set is not taken for a different one
      .sort()
      .map((k) => ({ harness: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) }))
    // A click is asked for an app's own queue only while that app is connected, and for a
    // conversation that is closed only where it may be reopened
    const scope = { listening, queues: [...new Set<string>([...QUEUES, ...WAKES.filter((h) => wakesNow.has(h))])].filter(connected) }
    const scopeKey = JSON.stringify(scope)
    // A changed listener set advances an answered page too. Frequent add-on updates cannot
    // restart discovery at the first names, and an unanswered subscription advances nothing.
    if (nextInbox && (advance || scopeKey !== watchingScope)) {
      for (const s of nextInbox) inboxAfter.set(s.harness, s.id)
      nextInbox = null
    }
    watchingScope = scopeKey
    const args = { ...scope, after: scope.queues.map((harness) => ({ harness, id: inboxAfter.get(harness) ?? '' })) }
    const next = JSON.stringify(args)
    if (next === watching) return
    watching = next
    const generation = ++watchGeneration
    unwatch?.()
    unwatch = client.onUpdate(
      api.delivery.inboxPage,
      args,
      (page: { clicks: Offered[]; after: { harness: string; id: string }[] }) => {
        // Ignore an answer already in flight when that subscription was replaced.
        if (watchGeneration !== generation) return
        const clicks = page.clicks
        nextInbox = page.after
        const here = performance.now()
        for (const click of clicks) {
          // A new owner gets its own window, including when the observation table is full.
          // Repeated offers to the same conversation keep their age. Old observations are
          // evicted even when another connector took the click and this one never confirmed it.
          const seen = hookSeen.get(click.id)
          const destination = tag(click)
          if (seen?.tag === destination) continue
          hookSeen.delete(click.id)
          hookSeen.set(click.id, { tag: destination, at: here })
          while (hookSeen.size > 5000) hookSeen.delete(hookSeen.keys().next().value!)
        }
        inbox = clicks
        for (const click of clicks) recoveredClicks.delete(click.id)
        void route()
      },
      (err) => say(`inbox: ${why(err)}`),
    )
  }
  watch()

  // A newer copy of this program has installed an add-on since this one started: the program
  // was brought up to date and this connector went on running. It stops, with a failure so
  // that whatever keeps it running starts it again, as the newer program.
  const makeWay = () => {
    if (!newerProgramSeen() || notOurs) return
    say('a newer It has been installed on this machine; stopping, to be started again as it')
    stopping?.(1)
  }
  // Nothing has been heard yet. The first answer is acted on whatever it says: an add-on
  // unticked while the connector was off is removed even if nothing is wanted any more.
  let wanted: string | null = null
  // The newest version of It there is, as this machine last learned it: asked every half hour while
  // that is not turned off, with a request that says nothing of this installation. Empty where
  // it is turned off, so that the site stops speaking of a version nobody is looking for.
  let latestKnown: string | undefined
  // Until when this machine reports only what the oldest It takes: an It that refused the
  // fuller report is given the plain one for a while, and then offered the fuller one again,
  // so that a refusal which was something else (a moment without a connection) does not
  // leave the machine saying less for as long as it runs
  let plainUntil = 0
  const lookForNewer = async () => {
    if (!looksForNewer()) latestKnown = ''
    else {
      const is = await latest().catch(() => null)
      if (is === null) return
      if (is !== latestKnown && newer(is, VERSION)) say(`It ${is} is out, and this is ${VERSION}; \`it upgrade\` puts it in place`)
      latestKnown = is
    }
    await report().catch(() => {})
  }
  // An upgrade the person asked for on the site: the newest program is fetched, checked and put
  // in place of this one, as `it upgrade` does it. Where the system starts It by itself, the new
  // program then writes the service's definition as its version has it and starts the service
  // again, which ends this one. Where a person started It by hand, they are told to do so again.
  let upgradingNow = false
  const upgradeAsked = async (version: string | undefined) => {
    if (upgradingNow) return
    upgradingNow = true
    try {
      await call('mutation', api.machines.upgrading, { state: 'working' }).catch(() => {})
      if (!version || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
        throw new Problem(
          'The update request names no valid release, so nothing was changed.',
          'upgrade_program',
          'Refresh the Machines page and request the update again.',
        )
      // Its sentences are a person's, and one of them names the folder the program is in: that one is said here without the folder
      const done = await fetchNewer({ expectedVersion: version, say: (line) => say(`upgrade: ${line.startsWith('Installed in ') ? 'installed' : line}`) })
      if (!done) return void (await call('mutation', api.machines.upgrading, { state: 'none' }).catch(() => {}))
      // Counted: from which version to which, asked for on the site
      record('upgrade.done', { from: three(done.from), to: three(done.to), by: 'site', result: 'ok' })
      // Not on Windows: there this connector runs inside the very task that starting again
      // stops, and what it starts may be ended with that task before it has started anything.
      // The new program is in place, and the person is told what starts It as it.
      if (service.restartsAfterUpgrade()) {
        say(`upgrade: starting again as ${done.to}`)
        // It is started again by the new program's own setup, which ends this connector on its
        // way. Where this connector is still here to see that setup end badly, or not start at
        // all, the person is told: left unsaid, the site went on saying it was updating.
        const setup = spawn(done.program, ['setup'], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true })
        const failed = (how: string) => {
          say(`upgrade: ${done.to} is in place, and It could not be started again as it (${how})`)
          void call('mutation', api.machines.upgrading, {
            state: 'failed',
            why: `It ${done.to} is in place on that machine, and It could not be started again as it. Run \`it setup\` there.`,
          }).catch(() => {})
        }
        setup.once('error', () => failed('its setup could not be run'))
        setup.once('exit', (code, signal) => {
          if (code !== 0) failed(`its setup ended with ${signal ?? code ?? 'an error'}`)
        })
        setup.unref()
      } else {
        say(`upgrade: ${done.to} is in place, and runs once It is started again`)
        await call('mutation', api.machines.upgrading, { state: 'installed', version: done.to }).catch(() => {})
      }
    } catch (err) {
      say(`upgrade: ${why(err)}`)
      // With what to do about it, where the problem says: on the site that is all the person is told
      const said = err instanceof Problem ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : 'It could not be upgraded.'
      await call('mutation', api.machines.upgrading, { state: 'failed', why: said }).catch(() => {})
    } finally {
      upgradingNow = false
    }
  }
  // What is installed on the machine is looked at when the connector starts, when what is
  // wanted changes, when an add-on that was found waiting for the person's yes speaks, and
  // every half hour: each look runs every harness's own command. The report in between says
  // the connector is alive, with what was found last time.
  found = await detectAll()
  countApps()
  watch()
  let lookedAt = Date.now()
  let looking = false
  const report = async (look = false) => {
    if ((look || Date.now() - lookedAt > 30 * 60_000) && !looking) {
      // One look at a time, and the time of it noted before it starts: a harness that is slow
      // to answer must not have look after look queued up behind it
      looking = true
      lookedAt = Date.now()
      try {
        // Every half hour what is installed is also made to match what is wanted again, in
        // case an install or a removal could not be finished the last time
        // Not once this machine has left: what `it logout` took out stays out
        if (!look && wantedNow && enrolledHere()) await reconcile(() => wantedNow ?? [], say, true).catch((err) => say(`add-ons: ${why(err)}`))
        makeWay()
        found = await detectAll()
        watch()
      } finally {
        looking = false
      }
    }
    // With the newest version this machine has learned of, where it looks for one and the It it
    // reports to takes that: one that is older than this program does not, and is told the rest
    const told = { connectorVersion: VERSION, harnesses: found.map((h) => ({ ...h, runtime: runtimes.status(h.id) })) }
    const legacy = { connectorVersion: VERSION, harnesses: found }
    // And with the system it runs on, which an It of the same age takes too
    const fuller = Date.now() >= plainUntil
    await call(
      'mutation',
      api.machines.report,
      fuller
        ? {
            ...told,
            system: process.platform,
            // Whether it hands nothing over for now, so that the site says so beside the machine and on its pages
            paused: unfitting ? (unfitting === NOT_ASKED ? 'unchecked' : 'unfit') : '',
            ...(latestKnown !== undefined ? { latest: latestKnown } : {}),
          }
        : legacy,
    )
      .catch(async (err) => {
        if (fuller && (err as { code?: string }).code !== 'unauthenticated') {
          plainUntil = Date.now() + 10 * 60_000
          await call('mutation', api.machines.report, legacy)
          return
        }
        throw err
      })
      .catch((err) => {
        // The bridge would give this machine no token, even a fresh one: it has been revoked.
        // Found out here within half a minute, where the live connection would take until its own
        // token ran out.
        if ((err as { code?: string }).code === 'unauthenticated') notOursNow()
        else say(`report: ${why(err)}`)
      })
  }
  lookAgain = () => report(true)
  client.onUpdate(
    api.machines.me,
    {},
    (me: {
      wanted: string[]
      wakes?: { harness: string; since: number }[]
      runs?: { harness: string; sessionId: string; stop?: boolean; run?: string }[]
      upgrade?: { state: string; version?: string } | null
    }) => {
      if (me.upgrade?.state === 'asked') void upgradeAsked(me.upgrade.version)
      // A conversation the person asked to have stopped is stopped. One that It has down as
      // running and that is not, which a connector that died leaves behind, is said to be over.
      for (const r of me.runs ?? []) {
        const key = follow(keyOf(r.harness, r.sessionId))
        const run = reopenedNow.get(key)
        // The stop is of the run It names. One heard late, of the run before, is not a stop of the one that has begun since
        if (run && r.stop && r.run === runNames.get(key)) {
          // That a person stopped it is written down as it is heard, and not when the app has
          // ended: this connector may itself be asked to stop in the seconds the app is given
          // to end in, and the turn would then be remembered as cut off, which it was not
          if (stoppedRun.size > 200) stoppedRun.delete(stoppedRun.keys().next().value!)
          if (r.run) stoppedRun.set(key, r.run)
          rememberStopped(key)
          run.abort()
        }
        // Named as It has it, so that only that run is taken away: one that began since stays
        if (!run) {
          // A run this connector found left from before it started, and ended, which a person
          // had stopped while no connector was there to hear: its conversation is told it was
          // stopped, which says to leave the work undone, and not that it was cut off
          if (r.stop) {
            rememberStopped(key)
            if (!pendingStops.has(key) && cutOff.delete(key)) keepCutOff()
          }
          pendingEnds.set(key, { for: { harness: r.harness, id: r.sessionId }, ...(r.run ? { run: r.run } : {}) })
        }
      }
      void finishRuns()
      // Read each time, whatever else changed or did not: it changes nothing that is installed
      const before = [...wakesNow.keys()].sort().join(',')
      wakesNow = new Map((me.wakes ?? []).map((w) => [w.harness, w.since]))
      if ([...wakesNow.keys()].sort().join(',') !== before) {
        watch()
        void route()
      }
      const next = [...me.wanted].sort().join(',')
      if (next === wanted) return
      wanted = next
      wantedNow = me.wanted
      restoreMarks()
      // What is watched and what is held follow at once, before anything is installed or taken out
      watch()
      void route()
      void reconcile(() => wantedNow ?? me.wanted, say, true)
        .catch((err) => say(`add-ons: ${why(err)}`))
        .then(() => report(true))
        .then(makeWay)
    },
    (err) => say(`settings: ${why(err)}`),
  )
  /**
   * Asks whether this machine and the It it joined fit, and acts on a change. Found not to
   * fit: said, with which of the two to update, and whatever this machine reopened is ended and
   * what it held given back. Found to fit again: said, and delivery goes on. Where the door
   * could not be asked, nothing changes: a machine that did not fit still does not.
   */
  async function fitsNow(): Promise<void> {
    const wrong = await unfit()
    if (wrong === undefined && unfitting === NOT_ASKED)
      seldom(
        'unasked',
        'the It this machine joined could not be asked which version it speaks, so nothing done on a page is handed to an agent here yet; it is asked again every minute',
      )
    if (wrong === undefined || closing) return
    if (wrong && unfitting !== wrong && (unfitting === null || unfitting === NOT_ASKED)) {
      unfitting = wrong
      say(
        `${wrong.message} ${wrong.hint ?? ''} This machine stays joined. Nothing done on a page is handed to an agent on it until then, and it is asked again every minute.`,
      )
      // What is running was started for an It that this program does not fit any more
      for (const [key, run] of reopenedNow) {
        // The note is the hand-over's whose run this is, which lets go of it when it is over
        const whose = handing.get(key)
        if (whose) lostHold.add(whose)
        run.abort()
      }
      // And what this machine holds for a conversation that is listening goes back, unless it was given already
      for (const [id, h] of held) {
        if (h.served) continue
        held.delete(id)
        journal('released', id)
        void release(id, h.attempt).catch(() => {})
      }
      // Said to It at once, so that the site says it beside the machine and on its pages: in
      // full, whatever plainer report this machine had fallen back on for a while
      plainUntil = 0
      void report()
    } else if (!wrong && unfitting) {
      const waited = unfitting !== NOT_ASKED
      unfitting = null
      if (waited) say('this machine and the It it joined fit again: what is done on a page is handed over again')
      plainUntil = 0
      void report()
      void route()
    }
  }
  // Asked once before anything is handed out, and then every minute
  await fitsNow()
  await report()
  const tick = setInterval(() => {
    void finishRuns()
    void route()
    watch(true)
  }, 1000)
  // Said this often and no less: the site takes a machine that has been quiet for a few of these to be off
  const alive = setInterval(() => void report(), ALIVE.everyMs)
  // Whether this machine still fits the It it joined is asked for as long as this runs: that
  // It may be updated under it, and so may this one. See `fitsNow`.
  const fits = setInterval(() => void fitsNow(), FITS_EVERY_MS)
  // Whether a newer It is out: asked a little after starting, and every half hour from then on
  const firstLook = setTimeout(() => void lookForNewer(), 20_000)
  const looks = setInterval(() => void lookForNewer(), LOOKS_EVERY_MS)
  const beat = setInterval(() => {
    const now = Date.now()
    for (const [k, s] of sessions) if (now - s.seen > 3_600_000) sessions.delete(k)
    for (const [k, w] of waiters) if (now - (w.endedAt ?? w.seen) > Math.max(60_000, WAIT_AGAIN_MS)) waiters.delete(k)
    // Another connector has the lock, which it could only take by finding no sign that this one lived: this one stops
    if (!holdsLock()) {
      say('another connector has taken over; stopping')
      stopping?.(0)
    }
    if (queueTries.size > 1000) queueTries.clear()
    // Anything still remembered about a click that has not stalled a line for an hour is forgotten
    for (const [id, at] of stalledAt) if (now - at > 3_600_000) stalledAt.delete(id)
    watch()
    // Once a day while it runs, so that an installation left running is still counted as in use
    if (now - countedAt > 86_400_000) {
      countedAt = now
      countMachine()
      countApps()
    }
  }, 60_000)

  // Whether this connector was asked to stop, which leaves its machine with none. One that
  // stops because another took over, or because its machine was revoked, leaves no such thing.
  let asked = false
  const code = await new Promise<number>((resolve) => {
    stopping = resolve
    // It may have been found out before this point was reached
    if (notOurs) resolve(0)
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      process.once(sig, () => {
        say(`stopping (${sig})`)
        asked = true
        resolve(0)
      })
  })
  clearInterval(tick)
  clearInterval(beat)
  clearInterval(alive)
  clearTimeout(firstLook)
  clearInterval(looks)
  clearInterval(fits)
  usage.stop()
  // The conversations this connector reopened are ended with it, and everything they had
  // started: nothing It runs with nobody watching runs on once It has been stopped. What each
  // was reopened for is given back, and is reopened for again when It next starts.
  closing = true
  for (const timer of markTimers) clearTimeout(timer)
  // Written down for the connector that starts next: each of these is given what it was
  // reopened for a second time, and must be told that its first turn at it was cut off
  // (Not the run a person has just stopped, which is ending for that reason and is noted as
  // stopped. That is told by the run's own name: the conversation may still be owed the word
  // that the run before this one was stopped, which says nothing of why this one is ending)
  for (const key of reopenedNow.keys()) if (stoppedRun.get(key) === undefined || stoppedRun.get(key) !== runNames.get(key)) cutOff.add(key)
  keepCutOff()
  for (const run of reopenedNow.values()) run.abort()
  // Held no more from this moment, before It is told so: an add-on that asks while the telling
  // is on its way is given nothing that is about to be somebody else's
  const givenBack = [...held].filter(([, h]) => !h.served)
  for (const [id] of givenBack) held.delete(id)
  // What is held goes back, and what was handed over is confirmed, all at once and for a few
  // seconds at most: whoever asked this program to stop will not wait long, and anything not
  // given back in that time goes back by itself when its lease runs out
  await Promise.race([
    Promise.allSettled([
      // And It is told that this machine is going, so that its pages say at once that they wait
      // for the machine, where they would otherwise say for minutes that a conversation was closed
      ...(asked ? [call('mutation', api.machines.stopping, {})] : []),
      ...givenBack.map(([id, h]) => release(id, h.attempt)),
      confirmAll(),
      ...queues.values(),
    ]),
    new Promise((r) => setTimeout(r, 5000)),
  ])
  server.close()
  await Promise.race([client.close(), new Promise((r) => setTimeout(r, 2000))])
  // Only what is still this program's own: another connector may have started meanwhile and
  // written its own file and socket in the same places
  if (readJson<ConnectorInfo>(infoFile())?.pid === process.pid) {
    rmSync(infoFile(), { force: true })
    if (info.socket) rmSync(info.socket, { force: true })
  }
  over = true
  await recovery.close()
  say('stopped')
  process.exitCode = code
}

/** The code that proves a message came from someone who knows the token, without the token being sent. */
export const mac = (token: string, nonce: string, what: string) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')
function macOk(token: string, nonce: string, what: string, given: string): boolean {
  if (!/^[0-9a-f]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given)) return false
  return timingSafeEqual(Buffer.from(mac(token, nonce, what)), Buffer.from(given))
}

/**
 * How `it hook` and `it wait` reach the connector on this machine. Null when it is not running.
 * The request is sent to the connector itself, on a connection of this program's own: over a
 * port, a runtime's own way of asking could be sent through a proxy named in the environment,
 * and what is asked and answered here is a person's clicks.
 */
export async function local<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T | null> {
  const info = readJson<ConnectorInfo>(infoFile())
  if (!info || typeof info.token !== 'string') return null
  const where =
    typeof info.socket === 'string'
      ? { path: info.socket }
      : Number.isInteger(info.port) && info.port! > 0 && info.port! < 65536
        ? { host: '127.0.0.1', port: info.port! }
        : null
  if (!where) return null
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  const method = init.method ?? 'GET'
  // Over the socket the token is shown. Over a port it never is: the request and the answer
  // are each sealed with it instead, so a program that took the port learns nothing and can
  // answer nothing that will be believed.
  const nonce = randomBytes(16).toString('hex')
  const proof: Record<string, string> =
    'path' in where ? { 'x-it-token': info.token } : { 'x-it-nonce': nonce, 'x-it-mac': mac(info.token, nonce, `${method}\n${path}\n${body ?? ''}`) }
  try {
    const answered = await ask(where, {
      method,
      path,
      headers: { ...proof, 'content-type': 'application/json' },
      body,
      // The whole exchange has this long, however slowly an answer trickles in, and an answer may
      // be only so large: over a port, whatever is answering may not be the connector at all
      signal: AbortSignal.timeout(init.timeoutMs ?? 1500),
      most: 1_000_000,
    })
    // Read as text once it is all there: its seal is over the text as it was sent
    const text = textOfBytes(answered.body)
    const genuine = text !== null && ('path' in where || macOk(info.token, nonce, `${answered.status}\n${text}`, answered.headers.get('x-it-mac') ?? ''))
    return answered.status === 200 && genuine ? ((parseJson(text) ?? null) as T | null) : null
  } catch {
    return null
  }
}
