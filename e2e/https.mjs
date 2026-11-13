// It over https, as it answers its tailnet with `it https on`: Tailscale's own server on the
// machine takes https at the machine's name, two ports above each of the door's, and hands every
// request to the door on this machine over plain http. Here a stand-in does the handing on
// (e2e/tailscale.mjs), since a runner is on no tailnet, and the settings of the stack's It are
// given the name as `it https on` writes it. So the listener itself is asked, as the program
// under test runs it, with what Tailscale sends it: which is what the standalone program people
// install got wrong while every test that calls the door's own function passed.
//
// The site, the pages' port and the live connection are asked for as a program asks, and then
// a browser is paired at the https address and shown a page there. For the browser the stand-in
// takes https itself, with a certificate made for the run by `openssl`, which must be there.
// It needs the stack running (node e2e/stack.mjs), and leaves its settings as it found them.
//
//   node e2e/https.mjs
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { it, needsStack, PRIVATE_MARK, STACK_LOGS, sleep } from './lib.mjs'
import { printCleanly, verdict } from './logs.mjs'
import { ownerAddress, paired } from './site.mjs'
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

/**
 * A key and a certificate for a name, made for this run and signed by nobody: the browser here
 * is told to pass that over, as it is told nothing else. They are read and the files removed.
 */
function selfSigned(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-e2e-tls-'))
  try {
    const [key, cert] = ['key.pem', 'cert.pem'].map((file) => path.join(dir, file))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${name}`], {
      stdio: 'ignore',
    })
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- the checks ----------

const standIns = []
let browser
let fixture
let slug
let cameraSlug
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

  // ---------- in a browser ----------

  // A browser is given the site over https only by something that takes https, so the stand-ins
  // are started again at the same ports, taking it. The browser is told that the machine's name
  // on the tailnet is this machine, and to pass over who signed the certificate.
  for (const standIn of standIns.splice(0)) await standIn.stop()
  const tls = selfSigned(NAME)
  standIns.push(await standInTailscale({ door: site.door, listen: site.https, tls }))
  standIns.push(await standInTailscale({ door: pages.door, listen: pages.https, tls }))
  const SHOWN = 'shown over https'
  fixture = mkdtempSync(path.join(os.tmpdir(), 'it-e2e-https-page-'))
  writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Over https</title><p id="over-https">${SHOWN}</p>`)
  const made = await it(at.home, ['create', `Over https ${PRIVATE_MARK}page`, '--id', `over-https-${Date.now().toString(36)}`, '--dir', fixture])
  slug = made.id
  // A camera and a microphone of the browser's own making, and a browser that lets the site use
  // them as a person who allows it would: It's own question still stands between a page and them
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const tab = await context.newPage()
  // The address `it site` prints pairs the owner's browser, and is opened here at the https place
  const pairing = new URL(await ownerAddress({ home: at.home }))
  await tab.goto(`${origin}${pairing.pathname}${pairing.search}${pairing.hash}`)
  const isPaired = await until(() => paired(tab), 30_000)
  check(
    'a browser that opens the site over https is paired there, which the live connection tells it',
    isPaired,
    await tab
      .locator('body')
      .innerText()
      .catch((err) => err.message),
  )
  await tab.goto(`${origin}/p/${slug}`)
  const showings = `https://${NAME}:${pages.https}/s/`
  let got = 'the site had put no frame there'
  const shown = await until(async () => {
    if ((await tab.locator('.mount iframe[data-shown="true"]').count()) !== 1) return undefined
    got = `the site called its frame shown, and none was at ${showings}`
    const frame = tab.frames().find((f) => f.url().startsWith(showings))
    if (!frame) return undefined
    got = 'a frame was at a showing’s https address, and the page was not in it'
    return (await frame.locator('#over-https').innerText({ timeout: 2000 })) === SHOWN
  }, 30_000)
  check('a page shows there, in a frame at the pages’ own https address', shown, got)

  // What a person does from a phone on their tailnet: a page asks for the camera live, which a
  // browser gives a site only at a secure address, and It asks in its bar before the page has it
  const camera = await it(at.home, [
    'create',
    `Camera over https ${PRIVATE_MARK}page`,
    '--id',
    `camera-over-https-${Date.now().toString(36)}`,
    '--dir',
    path.join(import.meta.dirname, 'fixtures', 'recorder'),
  ])
  cameraSlug = camera.id
  await tab.goto(`${origin}/p/${cameraSlug}`)
  const inPage = tab.frameLocator('.mount iframe')
  await inPage.locator('#live').click({ timeout: 30_000 })
  const question = tab.locator('.media-ask')
  const cameraAsked = await question.waitFor({ timeout: 15_000 }).then(
    () => question.textContent(),
    () => '',
  )
  if (cameraAsked) await question.getByRole('button', { name: 'Allow', exact: true }).click()
  const liveSaid = await inPage
    .locator('#out')
    .filter({ hasText: /^(live|refused)/ })
    .waitFor({ timeout: 15_000 })
    .then(
      () => inPage.locator('#out').textContent(),
      () => 'the page said nothing',
    )
  const pictures = await until(async () => {
    const seen = await inPage
      .locator('#view')
      .evaluate((v) => ({ width: v.videoWidth, pictures: Number(document.getElementById('frames').textContent) }))
      .catch(() => undefined)
    return seen && seen.width > 0 && seen.pictures > 5 ? seen : undefined
  }, 20_000)
  check(
    'over https, a page asks for the camera live, It asks the person in its bar, and once allowed the page is given the camera’s pictures',
    /see the camera’s picture live/.test(cameraAsked ?? '') && liveSaid === 'live' && pictures !== undefined,
    JSON.stringify({ asked: Boolean(cameraAsked), liveSaid, pictures }),
  )

  // And the microphone live, and the camera with sound, which a browser gives a site only at a secure address too
  const pageSaid = () => inPage.locator('#out').textContent()
  const saysWithin = (pattern) =>
    inPage
      .locator('#out')
      .filter({ hasText: pattern })
      .waitFor({ timeout: 15_000 })
      .then(pageSaid, () => pageSaid())
  const counted = (id) =>
    inPage
      .locator(`#${id}`)
      .textContent()
      .then(Number)
      .catch(() => 0)
  await inPage.locator('#close').click()
  await saysWithin(/^camera stopped/)
  await inPage.locator('#mic').click()
  const micAsked = await question.waitFor({ timeout: 15_000 }).then(
    () => question.textContent(),
    () => '',
  )
  if (micAsked) await question.getByRole('button', { name: 'Allow', exact: true }).click()
  const hearingSaid = await saysWithin(/^(hearing|refused)/)
  const pieces = await until(async () => ((n) => (n > 25 ? n : undefined))(await counted('pieces')), 20_000)
  check(
    'over https, a page asks for the microphone live, It asks the person in its bar, and once allowed the page is given its sound',
    /hear the microphone live/.test(micAsked ?? '') && /^hearing \d+$/.test(hearingSaid ?? '') && pieces !== undefined,
    JSON.stringify({ asked: Boolean(micAsked), hearingSaid, pieces }),
  )
  await inPage.locator('#quiet').click()
  await saysWithin(/^microphone stopped/)
  await inPage.locator('#call').click()
  const callSaid = await saysWithin(/^(live with sound|refused)/)
  const inStream = await until(async () => ((n) => (n > 0.001 ? n : undefined))(await counted('stream')), 20_000)
  check(
    'over https, a camera opened with sound gives the page a stream with the camera’s picture and the microphone’s sound, with nothing more asked',
    callSaid === 'live with sound, 1 sound tracks' && inStream !== undefined && (await question.count()) === 0,
    JSON.stringify({ callSaid, inStream }),
  )
  await inPage.locator('#close').click()
  await saysWithin(/^camera stopped/)
  // The microphone ends as soon as the page's frame loads another document
  const micChip = tab.locator('.page-nav .media-mic')
  await inPage.locator('#mic').click()
  const againSaid = await saysWithin(/^(hearing|refused)/)
  const chipThere = await micChip.count()
  await inPage.locator('#elsewhere').click()
  const chipGone = await until(async () => (await micChip.count()) === 0 || undefined, 1500, 50)
  check(
    'over https, the microphone live to a page ends as soon as its frame loads another document',
    /^hearing \d+$/.test(againSaid ?? '') && chipThere === 1 && chipGone === true,
    JSON.stringify({ againSaid, chipThere, chipGone: Boolean(chipGone) }),
  )
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  await browser?.close().catch(() => {})
  if (slug) await it(at.home, ['delete', slug]).catch(() => {})
  if (cameraSlug) await it(at.home, ['delete', cameraSlug]).catch(() => {})
  if (fixture) rmSync(fixture, { recursive: true, force: true })
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
