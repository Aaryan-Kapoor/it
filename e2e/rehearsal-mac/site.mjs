// A stand-in for https://itcan.do on a rented rehearsal Mac, so that the line a person pastes,
// `curl -fsSL https://itcan.do/install.sh | sh`, runs the install script of the build under test
// and not the published one. prepare.sh points itcan.do at 127.0.0.1 in /etc/hosts and adds a
// throwaway certificate authority, made for this Mac alone, to /etc/ssl/cert.pem, which macOS's
// curl trusts. /install.sh is answered from the build; every other path is passed on unchanged to
// the real itcan.do, so the live guide and the rest of the site are what a participant gets.
//
//   sudo node site.mjs <install.sh> <key.pem> <cert.pem> <real address>
import https from 'node:https'
import { readFileSync } from 'node:fs'

const [script, key, cert, real] = process.argv.slice(2)
const body = readFileSync(script)
https
  .createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = new URL(req.url ?? '/', 'https://itcan.do').pathname
    if (path === '/install.sh') {
      console.log(`${new Date().toISOString()} 200 /install.sh from the build (${body.length} bytes)`)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length })
      return void res.end(req.method === 'HEAD' ? undefined : body)
    }
    const up = https.request({ host: real, servername: 'itcan.do', port: 443, method: req.method, path: req.url, headers: { ...req.headers, host: 'itcan.do' } }, (r) => {
      console.log(`${new Date().toISOString()} ${r.statusCode} ${req.url} passed on`)
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  .listen(443, '127.0.0.1', () => console.log('itcan.do stand-in on 127.0.0.1:443'))
