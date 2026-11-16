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
    ['two of them', ['patch', 'a', '{"x":"1 2"}', '--replace', '{"y":"3 4"}']],
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
  test('JSON typed bare in cmd, or in its single quotes, which cmd hands on as they are, is read whole too', () => {
    expect(run(`"${IT}" patch board {"a":"b c"}`)).toEqual(['patch', 'board', '{"a":"b c"}'])
    expect(run(`"${IT}" patch board '{"a":"b c"}'`)).toEqual(['patch', 'board', '{"a":"b c"}'])
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
