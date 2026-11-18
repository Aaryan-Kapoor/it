// Two transactions that touched the same record at the same instant (a burst of publishes
// counted against one limit, say). The backend runs such a transaction again by itself a few
// times, and gives up on it, having done nothing, only when it keeps happening. An action, which
// is several transactions, asks again here for the one that was given up on: it alone knows
// which of its steps that was, and that nothing of that step was done.
export const clashed = (err: unknown): boolean => /changed while this mutation was being run/.test(String((err as Error)?.message ?? err))

/**
 * For how long a step that keeps being given up on is asked again. Callers that write one record
 * at the same moment are let through one after another, so the last of many is let through well
 * after the first, and on a machine with little to spare each asking takes seconds. A step is
 * given up on here, with the clash as the reason, once it has been asked for this long. Of those
 * that wait for a step asked for here, the one that waits the shortest is a machine asking for
 * its token, which gives It a quarter of a minute: so the asking that is under way when the time
 * is up still has five seconds to be answered in.
 */
export const CLASH_MS = 10_000

/** The time, and a wait, as an action has them: a test gives its own. */
const real = { now: () => Date.now(), pause: (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms)) }

export async function overClashes<T>(run: () => Promise<T>, clock: { now(): number; pause(ms: number): Promise<unknown> } = real): Promise<T> {
  const until = clock.now() + CLASH_MS
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (err) {
      // A little longer each time, up to about a second, and never the same for two callers:
      // those that clashed would otherwise all come back at the same moment, and clash again
      const wait = 50 + Math.random() * Math.min(150 * n, 1000)
      // Nothing is asked once the time is up, so nothing is waited for that would be
      if (!clashed(err) || clock.now() + wait >= until) throw err
      await clock.pause(wait)
      // A wait can end later than it was asked to, on a machine that was busy or asleep meanwhile: nothing is asked then either
      if (clock.now() >= until) throw err
    }
  }
}
