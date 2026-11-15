// For building the person's side of the tour: the stage with no agent and no recording, the
// tour's first page shown by hand, and a control port on 127.0.0.1 that runs a snippet of code
// with `page` (the person's browser), `it` (the run's It) and `term` in scope.
//
//   node e2e/rehearsal/explore.mjs [--port 5640] [--control 5698]
import http from 'node:http'
import { leftIn, profileEnv, runFolders, sleep } from './lib.mjs'
import { install, it, personBrowser, serve, setup, terminalView, terminalWindow } from './stage.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const port = Number(arg('port', 5640))
const control = Number(arg('control', 5698))
const id = `explore-${Date.now()}`
const f = runFolders(id)
const env = profileEnv(f, { port, appBin: null })
const log = (name, seen, ok = true) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${String(seen).slice(0, 400)}`)
const term = await terminalView({ port: control + 1, title: 'explore' })
const tw = await terminalWindow({ term, profile: f.viewProfile })
const ins = await install({ env, cwd: f.home, base: 'http://127.0.0.1:5690', term, log })
await setup({ program: ins.program, env, cwd: f.work, app: 'codex', term, log })
const served = await serve({ program: ins.program, env, cwd: f.work, logFile: `${f.logs}\\serve.log`, log })
const site = await it(ins.program, ['site', '--no-open'], { env, cwd: f.work })
log('site', site.out)
const { context, page } = await personBrowser({ channel: 'msedge', profile: f.browserProfile })
await page.goto(site.json?.url)
const runIt = (argv, opts = {}) => it(ins.program, argv, { env, cwd: f.work, ...opts })
http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    try {
      const fn = new Function('page', 'it', 'term', 'context', 'sleep', 'f', `return (async () => { ${body} })()`)
      const out = await fn(page, runIt, term, context, sleep, f)
      res.end(typeof out === 'string' ? out : JSON.stringify(out, null, 1))
    } catch (e) {
      res.end(`ERROR ${e.stack}`)
    }
    if (body.trim() === 'STOP') {
      await context.close()
      await tw.context.close()
      await served.stop()
      console.log('left', JSON.stringify(leftIn(f.top)))
      process.exit(0)
    }
  })
  .listen(control, '127.0.0.1', () => console.log(`control on ${control}; run folder ${f.top}`))
