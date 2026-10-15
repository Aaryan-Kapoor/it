// `it hook <harness>`: what a harness's own hook mechanism runs. It is one fixed command whose
// text never changes between releases, because a harness asks the person to approve a hook
// again whenever its definition changes. All the logic is here.
//
// A hook must never break the agent's turn: if the connector is not running, or anything goes
// wrong, this prints nothing and exits 0.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { behindMark, MARK, WHEN } from '@it/protocol'
import { ADDON_API } from './addon-runtime'
import { ADDONS } from './addons.generated'
import { type Delivered, local } from './connector'
import { textOf, written } from './lib'
import { profileOf } from './profiles'
import { hookSeenFile } from './setup'

async function stdin(): Promise<Record<string, any>> {
  if (process.stdin.isTTY) return {}
  const text = await textOf(process.stdin)
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

/** Codex: SessionStart, UserPromptSubmit, PostToolUse and Stop all run this. */
async function codex(): Promise<void> {
  const ev = await stdin()
  const session = String(ev.session_id ?? process.env.CODEX_THREAD_ID ?? '')
  const event = String(ev.hook_event_name ?? '')
  if (!session || !['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event)) return
  // Codex only runs a hook the person has approved, so being run by Codex is the proof of
  // approval. Being run by hand, with nothing on standard input, proves nothing.
  // Where Codex runs a hook, It's folder may not be writable. Noting the approval is then
  // skipped, and the hook still does what it is for.
  try {
    const seen = hookSeenFile('codex')
    if (!existsSync(seen)) {
      mkdirSync(path.dirname(seen), { recursive: true })
      writeFileSync(seen, '')
    }
  } catch {}
  // The folder the conversation is held in is said with everything the connector is told.
  // Codex runs the agent's own commands where It's folder cannot be written, so the `it` that
  // publishes a page there cannot note it, and a conversation whose folder is not known is
  // never reopened.
  const from = {
    harness: 'codex',
    session,
    profile: profileOf('codex'),
    instance: `codex-${session}`,
    addon: { api: ADDON_API, version: ADDONS.codex!.version, delivery: true, idle: true },
    ...(typeof ev.cwd === 'string' && path.isAbsolute(ev.cwd) ? { folder: ev.cwd } : {}),
  }
  if (event === 'SessionStart') {
    // Said to Codex as a conversation starts, beside what it is given then: when a page is the
    // answer. Written out before the connector is told, so that a connector that is slow or
    // not there takes nothing from it
    written(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: WHEN } }))
    await local('/session', { method: 'POST', body: from })
    return
  }
  /**
   * What the marks that were put into this conversation stand for, where the connector holds
   * any, and how to say afterwards that the agent has it. The connector keeps it until told
   * so: said first, then confirmed, as a click is, so that a hook that dies in between leaves
   * nothing lost.
   */
  const marked = async (own = false): Promise<{ texts: string[]; taken: () => Promise<unknown> }> => {
    const got = await local<{ texts?: string[]; marks?: string[] }>('/marked', { method: 'POST', body: { ...from, ...(own ? { own: true } : {}) } })
    const marks = got?.marks ?? []
    return { texts: got?.texts ?? [], taken: async () => (marks.length ? local('/marked', { method: 'POST', body: { ...from, taken: marks } }) : null) }
  }
  if (event === 'UserPromptSubmit') {
    await local('/session', { method: 'POST', body: { ...from, busy: true } })
    // A turn that It started with its mark alone: the agent is handed what the mark stands
    // for here, beside the message and out of the person's sight. Not for a message of the
    // person's own, where Codex says what the message is: the mark's own turn is still to come,
    // and only what has waited past its time goes with a message of theirs.
    const behind = await marked(typeof ev.prompt === 'string' && !ev.prompt.includes(MARK))
    if (!behind.texts.length) return
    written(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: behindMark(behind.texts) } }))
    await behind.taken()
    return
  }
  const got = await local<{ clicks: Delivered[] }>(`/clicks?harness=codex&session=${encodeURIComponent(session)}`, {
    method: 'POST',
    body: { ...from, busy: true },
  })
  // A mark that was put into a turn that is running starts no turn of its own, so no hook ran
  // for it as one began: what it stands for is handed over here, at the next moment one runs
  const behind = await marked()
  if (!got?.clicks.length && !behind.texts.length) {
    if (event === 'Stop') await local('/session', { method: 'POST', body: { ...from, busy: false } })
    return
  }
  const clicks = got?.clicks ?? []
  // It arrives in the middle of what the agent is doing, and may well read like the very thing
  // it is doing (a second press of the same button). Said to be another, it is answered as another.
  const several = clicks.length > 1
  const arrived = clicks.length
    ? `[It] ${several ? 'These arrived' : 'This arrived'} while you were working. ${several ? 'Each is a separate action with an id of its own' : 'It is a separate action with an id of its own'}, to be answered as well as what you were already doing, and not instead of it:\n${clicks.map((c) => c.text).join('\n')}`
    : ''
  const text = [behind.texts.length ? behindMark(behind.texts) : '', arrived].filter(Boolean).join('\n\n')
  // Said first, then confirmed: if this process dies in between, the click is offered again,
  // and its id in the text lets the agent see that it is the same one
  written(
    process.stdout,
    JSON.stringify(
      event === 'PostToolUse' ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } : { decision: 'block', reason: text },
    ),
  )
  await behind.taken()
  if (clicks.length) await local('/ack', { method: 'POST', body: { ids: clicks.map((c) => c.id), woke: false } })
}

export async function hook(harness: string): Promise<void> {
  try {
    if (harness === 'codex') await codex()
  } catch {}
}
