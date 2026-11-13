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
  WHO_MS,
} from '@it/protocol'
import { useConvex } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { askTwice } from './backend'
import { EmbedLayer } from './embeds'
import {
  enterFullscreen,
  fullscreenAvailable,
  fullscreenJustLeft,
  fullscreenOn,
  hostPlayers,
  leaveFullscreen,
  NOT_FULLSCREEN,
  onFullscreenChange,
} from './fullscreen'
import { api, displayKey, type Id, note, refusal } from './lib'
import { useLiveState } from './live'
import {
  allow,
  askPerson,
  browserWillAsk,
  cameraVideoOf,
  cannotOpen,
  grantFor,
  grantsOf,
  type Hearing,
  kindsSaid,
  microphoneAudioOf,
  type Opened,
  openCamera,
  openMicrophone,
  shoot,
  usedNow,
  whileTheBrowserAsks,
} from './media'
import { noteLost, onItsWay, outcomeOf, SENDING_TOO_MUCH, type Sent, settled, submit } from './outbox'
import { reportPage } from './presence'

type Phase = { is: 'loading' } | { is: 'shown' } | { is: 'failed'; why: string }
const REMOUNT_EVERY_MS = 10_000
/** A page that asks for more than this is told to slow down, without the backend hearing of it. */
const BURST = 20
const PER_SECOND = 5
/**
 * What it sends as actions is counted apart, and allowed more than a person clicks at their
 * fastest, so that only a page sending by itself meets it.
 */
const ACTION_BURST = 60
const ACTION_PER_SECOND = 15
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
  /**
   * How many loads of the page's frame the site had seen when it was asked for, counted from the
   * first: it may see none after that. A document's own load can reach the site before its hello or
   * after it, and also before or after what it asks for, so no load that comes after the asking can
   * be told from the next document's, and every one ends it. Nothing the page says moves it.
   */
  loads: number
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
  /** The layer over the page's frame that players and maps from the providers on It's list are hosted in. */
  const layer = useRef<HTMLDivElement>(null)
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
  /** The showing's word that the page has another owner now: what is open or is asked for it under the one before is let go. */
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
    let actionTokens = ACTION_BURST
    let actionFilled = Date.now()
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
    // The players and maps of the document the frame shows now, which go when it does
    const embeds = layer.current
      ? new EmbedLayer(
          layer.current,
          () => frame.current,
          (message) => port.current && toPage(port.current, message),
        )
      : null
    // A player's own fullscreen button makes It fullscreen, with that player over the page under the bar (fullscreen.ts)
    const unhost = embeds ? hostPlayers(embeds) : null

    // The microphone and the camera (media.ts). The site opens them for the page when the page
    // calls for one, and only once the person at this screen has allowed it.
    // A call is the page's only if it came over the channel of the document the frame shows now.
    // What the person said no to is not asked again in this showing.
    let question: { cancel: () => void } | null = null
    let photo: { cancel: () => void } | null = null
    /**
     * What is being opened, the microphone, the camera or a photo's camera, while the person or the
     * browser is asked and nothing is open yet to say so. Each beginning is its own, so that one let
     * go of when its document went does not hold back what the next document asks for.
     */
    let beginning: object | null = null
    /** Stops the microphone or the live camera that is being made ready, before anything else holds it, and what it may see of the frame's loads. */
    let starting: { stop: () => void; loads: number } | null = null
    /** The requests for the microphone and the camera that have not been answered yet, each with its channel and the page's id for it. */
    const unanswered = new Map<object, { from: MessagePort; requestId: string }>()
    /** A question taken away because the document that asked is gone: its going is not the person's no. */
    let letGo: unknown = null
    /** Which document the frame shows now, counted from the first: one that loads in its place is another, and what the one before began or asked for is not its. */
    let docs = 0
    /** How many times a document has loaded in the frame, as the browser tells the site. */
    let loads = 0
    // Each thing done for the page is held to the conversation the page had when it was asked for:
    // what the person allowed is that one's, and no other's. Each keeps its own, so that something
    // asked for later, under another conversation, cannot stand in for what an earlier one began with.
    /** Whose the question the person is being asked about is, and whose the camera open for a photo. */
    let questionBy = ''
    let photoBy = ''
    /** The most loads of the frame the question and the camera open for a photo may see, as `Held.loads` says. */
    let questionLoads = -1
    let photoLoads = -1
    const OWNER_MOVED =
      'Another conversation took this page over, so It stopped what it was doing for it. The person is asked again for the conversation that has it now.'
    const TAKEN_BACK = 'The person took back what they had allowed this page.'
    const HIDDEN = 'The screen stopped showing the page, so It closed the camera, and took no photo.'
    /**
     * Why what is being done for the page may not go on, or nothing where it may: the page is
     * closed, the document that asked for it is no longer the one in the frame, the page has another
     * owner, or what was allowed was taken back.
     */
    const whyNot = (kinds: MediaKind[], by: Held): 'not_shown' | 'replaced' | 'taken_over' | 'taken_back' | null =>
      !live
        ? 'not_shown'
        : by.doc !== docs || loads > by.loads
          ? 'replaced'
          : (maker.current?.owner ?? '') !== by.owner
            ? 'taken_over'
            : grantFor(user, artifactId, by.owner, kinds) !== by.grant
              ? 'taken_back'
              : null
    const SAID = {
      not_shown: 'The page was closed.',
      replaced: 'The page loaded another document, which asks for itself.',
      taken_over: OWNER_MOVED,
      taken_back: TAKEN_BACK,
    } as const
    /** The same for what the document on this channel began: nothing is the page's once the channel is not the one in use. */
    const whyNotOn = (from: MessagePort, kinds: MediaKind[], by: Held) => (!live ? 'not_shown' : port.current !== from ? 'replaced' : whyNot(kinds, by))
    /** The same, in words for the page. */
    const mayNotGoOn = (kinds: MediaKind[], by: Held): string | null => {
      const why = whyNot(kinds, by)
      return why ? SAID[why] : null
    }
    /**
     * What a device being made ready (media.ts `starting`) is given to say how it can be stopped:
     * its own, and never another's that began since, with what it may see of the frame's loads.
     */
    const startingFor = (h: Held) => {
      let startedBy: (() => void) | null = null
      return (stop: (() => void) | null) => {
        if (stop) starting = { stop, loads: h.loads }
        else if (starting?.stop === startedBy) starting = null
        startedBy = stop ?? startedBy
      }
    }
    // The camera live to the page (media.ts `openCamera`): held to the conversation and the grant
    // it was opened under, and each picture, and each piece of its sound, checked as it goes
    let camera: Opened | null = null
    /** The id the page names its live camera by, what it was opened under, and whether it was opened with sound. */
    let cameraId = ''
    let cameraBy: Held = { owner: '', grant: '', doc: -1, loads: -1 }
    let cameraSound = false
    // And the microphone live to it (media.ts `openMicrophone`), held in the same way
    let microphone: Hearing | null = null
    let microphoneId = ''
    let microphoneBy: Held = { owner: '', grant: '', doc: -1, loads: -1 }
    const CAMERA_LIVE =
      'The camera is live to this page just now, so It takes no photo for it. The page can take its own picture from cam.onframe or cam.stream, or stop the camera first.'
    const NO_PHOTO_BESIDE =
      'The microphone is live to this page just now, so It takes no photo for it. Stop the microphone first, or open the camera live with It.camera() and take the picture from cam.onframe.'
    const MICROPHONE_LIVE =
      'The microphone is live to this page already, so the camera is not opened with sound beside it. Open the camera without sound and use mic.stream for the sound, or stop the microphone first.'
    const CAMERA_HAS_IT =
      'The microphone is live to this page already, with its camera, and its sound is in cam.stream. Stop the camera before the microphone is opened by itself.'
    // Another conversation took the page over: whatever is open, is asked for or is open for a
    // photo under the one before closes. The person allowed that conversation, and the new one
    // has to be allowed for itself.
    ownerMoved.current = (owner) => {
      // A no from the person was about the conversation before: the one that has the page now is asked for itself
      refused.current = false
      if (question && questionBy !== owner) question.cancel()
      if (photo && photoBy !== owner) photo.cancel()
      if (camera && cameraBy.owner !== owner) camera.end('taken_over')
      if (microphone && microphoneBy.owner !== owner) microphone.end('taken_over')
    }
    /**
     * Leaves the frame in It's own place while the microphone or the camera is asked about, is live
     * or is open for a photo: a frame that fills the screen would hide It's bar, which asks, says
     * what is live, and has the buttons that stop it and take the photo.
     */
    const inSight = () => {
      if ((beginning || photo || camera || microphone) && document.fullscreenElement && document.fullscreenElement === frame.current)
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
      const cannot = cannotOpen()
      if (cannot) throw new Error(cannot)
      const doc = docs
      const most = loads
      // While the frame is being asked which document it holds, the channel may be held by a document
      // that is no longer there, or by a window it handed the channel to. What came over it is looked
      // at once the frame has answered, and refused where the document went meanwhile.
      while (asking) await new Promise<void>((answered) => untilAnswered.push(answered))
      if (!live) throw new Error('The page was closed.')
      if (doc !== docs || loads > most) throw new Error(SAID.replaced)
      // Nothing is begun for a page the screen does not show, where It's bar, which says what is live, cannot be seen
      if (document.visibilityState === 'hidden')
        throw new Error('It uses the microphone and the camera for a page only while this screen shows it. Ask again once the page is in front.')
      const by = maker.current
      const owner = by?.owner ?? ''
      const already = grantFor(user, artifactId, owner, kinds)
      if (already) {
        usedNow(user, artifactId)
        return { owner, grant: already, doc, loads: most }
      }
      if (refused.current) throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      // Asked only of someone who has the page in front of them: a window behind another, shown or not, is not asked from
      if (!document.hasFocus())
        throw new Error('It asks the person only while the page is in front, in the window they are using. Ask again from something they do on the page.')
      // What this call wants beyond what the page is allowed already, which stays as it is
      const had = grantsOf(user).find((g) => g.page === artifactId && g.owner === owner)
      const lacking = kinds.filter((k) => !had?.kinds.includes(k))
      const asked = askPerson({ page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, kinds: lacking })
      question = asked
      questionBy = owner
      questionLoads = most
      const yes = await asked.answer
      if (question === asked) question = null
      if (!live) throw new Error('The page was closed.')
      if (letGo === asked) throw new Error(SAID.replaced)
      // Taken over while the person was asked: what they answered was about the conversation before
      if ((maker.current?.owner ?? '') !== owner) throw new Error(OWNER_MOVED)
      if (!yes) {
        refused.current = true
        throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      }
      if (doc !== docs) throw new Error(SAID.replaced)
      allow(user, { page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, owner, kinds: lacking })
      const grant = grantFor(user, artifactId, owner, kinds)
      if (!grant) throw new Error(TAKEN_BACK)
      return { owner, grant, doc, loads: most }
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
        // Asked again before the browser is asked for the device: the page may have changed while It asked what the browser would ask
        const not = whyNot(kinds, held)
        if (not) throw new Error(SAID[not])
        return { held, got: await get(held) }
      } catch (err) {
        throw deviceRefused(err)
      } finally {
        shown?.()
      }
    }
    /** What the browser said when it would not give the device, in words for the page and the person. */
    const deviceRefused = (err: unknown): Error => {
      // Let go of by the site as it opened (media.ts), for a reason said in the site's own words
      const why = (err as { why?: unknown } | null)?.why
      if (typeof why === 'string' && why in SAID) return new Error(SAID[why as keyof typeof SAID])
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError')
        return new Error('The browser did not let It use that on this screen. Allow it for It’s site in the browser’s settings, and try again.')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('This screen has no microphone or camera that does what was asked.')
      if (name === 'NotReadableError' || name === 'AbortError') return new Error('The microphone or the camera is in use by something else on this screen.')
      return err instanceof Error ? err : new Error('It could not open the microphone or the camera.')
    }
    const onMedia = async (
      from: MessagePort,
      message: Extract<PageToSite, { type: 'it:photo' | 'it:camera' | 'it:camera-stop' | 'it:microphone' | 'it:microphone-stop' }>,
    ) => {
      if (message.type === 'it:camera-stop') {
        if (!camera || cameraId !== message.camera) throw new Error('That camera is not open.')
        camera.stop()
        camera = null
        return {}
      }
      if (message.type === 'it:microphone-stop') {
        if (!microphone || microphoneId !== message.microphone) throw new Error('That microphone is not open.')
        microphone.stop()
        microphone = null
        return {}
      }
      // The camera and the microphone are each open to a page once at most, and each is opened,
      // allowed, ended and stopped by itself. A camera opened with sound has the microphone too
      const withSound = message.type === 'it:camera' && message.audio !== undefined && message.audio !== null && message.audio !== false
      if (message.type === 'it:camera') {
        if (camera) throw new Error('The camera is live to this page already. Stop it before it is opened again.')
        if (microphone && withSound) throw new Error(MICROPHONE_LIVE)
      } else if (message.type === 'it:microphone') {
        if (microphone) throw new Error('The microphone is live to this page already. Stop it before it is opened again.')
        if (camera && cameraSound) throw new Error(CAMERA_HAS_IT)
      } else if (camera) throw new Error(CAMERA_LIVE)
      else if (microphone) throw new Error(NO_PHOTO_BESIDE)
      if (photo) throw new Error('It’s view of the camera is open for a photo for this page. Take the photo or close it first.')
      if (beginning || question) throw new Error('This page is asking for the microphone or the camera already. Wait for its answer first.')
      // Taken at once, before anything is waited for: a second asking that arrives while the
      // person or the browser is asked about the first is refused, and is not begun beside it
      const mine = {}
      beginning = mine
      // And It's bar is seen, which asks and says what is live
      inSight()
      try {
        if (message.type === 'it:camera') return await openLive(from, message)
        if (message.type === 'it:microphone') return await openSound(from, message)
        return await takePhoto(message, mine)
      } finally {
        if (beginning === mine) beginning = null
      }
    }
    const takePhoto = async (message: Extract<PageToSite, { type: 'it:photo' }>, mine: object) => {
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
      photoLoads = held.loads
      // Nothing more is being begun: what is open now is the person's to finish
      if (beginning === mine) beginning = null
      inSight()
      const made = await taking.photo
      photo = null
      // And again before the photo is handed over: one taken as the camera was being closed for any of these is not the page's
      const after = mayNotGoOn(['camera'], held)
      if (after) throw new Error(after)
      if (!made) throw new Error(document.visibilityState === 'hidden' ? HIDDEN : 'The person closed the camera without taking a photo.')
      return { file: made }
    }
    const openLive = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:camera' }>) => {
      const video = cameraVideoOf(message.video)
      // With sound where the page asks for it, which is the microphone's, and is allowed with the camera
      const audio = message.audio === undefined || message.audio === null || message.audio === false ? false : microphoneAudioOf(message.audio, 'It.camera')
      const kinds: MediaKind[] = audio ? ['mic', 'camera'] : ['camera']
      // The page names the camera itself, so that a picture that comes before the answer is one it knows
      const id = typeof message.camera === 'string' ? message.camera.slice(0, 100) : ''
      if (!id) throw new Error('A live camera needs an id to be named by.')
      /** The camera this opens, once it is open: what the end it is told of is compared with. */
      let mine: Opened | null = null
      // Allowed as a photo is, and It's bar says which page the browser asks about, where it asks
      const { held, got: opened } = await withDevice(kinds, (h) =>
        openCamera(video, audio, {
          id: crypto.getRandomValues(new Uint32Array(2)).join('-'),
          user,
          page: artifactId,
          owner: h.owner,
          grant: h.grant,
          title: titled.current,
          // The camera is the page's only while the document that opened it is shown, the page has
          // the conversation the person allowed, and what it was allowed under stands: asked as each
          // picture goes, and every second besides, and not only when the camera was opened
          still: () => whyNotOn(from, kinds, h),
          starting: startingFor(h),
          picture: (frame, picture) => from.postMessage({ type: 'it:camera-frame', camera: id, frame, picture } satisfies SiteToPage, [picture]),
          sound: (chunk, sampleRate, samples) =>
            from.postMessage({ type: 'it:microphone-sound', microphone: id, chunk, sampleRate, samples } satisfies SiteToPage, [samples.buffer]),
          told: (state, why) => {
            if (state === 'ended' && camera !== null && camera === mine) camera = null
            if (live && port.current === from) toPage(from, { type: 'it:camera-state', camera: id, state, ...(why ? { why } : {}) })
          },
        }),
      )
      mine = opened
      // The page was closed, loaded another document, was taken over, or what it was allowed was
      // taken back while the browser was asked: the camera is closed again at once
      const not = whyNotOn(from, kinds, held)
      const cannot = not ? SAID[not] : null
      if (cannot) {
        opened.stop()
        throw new Error(cannot)
      }
      camera = opened
      cameraId = id
      cameraBy = held
      cameraSound = audio !== false
      // An open camera is the page using what it was allowed: noted as it opens, and every hour while it is open (media.ts)
      usedNow(user, artifactId)
      // And a frame that fills the screen is put back in its place, where It's bar says the camera is live
      inSight()
      return opened.sampleRate ? { sound: { sampleRate: opened.sampleRate } } : {}
    }
    const openSound = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:microphone' }>) => {
      const audio = microphoneAudioOf(message.audio)
      // The page names the microphone itself, so that sound that comes before the answer is sound it knows
      const id = typeof message.microphone === 'string' ? message.microphone.slice(0, 100) : ''
      if (!id) throw new Error('A live microphone needs an id to be named by.')
      /** The microphone this opens, once it is open: what the end it is told of is compared with. */
      let mine: Hearing | null = null
      // Allowed as the camera is, and It's bar says which page the browser asks about, where it asks
      const { held, got: opened } = await withDevice(['mic'], (h) =>
        openMicrophone(audio, {
          id: crypto.getRandomValues(new Uint32Array(2)).join('-'),
          user,
          page: artifactId,
          owner: h.owner,
          grant: h.grant,
          title: titled.current,
          // The microphone is the page's only while the document that opened it is shown, the page
          // has the conversation the person allowed, and what it was allowed under stands: asked as
          // each piece of sound goes, and every second besides, and not only when it was opened
          still: () => whyNotOn(from, ['mic'], h),
          starting: startingFor(h),
          sound: (chunk, sampleRate, samples) =>
            from.postMessage({ type: 'it:microphone-sound', microphone: id, chunk, sampleRate, samples } satisfies SiteToPage, [samples.buffer]),
          told: (state, why) => {
            if (state === 'ended' && microphone !== null && microphone === mine) microphone = null
            if (live && port.current === from) toPage(from, { type: 'it:microphone-state', microphone: id, state, ...(why ? { why } : {}) })
          },
        }),
      )
      mine = opened
      // The page was closed, loaded another document, was taken over, or what it was allowed was
      // taken back while the browser was asked: the microphone is closed again at once
      const not = whyNotOn(from, ['mic'], held)
      const cannot = not ? SAID[not] : null
      if (cannot) {
        opened.stop()
        throw new Error(cannot)
      }
      microphone = opened
      microphoneId = id
      microphoneBy = held
      // An open microphone is the page using what it was allowed: noted as it opens, and every hour while it is open (media.ts)
      usedNow(user, artifactId)
      // And a frame that fills the screen is put back in its place, where It's bar says the microphone is live
      inSight()
      return { sound: { sampleRate: opened.sampleRate } }
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
    const actionAllowed = () => {
      const now = Date.now()
      actionTokens = Math.min(ACTION_BURST, actionTokens + (Math.max(0, now - actionFilled) / 1000) * ACTION_PER_SECOND)
      actionFilled = now
      if (actionTokens < 1) return false
      actionTokens -= 1
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
    // Every action this showing was sent, by the id the page gave it, with what became of it: on
    // its way, with the channel waiting to be told; left in the browser's outbox, to be sent from
    // there; accepted; refused; or ended with that not known here. A document that lost its channel
    // sends each action that was on its way again over its next one, as it was and marked as sent
    // again. That is never sent to It from here, under any deadline: it is the same action, and is
    // only told what became of the one already sent. It waits for one on its way, or for the outbox
    // to be done with it, and is told the action accepted or why it was refused; and where what
    // became of it is not known here, it is told so. None of it costs the page what new actions
    // cost it, since none of it is new. An action sent again that this showing does not know, as
    // one whose channel closed before it arrived, or one sent under another showing, is told that
    // It cannot tell whether it was done, and nothing is sent for it: whatever sent it first may
    // have sent it, and only the person can tell.
    type Known =
      | { is: 'going'; waiting: MessagePort; done: Promise<{ actionId: string }> }
      | { is: 'outbox' }
      | { is: 'accepted'; actionId: string }
      | { is: 'refused'; error: string }
      /** With what It said, for a refusal for now, to the page waiting on it then, and only to that page. */
      | { is: 'unsure'; now?: string }
    const ledger = new Map<string, Known>()
    /** Whether the ledger has let go of an action, having been sent more than it keeps: an action sent again that it does not know may then be one of those. */
    let forgot = false
    const LEDGER_MOST = 5000
    const UNKNOWN =
      'It cannot tell whether this was done: the page lost its channel to It while it was on its way, and what became of it is not known here. Check what your agent received before sending it again.'
    const noted = (id: string, known: Known) => {
      ledger.delete(id)
      ledger.set(id, known)
      if (ledger.size <= LEDGER_MOST) return
      const oldest = ledger.keys().next().value
      if (oldest !== undefined) ledger.delete(oldest)
      forgot = true
    }
    /** What became of an action this showing already has, for a page that sent it again. Nothing is sent to It for it. */
    const whatBecameOf = async (id: string, from: MessagePort): Promise<{ actionId: string }> => {
      for (;;) {
        const known = ledger.get(id)
        if (!known || known.is === 'unsure') throw new Error(UNKNOWN)
        if (known.is === 'accepted') return { actionId: known.actionId }
        if (known.is === 'refused') throw new Error(known.error)
        if (known.is === 'going') {
          // Told what becomes of the one on its way, over this channel now
          known.waiting = from
          try {
            return await known.done
          } catch {
            // What became of it is in the ledger by now. A refusal for now is told to this page, which
            // was waiting on it, as it would have been to the page that sent it
            const after = ledger.get(id)
            if (after === known) throw new Error(UNKNOWN)
            if (after?.is === 'unsure' && after.now) throw new Error(after.now)
            continue
          }
        }
        // Left in the outbox, which sends it under the deadline it was first given: waited for while it holds it
        while (live && onItsWay(user, artifactId, id)) await new Promise((resolve) => setTimeout(resolve, 1000))
        if (!live) throw new Error(UNKNOWN)
        if (ledger.get(id) !== known) continue
        const how = outcomeOf(user, artifactId, id)
        noted(id, how === undefined ? { is: 'unsure' } : 'actionId' in how ? { is: 'accepted', actionId: how.actionId } : { is: 'refused', error: how.refused })
      }
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
      // Only the channel of the document the frame shows now is heard: one whose document is gone was closed, and nothing on it is taken
      if (!message || typeof message !== 'object' || from !== port.current) return
      if (embeds?.take(message)) return
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
      if (message.type === 'it:microphone-heard') {
        // Never answered, and not counted against what the page may send: they come as fast as the sound does.
        // Of a live microphone, or of the sound of a camera opened with it, by the name the page gave each
        if (typeof message.chunk !== 'number') return
        if (microphone && message.microphone === microphoneId) microphone.heard(message.chunk)
        else if (camera && message.microphone === cameraId) camera.heard(message.chunk)
        return
      }
      if (
        message.type === 'it:photo' ||
        message.type === 'it:camera' ||
        message.type === 'it:camera-stop' ||
        message.type === 'it:microphone' ||
        message.type === 'it:microphone-stop'
      ) {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : ''
        // Answered once: here, or by `documentGone` before it closes the channel
        const asked = {}
        unanswered.set(asked, { from, requestId })
        try {
          // Stopping is never refused for asking too often: a page that cannot stop would go on with what it has open
          if (message.type !== 'it:camera-stop' && message.type !== 'it:microphone-stop' && !allowed())
            throw new Error('This page is sending too much at once. Try again in a moment.')
          const result = await onMedia(from, message)
          if (unanswered.delete(asked)) toPage(from, { type: 'it:result', requestId, ok: true, ...result })
        } catch (err) {
          if (unanswered.delete(asked))
            toPage(from, {
              type: 'it:result',
              requestId,
              ok: false,
              error: err instanceof Error ? err.message.slice(0, 500) : 'It could not open the microphone or the camera.',
            })
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
      /** Whether the page asks what became of an action it sent before, rather than sending a new one. */
      let askedAgain = false
      try {
        // An action the page sends again is not new, and is never refused for coming too fast
        const known =
          message.type === 'it:action' ? ledger.get(typeof message.envelope?.clientActionId === 'string' ? message.envelope.clientActionId : '') : undefined
        const again = message.type === 'it:action' && message.again === true
        askedAgain = known !== undefined || again
        if (message.type === 'it:action' && !known && !(again && forgot) && !actionAllowed()) throw new Error(SENDING_TOO_MUCH)
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
          const id = envelope.clientActionId
          let done: { actionId: string }
          if (known || again) done = await whatBecameOf(id, from)
          else {
            const one: Known & { is: 'going' } = { is: 'going', waiting: from, done: Promise.resolve({ actionId: '' }) }
            // The document that sent it is there to be told only while the channel waiting for its answer is the one in use
            const there = () => live && port.current !== null && one.waiting === port.current
            one.done = (async () => {
              try {
                const accepted = await submit(convex, user, artifactId, envelope, there, typeof was === 'function' ? was : undefined, files)
                if (ledger.get(id) === one) noted(id, { is: 'accepted', actionId: accepted.actionId })
                return accepted
              } catch (err) {
                // Kept in the outbox, which sends it again by itself; or refused by It for good, and not to be sent
                // again by anyone; or neither, as for a refusal for now that the page was there to be told of,
                // and what became of it is not known here to anyone who asks again
                const answered = err instanceof Error && 'data' in err
                if (ledger.get(id) === one)
                  noted(
                    id,
                    onItsWay(user, artifactId, id)
                      ? { is: 'outbox' }
                      : settled(err)
                        ? { is: 'refused', error: refusal(err).message }
                        : { is: 'unsure', ...(answered ? { now: refusal(err).message } : {}) },
                  )
                throw err
              }
            })()
            noted(id, one)
            done = await one.done
          }
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
        // A click refused, whatever refused it, is said in the page's bar too, once: not again
        // when the page asks what became of one it sent before, which was said then if it was lost
        if (message.type === 'it:action' && !askedAgain) noteLost(user, artifactId, err)
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

    // Which document the frame shows. Neither a hello nor holding the channel says that: a page can
    // say hello for a name of its choosing, hand its channel to another window, and then take its
    // frame to a document that says nothing, as `about:blank` is. So each time a document has
    // loaded in the frame, which the site hears from the frame itself whatever the document is,
    // the frame's own window is asked whether it holds the document the channel was made for,
    // with a value made for that asking. Only that window can be answered from, and only a
    // document there can have been asked. Until it answers, no click reaches a player.
    //
    // That answer means something only for the first document to load after the hello: until then
    // the document that said hello may still be loading, and the load may be its own. Once one has
    // answered for a load that came after the hello, that document's own load is behind it, and the
    // next document to load in the frame is another one, whatever it answers. So the channel, and
    // everything begun over it, ends then without asking: a page cannot keep the camera, the
    // microphone or its players by having the next document answer with the name the first one said.
    //
    // A document says hello before it has loaded, but the two reach the site separately, and on a
    // slower machine its load can come first. So a load that no document has answered for since
    // may be the load of the next document to say hello, and that document is taken to have loaded.
    let asking: { nonce: string; timer: ReturnType<typeof setTimeout>; afterHello: boolean } | null = null
    /** The document the channel was made for has loaded, or may have: the next load is another document. */
    let onItsLoad = false
    /** A document has loaded in the frame that has not answered as the one on the channel: it may be the next one to say hello. */
    let unclaimed = false
    /** What the page asked of the microphone and the camera while the frame was being asked, waiting for the asking to end. */
    const untilAnswered: (() => void)[] = []
    /** The frame is no longer being asked, whether it answered or the document is taken to be gone. */
    const doneAsking = () => {
      clearTimeout(asking?.timer)
      asking = null
      for (const go of untilAnswered.splice(0)) go()
    }
    /**
     * The document the channel was made for is gone. Its channel is closed, so that whatever holds
     * the other end now is heard no more, and everything it began here ends with it: its players
     * and maps, and what it asked of the microphone and the camera or began with them. This is the
     * one place that ends what a document began, whether it was replaced by one that said hello or
     * by one that did not answer.
     */
    const documentGone = () => {
      const was = port.current
      // What it opened with the microphone and the camera ends first, while the channel is still
      // open to say why to whatever holds it, and closes now, and not at a picture or a piece of
      // sound that a page which stopped taking them would never be sent.
      camera?.end('replaced')
      camera = null
      microphone?.end('replaced')
      microphone = null
      starting?.stop()
      // What it asked for and was not answered yet is answered now, while the channel can still carry it
      for (const [asked, { from, requestId }] of unanswered)
        if (from === was) {
          unanswered.delete(asked)
          toPage(from, { type: 'it:result', requestId, ok: false, error: SAID.replaced })
        }
      // And what it is beginning holds nothing back from the next document
      beginning = null
      was?.close()
      port.current = null
      onItsLoad = false
      embeds?.clear()
      // And what it asked of the microphone and the camera: the next document asks for itself
      docs += 1
      if (question) {
        letGo = question
        question.cancel()
      }
      photo?.cancel()
    }
    /** Asks the frame which document it holds now. `afterHello`: asked for a load that came after the channel's document said hello. */
    const askWho = (afterHello: boolean) => {
      const inside = frame.current?.contentWindow
      if (!inside) return
      clearTimeout(asking?.timer)
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
      embeds?.hold()
      asking = {
        nonce,
        afterHello,
        timer: setTimeout(() => {
          doneAsking()
          documentGone()
          embeds?.release()
          // A document of It's that was only slow to answer asks for a channel again when it hears this
          frame.current?.contentWindow?.postMessage({ type: 'it:gone' }, '*')
        }, WHO_MS),
      }
      inside.postMessage({ type: 'it:who', nonce }, '*')
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
      if (type === 'it:here') {
        const said = e.data as { nonce?: unknown; doc?: unknown }
        if (asking && said.nonce === asking.nonce && typeof said.doc === 'string' && said.doc === answered && port.current) {
          if (asking.afterHello) {
            onItsLoad = true
            unclaimed = false
          }
          doneAsking()
          embeds?.release()
        }
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
        // Another document, or one that lost its channel: what the one on the channel began ends whether or not a channel is given now
        if (!allowed()) {
          if (port.current) documentGone()
          return
        }
        answered = doc
        documentGone()
        const channel = new MessageChannel()
        port.current = channel.port1
        // Its load may have reached the site before its hello did
        onItsLoad = unclaimed
        unclaimed = false
        channel.port1.onmessage = (m) => void fromPage(channel.port1, m.data as PageToSite)
        // Sent to whatever document the page has put in its frame. The channel is for this one
        // showing, and gives a document there nothing the page did not already have.
        // With what the site does for a page beyond what every site has done: a page's script does none of these where a site does not say so, as one open since before It was updated does not
        ;(e.source as Window).postMessage({ type: 'it:port', v: CHANNEL_VERSION, embeds: embeds !== null, media: true, sound: true, opens: true }, '*', [
          channel.port2,
        ])
        const whole = liveState.whole()
        if (whole) toPage(channel.port1, whole)
        // A document that says hello while the frame is being asked is there to be asked again, as
        // the one this channel is for. Whether its own load is behind it was settled just now
        if (asking) askWho(false)
        // And whether It is fullscreen, which also tells the page that the site takes its asking for it
        toPage(channel.port1, fullscreenSaid())
      }
    }
    window.addEventListener('message', onMessage)

    /**
     * A document has loaded in the frame. What was begun or asked for is let go of where it has now
     * seen more loads than it may (`Held.loads`), whatever any document answers. Then the document is
     * another one where the channel's own has loaded already, or where the frame was being asked
     * about a load since the channel's hello and has not answered, and otherwise it is asked which.
     */
    const frameLoaded = () => {
      loads += 1
      unclaimed = true
      if (question && loads > questionLoads) {
        letGo = question
        question.cancel()
      }
      if (photo && loads > photoLoads) photo.cancel()
      if (camera && loads > cameraBy.loads) camera.end('replaced')
      if (microphone && loads > microphoneBy.loads) microphone.end('replaced')
      if (starting && loads > starting.loads) starting.stop()
      if (port.current && (onItsLoad || asking?.afterHello)) {
        doneAsking()
        embeds?.release()
        documentGone()
        // A document of It's that the site took to have loaded when it had not, and which loads only
        // now, asks for a channel again when it hears this; any other document lets it go by
        frame.current?.contentWindow?.postMessage({ type: 'it:gone' }, '*')
      } else askWho(true)
    }
    const shown = frame.current
    shown?.addEventListener('load', frameLoaded)
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
      // A page that is no longer shown has nothing open, and is asked nothing
      document.removeEventListener('fullscreenchange', inSight)
      ownerMoved.current = null
      question?.cancel()
      photo?.cancel()
      camera?.end('not_shown')
      camera = null
      microphone?.end('not_shown')
      microphone = null
      shown?.removeEventListener('load', frameLoaded)
      doneAsking()
      unhost?.()
      embeds?.dispose()
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
      <div className="embeds" ref={layer} />
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
