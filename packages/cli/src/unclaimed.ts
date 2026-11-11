// Pages made by an OpenCode that had not loaded It's add-on. OpenCode 1 reads its plugins only
// as it starts, and only the add-on tells a command which conversation it runs in. So a page
// that a conversation makes between `it setup` and OpenCode's next start names no conversation,
// and what is done on it waits in the inbox. Each such page is noted here, on this machine, and
// the OpenCode conversation that next names it, with `it update` or `it wait --id`, is given it,
// with what is waiting on it.

import { agentAppsAbove } from './ancestry'
import { type Asking, api, call, inHome, readJson, writePrivate } from './lib'

/** Where those pages are noted: in It's folder on this machine, and nowhere else. */
export const unclaimedFile = () => inHome('opencode-unclaimed.json')
/** How many are remembered: the ones noted last. */
const MOST = 50

type Notes = Record<string, { at: number }>
const notes = (): Notes => {
  const read = readJson<Notes>(unclaimedFile())
  return read && typeof read === 'object' && !Array.isArray(read) ? read : {}
}

/**
 * Whether a command that names no conversation was run by OpenCode: no app has marked it, and
 * OpenCode is the agent app nearest above it. That is an OpenCode 1 that has not loaded It's
 * add-on, since one that has marks every command its agent runs.
 */
export function inUnloadedOpenCode(asked: Asking | undefined, above: () => readonly string[] = agentAppsAbove): boolean {
  return asked === undefined && above()[0] === 'opencode'
}

/** Notes that this page was made in such an OpenCode. A note that cannot be kept keeps nothing from being published. */
export function noteUnclaimed(slug: string, now = Date.now()): void {
  try {
    const all = Object.entries({ ...notes(), [slug]: { at: now } })
      .sort(([, a], [, b]) => (a?.at ?? 0) - (b?.at ?? 0))
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

/** What It is asked: which conversation has a page, and to give a page to one. The tests give their own. */
export interface Backend {
  owner(slug: string): Promise<{ session?: { harness: string; id: string } | null } | null>
  take(slug: string, session: { harness: string; id: string }): Promise<unknown>
}
const backend: Backend = {
  owner: (slug) => call('query', api.artifacts.get, { slug }),
  take: (slug, session) => call('mutation', api.artifacts.take, { slug, session, agent: session.harness }),
}

/**
 * Gives a page that was made in an OpenCode without the add-on to the OpenCode conversation
 * that now names it, and answers whether it did. Only a page noted here, and only while no
 * conversation has it: one that another conversation has taken meanwhile, by showing it or with
 * --take, stays that conversation's, and the note goes. A conversation of another app is given
 * nothing this way. Whatever goes wrong, nothing is given and the command carries on.
 */
export async function claimUnclaimed(slug: string | undefined, session: { harness: string; id: string } | undefined, ask: Backend = backend): Promise<boolean> {
  try {
    if (!slug || session?.harness !== 'opencode' || !unclaimed(slug)) return false
    const page = await ask.owner(slug)
    if (!page) return false
    if (page.session) {
      forget(slug)
      return false
    }
    await ask.take(slug, session)
    forget(slug)
    return true
  } catch {
    return false
  }
}
