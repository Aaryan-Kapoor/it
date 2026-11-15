// As `itrehearsal`: the build under test installed into a folder of its own from the stand-in,
// then `it setup --none` (which registers that account's background task, which Windows does not
// start for an account never signed in at the screen, so setup falls back to its own backend and
// lists processes), with setup's child processes and their CPU time written down every ten
// seconds; then `it uninstall --yes`, which takes the task and the folder away again.
//   node e2e/rehearsal/repro-setup-watch.mjs
import { psAs, userEnv } from './asuser.mjs'

const home = 'C:\\Users\\itrehearsal\\.itrepro'
const env = userEnv('itrehearsal', { extra: { IT_HOME: home, IT_PORT: '5622', IT_INSTALL_BASE: 'http://127.0.0.1:5690', IT_INSTALL_PLAIN: '1', IT_INSTALL_NO_PATH: '1', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' } })
const it = `${home}\\bin\\it.exe`
const script = [
  "$ErrorActionPreference = 'Continue'",
  `if (Test-Path '${home}') { & '${it}' uninstall --yes 2>&1 | Out-Null }`,
  "Invoke-RestMethod http://127.0.0.1:5690/latest/download/install.ps1 -OutFile $env:TEMP\\it-repro-install.ps1",
  "powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\\it-repro-install.ps1 *>&1 | Select-Object -Last 2",
  // --diag: the copy of the program that reports how its listing ended, in place of the one installed
  ...(process.argv.includes('--diag') ? [`for ($i = 0; $i -lt 20; $i++) { try { Copy-Item -Force 'D:\\it-rehearsal\\work\\diag-bba\\it-windows-x64.exe' '${it}' -ErrorAction Stop; "diagnostic copy in place after $i retries"; break } catch { Start-Sleep 3 } }`] : []),
  `$out = "$env:TEMP\\it-repro-setup.out"; $err = "$env:TEMP\\it-repro-setup.err"`,
  `$p = Start-Process -FilePath '${it}' -ArgumentList 'setup','--none' -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru`,
  '$t0 = Get-Date; "setup pid $($p.Id)"',
  'function Kids($id) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { $_; Kids $_.ProcessId } }',
  'while (-not $p.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 260) {',
  '  Start-Sleep 3',
  '  $s = [int]((Get-Date) - $t0).TotalSeconds',
  '  $k = @(Kids $p.Id) | ForEach-Object { "{0}#{1} cpu {2:N1}s age {3}s" -f $_.Name, $_.ProcessId, (($_.KernelModeTime + $_.UserModeTime) / 1e7), [int]((Get-Date) - $_.CreationDate).TotalSeconds }',
  '  "t+$s s: " + ($(if ($k) { $k -join "; " } else { "(no children)" }))',
  '}',
  '"setup ended: " + $p.HasExited + " after " + [int]((Get-Date) - $t0).TotalSeconds + " s"',
  'if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }',
  '"--- setup said (last lines)"; Get-Content $err | Select-String -Pattern "diag" | ForEach-Object { $_.Line }; Get-Content $err -Tail 2; Get-Content $out -Tail 4',
  '"--- task"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName + " " + $_.State }',
  `"--- uninstall"; & '${it}' uninstall --yes 2>&1 | Select-Object -Last 2`,
  '"--- task after"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }',
].join('\n')
const r = await psAs('itrehearsal', script, env)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
