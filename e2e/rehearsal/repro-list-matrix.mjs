// Runs repro-list-bun (compiled with Bun, and the same source under Node) in each way a parent can
// start It's program on Windows, with each variant, and prints one line per run:
//   node e2e/rehearsal/repro-list-matrix.mjs [--variants "as,env,progress,stdin-ignore,env+progress"]
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const EXE = 'D:\\it-rehearsal\\work\\repro\\repro-list-bun.exe'
const SRC = path.join(here, 'repro-list-bun.ts')
const OUT = 'D:\\it-rehearsal\\work\\repro\\out'
mkdirSync(OUT, { recursive: true })
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const variants = arg('variants', 'as,env,progress,stdin-ignore').split(',')
const parents = arg('parents', 'console,hidden,detached').split(',')
const runtimes = arg('runtimes', 'bun,node').split(',')
let n = 0
for (const runtime of runtimes)
  for (const parent of parents)
    for (const v of variants) {
      const words = v === 'as' ? [] : v.split('+')
      const file = path.join(OUT, `r${++n}.txt`)
      rmSync(file, { force: true })
      const fd = openSync(file, 'w')
      const [cmd, argv] = runtime === 'bun' ? [EXE, words] : [process.execPath, ['--experimental-strip-types', '--no-warnings', SRC, ...words]]
      // console: a console of its own, as from a terminal; hidden: a hidden console (windowsHide);
      // detached: no console at all (DETACHED_PROCESS), as a program started by a service or WMI has
      const child = spawn(cmd, argv, {
        stdio: ['ignore', fd, fd],
        windowsHide: parent !== 'console',
        detached: parent === 'detached',
        env: { ...process.env, REPRO_TIMEOUT_MS: '45000' },
      })
      await new Promise((r) => child.on('close', r))
      closeSync(fd)
      const line = readFileSync(file, 'utf8').trim().split(/\r?\n/).pop()
      let j = {}
      try {
        j = JSON.parse(line)
      } catch {}
      console.log(`${runtime.padEnd(4)} ${parent.padEnd(8)} ${v.padEnd(14)} ${String(j.ms ?? '?').padStart(6)} ms  status ${j.status} error ${j.error} self ${j.self} end ${j.end}`)
    }
