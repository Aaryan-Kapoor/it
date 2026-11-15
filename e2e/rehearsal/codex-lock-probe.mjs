// What It on Windows sees of whether a Codex conversation is open: each file in
// <CODEX_HOME>\thread-writer-locks read as `lockedElsewhere` in packages/cli/src/wake.ts reads it
// (opened for reading, its first byte read: refused while a program holds a lock on it), with
// the time. Prints one line per lock file: locked / not locked / could not tell.
//   node e2e/rehearsal/codex-lock-probe.mjs <CODEX_HOME>
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

const dir = path.join(process.argv[2], 'thread-writer-locks')
if (!existsSync(dir)) {
  console.log(`${new Date().toISOString()} no thread-writer-locks folder`)
  process.exit(0)
}
for (const name of readdirSync(dir)) {
  const file = path.join(dir, name)
  let said
  let fd
  try {
    fd = openSync(file, 'r')
  } catch (e) {
    said = `could not open (${e.code})`
  }
  if (fd !== undefined) {
    try {
      readSync(fd, Buffer.alloc(1), 0, 1, 0)
      said = 'NOT locked (It takes the conversation for closed)'
    } catch (e) {
      said = e.code === 'EBUSY' || e.code === 'EPERM' || /lock/i.test(e.message) ? `locked (${e.code}; It takes it for open elsewhere)` : `could not tell (${e.code})`
    } finally {
      closeSync(fd)
    }
  }
  console.log(`${new Date().toISOString()} ${name} (${statSync(file).size} bytes): ${said}`)
}
