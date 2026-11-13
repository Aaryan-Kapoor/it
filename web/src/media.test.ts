// What the site holds a page to before it opens the microphone or the camera for it (media.ts):
// what the person allowed on this screen, kept for that page as the conversation that has it, and
// what a page may ask of the device. The devices themselves are run in real browsers, with their
// own fake microphone and camera, by the end-to-end run.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { displayKey, forgetAll, forgetDisplayKey, keepFor } from './lib'
import {
  allow,
  allowed,
  askPerson,
  cameraFor,
  cameraVideoOf,
  cannotOpen,
  DEVICE_WAIT,
  forgetGrants,
  grantFor,
  grantsOf,
  kindsSaid,
  LIVE_CAMERA,
  LIVE_MICROPHONE,
  microphoneAudioOf,
  microphoneFor,
  openCamera,
  openMicrophone,
  ownerOf,
  shoot,
  shootingNow,
  takeBack,
  usedNow,
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
  test('of the microphone plain switches, and nothing that names a device or is not a plain setting', () => {
    expect(microphoneAudioOf(undefined)).toBe(true)
    expect(microphoneAudioOf(true)).toBe(true)
    expect(microphoneAudioOf({})).toEqual({})
    expect(microphoneAudioOf({ echoCancellation: false, noiseSuppression: false, autoGainControl: true })).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    })
    for (const audio of [{ deviceId: 'abc' }, { groupId: 'x' }, { echoCancellation: 'no' }, { channelCount: 2 }, { sampleRate: 8000 }, 'yes', [true], false])
      expect(() => microphoneAudioOf(audio), JSON.stringify(audio)).toThrow()
    expect(() => microphoneAudioOf({ deviceId: 'abc' })).toThrow('It.microphone does not take audio.deviceId as it was given.')
    // Said of the call that asked, where the camera is opened with sound
    expect(() => microphoneAudioOf({ deviceId: 'abc' }, 'It.camera')).toThrow('It.camera does not take audio.deviceId as it was given.')
    expect(() => microphoneAudioOf(false)).toThrow('It.microphone needs the microphone.')
  })

  test('the kinds, as a person reads them', () => {
    expect([kindsSaid(['mic']), kindsSaid(['camera']), kindsSaid(['mic', 'camera'])]).toEqual(['the microphone', 'the camera', 'the microphone and the camera'])
  })
})

describe('where a browser gives a site the microphone and the camera at all', () => {
  test('not where it reached It over plain http, which is said with what to do', () => {
    // jsdom is no secure context, as a browser at another machine's plain http address is not
    expect(window.isSecureContext).not.toBe(true)
    expect(cannotOpen()).toMatch(/plain http.*it https on/)
    // A file input asks for no secure address, and a page can take a photo with it on any screen
    expect(cannotOpen()).toMatch(/A photo can be taken here all the same with a file input in the page, which opens a phone's own camera\.$/)
  })

  test('and not where the browser has no way to ask for either', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    const had = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    try {
      expect(cannotOpen()).toBe('This browser gives a site no microphone or camera.')
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } })
      expect(cannotOpen()).toBeNull()
    } finally {
      Reflect.deleteProperty(window, 'isSecureContext')
      if (had) Object.defineProperty(navigator, 'mediaDevices', had)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })
})

// A pretend camera, as far as the site goes with it for a photo: the tracks a browser would give,
// which say whether they were stopped. The real devices are the browsers' own, in the end-to-end run.
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

// A pretend for what passes sound on, as far as the site goes with it: what a browser makes sound
// with, which says whether it runs, waits or was closed, and what gathers the microphone's sound
// into pieces, whose pieces the test gives when it likes. The real ones are the browsers' own, in
// the end-to-end run, and what gathers the pieces is tested by itself below.
function standInSound(options: { rate?: number; starts?: boolean; gathers?: boolean | 'never'; whileLoading?: () => void } = {}) {
  const contexts: { state: string; sampleRate: number; asked: string[]; connected: number }[] = []
  const nodes: { options: any; port: { onmessage: ((m: { data: unknown }) => void) | null } }[] = []
  class Context {
    state = 'suspended'
    sampleRate = options.rate ?? 48_000
    /** The files it was asked to load what gathers the pieces from. */
    asked: string[] = []
    connected = 0
    audioWorklet = {
      addModule: async (url: string) => {
        this.asked.push(url)
        options.whileLoading?.()
        if (options.gathers === false) throw new Error('The browser would not load it')
        // A file that never comes, as from a site that has stopped answering
        if (options.gathers === 'never') await new Promise(() => {})
      },
    }
    constructor() {
      contexts.push(this)
    }
    // A browser that will not start sound leaves whoever asked waiting, and says nothing
    resume() {
      if (options.starts === false) return new Promise<void>(() => {})
      this.state = 'running'
      return Promise.resolve()
    }
    async suspend() {
      this.state = 'suspended'
    }
    async close() {
      this.state = 'closed'
    }
    createMediaStreamSource() {
      return { connect: () => this.connected++, disconnect: () => this.connected-- }
    }
  }
  class Node {
    port = { onmessage: null as ((m: { data: unknown }) => void) | null }
    constructor(
      _context: unknown,
      public name: string,
      public options: any,
    ) {
      nodes.push(this)
    }
  }
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Node)
  return {
    contexts,
    nodes,
    /** The microphone gives a piece of sound: so many samples, or whatever else the test hands over in their place. */
    piece: (given: unknown = new Float32Array(960)) => nodes.at(-1)!.port.onmessage?.({ data: given }),
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
  const opened = async (
    options: {
      size?: { width: number; height: number }
      drawAll?: boolean
      kinds?: ('mic' | 'camera')[]
      /** Opened with sound, which is the microphone's, with what the test's browser makes of sound. */
      sound?: Parameters<typeof standInSound>[0]
    } = {},
  ) => {
    const kinds: ('mic' | 'camera')[] = options.sound ? ['mic', 'camera'] : ['camera']
    allow('person-1', grant('page-1', options.kinds ?? kinds))
    const device = standInCamera(options.size)
    const sound = options.sound ? standInSound(options.sound) : null
    const given: number[] = []
    const pieces: [number, number, number][] = []
    const told = vi.fn()
    let refuse: 'taken_over' | 'taken_back' | null = null
    const live = await openCamera(true, !!options.sound, {
      ...camera,
      id: 'cam-1',
      grant: grantFor('person-1', 'page-1', OWNER, kinds)!,
      still: () => refuse,
      picture: (frame) => {
        given.push(frame)
        // A page that draws each picture the moment it comes
        if (options.drawAll) live.drawn(frame)
      },
      sound: (chunk, sampleRate, samples) => pieces.push([chunk, sampleRate, samples.length]),
      told,
    })
    open = live
    return { device, sound: sound!, given, pieces, told, live, refuse: (why: 'taken_over' | 'taken_back' = 'taken_over') => (refuse = why) }
  }

  test('a camera the page may no longer have by the time the browser gives it, or while it starts to play, is closed then, and says why', async () => {
    allow('person-1', grant('page-1', ['camera']))
    const device = standInCamera()
    const asOpened = { ...camera, id: 'cam-1', grant: grantFor('person-1', 'page-1', OWNER, ['camera'])!, picture: () => {}, sound: () => {}, told: vi.fn() }
    // Already not the page's as the browser gives it
    await expect(openCamera(true, false, { ...asOpened, still: () => 'replaced' })).rejects.toMatchObject({ why: 'replaced' })
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    // And while it starts to play, which here never ends
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(new Promise(() => {}))
    let not: 'replaced' | null = null
    const opening = openCamera(true, false, { ...asOpened, still: () => not })
    const settled = vi.fn()
    opening.then(settled, settled)
    await settle()
    expect(settled).not.toHaveBeenCalled()
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, false])
    not = 'replaced'
    await expect(opening).rejects.toMatchObject({ why: 'replaced' })
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    expect(cameraFor('page-1')).toBeUndefined()
  })

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

  test('runs beside the live microphone, each listed for It’s bar by itself and each ended by its own Stop', async () => {
    const { told, device } = await opened({ kinds: ['mic', 'camera'] })
    standInSound()
    const heard = vi.fn()
    const mic = await openMicrophone(true, {
      id: 'mic-1',
      user: 'person-1',
      page: 'page-1',
      owner: OWNER,
      grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!,
      title: 'Page page-1',
      still: () => null,
      sound: () => {},
      told: heard,
    })
    try {
      expect([cameraFor('page-1')?.id, microphoneFor('page-1')?.id]).toEqual(['cam-1', 'mic-1'])
      // The camera's Stop ends the camera, and the microphone goes on
      cameraFor('page-1')!.end('person')
      expect(told).toHaveBeenCalledWith('ended', 'person')
      expect(heard).not.toHaveBeenCalled()
      expect(microphoneFor('page-1')).toBeDefined()
      expect(device.tracks.map((t) => [t.kind, t.stopped])).toEqual([
        ['video', true],
        ['audio', false],
      ])
      microphoneFor('page-1')!.end('person')
      expect(heard).toHaveBeenCalledWith('ended', 'person')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    } finally {
      mic.stop()
    }
  })

  describe('opened with sound', () => {
    test('opens the microphone with it, sends the page its sound in numbered pieces beside the pictures, and says how many samples there are in a second', async () => {
      const { device, sound, given, pieces, live } = await opened({ sound: { rate: 44_100 } })
      expect(device.tracks.map((t) => t.kind)).toEqual(['audio', 'video'])
      expect(live.sampleRate).toBe(44_100)
      sound.piece(new Float32Array(882))
      sound.piece(new Float32Array(882))
      await device.picture()
      expect(pieces).toEqual([
        [1, 44_100, 882],
        [2, 44_100, 882],
      ])
      expect(given).toEqual([1])
    })

    test('is listed for It’s bar as one thing with both, and its one Stop closes the camera and the microphone together', async () => {
      const { device, sound, told } = await opened({ sound: {} })
      expect(cameraFor('page-1')).toMatchObject({ id: 'cam-1', kinds: ['mic', 'camera'] })
      expect(microphoneFor('page-1')).toBeUndefined()
      const host = document.body.appendChild(document.createElement('div'))
      const root = createRoot(host)
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
      expect(host.querySelectorAll('.media-live')).toHaveLength(1)
      expect(host.querySelector('.media-cam')?.textContent).toBe('Camera and mic liveStop')
      expect(host.querySelector('.media-cam')?.getAttribute('aria-label')).toBe('The camera and the microphone are live to “Page page-1”')
      // Marked as the wider chip, which on a phone shows only the square of its Stop
      expect(host.querySelector('.media-cam')?.hasAttribute('data-sound')).toBe(true)
      await act(async () => (host.querySelector('button[aria-label="Stop the camera and the microphone"]') as HTMLButtonElement).click())
      expect(told).toHaveBeenCalledWith('ended', 'person')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
      expect(sound.contexts[0]!.state).toBe('closed')
      // And no sound goes after it
      sound.piece()
      expect(host.textContent).toBe('')
      await act(async () => root.unmount())
      host.remove()
    })

    test('ends when what the page is allowed no longer has the microphone, though it still has the camera', async () => {
      const { device, told } = await opened({ sound: {} })
      // The same grant, as what is kept in the browser then says it, with the microphone no longer in it
      const key = `it.media.person-1.${displayKey()}`
      const kept = JSON.parse(localStorage.getItem(key)!) as { kinds: string[] }[]
      Storage.prototype.setItem.call(localStorage, key, JSON.stringify(kept.map((g) => ({ ...g, kinds: ['camera'] }))))
      expect(grantFor('person-1', 'page-1', OWNER, ['camera'])).not.toBeNull()
      window.dispatchEvent(new StorageEvent('storage', { key }))
      expect(told).toHaveBeenCalledWith('ended', 'taken_back')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    })

    test('sends no sound, and makes none, while the screen does not show the site', async () => {
      const { device, sound, pieces } = await opened({ sound: {} })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      expect(device.tracks.map((t) => t.enabled)).toEqual([false, false])
      expect(sound.contexts[0]!.state).toBe('suspended')
      sound.piece()
      expect(pieces).toEqual([])
    })

    test('ends with the reason the page may not have it any more, asked before a piece of sound is handed on, which is not sent', async () => {
      const { device, sound, pieces, told, refuse } = await opened({ sound: {} })
      refuse('taken_over')
      sound.piece()
      expect(pieces).toEqual([])
      expect(told).toHaveBeenCalledWith('ended', 'taken_over')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    })

    test('where the browser cannot pass the sound on, the camera and the microphone are let go of and nothing is opened', async () => {
      allow('person-1', grant('page-1', ['mic', 'camera']))
      const device = standInCamera()
      standInSound({ gathers: false })
      await expect(
        openCamera(true, true, {
          ...camera,
          id: 'cam-1',
          grant: grantFor('person-1', 'page-1', OWNER, ['mic', 'camera'])!,
          still: () => null,
          picture: () => {},
          sound: () => {},
          told: () => {},
        }),
      ).rejects.toThrow('This browser cannot pass the microphone’s sound on to a page.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
      expect(cameraFor('page-1')).toBeUndefined()
    })
  })
})

describe('the microphone, live to a page', () => {
  const microphone = { user: 'person-1', page: 'page-1', owner: OWNER, title: 'Page page-1' }
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
  /** The page allowed the microphone, and the microphone opened for it: what it was given, and what it was told. */
  const opened = async (options: { sound?: Parameters<typeof standInSound>[0]; takeAll?: boolean; audio?: true | MediaTrackConstraints } = {}) => {
    allow('person-1', grant('page-1', ['mic']))
    const device = standInCamera()
    const sound = standInSound(options.sound)
    const pieces: [number, number, number][] = []
    const told = vi.fn()
    let refuse: 'taken_over' | 'taken_back' | null = null
    const live = await openMicrophone(options.audio ?? true, {
      ...microphone,
      id: 'mic-1',
      grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!,
      still: () => refuse,
      sound: (chunk, sampleRate, samples) => {
        pieces.push([chunk, sampleRate, samples.length])
        // A page that takes each piece the moment it comes
        if (options.takeAll) live.heard(chunk)
      },
      told,
    })
    open = live
    return { device, sound, pieces, told, live, refuse: (why: 'taken_over' | 'taken_back' = 'taken_over') => (refuse = why) }
  }

  test('asks the browser for the microphone alone, with what the page asked of it, and gathers its sound from a file of the site’s own, of one channel, a fiftieth of a second to a piece', async () => {
    const { device, sound, live } = await opened({ audio: { echoCancellation: false } })
    const asked = (navigator.mediaDevices.getUserMedia as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(asked).toEqual([[{ audio: { echoCancellation: false }, video: false }]])
    expect(device.tracks.map((t) => t.kind)).toEqual(['audio'])
    expect(sound.contexts[0]!.asked).toEqual(['/sound-worklet.js'])
    expect(sound.contexts[0]!.connected).toBe(1)
    expect(sound.nodes[0]).toMatchObject({
      name: 'it-sound-pieces',
      options: { channelCount: 1, channelCountMode: 'explicit', processorOptions: { samples: 960 } },
    })
    expect(live.sampleRate).toBe(48_000)
    expect(LIVE_MICROPHONE.pieceMs).toBe(20)
  })

  test('a piece is a fiftieth of a second at whatever rate the browser makes sound, and never more than the most a piece may hold', async () => {
    const at = async (rate: number) => {
      const { sound, live } = await opened({ sound: { rate } })
      live.stop()
      return sound.nodes[0]!.options.processorOptions.samples
    }
    expect(await at(44_100)).toBe(882)
    expect(await at(96_000)).toBe(1920)
    expect(await at(384_000)).toBe(LIVE_MICROPHONE.mostSamples)
    expect(LIVE_MICROPHONE.mostSamples).toBe(4096)
  })

  test('sends the page each piece numbered in order, with how many samples there are in a second', async () => {
    const { sound, pieces } = await opened({ takeAll: true })
    for (let n = 0; n < 3; n++) sound.piece()
    expect(pieces).toEqual([
      [1, 48_000, 960],
      [2, 48_000, 960],
      [3, 48_000, 960],
    ])
  })

  test('sends a page no more than ten pieces it has not said it took, passes over what the microphone gives in between, and sends again once it says it took them', async () => {
    const { sound, pieces, live } = await opened()
    expect(LIVE_MICROPHONE.atOnce).toBe(10)
    for (let n = 0; n < 25; n++) sound.piece()
    expect(pieces.map(([chunk]) => chunk)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Said of a piece it was never sent, or of nothing that is a number of one, it makes no room
    live.heard(11)
    live.heard(99)
    live.heard(Number.NaN)
    live.heard(1.5)
    sound.piece()
    expect(pieces).toHaveLength(10)
    // Having taken every piece up to the fourth, it is sent four more, numbered on from the last sent
    live.heard(4)
    for (let n = 0; n < 9; n++) sound.piece()
    expect(pieces.map(([chunk]) => chunk)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    // And an earlier piece said again takes nothing back
    live.heard(2)
    sound.piece()
    expect(pieces).toHaveLength(14)
  })

  test('sends nothing that is not a run of samples, and no piece larger than the most', async () => {
    const { sound, pieces } = await opened({ takeAll: true })
    sound.piece(new Float32Array(LIVE_MICROPHONE.mostSamples + 1))
    sound.piece(new Float32Array(0))
    sound.piece('sound')
    sound.piece([0.5, 0.5])
    sound.piece(new Uint8Array(960))
    expect(pieces).toEqual([])
    sound.piece(new Float32Array(LIVE_MICROPHONE.mostSamples))
    expect(pieces).toEqual([[1, 48_000, LIVE_MICROPHONE.mostSamples]])
  })

  test('is listed for It’s bar while it is open, and no longer once it is closed, when the microphone is let go of and no more sound is passed on', async () => {
    const { device, sound, pieces, live, told } = await opened()
    expect(microphoneFor('page-1')).toMatchObject({ id: 'mic-1', page: 'page-1', state: 'live' })
    live.stop()
    expect(microphoneFor('page-1')).toBeUndefined()
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(sound.contexts[0]!.state).toBe('closed')
    expect(sound.contexts[0]!.connected).toBe(0)
    sound.piece()
    expect(pieces).toEqual([])
    // Closed as the page asked, it is not told of it as of something it did not ask
    expect(told).not.toHaveBeenCalled()
  })

  test('ends when the person takes back what the page was allowed, and sends nothing more', async () => {
    const { device, sound, pieces, told } = await opened()
    sound.piece()
    takeBack('person-1', 'page-1')
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    sound.piece()
    expect(pieces).toHaveLength(1)
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('ends when another tab took back what the page was allowed and allowed it again before this tab heard of it', async () => {
    const { device, told } = await opened()
    anotherTabTookBackAndAllowedAgain(['mic'])
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('ends when what is allowed is another conversation’s now', async () => {
    const { device, told } = await opened()
    allow('person-1', grant('page-1', ['mic'], ownerOf({ machineId: 'machine-1', session: { harness: 'codex', id: 'other' } })))
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('ends when this browser signs out', async () => {
    const { device, told } = await opened()
    forgetGrants('person-1')
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('goes on while the page uses what it was allowed again, and while more is allowed beside it, which keeps the same grant', async () => {
    const { device, sound, pieces, told } = await opened()
    usedNow('person-1', 'page-1')
    allow('person-1', grant('page-2', ['mic']))
    allow('person-1', grant('page-1', ['camera']))
    sound.piece()
    expect(told).not.toHaveBeenCalled()
    expect(pieces).toHaveLength(1)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
  })

  test('ends with the reason the page may not have the microphone any more, asked before a piece of sound is handed on, which is not sent', async () => {
    const { device, sound, pieces, told, refuse } = await opened()
    refuse()
    sound.piece()
    expect(told).toHaveBeenCalledWith('ended', 'taken_over')
    expect(pieces).toEqual([])
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(sound.contexts[0]!.state).toBe('closed')
  })

  test('ends when the microphone goes away', async () => {
    const { device, told } = await opened()
    device.tracks[0]!.gone()
    expect(told).toHaveBeenCalledWith('ended', 'device')
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('waits while the screen does not show the site, turning the microphone off and sending nothing, and goes on when it does again', async () => {
    const { device, sound, pieces, told } = await opened({ takeAll: true })
    let hidden = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(told).toHaveBeenLastCalledWith('paused')
    expect(microphoneFor('page-1')?.state).toBe('paused')
    expect(device.tracks.map((t) => t.enabled)).toEqual([false])
    expect(sound.contexts[0]!.state).toBe('suspended')
    // What was on its way from the microphone as the screen stopped showing the site is not sent either
    sound.piece()
    expect(pieces).toEqual([])
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(told).toHaveBeenLastCalledWith('live')
    expect(device.tracks.map((t) => t.enabled)).toEqual([true])
    expect(sound.contexts[0]!.state).toBe('running')
    sound.piece()
    expect(pieces).toHaveLength(1)
  })

  test('opened while the screen does not show the site, it waits at once', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const { device, sound, pieces, told } = await opened()
    expect(told).toHaveBeenCalledWith('paused')
    expect(device.tracks.map((t) => t.enabled)).toEqual([false])
    sound.piece()
    expect(pieces).toEqual([])
  })

  test('is said in It’s bar as live to the page, and its Stop ends it as the person stopping it', async () => {
    const { told } = await opened()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.querySelector('.media-mic')?.textContent).toBe('Mic liveStop')
    expect(host.querySelector('.media-mic')?.getAttribute('aria-label')).toBe('The microphone is live to “Page page-1”')
    expect(host.querySelector('.media-mic')?.getAttribute('title')).toBe('The microphone is live to “Page page-1”: the page hears it as it happens')
    // What it says in place of its words on a phone, beside the camera's chip or a question
    expect(host.querySelector('.media-mic .media-live-what')?.getAttribute('data-short')).toBe('Mic')
    expect(host.querySelector('video, .media-cam, [role="dialog"]')).toBeNull()
    await act(async () => (host.querySelector('button[aria-label="Stop the microphone"]') as HTMLButtonElement).click())
    expect(told).toHaveBeenCalledWith('ended', 'person')
    expect(host.textContent).toBe('')
    await act(async () => root.unmount())
    host.remove()
  })

  test('says in It’s bar that it is paused while the screen does not show the site', async () => {
    await opened()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(createElement(MediaBar, { page: 'page-1' })))
    expect(host.querySelector('.media-mic')?.textContent).toBe('Mic pausedStop')
    expect(host.querySelector('.media-mic')?.getAttribute('data-state')).toBe('paused')
    expect(host.querySelector('.media-mic')?.getAttribute('aria-label')).toBe('The microphone is paused to “Page page-1”')
    await act(async () => root.unmount())
    host.remove()
  })

  test('stays in It’s bar, with its Stop, while It asks the person about the camera for the same page, and the button that takes back what was allowed is hidden while it is live', async () => {
    const { MediaAllowed } = await import('./recording')
    const { told } = await opened()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    let asked: ReturnType<typeof askPerson> | null = null
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(MediaBar, { page: 'page-1' }),
          createElement(MediaAllowed, { user: 'person-1', page: 'page-1', title: 'Page page-1' }),
        ),
      )
      asked = askPerson({ page: 'page-1', title: 'Page page-1', agent: 'Claude Code', machine: 'studio', kinds: ['camera'] })
    })
    expect(host.querySelector('.media-ask')?.textContent).toContain('wants the camera')
    expect(host.querySelector('.media-mic .media-live-dot')).not.toBeNull()
    expect(host.querySelector('.media-allowed')).toBeNull()
    // And it can be stopped from there, while the question stays
    await act(async () => (host.querySelector('button[aria-label="Stop the microphone"]') as HTMLButtonElement).click())
    expect(told).toHaveBeenCalledWith('ended', 'person')
    expect(host.querySelector('.media-mic')).toBeNull()
    expect(host.querySelector('.media-ask')).not.toBeNull()
    // Closed, the button that takes back what was allowed is there again, once the question is answered
    await act(async () => ([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Not now') as HTMLButtonElement).click())
    expect(await asked!.answer).toBe(false)
    expect(host.querySelector('.media-allowed')).not.toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })

  test('is asked every second whether the page may still have it, whatever the page took, so that a page that took nothing is let go of too', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { device, sound, pieces, told, refuse } = await opened()
    for (let n = 0; n < 12; n++) sound.piece()
    // Ten pieces sent and none taken: no more is sent, and so no piece would ever ask
    expect(pieces).toHaveLength(10)
    vi.advanceTimersByTime(LIVE_MICROPHONE.checkEveryMs)
    expect(told).not.toHaveBeenCalled()
    refuse('taken_back')
    vi.advanceTimersByTime(LIVE_MICROPHONE.checkEveryMs)
    expect(told).toHaveBeenCalledWith('ended', 'taken_back')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('notes that the page uses what it was allowed every hour while it is open, and not more often, so that it does not lapse while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-11-10T12:00:00Z') })
    const { device } = await opened()
    const key = `it.media.person-1.${displayKey()}.used.${grantFor('person-1', 'page-1', OWNER, ['mic'])}`
    expect(localStorage.getItem(key)).toBeNull()
    vi.advanceTimersByTime(LIVE_MICROPHONE.usedEveryMs - LIVE_MICROPHONE.checkEveryMs)
    expect(localStorage.getItem(key)).toBeNull()
    vi.advanceTimersByTime(LIVE_MICROPHONE.checkEveryMs)
    expect(Number(localStorage.getItem(key))).toBe(Date.now())
    // Open for fifty-eight days, which is past the thirty a grant lasts unused, and still allowed
    const day = 24 * 60 * 60_000
    for (const _ of [1, 2]) {
      vi.setSystemTime(Date.now() + 29 * day)
      vi.advanceTimersByTime(LIVE_MICROPHONE.checkEveryMs)
      expect(Number(localStorage.getItem(key))).toBe(Date.now())
    }
    expect(grantFor('person-1', 'page-1', OWNER, ['mic'])).not.toBeNull()
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
  })

  describe('where the browser cannot pass its sound on', () => {
    /** Asked to open, with what the test's browser makes of sound: what it rejects with, and what became of the microphone. */
    const refused = async (sound: () => void) => {
      allow('person-1', grant('page-1', ['mic']))
      const device = standInCamera()
      sound()
      const opening = openMicrophone(true, {
        ...microphone,
        id: 'mic-1',
        grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!,
        still: () => null,
        sound: () => {},
        told: () => {},
      })
      return { device, opening }
    }

    test('for having nothing to make sound with, it says so, and lets go of the microphone', async () => {
      const { device, opening } = await refused(() => {
        vi.stubGlobal('AudioContext', undefined)
        vi.stubGlobal('AudioWorkletNode', undefined)
      })
      await expect(opening).rejects.toThrow('This browser cannot pass the microphone’s sound on to a page.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true])
      expect(microphoneFor('page-1')).toBeUndefined()
    })

    test('for not loading what gathers the pieces, it says so in its own words and not the browser’s, and closes what it made', async () => {
      let made: ReturnType<typeof standInSound> | null = null
      const { device, opening } = await refused(() => {
        made = standInSound({ gathers: false })
      })
      await expect(opening).rejects.toThrow('This browser cannot pass the microphone’s sound on to a page.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true])
      expect(made!.contexts[0]!.state).toBe('closed')
    })

    test('for not loading what gathers the pieces in two seconds, it waits no longer, says so, and lets go of the microphone, which was open all the while', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let made: ReturnType<typeof standInSound> | null = null
      const { device, opening } = await refused(() => {
        made = standInSound({ gathers: 'never' })
      })
      const outcome = opening.then(
        () => 'opened',
        (err: Error) => err.message,
      )
      await vi.advanceTimersByTimeAsync(LIVE_MICROPHONE.startMs - 1)
      expect(device.tracks.map((t) => t.stopped)).toEqual([false])
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toBe('This browser cannot pass the microphone’s sound on to a page.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true])
      expect(made!.contexts[0]!.state).toBe('closed')
      expect(microphoneFor('page-1')).toBeUndefined()
    })

    test('a microphone that went away while its sound was being made ready, when nothing was listening for that yet, is not opened, and nothing is listed for It’s bar', async () => {
      allow('person-1', grant('page-1', ['mic']))
      const device = standInCamera()
      // Unplugged while what gathers its sound is loading
      const made = standInSound({ whileLoading: () => Object.assign(device.tracks[0]!, { readyState: 'ended' }) })
      const opening = openMicrophone(true, {
        ...microphone,
        id: 'mic-1',
        grant: grantFor('person-1', 'page-1', OWNER, ['mic'])!,
        still: () => null,
        sound: () => {},
        told: () => {},
      })
      await expect(opening).rejects.toThrow('The microphone or the camera went away while it was being opened.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true])
      expect(made.contexts[0]!.state).toBe('closed')
      expect(microphoneFor('page-1')).toBeUndefined()
    })

    test('for not starting sound, it is given two seconds and no longer, and the page is told to ask again from a click', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let made: ReturnType<typeof standInSound> | null = null
      const { device, opening } = await refused(() => {
        made = standInSound({ starts: false })
      })
      const outcome = opening.then(
        () => 'opened',
        (err: Error) => err.message,
      )
      await vi.advanceTimersByTimeAsync(LIVE_MICROPHONE.startMs - 1)
      expect(device.tracks.map((t) => t.stopped)).toEqual([false])
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toBe('The browser did not start the sound for It on this screen. Ask again from a click on the page.')
      expect(device.tracks.map((t) => t.stopped)).toEqual([true])
      expect(made!.contexts[0]!.state).toBe('closed')
      expect(microphoneFor('page-1')).toBeUndefined()
    })
  })
})

describe('how long the browser is given to hand over the device', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    giveBack()
  })
  /** The stand-in camera and microphone, with a browser that gives them only when the test says so, as one whose own question is still open. */
  const slowBrowser = () => {
    const device = standInCamera()
    const asking = navigator.mediaDevices.getUserMedia as (asked: MediaStreamConstraints) => Promise<MediaStream>
    let give: () => void = () => {}
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: (asked: MediaStreamConstraints) =>
          new Promise<MediaStream>((resolve) => {
            give = () => resolve(asking(asked))
          }),
      },
    })
    return { device, give: () => give() }
  }
  const page = (kinds: ('mic' | 'camera')[]) => ({
    id: 'live-1',
    user: 'person-1',
    page: 'page-1',
    owner: OWNER,
    title: 'Page page-1',
    grant: grantFor('person-1', 'page-1', OWNER, kinds)!,
    still: () => null,
    picture: () => {},
    sound: () => {},
    told: () => {},
  })
  const outcome = (opening: Promise<unknown>) =>
    opening.then(
      () => 'opened',
      (err: Error) => err.message,
    )
  const NO_ANSWER = 'The browser did not give It the microphone or the camera in time. Ask again from something the person does on the page.'

  test('a browser that does not answer for the microphone within a minute leaves the page waiting no longer, and a microphone it gives after that is let go of at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(DEVICE_WAIT.answerMs).toBe(60_000)
    allow('person-1', grant('page-1', ['mic']))
    const { device, give } = slowBrowser()
    standInSound()
    const opening = outcome(openMicrophone(true, page(['mic'])))
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.answerMs - 1)
    let settled = false
    void opening.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await opening).toBe(NO_ANSWER)
    // The person answers the browser's own question after all
    give()
    await vi.advanceTimersByTimeAsync(0)
    expect(device.tracks.map((t) => [t.kind, t.stopped])).toEqual([['audio', true]])
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('the same for a camera, with sound or without, and for a photo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    allow('person-1', grant('page-1', ['mic', 'camera']))
    const { device, give } = slowBrowser()
    standInSound()
    const opening = outcome(openCamera(true, true, page(['mic', 'camera'])))
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.answerMs)
    expect(await opening).toBe(NO_ANSWER)
    give()
    await vi.advanceTimersByTimeAsync(0)
    expect(device.tracks.map((t) => [t.kind, t.stopped])).toEqual([
      ['audio', true],
      ['video', true],
    ])
    expect(cameraFor('page-1')).toBeUndefined()

    const photo = outcome(shoot({ page: 'page-1', title: 'Page page-1', user: 'person-1', owner: OWNER, grant: page(['camera']).grant }, undefined))
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.answerMs)
    expect(await photo).toBe(NO_ANSWER)
    give()
    await vi.advanceTimersByTimeAsync(0)
    expect(device.tracks.slice(2).map((t) => [t.kind, t.stopped])).toEqual([['video', true]])
    // And the camera is free for the next
    expect(shootingNow()).toBeNull()
  })

  test('a browser that refuses within the minute is told as it refused, and not as one that did not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    allow('person-1', grant('page-1', ['mic']))
    standInCamera()
    const refusal = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(refusal) } })
    await expect(openMicrophone(true, page(['mic']))).rejects.toBe(refusal)
    // And nothing is refused again when the minute is up
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.answerMs)
  })

  test('a microphone whose page may not have it any more while its sound is made ready is stopped there and then, and not when it is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    allow('person-1', grant('page-1', ['mic']))
    const device = standInCamera()
    const made = standInSound({ gathers: 'never' })
    let refuse: 'taken_back' | null = null
    const opening = outcome(openMicrophone(true, { ...page(['mic']), still: () => refuse }))
    await vi.advanceTimersByTimeAsync(300)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
    refuse = 'taken_back'
    await vi.advanceTimersByTimeAsync(100)
    // Stopped while what gathers its sound is still loading
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    await vi.advanceTimersByTimeAsync(LIVE_MICROPHONE.startMs)
    expect(await opening).toBe('The person took back what they had allowed this page.')
    expect(made.contexts[0]!.state).toBe('closed')
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('a camera with sound whose page is taken over while its picture begins is stopped there and then, the camera and the microphone both', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    allow('person-1', grant('page-1', ['mic', 'camera']))
    const device = standInCamera()
    const made = standInSound()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(new Promise<void>(() => {}))
    let refuse: 'taken_over' | null = null
    const opening = outcome(openCamera(true, true, { ...page(['mic', 'camera']), still: () => refuse }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false, false])
    refuse = 'taken_over'
    await vi.advanceTimersByTimeAsync(100)
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.playMs)
    expect(await opening).toMatch(/^Another conversation took this page over/)
    // Its sound was never begun
    expect(made.contexts).toHaveLength(0)
    expect(cameraFor('page-1')).toBeUndefined()
  })

  test('a device the browser gives for a page that was closed meanwhile is stopped as it comes, and nothing is made ready for it', async () => {
    allow('person-1', grant('page-1', ['mic', 'camera']))
    const device = standInCamera()
    const made = standInSound()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    await expect(openCamera(true, true, { ...page(['mic', 'camera']), still: () => 'not_shown' })).rejects.toThrow('The page was closed.')
    await expect(openMicrophone(true, { ...page(['mic']), still: () => 'not_shown' })).rejects.toThrow('The page was closed.')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, true, true])
    expect(play).not.toHaveBeenCalled()
    expect(made.contexts).toHaveLength(0)
  })

  test('a microphone the page may no longer have by the time the browser gives it is closed then, says why, and has nothing made ready for it', async () => {
    allow('person-1', grant('page-1', ['mic']))
    const device = standInCamera()
    const made = standInSound()
    await expect(openMicrophone(true, { ...page(['mic']), still: () => 'replaced' })).rejects.toMatchObject({
      why: 'replaced',
      message: 'The page loaded another document, which asks for itself.',
    })
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(made.contexts).toHaveLength(0)
    expect(microphoneFor('page-1')).toBeUndefined()
  })

  test('a microphone whose sound is being made ready is given a way to be stopped at once, which stops it there and then and says it was replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    allow('person-1', grant('page-1', ['mic']))
    const device = standInCamera()
    const made = standInSound({ gathers: 'never' })
    const stops: ((() => void) | null)[] = []
    const opening = openMicrophone(true, { ...page(['mic']), starting: (stop) => stops.push(stop) })
    const said = opening.then(
      () => null,
      (err: Error & { why?: string }) => ({ message: err.message, why: err.why }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(stops).toHaveLength(1)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
    // The page's frame loads another document while what gathers the sound is still loading
    stops[0]!()
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    await vi.advanceTimersByTimeAsync(0)
    expect(await said).toEqual({ message: 'The page loaded another document, which asks for itself.', why: 'replaced' })
    // And it is given nothing once it is no longer being made ready
    expect(stops).toEqual([stops[0], null])
    expect(microphoneFor('page-1')).toBeUndefined()
    // What was being made ready for it is closed when that ends
    await vi.advanceTimersByTimeAsync(LIVE_MICROPHONE.startMs)
    expect(made.contexts[0]!.state).toBe('closed')
  })

  test('a camera with sound is given the same way to be stopped while its sound is made ready, after its picture began, and stops both there and then', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    allow('person-1', grant('page-1', ['mic', 'camera']))
    const device = standInCamera()
    const made = standInSound({ gathers: 'never' })
    const stops: ((() => void) | null)[] = []
    const opening = outcome(openCamera(true, true, { ...page(['mic', 'camera']), starting: (stop) => stops.push(stop) }))
    await vi.advanceTimersByTimeAsync(0)
    // Its picture has begun, and its sound is being made ready: the way to stop it is still its own
    expect(made.contexts).toHaveLength(1)
    expect(stops).toHaveLength(1)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false, false])
    stops[0]!()
    expect(device.tracks.map((t) => t.stopped)).toEqual([true, true])
    expect(await opening).toBe('The page loaded another document, which asks for itself.')
    expect(stops).toEqual([stops[0], null])
    expect(cameraFor('page-1')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(LIVE_MICROPHONE.startMs)
    expect(made.contexts[0]!.state).toBe('closed')
  })

  test('a camera that gives no picture within five seconds of opening is let go of, and is never listed for It’s bar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(DEVICE_WAIT.playMs).toBe(5_000)
    allow('person-1', grant('page-1', ['camera']))
    const device = standInCamera()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(new Promise<void>(() => {}))
    const opening = outcome(openCamera(true, false, page(['camera'])))
    await vi.advanceTimersByTimeAsync(DEVICE_WAIT.playMs - 1)
    expect(device.tracks.map((t) => t.stopped)).toEqual([false])
    await vi.advanceTimersByTimeAsync(1)
    expect(await opening).toBe('The camera gave It no picture in time. Ask again from something the person does on the page.')
    expect(device.tracks.map((t) => t.stopped)).toEqual([true])
    expect(cameraFor('page-1')).toBeUndefined()
  })
})

// What gathers the microphone's sound into pieces is a file of the site's own, which a browser
// runs where it makes sound and nowhere a test can reach. It is run here as the browser runs it,
// with a stand-in for what it is given there.
describe('what gathers the microphone’s sound into pieces', () => {
  /** The file, run as a browser runs it: what it registered, by the name it registered it under. */
  const gatherer = () => {
    const registered = new Map<string, new (options: unknown) => { port: { sent: Float32Array[] }; process: (inputs: Float32Array[][]) => boolean }>()
    class Processor {
      port = {
        sent: [] as Float32Array[],
        postMessage(piece: Float32Array, handedOver: ArrayBuffer[]) {
          // Handed over whole, as a browser does with what is named for it: what was sent is the piece itself
          expect(handedOver).toEqual([piece.buffer])
          this.sent.push(piece)
        },
      }
    }
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sound-worklet.js'), 'utf8')
    new Function('AudioWorkletProcessor', 'registerProcessor', source)(Processor, (name: string, made: never) => registered.set(name, made))
    return registered
  }
  /** As many samples as a browser gives at once, counted on from where the last left off. */
  const heard = (from: number, count = 128) => [[Float32Array.from({ length: count }, (_, n) => from + n)]]

  test('registers itself under the name the site asks for it by', () => {
    expect([...gatherer().keys()]).toEqual(['it-sound-pieces'])
  })

  test('hands over a piece each time it has gathered as many samples as one holds, in order and with none lost between two pieces', () => {
    const Gatherer = gatherer().get('it-sound-pieces')!
    const made = new Gatherer({ processorOptions: { samples: 300 } })
    let from = 0
    for (let n = 0; n < 5; n++) {
      expect(made.process(heard(from))).toBe(true)
      from += 128
    }
    // 640 samples heard: two pieces of 300, and forty waiting for the next
    expect(made.port.sent.map((piece) => piece.length)).toEqual([300, 300])
    expect([made.port.sent[0]![0], made.port.sent[0]![299], made.port.sent[1]![0], made.port.sent[1]![299]]).toEqual([0, 299, 300, 599])
    // Each is a piece of its own, and not the one before written over
    expect(made.port.sent[0]).not.toBe(made.port.sent[1])
  })

  test('goes on, and hands nothing over, while the microphone gives it nothing', () => {
    const Gatherer = gatherer().get('it-sound-pieces')!
    const made = new Gatherer({ processorOptions: { samples: 128 } })
    expect(made.process([])).toBe(true)
    expect(made.process([[]])).toBe(true)
    expect(made.port.sent).toEqual([])
  })

  test('gathers a fiftieth of a second at the usual rate where it is told nothing it can go by, and never more than the most a piece may hold', () => {
    const Gatherer = gatherer().get('it-sound-pieces')!
    for (const samples of [undefined, 0, -5, 1.5, 4097, 'many']) {
      const made = new Gatherer({ processorOptions: { samples } })
      for (let n = 0; n < 8; n++) made.process(heard(n * 128))
      expect(
        made.port.sent.map((piece) => piece.length),
        String(samples),
      ).toEqual([960])
    }
    expect(new Gatherer(undefined).process(heard(0))).toBe(true)
  })
})
