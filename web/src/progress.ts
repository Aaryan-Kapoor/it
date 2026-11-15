// Where the things done on a page have got to, as a page of It's own tour is told: the tour's
// first page shows the person each stage that what they did goes through, and two of those
// stages only the site knows. It is told what the bar above the page goes by and no more:
// whether each of the last few actions was handed to the agent's conversation, and what is
// known of the agent's turn for it. A page that is not the tour's is told nothing.
import type { SiteToPage } from '@it/protocol'
import { turnFor, type Work } from './pages'

/** How many of the newest actions a page is told of: it waits on one at a time in each of its parts. */
const NEWEST = 8

/** The message for a page, or none where the page is not the tour's first or nothing has been done on it yet. */
export function progressFor(
  tour: string | null | undefined,
  recent: { id: string; at: number; delivery: string; route?: string | null; outcome?: string | null; handedAt?: number | null }[] | undefined,
  work: Work | undefined,
  now: number,
): Extract<SiteToPage, { type: 'it:progress' }> | null {
  if (tour !== 'start' || !recent?.length) return null
  return {
    type: 'it:progress',
    actions: recent
      .slice(0, NEWEST)
      .map((a) => ({ id: String(a.id), handed: a.delivery === 'handed_off', turn: a.delivery === 'handed_off' ? turnFor(a, work, now) : null })),
  }
}
