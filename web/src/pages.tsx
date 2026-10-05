// The person's pages: the grid of all of them, and one of them shown.
import { NOUN } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ago, api, type Id, navigate, refusal, useNow } from './lib'
import { Mount } from './mount'
import { onItsWayUntil, outboxChanges, unsaved, unsent, watchOutbox } from './outbox'

interface Card {
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
const agentName = (a: string | null) => (a ? (AGENTS[a] ?? a) : null)

/** Every page there is. Pinning one and deleting one are the owner's to do, and a screen is not offered them. */
export function Grid({ pages, owner }: { pages: Card[] | undefined; owner: boolean }) {
  const now = useNow()
  const [find, setFind] = useState('')
  const organize = useMutation(api.artifacts.organize)
  const remove = useMutation(api.artifacts.remove)
  const [error, setError] = useState('')
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (pages ?? [])
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  }, [pages, find])

  if (pages === undefined) return <main className="empty" role="status" />
  if (pages.length === 0) return <Welcome owner={owner} />
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  return (
    <main className="grid-view">
      <div className="grid-head">
        <input type="search" placeholder={`Find a ${NOUN.one}`} aria-label={`Find a ${NOUN.one}`} value={find} onChange={(e) => setFind(e.target.value)} />
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
      {shown.length === 0 && <p className="muted">Nothing matches “{find}”.</p>}
      <ul className="grid">
        {shown.map((p) => (
          <li key={p.id} className="card">
            <a
              href={`/p/${p.slug}`}
              className="cover"
              onClick={(e) => {
                e.preventDefault()
                navigate(`/p/${p.slug}`)
              }}
            >
              <span className="cover-title">{p.title}</span>
              {p.pending > 0 && (
                <span className="badge" title="Waiting for your agent">
                  {p.pending} waiting
                </span>
              )}
            </a>
            <div className="caption">
              <span className="card-title">{p.title}</span>
              <span className="card-meta">{[agentName(p.agent), p.machine, ago(p.updatedAt, now)].filter(Boolean).join(' · ')}</span>
              {owner && (
                <span className="tray">
                  <button
                    type="button"
                    aria-pressed={p.pinned}
                    title={p.pinned ? 'Unpin' : 'Pin to the front'}
                    onClick={() => act(organize({ artifactId: p.id as Id<'artifacts'>, pinned: !p.pinned }))}
                  >
                    {p.pinned ? 'Pinned' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => confirm(`Delete “${p.title}”? This removes it from every display.`) && act(remove({ artifactId: p.id as Id<'artifacts'> }))}
                  >
                    Delete
                  </button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}

/**
 * What is shown while there are no pages: how the first one gets here. The site comes from the
 * program that is already on the person's machine, so what is left to do is connecting their
 * agents to it, which is the owner's to do and is done on that machine.
 */
function Welcome({ owner }: { owner: boolean }) {
  if (!owner)
    return (
      <main className="empty">
        <h2>Nothing here yet</h2>
        <p className="muted">This display is ready. {NOUN.Many} appear here when one of your agents makes them.</p>
      </main>
    )
  return (
    <main className="empty">
      <h2>Nothing here yet</h2>
      <p className="muted">
        This display is ready. {NOUN.Many} appear here when one of your agents makes them. To connect your agents, run this on the machine It runs on:
      </p>
      <pre className="steps">
        <code>it setup</code>
      </pre>
      <p className="muted">
        It looks for the agent apps on that machine and offers to connect each one. Then ask your agent to show you something. You can see what is connected
        under{' '}
        <a
          href="/machines"
          onClick={(e) => {
            e.preventDefault()
            navigate('/machines')
          }}
        >
          Machines
        </a>
        .
      </p>
    </main>
  )
}

export function PageView({ slug, user }: { slug: string; user: string }) {
  const page = useQuery(api.artifacts.get, { slug })
  useEffect(() => {
    if (page) document.title = `${page.title} · It`
    return () => {
      document.title = 'It'
    }
  }, [page])
  if (!page) return <main className="empty" role="status" />
  return (
    <main className="page-view">
      <header className="page-bar">
        <button type="button" className="icon" aria-label={`Back to your ${NOUN.many}`} onClick={() => navigate('/')}>
          ←
        </button>
        <span className="page-title">{page.title}</span>
        <span className="grow" />
        <ActionStatus artifactId={page.id as Id<'artifacts'>} user={user} machine={page.machine} machineSeenAt={page.machineSeenAt} />
        <span className="page-meta">{[agentName(page.agent), page.machine].filter(Boolean).join(' · ')}</span>
      </header>
      {page.version === null ? (
        <div className="empty">
          <p className="muted">This {NOUN.one} has nothing published yet.</p>
        </div>
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
}: {
  artifactId: Id<'artifacts'>
  user: string
  machine: string | null
  machineSeenAt: number | null
}) {
  const convex = useConvex()
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
  return <span className="status" data-tone="wait">{`Sent. Waiting for your agent${waiting > 1 ? ` (${waiting})` : ''}`}</span>
}
