// The contract between the OpenCode add-on and the connector, checked without OpenCode: the
// add-on's own code runs against a stand-in for what OpenCode hands a plugin, and against a
// stand-in connector listening on a socket in a temporary folder.
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import files from 'node:fs/promises'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeClick, LISTENING_MOST, WHEN } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as addon from './plugins/it-bridge.js'

const TOKEN = 'ab'.repeat(24)
const within = { timeout: 8000, interval: 25 }
// The real clock, kept from before any test puts a stand-in in its place, so that a test can
// still wait for the connector to be asked while the add-on's own clock stands still
const really = setTimeout
const reallyEvery = setInterval
const reallyNext = setImmediate
const pause = (ms: number) => new Promise((r) => really(r, ms))
/** Everything that is ready to run has run, and whatever it set going has got as far as it can without waiting on something outside. */
const turn = () => new Promise((r) => reallyNext(r))
/** Waits on the real clock for something to have come about, and says what was waited for when it has not. */
async function reached(what: () => boolean, name: string) {
  const end = performance.now() + 8000
  while (!what()) {
    if (performance.now() > end) throw new Error(`Eight seconds went by, and this had not come about: ${name}`)
    await pause(5)
  }
}
const NO_FILE = Symbol('no connector file')

/**
 * What the add-on does outside itself, seen where it does it: the file it reads to find the
 * connector, and each question it puts to the connector. `waiting` is how many of those are
 * not over yet, `looked` how many times it has begun to read the file, and `put` how many
 * questions it has begun in all. Whatever the add-on does about a file or an answer it does
 * the moment it has read it, with nothing else getting a turn in between, so once nothing is
 * waited for the add-on has acted on all of it.
 */
let outside = { waiting: 0, looked: 0, put: 0 }
const itself = { connect: net.connect, readFile: files.readFile }
function watchOutside() {
  // Each test counts for itself: a question an earlier test left unanswered ends in that test's count, not this one's
  const seen = { waiting: 0, looked: 0, put: 0 }
  outside = seen
  // The add-on opens a connection of its own for each question, and closes it with the answer
  net.connect = ((...given: unknown[]) => {
    seen.waiting++
    seen.put++
    const socket = (itself.connect as (...given: unknown[]) => net.Socket)(...given)
    socket.once('close', () => seen.waiting--)
    return socket
  }) as typeof net.connect
  files.readFile = ((...given: unknown[]) => {
    seen.waiting++
    seen.looked++
    return (itself.readFile as (...given: unknown[]) => Promise<unknown>)(...given).finally(() => seen.waiting--)
  }) as typeof files.readFile
  syncBuiltinESMExports()
}
function watchNoMore() {
  net.connect = itself.connect
  files.readFile = itself.readFile
  syncBuiltinESMExports()
}
/**
 * The add-on waits on nothing outside itself: every round of asking it had begun is over, and
 * it has done whatever it does about each answer. A turn is given first, by which whatever
 * was just set going has read its file or put its question, if it is going to.
 */
async function settled() {
  await turn()
  await reached(() => outside.waiting === 0, 'the add-on has read every answer it asked for')
  await turn()
}

interface Asked {
  method: string
  path: string
  harness: string | null
  session: string | null
  token: string | undefined
  body: any
}
interface Click {
  id: string
  artifact: string
  title: string
  name: string
  payload: unknown
  at: number
  text: string
}
/** A click as the connector hands it over: with the words an agent is given for it, which the connector makes this way. */
const click = (id: string): Click => {
  const made = { id, artifact: 'deploy-plan', title: 'Deploy plan', name: 'approve', payload: { plan: 'B' }, at: 1 }
  return { ...made, text: describeClick({ ...made, attended: true }) }
}

/** A connector that answers as the real one does, and remembers everything it was asked. */
async function fakeConnector(listenOn: string | number) {
  const state = {
    token: TOKEN,
    offered: [] as Click[],
    /** When true an ack changes nothing, as if the connector never heard it. */
    deaf: false,
    /** When true, answers over a port carry no seal, as from something that took the connector's port. */
    unsealed: false,
    /** When above zero, each click offered is padded with this many characters, to make an answer longer than any real one. */
    padding: 0,
    asked: [] as Asked[],
    runtimes: [] as any[],
    acked: [] as string[],
  }
  const server = http.createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const url = new URL(req.url ?? '/', 'http://local')
    const body = text ? JSON.parse(text) : undefined
    if (url.pathname === '/addon') state.runtimes.push(body)
    if (url.pathname !== '/addon')
      state.asked.push({
        method: req.method ?? '',
        path: url.pathname,
        harness: url.searchParams.get('harness'),
        session: url.searchParams.get('session'),
        token: req.headers['x-it-token'] as string | undefined,
        body,
      })
    // Over a socket the token is shown. Over a port it is not: the request carries a code made
    // from it, and so does the answer, as the real connector's do.
    const overPort = typeof listenOn !== 'string'
    const nonce = String(req.headers['x-it-nonce'] ?? '')
    const sealed = (what: string) => createHmac('sha256', state.token).update(`${nonce}\n${what}`).digest('hex')
    const answer = (status: number, value: unknown) => {
      const text = JSON.stringify(value)
      res.writeHead(status, { 'content-type': 'application/json', ...(overPort && !state.unsealed ? { 'x-it-mac': sealed(`${status}\n${text}`) } : {}) })
      res.end(text)
    }
    const known = overPort
      ? req.headers['x-it-mac'] === sealed(`${req.method}\n${req.url}\n${text}`) && req.headers['x-it-token'] === undefined
      : req.headers['x-it-token'] === state.token
    if (!known) return answer(401, { error: 'not for you' })
    if (url.pathname === '/clicks') {
      return answer(200, { clicks: state.padding ? state.offered.map((c) => ({ ...c, title: 'x'.repeat(state.padding) })) : state.offered })
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      state.acked.push(...body.ids)
      if (!state.deaf) state.offered = state.offered.filter((c) => !body.ids.includes(c.id))
      return answer(200, { ok: true, acked: body.ids.length })
    }
    if (req.method === 'POST' && url.pathname === '/addon') return answer(200, { ok: true })
    if (req.method === 'POST' && url.pathname === '/session') return answer(200, { ok: true })
    return answer(404, { error: 'no such thing' })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (typeof listenOn === 'string') server.listen(listenOn, resolve)
    else server.listen(listenOn, '127.0.0.1', resolve)
  })
  return {
    state,
    port: typeof listenOn === 'string' ? 0 : (server.address() as { port: number }).port,
    polls: () => state.asked.filter((a) => a.path === '/clicks'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * What OpenCode hands a plugin, cut down to the two calls the add-on makes, and what OpenCode
 * then tells its plugins. As the real one does (seen in OpenCode 1.18.34): it answers 204 as
 * soon as it has agreed to try, and only afterwards shows the message to every plugin, stores
 * it, and stores its text, announcing each of those. Any of them can still fail.
 */
function fakeOpenCode(parents: Record<string, string> = {}) {
  const prompts: { path: { id: string }; body: any }[] = []
  /** The messages that really got into a conversation, text and all. */
  const conversation: string[] = []
  let hooks: any = null
  let made = 0
  const state = {
    /** How many of the next messages OpenCode refuses. */
    refuse: 0,
    missing: false,
    /** How many of the next messages OpenCode neither takes nor refuses, until `release` is called. */
    hang: 0,
    release: () => {},
    /** How many times OpenCode was asked to take a message, whatever came of it. */
    tried: 0,
    /** When true, OpenCode cannot say who started a conversation. */
    lost: false,
    /**
     * What becomes of each of the next messages OpenCode agreed to take. With nothing listed it
     * is stored. 'fails': another plugin refuses it, and OpenCode says something went wrong.
     * 'silent': nothing more is heard of it. 'held': the message is stored, and its text only
     * once `finish` is called.
     */
    next: [] as ('stored' | 'fails' | 'silent' | 'held')[],
    finish: () => {},
  }
  const say = (type: string, properties: unknown) => hooks.event({ event: { type, properties } })
  /** OpenCode takes a message into a conversation, telling its plugins each step in the order the real one does. */
  async function take(sessionID: string, body: any, what: 'stored' | 'fails' | 'held') {
    const model = body.model ? { ...body.model, ...(body.variant ? { variant: body.variant } : {}) } : undefined
    const message = { id: `msg_${++made}`, role: 'user', sessionID, agent: body.agent, ...(model ? { model } : {}) }
    const parts = body.parts.map((p: any, i: number) => ({ id: `prt_${made}_${i}`, type: 'text', sessionID, messageID: message.id, text: p.text }))
    await hooks['chat.message']({ sessionID, agent: message.agent, model: body.model }, { message, parts })
    if (what === 'fails')
      return say('session.error', { sessionID, error: { name: 'UnknownError', data: { message: 'Error: another plugin refuses this message' } } })
    await say('message.updated', { info: message })
    if (what === 'held') {
      await new Promise<void>((resolve) => {
        state.finish = resolve
      })
    }
    for (const part of parts) await say('message.part.updated', { part })
    conversation.push(parts.map((p: any) => p.text).join(''))
  }
  const client = {
    session: {
      // The real call answers 204 with nothing in it once OpenCode has agreed to try
      promptAsync: async (options: { path: { id: string }; body: any }) => {
        state.tried++
        if (state.missing) return { error: { name: 'NotFoundError' }, response: { ok: false, status: 404 } }
        if (state.refuse > 0) {
          state.refuse--
          return { error: { name: 'BadRequest' }, response: { ok: false, status: 400 } }
        }
        if (state.hang > 0) {
          state.hang--
          await new Promise<void>((resolve) => {
            state.release = resolve
          })
        }
        prompts.push(options)
        // The plugin often hears what became of the message before it sees the answer to its
        // call, as it did with the real OpenCode. Only a message whose text is held back is
        // heard of later.
        const what = state.next.shift() ?? 'stored'
        const told = what === 'silent' || !hooks ? Promise.resolve() : take(options.path.id, options.body, what).catch(() => {})
        if (what !== 'held') await told
        return { data: {}, response: { ok: true, status: 204 } }
      },
      get: async ({ path: { id } }: { path: { id: string } }) =>
        state.lost
          ? { error: { name: 'UnknownError' }, response: { ok: false, status: 500 } }
          : { data: { id, ...(parents[id] ? { parentID: parents[id] } : {}) }, response: { ok: true, status: 200 } },
    },
  }
  return {
    client,
    prompts,
    conversation,
    state,
    /** OpenCode has loaded the plugin, and from now on tells it what happens. */
    attach: (loaded: unknown) => {
      hooks = loaded
    },
    /** The person writes in a conversation, and OpenCode stores what they wrote. */
    writes: (sessionID: string, text: string) => take(sessionID, { agent: 'build', parts: [{ type: 'text', text }] }, 'stored'),
  }
}

type Hooks = Awaited<ReturnType<typeof addon.default.server>>
const texts = (prompts: { body: any }[]) => prompts.map((p) => p.body.parts.map((x: any) => x.text).join(''))

describe('the OpenCode add-on', () => {
  it('adds when a page is the answer to the agent’s instructions, last and once, in the words every add-on says', async () => {
    const opencode = fakeOpenCode()
    const hooks = await addon.default.server({ client: opencode.client } as any)
    const output = { system: ['You are OpenCode.'] }
    await hooks['experimental.chat.system.transform']({ model: {} }, output)
    await hooks['experimental.chat.system.transform']({ model: {} }, output)
    expect(output.system).toEqual(['You are OpenCode.', WHEN])
    // Where there is nothing to add to, nothing fails
    await hooks['experimental.chat.system.transform']({ model: {} }, {} as any)
    await hooks.dispose?.()
  })

  let home: string
  let before: string | undefined
  const loaded: Hooks[] = []
  const servers: { close: () => Promise<void> }[] = []
  const rejections: unknown[] = []
  const onRejection = (err: unknown) => rejections.push(err)

  async function load(parents: Record<string, string> = {}) {
    const opencode = fakeOpenCode(parents)
    const hooks = await addon.default.server({ client: opencode.client } as any)
    opencode.attach(hooks)
    loaded.push(hooks)
    return { hooks, ...opencode }
  }
  /** Starts a connector and writes its file: the usual one unless another is given, or none at all. */
  async function connector(
    file: unknown = { socket: path.join(home, 'connector.sock'), token: TOKEN },
    listenOn: string | number = path.join(home, 'connector.sock'),
  ) {
    const c = await fakeConnector(listenOn)
    servers.push(c)
    if (file !== NO_FILE) writeFileSync(path.join(home, 'connector.json'), typeof file === 'string' ? file : JSON.stringify(file))
    return c
  }
  /** A command the agent runs in a conversation, as OpenCode announces it to plugins: what it is told besides where to look for programs. */
  async function command(hooks: Hooks, sessionID?: string) {
    const { PATH: _, ...told } = await commandEnv(hooks, sessionID)
    return told
  }
  /** Everything such a command is told. */
  async function commandEnv(hooks: Hooks, sessionID?: string) {
    const output = { env: {} as Record<string, string> }
    await hooks['shell.env']({ cwd: home, ...(sessionID ? { sessionID, callID: 'call_1' } : {}) }, output)
    return output.env
  }
  /** A message reaches a conversation, as OpenCode announces it to plugins. It says which agent the conversation is in. */
  async function says(hooks: Hooks, sessionID: string, message: Record<string, unknown> = { agent: 'build' }) {
    await hooks['chat.message']({ sessionID }, { message, parts: [] } as any)
  }
  /** A conversation as the person uses it: their message reaches it, and then its agent runs a command. */
  async function begin(hooks: Hooks, sessionID: string) {
    await says(hooks, sessionID)
    return command(hooks, sessionID)
  }
  /**
   * Seconds pass on the add-on's clock, when a test has put a stand-in in its place. The round
   * of asking that each one sets off is over before the next begins, so each round is done
   * at the time its own second says.
   */
  async function seconds(n: number) {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(1000)
      await settled()
    }
  }
  /** The add-on's timer and its clock are stand-ins, and its waits for OpenCode too when asked: time passes for it only when a test says. */
  const standIn = (waits = false) =>
    vi.useFakeTimers({ toFake: [...(waits ? (['setTimeout', 'clearTimeout'] as const) : []), 'setInterval', 'clearInterval', 'Date'] })

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'it-opencode-'))
    before = process.env.IT_HOME
    process.env.IT_HOME = home
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
    watchOutside()
  })
  afterEach(async () => {
    for (const hooks of loaded.splice(0)) await hooks.dispose()
    vi.useRealTimers()
    for (const s of servers.splice(0)) await s.close()
    watchNoMore()
    process.off('unhandledRejection', onRejection)
    if (before === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before
    rmSync(home, { recursive: true, force: true })
  })

  it('exports one definition that OpenCode 1.x and 2.x each load, and nothing else', () => {
    // OpenCode 1.x takes a default export with an id for the definition, and loads its `server`;
    // where there is none it would load every export as a plugin of its own
    expect(Object.keys(addon)).toEqual(['default'])
    expect(addon.default.id).toBe('it-bridge')
    expect(typeof addon.default.server).toBe('function')
    // OpenCode 2.x takes a default export with an id and a `setup` function
    expect(typeof addon.default.setup).toBe('function')
  })

  it('sets IT_HARNESS and IT_SESSION for the commands a conversation runs', async () => {
    const { hooks } = await load()
    expect(await command(hooks, 'ses_one')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_one' })
    // It is told where the `it` command is as well, after everything that was on its PATH: an OpenCode started
    // from the terminal It was installed in does not have It's folder there yet
    const bin = path.join(home, 'bin')
    const before = process.env.PATH
    try {
      process.env.PATH = ['/usr/local/bin', '/usr/bin'].join(path.delimiter)
      expect((await commandEnv(hooks, 'ses_one')).PATH).toBe(['/usr/local/bin', '/usr/bin', bin].join(path.delimiter))
      // And not a second time where it is there already
      process.env.PATH = ['/usr/bin', bin].join(path.delimiter)
      expect((await commandEnv(hooks, 'ses_one')).PATH).toBeUndefined()
    } finally {
      process.env.PATH = before
    }
    // Each conversation gets its own id, however many one OpenCode holds
    expect(await command(hooks, 'ses_two')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_two' })
    // A terminal the person opened belongs to no conversation
    expect(await command(hooks)).toEqual({})
  })

  it("gives a subagent's commands the id of the conversation that started it", async () => {
    standIn()
    const c = await connector()
    const { hooks } = await load({ ses_child: 'ses_parent', ses_grandchild: 'ses_child' })
    expect(await command(hooks, 'ses_grandchild')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_parent' })
    // What the subagent itself is sent says nothing about the agent the conversation is in
    await says(hooks, 'ses_grandchild', { agent: 'explore' })
    await seconds(2)
    expect(outside.put).toBe(2)
    expect(c.state.runtimes).toHaveLength(2)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: true, idle: false } })
    expect(c.state.asked).toEqual([])
    await says(hooks, 'ses_parent')
    await settled()
    expect(c.polls().length).toBe(1)
    expect(c.polls().every((a) => a.session === 'ses_parent')).toBe(true)
  })

  it('asks about as many conversations at once as the connector listens for, and past that the one used longest ago gives way', async () => {
    standIn()
    const c = await connector()
    const { hooks } = await load()
    const open = Array.from({ length: LISTENING_MOST }, (_, i) => `ses_${i + 1}`)
    for (const id of open) await begin(hooks, id)
    await settled()
    c.state.asked.length = 0
    await seconds(1)
    expect(c.polls().map((a) => a.session)).toEqual(open)
    // One more than the connector listens for: the first, which has said nothing since, is the one not asked about
    await begin(hooks, 'ses_one_more')
    await settled()
    c.state.asked.length = 0
    await seconds(1)
    expect(c.polls().map((a) => a.session)).toEqual([...open.slice(1), 'ses_one_more'])
  })

  it('gives a subagent no conversation at all when the one that started it cannot be told for sure', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load({ ses_child: 'ses_parent' })
    // OpenCode cannot say who started it. Taking it for a conversation of its own would make its page its own.
    state.lost = true
    expect(await command(hooks, 'ses_child')).toEqual({})
    await says(hooks, 'ses_child')
    await seconds(2)
    expect(outside.put).toBe(2)
    expect(c.state.runtimes).toHaveLength(2)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: true, idle: false } })
    expect(c.state.asked).toEqual([])
    expect(prompts).toEqual([])
    // The failure is not remembered: the next command is looked up afresh
    state.lost = false
    expect(await command(hooks, 'ses_child')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_parent' })
  })

  it('does the same when the chain of who started whom is longer than it follows', async () => {
    const chain = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ses_${i}`, `ses_${i + 1}`]))
    const { hooks } = await load(chain)
    expect(await command(hooks, 'ses_0')).toEqual({})
    expect(await command(hooks, 'ses_2')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_9' })
  })

  it('asks the connector about its conversation, with the right harness, session and token, once a second', async () => {
    standIn()
    const c = await connector()
    const { hooks } = await load()
    await begin(hooks, 'ses_one')
    // The first round is asked at once, and each one after it when a second has gone by and not before
    await settled()
    expect(c.polls().length).toBe(1)
    vi.advanceTimersByTime(999)
    await settled()
    expect(c.polls().length).toBe(1)
    vi.advanceTimersByTime(1)
    await settled()
    expect(c.polls().length).toBe(2)
    await seconds(3)
    expect(c.polls().length).toBe(5)
    for (const a of c.polls()) expect(a).toMatchObject({ method: 'POST', harness: 'opencode', session: 'ses_one', token: TOKEN })
  })

  it('starts asking when a message reaches a conversation, before any command has run', async () => {
    const c = await connector()
    const { hooks } = await load()
    await hooks['chat.message']({ sessionID: 'ses_one' }, { message: { agent: 'build', model: { providerID: 'p', modelID: 'm' } }, parts: [] } as any)
    await vi.waitFor(() => expect(c.polls().length).toBeGreaterThan(0), within)
    expect(c.polls()[0]).toMatchObject({ harness: 'opencode', session: 'ses_one' })
  })

  it("hands the connector's text to the conversation word for word, then says it has", async () => {
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.state.acked).toEqual(['k1']), within)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.path).toEqual({ id: 'ses_one' })
    expect(prompts[0]!.body).toEqual({ agent: 'build', parts: [{ type: 'text', text: click('k1').text }] })
    expect(c.state.asked.find((a) => a.path === '/ack')).toMatchObject({ method: 'POST', token: TOKEN, body: { ids: ['k1'] } })
  })

  it('hands several clicks over in one message, each with its own text', async () => {
    const c = await connector()
    c.state.offered = [click('k1'), click('k2')]
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.state.acked.sort()).toEqual(['k1', 'k2']), within)
    expect(texts(prompts)).toEqual([`${click('k1').text}\n${click('k2').text}`])
  })

  it('uses the agent and model of the last message in the conversation', async () => {
    const c = await connector()
    const { hooks, prompts } = await load()
    const said = { agent: 'plan', model: { providerID: 'anthropic', modelID: 'claude', variant: 'high' } }
    await hooks['chat.message']({ sessionID: 'ses_one' }, { message: said, parts: [] } as any)
    c.state.offered = [click('k1')]
    await vi.waitFor(() => expect(prompts).toHaveLength(1), within)
    expect(prompts[0]!.body).toMatchObject({ agent: 'plan', model: { providerID: 'anthropic', modelID: 'claude' }, variant: 'high' })
  })

  it('delivers a click once, however often it is offered, and says so again each time', async () => {
    const c = await connector()
    c.state.deaf = true // the connector never hears the ack, so it goes on offering the click
    c.state.offered = [click('k1')]
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.state.acked.length).toBeGreaterThanOrEqual(3), within)
    expect(new Set(c.state.acked)).toEqual(new Set(['k1']))
    expect(prompts).toHaveLength(1)
  })

  it('reports a click only once its text is in the conversation: OpenCode agreeing to take it is not enough', async () => {
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, conversation, state } = await load()
    // OpenCode answers 204 and stores the message, but not yet the text that goes with it
    state.next = ['held']
    await begin(hooks, 'ses_one')
    await settled()
    expect(prompts).toHaveLength(1)
    expect(c.state.acked).toEqual([])
    state.finish()
    await settled()
    expect(c.state.acked).toEqual(['k1'])
    expect(conversation).toEqual([click('k1').text])
    expect(state.tried).toBe(1)
  })

  it('does not report a click OpenCode agreed to take when something then went wrong, and tries it again', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, conversation, state } = await load()
    // Another plugin refuses the message after the 204. OpenCode says so, and stores nothing.
    state.next = ['fails']
    await begin(hooks, 'ses_one')
    await settled()
    expect(prompts).toHaveLength(1)
    expect(c.state.acked).toEqual([])
    expect(conversation).toEqual([])
    // It counts as a refusal: the click is tried again after the usual wait, and this time it gets in
    await seconds(1)
    expect(c.state.acked).toEqual(['k1'])
    expect(state.tried).toBe(2)
    expect(conversation).toEqual([click('k1').text])
  })

  it('waits longer each time when OpenCode keeps agreeing to take a click that then comes to nothing', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, state } = await load()
    state.next = ['fails', 'fails', 'fails']
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    // Being shown the message before another plugin refused it is not OpenCode taking it: the waits still grow
    await seconds(1)
    expect(state.tried).toBe(2)
    await seconds(4)
    expect(state.tried).toBe(2)
    await seconds(1)
    expect(state.tried).toBe(3)
    expect(c.state.acked).toEqual([])
  })

  it('does not report a click OpenCode agreed to take when nothing more is heard of it', async () => {
    standIn(true)
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, conversation, state } = await load()
    state.next = ['silent']
    await begin(hooks, 'ses_one')
    await settled()
    expect(prompts).toHaveLength(1)
    // The agent quoting the click in its own words is not the click arriving
    await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'msg_agent', role: 'assistant', sessionID: 'ses_one' } } } } as any)
    const quoted = { id: 'prt_agent', type: 'text', sessionID: 'ses_one', messageID: 'msg_agent', text: `I see ${click('k1').text}` }
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: quoted } } } as any)
    // For half a minute it waits to see the message, and gives the conversation nothing else
    await seconds(29)
    expect(c.state.acked).toEqual([])
    expect(state.tried).toBe(1)
    // Then it counts as a refusal, and the click is tried again after the usual wait and not before
    await seconds(1)
    expect(state.tried).toBe(1)
    await seconds(1)
    expect(state.tried).toBe(2)
    expect(c.state.acked).toEqual(['k1'])
    expect(conversation).toEqual([click('k1').text])
  })

  it('does not say a click was delivered when OpenCode refused it, and tries again', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load()
    state.refuse = 1
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    expect(c.state.acked).toEqual([])
    expect(prompts).toHaveLength(0)
    await seconds(1)
    expect(c.state.acked).toEqual(['k1'])
    expect(prompts).toHaveLength(1)
  })

  it('tries a click OpenCode keeps refusing less and less often: after 1 second, then 5, then 30, then every few minutes', async () => {
    // Only the add-on's clock is stood in for. The connector is still asked for real.
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state, writes } = await load()
    state.refuse = Number.POSITIVE_INFINITY
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    await seconds(1)
    expect(state.tried).toBe(2)
    await seconds(4)
    expect(state.tried).toBe(2)
    await seconds(1)
    expect(state.tried).toBe(3)
    // Refused twice running: while it is being left alone it is not asked about either, so the
    // click goes back to waiting where `it wait` and the site can have it
    const asksBefore = c.polls().length
    vi.setSystemTime(Date.now() + 28_000)
    await seconds(1)
    expect(state.tried).toBe(3)
    expect(c.polls().length).toBe(asksBefore)
    await seconds(1)
    expect(state.tried).toBe(4)
    c.state.runtimes.length = 0
    vi.setSystemTime(Date.now() + 178_000)
    await seconds(1)
    expect(state.tried).toBe(4)
    expect(c.polls().length).toBe(asksBefore + 1)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { delivery: true, idle: false } })
    await seconds(1)
    expect(state.tried).toBe(5)
    expect(c.state.acked).toEqual([])
    // The person writes in the conversation, perhaps with a model OpenCode will take: the click is tried at once
    state.refuse = 0
    await writes('ses_one', 'try the other model')
    await seconds(1)
    expect(state.tried).toBe(6)
    expect(texts(prompts)).toEqual([click('k1').text])
    expect(c.state.acked).toEqual(['k1'])
  })

  it('does not hand over from memory a click the connector has stopped offering', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load()
    state.refuse = 1
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    // While OpenCode was refusing it, the connector lost its hold on the click, and it went to someone else
    c.state.offered = []
    const asks = c.polls().length
    await seconds(3)
    // It went on asking, and was offered nothing
    expect(c.polls().length).toBe(asks + 3)
    expect(state.tried).toBe(1)
    expect(prompts).toEqual([])
    expect(c.state.acked).toEqual([])
  })

  it('stops waiting for an OpenCode that does not answer, and tries the click again', async () => {
    standIn(true)
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load()
    state.hang = 1
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    // For as long as OpenCode is waited on, the conversation is given nothing else
    await seconds(4)
    expect(state.tried).toBe(1)
    // After five seconds it counts as a refusal, and a second later the click is tried again
    await seconds(1)
    expect(state.tried).toBe(1)
    await seconds(1)
    expect(state.tried).toBe(2)
    expect(texts(prompts)).toEqual([click('k1').text])
    expect(c.state.acked).toEqual(['k1'])
  })

  it('believes an OpenCode that takes the message after all, and does not give the click a second time', async () => {
    standIn(true)
    const c = await connector()
    c.state.deaf = true // the connector goes on offering the click, whatever it is told
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load()
    state.hang = 1
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    // The add-on stops waiting, and just then OpenCode takes the message
    await seconds(5)
    expect(c.state.acked).toEqual([])
    state.release()
    await settled()
    expect(c.state.acked).toContain('k1')
    await seconds(3)
    expect(state.tried).toBe(1)
    expect(prompts).toHaveLength(1)
  })

  it('does not ask about a conversation, or hand it a click, until the agent it is in is known', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts } = await load({ ses_child: 'ses_one' })
    // A command and a subagent's message say which conversation is in use, but not which agent it is in.
    // Handing a click over now could move a conversation in a read-only agent to the default one.
    await command(hooks, 'ses_one')
    await says(hooks, 'ses_child', { agent: 'explore' })
    await seconds(2)
    // Nothing is asked either, so the connector does not set the click aside where nothing else could have it
    expect(outside.put).toBe(2)
    expect(c.state.runtimes).toHaveLength(2)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: true, idle: false } })
    expect(c.state.asked).toEqual([])
    expect(prompts).toEqual([])
    await says(hooks, 'ses_one', { agent: 'plan' })
    await settled()
    expect(c.state.acked).toEqual(['k1'])
    expect(prompts.map((p) => p.body.agent)).toEqual(['plan'])
  })

  it('stops asking about a conversation that is gone', async () => {
    standIn()
    const c = await connector()
    c.state.offered = [click('k1')]
    const { hooks, prompts, state } = await load()
    state.missing = true
    await begin(hooks, 'ses_one')
    await settled()
    expect(state.tried).toBe(1)
    await seconds(3)
    expect(state.tried).toBe(1)
    expect(c.polls().length).toBe(1)
    expect(c.state.acked).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  it('stops asking about a conversation the person deleted', async () => {
    standIn()
    const c = await connector()
    const { hooks } = await load()
    await begin(hooks, 'ses_one')
    await settled()
    await seconds(1)
    expect(c.polls().length).toBe(2)
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_one' } } } } as any)
    await seconds(3)
    expect(c.polls().length).toBe(2)
  })

  it('reads the connector file again when the connector has restarted with a new token', async () => {
    const c = await connector()
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.polls().length).toBeGreaterThanOrEqual(1), within)
    c.state.token = 'cd'.repeat(24)
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: path.join(home, 'connector.sock'), token: c.state.token }))
    c.state.offered = [click('k1')]
    await vi.waitFor(() => expect(c.state.acked).toEqual(['k1']), within)
    expect(prompts).toHaveLength(1)
  })

  it('uses the socket in its own folder, whatever the file says', async () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-opencode-other-'))
    try {
      const other = await fakeConnector(path.join(elsewhere, 'connector.sock'))
      servers.push(other)
      const c = await connector({ socket: path.join(elsewhere, 'connector.sock'), token: TOKEN })
      const { hooks } = await load()
      await begin(hooks, 'ses_one')
      await vi.waitFor(() => expect(c.polls().length).toBeGreaterThanOrEqual(1), within)
      expect(other.state.asked).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('reaches the connector by port on this machine where there is no socket', async () => {
    const c = await connector(NO_FILE, 0)
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: c.port, token: TOKEN }))
    c.state.offered = [click('k1')]
    // An answer that is not sealed with the token is not believed: nothing it offers is delivered
    c.state.unsealed = true
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.polls().length).toBeGreaterThanOrEqual(2), within)
    expect(prompts).toEqual([])
    c.state.unsealed = false
    await vi.waitFor(() => expect(c.state.acked).toEqual(['k1']), within)
    expect(texts(prompts)).toEqual([click('k1').text])
    // And the token itself never went over the port
    expect(c.state.asked.every((a) => a.token === undefined)).toBe(true)
  })

  it('takes an answer too long to be the connector’s for no answer, even a sealed one, and reads the next as usual', async () => {
    const c = await connector(NO_FILE, 0)
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: c.port, token: TOKEN }))
    c.state.offered = [click('k1')]
    c.state.padding = 300_000
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await vi.waitFor(() => expect(c.polls().length).toBeGreaterThanOrEqual(2), within)
    expect(prompts).toEqual([])
    c.state.padding = 0
    await vi.waitFor(() => expect(c.state.acked).toEqual(['k1']), within)
    expect(texts(prompts)).toEqual([click('k1').text])
  })

  it('gives up on an answer that never ends three seconds after asking, however steadily it arrives, and asks again', async () => {
    standIn(true)
    let questions = 0
    let pieces = 0
    let ended = 0
    // Something on the connector's port that answers a little at a time, for ever
    const slow = http.createServer((_req, res) => {
      questions++
      res.writeHead(200, { 'content-type': 'application/json' })
      const drip = reallyEvery(() => res.write(' ', () => pieces++), 20)
      res.on('close', () => {
        clearInterval(drip)
        ended++
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          slow.closeAllConnections()
          slow.close(() => resolve())
        }),
    })
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: (slow.address() as { port: number }).port, token: TOKEN }))
    const { hooks, prompts } = await load()
    await begin(hooks, 'ses_one')
    await reached(() => pieces >= 3, 'the answer has begun to arrive')
    // Up to the three seconds it is waited for, with more of it arriving all the while
    vi.advanceTimersByTime(2999)
    const before = pieces
    await reached(() => pieces >= before + 3, 'more of the answer has arrived')
    expect([questions, ended]).toEqual([1, 0])
    // Then it is given up, though it was still arriving
    vi.advanceTimersByTime(1)
    await settled()
    await reached(() => ended === 1, 'the question has been given up')
    expect(questions).toBe(1)
    // And the next round asks again
    vi.advanceTimersByTime(1000)
    await reached(() => questions === 2, 'the connector has been asked again')
    expect(prompts).toEqual([])
  })

  it('looks for It where it was when the add-on was set up, if nothing in the environment says where', async () => {
    standIn()
    const source = readFileSync(fileURLToPath(new URL('./plugins/it-bridge.js', import.meta.url)), 'utf8')
    // `it setup` fills the folder in on this very line, so the line must stay exactly as it is
    expect(source.match(/^const IT_HOME_AT_SETUP = null$/gm)).toHaveLength(1)
    const copy = path.join(home, 'it-bridge.filled.mjs')
    writeFileSync(copy, source.replace(/^const IT_HOME_AT_SETUP = null$/m, `const IT_HOME_AT_SETUP = ${JSON.stringify(home)}`))
    const filled = await import(/* @vite-ignore */ pathToFileURL(copy).href)
    const c = await connector()
    c.state.offered = [click('k1')]
    // A harness started from a shell that knows nothing of It's folder
    delete process.env.IT_HOME
    const opencode = fakeOpenCode()
    const hooks = (await filled.default.server({ client: opencode.client })) as Hooks
    opencode.attach(hooks)
    loaded.push(hooks)
    await begin(hooks, 'ses_one')
    await settled()
    expect(c.state.acked).toEqual(['k1'])
    await hooks.dispose()
    // And what the environment says comes first
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-opencode-other-'))
    try {
      process.env.IT_HOME = elsewhere
      const other = fakeOpenCode()
      const otherHooks = (await filled.default.server({ client: other.client })) as Hooks
      other.attach(otherHooks)
      loaded.push(otherHooks)
      const asked = c.state.asked.length
      const looked = outside.looked
      await begin(otherHooks, 'ses_two')
      // Past the three seconds for which a file that was not found is taken to be missing still
      await settled()
      await seconds(4)
      // It looked in the folder the environment names, found no connector there, and asked nothing of this one
      expect(outside.looked).toBe(looked + 2)
      expect(c.state.asked.length).toBe(asked)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  describe('with no usable connector file', () => {
    const sock = () => path.join(home, 'connector.sock')
    const broken: [string, () => unknown][] = [
      ['a missing file', () => NO_FILE],
      ['a file that is not JSON', () => '{ "socket": '],
      ['a file holding null', () => 'null'],
      ['a file holding a list', () => '[]'],
      ['no token', () => ({ socket: sock() })],
      ['a token that is not hex', () => ({ socket: sock(), token: 'not a token at all, just words' })],
      ['a token that is too short', () => ({ socket: sock(), token: 'abcd' })],
      ['neither a socket nor a port', () => ({ token: TOKEN })],
      ['a port that is not a port', () => ({ port: 70000, token: TOKEN })],
      ['a port given as text', () => ({ port: '8080', token: TOKEN })],
    ]
    for (const [name, file] of broken) {
      it(`does nothing and throws nothing: ${name}`, async () => {
        standIn()
        // A connector is listening all the same, so anything the add-on sent would be seen
        const c = await connector(file())
        c.state.offered = [click('k1')]
        const { hooks, prompts } = await load()
        // The commands still say whose they are: that does not depend on the connector
        expect(await command(hooks, 'ses_one')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_one' })
        await hooks['chat.message']({ sessionID: 'ses_one' }, { message: { agent: 'build' }, parts: [] } as any)
        await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_one' } } } as any)
        // The first round is over: it looked for the connector, and found none it could use.
        // What it found is kept for three seconds, and after those it looks again and finds the same.
        await settled()
        expect(outside.looked).toBe(1)
        await seconds(4)
        expect(outside.looked).toBe(2)
        expect(outside.put).toBe(0)
        expect(c.state.asked).toEqual([])
        expect(prompts).toEqual([])
        expect(rejections).toEqual([])
      })
    }

    it('does nothing and throws nothing when the file is there and the connector is not', async () => {
      standIn()
      writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: sock(), token: TOKEN }))
      const { hooks, prompts } = await load()
      expect(await begin(hooks, 'ses_one')).toEqual({ IT_HARNESS: 'opencode', IT_SESSION: 'ses_one' })
      // It asks, and nothing is there to answer. A second later it asks again, having read the file anew.
      await settled()
      expect([outside.looked, outside.put]).toEqual([1, 1])
      await seconds(1)
      expect([outside.looked, outside.put]).toEqual([2, 2])
      expect(prompts).toEqual([])
      expect(rejections).toEqual([])
    })
  })

  it('reports a missing host API while no conversation is selected', async () => {
    standIn()
    const c = await connector()
    const hooks = await addon.default.server({ client: { session: {} } } as any)
    loaded.push(hooks)
    await seconds(2)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: false, idle: false } })
    expect(c.polls()).toEqual([])
  })

  it('throws nothing when OpenCode itself cannot be asked about a conversation', async () => {
    standIn()
    const hooks = await addon.default.server({
      client: {
        session: {
          get: async () => {
            throw new Error('down')
          },
          promptAsync: async () => {
            throw new Error('down')
          },
        },
      },
    } as any)
    loaded.push(hooks)
    const c = await connector()
    c.state.offered = [click('k1')]
    // Whether this is a conversation or a subagent cannot be told, so its commands are told nothing
    expect(await command(hooks, 'ses_one')).toEqual({})
    await hooks['chat.message']({ sessionID: 'ses_one' }, { message: { agent: 'build' }, parts: [] } as any)
    await seconds(2)
    // And nothing is asked about it, so the connector sets no click aside for it
    expect(outside.put).toBe(2)
    expect(c.state.runtimes).toHaveLength(2)
    expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: true, idle: false } })
    expect(c.state.asked).toEqual([])
    expect(rejections).toEqual([])
  })

  /**
   * What OpenCode 2.x hands a plugin's `setup`, cut down to what the add-on uses, and what it
   * then announces. As the real one does (seen in OpenCode 2.2.7): `session.prompt` shows the
   * message to every plugin's prompt hook, admits it to the conversation's inbox and answers
   * with it, and OpenCode then announces it as enqueued, and as delivered once it is in the
   * conversation or cancelled if it is dropped. An unknown conversation is refused with a
   * `Session.NotFoundError`.
   */
  function fakeOpenCode2(parents: Record<string, string> = {}) {
    const hooks: Record<string, ((input: any) => unknown)[]> = {}
    const prompts: { sessionID: string; text: string; delivery?: string }[] = []
    const conversation: string[] = []
    const events: any[] = []
    let wake: (() => void) | null = null
    let made = 0
    const state = {
      tried: 0,
      missing: false,
      refuse: 0,
      /** What becomes of each of the next messages taken: delivered, cancelled, nothing heard, or delivered before the answer to the call. */
      next: [] as ('delivered' | 'cancelled' | 'silent' | 'early' | 'pending')[],
      /** Delivers a message that was admitted and left pending, as OpenCode does at the conversation's next step. */
      deliver: () => {},
      subscribed: 0,
      unsubscribed: 0,
      disposed: 0,
    }
    const announce = (type: string, data: unknown) => {
      events.push({ type, data })
      wake?.()
    }
    const hookOf = (domain: string) => async (name: string, callback: (input: any) => unknown) => {
      const key = `${domain}:${name}`
      hooks[key] ??= []
      hooks[key]!.push(callback)
      return {
        dispose: async () => {
          state.disposed++
          hooks[key] = hooks[key]!.filter((c) => c !== callback)
        },
      }
    }
    const run = async (key: string, input: unknown) => {
      for (const callback of hooks[key] ?? []) await callback(input)
    }
    async function admit(sessionID: string, text: string, what: 'delivered' | 'cancelled' | 'silent' | 'early' | 'pending') {
      const id = `msg_${++made}`
      await run('session:prompt', { sessionID, messageID: id, prompt: { text, files: [] }, delivery: 'steer' })
      const item = { type: 'user', payload: { text, files: [] }, delivery: 'steer' }
      const after = () => {
        announce('session.inbox.enqueued', { sessionID, inboxID: id, item })
        if (what === 'delivered') {
          conversation.push(text)
          announce('session.inbox.delivered', { sessionID, inboxID: id })
        } else if (what === 'cancelled') announce('session.inbox.cancelled', { sessionID, inboxID: id })
        else if (what === 'pending')
          state.deliver = () => {
            conversation.push(text)
            announce('session.inbox.delivered', { sessionID, inboxID: id })
          }
      }
      if (what === 'early') {
        // Said to be delivered before the answer to the call, with the enqueued word lost
        conversation.push(text)
        announce('session.inbox.delivered', { sessionID, inboxID: id })
      } else setImmediate(after)
      return { id, sessionID, type: 'user', payload: { text }, delivery: 'steer' }
    }
    const ctx = {
      session: {
        hook: hookOf('session'),
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID.startsWith('ses_gone')) throw Object.assign(new Error('Session.NotFoundError'), { _tag: 'Session.NotFoundError', sessionID })
          return { id: sessionID, ...(parents[sessionID] ? { parentID: parents[sessionID] } : {}) }
        },
        prompt: async ({ sessionID, text, delivery }: { sessionID: string; text: string; delivery?: string }) => {
          state.tried++
          if (state.missing) throw Object.assign(new Error('Session.NotFoundError'), { _tag: 'Session.NotFoundError', sessionID })
          if (state.refuse > 0) {
            state.refuse--
            throw Object.assign(new Error('Session.ConflictError'), { _tag: 'Session.ConflictError' })
          }
          prompts.push({ sessionID, text, delivery })
          return admit(sessionID, text, state.next.shift() ?? 'delivered')
        },
      },
      shell: { hook: hookOf('shell') },
      event: {
        subscribe: ({ types, signal }: { types?: string[]; signal?: AbortSignal } = {}) => ({
          async *[Symbol.asyncIterator]() {
            state.subscribed++
            let at = events.length
            try {
              while (!signal?.aborted) {
                while (at < events.length) {
                  const event = events[at++]
                  if (!types || types.includes(event.type)) yield event
                }
                await new Promise<void>((resolve) => {
                  wake = resolve
                  signal?.addEventListener('abort', () => resolve(), { once: true })
                })
              }
            } finally {
              state.unsubscribed++
            }
          },
        }),
      },
    }
    return {
      ctx,
      prompts,
      conversation,
      state,
      announce,
      /** The person writes in a conversation. */
      writes: (sessionID: string, text = 'hello') => admit(sessionID, text, 'delivered'),
      /** The agent's instructions for one request, as OpenCode puts them together. */
      context: async (system: { type: string; text: string }[]) => {
        const input = { sessionID: 'ses_one', agent: 'build', system, messages: [], options: {}, tools: {} }
        await run('session:context', input)
        return input.system
      },
      /** A command the agent runs, with what OpenCode would start it with before it says which conversation it is in. */
      shell: async (env: Record<string, string | undefined>) => {
        const input = { command: 'it status', cwd: home, timeout: 0, shell: '/bin/sh', env: { ...env } }
        await run('shell:create.before', input)
        return input.env
      },
    }
  }

  describe('as OpenCode 2.x loads it', () => {
    async function load2(parents: Record<string, string> = {}) {
      const opencode = fakeOpenCode2(parents)
      const cleanup = (await addon.default.setup(opencode.ctx as any)) as () => Promise<void>
      loaded.push({ dispose: cleanup } as any)
      return { cleanup, ...opencode }
    }

    it('adds when a page is the answer to the agent’s instructions, last and once', async () => {
      const opencode = await load2()
      const first = [{ type: 'text', text: 'You are an AI agent running in OpenCode.' }]
      const once = await opencode.context([...first])
      expect(once).toEqual([...first, { type: 'text', text: WHEN }])
      expect(await opencode.context([...once])).toEqual([...first, { type: 'text', text: WHEN }])
    })

    it('tells the commands the agent runs where the `it` command is, and takes away a pair of It’s own they would inherit', async () => {
      const opencode = await load2()
      const bin = path.join(home, 'bin')
      const env = await opencode.shell({ PATH: ['/usr/bin'].join(path.delimiter), IT_HARNESS: 'claude-code', IT_SESSION: 'someone-else', TERM: 'xterm' })
      // OpenCode itself says which conversation the command is in, as OPENCODE_SESSION_ID, once the plugins have had their say
      expect(env).toEqual({ PATH: ['/usr/bin', bin].join(path.delimiter), TERM: 'xterm' })
    })

    it('asks about a conversation once a message reaches it, and hands it a click that the agent then has', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      expect(c.polls().map((a) => a.session)).toEqual(['ses_one'])
      expect(c.polls()[0]).toMatchObject({ method: 'POST', harness: 'opencode', token: TOKEN })
      c.state.offered = [click('k1')]
      await seconds(1)
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      expect(opencode.prompts).toEqual([{ sessionID: 'ses_one', text: click('k1').text, delivery: 'steer' }])
      expect(opencode.conversation).toEqual(['hello', click('k1').text])
      expect(c.state.acked).toEqual(['k1'])
      expect(c.state.runtimes.concat(c.state.asked.map((a) => a.body)).find((b) => b?.addon)?.addon).toMatchObject({ api: 1, delivery: true, idle: false })
    })

    it('reports a click only once OpenCode says it was delivered into the conversation, even when that is said before its answer', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      opencode.state.next = ['early']
      c.state.offered = [click('k1')]
      await seconds(1)
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      expect(c.state.acked).toEqual(['k1'])
      expect(opencode.state.tried).toBe(1)
    })

    it('does not report a click that OpenCode dropped from the inbox, and tries it again', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      opencode.state.next = ['cancelled']
      c.state.offered = [click('k1')]
      await seconds(1)
      await reached(() => opencode.state.tried === 1, 'OpenCode has been given the click')
      await settled()
      expect(c.state.acked).toEqual([])
      // Tried again after the usual wait, and this time it gets in
      await seconds(1)
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      expect(opencode.state.tried).toBe(2)
      expect(opencode.conversation).toEqual(['hello', click('k1').text])
    })

    it('does not report a click when nothing more is heard of it, and reports it without giving it again if it turns up late', async () => {
      standIn(true)
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      opencode.state.next = ['silent']
      c.state.offered = [click('k1')]
      await seconds(1)
      await settled()
      expect(opencode.state.tried).toBe(1)
      await seconds(29)
      expect(c.state.acked).toEqual([])
      expect(opencode.state.tried).toBe(1)
      // The message is delivered after all: the agent has the click, and is not given it again
      opencode.announce('session.inbox.enqueued', { sessionID: 'ses_one', inboxID: 'msg_2', item: { type: 'user', payload: { text: click('k1').text } } })
      opencode.announce('session.inbox.delivered', { sessionID: 'ses_one', inboxID: 'msg_2' })
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      await seconds(3)
      expect(opencode.state.tried).toBe(1)
      expect(c.state.acked).toEqual(['k1'])
    })

    it('waits for a click OpenCode admitted to the inbox for as long as the running turn takes, and never hands it over twice', async () => {
      standIn(true)
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      // Admitted while a long command runs, and delivered only at the turn's next step
      opencode.state.next = ['pending']
      c.state.offered = [click('k1')]
      await seconds(1)
      await settled()
      expect(opencode.state.tried).toBe(1)
      await seconds(90)
      expect(opencode.state.tried).toBe(1)
      expect(c.state.acked).toEqual([])
      opencode.state.deliver()
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      await seconds(5)
      expect(opencode.state.tried).toBe(1)
      expect(c.state.acked).toEqual(['k1'])
      expect(opencode.conversation).toEqual(['hello', click('k1').text])
    })

    it('does not report a click OpenCode refused, and tries it again', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      opencode.state.refuse = 1
      c.state.offered = [click('k1')]
      await seconds(1)
      await settled()
      expect(opencode.state.tried).toBe(1)
      expect(c.state.acked).toEqual([])
      await seconds(1)
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      expect(opencode.state.tried).toBe(2)
    })

    it('stops asking about a conversation OpenCode says is not there, or that the person deleted', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await opencode.writes('ses_two')
      await settled()
      opencode.state.missing = true
      c.state.offered = [click('k1')]
      await seconds(1)
      await settled()
      opencode.state.missing = false
      c.state.offered = []
      opencode.announce('session.deleted', { sessionID: 'ses_two' })
      await settled()
      c.state.asked.length = 0
      await seconds(2)
      expect(c.polls()).toEqual([])
      expect(c.state.acked).toEqual([])
    })

    it('asks about a subagent’s own conversation too, and hands its clicks to the conversation that started it', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2({ ses_child: 'ses_parent', ses_grandchild: 'ses_child' })
      await opencode.writes('ses_parent')
      await opencode.writes('ses_grandchild', 'Look into the tests.')
      await settled()
      c.state.asked.length = 0
      await seconds(1)
      expect(
        c
          .polls()
          .map((a) => a.session)
          .sort(),
      ).toEqual(['ses_grandchild', 'ses_parent'])
      c.state.offered = [click('k1')]
      await seconds(1)
      await reached(() => c.state.acked.length > 0, 'the connector has been told')
      // Offered under both ids here, since the stand-in connector offers every click to whoever asks: handed over once, to the parent
      expect(opencode.prompts).toEqual([{ sessionID: 'ses_parent', text: click('k1').text, delivery: 'steer' }])
    })

    it('says that this OpenCode is open before any conversation is known', async () => {
      standIn()
      const c = await connector()
      await load2()
      await seconds(2)
      expect(c.state.runtimes[0]).toMatchObject({ harness: 'opencode', addon: { api: 1, delivery: true, idle: false, missing: [] } })
      expect(c.polls()).toEqual([])
    })

    it('does nothing at all where OpenCode calls it with a context that cannot hand a message over, as OpenCode 1.x’s copy of the 2.x host does', async () => {
      standIn()
      const c = await connector()
      const opencode = fakeOpenCode2()
      // As OpenCode 1.18.32 calls it: its own `server` is what takes clicks there, and this must not say that OpenCode cannot
      const cleanup = await addon.default.setup({ ...opencode.ctx, session: { hook: opencode.ctx.session.hook } } as any)
      expect(cleanup).toBeUndefined()
      await seconds(3)
      expect(c.state.runtimes).toEqual([])
      expect(c.state.asked).toEqual([])
      expect(opencode.state.subscribed).toBe(0)
    })

    it('lets go of everything it set up when OpenCode unloads it', async () => {
      standIn()
      const c = await connector()
      const opencode = await load2()
      await opencode.writes('ses_one')
      await settled()
      expect(opencode.state.subscribed).toBe(1)
      await opencode.cleanup()
      await settled()
      expect(opencode.state.unsubscribed).toBe(1)
      expect(opencode.state.disposed).toBe(3)
      c.state.asked.length = 0
      c.state.runtimes.length = 0
      await seconds(3)
      expect(c.state.asked).toEqual([])
      expect(c.state.runtimes).toEqual([])
    })
  })
})

// The connector is on this machine, and what is asked of it names a conversation and brings
// back what a person did on a page. A proxy named in the environment is for the internet, and
// must be shown none of it. OpenCode runs its plugins under Bun, which sends whatever
// `node:http` and `fetch` ask through a proxy that is named when it starts, so the add-on is
// run in a process of its own that was started with one named.
describe.skipIf(process.platform === 'win32')('the OpenCode add-on, in an OpenCode started with a proxy named in its environment', () => {
  /** Something that takes whatever is sent to it as a proxy would, notes the first line of each thing asked, and passes nothing on. */
  async function collecting() {
    const seen: string[] = []
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      let got = ''
      socket.on('data', (piece: Buffer) => {
        const first = !got.includes('\r\n')
        got += piece.toString('latin1')
        if (!first || !got.includes('\r\n')) return
        seen.push(got.split('\r\n')[0]!)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    return {
      seen,
      // Named in every variable either runtime reads, with nothing left out of its reach
      env: { HTTP_PROXY: at, http_proxy: at, HTTPS_PROXY: at, https_proxy: at, ALL_PROXY: at, all_proxy: at, NO_PROXY: '', no_proxy: '' },
      close: () => new Promise<void>((r) => void server.close(() => r())),
    }
  }
  const bun = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, 'bun'))
    .find((file) => existsSync(file))
  /**
   * An OpenCode cut down to what the add-on asks of one. The person writes in a conversation,
   * and a message the add-on hands over is said, stored and announced as OpenCode announces one.
   */
  const OPENCODE = `
    import plugin from ${JSON.stringify(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins/it-bridge.js')).href)}
    const hooks = await plugin.server({
      client: {
        session: {
          get: async ({ path: { id } }) => ({ data: { id }, response: { ok: true, status: 200 } }),
          promptAsync: async ({ path: { id }, body }) => {
            const text = body.parts.map((part) => part.text).join('')
            console.log(text)
            const message = { id: 'msg_2', role: 'user', sessionID: id, agent: body.agent }
            await hooks['chat.message']({ sessionID: id, agent: body.agent }, { message, parts: [] })
            await hooks.event({ event: { type: 'message.part.updated', properties: { part: { id: 'prt_2', type: 'text', sessionID: id, messageID: 'msg_2', text } } } })
            return { data: {}, response: { ok: true, status: 204 } }
          },
        },
      },
    })
    await hooks['chat.message']({ sessionID: 'ses_the_persons_own' }, { message: { id: 'msg_1', agent: 'build' }, parts: [] })
    setTimeout(() => process.exit(0), 20000)
  `

  for (const [name, runtime, told] of [
    ['Bun', bun, {}],
    ['Node told to use the environment’s proxy', process.execPath, { NODE_USE_ENV_PROXY: '1' }],
  ] as const)
    it.skipIf(!runtime)(
      `under ${name}, a click is asked for, taken and reported over the connector’s port on this machine, and the proxy is sent nothing`,
      async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'it-opencode-'))
        const proxy = await collecting()
        const c = await fakeConnector(0)
        writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: c.port, token: TOKEN }))
        const offered = click('k1')
        c.state.offered = [offered]
        const opencode = path.join(home, 'opencode.mjs')
        writeFileSync(opencode, OPENCODE)
        const child = spawn(runtime!, [opencode], {
          env: { PATH: process.env.PATH, IT_HOME: home, ...proxy.env, ...told },
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        let handed = ''
        child.stdout.on('data', (piece) => (handed += piece))
        try {
          // Either the connector hears that the agent has the click, or the proxy was asked something
          const end = performance.now() + 15_000
          while (!c.state.acked.length && !proxy.seen.length && performance.now() < end) await pause(20)
          expect(proxy.seen).toEqual([])
          expect(c.polls().map((a) => a.session)).toContain('ses_the_persons_own')
          expect(handed.trim()).toBe(offered.text)
          expect(c.state.acked).toEqual(['k1'])
        } finally {
          child.kill('SIGKILL')
          await proxy.close()
          await c.close()
          rmSync(home, { recursive: true, force: true })
        }
      },
      30_000,
    )
})
