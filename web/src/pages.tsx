// The person's pages: the grid of all of them, and one of them shown.
import { NOUN } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { type CSSProperties, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { copy, IconBack, IconLink, IconPin, IconX, Mark } from './brand'
import { ago, api, type Id, navigate, refusal, useNow } from './lib'
import { Mount } from './mount'
import { Bell, say } from './notifications'
import { onItsWayUntil, outboxChanges, unsaved, unsent, watchOutbox } from './outbox'
import { Preview } from './preview'
import { Welcome } from './welcome'

export interface Card {
  id: string
  slug: string
  title: string
  version: number | null
  updatedAt: number
  agent: string | null
  machine: string | null
  pending: number
  pinned: boolean
}

const AGENTS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes', opencode: 'OpenCode', pi: 'Pi' }
export const agentName = (a: string | null) => (a ? (AGENTS[a] ?? a) : null)

/** A hue for a page, from its id: the same page has the same one on every display, and two neighbours seldom share one. */
function hueOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % 360
}

type Sort = 'newest' | 'oldest' | 'az' | 'za'
const SORTS: Record<Sort, (a: Card, b: Card) => number> = {
  newest: (a, b) => b.updatedAt - a.updatedAt,
  oldest: (a, b) => a.updatedAt - b.updatedAt,
  az: (a, b) => a.title.localeCompare(b.title),
  za: (a, b) => b.title.localeCompare(a.title),
}

/** A page changed this lately is marked as live on its card. */
const LIVE_MS = 60_000

/** Every page there is. Pinning one and deleting one are the owner's to do, and a screen is not offered them. */
export function Grid({ pages, owner, query, onQuery }: { pages: Card[] | undefined; owner: boolean; query: string; onQuery: (q: string) => void }) {
  const now = useNow()
  const [sort, setSort] = useState<Sort>('newest')
  const [by, setBy] = useState<string | null>(null)
  const organize = useMutation(api.artifacts.organize)
  const remove = useMutation(api.artifacts.remove)
  // The agent apps that made these pages, offered as a filter when there is more than one
  const agents = useMemo(() => [...new Set((pages ?? []).map((p) => p.agent).filter((a): a is string => a !== null))].sort(), [pages])
  const filter = by !== null && agents.includes(by) ? by : null
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (pages ?? [])
      .filter((p) => (!q || p.title.toLowerCase().includes(q) || p.slug.includes(q)) && (filter === null || p.agent === filter))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || SORTS[sort](a, b))
  }, [pages, query, sort, filter])

  if (pages === undefined) return <main className="grid-view" role="status" />
  if (pages.length === 0) return <Welcome owner={owner} />
  const act = (p: Promise<unknown>) => p.catch((err) => say(refusal(err).message, 'error'))
  return (
    <main className="grid-view">
      <div className="grid-toolbar">
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggles, which a fieldset would draw a box around */}
        <div className="grid-toolbar-left" role="group" aria-label="Filter by agent app">
          {agents.length > 1 &&
            [null, ...agents].map((a) => (
              <button
                key={a ?? ''}
                type="button"
                className={`grid-chip${filter === a ? ' grid-chip--active' : ''}`}
                aria-pressed={filter === a}
                onClick={() => setBy(a)}
              >
                {a === null ? 'All' : agentName(a)}
              </button>
            ))}
        </div>
        <select className="grid-sort" aria-label={`Sort ${NOUN.many}`} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="az">A–Z</option>
          <option value="za">Z–A</option>
        </select>
      </div>
      <ul className="grid">
        {shown.length === 0 && (
          <li className="grid-empty">
            <p className="grid-empty-line">{query.trim() ? `No ${NOUN.many} match “${query.trim()}”` : 'Nothing in this filter'}</p>
            {query.trim() && (
              <button type="button" className="grid-empty-reset" onClick={() => onQuery('')}>
                Clear search
              </button>
            )}
          </li>
        )}
        {shown.map((p, i) => (
          <li key={p.id} className="card page-card" style={i < 12 ? ({ '--card-delay': `${i * 0.035}s` } as CSSProperties) : undefined}>
            <div className="card-frame-box">
              <a
                href={`/p/${p.slug}`}
                className="cover card-preview"
                aria-label={p.title}
                onClick={(e) => {
                  e.preventDefault()
                  navigate(`/p/${p.slug}`)
                }}
              >
                <Preview
                  // A new version is a new showing, and so a new picture
                  key={`${p.id}:${p.version}`}
                  artifactId={p.id as Id<'artifacts'>}
                  title={p.title}
                  cover={
                    <span className="card-fallback card-fallback--bare" style={{ '--seed-h': hueOf(p.id) } as CSSProperties}>
                      <span className="card-fallback-kind">{agentName(p.agent) ?? NOUN.One}</span>
                    </span>
                  }
                />
                {now - p.updatedAt < LIVE_MS && <span className="card-live">live</span>}
                {p.pending > 0 && (
                  <span className="badge card-badge" title="Waiting for your agent">
                    {p.pending > 9 ? '9+' : p.pending}
                    <span className="offscreen"> waiting</span>
                  </span>
                )}
              </a>
              {owner && (
                <span className="tray card-actions">
                  <button
                    type="button"
                    className="card-action"
                    title="Copy link"
                    aria-label="Copy link"
                    onClick={async () => say((await copy(`${location.origin}/p/${p.slug}`)) ? 'Link copied' : 'Copy failed')}
                  >
                    <IconLink />
                  </button>
                  <button
                    type="button"
                    className="card-action"
                    aria-pressed={p.pinned}
                    title={p.pinned ? 'Unpin' : 'Pin to the front'}
                    aria-label={p.pinned ? 'Unpin' : 'Pin'}
                    onClick={() => act(organize({ artifactId: p.id as Id<'artifacts'>, pinned: !p.pinned }))}
                  >
                    <IconPin />
                  </button>
                  <button
                    type="button"
                    className="card-action card-action--danger"
                    title="Delete"
                    aria-label="Delete"
                    onClick={() => confirm(`Delete “${p.title}”? This removes it from every display.`) && act(remove({ artifactId: p.id as Id<'artifacts'> }))}
                  >
                    <IconX />
                  </button>
                </span>
              )}
            </div>
            <div className="caption card-body">
              <div className="card-text">
                <span className="card-title" title={p.title}>
                  {p.pinned && <span className="card-pin" role="img" aria-label="Pinned" />}
                  {p.title}
                </span>
                <span className="card-meta card-sub">{[agentName(p.agent), p.machine, ago(p.updatedAt, now)].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}

export function PageView({ slug, user, owner }: { slug: string; user: string; owner: boolean }) {
  const page = useQuery(api.artifacts.get, { slug })
  const now = useNow()
  useEffect(() => {
    if (page) document.title = `${page.title} · It`
    return () => {
      document.title = 'It'
    }
  }, [page])
  // Escape goes back, from wherever on the site's own part of the screen the keyboard is
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-overlay, .finder-overlay') && navigate('/')
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  if (!page) return <main className="page-view" role="status" />
  return (
    <main className="page-view">
      <header className="page-bar page-nav">
        <button type="button" className="back-btn" aria-label={`Back to your ${NOUN.many}`} title="Back (esc)" onClick={() => navigate('/')}>
          <IconBack />
        </button>
        <a
          className="page-nav-mark"
          href="/"
          onClick={(e) => {
            e.preventDefault()
            navigate('/')
          }}
        >
          <Mark />
        </a>
        <div className="page-nav-titlewrap">
          <h1 className="page-title page-nav-title">{page.title}</h1>
          <div className="page-meta page-nav-meta">
            {[agentName(page.agent), page.machine, ago(page.updatedAt, now)].filter(Boolean).map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed few, in a fixed order
              <span key={i} className="page-nav-meta-part">
                {i > 0 && <span className="page-nav-meta-dot" />}
                {part}
              </span>
            ))}
          </div>
        </div>
        <ActionStatus
          artifactId={page.id as Id<'artifacts'>}
          user={user}
          machine={page.machine}
          machineSeenAt={page.machineSeenAt}
          // Only the owner may switch reopening on, and only for an agent app It can reopen
          wakes={owner ? page.wake : null}
          agent={agentName(page.agent)}
        />
        <div className="page-nav-actions">
          <Bell compact />
          <button
            type="button"
            className="nav-action"
            title="Copy link"
            aria-label="Copy link"
            onClick={async () => say((await copy(`${location.origin}/p/${slug}`)) ? 'Link copied' : 'Copy failed')}
          >
            <IconLink />
          </button>
        </div>
      </header>
      {page.version === null ? (
        <div className="page-frame-unavailable">This {NOUN.one} has nothing published yet.</div>
      ) : (
        // A new version is a new showing: the session a page gets is for one version only
        <Mount key={`${page.id}:${page.version}`} artifactId={page.id as Id<'artifacts'>} title={page.title} user={user} />
      )}
    </main>
  )
}

/** A machine that has not been heard from for this long is taken to be off. */
const ONLINE_MS = 6 * 60_000

/** Where the last thing the person did has got to: saved here, accepted, or with the agent. */
function ActionStatus({
  artifactId,
  user,
  machine,
  machineSeenAt,
  wakes,
  agent,
}: {
  artifactId: Id<'artifacts'>
  user: string
  machine: string | null
  machineSeenAt: number | null
  /** Where the page's agent app can have a closed conversation reopened: the machine that would, and whether that is switched on there. */
  wakes: { machineId: string; harness: string; on: boolean } | null
  agent: string | null
}) {
  const convex = useConvex()
  const setWake = useMutation(api.machines.wake)
  const recent = useQuery(api.actions.forArtifact, { artifactId })
  const now = useNow(5_000)
  // What is said of a click is said again the moment one is saved here or let go of, and the
  // moment the connection comes or goes: what the backend last said is about the click before it
  useSyncExternalStore(watchOutbox, outboxChanges)
  const connected = useSyncExternalStore(
    useCallback((fn: () => void) => convex.subscribeToConnectionState(fn), [convex]),
    () => convex.connectionState().isWebSocketConnected,
  )
  // A click is said to be on its way only for the first few seconds after it was made, and only
  // over a connection that says it is there. A connection can say so and carry nothing, so a
  // click not taken by then is said not to have been sent, and that is said by itself when the
  // time comes
  const until = onItsWayUntil(user, artifactId)
  const onItsWay = connected && until !== null && Date.now() < until
  const [, look] = useState(0)
  useEffect(() => {
    if (!onItsWay || until === null) return
    // Looked at again a moment past the time, so that a timer that runs a little early does not find it not yet come
    const t = setTimeout(() => look((n) => n + 1), Math.max(0, until - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [onItsWay, until])
  const waiting = recent?.filter((a) => a.delivery !== 'handed_off').length ?? 0
  const last = recent?.[0]
  // Sent with no copy kept here, because this browser would not store one: closing the tab now would lose it
  if (unsaved(user, artifactId) > 0)
    return (
      <span className="status" data-tone="wait">
        {onItsWay ? 'Sending' : 'Not sent yet'}. This browser could not save it, so keep this tab open
      </span>
    )
  if (unsent(user, artifactId) > 0)
    return onItsWay ? (
      <span className="status" data-tone="wait">
        Sending…
      </span>
    ) : (
      <span className="status">Saved on this browser, not sent yet</span>
    )
  if (!last || now - last.at > 10 * 60_000) return null
  if (last.delivery === 'handed_off') {
    // When what became of it cannot be told, the person is told exactly that, so they can decide whether to do it again
    const said =
      last.outcome === 'failed'
        ? 'Your agent could not do that'
        : last.outcome === 'succeeded'
          ? 'Done'
          : last.outcome === 'unknown'
            ? 'Your agent got it; whether it finished is not known'
            : 'Your agent has it'
    return (
      <span className="status" data-tone={last.outcome === 'failed' ? 'bad' : last.outcome === 'unknown' ? 'wait' : 'ok'}>
        {said}
      </span>
    )
  }
  // Judged against the backend's clock, and again every few seconds: a machine that goes quiet changes nothing in the data
  const online = machineSeenAt !== null && now - machineSeenAt < ONLINE_MS
  if (!online)
    return <span className="status" data-tone="wait">{`Waiting for ${machine ?? 'your machine'} to come online${waiting > 1 ? ` (${waiting})` : ''}`}</span>
  // Sent, and not taken for a while: its conversation may be closed. The owner can switch on
  // the reopening of such conversations, here as under Machines, and it is so from then on
  const offer = wakes && !wakes.on && now - last.at > WAKE_OFFER_MS
  return (
    <>
      <span className="status" data-tone="wait">{`Sent. Waiting for your agent${waiting > 1 ? ` (${waiting})` : ''}`}</span>
      {offer && (
        <button
          type="button"
          className="link"
          title="Its conversation may be closed. Reopen it for this click, and from now on."
          onClick={() =>
            confirm(wakeAsked(agent ?? 'your agent', machine ?? 'its machine')) &&
            setWake({ machineId: wakes.machineId as Id<'machines'>, harness: wakes.harness, on: true }).catch((err) => say(refusal(err).message, 'error'))
          }
        >
          Wake it
        </button>
      )}
    </>
  )
}

/** How long a click has gone untaken before the owner is offered the reopening of its conversation. */
const WAKE_OFFER_MS = 12_000
/** What the person is asked before closed conversations of an agent app may be reopened on a machine, where they switch it on from a page. */
export const wakeAsked = (agent: string, machine: string): string =>
  `Turn on Auto-wake for ${agent} on ${machine}? It then runs ${agent} there, with nobody watching, when you use a page whose conversation is closed. You can turn it off under Machines.`
