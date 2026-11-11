// Real YouTube, played in a page: the one check of the players It hosts against a provider
// itself, where the end-to-end run uses a stand-in. A page writes YouTube's embed as YouTube
// gives it, the site frames the player over the page, and the check waits for the video to play,
// muted, as YouTube lets a video start by itself. It reaches YouTube over the internet, so it is
// run by hand and not in CI, whose machines YouTube may turn away for reasons of its own. Where
// www.youtube.com cannot be reached within a few seconds it says so and checks nothing. It needs
// the stack running (node e2e/stack.mjs).
//
//   node e2e/youtube.mjs [chromium|firefox]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, needsStack, sleep } from './lib.mjs'
import { printCleanly, verdict } from './logs.mjs'
import { APP, launch, pairAsOwner } from './site.mjs'

printCleanly()
const STACK = needsStack('The check against YouTube')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(verdict(name, ok, detail, 300))
}
/** Waits for something to come true, and gives it back, or nothing when it has not within the time. */
async function until(fn, ms = 10_000, every = 200) {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
  }
}

/** Whether YouTube answers from here at all, within five seconds. */
async function reachable() {
  try {
    return (await fetch('https://www.youtube.com/generate_204', { signal: AbortSignal.timeout(5000) })).status < 500
  } catch {
    return false
  }
}
if (!(await reachable())) {
  console.log('  skip  real YouTube in a page: www.youtube.com cannot be reached from here')
  process.exit(0)
}

// Big Buck Bunny, which the Blender Foundation publishes on YouTube under a licence that lets anyone show it
const VIDEO = 'https://www.youtube.com/embed/aqz-KE-bpKQ'
const folder = mkdtempSync(path.join(os.tmpdir(), 'it-youtube-'))
writeFileSync(
  path.join(folder, 'index.html'),
  `<!doctype html><title>A film</title><style>body{margin:0}iframe{display:block;margin:20px;width:640px;height:360px;border:0}</style><iframe src="${VIDEO}?mute=1&autoplay=1"></iframe>`,
)
const slug = `youtube-${Date.now().toString(36)}`
const kind = process.argv[2] ?? 'chromium'
const opened = await launch({ kind })
try {
  await it(STACK.home, ['create', 'A film', '--id', slug, '--dir', folder])
  await pairAsOwner(opened.page)
  await opened.page.goto(`${APP}/p/${slug}`)
  const player = await until(() => opened.page.frames().find((f) => f.parentFrame() === opened.page.mainFrame() && f.url().startsWith(VIDEO)), 30_000)
  check(`the site frames YouTube’s player over the page, in ${kind}`, player)
  const played =
    player &&
    (await until(
      () =>
        player.evaluate(() => {
          const video = document.querySelector('video')
          return video && video.currentTime > 2 ? Math.round(video.currentTime * 10) / 10 : 0
        }),
      45_000,
      500,
    ))
  const said = player ? await player.evaluate(() => document.querySelector('.ytp-error')?.textContent?.trim() ?? '').catch(() => '') : ''
  check(
    'and the video plays there, muted, as YouTube lets a video start by itself',
    played,
    played ? `it reached ${played} seconds` : said ? `YouTube said: ${said}` : 'it did not start',
  )
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  await opened.browser.close()
  await it(STACK.home, ['delete', slug]).catch(() => {})
  rmSync(folder, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} of ${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
