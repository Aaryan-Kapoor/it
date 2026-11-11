// Whether what the person does on a conversation's pages arrives in that conversation by itself,
// by which way, and what the agent is to do about it: what `it create`, `it update`, `it tour
// show` and `it status` print as `arrives`, for the conversation they run in. An agent told that
// it arrives by itself ends its turn; one told anything else waits for it with `it wait`.

import { existsSync } from 'node:fs'
import type { Route } from './connector'
import { claudeAddonHere, inHome } from './lib'
import { KNOWN, older } from './setup'

export interface Arrives {
  /** True where it arrives by itself, false where it does not, and `unknown` where It cannot tell. */
  byItself: boolean | 'unknown'
  /** The way it arrives, where it does: the conversation's own add-on, or its thread of T3 Code. */
  via?: 'addon' | 't3'
  /** What the agent is to do, in a sentence or two. */
  next: string
}

/**
 * The oldest Claude Code in which `/reload-plugins` loads It's add-on into a conversation that
 * was already open when the add-on was installed, and in which the add-on then starts: the
 * oldest that It's add-on is installed into. A mod built as It's add-on is was seen to load and
 * start that way in 2.1.287 and 2.1.319, and It's add-on itself in 2.1.321.
 */
export const RELOAD_PLUGINS_SINCE = KNOWN['claude-code'].min!

/**
 * The version of the Claude Code that a command runs inside, where Claude Code says it: it
 * names its own program in CLAUDE_CODE_EXECPATH, which its installer keeps by version. A
 * conversation that was open before Claude Code updated itself runs the version it began with,
 * which may be older than the `claude` on the PATH.
 */
export function claudeRunning(e: NodeJS.ProcessEnv = process.env): string | undefined {
  return /(?:^|[\\/])(\d+\.\d+\.\d+)(?:[\\/]|$)/.exec(e.CLAUDE_CODE_EXECPATH ?? '')?.[1]
}

/** Whether that Claude Code is too old to load It's add-on with `/reload-plugins`. Where its version is not said, it is taken to be new enough. */
export const tooOldToReload = (running: string | undefined): boolean => running !== undefined && older(running, RELOAD_PLUGINS_SINCE)

/**
 * What the person is to do so that a Claude Code conversation that was already open when It's
 * add-on was installed loads it: type `/reload-plugins` in it, or, in a Claude Code too old for
 * that, start a new conversation. Said once the agent's reply has ended, since Claude Code
 * applies a reload asked for in the middle of a reply only when the reply is over.
 */
export const loadAddon = (running: string | undefined): string =>
  tooOldToReload(running)
    ? 'start a new Claude Code conversation, where It’s add-on loads by itself, and carry on there: this Claude Code is too old to load it into this conversation'
    : 'type /reload-plugins in this conversation once your reply has ended: Claude Code then loads It’s add-on here'

/**
 * What the person is told, in so many words, so that a Claude Code conversation that was
 * already open when It's add-on was installed loads it. It is written for the person and in the
 * agent's voice, since the agent passes it on as it stands, and it is short, since an agent that
 * is told to pass on something long puts it in its own words and leaves things out.
 */
export const reloadLine = (running: string | undefined): string =>
  tooOldToReload(running)
    ? 'Start a new Claude Code chat to use It. This Claude Code is too old to load It’s add-on into this one.'
    : 'Type /reload-plugins in this chat, so that what you do on It’s pages reaches me. If I’m still replying, it takes effect when I’m done.'

/**
 * What a person in a Codex conversation is told, in so many words, once It's add-on is in Codex
 * and Codex has not yet run It's hooks: Codex reads its rules and asks to review hooks only as it
 * starts, so the Codex that ran setup asks before `it` commands, and runs none of It's hooks,
 * until it is started again. Not said in a thread of T3 Code, where Codex never asks (`T3_CODEX`).
 */
export const CODEX_RESTART =
  'Quit Codex and start it again now, then choose “Trust all and continue” when it asks to review hooks. Until then, Codex may ask you to approve every `it` command I run, and It’s hooks don’t run. In a terminal, `codex resume --last` brings this chat back.'

/**
 * What a person in a Codex conversation is told where T3 Code is on the machine and It cannot
 * tell whether one of its threads holds the conversation: what to do in each case.
 */
export const CODEX_RESTART_OR_T3 =
  'If you’re using Codex in a terminal or its desktop app, quit it and start it again now, then choose “Trust all and continue” when it asks to review hooks: until then it may ask you to approve every `it` command I run. In a T3 Code thread there’s nothing to approve: what you do on It’s pages reaches the thread through T3 Code.'

/**
 * Whether a conversation is known to be held in no thread of T3 Code: the connector found none
 * holding it, or T3 Code is not on this machine at all and the connector has not said otherwise.
 */
const heldNowhere = (route: Route | null, t3: boolean | undefined): boolean => route?.thread === 'none' || (t3 === false && route?.thread !== 'held')

/**
 * What a person in a Codex conversation held in a thread of T3 Code is told: what they do on a
 * page reaches the thread through T3 Code, idle or in the middle of a turn, and T3 Code never
 * shows Codex's review of It's hooks, so nothing there is to be approved.
 */
export const T3_CODEX =
  'What you do on It’s pages reaches this thread through T3 Code, even while I’m replying. Codex never asks about It’s hooks here, so there’s nothing to approve.'

/**
 * What a person in a Claude Code conversation held in a thread of T3 Code that has not loaded
 * It's add-on is told: what they do on a page reaches the thread already, through T3 Code, and
 * `/reload-plugins` is what lets it reach a turn that is running, through the add-on.
 */
export const t3ClaudeLine = (running: string | undefined): string =>
  tooOldToReload(running)
    ? 'What you do on It’s pages already reaches this thread through T3 Code.'
    : 'What you do on It’s pages already reaches this thread through T3 Code. Type /reload-plugins here too, so it also reaches me in the middle of a reply.'

/**
 * What the person is told, in so many words, so that a Pi conversation that was already open
 * when It's add-on was installed loads it: Pi reads its extensions as a conversation starts, and
 * `/reload` reads them again in the one that is open.
 */
export const PI_RELOAD = 'Type /reload in this chat, so that what you do on It’s pages reaches me.'

/** How an agent is told to pass on what the person is to be told: in its next message, and word for word. */
export const tellWordForWord = (line: string): string => `Tell the person this in your next message, word for word: “${line}”`

/**
 * How It's program is named in a command that an agent is told to run. In Windows PowerShell 5.1 a
 * bare `it` runs the `It` command of Pester, the test framework that comes with Windows, wherever
 * It's folder is not on the PATH of the app that runs the command, as it is not in an app that
 * was already open when It was installed. So on Windows the program is named by its whole path,
 * written with forward slashes, which both PowerShell and the Git Bash that Claude Code runs
 * commands in take as it stands. A path that one of them would read otherwise, with a space in
 * it say, is given as `it.exe` instead, which Pester's command is not named, and `onWindows`
 * says the rest.
 */
export function itForAgent(platform: string = process.platform): string {
  if (platform !== 'win32') return 'it'
  const file = [inHome('bin', 'it.exe'), inHome('bin', 'it.cmd')].find((f) => existsSync(f))
  const slashed = file?.replace(/\\/g, '/')
  return slashed && /^[A-Za-z]:\/[A-Za-z0-9._~/-]*$/.test(slashed) ? slashed : 'it.exe'
}

/** What an agent on Windows is told beside a command that names It's program, and nothing elsewhere. */
export const onWindows = (platform: string = process.platform): string =>
  platform === 'win32'
    ? ` On Windows, name It’s program as ${itForAgent(platform) === 'it.exe' ? 'it.exe, or by its whole path,' : 'it is written here'} and not as a bare \`it\`: in Windows PowerShell a bare \`it\` runs Pester’s \`It\` command instead, until It’s folder is on the PATH of an app started after It was installed.`
    : ''

/** What the agent is told to run while nothing arrives by itself. */
const waitFor = (slug: string | undefined) =>
  `After you show the ${slug ? 'page' : 'person a page'}, run \`${itForAgent()} wait ${slug ? `--id ${slug} ` : ''}--timeout 100\`, act on what it prints, and run it again when it prints {"timedOut": true}: do not put it in the background, since it has to end for you to see what it printed.${onWindows()}`

export interface Facts {
  /** The conversation the command runs in, where its agent app says which. */
  session: { harness: string; id: string } | undefined
  /** Whether It's add-on runs in that conversation, where that can be told here (`addonHere` in lib.ts). */
  addonHere: boolean | undefined
  /** The version of the Claude Code the command runs inside (`claudeRunning`). */
  claude?: string
  /** What the connector answered at `/route`, or null where it could not be asked. */
  route: Route | null
  /** The page the command published or showed, for `it wait --id`. */
  slug?: string
  /** Whether that page is one of the tour's, which the agent gives by the tour's own rules. */
  tour?: boolean
  /** Whether Codex has yet to run It's hooks on this machine (`codexHooksPending`). */
  codexPending?: boolean
  /** Whether T3 Code is on this machine (`t3Here`). */
  t3?: boolean
}

/**
 * Whether nothing the person does arrives in this conversation for now because it is a Claude
 * Code conversation that has not loaded It's add-on, as one that was open when the add-on was
 * installed or updated has not, and nothing else keeps what they do from it or takes it there
 * another way: the one case in which `arrives` gives the words for the person to load it, and
 * by which anything else that asks for them goes. Whether `/reload-plugins` can load it there
 * is `tooOldToReload`.
 */
export const notLoadedHere = (f: Facts): boolean =>
  f.session?.harness === 'claude-code' &&
  f.addonHere === false &&
  f.route?.connected === true &&
  !f.route.listening &&
  f.route.thread === 'none' &&
  f.route.runtime !== 'incompatible'

/**
 * The same for Pi: a Pi conversation that was open when It's add-on was installed has not loaded
 * it, as `piAddonHere` tells, and nothing else keeps what the person does from it. Pi has no
 * thread of T3 Code to take it there another way.
 */
export const piNotLoadedHere = (f: Facts): boolean =>
  f.session?.harness === 'pi' && f.addonHere === false && f.route?.connected === true && !f.route.listening && f.route.runtime !== 'incompatible'

/**
 * Whether what the person does arrives by itself, by which way, and what to do, from what It
 * knows of the conversation. In a Codex conversation that is not held in a thread of T3 Code,
 * while Codex has yet to run It's hooks, the agent is told as well to have the person start
 * Codex again, in so many words: until then Codex may ask before each `it` command the agent runs.
 */
export function arrives(f: Facts): Arrives {
  const said = arrivesAsIs(f)
  if (f.session?.harness !== 'codex' || !f.codexPending || f.route?.thread === 'held' || f.route?.connected === false) return said
  // Said outright only where no thread of T3 Code holds the conversation, which never asks to approve the hooks
  const line = heldNowhere(f.route, f.t3) ? CODEX_RESTART : CODEX_RESTART_OR_T3
  const tell = f.tour
    ? `Unless you told the person this with the pairing link, tell them this once, word for word, after the tour’s ending: “${line}”`
    : `Unless you have told the person already in this conversation, tell them this in your next message, word for word: “${line}”`
  return { ...said, next: `${said.next} Codex has not run It’s hooks in this conversation, which it does only once it is started again. ${tell}` }
}

function arrivesAsIs(f: Facts): Arrives {
  const on = f.slug ? 'this page' : 'your pages'
  const end = (via: 'addon' | 't3'): Arrives => ({
    byItself: true,
    via,
    next: `End your turn. What the person does on ${on} arrives in this conversation by itself, ${via === 't3' ? 'through its thread of T3 Code' : 'through It’s add-on'}, as a message that begins [It]. Do not run \`${itForAgent()} wait\`.`,
  })
  const unknown = (why: string): Arrives => ({ byItself: 'unknown', next: `${why} ${waitFor(f.slug)}` })
  const not = (why: string): Arrives => ({ byItself: false, next: `${why} ${waitFor(f.slug)}` })
  if (!f.session)
    return unknown('It cannot tell which conversation this command runs in, so it cannot tell whether what the person does arrives here by itself.')
  if (!f.route)
    return unknown(
      `It could not ask its connector, which is what hands what the person does to a conversation, so it cannot tell. \`${itForAgent()} status\` says how It stands.`,
    )
  const { harness } = f.session
  const app = harness in KNOWN ? KNOWN[harness as keyof typeof KNOWN].label : 'this agent app'
  // An app the person has not connected here is handed nothing by the connector, through its add-on or a thread of T3 Code alike
  if (!f.route.connected) return not(`It’s add-on for ${app} is not connected on this machine, so nothing the person does arrives here by itself.`)
  if (f.route.listening) {
    // Hermes lets its add-on speak only in some of the places it runs, and the add-on cannot say which this is
    if (harness === 'hermes')
      return unknown(
        'It’s add-on for Hermes is listening, and Hermes lets it speak only in some places: up to Hermes 0.21.5 in its plain terminal alone; in a later Hermes, in its plain terminal, TUI and desktop app, only where the person has allowed it with `hermes config set plugins.entries.it-bridge.allow_gateway_injection true`; and in its messaging gateway never.',
      )
    // Heard from under this conversation's id, and not running in this process: another copy of it has the add-on
    if (f.addonHere === false) return unknown('It’s add-on is listening for this conversation in another copy of it, and not in this one.')
    return end('addon')
  }
  if (f.route.thread === 'held') return end('t3')
  if (f.route.thread === 'unknown')
    return unknown(
      'T3 Code is running here and has not said whether one of its threads holds this conversation, so It cannot tell whether what the person does arrives here through it.',
    )
  if (f.route.runtime === 'incompatible')
    return not(
      `The add-on that ${app} has loaded cannot take clicks from this It, so nothing the person does arrives here by itself. \`${itForAgent()} status\` says what to do about it.`,
    )
  if (notLoadedHere(f)) {
    // Said word for word, and once: in the tour, where an agent that installed It said it with the
    // pairing link, it is not said again until the ending, and then only where it was not said
    const line = reloadLine(f.claude)
    const tell = f.tour
      ? `Unless you told the person this with the pairing link, tell them this once, word for word, after the tour’s ending: “${line}”`
      : `Unless you have told the person already in this conversation, tell them this in your next message, word for word: “${line}”`
    return not(
      `Nothing the person does on ${on} arrives here by itself yet: It’s add-on is not running in this conversation, as happens when the conversation was already open when the add-on was installed. ${tell} From then on what they do arrives by itself. Until then, wait for it.`,
    )
  }
  if (piNotLoadedHere(f)) {
    // Said as Claude Code's is: word for word, and once
    const tell = f.tour
      ? `Unless you told the person this with the pairing link, tell them this once, word for word, after the tour’s ending: “${PI_RELOAD}”`
      : `Unless you have told the person already in this conversation, tell them this in your next message, word for word: “${PI_RELOAD}”`
    return not(
      `Nothing the person does on ${on} arrives here by itself yet: It’s add-on is not running in this Pi conversation, as happens when the conversation was already open when the add-on was installed. ${tell} From then on what they do arrives by itself. Until then, wait for it.`,
    )
  }
  if (harness === 'claude-code' && f.addonHere === true)
    return unknown(
      `It’s add-on runs in this conversation, and It has not heard from it in the last few seconds: \`${itForAgent()} status\` says why, such as a proxy that keeps the add-on from reaching It.`,
    )
  return unknown(
    `It has not heard from It’s add-on in this conversation in the last few seconds, so it cannot tell whether what the person does arrives here by itself.`,
  )
}

/**
 * What the person is told where setup has just connected Claude Code from inside a Claude Code
 * conversation that has not loaded the add-on, as a conversation that was open when the add-on
 * was installed has not: Claude Code loads an add-on as a conversation starts. Such a
 * conversation loads it with `/reload-plugins`, and in a Claude Code too old for that, a new
 * conversation is where It's add-on runs. Nothing anywhere else.
 */
export function claudeReloadLine(e: NodeJS.ProcessEnv = process.env): string | undefined {
  if (claudeAddonHere(e) !== false) return undefined
  return reloadLine(claudeRunning(e))
}

/**
 * What the person is told, word for word, of the conversation setup ran in, once setup has put
 * in the add-on of the app it runs in: in Claude Code, that a conversation which has not loaded
 * the add-on loads it with `/reload-plugins`; in Codex, that Codex is to be started again so
 * that it runs It's hooks. In a thread of T3 Code, what is so there instead: what the person does
 * reaches the thread through T3 Code, and nothing is asked for that T3 Code would never show.
 * Nothing where nothing is left to do in this conversation.
 */
export function setupLine(f: {
  session: { harness: string; id: string } | undefined
  /** Whether It's add-on runs in that conversation, where that can be told (`claudeAddonHere`). */
  addonHere: boolean | undefined
  claude?: string
  /** What the connector answered at `/route` for the conversation, or null. */
  route: Route | null
  /** Whether the app of the conversation is connected now, its hooks waiting on the person or not. */
  connected: boolean
  /** Whether Codex has yet to run It's hooks (`codexHooksPending`). */
  codexPending: boolean
  /** Whether T3 Code is on this machine (`t3Here`). */
  t3?: boolean
}): string | undefined {
  if (!f.connected || !f.session) return undefined
  const held = f.route?.thread === 'held'
  if (f.session.harness === 'claude-code' && f.addonHere === false) return held ? t3ClaudeLine(f.claude) : reloadLine(f.claude)
  if (f.session.harness === 'codex' && f.codexPending) return held ? T3_CODEX : heldNowhere(f.route, f.t3) ? CODEX_RESTART : CODEX_RESTART_OR_T3
  return undefined
}

/**
 * What setup says last of all, in words, to whoever ran it from inside an agent's conversation.
 * It is addressed to the agent, which is the one that reads it: the person sees what the agent
 * says, and not what a command printed for it. So it tells the agent what to say, and gives the
 * words to say, which are what is left for the person to do.
 */
export const afterSetupForAgent = (lines: readonly string[]): string =>
  `For the agent that ran this: the person sees only what you say, and not what setup printed. Tell them this in your next message, word for word:\n\n${lines.map((line) => line.replace(/^/gm, '  ')).join('\n\n')}`
