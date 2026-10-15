import { ADDONS } from './addons.generated'

export interface AddonRuntime {
  state: 'active' | 'inactive' | 'unverified' | 'incompatible'
  version?: string
  idle?: boolean
  detail: string
}

interface Loaded {
  at: number
  runtime: AddonRuntime
  idle: boolean
}

/** This is the local add-on contract, separate from the machine and page protocols. */
export const ADDON_API = 1
const RECENT_MS = 30_000

export class AddonRuntimes {
  private loaded = new Map<string, Loaded>()

  hear(harness: string, instance: unknown, value: unknown, now = performance.now()): AddonRuntime | undefined {
    if (!ADDONS[harness] || typeof instance !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(instance)) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const v = value as { version?: unknown; api?: unknown; delivery?: unknown; idle?: unknown; missing?: unknown }
    if (typeof v.version !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(v.version)) return undefined
    const names: Record<string, string> = {
      session: 'identify a conversation',
      submit: 'submit a message',
      clock: 'schedule polling',
      dispatch: 'dispatch a message',
      settings: 'read its settings',
    }
    const missing = Array.isArray(v.missing)
      ? v.missing
          .filter((m): m is string => typeof m === 'string' && Object.hasOwn(names, m))
          .map((m) => names[m])
          .join(', ')
      : ''
    const runtime: AddonRuntime =
      v.api !== ADDON_API
        ? {
            state: 'incompatible',
            version: v.version,
            detail: 'The loaded add-on and connector use different delivery APIs. Update It and restart the agent app.',
          }
        : v.version !== ADDONS[harness]!.version
          ? { state: 'incompatible', version: v.version, detail: 'The app has a different add-on version loaded. Run `it setup` and restart the agent app.' }
          : v.delivery !== true
            ? {
                state: 'incompatible',
                version: v.version,
                detail: `The agent app is missing a delivery API${missing ? ` to ${missing}` : ' the add-on needs'}. Update the app and It, then restart the app. Clicks stay in the inbox.`,
              }
            : {
                state: 'active',
                idle: v.idle === true,
                version: v.version,
                detail:
                  v.idle === true
                    ? 'The loaded add-on reports the required delivery APIs. Each conversation must still listen for its own clicks.'
                    : 'The loaded add-on cannot discover a saved idle conversation. Open it and send a message to start listening. Auto-wake waits while this app is open.',
              }
    this.loaded.set(`${harness}:${instance}`, { at: now, runtime, idle: v.idle === true })
    for (const [key, entry] of this.loaded) if (now - entry.at >= RECENT_MS) this.loaded.delete(key)
    while (this.loaded.size > 100) this.loaded.delete(this.loaded.keys().next().value!)
    return runtime
  }

  status(harness: string, now = performance.now()): AddonRuntime {
    const entries = [...this.loaded].filter(([key, v]) => key.startsWith(`${harness}:`) && now - v.at < RECENT_MS).map(([, v]) => v.runtime)
    // One working process cannot conceal another process with stale or incompatible code.
    return (
      entries.find((r) => r.state === 'incompatible') ??
      entries[0] ?? {
        state: 'inactive',
        detail: 'Installed. No loaded add-on has reported its delivery APIs recently. The app may be closed or waiting for its first turn.',
      }
    )
  }

  blocksWake(harness: string, now = performance.now()): boolean {
    return [...this.loaded].some(([key, v]) => key.startsWith(`${harness}:`) && now - v.at < RECENT_MS && (!v.idle || v.runtime.state === 'incompatible'))
  }
}
