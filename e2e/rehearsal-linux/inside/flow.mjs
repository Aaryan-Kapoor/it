// One rehearsal flow, run inside the container as ana: the person at the terminal and the browser.
//
//   node flow.mjs <flow> <app> <browser> <run folder>
//
// It writes each step to steps.jsonl and its verdict to flow.json in the run folder. The host's
// run.mjs has started the container, the terminal, the recording and the sign-in before this.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { answerApp, busy, decide, links, quitApp, settle, since, startApp } from './agent.mjs'
import { openBrowser } from './browser.mjs'
import { history, key, saveTerminal, screen, setRunDir, sleep, step, type } from './lib.mjs'
import { followTour, tourFrame } from './tour.mjs'

const [flow, app, which, dir] = process.argv.slice(2)
setRunDir(dir)
const IT = '/home/ana/.it/bin/it'
const counts = { approvals: 0, nudges: 0, replies: 0, restarts: 0 }
const verdict = { flow, app, browser: which, ok: false, reason: null, blame: null, parts: {}, counts }
let browser = null

function finish() {
  verdict.counts = counts
  writeFileSync(`${dir}/flow.json`, `${JSON.stringify(verdict, null, 2)}\n`)
}
function fail(reason, blame) {
  verdict.ok = false
  verdict.reason ??= reason
  verdict.blame ??= blame
  step(`fails: ${reason}`, { blame }, false)
}
const appName = app === 'claude' ? 'Claude Code' : 'Codex'
const itRun = (...a) => {
  try {
    return execFileSync(IT, a, { encoding: 'utf8', cwd: '/home/ana/work', timeout: 60_000 })
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}

async function browserOpen() {
  if (!browser) {
    step(`opens ${which === 'firefox' ? 'Firefox' : 'Chromium'}`)
    browser = await openBrowser(which, { fake: flow === 'L6' })
  }
  return browser
}

/** The person types to the agent, and the agent's next words are read from after that. */
let lastTyped = ''
async function say(text) {
  lastTyped = text
  counts.replies++
  step(`types to ${appName}: "${text}"`)
  await type(text)
}

/** Keeps answering the app's own questions in the background while the person is in the browser. */
function watchTerminal() {
  let on = true
  let running = false
  const timer = setInterval(async () => {
    if (!on || running) return
    running = true
    try {
      await answerApp(app, counts)
    } catch {}
    running = false
  }, 1500)
  return () => {
    on = false
    clearInterval(timer)
  }
}

/**
 * The conversation that installs It: the person reads what the agent says whenever it is still,
 * answers its questions, opens the link it gives, presses what it says to press, and restarts the
 * app where it says to, until the tour's first page is on the screen.
 */
async function untilTour(minutes = 30) {
  const until = Date.now() + minutes * 60_000
  const opened = new Set()
  let lastSeen = ''
  let still = Date.now()
  let handled = ''
  let idleSince = null
  while (Date.now() < until) {
    const did = await answerApp(app, counts)
    if (did === 'login') {
      fail(`${appName} is not signed in`, 'harness')
      return null
    }
    if (browser) {
      const frame = await tourFrame(browser.page, 500)
      if (frame) return frame
      // The site's first screen, with the button the agent waits on
      const take = browser.page.getByRole('button', { name: /Take the tour/i })
      if (
        (await take.isVisible().catch(() => false)) &&
        /Take the tour/i.test(since(lastTyped) + history().slice(-3000))
      ) {
        await sleep(2000)
        step('presses "Take the tour" on the page, as the agent said to')
        await take.click().catch(() => {})
        await sleep(3000)
        continue
      }
    }
    const s = screen()
    if (did || s !== lastSeen || busy()) {
      lastSeen = s
      still = Date.now()
      idleSince = null
      await sleep(800)
      continue
    }
    if (Date.now() - still < 6000) {
      await sleep(800)
      continue
    }
    // The agent is still: read what it said since the person last typed
    const fresh = since(lastTyped)
    if (fresh === handled) {
      idleSince ??= Date.now()
      if (Date.now() - idleSince > 240_000) {
        if (counts.nudges >= 2) {
          fail('the agent stopped with nothing for the person to do, twice', 'model')
          return null
        }
        counts.nudges++
        step('nothing has happened for four minutes, and the agent said nothing to do', { lastWords: fresh.slice(-600) }, false)
        await say('What should I do now?')
        idleSince = null
      }
      await sleep(1000)
      continue
    }
    handled = fresh
    idleSince = Date.now()
    const urls = links(fresh).filter((u) => !opened.has(u))
    const pair = urls.find((u) => /\/pair#/.test(u)) ?? urls.find((u) => /\/p\//.test(u)) ?? urls[0]
    if (pair) {
      opened.add(pair)
      const { page } = await browserOpen()
      await sleep(1500)
      step('opens the link the agent gave', { url: pair.replace(/#.*/, '#…') })
      await page.goto(pair).catch((e) => step('the link did not open', { error: String(e.message).slice(0, 200) }, false))
      await sleep(4000)
      continue
    }
    const d = decide(app, fresh)
    if (!d) continue
    step(`reads what ${appName} said`, { why: d.why, words: fresh.slice(-500) })
    if (d.restart) {
      counts.restarts++
      await sleep(2000)
      await quitApp(app)
      await sleep(2000)
      const r = await startApp(app, counts)
      if (r === 'login') {
        fail(`${appName} is not signed in after the restart`, 'harness')
        return null
      }
      if (d.then) await say(d.then)
      continue
    }
    if (d.type) {
      await sleep(2000)
      await say(d.type)
    }
  }
  fail(`the tour was not on the screen after ${minutes} minutes`, 'model')
  return null
}

async function L1() {
  const r = await startApp(app, counts)
  if (r === 'login') return fail(`${appName} is not signed in`, 'harness')
  await sleep(2000)
  await say('Install It for me. The instructions are at https://itcan.do/install.md')
  const frame = await untilTour()
  if (!frame) return
  step('the tour is on the screen')
  const stop = watchTerminal()
  const before = counts.approvals
  verdict.parts = await followTour(browser.page, frame)
  stop()
  verdict.approvalsDuringTour = counts.approvals - before
  // The agent's last words, once it is still
  await settle(app, counts, 180_000, 8000)
  verdict.lastWords = since(lastTyped).slice(-1500)
  const failed = Object.values(verdict.parts).flat().filter((s) => s && s.ok === false)
  if (Object.keys(verdict.parts).length < 7) fail(`only ${Object.keys(verdict.parts).length} of the seven parts were reached`, 'model')
  else if (failed.length) fail(`${failed.length} step(s) of the tour were not answered: ${failed.map((s) => s.name).join('; ')}`, 'model')
  else if (counts.nudges) fail('the person had to ask what to do', 'model')
  else verdict.ok = true
}

async function main() {
  try {
    if (flow === 'L1') await L1()
    else fail(`no flow ${flow}`, 'harness')
  } catch (err) {
    fail(`the harness threw: ${String(err?.stack ?? err).slice(0, 500)}`, 'harness')
  } finally {
    saveTerminal()
    finish()
    if (browser) await browser.context.close().catch(() => {})
  }
}
await main()
process.exit(0)
