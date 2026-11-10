// Whether a conversation can hear what is done on its pages, as the machine it is open on says:
// the one test the page and the site go by, so that nothing on the site says otherwise.
import type { Doc } from '../_generated/dataModel'

/** How many conversations that have not loaded It's add-on a machine is believed of: far more than anyone has open at once. */
export const NOT_LOADED_MOST = 40

/**
 * Whether a conversation on a machine has not loaded It's add-on, as its connector last said:
 * the one test the page and the site go by. Nothing is taken to be so of a machine that has
 * been revoked or whose connector said it was stopping, which says nothing of it any more.
 */
export function addonNotLoaded(machine: Doc<'machines'> | null, s: { harness: string; id: string } | undefined): boolean {
  if (!machine || machine.revoked || machine.offAt !== undefined || !s) return false
  return (machine.notLoaded ?? []).some((c) => c.harness === s.harness && c.sessionId === s.id)
}
