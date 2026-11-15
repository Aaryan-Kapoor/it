// Prints what the session's task watcher sees, as `itrehearsal`.
import { psAs, userEnv } from './asuser.mjs'

const t0 = Date.now()
const r = await psAs(
  'itrehearsal',
  [
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$t = Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq ('it-' + $sid) }",
    "$serve = @(Get-CimInstance Win32_Process -Filter \"Name='it.exe'\" | Where-Object { ([string]$_.CommandLine) -match '\\sserve(\\s|$)' }).Count",
    'if ($t) { "task|" + $t.State + "|" + $t.Actions[0].Execute + "|" + $t.Actions[0].Arguments + "|" + $t.Actions[0].WorkingDirectory + "|" + $serve } else { "none|" + $serve }',
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(`${Date.now() - t0} ms`, JSON.stringify(r.output))
