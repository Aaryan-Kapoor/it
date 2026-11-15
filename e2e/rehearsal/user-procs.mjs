// Lists, and with --end ends by their own ids, the processes of the account `itrehearsal` that
// belong to an agent app or It, as that account.
//   node e2e/rehearsal/user-procs.mjs [--end]
import { psAs, userEnv } from './asuser.mjs'

const end = process.argv.includes('--end')
const r = await psAs(
  'itrehearsal',
  [
    '$me = $PID',
    "$mine = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -match '^(codex|codex-.*|claude|node|it|rg|python|conhost|cmd|powershell)\\.exe$' } | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } }",
    `foreach ($p in $mine) { if ($p.ProcessId -eq $me -or $p.ParentProcessId -eq $me) { continue }; $p.Name + " " + $p.ProcessId${end ? '; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue' : ''} }`,
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(r.output.trim() || '(none)')
