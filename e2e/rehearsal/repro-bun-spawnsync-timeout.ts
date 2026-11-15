// Whether a spawnSync with a timeout, then a wait longer than the next one's timeout, makes Bun's
// next spawnSync report ETIMEDOUT at once: as setup runs service.install()'s PowerShell
// (timeout 30 s, SIGKILL), waits up to 90 s for the service, then lists processes (timeout 60 s).
//   two-spawnsyncs <wait seconds> [first: timed|untimed|none] [wait: idle|fetch]
import { spawnSync } from 'node:child_process'
const waitS = Number(process.argv[2] ?? 90)
const first = process.argv[3] ?? 'timed'
const how = process.argv[4] ?? 'fetch'
const rt = typeof (globalThis as any).Bun === 'undefined' ? `node ${process.version}` : `bun ${(globalThis as any).Bun.version}`
if (first !== 'none') spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo first'], { encoding: 'utf8', windowsHide: true, env: process.env, ...(first === 'timed' ? { timeout: 30_000, killSignal: 'SIGKILL' as const } : {}) })
const until = Date.now() + waitS * 1000
while (Date.now() < until) {
  if (how === 'fetch') await fetch('http://127.0.0.1:9/health', { signal: AbortSignal.timeout(2000) }).then(() => 0, () => 0)
  await new Promise((r) => setTimeout(r, 250))
}
const t0 = Date.now()
const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 2; echo hello'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
const again = process.argv.includes('retry') ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 2; echo hello'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }) : null
console.log(JSON.stringify({ retry: again ? { status: again.status, error: again.error ? String((again.error as any).code) : null, out: String(again.stdout).trim() } : undefined, runtime: rt, first, waitS, how, ms: Date.now() - t0, status: ran.status, signal: ran.signal, error: ran.error ? String((ran.error as any).code) : null, out: String(ran.stdout).trim() }))
process.exit(0)
