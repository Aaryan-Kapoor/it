// Reads every log a run left behind, and fails if one of them holds something that should
// never be written down: a credential, a key, a code that pairs a browser, a session, a
// ticket, or what a page or a person sent.
//
//   node e2e/logs.mjs [folder or file ...]     defaults to where e2e/stack.mjs keeps its log
//
// Every file under a folder is read, whatever it is called and however large: what CI keeps as
// an artifact is exactly what was read here, and a file that cannot be read fails the check.
// A file is read for what it is: as plain text, and as text kept at two bytes to the letter
// where its first bytes or its empty bytes say it is that. One that is no text of either kind
// fails the check too, and so does one with a line whose bytes are not the text the file is
// kept as. It says which file and line and what kind of thing, and never the thing itself.
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { credentialsIn, encodingOf, withoutCredentials } from '../scripts/secrets.mjs'
import { notedSecrets, PRIVATE_MARK, STACK_LOGS } from './lib.mjs'

export { PRIVATE_MARK }

// What a log must not hold: any credential, the things only this product has among them. It is
// everything the check of what is committed looks for (scripts/secrets.mjs), found by the same
// function: what has a shape of its own, and a long value under a name that says it is a
// secret, which is how the secrets an installation makes for itself are told. Each is found
// whoever's it is and whether or not the run noted it. A log is no program, so nothing in one
// is passed over as code that only reads a value.
const LOG = 'a.log'
/** What marks a thing a page or a person sent. Made when it is looked for and not as this file is read, so that e2e/lib.mjs, which this file takes the mark from, may take a name from this file in its turn. */
const privateThings = () => ({ 'what a page or a person sent': new RegExp(PRIVATE_MARK) })
/** What is said of a file that is no text, on the line where that shows. */
const NO_TEXT = 'bytes that are no text, so that it cannot be read'
/** What the CLI printed, to the person or to their agent, is theirs: it may hold a name they chose or what a page sent. It may not hold a credential. */
const PRINTED = ['cli.said.log', 'cli.answers.txt']
/**
 * Whether a file is what the CLI printed. It is told by the file's own name and by nothing of
 * the folders before it, which one system writes with `/` between them and another with `\`.
 * `way` is how the system the file is on writes a path, which is this system's unless it is said.
 */
export const printedByCli = (file, way = path) => PRINTED.includes(way.basename(file))
/**
 * What a run noted that it holds (e2e/lib.mjs, noteSecret), read back from the file it kept
 * them in. `unread` says why when a file was named and not all of it could be read: whoever
 * reads the logs knowing less than the run held cannot vouch for them.
 */
function inventory() {
  const file = process.env.IT_E2E_INVENTORY
  if (!file) return { held: {} }
  if (!existsSync(file)) return { held: {}, unread: 'nothing was noted there' }
  const held = {}
  let unread
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const { what, value } = JSON.parse(line)
      if (typeof what !== 'string' || typeof value !== 'string') throw new Error('not a note')
      held[`${what} (${Object.keys(held).length + 1})`] = value
    } catch {
      unread = 'a line of it is not what the run writes'
    }
  }
  return { held, unread }
}
// Whatever the run noted, here or in the file, looked for as it is
const values = () => ({ ...inventory().held, ...notedSecrets() })
const known = (extra = {}) => Object.entries({ ...values(), ...extra }).filter(([, v]) => typeof v === 'string' && v.length >= 12)

/**
 * Text as it may be printed: with anything shaped like a credential, and any credential this
 * run knows of, taken out. What a failed check says goes to the step's own log, which nothing
 * scans afterwards, so it is cleaned before it is said.
 */
export function redact(text, extra = {}) {
  let out = String(text)
  for (const [what, value] of known(extra)) out = out.split(value).join(`[${what}]`)
  return withoutCredentials(out, LOG)
}

/**
 * One check's line as it is printed: whether it passed, its name, and for one that failed, what
 * was found. All of it is cleaned, the name too: a name may quote what an error said, and what
 * an error says may quote a credential. What was found is cleaned before it is cut short, so
 * that no part of a credential is left by the cut.
 */
export function verdict(name, ok, detail = '', length = 400) {
  return `${ok ? '  ok  ' : '  FAIL'} ${redact(name)}${ok || !detail ? '' : `\n         ${redact(String(detail)).slice(0, length)}`}`
}

/**
 * From here on, what ends this script with nothing having caught it is printed cleaned as
 * well, and not as it stands: an error thrown, a promise that failed with nobody waiting on it.
 */
export function printCleanly() {
  for (const how of ['uncaughtException', 'unhandledRejection'])
    process.on(how, (err) => {
      console.error(redact(err?.stack ?? String(err)))
      process.exit(1)
    })
}

/**
 * The stack's own files (e2e/stack.mjs), as they stand: its log, where the service and the
 * part of it that shows pages write, what setup said, and anything else it left beside them.
 * Not the folders there, which a run that keeps its own files in one reads for itself.
 */
export const stackLogs = (folder = STACK_LOGS) =>
  existsSync(folder)
    ? readdirSync(folder)
        .sort()
        .map((name) => path.join(folder, name))
        .filter((file) => statSync(file).isFile())
    : []

/**
 * The file in which a check of a run notes that it found something that nothing written down
 * may hold, for any later check of the same run: found once is found, and the check that is
 * made when the run is over refuses wherever this file is there. It stands beside the file the
 * run notes what it holds in, which IT_E2E_INVENTORY names, and there is none where that names
 * nothing. Whatever finds something adds its lines to it, here and in e2e/lib.mjs, and nothing
 * writes over what another put there. A line says where and what kind of thing, and never the
 * thing.
 */
export const foundNote = () => (process.env.IT_E2E_INVENTORY ? `${process.env.IT_E2E_INVENTORY}.found` : null)

function files(at, out = []) {
  const stat = statSync(at)
  if (!stat.isDirectory()) out.push(at)
  else for (const name of readdirSync(at).sort()) files(path.join(at, name), out)
  return out
}

/** How a file keeps its text (scripts/secrets.mjs, encodingOf), and whether it has empty bytes at all. */
async function writtenAs(file) {
  let start = Buffer.alloc(0)
  let even = 0
  let odd = 0
  let before = 0
  for await (const chunk of createReadStream(file)) {
    if (start.length < 2) start = Buffer.concat([start, chunk.subarray(0, 2 - start.length)])
    for (let at = chunk.indexOf(0); at >= 0; at = chunk.indexOf(0, at + 1)) (before + at) % 2 ? odd++ : even++
    before += chunk.length
  }
  return { encoding: encodingOf(start, even, odd), empty: even + odd > 0 }
}

/** How a line's bytes are read as text: strictly, which refuses bytes that are not the text they are said to be, and as best they can be read. */
const STRICT = { utf8: new TextDecoder('utf-8', { fatal: true }), utf16le: new TextDecoder('utf-16le', { fatal: true }) }
const AS_BEST = { utf8: new TextDecoder('utf-8'), utf16le: new TextDecoder('utf-16le') }
/**
 * A file's lines, read as text kept in the way named. A line at a time, so that a log of any
 * size is read to its end. Each line comes with whether its bytes are sound: text kept in that
 * way, every letter of it whole. One that is not is read as best it can be, so that what is in
 * it is looked for all the same.
 */
async function* linesOf(file, encoding) {
  const two = encoding !== 'utf8'
  const kept = two ? 'utf16le' : 'utf8'
  const line = (bytes) => {
    try {
      // A letter of two bytes that has only one of them is no letter
      if (two && bytes.length % 2) throw new TypeError('half a letter')
      return { text: STRICT[kept].decode(bytes), sound: true }
    } catch {
      return { text: AS_BEST[kept].decode(bytes), sound: false }
    }
  }
  /** Where the next line ends in what is held, or -1: at the byte that ends a line, which at two bytes to the letter stands at an even place with an empty byte after it. */
  const end = (held, from) => {
    for (let at = held.indexOf(0x0a, from); at >= 0; at = held.indexOf(0x0a, at + 1)) {
      if (!two) return at
      if (at % 2 === 0 && held[at + 1] === 0) return at
      if (at + 1 >= held.length) return -1
    }
    return -1
  }
  let held = Buffer.alloc(0)
  let waiting = Buffer.alloc(0)
  for await (let chunk of createReadStream(file)) {
    if (encoding === 'utf16be') {
      // The two bytes of each letter change places. A byte whose partner has not come yet waits for it
      const all = Buffer.concat([waiting, chunk])
      waiting = Buffer.from(all.subarray(all.length - (all.length % 2)))
      chunk = Buffer.from(all.subarray(0, all.length - waiting.length)).swap16()
    }
    held = held.length ? Buffer.concat([held, chunk]) : chunk
    let from = 0
    for (let at = end(held, from); at >= 0; at = end(held, from)) {
      yield line(held.subarray(from, at))
      from = at + (two ? 2 : 1)
    }
    held = Buffer.from(held.subarray(from))
  }
  // What is left when the file ends is its last line, with any byte that never got its partner
  const last = Buffer.concat([held, waiting])
  if (last.length) yield line(last)
}

/** Every place in these folders, or these files, where a log holds what it should not, or is no text that can be read. */
export async function leaks(paths, extra = {}) {
  const found = []
  const looked = known(extra)
  let read = 0
  for (const at of paths) {
    if (!existsSync(at)) continue
    for (const file of files(at)) {
      const answers = printedByCli(file)
      const things = Object.entries(privateThings())
      // Each thing on a line once, however many ways the line was read
      const here = new Map()
      const look = (line, n) => {
        for (const { what } of credentialsIn(line, LOG)) here.set(`${n} ${what}`, { file, line: n, what })
        if (!answers) for (const [what, shape] of things) if (shape.test(line)) here.set(`${n} ${what}`, { file, line: n, what })
        for (const [what, value] of looked) if (line.includes(value)) here.set(`${n} ${what}`, { file, line: n, what })
      }
      const { encoding, empty } = await writtenAs(file)
      // As plain text, and with its empty bytes taken out: whatever put them there, what is
      // written between them is still found
      let n = 0
      let noText = 0
      for await (const { text, sound } of linesOf(file, 'utf8')) {
        n += 1
        look(text, n)
        // Plain text is what the file is kept as where nothing says otherwise, and every line of it has to be that
        if (encoding === 'utf8' && !sound) noText ||= n
        if (!empty || !text.includes('\0')) continue
        look(text.replaceAll('\0', ''), n)
        if (!encoding) noText ||= n
      }
      // And as text kept at two bytes to the letter, where it is that
      if (encoding && encoding !== 'utf8') {
        n = 0
        for await (const { text, sound } of linesOf(file, encoding)) {
          n += 1
          look(text, n)
          if (!sound || text.includes('\0')) noText ||= n
        }
      }
      if (noText) here.set(`${noText} ${NO_TEXT}`, { file, line: noText, what: NO_TEXT })
      found.push(...[...here.values()].sort((a, b) => a.line - b.line))
      read += 1
    }
  }
  // Whatever a later scan of the same run sees or does not see, this one found something
  const note = foundNote()
  if (found.length && note) {
    try {
      appendFileSync(note, `${found.map((f) => `${f.file}:${f.line} ${f.what}`).join('\n')}\n`, { mode: 0o600 })
    } catch {}
  }
  return { found, read }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const paths = process.argv.slice(2)
  if (!paths.length) paths.push(STACK_LOGS)
  const earlier = foundNote() !== null && existsSync(foundNote())
  const { found, read } = await leaks(paths)
  if (!read) {
    console.error(`no logs to read in ${paths.join(', ')}`)
    process.exit(1)
  }
  if (earlier) {
    console.error('The run’s own check of what it wrote down found a credential. Nothing of it is to be kept.')
    process.exit(1)
  }
  // This program was told where the run noted the credentials it held, and looks for exactly
  // those. Where that cannot be read, it does not know what to look for, and says so
  const { unread } = inventory()
  if (unread) {
    console.error(`What the run held cannot be read back (${unread}), so what it wrote down cannot be vouched for. Nothing of it is to be kept.`)
    process.exit(1)
  }
  for (const f of found) console.error(`  ${f.file}:${f.line}  holds ${f.what}`)
  console.log(
    found.length ? `${found.length} line(s) in ${read} file(s) hold something a log must not` : `${read} file(s) read to the end, none holds a credential`,
  )
  if (found.length) process.exit(1)
}
