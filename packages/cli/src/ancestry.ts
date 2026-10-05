// Which agent apps this program was started from. A command an agent runs is started by the
// app's own process, usually through a shell. So when one app has been started from inside
// another, the processes above the command say which of the two is the inner one, which the
// environment cannot: it holds the marks of both, the same whichever way round they are.
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import type { Harness } from '@it/protocol'

/** A process, as far as this needs to know it: what started it, and the first words of its command line, of which the first is the program itself. */
export interface Proc {
  parent: number
  argv: string[]
}

// How each app shows among the processes of a machine. Some are programs of their own, named
// after the app. Others are scripts that Node, Bun or Python runs: then the program is the
// runtime, and the app is known by the script it was given, which is either a file inside the
// app's own package or the launcher an install leaves in a `bin` folder under the app's name.
const PROGRAM = new Map<string, Harness>([
  ['claude', 'claude-code'],
  ['codex', 'codex'],
  ['pi', 'pi'],
  ['hermes', 'hermes'],
  ['opencode', 'opencode'],
  ['openclaw', 'openclaw'],
])
const PACKAGE: [string, Harness][] = [
  ['@anthropic-ai/claude-code', 'claude-code'],
  ['@openai/codex', 'codex'],
  ['@mariozechner/pi-coding-agent', 'pi'],
  ['opencode-ai', 'opencode'],
  ['openclaw', 'openclaw'],
]
const RUNTIME = /^(node|nodejs|bun|deno|python[0-9.]*)$/
// A runtime's switches that are followed by a word of their own, which is then not the script
const TAKES_A_WORD = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--title',
  '--preload',
  '--cwd',
  '-W',
  '-X',
])
// And those after which nothing is run from a file of its own: code written on the command line, or a module known by name
const RUNS_NO_FILE = new Set(['-e', '--eval', '-p', '--print', '-c', '-m', '-'])
const named = (word: string) =>
  word
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')

/** The script a runtime was given to run: its first word that is neither a switch nor what a switch is followed by. */
function scriptOf(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (RUNS_NO_FILE.has(word)) return undefined
    if (word === '--') return argv[i + 1]
    if (TAKES_A_WORD.has(word)) i++
    // `bun run` and `deno run` name the script after that word
    else if (!word.startsWith('-') && !(i === 1 && word === 'run')) return word
  }
  return undefined
}

/**
 * Which agent app a process is, if it is one. Only the program says so: its own name, or for a
 * runtime the script it runs. A word further along the command line never does, so a shell
 * whose command mentions an app is not that app, and neither is a script of someone's own that
 * happens to be called after one.
 */
export function agentApp(p: Pick<Proc, 'argv'>): Harness | undefined {
  if (p.argv[0] === undefined) return undefined
  const program = named(p.argv[0])
  const own = PROGRAM.get(program)
  if (own) return own
  if (!RUNTIME.test(program)) return undefined
  const script = scriptOf(p.argv)?.replace(/\\/g, '/')
  if (!script) return undefined
  const packaged = PACKAGE.find(([folder]) => script.includes(`/node_modules/${folder}/`))?.[1]
  if (packaged) return packaged
  const launcher = /(?:^|\/)\.?bin\/([^/]+)$/.exec(script)
  return launcher ? PROGRAM.get(launcher[1]!.toLowerCase()) : undefined
}

/**
 * The agent apps among a process and those above it, the nearest first. `look` says what a
 * process is. The walk ends at the top, at a process that cannot be looked at, at one already
 * seen, or after `most` steps, whichever comes first.
 */
export function appsFrom(pid: number, look: (pid: number) => Proc | undefined, most = 40): Harness[] {
  const found: Harness[] = []
  const seen = new Set<number>()
  for (let steps = 0; pid > 1 && !seen.has(pid) && steps < most; steps++) {
    seen.add(pid)
    const proc = look(pid)
    if (!proc) break
    const app = agentApp(proc)
    if (app && !found.includes(app)) found.push(app)
    pid = proc.parent
  }
  return found
}

/** A process on Linux, as the system describes it in /proc. Undefined when it cannot be read. */
export function linuxProc(pid: number): Proc | undefined {
  try {
    // "pid (name) state parent ...". The name can itself hold spaces and brackets, so it ends at the last bracket.
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1')
    const close = stat.lastIndexOf(')')
    const parent = Number(stat.slice(close + 2).split(' ')[1])
    if (close < 0 || !Number.isInteger(parent)) return undefined
    return { parent, argv: firstWords(`/proc/${pid}/cmdline`) }
  } catch {
    return undefined
  }
}
/** The first words of a command line. Only its start is read: the rest can be very long, and is what the program was told, which is not needed here. */
function firstWords(file: string): string[] {
  try {
    const fd = openSync(file, 'r')
    try {
      const start = Buffer.alloc(4096)
      const read = readSync(fd, start, 0, start.length, 0)
      const words = start.subarray(0, read).toString('utf8').split('\0')
      // A full buffer may have cut the last word short
      if (read === start.length) words.pop()
      return words.filter(Boolean).slice(0, 16)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

/**
 * The processes of a machine, from what `ps -o pid= -o ppid= -o comm=` printed. The last column
 * is the program alone and runs to the end of the line, so a program in a folder with a space
 * in its name is read whole.
 */
export function psTable(text: string): Map<number, Proc> {
  const table = new Map<number, Proc>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (m) table.set(Number(m[1]), { parent: Number(m[2]), argv: [m[3]!] })
  }
  return table
}
/**
 * Adds, to processes read by `psTable`, the words after the program, from what
 * `ps -o pid= -o args=` printed. There the words of a command line come run together, so the
 * program is taken off the front as it is already known, and only the rest is split. A script
 * in a folder with a space in its name is then read as two words, and its runtime goes
 * unrecognised. It is taken for an app only where the words before the space are themselves an
 * app's launcher, as in a folder called `bin/pi tools`.
 */
export function psWords(table: Map<number, Proc>, text: string): void {
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    const proc = m ? table.get(Number(m[1])) : undefined
    const program = proc?.argv[0]
    if (!m || !proc || !program || !m[2]!.startsWith(program)) continue
    proc.argv = [program, ...m[2]!.slice(program.length).split(/\s+/).filter(Boolean).slice(0, 15)]
  }
}

const ps = (...args: string[]) =>
  execFileSync('/bin/ps', ['-ww', ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
/**
 * The processes above one, as `ps` tells them. Each column is asked for by an option of its
 * own: given as one list, the `ps` of macOS takes everything after the first `=` for a heading.
 * The words after the program are asked for only where the program is a runtime, which is where
 * they say what is being run.
 */
export function psAbove(pid: number): Map<number, Proc> {
  const table = psTable(ps('-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='))
  const runtimes: number[] = []
  appsFrom(pid, (at) => {
    const proc = table.get(at)
    if (proc && RUNTIME.test(named(proc.argv[0]!))) runtimes.push(at)
    return proc
  })
  try {
    if (runtimes.length) psWords(table, ps('-o', 'pid=', '-o', 'args=', '-p', runtimes.join(',')))
  } catch {}
  return table
}

let above: Harness[] | undefined
/**
 * The agent apps this very program was started from, the nearest first. Looked up once and
 * kept: what started a running program does not change. On Linux each process above is read
 * from /proc; on macOS `ps` lists them; on Windows it is not attempted. Wherever it cannot be
 * found out (a sandbox that hides the processes above, say) the answer is none, and never an
 * error.
 */
export function agentAppsAbove(): readonly Harness[] {
  if (above) return above
  try {
    if (process.platform === 'linux') above = appsFrom(process.ppid, linuxProc)
    else if (process.platform === 'darwin') {
      const table = psAbove(process.ppid)
      above = appsFrom(process.ppid, (pid) => table.get(pid))
    }
  } catch {}
  above ??= []
  return above
}
