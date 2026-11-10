// What the person sees of the microphone and the camera (media.ts), all of it inside It's own bar
// at the top of a page, and none of it over the page: the question It asks before a page may use
// them on this screen, what the browser is asking about where it asks itself, that a page records
// or has the camera live and the buttons that stop each, the small view of the camera for a photo,
// and the button that takes back what was allowed. Under Settings is what this screen has allowed, where it is taken
// back too.
import type { MediaKind } from '@it/protocol'
import { useEffect, useRef, useState } from 'react'
import { IconStop } from './brand'
import { ago, useNow } from './lib'
import {
  cameraFor,
  cannotRecord,
  dismissNote,
  endsAt,
  grantsOf,
  kindsSaid,
  type Live,
  type LiveCamera,
  liveFor,
  noteFor,
  takeBack,
  useAsking,
  useBrowserAsking,
  useMediaChanges,
  useShooting,
} from './media'

const IconMic = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
)
const IconCamera = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
)
const IconFor = ({ kinds }: { kinds: MediaKind[] }) => (kinds.includes('mic') ? <IconMic /> : <IconCamera />)

/** How long something has run, as minutes and seconds. */
const lasted = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** Who made a page, in a few words, for the person to know whose page is asking. */
const madeBy = (agent: string | null, machine: string | null): string => `${agent ?? 'An agent'}${machine ? ` on ${machine}` : ''}`
/** The kinds in as few words as the bar has room for. */
const kindsShort = (kinds: MediaKind[]): string =>
  kinds.includes('mic') && kinds.includes('camera') ? 'the mic and camera' : kinds.includes('camera') ? 'the camera' : 'the mic'
/** What a page wants, as the bar says it: in fewer words still on a phone, where the page's name, then this, has to fit beside the buttons. */
const Wants = ({ kinds, then = '' }: { kinds: MediaKind[]; then?: string }) => (
  <span className="media-bar-what">
    <span className="media-bar-long">
      &nbsp;wants {kindsShort(kinds)}
      {then}
    </span>
    <span className="media-bar-short" aria-hidden="true">
      &nbsp;wants {kindsShort(kinds).replace(/^the /, '')}
      {then}
    </span>
  </span>
)

/**
 * How long a button that gives a page something waits after it appears before it takes a press.
 * The bar is where the person's pointer often is, and a page can choose the moment it asks: a
 * press meant for what was there a moment before is not a yes.
 */
export const ARM_MS = 600
/** Whether a button that appeared for this has been there long enough to take a press. */
function useArmed(key: unknown): boolean {
  const [armedFor, setArmedFor] = useState<unknown>(null)
  useEffect(() => {
    const t = setTimeout(() => setArmedFor(() => key), ARM_MS)
    return () => clearTimeout(t)
  }, [key])
  return armedFor === key
}

/**
 * It's own question, in the bar, in place of the page's title while it is asked: the page, what
 * it wants, Allow and Not now. Who made the page, and how long a yes lasts, are said to whoever
 * points at it or reads the screen aloud. It is asked only where the browser will not ask itself.
 */
function Ask({ page }: { page: string }) {
  const asking = useAsking()
  const armed = useArmed(asking)
  if (!asking || asking.page !== page) return null
  // Allowed the camera, a page can see its picture live as well as record and take a photo: said here, since nothing more is asked later
  const gives = asking.kinds.includes('camera')
    ? 'With the camera it can record, take a photo, and see the camera’s picture live for as long as it keeps the camera open, and what it records or sees is the page’s to keep or to send anywhere.'
    : 'What it records is given to the page.'
  const detail = `${madeBy(asking.agent, asking.machine)} made this page. Allowed, it may use ${kindsSaid(asking.kinds)} on this screen until you take it back, here or under Settings, or until it goes 30 days without using it. ${gives}`
  return (
    <fieldset className="media-bar media-ask" aria-label={`“${asking.title}” asks to use ${kindsSaid(asking.kinds)} on this screen`} title={detail}>
      <span className="media-bar-icon">
        <IconFor kinds={asking.kinds} />
      </span>
      <span className="media-bar-text">
        <b className="media-bar-page">{asking.title}</b>
        <Wants kinds={asking.kinds} />
      </span>
      <span className="sr-only">{detail}</span>
      <button type="button" className="media-bar-btn primary" disabled={!armed} onClick={() => asking.answer(true)}>
        Allow
      </button>
      <button type="button" className="media-bar-btn" onClick={() => asking.answer(false)}>
        Not now
      </button>
    </fieldset>
  )
}

/** Where the browser asks about a page itself: which page its question is for. Nothing here answers it, and It asks nothing beside it. */
function BrowserAsks({ page }: { page: string }) {
  const asking = useBrowserAsking()
  if (!asking || asking.page !== page) return null
  return (
    <div className="media-bar media-waiting" role="status">
      <span className="media-bar-icon">
        <IconFor kinds={asking.kinds} />
      </span>
      <span className="media-bar-text">
        <b className="media-bar-page">{asking.title}</b>
        <Wants kinds={asking.kinds} then=" · answer your browser" />
      </span>
    </div>
  )
}

/** This browser's own clock, read again every second: a recording's start is this browser's moment, and not the backend's. */
function useTicking(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** A camera's picture, in a video element of It's own. */
function View({ stream, className, onView }: { stream: MediaStream; className: string; onView?: (v: HTMLVideoElement | null) => void }) {
  const view = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (view.current) view.current.srcObject = stream
  }, [stream])
  // Shown as in a mirror where the camera faces the person, as they expect to see themselves, and as it is where it faces away
  const away = stream.getVideoTracks()[0]?.getSettings().facingMode === 'environment'
  return (
    <video
      ref={(v) => {
        view.current = v
        onView?.(v)
      }}
      className={`${className}${away ? '' : ' media-view-mirrored'}`}
      autoPlay
      muted
      playsInline
    />
  )
}

/**
 * One recording under way, in the bar: a red dot, how long, and Stop, with the camera's picture
 * the size of the dot's row where the camera records, so that what is recorded is seen.
 */
function Recording({ l }: { l: Live }) {
  const now = useTicking()
  const time = lasted(now - l.since)
  const paused = l.state === 'paused'
  return (
    <span
      className="media-bar media-rec"
      data-state={l.state}
      role="status"
      aria-label={`${paused ? 'Paused' : 'Recording'} ${kindsSaid(l.kinds)} for “${l.title}”, ${time}`}
      title={`${paused ? 'Paused while the screen does not show It' : 'Recording'} ${kindsSaid(l.kinds)} for “${l.title}”`}
    >
      {l.kinds.includes('camera') && <View stream={l.stream} className="media-thumb" />}
      <span className="media-rec-dot" aria-hidden="true" />
      <span className="media-rec-time" aria-hidden="true">
        {time}
      </span>
      <button
        type="button"
        className="media-rec-stop"
        title="Stop recording. What was recorded is thrown away, and is not given to the page."
        aria-label="Stop recording"
        onClick={() => l.end('person')}
      >
        <IconStop />
        Stop
      </button>
    </span>
  )
}

/**
 * The camera live to a page, in the bar: a red dot, that the page sees the camera as it happens,
 * and Stop. No picture of the camera is shown here, since the page shows the picture itself.
 */
function CameraLive({ c }: { c: LiveCamera }) {
  const paused = c.state === 'paused'
  return (
    <span
      className="media-bar media-cam"
      data-state={c.state}
      role="status"
      aria-label={`The camera is ${paused ? 'paused' : 'live'} to “${c.title}”`}
      title={paused ? 'The camera is paused while the screen does not show It' : `The camera is live to “${c.title}”: the page sees its picture as it happens`}
    >
      <span className="media-cam-dot" aria-hidden="true" />
      <span className="media-cam-what" aria-hidden="true">
        Camera {paused ? 'paused' : 'live'}
      </span>
      <button
        type="button"
        className="media-cam-stop"
        title="Stop the camera. The page sees nothing more from it."
        aria-label="Stop the camera"
        onClick={() => c.end('person')}
      >
        <IconStop />
        Stop
      </button>
    </span>
  )
}

/**
 * A photo the page asked for, in the bar: Take and Cancel, and under them, hanging from the bar,
 * the camera's picture as small as a person can still aim by. The photo is taken at the size the
 * camera gives, whatever the size of this view.
 */
function Photo({ page }: { page: string }) {
  const shooting = useShooting()
  const armed = useArmed(shooting)
  const [view, setView] = useState<HTMLVideoElement | null>(null)
  if (!shooting || shooting.page !== page) return null
  return (
    <fieldset className="media-bar media-photo" aria-label={`Take a photo for “${shooting.title}”`}>
      <span className="media-bar-icon">
        <IconCamera />
      </span>
      <span className="media-bar-text">
        <span className="media-bar-what">Photo for&nbsp;</span>
        <b className="media-bar-page">{shooting.title}</b>
      </span>
      <button type="button" className="media-bar-btn primary" disabled={!armed} onClick={() => view && shooting.take(view)}>
        Take
      </button>
      <button type="button" className="media-bar-btn" onClick={shooting.close}>
        Cancel
      </button>
      <span className="media-photo-view">
        <View stream={shooting.stream} className="media-photo-video" onView={setView} />
      </span>
    </fieldset>
  )
}

/** What the bar says of a page's last recording where it stopped by itself at the most one file may be, until it is dismissed or the page records again. */
function Note({ page }: { page: string }) {
  const note = noteFor(page)
  if (!note) return null
  const long =
    note === 'kept'
      ? 'The recording stopped at 1 GB, the most one file sent with an action can be. What was recorded is kept, and was given to the page.'
      : 'The recording stopped: it grew past 1 GB, the most one file sent with an action can be, all at once, and nothing of it could be kept.'
  return (
    <span className="media-bar media-note" role="status" title={long}>
      <span className="media-bar-text">{note === 'kept' ? 'Stopped at 1 GB · kept' : 'Stopped past 1 GB · nothing kept'}</span>
      <span className="sr-only">{long}</span>
      <button type="button" className="media-bar-btn" onClick={() => dismissNote(page)}>
        OK
      </button>
    </span>
  )
}

/**
 * Everything about the microphone and the camera for the page shown, in It's bar, where nothing
 * on the page can cover it: It's question, or which page the browser is asking about, or the
 * photo being taken, or what records, or how the last recording stopped. The camera live to the
 * page is said beside whichever of those is shown, since it goes on all the while, a recording of
 * sound beside it among them.
 */
export function MediaBar({ page }: { page: string }) {
  useMediaChanges()
  const asking = useAsking()
  const browser = useBrowserAsking()
  const shooting = useShooting()
  const c = cameraFor(page)
  const l = liveFor(page)
  return (
    <>
      {c && <CameraLive c={c} />}
      {asking?.page === page ? (
        <Ask page={page} />
      ) : browser?.page === page ? (
        <BrowserAsks page={page} />
      ) : shooting?.page === page ? (
        <Photo page={page} />
      ) : l ? (
        <Recording l={l} />
      ) : (
        <Note page={page} />
      )}
    </>
  )
}

/**
 * Among the bar's buttons, where the page shown is allowed the microphone or the camera on this
 * screen: the button that takes that back, which asks once more in the bar itself before it does.
 */
export function MediaAllowed({ user, page, title }: { user: string; page: string; title: string }) {
  useMediaChanges()
  const [sure, setSure] = useState(false)
  const grant = grantsOf(user).find((g) => g.page === page)
  if (!grant || liveFor(page) || cameraFor(page)) return null
  if (sure)
    return (
      <fieldset className="media-bar media-takeback" aria-label={`Take back ${kindsSaid(grant.kinds)} from “${title}”?`}>
        <span className="media-bar-text">
          <span className="media-bar-what">Take back {kindsShort(grant.kinds)}?</span>
        </span>
        <button
          type="button"
          className="media-bar-btn danger"
          onClick={() => {
            setSure(false)
            takeBack(user, page)
          }}
        >
          Take back
        </button>
        <button type="button" className="media-bar-btn" onClick={() => setSure(false)}>
          Keep
        </button>
      </fieldset>
    )
  return (
    <button
      type="button"
      className="nav-action media-allowed"
      title={`“${title}” may use ${kindsSaid(grant.kinds)} on this screen. Press to take that back.`}
      aria-label={`Take back ${kindsSaid(grant.kinds)} from this page`}
      onClick={() => setSure(true)}
    >
      <IconFor kinds={grant.kinds} />
    </button>
  )
}

/** What this screen has allowed pages, under Settings, each with the button that takes it back. */
export function MediaGrants({ user }: { user: string }) {
  useMediaChanges()
  useNow()
  const grants = grantsOf(user)
  const cannot = cannotRecord()
  return (
    <section>
      <h3>Microphone and camera</h3>
      <ul className="rows panel">
        {grants.map((g) => (
          <li key={g.page} className="row">
            <span className="row-main">
              <span className="row-name">{g.title}</span>
              <span className="row-sub">{`May use ${kindsSaid(g.kinds)} on this screen. ${madeBy(g.agent, g.machine)} made it. Allowed ${ago(g.at, Date.now())}, and ends on ${new Date(endsAt(g)).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })} unless the page uses it before then.`}</span>
            </span>
            <span className="row-actions">
              <button type="button" onClick={() => takeBack(user, g.page)}>
                Take back
              </button>
            </span>
          </li>
        ))}
        {grants.length === 0 && (
          <li className="row">
            <span className="row-main">
              <span className="row-name">No page may use the microphone or the camera here</span>
              <span className="row-sub">A page that calls for one asks you first in its bar, and records only while It's bar says so.</span>
            </span>
          </li>
        )}
        {cannot && (
          <li className="row">
            <span className="row-main">
              <span className="row-sub">{cannot}</span>
            </span>
          </li>
        )}
      </ul>
    </section>
  )
}
