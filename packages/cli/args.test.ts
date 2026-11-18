import { describe, expect, test } from 'vitest'
import { BOOLEAN, commandLine, json, parse, strayBackslash, VALUED } from './src/args'

/** The code and the sentence a command line is refused with, or nothing where it is taken. */
const refused = (argv: string[]) => {
  try {
    parse(argv)
    return undefined
  } catch (err) {
    return [(err as { code?: string }).code, (err as Error).message]
  }
}

describe('what a command line is read as', () => {
  test('a switch no command reads is refused, wherever it stands, and nothing after it is taken for its value', () => {
    expect(refused(['network', '--quiet', 'on'])).toEqual(['invalid', '--quiet is not something `it` knows.'])
    expect(refused(['setup', '--no-services', '--none'])).toEqual(['invalid', '--no-services is not something `it` knows.'])
    expect(refused(['ack', 'an-id', '--fail', '--failed'])).toEqual(['invalid', '--fail is not something `it` knows.'])
    expect(refused(['list', '--frobnicate=1', '--json'])).toEqual(['invalid', '--frobnicate is not something `it` knows.'])
  })

  test('a switch that takes a value is not given another switch for one, unless the value is written with an equals sign', () => {
    expect(refused(['create', 'T', '--dir', '--open'])).toEqual(['invalid', '--dir needs a value, and what follows it is --open.'])
    expect(refused(['create', 'T', '--html'])).toEqual(['invalid', '--html needs a value.'])
    expect(parse(['create', 'T', '--html=--x', '--open'])).toMatchObject({ _: ['create', 'T'], flags: { html: '--x', open: true } })
    // A lone dash and a negative number are values like any other
    expect(parse(['wait', '--timeout', '-1', '--id', '-'])).toMatchObject({ flags: { timeout: '-1', id: '-' } })
  })

  test('PowerShell’s `--%` is dropped where it stands first and nowhere else, and changes nothing after it', () => {
    const words = ['tour', 'answer', 'k57abc', '{"say":"It’s 100%"}']
    expect(commandLine(['--%', ...words])).toEqual(words)
    expect(commandLine(words)).toEqual(words)
    expect(commandLine(['--%', '--%', ...words])).toEqual(['--%', ...words])
    expect(commandLine(['tour', '--%', 'answer'])).toEqual(['tour', '--%', 'answer'])
    expect(refused(['answer', '--%'])).toEqual(['invalid', '--% is not something `it` knows.'])
  })

  test('every switch a command reads is taken, each as what it is, and what follows two dashes is words', () => {
    for (const name of BOOLEAN) expect(parse([`--${name}`]).flags[name]).toBe(true)
    for (const name of VALUED) expect(parse([`--${name}`, 'v']).flags[name]).toBe('v')
    expect([...BOOLEAN].filter((name) => VALUED.has(name))).toEqual([])
    expect(parse(['create', '--', '--not-a-switch'])._).toEqual(['create', '--not-a-switch'])
    expect(parse(['notify', 'x', '--button', 'A=a', '--button', 'B=b']).many.button).toEqual(['A=a', 'B=b'])
  })
})

describe('JSON with a backslash that begins no escape', () => {
  test('is found where a backslash inside a string is followed by anything JSON does not read after one, and nowhere else', () => {
    for (const text of [
      String.raw`{"folder":"D:\work"}`,
      String.raw`{"folder":"C:\Users\ana"}`,
      String.raw`{"a":"\u12"}`,
      '{"a":"x\\',
      String.raw`{folder:D:\work}`,
      String.raw`{folder:C:\Users\ana}`,
      // Without its quotes but for one that was written \" inside a string, which marks no string: what Windows PowerShell 5.1 leaves of {"say":"\"hi\"","folder":"D:\work"}
      String.raw`{say:"hi",folder:D:\work}`,
    ])
      expect([text, strayBackslash(text)]).toEqual([text, true])
    for (const text of [
      String.raw`{"folder":"D:\\work"}`,
      String.raw`{"say":"she said \"hi\""}`,
      String.raw`{"a":"\/\b\f\n\r\t\u00e9\u2014"}`,
      String.raw`{"dir":"C:\\"}`,
      '{"a":1,}',
      // Outside a string, where writing it twice would mend nothing
      String.raw`{"x":\wrong}`,
      // Without its quotes, where the backslash may be half of the two that \"C:\\\\\" had before its quote was taken out
      String.raw`{dir:C:\}`,
      String.raw`{dir:C:\,x:1}`,
      // The same where a quote written \" is left, as of {"say":"\"hi","dir":"C:\\"} with an option after it: the quote opens no string, and the backslash was written twice
      String.raw`{say:"hi,dir:C:\}`,
      String.raw`{say:"hi,dir:C:\\x}`,
    ])
      expect([text, strayBackslash(text)]).toEqual([text, false])
  })
  test('is refused with a sentence that says a backslash inside a JSON string is written twice, and how the JSON is read is not changed', () => {
    const refusal = (text: string, fromFile?: string) => {
      try {
        json(text, 'The patch', fromFile)
        return undefined
      } catch (err) {
        return [(err as Error).message, (err as { hint?: string }).hint]
      }
    }
    expect(refusal(String.raw`{"folder":"D:\work"}`, 'it patch board --file <path>')).toEqual([
      'The patch is not valid JSON: a backslash inside a JSON string is written twice, and this arrived with one: write two, or forward slashes, as in "D:/work".',
      undefined,
    ])
    expect(refusal('{"a":1,}', 'it patch board --file <path>')).toEqual([
      'The patch is not valid JSON.',
      'Write the JSON to a file and run `it patch board --file <path>`, which works the same in every shell.',
    ])
    expect(json(String.raw`{"folder":"D:\\work"}`, 'The patch')).toEqual({ folder: String.raw`D:\work` })
  })
})
