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
 * it twice. All of this is as Codex 0.160 was seen to behave in its own window.
 *
 * There is a third way, which leaves the sandbox alone: a rule in Codex's `rules` folder that
 * lets one command run outside it. Seen with Codex as it comes, in a plain folder and in a git
 * one: with the one rule for `it`, every `it` command runs unasked, and any other command is
 * still kept from the network and from writing outside its folder. Without it, a git folder
 * asks for approval of each `it` command, and a plain folder refuses the asking itself
 * ("sandbox_approval: false") until the person chooses "Ask for approval" under /permissions.
 * And nothing gets out of the sandbox as it comes: a port of this machine is refused, and so
 * is a socket in a folder. So the rule is what a person is told of, and the network is only
 * looked for, as something that also lets `it` through.
 */
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The rule that lets `it`, and nothing else, run outside Codex's sandbox: one line of a file in Codex's `rules` folder. */
export const CODEX_RULE = 'prefix_rule(pattern=["it"], decision="allow")'
/** The file a person is told to keep it in: one of their own making, beside the one Codex keeps its own rules in. */
export const CODEX_RULE_FILE = '~/.codex/rules/it.rules'

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

/** Codex's settings file as text, null when there is none, false when it could not be read. */
export function codexConfig(home = codexHome()): string | null | false {
  try {
    return readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}

/**
 * Whether a rule of the person's lets every `it` command out of Codex's sandbox. Codex reads
 * every file ending in `.rules` in its `rules` folder, and writes such rules itself when a
 * person answers "don't ask again": those name a command and its first words, as in
 * `["it", "status"]`, and only one that names `it` alone covers every `it` command.
 */
export function codexRuleLetsItOut(home = codexHome()): boolean {
  try {
    const dir = path.join(home, 'rules')
    return readdirSync(dir)
      .filter((name) => name.endsWith('.rules'))
      .some((name) =>
        readFileSync(path.join(dir, name), 'utf8')
          .split('\n')
          .some((line) => /^\s*prefix_rule\(\s*pattern\s*=\s*\[\s*["']it["']\s*\]\s*,\s*decision\s*=\s*["']allow["']/.test(line)),
      )
  } catch {
    return false
  }
}

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
 * Whether Codex's own settings give the commands its agent runs the network, with which `it`
 * reaches It from inside the sandbox. Undefined where the settings are arranged in a way this
 * does not follow, or could not be read, which is not guessed at. Someone who runs Codex with
 * full access by a switch on its command line, or who chose otherwise inside a conversation, or
 * whose Codex is run by another app with settings of that app's own, is not seen here.
 */
export function codexGivesNetwork(config: string | null | false = codexConfig()): boolean | undefined {
  if (config === false) return undefined
  const all = settings(config ?? '')
  const has = (prefix: string) => [...all.keys()].some((k) => k === prefix || k.startsWith(`${prefix}.`))
  const word = (key: string) => (all.has(key) ? bare(all.get(key)!) : undefined)
  // A way of choosing settings that Codex no longer reads, and says so itself
  if (all.has('profile')) return undefined
  const chosen = word('default_permissions')
  // The newer way: a profile is chosen, and it wins over everything of the older way
  if (chosen !== undefined) {
    const seen = new Set<string>()
    for (let at = chosen; ; ) {
      if (at === ':danger-full-access') return true
      if (at === ':workspace' || at === ':read-only') return false
      // Another of Codex's own, a profile that is not in the file, or one that builds on itself: Codex's to say
      if (at.startsWith(':') || seen.has(at) || !has(`permissions.${at}`)) return undefined
      seen.add(at)
      const enabled = word(`permissions.${at}.network.enabled`)
      if (enabled !== undefined) return enabled === 'true'
      const on = word(`permissions.${at}.extends`)
      if (on === undefined) return false
      at = on
    }
  }
  // A profile that is defined and not chosen: Codex does not start with that, and says so itself
  if (has('permissions')) return undefined
  // The older way. With no mode said, a folder that is not a git repository is read-only, whatever the table says
  const mode = word('sandbox_mode')
  if (mode === 'danger-full-access') return true
  if (mode === 'workspace-write') return word('sandbox_workspace_write.network_access') === 'true'
  if (mode === undefined || mode === 'read-only') return false
  return undefined
}

/**
 * Whether Codex lets `it` reach It, as far as what is on this machine says: by a rule that lets
 * `it` out of the sandbox, or by a sandbox that has the network. False where plainly neither.
 */
export function codexLetsItOut(config: string | null | false = codexConfig(), rule = codexRuleLetsItOut()): boolean | undefined {
  if (rule) return true
  return codexGivesNetwork(config)
}

const WHY = 'Codex runs the commands its agent gives it in a sandbox that cannot reach It on this machine, so `it` is stopped there'

/**
 * What a person is told where Codex, as it is set, keeps `it` from reaching It: in lines, with
 * the rule set out as it is to be typed. The rule leaves Codex's sandbox as it is for
 * everything else, which giving the sandbox the network would not.
 */
export const CODEX_SHUT = `${WHY}.
To let \`it\` through, and leave the sandbox as it is for everything else, make the file \`${CODEX_RULE_FILE}\` with this one line in it, and start Codex again:
    ${CODEX_RULE}
Without it, Codex asks you to approve each \`it\` command. In a folder that is not a git repository it does not ask at all, until you choose "Ask for approval" under \`/permissions\` there. None of this is needed if you run Codex with full access.`

/** The same for an agent that was stopped there to pass on, in a sentence or two of its own reply. */
export const CODEX_SHUT_SAID = `${WHY}. A file \`${CODEX_RULE_FILE}\` holding the one line \`${CODEX_RULE}\` lets \`it\` through and leaves the sandbox as it is for everything else. Codex reads it when it next starts.`
