// The microphone and the camera, for a page that calls for them.
//
// No browser gives either to a page. A page is a sandboxed document with no origin of its own
// (mount.tsx), and a browser gives the microphone and the camera only to an origin it can ask the
// person about. So the site records, under its own origin, for a page that asks it to, and hands
// the page what was recorded as a file. The page sends that where it sends anything: to its
// agent with an action, which It keeps as it keeps any file an action carries. A page that wants
// the camera live is sent its pictures as they come, and makes its own stream of them.
//
// The browser asks the person once whether the site may use the microphone, and that would then
// be for every page there is. So the site asks first, in words of its own, for each page on each
// screen: which page, which agent made it, and what it would use. What the person allows is kept
// in this browser, for this pairing, for that page as the conversation that has it now has it: a
// page taken over by another conversation is asked about again. It is taken back in the page's
// bar or under Settings. While the site records, It's bar says so and can stop it; while the
// screen does not show the site, the recording waits, and nothing is recorded.

import { MEDIA_GRANT, type MediaKind, mediaFor, RECORDING } from '@it/protocol'
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
/** What records, and a camera open for a photo, that the person no longer allows stops at once. */
function closeWhatIsTakenBack(): void {
  // By the grant each was begun under, and not by whether some grant allows the page now: another
  // tab can take it back and allow it again before this one hears of either
  for (const l of [...live]) if (grantFor(l.user, l.page, l.owner, l.kinds) !== l.grant) l.end('taken_back')
  if (shooting && grantFor(shooting.user, shooting.page, shooting.owner, ['camera']) !== shooting.grant) shooting.close()
  for (const c of [...cameras]) if (grantFor(c.user, c.page, c.owner, ['camera']) !== c.grant) c.end('taken_back')
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
/** Takes back what a page was allowed on this screen, and stops what it is recording. */
export function takeBack(user: string, page: string): void {
  keep(
    user,
    grantsOf(user).filter((x) => x.page !== page),
  )
}
/** Takes back everything this screen allowed, and stops what records: the browser is signing out, and what it allowed ends with its pairing. */
export function forgetGrants(user: string): void {
  keep(user, [])
  for (const l of [...live]) l.end('taken_back')
  shooting?.close()
  for (const c of [...cameras]) c.end('taken_back')
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

// ---------- what is recording now ----------

/**
 * Why a recording ended without the page asking, in the words the page is told (protocol's
 * `it:recording`). `taken_over`: another conversation took the page over, and the person allowed
 * the one that had it. `too_large`: it reached the most a file an action carries may be.
 */
export type Why = 'person' | 'taken_back' | 'not_shown' | 'device' | 'too_long' | 'taken_over' | 'too_large'
/** A recording under way, as It's bar shows it. */
export interface Live {
  id: string
  user: string
  page: string
  owner: string
  /** The grant it was begun under (`grantFor`): taken back, by this tab or another, it ends, whatever is allowed since. */
  grant: string
  title: string
  kinds: MediaKind[]
  since: number
  state: 'recording' | 'paused'
  /** What the camera shows, for It's own view of it while it records. */
  stream: MediaStream
  /** Ends it without the page asking. What was recorded is the page's only where it ran out of time or room, or the device stopped. */
  end: (why: Why) => void
}
let live: Live[] = []
/**
 * What the person is to be told on a page's row of its last recording, which stopped by itself at
 * the most a file may be: `kept`, what was recorded went to the page; `lost`, nothing of it could
 * be kept, as when the recorder gave more than the most in one piece.
 */
const notes = new Map<string, 'kept' | 'lost'>()
/** What the recording row says of a page's last recording, after it ended by itself, until the person dismisses it or the page records again. */
export const noteFor = (page: string): 'kept' | 'lost' | undefined => notes.get(page)
export function dismissNote(page: string): void {
  if (notes.delete(page)) changed()
}
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
function asked(given: unknown, kind: 'audio' | 'video', by = 'It.record'): boolean | MediaTrackConstraints {
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
  /** Ends it without the page asking, and tells the page why, as It's bar does when the person stops it. */
  end: (why: Why) => void
}
/** What a recording is for: the page, as the person was asked about it, and who is told when it pauses, goes on or ends by itself. */
export interface For {
  /** The recording's own id, which the page is told it by. */
  id: string
  user: string
  page: string
  owner: string
  /** The grant the person allowed it under. */
  grant: string
  title: string
  /** The recording paused, went on, or ended without the page asking, with what was recorded where that is the page's to have. */
  told: (state: 'recording' | 'paused' | 'ended', why?: Why, file?: Blob) => void
}

/**
 * Room kept below the most a recording may be, for what the recorder still holds when it is
 * asked to stop: at least this, and twice the largest piece it has given so far.
 */
const ROOM = 1024 * 1024
/** The pieces of a recording, the last ones left off until what is left is no more than `most`: what a stop let through is never sent past the limit. */
export function withinTheMost(pieces: Blob[], most: number): Blob[] {
  let bytes = pieces.reduce((n, p) => n + p.size, 0)
  let kept = pieces.length
  while (kept > 0 && bytes > most) bytes -= pieces[--kept]!.size
  return pieces.slice(0, kept)
}

/**
 * Begins recording, for a page that the person allowed on this screen. Rejects with what the
 * browser said where it would not. It stops by itself, keeping what was recorded, before it is
 * larger than `most`, which is the most a file an action carries may be: a longer take would
 * otherwise be recorded only to be refused when the page sends it.
 */
export async function begin(spec: Spec, page: For, most: number = RECORDING.mostBytes): Promise<Begun> {
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
  let bytes = 0
  let largest = 0
  recorder.ondataavailable = (e) => {
    if (e.data.size <= 0) return
    pieces.push(e.data)
    bytes += e.data.size
    largest = Math.max(largest, e.data.size)
    // Near the most: stopped now, with room for what the recorder still holds
    if (!over && bytes + Math.max(ROOM, 2 * largest) >= most) end('too_large')
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
        const kept = withinTheMost(pieces, most)
        resolve(keep && kept.length ? new Blob(kept, { type: recorder.mimeType || mimeType || kept[0]!.type }) : undefined)
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
    if (over) return
    const keep = why === 'device' || why === 'too_long' || why === 'too_large'
    void finish(keep).then((file) => {
      if (why === 'too_large') {
        notes.set(page.page, file ? 'kept' : 'lost')
        changed()
      }
      page.told('ended', why, file)
    })
  }
  const longest = setTimeout(() => end('too_long'), RECORDING.longestMs)
  // A device that goes away, or that the person turns off from the browser's own controls, ends it
  for (const t of stream.getTracks()) t.addEventListener('ended', () => end('device'), { once: true })
  recorder.start(1000)
  if (notes.delete(page.page)) changed()
  live = [
    ...live,
    {
      id,
      user: page.user,
      page: page.page,
      owner: page.owner,
      grant: page.grant,
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
  return { id, mimeType: recorder.mimeType || mimeType, stop: finish, end }
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
    // A camera open for a photo is closed while the screen does not show It, whose bar is where it is seen
    if (document.visibilityState === 'hidden') shooting?.close()
    if (!live.length) return
    if (document.visibilityState === 'hidden') pauseAll()
    else resumeAll()
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
 * and only while nothing records. `cancel` closes the view, as when the page is closed.
 */
export async function shoot(
  page: { page: string; title: string; user: string; owner: string; grant: string },
  facing: 'user' | 'environment' | undefined,
): Promise<{ photo: Promise<Blob | null>; cancel: () => void }> {
  if (shooting || live.length || cameras.length) throw new Error('The camera is in use on this screen just now.')
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

/** Why the live camera ended without the page asking: as a recording ends, but never for its length or its size. */
export type CameraWhy = Exclude<Why, 'too_long' | 'too_large'>
/** The camera live to a page, as It's bar shows it. */
export interface LiveCamera {
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
  end: (why: CameraWhy) => void
}
let cameras: LiveCamera[] = []
/** The cameras live to a page on this screen. */
export const useCameras = (): LiveCamera[] => useSyncExternalStore(watch, () => cameras)
/** A page's live camera, if it has one. */
export const cameraFor = (page: string): LiveCamera | undefined => cameras.find((c) => c.page === page)
/** Each live camera's own word for whether the screen shows the site, by its id. */
const shown = new Map<string, (hidden: boolean) => void>()
// While the screen does not show the site the camera waits, and the page is given nothing
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
  still: () => CameraWhy | null
  /** One picture for the page, numbered in the order the camera gave it, which is handed on. */
  picture: (frame: number, picture: ImageBitmap) => void
  /** The camera paused, went on, or ended without the page asking. */
  told: (state: 'live' | 'paused' | 'ended', why?: CameraWhy) => void
}
/** The live camera, as the frame that opened it holds it. */
export interface Opened {
  id: string
  /** The page has drawn this picture: another may be sent in its place. */
  drawn: (frame: number) => void
  /** Closes it, as the page asked. */
  stop: () => void
  /** Closes it without the page asking, and tells the page why. */
  end: (why: CameraWhy) => void
}

/**
 * Opens the camera live, for a page that the person allowed it on this screen, and sends the
 * page its pictures until it is closed. Rejects with what the browser said where it would not
 * give the camera.
 */
export async function openCamera(video: true | MediaTrackConstraints, page: CameraFor): Promise<Opened> {
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  // The camera's picture, in a video element that is never shown: what each picture is taken from
  const view = document.createElement('video')
  view.muted = true
  view.playsInline = true
  view.srcObject = stream
  try {
    await view.play()
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    throw err
  }
  /** The pictures sent that the page has not said it drew, and how many are being made. */
  const sent = new Set<number>()
  let making = 0
  let frames = 0
  /** When each of the pictures begun in the last second was begun. */
  const begun: number[] = []
  let state: 'live' | 'paused' = 'live'
  let over = false
  let usedAt = Date.now()
  const close = (): boolean => {
    if (over) return false
    over = true
    clearInterval(watching)
    cameras = cameras.filter((c) => c.id !== page.id)
    shown.delete(page.id)
    for (const t of stream.getTracks()) t.stop()
    view.srcObject = null
    changed()
    return true
  }
  const end = (why: CameraWhy) => {
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
    { id: page.id, user: page.user, page: page.page, owner: page.owner, grant: page.grant, title: page.title, since: Date.now(), state, end },
  ]
  shown.set(page.id, show)
  changed()
  // Opened while the screen does not show the site: it waits at once
  if (document.visibilityState === 'hidden') show(true)
  next()
  return {
    id: page.id,
    drawn: (frame) => {
      sent.delete(frame)
    },
    stop: () => {
      close()
    },
    end,
  }
}
