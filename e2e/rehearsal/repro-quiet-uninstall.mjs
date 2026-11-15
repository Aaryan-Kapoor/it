// As `itrehearsal`: the build under test installed from the stand-in, set up with no service,
// `it serve` left quiet for a while, then `it uninstall --yes`, which stops that It and lists
// processes after the quiet stretch; then whether anything of it is left.
//   node e2e/rehearsal/repro-quiet-uninstall.mjs [--quiet <seconds>]
import { psAs, userEnv } from './asuser.mjs'

const i = process.argv.indexOf('--quiet')
const quiet = i === -1 ? 600 : Number(process.argv[i + 1])
const home = 'C:\\Users\\itrehearsal\\.itquiet'
const env = userEnv('itrehearsal', { extra: { IT_HOME: home, IT_PORT: '5632', IT_INSTALL_BASE: 'http://127.0.0.1:5690', IT_INSTALL_PLAIN: '1', IT_INSTALL_NO_PATH: '1', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' } })
const it = `${home}\\bin\\it.exe`
const script = [
  "$ErrorActionPreference = 'Continue'",
  `if (Test-Path '${it}') { & '${it}' uninstall --yes 2>&1 | Out-Null }`,
  'Invoke-RestMethod http://127.0.0.1:5690/latest/download/install.ps1 -OutFile $env:TEMP\\it-quiet-install.ps1',
  'powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\\it-quiet-install.ps1 *>&1 | Select-Object -Last 1',
  `"version: " + ((& '${it}' version) -join ' ')`,
  `$t = Get-Date; & '${it}' setup --none --no-service 2>&1 | Select-Object -Last 2; "setup took " + [int]((Get-Date) - $t).TotalSeconds + " s"`,
  `$serve = Start-Process -FilePath '${it}' -ArgumentList 'serve' -RedirectStandardOutput $env:TEMP\\it-quiet-serve.out -RedirectStandardError $env:TEMP\\it-quiet-serve.err -WindowStyle Hidden -PassThru`,
  'Start-Sleep 30',
  `"status before: " + ((& '${it}' status --json) -join ' ')`,
  `"quiet for ${quiet} s from " + (Get-Date).ToUniversalTime().ToString('HH:mm:ss')`,
  `Start-Sleep ${quiet}`,
  `"status after quiet: " + ((& '${it}' status --json) -join ' ')`,
  `$t = Get-Date; "--- uninstall at " + (Get-Date).ToUniversalTime().ToString('HH:mm:ss'); & '${it}' uninstall --yes 2>&1 | Select-Object -Last 4; "uninstall took " + [int]((Get-Date) - $t).TotalSeconds + " s"`,
  'Start-Sleep 5',
  '"serve process ended: " + $serve.HasExited',
  `"folder left: " + (Test-Path '${home}')`,
  '"tasks: " + ((Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }) -join ", ")',
  'if (-not $serve.HasExited) { Stop-Process -Id $serve.Id -Force; "serve ended by its id" }',
].join('\n')
const r = await psAs('itrehearsal', script, env)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
