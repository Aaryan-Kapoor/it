import { api, call, handed, live, Problem } from './lib'
import { type Listed, printed } from './wait'

/** Observe one page without claiming, handing off, or acknowledging its actions. */
export async function watchActions(slug: string): Promise<void> {
  await call('query', api.artifacts.get, { slug })
  const client = live()
  const seen = new Set<string>()
  let stopped = false
  let work = Promise.resolve()
  let finish!: () => void
  let failed = false
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const stop = () => {
    stopped = true
    finish()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const unwatch = client.onUpdate(
    api.delivery.waiting,
    { slug },
    (actions: Listed[]) => {
      if (stopped) return
      work = work
        .then(async () => {
          for (const action of actions) {
            if (stopped || seen.has(action.id)) continue
            if (!(await handed(process.stdout, `${JSON.stringify(printed(action))}\n`))) throw new Error('output_failed')
            seen.add(action.id)
            if (seen.size > 5000) seen.delete(seen.values().next().value!)
          }
        })
        .catch(() => {
          failed = true
          stop()
        })
    },
    () => {
      failed = true
      stop()
    },
  )
  try {
    await ended
    await work
  } finally {
    unwatch()
    await client.close()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
  if (failed) throw new Problem('The action observation stream ended unexpectedly.', 'offline')
}
