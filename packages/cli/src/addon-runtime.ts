import { ADDONS } from './addons.generated'

export interface AddonRuntime {
  state: 'active' | 'inactive' | 'unverified' | 'incompatible'
  version?: string
  idle?: boolean
  /**
   * The app runs an earlier build of the add-on than the one this It carries. It speaks the
   * same delivery API and still takes clicks: restarting the app loads the build installed.
   */
  outdated?: boolean
  detail: string
}

interface Loaded {
  at: number
  runtime: AddonRuntime
  idle: boolean
}

/**
 * This is the local add-on contract, separate from the machine and page protocols. An add-on of
 * another build that speaks it is given clicks and listened for as any other: what decides
 * whether the running code can work with this connector is this number and the delivery
 * capabilities the add-on reports, and never the build. So this goes up whenever the connector
 * comes to rely on something that an add-on of an earlier build does not do.
 */
export const ADDON_API = 1
// Add-ons report every second. Thirty seconds allows for delayed polling, while letting a
// closed app stop holding back Auto-wake even when it could not report that it was closing.
const RECENT_MS = 30_000

/** What a person is told of an app that refused to load It's add-on: OpenCode alone says so, in its log (see `opencode-refused.ts`). */
const REFUSED: Record<string, string> = {
  opencode:
    'OpenCode refused to load It’s add-on, as its log says, so what is done on a page does not reach an open OpenCode conversation by itself, and Auto-wake does not reopen one that may be open. Update It and OpenCode, then restart OpenCode. Until then clicks wait in the inbox, where `it wait` and the site take them.',
}

export class AddonRuntimes {
  private loaded = new Map<string, Loaded>()
  private overflowUntil = new Map<string, number>()
  /** When an app last refused to load It's add-on, and when one of its add-ons was last heard from, both by this machine's clock in milliseconds. */
  private refusedAt = new Map<string, number>()
  private heardAt = new Map<string, number>()

  /**
   * The app refused to load It's add-on at this time, or has not since its add-on was put
   * there (undefined). A refusal holds until an add-on of the app is heard from after it: until
   * then nothing of It runs in the app, and the app may be open without it, so the add-on is
   * not called connected and Auto-wake does not reopen beside it. Said back: whether this
   * changes what is said of the app.
   */
  refused(harness: string, at: number | undefined): boolean {
    const was = this.refusal(harness)
    if (at === undefined) this.refusedAt.delete(harness)
    else this.refusedAt.set(harness, at)
    return this.refusal(harness) !== was
  }

  /** The refusal that holds now: one no add-on of the app has been heard from since. */
  private refusal(harness: string): number | undefined {
    const at = this.refusedAt.get(harness)
    return at !== undefined && REFUSED[harness] && !((this.heardAt.get(harness) ?? -1) > at) ? at : undefined
  }

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
    // Only what the running code cannot do with this connector keeps clicks from it: another
    // delivery API, or an app that lacks what the add-on needs to hand a click over. An add-on of
    // an earlier build that speaks this API works as one of this build does, and is said to be
    // earlier so that the person knows a restart of the app loads the build It installed.
    const outdated = v.version !== ADDONS[harness]!.build
    const runtime: AddonRuntime =
      v.api !== ADDON_API
        ? {
            state: 'incompatible',
            version: v.version,
            detail: 'The loaded add-on and connector use different delivery APIs. Update It and restart the agent app.',
          }
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
              ...(outdated ? { outdated: true } : {}),
              detail: [
                outdated
                  ? 'The app is running an earlier build of It’s add-on than the one installed, and it still takes clicks. Restart the app to load the build It installed.'
                  : v.idle === true
                    ? 'The loaded add-on reports the required delivery APIs.'
                    : '',
                v.idle === true
                  ? 'Each conversation must still listen for its own clicks.'
                  : 'This app does not always tell the add-on which saved conversation is open. Open the conversation and send a message in it to start listening. Auto-wake waits while this app is open.',
              ]
                .filter(Boolean)
                .join(' '),
            }
    this.loaded.set(`${harness}:${instance}`, { at: now, runtime, idle: v.idle === true })
    this.heardAt.set(harness, Date.now())
    for (const [key, entry] of this.loaded) if (now - entry.at >= RECENT_MS) this.loaded.delete(key)
    // Keep room for 100 simultaneous app instances, but bound memory and the work of reading
    // their status if a faulty add-on keeps reporting a new instance id. Evicted instances
    // must still hold back Auto-wake until their reports expire.
    while (this.loaded.size > 100) {
      const [key, entry] = this.loaded.entries().next().value!
      const app = key.slice(0, key.indexOf(':'))
      // Eviction loses a process's identity, never its recent reason not to reopen beside it.
      if (!entry.idle || entry.runtime.state === 'incompatible') this.overflowUntil.set(app, Math.max(this.overflowUntil.get(app) ?? 0, entry.at + RECENT_MS))
      this.loaded.delete(key)
    }
    return runtime
  }

  status(harness: string, now = performance.now()): AddonRuntime {
    const entries = [...this.loaded].filter(([key, v]) => key.startsWith(`${harness}:`) && now - v.at < RECENT_MS).map(([, v]) => v.runtime)
    // One working process cannot conceal another process with stale or incompatible code.
    return (
      (this.refusal(harness) !== undefined ? { state: 'incompatible' as const, detail: REFUSED[harness]! } : undefined) ??
      entries.find((r) => r.state === 'incompatible') ??
      ((this.overflowUntil.get(harness) ?? 0) > now
        ? {
            state: 'unverified',
            idle: false,
            detail: 'More app instances have reported than It can track. Auto-wake waits until their recent reports expire.',
          }
        : undefined) ??
      // And one that is current cannot conceal another that runs an earlier build and wants the app restarted
      entries.find((r) => r.outdated) ??
      entries[0] ?? {
        state: 'inactive',
        detail: 'Installed. No loaded add-on has reported its delivery APIs recently. The app may be closed or waiting for its first turn.',
      }
    )
  }

  blocksWake(harness: string, now = performance.now()): boolean {
    return (
      this.refusal(harness) !== undefined ||
      (this.overflowUntil.get(harness) ?? 0) > now ||
      [...this.loaded].some(([key, v]) => key.startsWith(`${harness}:`) && now - v.at < RECENT_MS && (!v.idle || v.runtime.state === 'incompatible'))
    )
  }

  /** Why Auto-wake does not reopen a conversation of this app, where that is the app's refusal of the add-on. */
  wakeHeld(harness: string): string | undefined {
    return this.refusal(harness) !== undefined
      ? `${harness === 'opencode' ? 'OpenCode' : 'the app'} refused to load It’s add-on, so It did not start a second copy of a conversation that may be open in it: update It and OpenCode, then restart OpenCode, and what you did reaches it`
      : undefined
  }
}
