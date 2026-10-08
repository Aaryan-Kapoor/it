// Convex's backend program, run on this machine as a child of It's service. It is fetched for
// the release this version of It runs and checked against a checksum written here, started so
// that only this machine can reach it, with its data in It's folder, given It's functions, and
// stopped by being asked to and waited for. On Windows, where it cannot be counted on to hear,
// it is ended once nothing more is asked of it. One program at a time has a folder's data, and
// the service never moves, replaces or removes a database.
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { FUNCTIONS, FUNCTIONS_HASH } from '../functions.generated'
import { ask, backendAt, direct, inHome, Problem, psQuote, readJson, VERSION } from '../lib'
import {
  backendFolder,
  doorKey,
  instanceName,
  makeOnce,
  noteLoaded,
  programFile,
  RELEASE,
  rename,
  type ServiceConfig,
  unread,
  writeAll,
  writeFlushed,
  writeWhole,
} from './config'

/** That the functions in the database are not the ones this version of It carries, which ones those are, why, and since when. */
export interface Behind {
  functions: string
  /** `refused`: what the database holds does not fit them. `no_copy`: no copy of the database could be kept first. */
  why: 'refused' | 'no_copy'
  at: number
}
export interface Backend {
  /** Where functions are called. */
  api: string
  /** Where the backend's HTTP routes answer, which is also the address it signs under. */
  site: string
  adminKey: string
  /** Asks the program to stop, and waits until it has. */
  stop(): Promise<void>
  /** Set when the backend serves on functions loaded by an earlier version of It, the ones of this version not having gone in. */
  behind?: Behind
}
/** How a program ended: with a code of its own, or by a signal. */
export interface End {
  code: number | null
  signal: string | null
}
/** A backend this program started. `ended` settles when the program has ended, whether or not it was asked to. */
export interface Running extends Backend {
  ended: Promise<End>
}
/** An end as it is written down: the code, or the signal's name. */
export const endOf = (end: End) => (end.signal ? end.signal : `code ${end.code ?? 'none'}`)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const stopped = () => new Problem('It was asked to stop.', 'stopped')
/** A request that ends when its time is up, or when the service is asked to stop, whichever is first. */
const within = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms))
/** Whether a process has this number. One that is another account's, and so cannot be signalled, is a process all the same. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------- the program ----------

/**
 * The archive of the backend program for each system It runs on, as its release publishes it,
 * and the SHA-256 each must have. Every archive holds the program alone.
 */
const ARCHIVES: Record<string, { name: string; sha256: string }> = {
  'linux-x64': { name: 'convex-local-backend-x86_64-unknown-linux-gnu.zip', sha256: '5b4adbe9fc2f9985c66eb12b19dadedf2700d8796c839ddba09802196099f241' },
  'linux-arm64': { name: 'convex-local-backend-aarch64-unknown-linux-gnu.zip', sha256: 'd13679e5abb77637218547b8109ec903ae5e9a276addb2bec438d54457a6772c' },
  'darwin-x64': { name: 'convex-local-backend-x86_64-apple-darwin.zip', sha256: '8ca9b573069b504ce533394bb126ba2c88529f260138f54171d8f4b39b9ebe3b' },
  'darwin-arm64': { name: 'convex-local-backend-aarch64-apple-darwin.zip', sha256: 'c1613bb4a3ac884871184020662c865a045cde95ad781fff002a6bd25f2f2890' },
  'win32-x64': { name: 'convex-local-backend-x86_64-pc-windows-msvc.zip', sha256: 'fdf30fa67a8b5709ce21ec35dbe7c17ab0e1918495b4f02661a68137f391fe56' },
}
const RELEASES = 'https://github.com/get-convex/convex-backend/releases/download'
/**
 * Where the backend program's releases are fetched from: the program's own releases, or the
 * place `IT_BACKEND_RELEASES` names. That is a mirror of the releases, for a machine that
 * cannot reach them, and it is what stands in for them where It is tested with nothing asked
 * of the internet. It is laid out as the releases are, so the archive of a release is at the
 * release's name under it, by the name the archive has there.
 *
 * It is any https address, or plain http for this machine itself and for nothing else: exactly
 * `127.0.0.1` or `localhost` and a port, with nothing before it that a browser would read as a
 * name and a password. Such a place is `plain`: it is asked on a connection of this program's
 * own, whatever proxy the environment names, since a proxy would carry what is asked of this
 * machine off it, and what it answers is followed nowhere else. Anything else the variable
 * holds is refused before anything is asked, and is not said back, since it may hold a name
 * and a password.
 *
 * Whatever place it is, what comes from it is kept only if it is the archive this It expects
 * of its release, by the checksum written down here.
 */
function releases(): { base: string; plain: boolean } {
  const named = process.env.IT_BACKEND_RELEASES
  if (!named) return { base: RELEASES, plain: false }
  const base = named.replace(/\/+$/, '')
  let read: URL | undefined
  try {
    read = new URL(named)
  } catch {}
  if (read && /^https:\/\//.test(named) && read.protocol === 'https:') return { base, plain: false }
  if (
    read &&
    /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}(?:\/[^?#]*)?$/.test(named) &&
    read.protocol === 'http:' &&
    (read.hostname === '127.0.0.1' || read.hostname === 'localhost') &&
    read.username === '' &&
    read.password === ''
  )
    return { base, plain: true }
  throw new Problem(
    'IT_BACKEND_RELEASES does not name a place the backend program may be fetched from.',
    'backend_releases',
    'It names an https address, or this machine itself over plain http with its port, as http://127.0.0.1:8080 does. Unset it to fetch from the program’s own releases.',
  )
}
/** No archive is anywhere near this large. One that goes on past it is not what was asked for. */
const ARCHIVE_MOST = 400 * 1024 * 1024

/**
 * Fetches an archive, checks it, and unpacks the program in it to `file`. The archive is held
 * in memory until its checksum has been compared, so one that does not match is refused with
 * nothing of it written anywhere. The program is unpacked beside where it goes, with every
 * byte of it and on the disk, and only then moved into place, so a fetch that is cut short,
 * or a disk that takes a part of it, leaves no program that is half of one. It is made for
 * the person alone, as the folder it goes into is.
 *
 * An address that is `plain` is a place on this machine (see `releases`).
 */
/** How long the backend program may take to be fetched, all of it. */
const PROGRAM_WITHIN_MS = 20 * 60_000
export async function fetchProgram(
  from: { url: string; sha256: string; plain?: boolean },
  file: string,
  signal?: AbortSignal,
  /** Told how much has arrived, and of how much where the answer said: for whoever shows a person how far it has got. */
  progress?: (got: number, of: number | undefined) => void,
  /** How long the fetching may take, where it is not the usual: for a test, which does not wait so long. */
  within: number = PROGRAM_WITHIN_MS,
): Promise<void> {
  const elsewhere = Boolean(process.env.IT_BACKEND_RELEASES)
  // The whole of it has so long, however it comes. An answer that never ended, or went on
  // trickling, kept a first setup at this step for ever, and a service that needed a newer
  // program from ever opening its door, with nothing said.
  const limit = AbortSignal.timeout(within)
  const asked = signal
  signal = asked ? AbortSignal.any([asked, limit]) : limit
  const unreachable = () =>
    new Problem(
      'The backend program could not be fetched.',
      'offline',
      elsewhere
        ? 'It is fetched from the place IT_BACKEND_RELEASES names. Check that the release is there, laid out as the program’s own releases are, then try again.'
        : 'It is fetched from its release on GitHub, the first time It is set up and again when a newer It runs a newer one. Check that this machine is online, then try again.',
    )
  const pieces: Uint8Array[] = []
  const hash = createHash('sha256')
  let size = 0
  try {
    if (from.plain) {
      // A place on this machine is asked on a connection of this program's own, and where it answers with another address, nothing is asked there
      const at = new URL(from.url)
      const answer = await ask(
        { host: at.hostname, port: Number(at.port) },
        { path: `${at.pathname}${at.search}`, headers: { host: at.host }, most: ARCHIVE_MOST, signal },
      ).catch((err) => {
        if ((err as NodeJS.ErrnoException)?.code !== 'EMSGSIZE') throw err
        return null
      })
      if (answer && answer.status !== 200) throw unreachable()
      // An answer longer than any archive is not read to its end, and is not the archive
      size = answer ? answer.body.length : ARCHIVE_MOST + 1
      if (answer) {
        hash.update(answer.body)
        pieces.push(answer.body)
      }
    } else {
      const answer = await fetch(from.url, { redirect: 'follow', signal })
      if (!answer.ok || !answer.body) throw unreachable()
      const length = Number(answer.headers.get('content-length'))
      const of = Number.isInteger(length) && length > 0 ? length : undefined
      for await (const piece of answer.body as unknown as AsyncIterable<Uint8Array>) {
        size += piece.length
        if (size > ARCHIVE_MOST) break
        progress?.(size, of)
        hash.update(piece)
        pieces.push(piece)
      }
    }
  } catch (err) {
    if (asked?.aborted) throw stopped()
    if (limit.aborted)
      throw new Problem(
        `The backend program had not been fetched after ${Math.round(within / 60_000)} minutes, so it was given up.`,
        'offline',
        'It is about 60 MB. Check that this machine is online, then try again.',
      )
    throw err instanceof Problem ? err : unreachable()
  }
  if (size > ARCHIVE_MOST || hash.digest('hex') !== from.sha256)
    throw new Problem(
      'What was fetched as the backend program is not the file It expects, so none of it was kept.',
      'checksum',
      elsewhere
        ? 'What IT_BACKEND_RELEASES names does not hold the archive this It expects of its release. Point it at a place that does, or unset it to fetch from the program’s own releases.'
        : 'Try again. If it happens again, something between this machine and GitHub is changing what is fetched.',
    )
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const part = `${file}.${process.pid}.part`
  try {
    await unpack(pieces, path.basename(file), part)
    // The program is the person's alone, to run as well as to read, whatever the file was made as
    chmodSync(part, 0o700)
    renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
}

/**
 * Writes one file of an archive to `to`, a piece at a time, so that the program is never held
 * in memory whole beside its archive, and has every byte of it on the disk before it is done.
 */
async function unpack(archive: Uint8Array[], name: string, to: string): Promise<void> {
  const out = openSync(to, 'w', 0o700)
  let found = false
  let failed = false
  try {
    const unzip = new Unzip((entry) => {
      if (entry.name !== name) return
      found = true
      entry.ondata = (err, piece) => {
        if (err) failed = true
        else writeAll(out, piece)
      }
      entry.start()
    })
    unzip.register(UnzipInflate)
    unzip.register(UnzipPassThrough)
    // The archive is given over a megabyte at a time, however large the pieces it arrived in,
    // and between one and the next whatever else this program is doing gets its turn
    const step = 1024 * 1024
    for (let n = 0; n < archive.length; n++) {
      const piece = archive[n]!
      for (let at = 0; at < piece.length; at += step) {
        unzip.push(piece.subarray(at, at + step), n === archive.length - 1 && at + step >= piece.length)
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    fsyncSync(out)
  } catch {
    failed = true
  } finally {
    closeSync(out)
  }
  if (failed || !found) throw new Problem('The archive of the backend program could not be unpacked.', 'backend_program')
}

/** Where the backend program is, having fetched and checked it first if it is not on this machine yet. */
export async function program(say: (line: string) => void, signal?: AbortSignal, progress?: (got: number, of: number | undefined) => void): Promise<string> {
  const file = programFile()
  if (existsSync(file)) return file
  if (process.env.IT_BACKEND_BIN) throw new Problem(`IT_BACKEND_BIN names ${file}, and no file is there.`, 'backend_program')
  const archive = ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive)
    throw new Problem(
      `No backend program is published for ${process.platform} on ${process.arch}.`,
      'unsupported',
      'IT_BACKEND_BIN can name one that was built for this system.',
    )
  const folder = path.dirname(file)
  // What a fetch that was cut short left behind goes first, once the program that left it is gone
  if (existsSync(folder))
    for (const name of readdirSync(folder)) {
      const left = PROGRAM_PART.exec(name)
      if (left && !alive(Number(left[1]))) rmSync(path.join(folder, name), { force: true })
    }
  const from = releases()
  say('backend: fetching the program')
  await fetchProgram({ url: `${from.base}/${RELEASE}/${archive.name}`, sha256: archive.sha256, plain: from.plain }, file, signal, progress)
  say('backend: the program is in place')
  // The program that was here for another release is kept until this one has started on the
  // data and been heard from (see where the backend is said to have started): fetched and not
  // yet run, this one may still be refused, and the other is then the one that works.
  return file
}

/** The backend program's own name, on every system It runs on. */
const PROGRAM_NAMED = /^convex-local-backend(\.exe)?$/
/** What a fetch of it that is under way is called, with the number of the process that fetches. */
const PROGRAM_PART = /^convex-local-backend(?:\.exe)?\.(\d+)\.part$/
/**
 * Removes the backend programs that were fetched for other releases than this one. What goes is
 * only what a fetch puts there: in a folder named as a release is, the program under its own
 * name and what was left of fetching it, and then the folder if that leaves it empty. Anything
 * else under `bin/` is somebody's own and is left as it is, whatever folder it is in.
 *
 * `running` is the program that is in use now. Where the person named one themselves, with
 * `IT_BACKEND_BIN`, it may be one that was fetched here for an earlier release: the folder it
 * is in is then left as it is, since it is the only backend program this It will start.
 */
export function removeOtherPrograms(running?: string): void {
  const bin = path.join(backendFolder(), 'bin')
  if (!existsSync(bin)) return
  const real = (file: string) => {
    try {
      return realpathSync(file)
    } catch {
      return path.resolve(file)
    }
  }
  const inUse = running === undefined ? undefined : path.dirname(real(running))
  for (const release of readdirSync(bin)) {
    const folder = path.join(bin, release)
    if (release === RELEASE || !/^precompiled-\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/.test(release) || !lstatSync(folder).isDirectory()) continue
    if (inUse !== undefined && real(folder) === inUse) continue
    for (const name of readdirSync(folder)) {
      const file = path.join(folder, name)
      if ((PROGRAM_NAMED.test(name) || PROGRAM_PART.test(name)) && lstatSync(file).isFile()) rmSync(file, { force: true })
    }
    // Only an empty folder goes this way
    try {
      rmdirSync(folder)
    } catch {}
  }
}

// ---------- which process ----------

/**
 * When a process was started, as the system tells it. A number alone does not name a process
 * for long: once the process has ended, the number is given to another. The number and this
 * together are one process and no other. Null where no process has the number, and undefined
 * where there is one and the system would not say when it was started.
 */
export function startOf(pid: number): string | null | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // What follows the program's name, which may itself hold spaces and brackets: first how
      // the process is, and nineteen places on, when it was started, counted from when the
      // machine was
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // One that has ended, and has only not been collected yet, is no more
      if (after[0] === 'Z' || after[0] === 'X') return null
      if (after[19] && /^\d+$/.test(after[19])) return after[19]
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync('/proc/self/stat')) return null
    }
  }
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() } else { 'none' }`
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    })
    const told = ran.status === 0 ? ran.stdout.trim() : ''
    if (told === 'none') return null
    if (/^\d+$/.test(told)) return told
  } else {
    for (const ps of ['/bin/ps', 'ps']) {
      // Asked for in one language and one time zone, so that it is told in the same words whenever it is asked
      const ran = spawnSync(ps, ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        timeout: 30_000,
      })
      if (ran.error) continue
      const [state, ...when] = ran.status === 0 ? ran.stdout.trim().split(/\s+/) : []
      if (state?.startsWith('Z')) return null
      if (state && when.length) return when.join(' ')
      break
    }
  }
  // The system would not say when. Whether there is such a process at all, it does say.
  return alive(pid) ? undefined : null
}

/**
 * When this program itself was started, asked for once: it does not change while the program
 * runs, and on Windows each asking starts another program to answer it, which a lock that is
 * tried many times a second cannot wait for. Empty where the system would not say, and then
 * asked again the next time.
 */
let startedAs: string | undefined
const startedMyself = (): string => {
  if (!startedAs) startedAs = startOf(process.pid) || undefined
  return startedAs ?? ''
}

let here: string | undefined
/**
 * Where a process number means something: on the machine that gave it out, since that machine
 * was last started. A lock names its holder by a number, and says where the number is from.
 * Linux has a word for each time the machine is started, and one for each set of numbers it
 * gives out. Elsewhere a process's start is told as a date and a time, which a later process
 * under the same number shares only if it was started within the same second, and the
 * machine's name stands for the machine.
 */
function where(): string {
  if (here === undefined) {
    here = os.hostname()
    if (process.platform === 'linux')
      try {
        here = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()} ${readlinkSync('/proc/self/ns/pid')}`
      } catch {}
  }
  return here
}

// ---------- one at a time ----------

const lockFile = () => path.join(backendFolder(), 'lock')
const BEAT_MS = 5_000 // how often whoever holds a lock touches it
const STALE_MS = 30_000 // and how long a lock from elsewhere is watched, untouched, before it is nobody's
/**
 * Who holds a lock: a process, by its number, when it was started and where, and by a word of
 * its own for this one time. The backend's lock says as well where the backend program is to
 * answer, written before the program is started, and which process the program is, written as
 * soon as it has been.
 */
interface Lock {
  pid: number
  started: string
  where: string
  holder: string
  api?: string
  program?: number
  programStarted?: string
}
interface Held {
  /** Notes beside the holder what the lock is to say of the backend program. Refused when the lock has come to be another's. */
  note(more: Pick<Lock, 'api' | 'program' | 'programStarted'>): void
  /** Lets the lock go. */
  release(): void
  /** Leaves the lock where it is and stops looking after it: a program is still running on the folder, and the next service has to find it. */
  abandon(): void
  /** Called if the lock turns out to be another's while this one has it. */
  lost: () => void
}
/** A lock as it was found: what it says, the word that names it, and when it was last touched. One that is not whole says nothing, and is named by the file it is. */
interface Seen {
  lock: Lock | null
  word: string
  touched: number
}

function see(file: string): Seen | undefined {
  let touched: number
  let inode: number
  try {
    const stat = statSync(file)
    touched = stat.mtimeMs
    inode = stat.ino
  } catch {
    return undefined
  }
  const read = readJson<Lock>(file)
  const lock =
    read &&
    Number.isInteger(read.pid) &&
    typeof read.started === 'string' &&
    typeof read.where === 'string' &&
    typeof read.holder === 'string' &&
    /^[0-9a-f]{16}$/.test(read.holder)
      ? read
      : null
  return { lock, word: lock ? lock.holder : `unread-${inode}-${Math.floor(touched)}`, touched }
}

/**
 * Makes a lock where there is none, which only one program can. It is written first and then
 * given its name, so it is never seen half written. Whether it was made.
 */
function make(file: string, lock: Lock): boolean {
  const whole = `${file}.${lock.holder}.tmp`
  writeFlushed(whole, JSON.stringify(lock))
  return makeOnce(whole, file)
}
/** Puts a lock in the place of the one that is there, whole. */
function put(file: string, lock: Lock): void {
  const whole = `${file}.${lock.holder}.tmp`
  writeFlushed(whole, JSON.stringify(lock))
  rename(whole, file)
}

/**
 * Whether whoever a lock names still has it. On the machine the lock was made on, since it was
 * last started, that is whether the process it names is running: the very one, by its number
 * and when it was started, and where the system does not say when, or the lock does not, it
 * is taken to be. A lock from anywhere else, or one that is not whole, names nothing that can
 * be asked after from here. Its holder touches it every few seconds for as long as it lives,
 * so the lock is watched: touched while it is watched, it is held, and left alone for the
 * whole of that time, it is nobody's. Only the watching counts, by this machine's own measure
 * of time passing. When the lock says it was last touched is never held against the clock,
 * since the two may be kept by different machines, or the clock set anew in between.
 * `changed` when the lock was let go or replaced while it was watched.
 */
async function fateOf(file: string, seen: Seen, opts: { watching?: () => void; signal?: AbortSignal }): Promise<'held' | 'left' | 'changed'> {
  if (seen.lock && seen.lock.where === where()) {
    const started = startOf(seen.lock.pid)
    return started === undefined || started === seen.lock.started || (started !== null && seen.lock.started === '') ? 'held' : 'left'
  }
  opts.watching?.()
  for (const began = performance.now(); ; ) {
    if (opts.signal?.aborted) throw stopped()
    await sleep(250)
    const now = see(file)
    if (!now || now.word !== seen.word) return 'changed'
    if (now.touched !== seen.touched) return 'held'
    if (performance.now() - began >= STALE_MS) return 'left'
  }
}

/**
 * Takes a lock: a file only one program can make. Where there is none, making it is all there
 * is to it. One whose holder is gone is never removed, since two programs that both found it
 * left would each remove what the other had just put there. It is replaced, and only by the
 * one program that has made a second file, named after the word of the lock that was left:
 * only one can make that either, and it puts its own lock in the other's place only while the
 * one that was left is still what is there. Should the program that made the second file be
 * gone as well, a third is made after its word, and so on. Whoever comes to hold the lock
 * takes those files away.
 *
 * `taken` is what is said when another holds the lock, or is taking it. `left` is called with
 * the lock of a holder that is gone, by the one program that may replace it and before it
 * does, and what it throws leaves that lock as it was found. `watching` is called once if a
 * lock has to be watched for a while before it can be told to be held or left.
 */
async function takeLock(
  file: string,
  opts: { taken: (by: Lock | null) => Problem; left?: (lock: Lock) => Promise<void>; watching?: () => void; signal?: AbortSignal },
): Promise<Held> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Where the system will not say when this program was started, its lock says nothing of it,
  // and is believed for as long as a process has its number
  const me: Lock = { pid: process.pid, started: startedMyself(), where: where(), holder: randomBytes(8).toString('hex') }
  let said = false
  const watched = {
    signal: opts.signal,
    watching: () => {
      if (!said) opts.watching?.()
      said = true
    },
  }
  take: for (let attempt = 0; !make(file, me); attempt++) {
    if (attempt >= 20) throw new Problem('It could not take its lock: another program keeps putting one in its place.', 'lock_not_taken')
    const seen = see(file)
    if (!seen) continue
    const fate = await fateOf(file, seen, watched)
    if (fate === 'changed') continue
    if (fate === 'held') throw opts.taken(seen.lock)
    let word = seen.word
    let after: string
    for (;;) {
      after = `${file}.after.${word}`
      if (make(after, me)) break
      const theirs = see(after)
      if (!theirs) continue take
      const fate = await fateOf(after, theirs, watched)
      if (fate === 'changed') continue take
      // Another is taking the lock at this very moment
      if (fate === 'held') throw opts.taken(theirs.lock)
      word = theirs.word
    }
    // The lock that was left is looked at again, now that no other program can replace it:
    // one that did so a moment ago has it, and is alive
    const still = () => see(file)?.word === seen.word
    try {
      if (still() && seen.lock) await opts.left?.(seen.lock)
    } catch (err) {
      rmSync(after, { force: true })
      throw err
    }
    if (!still()) {
      rmSync(after, { force: true })
      continue
    }
    put(file, me)
    break
  }
  // What is left of the taking of a lock that is no more: no lock that stands is named in it.
  // Only what this taking makes goes: a file under one of the names it gives, with a lock in
  // it. Anything else beside the lock is somebody's own, whatever it is called.
  const folder = path.dirname(file)
  const [after, unnamed] = [/^\.after\.(?:[0-9a-f]{16}|unread-\d+-\d+)$/, /^(?:\.after\.(?:[0-9a-f]{16}|unread-\d+-\d+))?\.[0-9a-f]{16}\.tmp$/]
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(`${path.basename(file)}.`)) continue
    const rest = name.slice(path.basename(file).length)
    const beside = path.join(folder, name)
    try {
      // One that has no name yet may be another's that is being made at this moment
      if (!(unnamed.test(rest) ? Date.now() - statSync(beside).mtimeMs > 60_000 : after.test(rest))) continue
      if (lstatSync(beside).isFile() && see(beside)?.lock) rmSync(beside, { force: true })
    } catch {}
  }
  const mine = () => readJson<Lock>(file)?.holder === me.holder
  let kept = true
  const held: Held = {
    note: (more) => {
      if (!mine()) throw opts.taken(readJson<Lock>(file))
      put(file, { ...me, ...more })
    },
    release: () => {
      if (kept && mine()) rmSync(file, { force: true })
      held.abandon()
    },
    abandon: () => {
      kept = false
      clearInterval(beat)
    },
    lost: () => {},
  }
  const beat = setInterval(() => {
    if (!mine()) {
      // Said once: the lock has stopped being this program's to look after
      held.abandon()
      return held.lost()
    }
    try {
      const now = new Date()
      utimesSync(file, now, now)
    } catch {}
  }, BEAT_MS)
  beat.unref()
  return held
}

/**
 * Does one thing at a time for this folder. `run` has the folder to itself for as long as it
 * takes, and another that is under way, in this program or in any other, is waited for, for as
 * long as `forMs` says. The lock is a file of its own in It's folder, named for what is done,
 * and taken as the backend's is.
 */
export async function alone<T>(what: string, run: () => Promise<T>, forMs = 120_000): Promise<T> {
  const until = Date.now() + forMs
  let held: Held
  for (;;) {
    try {
      held = await takeLock(inHome(`${what}.lock`), {
        taken: () => new Problem('Another `it` command is doing the same thing for this folder, and has not finished.', 'busy', 'Try again in a moment.'),
      })
      break
    } catch (err) {
      if (!(err instanceof Problem && err.code === 'busy') || Date.now() >= until) throw err
      await sleep(50 + Math.random() * 100)
    }
  }
  try {
    return await run()
  } finally {
    held.release()
  }
}

/** Whether a backend that answers at an address is the one of that name. */
async function answers(api: string, name: string): Promise<boolean> {
  try {
    const answer = await direct(`${api}/instance_name`, { signal: AbortSignal.timeout(2000) })
    return answer.ok && (await answer.text()) === name
  } catch {
    return false
  }
}

// ---------- which programs are on the folder ----------

const DATABASE = 'db.sqlite3'
/**
 * The language `ps` is asked in: one in which a folder's name comes back with every letter it
 * has. Asked in the plainest one, `ps` puts a mark in the place of each letter outside it.
 */
const LISTED_IN = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'

/** What tells a file or a folder from every other on this machine, by whatever name it is reached. Nothing where there is no such file, or the system does not tell files apart so. */
function identity(file: string): string | undefined {
  try {
    const stat = statSync(file, { bigint: true })
    return stat.ino > 0n ? `${stat.dev}:${stat.ino}` : undefined
  } catch {
    return undefined
  }
}
/** Whether a folder, as some program names it, is this It's backend folder: that very folder, by whatever name it was reached. */
function ourFolder(folder: string): boolean {
  const [theirs, ours] = [identity(folder), identity(backendFolder())]
  if (theirs !== undefined && ours !== undefined) return theirs === ours
  const plain = (name: string) => (process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name))
  return plain(folder) === plain(backendFolder())
}
/**
 * What a command line names as its database, where the system gives the line in one piece:
 * this folder's, by its name in this folder, the very file under a name in another folder, or
 * neither. A folder's name may have spaces in it, which such a line does not tell from the
 * spaces between its words, so every place where the database's address could begin is tried.
 * The folder and the file are known by what tells each from every other, so they are the same
 * however their names are written.
 */
function databaseNamed(line: string): 'ours' | 'linked' | undefined {
  let linked = false
  for (const found of line.matchAll(/db\.sqlite3/gi)) {
    const end = found.index + DATABASE.length
    if (line[end] !== undefined && line[end] !== ' ' && line[end] !== '"') continue
    for (let at = 0; at < found.index; at++) {
      if (at > 0 && line[at - 1] !== ' ' && line[at - 1] !== '"') continue
      const named = line.slice(at, end)
      if (!path.isAbsolute(named)) continue
      if (ourFolder(path.dirname(named)) && (path.basename(named) === DATABASE || sameFile(named, databaseFile()))) return 'ours'
      linked ||= identity(named) !== undefined && identity(named) === identity(databaseFile())
    }
  }
  return linked ? 'linked' : undefined
}
/** That a backend program has this folder's database open, or was started on it, from another folder, where the database has a second name. It is that folder's, and nothing is started on the database beside it. */
const linked = (pid: number) =>
  new Problem(
    `A backend program that runs in another folder has this folder’s database (pid ${pid}): the database has a second name there. It is not this folder’s to stop, and no backend program is started on the database beside it.`,
    'still_running',
    'One backend program at a time can have a database. Stop It for the other folder, or give one of the two folders a database of its own in the place of the shared one, then start It again.',
  )
/**
 * That a backend program runs under the name this folder's settings give its backend, and
 * nothing the system shows says where. It may be one left on this folder, started when the
 * folder was called something else. It may as well run for a copy of this folder, which has
 * the same settings and so the same name. The name alone does not tell the two apart, so the
 * program is asked nothing, and nothing is started beside it.
 */
const namedAlike = (pid: number) =>
  new Problem(
    `A backend program runs under the name this folder’s settings give its backend (pid ${pid}), and nothing It can see says that it runs on this folder’s database. A copy of this folder gives its backend the same name, so It asks the program nothing, and starts no backend program beside it.`,
    'still_running',
    'If it was left on this folder, as it may have been before the folder was given another name, end it with an interrupt, as Ctrl-C at a terminal would. If it runs for a copy of this folder, stop It there. Then start It again.',
  )
/**
 * What Linux shows of where a process is: whether it runs in this folder, and whether it has
 * this folder's database open. A process that has the database open and runs in another
 * folder has it under a second name the file has there. Nothing where the system shows neither
 * the folder nor the files of the process, which is so of every process on a system that is
 * not Linux.
 */
function seen(pid: number | string): { here: boolean; open: boolean } | undefined {
  if (process.platform !== 'linux') return undefined
  const runsIn = identity(`/proc/${pid}/cwd`)
  let opens: Set<string | undefined> | undefined
  try {
    opens = new Set(readdirSync(`/proc/${pid}/fd`).map((one) => identity(`/proc/${pid}/fd/${one}`)))
  } catch {}
  if (runsIn === undefined && opens === undefined) return undefined
  const database = identity(databaseFile())
  return { here: runsIn !== undefined && runsIn === identity(backendFolder()), open: database !== undefined && opens?.has(database) === true }
}

/**
 * That one of this account's own programs is running and the system would not say what it was
 * started with. Nothing then tells it from a backend program on this folder, so the list does
 * not say that the folder is free, and nothing is started.
 */
const untold = (pid: number, how: string) =>
  new Problem(
    `It could not see what one of this account’s own programs was started with (pid ${pid}), so it cannot tell whether a backend program is left on its folder, and starts none.`,
    'cannot_list_processes',
    how,
  )
/**
 * Whether a process of Linux's whose command line could not be read is one that keeps the list
 * from saying the folder is free: one of this account's own that is still there. A process
 * that has ended in the meantime is none. Neither is another account's, which cannot be a
 * backend program on a folder that is this person's alone. One of which the system does not
 * say whose it is, is taken for this account's.
 */
function withheld(pid: string, err: unknown): boolean {
  if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '')) return false
  try {
    return statSync(`/proc/${pid}`).uid === process.geteuid?.()
  } catch (unseen) {
    return (unseen as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
/**
 * Whether a name a system gives a process by, where it gives nothing else of it, could be the
 * backend program's: its own name or the name of the file It starts as the program, whole or
 * as its first fifteen letters or more, which is as far as such a name goes.
 */
function couldBeProgram(shown: string): boolean {
  const names = ['convex-local-backend', path.basename(programFile())].map((name) => name.replace(/\.exe$/i, '').toLowerCase())
  const name = shown.replace(/\.exe$/i, '').toLowerCase()
  return names.some((own) => own === name || (name.length >= 15 && own.startsWith(name)))
}

/**
 * The backend programs that run on this folder, as the system itself lists what is running:
 * every process that was started the way the backend program is and is on this folder. This is
 * what says whether a program is on the folder. What a lock notes of a program is written by a
 * service that may be gone before it has written it, and a program that answers on no port may
 * be running all the same.
 *
 * Linux says of each process which folder it runs in and which files it has open. A program
 * that runs in this folder is on it when it has the database open, or was started with a
 * database of that name and has yet to open it, whatever the folder was called when it was
 * started. One that has this folder's database open and runs in another folder is on the
 * database through a second name the file has there: it is that folder's to stop, so here
 * that is said, and nothing is started. And where Linux shows where a program runs and what
 * it has open, and neither is this folder's, the program is not on this folder, whatever its
 * command line names: a path written there is where the database was when the program was
 * started, and may since have come to be the name of another. What Linux shows is what is so
 * in the moment it is asked: a program in another folder that was started on a second name of
 * the database an instant ago, and has yet to open it, is not shown to have it.
 *
 * macOS is asked through `ps`, in a language that keeps every letter of a folder's name, and
 * Windows through PowerShell. Both give each command line in one piece and nothing of what a
 * program runs in or has open. There a program is on this folder when its command line names
 * this folder's database by its name in this folder. That is the name the database had when
 * the program was started: a folder that was given another name while its program ran, with
 * another database since put under the old name, is not told apart there, and neither is a
 * database with a second name in a folder whose own name is not in the command line. A program
 * whose command line names the very file under another folder's name is said to be that
 * folder's, as on Linux. And one that only runs under `name`, the name this folder's settings
 * give its backend, may be this folder's or a copy's: it is asked nothing, and nothing is
 * started beside it. The same goes on Linux for a process of which the system shows neither
 * the folder nor the files. Where the system cannot be asked at all, that is said, and nothing
 * is started: nothing else tells that the folder is free.
 *
 * The list says that the folder is free only where it could have shown a backend program on
 * it. A process of this account's own of which the system would not say what it was started
 * with could be one, so it counts as a list that could not be read: on Linux a command line
 * this account may not read, in what `ps` gives a process shown by the program's name alone,
 * on Windows a program of that name whose command line is kept back. Another account's
 * process that is hidden so cannot be a backend program on this person's folder, and is
 * passed over. A process that is on its way out is shown the same way for a moment, so one
 * that is hidden is looked for again before it counts. And a list that does not show this
 * very program is not taken for whole.
 */
export function programsHere(name: string, platform: NodeJS.Platform = process.platform): number[] {
  const found: number[] = []
  if (platform === 'linux' && existsSync('/proc/self/stat')) {
    let listed: string[] | undefined
    try {
      listed = readdirSync('/proc')
    } catch {}
    for (const pid of listed ?? []) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
      let words: string[]
      try {
        words = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      } catch (err) {
        if (withheld(pid, err))
          throw untold(
            Number(pid),
            `It reads /proc/${pid}/cmdline, which this account has to be let read. Something that confines It, such as a sandbox it was started in, may keep it from that.`,
          )
        continue
      }
      if (!words.some((word) => word === '--instance-name' || word.startsWith('--instance-name='))) continue
      const at = seen(pid)
      if (at === undefined) {
        // The system shows nothing of it, so what it was started with is all there is to go by
        if (words.some((word) => path.isAbsolute(word) && path.basename(word) === DATABASE && ourFolder(path.dirname(word)))) found.push(Number(pid))
        else if (words.some((word, n) => (word === '--instance-name' && words[n + 1] === name) || word === `--instance-name=${name}`))
          throw namedAlike(Number(pid))
      } else if (at.open && !at.here) throw linked(Number(pid))
      // One that runs in this folder is on it once it has the database, and before that when the database is what it was started with
      else if (at.open || (at.here && words.some((word) => path.basename(word) === DATABASE))) found.push(Number(pid))
    }
    if (listed) return found
  }
  /** Takes a command line in one piece for what it is, with the number of the process it is the line of. */
  const take = (pid: number, command: string, into: number[]) => {
    if (!/(?:^|\s)--instance-name(?:=|\s)/.test(command)) return
    const database = databaseNamed(command)
    if (database === 'ours') return void into.push(pid)
    if (database === 'linked') throw linked(pid)
    if (new RegExp(`(?:^|\\s)--instance-name(?:=|\\s+)["']?${name.replace(/[^A-Za-z0-9-]/g, '\\$&')}["']?(?:\\s|$)`).test(command)) throw namedAlike(pid)
  }
  // A process that the list hides is looked for again, twice and a moment apart, before it
  // keeps anything from being started: one that is on its way out is shown with nothing of
  // what it was started with for that moment, and is gone the next.
  for (let look = 0; ; look++) {
    let hidden: Problem | undefined
    if (platform === 'win32') {
      // Each command line comes back as base64, so that a folder's name is the same name whatever
      // the console would have made of its letters. A process whose command line Windows keeps
      // back is told of only where it has the backend program's name: whose it is, as far as
      // Windows says, and whether it is in the session this service is in. The list ends with a
      // word of its own, and has one for this very program.
      const names = [...new Set(['convex-local-backend.exe', path.basename(programFile())])].map(psQuote).join(', ')
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$session = (Get-Process -Id $PID).SessionId',
        `$names = @(${names})`,
        'Get-CimInstance Win32_Process -Property Handle, ProcessId, SessionId, Name, CommandLine | ForEach-Object {',
        '  $line = [string]$_.CommandLine',
        `  if ($_.ProcessId -eq ${process.pid}) { 'self' } elseif ($line) {`,
        "    if ($line.Contains('--instance-name')) { 'seen {0} {1}' -f $_.ProcessId, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)) }",
        '  } elseif ($names -contains $_.Name) {',
        "    $owner = 'unknown'",
        "    try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($o.ReturnValue -eq 0 -and $o.Sid) { $owner = if ($o.Sid -eq $me) { 'mine' } else { 'other' } } } catch { }",
        "    'unseen {0} {1} {2}' -f $_.ProcessId, $owner, [int]($_.SessionId -eq $session)",
        '  }',
        '}',
        "'end'",
      ].join('\n')
      const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      })
      if (!ran.error && ran.status === 0) {
        const rows = ran.stdout.split(/\r?\n/).map((line) => line.trim())
        const here: number[] = []
        for (const row of rows) {
          const [, pid, coded] = /^seen (\d+) ([A-Za-z0-9+/=]+)$/.exec(row) ?? []
          if (pid !== undefined && coded !== undefined) take(Number(pid), Buffer.from(coded, 'base64').toString('utf8'), here)
          const [, unseen, whose, near] = /^unseen (\d+) (mine|other|unknown) ([01])$/.exec(row) ?? []
          // Its own account's, or nobody's that Windows will name and in this very session, where another account's is not
          if (unseen !== undefined && (whose === 'mine' || (whose === 'unknown' && near === '1')))
            hidden ??= untold(
              Number(unseen),
              'It has the backend program’s name, and Windows keeps back what it was started with, as it does of a program started as an administrator. If it is a backend program, end it, then start It again.',
            )
        }
        if (!hidden && rows.includes('end') && rows.includes('self')) return here
      }
    } else {
      for (const ps of ['/bin/ps', 'ps']) {
        const ran = spawnSync(ps, ['-axww', '-o', 'pid=', '-o', 'uid=', '-o', 'stat=', '-o', 'command='], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: LISTED_IN },
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        })
        if (ran.error || ran.status !== 0) continue
        const here: number[] = []
        let self = false
        for (const line of ran.stdout.split('\n')) {
          const [, pid, uid, state, command = ''] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line) ?? []
          if (pid === undefined || state === undefined) continue
          if (Number(pid) === process.pid) {
            self = true
            continue
          }
          // One that has ended, and has only not been collected yet, has nothing open
          if (state.startsWith('Z')) continue
          // A process whose command line `ps` was not given is shown by its name alone, between brackets
          const [, shown] = /^[([](.+)[)\]]$/.exec(command.trim()) ?? []
          if (shown !== undefined && Number(uid) === process.geteuid?.() && couldBeProgram(shown))
            hidden ??= untold(
              Number(pid),
              'It is shown in the list of what runs by its name alone, which is the backend program’s. If it is a backend program, end it with an interrupt, as Ctrl-C at a terminal would, then start It again.',
            )
          if (shown === undefined) take(Number(pid), command, here)
        }
        if (hidden) break
        if (self) return here
      }
    }
    if (!hidden) break
    if (look >= 2) throw hidden
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
  }
  throw new Problem(
    'It could not look through the programs running on this machine for a backend program left on its folder, so it starts none.',
    'cannot_list_processes',
    platform === 'win32'
      ? 'It asks Windows through PowerShell, with `Get-CimInstance Win32_Process`, which has to be allowed to run.'
      : 'It reads them with `ps`, which has to be on this machine.',
  )
}

/** Whether two names are names of one file, by what tells a file from every other, and where the system tells nothing of the kind, by the names. */
function sameFile(one: string, other: string): boolean {
  const [a, b] = [identity(one), identity(other)]
  if (a !== undefined && b !== undefined) return a === b
  const plain = (name: string) => (process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name))
  return plain(one) === plain(other)
}
/**
 * Whether a name is the backend program's own. Where a system tells of a program by the first
 * letters of its name alone, fifteen or more of them that begin the name are taken for it.
 */
const namedProgram = (name: string): boolean => {
  const own = name.replace(/\.exe$/i, '')
  return own === 'convex-local-backend' || (own.length >= 15 && 'convex-local-backend'.startsWith(own))
}

/**
 * Whether what runs under a number is the backend program itself, as the system tells of the
 * file a process runs: it is the very file It starts as the backend program, or a file of the
 * backend program's own name, as one fetched for another release is. Not so wherever the
 * system does not tell, and for whatever else runs there: a program that was only started with
 * what the backend program is started with is nothing It may ask to stop.
 *
 * Linux says which file a process runs, and Windows does, by its name and where it has the
 * right to say, by its address. macOS says what a process was started as, which for the
 * backend program is the address of its file.
 */
function runsProgram(pid: number): boolean {
  const told = (file: string) => Boolean(file) && (sameFile(file, programFile()) || namedProgram(path.basename(file)))
  if (process.platform === 'linux') {
    try {
      // A file that has since been removed, as the program of an earlier release is, is told with a word after its name
      return sameFile(`/proc/${pid}/exe`, programFile()) || namedProgram(path.basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')))
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') {
    const coded = (what: string) => `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]${what}))`
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { 'is {0} {1}' -f ${coded('$p.Name')}, ${coded('$p.ExecutablePath')} } else { 'none' }`
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    })
    const [, name, file] = /^is ([A-Za-z0-9+/=]+)(?: ([A-Za-z0-9+/=]+))?$/.exec(ran.status === 0 ? ran.stdout.trim() : '') ?? []
    const plain = (coded64: string | undefined) => (coded64 ? Buffer.from(coded64, 'base64').toString('utf8') : '')
    return told(plain(file)) || (!file && told(plain(name)))
  }
  for (const ps of ['/bin/ps', 'ps']) {
    const ran = spawnSync(ps, ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: LISTED_IN }, timeout: 30_000 })
    if (ran.error) continue
    return ran.status === 0 && told(ran.stdout.trim())
  }
  return false
}

/**
 * Asks a backend program that no service holds to stop, and waits until it has gone. One that
 * is still there after a minute keeps another from being started. On Windows, where a program
 * cannot be counted on to hear, it is ended once it has had its time (see `halt`).
 *
 * Nothing is asked to stop that the system does not show to be the backend program, whatever
 * it was started with and whatever a lock says of its number: such a process is left alone,
 * and keeps a backend program from being started beside it.
 */
async function stopLeft(pid: number, say: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const started = startOf(pid)
  if (started === null) return
  const its = runsProgram(pid)
  // The number may have come to be another process's while that was looked at
  const still = startOf(pid)
  if (still === null) return
  if (!its || still !== started) {
    say(`backend: a program that may be one left on this folder cannot be told to be the backend program, and is not asked to stop (pid ${pid})`)
    throw new Problem(
      `A program on this machine may be a backend program left on this folder (pid ${pid}), and It cannot tell that what runs there is the backend program. It is not asked to stop, and no backend program is started beside it.`,
      'still_running',
      'If it is a backend program, end it with an interrupt, as Ctrl-C at a terminal would. If it is something else, end it or wait until it has ended. Then start It again.',
    )
  }
  say(`backend: one left running by a service that is gone is asked to stop (pid ${pid})`)
  // On Linux the system says of each process when it was started for the price of reading a file
  const there = () => (process.platform === 'linux' && started !== undefined ? startOf(pid) === started : alive(pid))
  const gone = async (ms: number) => {
    for (const until = Date.now() + ms; there(); await sleep(100)) {
      if (signal?.aborted) throw stopped()
      if (Date.now() >= until) return false
    }
    return true
  }
  const unasked = interrupt(pid)
  if (process.platform === 'win32') {
    if ((unasked || !(await gone(HEARD_MS))) && there()) {
      say(`backend: one left running did not stop when asked, and is ended (pid ${pid}${unasked ? `, ${unasked}` : ''})`)
      try {
        process.kill(pid)
      } catch {}
    }
    if (await gone(ENDED_MS)) return
  } else if (await gone(60_000)) return
  throw new Problem(
    `A backend program left running on this folder has not stopped (pid ${pid}).`,
    'still_running',
    process.platform === 'win32'
      ? 'It was asked to stop, and Windows would not end it. End it yourself, then start It again.'
      : 'It was asked to stop and is never killed. End it yourself, then start It again.',
  )
}

/**
 * Makes sure that no backend program is on this folder before one is started on it: two that
 * wrote the same database would ruin it, and the program does not guard against that itself.
 * It is called by the one program that has the folder to itself: when the lock of a service
 * that is gone is taken over, with that lock, and again before the program is started,
 * whatever lock there was or was not.
 *
 * The system's own list of what is running is looked through, and every backend program on
 * this folder is asked to stop and waited for. A lock may also name the program its service
 * started, by its number and when it was started: that process and no other is asked to stop
 * in the same way, should the list not have shown it. One that does not go, or a process under
 * that number that cannot be told to be the program, keeps another from being started. So
 * does a list that could not have shown a backend program on the folder, and so does whatever
 * the list shows as one that the system does not show to be the backend program itself: that
 * is asked nothing.
 *
 * A program that answers on no port is not thereby gone, and nothing is concluded from it. The
 * other way about it does count: a backend that answers under this folder's name, where the
 * lock said one was to answer or where this one is about to, is one that the list did not
 * show, and it keeps another from being started. Only this machine's own address is asked.
 */
async function noneLeft(config: ServiceConfig, say: (line: string) => void, signal?: AbortSignal, left?: Lock): Promise<void> {
  // A service that was gone in the very moment it started the program may have left one that
  // is not yet in the list as the backend program. The lock then says that a start was under
  // way and names no process, and the list is read again a moment later.
  let again = left !== undefined && typeof left.api === 'string' && left.program === undefined
  const name = instanceName(config.instanceSecret)
  for (let round = 0; ; round++) {
    const found = programsHere(name)
    if (!found.length && again) {
      again = false
      await sleep(1000)
      continue
    }
    if (!found.length) break
    if (round >= 5)
      throw new Problem(
        `Backend programs go on being started on this folder while It asks them to stop (pid ${found[0]}).`,
        'still_running',
        'Stop whatever starts them, then start It again.',
      )
    for (const pid of found) await stopLeft(pid, say, signal)
  }
  const pid = left?.program
  // A number that is no process's own would mean every process in this program's group
  if (left && left.where === where() && typeof pid === 'number' && Number.isInteger(pid) && pid > 1) {
    const started = startOf(pid)
    if (started === undefined || (started !== null && typeof left.programStarted !== 'string'))
      throw new Problem(
        `A program is running under the number the backend program on this folder had (pid ${pid}), and It cannot tell whether it is that one.`,
        'still_running',
        `If it is the backend program, end it with an interrupt, as Ctrl-C at a terminal would. When no backend program is running on this folder, remove ${lockFile()} and start It again.`,
      )
    // The lock goes wherever the folder is copied to, and the program it names may be the
    // one of the folder it was copied from: where the system shows that, it is not this folder's
    if (started !== null && started === left.programStarted) {
      const at = seen(pid)
      if (at?.open && !at.here) throw linked(pid)
      if (at === undefined || at.here || at.open) await stopLeft(pid, say, signal)
    }
  }
  const noted = typeof left?.api === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(left.api) ? [left.api] : []
  for (const api of new Set([...noted, backendAt(config.port).api])) {
    if (signal?.aborted) throw stopped()
    if (await answers(api, name))
      throw new Problem(
        `A backend program answers for this folder at ${api}, and It does not know which process it is.`,
        'still_running',
        'End it with an interrupt, as Ctrl-C at a terminal would, then start It again. It is the program named convex-local-backend that was started with this folder’s database.',
      )
  }
}

// ---------- what is noted of the database ----------

/**
 * What It notes of the database, in a file beside it, so that the note goes wherever the
 * database goes and is lost only with it. It is read once the folder is this service's alone.
 */
interface Note {
  /** When this program began a database where there was none. */
  made?: number
  /** The release of the backend program that last ran on the database, and the version of It that ran it. */
  release?: string
  it?: string
  /** The hash of the functions last loaded, and of those functions together with their settings. */
  functions?: string
  load?: string
  /** The version of It those functions are the functions of. */
  functionsOf?: string
  /** The port It counted from when they were loaded, which they go on believing until others are loaded. */
  port?: number
  /** The functions this start of the service is loading: noted before the first of them goes in, and taken out when it is known how the loading ended. */
  loading?: string
  /**
   * What is not known of the database from earlier starts: functions whose loading was begun
   * and of which the end was never learned, and the newest It that began such a loading. They
   * may be in the database or not. Only a loading that is known to have gone in settles it: one
   * that the backend refuses leaves the database as it was, and so leaves this as it was too.
   */
  unsettled?: { it: string; functions: string[] }
  behind?: Behind
}
const noteFile = () => path.join(backendFolder(), 'data.json')
const databaseFile = () => path.join(backendFolder(), 'db.sqlite3')

/**
 * The note as the file holds it. Nothing is known where there is no file. A file that is there
 * and is not a note as It writes one is not taken for a note that says nothing: the note is
 * what says which It and which backend program the database is at, so whatever was about to
 * go by it stops, and the person is told.
 */
function readNote(): Note {
  if (!existsSync(noteFile())) return {}
  const read = readJson<Record<string, unknown>>(noteFile())
  if (!read || typeof read !== 'object' || Array.isArray(read))
    throw unread(
      `What It notes of its database, in ${noteFile()}, is not as It wrote it.`,
      'It says there which It and which backend program the database is at, and It does not start on the database without knowing. Put the file back as it was. If that cannot be done, move it away: It then takes the database for one it knows nothing of, and keeps a copy of it before it goes on.',
    )
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const behind = read.behind as Partial<Behind> | undefined
  const unsettled = read.unsettled as Partial<NonNullable<Note['unsettled']>> | undefined
  const note: Note = {
    made: typeof read.made === 'number' ? read.made : undefined,
    release: text(read.release),
    it: text(read.it),
    functions: text(read.functions),
    load: text(read.load),
    functionsOf: text(read.functionsOf),
    port: typeof read.port === 'number' ? read.port : undefined,
    loading: text(read.loading),
    unsettled:
      unsettled && typeof unsettled.it === 'string' && Array.isArray(unsettled.functions) && unsettled.functions.every((hash) => typeof hash === 'string')
        ? { it: unsettled.it, functions: unsettled.functions }
        : undefined,
    behind:
      behind && typeof behind.functions === 'string' && (behind.why === 'refused' || behind.why === 'no_copy') && typeof behind.at === 'number'
        ? { functions: behind.functions, why: behind.why, at: behind.at }
        : undefined,
  }
  return Object.fromEntries(Object.entries(note).filter(([, value]) => value !== undefined))
}
const writeNote = (note: Note) => writeWhole(noteFile(), note)

/**
 * How the database stands, for whoever tells a person: `it status`, and the site. Which release
 * of the backend program last ran on it and which version of It that was, the hash of the
 * functions in it and the version of It they are the functions of, and `behind` when those
 * are not the functions of the version of It that runs. Null where there is no database yet,
 * and where what is noted of it cannot be read: nothing is said of the database then, and it
 * is the service's start that says why.
 */
export function standing(): Pick<Note, 'release' | 'it' | 'functions' | 'functionsOf' | 'behind'> | null {
  if (!existsSync(noteFile())) return null
  try {
    const { release, it, functions, functionsOf, behind } = readNote()
    return Object.fromEntries(Object.entries({ release, it, functions, functionsOf, behind }).filter(([, value]) => value !== undefined))
  } catch {
    return null
  }
}

/** How one thing stands to another in time. `unknown` where the two are not the same and cannot be put in order. */
type Order = 'older' | 'same' | 'newer' | 'unknown'
/**
 * How a release of the backend program stands to another. A release's name carries the day it
 * was made, by which an older one is told from a newer. Two of the same day, or a name with no
 * day in it, cannot be put in order.
 */
function releaseTo(release: string, other: string): Order {
  if (release === other) return 'same'
  const day = (name: string) => /\d{4}-\d{2}-\d{2}/.exec(name)?.[0]
  const [a, b] = [day(release), day(other)]
  return a === undefined || b === undefined || a === b ? 'unknown' : a < b ? 'older' : 'newer'
}
/**
 * How a version of It stands to another: by its three numbers, and where those are the same,
 * a version with something after them, as one made before a release has, comes before the one
 * without. A version that is not written so cannot be put in order.
 */
function versionTo(version: string, other: string): Order {
  if (version === other) return 'same'
  const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  const [a, b] = [parts(version), parts(other)]
  if (!a || !b) return 'unknown'
  for (const n of [1, 2, 3]) if (Number(a[n]) !== Number(b[n])) return Number(a[n]) < Number(b[n]) ? 'older' : 'newer'
  if (a[4] === undefined || b[4] === undefined) return a[4] === b[4] ? 'same' : a[4] === undefined ? 'newer' : 'older'
  const [p, q] = [a[4].split('.'), b[4].split('.')]
  for (let n = 0; n < Math.max(p.length, q.length); n++) {
    const [x, y] = [p[n], q[n]]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? 'older' : 'newer'
    const [i, j] = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (i && j) return Number(x) < Number(y) ? 'older' : 'newer'
    if (i !== j) return i ? 'older' : 'newer'
    return x < y ? 'older' : 'newer'
  }
  return 'same'
}

/**
 * Refuses to go on where what is noted of the database says that this It is not to be started
 * on it: the functions in it are those of an It newer than this one, or may be, or a backend
 * program newer than the one this It runs has run on it. Either may have left the database as
 * only it and its successors read it.
 *
 * The database is at a version of It once that version's functions are in it, and not before:
 * a newer It whose functions the database refused has served with the ones that were there,
 * and the It those came with may be run on it again. A loading whose end was never learned may
 * have put its functions in, so the It that began it is the one the database is taken to be
 * at, until a loading is known to have gone in.
 *
 * Where two cannot be put in order, this It is taken for the older: a version that is not
 * written as It writes them, or another build of the backend program from the same day, which
 * only an It newer than the one that last ran the program may start in the other's place.
 * Nothing is noted, and nothing is started, before this has been looked at.
 */
function notOlder(note: Note): void {
  const at = note.unsettled ? note.unsettled.it : note.functionsOf
  const it = at === undefined ? undefined : versionTo(VERSION, at)
  const ran = note.it === undefined ? undefined : versionTo(VERSION, note.it)
  const program = note.release === undefined ? undefined : releaseTo(RELEASE, note.release)
  const itOlder = it === 'older' || it === 'unknown'
  const programOlder = program === 'older' || (program === 'unknown' && ran !== 'newer')
  if (!itOlder && !programOlder) return
  const copy = 'A copy of the database from before that It changed it, if it made one, is in a folder there whose name begins with "before-".'
  const than = it === 'older' ? 'is newer than' : 'cannot be told to be older than'
  if (itOlder)
    throw new Problem(
      note.unsettled
        ? `It ${at} began to load its functions into what It keeps in ${backendFolder()}, and how that ended was never learned. It ${than} this It ${VERSION}, and an older It is not started on what may have a newer one’s functions in it.`
        : `What It keeps in ${backendFolder()} has the functions of It ${at} in it, which ${than} this It ${VERSION}. An older It is not started on it.`,
      'backend_older',
      `Install It ${at} or a newer one. ${copy}`,
    )
  throw new Problem(
    `What It keeps in ${backendFolder()} was last run by ${note.it ? `It ${note.it}` : 'another It'}, with a backend program that ${program === 'older' ? 'is newer than' : 'cannot be told to be older than'} the one this It ${VERSION} runs. An older program is not started on it.`,
    'backend_older',
    `${note.it && ran !== 'same' && ran !== 'newer' ? `Install It ${note.it} or a newer one.` : 'Install the newest It.'} ${copy}`,
  )
}

/**
 * The note with what an earlier start left unlearned put where it is kept. A loading that an
 * earlier start began, and that is still noted as under way, never came to an end that was
 * learned: its functions are among those that may be in the database, and the It that began
 * it is the newest that began such a loading. It is kept apart from the loading this start may
 * begin, whose end, once learned, says nothing of the earlier one.
 */
function withUnsettled(note: Note): Note {
  if (note.loading === undefined) return note
  const { loading, ...rest } = note
  return { ...rest, unsettled: { it: note.it ?? note.unsettled?.it ?? '', functions: [...new Set([...(note.unsettled?.functions ?? []), loading])] } }
}

// ---------- copies of the database ----------

/**
 * What a copy says of itself, in a file inside it that only It writes: the name it was made
 * under, a word of its own that no other copy has, and when it was made and by which It.
 * `order` is its place among the copies as they were made, one more than the last before it.
 * Which copies are the last ones made is told by that and never by the time: a clock can be
 * set back, and the copy made after that would then say it was made before.
 *
 * `erased` is there on a copy that was made while the database's own file might still hold
 * what an erasing had removed. Such a copy holds that too, and nothing ever clears a copy, so
 * it is removed once the database's own file holds it no more (see `settleErased`).
 */
interface Copy {
  copy: string
  id: string
  made: number
  order: number
  it: string
  erased?: true
}
const COPY_NOTE = 'copy.json'
/** A release of the backend program, as its name is written. */
const RELEASE_NAMED = `(?:${RELEASE.replace(/[^A-Za-z0-9-]/g, '\\$&')}|precompiled-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{7,40})`
/**
 * The names It gives a copy: `before-`, and then the release of the backend program that was
 * about to be started on the database, the functions that were about to be loaded into it, or
 * both. While one is being made, and while one takes another's place, the folder has a word
 * of its own and `.part` or `.old` after that name.
 */
const COPY_NAMED = new RegExp(`^(before-(?:${RELEASE_NAMED}(?:-functions-[0-9a-f]{12})?|functions-[0-9a-f]{12}))(?:\\.[0-9a-f]{16}\\.(part|old))?$`)
/** A copy that is there, or what is left of making or replacing one, with the name of its folder. */
type CopyHere = Copy & { whole: boolean; entry: string }

/**
 * The copy that something beside the database is, where It made it: a folder whose name has
 * exactly the shape It gives one, with the file inside it that says it is the copy of that
 * name. `whole` unless it is what was left of making a copy or of replacing one.
 *
 * Whatever else is there is somebody's own, whatever it is called and whatever is in it: It
 * never removes it, gives it another name or writes into it. That goes for a folder of such a
 * name with no such file in it, and for one whose file names another copy.
 *
 * `unread` where the folder has such a name and the file is in it and is not as It writes it.
 * That may be a copy It made, with what was in the database in it, and It cannot tell: it is
 * left as it is, and whatever has to know of every copy there is says so and stops.
 */
function copyAt(entry: string, folder = backendFolder()): CopyHere | 'unread' | undefined {
  const [, name, left] = COPY_NAMED.exec(entry) ?? []
  if (!name) return undefined
  try {
    if (!lstatSync(path.join(folder, entry)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const file = path.join(folder, entry, COPY_NOTE)
  if (!lstatSync(file, { throwIfNoEntry: false })) return undefined
  const said = readJson<Partial<Copy>>(file)
  if (
    !said ||
    typeof said !== 'object' ||
    typeof said.copy !== 'string' ||
    typeof said.id !== 'string' ||
    !/^[0-9a-f]{16}$/.test(said.id) ||
    typeof said.made !== 'number' ||
    !Number.isSafeInteger(said.order) ||
    typeof said.it !== 'string' ||
    (said.erased !== undefined && said.erased !== true)
  )
    return 'unread'
  if (said.copy !== name) return undefined
  return {
    copy: name,
    id: said.id,
    made: said.made,
    order: said.order as number,
    it: said.it,
    ...(said.erased ? { erased: true } : {}),
    whole: left === undefined,
    entry,
  }
}
/** Every copy beside the database that It made, and what is left of making or replacing one. */
function copiesHere(folder = backendFolder()): CopyHere[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder).flatMap((entry) => {
    const copy = copyAt(entry, folder)
    return copy && copy !== 'unread' ? [copy] : []
  })
}
/**
 * Stops where a folder beside the database is named as a copy and does not say, in a way that
 * can be read, which copy it is. Whatever removes the copies an erasing covers has to know of
 * every copy there is, and does nothing until it does.
 */
function everyCopyRead(): void {
  const folder = backendFolder()
  if (!existsSync(folder)) return
  for (const entry of readdirSync(folder))
    if (copyAt(entry) === 'unread')
      throw unread(
        `The folder ${path.join(folder, entry)} is named as a copy It made of its database, and the file in it that says which copy it is, ${COPY_NOTE}, is not as It wrote it.`,
        'It may hold what was erased, and It removes only what it knows it made. Remove the folder yourself, or put the file in it back as it was.',
      )
}
/**
 * Removes a copy It made, or what is left of one. A whole copy first gives up its name for
 * that of one that is making way, and the file that says it is It's own goes last. So where
 * something in the copy cannot be removed, what stays is still known for a copy It made and is
 * removed the next time, and nothing that stays of it is ever in the way of the next copy
 * under that name.
 */
function removeCopy(entry: string, home = backendFolder()): void {
  const [, name, left] = COPY_NAMED.exec(entry) ?? []
  let folder = path.join(home, entry)
  if (name && !left) {
    const aside = path.join(home, `${name}.${randomBytes(8).toString('hex')}.old`)
    rename(folder, aside)
    folder = aside
  }
  for (const child of readdirSync(folder)) if (child !== COPY_NOTE) rmSync(path.join(folder, child), { recursive: true, force: true })
  rmSync(path.join(folder, COPY_NOTE), { force: true })
  rmdirSync(folder)
}

/**
 * Removes copies It made, and says how many whole ones went. One that cannot be removed does
 * not keep the others from going, and is what this fails with once they have.
 */
function removeAll(copies: { entry: string; whole: boolean }[], folder = backendFolder()): number {
  let gone = 0
  let failed: { err: unknown } | undefined
  for (const copy of copies) {
    try {
      removeCopy(copy.entry, folder)
      if (copy.whole) gone++
    } catch (err) {
      failed ??= { err }
    }
  }
  if (failed) throw failed.err
  return gone
}

/** Has a file, or a folder with everything in it, on the disk. A folder is told to the disk where the system lets one be. */
function flushed(file: string): void {
  const kind = lstatSync(file)
  // A link is copied as the link it is, and what it leads to is no part of the copy
  if (kind.isSymbolicLink()) return
  const folder = kind.isDirectory()
  if (folder) for (const name of readdirSync(file)) flushed(path.join(file, name))
  try {
    const open = openSync(file, folder ? 'r' : 'r+')
    try {
      fsyncSync(open)
    } finally {
      closeSync(open)
    }
  } catch (err) {
    if (!folder) throw err
  }
}

/**
 * Keeps a copy of the database as it is, in a folder beside it: the database's own files, the
 * files the backend keeps for it, and what is noted of it. It is made while no backend program
 * has the database, so it is whole, and it is given its name only once it is all there and on
 * the disk, before anything is changed in the database it is a copy of. The first thing in it
 * is the file that says it is a copy It made, so that even one that was cut short is known for
 * It's own. The two copies made last are kept, and the ones It made before them are removed:
 * which were made last is told by the order each says it was made in.
 *
 * A copy of the same name that It made earlier is replaced, unless `keep` says that it is the
 * one to keep: the copy from before a change that may since have been made. Something of that
 * name that It did not make is left as it is, and then there is no copy: that is said as
 * `in_the_way`.
 *
 * An earlier copy of It's own that is to go and cannot be removed just now does not make this
 * one any less of a copy. That is said, and it goes the next time.
 *
 * `erased` says that the database's file may still hold what an erasing removed, and the copy
 * says so of itself.
 */
function keepCopy(name: string, keep: boolean, erased: boolean, say: (line: string) => void): void {
  const folder = backendFolder()
  const to = path.join(folder, name)
  const there = copyAt(name)
  const earlier = there === 'unread' ? undefined : there
  if (!earlier && lstatSync(to, { throwIfNoEntry: false })) throw Object.assign(new Error('something else has the name of the copy'), { code: 'in_the_way' })
  if (keep && earlier) return
  const clear = (entry: string) => {
    try {
      removeCopy(entry)
    } catch (err) {
      const system = String((err as NodeJS.ErrnoException)?.code ?? '')
      say(`backend: an earlier copy of the database could not be removed (${/^E[A-Z0-9_]{2,30}$/.test(system) ? system : 'error'})`)
    }
  }
  // One more than any copy that is there says, what is left of one included: it is made under
  // the folder's lock, so no other copy is being made beside it
  const order = 1 + Math.max(0, ...copiesHere().map((other) => other.order))
  for (const left of copiesHere()) if (!left.whole) clear(left.entry)
  const word = randomBytes(8).toString('hex')
  const part = `${to}.${word}.part`
  mkdirSync(part, { mode: 0o700 })
  try {
    writeWhole(path.join(part, COPY_NOTE), { copy: name, id: word, made: Date.now(), order, it: VERSION, ...(erased ? { erased: true } : {}) } satisfies Copy)
    for (const file of readdirSync(folder)) {
      if (!file.startsWith('db.sqlite3') && file !== path.basename(noteFile())) continue
      copyFileSync(path.join(folder, file), path.join(part, file))
    }
    if (existsSync(path.join(folder, 'storage'))) cpSync(path.join(folder, 'storage'), path.join(part, 'storage'), { recursive: true })
    flushed(part)
    if (earlier) {
      const old = `${to}.${word}.old`
      rename(to, old)
      try {
        rename(part, to)
      } catch (err) {
        // The earlier one goes back where this one could not take its place
        rename(old, to)
        throw err
      }
    } else rename(part, to)
  } catch (err) {
    // What was begun of it is this program's own, made a moment ago under a name nothing else had
    try {
      if (existsSync(part)) removeCopy(path.basename(part))
    } catch {}
    throw err
  }
  if (earlier) clear(`${name}.${word}.old`)
  const others = copiesHere()
    .filter((other) => other.whole && other.entry !== name)
    .sort((a, b) => b.order - a.order)
  for (const other of others.slice(1)) clear(other.entry)
}

/**
 * What is remembered of an erasing: when the service was first told of it, and the copies of
 * the database there were at that moment, each by its own word.
 */
interface Erasing {
  at: number
  copies: string[]
}
/**
 * What the service keeps of the erasings it was told of, in a file beside the database. Each
 * is kept under a digest of the person's id, so that nothing names the person once everything
 * of theirs is gone. `ran` is for how long the backend program has run since an erasing was
 * last told of for the first time, in milliseconds.
 */
interface Erased {
  told: Record<string, Erasing>
  ran: number
}
const erasedFile = (folder = backendFolder()) => path.join(folder, 'erased.json')
/**
 * For how long after an erasing the database's own file may still hold what was erased, counted
 * while the backend program runs, which is the only time it clears anything out. What was
 * removed stays a row in the file for the hour the program is told to keep earlier versions.
 * The program's notes of the jobs that did the removing, with the ids those were given, are
 * removed an hour after each job ran, and stay rows for an hour more in their turn. Half an
 * hour is added for the minute or two the program takes to clear out each, and for what of its
 * running was not yet counted when a service was ended without a word.
 */
const erasedHeldMs = () => (2 * EARLIER_KEPT_S + 1800) * 1000
/** How often, while the backend program runs, its running is counted toward that time. */
const ERASED_COUNTED_MS = 15_000
/**
 * What is kept of the erasings, as the file holds it, and nothing where there is no file: the
 * service was then never told of one. A file that is there and is not as It wrote it is not
 * taken for one that tells of none. Told of an erasing again, It would take it for one it
 * hears of for the first time, and remove the copies made for whoever began again since, and
 * a copy made now would not say that it holds what was erased. So nothing goes on from it, and
 * the person is told.
 */
function erasedKept(folder = backendFolder()): Erased | undefined {
  const file = erasedFile(folder)
  if (!existsSync(file)) return undefined
  const read = readJson<Partial<Erased> | null>(file)
  const whole = (told: Partial<Erasing> | null): told is Erasing =>
    typeof told === 'object' && told !== null && typeof told.at === 'number' && Array.isArray(told.copies) && told.copies.every((id) => typeof id === 'string')
  if (
    !read ||
    typeof read !== 'object' ||
    typeof read.told !== 'object' ||
    read.told === null ||
    Array.isArray(read.told) ||
    !Object.values(read.told).every(whole) ||
    typeof read.ran !== 'number' ||
    !(read.ran >= 0)
  )
    throw unread(
      `What It keeps of the erasings it was told of, in ${file}, is not as It wrote it.`,
      'It says there which copies of the database each erasing removes, and It removes none without knowing. Put the file back as it was. If that cannot be done, move it away, and with it every folder there whose name begins with "before-": those are the copies, and It cannot tell which of them hold what was erased.',
    )
  return { told: Object.fromEntries(Object.entries(read.told).map(([person, told]) => [person, { at: told.at, copies: told.copies }])), ran: read.ran }
}

/**
 * Removes the copies of the database that It kept from before a change, with what is left of
 * making one, and says how many copies went. It is what the service does when a person has
 * erased everything: a copy holds what was erased, as it was when the copy was made. Nothing
 * but It's own copies is touched.
 *
 * `person` is the id of the person whose erasing this is. The service is told of one erasing
 * more than once, at the time and again later, and by then the person may have begun again and
 * It may have kept a copy of what they have made since. So the first time an erasing is told
 * of, the copies there are at that moment are written down, before any of them is removed, and
 * those are the copies that erasing removes, then and however often it is told of again. What
 * was written down is kept beside the database, so it holds when the service is started anew.
 * A copy made afterwards is another erasing's to remove. With no person named, every copy goes.
 *
 * From that first time the database's own file is taken to hold what was erased, until the
 * backend program has run for as long as it takes to clear that out (see `settleErased`).
 */
export function removeCopies(person?: string): number {
  everyCopyRead()
  let copies = copiesHere()
  if (person !== undefined && existsSync(backendFolder())) {
    const kept = erasedKept() ?? { told: {}, ran: 0 }
    const key = createHash('sha256').update(person).digest('hex')
    if (!kept.told[key]) {
      kept.told[key] = { at: Date.now(), copies: copies.map((copy) => copy.id) }
      kept.ran = 0
      writeWhole(erasedFile(), kept)
    }
    const theirs = kept.told[key].copies
    copies = copies.filter((copy) => theirs.includes(copy.id))
  }
  return removeAll(copies)
}

/**
 * Counts `more` milliseconds of the backend program's running toward the time in which the
 * database's own file still holds what an erasing removed, and once that time is over, removes
 * every copy that says it was made within it. Such a copy holds what was erased exactly as the
 * database's file did when it was made, and nothing clears a copy out, so it goes when the
 * database's own file has let go of it: whether or not a later copy is there, and whatever
 * change it was the way back from. The way back it gave lasts for that long and for no more.
 *
 * It is done when the service starts, before it keeps a copy of its own, and every few seconds
 * while the backend program runs.
 */
function settleErased(folder: string, more: number, say: (line: string) => void): void {
  const kept = erasedKept(folder)
  if (!kept) return
  if (kept.ran < erasedHeldMs() && more > 0) {
    kept.ran += more
    writeWhole(erasedFile(folder), kept)
  }
  if (kept.ran < erasedHeldMs()) return
  const over = copiesHere(folder).filter((copy) => copy.erased)
  if (!over.length) return
  let gone = 0
  for (const copy of over) {
    try {
      removeCopy(copy.entry, folder)
      if (copy.whole) gone++
    } catch (err) {
      const system = String((err as NodeJS.ErrnoException)?.code ?? '')
      say(`backend: a copy of the database that holds what was erased could not be removed (${/^E[A-Z0-9_]{2,30}$/.test(system) ? system : 'error'})`)
    }
  }
  if (gone) say(`backend: the database has let go of what was erased, and the copies of it made while it had not went with that (${gone})`)
}

// ---------- starting and stopping ----------

/**
 * Asks a program to stop as Ctrl-C at a terminal would: the backend program stops cleanly on
 * that and on nothing else. Nothing when it was asked, and otherwise a word for why it could
 * not be.
 *
 * Away from Windows that is a signal. Windows has none: there Ctrl-C is an event of the
 * console a program is attached to, and a program can only raise it on a console it is
 * attached to itself. So a helper leaves its own console, attaches to the backend's, and
 * raises the event there, having first told Windows that it does not mean itself. That reaches
 * only a program that has a console, and one started with its window hidden may have been
 * given none: the helper then says `no_console`. Whoever asks on Windows therefore never
 * depends on the answer, and ends the program where it could not be asked (see `halt`).
 */
function interrupt(pid: number): 'no_process' | 'no_console' | 'no_event' | 'no_helper' | undefined {
  // A number that is no process's own would mean every process in this program's group
  if (!Number.isInteger(pid) || pid <= 1) return 'no_process'
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGINT')
      return undefined
    } catch {
      return 'no_process'
    }
  }
  const script = [
    '$console = Add-Type -PassThru -Namespace It -Name Console -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint what, uint group);\'',
    '[void]$console::FreeConsole()',
    `if (-not $console::AttachConsole(${pid})) { exit 3 }`,
    '[void]$console::SetConsoleCtrlHandler([IntPtr]::Zero, $true)',
    'if (-not $console::GenerateConsoleCtrlEvent(0, 0)) { exit 4 }',
    // The event is handed out by the console, and a helper that left at once could take it along
    'Start-Sleep -Milliseconds 500',
    'exit 0',
  ].join('\n')
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    timeout: 30_000,
  })
  return ran.status === 0 ? undefined : ran.status === 3 ? 'no_console' : ran.status === 4 ? 'no_event' : 'no_helper'
}

/**
 * How the backend program is started on a system.
 *
 * Away from Windows it is put in a group of its own, so that Ctrl-C at the terminal the service
 * runs in reaches the service alone, which stops the backend last.
 *
 * On Windows it is not detached, its window is hidden, and none of its three streams is the
 * service's own handed down. A program started so shows no window. It may also have been given
 * no console, which is where Ctrl-C would reach it, and under Node it is in a job that Windows
 * closes when the service ends, however the service ends, which ends the program with it. So
 * on Windows nothing depends on the program hearing that it is to stop, or on its outliving
 * its service: see `halt`.
 */
export const startedWith = (platform: NodeJS.Platform): SpawnOptions => ({
  detached: platform !== 'win32',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

/** The program, started, and what it has said and done since. */
interface Child {
  pid: number
  /** Settles when the program has ended. */
  ended: Promise<End>
  over: () => boolean
  /** The last of what the program wrote. It names folders and may quote what a page stored, so it is kept in memory only, for a person at a terminal. */
  said: () => string[]
  /**
   * What the program said of why it ends, wherever among everything it wrote: that an address
   * it was to listen at is in use, and the last line it began with `Error:`. A program may
   * write a great deal after either, and of what it writes only the last lines are kept.
   */
  why: () => { taken: boolean; denied?: boolean; error?: string }
  /** Ends the program outright, without asking. Only `halt` does, and only on Windows. */
  end: () => void
}

/**
 * How long the backend program keeps the earlier versions of what it holds, in seconds. The
 * program writes a change as a new version beside the old one, and a removal as a mark after
 * the last, and takes the earlier ones out of its database only once they are this old. Left
 * to itself that is two weeks, for all of which what a person deleted or erased would still
 * be rows in the database file. Nothing of It's ever reads an earlier version of anything, so
 * the program is told to keep them an hour. It clears them out a minute or two after that,
 * and only while it runs.
 *
 * The program also notes every job it is given to run later, with what the job was given, and
 * keeps the note once the job has run. Left to itself it keeps it a week, and what a job was
 * given holds the ids of machines, pages and conversations, which would so stay for a week
 * after a person has erased everything. Nothing of It's reads such a note, so the program is
 * told to keep those an hour as well, counted from when the job ran. A job that is still to
 * run is not touched, however long ago it was given: it runs when it is due.
 */
const EARLIER_KEPT_S = 3600

/**
 * What the program is started with around it: what the service itself has, but for two things.
 * Nothing in it names a proxy. The program asks nothing off this machine: it asks itself for
 * its own keys, to check a token with, and it asks the door with what it has signed, and told
 * of a proxy it would send both there. And it says how long earlier versions are kept, and
 * the notes of the jobs that have run.
 */
const surroundings = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))),
  DOCUMENT_RETENTION_DELAY: String(EARLIER_KEPT_S),
  SCHEDULED_JOB_RETENTION: String(EARLIER_KEPT_S),
})

function launch(file: string, config: ServiceConfig): Child {
  const at = backendAt(config.port)
  const folder = backendFolder()
  // Whatever the program makes is the person's alone: its database, and every file it keeps
  // beside it. A program makes its files as the mask it was started under allows, and takes
  // that mask from whoever starts it. So the service narrows its own only for the moment in
  // which it starts the program: whatever else it starts, an agent app's own command among
  // it, is started under the mask the person gave the service. Windows has no such mask, and
  // a file there has the permissions of the folder it is made in.
  const mask = process.platform === 'win32' ? undefined : process.umask(0o077)
  let child: ChildProcess
  try {
    child = spawn(
      file,
      [
        // This machine only, whatever the door answers to
        '--interface',
        '127.0.0.1',
        '--port',
        new URL(at.api).port,
        '--site-proxy-port',
        new URL(at.site).port,
        '--convex-origin',
        at.api,
        '--convex-site',
        at.site,
        '--instance-name',
        instanceName(config.instanceSecret),
        '--instance-secret',
        config.instanceSecret,
        '--local-storage',
        path.join(folder, 'storage'),
        // The program reports to nobody
        '--disable-beacon',
        '--redact-logs-to-client',
        databaseFile(),
      ],
      { cwd: folder, env: surroundings(), ...startedWith(process.platform) },
    )
  } finally {
    if (mask !== undefined) process.umask(mask)
  }
  const said: string[] = []
  const why: { taken: boolean; denied?: boolean; error?: string } = { taken: false }
  const keep = (line: string) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the program colours what it writes, and the colours are taken out
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (plain) said.push(plain.slice(0, 500))
    if (said.length > 40) said.splice(0, said.length - 40)
    if (PORT_TAKEN.test(plain)) why.taken = true
    if (PORT_DENIED.test(plain)) why.denied = true
    if (plain.startsWith('Error:')) why.error = plain.slice(0, 500)
  }
  // What the program writes is kept a line at a time. A line can arrive in pieces, and a piece
  // is no line: what it ends with tells one ending from another, so it is read only when whole.
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (piece: string) => {
      const lines = (rest + piece).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) keep(line)
      // A line without an end is not waited for without end
      if (rest.length > 8192) {
        keep(rest)
        rest = ''
      }
    })
    stream.on('end', () => {
      keep(rest)
      rest = ''
    })
  }
  let over = false
  const ended = new Promise<End>((resolve) => {
    // It has ended when it has gone and everything it wrote has been read, which is a moment
    // after it is gone. Whatever holds its output open past that is not waited for.
    let gone: End | undefined
    child.once('exit', (code, signal) => {
      over = true
      gone = { code, signal }
      setTimeout(() => resolve({ code, signal }), 2000).unref()
    })
    child.once('close', (code, signal) => {
      over = true
      resolve(gone ?? { code, signal })
    })
    // A program that could not be started at all never ends: this is where that is heard, and
    // such a program has no number. Of a program that was started, the same word says only
    // that something asked of it could not be done, ending it among them. That is no end: it
    // has ended when the system says it has, and not before.
    child.on('error', () => {
      if (child.pid !== undefined) return
      over = true
      resolve({ code: null, signal: null })
    })
  })
  return { pid: child.pid ?? 0, ended, over: () => over, said: () => said, why: () => why, end: () => void child.kill() }
}

/** Waits until a program has ended or the time given is up, whichever comes first. Nothing is left waiting once either has come. */
function endedWithin(child: Child, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void child.ended.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** How long, on Windows, what the backend program was doing is given to finish before the program is asked to stop. */
const IN_FLIGHT_MS = 1000
/** How long a program on Windows is given to go once it has been asked to stop, before it is ended, and how long to be gone once it has been. */
const HEARD_MS = 3000
const ENDED_MS = 30_000

/**
 * Asks a program this service started to stop, and waits until it has, however long that is.
 * One that could not be asked is left running, and so is the lock, which says to the next
 * service that a program is still on the folder. Whether it has stopped.
 *
 * How it ends says nothing about whether it stopped cleanly. The program writes its database
 * shut and says it is done, and then, now and again, aborts on its way out. What it kept is
 * whole either way.
 *
 * On Windows the program is ended, and nothing is waited for without limit. By the time it is
 * stopped the service has closed its door, so nothing new is asked of it, and what it was
 * doing is given a moment to finish. It is then asked as a console would ask it. Where it has
 * no console to hear on, or has not gone a short while after being asked, Windows is told to
 * end it. That is what a power cut does to it, and its database is made to come through that
 * whole. Ended so on a machine that goes on running, it has kept everything it had answered
 * for, and only what it was in the middle of is lost. Where Windows will not end it, or does
 * not say that it has ended, it has not: it is left running, and so is the lock.
 */
async function halt(child: Child, lock: Held, say: (line: string) => void): Promise<boolean> {
  // One that could not be started has no number, and is over as soon as that has been heard
  if (!child.pid) await child.ended
  if (child.over()) return true
  if (process.platform === 'win32') {
    await endedWithin(child, IN_FLIGHT_MS)
    const unasked = child.over() ? undefined : interrupt(child.pid)
    if (!unasked) await endedWithin(child, HEARD_MS)
    if (!child.over()) {
      say(`backend: did not stop when asked, and is ended (pid ${child.pid}${unasked ? `, ${unasked}` : ''})`)
      child.end()
      await endedWithin(child, ENDED_MS)
    }
    if (child.over()) return true
    say(`backend: could not be ended, and is left running (pid ${child.pid})`)
    lock.abandon()
    return false
  }
  const unasked = interrupt(child.pid)
  if (unasked) {
    // It may have ended by itself in this very moment, which is as good
    await endedWithin(child, 5000)
    if (child.over()) return true
    say(`backend: could not be asked to stop, and is left running (pid ${child.pid}, ${unasked})`)
    lock.abandon()
    return false
  }
  const slow = setInterval(() => say('backend: still stopping'), 30_000)
  await child.ended
  clearInterval(slow)
  return true
}

/**
 * What the program says, last, when it cannot open the database it is given because the
 * database is not whole, as one is whose first making was cut short: the program was stopped
 * while it first wrote it. It then ends with the code 1.
 */
const UNFINISHED = /^Error: (missing _(tables|index)\.by_id global|bootstrap index \S+ has no `_index` document)$/
/** What the program says when an address it was to listen at is another program's: in the system's words, or by the number each system gives it. */
const PORT_TAKEN = /Address already in use|os error (98|48|10048)\b/
/**
 * How Windows may refuse a port: as one it will not let this program have. That is what it
 * says of a port another program is listening on alone, and also of a port the system keeps
 * aside for itself, so which of the two it is has to be asked of the port.
 */
const PORT_DENIED = /os error 10013\b/
/** Whether something answers at a port of this machine. */
const answersAt = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (is: boolean) => {
      socket.destroy()
      resolve(is)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

/**
 * Starts the program and waits until it answers. One that ends first is said to have, with why
 * as far as that is known, and whatever is in the folder is left where it is: no database is
 * ever moved, replaced or removed here, whatever the program says of it and whatever is noted
 * beside it.
 *
 * From the moment the program is started until it is handed back, it is this function's to
 * stop. Whatever goes wrong in between, a note that cannot be written included, the program
 * is stopped and waited for before the failure is passed on, so that whoever lets the lock go
 * afterwards lets go of a folder with no program on it. One that could not be stopped keeps
 * the lock (see `halt`).
 *
 * `neverLoaded` says how a database that would not open is told of to the person: whether what
 * is noted beside it says that this program began it and never loaded a function into it.
 */
async function up(file: string, config: ServiceConfig, lock: Held, neverLoaded: boolean, say: (line: string) => void, signal?: AbortSignal): Promise<Child> {
  const at = backendAt(config.port)
  const name = instanceName(config.instanceSecret)
  lock.note({ api: at.api })
  const child = launch(file, config)
  try {
    // One that has ended already is no program to note
    const started = child.pid ? startOf(child.pid) : null
    if (started !== null) lock.note({ api: at.api, program: child.pid, ...(started ? { programStarted: started } : {}) })
    const until = Date.now() + 5 * 60_000
    while (!child.over() && !(await answers(at.api, name))) {
      if (signal?.aborted) throw stopped()
      if (Date.now() > until) throw new Problem('The backend program was started and did not answer.', 'backend_silent')
      await endedWithin(child, 50)
    }
    if (!child.over()) return child
  } catch (err) {
    await halt(child, lock, say)
    throw err
  }
  const end = await child.ended
  if (!child.pid) throw new Problem(`The backend program at ${file} could not be started.`, 'backend_program')
  const last = child.why().error ?? child.said().at(-1)
  const why = last ? `The program said: ${last}` : 'The program said nothing.'
  const portOf = (address: string) => Number(/:(\d+)\/?$/.exec(address)?.[1])
  // Refused a port the Windows way: another program's if something answers there, and else one the system keeps aside
  const anothers = child.why().denied === true && ((await answersAt(portOf(at.api))) || (await answersAt(portOf(at.site))))
  if (child.why().taken || anothers)
    throw new Problem(
      `The backend program could not listen at ${at.api} or ${at.site}: another program has one of those ports.`,
      'port_in_use',
      'IT_PORT names another port for It to count from.',
    )
  if (child.why().denied)
    throw new Problem(
      `The backend program could not listen at ${at.api} or ${at.site}: this system would not let it have one of those ports, which it may be keeping aside.`,
      'port_in_use',
      'IT_PORT names another port for It to count from.',
    )
  say(`backend: the program ended as soon as it was started (${endOf(end)})`)
  if (end.code === 1 && last !== undefined && UNFINISHED.test(last))
    throw neverLoaded
      ? new Problem(
          `The database in ${backendFolder()} was begun and never finished, so the backend program cannot open it. Nothing there was moved or removed.`,
          'database_unfinished',
          `If It was never used on this machine, move the folder ${backendFolder()} out of the way and run \`it setup\` again.`,
        )
      : new Problem(`The backend program could not open the database in ${backendFolder()}. Nothing there was moved or removed.`, 'database_unopened', why)
  throw new Problem(`The backend program ended as soon as it was started. What It keeps in ${backendFolder()} is left as it is.`, 'backend_exited', why)
}

// ---------- It's functions ----------

/** The settings It's functions read, which are given to the backend with them. */
const settings = (config: ServiceConfig) => [
  { name: 'IT_PORT', value: String(config.port) },
  { name: 'IT_DOOR_KEY', value: doorKey(config) },
]
/** What tells one load from another: the functions built into this program, and the settings given with them. */
const loadOf = (config: ServiceConfig) =>
  createHash('sha256')
    .update(FUNCTIONS_HASH)
    .update(JSON.stringify(settings(config)))
    .digest('hex')

/**
 * Loads It's functions into the backend with the three requests the backend takes them in,
 * and then gives it the settings they read. A schema that takes the backend a while to check
 * is asked after until it is done.
 *
 * The backend takes the functions all at once, with the third request, or not at all. What it
 * refuses before then is refused as `functions_refused`, and the functions it had are the ones
 * it still has.
 */
async function load(config: ServiceConfig, say: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const at = backendAt(config.port)
  const ask = async (route: string, body: unknown, headers: Record<string, string> = {}) => {
    const answer = await direct(`${at.api}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: within(120_000, signal),
    }).catch(() => null)
    if (signal?.aborted) throw stopped()
    const text = (await answer?.text().catch(() => '')) ?? ''
    if (answer?.ok) return text ? (JSON.parse(text) as Record<string, any>) : {}
    // The backend says why in a word and in a sentence. The word is written down. The sentence
    // may quote what is in the database, so it goes only to a person at a terminal.
    let refusal: { code?: unknown; message?: unknown } = {}
    try {
      refusal = JSON.parse(text)
    } catch {}
    const word = typeof refusal.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(refusal.code) ? refusal.code : String(answer?.status ?? 'unreachable')
    say(`backend: functions not loaded (${word})`)
    // One that did not answer at all has refused nothing, and whether it took what it was sent is not known
    if (!answer) throw new Problem('The backend did not answer while It’s functions were being loaded.', 'backend_silent')
    throw new Problem(
      'The backend would not take It’s functions.',
      route === 'update_environment_variables' ? 'settings_refused' : 'functions_refused',
      typeof refusal.message === 'string' ? refusal.message.slice(0, 1000) : undefined,
    )
  }
  const started = await ask('deploy2/start_push', { ...JSON.parse(FUNCTIONS), adminKey: config.adminKey })
  for (;;) {
    const schema = await ask('deploy2/wait_for_schema', { adminKey: config.adminKey, schemaChange: started.schemaChange, timeoutMs: 10_000, dryRun: false })
    if (schema.type === 'complete') break
    if (schema.type !== 'inProgress') {
      say(`backend: functions not loaded (schema ${/^[A-Za-z]{1,40}$/.test(String(schema.type)) ? schema.type : 'refused'})`)
      throw new Problem(
        'What It already keeps does not fit the functions of this version of It, so they were not loaded.',
        'functions_refused',
        typeof schema.error === 'string' ? schema.error.slice(0, 1000) : undefined,
      )
    }
  }
  await ask('deploy2/finish_push', { adminKey: config.adminKey, startPush: started, dryRun: false, message: null })
  await ask('update_environment_variables', { changes: settings(config) }, { authorization: `Convex ${config.adminKey}` })
}

/** Whether It's functions answer in the backend, as they do once they have been loaded. */
async function loaded(site: string): Promise<boolean> {
  try {
    return (await direct(`${site}/health`, { signal: AbortSignal.timeout(5000) })).ok
  } catch {
    return false
  }
}

/**
 * Starts the backend for this folder: the program is fetched and checked if it is not here
 * yet, the folder is taken for this service alone, the program is started, and It's functions
 * and their settings are loaded when they are not the ones loaded last. `signal` is how a
 * service that is asked to stop while all this is under way says so.
 *
 * No backend program is started while another is on the folder: the system's list of what is
 * running is looked through once the folder is this service's alone, whatever any lock said.
 *
 * What is noted beside the database is read only once the folder is this service's alone. It
 * decides whether this It may be started on the database at all, and whether a copy is kept
 * first. It never decides that a database may be done away with: none ever is. An It older
 * than the one whose functions are in the database, or one whose backend program is older than
 * the one that last ran on it, is not started on it. Before a newer program is started on it,
 * and before other functions are loaded into it, a copy of it is kept. And where the functions
 * of this version are refused, because what the database holds does not fit them, the backend
 * goes on serving with the ones it has, and says so as `behind`: the database stays at the
 * version of It those came with, which may be run on it again.
 */
export async function startBackend(config: ServiceConfig, say: (line: string) => void, signal?: AbortSignal): Promise<Running> {
  const file = await program(say, signal)
  const lock = await takeLock(lockFile(), {
    taken: (by) => new Problem(`It is already running for this folder${by ? ` (pid ${by.pid})` : ''}.`, 'already_running'),
    left: (left) => noneLeft(config, say, signal, left),
    watching: () => say('backend: the lock on the folder is from elsewhere, and is watched for half a minute in case its holder lives'),
    signal,
  })
  const at = backendAt(config.port)
  const folder = backendFolder()
  let child: Child | undefined
  let behind: Behind | undefined
  try {
    await noneLeft(config, say, signal)
    // A copy that holds what was erased goes first where its time is over, and whether a copy
    // made now would hold such is what is kept of the erasings to say
    settleErased(folder, 0, say)
    const told = erasedKept(folder)
    const held = told !== undefined && told.ran < erasedHeldMs()
    const database = existsSync(databaseFile())
    // Where there is no database, whatever was noted was noted of one that is gone
    let note = database ? withUnsettled(readNote()) : {}
    notOlder(note)
    const wanted = loadOf(config)
    const programChanges = database && note.release !== RELEASE
    const functionsChange = database && note.functions !== FUNCTIONS_HASH
    let copied = true
    /** What is in the way of a copy, where something It did not make has the copy's name. */
    let inTheWay: string | undefined
    /** What the person can do about a copy that could not be kept. */
    const toCopy = () =>
      inTheWay
        ? `Something that It did not make is at ${inTheWay}, where the copy goes, and It leaves it as it is. Move it somewhere else, then start It again.`
        : 'Check that the disk has room for a second copy of the database, then start It again.'
    if (programChanges || functionsChange) {
      const name = `before-${[...(programChanges ? [RELEASE] : []), ...(functionsChange ? [`functions-${FUNCTIONS_HASH.slice(0, 12)}`] : [])].join('-')}`
      try {
        // A loading of these functions whose end was never learned may have changed the
        // database already: a copy made before it began is the one from before the change
        keepCopy(name, !programChanges && (note.unsettled?.functions.includes(FUNCTIONS_HASH) ?? false), held, say)
        say('backend: a copy of the database was kept before it is changed (database_copied)')
      } catch (err) {
        copied = false
        const system = String((err as NodeJS.ErrnoException)?.code ?? '')
        if (system === 'in_the_way') inTheWay = path.join(backendFolder(), name)
        say(`backend: no copy of the database could be kept (${inTheWay || /^E[A-Z0-9_]{2,30}$/.test(system) ? system : 'error'})`)
        if (programChanges)
          throw new Problem(
            `It could not keep a copy of its database in ${backendFolder()} before starting a newer backend program on it, so the program was not started.`,
            'copy_failed',
            toCopy(),
          )
      }
    }
    if (!database || note.release !== RELEASE || note.it !== VERSION) {
      note = database ? { ...note, release: RELEASE, it: VERSION } : { made: Date.now(), release: RELEASE, it: VERSION }
      writeNote(note)
    }
    // What the person is told of a database that will not open: whether this program began it and never loaded a function into it
    const neverLoaded = !database || (note.made !== undefined && note.functions === undefined && note.unsettled === undefined)
    child = await up(file, config, lock, neverLoaded, say, signal)
    say(`backend: started (pid ${child.pid})`)
    // It runs on the data: a program kept for another release is of no more use now. One that
    // cannot be removed now, as one that is still running on Windows cannot, is left for the next time.
    try {
      removeOtherPrograms(file)
    } catch {}
    /**
     * The functions already in the database go on serving, and why is noted for whoever tells
     * the person. They can only go on where It counts from the port it counted from when they
     * were loaded: what a backend believes of its own address, and of the door's, is fixed
     * with its functions, and from another port every command would be refused. That is no
     * going on, so It stops and says which port to put back.
     */
    const goOn = (why: Behind['why'], line: string) => {
      // The loading this start began is known to have changed nothing. What an earlier one left unlearned stays so.
      const { loading: _, behind: __, ...rest } = note
      if (note.port !== undefined && note.port !== config.port) {
        note = rest
        writeNote(note)
        say('backend: the functions of this version were not loaded, and the ones already loaded were loaded for another port (port_changed)')
        throw new Problem(
          `The functions in It’s database were loaded when It counted from port ${note.port}, and the functions of this version could not take their place, so It cannot run from port ${config.port}.`,
          'port_changed',
          why === 'refused'
            ? `Put the port back: start It with IT_PORT=${note.port}.`
            : inTheWay
              ? `Put the port back: start It with IT_PORT=${note.port}. Or move what is at ${inTheWay} somewhere else, and start It again.`
              : `Put the port back: start It with IT_PORT=${note.port}. Or make room on the disk for a second copy of the database, and start It again.`,
        )
      }
      behind = { functions: FUNCTIONS_HASH, why, at: Date.now() }
      note = { ...rest, behind }
      writeNote(note)
      say(line)
    }
    if (!copied) {
      if (!(await loaded(at.site)))
        throw new Problem(
          `It could not keep a copy of its database in ${backendFolder()} before loading other functions into it, so they were not loaded.`,
          'copy_failed',
          toCopy(),
        )
      goOn('no_copy', 'backend: for want of a copy, other functions were not loaded, and the ones already loaded go on serving (copy_failed)')
    } else if (note.load !== wanted || note.unsettled !== undefined || !(await loaded(at.site))) {
      // Noted before the first function is in: from here on the database may come to hold
      // what a person made. Where an earlier loading never came to an end that was learned,
      // what is in the database is not known, whatever was last noted as loaded: these go in.
      note = { ...note, loading: FUNCTIONS_HASH }
      writeNote(note)
      try {
        await load(config, say, signal)
        const { loading: _, behind: __, unsettled: ___, ...rest } = note
        // Only now is the database at this version of It, and nothing of it is unlearned
        note = { ...rest, functions: FUNCTIONS_HASH, functionsOf: VERSION, load: wanted, port: config.port }
        writeNote(note)
        say(`backend: functions loaded (${FUNCTIONS_HASH.slice(0, 12)})`)
      } catch (err) {
        // Refused, the functions the database already had are the ones it still has. Where
        // those answer, the person keeps everything they had, on them.
        if (!(err instanceof Problem && err.code === 'functions_refused') || !(await loaded(at.site))) throw err
        goOn('refused', 'backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)')
      }
    } else if (note.behind || note.functionsOf !== VERSION) {
      // The functions in it are this version's own, whichever version put them there
      const { behind: _, ...rest } = note
      note = { ...rest, functionsOf: VERSION }
      writeNote(note)
    }
    // The settings file says the same, for whoever reads it there
    if (!behind && (config.functions !== wanted || config.backend !== RELEASE)) {
      noteLoaded({ functions: wanted, backend: RELEASE })
      config.functions = wanted
      config.backend = RELEASE
    }
  } catch (err) {
    if (child) await halt(child, lock, say)
    lock.release()
    throw err
  }
  const running = child
  // While the program runs, its running is counted toward the time in which the database's
  // file still holds what an erasing removed. What is kept of the erasings may come to be
  // unreadable meanwhile: that is said once, and nothing is counted or removed until it can be read.
  let counted = performance.now()
  let uncounted = false
  const count = () => {
    const now = performance.now()
    try {
      settleErased(folder, now - counted, say)
      uncounted = false
    } catch (err) {
      if (!uncounted)
        say(
          `backend: what is kept of the erasings cannot be read or written, so nothing is counted or removed by it (${err instanceof Problem ? err.code : 'error'})`,
        )
      uncounted = true
    }
    counted = now
  }
  const counting = setInterval(count, ERASED_COUNTED_MS)
  counting.unref()
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(counting)
      count()
      if (await halt(running, lock, say)) say('backend: stopped')
      lock.release()
    })()
    return stopping
  }
  // The lock is another's, which it comes to be only from a holder that could not be told to
  // be alive. Two programs must not write the same data, so this one's stops.
  lock.lost = () => {
    say('backend: another service has taken this folder; stopping')
    void stop()
  }
  return { ...at, adminKey: config.adminKey, stop, ended: running.ended, ...(behind ? { behind } : {}) }
}

/**
 * Runs one of It's functions as the backend's administrator, which may run any of them, the
 * internal ones included. The function is named as `module:function`, or with a dot between
 * the two.
 */
export async function asAdmin(backend: Pick<Backend, 'api' | 'adminKey'>, name: string, args: unknown): Promise<unknown> {
  const client = new ConvexHttpClient(backend.api, {
    fetch: (input, init) => direct(input, { ...init, signal: AbortSignal.timeout(60_000) }),
    logger: false,
  }) as unknown as { setAdminAuth(key: string): void; function(name: string, component: undefined, args: unknown): Promise<unknown> }
  client.setAdminAuth(backend.adminKey)
  return client.function(name.includes(':') ? name : name.replace(/\.([^./]+)$/, ':$1'), undefined, args ?? {})
}
