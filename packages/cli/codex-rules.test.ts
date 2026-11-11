// The rules `it setup` writes into Codex's rules folder, so that `it` reaches It from inside
// Codex's sandbox: what they say, and what Codex itself makes of them where a `codex` command is
// on this machine. Codex is asked in a folder of its own, so no settings of a person's are read.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { CODEX_ASKED, CODEX_RULE, CODEX_RULES, CODEX_SAVE_RULE } from './src/codex-settings'

const rules = () => CODEX_RULES.split('\n').filter((line) => line && !line.startsWith('#'))

test('the file holds the one rule that lets `it` out, and one that asks first of every command that can change It itself', () => {
  expect(rules()).toEqual([
    'prefix_rule(pattern=["it"], decision="allow")',
    'prefix_rule(pattern=["it", ["setup", "uninstall", "upgrade", "login", "logout", "serve", "service", "network", "runs", "telemetry", "updates", "shell-profile", "https"]], decision="prompt", justification="This command can change It on this machine rather than use it.")',
    CODEX_SAVE_RULE,
  ])
  expect(rules()[0]).toBe(CODEX_RULE)
  expect([...CODEX_ASKED]).toEqual([
    'setup',
    'uninstall',
    'upgrade',
    'login',
    'logout',
    'serve',
    'service',
    'network',
    'runs',
    'telemetry',
    'updates',
    'shell-profile',
    'https',
  ])
  expect(CODEX_ASKED).not.toContain('action')
  expect(CODEX_RULES).toContain(CODEX_SAVE_RULE)
  expect(CODEX_RULES.endsWith('\n')).toBe(true)
})

// Each command as an agent might give it, and what Codex is to decide of it. An option or `--`
// before the word that says what to do is taken by `it`, so the commands that change It are
// asked about with whatever follows them.
const DECIDED: [string, 'allow' | 'prompt' | undefined][] = [
  ['it create board --file board.html', 'allow'],
  ['it update board --file board.html --open', 'allow'],
  ['it wait --timeout 30', 'allow'],
  ['it action a1', 'allow'],
  ['it save a1 photo.jpg', 'prompt'],
  ['it save a1 photo.jpg --number 2', 'prompt'],
  ['it save a1 photo.jpg --number=2', 'prompt'],
  ['it save --number=2 a1 photo.jpg', 'prompt'],
  ['it save a1 ~/.codex/rules/extra.rules', 'prompt'],
  ['it status', 'allow'],
  ['it displays', 'allow'],
  ['it delete board', 'allow'],
  ['it tour clear', 'allow'],
  ['it site --no-open', 'allow'],
  ['it setup', 'prompt'],
  ['it setup --yes', 'prompt'],
  ['it uninstall --yes', 'prompt'],
  ['it upgrade', 'prompt'],
  ['it upgrade --check', 'prompt'],
  ['it login --url http://x --code y', 'prompt'],
  ['it logout --force', 'prompt'],
  ['it serve', 'prompt'],
  ['it service install', 'prompt'],
  ['it service uninstall', 'prompt'],
  ['it service --json uninstall', 'prompt'],
  ['it service status', 'prompt'],
  ['it network on', 'prompt'],
  ['it network --json on', 'prompt'],
  ['it network', 'prompt'],
  ['it runs clear', 'prompt'],
  ['it runs --yes clear', 'prompt'],
  ['it runs', 'prompt'],
  ['it telemetry -- off', 'prompt'],
  ['it telemetry off', 'prompt'],
  ['it updates -- on', 'prompt'],
  ['git status', undefined],
  ['itx status', undefined],
]

const found = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
const codex = found.status === 0 && /codex/i.test(found.stdout)

describe.skipIf(!codex)('what Codex makes of the file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-codex-rules-'))
  const file = path.join(dir, 'it.rules')
  writeFileSync(file, CODEX_RULES)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const decide = (command: string) => {
    const r = spawnSync('codex', ['execpolicy', 'check', '--rules', file, ...command.split(' ')], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: dir },
    })
    expect(r.status, r.stderr).toBe(0)
    return (JSON.parse(r.stdout) as { decision?: string }).decision
  }
  test.each(DECIDED)('%s', (command, decision) => {
    expect(decide(command)).toBe(decision)
  })
})

test('help, delivery instructions and docs use the separate save command', () => {
  for (const relative of [
    'src/main.ts',
    'src/wait.ts',
    'tour/TOUR.md',
    '../protocol/src/index.ts',
    '../../addons/skill/SKILL.md',
    '../../addons/skill/more/actions.md',
    '../../docs/add-ons.md',
    '../../docs/what-it-protects.md',
  ]) {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    expect(text, relative).not.toMatch(/it action [^\n]*--save/)
  }
})
