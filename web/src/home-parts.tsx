// What every direction of the homepage is made of: what a page needs of the person, worked out
// from what `artifacts.home` says of it, and the small pieces each direction draws a page with.

import { ALIVE, NOUN } from '@it/protocol'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useState } from 'react'
import { IconPin, IconStop } from './brand'
import { agentName, ago, api, displayKey, type Id, navigate, refusal } from './lib'
import { say } from './notifications'
import { thisSession } from './outbox'
import { Preview } from './preview'

export type HomePage = FunctionReturnType<typeof api.artifacts.home>[number]

// ---------- what a page needs ----------

/**
 * What a page needs, most pressing first. The first four are the person's to do something
 * about: answer what an agent asked, see to a page whose script failed or whose agent could
 * not do what was asked, or get a click unstuck. The next two are an agent's: at work, or
 * holding something it has not answered yet. The last three only say how fresh the page is.
 */
export type Need = 'asked' | 'broken' | 'failed' | 'stuck' | 'working' | 'waiting' | 'said' | 'fresh' | 'quiet'
export interface Attention {
  need: Need
  /** What is said of it, in a sentence. */
  line: string
  /** Since when it has been so. */
  since: number
  tone: 'bad' | 'wait' | 'live' | 'ok' | 'calm'
  /** Whether it is the person's to do something about. */
  you: boolean
}
export const RANK: Record<Need, number> = { asked: 0, broken: 1, failed: 2, stuck: 3, working: 4, waiting: 5, said: 6, fresh: 7, quiet: 8 }
/** How long a click goes untaken before its conversation is taken to be closed. The page view offers to wake it after a few seconds; here it is given a minute. */
const UNHEARD_MS = 60_000
/** How long an agent's line is news, and how long a changed page is. */
const SAID_NEWS_MS = 48 * 3_600_000
const FRESH_MS = 6 * 3_600_000

export function attention(p: HomePage, now: number): Attention {
  const app = agentName(p.agent) ?? 'Your agent'
  const machine = p.machine ?? 'its machine'
  const ask = p.asks[0]
  if (ask) return { need: 'asked', line: ask.text, since: ask.at, tone: 'bad', you: true }
  if (p.faultAt !== null)
    return { need: 'broken', line: `The ${NOUN.one}’s own script failed, so it may not send what you do`, since: p.faultAt, tone: 'bad', you: true }
  const last = p.last
  if (last && last.delivery === 'handed_off' && last.outcome === 'failed' && last.route !== 'stopped' && p.answeredAt <= last.at)
    return { need: 'failed', line: `${app} could not do “${last.name}”`, since: last.at, tone: 'bad', you: true }
  if (p.pending > 0 && p.waitingSince !== null) {
    const n = p.pending > 1 ? ` (${p.pending})` : ''
    const since = p.waitingSince
    const stuck = (line: string): Attention => ({ need: 'stuck', line: line + n, since, tone: 'wait', you: true })
    if (p.machineGone) return stuck(`${machine} was removed from It`)
    if (p.machineSeenAt === null || now - p.machineSeenAt >= ALIVE.onlineMs) return stuck(`Waiting for ${machine} to come online`)
    if (p.machinePaused) return stuck(`${machine} and It are of versions that do not work together`)
    const state = p.connection?.state
    if (state === 'disconnected') return stuck(`${app} is not connected on ${machine}`)
    if (state === 'needs_approval') return stuck(`${app}’s add-on needs approval on ${machine}`)
    if (state && state !== 'connected' && state !== 'unknown') return stuck(`${app}’s add-on is not working on ${machine}`)
    if (p.wakeFailed && p.wakeFailed.at >= since) return stuck(`Couldn’t wake ${app}: ${p.wakeFailed.why}`)
    if (p.held) return { need: 'waiting', line: `${app} is busy, and gets it when it is free${n}`, since, tone: 'wait', you: false }
    if (now - since > UNHEARD_MS) return stuck(`${app} is not listening. Open its conversation`)
    return { need: 'waiting', line: `Sent. Waiting for ${app}${n}`, since, tone: 'wait', you: false }
  }
  if (p.run) return { need: 'working', line: p.run.stopping ? 'Stopping' : (p.said?.text ?? 'Working'), since: p.run.since, tone: 'live', you: false }
  if (last && last.delivery === 'handed_off' && last.outcome === 'running' && p.answeredAt < last.at && now - last.at < 10 * 60_000)
    return { need: 'working', line: `${app} has it`, since: last.at, tone: 'live', you: false }
  if (p.said && p.said.at > (last?.at ?? 0) && now - p.said.at < SAID_NEWS_MS)
    return { need: 'said', line: p.said.text, since: p.said.at, tone: 'ok', you: false }
  if (now - p.updatedAt < FRESH_MS) return { need: 'fresh', line: `Changed ${ago(p.updatedAt, now)}`, since: p.updatedAt, tone: 'calm', you: false }
  return { need: 'quiet', line: `Changed ${ago(p.updatedAt, now)}`, since: p.updatedAt, tone: 'calm', you: false }
}

export type Row = HomePage & { att: Attention }

/**
 * A conversation that It reopened is at work for every page it made at once. It is said to be
 * working on the one of them it was last busy with, and the others are left as they are.
 */
export function oneRunEach(pages: HomePage[]): HomePage[] {
  const conversation = (p: HomePage) => (p.session ? `${p.machineId}:${p.session.harness}:${p.session.id}` : null)
  const busiest = new Map<string, { id: string; at: number }>()
  for (const p of pages) {
    const c = conversation(p)
    const at = Math.max(p.last?.at ?? 0, p.updatedAt)
    if (p.run && c && (busiest.get(c)?.at ?? -1) < at) busiest.set(c, { id: p.id, at })
  }
  return pages.map((p) => (p.run && busiest.get(conversation(p) ?? '')?.id !== p.id ? { ...p, run: null } : p))
}

/** Most pressing first, and of two equally pressing the one that has waited longest. */
export const byNeed = (a: Row, b: Row) => RANK[a.att.need] - RANK[b.att.need] || (a.att.you ? a.att.since - b.att.since : b.att.since - a.att.since)

export interface ViewProps {
  rows: Row[]
  /** How many pages there are, before the search. */
  all: number
  owner: boolean
  now: number
  query: string
}

// ---------- the pieces every direction uses ----------

/** A hue for a page, from its id, as the grid gives one. */
export function hueOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % 360
}

const open = (slug: string) => (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  navigate(`/p/${slug}`)
}

/** A link that opens a page. */
export function PageLink({ page, className, children, tabIndex }: { page: HomePage; className?: string; children: ReactNode; tabIndex?: number }) {
  return (
    <a href={`/p/${page.slug}`} className={className} onClick={open(page.slug)} tabIndex={tabIndex}>
      {children}
    </a>
  )
}

/** The picture of a page: the page itself, small, or its cover while it is not shown. `big` draws it at half size, for a tile a wall is looked at from across the room. */
export function Shot({
  page,
  big = false,
  children,
  label = true,
  className = '',
}: {
  page: HomePage
  big?: boolean
  children?: ReactNode
  label?: boolean
  className?: string
}) {
  return (
    <a
      href={`/p/${page.slug}`}
      className={`cover card-preview h-shot${big ? ' h-shot--big' : ''} ${className}`}
      aria-label={label ? page.title : undefined}
      tabIndex={label ? undefined : -1}
      onClick={open(page.slug)}
    >
      <Preview
        key={`${page.id}:${page.version}`}
        artifactId={page.id as Id<'artifacts'>}
        title={page.title}
        cover={
          <span className="card-fallback card-fallback--bare" style={{ '--seed-h': hueOf(page.id) } as CSSProperties}>
            <span className="card-fallback-kind">{agentName(page.agent) ?? NOUN.One}</span>
          </span>
        }
      />
      {children}
    </a>
  )
}

/** What a page needs, as a dot and a few words. */
export function Status({ att, short = false }: { att: Attention; short?: boolean }) {
  const label: Record<Need, string> = {
    asked: 'Asked you',
    broken: 'Page error',
    failed: 'Failed',
    stuck: 'Stuck',
    working: 'Working',
    waiting: 'Waiting',
    said: 'New note',
    fresh: 'Changed',
    quiet: 'Quiet',
  }
  return (
    <span className="h-status" data-tone={att.tone} data-need={att.need}>
      <span className="h-dot" />
      {short && att.need !== 'quiet' && att.need !== 'fresh' ? label[att.need] : att.line}
    </span>
  )
}

/** Where a page comes from: its project, agent app and machine. */
export function Origin({ page, project = true, now }: { page: HomePage; project?: boolean; now?: number }) {
  return (
    <span className="h-origin">
      {[project ? page.project?.name : null, agentName(page.agent), page.machine, now !== undefined ? ago(page.updatedAt, now) : null]
        .filter(Boolean)
        .join(' · ')}
    </span>
  )
}

/** The buttons of what an agent asked about a page, which answer it from here. */
export function Answer({ page, compact = false }: { page: HomePage; compact?: boolean }) {
  const answer = useMutation(api.notifications.answer)
  const [sent, setSent] = useState<string | null>(null)
  const ask = page.asks[0]
  if (!ask) return null
  if (sent) return <span className="h-answered">Sent “{sent}”</span>
  return (
    <span className={`h-answer${compact ? ' h-answer--compact' : ''}`}>
      {ask.buttons.map((b, i) => (
        <button
          key={b.action}
          type="button"
          className={i === 0 ? 'h-btn h-btn--primary' : 'h-btn'}
          onClick={(e) => {
            e.stopPropagation()
            setSent(b.label)
            answer({ id: ask.id, action: b.action, displayKey: displayKey(), expectedSession: thisSession() }).catch((err) => {
              setSent(null)
              say(refusal(err).message, 'error')
            })
          }}
        >
          {b.label}
        </button>
      ))}
    </span>
  )
}

/** Stops the agent It reopened for a page. */
export function Stop({ page }: { page: HomePage }) {
  const stop = useMutation(api.artifacts.stop)
  const [asked, setAsked] = useState(false)
  if (!page.run || page.run.stopping || asked) return null
  return (
    <button
      type="button"
      className="h-btn h-btn--quiet"
      title="Stop the agent"
      onClick={(e) => {
        e.stopPropagation()
        setAsked(true)
        stop({ artifactId: page.id as Id<'artifacts'>, expectedRun: page.run?.identity, expectedSession: thisSession() }).catch((err) => {
          setAsked(false)
          say(refusal(err).message, 'error')
        })
      }}
    >
      <IconStop /> Stop
    </button>
  )
}

/** Pins a page, or unpins it. The owner's alone. */
export function PinButton({ page, owner }: { page: HomePage; owner: boolean }) {
  const organize = useMutation(api.artifacts.organize)
  if (!owner) return null
  return (
    <button
      type="button"
      className="h-icon-btn"
      aria-pressed={page.pinned}
      title={page.pinned ? 'Unpin' : 'Pin'}
      aria-label={page.pinned ? 'Unpin' : 'Pin'}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        organize({ artifactId: page.id as Id<'artifacts'>, pinned: !page.pinned }).catch((err) => say(refusal(err).message, 'error'))
      }}
    >
      <IconPin />
    </button>
  )
}

/** What can be done about a page from where it is listed: answer it, stop it, or go where it is put right. */
export function Fix({ row }: { row: Row }) {
  if (row.att.need === 'asked') return <Answer page={row} />
  if (row.att.need === 'working') return <Stop page={row} />
  if (row.att.need === 'stuck' && /come online|not connected|add-on|versions/.test(row.att.line))
    return (
      <a
        className="h-btn"
        href="/machines"
        onClick={(e) => {
          e.preventDefault()
          navigate('/machines')
        }}
      >
        Machines
      </a>
    )
  return (
    <PageLink page={row} className="h-btn">
      Open
    </PageLink>
  )
}

/** A card as the grid draws one, with what the page needs over its picture. */
export function Tile({ row, owner, now, project = true, big = false }: { row: Row; owner: boolean; now: number; project?: boolean; big?: boolean }) {
  return (
    <li className="page-card h-card" data-need={row.att.need} data-you={row.att.you || undefined}>
      <div className="card-frame-box">
        <Shot page={row} big={big}>
          {row.att.need !== 'quiet' && row.att.need !== 'fresh' && (
            <span className="h-pill" data-tone={row.att.tone}>
              <span className="h-dot" />
              <Status att={row.att} short />
            </span>
          )}
        </Shot>
        <span className="h-card-tools">
          <PinButton page={row} owner={owner} />
        </span>
      </div>
      <div className="caption card-body">
        <div className="card-text">
          <PageLink page={row} className="card-title" tabIndex={-1}>
            {row.pinned && <span className="card-pin" role="img" aria-label="Pinned" />}
            {row.title}
          </PageLink>
          <span className="card-meta card-sub">
            <Origin page={row} project={project} now={now} />
          </span>
        </div>
      </div>
    </li>
  )
}

/** Moves between the rows of a direction with j and k, opens one with Enter and pins it with p. */
export function useKeys(owner: boolean) {
  const organize = useMutation(api.artifacts.organize)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const at = document.activeElement
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || document.querySelector('[role="dialog"]')) return
      const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')]
      const here = rows.findIndex((r) => r === at || r.contains(at))
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        const next = rows[Math.max(0, Math.min(rows.length - 1, here + (e.key === 'j' ? 1 : -1)))] ?? rows[0]
        next?.focus()
        next?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && here >= 0 && rows[here] === at) {
        e.preventDefault()
        navigate(`/p/${rows[here]!.dataset.row}`)
      } else if (e.key === 'p' && here >= 0 && owner) {
        const id = rows[here]!.dataset.id
        if (id)
          organize({ artifactId: id as Id<'artifacts'>, pinned: rows[here]!.dataset.pinned !== 'true' }).catch((err) => say(refusal(err).message, 'error'))
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [owner, organize])
}

/** Who and how many, for the line over a direction. */
export function tally(rows: Row[]) {
  const you = rows.filter((r) => r.att.you)
  return {
    you,
    asked: you.filter((r) => r.att.need === 'asked').length,
    working: rows.filter((r) => r.att.need === 'working').length,
    waiting: rows.filter((r) => r.att.need === 'waiting').length,
    pinned: rows.filter((r) => r.pinned),
  }
}

/** The search found nothing. */
export function NoMatch({ query }: { query: string }) {
  return <p className="grid-empty-line h-nomatch">{`No ${NOUN.many} match “${query}”`}</p>
}
