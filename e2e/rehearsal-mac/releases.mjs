// A stand-in for It's releases on GitHub, on a rented rehearsal Mac, that serves the build
// under test as every release: `latest/download/<file>` and `download/<any tag>/<file>` are both
// the file of that name from the build's folder. So the real install script, which a release
// pins to its own tag, and `it upgrade`, which reads `latest.json`, both get the build under test
// when IT_INSTALL_BASE names this stand-in. It listens on 127.0.0.1 alone, as the install script
// requires of a base that is not https.
//
//   node releases.mjs <folder> <port>
import http from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'

const [folder, portText] = process.argv.slice(2)
const port = Number(portText)
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TAG = /^v[0-9A-Za-z._-]+$/
http
  .createServer((req, res) => {
    const parts = new URL(req.url ?? '/', 'http://stand-in').pathname.split('/').filter(Boolean)
    const file =
      parts.length === 3 && parts[0] === 'latest' && parts[1] === 'download'
        ? parts[2]
        : parts.length === 3 && parts[0] === 'download' && TAG.test(parts[1])
          ? parts[2]
          : null
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !file || !FILE.test(file)) {
      console.log(`${new Date().toISOString()} 404 ${req.method} ${req.url}`)
      return void res.writeHead(404).end()
    }
    let size
    try {
      size = statSync(join(folder, file)).size
    } catch {
      console.log(`${new Date().toISOString()} 404 ${req.url}`)
      return void res.writeHead(404).end()
    }
    console.log(`${new Date().toISOString()} 200 ${req.url} ${size}`)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(join(folder, file)).pipe(res)
  })
  .listen(port, '127.0.0.1', () => console.log(`Releases from ${folder} at http://127.0.0.1:${port}`))
