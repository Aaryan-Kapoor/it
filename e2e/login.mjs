// Joins a second machine, with a folder of its own, to the stack's It: an invite is asked for
// as the machine It runs on, and `it login` is run with it in the second machine's folder.
//   node e2e/login.mjs <IT_HOME> [machine name]

import path from 'node:path'
import { ask, it, machineToken, needsStack, noteSecret, patiently, STACK } from './lib.mjs'
import { printCleanly } from './logs.mjs'

/**
 * An invite for one machine: a code that is good once, for ten minutes. A machine that is
 * already one of the person's may ask for it, and here the machine It runs on does. The code
 * is one of the credentials a run holds. `wait` is how long it waits before asking again
 * when it is told to try again shortly.
 */
export async function inviteMachine({ home = STACK?.home, token = machineToken, asked = ask, wait = 2000 } = {}) {
  const as = await token(home)
  // Asked again where It says to try again shortly: It makes only so many codes in a minute
  const made = await patiently(() => asked('mutation', 'sessions:inviteMachine', {}, as), { wait })
  if (!made.ok || typeof made.value?.code !== 'string') throw new Error(`no invite was made for a machine (${made.code ?? 'the answer held no code'})`)
  noteSecret('an invite for a machine', made.value.code)
  return made.value.code
}

/**
 * Joins a machine to the stack's It, and resolves with what the program answered: the
 * machine's id and its name. It joins where a machine elsewhere would, at the door, and from
 * then on its folder is all its commands need. The last argument is what a test of this puts
 * stand-ins in through.
 */
export async function join(home, name = 'e2e machine', { run = it, invite = inviteMachine, at = STACK?.site } = {}) {
  return run(home, ['login', '--url', at, '--code', await invite(), '--name', name, '--no-setup'])
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [home, name] = process.argv.slice(2)
  if (!home) {
    console.error('usage: node e2e/login.mjs <IT_HOME> [name]')
    process.exit(2)
  }
  needsStack('This machine')
  // A machine that cannot join says why in what the program answered
  printCleanly()
  console.log(JSON.stringify(await join(home, name)))
}
