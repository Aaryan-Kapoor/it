// Why a conversation's click could not be handed over by reopening it, by Codex's queue or by
// its thread of T3 Code, as one of a few fixed words. Usage reporting sends the word with
// `agent.woken` when the hand-over was declined or failed. The refusal itself is said in this
// program's own words, which may name an app and how it ended, and those go to the page and to
// the log on this machine: only the word made from them leaves it.

/** Every word there is for why a hand-over did not happen, and `none` for one that did. */
export const WAKE_WHY = [
  'none',
  'not_found',
  'not_started',
  'exited',
  'timeout',
  'unnoted',
  'bad_id',
  'unsupported',
  'no_folder',
  'profile',
  'unconfirmed',
  'reopening',
  'runs_unread',
  'unsettled',
  'untold',
  't3_unreachable',
  't3_refused',
  'other',
] as const
export type WakeWhy = (typeof WAKE_WHY)[number]

/**
 * Each refusal this program says, by how it begins or ends, with its word. The first that fits
 * is taken. T3 Code's come first, since one of them would otherwise be taken for an app that
 * did not answer in time.
 */
const RULES: readonly (readonly [RegExp, WakeWhy])[] = [
  [/^T3 Code (could not be reached|closed the connection|did not answer in time)/, 't3_unreachable'],
  [/^T3 Code (refused the message|failed at the message|did not let It in)/, 't3_refused'],
  [/^an open app cannot confirm which idle conversations it holds/, 'unconfirmed'],
  [/^the folder its conversation was held in is not known/, 'no_folder'],
  [/^its (recorded )?app profile /, 'profile'],
  [/^its conversation id is not one .+ would have made$/, 'bad_id'],
  [/^It has no way to reopen a conversation of /, 'unsupported'],
  [/^it is being reopened already$/, 'reopening'],
  [/^It could not read its own note of which conversations were running/, 'runs_unread'],
  [/^a turn of it from before may still be running/, 'unsettled'],
  [/^It could not be told that the conversation was being reopened/, 'untold'],
  [/ was started and could not be noted down/, 'unnoted'],
  [/ (had not finished in fifteen minutes|did not answer in thirty seconds)$/, 'timeout'],
  [/ could not be started\b/, 'not_started'],
  [/ was not found$/, 'not_found'],
  [/ exited with /, 'exited'],
]

/** The word for a refusal, or `other` for one that this list does not know. */
export function wakeWhy(refusal: string): WakeWhy {
  for (const [shape, word] of RULES) if (shape.test(refusal)) return word
  return 'other'
}
