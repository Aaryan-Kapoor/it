// What It meets in a T3 Code that speaks another version of T3 Code's protocol than It does,
// made from the real server: everything It asks is passed on to the real server unchanged but for
// the version it is asked in, which is put one above the version It names. So whatever T3 Code
// does with a version it does not speak, which today is to refuse it, is what It is answered.
//
// Over HTTP the version is the header `x-t3-orchestration-protocol`, and on T3 Code's socket the
// query's `orchestrationProtocol`. Nothing else of a request or an answer is read or changed.
import http from 'node:http'
import net from 'node:net'

/** The version one above the one asked for, as text; anything that is not a version is passed on as it is. */
const above = (version) => (/^\d+$/.test(version) ? String(Number(version) + 1) : version)

/**
 * Listens on `port` of this machine and passes everything on to `origin`, the real server, asked
 * in the version above the one It names. Resolves with its address, what it has passed on with how the
 * real server answered each, and a way to stop it.
 */
export function otherProtocol(origin, port) {
  const target = new URL(origin)
  const asked = []
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host }
    const given = req.headers['x-t3-orchestration-protocol']
    if (typeof given === 'string') headers['x-t3-orchestration-protocol'] = above(given)
    // What was asked, and how the real server answered it: its status, or that it could not be reached
    const one = { method: req.method, path: req.url.split('?')[0], given: given ?? null, passed: headers['x-t3-orchestration-protocol'] ?? null, status: null }
    asked.push(one)
    const out = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (answer) => {
      one.status = answer.statusCode ?? null
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    out.on('error', () => {
      one.status = 'unreachable'
      res.writeHead(502)
      res.end()
    })
    req.pipe(out)
  })
  // The socket: the request that opens it is written out again with the version changed, and from
  // then on what each side sends is passed to the other as it is
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin)
    const given = url.searchParams.get('orchestrationProtocol')
    if (given !== null) url.searchParams.set('orchestrationProtocol', above(given))
    const one = { method: 'socket', path: url.pathname, given, passed: url.searchParams.get('orchestrationProtocol'), status: null }
    asked.push(one)
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i].toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      // How the real server answered the opening of the socket: the status of its first line
      upstream.once('data', (chunk) => {
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString('latin1'))?.[1]
        one.status = status ? Number(status) : 'unreadable'
      })
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const end = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', () => {
      one.status ??= 'unreachable'
      end()
    })
    socket.on('error', end)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${port}`,
        asked,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      }),
    )
  })
}
