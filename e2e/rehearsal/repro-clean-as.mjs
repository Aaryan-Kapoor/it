// Takes away what the repro runs as `itrehearsal` left: its It in C:\Users\itrehearsal\.itrepro,
// with the background task that setup registered for that account (`it uninstall --yes`).
// Run when no backend program of another account runs in the session, since It then cannot tell
// such a program from one of its own.
//   node e2e/rehearsal/repro-clean-as.mjs
import { psAs, userEnv } from './asuser.mjs'

const home = 'C:\\Users\\itrehearsal\\.itrepro'
const r = await psAs(
  'itrehearsal',
  [
    `if (Test-Path '${home}\\bin\\it.exe') { & '${home}\\bin\\it.exe' uninstall --yes 2>&1 | Select-Object -Last 3 }`,
    '"--- tasks after"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }',
    `"folder left: " + (Test-Path '${home}')`,
  ].join('\n'),
  userEnv('itrehearsal', { extra: { IT_HOME: home, IT_PORT: '5622' } }),
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
