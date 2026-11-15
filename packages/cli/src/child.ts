// Every child this program starts and waits for with a limit on how long it may run goes
// through `runSync`, so that a fault of the runtime that the standalone program is built on
// cannot end one before its time.
//
// Bun 1.3, which the standalone program runs on, waits for such a child on Windows in an event
// loop of its own, which only runs while a child is being waited for. Its time limit is a timer
// of that loop, and the loop reckons when the timer is due from the time it last noted, which is
// when it last ran: at the end of the previous child it waited for. So the limit is shortened by
// however long the program went without waiting for a child, and once that is longer than the
// limit the child is ended almost as soon as it starts, reported as timed out, having printed
// nothing. Running the child gives the loop the right time again, so the next child is given
// its whole limit. Node, and Bun on Linux and macOS, count every limit from when the child is
// started, and never end one before its limit has passed.
import {
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process'

/**
 * Whether a child that came back as ended by its limit after `ms` was cut short: it had not run
 * for its whole limit. A limit that really ran out has always passed by the time the child
 * comes back, and the twentieth of a second allowed is for the clocks being read a little apart.
 */
export const cutShort = (ms: number, limit: number): boolean => ms < limit - 50

/**
 * Runs a child, and runs it once more where it came back as ended by its limit before the limit
 * had passed, which only the fault above does. The second run is given the whole limit, and
 * what it gives is what is given back, whatever that is: nothing is run a third time. A child
 * that really ran out of time, and one that ended in any other way, is run once. Where a second
 * run is safe only where the first did not get far, `again` says from the first run's result
 * whether it is, and that result is given back where it is not. `clock` is a monotonic count of milliseconds,
 * which a test stands in for.
 */
export function unlessCutShort<T extends { error?: Error }>(
  run: () => T,
  limit: number | undefined,
  again: (first: T) => boolean = () => true,
  clock: () => number = () => performance.now(),
): T {
  const began = clock()
  const first = run()
  if (!limit || (first.error as NodeJS.ErrnoException | undefined)?.code !== 'ETIMEDOUT' || !cutShort(clock() - began, limit) || !again(first)) return first
  return run()
}

/** `spawnSync`, given a second run where its limit ended the child before its time, and where `again` agrees (see `unlessCutShort`). */
export function runSync(
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  again?: (first: SpawnSyncReturns<string>) => boolean,
): SpawnSyncReturns<string>
export function runSync(
  file: string,
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
  again?: (first: SpawnSyncReturns<Buffer>) => boolean,
): SpawnSyncReturns<Buffer>
export function runSync(
  file: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
  again?: (first: SpawnSyncReturns<string | Buffer>) => boolean,
): SpawnSyncReturns<string | Buffer>
export function runSync(
  file: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
  again?: ((first: SpawnSyncReturns<string>) => boolean) | ((first: SpawnSyncReturns<Buffer>) => boolean),
): SpawnSyncReturns<string | Buffer> {
  // Each signature above gives `again` what `spawnSync` gives for its options
  return unlessCutShort(() => spawnSync(file, args, options), options.timeout, again as ((first: SpawnSyncReturns<string | Buffer>) => boolean) | undefined)
}

/**
 * What a child printed, where it ended well, as `execFileSync` gives it. Where it did not, this
 * throws, as `execFileSync` does: the error it could not be run or was ended with, or else one
 * that says how it ended, with its exit code as `status` and its signal as `signal`.
 */
export function printed(ran: SpawnSyncReturns<string>): string {
  if (ran.error) throw ran.error
  if (ran.status !== 0)
    throw Object.assign(new Error(ran.signal ? `ended by ${ran.signal}` : `ended with exit code ${ran.status}`), { status: ran.status, signal: ran.signal })
  return ran.stdout
}
