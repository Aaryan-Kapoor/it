// The actions waiting on one page, as `it actions --id` lists them and `it actions --id --follow`
// watches them. Both only read: nothing here claims, holds, hands off, sets aside or answers an
// action, so whatever else delivers the person's actions goes on as it would without them.
import { NOUN, TAKES } from '@it/protocol'
import { api, backendTakes, call, handed, live, machine, notKnown, Problem, translate } from './lib'
import { type Listed, printed } from './wait'

/** What `delivery.waitingPage` answers: a bounded page of a page's waiting actions, each with its place. */
interface Page {
  actions: (Listed & { cursor: string })[]
  /** The place just before these: read after it, the same ones come again, and every later one. */
  from: string
  /** Whether more wait after the last of these. */
  more: boolean
  /** Whether older ones wait that were left out, where the newest were asked for. */
  earlier: boolean
}

/**
 * How much `it actions --id` prints, at the most, in bytes. What reads it may keep no more than
 * half a megabyte of what a command prints, and fifty actions that each carried all an action may
 * carry, printed out, come to several times that.
 */
export const LISTED_MOST = 256 * 1024

/** What a person or agent is told where the It this machine asks is older than this command. */
const OLDER = 'The It this machine asked is of an earlier version than this command'
const UPDATE = 'until that It is updated: with `it upgrade` on the machine it runs on, or the Update button on its Machines page'

/**
 * Whether a refusal says that the backend has no paged read, on its own word. An older backend
 * refuses a function it does not have and keeps why to itself, so it is asked what it takes: only
 * where it says it does not take this is it taken for one that cannot. A refusal of It's own code
 * (no such page, a cursor that is not one) or a backend that could not be reached is what it is.
 */
async function olderBackend(err: unknown): Promise<boolean> {
  return err instanceof Problem && err.code === 'error' && (await backendTakes(TAKES.waitingPage)) === false
}

/** An action as one element of the array `out` prints, in bytes, with what stands around it. */
const sizeIn = (x: unknown) => {
  const text = JSON.stringify(x, null, 2)
  return Buffer.byteLength(text) + 2 * (text.split('\n').length + 1)
}

/**
 * The actions to print, within `most` bytes as `out` prints them, keeping the newest or the
 * oldest. One that does not fit even by itself is printed without its data, with how to read it.
 * Says how many were left out.
 */
export function bounded<T extends { id: string; data?: unknown }>(all: T[], keep: 'newest' | 'oldest', most = LISTED_MOST): { list: T[]; left: number } {
  const order = keep === 'newest' ? [...all].reverse() : all
  const list: T[] = []
  let used = 4
  for (const x of order) {
    let one = x
    if (sizeIn(one) + 4 > most) one = { ...x, data: null, dataLeftOut: `Too long to list here: run \`it action ${x.id}\` to read all of it.` } as T
    const size = sizeIn(one)
    if (used + size > most) break
    list.push(one)
    used += size
  }
  return { list: keep === 'newest' ? list.reverse() : list, left: all.length - list.length }
}

/**
 * The actions waiting on one page, within what is printed at the most: the newest of them, or,
 * `after` a place, the ones that came after it, oldest first. `notes` are what to say beside them.
 */
export async function listActions(slug: string, after?: string): Promise<{ list: ReturnType<typeof printed>[]; notes: string[] }> {
  let page: Page
  try {
    page = await call<Page>('query', api.delivery.waitingPage, { slug, ...(after === undefined ? {} : { after }) })
  } catch (err) {
    if (!(await olderBackend(err))) throw err
    if (after !== undefined) throw new Problem(`${OLDER}, and cannot list the actions on a ${NOUN.one} after a cursor ${UPDATE}.`, 'invalid')
    // What such an It lists: the oldest 50, which is all of them while fewer wait
    const old = (await call<Listed[]>('query', api.delivery.waiting, { slug })).map(printed)
    const { list, left } = bounded(old, 'oldest')
    const full = old.length >= 50 || left > 0
    const notes = full
      ? [`${OLDER}, and lists only the oldest 50 actions waiting on a ${NOUN.one}: newer ones are not listed here while those wait, ${UPDATE}.`]
      : []
    return { list, notes }
  }
  const all = page.actions.map(printed)
  const { list, left } = bounded(all, after === undefined ? 'newest' : 'oldest')
  const notes: string[] = []
  if (after === undefined && (page.earlier || left > 0))
    notes.push(
      `Older actions wait on this ${NOUN.one} than these. To read every one, oldest first, run \`it actions --id ${slug} --after 0\`, and again with --after set to the cursor of the last one listed.`,
    )
  const last = list.at(-1)?.cursor ?? after
  if (after !== undefined && (page.more || left > 0)) notes.push(`More actions wait after these: run \`it actions --id ${slug} --after ${last}\`.`)
  return { list, notes }
}

/**
 * Prints each action that waits on one page, and each one that comes after, as one line of JSON
 * each, until it is stopped: the newest already waiting first, or, `after` a place, every one
 * that came after it. Each is printed once.
 *
 * It reads the page's waiting actions a bounded page at a time and watches the page after the
 * place of what it has printed, moving on whenever a page is full, so that however many older
 * ones wait unanswered, a new one is printed as soon as It has it. Against an older backend,
 * which has no such read, it watches the oldest 50 and says that newer ones may not be seen.
 *
 * Ends without error when told to stop (SIGTERM or SIGINT), and with an error when the page
 * goes, It no longer knows this machine, or what it prints cannot be written.
 */
export async function watchActions(slug: string, after: string | undefined, note: (line: string) => void): Promise<void> {
  await call('query', api.artifacts.get, { slug })
  /** Where the watch starts: after this place in the paged read, or, with none, in the older one. */
  let start: string | undefined
  try {
    const first = await call<Page>('query', api.delivery.waitingPage, { slug, ...(after === undefined ? {} : { after }) })
    start = after ?? first.from
  } catch (err) {
    if (!(await olderBackend(err))) throw err
    if (after !== undefined) throw new Problem(`${OLDER}, and cannot follow the actions on a ${NOUN.one} from a cursor ${UPDATE}.`, 'invalid')
    note(
      JSON.stringify({
        note: `${OLDER}, which tells it only the oldest 50 actions waiting on a ${NOUN.one}: while 50 wait unanswered, newer ones are not printed here ${UPDATE}.`,
      }),
    )
  }
  let failure: Problem | undefined
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  let stopped = false
  const stop = (why?: Problem) => {
    if (stopped) return
    stopped = true
    failure = why
    finish()
  }
  const client = live(() => stop(notKnown(machine())))
  const signalled = () => stop()
  process.once('SIGTERM', signalled)
  process.once('SIGINT', signalled)
  /**
   * Printed already. A page holds at most 50, and the watch moves on past each full one, so no
   * action that can come again is ever forgotten here; the bound is for a watch that runs for weeks.
   */
  const seen = new Set<string>()
  let work = Promise.resolve()
  let unwatch: (() => void) | undefined
  /** Which watch is the current one: what an earlier one still had on its way when it was replaced is printed, and moves nothing on. */
  let watching = 0
  const failed = (err: unknown) =>
    void translate(err).catch((p: Problem) =>
      stop(
        p.code === 'error' || p.code === 'unavailable' || p.code === 'timeout'
          ? new Problem(`The stream of actions on ${slug} ended: ${p.message}`, 'offline')
          : p,
      ),
    )
  /** Prints what has not been printed, in order, each once it has really left this process. */
  const print = async (actions: Listed[]) => {
    for (const action of actions) {
      if (stopped) return
      if (seen.has(action.id)) continue
      if (!(await handed(process.stdout, `${JSON.stringify(printed(action))}\n`)))
        return stop(new Problem('An action could not be written to the output.', 'output_failed'))
      seen.add(action.id)
      if (seen.size > 5000) seen.delete(seen.values().next().value!)
    }
  }
  const then = (step: () => Promise<void>) => {
    work = work.then(step).catch((err) => failed(err))
  }
  const watchAfter = (place: string) => {
    unwatch?.()
    const mine = ++watching
    unwatch = client.onUpdate(
      api.delivery.waitingPage,
      { slug, after: place },
      (page: Page) =>
        then(async () => {
          if (stopped) return
          await print(page.actions)
          // A full page: what comes after it is watched now, and it is as soon as this one is printed
          const last = page.actions.at(-1)
          if (page.more && last && !stopped && mine === watching) watchAfter(last.cursor)
        }),
      failed,
    )
  }
  if (start !== undefined) watchAfter(start)
  else unwatch = client.onUpdate(api.delivery.waiting, { slug }, (actions: Listed[]) => then(() => print(actions)), failed)
  try {
    await ended
    await work
  } finally {
    unwatch?.()
    process.removeListener('SIGTERM', signalled)
    process.removeListener('SIGINT', signalled)
    await client.close().catch(() => {})
  }
  if (failure) throw failure
}
