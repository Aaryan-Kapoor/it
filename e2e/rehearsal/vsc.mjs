// Drives the throwaway VS Code that arun.mjs started (`vscode` on its control port) over its
// debugging port, for a test of an agent's VS Code extension panel, step by step:
//   node e2e/rehearsal/vsc.mjs [--port 5700] run <command title>   F1, the title, Enter
//   node e2e/rehearsal/vsc.mjs text [chars]       the panel's text (its last chars)
//   node e2e/rehearsal/vsc.mjs send <text>        typed into the panel's message box, then Enter
//   node e2e/rehearsal/vsc.mjs typeonly <text>    typed into the panel's message box, no Enter
//   node e2e/rehearsal/vsc.mjs key <key>          a key to the window (Playwright's names)
//   node e2e/rehearsal/vsc.mjs shot <file.png>    a picture of the window
//   node e2e/rehearsal/vsc.mjs frames             the window's frames (their addresses' start)
//   node e2e/rehearsal/vsc.mjs workbench [chars]  the window's own text outside the panel
// What it prints has the account's name masked.
import os from 'node:os'
import { chromium } from 'playwright'

const argv = process.argv.slice(2)
let port = 5700
if (argv[0] === '--port') {
  port = Number(argv[1])
  argv.splice(0, 2)
}
const [cmd, ...rest] = argv
const a = rest.join(' ')
const user = os.userInfo().username
const mask = (s) => String(s).split(user).join('<account>')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = browser.contexts().flatMap((c) => c.pages())
const page = pages.find((p) => /workbench/.test(p.url())) ?? pages[0]
// The panel: the extension's webview is a target of its own (an out-of-process frame), reached
// over the raw debugging protocol; its content is in the frame inside it
async function panel() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  for (const t of list.filter((t) => t.type === 'iframe' && /^vscode-webview:/.test(t.url))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let n = 0
    const waiting = new Map()
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id) } }
    const call = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
    const DOC = `(() => { const f = document.querySelector('iframe'); try { return f && f.contentDocument ? f.contentDocument : document } catch { return document } })()`
    const evaluate = async (expr) => (await call('Runtime.evaluate', { expression: `(() => { const doc = ${DOC}; return (${expr}) })()`, returnByValue: true }))?.result?.value
    // only a panel the person can see: a hidden side bar keeps its webview alive
    const has = await evaluate(`!!doc.querySelector('[contenteditable], textarea') && document.visibilityState === 'visible' && doc.body.getBoundingClientRect().width > 0`)
    if (has) return { call, evaluate, close: () => ws.close() }
    ws.close()
  }
  return null
}
let out = ''
if (cmd === 'run') {
  await page.bringToFront()
  await page.keyboard.press('F1')
  await page.waitForTimeout(500)
  await page.keyboard.type(a)
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  out = 'done'
} else if (cmd === 'text') {
  const p = await panel()
  out = p ? String(await p.evaluate('doc.body.innerText')).slice(-Number(rest[0] ?? 1500)) : 'no panel'
} else if (cmd === 'send' || cmd === 'typeonly') {
  const p = await panel()
  if (!p) out = 'no panel'
  else {
    await p.evaluate(`(() => { const b = doc.querySelector('[contenteditable], textarea'); b.focus(); return 1 })()`)
    await p.call('Input.insertText', { text: a })
    if (cmd === 'send') {
      await new Promise((r) => setTimeout(r, 300))
      for (const type of ['rawKeyDown', 'char', 'keyUp']) await p.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'char' ? String.fromCharCode(13) : undefined })
    }
    out = 'typed'
  }
} else if (cmd === 'key') {
  await page.keyboard.press(a)
  out = 'pressed'
} else if (cmd === 'shot') {
  await page.screenshot({ path: a })
  out = a
} else if (cmd === 'click') {
  // click <text>: the first visible element with that text, in the window or any frame
  out = 'not found'
  for (const fr of page.frames()) {
    const el = fr.getByText(a, { exact: false }).first()
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {})
      out = 'clicked'
      break
    }
  }
} else if (cmd === 'xy') {
  // xy <x> <y>: a click at that point of the window
  await page.mouse.click(Number(rest[0]), Number(rest[1]))
  out = 'clicked'
} else if (cmd === 'frames') {
  out = page.frames().map((fr) => fr.url().slice(0, 120)).join('\n')
} else if (cmd === 'workbench') {
  out = (await page.evaluate(() => document.body.innerText)).slice(-Number(rest[0] ?? 1500))
}
console.log(mask(out).slice(0, 4000))

process.exit(0)
