// The homepage, in the ways it is being tried out: the grid there has always been, and four
// directions that sort the person's pages by what each needs of them. Which one is shown is
// chosen with `?home=<name>`, kept in this browser, and changed from the switch at the bottom.
// What each direction shows comes from `artifacts.home`, which reads only what It keeps today.

import { useQuery } from 'convex/react'
import { type ReactNode, useMemo, useState } from 'react'
import { Feed } from './home-feed'
import { attention, type HomePage, oneRunEach } from './home-parts'
import { Projects } from './home-projects'
import { Triage } from './home-triage'
import { Wall } from './home-wall'
import { agentName, api, displayKey, useNow } from './lib'
import { type Card, Grid } from './pages'
import './home.css'

export const HOMES = ['grid', 'triage', 'projects', 'wall', 'feed'] as const
export type HomeName = (typeof HOMES)[number]
const LABELS: Record<HomeName, string> = { grid: 'Grid', triage: 'Triage', projects: 'Projects', wall: 'Wall', feed: 'Feed' }
const CHOSEN = 'it.home'
const isHome = (x: unknown): x is HomeName => (HOMES as readonly unknown[]).includes(x)

/** The direction this browser shows: the one the address asks for, or the one it was last shown. */
function chosen(): HomeName {
  const asked = new URLSearchParams(location.search).get('home')
  if (isHome(asked)) localStorage.setItem(CHOSEN, asked)
  const kept = localStorage.getItem(CHOSEN)
  return isHome(kept) ? kept : 'grid'
}

/** A page matches what is typed in the search when its title, id, project, agent app or machine has it. */
const matches = (p: HomePage, q: string) => !q || [p.title, p.slug, p.project?.name, agentName(p.agent), p.machine].some((x) => x?.toLowerCase().includes(q))

// ---------- the homepage ----------

export function Home({ pages, owner, query, onQuery }: { pages: Card[] | undefined; owner: boolean; query: string; onQuery: (q: string) => void }) {
  const [name, setName] = useState(chosen)
  const bare = new URLSearchParams(location.search).get('switch') === '0'
  const pick = (next: HomeName) => {
    localStorage.setItem(CHOSEN, next)
    setName(next)
  }
  return (
    <>
      {name === 'grid' ? (
        <Grid pages={pages} owner={owner} query={query} onQuery={onQuery} />
      ) : (
        <Showcase name={name} owner={owner} query={query} fallback={<Grid pages={pages} owner={owner} query={query} onQuery={onQuery} />} />
      )}
      {!bare && <Switch name={name} onPick={pick} />}
    </>
  )
}

/** The switch between directions, which is only here while one is being chosen. */
function Switch({ name, onPick }: { name: HomeName; onPick: (n: HomeName) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggles, which a fieldset would draw a box around
    <div className="h-switch" role="group" aria-label="Homepage direction">
      <span className="h-switch-label">Homepage</span>
      {HOMES.map((h) => (
        <button key={h} type="button" className="h-switch-btn" aria-pressed={name === h} onClick={() => onPick(h)}>
          {LABELS[h]}
        </button>
      ))}
    </div>
  )
}

function Showcase({ name, owner, query, fallback }: { name: Exclude<HomeName, 'grid'>; owner: boolean; query: string; fallback: ReactNode }) {
  const pages = useQuery(api.artifacts.home, { key: displayKey() })
  const now = useNow(5_000)
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return oneRunEach(pages ?? [])
      .filter((p) => matches(p, q))
      .map((p) => ({ ...p, att: attention(p, now) }))
  }, [pages, query, now])
  if (pages === undefined) return <main className="grid-view" role="status" />
  // With nothing yet, every direction is the grid's welcome
  if (pages.length === 0) return fallback
  const props = { rows, all: pages.length, owner, now, query: query.trim() }
  if (name === 'triage') return <Triage {...props} />
  if (name === 'projects') return <Projects {...props} />
  if (name === 'wall') return <Wall {...props} />
  return <Feed {...props} />
}
