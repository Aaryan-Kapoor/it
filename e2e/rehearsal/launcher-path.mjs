// As `itrehearsal`: It installed from the real site with IT_INSTALL_PLAIN (which puts .it\bin on
// the account's PATH in its registry, as for a participant), then `it setup --only <app>` run by
// the program's whole path from a process whose PATH was made before the install (as an agent's
// shell opened before it is), and the service launcher it wrote (`.it\bin\it-service.cmd`) read:
// whether its `set PATH=` holds .it\bin, and the NAMES of the variables it sets (never a value).
// With --vars, two user variables are set for the account first (CLAUDE_CODE_IT_TEST=1 and
// CLAUDE_CODE_GIT_BASH_PATH), as a person who set them would have them.
//   node e2e/rehearsal/launcher-path.mjs [--app claude-code|codex] [--vars] [--keep]
import { psAs, userEnv } from './asuser.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const app = arg('app', 'claude-code')
const env = userEnv('itrehearsal', { path: ['C:\\Users\\itrehearsal\\AppData\\Roaming\\npm'] })
const it = 'C:\\Users\\itrehearsal\\.it\\bin\\it.exe'
const before = [
  "$ErrorActionPreference = 'Continue'",
  ...(process.argv.includes('--vars')
    ? [
        "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_IT_TEST', '1', 'User')",
        "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', 'C:\\Program Files\\Git\\bin\\bash.exe', 'User')",
        '"user variables set: CLAUDE_CODE_IT_TEST, CLAUDE_CODE_GIT_BASH_PATH"',
      ]
    : []),
  `"PATH of this shell holds .it\\bin before the install: " + ($env:Path -like '*\\.it\\bin*')`,
  `if (-not (Test-Path '${it}')) { $env:IT_INSTALL_PLAIN = '1'; Invoke-RestMethod https://itcan.do/install.ps1 -OutFile $env:TEMP\\it-install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\\it-install.ps1 *>&1 | Select-Object -Last 1; Remove-Item Env:IT_INSTALL_PLAIN }`,
  `"version: " + ((& '${it}' version) -join ' ')`,
  `"account PATH (registry) holds .it\\bin after the install: " + ([Environment]::GetEnvironmentVariable('Path','User') -like '*\\.it\\bin*')`,
  `"PATH of this shell (opened before) holds .it\\bin: " + ($env:Path -like '*\\.it\\bin*')`,
  `$t = Get-Date; & '${it}' setup --only ${app} 2>&1 | Select-Object -Last 3; "setup took " + [int]((Get-Date) - $t).TotalSeconds + " s"`,
  "$cmd = 'C:\\Users\\itrehearsal\\.it\\bin\\it-service.cmd'",
  '"launcher exists: " + (Test-Path $cmd)',
  'if (Test-Path $cmd) {',
  '  $lines = Get-Content $cmd',
  '  $p = $lines | Where-Object { $_ -match "^set PATH=" } | Select-Object -First 1',
  '  "launcher set PATH holds .it\\bin: " + ($p -like "*\\.it\\bin*")',
  '  "launcher set PATH holds the npm folder: " + ($p -like "*\\AppData\\Roaming\\npm*")',
  "  'launcher sets (names only): ' + ((($lines | Where-Object { $_ -match '^set [^=]+=' }) | ForEach-Object { ($_ -split '=')[0].Substring(4) }) -join ', ')",
  "  'launcher runs: ' + ((($lines | Where-Object { $_ -notmatch '^(set |@|rem |::)' -and $_.Trim() }) | ForEach-Object { (($_.Trim() -split ' ')[0]) -replace '^.*\\\\', '' }) -join ', ')",
  '}',
  '"task: " + ((Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName + " " + $_.State + " " + $_.Principal.LogonType }) -join ", ")',
]
const r = await psAs('itrehearsal', before.join('\n'), env)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
