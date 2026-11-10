// Whether what the person does on a conversation's pages arrives in that conversation by itself,
// by which way, and what the agent is to do about it: what `it create`, `it update`, `it tour
// show` and `it status` print as `arrives`, for the conversation they run in. An agent told that
// it arrives by itself ends its turn; one told anything else waits for it with `it wait`.
import type { Route } from './connector'
import { claudeAddonHere } from './lib'
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

/** How an agent is told to pass on what the person is to be told: in its next message, and word for word. */
export const tellWordForWord = (line: string): string => `Tell the person this in your next message, word for word: “${line}”`

/** What the agent is told to run while nothing arrives by itself. */
const waitFor = (slug: string | undefined) =>
  `After you show the ${slug ? 'page' : 'person a page'}, run \`it wait ${slug ? `--id ${slug} ` : ''}--timeout 100\`, act on what it prints, and run it again when it prints {"timedOut": true}: do not put it in the background, since it has to end for you to see what it printed.`

export interface Facts {
  /** The conversation the command runs in, where its agent app says which. */
  session: { harness: string; id: string } | undefined
  /** Whether It's add-on runs in that conversation, where that can be told here (`claudeAddonHere`). */
  addonHere: boolean | undefined
  /** The version of the Claude Code the command runs inside (`claudeRunning`). */
  claude?: string
  /** What the connector answered at `/route`, or null where it could not be asked. */
  route: Route | null
  /** The page the command published or showed, for `it wait --id`. */
  slug?: string
  /** Whether that page is one of the tour's, which the agent gives by the tour's own rules. */
  tour?: boolean
}

/** Whether what the person does arrives by itself, by which way, and what to do, from what It knows of the conversation. */
export function arrives(f: Facts): Arrives {
  const on = f.slug ? 'this page' : 'your pages'
  const end = (via: 'addon' | 't3'): Arrives => ({
    byItself: true,
    via,
    next: `End your turn. What the person does on ${on} arrives in this conversation by itself, ${via === 't3' ? 'through its thread of T3 Code' : 'through It’s add-on'}, as a message that begins [It]. Do not run \`it wait\`.`,
  })
  const unknown = (why: string): Arrives => ({ byItself: 'unknown', next: `${why} ${waitFor(f.slug)}` })
  const not = (why: string): Arrives => ({ byItself: false, next: `${why} ${waitFor(f.slug)}` })
  if (!f.session)
    return unknown('It cannot tell which conversation this command runs in, so it cannot tell whether what the person does arrives here by itself.')
  if (!f.route)
    return unknown(
      'It could not ask its connector, which is what hands what the person does to a conversation, so it cannot tell. `it status` says how It stands.',
    )
  const { harness } = f.session
  const app = harness in KNOWN ? KNOWN[harness as keyof typeof KNOWN].label : 'this agent app'
  // An app the person has not connected here is handed nothing by the connector, through its add-on or a thread of T3 Code alike
  if (!f.route.connected) return not(`It’s add-on for ${app} is not connected on this machine, so nothing the person does arrives here by itself.`)
  if (f.route.listening) {
    // Hermes lets its add-on speak only in some of the places it runs, and the add-on cannot say which this is
    if (harness === 'hermes')
      return unknown(
        'It’s add-on for Hermes is listening, and Hermes lets it speak only in some places: in its plain terminal what the person does arrives by itself, in its TUI and desktop app only where the person has allowed it, and in its messaging gateway never.',
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
      `The add-on that ${app} has loaded cannot take clicks from this It, so nothing the person does arrives here by itself. \`it status\` says what to do about it.`,
    )
  if (harness === 'claude-code' && f.addonHere === false) {
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
  if (harness === 'claude-code' && f.addonHere === true)
    return unknown(
      'It’s add-on runs in this conversation, and It has not heard from it in the last few seconds: `it status` says why, such as a proxy that keeps the add-on from reaching It.',
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
 * What setup says last of all, in words, in that conversation. It is addressed to the agent that
 * ran setup, which is the one that reads it: the person sees what the agent says, and not what a
 * command printed for it. So it tells the agent what to say, and gives the words to say.
 */
export function claudeAfterSetup(e: NodeJS.ProcessEnv = process.env): string | undefined {
  const line = claudeReloadLine(e)
  if (!line) return undefined
  return `For the agent that ran this: this Claude Code conversation was already open when It’s add-on was installed, so it has not loaded it, and nothing the person does on a page reaches it yet. Tell the person this in your next message, word for word:\n\n  ${line}`
}
