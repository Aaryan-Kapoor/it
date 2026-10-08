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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ALIVE, briefClick, type Click, describeClick, LEASE_MS, LISTENING_MOST, newer, parseJson, QUEUES, WAKE_MOST, WAKES } from '@it/protocol'
import {
  api,
  ask,
  call,
  direct,
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
import { conversationFolder, noteConversation } from './publish'
import { alone } from './serve/backend'
import * as service from './service'
import { detectAll, type HarnessStatus, newerProgramSeen, reconcile } from './setup'
import { fetchNewer, LOOKS_EVERY_MS, latest, watching as looksForNewer } from './upgrade'
import { agentOf, record, startSender, thisProgram, timeBand } from './usage'
import { Budget, carrying, carryOn, claudeModeOf, claudeWroteAt, codexHeld, endTree, identity, mayWake, STOPPED, WAS_CUT_OFF, WAS_STOPPED, WOKEN } from './wake'

/** A click as the backend offers it: its data as JSON text, and the conversation it is for. */
interface Offered {
  id: string
  artifact: string
  title: string
  name: string
  payload: string
  at: number
  attended: boolean | null
  session: { harness: string; id: string } | null
  version?: number
  stateRevision?: number
  nowVersion?: number
  nowStateRevision?: number
}
/** A click as an add-on receives it: its data as a value, the one wording agents read, and the few words a person is shown where an app has another place for the rest. */
export interface Delivered extends Click {
  text: string
  brief: string
}
interface Held {
  click: Offered
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
const keyOf = (harness: string, id: string) => `${harness}:${id}`
/** Everything an add-on or a command asks the connector for. */
const ROUTES = ['/health', '/session', '/clicks', '/waiting', '/ack']
/** What was asked for, as it may be written down: one of the connector's own routes, or one fixed word for anything else. */
const routeOf = (asked: string | undefined): string => {
  const route = (asked ?? '').split('?')[0]!
  return ROUTES.includes(route) ? route : 'unknown_route'
}
export const infoFile = () => inHome('connector.json')
const socketFile = () => inHome('connector.sock')
const journalFile = () => inHome('journal.jsonl')
const aliasFile = () => inHome('aliases.json')
/** Where a connector that is stopping writes down which conversations it cut off in the middle of a turn. */
const cutOffFile = () => inHome('cut-off.json')
/** The conversations this connector has reopened and that are running now, each with the process that is it: read by the connector that starts next, if this one dies. */
const runsFile = () => inHome('runs.json')
/** Where the conversations whose last reopened turn a person stopped are kept until each has been told so. */
const stoppedFile = () => inHome('stopped.json')
/** A word with the article it takes: "an opencode conversation", "a codex conversation". */
const a = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
const lockFile = () => inHome('connector.lock')

function journal(event: string, id: string): void {
  try {
    if (existsSync(journalFile()) && statSync(journalFile()).size > 1_000_000)
      writeFileSync(journalFile(), readFileSync(journalFile(), 'utf8').split('\n').slice(-500).join('\n'))
    appendFileSync(journalFile(), `${JSON.stringify({ t: Date.now(), event, id })}\n`, { mode: 0o600 })
  } catch {}
}
/** Clicks the journal says a harness's queue accepted, but which were never confirmed to It. */
function queuedButUnconfirmed(): Set<string> {
  const out = new Set<string>()
  try {
    for (const line of readFileSync(journalFile(), 'utf8').split('\n')) {
      if (!line) continue
      const e = JSON.parse(line) as { event: string; id: string }
      // "queueing" is only the intent. If nothing follows it, the command may never have run,
      // so the click is sent again: a repeat can be told apart by its id, a loss cannot be undone.
      if (e.event === 'queued') out.add(e.id)
      if (e.event === 'confirmed') out.delete(e.id)
    }
  } catch {}
  return out
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

/** Null when Codex took the message. Otherwise why it did not, for the log: never what Codex printed, which may repeat the message. */
export function codexQueue(thread: string, text: string): Promise<string | null> {
  // A thread id is letters, digits and dashes. Anything else is not one, and is never put on a command line.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(thread)) return Promise.resolve('its conversation id is not one Codex would have made')
  const env = harnessEnv()
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
 * versions of the way machines talk to It, as that It says at its door. Nothing where they
 * speak the same, where this machine runs It itself, or where the door cannot be asked: not
 * knowing is not a reason to stop.
 */
async function unfit(): Promise<Problem | null> {
  const joinedAt = readJson<{ at?: unknown }>(inHome('machine.json'))?.at
  if (typeof joinedAt !== 'string') return null
  return direct(`${joinedAt}/cli/config`, { signal: AbortSignal.timeout(10_000) })
    .then(async (answer) => incompatible(((await answer.json()) as { protocol?: unknown } | null)?.protocol))
    .catch(() => null)
}
/** How often a machine that does not fit the It it joined asks again whether it does, and one that fits whether it still does. */
const FITS_EVERY_MS = 60_000

/** Everything the connector does once the folder's lock is its own. */
async function connecting(say: (line: string) => void): Promise<void> {
  // A machine that joined an It hands nothing to an agent, and asks nothing of that It, while
  // the two speak different versions of how machines talk to it: what one of them means by a
  // request is not what the other takes it for. It waits here, having said which of the two is
  // to be updated, and goes on by itself once they fit. `it status` sends the person to this log.
  for (let said = false; ; said = true) {
    const wrong = await unfit()
    if (!wrong) break
    if (!said)
      say(`${wrong.message} ${wrong.hint ?? ''} Nothing done on a page is handed to an agent on this machine until then. It is asked again every minute.`)
    await new Promise((r) => setTimeout(r, FITS_EVERY_MS))
  }
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
  const wakes = (harness: string, at: number) => mayWake(wakesNow, harness, at)

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
  const waiters = new Map<string, { slug: string | null; sessions: Set<string>; seen: number }>()
  const waitedFor = (w: { slug: string | null; sessions: Set<string> }, click: Offered) =>
    w.slug === null ? click.session !== null && w.sessions.has(keyOf(click.session.harness, click.session.id)) : w.slug === click.artifact
  const awaited = (click: Offered, now: number) => [...waiters.values()].some((w) => now - w.seen < WAIT_MS && waitedFor(w, click))
  const held = new Map<string, Held>()
  /** Handed to an agent, and not yet confirmed to It: confirmed again and again until it is. */
  const toConfirm = new Map<string, string>()
  /**
   * For usage reporting, which counts a delivery once It has confirmed it: when the click was
   * made, which harness it was for, and whether it joined a running turn or started one.
   */
  const counting = new Map<string, { at: number; harness: string | undefined; path: 'heard' | 'woke' }>()
  /** Given up on by this machine, and It has not yet been told to set it aside. Told again until it has. */
  const toPark = new Map<string, { for: { harness: string; id: string } | null; tag: string }>()
  /** Set aside, and It has confirmed it. Should one come back on offer, it is left alone. */
  const parked = new Set<string>()
  /** Being put in a harness's queue right now; how often that has been tried, and when last. */
  const queueing = new Set<string>()
  /**
   * Claimed, and given to the harness's own command, which has not yet said whether it took it.
   * An agent that begins to wait for such a click is given it as well (see `/waiting`), and
   * that is noted here, so that a refusal by the command is then no failure.
   */
  const submitting = new Map<string, { click: Offered; toWaiter: boolean }>()
  /**
   * Taken by Codex's queue while the conversation's turn was running. Codex hands such a click
   * over only when that turn is done, so an agent that begins to wait for it in the same turn
   * would wait for a message that stands behind its own turn. It is given the click as well
   * (see `/waiting`). Kept, by the conversation it is for, until the conversation is heard to
   * end the turn or begin another, which is when Codex itself hands the click over.
   */
  const behindTurn = new Map<string, { click: Offered; key: string }>()
  const turnRunning = (key: string, now: number) => {
    const s = sessions.get(key)
    if (!(s?.busy === true && now - s.busyAt < TURN_QUIET_MS)) return false
    // A Codex turn that was interrupted, or whose Codex was closed in the middle of it, ends
    // with no hook to say so. No Codex holds its conversation from then on, so no turn is
    // running there. Taken for running, each click of the next half hour was kept a minute
    // for a hook that could not come, while the page said the agent was busy.
    if (key.startsWith('codex:') && !codexHeld(threadOf(key))) {
      s.busy = false
      return false
    }
    return true
  }
  const queueTries = new Map<string, { n: number; at: number; reopening: boolean }>()
  /** One at a time for each conversation, oldest first, so that clicks arrive in the order they were made. */
  const queues = new Map<string, Promise<void>>()
  const unconfirmed = queuedButUnconfirmed()
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
    for (const [id, route] of toConfirm) {
      try {
        const done = await call<{ already: boolean } | null>('mutation', api.delivery.handedOff, { id, route })
        journal('confirmed', id)
        toConfirm.delete(id)
        const how = counting.get(id)
        counting.delete(id)
        // Counted once: not when It already had it down as handed over
        if (how && done && !done.already) record('answer.delivered', { path: how.path, after: timeBand(Date.now() - how.at), agent: agentOf(how.harness) })
      } catch (err) {
        // Another machine took it over, or it is gone: either way it is not this one's to confirm
        if (/conflict|not_found/.test(String((err as { code?: string }).code))) {
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
  const taken = (click: Offered) => held.has(click.id) || toConfirm.has(click.id) || queueing.has(click.id) || toPark.has(click.id) || parked.has(tag(click))
  /** Tells It to set aside the clicks this machine has given up on, until It has heard. */
  let parking = false
  async function parkAll(): Promise<void> {
    if (parking) return
    parking = true
    try {
      for (const [id, { for: tried, tag: which }] of toPark) {
        // The backend says whether it is set aside. While another machine holds the click it is
        // not, and it is asked about again. A conversation that took nothing in all its tries
        // has everything else that is waiting for it set aside with this click.
        const done = await call<boolean>('mutation', api.delivery.park, { id, ...(tried ? { for: tried, all: true } : {}) }).then(
          (set) => set !== false,
          (err) => {
            if (/not_found/.test(String((err as { code?: string }).code))) return true
            seldom('park', `could not tell It that click ${id} was set aside (${why(err)}); trying again`)
            return false
          },
        )
        if (!done) continue
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
    for (const one of new Set(ids))
      void call<number>('mutation', api.delivery.unpark, { for: { harness, id: one } })
        .then((given) => {
          if (given > 0)
            say(
              `${a(agentOf(harness))} conversation (${short(id)}) is back: ${given} thing${given === 1 ? '' : 's'} set aside for it ${given === 1 ? 'is' : 'are'} tried again`,
            )
        })
        .catch(() => {})
  }
  /** The conversations this machine has reopened and that are running now, each with the way to stop it. */
  const reopenedNow = new Map<string, AbortController>()
  /** Whether this connector is stopping: what it reopened is then ended with it, and is not taken for something a person stopped. */
  let closing = false
  /**
   * The conversations whose reopened turn was cut off when the connector before this one
   * stopped, as that connector wrote them down. Each is told so when it is reopened for the
   * same thing again, once.
   */
  const cutOff = new Set<string>(readJson<string[]>(cutOffFile()) ?? [])
  // Each is owed until its conversation has been told, which may be several starts of this
  // connector later: so the list is kept in its file for as long as anything is on it
  const keepCutOff = () => {
    try {
      while (cutOff.size > 200) cutOff.delete(cutOff.values().next().value!)
      if (cutOff.size) writePrivate(cutOffFile(), [...cutOff])
      else rmSync(cutOffFile(), { force: true })
    } catch {}
  }
  // A connector that died, where one that is stopped ends what it reopened, left its reopened
  // conversations running with nobody to stop them, and It offering the same click again
  // beside them. Each is ended now, with what it had started, before anything is handed out:
  // the process it was is known by its number and by when it began, so that no other process
  // that has since been given the number is touched. Its conversation is told, the next time
  // it is reopened, that its turn was cut off.
  const running = new Map<string, { pid: number; since: string }>()
  /**
   * The runs from before this connector started that could not be checked on, or could not be
   * ended: each is still noted, is looked at again when its conversation is next to be
   * reopened, and until it is known to be gone that conversation is reopened for nothing.
   */
  const unsettled = new Map<string, { pid: number; since: string }>()
  /** Writes down which runs there are. `must` is for a run that is about to be given something to do: not written down, it is not to run. */
  const keepRuns = (must = false) => {
    try {
      const all = { ...Object.fromEntries(unsettled), ...Object.fromEntries(running) }
      if (Object.keys(all).length) writePrivate(runsFile(), all)
      else rmSync(runsFile(), { force: true })
    } catch (err) {
      if (must) throw err
    }
  }
  /** Ends a run that was noted before this connector started. True once nothing of it is left. */
  const settleOld = async (key: string, was: { pid: number; since: string }): Promise<boolean> => {
    const became = await endTree(was.pid, was.since).catch(() => 'unknown' as const)
    if (became === 'unknown') return false
    unsettled.delete(key)
    if (became === 'ended') {
      cutOff.add(key)
      keepCutOff()
      say(
        `${a(key.slice(0, key.indexOf(':')))} conversation (${short(key)}) was still running from before this started, with nothing looking after it, and was ended`,
      )
    }
    return true
  }
  {
    let noted: unknown = {}
    if (existsSync(runsFile()))
      try {
        noted = JSON.parse(readFileSync(runsFile(), 'utf8'))
      } catch {
        // Not readable as what this program writes there. It is kept under another name, for
        // whoever looks into it, and said: what it named can be neither found nor ended from here
        const aside = `${runsFile()}.unreadable`
        try {
          renameSync(runsFile(), aside)
        } catch {}
        say(
          `the note of which conversations were running before this started could not be read, and is kept as ${aside}: anything it named is not looked after`,
        )
      }
    for (const [key, was] of Object.entries(noted && typeof noted === 'object' ? (noted as Record<string, { pid?: unknown; since?: unknown }>) : {})) {
      if (typeof was?.pid !== 'number' || typeof was.since !== 'string') continue
      const run = { pid: was.pid, since: was.since }
      unsettled.set(key, run)
      if (!(await settleOld(key, run)))
        say(
          `${a(key.slice(0, key.indexOf(':')))} conversation (${short(key)}) may still be running from before this started, and could not be checked on or ended: it is reopened for nothing until it can be`,
        )
    }
    keepRuns()
  }
  /**
   * The conversations whose reopened turn is being ended because this machine's hold on what
   * they were reopened for was lost: It was out of reach for as long as a hold lasts, and may
   * have given the click to another machine by now. A run that went on would act on it a
   * second time beside whoever has it.
   */
  const lostHold = new Set<string>()
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
  /**
   * The conversations whose last reopened turn the person stopped from the page. An app that is
   * ended in the middle of a turn writes nothing of that into the conversation, so the agent
   * that is next reopened there would read a turn that simply breaks off, and might carry on
   * with it. It is told once, with what it is next reopened for. That may be after this
   * connector has been started again, so the list is kept in a file: forgotten with a restart,
   * the next reopening told the agent nothing, and it did what the person had stopped.
   */
  const stoppedByPerson = new Set<string>(readJson<string[]>(stoppedFile()) ?? [])
  const keepStopped = () => {
    try {
      if (stoppedByPerson.size) writePrivate(stoppedFile(), [...stoppedByPerson])
      else rmSync(stoppedFile(), { force: true })
    } catch {}
  }
  /** The last line a reopened app printed where it ended badly, by conversation, until its next reopening. */
  const saidLast = new Map<string, string>()
  // What a reopened app printed is kept in a file only while it runs. One that was left by a
  // connector that was ended in the middle of a run goes now.
  try {
    for (const name of readdirSync(inHome('logs'))) if (/^reopened-\d+-\d+\.txt$/.test(name)) rmSync(inHome('logs', name), { force: true })
  } catch {}
  async function carry(session: { harness: string; id: string }, text: string): Promise<string | null> {
    const key = follow(keyOf(session.harness, session.id))
    // A conversation that was cleared carries on under another id, and it is that one which is carried on
    const now = { harness: session.harness, id: key.slice(key.indexOf(':') + 1) }
    const cwd = conversationFolder(now) ?? conversationFolder(session)
    if (!cwd) return 'the folder its conversation was held in is not known on this machine, or is gone'
    // With what the person's shell gives a program, where this is the background service: an
    // app that takes its key from there cannot be reopened without it
    await shellLearned()
    const env = harnessEnv()
    const how = carrying(now.harness, now.id, text, {
      codex: codexCommand(process.platform, env.PATH ?? env.Path ?? '', existsSync),
      itHome: home(),
      // The mode the person last had the conversation in, and where `it` is installed
      mode: now.harness === 'claude-code' ? (claudeModeOf(now.id, cwd) ?? claudeModeOf(session.id, cwd)) : null,
      itAt: [
        ...new Set([path.join(home(), 'bin', process.platform === 'win32' ? 'it.exe' : 'it'), process.execPath].filter((p) => /[\\/]it(\.exe)?$/.test(p))),
      ],
    })
    if (typeof how === 'string') return how
    if (reopenedNow.has(key)) return 'it is being reopened already'
    // This connector is stopping: nothing is started that it would not be there to end
    if (closing) return STOPPED
    // A run of it from before this connector started may still be there
    const before = unsettled.get(key)
    if (before && !(await settleOld(key, before).finally(() => keepRuns())))
      return 'a turn of it from before It was last started may still be running, and could not be checked on or ended'
    if (closing) return STOPPED
    const stop = new AbortController()
    reopenedNow.set(key, stop)
    await call('mutation', api.machines.runBegan, { for: session }).catch(() => {})
    let ended: string | null = 'it did not end'
    try {
      saidLast.delete(key)
      ended = await carryOn(
        how,
        cwd,
        { harness: now.harness, session: now.id },
        {
          signal: stop.signal,
          keepIn: inHome('logs'),
          said: (words) => saidLast.set(key, words),
          // Written down before it is given anything to do, or it is not to run: see `carryOn`
          began: (pid) => {
            const since = identity([pid]).get(pid)
            if (since === undefined) throw new Error('which process it is could not be told')
            running.set(key, { pid, since })
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
      else if (ended !== STOPPED) shellMayHaveChanged()
      // Ended because its hold on what it was reopened for was lost: nobody stopped it. Its
      // conversation is told, if it is reopened for the same thing again, that its turn was cut off.
      if (ended === STOPPED && lostHold.has(key)) {
        cutOff.add(key)
        keepCutOff()
      }
      // Stopped by the person, and not by this connector closing: its next turn is told so
      if (ended === STOPPED && !closing && !lostHold.has(key)) {
        if (stoppedByPerson.size > 200) stoppedByPerson.delete(stoppedByPerson.values().next().value!)
        stoppedByPerson.add(key)
        keepStopped()
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
        void call('mutation', api.delivery.release, { id })
          .catch(() => {})
          .then(() => route())
      }
      // That it ran, or was stopped, takes back anything said earlier of why it could not be reopened
      await call('mutation', api.machines.runEnded, { for: session, ...(ended === null || ended === STOPPED ? { ok: true } : {}) }).catch(() => {})
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
  const someoneThere = (click: Offered) =>
    click.attended !== false ||
    inbox.some((c) => c.id !== click.id && c.attended !== false && c.session?.harness === click.session?.harness && c.session?.id === click.session?.id)
  /** Whether a conversation that is not listening is at work all the same, in a window It cannot see into: Claude Code wrote of it a moment ago. */
  const atWork = (session: { harness: string; id: string }, now: number) => {
    if (session.harness !== 'claude-code') return false
    const cwd = conversationFolder(session)
    const wrote = cwd ? claudeWroteAt(session.id, cwd) : null
    if (wrote === null || now - wrote >= CLAUDE_QUIET_MS) return false
    // What this machine's own reopening of it wrote is not somebody at work in it
    const ours = ranUntil.get(follow(keyOf(session.harness, session.id)))
    return ours === undefined || wrote > ours + 3000
  }
  /** The id Codex knows a conversation by now: the one it carries on under, if it was cleared. */
  const threadOf = (key: string) => key.slice(key.indexOf(':') + 1)
  async function queueNow(click: Offered, reopening: boolean): Promise<void> {
    let keeping: ReturnType<typeof setInterval> | undefined
    /** This hand-over is finished: what its renewals are answered from now on is about nothing that is running. */
    let over = false
    const line = click.session!.id
    const harness = click.session!.harness
    // What the route is called where it is written down: Codex's own queue, or the reopening of a conversation that was closed
    const route = reopening ? 'the reopening of its conversation' : 'Codex’s queue'
    const key = follow(keyOf(harness, line))
    /** The other clicks waiting for the same conversation, which go with this one in the same message. */
    let withIt: Offered[] = []
    const giveBack = async () => {
      for (const c of withIt) {
        journal('released', c.id)
        await call('mutation', api.delivery.release, { id: c.id }).catch(() => {})
      }
      withIt = []
    }
    try {
      // This connector is stopping: what stood in line behind a run it has just ended is left for the connector that starts next
      if (closing) return
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
      if (reopening && (!wakes(harness, click.at) || !room(key, someoneThere(click)))) return
      // Codex's queue is for a conversation some Codex has open. One that was closed while this
      // click stood in line is not given it: the click is looked at afresh on the next pass.
      if (!reopening && !codexHeld(threadOf(key))) return
      // Only if it is still for this conversation on this machine: the page may have changed
      // hands while the click stood in line here
      const [got] = await call<string[]>('mutation', api.delivery.claim, { ids: [click.id], for: click.session! })
      if (!got) return
      // And looked at once more, now that the claim is answered: a waiter that began while it
      // was being asked for cannot take what this machine holds, so it is given back to it. It
      // is given back as well when Codex was disconnected in that time.
      if (closing || awaited(click, Date.now()) || !connected(harness) || (reopening && !wakes(harness, click.at))) {
        journal('released', click.id)
        await call('mutation', api.delivery.release, { id: click.id }).catch(() => {})
        return
      }
      if (reopening) {
        // Everything else that is waiting for the conversation goes with it, in the one
        // message: a conversation reopened for five clicks is reopened once, and reads all five
        const more = inbox
          .filter(
            (c) =>
              c.id !== click.id &&
              c.session?.harness === harness &&
              c.session.id === line &&
              !held.has(c.id) &&
              !toConfirm.has(c.id) &&
              !toPark.has(c.id) &&
              !parked.has(tag(c)) &&
              !rode.has(c.id) &&
              wakes(harness, c.at) &&
              !awaited(c, Date.now()),
          )
          .sort((a, b) => a.at - b.at)
          .slice(0, WAKE_MOST - 1)
        if (more.length) {
          const got = await call<string[]>('mutation', api.delivery.claim, { ids: more.map((c) => c.id), for: click.session! }).catch(() => [] as string[])
          withIt = more.filter((c) => got.includes(c.id))
        }
        room(
          key,
          [click, ...withIt].some((c) => c.attended !== false),
          true,
        )
      }
      // The command can take as long as a lease lasts, so the lease is kept up while it runs.
      // Only a renewal the backend confirmed keeps it. Told that a click of this hand-over is
      // somebody else's to deliver by now, or told nothing for as long as a hold lasts, a
      // conversation that was reopened for it is ended. A click that is no longer held because
      // it is done with (its agent said so with `it ack`, or it was dropped) is no loss: it
      // is renewed no more, and the run goes on with the rest.
      let heldUntil = Date.now() + LEASE_MS
      const keptUp = new Set([click.id, ...withIt.map((c) => c.id)])
      keeping = setInterval(() => {
        const asked = Date.now()
        const ids = [...keptUp]
        if (!ids.length) return
        void call<string[]>('mutation', api.delivery.renew, { ids })
          .then(async (kept) => {
            const not = ids.filter((id) => !kept.includes(id))
            // An It from before this could be asked says nothing: what is not held is then taken for lost, as it was
            const lost = not.length
              ? await call<string[]>('query', api.delivery.lost, { ids: not }).then(
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
            if (!said && Date.now() <= heldUntil) return
            if (!reopening || closing || lostHold.has(key)) return
            const run = reopenedNow.get(follow(key))
            if (!run) return
            lostHold.add(key)
            say(
              `${a(harness)} conversation (${short(line)}) is ended: this machine’s hold on what it was reopened for was lost, and that may be with another machine by now`,
            )
            run.abort()
          })
      }, RENEW_MS)
      journal('queueing', click.id)
      /** Whether this turn is told that the one before it was cut off: decided before it begins, since its own ending may make such a note anew. */
      const toldCutOff = cutOff.has(key)
      const sent = { click, toWaiter: false }
      submitting.set(click.id, sent)
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
          ).then((ended) => {
            // Told, where the conversation was in fact reopened: one that could not be is told the next time
            if (ended === null || ended === STOPPED) {
              // The note it was given is used up. A turn that was itself cut off, by a hold
              // that was lost or by this connector stopping, is owed the note again
              if (toldCutOff && !(ended === STOPPED && (lostHold.has(key) || closing))) {
                cutOff.delete(key)
                keepCutOff()
              }
              // Stopped again, it is owed the note again, which the stopping itself has written down
              if (ended === null && stoppedByPerson.delete(key)) keepStopped()
            }
            return ended
          })
        : await codexQueue(threadOf(key), describeClick(asClick(click), 0))
      // A conversation the person stopped had what was done all the same: it is handed over,
      // and nothing is tried again for it
      // Ended because this connector is stopping, it is given back, to be reopened for by the
      // connector that starts next: nobody stopped it, and nothing is counted against it
      if (refused === STOPPED && closing) {
        await giveBack()
        journal('released', click.id)
        await call('mutation', api.delivery.release, { id: click.id }).catch(() => {})
        return
      }
      // Ended because the hold on it was lost: it is not this machine's to hand over or to give
      // back, and nothing is counted against the conversation. Whatever else was held with it goes back.
      if (refused === STOPPED && lostHold.delete(key)) {
        await giveBack()
        journal('lost', click.id)
        // It may be a click that went with this one that was lost, and this one still held
        // here: given back, it is reopened for again, with the note that its turn was cut
        // off. Where it is not this machine's, the giving back does nothing.
        await call('mutation', api.delivery.release, { id: click.id }).catch(() => {})
        return
      }
      const handed = refused === null || refused === STOPPED
      if (!handed) await giveBack()
      // Refused by the command, and given meanwhile to an agent that is waiting for it: the
      // waiter has it and says so to It itself, so there is nothing to try again or set aside
      if (!handed && sent.toWaiter) return
      if (handed) {
        if (refused === STOPPED) say(`${a(harness)} conversation (${short(line)}) was stopped by the person`)
        for (const c of [click, ...withIt]) {
          journal('queued', c.id)
          toConfirm.set(c.id, 'queue')
          // The queue, or the reopening, starts a turn in a conversation that was not working
          counting.set(c.id, { at: c.at, harness, path: 'woke' })
          if (c !== click) {
            if (rode.size > 500) rode.delete(rode.values().next().value!)
            rode.add(c.id)
          }
        }
        record('agent.woken', { result: 'resumed', agent: agentOf(harness) })
        if (stalled.get(line) === click.id) stalled.delete(line)
        // Only Codex's queue hands a click over behind a turn that is running
        if (!reopening && !sent.toWaiter && turnRunning(key, Date.now())) {
          behindTurn.set(click.id, { click, key })
          if (behindTurn.size > 200) behindTurn.delete(behindTurn.keys().next().value!)
        }
        await confirmAll()
      } else {
        const n = (queueTries.get(tag(click))?.n ?? 0) + 1
        queueTries.set(tag(click), { n, at: Date.now(), reopening })
        stalled.set(line, click.id)
        stalledAt.set(click.id, Date.now())
        record('agent.woken', { result: n >= QUEUE_WAITS.length ? 'failed' : 'declined', agent: agentOf(harness) })
        if (reopening) notReopened(click.session!, refused)
        if (n >= QUEUE_WAITS.length) {
          stalled.delete(line)
          // Given up on from here. It is set aside so that it does not hide clicks that can be
          // delivered; it is still waiting, and the person and `it wait` still see it.
          say(`click ${click.id} was not taken by ${route} after ${n} tries (${refused}); it stays waiting`)
          toPark.set(click.id, { for: click.session, tag: tag(click) })
          await parkAll()
        } else {
          say(`click ${click.id} was not taken by ${route} (${refused}); try ${n} of ${QUEUE_WAITS.length}`)
          await call('mutation', api.delivery.release, { id: click.id }).catch(() => {})
        }
      }
    } catch (err) {
      say(`queue: click ${click.id}: ${why(err)}`)
      await giveBack()
    } finally {
      over = true
      clearInterval(keeping)
      submitting.delete(click.id)
      queueing.delete(click.id)
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
  function queue(click: Offered, reopening: boolean): boolean {
    if (closing) return false
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
    queueing.add(click.id)
    const key = click.session!.id
    const next = (queues.get(key) ?? Promise.resolve()).then(() => (reopening ? withRunSlot : withSlot)(() => queueNow(click, reopening)))
    queues.set(key, next)
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
    return true
  }

  /** Looks at what is waiting again in a moment, and not only at the next second: what is reopened at once is not kept waiting for the clock. */
  let sooner: ReturnType<typeof setTimeout> | undefined
  const soon = (ms: number) => {
    if (sooner) return
    sooner = setTimeout(() => {
      sooner = undefined
      void route()
    }, ms)
    sooner.unref?.()
  }
  async function route(): Promise<void> {
    if (routing || closing) return
    routing = true
    try {
      const now = Date.now()
      // Telling It what was handed over is done beside this, never ahead of it: a slow answer
      // there must not hold up renewing leases or taking new clicks
      void confirmAll()
      void parkAll()
      // A held click stays held while something will come for it: an add-on that is asking, or
      // a Codex turn that is still running and will reach a hook. Otherwise it goes back, so
      // another route can have it.
      /** Gives back a click that is held for an app the person has since disconnected: it is given to nothing there. Whether it was. */
      const disconnected = async (id: string, h: Held): Promise<boolean> => {
        if (!h.click.session || chosen(h.click.session.harness)) return false
        held.delete(id)
        journal('released', id)
        say(`click ${id} was kept for an agent app that is not connected any more; it goes back to waiting`)
        await call('mutation', api.delivery.release, { id }).catch(() => {})
        return true
      }
      for (const [id, h] of held) {
        if (await disconnected(id, h)) continue
        const s = sessions.get(h.key)
        const listening = !h.forHook && s !== undefined && now - s.seen < LIVE_MS
        const hookComing = h.forHook && turnRunning(h.key, now) && now - h.claimedAt < HOOK_HOLD_MS
        if (listening || hookComing) {
          if (now < h.leaseUntil - LEASE_MS + RENEW_MS) continue
          // Only a renewal the backend confirmed extends the lease. Past it the click may be
          // someone else's, so serving it from here stops.
          // Counted from before the request went out: the backend's clock started no later than that
          const asked = Date.now()
          const kept = await call<string[]>('mutation', api.delivery.renew, { ids: [id] }).catch(() => null)
          // While that was being asked, the click may have been handed over or given to a waiting
          // agent: it is not held here then, and nothing about it is lost
          if (held.get(id) !== h) continue
          // Or the person may have disconnected its app, and then it is not kept a moment longer
          if (await disconnected(id, h)) continue
          if (kept?.includes(id)) h.leaseUntil = asked + LEASE_MS
          else if (kept !== null || now > h.leaseUntil - 2000) {
            held.delete(id)
            journal('lost', id)
            say(
              `click ${id} is not this machine's to deliver any more (${kept === null ? 'It could not be reached to keep it' : 'It gave it to another'}); it goes back to waiting`,
            )
          }
        } else if (now - h.claimedAt > HOLD_MS && !h.served) {
          held.delete(id)
          journal('released', id)
          say(`click ${id} was kept for ${h.forHook ? 'a Codex turn that ended without taking it' : 'an add-on that stopped asking'}; it goes back to waiting`)
          await call('mutation', api.delivery.release, { id }).catch(() => {})
        } else if (now > h.leaseUntil - 2000) {
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
      for (const click of [...inbox].sort((a, b) => a.at - b.at)) {
        if (taken(click)) continue
        if (unconfirmed.has(click.id)) {
          // Its harness's queue took it before a restart; all that was missing was telling It
          unconfirmed.delete(click.id)
          toConfirm.set(click.id, 'queue')
          continue
        }
        if (!click.session || awaited(click, now)) continue
        // A click for an app that is not connected is left where it is, for the person and `it wait`
        if (!chosen(click.session.harness)) continue
        const key = follow(keyOf(click.session.harness, click.session.id))
        if (waitingBehind.has(key)) continue
        const s = sessions.get(key)
        const codex = click.session.harness === 'codex'
        // An add-on that asks every second is listening. Codex's hooks only run at moments in a
        // turn, so having heard from one says nothing about the next.
        const listening = !codex && s !== undefined && now - s.seen < LIVE_MS
        // A Codex turn that is running will reach a hook: after its next command, or when it stops
        const inTurn = codex && turnRunning(key, now)
        if (listening || (inTurn && now - click.at < FRESH_MS)) {
          // Route 1: the add-on will ask for it, or the running turn's next hook will
          const asked = Date.now()
          const [got] = await call<string[]>('mutation', api.delivery.claim, { ids: [click.id], for: click.session })
          // An agent may have begun to wait for it while the claim was being asked for. A waiter
          // cannot take what this machine holds, so the click is given back for it to take. It
          // is given back as well when the person disconnected its app in that time.
          if (got && (awaited(click, Date.now()) || !chosen(click.session.harness))) {
            journal('released', click.id)
            await call('mutation', api.delivery.release, { id: click.id }).catch(() => {})
          } else if (got) {
            held.set(click.id, { click, key, claimedAt: now, leaseUntil: asked + LEASE_MS, forHook: inTurn, served: false })
            journal('claimed', click.id)
          }
        } else if (codex && connected('codex') && !reopenedNow.has(key) && codexHeld(threadOf(key))) {
          // Route 2: some Codex has the conversation open, and takes a message from Codex's own
          // queue by itself: at once when it is idle, after its turn when it is not. Not waited
          // for here: one slow command must not hold up every other click. A conversation this
          // machine is itself running is not given one that way: that run ends with its turn,
          // and would cut off whatever Codex began for the message.
          if (!queue(click, false)) waitingBehind.add(key)
        } else if (wakes(click.session.harness, click.at) && connected(click.session.harness)) {
          // Route 3: the conversation is not listening, which is to say closed, and the person
          // has switched on reopening for its agent app on this machine. It is reopened at once,
          // but for the moment that lets a few things done together go together. It is run in
          // line like a queue, one click of a conversation at a time. And only so often: past
          // that the click waits, and goes with the next reopening. Nor while it is at work in a
          // window It cannot see into: it is looked at again once it is quiet.
          if (now - click.at < SETTLE_MS) {
            waitingBehind.add(key)
            soon(SETTLE_MS - (now - click.at) + 10)
          } else if (atWork(click.session, now) || !room(key, someoneThere(click)) || !queue(click, true)) waitingBehind.add(key)
        }
        // Route 4: nothing to do. The click stays waiting and the site shows it.
      }
    } catch (err) {
      say(`delivery: ${why(err)}`)
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
      const key = keyOf(harness, id)
      // An add-on that can see which folder its conversation is held in says so, and it is noted
      // here: where the app runs the agent's commands with It's folder shut to them (Codex does),
      // the `it` that publishes a page cannot note it itself, and without it the conversation
      // could never be reopened.
      if (typeof body.folder === 'string' && body.folder.length <= 4096 && path.isAbsolute(body.folder)) noteConversation({ harness, id }, body.folder)
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
        // A turn has ended or a new one has begun: what Codex's queue held behind the turn is
        // now handed over by Codex itself, and is not a waiter's to be given
        if (url.pathname === '/session') for (const [clickId, b] of behindTurn) if (b.key === follow(key)) behindTurn.delete(clickId)
      }
      sessions.set(key, s)
      let changed = false
      // A conversation that is here under its own id is not somewhere else under another
      if (aliases.delete(key)) changed = true
      if (typeof body.was === 'string' && body.was && body.was !== id && body.was.length <= 200) {
        const was = keyOf(harness, body.was)
        // Whatever led to the old id leads straight to the new one, so no chain grows
        for (const [from, to] of aliases) if (to === was) aliases.set(from, key)
        aliases.set(was, key)
        while (aliases.size > 500) aliases.delete(aliases.keys().next().value!)
        changed = true
      }
      if (changed) writePrivate(aliasFile(), Object.fromEntries(aliases))
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
      const now = Date.now()
      // A few at a time, oldest first, and never more than an add-on will read: the rest are
      // given on its next asking, a second later
      const mine: Held[] = []
      // Measured as it will be sent, in bytes: a click in another alphabet takes three bytes a letter
      let size = 20
      for (const h of [...held.values()].filter((h) => h.key === key && now < h.leaseUntil - 1000).sort((a, b) => a.click.at - b.click.at)) {
        size += Buffer.byteLength(JSON.stringify(asDelivered(h.click))) + 1
        if (mine.length >= SERVE_MOST || (mine.length > 0 && size > SERVE_BYTES)) break
        mine.push(h)
      }
      // Counted as given only if whoever asked is still there to be answered
      if (gone()) return [200, { clicks: [] }]
      for (const h of mine) {
        if (!h.served) journal('served', h.click.id)
        h.served = true
      }
      return [200, { clicks: mine.map((h) => asDelivered(h.click)) }]
    }
    if (req.method === 'POST' && url.pathname === '/waiting') {
      const who = String(body.id ?? '')
      if (!who) return [400, { error: 'say who is waiting' }]
      if (body.done) waiters.delete(who)
      else {
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
        const handedBack: Offered[] = []
        for (const [clickId, h] of held) {
          if (!waitedFor(waiter, h.click)) continue
          held.delete(clickId)
          // What an add-on has been given and has not reported may be something it can only
          // hand over with a command's result, and the command now running is the waiter. So
          // the waiter is given it too, still held for this machine. Should the add-on hand it
          // over as well, the agent can tell by its id that it is the same click.
          if (h.served && Date.now() < h.leaseUntil - 1000) handedBack.push(h.click)
          // Anything set aside for an add-on and not yet given to it goes back, so the waiter
          // can have it. Not waited for: the waiter must have its answer at once.
          else void call('mutation', api.delivery.release, { id: clickId }).catch(() => {})
        }
        // A click that Codex's own command has been started with, and has not yet answered for,
        // cannot be taken back: Codex may have it already, and would hand it over only
        // after the turn that is now waiting. So the waiter is given it too, still held for
        // this machine. Should Codex hand it over as well, its id shows it is the same click.
        for (const sent of submitting.values()) {
          if (!waitedFor(waiter, sent.click)) continue
          sent.toWaiter = true
          handedBack.push(sent.click)
        }
        // And a click that Codex's queue has taken, and holds until the turn now running is
        // done: the waiter is that turn, so it is given the click too, and given it once
        for (const [clickId, b] of behindTurn) {
          if (!turnRunning(b.key, Date.now())) behindTurn.delete(clickId)
          else if (waitedFor(waiter, b.click)) {
            behindTurn.delete(clickId)
            handedBack.push(b.click)
          }
        }
        const sessions = watched.map((k) => ({ harness: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) }))
        return [200, { ok: true, ...(session ? { sessions } : {}), ...(handedBack.length ? { clicks: handedBack } : {}) }]
      }
      return [200, { ok: true }]
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      // The agent has it. It is never offered again from here, whatever happens to the report of that.
      // Only a click that was given out from here is taken as received. One that is held and
      // not yet given to anyone was claimed afresh, for a conversation that has not asked for it
      // yet: a receipt for it is an old one, from whoever had it before, and taking it would
      // mark the click as handed to an agent that never saw it.
      const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && held.get(x)?.served === true) : []
      // An add-on that knows says whether the click started a turn or joined one that was
      // running. One that does not say is taken to have been heard at once.
      const woke = body.woke === true
      // One report is one turn, however many clicks it carried: counted as one waking
      if (woke && ids.length) record('agent.woken', { result: 'resumed', agent: agentOf(held.get(ids[0]!)!.click.session?.harness) })
      for (const clickId of ids) {
        const click = held.get(clickId)!.click
        counting.set(clickId, { at: click.at, harness: click.session?.harness, path: woke ? 'woke' : 'heard' })
        if (counting.size > 2000) counting.delete(counting.keys().next().value!)
        held.delete(clickId)
        toConfirm.set(clickId, 'addon')
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
  writePrivate(infoFile(), info)
  // Where it listens is said by kind: the socket's own address would name the person's home folder
  say(`connector ${VERSION} started (pid ${process.pid}); connector listening on ${info.socket ? 'its socket' : `127.0.0.1:${info.port}`}`)
  // Usage counts are sent from here, in the background, for every command on this machine
  const usage = startSender()
  record('service.started', thisProgram())
  let countedAt = Date.now()

  // ---- what It says ----
  let notOurs = false
  /** It does not take this machine for one of the person's machines any more: it was revoked on the site, or everything It held was erased. Nothing more can be done from here, so the connector stops. */
  const notOursNow = () => {
    if (notOurs) return
    say("this machine is not one of It's machines any more; stopping")
    notOurs = true
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
  let saidTooMany = false
  let unwatch: (() => void) | null = null
  function watch(): void {
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
    const args = { listening, queues: [...new Set<string>([...QUEUES, ...WAKES.filter((h) => wakesNow.has(h))])].filter(connected) }
    const next = JSON.stringify(args)
    if (next === watching) return
    watching = next
    unwatch?.()
    unwatch = client.onUpdate(
      api.delivery.inbox,
      args,
      (clicks: Offered[]) => {
        inbox = clicks
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
  let sayLatest = true
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
  const upgradeAsked = async () => {
    if (upgradingNow) return
    upgradingNow = true
    try {
      await call('mutation', api.machines.upgrading, { state: 'working' }).catch(() => {})
      const done = await fetchNewer({ say: (line) => say(`upgrade: ${line}`) })
      if (!done) return void (await call('mutation', api.machines.upgrading, { state: 'none' }).catch(() => {}))
      if (service.installedHere()) {
        say(`upgrade: starting again as ${done.to}`)
        spawn(done.program, ['setup'], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }).unref()
      } else {
        say(`upgrade: ${done.to} is in place, and runs once It is started again`)
        await call('mutation', api.machines.upgrading, { state: 'installed', version: done.to }).catch(() => {})
      }
    } catch (err) {
      say(`upgrade: ${why(err)}`)
      await call('mutation', api.machines.upgrading, { state: 'failed', why: err instanceof Problem ? err.message : 'It could not be upgraded.' }).catch(
        () => {},
      )
    } finally {
      upgradingNow = false
    }
  }
  // What is installed on the machine is looked at when the connector starts, when what is
  // wanted changes, and every half hour: each look runs every harness's own command. The
  // report in between says the connector is alive, with what was found last time.
  found = await detectAll()
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
    const told = { connectorVersion: VERSION, harnesses: found }
    await call('mutation', api.machines.report, sayLatest && latestKnown !== undefined ? { ...told, latest: latestKnown } : told)
      .catch(async (err) => {
        if (sayLatest && latestKnown !== undefined && (err as { code?: string }).code !== 'unauthenticated') {
          sayLatest = false
          await call('mutation', api.machines.report, told)
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
  client.onUpdate(
    api.machines.me,
    {},
    (me: {
      wanted: string[]
      wakes?: { harness: string; since: number }[]
      runs?: { harness: string; sessionId: string; stop?: boolean }[]
      upgrade?: { state: string } | null
    }) => {
      if (me.upgrade?.state === 'asked') void upgradeAsked()
      // A conversation the person asked to have stopped is stopped. One that It has down as
      // running and that is not, which a connector that died leaves behind, is said to be over.
      for (const r of me.runs ?? []) {
        const run = reopenedNow.get(follow(keyOf(r.harness, r.sessionId)))
        if (run && r.stop) run.abort()
        if (!run) void call('mutation', api.machines.runEnded, { for: { harness: r.harness, id: r.sessionId } }).catch(() => {})
      }
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
  await report()
  const tick = setInterval(() => void route(), 1000)
  // Said this often and no less: the site takes a machine that has been quiet for a few of these to be off
  const alive = setInterval(() => void report(), ALIVE.everyMs)
  // And whether it still does, for as long as this runs: the It it joined may be updated under
  // it. Found not to fit, the connector stops, which ends what it reopened and gives back what
  // it held; started again, it waits as above until the two fit.
  const fits = setInterval(
    () =>
      void unfit().then((wrong) => {
        if (!wrong) return
        say(`${wrong.message} ${wrong.hint ?? ''} Stopping until then.`)
        stopping?.(0)
      }),
    FITS_EVERY_MS * 5,
  )
  // Whether a newer It is out: asked a little after starting, and every half hour from then on
  const firstLook = setTimeout(() => void lookForNewer(), 20_000)
  const looks = setInterval(() => void lookForNewer(), LOOKS_EVERY_MS)
  const beat = setInterval(() => {
    const now = Date.now()
    for (const [k, s] of sessions) if (now - s.seen > 3_600_000) sessions.delete(k)
    for (const [k, w] of waiters) if (now - w.seen > 60_000) waiters.delete(k)
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
      record('service.started', thisProgram())
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
  // Written down for the connector that starts next: each of these is given what it was
  // reopened for a second time, and must be told that its first turn at it was cut off
  for (const key of reopenedNow.keys()) cutOff.add(key)
  keepCutOff()
  for (const run of reopenedNow.values()) run.abort()
  // What is held goes back, and what was handed over is confirmed, all at once and for a few
  // seconds at most: whoever asked this program to stop will not wait long, and anything not
  // given back in that time goes back by itself when its lease runs out
  await Promise.race([
    Promise.allSettled([
      // And It is told that this machine is going, so that its pages say at once that they wait
      // for the machine, where they would otherwise say for minutes that a conversation was closed
      ...(asked ? [call('mutation', api.machines.stopping, {})] : []),
      ...[...held].filter(([, h]) => !h.served).map(([id]) => call('mutation', api.delivery.release, { id })),
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
