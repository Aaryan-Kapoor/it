// `it`: the one command agents and people use. A command prints JSON on standard output, and
// anything said along the way goes to standard error, so that what a command printed can always
// be parsed. Three print text and no JSON: `it help`, `it skill` and `it service logs`. And the
// five that a person runs to look after It (`it setup`, `it status`, `it site`, `it network`
// and `it service status`) print a few plain sentences where standard output is a terminal, and
// the same JSON as ever where it is not, or when `--json` is given.
import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { describeClick, firstFile, HARNESSES, type Harness, isSlug, LIMITS, NOUN, newer, PROTOCOL_VERSION, parseJson, TAKES, withoutFiles } from '@it/protocol'
import { MORE, SKILL } from './addons.generated'
import { type Args, json, loose, need, nested, optionsFor, outputArgs, parse, text } from './args'
import { conversationIds, local } from './connector'
import { deletePage, deletionStatus } from './delete'
import { saveAttached } from './files'
import * as flow from './flow'
import { hook } from './hooks'
import { checkInstallationFolder, checkInstallationRecord, legacyInstallation, markedInstallation, markInstallation } from './installation'
import { withInstallerLock } from './installer-lock'
import {
  api,
  askConnectorWith,
  askShell,
  backend,
  backendAt,
  backendTakes,
  basePort,
  call,
  changeWhole,
  direct,
  doorRefusal,
  elsewhere,
  end,
  enrolledHere,
  forgetMachine,
  hasLeft,
  home,
  inHome,
  joinLine,
  keptFromIt,
  left,
  machine,
  NOT_RUNNING,
  noteLeft,
  noteWas,
  notKnown,
  notSetUp,
  Problem,
  plainWord,
  readJson,
  sessionAsked,
  sessionNote,
  settingsFile,
  shutIn,
  siteAddress,
  textOf,
  VERSION,
  why,
  windowsPathCommand,
  windowsPathHas,
  windowsPathRemoval,
  withoutTables,
  writePrivate,
  written,
} from './lib'
import { joinedBefore, login, runsItsOwn } from './login'
import { lenientAboutServiceMarks, nodeTooOld, quietAboutItsDatabase } from './node'
import { failure, forPerson } from './output'
import { gather, noteConversation, publish } from './publish'
import { alone, asAdmin, nothingLeft, standing, startBackend } from './serve/backend'
import { noteNetwork, readConfig } from './serve/config'
import { begin } from './serve/firstrun'
import { serve } from './serve/index'
import { onTheInternet, reachable } from './serve/network'
import { tailnetAddresses, tailnetName } from './serve/tailnet'
import * as service from './service'
import {
  AFTER,
  CODEX_RULE_FILE,
  CODEX_SHUT,
  codexLetsItOut,
  codexRuleLetsItOut,
  detectAll,
  disconnect,
  type HarnessStatus,
  holdsAddons,
  KNOWN,
  reconcile,
  shim,
  stampFile,
  supported,
  whyHeldBack,
} from './setup'
import { printEnv } from './shell-env'
import { zshDirectory } from './shell-profile'
import { GUIDE, NAMES, END as TOUR_END, STEPS as TOUR_STEPS, tourPage } from './tour'
import { finishInstallationRemoval, installationFile, removeInstallationFiles, stepOutOf, withInstallationLock } from './uninstall-files'
import { fetchNewer, keepBase, latest, watch, watched, withCurrentProgram } from './upgrade'
import * as usage from './usage'
import { type Listed, printed, wait } from './wait'

// Everything is written through `written`, which follows each write until it has left the
// process, and nothing here ends the process before all of it has: see `end` and `left`.
const say = (line: string): void => written(process.stderr, `${line}\n`)
const out = (value: unknown): void => written(process.stdout, `${JSON.stringify(value, null, 2)}\n`)

/** Says something to a person, a sentence or a paragraph to the line, on standard output. */
const tell = (lines: (string | undefined)[]): void => written(process.stdout, `${lines.filter((line) => line !== undefined).join('\n')}\n`)

/** What a person is told where Codex is connected and, as it is set, would keep `it` from reaching It. Null where it would not. */
function codexShut(found: HarnessStatus[]): string | null {
  if (!found.some((h) => h.id === 'codex' && (h.addon === 'connected' || h.addon === 'needs_approval'))) return null
  return codexLetsItOut() === false ? `Codex: ${CODEX_SHUT}` : null
}
/** What a person is told of the agent apps on this machine: each one that was found, and whether It is connected to it. */
/**
 * Tells It which agent apps were chosen on this machine, and what system the machine runs,
 * which no connector has reported yet when setup is first run. Answers with the apps of them
 * that It reopens closed conversations of here. An It from before it took the system is told
 * the choice alone, and says nothing of that.
 */
async function chosen(wanted: string[]): Promise<string[]> {
  const said = await call<{ wakes?: string[] } | null>('mutation', api.machines.choose, { harnesses: wanted, system: process.platform }).catch(() =>
    call<{ wakes?: string[] } | null>('mutation', api.machines.choose, { harnesses: wanted }),
  )
  return said?.wakes ?? []
}
/**
 * The apps It reopens closed conversations of on this machine as things stand, asked before a
 * setup chooses anything. Null where It cannot be asked.
 */
const wokenNow = (): Promise<Set<string> | null> =>
  call<{ wakes?: { harness: string }[] } | null>('query', api.machines.me).then(
    (me) => new Set((me?.wakes ?? []).map((w) => w.harness)),
    () => null,
  )
/**
 * Of the apps that It reopens closed conversations of once a setup has chosen, those it does
 * so for because of this setup: it did not before, by It's own word. That is what the person
 * is told of, and not whether the app's add-on was installed already: a machine that was
 * enrolled anew in the place of the one it was has its add-ons as they were, and reopening
 * comes on for it with the choice all the same. Where It could not be asked how things stood,
 * it is taken to have come on for the apps that were not connected before.
 */
const cameOn = (woken: string[], before: Set<string> | null, connected: Set<Harness>): string[] =>
  woken.filter((id) => (before ? !before.has(id) : !connected.has(id as Harness)))
/**
 * What setup says, once, of the apps it has just connected that It reopens closed
 * conversations of: reopening is on from the start, and it runs an agent with nobody
 * watching, so the person is told that it is, what it does and where to turn it off.
 */
function wakesSaid(woken: string[]): string | null {
  if (!woken.length) return null
  const names = woken.map((id) => KNOWN[id as Harness]?.label ?? id)
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `Auto-wake is on for ${listed}: when you use a page whose conversation is closed, It reopens the conversation and runs the agent on this machine with nobody watching. You can turn it off for each app on the site’s Machines page.`
}

function appsSaid(found: HarnessStatus[], advise = true, withCodex = true): string[] {
  if (!found.length) return ['No agent app was found on this machine.']
  const lines = found.map((h) => {
    const app = KNOWN[h.id].label
    if (h.addon === 'connected') return h.runtime ? `${app}: ${h.runtime.detail}` : `${app}'s add-on is installed. Its loaded code has not been verified.`
    if (h.addon === 'needs_approval') return `${app} is connected, and one thing is left for you to do: ${h.detail}`
    return `${app} is not connected${h.detail && h.addon !== 'not_connected' ? `: ${h.detail}` : '.'}`
  })
  // Said each time it is asked for as long as it is so: the first thing a Codex user would otherwise learn of it is a page that never appears
  const shut = withCodex ? codexShut(found) : null
  if (shut) lines.push(shut)
  if (advise && found.some((h) => h.addon === 'not_connected' && supported(h.id))) lines.push('Run `it setup` to choose which agent apps are connected.')
  return lines
}
/** What a person is told of the background service, and of whether what is done on a page is being handed to the conversations on this machine, which is the connector's doing. */
function serviceSaid(
  background: { registered: boolean; state: string; startup?: service.ServiceStatus['startup'] },
  connector: Record<string, unknown>,
  running: boolean,
): string[] {
  return [
    ...(background.startup
      ? [
          background.startup.paused
            ? `Automatic startup stopped after ${background.startup.failures} failed starts (${background.startup.code}). ${background.startup.hint}`
            : `Startup is waiting to retry after ${background.startup.code}. ${background.startup.hint}`,
        ]
      : []),
    background.registered
      ? `It is registered with the system to start by itself (${background.state}).`
      : service.reachable()
        ? 'It is not registered to start by itself. `it setup` registers it, and `it serve` runs it in a terminal until then.'
        : 'Nothing starts It by itself on this machine: no systemd for your account can be reached from here. `it serve` runs it, in a terminal or under a supervisor of your own.',
    // A machine that joined an It of a version it does not fit hands nothing over, and says which of the two to update
    ...(typeof connector.unfit === 'string' ? [`${connector.unfit} Nothing done on a page is handed to an agent on this machine until then.`] : []),
    ...(connector.unchecked === true
      ? [
          'The It this machine joined has not yet said which version it speaks, so nothing done on a page is handed to an agent here yet. It is asked again every minute: check that that It is running and can be reached from here.',
        ]
      : []),
    ...(typeof connector.heldRuns === 'number' && connector.heldRuns > 0
      ? ['Some conversations are not reopened for now, since a turn of theirs from before may still be running: `it runs` says which, and what to do.']
      : []),
    ...(running && connector.ok !== true
      ? [
          'It is not handing what is done on a page to the conversations on this machine, so nothing done there reaches an agent here by itself. `it service logs` says what it met.',
        ]
      : []),
  ]
}

async function piped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  // No more than the largest thing a command takes: a pipe that goes on and on, a log or a
  // file that is no page, is given up there and not read into memory to its end
  const all = await textOf(process.stdin, LIMITS.fileBytes).catch((err) => {
    if ((err as { code?: string })?.code === 'too_much')
      throw new Problem(`What was piped in is larger than anything this command takes (${LIMITS.fileBytes / (1024 * 1024)} MB).`, 'limit')
    throw err
  })
  return all.trim() ? all : undefined
}

// ---------- pages ----------

async function source(a: Args) {
  // The three say where one page is, and a command given two of them would have to choose which
  // it meant: an agent that changed `--html` for `--file` and left the first in would publish
  // the page it had meant to replace. So nothing is read and nothing published
  const given = ['file', 'dir', 'html'].filter((name) => text(a, name) !== undefined).map((name) => `--${name}`)
  if (given.length > 1)
    throw new Problem(
      `A ${NOUN.one} is published from one source, and this command was given ${given.slice(0, -1).join(', ')} and ${given.at(-1)}.`,
      'invalid',
      'Give one of --file, --dir and --html, or pipe HTML in with none of them.',
    )
  const html = text(a, 'html') ?? (text(a, 'file') || text(a, 'dir') ? undefined : await piped())
  return gather({ html, file: text(a, 'file'), dir: text(a, 'dir') })
}
/**
 * Runs something that names a display. The backend says only that there is none of that name:
 * which name was asked for, and which there are, is said here, where it is the person's own
 * machine saying it.
 */
async function onDisplay<T>(a: Args, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof Problem) || err.code !== 'no_such_display') throw err
    const names = await call<{ name: string }[]>('query', api.displays.list).then(
      (all) => all.map((d) => named(d.name)).join(', '),
      () => '',
    )
    throw new Problem(`No display is called ${named(text(a, 'on') ?? '')}.`, 'not_found', names ? `Displays: ${names}` : noDisplay())
  }
}
/**
 * What to say when something was shown on no display because there is none. A display is a
 * browser with the site open and paired, so the person is told how to get one: neither they
 * nor an agent would otherwise learn why nothing appeared anywhere.
 */
const noDisplay = () =>
  `No display is paired yet, so there is nowhere to show it. Run \`it site\` to open ${siteAddress() ?? 'the site'} in a browser on this machine and pair that browser. Other displays are added from there.`
/** What It answers when asked to show a page: the displays it is now shown on, and each one it was asked onto and is not shown on, with why. */
interface Shown {
  displays: string[]
  notShown?: { display: string; reason: string }[]
}
async function show(slug: string, a: Args) {
  return onDisplay(a, () => call<Shown>('mutation', api.displays.show, { slug, ...(text(a, 'on') ? { display: text(a, 'on') } : {}) }))
}
/**
 * What is printed of where a page was asked to be shown: `shownOn` names the displays it is
 * shown on, and `notShownOn` each display it was asked onto and is not shown on, with the
 * reason beside it. A display is one the person named and kept, and it stays when the pairing
 * of its browser is ended: it then shows nothing until that browser is paired again, which is
 * the one reason there is, `not_paired`. The `hint` says so in words, and where no display was
 * there to be asked at all, how one is paired.
 */
function shownAs(shown: Shown): { shownOn: string[]; notShownOn?: { display: string; reason: string }[]; hint?: string } {
  const notShownOn = shown.notShown ?? []
  const ended = notShownOn.filter((d) => d.reason === 'not_paired').map((d) => named(d.display))
  const one = ended.length === 1
  const which = one ? ended[0]! : `${ended.slice(0, -1).join(', ')} and ${ended.at(-1)}`
  const hint = ended.length
    ? `${which} ${one ? 'is' : 'are'} not paired any more: the pairing of ${one ? 'its browser' : 'their browsers'} was ended, and ${one ? 'it shows' : 'they show'} nothing until ${one ? 'that browser is' : 'those browsers are'} paired again. On the machine It runs on, \`it site\` pairs the browser there. Another screen is paired from the site, under Displays, with “Add a display”.`
    : shown.displays.length || notShownOn.length
      ? undefined
      : noDisplay()
  return { shownOn: shown.displays, ...(notShownOn.length ? { notShownOn } : {}), ...(hint ? { hint } : {}) }
}

const LOGIN = 'login --url <address> --code <invite> [--name <name>] [--no-setup]'
// How many words each command takes besides its switches, and how it is written. `set` and
// `notify` are not here: they read all their last words together as one text.
const WORDS: Record<string, [most: number, usage: string]> = {
  login: [0, LOGIN],
  logout: [0, 'logout [--force]'],
  uninstall: [0, 'uninstall [--yes]'],
  whoami: [0, 'whoami'],
  status: [0, 'status'],
  setup: [0, 'setup [--all | --only a,b | --none] [--name <name>] [--no-service]'],
  site: [0, 'site [--no-open]'],
  network: [1, 'network [on | off | tailscale]'],
  serve: [0, 'serve [--log <file>]'],
  service: [1, 'service install | uninstall | status | logs'],
  skill: [0, 'skill'],
  tour: [2, 'tour [--wait] [show <name> | show next | clear]'],
  telemetry: [1, 'telemetry [on | off]'],
  upgrade: [0, 'upgrade [--check]'],
  updates: [1, 'updates [on | off]'],
  runs: [1, 'runs [clear]'],
  create: [1, 'create "<title>" [--id <id>] (--file f | --dir d | --html "<…>" | pipe)'],
  update: [1, 'update <id> (--file f | --dir d | --html "<…>" | pipe)'],
  list: [0, 'list'],
  read: [1, 'read <id>'],
  delete: [1, 'delete <id> [--status]'],
  rollback: [2, 'rollback <id> <version>'],
  patch: [2, "patch <id> '<json>' [--replace] [--if-revision <n>]"],
  state: [1, 'state <id>'],
  open: [1, 'open <id> [--on "<display>"]'],
  displays: [0, 'displays'],
  wait: [0, 'wait [--id <id>] [--follow] [--timeout <seconds>]'],
  actions: [0, 'actions [--id <id>]'],
  action: [1, 'action <action-id> [--save <file> [--number <n>]]'],
  ack: [1, 'ack <action-id> [--failed]'],
}
/**
 * Refuses a word a command has no use for. One left after a switch (`--force false`) would
 * otherwise be dropped in silence and the switch read as given, which for `ack --failed` or
 * `setup --none` does what the person meant not to do.
 */
function noMore(cmd: string, a: Args): void {
  if (!Object.hasOwn(WORDS, cmd)) return
  const [most, usage] = WORDS[cmd]!
  if (a._.length > most) throw new Problem(`It does not know what to do with "${a._[most]}".`, 'invalid', `Usage: it ${usage}`)
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Problem(`${what} is a JSON object.`, 'invalid')
  return value as Record<string, unknown>
}

async function create(a: Args) {
  const title = need(a._[0], `the ${NOUN.one}'s title`, 'create "<title>" [--id <id>] (--file f | --dir d | --html "<…>" | pipe)')
  const slug = text(a, 'id')
  if (slug !== undefined && !isSlug(slug)) throw new Problem('An id is lowercase letters, digits, dots, dashes and underscores, at most 64.', 'invalid')
  const state = text(a, 'state')
  if (state !== undefined) object(json(state, '--state'), '--state')
  // A conversation that makes a page is the one that hears what is done on it. Where the id is
  // already another conversation's page, nothing is made, and the conversation is told whose it
  // is: two that each chose `counter` ended with one page, and the first went on telling its
  // person to press a button whose presses it never heard of again. Someone who says "show me
  // the board again" the next day means that very page, and the conversation in front of them
  // says so, with `it open` or with --take. `it update` leaves a page with whoever has it,
  // unless told --take.
  const take = a.flags.take === true
  const page = { slug, title, files: await source(a), agent: text(a, 'agent'), state, shown: a.flags.open === true }
  let done: Awaited<ReturnType<typeof publish>>
  try {
    done = await publish({ ...page, take, own: !take })
  } catch (err) {
    if (!(err instanceof Problem) || err.code !== 'anothers' || slug === undefined) throw err
    const theirs = await call<Made>('query', api.artifacts.get, { slug }).catch(() => null)
    // The same conversation, under the id its app gave it before it was cleared or carried on: the page is its own
    if (theirs?.session && carriedOn(theirs.session, theirs.machineId))
      done = await publish({ ...page, take: true, expectedOwner: { machineId: theirs.machineId!, session: theirs.session } })
    else throw anothers(slug, theirs)
  }
  await published(done, a, done.version === 1)
}

/** What is known of a page that a conversation meant to make and that is another's. */
type Made = {
  title?: string
  agent?: string | null
  machine?: string | null
  machineId?: string | null
  updatedAt?: number
  session?: { harness: string; id: string } | null
}
/**
 * Whether a conversation is the one this command runs in, under an id it had before: an agent
 * app that clears a conversation, or carries it on, gives it a new id, and the connector on
 * this machine keeps which id became which.
 *
 * It is asked of a page the backend has just said is another conversation's. One under the very
 * id this conversation has is therefore on another machine, where a conversation that was
 * copied there has the same id: it is another's, and so is any page the backend says is on
 * another machine than this, whatever became of its id here. Taking a page from another machine
 * is for whoever says so, with --take or `it open`.
 */
function carriedOn(was: { harness: string; id: string }, onMachine?: string | null): boolean {
  const now = sessionAsked()?.session
  if (!now || now.harness !== was.harness || now.id === was.id) return false
  if (typeof onMachine !== 'string' || onMachine !== readJson<{ id?: string }>(inHome('machine.json'))?.id) return false
  const became = readJson<Record<string, string>>(inHome('aliases.json')) ?? {}
  let key = `${was.harness}:${was.id}`
  for (let hops = 0; hops < 10 && typeof became[key] === 'string'; hops++) key = became[key]!
  return key === `${now.harness}:${now.id}`
}
/**
 * A name that a person or an agent chose (a page's title, a display's or a machine's name), as
 * it stands in a sentence this command says as its own: in quotation marks that nothing in
 * the name can close, so that no name reads as more of the sentence, or as another.
 */
const named = (name: string): string => JSON.stringify(name)

/** What a conversation is told when the id it chose for a page is another conversation's page: whose it is, and the three things it can do. */
function anothers(slug: string, theirs: Made | null): Problem {
  const app = appName(theirs?.agent ?? theirs?.session?.harness)
  const whose = [app ? `${app}’s` : '', theirs?.machine ? `on ${named(theirs.machine)}` : ''].filter(Boolean).join(', ')
  const changed = ago(theirs?.updatedAt)
  return new Problem(
    `There is already a ${NOUN.one} with the id ${slug}${theirs?.title ? `, ${named(theirs.title)}` : ''}, and it belongs to another conversation${whose ? ` (${whose}${changed ? `, last changed ${changed}` : ''})` : ''}. Nothing was published.`,
    'conflict',
    `If you are making something new, publish it under another id. If the person asked for that very ${NOUN.one}, \`it open ${slug}\` brings it up as it is and makes it this conversation’s, and this command with --take replaces it with yours. Taken either way, what is done on it comes here, and the other conversation hears no more of it.`,
  )
}

/**
 * Says what was published, having brought it up on a display if that was asked for. The page
 * exists by now whatever becomes of showing it, so it is always said, with what went wrong
 * beside it: an agent told only "no such display" would publish the same page a second time.
 */
async function published(done: { slug: string; version: number; url: string; note?: string; urlNote?: string }, a: Args, fresh = false): Promise<void> {
  const result = {
    id: done.slug,
    version: done.version,
    url: done.url,
    // Why the url is not at the place the owner chose for links, where It cannot be reached there just now
    ...(done.urlNote ? { urlNote: done.urlNote } : {}),
    ...(done.note ? { note: done.note } : {}),
    // A page that was just made is one the person has no way to yet, but for a display that
    // happens to be open: the agent is told, each time, to put its address in the chat. Said
    // by the command and not left to the skill, which an agent has read once and long ago
    ...(fresh ? { tell: `Give the user this url in the chat, in one short line that says what is on the ${NOUN.one}.` } : {}),
  }
  if (!a.flags.open) return out(result)
  try {
    out({ ...result, ...shownAs(await show(done.slug, a)) })
  } catch (err) {
    if (!(err instanceof Problem)) throw err
    out({
      ...result,
      shownOn: [],
      notShown: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
      // Said in so many words: an empty `shownOn` alone reads as "no display is paired", and this is not that
      hint: `The ${NOUN.one} is published, and only showing it failed: \`notShown\` says why. Do not publish it again. Run \`it open ${done.slug}\` to show it.`,
    })
    process.exitCode = 1
  }
}

/** How often an agent that waits to give the tour says so, and asks whether it was asked for. */
const TOUR_ASK_EVERY_MS = 2500
/**
 * What an agent that waited is told before the tour itself, when the person has asked for it
 * on the site.
 */
const TOUR_ASKED = `The person pressed "Take the tour" on It's site a moment ago, and is looking at that screen now. Give them the tour below, in this conversation, starting now. The tour's menu is what answers their press, so show it before you say anything.`
/** The words the tour's first rule begins with, by which it is found. */
const TOUR_RULE_ONE = '1. **Never block.**'
/**
 * The tour's first rule for an agent that waited for the button. Such an agent has usually just
 * installed It, in a conversation that was open before It's add-on was there, and is told
 * nothing by itself. The rule as the tour has it sends such an agent to a waiter left running
 * in the background, which an app without one runs in front and never hears from again: so
 * here the rule is another, in the place of the first, and not a second word against it.
 */
const TOUR_RULE_ONE_WAITING = `1. **Wait for each thing they do.** This conversation was open before It's add-on was installed, so nothing the person does on a page arrives here by itself. After every page you show and every answer you give, run \`it wait --timeout 100\` and act on what it prints: an action, or \`{"timedOut": true}\`, which means that nothing has happened yet, and you run it again. Where it is refused because your harness does not tell \`it\` which conversation this is, add \`--id\` and the id of the page that is on the screen. Do not use \`--follow\`, and do not put the command in the background: it has to end for you to be shown what it printed. The person is at the screen and not at this chat, so a command that holds your terminal costs them nothing.`
/** The tour as an agent that waited for the button is given it. */
function tourForOneThatWaited(guide: string): string {
  const lines = guide.split('\n')
  const at = lines.findIndex((line) => line.startsWith(TOUR_RULE_ONE))
  // Where the tour no longer has that rule, it is given as it is, with the rule said before it
  if (at < 0) return `${TOUR_ASKED}\n\n${TOUR_RULE_ONE_WAITING}\n\n${guide}`
  lines[at] = TOUR_RULE_ONE_WAITING
  return `${TOUR_ASKED}\n\n${lines.join('\n')}`
}

/**
 * What setup says last to whoever ran it without a terminal, which is an agent installing It
 * for someone. An agent reads what a command prints whole. The install guide it may not have
 * read at all: an agent app's own tool for fetching a page hands its agent a summary, and in
 * the summaries seen the guide's last step was gone, so the agent installed It, gave the
 * pairing link and stopped, with no tour. So the two steps that follow setup are said here,
 * with how to read the guide itself.
 */
export const AFTER_SETUP =
  'If you are an agent installing It for someone, two steps of the install guide come after this one: give the person the link that `it site --no-open` prints, to open on this computer, then run `it tour --wait` in the same turn and do what it prints. If you read a summary of the guide and not the guide itself, read it whole now, with `curl -fsSL https://itcan.do/install.md`, and go on from its step 3.'

/**
 * `it tour --wait`: waits until the person asks for the tour with the button on the site, and
 * then prints the tour for the agent to give. While it waits the site says that an agent is
 * ready, which is what makes the button more than a sentence to copy. When the time is up and
 * nobody has asked, it says so and ends, and may be run again.
 */
async function tourWhenAsked(a: Args) {
  const seconds = text(a, 'timeout') === undefined ? 100 : Number(text(a, 'timeout'))
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Problem('--timeout is a number of seconds.', 'invalid')
  const harness = sessionAsked()?.session.harness
  const until = performance.now() + seconds * 1000
  const waitId = crypto.randomUUID()
  let first = true
  for (;;) {
    const answer = await call<{ asked: boolean }>('mutation', api.tour.wait, {
      waitId,
      ...(first ? { first: true } : {}),
      ...(harness ? { harness } : {}),
    }).catch((err) => {
      if (
        err instanceof Problem &&
        err.code === 'conflict' &&
        err.message === 'The person said on the site that they want no tour, so there is nothing to wait for. Give the tour when they ask you for it.'
      )
        return null
      throw err
    })
    first = false
    if (answer === null) return out({ skipped: true, hint: 'The person skipped the tour.' })
    const { asked } = answer
    if (asked) {
      // What the person does on the tour's first page may come before this agent's first wait
      // for it. The connector is told now that this conversation waits for each thing in turn,
      // as one that has just waited does, so that it leaves that for the wait and puts it nowhere else
      const me = sessionAsked()?.session
      if (me) {
        const who = crypto.randomUUID()
        await local('/waiting', { method: 'POST', body: { id: who, slug: null, session: me } }).catch(() => {})
        await local('/waiting', { method: 'POST', body: { id: who, done: true } }).catch(() => {})
      }
      return written(process.stdout, tourForOneThatWaited(GUIDE))
    }
    const left = until - performance.now()
    if (left <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(TOUR_ASK_EVERY_MS, left)))
  }
  await call('mutation', api.tour.leave, { waitId }).catch(() => {})
  return out({
    timedOut: true,
    hint: 'Nobody has pressed "Take the tour" on the site yet. Run this again to go on waiting. If the person has not opened the pairing link yet, that comes first.',
  })
}

/**
 * The tour an agent gives of It. With nothing after it, the guide is printed for the agent to
 * follow. `show` publishes one of the tour's pages and brings it up, starting afresh each time,
 * and `clear` removes every page of the tour and nothing else.
 *
 * Which things the person has been shown is kept in the menu's own state, as `seen`, so that
 * the menu marks them when it is shown again, and `show next` is the next of them that has
 * not been: the agent that gives the tour keeps no count of its own. When all have been seen,
 * what comes next is the ending.
 */
async function tour(a: Args) {
  const USAGE = 'tour [--wait] [show <name> | show next | clear]'
  const what = a._[0]
  if (a.flags.wait === true && what === undefined) return tourWhenAsked(a)
  if (what === undefined) return written(process.stdout, GUIDE)
  if (what === 'clear') {
    const cleared = await call<{ requested: { slug: string; job: string }[]; kept: string[]; seen: number }>('mutation', api.tour.clear, {})
    if (cleared.requested.length) usage.record('tour.ended', { seen: String(Math.min(cleared.seen, 5)) as '0' | '1' | '2' | '3' | '4' | '5' })
    const results = await Promise.all(cleared.requested.map(({ slug, job }) => deletionStatus(slug, job)))
    const pending = results.filter((r) => r.state !== 'completed')
    return out({
      deleted: results.filter((r) => r.state === 'completed').map((r) => r.requested),
      ...(pending.length ? { pending } : {}),
      ...(cleared.kept.length
        ? {
            kept: cleared.kept,
            hint: 'These pages have tour ids but no tour ownership mark, so they were preserved. Older tour pages are preserved too. Ask the person before deleting any of them with it delete.',
          }
        : {}),
    })
  }
  if (what !== 'show') throw new Problem(`It does not know what to do with "${what}".`, 'invalid', `Usage: it ${USAGE}`)
  const asked = need(a._[1], `which page of the tour (${NAMES.join(', ')}, or next)`, USAGE)
  const { seen } = asked === 'next' ? await call<{ seen: string[] }>('query', api.tour.seen, {}) : { seen: [] }
  const name = asked === 'next' ? (TOUR_STEPS.find((step) => !seen.includes(step)) ?? TOUR_END) : asked
  const given: Record<string, unknown> = {}
  for (const param of a.many.param ?? []) {
    const eq = param.indexOf('=')
    if (eq < 1) throw new Problem('--param is written name=value.', 'invalid')
    given[param.slice(0, eq)] = loose(param.slice(eq + 1))
  }
  // The agent's plate on the page carries the name of the agent app that is giving the tour, where that is known
  const by = sessionAsked()?.session.harness
  const made = tourPage(name, given, text(a, 'agent') ?? (by && Object.hasOwn(KNOWN, by) ? KNOWN[by as Harness].label : undefined))
  // The page is this conversation's from now on, whoever showed it last. An agent app that does
  // not say which conversation it is in has none to take the page for: it publishes the page all
  // the same, and waits for what is done on it by the page's id, as the tour tells it to
  const done = await publish({
    slug: made.slug,
    title: made.title,
    files: gather({ html: made.html }),
    agent: text(a, 'agent'),
    state: made.state,
    take: by !== undefined,
    itsOwn: true,
    tour: name,
  })
  // Counted as a page of the tour that was shown, by its name, which is It's own
  usage.record('tour.shown', { page: name as usage.TourPage, agent: usage.agentOf(by) })
  a.flags.open = true
  await published(done, a)
}

async function update(a: Args) {
  // Written as `it create` is, with the id in `--id` and a title in front of it, it is taken as that:
  // an agent that has just made a page with the one often asks for the other in the same shape
  const named = text(a, 'id')
  const slug = named ?? need(a._[0], `which ${NOUN.one}`, 'update <id> (--file f | --dir d | --html "<…>" | pipe)')
  const retitled = named !== undefined && a._[0] !== undefined && a._[0] !== named ? a._[0] : undefined
  const existing = await call<{ title: string }>('query', api.artifacts.get, { slug })
  const done = await publish({
    slug,
    title: text(a, 'title') ?? retitled ?? existing.title,
    files: await source(a),
    agent: text(a, 'agent'),
    take: a.flags.take === true,
    shown: a.flags.open === true,
  })
  await published(done, a)
}

/** A page as an agent sees it: the id is the one it chose, not the backend's own. */
/** How long ago something was, in a word or two. */
function ago(at: unknown, now = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}
/** Rows set in columns, each column as wide as its widest cell, for a person to read. */
function columns(rows: string[][]): string[] {
  const wide = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), [])
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(wide[i]!)))
      .join('  ')
      .trimEnd(),
  )
}
/** An agent app by the name a person knows it by. */
const appName = (id: unknown): string => (typeof id === 'string' && Object.hasOwn(KNOWN, id) ? KNOWN[id as Harness].label : typeof id === 'string' ? id : '')

function page(p: Record<string, unknown>): Record<string, unknown> {
  const { id: _internal, slug, ...rest } = p
  return { id: slug, ...rest }
}

// ---------- this machine ----------

/** Asks the system to open an address in the person's browser. False where it is not asked: over SSH the browser would open on a screen nobody is at. */
function openBrowser(url: string): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false
  // Nor where there is no screen to open one on, or nothing to open one with: said to be
  // opening there, the person waits for a browser that never comes
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false
    const found = (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, 'xdg-open')))
    if (!found) return false
  }
  // Never through a shell: the address came from a server. On Windows `start` is a shell
  // command, so the system's own handler for addresses is called directly instead.
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, shell: false })
      .on('error', () => {})
      .unref()
  } catch {}
  return true
}

async function connectorHealth(): Promise<Record<string, unknown> | null> {
  return local<Record<string, unknown>>('/health')
}
// A command that finds nothing at It's port asks this as well, to tell an It that is stopped from a command that is shut in
askConnectorWith(async () => (await connectorHealth())?.ok === true)
/**
 * What answers at an address when it is asked how it is: It, a program that is not It, or
 * nothing at all. Or the asking was not let happen: the system refused this command the
 * connection itself, as it does where an agent app runs commands with the network closed to
 * them, and that says nothing of whether It is running.
 */
type Answers = 'it' | 'another program' | 'nothing' | 'not let ask'
/**
 * Asks at an address how whatever is there is. It says that it is It: the backend's own answer
 * has that in it, and It's door passes the question on to the backend. Any other answer is
 * some other program's that has the address, however well it answers, and is never taken for
 * It. What is said by It's own door when it cannot or will not pass the question on is no other
 * program, and no running It either.
 */
async function asked(at: string): Promise<Answers> {
  let answer: Response
  try {
    answer = await direct(`${at}/health`, { signal: AbortSignal.timeout(3000) })
  } catch (err) {
    if (await keptFromIt(err)) return 'not let ask'
    // What answered otherwise than as It answers anything, or at more length than is read, is a program all the same
    return ['EPROTO', 'EMSGSIZE'].includes(String((err as { code?: unknown } | null)?.code)) ? 'another program' : 'nothing'
  }
  const said = await answer.text().catch(() => '')
  if (answer.ok && (parseJson(said) as { it?: unknown } | null)?.it === true) return 'it'
  return doorRefusal(said, at) ? 'nothing' : 'another program'
}
/** Whether It answers at an address. */
const healthy = async (at: string): Promise<boolean> => (await asked(at)) === 'it'
/**
 * What answers where It is asked whether it is running. On a machine that joined an It, or was
 * given an address, that is the address of that It. On the machine It runs on it is It's door,
 * which asks the backend program in its turn: the site is there, and a browser and another
 * machine can reach it. The backend program answering at its own port is not It running. `it
 * setup` runs that program by itself for as long as it takes, with no site in front of it and
 * nothing to get a click to an agent.
 */
async function answers(): Promise<Answers> {
  try {
    const port = elsewhere() ? undefined : basePort()
    return await asked(port === undefined ? backend().site : `http://127.0.0.1:${port}`)
  } catch {
    return 'nothing'
  }
}
/** Whether It is running, as `answers` finds it. */
const runs = async (): Promise<boolean> => (await answers()) === 'it'
/**
 * What is said on the machine It runs on when It is not running, with what to do about it.
 * Where another program answers at the port of It's site, that is what is in the way, and is
 * said: It cannot be started there while it is. Where the backend program answers all the same,
 * that is said too, since every command that only asks the backend goes on working meanwhile:
 * a setup is at work, or one was ended before it could stop the program it had started, which
 * the next setup stops.
 */
async function notRunning(found: Answers): Promise<Problem> {
  if (found === 'not let ask') return shutIn()
  const port = basePort()
  if (found === 'another program')
    return new Problem(
      `It is not running on this machine: another program answers at port ${port}, where It’s site would be.`,
      'offline',
      `Stop whatever is using that port, or choose another first port for It by setting IT_PORT. ${NOT_RUNNING}`,
    )
  return port !== undefined && (await healthy(backendAt(port).site))
    ? new Problem(
        'It is not running on this machine: only its backend program is, as it is while `it setup` is at work.',
        'offline',
        `If no setup is at work here, one was ended before it had stopped that program, and running \`it setup\` again stops it. ${NOT_RUNNING}`,
      )
    : new Problem('It is not running on this machine.', 'offline', NOT_RUNNING)
}
/** What is said on a machine that joined an It when that It does not answer where the machine asks it. */
const notAnswering = (found: Answers): string => {
  if (found === 'not let ask') return inWords(shutIn())
  const at = siteAddress() ?? 'its address'
  return found === 'another program'
    ? `What answers at ${at} is another program, and not the It this machine joined. Check on the machine It runs on that It is running, and at which address, which \`it network\` says there.`
    : `The It this machine joined does not answer at ${at}.`
}
/** A problem as one line, with what to do about it after what it is. */
const inWords = (p: Problem): string => [p.message, p.hint].filter(Boolean).join(' ')
/** Whether a connector answers on this machine, asked for a few seconds: one that was only just started needs a moment. */
async function answering(forMs = 10_000): Promise<boolean> {
  const until = Date.now() + forMs
  for (;;) {
    if (await connectorHealth()) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * An agent runs `it` by name, so the folder that holds the program, or the launcher that stands
 * for it, has to be on the PATH. The install script puts it there; a program run from anywhere
 * else has only this to say so. Nothing when the folder is on the PATH already; otherwise what
 * to do about it, with the line to add.
 */
async function pathLine(): Promise<string | undefined> {
  // The launcher is put there now if it is not there yet, so that what the line points at exists
  try {
    shim()
  } catch {}
  const bin = inHome('bin')
  const same = (dir: string) =>
    process.platform === 'win32' ? path.resolve(dir).toLowerCase() === path.resolve(bin).toLowerCase() : path.resolve(dir) === path.resolve(bin)
  if ((process.env.PATH ?? '').split(path.delimiter).some((dir) => dir !== '' && same(dir))) return undefined
  // Put there by the install script for every terminal opened from now on, it is only not on
  // the PATH this program was started with, as when an agent installs It and sets it up in
  // one conversation. Nothing is left for the person to do, and nothing is said.
  if (await onPathLater(bin)) return undefined
  if (process.platform === 'win32') return `Run this in PowerShell, then open a new terminal:\n\n  ${windowsPathCommand(bin)}`
  return `Add this line to the file your shell reads when it starts, then open a new terminal:\n\n  export PATH='${bin.replace(/'/g, `'\\''`)}':"$PATH"`
}

/**
 * Sets It up on this machine: makes it exist here where it does not yet, finds the harnesses,
 * asks which to connect, connects them, and leaves It running in the background.
 *
 * `--none` connects no harness, and takes out whatever this folder had put into one. On a
 * machine that has never been set up it is a first run like any other. Where It is set up, it
 * is the taking out and leaves the rest as it is: the background service is neither registered
 * nor started again. In a folder that only holds what a machine left behind, it is the taking
 * out and nothing more: such a folder is one a machine has left, or one that still has a note
 * of an add-on and no settings, and an It begun there would be a second one on this machine,
 * after the same ports as the person's own. The same where the backend is named by IT_URL and
 * this machine is not one of its machines.
 *
 * Which apps to connect is the person's to say: with `--all`, with `--only`, or by answering
 * for each at a terminal, which `--yes` answers for them. Where there is no terminal to ask
 * at and none of those was given, nothing is connected that was not already: what the person
 * chose before stays chosen, what is connected stays connected, and the command that connects
 * the rest is said.
 *
 * `joined` says that this machine joined an It a moment ago, with `it login`, which goes on
 * here. That is a first run on this machine whatever is to be connected: with `--none` too the
 * background service is registered unless `--no-service` says not, and the person is told
 * where the site is and what is left for them to do.
 */
/**
 * Takes It off this machine, in the order a person would do it by hand: its add-ons out of the
 * agent apps while it can still say which files were its own, then the background service,
 * then its line in the shell's profile, and last its folder, with everything it kept. Asked
 * first, in words that say what goes: the pages go with the folder, and nothing brings them back.
 */
/** PowerShell, given one thing to run, exactly as it is written. What it printed, or nothing where it could not be run or ended as a failure. */
function inPowerShell(script: string): string | undefined {
  try {
    const ran = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${service.PS_QUIET}\n${script}`, 'utf16le').toString('base64')],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    )
    return ran.status === 0 ? ran.stdout.trim() : undefined
  } catch {
    return undefined
  }
}
/** Takes a folder off the PATH Windows keeps for this account. Whether it was on it and is off now, was not on it, or could not be taken off. */
function offWindowsPath(folder: string): 'off' | 'absent' | undefined {
  const said = inPowerShell(windowsPathRemoval(folder))
  return said === 'off' || said === 'absent' ? said : undefined
}
/** Whether this command has taken It off the machine. Nothing is counted after that: the folder a count is kept in is gone, or holds only what taking an add-on out later needs. */
let takenOff = false

async function uninstall(a: Args) {
  const folder = home()
  const said: string[] = []
  const say = (line: string) => {
    said.push(line)
    if (forPerson(a)) tell([line])
  }
  // Only a folder that is It's is ever removed: one a variable names by mistake is left alone
  // Never the person's own folder, and never the whole disk, however the path to either is
  // spelled: asked of the folders themselves, since a link somewhere along the way makes the
  // same folder read as another. Where that cannot be asked, nothing is removed.
  let real: string
  let own: string
  try {
    real = realpathSync(folder)
    own = realpathSync(os.homedir())
  } catch {
    throw new Problem(`${folder} could not be looked at closely enough to be sure that It may remove it, so nothing was removed.`, 'invalid')
  }
  if (real === own || real === path.parse(real).root || path.resolve(folder) === path.resolve(os.homedir()) || path.resolve(folder) === path.parse(folder).root)
    throw new Problem(`${folder} is not a folder It may remove.`, 'invalid')
  if (!markedInstallation(folder) && !legacyInstallation(folder))
    throw new Problem(
      `${folder} does not hold It with a recognised installation record or its running installed program. Nothing was removed.`,
      'invalid',
      'For an older installation with its original license and notices, run its own bin/it with IT_HOME set to that folder, or install It there again first. Inspect an ambiguous folder and remove its files by hand.',
    )
  if (!a.flags.yes) {
    if (!flow.live())
      throw new Problem(
        'This removes It and deletes its data folders whole, and is not done without being asked for twice. Unknown top-level files remain.',
        'invalid',
        'Run `it uninstall` at a terminal, where it asks first, or `it uninstall --yes`.',
      )
    const go = await flow.pick(`Take It off this machine? Its data folders in ${folder} are deleted whole. Unknown top-level files stay.`, [
      { value: false, label: 'No, leave it' },
      { value: true, label: 'Yes, remove It' },
    ])
    if (!go) return forPerson(a) ? tell(['Nothing was changed.']) : out({ removed: false })
  }
  // Counted before anything goes, and sent from here, since the service that sends will be gone: that It was taken off, and how long it had been here, as a band
  const since = usage.sinceBegun()
  if (since !== undefined) await usage.sendNow('installation.removed', { age: usage.ageBand(since) })
  const left: string[] = []
  const program = path.join(folder, 'bin', process.platform === 'win32' ? 'it.exe' : 'it')
  let kept = false
  const heard: string[] = []
  let removing = false
  await withInstallationLock(real, async () => {
    // First of all the background service, since stopping it may be refused: where it
    // could not be stopped, nothing else is taken away, so that It is still whole and this can
    // be run again. With the program and its folder gone and the service left, there would be
    // nothing left to run.
    // The one service a machine has belongs to the It folder its definition names. One that runs
    // It from another folder is another It's, and is left as it is.
    if (service.definedFor() === 'another folder') service.passLingerToRegisteredService()
    else {
      const was = service.definedFor() === 'this folder'
      try {
        service.uninstall()
        if (was) say('The background service is stopped, and no longer starts by itself.')
      } catch (err) {
        throw new Problem(
          `It was not taken off this machine: ${err instanceof Error && err.message.trim() ? err.message.replace(/\.$/, '') : 'the background service could not be stopped or removed'}.`,
          'error',
          'Nothing else was changed, and It is as it was. Run `it uninstall` again once the service can be stopped.',
        )
      }
    }
    // 2. An `it serve` someone started by hand in this folder
    service.askToStop(folder, 30_000)
    if (service.runningFor(folder))
      throw new Problem(
        'It is still running, and no data was removed.',
        'still_running',
        'End the `it serve` you started in its terminal, then run `it uninstall` again.',
      )
    try {
      await nothingLeft(
        (line) => heard.push(line),
        async () => {
          removing = true
          if (heard.length) say('The backend program that an It which had died left running here is stopped.')
          // 1. The add-ons, each from where this folder put it. One that could not be taken out is
          // taken out by running this again, which needs the note It keeps of where it put the add-on,
          // and the program: so those are kept, and said, with how it is run once its PATH is gone
          for (const id of HARNESSES) {
            if (!installationFile(real, `addons/${id}.json`)) continue
            const gone = await disconnect(id, say, { keepLocalFiles: true }).catch(() => false)
            if (gone) say(`${KNOWN[id].label}: It’s add-on is out.`)
            else {
              kept = true
              left.push(
                `${KNOWN[id].label} still has It’s add-on, which could not be taken out. What It noted of where it put the add-on is kept in ${path.join(folder, 'addons')}, with the program: once ${KNOWN[id].label} can be run from here, run \`${program} uninstall\`${process.env.IT_HOME ? `, with IT_HOME set to ${folder} as it is now` : ''}, which takes the add-on out and removes It’s folders and recognised top-level files. Inspect any remaining files before deleting them yourself.`,
              )
            }
          }
          // 3. Its line in the shell's profile, with the comment above it
          const bin = path.join(folder, 'bin')
          const profiles = process.platform === 'win32' ? { changed: [], failed: [] } : await unlisted(bin, say)
          for (const file of profiles.changed) say(`${file}: the line that put It on your PATH is out.`)
          for (const { file, why: reason } of profiles.failed)
            left.push(
              `${file} still has the line that puts It on your PATH, and could not be changed (${reason}). Check the file and any recovery original named above, then take the It line out yourself.`,
            )
          // On Windows the folder is on the PATH the system keeps for this account, and is taken off there
          if (process.platform === 'win32') {
            const taken = offWindowsPath(bin)
            if (taken === 'off') say(`${bin} is off your PATH.`)
            else if (taken === undefined) left.push(`${bin} is still on your PATH. Take it off under “Edit environment variables for your account”.`)
          }
          // 4. What It's add-ons left in the apps' own folders that the apps do not clear away themselves
          crumbs(folder, say)
          // The rule the person wrote for Codex on It's word is theirs, and is not taken out. It is said
          // to be there, since it lets whatever is named `it` out of Codex's sandbox from now on.
          if (codexRuleLetsItOut())
            say(
              `Codex: the rule that lets \`it\` run outside Codex’s sandbox is still in Codex’s rules folder (\`${CODEX_RULE_FILE}\` is where It said to keep it). Delete it now that It is gone.`,
            )
          // 5. Whole owned folders and recognised top-level files. Windows moves the running executable out first. An add-on
          // that remains keeps the program and its ownership record so removal can be retried.
          const stepped = process.platform === 'win32' && !kept ? stepOutOf(folder) : undefined
          if (stepped && 'said' in stepped) say(stepped.said)
          else if (stepped) left.push(stepped.left)
          takenOff = true
          const settingsAt = path.join(real, 'service.json')
          const settings = existsSync(settingsAt) ? readFileSync(settingsAt, 'utf8') : undefined
          try {
            removeInstallationFiles(real, kept)
          } catch (err) {
            left.push(`${folder} could not be fully cleaned (${why(err)}). Inspect the remaining files before removing them yourself.`)
            // A partial removal can leave the backend behind. Keep the settings needed to
            // identify it when uninstall is tried again, while the shutdown lock is still held.
            if (settings !== undefined && existsSync(real) && !existsSync(settingsAt)) {
              try {
                writePrivate(settingsAt, settings)
              } catch (restore) {
                left.push(`The service settings could not be restored (${why(restore)}). Put service.json back before retrying uninstall.`)
              }
            }
          }
        },
      )
    } catch (err) {
      if (removing) throw err
      throw new Problem(
        `It could not make sure that no backend program is left running on this folder’s database: ${err instanceof Problem ? err.message : why(err)}.`,
        'still_running',
        'The folder and add-ons were kept. Resolve the running program or unreadable settings, then run `it uninstall` again.',
      )
    }
  })
  // The program and shutdown locks are released before the last empty directories are removed.
  try {
    const retained = finishInstallationRemoval(real)
    if (!retained.length && lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(folder)
    const unknown = retained.filter((name) => !kept || !['addons', 'bin', 'installation.json'].includes(name))
    if (unknown.length)
      left.push(
        `${real} still holds files It could not safely remove: ${unknown.join(', ')}. These may include page data or backups. Inspect them and remove only what you intend to erase. The folder and any link to it were kept.`,
      )
  } catch (err) {
    left.push(`${folder} could not be fully cleaned (${why(err)}). Inspect the remaining files before removing them yourself.`)
  }
  if (!forPerson(a)) return out({ removed: left.length === 0, folder, ...(left.length ? { left } : {}), said })
  tell([
    left.length ? 'Removal is incomplete:' : 'It is off this machine.',
    ...left.map((line) => `  ${line}`),
    left.some((line) => /PATH/.test(line))
      ? 'Once the PATH is as you want it, a new terminal has it: one that is open keeps the old PATH.'
      : 'A terminal that is open still has the old PATH: a new one does not.',
  ])
}

/** The line the installer writes for a folder, without asking a shell to discover its profiles again. */
function profileLine(bin: string, fish: boolean): string {
  const posix = `export PATH='${bin.replaceAll("'", `'\\''`)}':"$PATH"`
  const fishWord = `'${bin.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  const fishLine = `contains -- ${fishWord} $PATH; or set -gx PATH ${fishWord} $PATH`
  return fish ? fishLine : posix
}

/** The files a shell reads when it starts, each with the line the install script writes into it to put a folder on the PATH. */
async function profileLines(bin: string, active = false, unresolved: () => void = () => {}): Promise<Map<string, string>> {
  const shell = path.basename(process.env.SHELL || 'sh')
  const zdot = shell === 'zsh' ? await zshDirectory() : undefined
  if (shell === 'zsh' && !zdot) unresolved()
  const home = os.homedir()
  const zshFiles = [...new Set([zdot, ...(!active ? [process.env.ZDOTDIR, home] : [])])]
    .filter((d): d is string => Boolean(d))
    .map((dir) => path.join(dir, '.zshrc'))
  const login = ['.bash_profile', '.bash_login', '.profile'].find((name) => existsSync(path.join(home, name))) ?? '.profile'
  const posixFiles = active
    ? shell === 'zsh'
      ? zshFiles
      : shell === 'bash'
        ? ['.bashrc', login].map((name) => path.join(home, name))
        : shell === 'fish'
          ? []
          : [path.join(home, '.profile')]
    : [...zshFiles, ...['.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => path.join(home, name))]
  const files = new Map(posixFiles.map((file) => [file, profileLine(bin, false)]))
  if (!active || shell === 'fish')
    files.set(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'it.fish'), profileLine(bin, true))
  return files
}

/**
 * Whether a terminal opened from now on has a folder on its PATH, whatever this program's own
 * PATH holds: the install script's line for it is in a file the person's shell reads, or the
 * folder is on the PATH Windows keeps for the account.
 */
async function onPathLater(bin: string): Promise<boolean> {
  if (process.platform === 'win32') return inPowerShell(windowsPathHas(bin))?.trim() === 'on'
  for (const [file, line] of await profileLines(bin, true)) {
    try {
      if (readFileSync(file, 'utf8').split('\n').includes(line)) return true
    } catch {}
  }
  return false
}

/**
 * Takes the installer's line out of every shell profile it may have put it in, with the comment
 * and the blank line it wrote above it, and says which files it was in. A profile that held
 * nothing else is removed unless it is a link, whose target is left empty.
 */
async function unlisted(bin: string, say: (line: string) => void): Promise<{ changed: string[]; failed: { file: string; why: string }[] }> {
  const files = await profileLines(bin, false, () =>
    say('Zsh did not say which folder it reads .zshrc from. Check the .zshrc it reads and remove the It PATH line there if it remains.'),
  )
  const changed: string[] = []
  const failed: { file: string; why: string }[] = []
  for (const [file, line] of files) {
    /** The profile without the line, nothing where the line is not in it, and null where nothing else is. */
    const without = (text: string): string | null | undefined => {
      const kept: string[] = []
      let found = false
      for (const l of text.split('\n')) {
        const sameBin = () => {
          const posix = /^export PATH='(.*)':"\$PATH"$/.exec(l)
          const fish = /^contains -- '((?:\\.|[^'])*)' \$PATH; or set -gx PATH /.exec(l)
          const named = posix ? posix[1]!.replaceAll("'\\''", "'") : fish?.[1]?.replace(/\\([\\'])/g, '$1')
          if (!named || !path.isAbsolute(named) || profileLine(named, line.startsWith('contains -- ')) !== l) return false
          try {
            return realpathSync(named) === realpathSync(bin)
          } catch {
            return false
          }
        }
        if (l !== line && !sameBin()) {
          kept.push(l)
          continue
        }
        found = true
        // The comment the installer wrote above it, and the blank line above that
        if (kept.at(-1) === '# It') kept.pop()
        if (kept.at(-1) === '') kept.pop()
      }
      if (!found) return undefined
      const after = kept.join('\n')
      return after.trim() === '' ? null : after.endsWith('\n') || !text.endsWith('\n') ? after : `${after}\n`
    }
    // A profile that is not there, or cannot be read, is not known to hold the line
    try {
      readFileSync(file, 'utf8')
    } catch {
      continue
    }
    try {
      if (changeWhole(file, without, (original) => say(`The original is kept for recovery at ${original}. Review it before removing its numbered folder`)))
        changed.push(file)
    } catch (err) {
      failed.push({ file, why: (err as NodeJS.ErrnoException).code ?? (err as Error).message })
    }
  }
  return { changed, failed }
}

/**
 * What the agent apps keep of It's add-ons after their own commands have removed them, and
 * do not clear away: Codex's note that the person trusted the add-on's hooks, and the copies of
 * the add-on that Codex and Claude Code keep. Each is taken out only where it is plainly It's,
 * and a settings file that cannot be changed is left for the person to check.
 */
function crumbs(folder: string, say: (line: string) => void): void {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  // What is in the apps' folders is shared by every It folder on the machine. A copy of the
  // add-on says which It folder it was installed from: where one that an app keeps says another
  // folder than the one being taken away, that It is still using what the app keeps, and it is
  // left alone. A second It that was only tried must not take the first one's add-ons with it.
  const mine = (() => {
    try {
      return realpathSync(folder)
    } catch {
      return path.resolve(folder)
    }
  })()
  const anothers = (kept: string, depth = 0): boolean => {
    let names: string[]
    try {
      names = readdirSync(kept)
    } catch {
      return false
    }
    for (const name of names) {
      const at = path.join(kept, name)
      if (name === 'it-home.json') {
        const from = readJson<{ home?: unknown }>(at)?.home
        if (typeof from !== 'string' || !from) continue
        try {
          if (realpathSync(from) !== mine) return true
        } catch {
          // The folder it names is gone: nothing is using this copy
        }
      } else if (depth < 4 && anothers(at, depth + 1)) return true
    }
    return false
  }
  const claudeKept = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'cache', 'it')
  if (!anothers(claudeKept))
    try {
      rmSync(claudeKept, { recursive: true, force: true })
    } catch {}
  if (anothers(path.join(codexHome, 'plugins', 'cache', 'it'))) return
  try {
    // Codex saves this file itself, when the person trusts a project or a plugin's hooks, and
    // may do so while this is at work. Only an unfinished change keeps its original for recovery.
    changeWhole(
      path.join(codexHome, 'config.toml'),
      (text) => {
        // A table of its own for each hook, holding the one line that says it was trusted
        const without = withoutTables(text, (header) => /^\[hooks\.state\."it-bridge@it:[^"]*"\]/.test(header)).replace(/\n\[hooks\.state\]\n(?=\n|\[|$)/, '\n')
        return without === text ? undefined : without.replace(/\n{3,}/g, '\n\n')
      },
      (original) => say(`Codex: the original settings are kept for recovery at ${original}. Review them before removing the numbered folder`),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      say(`Codex's settings could not be cleaned up. Check its config.toml and any recovery original named above: ${(err as Error).message}`)
  }
  try {
    rmSync(path.join(codexHome, 'plugins', 'cache', 'it'), { recursive: true, force: true })
  } catch {}
  // The folders Codex made to keep It's add-on in, where nothing else is in them
  for (const dir of [path.join(codexHome, 'plugins', 'cache'), path.join(codexHome, 'plugins')]) {
    try {
      rmdirSync(dir)
    } catch {}
  }
  if (process.platform === 'linux') {
    // The folders the service's definition was written into, where nothing else is in them
    for (const dir of [
      path.join(os.homedir(), '.config', 'systemd', 'user'),
      path.join(os.homedir(), '.config', 'systemd'),
      path.join(os.homedir(), '.config'),
    ]) {
      try {
        rmdirSync(dir)
      } catch {}
    }
  }
}

/**
 * Counts that a setup came to its end: who led it (a person at a terminal, an agent in its
 * conversation, or a script), whether It was new here, joined to an It on another computer or
 * set up again, whether it is registered to run in the background, how many agent apps have
 * its add-on, and whether it was done over SSH. `was` is whether It was set up here before.
 */
function setUp(a: Args, was: boolean): void {
  try {
    const apps = HARNESSES.filter((id) => existsSync(stampFile(id))).length
    const wantedInBackground = !a.flags['no-service'] && !a.flags.none
    usage.record('setup.finished', {
      led: sessionAsked() ? 'agent' : process.stderr.isTTY ? 'person' : 'script',
      kind: was ? 'again' : elsewhere() ? 'joined' : 'new',
      service: service.installedHere() ? 'registered' : wantedInBackground ? 'failed' : 'none',
      apps: apps >= 3 ? '3 or more' : (String(apps) as '0' | '1' | '2'),
      ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
    })
  } catch {}
}

async function setup(a: Args, joined = false) {
  const only = text(a, 'only')
  if (only !== undefined && !a.flags.none) appsNamed(only)
  // Take the folder's setup lock first where one is needed, so concurrent setups keep their
  // usual waiting message and allowance. Every path checks the program before its writes.
  const current = <T>(run: () => Promise<T>) =>
    withCurrentProgram(() => {
      markInstallation(home())
      // Where this It was installed from is where it looks for newer versions.
      keepBase()
      return run()
    })

  if (a.flags.none && !enrolledHere()) {
    const leftBehind = !existsSync(settingsFile()) && (hasLeft() || holdsAddons())
    if (leftBehind || elsewhere()) {
      return oneAtATime(() =>
        current(async () => {
          await reconcile([], say)
          if (leftBehind) {
            // Noted, so that the folder is still known for what it is once its add-ons are out
            noteLeft()
            say(
              'It is not set up in this folder, which holds only what an earlier use of It left there, so nothing was started. `it setup --none` here takes out the add-ons this folder had put in. To set It up on this machine, run `it setup`.',
            )
          }
          const left = await detectAll()
          return forPerson(a) ? tell(appsSaid(left, false)) : out({ harnesses: left, wanted: [] })
        }),
      )
    }
  }
  if (elsewhere()) return oneAtATime(() => current(() => settingUp(a, joined)))
  // Where the backend is this machine's own to run, a setup makes what It needs here and may
  // run the backend for as long as the setup takes: one at a time for a folder, and not while
  // the machine is joining an It on another computer. Whether the folder is to run an It is
  // decided again once the folder is this setup's alone. A machine that has joined an It
  // meanwhile keeps the identity it joined with: nothing is set up here over it.
  return oneAtATime(() =>
    current(() => {
      const at = readJson<{ at?: string }>(inHome('machine.json'))?.at
      if (at)
        throw new Problem(
          `This machine joined the It at ${at} while this setup was waiting, so no It was set up here.`,
          'joined',
          'Run `it setup` again to connect its agent apps to that It. To have It run on this machine instead, run `it logout` first, and then `it setup`.',
        )
      return settingUp(a, joined)
    }),
  )
}

/** How long a setup waits for another that is at work in the same folder, which may itself be waiting for a person's answers. */
const SETUP_WAIT_MS = 10 * 60_000
/**
 * Runs a setup, or the joining of an It on another computer, with its folder to itself as far
 * as those two go. On the machine It runs on, a setup that finds no backend running starts the
 * program itself, and stops it when it is done. Were two at work at once, the one that started
 * the program would stop it under the other, which was still asking it. And a setup and a
 * joining at once would each decide what the folder is to be while the other was making it
 * something else. So the second waits until the first has finished, and says that it is
 * waiting, and whoever comes to have the folder looks at what it is before doing anything to
 * it. The lock is a file in It's folder, taken as the backend's is, and one left by a command
 * that was ended is taken over.
 */
async function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const until = Date.now() + SETUP_WAIT_MS
  let begun = false
  let said = false
  for (;;) {
    try {
      return await alone(
        'setup',
        () => {
          begun = true
          return run()
        },
        0,
      )
    } catch (err) {
      // Only another having the folder is waited out. What this one met once it had begun is its own to say
      if (begun || !(err instanceof Problem && err.code === 'busy')) throw err
      if (Date.now() >= until)
        throw new Problem('Another `it setup` or `it login` is still at work in this folder.', 'busy', 'Let it finish, or end it, and then run this again.')
      if (!said) say('Another `it setup` or `it login` is at work in this folder. This one goes on when that one has finished.')
      said = true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/**
 * Stops a backend program that an earlier setup left running on this folder, having been ended
 * before it could stop what it had started. Such a program answers, and would be taken for the
 * backend of an It that is running, with nothing to stop it afterwards.
 *
 * It is looked for where the backend program answers and It's door does not, which is no
 * service at work. Whoever has the folder then decides. A service that is only now starting
 * holds the folder's lock, and everything is left as it is. Where nobody holds it, the folder
 * is taken as a service takes it, which asks a program left on it to stop and waits until it
 * has, and is let go again at once.
 */
async function noneAbandoned(): Promise<void> {
  const config = readConfig()
  if (!config || !(await healthy(backendAt(config.port).site)) || (await healthy(`http://127.0.0.1:${config.port}`))) return
  try {
    await (await startBackend(config, () => {})).stop()
    say('A backend program that an earlier `it setup` had left running on this machine was stopped.')
  } catch (err) {
    if (!(err instanceof Problem && err.code === 'already_running')) throw err
  }
}

/** Whether this command was run from another computer, over SSH: a browser opened here would open on a screen nobody is at. */
const fromAfar = (): boolean => Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)

/**
 * Whether a setup is led step by step: by a person at a terminal, on the machine It runs on,
 * who is there to be asked. With `--none`, on a machine that joined an It elsewhere, or where
 * what is printed is read by a program, it goes as it always has.
 */
const led = (a: Args): boolean => forPerson(a) && flow.live() && !elsewhere() && !a.flags.none

/** Waits until a display is there that was not before, and gives its name. Nothing when the time runs out first. */
/**
 * Asks one question at a plain terminal. Where the person ends it without an answer (Ctrl-C,
 * Ctrl-D, the terminal closed), that is said as what it is and the command ends: under the
 * runtime the program is built with, the asking would otherwise never be answered, and the
 * command would stay as it was with nobody at it.
 */
function answerTo(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false
    const closed = () => {
      if (done) return
      done = true
      reject(new Problem('Setup was ended before it was finished. Nothing more was changed: run `it setup` to go on.', 'invalid'))
    }
    rl.once('close', closed)
    rl.once('SIGINT', () => {
      rl.close()
      closed()
    })
    rl.question(question).then(
      (answer) => {
        done = true
        rl.off('close', closed)
        resolve(answer)
      },
      () => closed(),
    )
  })
}

async function newDisplay(before: Set<string>, forMs: number, given?: AbortSignal): Promise<string | undefined> {
  const until = Date.now() + forMs
  while (Date.now() < until && !given?.aborted) {
    // Given up the moment the person says to: left to run out its time, it would hold the command open for that long
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, 1000)
      function done() {
        clearTimeout(t)
        given?.removeEventListener('abort', done)
        resolve()
      }
      given?.addEventListener('abort', done, { once: true })
    })
    if (given?.aborted) break
    const now = await call<{ id: string; name: string }[]>('query', api.displays.list).catch(() => [])
    const made = now.find((d) => !before.has(d.id))
    if (made) return made.name
  }
  return undefined
}

/** Checks app prerequisites before a first backend download, then reuses the result for choosing apps. */
async function setupApps(a: Args, guided: boolean): Promise<HarnessStatus[]> {
  const looking = guided ? flow.step('Agent apps', 'looking for them on this machine') : undefined
  if (!guided) say('Looking for agent apps on this machine…')
  const found = await detectAll().finally(() => looking?.clear())
  const old = found.filter((h) => h.addon === 'too_old')
  if (
    !a.flags.none &&
    !elsewhere() &&
    !existsSync(settingsFile()) &&
    !enrolledHere() &&
    old.length &&
    !found.some((h) => supported(h.id) && h.addon !== 'too_old')
  ) {
    throw new Problem(
      old.map((h) => h.detail).join('\n'),
      'invalid',
      'No backend was downloaded or set up. Update an agent app and run `it setup` again, or use `it setup --none` to set It up without connecting an app.',
    )
  }
  return found
}

/** Leads a person through setup, network access and pairing their first screen. */
async function settingUpLed(a: Args, begunAlready = false) {
  // What the parts say in sentences is kept, and said at the end where the person has to act on it
  const kept: string[] = []
  const quiet = (line: string) => void kept.push(line)
  // The name is said once: by the install script where that ran, by the question of where It is where that was asked, and else here
  if (!process.env.IT_INSTALL_FLOW && !(begunAlready && !a.flags.all && text(a, 'only') === undefined && !a.flags.yes)) flow.banner('setup')
  const found = await setupApps(a, true)
  await noneAbandoned()
  const inBackground = !a.flags['no-service']
  let at = flow.step('Backend program')
  let fetched = false
  let begun: Awaited<ReturnType<typeof begin>>
  try {
    begun = await begin({
      say: quiet,
      background: inBackground,
      name: text(a, 'name'),
      progress: (got, of) => at.say(flow.bar(got, of)),
      stage: (stage, how) => {
        if (stage === 'program') fetched = how === 'fetching'
        else if (stage === 'service') {
          at.done(fetched ? 'fetched' : 'ready')
          at = flow.step(inBackground ? 'Background service' : 'It', 'starting')
        }
      },
    })
  } catch (err) {
    at.fail(err instanceof Problem ? err.message : 'failed')
    // A person is reading: what to do about it is said under the step, in its own words, and
    // the same thing is not then printed a second time as a record for a program
    if (err instanceof Problem && err.hint) {
      flow.line()
      flow.line(err.hint)
      flow.line()
      process.exitCode = err.code === 'invalid' ? 2 : 1
      return
    }
    throw err
  }
  /** What is left for the person to do, said at the end. */
  const left: string[] = []
  let trouble = begun.trouble
  try {
    if (trouble) at.warn('not running in the background')
    else at.done(begun.own ? 'running until this setup ends' : 'running')
    const me = machine()
    flow.step('This machine').done(me.name)

    // ---------- the agent apps
    const usable = found.filter((h) => supported(h.id) && h.addon !== 'too_old')
    let wanted: Harness[]
    const only = text(a, 'only')
    if (only !== undefined) wanted = appsNamed(only)
    else if (a.flags.all || a.flags.yes) wanted = usable.map((h) => h.id)
    // Nothing is asked where there is nothing to choose: no app was found, or none that It can connect
    else if (!usable.length) wanted = []
    else {
      // On a first run every app that can be connected is ticked. Later, what was chosen before
      const before = begun.enrolled ? null : ((await call<{ wanted?: string[] } | null>('query', api.machines.me).catch(() => null))?.wanted ?? [])
      wanted = await flow.pickMany(
        'Connect your agent apps',
        found.map((h) => ({
          value: h.id,
          label: `${KNOWN[h.id].label}${h.version ? ` ${h.version}` : ''}`,
          on: before === null || before.includes(h.id) || h.addon === 'connected' || h.addon === 'needs_approval',
          no: !supported(h.id) ? 'not available yet' : h.addon === 'too_old' ? `too old: It needs ${KNOWN[h.id].min} or newer` : undefined,
        })),
      )
    }
    const apps = flow.step('Agent apps', found.length ? 'connecting' : '')
    const connectedBefore = new Set(found.filter((h) => h.addon === 'connected').map((h) => h.id))
    // The backend is told of the choice before anything is changed on this machine, as in `settingUp`
    // Asked only where an app is chosen: with none, reopening comes on for none
    const wokenBefore = wanted.length ? await wokenNow() : null
    let woken = await chosen(wanted).catch(() => null)
    await reconcile(wanted, quiet)
    woken ??= await chosen(wanted)
    const after = await detectAll()
    await call('mutation', api.machines.inventory, { harnesses: after })
    const on = after.filter((h) => h.addon === 'connected' || h.addon === 'needs_approval')
    const failed = after.filter((h) => wanted.includes(h.id) && h.addon !== 'connected' && h.addon !== 'needs_approval')
    if (!usable.length) apps.warn(found.length ? 'none found that It can connect yet' : 'none found on this machine')
    else if (failed.length) apps.warn(`${on.map((h) => KNOWN[h.id].label).join(', ') || 'none'} connected`)
    else apps.done(on.length ? on.map((h) => KNOWN[h.id].label).join(', ') : 'none connected')
    for (const h of failed) {
      // Why, as the connecting itself said it: looked at afresh, an app that could not be connected only says that it is not
      const said = kept.findLast((line) => line.startsWith(`${KNOWN[h.id].label}: `))?.slice(KNOWN[h.id].label.length + 2)
      const why = h.detail ?? said
      left.push(`${KNOWN[h.id].label} could not be connected${why ? `: ${why.replace(/\.$/, '')}.` : '.'}`)
    }
    // What decides whether Codex's first page appears at all is said by itself, and first
    const shut = codexShut(after)
    if (shut) left.push(shut)
    // That reopening came on with this setup, said once: not again each time setup is run
    const waking = wakesSaid(cameOn(woken, wokenBefore, connectedBefore).filter((id) => on.some((h) => h.id === id)))
    if (waking) left.push(waking)
    for (const h of after) {
      if (h.addon === 'needs_approval' && h.detail) left.push(`${KNOWN[h.id].label}: ${h.detail}`)
      else if (h.addon === 'connected' && wanted.includes(h.id) && AFTER[h.id] && !connectedBefore.has(h.id)) left.push(`${KNOWN[h.id].label}: ${AFTER[h.id]}`)
      // An app that was found and whose add-on is held back is named, with how to ask for it: left unsaid, its user is told that no app was found
      else if (h.addon === 'unavailable' && h.detail && whyHeldBack(h.id)) left.push(`${KNOWN[h.id].label}: ${h.detail}`)
      // And one that is too old for It is named with the version It needs and what to do. The
      // list to choose from says as much of it, and is not shown where no app can be connected:
      // someone whose only agent app is too old was told that none was found that It can connect, and no more
      else if (h.addon === 'too_old' && h.detail) left.push(`${KNOWN[h.id].label}: ${h.detail}`)
    }

    // Registered is not yet running. The connector itself is asked, and given a little while to answer
    if (inBackground && !trouble && !(await answering()))
      trouble = 'It was registered as a background service, but it is not answering. Run `it service logs` to read why.'
    // Not registered, and running all the same: the person started `it serve` themselves, in
    // another terminal, as a machine with no service manager has them do. It is there to be
    // reached, and is not said to be stopped.
    const byHand = !begun.own && !!trouble && (await answering(1500))
    if (trouble) left.push(byHand ? `${trouble}\nIt is running now, from the \`it serve\` you started yourself, and stops when that does.` : trouble)
    if (begun.background && 'note' in begun.background && begun.background.note) left.push(begun.background.note)
    // Whether It goes on running once this setup has ended. Where it does not, the ending says
    // so and says what to run, in place of saying that It is ready.
    const stays = !begun.own && (!trouble || byHand)

    // ---------- how It is reached, and the first screen: only where It goes on running to be reached
    const config = readConfig()
    if (config && stays) {
      const tail = tailnetAddresses()
      const home = reachable(config.port)[0]
      // Run from another computer, the likeliest wish is to reach It from there, and that is what
      // is offered first: over the tailnet where there is one, and else over the home network.
      // Not on a machine with a public address, such as a rented server: there "the network"
      // is the internet, over plain http, and nobody is to open It to that by pressing Enter.
      const open = onTheInternet()
      const start = config.network ? (config.tailnet ? 2 : 1) : fromAfar() ? (tail.length ? 2 : open ? 0 : 1) : 0
      const reach = await flow.pick<'off' | 'on' | 'tailscale'>(
        'How will you reach It?',
        [
          { value: 'off', label: 'From this computer only', hint: `localhost:${config.port}` },
          open
            ? { value: 'on', label: 'From any network, the internet included', hint: `this machine ${open.why}, and It answers over plain http` }
            : { value: 'on', label: 'From my home network', hint: home ? new URL(home).host : undefined },
          { value: 'tailscale', label: 'Over Tailscale', hint: tailnetName() ?? tail[0], no: tail.length ? undefined : 'not found on this machine' },
        ],
        start,
      )
      const net = flow.step('Network', 'opening')
      try {
        await turnNetwork(config, true, reach !== 'off', reach === 'tailscale')
        net.done(
          reach === 'off'
            ? 'this computer only'
            : reach === 'tailscale'
              ? 'your tailnet only'
              : open
                ? 'every network this machine is on, the internet included'
                : 'your home network',
        )
      } catch (err) {
        net.warn('this computer only')
        left.push(err instanceof Problem ? inWords(err) : String(err))
      }
      const addresses = readConfig()?.network ? reachable(config.port, undefined, reach === 'tailscale') : []

      const displays = await call<{ id: string; name: string; paired?: boolean }[]>('query', api.displays.list).catch(() => [])
      if (displays.some((d) => d.paired !== false)) {
        const screens = displays.filter((d) => d.paired !== false)
        flow.step('Screens').done(screens.length === 1 ? screens[0]!.name : `${screens.length} paired`)
      } else {
        const { code } = await call<{ code: string }>('mutation', api.sessions.inviteOwner)
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) throw new Problem('It answered with something that is no invite.', 'error')
        const here = `http://localhost:${config.port}/pair#${code}`
        const opened = !fromAfar() && openBrowser(here)
        flow.line()
        if (opened) flow.line(`${flow.bold('Your browser is opening It.')} ${flow.dim('If it does not, open:')}`)
        else flow.line(flow.bold(addresses.length ? 'Open this on the screen you want to use:' : 'Open this in a browser on this computer:'))
        flow.line()
        const there = addresses.map((address) => `${address}/pair#${code}`)
        flow.line(`  ${opened || !there.length ? here : there[0]}`)
        if (!opened && there.length) {
          flow.line()
          for (const row of flow.qr(there[0]!)) flow.line(`  ${row}`)
          for (const other of there.slice(1, 3)) flow.line(`  ${flow.dim(`or ${other}`)}`)
        }
        flow.line()
        const screen = flow.step('First screen', 'waiting for a browser to pair · enter to skip')
        const skipped = new AbortController()
        const paired = await flow.unlessEnter(newDisplay(new Set(displays.map((d) => d.id)), 10 * 60_000, skipped.signal)).finally(() => skipped.abort())
        if (paired) screen.done(paired)
        else screen.warn('not paired yet')
        if (!paired) left.push('No screen is paired yet. `it site` prints a new address to open.')
      }
    }

    const add = await pathLine()
    if (add) left.push(`\`it\` is not on your PATH yet, so an agent that runs it by name will not find it. ${add}`)
    flow.line()
    if (left.length) {
      flow.line(flow.bold('Left for you'))
      for (const said of left) for (const [i, row] of said.split('\n').entries()) flow.line(`${i === 0 ? flow.yellow('!') : ' '} ${row}`)
      flow.line()
    }
    // The terminal the install script ran in has no `it` on its PATH yet, so a command given
    // there is given with its whole path: typed as `it`, it would not be found
    // In PowerShell a program named by its path in quotation marks is run with `&` before it, and a quotation mark inside is written twice
    const byPath = process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}'` : `'${process.execPath.replace(/'/g, `'\\''`)}'`
    const it = process.env.IT_INSTALL_FLOW ? byPath : 'it'
    if (!stays) {
      flow.line(`${flow.bold('It is set up, and it is not running.')} Nothing starts it by itself on this machine, so two things are yours to do:`)
      flow.line()
      flow.line(`  1. Start it, and leave it running:      ${flow.green(`${it} serve`)}`)
      flow.line(`  2. In another terminal, open its site:  ${flow.green(`${it} site`)}`)
      flow.line()
      flow.line(
        on.length
          ? `Then say this to your agent:  ${flow.green('Give me the It tour.')}`
          : 'No agent app is connected: `it skill` prints what to give any agent, and `it setup` connects one later.',
      )
    } else if (on.length) {
      flow.line(`${flow.bold('It is ready.')} Say this to your agent:`)
      flow.line()
      flow.line(`  ${flow.green('Give me the It tour.')}`)
    } else flow.line(`${flow.bold('It is ready.')} No agent app is connected: \`it skill\` prints what to give any agent, and \`it setup\` connects one later.`)
    flow.line()
    // The terminal the install script ran in was open before `it` was on its PATH, and a person
    // who types `it` there next is told that there is no such command
    if (stays && process.env.IT_INSTALL_FLOW && process.env.IT_INSTALL_ON_PATH === '0') {
      flow.line(flow.dim('To type `it` yourself, open a new terminal: this one was open before `it` was on your PATH.'))
      flow.line()
    }
    if (trouble) process.exitCode = 1
  } finally {
    await begun.done()
  }
}

/**
 * A first setup at a terminal begins by asking where the person's It is: on this computer, or
 * on another of theirs, which this one then joins. Someone with It on one computer who
 * installs it on a second would otherwise be given a second It, when what they wanted was
 * their agents here on the screens they have. Joining takes the line that the other
 * computer's site gives under Machines, "Add a machine", pasted here: the invite is made
 * there, by the person, and nowhere else. True once this machine has joined.
 */
async function joinedInstead(a: Args): Promise<boolean> {
  // Asked only where nothing is here yet, and of a person who has not already said what they want set up
  if (existsSync(settingsFile()) || enrolledHere() || a.flags.all || text(a, 'only') !== undefined || a.flags.yes) return false
  if (!process.env.IT_INSTALL_FLOW) flow.banner('setup')
  const where = await flow.pick<'here' | 'join'>('Where is your It?', [
    { value: 'here', label: 'On this computer', hint: 'set it up here' },
    { value: 'join', label: 'On another computer of mine', hint: 'join that one, and use it from here' },
  ])
  if (where === 'here') return false
  flow.line(`${flow.green('✓')} ${'Joining'.padEnd(20)} ${flow.dim('the It on another computer')}`)
  flow.line()
  flow.line('On that computer, open It’s site, go to Machines and press Add a machine.')
  flow.line('Paste the line it gives you here, and press Enter.')
  flow.line()
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (;;) {
      const pasted = (await answerTo(rl, '  › ')).trim()
      // Nothing pasted is a change of mind: It is set up here after all
      if (!pasted) return false
      const asked = joinLine(pasted)
      if (!asked) {
        flow.line()
        flow.line(flow.yellow('That has no address and invite in it. The line begins with `it login` or with `curl`, and holds --url and --code.'))
        flow.line(flow.dim('Paste it again, or press Enter alone to set It up on this computer.'))
        flow.line()
        continue
      }
      try {
        // The folder is this setup's alone already, which is what a joining asks for
        const done = await login(asked)
        flow.line()
        flow.line(`${flow.green('✓')} ${'Joined'.padEnd(20)} ${flow.dim(`as “${done.name}”`)}`)
        if (done.waitsFor !== undefined) flow.line(flow.dim(joinedBefore(done.waitsFor)))
        return true
      } catch (err) {
        if (!(err instanceof Problem)) throw err
        flow.line()
        flow.line(flow.yellow(err.message))
        if (err.hint) flow.line(flow.dim(err.hint))
        flow.line(flow.dim('Paste a line again, or press Enter alone to set It up on this computer.'))
        flow.line()
      }
    }
  } finally {
    rl.close()
  }
}

/**
 * The agent apps that `--only` names. A name It does not know is refused, and so is an app
 * whose add-on is held back and that nobody has asked for: in words, with nothing changed.
 * Carried on with, such a setup would connect nothing and take out every app that was not
 * named, the one asked for among them.
 */
function appsNamed(only: string): Harness[] {
  const wanted = only
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean) as Harness[]
  const bad = wanted.filter((id) => !(HARNESSES as readonly string[]).includes(id))
  if (bad.length) throw new Problem(`Not an agent app It knows: ${bad.join(', ')}`, 'invalid', `It knows: ${HARNESSES.join(', ')}`)
  const held = wanted.map((id) => whyHeldBack(id)).find((why) => why !== undefined)
  if (held) throw new Problem(held, 'invalid')
  return wanted
}

/** The whole of a setup, once it is known that something is to be set up here: see `setup`. */
async function settingUp(a: Args, joined: boolean) {
  // What `--only` names is looked at before anything is begun. A first run fetches the backend
  // program, makes this machine's settings and starts It, and one that was then refused for
  // what it was asked to connect would have done all of that and changed what it said it had not.
  const only = text(a, 'only')
  if (only !== undefined && !a.flags.none) appsNamed(only)
  // Said already by the question of where It is, where that was asked
  const asked = !joined && led(a) && !existsSync(settingsFile()) && !enrolledHere()
  if (asked && (await joinedInstead(a))) return settingUp(a, true)
  if (!joined && led(a)) return settingUpLed(a, asked)
  // Where It is set up already, `--none` leaves the background service as it is, registered or
  // not. A machine that has only just joined is not set up yet, though it has its identity
  const leaves = a.flags.none === true && !joined && enrolledHere() && (elsewhere() || existsSync(settingsFile()))
  const inBackground = !a.flags['no-service'] && !leaves
  // --none needs no app prerequisite. Its inventory is read once the backend is ready.
  const beforeSetup = a.flags.none ? undefined : await setupApps(a, false)
  if (!elsewhere()) await noneAbandoned()
  // Where the backend is not this machine's to run, there is nothing to make here, and the
  // background service is the connector alone
  const begun = elsewhere() ? undefined : await begin({ say, background: inBackground, name: text(a, 'name') })
  try {
    machine()
    // The key just made is in It's folder. In a person's own profile that is theirs alone. A
    // folder they named instead is as private as they made it, on Windows, where a file has
    // its folder's permissions and this program cannot give it others.
    if (begun?.enrolled && process.platform === 'win32' && process.env.IT_HOME)
      say(`This machine's key is kept in ${home()}. Windows lets whoever can open that folder read it, so make sure nobody but you can.`)
    const found = beforeSetup ?? (await setupApps(a, false))
    const usable = found.filter((h) => supported(h.id) && h.addon !== 'too_old')
    for (const h of found)
      say(
        `  ${KNOWN[h.id].label} ${h.version ?? ''}${supported(h.id) ? '' : ' (found, but It cannot connect to it yet)'}${h.addon === 'too_old' ? ` (${h.detail})` : ''}`,
      )
    if (!found.length)
      say(
        '  None was found. Any agent can still use `it` to make pages and `it wait` to hear what is done on them, and `it skill` prints the instructions to give it.',
      )

    let wanted: Harness[]
    /** What is said of the apps that were found and left unconnected because nobody was there to be asked. */
    let unasked: string | undefined
    if (a.flags.none) wanted = []
    else if (only !== undefined) wanted = appsNamed(only)
    else if (a.flags.all || a.flags.yes) wanted = usable.map((h) => h.id)
    else if (!process.stdin.isTTY) {
      // Nobody is here to be asked. What the person chose before stays chosen, and what is
      // connected stays connected: It is asked first, so that nothing is changed where it cannot be
      const chosen = (await call<{ wanted?: string[] } | null>('query', api.machines.me))?.wanted ?? []
      const connected = found.filter((h) => h.addon === 'connected' || h.addon === 'needs_approval').map((h) => h.id)
      wanted = [...new Set([...chosen, ...connected])].filter((id): id is Harness => (HARNESSES as readonly string[]).includes(id))
      const left = usable.filter((h) => !wanted.includes(h.id))
      if (left.length) {
        unasked = `There is no terminal here to ask at, so ${left.length === 1 ? `${KNOWN[left[0]!.id].label} was not connected` : 'none of them was connected that was not connected already'}. Run \`it setup --all\` to connect every agent app that was found, or \`it setup --only ${left.map((h) => h.id).join(',')}\` to connect the ${left.length === 1 ? 'one' : 'ones'} named.`
        say(unasked)
      }
    } else {
      wanted = []
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      for (const h of usable) {
        const answer = (await answerTo(rl, `Connect ${KNOWN[h.id].label}? [Y/n] `)).trim().toLowerCase()
        if (answer === '' || answer.startsWith('y')) wanted.push(h.id)
      }
      rl.close()
    }
    const before = new Set(found.filter((h) => h.addon === 'connected').map((h) => h.id))
    // The backend is told of the choice before anything is changed on this machine, where it
    // can be told: a service that is running follows the choice as the backend has it, and
    // would otherwise take out again, by the choice from before, what is being connected here.
    // Where the backend cannot be reached, what is on this machine is put right all the same,
    // so that an add-on the person chose to remove is removed, and the failure is said after
    // Asked only where an app is chosen: with none, reopening comes on for none
    const wokenBefore = wanted.length ? await wokenNow() : null
    let woken = await chosen(wanted).catch(() => null)
    await reconcile(wanted, say)
    woken ??= await chosen(wanted)
    const after = await detectAll()
    // The site is told what was found, and no more than that. Whether this machine can hear a
    // click is the connector's to say, once one is running: said from here, the site would show
    // the machine as online before anything was there to deliver.
    await call('mutation', api.machines.inventory, { harnesses: after })

    // Left as it was, the service is said as it is. Left out, it is said to be that
    let background: service.ServiceStatus | { registered: false; state: string } =
      begun?.background ?? (leaves && !a.flags['no-service'] ? service.status() : { registered: false, state: 'not installed' })
    // Why It is not running in the background, when it was wanted there
    let trouble = begun?.trouble
    if (inBackground) {
      if (!begun) {
        try {
          background = service.install()
        } catch (err) {
          trouble = `It could not be registered as a background service: ${(err as Error).message}`
        }
      }
      // Registered is not yet running. The connector itself is asked, and given a little while to answer.
      if (!trouble) {
        if (await answering()) say(`It runs in the background (${background.state}).`)
        else trouble = 'It was registered as a background service, but it is not answering. Run `it service logs` to read why.'
      }
      if (trouble) {
        say(trouble)
        // Started by hand in another terminal, it is running: said as that, and not as stopped
        if (await answering(1500)) say('It is running now, from an `it serve` that was started by hand, and stops when that does.')
        else say('Until It runs on this machine, nothing done on a page reaches an agent here. Run `it serve` yourself to keep it going.')
      }
      // What the system would not do for the service is said here as well, where a person at a terminal reads it: that It stops when they log out, say
      if ('note' in background && background.note) say(background.note)
    }
    // A person is told in a sentence for each app what the JSON says of them to a program, before what is left for them to do
    if (forPerson(a)) tell(appsSaid(after, false, false))
    // What the person still has to do themselves, for each harness that was just connected.
    // What decides whether Codex's first page appears at all is said by itself, and first.
    const shut = codexShut(after)
    if (shut) say(`\n${shut}`)
    // That reopening came on with this setup, said once: not again each time setup is run
    const waking = wakesSaid(
      cameOn(woken, wokenBefore, before).filter((id) => after.some((h) => h.id === id && (h.addon === 'connected' || h.addon === 'needs_approval'))),
    )
    if (waking) say(`\n${waking}`)
    for (const h of after) {
      if (h.addon === 'needs_approval') say(`\n${KNOWN[h.id].label}: ${h.detail}`)
      else if (h.addon === 'connected' && wanted.includes(h.id) && AFTER[h.id] && !before.has(h.id)) say(`\n${KNOWN[h.id].label}: ${AFTER[h.id]}`)
    }
    // The things left for the person to do, unless everything was just taken out again from
    // an It that was already here
    if (!a.flags.none || begun?.enrolled || joined) {
      const add = await pathLine()
      if (add) say(`\n\`it\` is not on your PATH yet, so an agent that runs it by name will not find it. ${add}`)
      // Run from here only for as long as setup took, It stops with it
      if (begun?.own) say('\nIt is not running in the background. Run `it serve`, in a terminal or under a supervisor of your own, to keep it going.')
      // On a machine that has just joined, nothing of It runs until its service does, which here is what gets a click to an agent
      if (joined && !inBackground)
        say(
          '\nIt is not running in the background on this machine. Run `it serve` here, in a terminal or under a supervisor of your own, so that what is done on a page reaches the agents on this machine.',
        )
      // A page is shown on a display, and a display is a browser with the site open: said
      // last, since nothing so far has sent the person to the site
      const site = siteAddress()
      say(
        site
          ? `\nIt’s site is at ${site}. No browser is let in until it is paired: \`it site\` opens the site in a browser on this machine and pairs that browser, and \`it site --no-open\` prints the link that does.`
          : `\nNo browser is let in to It’s site until it is paired: \`it site\` opens the site in a browser on this machine and pairs that browser, and \`it site --no-open\` prints the link that does.`,
      )
    }
    if (!forPerson(a))
      out({
        harnesses: after,
        service: background,
        ...(trouble ? { problem: trouble } : {}),
        ...(unasked ? { hint: unasked } : {}),
        // An agent that is installing It reads this whole, whatever it was given of the guide.
        // Said once an agent app is connected: until then the hint above is what comes next
        ...(after.some((h) => h.addon === 'connected' || h.addon === 'needs_approval') ? { next: AFTER_SETUP } : {}),
      })
    // Setup that leaves It not running where it was wanted has not done what it was asked, and ends by saying so
    if (trouble) process.exitCode = 1
  } finally {
    await begun?.done()
  }
}

// ---------- the home network ----------

/** How long the running service is given to open its door anew. It looks at the settings every second. */
const TAKEN_MS = 20_000

/** Whether the network is on in this machine's settings, and where another device then reaches It. Off, with no address, on a machine that only joined an It. */
function networkNow(): { on: boolean; addresses: string[]; tailnet?: true; unable?: true } {
  try {
    const config = elsewhere() ? null : readConfig()
    const on = config?.network ?? false
    // Kept to the tailnet, the door answers at this machine's addresses there and at no other:
    // an address on the home network would be one that nothing opens
    return {
      on,
      addresses: on && config ? reachable(config.port, undefined, config.tailnet === true) : [],
      ...(on && config?.tailnet === true ? { tailnet: true } : {}),
    }
  } catch {
    // Settings that cannot be read say nothing of the network, and `it status` still says the rest
    return { on: false, addresses: [] }
  }
}

/**
 * The network as it stands, and not only as the settings ask for it: a service that was to
 * listen on the network and could not answers this machine only, whatever its settings say,
 * and to say that the network is on would send the person to addresses that nothing answers at.
 */
async function networkAsItStands(running: boolean): Promise<ReturnType<typeof networkNow>> {
  const asked = networkNow()
  if (!asked.on || !running || elsewhere()) return asked
  try {
    const config = readConfig()
    const stands = config ? await doorStands(config) : undefined
    if (stands?.wanted && !stands.on) return { on: false, addresses: [], unable: true }
  } catch {}
  return asked
}

/**
 * How the service's door stands, and what its settings had asked for when it said so, as the
 * service last told the backend. Nothing when the backend cannot be asked. Whether a service
 * is running now to have said it is not told by this, and is asked at the door. The command
 * asks as the service itself does, with the key in It's settings, so that it needs nothing of
 * this machine's enrolment.
 */
async function doorStands(config: { port: number; adminKey: string }): Promise<{ on: boolean; wanted: boolean; tailnet?: boolean } | undefined> {
  const said = (await asAdmin({ api: backendAt(config.port).api, adminKey: config.adminKey }, 'network:current', {}).catch(() => undefined)) as
    | { on?: unknown; wanted?: unknown; tailnet?: unknown }
    | undefined
  return typeof said?.on === 'boolean' && typeof said.wanted === 'boolean'
    ? { on: said.on, wanted: said.wanted, ...(typeof said.tailnet === 'boolean' ? { tailnet: said.tailnet } : {}) }
    : undefined
}

/**
 * Writes whether the network is to be on, and for the tailnet alone, and waits until the service
 * that is running has done as the setting says. With no service running the setting is all
 * there is, and it takes effect when one starts. Where the service could not listen on the
 * network, the network is left off and that is the problem said.
 */
async function turnNetwork(
  config: { port: number; adminKey: string; network: boolean; tailnet?: boolean },
  running: boolean,
  on: boolean,
  tailnet: boolean,
): Promise<void> {
  /**
   * Waits until the running service has looked at a setting and said so, and gives how its
   * door then stands. Nothing when no service is running to be waited for.
   */
  const taken = async (setting: boolean, policy?: boolean) => {
    if (!running) return undefined
    const until = Date.now() + TAKEN_MS
    let stands = await doorStands(config)
    while (
      stands !== undefined &&
      (stands.wanted !== setting ||
        (!setting && stands.on) ||
        (setting && stands.on && policy !== undefined && stands.tailnet !== undefined && stands.tailnet !== policy)) &&
      Date.now() < until
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      stands = await doorStands(config)
    }
    return stands
  }
  // What the service last said may be a moment behind the settings as they are: it is let catch up first
  let stands = await taken(config.network)
  // A service that was to listen on the network and could not is asked afresh, and not taken at its last word
  if (on && stands?.wanted && !stands.on) {
    noteNetwork(false)
    stands = await taken(false)
  }
  noteNetwork(on, tailnet)
  // The service that is running takes it by itself. With none running there is nothing to wait for.
  stands = await taken(on, tailnet)
  if (stands !== undefined && (stands.wanted !== on || (!on && stands.on) || (on && stands.on && stands.tailnet !== undefined && stands.tailnet !== tailnet)))
    throw new Problem(
      `The network is turned ${on ? 'on' : 'off'} in It’s settings, and the service that is running has not taken that.`,
      'not_taken',
      'Stop It and start it again. `it service logs` says what the service met.',
    )
  if (stands !== undefined && stands.on !== on) {
    // Asked to listen on the network, the service could not. Left on in the settings, it would try the same each time it started
    noteNetwork(false)
    await taken(false)
    throw new Problem(
      'It could not listen on this machine’s network addresses, so the network is left off.',
      'cannot_listen',
      'Another program may have one of the ports It listens on, on one of those addresses. `it service logs` says what the service met.',
    )
  }
  if (running && (stands === undefined || (on && stands.tailnet === undefined)))
    throw new Problem(
      'The network setting was saved, but It could not confirm that the service applied it.',
      'not_confirmed',
      stands === undefined
        ? 'The service could not be asked how its door stands. Check `it service logs` and try again.'
        : 'The backend functions do not report the applied network policy. Run `it status` on this machine to check whether older functions are still running.',
    )
}

/** What is said where the tailnet is asked for on a machine that is on none. */
const noTailnet = () =>
  new Problem(
    'This machine is on no tailnet, so there is none to keep It to.',
    'no_tailnet',
    'Install Tailscale on this machine and sign in to it, and run this again. `it network on` opens It to every network this machine is on instead.',
  )

/**
 * `it network on` and `it network off` say whether It answers the person's other devices, and
 * `it network tailscale` that it answers them on their tailnet alone. `it network` says which it
 * is. The setting is written and the running service opens its door anew by itself, within a
 * second or two: the command waits until the service has done as the setting says, and says so
 * if it could not.
 */
async function network(a: Args) {
  const to = a._[0]
  if (to !== undefined && to !== 'on' && to !== 'off' && to !== 'tailscale')
    throw new Problem('It is `it network`, `it network on`, `it network tailscale` or `it network off`.', 'invalid')
  if (!existsSync(settingsFile()) || elsewhere()) {
    if (enrolledHere() && elsewhere())
      throw new Problem(
        'This machine joined an It that runs on another machine, and has no network of It’s own to turn on.',
        'invalid',
        'Run `it network` on the machine It runs on.',
      )
    throw notSetUp()
  }
  const config = readConfig()!
  const on = to === undefined ? config.network : to !== 'off'
  const tailnet = on && (to === undefined ? config.tailnet === true : to === 'tailscale')
  if (to === 'tailscale' && !tailnetAddresses().length) throw noTailnet()
  // Whether a service is running, to take the setting or to be asked how its door stands, is
  // whether It's door answers. What the backend was last told of the door does not say: the
  // backend program may be running by itself, with what a service told it before it stopped.
  const running = await runs()
  if (to !== undefined) await turnNetwork(config, running, on, tailnet)
  // Asked only how things stand: a service that was to listen on the network and could not is said as it is
  if (to === undefined && on && running) {
    const stands = await doorStands(config)
    if (stands?.wanted && !stands.on) {
      const could =
        'The network is turned on in It’s settings, and It could not listen on this machine’s network addresses, so it answers this machine only. Another program may have one of the ports It listens on. `it service logs` says what the service met.'
      if (forPerson(a)) return tell([could])
      say(could)
      return out({ network: false, addresses: [] })
    }
  }
  const addresses = on ? reachable(config.port, undefined, tailnet) : []
  const said = !on
    ? 'The network is off. It answers this machine only.'
    : addresses.length === 0
      ? tailnet
        ? 'The network is on, for your tailnet only, but this machine has no address there just now.'
        : 'The network is on, but this machine has no address on a network just now.'
      : tailnet
        ? 'The network is on, for your tailnet only. Your devices on it can open It at:'
        : 'The network is on. Devices on the same network can open It at:'
  // With no service running the setting is all there is: nothing listens anywhere until It starts
  const later = running ? undefined : 'It is not running on this machine at the moment, so this takes effect when it starts.'
  // Open to every network, on a machine that the internet can reach: said in so many words, each time it is asked
  const open = on && !tailnet ? onTheInternet() : undefined
  const toAll = open
    ? `This machine ${open.why}, so It can be reached from the internet, over plain http: anyone can open the pairing screen, and what your paired devices send can be read on the way. \`it network tailscale\` keeps It to your tailnet, and \`it network off\` to this machine.`
    : undefined
  // To a person the sentence is what is printed, with the addresses under it. Anywhere else it is said beside the JSON
  if (forPerson(a)) return tell([said, ...addresses.map((address) => `  ${address}`), toAll, later])
  say(addresses.length ? `${said} ${addresses.join(', ')}` : said)
  if (toAll) say(toAll)
  if (later) say(later)
  return out({ network: on, ...(tailnet ? { tailnet: true } : {}), addresses, ...(open ? { public: open.address ?? true } : {}) })
}

/**
 * How things stand on this machine: whether It is running, whether this machine is one of the
 * person's, where the site is and whether the network is on, and which agent apps are
 * connected. Whether the machine is enrolled is read from what is on this machine, so that it
 * is said truly when It is not running to be asked. What is wrong, when something is, is said
 * in `hint` as what to do next.
 */
async function status(a: Args) {
  const kept = readJson<{ id?: unknown; name?: unknown; at?: string }>(inHome('machine.json'))
  const enrolled = enrolledHere()
  const here = existsSync(settingsFile()) && !elsewhere()
  if (!enrolled && !here)
    return forPerson(a) ? tell(['It is not set up on this machine. Run `it setup`.']) : out({ running: false, enrolled: false, hint: 'Run `it setup`.' })
  const found = await answers()
  const running = found === 'it'
  let machine: Record<string, unknown> | null = enrolled ? { id: kept?.id ?? null, name: kept?.name ?? null } : null
  let hint: string | undefined
  /** Whether It, asked, would not say that this machine is one of its machines. */
  let refused = false
  if (!running) hint = here ? inWords(await notRunning(found)) : notAnswering(found)
  else if (!enrolled) hint = 'Run `it setup` to enrol this machine.'
  else {
    // What It says of this machine, which it may have stopped knowing
    try {
      machine = await call<{ id: string; name: string; wanted: string[] }>('query', api.machines.me)
    } catch (err) {
      // Refused as nobody, it is a machine It has stopped knowing, whatever words the refusal came in
      hint = inWords((err as Problem).code === 'unauthenticated' ? notKnown({ at: kept?.at }) : (err as Problem))
      refused = true
    }
  }
  // How the data stands, on the machine that keeps it. Where the functions of this version of
  // It could not be put onto it, the ones that were there go on serving, and while It runs that
  // is said before anything else
  const database = here ? standing() : null
  if (database?.behind && running)
    hint =
      database.behind.why === 'refused'
        ? 'The data here does not fit the backend functions of this version of It, so the ones from the version before go on serving, with the rest of It as this version. Nothing was lost.'
        : 'A copy of the data could not be made, so the backend functions of this version of It were not put onto it, and the ones from the version before go on serving. Make room on the disk and start It again.'
  // Run where it may not open a connection, this command cannot see whether It is running at
  // all. That is said first and as not known: answered "not running", an agent takes It for
  // stopped, and says so to its person or tries to start it.
  const blocked = found === 'not let ask'
  const learned = (machine as { latest?: unknown } | null | undefined)?.latest
  const newerOut = typeof learned === 'string' && newer(learned, VERSION) ? learned : null
  const connector = blocked ? { running: null } : ((await connectorHealth()) ?? { running: false })
  const runtimes = connector.addons as Record<string, HarnessStatus['runtime']> | undefined
  const stands = {
    ...(blocked ? { blocked: true, hint } : {}),
    running: blocked ? null : running,
    enrolled,
    machine,
    site: siteAddress() ?? null,
    network: await networkAsItStands(running && !blocked),
    ...(database ? { database } : {}),
    connector,
    background: service.status(),
    harnesses: (await detectAll()).map((h) => ({ ...h, ...(runtimes?.[h.id] ? { runtime: runtimes[h.id] } : {}) })),
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    // A newer version that this machine has learned is out, where it looks for one
    ...(newerOut ? { update: { latest: newerOut, how: 'Run `it upgrade`.' } } : {}),
    ...(hint && !blocked ? { hint } : {}),
  }
  if (!forPerson(a)) return out(stands)
  // To a person: what is wrong and what to do about it first, then whether It is running and
  // where its site is, whether this machine is enrolled, the network, the agent apps, and
  // whether It starts by itself
  const { site, network } = stands
  const name = typeof machine?.name === 'string' ? machine.name : undefined
  const [first, ...others] = network.addresses
  tell([
    // Running and not enrolled, the one thing to do is to enrol it
    running && !enrolled ? 'This machine is not enrolled. Run `it setup` to enrol it.' : hint,
    running
      ? `${here ? 'It is running on this machine' : 'The It this machine joined is running'}${site ? `, and its site is at ${site}` : ''}.`
      : // Where another program has the site's port, what was said first is all there is to say of the site
        here && site && found !== 'another program'
        ? `Its site is at ${site} while it runs.`
        : undefined,
    // Said as it is on this machine, unless It has just said otherwise, which the first line then says
    refused ? undefined : enrolled ? `This machine is enrolled${name ? ` as “${name}”` : ''}.` : running ? undefined : 'This machine is not enrolled.',
    !here
      ? undefined
      : network.unable
        ? 'The network is turned on in It’s settings, and It could not listen on this machine’s network addresses, so it answers this machine only. Another program may have one of the ports It listens on. `it service logs` says what the service met.'
        : !network.on
          ? 'The network is off, so It answers this machine only. `it network on` lets your other devices on the same network reach it.'
          : first === undefined
            ? 'The network is on, and this machine has no address on a network just now.'
            : network.tailnet
              ? `The network is on, for your tailnet only. Your devices on it open the site at ${first}.${others.length ? ` This machine’s other addresses there are ${others.join(' and ')}.` : ''}`
              : `The network is on. Other devices on the same network open the site at ${first}.${others.length ? ` This machine’s other addresses are ${others.join(' and ')}.` : ''}`,
    ...appsSaid(stands.harnesses),
    ...serviceSaid(stands.background, stands.connector, running && enrolled),
    newerOut ? `It ${newerOut} is out, and this is ${VERSION}. \`it upgrade\` puts it in place.` : `This is It ${VERSION}.`,
  ])
}

/**
 * Runs something that goes on until it is stopped, which is the service.
 * What it says goes to the log it was given, or else to the terminal. `named` is how the
 * person is told of it, and `command` what they run to see it start.
 */
async function keepRunning(a: Args, named: string, command: string, run: (line: (l: string) => void) => Promise<void>): Promise<never> {
  const log = text(a, 'log')
  let last = ''
  let repeats = 0
  if (service.supervised() && command === 'it serve') askShell((l) => line(l))
  const line = (l: string) => {
    // The same line over and over (the network is down, say) is written once and counted
    if (l === last && ++repeats % 300 !== 0) return
    if (l !== last) repeats = 0
    last = l
    const stamped = `${new Date().toISOString()} ${l}${repeats ? ` (${repeats} more times)` : ''}`
    if (!log) return say(stamped)
    try {
      // Kept to a few megabytes: the newer half stays
      if (existsSync(log) && statSync(log).size > 5_000_000) writeFileSync(log, readFileSync(log, 'utf8').slice(-2_000_000), { mode: 0o600 })
      appendFileSync(log, `${stamped}\n`, { mode: 0o600 })
    } catch {}
  }
  // Whatever ends it is written where the person will look for it. Run as a background
  // service, nothing else of what it prints is kept on every system.
  // Its kind and where it happened, and not its words: an error nothing caught may quote
  // whatever it was given, and this file is no place for that
  const fatal = (what: string) => (err: unknown) => {
    const e = err as { name?: unknown; code?: unknown; stack?: unknown } | null
    const where = /\(([^()]+)\)|at (\S+:\d+:\d+)/.exec(String(e?.stack ?? '').split('\n')[1] ?? '')
    // The kind and the code are written only where each is one plain word, which what an error quotes never is
    line(
      `stopped: ${what}: ${plainWord(e?.name) ? e.name : 'error'}${plainWord(e?.code) ? ` ${e.code}` : ''}${where ? ` at ${path.basename(where[1] ?? where[2] ?? '')}` : ''}`,
    )
    void end(1)
  }
  process.on('uncaughtException', fatal('an error nothing caught'))
  process.on('unhandledRejection', fatal('an error nothing caught'))
  try {
    // The log is this person's alone, like everything else in It's folder: it names their
    // pages and conversations by id
    if (log) {
      mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 })
      try {
        if (existsSync(log)) chmodSync(log, 0o600)
      } catch {}
    }
    await run(line)
  } catch (err) {
    // Why it could not start is written down as a fixed word: one of this program's own
    // codes, or the system's code for what a file or a socket refused. The explanation names
    // the person's folders, so it is said only to a person at a terminal. Started by a
    // supervisor, what this program prints may be kept as well, and the code is all it says.
    const own = err instanceof Problem && /^[a-z_]{1,40}$/.test(err.code) ? err.code : undefined
    const system = String((err as { code?: unknown })?.code ?? '')
    const code = own ?? (/^E[A-Z0-9_]{2,30}$/.test(system) ? system : 'error')
    line(`could not start: ${code}`)
    if (process.stderr.isTTY) throw err
    throw new Problem(`${named} could not start.`, code, `Run \`${command}\` in a terminal to read why.`)
  }
  // It has stopped, and said so. Whatever is still pending (a token being asked for again
  // and again while the network is down, say) must not keep the program alive: a supervisor
  // that asked it to stop would wait a minute and a half and then kill it.
  return end(Number(process.exitCode ?? 0))
}

/**
 * The background service: registering it with the system, taking it away again, saying how it
 * is, and printing the end of what it wrote down. `it serve` is what it runs.
 */
async function serviceCommand(a: Args) {
  const sub = a._[0] ?? 'status'
  if (sub === 'status') {
    const here = existsSync(settingsFile()) && !elsewhere()
    // Where It was never set up there is no It to speak of, here or joined: a person is told that, as `it status` tells it
    if (forPerson(a) && !enrolledHere() && !here) return tell(['It is not set up on this machine. Run `it setup`.'])
    const found = await answers()
    const stands = { ...service.status(), running: found === 'it', connector: (await connectorHealth()) ?? { running: false } }
    if (!forPerson(a)) return out(stands)
    return tell([
      stands.running
        ? here
          ? 'It is running on this machine.'
          : 'The It this machine joined is running.'
        : here
          ? inWords(await notRunning(found))
          : notAnswering(found),
      ...serviceSaid(stands, stands.connector, stands.running),
      ...(stands.connector.ok === true &&
      typeof (stands.connector as { unfit?: unknown }).unfit !== 'string' &&
      (stands.connector as { unchecked?: unknown }).unchecked !== true
        ? ['It is ready to hand what is done on a page to the conversation that made it, on this machine.']
        : []),
    ])
  }
  if (sub === 'install') {
    machine()
    if (!elsewhere() && !existsSync(settingsFile())) throw notSetUp()
    return out(service.install())
  }
  if (sub === 'uninstall') {
    // The one service a machine has belongs to the It folder its definition names, and is that
    // folder's to take away, whatever the system says of it: whether the system starts it by
    // itself, or has it running, says nothing of whose it is
    if (service.definedFor() === 'another folder')
      throw new Problem(
        'The background service on this machine runs It from another folder, and is left as it is.',
        'invalid',
        'Run this with IT_HOME set to that folder to take it away.',
      )
    service.uninstall()
    // To a person, in a sentence: it is the last thing some of them ever ask It
    if (forPerson(a))
      return tell([
        'It is no longer registered to start by itself, and the background service is stopped. An `it serve` you started yourself runs on until you end it.',
      ])
    return out({ ok: true })
  }
  if (sub === 'logs') {
    const file = service.logFile()
    written(process.stdout, existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-200).join('\n') : '')
    return
  }
  throw new Problem(`No such service command: ${sub}`, 'invalid', 'it service install | uninstall | status | logs')
}

const HELP = `it ${VERSION}: put a live ${NOUN.one} on any display you own, and hear back what happens on it.

Pages
  it create "<title>" [--id <id>] (--file f | --dir d | --html "<…>" | pipe)  [--state '{…}'] [--open] [--on "<display>"]
  it update <id> (--file f | --dir d | --html "<…>" | pipe) [--title "<title>"] [--open] [--on "<display>"]
                                 Both take [--agent <name>], a label for who made it,
                                 which its owning conversation can change explicitly, and
                                 [--take], which gives the ${NOUN.one} to this conversation.
                                 Without --take, create makes nothing under an id that is
                                 another conversation's ${NOUN.one}, and says whose it is.
  it list | it read <id> | it rollback <id> <version>
  it delete <id> [--status]      Delete a page, or check its last deletion.

State
  it set <id> <key> <value>      A key may be dotted, and a value that parses as JSON is JSON.
  it patch <id> '<json>' [--replace] [--if-revision <n>]
                                 --if-revision changes the state only while it is still at
                                 that revision, which \`it state\` prints.
  it state <id>
  it say <id> "<text>"           A line of your own words above the ${NOUN.one}, where the person is
                                 looking: an answer that has no place on the ${NOUN.one} itself.
                                 With no text, what was said before is taken away.

Displays
  it open <id> [--on "<display>"]
  it notify "<text>" [--id <id>] [--on "<display>"] [--sticky] [--button "Label=action"]…
  it displays

What the person did
  it wait [--id <id>] [--follow] [--timeout <seconds>]
  it actions [--id <id>] [--all]
                                 List the actions still waiting. An agent is listed those on
                                 its own conversation's ${NOUN.many} and on ${NOUN.many} that no
                                 conversation has. --all lists every one, and so does a command
                                 that no conversation ran. --id lists those on one ${NOUN.one}.
  it action <action-id> [--save <file> [--number <n>]]
                                 Print one action in full, by the id in its message. --save
                                 writes a file it carried (a photo, a drawing, a document) to a
                                 file you can open; --number says which, where it carried more.
  it ack <action-id> [--failed]

This machine
  it setup [--all | --only a,b | --none] [--name <name>] [--no-service]
                                 Set It up on this machine, keep it running in the
                                 background, and connect your agent apps. --yes connects
                                 every app it would otherwise ask about.
  it site [--no-open]            Open It's site in a browser on this machine, and pair that browser.
                                 --no-open only prints the address.
  it network [on | off | tailscale]
                                 Say whether It answers your other devices, or turn that on or
                                 off. With tailscale it answers your tailnet alone. It answers
                                 this machine only until it is turned on.
  it status                      Say whether It is running, where its site is, and what is connected.
  it whoami                      Say what It knows this machine as.
  it serve [--log <file>]        Run It here yourself, in this terminal, as the background
                                 service does. --log writes what it says to a file.
  it service install | uninstall | status | logs
                                 Register the background service with this system, take it
                                 away again, say how it is, or print what it last wrote down.
  it ${LOGIN}
                                 Join an It that runs on another machine, with an invite
                                 made on its site under Machines. --no-setup joins and
                                 connects no agent app.
  it logout [--force]            Leave the It this machine joined. --force leaves though
                                 that It cannot be told.
  it uninstall [--yes]           Take It off this machine: its add-ons out of your agent apps,
                                 its background service, its line in your shell's profile, and
                                 its folder with every page in it. It asks first, and --yes
                                 answers for you.
  it skill                       Print the instructions an agent needs to use It.
  it tour [show <name> | clear]  Print the tour an agent gives of It. With show, bring up one of
                                 its pages, or with show next the next one not yet seen, and
                                 with clear, remove them all.
  it tour --wait [--timeout <seconds>]
                                 Wait until the person presses "Take the tour" on the site, and
                                 print the tour then. For an agent that has just installed It.
  it telemetry [on | off]        Say whether It reports usage counts, or turn that on or off.
                                 It reports them until it is turned off.
  it upgrade [--check]           Put the newest It in place of this one, and start it again where
                                 it is registered to start by itself. With --check, only say
                                 whether a newer one is out.
  it runs [clear]                Say which conversations It has reopened, and which it holds back
                                 because a turn from before may still be running. With clear, let
                                 those be reopened again, once you have looked that none is.
  it updates [on | off]          Say whether It looks every half hour for a newer version,
                                 or turn that on or off. It looks until it is turned off.
  it version | it help
  it help <part>                 Print one part of what an agent may need that the agent skill
                                 leaves for then: showing, page, waiting or actions.

Run at a terminal, it setup, it site, it network, it status, it service status, it list,
it displays, it whoami, it upgrade, it updates and it uninstall say how things stand in a
few sentences. With --json, wherever a program reads what they print, and for an agent,
they print JSON.
`

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  // Run as a script, it is held to the Node it needs before anything else is done. The standalone program has its own runtime.
  if (!('Bun' in globalThis)) {
    const old = nodeTooOld(process.versions.node)
    if (old) throw old
    quietAboutItsDatabase()
    lenientAboutServiceMarks()
  }
  if (cmd === 'hook') {
    usage.heed()
    return hook(rest[0] ?? '')
  }
  // What the background service has the person's shell run, to learn what it gives a program
  if (cmd === 'shell-env') {
    usage.heed()
    return printEnv()
  }
  if (cmd === 'shell-profile') {
    const dir = await zshDirectory()
    if (!dir)
      throw new Problem('Zsh did not say which folder it reads .zshrc from, within five seconds and without running a .zshrc. Its PATH file was left alone.')
    process.stdout.write(`${dir}\n`)
    return
  }
  const a = parse(rest)
  optionsFor(cmd, a)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || a.flags.help) {
    // An explicit opt-out must reach the background service even when this command only prints help.
    usage.heed()
    // `it help <word>` prints one of the parts the agent skill leaves for when it is needed.
    // Any other word after it, a command's name among them, prints the whole help as before
    const more = cmd === 'help' && a._[0] !== undefined && Object.hasOwn(MORE, a._[0]) ? MORE[a._[0]] : undefined
    written(process.stdout, more ?? HELP)
    return
  }
  noMore(cmd, a)
  if (cmd === 'setup' || cmd === 'login') checkInstallationFolder(home())
  // A rejected command changes no reporting setting either.
  usage.heed()
  // Counting begins with the first command, whoever runs it, and nothing is said of it here: the
  // first screen of the site says it. Not by a command that only prints what it was asked for,
  // nor by `it telemetry`, which is how a person turns it off before it has begun. The service
  // begins it for itself as it starts.
  if (!['serve', 'service', 'version', '--version', '-v', 'skill', 'telemetry'].includes(cmd)) usage.begin()
  switch (cmd) {
    case 'version':
    case '--version':
    case '-v':
      return out({ version: VERSION, protocol: PROTOCOL_VERSION })
    case 'telemetry': {
      const to = a._[0]
      if (to !== undefined && to !== 'on' && to !== 'off' && to !== 'status')
        throw new Problem('It is `it telemetry`, `it telemetry on` or `it telemetry off`.', 'invalid')
      if (to !== 'on' && to !== 'off') return out(usage.status())
      return out(usage.set(to === 'on'))
    }
    case 'upgrade': {
      // Asked only whether a newer one is out
      if (a.flags.check) {
        const is = await latest()
        if (!forPerson(a)) return out({ version: VERSION, latest: is, newer: newer(is, VERSION) })
        return tell([
          is === null
            ? 'The newest version of It could not be learned just now. Check that this machine is online.'
            : newer(is, VERSION)
              ? `It ${is} is out, and this is ${VERSION}. \`it upgrade\` puts it in place.`
              : `This is the newest It there is (${VERSION}).`,
        ])
      }
      const done = await fetchNewer({ say })
      if (!done) return forPerson(a) ? tell([`This is the newest It there is (${VERSION}).`]) : out({ version: VERSION, upgraded: false })
      // The program is in place. What runs is still the one that was started: the service is
      // started again by the new program, which also writes the service's definition as its
      // version has it and brings the add-ons in the agent apps up to it. It is given what the
      // definition that is there gives the service, so that a setting this terminal does not
      // name is in the one written next. Where nothing starts It by itself, whoever started it
      // does so again.
      let started: 'again' | 'by hand' | 'failed' = 'by hand'
      let why: string | undefined
      if (service.installedHere()) {
        say('Starting It again as the new version…')
        const ran = await new Promise<{ ok: boolean; said: string; failed: string }>((resolve) =>
          execFile(
            done.program,
            ['setup'],
            { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: service.againWith() },
            (err, stdout, stderr) => resolve({ ok: !err, said: String(stdout), failed: String(stderr) }),
          ),
        )
        started = ran.ok ? 'again' : 'failed'
        if (!ran.ok) {
          // Why, as setup said it: in what it printed, or in the problem it ended with
          try {
            why = (JSON.parse(ran.said) as { problem?: string }).problem
          } catch {}
          if (!why)
            for (const line of ran.failed.split('\n').reverse())
              try {
                why = (JSON.parse(line) as { error?: { message?: string } }).error?.message
                if (why) break
              } catch {}
        }
      }
      // The new program is in place either way, and that is said. That It is not running as it
      // is said too, and by how this ends: whoever asked for the upgrade from a script goes by that
      if (started === 'failed') process.exitCode = 1
      // Counted: from which version to which, and whether It runs as the new one
      usage.record('upgrade.done', { from: usage.three(done.from), to: usage.three(done.to), by: 'command', result: started === 'failed' ? 'failed' : 'ok' })
      const result = { upgraded: true, from: done.from, to: done.to, started, ...(why ? { problem: why } : {}) }
      if (!forPerson(a)) return out(result)
      return tell([
        `It ${done.to} is installed in place of ${done.from}.`,
        started === 'again'
          ? 'It was started again, and is running as the new version.'
          : started === 'failed'
            ? `It could not be started again${why ? `: ${why}` : ''}. Run \`it setup\` to see why.`
            : 'It runs as the new version once it is started again: stop `it serve` where it is running, and start it.',
      ])
    }
    case 'runs': {
      // The conversations It is not reopening, because a turn of theirs from before could not be checked on or ended
      type Held = {
        unread: boolean
        held: { key?: string; agent: string; conversation: string; pid: number; since: string }[]
        running: { agent: string; conversation: string }[]
      }
      const sub = a._[0]
      if (sub !== undefined && sub !== 'clear') throw new Problem('It is `it runs` or `it runs clear`.', 'invalid')
      const now = await local<Held>('/runs')
      if (!now)
        throw new Problem(
          'It is not running on this machine, so there is nothing to ask about what it reopened.',
          'offline',
          'Start it with `it serve` or `it setup`.',
        )
      if (sub === 'clear') {
        if (!now.unread && !now.held.length) return forPerson(a) ? tell(['Nothing is held back: there is nothing to clear.']) : out({ cleared: 0 })
        if (!a.flags.yes && !flow.live())
          throw new Problem(
            'This lets It reopen conversations that it is holding back because a turn of theirs from before may still be running, and is not done without being asked for twice.',
            'invalid',
            'Look first that no agent It started is still running on this machine. Then run `it runs clear` at a terminal, where it asks, or `it runs clear --yes`.',
          )
        if (!a.flags.yes) {
          const go = await flow.pick('Have you looked that no agent It started is still running on this machine?', [
            { value: false, label: 'No, leave them held' },
            { value: true, label: 'Yes, let It reopen them again' },
          ])
          if (!go) return tell(['Nothing was changed.'])
        }
        // What is let go of is what was just shown, and nothing that came to be held since
        const done = await local<{ cleared: number; unkept?: boolean }>('/runs', {
          method: 'POST',
          body: { clear: true, of: now.held.map((r) => r.key ?? `${r.agent}:${r.conversation}`), unread: now.unread },
        })
        if (done?.unkept)
          throw new Problem(
            'Nothing was let go of: It could not write down that those turns were cut off, which each conversation is to be told when it is next reopened.',
            'unavailable',
            'See that the disk It’s folder is on is not full, then run this again.',
          )
        if (!forPerson(a)) return out({ cleared: done?.cleared ?? 0 })
        return tell([`It reopens them again. Each is told, the next time, that a turn of its was cut off and to look before it does anything twice.`])
      }
      if (!forPerson(a)) return out(now)
      return tell([
        now.running.length
          ? `Reopened and running now: ${now.running.map((r) => `${appName(r.agent)} (${r.conversation})`).join(', ')}.`
          : 'It has no conversation reopened at the moment.',
        ...(now.unread ? ['It could not read its own note of which conversations were running when it last stopped, so it reopens none of them for now.'] : []),
        ...now.held.map(
          (r) =>
            `${appName(r.agent)} conversation ${r.conversation} is held back: a turn of it from before (process ${r.pid}${/^[A-Z][a-z]{2} /.test(r.since) ? `, started ${r.since} UTC` : ''}) may still be running, and could not be checked on or ended.`,
        ),
        ...(now.unread || now.held.length
          ? [
              now.unread
                ? 'To let them be reopened again, look that no agent It started is still running here (`ps -u "$USER" -o pid,lstart,args`), and then run `it runs clear`. Starting this machine again does not do it where the note could not be read.'
                : 'They are reopened again once this machine has been started again. To let them be reopened sooner, look that no agent It started is still running here (`ps -u "$USER" -o pid,lstart,args`), and then run `it runs clear`.',
            ]
          : ['Nothing is held back.']),
      ])
    }
    case 'updates': {
      const to = a._[0]
      if (to !== undefined && to !== 'on' && to !== 'off') throw new Problem('It is `it updates`, `it updates on` or `it updates off`.', 'invalid')
      const now = to === undefined ? watched() : watch(to === 'on')
      if (!forPerson(a)) return out(now)
      return tell([
        now.on
          ? 'It looks every half hour for a newer version of itself, and says so on its site and in `it status` when one is out. Nothing about this installation is sent to ask. `it updates off` stops it looking.'
          : now.because === 'IT_UPDATE_CHECK'
            ? 'It does not look for a newer version of itself, since IT_UPDATE_CHECK says not to where It is started. Take that variable away there and start It again to have it look. `it upgrade --check` asks once.'
            : 'It does not look for a newer version of itself. `it upgrade --check` asks once, and `it updates on` has it look every half hour.',
      ])
    }
    case 'skill':
      written(process.stdout, SKILL)
      return
    case 'tour':
      return tour(a)
    case 'login': {
      /** What a folder is that has nothing to join, or has joined already. */
      const refused = () => {
        if (existsSync(settingsFile())) throw runsItsOwn()
        if (enrolledHere()) throw new Problem('This machine has already joined an It.', 'invalid', 'Run `it logout` to leave it first.')
      }
      // A person at a terminal ran the line that It's site gave them. Why this machine did not
      // join, and what to do about it, is said to them in sentences: the record a program reads
      // is printed everywhere else.
      const said = async (err: unknown): Promise<never> => {
        if (!(err instanceof Problem) || !forPerson(a)) throw err
        say(`\n${err.message}`)
        if (err.hint) say(`\n${err.hint}\n`)
        return end(err.code === 'invalid' ? 2 : 1)
      }
      try {
        refused()
      } catch (err) {
        return said(err)
      }
      const asked = {
        url: need(text(a, 'url'), 'where the It to join is', LOGIN),
        code: need(text(a, 'code'), 'the invite made on its site', LOGIN),
        name: text(a, 'name'),
      }
      // The folder is this command's alone while it joins, as it is a setup's while that sets It
      // up here. What the folder is, is looked at again once it is: a setup that was at work in
      // the meantime has made it the folder of an It that runs on this machine
      // The installer and program locks also keep uninstall out until the network replies
      // and the joined machine's records have been written.
      const done = await oneAtATime(() =>
        withInstallerLock(home(), () =>
          withCurrentProgram(async () => {
            refused()
            checkInstallationRecord(home())
            const joined = await login(asked)
            markInstallation(home())
            return joined
          }, 'login'),
        ),
      ).catch(said)
      say(`\nThis machine has joined as "${done.name}".`)
      if (done.waitsFor !== undefined) say(joinedBefore(done.waitsFor))
      // The key just made is in It's folder. In a person's own profile that is theirs alone. A
      // folder they named instead is as private as they made it, on Windows, where a file has
      // its folder's permissions and this program cannot give it others.
      if (process.platform === 'win32' && process.env.IT_HOME)
        say(`This machine's key is kept in ${home()}. Windows lets whoever can open that folder read it, so make sure nobody but you can.`)
      if (a.flags['no-setup']) return out({ machine: done.machine, name: done.name })
      return setup(a, true)
    }
    case 'logout': {
      // There is nothing to leave on the machine It runs on: what is there is It itself
      if (existsSync(settingsFile()))
        throw new Problem(
          'This machine is the one It runs on, so it cannot leave.',
          'invalid',
          '`it setup --none` takes the add-ons out of your agent apps, and `it service uninstall` stops It running in the background.',
        )
      // The machine is taken off the person's machines first. If It cannot be told, the key
      // is kept: a key thrown away here would leave the machine among them with nobody able
      // to use it, and its pages with nowhere to send their clicks.
      // What this machine was at the It it joined is written down before It is told that it
      // leaves: where that cannot be written, nothing has been done yet, and this can be run again
      noteWas()
      if (enrolledHere() && !a.flags.force) {
        try {
          await call('mutation', api.machines.leave)
        } catch (err) {
          if ((err as Problem).code !== 'unauthenticated')
            throw new Problem(
              'This machine could not be taken off your machines, so it is still one of them.',
              (err as Problem).code ?? 'error',
              'Try again when It can be reached, or revoke the machine on the site and then run `it logout --force`.',
            )
        }
      }
      // Only the service this folder set up: another folder's is not this one's to remove
      try {
        if (service.installedHere()) service.uninstall()
      } catch (err) {
        say(`The background service could not be removed (${String((err as Error).message).slice(0, 200)}). Run \`it service uninstall\` to try again.`)
      }
      // The add-ons this folder installed come out too. Left in, they would go on asking for a
      // connector that is gone. One that could not be taken out now keeps its note,
      // and `it setup --none` in this folder takes it out later.
      const was = enrolledHere()
      await reconcile([], say).catch(() => {})
      forgetMachine()
      if (was) noteLeft()
      return out({ ok: true })
    }
    case 'site': {
      // The address is the site's, so on the machine It runs on the site has to be there: the
      // backend program by itself would make an invite for an address that nothing answers at
      if (existsSync(settingsFile()) && !elsewhere()) {
        const found = await answers()
        if (found !== 'it') throw await notRunning(found)
      }
      // An invite that signs one browser in as the person themselves. Only one of their
      // machines can ask for it, and it is good once, for a few minutes.
      const { code } = await call<{ code: string }>('mutation', api.sessions.inviteOwner)
      const site = siteAddress()
      if (!site) throw notSetUp()
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) throw new Problem('It answered with something that is no invite.', 'error')
      // After the mark that begins it, nothing of an address is sent to a server or kept in its logs
      const url = `${site}/pair#${code}`
      // Where the network is on, the same code pairs a browser on another device, at each address this machine is reached by
      // As the network stands, and not only as the settings ask for it: an address the door could not listen at is no address to give
      const elsewhereToo = (await networkAsItStands(true)).addresses.map((address) => `${address}/pair#${code}`)
      const opening = !a.flags['no-open'] && openBrowser(url)
      if (!forPerson(a)) return out({ url, ...(elsewhereToo.length ? { urls: elsewhereToo } : {}) })
      if (opening) return tell(['It’s site is opening in your browser, and this link pairs it:', `  ${url}`])
      // No browser was opened here: nobody is at this machine's own screen, or it has none, or
      // it was asked not to. The address to open is then the one another device can reach,
      // with the one for this machine after it.
      const there = elsewhereToo
      return tell([
        there.length ? 'Open this on the screen you want to pair:' : `Open this in a browser${existsSync(settingsFile()) ? ' on this machine' : ''}:`,
        `  ${there[0] ?? url}`,
        ...(there.length && flow.live() ? ['', ...flow.qr(there[0]!).map((row) => `  ${row}`), ''] : []),
        ...there.slice(1).map((other) => `  or ${other}`),
        ...(there.length ? [`  or, on this machine, ${url}`] : []),
        'It pairs one browser, once, within ten minutes.',
        !there.length && existsSync(settingsFile())
          ? 'No other device can open that: `it network tailscale` or `it network on` lets one, and this then prints an address for it.'
          : undefined,
      ])
    }
    case 'network':
      return network(a)
    case 'serve':
      return keepRunning(a, 'It', 'it serve', serve)
    case 'whoami': {
      const me = await call<{ name?: string; harnesses?: { id: string; addon: string }[]; wakes?: { harness: string }[] } | null>('query', api.machines.me)
      if (!forPerson(a) || !me) return out(me)
      const on = (me.harnesses ?? []).filter((h) => h.addon === 'connected' || h.addon === 'needs_approval').map((h) => appName(h.id))
      const woken = (me.wakes ?? []).map((w) => appName(w.harness))
      return tell([
        `It knows this machine as “${me.name ?? ''}”.`,
        on.length ? `Connected here: ${on.join(', ')}.` : 'No agent app is connected here.',
        woken.length
          ? `Closed conversations are reopened for: ${woken.join(', ')}.`
          : 'No closed conversation is reopened here: Auto-wake is off for every agent app.',
      ])
    }
    case 'status':
      return status(a)
    case 'setup': {
      const was = enrolledHere() || existsSync(settingsFile())
      await setup(a)
      return setUp(a, was)
    }
    case 'uninstall':
      return uninstall(a)
    case 'service':
      return serviceCommand(a)
    case 'create':
      return create(a)
    case 'update':
      return update(a)
    case 'list': {
      const pages = (await call<Record<string, unknown>[]>('query', api.artifacts.list)).map(page)
      if (!forPerson(a)) return out(pages)
      if (!pages.length) return tell([`No ${NOUN.many} yet. An agent makes one with \`it create\`.`])
      return tell([
        `${pages.length} ${pages.length === 1 ? NOUN.one : NOUN.many}, the newest first:`,
        ...columns(
          pages.map((p) => [
            `  ${String(p.id)}`,
            String(p.title ?? ''),
            [appName(p.agent), p.machine].filter(Boolean).join(' on '),
            ago(p.updatedAt),
            Number(p.pending) > 0 ? `${p.pending} waiting` : '',
          ]),
        ),
      ])
    }
    case 'read': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'read <id>')
      const [found, state, actions] = await Promise.all([
        call('query', api.artifacts.get, { slug }),
        call('query', api.state.get, { slug }),
        call('query', api.actions.forArtifact, { slug }),
      ])
      return out({
        ...page(found),
        state: parseJson(state.json) ?? {},
        stateRevision: state.revision,
        recentActions: (actions as Record<string, unknown>[]).map(({ payload, ...rest }) => ({
          ...rest,
          data: typeof payload === 'string' ? (parseJson(payload) ?? null) : null,
        })),
      })
    }
    case 'delete': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'delete <id> [--status]')
      return out(await deletePage(slug, a.flags.status === true))
    }
    case 'rollback': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'rollback <id> <version>')
      const version = Number(need(a._[1], 'which version', 'rollback <id> <version>'))
      if (!Number.isInteger(version) || version < 1) throw new Problem('A version is a whole number.', 'invalid')
      return out({ id: slug, ...(await call('mutation', api.artifacts.rollback, { slug, version })) })
    }

    case 'set': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'set <id> <key> <value>')
      const key = need(a._[1], 'which key', 'set <id> <key> <value>')
      const value = need(a._.slice(2).join(' ') || undefined, 'the value', 'set <id> <key> <value>')
      // Held to the revision it was read at, where one is given, as `it patch` is: taken and
      // passed over, the write would go over a change the agent had not seen, and say nothing
      const base = text(a, 'if-revision')
      return out(
        await call('mutation', api.state.patch, {
          slug,
          patch: JSON.stringify(nested(key, loose(value))),
          ...(base === undefined ? {} : { baseRevision: Number(base) }),
        }),
      )
    }
    case 'patch': {
      const slug = need(a._[0], `which ${NOUN.one}`, "patch <id> '<json>'")
      const body = object(json(need(a._[1] ?? (await piped()), 'the patch', "patch <id> '<json>'"), 'The patch'), 'A patch')
      const base = text(a, 'if-revision')
      return out(
        await call('mutation', api.state.patch, {
          slug,
          patch: JSON.stringify(body),
          ...(a.flags.replace ? { replace: true } : {}),
          ...(base === undefined ? {} : { baseRevision: Number(base) }),
        }),
      )
    }
    case 'say': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'say <id> "<text>"')
      // Everything after the id is what is said, as `it set` reads its value. With nothing after
      // it, what was said before is taken away
      return out({ id: slug, ...(await call('mutation', api.artifacts.say, { slug, text: a._.slice(1).join(' ') })) })
    }
    case 'state': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'state <id>')
      const s = await call<{ json: string; revision: number }>('query', api.state.get, { slug })
      return out({ state: parseJson(s.json) ?? {}, revision: s.revision })
    }

    case 'open': {
      const slug = need(a._[0], `which ${NOUN.one}`, 'open <id> [--on "<display>"]')
      // A conversation that brings a page up for its person is the one they are talking to: the
      // page is its page from now on, also where another conversation made it. Someone who says
      // "show me the board again" the next day gets an agent that opens what is there, and what
      // they then do on it went to a conversation that was closed.
      const asked = sessionAsked()
      const mine = asked?.session
      // Which conversation this is was a choice among the apps that had marked this command: said, so that an agent that is another one knows
      const guessed = sessionNote(asked, `This ${NOUN.one} was shown for`, `run \`it open ${slug}\` again with IT_HARNESS and IT_SESSION set to your own.`)
      const result = await onDisplay(a, () =>
        call<Shown & { took?: boolean }>('mutation', api.displays.show, {
          slug,
          ...(text(a, 'on') ? { display: text(a, 'on') } : {}),
          ...(mine ? { session: mine, agent: mine.harness } : {}),
        }),
      )
      // Noted only once It has answered, since it is as the page is shown that it becomes this
      // conversation's: a page It refuses to show leaves no note of the conversation
      if (mine) await noteConversation(mine)
      const took = result.took === true
      const shown = shownAs(result)
      const taken = `This ${NOUN.one} was another conversation’s, and is this one’s now: what is done on it comes here.`
      return out({
        id: slug,
        ...shown,
        ...(took ? { note: taken } : {}),
        ...(guessed ? { session: guessed } : {}),
      })
    }
    case 'notify': {
      const body = need(a._.join(' ') || (await piped()), 'what to say', 'notify "<text>"')
      const buttons = (a.many.button ?? []).map((b) => {
        const eq = b.lastIndexOf('=')
        if (eq < 1) throw new Problem('A button is "Label=action".', 'invalid')
        return { label: b.slice(0, eq), action: b.slice(eq + 1) }
      })
      const sent = await onDisplay(a, () =>
        call('mutation', api.notifications.send, {
          text: body,
          ...(text(a, 'id') ? { slug: text(a, 'id') } : {}),
          ...(text(a, 'on') ? { display: text(a, 'on') } : {}),
          ...(a.flags.sticky ? { sticky: true } : {}),
          ...(buttons.length ? { buttons } : {}),
        }),
      )
      // Counted: which agent app sent it, whether it had buttons, stays up, or is about a page, and whether it went to one display or to all. Never what it says
      usage.record('notification.sent', {
        agent: usage.agentOf(sessionAsked()?.session.harness),
        buttons: buttons.length > 0,
        sticky: a.flags.sticky === true,
        page: text(a, 'id') !== undefined,
        to: text(a, 'on') ? 'one' : 'all',
      })
      return out(sent)
    }
    case 'displays': {
      const shown = await call<{ name: string; paired?: boolean; lastSeenAt?: number }[]>('query', api.displays.list)
      if (!forPerson(a)) return out(shown)
      if (!shown.length) return tell(['No display is paired. `it site` opens the site in a browser on this machine and pairs that browser.'])
      return tell([
        `${shown.length} display${shown.length === 1 ? '' : 's'}:`,
        ...columns(
          shown.map((d) => [`  ${d.name}`, d.paired === false ? 'not paired any more' : 'paired', d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'never seen']),
        ),
      ])
    }

    case 'wait':
      return wait(a, counted)
    case 'actions': {
      const slug = text(a, 'id')
      if (slug && a.flags.all) throw new Problem(`--id lists what waits on one ${NOUN.one}, and --all what waits on every one: give one of them.`, 'invalid')
      if (slug) return out((await call<Listed[]>('query', api.delivery.waiting, { slug })).map(printed))
      // An agent is listed what waits on its own conversation's pages, under every id the
      // conversation has had, and on pages no conversation has: what is done on another
      // conversation's page is that conversation's to answer. The backend reads each
      // conversation's by itself, so no number of others' stands in front of one of its own.
      const asked = sessionAsked()
      const ids = asked ? conversationIds(asked.session) : []
      /** What waits for this conversation and for none, newest first, and whether It could list all of it. */
      const own = async (): Promise<{ clicks: Listed[]; whole: boolean }> => {
        try {
          const each = await Promise.all(ids.map((s) => call<Listed[]>('query', api.delivery.allWaiting, { for: s })))
          return { clicks: [...new Map(each.flat().map((c) => [c.id, c])).values()].sort((x, y) => y.at - x.at).slice(0, 50), whole: true }
        } catch (err) {
          // This machine may be a version ahead of the It it asks, whose list takes no
          // conversation. Such an It fails the call and keeps why to itself, so it is asked what
          // it takes. Only on its word that it does not take this is the newest of everyone's read
          // here for this conversation's. Any other failure is said as it is.
          if ((await backendTakes(TAKES.conversationsWaiting)) !== false) throw err
          const ours = (c: Listed) => !c.session || ids.some((s) => s.harness === c.session!.harness && s.id === c.session!.id)
          return { clicks: (await call<Listed[]>('query', api.delivery.allWaiting, {})).filter(ours), whole: false }
        }
      }
      if (ids.length && !a.flags.all) {
        // Whose pages these are was a choice among the apps that had marked this command: said apart from what is printed
        const unsure = sessionNote(asked, 'These are the actions on the pages of', 'run it again with IT_HARNESS and IT_SESSION set to your own.')
        if (unsure) say(JSON.stringify({ note: unsure }))
        const { clicks, whole } = await own()
        if (!whole)
          say(
            JSON.stringify({
              note: `The It this machine asked is of an earlier version than this command, and lists only the newest 50 actions across every conversation. These are the ones among them on this conversation’s ${NOUN.many} and on ${NOUN.many} that no conversation has, so they may not be all of them until that It is updated: with \`it upgrade\` on the machine it runs on, or the Update button on its Machines page.`,
            }),
          )
        return out(clicks.map(printed))
      }
      // A person at a terminal or a script, with no conversation, is listed everything, and so is
      // whoever asks for it with --all. An agent is told which are another conversation's by the
      // page each is on, and never by that conversation's own id.
      const [clicks, mine] = await Promise.all([call<Listed[]>('query', api.delivery.allWaiting, {}), ids.length ? own().then((o) => o.clicks) : null])
      const theirs = (c: Listed) => mine !== null && !mine.some((m) => m.id === c.id)
      return out(clicks.map((c) => ({ ...printed(c), ...(theirs(c) ? { forAnotherConversation: true } : {}) })))
    }
    case 'action': {
      // One action in full, by the id an agent was given: for data too long to have been shown, or to check a repeat
      const id = need(a._[0], 'which action', 'action <action-id>')
      const c = await call<Listed & { delivery: string; route: string | null; outcome: string | null }>('query', api.delivery.get, { id })
      const click = {
        id: c.id,
        artifact: c.artifact,
        title: c.title,
        name: c.name,
        payload: parseJson(c.payload) ?? null,
        at: c.at,
        ...(c.attended === null ? {} : { attended: c.attended }),
        ...(c.version === undefined ? {} : { version: c.version }),
        ...(c.nowVersion === undefined ? {} : { nowVersion: c.nowVersion }),
        ...(c.stateRevision === undefined ? {} : { stateRevision: c.stateRevision }),
        ...(c.nowStateRevision === undefined ? {} : { nowStateRevision: c.nowStateRevision }),
        ...(c.files?.length ? { files: c.files } : {}),
      }
      const all = { ...printed(c), delivery: c.delivery, route: c.route, outcome: c.outcome, text: describeClick(click, Number.MAX_SAFE_INTEGER) }
      // A file the action carried, written out as the file it is: an agent opens a file with what
      // it reads pictures, documents and the rest with, and need not write a program to fetch or
      // decode one
      const to = text(a, 'save')
      const asked = text(a, 'number')
      if (asked !== undefined && to === undefined)
        throw new Problem('--number says which file --save writes.', 'invalid', `Usage: it action ${id} --save <file> --number <n>`)
      const number = asked === undefined ? 1 : /^[1-9][0-9]?$/.test(asked) ? Number(asked) : 0
      if (!number) throw new Problem('--number is the number of one of the files the action carried, from 1.', 'invalid')
      if (to === undefined) return out(all)
      if (c.files?.length) return out({ ...all, saved: await saveAttached(id, number, to) })
      // An action from a page that wrote a picture into what it carried, as text
      if (number !== 1) throw new Problem('That action carried no files but a picture written into what it carried, which is number 1.', 'invalid')
      const file = firstFile(click.payload)
      if (!file) throw new Problem('This action carried no picture or other file to save.', 'invalid', 'Run it without --save to read what it carried.')
      const bytes = Buffer.from(file.base64, 'base64')
      const at = path.resolve(to)
      try {
        // Made anew or not at all: a file of that name that is there is the person's, and is not written over
        writeFileSync(at, bytes, { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Problem(
            `${at} is there already, and It does not write over a file.`,
            'invalid',
            'Give a name that no file has, and delete the file you made when you have read it.',
          )
        throw new Problem(
          `${at} could not be written (${(err as NodeJS.ErrnoException).code ?? 'an error'}).`,
          'invalid',
          'Give a file in a folder you may write to, such as the one you are in.',
        )
      }
      // Printed without the picture's text, which is what the file is for
      return out({ ...all, data: withoutFiles(click.payload).payload, saved: { file: at, type: file.type, bytes: bytes.length } })
    }
    case 'ack': {
      const id = need(a._[0], 'which action', 'ack <action-id> [--failed]')
      const done = await call<{ already: boolean; at: number; harness: string | null } | null>('mutation', api.delivery.handedOff, { id, route: 'manual' })
      // Nothing had delivered it: the agent came and took it from what was waiting
      if (done && !done.already)
        usage.record('answer.delivered', { path: 'waited', after: usage.timeBand(Date.now() - done.at), agent: usage.agentOf(done.harness) })
      await call('mutation', api.delivery.settle, { id, outcome: a.flags.failed ? 'failed' : 'succeeded' })
      return out({ id, outcome: a.flags.failed ? 'failed' : 'succeeded' })
    }
    default:
      throw new Problem(`No such command: ${cmd}`, 'invalid', 'Run `it help`.')
  }
}

// The program is there for as long as the command takes. A command waits for things that a
// runtime does not count as work still to be done: the making of this machine's proof is one,
// in the runtime's own cryptography, and under the standalone program's runtime on a busy
// machine nothing else is being waited for at that moment. A runtime with nothing it counts
// ends the program there, in the middle of the command, with nothing printed and as though all
// had gone well. So something it does count is held from before the command begins until the
// command has settled.
//
// And however a command ends, the process does not end before what it printed has left it: into
// a pipe, what was written is still on its way for a moment after it was written.
const whileItRuns = setInterval(() => {}, 1000)
const began = Date.now()
/**
 * Counts that a command was run: which of It's commands, who ran it (a person at a terminal, an
 * agent app in a conversation, or a script), how it ended and how long it took, in bands. Never
 * what was typed after the command. What an agent app runs as a hook, what the service has the
 * shell run, and the service itself are not commands anyone gave.
 */
function counted(code?: string): void {
  try {
    const cmd = process.argv[2]
    if (cmd === 'hook' || cmd === 'shell-env' || cmd === 'shell-profile' || cmd === 'serve' || takenOff) return
    const harness = sessionAsked()?.session.harness
    const by = harness
      ? (HARNESSES as readonly string[]).includes(harness)
        ? (harness as Harness)
        : 'other'
      : process.stdout.isTTY || process.stderr.isTTY
        ? 'person'
        : 'script'
    usage.record('command.run', { command: usage.commandOf(cmd), by, result: usage.resultOf(code), took: usage.timeBand(Date.now() - began) })
  } catch {}
}
main(process.argv.slice(2)).then(
  () => {
    clearInterval(whileItRuns)
    // A command that did a part of what it was asked, said which part it did not, and set how it
    // ends has not ended well: it is counted by how it ends, and not by its having come back
    counted(process.exitCode ? (process.exitCode === 2 ? 'invalid' : 'error') : undefined)
    if (!['wait', 'serve'].includes(process.argv[2] ?? '')) process.exitCode ??= 0
    return left()
  },
  (err) => {
    clearInterval(whileItRuns)
    const p = err instanceof Problem ? err : new Problem(String((err as Error)?.message ?? err))
    counted(p.code)
    failure(p, outputArgs(process.argv.slice(3)))
    return end(p.code === 'invalid' ? 2 : 1)
  },
)
