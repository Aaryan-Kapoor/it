// A stand-in for Tailscale's own server on a machine (`tailscale serve`), as It uses it with
// `it https on`: it takes a request and hands it to the door on this machine, over plain http,
// saying that it came over https. Tailscale takes https there, and this takes it only where it is
// given a key and a certificate, which a browser needs and a program that asks does not: what the
// door is handed is the same either way, and the door is what the checks that use this are about.
//
// What it hands on is what Tailscale hands on. The request as it was asked, at the path it was
// asked for, with the Host it was sent to, which is the machine's name on its tailnet and the
// https port; and three headers it writes itself whatever the caller sent: that the request came
// over https, the address on the tailnet it came from, and the Host again.
import http from 'node:http'
import https from 'node:https'

/** An address on a tailnet, of the kind Tailscale gives a machine: where the stand-in says each request came from. */
export const TAILNET_CALLER = '100.64.0.7'

/** What the stand-in writes into a request it hands on, in place of anything the caller said of the same. */
const handedOn = (headers) => ({
  ...headers,
  'x-forwarded-proto': 'https',
  'x-forwarded-for': TAILNET_CALLER,
  'x-forwarded-host': headers.host ?? '',
})

/** The first lines of an answer, as they are written to a connection that is being taken over. */
const head = (res) => {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`]
  for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Starts the stand-in on this machine alone, at `listen`, handing everything to the door at
 * `door`, which is a port on this machine too. Resolves with the port it listens on and a way
 * to stop it, and rejects where it cannot listen there. Given a key and a certificate (`tls`),
 * it takes https itself, as Tailscale does, which is what a browser needs of it: the site it is
 * given over https says so in its policy and its cookies. What the door is handed is the same.
 */
export function standInTailscale({ door, listen = 0, tls }) {
  const to = { host: '127.0.0.1', port: door }
  const open = new Set()
  const server = (tls ? https.createServer.bind(https, tls) : http.createServer)((req, res) => {
    const on = http.request({ ...to, method: req.method, path: req.url, headers: handedOn(req.headers) }, (answer) => {
      res.writeHead(answer.statusCode, answer.statusMessage, answer.rawHeaders)
      answer.pipe(res)
    })
    on.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(on)
  })
  // A connection that asks to become something else, which is how the live connection begins:
  // the door's answer is written back as it came, and the two are joined from then on
  server.on('upgrade', (req, socket, first) => {
    const on = http.request({ ...to, method: req.method, path: req.url, headers: handedOn(req.headers) })
    on.on('upgrade', (answer, onward, begun) => {
      socket.write(head(answer))
      if (begun.length) socket.write(begun)
      if (first.length) onward.write(first)
      open.add(onward)
      onward.on('close', () => open.delete(onward))
      onward.on('error', () => socket.destroy())
      socket.on('error', () => onward.destroy())
      onward.pipe(socket)
      socket.pipe(onward)
    })
    // The door answered, and did not take the connection over: its answer is the caller's
    on.on('response', (answer) => {
      socket.write(head(answer))
      answer.pipe(socket)
    })
    on.on('error', () => socket.destroy())
    on.end()
  })
  server.on('connection', (socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listen, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        stop: () =>
          new Promise((done) => {
            for (const socket of open) socket.destroy()
            server.close(() => done())
          }),
      }),
    )
  })
}

/**
 * Asks something of the stand-in as a browser on the tailnet asks it of Tailscale: at the
 * machine's name and https port, which is what `host` says, whatever port the stand-in itself
 * listens on. Resolves with the status and the body, and for a connection the other end took
 * over, with 101 and nothing more; the connection is closed then.
 */
export function askThrough(port, host, path, headers = {}, ms = 10_000) {
  return new Promise((resolve, reject) => {
    // A connection of its own each time: one that was asked to become something else is not asked anything after
    const req = http.request({ host: '127.0.0.1', port, path, headers: { ...headers, host }, timeout: ms, agent: false })
    req.on('response', (res) => {
      const parts = []
      res.on('data', (part) => parts.push(part))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(parts).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode, type: '', body: '' })
    })
    req.on('timeout', () => req.destroy(new Error(`no answer within ${ms / 1000} s`)))
    req.on('error', reject)
    req.end()
  })
}
