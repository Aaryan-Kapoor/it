// Notifications: an agent speaking to the person outside any one page. They are stored, so
// they survive a reload; a new one shows as a toast; all of them wait in the tray. The site's
// own short words ("Link copied") are shown in the same place, and are kept nowhere.
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconBell } from './brand'
import { ago, api, displayKey, type Id, navigate, refusal, useNow } from './lib'
import { NOT_SECURE, notSecure } from './push'

interface Note {
  id: string
  text: string
  slug: string | null
  sticky: boolean
  buttons: { label: string; action: string }[]
  at: number
  seen: boolean
  answer: string | null
}
const TOAST_MS = 8_000

// ---------- the site's own words ----------

interface Said {
  id: number
  text: string
  tone: 'info' | 'error'
}
let said: Said[] = []
let nextId = 1
const hearers = new Set<() => void>()
const tell = () => {
  for (const fn of hearers) fn()
}
/** Shows a few words over whatever is on screen, for a moment. */
export function say(text: string, tone: Said['tone'] = 'info'): void {
  const id = nextId++
  said = [...said, { id, text, tone }]
  tell()
  setTimeout(
    () => {
      said = said.filter((s) => s.id !== id)
      tell()
    },
    tone === 'error' ? 6000 : 2600,
  )
}
const watchSaid = (fn: () => void) => {
  hearers.add(fn)
  return () => void hearers.delete(fn)
}

function Body({ n, onDone, kind }: { n: Note; onDone?: () => void; kind: 'toast' | 'notif-item' }) {
  const answer = useMutation(api.notifications.answer)
  const [error, setError] = useState('')
  return (
    <>
      <p className={`note-text ${kind}-text`}>{n.text}</p>
      {n.buttons.length > 0 && (
        <div className="note-buttons toast-actions">
          {n.buttons.map((b) => (
            <button
              key={b.action}
              type="button"
              className={`toast-btn${n.answer === b.action ? ' toast-btn--chosen' : ''}`}
              aria-pressed={n.answer === b.action}
              disabled={n.answer !== null}
              onClick={(e) => {
                e.stopPropagation()
                answer({ id: n.id as Id<'notifications'>, action: b.action, displayKey: displayKey() }).then(
                  () => onDone?.(),
                  (err) => setError(refusal(err).message),
                )
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      {error && <span className="error">{error}</span>}
    </>
  )
}

/** New notifications, shown over whatever is on screen. */
export function Toasts() {
  const notes = useQuery(api.notifications.list, { key: displayKey() }) as Note[] | undefined
  const own = useSyncExternalStore(watchSaid, () => said)
  // A toast is for what arrives while the site is open. Whatever was already there when it
  // loaded is in the tray; "already there" is the newest one at that moment, so no clock of
  // this browser's is compared with the backend's.
  const since = useRef<number | null>(null)
  if (notes !== undefined && since.current === null) since.current = notes.reduce((newest, n) => Math.max(newest, n.at), 0)
  const [gone, setGone] = useState<Set<string>>(new Set())
  const fresh = (notes ?? []).filter((n) => since.current !== null && n.at > since.current && !gone.has(n.id) && !n.answer).slice(0, 3)
  const hide = (id: string) => setGone((g) => new Set(g).add(id))

  // One that asks nothing goes away by itself; one with buttons, or marked to stay, waits
  const passing = fresh
    .filter((n) => !n.sticky && n.buttons.length === 0)
    .map((n) => n.id)
    .join(',')
  useEffect(() => {
    if (!passing) return
    const timers = passing.split(',').map((id) => setTimeout(() => setGone((g) => new Set(g).add(id)), TOAST_MS))
    return () => timers.forEach(clearTimeout)
  }, [passing])

  if (!fresh.length && !own.length) return null
  return (
    <div className="toasts toast-stack" aria-live="polite">
      {own.map((s) => (
        <div key={`own-${s.id}`} className={`toast toast--own${s.tone === 'error' ? ' toast--error' : ''}`} role={s.tone === 'error' ? 'alert' : 'status'}>
          <p className="toast-text">{s.text}</p>
        </div>
      ))}
      {fresh.map((n) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the same notification is reachable from the tray
        // biome-ignore lint/a11y/noStaticElementInteractions: see above
        <div
          key={n.id}
          className="toast"
          data-link={Boolean(n.slug)}
          onClick={() => {
            if (n.slug) navigate(`/p/${n.slug}`)
            hide(n.id)
          }}
        >
          <Body n={n} kind="toast" onDone={() => hide(n.id)} />
          <button
            type="button"
            className="icon x toast-close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              hide(n.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/** The bell and its tray, with a count of what has not been seen on this display. `compact` is the bell of the bar over a page. */
export function Bell({ compact = false }: { compact?: boolean }) {
  const notes = useQuery(api.notifications.list, { key: displayKey() }) as Note[] | undefined
  const seen = useMutation(api.notifications.seen)
  const dismiss = useMutation(api.notifications.dismiss)
  const [open, setOpen] = useState(false)
  const now = useNow()
  const unseen = (notes ?? []).filter((n) => !n.seen).length
  // Exactly what the tray is showing, and nothing the person has not been shown
  const unseenIds = (notes ?? [])
    .filter((n) => !n.seen)
    .map((n) => n.id)
    .join(',')
  useEffect(() => {
    if (open && unseenIds) void seen({ key: displayKey(), ids: unseenIds.split(',') as Id<'notifications'>[] }).catch(() => {})
  }, [open, unseenIds, seen])
  // A click anywhere else closes it, and so does Escape
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div className="menu" ref={box}>
      <button
        type="button"
        className={`icon bell notif-btn ${compact ? 'nav-action' : 'grid-icon-btn'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'}
        onClick={() => setOpen(!open)}
      >
        <IconBell />
        {unseen > 0 && <span className="count notif-badge">{unseen > 9 ? '9+' : unseen}</span>}
      </button>
      {open && (
        <div className={`tray-panel notif-panel${compact ? ' notif-panel--low' : ''}`} role="dialog" aria-label="Notifications">
          <div className="tray-head notif-head">
            <span className="notif-head-title">Notifications</span>
            {(notes?.length ?? 0) > 0 && (
              <button
                type="button"
                className="link notif-clear"
                onClick={() => void dismiss({ key: displayKey(), ids: (notes ?? []).map((n) => n.id as Id<'notifications'>) })}
              >
                Clear all
              </button>
            )}
          </div>
          {(notes ?? []).length === 0 && <p className="notif-empty">Nothing new.</p>}
          {/* Said where notifications are read, on a screen that cannot be told of one once the site is closed */}
          {notSecure() && <p className="tray-note notif-note">{NOT_SECURE}</p>}
          <ul>
            {(notes ?? []).map((n) => (
              <li key={n.id} className={`note notif-item${n.answer !== null ? ' notif-item--done' : ''}`}>
                <Body n={n} kind="notif-item" />
                <div className="note-foot">
                  <span className="notif-item-meta">{ago(n.at, now)}</span>
                  {n.slug && (
                    <button
                      type="button"
                      className="link notif-clear"
                      onClick={() => {
                        setOpen(false)
                        navigate(`/p/${n.slug}`)
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button type="button" className="link notif-clear" onClick={() => void dismiss({ key: displayKey(), ids: [n.id as Id<'notifications'>] })}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
