// What every command shares: where things are kept on this machine, how the machine proves who
// it is, and how to reach the backend.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { type Harness, PORTS } from '@it/protocol'
import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { ConvexError } from 'convex/values'
import { importJWK, type JWK, SignJWT } from 'jose'
import { agentAppsAbove } from './ancestry'
import { CODEX_SHUT_SAID } from './codex-settings'
import { added, shellEnv } from './shell-env'

export const VERSION = '0.1.0'
export const api: any = anyApi

/** A failure the person or agent can act on. `hint` says what to do next. */
export class Problem extends Error {
  constructor(
    message: string,
    readonly code = 'error',
    readonly hint?: string,
  ) {
    super(message)
  }
}

// ---------- files on this machine ----------

// An IT_HOME that is set and empty names no folder, and is taken for not being set. One named
// from where the shell stands is read from there once and for all: a file's address made from
// it is then the same file when it is written into a service or a launcher, which start from
// somewhere else.
export const home = () => (process.env.IT_HOME ? path.resolve(process.env.IT_HOME) : path.join(os.homedir(), '.it'))
export const inHome = (...parts: string[]) => path.join(home(), ...parts)

/**
 * A piece of text as PowerShell reads it back exactly. Between apostrophes nothing is more
 * than itself but the apostrophe, which is written twice, and PowerShell reads three curled
 * marks and a low one as that apostrophe, so they are written twice too.
 */
export const psQuote = (v: string) => `'${v.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`

/**
 * The line that puts a folder first on the PATH Windows keeps for this account, for a person
 * to run in PowerShell. That PATH is read and written as it is kept, with a name such as
 * %USERPROFILE% left as a name and the value left the kind it was: read the usual way, every
 * such name comes back as what it stands for today, and writing that back would fix it there
 * for good. Setting and removing a variable at the end is what tells running programs that the
 * PATH has changed.
 */
export function windowsPathCommand(folder: string): string {
  const dir = psQuote(folder)
  return [
    "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    "$p = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    `if (($p -split ';') -notcontains ${dir}) { $kind = if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { 'ExpandString' }; $k.SetValue('Path', (@(${dir}, $p) | Where-Object { $_ }) -join ';', $kind); [Environment]::SetEnvironmentVariable('IT_PATH_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('IT_PATH_CHANGED', [NullString]::Value, 'User') }`,
    '$k.Close()',
  ].join('; ')
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
/**
 * Everything a stream gives, as text. The bytes are put together first and read as text once: a
 * character can arrive split across two pieces, and each piece read by itself would turn it
 * into something else.
 */
export async function textOf(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const pieces: Buffer[] = []
  for await (const piece of stream) pieces.push(typeof piece === 'string' ? Buffer.from(piece) : piece)
  return Buffer.concat(pieces).toString('utf8')
}
/**
 * Gives a file or a folder another name. Windows refuses that while another program has the
 * file open in a way that does not allow it, and a program that looks into every new file may
 * have it open so for a moment, so there it is tried again for a little while.
 */
export function rename(from: string, to: string): void {
  for (let tries = 0; ; tries++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (process.platform !== 'win32' || tries >= 30 || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

/**
 * Gives an open file every byte that is to go to it. The system may take fewer bytes than it
 * is given and say so without failing, as it does where a disk is nearly full, so it is given
 * the rest until it has taken them all.
 */
export function writeAll(to: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; ) {
    const taken = writeSync(to, bytes, at, bytes.length - at)
    if (taken <= 0) throw Object.assign(new Error('the system took no more of the file'), { code: 'ENOSPC' })
    at += taken
  }
}

/**
 * Writes a file for this person alone, with every byte it is to have, and has it on the disk
 * before anything goes on from it. A file that could not be written whole is taken away again.
 *
 * The file is written under a name that is not yet the one it is to be found under: what It
 * keeps is given its name only once it is all there, by `writePrivate`, or by the one step
 * that makes a file once where it must be made once.
 */
export function writeFlushed(file: string, text: string): void {
  try {
    const out = openSync(file, 'w', 0o600)
    try {
      writeAll(out, Buffer.from(text))
      fsyncSync(out)
    } finally {
      closeSync(out)
    }
  } catch (err) {
    rmSync(file, { force: true })
    throw err
  }
}

/**
 * Keeps something in a file of It's folder: written whole and on the disk first, and then
 * given its name in one step, in the place of what the file held before. Whoever reads the
 * file finds what it held before or what it holds now, and never a part of it, also where the
 * machine lost its power in the moment it was kept. The folder is told to the disk as well,
 * where the system lets a folder be. The only copy of this machine's key is kept this way, and
 * so is every record the service acts on.
 *
 * It is readable only by this user. That is the system's doing: elsewhere than Windows the
 * file is made for its owner alone. Windows takes no such word from a program, and gives a
 * file the permissions of the folder it is in, so there it is as private as It's folder is: a
 * person's own profile is, and a folder they name instead may not be.
 */
export function writePrivate(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const whole = `${file}.${process.pid}.tmp`
  writeFlushed(whole, typeof data === 'string' ? data : JSON.stringify(data, null, 1))
  try {
    rename(whole, file)
  } catch (err) {
    rmSync(whole, { force: true })
    throw err
  }
  chmodSync(file, 0o600)
  try {
    const folder = openSync(path.dirname(file), 'r')
    try {
      fsyncSync(folder)
    } finally {
      closeSync(folder)
    }
  } catch {}
}
// ---------- what may be written down ----------

/** Whether something is one plain word, as a code is and as the kind of an error is. A folder's name is not, and neither is what a person typed. */
export const plainWord = (said: unknown): said is string => typeof said === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(said)
/**
 * What went wrong, as it may be written down: a refusal's own code, the system's code for it,
 * or the kind of error, whichever comes first that is one plain word. An error's words are
 * never written, and neither is a code or a name that is more than a word: any of them can
 * repeat a folder's name or what a person typed.
 */
export function why(err: unknown): string {
  // A refusal from the backend carries its code in its data, as an object or as text
  const data = (err as { data?: unknown } | null)?.data
  const refused = typeof data === 'string' ? /"code":"([a-z_]+)"/.exec(data)?.[1] : (data as { code?: unknown } | undefined)?.code
  return [refused, (err as { code?: unknown } | null)?.code, (err as { name?: unknown } | null)?.name].find(plainWord) ?? 'error'
}

// ---------- what this program prints ----------

/** What has been written to this program's output and has not yet left the process. */
const leaving = new Set<Promise<void>>()
/**
 * Writes to standard output or standard error, and keeps hold of the write until it has left
 * the process. A write into a pipe is finished some time after it was asked for, and a process
 * that ends itself before then takes what it wrote with it. Everything a command prints is
 * written through here, and `left` is waited for wherever the process is about to end.
 */
export function written(stream: NodeJS.WriteStream, text: string): void {
  const gone = new Promise<void>((resolve) => {
    stream.write(text, () => resolve())
  })
  leaving.add(gone)
  void gone.then(() => leaving.delete(gone))
}
/**
 * Resolves once everything written so far has left the process. Until then the process is kept
 * from ending by itself, which it could otherwise do with nothing else left for it to wait on.
 */
export async function left(): Promise<void> {
  const held = setInterval(() => {}, 1000)
  try {
    while (leaving.size) await Promise.all([...leaving])
  } finally {
    clearInterval(held)
  }
}
/** Ends the process, once everything it wrote has left it. */
export async function end(code: number): Promise<never> {
  await left()
  process.exit(code)
}

// ---------- which backend ----------

/** The backend's two addresses: one for function calls, one for HTTP. */
export interface Backend {
  api: string
  site: string
}
/** Where It's settings are kept, on the machine It runs on. */
export const settingsFile = () => inHome('service.json')
/** A port everything else can be counted from: a whole number with room above it for the backend's two. */
export const asPort = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value + PORTS.backendSite <= 65535 ? value : undefined
/**
 * The ports no browser opens a page on, whatever answers there: the list in the Fetch standard,
 * which every browser keeps. It would start on one of them and run, and its site could never
 * be opened.
 */
const BROWSERS_REFUSE = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])
/** The port a browser would refuse, of the two it has to open when It counts from `port`: the site's, or the pages' above it. */
export const browsersRefuse = (port: number): number | undefined => [port, port + PORTS.content].find((p) => BROWSERS_REFUSE.has(p))
/** The port IT_PORT names, when it is set. One that is no usable port is refused, and never passed over in silence. */
export function portAsked(): number | undefined {
  if (!process.env.IT_PORT) return undefined
  const port = asPort(Number(process.env.IT_PORT))
  if (port === undefined)
    throw new Problem(`IT_PORT is a port with room above it for ${PORTS.backendSite} more, and "${process.env.IT_PORT}" is not one.`, 'invalid')
  const shut = browsersRefuse(port)
  if (shut !== undefined)
    throw new Problem(
      `IT_PORT=${port} would put ${shut === port ? 'It’s site' : 'the pages agents make'} on port ${shut}, which browsers refuse to open.`,
      'invalid',
      'Choose another first port for It.',
    )
  return port
}
/** The port everything on this machine is counted from: what IT_PORT says, or else what It's settings say. Undefined where It has not been set up. */
export function basePort(): number | undefined {
  const settings = readJson<{ port?: unknown }>(settingsFile())
  return settings ? (portAsked() ?? asPort(settings.port)) : undefined
}
/** The backend's two addresses on this machine, counted from the base port. */
export const backendAt = (port: number): Backend => ({
  api: `http://127.0.0.1:${port + PORTS.backendApi}`,
  site: `http://127.0.0.1:${port + PORTS.backendSite}`,
})
/** What every command but `it setup` says on a machine where It has not been set up. */
export const notSetUp = () => new Problem('It has not been set up on this machine, so run `it setup` first.', 'not_set_up')
/**
 * Where the backend is. On the machine It runs on, that is two ports of this machine. On a
 * machine that joined an It running on another, it is the address it joined at. IT_URL names
 * another address, and IT_SITE_URL the one for HTTP where the two are not the same.
 */
export function backend(): Backend {
  const plain = (address: string) => address.replace(/\/$/, '')
  if (process.env.IT_URL) return { api: plain(process.env.IT_URL), site: plain(process.env.IT_SITE_URL || process.env.IT_URL) }
  const port = basePort()
  if (port !== undefined) return backendAt(port)
  const joined = readJson<Machine>(machineFile())?.at
  if (joined) return { api: joined, site: joined }
  throw notSetUp()
}
/** What to do about It not running on the machine it runs on. */
export const NOT_RUNNING = 'Start it with `it serve`, or run `it setup` to keep it running in the background.'
/**
 * What is said when nothing answered at all. On the machine It runs on, that is It not running,
 * and the person is told how to start it: where its backend listens is nothing they can act on.
 * On a machine that joined an It on another computer, or was given an address, it is that
 * address that did not answer, and it is named with what to check there.
 */
export const unreachable = (where: string) =>
  !process.env.IT_URL && basePort() !== undefined
    ? new Problem('It is not running on this machine.', 'offline', NOT_RUNNING)
    : new Problem(
        `It could not reach the It at ${where}.`,
        'offline',
        'Check that It is running on the machine it runs on, that its network is on, which `it network` says there, and that this machine can reach that address.',
      )

/**
 * What is said when the system would not let this command open a connection at all. An agent
 * app that runs commands with the network closed to them does that, and the command then
 * cannot tell whether It is running: it is not said to be stopped, and nobody is told to start
 * it. What helps is running the command where it may reach It.
 */
export const shutIn = (e: NodeJS.ProcessEnv = process.env) =>
  new Problem(
    'It could not be asked from here: this command is run where it may not open a connection, as an agent app runs commands when it gives them no network. It may well be running.',
    'blocked',
    // Codex is the app that does this as it comes, and the person is the one who can change it:
    // the agent is given the line to tell them, since nothing else can get word out of here
    e.CODEX_THREAD_ID
      ? // What is for the agent comes first and what it is to pass on comes last: an agent that is told "say this, in these words" says everything after it
        `It may well be running: this says nothing of that, so do not start It again, and do not change Codex’s settings yourself. Ask to run this same command outside the sandbox, the way you ask for any command that needs it. If the asking is refused, or you may not ask, tell the user what follows, in these words and no others: ${CODEX_SHUT_SAID}`
      : 'Run `it` outside that sandbox, or let commands use the network there. Do not start It again.',
  )
/** Whether an error says that the system refused the connecting itself, and not that nothing answered. */
export function notLet(err: unknown): boolean {
  const codes = [(err as { code?: unknown } | null)?.code, (err as { cause?: { code?: unknown } } | null)?.cause?.code]
  return codes.some((code) => code === 'EPERM' || code === 'EACCES')
}
/**
 * Whether the system keeps this command from the network altogether: it may not so much as
 * listen on this machine's own address. Bun gives a connection the system refused as one that
 * nothing answered, so where nothing seemed to answer, this is asked as well. Nothing is sent.
 */
export const closedToNetwork = (): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(true)).listen(0, '127.0.0.1', () => probe.close(() => resolve(false)))
  })
/**
 * Asks the part of It that hands clicks on whether it is there, at its socket in It's folder.
 * Whoever starts the command gives the way to ask, since that part is asked from another file.
 */
let connectorThere: (() => Promise<boolean>) | undefined
export const askConnectorWith = (ask: () => Promise<boolean>) => {
  connectorThere = ask
}
/**
 * Whether an error is the system keeping this command from It, said outright or found by
 * asking. A sandbox that gives a command a network of its own, with nothing on it, refuses
 * nothing and lets it listen: there the command finds nothing at It's port. So on the machine
 * It runs on, the part of It that hands clicks on is asked as well, at its socket, which such a
 * sandbox leaves open. Where that answers and It's port does not, It is running and this
 * command is shut in.
 */
export const keptFromIt = async (err: unknown): Promise<boolean> => {
  if (notLet(err)) return true
  if (!notReached(err)) return false
  if (await closedToNetwork()) return true
  if (process.env.IT_URL || basePort() === undefined || !connectorThere) return false
  return connectorThere().catch(() => false)
}

/**
 * What the door of an It answers when it will not take a request: one fixed word for why, or,
 * asked by a name it does not answer to, a sentence. A machine that joined from another
 * computer reaches the backend only through that door. This is what its commands say then: what
 * happened and what the person can do about it, never the door's own word by itself. Null for
 * anything that is not the door's refusal.
 */
export function doorRefusal(said: string, at: string): Problem | null {
  const text = said.trim()
  const word = text.startsWith('It does not answer to this name.') ? 'unknown_host' : /^\{"error":"([a-z_]{1,40})"\}$/.exec(text)?.[1]
  if (!word) return null
  if (word === 'unknown_host')
    return new Problem(
      `The It at ${at} does not answer to that address.`,
      'offline',
      'On the machine It runs on, `it network` lists the addresses it answers to. Join at one of those with `it login`, after `it logout` if this machine had joined at another.',
    )
  if (['backend_unreachable', 'fault', 'content_failed', 'too_slow'].includes(word))
    return new Problem(`The It at ${at} is running, and could not answer just now. Try again in a moment.`, 'unavailable')
  if (word === 'too_large') return new Problem('That is more than It takes in one request.', 'limit')
  if (word === 'too_many_wrong_codes')
    return new Problem(
      'Too many codes from this machine were refused in the last minute.',
      'rate_limited',
      'Wait a minute, then try again with a code made just now.',
    )
  return new Problem(
    `The It at ${at} does not take that from another machine (${word}).`,
    'unsupported',
    'The two may be different versions of It. `it version` says which this one is, and the older of the two is the one to update.',
  )
}

/**
 * The door of the It this machine asks, on a machine that has no It of its own: the address it
 * was given, which is IT_URL, or IT_SITE_URL where the address for HTTP is another, and failing
 * that the address it joined at. An address that was given is believed over the one the machine
 * joined at, since it is how the machine is told that its It has moved. Undefined on the machine
 * It runs on, whose door is its own, and where no door is known.
 */
function door(): string | undefined {
  if (basePort() !== undefined) return undefined
  const given = process.env.IT_URL ? process.env.IT_SITE_URL || process.env.IT_URL : undefined
  return given ? given.replace(/\/$/, '') : readJson<Machine>(machineFile())?.at
}

/**
 * An address at It's door, as this machine reaches the door. The backend names the door as the
 * machine it runs on reaches it, which names nothing on any other machine: there the same thing
 * is asked for at the door this machine asks, however it came to know it.
 */
export function throughDoor(address: string): string {
  const at = door()
  if (!at) return address
  try {
    const asked = new URL(address)
    return `${at}${asked.pathname}${asked.search}`
  } catch {
    return address
  }
}

/** The site's address, where a person opens It in a browser: on the machine It runs on, that machine's own, and on any other, the door it asks. Undefined where It has not been set up. */
export function siteAddress(): string | undefined {
  const port = basePort()
  return port !== undefined ? `http://localhost:${port}` : door()
}

// ---------- a request on a connection of this program's own ----------

// Both runtimes can send what `fetch` and `node:http` ask through a proxy named in the
// environment: Bun whenever HTTP_PROXY is set, whatever the request says, and Node when it is
// told to use the environment's proxy. Neither can be told otherwise for one request. What is
// asked of It carries a machine's proof of who it is, its tokens, the keys in It's settings and
// a person's pages, and It is on this machine or on the person's own network, so none of it may
// go by way of a proxy. A request to It's backend or to its door is therefore written on a
// connection this program opens itself, to the very address it is for, where nothing in the
// environment can stand in between. It speaks plain HTTP, which is all It speaks. What is
// fetched from the internet is not asked this way, since a person behind a proxy needs it there.

/** Where a request is sent: a port of a machine, or a socket in a folder. */
export type Where = { host: string; port: number } | { path: string }
/**
 * A body given in pieces, which is sent as the pieces come and never held whole. Whatever makes
 * the pieces is told when the request is over before it had given them all: the `return` of
 * what it is read through is called then, once.
 */
type Pieces = AsyncIterable<Uint8Array>
/** One request: what is asked for, and what is sent with it. */
export interface Sent {
  method?: string
  /** The path that is asked for, with whatever follows it. */
  path: string
  /**
   * What is said beside the request. Where the request ends is this program's to say and nobody
   * else's: a `content-length` may be given, and has to be the length of the body, and neither
   * `transfer-encoding` nor `upgrade` is taken.
   */
  headers?: HeadersInit
  /** Given whole, or in pieces. For a body in pieces the `content-length` header says how long it is, and it must be exactly that long. */
  body?: string | Uint8Array | Pieces
  /** Ends the request, and its connection, when it is aborted. What it was aborted with is what the request then fails with. */
  signal?: AbortSignal
  /** The most bytes of an answer's body that are read. */
  most?: number
}
export interface Answered {
  status: number
  headers: Headers
  body: Buffer
}

/** The most bytes of an answer's body that are read unless the request says otherwise: more than any of It's functions returns. */
const ANSWER_MOST = 32 * 1024 * 1024
/** The most bytes an answer's first lines may be, every answer that only said to go on among them, and the most the lines after a body sent in pieces may be. */
const HEAD_MOST = 64 * 1024
/** The most bytes of the line that says how long a piece of a body is. */
const LINE_MOST = 1024
/** What a header's name is made of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** What a header's value is made of: what can be printed, and tabs. Nothing in it can end a line, and no other byte that says something to a terminal or a parser is in it either. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** A failure of the exchange itself, under the code the system has for the nearest thing. */
const fault = (code: 'EPROTO' | 'ECONNRESET' | 'EMSGSIZE', message: string, cause?: unknown) =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code })
const notHttp = () => fault('EPROTO', 'What answered did not answer as It does.')
const lost = (cause?: unknown) => fault('ECONNRESET', 'The connection was lost before the answer was whole.', cause)
const tooLong = () => fault('EMSGSIZE', 'The answer is longer than this program reads.')
const unsendable = (why: string) => new TypeError(`That is not a request that can be sent: ${why}.`)

/** A header as one line of an answer gives it, or a refusal where the line is not one. */
function headerIn(line: string): [name: string, value: string] {
  const colon = line.indexOf(':')
  const name = line.slice(0, Math.max(colon, 0))
  const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '')
  if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) throw notHttp()
  return [name, value]
}

/** An answer's first lines: its status and headers, where its body begins, and how the end of the body is known. */
export interface Head {
  status: number
  headers: Headers
  from: number
  /** A number of bytes, or `pieces` for a body sent in pieces that say their own lengths, `end` for one that lasts until the connection ends, and `none`. */
  length: number | 'pieces' | 'end' | 'none'
}
/**
 * The first lines of the answer in what has arrived so far, or null while they are not all
 * there. An answer that only says to go on is passed over for the one that follows it.
 *
 * Whatever is not as an answer is written is refused, and nothing is made of it by guessing:
 * a header that is not a name and a value, a length that is not one number, a way of sending
 * the body other than in pieces, and a length said beside that way, which leaves two places
 * where the body could end.
 */
export function headIn(got: Buffer, method: string): Head | null {
  let at = 0
  for (;;) {
    // What is no answer is known by how it begins, and is not waited for to its end
    if (!'HTTP/'.startsWith(got.subarray(at, at + 5).toString('latin1'))) throw notHttp()
    const end = got.indexOf('\r\n\r\n', at)
    if ((end === -1 ? got.length : end + 4) > HEAD_MOST) throw notHttp()
    const text = got.subarray(at, end === -1 ? got.length : end).toString('latin1')
    // A line ends with both of the bytes that end one. One that ends with the second alone would be waited for without end
    if (/(^|[^\r])\n/.test(text)) throw notHttp()
    if (end === -1) return null
    const [first = '', ...lines] = text.split('\r\n')
    const [, minor, digits, reason = ''] = /^HTTP\/1\.([01]) (\d{3})(?: (.*))?$/.exec(first) ?? []
    const status = Number(digits)
    if (!status || !HEADER_VALUE.test(reason)) throw notHttp()
    const headers = new Headers()
    try {
      for (const line of lines) headers.append(...headerIn(line))
    } catch {
      throw notHttp()
    }
    const from = end + 4
    if (status < 200) {
      at = from
      continue
    }
    const sending = headers.get('transfer-encoding')
    const length = headers.get('content-length')
    if (length !== null && !/^\d{1,15}$/.test(length)) throw notHttp()
    if (sending !== null && (sending.toLowerCase() !== 'chunked' || length !== null || minor === '0')) throw notHttp()
    if (method === 'HEAD' || status === 204 || status === 304) return { status, headers, from, length: 'none' }
    if (sending !== null) return { status, headers, from, length: 'pieces' }
    if (length === null) return { status, headers, from, length: 'end' }
    return { status, headers, from, length: Number(length) }
  }
}
/**
 * Something that reads the body of an answer whose first lines have been read, from its bytes
 * as they come. It is given each piece that arrives, once, and answers with the body as soon as
 * it is whole, and with null until then. Given null, which says that the other end has closed
 * the connection, it answers with the body if that is how the body ends, and otherwise fails:
 * a body that is not all there by then never will be.
 *
 * No more than `most` bytes of a body are kept, however the body is sent, and one that says
 * beforehand that it is longer is refused as soon as it has said so. Of a body sent in pieces
 * only the pieces are kept: the lines between them are read and let go of as they come.
 */
export function bodyOf(head: Head, most: number): (piece: Buffer | null) => Buffer | null {
  const kept: Buffer[] = []
  let size = 0
  const keep = (bytes: Buffer) => {
    size += bytes.length
    if (size > most) throw tooLong()
    if (bytes.length) kept.push(bytes)
  }
  const whole = () => Buffer.concat(kept, size)
  if (head.length === 'none') return () => Buffer.alloc(0)
  if (head.length === 'end')
    return (piece) => {
      if (piece === null) return whole()
      keep(piece)
      return null
    }
  if (typeof head.length === 'number') {
    const length = head.length
    if (length > most) throw tooLong()
    return (piece) => {
      // What comes after the body is no part of it
      if (piece !== null) keep(piece.subarray(0, length - size))
      if (size === length) return whole()
      if (piece === null) throw lost()
      return null
    }
  }
  /** What is read next: the line that says how long a piece is, the piece, the end of line after it, or the lines after the last piece. */
  let next: 'length' | 'piece' | 'end' | 'after' = 'length'
  /** How much of the piece being read is still to come, and how long the lines after the last piece have been so far. */
  let left = 0
  let after = 0
  /** What has arrived and cannot be read yet: the beginning of a line, and never more than a line may be. */
  let unread: Buffer = Buffer.alloc(0)
  return (piece) => {
    if (piece === null) throw lost()
    const got = unread.length ? Buffer.concat([unread, piece]) : piece
    let at = 0
    for (;;) {
      if (next === 'piece') {
        const have = Math.min(left, got.length - at)
        keep(got.subarray(at, at + have))
        at += have
        left -= have
        if (left > 0) break
        next = 'end'
      }
      if (next === 'end') {
        if (got.length - at < 2) break
        // A piece ends with the end of a line and with nothing else
        if (got[at] !== 0x0d || got[at + 1] !== 0x0a) throw notHttp()
        at += 2
        next = 'length'
      }
      // A line ends with both of the bytes that end one, and one that ends with the second alone is not waited for
      const ends = got.indexOf(0x0a, at)
      if ((ends === -1 ? got.length : ends) - at > (next === 'after' ? HEAD_MOST : LINE_MOST)) throw notHttp()
      if (ends === -1) break
      if (ends === at || got[ends - 1] !== 0x0d) throw notHttp()
      const line = got.subarray(at, ends - 1).toString('latin1')
      at = ends + 1
      if (next === 'length') {
        // A piece begins with its length in hexadecimal, and may say more after a semicolon, which is passed over
        const said = /^([0-9a-fA-F]{1,12})[ \t]*(;.*)?$/.exec(line)
        if (!said || !HEADER_VALUE.test(said[2] ?? '')) throw notHttp()
        left = Number.parseInt(said[1]!, 16)
        if (size + left > most) throw tooLong()
        next = left === 0 ? 'after' : 'piece'
      } else {
        // After the last piece come lines of the sender's own, if any, each written as a header is, and then an empty one
        if (line === '') return whole()
        after += line.length + 2
        if (after > HEAD_MOST) throw notHttp()
        headerIn(line)
      }
    }
    unread = at < got.length ? got.subarray(at) : Buffer.alloc(0)
    return null
  }
}

/**
 * Sends one request on a connection of this program's own, and gives the answer once it is all
 * there. The connection is used for the one request and then closed.
 *
 * A request that fails says why in a way a caller can tell apart. Where no connection could be
 * made it fails with the system's own error, whose `code` is `ECONNREFUSED` when nothing
 * listens there. Where the connection was made and then lost before the answer was whole, the
 * `code` is `ECONNRESET`. What answered otherwise than an answer is written fails with the
 * `code` `EPROTO`, and an answer longer than is read with `EMSGSIZE`. Where it was given up on,
 * it fails with what its signal was aborted with, which for a time limit is an error named
 * `TimeoutError`.
 *
 * Everything the request set going ends when the request does, however it ends: its
 * connection, what it listens to its signal with, and the reading of a body in pieces.
 */
export function ask(where: Where, sent: Sent): Promise<Answered> {
  const method = sent.method ?? 'GET'
  const most = sent.most ?? ANSWER_MOST
  return new Promise((resolve, reject) => {
    let headers: Headers
    try {
      headers = new Headers(sent.headers)
    } catch {
      return reject(unsendable('a header of it cannot be one'))
    }
    // A port that nothing can be asked at is no port, and is never made into another
    if (!('path' in where) && !(Number.isInteger(where.port) && where.port > 0 && where.port < 65536))
      return reject(unsendable('the port it is for is not one'))
    if (!/^[A-Z]{1,16}$/.test(method)) return reject(unsendable('its method is not one'))
    if (!/^\/[\x21-\x7e]*$/.test(sent.path)) return reject(unsendable('its path is not one'))
    const given = sent.body
    const whole =
      given === undefined || typeof given === 'string'
        ? Buffer.from(given ?? '')
        : given instanceof Uint8Array
          ? Buffer.from(given.buffer, given.byteOffset, given.byteLength)
          : null
    const pieces = whole === null ? (given as Pieces) : null
    // Where the request ends is said here and nowhere else, as the length of its body. A caller
    // may say that length too, and for a body in pieces has to, and what it says has to be so.
    // Whatever else could move the end of the request is not taken from a caller at all.
    if (headers.has('transfer-encoding') || headers.has('upgrade')) return reject(unsendable('how it is sent is not for a header of it to say'))
    const said = headers.get('content-length')
    if (said !== null && !/^\d{1,15}$/.test(said)) return reject(unsendable('the length it gives is not one'))
    if (pieces && said === null) return reject(unsendable('a body given in pieces has to say how long it is'))
    if (whole && said !== null && Number(said) !== whole.length) return reject(unsendable('the length it gives is not the length of its body'))
    const length = whole ? whole.length : Number(said)
    if (!headers.has('host')) headers.set('host', 'path' in where ? 'localhost' : `${where.host.includes(':') ? `[${where.host}]` : where.host}:${where.port}`)
    headers.set('connection', 'close')
    if (given !== undefined || (method !== 'GET' && method !== 'HEAD')) headers.set('content-length', String(length))
    else headers.delete('content-length')
    // Nothing that could end one line of a request and begin another is ever written into it,
    // and nothing that is written as one byte and is not one
    const lines: string[] = []
    let fit = true
    headers.forEach((value, name) => {
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) fit = false
      lines.push(`${name}: ${value}`)
    })
    if (!fit) return reject(unsendable('a header of it cannot be one'))
    const first = `${method} ${sent.path} HTTP/1.1\r\n${lines.map((line) => `${line}\r\n`).join('')}\r\n`

    const socket = 'path' in where ? net.connect({ path: where.path }) : net.connect({ host: where.host, port: where.port })
    let connected = false
    /** What has arrived while the answer's first lines are not all there. */
    let arrived: Buffer = Buffer.alloc(0)
    let head: Head | null = null
    let body: ((piece: Buffer | null) => Buffer | null) | null = null
    let settled = false
    /** Called when the request is over, by whatever of it is still waiting for something. */
    const over: (() => void)[] = []
    const settle = (err: unknown, answer?: Answered) => {
      if (settled) return
      settled = true
      sent.signal?.removeEventListener('abort', aborted)
      socket.destroy()
      for (const tell of over.splice(0)) tell()
      if (answer) resolve(answer)
      else reject(err)
    }
    const aborted = () => settle(sent.signal?.reason ?? new DOMException('The request was given up on.', 'AbortError'))
    /** Takes what has just arrived, or null for the other end having closed, and settles once the answer is whole or can never be. */
    const hear = (piece: Buffer | null) => {
      if (settled) return
      try {
        let fresh = piece
        if (!body) {
          if (piece) arrived = arrived.length ? Buffer.concat([arrived, piece]) : piece
          head = headIn(arrived, method)
          // Closed with its first lines not all there: what had begun as an answer was lost on its way
          if (!head && piece === null) throw lost()
          if (!head) return
          body = bodyOf(head, most)
          fresh = arrived.subarray(head.from)
          arrived = Buffer.alloc(0)
        }
        const all = (fresh && body(fresh)) ?? (piece === null ? body(null) : null)
        if (all) settle(null, { status: head!.status, headers: head!.headers, body: all })
      } catch (err) {
        settle(err)
      }
    }
    /** Writes the request. A body in pieces is written a piece at a time, each once the connection has taken the one before. */
    const send = async () => {
      socket.write(first, 'latin1')
      if (whole) {
        if (whole.length) socket.write(whole)
        return
      }
      const source = pieces![Symbol.asyncIterator]()
      /** Settles when the request is over, so that a piece that never comes is not waited for. */
      const ended = new Promise<null>((done) => over.push(() => done(null)))
      let written = 0
      let all = false
      try {
        while (!settled) {
          const coming = source.next()
          // Left waiting when the request ends first, it may yet fail, which is then nobody's to hear
          coming.catch(() => {})
          const next = await Promise.race([coming, ended])
          if (settled || next === null) break
          if (next.done) {
            all = true
            break
          }
          const piece = next.value
          written += piece.length
          if (written > length) throw unsendable('its body is longer than it said')
          if (!socket.write(piece))
            await new Promise<void>((taken) => {
              const go = () => {
                socket.off('drain', go)
                socket.off('close', go)
                taken()
              }
              socket.on('drain', go)
              socket.on('close', go)
            })
        }
      } finally {
        // Whatever makes the pieces is told that no more of them are wanted
        if (!all) void Promise.resolve(source.return?.()).catch(() => {})
      }
      if (!settled && written !== length) throw unsendable('its body is shorter than it said')
    }
    socket.once('connect', () => {
      connected = true
      send().catch((err) => settle(err))
    })
    socket.on('data', hear)
    socket.on('end', () => hear(null))
    socket.on('close', () => hear(null))
    socket.on('error', (err) => settle(connected ? lost(err) : err))
    if (sent.signal?.aborted) aborted()
    else sent.signal?.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * The pieces of a stream as they come. The stream is taken hold of only when the first piece is
 * asked for, so one that was never sent from is left as it was given. Left off before its end,
 * it is cancelled, which ends a read of it that is still waiting: leaving off what a stream is
 * ordinarily read through waits for that read first, and a stream that has no more to give
 * would be held for ever.
 */
function piecesOf(stream: ReadableStream<Uint8Array>): Pieces {
  return {
    [Symbol.asyncIterator]: () => {
      const reader = stream.getReader()
      const letGo = () => {
        try {
          reader.releaseLock()
        } catch {}
      }
      return {
        async next() {
          const read = await reader.read()
          if (read.done) letGo()
          return read as IteratorResult<Uint8Array>
        },
        async return() {
          await reader.cancel().catch(() => {})
          letGo()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/**
 * One request to It's backend or its door, taken and answered as `fetch` takes and answers one,
 * and sent as `ask` sends it: on a connection of this program's own, which no proxy named in
 * the environment is ever part of. It fails as `ask` fails.
 *
 * It is `fetch` as far as It is ever asked anything, and no further. The address is plain
 * `http`, given as text or as a URL. A body is text or bytes, or a stream of a length the
 * `content-length` header gives, which is sent as it comes. The answer is read whole. An answer
 * that points somewhere else is given back as it is, and nothing is ever sent on to wherever it
 * names. A time limit is a signal that ends it, as `AbortSignal.timeout` makes one.
 */
export async function direct(
  input: string | URL | Request,
  init: { method?: string; headers?: HeadersInit; body?: BodyInit | Uint8Array | Pieces | null; signal?: AbortSignal | null } = {},
): Promise<Response> {
  if (typeof input !== 'string' && !(input instanceof URL)) throw unsendable('its address is given as text')
  const url = new URL(input)
  if (url.protocol !== 'http:') throw unsendable('It is asked over plain http')
  const body = init.body ?? undefined
  const stream = body instanceof ReadableStream
  if (
    body !== undefined &&
    typeof body !== 'string' &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer) &&
    !stream &&
    !(Symbol.asyncIterator in body)
  )
    throw unsendable('its body is neither text, bytes nor a stream')
  let headers: Headers
  try {
    headers = new Headers(init.headers)
  } catch {
    throw unsendable('a header of it cannot be one')
  }
  headers.set('host', url.host)
  const answered = await ask(
    // An address that names no port means the one plain http is asked at. One that names a port means that port and no other
    { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? 80 : Number(url.port) },
    {
      method: init.method?.toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers,
      body:
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : stream
            ? piecesOf(body as ReadableStream<Uint8Array>)
            : (body as string | Uint8Array | Pieces | undefined),
      signal: init.signal ?? undefined,
    },
  )
  if (answered.status > 599) throw notHttp()
  const empty = answered.status === 204 || answered.status === 205 || answered.status === 304
  return new Response(empty ? null : new Uint8Array(answered.body), { status: answered.status, headers: answered.headers })
}

/**
 * What the live connection to It is opened with, so that it too is direct. Bun opens one to the
 * address it is for, whatever proxy the environment names. Node, told to use the environment's
 * proxy, opens one through it, and takes the word of a dispatcher instead: so it is given one
 * of the kind it already uses, told to send nothing by way of a proxy. Node keeps the class of
 * that dispatcher to itself, and it is found on the one Node is using. Where Node has been told
 * to use a proxy and no such dispatcher can be made, the connection is refused, and never opened
 * through the proxy.
 */
export function directWebSocket(): typeof WebSocket {
  if ('Bun' in globalThis) return WebSocket
  const using = Object.getOwnPropertySymbols(globalThis)
    .filter((symbol) => symbol.description?.startsWith('undici.globalDispatcher.'))
    .map((symbol) => (globalThis as unknown as Record<symbol, { constructor?: new (options: { noProxy: string }) => unknown } | undefined>)[symbol])
    .find((dispatcher) => dispatcher?.constructor?.name === 'EnvHttpProxyAgent')
  if (!using?.constructor) {
    const options = `${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS ?? ''}`
    const told = /(^|\s)--use-env-proxy(\s|$)/.test(options) || process.env.NODE_USE_ENV_PROXY === '1'
    const named = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'].some((name) => process.env[name])
    if (told && named)
      throw new Problem(
        'This Node opens its connections through the proxy named in its environment, and It opens none of its own through a proxy.',
        'unsupported',
        'Run `it` without NODE_USE_ENV_PROXY and without --use-env-proxy, or install the standalone `it` program, which needs no Node at all.',
      )
    return WebSocket
  }
  const none = new using.constructor({ noProxy: '*' })
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, { protocols, dispatcher: none } as unknown as string[])
    }
  }
}

/**
 * Whether an error says that nothing could be reached at an address: no connection could be
 * made, or the one that was made was lost before an answer was whole, or what answered was not
 * It. It is told by the code the system gives it, and never by its words: the two runtimes word
 * the same failure differently. A request sent with `direct` carries that code under both. A
 * runtime's own `fetch` says the same thing in its own way, Node under the error's cause and
 * Bun under names of its own, and those are known here too.
 */
export function notReached(err: unknown): boolean {
  const codes = [(err as { code?: unknown } | null)?.code, (err as { cause?: { code?: unknown } } | null)?.cause?.code]
  return codes.some((code) => typeof code === 'string' && NOT_REACHED.has(code))
}
const NOT_REACHED = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EPIPE',
  'EPROTO',
  'ETIMEDOUT',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
])

// ---------- this machine's identity ----------

export interface Machine {
  id: string
  name: string
  key: JWK
  /** On a machine that joined an It running on another: the address it joined at. */
  at?: string
  /** And the address that It's backend signs under, which is whom this machine's proofs are made out to. */
  issuer?: string
}
export const machineFile = () => inHome('machine.json')
export function machine(): Machine {
  return (
    readJson<Machine>(machineFile()) ??
    (() => {
      throw notSetUp()
    })()
  )
}
/** Whether this machine holds an identity: it is enrolled where It runs, or has joined an It on another computer. */
export const enrolledHere = () => existsSync(machineFile())
/** Whether the backend is one this machine does not run itself: the one IT_URL names, or the one on the machine it joined. */
export const elsewhere = () => Boolean(process.env.IT_URL) || Boolean(readJson<Machine>(machineFile())?.at)
/**
 * The identity this machine had at each It it has left: the id it had there, and nothing else
 * of it. Joining the same It again names that identity, so that the pages its conversations
 * made, and what is waiting on them, come along to the new one. That It takes the word for it
 * only of an identity that is the same person's and was given up.
 */
const wasFile = () => inHome('was.json')
const wasAll = (): { at: string; id: string }[] => {
  const kept = readJson<unknown>(wasFile())
  return Array.isArray(kept) ? kept.filter((w): w is { at: string; id: string } => typeof w?.at === 'string' && typeof w?.id === 'string') : []
}
export const wasAt = (at: string): string | undefined => wasAll().find((w) => w.at === at)?.id
export function forgetMachine(): void {
  const m = readJson<Machine>(machineFile())
  if (typeof m?.at === 'string' && typeof m.id === 'string') {
    try {
      writePrivate(wasFile(), [...wasAll().filter((w) => w.at !== m.at), { at: m.at, id: m.id }].slice(-20))
    } catch {}
  }
  for (const f of ['machine.json', 'token.json']) rmSync(inHome(f), { force: true })
}
/**
 * The note that this folder is what a machine left behind: one that had joined an It and left
 * it, or one whose add-ons were all that was still here. `it setup --none` reads it, and begins
 * nothing in such a folder. It holds nothing of the machine, and goes when a machine is in the
 * folder again.
 */
const leftFile = () => inHome('left.json')
export const hasLeft = (): boolean => existsSync(leftFile())
export const noteLeft = (): void => writePrivate(leftFile(), { left: true })
/** Keeps this machine's identity, in a file of this person's alone. */
export function keepMachine(m: Machine): void {
  writePrivate(machineFile(), m)
  rmSync(leftFile(), { force: true })
}

/** A time limit for one request, which also ends with whatever the request is part of, when that is given. */
const within = (ms: number, ending?: AbortSignal) => (ending ? AbortSignal.any([ending, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms))
/** A wait before something is tried again, which is over at once when whatever it is part of ends. */
const waited = (ms: number, ending?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ending?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      ending?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    ending?.addEventListener('abort', done, { once: true })
  })

/** The address an It's backend signs under, as it says at its door. Nothing when it could not be asked. */
async function issuerAt(door: string, ending?: AbortSignal): Promise<string | undefined> {
  const said = (await direct(`${door}/cli/config`, { signal: within(15_000, ending) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { issuer?: unknown } | null
  return typeof said?.issuer === 'string' ? said.issuer : undefined
}

/** What a machine is told when It does not take it for one of the person's machines any more, with how it becomes one again. */
export const notKnown = (m: Pick<Machine, 'at'>) =>
  new Problem(
    'It does not know this machine any more: it was revoked on the site, or everything It held was erased there.',
    'unauthenticated',
    m.at ? 'Run `it logout`, then join again with `it login`.' : 'Run `it setup` to enrol it again.',
  )

/**
 * A token the backend believes for five minutes. The machine gets one by signing a statement
 * with its key: which machine, for which address, when, and a number used once. The address is
 * the one the backend signs under, which on the machine It runs on is where it is reached.
 * Tokens are kept until just before they run out, so a burst of commands shares one.
 *
 * `ending` is a signal of whatever the token is for. Once it is aborted nothing more is asked
 * and nothing more is waited for, and this fails with what the signal was aborted with.
 */
export async function token(
  force = false,
  ending?: AbortSignal,
  /** What has been tried once already for this token, and how often the backend has had trouble answering. */
  tried: { proof?: boolean; issuer?: boolean; troubles?: number } = {},
): Promise<string> {
  ending?.throwIfAborted()
  const m = machine()
  const b = backend()
  const cached = readJson<{ token: string; exp: number; machine: string; site: string }>(inHome('token.json'))
  if (!force && cached && cached.machine === m.id && cached.site === b.site && cached.exp - Date.now() / 1000 > 45) return cached.token
  const proof = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(m.id)
    .setAudience(`${m.issuer ?? b.site}/bridge/token`)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(await importJWK(m.key, 'ES256'))
  const r = await direct(`${b.site}/bridge/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machine: m.id, proof }),
    signal: within(15_000, ending),
  }).catch(async (err) => {
    ending?.throwIfAborted()
    throw (await keptFromIt(err)) ? shutIn() : unreachable(b.site)
  })
  if (r.status === 401) {
    const why = (await r.json().catch(() => ({}))) as { reason?: string; now?: number }
    // A proof made at the wrong time looks like being revoked unless the two are told apart
    if (why.reason === 'clock') {
      const off = typeof why.now === 'number' ? Math.round(Date.now() / 1000 - why.now) : null
      throw new Problem(
        `This machine's clock is wrong${off === null ? '' : ` by about ${Math.abs(off)} seconds`}, so It cannot tell that its requests are fresh.`,
        'clock',
        'Set the clock, then try again.',
      )
    }
    // A proof that was merely unlucky (it took too long on its way, or its number was taken)
    // says nothing about the machine: another is made, once, and after that it is trouble, not
    // being turned away. Anything else is the backend not knowing this machine's key any more.
    if (why.reason === 'proof') {
      if (!tried.proof) return token(true, ending, { ...tried, proof: true })
      throw new Problem('It would not take this machine’s proof just now. Try again in a moment.', 'unavailable')
    }
    // A proof is made out to the address the backend signs under. A machine that joined keeps
    // that address from when it joined, and it has the backend's port in it: an It that has
    // since been given another port to count from signs under another address, and takes a
    // proof made out to the old one for no proof of this machine's. So the address is read
    // again at the door, and where it is another one, it is kept and the proof made again, once.
    if (why.reason === 'signature') {
      const signsUnder = m.issuer === undefined || tried.issuer ? undefined : await issuerAt(b.site, ending)
      if (signsUnder !== undefined && signsUnder !== m.issuer) {
        keepMachine({ ...m, issuer: signsUnder })
        return token(true, ending, { ...tried, issuer: true })
      }
      throw new Problem(
        'It did not take this machine’s proof of who it is: the key this machine holds is not the one It has for it.',
        'unauthenticated',
        m.at ? 'Run `it logout --force`, then join again with `it login`.' : 'Run `it setup` to enrol it again.',
      )
    }
    throw notKnown(m)
  }
  if (r.status === 429) throw new Problem('Too many requests from this machine. Try again shortly.', 'rate_limited')
  // Trouble on the backend's side, not a refusal: a burst of commands all asking for a token at
  // the same instant can trip over each other there. Asked again, a moment later, a few times,
  // and after that said as trouble that will pass, not as an error of the caller's.
  if (r.status >= 500) {
    const troubles = tried.troubles ?? 0
    if (troubles < 3) {
      await waited(150 + Math.random() * 400 * (troubles + 1), ending)
      return token(force, ending, { ...tried, troubles: troubles + 1 })
    }
    throw new Problem('It could not check this machine’s proof of who it is just now. Try again in a moment.', 'unavailable')
  }
  if (!r.ok)
    throw doorRefusal(await r.text().catch(() => ''), b.site) ?? new Problem(`It would not check this machine’s proof of who it is (${r.status}).`, 'error')
  const body = (await r.json().catch(() => null)) as { token?: unknown; expires_in?: unknown } | null
  if (typeof body?.token !== 'string' || typeof body.expires_in !== 'number')
    throw new Problem('It answered this machine’s proof with something that is no token.', 'error')
  // Kept so a burst of commands shares one token. Inside a harness's sandbox the folder may be
  // read-only, and then the token is simply used once.
  try {
    writePrivate(inHome('token.json'), { token: body.token, exp: Math.floor(Date.now() / 1000) + body.expires_in, machine: m.id, site: b.site })
  } catch {}
  return body.token
}

/** Turns a refusal from the backend into a Problem with its code. */
async function translate(err: unknown): Promise<never> {
  if (err instanceof Problem) throw err
  if (err instanceof ConvexError) {
    const data = (typeof err.data === 'string' ? JSON.parse(err.data) : err.data) as {
      code?: string
      message?: string
      noSuchDisplay?: boolean
      anothers?: boolean
    }
    throw new Problem(data.message ?? 'Refused.', data.noSuchDisplay ? 'no_such_display' : data.anothers ? 'anothers' : (data.code ?? 'error'))
  }
  const text = String((err as Error)?.message ?? err)
  if (clashed(err)) throw new Problem('It is busy just now. Try again in a moment.', 'unavailable')
  let tried = 'the address it was given'
  try {
    tried = backend().api
  } catch {}
  // The door of the It this machine joined would not pass the call on
  const atDoor = doorRefusal(text, tried)
  if (atDoor) throw atDoor
  // Given up on after waiting: unlike a refusal, this does not say whether it went through
  if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError')
    throw new Problem('It did not answer in time, so whether that went through is not known.', 'timeout', 'Check with `it list` before doing it again.')
  // The system would not let the connection be opened, which says nothing of whether It runs
  if (await keptFromIt(err)) throw shutIn()
  // Nothing answered at all, which is told by the system's code for it and not by the error's words
  if (notReached(err)) throw unreachable(tried)
  // What the backend says of a request it could not read is a sentence inside JSON: the sentence is what is said
  const first = text.split('\n')[0]!
  let sentence: unknown
  try {
    sentence = (JSON.parse(first) as { message?: unknown } | null)?.message
  } catch {}
  throw new Problem((typeof sentence === 'string' && sentence ? sentence : first).slice(0, 300), 'error')
}

// Two calls that touched the same record at the same instant (a burst of commands counted
// against one limit, say): the backend gives up on one of them, having done nothing for it. So
// it is simply asked again, a moment later, a few times.
export const clashed = (err: unknown): boolean => /changed while this mutation was being run/.test(String((err as Error)?.message ?? err))
/**
 * The backend is run so that it keeps from its callers why a call failed, unless its own code
 * refused it: it says "Server Error" and no more. A clash may arrive looking like that. For a
 * single transaction it is safe to ask again whatever the reason was: one that failed did nothing.
 */
export const unexplained = (err: unknown): boolean => !(err instanceof ConvexError) && /\] Server Error\s*$/.test(String((err as Error)?.message ?? err).trim())
export async function overClashes<T>(
  run: () => Promise<T>,
  pause: (n: number) => Promise<unknown> = (n) => new Promise((r) => setTimeout(r, 100 + Math.random() * 300 * n)),
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (err) {
      if (!(clashed(err) || unexplained(err)) || n > 3) throw err
      await pause(n)
    }
  }
}

/** One call to the backend as this machine. A token that has just expired is replaced once. */
export async function call<T = any>(kind: 'query' | 'mutation' | 'action', fn: unknown, args: Record<string, unknown> = {}): Promise<T> {
  const attempt = async (force: boolean): Promise<T> => {
    // No call may hang for ever: a laptop that woke on another network would otherwise wait
    // minutes. An action does more than a query does (checking a whole upload, say) and is given longer.
    const limit = kind === 'action' ? 90_000 : 20_000
    const client = new ConvexHttpClient(backend().api, {
      fetch: (input, init) => direct(input, { ...init, signal: AbortSignal.timeout(limit) }),
      // What the backend's functions write down is not this program's to print: a backend may
      // send it along with each answer, and printed it would land in what an agent reads
      logger: false,
    })
    client.setAuth(await token(force))
    return (client as any)[kind](fn, args) as Promise<T>
  }
  // Only what is one transaction is asked again after a clash: nothing of it was done. An action
  // is several steps, some of which may have been, and it asks again for its own steps itself.
  const once = (force: boolean) => (kind === 'mutation' ? overClashes(() => attempt(force)) : attempt(force))
  try {
    return await once(false)
  } catch (err) {
    const data = err instanceof ConvexError ? ((typeof err.data === 'string' ? JSON.parse(err.data) : err.data) as { code?: string }) : null
    if (data?.code === 'unauthenticated') return once(true).catch(translate)
    return translate(err)
  }
}

/**
 * A live connection, for watching. The caller closes it. `onNotKnown` is called if It turns out
 * not to know the machine any more; anything else that goes wrong fetching a token (no network
 * yet, a busy backend) is waited out here, because the connection gives up for good if it is
 * ever told there is no token.
 *
 * Closing the connection ends all of that with it: a token that is being asked for is given up
 * on, a wait before the next try is over, and nothing is asked again.
 */
export function live(onNotKnown?: () => void, onTrouble?: (err: unknown) => void): ConvexClient {
  // What the backend's functions write down is theirs to keep: a backend may send it along
  // with each answer, and it is not printed here
  const client = new ConvexClient(backend().api, { logger: false, webSocketConstructor: directWebSocket() })
  const closed = new AbortController()
  client.setAuth(async ({ forceRefreshToken }) => {
    for (let attempt = 0; !closed.signal.aborted; attempt++) {
      try {
        return await token(forceRefreshToken, closed.signal)
      } catch (err) {
        if (closed.signal.aborted) break
        if (err instanceof Problem && err.code === 'unauthenticated') {
          onNotKnown?.()
          return null
        }
        onTrouble?.(err)
        await waited(Math.min(1000 * 2 ** attempt, 30_000), closed.signal)
      }
    }
    return null
  })
  const close = client.close.bind(client)
  client.close = () => {
    closed.abort()
    return close()
  }
  return client
}

/**
 * Where a person keeps each harness's settings, when it is not the usual place. These are kept
 * for every command run on a harness, and written into the background service's definition, so
 * that the connector looks in the same place as the shell that ran `it setup`.
 */
export const PROFILE_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'HERMES_HOME',
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
] as const

/**
 * The environment a harness's own command is run with. This program may itself be running
 * inside an agent's session, and what marks that session must not leak into a command meant
 * for another. Where the person keeps a harness's settings is theirs to say, and is kept.
 */
export function harnessEnv(): NodeJS.ProcessEnv {
  const keep = new Set<string>(PROFILE_VARS)
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.has(k) || !/^(CLAUDE|CODEX_|IT_SESSION$|IT_HARNESS$)/.test(k)))
  // And what the person's shell has that this program was not started with, where it was asked
  return { ...own, ...fromShell }
}

/** What the person's shell adds for the apps this program runs (see `shell-env`). Nothing until it has been asked. */
let fromShell: NodeJS.ProcessEnv = {}
let shellAskedAt = 0
let shellAsking: Promise<void> | null = null
let shellIsAsked = false
/**
 * Has the person's shell asked for what it gives a program, now and from time to time, for the
 * apps this program runs. Only the background service does this: started by the system, it has
 * none of what a person exports in their shell's files, and an app that takes its key from
 * there would fail when reopened. A program started from a terminal has it all already.
 */
export function askShell(said?: (line: string) => void): void {
  // Someone whose shell's files are not to be run by a service says so, and the apps then get what the service has
  if (/^(0|off|false|no)$/i.test((process.env.IT_SHELL_ENV ?? '').trim())) return
  shellIsAsked = true
  void shellLearned().then(() => {
    const n = Object.keys(fromShell).filter((k) => k !== 'PATH').length
    said?.(
      shellAskedAt && n
        ? `agent apps that It reopens are given ${n} setting${n === 1 ? '' : 's'} of your shell that the background service was started without`
        : 'agent apps that It reopens are given the environment the background service was started with',
    )
  })
}
/**
 * An app that this program ran has ended badly, and what it lacked may be something the person
 * has since put in their shell's files: the shell is asked again before the next app is run.
 */
export function shellMayHaveChanged(): void {
  shellAskedAt = 0
}
/**
 * Resolves once the shell has been asked, where it is asked at all. What was learned more than
 * a few minutes ago is asked for again without being waited for, so that a key someone adds to
 * their shell's files is there the next time, and no reopening waits for a shell twice.
 */
export function shellLearned(maxAgeMs = 5 * 60_000): Promise<void> {
  if (!shellIsAsked) return Promise.resolve()
  if (!shellAsking && (!shellAskedAt || Date.now() - shellAskedAt > maxAgeMs))
    shellAsking = shellEnv()
      .then((found) => {
        if (found) fromShell = added(process.env, found)
        shellAskedAt = Date.now()
      })
      .catch(() => {
        shellAskedAt = Date.now()
      })
      .finally(() => {
        shellAsking = null
      })
  return shellAskedAt ? Promise.resolve() : (shellAsking ?? Promise.resolve())
}

// ---------- which conversation is asking ----------

// The variable each app sets, by itself, for the commands its agent runs. In the order they are
// guessed in when nothing better is known, which puts Claude Code last (see `sessionAsked`).
const OWN_MARKS: [string, Harness][] = [
  ['CODEX_THREAD_ID', 'codex'],
  ['OPENCLAW_SESSION_ID', 'openclaw'],
  ['HERMES_SESSION_ID', 'hermes'],
  ['OPENCODE_SESSION_ID', 'opencode'],
  ['PI_SESSION_ID', 'pi'],
  ['CLAUDE_CODE_SESSION_ID', 'claude-code'],
]
const APP_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  pi: 'Pi',
}

/** The conversation a command is taken to be in, and how far that is known. */
export interface Asking {
  session: { harness: string; id: string }
  /**
   * The other apps whose marks were on the command too, when which of them ran it could not be
   * seen and the conversation is therefore a choice among them. Empty when it is known.
   */
  unsettled: string[]
}

/**
 * The agent session a command is running inside, if the harness tells us.
 *
 * Each app marks the commands its agent runs. Claude Code, Codex, Pi and Hermes set a variable
 * of their own. It's add-ons for Claude Code, OpenCode and OpenClaw set the pair IT_HARNESS and
 * IT_SESSION, and so may a person or a script that wants to say which conversation it is. A
 * command also inherits every mark that was already in the environment of the app that ran it.
 * So when one app is started from inside another, the command carries the marks of both, and
 * they are the same marks whichever of the two is the inner one. What is believed, in order:
 *
 *  1. Only one app's marks are there: that app. For Claude Code its own variable is believed
 *     over the pair, because after the person resumes another conversation the add-on's note is
 *     a moment behind, and a page made in that moment would belong to the conversation just
 *     left. For any other app the pair is believed over the app's variable: nothing writes such
 *     a pair but someone who means it.
 *  2. Two apps' marks are there: the app whose process is nearest above this command. The inner
 *     app is the one that ran the command, so its process stands between the command and the
 *     outer app's. Nothing else tells the two ways round apart, and it is looked up only now.
 *     One thing is believed over it: a pair that names an app other than Claude Code, when that
 *     app is nowhere above. Someone set it by hand, or its app runs under a name that is not
 *     known. Claude Code's pair gets no such standing, because it is inherited by every app
 *     that is started from inside a Claude Code conversation, however far from it.
 *  3. None of the marked apps can be seen above (it is not looked up on Windows, and a sandbox
 *     can hide the processes above): the pair, whichever app it names, because an add-on writes
 *     it afresh for each command its own agent runs and an app's own variable is only ever
 *     inherited. With no pair, another app's variable before Claude Code's. This is a choice
 *     and not knowledge. It is wrong for an app without such an add-on that was started from
 *     inside one that has it.
 *
 * Wherever the pair is believed over what was seen above, or nothing was seen, the answer says
 * which other apps' marks were there, so that whoever ran the command can be told.
 */
export function sessionAsked(
  e: NodeJS.ProcessEnv = process.env,
  /** The agent apps this command was started from, the nearest first: given by the tests. */
  above: () => readonly string[] = agentAppsAbove,
): Asking | undefined {
  // Every app whose mark is there, with the conversation it names, in the order of the guess
  const marked = new Map<string, string>()
  const pair = e.IT_HARNESS && e.IT_SESSION ? { harness: e.IT_HARNESS, id: e.IT_SESSION } : undefined
  if (pair && pair.harness !== 'claude-code') marked.set(pair.harness, pair.id)
  for (const [name, harness] of OWN_MARKS) if (e[name] && !marked.has(harness)) marked.set(harness, e[name])
  if (pair && !marked.has(pair.harness)) marked.set(pair.harness, pair.id)
  if (marked.size === 0) return undefined
  const as = (harness: string, known: boolean): Asking => ({
    session: { harness, id: marked.get(harness)! },
    unsettled: known ? [] : [...marked.keys()].filter((other) => other !== harness),
  })
  if (marked.size === 1) return as(marked.keys().next().value!, true)
  const apps = above()
  const nearest = apps.find((app) => marked.has(app))
  if (!nearest) return as(pair?.harness ?? marked.keys().next().value!, false)
  if (pair && pair.harness !== 'claude-code' && !apps.includes(pair.harness)) return as(pair.harness, false)
  return as(nearest, true)
}

/** The agent session a command is running inside, as `sessionAsked` finds it. */
export function currentSession(
  e: NodeJS.ProcessEnv = process.env,
  above: () => readonly string[] = agentAppsAbove,
): { harness: string; id: string } | undefined {
  return sessionAsked(e, above)?.session
}

/**
 * What a command says beside its result when the conversation it acted for was a choice among
 * several: which one was chosen (`did` begins that sentence), which other apps had marked the
 * command, and what to do if the choice is wrong (`otherwise`). Nothing when the conversation
 * is known.
 */
export function sessionNote(asked: Asking | undefined, did: string, otherwise: string): string | undefined {
  if (!asked?.unsettled.length) return undefined
  const name = (harness: string) => (Object.hasOwn(APP_NAMES, harness) ? APP_NAMES[harness]! : harness)
  const others = asked.unsettled.map(name)
  const listed = others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others.at(-1)}` : others[0]
  return `${did} the ${name(asked.session.harness)} conversation ${asked.session.id}. This command also carried the marks of ${listed}, and which of them ran it could not be told. If that is not the conversation you are in, ${otherwise}`
}

/**
 * Takes whole tables out of a TOML file's text: each from its header to the next header, with
 * whatever settings, comments and blank lines stand in it. Taking a header alone would leave
 * its settings to fall into the table before it, which may then say one thing twice and be no
 * TOML at all. Comments and blank lines that stand directly before the next table are taken to
 * introduce that one, and stay with it where it stays.
 */
export function withoutTables(text: string, owned: (header: string) => boolean): string {
  const out: string[] = []
  let dropping = false
  let held: string[] = []
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      dropping = owned(line.trim())
      if (!dropping) out.push(...held, line)
      held = []
    } else if (!dropping) out.push(line)
    else if (/^\s*(#.*)?\r?$/.test(line)) held.push(line)
    else held = []
  }
  // The file ended in a table that is going: it still ends with the end of a line, if it did
  if (dropping && text.endsWith('\n') && out.at(-1) !== '') out.push('')
  return out.join('\n')
}
