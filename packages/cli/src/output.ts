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
