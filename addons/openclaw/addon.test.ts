// The OpenClaw add-on, run against a stand-in for what OpenClaw hands a plugin and a stand-in
// for the connector. Nothing here touches a real OpenClaw. What it must get right: commands are
// told which conversation they are in, each click reaches the conversation that made the page
// exactly once and no other, and it is reported as given only when it really was.
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeClick } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface Click {
  id: string
  text: string
}
const MAIN = 'agent:main:main'
const GROUP = 'agent:main:telegram:group:-1001'
const TOKEN = 'a'.repeat(48)

let home: string
let server: http.Server
/** What the stand-in connector will offer each conversation, and what it was asked. */
let offered: Record<string, Click[]>
let asked: { path: string; body: any }[]
let hosts: ReturnType<typeof fakeOpenClaw>[]
let homeBefore: string | undefined
/** Everything the stand-in connector was sent, word for word: the first line, the headers and the body of each request. */
let received: string[]
/** How the stand-in connector seals its answers over a port: as the real one does, with another token, or not at all. */
let sealing: 'right' | 'wrong' | 'none'
/** Other stand-ins a test started, which are closed when it ends. */
let others: http.Server[]

/**
 * A stand-in for the connector. On a socket file it is shown the token, as on Linux and macOS.
 * On a port, as on Windows, the token is never sent: each request carries a code made from it,
 * and so does each answer.
 */
function fakeConnector(listenOn: string | number): Promise<http.Server> {
  const overPort = typeof listenOn === 'number'
  const s = http.createServer((req, res) => {
    let text = ''
    req
      .on('data', (c) => (text += c))
      .on('end', () => {
        received.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${text}`)
        const nonce = String(req.headers['x-it-nonce'] ?? '')
        const sealed = (token: string, what: string) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')
        const known = overPort ? req.headers['x-it-mac'] === sealed(TOKEN, `${req.method}\n${req.url}\n${text}`) : req.headers['x-it-token'] === TOKEN
        if (!known) {
          res.writeHead(401).end('{}')
          return
        }
        const body = text ? JSON.parse(text) : null
        const url = new URL(req.url ?? '/', 'http://it')
        asked.push({ path: req.url ?? '', body })
        if (url.pathname === '/ack') for (const k of Object.keys(offered)) offered[k] = offered[k]!.filter((c) => !body.ids.includes(c.id))
        const answer = JSON.stringify(url.pathname === '/clicks' ? { clicks: offered[url.searchParams.get('session') ?? ''] ?? [] } : { ok: true })
        const seal = overPort && sealing !== 'none' ? { 'x-it-mac': sealed(sealing === 'right' ? TOKEN : 'b'.repeat(48), `200\n${answer}`) } : {}
        res.writeHead(200, { 'content-type': 'application/json', ...seal })
        res.end(answer)
      })
  })
  return new Promise((resolve) => (overPort ? s.listen(listenOn, '127.0.0.1', () => resolve(s)) : s.listen(listenOn, () => resolve(s))))
}
/** Starts a stand-in connector on a port of this machine, and writes the file that says where it is. */
async function onPort(server: http.Server | Promise<http.Server>): Promise<http.Server> {
  const s = await server
  others.push(s)
  writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: (s.address() as { port: number }).port, token: TOKEN }))
  return s
}

/**
 * A stand-in for the `api` OpenClaw hands a plugin's `register`. `turns` are the messages the
 * plugin asked OpenClaw to put into a conversation, each of which the test then starts,
 * finishes or refuses, as OpenClaw would.
 */
function fakeOpenClaw(parts: { dispatch?: boolean } = {}) {
  const hooks: Record<string, (event: any, ctx: any) => any> = {}
  const services: { id: string; start: () => void; stop: () => void }[] = []
  const turns: { plan: any; begin: () => void; finish: (result?: unknown) => void; refuse: (why?: unknown) => void }[] = []
  const warnings: string[] = []
  /** What OpenClaw has on record for each conversation. */
  const entries: Record<string, any> = {
    [MAIN]: {
      sessionId: 's-1',
      delivery: { kind: 'external', context: { channel: 'telegram', to: 'telegram:42', accountId: 'default' }, route: {}, origin: {} },
    },
    [GROUP]: {
      sessionId: 's-2',
      delivery: { kind: 'external', context: { channel: 'telegram', to: 'telegram:-1001', accountId: 'default', threadId: 7 }, route: {}, origin: {} },
    },
    'agent:main:dashboard:abc': { sessionId: 's-3', delivery: { kind: 'internal' } },
  }
  const config = { session: {} }
  const api = {
    id: 'it-bridge',
    registrationMode: 'full',
    logger: { debug() {}, info() {}, warn: (line: string) => void warnings.push(line), error() {} },
    on: (name: string, fn: (event: any, ctx: any) => any) => {
      hooks[name] = fn
    },
    registerService: (s: any) => void services.push(s),
    runtime: {
      version: '2026.9.6',
      config: { current: () => config },
      agent: { session: { getSessionEntry: ({ sessionKey }: { agentId?: string; sessionKey: string }) => entries[sessionKey] } },
      channel: {
        inbound:
          parts.dispatch === false
            ? {}
            : {
                dispatch: (plan: any) =>
                  new Promise((resolve, reject) =>
                    turns.push({
                      plan,
                      begin: () => plan.replyOptions?.onAgentRunStart?.('run-1'),
                      finish: (result = { dispatched: true, admission: { kind: 'dispatch' } }) => resolve(result),
                      refuse: (why = new Error('refused')) => reject(why),
                    }),
                  ),
              },
      },
    },
  }
  /** The agent runs a shell command in a conversation: OpenClaw asks plugins for its environment. */
  const runsCommand = (sessionKey: string | undefined, ctx: Record<string, unknown> = { agentId: 'main' }) =>
    hooks.resolve_exec_env!({ sessionKey, toolName: 'exec', host: 'gateway' }, { sessionKey, ...ctx })
  return { api, hooks, services, turns, warnings, entries, config, runsCommand }
}

/** Starts the plugin as the gateway would: registers it, then starts its service. */
async function start(parts: { dispatch?: boolean } = {}) {
  vi.resetModules()
  const plugin = (await import('./index.js')).default
  const host = fakeOpenClaw(parts)
  plugin.register(host.api)
  for (const s of host.services) s.start()
  hosts.push(host)
  return host
}
// The real clock, kept from before any test puts a stand-in in its place
const really = setTimeout
const reallyNext = setImmediate
/** Everything that is ready to run has run, and whatever it set going has got as far as it can without waiting on something outside. */
const turn = () => new Promise((r) => reallyNext(r))
/** Waits on the real clock for something to have come about, and says what was waited for when it has not. */
async function until(what: () => boolean, name: string) {
  const end = performance.now() + 8000
  while (!what()) {
    if (performance.now() > end) throw new Error(`Eight seconds went by, and this had not come about: ${name}`)
    await new Promise((r) => really(r, 5))
  }
}
/**
 * The questions the plugin has put to the connector, counted where it puts them: how many are
 * not over yet. Whatever the plugin does about an answer it does the moment it has read it,
 * with nothing else getting a turn in between, so once none is waited for the plugin has
 * acted on every answer.
 */
let questions = { waiting: 0 }
const request = http.request
function watchQuestions() {
  // Each test counts for itself: a question an earlier test left unanswered ends in that test's count
  const seen = { waiting: 0 }
  questions = seen
  http.request = ((...given: unknown[]) => {
    seen.waiting++
    const req = (request as (...given: unknown[]) => http.ClientRequest)(...given)
    req.once('close', () => seen.waiting--)
    return req
  }) as typeof http.request
}
/**
 * The plugin waits on nothing outside itself: every question it had put to the connector is
 * over, and it has done whatever it does about each answer. A turn is given first, by which
 * whatever was just set going has put its question, if it is going to.
 */
async function settle() {
  await turn()
  await until(() => questions.waiting === 0, 'the plugin has read every answer it asked for')
  await turn()
}
/** A second passes: the plugin asks the connector once more, and that round of asking is over before anything else is done. */
async function tick(seconds = 1) {
  for (let i = 0; i < seconds; i++) {
    vi.advanceTimersByTime(1000)
    await settle()
  }
}
const acks = () => asked.filter((a) => a.path === '/ack').flatMap((a) => a.body.ids as string[])
const clicksPath = (session: string) => `/clicks?harness=openclaw&session=${encodeURIComponent(session)}`

beforeEach(async () => {
  // Only the plugin's once-a-second clock and the time of day are stand-ins. The connector is asked for real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  home = mkdtempSync(path.join(os.tmpdir(), 'it-openclaw-'))
  homeBefore = process.env.IT_HOME
  process.env.IT_HOME = home
  offered = {}
  asked = []
  hosts = []
  received = []
  sealing = 'right'
  others = []
  server = await fakeConnector(path.join(home, 'connector.sock'))
  writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: path.join(home, 'connector.sock'), token: TOKEN }))
  watchQuestions()
})
afterEach(async () => {
  for (const host of hosts) for (const s of host.services) s.stop()
  http.request = request
  vi.useRealTimers()
  if (homeBefore === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = homeBefore
  for (const s of [server, ...others]) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
  rmSync(home, { recursive: true, force: true })
})

describe('the OpenClaw add-on', () => {
  test('commands the agent runs are told which conversation they are in, through OpenClaw’s own hook', async () => {
    const host = await start()
    expect(Object.keys(host.hooks)).toEqual(['resolve_exec_env'])
    expect(host.runsCommand(MAIN)).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: MAIN })
    // The agent is read from the key when OpenClaw does not say which it is
    expect(host.runsCommand(GROUP, {})).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: GROUP })
    // With no conversation, or one this add-on could not ask the connector about, nothing is said
    expect(host.runsCommand(undefined)).toBeUndefined()
    expect(host.runsCommand('not-a-full-key', {})).toBeUndefined()
    expect(host.runsCommand(`agent:main:${'x'.repeat(200)}`)).toBeUndefined()
  })

  test('a subagent’s commands, and a scheduled run’s, are given no conversation, and nothing is asked about them', async () => {
    const host = await start()
    const keys = [
      'agent:main:subagent:6f1c',
      'agent:main:subagent:6f1c:subagent:22aa',
      'agent:main:SubAgent:6f1c',
      'agent:main:cron:nightly',
      'agent:main:cron:nightly:run:7',
      'cron:nightly',
    ]
    for (const key of keys) {
      host.entries[key] = { sessionId: 's-9', delivery: { kind: 'internal' } }
      offered[key] = [{ id: `click-${key}`, text: 'one' }]
      expect(host.runsCommand(key)).toBeUndefined()
    }
    await tick(2)
    expect(asked).toEqual([])
    expect(host.turns).toEqual([])
    // A key that only has such a word inside one of its parts is a conversation like any other
    expect(host.runsCommand('agent:main:telegram:group:cronies')).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: 'agent:main:telegram:group:cronies' })
  })

  test('a subagent’s key that the file of conversations holds is not asked about, and is not kept', async () => {
    const helper = 'agent:main:subagent:6f1c'
    const saved = { [helper]: { agent: 'main', seen: Date.now() }, [MAIN]: { agent: 'main', seen: Date.now() } }
    writeFileSync(path.join(home, 'openclaw-sessions.json'), JSON.stringify(saved))
    const host = await start()
    host.entries[helper] = { sessionId: 's-9', delivery: { kind: 'internal' } }
    offered[helper] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN)])
    expect(host.turns).toEqual([])
    expect(Object.keys(JSON.parse(readFileSync(path.join(home, 'openclaw-sessions.json'), 'utf8')))).toEqual([MAIN])
  })

  test('asks the connector about a conversation once it has run a command, by OpenClaw’s own key for it, and about no other', async () => {
    const host = await start()
    await tick(2)
    expect(asked).toEqual([])
    host.runsCommand(MAIN)
    await tick()
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN)])
    host.runsCommand(GROUP)
    await tick()
    expect(
      asked
        .slice(1)
        .map((a) => a.path)
        .sort(),
    ).toEqual([clicksPath(MAIN), clicksPath(GROUP)].sort())
  })

  test('a click is given to the conversation that made the page, in the connector’s own words, and to no other', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    host.runsCommand(GROUP)
    // The words an agent is given for a click, as the connector makes them
    const text = describeClick({ id: 'click-1', artifact: 'plan', title: 'Plan', name: 'approve', payload: {}, at: 1, attended: true })
    offered[GROUP] = [{ id: 'click-1', text }]
    await tick()
    expect(host.turns.length).toBe(1)
    const { plan } = host.turns[0]!
    expect(plan.route).toEqual({ agentId: 'main', sessionKey: GROUP })
    expect(plan.cfg).toBe(host.config)
    expect(plan.ctxPayload).toEqual({
      Body: text,
      RawBody: text,
      BodyForAgent: text,
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
      SessionKey: GROUP,
      AgentId: 'main',
      // Where this conversation's answers already go, so the answer to the click goes there too
      OriginatingChannel: 'telegram',
      OriginatingTo: 'telegram:-1001',
      AccountId: 'default',
      MessageThreadId: 7,
    })
    // A click must never start a conversation, and this add-on sends nothing anywhere itself
    expect(plan.record).toEqual({ createIfMissing: false })
    expect(await plan.delivery.deliver({ text: 'an answer' }, { kind: 'final' })).toEqual({ visibleReplySent: false })
    expect(JSON.stringify(plan)).not.toContain(MAIN)
  })

  test('a conversation held in OpenClaw’s own window is given the click with no address to answer to', async () => {
    const host = await start()
    host.runsCommand('agent:main:dashboard:abc')
    offered['agent:main:dashboard:abc'] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns[0]!.plan.ctxPayload).toEqual({
      Body: 'one',
      RawBody: 'one',
      BodyForAgent: 'one',
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
      SessionKey: 'agent:main:dashboard:abc',
      AgentId: 'main',
    })
  })

  test('a click is reported only once the agent has it: when its turn starts', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns.length).toBe(1)
    expect(acks()).toEqual([])
    // The turn starts. It may run for minutes, and the click is the agent's from this moment.
    host.turns[0]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
    // The turn failing later does not make the click anyone's to give again
    host.turns[0]!.refuse()
    await tick(2)
    expect(host.turns.length).toBe(1)
    expect(host.warnings).toEqual([])
  })

  test('clicks that arrive together are given together, each in the connector’s words', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [
      { id: 'click-1', text: 'one' },
      { id: 'click-2', text: 'two' },
    ]
    await tick()
    expect(host.turns.map((t) => t.plan.ctxPayload.Body)).toEqual(['one\ntwo'])
    host.turns[0]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1', 'click-2'])
  })

  test('a message OpenClaw says it dispatched is not reported as given unless the agent’s turn started, and is tried again', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    // OpenClaw finishes with the message and says it was dispatched, but no turn ever started:
    // the conversation was busy, or the turn was stopped. The agent may never have seen it.
    host.turns[0]!.finish()
    await settle()
    expect(acks()).toEqual([])
    expect(host.warnings.length).toBe(1)
    // Five seconds later it is tried again, and not before
    await tick(4)
    expect(host.turns.length).toBe(1)
    await tick()
    expect(host.turns.length).toBe(2)
    host.turns[1]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
  })

  test('a turn that starts after OpenClaw had finished with the message still counts, and the click is not given again', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    host.turns[0]!.finish()
    await settle()
    expect(acks()).toEqual([])
    // OpenClaw had kept the message for later, and now starts the turn that carries it
    host.turns[0]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
    await tick(8)
    expect(host.turns.length).toBe(1)
  })

  test('a click still on offer while it is being handed over is not handed over twice', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    // OpenClaw has not taken it yet, and the connector is asked again, and again
    await tick(2)
    expect(host.turns.length).toBe(1)
    host.turns[0]!.begin()
    await settle()
    // The report was lost: the connector offers it once more. It is reported again, and not given again.
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    asked = []
    await tick()
    expect(host.turns.length).toBe(1)
    expect(acks()).toEqual(['click-1'])
  })

  test('a click OpenClaw refused is not reported as given, and is tried again after a while, not at once', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    host.turns[0]!.refuse()
    await settle()
    expect(acks()).toEqual([])
    expect(host.warnings.length).toBe(1)
    // Five seconds after the first refusal
    await tick(4)
    expect(host.turns.length).toBe(1)
    await tick()
    expect(host.turns.length).toBe(2)
    // OpenClaw answers, but says it did not take the message: that is a refusal too
    host.turns[1]!.finish({ dispatched: false, admission: { kind: 'drop', reason: 'bot-loop-protection' } })
    await settle()
    expect(acks()).toEqual([])
    // And fifteen after the second
    await tick(14)
    expect(host.turns.length).toBe(2)
    await tick()
    expect(host.turns.length).toBe(3)
    host.turns[2]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
  })

  test('a conversation that refuses three times in a row is left alone for ten minutes, whatever commands it runs meanwhile', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    host.turns[0]!.refuse()
    await settle()
    await tick(6)
    host.turns[1]!.finish({ dispatched: false, admission: { kind: 'drop', reason: 'bot-loop-protection' } })
    await settle()
    await tick(16)
    expect(host.turns.length).toBe(3)
    host.turns[2]!.refuse()
    await settle()
    expect(host.warnings.length).toBe(3)
    expect(acks()).toEqual([])
    // Asking would keep the click set aside for this add-on, so nothing is asked, however long it goes on
    asked = []
    await tick(3)
    // A turn that is still running goes on running commands. They are told which conversation
    // they are in, and the click is not sent three more times because of them.
    expect(host.runsCommand(MAIN)).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: MAIN })
    await tick(3)
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)
    host.runsCommand(MAIN)
    await tick(3)
    expect(asked).toEqual([])
    expect(host.turns.length).toBe(3)
    // It is not remembered across a restart of OpenClaw either
    expect(JSON.parse(readFileSync(path.join(home, 'openclaw-sessions.json'), 'utf8'))).toEqual({})
    // Ten minutes on the conversation is in use again: it is asked about, and its click is tried, as before
    vi.setSystemTime(Date.now() + 2 * 60 * 1000)
    host.runsCommand(MAIN)
    await tick()
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN)])
    expect(host.turns.length).toBe(4)
  })

  test('a hand-over OpenClaw says nothing about counts as refused after ten minutes, and the click is tried again', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns.length).toBe(1)
    // OpenClaw neither starts a turn nor finishes with the message
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)
    await tick(2)
    expect(host.turns.length).toBe(1)
    expect(host.warnings).toEqual([])
    vi.setSystemTime(Date.now() + 60 * 1000)
    await tick()
    expect(host.warnings.length).toBe(1)
    expect(host.warnings[0]).toMatch(/ and will be tried again: no_word$/)
    expect(host.turns.length).toBe(1)
    expect(acks()).toEqual([])
    await tick(6)
    expect(host.turns.length).toBe(2)
    // Should the first turn start after all, the agent has the click, and that is reported
    host.turns[0]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
  })

  test('and after those ten minutes it does not keep a conversation that has been quiet for a day from being forgotten', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns.length).toBe(1)
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    asked = []
    await tick(8)
    expect(asked).toEqual([])
    expect(host.turns.length).toBe(1)
  })

  test('what is written to OpenClaw’s log about a refusal is a fixed word for its kind and a shortened id, and never the error’s words or the conversation’s key', async () => {
    const host = await start()
    // A key can hold an address: a telephone number, a chat's id, an account's name
    const key = 'agent:main:whatsapp:dm:+15551234567'
    host.entries[key] = { sessionId: 's-4', delivery: { kind: 'internal' } }
    host.runsCommand(key)
    offered[key] = [{ id: 'click-1', text: 'one' }]
    await tick()
    // Each kind of refusal in turn: OpenClaw fails, says it did not take the message, and finishes without a turn
    host.turns[0]!.refuse(new Error('could not read /home/PRIVATE PERSON/project: TOKEN sk-secret'))
    await settle()
    await tick(6)
    host.turns[1]!.finish({ dispatched: false, admission: { kind: 'drop', reason: 'PRIVATE REASON' } })
    await settle()
    await tick(16)
    host.turns[2]!.finish()
    await settle()
    const short = createHash('sha256').update(key).digest('hex').slice(0, 8)
    expect(host.warnings).toEqual([
      `It: a click could not be given to a conversation (${short}) and will be tried again: dispatch_failed`,
      `It: a click could not be given to a conversation (${short}) and will be tried again: not_taken`,
      `It: a click could not be given to a conversation (${short}), 3 times in a row, and waits: no_turn_started`,
    ])
    // The call itself failing at once, and OpenClaw never saying what became of a click, each have a word of their own
    const other = await start()
    other.api.runtime.channel.inbound.dispatch = () => {
      throw Object.assign(new Error('PRIVATE WORDS'), { name: 'PRIVATE NAME', code: 'PRIVATE CODE' })
    }
    other.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-2', text: 'two' }]
    await tick()
    expect(other.warnings.length).toBe(1)
    expect(other.warnings[0]).toMatch(/^It: a click could not be given to a conversation \([0-9a-f]{8}\) and will be tried again: dispatch_threw$/)
    for (const line of [...host.warnings, ...other.warnings]) expect(line).not.toMatch(/PRIVATE|TOKEN|secret|whatsapp|5551234567|agent:main/)
  })

  test('a conversation that is gone is not started again by a click, and is not asked about again', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    delete host.entries[MAIN]
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns).toEqual([])
    expect(acks()).toEqual([])
    asked = []
    await tick(2)
    expect(asked).toEqual([])
  })

  test('a conversation that has been quiet for a day is not asked about, until it runs a command again', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    await tick()
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    asked = []
    await tick(2)
    expect(asked).toEqual([])
    host.runsCommand(MAIN)
    await tick()
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN)])
  })

  test('conversations are still asked about after OpenClaw is restarted', async () => {
    const before = await start()
    before.runsCommand(MAIN)
    await tick()
    for (const s of before.services) s.stop()
    expect(JSON.parse(readFileSync(path.join(home, 'openclaw-sessions.json'), 'utf8'))).toEqual({ [MAIN]: { agent: 'main', seen: expect.any(Number) } })
    // A new gateway: nothing has run a command in it yet
    const after = await start()
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    asked = []
    await tick()
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN)])
    expect(after.turns.map((t) => t.plan.route.sessionKey)).toEqual([MAIN])
    expect(before.turns).toEqual([])
  })

  test('once its service is stopped it asks nothing more', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    await tick()
    for (const s of host.services) s.stop()
    asked = []
    await tick(2)
    expect(asked).toEqual([])
  })

  test('an OpenClaw without the call that puts a message into a conversation is left alone: nothing is asked, so no click is held for it', async () => {
    const host = await start({ dispatch: false })
    expect(host.runsCommand(MAIN)).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: MAIN })
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick(2)
    expect(asked).toEqual([])
  })

  test('nothing in the connector’s file can point the add-on anywhere but the socket beside it', async () => {
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: '/tmp/somewhere-else.sock', port: '1@evil.example', token: TOKEN }))
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    // It still reached the real connector, on the socket in its own folder
    expect(host.turns.length).toBe(1)
  })

  test('over a port, as on Windows, the token is never sent, and only an answer sealed with it is believed', async () => {
    await onPort(fakeConnector(0))
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    // Something that took the connector's port answers without the seal: nothing it offers is given
    sealing = 'none'
    await tick(2)
    // The stand-in only notes a request whose own seal is right, as the real connector only answers such a one
    expect(asked.map((a) => a.path)).toEqual([clicksPath(MAIN), clicksPath(MAIN)])
    expect(host.turns).toEqual([])
    // Nor is an answer sealed by someone who does not know the token
    sealing = 'wrong'
    await tick(2)
    expect(host.turns).toEqual([])
    sealing = 'right'
    await tick()
    expect(host.turns.map((t) => t.plan.ctxPayload.Body)).toEqual(['one'])
    host.turns[0]!.begin()
    await settle()
    expect(acks()).toEqual(['click-1'])
    // And the token itself never went over the port, in a header or anywhere else
    expect(received.length).toBeGreaterThanOrEqual(6)
    for (const sent of received) {
      expect(sent).not.toContain(TOKEN)
      expect(sent).not.toContain('x-it-token')
    }
  })

  test('an answer too long to be the connector’s counts as no answer, and the next one is read as usual', async () => {
    const host = await start()
    host.runsCommand(MAIN)
    offered[MAIN] = [{ id: 'click-big', text: 'x'.repeat(300_000) }]
    await tick(2)
    expect(asked.length).toBe(2)
    expect(host.turns).toEqual([])
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    await tick()
    expect(host.turns.map((t) => t.plan.ctxPayload.Body)).toEqual(['one'])
  })

  test('an answer that never ends is given up on three seconds after asking, however steadily it arrives, and asking goes on', async () => {
    // The wait for an answer is on a stand-in clock here too, so that it ends when the test says
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    let asks = 0
    let pieces = 0
    let ended = 0
    // Something on the connector's port that answers a little at a time, for ever
    const slow = http.createServer((_req, res) => {
      asks++
      let open = true
      res.on('close', () => {
        open = false
        ended++
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      const drip = () => {
        if (!open) return
        res.write(' ', () => pieces++)
        really(drip, 20)
      }
      drip()
    })
    await onPort(new Promise<http.Server>((resolve) => slow.listen(0, '127.0.0.1', () => resolve(slow))))
    const host = await start()
    host.runsCommand(MAIN)
    vi.advanceTimersByTime(1000)
    await until(() => pieces >= 3, 'the answer has begun to arrive')
    // Up to the three seconds it is waited for, with more of it arriving all the while
    vi.advanceTimersByTime(2999)
    const before = pieces
    await until(() => pieces >= before + 3, 'more of the answer has arrived')
    expect([asks, ended]).toEqual([1, 0])
    // Then it is given up, though it was still arriving
    vi.advanceTimersByTime(1)
    await settle()
    await until(() => ended === 1, 'the question has been given up')
    expect(asks).toBe(1)
    // The check that was held up is over, and the next one asks again
    vi.advanceTimersByTime(1000)
    await until(() => asks === 2, 'the connector has been asked again')
    expect(host.turns).toEqual([])
  })

  test('It is looked for where it was when the add-on was set up, if nothing in the environment says where', async () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'home.js'), 'utf8')
    // `it setup` fills the folder in on this very line, so the line must stay exactly as it is
    expect(source.match(/^const IT_HOME_AT_SETUP = null$/gm)).toHaveLength(1)
    const copy = path.join(home, 'home.filled.mjs')
    writeFileSync(copy, source.replace(/^const IT_HOME_AT_SETUP = null$/m, `const IT_HOME_AT_SETUP = ${JSON.stringify(home)}`))
    const filled = await import(/* @vite-ignore */ pathToFileURL(copy).href)
    // A gateway started from a shell that knows nothing of It's folder
    delete process.env.IT_HOME
    expect(filled.connectorInfo()).toEqual({ socket: path.join(home, 'connector.sock'), port: null, token: TOKEN })
    filled.saveSessions([[MAIN, 'main', 5]])
    expect(JSON.parse(readFileSync(path.join(home, 'openclaw-sessions.json'), 'utf8'))).toEqual({ [MAIN]: { agent: 'main', seen: 5 } })
    // And what the environment says comes first
    process.env.IT_HOME = path.join(home, 'elsewhere')
    expect(filled.connectorInfo()).toBeNull()
  })

  test('with no connector, or a file that is not what the connector writes, it does nothing and breaks nothing', async () => {
    offered[MAIN] = [{ id: 'click-1', text: 'one' }]
    for (const content of ['', 'not json', '{}', '[]', JSON.stringify({ port: 80, token: 'short' }), JSON.stringify({ port: '8080', token: TOKEN })]) {
      writeFileSync(path.join(home, 'connector.json'), content)
      const host = await start()
      // Commands are still told their conversation: a page made now finds it once the connector runs
      expect(host.runsCommand(MAIN)).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: MAIN })
      await tick()
      expect(asked).toEqual([])
      expect(host.turns).toEqual([])
      expect(host.warnings).toEqual([])
    }
    rmSync(path.join(home, 'connector.json'))
    const host = await start()
    host.runsCommand(MAIN)
    await tick()
    expect(asked).toEqual([])
    expect(host.turns).toEqual([])
  })

  test('on a machine with no It at all, nothing is written and nothing breaks', async () => {
    process.env.IT_HOME = path.join(home, 'not-there')
    const host = await start()
    expect(host.runsCommand(MAIN)).toEqual({ IT_HARNESS: 'openclaw', IT_SESSION: MAIN })
    await tick()
    for (const s of host.services) s.stop()
    expect(existsSync(path.join(home, 'not-there'))).toBe(false)
    expect(asked).toEqual([])
  })

  test('the files OpenClaw reads before running anything agree with the plugin itself', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf8'))
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const plugin = (await import('./index.js')).default
    expect(manifest.id).toBe(plugin.id)
    expect(pkg.name).toBe(plugin.id)
    // Without this OpenClaw would not load the plugin when the gateway starts
    expect(manifest.activation).toEqual({ onStartup: true })
    expect(manifest.configSchema).toEqual({ type: 'object', additionalProperties: false, properties: {} })
    expect(pkg.openclaw.extensions).toEqual(['./index.js'])
    expect(existsSync(path.join(dir, 'index.js'))).toBe(true)
  })
})
