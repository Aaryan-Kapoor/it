// As `itrehearsal`: runs a diagnostic copy of It's Node bundle (which says how its process
// listing ended) through `setup --none`, with its background task registered, and prints what
// the listing said; then that copy's own uninstall.
//   node e2e/rehearsal/repro-diag.mjs [--no-service]
import { psAs, userEnv } from './asuser.mjs'

const noService = process.argv.includes('--no-service')
const home = 'C:\\Users\\itrehearsal\\.itdiag'
const env = userEnv('itrehearsal', { extra: { IT_HOME: home, IT_PORT: '5622' } })
const it = `& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\it-rehearsal\\work\\diag\\it.mjs'`
const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    `$t0 = Get-Date; "--- setup"; (${it} setup --none${noService ? ' --no-service' : ''} 2>&1 | Out-String).Trim().Split("\`n") | Where-Object { $_ -match 'diag|error|registered' } | Select-Object -First 12; "took " + [int]((Get-Date) - $t0).TotalSeconds + " s"`,
    '"--- task"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName + " " + $_.State + " last result " + (Get-ScheduledTaskInfo -InputObject $_).LastTaskResult }',
    `"--- uninstall"; (${it} uninstall --yes 2>&1 | Out-String).Trim().Split("\`n") | Select-Object -Last 2`,
    `"--- task after"; Get-ScheduledTask -TaskPath "\\" | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }`,
  ].join('\n'),
  env,
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
