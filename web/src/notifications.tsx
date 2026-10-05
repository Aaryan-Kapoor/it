// Notifications: an agent speaking to the person outside any one page. They are stored, so
// they survive a reload; a new one shows as a toast; all of them wait in the tray.
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
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

function Body({ n, onDone }: { n: Note; onDone?: () => void }) {
  const answer = useMutation(api.notifications.answer)
  const [error, setError] = useState('')
  return (
    <>
      <p className="note-text">{n.text}</p>
      {n.buttons.length > 0 && (
        <div className="note-buttons">
          {n.buttons.map((b) => (
            <button
              key={b.action}
              type="button"
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

  if (!fresh.length) return null
  return (
    <div className="toasts" aria-live="polite">
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
          <Body n={n} onDone={() => hide(n.id)} />
          <button
            type="button"
            className="icon x"
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

/** The bell and its tray, with a count of what has not been seen on this display. */
export function Bell() {
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
  return (
    <div className="menu">
      <button
        type="button"
        className="icon bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'}
        onClick={() => setOpen(!open)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unseen > 0 && <span className="count">{unseen > 9 ? '9+' : unseen}</span>}
      </button>
      {open && (
        <div className="tray-panel" role="dialog" aria-label="Notifications">
          <div className="tray-head">
            <span>Notifications</span>
            {(notes?.length ?? 0) > 0 && (
              <button
                type="button"
                className="link"
                onClick={() => void dismiss({ key: displayKey(), ids: (notes ?? []).map((n) => n.id as Id<'notifications'>) })}
              >
                Clear all
              </button>
            )}
          </div>
          {(notes ?? []).length === 0 && <p className="muted">Nothing new. When an agent has something to tell you, it shows up here.</p>}
          {/* Said where notifications are read, on a screen that cannot be told of one once the site is closed */}
          {notSecure() && <p className="muted tray-note">{NOT_SECURE}</p>}
          <ul>
            {(notes ?? []).map((n) => (
              <li key={n.id} className="note">
                <Body n={n} />
                <div className="note-foot">
                  <span className="muted">{ago(n.at, now)}</span>
                  {n.slug && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setOpen(false)
                        navigate(`/p/${n.slug}`)
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button type="button" className="link" onClick={() => void dismiss({ key: displayKey(), ids: [n.id as Id<'notifications'>] })}>
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
