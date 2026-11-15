// repro-bun-spawnsync-timeout.ts's pattern through It's own `runSync` (packages/cli/src/child.ts,
// #497), compiled with the Bun the release is built with: one child, then a wait longer than
// the next child's limit, then a two-second PowerShell with a limit of 60 s; and the same with
// `spawnSync` itself, to show the fault is still there underneath.
//   bun build --compile e2e/rehearsal/repro-runsync.ts --target=bun-windows-x64-baseline --outfile repro-runsync.exe
//   repro-runsync <wait seconds> runsync|spawnsync
import { spawnSync } from 'node:child_process'
import { runSync } from '../../packages/cli/src/child'

const waitS = Number(process.argv[2] ?? 90)
const how = process.argv[3] ?? 'runsync'
const run = how === 'runsync' ? runSync : spawnSync
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo first'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
await new Promise((r) => setTimeout(r, waitS * 1000))
const t0 = Date.now()
const ran = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 2; echo hello'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
console.log(
  JSON.stringify({
    how,
    runtime: typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? `node ${process.version}` : `bun ${(globalThis as { Bun: { version: string } }).Bun.version}`,
    waitS,
    ms: Date.now() - t0,
    status: ran.status,
    signal: ran.signal,
    error: ran.error ? String((ran.error as NodeJS.ErrnoException).code) : null,
    out: String(ran.stdout).trim(),
  }),
)
process.exit(0)
