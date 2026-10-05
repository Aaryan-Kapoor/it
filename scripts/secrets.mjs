// Fails if anything committed here holds something shaped like a credential, or is a file that
// It keeps a machine's secrets in. CI runs this on every commit, with every commit before it.
//
//   node scripts/secrets.mjs             every file as it is committed, and as it is in the
//                                        working folder where that is not the same
//   node scripts/secrets.mjs --history   those, and every file of every commit that leads to
//                                        this one, and every commit's message
//
// It says which file and line and what kind of thing, and never the thing itself. A file it
// cannot read fails the check: nothing is passed over without being said.
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const thisRepository = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Shapes that are credentials whoever they belong to, each named for its shape and for nobody
 * who gives such a thing out, and after them the ones only It has. With the long values under a
 * name that says it is a secret, further down, they are everything this check looks for, and
 * e2e/logs.mjs looks for all of it in logs through the same two functions, `credentialsIn` and
 * `withoutCredentials`.
 */
export const CREDENTIALS = {
  'a signed token': /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/,
  // Many services write a key this way: whether it is the secret or the public one, whether it
  // is for trying things out or for real, and then the key
  'a key marked test or live': /\b[sp]k_(?:test|live)_[A-Za-z0-9_-]{16,}/,
  'a webhook secret': /\bwhsec_[A-Za-z0-9+/=]{16,}/,
  'a private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----|"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/,
  // What follows the word, when it is not an ordinary word itself: one of twelve letters or
  // more that holds a digit, a capital or a mark
  'a bearer credential': /\b[Bb]earer\s+((?=[A-Za-z0-9._~+/=-]*[0-9A-Z._~+/-])[A-Za-z0-9._~+/=-]{12,})/,
  // The name of the backend a key opens, then a bar, then the key. The key It runs its own
  // backend with is written so, under a name that ends in twelve characters of a hash, and so
  // is the key of a backend named by a kind, two words and a number.
  'a key written as a name, a bar and a secret': /\b(?:(?:dev|prod|preview):[a-z]+-[a-z]+-\d+|[a-z][a-z0-9]*-[0-9a-f]{12})\|[A-Za-z0-9+/=]{16,}/,
  'a GitHub token': /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  // What only It has. A code is twenty characters of its own alphabet, and is a credential
  // where something says it is one: the address that pairs a browser, which carries it after
  // the `#`, and the command that joins a machine, which carries it after `--code`. There it
  // may be written between quotes in fours, as the site shows a code to be read.
  'a code that pairs a browser, in an address': /\/pair#[a-z2-7]{20}(?![a-z2-7])/i,
  'a code that joins a machine, in its command': /--code[= ]+(?:["']?[a-z2-7]{20}(?![a-z2-7])|["'][a-z2-7]{4}(?: [a-z2-7]{4}){4}["'])/i,
  // Each session has a cookie of its own, named for the session after the name they all begin with
  'a browser’s session, in its cookie': /\bit_session_[A-Za-z0-9_]+=[A-Za-z0-9_-]{43}/,
  // The path a page's files are at holds the token that is all a request for them is asked for
  'a showing’s address': /\/s\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  // What the door sends the backend with a request about a session, as the header it goes in
  // and as the setting the backend is given it by
  'the door’s key': /\b(?:x-it-door|IT_DOOR_KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/i,
  // What an add-on shows the connector over its socket, wherever on a line the header is written
  'a connector’s token, in its header': /\bx-it-token["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
}

/**
 * Files that hold one machine's settings and so are never committed, whatever is in them: a
 * file of environment variables, and the files It keeps its secrets in, in its own folder. They
 * are the keys It runs its backend with, the keys it sends notifications with, this machine's
 * own key, the token that key last earned, and the token the connector takes its add-ons by.
 */
const NEVER_COMMITTED = /(^|\/)(\.env(\..*)?|service\.json|push\.json|machine\.json|token\.json|connector\.json)$/

// Something set to a long value under a name that says it is a secret, in each way a file may
// write that. The value is what the brackets hold. Between quotes a value is whatever is there,
// marks and all; with no quotes round it, it is what a settings file can write without them.
const VALUE = '[A-Za-z0-9+/=_.:|~-]{16,}'
const QUOTED_VALUE = '[^\\s"\'\\x60]{16,}'
const SECRET_NAME = '(?:secret|token|password|passwd|credential)s?(?:[_-]?key)?|(?:private|deploy|api|access|signing)[_-]?key'
const NAMED = [
  // A settings file, in capitals: SERVICE_TOKEN=..., export SIGNING_SECRET_KEY="..."
  /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DEPLOY_KEY)[A-Z0-9_]*\s*=\s*['"]?([A-Za-z0-9+/=_.:|-]{16,})/,
  // A settings file in any case, with = or a colon and no quotes: password=..., client_secret: ...
  new RegExp(String.raw`^\s*(?:export\s+)?["']?[\w.-]*(?:${SECRET_NAME})["']?\s*[=:]\s*(${VALUE})\s*(?:[#;].*)?$`, 'i'),
  // A field or a declaration with its value in quotes: "token": "...", const apiToken = '...'.
  // An address is not a value: a name such as `token` is also given to where one is asked for.
  new RegExp(String.raw`(?:${SECRET_NAME})["']?\s*[:=]\s*["'\x60](?![a-z][a-z0-9+.-]*:\/\/)(${QUOTED_VALUE})["'\x60]`, 'i'),
]
const NAMED_AS_A_SECRET = 'a long value under a name that says it is a secret'
/**
 * Written without quotes, a path of names such as `body.access_token` is code that reads a
 * value, and no value. That is so only in a program, and only where the name and the path are
 * set apart as a program sets them: `password=correct.horse.battery.staple`, with nothing on
 * either side of the sign, is how a shell and a file of settings write a value, and in a file
 * that is no program a path of names is a value however it is written.
 */
const READS_A_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const PROGRAM = /\.(?:[cm]?[jt]sx?|py|sh|ps1|go|rs|rb|html|md)$/i
const SET_AS_A_SETTING = /[^\s=!<>]=$/
/** Between quotes, text with a place in it for a value to be put is what a program builds a value from, and no value. */
const BUILDS_A_VALUE = /\$\{|\$\(|\{\{|^\$[A-Za-z_]|^<[^<>]*>$|%[sd(]/

// No value is passed over for being one a test made up. A test that needs the shape of a
// credential puts it together as it runs, and one that does not uses a value too short or too
// plain to be taken for one.

// Each shape is looked for all along a line, and says where on the line its value begins
const everywhere = (shape) => new RegExp(shape.source, `${shape.flags.replace(/[gd]/g, '')}gd`)
const SHAPES = [
  ...Object.entries(CREDENTIALS).map(([what, shape]) => ({ what, shape: everywhere(shape) })),
  ...NAMED.map((shape) => ({ what: NAMED_AS_A_SECRET, shape: everywhere(shape), named: true })),
]

/**
 * How a file keeps its text, told from the bytes it begins with and from where its empty bytes
 * stand. Text kept at two bytes to the letter begins with a mark that says which of the two
 * comes first, and where it has no mark, each ordinary letter has an empty byte beside it,
 * always on the same side. `even` and `odd` are how many empty bytes stand at even and at odd
 * places, counted from nought. Null where a file has empty bytes on both sides and no mark:
 * that is no text of either kind.
 */
export function encodingOf(start, even, odd) {
  if (start[0] === 0xff && start[1] === 0xfe) return 'utf16le'
  if (start[0] === 0xfe && start[1] === 0xff) return 'utf16be'
  if (!even && !odd) return 'utf8'
  if (!even) return 'utf16le'
  if (!odd) return 'utf16be'
  return null
}

/**
 * The texts a file's bytes may be, each to be read: the bytes as plain text, and, where they
 * are text kept at two bytes to the letter, that text as well. A file is read both ways because
 * one program may have written into what another began, each in its own way.
 */
export function readingsOf(bytes) {
  const plain = bytes.toString('utf8')
  let even = 0
  let odd = 0
  for (let at = bytes.indexOf(0); at >= 0; at = bytes.indexOf(0, at + 1)) at % 2 ? odd++ : even++
  const encoding = encodingOf(bytes, even, odd)
  if (!encoding || encoding === 'utf8') return [plain]
  const pairs = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
  return [plain, (encoding === 'utf16be' ? pairs.swap16() : pairs).toString('utf16le')]
}

/** Whether a file is a program, by its name. A text that is from no file is read as one. */
const isProgram = (name) => !name || PROGRAM.test(name)

/**
 * Each thing on a line that is shaped like a credential: what kind of thing, and where on the
 * line its value begins and ends. `program` says whether the line is from a program, where a
 * path of names set to a name is code that reads a value.
 */
function* onLine(line, program) {
  for (const { what, shape, named } of SHAPES)
    for (const match of line.matchAll(shape)) {
      const value = match[1] ?? match[0]
      const [from, to] = match.indices[1] ?? match.indices[0]
      const quoted = named && /["'\x60]/.test(line[from - 1] ?? '')
      if (named && quoted && BUILDS_A_VALUE.test(value)) continue
      if (named && !quoted && program && !SET_AS_A_SETTING.test(line.slice(0, from)) && READS_A_VALUE.test(value)) continue
      yield { what, from, to }
    }
}

/**
 * Every line of a text that holds something shaped like a credential, and what kind of thing:
 * each thing on a line once. `name` is the name of the file the text is from, where it is from
 * one: it says whether the file is a program.
 */
export function credentialsIn(text, name = '') {
  const program = isProgram(name)
  // Text with empty bytes in it is read as it is, and again with them taken out: whatever put
  // them there, between the letters or around them, what is written is still found
  const readings = text.includes('\0') ? [text, text.replaceAll('\0', '')] : [text]
  const found = new Map()
  for (const reading of readings)
    reading.split('\n').forEach((line, i) => {
      for (const { what } of onLine(line, program)) found.set(`${i + 1} ${what}`, { line: i + 1, what })
    })
  return [...found.values()].sort((a, b) => a.line - b.line)
}

/**
 * A text as it may be printed: with the value of everything in it that `credentialsIn` would
 * find taken out, and what kind of thing it was said in its place. `name` is read as it is
 * there.
 */
export function withoutCredentials(text, name = '') {
  const program = isProgram(name)
  return text
    .split('\n')
    .map((line) => {
      // From the left, and what lies inside something already taken out is gone with it
      const values = [...onLine(line, program)].sort((a, b) => a.from - b.from || b.to - a.to)
      let out = ''
      let at = 0
      for (const { what, from, to } of values) {
        if (from < at) continue
        out += `${line.slice(at, from)}[${what}]`
        at = to
      }
      return out + line.slice(at)
    })
    .join('\n')
}

/** A file's name as it may be printed: with anything in it that is shaped like a credential taken out. */
export const cleanName = (name) =>
  SHAPES.reduce((out, { what, shape }) => out.replace(shape, (all, value) => (typeof value === 'string' ? all.replace(value, `[${what}]`) : `[${what}]`)), name)

const MIB = 1024 * 1024
/** Git could not be asked, or did not answer. */
class NoAnswer extends Error {}
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Reads a repository and says what it found: `ok`, and the lines to print. `limit` is the
 * largest file it will read, in bytes; a larger one is named and fails the check.
 */
export function scan({ root = thisRepository, history = false, limit = 64 * MIB } = {}) {
  const git = (args, input) => {
    const ran = spawnSync('git', args, { cwd: root, input, maxBuffer: 2 * limit + 64 * MIB, windowsHide: true })
    if (ran.status !== 0) throw new NoAnswer()
    return ran.stdout
  }
  /** What kind of object each of these is, and how large. */
  const sized = (objects) => {
    if (!objects.length) return []
    const said = git(['cat-file', '--batch-check'], `${objects.map((o) => o.id).join('\n')}\n`)
      .toString()
      .split('\n')
    return objects.map((o, i) => ({ ...o, kind: said[i].split(' ')[1], size: Number(said[i].split(' ')[2]) }))
  }
  /** The bytes of each file, asked of git a group at a time so that no answer is larger than can be held. */
  function* bytesOf(files) {
    let group = []
    let weight = 0
    function* answered() {
      if (!group.length) return
      const out = git(['cat-file', '--batch'], `${group.map((f) => f.id).join('\n')}\n`)
      let at = 0
      for (const file of group) {
        const start = out.indexOf(10, at) + 1
        yield [file, out.subarray(start, start + file.size)]
        at = start + file.size + 1
      }
      group = []
      weight = 0
    }
    for (const file of files) {
      group.push(file)
      weight += file.size
      if (weight > limit / 2) yield* answered()
    }
    yield* answered()
  }

  // Each thing once, however many ways it was come by
  const found = new Set()
  const unread = []
  // A name is printed cleaned of anything shaped like a credential: a file can be named for one
  const tooLarge = (name, as = '') =>
    unread.push(`  ${cleanName(name)}${as}  could not be read: it is larger than ${limit >= MIB ? `${Math.floor(limit / MIB)} MiB` : `${limit} bytes`}`)
  const look = (bytes, name, as = '') => {
    for (const text of readingsOf(bytes)) for (const { line, what } of credentialsIn(text, name)) found.add(`  ${cleanName(name)}:${line}  ${as}holds ${what}`)
  }
  // A file's name is read as its contents are
  const lookAtName = (name, as = '') => {
    for (const { what } of credentialsIn(name)) found.add(`  ${cleanName(name)}  ${as}is named with ${what}`)
  }
  try {
    // What is committed, or is about to be: the index, whatever the working files say now
    const index = git(['ls-files', '-s', '-z'])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((entry) => ({ mode: entry.slice(0, 6), id: entry.split(/[ \t]/)[1], name: entry.slice(entry.indexOf('\t') + 1) }))
      // A folder that is a repository of its own is no file here
      .filter((entry) => entry.mode !== '160000')
    for (const { name } of index) {
      if (NEVER_COMMITTED.test(name)) found.add(`  ${cleanName(name)}  is a file of one machine’s settings, and is committed`)
      lookAtName(name)
    }
    const committed = sized(index)
    // What has been looked at here, read or found too large, is not looked at again in the history
    const read = new Set()
    for (const file of committed.filter((f) => f.size > limit)) {
      tooLarge(file.name)
      read.add(file.id)
    }
    for (const [file, bytes] of bytesOf(committed.filter((f) => f.size <= limit))) {
      look(bytes, file.name)
      read.add(file.id)
      // And the file as it is in the working folder, where someone has changed it since
      const working = path.join(root, file.name)
      const there = lstatSync(working, { throwIfNoEntry: false })
      if (!there?.isFile()) continue
      if (there.size > limit) tooLarge(file.name, ' (as it is in the working folder)')
      else {
        const now = readFileSync(working)
        if (!now.equals(bytes)) look(now, file.name, '(as it is in the working folder) ')
      }
    }
    let summary = `${count(index.length, 'committed file')} read`

    if (history) {
      if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true')
        return {
          ok: false,
          lines: [
            ...found,
            'This checkout holds only the newest commits, so its history cannot be read. Fetch all of it first (in CI, a checkout with fetch-depth: 0).',
          ],
        }
      // Every file any commit has held, each once, under the first name it is found by
      const objects = git(['rev-list', '--objects', 'HEAD'])
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => ({
          id: line.slice(0, line.indexOf(' ') < 0 ? undefined : line.indexOf(' ')),
          name: line.indexOf(' ') < 0 ? '' : line.slice(line.indexOf(' ') + 1),
        }))
      const files = sized(objects).filter((o) => o.kind === 'blob')
      const once = (file) => `(as it once was, git object ${file.id.slice(0, 7)}) `
      for (const file of files.filter((f) => f.size > limit && !read.has(f.id))) tooLarge(file.name, ` ${once(file).trim()}`)
      for (const [file, bytes] of bytesOf(files.filter((f) => f.size <= limit && !read.has(f.id)))) look(bytes, file.name, once(file))
      // Every name a file has ever been committed under
      const now = new Set(index.map((f) => f.name))
      const names = new Set(git(['log', '--format=', '--name-only', '--no-renames', '-z', 'HEAD']).toString().split('\0').filter(Boolean))
      for (const name of [...names].sort()) {
        if (now.has(name)) continue
        if (NEVER_COMMITTED.test(name)) found.add(`  ${cleanName(name)}  is a file of one machine’s settings, and was once committed`)
        lookAtName(name, 'was once committed, and ')
      }
      // And what each commit says of itself
      const commits = git(['log', '--format=%H%n%B%x00', 'HEAD'])
        .toString()
        .split('\0')
        .map((c) => c.replace(/^\n/, ''))
        .filter(Boolean)
      for (const commit of commits)
        for (const { line, what } of credentialsIn(commit.slice(commit.indexOf('\n') + 1)))
          found.add(`  the message of commit ${commit.slice(0, 7)}:${line}  holds ${what}`)
      summary = `${count(files.length, 'file')} from ${count(commits.length, 'commit')} read, with every commit’s message`
    }

    const lines = [...found, ...unread]
    if (unread.length)
      lines.push(`${count(unread.length, 'file')} could not be read, so nothing can be said of what ${unread.length === 1 ? 'it holds' : 'they hold'}`)
    if (found.size) lines.push(`${count(found.size, 'thing')} in what is committed ${found.size === 1 ? 'looks like a credential' : 'look like credentials'}`)
    if (lines.length) return { ok: false, lines }
    if (!index.length) return { ok: false, lines: ['No committed files were read: is this a git checkout with anything in it?'] }
    return { ok: true, lines: [`${summary}, none holds a credential`] }
  } catch (err) {
    if (!(err instanceof NoAnswer)) throw err
    return { ok: false, lines: ['What is committed could not be read: this is not a git checkout, or git could not be asked.'] }
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { ok, lines } = scan({ history: process.argv.includes('--history') })
  for (const line of lines) (ok ? console.log : console.error)(line)
  if (!ok) process.exit(1)
}
