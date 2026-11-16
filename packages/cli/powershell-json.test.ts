// The form of JSON It tells an agent to give in PowerShell, held against how each PowerShell hands
// an argument to a program, as a model of each: the JSON in single quotes, beginning with a space,
// with each of its double quotes written `\"`. Codex reads that as plain words, so that its rule
// for `it` lets it run where nobody can approve a command, as in a conversation It reopened, where
// a command with `--%`, or with any of ’ ‘ “ ” – — ― in it, is refused (the Windows rehearsal).
// windows-answer.test.ts runs the same lines in the real PowerShells on Windows.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { json } from './src/args'
import { POWERSHELL_JSON } from './src/codex-settings'
import { WOKEN, WOKEN_POWERSHELL, wokenNote } from './src/wake'

/** The value PowerShell makes of a single-quoted string: what is between the quotes, with each `''` one apostrophe. */
const singleQuoted = (written: string) => {
  expect(written.startsWith("'") && written.endsWith("'"), written).toBe(true)
  return written.slice(1, -1).replaceAll("''", "'")
}
/** How a program on Windows reads its command line into words, as the C runtime and Node and Bun do. */
function commandLineWords(line: string): string[] {
  const words: string[] = []
  let word = ''
  let quoted = false
  let any = false
  for (let i = 0; i < line.length; ) {
    const c = line[i]!
    if (c === '\\') {
      let n = 0
      while (line[i] === '\\') {
        n++
        i++
      }
      if (line[i] === '"') {
        word += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) {
          word += '"'
          i++
        }
      } else word += '\\'.repeat(n)
      any = true
      continue
    }
    if (c === '"') {
      quoted = !quoted
      any = true
      i++
      continue
    }
    if ((c === ' ' || c === '\t') && !quoted) {
      if (any) words.push(word)
      word = ''
      any = false
      i++
      continue
    }
    word += c
    any = true
    i++
  }
  if (any) words.push(word)
  return words
}
/**
 * What Windows PowerShell 5.1 hands a program of one argument: the argument as it is, in double
 * quotes of its own only where it has a space outside quotes, counting every double quote, `\"` as
 * well; read back as the program reads its command line.
 */
function windowsPowerShell(value: string): string[] {
  let quotes = 0
  let spaced = false
  for (const c of value) {
    if (c === '"') quotes++
    else if (/\s/.test(c) && quotes % 2 === 0) spaced = true
  }
  return commandLineWords(spaced ? `"${value}"` : value)
}
/** What PowerShell 7.3 and later hand a program of one argument: the argument itself, whole. */
const powerShell7 = (value: string) => [value]

/** Every place It gives the form, with its own example of it. */
const page = readFileSync(new URL('../../addons/skill/more/page.md', import.meta.url), 'utf8')
const tour = readFileSync(new URL('tour/TOUR.md', import.meta.url), 'utf8')
const EXAMPLES: [string, string][] = [
  ['the refusal of JSON', /as in ('[^']*')/.exec(POWERSHELL_JSON)![1]!],
  ['a reopened Codex on Windows', /`it patch <id> ('.*?')`/.exec(WOKEN_POWERSHELL)![1]!],
  ['the tour', /```powershell\nit tour answer <the action's id> ('.*')\n```/.exec(tour)![1]!],
  ['the tour’s ideas', /`it patch tour-start ('.*?')`/.exec(tour)![1]!.replace('…', '\\"x\\"')],
  ['the skill', /`it\.exe patch board (' \{.*?')`/.exec(page)![1]!],
]

describe('JSON given in PowerShell as It says to give it', () => {
  test.each(EXAMPLES)('the form %s gives arrives as one word, read as the same JSON, from Windows PowerShell 5.1 and PowerShell 7', (_, written) => {
    const value = singleQuoted(written)
    expect(value.startsWith(' ')).toBe(true)
    const fromOld = windowsPowerShell(value)
    const fromNew = powerShell7(value)
    expect(fromOld).toHaveLength(1)
    const meant = json(fromOld[0]!, 'The patch', 'it patch p --file <path>')
    expect(meant).toBeTypeOf('object')
    expect(json(fromNew[0]!, 'The patch', 'it patch p --file <path>')).toEqual(meant)
  })

  test.each(EXAMPLES)('the form %s has nothing in it that Codex cannot read as plain words', (_, written) => {
    expect(written).not.toContain('--%')
    expect(written).not.toMatch(/[‘’“”–—―$|]/)
  })

  test('without the space before it, Windows PowerShell 5.1 splits JSON with a space in a value, and with it, it does not', () => {
    const value = String.raw`{\"note\":\"two words\"}`
    expect(windowsPowerShell(value)).toEqual(['{"note":"two', 'words"}'])
    expect(windowsPowerShell(` ${value}`)).toEqual([' {"note":"two words"}'])
    // And that is what It is given from PowerShell 7, which it reads as meant
    expect(json(` ${value}`, 'The patch', 'it patch p --file <path>')).toEqual({ note: 'two words' })
  })

  test('an apostrophe written as two, and a quotation mark, a long dash and a backslash written \\u0022, \\u2014 and \\u005c, arrive as themselves', () => {
    const value = singleQuoted(String.raw`' {\"say\":\"It''s a \u0022yes\u0022 \u2014 café ★\"}'`)
    for (const given of [windowsPowerShell(value), powerShell7(value)])
      expect(json(given[0]!, 'The answer', undefined, true)).toEqual({ say: `It's a "yes" — café ★` })
    // A backslash at the end of a value, written \u005c, where \\ would run into the \" after it
    const path = singleQuoted(String.raw`' {\"path\":\"C:\u005c\"}'`)
    for (const given of [windowsPowerShell(path), powerShell7(path)]) expect(json(given[0]!, 'The patch', 'it patch p --file <path>')).toEqual({ path: 'C:\\' })
  })

  test('a reopened Codex on Windows is told the form after what every reopened conversation is told, and no other app or system is', () => {
    expect(wokenNote('codex', 'win32')).toBe(`${WOKEN}\n\n${WOKEN_POWERSHELL}`)
    for (const [harness, platform] of [
      ['codex', 'linux'],
      ['codex', 'darwin'],
      ['claude-code', 'win32'],
      ['pi', 'win32'],
    ] as const)
      expect(wokenNote(harness, platform)).toBe(WOKEN)
    expect(WOKEN_POWERSHELL).toMatch(/^\[It\] /)
    expect(WOKEN_POWERSHELL).toContain('no `--%`')
    expect(WOKEN_POWERSHELL).toContain("`it set <id> <key> 'Pressed at noon'`")
  })
})
