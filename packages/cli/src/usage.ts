// Usage reporting: counts of what It is used for, and nothing of what was in it.
//
// It is on unless the person turns it off, and nothing is recorded until a person has been
// told so once, by the first command a person runs at a terminal, which the setup is. An
// event is a name and a few properties, each of which is one of a fixed set of words or bands:
// `ALLOWED` below is the whole of what can be sent, and an event with anything else in it is not
// sent at all. `docs/usage-reporting.md` says the same to the person, and a test holds the two
// together.
//
// Off is a file of its own in It's folder, `telemetry-off`, and never a field of the settings:
// whoever writes the settings, however old their view of them, cannot then turn reporting back
// on. `it telemetry off` makes the file. So does any command that finds a variable in its
// environment that turns reporting off, because the program that sends is the background
// service, which is not started from anyone's shell and would otherwise never hear of it.
//
// Turning reporting on always gives the installation a new random id, and every event carries a
// tag of the id it was made under. An event whose tag is not the current id's is never sent, so
// nothing from before reporting was turned off can go out after it is turned on again.
//
// Reporting never stands in the way of anything. Recording an event is adding it to a list in
// memory in the program that sends. In any other command it is one look for the off file and
// one short line added to a file. Sending is done by the connector, in the background, in
// batches; a batch that cannot be sent is tried a few more times, less and less often, and then
// dropped.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { HARNESSES } from '@it/protocol'
import { currentSession, inHome, Problem, VERSION } from './lib'

export const DEFAULT_URL = 'https://itcan.do/api/usage'
export const DOCS = 'https://itcan.do/usage-reporting'
export const NOTICE = `It reports usage counts under a random id for this installation, and never what is on a page. Turn it off with \`it telemetry off\` or IT_TELEMETRY_ENABLED=false. What is sent: ${DOCS}`
/** The same in fewer words, for one quiet line among the few a setup led at a terminal shows. `it telemetry` says the rest. */
export const NOTICE_BRIEF = 'It reports usage counts under a random id, and never what is on a page. `it telemetry off` turns that off.'

// ---------- what can be sent ----------

const AGENTS = [...HARNESSES, 'other', 'unknown'] as const
export type Agent = (typeof AGENTS)[number]
/** Which agent app, as one of the names It knows. A name it does not know is "other", and is never sent as it was given. */
export const agentOf = (harness: string | null | undefined): Agent =>
  !harness || harness === 'unknown' ? 'unknown' : (HARNESSES as readonly string[]).includes(harness) ? (harness as Agent) : 'other'

const SIZES = ['under 10 KB', '10 to 100 KB', '100 KB to 1 MB', '1 to 10 MB', 'over 10 MB'] as const
export const sizeBand = (bytes: number): (typeof SIZES)[number] =>
  bytes < 10_000 ? SIZES[0] : bytes < 100_000 ? SIZES[1] : bytes < 1_000_000 ? SIZES[2] : bytes < 10_000_000 ? SIZES[3] : SIZES[4]

const TIMES = ['under 1 second', '1 to 10 seconds', '10 to 60 seconds', '1 to 10 minutes', '10 to 60 minutes', '1 to 24 hours', 'over 24 hours'] as const
export const timeBand = (ms: number): (typeof TIMES)[number] =>
  ms < 1000
    ? TIMES[0]
    : ms < 10_000
      ? TIMES[1]
      : ms < 60_000
        ? TIMES[2]
        : ms < 600_000
          ? TIMES[3]
          : ms < 3_600_000
            ? TIMES[4]
            : ms < 86_400_000
              ? TIMES[5]
              : TIMES[6]

/**
 * Every event that exists, and for each property the values it may have. Two of the events are
 * not sent yet: they happen between a screen and the backend, where this program is not.
 */
export const ALLOWED = {
  'service.started': {
    version: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/,
    os: ['linux', 'macos', 'windows', 'other'],
    arch: ['x64', 'arm64', 'other'],
    installed: ['script', 'source', 'other'],
  },
  'screen.connected': { screen: ['phone', 'tablet', 'computer', 'tv'], sameMachine: [true, false] },
  'page.published': { agent: AGENTS, change: ['new', 'update'], kind: ['custom'], size: SIZES },
  'answer.sent': { screen: ['phone', 'tablet', 'computer', 'tv'], agentRunning: [true, false] },
  'answer.delivered': { path: ['heard', 'woke', 'waited'], after: TIMES, agent: AGENTS },
  'agent.woken': { result: ['resumed', 'declined', 'failed'], agent: AGENTS },
} as const
export type EventName = keyof typeof ALLOWED
type Value = string | boolean
type Properties<N extends EventName> = {
  [K in keyof (typeof ALLOWED)[N]]: (typeof ALLOWED)[N][K] extends RegExp ? string : (typeof ALLOWED)[N][K] extends readonly (infer V)[] ? V : never
}

interface Recorded {
  /** Its own, so that a batch sent twice is counted once. */
  id: string
  name: EventName
  /** When, to the hour: enough to count by the week, and no finer. */
  at: string
  properties: Record<string, Value>
  /** Which installation id this was made under, as a short hash of it. It is kept with the event on this machine and is not sent. */
  tag: string
}

/**
 * The event's properties if every one is allowed, built afresh from the table so that nothing
 * else can ride along; null if anything about it is not allowed. Only a name that is in the
 * table itself counts, and only properties that are a plain object.
 */
function allowed(name: unknown, properties: unknown): Record<string, Value> | null {
  if (typeof name !== 'string' || !Object.hasOwn(ALLOWED, name)) return null
  const shape = (ALLOWED as unknown as Record<string, Record<string, RegExp | readonly Value[]>>)[name]!
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null
  const proto = Object.getPrototypeOf(properties)
  if (proto !== Object.prototype && proto !== null) return null
  const given = properties as Record<string, unknown>
  const keys = Object.keys(given)
  if (keys.length !== Object.keys(shape).length) return null
  const out: Record<string, Value> = {}
  for (const k of keys) {
    if (!Object.hasOwn(shape, k)) return null
    const may = shape[k]!
    const value = given[k]
    if (may instanceof RegExp ? typeof value !== 'string' || !may.test(value) : !(may as readonly unknown[]).includes(value)) return null
    out[k] = value as Value
  }
  return out
}

// ---------- the files in It's folder ----------

// Each of these files is opened first and looked at afterwards, through what was opened: a look
// at a name followed by opening it leaves a moment in which something else can be put there. And
// it is opened so that it neither waits nor follows a link, whatever stands in its place. A pipe
// with nobody at its other end would otherwise hold the program for ever.
//
// Windows has no way to refuse a link in the opening itself. There the name is looked at before
// the file is opened, so that nothing is opened or made through a link that is already there,
// and again afterwards: the name must then be an ordinary file, and the very one that was
// opened. A link put there at any moment in between is in that way never read or written through.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const NO_WAIT = (constants.O_NONBLOCK ?? 0) | NO_FOLLOW
const shut = (fd: number): void => {
  try {
    closeSync(fd)
  } catch {}
}
/** Opens what should be an ordinary file, and says how large it is. Null when it is anything else, or cannot be opened. The caller closes it. */
function ordinary(file: string, flags: number): { fd: number; size: number } | null {
  let fd: number | undefined
  try {
    if (!NO_FOLLOW && lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return null
    fd = openSync(file, flags | NO_WAIT, 0o600)
    const s = fstatSync(fd, { bigint: true })
    if (s.isFile() && (NO_FOLLOW || isNamed(file, s))) return { fd, size: Number(s.size) }
  } catch {}
  if (fd !== undefined) shut(fd)
  return null
}
/** Whether this name is, this moment, an ordinary file and the one that was opened. */
function isNamed(file: string, opened: { ino: bigint; dev: bigint }): boolean {
  const named = lstatSync(file, { bigint: true })
  return named.isFile() && named.ino === opened.ino && named.dev === opened.dev
}
/** The first `bytes` bytes of an open file, as text, and never more. */
function textOf(fd: number, bytes: number): string {
  const buffer = Buffer.alloc(bytes)
  let got = 0
  while (got < bytes) {
    const n = readSync(fd, buffer, got, bytes - got, null)
    if (n <= 0) break
    got += n
  }
  return buffer.toString('utf8', 0, got)
}
/** A small ordinary file's text. Null when it is not there, is not an ordinary file, or holds more than `most` bytes. */
function readSmall(file: string, most: number): string | null {
  const f = ordinary(file, constants.O_RDONLY)
  if (!f) return null
  try {
    return f.size <= most ? textOf(f.fd, f.size) : null
  } catch {
    return null
  } finally {
    shut(f.fd)
  }
}
/** Adds whole lines to the end of an ordinary file, as many as fit before it would hold more than `most` bytes. */
function addLines(file: string, lines: string[], most: number): void {
  const f = ordinary(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT)
  if (!f) return
  try {
    let room = most - f.size
    let text = ''
    for (const line of lines) {
      room -= Buffer.byteLength(line) + 1
      if (room < 0) break
      text += `${line}\n`
    }
    if (text) writeSync(f.fd, text)
  } finally {
    shut(f.fd)
  }
}
/** Removes whatever has this name: a file, a link, a pipe, or a folder with nothing in it. What cannot be removed is left where it is. */
function remove(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    try {
      rmdirSync(file)
    } catch {}
  }
}
/**
 * Puts a small file in place whole or not at all, readable only by this user. It is written
 * under a name nothing else has, and then moved over whatever was there.
 */
function putWhole(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const beside = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const fd = openSync(beside, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_WAIT, 0o600)
  try {
    try {
      writeSync(fd, text)
    } finally {
      shut(fd)
    }
    renameSync(beside, file)
  } catch (err) {
    remove(beside)
    throw err
  }
}

// ---------- on, off, and who ----------

interface Settings {
  /** When a person was told, once, that It reports usage. Nothing is recorded before. */
  told?: number
  /** A random id for this installation. What is sent is a hash of it. A new one is made every time reporting is turned on. */
  installation?: string
}
const settingsFile = () => inHome('telemetry.json')
const offFile = () => inHome('telemetry-off')
const spoolFile = () => inHome('usage.jsonl')
/** The lines, once the connector has taken them to read. */
const takenFile = () => inHome('usage.jsonl.taken')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The settings as the file is this moment. A file of any other shape than It writes holds
 * neither a telling nor an id. Whether reporting is on or off is nothing the settings say: that
 * is the off file's alone, and whatever else a settings file holds is passed over.
 */
function fresh(): Settings {
  let value: unknown = null
  try {
    value = JSON.parse(readSmall(settingsFile(), 16 * 1024) ?? 'null')
  } catch {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const { told, installation } = value as Record<string, unknown>
  const kept: Settings = {}
  const toldRight = told === undefined || (typeof told === 'number' && Number.isFinite(told) && told > 0)
  const idRight = installation === undefined || (typeof installation === 'string' && UUID.test(installation))
  if (!toldRight || !idRight) return kept
  if (told !== undefined) kept.told = told as number
  if (installation !== undefined) kept.installation = installation as string
  return kept
}
/** Writes the settings, which are these two things and nothing else. */
function save(settings: Settings): void {
  putWhole(settingsFile(), JSON.stringify({ told: settings.told, installation: settings.installation }, null, 1))
  known = { file: settingsFile(), tag: tagFrom(settings) }
}

type Variable = 'IT_TELEMETRY_ENABLED' | 'DO_NOT_TRACK'
/** What a variable holds, without the spaces or quotes that a shell, a unit file or an env file may leave around it. */
const held = (name: Variable): string => (process.env[name] ?? '').replace(/^[\s'"]+|[\s'"]+$/g, '').toLowerCase()
/**
 * Which variable in this process's environment turns reporting off, if one does. DO_NOT_TRACK
 * is read by its own convention: any value but an empty one and the few that plainly mean "no".
 */
const offInEnvironment = (): Variable | null =>
  ['false', '0', 'off', 'no', 'n', 'disabled'].includes(held('IT_TELEMETRY_ENABLED'))
    ? 'IT_TELEMETRY_ENABLED'
    : !['', '0', 'false', 'no', 'off'].includes(held('DO_NOT_TRACK'))
      ? 'DO_NOT_TRACK'
      : null
/** Whether anything at all has this name. Where that cannot be told, something is taken to. */
const stands = (file: string): boolean => {
  try {
    return lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOTDIR'
  }
}
/** Whether anything at all stands where the off file would be. Where that cannot be told, reporting is taken to be off. */
const offFileIsThere = (): boolean => stands(offFile())
/**
 * Whether reporting is off, and the settings, as they are this moment. The off file is looked
 * for first and the settings are read after it. Turning reporting off forgets the id and turning
 * it on makes a new one, so when both happen between the look and the read, what is read is the
 * new id, and never the one from before.
 */
function standing(): { off: boolean; kept: Settings } {
  const off = offInEnvironment() !== null || offFileIsThere()
  const kept = fresh()
  return { off, kept }
}
export const url = () => process.env.IT_TELEMETRY_URL || DEFAULT_URL

export interface Status {
  enabled: boolean
  because: Variable | 'it telemetry off' | 'the file telemetry-off' | 'it telemetry on' | 'the default'
  /** Where this command would send. */
  sendsTo: string
  whatIsSent: string
  /** What the lines above do not say, when there is something: that the background service was not told, or that it sends somewhere else. */
  note?: string
}
/** The one word the off file holds, which says what turned reporting off, and what `it telemetry` says for it. */
const SAID_BY: Record<string, Status['because']> = {
  command: 'it telemetry off',
  IT_TELEMETRY_ENABLED: 'IT_TELEMETRY_ENABLED',
  DO_NOT_TRACK: 'DO_NOT_TRACK',
}
/** Why reporting is off, or null when it is on. A variable set where this command runs is named before anything that was written down. */
function whyOff(): Status['because'] | null {
  const variable = offInEnvironment()
  if (variable) return variable
  if (!offFileIsThere()) return null
  const word = (readSmall(offFile(), 64) ?? '').trim()
  return Object.hasOwn(SAID_BY, word) ? SAID_BY[word]! : 'the file telemetry-off'
}
export function status(): Status {
  const why = whyOff()
  const notes: string[] = []
  if (offInEnvironment() && !offFileIsThere())
    notes.push('That could not be written down in It’s folder, so the background service has not been told and is not stopped by it.')
  if (process.env.IT_TELEMETRY_URL)
    notes.push('IT_TELEMETRY_URL is set where this command runs. The background service sends to the address it was installed with, which may be another.')
  return { enabled: !why, because: why ?? 'the default', sendsTo: url(), whatIsSent: DOCS, ...(notes.length ? { note: notes.join(' ') } : {}) }
}
/** Whether a person has been told, by a command at a terminal. */
export const wasTold = (): boolean => fresh().told !== undefined

/** How this installation is named in what is sent: a hash of its random id. */
const named = (installation: string): string => createHash('sha256').update(`it-usage:${installation}`).digest('hex')
/**
 * The name to send under and the tag to record under, once a person has been told and there is
 * an id. Null before, and then nothing is recorded or sent. The tag is a hash of its own, so
 * that no part of what stays on this machine is in what is sent.
 */
function identity(kept: Settings): { who: string; tag: string } | null {
  if (kept.told === undefined || !kept.installation) return null
  const tag = createHash('sha256').update(`it-usage-tag:${kept.installation}`).digest('hex').slice(0, 12)
  return { who: named(kept.installation), tag }
}
const tagFrom = (kept: Settings): string | null => identity(kept)?.tag ?? null
/**
 * Whether counts are being sent from this installation as things stand this moment: reporting
 * is on, a person has been told of it, and there is an id to send under. Before that, and
 * whenever it is off, nothing is counted. Where that cannot be read, it is said that none are.
 */
export function counting(): boolean {
  try {
    const { off, kept } = standing()
    return !off && identity(kept) !== null
  } catch {
    return false
  }
}

/** What is waiting in this program's memory is forgotten. */
function forget(): void {
  queue.length = 0
  batches.length = 0
  oldestAt = null
}
/**
 * Everything waiting to be sent is removed: what is in memory, the lines the commands left, and
 * the file a connector had taken them into. Those are two names, and the folder is never listed,
 * so this costs the same whatever else stands in it.
 */
function discard(): void {
  forget()
  remove(spoolFile())
  remove(takenFile())
}

// The sender decides whether to send in one step: it looks for the off file, reads the id, and
// begins its request. For as long as that step takes, a file of its own says so. A command that
// turns reporting off makes the off file first and then waits for that file to go. A request
// that begins after the command has returned was therefore decided on with the off file already
// there, which is to say that none begins. A command that turns reporting on waits in the same
// way once it has written the new id down, so that none begins under the old one either.
const decidingFile = () => inHome('telemetry-sending')
/** The longest the step may take. A sender that stood still for longer does not send on what it saw, and looks again at its next pass. */
const DECIDING_MOST_MS = 250
/** How long a command that turns reporting off waits for a sender that is deciding: longer than the step may take. */
const WAIT_FOR_SENDER_MS = 1000
/** Stands still for a moment. Only a command does this, as it turns reporting off, and never the sender on the loop that delivers. */
const pause = (ms: number): void => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {}
}
/** Waits for a sender that is deciding at this moment, until its request has begun or it has stood still too long to send. */
function waitForSender(): void {
  const until = performance.now() + WAIT_FOR_SENDER_MS
  while (stands(decidingFile()) && performance.now() < until) pause(5)
  // Still there: left by a sender that was killed, or by one standing still, which will not send on what it saw so long ago
  remove(decidingFile())
}
/** Makes the off file, holding the one word that says what turned reporting off, and waits for a sender that is deciding at that moment. */
function turnOff(word: string): void {
  putWhole(offFile(), word)
  waitForSender()
}

/**
 * Run by every command before anything else. A command that finds reporting turned off in its
 * environment makes the off file, so that the background service, which never sees a shell's
 * variables, stops too. It stays off until `it telemetry on` is run somewhere the variable is
 * not set. What was waiting is discarded whether or not the file could be made.
 */
export function heed(): void {
  let kept: Settings = {}
  try {
    kept = fresh()
    known = { file: settingsFile(), tag: tagFrom(kept) }
  } catch {}
  const variable = offInEnvironment()
  if (!variable) return
  try {
    if (!offFileIsThere()) turnOff(variable)
  } catch {}
  try {
    if (kept.installation) save({ told: kept.told })
  } catch {}
  discard()
}

/**
 * `it telemetry on` and `it telemetry off`. Turning it off makes the off file, discards what was
 * waiting to be sent and forgets the installation's id. Turning it on removes the file and makes
 * a new id, always: nothing recorded under an earlier one is then sent. While a variable where
 * this command runs turns reporting off, turning it on is refused and nothing is changed.
 *
 * Someone who turns it on without having been told is told through `say`, before anything is
 * written down: a command stopped between the two has then said the line and noted nothing, and
 * never the other way about. Where the line cannot be said, nothing is changed. With no `say`
 * given, nobody counts as told, and nothing is recorded until a command at a terminal says it.
 */
export function set(on: boolean, say?: (line: string) => void): Status {
  if (!on) {
    let written = true
    try {
      turnOff('command')
    } catch {
      written = offFileIsThere()
    }
    try {
      // Whoever runs this command has plainly been told
      save({ told: fresh().told ?? Date.now() })
    } catch {}
    discard()
    if (!written)
      throw new Problem(
        'Usage reporting is still on, because the file that turns it off could not be written in It’s folder.',
        'error',
        'Run `it telemetry off` again once the folder can be written. Until then, IT_TELEMETRY_ENABLED=false stops every command it is set for.',
      )
    return status()
  }
  const variable = offInEnvironment()
  if (variable)
    throw new Problem(`${variable} is set where this command runs, so usage reporting stays off. Run \`it telemetry on\` again without it.`, 'refused')
  let told = fresh().told
  if (told === undefined && say) {
    say(NOTICE)
    told = Date.now()
  }
  try {
    save({ told, installation: randomUUID() })
  } catch {
    throw new Problem('Usage reporting was left as it was, because nothing could be written in It’s folder.', 'error')
  }
  waitForSender()
  remove(offFile())
  const after = status()
  if (!after.enabled)
    throw new Problem(
      'Usage reporting is still off, because the file `telemetry-off` in It’s folder could not be removed.',
      'error',
      'Remove it yourself, then run `it telemetry on` again.',
    )
  return { ...after, because: 'it telemetry on' }
}

/**
 * Says once that usage is reported and how to turn it off, and only where a person will read
 * it: at a terminal, and not inside an agent's conversation, since some agent apps give the
 * commands they run a terminal. Run by an agent, a script or a service, a command says nothing
 * and counts nothing, and the next command a person runs at a terminal says it. Until it has
 * been said nothing is recorded. The install scripts say nothing of it and leave no note: the
 * setup they lead into is the command that says it. `notice` is the sentence, where it is to be
 * the shorter one.
 */
export function tellOnce(say: (line: string) => void, atTerminal: boolean, notice: string = NOTICE): void {
  try {
    const { off, kept } = standing()
    known = { file: settingsFile(), tag: tagFrom(kept) }
    if (off) return
    if (kept.told !== undefined) {
      if (!kept.installation) save({ told: kept.told, installation: randomUUID() })
      return
    }
    if (!atTerminal || currentSession()) return
    say(notice)
    save({ told: Date.now(), installation: randomUUID() })
  } catch {}
}

// ---------- recording ----------

const QUEUE_MOST = 1000
const SPOOL_MOST_BYTES = 256 * 1024
const queue: Recorded[] = []
/** Whether this process sends what it records. Only the connector does; any other command leaves a line for it. */
let sending = false
// What `record` goes by. In the program that sends, it is what the sender saw at its last look,
// so that counting a delivery there reads no file at all. In any other command it is the tag as
// that command first read it, kept for as long as the command runs, so that all it does each
// time is look for the off file. A command still running when reporting is turned off and on
// again goes on using the old tag, and what it records after that is never sent.
interface Seen {
  off: boolean
  who: string | null
  tag: string | null
}
let seen: Seen = { off: false, who: null, tag: null }
let known: { file: string; tag: string | null } | null = null

/**
 * Notes that something happened. It returns at once and never throws: whatever goes wrong
 * here, the thing being counted has already been done and is not affected.
 */
export function record<N extends EventName>(name: N, properties: Properties<N>): void {
  try {
    if (!sending && known?.file !== settingsFile()) known = { file: settingsFile(), tag: tagFrom(fresh()) }
    const tag = sending ? seen.tag : known!.tag
    // Nobody has been told yet, or there is no id to record under
    if (!tag) return
    // A command that is not the sender looks for the off file every time, since another program
    // may have made it since this one began
    if (!sending && (offInEnvironment() || offFileIsThere())) return
    const kept = allowed(name, properties)
    if (!kept) return
    const hour = new Date()
    hour.setUTCMinutes(0, 0, 0)
    const event: Recorded = { id: randomUUID(), name, at: hour.toISOString(), properties: kept, tag }
    if (sending) {
      queue.push(event)
      if (queue.length > QUEUE_MOST) queue.shift()
      return
    }
    // One line, for the connector to pick up. A file that has grown large means nothing has
    // been picking it up, and it is left as it is.
    addLines(spoolFile(), [JSON.stringify(event)], SPOOL_MOST_BYTES)
  } catch {}
}

/** The most that one file taken from the other commands may hold, and the most that is read in one pass. */
const TAKEN_MOST_BYTES = SPOOL_MOST_BYTES * 2
/** No file It wrote has more lines than this in the bytes it may hold. */
const LINES_MOST = 4000
const HOUR = /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/

/**
 * The event a line holds, if it is one It would have written under the current id, in the last
 * week. The file is this user's own, and is still read as if anyone could have written it: the
 * event is sent under an id made here, as it is taken, and what the line gives as its id is
 * never sent. Every later try of the same event carries that same id.
 */
function fromLine(line: string, tag: string, wall: number): Recorded | null {
  if (!line) return null
  try {
    const e = JSON.parse(line) as { id?: unknown; name?: unknown; at?: unknown; properties?: unknown; tag?: unknown }
    if (e.tag !== tag) return null
    const kept = allowed(e.name, e.properties)
    if (!kept || typeof e.id !== 'string' || !UUID.test(e.id) || typeof e.at !== 'string' || !HOUR.test(e.at)) return null
    const at = Date.parse(e.at)
    // Its hour is one this machine's clock could have given it lately
    if (!(at <= wall + 3_600_000 && at >= wall - 7 * 86_400_000)) return null
    return { id: randomUUID(), name: e.name as EventName, at: e.at, properties: kept, tag }
  } catch {
    return null
  }
}

/**
 * What an earlier connector had taken and was stopped before sending, and then what the other
 * commands have left since: at most `room` events, made under the current id. The lines are
 * taken whole by renaming their file, so a command writing a line at that instant writes it to
 * the file that is about to be read or to a new one. One line can still be lost, when it is
 * written after the read and before the file is removed.
 *
 * How much one pass does is settled before it does it: two files, each known by its name, a
 * fixed number of bytes and of lines, and two removals. The folder is never listed, so no number
 * of other files in it makes a pass longer. What does not fit in this pass waits for the next.
 */
function fromSpool(tag: string, room: number): Recorded[] {
  const out: Recorded[] = []
  const wall = Date.now()
  let bytes = 0
  for (const left of ['by an earlier connector', 'by the commands'] as const) {
    if (out.length >= room) break
    let from = takenFile()
    if (left === 'by the commands') {
      try {
        renameSync(spoolFile(), from)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
        // Something that cannot be removed stands where the lines are taken to: they are read where they are
        from = spoolFile()
      }
    }
    let waits = false
    const f = ordinary(from, constants.O_RDONLY)
    try {
      // Larger than the lines are ever let grow, or not an ordinary file: not something this program wrote
      if (f && f.size <= TAKEN_MOST_BYTES) {
        if (bytes + f.size > TAKEN_MOST_BYTES) waits = true
        else {
          bytes += f.size
          for (const line of textOf(f.fd, f.size).split('\n', LINES_MOST)) {
            if (out.length >= room) break
            const event = fromLine(line, tag, wall)
            if (event) out.push(event)
          }
        }
      }
    } catch {
    } finally {
      if (f) shut(f.fd)
      if (!waits) remove(from)
    }
    if (waits) break
  }
  return out
}

// ---------- sending ----------

export const BATCH_MOST = 20
/** How long a batch waits before each further try. After the last of these fails too, it is dropped. */
export const WAITS = [2_000, 15_000, 60_000, 300_000]
/** Events are held a little while so that they go together, and never longer than this. */
const HOLD_MS = 30_000

interface Batch {
  events: Recorded[]
  tries: number
  nextAt: number
}
const batches: Batch[] = []
/** When the oldest event still waiting to go into a batch began to wait. */
let oldestAt: number | null = null

/** Of everything waiting in memory, only what was made under this id is kept. */
function only(tag: string): void {
  const under = (e: Recorded) => e.tag === tag
  if (!queue.every(under)) queue.splice(0, queue.length, ...queue.filter(under))
  for (const batch of batches) if (!batch.events.every(under)) batch.events = batch.events.filter(under)
  for (let i = batches.length - 1; i >= 0; i--) if (!batches[i]!.events.length) batches.splice(i, 1)
  if (!queue.length) oldestAt = null
}

export interface Sender {
  /** One pass: takes what is waiting, and sends what is due. Resolves when what it started has finished. */
  tick(): Promise<void>
  /** Stops for good. What was never tried is left for the next start; what was being tried is dropped. */
  stop(): void
}

/**
 * Starts sending from this process. `post` and `now` are given by tests; nothing else passes them.
 * Whatever a pass does, it does not throw, and nothing waits for it.
 */
export function startSender(
  options: { post?: (address: string, body: string, signal: AbortSignal) => Promise<boolean>; now?: () => number; everyMs?: number } = {},
): Sender {
  // Waits are counted on a clock that only goes forward. The time of day is used for an event's
  // hour and for nothing else: setting the machine's clock back must not put a retry off.
  const now = options.now ?? (() => performance.now())
  const post =
    options.post ??
    ((address: string, body: string, signal: AbortSignal) =>
      fetch(address, {
        method: 'POST',
        // Said plainly, so that the page that lists what is sent can say exactly what this header is
        headers: { 'content-type': 'application/json', 'user-agent': `it/${VERSION}` },
        body,
        // An answer that points somewhere else is a send that failed: a batch is never sent on to wherever it names
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }).then(
        (r) => {
          // All that is wanted of the answer is whether the batch was taken. The rest of it is not read or waited for
          void r.body?.cancel().catch(() => {})
          return r.ok
        },
        () => false,
      ))
  sending = true
  let busy = false
  let stopped = false
  /** The send that is under way, and the id it is being made under. */
  let flight: { tag: string; end: AbortController } | null = null
  /**
   * How things stand this moment, which is also what `record` goes by until the next look. A
   * send under way is given up at once when reporting has been turned off, or when the id it
   * was made under has stopped being the current one.
   */
  const look = (): Seen => {
    const { off, kept } = standing()
    const id = off ? null : identity(kept)
    seen = { off, who: id?.who ?? null, tag: id?.tag ?? null }
    if (flight && flight.tag !== seen.tag) flight.end.abort()
    if (off) discard()
    return seen
  }
  look()
  /** A batch that failed is tried again when its wait is over, and not only at the next regular pass. */
  const again = new Set<ReturnType<typeof setTimeout>>()
  async function tick(): Promise<void> {
    if (stopped) return
    // Looked at on every pass, also while a send is under way, so that turning reporting off is
    // heard within one pass however long the other end takes to answer
    let s: Seen
    try {
      s = look()
    } catch {
      return
    }
    if (busy || s.off) return
    busy = true
    try {
      // Nobody has been told yet, or there is no id: nothing may be sent, whatever is waiting
      if (!s.who || !s.tag) return forget()
      only(s.tag)
      queue.push(...fromSpool(s.tag, QUEUE_MOST - queue.length))
      if (queue.length && oldestAt === null) oldestAt = now()
      // Made into batches once there are enough to fill one, or the oldest has waited long enough
      while (queue.length >= BATCH_MOST || (queue.length && oldestAt !== null && now() - oldestAt >= HOLD_MS)) {
        batches.push({ events: queue.splice(0, BATCH_MOST), tries: 0, nextAt: 0 })
        oldestAt = queue.length ? now() : null
      }
      while (batches.length > 50) batches.shift()
      for (const batch of [...batches]) {
        if (stopped) return
        if (!batches.includes(batch) || batch.nextAt > now()) continue
        // Asked again before each send, in one step with beginning it: turned off while a pass
        // is under way, nothing more of that pass is sent, and given a new id, nothing made
        // under the old one is. The clock for the step is the machine's own, whatever a test gives.
        const began = performance.now()
        let t: Seen
        let answer: Promise<boolean>
        try {
          const mine = ordinary(decidingFile(), constants.O_WRONLY | constants.O_CREAT)
          // A sender that cannot say it is deciding does not send: nobody turning reporting off could wait for it
          if (!mine) return
          shut(mine.fd)
          t = look()
          if (t.off) return
          if (!t.who || !t.tag) return forget()
          only(t.tag)
          if (!batches.includes(batch)) continue
          const body = JSON.stringify({ v: 1, installation: t.who, events: batch.events.map(({ id, name, at, properties }) => ({ id, name, at, properties })) })
          // Whoever turned reporting off in the meantime has stopped waiting for this step to end
          if (performance.now() - began > DECIDING_MOST_MS) return
          batch.tries += 1
          flight = { tag: t.tag, end: new AbortController() }
          // A send that throws is a send that failed, and is counted as one try like any other
          try {
            answer = Promise.resolve(post(url(), body, flight.end.signal))
          } catch {
            answer = Promise.resolve(false)
          }
        } finally {
          remove(decidingFile())
        }
        let ok = false
        try {
          ok = (await answer) === true
        } catch {}
        // Whatever is left of the request is given up with it, so that nothing of a send outlives it
        flight?.end.abort()
        flight = null
        if (stopped) return
        // Given a new id, or left with none, while it was on its way: a batch made under another id is dropped, and never tried again
        if (seen.tag !== t.tag) seen.tag ? only(seen.tag) : forget()
        if (!batches.includes(batch)) continue
        const wait = WAITS[batch.tries - 1]
        if (ok || wait === undefined) batches.splice(batches.indexOf(batch), 1)
        else {
          batch.nextAt = now() + wait
          if (options.everyMs !== 0) {
            const retry = setTimeout(() => {
              again.delete(retry)
              // Its wait is over when its own timer says so, whatever a clock read a moment apart says
              batch.nextAt = 0
              void tick()
            }, wait)
            retry.unref()
            again.add(retry)
          }
        }
      }
    } catch {
    } finally {
      busy = false
    }
  }
  const timer = options.everyMs === 0 ? null : setInterval(() => void tick(), options.everyMs ?? 5_000)
  timer?.unref()
  return {
    tick,
    stop() {
      if (timer) clearInterval(timer)
      for (const t of again) clearTimeout(t)
      stopped = true
      sending = false
      // A send that is under way is given up at once, so that stopping never waits for it
      flight?.end.abort()
      // Never tried: put back as lines, for the connector's next start, and never more of them
      // than the file is let grow to. A batch that was tried and failed is dropped here, and so
      // is anything made under an id that has stopped being the current one.
      try {
        const { off, kept } = standing()
        const tag = off ? null : tagFrom(kept)
        const untried = [...batches.filter((b) => b.tries === 0).flatMap((b) => b.events), ...queue].filter((e) => e.tag === tag)
        if (untried.length)
          addLines(
            spoolFile(),
            untried.map((e) => JSON.stringify(e)),
            SPOOL_MOST_BYTES,
          )
      } catch {}
      known = null
      seen = { off: false, who: null, tag: null }
      forget()
    },
  }
}

// ---------- what this program itself can say ----------

/** The `service.started` event's properties, for this program as it is running now. */
export function thisProgram(): Properties<'service.started'> {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'other'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'other'
  // The install script puts the program in It's own folder. One that Node or Bun is running is
  // the bundle or the source, run as a script, wherever it lies.
  const program = process.execPath
  const installed = program.startsWith(inHome('bin')) ? 'script' : /(^|[\\/])(node|bun)(\.exe)?$/i.test(program) ? 'source' : 'other'
  // The three numbers a version begins with, and nothing after them: a version with more to it
  // is counted under those three, and is not left out for failing to be only them
  const version = /^\d{1,4}\.\d{1,4}\.\d{1,4}/.exec(VERSION)?.[0] ?? '0.0.0'
  return { version, os, arch, installed }
}
