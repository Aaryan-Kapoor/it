// Where the things done on a page have got to, as every page is told, so that a page can show the
// person each stage that what they did goes through beside what they pressed: two of those stages
// only the site knows. It is told what the bar above the page goes by and no more: whether a turn
// of the page's conversation is running, and, of each of the last few actions, whether it was
// handed to the agent's conversation and what is known of the agent's turn for it.
import type { SiteToPage } from '@it/protocol'
import { atWorkNow, turnFor, type Work } from './pages'

/** How many of the newest actions a page is told of: it waits on one at a time in each of its parts. */
const NEWEST = 8

/** The message for a page, or none while what was done on it is still being asked for. */
export function progressFor(
  recent: { id: string; at: number; delivery: string; route?: string | null; outcome?: string | null; handedAt?: number | null }[] | undefined,
  work: Work | undefined,
  now: number,
): Extract<SiteToPage, { type: 'it:progress' }> | null {
  if (!recent) return null
  return {
    type: 'it:progress',
    working: atWorkNow(work, now),
    actions: recent
      .slice(0, NEWEST)
      .map((a) => ({ id: String(a.id), handed: a.delivery === 'handed_off', turn: a.delivery === 'handed_off' ? turnFor(a, work, now) : null })),
  }
}
