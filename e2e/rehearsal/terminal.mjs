// The agent app's terminal, as a person has one: the app runs in a pseudo console the harness
// holds (pty.py), the harness types into it as a person would, and what it shows is drawn in a
// window of its own by xterm.js, so that the screen recording shows the terminal as it is.
// What the console showed is kept, raw, for the run's transcript.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Where xterm.js and ws are installed for the rehearsal, outside the repository. */
const NODE_MODULES = process.env.IT_REHEARSAL_NODE_MODULES || 'D:\\it-rehearsal\\work\\node\\node_modules'
const require = createRequire(path.join(NODE_MODULES, 'x.js'))
const { WebSocketServer } = require('ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const page = (title, cols, rows, fontSize) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/xterm.css"><style>
html,body{margin:0;height:100%;background:#0c0c0c;color:#ddd;font-family:Segoe UI,sans-serif;overflow:hidden}
#bar{height:34px;line-height:34px;padding:0 14px;font-size:17px;background:#1f1f1f;color:#e8e8e8;border-bottom:1px solid #333;white-space:nowrap;overflow:hidden}
#bar b{color:#7fd7a8;font-weight:600}#t{padding:6px 8px}
</style></head><body><div id="bar"><b>Terminal</b> &nbsp;${title}</div><div id="t"></div>
<script src="/xterm.js"></script><script src="/links.js"></script><script>
const term = new Terminal({cols:${cols},rows:${rows},fontSize:${fontSize},fontFamily:'Cascadia Mono, Consolas, monospace',scrollback:5000,convertEol:false,theme:{background:'#0c0c0c'}});
term.open(document.getElementById('t')); window.term = term;
window.screenText = () => { const b = term.buffer.active; const out = []; for (let i = 0; i < term.rows; i++) { const l = b.getLine(b.viewportY + i); out.push(l ? l.translateToString(true) : '') } return out.join('\\n') };
const ws = new WebSocket('ws://' + location.host + '/io'); ws.binaryType = 'arraybuffer';
ws.onmessage = (e) => term.write(new Uint8Array(e.data));
// What the person types goes to the program, as in any terminal window
// The view's own replies to a program's questions about the terminal (its colours, its kind) are
// not sent: the pseudo console answers those itself, and a second answer arrives as typed text
const reply = /^(\\x1b(\\][0-9]+;[^\\x07\\x1b]*(\\x07|\\x1b\\\\)?|\\[\\?[0-9;]*c|\\[>[0-9;]*c|\\[[0-9]+;[0-9]+R))+$/;
term.onData((d) => !reply.test(d) && ws.readyState === 1 && ws.send(JSON.stringify({ keys: d })));
// A link clicked in the terminal opens in the browser, as a terminal opens the default browser
term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => ws.readyState === 1 && ws.send(JSON.stringify({ open: uri }))));
term.focus();
</script></body></html>`

/**
 * A terminal view on 127.0.0.1:`port`, and a program in a pseudo console behind it. `open`
 * starts the program; `type` types; `screen` reads what the view shows now, through `view`,
 * the browser page that shows it.
 */
export async function terminalView({ port, title, cols = 104, rows = 50, fontSize = 20 }) {
  const xtermDir = path.join(NODE_MODULES, '@xterm', 'xterm')
  let raw = Buffer.alloc(0)
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(title, cols, rows, fontSize))
    if (req.url === '/xterm.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(path.join(xtermDir, 'lib', 'xterm.js')))
    if (req.url === '/xterm.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(path.join(xtermDir, 'css', 'xterm.css')))
    if (req.url === '/blank') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>New tab</title><body style="background:#fff"></body>')
    if (req.url === '/links.js')
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(path.join(NODE_MODULES, '@xterm', 'addon-web-links', 'lib', 'addon-web-links.js')))
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/io') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      // A view that opens late is shown everything from the beginning
      if (raw.length) ws.send(raw)
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (m) => {
        let said
        try {
          said = JSON.parse(String(m))
        } catch {
          return
        }
        if (typeof said.keys === 'string' && child) child.stdin.write(said.keys)
        if (typeof said.open === 'string' && /^https?:\/\//.test(said.open)) t.onOpen?.(said.open)
      })
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const show = (buf) => {
    raw = Buffer.concat([raw, buf])
    for (const ws of sockets) ws.send(buf)
  }
  let child = null
  let view = null
  const t = {
    url: `http://127.0.0.1:${port}/`,
    cols,
    rows,
    /** Draws a line of the harness's own in the terminal, dimmed, so that a viewer sees what was run before the agent. */
    note(text) {
      show(Buffer.from(`\x1b[90m${text.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`))
    },
    /** Shows what a program printed, as it is. */
    echo(text) {
      show(Buffer.from(String(text).replace(/\r?\n/g, '\r\n')))
    },
    attach(page) {
      view = page
    },
    open(argv, { env, cwd, python = 'python' }) {
      child = spawn(python, ['-I', path.join(here, 'pty.py'), String(cols), String(rows), ...argv], {
        env: { ...env, IT_REHEARSAL_PYPATH: process.env.IT_REHEARSAL_PYPATH || 'D:\\it-rehearsal\\work\\py' },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout.on('data', show)
      child.stderr.on('data', show)
      return child
    },
    /** Uses a terminal held elsewhere (agent-host.py, as another account), reached by `socket`, in place of `open`. */
    useSocket(socket) {
      let open = true
      socket.on('data', show)
      socket.on('close', () => (open = false))
      socket.on('error', () => (open = false))
      child = {
        stdin: { write: (d) => open && socket.write(d) },
        get exitCode() {
          return open ? null : 0
        },
        signalCode: null,
        pid: null,
        socket,
      }
      return child
    },
    get child() {
      return child
    },
    alive: () => child && child.exitCode === null && child.signalCode === null,
    raw: () => raw,
    /** Types text as a person would, a few characters at a time. */
    async type(text, { perChunk = 6, delay = 25 } = {}) {
      for (let i = 0; i < text.length; i += perChunk) {
        child.stdin.write(text.slice(i, i + perChunk))
        await sleep(delay)
      }
    },
    key(name) {
      const keys = { enter: '\r', down: '\x1b[B', up: '\x1b[A', esc: '\x1b', tab: '\t', ctrlc: '\x03', ctrld: '\x04', space: ' ' }
      child.stdin.write(keys[name] ?? name)
    },
    /** What the terminal shows now, line by line, as the view draws it. */
    async screen() {
      if (!view) return ''
      try {
        return await view.evaluate(() => window.screenText())
      } catch {
        return ''
      }
    },
    /** Waits until the screen matches, and resolves with whether it did. */
    async until(pattern, ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (pattern.test(await t.screen())) return true
        if (child && !t.alive()) return pattern.test(await t.screen())
        await sleep(400)
      }
      return false
    },
    async close() {
      for (const ws of sockets) ws.terminate()
      await new Promise((r) => server.close(r))
    },
  }
  return t
}
