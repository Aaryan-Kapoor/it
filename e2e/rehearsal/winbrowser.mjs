// A browser on Windows for a test of an It that runs elsewhere (in WSL): Edge with a throwaway
// profile, held open, driven over a control port like arun.mjs's (ctl.mjs --control <port>):
// goto <url or page id>, click <selector, in any frame>, pagetext (the page and its frames), stop.
//   node e2e/rehearsal/winbrowser.mjs --profile <folder> --site http://localhost:5640 --control 5698
import http from 'node:http'
import { chromium } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const site = arg('site', 'http://localhost:5640')
const ctx = await chromium.launchPersistentContext(arg('profile'), { channel: 'msedge', headless: false, viewport: null, args: ['--no-first-run', '--no-default-browser-check'] })
const page = ctx.pages()[0] ?? (await ctx.newPage())
let stopping = false
http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const q = JSON.parse(body || '{}')
  try {
    if (q.cmd === 'goto') {
      const url = /^https?:/.test(q.page) ? q.page : `${site}/p/${q.page}`
      const r = await page.goto(url, { timeout: 20000 }).catch((e) => ({ status: () => `error ${e.message.split('\n')[0]}` }))
      return res.end(`status ${r?.status?.() ?? '?'}`)
    }
    if (q.cmd === 'click') {
      for (const fr of page.frames()) {
        const el = await fr.$(q.selector).catch(() => null)
        if (el) { await el.click().catch(() => {}); return res.end('clicked') }
      }
      return res.end('not found')
    }
    if (q.cmd === 'pagetext') {
      const parts = []
      for (const fr of page.frames()) parts.push(await fr.evaluate(() => document.body?.innerText ?? '').catch(() => ''))
      return res.end(parts.join('\n--frame--\n'))
    }
    if (q.cmd === 'screen') return res.end(page.url())
    if (q.cmd === 'stop') { stopping = true; res.end('stopping'); await ctx.close(); process.exit(0) }
    res.end('?')
  } catch (e) { res.end(`error ${e.message}`) }
}).listen(Number(arg('control', 5698)), '127.0.0.1')
console.log('browser ready')
