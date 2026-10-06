// The person's pages: the grid of all of them, and one of them shown.
import { NOUN } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { type CSSProperties, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { copy, IconBack, IconLink, IconPin, IconStop, IconX, Mark } from './brand'
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
  /** What the page's own script last failed with, and which version of the page that was. */
  const [fault, setFault] = useState<{ of: string; message: string } | null>(null)
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
        {/* The page's own script failed: said before anything else, since nothing done on it can be relied on to have been sent */}
        {fault && fault.of === `${page.id}:${page.version}` && (
          <span className="status" data-tone="bad" title={fault.message}>
            This {NOUN.one} has an error in it, so it may not send what you do. Tell your agent: {fault.message}
          </span>
        )}
        {page.run ? (
          <Working artifactId={page.id as Id<'artifacts'>} stopping={page.run.stopping} />
        ) : (
          <ActionStatus
            artifactId={page.id as Id<'artifacts'>}
            user={user}
            machine={page.machine}
            machineSeenAt={page.machineSeenAt}
            // Only the owner may switch reopening on, and only for an agent app It can reopen
            wakes={owner ? page.wake : null}
            agent={agentName(page.agent)}
            stoppedAt={page.stoppedAt}
            wakeFailed={page.wakeFailed}
            answeredAt={page.answeredAt ?? null}
          />
        )}
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
        <Mount
          key={`${page.id}:${page.version}`}
          artifactId={page.id as Id<'artifacts'>}
          title={page.title}
          user={user}
          // Said of the version that failed, and of no other: a new version is a new page
          onFault={(message) => setFault({ of: `${page.id}:${page.version}`, message })}
        />
      )}
    </main>
  )
}

/**
 * The page's agent is at work because It reopened its conversation, with nobody at the machine
 * to watch it: said in a word, with the one thing to do about it, which is to stop it.
 */
function Working({ artifactId, stopping }: { artifactId: Id<'artifacts'>; stopping: boolean }) {
  const stop = useMutation(api.artifacts.stop)
  const [asked, setAsked] = useState(false)
  const ending = stopping || asked
  // What else was done on the page while it works: said, so that the person knows it is held and what a stop takes with it
  const recent = useQuery(api.actions.forArtifact, { artifactId })
  const more = Math.max(0, (recent?.filter((a) => a.delivery !== 'handed_off').length ?? 0) - 1)
  return (
    <span className="working" role="status">
      <span className="working-dot" data-ending={ending || undefined} />
      {ending ? 'Stopping' : more ? `Working, ${more} more waiting` : 'Working'}
      {!ending && (
        <button
          type="button"
          className="working-stop"
          title={more ? 'Stop the agent. What is waiting goes with it.' : 'Stop the agent'}
          aria-label="Stop the agent"
          onClick={() => {
            setAsked(true)
            stop({ artifactId }).catch((err) => {
              setAsked(false)
              say(refusal(err).message, 'error')
            })
          }}
        >
          <IconStop />
        </button>
      )}
    </span>
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
  stoppedAt,
  wakeFailed,
  answeredAt,
}: {
  artifactId: Id<'artifacts'>
  user: string
  machine: string | null
  machineSeenAt: number | null
  /** Where the page's agent app can have a closed conversation reopened: the machine that would, and whether that is switched on there. */
  wakes: { machineId: string; harness: string; on: boolean } | null
  agent: string | null
  /** When a person last stopped the page's agent, if they have. */
  stoppedAt: number | null
  /** Why the page's conversation could not be reopened, the last time that was tried and did not work. */
  wakeFailed: { at: number; why: string } | null
  /** When the page's agent last changed the page, by publishing it or writing its state. */
  answeredAt: number | null
}) {
  const convex = useConvex()
  const setWake = useMutation(api.machines.wake)
  const recent = useQuery(api.actions.forArtifact, { artifactId })
  // Looked at every second: what is said of a click that nobody has taken changes within a few
  // seconds of it, and a person who is not told by then has usually pressed again
  const now = useNow(1_000)
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
  // It cannot be reached: said once that has gone on for a few seconds, whatever was last done
  // here. A page that is open when It stops otherwise looks exactly as it did, and the person
  // goes on using a page whose agent hears nothing. A moment without a connection is not said.
  const [down, setDown] = useState(false)
  useEffect(() => {
    if (connected) return setDown(false)
    const t = setTimeout(() => setDown(true), DOWN_MS)
    return () => clearTimeout(t)
  }, [connected])
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
      <span className="status" data-tone={down ? 'bad' : undefined}>
        {down ? 'Can’t reach It. Saved on this browser, and sent when It is back' : 'Saved on this browser, not sent yet'}
      </span>
    )
  if (down)
    return (
      <span className="status" data-tone="bad">
        Can’t reach It. What you do here is saved on this browser, and sent when It is back
      </span>
    )
  if (!last || now - last.at > 10 * 60_000) return null
  // The agent was stopped after the last thing done here: said as that, whatever became of it.
  // What was waiting then went with the stop, and the next thing done reopens the conversation.
  if (stoppedAt !== null && last.at <= stoppedAt) {
    // Everything of that conversation's that was waiting went with the stop, and is said to have
    const dropped = (recent ?? []).filter((x) => x.route === 'stopped' && x.at <= stoppedAt && stoppedAt - x.at < 3_600_000).length
    return <span className="status">{dropped > 1 ? `Stopped, with ${dropped - 1} more that ${dropped === 2 ? 'was' : 'were'} waiting` : 'Stopped'}</span>
  }
  if (last.delivery === 'handed_off') {
    // The agent has changed the page since: its answer is on the page, and the bar has nothing to add.
    // Left up, "Your agent has it" read as an agent still at work, minutes after it had answered.
    // (Handed over and not yet said to be done is what `running` means: every click an add-on took is that, until its agent says more)
    if ((last.outcome === null || last.outcome === 'running') && answeredAt !== null && answeredAt > last.at) return null
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
  const slow = now - last.at > WAKE_OFFER_MS
  // A machine has it in hand and has not been able to give it to the agent: the conversation is
  // open and at work on something else. With nobody holding it, nothing on that machine was
  // listening for it: the conversation is closed, or its app is not running.
  const busy = last.delivery === 'leased'
  const offer = wakes && !wakes.on && slow && !busy
  // Tried, and it could not be reopened: said as that, with why where it is asked for
  if (wakeFailed && wakeFailed.at >= last.at)
    return (
      <span className="status" data-tone="bad">
        {`Couldn’t wake ${agent ?? 'your agent'}${waiting > 1 ? ` (${waiting})` : ''}: ${wakeFailed.why}`}
      </span>
    )
  return (
    <>
      <span className="status" data-tone="wait">
        {/* Not taken after a while: said as what it is, busy or closed, so that the person knows whether to wait or to do something */}
        {slow && busy
          ? `Sent. ${agent ?? 'Your agent'} is busy, and gets it when it is free${waiting > 1 ? ` (${waiting})` : ''}`
          : slow && !wakes?.on
            ? `Sent. ${agent ?? 'Your agent'} is not listening${waiting > 1 ? ` (${waiting})` : ''}: its conversation looks closed`
            : `Sent. Waiting for your agent${waiting > 1 ? ` (${waiting})` : ''}`}
      </span>
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
const WAKE_OFFER_MS = 3_000
/** How long It has not been reachable before the page says so: longer than a connection takes to come back by itself. */
const DOWN_MS = 5_000
/** What the person is asked before closed conversations of an agent app may be reopened on a machine, where they switch it on from a page. */
export const wakeAsked = (agent: string, machine: string): string =>
  `Turn on Auto-wake for ${agent} on ${machine}? It then runs ${agent} there, with nobody watching, when you use a page whose conversation is closed. You can turn it off under Machines.`
