// Where the things done on a page have got to, as every page is told, so that a page can show the
// person each stage that what they did goes through beside what they pressed: two of those stages
// only the site knows. It is told what the bar above the page goes by and no more: whether a turn
// of the page's conversation is running, and, of each of the last few actions, whether it was
// handed to the agent's conversation and what is known of the agent's turn for it; and whether
// the conversation is open and has not loaded It's add-on, as the notice above the page says.
import { ALIVE, type SiteToPage } from '@it/protocol'
import { type Listening, notLoaded } from './listening'
import { atWorkNow, turnFor, type Work } from './pages'

/** How many of the newest actions a page is told of: it waits on one at a time in each of its parts. */
const NEWEST = 8

/** The message for a page, or none while what was done on it is still being asked for. */
export function progressFor(
  recent: { id: string; at: number; delivery: string; route?: string | null; outcome?: string | null; handedAt?: number | null }[] | undefined,
  work: Work | undefined,
  now: number,
  /** Whether the page's conversation can hear it, as the page's record says; undefined where functions from before they said it say nothing of it. */
  listening?: Listening,
): Extract<SiteToPage, { type: 'it:progress' }> | null {
  if (!recent) return null
  return {
    type: 'it:progress',
    working: atWorkNow(work, now),
    // By the machine's word while it stands, as the notice above the page lets it go (`standing`).
    // Not said at all where It cannot say, as while It is out of reach, when `work` is not given
    ...(listening !== undefined && work ? { notLoaded: notLoaded(listening) && work.machineSeenAt != null && now - work.machineSeenAt < ALIVE.onlineMs } : {}),
    actions: recent
      .slice(0, NEWEST)
      // What a stop dropped was handed to nobody, though it is no longer waiting either
      .map((a) => ({
        id: String(a.id),
        handed: a.delivery === 'handed_off' && a.route !== 'stopped',
        turn: a.delivery === 'handed_off' ? turnFor(a, work, now) : null,
      })),
  }
}
