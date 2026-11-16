// What Windows PowerShell 5.1 hands a program from `--%` and JSON in double quotes with its own
// written `\"`: `it --% tour answer <id> "{\"say\":\"…\"}"`, which agents were taught there and
// It still takes, and which hands the rest of the line over as it is written, letters outside
// ASCII whole, where what is piped arrives in ASCII (so that × arrived as "?" on the whiteboard in
// the Windows rehearsal). JSON in single quotes, which the guide teaches now, is checked through
// the real shells and the real program by e2e/windows-json.mjs. A program stands in for It here,
// which prints what it was given. Run on Windows alone, where that PowerShell is.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

describe.runIf(process.platform === 'win32')('an answer of the tour, as Windows PowerShell 5.1 hands it to a program', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-ps-answer-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  // Writes what it was given to a file as JSON, which no console's code page can change
  const echo = path.join(dir, 'echo.mjs')
  const out = path.join(dir, 'out.json')
  writeFileSync(echo, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
  const WORDS = 'Area = side × side, so it’s 144 — a “square” ★'
  /** Runs a line in Windows PowerShell 5.1 as an agent app does, and gives what the stand-in for It was given. */
  const given = (line: string) => {
    rmSync(out, { force: true })
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    return JSON.parse(readFileSync(out, 'utf8')) as string[]
  }
  test('the tour’s form, with `--%` and its quotes written \\", arrives whole, letters outside ASCII and all', () => {
    const json = JSON.stringify({ say: WORDS })
    const line = `& ${JSON.stringify(process.execPath)} ${JSON.stringify(echo)} --% tour answer k57abc "${json.replaceAll('"', '\\"')}"`
    const args = given(line)
    expect(args.slice(0, 3)).toEqual(['tour', 'answer', 'k57abc'])
    expect(JSON.parse(args[3]!)).toEqual({ say: WORDS })
  })
})
