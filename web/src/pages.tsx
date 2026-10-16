// The person's pages: the grid of all of them, and one of them shown.
import { ALIVE, LIMITS, NOUN, WAKE_BACK_MS } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { copy, IconBack, IconLink, IconPin, IconSay, IconSend, IconStop, IconX, Mark } from './brand'
import { agentName, ago, api, displayKey, type Id, navigate, refusal, useNow } from './lib'
import { Mount } from './mount'
import { Bell, say } from './notifications'
import { onItsWayUntil, outboxChanges, unsaved, unsent, watchOutbox } from './outbox'
import { Preview } from './preview'
import { Starters, useTour, Welcome } from './welcome'

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

export { agentName }

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
  if (pages.length === 0) return <Empty owner={owner} />
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
                {/* The title opens the page as its picture does: it is what a person reads, and so what they press. Not a second stop for the keyboard, which has the picture's */}
                <a
                  href={`/p/${p.slug}`}
                  className="card-title"
                  title={p.title}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(`/p/${p.slug}`)
                  }}
                >
                  {p.pinned && <span className="card-pin" role="img" aria-label="Pinned" />}
                  {p.title}
                </a>
                <span className="card-meta card-sub">{[agentName(p.agent), p.machine, ago(p.updatedAt, now)].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}

/**
 * What someone with no pages is shown. Until they have had the tour, or said they want none,
 * the way into it. After that, things to ask an agent for: the tour's own screen does not come
 * back when its pages are taken away at the end of it.
 */
function Empty({ owner }: { owner: boolean }) {
  const tour = useTour()
  if (!tour.known) return <main className="grid-view" role="status" />
  return tour.done && !tour.waiting && !tour.coming ? <Starters owner={owner} /> : <Welcome owner={owner} />
}

/**
 * The pages this tab has had on its screen. One of them that is no longer there was taken
 * away while it was being looked at, as an agent takes its tour's pages away when the tour is
 * over: the screen then goes back to the person's pages, and is not left saying that there is
 * no such page, which is for an address that never led anywhere.
 */
export const wasShown = new Set<string>()

export function PageView({ slug, user, owner }: { slug: string; user: string; owner: boolean }) {
  const page = useQuery(api.artifacts.get, { slug, history: false })
  const now = useNow()
  useEffect(() => {
    if (page) wasShown.add(slug)
  }, [page, slug])
  /** What the page's own script last failed with, and which version of the page that was. */
  const [fault, setFault] = useState<{ of: string; message: string; agentTold: boolean } | null>(null)
  /** Whether the box to type to the page's agent in is open. */
  const [talking, setTalking] = useState(false)
  // Whether something done here is with the page's agent, or on its way to it, and not yet
  // answered: shown as a line that moves under the bar, which is seen where the few words
  // beside the title are not
  const recent = useQuery(api.actions.forArtifact, page ? { artifactId: page.id as Id<'artifacts'> } : 'skip')
  const underWay = page ? inHand(recent, page.answeredAt ?? null, page.run !== null && page.run !== undefined, now) : false
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
        {underWay && <span className="page-progress" aria-hidden="true" />}
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
          <span className="status" data-tone="bad" title={fault.message} role="alert">
            This {NOUN.one} has an error in it, so it may not send what you do. {fault.agentTold ? 'It has been sent to your agent' : 'Tell your agent'}:{' '}
            {fault.message}
          </span>
        )}
        {/* What became of what was done on the page is said aloud too, to whoever cannot see it change */}
        <span className="page-nav-said" role="status">
          {page.run ? (
            <Working
              // Another run of the conversation is another thing to stop: what was asked of the one before is not said of it
              key={page.run.since}
              artifactId={page.id as Id<'artifacts'>}
              stopping={page.run.stopping}
              user={user}
              machine={page.machine}
              machineSeenAt={page.machineSeenAt}
              agent={agentName(page.agent)}
            />
          ) : (
            <ActionStatus
              artifactId={page.id as Id<'artifacts'>}
              user={user}
              machine={page.machine}
              machineSeenAt={page.machineSeenAt}
              machineGone={page.machineGone === true}
              machinePaused={page.machinePaused ?? null}
              pending={page.pending}
              // Only the owner may switch reopening on, and only for an agent app It can reopen
              wakes={owner ? page.wake : null}
              agent={agentName(page.agent)}
              stoppedAt={page.stoppedAt}
              stoppedSequence={page.stoppedSequence}
              wakeFailed={page.wakeFailed}
              answeredAt={page.answeredAt ?? null}
            />
          )}
        </span>
        <div className="page-nav-actions">
          {page.version !== null && (
            <button
              type="button"
              className="nav-action"
              aria-pressed={talking}
              title={`Type to ${agentName(page.agent) ?? 'your agent'}`}
              aria-label={`Type to ${agentName(page.agent) ?? 'your agent'}`}
              onClick={() => setTalking(!talking)}
            >
              <IconSay />
            </button>
          )}
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
      {page.version !== null && (
        <Talk
          // Another page is another box: what was being typed to one agent is not sent to the next
          key={page.id}
          artifactId={page.id as Id<'artifacts'>}
          agent={agentName(page.agent)}
          said={page.said ?? null}
          open={talking}
          onClose={() => setTalking(false)}
        />
      )}
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
          onFault={(message, agentTold) => setFault({ of: `${page.id}:${page.version}`, message, agentTold })}
        />
      )}
    </main>
  )
}

/** How long after something was done on a page it is still shown as under way, where nothing has come of it. */
const UNDER_WAY_MS = 10 * 60_000
/**
 * Whether the last thing done on a page is still with its agent, or on its way to it: sent and
 * not yet taken, or taken and not yet answered on the page. Not what a stop dropped, nor what
 * its agent said was done or could not be done, nor anything from long ago.
 */
export function inHand(
  recent: { at: number; delivery: string; route?: string | null; outcome?: string | null }[] | undefined,
  answeredAt: number | null,
  running: boolean,
  now: number,
): boolean {
  if (running) return true
  const last = recent?.find((a) => a.delivery !== 'handed_off') ?? recent?.[0]
  if (!last || now - last.at > UNDER_WAY_MS || last.route === 'stopped') return false
  if (last.delivery !== 'handed_off') return true
  return (last.outcome === null || last.outcome === undefined || last.outcome === 'running') && !(answeredAt !== null && answeredAt > last.at)
}

/** How long what an agent said above a page is shown by itself. After that it is there for whoever opens the box. */
export const SAID_FOR_MS = 30 * 60_000

/**
 * What passes between a person at a page and the page's agent that needs nothing of the page
 * itself: the line the agent last said above the page, and a box to type to it in. The box is
 * a second way to the agent, beside what the page has for it, and what is typed in it goes as
 * anything done on the page goes: to the conversation the page belongs to, kept until it is
 * taken. So that someone at a display does not have to go to the agent's own window to say a
 * word, or to read one.
 */
function Talk({
  artifactId,
  agent,
  said,
  open,
  onClose,
}: {
  artifactId: Id<'artifacts'>
  agent: string | null
  said: { text: string; at: number } | null
  open: boolean
  onClose: () => void
}) {
  const convex = useConvex()
  const now = useNow()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLInputElement>(null)
  // One id for what is in the box until it has been taken, so that sending it twice over a
  // connection that dropped is one message. Not `randomUUID`, which a browser offers only to a
  // site it reached securely
  const fresh = () => `typed-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`
  const id = useRef(fresh())
  // The line a person closed stays closed, in this tab: the next thing the agent says is another line
  const closedKey = `it.said.${artifactId}`
  const [closed, setClosed] = useState(() => Number(sessionStorage.getItem(closedKey) ?? 0))
  useEffect(() => {
    if (open) box.current?.focus()
  }, [open])
  const line = said && said.at > closed && (open || now - said.at < SAID_FOR_MS) ? said : null
  if (!open && !line) return null
  const send = async () => {
    const typed = text.trim()
    if (!typed || sending) return
    setSending(true)
    setError('')
    try {
      await convex.mutation(api.actions.message, { artifactId, displayKey: displayKey(), clientActionId: id.current, text: typed })
      id.current = fresh()
      setText('')
    } catch (err) {
      // Left in the box, to be sent again: nothing of it is kept anywhere else
      setError(refusal(err).message)
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="page-talk">
      {line && (
        // Said aloud as it arrives, to whoever cannot see it
        <p className="page-talk-said" role="status">
          <b>{agent ?? 'Your agent'}</b>
          <span>{line.text}</span>
          <button
            type="button"
            className="page-talk-x"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => {
              sessionStorage.setItem(closedKey, String(line.at))
              setClosed(line.at)
            }}
          >
            <IconX />
          </button>
        </p>
      )}
      {open && (
        <form
          className="page-talk-form"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <input
            ref={box}
            className="page-talk-box"
            aria-label={`Type to ${agent ?? 'your agent'}`}
            placeholder={`Type to ${agent ?? 'your agent'}…`}
            autoComplete="off"
            maxLength={LIMITS.messageText}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Escape closes the box, and does not leave the page as it does anywhere else on the bar
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.nativeEvent.stopImmediatePropagation()
              onClose()
            }}
          />
          <button type="submit" className="page-talk-send" disabled={sending || !text.trim()} aria-label="Send" title="Send (enter)">
            <IconSend />
          </button>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
        </form>
      )}
    </div>
  )
}

/**
 * The page's agent is at work because It reopened its conversation, with nobody at the machine
 * to watch it: said in a word, with the one thing to do about it, which is to stop it.
 */
function Working({
  artifactId,
  stopping,
  user,
  machine,
  machineSeenAt,
  agent,
}: {
  artifactId: Id<'artifacts'>
  stopping: boolean
  user: string
  machine: string | null
  machineSeenAt: number | null
  agent: string | null
}) {
  const stop = useMutation(api.artifacts.stop)
  // A stop is It's to keep, and It has it only once It has answered. Until then it is in this
  // tab alone: it is said to be on its way, and not to have been asked
  const [sending, setSending] = useState(false)
  // It answers within a moment where it can be reached, and a sentence that came and went with
  // the answer would only flicker: the stop is said to be on its way once it has been for a while
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!sending) return setLate(false)
    const timer = setTimeout(() => setLate(true), SENDING_SAID_MS)
    return () => clearTimeout(timer)
  }, [sending])
  const [asked, setAsked] = useState(false)
  const ending = stopping || asked
  // What else was done on the page while it works: said, so that the person knows it is held and what a stop takes with it
  const recent = useQuery(api.actions.forArtifact, { artifactId })
  const more = Math.max(0, (recent?.filter((a) => a.delivery !== 'handed_off').length ?? 0) - 1)
  const now = useNow(1_000)
  useSyncExternalStore(watchOutbox, outboxChanges)
  // Something done here that this browser would not store is lost with the tab, whatever the agent is doing: said beside the rest
  const keepOpen = unsaved(user, artifactId) > 0 && (
    <span className="status" data-tone="wait">
      Not sent yet. This browser could not save it, so keep this tab open
    </span>
  )
  // That it is working is the machine's own word, and is as good as the machine is there to
  // give it: one that has gone quiet, or said it was stopping, may have ended the run or may
  // not, and cannot be told to stop until it is back. Said as that, and not as work going on.
  const askStop = () => {
    setSending(true)
    stop({ artifactId }).then(
      (said) => {
        setSending(false)
        // It may answer that nothing was running there to stop any more: the stop is offered again, until the bar goes with the run
        setAsked(said.stopping)
      },
      (err) => {
        setSending(false)
        say(refusal(err).message, 'error')
      },
    )
  }
  // A stop on its way is lost with the tab, as anything is that is nowhere but here: said beside
  // the rest until It has answered, or the page hears from It that the run is being stopped
  const sendingStop = sending && late && !ending && (
    <span className="status" data-tone="wait">
      Sending the stop. Keep this tab open until it is sent
    </span>
  )
  if (machineSeenAt === null || now - machineSeenAt >= ALIVE.onlineMs)
    return (
      <>
        <span className="status" data-tone="wait">
          {ending
            ? `Asked to stop. ${machine ?? 'Its machine'} is not answering, and is told when it is back`
            : `${machine ?? 'Its machine'} is not answering. Whether ${agent ?? 'your agent'} is still at work there is not known`}
        </span>
        {sendingStop}
        {keepOpen}
        {/* It can still be asked to stop: It keeps the asking, and the machine acts on it the moment it is back. Not a second time while one is on its way */}
        {!ending && !sending && (
          <button type="button" className="working-stop" title="Stop the agent when its machine is back" aria-label="Stop the agent" onClick={askStop}>
            <IconStop />
            Stop
          </button>
        )}
      </>
    )
  // What was done here and has not reached It is not with the agent that is working
  const notSent = unsent(user, artifactId)
  return (
    <>
      <span className="working" role="status">
        <span className="working-dot" data-ending={ending || undefined} />
        {ending ? 'Stopping' : more ? `Working, ${more} more waiting` : 'Working'}
        {notSent > 0 && `, and ${notSent} not sent yet`}
        {!ending && !sending && (
          <button
            type="button"
            className="working-stop"
            title={more ? 'Stop the agent. What is waiting goes with it.' : 'Stop the agent'}
            aria-label="Stop the agent"
            onClick={askStop}
          >
            <IconStop />
            Stop
          </button>
        )}
      </span>
      {sendingStop}
      {keepOpen}
    </>
  )
}

/** How long a stop has been on its way to It before the bar says so. */
export const SENDING_SAID_MS = 700

/** Where the last thing the person did has got to: saved here, accepted, or with the agent. */
function ActionStatus({
  artifactId,
  user,
  machine,
  machineSeenAt,
  machineGone,
  machinePaused,
  pending,
  wakes,
  agent,
  stoppedAt,
  stoppedSequence,
  wakeFailed,
  answeredAt,
}: {
  artifactId: Id<'artifacts'>
  user: string
  machine: string | null
  machineSeenAt: number | null
  /** The machine the page was made on is no longer one of the person's. */
  machineGone: boolean
  /** Why the page's machine, though it is there, hands nothing to an agent for now. Null where it does. */
  machinePaused: string | null
  /** How many things done on the page are waiting for its agent, as It counts them: all of them, however long ago they were done. */
  pending: number
  /** Where the page's agent app can have a closed conversation reopened: the machine that would, and whether that is switched on there. */
  wakes: { machineId: string; harness: string; on: boolean } | null
  agent: string | null
  /** When a person last stopped the page's agent, if they have. */
  stoppedAt: number | null
  stoppedSequence?: number | null
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
  // What still waits, of the last things done here, and how many wait in all: It's own count,
  // where more wait than the last few show
  const stillWaiting = recent?.filter((a) => a.delivery !== 'handed_off') ?? []
  const waiting = Math.max(stillWaiting.length, recent ? pending || 0 : 0)
  // The bar speaks of the last thing that is still waiting, where anything is: that something
  // done after it was dealt with does not make it so. Otherwise of the last thing done.
  const last = stillWaiting[0] ?? recent?.[0]
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
  if (!last) return null
  // Everything among the last things done was dealt with, and something older still waits
  if (last.delivery === 'handed_off' && waiting > 0)
    return (
      <span className="status" data-tone="wait">
        {`${waiting} earlier ${waiting === 1 ? 'thing' : 'things'} done here ${waiting === 1 ? 'is' : 'are'} still waiting for ${agent ?? 'your agent'}`}
      </span>
    )
  // What has been settled is said for ten minutes and then no more. What has not, something
  // still waiting for a machine or for an agent, is said for as long as it waits, with what
  // can be done about it: gone from the bar, it looked done when nothing had come of it.
  if (now - last.at > 10 * 60_000 && last.delivery === 'handed_off') return null
  // The agent was stopped after the last thing done here: said as that, whatever became of it.
  // What was waiting then went with the stop, and the next thing done reopens the conversation.
  // (Not of something its agent had already said was done, or could not be done: a stop that
  // came after that, on this page or another of the conversation's, changed nothing about it)
  const settled = last.delivery === 'handed_off' && last.route !== 'stopped' && (last.outcome === 'succeeded' || last.outcome === 'failed')
  if (
    (stoppedSequence != null
      ? last.sequence === undefined || last.sequence <= stoppedSequence
      : last.sequence === undefined && stoppedAt !== null && last.at <= stoppedAt) &&
    !settled
  ) {
    // Everything of that conversation's that was waiting went with the stop, and is said to have.
    // Each is counted by when it was dropped: what an earlier stop of the same conversation
    // dropped was done before this one too, and is none of this one's. (Functions from before
    // they said when leave only the hour before the stop to go by)
    const dropped = (recent ?? []).filter(
      (x) =>
        x.route === 'stopped' &&
        (stoppedSequence != null
          ? x.stoppedSequence === stoppedSequence
          : stoppedAt !== null && x.at <= stoppedAt && (x.handedAt == null ? stoppedAt - x.at < 3_600_000 : x.handedAt >= stoppedAt)),
    ).length
    return <span className="status">{dropped > 1 ? `Stopped, with ${dropped - 1} more that ${dropped === 2 ? 'was' : 'were'} waiting` : 'Stopped'}</span>
  }
  // Dropped by a stop the page no longer says the time of, having changed conversation or machine
  // since. The person stopped it all the same, and it is never said as something the agent could not do
  if (last.route === 'stopped') return <span className="status">Stopped</span>
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
  // Nothing is waited for on a machine that was removed: said as what it is, with what would get it to the agent
  if (machineGone)
    return (
      <span className="status" data-tone="wait">
        {`${machine ?? 'Its machine'} was removed from It. Your agent gets this when its conversation is open on one of your machines${waiting > 1 ? ` (${waiting})` : ''}`}
      </span>
    )
  // Judged against the backend's clock, and again every second: a machine that goes quiet changes nothing in the data
  const online = machineSeenAt !== null && now - machineSeenAt < ALIVE.onlineMs
  if (!online)
    return <span className="status" data-tone="wait">{`Waiting for ${machine ?? 'your machine'} to come online${waiting > 1 ? ` (${waiting})` : ''}`}</span>
  // Its machine is there and hands nothing over for now: said as that, before anything about
  // the conversation. Opening the conversation changes nothing, and neither does reopening it
  if (machinePaused)
    return (
      <span className="status" data-tone="wait">
        {machinePaused === 'unchecked'
          ? `Sent${waiting > 1 ? ` (${waiting})` : ''}. ${machine ?? 'Its machine'} is still asking It whether the two work together, and hands it to ${agent ?? 'your agent'} once it knows`
          : // Which of the two is behind is not known here: it may be this machine, or the one It runs on
            `Sent${waiting > 1 ? ` (${waiting})` : ''}. ${machine ?? 'Its machine'} and It are of versions that do not work together, so ${agent ?? 'your agent'} gets it once the one that is behind is updated. The Machines page says more`}
      </span>
    )
  // Sent, and not taken for a while: its conversation may be closed. The owner can switch on
  // the reopening of such conversations, here as under Machines, and it is so from then on
  const slow = now - last.at > WAKE_OFFER_MS
  // A machine has it in hand and has not been able to give it to the agent: the conversation is
  // open and at work on something else. With nobody holding it, nothing on that machine was
  // listening for it: the conversation is closed, or its app is not running.
  const busy = last.delivery === 'leased'
  // A conversation is reopened only for what was done in the last day. For anything older the
  // switch would change nothing, so it is not offered, and the bar says what would bring it
  const tooOld = now - last.at > WAKE_BACK_MS
  const offer = wakes && !wakes.on && slow && !busy && !tooOld
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
          : slow && tooOld
            ? `Sent more than a day ago${waiting > 1 ? ` (${waiting})` : ''}. ${agent ?? 'Your agent'} gets it when its conversation is next open`
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
