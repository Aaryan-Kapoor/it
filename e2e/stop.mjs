// Asks the stack (e2e/stack.mjs) to stop, waits until it has, and says how it stopped.
//   node e2e/stop.mjs [seconds]
// Exits 0 only when the stack has gone and has noted that everything stopped when it was asked
// to. It exits 1 when the stack is still there after the wait, when the stack had to make the
// service or a backend program stop, and when the stack ended without saying how: in each of
// those the logs may not be whole, and a run is not one that passed. A stack that was started
// in the background ends with nobody to read how it ended, and this is where that is read.
//
// The wait is two and a half minutes unless it is given: the stack gives the service a minute
// to stop, and a backend program left behind another.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { noStack, STACK_LOGS, sleep, stackNote } from './lib.mjs'

/** The stack's note as it stands, whole: where it is, and once it has stopped, how. */
const note = () => {
  try {
    return JSON.parse(readFileSync(stackNote(), 'utf8'))
  } catch {
    return null
  }
}
/**
 * Whether a program is still running. One that has ended and has not yet been taken note of by
 * whatever started it still answers to its number, and is not running: the system says which.
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    // Where the system cannot be asked, or does not know the number any more
    return process.platform === 'win32'
  }
}
/** The end of what the stack itself said, where whoever started it kept that beside its log. */
const lastSaid = () => {
  const file = path.join(STACK_LOGS, 'stack.log')
  return existsSync(file) ? `\n--- the end of ${file}\n${readFileSync(file, 'utf8').split('\n').slice(-12).join('\n')}` : ''
}

const first = note()
if (!first || !Number.isInteger(first.pid)) {
  console.error(noStack())
  process.exit(2)
}
const seconds = Number(process.argv[2] ?? 150)
if (alive(first.pid)) process.kill(first.pid, 'SIGTERM')
for (const end = Date.now() + seconds * 1000; alive(first.pid) && Date.now() < end; ) await sleep(200)
if (alive(first.pid)) {
  console.error(
    `The stack had not stopped ${seconds} seconds after it was asked to (pid ${first.pid}). It is left running, and what it wrote is not yet whole.${lastSaid()}`,
  )
  process.exit(1)
}
const last = note()
if (last?.stopped === 'when asked' && !last.forced?.length) {
  console.log('the stack has stopped, and everything stopped when it was asked to')
  process.exit(0)
}
console.error(
  last?.stopped
    ? `The stack has stopped, and not everything stopped when it was asked to: ${(last.forced ?? ['a backend program is still running']).join('; ')}.`
    : `The stack has gone without saying how it stopped, so it did not stop as it does when it is asked.${lastSaid()}`,
)
process.exit(1)
