// What the site says of a newer It, as `updateSaid` decides it for the Machines page and the
// home page alike: the words of every state, which of them has a button and which, and when
// nothing is said at all.
import { UPGRADE_MS } from '@it/protocol'
import { describe, expect, test } from 'vitest'
import { DONE_SAID_MS, type Upgradable, updateSaid } from './update'

const NOW = 1_000_000_000_000
const desk: Upgradable = { id: 'machine-1', name: 'the desk', lastSeenAt: NOW, connectorVersion: '0.1.41', runsIt: true, latest: '0.1.44', harnesses: [] }
const laptop: Upgradable = { ...desk, id: 'machine-2', name: 'the laptop', runsIt: false }
const said = (m: Upgradable, host: string | null = desk.connectorVersion) => updateSaid(m, host, NOW)
const asked = (state: NonNullable<Upgradable['upgrade']>['state'], ago = 0, more: object = {}) => ({ upgrade: { at: NOW - ago, state, ...more } })

describe('what is said of an update of the machine It runs on', () => {
  test('nothing, where it knows of no newer version than the one it runs', () => {
    expect(said({ ...desk, latest: '0.1.41' })).toBeNull()
    expect(said({ ...desk, latest: null })).toBeNull()
    expect(said({ ...desk, latest: '0.1.40' })).toBeNull()
  })

  test.each([
    ['out', {}, { kind: 'out', press: 'Update', words: 'It 0.1.44 is out. This machine runs 0.1.41.' }],
    ['asked', asked('asked'), { kind: 'working', press: null, words: 'Updating to It 0.1.44…' }],
    ['working', asked('working'), { kind: 'working', press: null, words: 'Updating to It 0.1.44…' }],
    ['restarting', asked('restarting'), { kind: 'restarting', press: null, words: 'Starting again as It 0.1.44…' }],
    [
      'failed',
      asked('failed', 0, { why: 'The newest release of It could not be fetched (it-linux-x64).' }),
      {
        kind: 'failed',
        tone: 'bad',
        press: 'Try again',
        words: 'The update to It 0.1.44 did not finish: The newest release of It could not be fetched (it-linux-x64).',
      },
    ],
    [
      'failed without a reason',
      asked('failed'),
      { kind: 'failed', tone: 'bad', press: 'Try again', words: 'The update to It 0.1.44 did not finish: it is not known why.' },
    ],
    [
      'cut short',
      asked('working', UPGRADE_MS + 1),
      { kind: 'cut-short', tone: 'bad', press: 'Try again', words: 'The update to It 0.1.44 did not finish. This machine still runs 0.1.41.' },
    ],
    [
      'not heard from after starting again',
      asked('restarting', UPGRADE_MS + 1),
      {
        kind: 'not-heard',
        tone: 'bad',
        press: 'Try again',
        words: 'It 0.1.44 is in place, and has not been heard from since it was started. Run it service logs on that machine to read why.',
      },
    ],
  ])('%s', (_, more, expected) => {
    expect(said({ ...desk, ...more })).toEqual(expected)
  })

  test('installed and waiting to be started again, with what to run in backticks, and the word for Claude Code where it is there', () => {
    const installed = said({ ...desk, latest: '0.1.44', ...asked('installed', 0, { version: '0.1.44' }) })
    expect(installed).toMatchObject({ kind: 'installed', tone: 'wait', press: null })
    expect(installed?.words).toContain('It 0.1.44 is installed on the desk. It runs once It is started again there.')
    expect(installed?.words).toContain('If you started It in a terminal with `it serve`, stop it and start it again.')
    expect(installed?.words).toContain('An app that is already running goes on with the add-on it loaded until it is restarted')
    const claude = said({ ...desk, harnesses: [{ id: 'claude-code', addon: 'connected' }], ...asked('installed', 0, { version: '0.1.44' }) })
    expect(claude?.words).toMatch(/Type \/reload-plugins only in one whose page says it cannot hear it\.$/)
  })

  test('done, said for a few hours with the word for Claude Code, and then nothing', () => {
    const done = { ...desk, connectorVersion: '0.1.44', latest: '0.1.44' }
    expect(said({ ...done, ...asked('done', 0, { version: '0.1.44' }) }, '0.1.44')).toEqual({
      kind: 'done',
      press: null,
      words: 'It 0.1.44 is running on the desk.',
    })
    expect(said({ ...done, harnesses: [{ id: 'claude-code', addon: 'connected' }], ...asked('done', 0, { version: '0.1.44' }) }, '0.1.44')?.words).toBe(
      'It 0.1.44 is running on the desk. A Claude Code chat that was already open there goes on with the add-on it loaded, which still takes clicks. Type /reload-plugins only in one whose page says it cannot hear it.',
    )
    expect(said({ ...done, ...asked('done', DONE_SAID_MS + 1, { version: '0.1.44' }) }, '0.1.44')).toBeNull()
    // Something newer out already is said instead
    expect(said({ ...done, latest: '0.1.45', ...asked('done', 0, { version: '0.1.44' }) }, '0.1.44')).toMatchObject({ kind: 'out', press: 'Update' })
  })
})

describe('what is said of an update of a machine that joined this It', () => {
  test('it waits for the machine It runs on, whatever state its own asking is in, and has no button until then', () => {
    expect(said(laptop, '0.1.41')).toEqual({
      kind: 'first',
      press: null,
      words: 'It 0.1.44 is out. This machine runs 0.1.41. Update the machine It runs on first.',
    })
    expect(said({ ...laptop, ...asked('failed', 0, { why: 'No room.' }) }, '0.1.41')).toMatchObject({
      kind: 'failed',
      press: null,
      words: 'The update to It 0.1.44 did not finish: No room. Update the machine It runs on first.',
    })
  })

  test('once the machine It runs on is updated it has its own button, and one behind with no release found says how to look', () => {
    expect(said(laptop, '0.1.44')).toEqual({ kind: 'out', press: 'Update', words: 'It 0.1.44 is out. This machine runs 0.1.41.' })
    expect(said({ ...laptop, latest: null }, '0.1.44')).toEqual({
      kind: 'behind',
      tone: 'wait',
      press: null,
      words:
        'This machine runs It 0.1.41. The machine It runs on uses 0.1.44. A matching release has not been confirmed here. Run `it upgrade --check` on this machine to check for updates.',
    })
  })
})
