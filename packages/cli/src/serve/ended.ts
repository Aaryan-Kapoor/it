// How a program of the system's own that It started and waited for ended, where it did not do
// what it was asked. A person at a terminal is told in words, with whatever the program printed.
// The log is given a code and the numbers that go with it, and never what the program printed or
// the words an error has of its own, which can name a folder or a person.
import { cutShort } from '../child'

/** What is known of a child that has ended: its exit code, the signal that ended it, and the error it could not be started or was ended with. */
export interface Ended {
  status: number | null
  signal?: NodeJS.Signals | null
  error?: (Error & { code?: string }) | undefined
}

/** Whether a child was ended for taking longer than the `forMs` it was given, having run for `ms`. */
const atLimit = (r: Ended, ms: number, forMs?: number): boolean => r.error?.code === 'ETIMEDOUT' || (forMs !== undefined && !!r.signal && ms >= forMs)

/** Whether a child could not be started at all, so that nothing of it ever ran. */
export const notStarted = (r: Ended): boolean => !!r.error && r.status === null && !r.signal && r.error.code !== 'ETIMEDOUT'

/**
 * Says why a command did not do what it was asked: that it could not be started, that it was
 * ended at its time limit or by a signal, or the code it ended with, and how long it ran, with
 * whatever it printed. A failure that printed nothing is then still told from another.
 */
export function failure(name: string, r: Ended & { out: string }, ms: number, forMs?: number): string {
  const took = `${(ms / 1000).toFixed(1)} seconds`
  const code = r.error?.code
  const how = atLimit(r, ms, forMs)
    ? // How long it had run is said too: a limit that ended a command long before it was reached would be told so
      `${name} was ended at its limit of ${Math.round((forMs ?? ms) / 1000)} seconds, after ${took}`
    : r.error && r.status === null && !r.signal
      ? `${name} could not be started (${code ?? r.error.message})`
      : r.signal
        ? `${name} was ended by ${r.signal} after ${took}`
        : r.status !== null
          ? `${name} ended with exit code ${r.status}${r.status > 0xffff ? ` (0x${r.status.toString(16).toUpperCase()})` : ''} after ${took}`
          : `${name} ended after ${took} without saying how`
  return r.out ? `${how}, and printed: ${r.out}` : `${how}, and printed nothing`
}

/**
 * The same, as the log may say it: a word for how the child ended and the numbers that go with
 * it, in milliseconds. `not_started` with the system's code for why, where it could not be
 * started; `timed_out` where its limit ended it, and `cut_short` where the limit ended it before
 * its time, as a fault of the runtime does on Windows (see `child.ts`); `ended_by` with the
 * signal; `exit_` with the code it ended with; and `unknown` where nothing says how it ended.
 */
export function endedAs(r: Ended, ms: number, forMs?: number): string {
  const took = Math.max(0, Math.round(ms))
  if (atLimit(r, ms, forMs)) return forMs !== undefined && cutShort(ms, forMs) ? `cut_short after ${took} of ${forMs} ms` : `timed_out after ${took} ms`
  if (notStarted(r)) return `not_started ${/^E[A-Z0-9_]{2,30}$/.test(r.error?.code ?? '') ? r.error?.code : 'error'}`
  if (r.signal) return `ended_by ${/^SIG[A-Z0-9]{2,10}$/.test(r.signal) ? r.signal : 'signal'} after ${took} ms`
  if (r.status !== null) return `exit_${r.status}`
  return 'unknown'
}
