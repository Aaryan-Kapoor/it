// The real thing, with a real Codex: `it setup` installs the add-on with Codex's own plugin
// commands, Codex publishes a page, a person clicks it in a browser, and the click comes back
// into the conversation, through Codex's hooks while a turn is running and through Codex's own
// queue when it is idle. Codex is driven the way T3 Code drives it, as a private app-server.
// Costs a few short turns of the model named below. Removes the add-on again when it is done.
//
//   node e2e/harness-codex.mjs [model]
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const model = process.argv[2] ?? 'gpt-5.6-luna'
printCleanly()
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, detail, 700))
}
// The agent's machine joins the stack's It, and the page is shown in a browser paired there
needsStack('This run')
const home = mkdtempSync(path.join(os.tmpdir(), 'it-codex-'))
const work = mkdtempSync(path.join(os.tmpdir(), 'it-codex-work-'))
// What the run writes down is kept here until the end of the run has read it: what the
// connector said and its journal, what the CLI printed, and what was reported as usage
const kept = mkdtempSync(path.join(os.tmpdir(), 'it-codex-logs-'))
process.env.IT_E2E_SAID = kept
const slug = `codex-${Date.now().toString(36)}`
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
// The person's own Codex settings are put back exactly as they were
const config = path.join(os.homedir(), '.codex', 'config.toml')
const saved = path.join(home, 'config.toml.before')
if (existsSync(config)) copyFileSync(config, saved)
let connector
let codex
// The second Codex, run once to its end: kept here so that it is stopped however the run ends
let exec
let browser
// Whether this run has begun to put the add-on into Codex, which is when it becomes this run's to take out
let ours = false
// Every browser the run opened, and what Codex itself printed, for the end of the run to keep and read
const browsers = []
let transcript = () => ''

try {
  // Every name, title and payload the run chooses carries the mark that the check of what it wrote down looks for
  await join(home, `e2e codex box ${PRIVATE_MARK}box`)
  // This run installs It's add-on into the Codex of whoever runs it, and removes it again at the
  // end. Where one is there already, from the person's own It, switched on or off, that would
  // replace theirs and then take it away: so it is begun only where Codex itself says it has none.
  const found = (await it(home, ['status'])).harnesses?.find((h) => h.id === 'codex')
  const why = whyNotInstall('Codex', found, found?.addon === 'not_connected' ? await addonIn('codex') : undefined)
  if (why) {
    console.error(why)
    await it(home, ['logout']).catch(() => {})
    for (const folder of [home, work, kept]) rmSync(folder, { recursive: true, force: true })
    process.exit(2)
  }
  ours = true
  const setup = await it(home, ['setup', '--only', 'codex', '--no-service'])
  const status = setup.harnesses.find((h) => h.id === 'codex')
  check(
    'it setup installs the add-on with Codex’s own plugin commands',
    status && status.addon !== 'not_connected' && status.addon !== 'error',
    JSON.stringify(setup),
  )
  check(
    'and says the hooks still need the person’s approval inside Codex',
    status?.addon === 'needs_approval' && /Trust all/.test(status.detail ?? ''),
    JSON.stringify(status),
  )

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

  // The approval is a screen in Codex's own interface; a run with no person at it stands in for "approved"
  codex = spawn(
    'codex',
    ['--dangerously-bypass-hook-trust', '-c', `model="${model}"`, '-c', 'model_reasoning_effort="low"', 'app-server', '--listen', 'stdio://'],
    { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  codex.stderr.on('data', (c) => (stderr += c))
  const seen = []
  transcript = () => `${seen.map((s) => JSON.stringify(s)).join('\n')}\n${stderr}`
  const waiting = new Map()
  let nextId = 1
  let buf = ''
  codex.stdout.on('data', (c) => {
    buf += c
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && waiting.has(m.id)) {
        const { resolve, reject } = waiting.get(m.id)
        waiting.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      } else if (m.method && m.id !== undefined) codex.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: 'accept' } })}\n`)
      else if (m.method) seen.push(m)
    }
  })
  // A request is answered, or fails: when Codex ends or cannot be written to with requests
  // still unanswered, and when one has gone a minute without an answer. Nothing waits for good.
  const gaveUp = (why) => {
    for (const [id, { reject }] of waiting) {
      waiting.delete(id)
      reject(new Error(why))
    }
  }
  codex.on('error', () => gaveUp('Codex could not be started'))
  codex.on('close', () => gaveUp('Codex ended with a request unanswered'))
  codex.stdin.on('error', () => gaveUp('Codex could not be written to'))
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const late = setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`Codex did not answer ${method} within a minute`))
      }, 60_000)
      const done = (settle) => (value) => {
        clearTimeout(late)
        settle(value)
      }
      waiting.set(id, { resolve: done(resolve), reject: done(reject) })
      codex.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  // A turn counts as having come to its end only where Codex says it completed: one that
  // failed or was interrupted is told of by the same message, and is no turn that worked
  const count = (method) => seen.filter((s) => s.method === method && (method !== 'turn/completed' || s.params?.turn?.status === 'completed')).length
  const until = async (method, n, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end && count(method) < n) await sleep(200)
    return count(method) >= n
  }
  const said = (from) =>
    seen
      .slice(from)
      .filter((s) => s.method === 'item/completed' && s.params?.item?.type === 'agentMessage')
      .map((s) => s.params.item.text)
      .join('\n')
  /** Whether the conversation was given a click since `from`, whatever the model then chose to say about it. */
  const heard = (from) => seen.slice(from).some((s) => JSON.stringify(s.params ?? {}).includes('sent this just after someone used it'))
  const turn = (threadId, text) => request('turn/start', { threadId, input: [{ type: 'text', text }] })

  await request('initialize', { clientInfo: { name: 'it-e2e', title: 'It end to end', version: '0' }, capabilities: { experimentalApi: true } })
  codex.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  const started = await request('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const threadId = started?.thread?.id

  await turn(
    threadId,
    `Run this exact shell command, and nothing else:\n\nit create "Approve deploy ${PRIVATE_MARK}title" --id ${slug} --html '<h1>Deploy</h1><button id="go" onclick="It.action(\`approve\`, {plan: \`${PRIVATE_MARK}B\`})">Approve</button>'\n\nThen reply with only the word READY.`,
  )
  check('Codex publishes a page with the it command', await until('turn/completed', 1, 120_000), stderr.slice(-400))
  const made = await it(home, ['read', slug]).catch((e) => ({ error: e.message }))
  check(
    'the page remembers which conversation made it',
    made.session?.harness === 'codex' && made.session?.id === threadId,
    JSON.stringify({ made: made.session ?? made.error, threadId }),
  )

  const one = await open('owner')
  browser = one.browser
  browsers.push(one)
  await one.page.goto(`${APP}/p/${slug}`)
  const frame = one.page.frameLocator('.mount iframe')
  await frame.locator('#go').waitFor({ timeout: 30_000 })

  // Before the person has approved the hooks, Codex runs none of them. A click during a turn
  // then waits in Codex's own queue and runs as the next turn; nothing is lost. The command
  // leaves a file as it begins, and the click is made once that file is there: while the turn
  // is running its command, and neither before it nor after.
  let mark = seen.length
  const begun = path.join(work, 'begun')
  await turn(
    threadId,
    `Run the shell command: python3 -c "import time; open('${begun}', 'w').close(); time.sleep(14); print(42)"\n\nThen reply with only what it printed.`,
  )
  check('Codex starts the command, which runs for a while', await untilThere(begun, 90_000), said(mark))
  await sleep(1500)
  await frame.locator('#go').click()
  check('hooks not yet approved: a click during a turn starts the next turn', (await until('turn/completed', 3, 150_000)) && heard(mark), said(mark))
  const queued = (await it(home, ['read', slug])).recentActions?.[0]
  check('delivered by Codex’s own queue', queued?.delivery === 'handed_off' && queued?.route === 'queue', JSON.stringify(queued))
  // Waited for here, before the next click is made, so that which click was counted how is known
  check(
    'usage counts a click Codex’s queue took as having woken the agent',
    await untilReported('woke', 'codex'),
    JSON.stringify(reported().map((e) => [e.name, e.properties])),
  )

  // Idle: the click goes into Codex's own queue and starts a turn
  await sleep(4000)
  mark = seen.length
  const turnsBefore = count('turn/started')
  await frame.locator('#go').click()
  check('a click while Codex is idle starts a turn with nothing typed', await until('turn/started', turnsBefore + 1, 60_000))
  const cameToItsEnd = await until('turn/completed', 4, 90_000)
  check('and that turn is the click, in It’s own words, and comes to its end', cameToItsEnd && heard(mark), said(mark))
  check('usage counts that one the same way', await untilReported('woke,woke', 'codex'), JSON.stringify(reported().map((e) => [e.name, e.properties])))
  codex.stdin.end()
  await stopped(codex)

  // With the hooks approved (here: a run with no person at it, told to trust them), a click
  // during a running command rides along with that command's result, in the same turn.
  const slug2 = `${slug}-hooks`
  const begunWithHooks = path.join(work, 'begun-with-hooks')
  let out = ''
  exec = spawn(
    'codex',
    [
      'exec',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-m',
      model,
      '-c',
      'model_reasoning_effort="low"',
      `First run this exact shell command:\n\nit create "Hooks ${PRIVATE_MARK}title" --id ${slug2} --html '<button id="go" onclick="It.action(\`approve\`, {plan: \`${PRIVATE_MARK}C\`})">Approve</button>'\n\nThen run this one: python3 -c "import time; open('${begunWithHooks}', 'w').close(); time.sleep(30); print(42)"\n\nThen answer in two lines: line one is what the second command printed; line two is a word-for-word copy of anything else you were told alongside its result, or NOTHING EXTRA.`,
    ],
    { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  exec.stdout.on('data', (d) => (out += d))
  exec.stderr.on('data', (d) => (out += d))
  const earlier = transcript
  transcript = () => `${earlier()}\n${out}`
  const finished = new Promise((resolve) => exec.on('close', resolve))
  let exists = false
  for (let i = 0; i < 120 && !exists; i++) {
    exists = await it(home, ['read', slug2]).then(
      (p) => p.version === 1,
      () => false,
    )
    if (!exists) await sleep(500)
  }
  await one.page.goto(`${APP}/p/${slug2}`)
  const frame2 = one.page.frameLocator('.mount iframe')
  await frame2.locator('#go').waitFor({ timeout: 30_000 })
  // The second command leaves a file as it begins, and runs for thirty seconds from then
  const running = await untilThere(begunWithHooks, 120_000)
  await sleep(1500)
  const runningFor = running ? Date.now() - statSync(begunWithHooks).mtimeMs : null
  await frame2.locator('#go').click()
  check(
    'hooks approved: the click is made while Codex is running the second command',
    running && runningFor < 25_000,
    running ? `the command had begun ${Math.round(runningFor / 1000)} seconds before` : out.slice(-400),
  )
  const ended = await Promise.race([finished.then((code) => ({ code })), sleep(150_000).then(() => null)])
  check(
    'and Codex then comes to its end by itself, without a fault',
    ended?.code === 0,
    ended ? `it ended with ${ended.code}` : 'it had not ended after 150 seconds',
  )
  // What Codex answered comes after the last line that says only "codex". Where it printed no
  // such line there is no answer to tell apart from what it was told, and none is taken
  const answer = out.includes('codex\n') ? out.split('codex\n').pop() : ''
  check('and the click is given to Codex with that command’s result', /sent this just after someone used it/i.test(answer), out.slice(-600))
  const viaHook = (await it(home, ['read', slug2])).recentActions?.[0]
  check('It records that the add-on handed it over', viaHook?.delivery === 'handed_off' && viaHook?.route === 'addon', JSON.stringify(viaHook))
  const now = (await it(home, ['status'])).harnesses.find((h) => h.id === 'codex')
  check('once a hook has run, setup stops asking for approval', now?.addon === 'connected', JSON.stringify(now))
  await it(home, ['delete', slug2]).catch(() => {})
  // Two clicks went through Codex's own queue, which starts a turn, and one rode a hook in a turn that was running
  check(
    'and the click a hook took in a turn that was running as heard at once',
    await untilReported('heard,woke,woke', 'codex'),
    JSON.stringify(reported().map((e) => [e.name, e.properties])),
  )
  check(
    'and counts two wakings, both resumed',
    reported()
      .filter((e) => e.name === 'agent.woken')
      .map((e) => `${e.properties.agent} ${e.properties.result}`)
      .join() === 'codex resumed,codex resumed',
    JSON.stringify(reported().filter((e) => e.name === 'agent.woken')),
  )
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  // Everything the run started is stopped, and waited for, before anything it wrote is read or removed
  if (codex && !codex.stdin.destroyed) codex.stdin.end()
  await Promise.all([stopped(codex), stopped(exec), stopped(connector)])
  await browser?.close().catch(() => {})
  // Leave the person's Codex as it was found: done first, before anything else here that could
  // go wrong, and only by a run that got as far as putting the add-on in
  const taken = ours ? await takeOut('codex', home) : null
  const stillIn = taken !== null && !taken.out
  if (taken) {
    const undone = taken.setup
    check(
      'disconnecting removes the add-on again, and Codex itself says it has gone',
      // Codex says it is gone, and so the note that it was installed is gone too: nothing is left to try again
      !undone.error &&
        undone.harnesses.find((h) => h.id === 'codex')?.addon === 'not_connected' &&
        !existsSync(path.join(home, 'addons', 'codex.json')) &&
        taken.out,
      JSON.stringify(undone),
    )
  }
  if (existsSync(saved)) {
    const same = readFileSync(saved, 'utf8') === readFileSync(config, 'utf8')
    if (!same) copyFileSync(saved, config)
    check('Codex’s own settings are as they were found', same)
  }
  await usage.close().catch(() => {})
  // Everything that was reported, down to what a connector sent as it stopped
  const wrong = wrongWithUsage(usage)
  check('everything reported as usage is what a batch may be, and was sent as one may be sent', wrong.length === 0, wrong.slice(0, 3).join('; '))
  await it(home, ['delete', slug]).catch(() => {})
  // A folder that is kept stays one of the stack's machines: it holds the note of what was put where
  if (!stillIn) await it(home, ['logout']).catch(() => {})
  // What the browser's tabs wrote and what Codex itself printed are kept with the rest, so
  // that the check below reads them too. Codex's own conversation was given the page's title and
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
