// JSON read back from the command line on Windows, where Windows PowerShell 5.1 spoilt it on its
// way to the program. The lines here are built as each shell builds them; the Windows job of the
// main workflow runs the same commands through the real shells and the real standalone program
// (e2e/windows-json.mjs).
import { describe, expect, test } from 'vitest'
import { WOKEN, WOKEN_POWERSHELL, wokenNote } from './src/wake'
import { commandLineWords, jsonEnd, wholeJson } from './src/windows-args'

const IT = 'C:\\Users\\Ana Lee\\.it\\bin\\it.exe'

/**
 * The line Windows PowerShell 5.1 builds for a program: each argument as it is, in quotes of its
 * own only where it has a space or tab outside quotes, counting every double quote as one.
 */
function windowsPowerShell(args: string[]): string {
  const each = args.map((a) => {
    let quotes = 0
    let spaced = a === ''
    for (const c of a) {
      if (c === '"') quotes++
      else if ((c === ' ' || c === '\t') && quotes % 2 === 0) spaced = true
    }
    return spaced ? `"${a}"` : a
  })
  return [`"${IT}"`, ...each].join(' ')
}
/** The line PowerShell 7.3 and later, Git Bash and Node build: each argument written so that the program reads it back exactly. */
function escaped(args: string[]): string {
  const each = args.map((a) => {
    if (a !== '' && !/[\s"]/.test(a)) return a
    return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  })
  return [`"${IT}"`, ...each].join(' ')
}
/** What the program is given of a line, after its own name: the runtime's own reading of it. */
const given = (line: string) =>
  commandLineWords(line)
    .slice(1)
    .map((w) => w.value)
/** What a command is run with: what it was given, or that with the JSON taken whole from the line. */
const run = (line: string) => wholeJson(line, given(line)) ?? given(line)

describe('JSON spoilt by Windows PowerShell 5.1 is read whole from the command line', () => {
  const cases: [string, string[]][] = [
    ['an object with no space', ['patch', 'board', '{"number":4}']],
    ['a space inside a string', ['patch', 'board', '{"note":"two words"}']],
    ['a space between members', ['patch', 'board', '{"a":1, "b":"x y"}']],
    ['a quote inside a string, written \\"', ['patch', 'board', '{"say":"she said \\"hi\\" twice"}']],
    ['a backslash, and one at the end of a string', ['patch', 'board', '{"path":"C:\\\\Users\\\\ana\\\\","n":"a\\\\b"}']],
    ['letters outside ASCII, and escapes for them', ['patch', 'board', '{"say":"Café 12×12 \\u2014 ★ 支付"}']],
    ['brackets inside strings', ['patch', 'board', '{"say":"a } and a ] and a {"}']],
    ['an array', ['set', 'board', 'order', '["c1", "c 2"]']],
    ['a switch after the JSON', ['patch', 'board', '{"total":42, "of":"all of it"}', '--if-revision', '7']],
    ['a switch before it, and one whose value is JSON', ['create', 'Plan', '--html', '<p>{x}</p>', '--state', '{"steps":{"build":"not yet"}}', '--open']],
    ['the tour’s answer', ['tour', 'answer', 'k57abc', '{"say":"Right: 12 × 12 is 144, a square’s area."}']],
    ['a switch inside a string, which is not one', ['patch', 'board', '{"note":"run --replace now"}']],
  ]
  test.each(cases)('%s', (_, args) => {
    const line = windowsPowerShell(args)
    expect(run(line)).toEqual(args)
  })
  test('and where the JSON came whole, as from PowerShell 7, Git Bash, cmd written for it, or Node, nothing is taken', () => {
    for (const [, args] of cases) {
      const line = escaped(args)
      expect(given(line)).toEqual(args)
      expect(wholeJson(line, given(line))).toBeNull()
    }
    // cmd, with the JSON written as the program reads it
    expect(wholeJson(`${IT} patch board "{\\"a\\":\\"b c\\"}"`, ['patch', 'board', '{"a":"b c"}'])).toBeNull()
  })
  test('JSON typed bare in cmd, which cmd hands on as it is, is read whole too', () => {
    expect(run(`"${IT}" patch board {"a":"b c"}`)).toEqual(['patch', 'board', '{"a":"b c"}'])
  })
  test('an array that is JSON as it arrives is left as it is, though Windows PowerShell 5.1 turned its strings into numbers, since cmd hands on the same line for those numbers', () => {
    expect(wholeJson(windowsPowerShell(['set', 'board', 'order', '["1","2"]']), ['set', 'board', 'order', '[1,2]'])).toBeNull()
  })
  test('under Node, with the script’s name after the runtime’s, the words after both are read', () => {
    const line = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ana\\it\\dist\\it.mjs" patch board {"note":"two words"}`
    expect(wholeJson(line, ['patch', 'board', '{note:two words}'])).toEqual(['patch', 'board', '{"note":"two words"}'])
  })
})

describe('nothing is taken where it is not JSON spoilt on the way, so no command becomes another', () => {
  test('text that begins with a bracket and is not JSON is left as it was given', () => {
    for (const args of [
      ['set', 'board', 'label', '[beta] notes'],
      ['set', 'board', 'label', '[1] apples'],
      ['set', 'board', 'label', '{x}'],
      ['say', 'board', '{', 'not', 'json'],
      ['patch', 'board', '{"a":1,}'],
      ['patch', 'board', '{"a":"never closed'],
    ]) {
      const line = windowsPowerShell(args)
      expect([args, wholeJson(line, given(line))]).toEqual([args, null])
    }
  })
  test('a value that is JSON on the line but runs on into more of the word is not taken', () => {
    // `{"a":1}x` is one word; its JSON part alone would leave the x out
    expect(wholeJson(`${IT} patch board {"a":1}x`, ['patch', 'board', '{a:1}x'])).toBeNull()
    // In quotes the shell put there, the JSON must be all of what is in them
    expect(wholeJson(`${IT} set board label "[1] apples"`, ['set', 'board', 'label', '[1] apples'])).toBeNull()
  })
  test('where the line does not split back into exactly what the program was given, nothing is taken from it', () => {
    const line = windowsPowerShell(['patch', 'board', '{"note":"two words"}'])
    expect(wholeJson(line, ['patch', 'board', '{note:two', 'words}', 'more'])).toBeNull()
    expect(wholeJson(line, ['patch', 'other', '{note:two', 'words}'])).toBeNull()
    expect(wholeJson('', ['patch', 'board', '{note:two', 'words}'])).toBeNull()
  })
  test('words that are not spoilt JSON keep their place and their value, whatever comes before or after', () => {
    const args = ['patch', 'board', '{"note":"two words"}', '--if-revision', '7']
    const line = windowsPowerShell(args)
    expect(given(line)).toEqual(['patch', 'board', '{note:two words}', '--if-revision', '7'])
    expect(run(line)).toEqual(args)
  })
  test('separate arguments are never joined, quotes that are part of a word are never dropped, and nothing outside the JSON becomes a switch', () => {
    // Two words that together would be JSON, as `it say board "[1," "2]"` hands them on
    expect(wholeJson(`"${IT}" say board [1, 2]`, ['say', 'board', '[1,', '2]'])).toBeNull()
    // A file whose name has apostrophes in it, as `it patch board --file "'[1]'"` hands it on
    expect(wholeJson(`"${IT}" patch board --file '[1]'`, ['patch', 'board', '--file', "'[1]'"])).toBeNull()
    // One argument, `{"x":"\\"} --replace`, which PowerShell 7's older way of counting quotes left without quotes round it
    const legacy = String.raw`"${IT}" patch board {"x":"\\"} --replace`
    expect(given(legacy)).toEqual(['patch', 'board', String.raw`{x:\}`, '--replace'])
    expect(wholeJson(legacy, given(legacy))).toBeNull()
    // And bare in cmd, with a space outside its strings, JSON is not taken, since it may be two arguments
    expect(given(`"${IT}" patch board {"a":1, "b":2}`)).toHaveLength(4)
    expect(wholeJson(`"${IT}" patch board {"a":1, "b":2}`, given(`"${IT}" patch board {"a":1, "b":2}`))).toBeNull()
  })
  test('a value is taken only where the line reads in no other way', () => {
    // The value of an option that takes no JSON, as cmd hands on `--file ["1"]`
    const file = `"${IT}" patch board --file ["1"]`
    expect(given(file)).toEqual(['patch', 'board', '--file', '[1]'])
    expect(wholeJson(file, given(file))).toBeNull()
    // An argument with quotes of its own round it, '"{"x":1}"', which PowerShell would not have put there
    const quoted = windowsPowerShell(['patch', 'board', '"{"x":1}"'])
    expect(wholeJson(quoted, given(quoted))).toBeNull()
    // Quotes round words that, as one argument, PowerShell would have handed on bare: cmd's "{"x":" --replace "}"
    const switched = `"${IT}" patch board "{"x":" --replace "}"`
    expect(given(switched)).toContain('--replace')
    expect(wholeJson(switched, given(switched))).toBeNull()
    // A backslash just before a quote, then more words: PowerShell 7's older way may have built that from one argument
    const trailing = windowsPowerShell(['patch', 'board', String.raw`{"path":"C:\\"}`, '--if-revision', '3'])
    expect(wholeJson(trailing, given(trailing))).toBeNull()
  })
  test('a quote inside a string written \\", then more words, is still taken, since every PowerShell puts quotes round more than that', () => {
    const args = ['patch', 'board', String.raw`{"say":"she said \"hi\" twice"}`, '--if-revision', '3']
    expect(run(windowsPowerShell(args))).toEqual(args)
  })
  test('two arguments that make one JSON value with a space inside a string read the same on the line as that one argument, and are taken as it', () => {
    // `it patch board '{"x":"a' 'b"}'`, which nobody writes for anything else
    const line = windowsPowerShell(['patch', 'board', '{"x":"a', 'b"}'])
    expect(run(line)).toEqual(['patch', 'board', '{"x":"a b"}'])
  })
  test('only where a command takes JSON: never from a key, a file’s name or text, which cmd reads with its quotes as quoting', () => {
    for (const line of [
      `"${IT}" set board ["a"] 42`,
      `"${IT}" set board n ["a\\"b"]`,
      `"${IT}" set board n ["a"] tail`,
      `"${IT}" say board ["a"]`,
      `"${IT}" save k57abc ["a"]`,
      `"${IT}" patch board --file ["a"]`,
      `"${IT}" patch board {"a":1} {"b":2}`,
    ])
      expect([line, wholeJson(line, given(line))]).toEqual([line, null])
    // And where it does, with options anywhere around it
    expect(run(`"${IT}" --json set board steps {"build":"not yet"}`)).toEqual(['--json', 'set', 'board', 'steps', '{"build":"not yet"}'])
    expect(run(`"${IT}" tour answer k57abc {"say":"a b"} --no-wait`)).toEqual(['tour', 'answer', 'k57abc', '{"say":"a b"}', '--no-wait'])
  })
  test('a line with no spoilt word is never read', () => {
    expect(wholeJson(`${IT} patch board {"a":1}`, ['patch', 'board', '{"a":1}'])).toBeNull()
    expect(wholeJson(`${IT} status`, ['status'])).toBeNull()
  })
})

describe('the scan of a JSON value on the line', () => {
  test('ends after the bracket that closes the first, with strings and their escapes passed over', () => {
    const line = '{"a":"x}\\"]","b":[1,{"c":2}]} rest'
    expect(line.slice(0, jsonEnd(line, 0))).toBe('{"a":"x}\\"]","b":[1,{"c":2}]}')
    expect(jsonEnd('[1,2', 0)).toBe(-1)
    expect(jsonEnd('{"a":"]}', 0)).toBe(-1)
  })
  test('splits a line as the C runtime does, and as shell32 does where they differ', () => {
    const line = `${IT} a "b c" d\\"e "f""g" h\\\\"i j"`
    expect(commandLineWords(line, 'crt').map((w) => w.value)).toEqual([IT.split(' ')[0], 'Lee\\.it\\bin\\it.exe', 'a', 'b c', 'd"e', 'f"g', 'h\\i j'])
    expect(commandLineWords(`"${IT}" x`).map((w) => w.value)).toEqual([IT, 'x'])
    expect(commandLineWords(`"${IT}" "a""b c"`, 'crt').map((w) => w.value)).toEqual([IT, 'a"b c'])
    expect(commandLineWords(`"${IT}" "a""b c"`, 'shell32').map((w) => w.value)).toEqual([IT, 'a"b', 'c'])
  })
})

test('a reopened Codex on Windows is told to write JSON as anywhere, never after `--%`, and with what Codex refuses written as escapes; no other app or system is told it', () => {
  expect(wokenNote('codex', 'win32')).toBe(`${WOKEN}\n\n${WOKEN_POWERSHELL}`)
  for (const [app, system] of [
    ['codex', 'linux'],
    ['codex', 'darwin'],
    ['claude-code', 'win32'],
    ['pi', 'win32'],
  ] as const)
    expect(wokenNote(app, system)).toBe(WOKEN)
  expect(WOKEN_POWERSHELL).toMatch(/^\[It\] /)
  expect(WOKEN_POWERSHELL).toContain('never after `--%`')
  expect(WOKEN_POWERSHELL).toContain('`\\u2014`')
})
