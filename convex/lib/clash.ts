// Two transactions that touched the same record at the same instant (a burst of publishes
// counted against one limit, say). The backend runs such a transaction again by itself a few
// times, and gives up on it, having done nothing, only when it keeps happening. An action, which
// is several transactions, asks again here for the one that was given up on: it alone knows
// which of its steps that was, and that nothing of that step was done.
export const clashed = (err: unknown): boolean => /changed while this mutation was being run/.test(String((err as Error)?.message ?? err))

// The backend turned a step away because it had more to run, or more to write down, than it
// could get to in time: its queue of functions let the step go before it ran, or its queue of
// writes was full. That comes of many callers at once on a machine with little to spare, as
// those that clash do, and nothing of the step was done, so it is asked again here as they are.
export const turnedAway = (err: unknown): boolean =>
  /Too many concurrent (requests|commits) in a short period of time/.test(String((err as Error)?.message ?? err))

/**
 * For how long an action asks again for a step that keeps being given up on or turned away.
 * Callers that write one record at the same moment are let through one after another, so the
 * last of many is let through well after the first, and on a machine with little to spare, or
 * whose disk is busy, each of them takes a good part of a second. A step is given up on here,
 * with the backend's reason, once it has been asked for this long. Of those that wait for an
 * action, the command waits the least, a minute and a half: so the asking under way when the
 * time is up still has half a minute to be answered in.
 */
export const CLASH_MS = 60_000

/**
 * The same for a route. The site, and a machine that is joining, wait a third of a minute for
 * the routes that ask again, and the door half a minute for any route: so the asking under way
 * when the time is up still has five seconds. A route whose caller waits less gives less.
 */
export const ROUTE_CLASH_MS = 15_000

/** The time, and a wait, as an action has them: a test gives its own. */
const real = { now: () => Date.now(), pause: (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms)) }

export async function overClashes<T>(
  run: () => Promise<T>,
  { within = CLASH_MS, now = real.now, pause = real.pause }: { within?: number; now?: () => number; pause?: (ms: number) => Promise<unknown> } = {},
): Promise<T> {
  const until = now() + within
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (err) {
      // A little longer each time, up to about a second, and never the same for two callers:
      // those that clashed would otherwise all come back at the same moment, and clash again
      const wait = 50 + Math.random() * Math.min(150 * n, 1000)
      // Nothing is asked once the time is up, so nothing is waited for that would be
      if (!(clashed(err) || turnedAway(err)) || now() + wait >= until) throw err
      await pause(wait)
      // A wait can end later than it was asked to, on a machine that was busy or asleep meanwhile: nothing is asked then either
      if (now() >= until) throw err
    }
  }
}
