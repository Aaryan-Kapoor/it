// The scenarios a script plays the person in, inside the container as ana, on a machine where It
// is already set up (a snapshot of scenario 1). The browser is the machine's own, reached over its
// debugging port; the agent app runs in the terminal, typed into through tmux.
//
//   node scripted.mjs <S4|S6|S7a|S7b> <app> <run folder>
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { answerApp, busy, quitApp, settle, startApp } from './agent.mjs'
import { saveTerminal, screen, setRunDir, sleep, step, type } from './lib.mjs'

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
async function page() {
  browser ??= await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const pages = ctx.pages().filter((p) => !p.url().startsWith('devtools'))
  return pages.find((p) => p.url().includes('localhost:4700')) ?? pages.at(-1) ?? (await ctx.newPage())
}

/** The text of every frame of the tab, which holds the agent's page inside the site. */
async function shown(p) {
  const parts = []
  for (const f of p.frames()) {
    try {
      parts.push(await f.evaluate(() => document.body?.innerText ?? ''))
    } catch {}
  }
  return parts.join('\n')
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
  return one.t.split('\n')[0].slice(0, 60)
}

/** Waits until the page shows words it did not show before, for up to `ms`. */
async function answered(p, before, ms, what) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    await answerApp(app, counts).catch(() => {})
    const now = await shown(p).catch(() => before)
    if (now !== before && now.length > 0) {
      const fresh = now.split('\n').filter((l) => l.trim() && !before.includes(l)).join(' / ').slice(0, 300)
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
  await agentWorks('Make me a page where I can pick one of three pizzas, and tell me on the page what you would order with it.')
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

async function main() {
  try {
    if (scenario === 'S4') await S4()
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
