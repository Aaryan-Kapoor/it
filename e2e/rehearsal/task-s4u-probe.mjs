// Whether `itrehearsal`, a standard account never signed in at the screen, can register for
// itself, without an administrator, a task that Windows runs while it is not signed in (logon
// type S4U, no password kept), and whether Windows runs it: a harmless action that writes the
// time, its token's logon type and session, and the names (never values) of its variables,
// then the task is removed.
//   node e2e/rehearsal/task-s4u-probe.mjs
import { psAs, userEnv } from './asuser.mjs'

const script = [
  "$ErrorActionPreference = 'Continue'",
  '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "$name = 'it-rehearsal-probe-' + $sid",
  '$out = Join-Path $env:LOCALAPPDATA "it-probe.txt"; Remove-Item $out -ErrorAction SilentlyContinue',
  "$cmd = '[Environment]::UserName + \" session \" + (Get-Process -Id $PID).SessionId + \" elevated \" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + \" vars \" + ((Get-ChildItem env: | ForEach-Object Name | Sort-Object) -join \",\") | Out-File -Encoding utf8 ' + $out",
  '$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -NonInteractive -Command " + $cmd)',
  '$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Limited',
  '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
  'try { Register-ScheduledTask -TaskPath "\\" -TaskName $name -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null; "registered S4U: yes" } catch { "registered S4U: NO: " + $_.Exception.Message }',
  'if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {',
  '  Start-ScheduledTask -TaskName $name; Start-Sleep 12',
  '  "last result: " + (Get-ScheduledTaskInfo -TaskName $name).LastTaskResult',
  '  if (Test-Path $out) { "ran: " + (Get-Content $out -Raw) } else { "ran: no output" }',
  '  Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed: " + (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue))',
  '}',
].join('\n')
const r = await psAs('itrehearsal', script, userEnv('itrehearsal'))
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
