// Ends the agent app running in the rehearsal's own terminal (the processes under its pty.py
// that are not the shell), by their ids. Prints only their ids and names.
//   node e2e/rehearsal/end-app.mjs
import { spawnSync } from 'node:child_process'
import { killTree } from './lib.mjs'

const out = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
).stdout
const all = [JSON.parse(out)].flat()
const roots = all.filter((p) => /pty\.py/.test(p.CommandLine ?? '') && /it-rehearsal/i.test(p.CommandLine ?? '')).map((p) => p.ProcessId)
const kids = (pid) => all.filter((p) => p.ParentProcessId === pid)
const ended = []
for (const root of roots)
  for (const shell of kids(root))
    for (const p of all.filter((x) => x.ParentProcessId === shell.ProcessId || kids(shell.ProcessId).some((k) => k.ProcessId === x.ParentProcessId)))
      if (/^(node|codex|claude)/i.test(p.Name) && p.ParentProcessId === shell.ProcessId) {
        killTree(p.ProcessId)
        ended.push(`${p.Name} ${p.ProcessId}`)
      }
console.log(`ended: ${ended.join(', ') || 'nothing'}`)
