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
 * and take from a plain folder the writing it had. Within one file, a profile that is chosen
 * wins over everything of the older way. Between the person's settings, a project's and the
 * command line, the one that ranks highest and says either decides, so a `sandbox_mode` given
 * with `-c`, as Auto-wake gives it, wins over a profile chosen in a file. A file that defines a profile and chooses none, or has the
 * choosing line below a table, is one Codex will not start with, and so is a table that is in
 * it twice. All of this is as Codex 0.160 was seen to behave in its own window.
 *
 * There is a third way, which leaves the sandbox alone: a rule in Codex's `rules` folder that
 * lets one command run outside it. Seen with Codex as it comes, in a plain folder and in a git
 * one: with only the broad rule for `it`, every `it` command runs unasked, and any other command is
 * still kept from the network and from writing outside its folder. So `it setup` writes that rule
 * into a file of It's own there when it connects Codex (see `CODEX_RULES`). Without it, a git folder
 * asks for approval of each `it` command, and a plain folder refuses the asking itself
 * ("sandbox_approval: false") until the person chooses "Ask for approval" under /permissions.
 * And nothing gets out of the sandbox as it comes: a port of this machine is refused, and so
 * is a socket in a folder. So the rule is what It writes, and what a person is told of where It
 * may not, and the network is only looked for, as something that also lets `it` through. On Windows, Codex's elevated sandbox
 * runs commands as accounts of its own, which It's folder is closed to, and there the network
 * lets nothing through: the rule is the one way.
 *
 * None of that is what a conversation runs with once It has reopened it. Auto-wake starts it in
 * the mode chosen for Codex under Machines, and gives the sandbox of that mode on the command
 * line, which wins over the settings: full access in a person's own settings is not carried into
 * it. So whether `it` reaches It there is asked apart, of the mode (`codexReopenedLetsItOut`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_MODES } from '@it/protocol'

/** The rule that lets `it`, and nothing else, run outside Codex's sandbox: one line of a file in Codex's `rules` folder. */
export const CODEX_RULE = 'prefix_rule(pattern=["it"], decision="allow")'
/** Saving page-supplied bytes always needs approval outside the sandbox. */
export const CODEX_SAVE_RULE =
  'prefix_rule(pattern=["it", "save"], decision="prompt", justification="This command writes a file a page sent to a path on this machine.")'
/**
 * What an agent in Codex is told where `it save` was stopped by the sandbox. A rule that asks
 * runs what the person approves inside the sandbox, and Codex 0.167 has no form of rule that
 * asks and then runs a command outside it: only the agent's asking for that, with
 * `sandbox_permissions` set to `require_escalated`, does. Given that way the first time, the
 * person is asked once, and the command runs where it can reach It. The rule still decides that
 * the person is asked: an `it save` given that way is not run unasked, and since the rule matches
 * it, Codex offers no "don't ask again" for it.
 *
 * Codex can refuse that asking itself without putting it to the person: its automatic review of
 * approvals did so in the rehearsals, and then `it save` never runs, so It hears nothing of it and
 * only the agent knows. The person is at the page, so the agent is told to say there at once what
 * to change in Codex. `/permissions` is Codex's command in its terminal, and a setting of Codex's
 * may keep "Ask for approval" from it, so that step is given only for a conversation open there,
 * and only as something to choose where it is offered. The words are given only where there is a
 * file to save, and not to an agent in another app known to have been started from inside Codex.
 */
export const CODEX_SAVE_ESCALATE =
  'Codex asks the user before every `it save`, and runs the command they approve inside its sandbox, where `it` cannot reach It, unless you asked for it outside. Give every `it save` with `sandbox_permissions` set to `"require_escalated"` and a `justification` from the start, and the user is asked once. If Codex refuses that without asking the user, do not ask again: at once, say so above the page with `it say <page-id> "<words>"`, and carry on with the action text. Where they have this conversation open in Codex in a terminal and Codex said its automatic review refused it, the words are: Codex would not let me save the file you sent. If /permissions in Codex offers “Ask for approval”, choose it and send the file again, and Codex will ask you first. Anywhere else, they say what Codex said.'
/**
 * The commands of `it` that change It on this machine, rather than use it: its installation, its
 * service, whom it answers, what it reports, and the hold it keeps on conversations it cannot tell
 * are over. An agent has no need to run them unasked. Codex takes the strictest of the rules a
 * command matches, so these still ask the person first in the file It writes, and where nobody can
 * be asked, as in a conversation It reopened, they are refused. A rule names a command by its
 * first words, and `it` always takes its first word as the command. Each is asked about whole,
 * with whatever follows it: `it` takes an option or `--` before the word that says what to do, as
 * in `it service --json uninstall`, and a rule that named that word too would not match there.
 * So the forms of these that only say how things are, such as `it service status`, ask as well.
 */
export const CODEX_ASKED = [
  'setup',
  'uninstall',
  'upgrade',
  'login',
  'logout',
  'serve',
  'service',
  'network',
  'runs',
  'telemetry',
  'updates',
  'shell-profile',
  'https',
] as const
/** Where It keeps the file of its own in Codex's settings folder, with the rules that let `it` out of the sandbox. */
export const CODEX_RULES_REL = 'rules/it.rules'
/**
 * The file `it setup` writes when it connects Codex: the one rule that lets `it` run outside
 * Codex's sandbox, with the commands that change It itself still asked about. Codex reads it as
 * Starlark, where a line that begins with `#` is a remark.
 */
export const CODEX_RULES = `# Written by It when \`it setup\` connected Codex. It lets the \`it\` command run outside Codex's
# sandbox, so that it can reach It on this machine. Every other command stays in the sandbox,
# and the \`it\` commands that change It itself still ask you first. \`it save\` also asks first,
# because it writes a file a page sent to a path on this machine. \`it action\` only reads.
# It brings this file up to date with its add-on, and removes it when Codex is disconnected or
# It is uninstalled. Once you change it, it is yours, and It leaves it alone.
${CODEX_RULE}
prefix_rule(pattern=["it", [${CODEX_ASKED.map((word) => `"${word}"`).join(', ')}]], decision="prompt", justification="This command can change It on this machine rather than use it.")
${CODEX_SAVE_RULE}
`
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

/**
 * The file `it setup` writes it in, and a person is told of: one of It's own, beside the one Codex
 * keeps its own rules in. That is in the folder Codex is using, which is the one the rule is then
 * looked for in: where `CODEX_HOME` names another folder than the usual one, a rule kept in the
 * usual one is never read, and the person who wrote it there is told to write it again.
 */
export const CODEX_RULE_FILE = process.env.CODEX_HOME
  ? path.join(path.resolve(process.env.CODEX_HOME), ...CODEX_RULES_REL.split('/'))
  : `~/.codex/${CODEX_RULES_REL}`

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
 * Whether Codex runs the commands its agent gives it as accounts of its own, which It's folder is
 * closed to: its elevated sandbox on Windows does, chosen with `sandbox = "elevated"` under
 * `[windows]`. Its other sandbox there runs them as the person, with less they may write, as the
 * sandbox does elsewhere.
 */
export function codexRunsApart(config: string | null | false = codexConfig(), platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32' || !config) return false
  return bare(settings(config).get('windows.sandbox') ?? '') === 'elevated'
}
/** Whether Codex is set to run its agent's commands with no sandbox at all. */
function codexFullAccess(config: string): boolean {
  const all = settings(config)
  const word = (key: string) => (all.has(key) ? bare(all.get(key)!) : undefined)
  const chosen = word('default_permissions')
  return chosen !== undefined ? chosen === ':danger-full-access' : word('sandbox_mode') === 'danger-full-access'
}

/**
 * Whether Codex lets `it` reach It, as far as what is on this machine says: by a rule that lets
 * `it` out of the sandbox, or by a sandbox that has the network. False where plainly neither. A
 * sandbox that runs commands as accounts of its own is given the network to no end: `it` may not
 * read It's folder there.
 */
export function codexLetsItOut(
  config: string | null | false = codexConfig(),
  rule = codexRuleLetsItOut(),
  platform: NodeJS.Platform = process.platform,
): boolean | undefined {
  if (rule) return true
  const network = codexGivesNetwork(config)
  if (network && config && codexRunsApart(config, platform) && !codexFullAccess(config)) return false
  return network
}

/**
 * Whether Codex lets `it` reach It in a conversation that It reopened, which runs in the mode
 * chosen for Codex under Machines (`mode`, one of `WAKE_MODES`) and not as Codex's settings have
 * it in a window: `carrying` gives the sandbox of the mode on the command line, which wins over
 * them. So full access in the settings says nothing of it.
 *
 * - With a rule that lets `it` out of the sandbox, it does in every mode: a rule that allows
 *   lets its command through whoever approves, and runs it as the person.
 * - Full Access has no sandbox, and `it` runs there as it does in a terminal.
 * - Approve for me and Ask for approval are the sandbox for a workspace, given the network and
 *   It's folder to write in, which is what `it` needs. On Windows It's folder is not given, since
 *   Codex leaves a folder it gave its sandbox open to every sandboxed command after it, and the
 *   elevated sandbox there runs commands as accounts It's folder is closed to. Where Codex has no
 *   sandbox set up there, every command no rule lets through would ask. So on Windows the rule is
 *   the one way: without it `it` is refused where nobody approves, and under the reviewer each
 *   `it` command waits on a model that may refuse it, which is nothing to count on.
 * - Read Only is the read-only sandbox, which has no network on any system: the rule is the one
 *   way there too. A mode with a name this It does not know is run as Read Only.
 */
export function codexReopenedLetsItOut(mode: string, rule = codexRuleLetsItOut(), platform: NodeJS.Platform = process.platform): boolean {
  if (rule || mode === 'full-access') return true
  if (mode !== 'approve-for-me' && mode !== 'ask') return false
  return platform !== 'win32'
}

const WHY = 'Codex runs the commands its agent gives it in a sandbox that cannot reach It on this machine, so `it` is stopped there'
/** The rules of the file It writes, set out as they are to be typed. */
const RULES_SET_OUT = CODEX_RULES.split('\n')
  .filter((line) => line.startsWith('prefix_rule'))
  .map((line) => `    ${line}`)
  .join('\n')

/**
 * What a person is told where Codex, as it is set, keeps `it` from reaching It: in lines, with
 * the rule set out as it is to be typed. The rule leaves Codex's sandbox as it is for
 * everything else, which giving the sandbox the network would not. `it setup` writes it when it
 * connects Codex, so this is said mostly where the file is not It's to write: the person made one
 * of that name, or changed It's since.
 */
export const CODEX_SHUT = `${WHY}.
Run \`it setup\` again to install the complete protected rules in \`${CODEX_RULE_FILE}\`, then restart Codex. If you edited that file, keep your changes and add all these rules yourself:
${RULES_SET_OUT}
These rules allow reads with \`it action\`, but \`it save\` and administrative commands ask first. Without the rules, Codex asks you to approve each \`it\` command.`

/**
 * What a person is told where Codex lets `it` through in its own window and would not in a
 * conversation that It reopens, in the mode chosen for Codex under Machines: why the two differ,
 * what becomes of `it` there, and the same rules. A reopened conversation is a Codex that has
 * just started, which reads the rules as it does, so nothing needs starting again for it.
 */
export function codexShutReopened(mode: string): string {
  const name = WAKE_MODES.codex?.choices.find((choice) => choice.id === mode)?.label ?? mode
  const stopped =
    mode === 'approve-for-me' ? 'each `it` command there waits on Codex’s reviewer, which may refuse it' : '`it` is stopped there, with nobody to approve it'
  return `Auto-wake is on for Codex, and a conversation that It reopens runs in ${name}, the mode chosen for Codex on the site’s Machines page, whatever access Codex has in its own window. In that mode on this machine \`it\` reaches It only through a rule that lets it out of Codex’s sandbox, and Codex’s rules folder has none, so ${stopped}.
Run \`it setup\` again to install the complete protected rules in \`${CODEX_RULE_FILE}\`. If you edited that file, keep your changes and add all these rules yourself:
${RULES_SET_OUT}
These rules allow reads with \`it action\`, but \`it save\` and administrative commands ask first.`
}

/**
 * The same for an agent that was stopped there to pass on, in a sentence or two of its own
 * reply. Codex reads its rules as it starts, so a Codex that was running when setup wrote the
 * file is one that does not have the rule yet.
 */
export const CODEX_SHUT_SAID = `${WHY}. Run \`it setup\` to install the complete protected rules in \`${CODEX_RULE_FILE}\`, then restart Codex. If you edited that file, keep your changes and add all of these rules: ${CODEX_RULES.split(
  '\n',
)
  .filter((line) => line.startsWith('prefix_rule'))
  .map((line) => `\`${line}\``)
  .join('; ')}. Reads with \`it action\` remain allowed; \`it save\` asks first.`

/**
 * What a person is told of Codex where it is connected and something would keep \`it\` from It, or
 * null where nothing would: that Codex as it is set keeps it out, or, where it does not, that a
 * conversation It reopens would, in the mode it runs in (\`reopened\`, given where Auto-wake is on
 * for Codex on this machine), or else what is missing from a rules file of the person's own.
 */
export function codexShutSaid(
  reopened?: string | null,
  config: string | null | false = codexConfig(),
  rule = codexRuleLetsItOut(),
  platform: NodeJS.Platform = process.platform,
  home = codexHome(),
): string | null {
  if (codexLetsItOut(config, rule, platform) === false) return `Codex: ${CODEX_SHUT}`
  if (reopened != null && !codexReopenedLetsItOut(reopened, rule, platform)) return `Codex: ${codexShutReopened(reopened)}`
  return codexRulesWarning(home)
}

/** A personal rules file is preserved, but must not be described as protected without the save rule. */
export function codexRulesWarning(home = codexHome()): string | null {
  try {
    const text = readFileSync(path.join(home, ...CODEX_RULES_REL.split('/')), 'utf8')
    if (text.split('\n').some((line) => line.trim() === CODEX_SAVE_RULE)) return null
    return `Codex: your rules file was left unchanged. It needs the \`it save\` prompt rule before saving is protected: ${CODEX_SAVE_RULE}`
  } catch {
    return null
  }
}
