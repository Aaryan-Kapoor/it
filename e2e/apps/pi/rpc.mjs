// The real Pi, driven as a host drives it with no terminal: `pi --mode rpc`, one JSON record a
// line on its standard input and output. Every record Pi prints is kept, and a command is
// matched to its response by the id it was sent with.
import { spawn } from 'node:child_process'

/** Starts `pi` with these arguments in `cwd` and `env`. */
export function startPi(program, args, { cwd, env }) {
  const child = spawn(program, ['--mode', 'rpc', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const records = []
  let pending = Buffer.alloc(0)
  let stderr = ''
  let asked = 0
  // Records are split on a line feed alone, as Pi's documentation asks: a JSON string may hold
  // the separators that a reader of lines would also split on
  child.stdout.on('data', (piece) => {
    pending = Buffer.concat([pending, piece])
    for (let at = pending.indexOf(10); at >= 0; at = pending.indexOf(10)) {
      const line = pending.subarray(0, at).toString('utf8').replace(/\r$/, '')
      pending = pending.subarray(at + 1)
      try {
        records.push(JSON.parse(line))
      } catch {
        records.push({ type: 'unreadable', line: line.slice(0, 200) })
      }
    }
  })
  child.stderr.on('data', (d) => {
    if (stderr.length < 64 * 1024) stderr += d
  })
  // A Pi that ended takes no more commands, and a write to it is not to end this program
  child.stdin.on('error', () => {})
  let ended = null
  child.on('close', (code, signal) => (ended = { code, signal }))
  child.on('error', (err) => (ended = { error: err.message }))
  const until = async (test, ms) => {
    const end = Date.now() + ms
    for (;;) {
      const found = records.find(test)
      if (found || Date.now() > end || ended) return found ?? null
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return {
    child,
    records,
    stderr: () => stderr,
    ended: () => ended,
    /** Sends a command and waits for Pi's response to it; null where none came in time. */
    async command(type, fields = {}, ms = 30_000) {
      const id = `it-check-${++asked}`
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
      return until((r) => r.type === 'response' && r.id === id, ms)
    },
    /** Waits for a record that `test` picks, from the `from`th record on. */
    until: (test, ms, from = 0) => until((r) => records.indexOf(r) >= from && test(r), ms),
    /** Closes Pi's input, which asks it to shut down in order, and waits for it to end. */
    async close(ms = 20_000) {
      if (ended) return ended
      child.stdin.end()
      const end = Date.now() + ms
      while (!ended && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
      if (!ended) {
        child.kill('SIGTERM')
        while (!ended && Date.now() < end + 5000) await new Promise((r) => setTimeout(r, 100))
      }
      if (!ended) child.kill('SIGKILL')
      return ended
    },
  }
}
