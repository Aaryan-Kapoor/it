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
// this action for itself, with these files", and how much it may ask of the site is bounded
// here, before anything reaches the backend. The site never opens a file a page sent: it keeps
// and sends its bytes as they are.
import {
  contentPort,
  FAULT,
  fileMarker,
  isMediaKind,
  isStoreKey,
  LIMITS,
  MESSAGE,
  type MediaKind,
  type PageToSite,
  parseJson,
  SANDBOX,
  type SiteToPage,
} from '@it/protocol'
import { useConvex, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { askTwice } from './backend'
import { api, displayKey, type Id, note, refusal } from './lib'
import { allow, allowed as allowedHere, askPerson, type Begun, begin, cannotRecord, kindsOf, kindsSaid, shoot, specOf } from './media'
import { type Sent, submit } from './outbox'

type Phase = { is: 'loading' } | { is: 'shown' } | { is: 'failed'; why: string }
const REMOUNT_EVERY_MS = 10_000
/** A page that asks for more than this is told to slow down, without the backend hearing of it. */
const BURST = 20
const PER_SECOND = 5
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
/**
 * Where pages are shown from: the port after the site's own, on the machine the site itself was
 * reached at and by the same name, so that a page is reached wherever the site is.
 */
const pages = () => `${location.protocol}//${location.hostname}:${contentPort(Number(location.port) || (location.protocol === 'https:' ? 443 : 80))}`

/**
 * JSON text and nothing else: what crosses from a page is copied, so it cannot carry anything
 * live. Where `files` is given, a file the page put in it (a `File` or a `Blob`, which the
 * channel copies as the file it is) is taken out, put in `files`, and stands in the text as
 * which of them it is, counted from 1. The same file put in twice is one file.
 */
export function jsonText(value: unknown, max: number, files?: Blob[]): string {
  // Looked over before it is written out, within a fixed amount of work. What a page sends can
  // be a small thing that names the same piece many times over, level upon level, and writing
  // that out in full would take all the memory the site has.
  let looks = 20_000
  let letters = 0
  const look = (v: unknown, depth: number): void => {
    if (--looks < 0 || depth > 40) throw new Error('That is too large to send.')
    if (v instanceof Blob) {
      if (!files) throw new Error('A file cannot be kept with It.store. Send it with It.action, which takes files beside what it carries.')
      return
    }
    if (typeof v === 'string') letters += v.length
    else if (Array.isArray(v)) {
      // Its length is counted before anything is done with it: a list can be mostly holes
      if (v.length > looks) throw new Error('That is too large to send.')
      for (const x of v) look(x, depth + 1)
    } else if (v && typeof v === 'object') {
      // Only plain objects, which is all that JSON has. Anything else a page can send (a block
      // of bytes, a map, a date) could be enormous in ways that are only found by unpacking it.
      const kind = Object.getPrototypeOf(v)
      if (kind !== Object.prototype && kind !== null) throw new Error('That cannot be sent.')
      // One entry at a time, so the count applies as it goes
      for (const k in v) {
        if (!Object.hasOwn(v, k)) continue
        letters += k.length
        look((v as Record<string, unknown>)[k], depth + 1)
      }
    }
    if (letters > max) throw new Error('That is too large to send.')
  }
  look(value, 0)
  const numbered = new Map<Blob, number>()
  const text = JSON.stringify(
    value === undefined ? null : value,
    files
      ? (_key, v: unknown) => {
          if (!(v instanceof Blob)) return v
          if (!numbered.has(v)) numbered.set(v, files.push(v))
          return fileMarker(numbered.get(v)!)
        }
      : undefined,
  )
  if (typeof text !== 'string') throw new Error('That cannot be sent.')
  return text
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
  const [mount, setMount] = useState<{ address: string; mountId: string; version: number; media: MediaKind[] } | null>(null)
  const [phase, setPhase] = useState<Phase>({ is: 'loading' })
  /** The one channel to whatever document the frame is showing now. */
  const port = useRef<MessagePort | null>(null)
  /** These outlive a remount, so a page cannot reset them by asking to be shown again. */
  const lastRemount = useRef(0)
  const failures = useRef(0)
  /** Whoever is told of the page's faults now: kept apart from the channel, which is set up once for a showing. */
  const told = useRef(onFault)
  told.current = onFault
  /** Who made the page, as it is now: kept apart from the channel, as `told` is. */
  const maker = useRef(madeBy)
  maker.current = madeBy
  const titled = useRef(title)
  titled.current = title
  /** The version of the page whose agent this showing has told that its script failed: it is told once for a version. */
  const faulted = useRef<number | null>(null)
  const state = useQuery(api.state.get, { artifactId })
  const latest = useRef(state)
  latest.current = state
  const again = useCallback(() => setAttempt((n) => n + 1), [])

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
        // What the version shown asked to use of the screen: nothing, from functions older than that
        const media = ((m as { media?: unknown }).media ?? []) as unknown[]
        return { address: `${pages()}/open/${ticket}`, mountId: m.mountId, version: m.version, media: media.filter(isMediaKind) }
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
    // time, and only as the version shown asked for when it was published and the person at
    // this screen has allowed it. What the person said no to is not asked again in this showing.
    let recording: Begun | null = null
    let question: { cancel: () => void } | null = null
    let photo: { cancel: () => void } | null = null
    /** A recording or a photo is being begun: the person or the browser is being asked, and nothing is under way yet to say so. */
    let beginning = false
    let refused = false
    /** Leaves the frame in It's own place while it records: a frame that fills the screen would hide It's bar, which says that it is recording. */
    const inSight = () => {
      if (recording && document.fullscreenElement && document.fullscreenElement === frame.current) void document.exitFullscreen().catch(() => {})
    }
    document.addEventListener('fullscreenchange', inSight)
    /** Settles whether the page may use these here, asking the person where they have not said. Throws, in words for the page, where it may not. */
    const mayUse = async (kinds: MediaKind[]): Promise<void> => {
      const missing = kinds.filter((k) => !mount.media.includes(k))
      if (missing.length)
        throw new Error(
          `This page did not ask for ${kindsSaid(missing)} when it was published, so It does not record for it. Its agent publishes it again with --media ${[...new Set([...mount.media, ...kinds])].join(',')}.`,
        )
      const cannot = cannotRecord()
      if (cannot) throw new Error(cannot)
      const by = maker.current
      const owner = by?.owner ?? ''
      if (allowedHere(user, artifactId, owner, kinds)) return
      if (refused) throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      const asked = askPerson({ page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, kinds })
      question = asked
      const yes = await asked.answer
      question = null
      if (!live) throw new Error('The page was closed.')
      if (!yes) {
        refused = true
        throw new Error(`The person did not allow this page to use ${kindsSaid(kinds)} on this screen.`)
      }
      allow(user, { page: artifactId, title: titled.current, agent: by?.agent ?? null, machine: by?.machine ?? null, owner, kinds })
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
    const onMedia = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:record' | 'it:record-stop' | 'it:photo' }>) => {
      if (message.type === 'it:record-stop') {
        const was = recording
        if (!was || was.id !== message.recording) throw new Error('That recording is not under way.')
        recording = null
        const file = await was.stop(message.keep === true)
        return message.keep === true ? { file } : {}
      }
      if (beginning || recording || question || photo) throw new Error('This page is using the microphone or the camera already. Stop that first.')
      // Taken at once, before anything is waited for: a second asking that arrives while the
      // person or the browser is asked about the first is refused, and is not begun beside it
      beginning = true
      try {
        return message.type === 'it:photo' ? await takePhoto(message) : await beginRecording(from, message)
      } finally {
        beginning = false
      }
    }
    const takePhoto = async (message: Extract<PageToSite, { type: 'it:photo' }>) => {
      await mayUse(['camera'])
      const facing = message.facing === 'user' || message.facing === 'environment' ? message.facing : undefined
      let taking: Awaited<ReturnType<typeof shoot>>
      try {
        taking = await shoot({ page: artifactId, title: titled.current }, facing)
      } catch (err) {
        throw deviceRefused(err)
      }
      // The page was closed while the browser was asked: the camera is closed again at once
      if (!live) {
        taking.cancel()
        throw new Error('The page was closed.')
      }
      photo = taking
      // Nothing more is being begun: what is open now is the person's to finish
      beginning = false
      const made = await taking.photo
      photo = null
      if (!made) throw new Error('The person closed the camera without taking a photo.')
      return { file: made }
    }
    const beginRecording = async (from: MessagePort, message: Extract<PageToSite, { type: 'it:record' }>) => {
      const spec = specOf(message)
      await mayUse(kindsOf(spec))
      const id = crypto.getRandomValues(new Uint32Array(2)).join('-')
      const tell = (state: 'recording' | 'paused' | 'ended', why?: 'person' | 'taken_back' | 'not_shown' | 'device' | 'too_long', file?: Blob) => {
        if (state === 'ended' && recording?.id === id) recording = null
        if (live && port.current === from) toPage(from, { type: 'it:recording', recording: id, state, ...(why ? { why } : {}), ...(file ? { file } : {}) })
      }
      try {
        recording = await begin(spec, { id, user, page: artifactId, owner: maker.current?.owner ?? '', title: titled.current, told: tell })
      } catch (err) {
        throw deviceRefused(err)
      }
      // The page was closed, or what it was allowed was taken back, while the browser was asked:
      // nothing is recorded for a page that is gone, or that may not
      if (!live || !allowedHere(user, artifactId, maker.current?.owner ?? '', kindsOf(spec))) {
        void recording.stop(false)
        recording = null
        throw new Error(live ? 'The person took back what they had allowed this page.' : 'The page was closed.')
      }
      inSight()
      return { recording: { id, mimeType: recording.mimeType } }
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
    const fromPage = async (from: MessagePort, message: PageToSite) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'it:lapsed') {
        // The page's showing is over. Show it again, but not in a loop: one that is over so
        // soon after the last was begun is shown again when that while has passed. It is not
        // let go by, since a document says that its showing is over only once, and the page
        // would stay as it is with nothing under it to load from.
        const remount = () => {
          lastRemount.current = Date.now()
          again()
        }
        const wait = Math.min(lastRemount.current + REMOUNT_EVERY_MS - Date.now(), REMOUNT_EVERY_MS)
        if (wait < 0) remount()
        else later ??= setTimeout(remount, wait)
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
      if (message.type === 'it:record' || message.type === 'it:record-stop' || message.type === 'it:photo') {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : ''
        try {
          // Stopping is never refused for asking too often: a page that cannot stop would go on recording
          if (message.type !== 'it:record-stop' && !allowed()) throw new Error('This page is sending too much at once. Try again in a moment.')
          toPage(from, { type: 'it:result', requestId, ok: true, ...(await onMedia(from, message)) })
        } catch (err) {
          toPage(from, { type: 'it:result', requestId, ok: false, error: err instanceof Error ? err.message.slice(0, 500) : 'It could not record.' })
        }
        return
      }
      if (message.type !== 'it:action' && message.type !== 'it:store') return
      const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : ''
      try {
        if (!allowed()) throw new Error('This page is sending too much at once. Try again in a moment.')
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
          // The same rule the backend keeps, kept here so that nothing long is sent only to be refused
          if (!isStoreKey(message.key)) throw new Error('A store key is 1 to 64 letters, digits, dashes or underscores.')
          const value = jsonText(message.value, LIMITS.storeValueBytes)
          if (new TextEncoder().encode(value).length > LIMITS.storeValueBytes) throw new Error(`A stored value is at most ${LIMITS.storeValueBytes / 1024} KB.`)
          await convex.mutation(api.state.storeSet, { artifactId, key: message.key, value })
          toPage(from, { type: 'it:result', requestId, ok: true })
        }
      } catch (err) {
        const said = refusal(err)
        toPage(from, {
          type: 'it:result',
          requestId,
          ok: false,
          error: said.code === 'error' && err instanceof Error && !('data' in err) ? err.message : said.message,
        })
      }
    }

    const onMessage = (e: MessageEvent) => {
      // Only this frame. What is in it has no origin to be known by: the window it came from is what tells
      if (!live || e.source !== frame.current?.contentWindow) return
      const type = (e.data as { type?: unknown } | null)?.type
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
        port.current?.close()
        const channel = new MessageChannel()
        port.current = channel.port1
        channel.port1.onmessage = (m) => void fromPage(channel.port1, m.data as PageToSite)
        // Sent to whatever document the page has put in its frame. The channel is for this one
        // showing, and gives a document there nothing the page did not already have.
        ;(e.source as Window).postMessage({ type: 'it:port' }, '*', [channel.port2])
        const s = latest.current
        if (s) toPage(channel.port1, { type: 'it:state', state: parseJson(s.json) ?? {}, revision: s.revision })
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      live = false
      clearTimeout(timer)
      clearTimeout(later)
      clearInterval(looking)
      window.removeEventListener('message', onMessage)
      // A page that is no longer shown records nothing, and is asked nothing
      document.removeEventListener('fullscreenchange', inSight)
      question?.cancel()
      photo?.cancel()
      void recording?.stop(false)
      recording = null
      port.current?.close()
      port.current = null
    }
  }, [convex, artifactId, mount, user, again])

  // State flows down: every change goes to whatever the frame is showing now
  useEffect(() => {
    if (state && port.current) port.current.postMessage({ type: 'it:state', state: parseJson(state.json) ?? {}, revision: state.revision } satisfies SiteToPage)
  }, [state])

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
          // origin of its address, can never move this tab, and what it opens is held to the same
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
