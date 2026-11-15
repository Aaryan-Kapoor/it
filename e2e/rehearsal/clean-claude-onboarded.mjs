// For `itrehearsal`: ends its own Claude Code processes by their ids (one left at a first-run
// screen), then sets in its `.claude.json` what a finished first run leaves there
// (hasCompletedOnboarding, a theme), as a participant's laptop has it, so that a run's person does
// not meet Claude Code's first-run sign-in screens. Prints only what it did.
//   node e2e/rehearsal/clean-claude-onboarded.mjs
import { psAs, userEnv } from './asuser.mjs'

const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    "$mine = Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } }",
    'foreach ($p in $mine) { Stop-Process -Id $p.ProcessId -Force; "ended claude " + $p.ProcessId }',
    '$f = Join-Path $env:USERPROFILE ".claude.json"',
    '$j = if (Test-Path $f) { Get-Content -Raw $f | ConvertFrom-Json } else { [pscustomobject]@{} }',
    '$j | Add-Member -Force -NotePropertyName hasCompletedOnboarding -NotePropertyValue $true',
    "$j | Add-Member -Force -NotePropertyName theme -NotePropertyValue 'dark'",
    '[IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 30))',
    '"onboarding marked done: " + ((Get-Content -Raw $f | ConvertFrom-Json).hasCompletedOnboarding)',
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, ''))
