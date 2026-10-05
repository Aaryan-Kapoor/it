// The Pi add-on, run against a stand-in for Pi's extension API and a stand-in connector: a
// small web server on a socket in a temporary folder, as the real connector is on Linux and
// macOS. Nothing here needs Pi itself, an account or the network.
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeClick } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import addon from './extensions/it.js'

const TOKEN = 'ab'.repeat(24)

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

let home = ''
let server: http.Server | null = null
let asked: Asked[] = []
/** What the stand-in connector offers whoever asks. */
let offered: Click[] = []
/** Whether the stand-in connector stops offering a click once it is told the agent has it. */
let acksArrive = true
/** Whether the stand-in connector takes being told that a conversation has a new id. */
let renamesArrive = true
let stops: (() => void)[] = []
let n = 0

/** A click as the connector hands it over: with the words an agent is given for it, which the connector makes this way. */
const click = (name: string): Click => {
  const made = { id: `click-${process.pid}-${++n}`, artifact: 'deploy-plan', title: 'Deploy plan', name, payload: { plan: 'B' }, at: Date.now() }
  return { ...made, text: describeClick({ ...made, attended: true }) }
}

/** Starts the stand-in connector in the temporary folder, with the file that says where it is. */
async function connect(info: Record<string, unknown> = {}): Promise<void> {
  const socket = path.join(home, 'connector.sock')
  server = http.createServer((req, res) => {
    let text = ''
    req.on('data', (piece) => {
      text += piece
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://local')
      const body = text ? JSON.parse(text) : undefined
      asked.push({
        method: req.method ?? '',
        path: url.pathname,
        harness: url.searchParams.get('harness'),
        session: url.searchParams.get('session'),
        token: req.headers['x-it-token'] as string | undefined,
        body,
      })
      let answer: unknown = { ok: true }
      if (req.headers['x-it-token'] !== TOKEN) answer = null
      else if (url.pathname === '/clicks') answer = { clicks: offered }
      else if (url.pathname === '/ack' && acksArrive) offered = offered.filter((c) => !body.ids.includes(c.id))
      if (url.pathname === '/session' && !renamesArrive) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(answer ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer ?? { error: 'not for you' }))
    })
  })
  await new Promise<void>((resolve) => server!.listen(socket, resolve))
  writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket, token: TOKEN, pid: 1, ...info }))
}

/** A stand-in for Pi: the part of its extension API the add-on uses, and a conversation to put messages in. */
function pi(session: string, file: string | undefined = `/sessions/${session}.jsonl`, load: (api: any) => void = addon) {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>()
  const sent: { text: string; options: unknown }[] = []
  const conversation: string[] = []
  const queued: string[] = []
  // The id and the file are the conversation's own. Pi can give a conversation a new id and go on keeping it in the same file.
  const state = { idle: true, mode: 'tui', refuses: false, model: { id: 'stand-in' } as { id: string } | undefined, session, file }
  const ctx = {
    get mode() {
      return state.mode
    },
    get model() {
      return state.model
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => queued.length > 0,
    sessionManager: { getSessionId: () => state.session, getSessionFile: () => state.file },
  }
  const emit = (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx)
  }
  const arrive = (text: string) => {
    conversation.push(text)
    const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
    emit('message_start', { message })
    emit('message_end', { message })
  }
  const api = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => {}
    },
    // As Pi does it: idle, the message goes into the conversation and starts a turn; working,
    // it waits in the steering queue until the tools that are running have finished.
    sendUserMessage(text: string, options: unknown) {
      sent.push({ text, options })
      if (state.refuses) return
      if (state.idle) arrive(text)
      else queued.push(text)
    },
  }
  load(api)
  const self = {
    sent,
    conversation,
    state,
    emit,
    start(event: Record<string, unknown> = { reason: 'startup' }) {
      emit('session_start', event)
    },
    /** The agent starts working, as it does when a turn begins. */
    work() {
      state.idle = false
      emit('agent_start')
    },
    /** The tools that were running have finished, so Pi reads what was queued for it. */
    step() {
      for (const text of queued.splice(0)) arrive(text)
    },
    shutdown(event: Record<string, unknown> = { reason: 'quit' }) {
      emit('session_shutdown', event)
    },
  }
  stops.push(() => self.shutdown())
  return self
}

// The real clock, kept from before any test puts a stand-in in its place
const really = setTimeout
const reallyEvery = setInterval
const reallyNext = setImmediate
/** Waits on the real clock for something to have come about, and says so when it has not. */
async function until(what: () => boolean, ms = 8000): Promise<void> {
  const end = performance.now() + ms
  while (!what()) {
    if (performance.now() > end) throw new Error('waited too long')
    await new Promise((r) => really(r, 5))
  }
}
/** Everything that is ready to run has run, and whatever it set going has got as far as it can without waiting on something outside. */
const turn = () => new Promise((r) => reallyNext(r))
/**
 * The questions the add-on has put to the connector, counted where it puts them: how many in
 * all, and how many of those are not over yet. Whatever the add-on does about an answer it
 * does the moment it has read it, with nothing else getting a turn in between, so once none
 * is waited for the add-on has acted on every answer.
 */
let questions = { put: 0, waiting: 0 }
const request = http.request
function watchQuestions() {
  // Each test counts for itself: a question an earlier test left unanswered ends in that test's count
  const seen = { put: 0, waiting: 0 }
  questions = seen
  http.request = ((...given: unknown[]) => {
    seen.put++
    seen.waiting++
    const req = (request as (...given: unknown[]) => http.ClientRequest)(...given)
    req.once('close', () => seen.waiting--)
    return req
  }) as typeof http.request
}
/**
 * The add-on waits on nothing outside itself: every question it had put to the connector is
 * over, and it has done whatever it does about each answer. A turn is given first, by which
 * whatever was just set going has put its question, if it is going to.
 */
async function settled(): Promise<void> {
  await turn()
  await until(() => questions.waiting === 0)
  await turn()
}
/** The add-on's once-a-second timer and its clock are stand-ins, and its wait for an answer too when asked: time passes for it only when a test says. */
const standIn = (waits = false) =>
  vi.useFakeTimers({ toFake: [...(waits ? (['setTimeout', 'clearTimeout'] as const) : []), 'setInterval', 'clearInterval', 'Date'] })
/**
 * A second passes on the add-on's clock, in a test that has put a stand-in in its place, and
 * the check it sets off is over before anything else is done.
 */
async function second(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    vi.advanceTimersByTime(1000)
    await settled()
  }
}
const polls = () => asked.filter((a) => a.path === '/clicks')
const acks = () => asked.filter((a) => a.path === '/ack')

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'it-pi-'))
  process.env.IT_HOME = home
  asked = []
  offered = []
  acksArrive = true
  renamesArrive = true
  stops = []
  watchQuestions()
})
afterEach(async () => {
  for (const stop of stops) stop()
  http.request = request
  vi.useRealTimers()
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
  }
  server = null
  delete process.env.IT_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('the Pi add-on', () => {
  it('asks the connector for this conversation, as pi, once a second', async () => {
    standIn()
    await connect()
    pi('session-one').start()
    // The first check is made at once, and each one after it when a second has gone by and not before
    await settled()
    expect(polls().length).toBe(1)
    vi.advanceTimersByTime(999)
    await settled()
    expect(polls().length).toBe(1)
    vi.advanceTimersByTime(1)
    await settled()
    expect(polls().length).toBe(2)
    await second(3)
    expect(polls().length).toBe(5)
    for (const p of polls()) expect(p).toMatchObject({ method: 'GET', harness: 'pi', session: 'session-one', token: TOKEN })
  })

  it('hands a click to an idle Pi as a user message with steering delivery, in the connector’s words, and reports it', async () => {
    await connect()
    const c = click('approve')
    offered = [c]
    const p = pi('session-two')
    p.start()
    await until(() => acks().length > 0)
    expect(p.sent).toEqual([{ text: c.text, options: { deliverAs: 'steer' } }])
    expect(p.conversation).toEqual([c.text])
    expect(acks()[0]).toMatchObject({ method: 'POST', token: TOKEN, body: { ids: [c.id] } })
  })

  it('gives several clicks as one message, one line each', async () => {
    await connect()
    const [a, b] = [click('approve'), click('reject')]
    offered = [a, b]
    const p = pi('session-three')
    p.start()
    await until(() => acks().length > 0)
    expect(p.sent.map((s) => s.text)).toEqual([`${a.text}\n${b.text}`])
    expect(acks()[0]!.body.ids).toEqual([a.id, b.id])
  })

  it('delivers a click that is offered twice only once, and reports it again', async () => {
    await connect()
    acksArrive = false // the connector never hears that the agent has it, so it keeps offering it
    const c = click('approve')
    offered = [c]
    const p = pi('session-four')
    p.start()
    await until(() => acks().length >= 3)
    expect(p.sent).toHaveLength(1)
    expect(p.conversation).toEqual([c.text])
    for (const a of acks()) expect(a.body).toEqual({ ids: [c.id] })
  })

  it('does not deliver a click again in the conversation that replaces this one', async () => {
    await connect()
    acksArrive = false
    const c = click('approve')
    offered = [c]
    const first = pi('session-five')
    first.start()
    await until(() => acks().length > 0)
    first.shutdown({ reason: 'reload' })
    const second = pi('session-five')
    second.start({ reason: 'reload' })
    await until(() => acks().length >= 3)
    expect(second.sent).toEqual([])
  })

  it('queues a click as steering while Pi works, and reports it only once it is in the conversation', async () => {
    standIn()
    await connect()
    const p = pi('session-six')
    p.start()
    await settled()
    p.work()
    const c = click('approve')
    offered = [c]
    await second()
    expect(p.sent).toEqual([{ text: c.text, options: { deliverAs: 'steer' } }])
    // Still queued inside Pi: the agent does not have it yet, so the connector is not told it has
    await second(3)
    expect(p.sent).toHaveLength(1)
    expect(acks()).toEqual([])
    p.step()
    await settled()
    expect(acks().map((a) => a.body)).toEqual([{ ids: [c.id] }])
  })

  it('reports nothing when Pi does not take the message', async () => {
    await connect()
    const p = pi('session-seven')
    p.state.refuses = true
    const c = click('approve')
    offered = [c]
    standIn()
    p.start()
    await settled()
    expect(p.sent).toHaveLength(1)
    await second(3)
    expect(p.sent).toHaveLength(1)
    expect(p.conversation).toEqual([])
    expect(acks()).toEqual([])
  })

  it('gives a click again, later, when Pi never showed it in the conversation', async () => {
    await connect()
    const p = pi('session-lost')
    p.state.refuses = true
    const c = click('approve')
    offered = [c]
    // Only the add-on's clock is stood in for, so that its seconds pass quickly. The connector is still asked for real.
    standIn()
    p.start()
    await settled()
    expect(p.sent).toHaveLength(1)
    // Ten idle seconds with nothing queued is what it takes to call the message lost. Through
    // all of them the connector is asked, since the click may yet show up in the conversation.
    await second(9)
    expect(polls().length).toBe(10)
    // Then it is left alone for a while. The connector is not asked in that time, so the
    // click is not kept from anything else that could take it.
    await second(3)
    expect(polls().length).toBe(10)
    expect(p.sent).toHaveLength(1)
    expect(acks()).toEqual([])
    p.state.refuses = false
    for (let i = 0; i < 6 && p.sent.length < 2; i++) await second()
    expect(p.sent).toHaveLength(2)
    expect(p.conversation).toEqual([c.text])
    expect(acks().map((a) => a.body)).toEqual([{ ids: [c.id] }])
  })

  it('does not start a turn in a one-shot run that has finished, or ask the connector for it', async () => {
    await connect()
    const p = pi('session-eight')
    p.state.mode = 'print'
    offered = [click('approve')]
    standIn()
    p.start()
    await settled()
    await second(2)
    expect(questions.put).toBe(0)
    expect(asked).toEqual([])
    expect(p.sent).toEqual([])
  })

  it('does not ask the connector while no model is chosen, so the click is left for whatever else could take it', async () => {
    await connect()
    const p = pi('session-no-model')
    p.state.model = undefined
    const c = click('approve')
    offered = [c]
    standIn()
    p.start()
    // Pi would refuse the message. Asking would have the connector set the click aside for this add-on all the same.
    await settled()
    await second(2)
    expect(questions.put).toBe(0)
    expect(asked).toEqual([])
    expect(p.sent).toEqual([])
    // The person chooses a model: from the next check on the conversation is asked about, and gets its click
    p.state.model = { id: 'stand-in' }
    await second()
    expect(acks().length).toBe(1)
    expect(p.conversation).toEqual([c.text])
  })

  it('tells the connector when the same conversation gets a new id, before asking under the new id', async () => {
    await connect()
    const p = pi('session-old', '/sessions/kept.jsonl')
    p.start()
    await until(() => polls().length > 0)
    asked = []
    // Pi goes on keeping the conversation in the same file, under another id
    p.state.session = 'session-renamed'
    await until(() => polls().length > 0)
    expect(asked[0]).toMatchObject({ method: 'POST', path: '/session', token: TOKEN, body: { harness: 'pi', session: 'session-renamed', was: 'session-old' } })
    expect(asked.filter((a) => a.path === '/session')).toHaveLength(1)
    expect(polls()[0]).toMatchObject({ harness: 'pi', session: 'session-renamed' })
  })

  it('tells the connector of every change of id, in the order they happened, when the id changed again before it could be told of the last time', async () => {
    await connect()
    const renames = () => asked.filter((a) => a.path === '/session').map((a) => `${a.body.was} is now ${a.body.session}`)
    const p = pi('session-one', '/sessions/kept.jsonl')
    p.start()
    await until(() => polls().length > 0)
    // The connector cannot take a change of id for a while, and is told again on each check
    renamesArrive = false
    p.state.session = 'session-two'
    await until(() => renames().length >= 2)
    // The same conversation gets another id meanwhile
    p.state.session = 'session-three'
    await until(() => renames().length >= 4)
    // Nothing is told out of turn, and nothing is asked for under an id the connector could not place
    expect(new Set(renames())).toEqual(new Set(['session-one is now session-two']))
    expect(polls().every((a) => a.session === 'session-one')).toBe(true)
    asked = []
    renamesArrive = true
    await until(() => polls().length > 0)
    // Pages made under the first id follow the conversation through the second to the third
    expect(renames()).toEqual(['session-one is now session-two', 'session-two is now session-three'])
    expect(polls()[0]).toMatchObject({ harness: 'pi', session: 'session-three' })
  }, 15_000)

  it.each(['new', 'resume', 'fork'])('leaves a conversation’s pages its own when the person goes to another one in the same window (%s)', async (reason) => {
    await connect()
    const old = pi('session-old')
    old.start()
    await until(() => polls().length > 0)
    old.shutdown({ reason })
    asked = []
    // Another conversation takes this one's place. The first still exists and can be opened again.
    pi('session-other').start({ reason, previousSessionFile: '/sessions/session-old.jsonl' })
    await until(() => polls().length >= 2)
    // The connector is never told that the one became the other, so clicks on the first one's pages do not go to the second
    expect(asked.filter((a) => a.path === '/session')).toEqual([])
    for (const a of polls()) expect(a).toMatchObject({ harness: 'pi', session: 'session-other' })
  })

  it('does the same when the id and the file change under the same copy of the add-on', async () => {
    await connect()
    const p = pi('session-old')
    p.start()
    await until(() => polls().length > 0)
    asked = []
    p.state.session = 'session-other'
    p.state.file = '/sessions/session-other.jsonl'
    await until(() => polls().length >= 2)
    expect(asked.filter((a) => a.path === '/session')).toEqual([])
    for (const a of polls()) expect(a).toMatchObject({ harness: 'pi', session: 'session-other' })
  })

  it('uses the socket in its own folder, whatever the file says', async () => {
    await connect({ socket: '/somewhere/else/connector.sock' })
    pi('session-nine').start()
    await until(() => polls().length > 0)
    expect(polls()[0]).toMatchObject({ session: 'session-nine', token: TOKEN })
  })

  it('asks a port on this machine when the file gives one instead of a socket, as on Windows', async () => {
    const c = click('approve')
    offered = [c]
    const seen: string[] = []
    // Over a port the token is never sent. The request carries a code made from it, and the
    // answer must carry one too, or it is not believed.
    let honest = false
    server = http.createServer((req, res) => {
      let sent = ''
      req
        .on('data', (piece) => (sent += piece))
        .on('end', () => {
          const nonce = String(req.headers['x-it-nonce'])
          const genuine = req.headers['x-it-mac'] === createHmac('sha256', TOKEN).update(`${nonce}\n${req.method}\n${req.url}\n${sent}`).digest('hex')
          seen.push(`${req.method} ${req.url} ${req.headers['x-it-token']} ${genuine}`)
          const answer = JSON.stringify({ clicks: seen.some((s) => s.startsWith('POST /ack')) ? [] : offered })
          res.writeHead(200, {
            'content-type': 'application/json',
            ...(honest ? { 'x-it-mac': createHmac('sha256', TOKEN).update(`${nonce}\n200\n${answer}`).digest('hex') } : {}),
          })
          res.end(answer)
        })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: (server.address() as { port: number }).port, token: TOKEN }))
    const p = pi('session-port')
    p.start()
    // Something that took the port answers without the seal: nothing it offers is delivered
    await until(() => seen.length >= 2)
    expect(p.conversation).toEqual([])
    honest = true
    await until(() => seen.some((s) => s.startsWith('POST /ack')))
    expect(seen[0]).toBe('GET /clicks?harness=pi&session=session-port undefined true')
    expect(p.conversation).toEqual([c.text])
  })

  it('takes an answer too long to be the connector’s for no answer, and reads the next as usual', async () => {
    await connect()
    const c = click('approve')
    // A real click, in an answer padded past anything the connector would send
    offered = [{ ...c, title: 'x'.repeat(300_000) }]
    const p = pi('session-long')
    p.start()
    await until(() => polls().length >= 2)
    expect(p.sent).toEqual([])
    offered = [c]
    await until(() => acks().length > 0)
    expect(p.conversation).toEqual([c.text])
  })

  it('gives up on an answer that never ends three seconds after asking, however steadily it arrives, and asks again', async () => {
    standIn(true)
    let asks = 0
    let pieces = 0
    let ended = 0
    // Something on the connector's port that answers a little at a time, for ever
    server = http.createServer((_req, res) => {
      asks++
      res.writeHead(200, { 'content-type': 'application/json' })
      const drip = reallyEvery(() => res.write(' ', () => pieces++), 20)
      res.on('close', () => {
        clearInterval(drip)
        ended++
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: (server.address() as { port: number }).port, token: TOKEN }))
    const p = pi('session-slow')
    p.start()
    await until(() => pieces >= 3)
    // Up to the three seconds it is waited for, with more of it arriving all the while
    vi.advanceTimersByTime(2999)
    const before = pieces
    await until(() => pieces >= before + 3)
    expect([asks, ended]).toEqual([1, 0])
    // Then it is given up, though it was still arriving
    vi.advanceTimersByTime(1)
    await settled()
    await until(() => ended === 1)
    expect(asks).toBe(1)
    // And the next check asks again
    vi.advanceTimersByTime(1000)
    await until(() => asks === 2)
    expect(p.sent).toEqual([])
  })

  it('looks for It where it was when the add-on was set up, if nothing in the environment says where', async () => {
    const source = readFileSync(fileURLToPath(new URL('./extensions/it.js', import.meta.url)), 'utf8')
    // `it setup` fills the folder in on this very line, so the line must stay exactly as it is
    expect(source.match(/^const IT_HOME_AT_SETUP = null$/gm)).toHaveLength(1)
    const copy = path.join(home, 'it.filled.mjs')
    writeFileSync(copy, source.replace(/^const IT_HOME_AT_SETUP = null$/m, `const IT_HOME_AT_SETUP = ${JSON.stringify(home)}`))
    const filled = (await import(/* @vite-ignore */ pathToFileURL(copy).href)).default
    standIn()
    await connect()
    // A Pi started from a shell that knows nothing of It's folder
    delete process.env.IT_HOME
    pi('session-setup', undefined, filled).start()
    await settled()
    expect(polls()).toHaveLength(1)
    expect(polls()[0]).toMatchObject({ session: 'session-setup', token: TOKEN })
    // And what the environment says comes first
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'it-pi-other-'))
    try {
      process.env.IT_HOME = elsewhere
      pi('session-elsewhere', undefined, filled).start()
      // Past the three seconds for which a connector that was not found is taken to be missing still
      await settled()
      await second(4)
      expect(asked.filter((a) => a.session === 'session-elsewhere')).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('does nothing and throws nothing when the connector’s file is missing', async () => {
    standIn()
    const p = pi('session-ten')
    expect(() => p.start()).not.toThrow()
    // Past the three seconds for which a connector that was not found is taken to be missing still
    await settled()
    await second(4)
    expect(questions.put).toBe(0)
    expect(p.sent).toEqual([])
    expect(() => p.shutdown()).not.toThrow()
  })

  it.each([
    ['not JSON', '{ "socket": '],
    ['not an object', '"hello"'],
    ['nothing', 'null'],
    ['no token', JSON.stringify({ socket: 'x' })],
    ['a token that is not one', JSON.stringify({ socket: 'x', token: '../etc/passwd' })],
    ['neither a socket nor a port', JSON.stringify({ token: TOKEN })],
    ['a port that is not one', JSON.stringify({ token: TOKEN, port: 'http://example.com' })],
  ])('does nothing and throws nothing when the connector’s file is %s', async (_name, text) => {
    // A connector is there and would answer, so anything the add-on did would be seen
    await connect()
    offered = [click('approve')]
    writeFileSync(path.join(home, 'connector.json'), text)
    standIn()
    const p = pi('session-eleven')
    expect(() => p.start()).not.toThrow()
    // The add-on looks for the connector the moment the conversation starts, and again when
    // the three seconds are over for which it takes what it found to be so still
    await settled()
    await second(4)
    expect(questions.put).toBe(0)
    expect(asked).toEqual([])
    expect(p.sent).toEqual([])
  })
})
