// What It puts on Codex's command line, held to what the real Codex says it takes. It runs only
// where IT_E2E_CODEX names a Codex program, which the workflow for the real Codex
// (.github/workflows/app-codex.yml) installs; everywhere else it is skipped.
//
// Auto-wake reopens a closed Codex conversation with `codex exec resume`, in the words that
// `carrying` in packages/cli/src/wake.ts gives, which are read from there and not copied here.
// The connector puts a click into an open conversation with `codex queue --thread=<id>
// --message=<text>` (`codexQueue` in packages/cli/src/connector.ts), which builds those words
// where it runs them and gives them nowhere else, so they are copied here: e2e/apps/codex.mjs is
// what runs the connector's own call against the real Codex. A flag that Codex has
// renamed or dropped would show on the page as "Couldn’t wake", or leave the click waiting.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { carrying } from '../../../packages/cli/src/wake.ts'

const program = process.env.IT_E2E_CODEX

describe.skipIf(!program)('the flags It gives the real Codex', () => {
  // Codex is asked only for its help, in a home of its own
  const home = mkdtempSync(path.join(os.tmpdir(), 'it-codex-flags-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const help = (...words) => {
    const r = spawnSync(program, [...words, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home } })
    expect(r.status, `codex ${words.join(' ')} --help: ${r.stderr}`).toBe(0)
    return r.stdout
  }
  /** Whether a help text names an option, as `-c, --config <key=value>` names both of its forms. */
  const names = (text, option) => new RegExp(`(^|[\\s,])${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,=<\\[]|$)`, 'm').test(text)

  test('Auto-wake’s `codex exec resume`, with every option It passes and the conversation and `-` after them', () => {
    const session = '01a1d400-7e98-7710-b80c-884d0c4c7e28'
    const carried = carrying('codex', session, 'what was done on the page', { codex: [program], itHome: path.join(home, 'it'), platform: 'linux' })
    expect(typeof carried, String(carried)).toBe('object')
    const [first, second, ...rest] = carried.argv.slice(1)
    expect([first, second]).toEqual(['exec', 'resume'])
    const text = help('exec', 'resume')
    // What follows the options: the conversation, and `-` for the message on standard input
    expect(rest.slice(-2)).toEqual([session, '-'])
    expect(text).toMatch(/Usage: codex exec resume \[OPTIONS\] \[SESSION_ID\] \[PROMPT\]/)
    expect(text).toMatch(/If `-` is used, read from stdin/)
    expect(carried.input).toBe('what was done on the page')
    const options = rest.slice(0, -2).filter((word) => word.startsWith('-'))
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) expect(names(text, option), `codex exec resume takes ${option}`).toBe(true)
  })

  test('`codex queue --thread=<id> --message=<text>`, in the words the connector uses, copied from it', () => {
    const text = help('queue')
    expect(text).toMatch(/Usage: codex queue \[OPTIONS\] --thread <THREAD> --message <TEXT>/)
    for (const option of ['--thread', '--message']) expect(names(text, option), `codex queue takes ${option}`).toBe(true)
  })
})
