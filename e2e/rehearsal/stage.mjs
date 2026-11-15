// The stage of a run: It installed by the real install script through the stand-in for the
// releases, set up with `--no-service`, served by `it serve` that the run starts, and the two
// windows a viewer watches, the agent's terminal on the left and the person's browser on the right.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { killTree, run, sleep, stopChild } from './lib.mjs'
import { terminalView } from './terminal.mjs'

export const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const SCREEN = { width: 2560, height: 1376 }
const HALF = SCREEN.width / 2

/** Parses what an It command printed as JSON, or the last line of it that is JSON. */
export function json(text) {
  try {
    return JSON.parse(text)
  } catch {}
  for (const line of String(text).trim().split(/\r?\n/).reverse())
    try {
      return JSON.parse(line)
    } catch {}
  return null
}

/**
 * Installs It with the real install.ps1 under Windows PowerShell 5.1, fetched from the stand-in:
 * with IT_INSTALL_BASE naming the stand-in, IT_INSTALL_PLAIN so that it stops once the program
 * is in place, and, under the owner's account, IT_INSTALL_NO_PATH, so that the owner's own PATH
 * in the registry is left alone. The script is saved to a file and run from it, as the guide's
 * "read the script before running it" does, and not piped into `iex`: the session this harness
 * runs in refuses to start any process whose command line pipes `irm` into `iex`.
 */
export async function install({ env, cwd, base, term, log, noPath = true, version }) {
  const ienv = { ...env, IT_INSTALL_BASE: base, IT_INSTALL_PLAIN: '1', ...(noPath ? { IT_INSTALL_NO_PATH: '1' } : {}), ...(version ? { IT_VERSION: version } : {}) }
  const from = version ? `${base}/download/${version}/install.ps1` : `${base}/latest/download/install.ps1`
  const saved = path.join(cwd, 'it-install.ps1')
  const { writeFileSync } = await import('node:fs')
  const got = await fetch(from)
  writeFileSync(saved, Buffer.from(await got.arrayBuffer()))
  term?.note(`PS> $env:IT_INSTALL_BASE='${base}'; $env:IT_INSTALL_PLAIN='1'${noPath ? "; $env:IT_INSTALL_NO_PATH='1'" : ''}${version ? `; $env:IT_VERSION='${version}'` : ''}`)
  term?.note(`PS> irm ${from} -OutFile it-install.ps1`)
  term?.note('PS> powershell -NoProfile -ExecutionPolicy Bypass -File .\\it-install.ps1')
  const r = await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', saved], { env: ienv, cwd, ms: 600_000 })
  term?.echo(`${r.out}${r.err}\n`)
  const program = path.join(env.IT_HOME, 'bin', 'it.exe')
  log('install.ps1 under Windows PowerShell 5.1', `exit ${r.code}; ${(r.out + r.err).trim().split(/\r?\n/).slice(-3).join(' / ')}`, r.code === 0 && existsSync(program))
  return { ...r, program }
}

/** Runs the real It program of the run, and resolves with what it printed, and its JSON. */
export async function it(program, argv, { env, cwd, ms = 300_000, input } = {}) {
  const r = await run(program, argv, { env, cwd, ms, input })
  return { ...r, json: json(r.out) }
}

/** `it setup --only <app> --no-service`, run as a script runs it, with no terminal to ask at. */
export async function setup({ program, env, cwd, app, term, log }) {
  term?.note(`PS> it setup --only ${app} --no-service`)
  const r = await it(program, ['setup', '--only', app, '--no-service'], { env, cwd, ms: 900_000 })
  term?.echo(`${r.out.slice(0, 6000)}${r.err ? `\n${r.err.slice(0, 3000)}` : ''}\n`)
  log(`it setup --only ${app} --no-service`, `exit ${r.code}; ${(r.err || r.out).trim().split(/\r?\n/).slice(0, 6).join(' / ')}`, r.code === 0)
  return r
}

/** `it serve`, started by the run and kept until the run stops it by its process id. */
export async function serve({ program, env, cwd, logFile, log }) {
  const { spawn } = await import('node:child_process')
  const { createWriteStream } = await import('node:fs')
  const out = createWriteStream(logFile, { flags: 'a' })
  const child = spawn(program, ['serve'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  // Ready when `it status` says It is running
  const end = Date.now() + 240_000
  let status = null
  while (Date.now() < end) {
    await sleep(2500)
    if (child.exitCode !== null) break
    status = (await it(program, ['status', '--json'], { env, cwd, ms: 90_000 })).json
    if (status?.running) break
  }
  log('it serve is running', status ? `running ${status.running}, site ${status.site}` : `it serve ended with ${child.exitCode}`, Boolean(status?.running))
  return { child, status, stop: () => stopChild(child, 15_000) }
}

/** The person's browser: the real Edge or Chrome, headed, with a profile of its own, on the right half of the screen. */
export async function personBrowser({ channel, profile, fakeMedia = false, realMedia = false, app = null }) {
  const args = [`--window-position=${HALF},0`, `--window-size=${HALF + 8},${SCREEN.height + 24}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate']
  // As an app window (one window, no tabs), since Windows keeps an app window of Chromium on top
  // of the others when asked, and a browser window with tabs not: on the owner's own desktop,
  // only the rehearsal's windows may ever be on the screen
  if (app) args.push(`--app=${app}`)
  if (fakeMedia) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream')
  if (realMedia) args.push('--use-fake-ui-for-media-stream')
  const context = await chromium.launchPersistentContext(profile, {
    channel,
    headless: false,
    viewport: null,
    args,
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  })
  let page = context.pages()[0]
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250)
    page = context.pages()[0]
  }
  page = page ?? (await context.newPage())
  if (app)
    // A page that would open in a window of its own opens in the one window instead
    context.on('page', async (p) => {
      if (p === page) return
      try {
        await p.waitForLoadState('commit', { timeout: 10_000 })
        const url = p.url()
        await p.close()
        if (/^https?:\/\//.test(url)) await page.goto(url)
      } catch {}
    })
  return { context, page }
}

/** The terminal's window, on the left half: an app window of Edge showing the terminal view. */
export async function terminalWindow({ term, profile }) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    args: [`--app=${term.url}`, '--window-position=0,0', `--window-size=${HALF + 8},${SCREEN.height + 24}`, '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  })
  let page = context.pages()[0]
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250)
    page = context.pages()[0]
  }
  await page.waitForFunction(() => typeof window.screenText === 'function', null, { timeout: 30_000 })
  term.attach(page)
  return { context, page }
}

export { terminalView, killTree }
