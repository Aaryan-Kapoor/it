// The real thing, with a real Claude Code: `it setup` installs the add-on with Claude Code's own
// plugin commands, Claude publishes a page, a person clicks it in a browser, and the click comes
// back into Claude's conversation. Claude is driven the way a host such as T3 Code drives it.
// Costs a few short turns of the model named below. Removes the add-on again when it is done.
//
//   node e2e/harness-claude.mjs [model]
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addonIn,
  COMMAND,
  couldNotKeep,
  couldNotNote,
  it,
  itEnv,
  needsStack,
  noteConnector,
  noteFound,
  sleep,
  stopped,
  takeOut,
  toldAboutUsage,
  usageReceiver,
  whyNotInstall,
  wrongWithUsage,
} from './lib.mjs'
import { join } from './login.mjs'
import { leaks, PRIVATE_MARK, printCleanly, stackLogs, verdict } from './logs.mjs'
import { APP, open } from './site.mjs'

const model = process.argv[2] ?? 'haiku'
printCleanly()
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, detail, 600))
}
// The agent's machine joins the stack's It, and the page is shown in a browser paired there
needsStack('This run')
const home = mkdtempSync(path.join(os.tmpdir(), 'it-claude-'))
const work = mkdtempSync(path.join(os.tmpdir(), 'it-claude-work-'))
// What the run writes down is kept here until the end of the run has read it: what the
// connector said and its journal, what the CLI printed, and what was reported as usage
const kept = mkdtempSync(path.join(os.tmpdir(), 'it-claude-logs-'))
process.env.IT_E2E_SAID = kept
const slug = `claude-${Date.now().toString(36)}`
// What the connector reports as usage goes to a stand-in here, never to the real address, and
// is read back at the end
const usage = await usageReceiver(path.join(kept, 'usage.received.jsonl'))
process.env.IT_E2E_USAGE_URL = usage.url
// As the install script leaves a machine: the person has been told about usage reporting
toldAboutUsage(home)
const reported = () => usage.batches.flatMap((b) => b.events ?? [])
const reportedAs = (agent) =>
  reported()
    .filter((e) => e.name === 'answer.delivered' && e.properties.agent === agent)
    .map((e) => e.properties.path)
    .sort()
    .join()
const untilReported = async (want, agent, ms = 50_000) => {
  const end = Date.now() + ms
  while (Date.now() < end && reportedAs(agent) !== want) await sleep(500)
  return reportedAs(agent) === want
}
/** Waits for a file to be there: a command the agent is told to run leaves one as it begins, which is how the run knows the command is under way. */
const untilThere = async (file, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end && !existsSync(file)) await sleep(200)
  return existsSync(file)
}
// A real agent runs in what follows, with tools of its own: it is given the folder of the
// machine that joins, and nothing of the conversation this program may itself be run from
const env = { ...itEnv(home), PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH}` }
let connector
let claude
let browser
// Whether this run has begun to put the add-on into Claude Code, which is when it becomes this run's to take out
let ours = false
// Every browser the run opened, and what Claude itself printed, for the end of the run to keep and read
const browsers = []
let transcript = () => ''

try {
  // Every name, title and payload the run chooses carries the mark that the check of what it wrote down looks for
  await join(home, `e2e claude box ${PRIVATE_MARK}box`)
  // This run installs It's add-on into the Claude Code of whoever runs it, and removes it again at the
  // end. Where one is there already, from the person's own It, switched on or off, that would
  // replace theirs and then take it away: so it is begun only where Claude Code itself says it
  // has none.
  const found = (await it(home, ['status'])).harnesses?.find((h) => h.id === 'claude-code')
  const why = whyNotInstall('Claude Code', found, found?.addon === 'not_connected' ? await addonIn('claude-code') : undefined)
  if (why) {
    console.error(why)
    await it(home, ['logout']).catch(() => {})
    for (const folder of [home, work, kept]) rmSync(folder, { recursive: true, force: true })
    process.exit(2)
  }
  ours = true
  const setup = await it(home, ['setup', '--only', 'claude-code', '--no-service'])
  const status = setup.harnesses.find((h) => h.id === 'claude-code')
  check('it setup connects Claude Code with its own plugin commands', status?.addon === 'connected', JSON.stringify(setup))

  // The service of a machine that joined is its connector. What it says is kept where the end of the run reads it
  connector = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], {
    env,
    stdio: ['ignore', 'ignore', openSync(path.join(kept, 'connector.log'), 'w')],
  })
  await sleep(2500)
  // Its token is one of the credentials this run holds. It is waited for and noted before
  // anything more is done, so that anything printed from here on is cleaned of it
  const began = Date.now()
  while (!noteConnector(home)) {
    if (Date.now() - began > 30_000) throw new Error('the connector wrote down no token within thirty seconds')
    await sleep(250)
  }

  // Claude Code as a host runs it: one process, messages in and events out as JSON lines
  claude = spawn(
    'claude',
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'bypassPermissions'],
    { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const events = []
  let buf = ''
  claude.stdout.on('data', (c) => {
    buf += c
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        events.push(JSON.parse(line))
      } catch {}
    }
  })
  let stderr = ''
  claude.stderr.on('data', (d) => (stderr += d))
  transcript = () => `${events.map((e) => JSON.stringify(e)).join('\n')}\n${stderr}`
  const say = (text) => claude.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
  const results_ = () => events.filter((e) => e.type === 'result')
  const texts = (from = 0) =>
    events
      .slice(from)
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text))
      .join('\n')
  const untilResults = async (n, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end && results_().length < n) await sleep(200)
    return results_().length >= n
  }

  say(
    `Run this exact shell command, and nothing else:\n\nit create "Approve deploy ${PRIVATE_MARK}title" --id ${slug} --html '<h1>Deploy</h1><button id="go" onclick="It.action(\`approve\`, {plan: \`${PRIVATE_MARK}B\`})">Approve</button>'\n\nThen reply with only the word READY.`,
  )
  check(
    'Claude publishes a page with the it command, in a turn that finishes normally',
    (await untilResults(1, 120_000)) && results_()[0]?.subtype === 'success',
    stderr.slice(-400) + texts(),
  )
  const session = events.find((e) => e.session_id)?.session_id
  const made = await it(home, ['read', slug]).catch((e) => ({ error: e.message }))
  check(
    'the page remembers which conversation made it',
    made.session?.harness === 'claude-code' && made.session?.id === session,
    JSON.stringify({ made: made.session ?? made.error, session }),
  )

  const one = await open('owner')
  browser = one.browser
  browsers.push(one)
  await one.page.goto(`${APP}/p/${slug}`)
  const frame = one.page.frameLocator('.mount iframe')
  await frame.locator('#go').waitFor({ timeout: 30_000 })

  // Idle: the click starts a turn by itself
  let mark = events.length
  await frame.locator('#go').click()
  check(
    'a click while Claude is idle starts a turn with nothing typed, which finishes normally',
    (await untilResults(2, 90_000)) && results_()[1]?.subtype === 'success',
    JSON.stringify(results_()[1] ?? 'no result within ninety seconds') + texts(mark),
  )
  check('and Claude answers what the person did', /approve|plan\s*B|deploy/i.test(texts(mark)), texts(mark))
  check('the turn is marked as coming from the add-on, not the person', results_()[1]?.origin?.kind === 'plugin', JSON.stringify(results_()[1]?.origin))
  const first = (await it(home, ['read', slug])).recentActions?.[0]
  check('It records that the add-on handed it over', first?.delivery === 'handed_off' && first?.route === 'addon', JSON.stringify(first))
  // Waited for here, before the next click is made, so that which click was counted how is known
  check(
    'usage counts that click as having woken the agent',
    await untilReported('woke', 'claude-code'),
    JSON.stringify(reported().map((e) => [e.name, e.properties])),
  )

  // Busy: the click rides along with the next tool result, and no extra turn starts. The
  // command leaves a file as it begins, and the click is made once that file is there: while
  // the command is running, and neither before it nor after
  mark = events.length
  const begun = path.join(work, 'begun')
  say(
    `Run this exact shell command: python3 -c "import time; open('${begun}', 'w').close(); time.sleep(18); print(42)"\n\nWhen it finishes, tell me what it printed, and repeat word for word anything else you were told alongside its result.`,
  )
  check('Claude starts the command, which runs for a while', await untilThere(begun, 90_000), texts(mark))
  await sleep(1500)
  await frame.locator('#go').click()
  check(
    'a turn that is running a tool finishes normally',
    (await untilResults(3, 120_000)) && results_()[2]?.subtype === 'success',
    JSON.stringify(results_()[2] ?? 'no result within two minutes'),
  )
  check('and Claude was given the click with that tool’s result', /sent this just after someone used it|approve/i.test(texts(mark)), texts(mark))
  await sleep(4000)
  check('with no extra turn started for it', results_().length === 3, `results: ${results_().length}`)
  check('the site shows that the agent has it', await one.page.locator('.status', { hasText: 'Your agent has it' }).isVisible())
  // The add-on told the connector which click started a turn and which joined one, and that is what is counted
  check(
    'and the click that joined a running turn as heard at once',
    await untilReported('heard,woke', 'claude-code'),
    JSON.stringify(reported().map((e) => [e.name, e.properties])),
  )
  check(
    'and counts one waking, which resumed',
    reported()
      .filter((e) => e.name === 'agent.woken')
      .map((e) => `${e.properties.agent} ${e.properties.result}`)
      .join() === 'claude-code resumed',
    JSON.stringify(reported().filter((e) => e.name === 'agent.woken')),
  )
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  // Everything the run started is stopped, and waited for, before anything it wrote is read or removed
  await Promise.all([stopped(claude), stopped(connector)])
  await browser?.close().catch(() => {})
  // Leave the person's Claude Code as it was found: done first, before anything else here that
  // could go wrong, and only by a run that got as far as putting the add-on in
  const taken = ours ? await takeOut('claude-code', home) : null
  const stillIn = taken !== null && !taken.out
  if (taken) {
    const undone = taken.setup
    check(
      'disconnecting removes the add-on again, and Claude Code itself says it has gone',
      !undone.error &&
        !undone.harnesses.some((h) => h.id === 'claude-code' && h.addon === 'connected') &&
        !existsSync(path.join(home, 'addons', 'claude-code.json')) &&
        taken.out,
      JSON.stringify(undone),
    )
  }
  await usage.close().catch(() => {})
  // Everything that was reported, down to what a connector sent as it stopped
  const wrong = wrongWithUsage(usage)
  check('everything reported as usage is what a batch may be, and was sent as one may be sent', wrong.length === 0, wrong.slice(0, 3).join('; '))
  await it(home, ['delete', slug]).catch(() => {})
  // A folder that is kept stays one of the stack's machines: it holds the note of what was put where
  if (!stillIn) await it(home, ['logout']).catch(() => {})
  // What the browser's tabs wrote and what Claude itself printed are kept with the rest, so
  // that the check below reads them too. Claude's own conversation was given the page's title and
  // what the click sent, and says them back: like what the CLI answered, it is read for
  // credentials only, which is what the name of its file says to the check.
  let keptAll = true
  try {
    browsers.forEach((b, i) => {
      writeFileSync(path.join(kept, `browser-${i + 1}.console.log`), b.said.join('\n'))
      // What is kept of a console has been cleaned, so a credential that was in it is said here, for whoever reads the kept files afterwards
      noteFound(`the console of browser ${i + 1}`, b.leaked)
    })
    mkdirSync(path.join(kept, 'agent'), { recursive: true })
    writeFileSync(path.join(kept, 'agent', 'cli.answers.txt'), transcript())
  } catch {
    keptAll = false
  }
  // What the run wrote down is read before any of it is removed, with the stack's own log as
  // it stands. What the CLI printed is the agent's own data, and is read for credentials only.
  if (existsSync(path.join(home, 'journal.jsonl'))) copyFileSync(path.join(home, 'journal.jsonl'), path.join(kept, 'journal.jsonl'))
  const held = await leaks([kept, ...stackLogs()]).catch(() => ({ read: 0, found: [] }))
  // What a page or the site wrote to the browser's console was looked at as it was written: what is kept of it has had any credential taken out
  const writtenToAConsole = [...new Set(browsers.flatMap((b) => b.leaked))]
  check(
    'nothing the run wrote down holds a credential, a name or title it chose, or what its page sent',
    keptAll && couldNotKeep() === 0 && couldNotNote().length === 0 && held.read > 0 && held.found.length === 0 && writtenToAConsole.length === 0,
    `kept from the browser and the agent: ${keptAll}; not kept from the CLI: ${couldNotKeep()}; credentials not noted: ${couldNotNote().join(', ')}; written to a browser’s console: ${writtenToAConsole.join(', ')}; read: ${held.read}; ${held.found
      .slice(0, 8)
      .map((f) => `${path.basename(f.file)}:${f.line} holds ${f.what}`)
      .join('; ')}`,
  )
  // The run's It folder goes only once the add-on is out: until then it is what removes it
  for (const folder of stillIn ? [work, kept] : [home, work, kept]) rmSync(folder, { recursive: true, force: true })
  if (stillIn) console.error(`\n${taken.left}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
