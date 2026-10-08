// The site's ServiceWorker, by itself: a push that arrives becomes a notification, with the
// site open and with it closed, and tapping it takes a window of the site to the page it points
// at, or opens one when there is none or none can be taken there, and goes nowhere else. The
// push is delivered straight to it through the browser's own debugging interface, since a
// browser with nobody at it cannot subscribe to a real push service. The door serves the script
// to any browser, paired or not, so the browser here is not paired. It needs the stack running
// (node e2e/stack.mjs).
//
// Nobody taps anything here, and a browser lets a script open a window only when someone has.
// So a tap is put to the script's own handler, and where the handler then opens a window is
// noted in place of opening one. Which windows of the site there are is the browser's own
// answer once the site is closed, and a stand-in's where a window has to refuse to be taken
// somewhere or to be brought to the front, which no real window does on request.
//
//   node e2e/push.mjs
import { chromium } from 'playwright'
import { needsStack, sleep } from './lib.mjs'
import { printCleanly, verdict } from './logs.mjs'
import { APP } from './site.mjs'

printCleanly()
needsStack('The check of notifications')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(verdict(name, ok, detail, 300))
}
/** Waits for something to come true, and gives it back, or nothing when it has not within the time. */
async function until(fn, ms = 10_000, every = 100) {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
  }
}
// The full browser run without a window: the cut-down one used elsewhere refuses notifications outright
const browser = await chromium.launch({ headless: false, args: ['--headless=new'] })
try {
  const context = await browser.newContext()
  await context.grantPermissions(['notifications'], { origin: APP })
  // A tab that is no tab of the site. The browser's debugging interface is reached through it,
  // so that a push can be delivered whether the site is open or closed
  const beside = await context.newPage()
  const cdp = await context.newCDPSession(beside)
  // Listened for before it is asked for: the browser may say which registrations there are
  // before it has answered the asking, and what is said with nobody listening is lost
  const registrations = []
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations))
  await cdp.send('ServiceWorker.enable')
  const page = await context.newPage()
  await page.goto(APP)
  const scope = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    return r.scope
  })
  // Not waited for without end: a run that hung here would hang until its job was stopped
  const registrationId = (await until(() => registrations.find((r) => r.scopeURL === scope && !r.isDeleted), 20_000))?.registrationId
  if (registrationId === undefined) throw new Error('the browser did not say the site’s ServiceWorker was registered within twenty seconds')
  const push = (data) => cdp.send('ServiceWorker.deliverPushMessage', { origin: APP, registrationId, data: JSON.stringify(data) })
  /** The script as it is running now. A browser stops one that has nothing to do and starts it again for the next push. */
  const script = async () => context.serviceWorkers().at(-1) ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }))
  /** The notifications that are showing, as the script itself lists them: it is there with the site open or closed. */
  const showing = async () =>
    (await script()).evaluate(async () =>
      (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })),
    )
  /** Waits for the notification a push made, by the address it points at, and gives every notification showing then. */
  const shownFor = (url) => until(async () => ((await showing()).some((n) => n.url === url) ? showing() : undefined))

  const DEPLOY = `${APP}/p/deploy-plan`
  // One at a time: the second is sent once the first is showing, so that a push the browser
  // had not yet handed to the script when the next came is never taken for one the script lost
  // The first is sent again until it shows. A push put to a script the browser has only just
  // started may never reach it, which is the browser's doing and not the script's; and since
  // each sending carries the same id, however many arrive make one notification
  const firstPush = { title: 'It', body: 'The deploy finished', url: DEPLOY, id: 'note-1' }
  await push(firstPush)
  for (let again = 0; again < 3 && !(await shownFor(DEPLOY)); again++) await push(firstPush)
  await push({ title: 'It', body: 'A second thing', url: `${DEPLOY}?second`, id: 'note-2' })
  const first = (await shownFor(`${DEPLOY}?second`)) ?? (await showing())
  check(
    'a push becomes a notification with its text',
    first.some((n) => n.body === 'The deploy finished' && n.title === 'It' && n.url === DEPLOY),
    JSON.stringify(first),
  )
  check('a second one does not replace the first', first.length === 2 && new Set(first.map((n) => n.tag)).size === 2, JSON.stringify(first))

  /**
   * Puts a tap on the notification that points at `url` to the script's own handler, and gives
   * what the handler then did: where it took a window of the site (`went`), where it opened one
   * (`opened`), and whether the notification is still showing. `windows` says which windows of
   * the site the script finds: left out, it finds the ones the browser has; given, it finds one
   * stand-in for each word, which can be taken somewhere and brought to the front ('fine'),
   * cannot be taken anywhere ('stays'), or cannot be brought to the front ('behind').
   */
  const tapped = async (url, windows) =>
    (await script()).evaluate(
      async ({ u, windows }) => {
        const notification = (await self.registration.getNotifications()).find((n) => n.data?.url === u)
        if (!notification) return { missing: true }
        const went = []
        const opened = []
        const real = [self.clients.matchAll, self.clients.openWindow]
        const standIn = (kind) => ({
          navigate: async (to) => {
            if (kind === 'stays') throw new Error('this window cannot be taken anywhere')
            went.push(to)
            return null
          },
          focus: async () => {
            if (kind === 'behind') throw new Error('this window cannot be brought to the front')
          },
        })
        if (windows) self.clients.matchAll = async () => windows.map(standIn)
        self.clients.openWindow = async (to) => void opened.push(to)
        try {
          const tap = new NotificationEvent('notificationclick', { notification })
          let done = Promise.resolve()
          // A tap made by a script is not one the browser will wait on, so the waiting is done here
          Object.defineProperty(tap, 'waitUntil', { value: (work) => (done = work) })
          self.dispatchEvent(tap)
          await done
        } finally {
          ;[self.clients.matchAll, self.clients.openWindow] = real
        }
        return { went, opened, stillShown: (await self.registration.getNotifications()).some((n) => n.data?.url === u && n.tag === notification.tag) }
      },
      { u: url, windows },
    )
  const took = (did, where) => JSON.stringify([did.went, did.opened, did.stillShown]) === JSON.stringify([...where, false])

  const toPage = await tapped(DEPLOY, ['fine'])
  check(
    'tapping a notification for a page takes a window of the site that is open to that page, opens no other, and puts the notification away',
    took(toPage, [[DEPLOY], []]),
    JSON.stringify(toPage),
  )
  const withNone = await tapped(`${DEPLOY}?second`, [])
  check('with no window of the site open, tapping opens one at the page', took(withNone, [[], [`${DEPLOY}?second`]]), JSON.stringify(withNone))
  // A window that is there and cannot be used: one that cannot be taken to the page, and one
  // that is taken there and cannot be brought to the front. Either way the person is left
  // looking at nothing unless a window is opened
  await push({ title: 'It', body: 'A third thing', url: `${DEPLOY}?third`, id: 'note-3' })
  await shownFor(`${DEPLOY}?third`)
  const cannotBeTaken = await tapped(`${DEPLOY}?third`, ['stays'])
  await push({ title: 'It', body: 'A fourth thing', url: `${DEPLOY}?fourth`, id: 'note-4' })
  await shownFor(`${DEPLOY}?fourth`)
  const cannotComeForward = await tapped(`${DEPLOY}?fourth`, ['behind', 'stays'])
  check(
    'and when the windows that are open cannot be taken to the page, or cannot be brought to the front, one is opened there all the same',
    took(cannotBeTaken, [[], [`${DEPLOY}?third`]]) && took(cannotComeForward, [[`${DEPLOY}?fourth`], [`${DEPLOY}?fourth`]]),
    JSON.stringify({ cannotBeTaken, cannotComeForward }),
  )

  // Whatever a push claims, the script only ever opens an address on this site
  const ELSEWHERE = 'https://evil.example/steal'
  await push({ title: 'x'.repeat(10), body: 12345, url: ELSEWHERE, id: 7 })
  const odd = (await shownFor(ELSEWHERE))?.find((n) => n.url === ELSEWHERE)
  check('a push with the wrong kinds of values is still shown safely', odd && odd.body === '' && odd.tag === '', JSON.stringify(odd))
  const elsewhere = await tapped(ELSEWHERE, ['fine'])
  await push({ title: 'It', body: 'elsewhere again', url: ELSEWHERE, id: 'note-5' })
  await shownFor(ELSEWHERE)
  const elsewhereWithNone = await tapped(ELSEWHERE, [])
  check(
    'and tapping one that names another site goes to this site’s front page instead, in a window that is open or in one that is opened',
    took(elsewhere, [['/'], []]) && took(elsewhereWithNone, [[], ['/']]),
    JSON.stringify({ elsewhere, elsewhereWithNone }),
  )
  // An address on this site whose path looks like another site stays on this site
  const DRESSED = `${APP}//evil.example/x`
  await push({ title: 'It', body: 'dressed up', url: DRESSED, id: 'note-6' })
  await shownFor(DRESSED)
  const dressed = await tapped(DRESSED, [])
  check(
    'nor can a path dressed up as another site lead anywhere else',
    dressed.opened?.length === 1 &&
      dressed.went.length === 0 &&
      new URL(dressed.opened[0], APP).origin === new URL(APP).origin &&
      dressed.opened[0].startsWith(APP),
    JSON.stringify(dressed),
  )

  // The site is closed: its one tab goes, and the browser has no window of it left. A push
  // still arrives, and the script is asked which windows there are by nobody but the browser.
  await page.close()
  const CLOSED = `${APP}/p/while-closed`
  await push({ title: 'It', body: 'While the site was closed', url: CLOSED, id: 'note-7' })
  const whileClosed = await shownFor(CLOSED)
  check(
    'a push that arrives while the site is closed becomes a notification all the same',
    whileClosed?.some((n) => n.url === CLOSED && n.body === 'While the site was closed'),
    JSON.stringify(whileClosed ?? (await showing())),
  )
  const windowsThen = await (await script()).evaluate(async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length)
  const fromClosed = await tapped(CLOSED)
  check(
    'and tapping it then, when the browser itself has no window of the site, opens one at the page',
    windowsThen === 0 && took(fromClosed, [[], [CLOSED]]),
    JSON.stringify({ windowsThen, fromClosed }),
  )

  const source = await (await fetch(`${APP}/sw.js`)).text()
  check('and it caches nothing', !/caches\.|cache\.put|respondWith/.test(source))
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  await browser.close()
}
console.log(`\n${results.filter(Boolean).length} of ${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
