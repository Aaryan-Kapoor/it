// What PowerShell hands a program from the lines an agent writes there for a tour's answer or a
// page's state. The form the guide and a reopened Codex are given is the JSON in single quotes,
// beginning with a space, with each of its double quotes written `\"`:
// `it tour answer <id> ' {\"say\":\"…\"}'`. Codex reads that as plain words and lets its rule for
// `it` run it, where it refuses a command with `--%` in it when nobody can approve it (the Windows
// rehearsal). Windows PowerShell 5.1 would split it at a space in a value but for the space before
// it, and hands it on in quotes, where a program reading its command line makes each `\"` a double
// quote; PowerShell 7.3 and later hand the backslashes on too, which It reads as meant
// (`quotesEscaped`).
// A command line is UTF-16 on Windows, so letters outside ASCII arrive whole, where what is piped
// arrives in ASCII from Windows PowerShell 5.1, so that × arrived on the whiteboard as "?" (seen
// in the Windows rehearsal). A program stands in for It here, which writes down what it was given.
// Run on Windows alone, where those PowerShells are.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { json } from './src/args'

/** Whether a PowerShell of that name runs here. */
const runs = (shell: string) => process.platform === 'win32' && spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status === 0

describe.runIf(process.platform === 'win32')('an answer of the tour, as PowerShell hands it to a program', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-ps-answer-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  // Writes what it was given to a file as JSON, which no console's code page can change
  const echo = path.join(dir, 'echo.mjs')
  const out = path.join(dir, 'out.json')
  writeFileSync(echo, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
  const program = `& ${JSON.stringify(process.execPath)} ${JSON.stringify(echo)}`
  /** Runs a line in a PowerShell as an agent app does, and gives what the stand-in for It was given. */
  const given = (shell: string, line: string) => {
    rmSync(out, { force: true })
    const ran = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    return JSON.parse(readFileSync(out, 'utf8')) as string[]
  }
  // The words as the guide has them written there: a space before the JSON, an apostrophe as two, a double quotation mark
  // as \u0022 and a long dash as \u2014, since a command with ’ “ ” or a long dash in it is one Codex refuses
  const WRITTEN = String.raw` {\"say\":\"Area = side × side, so it''s 144 \u2014 a \u0022square\u0022 ★ for café\"}`
  const MEANT = { say: `Area = side × side, so it's 144 — a "square" ★ for café` }
  for (const shell of ['powershell.exe', 'pwsh'])
    test.runIf(runs(shell))(`in ${shell}, the JSON in single quotes after a space, with its quotes written \\", arrives whole and is read as meant`, () => {
      const args = given(shell, `${program} tour answer k57abc '${WRITTEN}'`)
      expect(args.slice(0, 3)).toEqual(['tour', 'answer', 'k57abc'])
      expect(json(args[3]!, 'The answer', undefined, true)).toEqual(MEANT)
      // And `it patch` and `it set`, which read their JSON the same way
      const patch = given(shell, String.raw`${program} patch plan ' {\"steps\":{\"build\":\"done, at last\"}}'`)
      expect(json(patch[2]!, 'The patch', 'it patch plan --file <path>')).toEqual({ steps: { build: 'done, at last' } })
      // Text for `it set` in single quotes needs no JSON, and arrives as one word, spaces and all
      expect(given(shell, `${program} set plan status 'Pressed at noon, and done'`)).toEqual(['set', 'plan', 'status', 'Pressed at noon, and done'])
    })
  test.runIf(runs('powershell.exe'))(
    'in powershell.exe, `--%` with the JSON in double quotes and its quotes written \\" arrives whole as well, though Codex will not run it unasked',
    () => {
      const WORDS = 'Area = side × side, so it’s 144 — a “square” ★'
      const line = `${program} --% tour answer k57abc "${JSON.stringify({ say: WORDS }).replaceAll('"', '\\"')}"`
      const args = given('powershell.exe', line)
      expect(args.slice(0, 3)).toEqual(['tour', 'answer', 'k57abc'])
      expect(JSON.parse(args[3]!)).toEqual({ say: WORDS })
    },
  )
})
