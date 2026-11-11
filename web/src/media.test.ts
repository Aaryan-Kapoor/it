// What the site holds a page to before it records for it (media.ts): what the person allowed on
// this screen, kept for that page as the conversation that has it, and what a page may ask of
// the device. The recording itself is run in real browsers, with their own fake microphone and
// camera, by the end-to-end run.
import { LIMITS, RECORDING } from '@it/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { displayKey, forgetAll, forgetDisplayKey, keepFor } from './lib'
import {
  allow,
  allowed,
  askPerson,
  begin,
  cannotRecord,
  forgetGrants,
  grantFor,
  grantsOf,
  kindsOf,
  kindsSaid,
  liveFor,
  noteFor,
  ownerOf,
  shoot,
  specOf,
  takeBack,
  withinTheMost,
} from './media'
import { MediaBar } from './recording'

const OWNER = ownerOf({ machineId: 'machine-1', session: { harness: 'claude-code', id: 'conversation-1' } })
const grant = (page: string, kinds: ('mic' | 'camera')[], owner = OWNER) => ({
  page,
  title: `Page ${page}`,
  agent: 'Claude Code',
  machine: 'studio',
  owner,
  kinds,
})

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

describe('which grant allows a page', () => {
  test('is the same while more is allowed beside it, and another once it was taken back and allowed again', async () => {
    const { grantFor } = await import('./media')
    allow('person-1', grant('page-1', ['mic']))
    const first = grantFor('person-1', 'page-1', OWNER, ['mic'])
    expect(first).toMatch(/^[0-9a-f]{24}$/)
    allow('person-1', grant('page-1', ['camera']))
    expect(grantFor('person-1', 'page-1', OWNER, ['mic', 'camera'])).toBe(first)
    takeBack('person-1', 'page-1')
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).toBeNull()
    allow('person-1', grant('page-1', ['mic']))
    const again = grantFor('person-1', 'page-1', OWNER, ['mic'])
    expect(again).not.toBeNull()
    expect(again).not.toBe(first)
  })
})

describe('how long what was allowed lasts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('until the page goes 30 days without using it, each use beginning the time again, and the grant staying the same grant', async () => {
    const { usedNow } = await import('./media')
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') })
    const day = 24 * 60 * 60_000
    allow('person-1', grant('page-1', ['mic']))
    const first = grantFor('person-1', 'page-1', OWNER, ['mic'])
    vi.setSystemTime(Date.now() + 29 * day)
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).toBe(first)
    usedNow('person-1', 'page-1')
    vi.setSystemTime(Date.now() + 29 * day)
    // Fifty-eight days after it was allowed, but used on the twenty-ninth
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).toBe(first)
    vi.setSystemTime(Date.now() + 2 * day)
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).toBeNull()
    expect(grantsOf('person-1')).toEqual([])
    // Allowed again, it is a new grant
    allow('person-1', grant('page-1', ['mic']))
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).not.toBe(first)
  })
})

describe('a use noted beside the grants', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('does not put back what another tab took back between this tab reading the grants and noting the use', async () => {
    const { usedNow } = await import('./media')
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') })
    allow('person-1', grant('page-x', ['mic']))
    allow('person-1', grant('page-y', ['mic']))
    const key = `it.media.person-1.${displayKey()}`
    const read = Storage.prototype.getItem
    let once = false
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name: string) {
      const got = read.call(this, name)
      if (name === key && !once && got) {
        once = true
        // Another tab takes page-y back the moment after this one read the grants
        localStorage.setItem(key, JSON.stringify((JSON.parse(got) as { page: string }[]).filter((g) => g.page !== 'page-y')))
      }
      return got
    })
    usedNow('person-1', 'page-x')
    vi.restoreAllMocks()
    expect(once).toBe(true)
    expect(grantFor('person-1', 'page-y', OWNER, ['mic'])).toBeNull()
    expect(grantsOf('person-1').map((g) => [g.page, g.used])).toEqual([['page-x', Date.now()]])
  })

  test('is let go with its grant, and a grant allowed again does not run on from the use of the one before', async () => {
    const { usedNow } = await import('./media')
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') })
    const day = 24 * 60 * 60_000
    allow('person-1', grant('page-1', ['mic']))
    const first = grantFor('person-1', 'page-1', OWNER, ['mic'])!
    vi.setSystemTime(Date.now() + day)
    usedNow('person-1', 'page-1')
    const usedKeys = () => Object.keys(localStorage).filter((k) => k.includes('.used.'))
    expect(usedKeys()).toEqual([`it.media.person-1.${displayKey()}.used.${first}`])
    // More allowed beside it keeps the grant and its use
    allow('person-1', grant('page-1', ['camera']))
    expect(usedKeys()).toHaveLength(1)
    takeBack('person-1', 'page-1')
    expect(usedKeys()).toEqual([])
    allow('person-1', grant('page-1', ['mic']))
    expect(grantsOf('person-1')[0]!.used).toBeUndefined()
  })
})

describe('what the browser will ask about itself', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'permissions')
  })

  test('is what it has not been told yet for It’s site, and nothing where it cannot say', async () => {
    const { browserWillAsk } = await import('./media')
    const states: Record<string, string> = { microphone: 'granted', camera: 'prompt' }
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async ({ name }: { name: string }) => ({ state: states[name] }) } })
    expect(await browserWillAsk(['mic', 'camera'])).toEqual(['camera'])
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: {
        query: async () => {
          throw new TypeError('not a permission this browser knows')
        },
      },
    })
    expect(await browserWillAsk(['mic', 'camera'])).toEqual([])
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

// A pretend microphone and camera, as far as the site goes with them: the tracks a browser would
// give, which say whether they were stopped, and a recorder that gives what the test says it
// recorded. The real devices are the browsers' own, in the end-to-end run.
function standInDevices(gate?: Promise<void>) {
  const tracks: { kind: string; stopped: boolean }[] = []
  const getUserMedia = vi.fn(async (asked: MediaStreamConstraints) => {
    await gate
    const made = (['audio', 'video'] as const)
      .filter((kind) => asked[kind])
      .map((kind) => {
        const t = {
          kind,
          enabled: true,
          stopped: false,
          stop() {
            t.stopped = true
          },
          addEventListener() {},
        }
        tracks.push(t)
        return t
      })
    return { getTracks: () => made }
  })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  return { tracks, getUserMedia }
}
class StandInRecorder {
  static isTypeSupported = () => true
  static last: StandInRecorder | null = null
  /** What it still holds when it is asked to stop, as a recorder does between its pieces. */
  static tail = 512 * 1024
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_stream: unknown, options: { mimeType?: string } = {}) {
    this.mimeType = options.mimeType ?? 'audio/webm'
    StandInRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
  /** A piece of what was recorded, as a recorder gives one every second. */
  give(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) })
  }
  stop() {
    this.give(StandInRecorder.tail)
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  }
}
const MiB = 1024 * 1024
const settle = () => new Promise((r) => setTimeout(r, 10))

/** Another tab of this browser takes back what the page was allowed and allows it again, and this tab hears of both only after. */
function anotherTabTookBackAndAllowedAgain(kinds: ('mic' | 'camera')[]) {
  const key = `it.media.person-1.${displayKey()}`
  const before = localStorage.getItem(key)
  const regranted = grantsOf('person-1').map((g) => (g.page === 'page-1' ? { ...g, kinds, id: 'a-grant-made-in-another-tab' } : g))
  // Written as that tab writes it, under this tab's feet: no event here until the browser delivers the queued ones
  Storage.prototype.setItem.call(localStorage, key, JSON.stringify(regranted))
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue: before, newValue: null }))
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue: null, newValue: JSON.stringify(regranted) }))
}

describe('a camera open for a photo', () => {
  /** The camera a test opened, closed after it whatever the test did, so that the next finds the camera free. */
  let open: { cancel: () => void } | null = null
  afterEach(() => {
    open?.cancel()
    open = null
  })
  const taking = async () => {
    allow('person-1', grant('page-1', ['camera']))
    const devices = standInDevices()
    const shot = await shoot(
      { page: 'page-1', title: 'Page page-1', user: 'person-1', owner: OWNER, grant: grantFor('person-1', 'page-1', OWNER, ['camera'])! },
      undefined,
    )
    open = shot
    return { devices, shot }
  }

  test('closes when the person takes back what the page was allowed, and gives the page no photo', async () => {
    const { devices, shot } = await taking()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([false])
    takeBack('person-1', 'page-1')
    expect(await shot.photo).toBeNull()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('closes when what is allowed is another conversation’s now', async () => {
    const { devices, shot } = await taking()
    allow('person-1', grant('page-1', ['camera'], ownerOf({ machineId: 'machine-1', session: { harness: 'codex', id: 'other' } })))
    expect(await shot.photo).toBeNull()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('closes when this browser signs out', async () => {
    const { devices, shot } = await taking()
    forgetGrants('person-1')
    expect(await shot.photo).toBeNull()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('closes when another tab of this browser took it back', async () => {
    const { devices, shot } = await taking()
    const key = `it.media.person-1.${displayKey()}`
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(await shot.photo).toBeNull()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('closes when another tab took back what the page was allowed and allowed it again before this tab heard of it', async () => {
    const { devices, shot } = await taking()
    anotherTabTookBackAndAllowedAgain(['camera'])
    expect(await shot.photo).toBeNull()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('stays open while what the page was allowed stands', async () => {
    const { devices, shot } = await taking()
    allow('person-1', grant('page-2', ['mic']))
    await settle()
    expect(devices.tracks.map((t) => t.stopped)).toEqual([false])
    shot.cancel()
    expect(await shot.photo).toBeNull()
  })
})

describe('a recording under way', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', StandInRecorder)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const record = async (most: number) => {
    allow('person-1', grant('page-1', ['mic']))
    const devices = standInDevices()
    const told = vi.fn()
    const begun = await begin(
      specOf({ audio: true, video: false }),
      { id: 'rec-1', user: 'person-1', page: 'page-1', owner: OWNER, grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!, title: 'Page page-1', told },
      most,
    )
    return { devices, told, begun, recorder: StandInRecorder.last! }
  }

  test('ends, and is thrown away, when another tab took back what the page was allowed and allowed it again before this tab heard of it', async () => {
    const { devices, told } = await record(8 * MiB)
    anotherTabTookBackAndAllowedAgain(['mic'])
    await settle()
    expect(told).toHaveBeenCalledWith('ended', 'taken_back', undefined)
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
    expect(liveFor('page-1')).toBeUndefined()
  })

  test('the most is what one file an action carries may be', () => {
    expect(RECORDING.mostBytes).toBe(LIMITS.actionFileBytes)
  })

  test('stops by itself before the most, keeps what was recorded, and gives it to the page', async () => {
    const { devices, told, recorder } = await record(8 * MiB)
    // A piece a second, until what has come and what the recorder still holds would be near the most
    for (let n = 0; n < 5; n++) recorder.give(MiB)
    expect(told).not.toHaveBeenCalled()
    recorder.give(MiB)
    await settle()
    expect(told).toHaveBeenCalledTimes(1)
    const [state, why, file] = told.mock.calls[0]!
    expect([state, why]).toEqual(['ended', 'too_large'])
    // Everything that came, what the recorder held when it was stopped among it, and never more than the most
    expect((file as Blob).size).toBe(6 * MiB + StandInRecorder.tail)
    expect((file as Blob).size).toBeLessThanOrEqual(8 * MiB)
    expect(devices.tracks.map((t) => t.stopped)).toEqual([true])
    expect(liveFor('page-1')).toBeUndefined()
  })

  test('says why on its row, until the page records again', async () => {
    const { recorder } = await record(8 * MiB)
    for (let n = 0; n < 6; n++) recorder.give(MiB)
    await settle()
    expect(noteFor('page-1')).toBe('kept')
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.textContent).toContain('Stopped at 1 GB · kept')
    expect(host.textContent).toContain('the most one file sent with an action can be. What was recorded is kept')
    // Recording again, the bar shows the recording instead
    await act(async () => {
      await record(8 * MiB)
    })
    expect(noteFor('page-1')).toBeUndefined()
    expect(host.querySelector('.media-rec')).not.toBeNull()
    expect(host.textContent).not.toContain('Stopped at')
    await act(async () => root.unmount())
    host.remove()
  })

  test('more than the most in one piece is nothing that can be kept, and its row and the page are told that, not that it was kept', async () => {
    const { told, recorder } = await record(MiB)
    recorder.give(2 * MiB)
    await settle()
    expect(told).toHaveBeenCalledWith('ended', 'too_large', undefined)
    expect(noteFor('page-1')).toBe('lost')
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.textContent).toContain('Stopped past 1 GB · nothing kept')
    expect(host.textContent).toContain('nothing of it could be kept')
    expect(host.textContent).not.toContain('What was recorded is kept')
    await act(async () => root.unmount())
    host.remove()
  })

  test('a stop that lets more through than the most is cut back to whole pieces within it', () => {
    const piece = (n: number) => new Blob([new Uint8Array(n)])
    expect(withinTheMost([piece(4), piece(4), piece(4)], 9).map((p) => p.size)).toEqual([4, 4])
    expect(withinTheMost([piece(4), piece(4)], 8).map((p) => p.size)).toEqual([4, 4])
    expect(withinTheMost([piece(10)], 9)).toEqual([])
  })
})

describe('what It’s bar shows of the microphone and the camera', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  })
  const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined

  test('It’s question is a line in the bar, with no dialog: the page, what it wants, and an Allow that takes no press until it has been there a moment', async () => {
    const { ARM_MS } = await import('./recording')
    vi.useFakeTimers()
    const asked = askPerson({ page: 'page-1', title: 'Voice notes', agent: 'Claude Code', machine: 'studio', kinds: ['mic', 'camera'] })
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.querySelector('[role="dialog"], dialog, .modal-overlay')).toBeNull()
    expect(host.querySelector('.media-ask')?.textContent).toContain('Voice notes')
    expect(host.querySelector('.media-ask')?.textContent).toContain('wants the mic and camera')
    // Who made it, and how long a yes lasts, for whoever points at it or hears the screen read
    expect(host.textContent).toContain('Claude Code on studio made this page')
    expect(host.textContent).toContain('30 days')
    expect(button('Allow')?.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(ARM_MS - 50))
    expect(button('Allow')?.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(100))
    expect(button('Allow')?.disabled).toBe(false)
    await act(async () => button('Allow')!.click())
    expect(await asked.answer).toBe(true)
    expect(host.querySelector('.media-ask')).toBeNull()
  })

  test('Not now answers at once, and the question is for its own page only', async () => {
    const asked = askPerson({ page: 'page-1', title: 'Voice notes', agent: null, machine: null, kinds: ['mic'] })
    await act(async () => root.render(createElement(MediaBar, { page: 'page-2' })))
    expect(host.querySelector('.media-ask')).toBeNull()
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.querySelector('.media-ask')?.textContent).toContain('wants the mic')
    await act(async () => button('Not now')!.click())
    expect(await asked.answer).toBe(false)
  })

  test('a photo is Take and Cancel in the bar, with the camera’s picture inside the bar’s own element, and Take waits a moment too', async () => {
    const { ARM_MS } = await import('./recording')
    allow('person-1', grant('page-1', ['camera']))
    const track = { kind: 'video', enabled: true, stopped: false, stop: () => (track.stopped = true), addEventListener() {}, getSettings: () => ({}) }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } })
    const shot = await shoot(
      { page: 'page-1', title: 'Voice notes', user: 'person-1', owner: OWNER, grant: grantFor('person-1', 'page-1', OWNER, ['camera'])! },
      undefined,
    )
    vi.useFakeTimers()
    try {
      await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
      const bar = host.querySelector('.media-photo')
      expect(bar?.querySelector('.media-photo-view video')).not.toBeNull()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(button('Take')?.disabled).toBe(true)
      await act(async () => vi.advanceTimersByTime(ARM_MS + 10))
      expect(button('Take')?.disabled).toBe(false)
      await act(async () => button('Cancel')!.click())
      expect(await shot.photo).toBeNull()
      expect(track.stopped).toBe(true)
    } finally {
      shot.cancel()
    }
  })

  test('taking back from the bar asks once more in the bar itself, and not in a browser dialog', async () => {
    const { MediaAllowed } = await import('./recording')
    const confirm = vi.spyOn(window, 'confirm')
    allow('person-1', grant('page-1', ['mic']))
    await act(async () => root.render(createElement(MediaAllowed, { user: 'person-1', page: 'page-1', title: 'Voice notes' })))
    await act(async () => (host.querySelector('.media-allowed') as HTMLButtonElement).click())
    expect(host.querySelector('.media-takeback')?.textContent).toContain('Take back the mic?')
    await act(async () => button('Keep')!.click())
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).not.toBeNull()
    await act(async () => (host.querySelector('.media-allowed') as HTMLButtonElement).click())
    await act(async () => button('Take back')!.click())
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).toBeNull()
    expect(host.querySelector('.media-allowed, .media-takeback')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
