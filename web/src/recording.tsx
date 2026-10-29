// What the person sees of the microphone and the camera (media.ts): the question It asks before a
// page may use them on this screen, what It's bar says while one records, It's own view of the
// camera, and what this screen has allowed, under Settings, where it is taken back.
import { useEffect, useRef, useState } from 'react'
import { IconStop } from './brand'
import { Dialog } from './dialog'
import { ago, useNow } from './lib'
import { cannotRecord, grantsOf, kindsSaid, type Live, liveFor, takeBack, useAsking, useLive, useMediaChanges, useShooting } from './media'

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

/** How long something has run, as minutes and seconds. */
const lasted = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** Who made a page, in a few words, for the person to know whose page is asking. */
const madeBy = (agent: string | null, machine: string | null): string => `${agent ?? 'An agent'}${machine ? ` on ${machine}` : ''}`

/**
 * The question It asks before a page may use the microphone or the camera on this screen: in It's
 * own words and not the page's, naming the page and the agent that made it. Closing it is no.
 */
export function MediaAsk() {
  const asking = useAsking()
  if (!asking) return null
  const what = kindsSaid(asking.kinds)
  return (
    <Dialog
      eyebrow={asking.kinds.includes('camera') ? 'Camera' : 'Microphone'}
      title={`Let “${asking.title}” use ${what} on this screen?`}
      onClose={() => asking.answer(false)}
      className="media-ask"
    >
      <p className="modal-lede">
        {madeBy(asking.agent, asking.machine)} made this page, and it asks to record from {what} here. It records only while It's bar says so, and you can stop
        it there. What it records is given to the page, which can send it to its agent, or anywhere else its own code sends things.
      </p>
      <p className="modal-lede">This is kept for this page on this screen until you take it back, in the page's bar or under Settings.</p>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={() => asking.answer(true)}>
          Allow on this screen
        </button>
        <button type="button" onClick={() => asking.answer(false)}>
          Don’t allow
        </button>
      </div>
    </Dialog>
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

/** One recording under way, in It's bar: what records, for how long, and the button that stops it. */
function LiveChip({ l }: { l: Live }) {
  const now = useTicking()
  const what = l.kinds.includes('camera') ? (l.kinds.includes('mic') ? 'Microphone and camera' : 'Camera') : 'Microphone'
  return (
    <span className="media-live" data-state={l.state} role="status">
      <span className="media-live-dot" aria-hidden="true" />
      <span className="media-live-text">
        {l.state === 'paused' ? 'Paused' : 'Recording'} · {what} · {lasted(now - l.since)}
      </span>
      <button
        type="button"
        className="media-live-stop"
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
 * While the page shown records, a row of It's bar of its own, under the rest of it: that it
 * records, what, for how long, and the button that stops it. It is drawn by the site, where
 * nothing on the page can cover it.
 */
export function RecordingNow({ page }: { page: string }) {
  useMediaChanges()
  const l = liveFor(page)
  return l ? <LiveChip l={l} /> : null
}

/** Among the bar's buttons, where the page shown is allowed the microphone or the camera on this screen: the button that takes that back. */
export function MediaAllowed({ user, page, title }: { user: string; page: string; title: string }) {
  useMediaChanges()
  const grant = grantsOf(user).find((g) => g.page === page)
  if (!grant || liveFor(page)) return null
  return (
    <button
      type="button"
      className="nav-action media-allowed"
      title={`“${title}” may use ${kindsSaid(grant.kinds)} on this screen. Press to take that back.`}
      aria-label={`Take back ${kindsSaid(grant.kinds)} from this page`}
      onClick={() => confirm(`Take back ${kindsSaid(grant.kinds)} from “${title}” on this screen? It asks again the next time it wants it.`) && takeBack(user, page)}
    >
      <IconMic />
    </button>
  )
}

/** A camera's picture, in a video element of It's own. */
function View({ stream, onView }: { stream: MediaStream; onView?: (v: HTMLVideoElement | null) => void }) {
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
      className={`media-view-video${away ? '' : ' media-view-mirrored'}`}
      autoPlay
      muted
      playsInline
    />
  )
}

/**
 * It's own view of the camera: small, in a corner, while a page records from it, so that the
 * person sees what is recorded; and whole, with a button to take the photo, while a page asks
 * for one.
 */
export function CameraView() {
  const recording = useLive().filter((l) => l.kinds.includes('camera'))
  const shooting = useShooting()
  const [view, setView] = useState<HTMLVideoElement | null>(null)
  return (
    <>
      {recording.map((l) => (
        <figure key={l.id} className="media-corner" aria-label={`What the camera records for “${l.title}”`}>
          <View stream={l.stream} />
        </figure>
      ))}
      {shooting && (
        <div className="media-shoot" role="dialog" aria-modal="true" aria-label={`Take a photo for “${shooting.title}”`}>
          <div className="media-shoot-head">A photo for “{shooting.title}”</div>
          <View stream={shooting.stream} onView={setView} />
          <div className="media-shoot-actions">
            <button type="button" className="primary" onClick={() => view && shooting.take(view)}>
              Take photo
            </button>
            <button type="button" onClick={shooting.close}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
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
              <span className="row-sub">{`May use ${kindsSaid(g.kinds)} on this screen. ${madeBy(g.agent, g.machine)} made it. Allowed ${ago(g.at, Date.now())}.`}</span>
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
              <span className="row-sub">A page that asked for them when it was published asks you here first, and records only while It's bar says so.</span>
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
