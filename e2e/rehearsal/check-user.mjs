// Checks, before any run as another account, that what is started as it runs as it, with its own
// profile, and cannot write into the owner's folders; and says whether the machine refuses a
// process that pipes `irm` into `iex` there too.
//
//   node e2e/rehearsal/check-user.mjs itrehearsal
import os from 'node:os'
import { psAs, userEnv } from './asuser.mjs'

const owner = os.userInfo().homedir
const user = process.argv[2] || 'itrehearsal'
const tries = [`${owner}\\Documents`, owner, `${owner}\\AppData\\Local\\Temp`].map((d) => `'${d}\\itrehearsal-write-test.txt'`).join(', ')
const r = await psAs(
  user,
  [
    '$ErrorActionPreference = "Continue"',
    '"whoami: " + (whoami)',
    '"sid: " + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '"profile: " + $env:USERPROFILE + " exists " + (Test-Path $env:USERPROFILE)',
    '"admin: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    `foreach ($t in @(${tries})) { try { Set-Content -LiteralPath $t -Value x -ErrorAction Stop; "WROTE " + $t; Remove-Item -LiteralPath $t } catch { "denied " + $t } }`,
    `try { Get-ChildItem '${owner}' -ErrorAction Stop | Out-Null; "CAN LIST the owner's folder" } catch { "cannot list the owner's folder" }`,
    '"tasks: " + ((Get-ScheduledTask -TaskPath "\\" -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }) -join ",")',
    '$p = Start-Process powershell.exe -ArgumentList "-NoProfile","-Command","`"irm http://127.0.0.1:5690/latest/download/latest.json | iex`"" -PassThru -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue; if ($p) { "irm|iex: started, exit " + $p.ExitCode } else { "irm|iex: refused: " + $Error[0].Exception.Message }',
  ].join('\n'),
  userEnv(user),
)
console.log(r.output)
console.log(`exit ${r.exit}`)
