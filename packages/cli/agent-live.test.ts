// A project agent's program as the real Claude Code and the real Codex run it, started and then
// resumed, against a stand-in for their model services on this machine. Each app is given
// folders of its own for its settings, and a home folder of its own, so nothing of the person's
// is read or changed, and no account is used. It runs only where it is asked for, with
// IT_LIVE_AGENTS=1, and where the app is installed: it starts the person's own copy of the app.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type AgentSession, ClaudeSession, CodexSession, type Launch, type SessionEvents } from './src/agent-session'
import { answerTo, standInModel } from './stand-in-model'

const asked = process.env.IT_LIVE_AGENTS === '1' && process.platform !== 'win32'
/** Whether an app is on the PATH, found without running it. */
const has = (app: string) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && existsSync(path.join(d, app)))

let dir: string
let folder: string
let model: Awaited<ReturnType<typeof standInModel>>
beforeAll(async () => {
  if (!asked) return
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-live-agents-')))
  folder = path.join(dir, 'garden')
  mkdirSync(folder)
  model = await standInModel()
})
afterAll(async () => {
  if (!asked) return
  await model.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A turn's end, as the session says it. */
function turns() {
  const ended: [string | null, string | null][] = []
  const exited: string[] = []
  let wake = () => {}
  const on: SessionEvents = {
    session: () => {},
    idle: (said, failed) => {
      ended.push([said, failed])
      wake()
    },
    exited: (why, words) => {
      exited.push(`${why}: ${words}`)
      wake()
    },
  }
  return { ended, exited, on, next: () => new Promise<void>((resolve) => (wake = resolve)) }
}
async function turn(s: AgentSession, t: ReturnType<typeof turns>, text: string): Promise<string | null> {
  const done = t.next()
  await s.send(text)
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer: ${t.exited.join('; ')}`)), 90_000))])
  if (t.exited.length) throw new Error(t.exited.join('; '))
  const [said, failed] = t.ended.at(-1)!
  if (failed) throw new Error(failed)
  return said
}

/** An environment that holds nothing of the person's: a home of its own, the app's settings in it, and the stand-in for its model. */
function envFor(app: 'claude-code' | 'codex'): NodeJS.ProcessEnv {
  const home = path.join(dir, `${app}-home`)
  mkdirSync(home, { recursive: true })
  const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|ANTHROPIC|OPENAI|IT_SESSION$|IT_HARNESS$)/.test(k)))
  if (app === 'claude-code') {
    const config = path.join(home, '.claude')
    mkdirSync(config, { recursive: true })
    return {
      ...keep,
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: 'not-a-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    }
  }
  const codexHome = path.join(home, '.codex')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model = "stand-in"',
      'model_provider = "standin"',
      '[model_providers.standin]',
      'name = "Stand-in"',
      `base_url = "${model.url}/v1"`,
      'wire_api = "responses"',
      'env_key = "STAND_IN_KEY"',
      '',
    ].join('\n'),
  )
  return { ...keep, HOME: home, CODEX_HOME: codexHome, STAND_IN_KEY: 'not-a-key' }
}

const launch = (app: 'claude-code' | 'codex', session: string | null, resume: boolean): Launch => ({
  app,
  folder,
  session,
  resume,
  env: envFor(app),
  itHome: path.join(dir, 'it-home'),
  itAt: [],
  run: `agent-${randomUUID()}`,
})

describe.skipIf(!asked)('project agents with the real apps, against a stand-in for their models', () => {
  test.skipIf(!asked || !has('claude'))(
    'Claude Code starts a conversation in its folder, and resumes it with what came before',
    async () => {
      const id = randomUUID()
      const first = turns()
      const one = new ClaudeSession(launch('claude-code', id, false), first.on)
      await one.start()
      expect(await turn(one, first, 'Plan the beds')).toBe(answerTo('Plan the beds', 0))
      expect(await turn(one, first, 'Add beans')).toBe(answerTo('Add beans', 1))
      expect(['ended', 'gone', 'unknown']).toContain(await one.end())
      // The note It gives it was part of what it sent its model
      expect(
        model.asked.some((a) => a.path === '/v1/messages' && JSON.stringify(a.body?.system ?? '').includes('It started this conversation for the person')),
      ).toBe(true)
      // A new program, resumed in the same conversation, carries what came before
      const again = turns()
      const two = new ClaudeSession(launch('claude-code', id, true), again.on)
      await two.start()
      expect(await turn(two, again, 'And water them')).toBe(answerTo('And water them', 2))
      expect(two.session).toBe(id)
      expect(['ended', 'gone', 'unknown']).toContain(await two.end())
    },
    240_000,
  )

  test.skipIf(!asked || !has('codex'))(
    'Codex’s app server opens a thread in its folder, and resumes it with what came before',
    async () => {
      const first = turns()
      const one = new CodexSession(launch('codex', null, false), first.on)
      await one.start()
      const thread = one.session!
      expect(thread).toMatch(/^[0-9a-f-]{36}$/)
      expect(await turn(one, first, 'Plan the beds')).toBe(answerTo('Plan the beds', 0))
      expect(['ended', 'gone', 'unknown']).toContain(await one.end())
      // The note It gives it was part of what it sent its model
      expect(model.asked.some((a) => a.path === '/v1/responses' && JSON.stringify(a.body).includes('It started this conversation for the person'))).toBe(true)
      const again = turns()
      const two = new CodexSession(launch('codex', thread, true), again.on)
      await two.start()
      expect(two.session).toBe(thread)
      expect(await turn(two, again, 'And water them')).toBe(answerTo('And water them', 1))
      expect(['ended', 'gone', 'unknown']).toContain(await two.end())
    },
    240_000,
  )
})
