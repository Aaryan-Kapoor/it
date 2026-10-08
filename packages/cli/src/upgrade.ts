// A newer It: learning that one is out, and putting it in place of this one.
//
// A release is a handful of files in one place, laid out as GitHub lays out a repository's
// releases and as the install scripts take them: the program for each system, the license, the
// notices, `SHA256SUMS` with the checksum of each, and `latest.json`, which says which version
// they are. The place is the one the install scripts download from, or the one IT_INSTALL_BASE
// names instead.
//
// Learning of a newer version sends nothing about this installation: one plain request for
// `latest.json`, with no id and nothing of what It holds. The service makes it every half hour until
// that is turned off (`it updates off`).
//
// An upgrade trusts what an install trusts and no more: the place it downloads from, over
// https, and the checksums published beside the files. It replaces a program only by one that
// matches its checksum, that starts on this system, and that says of itself that it is newer.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { INSTALL, newer } from '@it/protocol'
import { ask, home, inHome, Problem, readJson, VERSION, writePrivate } from './lib'

/** No program is anywhere near this large, and nothing else of a release is near the second. */
const PROGRAM_MOST = 400 * 1024 * 1024
const TEXT_MOST = 8 * 1024 * 1024

/**
 * Where releases are, and whether that is a place on this machine, which is how an upgrade is
 * tried before anything is published. Anywhere else has to be asked over https, as the install
 * scripts insist too.
 */
export function releases(): { base: string; plain: boolean } {
  const base = (process.env.IT_INSTALL_BASE || keptBase() || INSTALL.releases).replace(/\/+$/, '')
  const plain = /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(base)
  if (!plain && !/^https:\/\/[^/]/.test(base)) throw new Problem('IT_INSTALL_BASE must be an https address.', 'invalid')
  return { base, plain }
}

// An It that was installed from another place than the usual one is updated from there too.
// The install script is told the place by a variable, which the setup it goes on to still has
// and nothing after it does: not the service, and not a terminal opened the next day. So setup
// writes it down in It's folder, and takes it away again when it is set up from the usual place.
const baseFile = () => inHome('releases.json')
const keptBase = (): string | undefined => {
  const kept = readJson<{ base?: unknown }>(baseFile())?.base
  return typeof kept === 'string' && kept ? kept : undefined
}
/** Notes where this It's releases are, as the variable says while it is set up. Nothing is changed where the variable is not set. */
export function keepBase(): void {
  const named = process.env.IT_INSTALL_BASE?.replace(/\/+$/, '')
  if (!named) return
  try {
    if (named === INSTALL.releases) rmSync(baseFile(), { force: true })
    else if (/^https:\/\/[^/]/.test(named) || /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(named)) writePrivate(baseFile(), { base: named })
  } catch {}
}

/** One file of the newest release, whole and in memory, or the reason it could not be had. */
async function file(name: string, most: number, signal?: AbortSignal, progress?: (got: number, of: number | undefined) => void): Promise<Buffer> {
  const { base, plain } = releases()
  const url = `${base}/latest/download/${name}`
  const unreachable = () =>
    new Problem(
      `The newest release of It could not be fetched (${name}).`,
      'offline',
      base !== INSTALL.releases
        ? `It is fetched from ${base}, where this It was installed from. Check that a release is there, then try again.`
        : 'Check that this machine is online, then try again.',
    )
  const tooLarge = () => new Problem(`What was fetched as ${name} is larger than any release of It holds, so none of it was kept.`, 'checksum')
  // A place on this machine is asked directly, whatever proxy the environment names, and its
  // answer is read whole up to the most a release's file can be
  if (plain) {
    const at = new URL(url)
    const answer = await ask(
      { host: at.hostname, port: Number(at.port) },
      { path: `${at.pathname}${at.search}`, headers: { host: at.host }, most, signal },
    ).catch((err) => {
      throw (err as NodeJS.ErrnoException)?.code === 'EMSGSIZE' ? tooLarge() : unreachable()
    })
    if (answer.status !== 200) throw unreachable()
    progress?.(answer.body.length, answer.body.length)
    return Buffer.from(answer.body)
  }
  // Anywhere else is asked as any https address is, and may send on to another https address only
  let answer: Response
  try {
    answer = await fetch(url, { redirect: 'follow', signal })
  } catch {
    throw unreachable()
  }
  if (!answer.ok || !answer.body || !answer.url.startsWith('https://')) throw unreachable()
  const length = Number(answer.headers.get('content-length'))
  const of = Number.isInteger(length) && length > 0 ? length : undefined
  const pieces: Uint8Array[] = []
  let size = 0
  try {
    for await (const piece of answer.body as unknown as AsyncIterable<Uint8Array>) {
      size += piece.length
      if (size > most) throw tooLarge()
      progress?.(size, of)
      pieces.push(piece)
    }
  } catch (err) {
    throw err instanceof Problem ? err : unreachable()
  }
  return Buffer.concat(pieces)
}

/**
 * The newest version there is, as the place releases are kept says it. Nothing where it cannot
 * be asked or does not say: not knowing is not a problem to tell anyone of.
 */
export async function latest(signal?: AbortSignal): Promise<string | null> {
  try {
    const said = JSON.parse((await file('latest.json', 4096, signal ?? AbortSignal.timeout(20_000))).toString('utf8')) as { version?: unknown } | null
    const version = typeof said?.version === 'string' ? said.version.trim().replace(/^v/, '') : ''
    return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version) ? version : null
  } catch {
    return null
  }
}

// ---------- whether the service looks for a newer version by itself ----------

// Off is a file of its own in It's folder, as it is for usage reporting, and for the same
// reason: a copy of the switch in the service's definition would turn it off again each time
// the service started, after the person had turned it back on.
const offFile = () => inHome('updates-off')
const offByVariable = () => ['false', '0', 'off', 'no', 'n', 'disabled'].includes((process.env.IT_UPDATE_CHECK ?? '').trim().toLowerCase())
/** How often the service asks whether a newer version is out: often enough that one is known of within the hour it is published. */
export const LOOKS_EVERY_MS = 30 * 60_000
/** Whether this installation looks for a newer version by itself. It does until it is told not to. */
export const watching = (): boolean => !offByVariable() && !existsSync(offFile())
export function watch(on: boolean): { on: boolean; because?: string } {
  if (on) rmSync(offFile(), { force: true })
  else writePrivate(offFile(), { off: true })
  return watched()
}
export const watched = (): { on: boolean; because?: string } =>
  offByVariable() ? { on: false, because: 'IT_UPDATE_CHECK' } : existsSync(offFile()) ? { on: false, because: 'it updates off' } : { on: true }

// ---------- putting a newer program in place ----------

/** The name a release gives the program for this system, or nothing where it has none for it. */
export function programName(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : null
  const chip = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!os || !chip || (os === 'windows' && chip !== 'x64')) return null
  return `it-${os}-${chip}${os === 'windows' ? '.exe' : ''}`
}

/**
 * The file this program is, where it is the standalone program an install puts in place: the
 * one file an upgrade replaces. Nothing where It runs from its bundle under Node or Bun, or
 * from its source: that is put there some other way, and is updated that way.
 */
export function standalone(): string | null {
  const script = process.argv[1]
  if (script !== undefined && /\.(m?js|ts)$/.test(script)) return null
  return process.execPath
}

/** Writes a file whole, with every byte on the disk, beside where it goes, and only then gives it its name. */
function put(to: string, bytes: Buffer, mode: number): void {
  const part = `${to}.${process.pid}.part`
  try {
    const out = openSync(part, 'w', mode)
    try {
      for (let at = 0; at < bytes.length; ) at += writeSync(out, bytes, at, Math.min(1024 * 1024, bytes.length - at))
      fsyncSync(out)
    } finally {
      closeSync(out)
    }
    renameSync(part, to)
  } finally {
    rmSync(part, { force: true })
  }
}

/** What a program says its version is, asked as anyone would ask it. Nothing where it does not start, or does not say. */
function saysItIs(program: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, ['--version'], { timeout: 30_000, env: { ...process.env, IT_HOME: home() }, windowsHide: true }, (err, out) => {
      if (err) return resolve(null)
      try {
        const version = (JSON.parse(String(out)) as { version?: unknown } | null)?.version
        resolve(typeof version === 'string' ? version : null)
      } catch {
        resolve(null)
      }
    })
  })
}

export interface Upgraded {
  from: string
  to: string
  /** The file that was replaced, which is the program to run from now on. */
  program: string
}

/**
 * Puts the newest release's program in place of this one, where it is newer. Nothing where
 * this is the newest already. The license and the notices beside the program are replaced with
 * it. Nothing is started or stopped here: the program that is running runs on as it was until
 * it is started again, and `started` is for whoever calls to see to.
 *
 * Every step that can fail comes before the one that replaces the program, so a failure leaves
 * the installation exactly as it was.
 */
export async function fetchNewer(
  opts: {
    say?: (line: string) => void
    progress?: (got: number, of: number | undefined) => void
    signal?: AbortSignal
    /** The file to replace, where it is not the program this is: for a test, which is no standalone program. */
    program?: string
  } = {},
): Promise<Upgraded | null> {
  const say = opts.say ?? (() => {})
  const program = opts.program ?? standalone()
  if (!program)
    throw new Problem(
      'This It does not run as the program an install puts in place, so it is not upgraded this way.',
      'invalid',
      'Update it the way it was put here: from its source, or with the package it came in.',
    )
  const name = programName()
  if (!name) throw new Problem(`There is no program of It for this system (${process.platform} ${process.arch}).`, 'invalid')
  const to = await latest(opts.signal)
  if (!to) throw new Problem('The newest version of It could not be learned.', 'offline', 'Check that this machine is online, then try again.')
  if (!newer(to, VERSION)) return null
  say(`It ${to} is out, and this is ${VERSION}.`)
  // The checksums first: what is fetched after them is held to them
  const sums = new Map<string, string>()
  for (const line of (await file('SHA256SUMS', TEXT_MOST, opts.signal)).toString('utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())
    if (m) sums.set(m[2]!, m[1]!)
  }
  const checked = async (of: string, most: number, progress?: (got: number, total: number | undefined) => void): Promise<Buffer> => {
    const want = sums.get(of)
    const bytes = want ? await file(of, most, opts.signal, progress) : null
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== want)
      throw new Problem(
        `What was fetched as ${of} is not the file its release says it is, so nothing was changed.`,
        'checksum',
        'Try again. If it happens again, something between this machine and where releases are kept is changing what is fetched.',
      )
    return bytes
  }
  const fetched = await checked(name, PROGRAM_MOST, opts.progress)
  const license = await checked('LICENSE.md', TEXT_MOST)
  const notices = await checked('THIRD_PARTY_NOTICES.md', TEXT_MOST)
  say('Downloaded, and checked against its checksum.')
  // Beside the program it is to replace, under a name of its own, and started there once to
  // see that it runs on this system and is what it was said to be
  const dir = path.dirname(program)
  mkdirSync(dir, { recursive: true })
  const fresh = path.join(dir, `.it-upgrade-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`)
  try {
    put(fresh, fetched, 0o755)
    const is = await saysItIs(fresh)
    if (!is || !newer(is, VERSION))
      throw new Problem(
        is
          ? `The program that was fetched says it is version ${is}, which is not newer than this one, so nothing was changed.`
          : 'The program that was fetched does not start on this system, so the one that is here stays.',
        'upgrade_program',
      )
    // Windows does not let a program that is running be written over, and does let it be given
    // another name: the one that is running goes on under that name until it ends
    if (process.platform === 'win32') {
      for (const old of readdirSync(dir).filter((f) => /^it\.old\.\d+\.exe$/.test(f))) rmSync(path.join(dir, old), { force: true })
      const aside = path.join(dir, `it.old.${Date.now()}.exe`)
      renameSync(program, aside)
      try {
        renameSync(fresh, program)
      } catch (err) {
        // Put back under its own name, so that a failure leaves the program that was there
        renameSync(aside, program)
        throw err
      }
    } else renameSync(fresh, program)
    // The terms it comes under and the notices of what it includes are this version's too
    for (const [as, bytes] of [
      ['LICENSE.md', license],
      ['THIRD_PARTY_NOTICES.md', notices],
    ] as const) {
      try {
        put(inHome(as), bytes, 0o644)
      } catch {}
    }
    say(`Installed in ${dir}.`)
    return { from: VERSION, to: is, program }
  } finally {
    rmSync(fresh, { force: true })
  }
}
