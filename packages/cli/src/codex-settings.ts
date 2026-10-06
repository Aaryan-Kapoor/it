/**
 * What Codex's settings say of the network it gives the commands its agent runs, and what a
 * person is told to change where they give none. `it` reaches It over the machine's own
 * network, and Codex as it comes gives its agent's commands no network at all.
 *
 * Codex has two ways of saying it, and they do not mix as one would guess. The newer is a named
 * permissions profile, chosen with `default_permissions`. The older is `sandbox_mode` with the
 * table `[sandbox_workspace_write]`. The moment a file holds anything of the older way and no
 * `default_permissions`, Codex reads all of it the older way, and a folder that is not a git
 * repository is then read-only: the two lines `[sandbox_workspace_write]` and
 * `network_access = true`, added to settings that had neither, give a git folder the network
 * and take from a plain folder the writing it had. A profile that is chosen wins over
 * everything of the older way. A file that defines a profile and chooses none, or has the
 * choosing line below a table, is one Codex will not start with, and so is a table that is in
 * it twice: what a person is told to add is said with that in mind. All of this is as Codex
 * 0.160 was seen to behave in its own window.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The profile a person is told to add. Codex shows the name in its own status line. */
export const CODEX_PROFILE = 'workspace-network'

/** Codex's settings file as text, null when there is none, false when it could not be read. */
export function codexConfig(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string | null | false {
  try {
    return readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}

/** What a person is to change in Codex's settings file so that `it` is let out. */
export interface CodexAdvice {
  /** A line that has to be the file's very first, above every table */
  first?: string
  /** A line of the person's own that is to be changed, and what to */
  change?: { from: string; to: string }
  /** A setting to put under a table that is already in the file */
  under?: { table: string; line: string }
  /** Lines to add at the end of the file */
  end?: string[]
}
/**
 * Whether Codex lets `it` out, as far as its settings say. Where it does not, what to change;
 * with nothing to change where the person has chosen that Codex only reads, which is theirs.
 */
export type CodexNetwork = { lets: true } | { lets: false; advice?: CodexAdvice }

const bare = (s: string) => s.replace(/^["']|["']$/g, '')
/** Every setting of the file by its full dotted name, with its value as written. Tables that repeat (`[[…]]`) are left out. */
function settings(config: string): Map<string, string> {
  const all = new Map<string, string>()
  const name = (s: string) =>
    s
      .split('.')
      .map((part) => bare(part.trim()))
      .join('.')
  let table: string | null = ''
  for (const raw of config.split('\n')) {
    const line = raw.replace(/^\s*#.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('[[')) {
      table = null
      continue
    }
    const header = /^\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line)
    if (header) {
      table = name(header[1]!)
      // A table with nothing under it is in the file all the same
      if (!all.has(table)) all.set(table, '{}')
      continue
    }
    if (table === null) continue
    const kv = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_:-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_:-]+))*)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const key = `${table ? `${table}.` : ''}${name(kv[1]!)}`
    // A value is a word, a number or a quoted string here, and what follows it on the line is a remark
    const value = /^("[^"]*"|'[^']*'|\{.*\}|\[.*\]|[^\s#]+)/.exec(kv[2]!.trim())?.[1] ?? kv[2]!.trim()
    // A table written on one line holds settings of its own
    if (value.startsWith('{')) {
      for (const inner of value.slice(1, -1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^,}\s]+)/g)) all.set(`${key}.${inner[1]}`, inner[2]!)
      all.set(key, '{}')
      continue
    }
    all.set(key, value)
  }
  return all
}

/**
 * Whether Codex, as its settings stand, gives the commands its agent runs the network that
 * `it` needs, and what to change where it does not. Undefined where the settings are arranged
 * in a way this does not follow, or could not be read, which is not guessed at. Someone who
 * runs Codex with full access by a switch on its command line, or who chose otherwise inside a
 * conversation, is not seen here either, so what is said of this is said as advice.
 */
export function codexNetwork(config: string | null | false = codexConfig()): CodexNetwork | undefined {
  if (config === false) return undefined
  const all = settings(config ?? '')
  const has = (prefix: string) => [...all.keys()].some((k) => k === prefix || k.startsWith(`${prefix}.`))
  const word = (key: string) => (all.has(key) ? bare(all.get(key)!) : undefined)
  const profile = [`[permissions.${CODEX_PROFILE}]`, 'extends = ":workspace"', '', `[permissions.${CODEX_PROFILE}.network]`, 'enabled = true']
  const chosen = word('default_permissions')
  const mode = word('sandbox_mode')

  // A way of choosing settings that Codex no longer reads, and says so itself
  if (all.has('profile')) return undefined
  // The newer way: a profile is chosen, and it wins over everything of the older way
  if (chosen !== undefined) {
    if (chosen === ':danger-full-access') return { lets: true }
    // Read-only by the person's own choice
    if (chosen === ':read-only') return { lets: false }
    const line = `default_permissions = ${all.get('default_permissions')}`
    if (chosen.startsWith(':')) {
      if (chosen !== ':workspace') return undefined
      return {
        lets: false,
        advice: { change: { from: line, to: `default_permissions = "${CODEX_PROFILE}"` }, ...(has(`permissions.${CODEX_PROFILE}`) ? {} : { end: profile }) },
      }
    }
    // A profile of the person's own, which may build on another of theirs
    const seen = new Set<string>()
    for (let at = chosen; ; ) {
      if (at === ':danger-full-access') return { lets: true }
      if (at.startsWith(':')) break
      // A profile that is not in the file, or that builds on itself: Codex's to say
      if (seen.has(at) || !has(`permissions.${at}`)) return undefined
      seen.add(at)
      const enabled = word(`permissions.${at}.network.enabled`)
      if (enabled === 'true') return { lets: true }
      if (enabled !== undefined) break
      const on = word(`permissions.${at}.extends`)
      if (on === undefined) break
      at = on
    }
    const table = `permissions.${chosen}.network`
    // Its table for the network is there already: a second one of that name and Codex will not start
    if (has(table)) return { lets: false, advice: { under: { table: `[${table}]`, line: 'enabled = true' } } }
    return { lets: false, advice: { end: [`[${table}]`, 'enabled = true'] } }
  }
  // A profile that is defined and not chosen: Codex does not start with that, and says so itself
  if (has('permissions')) return undefined

  // The older way
  if (mode === 'danger-full-access') return { lets: true }
  if (mode === 'read-only') return { lets: false }
  if (mode === 'workspace-write') {
    if (word('sandbox_workspace_write.network_access') === 'true') return { lets: true }
    if (has('sandbox_workspace_write')) return { lets: false, advice: { under: { table: '[sandbox_workspace_write]', line: 'network_access = true' } } }
    return { lets: false, advice: { end: ['[sandbox_workspace_write]', 'network_access = true'] } }
  }
  if (mode !== undefined) return undefined
  // Codex as it comes, or with something of the older way and no mode said, which leaves a
  // plain folder read-only: the profile, which wins over what is there
  return { lets: false, advice: { first: `default_permissions = "${CODEX_PROFILE}"`, end: profile } }
}

/** Whether Codex lets `it` out, where its settings say so plainly. */
export const codexLetsItOut = (config: string | null | false = codexConfig()): boolean | undefined => codexNetwork(config)?.lets

const WHY = 'Codex gives the commands its agent runs no network, and `it` needs it to reach It on this machine'
const FILE = '`~/.codex/config.toml`'
const UNLESS = 'You need not if you run Codex with full access, or would sooner approve `it` each time Codex asks.'
const indented = (lines: string[]) => lines.map((l) => (l ? `    ${l}` : '')).join('\n')

/**
 * What a person is told where Codex, as it is set, would keep `it` from reaching It: in lines,
 * with what to add set out as it is to be typed. Null where Codex lets `it` out, or where its
 * settings are not followed.
 */
export function codexNoNetwork(net: CodexNetwork | undefined): string | null {
  if (!net || net.lets) return null
  const a = net.advice
  if (!a)
    return `Codex is set to only read, which ${WHY.replace(/^Codex gives/, 'gives')}. Approve \`it\` each time Codex asks, or choose another setting in ${FILE}.`
  const steps: string[] = []
  if (a.first)
    steps.push(`Put this as its very first line, above every line in square brackets (lower than that, and Codex will not start):\n${indented([a.first])}`)
  if (a.change) steps.push(`Change its line \`${a.change.from}\` to:\n${indented([a.change.to])}`)
  if (a.under) steps.push(`Under the \`${a.under.table}\` that is in it, add:\n${indented([a.under.line])}`)
  if (a.end) steps.push(`Add ${a.first || a.change ? 'these' : 'this'} at its end:\n${indented(a.end)}`)
  return `As it is set, ${WHY}: each \`it\` command would fail, or stop to ask you.\nTo let it, open ${FILE}.\n${steps.join('\n')}\nThen start Codex again. ${UNLESS}`
}

/** The same in one sentence or two, for an agent to pass on to the person in its own reply. */
export function codexNoNetworkSaid(net: CodexNetwork | undefined): string {
  const a = net && !net.lets ? net.advice : undefined
  const ticks = (lines: string[]) =>
    lines
      .filter(Boolean)
      .map((l) => `\`${l}\``)
      .join(', ')
  if (!net || net.lets) return `${WHY}. Letting the commands Codex runs use the network, in Codex's settings, lets it.`
  if (!a)
    return `Codex is set to only read, which ${WHY.replace(/^Codex gives/, 'gives')}. Approving \`it\` each time Codex asks, or choosing another setting in ${FILE}, lets it.`
  const steps: string[] = []
  if (a.first) steps.push(`put the line \`${a.first}\` at the very top, above every line in square brackets (Codex will not start if it is lower)`)
  if (a.change) steps.push(`change the line \`${a.change.from}\` to \`${a.change.to}\``)
  if (a.under) steps.push(`add the line \`${a.under.line}\` under the \`${a.under.table}\` that is there`)
  if (a.end) steps.push(`add at its end, each on a line of its own, ${ticks(a.end)}`)
  return `${WHY}. To let it, in ${FILE}: ${steps.join('; and ')}. Then start Codex again.`
}
