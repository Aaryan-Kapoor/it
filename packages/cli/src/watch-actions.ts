// The actions waiting on one page, as `it actions --id` lists them and `it actions --id --follow`
// watches them. Both only read: nothing here claims, holds, hands off, sets aside or answers an
// action, so whatever else delivers the person's actions goes on as it would without them.
import { actionPlace, comparePlaces, NOUN, TAKES } from '@it/protocol'
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
 * Whether the It this machine asks reads a page's actions a page at a time, asked at its door
 * before that read is asked for: true or false on its own word, and an error where it could not
 * be asked, which says nothing either way and is never taken for the older read.
 */
async function pagedRead(): Promise<boolean> {
  const takes = await backendTakes(TAKES.waitingPage)
  if (takes === undefined)
    throw new Problem('It could not be asked which ways of reading a page’s actions it takes, so none was asked for.', 'offline', 'Run `it status`.')
  return takes
}

/**
 * The actions waiting on one page, within what is printed at the most: the newest of them, or,
 * `after` a place, the ones that came after it, oldest first. `notes` are what to say beside them.
 */
export async function listActions(slug: string, after?: string): Promise<{ list: ReturnType<typeof printed>[]; notes: string[] }> {
  if (!(await pagedRead())) {
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
  const page = await call<Page>('query', api.delivery.waitingPage, { slug, ...(after === undefined ? {} : { after }) })
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

/** How long a watch that could not ask It what it takes waits before it asks again, at the least and at the most. */
const ASK_AGAIN_MS = [5_000, 60_000] as const

/**
 * Prints each action that waits on one page, and each one that comes after, as one line of JSON
 * each, until it is stopped: the newest already waiting first, or, `after` a place, every one
 * that came after it. Each is printed once.
 *
 * It reads the page's waiting actions a bounded page at a time and watches the page after a
 * place, moving on past each page that comes back full, so that however many older ones wait
 * unanswered, a new one is printed as soon as It has it. What it prints comes in the order of
 * the actions' places, and it prints only what stands after the last one it printed: an action
 * never comes after that place a second time, so nothing is printed twice, however long it runs,
 * and nothing need be remembered but that place. An action that was taken before it could be
 * printed and comes back to waiting behind that place is not printed.
 *
 * Whether It has that read is asked at its door before it is first asked for, and again before
 * each new watch: where It says it has not, it watches the oldest 50 instead, as an older It
 * gives, and says so; where It could not be asked, the watch it has is kept, and It is asked
 * again a little later.
 *
 * Ends without error when told to stop (SIGTERM or SIGINT), and with an error when the page
 * goes, It no longer knows this machine, or what it prints cannot be written.
 */
export async function watchActions(slug: string, after: string | undefined, note: (line: string) => void): Promise<void> {
  await call('query', api.artifacts.get, { slug })
  /** Where the watch starts: after this place in the paged read, or, with none, in the older one. */
  let start: string | undefined
  if (await pagedRead()) {
    const first = await call<Page>('query', api.delivery.waitingPage, { slug, ...(after === undefined ? {} : { after }) })
    start = after ?? first.from
  } else {
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
  let askAgain: ReturnType<typeof setTimeout> | undefined
  const stop = (why?: Problem) => {
    if (stopped) return
    stopped = true
    failure = why
    clearTimeout(askAgain)
    finish()
  }
  const client = live(() => stop(notKnown(machine())))
  const signalled = () => stop()
  process.once('SIGTERM', signalled)
  process.once('SIGINT', signalled)
  let work = Promise.resolve()
  let unwatch: (() => void) | undefined
  const failed = (err: unknown) =>
    void translate(err).catch((p: Problem) =>
      stop(
        p.code === 'error' || p.code === 'unavailable' || p.code === 'timeout'
          ? new Problem(`The stream of actions on ${slug} ended: ${p.message}`, 'offline')
          : p,
      ),
    )
  const then = (step: () => Promise<void>) => {
    work = work.then(step).catch((err) => failed(err))
  }
  /** Writes one action out, and says whether it left this process. */
  const emit = async (action: Listed) => {
    if (await handed(process.stdout, `${JSON.stringify(printed(action))}\n`)) return true
    stop(new Problem('An action could not be written to the output.', 'output_failed'))
    return false
  }

  if (start === undefined) {
    // The oldest 50, read whole each time, in which an action can come back at any time: each
    // printed is remembered for as long as the watch runs, so that none is printed twice
    const seen = new Set<string>()
    unwatch = client.onUpdate(
      api.delivery.waiting,
      { slug },
      (actions: Listed[]) =>
        then(async () => {
          for (const action of actions) {
            if (stopped) return
            if (seen.has(action.id)) continue
            if (!(await emit(action))) return
            seen.add(action.id)
          }
        }),
      failed,
    )
  } else {
    /** The place of the last action printed, or where the watch began: only what stands after it is printed. */
    let printedTo = actionPlace(start)
    if (printedTo === undefined) throw new Problem('That is not a place among the actions on a page.', 'invalid')
    /** Which watch is the current one: what an earlier one still had on its way when it was replaced moves nothing on. */
    let watching = 0
    let waitFor: number = ASK_AGAIN_MS[0]
    const watchAfter = (place: string) => {
      unwatch?.()
      const mine = ++watching
      unwatch = client.onUpdate(
        api.delivery.waitingPage,
        { slug, after: place },
        (page: Page) =>
          then(async () => {
            if (stopped) return
            for (const action of page.actions) {
              if (stopped) return
              const at = actionPlace(action.cursor)
              if (at === undefined) throw new Problem('It gave an action no place among the actions on its page.', 'error')
              if (comparePlaces(at, printedTo!) <= 0) continue
              if (!(await emit(action))) return
              printedTo = at
            }
            // A full page: what comes after it is watched next, once It has said that it still has this read
            const last = page.actions.at(-1)
            if (page.more && last && mine === watching) await moveOn(last.cursor, mine)
          }),
        failed,
      )
    }
    const moveOn = async (place: string, mine: number) => {
      if (stopped || mine !== watching) return
      const takes = await backendTakes(TAKES.waitingPage)
      if (stopped || mine !== watching) return
      if (takes === true) {
        waitFor = ASK_AGAIN_MS[0]
        return watchAfter(place)
      }
      // On its word that it no longer has the read, the watch ends: the older read gives other
      // actions in another order, and a watch started again begins there and says so
      if (takes === false)
        return stop(
          new Problem(
            `The It this machine asks no longer reads a ${NOUN.one}'s actions a page at a time: its functions are of an earlier version now. Start the watch again.`,
            'unavailable',
          ),
        )
      // It could not be asked: the watch that there is goes on, and It is asked again later
      clearTimeout(askAgain)
      askAgain = setTimeout(() => then(() => moveOn(place, mine)), waitFor)
      waitFor = Math.min(waitFor * 2, ASK_AGAIN_MS[1])
    }
    watchAfter(start)
  }
  try {
    await ended
    await work
  } finally {
    unwatch?.()
    clearTimeout(askAgain)
    process.removeListener('SIGTERM', signalled)
    process.removeListener('SIGINT', signalled)
    await client.close().catch(() => {})
  }
  if (failure) throw failure
}
