// What a person is drawn at a terminal: the bar of something being fetched, and an address as a
// code a camera reads. Neither needs a terminal to be said.
import { describe, expect, test } from 'vitest'
import { bar, qr, row } from './src/flow'

describe('the bar of something being fetched', () => {
  test('fills as it arrives, and says how much of how much', () => {
    expect(bar(0, 60 * 1_048_576)).toBe(`${'░'.repeat(18)} 0 MB of 60 MB`)
    expect(bar(30 * 1_048_576, 60 * 1_048_576)).toBe(`${'█'.repeat(9)}${'░'.repeat(9)} 30 MB of 60 MB`)
    expect(bar(60 * 1_048_576, 60 * 1_048_576)).toBe(`${'█'.repeat(18)} 60 MB of 60 MB`)
    // More than was said to be coming does not draw past the end
    expect(bar(90 * 1_048_576, 60 * 1_048_576)).toContain('█'.repeat(18))
  })

  test('says only how much has arrived where nobody said how much there is', () => {
    expect(bar(12 * 1_048_576, undefined)).toBe('12 MB')
  })
})

describe('an address as a code a camera reads', () => {
  const lines = qr('http://100.101.42.17:4700/pair#abcdefghij0123456789')
  test('is a square of blocks, two rows of the code to a line, with a margin all round', () => {
    const width = [...lines[0]!].length
    expect(lines.every((line) => [...line].length === width)).toBe(true)
    expect(lines.every((line) => /^[█▀▄ ]+$/.test(line))).toBe(true)
    // Twice as many columns as lines, as near as an odd number of rows comes
    expect(Math.abs(width - lines.length * 2)).toBeLessThanOrEqual(1)
    // The margin is the white the code is drawn on
    expect(lines[0]).toBe('█'.repeat(width))
    expect(lines.every((line) => line.startsWith('██') && line.endsWith('██'))).toBe(true)
  })

  test('is another picture for another address', () => {
    expect(qr('http://100.101.42.17:4700/pair#zyxwvutsrq9876543210').join('\n')).not.toBe(lines.join('\n'))
  })
})

describe('a row of a list a person chooses from', () => {
  const on = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').length
  const wide = (columns: number, run: () => void) => {
    const was = Object.getOwnPropertyDescriptor(process.stderr, 'columns')
    Object.defineProperty(process.stderr, 'columns', { value: columns, configurable: true })
    try {
      run()
    } finally {
      if (was) Object.defineProperty(process.stderr, 'columns', was)
      else delete (process.stderr as { columns?: number }).columns
    }
  }
  const HINT = 'this machine has an address on the internet (2600:1700:8100:c690::838c), and It answers over plain http'

  test('stays on one line of the terminal, however much is said after its label: one that ran onto a second line was drawn again below itself at every key', () => {
    for (const columns of [40, 63, 80, 120]) {
      wide(columns, () => {
        const drawn = row('  ❯ ', 4, 'From any network, the internet included', HINT, true)
        expect(on(drawn)).toBeLessThan(columns)
        expect(drawn).toContain('From any network')
      })
    }
    // Where it all fits, nothing is cut
    wide(200, () => expect(row('    ', 4, 'From this computer only', 'localhost:4700', true)).toContain('From this computer only  '))
    wide(200, () => expect(row('  ❯ ', 4, 'From any network, the internet included', HINT, true)).toContain('plain http'))
  })

  test('cuts the label itself where the terminal is narrower than that, and says nothing after it', () => {
    wide(24, () => {
      const drawn = row('  ❯ ● ', 6, 'From any network, the internet included', HINT, true)
      expect(on(drawn)).toBeLessThan(24)
      expect(drawn.endsWith('…')).toBe(true)
    })
  })
})
