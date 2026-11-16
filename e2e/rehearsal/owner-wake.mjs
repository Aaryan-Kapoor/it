// Auto-wake on the owner's OWN It, under its real scheduled task, with the owner's own agent app
// and sign-in: the one test the owner allowed ("Feel free to run any tests on Zephyrus as well").
// A terminal with the environment a new terminal of this account gets (from the registry, none of
// this session's own variables), in a new folder under D:\it-rehearsal\owner-wake, and a browser
// with a profile of its own, paired with the owner's It off the screen (so that the owner's list
// of pages is never shown) and sent straight to the test page. The tester drives over the
// control port (127.0.0.1:5797): {cmd:"type",text} {cmd:"key",name} {cmd:"screen"} {cmd:"goto",page}
// {cmd:"click",selector} {cmd:"record"} {cmd:"stop"}. Only the browser's half of the screen is
// recorded; the terminal is kept as text with anything shaped like an email or the owner's name
// taken out. Every new agent app process that the owner's It service starts is written down with
// the NAMES of its variables (env-names.ps1) and whether its PATH holds .it\bin.
//   node e2e/rehearsal/owner-wake.mjs --app claude|codex
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { recorder, sleep, stamp } from './lib.mjs'
import { SCREEN, terminalView, terminalWindow } from './stage.mjs'

const app = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : 'claude'
const id = `${stamp().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-owner-wake-${app}`
const OUT = path.join('D:\\it-rehearsal\\2026-11-15', id)
const WORKDIR = path.join('D:\\it-rehearsal\\owner-wake', `${app}-${id.slice(9, 13)}`)
const PROF = path.join('D:\\it-rehearsal\\owner-wake', `.profiles-${id.slice(9, 13)}-${app}`)
mkdirSync(OUT, { recursive: true })
mkdirSync(WORKDIR, { recursive: true })
const ownerIt = path.join(os.userInfo().homedir, '.it', 'bin', 'it.exe')
const ME = os.userInfo().username
const redact = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(new RegExp(ME, 'gi'), '[owner]').replace(/Aaryan|Kapoor/gi, '[owner]')
const logFile = path.join(OUT, 'steps.log')
let rec = null
const log = (what) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${rec ? `${rec.at().toFixed(1)}s` : '--'} ${redact(what)}`
  console.log(line)
  writeFileSync(logFile, `${line}\n`, { flag: 'a' })
}

// What a new terminal of this account gets: the machine's and the account's own variables, from the registry
const reg = JSON.parse(
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$m=[Environment]::GetEnvironmentVariables('Machine');$u=[Environment]::GetEnvironmentVariables('User');$o=@{};foreach($k in $m.Keys){$o[$k]=$m[$k]};foreach($k in $u.Keys){if($k -ieq 'Path'){$o['Path']=$m['Path']+';'+$u[$k]}else{$o[$k]=$u[$k]}};$o|ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true }),
)
const keep = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'SystemRoot', 'SystemDrive', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'ComSpec', 'PSModulePath']
const termEnv = {}
for (const k of keep) if (process.env[k]) termEnv[k] = process.env[k]
for (const [k, v] of Object.entries(reg)) termEnv[k] = String(v).replace(/%([^%]+)%/g, (m, n) => termEnv[n] ?? process.env[n] ?? m)
termEnv.TEMP = path.join(termEnv.LOCALAPPDATA, 'Temp')
termEnv.TMP = termEnv.TEMP
const termNames = Object.keys(termEnv).map((k) => k.toUpperCase())

// The owner's It: its site, and a link that pairs one browser (never written down)
const site = JSON.parse(execFileSync(ownerIt, ['site', '--no-open'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }))
const base = new URL(site.url).origin
log("owner's It site found (its address is not written down)")
// Paired off the screen, so that whatever the site shows after pairing (the owner's own pages) is never on the screen
{
  const ctx = await chromium.launchPersistentContext(path.join(PROF, 'browser'), { channel: 'chrome', headless: false, args: ['--window-position=-4000,-4000', '--window-size=800,600', '--no-first-run', '--no-default-browser-check'], ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'] })
  const p = ctx.pages()[0] ?? (await ctx.newPage())
  await p.goto(site.url).catch(() => {})
  await sleep(6000)
  await ctx.close()
  log('the browser was paired with the owner\'s It, off the screen')
}
const term = await terminalView({ port: 5798, title: 'tester@laptop — Windows PowerShell', cols: 104, rows: 50, fontSize: 20 })
const tw = await terminalWindow({ term, profile: path.join(PROF, 'terminal-view') })
const HALF = SCREEN.width / 2
const browser = await chromium.launchPersistentContext(path.join(PROF, 'browser'), { channel: 'chrome', headless: false, viewport: null, args: [`--window-position=${HALF - 8},0`, `--window-size=${HALF + 16},${SCREEN.height + 24}`, '--no-first-run', '--no-default-browser-check', `--app=${term.url}blank`], ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'] })
const page = browser.pages()[0] ?? (await browser.newPage())
browser.on('page', (p) => p.on('filechooser', (fc) => fc.setFiles([]).catch(() => {})))
const pty = term.open(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoLogo'], { env: termEnv, cwd: WORKDIR, python: 'D:\\it-rehearsal\\work\\pyembed\\python.exe' })
await sleep(2500)
await tw.page.click('#t').catch(() => {})
log(`terminal open in the test folder; ${termNames.length} variables, PATH holds .it\\bin: ${/\\\.it\\bin(;|$)/i.test(termEnv.Path ?? termEnv.PATH ?? '')}`)

// The two windows kept on top of everything else, as the harness keeps them (hands.exe raise)
const HANDS = 'D:\\it-rehearsal\\work\\hands\\hands.exe'
const raising = setInterval(() => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { ([string]$_.CommandLine).ToLower().Contains('${PROF.toLowerCase().replace(/\\/g, '\\\\').replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true })
    writeFileSync('D:\\it-rehearsal\\work\\hands\\allowed.txt', out)
    execFileSync(HANDS, ['raise'], { windowsHide: true, stdio: 'ignore' })
  } catch {}
}, 4000)
// The bar's words and the page's answer, every two seconds, written when they change
let barWas = ''
let answerWas = ''
const watch = setInterval(async () => {
  try {
    const bar = await page.evaluate(() => (document.body?.innerText ?? '').split('\n').filter((l) => /work|wake|reopen|hear|answer|could|asleep|wait|closed|codex|claude|sent|done|fail|no answer|can.t/i.test(l)).slice(0, 6).join(' | '))
    if (bar !== barWas) {
      barWas = bar
      log(`bar: ${bar.slice(0, 400)}`)
    }
    for (const fr of page.frames()) {
      const a = await fr.evaluate(() => document.querySelector('#answer')?.textContent ?? null).catch(() => null)
      if (a !== null && a !== answerWas) {
        answerWas = a
        log(`answer on the page: ${a.slice(0, 160)}`)
      }
    }
  } catch {}
}, 2000)
// Every new agent app process that the owner's It service starts (its parent chain leads to It), with its variable names
const seen = new Set()
const watchProcs = setInterval(() => {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$all = Get-CimInstance Win32_Process; $by=@{}; foreach($p in $all){$by[[int]$p.ProcessId]=$p}; $all | Where-Object { $_.Name -match '^(claude|codex)\\.exe$' } | ForEach-Object { $c=$_; $chain=@(); $q=$by[[int]$c.ParentProcessId]; for($i=0;$i -lt 6 -and $q;$i++){ $chain+=$q.Name; $q=$by[[int]$q.ParentProcessId] }; '{0}|{1}|{2}' -f $c.ProcessId, ($chain -join '<'), ([string]$c.CommandLine -replace '^.*?\\.exe\"?\\s*','') }"], { windowsHide: true })
  let out = ''
  ps.stdout.on('data', (d) => (out += d))
  ps.on('close', () => {
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const [pid, chain, args] = line.split('|')
      if (seen.has(pid)) continue
      seen.add(pid)
      const byIt = /(^|<)it\.exe/i.test(chain)
      if (!rec && !byIt) continue
      let names = null
      try {
        names = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'env-names.ps1'), pid], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }))
      } catch {}
      const nameList = (names?.names ?? []).map((n) => n.toUpperCase())
      const extra = nameList.filter((n) => !termNames.includes(n))
      const missing = termNames.filter((n) => !nameList.includes(n))
      log(`process ${pid} ${byIt ? 'STARTED BY IT' : ''} (parents ${chain}): ${redact(args).slice(0, 160)}${names ? ` | PATH holds .it\\bin: ${names.pathHasItBin} | names it has that the terminal has not: ${extra.join(',') || 'none'} | names the terminal has that it has not: ${missing.join(',') || 'none'}` : ' | names could not be read'}`)
    }
  })
}, 2000)

http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const q = JSON.parse(body || '{}')
    const reply = (o) => res.end(typeof o === 'string' ? o : JSON.stringify(o))
    try {
      if (q.cmd === 'type') await term.type(q.text)
      else if (q.cmd === 'key') term.key(q.name)
      else if (q.cmd === 'screen') return reply(redact(await term.screen()))
      else if (q.cmd === 'goto') {
        await page.goto(`${base}/p/${q.page}`)
        log(`browser went to the test page ${q.page}`)
      } else if (q.cmd === 'click') {
        for (const fr of page.frames()) {
          const el = await fr.$(q.selector).catch(() => null)
          if (el) {
            await el.click()
            log(`clicked ${q.selector}`)
            return reply('clicked')
          }
        }
        return reply('not found')
      } else if (q.cmd === 'record') {
        if (!rec) rec = recorder(path.join(OUT, 'video-browser.mp4'), { width: SCREEN.width, height: SCREEN.height })
        log('recording the screen (the browser half is kept)')
      } else if (q.cmd === 'note') log(q.text)
      else if (q.cmd === 'stop') {
        reply('stopping')
        clearInterval(watch)
        clearInterval(watchProcs)
        clearInterval(raising)
        if (rec) {
          await rec.stop()
          // Only the browser's half is kept
          const full = path.join(OUT, 'video-browser.mp4')
          const half = path.join(OUT, 'video.mp4')
          try {
            execFileSync('ffmpeg', ['-v', 'error', '-i', full, '-vf', 'crop=iw/2:ih:iw/2:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-y', half], { windowsHide: true })
            execFileSync('cmd.exe', ['/d', '/c', 'del', '/q', full], { windowsHide: true })
          } catch {}
        }
        writeFileSync(path.join(OUT, 'terminal-plain.txt'), redact(await term.screen()))
        spawn('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { windowsHide: true })
        await browser.close().catch(() => {})
        await tw.context.close().catch(() => {})
        await term.close()
        log('stopped; the terminal and the browser closed')
        process.exit(0)
      }
      reply('done')
    } catch (e) {
      reply(`error: ${e.message}`)
    }
  })
  .listen(5797, '127.0.0.1', () => log('control port open 5797'))
