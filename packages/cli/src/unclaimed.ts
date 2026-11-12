// Pages made by an OpenCode that had not loaded It's add-on. OpenCode 1 reads its plugins only
// as it starts, and only the add-on tells a command which conversation it runs in. So a page
// that a conversation makes between `it setup` and OpenCode's next start names no conversation,
// and what is done on it waits in the inbox. Each such page is noted here, on this machine, and
// the OpenCode conversation that next names it, with `it update` or `it wait --id`, is given it,
// with what is waiting on it.

import { agentAppsAbove } from './ancestry'
import { type Asking, api, call, inHome, Problem, readJson, writePrivate } from './lib'

/** Where those pages are noted: in It's folder on this machine, and nowhere else. */
export const unclaimedFile = () => inHome('opencode-unclaimed.json')
/** How many are remembered: the ones noted last. */
const MOST = 50

/** Each noted page, by its id, with It's own record of it, so that a page deleted and made again under the same id is not taken for it. */
type Note = { at: number; page: string }
type Notes = Record<string, Note>
const isNote = (n: unknown): n is Note =>
  typeof n === 'object' && n !== null && typeof (n as Note).at === 'number' && typeof (n as Note).page === 'string' && (n as Note).page !== ''
const notes = (): Notes => {
  const read = readJson<Record<string, unknown>>(unclaimedFile())
  if (!read || typeof read !== 'object' || Array.isArray(read)) return {}
  return Object.fromEntries(Object.entries(read).filter(([, n]) => isNote(n))) as Notes
}

/**
 * Whether a command that names no conversation was run by OpenCode: no app has marked it, and
 * OpenCode is the agent app nearest above it. That is an OpenCode 1 that has not loaded It's
 * add-on, since one that has marks every command its agent runs. The processes above a command
 * are not looked up on Windows, so there it is never so.
 */
export function inUnloadedOpenCode(asked: Asking | undefined, above: () => readonly string[] = agentAppsAbove): boolean {
  return asked === undefined && above()[0] === 'opencode'
}

/** Notes that this page was made in such an OpenCode. A note that cannot be kept keeps nothing from being published. */
export function noteUnclaimed(slug: string, page: string, now = Date.now()): void {
  try {
    const all = Object.entries({ ...notes(), [slug]: { at: now, page } })
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(-MOST)
    writePrivate(unclaimedFile(), Object.fromEntries(all))
  } catch {}
}

/** Whether this page is noted as made in such an OpenCode, and given to no conversation since. */
export const unclaimed = (slug: string): boolean => Object.hasOwn(notes(), slug)

function forget(slug: string): void {
  try {
    const all = notes()
    if (!Object.hasOwn(all, slug)) return
    delete all[slug]
    writePrivate(unclaimedFile(), all)
  } catch {}
}

/** What It is asked: to give a page to a conversation only while no conversation has it. The tests give their own. */
export type Take = (page: string, session: { harness: string; id: string }) => Promise<{ took?: boolean } | null>
const takeUnowned: Take = (page, session) => call('mutation', api.artifacts.take, { artifactId: page, session, agent: session.harness, unowned: true })

/**
 * Gives a page that was made in an OpenCode without the add-on to the OpenCode conversation
 * that now names it, and answers whether it did. Only a page noted here, and only while no
 * conversation has it, which It tells in the same step that gives it: one that another
 * conversation has taken, by showing it or with --take, stays that conversation's, however
 * close together the two are, and the note goes. So does the note of a page that is gone. A
 * conversation of another app is given nothing this way. Whatever else goes wrong, nothing is
 * given, the note is kept for the next time, and the command carries on.
 */
export async function claimUnclaimed(
  slug: string | undefined,
  session: { harness: string; id: string } | undefined,
  take: Take = takeUnowned,
): Promise<boolean> {
  try {
    if (!slug || session?.harness !== 'opencode') return false
    const note = notes()[slug]
    if (!note) return false
    let answer: { took?: boolean } | null
    try {
      answer = await take(note.page, session)
    } catch (err) {
      if (err instanceof Problem && err.code === 'not_found') forget(slug)
      return false
    }
    forget(slug)
    return answer?.took === true
  } catch {
    return false
  }
}
