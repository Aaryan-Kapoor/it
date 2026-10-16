// Requests that automatic recovery must not interrupt. Ending a pairing deliberately clears them.
const pending = new Map<symbol, string>()
const watchers = new Set<() => void>()
const changed = () => {
  for (const watch of watchers) watch()
}
export const hasPending = (): boolean => pending.size > 0
export function watchPending(watch: () => void): () => void {
  watchers.add(watch)
  return () => void watchers.delete(watch)
}
export function holdPending(user: string): () => void {
  const key = Symbol()
  pending.set(key, user)
  changed()
  return () => {
    if (pending.delete(key)) changed()
  }
}
export function discardPending(user?: string): void {
  let removed = false
  for (const [key, owner] of pending) if (user === undefined || user === owner) removed = pending.delete(key) || removed
  if (removed) queueMicrotask(changed)
}
