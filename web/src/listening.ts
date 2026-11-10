// Whether a page's conversation can hear what is done on the page, as It knows it from the
// machine the conversation is open on. This is the one place the site reads it: the notice that
// asks the person to type /reload-plugins goes by it, and so does anything else on the site that
// says whether a conversation hears its pages, so that the two never say different things.

/** As the page says it: `not_loaded` where its conversation is open and has not loaded It's add-on, null where It cannot say. */
export type Listening = 'yes' | 'no' | 'not_loaded' | null

/** Whether the page's conversation is open and has not loaded It's add-on, so that nothing done on the page reaches it until the person loads it. */
export const notLoaded = (listening: Listening | undefined): boolean => listening === 'not_loaded'

/** A conversation that has not loaded It's add-on, by its pages, as the site is told of it. */
export interface NotLoaded {
  harness: string
  slugs: string[]
  /** The title of its page that changed last, by which the person tells which conversation it is. */
  title: string
}

/** What the notice says, on a page whose conversation has not loaded the add-on, or elsewhere on the site, of those that have not. */
export function reloadWords(conversations: readonly NotLoaded[], slug?: string): string | null {
  if (slug !== undefined)
    return conversations.some((c) => c.slugs.includes(slug)) ? 'Your Claude Code chat can’t hear this page yet. Type /reload-plugins in that chat.' : null
  if (conversations.length === 0) return null
  if (conversations.length === 1) return `Your Claude Code chat can’t hear “${conversations[0]!.title}” yet. Type /reload-plugins in that chat.`
  return `${conversations.length} of your Claude Code chats can’t hear their pages yet. Type /reload-plugins in each of them.`
}
