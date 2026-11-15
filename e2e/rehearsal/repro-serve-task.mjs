// As `itrehearsal`: installs It from the stand-in with its background task registered, runs `it serve` for half a
// minute, and prints what it said; then It's own uninstall. Says whether It can start its backend there.
//   node e2e/rehearsal/repro-serve.mjs
import { psAs, userEnv } from './asuser.mjs'

const env = userEnv('itrehearsal', { extra: { IT_INSTALL_BASE: 'http://127.0.0.1:5690', IT_INSTALL_PLAIN: '1', IT_PORT: '5620' } })
const it = 'C:\\Users\\itrehearsal\\.it\\bin\\it.exe'
const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    'Invoke-RestMethod http://127.0.0.1:5690/latest/download/install.ps1 -OutFile "$env:TEMP\\it-install.ps1"',
    '$null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\it-install.ps1" 2>&1',
    `"--- setup --no-service"; (& '${it}' setup --none 2>&1 | Out-String).Trim().Split("\`n") | Select-Object -Last 4`,
    `$p = Start-Process -FilePath '${it}' -ArgumentList 'serve' -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\\serve-out.txt" -RedirectStandardError "$env:TEMP\\serve-err.txt"`,
    'Start-Sleep 40',
    `"--- status"; (& '${it}' status --json 2>&1 | Out-String).Trim().Split("\`n") | Select-Object -First 4`,
    'Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Start-Sleep 3',
    '"--- serve said"; Get-Content "$env:TEMP\\serve-out.txt" -Tail 15; Get-Content "$env:TEMP\\serve-err.txt" -Tail 10',
    `"--- uninstall"; (& '${it}' uninstall --yes 2>&1 | Out-String).Trim().Split("\`n") | Select-Object -Last 2`,
  ].join('\n'),
  env,
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
