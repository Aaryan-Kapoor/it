import { newer } from '@it/protocol'

/** The owning app's reported state, without exposing the rest of its machine's inventory. */
export interface PageConnection {
  harness: string
  state: 'disconnected' | 'connecting' | 'needs_approval' | 'disabled' | 'error' | 'unavailable' | 'too_old' | 'connected' | 'unknown'
  queue: boolean
}

/**
 * What a person does so that Codex runs It's hooks, where Codex runs: in its terminal or its
 * desktop app, Codex asks to review them only as it starts, and "Trust all and continue" approves them.
 */
export const CODEX_TRUST = 'Start Codex again, and choose “Trust all and continue” when it asks to review hooks'

/** Older backends expose inventory to owners only. Screens keep their generic waiting status. */
export function reportedConnection(
  harness: string,
  machine: { wanted: string[]; harnesses?: { id: string; addon: string; version?: string }[] } | undefined,
): PageConnection | undefined {
  if (!machine) return undefined
  if (!machine.wanted.includes(harness)) return { harness, state: 'disconnected', queue: false }
  const found = machine.harnesses?.find((app) => app.id === harness)
  const state: PageConnection['state'] =
    found?.addon === 'not_connected'
      ? 'connecting'
      : found && ['connected', 'needs_approval', 'disabled', 'error', 'unavailable', 'too_old'].includes(found.addon)
        ? (found.addon as PageConnection['state'])
        : 'unknown'
  // This is the first supported Codex version whose open conversations can be checked.
  const queue =
    harness === 'codex' &&
    (state === 'connected' || state === 'needs_approval') &&
    /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(found?.version ?? '') &&
    !newer('0.160.0', found?.version)
  return { harness, state, queue }
}
