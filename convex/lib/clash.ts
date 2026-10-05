// Two transactions that touched the same record at the same instant (a burst of publishes
// counted against one limit, say). The backend runs such a transaction again by itself a few
// times, and gives up on it, having done nothing, only when it keeps happening. An action, which
// is several transactions, asks again here for the one that was given up on: it alone knows
// which of its steps that was, and that nothing of that step was done.
export const clashed = (err: unknown): boolean => /changed while this mutation was being run/.test(String((err as Error)?.message ?? err))

export async function overClashes<T>(run: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (err) {
      if (!clashed(err) || n > 3) throw err
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * n))
    }
  }
}
