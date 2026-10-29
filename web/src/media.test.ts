// What the site holds a page to before it records for it (media.ts): what the person allowed on
// this screen, kept for that page as the conversation that has it, and what a page may ask of
// the device. The recording itself is run in real browsers, with their own fake microphone and
// camera, by the end-to-end run.
import { beforeEach, describe, expect, test } from 'vitest'
import { displayKey, forgetAll, forgetDisplayKey, keepFor } from './lib'
import { allow, allowed, askPerson, cannotRecord, forgetGrants, grantsOf, kindsOf, kindsSaid, ownerOf, specOf, takeBack } from './media'

const OWNER = ownerOf({ machineId: 'machine-1', session: { harness: 'claude-code', id: 'conversation-1' } })
const grant = (page: string, kinds: ('mic' | 'camera')[], owner = OWNER) => ({ page, title: `Page ${page}`, agent: 'Claude Code', machine: 'studio', owner, kinds })

beforeEach(() => {
  localStorage.clear()
  keepFor('person-1')
})

describe('what the person allowed a page on this screen', () => {
  test('is for that page, those kinds, and the conversation that had it, and nothing else', () => {
    expect(allowed('person-1', 'page-1', OWNER, ['mic'])).toBe(false)
    allow('person-1', grant('page-1', ['mic']))
    expect(allowed('person-1', 'page-1', OWNER, ['mic'])).toBe(true)
    // Not the camera, which was not asked about
    expect(allowed('person-1', 'page-1', OWNER, ['mic', 'camera'])).toBe(false)
    // Not another page
    expect(allowed('person-1', 'page-2', OWNER, ['mic'])).toBe(false)
    // Not the same page once another conversation has taken it
    expect(allowed('person-1', 'page-1', ownerOf({ machineId: 'machine-1', session: { harness: 'codex', id: 'other' } }), ['mic'])).toBe(false)
    // Not another person paired in this browser
    expect(allowed('person-2', 'page-1', OWNER, ['mic'])).toBe(false)
  })

  test('adds what is allowed later to what was allowed before, and starts afresh for a page another conversation took', () => {
    allow('person-1', grant('page-1', ['mic']))
    allow('person-1', grant('page-1', ['camera']))
    expect(grantsOf('person-1').map((g) => g.kinds)).toEqual([['mic', 'camera']])
    const theirs = ownerOf({ machineId: 'machine-2', session: { harness: 'codex', id: 'other' } })
    allow('person-1', grant('page-1', ['camera'], theirs))
    expect(grantsOf('person-1')).toMatchObject([{ page: 'page-1', owner: theirs, kinds: ['camera'] }])
  })

  test('is taken back for one page and not for another', () => {
    allow('person-1', grant('page-1', ['mic']))
    allow('person-1', grant('page-2', ['camera']))
    takeBack('person-1', 'page-1')
    expect(grantsOf('person-1').map((g) => g.page)).toEqual(['page-2'])
    expect(allowed('person-1', 'page-1', OWNER, ['mic'])).toBe(false)
  })

  test('ends with the pairing: on signing out, and when the display it was allowed on is forgotten', () => {
    allow('person-1', grant('page-1', ['mic']))
    forgetGrants('person-1')
    expect(grantsOf('person-1')).toEqual([])
    allow('person-1', grant('page-1', ['mic']))
    forgetDisplayKey()
    expect(grantsOf('person-1')).toEqual([])
    expect(Object.keys({ ...localStorage }).filter((name) => name.startsWith('it.media.'))).toEqual([])
  })

  test('goes with everything else the site keeps for the person, and is not taken from what was written by hand', () => {
    allow('person-1', grant('page-1', ['mic']))
    forgetAll('person-1')
    keepFor('person-1')
    expect(grantsOf('person-1')).toEqual([])
    // What is not a grant, written under the same name, allows nothing
    localStorage.setItem(`it.media.person-1.${displayKey()}`, `[{"page":"page-1","owner":"${OWNER}","kinds":["mic"]}]`)
    expect(allowed('person-1', 'page-1', OWNER, ['mic'])).toBe(false)
  })
})

describe('asking the person', () => {
  test('one question at a time: a page that asks while another question is open is answered no, and a question taken away is no', async () => {
    const first = askPerson({ page: 'page-1', title: 'One', agent: null, machine: null, kinds: ['mic'] })
    const second = askPerson({ page: 'page-2', title: 'Two', agent: null, machine: null, kinds: ['mic'] })
    expect(await second.answer).toBe(false)
    first.cancel()
    expect(await first.answer).toBe(false)
  })
})

describe('what a page may ask of the device', () => {
  test('plain switches and sizes, and which way the camera faces, held to the bit rates the site allows', () => {
    const spec = specOf({ audio: { echoCancellation: false, channelCount: 2 }, video: { facingMode: 'environment', width: 1280 }, audioBitsPerSecond: 9e9 })
    expect(spec).toEqual({
      audio: { echoCancellation: false, channelCount: 2 },
      video: { facingMode: 'environment', width: 1280 },
      audioBitsPerSecond: 512_000,
      videoBitsPerSecond: 1_500_000,
    })
    expect(kindsOf(spec)).toEqual(['mic', 'camera'])
    expect(kindsOf(specOf({ audio: true, video: false }))).toEqual(['mic'])
  })

  test('nothing that names a device, and nothing that is not a plain setting', () => {
    for (const audio of [{ deviceId: 'abc' }, { groupId: 'x' }, { echoCancellation: 'no' }, { channelCount: -1 }, 'yes', [true]])
      expect(() => specOf({ audio, video: false }), JSON.stringify(audio)).toThrow()
    expect(() => specOf({ audio: false, video: { facingMode: 'sideways' } })).toThrow()
    expect(() => specOf({ audio: false, video: false })).toThrow('needs audio, video or both')
  })

  test('the kinds, as a person reads them', () => {
    expect([kindsSaid(['mic']), kindsSaid(['camera']), kindsSaid(['mic', 'camera'])]).toEqual(['the microphone', 'the camera', 'the microphone and the camera'])
  })
})

describe('where a browser records at all', () => {
  test('not where it reached It over plain http, which is said with what to do', () => {
    // jsdom is no secure context, as a browser at another machine's plain http address is not
    expect(window.isSecureContext).not.toBe(true)
    expect(cannotRecord()).toMatch(/plain http.*it https on/)
  })
})
