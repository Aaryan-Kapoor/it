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
 * program was given it (or is an array, which can lose its quotes and still be JSON), and before
 * any command has started, so that it decides what the command
 * is given and nothing else. The line is split again by the same rules the runtime split it by,
 * and only where those rules give back exactly the words the program was given is anything taken
 * from it. Then each word that begins with `{` or `[` and is not JSON as it was given (or is an
 * array, which a shell can spoil into other JSON) is replaced by the whole JSON value that begins
 * there on the line, scanned with what JSON says of its strings, where that value can only be
 * the one argument the shell spoilt (see `wholeJson`). Everything else on the line is read as before. Where nothing can be
 * taken back, the words are left as they were given, and the command says what it says today.
 */
import path from 'node:path'
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
/**
 * Whether a word may be JSON a shell spoilt: it begins as a JSON object or array does, and is not
 * JSON as it is, or is an array, which can still be JSON once its quotes are gone (`["1","2"]`
 * arrives as `[1,2]`). An object that is JSON as it is kept its quotes, since its keys need them.
 */
const spoilt = (word: string) => /^[[{]/.test(word) && (word.startsWith('[') || parsed(word) === null)

/** Whether a JSON value on the line has a space or tab outside its strings. */
function spacedOutsideStrings(json: string): boolean {
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (space(c)) return true
  }
  return false
}

/**
 * The words after the program's name (and the script's, under Node) with each JSON value the
 * shell spoilt taken whole from the command line, or null where nothing is taken: the line
 * cannot be split back into exactly `given` by either rules, or no word is both spoilt and
 * whole on the line. `given` is what the program was given after its own name (and the
 * script's), in order.
 *
 * A value is taken only where it can be nothing but one argument that a shell spoilt. It begins
 * at the start of a word, or just inside the quotes Windows PowerShell put round the word, and
 * ends where that word ends, or at the closing one of those quotes. Where there are no such
 * quotes, it has no space outside its strings, since Windows PowerShell puts quotes round any
 * argument that has one, and where it has a backslash just before a quote, it is the last thing
 * on the line, since there PowerShell 7's older way of counting quotes can leave a space that was
 * inside the argument outside its quotes. And it parses, as something other than what the word
 * was as given.
 */
export function wholeJson(line: string, given: readonly string[]): string[] | null {
  if (!given.some(spoilt)) return null
  for (const rules of ['crt', 'shell32'] as const) {
    const words = commandLineWords(line, rules)
    const lead = words.length - given.length
    if (lead < 1 || words.slice(lead).some((w, k) => w.value !== given[k])) continue
    // Read again from the first word after the program's own, taking each spoilt JSON value whole
    const out: string[] = []
    let taken = false
    let i = words[lead]!.start
    for (;;) {
      while (space(line[i])) i++
      if (i >= line.length) break
      const word = wordAt(line, i, rules)
      const wrapped = line[i] === '"'
      const from = i + (wrapped ? 1 : 0)
      if (spoilt(word.value) && (line[from] === '{' || line[from] === '[')) {
        const end = jsonEnd(line, from)
        const after = end === -1 ? -1 : end + (wrapped ? 1 : 0)
        const json = end === -1 ? '' : line.slice(from, end)
        const ends = after >= line.length || line.slice(after).trim() === ''
        const whole =
          end !== -1 &&
          (!wrapped || line[end] === '"') &&
          (after >= line.length || space(line[after])) &&
          (wrapped || (!spacedOutsideStrings(json) && (!/\\"/.test(json) || ends)))
        const value = whole ? parsed(json) : null
        const was = parsed(word.value)
        if (value && (was === null || JSON.stringify(was.value) !== JSON.stringify(value.value))) {
          out.push(json)
          taken = true
          i = after
          continue
        }
      }
      out.push(word.value)
      i = word.end
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
