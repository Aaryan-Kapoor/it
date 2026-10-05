// What It does on the computer it runs on, said to the owner in Settings: where everything is
// kept and for how long, what runs and listens there, what is fetched to it, and the two things
// that leave it. The owner may be reading on another computer, so none of it speaks of "this
// computer". What only that computer can know (whether It is registered to start by itself,
// whether counts of its use are sent, and which port it counts from) is what the service there
// has told the backend, and is said as a fact only once the service has said it.
import { contentPort, LIMITS, PORTS, RETENTION } from '@it/protocol'
import { useQuery } from 'convex/react'
import { api } from './lib'
import { UNSENT_DAYS } from './outbox'

/** A number of days, in words. */
const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`
/**
 * How long the backend program keeps the earlier versions of a record inside its database file
 * after the record is changed or removed, in words. The service starts the program with an hour
 * for it, and the program clears them away in passes of its own, a minute or two after.
 */
export const REMOVED_STAYS = 'about an hour'
/**
 * How long the backend program keeps its own note of a task it ran in the background, in words.
 * The note holds what the task was started with, which is the id of what it was about and
 * never a person's own id (convex/retention.ts, convex/logs.ts). The service starts the program
 * with an hour for these as well, where the program left to itself keeps each for seven days.
 */
export const TASKS_STAY = 'about an hour'

/** What the service says of itself (`network.service`). Each of the last two is null while it has not said. */
interface Itself {
  port: number
  background: boolean | null
  usage: boolean | null
}

/**
 * The ports It uses, each by its number, counted from the one the service says it counts from:
 * that one, the one after it for pages, and the two of the backend program. Until that is
 * known there is nothing to count from, and only how many there are is said.
 */
function ports(base: number | undefined): string {
  if (base === undefined) return 'one for this site, one for pages, and two for its backend program'
  return `${base} for this site, ${contentPort(base)} for pages, and ${base + PORTS.backendApi} and ${base + PORTS.backendSite} for its backend program`
}

/** When It runs: as the service said, or, while it has not said, both ways it can be. */
function Runs({ background }: { background: boolean | null | undefined }) {
  if (background === true) return <p className="muted">It starts when that computer starts, or when you log in to it, and keeps running in the background.</p>
  if (background === false)
    return (
      <p className="muted">
        It is not registered to start by itself on that computer: it runs for as long as <code>it serve</code> is kept running there. To have it start by
        itself, run <code>it service install</code> there.
      </p>
    )
  return (
    <p className="muted">
      Where it is registered as a background service, which <code>it setup</code> does unless it is told not to, It starts when that computer starts, or when
      you log in to it, and keeps running in the background. Otherwise it runs for as long as <code>it serve</code> is kept running there.
    </p>
  )
}

/** Whether counts of its use leave the computer: as the service said, or, while it has not said, on what it depends. */
function Usage({ usage }: { usage: boolean | null | undefined }) {
  const where = (
    <>
      to <span className="mono">itcan.do</span>, under a random id for this installation: that it started, that a page was published, that an answer reached an
      agent
    </>
  )
  if (usage === false)
    return (
      <p className="muted">
        It is sending no counts of how it is used. When usage reporting is on, it sends them {where}, and never anything that is on a page. On the computer It
        runs on, <code>it telemetry</code> says whether it is on.
      </p>
    )
  return (
    <p className="muted">
      {usage === true ? 'It sends counts of how it is used ' : 'Unless usage reporting has been turned off, It sends counts of how it is used '}
      {where}. Nothing that is on a page is ever among them. To turn that off, run <code>it telemetry off</code> on the computer It runs on.
    </p>
  )
}

/** The section of the owner's Settings that says what It does on the computer it runs on. */
export function WhatItDoes() {
  const itself = useQuery(api.network.service, {}) as Itself | undefined
  return (
    <section className="panel">
      <h3>What It does on the computer it runs on</h3>
      <p className="muted">
        Everything It holds is kept on the computer It runs on, in the folder <code>~/.it</code> (or the one <code>IT_HOME</code> names, if you set that): your
        pages, their files, and every record of them. Beside its database in that folder It keeps a copy of the database as it was before each of the last two
        updates that changed it. Nothing It holds is kept on any other computer.
      </p>
      <p className="muted">
        A browser that is paired keeps a little of its own: the cookie that is its pairing and that cookie’s name, which display it is, what you did on a page
        until that has reached It, and, where you turned notifications on, the script that shows them. What it could not send within {days(UNSENT_DAYS)} it
        gives up. When its pairing ends, it keeps the cookie’s name for a day more, to ask for the cookie to be cleared again should an answer that was on its
        way put it back.
      </p>
      <p className="muted">
        A page is kept, with its {LIMITS.versionsKept} newest versions, until you delete it. What you do on a page is kept for{' '}
        {days(RETENTION.handledActionDays)} after an agent has received it, and for {days(RETENTION.pendingActionDays)} if none has. A notification is kept for{' '}
        {days(RETENTION.notificationDays)}. A machine you revoke is remembered for 30 days, and for as long after that as a page it made is still there. The key
        of a display you forget is refused for 90 days.
      </p>
      <p className="muted">
        What is removed from the database, by you or by its age, stays inside the database’s file for {REMOVED_STAYS} more, where nothing of It reads it: the
        backend program keeps the earlier versions of what it holds for that long. Traces of it can stay in the file’s unused space after that, until the
        program writes over them. For {TASKS_STAY} the program also keeps a note of each task it ran in the background, by the id of the machine, the page, the
        notification or the conversation the task was about, with nothing that was on a page.
      </p>
      <p className="muted">A browser you pair stays paired while it is used, and for a year after it was last used.</p>
      <Runs background={itself?.background} />
      <p className="muted">It uses four ports: {ports(itself?.port)}. The backend program’s two answer the computer It runs on and no other.</p>
      <p className="muted">
        Its backend program is made by Convex. It is fetched from Convex’s releases on GitHub the first time It runs, and again when a newer It needs a newer
        one.
      </p>
      <p className="muted">
        A notification to a browser that asked for them travels through the push service of that browser’s maker, sealed so that only that browser can read it.
      </p>
      <Usage usage={itself?.usage} />
    </section>
  )
}
