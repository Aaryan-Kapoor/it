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
  cameraFor,
  cameraVideoOf,
  cannotRecord,
  dismissNote,
  forgetGrants,
  grantFor,
  grantsOf,
  kindsOf,
  kindsSaid,
  LIVE_CAMERA,
  liveFor,
  noteFor,
  openCamera,
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

/** What the stand-ins put in place of the browser's own, given back after each test. */
const kept: [string, PropertyDescriptor | undefined][] = []
function giveBack() {
  for (const [name, was] of kept.splice(0).reverse()) {
    const on = name === 'readyState' ? HTMLMediaElement.prototype : HTMLVideoElement.prototype
    if (was) Object.defineProperty(on, name, was)
    else Reflect.deleteProperty(on, name)
  }
}
// A pretend camera for the live picture, as far as the site goes with it: a track that says
// whether it was stopped or turned off and can go away, a video element whose next picture the
// test gives when it likes, and pictures that say whether they were closed. The real camera is
// Chromium's own, in the end-to-end run.
function standInCamera(size = { width: 640, height: 480 }) {
  const tracks: { kind: string; enabled: boolean; stopped: boolean; gone: () => void }[] = []
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      // A track for each kind asked for: the camera, and the microphone where sound is recorded beside it
      getUserMedia: vi.fn(async (asked: MediaStreamConstraints) => {
        const made = (['audio', 'video'] as const)
          .filter((kind) => asked[kind])
          .map((kind) => {
            const listeners: (() => void)[] = []
            const t = {
              kind,
              enabled: true,
              stopped: false,
              stop() {
                t.stopped = true
              },
              addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
              /** The device goes away, as one unplugged does. */
              gone: () => {
                for (const fn of listeners) fn()
              },
            }
            tracks.push(t)
            return t
          })
        return { getTracks: () => made }
      }),
    },
  })
  kept.push(['videoWidth', Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth')])
  kept.push(['videoHeight', Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight')])
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => size.width })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => size.height })
  /** Whoever waits for the camera's next picture. */
  let waiting: (() => void) | null = null
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  kept.push(['readyState', Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState')])
  kept.push(['requestVideoFrameCallback', Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')])
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(fn: () => void) {
      waiting = fn
      return 1
    },
  })
  const made: { closed: boolean; close: () => void; width: number; height: number }[] = []
  /** Holds each picture being made until the test lets it through, where it says so. */
  let hold = false
  const held: (() => void)[] = []
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(
      () =>
        new Promise((resolve) => {
          const picture = {
            width: 640,
            height: 480,
            closed: false,
            close() {
              picture.closed = true
            },
          }
          made.push(picture)
          if (hold) held.push(() => resolve(picture))
          else resolve(picture)
        }),
    ),
  )
  return {
    tracks,
    made,
    /** What each picture was asked to be made as. */
    asked: () => (createImageBitmap as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1]),
    /** The camera gives a picture, and what is made of it is let through. */
    async picture() {
      const next = waiting
      waiting = null
      next?.()
      await settle()
    },
    hold: (on: boolean) => {
      hold = on
    },
    letThrough: () => {
      for (const go of held.splice(0)) go()
    },
  }
}

describe('the camera, live to a page', () => {
  const camera = { user: 'person-1', page: 'page-1', owner: OWNER, title: 'Page page-1' }
  let open: { stop: () => void } | null = null
  afterEach(() => {
    open?.stop()
    open = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    giveBack()
    Reflect.deleteProperty(document, 'visibilityState')
  })
  /** The page allowed the camera, and the camera opened for it: what it was given, and what it was told. */
  const opened = async (options: { size?: { width: number; height: number }; drawAll?: boolean; kinds?: ('mic' | 'camera')[] } = {}) => {
    allow('person-1', grant('page-1', options.kinds ?? ['camera']))
    const device = standInCamera(options.size)
    const given: number[] = []
    const told = vi.fn()
    let refuse: 'taken_over' | 'taken_back' | null = null
    const live = await openCamera(true, {
      ...camera,
      id: 'cam-1',
      grant: grantFor('person-1', 'page-1', OWNER, ['camera'])!,
      still: () => refuse,
      picture: (frame) => {
        given.push(frame)
        // A page that draws each picture the moment it comes
        if (options.drawAll) live.drawn(frame)
      },
      told,
    })
    open = live
    return { device, given, told, live, refuse: (why: 'taken_over' | 'taken_back' = 'taken_over') => (refuse = why) }
  }

  test('sends a page no more than two pictures it has not drawn, passes over the camera’s pictures in between, and sends again once it says it drew one', async () => {
    const { device, given, live } = await opened()
    expect(LIVE_CAMERA.atOnce).toBe(2)
    for (let n = 0; n < 5; n++) await device.picture()
    expect(given).toEqual([1, 2])
    // The pictures it had no room for were not made at all
    expect(device.made).toHaveLength(2)
    // A picture it never was sent makes no room
    live.drawn(7)
    await device.picture()
    expect(given).toEqual([1, 2])
    live.drawn(1)
    await device.picture()
    await device.picture()
    expect(given).toEqual([1, 2, 3])
    live.drawn(2)
    live.drawn(3)
    await device.picture()
    await device.picture()
    expect(given).toEqual([1, 2, 3, 4, 5])
  })

  test('counts pictures still being made, so that a slow browser piles nothing up either', async () => {
    const { device, given } = await opened()
    device.hold(true)
    for (let n = 0; n < 4; n++) await device.picture()
    expect(device.made).toHaveLength(2)
    device.letThrough()
    await settle()
    expect(given).toEqual([1, 2])
  })

  test('is listed for It’s bar while it is open, and no longer once it is closed', async () => {
    const { device, live, told } = await opened()
    expect(cameraFor('page-1')).toMatchObject({ id: 'cam-1', page: 'page-1', state: 'live' })
    live.stop()
    expect(cameraFor('page-1')).toBeUndefined()
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    // Closed as the page asked, it is not told of it as of something it did not ask
    expect(told).not.toHaveBeenCalled()
  })

  test('ends when the person takes back what the page was allowed, and sends nothing more', async () => {
    const { device, given, told } = await opened()
    await device.picture()
    takeBack('person-1', 'page-1')
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    await device.picture()
    expect(given).toEqual([1])
    expect(cameraFor('page-1')).toBeUndefined()
  })

  test('ends when another tab took back what the page was allowed and allowed it again before this tab heard of it', async () => {
    const { device, told } = await opened()
    anotherTabTookBackAndAllowedAgain(['camera'])
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('ends when what is allowed is another conversation’s now', async () => {
    const { device, told } = await opened()
    allow('person-1', grant('page-1', ['camera'], ownerOf({ machineId: 'machine-1', session: { harness: 'codex', id: 'other' } })))
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('ends when this browser signs out', async () => {
    const { device, told } = await opened()
    forgetGrants('person-1')
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('goes on while the page uses what it was allowed again, which keeps the same grant', async () => {
    const { usedNow } = await import('./media')
    const { device, given, told } = await opened()
    usedNow('person-1', 'page-1')
    allow('person-1', grant('page-2', ['mic']))
    await device.picture()
    expect(told).not.toHaveBeenCalled()
    expect(given).toEqual([1])
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
  })

  test('ends with the reason the page may not have the camera any more, asked before a picture is handed on, and the picture is closed', async () => {
    const { device, told, refuse } = await opened()
    refuse()
    await device.picture()
    expect(told).toHaveBeenCalledWith('ended', 'taken_over')
    expect(device.made[0]!.closed).toBe(true)
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('ends when the camera goes away', async () => {
    const { device, told } = await opened()
    device.tracks[0]!.gone()
    expect(told).toHaveBeenCalledWith('ended', 'device')
    expect(cameraFor('page-1')).toBeUndefined()
  })

  test('waits while the screen does not show the site, turning the camera off and sending nothing, and goes on when it does again', async () => {
    const { device, given, told } = await opened()
    let hidden = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(told).toHaveBeenLastCalledWith('paused')
    expect(cameraFor('page-1')?.state).toBe('paused')
    expect(device.tracks.map((t) => t.enabled)).toEqual([false])
    await device.picture()
    expect(given).toEqual([])
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(told).toHaveBeenLastCalledWith('live')
    expect(device.tracks.map((t) => t.enabled)).toEqual([true])
    await device.picture()
    expect(given).toEqual([1])
  })

  test('is said in It’s bar as live to the page, with no picture of its own there, and its Stop ends it as the person stopping it', async () => {
    // What the bar said of an earlier recording here, which would be said again once the camera is closed
    dismissNote('page-1')
    const { told } = await opened()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.querySelector('.media-cam')?.textContent).toBe('Camera liveStop')
    expect(host.querySelector('.media-cam')?.getAttribute('aria-label')).toBe('The camera is live to “Page page-1”')
    expect(host.querySelector('video, .media-rec, [role="dialog"]')).toBeNull()
    await act(async () => (host.querySelector('button[aria-label="Stop the camera"]') as HTMLButtonElement).click())
    expect(told).toHaveBeenCalledWith('ended', 'person')
    expect(host.textContent).toBe('')
    await act(async () => root.unmount())
    host.remove()
  })

  test('keeps a photo from being taken on this screen while it is open', async () => {
    await opened()
    await expect(shoot({ page: 'page-2', title: 'Page page-2', user: 'person-1', owner: OWNER, grant: 'any' }, undefined)).rejects.toThrow(
      'The camera is in use on this screen just now.',
    )
  })

  test('is asked for with plain sizes and which way the camera faces, and nothing that names a device', () => {
    expect(cameraVideoOf(undefined)).toBe(true)
    expect(cameraVideoOf({ facingMode: 'environment', width: 1280, frameRate: 30 })).toEqual({ facingMode: 'environment', width: 1280, frameRate: 30 })
    for (const video of [{ deviceId: 'abc' }, { facingMode: 'sideways' }, { width: -1 }, false, 'yes'])
      expect(() => cameraVideoOf(video), JSON.stringify(video)).toThrow()
    expect(() => cameraVideoOf({ deviceId: 'abc' })).toThrow('It.camera does not take video.deviceId as it was given.')
    // And no more than is ever sent, whatever the page asks
    expect(cameraVideoOf({ width: 3840, height: 2160, frameRate: 120 })).toEqual({ width: 1920, height: 1920, frameRate: 30 })
  })

  // A picture is made as the camera gives it, and the page may stop being one that should have it while it is made
  describe('a picture still being made', () => {
    test('is closed and not sent when the page closes the camera meanwhile', async () => {
      const { device, given } = await opened()
      device.hold(true)
      await device.picture()
      open!.stop()
      device.letThrough()
      await settle()
      expect(given).toEqual([])
      expect(device.made[0]!.closed).toBe(true)
    })

    test('is closed and not sent when the screen stops showing the site meanwhile', async () => {
      const { device, given } = await opened()
      device.hold(true)
      await device.picture()
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      device.letThrough()
      await settle()
      expect(given).toEqual([])
      expect(device.made[0]!.closed).toBe(true)
    })

    test('is closed and not sent when the person takes back what the page was allowed meanwhile', async () => {
      const { device, given, told } = await opened()
      device.hold(true)
      await device.picture()
      takeBack('person-1', 'page-1')
      device.letThrough()
      await settle()
      expect(given).toEqual([])
      expect(device.made[0]!.closed).toBe(true)
      expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    })

    test('is closed and not sent when the page may no longer have the camera by the time it is made', async () => {
      const { device, given, told, refuse } = await opened()
      device.hold(true)
      await device.picture()
      refuse('taken_over')
      device.letThrough()
      await settle()
      expect(given).toEqual([])
      expect(device.made[0]!.closed).toBe(true)
      expect(told).toHaveBeenCalledWith('ended', 'taken_over')
    })
  })

  test('is asked every second whether the page may still have it, whatever the page drew, so that a page that drew nothing is let go of too', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { device, given, told, refuse } = await opened()
    await device.picture()
    await device.picture()
    // Two pictures sent and none drawn: no more is sent, and so no picture would ever ask
    expect(given).toEqual([1, 2])
    vi.advanceTimersByTime(LIVE_CAMERA.checkEveryMs)
    expect(told).not.toHaveBeenCalled()
    refuse('taken_back')
    vi.advanceTimersByTime(LIVE_CAMERA.checkEveryMs)
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(cameraFor('page-1')).toBeUndefined()
  })

  test('notes that the page uses what it was allowed every hour while it is open, and not more often, so that it does not lapse while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-11-10T12:00:00Z') })
    const { device } = await opened()
    const key = `it.media.person-1.${displayKey()}.used.${grantFor('person-1', 'page-1', OWNER, ['camera'])}`
    expect(localStorage.getItem(key)).toBeNull()
    vi.advanceTimersByTime(LIVE_CAMERA.usedEveryMs - LIVE_CAMERA.checkEveryMs)
    expect(localStorage.getItem(key)).toBeNull()
    vi.advanceTimersByTime(LIVE_CAMERA.checkEveryMs)
    expect(Number(localStorage.getItem(key))).toBe(Date.now())
    // Open for fifty-eight days, which is past the thirty a grant lasts unused, and still allowed
    const day = 24 * 60 * 60_000
    for (const _ of [1, 2]) {
      vi.setSystemTime(Date.now() + 29 * day)
      vi.advanceTimersByTime(LIVE_CAMERA.checkEveryMs)
      expect(Number(localStorage.getItem(key))).toBe(Date.now())
    }
    expect(grantFor('person-1', 'page-1', OWNER, ['camera'])).not.toBeNull()
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
  })

  test('sends no picture larger than 1920 pixels on its longer side, whatever the camera gives', async () => {
    const { device, given } = await opened({ size: { width: 3840, height: 2160 } })
    await device.picture()
    expect(given).toEqual([1])
    expect(device.asked()).toEqual([{ resizeWidth: 1920, resizeHeight: 1080, resizeQuality: 'medium' }])
  })

  test('sends no more than 30 pictures in any second, however fast the camera gives them and the page draws them', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { device, given } = await opened({ drawAll: true })
    for (let n = 0; n < 40; n++) await device.picture()
    expect(given).toHaveLength(30)
    now += 999
    await device.picture()
    expect(given).toHaveLength(30)
    now += 1
    await device.picture()
    expect(given).toHaveLength(31)
  })

  test('runs beside a recording of sound, each listed for It’s bar by itself and each ended by its own Stop', async () => {
    vi.stubGlobal('MediaRecorder', StandInRecorder)
    const { told, device } = await opened({ kinds: ['mic', 'camera'] })
    const heard = vi.fn()
    await begin(specOf({ audio: true, video: false }), {
      id: 'rec-1',
      user: 'person-1',
      page: 'page-1',
      owner: OWNER,
      grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!,
      title: 'Page page-1',
      told: heard,
    })
    expect([cameraFor('page-1')?.id, liveFor('page-1')?.id]).toEqual(['cam-1', 'rec-1'])
    // The camera's Stop ends the camera, and the recording goes on
    cameraFor('page-1')!.end('person')
    expect(told).toHaveBeenCalledWith('ended', 'person')
    expect(heard).not.toHaveBeenCalled()
    expect(liveFor('page-1')).toBeDefined()
    expect(device.tracks.map((t) => [t.kind, t.stopped])).toEqual([
      ['video', true],
      ['audio', false],
    ])
    liveFor('page-1')!.end('person')
    await settle()
    expect(heard).toHaveBeenCalledWith('ended', 'person', undefined)
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
  })
})
