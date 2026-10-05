// What the program needs of Node when it is run as a script: which versions it runs under, and
// that Node's own notice about its database module is the one warning kept off the terminal.
import { afterEach, describe, expect, test } from 'vitest'
import { nodeTooOld, quietAboutItsDatabase } from './src/node'

describe('the Node this program is run under', () => {
  test('is new enough from 22.13 on, and under anything older the person is told in one sentence which Node is needed', () => {
    for (const version of ['22.13.0', '22.22.3', '23.4.0', '23.11.1', '24.0.0', '24.18.0', '25.1.0', '100.0.0'])
      expect([version, nodeTooOld(version)]).toEqual([version, undefined])
    for (const version of ['22.12.0', '22.0.0', '22.3.0', '20.20.0', '18.19.1', '9.11.2']) {
      const refused = nodeTooOld(version)!
      expect([version, refused.code, refused.message]).toEqual([version, 'unsupported', `It needs Node 22.13 or later, and this is Node ${version}.`])
      expect(refused.hint).toBe('Run it under a newer Node, or install the standalone `it` program, which needs no Node at all.')
    }
    // The one this test runs under is one it runs under
    expect(nodeTooOld(process.versions.node)).toBeUndefined()
  })

  test('the first releases of Node 23 are newer than 22.13 and still need a flag for their database, so they are refused, and told which Node 23 is needed', () => {
    for (const version of ['23.0.0', '23.1.0', '23.3.0']) {
      const refused = nodeTooOld(version)!
      expect([version, refused.code, refused.message]).toEqual([
        version,
        'unsupported',
        `It needs Node 23.4 or later among the releases of Node 23, and this is Node ${version}.`,
      ])
      expect(refused.hint).toBe('Run it under a newer Node, or install the standalone `it` program, which needs no Node at all.')
    }
  })
})

describe('what Node says of itself', () => {
  const emit = process.emitWarning
  afterEach(() => {
    process.emitWarning = emit
  })

  test('that its database module is experimental is kept off the terminal, and every other warning is passed on as it was', async () => {
    const passed: unknown[][] = []
    process.emitWarning = ((...args: unknown[]) => void passed.push(args)) as typeof process.emitWarning
    quietAboutItsDatabase()
    // As Node itself says it, in both of the ways a warning is given
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')
    process.emitWarning('SQLite is an experimental feature and might change at any time', { type: 'ExperimentalWarning' })
    expect(passed).toEqual([])
    process.emitWarning('Something else is an experimental feature', 'ExperimentalWarning')
    process.emitWarning('SQLite could not be opened', 'DeprecationWarning')
    process.emitWarning(new Error('SQLite is on fire'))
    process.emitWarning('A plain warning')
    expect(passed.map((args) => String(args[0]))).toEqual([
      'Something else is an experimental feature',
      'SQLite could not be opened',
      'Error: SQLite is on fire',
      'A plain warning',
    ])
    expect(passed[0]).toEqual(['Something else is an experimental feature', 'ExperimentalWarning'])
  })
})
