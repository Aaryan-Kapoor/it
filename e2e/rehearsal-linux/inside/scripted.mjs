// The scenarios a script plays the person in, inside the container as ana, on a machine where It
// is already set up (a snapshot of scenario 1). The browser is the machine's own, reached over its
// debugging port; the agent app runs in the terminal, typed into through tmux.
//
//   node scripted.mjs <S4|S6|S7a|S7b> <app> <run folder>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { answerApp, busy, quitApp, settle, startApp } from './agent.mjs'
import { key, saveTerminal, screen, setRunDir, sleep, step, type } from './lib.mjs'

const [scenario, app, dir] = process.argv.slice(2).filter(Boolean)
setRunDir(dir)
const counts = { approvals: 0 }
const verdict = { scenario, app, ok: false, reason: null, blame: null, checks: [], counts }
const name = app === 'claude' ? 'Claude Code' : 'Codex'
const check = (what, ok, seen = {}) => {
  verdict.checks.push({ what, ok, ...seen })
  step(`${ok ? 'holds' : 'DOES NOT HOLD'}: ${what}`, seen, ok)
  return ok
}
const sh = (cmd) => {
  try {
    return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 120_000 })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

let browser
const PIZZA = /margherita|pepperoni|pizza|funghi|hawaiian|veg|diavola|quattro|mushroom/i
async function page() {
  browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const pages = ctx.pages().filter((p) => !p.url().startsWith('devtools'))
  return pages.find((p) => p.url().includes('localhost:4700')) ?? pages.at(-1) ?? (await ctx.newPage())
}

/** The text of the agent's page alone, inside the site: never the site's own bar. */
async function shown(p) {
  const parts = []
  for (const f of p.frames()) {
    if (f === p.mainFrame()) continue
    try {
      parts.push(await f.evaluate(() => document.body?.innerText ?? ''))
    } catch {}
  }
  return parts.join('\n')
}
/** What the site's own bar says, for the record. */
async function bar(p) {
  try {
    return (await p.mainFrame().evaluate(() => document.body?.innerText ?? '')).split('\n').filter((l) => /sent|waiting|wake|listening|working|done|reach/i.test(l)).slice(0, 3).join(' / ').slice(0, 300)
  } catch {
    return ''
  }
}

/** The agent's page frame: the one that is not the site itself. */
async function agentFrame(p) {
  for (const f of p.frames()) if (f !== p.mainFrame() && !/^about:/.test(f.url())) return f
  return null
}

/** Clicks the nth button of the agent's page whose words match `re`, and says which. */
async function press(p, re, nth = 0) {
  const f = await agentFrame(p)
  if (!f) return null
  const buttons = await f.$$('button, [role=button], .card, label')
  const named = []
  for (const b of buttons) {
    const t = ((await b.innerText().catch(() => '')) ?? '').trim()
    if (t && re.test(t) && (await b.isVisible().catch(() => false))) named.push({ b, t })
  }
  const one = named[nth] ?? named[0]
  if (!one) return null
  await sleep(1500)
  await one.b.click()
  await sleep(1500)
  // A page that asks for a pick and then a press of its own button is sent by that button
  for (const b of await f.$$('button')) {
    const t = ((await b.innerText().catch(() => '')) ?? '').trim()
    if (t && t !== one.t && (!re.test(t) || /^(choose|order|send|submit|confirm|get|show|tell|ask|go|pick)\b/i.test(t)) && /order|tell|send|submit|ask|what would|go\b|confirm|pick this|pick it|pick me|pair|get |show|see |recommend|suggest|choose|done|let.s|find|match/i.test(t) && (await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
      await sleep(1000)
      await b.click()
      await sleep(1500)
      break
    }
  }
  return one.t.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** A line of the agent's answer to a pick: new, naming what was picked, and not the page's own "sent" note. */
const NOT_ANSWER = /sending|sent\b|on its way|waiting|working|thinking|taking a look|picking|choosing|got it\b|preparing/i
function answerLine(before, now, picked) {
  const name = (String(picked ?? '').match(PIZZA) ?? [])[0]
  return now
    .split('\n')
    .filter((l) => l.trim().length > 25 && !before.includes(l) && !NOT_ANSWER.test(l) && (!name || new RegExp(name, 'i').test(l) || /order|pair|with (it|your)|i.d (have|go|order)/i.test(l)))
    .join(' / ')
    .slice(0, 240)
}

/** Waits until the page shows words it did not show before, for up to `ms`. */
async function answered(p, before, ms, what) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    await answerApp(app, counts).catch(() => {})
    const now = await shown(p).catch(() => before)
    if (now !== before && now.length > 0) {
      // A new line of the agent's that says more than that the pick is on its way
      const fresh = answerLine(before, now, null)
      if (fresh) return check(what, true, { seconds: Math.round((Date.now() - start) / 1000), fresh })
    }
    await sleep(2000)
  }
  return check(what, false, { seconds: Math.round(ms / 1000) })
}

async function agentWorks(text, ms = 600_000) {
  step(`types to ${name}: "${text}"`)
  await type(text)
  await sleep(5000)
  return settle(app, counts, ms, 8000)
}

async function pizzaPage() {
  await startApp(app, counts)
  await agentWorks('Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.')
  const p = await page()
  await p.bringToFront()
  for (let i = 0; i < 30; i++) {
    if (/pizza|margherita|pepperoni/i.test(await shown(p))) return p
    await sleep(2000)
  }
  check('the agent put a pizza page on the screen', false)
  return p
}

async function S4() {
  const p = await pizzaPage()
  check('the agent put a pizza page on the screen', /pizza|margherita|pepperoni/i.test(await shown(p)))
  let before = await shown(p)
  const first = await press(p, /margherita|pepperoni|pizza|funghi|hawaiian|veg|diavola|quattro/i, 0)
  step(`picks "${first}"`)
  await answered(p, before, 180_000, 'a pick with the conversation open is answered on the page')
  await settle(app, counts, 120_000, 6000)
  // The app closed: Auto-wake reopens the conversation
  await quitApp(app)
  await sleep(4000)
  before = await shown(p)
  const second = await press(p, /margherita|pepperoni|pizza|funghi|hawaiian|veg|diavola|quattro/i, 1)
  step(`with ${name} closed, picks "${second}"`)
  await answered(p, before, 300_000, 'with the app closed, Auto-wake reopens the conversation and the pick is answered')
  // Auto-wake off on the Machines page
  const site = p
  await sleep(3000)
  await site.getByRole('link', { name: /Machines/ }).first().click().catch(() => site.goto('http://localhost:4700/#/machines'))
  await sleep(3000)
  const toggle = site.getByRole('switch', { name: /auto-?wake/i }).or(site.getByRole('checkbox', { name: /auto-?wake/i })).or(site.getByText(/Auto-?wake/i).first())
  const seenMachines = (await site.mainFrame().evaluate(() => document.body.innerText)).slice(0, 1500)
  step('opens the Machines page', { seen: seenMachines.slice(0, 600) })
  await toggle.first().click().catch(() => step('no Auto-wake switch was found on the Machines page', {}, false))
  await sleep(3000)
  step('turned Auto-wake off', { seen: (await site.mainFrame().evaluate(() => document.body.innerText)).slice(0, 600) })
  await site.goBack().catch(() => {})
  await sleep(4000)
  before = await shown(p)
  const third = await press(p, /margherita|pepperoni|pizza|funghi|hawaiian|veg|diavola|quattro/i, 2)
  step(`with Auto-wake off and ${name} closed, picks "${third}"`)
  await sleep(45_000)
  const waiting = await shown(p)
  check('the click waits, and the page says so', waiting !== before && /wait|closed|not (running|open)|when .* (opens|starts)|reopen/i.test(waiting), { seen: waiting.split('\n').filter((l) => !before.includes(l)).join(' / ').slice(0, 300) })
  step(`reopens the conversation by hand`)
  await type(app === 'claude' ? 'claude --continue' : 'codex resume --last')
  await sleep(6000)
  await answered(p, waiting, 300_000, 'reopened by hand, the waiting click is delivered and answered')
  await settle(app, counts, 180_000, 8000)
}



async function S6() {
  const p = await pizzaPage()
  let before = await shown(p)
  step(`picks "${await press(p, PIZZA, 0)}"`)
  await answered(p, before, 180_000, 'before the update, a pick is answered on the page')
  await settle(app, counts, 120_000, 6000)
  // The Machines page, looked at as a person would after hearing a fix is out
  await p.goto('http://localhost:4700/#/machines').catch(() => {})
  await sleep(5000)
  let machines = await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')
  step('opens the Machines page', { seen: machines.slice(0, 700) })
  const update = p.getByRole('button', { name: /update/i }).first()
  let how
  if (await update.isVisible().catch(() => false)) {
    how = 'the Update button on the Machines page'
    step('presses Update on the Machines page')
    await update.click()
  } else {
    how = '`it upgrade` in a second terminal'
    step('no Update button is shown; runs it upgrade in a second terminal tab')
    sh('tmux new-window -t agent -n upgrade')
    sh(`tmux send-keys -t agent:upgrade -l '~/.it/bin/it upgrade' && tmux send-keys -t agent:upgrade Enter`)
    await sleep(90_000)
    step('what it upgrade said', { said: sh('tmux capture-pane -p -J -t agent:upgrade').trim().split('\n').slice(-12).join(' / ').slice(0, 900) })
    sh('tmux select-window -t agent:0')
  }
  verdict.updatedBy = how
  await sleep(60_000)
  const version = sh('~/.it/bin/it --version').trim()
  check('the newer version is in place and the service runs it', /0\.1\.42/.test(version) && /active/.test(sh('systemctl --user is-active it.service')), { version })
  // Back to the pizza page, as the person had it
  await p.goBack().catch(() => {})
  await sleep(8000)
  const told = await shown(p)
  check('the open tab says that It was updated, or reloads by itself', /reload|updated|new version|refresh/i.test(told) || /pizza|margherita|pepperoni/i.test(told), { seen: told.slice(0, 400) })
  const reload = p.getByRole('button', { name: /reload|refresh/i }).first()
  if (await reload.isVisible().catch(() => false)) {
    step('presses the reload the tab offers')
    await reload.click()
    await sleep(6000)
  }
  check('the page from before the update is still there', PIZZA.test(await shown(p)))
  before = await shown(p)
  step(`picks "${await press(p, PIZZA, 1)}"`)
  await answered(p, before, 300_000, 'after the update, a pick is answered with nothing else done')
}

async function S7() {
  // After the reboot, signed in again: the browser came back with the person
  const p = await page()
  await sleep(5000)
  check('the service came back by itself after the reboot', /^active/.test(sh('systemctl --user is-active it.service').trim()))
  await p.goto('http://localhost:4700/').catch(() => {})
  await sleep(6000)
  const site = await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')
  check('the paired browser shows its pages without pairing again', !/pair this browser|enter the code|scan/i.test(site) && site.length > 50, { seen: site.slice(0, 500) })
  // The newest page, which the agent built at the end of the tour
  const card = p.locator('a[href*="/p/"]').first()
  if (await card.isVisible().catch(() => false)) {
    step('opens the newest page')
    await card.click()
    await sleep(6000)
  } else step('no page is listed to open', {}, false)
  const before = await shown(p)
  const pressed = await press(p, /./, 0)
  step(`presses "${pressed}" on it`)
  if (!pressed) return check('a click on a page is answered after the reboot', false, { why: 'no button on the page' })
  await answered(p, before, 300_000, 'a click on a page is answered after the reboot (Auto-wake reopens the conversation)')
}


async function SOAK() {
  const p = await pizzaPage()
  let before = await shown(p)
  step(`picks "${await press(p, PIZZA, 0)}"`)
  await answered(p, before, 240_000, 'the first pick, with the conversation open, is answered')
  await settle(app, counts, 120_000, 6000)
  await quitApp(app)
  // Then a click every ten minutes for two hours, with the app closed: each reopens the conversation
  const until = Date.now() + 120 * 60_000
  let n = 0
  while (Date.now() < until) {
    const next = Date.now() + 10 * 60_000
    n++
    await p.bringToFront().catch(() => {})
    before = await shown(p)
    const which = await press(p, PIZZA, n % 3)
    step(`soak click ${n}: picks "${which}"`, { bar: await bar(p) })
    await answered(p, before, 300_000, `soak click ${n} is answered on the page`)
    step(`after soak click ${n}`, { bar: await bar(p) })
    while (Date.now() < next && Date.now() < until) await sleep(5000)
  }
}

/**
 * Both agent apps on one machine for the whole night: a page from each, then a click every fifteen
 * minutes, alternating between them. In the first half Codex stays open and Claude Code is closed,
 * so Claude Code's clicks go through Auto-wake; in the second half Codex is closed and Claude Code
 * resumed, so Codex's go through Auto-wake. Played on a fresh machine where It is set up for both.
 */
/** Types a request to the app, and types it again where the app had not taken the words (still drawing its start screen). */
async function ask(who, text) {
  // The app's own input line first, answering whatever it asks before that (its theme, the folder)
  const ready = /for shortcuts|Ask Codex to do anything|shift\+tab to cycle|auto mode|accept edits|bypass permissions|\? for/i
  for (let i = 0; i < 40; i++) {
    const did = await answerApp(who, counts).catch(() => null)
    const tail = screen().replace(/\s+$/, '').split('\n').slice(-8).join('\n')
    if (!did && ready.test(tail) && !/No, exit|trust this folder|Do you trust|Trust all/i.test(screen())) break
    await sleep(1500)
  }
  for (let i = 0; i < 3; i++) {
    step(`types to ${who === 'claude' ? 'Claude Code' : 'Codex'}: "${text}"${i ? ' (again: the app had not taken it)' : ''}`)
    await type(text)
    await sleep(9000)
    await answerApp(who, counts).catch(() => {})
    const s = screen()
    if (busy() || s.includes(text.slice(0, 40)) || /Working|Thinking|esc to interrupt/i.test(s)) return
  }
}

async function SOAK2() {
  const hours = Number(process.env.SOAK_HOURS ?? '7')
  const DRINK = /lemonade|iced tea|cola|tea|drink/i
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  // The browser paired as the tour would have it, by the link that `it site` prints
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  check('it site gives a pairing link', !!pair)
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(8000)
  const answeredBy = async (who, before, ms, what) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      await answerApp(who, counts).catch(() => {})
      const now = await shown(p).catch(() => before)
      const fresh = answerLine(before, now, null)
      if (now !== before && fresh) return check(what, true, { seconds: Math.round((Date.now() - start) / 1000), fresh })
      await sleep(2000)
    }
    return check(what, false, { seconds: Math.round(ms / 1000) })
  }
  const makePage = async (who, askText, re) => {
    await startApp(who, counts)
    await ask(who, askText)
    await settle(who, counts, 600_000, 8000)
    for (let i = 0; i < 40; i++) {
      p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
      if (re.test(await shown(p).catch(() => ''))) return p.url()
      await sleep(3000)
    }
    check(`${who} put its page on the screen`, false)
    return p.url()
  }
  const urlA = await makePage('claude', 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.', PIZZA)
  let before = await shown(p)
  step(`claude page: picks "${await press(p, PIZZA, 0)}"`)
  await answeredBy('claude', before, 240_000, 'Claude Code, conversation open: a pick is answered')
  await settle('claude', counts, 120_000, 6000)
  await quitApp('claude')
  const urlB = await makePage('codex', 'Make me a page with It where I can pick one of three drinks: lemonade, iced tea or cola, and tell me on the page what snack you would have with it.', DRINK)
  before = await shown(p)
  step(`codex page: picks "${await press(p, DRINK, 0)}"`)
  await answeredBy('codex', before, 240_000, 'Codex, conversation open: a pick is answered')
  await settle('codex', counts, 120_000, 6000)
  step('soak pages', { claude: urlA, codex: urlB })
  const start = Date.now()
  const until = start + hours * 3600_000
  let n = 0
  let swapped = false
  while (Date.now() < until) {
    const next = Date.now() + 15 * 60_000
    if (!swapped && Date.now() - start > (hours * 3600_000) / 2) {
      // Halfway: Codex closed, Claude Code's conversation resumed in the terminal
      await quitApp('codex')
      // The harness's sign-in variable in this terminal is as old as the night; Claude Code then
      // reads the newest copy the harness keeps in its own file, as a laptop's Claude Code would
      await type('unset CLAUDE_CODE_OAUTH_TOKEN')
      await startApp('claude', counts, '--continue')
      swapped = true
      step('halfway: Codex closed, Claude Code resumed with --continue')
    }
    n++
    const who = n % 2 ? 'claude' : 'codex'
    const open = swapped ? who === 'claude' : who === 'codex'
    await p.goto(who === 'claude' ? urlA : urlB).catch(() => {})
    await sleep(8000)
    before = await shown(p)
    const which = await press(p, who === 'claude' ? PIZZA : DRINK, (Math.floor(n / 2) + 1) % 3)
    step(`soak click ${n} (${who}, ${open ? 'conversation open' : 'closed, Auto-wake'}): picks "${which}"`, { bar: await bar(p) })
    await answeredBy(open ? who : swapped ? 'claude' : 'codex', before, 300_000, `soak click ${n}, ${who}, ${open ? 'open' : 'Auto-wake'}: answered on the page`)
    step(`after soak click ${n}`, { bar: await bar(p) })
    while (Date.now() < next && Date.now() < until) {
      await answerApp(swapped ? 'claude' : 'codex', counts).catch(() => {})
      await sleep(5000)
    }
  }
}

/** The variable NAMES (never a value) of a process of ana's, sorted, or null where it is gone. */
function envNames(pid) {
  const out = sh(`tr '\\0' '\\n' < /proc/${Number(pid)}/environ 2>/dev/null | sed -n 's/=.*//p' | sort -u`)
  const names = out.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l))
  return names.length ? names : null
}
/** Whether It's own folder is on a process's PATH (a PATH holds no secret), or null where it is gone. */
function pathFirst(pid) {
  return sh(`tr '\\0' '\\n' < /proc/${Number(pid)}/environ 2>/dev/null | sed -n 's/^PATH=//p'`).trim().split(':')[0] || null
}
function itOnPath(pid) {
  const path = sh(`tr '\\0' '\\n' < /proc/${Number(pid)}/environ 2>/dev/null | sed -n 's/^PATH=//p'`).trim()
  return path ? /\/\.it\/bin(:|$)/.test(path) : null
}
/** Codex's own background server, which outlives /quit, and what it has. */
function codexServer() {
  const pid = sh("ps -u ana -o pid=,args= | grep 'codex app-server' | grep -v grep | head -1 | awk '{print $1}'").trim()
  return pid ? { pid: Number(pid), itOnPath: itOnPath(pid) } : null
}

/** The agent app's processes of ana's: pid and command line, the command line cut short and with no value of any variable. */
function appProcs(who) {
  const re = who === 'claude' ? /(^|\/)claude( |$)/ : /(^|\/)codex( |$)/
  return sh('ps -u ana -o pid=,args=')
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m && re.test(m[2]) && !/app-server|code-mode|ps -u ana/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), args: m[2].replace(/\s+--?\S*(token|key)\S*\s+\S+/gi, ' [cut]').slice(0, 140) }))
}

/**
 * Auto-wake, on a machine set up as a participant's (run.mjs --participant): a page, then every
 * way a participant's click can find the conversation closed, quiet or busy, each timed from the
 * click to the answer on the page, with the variable names of every process It reopened.
 */
async function WAKE() {
  const who = app
  const label = who === 'claude' ? 'Claude Code' : 'Codex'
  const resume = who === 'claude' ? 'claude --continue' : 'codex resume --last'
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  check('it site gives a pairing link', !!pair)
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(8000)
  // What the service and the person's terminal each have, by name
  const mainPid = sh('systemctl --user show -p MainPID --value it.service').trim()
  const svc = envNames(mainPid) ?? []
  const pane = sh("tmux display -p -t agent '#{pane_pid}'").trim()
  const term = envNames(pane) ?? []
  step('variable names: It\'s service and the terminal', { service: svc.join(' '), terminal: term.join(' '), onlyService: svc.filter((n) => !term.includes(n)).join(' '), onlyTerminal: term.filter((n) => !svc.includes(n)).join(' ') })
  step('lingering', { linger: sh('ls /var/lib/systemd/linger/ 2>&1').trim(), note: sh('ls ~/.it/linger-by-it 2>&1').trim() })

  await startApp(who, counts)
  await ask(who, 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.')
  await settle(who, counts, 600_000, 8000)
  let url = null
  for (let i = 0; i < 40 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (PIZZA.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  if (!check(`${label} put its page on the screen`, !!url)) return

  let nth = 0
  /** One click on the page, timed to the answer; with the names of any process It reopened for it. */
  const click = async (what, { open = false, ms = 300_000, reload = true } = {}) => {
    if (reload) {
      await p.goto(url).catch(() => {})
      await sleep(6000)
    }
    const had = new Set(appProcs(who).map((x) => x.pid))
    const before = await shown(p)
    const t0 = Date.now()
    // Markers left by a server added for every project and by a hook in the project's settings, counted before the press: a woken app starts them within seconds of it
    const marks = () => ({ server: Number(sh('ls /tmp/it-marker-server-* 2>/dev/null | wc -l').trim()), projectHook: Number(sh('ls /tmp/it-marker-hook-* 2>/dev/null | wc -l').trim()) })
    const marksBefore = marks()
    const picked = await press(p, PIZZA, nth++ % 3)
    step(`${what}: picks "${picked}"`, { bar: await bar(p) })
    let woke = null
    let ok = false
    let bars = []
    while (Date.now() - t0 < ms) {
      if (open) await answerApp(who, counts).catch(() => {})
      if (!woke) {
        const fresh = appProcs(who).filter((x) => !had.has(x.pid))
        if (fresh.length) {
          const names = envNames(fresh[0].pid)
          woke = { pid: fresh[0].pid, args: fresh[0].args, seconds: Math.round((Date.now() - t0) / 1000), itOnPath: itOnPath(fresh[0].pid), pathFirst: pathFirst(fresh[0].pid), names, onlyWoken: names?.filter((n) => !term.includes(n)).join(' '), onlyTerminal: names ? term.filter((n) => !names.includes(n)).join(' ') : null, configDir: names?.includes('CLAUDE_CONFIG_DIR') ? sh(`tr '\\0' '\\n' < /proc/${fresh[0].pid}/environ | sed -n 's/^CLAUDE_CONFIG_DIR=//p'`).trim() : 'not set' }
        }
      }
      const b = await bar(p)
      if (b && b !== bars.at(-1)) bars.push(b)
      const now = await shown(p).catch(() => before)
      const fresh = answerLine(before, now, picked)
      if (now !== before && fresh) {
        ok = true
        check(`${what}: answered on the page`, true, { seconds: Math.round((Date.now() - t0) / 1000), fresh, bars: bars.join(' | ').slice(0, 400) })
        break
      }
      await sleep(1000)
    }
    if (!ok) check(`${what}: answered on the page`, false, { seconds: Math.round(ms / 1000), bars: bars.join(' | ').slice(0, 600) })
    await sleep(3000)
    const marksAfter = marks()
    step(`${what}: processes`, { reopened: woke ?? 'none new', codexServer: who === 'codex' ? codexServer() : undefined, appProcessesNow: appProcs(who).length, serverStarts: marksAfter.server - marksBefore.server, projectHookRuns: marksAfter.projectHook - marksBefore.projectHook, globalSettingsFile: sh('ls -la ~/.claude.json ~/.claude/.claude.json 2>&1 | sed "s/^.* ana ana *//"').trim().replace(/\n/g, ' | ') })
    return ok
  }

  // 1. The conversation open
  await click('1. conversation open', { open: true })
  await settle(who, counts, 120_000, 6000)
  // 2. A click while the person is typing in that conversation, and what became of the typing
  await type('I was half way through typing this', { enter: false })
  await click('2. while the person types in the conversation', { open: true })
  step('2. the typed words after the click', { stillThere: /half way through typing this/.test(screen()) })
  await key('C-u')
  await settle(who, counts, 120_000, 6000)
  // 3. Idle for twenty minutes, then a click: it must arrive in the open conversation
  const procsBefore = appProcs(who).length
  step('3. leaves the conversation idle for twenty minutes')
  const idleUntil = Date.now() + 20 * 60_000
  while (Date.now() < idleUntil) {
    await answerApp(who, counts).catch(() => {})
    await sleep(10_000)
  }
  await click('3. after twenty idle minutes, conversation open', { open: true })
  step('3. a second copy?', { appProcessesBefore: procsBefore, appProcessesAfter: appProcs(who).length })
  await settle(who, counts, 120_000, 6000)
  // 4. The app quit, and a click
  await quitApp(who)
  await sleep(30_000)
  await click('4. app quit (Auto-wake)')
  // 5. Three clicks in a row while the first wake is still starting
  await sleep(60_000)
  await p.goto(url).catch(() => {})
  await sleep(6000)
  const before5 = await shown(p)
  const t5 = Date.now()
  const picks = []
  for (let i = 0; i < 3; i++) {
    picks.push(await press(p, PIZZA, i))
    await sleep(2500)
  }
  step('5. three clicks in a row, the app closed', { picks: picks.join(', '), bar: await bar(p) })
  let seen5 = ''
  const last5 = (String(picks.at(-1) ?? '').match(PIZZA) ?? ['(none)'])[0]
  const got5 = () => answerLine(before5, seen5, picks.at(-1)).match(new RegExp(last5, 'i'))
  while (Date.now() - t5 < 360_000) {
    seen5 = await shown(p).catch(() => '')
    if (got5()) break
    await sleep(2000)
  }
  check('5. the last of three quick clicks is answered on the page', !!got5(), { seconds: Math.round((Date.now() - t5) / 1000), bar: await bar(p), lastPick: last5, answer: answerLine(before5, seen5, picks.at(-1)).slice(0, 200) })
  // 6. The terminal window closed with the app open in it (its programs hang up), and a click
  await sleep(30_000)
  await type(resume)
  await sleep(4000)
  await settle(who, counts, 120_000, 5000)
  step('6. closes the terminal with the app open in it')
  sh('tmux kill-server')
  await sleep(15_000)
  step('6. app processes after the terminal closed', { left: appProcs(who).length })
  await click('6. terminal closed (Auto-wake)')
  // 7. The project folder renamed, and a click
  await sleep(30_000)
  sh('mv ~/work ~/work-renamed')
  step('7. renames the project folder ~/work to ~/work-renamed')
  await click('7. folder renamed (Auto-wake)')
  // 8. Auto-wake turned off under Machines, a click, then the conversation opened by hand
  await sleep(30_000)
  await p.goto('http://localhost:4700/machines').catch(() => {})
  await sleep(6000)
  const sw = p.locator(`[role=switch][aria-label="Auto-wake ${label}"]`).first()
  const was = await sw.isChecked().catch(() => null)
  if (was) await sw.click().catch(() => {})
  await sleep(4000)
  step('8. Machines: Auto-wake switched off', { wasOn: was, nowOn: await sw.isChecked().catch(() => null), says: (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).split('\n').filter((l) => /auto-wake|click waits|reopens/i.test(l)).slice(0, 3).join(' / ') })
  await p.goto(url).catch(() => {})
  await sleep(6000)
  const before8 = await shown(p)
  const t8 = Date.now()
  step(`8. picks "${await press(p, PIZZA, nth++ % 3)}" with Auto-wake off`)
  await sleep(60_000)
  step('8. the bar a minute later', { bar: await bar(p), siteSays: (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).split('\n').filter((l) => /listening|waiting|wake|open its conversation|machines/i.test(l)).slice(0, 3).join(' / '), answered: (await shown(p)) !== before8 })
  sh(`tmux new-session -d -s agent -x 104 -y 56 -c ~/work-renamed`)
  // A new terminal window, as the person opens one
  sh('setsid -f env DISPLAY=:1 xfce4-terminal --disable-server --hide-menubar --hide-toolbar --hide-scrollbar --title=Terminal --font="DejaVu Sans Mono 11" --geometry=104x54+0+0 -x tmux attach -t agent >/dev/null 2>&1')
  await sleep(4000)
  await type(resume)
  step(`8. opens the conversation by hand: ${resume} in ~/work-renamed`)
  let ok8 = false
  while (Date.now() - t8 < 420_000) {
    await answerApp(who, counts).catch(() => {})
    const now = await shown(p).catch(() => before8)
    if (now !== before8 && answerLine(before8, now, null)) {
      ok8 = true
      break
    }
    await sleep(2000)
  }
  check('8. opening the conversation by hand delivers the waiting click', ok8, { seconds: Math.round((Date.now() - t8) / 1000) })
}

/** Before the restart: both screens paired, a page, a click answered, the app quit. */
async function WAKEBOOT1() {
  const who = app
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const link = () => /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  // The second screen first, a browser of its own, so that the laptop's browser is the newest
  // display and the agent's page comes up there
  sh('setsid -f env DISPLAY=:1 /opt/ms-playwright/chromium-1228/chrome-linux64/chrome --user-data-dir=/opt/person-profile/screen2 --no-sandbox --test-type --no-first-run --no-default-browser-check --password-store=basic --remote-debugging-port=9223 --window-position=1300,300 --window-size=600,700 about:blank >/dev/null 2>&1')
  await sleep(6000)
  const b2 = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const p2 = b2.contexts()[0].pages()[0] ?? (await b2.contexts()[0].newPage())
  const pair2 = link()
  if (pair2) await p2.goto(pair2).catch(() => {})
  await sleep(8000)
  check('the second screen is paired', /localhost:4700\/(?!pair)/.test(p2.url()) || !/pair/.test(p2.url()), { url: p2.url().replace(/#.*/, '') })
  const pair = link()
  check('it site gives a pairing link', !!pair)
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(8000)
  await startApp(who, counts)
  await ask(who, 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.')
  await settle(who, counts, 600_000, 8000)
  let url = null
  for (let i = 0; i < 40 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (p.url().includes('/p/') && PIZZA.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  if (!check('the page is on the screen', !!url)) return
  writeFileSync('/var/lib/rehearsal-flow/url.txt', url)
  const before = await shown(p)
  step(`picks "${await press(p, PIZZA, 0)}" with the conversation open`)
  await answered(p, before, 240_000, 'a click with the conversation open is answered')
  await settle(who, counts, 120_000, 6000)
  await quitApp(who)
  await b2.close().catch(() => {})
  sh("pkill -u ana -f 'user-data-dir=/opt/person-profile/screen2' || true")
  await sleep(3000)
}

/** After the restart, nobody signed in: a click from the second screen, timed, with what It reopened. */
async function WAKEBOOT2() {
  const who = app
  try {
    const prior = JSON.parse(readFileSync(`${dir}/flow.json`, 'utf8'))
    verdict.checks.push(...(prior.checks ?? []))
  } catch {}
  const url = readFileSync('/var/lib/rehearsal-flow/url.txt', 'utf8').trim()
  step('after the restart', { linger: sh('loginctl show-user ana -p Linger 2>&1').trim(), userManager: sh('systemctl is-active user@1000.service 2>&1').trim(), sessions: sh('loginctl list-sessions --no-legend 2>&1 | wc -l').trim(), itAnswers: sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4700/ 2>&1').trim() })
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const p = ctx.pages()[0] ?? (await ctx.newPage())
  await p.goto(url).catch(() => {})
  await sleep(10_000)
  step('the second screen opens the page', { shows: (await shown(p)).slice(0, 160), site: (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).slice(0, 200) })
  const had = new Set(appProcs(who).map((x) => x.pid))
  const before = await shown(p)
  const t0 = Date.now()
  step(`after the restart, picks "${await press(p, PIZZA, 1)}" on the second screen`, { bar: await bar(p) })
  let woke = null
  let ok = false
  const bars = []
  while (Date.now() - t0 < 300_000) {
    if (!woke) {
      const fresh = appProcs(who).filter((x) => !had.has(x.pid))
      if (fresh.length) woke = { pid: fresh[0].pid, seconds: Math.round((Date.now() - t0) / 1000), itOnPath: itOnPath(fresh[0].pid), pathFirst: pathFirst(fresh[0].pid), names: envNames(fresh[0].pid)?.join(' ') }
    }
    const b = await bar(p)
    if (b && b !== bars.at(-1)) bars.push(b)
    const now = await shown(p).catch(() => before)
    if (now !== before && answerLine(before, now, null)) {
      ok = true
      break
    }
    await sleep(1000)
  }
  check('after the restart, nobody signed in, a click from the second screen is answered', ok, { seconds: Math.round((Date.now() - t0) / 1000), bars: bars.join(' | ').slice(0, 500), reopened: woke ?? 'none seen' })
}

/**
 * The shorter Auto-wake run for a machine prepared one particular way (the app under a version
 * manager, an older app, a variable in the shell's profile): a page, a click with the app open,
 * the app quit and a click, and, where /var/lib/rehearsal-flow/between.sh is there, that run (as
 * root, by run.mjs, which watches for between-now) and a second click.
 */
async function WAKELITE() {
  const who = app
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  check('it site gives a pairing link', !!pair)
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(8000)
  const pane = sh("tmux display -p -t agent '#{pane_pid}'").trim()
  const term = envNames(pane) ?? []
  step('the app in the terminal', { itVersion: sh('~/.it/bin/it version 2>/dev/null | grep -o "0.1.4."').trim(), unitPath: sh("grep -o 'PATH=[^\"]*' ~/.config/systemd/user/it.service").trim(), which: sh(`bash -ic 'command -v ${who}; ${who} --version' 2>/dev/null`).trim().split('\n').slice(-2).join(' / '), serviceFinds: sh(`systemd-run --user --wait --pipe -q sh -c 'command -v ${who} || echo none' 2>&1`).trim() })
  await startApp(who, counts)
  await ask(who, 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.')
  await settle(who, counts, 600_000, 8000)
  let url = null
  for (let i = 0; i < 40 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (PIZZA.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  if (!check('the page is on the screen', !!url)) return
  let nth = 0
  const click = async (what, open) => {
    await p.goto(url).catch(() => {})
    await sleep(6000)
    const had = new Set(appProcs(who).map((x) => x.pid))
    const before = await shown(p)
    const t0 = Date.now()
    step(`${what}: picks "${await press(p, PIZZA, nth++ % 3)}"`, { bar: await bar(p) })
    let woke = null
    const bars = []
    while (Date.now() - t0 < 300_000) {
      if (open) await answerApp(who, counts).catch(() => {})
      if (!woke) {
        const fresh = appProcs(who).filter((x) => !had.has(x.pid))
        if (fresh.length) {
          const names = envNames(fresh[0].pid)
          woke = { pid: fresh[0].pid, args: fresh[0].args, seconds: Math.round((Date.now() - t0) / 1000), itOnPath: itOnPath(fresh[0].pid), pathFirst: pathFirst(fresh[0].pid), names: names?.join(' '), onlyWoken: names?.filter((n) => !term.includes(n)).join(' '), onlyTerminal: names ? term.filter((n) => !names.includes(n)).join(' ') : null }
        }
      }
      const b = await bar(p)
      if (b && b !== bars.at(-1)) bars.push(b)
      const now = await shown(p).catch(() => before)
      const fresh = answerLine(before, now, null)
      if (now !== before && fresh) {
        check(`${what}: answered on the page`, true, { seconds: Math.round((Date.now() - t0) / 1000), fresh, bars: bars.join(' | ').slice(0, 400), reopened: woke ?? 'none new', codexServer: who === 'codex' ? codexServer() : undefined })
        return true
      }
      await sleep(1000)
    }
    check(`${what}: answered on the page`, false, { seconds: 300, bars: bars.join(' | ').slice(0, 600), reopened: woke ?? 'none new', site: (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).split('\n').filter((l) => /wake|listening|waiting|open its|could/i.test(l)).slice(0, 3).join(' / ') })
    return false
  }
  await click('conversation open', true)
  await settle(who, counts, 120_000, 6000)
  await quitApp(who)
  await sleep(30_000)
  await click('app quit (Auto-wake)', false)
  if (sh('test -f /etc/rehearsal-between.sh && echo yes').trim() === 'yes') {
    sh('touch /var/lib/rehearsal-flow/between-now')
    for (let i = 0; i < 180 && sh('test -f /var/lib/rehearsal-flow/between-done && echo yes').trim() !== 'yes'; i++) await sleep(2000)
    step('between the clicks', { did: sh('cat /var/lib/rehearsal-flow/between.log 2>/dev/null | tail -3').trim().slice(0, 300), appNow: sh(`bash -ic '${who} --version' 2>/dev/null`).trim().split('\n').pop() })
    await sleep(20_000)
    await click('after the change between the clicks (Auto-wake)', false)
  }
}

/** A page made in a fresh conversation, with the browser paired first; resolves with the page and its address. */
async function freshPage(who, askText, re, before = null) {
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  check('it site gives a pairing link', !!pair)
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(8000)
  if (before) await type(before)
  await startApp(who, counts)
  await ask(who, askText)
  await settle(who, counts, 600_000, 8000)
  let url = null
  for (let i = 0; i < 40 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (p.url().includes('/p/') && re.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  check('the page is on the screen', !!url)
  return { p, url }
}

/**
 * Finding 6: a click made while It's service restarts, with Claude Code open, ten times, watching
 * for a second copy of the open conversation started beside it. Five as Linux has it, five with
 * IT_SHELL_ENV=off in the service, which stands for Windows, where the shell is not asked.
 */
async function RESTARTCLICK() {
  const who = app
  const { p, url } = await freshPage(who, 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.', PIZZA)
  if (!url) return
  let before = await shown(p)
  const first = await press(p, PIZZA, 0)
  step(`picks "${first}" with the conversation open`)
  await answered(p, before, 180_000, 'a click with the conversation open is answered')
  await settle(who, counts, 120_000, 6000)
  for (let i = 1; i <= 10; i++) {
    if (i === 6) {
      sh('systemctl --user set-environment IT_SHELL_ENV=off')
      step('from here on IT_SHELL_ENV=off in the service, standing for Windows')
    }
    await settle(who, counts, 60_000, 25_000)
    const had = appProcs(who).map((x) => x.pid)
    sh('systemctl --user stop it.service')
    await sleep(2000)
    before = await shown(p).catch(() => '')
    const t0 = Date.now()
    const picked = await press(p, PIZZA, i % 3)
    await sleep(3000)
    sh('systemctl --user start it.service')
    let fresh = ''
    let seenExtra = []
    while (Date.now() - t0 < 180_000) {
      await answerApp(who, counts).catch(() => {})
      const extra = appProcs(who).filter((x) => !had.includes(x.pid))
      if (extra.length) seenExtra = extra.map((x) => x.args.slice(0, 90))
      fresh = answerLine(before, await shown(p).catch(() => before), picked)
      if (fresh) break
      await sleep(1000)
    }
    check(`restart ${i}: the click made while It was stopped is answered, and no second copy of the open conversation is started`, !!fresh && seenExtra.length === 0, { seconds: Math.round((Date.now() - t0) / 1000), secondCopy: seenExtra, answer: fresh.slice(0, 120) })
  }
  sh('systemctl --user unset-environment IT_SHELL_ENV')
}

/**
 * Finding 4: the project's virtual environment, active in the terminal the agent was started from,
 * and a page whose button asks the agent to run a script that needs it; then the app quit and the
 * same button pressed, so that a reopened turn runs it.
 */
async function VENV() {
  const who = app
  const RUN = /run|check/i
  const { p, url } = await freshPage(who, 'Make me a page with It with one button, Run my check. When I press it, run python check.py in this folder and show on the page exactly what it prints, every time I press it.', RUN, 'source .venv/bin/activate')
  if (!url) return
  const go = async (what, open) => {
    await p.goto(url).catch(() => {})
    await sleep(6000)
    const before = await shown(p)
    const had = new Set(appProcs(who).map((x) => x.pid))
    const t0 = Date.now()
    step(`${what}: presses "${await press(p, RUN, 0)}"`)
    let woke = null
    while (Date.now() - t0 < 300_000) {
      if (open) await answerApp(who, counts).catch(() => {})
      if (!woke) {
        const f = appProcs(who).filter((x) => !had.has(x.pid))
        if (f.length) woke = { pid: f[0].pid, venv: sh(`tr '\\0' '\\n' < /proc/${f[0].pid}/environ | grep -c '^VIRTUAL_ENV='`).trim() === '1', venvOnPath: /\.venv\/bin/.test(sh(`tr '\\0' '\\n' < /proc/${f[0].pid}/environ | sed -n 's/^PATH=//p'`)) }
      }
      const now = await shown(p).catch(() => before)
      const fresh = now.split('\n').filter((l) => l.trim() && !before.includes(l)).join(' / ')
      if (/venv ok|ModuleNotFoundError|No module named|not installed|error|could not|failed/i.test(fresh)) {
        check(`${what}: the page shows what the script printed`, /venv ok/i.test(fresh), { seconds: Math.round((Date.now() - t0) / 1000), shows: fresh.slice(0, 300), reopened: woke ?? 'none new', codexServer: who === 'codex' ? codexServer() : undefined })
        return
      }
      await sleep(1500)
    }
    check(`${what}: the page shows what the script printed`, false, { seconds: 300, reopened: woke ?? 'none new' })
  }
  await go('the conversation open, the environment active', true)
  await settle(who, counts, 120_000, 6000)
  await quitApp(who)
  // Codex's own server outlives /quit and keeps the terminal's environment: stopped too, as a restart would
  if (who === 'codex') sh("pkill -u ana -f 'codex app-server' || true")
  await sleep(30_000)
  await go('the app quit, a reopened turn', false)
}

/**
 * Whether It takes a closed Claude Code conversation for open: Claude Code against a stand-in for
 * its model (no account), a page, an open click; then the app quit with /exit, and later the
 * terminal closed, each watched for five minutes by what It says of Claude Code, what processes
 * are left and what It's log says, with a click thirty seconds after each, timed to its answer.
 */
async function STANDIN() {
  const who = 'claude'
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(6000)
  await startApp(who, counts)
  await ask(who, 'Make a page with one button')
  await settle(who, counts, 120_000, 6000)
  let url = null
  for (let i = 0; i < 30 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/onebutton')) ?? p
    if (p.url().includes('/p/onebutton')) url = p.url()
    else await sleep(2000)
  }
  if (!url) {
    await p.goto('http://localhost:4700/p/onebutton').catch(() => {})
    await sleep(5000)
    url = p.url()
  }
  check('the stand-in made the page', /onebutton/.test(url), { url })
  const seen = async () => (await shown(p).catch(() => '')).match(/Pressed:\s*(.*)/)?.[1]?.trim() ?? ''
  const status = () => {
    try {
      const j = JSON.parse(sh('~/.it/bin/it status --json 2>/dev/null'))
      const h = (j.machine?.harnesses ?? []).find((x) => x.id === 'claude-code')
      return { addon: h?.addon, state: h?.runtime?.state, idle: h?.runtime?.idle, waiting: j.connector?.waiting ?? j.waiting }
    } catch {
      return { unreadable: true }
    }
  }
  let logAt = Number(sh('wc -l < ~/.it/logs/it.log').trim()) || 0
  const newLog = () => {
    const lines = sh(`tail -n +${logAt + 1} ~/.it/logs/it.log`).split('\n').filter(Boolean)
    logAt += lines.length
    // By what each line is about, its first words, and how many: never anything a page carried
    return lines.map((l) => l.replace(/^\S+\s+/, '').replace(/\{.*$/, '{…}').replace(/\([0-9a-f]{6,}\)/g, '(…)').slice(0, 90))
  }
  let n = 0
  let nthPick = 0
  const click = async (what, ms) => {
    await p.goto(url).catch(() => {})
    await sleep(4000)
    const before = await seen()
    const t0 = Date.now()
    const f = await agentFrame(p)
    await f?.locator('#go').click().catch(() => {})
    n++
    step(`${what}: presses the button`, { before, bar: await bar(p) })
    const bars = []
    while (Date.now() - t0 < ms) {
      const b = await bar(p)
      if (b && b !== bars.at(-1)) bars.push(b)
      const now = await seen()
      if (now !== before && /answer/.test(now)) {
        check(`${what}: answered`, true, { seconds: Math.round((Date.now() - t0) / 1000), now, bars: bars.join(' | ') })
        return true
      }
      await sleep(1000)
    }
    check(`${what}: answered`, false, { seconds: Math.round(ms / 1000), bars: bars.join(' | '), status: status() })
    return false
  }
  await click('with the conversation open', 60_000)
  await settle(who, counts, 60_000, 5000)
  const watch = async (how) => {
    const t0 = Date.now()
    let clicked = false
    let answered = null
    let clickAt = null
    while (Date.now() - t0 < 300_000) {
      const at = Math.round((Date.now() - t0) / 1000)
      step(`${how}: ${at} s after`, { status: status(), claudeProcesses: appProcs(who).map((x) => x.args.slice(0, 70)), log: newLog().join(' || ').slice(0, 600), standin: sh('tail -2 /tmp/standin.log').replace(/\n/g, ' | ').slice(0, 200) })
      if (!clicked && at >= Number((process.env.STANDIN_CLICK_AT ?? sh('cat /etc/rehearsal-click-at 2>/dev/null').trim()) || 30)) {
        clicked = true
        clickAt = at
        answered = await click(`${how}: a click ${at} s after`, 240_000)
      }
      await sleep(10_000)
    }
    return { clickAt, answered }
  }
  step('quits Claude Code with /exit')
  await quitApp(who)
  const a = await watch('after /exit')
  // Again open, then the terminal closed with Claude Code in it
  await type('claude --continue')
  await sleep(4000)
  await settle(who, counts, 60_000, 5000)
  await click('the conversation open again', 90_000)
  await settle(who, counts, 60_000, 5000)
  step('closes the terminal with Claude Code open in it')
  sh('tmux kill-server')
  const b = await watch('after the terminal closed')
  step('the two quits', { afterExit: a, afterTerminalClosed: b })
}

/**
 * Pi, OpenCode or Hermes through OpenRouter, played by a script: the app started in the terminal,
 * a page asked for, a click with the app open, then the app quit and a click, with what the page
 * and its bar say. The app's own questions are answered as a willing person would.
 */
async function OTHERAPP() {
  const who = app
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const pair = /https?:\/\/localhost:\d+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  if (pair) await p.goto(pair).catch(() => {})
  await sleep(6000)
  const allow = async () => {
    const s = screen().replace(/\s+$/, '').split('\n').slice(-25).join('\n')
    if (/allow once/i.test(s)) { step(`${who} asks to allow something; allows once`); await key('Enter'); return true }
    if (/\[o\]nce/i.test(s)) { step(`${who} asks to approve a command; once`); await type('o'); return true }
    if (/\(y\/n\)|\[y\/N\]|\[Y\/n\]/i.test(s)) { step(`${who} asks yes or no; yes`); await type('y'); return true }
    return false
  }
  step(`types ${who} in the terminal`)
  await type(who)
  await sleep(15_000)
  const askText = 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.'
  for (let i = 0; i < 3; i++) {
    step(`types to ${who}: a page${i ? ' (again: it had not taken it)' : ''}`)
    await type(askText)
    await sleep(12_000)
    if (screen().includes(askText.slice(0, 30)) || /esc interrupt|Working|Thinking/i.test(screen())) break
  }
  let url = null
  const t0 = Date.now()
  while (Date.now() - t0 < 420_000 && !url) {
    await allow()
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (p.url().includes('/p/') && PIZZA.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  if (!check(`${who} put its page on the screen`, !!url, { seconds: Math.round((Date.now() - t0) / 1000), screen: url ? undefined : screen().replace(/\s+$/, '').split('\n').slice(-12).join(' | ').slice(0, 600) })) return
  const click = async (what, ms) => {
    await p.goto(url).catch(() => {})
    await sleep(5000)
    const before = await shown(p)
    const c0 = Date.now()
    // A different pizza each time, so an answer to this click is not the last one again
    const picked = await press(p, PIZZA, nthPick++ % 3)
    step(`${what}: picks "${picked}"`, { bar: await bar(p) })
    const bars = []
    while (Date.now() - c0 < ms) {
      await allow()
      const b = await bar(p)
      if (b && b !== bars.at(-1)) bars.push(b)
      const fresh = answerLine(before, await shown(p).catch(() => before), picked)
      if (fresh) return check(`${what}: answered on the page`, true, { seconds: Math.round((Date.now() - c0) / 1000), fresh, bars: bars.join(' | ') })
      await sleep(2000)
    }
    return check(`${what}: answered on the page`, false, { seconds: Math.round(ms / 1000), bars: bars.join(' | ').slice(0, 400), site: (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).split('\n').filter((l) => /listen|wake|open its|waiting|sent/i.test(l)).slice(0, 3).join(' / ') })
  }
  await click('the app open', 240_000)
  step(`leaves ${who}`)
  await type('/exit')
  await sleep(3000)
  await key('C-c')
  await sleep(1000)
  await key('C-c')
  await sleep(2000)
  await key('C-d')
  await sleep(5000)
  step('after leaving', { shell: /\$\s*$/.test(screen().replace(/\s+$/, '')), processes: sh(`ps -u ana -o args= | grep -c '${who}'`).trim() })
  await sleep(25_000)
  await click('the app closed', 180_000)
}

/** Asks the host for one of the few things the machine cannot do to itself, and waits until it is done. */
/**
 * Which tool Codex reaches for when asked for a page, with It set up: It, its account's curated
 * Sites plugin, or something else. SITES-<ask>-<variant>: ask is named (the request names It), plain
 * (it does not) or cmd (it says to use the it command); variant is none, off (the Sites plugin turned
 * off in Codex's own config) or skill (a copy of It's skill under ~/.codex/skills whose description
 * names Sites). Each conversation is fresh, in a folder of its own; what Codex ran is read from its
 * session file and from the terminal. SITES_N conversations (default 3).
 */
async function SITES() {
  const [, kind = 'named', variant = 'none'] = scenario.split('-')
  const N = Number(process.env.SITES_N ?? 3)
  const asks = {
    named: 'Make me a page with It where I can pick one of three pizzas',
    plain: 'Make me a page where I can pick one of three pizzas',
    cmd: 'Make me a page where I can pick one of three pizzas. Use the `it` command.',
    website: 'Make me a website where I can pick one of three pizzas',
  }
  const cache = () => sh('ls -la --time-style=full-iso ~/.codex/plugins/cache/openai-curated-remote 2>&1 | grep -E "total|sites|pages|visualize|cannot" ; ls --time-style=full-iso -la ~/.codex/plugins/cache/openai-curated-remote/sites 2>/dev/null | tail -n +4').trim()
  step('before any conversation: the plugin cache', { cache: cache(), skills: sh('ls ~/.codex/skills 2>&1').trim(), auth: sh('ls -la --time-style=full-iso ~/.codex/auth.json | sed "s/^.* ana ana *//"').trim() })
  const listed = () => sh("codex plugin list 2>&1 | grep -E '^(sites|pages|visualize|vercel|canva|openai-templates)@' | sed -E 's/ +/ /g'").trim()
  step("the account's plugins (codex plugin list)", { list: listed(), cacheAfterList: cache() })
  if (variant === 'off') {
    // As a person turns a plugin off: Codex's /plugins screen, the plugin searched for, Tab
    const cfgBefore = sh('cat ~/.codex/config.toml')
    await type('clear && tmux clear-history')
    await startApp('codex', counts)
    await type('/plugins')
    await sleep(6000)
    await type('sites', { enter: false })
    await sleep(3000)
    const found = screen().replace(/\s+$/, '').split('\n').slice(-22).join('\n')
    await key('Tab')
    await sleep(3000)
    const toggled = screen().replace(/\s+$/, '').split('\n').slice(-22).join('\n')
    await key('Escape')
    await sleep(1500)
    await key('Escape')
    await sleep(1500)
    await quitApp('codex')
    const cfgAfter = sh('cat ~/.codex/config.toml')
    step('turns the Sites plugin off on Codex\'s /plugins screen: /plugins, types sites, Tab', { found, toggled, configAdded: cfgAfter.split('\n').filter((l) => !cfgBefore.split('\n').includes(l)).join('\n'), list: listed() })
    await type('clear && tmux clear-history')
    await sleep(1500)
  }
  if (variant === 'skill') {
    const f = `${process.env.HOME}/.codex/skills/it/SKILL.md`
    const was = 'your own built-in artifacts, canvas, widgets or generated sites'
    const now = 'your own built-in artifacts, canvas, widgets or generated sites, and instead of the Sites plugin (Sites, ChatGPT Pages, Visualize)'
    const t = readFileSync(f, 'utf8')
    writeFileSync(f, t.replace(was, now))
    step('changes the copy of It\'s skill under ~/.codex/skills/it/SKILL.md only', { changed: t.includes(was), description: readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('description:'))?.slice(0, 600) })
  }
  const rollouts = () => sh('find ~/.codex/sessions -name "rollout-*.jsonl" 2>/dev/null').trim().split('\n').filter(Boolean)
  const tally = { it: 0, sites: 0, other: 0, both: 0 }
  for (let i = 1; i <= N; i++) {
    const had = new Set(rollouts())
    await type(`mkdir ~/w${i}; cd ~/w${i} && clear && tmux clear-history`)
    await sleep(2000)
    await startApp('codex', counts)
    await ask('codex', asks[kind])
    await settle('codex', counts, 540_000, 10_000)
    const term = sh('tmux capture-pane -p -J -S -20000 -t agent')
    await quitApp('codex')
    const f = rollouts().find((x) => !had.has(x))
    let calls = []
    if (f) {
      for (const l of readFileSync(f, 'utf8').split('\n')) {
        try {
          const j = JSON.parse(l)
          const pl = j.payload ?? {}
          if (/call/.test(pl.type ?? '') && !/output/.test(pl.type ?? '')) calls.push({ name: pl.name ?? pl.type, args: String(pl.arguments ?? pl.input ?? JSON.stringify(pl.invocation ?? '')).slice(0, 300) })
        } catch {}
      }
    }
    const all = `${term}\n${calls.map((c) => `${c.name} ${c.args}`).join('\n')}`
    const usedIt = /(^|[\s'"`/(;&])it (create|show|open|patch|site|status|list|ack|say|notify|update|page|pages)\b|\.it\/bin\/it\b/m.test(all)
    const usedSites = /openai-curated-remote\/sites|skills\/sites|SITES_MANAGED|Sites publishing|sites-env/i.test(all)
    const nonShell = [...new Set(calls.map((c) => c.name).filter((n) => !/exec_command|^shell|apply_patch|update_plan|write_stdin|view_image/.test(n)))]
    const which = usedIt && usedSites ? 'both' : usedIt ? 'it' : usedSites ? 'sites' : 'other'
    tally[which]++
    step(`conversation ${i}: ${which}`, { ask: asks[kind], usedIt, usedSites, toolsOtherThanShell: nonShell.join(', '), session: f ? f.split('/').pop() : 'no session file', commands: calls.filter((c) => /exec|shell/.test(c.name)).map((c) => c.args.replace(/\s+/g, ' ').slice(0, 140)).slice(0, 12), said: term.replace(/\s+$/, '').split('\n').filter((l) => l.trim()).slice(-8).join(' | ').slice(0, 600) })
  }
  step('tally', { variant, ask: kind, ...tally })
  verdict.ok = true
  verdict.reason = `SITES ${kind}/${variant}: It ${tally.it}, Sites ${tally.sites}, both ${tally.both}, other ${tally.other} of ${N}`
}

async function hostDoes(what, ms = 2400_000) {
  sh('rm -f /var/lib/rehearsal-flow/host-done')
  writeFileSync('/var/lib/rehearsal-flow/host-now', what)
  const t0 = Date.now()
  while (Date.now() - t0 < ms && sh('cat /var/lib/rehearsal-flow/host-done 2>/dev/null').trim() === '') await sleep(2000)
  return sh('cat /var/lib/rehearsal-flow/host-done 2>/dev/null').trim()
}
const siteSays = async (p) => (await p.mainFrame().evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)

/**
 * Things going wrong, with Codex and no person: a pairing link opened after it expired; It stopped
 * by hand and a click; no internet and a click; the laptop asleep half an hour (the machine paused
 * by the host); the machine's address changed with a second screen paired; It uninstalled and
 * installed again.
 */
async function MISC() {
  const who = app
  const ctx = (browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')).contexts()[0]
  let p = ctx.pages().find((x) => !x.url().startsWith('devtools')) ?? (await ctx.newPage())
  const link = () => /https?:\/\/[^\s"']+\/pair#[A-Za-z0-9]+/.exec(sh('~/.it/bin/it site --no-open 2>&1'))?.[0]
  // a. A pairing link opened after its ten minutes
  const old = link()
  step('a. a pairing link from it site, opened eleven minutes later')
  await sleep(660_000)
  await p.goto(old).catch(() => {})
  await sleep(6000)
  step('a. what the expired link shows', { shows: await siteSays(p) })
  await p.goto(link()).catch(() => {})
  await sleep(6000)
  step('a. a fresh link', { shows: (await siteSays(p)).slice(0, 160) })
  // A page and an open click
  await startApp(who, counts)
  await ask(who, 'Make me a page with It where I can pick one of three pizzas, and tell me on the page what you would order with it.')
  await settle(who, counts, 600_000, 8000)
  let url = null
  for (let i = 0; i < 40 && !url; i++) {
    p = ctx.pages().find((x) => x.url().includes('/p/')) ?? p
    if (p.url().includes('/p/') && PIZZA.test(await shown(p).catch(() => ''))) url = p.url()
    else await sleep(3000)
  }
  if (!check('the page is on the screen', !!url)) return
  let k = 0
  const click = async (what, ms, quiet = 60_000) => {
    await p.goto(url).catch(() => {})
    await sleep(5000)
    const before = await shown(p).catch(() => '')
    const c0 = Date.now()
    const picked = await press(p, PIZZA, k++ % 3)
    step(`${what}: picks "${picked}"`, { bar: await bar(p) })
    const bars = []
    let saidAtQuiet = null
    while (Date.now() - c0 < ms) {
      await answerApp(who, counts).catch(() => {})
      const b = await bar(p)
      if (b && b !== bars.at(-1)) bars.push(b)
      if (!saidAtQuiet && Date.now() - c0 > quiet) saidAtQuiet = { bar: b, site: (await siteSays(p)).slice(0, 300) }
      const fresh = answerLine(before, await shown(p).catch(() => before), picked)
      if (fresh) return check(`${what}: answered on the page`, true, { seconds: Math.round((Date.now() - c0) / 1000), fresh: fresh.slice(0, 150), bars: bars.join(' | ') })
      await sleep(2000)
    }
    return check(`${what}: answered on the page`, false, { seconds: Math.round(ms / 1000), bars: bars.join(' | ').slice(0, 400), atOneMinute: saidAtQuiet })
  }
  await click('the conversation open', 180_000)
  await settle(who, counts, 60_000, 6000)
  // b. It stopped by hand, a click, and It started again a minute later
  sh('systemctl --user stop it.service')
  step('b. It stopped by hand')
  const pb = click('b. a click while It is stopped (It started again after 70 s)', 240_000)
  await sleep(75_000)
  sh('systemctl --user start it.service')
  await pb
  await settle(who, counts, 60_000, 6000)
  // c. No internet: the machine off every network, a click, then back on
  step('c. the machine off every network', { host: await hostDoes('offline') })
  const pc = click('c. a click with no internet (back on the network after 2 min)', 360_000, 90_000)
  await sleep(120_000)
  step('c. back on the network', { host: await hostDoes('online') })
  await pc
  await settle(who, counts, 60_000, 6000)
  // d. The laptop asleep for half an hour (the host pauses the whole machine), then a click
  step('d. the laptop asleep for thirty minutes')
  const slept = await hostDoes('pause:1800')
  step('d. awake again', { host: slept, itAnswers: sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4700/').trim(), bar: await bar(p) })
  await click('d. a click after the sleep', 240_000)
  // e. A second screen paired at the network address, then the machine's address changes
  step('e. it network on', { said: sh('~/.it/bin/it network on 2>&1 | tail -4').replace(/\s+/g, ' ').slice(0, 300) })
  sh('setsid -f env DISPLAY=:1 /opt/ms-playwright/chromium-1228/chrome-linux64/chrome --user-data-dir=/opt/person-profile/screen2 --no-sandbox --test-type --no-first-run --no-default-browser-check --password-store=basic --remote-debugging-port=9223 --window-position=1300,300 --window-size=600,700 about:blank >/dev/null 2>&1')
  await sleep(6000)
  const b2 = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const p2 = b2.contexts()[0].pages()[0] ?? (await b2.contexts()[0].newPage())
  const netLink = link()
  step('e. the pairing link for the network', { link: (netLink ?? '').replace(/#.*/, '#…') })
  if (netLink) await p2.goto(netLink).catch(() => {})
  await sleep(8000)
  await p2.goto(url.replace('localhost', new URL(netLink ?? 'http://x').hostname)).catch(() => {})
  await sleep(6000)
  step('e. the second screen shows the page', { shows: (await shown(p2).catch(() => '')).slice(0, 120) })
  step('e. the machine moves to another network', { host: await hostDoes('newaddress') })
  await sleep(10_000)
  await p2.reload().catch(() => {})
  await sleep(10_000)
  step('e. the second screen after the move', { url: p2.url().replace(/#.*/, ''), shows: (await siteSays(p2)).slice(0, 300), itNetwork: sh('~/.it/bin/it network 2>&1 | tail -4').replace(/\s+/g, ' ').slice(0, 300) })
  await b2.close().catch(() => {})
  // f. Uninstalled, then installed again from the site
  await quitApp(who)
  step('f. it uninstall', { said: sh('printf "y\\n" | ~/.it/bin/it uninstall --yes 2>&1 | tail -6').replace(/\s+/g, ' ').slice(0, 400) })
  await p.goto(url).catch(() => {})
  await sleep(6000)
  step('f. the old page after the uninstall', { shows: (await siteSays(p)).slice(0, 200) })
  step('f. installed again', { said: sh('curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh 2>&1 | tail -2; ~/.it/bin/it setup --only codex 2>&1 | tail -2').replace(/\s+/g, ' ').slice(0, 400) })
  await p.goto(url).catch(() => {})
  await sleep(8000)
  step('f. the old page after installing again', { shows: (await siteSays(p)).slice(0, 200), pages: sh('~/.it/bin/it list 2>&1 | head -5').replace(/\s+/g, ' ').slice(0, 200) })
}

async function main() {
  try {
    if (scenario === 'S4') await S4()
    else if (scenario === 'S6') await S6()
    else if (scenario === 'S7') await S7()
    else if (scenario === 'SOAK') await SOAK()
    else if (scenario === 'SOAK2') await SOAK2()
    else if (scenario === 'WAKE') await WAKE()
    else if (scenario === 'WAKEBOOT1') await WAKEBOOT1()
    else if (scenario === 'WAKELITE') await WAKELITE()
    else if (scenario === 'RESTARTCLICK') await RESTARTCLICK()
    else if (scenario === 'VENV') await VENV()
    else if (scenario === 'STANDIN') await STANDIN()
    else if (scenario === 'OTHERAPP') await OTHERAPP()
    else if (scenario.startsWith('SITES')) await SITES()
    else if (scenario === 'MISC') await MISC()
    else if (scenario === 'WAKEBOOT2') await WAKEBOOT2()
    else check(`no scenario ${scenario}`, false)
    const failed = verdict.checks.filter((c) => !c.ok)
    verdict.ok = failed.length === 0 && verdict.checks.length > 0
    if (!verdict.ok) verdict.reason = `does not hold: ${failed.map((c) => c.what).join('; ')}`
  } catch (err) {
    verdict.reason = `the script threw: ${String(err?.stack ?? err).slice(0, 400)}`
    verdict.blame = 'harness'
  } finally {
    saveTerminal()
    writeFileSync(`${dir}/flow.json`, `${JSON.stringify(verdict, null, 2)}\n`)
    await browser?.close().catch(() => {})
  }
}
await main()
process.exit(0)
