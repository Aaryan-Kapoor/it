// Projects: the homepage as a workspace. Pages are grouped by the project they were made in (its
// git remote, or its folder) and within it by the conversation that made them, with a sidebar
// that narrows to what needs the person, what is pinned, a project, a machine or an agent app.

import { ALIVE, NOUN } from '@it/protocol'
import { type ReactNode, useState } from 'react'
import { byNeed, NoMatch, type Row, Tile, tally, type ViewProps } from './home-parts'
import { agentName, ago } from './lib'

type Scope = { kind: 'all' } | { kind: 'you' } | { kind: 'pinned' } | { kind: 'project' | 'machine' | 'agent'; value: string }

const NO_PROJECT = ''
const projectOf = (r: Row) => r.project?.key ?? NO_PROJECT
const conversationOf = (r: Row) => (r.session ? `${r.machineId ?? ''}:${r.session.harness}:${r.session.id}` : `page:${r.id}`)
const latest = (rows: Row[]) => Math.max(...rows.map((r) => Math.max(r.updatedAt, r.att.since)))

/** The rows grouped by a key, in the order given, each group in the order its rows came. */
function groups(rows: Row[], key: (r: Row) => string): [string, Row[]][] {
  const out = new Map<string, Row[]>()
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r])
  return [...out]
}

export function Projects({ rows, all, owner, now, query }: ViewProps) {
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const t = tally(rows)
  const projects = groups(rows, projectOf).sort(
    (a, b) => b[1].filter((r) => r.att.you).length - a[1].filter((r) => r.att.you).length || latest(b[1]) - latest(a[1]),
  )
  const machines = groups(
    rows.filter((r) => r.machine),
    (r) => r.machine as string,
  ).sort((a, b) => a[0].localeCompare(b[0]))
  const agents = groups(
    rows.filter((r) => r.agent),
    (r) => r.agent as string,
  ).sort((a, b) => b[1].length - a[1].length)
  const inScope = (r: Row) =>
    scope.kind === 'all' ||
    (scope.kind === 'you' && r.att.you) ||
    (scope.kind === 'pinned' && r.pinned) ||
    (scope.kind === 'project' && projectOf(r) === scope.value) ||
    (scope.kind === 'machine' && r.machine === scope.value) ||
    (scope.kind === 'agent' && r.agent === scope.value)
  const shown = projects.map(([key, rs]) => [key, rs.filter(inScope)] as const).filter(([, rs]) => rs.length > 0)
  const is = (s: Scope) => scope.kind === s.kind && ('value' in s ? 'value' in scope && scope.value === s.value : true)

  const item = (s: Scope, label: string, rs: Row[], extra?: ReactNode) => {
    const you = rs.filter((r) => r.att.you).length
    return (
      <li key={`${s.kind}:${'value' in s ? s.value : ''}`}>
        <button type="button" className="h-side-item" aria-pressed={is(s)} onClick={() => setScope(s)}>
          {extra}
          <span className="h-side-label">{label}</span>
          {you > 0 && s.kind !== 'you' && <span className="h-side-alert" title={`${you} need you`} />}
          <span className="h-side-count">{rs.length}</span>
        </button>
      </li>
    )
  }

  return (
    <main className="grid-view h-view h-projects">
      <aside className="h-side" aria-label="Narrow the pages">
        <ul className="h-side-list">
          {item({ kind: 'all' }, `All ${NOUN.many}`, rows)}
          {item({ kind: 'you' }, 'Needs you', t.you)}
          {item({ kind: 'pinned' }, 'Pinned', t.pinned)}
        </ul>
        <h3 className="h-side-head">Projects</h3>
        <ul className="h-side-list">
          {projects.map(([key, rs]) => item({ kind: 'project', value: key }, key === NO_PROJECT ? 'No project' : (rs[0]?.project?.name ?? key), rs))}
        </ul>
        <h3 className="h-side-head">Machines</h3>
        <ul className="h-side-list">
          {machines.map(([name, rs]) => {
            const seen = Math.max(...rs.map((r) => r.machineSeenAt ?? 0))
            const online = seen > 0 && now - seen < ALIVE.onlineMs
            return item({ kind: 'machine', value: name }, name, rs, <span className="h-side-dot" data-on={online} title={online ? 'Online' : 'Offline'} />)
          })}
        </ul>
        <h3 className="h-side-head">Agent apps</h3>
        <ul className="h-side-list">{agents.map(([agent, rs]) => item({ kind: 'agent', value: agent }, agentName(agent) ?? agent, rs))}</ul>
      </aside>

      <div className="h-proj-main">
        {rows.length === 0 && <NoMatch query={query} />}
        {shown.map(([key, rs]) => {
          const pt = tally(rs)
          const name = key === NO_PROJECT ? 'No project' : (rs[0]?.project?.name ?? key)
          const conversations = groups(
            [...rs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || byNeed(a, b) || b.updatedAt - a.updatedAt),
            conversationOf,
          ).sort((a, b) => Number(b[1].some((r) => r.att.you)) - Number(a[1].some((r) => r.att.you)) || latest(b[1]) - latest(a[1]))
          return (
            <section key={key} className="h-proj">
              <header className="h-proj-head">
                <h2 className="h-proj-name">{name}</h2>
                {key !== NO_PROJECT && key !== name && <span className="h-proj-key">{key}</span>}
                <span className="h-proj-facts">
                  {pt.you.length > 0 && <span className="h-chip" data-tone="bad">{`${pt.you.length} need${pt.you.length === 1 ? 's' : ''} you`}</span>}
                  {pt.working > 0 && <span className="h-chip" data-tone="live">{`${pt.working} working`}</span>}
                  <span className="h-chip">{`${rs.length} ${rs.length === 1 ? NOUN.one : NOUN.many}`}</span>
                  <span className="h-proj-ago">{`active ${ago(latest(rs), now)}`}</span>
                </span>
              </header>
              {conversations.map(([c, cs]) => {
                const first = cs[0]!
                const started = Math.min(...cs.map((r) => r.createdAt))
                return (
                  <div key={c} className="h-conv">
                    <div className="h-conv-head">
                      <span className="h-conv-agent">{agentName(first.agent) ?? 'An agent'}</span>
                      {first.machine && <span className="h-conv-on">on {first.machine}</span>}
                      <span className="h-conv-since">{`${cs.length} ${cs.length === 1 ? NOUN.one : NOUN.many}, since ${ago(started, now)}`}</span>
                      {cs.some((r) => r.att.need === 'working') && (
                        <span className="h-chip" data-tone="live">
                          Working
                        </span>
                      )}
                      {cs.some((r) => r.att.you) && (
                        <span
                          className="h-chip"
                          data-tone="bad"
                        >{`${cs.filter((r) => r.att.you).length} need${cs.filter((r) => r.att.you).length === 1 ? 's' : ''} you`}</span>
                      )}
                    </div>
                    <ul className="grid h-grid h-conv-grid">
                      {cs.map((r) => (
                        <Tile key={r.id} row={r} owner={owner} now={now} project={false} />
                      ))}
                    </ul>
                  </div>
                )
              })}
            </section>
          )
        })}
        {shown.length === 0 && rows.length > 0 && <p className="grid-empty-line h-nomatch">Nothing here.</p>}
        <p className="h-foot">{`${all} ${NOUN.many} in ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`}</p>
      </div>
    </main>
  )
}
