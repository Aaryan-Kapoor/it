// What `it create`, `it update`, `it tour show` and `it status` say to an agent of whether what
// the person does on its pages arrives in its conversation by itself, and what to do about it.
import { describe, expect, test } from 'vitest'
import {
  arrives,
  claudeAfterSetup,
  claudeReloadLine,
  claudeRunning,
  loadAddon,
  notLoadedHere,
  RELOAD_PLUGINS_SINCE,
  reloadLine,
  tooOldToReload,
} from './src/arrives'
import type { Route } from './src/connector'

const claude = { harness: 'claude-code', id: '11111111-2222-4333-8444-555555555555' }
const route = (r: Partial<Route> = {}): Route => ({ connected: true, listening: false, runtime: 'inactive', thread: 'none', ...r })

describe('whether what the person does arrives by itself', () => {
  test('through the conversation’s own add-on, where it is listening: the agent ends its turn and does not wait', () => {
    const said = arrives({ session: claude, addonHere: true, route: route({ listening: true, runtime: 'active' }), slug: 'plan' })
    expect(said).toMatchObject({ byItself: true, via: 'addon' })
    expect(said.next).toMatch(/^End your turn\./)
    expect(said.next).toContain('Do not run `it wait`')
    expect(arrives({ session: { harness: 'codex', id: 'thread-1' }, addonHere: undefined, route: route({ listening: true }) })).toMatchObject({
      byItself: true,
      via: 'addon',
    })
  })

  test('through its thread of T3 Code where one holds it, though its add-on is not running there', () => {
    const said = arrives({ session: claude, addonHere: false, route: route({ thread: 'held' }), slug: 'plan' })
    expect(said).toMatchObject({ byItself: true, via: 't3' })
    expect(said.next).toContain('through its thread of T3 Code')
    expect(said.next).not.toContain('/reload-plugins')
  })

  test('not at all in a Claude Code conversation that has not loaded the add-on: the agent waits, and tells the person word for word to reload its plugins', () => {
    const said = arrives({ session: claude, addonHere: false, claude: '2.1.321', route: route(), slug: 'plan' })
    expect(said.byItself).toBe(false)
    expect(said.via).toBeUndefined()
    expect(said.next).toContain(`tell them this in your next message, word for word: “${reloadLine('2.1.321')}”`)
    expect(said.next).toContain('Unless you have told the person already in this conversation')
    expect(said.next).toContain('`it wait --id plan --timeout 100`')
  })

  test('on a page of the tour, the words are said once, after its ending, unless they were said with the pairing link', () => {
    const said = arrives({ session: claude, addonHere: false, claude: '2.1.321', route: route(), slug: 'it-tour-menu', tour: true })
    expect(said.byItself).toBe(false)
    expect(said.next).toContain(
      `Unless you told the person this with the pairing link, tell them this once, word for word, after the tour’s ending: “${reloadLine('2.1.321')}”`,
    )
    expect(said.next).not.toContain('in your next message')
  })

  test('in a Claude Code too old to load the add-on that way, the person is asked to start a new conversation', () => {
    const said = arrives({ session: claude, addonHere: false, claude: '2.1.280', route: route(), slug: 'plan' })
    expect(said.byItself).toBe(false)
    expect(said.next).toContain('Start a new Claude Code chat to use It')
    expect(said.next).not.toContain('/reload-plugins')
  })

  test('not at all where the app is not connected here, though a thread of T3 Code holds the conversation or its add-on was heard from a moment ago, since the connector hands a disconnected app nothing', () => {
    expect(arrives({ session: claude, addonHere: false, route: route({ connected: false, thread: 'held' }) })).toMatchObject({ byItself: false })
    expect(arrives({ session: claude, addonHere: true, route: route({ connected: false, listening: true }) })).toMatchObject({ byItself: false })
    expect(arrives({ session: claude, addonHere: true, route: route({ connected: false, listening: true }) }).next).toContain('`it wait')
  })

  test('not at all where the app’s add-on is not connected here, or the add-on it loaded cannot take clicks from this It', () => {
    expect(arrives({ session: claude, addonHere: false, route: route({ connected: false }) })).toMatchObject({ byItself: false })
    expect(arrives({ session: claude, addonHere: false, route: route({ connected: false }) }).next).not.toContain('/reload-plugins')
    const incompatible = arrives({ session: claude, addonHere: true, route: route({ runtime: 'incompatible' }) })
    expect(incompatible.byItself).toBe(false)
    expect(incompatible.next).toContain('`it status`')
  })

  test('is said to be unknown, with the agent told to wait, wherever It cannot tell', () => {
    for (const said of [
      // No conversation is known
      arrives({ session: undefined, addonHere: undefined, route: null }),
      // The connector could not be asked
      arrives({ session: claude, addonHere: true, route: null }),
      // T3 Code has not said whether a thread holds it
      arrives({ session: claude, addonHere: false, route: route({ thread: 'unknown' }) }),
      // Hermes's add-on is listening, and Hermes lets it speak in some places only
      arrives({ session: { harness: 'hermes', id: '20261108_120000_abcd' }, addonHere: undefined, route: route({ listening: true }) }),
      // The add-on runs in this conversation and has not been heard from
      arrives({ session: claude, addonHere: true, route: route() }),
      // Another app whose add-on has not been heard from
      arrives({ session: { harness: 'codex', id: 'thread-1' }, addonHere: undefined, route: route() }),
    ]) {
      expect(said.byItself).toBe('unknown')
      expect(said.via).toBeUndefined()
      expect(said.next).toContain('`it wait')
    }
  })

  test('gives the words to load the add-on in exactly the case that is named for anything else that asks', () => {
    const cases = [
      { session: claude, addonHere: false, route: route() },
      { session: claude, addonHere: false, route: route({ thread: 'held' }) },
      { session: claude, addonHere: false, route: route({ thread: 'unknown' }) },
      { session: claude, addonHere: false, route: route({ connected: false }) },
      { session: claude, addonHere: false, route: route({ listening: true }) },
      { session: claude, addonHere: false, route: route({ runtime: 'incompatible' }) },
      { session: claude, addonHere: true, route: route() },
      { session: claude, addonHere: false, route: null },
      { session: { harness: 'codex', id: 'thread-1' }, addonHere: false, route: route() },
    ] as const
    for (const f of cases) expect(notLoadedHere(f)).toBe(arrives(f).next.includes('word for word'))
    expect(cases.filter((f) => notLoadedHere(f))).toHaveLength(1)
  })

  test('says which page to wait on where there is one, and asks for no page where there is none', () => {
    expect(arrives({ session: claude, addonHere: false, route: route(), slug: 'plan' }).next).toContain('--id plan')
    expect(arrives({ session: claude, addonHere: false, route: route() }).next).not.toContain('--id')
  })
})

describe('the Claude Code a command runs inside', () => {
  test('is the version Claude Code names its own program by, where it does', () => {
    expect(claudeRunning({ CLAUDE_CODE_EXECPATH: '/home/someone/.local/share/claude/versions/2.1.321' })).toBe('2.1.321')
    expect(claudeRunning({ CLAUDE_CODE_EXECPATH: 'C:\\Users\\someone\\.local\\share\\claude\\versions\\2.1.300\\claude.exe' })).toBe('2.1.300')
    expect(claudeRunning({ CLAUDE_CODE_EXECPATH: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' })).toBeUndefined()
    expect(claudeRunning({})).toBeUndefined()
  })

  test('is too old to load the add-on with /reload-plugins only before the oldest Claude Code It installs into', () => {
    expect(RELOAD_PLUGINS_SINCE).toBe('2.1.287')
    expect(tooOldToReload('2.1.286')).toBe(true)
    expect(tooOldToReload('2.1.287')).toBe(false)
    expect(tooOldToReload(undefined)).toBe(false)
    expect(loadAddon('2.1.286')).toContain('start a new Claude Code conversation')
    expect(loadAddon(undefined)).toContain('/reload-plugins')
  })
})

describe('what setup says last where it has just connected Claude Code', () => {
  const inClaude = { CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555' }
  test('from inside a conversation that has not loaded the add-on: to the agent, to tell the person word for word to type /reload-plugins', () => {
    const said = claudeAfterSetup({ ...inClaude, CLAUDE_CODE_EXECPATH: '/home/someone/.local/share/claude/versions/2.1.321' })!
    expect(said).toMatch(/^For the agent that ran this: /)
    expect(said).toContain('Tell the person this in your next message, word for word:')
    // The words for the person come last, on their own, as they are to be said
    expect(said.endsWith(`\n\n  ${reloadLine('2.1.321')}`)).toBe(true)
    expect(reloadLine('2.1.321')).toContain('Type /reload-plugins in this chat')
    expect(claudeReloadLine(inClaude)).toBe(reloadLine(undefined))
  })

  test('the words for the person are short and in the agent’s voice, as an agent passes them on as they stand', () => {
    for (const line of [reloadLine('2.1.321'), reloadLine('2.1.286')]) {
      expect(line.length).toBeLessThan(140)
      expect(line).not.toMatch(/\bagent\b|\bIt’s add-on is not running\b/)
    }
    expect(reloadLine('2.1.321')).toContain('reaches me')
  })

  test('from inside one of a Claude Code too old for that: to start a new conversation', () => {
    const said = claudeAfterSetup({ ...inClaude, CLAUDE_CODE_EXECPATH: '/home/someone/.local/share/claude/versions/2.1.286' })!
    expect(said).toContain('Start a new Claude Code chat to use It')
    expect(said).not.toContain('/reload-plugins')
  })

  test('nothing from outside Claude Code, or from a conversation where the add-on runs already', () => {
    expect(claudeAfterSetup({})).toBeUndefined()
    expect(claudeAfterSetup({ CODEX_THREAD_ID: 'thread-1' })).toBeUndefined()
    expect(claudeAfterSetup({ ...inClaude, IT_HARNESS: 'claude-code', IT_SESSION: inClaude.CLAUDE_CODE_SESSION_ID })).toBeUndefined()
    expect(claudeReloadLine({})).toBeUndefined()
  })
})
