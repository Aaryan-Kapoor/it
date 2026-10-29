// The microphone and the camera, for a page that asked for them when it was published.
//
// No browser gives either to a page. A page is a sandboxed document with no origin of its own
// (mount.tsx), and a browser gives the microphone and the camera only to an origin it can ask the
// person about. So the site records, under its own origin, for a page that asks it to, and hands
// the page what was recorded as a file. The page sends that where it sends anything: to its
// agent with an action, which It keeps as it keeps any file an action carries.
//
// The browser asks the person once whether the site may use the microphone, and that would then
// be for every page there is. So the site asks first, in words of its own, for each page on each
// screen: which page, which agent made it, and what it would use. What the person allows is kept
// in this browser, for this pairing, for that page as the conversation that has it now has it: a
// page taken over by another conversation is asked about again. It is taken back in the page's
// bar or under Settings. While the site records, It's bar says so and can stop it; while the
// screen does not show the site, the recording waits, and nothing is recorded.

import { type MediaKind, mediaFor, RECORDING } from '@it/protocol'
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
}
/**
 * Where it is kept: under the person's id, so that it goes when what is kept for them goes, and
 * this browser's display key, so that a pairing begun afresh begins with nothing allowed.
 */
const keptAt = (user: string) => `it.media.${user}.${displayKey()}`
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
    Array.isArray(x.kinds) &&
    x.kinds.every((k) => k === 'mic' || k === 'camera')
  )
}
/** The pages allowed the microphone or the camera on this screen, the latest first. */
export function grantsOf(user: string): Grant[] {
  try {
    const kept = JSON.parse(localStorage.getItem(keptAt(user)) ?? '[]') as unknown
    return Array.isArray(kept) ? kept.filter(isGrant).sort((a, b) => b.at - a.at) : []
  } catch {
    return []
  }
}
function keep(user: string, grants: Grant[]): void {
  try {
    if (grants.length) localStorage.setItem(keptAt(user), JSON.stringify(grants))
    else localStorage.removeItem(keptAt(user))
  } catch {}
  changed()
  // What is recording and is no longer allowed stops at once
  for (const l of [...live]) if (!allowed(user, l.page, l.owner, l.kinds)) l.end('taken_back')
}
/** Whether the person allowed this page, as this conversation has it, every one of these on this screen. */
export function allowed(user: string, page: string, owner: string, kinds: MediaKind[]): boolean {
  const g = grantsOf(user).find((x) => x.page === page)
  return !!g && g.owner === owner && kinds.every((k) => g.kinds.includes(k))
}
/** Notes that the person allowed a page these, beside what they allowed it before as the same conversation's. */
export function allow(user: string, grant: Omit<Grant, 'at'>): void {
  const before = grantsOf(user)
  const was = before.find((x) => x.page === grant.page && x.owner === grant.owner)
  const kinds = (['mic', 'camera'] as const).filter((k) => grant.kinds.includes(k) || was?.kinds.includes(k))
  keep(user, [{ ...grant, kinds, at: Date.now() }, ...before.filter((x) => x.page !== grant.page)])
}
/** Takes back what a page was allowed on this screen, and stops what it is recording. */
export function takeBack(user: string, page: string): void {
  keep(
    user,
    grantsOf(user).filter((x) => x.page !== page),
  )
}
// Another tab of this browser allowed something or took it back: this one goes by that too
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith('it.media.')) return
    changed()
    for (const l of [...live]) if (!allowed(l.user, l.page, l.owner, l.kinds)) l.end('taken_back')
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
/**
 * Asks the person whether a page may use these on this screen. One question at a time: a page
 * that asks while another question is open is answered no. `cancel` takes the question away
 * unanswered, as when the page is closed.
 */
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

// ---------- what is recording now ----------

/** Why a recording ended without the page asking, in the words the page is told (protocol's `it:recording`). */
export type Why = 'person' | 'taken_back' | 'not_shown' | 'device' | 'too_long'
/** A recording under way, as It's bar shows it. */
export interface Live {
  id: string
  user: string
  page: string
  owner: string
  title: string
  kinds: MediaKind[]
  since: number
  state: 'recording' | 'paused'
  /** What the camera shows, for It's own view of it while it records. */
  stream: MediaStream
  /** Ends it without the page asking. What was recorded is the page's only where it ran out of time or the device stopped. */
  end: (why: Why) => void
}
let live: Live[] = []
/** The recordings under way on this screen. */
export const useLive = (): Live[] => useSyncExternalStore(watch, () => live)
/** A page's recording under way, if it has one. */
export const liveFor = (page: string): Live | undefined => live.find((l) => l.page === page)

/**
 * Why this browser cannot record for any page, in words for the page and the person, or nothing
 * where it can. A browser gives the microphone and the camera only to a site it counts as secure:
 * this machine by its own name, or an https address.
 */
export function cannotRecord(): string | null {
  if (typeof window === 'undefined' || !window.isSecureContext)
    return 'This screen reaches It over plain http, and a browser gives the microphone and the camera only to an https address or to the machine itself. Open It at its https address on your tailnet: `it https on`, on the machine It runs on, says how.'
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'This browser cannot record.'
  return null
}

// ---------- what a page may ask of the device ----------

/** What a page asked to record, held to what the site takes: plain switches and sizes, and nothing that names a device. */
export interface Spec {
  audio: boolean | MediaTrackConstraints
  video: boolean | MediaTrackConstraints
  audioBitsPerSecond: number
  videoBitsPerSecond: number
  mimeType?: string
}
const SWITCHES: Record<'audio' | 'video', string[]> = { audio: ['echoCancellation', 'noiseSuppression', 'autoGainControl'], video: [] }
const SIZES: Record<'audio' | 'video', string[]> = {
  audio: ['channelCount', 'sampleRate', 'sampleSize'],
  video: ['width', 'height', 'frameRate', 'aspectRatio'],
}
/** One of the two, as the browser is to be asked for it. A page may say plain switches and sizes, and for the camera which way it faces. */
function asked(given: unknown, kind: 'audio' | 'video'): boolean | MediaTrackConstraints {
  if (given === undefined || given === null || given === false) return false
  if (given === true) return true
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error(`${kind} is true, false, or an object of plain settings.`)
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    if (SWITCHES[kind].includes(name) && typeof value === 'boolean') out[name] = value
    else if (SIZES[kind].includes(name) && typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10_000) out[name] = value
    else if (kind === 'video' && name === 'facingMode' && (value === 'user' || value === 'environment')) out[name] = value
    else throw new Error(`It.record does not take ${kind}.${name.slice(0, 40)} as it was given.`)
  }
  return out
}
const within = (given: unknown, bounds: { least: number; most: number; given: number }): number =>
  typeof given === 'number' && Number.isFinite(given) ? Math.min(bounds.most, Math.max(bounds.least, Math.round(given))) : bounds.given
/** What a page asked to record, as the site takes it, or an error that says what it cannot take. */
export function specOf(message: { audio: unknown; video: unknown; audioBitsPerSecond?: unknown; videoBitsPerSecond?: unknown; mimeType?: unknown }): Spec {
  const audio = asked(message.audio, 'audio')
  const video = asked(message.video, 'video')
  if (!audio && !video) throw new Error('It.record needs audio, video or both.')
  const mime = typeof message.mimeType === 'string' && message.mimeType.length <= 100 ? message.mimeType : undefined
  return {
    audio,
    video,
    audioBitsPerSecond: within(message.audioBitsPerSecond, RECORDING.audioBits),
    videoBitsPerSecond: within(message.videoBitsPerSecond, RECORDING.videoBits),
    ...(mime ? { mimeType: mime } : {}),
  }
}
/** The kinds a recording uses. */
export const kindsOf = (spec: { audio: unknown; video: unknown }): MediaKind[] => mediaFor({ audio: !!spec.audio, video: !!spec.video })

/** The kind of file to record into: the page's choice where the browser makes it, and otherwise the first of these that it does. */
function fileKind(spec: Spec): string {
  const supported = (type: string) => {
    try {
      return MediaRecorder.isTypeSupported(type)
    } catch {
      return false
    }
  }
  if (spec.mimeType && supported(spec.mimeType)) return spec.mimeType
  const choices = spec.video
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return choices.find(supported) ?? ''
}

// ---------- recording ----------

/** A recording that has begun, as the frame that asked for it holds it. */
export interface Begun {
  id: string
  mimeType: string
  /** Stops it. With `keep`, what was recorded; without, nothing, and it is thrown away. */
  stop: (keep: boolean) => Promise<Blob | undefined>
}
/** What a recording is for: the page, as the person was asked about it, and who is told when it pauses, goes on or ends by itself. */
export interface For {
  /** The recording's own id, which the page is told it by. */
  id: string
  user: string
  page: string
  owner: string
  title: string
  /** The recording paused, went on, or ended without the page asking, with what was recorded where that is the page's to have. */
  told: (state: 'recording' | 'paused' | 'ended', why?: Why, file?: Blob) => void
}

/** Begins recording, for a page that the person allowed on this screen. Rejects with what the browser said where it would not. */
export async function begin(spec: Spec, page: For): Promise<Begun> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: spec.audio, video: spec.video })
  const mimeType = fileKind(spec)
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      ...(spec.audio ? { audioBitsPerSecond: spec.audioBitsPerSecond } : {}),
      ...(spec.video ? { videoBitsPerSecond: spec.videoBitsPerSecond } : {}),
    })
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    throw err
  }
  const pieces: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) pieces.push(e.data)
  }
  const id = page.id
  recorders.set(id, { recorder, told: page.told })
  let over = false
  /** Ends it, and gives what was recorded where it is kept. */
  const finish = (keep: boolean): Promise<Blob | undefined> => {
    if (over) return Promise.resolve(undefined)
    over = true
    clearTimeout(longest)
    recorders.delete(id)
    live = live.filter((l) => l.id !== id)
    changed()
    return new Promise((resolve) => {
      const done = () => {
        for (const t of stream.getTracks()) t.stop()
        resolve(keep && pieces.length ? new Blob(pieces, { type: recorder.mimeType || mimeType || pieces[0]!.type }) : undefined)
      }
      if (recorder.state === 'inactive') return done()
      recorder.onstop = done
      recorder.onerror = done
      try {
        recorder.stop()
      } catch {
        done()
      }
    })
  }
  /** Ends it without the page asking, and tells the page why, with what was recorded where that is the page's to have. */
  const end = (why: Why) => {
    const keep = why === 'device' || why === 'too_long'
    void finish(keep).then((file) => page.told('ended', why, file))
  }
  const longest = setTimeout(() => end('too_long'), RECORDING.longestMs)
  // A device that goes away, or that the person turns off from the browser's own controls, ends it
  for (const t of stream.getTracks()) t.addEventListener('ended', () => end('device'), { once: true })
  recorder.start(1000)
  live = [
    ...live,
    {
      id,
      user: page.user,
      page: page.page,
      owner: page.owner,
      title: page.title,
      kinds: kindsOf(spec),
      since: Date.now(),
      state: 'recording',
      stream,
      end,
    },
  ]
  changed()
  // Begun while the screen does not show the site: it waits at once
  if (document.visibilityState === 'hidden') pauseAll()
  return { id, mimeType: recorder.mimeType || mimeType, stop: finish }
}

/** Each recording's recorder, and who is told of it, by its id: what pausing and going on need beside what the bar shows. */
const recorders = new Map<string, { recorder: MediaRecorder; told: For['told'] }>()

/** Every recording under way waits while the screen does not show the site, and goes on when it does again. */
function pauseAll(): void {
  live = live.map((l) => {
    const r = recorders.get(l.id)
    if (l.state === 'paused' || !r) return l
    for (const t of l.stream.getTracks()) t.enabled = false
    try {
      if (r.recorder.state === 'recording') r.recorder.pause()
    } catch {}
    r.told('paused')
    return { ...l, state: 'paused' as const }
  })
  changed()
}
function resumeAll(): void {
  live = live.map((l) => {
    const r = recorders.get(l.id)
    if (l.state === 'recording' || !r) return l
    for (const t of l.stream.getTracks()) t.enabled = true
    try {
      if (r.recorder.state === 'paused') r.recorder.resume()
    } catch {}
    r.told('recording')
    return { ...l, state: 'recording' as const }
  })
  changed()
}
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (!live.length) return
    if (document.visibilityState === 'hidden') pauseAll()
    else resumeAll()
  })

// ---------- a photo ----------

/** A photo being taken: It's own view of the camera, for one page, until the person takes it or closes it. */
export interface Shooting {
  page: string
  title: string
  stream: MediaStream
  /** Takes the photo, as the view shows it now. */
  take: (view: HTMLVideoElement) => void
  close: () => void
}
let shooting: Shooting | null = null
/** The photo being taken now, if one is. */
export const useShooting = (): Shooting | null => useSyncExternalStore(watch, () => shooting)
/**
 * Shows the person It's own view of the camera, for a page the person allowed it on this screen,
 * and gives the photo they take there as a JPEG, or nothing where they close it. One at a time,
 * and only while nothing records. `cancel` closes the view, as when the page is closed.
 */
export async function shoot(
  page: { page: string; title: string },
  facing: 'user' | 'environment' | undefined,
): Promise<{ photo: Promise<Blob | null>; cancel: () => void }> {
  if (shooting || live.length) throw new Error('The camera is in use on this screen just now.')
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
