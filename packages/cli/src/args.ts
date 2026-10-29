// Reading a command line, kept apart from the commands so it can be tested by itself.
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
  'media',
])
export interface Args {
  _: string[]
  flags: Record<string, string | boolean>
  many: Record<string, string[]>
}
/** The options each command can honour. JSON and help apply to every public command. */
export const OPTIONS: Record<string, readonly string[]> = {
  create: ['id', 'file', 'dir', 'html', 'state', 'agent', 'open', 'on', 'take', 'media'],
  update: ['id', 'file', 'dir', 'html', 'title', 'agent', 'open', 'on', 'take', 'media'],
  list: [],
  read: [],
  delete: ['status'],
  rollback: [],
  set: ['if-revision'],
  patch: ['replace', 'if-revision'],
  state: [],
  say: [],
  open: ['on'],
  notify: ['id', 'on', 'sticky', 'button'],
  displays: [],
  wait: ['id', 'follow', 'timeout'],
  actions: ['id', 'all'],
  action: ['save', 'number'],
  ack: ['failed'],
  setup: ['all', 'only', 'none', 'name', 'no-service', 'yes'],
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
  'tour show': ['agent', 'param', 'on'],
  'tour clear': [],
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
export function json(value: string, what: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Problem(`${what} is not valid JSON.`, 'invalid')
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
