// A browser on the site, for the end-to-end scripts, and the two ways one is paired: as the
// owner's, from the machine It runs on with `it site`, and as a screen's, with a code that the
// owner's browser shows under Displays.
import { createHash } from 'node:crypto'
import { chromium, firefox } from 'playwright'
import { it, noteWhenSeen, patiently, STACK } from './lib.mjs'
import { redact } from './logs.mjs'

/** The site, as a person at the machine It runs on opens it. */
export const APP = STACK?.site

// Playwright starts Chromium with storage partitioning switched off, and Firefox with cookie
// partitioning switched off. Nobody runs a browser that way, so these put each back to how it
// ships; the "-blocked" and "-strict" kinds add the stricter settings a person might choose.
async function chromiumAsShipped(extra = [], channel) {
  const server = await chromium.launchServer(channel ? { channel } : {})
  const flag = server.process().spawnargs.find((a) => a.startsWith('--disable-features='))
  await server.close()
  const kept = flag
    .split('=')[1]
    .split(',')
    .filter((f) => f !== 'ThirdPartyStoragePartitioning')
  return { ...(channel ? { channel } : {}), ignoreDefaultArgs: [flag], args: [`--disable-features=${kept.join(',')}`, ...extra] }
}
const FIREFOX_SHIPPED = { 'network.cookie.cookieBehavior': 5, 'network.cookie.CHIPS.enabled': true }
export const BROWSERS = {
  chromium: async () => chromium.launch(await chromiumAsShipped()),
  'chromium-blocked': async () => chromium.launch(await chromiumAsShipped(['--test-third-party-cookie-phaseout'])),
  chrome: async () => chromium.launch(await chromiumAsShipped([], 'chrome')),
  'chrome-blocked': async () => chromium.launch(await chromiumAsShipped(['--test-third-party-cookie-phaseout'], 'chrome')),
  firefox: () => firefox.launch({ firefoxUserPrefs: FIREFOX_SHIPPED }),
  'firefox-strict': () =>
    firefox.launch({
      firefoxUserPrefs: { ...FIREFOX_SHIPPED, 'browser.contentblocking.category': 'strict', 'privacy.trackingprotection.enabled': true },
    }),
}
export const BROWSER = process.env.IT_BROWSER ?? 'chromium'

/**
 * The cookie It gives a browser when it is paired, where an answer sets it: the browser's own
 * session, in a cookie named for that session. An answer that clears one sets it to nothing,
 * which is no session.
 */
const SESSION = /(?:^|\n)it_session_[A-Za-z0-9_]+=([^;\n]+)/g
/** The cookie of a session as an answer sets it or clears it: its name, which is the session's and no secret, and what it is given, which is nothing where it is cleared. */
const SESSION_COOKIE = /(?:^|\n)(it_session_[A-Za-z0-9_]+)=([^;\n]*)/g
/** The name of the cookie a session is held in, by the session's id. */
export const cookieOf = (session) => `it_session_${String(session).replace(/[^A-Za-z0-9]/g, '_')}`
/** The path a page is shown under, which is that showing's alone: whoever has it is given the page's files. */
const SHOWING = /\/s\/([A-Za-z0-9_-]{43})\//g
/** A text with the address of any showing it names taken out and noted: it is one of the credentials a run holds. */
const withoutShowings = (text) =>
  text.replace(SHOWING, (_, path) => {
    noteWhenSeen('a showing’s address', path)
    return '/s/[a showing’s address]/'
  })

/**
 * What a text holds that nothing written down may hold, by kind: anything shaped like a
 * credential, and any credential this run has noted. Only the kinds are given back, and
 * nothing of the text.
 */
export function heldIn(text) {
  const cleaned = redact(text)
  if (cleaned === text) return []
  // What stands in the cleaned text in place of each thing that was taken out says what kind of
  // thing it was. A credential the run noted is told there from the others of its kind by a
  // number, which is no part of the kind
  return [
    ...new Set(
      [...cleaned.matchAll(/\[([^\][]{3,80})\]/g)]
        .map(([, what]) => what)
        .filter((what) => !text.includes(`[${what}]`))
        .map((what) => what.replace(/ \(\d+\)$/, '')),
    ),
  ]
}

/**
 * One thing a browser's console was given, as it is kept, with what it held that it should not.
 *
 * What a page or the site wrote there with a call of its own is looked at exactly as it was
 * written, before anything is taken out of it: a credential in it is a leak, whichever kind it
 * is, and a showing's address is one. Only then is it cleaned, so that what is kept holds
 * nothing of it, and the leak is remembered by its kind.
 *
 * What the browser says by itself is told apart by having been given nothing to say: it comes
 * with no arguments. A browser names a frame by its address when it says something about it,
 * which for a page being shown is the showing's own. That is the browser's word for the frame
 * and no doing of It's, so it is taken out and noted. Anything else in the browser's own words
 * that is a credential is a leak like any other.
 */
export function consoleLine({ type, text, own }) {
  const written = own ? withoutShowings(text) : text
  return { kept: `${type}: ${redact(written)}`, leaked: heldIn(written) }
}

/**
 * Starts a browser that is not paired, with one tab. Returns the browser, its context and the
 * page, with what any tab of it reported as an error (`problems`), everything any tab of it
 * wrote to its console, cleaned of any credential (`said`), and the kinds of credential that a
 * page or the site wrote there or threw (`leaked`).
 *
 * Each problem is kept with when it was reported (`at`), what it says, cleaned (`says`), and
 * who said it: the browser by itself (`own`), which it does of a request that was refused or
 * could not be made and of what its own rules forbid, or a script of the site's or a page's,
 * by writing an error or throwing one. Of a request the browser says which address was asked,
 * and that is kept without what follows a question mark (`of`), with the showing it is in, by
 * an id that is no secret (`showing`), where it is in one.
 */
export async function launch({ kind = BROWSER, context: contextOptions = {} } = {}) {
  if (!BROWSERS[kind]) throw new Error(`no such browser: ${kind}. One of ${Object.keys(BROWSERS).join(', ')}`)
  const browser = await BROWSERS[kind]()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...contextOptions })
  const problems = []
  const said = []
  const leaked = []
  // Pairing leaves the browser a session, in a cookie, and each showing of a page has an address
  // that is all it takes to be given the page. Both are credentials this run was given: noted
  // from every tab of this browser, for the check of what the run wrote down
  // Each thing a tab of this browser sent the site about its session is kept with what came of
  // it: which tab sent it and when, to which address, the session it named where it named
  // one, how it was answered and when, and which sessions' cookies the answer set or cleared,
  // by their names. A session's name is no secret and opens nothing.
  const exchanges = []
  const sentAbout = new Map()
  context.on('response', (r) => {
    if (r.request().method() !== 'POST') return
    const one = sentAbout.get(r.request())
    if (one) Object.assign(one, { status: r.status(), answered: Date.now() })
    const read = r.headerValue('set-cookie').then(
      (cookies) => {
        for (const [, value] of (cookies ?? '').matchAll(SESSION)) noteWhenSeen('a browser’s session', value)
        if (one) for (const [, name, value] of (cookies ?? '').matchAll(SESSION_COOKIE)) one.cookies.push({ name, set: value !== '' })
      },
      () => {},
    )
    if (one) one.read = read
  })
  // What the browser has asked for and has not been answered yet, with when it asked: for
  // whoever has to say what a tab that does not answer is waiting on
  const waitingFor = new Map()
  context.on('request', (r) => {
    for (const [, path] of r.url().matchAll(SHOWING)) noteWhenSeen('a showing’s address', path)
    waitingFor.set(r, Date.now())
    let asked
    try {
      asked = new URL(r.url())
    } catch {
      return
    }
    if (r.method() !== 'POST' || !asked.pathname.startsWith('/session/')) return
    let tab = null
    let named = null
    try {
      tab = r.frame().page()
    } catch {}
    try {
      named = r.postDataJSON()?.session
    } catch {}
    const one = {
      tab,
      origin: asked.origin,
      path: asked.pathname,
      sent: Date.now(),
      named: typeof named === 'string' ? named : null,
      status: null,
      answered: null,
      cookies: [],
      read: Promise.resolve(),
    }
    exchanges.push(one)
    sentAbout.set(r, one)
  })
  for (const over of ['requestfinished', 'requestfailed']) context.on(over, (r) => waitingFor.delete(r))
  /** Each request of this browser that is not answered yet: how it was asked, at which path, a showing's address taken out of it, and for how long it has waited. */
  const unanswered = () =>
    [...waitingFor].map(([r, since]) => {
      let asked = 'an address that is none'
      try {
        asked = withoutShowings(new URL(r.url()).pathname).slice(0, 80)
      } catch {}
      return `${r.method()} ${asked}, for ${Math.round((Date.now() - since) / 1000)} seconds`
    })
  // What an error nothing caught says is the words of whatever threw it, a page or the site
  context.on('weberror', (e) => {
    const line = consoleLine({ type: 'pageerror', text: e.error().message, own: false })
    leaked.push(...line.leaked)
    problems.push({ at: Date.now(), says: line.kept, own: false, of: '', showing: undefined })
  })
  context.on('console', (m) => {
    const line = consoleLine({ type: m.type(), text: m.text(), own: m.args().length === 0 })
    leaked.push(...line.leaked)
    said.push(line.kept)
    if (m.type() !== 'error') return
    // With where it was asked of, where the browser says: the address without what follows a
    // question mark. That is the browser's own account of the request, and a showing's address in it is taken out
    let of = ''
    try {
      const at = new URL(m.location().url)
      of = `${at.origin}${withoutShowings(at.pathname).slice(0, 80)}`
    } catch {}
    problems.push({ at: Date.now(), says: line.kept.slice(`${m.type()}: `.length, 300), own: m.args().length === 0, of, showing: showingOf(m.location().url) })
  })
  const page = await context.newPage()
  return { browser, context, page, problems, said, leaked, unanswered, exchanges }
}

// ---------- when a browser names a session ----------

// A browser names a session to the site (`POST /session/end`) for one of two things. It names
// the session it holds to end it: when the person signs out or erases everything, and when a
// tab learns that its display was forgotten or its pairing ended. And it names sessions it
// held that are over, so that the backend clears their cookies again, should an answer that
// was on its way have put one back: each time a tab is refused a token, the first time a tab
// finds the browser paired, and when an answer arrives that was overtaken. The backend answers
// 200 where it ended the session, 401 where the browser holds no session that is paired, and
// 409 where it holds another. A browser writes each refusal down by itself, so a run has to
// know which of them the site may cause, and holds every naming to this.

/**
 * Holds every naming of a session by one browser to what the site may do, from everything the
 * browser sent the site about its session (`exchanges`, as `launch` keeps them) and from the
 * whiles in which the run took the browser's pairing to be ending or over (`notPaired`, each
 * with `from` and `until`).
 *
 * A session is the browser's own to name from the answer that set its cookie. While the
 * browser has that cookie, naming the session ends it, and that is done only in such a while,
 * and is answered 200, 401 or 409. Once the cookie has been cleared the session is over:
 * naming it ends nothing, and is answered 401 or 409 in such a while and 409 outside one,
 * where the browser is paired. A tab names sessions that are over no oftener than once for
 * each, each time it was answered about its token. And a session the browser never held is
 * never named.
 *
 * Gives `wrong`, a sentence for each naming that is none of that, and `refused`, how many
 * namings that were as they may be were answered with a refusal, by the site they were sent to
 * and the status: that is how often the browser may say so by itself.
 */
export function namingsHeld(exchanges, notPaired = []) {
  const held = new Set()
  const has = new Set()
  const accountedFor = new Map()
  const kinds = new Map()
  const wrong = []
  const refused = new Map()
  const short = (session) => `${String(session).slice(0, 6)}…`
  const events = exchanges
    .flatMap((x) => [{ at: x.sent, x, sent: true }, ...(x.answered === null ? [] : [{ at: x.answered, x, sent: false }])])
    .sort((a, b) => a.at - b.at)
  for (const { x, sent } of events) {
    const naming = x.path === '/session/end'
    if (sent) {
      if (!naming) continue
      const name = x.named === null ? null : cookieOf(x.named)
      if (name === null || !held.has(name)) {
        wrong.push(`a session the browser never held was named (${x.named === null ? 'none at all' : short(x.named)})`)
      } else if (has.has(name)) {
        kinds.set(x, 'its own')
        if (!notPaired.some((w) => x.sent >= w.from && x.sent <= w.until))
          wrong.push(`the session the browser holds was named while nothing had ended its pairing (${short(x.named)})`)
      } else {
        kinds.set(x, 'over')
        const left = accountedFor.get(x.tab) ?? 0
        if (left < 1) wrong.push(`a session that is over was named oftener than the tab’s askings account for (${short(x.named)})`)
        else accountedFor.set(x.tab, left - 1)
      }
      continue
    }
    if (naming && kinds.has(x)) {
      const whilst = notPaired.some((w) => x.sent >= w.from && x.sent <= w.until)
      const may = kinds.get(x) === 'its own' ? [200, 401, 409] : whilst ? [401, 409] : [409]
      if (!may.includes(x.status))
        wrong.push(
          `naming ${kinds.get(x) === 'its own' ? 'the session the browser holds' : 'a session that is over'} was answered ${x.status} (${short(x.named)})`,
        )
      else if (x.status !== 200) refused.set(`${x.origin} ${x.status}`, (refused.get(`${x.origin} ${x.status}`) ?? 0) + 1)
    }
    for (const cookie of x.cookies) {
      if (cookie.set) {
        held.add(cookie.name)
        has.add(cookie.name)
      } else has.delete(cookie.name)
    }
    // Answered about its token, a tab may name each session that is over once more
    if (x.path === '/session/token') accountedFor.set(x.tab, (accountedFor.get(x.tab) ?? 0) + [...held].filter((name) => !has.has(name)).length)
  }
  return { wrong, refused: (origin, status) => refused.get(`${origin} ${status}`) ?? 0, held: [...held] }
}

// ---------- what a browser is expected to say ----------

// A browser writes to its console, whatever a script on the page does about it, each request
// that was refused or could not be made, and each thing its own rules kept a page from doing.
// Those are the browser's words: no script is asked first, so the site cannot be quiet about
// them. A run provokes each of them on purpose somewhere, and foresees it there: in which
// browser, in which words, about which address, how often at most, and from when until when.
// Whatever a browser says by itself that nothing foresaw is an error of its own. So is every
// error a script of the site's or of a page's wrote or threw: the site writes none for what the
// backend refuses with a code, and nothing foresees one. The words below are Chromium's.

/** A text as a pattern takes it for itself, whatever is in it. */
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The words a browser has for a request that was answered with a refusal. It writes them whatever the page then does with the answer. */
export const refusedWith = (status) => new RegExp(`^Failed to load resource: the server responded with a status of ${status} `)
/** The words it has for a request it could not make, or would not let a page make, by the reason it gives: `ERR_FAILED`, `ERR_CONNECTION_REFUSED`. */
export const notMade = (...reasons) => new RegExp(`^Failed to load resource: net::(${reasons.map(literally).join('|')})$`)
/** For a page that asked another origin for something that origin does not let it read: by what was asked for, and from which origin. A page being shown has an origin of its own that is written `null`. */
export const notLetRead = (asked, from = 'null') =>
  new RegExp(`^Access to fetch at '${literally(asked)}' from origin '${literally(from)}' has been blocked by CORS policy`)
/** For the live connection to a site, refused or with nothing there to make it to: the site's own, at the address the site keeps it at, and no other connection. */
export const noConnectionTo = (site) => new RegExp(`^WebSocket connection to '${literally(site.replace(/^http/, 'ws'))}/api/[^'/]+/sync' failed`)
/** For a page that tried to take the tab it is shown in elsewhere and may not: by the address the tab is at. */
export const mayNotLeave = (tab) => new RegExp(`^Unsafe attempt to initiate navigation for frame with URL '${literally(tab)}'`)
/**
 * For one thing a document's content policy forbids it: by how the browser begins to say what
 * was tried, such as "Framing 'http://another.site/'" or "Executing inline script", and by the
 * whole directive it names as the one that forbids it.
 */
export const againstPolicy = (tried, directive) =>
  new RegExp(`^${literally(tried)} violates the following Content Security Policy directive\\b.*?["']${literally(directive)}["']`)
/** For an answer a document asked another site for and its content policy forbids it to ask: by the address it asked. */
export const notAsked = (asked) =>
  new RegExp(`^Fetch API cannot load ${literally(asked)}\\. Refused to connect because it violates the document's Content Security Policy\\.`)
/** One address, and no other. */
export const exactly = (address) => new RegExp(`^${literally(address)}$`)
/** Any address under one. */
export const under = (address) => new RegExp(`^${literally(address)}`)
/** A showing by an id that is no secret: enough to tell one showing from another, and nothing that leads back to its address. Nothing, for an address that is no showing's. */
export const showingOf = (url) => {
  const [, path] = /\/s\/([A-Za-z0-9_-]{43})\//.exec(String(url)) ?? []
  return path ? createHash('sha256').update(path).digest('hex').slice(0, 8) : undefined
}

/**
 * What one run foresees of its browsers, and the holding of what they reported against it.
 * `linger` is how long a thing stays foreseen after what provokes it is over, since a browser
 * may say it a moment late.
 */
export function expectations({ linger = 3000 } = {}) {
  const foreseen = []
  /**
   * Foresees something one browser will say by itself, from now on, and gives the way to say
   * that what provokes it is over. `who` is the browser, as `launch` gave it: nothing is ever
   * foreseen of every browser at once. `says` is what its words are known by, `of` the address
   * they are about, and `showing` the showing that address is in, by its id (`showingOf`),
   * where it matters which. `times` is how often it may be said at most, once unless told, as
   * a number or as something that gives the number when the run is done, such as how many
   * requests were seen to be made. A browser is taken to be sure to say it at least once, so
   * that one that was never said is found out at the end as an excuse nothing needed; `may`
   * marks what a browser says only when the moment falls so. `because` says what provoked it,
   * for whoever reads that it was never said.
   */
  function foresee(who, { says, of, showing, times = 1, may = false, because }) {
    if (!who?.problems) throw new Error('what is foreseen is foreseen of one browser, and none was named')
    const one = { who, says, of, showing, times, may, because, from: Date.now(), until: Number.POSITIVE_INFINITY, said: 0 }
    foreseen.push(one)
    const over = () => {
      one.until = Math.min(one.until, Date.now() + linger)
    }
    // Whether the browser has said it yet, since it was foreseen, for whoever waits for that
    over.said = () => who.problems.some((problem) => problem.own && problem.at >= one.from && fits(one, problem))
    over.sure = !may
    return over
  }
  /** Whether what a browser said is what was foreseen of it: in those words, about that address and that showing. */
  const fits = (f, problem) => f.says.test(problem.says) && (!f.of || f.of.test(problem.of)) && (f.showing === undefined || f.showing === problem.showing)
  /**
   * Foresees each of several things of a browser for what is done in the statements that
   * follow, and gives the way to say that the doing is over. What is given has a way of its
   * own, `said`, to wait until the browser has said everything that was foreseen of it for
   * sure: a browser says a thing a moment after it is done, and whoever looks at what became
   * of the doing looks once it has spoken. It waits ten seconds at most, and says whether the
   * browser has spoken.
   */
  function during(who, reports) {
    const over = reports.map((report) => foresee(who, report))
    const done = () => {
      for (const one of over) one()
    }
    done.said = async (ms = 10_000) => {
      for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 25))) {
        if (over.every((one) => !one.sure || one.said())) return true
        if (Date.now() > end) return false
      }
    }
    return done
  }
  /** Does something in a browser that the browser will report by itself, and foresees each report for as long as the doing lasts and a moment after. */
  async function provoking(who, reports, doing) {
    const done = during(who, reports)
    try {
      return await doing()
    } finally {
      done()
    }
  }
  /**
   * Holds what each browser reported against what was foreseen of it: the same browser, at
   * that time, in those words, about that address and that showing, and no oftener than was
   * foreseen. Gives every error that is a browser's own (`own`), each as a sentence, once,
   * with how often it was said: what a browser said by itself that nothing foresaw or that was
   * said more often than foreseen, and everything a script wrote or threw, which nothing can
   * foresee. And gives what was foreseen for sure and never said (`neverSaid`), each by what
   * was to provoke it.
   */
  function heldToAccount(browsers) {
    for (const f of foreseen) f.said = 0
    const most = (f) => (typeof f.times === 'function' ? f.times() : f.times)
    const own = []
    browsers.forEach((b, i) => {
      for (const problem of b.problems) {
        // Where more than one thing foreseen fits, the browser is taken to speak of the one
        // that was foreseen last and has not been said yet: what was provoked latest is what
        // it is speaking of, and nothing goes unsaid because another took its words
        const meant = problem.own
          ? foreseen.filter((f) => f.who === b && problem.at >= f.from && problem.at <= f.until && fits(f, problem) && f.said < most(f))
          : []
        const expected = meant.findLast((f) => f.said === 0) ?? meant.at(-1)
        if (expected) expected.said += 1
        else
          own.push(
            `browser ${i + 1} ${problem.own ? 'said' : 'had a script write or throw'}: ${problem.says.replace(/\s+/g, ' ').slice(0, 180)}${problem.of ? ` (asked of ${problem.of})` : ''}`,
          )
      }
    })
    // Each thing once, with how often it was said, so that one said many times does not crowd out the others
    const often = new Map()
    for (const line of own) often.set(line, (often.get(line) ?? 0) + 1)
    return {
      own: [...often].map(([line, times]) => (times > 1 ? `${line}, ${times} times` : line)),
      neverSaid: foreseen.filter((f) => !f.may && f.said === 0).map((f) => f.because),
    }
  }
  return { foresee, during, provoking, heldToAccount }
}

/** Whether a tab shows the site as a paired browser sees it. */
export const paired = (page) =>
  page
    .locator('header.bar')
    .isVisible()
    .catch(() => false)
/** Waits for a tab to show the site as a paired browser sees it, and says what it shows when it does not. */
async function untilPaired(page, how) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    if (await paired(page)) return
    await page.waitForTimeout(200)
  }
  const shows = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
  throw new Error(`the browser was not paired ${how}. The page says: ${shows}`)
}

/**
 * The address that pairs one browser as the owner's: `it site` on the machine It runs on asks
 * for it and prints it. It works once. `--no-open` keeps the program from opening a browser of
 * its own. Where It says to try again shortly, it is asked for again: It makes only so many
 * codes in a minute.
 */
export const ownerAddress = async ({ home = STACK.home, run = it } = {}) => (await patiently(() => run(home, ['site', '--no-open']))).url
/** Pairs a tab as the owner's, with the address `it site` prints. */
export async function pairAsOwner(page, opts) {
  await page.goto(await ownerAddress(opts))
  await untilPaired(page, 'by the address `it site` printed')
}

/**
 * Presses the button of a panel that asks It for a code, and waits for what the panel shows
 * once it has one (`given`). Where the panel says instead to try again shortly, the button is
 * pressed again a little later, as a person would press it: It makes only so many codes in a
 * minute, and a run asks for more than a person does. Whatever else the panel comes to show is
 * left for whoever reads the panel next.
 */
async function pressedForACode(page, name, given) {
  const dialog = page.locator('.pairing')
  for (let tries = 1; tries <= 6 && !(await given.isVisible()); tries++) {
    // The button on the page opens the dialog, and the dialog asks for a code as it opens
    if (!(await dialog.isVisible())) await page.getByRole('button', { name, exact: true }).first().click()
    let toldToWait = false
    for (const end = Date.now() + 15_000; Date.now() < end && !toldToWait && !(await given.isVisible()); await page.waitForTimeout(100)) {
      toldToWait = await dialog.getByText('Try again shortly').isVisible()
    }
    if (!toldToWait) return
    await dialog.getByRole('button', { name: 'Done' }).click()
    await page.waitForTimeout(2000)
  }
}

/**
 * A code that pairs one browser as a screen, made as a person makes one: in a tab of the
 * owner's browser, under Displays, with "Add a display". The code is read off the page in the
 * letters it shows, in fours, with the address it shows beside them when it shows one.
 */
export async function screenCode(owner) {
  const tab = await owner.context.newPage()
  try {
    await tab.goto(`${APP}/displays`)
    await pressedForACode(tab, 'Add a display', tab.locator('.pair-code'))
    const shown = (await tab.locator('.pair-code').innerText({ timeout: 15_000 })).trim()
    const address = await tab
      .locator('.pair-address')
      .innerText({ timeout: 500 })
      .then(
        (text) => text.trim(),
        () => null,
      )
    const pictured = await tab.locator('.pairing svg.qr').isVisible()
    const code = shown.replace(/\s+/g, '')
    noteWhenSeen('a code that pairs a browser', code)
    await tab.locator('.pairing').getByRole('button', { name: 'Done' }).click()
    return { code, shown, address, pictured }
  } finally {
    await tab.close()
  }
}
/** The button the site offers a browser that was opened at a screen's address: nothing is paired, and the code is not used, until it is pressed. */
export const becomeAScreen = (page) => page.getByRole('button', { name: 'Make this browser a screen of It', exact: true })
/**
 * Pairs a tab as a screen: by opening the address a code makes and saying there that this
 * browser is the screen, or, with `typed`, by typing the code where the site asks for one. `at`
 * is the site as that screen reaches it, which for a screen elsewhere on the network is the
 * machine's address there.
 */
export async function pairAsScreen(page, code, { typed = false, at = APP } = {}) {
  if (typed) {
    await page.goto(at)
    await page.getByLabel('Pairing code').fill(code)
    await page.getByRole('button', { name: 'Pair this browser' }).click()
  } else {
    await page.goto(`${at}/pair#${code.replace(/\s+/g, '')}`)
    await becomeAScreen(page).click({ timeout: 20_000 })
  }
  await untilPaired(page, typed ? 'by the code typed into it' : 'by the address its code makes, once it was said there that the browser is that screen')
}

/**
 * What another computer runs to join, made as a person makes it: in a tab of the owner's
 * browser, under Machines, with "Add a machine". The site shows the command once It can be
 * reached from the network, and it is read off the page: the address to join at, and the code,
 * which is one of the credentials a run holds. Where the site shows no command, `command` is
 * null and `says` is what it shows instead.
 */
export async function machineCommand(owner) {
  const tab = await owner.context.newPage()
  try {
    await tab.goto(`${APP}/machines`)
    // The dialog has answered once it shows something to copy: the command, or the one that turns the network on
    // The dialog shows two commands: the line that installs It and joins, and the joining alone, which is the one read here
    await pressedForACode(tab, 'Add a machine', tab.locator('.pair-command.join .copyable'))
    await tab.locator('.pair-command.join .copyable').waitFor({ timeout: 15_000 })
    const command = await tab
      .locator('.pair-command.join code')
      .innerText({ timeout: 2000 })
      .then(
        (text) => text.trim(),
        () => null,
      )
    const [, url, code] = /^it login --url "?([^\s"]+)"? --code (\S+)$/.exec(command ?? '') ?? []
    noteWhenSeen('an invite for a machine', code)
    const says = command ? null : (await tab.locator('.pairing').innerText()).replace(/\s+/g, ' ')
    await tab.locator('.pairing').getByRole('button', { name: 'Done' }).click()
    return { command, url, code, says }
  } finally {
    await tab.close()
  }
}

/**
 * Opens the site in a browser of its own and pairs it: as the owner's, or, given the owner's
 * browser to make the code in, as a screen's. Returns what `launch` returns. A browser that
 * could not be paired is closed before the failure is passed on.
 */
export async function open(as = 'owner', { owner, typed, ...options } = {}) {
  const opened = await launch(options)
  try {
    if (as === 'owner') await pairAsOwner(opened.page)
    else if (as === 'screen') await pairAsScreen(opened.page, (await screenCode(owner)).shown, { typed })
    else throw new Error(`a browser is paired as the owner’s or as a screen’s, and not as “${as}”`)
    return opened
  } catch (err) {
    await opened.browser.close().catch(() => {})
    throw err
  }
}
