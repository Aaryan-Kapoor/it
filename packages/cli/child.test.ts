// A child this program waits for, with a limit on how long it may run (`src/child.ts`).
//
// The first group stands in for the child and the clock. The second starts real children, after
// a quiet stretch longer than their limit, which is what ended a child at once in the standalone
// program on Windows. Under vitest it runs on Node, where no limit is cut short. CI also runs
// this file with `bun test ./packages/cli/child.test.ts` on Windows, under the Bun that the
// standalone program is built with, which is where the second group shows whether It is safe.
import { execFile, type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { printed, runSync, unlessCutShort } from './src/child'

const timedOut = () => Object.assign(new Error('spawnSync child ETIMEDOUT'), { code: 'ETIMEDOUT' })
const ran = (over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> => ({
  pid: 1,
  output: [],
  stdout: '',
  stderr: '',
  status: 0,
  signal: null,
  ...over,
})
const cut = ran({ status: null, signal: 'SIGTERM', error: timedOut() })
const fine = ran({ stdout: 'answer' })

/** A child that gives each of `results` in turn, each after the milliseconds beside it on a clock of its own. */
function stand(...results: [SpawnSyncReturns<string>, number][]) {
  let now = 1000
  let runs = 0
  return {
    run: () => {
      const [result, ms] = results[runs++]!
      now += ms
      return result
    },
    clock: () => now,
    runs: () => runs,
  }
}

describe('a child that its limit ended before its time', () => {
  test('is run once more, and what the second run gives is given back', () => {
    const child = stand([cut, 25], [fine, 2000])
    expect(unlessCutShort(child.run, 60_000, undefined, child.clock)).toBe(fine)
    expect(child.runs()).toBe(2)
  })

  test('is never run a third time, however the second run ends', () => {
    const child = stand([cut, 25], [cut, 30], [fine, 1])
    expect(unlessCutShort(child.run, 60_000, undefined, child.clock)).toBe(cut)
    expect(child.runs()).toBe(2)
  })

  test('is run once more where the limit was only shortened, however little', () => {
    for (const ms of [20_000, 29_000]) {
      const child = stand([cut, ms], [fine, 25_000])
      expect(unlessCutShort(child.run, 30_000, undefined, child.clock)).toBe(fine)
      expect(child.runs()).toBe(2)
    }
  })

  test('is run once more only where what a second run needs still holds', () => {
    const held = stand([cut, 25], [fine, 2000])
    expect(unlessCutShort(held.run, 30_000, () => true, held.clock)).toBe(fine)
    expect(held.runs()).toBe(2)
    const gone = stand([cut, 25], [fine, 2000])
    expect(unlessCutShort(gone.run, 30_000, () => false, gone.clock)).toBe(cut)
    expect(gone.runs()).toBe(1)
  })
})

describe('a child that is run once', () => {
  test('one that really ran out of its time', () => {
    // Its clock read a few milliseconds apart from the runtime's, either way
    for (const ms of [60_004, 59_990]) {
      const child = stand([cut, ms], [fine, 1])
      expect(unlessCutShort(child.run, 60_000, () => true, child.clock)).toBe(cut)
      expect(child.runs()).toBe(1)
    }
  })

  test('one that ended well', () => {
    const child = stand([fine, 5], [fine, 1])
    expect(unlessCutShort(child.run, 60_000, undefined, child.clock)).toBe(fine)
    expect(child.runs()).toBe(1)
  })

  test('one that failed in any other way, however soon', () => {
    const missing = ran({ status: null, error: Object.assign(new Error('spawnSync child ENOENT'), { code: 'ENOENT' }) })
    const refused = ran({ status: 1, stderr: 'no' })
    for (const result of [missing, refused]) {
      const child = stand([result, 3], [fine, 1])
      expect(unlessCutShort(child.run, 60_000, undefined, child.clock)).toBe(result)
      expect(child.runs()).toBe(1)
    }
  })

  test('one given no limit, which nothing can have cut short', () => {
    const child = stand([cut, 3], [fine, 1])
    expect(unlessCutShort(child.run, undefined, undefined, child.clock)).toBe(cut)
    expect(child.runs()).toBe(1)
  })
})

describe('what a child printed', () => {
  test('is given where it ended well, and thrown for as execFileSync throws where it did not', () => {
    expect(printed(fine)).toBe('answer')
    expect(() => printed(cut)).toThrow(/ETIMEDOUT/)
    let thrown: unknown
    try {
      printed(ran({ status: 1 }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ status: 1, signal: null, message: 'ended with exit code 1' })
  })
})

// A child that takes a moment and says so, and the limit it is given: long enough for any
// runner to start the runtime twice over, and shorter than the quiet stretch before it
const CHILD = [process.execPath, ['-e', 'setTimeout(() => console.log("done"), 100)']] as const
const LIMIT = 1500
const QUIET = 2000
const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET))
const runtime =
  typeof (globalThis as { Bun?: { version: string } }).Bun === 'undefined'
    ? `Node ${process.version}`
    : `Bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}`

describe(`a real child after a quiet stretch longer than its limit, under ${runtime} on ${process.platform}`, () => {
  test('is given its whole limit when It waits for it', async () => {
    runSync(...CHILD, { encoding: 'utf8', timeout: LIMIT })
    await quiet()
    const began = performance.now()
    const after = runSync(...CHILD, { encoding: 'utf8', timeout: LIMIT })
    const ms = Math.round(performance.now() - began)
    expect({ status: after.status, error: (after.error as NodeJS.ErrnoException | undefined)?.code, out: after.stdout.trim() }, `after ${ms} ms`).toEqual({
      status: 0,
      error: undefined,
      out: 'done',
    })
  }, 20_000)

  // What the runtime's own spawnSync does in the same place, said and not held to: the fault is
  // the runtime's, and a later runtime may not have it
  test('and what the runtime itself makes of it is said', async () => {
    spawnSync(...CHILD, { encoding: 'utf8', timeout: LIMIT })
    await quiet()
    const began = performance.now()
    const after = spawnSync(...CHILD, { encoding: 'utf8', timeout: LIMIT })
    const ms = Math.round(performance.now() - began)
    const code = (after.error as NodeJS.ErrnoException | undefined)?.code
    console.log(
      `${runtime} on ${process.platform}: spawnSync with a limit of ${LIMIT} ms, ${QUIET} ms after the one before it, ${code === 'ETIMEDOUT' ? `was ended at its limit after ${ms} ms` : `ended with ${after.status} after ${ms} ms`}`,
    )
  }, 20_000)

  test('is given its whole limit when it is not waited for', async () => {
    spawnSync(...CHILD, { encoding: 'utf8', timeout: LIMIT })
    await quiet()
    const began = performance.now()
    const said = await new Promise<{ code?: string | number; signal?: string; out: string }>((resolve) =>
      execFile(CHILD[0], [...CHILD[1]], { encoding: 'utf8', timeout: LIMIT }, (err, out) =>
        resolve({
          code: (err as NodeJS.ErrnoException | null)?.code ?? undefined,
          signal: (err as { signal?: string } | null)?.signal ?? undefined,
          out: out.trim(),
        }),
      ),
    )
    expect(said, `after ${Math.round(performance.now() - began)} ms`).toEqual({ code: undefined, signal: undefined, out: 'done' })
  }, 20_000)
})
