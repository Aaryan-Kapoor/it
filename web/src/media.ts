// The microphone and the camera, for a page that calls for them.
//
// No browser gives either to a page. A page is a sandboxed document with no origin of its own
// (mount.tsx), and a browser gives the microphone and the camera only to an origin it can ask the
// person about. So the site opens them, under its own origin, for a page that asks it to, and
// passes the page what they give as it comes: the camera's pictures one by one, and the
// microphone's sound in small pieces. The page makes a stream of its own from them, to show, to
// record or to send in a call. A photo is taken by the person in a view of It's own, and the page
// is given that one picture as a file.
//
// The browser asks the person once whether the site may use the microphone, and that would then
// be for every page there is. So the site asks first, in words of its own, for each page on each
// screen: which page, which agent made it, and what it would use. What the person allows is kept
// in this browser, for this pairing, for that page as the conversation that has it now has it: a
// page taken over by another conversation is asked about again. It is taken back in the page's
// bar or under Settings. While a page has either, It's bar says so and can stop it; while the
// screen does not show the site, both wait, and the page is given nothing.

import { MEDIA_GRANT, type MediaKind } from '@it/protocol'
import { useSyncExternalStore } from 'react'
import { displayKey } from './lib'

const tellers = new Set<() => void>()
/** Whatever shows any of this is told that something changed. */
let changes = 0
function changed(): void {
  changes++
  for (const tell of tellers) tell()
}
function watch(fn: () => void): () => void {
  tellers.add(fn)
  return () => tellers.delete(fn)
}
/** A number that moves whenever anything here changes, for a component to be drawn again by. */
export const useMediaChanges = (): number => useSyncExternalStore(watch, () => changes)

// ---------- what the person allowed, on this screen ----------

/** What the person allowed one page on this screen. */
export interface Grant {
  /** The page's own id. */
  page: string
  title: string
  agent: string | null
  machine: string | null
  /** The conversation that had the page when it was allowed. A page another conversation has since taken is asked about again. */
  owner: string
  kinds: MediaKind[]
  at: number
  /**
   * When the page last used what it was allowed, which keeps the grant from lapsing (`MEDIA_GRANT`).
   * It is kept beside the grants and not in them (`usedAt`), and filled in here as they are read.
   */
  used?: number
  /**
   * This grant itself: made afresh each time the page is allowed after being taken back, and kept
   * when more is allowed beside it. What was begun under one grant is not the page's under another,
   * so a take that was finishing when the person took back what they had allowed stays discarded,
   * whatever they allow later. Kept in the browser with the grant, so every tab goes by it.
   */
  id: string
}
/**
 * Where it is kept: under the person's id, so that it goes when what is kept for them goes, and
 * this browser's display key, so that a pairing begun afresh begins with nothing allowed.
 */
const keptAt = (user: string) => `it.media.${user}.${displayKey()}`
/**
 * Where the moment a grant was last used is kept: a value of its own for each grant, beside the
 * grants and never in them. A page uses what it was allowed from its script, as often as it likes
 * and in any tab, and noting that must never write the grants: written from what one tab read a
 * moment before, they would put back what the person took back in another tab meanwhile.
 */
const usedAt = (user: string, id: string) => `${keptAt(user)}.used.${id}`
const lastUse = (user: string, id: string): number => {
  try {
    const n = Number(localStorage.getItem(usedAt(user, id)))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
/** The conversation that has a page, as a grant is held to it: the machine, the agent app and the conversation's id. */
export const ownerOf = (page: { machineId?: string | null; session?: { harness: string; id: string } | null }): string =>
  [page.machineId ?? '', page.session?.harness ?? '', page.session?.id ?? ''].join('|')

const isGrant = (g: unknown): g is Grant => {
  const x = g as Grant | null
  return (
    !!x &&
    typeof x.page === 'string' &&
    typeof x.title === 'string' &&
    typeof x.owner === 'string' &&
    typeof x.at === 'number' &&
    (x.used === undefined || typeof x.used === 'number') &&
    typeof x.id === 'string' &&
    Array.isArray(x.kinds) &&
    x.kinds.every((k) => k === 'mic' || k === 'camera')
  )
}
/** When a grant lapses unless the page uses it before then. */
export const endsAt = (g: Grant): number => Math.max(g.at, g.used ?? 0) + MEDIA_GRANT.unusedMs
/** The pages allowed the microphone or the camera on this screen, the latest first. One that went unused for too long is no longer allowed, and is not listed. */
export function grantsOf(user: string): Grant[] {
  try {
    const kept = JSON.parse(localStorage.getItem(keptAt(user)) ?? '[]') as unknown
    const now = Date.now()
    return Array.isArray(kept)
      ? kept
          .filter(isGrant)
          .map((g) => ({ ...g, used: Math.max(g.used ?? 0, lastUse(user, g.id)) || undefined }))
          .filter((g) => endsAt(g) > now)
          .sort((a, b) => b.at - a.at)
      : []
  } catch {
    return []
  }
}
/**
 * Notes that a page used what it was allowed, so that the grant runs on from now. Only the moment
 * is written, under the grant's own id: the grants themselves are left as they are, and a grant
 * taken back meanwhile stays taken back, its moment going unread.
 */
export function usedNow(user: string, page: string): void {
  const g = grantsOf(user).find((x) => x.page === page)
  if (!g) return
  try {
    localStorage.setItem(usedAt(user, g.id), String(Date.now()))
  } catch {}
  changed()
}
function keep(user: string, grants: Grant[]): void {
  try {
    if (grants.length) localStorage.setItem(keptAt(user), JSON.stringify(grants.map(({ used: _, ...g }) => g)))
    else localStorage.removeItem(keptAt(user))
    // The moments of grants that are gone are let go. A grant's id is never made again, so one of
    // those is never read again either; what is kept now is read afresh, since another tab may
    // have written grants since this one read them
    const prefix = `${keptAt(user)}.used.`
    const kept = new Set(
      (() => {
        const raw = JSON.parse(localStorage.getItem(keptAt(user)) ?? '[]') as unknown
        return Array.isArray(raw) ? raw.filter(isGrant).map((g) => g.id) : []
      })(),
    )
    const gone: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(prefix) && !kept.has(name.slice(prefix.length))) gone.push(name)
    }
    for (const name of gone) localStorage.removeItem(name)
  } catch {}
  changed()
  closeWhatIsTakenBack()
}
/** A camera open for a photo, and a camera or a microphone live to a page, that the person no longer allows closes at once. */
function closeWhatIsTakenBack(): void {
  // By the grant each was begun under, and not by whether some grant allows the page now: another
  // tab can take it back and allow it again before this one hears of either
  if (shooting && grantFor(shooting.user, shooting.page, shooting.owner, ['camera']) !== shooting.grant) shooting.close()
  for (const c of [...cameras]) if (grantFor(c.user, c.page, c.owner, c.kinds) !== c.grant) c.end('taken_back')
  for (const m of [...microphones]) if (grantFor(m.user, m.page, m.owner, ['mic']) !== m.grant) m.end('taken_back')
}
/** Whether the person allowed this page, as this conversation has it, every one of these on this screen. */
export function allowed(user: string, page: string, owner: string, kinds: MediaKind[]): boolean {
  return grantFor(user, page, owner, kinds) !== null
}
/** Which grant allows the page these, as this conversation has it, or nothing where none does. */
export function grantFor(user: string, page: string, owner: string, kinds: MediaKind[]): string | null {
  const g = grantsOf(user).find((x) => x.page === page)
  return g && g.owner === owner && kinds.every((k) => g.kinds.includes(k)) ? g.id : null
}
/** Notes that the person allowed a page these, beside what they allowed it before as the same conversation's. */
export function allow(user: string, grant: Omit<Grant, 'at' | 'id'>): void {
  const before = grantsOf(user)
  const was = before.find((x) => x.page === grant.page && x.owner === grant.owner)
  const kinds = (['mic', 'camera'] as const).filter((k) => grant.kinds.includes(k) || was?.kinds.includes(k))
  const id = was?.id ?? Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  keep(user, [{ ...grant, kinds, at: Date.now(), id }, ...before.filter((x) => x.page !== grant.page)])
}
/** Takes back what a page was allowed on this screen, and closes what it has open. */
export function takeBack(user: string, page: string): void {
  keep(
    user,
    grantsOf(user).filter((x) => x.page !== page),
  )
}
/** Takes back everything this screen allowed, and closes what is open: the browser is signing out, and what it allowed ends with its pairing. */
export function forgetGrants(user: string): void {
  keep(user, [])
  shooting?.close()
  for (const c of [...cameras]) c.end('taken_back')
  for (const m of [...microphones]) m.end('taken_back')
}
// Another tab of this browser allowed something or took it back: this one goes by that too
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith('it.media.')) return
    changed()
    closeWhatIsTakenBack()
  })

/** The kinds, as a person says them. */
export const kindsSaid = (kinds: MediaKind[]): string =>
  kinds.includes('mic') && kinds.includes('camera') ? 'the microphone and the camera' : kinds.includes('camera') ? 'the camera' : 'the microphone'

// ---------- asking the person ----------

/** A page that wants something the person has not allowed it on this screen, waiting for their answer. */
export interface Asking {
  page: string
  title: string
  agent: string | null
  machine: string | null
  kinds: MediaKind[]
  answer: (yes: boolean) => void
}
let asking: Asking | null = null
/** The one question the site is asking the person now, if it is asking one. */
export const useAsking = (): Asking | null => useSyncExternalStore(watch, () => asking)
/** The same, read once, outside a view. */
export const currentQuestion = (): Asking | null => asking
/**
 * Asks the person whether a page may use these on this screen. One question at a time: a page
 * that asks while another question is open is answered no. `cancel` takes the question away
 * unanswered, as when the page is closed.
 */
/**
 * Which of these the browser will ask the person about itself, once for It's site, when they are
 * first used: after It's own question, It's bar says which page the browser's question is for,
 * while it is asked. Where the browser cannot say, nothing is claimed.
 */
export async function browserWillAsk(kinds: MediaKind[]): Promise<MediaKind[]> {
  const asks: MediaKind[] = []
  for (const kind of kinds) {
    try {
      const state = await navigator.permissions.query({ name: (kind === 'mic' ? 'microphone' : 'camera') as PermissionName })
      if (state.state === 'prompt') asks.push(kind)
    } catch {}
  }
  return asks
}
/** A page the browser itself is asking about, so that It's bar can say which page the browser's question is for. It is not a question of It's own, and has nothing to answer. */
export interface BrowserAsking {
  page: string
  title: string
  kinds: MediaKind[]
}
let browserAsking: BrowserAsking | null = null
/** The page the browser is asking about now, if it is asking. */
export const useBrowserAsking = (): BrowserAsking | null => useSyncExternalStore(watch, () => browserAsking)
/** The same, read once, outside a view. */
export const browserAskingNow = (): BrowserAsking | null => browserAsking
/** Says in It's bar that the browser is asking about a page, until what is given back is called. */
export function whileTheBrowserAsks(about: BrowserAsking): () => void {
  browserAsking = about
  changed()
  return () => {
    if (browserAsking !== about) return
    browserAsking = null
    changed()
  }
}
export function askPerson(about: Omit<Asking, 'answer'>): { answer: Promise<boolean>; cancel: () => void } {
  if (asking) return { answer: Promise.resolve(false), cancel: () => {} }
  let answered: (yes: boolean) => void = () => {}
  const answer = new Promise<boolean>((resolve) => {
    answered = resolve
  })
  const mine: Asking = {
    ...about,
    answer: (yes) => {
      if (asking !== mine) return
      asking = null
      changed()
      answered(yes)
    },
  }
  asking = mine
  changed()
  return { answer, cancel: () => mine.answer(false) }
}

// ---------- what is open now ----------

/**
 * Why a camera or a microphone live to a page ended without the page asking, in the words the
 * page is told (protocol's `it:camera-state`). `taken_over`: another conversation took the page
 * over, and the person allowed the one that had it.
 */
export type Why = 'person' | 'taken_back' | 'not_shown' | 'device' | 'taken_over'

/**
 * Why this browser cannot open the microphone or the camera for any page, in words for the page
 * and the person, or nothing where it can. A browser gives the microphone and the camera only to
 * a site it counts as secure: this machine by its own name, or an https address.
 */
export function cannotOpen(): string | null {
  if (typeof window === 'undefined' || !window.isSecureContext)
    return 'This screen reaches It over plain http, and a browser gives the microphone and the camera only to an https address or to the machine itself. Open It at its https address on your tailnet: `it https on`, on the machine It runs on, says how.'
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser gives a site no microphone or camera.'
  return null
}

// ---------- what a page may ask of the device ----------

const SWITCHES: Record<'audio' | 'video', string[]> = { audio: ['echoCancellation', 'noiseSuppression', 'autoGainControl'], video: [] }
const SIZES: Record<'audio' | 'video', string[]> = { audio: [], video: ['width', 'height', 'frameRate', 'aspectRatio'] }
/** One of the two, as the browser is to be asked for it. A page may say plain switches and sizes, and for the camera which way it faces: nothing that names a device. */
function asked(given: unknown, kind: 'audio' | 'video', by: string): boolean | MediaTrackConstraints {
  if (given === undefined || given === null || given === false) return false
  if (given === true) return true
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error(`${kind} is true, false, or an object of plain settings.`)
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    if (SWITCHES[kind].includes(name) && typeof value === 'boolean') out[name] = value
    else if (SIZES[kind].includes(name) && typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10_000) out[name] = value
    else if (kind === 'video' && name === 'facingMode' && (value === 'user' || value === 'environment')) out[name] = value
    else throw new Error(`${by} does not take ${kind}.${name.slice(0, 40)} as it was given.`)
  }
  return out
}
/** What a page asked of the camera it sees live, held to what the site takes: plain sizes and which way it faces. */
export function cameraVideoOf(given: unknown): true | MediaTrackConstraints {
  if (given === undefined || given === null) return true
  const video = asked(given, 'video', 'It.camera')
  if (video === false) throw new Error('It.camera needs the camera.')
  if (video === true) return true
  // Asked for no more than is sent
  const most: Record<string, number> = { width: LIVE_CAMERA.longestSide, height: LIVE_CAMERA.longestSide, frameRate: LIVE_CAMERA.perSecond }
  return Object.fromEntries(
    Object.entries(video).map(([name, value]) => [name, typeof value === 'number' && name in most ? Math.min(value, most[name]!) : value]),
  )
}
/** What a page asked of the microphone it hears live, held to what the site takes: plain switches. */
export function microphoneAudioOf(given: unknown, by = 'It.microphone'): true | MediaTrackConstraints {
  if (given === undefined || given === null) return true
  const audio = asked(given, 'audio', by)
  if (audio === false) throw new Error(`${by} needs the microphone.`)
  return audio
}

// A camera open for a photo is closed while the screen does not show It, whose bar is where it is seen
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') shooting?.close()
  })

// ---------- a photo ----------

/** A photo being taken: It's own view of the camera, for one page, until the person takes it or closes it. */
export interface Shooting {
  page: string
  title: string
  /** The person, the conversation the page had, and the grant the photo is allowed under: taken back, the camera closes. */
  user: string
  owner: string
  grant: string
  stream: MediaStream
  /** Takes the photo, as the view shows it now. */
  take: (view: HTMLVideoElement) => void
  close: () => void
}
let shooting: Shooting | null = null
/** The photo being taken now, if one is. */
export const useShooting = (): Shooting | null => useSyncExternalStore(watch, () => shooting)
/** The same, read once, outside a view. */
export const shootingNow = (): Shooting | null => shooting
/**
 * Shows the person It's own view of the camera, for a page the person allowed it on this screen,
 * and gives the photo they take there as a JPEG, or nothing where they close it. One at a time,
 * and only while no camera is live to a page. `cancel` closes the view, as when the page is closed.
 */
export async function shoot(
  page: { page: string; title: string; user: string; owner: string; grant: string },
  facing: 'user' | 'environment' | undefined,
): Promise<{ photo: Promise<Blob | null>; cancel: () => void }> {
  if (shooting || cameras.length) throw new Error('The camera is in use on this screen just now.')
  const stream = await navigator.mediaDevices.getUserMedia({ video: facing ? { facingMode: facing } : true, audio: false })
  let given: (photo: Blob | null) => void = () => {}
  const photo = new Promise<Blob | null>((resolve) => {
    given = resolve
  })
  const close = (made: Blob | null) => {
    if (shooting !== mine) return
    shooting = null
    changed()
    for (const t of stream.getTracks()) t.stop()
    given(made)
  }
  const mine: Shooting = {
    ...page,
    stream,
    take: (view) => {
      const width = view.videoWidth
      const height = view.videoHeight
      if (!width || !height) return
      const canvas = Object.assign(document.createElement('canvas'), { width, height })
      canvas.getContext('2d')?.drawImage(view, 0, 0, width, height)
      canvas.toBlob((made) => close(made), 'image/jpeg', 0.92)
    },
    close: () => close(null),
  }
  shooting = mine
  changed()
  for (const t of stream.getTracks()) t.addEventListener('ended', () => close(null), { once: true })
  return { photo, cancel: () => close(null) }
}

// ---------- the camera, live to a page ----------
//
// No browser hands a sandboxed document the camera's track, or a frame of video, from the site:
// each is refused, or never arrives. A picture does. So the site opens the camera and sends the
// page each picture it gives, as an ImageBitmap, and the page draws them onto a canvas of its own
// and makes its stream from that, for a video element or a call it makes itself. The site sends
// a few at a time and no more, and the next only once the page says it has drawn one, so that a
// page that is slow to draw is given fewer pictures rather than more and more of them waiting.
// Opened with sound, the microphone is opened with it, and its sound goes to the page as a live
// microphone's does, under the camera's own name.

/** The camera live to a page, as It's bar shows it. */
export interface LiveCamera {
  id: string
  user: string
  page: string
  owner: string
  /** What it has open: the camera, and the microphone too where it was opened with sound. */
  kinds: MediaKind[]
  /** The grant it was opened under (`grantFor`): taken back, by this tab or another, it ends, whatever is allowed since. */
  grant: string
  title: string
  since: number
  state: 'live' | 'paused'
  /** Ends it without the page asking, and tells the page why. */
  end: (why: Why) => void
}
let cameras: LiveCamera[] = []
/** The cameras live to a page on this screen. */
export const useCameras = (): LiveCamera[] => useSyncExternalStore(watch, () => cameras)
/** A page's live camera, if it has one. */
export const cameraFor = (page: string): LiveCamera | undefined => cameras.find((c) => c.page === page)
/** Each live camera's and microphone's own word for whether the screen shows the site, by its id. */
const shown = new Map<string, (hidden: boolean) => void>()
// While the screen does not show the site the camera and the microphone wait, and the page is given nothing
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    for (const show of [...shown.values()]) show(document.visibilityState === 'hidden')
  })

/**
 * What the site holds the live camera to, whatever the page asks of it. `atOnce`: how many
 * pictures a page may have been sent and not yet said it drew, one being drawn and the next on its
 * way. `perSecond` and `longestSide`: no more pictures than that in any second, and none larger
 * than that many pixels on its longer side, since what a page asks of the camera is only what the
 * browser is asked for. `checkEveryMs`: how often it is asked whether the page may still have the
 * camera, whether or not a picture is sent. `usedEveryMs`: how often an open camera notes that the
 * page uses what it was allowed, so that it does not lapse while it is open.
 */
export const LIVE_CAMERA = { atOnce: 2, perSecond: 30, longestSide: 1920, checkEveryMs: 1000, usedEveryMs: 60 * 60_000 } as const

/** What the live camera is for: the page, as the person was asked about it, and who is given its pictures and told of it. */
export interface CameraFor {
  /** The camera's own id, for It's bar. */
  id: string
  user: string
  page: string
  owner: string
  /** The grant the person allowed it under. */
  grant: string
  title: string
  /**
   * Why the page may not have the camera any more, or nothing where it may. Asked before each
   * picture is handed on, and every `checkEveryMs` while the camera is open, whatever the page has
   * drawn: a page that draws nothing is sent nothing, and would otherwise never be asked about.
   */
  still: () => Why | null
  /** One picture for the page, numbered in the order the camera gave it, which is handed on. */
  picture: (frame: number, picture: ImageBitmap) => void
  /** One piece of the microphone's sound for the page, where the camera is opened with sound. */
  sound: (chunk: number, sampleRate: number, samples: Float32Array) => void
  /** The camera paused, went on, or ended without the page asking. */
  told: (state: 'live' | 'paused' | 'ended', why?: Why) => void
}
/** The live camera, as the frame that opened it holds it. */
export interface Opened {
  id: string
  /** How many samples of its sound there are in a second, where it was opened with sound. */
  sampleRate?: number
  /** The page has drawn this picture: another may be sent in its place. */
  drawn: (frame: number) => void
  /** The page has taken every piece of sound up to this one: more may be sent in their place. */
  heard: (chunk: number) => void
  /** Closes it, as the page asked. */
  stop: () => void
  /** Closes it without the page asking, and tells the page why. */
  end: (why: Why) => void
}

/**
 * Opens the camera live, for a page that the person allowed it on this screen, and sends the
 * page its pictures until it is closed. With `audio` the microphone is opened with it, for a page
 * allowed both, and its sound is sent beside the pictures. Rejects with what the browser said
 * where it would not give the camera.
 */
export async function openCamera(video: true | MediaTrackConstraints, audio: false | true | MediaTrackConstraints, page: CameraFor): Promise<Opened> {
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio })
  // The camera's picture, in a video element that is never shown: what each picture is taken from
  const view = document.createElement('video')
  view.muted = true
  view.playsInline = true
  view.srcObject = stream
  let state: 'live' | 'paused' = 'live'
  let over = false
  /** The microphone's sound on its way to the page, where the camera was opened with sound. */
  let sound: Relay | null = null
  try {
    await view.play()
    if (audio)
      sound = await relaySound(stream, {
        still: () => (over ? 'not_shown' : page.still()),
        waiting: () => state === 'paused',
        sound: page.sound,
        end: (why) => end(why),
      })
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    view.srcObject = null
    throw err
  }
  // Gone while it was being opened, when nothing was listening for that yet: it is not opened
  if (wentAway(stream)) {
    sound?.close()
    for (const t of stream.getTracks()) t.stop()
    view.srcObject = null
    throw new Error(WENT_AWAY)
  }
  /** The pictures sent that the page has not said it drew, and how many are being made. */
  const sent = new Set<number>()
  let making = 0
  let frames = 0
  /** When each of the pictures begun in the last second was begun. */
  const begun: number[] = []
  let usedAt = Date.now()
  const close = (): boolean => {
    if (over) return false
    over = true
    clearInterval(watching)
    cameras = cameras.filter((c) => c.id !== page.id)
    shown.delete(page.id)
    sound?.close()
    for (const t of stream.getTracks()) t.stop()
    view.srcObject = null
    changed()
    return true
  }
  const end = (why: Why) => {
    if (close()) page.told('ended', why)
  }
  // Asked whether the page may still have it whatever is sent, paused or not; and while it may, an
  // open camera is the page using what it was allowed, noted now and then and not for each picture
  const watching = setInterval(() => {
    const not = page.still()
    if (not) return end(not)
    if (Date.now() - usedAt < LIVE_CAMERA.usedEveryMs) return
    usedAt = Date.now()
    usedNow(page.user, page.page)
  }, LIVE_CAMERA.checkEveryMs)
  const show = (hidden: boolean) => {
    const now = hidden ? 'paused' : 'live'
    if (over || state === now) return
    state = now
    // A camera whose track gives nothing is one the browser lets go of, and says so to the person
    for (const t of stream.getTracks()) t.enabled = !hidden
    sound?.wait(hidden)
    cameras = cameras.map((c) => (c.id === page.id ? { ...c, state: now } : c))
    changed()
    page.told(now)
  }
  // Each new picture where the browser says when there is one, and otherwise each time the screen
  // is drawn, which is told by the time the video has reached
  const each = typeof view.requestVideoFrameCallback === 'function'
  let reached = -1
  const next = () => {
    if (each) view.requestVideoFrameCallback(picture)
    else requestAnimationFrame(picture)
  }
  /** A picture the camera gave: sent where the page has room for one, and passed over where it has none. */
  function picture() {
    if (over) return
    next()
    if (state === 'paused' || sent.size + making >= LIVE_CAMERA.atOnce || view.readyState < 2) return
    if (!each) {
      if (view.currentTime === reached) return
      reached = view.currentTime
    }
    // No more in any second than the most, however fast the camera gives them
    const now = performance.now()
    while (begun.length && now - begun[0]! >= 1000) begun.shift()
    if (begun.length >= LIVE_CAMERA.perSecond) return
    begun.push(now)
    // And none larger than the most on its longer side, made smaller as it is taken
    const width = view.videoWidth
    const height = view.videoHeight
    const scale = Math.min(1, LIVE_CAMERA.longestSide / Math.max(width, height, 1))
    making++
    ;(scale < 1
      ? createImageBitmap(view, { resizeWidth: Math.round(width * scale), resizeHeight: Math.round(height * scale), resizeQuality: 'medium' })
      : createImageBitmap(view)
    ).then(
      (made) => {
        making--
        // Closed, or the screen stopped showing the site, while it was made
        if (over || state === 'paused') return made.close()
        const not = page.still()
        if (not) {
          made.close()
          return end(not)
        }
        const frame = ++frames
        sent.add(frame)
        page.picture(frame, made)
      },
      () => {
        making--
      },
    )
  }
  // A camera that goes away, or that the person turns off from the browser's own controls, ends it
  for (const t of stream.getTracks()) t.addEventListener('ended', () => end('device'), { once: true })
  cameras = [
    ...cameras,
    {
      id: page.id,
      user: page.user,
      page: page.page,
      owner: page.owner,
      kinds: audio ? ['mic', 'camera'] : ['camera'],
      grant: page.grant,
      title: page.title,
      since: Date.now(),
      state,
      end,
    },
  ]
  shown.set(page.id, show)
  changed()
  // Opened while the screen does not show the site: it waits at once
  if (document.visibilityState === 'hidden') show(true)
  next()
  return {
    id: page.id,
    ...(sound ? { sampleRate: sound.sampleRate } : {}),
    drawn: (frame) => {
      sent.delete(frame)
    },
    heard: (chunk) => sound?.heard(chunk),
    stop: () => {
      close()
    },
    end,
  }
}

// ---------- the microphone, live to a page ----------
//
// No browser hands a sandboxed document the microphone's track from the site either. Its samples
// do arrive. So the site opens the microphone, gathers its sound into small pieces, of one
// channel, and sends the page each piece as it comes; the page plays the pieces one after
// another into a stream of its own, for a meter, for captions, to record, or for a call it makes
// itself. The site sends a few pieces at a time and no more, and more only once the page says it
// has taken them, so that a page that falls behind is given less sound and never a pile of it.

/**
 * What the site holds live sound to. `pieceMs`: how much sound goes in one piece. `mostSamples`:
 * the most samples one piece may hold, whatever the rate of the sound. `atOnce`: how many pieces a
 * page may have been sent and not yet said it took. `startMs`: how long the browser is given to
 * load what gathers the sound, and again to start passing it on. `checkEveryMs` and `usedEveryMs` are as the live camera's.
 */
export const LIVE_MICROPHONE = { pieceMs: 20, mostSamples: 4096, atOnce: 10, startMs: 2000, checkEveryMs: 1000, usedEveryMs: 60 * 60_000 } as const
/** Where the site keeps what gathers the microphone's sound into pieces: a file of its own, since the site runs no script that is not one of its files. */
const PIECES = '/sound-worklet.js'
const NO_SOUND = 'This browser cannot pass the microphone’s sound on to a page.'

/** What is waited for while the microphone's sound is made ready, for `startMs` at most: whoever waits goes on then, whether or not it is done. */
const soon = (doing: Promise<unknown>): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([doing, new Promise((resolve) => (timer = setTimeout(resolve, LIVE_MICROPHONE.startMs)))]).finally(() => clearTimeout(timer))
}
/** What a page is told where the device went away while it was being opened: unplugged, or turned off from the browser's own controls. */
const WENT_AWAY = 'The microphone or the camera went away while it was being opened.'
/** Whether a device of this stream has gone away, which nothing was listening for while it was being opened. */
const wentAway = (stream: MediaStream): boolean => stream.getTracks().some((t) => t.readyState === 'ended')
/** Sound on its way to a page, as whatever opened the microphone holds it. */
interface Relay {
  sampleRate: number
  /** The page has taken every piece up to this one. */
  heard: (chunk: number) => void
  /** Waits while the screen does not show the site, and goes on when it does. */
  wait: (hidden: boolean) => void
  close: () => void
}
/**
 * Passes the sound of a stream's microphone on, piece by piece, until it is closed. `still` is
 * asked before each piece is handed on, and where the page may not have it any more, `end` is
 * told why and the piece is not sent. Nothing is sent while `waiting`.
 */
async function relaySound(
  stream: MediaStream,
  to: { still: () => Why | null; waiting: () => boolean; sound: (chunk: number, sampleRate: number, samples: Float32Array) => void; end: (why: Why) => void },
): Promise<Relay> {
  const Context = window.AudioContext
  if (typeof Context !== 'function' || typeof AudioWorkletNode !== 'function') throw new Error(NO_SOUND)
  const context = new Context()
  let node: AudioWorkletNode
  let source: MediaStreamAudioSourceNode
  try {
    if (!context.audioWorklet) throw new Error(NO_SOUND)
    // What gathers the pieces is given a moment to load, and not waited on for ever: the microphone is open all the while, with nothing yet in It's bar to say so
    let loaded = false
    await soon(
      context.audioWorklet.addModule(PIECES).then(() => {
        loaded = true
      }),
    )
    if (!loaded) throw new Error(NO_SOUND)
    // A browser may hold sound back until the person has done something on the site. It is given a moment too
    await soon(context.resume())
    if (context.state !== 'running') throw new Error('The browser did not start the sound for It on this screen. Ask again from a click on the page.')
    const samples = Math.min(LIVE_MICROPHONE.mostSamples, Math.max(1, Math.round((context.sampleRate * LIVE_MICROPHONE.pieceMs) / 1000)))
    // One channel, mixed down where the microphone gives more
    node = new AudioWorkletNode(context, 'it-sound-pieces', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { samples },
    })
    source = context.createMediaStreamSource(stream)
    source.connect(node)
  } catch (err) {
    void context.close().catch(() => {})
    throw err instanceof Error && /^(This browser cannot|The browser did not start)/.test(err.message) ? err : new Error(NO_SOUND)
  }
  let closed = false
  /** The number of the last piece sent, and of the last the page said it took. */
  let sent = 0
  let taken = 0
  node.port.onmessage = (m: MessageEvent) => {
    const samples: unknown = m.data
    if (closed || to.waiting() || !(samples instanceof Float32Array) || samples.length === 0 || samples.length > LIVE_MICROPHONE.mostSamples) return
    // A page that has not taken what it was sent is sent no more, and this piece is passed over
    if (sent - taken >= LIVE_MICROPHONE.atOnce) return
    const not = to.still()
    if (not) return to.end(not)
    to.sound(++sent, context.sampleRate, samples)
  }
  return {
    sampleRate: context.sampleRate,
    heard: (chunk) => {
      // Of a piece that was never sent, it makes no room
      if (Number.isInteger(chunk) && chunk > taken && chunk <= sent) taken = chunk
    },
    wait: (hidden) => {
      void (hidden ? context.suspend() : context.resume()).catch(() => {})
    },
    close: () => {
      if (closed) return
      closed = true
      node.port.onmessage = null
      try {
        source.disconnect()
      } catch {}
      void context.close().catch(() => {})
    },
  }
}

/** The microphone live to a page, as It's bar shows it. */
export interface LiveMicrophone {
  id: string
  user: string
  page: string
  owner: string
  /** The grant it was opened under (`grantFor`): taken back, by this tab or another, it ends, whatever is allowed since. */
  grant: string
  title: string
  since: number
  state: 'live' | 'paused'
  /** Ends it without the page asking, and tells the page why. */
  end: (why: Why) => void
}
let microphones: LiveMicrophone[] = []
/** The microphones live to a page on this screen. */
export const useMicrophones = (): LiveMicrophone[] => useSyncExternalStore(watch, () => microphones)
/** A page's live microphone, if it has one. */
export const microphoneFor = (page: string): LiveMicrophone | undefined => microphones.find((m) => m.page === page)

/** What the live microphone is for: the page, as the person was asked about it, and who is given its sound and told of it. */
export interface MicrophoneFor {
  /** The microphone's own id, for It's bar. */
  id: string
  user: string
  page: string
  owner: string
  /** The grant the person allowed it under. */
  grant: string
  title: string
  /**
   * Why the page may not have the microphone any more, or nothing where it may. Asked before each
   * piece of sound is handed on, and every `checkEveryMs` while the microphone is open, whatever
   * the page has taken: a page that takes nothing is sent nothing, and would otherwise never be
   * asked about.
   */
  still: () => Why | null
  /** One piece of sound for the page, numbered in the order it was heard, which is handed on. */
  sound: (chunk: number, sampleRate: number, samples: Float32Array) => void
  /** The microphone paused, went on, or ended without the page asking. */
  told: (state: 'live' | 'paused' | 'ended', why?: Why) => void
}
/** The live microphone, as the frame that opened it holds it. */
export interface Hearing {
  id: string
  /** How many samples of its sound there are in a second. */
  sampleRate: number
  /** The page has taken every piece of sound up to this one: more may be sent in their place. */
  heard: (chunk: number) => void
  /** Closes it, as the page asked. */
  stop: () => void
  /** Closes it without the page asking, and tells the page why. */
  end: (why: Why) => void
}

/**
 * Opens the microphone live, for a page that the person allowed it on this screen, and sends the
 * page its sound until it is closed. Rejects with what the browser said where it would not give
 * the microphone, or with why its sound cannot be passed on.
 */
export async function openMicrophone(audio: true | MediaTrackConstraints, page: MicrophoneFor): Promise<Hearing> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
  let state: 'live' | 'paused' = 'live'
  let over = false
  let usedAt = Date.now()
  let sound: Relay
  const end = (why: Why) => {
    if (close()) page.told('ended', why)
  }
  try {
    sound = await relaySound(stream, {
      still: () => (over ? 'not_shown' : page.still()),
      waiting: () => state === 'paused',
      sound: page.sound,
      end: (why) => end(why),
    })
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    throw err
  }
  // Gone while its sound was being made ready, when nothing was listening for that yet: it is not opened
  if (wentAway(stream)) {
    sound.close()
    for (const t of stream.getTracks()) t.stop()
    throw new Error(WENT_AWAY)
  }
  function close(): boolean {
    if (over) return false
    over = true
    clearInterval(watching)
    microphones = microphones.filter((m) => m.id !== page.id)
    shown.delete(page.id)
    sound.close()
    for (const t of stream.getTracks()) t.stop()
    changed()
    return true
  }
  // Asked whether the page may still have it whatever is sent, paused or not; and while it may, an
  // open microphone is the page using what it was allowed, noted now and then and not for each piece
  const watching = setInterval(() => {
    const not = page.still()
    if (not) return end(not)
    if (Date.now() - usedAt < LIVE_MICROPHONE.usedEveryMs) return
    usedAt = Date.now()
    usedNow(page.user, page.page)
  }, LIVE_MICROPHONE.checkEveryMs)
  const show = (hidden: boolean) => {
    const now = hidden ? 'paused' : 'live'
    if (over || state === now) return
    state = now
    // A microphone whose track gives nothing is one the browser lets go of, and says so to the person
    for (const t of stream.getTracks()) t.enabled = !hidden
    sound.wait(hidden)
    microphones = microphones.map((m) => (m.id === page.id ? { ...m, state: now } : m))
    changed()
    page.told(now)
  }
  // A microphone that goes away, or that the person turns off from the browser's own controls, ends it
  for (const t of stream.getTracks()) t.addEventListener('ended', () => end('device'), { once: true })
  microphones = [
    ...microphones,
    { id: page.id, user: page.user, page: page.page, owner: page.owner, grant: page.grant, title: page.title, since: Date.now(), state, end },
  ]
  shown.set(page.id, show)
  changed()
  // Opened while the screen does not show the site: it waits at once
  if (document.visibilityState === 'hidden') show(true)
  return {
    id: page.id,
    sampleRate: sound.sampleRate,
    heard: sound.heard,
    stop: () => {
      close()
    },
    end,
  }
}
