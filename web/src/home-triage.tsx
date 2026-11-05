// Triage: the homepage as an inbox. What needs the person comes first, a row each with what it
// needs and the button that does it; then what is with their agents, what they pinned, what
// changed today, and everything else as a plain list.

import { NOUN } from '@it/protocol'
import { useState } from 'react'
import { byNeed, Fix, NoMatch, Origin, PageLink, PinButton, type Row, Shot, Status, Stop, Tile, tally, useKeys, type ViewProps } from './home-parts'
import { ago } from './lib'

const DAY = 24 * 3_600_000
const REST_SHOWN = 10

export function Triage({ rows, all, owner, now, query }: ViewProps) {
  useKeys(owner)
  const [more, setMore] = useState(false)
  const t = tally(rows)
  const needs = t.you.sort(byNeed)
  // What wants a decision is drawn with its picture. A click stuck on its way is put right elsewhere, and is a line
  const decide = needs.filter((r) => r.att.need !== 'stuck')
  const stuck = needs.filter((r) => r.att.need === 'stuck')
  const busy = rows.filter((r) => r.att.need === 'working' || r.att.need === 'waiting').sort(byNeed)
  const placed = new Set([...needs, ...busy].map((r) => r.id))
  const pinned = rows.filter((r) => r.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = rows
    .filter((r) => !placed.has(r.id) && !r.pinned && now - Math.max(r.updatedAt, r.said?.at ?? 0) < DAY)
    .sort((a, b) => b.att.since - a.att.since)
  for (const r of [...pinned, ...recent]) placed.add(r.id)
  const rest = rows.filter((r) => !placed.has(r.id)).sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <main className="grid-view h-view h-triage">
      <header className="h-head">
        <h1 className="h-hello">{needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'}</h1>
        <p className="h-sub">
          {[
            t.asked && `${t.asked} ${t.asked === 1 ? 'question' : 'questions'} from your agents`,
            t.working && `${t.working} at work`,
            t.waiting && `${t.waiting} waiting on an agent`,
            `${all} ${NOUN.many}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      {rows.length === 0 && <NoMatch query={query} />}

      {decide.length > 0 && (
        <section className="h-sec" aria-label="Needs you">
          <ol className="h-needs">
            {decide.map((r) => (
              <NeedRow key={r.id} row={r} owner={owner} now={now} />
            ))}
          </ol>
        </section>
      )}

      {stuck.length > 0 && (
        <section className="h-sec">
          <h2 className="h-sec-title">Stuck on the way to an agent</h2>
          <ul className="h-list h-stuck">
            {stuck.map((r) => (
              <li key={r.id} className="h-list-row h-stuck-row" data-row={r.slug} data-id={r.id} data-pinned={r.pinned} data-tone={r.att.tone} tabIndex={-1}>
                <PageLink page={r} className="h-row-title">
                  {r.title}
                </PageLink>
                <Status att={r.att} />
                <span className="h-ago">{ago(r.att.since, now)}</span>
                <Fix row={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {busy.length > 0 && (
        <section className="h-sec">
          <h2 className="h-sec-title">With your agents</h2>
          <ul className="h-busy">
            {busy.map((r) => (
              <li key={r.id} className="h-busy-item" data-row={r.slug} data-id={r.id} data-pinned={r.pinned} tabIndex={-1}>
                <Shot page={r} label={false} className="h-busy-shot" />
                <div className="h-busy-main">
                  <PageLink page={r} className="h-row-title">
                    {r.title}
                  </PageLink>
                  <Status att={r.att} />
                  <Origin page={r} />
                </div>
                <Stop page={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {pinned.length > 0 && (
        <section className="h-sec">
          <h2 className="h-sec-title">Pinned</h2>
          <ul className="grid h-grid">
            {pinned.map((r) => (
              <Tile key={r.id} row={r} owner={owner} now={now} />
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="h-sec">
          <h2 className="h-sec-title">Changed today</h2>
          <ul className="grid h-grid">
            {recent.map((r) => (
              <Tile key={r.id} row={r} owner={owner} now={now} />
            ))}
          </ul>
        </section>
      )}

      {rest.length > 0 && (
        <section className="h-sec">
          <h2 className="h-sec-title">
            Everything else <span className="h-count">{rest.length}</span>
          </h2>
          <ul className="h-list">
            {(more ? rest : rest.slice(0, REST_SHOWN)).map((r) => (
              <li key={r.id} className="h-list-row" data-row={r.slug} data-id={r.id} data-pinned={r.pinned} tabIndex={-1}>
                <PageLink page={r} className="h-row-title">
                  {r.title}
                </PageLink>
                <Origin page={r} />
                <span className="h-ago">{ago(r.updatedAt, now)}</span>
                <PinButton page={r} owner={owner} />
              </li>
            ))}
          </ul>
          {rest.length > REST_SHOWN && (
            <button type="button" className="grid-empty-reset h-more" onClick={() => setMore(!more)}>
              {more ? 'Show fewer' : `Show ${rest.length - REST_SHOWN} more`}
            </button>
          )}
        </section>
      )}
      <p className="h-keys" aria-hidden="true">
        <kbd>j</kbd> <kbd>k</kbd> move · <kbd>enter</kbd> opens · <kbd>p</kbd> pins
      </p>
    </main>
  )
}

function NeedRow({ row, owner, now }: { row: Row; owner: boolean; now: number }) {
  return (
    <li className="h-need" data-row={row.slug} data-id={row.id} data-pinned={row.pinned} data-tone={row.att.tone} tabIndex={-1}>
      <Shot page={row} label={false} className="h-need-shot" />
      <div className="h-need-main">
        <div className="h-need-top">
          <Status att={row.att} short />
          <span className="h-ago">{ago(row.att.since, now)}</span>
          {row.pinned && <span className="card-pin" role="img" aria-label="Pinned" />}
        </div>
        <PageLink page={row} className="h-need-title">
          {row.title}
        </PageLink>
        <Origin page={row} />
        <p className="h-need-line">{row.att.need === 'asked' ? `“${row.att.line}”` : row.att.line}</p>
      </div>
      <div className="h-need-act">
        <Fix row={row} />
        <PinButton page={row} owner={owner} />
      </div>
    </li>
  )
}
