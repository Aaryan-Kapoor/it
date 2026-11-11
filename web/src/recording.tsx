// What the person sees of the microphone and the camera (media.ts), all of it inside It's own bar
// at the top of a page, and none of it over the page: the question It asks before a page may use
// them on this screen, what the browser is asking about where it asks itself, that a page has the
// camera or the microphone live and the button that stops each, the small view of the camera for
// a photo, and the button that takes back what was allowed. Under Settings is what this screen
// has allowed, where it is taken back too.
import type { MediaKind } from '@it/protocol'
import { useEffect, useRef, useState } from 'react'
import { IconStop } from './brand'
import { ago, useNow } from './lib'
import {
  cameraFor,
  cannotOpen,
  endsAt,
  grantsOf,
  kindsSaid,
  type LiveCamera,
  type LiveMicrophone,
  microphoneFor,
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
  // What a page allowed either can do with it, and that what it is given is its own: said here, since nothing more is asked later
  const gives = !asking.kinds.includes('camera')
    ? 'With the microphone it can hear the microphone live for as long as it keeps it open, and what it hears is the page’s to keep, to record or to send anywhere.'
    : !asking.kinds.includes('mic')
      ? 'With the camera it can take a photo, and see the camera’s picture live for as long as it keeps the camera open, and what it sees is the page’s to keep, to record or to send anywhere.'
      : 'With them it can take a photo, and see the camera’s picture and hear the microphone live for as long as it keeps them open, and what it sees or hears is the page’s to keep, to record or to send anywhere.'
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
 * The camera live to a page, in the bar: a red dot, that the page sees the camera as it happens,
 * and Stop. No picture of the camera is shown here, since the page shows the picture itself.
 * Opened with sound, it says that the microphone is live with it, and its Stop ends both. On a
 * phone, beside the microphone's own chip or a question, it says only "Cam".
 */
function CameraLive({ c }: { c: LiveCamera }) {
  const paused = c.state === 'paused'
  const sound = c.kinds.includes('mic')
  const what = sound ? 'The camera and the microphone are' : 'The camera is'
  return (
    <span
      className="media-bar media-live media-cam"
      data-state={c.state}
      role="status"
      aria-label={`${what} ${paused ? 'paused' : 'live'} to “${c.title}”`}
      title={
        paused
          ? `${what} paused while the screen does not show It`
          : `${what} live to “${c.title}”: the page sees the camera’s picture${sound ? ' and hears the microphone' : ''} as it happens`
      }
    >
      <span className="media-live-dot" aria-hidden="true" />
      <span className="media-live-what" data-short="Cam" aria-hidden="true">
        {sound ? 'Camera and mic' : 'Camera'} {paused ? 'paused' : 'live'}
      </span>
      <button
        type="button"
        className="media-live-stop"
        title={
          sound ? 'Stop the camera and the microphone. The page sees and hears nothing more from them.' : 'Stop the camera. The page sees nothing more from it.'
        }
        aria-label={sound ? 'Stop the camera and the microphone' : 'Stop the camera'}
        onClick={() => c.end('person')}
      >
        <IconStop />
        Stop
      </button>
    </span>
  )
}

/**
 * The microphone live to a page, in the bar: a red dot, that the page hears the microphone as it
 * happens, and Stop. On a phone, beside the camera's chip or a question, it says only "Mic".
 */
function MicLive({ m }: { m: LiveMicrophone }) {
  const paused = m.state === 'paused'
  return (
    <span
      className="media-bar media-live media-mic"
      data-state={m.state}
      role="status"
      aria-label={`The microphone is ${paused ? 'paused' : 'live'} to “${m.title}”`}
      title={paused ? 'The microphone is paused while the screen does not show It' : `The microphone is live to “${m.title}”: the page hears it as it happens`}
    >
      <span className="media-live-dot" aria-hidden="true" />
      <span className="media-live-what" data-short="Mic" aria-hidden="true">
        Mic {paused ? 'paused' : 'live'}
      </span>
      <button
        type="button"
        className="media-live-stop"
        title="Stop the microphone. The page hears nothing more from it."
        aria-label="Stop the microphone"
        onClick={() => m.end('person')}
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

/**
 * Everything about the microphone and the camera for the page shown, in It's bar, where nothing
 * on the page can cover it: It's question, or which page the browser is asking about, or the
 * photo being taken. The camera and the microphone live to the page are said beside whichever of
 * those is shown, since each goes on all the while: a page with the microphone live that asks for
 * the camera still shows that the microphone is live, with its Stop, while It asks.
 */
export function MediaBar({ page }: { page: string }) {
  useMediaChanges()
  const asking = useAsking()
  const browser = useBrowserAsking()
  const shooting = useShooting()
  const c = cameraFor(page)
  const m = microphoneFor(page)
  return (
    <>
      {c && <CameraLive c={c} />}
      {m && <MicLive m={m} />}
      {asking?.page === page ? (
        <Ask page={page} />
      ) : browser?.page === page ? (
        <BrowserAsks page={page} />
      ) : shooting?.page === page ? (
        <Photo page={page} />
      ) : null}
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
  if (!grant || cameraFor(page) || microphoneFor(page)) return null
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
  const cannot = cannotOpen()
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
              <span className="row-sub">A page that calls for one asks you first in its bar, and has it only while It's bar says so.</span>
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
