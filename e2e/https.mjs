// It over https, as it answers its tailnet with `it https on`: Tailscale's own server on the
// machine takes https at the machine's name, two ports above each of the door's, and hands every
// request to the door on this machine over plain http. Here a stand-in does the handing on
// (e2e/tailscale.mjs), since a runner is on no tailnet, and the settings of the stack's It are
// given the name as `it https on` writes it. So the listener itself is asked, as the program
// under test runs it, with what Tailscale sends it: which is what the standalone program people
// install got wrong while every test that calls the door's own function passed. It needs the
// stack running (node e2e/stack.mjs), and leaves its settings as it found them.
//
//   node e2e/https.mjs
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { needsStack, STACK_LOGS, sleep } from './lib.mjs'
import { printCleanly, verdict } from './logs.mjs'
import { askThrough, standInTailscale } from './tailscale.mjs'

printCleanly()
const at = needsStack('The check of It over https')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(verdict(name, ok, detail, 300))
}

/** The machine's name on its tailnet, as far as this run goes: a name of the shape Tailscale gives, that no machine has. */
const NAME = 'e2e-laptop.tail-e2e.ts.net'
/** Two above each of the door's ports is where Tailscale takes https for it (`httpsPort`, packages/protocol). */
const HTTPS = 2
const site = { door: at.port, https: at.port + HTTPS }
const pages = { door: at.port + 1, https: at.port + 1 + HTTPS }

// ---------- the settings ----------

// The settings hold the keys It runs its backend with. They are read and written whole and
// never printed, and written as It writes them: under another name first, kept to their owner.
const settings = path.join(at.home, 'service.json')
const kept = () => JSON.parse(readFileSync(settings, 'utf8'))
const keep = (said) => {
  const whole = `${settings}.${process.pid}.tmp`
  writeFileSync(whole, JSON.stringify(said, null, 1), { mode: 0o600 })
  renameSync(whole, settings)
  chmodSync(settings, 0o600)
}
/** Writes the name It answers at over https, or that it answers at none, as `it https on` and `it https off` do. */
const noteHttps = (name) => {
  const { https: _, ...rest } = kept()
  keep({ ...rest, ...(name ? { https: name } : {}) })
}
// The service looks at its settings every second and opens its door anew for a name that
// changed, and says so in its log. How often it has said it is counted from the start of this
// check, so that what an earlier one left in the log is not taken for this one's.
const log = path.join(STACK_LOGS, 'service.log')
const said = (line) => (existsSync(log) ? readFileSync(log, 'utf8').split(line).length - 1 : 0)
const TAKEN = 'door: answers its tailnet over https too, through Tailscale'
const DROPPED = 'door: answers over https no more'
async function until(fn, ms = 20_000, every = 200) {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
  }
}

// ---------- the checks ----------

const standIns = []
const before = { taken: said(TAKEN), dropped: said(DROPPED) }
let wrote = false
try {
  // At the ports Tailscale itself would take, on this machine alone
  const front = await standInTailscale({ door: site.door, listen: site.https })
  standIns.push(front)
  const frontOfPages = await standInTailscale({ door: pages.door, listen: pages.https })
  standIns.push(frontOfPages)
  const host = `${NAME}:${site.https}`
  const origin = `https://${host}`

  // Before the settings say so, a request that claims to have come over https is one sent to a
  // name this machine does not answer to, and is turned away
  const unasked = await askThrough(front.port, host, '/')
  check('before the settings name it, the door answers nothing at the tailnet’s https name', unasked.status === 421, `status ${unasked.status}`)

  noteHttps(NAME)
  wrote = true
  const taken = await until(() => said(TAKEN) > before.taken)
  check('the service takes the name from its settings, and opens its door anew for it', taken, `not said in ${log} within twenty seconds`)
  // The door is opened a moment after it is said that it will be
  await until(async () => (await askThrough(site.door, `localhost:${site.door}`, '/')).status === 200)

  const home = await askThrough(front.port, host, '/')
  check(
    'the site loads over https, through Tailscale',
    home.status === 200 && /^text\/html/.test(home.type) && /<script/.test(home.body),
    `status ${home.status}, ${home.type || 'of no type'}: ${home.body.slice(0, 120)}`,
  )
  const script = /<script[^>]+src="([^"]+)"/.exec(home.body)?.[1]
  const asked = script ? await askThrough(front.port, host, script) : undefined
  check('and so does the script it asks for', asked?.status === 200, asked ? `status ${asked.status}` : 'the site names no script')

  // The pages' port, at its own https port. No page is shown here, so the address is no
  // showing's, and the answer that says so is the content service's own: the door took the
  // request as sent to a place it answers at, and handed it on
  const noPage = await askThrough(frontOfPages.port, `${NAME}:${pages.https}`, `/s/${'x'.repeat(43)}/index.html`)
  check(
    'the pages’ port hands a page’s address to the part that shows pages, over https too',
    noPage.status !== 400 && noPage.status < 500,
    `status ${noPage.status}: ${noPage.body.slice(0, 120)}`,
  )

  // The live connection, as a browser on the site opens it: from the site's own https address
  const require = createRequire(import.meta.url)
  const client = require('convex/package.json').version
  const live = await askThrough(front.port, host, `/api/${client}/sync`, {
    origin,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': Buffer.from('e2e-over-https--').toString('base64'),
  })
  check('the live connection opens over https', live.status === 101, `status ${live.status}: ${live.body.slice(0, 120)}`)
  // And is still refused to a page of some other site, which is the door's doing and not Tailscale's
  const stranger = await askThrough(front.port, host, `/api/${client}/sync`, {
    origin: 'https://elsewhere.example',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': Buffer.from('e2e-over-https--').toString('base64'),
  })
  check('and not for a page of another site', stranger.status === 403, `status ${stranger.status}`)

  // Not through Tailscale, the same name is one this machine does not answer to
  const direct = await askThrough(site.door, host, '/')
  check('a request that did not come through Tailscale is not taken for one that did', direct.status === 421, `status ${direct.status}`)
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  // The settings are left as they were found, and the door as it was opened before
  if (wrote) {
    try {
      noteHttps(undefined)
      const dropped = await until(() => said(DROPPED) > before.dropped)
      check('the settings are left as they were, and the door answers over https no more', dropped, `not said in ${log} within twenty seconds`)
      await until(async () => (await askThrough(site.door, `localhost:${site.door}`, '/')).status === 200)
    } catch (err) {
      check(`the settings were left as they were (${err.message})`, false, err.stack)
    }
  }
  for (const standIn of standIns) await standIn.stop()
}
console.log(`\n${results.filter(Boolean).length} of ${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
