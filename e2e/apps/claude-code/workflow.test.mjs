// The workflow that runs the real Claude Code (.github/workflows/app-claude-code.yml), read as
// text: what it is trusted with, when it runs, and that the oldest Claude Code it installs is
// the oldest that `it setup` accepts, as the step that finds it reads that from the source.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { KNOWN } from '../../../packages/cli/src/setup.ts'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'app-claude-code.yml'), 'utf8')
const lines = workflow.split('\n')

describe('the workflow that runs the real Claude Code', () => {
  test('pins every action to a commit, keeps no checkout credentials, can only read, and is given no secret', () => {
    const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) expect(line, line.trim()).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/)
    const checkouts = lines.flatMap((line, i) => (/uses: actions\/checkout@/.test(line) ? [lines.slice(i, i + 3).join('\n')] : []))
    expect(checkouts).toHaveLength(1)
    for (const checkout of checkouts) expect(checkout).toMatch(/persist-credentials: false/)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m)
    expect(workflow.match(/^\s*permissions:/gm)).toHaveLength(1)
    expect(workflow).not.toMatch(/\$\{\{[^}]*\bsecrets\b/)
    expect(workflow).not.toMatch(/\bsecrets\s*:/)
  })

  test('runs on pull requests, on pushes to master, every night and by hand, and blocks nothing by its own leave', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[master\]\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:\n/m)
    expect(workflow).not.toMatch(/continue-on-error/)
    expect(workflow).toMatch(/which: \[oldest, newest\]/)
  })

  // The line is run by the shell a runner runs it with, against the source as it is
  test.skipIf(process.platform === 'win32')('installs, as the oldest, the oldest Claude Code that `it setup` accepts', () => {
    const line = lines.find((l) => l.includes('version="$(sed -n'))
    expect(line).toBeDefined()
    const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${line.trim()}\necho "$version"`], { cwd: root, encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout.trim()).toBe(KNOWN['claude-code'].min)
  })
})
