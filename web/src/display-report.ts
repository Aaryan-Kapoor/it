/** Reports the host's current tab. Page messages cannot choose a display, tab, or mount. */
export type PagePhase = 'none' | 'loading' | 'shown' | 'failed'
export type DisplayReport = { tab: string; sequence: number; phase: PagePhase; mountId?: string; visible: boolean }
let current: { phase: PagePhase; mountId?: string } = { phase: 'none' }
const listeners = new Set<() => void>()

export function reportPage(phase: PagePhase, mountId?: string): void {
  current = { phase, ...(mountId ? { mountId } : {}) }
  for (const changed of listeners) changed()
}

/** A new tab identity on every load avoids cloned session storage and out-of-order reports. */
export function startDisplayReports(send: (report: DisplayReport) => Promise<unknown>): () => void {
  // Random bytes and not `randomUUID`, which a browser offers only to a site it counts as secure:
  // a display that reached It over plain http has to report too
  const tab = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  let sequence = 0
  let stopped = false
  const report = (closed = false) => {
    if (stopped) return
    const state = closed ? { phase: 'none' as const } : current
    void send({ tab, sequence: ++sequence, ...state, visible: !closed && document.visibilityState === 'visible' }).catch(() => {})
  }
  const changed = () => report()
  const leaving = () => report(true)
  listeners.add(changed)
  document.addEventListener('visibilitychange', changed)
  window.addEventListener('pagehide', leaving)
  window.addEventListener('pageshow', changed)
  window.addEventListener('online', changed)
  const interval = setInterval(changed, 30_000)
  report()
  return () => {
    report(true)
    stopped = true
    clearInterval(interval)
    listeners.delete(changed)
    document.removeEventListener('visibilitychange', changed)
    window.removeEventListener('pagehide', leaving)
    window.removeEventListener('pageshow', changed)
    window.removeEventListener('online', changed)
  }
}
