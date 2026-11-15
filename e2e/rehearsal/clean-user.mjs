// Takes It out of the account `itrehearsal` with It's own uninstall, ends what is left of It
// and the agent apps there by their ids, and says what is left.
//   node e2e/rehearsal/clean-user.mjs
import { psAs, userEnv } from './asuser.mjs'

const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    "if (Test-Path \"$env:USERPROFILE\\.it\\bin\\it.exe\") { (& \"$env:USERPROFILE\\.it\\bin\\it.exe\" uninstall --yes 2>&1 | Out-String).Trim().Split(\"`n\") | Select-Object -Last 2 }",
    '$me = $PID',
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and ([string]$_.ExecutablePath) -like ($env:USERPROFILE + '\\*') } | ForEach-Object { 'ending ' + $_.Name + ' ' + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -match '^(codex|codex-.*|claude|node)\\.exe$' } | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } } | ForEach-Object { 'ending ' + $_.Name + ' ' + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "foreach ($d in @(\"$env:USERPROFILE\\.it\", \"$env:USERPROFILE\\.itdiag\", \"$env:USERPROFILE\\hackathon\")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }",
    '"tasks: " + ((Get-ScheduledTask -TaskPath "\\" -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }) -join ",")',
    '"it folder: " + (Test-Path "$env:USERPROFILE\\.it")',
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, '').trim())
