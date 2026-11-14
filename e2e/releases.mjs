// A stand-in for It's releases on GitHub that says a release of our choosing is the newest, for
// the check of an upgrade in `.github/workflows/published.yml`. `it upgrade` puts in place
// whichever release GitHub marks Latest, and a pre-release is never marked so. Given this
// stand-in's address as IT_INSTALL_BASE, an It upgrades to the release named here instead.
//
//   node e2e/releases.mjs --newest <tag> --port <port>
//
// It listens on 127.0.0.1 alone, at the port given, and is laid out as GitHub lays out a
// repository's releases: `latest/download/<file>` is the file of the release named newest, and
// `download/<tag>/<file>` the file of that release. Every file it answers with is fetched from
// It's real releases on GitHub as it is asked for, whole, and passed on unchanged, so what the
// upgrade downloads and checks against the published checksums is what GitHub publishes. Which
// release is the newest is the one thing it stands in for. Anything else is answered 404.
import http from 'node:http'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const TAG = /^v[0-9A-Za-z._-]+$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const newest = arg('newest')
const port = Number(arg('port'))
if (!newest || !TAG.test(newest) || !Number.isInteger(port) || port <= 0) {
  console.error('Usage: node e2e/releases.mjs --newest <tag> --port <port>')
  process.exit(2)
}
const GITHUB = 'https://github.com/Aaryan-Kapoor/it/releases/download'

http
  .createServer(async (req, res) => {
    const parts = new URL(req.url ?? '/', 'http://stand-in').pathname.split('/').filter(Boolean)
    const [tag, file] =
      parts.length === 3 && parts[0] === 'latest' && parts[1] === 'download'
        ? [newest, parts[2]]
        : parts.length === 3 && parts[0] === 'download'
          ? [parts[1], parts[2]]
          : []
    if (req.method !== 'GET' || !tag || !TAG.test(tag) || !file || !FILE.test(file)) return void res.writeHead(404).end()
    try {
      const answer = await fetch(`${GITHUB}/${tag}/${file}`)
      if (!answer.ok) {
        console.log(`${tag}/${file}: GitHub answered ${answer.status}`)
        return void res.writeHead(answer.status === 404 ? 404 : 502).end()
      }
      const bytes = Buffer.from(await answer.arrayBuffer())
      console.log(`${tag}/${file}: ${bytes.length} bytes, as GitHub publishes it`)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes)
    } catch (err) {
      console.log(`${tag}/${file}: not fetched (${err?.cause?.code ?? err?.name ?? 'error'})`)
      res.writeHead(502).end()
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Releases are answered at http://127.0.0.1:${port}, with ${newest} as the newest.`))
