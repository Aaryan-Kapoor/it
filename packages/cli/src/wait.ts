import { MESSAGE, NOUN, parseJson } from '@it/protocol'
import { type Args, text } from './args'
import { local } from './connector'
import { api, call, end, handed, live, Problem, sessionAsked, sessionNote, translate, written } from './lib'
import { failure } from './output'
import * as usage from './usage'

const say = (line: string): void => written(process.stderr, `${line}\n`)

// ---------- waiting for the person ----------

/** A click as the backend lists it: what it carried is JSON text. */
export interface Listed {
  id: string
  artifact: string
  title: string
  name: string
  payload: string
  at: number
  attended: boolean | null
  session: { harness: string; id: string } | null
  version?: number
  stateRevision?: number
  nowVersion?: number
  nowStateRevision?: number
  /** The files it carried beside its data. */
  files?: { name: string; type: string; bytes: number }[]
}
/** A click as this program prints it for an agent. */
export const printed = (c: Listed) => ({
  id: c.id,
  page: c.artifact,
  title: c.title,
  action: c.name,
  data: parseJson(c.payload) ?? null,
  at: c.at,
  // Said only when the site saw no sign that anyone had just used the page, which an agent should know
  ...(c.attended === false ? { sentByThePageItself: true } : {}),
  // What the person typed in the box above the page is told as that, with where to answer it: an
  // agent that only ever reads this, and not the words an add-on is given, would otherwise take
  // it for one more thing the page sent, and answer it in a chat the person is not looking at
  ...(c.name === MESSAGE
    ? {
        typedByTheUser: true,
        answer: `They typed this in the box above the ${NOUN.one} and are looking at that ${NOUN.one}, not at the chat: answer there, by changing the ${NOUN.one} or with \`it say ${c.artifact} "…"\`.`,
      }
    : {}),
  // Which version of the page, and which revision of its state, the person was looking at
  ...(c.version === undefined ? {} : { version: c.version }),
  ...(c.stateRevision === undefined ? {} : { stateRevision: c.stateRevision }),
  // Said only when what they acted on has been replaced since, which an agent must know before it acts on it
  ...(c.nowVersion === undefined ? {} : { pageIsNowAtVersion: c.nowVersion }),
  ...(c.nowStateRevision === undefined ? {} : { stateIsNowAtRevision: c.nowStateRevision }),
  // The files it carried beside its data, by the numbers its data names them by, and how to write one to a file
  ...(c.files?.length
    ? {
        files: c.files.map((f, i) => ({ number: i + 1, ...f })),
        saveWith: `it action ${c.id} --save <file>${c.files.length > 1 ? ' --number <n>' : ''}`,
      }
    : {}),
})
/** Writes a line and resolves once it has really left this process. */
const emit = async (value: unknown) => {
  if (!(await handed(process.stdout, `${JSON.stringify(value)}\n`))) throw new Problem('The action could not be written to the output.', 'output_failed')
}

/**
 * Blocks until the person acts, then prints what they did. While this runs, the connector on
 * this machine leaves matching clicks alone: an agent that is waiting gets the click here.
 */
export async function wait(a: Args, counted: (code?: string) => void) {
  const slug = text(a, 'id')
  const follow = a.flags.follow === true
  const seconds = text(a, 'timeout') === undefined ? 0 : Number(text(a, 'timeout'))
  if (!Number.isFinite(seconds) || seconds < 0) throw new Problem('--timeout is a number of seconds.', 'invalid')
  if (slug) await call('query', api.artifacts.get, { slug })
  // Without a page named, an agent waits for clicks on its own pages. Every click that is
  // waiting would include other conversations' clicks, which are theirs to hear.
  const asked = sessionAsked()
  const me = asked?.session
  if (!slug && !me) throw new Problem('Say which page to wait on.', 'invalid', 'it wait --id <id>')
  // Whose pages are waited on was a choice among the apps that had marked this command. It is said apart from what is printed, which is the person's actions only.
  const unsure = slug ? undefined : sessionNote(asked, 'This waits for actions on the pages of', 'name the page with --id.')
  if (unsure) say(JSON.stringify({ note: unsure }))
  // It is asked once before anything is waited for, as a wait on a named page asks for its page:
  // where It cannot be reached at all, that is said now, and not taken for a wait in which nothing happened
  /**
   * Asks It what is waiting for this, as it stands now. Throws where It cannot be asked. With no
   * page named that is asked of each id the conversation is known by, the ones it had before it
   * was cleared among them once the connector has said them: a page made under an earlier id is
   * still recorded under it, and what is done on it waits there.
   */
  const waitingNow = async (ids = [me!]): Promise<Listed[]> => {
    if (slug) return call<Listed[]>('query', api.delivery.waiting, { slug })
    const each = await Promise.all(ids.map((session) => call<Listed[]>('query', api.delivery.waitingFor, { session })))
    return [...new Map(each.flat().map((c) => [c.id, c])).values()].sort((x, y) => x.at - y.at)
  }
  if (!slug) await waitingNow()
  const who = crypto.randomUUID()
  // The connector is told what this waits for: one page, or, with none named, this
  // conversation's clicks only. Everyone else's go on being delivered as usual.
  /**
   * What the connector handed back and this has printed. The connector keeps its copy of such
   * a click until it is told so, and gives it again to a wait that has not said it: an answer
   * of its that never arrived would otherwise be the last of that click.
   */
  const taken = new Set<string>()
  // Only the latest 500 receipts are sent with an asking. Keep no more in a wait that may follow
  // for days; an older click offered again is remembered anew, without being printed twice.
  const take = (id: string) => {
    taken.add(id)
    if (taken.size > 500) taken.delete(taken.values().next().value!)
  }
  const got = () => (taken.size ? { got: [...taken] } : {})
  const announce = () =>
    local<{ sessions?: { harness: string; id: string }[]; clicks?: Listed[] }>('/waiting', {
      method: 'POST',
      body: { id: who, slug: slug ?? null, ...(slug ? {} : { session: me }), ...got() },
    })
  // The connector knows the ids this conversation had before it was last cleared: pages made
  // then are still recorded under them
  const first = await announce()
  const known = first?.sessions
  const sessions = !slug && me ? (known?.length ? known : [me]) : []
  const mine = (c: Listed) => slug !== undefined || sessions.some((s) => c.session?.harness === s.harness && c.session?.id === s.id)
  // An add-on in this conversation may already have been given a click it can only hand over
  // with the result of a command, and the command now running is this one. The connector
  // passes such a click on here, already held for this machine, and it is printed like any other.
  let handedBack: Listed[] = first?.clicks ?? []
  /** The asking of the connector that is on its way now, if one is. What it brings is waited for before the wait says its last word. */
  let announcing: Promise<void> | null = null
  /** The wait is choosing its last word: the connector is asked for nothing more, which it would hand over once and this could then not print. */
  let deciding = false
  const beat = setInterval(() => {
    if (deciding || announcing) return
    announcing = announce()
      .then((r) => {
        if (r?.clicks?.length) {
          handedBack = [...handedBack, ...r.clicks]
          void onHandedBack()
        }
      })
      .catch(() => {})
      .finally(() => {
        announcing = null
      })
  }, 2000)
  const client = live()
  /** Printed already. Never printed twice, whatever happens to the report of it. */
  const printedIds = new Set<string>()
  /** Printed, and It has not yet been told so. Told again until it has. */
  const unreported = new Set<string>()
  /**
   * For usage reporting: when each click this printed was made, for which harness, and whether
   * it was already waiting when this began. That last is known from what the backend first
   * offered, and not by comparing this machine's clock with the backend's.
   */
  const made = new Map<string, { at: number; harness: string | undefined; wasWaiting: boolean }>()
  /** Whether the first list of what is waiting has been looked at. What is in it was made before this began. */
  let looked = false
  let busy = false
  let ending = false
  /** The wait has said its last word (that its time ran out): nothing is printed after it. */
  let over = false
  const finish = async (code: number) => {
    if (ending) return
    ending = true
    clearInterval(beat)
    // Whatever the connector has handed over, or is handing over this moment, is printed
    // before this ends, however it ends: the connector gives a click to a waiter once, and a
    // wait that ended without printing it would have lost it. Only not after the wait has
    // said that its time ran out, which is its last word.
    deciding = true
    await announcing
    // What is being printed this moment is printed whole, and It told of it, before anything
    // more is done: a signal or an error that came in the middle of three clicks ended the
    // wait after the first, with the other two taken from the connector and never said
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20))
    if (!over)
      await printHandedBack().catch(() => {
        code = 1
      })
    await local('/waiting', { method: 'POST', body: { id: who, done: true, ...got() } })
    await client.close().catch(() => {})
    // A wait that was given something has its answer, whatever went wrong beside it
    const last = code === 1 && printedIds.size > 0 && !follow ? 0 : code
    // Counted here, where a wait ends: it never comes back to where the other commands are
    // counted. One that was ended by a signal, as a wait that follows is, ended as it was meant to
    counted(last === 0 || last === 130 ? undefined : 'error')
    await end(last)
  }
  const report = async () => {
    for (const id of unreported) {
      const ok = await call<{ already: boolean } | null>('mutation', api.delivery.handedOff, { id, route: 'waiter' }).then(
        (done) => {
          const c = made.get(id)
          // Counted or not, it is finished with: a wait that goes on for days keeps nothing of it
          made.delete(id)
          // A click made while the agent was already waiting was heard at once. One made before
          // had been waiting for the agent to come and ask.
          if (c && done && !done.already)
            usage.record('answer.delivered', {
              path: c.wasWaiting ? 'waited' : 'heard',
              after: usage.timeBand(Date.now() - c.at),
              agent: usage.agentOf(c.harness),
            })
          return true
        },
        (err) => /conflict|not_found/.test(String((err as Problem).code)),
      )
      if (ok) unreported.delete(id)
    }
  }
  /** Prints what the connector handed back and has not been printed yet, and tells It of it. */
  const printHandedBack = async () => {
    for (const c of handedBack.splice(0)) {
      // What the connector gave again is what this already had, and is said to it as printed.
      // Anything else only once it is: the connector lets go of its copy at that word
      if (printedIds.has(c.id)) {
        take(c.id)
        continue
      }
      await emit(printed(c))
      take(c.id)
      printedIds.add(c.id)
      if (printedIds.size > 5000) printedIds.delete(printedIds.values().next().value!)
      unreported.add(c.id)
      made.set(c.id, { at: c.at, harness: c.session?.harness, wasWaiting: false })
    }
    await report()
  }
  const onHandedBack = async () => {
    if (busy || ending || over || !handedBack.length) return
    busy = true
    try {
      await printHandedBack()
    } catch (err) {
      say(`wait: ${(err as Error).message}`)
      void finish(1)
    } finally {
      busy = false
    }
    // Ended only once this is no longer in the middle of anything: the ending waits for that
    if (printedIds.size > 0 && !follow) await finish(0)
  }
  const onClicks = async (clicks: Listed[]): Promise<'printed' | 'nothing' | 'failed'> => {
    if (busy || ending || over) return 'nothing'
    busy = true
    let came: 'printed' | 'nothing' | 'failed' = 'nothing'
    try {
      await report()
      const fresh = clicks.filter((c) => !printedIds.has(c.id) && mine(c))
      if (fresh.length) {
        const got = new Set<string>()
        if (slug) for (const id of await call<string[]>('mutation', api.delivery.claim, { ids: fresh.map((c) => c.id) })) got.add(id)
        // Waiting for its own conversation's clicks, each is claimed for the conversation it
        // was offered for: a page that has changed hands meanwhile keeps its click for its new owner
        else for (const c of fresh) for (const id of await call<string[]>('mutation', api.delivery.claim, { ids: [c.id], for: c.session! })) got.add(id)
        for (const c of fresh.filter((x) => got.has(x.id))) {
          // The wait ended while this was being asked for: it is given back, and not printed after the last word
          if (ending || over) {
            await call('mutation', api.delivery.release, { id: c.id }).catch(() => {})
            continue
          }
          // Out of this process first, and only then reported as handed over
          await emit(printed(c))
          came = 'printed'
          printedIds.add(c.id)
          if (printedIds.size > 5000) printedIds.delete(printedIds.values().next().value!)
          unreported.add(c.id)
          made.set(c.id, { at: c.at, harness: c.session?.harness, wasWaiting: !looked })
        }
        await report()
      }
      looked = true
    } catch (err) {
      say(`wait: ${(err as Error).message}`)
      if (came !== 'printed') came = 'failed'
      if (err instanceof Problem && err.code === 'output_failed') void finish(1)
    } finally {
      busy = false
    }
    // Having printed something, this ends even if It could not be told: the lease runs out
    // and the click is offered again, which an agent can tell by its id. Ended only now that
    // this is no longer in the middle of anything, which the ending waits for.
    if (printedIds.size > 0 && !follow) await finish(0)
    return came
  }
  // Read by the page, or by the conversation: never everything that is waiting, where other
  // conversations' clicks could stand in front of this one's
  const watched = new Map<string, Listed[]>()
  let latest: Listed[] = []
  const watch = (name: string, fn: unknown, args: Record<string, unknown>) =>
    client.onUpdate(
      fn as never,
      args as never,
      (clicks: Listed[]) => {
        watched.set(name, clicks)
        latest = [...watched.values()].flat().sort((x, y) => x.at - y.at)
        void onClicks(latest)
      },
      (err) => {
        // A refusal during the live wait follows the same policy as one before it began.
        void translate(err).catch((p: Problem) => {
          failure(p, a)
          void finish(1)
        })
      },
    )
  if (slug) watch('page', api.delivery.waiting, { slug })
  else for (const s of sessions) watch(`${s.harness}:${s.id}`, api.delivery.waitingFor, { session: s })
  // A click that arrived while another was being handled is picked up here
  const again = setInterval(() => void onHandedBack().then(() => onClicks(latest)), 1000)
  void onHandedBack()
  if (seconds > 0) {
    const timeUp = async (): Promise<void> => {
      const printedOne = () => printedIds.size > 0 && !follow
      // Something was printed, and this is ending with it: that was no wait in which nothing happened
      if (ending || printedOne()) return
      // Something is being printed or reported this moment: looked at again when that is done
      if (busy) return void setTimeout(() => void timeUp(), 250)
      const failed = async (p: Problem, what: string) => {
        // What the connector handed over meanwhile is the answer, where there is any: a wait
        // is said to have failed only where it got nothing
        deciding = true
        await announcing
        while (busy) await new Promise((resolve) => setTimeout(resolve, 50))
        await onHandedBack()
        if (ending || printedOne()) return
        failure(new Problem(`${what}: ${p.message}`, p.code, p.hint), a)
        clearInterval(again)
        void finish(1)
      }
      // "Nothing happened" is said only on It's own word, asked now: a wait that could not
      // reach It all the while has heard nothing, which is not the same. Nothing else is taken
      // or printed while that is asked, so that the last word and an action do not cross.
      busy = true
      let there: Listed[]
      try {
        there = (await waitingNow(sessions)).filter((c) => !printedIds.has(c.id) && mine(c))
      } catch (err) {
        busy = false
        if (ending || printedOne()) return
        return failed(
          err instanceof Problem ? err : new Problem(String((err as Error)?.message ?? err)),
          'The wait ran out of time, and It could not be asked then whether anything was waiting',
        )
      }
      busy = false
      // Something is waiting after all, and has only not been taken yet: it is taken now
      if (there.length) {
        const came = await onClicks(there)
        if (ending || printedOne()) return
        if (came === 'failed')
          return failed(
            new Problem('It could not be reached to take it.', 'offline'),
            'The wait ran out of time with something waiting that could not be taken',
          )
      }
      // What the connector handed back meanwhile, or is handing back this moment, is printed
      // like anything else: the connector gives a click to a waiter once, and a wait that then
      // said nothing had happened would have lost it. Nothing more is asked of it from here.
      deciding = true
      await announcing
      while (busy) await new Promise((resolve) => setTimeout(resolve, 50))
      await onHandedBack()
      if (ending || printedOne()) return
      // The last word, and nothing after it
      over = true
      clearInterval(again)
      try {
        await emit({ timedOut: true })
        void finish(0)
      } catch {
        void finish(1)
      }
    }
    // A timer of the runtime counts no further than some twenty-four days, and one given more
    // rings at once: a wait told to go on for a month would say in its first moment that nothing
    // had happened. So the time is waited out a day at most at a time, until it is up
    const until = performance.now() + seconds * 1000
    const later = (): void => {
      const left = until - performance.now()
      if (left <= 0) return void timeUp()
      setTimeout(later, Math.min(left, 86_400_000))
    }
    later()
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void finish(130))
  await new Promise(() => {})
}
