// Waits for the stack (e2e/stack.mjs) to answer, and says what does not.
//   node e2e/ready.mjs [seconds]
// Exits 1 with the end of the stack's log when the time runs out, so that a CI run that could
// not start its stack shows why.
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { noStack, STACK_LOGS, sleep, stack } from './lib.mjs'
import { printCleanly, redact } from './logs.mjs'

printCleanly()

// Each thing the one service answers with when it is serving: the backend with It's functions
// in place, and the door with the site, which it opens last. Each is asked by address with
// the name beside it, so that this does not depend on how the machine looks a name up.
const parts = (at) => ({
  'the backend, with It’s functions loaded': { port: new URL(at.http).port, path: '/health' },
  'the door, with the site': { port: at.port, path: '/', host: `localhost:${at.port}` },
})
const up = ({ port, path: p, host }) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: host ? { host } : {}, timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
/** Whether the stack that noted itself is still running: one that could not start has said why and gone. */
const running = (at) => {
  try {
    process.kill(at.pid, 0)
    return true
  } catch {
    return false
  }
}
const end = Date.now() + Number(process.argv[2] ?? 240) * 1000
// The stack notes where it is as it starts, and answers some while after that
let at = stack()
let down = ['the stack’s note of where it is']
while (Date.now() < end) {
  at = stack()
  if (at) {
    down = []
    for (const [name, part] of Object.entries(parts(at))) if (!(await up(part))) down.push(name)
    if (!down.length || !running(at)) break
  }
  await sleep(1000)
}
if (down.length) {
  console.error(
    !at
      ? noStack()
      : running(at)
        ? `not answering: ${down.join('; ')}`
        : 'the stack that noted where it is has stopped: what it said as it did is in its own output',
  )
  for (const name of ['service.log', 'cli.said.log']) {
    const file = path.join(STACK_LOGS, name)
    // Cleaned of anything that is, or is shaped like, a credential: this goes to a CI step's own log
    console.error(`\n--- the end of ${file}\n${existsSync(file) ? redact(readFileSync(file, 'utf8').split('\n').slice(-40).join('\n')) : '(no such file)'}`)
  }
  process.exit(1)
}
console.log('the stack is answering')
