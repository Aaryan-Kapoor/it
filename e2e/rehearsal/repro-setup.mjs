// Installs It as `itrehearsal` from the stand-in, runs `it setup --none` as a script would, and
// prints what it said, the service's state and the end of its log; then It's own uninstall.
//   node e2e/rehearsal/repro-setup.mjs [--keep]
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { psAs, userEnv } from './asuser.mjs'
import { WORK } from './lib.mjs'

const keep = process.argv.includes('--keep')
const env = userEnv('itrehearsal', { extra: { IT_INSTALL_BASE: 'http://127.0.0.1:5690', IT_INSTALL_PLAIN: '1' } })
const it = 'C:\\Users\\itrehearsal\\.it\\bin\\it.exe'
const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    'Invoke-RestMethod http://127.0.0.1:5690/latest/download/install.ps1 -OutFile "$env:TEMP\\it-install.ps1"',
    '"--- install"; (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\it-install.ps1" 2>&1 | Out-String).Trim().Split("`n") | Select-Object -Last 3',
    `"--- setup"; (& '${it}' setup --none 2>&1 | Out-String).Trim()`,
    `"--- status"; (& '${it}' service status 2>&1 | Out-String).Trim()`,
    '"--- task"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName + " " + $_.State + " last result " + (Get-ScheduledTaskInfo -InputObject $_).LastTaskResult }',
    `"--- log"; if (Test-Path 'C:\\Users\\itrehearsal\\.it\\logs\\it.log') { Get-Content 'C:\\Users\\itrehearsal\\.it\\logs\\it.log' -Tail 25 } else { 'no log' }`,
    `"--- startup"; if (Test-Path 'C:\\Users\\itrehearsal\\.it\\startup.json') { Get-Content 'C:\\Users\\itrehearsal\\.it\\startup.json' -Raw }`,
    '"--- sessions"; query user 2>&1 | Out-String',
    ...(keep ? [] : [`"--- uninstall"; (& '${it}' uninstall --yes 2>&1 | Out-String).Trim().Split("\`n") | Select-Object -Last 3`]),
  ].join('\n'),
  env,
)
writeFileSync(path.join(WORK, 'repro-setup.txt'), r.output)
console.log(r.output)
