// The listing alone (repro-list-bun), started as `it setup` was started when it failed: with
// Start-Process, a hidden window and standard output and error sent to files; and, to compare,
// started straight from the console. Bun-compiled and under Node, as `itrehearsal` and as the
// account running this (`aarya`, in a throwaway folder only).
//   node e2e/rehearsal/repro-list-started.mjs
import { spawnSync } from 'node:child_process'
import { psAs, userEnv } from './asuser.mjs'

const exe = 'D:\\it-rehearsal\\work\\repro\\repro-list-bun.exe'
const node = 'C:\\Program Files\\nodejs\\node.exe'
const src = 'D:\\it-rehearsal\\work\\repro\\repro-list-bun.ts'
const script = (tmp) =>
  [
    "$ErrorActionPreference = 'Continue'",
    `$tmp = '${tmp}'; New-Item -ItemType Directory -Force $tmp | Out-Null`,
    'function Started($file, $argv, $how) {',
    '  $o = Join-Path $tmp "o.txt"; $e = Join-Path $tmp "e.txt"; Remove-Item $o, $e -ErrorAction SilentlyContinue',
    '  $t0 = Get-Date',
    '  if ($how -eq "hidden+redirected") { $p = Start-Process -FilePath $file -ArgumentList $argv -WindowStyle Hidden -RedirectStandardOutput $o -RedirectStandardError $e -PassThru; $p.WaitForExit(70000) | Out-Null; if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; "  (still running after 70 s; ended)" } }',
    '  elseif ($how -eq "redirected") { $p = Start-Process -FilePath $file -ArgumentList $argv -NoNewWindow -RedirectStandardOutput $o -RedirectStandardError $e -PassThru; $p.WaitForExit(70000) | Out-Null; if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; "  (still running after 70 s; ended)" } }',
    '  elseif ($how -eq "hidden") { $p = Start-Process -FilePath $file -ArgumentList $argv -WindowStyle Hidden -PassThru; $p.WaitForExit(70000) | Out-Null; "  (hidden, no output kept) exit $($p.ExitCode)" }',
    '  else { & $file @argv 2>$null | Set-Content $o }',
    '  $line = if (Test-Path $o) { (Get-Content $o | Select-Object -Last 1) } else { "" }',
    '  "{0,-5} {1,-18} {2}" -f $(if ($file -like "*node*") { "node" } else { "bun" }), $how, ($line -replace \'"err":".*\', \'...\')',
    '}',
    ...['console', 'redirected', 'hidden+redirected'].flatMap((how) => [
      `Started '${exe}' @('plain') '${how}'`,
      `Started '${node}' @('--experimental-strip-types','--no-warnings','${src}') '${how}'`,
    ]),
  ].join('\n')

console.log('=== as itrehearsal')
const r = await psAs('itrehearsal', script('C:\\Users\\itrehearsal\\AppData\\Local\\Temp\\it-repro-started'), userEnv('itrehearsal', { extra: { REPRO_TIMEOUT_MS: '45000' } }))
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, '').trim())
console.log('=== as this account')
const me = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script('D:\\r\\repro-started')], { encoding: 'utf8', env: { ...process.env, REPRO_TIMEOUT_MS: '45000' } })
console.log(me.stdout.trim(), me.stderr.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, '').trim().slice(0, 500))
