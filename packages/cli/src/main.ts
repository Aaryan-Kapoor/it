// `it`: the one command agents and people use. A command prints JSON on standard output, and
// anything said along the way goes to standard error, so that what a command printed can always
// be parsed. Three print text and no JSON: `it help`, `it skill` and `it service logs`. And the
// five that a person runs to look after It (`it setup`, `it status`, `it site`, `it network`
// and `it service status`) print a few plain sentences where standard output is a terminal, and
// the same JSON as ever where it is not, or when `--json` is given.
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { describeClick, firstFile, HARNESSES, type Harness, isSlug, NOUN, PROTOCOL_VERSION, parseJson, withoutFiles } from '@it/protocol'
import { SKILL } from './addons.generated'
import { type Args, json, loose, need, nested, parse, text } from './args'
import { local } from './connector'
import * as flow from './flow'
import { hook } from './hooks'
import {
  api,
  askConnectorWith,
  askShell,
  backend,
  backendAt,
  basePort,
  call,
  direct,
  doorRefusal,
  elsewhere,
  end,
  enrolledHere,
  forgetMachine,
  hasLeft,
  home,
  inHome,
  keptFromIt,
  left,
  live,
  machine,
  NOT_RUNNING,
  noteLeft,
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
  written,
} from './lib'
import { login, runsItsOwn } from './login'
import { nodeTooOld, quietAboutItsDatabase } from './node'
import { gather, noteConversation, publish } from './publish'
import { alone, asAdmin, standing, startBackend } from './serve/backend'
import { noteNetwork, readConfig } from './serve/config'
import { begin } from './serve/firstrun'
import { serve } from './serve/index'
import { reachable } from './serve/network'
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
import { GUIDE, STEPS, TOUR_PREFIX, tourPage } from './tour'
import * as usage from './usage'

// Everything is written through `written`, which follows each write until it has left the
// process, and nothing here ends the process before all of it has: see `end` and `left`.
const say = (line: string): void => written(process.stderr, `${line}\n`)
const out = (value: unknown): void => written(process.stdout, `${JSON.stringify(value, null, 2)}\n`)

/**
 * Whether what a command prints is read by a person: standard output is a terminal, and JSON was
 * not asked for. A person is then told what they need in a few sentences, the most important
 * first. An agent, a script and a test read the JSON, which is what is printed everywhere else:
 * also an agent whose app gives its commands a terminal, which is told apart by the mark the
 * app puts on the commands its agent runs.
 */
const forPerson = (a: Args): boolean => process.stdout.isTTY === true && a.flags.json !== true && sessionAsked() === undefined
/** Says something to a person, a sentence or a paragraph to the line, on standard output. */
const tell = (lines: (string | undefined)[]): void => written(process.stdout, `${lines.filter((line) => line !== undefined).join('\n')}\n`)

/** What a person is told where Codex is connected and, as it is set, would keep `it` from reaching It. Null where it would not. */
function codexShut(found: HarnessStatus[]): string | null {
  if (!found.some((h) => h.id === 'codex' && (h.addon === 'connected' || h.addon === 'needs_approval'))) return null
  return codexLetsItOut() === false ? `Codex: ${CODEX_SHUT}` : null
}
/** What a person is told of the agent apps on this machine: each one that was found, and whether It is connected to it. */
function appsSaid(found: HarnessStatus[], advise = true, withCodex = true): string[] {
  if (!found.length) return ['No agent app was found on this machine.']
  const lines = found.map((h) => {
    const app = KNOWN[h.id].label
    if (h.addon === 'connected') return `${app} is connected.`
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
function serviceSaid(background: { registered: boolean; state: string }, connector: Record<string, unknown>, running: boolean): string[] {
  return [
    background.registered
      ? `It is registered with the system to start by itself (${background.state}).`
      : service.reachable()
        ? 'It is not registered to start by itself. `it setup` registers it, and `it serve` runs it in a terminal until then.'
        : 'Nothing starts It by itself on this machine: no systemd for your account can be reached from here. `it serve` runs it, in a terminal or under a supervisor of your own.',
    ...(running && connector.ok !== true
      ? [
          'It is not handing what is done on a page to the conversations on this machine, so nothing done there reaches an agent here by itself. `it service logs` says what it met.',
        ]
      : []),
  ]
}

async function piped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const all = await textOf(process.stdin)
  return all.trim() ? all : undefined
}

// ---------- pages ----------

async function source(a: Args) {
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
      (all) => all.map((d) => d.name).join(', '),
      () => '',
    )
    throw new Problem(`No display is called "${text(a, 'on')}".`, 'not_found', names ? `Displays: ${names}` : noDisplay())
  }
}
/**
 * What to say when something was shown on no display because there is none. A display is a
 * browser with the site open and paired, so the person is told how to get one: neither they
 * nor an agent would otherwise learn why nothing appeared anywhere.
 */
const noDisplay = () =>
  `No display is paired yet, so there is nowhere to show it. Run \`it site\` to open ${siteAddress() ?? 'the site'} in a browser on this machine, already paired. Other displays are added from there.`
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
  const ended = notShownOn.filter((d) => d.reason === 'not_paired').map((d) => d.display)
  const one = ended.length === 1
  const named = one ? ended[0]! : `${ended.slice(0, -1).join(', ')} and ${ended.at(-1)}`
  const hint = ended.length
    ? `${named} ${one ? 'is' : 'are'} not paired any more: the pairing of ${one ? 'its browser' : 'their browsers'} was ended, and ${one ? 'it shows' : 'they show'} nothing until ${one ? 'that browser is' : 'those browsers are'} paired again. On the machine It runs on, \`it site\` pairs the browser there. Another screen is paired from the site, under Displays, with “Add a display”.`
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
  tour: [2, 'tour [show <name> [--step <n>] | clear]'],
  telemetry: [1, 'telemetry [on | off]'],
  create: [1, 'create "<title>" [--id <id>] (--file f | --dir d | --html "<…>" | pipe)'],
  update: [1, 'update <id> (--file f | --dir d | --html "<…>" | pipe)'],
  list: [0, 'list'],
  read: [1, 'read <id>'],
  delete: [1, 'delete <id>'],
  rollback: [2, 'rollback <id> <version>'],
  patch: [2, "patch <id> '<json>' [--replace] [--if-revision <n>]"],
  state: [1, 'state <id>'],
  open: [1, 'open <id> [--on "<display>"]'],
  displays: [0, 'displays'],
  wait: [0, 'wait [--id <id>] [--follow] [--timeout <seconds>]'],
  actions: [0, 'actions [--id <id>]'],
  action: [1, 'action <action-id> [--save <file>]'],
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
  const page = { slug, title, files: await source(a), agent: text(a, 'agent'), state }
  let done: Awaited<ReturnType<typeof publish>>
  try {
    done = await publish({ ...page, take, own: !take })
  } catch (err) {
    if (!(err instanceof Problem) || err.code !== 'anothers' || slug === undefined) throw err
    const theirs = await call<Made>('query', api.artifacts.get, { slug }).catch(() => null)
    // The same conversation, under the id its app gave it before it was cleared or carried on: the page is its own
    if (theirs?.session && carriedOn(theirs.session)) done = await publish({ ...page, take: true })
    else throw anothers(slug, theirs)
  }
  await published(done, a)
}

/** What is known of a page that a conversation meant to make and that is another's. */
type Made = { title?: string; agent?: string | null; machine?: string | null; updatedAt?: number; session?: { harness: string; id: string } | null }
/**
 * Whether a conversation is the one this command runs in, under an id it had before: an agent
 * app that clears a conversation, or carries it on, gives it a new id, and the connector on
 * this machine keeps which id became which.
 */
function carriedOn(was: { harness: string; id: string }): boolean {
  const now = sessionAsked()?.session
  if (!now || now.harness !== was.harness) return false
  const became = readJson<Record<string, string>>(inHome('aliases.json')) ?? {}
  let key = `${was.harness}:${was.id}`
  for (let hops = 0; hops < 10 && typeof became[key] === 'string'; hops++) key = became[key]!
  return key === `${now.harness}:${now.id}`
}
/** What a conversation is told when the id it chose for a page is another conversation's page: whose it is, and the three things it can do. */
function anothers(slug: string, theirs: Made | null): Problem {
  const app = appName(theirs?.agent ?? theirs?.session?.harness)
  const whose = [app ? `${app}’s` : '', theirs?.machine ? `on ${theirs.machine}` : ''].filter(Boolean).join(', ')
  const changed = ago(theirs?.updatedAt)
  return new Problem(
    `There is already a ${NOUN.one} with the id ${slug}${theirs?.title ? `, "${theirs.title}"` : ''}, and it belongs to another conversation${whose ? ` (${whose}${changed ? `, last changed ${changed}` : ''})` : ''}. Nothing was published.`,
    'conflict',
    `If you are making something new, publish it under another id. If the person asked for that very ${NOUN.one}, \`it open ${slug}\` brings it up as it is and makes it this conversation’s, and this command with --take replaces it with yours. Taken either way, what is done on it comes here, and the other conversation hears no more of it.`,
  )
}

/**
 * Says what was published, having brought it up on a display if that was asked for. The page
 * exists by now whatever becomes of showing it, so it is always said, with what went wrong
 * beside it: an agent told only "no such display" would publish the same page a second time.
 */
async function published(done: { slug: string; version: number; url: string; note?: string }, a: Args): Promise<void> {
  const result = { id: done.slug, version: done.version, url: done.url, ...(done.note ? { note: done.note } : {}) }
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

/**
 * The tour an agent gives of It. With nothing after it, the guide is printed for the agent to
 * follow. `show` publishes one of the tour's pages and brings it up, starting afresh each time,
 * and `clear` removes every page of the tour and nothing else.
 */
async function tour(a: Args) {
  const USAGE = 'tour [show <name> [--step <n>] | clear]'
  const what = a._[0]
  if (what === undefined) return written(process.stdout, GUIDE)
  if (what === 'clear') {
    const pages = await call<{ slug: string }[]>('query', api.artifacts.list)
    const gone: string[] = []
    for (const { slug } of pages.filter((p) => p.slug.startsWith(TOUR_PREFIX))) {
      await call('mutation', api.artifacts.remove, { slug })
      gone.push(slug)
    }
    return out({ deleted: gone })
  }
  if (what !== 'show') throw new Problem(`It does not know what to do with "${what}".`, 'invalid', `Usage: it ${USAGE}`)
  const name = need(a._[1], `which page of the tour (menu, ${STEPS.join(', ')})`, USAGE)
  const given: Record<string, unknown> = {}
  for (const param of a.many.param ?? []) {
    const eq = param.indexOf('=')
    if (eq < 1) throw new Problem('--param is written name=value.', 'invalid')
    given[param.slice(0, eq)] = loose(param.slice(eq + 1))
  }
  const step = text(a, 'step')
  const made = tourPage(name, given, step === undefined ? undefined : Number(step))
  // The page is this conversation's from now on, whoever showed it last
  const done = await publish({ slug: made.slug, title: made.title, files: gather({ html: made.html }), agent: text(a, 'agent'), state: made.state, take: true })
  // And it starts as it was first made, whatever a tour before this one left in it
  await call('mutation', api.state.patch, { slug: made.slug, patch: made.state, replace: true })
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

// ---------- waiting for the person ----------

/** A click as the backend lists it: what it carried is JSON text. */
interface Listed {
  id: string
  artifact: string
  title: string
  name: string
  payload: string
  at: number
  attended: boolean | null
  session: { harness: string; id: string } | null
  version?: number
  stateRevision?: number
  nowVersion?: number
  nowStateRevision?: number
}
/** A click as this program prints it for an agent. */
const printed = (c: Listed) => ({
  id: c.id,
  page: c.artifact,
  title: c.title,
  action: c.name,
  data: parseJson(c.payload) ?? null,
  at: c.at,
  // Said only when the site saw no sign that anyone had just used the page, which an agent should know
  ...(c.attended === false ? { sentByThePageItself: true } : {}),
  // Which version of the page, and which revision of its state, the person was looking at
  ...(c.version === undefined ? {} : { version: c.version }),
  ...(c.stateRevision === undefined ? {} : { stateRevision: c.stateRevision }),
  // Said only when what they acted on has been replaced since, which an agent must know before it acts on it
  ...(c.nowVersion === undefined ? {} : { pageIsNowAtVersion: c.nowVersion }),
  ...(c.nowStateRevision === undefined ? {} : { stateIsNowAtRevision: c.nowStateRevision }),
})
/** Writes a line and resolves once it has really left this process. */
const emit = (value: unknown) => {
  written(process.stdout, `${JSON.stringify(value)}\n`)
  return left()
}

/**
 * Blocks until the person acts, then prints what they did. While this runs, the connector on
 * this machine leaves matching clicks alone: an agent that is waiting gets the click here.
 */
async function wait(a: Args) {
  const slug = text(a, 'id')
  const follow = a.flags.follow === true
  const seconds = text(a, 'timeout') === undefined ? 0 : Number(text(a, 'timeout'))
  if (!Number.isFinite(seconds) || seconds < 0) throw new Problem('--timeout is a number of seconds.', 'invalid')
  if (slug) await call('query', api.artifacts.get, { slug })
  // Without a page named, an agent waits for clicks on its own pages. Every click that is
  // waiting would include other conversations' clicks, which are theirs to hear.
  const asked = sessionAsked()
  const me = asked?.session
  if (!slug && !me) throw new Problem('Say which page to wait on.', 'invalid', 'it wait --id <id>')
  // Whose pages are waited on was a choice among the apps that had marked this command. It is said apart from what is printed, which is the person's actions only.
  const unsure = slug ? undefined : sessionNote(asked, 'This waits for actions on the pages of', 'name the page with --id.')
  if (unsure) say(JSON.stringify({ note: unsure }))
  const who = crypto.randomUUID()
  // The connector is told what this waits for: one page, or, with none named, this
  // conversation's clicks only. Everyone else's go on being delivered as usual.
  const announce = () =>
    local<{ sessions?: { harness: string; id: string }[]; clicks?: Listed[] }>('/waiting', {
      method: 'POST',
      body: { id: who, slug: slug ?? null, ...(slug ? {} : { session: me }) },
    })
  // The connector knows the ids this conversation had before it was last cleared: pages made
  // then are still recorded under them
  const first = await announce()
  const known = first?.sessions
  const sessions = !slug && me ? (known?.length ? known : [me]) : []
  const mine = (c: Listed) => slug !== undefined || sessions.some((s) => c.session?.harness === s.harness && c.session?.id === s.id)
  // An add-on in this conversation may already have been given a click it can only hand over
  // with the result of a command, and the command now running is this one. The connector
  // passes such a click on here, already held for this machine, and it is printed like any other.
  let handedBack: Listed[] = first?.clicks ?? []
  const beat = setInterval(
    () =>
      void announce().then((r) => {
        if (r?.clicks?.length) {
          handedBack = [...handedBack, ...r.clicks]
          void onHandedBack()
        }
      }),
    2000,
  )
  const client = live()
  /** Printed already. Never printed twice, whatever happens to the report of it. */
  const printedIds = new Set<string>()
  /** Printed, and It has not yet been told so. Told again until it has. */
  const unreported = new Set<string>()
  /**
   * For usage reporting: when each click this printed was made, for which harness, and whether
   * it was already waiting when this began. That last is known from what the backend first
   * offered, and not by comparing this machine's clock with the backend's.
   */
  const made = new Map<string, { at: number; harness: string | undefined; wasWaiting: boolean }>()
  /** Whether the first list of what is waiting has been looked at. What is in it was made before this began. */
  let looked = false
  let busy = false
  let ending = false
  const finish = async (code: number) => {
    if (ending) return
    ending = true
    clearInterval(beat)
    await local('/waiting', { method: 'POST', body: { id: who, done: true } })
    await client.close().catch(() => {})
    await end(code)
  }
  const report = async () => {
    for (const id of unreported) {
      const ok = await call<{ already: boolean } | null>('mutation', api.delivery.handedOff, { id, route: 'waiter' }).then(
        (done) => {
          const c = made.get(id)
          // Counted or not, it is finished with: a wait that goes on for days keeps nothing of it
          made.delete(id)
          // A click made while the agent was already waiting was heard at once. One made before
          // had been waiting for the agent to come and ask.
          if (c && done && !done.already)
            usage.record('answer.delivered', {
              path: c.wasWaiting ? 'waited' : 'heard',
              after: usage.timeBand(Date.now() - c.at),
              agent: usage.agentOf(c.harness),
            })
          return true
        },
        (err) => /conflict|not_found/.test(String((err as Problem).code)),
      )
      if (ok) unreported.delete(id)
    }
  }
  const onHandedBack = async () => {
    if (busy || ending || !handedBack.length) return
    busy = true
    try {
      for (const c of handedBack.splice(0)) {
        if (printedIds.has(c.id)) continue
        await emit(printed(c))
        printedIds.add(c.id)
        if (printedIds.size > 5000) printedIds.delete(printedIds.values().next().value!)
        unreported.add(c.id)
        made.set(c.id, { at: c.at, harness: c.session?.harness, wasWaiting: false })
      }
      await report()
      if (printedIds.size > 0 && !follow) await finish(0)
    } finally {
      busy = false
    }
  }
  const onClicks = async (clicks: Listed[]) => {
    if (busy || ending) return
    busy = true
    try {
      await report()
      const fresh = clicks.filter((c) => !printedIds.has(c.id) && mine(c))
      if (fresh.length) {
        const got = new Set<string>()
        if (slug) for (const id of await call<string[]>('mutation', api.delivery.claim, { ids: fresh.map((c) => c.id) })) got.add(id)
        // Waiting for its own conversation's clicks, each is claimed for the conversation it
        // was offered for: a page that has changed hands meanwhile keeps its click for its new owner
        else for (const c of fresh) for (const id of await call<string[]>('mutation', api.delivery.claim, { ids: [c.id], for: c.session! })) got.add(id)
        for (const c of fresh.filter((x) => got.has(x.id))) {
          // Out of this process first, and only then reported as handed over
          await emit(printed(c))
          printedIds.add(c.id)
          if (printedIds.size > 5000) printedIds.delete(printedIds.values().next().value!)
          unreported.add(c.id)
          made.set(c.id, { at: c.at, harness: c.session?.harness, wasWaiting: !looked })
        }
        await report()
      }
      looked = true
      // Having printed something, this ends even if It could not be told: the lease runs out
      // and the click is offered again, which an agent can tell by its id
      if (printedIds.size > 0 && !follow) await finish(0)
    } catch (err) {
      say(`wait: ${(err as Error).message}`)
      if (printedIds.size > 0 && !follow) await finish(0)
    } finally {
      busy = false
    }
  }
  // Read by the page, or by the conversation: never everything that is waiting, where other
  // conversations' clicks could stand in front of this one's
  const watched = new Map<string, Listed[]>()
  let latest: Listed[] = []
  const watch = (name: string, fn: unknown, args: Record<string, unknown>) =>
    client.onUpdate(
      fn as never,
      args as never,
      (clicks: Listed[]) => {
        watched.set(name, clicks)
        latest = [...watched.values()].flat().sort((x, y) => x.at - y.at)
        void onClicks(latest)
      },
      (err) => {
        say(`wait: ${err.message}`)
        void finish(1)
      },
    )
  if (slug) watch('page', api.delivery.waiting, { slug })
  else for (const s of sessions) watch(`${s.harness}:${s.id}`, api.delivery.waitingFor, { session: s })
  // A click that arrived while another was being handled is picked up here
  const again = setInterval(() => void onHandedBack().then(() => onClicks(latest)), 1000)
  void onHandedBack()
  if (seconds > 0)
    setTimeout(async () => {
      clearInterval(again)
      await emit({ timedOut: true })
      void finish(0)
    }, seconds * 1000)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void finish(130))
  await new Promise(() => {})
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
function pathLine(): string | undefined {
  // The launcher is put there now if it is not there yet, so that what the line points at exists
  try {
    shim()
  } catch {}
  const bin = inHome('bin')
  const same = (dir: string) =>
    process.platform === 'win32' ? path.resolve(dir).toLowerCase() === path.resolve(bin).toLowerCase() : path.resolve(dir) === path.resolve(bin)
  if ((process.env.PATH ?? '').split(path.delimiter).some((dir) => dir !== '' && same(dir))) return undefined
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
async function uninstall(a: Args) {
  const folder = home()
  const said: string[] = []
  const say = (line: string) => {
    said.push(line)
    if (forPerson(a)) tell([line])
  }
  // Only a folder that is It's is ever removed: one a variable names by mistake is left alone
  const its = ['service.json', 'machine.json', 'addons', path.join('bin', process.platform === 'win32' ? 'it.exe' : 'it')].some((name) =>
    existsSync(path.join(folder, name)),
  )
  if (!its) throw new Problem(`${folder} does not hold It, so there is nothing here to take off this machine.`, 'invalid')
  if (path.resolve(folder) === path.resolve(os.homedir()) || path.resolve(folder) === path.parse(folder).root)
    throw new Problem(`${folder} is not a folder It may remove.`, 'invalid')
  if (!a.flags.yes) {
    if (!flow.live())
      throw new Problem(
        'This takes It off this machine with everything it holds, the pages among them, and is not done without being asked for twice.',
        'invalid',
        'Run `it uninstall` at a terminal, where it asks first, or `it uninstall --yes`.',
      )
    const go = await flow.pick(`Take It off this machine? Every page it holds here goes with it, and its folder (${folder}) is deleted.`, [
      { value: false, label: 'No, leave it' },
      { value: true, label: 'Yes, remove It' },
    ])
    if (!go) return forPerson(a) ? tell(['Nothing was changed.']) : out({ removed: false })
  }
  const left: string[] = []
  // 1. The add-ons, each from where this folder put it
  for (const id of HARNESSES) {
    if (!existsSync(stampFile(id))) continue
    const gone = await disconnect(id, say).catch(() => false)
    if (gone) say(`${KNOWN[id].label}: It’s add-on is out.`)
    else left.push(`${KNOWN[id].label} still has It’s add-on, which could not be taken out. Its own command for add-ons removes it.`)
  }
  // 2. The background service, and an `it serve` someone started by hand in this folder
  // The one service a machine has belongs to the It folder its definition names. One that runs
  // It from another folder is another It's, and is left as it is.
  if (service.definedFor() !== 'another folder') {
    const was = service.definedFor() === 'this folder'
    try {
      service.uninstall()
      if (was) say('The background service is stopped, and no longer starts by itself.')
    } catch (err) {
      left.push(`The background service could not be taken away (${why(err)}).`)
    }
  }
  service.askToStop(folder, 30_000)
  if (service.runningFor(folder)) left.push('It is still running, and was asked to stop: end the `it serve` you started, in its terminal.')
  // 3. Its line in the shell's profile, with the comment above it
  const bin = path.join(folder, 'bin')
  const profiles = process.platform === 'win32' ? [] : unlisted(bin)
  for (const file of profiles) say(`${file}: the line that put It on your PATH is out.`)
  if (process.platform === 'win32') left.push(`${bin} is still on your PATH. Take it off under “Edit environment variables for your account”.`)
  // 4. What It's add-ons left in the apps' own folders that the apps do not clear away themselves
  crumbs()
  // The rule the person wrote for Codex on It's word is theirs, and is not taken out. It is said
  // to be there, since it lets whatever is named `it` out of Codex's sandbox from now on.
  if (codexRuleLetsItOut())
    say(
      `Codex: the rule that lets \`it\` run outside Codex’s sandbox is still in Codex’s rules folder (\`${CODEX_RULE_FILE}\` is where It said to keep it). Delete it now that It is gone.`,
    )
  // 5. Its folder, the program in it included. A program that is running may delete its own file on every system but Windows.
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch (err) {
    left.push(`${folder} could not be deleted (${why(err)}). Delete it to finish.`)
  }
  if (existsSync(folder) && !left.some((line) => line.startsWith(folder))) left.push(`${folder} could not be deleted whole. Delete it to finish.`)
  if (!forPerson(a)) return out({ removed: left.length === 0, folder, ...(left.length ? { left } : {}), said })
  tell([
    left.length ? 'It is off this machine, but for this:' : 'It is off this machine.',
    ...left.map((line) => `  ${line}`),
    'A terminal that is open still has the old PATH: a new one does not.',
  ])
}

/**
 * Takes the installer's line out of every shell profile it may have put it in, with the comment
 * and the blank line it wrote above it, and says which files it was in. A profile that held
 * nothing else was made by the installer, and goes too.
 */
function unlisted(bin: string): string[] {
  const line = `export PATH='${bin.replaceAll("'", `'\\''`)}':"$PATH"`
  const dirs = [process.env.ZDOTDIR, os.homedir()].filter((d): d is string => typeof d === 'string' && d !== '')
  const files = [...new Set(dirs.flatMap((d) => ['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => path.join(d, name))))]
  const changed: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    const kept: string[] = []
    let found = false
    for (const l of lines) {
      if (l !== line) {
        kept.push(l)
        continue
      }
      found = true
      // The comment the installer wrote above it, and the blank line above that
      if (kept.at(-1) === '# It') kept.pop()
      if (kept.at(-1) === '') kept.pop()
    }
    if (!found) continue
    const after = kept.join('\n')
    try {
      if (after.trim() === '') rmSync(file, { force: true })
      else writeFileSync(file, after.endsWith('\n') || !text.endsWith('\n') ? after : `${after}\n`)
      changed.push(file)
    } catch {}
  }
  return changed
}

/**
 * What the agent apps keep of It's add-ons after their own commands have removed them, and
 * do not clear away: Codex's note that the person trusted the add-on's hooks, and the copies of
 * the add-on that Codex and Claude Code keep. Each is taken out only where it is plainly It's,
 * and nothing here is ever said to have failed: none of it does anything once the add-on is gone.
 */
function crumbs(): void {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  try {
    const file = path.join(codexHome, 'config.toml')
    const text = readFileSync(file, 'utf8')
    // A table of its own for each hook, holding the one line that says it was trusted
    const without = text
      .replace(/\n?\[hooks\.state\."it-bridge@it:[^"\n]*"\]\n(?:trusted_hash = "[^"\n]*"\n?)?/g, '\n')
      .replace(/\n\[hooks\.state\]\n(?=\n|\[|$)/, '\n')
    if (without !== text) writeFileSync(file, without.replace(/\n{3,}/g, '\n\n'))
  } catch {}
  for (const kept of [
    path.join(codexHome, 'plugins', 'cache', 'it'),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'cache', 'it'),
  ]) {
    try {
      rmSync(kept, { recursive: true, force: true })
    } catch {}
  }
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

async function setup(a: Args, joined = false) {
  if (a.flags.none && !enrolledHere()) {
    const leftBehind = !existsSync(settingsFile()) && (hasLeft() || holdsAddons())
    if (leftBehind || elsewhere()) {
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
    }
  }
  if (elsewhere()) return settingUp(a, joined)
  // Where the backend is this machine's own to run, a setup makes what It needs here and may
  // run the backend for as long as the setup takes: one at a time for a folder, and not while
  // the machine is joining an It on another computer. Whether the folder is to run an It is
  // decided again once the folder is this setup's alone. A machine that has joined an It
  // meanwhile keeps the identity it joined with: nothing is set up here over it.
  return oneAtATime(() => {
    const at = readJson<{ at?: string }>(inHome('machine.json'))?.at
    if (at)
      throw new Problem(
        `This machine joined the It at ${at} while this setup was waiting, so no It was set up here.`,
        'joined',
        'Run `it setup` again to connect its agent apps to that It. To have It run on this machine instead, run `it logout` first, and then `it setup`.',
      )
    return settingUp(a, joined)
  })
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
async function newDisplay(before: Set<string>, forMs: number): Promise<string | undefined> {
  const until = Date.now() + forMs
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const now = await call<{ id: string; name: string }[]>('query', api.displays.list).catch(() => [])
    const made = now.find((d) => !before.has(d.id))
    if (made) return made.name
  }
  return undefined
}

/**
 * A setup that leads a person through: the same things `settingUp` does, in the same order,
 * said as a few steps, and with two more at the end that the person would otherwise have to
 * know to ask for: how It is to be reached from their other devices, and the pairing of the
 * first screen. It ends by saying the one thing to do next.
 */
async function settingUpLed(a: Args) {
  // What the parts say in sentences is kept, and said at the end where the person has to act on it
  const kept: string[] = []
  const quiet = (line: string) => void kept.push(line)
  if (!process.env.IT_INSTALL_FLOW) flow.banner('setup')
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
    const found = await detectAll()
    const usable = found.filter((h) => supported(h.id) && h.addon !== 'too_old')
    let wanted: Harness[]
    const only = text(a, 'only')
    if (only !== undefined) {
      wanted = only
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean) as Harness[]
      const bad = wanted.filter((id) => !(HARNESSES as readonly string[]).includes(id))
      if (bad.length) throw new Problem(`Not an agent app It knows: ${bad.join(', ')}`, 'invalid', `It knows: ${HARNESSES.join(', ')}`)
      // Asked for by name and held back: refused in words, with nothing changed. Carried on with,
      // it would connect nothing and take out every app that was not named, the one asked for among them.
      const held = wanted.map((id) => whyHeldBack(id)).find((why) => why !== undefined)
      if (held) throw new Problem(held, 'invalid')
    } else if (a.flags.all || a.flags.yes) wanted = usable.map((h) => h.id)
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
    const told = await call('mutation', api.machines.choose, { harnesses: wanted }).then(
      () => true,
      () => false,
    )
    await reconcile(wanted, quiet)
    if (!told) await call('mutation', api.machines.choose, { harnesses: wanted })
    const after = await detectAll()
    await call('mutation', api.machines.inventory, { harnesses: after })
    const on = after.filter((h) => h.addon === 'connected' || h.addon === 'needs_approval')
    const failed = after.filter((h) => wanted.includes(h.id) && h.addon !== 'connected' && h.addon !== 'needs_approval')
    if (!usable.length) apps.warn(found.length ? 'none found that It can connect yet' : 'none found on this machine')
    else if (failed.length) apps.warn(`${on.map((h) => KNOWN[h.id].label).join(', ') || 'none'} connected`)
    else apps.done(on.length ? on.map((h) => KNOWN[h.id].label).join(', ') : 'none connected')
    for (const h of failed) left.push(`${KNOWN[h.id].label} could not be connected${h.detail ? `: ${h.detail}` : '.'}`)
    // What decides whether Codex's first page appears at all is said by itself, and first
    const shut = codexShut(after)
    if (shut) left.push(shut)
    for (const h of after) {
      if (h.addon === 'needs_approval' && h.detail) left.push(`${KNOWN[h.id].label}: ${h.detail}`)
      else if (h.addon === 'connected' && wanted.includes(h.id) && AFTER[h.id] && !connectedBefore.has(h.id)) left.push(`${KNOWN[h.id].label}: ${AFTER[h.id]}`)
      // An app that was found and whose add-on is held back is named, with how to ask for it: left unsaid, its user is told that no app was found
      else if (h.addon === 'unavailable' && h.detail && whyHeldBack(h.id)) left.push(`${KNOWN[h.id].label}: ${h.detail}`)
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
      const start = config.network ? (config.tailnet ? 2 : 1) : fromAfar() ? (tail.length ? 2 : 1) : 0
      const reach = await flow.pick<'off' | 'on' | 'tailscale'>(
        'How will you reach It?',
        [
          { value: 'off', label: 'From this computer only', hint: `localhost:${config.port}` },
          { value: 'on', label: 'From my home network', hint: home ? new URL(home).host : undefined },
          { value: 'tailscale', label: 'Over Tailscale', hint: tailnetName() ?? tail[0], no: tail.length ? undefined : 'not found on this machine' },
        ],
        start,
      )
      const net = flow.step('Network', 'opening')
      try {
        await turnNetwork(config, true, reach !== 'off', reach === 'tailscale')
        net.done(reach === 'off' ? 'this computer only' : reach === 'tailscale' ? 'your tailnet only' : 'your home network')
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
        const paired = await flow.unlessEnter(newDisplay(new Set(displays.map((d) => d.id)), 10 * 60_000))
        if (paired) screen.done(paired)
        else screen.warn('not paired yet')
        if (!paired) left.push('No screen is paired yet. `it site` prints a new address to open.')
      }
    }

    const add = pathLine()
    if (add) left.push(`\`it\` is not on your PATH yet, so an agent that runs it by name will not find it. ${add}`)
    flow.line()
    if (left.length) {
      flow.line(flow.bold('Left for you'))
      for (const said of left) for (const [i, row] of said.split('\n').entries()) flow.line(`${i === 0 ? flow.yellow('!') : ' '} ${row}`)
      flow.line()
    }
    // The terminal the install script ran in has no `it` on its PATH yet, so a command given
    // there is given with its whole path: typed as `it`, it would not be found
    const it = process.env.IT_INSTALL_FLOW ? `'${process.execPath.replace(/'/g, `'\\''`)}'` : 'it'
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

/** The whole of a setup, once it is known that something is to be set up here: see `setup`. */
async function settingUp(a: Args, joined: boolean) {
  if (!joined && led(a)) return settingUpLed(a)
  // Where It is set up already, `--none` leaves the background service as it is, registered or
  // not. A machine that has only just joined is not set up yet, though it has its identity
  const leaves = a.flags.none === true && !joined && enrolledHere() && (elsewhere() || existsSync(settingsFile()))
  const inBackground = !a.flags['no-service'] && !leaves
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
    say('Looking for agent apps on this machine…')
    const found = await detectAll()
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
    const only = text(a, 'only')
    if (a.flags.none) wanted = []
    else if (only !== undefined) {
      wanted = only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as Harness[]
      const bad = wanted.filter((id) => !(HARNESSES as readonly string[]).includes(id))
      if (bad.length) throw new Problem(`Not an agent app It knows: ${bad.join(', ')}`, 'invalid', `It knows: ${HARNESSES.join(', ')}`)
      // Asked for by name and held back: refused in words, with nothing changed. Carried on with,
      // it would connect nothing and take out every app that was not named, the one asked for among them.
      const held = wanted.map((id) => whyHeldBack(id)).find((why) => why !== undefined)
      if (held) throw new Problem(held, 'invalid')
    } else if (a.flags.all || a.flags.yes) wanted = usable.map((h) => h.id)
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
        const answer = (await rl.question(`Connect ${KNOWN[h.id].label}? [Y/n] `)).trim().toLowerCase()
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
    const told = await call('mutation', api.machines.choose, { harnesses: wanted }).then(
      () => true,
      () => false,
    )
    await reconcile(wanted, say)
    if (!told) await call('mutation', api.machines.choose, { harnesses: wanted })
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
    for (const h of after) {
      if (h.addon === 'needs_approval') say(`\n${KNOWN[h.id].label}: ${h.detail}`)
      else if (h.addon === 'connected' && wanted.includes(h.id) && AFTER[h.id] && !before.has(h.id)) say(`\n${KNOWN[h.id].label}: ${AFTER[h.id]}`)
    }
    // The things left for the person to do, unless everything was just taken out again from
    // an It that was already here
    if (!a.flags.none || begun?.enrolled || joined) {
      const add = pathLine()
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
          ? `\nIt’s site is at ${site}. Run \`it site\` to open it in a browser on this machine, already paired.`
          : `\nRun \`it site\` to open It’s site in a browser on this machine, already paired.`,
      )
    }
    if (!forPerson(a)) out({ harnesses: after, service: background, ...(trouble ? { problem: trouble } : {}), ...(unasked ? { hint: unasked } : {}) })
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
function networkNow(): { on: boolean; addresses: string[] } {
  try {
    const config = elsewhere() ? null : readConfig()
    const on = config?.network ?? false
    // Kept to the tailnet, the door answers at this machine's addresses there and at no other:
    // an address on the home network would be one that nothing opens
    return { on, addresses: on && config ? reachable(config.port, undefined, config.tailnet === true) : [] }
  } catch {
    // Settings that cannot be read say nothing of the network, and `it status` still says the rest
    return { on: false, addresses: [] }
  }
}

/**
 * How the service's door stands, and what its settings had asked for when it said so, as the
 * service last told the backend. Nothing when the backend cannot be asked. Whether a service
 * is running now to have said it is not told by this, and is asked at the door. The command
 * asks as the service itself does, with the key in It's settings, so that it needs nothing of
 * this machine's enrolment.
 */
async function doorStands(config: { port: number; adminKey: string }): Promise<{ on: boolean; wanted: boolean } | undefined> {
  const said = (await asAdmin({ api: backendAt(config.port).api, adminKey: config.adminKey }, 'network:current', {}).catch(() => undefined)) as
    | { on?: unknown; wanted?: unknown }
    | undefined
  return typeof said?.on === 'boolean' && typeof said.wanted === 'boolean' ? { on: said.on, wanted: said.wanted } : undefined
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
  const taken = async (setting: boolean) => {
    if (!running) return undefined
    const until = Date.now() + TAKEN_MS
    let stands = await doorStands(config)
    while (stands !== undefined && stands.wanted !== setting && Date.now() < until) {
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
  // Whom the door answers changes with nothing else changing when only the tailnet is turned
  // to or from. The service opens its door anew for that at its next look, which is waited out
  const onlyWhom = running && on && config.network && (config.tailnet === true) !== tailnet
  noteNetwork(on, tailnet)
  // The service that is running takes it by itself. With none running there is nothing to wait for.
  stands = await taken(on)
  if (onlyWhom) await new Promise((resolve) => setTimeout(resolve, 2500))
  if (stands !== undefined && stands.wanted !== on)
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
  // To a person the sentence is what is printed, with the addresses under it. Anywhere else it is said beside the JSON
  if (forPerson(a)) return tell([said, ...addresses.map((address) => `  ${address}`), later])
  say(addresses.length ? `${said} ${addresses.join(', ')}` : said)
  if (later) say(later)
  return out({ network: on, ...(tailnet ? { tailnet: true } : {}), addresses })
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
  const stands = {
    ...(blocked ? { blocked: true, hint } : {}),
    running: blocked ? null : running,
    enrolled,
    machine,
    site: siteAddress() ?? null,
    network: networkNow(),
    ...(database ? { database } : {}),
    connector: blocked ? { running: null } : ((await connectorHealth()) ?? { running: false }),
    background: service.status(),
    harnesses: await detectAll(),
    version: VERSION,
    protocol: PROTOCOL_VERSION,
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
      : !network.on
        ? 'The network is off, so It answers this machine only. `it network on` lets your other devices on the same network reach it.'
        : first === undefined
          ? 'The network is on, and this machine has no address on a network just now.'
          : `The network is on. Other devices on the same network open the site at ${first}.${others.length ? ` This machine’s other addresses are ${others.join(' and ')}.` : ''}`,
    ...appsSaid(stands.harnesses),
    ...serviceSaid(stands.background, stands.connector, running && enrolled),
    `This is It ${VERSION}.`,
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
  // Told where to write its log, it is the background service and was started by the system
  if (log && command === 'it serve') askShell((l) => line(l))
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
      ...(stands.connector.ok === true ? ['It is ready to hand what is done on a page to the conversation that made it, on this machine.'] : []),
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
                                 Both take [--agent <name>], a label for who made it, and
                                 [--take], which gives the ${NOUN.one} to this conversation.
                                 Without it, create makes nothing under an id that is
                                 another conversation's ${NOUN.one}, and says whose it is.
  it list | it read <id> | it delete <id> | it rollback <id> <version>

State
  it set <id> <key> <value>      A key may be dotted, and a value that parses as JSON is JSON.
  it patch <id> '<json>' [--replace] [--if-revision <n>]
                                 --if-revision changes the state only while it is still at
                                 that revision, which \`it state\` prints.
  it state <id>

Displays
  it open <id> [--on "<display>"]
  it notify "<text>" [--id <id>] [--on "<display>"] [--sticky] [--button "Label=action"]…
  it displays

What the person did
  it wait [--id <id>] [--follow] [--timeout <seconds>]
  it actions [--id <id>]
  it action <action-id> [--save <file>]
                                 Print one action in full, by the id in its message. --save
                                 writes a picture it carried to a file, to open as a picture.
  it ack <action-id> [--failed]

This machine
  it setup [--all | --only a,b | --none] [--name <name>] [--no-service]
                                 Set It up on this machine, keep it running in the
                                 background, and connect your agent apps. --yes connects
                                 every app it would otherwise ask about.
  it site [--no-open]            Open It's site in a browser on this machine, already paired.
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
                                 its pages, and with clear, remove them all.
  it telemetry [on | off]        Say whether It reports usage counts, or turn that on or off.
                                 It reports them until it is turned off.
  it version | it help

Run at a terminal, it setup, it site, it network, it status, it service status, it list,
it displays, it whoami and it uninstall say how things stand in a few sentences. With --json,
wherever a program reads what they print, and for an agent, they print JSON.
`

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  // Run as a script, it is held to the Node it needs before anything else is done. The standalone program has its own runtime.
  if (!('Bun' in globalThis)) {
    const old = nodeTooOld(process.versions.node)
    if (old) throw old
    quietAboutItsDatabase()
  }
  // Usage reporting turned off in this command's environment is written down for the
  // background service, which has no such environment, before anything else is done
  usage.heed()
  if (cmd === 'hook') return hook(rest[0] ?? '')
  // What the background service has the person's shell run, to learn what it gives a program
  if (cmd === 'shell-env') return printEnv()
  const a = parse(rest)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || a.flags.help) {
    written(process.stdout, HELP)
    return
  }
  // Said once, and only at a terminal, where a person reads it: a command an agent or a script
  // runs says nothing and counts nothing. Never by the service or the connector, which nobody
  // is watching, nor by a command that only prints what it was asked for.
  noMore(cmd, a)
  if (!['serve', 'service', 'version', '--version', '-v', 'skill', 'telemetry'].includes(cmd)) usage.tellOnce(say, process.stderr.isTTY === true)
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
      // Someone who turns it on and has not been told what that means is told then: the line
      // is said before anything is written down, and nothing is where it cannot be said or
      // where a variable keeps reporting off
      return out(usage.set(to === 'on', say))
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
      const done = await oneAtATime(() => {
        refused()
        return login(asked)
      }).catch(said)
      say(`\nThis machine has joined as "${done.name}".`)
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
      const elsewhereToo = networkNow().addresses.map((address) => `${address}/pair#${code}`)
      const opening = !a.flags['no-open'] && openBrowser(url)
      if (!forPerson(a)) return out({ url, ...(elsewhereToo.length ? { urls: elsewhereToo } : {}) })
      if (opening) return tell(['It’s site is opening in your browser, already paired:', `  ${url}`])
      // Nobody is at this machine's own screen, or it has none: the address to open is the one another device can reach
      const there = fromAfar() || a.flags['no-open'] ? elsewhereToo : []
      return tell([
        there.length ? 'Open this on the screen you want to pair:' : `Open this in a browser${existsSync(settingsFile()) ? ' on this machine' : ''}:`,
        `  ${there[0] ?? url}`,
        ...(there.length && flow.live() ? ['', ...flow.qr(there[0]!).map((row) => `  ${row}`), ''] : []),
        ...there.slice(1).map((other) => `  or ${other}`),
        ...(there.length ? [`  or, on this machine, ${url}`] : []),
        'It pairs one browser, once, within ten minutes.',
        !there.length && fromAfar() && existsSync(settingsFile())
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
    case 'setup':
      return setup(a)
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
      const slug = need(a._[0], `which ${NOUN.one}`, 'delete <id>')
      await call('mutation', api.artifacts.remove, { slug })
      return out({ deleted: slug })
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
      return out(await call('mutation', api.state.patch, { slug, patch: JSON.stringify(nested(key, loose(value))) }))
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
      const mine = sessionAsked()?.session
      let took = false
      if (mine) {
        noteConversation(mine)
        // A page that is not there, or anything else in the way, is said by the showing itself, below
        took = await call<{ took: boolean }>('mutation', api.artifacts.take, { slug, session: mine, agent: mine.harness }).then(
          (r) => r.took === true,
          () => false,
        )
      }
      return out({
        id: slug,
        ...shownAs(await show(slug, a)),
        ...(took ? { note: `This ${NOUN.one} was another conversation’s, and is this one’s now: what is done on it comes here.` } : {}),
      })
    }
    case 'notify': {
      const body = need(a._.join(' ') || (await piped()), 'what to say', 'notify "<text>"')
      const buttons = (a.many.button ?? []).map((b) => {
        const eq = b.lastIndexOf('=')
        if (eq < 1) throw new Problem('A button is "Label=action".', 'invalid')
        return { label: b.slice(0, eq), action: b.slice(eq + 1) }
      })
      return out(
        await onDisplay(a, () =>
          call('mutation', api.notifications.send, {
            text: body,
            ...(text(a, 'id') ? { slug: text(a, 'id') } : {}),
            ...(text(a, 'on') ? { display: text(a, 'on') } : {}),
            ...(a.flags.sticky ? { sticky: true } : {}),
            ...(buttons.length ? { buttons } : {}),
          }),
        ),
      )
    }
    case 'displays': {
      const shown = await call<{ name: string; paired?: boolean; lastSeenAt?: number }[]>('query', api.displays.list)
      if (!forPerson(a)) return out(shown)
      if (!shown.length) return tell(['No display is paired. `it site` opens the site in a browser on this machine, already paired.'])
      return tell([
        `${shown.length} display${shown.length === 1 ? '' : 's'}:`,
        ...columns(
          shown.map((d) => [`  ${d.name}`, d.paired === false ? 'not paired any more' : 'paired', d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'never seen']),
        ),
      ])
    }

    case 'wait':
      return wait(a)
    case 'actions': {
      const slug = text(a, 'id')
      const clicks = await call<Listed[]>('query', slug ? api.delivery.waiting : api.delivery.allWaiting, slug ? { slug } : {})
      return out(clicks.map(printed))
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
      }
      const all = { ...printed(c), delivery: c.delivery, route: c.route, outcome: c.outcome, text: describeClick(click, Number.MAX_SAFE_INTEGER) }
      // A picture the action carried, written out as the file it is: an agent opens a file with
      // what it reads pictures with, and need not write a program to decode one from text
      const to = text(a, 'save')
      if (to === undefined) return out(all)
      const file = firstFile(click.payload)
      if (!file) throw new Problem('This action carried no picture or other file to save.', 'invalid', 'Run it without --save to read what it carried.')
      const bytes = Buffer.from(file.base64, 'base64')
      const at = path.resolve(to)
      try {
        writeFileSync(at, bytes)
      } catch (err) {
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
main(process.argv.slice(2)).then(
  () => {
    clearInterval(whileItRuns)
    if (!['wait', 'serve'].includes(process.argv[2] ?? '')) process.exitCode ??= 0
    return left()
  },
  (err) => {
    clearInterval(whileItRuns)
    const p = err instanceof Problem ? err : new Problem(String((err as Error)?.message ?? err))
    say(JSON.stringify({ error: { code: p.code, message: p.message, ...(p.hint ? { hint: p.hint } : {}) } }))
    return end(p.code === 'invalid' ? 2 : 1)
  },
)
