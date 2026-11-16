// What a command says to do where It is not running on the machine it runs on, by whether a service is registered and whether anything could keep It running.
import { describe, expect, test } from 'vitest'
import { notRunningHint } from './src/lib'

const SERVE = 'Run `it serve` in a terminal of your own and leave that terminal open, or under a supervisor of your own.'

describe('what is said to do where It is not running', () => {
  test('is to start the registered service again, or to run setup, where the system can keep It running', () => {
    expect(notRunningHint(true, () => true)).toMatch(
      /^It's background service is registered on this machine and is not running: `it service install` starts it again/,
    )
    expect(notRunningHint(false, () => true)).toMatch(/^Run `it setup`, which starts It and keeps it running in the background\./)
  })

  test('is to keep `it serve` running where nothing could, whether or not a service’s definition is on the disk', () => {
    // A home a container shares with the machine it runs on can hold the definition, and `it service install` refuses there
    for (const registered of [true, false]) {
      const said = notRunningHint(registered, () => false)
      expect(said).toContain(SERVE)
      expect(said).not.toMatch(/it setup`|it service install/)
    }
  })

  test('is both ways where the system could not be asked whether a service is registered, which is only ever so on Windows', () => {
    expect(notRunningHint('unknown', () => false)).toMatch(/^Where `it setup` registered It's background service/)
  })
})
