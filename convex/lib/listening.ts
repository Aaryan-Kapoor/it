// Whether a conversation can hear what is done on its pages, as the machine it is open on says:
// the one test the page and the site go by, so that nothing on the site says otherwise.
import { ALIVE } from '@it/protocol'
import type { Doc } from '../_generated/dataModel'

/** How many conversations that have not loaded It's add-on a machine is believed of: far more than anyone has open at once. */
export const NOT_LOADED_MOST = 40

/**
 * Whether a machine's word on which conversations have not loaded It's add-on still stands: its
 * connector said it lately and has not said it is stopping. One that went quiet without saying
 * so, as a machine does that loses power, says nothing of them any more. Its last word stays on
 * its record, and the site, which is told when the machine was last seen, lets it go by its own
 * clock as well, since nothing here is asked again once nothing changes.
 */
export const notLoadedStands = (machine: Doc<'machines'>): boolean =>
  !machine.revoked && machine.offAt === undefined && Date.now() - machine.lastSeenAt < ALIVE.onlineMs

/**
 * Whether a conversation on a machine has not loaded It's add-on, as its connector last said:
 * the one test the page and the site go by.
 */
export function addonNotLoaded(machine: Doc<'machines'> | null, s: { harness: string; id: string } | undefined): boolean {
  if (!machine || !s || !notLoadedStands(machine)) return false
  return (machine.notLoaded ?? []).some((c) => c.harness === s.harness && c.sessionId === s.id)
}
