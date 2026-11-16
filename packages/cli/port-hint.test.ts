// What a first setup says to do where the ports It would use are taken, in the words of each system's shell.
import { describe, expect, test } from 'vitest'
import { portHint } from './src/serve/firstrun'

describe('what a first setup says to do where its ports are taken', () => {
  test('is to run setup again from a free port where another program has them, as the background service it would be anyway', () => {
    expect(portHint(false, 4800, 'linux')).toBe(
      'Nothing was set up. To set It up on ports nothing else uses, run setup again with IT_PORT before it: `IT_PORT=4800 it setup`. The port is written into its settings, so it is named this once.',
    )
    expect(portHint(false, 4800, 'darwin')).toContain('`IT_PORT=4800 it setup`')
    // Nothing about a second It, which is not what the person has
    expect(portHint(false, 4800, 'linux')).not.toMatch(/second It|--no-service|it serve/)
  })

  test('is said in PowerShell’s words on Windows', () => {
    expect(portHint(false, 4800, 'win32')).toContain("`$env:IT_PORT='4800'; it setup`")
    expect(portHint(true, 4800, 'win32')).toContain("`$env:IT_PORT='4800'; it setup --none --no-service`")
  })

  test('is how to run a second It by hand where another It has them', () => {
    expect(portHint(true, 4800, 'linux')).toBe(
      'Nothing was set up. To run a second It by hand, keep IT_HOME set to this folder and use `IT_PORT=4800 it setup --none --no-service`, then `it serve`. The port is written into its settings, so it is named this once. There is only one background service per account: setup without --no-service replaces its registration with this folder.',
    )
  })

  test('leaves the port to the person where none was found free', () => {
    expect(portHint(false, undefined, 'linux')).toContain('`IT_PORT=<port> it setup`')
  })
})
