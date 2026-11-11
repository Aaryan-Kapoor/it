// `it mcp`: the protocol itself against commands that are stood in for, and then the built
// program over its real standard input and output.
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  actionsUri,
  conversationEnv,
  type Follow,
  MCP_REVISIONS,
  pageOf,
  type Ran,
  type Run,
  result,
  serveMcp,
  sessionNamed,
  TOOLS,
  WAIT_MOST,
  WATCHED_MOST,
} from './src/mcp'

type Json = Record<string, any>

/** A client on a pair of streams: sends a message, and waits for the one that answers it. */
function client(run: Run, follow?: Follow) {
  const input = new PassThrough()
  const output = new PassThrough()
  const heard: Json[] = []
  const waiting: ((message: Json) => void)[] = []
  createInterface({ input: output }).on('line', (line) => {
    const message = JSON.parse(line) as Json
    heard.push(message)
    for (const each of waiting.splice(0)) each(message)
  })
  let ended = false
  const server = serveMcp({ input, output, run, follow: follow ?? (() => ({ stop: () => {} })), version: '9.9.9', done: () => (ended = true) })
  let next = 0
  const until = (found: (message: Json) => boolean) =>
    new Promise<Json>((resolve) => {
      const look = () => {
        const one = heard.find(found)
        if (one) return resolve(one)
        waiting.push(look)
      }
      look()
    })
  return {
    heard,
    server,
    ended: () => ended,
    notify: (method: string, params: Json = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    raw: (line: string) => input.write(`${line}\n`),
    until,
    ask: (method: string, params: Json = {}) => {
      const id = ++next
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return until((m) => m.id === id)
    },
    close: () => input.end(),
  }
}

/** Commands that are stood in for: each run is recorded, and answered as the test says. */
function commands(answer: (words: string[]) => Ran | Promise<Ran> = () => ({ code: 0, stdout: '{"ok":true}\n', stderr: '' })) {
  const ran: { words: string[]; stdin?: string }[] = []
  const run: Run = async (words, opts) => {
    ran.push({ words, stdin: opts?.stdin })
    return answer(words)
  }
  return { ran, run }
}

describe('the MCP server', () => {
  it('answers a client that begins with the revision it asked for, or the newest it has', async () => {
    const c = client(commands().run)
    const known = await c.ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(known.result.protocolVersion).toBe('2025-03-26')
    expect(known.result.serverInfo).toEqual({ name: 'it', title: 'It', version: '9.9.9' })
    expect(known.result.capabilities.tools).toBeDefined()
    expect(known.result.capabilities.resources.subscribe).toBe(true)
    const other = await c.ask('initialize', { protocolVersion: '1999-01-01' })
    expect(other.result.protocolVersion).toBe(MCP_REVISIONS[0])
    expect((await c.ask('ping')).result).toEqual({})
  })

  it('lists a tool for each command an agent uses, each with a schema that takes nothing unnamed', async () => {
    const c = client(commands().run)
    const { tools } = (await c.ask('tools/list')).result
    expect(tools.map((t: Json) => t.name)).toEqual([
      'it_guide',
      'it_status',
      'it_create',
      'it_update',
      'it_state',
      'it_patch',
      'it_say',
      'it_open',
      'it_displays',
      'it_list',
      'it_read',
      'it_wait',
      'it_actions',
      'it_action',
      'it_ack',
    ])
    for (const tool of tools) {
      expect([tool.name, tool.inputSchema.type, tool.inputSchema.additionalProperties]).toEqual([tool.name, 'object', false])
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('publishes a page with the words an agent would have typed, and the page piped in', async () => {
    const { ran, run } = commands(() => ({ code: 0, stdout: '{"url":"http://localhost:4700/p/plan","shownOn":[]}\n', stderr: '' }))
    const c = client(run)
    const answer = await c.ask('tools/call', {
      name: 'it_create',
      arguments: { title: 'Deploy plan', id: 'plan', html: '<p>hello</p>', state: { step: 1 }, open: true, onId: 'd1' },
    })
    expect(ran).toEqual([{ words: ['create', 'Deploy plan', '--id', 'plan', '--state', '{"step":1}', '--open', '--on-id', 'd1'], stdin: '<p>hello</p>' }])
    expect(answer.result.isError).toBeUndefined()
    expect(answer.result.structuredContent).toEqual({ url: 'http://localhost:4700/p/plan', shownOn: [] })
    expect(answer.result.content[0].text).toContain('"url"')
  })

  it('gives each tool its command', async () => {
    const { ran, run } = commands()
    const c = client(run)
    const calls: [string, Json, string[]][] = [
      ['it_guide', {}, ['skill']],
      ['it_guide', { topic: 'page' }, ['help', 'page']],
      ['it_status', {}, ['status']],
      ['it_update', { id: 'plan', html: '<b>2</b>', title: 'Two' }, ['update', 'plan', '--title', 'Two']],
      ['it_state', { id: 'plan' }, ['state', 'plan']],
      ['it_patch', { id: 'plan', patch: { a: null }, ifRevision: 3 }, ['patch', 'plan', '{"a":null}', '--if-revision', '3']],
      ['it_say', { id: 'plan', text: 'On it.' }, ['say', 'plan', 'On it.']],
      ['it_say', { id: 'plan' }, ['say', 'plan']],
      ['it_open', { id: 'plan', on: 'Kitchen' }, ['open', 'plan', '--on', 'Kitchen']],
      ['it_displays', {}, ['displays']],
      ['it_list', {}, ['list']],
      ['it_read', { id: 'plan' }, ['read', 'plan']],
      ['it_wait', { id: 'plan', timeout: 5 }, ['wait', '--id', 'plan', '--timeout', '5']],
      ['it_wait', {}, ['wait', '--timeout', '25']],
      ['it_actions', {}, ['actions']],
      ['it_actions', { id: 'plan' }, ['actions', '--id', 'plan']],
      ['it_action', { action: 'a1' }, ['action', 'a1']],
      ['it_ack', { action: 'a1', failed: true }, ['ack', 'a1', '--failed']],
    ]
    for (const [name, args] of calls) expect((await c.ask('tools/call', { name, arguments: args })).result.isError).toBeUndefined()
    expect(ran.map((r) => r.words)).toEqual(calls.map(([, , words]) => words))
  })

  it('refuses, before any command runs, a value the command would read as a switch, a name the tool does not take, and a wait longer than a client keeps a call', async () => {
    const { ran, run } = commands()
    const c = client(run)
    const refused: [string, Json][] = [
      ['it_state', { id: '--all' }],
      ['it_create', { title: '--take', id: 'plan', html: '<p></p>' }],
      ['it_create', { title: 'T', id: 'plan', html: '' }],
      ['it_create', { title: 'T', id: 'plan', html: '<p></p>', file: '/etc/passwd' }],
      ['it_create', { title: 'T', id: 'plan', html: '<p></p>', state: 'x' }],
      ['it_open', { id: 'plan', on: 'A', everywhere: true }],
      ['it_open', { id: 'plan', on: '--everywhere' }],
      ['it_patch', { id: 'plan', patch: [1] }],
      ['it_patch', { id: 'plan', patch: {}, ifRevision: -1 }],
      ['it_wait', { timeout: WAIT_MOST + 1 }],
      ['it_ack', { action: '--failed' }],
      ['it_say', { id: 'plan', text: '--json' }],
      ['it_state', {}],
    ]
    for (const [name, args] of refused) {
      const answer = await c.ask('tools/call', { name, arguments: args })
      expect([name, args, answer.result?.isError]).toEqual([name, args, true])
      expect(JSON.parse(answer.result.content[0].text).error.code).toBe('invalid')
    }
    expect(ran).toEqual([])
    expect((await c.ask('tools/call', { name: 'it_serve', arguments: {} })).error.code).toBe(-32602)
  })

  it('hands a failed command back as an error with what the command said, and never as a failure of the protocol', async () => {
    const said = '{"note":"a note"}\n{"error":{"code":"conflict","message":"That id is another conversation\'s page."}}\n'
    const c = client(commands(() => ({ code: 1, stdout: '', stderr: said })).run)
    const answer = await c.ask('tools/call', { name: 'it_create', arguments: { title: 'T', id: 'plan', html: '<p></p>' } })
    expect(answer.error).toBeUndefined()
    expect(answer.result.isError).toBe(true)
    expect(answer.result.structuredContent.error.code).toBe('conflict')
  })

  it('stops a call the client gives up, and does not answer it', async () => {
    let stopped = false
    const run: Run = (_words, opts) =>
      new Promise((resolve) =>
        opts?.signal?.addEventListener('abort', () => {
          stopped = true
          resolve({ code: 1, stdout: '', stderr: '' })
        }),
      )
    const c = client(run)
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'it_wait', arguments: {} } }))
    c.notify('notifications/cancelled', { requestId: 'w1' })
    expect((await c.ask('ping')).result).toEqual({})
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(true)
    expect(c.heard.find((m) => m.id === 'w1')).toBeUndefined()
  })

  it("tells a client that subscribed to a page's actions when one arrives, by watching and never claiming, until it unsubscribes or goes", async () => {
    const following: { words: string[]; line: (text: string) => void; stopped: boolean }[] = []
    const follow: Follow = (words, line) => {
      const one = { words, line, stopped: false }
      following.push(one)
      return { stop: () => (one.stopped = true) }
    }
    const { ran, run } = commands(() => ({ code: 0, stdout: '[{"id":"a1","name":"approve"}]\n', stderr: '' }))
    const c = client(run, follow)
    const uri = actionsUri('plan')
    expect((await c.ask('resources/templates/list')).result.resourceTemplates[0].uriTemplate).toBe('it://page/{id}/actions')
    expect((await c.ask('resources/subscribe', { uri })).result).toEqual({})
    expect((await c.ask('resources/subscribe', { uri })).result).toEqual({})
    expect(following.map((f) => f.words)).toEqual([['actions', '--id', 'plan', '--follow']])
    following[0]!.line('{"id":"a1"}')
    expect((await c.until((m) => m.method === 'notifications/resources/updated')).params).toEqual({ uri })
    // The notification names the page and carries nothing of the action: the client reads it
    const read = await c.ask('resources/read', { uri })
    expect(JSON.parse(read.result.contents[0].text)).toEqual([{ id: 'a1', name: 'approve' }])
    expect(ran.at(-1)!.words).toEqual(['actions', '--id', 'plan'])
    expect((await c.ask('resources/subscribe', { uri: 'it://page/--all/actions' })).error.code).toBe(-32002)
    expect((await c.ask('resources/read', { uri: 'file:///etc/passwd' })).error.code).toBe(-32002)
    await c.ask('resources/subscribe', { uri: actionsUri('other') })
    // Each watched page is a command that goes on running, so there are only so many
    for (let n = 2; n < WATCHED_MOST; n++) expect((await c.ask('resources/subscribe', { uri: actionsUri(`p${n}`) })).result).toEqual({})
    expect((await c.ask('resources/subscribe', { uri: actionsUri('one-more') })).error.code).toBe(-32000)
    for (let n = 2; n < WATCHED_MOST; n++) await c.ask('resources/unsubscribe', { uri: actionsUri(`p${n}`) })
    following.splice(2)
    await c.ask('resources/unsubscribe', { uri })
    expect(following.map((f) => f.stopped)).toEqual([true, false])
    c.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(following.map((f) => f.stopped)).toEqual([true, true])
    expect(c.ended()).toBe(true)
  })

  it('answers a line that is no message, and a method it does not have, as the protocol says', async () => {
    const c = client(commands().run)
    c.raw('not json')
    expect((await c.until((m) => m.error?.code === -32700)).id).toBeNull()
    expect((await c.ask('sampling/createMessage')).error.code).toBe(-32601)
    // A notification is never answered
    c.notify('notifications/initialized')
    expect((await c.ask('ping')).result).toEqual({})
    expect(c.heard.filter((m) => m.id === undefined && !m.method)).toEqual([])
  })

  it('reads what a command printed as JSON where it is JSON, a list among it, and as text where it is not', () => {
    expect(result({ code: 0, stdout: '[1,2]\n', stderr: '' }).structuredContent).toEqual({ items: [1, 2] })
    expect(result({ code: 0, stdout: '# It\n', stderr: '' })).toEqual({ content: [{ type: 'text', text: '# It' }] })
    expect(result({ code: 0, stdout: '', stderr: '' })).toEqual({ content: [{ type: 'text', text: 'Done.' }] })
    expect(result({ code: 3, stdout: '', stderr: '' })).toEqual({ content: [{ type: 'text', text: 'The command failed with code 3.' }], isError: true })
  })

  it("marks its commands as its own conversation's and takes off every other app's mark", () => {
    const env = conversationEnv('desk', {
      PATH: '/bin',
      CODEX_THREAD_ID: 'c',
      CLAUDE_CODE_SESSION_ID: 's',
      IT_HARNESS: 'claude-code',
      IT_SESSION: 's',
      IT_HOME: '/h',
    })
    expect(env).toEqual({ PATH: '/bin', IT_HOME: '/h', IT_HARNESS: 'mcp', IT_SESSION: 'desk' })
    expect(['desk', 'dot.work-1', 'a_b'].map(sessionNamed)).toEqual([true, true, true])
    expect(['', '-x', 'a b', 'a/b', 'x'.repeat(101)].map(sessionNamed)).toEqual([false, false, false, false, false])
    expect(pageOf(actionsUri('my page'))).toBe('my page')
    expect(TOOLS.filter((t) => !t.reads).map((t) => t.name)).toEqual(['it_create', 'it_update', 'it_patch', 'it_say', 'it_open', 'it_wait', 'it_ack'])
  })
})

describe('the built program as an MCP server', () => {
  const cli = path.resolve('packages/cli/dist/it.mjs')
  let child: ChildProcess | undefined
  let folder: string | undefined
  afterEach(() => {
    child?.kill()
    if (folder) rmSync(folder, { recursive: true, force: true })
  })

  it('speaks the protocol on its standard output and nothing else, and ends when its input does', async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-mcp-'))
    // A folder of its own with no It in it: every tool that asks It anything is refused by the command itself
    child = spawn(process.execPath, [cli, 'mcp', '--session', 'test'], {
      env: { ...process.env, IT_HOME: folder, IT_TELEMETRY_ENABLED: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const heard: Json[] = []
    const lines: string[] = []
    const waiting: (() => void)[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => {
      lines.push(line)
      heard.push(JSON.parse(line))
      for (const each of waiting.splice(0)) each()
    })
    const ask = (id: number, method: string, params: Json = {}) => {
      child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise<Json>((resolve) => {
        const look = () => {
          const one = heard.find((m) => m.id === id)
          if (one) return resolve(one)
          waiting.push(look)
        }
        look()
      })
    }
    const begun = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(begun.result.protocolVersion).toBe('2025-06-18')
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    expect((await ask(2, 'tools/list')).result.tools).toHaveLength(TOOLS.length)
    // The guide is the skill the program carries, printed by the command the tool runs
    const guide = await ask(3, 'tools/call', { name: 'it_guide', arguments: {} })
    expect(guide.result.isError).toBeUndefined()
    expect(guide.result.content[0].text).toContain('It.action')
    // Where there is no It to ask, the command says so and the tool hands that back
    const state = await ask(4, 'tools/call', { name: 'it_state', arguments: { id: 'plan' } })
    expect(state.result.isError).toBe(true)
    expect(state.result.content[0].text).toContain('"error"')
    const ended = new Promise<number | null>((resolve) => child!.on('close', resolve))
    child.stdin!.end()
    expect(await ended).toBe(0)
    expect(lines).toHaveLength(4)
  }, 60_000)
})
