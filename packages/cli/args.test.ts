import { describe, expect, test } from 'vitest'
import { BOOLEAN, parse, VALUED } from './src/args'

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

  test('every switch a command reads is taken, each as what it is, and what follows two dashes is words', () => {
    for (const name of BOOLEAN) expect(parse([`--${name}`]).flags[name]).toBe(true)
    for (const name of VALUED) expect(parse([`--${name}`, 'v']).flags[name]).toBe('v')
    expect([...BOOLEAN].filter((name) => VALUED.has(name))).toEqual([])
    expect(parse(['create', '--', '--not-a-switch'])._).toEqual(['create', '--not-a-switch'])
    expect(parse(['notify', 'x', '--button', 'A=a', '--button', 'B=b']).many.button).toEqual(['A=a', 'B=b'])
  })
})
