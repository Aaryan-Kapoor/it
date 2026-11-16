// The owner's own It, read only, for the one test the owner allowed (Auto-wake under the real
// scheduled task): what its version and status say, as codes and versions only, and whether the
// `set PATH=` line of its service launcher holds .it\bin, as yes or no. Nothing else of what
// these print or hold is shown or kept. Run by the program's full path, never a bare `it`.
//   node e2e/rehearsal/owner-it-read.mjs [--pages]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.userInfo().homedir
const exe = path.join(home, '.it', 'bin', 'it.exe')
const run = (args) => {
  try {
    return JSON.parse(execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch (e) {
    try {
      return JSON.parse(String(e.stdout ?? ''))
    } catch {
      return { error: { code: 'unreadable' } }
    }
  }
}
const v = run(['version'])
const st = run(['status', '--json'])
let launcherHasBin = 'no launcher'
try {
  const line = readFileSync(path.join(home, '.it', 'bin', 'it-service.cmd'), 'utf8').split(/\r?\n/).find((l) => /^set PATH=/i.test(l)) ?? ''
  launcherHasBin = line ? (/\\\.it\\bin(;|$)/i.test(line) ? 'yes' : 'no') : 'no set PATH line'
} catch {}
const out = {
  version: v.version ?? v.error?.code,
  running: st.running ?? null,
  enrolled: st.enrolled ?? null,
  connectorVersion: st.machine?.connectorVersion ?? null,
  latest: st.machine?.latest ?? null,
  service: st.service ? { registered: st.service.registered ?? null, state: st.service.state ?? null } : null,
  harnesses: Array.isArray(st.machine?.harnesses) ? st.machine.harnesses.map((h) => (typeof h === 'string' ? h : (h?.id ?? h?.harness ?? '?'))) : null,
  launcherSetPathHoldsItBin: launcherHasBin,
  statusError: st.error?.code ?? null,
}
if (process.argv.includes('--pages')) {
  const l = run(['list', '--json'])
  out.pageCount = Array.isArray(l) ? l.length : Array.isArray(l?.pages) ? l.pages.length : l?.error?.code ?? 'unknown'
}
console.log(JSON.stringify(out))
