// Showing a page. Each showing gets exactly one ticket:
//
//   1. the backend makes the mount, and gives the one ticket for it
//   2. the frame is sent to the port pages are shown from, with the ticket in its address
//   3. the content service trades the ticket for a path nobody can guess, and sends the frame
//      on to the page under it
//   4. the page's own script says hello, and gets a channel for clicks and state
//
// Whatever is in the frame is generated HTML, in a sandbox: its origin is its own, and it has
// no cookies and no storage. So a message is known to be from the page by the window it came
// from, and by nothing else. Nothing a page says is believed beyond "this page wants to submit
// this action for itself, with these files", or "this page wants It to go fullscreen, or to
// leave it", and how much it may ask of the site is bounded here, before anything reaches the
// backend. The site never opens a file a page sent: it keeps
// and sends its bytes as they are.
import {
  CHANNEL_VERSION,
  contentPort,
  FAULT,
  isStoreKey,
  jsonText,
  LIMITS,
  MESSAGE,
  type MediaKind,
  openedForAPage,
  type PageToSite,
  SANDBOX,
  type SiteToPage,
  STORE_EVERY_MS,
} from '@it/protocol'
import { useConvex } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { askTwice } from './backend'
import { enterFullscreen, fullscreenAvailable, fullscreenJustLeft, fullscreenOn, leaveFullscreen, NOT_FULLSCREEN, onFullscreenChange } from './fullscreen'
import { api, displayKey, type Id, note, refusal } from './lib'
import { useLiveState } from './live'
import {
  allow,
  askPerson,
  type Begun,
  begin,
  browserWillAsk,
  cameraVideoOf,
  cannotRecord,
  dismissNote,
  grantFor,
  grantsOf,
  kindsOf,
  kindsSaid,
  type Opened,
  openCamera,
  shoot,
  specOf,
  usedNow,
  type Why,
  whileTheBrowserAsks,
} from './media'
import { type Sent, submit } from './outbox'
import { reportPage } from './presence'

type Phase = { is: 'loading' } | { is: 'shown' } | { is: 'failed'; why: string }
const REMOUNT_EVERY_MS = 10_000
/** A page that asks for more than this is told to slow down, without the backend hearing of it. */
const BURST = 20
const PER_SECOND = 5
/**
 * What a page keeps for itself is counted apart, and allowed more: twice what the script in a
 * page sends at its fastest, which is one write each STORE_EVERY_MS, each with whatever was set
 * in between. A page refused here is told how long to wait, and the script in it sends again then.
 */
const STORE_BURST = 40
const STORE_PER_SECOND = 2 * (1000 / STORE_EVERY_MS)
/** How long after the person last did something in a page an action from it still counts as theirs. */
const ATTENDED_MS = 30_000
/**
 * How long the browser goes on saying "the person just acted" after a click on the site itself:
 * five seconds, in every browser that says it at all, and a moment more for the clocks to agree.
 */
const SITE_TOUCH_MS = 5020
// When the person last clicked, tapped or pressed a key on the site itself. The site sees its
// own, and never those inside a page's frame, which belong to another origin; a page can cause
// neither. Noted from the moment the site loads, so that the click which opens a page counts.
let siteTouchedAt = 0
const siteTouched = () => {
  siteTouchedAt = Date.now()
}
// A touch counts from when the finger lifts, which is when the browser starts saying so, as
// well as from when it lands
for (const kind of ['pointerdown', 'pointerup', 'mouseup', 'touchend', 'click', 'keydown', 'keyup']) window.addEventListener(kind, siteTouched, true)
/** How long a page has to load and say hello. */
const READY_MS = 20_000
/** How close together the browser refuses to show another site in a page's frame and the frame loads what it shows instead, the browser's error page, in either order. */
const REFUSED_LOAD_MS = 2000
/**
 * Where pages are shown from: the port after the site's own, on the machine the site itself was
 * reached at and by the same name, so that a page is reached wherever the site is.
 */
const pages = () => `${location.protocol}//${location.hostname}:${contentPort(Number(location.port) || (location.protocol === 'https:' ? 443 : 80))}`
/** What a page is told when it asked for fullscreen other than on the person's own click or key in it. */
const NOT_FROM_THE_PAGE =
  'It goes fullscreen for a page only on a click or a key in the page itself, and not just after a click on It or just after fullscreen was left. Ask again on the next click in the page.'
/** What a page is told of It's fullscreen. */
const fullscreenSaid = (): SiteToPage => ({ type: 'it:fullscreen', on: fullscreenOn(), enabled: fullscreenAvailable() })

/** What something done for a page was begun under: the conversation that had the page, and the grant that allowed it (media.ts `grantFor`). */
interface Held {
  owner: string
  grant: string
  /** Which of the documents the frame has shown asked for it: what one asked for is not the next one's. */
  doc: number
}

/** Who made a page, as the person is told when it asks for the microphone or the camera, and the conversation a grant is held to. */
export interface MadeBy {
  agent: string | null
  machine: string | null
  /** The conversation that has the page now (media.ts `ownerOf`). */
  owner: string
}

export function Mount({
  artifactId,
  title,
  user,
  madeBy,
  onFault,
}: {
  artifactId: Id<'artifacts'>
  title: string
  user: string
  madeBy?: MadeBy
  /** Told what the page's own script failed with, each time it says so. */
  /** The page's own script failed, with what it failed with; and again once its agent has been told. */
  onFault?: (message: string, agentTold: boolean) => void
}) {
  const convex = useConvex()
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [mount, setMount] = useState<{ address: string; mountId: string; version: number } | null>(null)
  const [phase, setPhase] = useState<Phase>({ is: 'loading' })
  /** The one channel to whatever document the frame is showing now. */
  const port = useRef<MessagePort | null>(null)
  /** These outlive a remount, so a page cannot reset them by asking to be shown again. */
  const lastRemount = useRef(0)
  const failures = useRef(0)
  /**
   * The person said no to the page's asking for the microphone or the camera, in this showing:
   * it is not asked again until it is opened again, however often it asks or has its frame shown
   * afresh. A page another conversation takes over is asked about for that one.
   */
  const refused = useRef(false)
  /** Whoever is told of the page's faults now: kept apart from the channel, which is set up once for a showing. */
  const told = useRef(onFault)
  told.current = onFault
  /** Who made the page, as it is now: kept apart from the channel, as `told` is. */
  const maker = useRef(madeBy)
  maker.current = madeBy
  /** The showing's word that the page has another owner now: what records or is asked for it under the one before is let go. */
  const ownerMoved = useRef<((owner: string) => void) | null>(null)
  const titled = useRef(title)
  titled.current = title
  /** The version of the page whose agent this showing has told that its script failed: it is told once for a version. */
  const faulted = useRef<number | null>(null)
  const liveState = useLiveState(artifactId)
  const again = useCallback(() => setAttempt((n) => n + 1), [])
  // What this tab shows, for what the display says of itself: this page's showing and how far it
  // has got, and nothing once the page is left
  const mountId = mount?.mountId
  useEffect(() => {
    reportPage(mountId === undefined ? 'none' : phase.is, mountId)
  }, [phase.is, mountId])
  useEffect(() => () => reportPage('none'), [])

  // 1 and 2. a fresh mount for every showing, and its one ticket
  useEffect(() => {
    let live = true
    setMount(null)
    setPhase({ is: 'loading' })
    void attempt
    // A showing that met trouble on the way is begun afresh, once, before the person is told of
    // any: a mount that got no ticket is of no use to anyone, and is left behind
    let made = false
    askTwice(
      convex,
      async (calls) => {
        made = false
        const m = await calls.mutation(api.mounts.create, { artifactId, displayKey: displayKey() })
        made = true
        if (!live) return null
        const { ticket } = await calls.action(api.mounts.ticket, { mountId: m.mountId })
        // The ticket is the last part of the frame's address, and is spent the moment the frame asks for it
        return { address: `${pages()}/open/${ticket}`, mountId: m.mountId, version: m.version }
      },
      () => live,
    ).then(
      (shown) => live && shown && setMount(shown),
      (err) => {
        if (made) note('no ticket was given for a page', refusal(err).code)
        if (live) setPhase({ is: 'failed', why: refusal(err).message })
      },
    )
    return () => {
      live = false
    }
  }, [convex, artifactId, attempt])

  // 3 and 4
  useEffect(() => {
    if (!mount) return
    let live = true
    let ready = false
    let answered = ''
    let tokens = BURST
    let filled = Date.now()
    let storeTokens = STORE_BURST
    let storeFilled = Date.now()
    const timer = setTimeout(() => live && setPhase({ is: 'failed', why: 'The page did not load. Check the connection.' }), READY_MS)
    /** The framing again that a showing which ran out too soon after the last one is waiting for. */
    let later: ReturnType<typeof setTimeout> | undefined

    // "At the page" means the person did something in it lately. A browser tells this page when
    // the person has just clicked, tapped or typed anywhere in it, frames included, and a script
    // cannot make it say so. That is looked at often, and a look that finds it true while the
    // frame has the keyboard is remembered for a while, since a page may send its action some
    // seconds after the click that caused it. Where a browser does not tell, the frame having
    // the keyboard is all there is to go on.
    //
    // The browser says the same for a few seconds after a click on the site itself: on the card
    // that opened this page, say. That is not the person doing something in the page, and a
    // page could take the keyboard for itself in that moment. So what the browser says within
    // those few seconds of a click on the site is not counted. A page that sends an action in
    // that time is asked to wait until they are over, and then it is looked at again: a real
    // click in the page is still being reported by the browser then, and the site's own is not.
    let touchedAt = 0
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation
    // A page can also be brought up while the browser is still reporting a click made somewhere
    // else: in the page that was showing before, say, when an agent shows another. That click
    // was not made in this page either, and is waited out in the same way.
    const before = activation?.isActive ? Date.now() : 0
    const lastElsewhere = () => Math.max(siteTouchedAt, before)
    const inFrame = () => document.visibilityState === 'visible' && document.activeElement === frame.current
    const look = () => {
      if (inFrame() && (activation ? activation.isActive && Date.now() - lastElsewhere() > SITE_TOUCH_MS : true)) touchedAt = Date.now()
    }
    const looking = setInterval(look, 500)
    /**
     * Whether the person was at the page when it sent an action. What matters is how things
     * stood at that moment, so that is noted at once; where the person goes while the answer
     * is being waited for (back to the grid, to another tab) changes nothing.
     */
    const attended = (): boolean | (() => Promise<boolean>) => {
      look()
      const focused = inFrame()
      if (!focused) return false
      if (Date.now() - touchedAt < ATTENDED_MS) return true
      const noted = siteTouchedAt
      const unsure = lastElsewhere() + SITE_TOUCH_MS - Date.now()
      if (!activation?.isActive || unsure <= 0) return false
      // The browser says the person has just acted, but so soon after a click on the site
      // itself that it cannot yet be told which click it means. Once the site's own has worn
      // off, a click in the page is still being reported. Another click on the site meanwhile
      // makes it impossible to tell, and then it is not counted.
      return async () => {
        // Looked at the moment the earlier click has stopped being what the browser may be
        // reporting, and no later: a click made in the page soon after is itself only
        // reported for so long
        await new Promise((r) => setTimeout(r, unsure))
        return siteTouchedAt === noted && activation.isActive
      }
    }
    const toPage = (to: MessagePort, message: SiteToPage) => to.postMessage(message)

    // The microphone and the camera (media.ts). The site records for the page, one thing at a
    // time, when the page calls for it, and only once the person at this screen has allowed it.
    // A call is the page's only if it came over the channel of the document the frame shows now.
    // What the person said no to is not asked again in this showing.
    let recording: Begun | null = null
    let question: { cancel: () => void } | null = null
    let photo: { cancel: () => void } | null = null
    /** A recording or a photo is being begun: the person or the browser is being asked, and nothing is under way yet to say so. */
    let beginning = false
    /** A question taken away because the document that asked is gone: its going is not the person's no. */
    let letGo: unknown = null
    /** Which document the frame shows now, counted from the first: one that loads in its place is another, and what the one before began or asked for is not its. */
    let docs = 0
    // Each thing done for the page is held to the conversation the page had when it was asked for:
    // what the person allowed is that one's, and no other's. Each keeps its own, so that something
    // asked for later, under another conversation, cannot stand in for what an earlier one began with.
    /** Whose the question the person is being asked about is, whose the camera open for a photo, and whose the recording under way. */
    let questionBy = ''
    let photoBy = ''
    let recordingBy: Held = { owner: '', grant: '', doc: -1 }
    const OWNER_MOVED =
      'Another conversation took this page over, so It stopped what it was doing for it. The person is asked again for the conversation that has it now.'
    const TAKEN_BACK = 'The person took back what they had allowed this page.'
    const HIDDEN = 'The screen stopped showing the page, so It closed the camera, and took no photo.'
    /** Why what is being done for the page may not go on, or nothing where it may: the page is gone, it has another owner, or what was allowed was taken back. */
    const whyNot = (kinds: MediaKind[], by: Held): 'not_shown' | 'taken_over' | 'taken_back' | null =>
      !live || by.doc !== docs
        ? 'not_shown'
        : (maker.current?.owner ?? '') !== by.owner
          ? 'taken_over'
          : grantFor(user, artifactId, by.owner, kinds) !== by.grant
            ? 'taken_back'
            : null
    const SAID = { not_shown: 'The page was closed.', taken_over: OWNER_MOVED, taken_back: TAKEN_BACK } as const
    /** The same, in words for the page. */
    const mayNotGoOn = (kinds: MediaKind[], by: Held): string | null => {
      const why = whyNot(kinds, by)
      return why ? SAID[why] : null
    }
    /** What the recording under way records, for asking again whether the page may have what it gives. */
    let recordingKinds: MediaKind[] = []
    // The camera live to the page (media.ts `openCamera`), which is one more thing at a time: held to
    // the conversation and the grant it was opened under, and each picture checked as it goes
    let camera: Opened | null = null
    /** The id the page names its live camera by, and what it was opened under. */
    let cameraId = ''
    let cameraBy: Held = { owner: '', grant: '', doc: -1 }
    const CAMERA_LIVE =
      'The camera is live to this page just now, so It takes no photo and records no video for it. The page can take its own picture from cam.onframe or cam.stream, or stop the camera first. Sound alone can be recorded beside it.'
    // Another conversation took the page over: whatever records, is asked for or is open for a
    // photo under the one before stops, and what was recorded is thrown away. The person allowed
    // that conversation, and the new one has to be allowed for itself.
    ownerMoved.current = (owner) => {
      // A no from the person was about the conversation before: the one that has the page now is asked for itself
      refused.current = false
      if (question && questionBy !== owner) question.cancel()
      if (photo && photoBy !== owner) photo.cancel()
      if (recording && recordingBy.owner !== owner) recording.end('taken_over')
      if (camera && cameraBy.owner !== owner) camera.end('taken_over')
    }
    /**
     * Leaves the frame in It's own place while the microphone or the camera is asked about, records
     * or is open for a photo: a frame that fills the screen would hide It's bar, which asks, says
     * that it records, and has the buttons that stop it and take the photo.
     */
    const inSight = () => {
      if ((beginning || recording || photo || camera) && document.fullscreenElement && document.fullscreenElement === frame.current)
        void document.exitFullscreen().catch(() => {})
    }
    document.addEventListener('fullscreenchange', inSight)
    /**
     * Settles whether the page may use these here, asking the person where they have not said:
     * once, in It's bar, for what this call wants that the page is not allowed yet on this
     * screen, as the conversation that has it now. Nothing but the page's own call asks, and only
     * while the person can see the page. Throws, in words for the page, where it may not.
     */
    const mayUse = async (kinds: MediaKind[]): Promise<Held> => {
      const cannot = cannotRecord()
      if (cannot) throw new Error(cannot)
      const doc = docs
      // Nothing is begun for a page the screen does not show, where It's bar, which says what records, cannot be seen
      if (document.visibilityState === 'hidden')
        throw new Error('It uses the microphone and the camera for a page only while this screen shows it. Ask again once the page is in front.')
      const by = maker.current
      const owner = by?.owner ?? ''
      const already = grantFor(user, artifactId, owner, kinds)
      if (already) {
        usedNow(user, artifactId)
        return { owner, grant: already, doc }
      }
      if (refused.current) throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      // Asked only of someone who has the page in front of them: a window behind another, shown or not, is not asked from
      if (!document.hasFocus())
        throw new Error('It asks the person only while the page is in front, in the window they are using. Ask again from something they do on the page.')
      // What this call wants beyond what the page is allowed already, which stays as it is
      const had = grantsOf(user).find((g) => g.page === artifactId && g.owner === owner)
      const asking = kinds.filter((k) => !had?.kinds.includes(k))
      const asked = askPerson({ page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, kinds: asking })
      question = asked
      questionBy = owner
      const yes = await asked.answer
      if (question === asked) question = null
      if (!live) throw new Error('The page was closed.')
      if (letGo === asked) throw new Error('The page loaded another document, which asks for itself.')
      // Taken over while the person was asked: what they answered was about the conversation before
      if ((maker.current?.owner ?? '') !== owner) throw new Error(OWNER_MOVED)
      if (!yes) {
        refused.current = true
        throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      }
      if (doc !== docs) throw new Error('The page loaded another document, which asks for itself.')
      allow(user, { page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, owner, kinds: asking })
      const grant = grantFor(user, artifactId, owner, kinds)
      if (!grant) throw new Error(TAKEN_BACK)
      return { owner, grant, doc }
    }
    /**
     * Gets the device for what the page may use, through `get`. Where the browser asks about it
     * itself, the first time on this screen, It's bar says which page the browser's question is
     * for, while it is asked; It asks nothing more of its own.
     */
    const withDevice = async <T,>(kinds: MediaKind[], get: (held: Held) => Promise<T>): Promise<{ held: Held; got: T }> => {
      const held = await mayUse(kinds)
      const shown = (await browserWillAsk(kinds)).length ? whileTheBrowserAsks({ page: artifactId, title: titled.current, kinds }) : undefined
      try {
        return { held, got: await get(held) }
      } catch (err) {
        throw deviceRefused(err)
      } finally {
        shown?.()
      }
    }
    /** What the browser said when it would not give the device, in words for the page and the person. */
    const deviceRefused = (err: unknown): Error => {
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError')
        return new Error('The browser did not let It use that on this screen. Allow it for It’s site in the browser’s settings, and try again.')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('This screen has no microphone or camera that does what was asked.')
      if (name === 'NotReadableError' || name === 'AbortError') return new Error('The microphone or the camera is in use by something else on this screen.')
      return err instanceof Error ? err : new Error('It could not record.')
    }
    const onMedia = async (
      from: MessagePort,
      message: Extract<PageToSite, { type: 'it:record' | 'it:record-stop' | 'it:photo' | 'it:camera' | 'it:camera-stop' }>,
    ) => {
      if (message.type === 'it:record-stop') {
        const was = recording
        if (!was || was.id !== message.recording) throw new Error('That recording is not under way.')
        // Whose it was, and what it records, as it was begun: the page may begin another while this one finishes
        const wasBy = recordingBy
        const wasKinds = recordingKinds
        recording = null
        if (message.keep !== true) {
          await was.stop(false)
          return {}
        }
        const file = await was.stop(true)
        // Taken over, or taken back, while the recorder was finishing: what it gives is not the page's
        const cannot = mayNotGoOn(wasKinds, wasBy)
        if (cannot) throw new Error(cannot)
        return { file }
      }
      if (message.type === 'it:camera-stop') {
        if (!camera || cameraId !== message.camera) throw new Error('That camera is not open.')
        camera.stop()
        camera = null
        return {}
      }
      // One thing at a time, but for sound recorded while the camera is live, which the page can have
      // beside it: each is begun, allowed, ended and stopped by itself
      if (message.type === 'it:camera') {
        if (camera) throw new Error('The camera is live to this page already. Stop it before it is opened again.')
        if (recording && recordingKinds.includes('camera'))
          throw new Error('This page is recording from the camera just now. Stop the recording before the camera is shown to it live.')
        if (photo) throw new Error('It’s view of the camera is open for a photo for this page. Take the photo or close it first.')
        if (beginning || question) throw new Error('This page is using the microphone or the camera already. Stop that first.')
      } else {
        if (camera && (message.type === 'it:photo' || kindsOf(message).includes('camera'))) throw new Error(CAMERA_LIVE)
        if (beginning || recording || question || photo) throw new Error('This page is using the microphone or the camera already. Stop that first.')
      }
      // Taken at once, before anything is waited for: a second asking that arrives while the
      // person or the browser is asked about the first is refused, and is not begun beside it
      beginning = true
      // And It's bar is seen, which asks and says what is under way
      inSight()
      try {
        if (message.type === 'it:camera') return await openLive(from, message)
        return message.type === 'it:photo' ? await takePhoto(message) : await beginRecording(from, message)
      } finally {
        beginning = false
      }
    }
    const takePhoto = async (message: Extract<PageToSite, { type: 'it:photo' }>) => {
      const facing = message.facing === 'user' || message.facing === 'environment' ? message.facing : undefined
      const { held, got: taking } = await withDevice(['camera'], (h) =>
        shoot({ page: artifactId, title: titled.current, user, owner: h.owner, grant: h.grant }, facing),
      )
      const owner = held.owner
      // The page was closed, left for another document, taken over, or what it was allowed taken
      // back while the browser was asked, or the screen stopped showing it: the camera is closed again at once
      const before = mayNotGoOn(['camera'], held) ?? (document.visibilityState === 'hidden' ? HIDDEN : null)
      if (before) {
        taking.cancel()
        throw new Error(before)
      }
      photo = taking
      photoBy = owner
      // Nothing more is being begun: what is open now is the person's to finish
      beginning = false
      inSight()
      const made = await taking.photo
      photo = null
      // And again before the photo is handed over: one taken as the camera was being closed for any of these is not the page's
      const after = mayNotGoOn(['camera'], held)
      if (after) throw new Error(after)
      if (!made) throw new Error(document.visibilityState === 'hidden' ? HIDDEN : 'The person closed the camera without taking a photo.')
      return { file: made }
    }
    const beginRecording = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:record' }>) => {
      const spec = specOf(message)
      let held: Held = { owner: '', grant: '', doc: -1 }
      const id = crypto.getRandomValues(new Uint32Array(2)).join('-')
      const tell = (state: 'recording' | 'paused' | 'ended', said?: Why, given?: Blob) => {
        if (state === 'ended' && recording?.id === id) recording = null
        let why = said
        let file = given
        // A recording that ended by itself gives what it recorded only to a page that may still have it: one
        // taken over, or whose leave was taken back, while the recorder was finishing is told that instead, and given nothing
        const not = file ? whyNot(kindsOf(spec), held) : null
        if (not) {
          why = not
          file = undefined
          dismissNote(artifactId)
        }
        if (live && port.current === from) toPage(from, { type: 'it:recording', recording: id, state, ...(why ? { why } : {}), ...(file ? { file } : {}) })
      }
      recording = (
        await withDevice(kindsOf(spec), (h) => {
          held = h
          return begin(spec, { id, user, page: artifactId, owner: h.owner, grant: h.grant, title: titled.current, told: tell })
        })
      ).got
      // The page was closed, taken over, or what it was allowed taken back while the browser was
      // asked: nothing is recorded for a page that is gone, that another conversation has now, or that may not
      const cannot = mayNotGoOn(kindsOf(spec), held)
      if (cannot) {
        void recording.stop(false)
        recording = null
        throw new Error(cannot)
      }
      recordingBy = held
      recordingKinds = kindsOf(spec)
      inSight()
      return { recording: { id, mimeType: recording.mimeType } }
    }
    const openLive = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:camera' }>) => {
      const video = cameraVideoOf(message.video)
      // The page names the camera itself, so that a picture that comes before the answer is one it knows
      const id = typeof message.camera === 'string' ? message.camera.slice(0, 100) : ''
      if (!id) throw new Error('A live camera needs an id to be named by.')
      /** The camera this opens, once it is open: what the end it is told of is compared with. */
      let mine: Opened | null = null
      // Allowed as a photo or a recording is, and It's bar says which page the browser asks about, where it asks
      const { held, got: opened } = await withDevice(['camera'], (h) =>
        openCamera(video, {
          id: crypto.getRandomValues(new Uint32Array(2)).join('-'),
          user,
          page: artifactId,
          owner: h.owner,
          grant: h.grant,
          title: titled.current,
          // The camera is the page's only while the document that opened it is shown, the page has
          // the conversation the person allowed, and what it was allowed under stands: asked as each
          // picture goes, and every second besides, and not only when the camera was opened
          still: () => (port.current === from ? whyNot(['camera'], h) : 'not_shown'),
          picture: (frame, picture) => from.postMessage({ type: 'it:camera-frame', camera: id, frame, picture } satisfies SiteToPage, [picture]),
          told: (state, why) => {
            if (state === 'ended' && camera !== null && camera === mine) camera = null
            if (live && port.current === from) toPage(from, { type: 'it:camera-state', camera: id, state, ...(why ? { why } : {}) })
          },
        }),
      )
      mine = opened
      // The page was closed, loaded another document, was taken over, or what it was allowed was
      // taken back while the browser was asked: the camera is closed again at once
      const cannot = port.current === from ? mayNotGoOn(['camera'], held) : SAID.not_shown
      if (cannot) {
        opened.stop()
        throw new Error(cannot)
      }
      camera = opened
      cameraId = id
      cameraBy = held
      // An open camera is the page using what it was allowed: noted as it opens, and every hour while it is open (media.ts)
      usedNow(user, artifactId)
      // And a frame that fills the screen is put back in its place, where It's bar says the camera is live
      inSight()
      return {}
    }
    const allowed = () => {
      const now = Date.now()
      // Never less than nothing: a browser's clock that was set back would otherwise take an hour's worth away, and the page would be refused for an hour
      tokens = Math.min(BURST, tokens + (Math.max(0, now - filled) / 1000) * PER_SECOND)
      filled = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    }
    /** Whether the page may keep something now, or else how long until it may. */
    const storeAllowed = (): number => {
      const now = Date.now()
      storeTokens = Math.min(STORE_BURST, storeTokens + (Math.max(0, now - storeFilled) / 1000) * STORE_PER_SECOND)
      storeFilled = now
      if (storeTokens < 1) return Math.ceil(((1 - storeTokens) / STORE_PER_SECOND) * 1000)
      storeTokens -= 1
      return 0
    }
    /** Shows the page again, but not in a loop: one shown again so soon after the last time is shown again when that while has passed. */
    const showAgain = () => {
      const remount = () => {
        lastRemount.current = Date.now()
        again()
      }
      const wait = Math.min(lastRemount.current + REMOUNT_EVERY_MS - Date.now(), REMOUNT_EVERY_MS)
      if (wait < 0) remount()
      else later ??= setTimeout(remount, wait)
    }
    const fromPage = async (from: MessagePort, message: PageToSite) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'it:lapsed') {
        // The page's showing is over. Show it again. It is not let go by, since a document says
        // that its showing is over only once, and the page would stay as it is with nothing
        // under it to load from.
        showAgain()
        return
      }
      if (message.type === 'it:fault') {
        if (typeof message.message !== 'string') return
        // Only ever shown as text, and no more of it than fits a line
        const text = message.message.replace(/\s+/g, ' ').slice(0, 200)
        // What a browser says of a script from elsewhere that it will not describe, and of a
        // layout it could not finish in one pass, is not the page's script failing
        if (/^Script error\.?$/.test(text) || /ResizeObserver loop/.test(text)) return
        told.current?.(text, false)
        // And its agent is told, once for each version of the page however many times and
        // places it is opened in: the person can only carry the words over by hand, and an
        // agent that is waiting for an answer waits for one that cannot come
        if (faulted.current === mount.version) return
        faulted.current = mount.version
        try {
          const was = attended()
          await submit(
            convex,
            user,
            artifactId,
            {
              v: 1,
              clientActionId: `it-fault-v${mount.version}`,
              name: FAULT,
              payload: JSON.stringify({ message: text }),
              contentVersion: mount.version,
              attended: was === true,
            },
            () => live && port.current === from,
            typeof was === 'function' ? was : undefined,
          )
          told.current?.(text, true)
        } catch {
          // Refused, or too many at once: the bar has said it, which is what the person needs
        }
        return
      }
      if (message.type === 'it:camera-drawn') {
        // Never answered, and not counted against what the page may send: one comes for each picture
        if (camera && message.camera === cameraId && typeof message.frame === 'number') camera.drawn(message.frame)
        return
      }
      if (
        message.type === 'it:record' ||
        message.type === 'it:record-stop' ||
        message.type === 'it:photo' ||
        message.type === 'it:camera' ||
        message.type === 'it:camera-stop'
      ) {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : ''
        try {
          // Stopping is never refused for asking too often: a page that cannot stop would go on recording
          if (message.type !== 'it:record-stop' && message.type !== 'it:camera-stop' && !allowed())
            throw new Error('This page is sending too much at once. Try again in a moment.')
          toPage(from, { type: 'it:result', requestId, ok: true, ...(await onMedia(from, message)) })
        } catch (err) {
          toPage(from, { type: 'it:result', requestId, ok: false, error: err instanceof Error ? err.message.slice(0, 500) : 'It could not record.' })
        }
        return
      }
      if (message.type !== 'it:action' && message.type !== 'it:store') return
      const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : ''
      if (message.type === 'it:store') {
        const wait = storeAllowed()
        if (wait > 0) {
          toPage(from, { type: 'it:result', requestId, ok: false, error: 'This page is storing too much at once. Try again in a moment.', retryAfterMs: wait })
          return
        }
      }
      try {
        if (message.type === 'it:action' && !allowed()) throw new Error('This page is sending too much at once. Try again in a moment.')
        if (message.type === 'it:action') {
          const e = message.envelope
          // The name of what a person types above a page is the site's own, and no page's to send under
          if (e.name === MESSAGE) throw new Error(`A page may not send an action named ${MESSAGE}.`)
          // Said by the site, not the page: whether the person was at this page when it sent this.
          // A page can send actions with nobody touching it, and its agent should know which is which.
          const was = attended()
          // The files it carries go beside it, and are said in what it carries by their numbers
          const files: Blob[] = []
          const envelope: Sent = {
            v: 1,
            clientActionId: typeof e.clientActionId === 'string' ? e.clientActionId : '',
            name: typeof e.name === 'string' ? e.name : '',
            payload: jsonText(e.payload, LIMITS.actionPayloadBytes, files),
            // The version this showing is of, as the site knows it: a showing is of one version,
            // so that is what the person was looking at, whatever the page says
            contentVersion: mount.version,
            ...(typeof e.baseStateRevision === 'number' ? { baseStateRevision: e.baseStateRevision } : {}),
            attended: was === true,
          }
          // The document that sent it is still there only while its own channel is the one in use
          const done = await submit(convex, user, artifactId, envelope, () => live && port.current === from, typeof was === 'function' ? was : undefined, files)
          toPage(from, { type: 'it:result', requestId, ok: true, actionId: done.actionId })
        } else {
          // The same rules the backend keeps, kept here so that nothing long is sent only to be refused.
          // A page's script that takes the site for one taking a value at a time sends one by itself,
          // as it is: it is written out here, as the site always wrote such a value out
          const changes =
            'changes' in message ? message.changes : 'key' in message ? [[message.key, jsonText(message.value, LIMITS.storeValueBytes)]] : undefined
          if (!Array.isArray(changes) || changes.length === 0 || changes.length > LIMITS.storeKeysAtOnce)
            throw new Error(`One write keeps 1 to ${LIMITS.storeKeysAtOnce} values.`)
          const sent: { key: string; value: string }[] = []
          let total = 0
          for (const change of changes) {
            const [key, value] = Array.isArray(change) ? change : []
            if (!isStoreKey(key)) throw new Error('A store key is 1 to 64 letters, digits, dashes or underscores.')
            if (typeof value !== 'string') throw new Error('That cannot be sent.')
            // Its length in letters first: never more than its length in bytes, and known without reading it
            const bytes = value.length > LIMITS.storeValueBytes ? value.length : new TextEncoder().encode(value).length
            if (bytes > LIMITS.storeValueBytes) throw new Error(`A stored value is at most ${LIMITS.storeValueBytes / 1024} KB.`)
            total += bytes
            if (total > LIMITS.stateBytes) throw new Error(`A page's state is at most ${LIMITS.stateBytes / 1024} KB.`)
            sent.push({ key, value })
          }
          const { revision } = await convex.mutation(api.state.store, { artifactId, changes: sent })
          toPage(from, { type: 'it:result', requestId, ok: true, revision })
        }
      } catch (err) {
        const said = refusal(err) as ReturnType<typeof refusal> & { retryAfterMs?: unknown }
        toPage(from, {
          type: 'it:result',
          requestId,
          ok: false,
          error: said.code === 'error' && err instanceof Error && !('data' in err) ? err.message : said.message,
          ...(said.code === 'rate_limited' && typeof said.retryAfterMs === 'number' ? { retryAfterMs: said.retryAfterMs } : {}),
        })
      }
    }

    const onMessage = (e: MessageEvent) => {
      // Only this frame. What is in it has no origin to be known by: the window it came from is what tells
      if (!live || e.source !== frame.current?.contentWindow) return
      const type = (e.data as { type?: unknown } | null)?.type
      if (type === 'it:open') {
        // An address the page asks to have opened in a tab of its own: a link to an address only
        // the person's system can open, which a sandboxed frame cannot hand to it, or It.open.
        // It is opened only from the person's own click or key in the page: the frame holds the
        // keyboard, which a click or a key in it gives it, and the browser says that the person
        // has just acted. It is opened while this message is being handled, which is when WebKit
        // still counts the person's gesture, and with no hold either way and no referrer: the
        // window has no opener, and the site no handle on it.
        const url = openedForAPage((e.data as { url?: unknown }).url)
        if (!url || !inFrame() || (activation && !activation.isActive) || !allowed()) return
        const open = () => void window.open(url, '_blank', 'noopener,noreferrer')
        const unsure = activation ? lastElsewhere() + SITE_TOUCH_MS - Date.now() : 0
        if (unsure <= 0) return open()
        // The browser says the person has just acted, but so soon after a click on the site
        // itself that it cannot yet be told which click it means, and a page could take the
        // site's for its own. Once the site's has worn off, a click in the page is still being
        // reported, and the address is opened then. Another click on the site meanwhile makes
        // it impossible to tell, and then it is not opened at all.
        const noted = siteTouchedAt
        setTimeout(() => {
          if (live && siteTouchedAt === noted && activation?.isActive && inFrame()) open()
        }, unsure)
        return
      }
      if (type === 'it:fullscreen') {
        // The page asks for It's fullscreen, which keeps the bar above it. Asked of the browser
        // here and now, in the turn the message arrived in: a browser goes fullscreen only just
        // after a click, and Safari counts a click in the page as the site's own only while the
        // message it caused is being handled
        const asked = e.data as { requestId?: unknown; on?: unknown }
        const to = port.current
        if (typeof asked.on !== 'boolean' || !to) return
        const requestId = typeof asked.requestId === 'string' ? asked.requestId.slice(0, 100) : ''
        // A refusal is followed by what It is, so that a page that took itself to be in or out of
        // fullscreen ahead of the answer goes by what It is
        const refuse = (error: string) => {
          toPage(to, { type: 'it:result', requestId, ok: false, error })
          toPage(to, fullscreenSaid())
        }
        // Going fullscreen is counted with what else the page asks of the site, as asking again and
        // again would be. Leaving is never refused: it only ever gives the person their screen back
        if (asked.on && !allowed()) return refuse('This page is asking too much at once. Try again in a moment.')
        // Going fullscreen is for the person's own click or key in the page, and never for one of
        // the site's, which the browser counts for the page as well: a page that asked whenever
        // It left fullscreen would otherwise be let back in by the very click on Leave fullscreen.
        // So the frame must hold the keyboard, which a click or a key in it gives it, the browser
        // must say that the person has just acted, and neither a click or key on the site nor the
        // end of fullscreen may be so recent that it could be what the browser means. That is
        // timed from the click or key itself, and not from when the page was framed, which can be
        // seconds later while the browser still reports the click that opened it: a click in the
        // page after that one has worn off counts. Leaving needs none of this
        if (asked.on && (!inFrame() || (activation && !activation.isActive) || Date.now() - siteTouchedAt <= SITE_TOUCH_MS || fullscreenJustLeft()))
          return refuse(NOT_FROM_THE_PAGE)
        ;(asked.on ? enterFullscreen() : leaveFullscreen()).then(
          () => toPage(to, { type: 'it:result', requestId, ok: true }),
          (err) => refuse(err instanceof Error ? err.message : NOT_FULLSCREEN),
        )
        return
      }
      if (type === 'it:hello') {
        if (!ready) {
          // The page's own script is running: the page is there to be seen
          ready = true
          failures.current = 0
          clearTimeout(timer)
          setPhase({ is: 'shown' })
        }
        // One channel at a time. A document says hello until it is answered, and is answered
        // once. A page that loads another of its own documents gets a new channel, and the old
        // one is closed; saying hello again and again makes nothing pile up.
        const named = (e.data as { doc?: unknown }).doc
        const doc = typeof named === 'string' ? named.slice(0, 64) : ''
        // A document names itself, in text. A hello that does not is not from the page's own script as It wrote it.
        if (!doc || doc === answered) return
        if (!allowed()) return
        answered = doc
        docs += 1
        // What the document before asked for, or began, is that document's: it is let go, and the new one asks for itself
        if (question) {
          letGo = question
          question.cancel()
        }
        photo?.cancel()
        recording?.end('not_shown')
        recording = null
        // And its camera closes now, and not at a picture that a page which stopped drawing would never be sent
        camera?.end('not_shown')
        port.current?.close()
        const channel = new MessageChannel()
        port.current = channel.port1
        channel.port1.onmessage = (m) => void fromPage(channel.port1, m.data as PageToSite)
        // Sent to whatever document the page has put in its frame. The channel is for this one
        // showing, and gives a document there nothing the page did not already have.
        ;(e.source as Window).postMessage({ type: 'it:port', v: CHANNEL_VERSION }, '*', [channel.port2])
        const whole = liveState.whole()
        if (whole) toPage(channel.port1, whole)
        // And whether It is fullscreen, which also tells the page that the site takes its asking for it
        toPage(channel.port1, fullscreenSaid())
      }
    }
    window.addEventListener('message', onMessage)
    // The page's frame taken to another site by a way the script in the page cannot see, such as
    // a link inside a closed shadow root that the page's own markup declares. The browser refuses
    // it, since the frame may show only the pages' port, and in Chromium leaves its error page in
    // the frame, which loads in place of the page. The browser tells the site which site it
    // refused and not the address, so what was asked for cannot be opened from here. The page is
    // shown again instead, rather than left as an error page. The browser says that it refused a
    // moment after the error page has loaded, or before, so the two are taken in either order,
    // and each goes with one of the other at most.
    let refusedAt = Number.NEGATIVE_INFINITY
    let loadedAt = Number.NEGATIVE_INFINITY
    const together = () => {
      if (!ready || Math.abs(refusedAt - loadedAt) >= REFUSED_LOAD_MS) return
      refusedAt = Number.NEGATIVE_INFINITY
      loadedAt = Number.NEGATIVE_INFINITY
      showAgain()
    }
    const frameRefused = (e: Event) => {
      if ((e as SecurityPolicyViolationEvent).effectiveDirective !== 'frame-src') return
      refusedAt = Date.now()
      together()
    }
    const framed = frame.current
    const loaded = () => {
      loadedAt = Date.now()
      together()
    }
    document.addEventListener('securitypolicyviolation', frameRefused)
    framed?.addEventListener('load', loaded)
    return () => {
      live = false
      clearTimeout(timer)
      clearTimeout(later)
      clearInterval(looking)
      window.removeEventListener('message', onMessage)
      document.removeEventListener('securitypolicyviolation', frameRefused)
      framed?.removeEventListener('load', loaded)
      // A page that is no longer shown records nothing, and is asked nothing
      document.removeEventListener('fullscreenchange', inSight)
      ownerMoved.current = null
      question?.cancel()
      photo?.cancel()
      void recording?.stop(false)
      recording = null
      camera?.end('not_shown')
      camera = null
      port.current?.close()
      port.current = null
    }
  }, [convex, artifactId, mount, user, again, liveState])

  // State flows down: what changed goes to whatever the frame is showing now
  useEffect(() => liveState.listen((message) => port.current?.postMessage(message)), [liveState])
  // And so does It going fullscreen or leaving it, however that came about
  useEffect(() => onFullscreenChange(() => port.current?.postMessage(fullscreenSaid())), [])

  // The page has another owner: what is done for it under the one before is let go
  const owner = madeBy?.owner ?? ''
  useEffect(() => ownerMoved.current?.(owner), [owner])

  // A display nobody is standing at puts itself right: a failed showing is tried again, less and
  // less often, and at once when the connection or the tab comes back
  const failed = phase.is === 'failed'
  useEffect(() => {
    if (!failed) return
    failures.current += 1
    const wait = Math.min(5000 * 2 ** (failures.current - 1), 300_000)
    const timer = setTimeout(again, wait)
    const now = () => document.visibilityState === 'visible' && navigator.onLine && again()
    window.addEventListener('online', now)
    document.addEventListener('visibilitychange', now)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', now)
      document.removeEventListener('visibilitychange', now)
    }
  }, [failed, again])

  return (
    <div className="mount">
      {mount && phase.is !== 'failed' && (
        <iframe
          ref={frame}
          key={mount.mountId}
          title={title}
          src={mount.address}
          // The same words the content service says on everything it sends: a page never has the
          // origin of its address and can never move this tab, and a window it opens is an
          // ordinary tab, which the script in the page opens with no hold either way
          sandbox={SANDBOX}
          // A page may not take the keyboard by itself, where the browser lets that be said
          allow="fullscreen; clipboard-write; autoplay; focus-without-user-activation 'none'"
          referrerPolicy="no-referrer"
          data-shown={phase.is === 'shown'}
        />
      )}
      {phase.is === 'loading' && (
        <div className="mount-note" role="status">
          Opening…
        </div>
      )}
      {phase.is === 'failed' && (
        <div className="mount-note" role="alert">
          <p className="mount-why">{phase.why}</p>
          <p className="muted">It will try again by itself.</p>
          <button
            type="button"
            onClick={() => {
              failures.current = 0
              again()
            }}
          >
            Try again now
          </button>
        </div>
      )}
    </div>
  )
}
