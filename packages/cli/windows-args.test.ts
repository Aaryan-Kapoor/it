// JSON read back from the command line on Windows, where Windows PowerShell 5.1 spoilt it on its
// way to the program. The lines here are built as each shell builds them; the Windows job of the
// main workflow runs the same commands through the real shells and the real standalone program
// (e2e/windows-json.mjs).
import { describe, expect, test } from 'vitest'
import { parse, json as readJson, setValue, text } from './src/args'
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

/** How many words each command reads before it refuses one more, as `noMore` in main.ts counts them. */
const MOST: Record<string, number> = { patch: 2, create: 1, tour: 3 }
/**
 * What a command does with JSON written as Windows PowerShell 5.1 hands it on: the line is built
 * as that PowerShell builds it, read back as the program reads it, and given to the very reading
 * the command does (`parse`, then `json` or `setValue`). The value it would change the state to,
 * or the sentence it refuses with.
 */
function outcome(args: string[]): { value: unknown } | { refused: string } {
  try {
    const [cmd, ...rest] = run(windowsPowerShell(args))
    const a = parse(rest)
    const most = MOST[cmd!]
    if (most !== undefined && a._.length > most) return { refused: `It does not know what to do with "${a._[most]}".` }
    if (cmd === 'patch') return { value: readJson(a._[1]!, 'The patch', 'it patch board --file <path>') }
    if (cmd === 'set') return { value: setValue(a._.slice(2).join(' '), 'it set board v --file <path>') }
    if (cmd === 'create') return { value: readJson(text(a, 'state')!, '--state', 'it create … --state-file <path>') }
    return { value: readJson(a._[2]!, 'The answer') }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

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
    expect(run(`"${IT}" set board steps {"build":"not yet"} --json`)).toEqual(['set', 'board', 'steps', '{"build":"not yet"}', '--json'])
    // A word with one dash is a key, as \`it\` reads it, and not an option
    expect(run(windowsPowerShell(['set', 'board', '-a', '{"x":"b c"}']))).toEqual(['set', 'board', '-a', '{"x":"b c"}'])
    // Read as `main` reads its words: one-dash words are not options, and what an option takes is skipped as \`it\` skips it
    for (const line of [
      `"${IT}" set board -open key {"x":1}`,
      `"${IT}" set board -state {"x":1} suffix`,
      `"${IT}" say board -state {"x":1} suffix`,
      `"${IT}" --json set board steps {"x":1}`,
    ])
      expect([line, wholeJson(line, given(line))]).toEqual([line, null])
    // Of two --state values only the last is read, so the one before it is never taken, nor the title after it
    const twice = `"${IT}" create --state "{ "x":"a b"}" --state {} --html hi`
    expect(wholeJson(twice, given(twice))).toBeNull()
    const equals = `"${IT}" create --state "{ "x":"a b"}" --state={} --html hi`
    expect(wholeJson(equals, given(equals))).toBeNull()
    expect(run(`"${IT}" patch board {"a":"b c"} --if-revision=3`)).toEqual(['patch', 'board', '{"a":"b c"}', '--if-revision=3'])
    expect(run(`"${IT}" tour answer k57abc {"say":"a b"} --no-wait`)).toEqual(['tour', 'answer', 'k57abc', '{"say":"a b"}', '--no-wait'])
  })
  test('`it patch`, `--state` and `it tour answer` either read the JSON exactly as written or refuse it, whatever form it is written in', () => {
    const forms: [string, string][] = [
      ['compact', '{"a":1,"b":"x - y"}'],
      ['spaced, with a dash in a string', '{"title": "Plan - draft", "n": 1}'],
      ['spaced, with a switch in a string', '{"note": "run with --verbose"}'],
      ['spaced, with a negative number', '{"n": -1, "m": "a b"}'],
      ['pretty-printed', '{\n  "a": 1,\n  "b": "x y"\n}'],
      ['beginning with a space', ' {"a":1}'],
      ['a backslash before a quote', String.raw`{"dir":"C:\\"}`],
      ['an escaped quote', String.raw`{"say":"she said \"hi\" twice"}`],
      ['an empty string with a space outside it', '{"name": "", "n": 1}'],
      ['a Windows path', String.raw`{"folder":"D:\\work"}`],
    ]
    for (const [what, json] of forms)
      for (const args of [
        ['patch', 'board', json, '--if-revision', '7'],
        ['patch', 'board', '--if-revision', '7', json],
        ['create', 'Plan', '--html', 'hi', '--state', json, '--open'],
        ['create', 'Plan', `--state=${json}`],
        ['tour', 'answer', 'k57abc', json, '--no-wait'],
      ]) {
        const done = outcome(args)
        expect([what, args, 'refused' in done || done.value]).toEqual([what, args, 'refused' in done || JSON.parse(json)])
      }
  })
  test('what the skill tells an agent on Windows is so: the habits it gives are read exactly, and `it set` changes what it says it changes', () => {
    // A Windows path, written with two backslashes or with forward slashes
    expect(outcome(['patch', 'board', String.raw`{"folder":"D:\\work"}`])).toEqual({ value: { folder: String.raw`D:\work` } })
    expect(outcome(['patch', 'board', '{"folder":"D:/work"}'])).toEqual({ value: { folder: 'D:/work' } })
    // No space outside the strings, every option before the JSON, and --state given its JSON as a word of its own
    expect(outcome(['patch', 'board', '{"a":1,"b":"x - y"}'])).toEqual({ value: { a: 1, b: 'x - y' } })
    expect(outcome(['patch', 'board', '--if-revision', '7', String.raw`{"dir":"C:\\"}`])).toEqual({ value: { dir: 'C:\\' } })
    expect(outcome(['create', 'Plan', '--state', '{"a":1}'])).toEqual({ value: { a: 1 } })
    // A space outside the strings is read too where no string has a space and then a dash, as the Windows check writes it
    expect(outcome(['patch', 'board', '--if-revision', '3', '{"a": 1, "b": "x y"}'])).toEqual({ value: { a: 1, b: 'x y' } })
    // And the forms those habits avoid are refused
    expect(outcome(['patch', 'board', '{"title": "Plan - draft", "n": 1}'])).toHaveProperty('refused')
    expect(outcome(['patch', 'board', String.raw`{"dir":"C:\\"}`, '--if-revision', '7'])).toHaveProperty('refused')
    expect(outcome(['create', 'Plan', '--state={"a":1}'])).toHaveProperty('refused')
    // `it set`: a JSON string loses its quotes, an array of such strings loses theirs, and an object with \" or "" in it may be taken as text
    expect(outcome(['set', 'board', 'v', '"true"'])).toEqual({ value: true })
    expect(outcome(['set', 'board', 'v', String.raw`"D:\\work"`])).toEqual({ value: String.raw`D:\\work` })
    expect(outcome(['set', 'board', 'order', '["1","2"]'])).toEqual({ value: [1, 2] })
    expect(outcome(['set', 'board', 'say', String.raw`{"say":"she said \"hi\""}`])).toEqual({ value: '{say:she said "hi"}' })
    expect(outcome(['set', 'board', 'who', '{"name": "", "n": 1}'])).toEqual({ value: '{name: ", n: 1}' })
    // Plain text, a number, true and false are set as they are written, and the rest goes through `it patch` whole
    expect(outcome(['set', 'board', 'status', 'Deploying 3 of 7'])).toEqual({ value: 'Deploying 3 of 7' })
    expect(outcome(['set', 'board', 'n', '4'])).toEqual({ value: 4 })
    expect(outcome(['set', 'board', 'done', 'false'])).toEqual({ value: false })
    expect(outcome(['patch', 'board', '{"order":["1","2"]}'])).toEqual({ value: { order: ['1', '2'] } })
    expect(outcome(['patch', 'board', String.raw`{"say":"she said \"hi\"","who":{"name":"","n":1}}`])).toEqual({
      value: { say: 'she said "hi"', who: { name: '', n: 1 } },
    })
  })
  test('what the skill says can be changed without a word is changed, and nothing else is', () => {
    // JSON whose first key is empty, or begins with a space, } or \", may be JSON as the runtime hands it on too, with nothing to show that it was spoilt
    expect(outcome(['patch', 'board', String.raw`{"\"a\"":"\"b\""}`])).toEqual({ value: { a: 'b' } })
    expect(outcome(['patch', 'board', String.raw`{" \"1\"":[]}`])).toEqual({ value: { 1: [] } })
    expect(outcome(['tour', 'answer', 'k57abc', String.raw`{"": "\":1"}`])).toEqual({ value: { ': ': 1 } })
    expect(outcome(['create', 'Plan', '--state', '{"} --html x": 1}'])).toEqual({ value: {} })
    // And JSON given to --state with --state inside one of its strings, which the runtime hands on as a --state of its own, the last one given
    expect(outcome(['create', 'Plan', '--state', String.raw`{"note": "then --state {\"a\":1} --agent ", "n": 1}`])).toEqual({ value: { a: 1 } })
    // The same JSON with a first key of plain letters, or given to `it patch`, is read as written or refused
    expect(outcome(['patch', 'board', String.raw`{"k":"\"b\""}`])).toEqual({ value: { k: '"b"' } })
    expect(outcome(['patch', 'board', String.raw`{"note": "then --state {\"a\":1} --agent ", "n": 1}`])).toHaveProperty('refused')
    // `it set`: an object or array with \" in it is set as other JSON, text with a double quote in it arrives changed, and text that ends in a backslash takes the quote PowerShell closed it with
    expect(outcome(['set', 'board', 'v', String.raw`["\"a\""]`])).toEqual({ value: ['a'] })
    expect(outcome(['set', 'board', 'v', String.raw`{"\"a\"":1}`])).toEqual({ value: { a: 1 } })
    expect(outcome(['set', 'board', 'note', 'she said "hi"'])).toEqual({ value: 'she said hi' })
    expect(outcome(['set', 'board', 'note', 'x "" y'])).toEqual({ value: 'x " y' })
    expect(outcome(['set', 'board', 'dir', 'C:\\Program Files\\'])).toEqual({ value: 'C:\\Program Files"' })
    // Text with no double quote in it and no backslash at its end is set as it is written
    expect(outcome(['set', 'board', 'dir', 'D:\\My Files\\work'])).toEqual({ value: 'D:\\My Files\\work' })
    expect(outcome(['set', 'board', 'note', 'It’s done - 3 of 7, at D:/work'])).toEqual({ value: 'It’s done - 3 of 7, at D:/work' })
  })
  test('a refusal says that a backslash is written twice only where one was written once, whatever quotes the runtime left', () => {
    const TWICE = 'a backslash inside a JSON string is written twice'
    // Written as JSON has them, and refused for the option after it: the refusal does not tell the agent to double backslashes it wrote twice
    const right = outcome(['patch', 'board', String.raw`{"say":"\"hi","dir":"C:\\"}`, '--if-revision', '7'])
    expect(right).toHaveProperty('refused')
    expect('refused' in right && right.refused).not.toContain(TWICE)
    // Written once, beside a string with \" in it, which leaves quotes that mark no string: the refusal says so
    const wrong = outcome(['patch', 'board', String.raw`{"say":"\"hi\"","folder":"D:\work"}`])
    expect('refused' in wrong && wrong.refused).toContain(TWICE)
    expect(outcome(['patch', 'board', String.raw`{"folder":"D:\work"}`])).toEqual({ refused: expect.stringContaining(TWICE) })
  })
  test('across JSON of every awkward kind, nothing is read as something else but the JSON the skill names', () => {
    // The same JSON in every run, from a generator with a fixed seed: its strings are made of what a shell, the runtime or a command could take for its own
    let seed = 20261118
    const below = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
    const PIECES = [
      'a',
      'b c',
      ' ',
      '-',
      ' - ',
      '--x',
      ' --replace ',
      '"',
      '\\',
      '\\\\',
      '{',
      '}',
      '[',
      ']',
      ',',
      ':',
      '1',
      'true',
      "'",
      ' -1',
      'C:\\dir\\',
      '',
    ]
    // And what a command would take for an option of its own, where the runtime hands it on as a word
    PIECES.push(' --state {"a":1}', ' --state {}', ' --state=', ' --if-revision 3', ' --agent x', ' --open', ' --no-wait', ' --file x')
    const words = () => Array.from({ length: below(4) }, () => PIECES[below(PIECES.length)]).join('')
    const key = (i: number) => [`k${i}`, `k${i}`, words(), `"${words()}"`][below(4)]!
    const value = (depth: number): unknown => {
      const kind = below(depth > 1 ? 5 : 7)
      if (kind < 3) return words()
      if (kind === 3) return below(100) - 50
      if (kind === 4) return [true, false, null][below(3)]
      if (kind === 5) return object(depth + 1)
      return Array.from({ length: below(3) }, () => value(depth + 1))
    }
    const object = (depth: number) => Object.fromEntries(Array.from({ length: 1 + below(3) }, (_, i) => [key(i), value(depth)]))
    let read = 0
    let refused = 0
    let changed = 0
    for (let n = 0; n < 400; n++) {
      const written = object(0)
      const first = Object.keys(written)[0]!
      const named = first === '' || first.startsWith(' ') || first.startsWith('}') || first.startsWith('"')
      for (const json of [JSON.stringify(written), JSON.stringify(written).replaceAll('":', '": ').replaceAll(',"', ', "'), JSON.stringify(written, null, 2)])
        for (const args of [
          ['patch', 'board', json],
          ['patch', 'board', '--if-revision', '7', json],
          ['patch', 'board', json, '--replace'],
          ['create', 'Plan', '--html', 'hi', '--state', json, '--open'],
          ['create', 'Plan', `--state=${json}`],
          ['tour', 'answer', 'k57abc', json, '--no-wait'],
        ]) {
          const done = outcome(args)
          if ('refused' in done) refused++
          else if (JSON.stringify(done.value) === JSON.stringify(JSON.parse(json))) read++
          else {
            changed++
            expect([args, named || (args[0] === 'create' && json.includes('--state'))]).toEqual([args, true])
          }
        }
    }
    // Each of the three is met, so that the test holds what it says
    expect([read > 1000, refused > 1000, changed > 0]).toEqual([true, true, true])
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
