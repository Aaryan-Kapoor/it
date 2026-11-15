// A stand-in for It's releases on GitHub that serves the build under test, laid out as GitHub
// lays out a repository's releases, as e2e/releases.mjs does for a published release:
//
//   node e2e/rehearsal/releases.mjs --folder <build> --tag <v0.1.41> --port <port>
//
// `latest/download/<file>` and `download/<tag>/<file>` are the files of the folder, which holds
// a build of It's programs with `SHA256SUMS` beside them. Any other tag is fetched from It's
// real releases on GitHub as it is asked for and passed on unchanged, so that an older
// published release can be installed from the same place and upgraded from. Given this
// address as IT_INSTALL_BASE, the real install script and `it upgrade` install the build.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const TAG = /^v[0-9A-Za-z._-]+$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const folder = arg('folder')
const tag = arg('tag')
const port = Number(arg('port'))
if (!folder || !existsSync(folder) || !tag || !TAG.test(tag) || !Number.isInteger(port)) {
  console.error('Usage: node e2e/rehearsal/releases.mjs --folder <build> --tag <tag> --port <port>')
  process.exit(2)
}
// The checksums, as a release publishes them, written where the build has none
const sums = path.join(folder, 'SHA256SUMS')
if (!existsSync(sums))
  writeFileSync(
    sums,
    readdirSync(folder)
      .filter((f) => f !== 'SHA256SUMS' && statSync(path.join(folder, f)).isFile())
      .sort()
      .map((f) => `${createHash('sha256').update(readFileSync(path.join(folder, f))).digest('hex')}  ${f}\n`)
      .join(''),
  )
const GITHUB = 'https://github.com/Aaryan-Kapoor/it/releases/download'

http
  .createServer(async (req, res) => {
    const parts = new URL(req.url ?? '/', 'http://stand-in').pathname.split('/').filter(Boolean)
    const [asked, file] =
      parts.length === 3 && parts[0] === 'latest' && parts[1] === 'download'
        ? [tag, parts[2]]
        : parts.length === 3 && parts[0] === 'download'
          ? [parts[1], parts[2]]
          : []
    if (req.method !== 'GET' || !asked || !TAG.test(asked) || !file || !FILE.test(file)) return void res.writeHead(404).end()
    if (asked === tag) {
      const at = path.join(folder, file)
      if (!existsSync(at)) {
        console.log(`${asked}/${file}: not in the build`)
        return void res.writeHead(404).end()
      }
      const bytes = readFileSync(at)
      console.log(`${asked}/${file}: ${bytes.length} bytes, from the build under test`)
      return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes)
    }
    try {
      const answer = await fetch(`${GITHUB}/${asked}/${file}`)
      if (!answer.ok) {
        console.log(`${asked}/${file}: GitHub answered ${answer.status}`)
        return void res.writeHead(answer.status === 404 ? 404 : 502).end()
      }
      const bytes = Buffer.from(await answer.arrayBuffer())
      console.log(`${asked}/${file}: ${bytes.length} bytes, as GitHub publishes it`)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes)
    } catch (err) {
      console.log(`${asked}/${file}: not fetched (${err?.cause?.code ?? err?.name ?? 'error'})`)
      res.writeHead(502).end()
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Releases are answered at http://127.0.0.1:${port}, with ${tag} from ${folder}.`))
