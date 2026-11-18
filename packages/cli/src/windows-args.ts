/**
 * JSON on the command line on Windows, read back from the command line itself where the shell
 * spoilt it.
 *
 * A program on Windows is given one command line, and splits it into words itself. Windows
 * PowerShell 5.1 (and PowerShell 7 before 7.3) builds that line from each argument as it is,
 * without writing its double quotes so that the program keeps them, and puts quotes round the
 * whole argument only where it has a space that its count of double quotes puts outside them. So
 * `it patch board '{"note":"two words"}'` reaches the line as `{"note":"two words"}`, and the
 * program's own reading of the line takes the quotes for its own: It is given `{note:two words}`,
 * and where a space falls outside the quotes as it counts them, two words. The JSON is spoilt only
 * in that reading. On the line it is whole, as the agent
 * wrote it, so It reads it from there: this is what makes the form an agent writes in every
 * other shell work in Windows PowerShell as well, `--%` and a file not needed.
 *
 * It is done only where an argument that begins as JSON does, with `{` or `[`, is not JSON as the
 * program was given it, and before any command has started, so that it decides what the command
 * is given and nothing else. The line is split again by the same rules the runtime split it by,
 * and only where those rules give back exactly the words the program was given is anything taken
 * from it. Then each word that begins with `{` or `[` and is not JSON as it was given is replaced
 * by the whole JSON value that begins there on the line, scanned with what JSON says of its strings, where that value can only be
 * the one argument the shell spoilt (see `wholeJson`). Everything else on the line is read as before. Where nothing can be
 * taken back, the words are left as they were given, and the command says what it says today.
 */
import path from 'node:path'
import { BOOLEAN, quotesTakenOut, VALUED } from './args'
import { runSync } from './child'

/** The rules a program on Windows splits its command line by: the C runtime's since 2008, or `CommandLineToArgvW`'s, which read `""` inside quotes differently. */
type Rules = 'crt' | 'shell32'

/** One word of a command line, and where it is on the line: from its first character, a quote included, to just after its last. */
interface Word {
  value: string
  start: number
  end: number
}

const space = (c: string | undefined) => c === ' ' || c === '\t'

/** The program's own name, the first word: up to the next quote where it begins with one, else to the next space, with no backslash read as anything. */
function programName(line: string): Word | null {
  let i = 0
  while (space(line[i])) i++
  if (i >= line.length) return null
  const start = i
  if (line[i] === '"') {
    const close = line.indexOf('"', i + 1)
    const end = close === -1 ? line.length : close + 1
    return { value: line.slice(i + 1, close === -1 ? line.length : close), start, end }
  }
  while (i < line.length && !space(line[i])) i++
  return { value: line.slice(start, i), start, end: i }
}

/** One word that begins at `i` (not a space), read by the rules: backslashes before a quote halve, an odd one left over keeps the quote, and quotes outside that open and close. */
function wordAt(line: string, i: number, rules: Rules): Word {
  const start = i
  let value = ''
  let quoted = false
  while (i < line.length) {
    const c = line[i]!
    if (space(c) && !quoted) break
    if (c === '\\') {
      let n = 0
      while (line[i] === '\\') {
        n++
        i++
      }
      if (line[i] === '"') {
        value += '\\'.repeat(n >> 1)
        if (n % 2 === 1) {
          value += '"'
          i++
        }
      } else value += '\\'.repeat(n)
      continue
    }
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        // `""` inside quotes is one quote; the C runtime stays inside the quotes, shell32 leaves them
        value += '"'
        i += 2
        if (rules === 'shell32') quoted = false
        continue
      }
      quoted = !quoted
      i++
      continue
    }
    value += c
    i++
  }
  return { value, start, end: i }
}

/** Every word of a command line by the rules, the program's name first. */
export function commandLineWords(line: string, rules: Rules = 'crt'): Word[] {
  const first = programName(line)
  if (!first) return []
  const words = [first]
  let i = first.end
  for (;;) {
    while (space(line[i])) i++
    if (i >= line.length) return words
    const word = wordAt(line, i, rules)
    words.push(word)
    i = word.end
  }
}

/**
 * The end of the JSON object or array that begins at `i`, just after its closing bracket, or -1
 * where it does not close on the line. Inside a JSON string a backslash takes the next character
 * with it and only a quote ends it, as JSON says; outside strings brackets are counted. Whether
 * what is between is JSON is left to `JSON.parse`.
 */
export function jsonEnd(line: string, i: number): number {
  let depth = 0
  let inString = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

const parsed = (text: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return null
  }
}
/** Whether a word may be JSON a shell spoilt: it begins as a JSON object or array does, and is not JSON as it is. */
const spoilt = (word: string) => /^[[{]/.test(word) && parsed(word) === null

/**
 * The two ways PowerShell builds a program's command line from an argument without writing its
 * quotes so that the program keeps them: in quotes of its own where the argument has a space
 * that its count of double quotes puts outside them, and as it is otherwise. Windows PowerShell
 * 5.1 counts every double quote; PowerShell 7 in its older way (before 7.3, or where it is asked
 * for) does not count one just after a backslash.
 */
const COUNTINGS = ['every', 'unescaped'] as const
function rendered(arg: string, counting: (typeof COUNTINGS)[number]): string {
  let quotes = 0
  let afterBackslash = false
  let spaced = arg === ''
  for (const c of arg) {
    if (c === '"' && !(counting === 'unescaped' && afterBackslash)) quotes++
    else if (/\s/.test(c) && quotes % 2 === 0) spaced = true
    afterBackslash = c === '\\'
  }
  return spaced ? `"${arg}"` : arg
}
/** Whether a stretch of the line could be what PowerShell built for one argument, in either way: the argument as it is, or in the quotes PowerShell puts round it. */
const oneArgument = (stretch: string) =>
  COUNTINGS.some(
    (counting) =>
      rendered(stretch, counting) === stretch ||
      (stretch.length >= 2 && stretch.startsWith('"') && stretch.endsWith('"') && rendered(stretch.slice(1, -1), counting) === stretch),
  )

/**
 * Where a command takes JSON, by the place of the word among those the program was given: the
 * patch of `it patch <id> <json>`, the answer of `it tour answer <id> <json>`, the value of
 * `--state`, and the value of `it set <id> <key> <value>` where `it set` would refuse it as given
 * (a value that begins and ends as JSON does and has lost its quotes). Each only where nothing
 * the command reads as a word of its own comes after it, so that the JSON is the whole of what
 * the command takes there. Anywhere else, a word that looks like JSON may be a key, a file's
 * name or text, which cmd reads with its quotes as quoting, and nothing is taken there.
 */
export function jsonPlaces(given: readonly string[]): Map<number, number> {
  const places = new Map<number, number>()
  // The words as `main` reads them: the first is the command, and the rest as `parse` reads them,
  // where only a word that begins with two dashes is an option, `--name=value` is one word, and
  // an option `parse` does not know, or one left without its value, stops the command anyway
  const command = given[0]
  const words: number[] = []
  let state: number | undefined
  for (let k = 1; k < given.length; k++) {
    const word = given[k]!
    if (word === '--') {
      for (let rest = k + 1; rest < given.length; rest++) words.push(rest)
      break
    }
    if (!word.startsWith('--') || word.length === 2) {
      words.push(k)
      continue
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word.slice(2) : word.slice(2, eq)
    if (!BOOLEAN.has(name) && !VALUED.has(name)) return new Map()
    if (eq !== -1 || BOOLEAN.has(name)) {
      // `--state=…` is a --state as well, and the last one is the one read: none before it is a place
      if (name === 'state') state = undefined
      continue
    }
    const value = given[k + 1]
    if (value === undefined || (value.startsWith('--') && value.length > 2)) return new Map()
    // The value of --state is JSON, and is the whole of it; the value of any other option is not
    if (name === 'state') state = k + 1
    k++
  }
  // Only the last --state, which is the one `parse` keeps: a value given before it is never read, so that taking it would change nothing that fails into what runs
  if (state !== undefined) places.set(state, state)
  const second = words[0] === undefined ? undefined : given[words[0]]
  const last = words[words.length - 1]!
  // The place where the JSON begins: after the id, after `answer` and the action's id, or after the id and the key
  const json = command === 'patch' ? words[1] : command === 'tour' && second === 'answer' ? words[2] : command === 'set' ? words[2] : undefined
  if (json === undefined) return places
  if (
    command === 'set' &&
    !quotesTakenOut(
      words
        .slice(2)
        .map((k) => given[k])
        .join(' '),
    )
  )
    return places
  places.set(json, last)
  return places
}

/**
 * Whether the words a JSON value stands in for may be taken into it. Where PowerShell put the
 * value in quotes of its own, because it has a space outside its strings, the runtime's reading
 * of the line splits it inside its strings instead, so that a string with a space and then a dash
 * in it (`"Plan - draft"`, `"a -1"`, `"run with --verbose"`) hands the program a word that begins
 * with a dash. Such a word is taken into the value where the command, given the words as they
 * came, would have read it as no option of its own: a word with one dash, which every command
 * reads as a plain word, or a word with two that names no option, which every command refuses.
 * A word that names an option It knows, and `--` itself, which ends a command's options, are
 * never taken, so that nothing the command would have read as one of its own ever is. Where
 * PowerShell put no quotes round the value, no word that begins with a dash is taken.
 */
function takeable(words: readonly string[], wrapped: boolean): boolean {
  return words.every((w) => {
    if (!w.startsWith('-')) return true
    if (!wrapped || w === '--') return false
    return !w.startsWith('--') || !optionNamed(w)
  })
}
/** Whether a word that begins with two dashes names an option It knows, as `parse` reads it. */
const optionNamed = (word: string) => {
  const eq = word.indexOf('=')
  const name = eq === -1 ? word.slice(2) : word.slice(2, eq)
  return BOOLEAN.has(name) || VALUED.has(name)
}

/**
 * The words as the command would read them if each JSON value that PowerShell put in quotes of
 * its own were one word, where the runtime split it at a word that begins with two dashes and
 * names no option (`takeable`). `parse` refuses such a word, and `jsonPlaces` finds no place
 * where any word is refused, so the places are found among these words instead: each such value
 * is the words it stands in for joined by a space, as `it set` joins the words of its value. Only
 * a value that already stands as one argument on the line, as PowerShell builds one, is joined;
 * whether it is taken is decided after, as for every other value. Each word here keeps the index
 * of the first word it stands for, and a joined one the index of its last as well.
 */
function joinedAtUnknownSwitches(line: string, after: readonly Word[]): { words: string[]; first: number[]; last: Map<number, number> } {
  const words: string[] = []
  const first: number[] = []
  const last = new Map<number, number>()
  for (let k = 0; k < after.length; k++) {
    const word = after[k]!
    const from = word.start + 1
    const end = line[word.start] === '"' && spoilt(word.value) && (line[from] === '{' || line[from] === '[') ? jsonEnd(line, from) : -1
    let to = k
    if (end !== -1 && line[end] === '"' && (end + 1 >= line.length || space(line[end + 1]))) {
      while (to + 1 < after.length && after[to + 1]!.start < end + 1) to++
      const inside = after.slice(k + 1, to + 1).map((w) => w.value)
      const joins = after[to]!.end === end + 1 && inside.some((w) => w.startsWith('--') && w !== '--' && !optionNamed(w)) && takeable(inside, true)
      if (!joins) to = k
    }
    if (to > k) last.set(words.length, to)
    words.push(
      after
        .slice(k, to + 1)
        .map((w) => w.value)
        .join(' '),
    )
    first.push(k)
    k = to
  }
  return { words, first, last }
}

/**
 * The words after the program's name (and the script's, under Node) with each JSON value the
 * shell spoilt taken whole from the command line, or null where nothing is taken: the line
 * cannot be split back into exactly `given` by either rules, or no word is both spoilt and
 * whole on the line. `given` is what the program was given after its own name (and the
 * script's), in order.
 *
 * A value is taken only where the line can be read in no other way than as that one JSON
 * argument, spoilt by PowerShell. It begins where a word begins (or just inside the quotes
 * PowerShell put round it) and ends where that word ends (or at those quotes); the stretch of the
 * line it takes is exactly what PowerShell builds for it as one argument, in quotes only where
 * PowerShell would have put them; no longer stretch, running on over the words after it, could
 * be one argument PowerShell built, so that nothing written inside one argument is taken for a
 * switch or another word; no word it stands in for is one the command would read as its own
 * (`takeable`); it is at a
 * place where the command takes JSON (`jsonPlaces`), and runs over every word the command would
 * read after it there; and it parses. Where spoilt JSON that the runtime split into several words
 * is not taken, nothing on the line is, since the command would read those words as its own.
 *
 * Two lines are the same on the line as the one-argument line they are taken for, and so are
 * taken as it: two arguments that together make one JSON value with a space inside a string
 * (`'{"x":"a' 'b"}'`), and JSON with a space in it written inside double quotes of its own
 * (`'"{ "x":1}"'`). Either would otherwise be refused as not JSON, and what is taken is the JSON
 * as it was typed. An array whose strings Windows PowerShell 5.1 turned into numbers (`'["1"]'`
 * arrives as `[1]`) is JSON as it arrives, and is left as it is, since cmd hands on `["1"]`
 * typed bare as that very `[1]`.
 */
export function wholeJson(line: string, given: readonly string[]): string[] | null {
  if (!given.some(spoilt)) return null
  for (const rules of ['crt', 'shell32'] as const) {
    const words = commandLineWords(line, rules)
    const lead = words.length - given.length
    if (lead < 1 || words.slice(lead).some((w, k) => w.value !== given[k])) continue
    const after = words.slice(lead)
    // The places where a command takes JSON, found with each value PowerShell quoted read as one word where a switch It does not know split it
    const joined = joinedAtUnknownSwitches(line, after)
    const places = new Map<number, number>()
    for (const [at, reach] of jsonPlaces(joined.words)) places.set(joined.first[at]!, joined.last.get(reach) ?? joined.first[reach]!)
    // Read again from the first word after the program's own, taking each spoilt JSON value whole
    const out: string[] = []
    let taken = false
    let k = 0
    while (k < after.length) {
      const word = after[k]!
      const at = word.start
      const wrapped = line[at] === '"'
      const from = at + (wrapped ? 1 : 0)
      const reach = places.get(k)
      const candidate = spoilt(word.value) && (line[from] === '{' || line[from] === '[')
      const end = candidate ? jsonEnd(line, from) : -1
      const stop = end === -1 ? -1 : end + (wrapped ? 1 : 0)
      // The words the value would stand in for: from this one to the last that begins inside it
      let last = k
      while (stop !== -1 && last + 1 < after.length && after[last + 1]!.start < stop) last++
      const json = end === -1 ? '' : line.slice(from, end)
      // Whether the value closes on the line where a word ends, as JSON spoilt on the way does
      const closes = end !== -1 && (!wrapped || line[end] === '"') && (stop >= line.length || space(line[stop])) && after[last]!.end === stop
      const fits =
        closes &&
        COUNTINGS.some((counting) => rendered(json, counting) === line.slice(at, stop)) &&
        takeable(
          after.slice(k + 1, last + 1).map((w) => w.value),
          wrapped,
        ) &&
        reach !== undefined &&
        last >= reach &&
        after.slice(last + 1).every((w) => !oneArgument(line.slice(at, w.end)))
      if (fits && parsed(json)) {
        out.push(json)
        taken = true
        k = last + 1
        continue
      }
      // Spoilt JSON that the runtime split into several words and that is not taken leaves those
      // words to the command, which may read one as an option of its own beside JSON taken
      // elsewhere: `--open` out of a first --state of `{"a": "x --open"}`, which a second --state
      // overrides. Nothing is taken then, so that what runs is never other than what was written
      if (closes && last > k) return null
      out.push(word.value)
      k++
    }
    return taken ? out : null
  }
  return null
}

/**
 * This program's own command line as Windows keeps it, or null where it cannot be had. The
 * standalone program asks Windows for it directly; under Node, or where that fails, Windows's
 * own record of the process is asked through PowerShell, which takes a moment and is done only
 * where a JSON argument came spoilt.
 */
export async function ownCommandLine(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if ('Bun' in globalThis) {
    try {
      const ffi = await import('bun:ffi')
      const kernel32 = ffi.dlopen('kernel32.dll', {
        GetCommandLineW: { args: [], returns: ffi.FFIType.ptr },
        lstrlenW: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
      })
      try {
        const at = kernel32.symbols.GetCommandLineW()
        if (at) {
          const length = kernel32.symbols.lstrlenW(at)
          return Buffer.from(ffi.toArrayBuffer(at, 0, length * 2)).toString('utf16le')
        }
      } finally {
        kernel32.close()
      }
    } catch {
      // Asked of Windows's record below
    }
  }
  // By its whole path, so that no program of that name in the folder It was started in is run in its place
  const asked = runSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CommandLine`,
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  )
  const line = asked.status === 0 ? asked.stdout.replace(/\r?\n$/, '') : ''
  return line || null
}

/** The words a command is run with on Windows: as given, or with each JSON value the shell spoilt taken whole from the command line (see above). */
export async function recoveredArgs(given: string[]): Promise<string[]> {
  if (process.platform !== 'win32' || !given.some(spoilt)) return given
  const line = await ownCommandLine()
  return (line && wholeJson(line, given)) || given
}
