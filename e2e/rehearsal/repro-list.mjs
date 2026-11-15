// Runs, as `itrehearsal`, the script It runs to list processes before it starts its backend
// (packages/cli/src/serve/backend.ts), the way It runs it, and prints how it ends.
//   node e2e/rehearsal/repro-list.mjs
import { psAs, userEnv } from './asuser.mjs'

const script = [
  "$ErrorActionPreference = 'Stop'",
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$session = (Get-Process -Id $PID).SessionId',
  "$names = @('convex-local-backend.exe', 'it.exe')",
  'Get-CimInstance Win32_Process -Property Handle, ProcessId, SessionId, Name, CommandLine | ForEach-Object {',
  '  $line = [string]$_.CommandLine',
  "  if ($_.ProcessId -eq 1) { 'self' } elseif ($line) {",
  "    if ($line.Contains('--instance-name')) { 'seen' }",
  '  } elseif ($names -contains $_.Name) {',
  "    $owner = 'unknown'",
  "    try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($o.ReturnValue -eq 0 -and $o.Sid) { $owner = if ($o.Sid -eq $me) { 'mine' } else { 'other' } } } catch { }",
  "    'unseen {0} {1} {2}' -f $_.ProcessId, $owner, [int]($_.SessionId -eq $session)",
  '  }',
  '}',
  "'end'",
].join('\n')
const encoded = Buffer.from(script, 'utf16le').toString('base64')
const r = await psAs(
  'itrehearsal',
  [
    `$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\\list-out.txt" -RedirectStandardError "$env:TEMP\\list-err.txt"`,
    '"exit: " + $p.ExitCode',
    '"--- out (last lines)"; Get-Content "$env:TEMP\\list-out.txt" -Tail 3',
    '"--- err"; Get-Content "$env:TEMP\\list-err.txt" | Select-Object -First 12',
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(r.output)
