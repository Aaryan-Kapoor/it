// Feed: the homepage as what happened, newest first and a day at a time. What still waits on the
// person is held at the top, and a rail beside the feed keeps the pinned pages, the agents at
// work and what each display is showing. For catching up after time away.

import { MESSAGE, NOUN } from '@it/protocol'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'
import { Answer, byNeed, Fix, NoMatch, Origin, PageLink, type Row, Shot, Status, Stop, tally, type ViewProps } from './home-parts'
import { agentName, ago, api } from './lib'

type Event = FunctionReturnType<typeof api.artifacts.activity>[number]
/** Things that happened to one page close together, said as one entry. */
type Entry = { row: Row; events: Event[] }

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** How many of what waits on the person are shown above the feed before the rest are asked for. */
const OPEN_SHOWN = 3
/** Events on one page within this long of each other are one entry. */
const TOGETHER_MS = 2 * HOUR

function dayOf(at: number, now: number): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (at >= start) return 'Today'
  if (at >= start - DAY) return 'Yesterday'
  if (at >= start - 6 * DAY) return 'Earlier this week'
  if (at >= start - 29 * DAY) return 'Earlier this month'
  return 'Older'
}

const when = (at: number, now: number) =>
  now - at < 6 * DAY
    ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })

/** What happened, in a sentence about the page. */
function said(e: Event, row: Row) {
  const app = agentName(row.agent) ?? 'Your agent'
  switch (e.kind) {
    case 'made':
      return `${app} made this ${NOUN.one}`
    case 'changed':
      return `${app} changed it${e.version ? `, version ${e.version}` : ''}`
    case 'said':
      return `${app} said “${e.text}”`
    case 'asked':
      return `${app} asked “${e.text}”`
    case 'answered':
      return `You answered “${e.text}”`
    case 'fault':
      return 'Its own script failed'
    default: {
      const did = e.text === MESSAGE ? `You wrote to ${app}` : `You pressed “${e.text}”`
      const outcome =
        e.outcome === 'stopped'
          ? 'stopped'
          : e.delivery !== 'handed_off'
            ? 'not taken yet'
            : e.outcome === 'failed'
              ? `${app} could not do it`
              : e.outcome === 'succeeded'
                ? 'done'
                : e.outcome === 'running'
                  ? `${app} has it`
                  : ''
      return outcome ? `${did}, ${outcome}` : did
    }
  }
}

const TONE: Record<string, string> = { asked: 'bad', fault: 'bad', said: 'ok', answered: 'calm', made: 'live', changed: 'calm', did: 'wait' }

export function Feed({ rows, now, query }: ViewProps) {
  const events = useQuery(api.artifacts.activity, {})
  const [allOpen, setAllOpen] = useState(false)
  const byId = new Map(rows.map((r) => [r.id as string, r]))
  const t = tally(rows)
  const needs = t.you.sort(byNeed)
  const busy = rows.filter((r) => r.att.need === 'working' || r.att.need === 'waiting').sort(byNeed)

  // Consecutive events on one page close in time become one entry, said by its newest
  const entries: Entry[] = []
  for (const e of events ?? []) {
    const row = byId.get(e.artifactId)
    if (!row) continue
    const prev = entries.at(-1)
    if (prev && prev.row.id === row.id && (prev.events.at(-1)?.at ?? 0) - e.at < TOGETHER_MS) prev.events.push(e)
    else entries.push({ row, events: [e] })
  }
  const days: [string, Entry[]][] = []
  for (const entry of entries) {
    const day = dayOf(entry.events[0]!.at, now)
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(entry)
    else days.push([day, [entry]])
  }
  const showing = rows.filter((r) => r.shownOn.length)

  return (
    <main className="grid-view h-view h-feed">
      <div className="h-feed-main">
        {rows.length === 0 && <NoMatch query={query} />}
        {needs.length > 0 && (
          <section className="h-feed-open" aria-label="Still waiting on you">
            <h2 className="h-day">Still waiting on you</h2>
            <ol className="h-events">
              {(allOpen ? needs : needs.slice(0, OPEN_SHOWN)).map((r) => (
                <li key={r.id} className="h-event h-event--open" data-tone={r.att.tone}>
                  <span className="h-event-when">{ago(r.att.since, now)}</span>
                  <span className="h-event-dot" />
                  <div className="h-event-main">
                    <PageLink page={r} className="h-event-title">
                      {r.title}
                    </PageLink>
                    <p className="h-event-said">{r.att.need === 'asked' ? `${agentName(r.agent) ?? 'Your agent'} asked “${r.att.line}”` : r.att.line}</p>
                    <Origin page={r} />
                  </div>
                  <div className="h-event-act">
                    <Fix row={r} />
                  </div>
                </li>
              ))}
            </ol>
            {needs.length > OPEN_SHOWN && (
              <button type="button" className="grid-empty-reset h-more" onClick={() => setAllOpen(!allOpen)}>
                {allOpen ? 'Show fewer' : `Show ${needs.length - OPEN_SHOWN} more waiting on you`}
              </button>
            )}
          </section>
        )}
        {events === undefined && <p className="h-nomatch" role="status" />}
        {days.map(([day, list]) => (
          <section key={day}>
            <h2 className="h-day">{day}</h2>
            <ol className="h-events">
              {list.map((entry) => {
                const e = entry.events[0]!
                const r = entry.row
                const pictured = e.kind === 'made' || e.kind === 'changed' || e.kind === 'said'
                return (
                  <li key={`${r.id}:${e.at}:${e.kind}`} className="h-event" data-tone={TONE[e.kind]} data-kind={e.kind}>
                    <span className="h-event-when">{when(e.at, now)}</span>
                    <span className="h-event-dot" />
                    <div className="h-event-main">
                      <PageLink page={r} className="h-event-title">
                        {r.title}
                      </PageLink>
                      <p className="h-event-said">{said(e, r)}</p>
                      {entry.events.length > 1 && (
                        <p className="h-event-more">
                          {entry.events
                            .slice(1, 3)
                            .map((x) => said(x, r))
                            .join(' · ') + (entry.events.length > 3 ? ` · and ${entry.events.length - 3} more` : '')}
                        </p>
                      )}
                      <Origin page={r} />
                      {e.kind === 'asked' && r.asks[0]?.text === e.text && <Answer page={r} />}
                    </div>
                    {pictured && (
                      <div className="h-event-shot">
                        <Shot page={r} label={false} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
      <aside className="h-feed-rail">
        {t.pinned.length > 0 && (
          <section>
            <h3 className="h-side-head">Pinned</h3>
            <ul className="h-mini">
              {t.pinned.map((r) => (
                <li key={r.id} className="h-mini-item">
                  <Shot page={r} label={false} className="h-mini-shot" />
                  <div>
                    <PageLink page={r} className="h-mini-title">
                      {r.title}
                    </PageLink>
                    <Status att={r.att} short />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {busy.length > 0 && (
          <section>
            <h3 className="h-side-head">With your agents</h3>
            {busy.map((r) => (
              <div key={r.id} className="h-rail-item h-rail-item--quiet">
                <PageLink page={r} className="h-rail-title">
                  {r.title}
                </PageLink>
                <Status att={r.att} />
                <Stop page={r} />
              </div>
            ))}
          </section>
        )}
        {showing.length > 0 && (
          <section>
            <h3 className="h-side-head">On your displays</h3>
            <ul className="h-shown">
              {showing.flatMap((r) =>
                r.shownOn.map((d) => (
                  <li key={`${d}:${r.id}`}>
                    <span className="h-shown-display">{d}</span>
                    <PageLink page={r} className="h-shown-page">
                      {r.title}
                    </PageLink>
                  </li>
                )),
              )}
            </ul>
          </section>
        )}
      </aside>
    </main>
  )
}
