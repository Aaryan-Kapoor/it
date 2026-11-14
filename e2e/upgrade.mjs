// A browser of a person's own, for the check of an upgrade in `.github/workflows/published.yml`:
// paired with an It that was installed from a release, and asked again once that It has been
// upgraded, from the same profile, whether it is still paired and still shows the page.
//
//   node e2e/upgrade.mjs pair --it <program> --profile <folder> [--page <id> --says <words>]
//   node e2e/upgrade.mjs still --it <program> --profile <folder> [--page <id> --says <words>]
//
// `pair` opens the address `it site --no-open` prints, as a person opens the link an agent gives
// them, and waits for the site to show the browser as paired. `still` opens the site's plain
// address and waits for the same, so that it passes only where the pairing made before is still
// honoured: nothing pairs the browser again. Both then open the page by its id, where one is
// named, and wait for its frame to show the words. The profile is a folder Chromium keeps
// everything in, its cookies with it, so that the second run is the same browser as the first.
//
// It uses Playwright's Chromium, which `npx playwright install chromium` puts on the machine, and
// nothing else of this repository: the It it talks to is the program named, and the site is
// wherever that program's `it status` says it is. Nothing it prints holds the pairing address,
// which is a credential.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const [what, ...rest] = process.argv.slice(2)
const arg = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i === -1 ? undefined : rest[i + 1]
}
const program = arg('it')
const profile = arg('profile')
const pageId = arg('page')
const says = arg('says')
if (!['pair', 'still'].includes(what) || !program || !profile || (pageId && !says)) {
  console.error('Usage: node e2e/upgrade.mjs pair|still --it <program> --profile <folder> [--page <id> --says <words>]')
  process.exit(2)
}

/**
 * What may be printed of an error: its message alone, with any pairing address's code taken out.
 * Playwright puts the whole address it was going to in its errors, and a failed command its
 * output, so nothing of an error is printed but this.
 */
const clean = (text) => String(text).replace(/\/pair#[^\s'"`)]*/g, '/pair#(the code)')
process.on('uncaughtException', (err) => {
  console.error(`The check failed: ${clean(err?.message ?? err)}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error(`The check failed: ${clean(err?.message ?? err)}`)
  process.exit(1)
})

/** What the installed `it` answers, as JSON. */
// What it prints, on either stream, is kept from the log, and so is what an error would repeat of
// it: the failure is said by the command's words and its exit code alone.
const asked = (...args) => {
  let said
  try {
    said = execFileSync(program, [...args, '--json'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(
      `\`it ${args.join(' ')}\` failed (${err?.code === 'ETIMEDOUT' ? 'it took more than a minute' : (err?.status ?? err?.signal ?? err?.code ?? 'no exit code')})`,
    )
  }
  try {
    return JSON.parse(said)
  } catch {
    throw new Error(`\`it ${args.join(' ')}\` printed no JSON`)
  }
}
const site = asked('status').site
if (typeof site !== 'string' || !/^http:\/\/localhost:\d+$/.test(site)) throw new Error('`it status` named no site on this machine')

const browser = await chromium.launchPersistentContext(profile, { headless: true })
try {
  const tab = browser.pages()[0] ?? (await browser.newPage())
  // The site's bar is shown only to a paired browser; one that is not paired is shown how to pair it
  const paired = async (ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (
        await tab
          .locator('header.bar')
          .isVisible()
          .catch(() => false)
      )
        return true
      await tab.waitForTimeout(250)
    }
    return false
  }
  if (what === 'pair') {
    const address = asked('site', '--no-open').url
    if (typeof address !== 'string' || !address.startsWith(`${site}/pair#`)) throw new Error('`it site --no-open` gave no pairing address for this site')
    await tab.goto(address).catch(() => {
      throw new Error('the browser could not open the address `it site --no-open` printed')
    })
    if (!(await paired(30_000))) throw new Error('the address `it site --no-open` printed did not pair the browser within 30 seconds')
    console.log(`The browser was paired with the It at ${site}.`)
  } else {
    await tab.goto(site)
    if (!(await paired(30_000))) throw new Error('the browser paired before was not shown the site as a paired browser within 30 seconds')
    console.log(`The browser paired before is still paired with the It at ${site}.`)
  }
  if (pageId) {
    await tab.goto(`${site}/p/${encodeURIComponent(pageId)}`)
    const words = tab.frameLocator('iframe').first().getByText(says)
    await words.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
      throw new Error(`the page ${pageId} was not shown with its words within 30 seconds`)
    })
    console.log(`The page ${pageId} is shown in it.`)
  }
} finally {
  await browser.close()
}
