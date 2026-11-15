// The person's browser: a headed Chromium or Firefox on the right half of the virtual display,
// with a profile kept outside ana's home so that it outlives one run of the browser (a reboot
// of the machine included) and is not taken for anything of It's.
import { execFileSync } from 'node:child_process'
import { chromium, firefox } from 'playwright'
import { sleep } from './lib.mjs'

export async function openBrowser(which = 'chromium', { fake = false } = {}) {
  const profile = `/opt/person-profile/${which}`
  const opts = { headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation'] }
  let context
  if (which === 'firefox') {
    context = await firefox.launchPersistentContext(profile, {
      ...opts,
      args: ['-width', '960', '-height', '1080'],
      firefoxUserPrefs: fake ? { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } : {},
    })
  } else {
    context = await chromium.launchPersistentContext(profile, {
      ...opts,
      args: ['--window-position=960,0', '--window-size=960,1080', '--no-first-run', '--password-store=basic', ...(fake ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [])],
    })
  }
  await sleep(1500)
  try {
    execFileSync('sh', ['-c', "wmctrl -lx | awk 'tolower($3) ~ /chrom|firefox|navigator/ {print $1}' | while read w; do wmctrl -i -r \"$w\" -b remove,maximized_vert,maximized_horz; wmctrl -i -r \"$w\" -e 0,960,0,960,1080; done"], { env: { ...process.env, DISPLAY: ':1' } })
  } catch {}
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}
