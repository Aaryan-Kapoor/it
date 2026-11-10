// The add-on as a real Claude Code loads it. Claude Code reads a mod's code before it runs it,
// and refuses the whole module for any use of `$` but `$.noun.event(...)` at a call site: a
// stand-in for its interface cannot tell, so two things are held here. The add-on's code is
// read for anything Claude Code refuses, always. And where IT_CLAUDE_BINS names Claude Code
// programs, separated as a PATH is, each of them is given a config folder of its own, the
// add-on is installed into it from this checkout with Claude Code's own `claude plugin`
// commands, and a headless conversation is started beside a stand-in connector: the add-on is
// to load, and to ask the connector for that conversation's clicks. No message is sent, so no
// account is asked for. CI has no Claude Code, and runs only the reading.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const here = path.dirname(new URL(import.meta.url).pathname)
const source = readFileSync(path.join(here, 'it-bridge/hooks/register.js'), 'utf8')

/** The code, without its comments, which Claude Code does not read for this either. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/**
 * Every use of `$` in the code that Claude Code refuses a module for: `$?.`, `$[`, and a noun of
 * `$` read as anything but a call, as `typeof $.clock.every` reads it. `$` passed on whole, to a
 * function of the add-on's own, or named as a hook's own, is how the add-on's hooks hand it to
 * what they call, and Claude Code takes that.
 */
function refused(text: string): string[] {
  const found: string[] = []
  for (const [n, line] of text.split('\n').entries())
    for (const m of line.matchAll(/(?<![\w$])\$(?![\w${])/g)) {
      const after = line.slice(m.index! + 1)
      if (/^\s*(\?\.|\[)/.test(after) || (/^\s*\./.test(after) && !/^\.[A-Za-z_]\w*\.[A-Za-z_]\w*\(/.test(after))) found.push(`${n + 1}: ${line.trim()}`)
    }
  return found
}

describe('the Claude Code add-on, read as Claude Code reads it', () => {
  test('uses `$` only as `$.noun.event(...)` at a call site, or passed on whole', () => {
    expect(refused(code)).toEqual([])
  })

  test('the reading finds each use that Claude Code refused', () => {
    // The capability check that kept the add-on from loading in It 0.1.36, and the ways like it
    expect(refused("const ok = typeof $?.session?.id === 'function'")).toHaveLength(1)
    expect(refused("if (typeof $.clock?.every === 'function') {}")).toHaveLength(1)
    expect(refused('const submit = $.prompt.submit')).toHaveLength(1)
    expect(refused("const id = $['session'].id()")).toHaveLength(1)
    expect(refused('const s = $.session')).toHaveLength(1)
    // And none of what it is allowed
    expect(refused('const id = await $.session.id()')).toEqual([])
    expect(refused('$.clock.every(1000, () => check($).catch(() => {}))')).toEqual([])
    expect(refused("on('turn.start', async ($, e, next) => next(e))")).toEqual([])
    // A template's own `${…}`, written here with its dollar escaped, is no use of `$`
    expect(refused('const text = `\u0024{a}\u0024{b}`')).toEqual([])
  })
})

const programs = (process.env.IT_CLAUDE_BINS ?? '').split(path.delimiter).filter(Boolean)

describe.skipIf(!programs.length)('the Claude Code add-on, loaded by a real Claude Code', () => {
  test.each(programs)(
    '%s loads it, and it asks the connector for the conversation’s clicks',
    async (program) => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-cc-'))
      const it = path.join(scratch, 'it')
      const config = path.join(scratch, 'claude')
      const market = path.join(scratch, 'market')
      const work = path.join(scratch, 'work')
      for (const folder of [it, config, work, path.join(market, '.claude-plugin')]) mkdirSync(folder, { recursive: true })
      // The add-on as this checkout has it, in a marketplace of its own, as `it setup` makes one
      cpSync(path.join(here, 'it-bridge'), path.join(market, 'it-bridge'), { recursive: true })
      writeFileSync(
        path.join(market, '.claude-plugin/marketplace.json'),
        JSON.stringify({ name: 'it', owner: { name: 'It' }, plugins: [{ name: 'it-bridge', source: './it-bridge', description: 'It' }] }),
      )
      // Nothing of the Claude Code that runs this test, if one does, reaches the one under test
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('IT_')))
      Object.assign(env, { CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', IT_HOME: it })
      const claude = (...args: string[]) => spawnSync(program, args, { env, encoding: 'utf8', timeout: 120_000 })
      // A stand-in connector, answering as the real one does to an add-on that asks for its clicks
      const asked: string[] = []
      const socket = path.join(it, 'connector.sock')
      const token = 'a'.repeat(48)
      const connector = http.createServer((req, res) => {
        req.resume().on('end', () => {
          if (req.headers['x-it-token'] !== token) return void res.writeHead(401).end('{}')
          asked.push(req.url ?? '')
          res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.startsWith('/clicks') ? '{"clicks":[]}' : '{"ok":true}')
        })
      })
      await new Promise<void>((resolve) => connector.listen(socket, resolve))
      writeFileSync(path.join(it, 'connector.json'), JSON.stringify({ socket, token }))
      const debug = path.join(scratch, 'debug.txt')
      let child: ReturnType<typeof spawn> | undefined
      try {
        for (const args of [
          ['plugin', 'marketplace', 'add', market],
          ['plugin', 'install', 'it-bridge@it', '--scope', 'user'],
        ]) {
          const ran = claude(...args)
          expect(ran.status, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`).toBe(0)
        }
        // A headless conversation, given no message: it starts, and its mods with it
        child = spawn(program, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--debug-file', debug], {
          cwd: work,
          env,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        const until = Date.now() + 60_000
        while (!asked.some((a) => a.startsWith('/clicks?harness=claude-code&session=')) && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
        const said = existsSync(debug)
          ? readFileSync(debug, 'utf8')
              .split('\n')
              .filter((line) => line.includes('it-bridge'))
              .join('\n')
          : ''
        expect(said, 'what Claude Code said of the add-on').not.toMatch(/failed to load|did not load/)
        expect(said).toMatch(/hooks module it-bridge@it loaded/)
        expect(
          asked.some((a) => a.startsWith('/clicks?harness=claude-code&session=')),
          `the connector was asked: ${asked.join(', ') || 'nothing'}`,
        ).toBe(true)
      } finally {
        child?.kill('SIGTERM')
        if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r))
        await new Promise((r) => connector.close(r))
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    240_000,
  )
})
