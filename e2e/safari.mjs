// Safari itself, on the It a stack runs (e2e/stack.mjs): the Safari of the Mac this runs on, or
// the one in an iOS Simulator, each driven through safaridriver, which speaks WebDriver and which
// Playwright cannot drive. The browser is paired as the owner's with the address `it site`
// prints, a page is opened, and it is held to rendering in its frame with It's script in it. Its
// button is then pressed as a person presses it, and the action is to be accepted, and to be one
// that It holds for the page.
//
//   node e2e/safari.mjs [--simulator <udid>] [--driver <address>] [--out <folder>] [--tries <n>] [--within <seconds>]
//
// safaridriver must be enabled first (`sudo safaridriver --enable`) and listening, at
// http://127.0.0.1:4444 unless --driver says otherwise. With --simulator, the simulator must be
// booted. Each try pairs a new session; the run passes when one of them passes, and says how
// many did not. A screenshot of each try is written to --out.
//
// The whole check is over within --within seconds, 900 unless it says otherwise. Every request
// to the driver has a deadline of its own that covers its whole answer (e2e/webdriver.mjs), and
// none is given more than is left of that time, less what is kept for the end of each try: the
// screenshot and the session's end are each given a short deadline of their own from that. Each
// run of the command (the page's making, the pairing address, the actions It holds) is held to
// what is left in the same way, and the command is ended by its process id once that is spent.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { needsStack, sleep, within } from './lib.mjs'
import { printCleanly, redact } from './logs.mjs'
import { ownerAddress } from './site.mjs'
import { webdriver } from './webdriver.mjs'

printCleanly()
const STACK = needsStack('The Safari check')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const DRIVER = arg('driver', 'http://127.0.0.1:4444')
const SIMULATOR = arg('simulator', null)
const OUT = arg('out', null)
const TRIES = Number(arg('tries', '2'))
/** When the check is to be over, and how long before it the end of a try is kept for. */
const OVER = Date.now() + Number(arg('within', '900')) * 1000
const KEPT_FOR_THE_END = 45_000
/** What is left for anything but the end of a try, at most `ms`. */
const left = (ms) => Math.min(ms, OVER - KEPT_FOR_THE_END - Date.now())
const WHICH = SIMULATOR ? 'the iOS Simulator’s Safari' : 'Safari'
if (OUT) mkdirSync(OUT, { recursive: true })

/** The W3C name an element is given under, in what a driver answers. */
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'
const CAPS = SIMULATOR ? { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': SIMULATOR } : { browserName: 'safari' }

// The page makes a word of its own each time it is shown, and sends it with its action: the
// action It holds is then the one this try's press sent, and not one from an earlier try
const PAGE = 'safari-check'
const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="font:24px sans-serif;padding:16px">
<h1 id="ready">loading</h1><p id="word"></p>
<button id="press" style="font-size:32px;padding:20px">Press</button>
<script>
const word = Math.random().toString(36).slice(2, 12)
document.getElementById('word').textContent = word
document.getElementById('ready').textContent = typeof window.It === 'object' ? 'rendered' : 'no It'
document.getElementById('press').addEventListener('click', () => {
  document.body.dataset.sent = 'sending'
  It.action('pressed', { word }).then(() => { document.body.dataset.sent = 'yes' }, (e) => { document.body.dataset.sent = 'refused: ' + e.message })
})
</script></body></html>`

const ask = webdriver(DRIVER)
/** A request to the driver, given `ms` or what is left of the check's time, whichever is less. */
const driver = (method, url, body, ms = 30_000) => ask(method, url, body, { ms: left(ms) })
/** The command, run as `it` is (e2e/lib.mjs), and ended by its process id once it has had `ms` or what is left of the check's time. */
const cli = (home, args, opts, ms = 30_000) => within(left(ms))(home, args, opts)

/** One try: a session of its own, paired afresh. Resolves with what it saw, and throws with where it stopped. */
async function attempt(n) {
  const begun = Date.now()
  const at = () => `${((Date.now() - begun) / 1000).toFixed(1)}s`
  const said = (what) => console.log(`  [${at()}] ${what}`)
  let session
  let paired = false
  // The simulator's Safari is not always found at the first ask just after the simulator has
  // booted: it has taken as many as three, each of which safaridriver gives up on after half a minute
  for (let asked = 1; !session; asked++) {
    try {
      session = await driver('POST', '/session', { capabilities: { alwaysMatch: CAPS } }, 60_000)
    } catch (e) {
      if (asked === 5 || left(10_000) < 10_000) throw e
      said(`no session yet (${e.message.slice(0, 160)}), asking again`)
      await sleep(10_000)
    }
  }
  const s = (p) => `/session/${session.sessionId}${p}`
  const run = (script, ms) => driver('POST', s('/execute/sync'), { script, args: [] }, ms)
  // Each ask is given no more than what is left of the wait, so the wait is over when it says
  const until = async (what, script, ms) => {
    const end = Date.now() + ms
    let last
    while (Date.now() < end && left(ms) > 0) {
      // What the script gives back once it holds, and an error's words while it cannot yet be run
      last = await run(script, Math.min(10_000, end - Date.now())).catch((e) => e.message)
      if (last && typeof last !== 'string') return last
      await sleep(500)
    }
    throw new Error(`${what}, not within ${ms / 1000} s (last: ${JSON.stringify(last)?.slice(0, 200)})`)
  }
  try {
    said(`${session.capabilities.browserName} ${session.capabilities.browserVersion} on ${session.capabilities.platformName}`)
    await driver('POST', s('/url'), { url: await ownerAddress({ run: cli }) })
    await until('the browser was not shown the site as a paired one', "return !!document.querySelector('header.bar')", 90_000)
    said('paired')
    paired = true
    await driver('POST', s('/url'), { url: `${STACK.site}/p/${PAGE}` })
    await until('the page’s frame was not put on the site', "return !!document.querySelector('iframe')", 30_000)
    const frame = await driver('POST', s('/element'), { using: 'css selector', value: 'iframe' })
    await driver('POST', s('/frame'), { id: frame })
    const shown = await until(
      'the page did not render in its frame with It’s script',
      "const b = document.getElementById('press')?.getBoundingClientRect(); return document.getElementById('ready')?.textContent === 'rendered' && b && b.width > 0 ? { word: document.getElementById('word').textContent } : null",
      30_000,
    )
    said('rendered, with It’s script')
    // WebDriver's own click, as a person's click on a Mac, and on iOS as a tap. On the simulator
    // it has more often than not arrived as a long press, which selects the button's text and is
    // no click, and so has a short tap with a finger made through WebDriver's actions. So on the
    // simulator, where neither is heard, the button's own click() is called from a script: that
    // runs the page's handler and It's action as a press would, though no finger made it, and the
    // run says so. On a Mac the click is to be heard, and nothing stands in for it.
    const press = await driver('POST', s('/element'), { using: 'css selector', value: '#press' })
    await driver('POST', s(`/element/${press[ELEMENT]}/click`), {})
    const heard = async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(500)
        if ((await run('return document.body.dataset.sent || null').catch(() => null)) !== null) return true
      }
      return false
    }
    let pressedBy = 'WebDriver’s click'
    if (!(await heard()) && SIMULATOR) {
      said('the click was not heard, so the button is tapped')
      pressedBy = 'a tap'
      const finger = [
        { type: 'pointerMove', duration: 0, origin: press, x: 0, y: 0 },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ]
      await driver('POST', s('/actions'), { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: finger }] })
      await driver('DELETE', s('/actions')).catch(() => {})
      if (!(await heard())) {
        said('the tap was not heard either, so the button’s click() is called from a script')
        pressedBy = 'a script'
        await run("document.getElementById('press').click(); return true")
      }
    }
    const sent = await until('the page’s action was not answered', "const v = document.body.dataset.sent; return v && v !== 'sending' ? { v } : null", 30_000)
    if (sent.v !== 'yes') throw new Error(`the page’s action was ${sent.v}`)
    said(`pressed by ${pressedBy}, and the action was accepted`)
    const held = await cli(STACK.home, ['actions', '--id', PAGE])
    if (!JSON.stringify(held).includes(shown.word)) throw new Error('It holds no action for the page with the word this press sent')
    said('It holds the action')
    await driver('POST', s('/frame/parent'), {})
    return { seconds: (Date.now() - begun) / 1000, pressedBy }
  } finally {
    // Only once the browser is paired: before then its address bar may still hold the code
    // Each has a short deadline of its own, from the time kept for the end of a try, so that a
    // driver that stalls here holds up neither the session's end nor what the try says
    if (OUT && paired)
      await ask('GET', s('/screenshot'), undefined, { ms: 15_000 })
        .then((png) => writeFileSync(path.join(OUT, `${SIMULATOR ? 'simulator' : 'safari'}-${n}.png`), Buffer.from(png, 'base64')))
        .catch((e) => said(`no screenshot: ${e.message}`))
    await ask('DELETE', s(''), undefined, { ms: 15_000 }).catch((e) => said(`the session did not end: ${e.message}`))
  }
}

// The page, made afresh, or put back as it is here where an earlier run left it
// A command that ran out of time is said as such, and not hidden behind an update with none left
await cli(STACK.home, ['create', 'Safari check', '--id', PAGE, '--html', HTML]).catch((e) =>
  /no answer within|no time was left/.test(e.message) ? Promise.reject(e) : cli(STACK.home, ['update', PAGE, '--html', HTML]),
)
let passed = 0
const faults = []
for (let n = 1; n <= TRIES && left(60_000) >= 60_000; n++) {
  console.log(`${WHICH}, try ${n} of ${TRIES}`)
  try {
    const got = await attempt(n)
    passed++
    console.log(`  passed in ${got.seconds.toFixed(1)} s`)
    if (got.pressedBy === 'a script')
      console.log(
        `::warning::${WHICH} rendered the page and It took its action, but neither WebDriver's click nor a tap reached the page, so its button was pressed from a script`,
      )
    break
  } catch (e) {
    faults.push(redact(String(e.message ?? e)))
    console.log(`  failed: ${faults.at(-1)}`)
  }
}
if (!passed) {
  console.error(
    `${WHICH} did not pass in ${faults.length} of the ${TRIES} tries it was given${faults.length < TRIES ? ', the time for the rest having run out' : ''}`,
  )
  process.exit(1)
}
if (faults.length) console.log(`::warning::${WHICH} passed after ${faults.length} failed ${faults.length === 1 ? 'try' : 'tries'}: ${faults.join(' | ')}`)
