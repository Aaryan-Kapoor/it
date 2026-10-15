import { api, call } from './lib'

type Receipt = {
  job: string
  slug: string
  state: 'pending' | 'retrying' | 'completed'
  attempts: number
  nextAt: number | null
  completedAt: number | null
}

/** A request is not completion. Wait briefly, and leave a way to check the durable receipt. */
export async function deletePage(slug: string, status = false) {
  const requested = status ? null : await call<{ job: string } | null>('mutation', api.artifacts.remove, { slug })
  const job = requested?.job
  const hint = `Run \`it delete ${slug} --status\` to check again. It keeps trying while it is running.`
  const pending = { requested: slug, job: job ?? null, state: 'pending' as const, hint }
  // Earlier functions can accept a deletion without returning a receipt. That proves no completion.
  if (!status && !job)
    return { ...pending, hint: 'Deletion was requested, but this backend cannot confirm completion. Start It with the current backend functions.' }
  const until = performance.now() + 5000
  while (true) {
    let receipt: Receipt
    try {
      receipt = await call<Receipt>('query', api.deletions.get, job ? { job } : { slug })
    } catch (err) {
      if (status) throw err
      return { ...pending, hint: `Completion could not be checked. ${hint}` }
    }
    const result = {
      requested: slug,
      job: receipt.job,
      state: receipt.state,
      attempts: receipt.attempts,
      nextAt: receipt.nextAt,
      completedAt: receipt.completedAt,
    }
    if (receipt.state === 'completed') return { ...result, deleted: slug }
    if (status || receipt.state === 'retrying' || performance.now() >= until) return { ...result, hint }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
