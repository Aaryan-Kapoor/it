// Reading a command line, kept apart from the commands so it can be tested by itself.
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { sizeSaid, UPLOAD } from '@it/protocol'
import { Problem } from './lib'

export const BOOLEAN = new Set([
  'open',
  'follow',
  'replace',
  'sticky',
  'all',
  'none',
  'no-open',
  'no-setup',
  'no-service',
  'no-wait',
  'failed',
  'json',
  'help',
  'yes',
  'take',
  'force',
  'check',
  'status',
  'wait',
  'supervised',
  'refresh',
  'everywhere',
])
/** The switches that take a value: every other name a command line gives is refused, so that a misspelt one is never taken for nothing and the word after it never lost. */
export const VALUED = new Set([
  'id',
  'file',
  'dir',
  'html',
  'state',
  'agent',
  'title',
  'on',
  'on-id',
  'button',
  'timeout',
  'if-revision',
  'only',
  'name',
  'url',
  'code',
  'log',
  'step',
  'param',
  'save',
  'number',
  'after',
  'state-file',
])
export interface Args {
  _: string[]
  flags: Record<string, string | boolean>
  many: Record<string, string[]>
}
/** The options each command can honour. JSON and help apply to every public command. */
export const OPTIONS: Record<string, readonly string[]> = {
  create: ['id', 'file', 'dir', 'html', 'state', 'state-file', 'agent', 'open', 'on', 'on-id', 'everywhere', 'take'],
  update: ['id', 'file', 'dir', 'html', 'title', 'agent', 'open', 'on', 'on-id', 'everywhere', 'take'],
  list: [],
  read: [],
  delete: ['status'],
  rollback: [],
  set: ['if-revision', 'file'],
  patch: ['replace', 'if-revision', 'file'],
  state: [],
  say: [],
  open: ['on', 'on-id', 'everywhere'],
  notify: ['id', 'on', 'on-id', 'everywhere', 'sticky', 'button'],
  displays: [],
  wait: ['id', 'follow', 'timeout'],
  actions: ['id', 'all', 'follow', 'after'],
  action: [],
  save: ['number'],
  ack: ['failed'],
  setup: ['all', 'only', 'none', 'name', 'no-service', 'yes', 'refresh'],
  login: ['url', 'code', 'name', 'no-setup', 'all', 'only', 'none', 'no-service', 'yes'],
  logout: ['force'],
  uninstall: ['yes'],
  site: ['no-open'],
  network: [],
  https: [],
  status: [],
  whoami: [],
  serve: ['log', 'supervised'],
  service: [],
  skill: [],
  tour: ['wait', 'timeout'],
  'tour show': ['agent', 'param', 'on', 'on-id', 'everywhere'],
  'tour clear': [],
  'tour answer': ['file', 'wait', 'no-wait', 'timeout'],
  'tour next': ['timeout'],
  telemetry: [],
  upgrade: ['check'],
  runs: [],
  'runs clear': ['yes'],
  updates: [],
  version: [],
  '--version': [],
  '-v': [],
  help: [],
  '--help': [],
  '-h': [],
}

/** Refuses unused options before a command reads input, contacts It or changes a file. */
export function optionsFor(cmd: string | undefined, a: Args): void {
  const sub = `${cmd} ${a._[0]}`
  const name = Object.hasOwn(OPTIONS, sub) ? sub : (cmd ?? 'help')
  const allowed = new Set(['json', 'help', ...(Object.hasOwn(OPTIONS, name) ? OPTIONS[name]! : [])])
  for (const flag of Object.keys(a.flags))
    if (!allowed.has(flag)) throw new Problem(`\`it ${name}\` does not take --${flag}.`, 'invalid', '`it help` lists what each command takes.')
  if (cmd === 'save' && !a.flags.help) {
    if (a._.length !== 2 || a._.some((word) => !word || word.startsWith('-')))
      throw new Problem('Say which action and file to save.', 'invalid', 'Usage: it save <action-id> <file> [--number <n>]')
    for (const [flag, values] of Object.entries(a.many)) if (values.length > 1) throw new Problem(`--${flag} may be given only once.`, 'invalid')
    const number = text(a, 'number')
    if (number !== undefined && (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number))))
      throw new Problem('--number is the number of one of the files the action carried, from 1.', 'invalid')
  }
  if (cmd === 'tour' && a._.length === 0 && a.flags.timeout !== undefined && a.flags.wait !== true)
    throw new Problem('--timeout needs --wait with `it tour`.', 'invalid', 'Usage: it tour --wait [--timeout <seconds>]')
  if (cmd === 'login' && a.flags['no-setup'] === true) {
    const unused = ['all', 'only', 'none', 'no-service', 'yes'].find((flag) => a.flags[flag] !== undefined)
    if (unused) throw new Problem(`--${unused} cannot be used with --no-setup.`, 'invalid', 'Leave out --no-setup to connect agent apps after joining.')
  }
}

/** Finds the output preference even when another option prevents the rest from parsing. */
export function outputArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, many: {} }
  for (const word of argv) {
    if (word === '--') break
    if (word === '--json') a.flags.json = true
    else if (word.startsWith('--json=')) {
      // An invalid value is an argument error. Keep that error machine-readable when JSON was requested.
      a.flags.json = !['false', '0', 'no'].includes(word.slice(7).toLowerCase())
    }
  }
  return a
}
/** What a switch given as `--name=value` is set to. Anything that is neither a yes nor a no is refused, since guessing could switch on what the person meant to leave off. */
function onOrOff(name: string, value: string): boolean {
  const said = value.toLowerCase()
  if (['true', '1', 'yes'].includes(said)) return true
  if (['false', '0', 'no'].includes(said)) return false
  throw new Problem(`--${name} is a switch, and "${value}" is neither yes nor no.`, 'invalid', `Write --${name} to switch it on, or leave it out.`)
}
export function parse(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, many: {} }
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--') {
      a._.push(...argv.slice(i + 1))
      break
    }
    if (!word.startsWith('--') || word.length === 2) {
      a._.push(word)
      continue
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word.slice(2) : word.slice(2, eq)
    // A name no command reads is refused, and nothing is done: left alone it would pass for a
    // switch that was given, and would take the word after it, another switch included
    if (!BOOLEAN.has(name) && !VALUED.has(name))
      throw new Problem(`--${name} is not something \`it\` knows.`, 'invalid', '`it help` lists what each command takes.')
    let value: string | boolean
    // A switch written with a value is on or off as the value says, and is never kept as text:
    // text is true to whatever asks whether the switch was given, "false" included
    if (eq !== -1) value = BOOLEAN.has(name) ? onOrOff(name, word.slice(eq + 1)) : word.slice(eq + 1)
    else if (BOOLEAN.has(name)) value = true
    else {
      const next = argv[++i]
      if (next === undefined) throw new Problem(`--${name} needs a value.`, 'invalid')
      // What follows is another switch, so the value was left out: a value that begins so is written --name=value
      if (next.startsWith('--') && next.length > 2)
        throw new Problem(
          `--${name} needs a value, and what follows it is ${next.split('=')[0]}.`,
          'invalid',
          `Write --${name}=<value> for a value that begins with two dashes.`,
        )
      value = next
    }
    a.flags[name] = value
    if (typeof value === 'string') a.many[name] = [...(a.many[name] ?? []), value]
  }
  return a
}
export const text = (a: Args, name: string): string | undefined => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined)
export function need(value: string | undefined, what: string, usage: string): string {
  if (value === undefined || value === '') throw new Problem(`Say ${what}.`, 'invalid', `Usage: it ${usage}`)
  return value
}
/**
 * Whether a value is what a shell leaves of a JSON object or array once it has taken every
 * double quote out of it. Windows PowerShell 5.1 does that to each argument it hands to a
 * program, so that `{"number":4}` arrives as `{number:4}`. Such a value is never made back into
 * JSON, since where the quotes were cannot be known: `{note:a,b}` was `{"note":"a,b"}` as
 * easily as `{"note":"a","b":…}`.
 */
export function quotesTakenOut(value: string): boolean {
  const t = value.trim()
  if (t.includes('"') || !((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false
  try {
    JSON.parse(t)
    return false
  } catch {
    return true
  }
}
/** What a refusal of JSON from the command line says to do instead: give it in a file, which no shell changes. */
const inAFile = (fromFile: string) => `Write the JSON to a file and run \`${fromFile}\`, which works the same in every shell.`
const SHELL_TOOK = 'as when a shell takes them out of an argument, which Windows PowerShell 5.1 does'
/**
 * Reads JSON. `fromFile` is the command that reads the same JSON from a file, where it was given
 * on the command line: a refusal names it, since a file is the way that works in every shell.
 */
export function json(value: string, what: string, fromFile?: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    const instead = fromFile === undefined ? undefined : inAFile(fromFile)
    if (fromFile !== undefined && quotesTakenOut(value))
      throw new Problem(`${what} is not valid JSON: it has no double quotes, ${SHELL_TOOK}.`, 'invalid', instead)
    throw new Problem(`${what} is not valid JSON.`, 'invalid', instead)
  }
}
/**
 * The value `it set` was given on its command line: JSON where it parses as JSON, and text
 * otherwise. A value that is what a shell leaves of a JSON object or array is neither taken for
 * text nor made back into JSON, but refused, with the way that works: as text it would put
 * `[a,b c]` on the page where the agent wrote `["a","b c"]`, and say nothing.
 */
export function setValue(value: string, fromFile: string): unknown {
  if (quotesTakenOut(value))
    throw new Problem(
      `The value ${value} begins and ends as JSON does, but is not JSON and has no double quotes, ${SHELL_TOOK}. Nothing was changed.`,
      'invalid',
      `${inAFile(fromFile)} To set this very text, write it in the file as a JSON string.`,
    )
  return loose(value)
}
/**
 * The text of a file that a command was given JSON in, in place of an argument. Its bytes are
 * read as UTF-8, or as UTF-16 where they begin with the mark that says so, as Windows
 * PowerShell 5.1 writes a file with Out-File. A mark of UTF-8 at the start is passed over. Any
 * other bytes are refused, and no other encoding is guessed at.
 */
export function fileText(file: string, what: string): string {
  if (file === '') throw new Problem(`Say which file ${what} is in.`, 'invalid')
  const link = () =>
    new Problem(`${file} is a link, and It does not read JSON through a link.`, 'invalid', 'Give the path of the file itself, not of a link to it.')
  // A link is never followed, as a page's own files are not: a link in a project could point at
  // any file on the machine, and what is read here goes into a page's state, which the page reads.
  // It is refused before opening, and by the system itself as the file is opened, in case one was
  // put there in between; and the file is never waited for, as a pipe put there would be
  let fd: number
  let before: BigIntStats
  try {
    before = lstatSync(file, { bigint: true })
    if (before.isSymbolicLink()) throw link()
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    if (err instanceof Problem) throw err
    const code = (err as { code?: string })?.code
    if (code === 'ENOENT') throw new Problem(`No such file: ${file}`, 'invalid')
    if (code === 'ELOOP' || code === 'EMLINK') throw link()
    throw err
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) throw new Problem(`${file} is not an ordinary file.`, 'invalid')
    // Where the system cannot refuse a link as it opens a file, as on Windows, the name may have
    // been pointed at another file after it was looked at: what was opened must be what was looked at
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw link()
    // Windows may give no usable id for a file: 0 where the file system keeps none, or every bit
    // set where it cannot make one unique. Two files then look the same, and so where a link
    // cannot be refused as the file is opened, a file without a usable id is not read at all
    if (constants.O_NOFOLLOW === undefined && (stat.ino === 0n || stat.ino === 0xffffffffffffffffn))
      throw new Problem(
        `It cannot tell on this drive whether ${file} is the file it looked at, so it does not read it.`,
        'invalid',
        "Write the JSON to a file in the user's temporary folder, on the system drive, and give that path.",
      )
    const tooLarge = () => new Problem(`${file} is larger than this command reads (${sizeSaid(UPLOAD.requestBytes)}).`, 'limit')
    if (stat.size > BigInt(UPLOAD.requestBytes)) throw tooLarge()
    // Read no further than the limit and one byte more, however the file grows while it is read
    const most = UPLOAD.requestBytes + 1
    const pieces: Buffer[] = []
    let got = 0
    while (got < most) {
      const piece = Buffer.allocUnsafe(Math.min(most - got, 1 << 20))
      const n = readSync(fd, piece, 0, piece.length, null)
      if (n === 0) break
      pieces.push(piece.subarray(0, n))
      got += n
    }
    if (got > UPLOAD.requestBytes) throw tooLarge()
    return decoded(Buffer.concat(pieces, got), file)
  } finally {
    closeSync(fd)
  }
}
/** Bytes as text: UTF-8, or UTF-16 of either order where they begin with its mark. Bytes that are not whole and valid characters in that encoding are refused. */
export function decoded(bytes: Uint8Array, file: string): string {
  const [a, b, c] = bytes
  try {
    if (a === 0xef && b === 0xbb && c === 0xbf) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3))
    if (a === 0xff && b === 0xfe) return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2))
    if (a === 0xfe && b === 0xff) {
      // Read as UTF-16 of the other order once each pair of bytes is turned round
      const rest = bytes.subarray(2)
      if (rest.length % 2) throw new Error('odd')
      const turned = new Uint8Array(rest.length)
      for (let i = 0; i < rest.length; i += 2) {
        turned[i] = rest[i + 1]!
        turned[i + 1] = rest[i]!
      }
      return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(turned)
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Problem(`${file} is not text in UTF-8 or UTF-16.`, 'invalid', 'Write the file again in UTF-8.')
  }
}
/** `it set page a.b.c value` is the patch {a:{b:{c:value}}}. A value that parses as JSON is JSON. */
export function nested(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.')
  if (parts.some((p) => p === '' || p === '__proto__' || p === 'constructor' || p === 'prototype')) throw new Problem('That is not a usable key.', 'invalid')
  return parts.reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as Record<string, unknown>
}
export function loose(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
