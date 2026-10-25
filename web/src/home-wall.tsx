// Wall: the homepage as a dashboard to keep open on a screen across the room. The pages the
// person pinned are big live tiles, a band across the top counts what needs them and what their
// agents are doing, a rail beside the tiles answers what was asked, and a strip along the bottom
// shows what changed last of the rest.

import { NOUN } from '@it/protocol'
import type { CSSProperties } from 'react'
import { byNeed, Fix, NoMatch, Origin, PageLink, Shot, Status, Stop, tally, type ViewProps } from './home-parts'
import { ago } from './lib'

const STRIP = 8

export function Wall({ rows, now, query }: ViewProps) {
  const t = tally(rows)
  const needs = t.you.sort(byNeed)
  const busy = rows.filter((r) => r.att.need === 'working' || r.att.need === 'waiting').sort(byNeed)
  // Without pins the newest pages stand in, so that a wall is never empty
  const pinned = t.pinned.length ? t.pinned.sort((a, b) => Number(b.att.you) - Number(a.att.you) || b.updatedAt - a.updatedAt) : []
  const tiles = (pinned.length ? pinned : [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6)).slice(0, 9)
  const onTiles = new Set(tiles.map((r) => r.id))
  const strip = rows
    .filter((r) => !onTiles.has(r.id))
    .sort((a, b) => b.att.since - a.att.since)
    .slice(0, STRIP)
  const clock = new Date(now)

  return (
    <main className="h-view h-wall">
      <header className="h-wall-band">
        <Big n={needs.length} label="need you" tone={needs.length ? 'bad' : 'calm'} />
        <Big n={t.working} label="at work" tone={t.working ? 'live' : 'calm'} />
        <Big n={t.waiting} label="waiting on an agent" tone={t.waiting ? 'wait' : 'calm'} />
        <Big n={rows.length} label={NOUN.many} tone="calm" />
        <div className="h-wall-clock">
          <b className="h-wall-time">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
          <span className="h-wall-date">{clock.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span>
        </div>
      </header>
      {rows.length === 0 && <NoMatch query={query} />}
      <div className="h-wall-body">
        <section
          className="h-wall-tiles"
          aria-label={pinned.length ? 'Pinned' : 'Newest'}
          // The first tile takes two rows beside the next two, and the rest go three to a row under them
          style={{ '--rows': tiles.length <= 3 ? 2 : 2 + Math.ceil((tiles.length - 3) / 3) } as CSSProperties}
        >
          {tiles.map((r, i) => (
            <article key={r.id} className="h-tile" data-size={i === 0 ? 'xl' : i < 3 ? 'side' : 'm'} data-you={r.att.you || undefined} data-tone={r.att.tone}>
              <Shot page={r} big={i < 3} className="h-tile-shot">
                {r.att.need !== 'quiet' && r.att.need !== 'fresh' && (
                  <span className="h-pill" data-tone={r.att.tone}>
                    <Status att={r.att} short />
                  </span>
                )}
              </Shot>
              <div className="h-tile-cap">
                <PageLink page={r} className="h-tile-title" tabIndex={-1}>
                  {r.title}
                </PageLink>
                <Origin page={r} now={now} />
              </div>
            </article>
          ))}
          {!pinned.length && <p className="h-wall-hint">Pin {NOUN.many} to keep them here. Until then the newest are shown.</p>}
        </section>
        <aside className="h-wall-rail" aria-label="Needs you">
          <h2 className="h-rail-head">{needs.length ? 'Needs you' : 'Nothing needs you'}</h2>
          {needs.map((r) => (
            <div key={r.id} className="h-rail-item" data-tone={r.att.tone}>
              <div className="h-rail-top">
                <Status att={r.att} short />
                <span className="h-ago">{ago(r.att.since, now)}</span>
              </div>
              <PageLink page={r} className="h-rail-title">
                {r.title}
              </PageLink>
              <p className="h-rail-line">{r.att.need === 'asked' ? `“${r.att.line}”` : r.att.line}</p>
              <Fix row={r} />
            </div>
          ))}
          {busy.length > 0 && <h2 className="h-rail-head h-rail-head--sub">With your agents</h2>}
          {busy.map((r) => (
            <div key={r.id} className="h-rail-item h-rail-item--quiet">
              <PageLink page={r} className="h-rail-title">
                {r.title}
              </PageLink>
              <Status att={r.att} />
              <Stop page={r} />
            </div>
          ))}
        </aside>
      </div>
      {strip.length > 0 && (
        <section className="h-wall-strip" aria-label="Changed lately">
          {strip.map((r) => (
            <div key={r.id} className="h-strip-item">
              <Shot page={r} className="h-strip-shot" />
              <span className="h-strip-title">{r.title}</span>
              <span className="h-strip-ago">{ago(r.att.since, now)}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  )
}

function Big({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="h-wall-big" data-tone={tone}>
      <b className="h-wall-num">{n}</b>
      <span className="h-wall-what">{label}</span>
    </div>
  )
}
