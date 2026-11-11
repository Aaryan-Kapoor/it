// What `it create`, `it update`, `it tour show` and `it status` say to an agent of whether what
// the person does on its pages arrives in its conversation by itself, and what to do about it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  afterSetupForAgent,
  arrives,
  CODEX_RESTART,
  CODEX_RESTART_OR_T3,
  claudeReloadLine,
  claudeRunning,
  itForAgent,
  loadAddon,
  notLoadedHere,
  onWindows,
  PI_RELOAD,
  piNotLoadedHere,
  RELOAD_PLUGINS_SINCE,
  reloadLine,
  setupLine,
  T3_CODEX,
  t3ClaudeLine,
  tooOldToReload,
} from './src/arrives'
import type { Route } from './src/connector'

const claude = { harness: 'claude-code', id: '11111111-2222-4333-8444-555555555555' }
/** It's program as a command names it here: `it`, and on Windows its whole path or `it.exe` (`itForAgent`). */
const it = () => itForAgent()
const route = (r: Partial<Route> = {}): Route => ({ connected: true, listening: false, runtime: 'inactive', thread: 'none', ...r })

describe('whether what the person does arrives by itself', () => {
  test('through the conversation’s own add-on, where it is listening: the agent ends its turn and does not wait', () => {
    const said = arrives({ session: claude, addonHere: true, route: route({ listening: true, runtime: 'active' }), slug: 'plan' })
    expect(said).toMatchObject({ byItself: true, via: 'addon' })
    expect(said.next).toMatch(/^End your turn\./)
    expect(said.next).toContain(`Do not run \`${it()} wait\``)
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
    expect(said.next).toContain(`\`${it()} wait --id plan --timeout 100\``)
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
    expect(arrives({ session: claude, addonHere: true, route: route({ connected: false, listening: true }) }).next).toContain(`\`${it()} wait`)
  })

  test('not at all where the app’s add-on is not connected here, or the add-on it loaded cannot take clicks from this It', () => {
    expect(arrives({ session: claude, addonHere: false, route: route({ connected: false }) })).toMatchObject({ byItself: false })
    expect(arrives({ session: claude, addonHere: false, route: route({ connected: false }) }).next).not.toContain('/reload-plugins')
    const incompatible = arrives({ session: claude, addonHere: true, route: route({ runtime: 'incompatible' }) })
    expect(incompatible.byItself).toBe(false)
    expect(incompatible.next).toContain(`\`${it()} status\``)
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
      // Codex with neither a running hooked turn nor an open queue remains unknown.
      // A quiet hook alone is no longer enough to make /route say this.
      arrives({ session: { harness: 'codex', id: 'thread-1' }, addonHere: undefined, route: route() }),
    ]) {
      expect(said.byItself).toBe('unknown')
      expect(said.via).toBeUndefined()
      expect(said.next).toContain(`\`${it()} wait`)
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

describe('what setup says of the conversation it ran in, where it has just connected that conversation’s app', () => {
  const inClaude = { CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555' }
  const codex = { harness: 'codex', id: 'thread-1' }
  const facts = { session: claude, addonHere: false, claude: '2.1.321', route: null, connected: true, codexPending: false, t3: false }

  test('in a Claude Code conversation that has not loaded the add-on: to type /reload-plugins, or in one too old for that, to start a new conversation', () => {
    expect(setupLine(facts)).toBe(reloadLine('2.1.321'))
    expect(reloadLine('2.1.321')).toContain('Type /reload-plugins in this chat')
    expect(setupLine({ ...facts, claude: '2.1.286' })).toContain('Start a new Claude Code chat to use It')
    expect(claudeReloadLine(inClaude)).toBe(reloadLine(undefined))
  })

  test('in a Claude Code conversation held in a thread of T3 Code: that what the person does reaches the thread already, with /reload-plugins for a turn that is running', () => {
    const said = setupLine({ ...facts, route: route({ thread: 'held' }) })!
    expect(said).toBe(t3ClaudeLine('2.1.321'))
    expect(said).toContain('already reaches this thread through T3 Code')
    expect(said).toContain('Type /reload-plugins here too')
    expect(said).not.toMatch(/won’t|doesn’t reach|not reach/)
    // One too old to load it that way is told nothing of reloading
    expect(setupLine({ ...facts, claude: '2.1.286', route: route({ thread: 'held' }) })).toBe(
      'What you do on It’s pages already reaches this thread through T3 Code.',
    )
  })

  test('in a Codex conversation, while Codex has yet to run It’s hooks: to start Codex again now, and why', () => {
    const said = setupLine({ ...facts, session: codex, addonHere: undefined, codexPending: true })
    expect(said).toBe(CODEX_RESTART)
    expect(CODEX_RESTART).toMatch(/^Quit Codex and start it again now/)
    expect(CODEX_RESTART).toContain('may ask you to approve every `it` command')
    expect(CODEX_RESTART).toContain('“Trust all and continue”')
  })

  test('in a Codex conversation held in a thread of T3 Code: that clicks reach the thread, and nothing is asked for that T3 Code never shows', () => {
    const said = setupLine({ ...facts, session: codex, addonHere: undefined, codexPending: true, route: route({ thread: 'held' }) })
    expect(said).toBe(T3_CODEX)
    expect(T3_CODEX).not.toContain('Trust all')
    expect(T3_CODEX).toContain('nothing to approve')
  })

  test('in a Codex conversation where T3 Code is on the machine and It cannot tell whether a thread holds it: what to do in each case, and no outright restart', () => {
    const codexFacts = { ...facts, session: codex, addonHere: undefined, codexPending: true, t3: true }
    for (const r of [null, route({ thread: 'unknown' })]) expect(setupLine({ ...codexFacts, route: r })).toBe(CODEX_RESTART_OR_T3)
    // The connector found no thread holding it: said outright
    expect(setupLine({ ...codexFacts, route: route({ thread: 'none' }) })).toBe(CODEX_RESTART)
    // T3 Code is not on this machine: no thread can hold it, whatever the connector could say
    expect(setupLine({ ...codexFacts, t3: false, route: null })).toBe(CODEX_RESTART)
    expect(CODEX_RESTART_OR_T3).toContain('In a T3 Code thread there’s nothing to approve')
  })

  test('nothing where the conversation’s app is not connected, where nothing is left to do in it, or where no conversation is known', () => {
    expect(setupLine({ ...facts, connected: false })).toBeUndefined()
    expect(setupLine({ ...facts, addonHere: true })).toBeUndefined()
    expect(setupLine({ ...facts, session: codex, addonHere: undefined, codexPending: false })).toBeUndefined()
    expect(setupLine({ ...facts, session: undefined })).toBeUndefined()
    expect(setupLine({ ...facts, session: { harness: 'pi', id: 'p' }, addonHere: undefined, codexPending: true })).toBeUndefined()
    expect(claudeReloadLine({})).toBeUndefined()
    expect(claudeReloadLine({ CODEX_THREAD_ID: 'thread-1' })).toBeUndefined()
    expect(claudeReloadLine({ ...inClaude, IT_HARNESS: 'claude-code', IT_SESSION: inClaude.CLAUDE_CODE_SESSION_ID })).toBeUndefined()
  })

  test('is said to the agent, with every note for the person on its own, as it is to be said', () => {
    const hermes = 'Hermes: restart Hermes.\nFor the Hermes TUI, also run this once:\n    hermes config set x true'
    const said = afterSetupForAgent([reloadLine('2.1.321'), hermes])
    expect(said).toMatch(/^For the agent that ran this: /)
    expect(said).toContain('Tell them this in your next message, word for word:')
    expect(
      said.endsWith(`\n\n  ${reloadLine('2.1.321')}\n\n  Hermes: restart Hermes.\n  For the Hermes TUI, also run this once:\n      hermes config set x true`),
    ).toBe(true)
  })

  test('the words for the person are short and in the agent’s voice, as an agent passes them on as they stand', () => {
    for (const line of [reloadLine('2.1.321'), reloadLine('2.1.286'), t3ClaudeLine('2.1.321'), T3_CODEX]) {
      expect(line.length).toBeLessThan(160)
      expect(line).not.toMatch(/\bagent\b|\bIt’s add-on is not running\b/)
    }
    expect(CODEX_RESTART.length).toBeLessThan(260)
    expect(reloadLine('2.1.321')).toContain('reaches me')
  })
})

describe('what a Codex conversation is told with each page while Codex has yet to run It’s hooks', () => {
  const codex = { harness: 'codex', id: 'thread-1' }
  test('outside T3 Code, the agent is told to have the person start Codex again, word for word, once', () => {
    for (const r of [route(), route({ listening: true })]) {
      const said = arrives({ session: codex, addonHere: undefined, route: r, slug: 'plan', codexPending: true })
      expect(said.next).toContain(
        `Unless you have told the person already in this conversation, tell them this in your next message, word for word: “${CODEX_RESTART}”`,
      )
    }
    const tour = arrives({ session: codex, addonHere: undefined, route: route(), slug: 'it-tour-menu', tour: true, codexPending: true })
    expect(tour.next).toContain(`after the tour’s ending: “${CODEX_RESTART}”`)
  })

  test('where T3 Code is on the machine and the connector cannot tell whether a thread holds it, what to do in each case is said, and not an outright restart', () => {
    const said = arrives({ session: codex, addonHere: undefined, route: route({ thread: 'unknown' }), slug: 'plan', codexPending: true, t3: true })
    expect(said.next).toContain(`word for word: “${CODEX_RESTART_OR_T3}”`)
    expect(said.next).not.toContain(CODEX_RESTART)
  })

  test('in a thread of T3 Code, once its hooks have run, or where Codex is not connected here, nothing of it is said', () => {
    const held = arrives({ session: codex, addonHere: undefined, route: route({ thread: 'held' }), slug: 'plan', codexPending: true })
    expect(held).toMatchObject({ byItself: true, via: 't3' })
    expect(held.next).not.toContain('Codex again')
    expect(arrives({ session: codex, addonHere: undefined, route: route(), slug: 'plan', codexPending: false }).next).not.toContain('Codex again')
    expect(arrives({ session: codex, addonHere: undefined, route: route({ connected: false }), codexPending: true }).next).not.toContain('Codex again')
    // And never in another app's conversation
    expect(arrives({ session: claude, addonHere: false, claude: '2.1.321', route: route(), codexPending: true }).next).not.toContain('Codex again')
  })
})

describe('how It’s program is named in a command an agent is told to run', () => {
  test('as `it` everywhere but Windows, with nothing more said', () => {
    expect(itForAgent('linux')).toBe('it')
    expect(itForAgent('darwin')).toBe('it')
    expect(onWindows('linux')).toBe('')
  })

  test('on Windows, no command that `arrives` gives an agent names a bare it', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const was = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-name-'))
    try {
      process.env.IT_HOME = folder
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const said = [
        arrives({ session: claude, addonHere: false, route: null, slug: 'plan' }),
        arrives({ session: claude, addonHere: true, route: route(), slug: 'plan' }),
        arrives({ session: claude, addonHere: true, route: route({ runtime: 'incompatible' }) }),
        arrives({ session: claude, addonHere: true, route: route({ listening: true, runtime: 'active' }) }),
      ].map((a) => a.next)
      for (const next of said) expect(next).not.toMatch(/`it /)
      expect(said[0]).toContain('`it.exe status`')
      expect(said[0]).toContain('`it.exe wait --id plan --timeout 100`')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      if (was === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = was
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('on Windows, by its whole path with forward slashes where both shells take it as it stands, and else as it.exe, never as a bare it', () => {
    const was = process.env.IT_HOME
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-name-'))
    try {
      process.env.IT_HOME = folder
      // Not installed in It's folder: the name that Pester's command does not have
      expect(itForAgent('win32')).toBe('it.exe')
      mkdirSync(path.join(folder, 'bin'))
      writeFileSync(path.join(folder, 'bin', 'it.exe'), '')
      const slashed = path.join(folder, 'bin', 'it.exe').replace(/\\/g, '/')
      // A path on a drive, with nothing in it that either shell would read otherwise, is given whole
      expect(itForAgent('win32')).toBe(/^[A-Za-z]:\/[A-Za-z0-9._~/-]*$/.test(slashed) ? slashed : 'it.exe')
      expect(itForAgent('win32')).not.toBe('it')
      expect(onWindows('win32')).toContain('in Windows PowerShell a bare `it` runs Pester’s `It` command instead')
    } finally {
      if (was === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = was
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('a Pi conversation that has not loaded It’s add-on', () => {
  const pi = { harness: 'pi', id: 'pi-1' }
  test('is told that nothing arrives by itself, and the agent tells the person word for word to type /reload, and waits', () => {
    const said = arrives({ session: pi, addonHere: false, route: route(), slug: 'plan' })
    expect(said.byItself).toBe(false)
    expect(said.next).toContain(
      `Unless you have told the person already in this conversation, tell them this in your next message, word for word: “${PI_RELOAD}”`,
    )
    expect(said.next).toContain(`\`${it()} wait --id plan --timeout 100\``)
    expect(PI_RELOAD).toBe('Type /reload in this chat, so that what you do on It’s pages reaches me.')
  })

  test('on a page of the tour, the words are said once, after its ending, unless they were said with the pairing link', () => {
    const said = arrives({ session: pi, addonHere: false, route: route(), slug: 'it-tour-menu', tour: true })
    expect(said.next).toContain(
      `Unless you told the person this with the pairing link, tell them this once, word for word, after the tour’s ending: “${PI_RELOAD}”`,
    )
    expect(said.next).not.toContain('in your next message')
  })

  test('is not told to reload where the add-on runs in it, where Pi is not connected, where the add-on it loaded cannot take clicks, or where It cannot tell', () => {
    expect(piNotLoadedHere({ session: pi, addonHere: false, route: route() })).toBe(true)
    for (const facts of [
      { session: pi, addonHere: true, route: route() },
      { session: pi, addonHere: undefined, route: route() },
      { session: pi, addonHere: false, route: route({ connected: false }) },
      { session: pi, addonHere: false, route: route({ runtime: 'incompatible' as const }) },
      { session: pi, addonHere: false, route: null },
      { session: claude, addonHere: false, route: route({ connected: false }) },
    ]) {
      expect(piNotLoadedHere(facts)).toBe(false)
      expect(arrives(facts).next).not.toContain(PI_RELOAD)
    }
    // Heard from under its id while not running here: another copy of the conversation has the add-on, as before
    expect(arrives({ session: pi, addonHere: false, route: route({ listening: true }) }).next).toContain('in another copy of it')
  })
})
