// What became of the last things done on a page, step by step: when each was made, when It got
// it, which conversation it was for, whether it was handed over, held back, set aside or dropped
// by a stop, and what became of the work it started. Everything said here is read from what It
// already keeps of a click, and none of it is what the click carried.

import { IconX } from './brand'
import { agentName, ago } from './lib'

/** A click as `actions.forArtifact` gives it to a browser. */
export type Click = {
  id: string
  at: number
  madeAt: number
  delivery: 'pending' | 'leased' | 'handed_off'
  route: string | null
  outcome: 'running' | 'succeeded' | 'failed' | 'unknown' | null
  attended: boolean | null
  handedAt: number | null
  parked: boolean
  heldBack: string | null
  /** Its number on its page, which conversation it is for, and in which app. Older functions say none of the three. */
  seq?: number | null
  harness?: string | null
  conversation?: string | null
}

export type Tone = 'ok' | 'wait' | 'bad' | 'none'
/** One thing that happened to a click, as a fixed word, with when it did where that is kept. */
export type Step = { code: string; at: number | null; tone: Tone; text: string }

/** A click that reached It this long after it was made waited in its browser first. */
const WAITED_MS = 5_000

/** A conversation's id is long, and its first few characters tell it from the others on a page. */
export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id)

/** What happened to one click, in order. The last step is where it is now. */
export function stepsOf(c: Click): Step[] {
  const steps: Step[] = []
  const who = c.attended === null ? '' : c.attended ? ', with someone at the page' : ', with nobody at the page'
  steps.push({ code: 'made', at: c.madeAt, tone: 'ok', text: `Made on the page${who}` })
  steps.push({
    code: c.at - c.madeAt > WAITED_MS ? 'received_late' : 'received',
    at: c.at,
    tone: 'ok',
    text: c.at - c.madeAt > WAITED_MS ? 'It received it, after it waited in the browser' : 'It received it',
  })
  if (c.harness !== undefined || c.conversation !== undefined)
    steps.push(
      c.harness && c.conversation
        ? { code: 'addressed', at: null, tone: 'ok', text: `For ${agentName(c.harness) ?? c.harness}, conversation ${shortId(c.conversation)}` }
        : { code: 'unaddressed', at: null, tone: 'bad', text: 'It has no conversation to go to' },
    )
  if (c.delivery === 'handed_off' && c.route === 'stopped') {
    steps.push({ code: 'stopped', at: c.handedAt, tone: 'none', text: 'Dropped by a stop, and not given to the agent' })
    return steps
  }
  if (c.delivery === 'handed_off') {
    steps.push({ code: 'handed', at: c.handedAt, tone: 'ok', text: `Handed to the agent${c.route ? ` (${c.route})` : ''}` })
    if (c.outcome === 'running') steps.push({ code: 'running', at: null, tone: 'wait', text: 'The work it started is running' })
    else if (c.outcome === 'succeeded') steps.push({ code: 'succeeded', at: null, tone: 'ok', text: 'The work it started ended well' })
    else if (c.outcome === 'failed') steps.push({ code: 'failed', at: null, tone: 'bad', text: 'The work it started failed' })
    else steps.push({ code: 'unknown', at: null, tone: 'none', text: 'What became of the work is not known' })
    return steps
  }
  if (c.delivery === 'leased') steps.push({ code: 'delivering', at: null, tone: 'wait', text: 'A machine is delivering it now' })
  else if (c.heldBack !== null) steps.push({ code: 'held', at: null, tone: 'bad', text: `Held back: ${c.heldBack}` })
  else if (c.parked) steps.push({ code: 'set_aside', at: null, tone: 'bad', text: 'Set aside, after tries that came to nothing' })
  else steps.push({ code: 'waiting', at: null, tone: 'wait', text: 'Waiting for the agent to take it' })
  return steps
}

/** What the conversation itself last said or was told, beside the clicks. */
export type Conversation = {
  run: { since: number; stopping: boolean } | null
  wakeFailed: { at: number; why: string } | null
  stoppedAt: number | null
}

/** The time of day, to the second: two clicks a moment apart are told apart by it. */
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function Activity({
  clicks,
  conversation,
  now,
  onClose,
}: {
  clicks: Click[] | undefined
  conversation: Conversation
  now: number
  onClose: () => void
}) {
  return (
    <section className="page-activity" aria-label="Activity on this page">
      <header>
        <h2>Activity</h2>
        <span className="page-activity-note">The last things done here, and where each got to. Nothing of what they carried is shown.</span>
        <button type="button" className="page-talk-x" aria-label="Close activity" title="Close" onClick={onClose}>
          <IconX />
        </button>
      </header>
      {(conversation.run || conversation.wakeFailed || conversation.stoppedAt) && (
        <ul className="page-activity-conversation">
          {conversation.run && (
            <li data-tone="wait">
              It reopened the conversation {ago(conversation.run.since, now)}
              {conversation.run.stopping ? ', and it has been asked to stop' : ', and it is at work'}
            </li>
          )}
          {conversation.wakeFailed && (
            <li data-tone="bad">
              The conversation could not be reopened {ago(conversation.wakeFailed.at, now)}: {conversation.wakeFailed.why}
            </li>
          )}
          {conversation.stoppedAt && <li data-tone="none">The conversation was stopped {ago(conversation.stoppedAt, now)}</li>}
        </ul>
      )}
      {clicks === undefined ? (
        <p role="status">Loading</p>
      ) : clicks.length === 0 ? (
        <p>Nothing has been done on this page yet.</p>
      ) : (
        <ol className="page-activity-list">
          {clicks.map((c) => {
            const steps = stepsOf(c)
            const last = steps[steps.length - 1]!
            return (
              <li key={c.id} data-tone={last.tone}>
                <details>
                  <summary>
                    <span className="page-activity-n">{c.seq ? `#${c.seq}` : 'Click'}</span>
                    <span className="page-activity-last">{last.text}</span>
                    <time dateTime={new Date(c.madeAt).toISOString()}>{ago(c.madeAt, now)}</time>
                  </summary>
                  <ol className="page-activity-steps">
                    {steps.map((s) => (
                      <li key={s.code} data-tone={s.tone} data-code={s.code}>
                        <span className="page-activity-text">{s.text}</span>
                        {s.at !== null && <time dateTime={new Date(s.at).toISOString()}>{clock(s.at)}</time>}
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
