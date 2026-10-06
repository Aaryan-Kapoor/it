// The Claude Code add-on, run against a stand-in for Claude Code's mod interface and a stand-in
// for the connector. What it must get right: each click reaches the main conversation exactly
// once, and is reported as given only when it really was.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { briefClick, describeClick } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface Click {
  id: string
  text: string
  /** The few words a person is shown, which a connector of this version gives beside the rest. */
  brief?: string
}
let home: string
let server: http.Server
/** What the stand-in connector will offer, and what it was told. */
let offered: Click[]
let asked: { path: string; body: any }[]

function fakeConnector(socket: string): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    let text = ''
    req
      .on('data', (c) => (text += c))
      .on('end', () => {
        if (req.headers['x-it-token'] !== 'a'.repeat(48)) {
          res.writeHead(401).end('{}')
          return
        }
        const body = text ? JSON.parse(text) : null
        asked.push({ path: req.url ?? '', body })
        if (req.url?.startsWith('/ack')) offered = offered.filter((c) => !body.ids.includes(c.id))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(req.url?.startsWith('/clicks') ? { clicks: offered } : { ok: true }))
      })
  })
  return new Promise((resolve) => s.listen(socket, () => resolve(s)))
}

/** Everything that is ready to run has run, and whatever it set going has got as far as it can without waiting on something outside. */
const turn = () => new Promise((r) => setImmediate(r))
/** Waits for something to have come about, and says what was waited for when it has not. */
async function until(what: () => boolean, name: string) {
  const end = performance.now() + 8000
  while (!what()) {
    if (performance.now() > end) throw new Error(`Eight seconds went by, and this had not come about: ${name}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A stand-in for what Claude Code hands a mod. `submits` are the prompts it was asked to start. */
function fakeHost() {
  const handlers: Record<string, (...args: any[]) => any> = {}
  const submits: { text: string; asUser?: true; context?: readonly string[]; settle: (result?: unknown) => void; refuse: () => void }[] = []
  /** Whether this Claude Code passes a prompt an add-on submits through that add-on's own hook on prompts, as the real one does. */
  const passes = { ownHooks: true }
  const env: Record<string, string | undefined> = { IT_HOME: home }
  let tick: () => Promise<void> = async () => {}
  const state = { session: 'session-1' }
  // What the mod is waiting on outside itself: a file it is reading, or a question to the
  // connector that is not over. Whatever the mod does about either it does the moment it has
  // it, with nothing else getting a turn in between.
  let waiting = 0
  let put = 0
  const outside = <T>(work: Promise<T>): Promise<T> => {
    waiting++
    return work.finally(() => {
      waiting--
    })
  }
  const $ = {
    env: {
      get: async (k: string) => env[k],
      set: async (k: string, v: string) => {
        env[k] = v
      },
    },
    fs: { read: (p: string) => outside((async () => (await import('node:fs/promises')).readFile(p, 'utf8'))()) },
    session: { id: async () => state.session },
    clock: {
      every: (_ms: number, fn: () => Promise<void>) => {
        tick = fn
      },
      // Claude Code's own one-shot timer, which is all a mod has: it has no setTimeout
      after: (ms: number, fn: () => void) => {
        const t = setTimeout(fn, ms)
        return { cancel: () => clearTimeout(t) }
      },
    },
    prompt: {
      submit: ({ text, asUser }: { text: string; asUser?: true }) => {
        const entered = (e: { text: string; context?: readonly string[] }) =>
          new Promise((resolve, reject) =>
            submits.push({
              text: e.text,
              ...(asUser ? { asUser } : {}),
              ...(e.context ? { context: e.context } : {}),
              settle: (r = {}) => resolve(r),
              refuse: () => reject(new Error('refused')),
            }),
          )
        const hook = handlers['prompt.submit']
        const e = { text, wait: false, origin: { kind: 'plugin', name: 'it-bridge', ...(asUser ? { asUser } : {}) } }
        return hook && passes.ownHooks ? hook($, e, entered) : entered(e)
      },
    },
    http: {
      fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) =>
        outside(
          new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
            put++
            const u = new URL(url)
            // A connection of its own for each request, so that none is sent down one left over from a server that has gone
            const req = http.request(
              { socketPath: init.socketPath, path: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers, agent: false },
              (res) => {
                let text = ''
                res.on('data', (c) => (text += c)).on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, text }))
              },
            )
            req.on('error', reject)
            if (init.body) req.write(init.body)
            req.end()
          }),
        ),
    },
  }
  const on = (event: string, fn: (...args: any[]) => any) => {
    handlers[event] = fn
  }
  const fire = (event: string, e: Record<string, unknown> = {}, result: Record<string, unknown> = {}) => handlers[event]!($, e, async () => result)
  return {
    $,
    on,
    fire,
    handlers,
    submits,
    passes,
    env,
    state,
    tick: () => tick(),
    /** How many questions the mod has put to the connector, answered or not. */
    put: () => put,
    /**
     * The mod waits on nothing outside itself: every question it had put to the connector is
     * over, and it has done whatever it does about each answer. A turn is given first, by
     * which whatever was just set going has put its question, if it is going to.
     */
    settle: async () => {
      await turn()
      await until(() => waiting === 0, 'the mod has read every answer it asked for')
      await turn()
    },
  }
}
const hostHandlers = (host: ReturnType<typeof fakeHost>) => host.handlers

async function start() {
  vi.resetModules()
  const { register } = await import('./it-bridge/hooks/register.js')
  const host = fakeHost()
  register(host.on)
  await host.fire('session.start')
  return host
}
const acks = () => asked.filter((a) => a.path === '/ack').flatMap((a) => a.body.ids as string[])
/** Whether each report said the click started a turn (true), joined one (false), or did not say. */
const wokes = () => asked.filter((a) => a.path === '/ack').map((a) => a.body.woke as boolean | undefined)

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'it-mod-'))
  offered = []
  asked = []
  server = await fakeConnector(path.join(home, 'connector.sock'))
  writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: path.join(home, 'connector.sock'), token: 'a'.repeat(48) }))
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(home, { recursive: true, force: true })
})

describe('the Claude Code add-on', () => {
  test('asks the connector for this conversation’s clicks, and tells commands which conversation they are in', async () => {
    const host = await start()
    await host.tick()
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-1')
    expect([host.env.IT_HARNESS, host.env.IT_SESSION]).toEqual(['claude-code', 'session-1'])
  })

  test('an idle conversation is given a click as a turn, in the connector’s own words, and only then is it reported', async () => {
    const host = await start()
    // The words an agent is given for a click, as the connector makes them
    const text = describeClick({ id: 'click-1', artifact: 'plan', title: 'Plan', name: 'approve', payload: {}, at: 1, attended: true })
    offered = [{ id: 'click-1', text }]
    await host.tick()
    expect(host.submits.map((s) => s.text)).toEqual([text])
    expect(acks()).toEqual([])
    host.submits[0]!.settle()
    await host.settle()
    expect(acks()).toEqual(['click-1'])
    // It started a turn, and says so: the connector counts that apart from a click that joined one
    expect(wokes()).toEqual([true])
  })

  test('a click starts a turn in a few words, as the person’s own message, and nothing the page sent is put into them', async () => {
    const host = await start()
    const click = {
      id: 'click-1',
      artifact: 'chess',
      title: 'Chess',
      name: 'move',
      payload: { move: 'Qb3', fen: 'rnbqkbnr/pppp1ppp/8/4p3/2P5/1Q6/PP1PPPPP/RNB1KBNR b KQkq - 1 2' },
      at: 1,
      attended: true,
    }
    offered = [{ id: 'click-1', text: describeClick(click), brief: briefClick(click) }]
    await host.tick()
    expect(host.submits.length).toBe(1)
    const sent = host.submits[0]!
    // What stands in the conversation: the page, what was done, that there is more to read, and the id to read it by
    expect(sent.text).toBe('[It] "Chess" (chess): move, with details [action click-1]')
    // Submitted as the person's own, which is the one way Claude Code shows it as it is and adds no lines of its own
    expect(sent.asUser).toBe(true)
    expect(sent.text).not.toContain('Qb3')
    expect(sent.context).toBeUndefined()
    sent.settle()
    await host.settle()
    expect(acks()).toEqual(['click-1'])
    expect(wokes()).toEqual([true])
  })

  test('every click after the first goes the same way, and several at once are a line each', async () => {
    const host = await start()
    const one = { id: 'click-1', artifact: 'chess', title: 'Chess', name: 'move', payload: { move: 'Qb3' }, at: 1, attended: true }
    const two = { ...one, id: 'click-2', name: 'resign', payload: {} }
    const three = { ...one, id: 'click-3', name: 'tick', payload: null, attended: false }
    offered = [{ id: 'click-1', text: describeClick(one), brief: briefClick(one) }]
    await host.tick()
    host.submits[0]!.settle()
    await host.settle()
    offered = [
      { id: 'click-2', text: describeClick(two), brief: briefClick(two) },
      { id: 'click-3', text: describeClick(three), brief: briefClick(three) },
    ]
    await host.tick()
    expect(host.submits[1]!.text).toBe('[It] "Chess" (chess): resign [action click-2]\n[It] "Chess" (chess): tick, sent by the page itself [action click-3]')
    expect(host.submits[1]!.asUser).toBe(true)
  })

  test('a connector from before it gave a few words for a click gives the whole wording, and that is what is submitted, still as the person’s own', async () => {
    const host = await start()
    const click = { id: 'click-1', artifact: 'chess', title: 'Chess', name: 'move', payload: { move: 'Qb3' }, at: 1, attended: true }
    offered = [{ id: 'click-1', text: describeClick(click) }]
    await host.tick()
    expect(host.submits[0]!.text).toBe(describeClick(click))
    expect(host.submits[0]!.asUser).toBe(true)
  })

  test('a click still on offer while it is being handed over is not handed over twice', async () => {
    const host = await start()
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    // The prompt has not been accepted yet, and the connector is asked again, and again
    await host.tick()
    await host.tick()
    expect(host.submits.length).toBe(1)
    host.submits[0]!.settle()
    await host.settle()
    // The report was lost: the connector offers it once more. It is reported again, and not given again.
    offered = [{ id: 'click-1', text: 'one' }]
    asked = []
    await host.tick()
    await host.settle()
    expect(host.submits.length).toBe(1)
    expect(acks()).toEqual(['click-1'])
  })

  test('a prompt that was refused or dropped is not reported as given, and is tried again less and less often', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const later = (ms: number) => vi.setSystemTime(Date.now() + ms)
    try {
      const host = await start()
      offered = [{ id: 'click-1', text: 'one' }]
      await host.tick()
      host.submits[0]!.settle({ drop: 'another hook said no' })
      await host.settle()
      expect(acks()).toEqual([])
      // Not again at once: the person's hooks are not run every second while they refuse
      await host.tick()
      expect(host.submits.length).toBe(1)
      later(1100)
      await host.tick()
      expect(host.submits.length).toBe(2)
      host.submits[1]!.refuse()
      await host.settle()
      expect(acks()).toEqual([])
      later(1100)
      await host.tick()
      expect(host.submits.length).toBe(2)
      later(4000)
      await host.tick()
      host.submits[2]!.settle()
      await host.settle()
      expect(acks()).toEqual(['click-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  test('how often one conversation refused does not hold up the conversation that takes its place', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const later = (ms: number) => vi.setSystemTime(Date.now() + ms)
    try {
      const host = await start()
      offered = [{ id: 'click-1', text: 'for the first conversation' }]
      // The first conversation's hooks refuse again and again, and the waits between tries grow to minutes
      await host.tick()
      for (let i = 0; i < 4; i++) {
        host.submits[i]!.settle({ drop: 'a hook said no' })
        await host.settle()
        later([1100, 5100, 31_000, 121_000][i]!)
        await host.tick()
      }
      expect(host.submits.length).toBe(5)
      // A refusal that arrives after the person has resumed another conversation is the first one's too
      await host.fire('session.end', { reason: 'resume', sessionId: 'session-1' })
      host.state.session = 'session-other'
      host.submits[4]!.settle({ drop: 'a hook said no' })
      await host.settle()
      // The new conversation's click is handed over at once, not ten minutes from now
      offered = [{ id: 'click-2', text: 'for the other conversation' }]
      await host.tick()
      await host.settle()
      expect(host.submits.length).toBe(6)
      expect(host.submits[5]!.text).toContain('for the other conversation')
      host.submits[5]!.settle()
      await host.settle()
      expect(acks()).toEqual(['click-2'])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a click is not reported while its prompt is still on its way, so one that is then dropped was never called given', async () => {
    const host = await start()
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    // The person's own hook is still looking at the prompt, and the connector is asked again and again
    await host.tick()
    await host.tick()
    await host.settle()
    expect([host.submits.length, acks()]).toEqual([1, []])
    host.submits[0]!.settle({ drop: 'a hook said no' })
    await host.settle()
    expect(acks()).toEqual([])
  })

  test('a click the connector has stopped offering is not given from memory', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const host = await start()
      offered = [{ id: 'click-1', text: 'one' }]
      await host.tick()
      host.submits[0]!.refuse()
      await host.settle()
      // Its lease ran out meanwhile and something else delivered it: the connector offers nothing
      offered = []
      vi.setSystemTime(Date.now() + 2000)
      await host.tick()
      await host.settle()
      expect(host.submits.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('during a turn a click rides along with the next tool result, of the conversation itself and not of a subagent', async () => {
    const host = await start()
    await host.fire('turn.start')
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    expect(host.submits.length).toBe(0)
    // A subagent's tool call is the subagent's: nothing is added to it
    const theirs = await host.fire('tool.call', { agentId: 'subagent-7' }, { output: 'x' })
    expect(theirs).toEqual({ output: 'x' })
    expect(acks()).toEqual([])
    // A refused tool call is left alone too
    expect(await host.fire('tool.call', {}, { deny: 'no' })).toEqual({ deny: 'no' })
    const ours = await host.fire('tool.call', {}, { output: 'x', context: ['already there'] })
    expect(ours).toEqual({ output: 'x', context: ['already there', 'one'] })
    await host.settle()
    expect(acks()).toEqual(['click-1'])
    // It joined a turn that was running, and says so
    expect(wokes()).toEqual([false])
    // Given once: the end of the turn does not start another turn for it
    await host.fire('turn.complete')
    expect(host.submits.length).toBe(0)
  })

  test('a click that arrives in a turn with no tool calls starts a turn when that one ends, even if the turn failed', async () => {
    const host = await start()
    await host.fire('turn.start')
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    // The turn ends by failing: the add-on must still notice that it ended
    const failing =
      host.on &&
      (async () => {
        throw new Error('the turn failed')
      })
    await expect(hostHandlers(host)['turn.complete'](host.$, {}, failing)).rejects.toThrow('the turn failed')
    expect(host.submits.map((s) => s.text)).toEqual(['one'])
  })

  test('a helper finishing its own turn does not end the conversation’s: the click still joins the running turn', async () => {
    const host = await start()
    await host.fire('turn.start')
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    // A subagent starts and finishes inside the conversation's turn
    await host.fire('turn.start', { agentId: 'subagent-7' })
    await host.fire('turn.complete', { agentId: 'subagent-7' })
    await host.tick()
    // Nothing was started for the click: the conversation is still working
    expect(host.submits.length).toBe(0)
    expect(acks()).toEqual([])
    // It rides the conversation's own next tool result, as a click in a running turn does
    const ours = await host.fire('tool.call', {}, { output: 'x' })
    expect(ours).toEqual({ output: 'x', context: ['one'] })
    await host.settle()
    expect(acks()).toEqual(['click-1'])
    expect(wokes()).toEqual([false])
  })

  test('after /clear the conversation has a new id: the connector is told which it was, and commands are told the new one', async () => {
    const host = await start()
    await host.tick()
    // Claude Code says the conversation ended by being cleared, and goes on under a new id
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-1' })
    host.state.session = 'session-2'
    await host.tick()
    expect(asked.find((a) => a.path === '/session')?.body).toEqual({ harness: 'claude-code', session: 'session-2', was: 'session-1' })
    expect(host.env.IT_SESSION).toBe('session-2')
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-2')
  })

  /** Each change of id the connector was told of, in the order it was told. */
  const told = () => asked.filter((a) => a.path === '/session').map((a) => `${a.body.was} is now ${a.body.session}`)

  test('a conversation cleared twice before the connector is next asked has both changes of id told, in the order they happened', async () => {
    const host = await start()
    await host.tick()
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-1' })
    host.state.session = 'session-2'
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-2' })
    host.state.session = 'session-3'
    await host.tick()
    // The pages made under the first id follow the conversation through the second to the third
    expect(told()).toEqual(['session-1 is now session-2', 'session-2 is now session-3'])
    expect(host.env.IT_SESSION).toBe('session-3')
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-3')
    // Told once: the next check only asks for clicks
    await host.tick()
    expect(told().length).toBe(2)
  })

  test('a change of id the connector could not be told of is kept, and told before any that came after it', async () => {
    const host = await start()
    await host.tick()
    // The connector cannot take a change of id for a while
    const reach = host.$.http.fetch
    let down = true
    host.$.http.fetch = async (url, init) => (down && url.endsWith('/session') ? { ok: false, status: 503, text: '{}' } : reach(url, init))
    offered = [{ id: 'click-1', text: 'on a page the first id made' }]
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-1' })
    host.state.session = 'session-2'
    await host.tick()
    await host.tick()
    // Until it has, nothing is asked for under the new id: the connector would not yet know whose the old pages are
    expect(told()).toEqual([])
    expect(asked.some((a) => a.path.includes('session-2'))).toBe(false)
    // The conversation is cleared again while the connector still has not been told of the first time
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-2' })
    host.state.session = 'session-3'
    await host.tick()
    expect(told()).toEqual([])
    down = false
    await host.tick()
    expect(told()).toEqual(['session-1 is now session-2', 'session-2 is now session-3'])
    // And a click on a page the first id made arrives in the conversation as it is now
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-3')
    expect(host.submits.map((s) => s.text)).toEqual(['on a page the first id made'])
  })

  test('a conversation that was resumed, and cleared before the connector was first asked, still takes its pages with it', async () => {
    const host = await start()
    // Nothing has been asked yet: the person resumed a conversation and cleared it at once
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-1' })
    host.state.session = 'session-2'
    await host.tick()
    expect(told()).toEqual(['session-1 is now session-2'])
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-2')
  })

  test('a conversation that was cleared and then left for another has its change of id told, and the other is not taken for it', async () => {
    const host = await start()
    offered = [{ id: 'click-1', text: 'for the first conversation' }]
    await host.fire('turn.start')
    await host.tick()
    await host.fire('session.end', { reason: 'clear', sessionId: 'session-1' })
    host.state.session = 'session-2'
    // Before the connector is asked again, the person resumes an unrelated conversation
    await host.fire('session.end', { reason: 'resume', sessionId: 'session-2' })
    host.state.session = 'session-other'
    offered = []
    await host.tick()
    // The first conversation's pages follow it to the id it was left under, where it can be resumed
    expect(told()).toEqual(['session-1 is now session-2'])
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-other')
    // What was taken for the first conversation is not handed to the one that took its place
    const result = await host.fire('tool.call', {}, {})
    expect(result.context ?? []).toEqual([])
  })

  test('resuming another conversation in the same window does not take the first one’s pages with it', async () => {
    const host = await start()
    offered = [{ id: 'click-1', text: 'for the first conversation' }]
    await host.fire('turn.start')
    await host.tick()
    // The person resumes an unrelated conversation: another takes this one's place
    await host.fire('session.end', { reason: 'resume', sessionId: 'session-1' })
    host.state.session = 'session-other'
    offered = []
    await host.tick()
    expect(asked.some((a) => a.path === '/session')).toBe(false)
    expect(host.env.IT_SESSION).toBe('session-other')
    expect(asked.at(-1)!.path).toBe('/clicks?harness=claude-code&session=session-other')
    // What was taken for the first conversation is not handed to the second
    const result = await host.fire('tool.call', {}, {})
    expect(result.context ?? []).toEqual([])
    await host.fire('turn.complete')
    await host.settle()
    expect([host.submits.length, acks()]).toEqual([0, []])
  })

  test('an answer that was asked for before another conversation took this one’s place is not believed', async () => {
    const host = await start()
    await host.tick()
    // The connector is slow to answer a question asked for the first conversation
    let answer: (() => void) | null = null
    const slow = http.createServer((req, res) => {
      req.resume()
      answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ clicks: [{ id: 'click-1', text: 'for the first conversation' }] }))
      }
    })
    await new Promise((r) => server.close(r))
    server = await new Promise<http.Server>((resolve) => slow.listen(path.join(home, 'connector.sock'), () => resolve(slow)))
    try {
      const asking = host.tick()
      await until(() => answer !== null, 'the question has reached the connector')
      // Meanwhile the person resumes another conversation
      await host.fire('session.end', { reason: 'resume', sessionId: 'session-1' })
      host.state.session = 'session-other'
      answer!()
      await asking
      await host.settle()
      expect(host.submits).toEqual([])
      const result = await host.fire('tool.call', {}, {})
      expect(result.context ?? []).toEqual([])
    } finally {
      slow.closeAllConnections()
    }
  })

  test('checks do not pile up behind a connector that is slow to answer', async () => {
    const host = await start()
    await host.tick()
    asked = []
    // The connector stops answering for a while: checks made meanwhile are skipped, not queued
    let reached = 0
    const slow = http.createServer(() => {
      reached++
    })
    await new Promise((r) => server.close(r))
    server = await new Promise<http.Server>((resolve) => slow.listen(path.join(home, 'connector.sock'), () => resolve(slow)))
    try {
      const first = host.tick()
      await until(() => reached === 1, 'the question has reached the connector')
      const put = host.put()
      // A second later, and a second after that, the clock asks again
      await host.tick()
      await host.tick()
      await turn()
      expect(host.put()).toBe(put)
      expect(reached).toBe(1)
      // And the one in flight is given up on after a few seconds, so nothing stays open for good
      await first
    } finally {
      slow.closeAllConnections()
    }
  }, 10_000)

  test('It is looked for where it was when the add-on was set up, if nothing in the environment says where', async () => {
    const source = readFileSync(new URL('./it-bridge/hooks/register.js', import.meta.url), 'utf8')
    expect(source.match(/^const IT_HOME_AT_SETUP = null$/gm)?.length).toBe(1)
    // As `it setup` writes it when It lives somewhere of its own
    const filled = path.join(home, 'register.filled.mjs')
    writeFileSync(filled, source.replace(/^const IT_HOME_AT_SETUP = null$/m, `const IT_HOME_AT_SETUP = ${JSON.stringify(home)}`))
    vi.resetModules()
    const { register } = await import(filled)
    const host = fakeHost()
    // The harness was started from somewhere that was never told where It is
    host.env.IT_HOME = undefined
    host.env.HOME = '/nowhere'
    register(host.on)
    await host.fire('session.start')
    await host.tick()
    expect(asked.at(-1)?.path).toBe('/clicks?harness=claude-code&session=session-1')
  })

  test('with nothing said about where It is, it is looked for in the person’s own folder as the `it` command finds that folder', async () => {
    // It's usual folder, inside a person's own, with a connector in it
    const person = mkdtempSync(path.join(os.tmpdir(), 'it-mod-person-'))
    mkdirSync(path.join(person, '.it'))
    writeFileSync(path.join(person, '.it', 'connector.json'), JSON.stringify({ socket: 'beside this file', token: 'a'.repeat(48) }))
    const usual = await fakeConnector(path.join(person, '.it', 'connector.sock'))
    try {
      const found = async (env: Record<string, string | undefined>) => {
        const host = await start()
        Object.assign(host.env, { IT_HOME: undefined, ...env })
        asked = []
        await host.tick()
        return asked.length > 0
      }
      // On Windows the `it` command goes by USERPROFILE, whatever a shell has put in HOME
      expect(await found({ OS: 'Windows_NT', USERPROFILE: person, HOME: path.join(person, 'a-shell-s-own-home') })).toBe(true)
      expect(await found({ OS: 'Windows_NT', USERPROFILE: person, HOME: '' })).toBe(true)
      // Anywhere else it goes by HOME
      expect(await found({ HOME: person, USERPROFILE: path.join(person, 'left-over-from-elsewhere') })).toBe(true)
      expect(await found({ HOME: path.join(person, 'not-here') })).toBe(false)
    } finally {
      await new Promise((r) => usual.close(r))
      rmSync(person, { recursive: true, force: true })
    }
  })

  test('it uses nothing a mod does not have: no timers of its own, no Node', async () => {
    const source = readFileSync(new URL('./it-bridge/hooks/register.js', import.meta.url), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n')
    for (const missing of ['setTimeout(', 'clearTimeout(', 'setInterval(', 'clearInterval(', 'require(', 'process.', 'Buffer.', "from 'node:"])
      expect(code).not.toContain(missing)
  })

  test('nothing in the connector’s file can point the add-on anywhere but the socket beside it', async () => {
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: '/tmp/somewhere-else.sock', port: '1@evil.example', token: 'a'.repeat(48) }))
    const host = await start()
    offered = [{ id: 'click-1', text: 'one' }]
    await host.tick()
    // It still reached the real connector, on the socket in its own folder
    expect(host.submits.length).toBe(1)
  })

  test('over a port the token is never sent, and an answer that is not sealed with it is not believed', async () => {
    const { createHmac } = await import('node:crypto')
    const token = 'b'.repeat(48)
    const seen: http.IncomingHttpHeaders[] = []
    let honest = true
    const tcp = http.createServer((req, res) => {
      seen.push(req.headers)
      const body = JSON.stringify({ clicks: [{ id: honest ? 'click-real' : 'click-forged', text: honest ? 'real' : 'forged approval' }] })
      const sealed = createHmac('sha256', token).update(`${req.headers['x-it-nonce']}\n200\n${body}`).digest('hex')
      res.writeHead(200, honest ? { 'x-it-mac': sealed } : {}).end(body)
    })
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
    const port = (tcp.address() as { port: number }).port
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port, token }))
    try {
      const host = fakeHost()
      // The stand-in for Claude Code's own fetch, over a port this time, with headers in the answer
      host.$.http.fetch = (url: string, init: any) =>
        fetch(url, { method: init.method, headers: init.headers, body: init.body }).then(async (r) => ({
          ok: r.ok,
          status: r.status,
          text: await r.text(),
          headers: Object.fromEntries(r.headers),
        }))
      vi.resetModules()
      const { register } = await import('./it-bridge/hooks/register.js')
      register(host.on)
      await host.fire('session.start')
      // Something else has taken the port and answers with a click of its own making
      honest = false
      await host.tick()
      expect(host.submits).toEqual([])
      expect(JSON.stringify(seen)).not.toContain(token)
      expect(seen[0]!['x-it-mac']).toMatch(/^[0-9a-f]{64}$/)
      // The real connector's answers are believed
      honest = true
      await host.tick()
      expect(host.submits.map((s) => s.text)).toEqual(['real'])
    } finally {
      await new Promise((r) => tcp.close(r))
    }
  })

  test('with no connector, or a file that is not what the connector writes, it does nothing and breaks nothing', async () => {
    for (const content of ['', 'not json', '{}', JSON.stringify({ port: 80, token: 'short' }), JSON.stringify({ port: '8080', token: 'a'.repeat(48) })]) {
      writeFileSync(path.join(home, 'connector.json'), content)
      const host = await start()
      asked = []
      await host.tick()
      expect(asked).toEqual([])
      expect(host.submits).toEqual([])
    }
    rmSync(path.join(home, 'connector.json'))
    const host = await start()
    await host.tick()
    expect(host.submits).toEqual([])
  })
})

describe('what Claude Code asks of a module before it loads it', () => {
  test('every variable the add-on reads or sets is named plainly where it is asked for, since Claude Code refuses a module that works a name out', () => {
    const source = readFileSync(new URL('./it-bridge/hooks/register.js', import.meta.url), 'utf8')
    const asked = [...source.matchAll(/\$\.env\.(get|set)\(\s*([^)\s,]*)/g)].map((m) => m[2])
    expect(asked.length).toBeGreaterThan(3)
    // A name written out begins and ends with a quote
    expect(asked.filter((name) => !/^'[A-Z_]+'$/.test(name))).toEqual([])
  })

  test('a click that comes with no words is given to nobody: Claude Code takes no empty message, and no empty note beside what a tool gave back', async () => {
    const host = await start()
    offered = [{ id: 'click-1', text: '' }, { id: 'click-2' } as Click]
    await host.tick()
    expect(host.submits).toEqual([])
    await host.fire('turn.start')
    await host.tick()
    expect(await host.fire('tool.call', {}, { output: 'what the tool gave back' })).toEqual({ output: 'what the tool gave back' })
    expect(acks()).toEqual([])
  })

  test.each([{ length: 48 }, { length: 128 }])(
    'over a port, a message is sealed and an answer checked with the one kind of hashing Claude Code gives a module (a token of $length letters)',
    async ({ length }) => {
      const { createHmac, webcrypto } = await import('node:crypto')
      const token = 'c'.repeat(length)
      const sealed = (nonce: unknown, what: string) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')
      const rightlySealed: boolean[] = []
      const tcp = http.createServer((req, res) => {
        let text = ''
        req
          .on('data', (c) => (text += c))
          .on('end', () => {
            rightlySealed.push(req.headers['x-it-mac'] === sealed(req.headers['x-it-nonce'], `${req.method}\n${req.url}\n${text}`))
            const body = JSON.stringify({ clicks: [{ id: 'click-1', text: 'one' }] })
            res.writeHead(200, { 'x-it-mac': sealed(req.headers['x-it-nonce'], `200\n${body}`) }).end(body)
          })
      })
      await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
      writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ port: (tcp.address() as { port: number }).port, token }))
      // All that Claude Code gives a module under this name: one way of hashing, and random bytes
      vi.stubGlobal('crypto', {
        subtle: { digest: (algorithm: string, data: ArrayBufferView) => webcrypto.subtle.digest(algorithm, data) },
        randomUUID: () => webcrypto.randomUUID(),
        getRandomValues: <T extends ArrayBufferView>(array: T) => webcrypto.getRandomValues(array as never) as T,
      })
      try {
        const host = fakeHost()
        host.$.http.fetch = (url: string, init: any) =>
          fetch(url, { method: init.method, headers: init.headers, body: init.body }).then(async (r) => ({
            ok: r.ok,
            status: r.status,
            text: await r.text(),
            headers: Object.fromEntries(r.headers),
          }))
        vi.resetModules()
        const { register } = await import('./it-bridge/hooks/register.js')
        register(host.on)
        await host.fire('session.start')
        await host.tick()
        expect(rightlySealed.length).toBeGreaterThan(0)
        expect(rightlySealed).not.toContain(false)
        expect(host.submits.map((s) => s.text)).toEqual(['one'])
      } finally {
        vi.unstubAllGlobals()
        await new Promise((r) => tcp.close(r))
      }
    },
  )
})
