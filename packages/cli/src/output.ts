import type { Args } from './args'
import { type Problem, sessionAsked, written } from './lib'

const say = (line: string): void => written(process.stderr, `${line}\n`)

/**
 * Whether what a command prints is read by a person: standard output is a terminal, and JSON was
 * not asked for. A person is then told what they need in a few sentences, the most important
 * first. An agent, a script and a test read the JSON, which is what is printed everywhere else:
 * also an agent whose app gives its commands a terminal, which is told apart by the mark the
 * app puts on the commands its agent runs.
 */
export const forPerson = (a: Args): boolean => process.stdout.isTTY === true && a.flags.json !== true && sessionAsked() === undefined
/** Failures follow the same output policy as successful commands, and stay on standard error. */
export function failure(p: Problem, a: Args): void {
  if (forPerson(a)) {
    say(p.message)
    if (p.hint) say(p.hint)
  } else say(JSON.stringify({ error: { code: p.code, message: p.message, ...(p.hint ? { hint: p.hint } : {}) } }))
}

/**
 * Folds a line that a long-running command says over and over (the network is down, say) into a
 * count, so that its log is not filled with it. A line that is the same as the one before is
 * left out while it comes within a minute of the copy last written, up to 300 in a row. Past
 * either, it is written again, with how many times it was said since that copy. One that comes
 * again after a quiet minute is news, such as a conversation that is listening again, and is
 * written as it is. Answers what to write, or null where the line is left out.
 */
export function foldRepeats(withinMs = 60_000, most = 300): (line: string, now?: number) => string | null {
  let last: string | undefined
  let writtenAt = 0
  let folded = 0
  return (line, now = Date.now()) => {
    if (line === last && now - writtenAt < withinMs && folded + 1 < most) {
      folded += 1
      return null
    }
    const said = line === last && folded ? `${line} (${folded + 1} more times)` : line
    last = line
    writtenAt = now
    folded = 0
    return said
  }
}
