// Whether Bun's asynchronous `spawn` with `timeout` shows the fault that `spawnSync` shows
// (repro-bun-spawnsync-timeout.ts): one child first, then a wait longer than the next child's
// timeout, then a child of about two seconds with `timeout: 60_000`, asynchronously.
//   repro-bun-spawn-timeout <wait seconds> [first: sync|async|none]
import { spawn, spawnSync } from 'node:child_process'

const waitS = Number(process.argv[2] ?? 90)
const first = process.argv[3] ?? 'sync'
const rt = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? `node ${process.version}` : `bun ${(globalThis as { Bun: { version: string } }).Bun.version}`
const quick = ['-NoProfile', '-NonInteractive', '-Command', 'echo first']
if (first === 'sync') spawnSync('powershell.exe', quick, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
if (first === 'async')
  await new Promise((r) => {
    const c = spawn('powershell.exe', quick, { windowsHide: true, timeout: 30_000 })
    c.on('close', r)
  })
await new Promise((r) => setTimeout(r, waitS * 1000))
const t0 = Date.now()
const result = await new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => {
  let out = ''
  const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 2; echo hello'], { windowsHide: true, timeout: 60_000 })
  c.stdout.on('data', (d) => (out += d))
  c.on('close', (code, signal) => resolve({ code, signal, out: out.trim() }))
})
console.log(JSON.stringify({ runtime: rt, first, waitS, ms: Date.now() - t0, ...result }))
process.exit(0)
