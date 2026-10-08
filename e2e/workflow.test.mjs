// The workflow CI runs (.github/workflows/it.yml), read as text: which jobs the one required
// check waits for, what that check makes of their results, what the workflow is trusted with,
// and what its jobs are held to running. Two of its steps are also run as they are written,
// by the shell a runner gives them: the one that decides whether a change may be merged, and
// the one that stops It at the end of an end-to-end run.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'it.yml'), 'utf8')
const lines = workflow.split('\n')
const jobsAt = lines.indexOf('jobs:')
/** Each job by its id, with the lines that are its own. */
const jobs = {}
let current
for (const line of lines.slice(jobsAt + 1)) {
  const id = /^ {2}([a-z][a-z0-9-]*):$/.exec(line)?.[1]
  if (id) current = jobs[id] = []
  else if (current) current.push(line)
}
/** The steps of a job, each as its own lines joined, in the order they run. Comments are no part of a step. */
const steps = (id) => {
  const own = jobs[id].filter((line) => !/^\s*#/.test(line))
  const starts = own.flatMap((line, i) => (/^ {6}- /.test(line) ? [i] : []))
  return starts.map((at, n) => own.slice(at, starts[n + 1]).join('\n'))
}
/** Which of a job's steps is the first to hold a piece of text, or -1. */
const stepWith = (id, text) => steps(id).findIndex((step) => step.includes(text))
const GATE = 'ok'
const waitsFor = /^ {4}needs: \[(.*)\]$/m
  .exec(jobs[GATE].join('\n'))[1]
  .split(',')
  .map((id) => id.trim())
/** What a step runs, as the shell is given it: the lines under its `run: |`. */
const scriptOf = (step) => {
  const own = step.split('\n')
  const at = own.findIndex((line) => /^ {8}run: \|$/.test(line))
  const body = []
  for (const line of own.slice(at + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(10))) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}
/** The shell a runner runs a step with, where this machine has it. A test that runs a step as it is written needs it. */
const shell = (() => {
  try {
    return execFileSync('bash', ['-c', 'echo runs'], { stdio: 'pipe' }).toString().trim() === 'runs'
  } catch {
    return false
  }
})()
/** Runs a step's script as a runner does: with `bash --noprofile --norc -eo pipefail`. */
const asRunner = (script, options) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', ...options })
/** What the gate's step runs. */
const script = scriptOf(jobs[GATE].join('\n'))
/** How many jobs the gate says it waits for, which is what it counts the results against. */
const counted = Number(/^ {10}WAITED_FOR: (\d+)$/m.exec(jobs[GATE].join('\n'))?.[1])
const gate = (results) => (asRunner(script, { env: { ...process.env, RESULTS: results, WAITED_FOR: String(counted) } }).status === 0 ? 'passes' : 'fails')
const passed = (n) => Array.from({ length: n }, () => 'success')

describe('the check that says a change is ready to merge', () => {
  test('waits for every other job, the one that starts the programs on macOS and Windows included', () => {
    const others = Object.keys(jobs).filter((id) => id !== GATE)
    expect(others).toContain('programs-smoke')
    expect([...waitsFor].sort()).toEqual([...others].sort())
    expect(counted).toBe(waitsFor.length)
  })

  test('no job is allowed to fail without failing it, except the unit tests on Windows', () => {
    const allowed = Object.entries(jobs).flatMap(([id, own]) =>
      own.filter((line) => /^ {4}continue-on-error:/.test(line)).map((line) => `${id}: ${line.trim()}`),
    )
    expect(allowed).toHaveLength(1)
    expect(allowed[0]).toMatch(/^test: continue-on-error: \$\{\{ matrix\.experimental \}\}$/)
    const legs = [...jobs.test.join('\n').matchAll(/- os: (\S+)\n\s+experimental: (true|false)/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(legs).toEqual(['ubuntu-latest false', 'macos-latest false', 'windows-latest true'])
  })

  test('runs whatever became of the jobs it waits for, so that it is never skipped itself', () => {
    expect(jobs[GATE]).toContain('    if: always()')
    expect(jobs[GATE].join('\n')).toMatch(/RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}/)
  })

  // The script is the runner's own, run by its own shell: where there is none of that kind, there is nothing to run it with
  test.skipIf(!shell)('passes only when every one of them passed: not when one failed, was cancelled or was skipped, nor when a result is missing', () => {
    expect(gate(passed(counted).join(' '))).toBe('passes')
    for (const one of ['failure', 'cancelled', 'skipped', 'neutral'])
      for (let at = 0; at < counted; at++) expect(gate(passed(counted).with(at, one).join(' ')), `${one} at ${at}`).toBe('fails')
    expect(gate(passed(counted - 1).join(' '))).toBe('fails')
    expect(gate(passed(counted + 1).join(' '))).toBe('fails')
    expect(gate('')).toBe('fails')
    expect(gate(' ')).toBe('fails')
  })
})

describe('what the workflow is trusted with', () => {
  test('every action is pinned to a commit, no checkout keeps its credentials, and the token can only read', () => {
    const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) expect(line, line.trim()).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/)
    const checkouts = lines.flatMap((line, i) => (/uses: actions\/checkout@/.test(line) ? [lines.slice(i, i + 4).join('\n')] : []))
    for (const checkout of checkouts) expect(checkout).toMatch(/persist-credentials: false/)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m)
    expect(workflow.match(/^\s*permissions:/gm)).toHaveLength(1)
  })

  test('no job is given a secret, and no step asks for one', () => {
    expect(workflow).not.toMatch(/\$\{\{[^}]*\bsecrets\b/)
    expect(workflow).not.toMatch(/\bsecrets\s*:/)
  })

  test('one version of Node and one of Bun are each said once, and used wherever one is set up', () => {
    expect(workflow.match(/^ {2}NODE_VERSION: \d+$/gm)).toHaveLength(1)
    const bun = workflow.match(/^ {2}BUN_VERSION: (\d+\.\d+\.\d+)$/m)?.[1]
    expect(bun).toBeDefined()
    expect(workflow.match(/BUN_VERSION:/g)).toHaveLength(1)
    // The Bun inside the standalone programs is the one whose own notice is kept for the third-party notices
    expect(existsSync(path.join(root, 'scripts', 'notices', `bun-${bun}.md`))).toBe(true)
    const versions = lines.filter((line) => /^\s*(node|bun)-version:/.test(line)).map((line) => line.trim())
    expect(versions.length).toBeGreaterThan(0)
    for (const line of versions) expect(line).toMatch(/^(node-version: \$\{\{ env\.NODE_VERSION \}\}|bun-version: \$\{\{ env\.BUN_VERSION \}\})$/)
    expect(lines.filter((line) => /uses: actions\/setup-node@/.test(line))).toHaveLength(versions.filter((line) => line.startsWith('node')).length)
    expect(lines.filter((line) => /uses: oven-sh\/setup-bun@/.test(line))).toHaveLength(versions.filter((line) => line.startsWith('bun')).length)
  })
})

/** What the first job checks once everything is built, each as the step that runs it says it. */
const CHECKS = ['npm run check:ci', 'npm run check:history', 'npm run check:notices', 'npm run check:version', 'npm run typecheck', 'git diff --exit-code -- .']

describe('what the jobs are held to running', () => {
  test('the unit tests come by the backend program before they run, on every system, so that the tests that start it are not skipped', () => {
    const first = stepWith('test', 'packages/cli/dist/it.mjs setup')
    const built = stepWith('test', 'npm run generate')
    const tests = stepWith('test', 'run: npm test')
    expect(built).toBeGreaterThan(-1)
    expect(first).toBeGreaterThan(built)
    expect(tests).toBeGreaterThan(first)
    const step = steps('test')[first]
    // A first run in a folder of its own, with no background service, that connects no agent app
    expect(step).toMatch(/IT_HOME: \$\{\{ runner\.temp \}\}\//)
    expect(step).toMatch(/setup --none --no-service$/m)
    // It fails where no program was left, and names the program for the steps after it
    expect(step).toMatch(/\[ -f "\$program" \] \|\| \{[^}]*exit 1; \}/)
    expect(step).toMatch(/echo "IT_BACKEND_BIN=\$program" >> "\$GITHUB_ENV"/)
    // On every system: the step is not left out on any
    expect(step).not.toMatch(/^ {6}(?:- | {2})if:/m)
    expect(step).not.toMatch(/continue-on-error/)
    // Where it failed and named no program, that is said before the tests are run, since the ones that start the program then skip themselves
    const said = stepWith('test', "env.IT_BACKEND_BIN == ''")
    expect(said).toBeGreaterThan(first)
    expect(tests).toBeGreaterThan(said)
    expect(steps('test')[said]).toMatch(/if: \$\{\{ !cancelled\(\) && env\.IT_BACKEND_BIN == '' \}\}\n\s+run: echo "::warning::/)
  })

  test('both browsers that pages are run in are installed before the unit tests, on every system, so that those tests are not skipped', () => {
    const install = stepWith('test', 'npx playwright install')
    expect(install).toBeGreaterThan(-1)
    expect(stepWith('test', 'run: npm test')).toBeGreaterThan(install)
    const step = steps('test')[install]
    expect(step).toMatch(/run: npx playwright install --with-deps chromium firefox$/m)
    // On every system, and never passed over when it fails
    expect(step).not.toMatch(/runner\.os|matrix\.os/)
    expect(step).not.toMatch(/continue-on-error/)
    // The tests themselves say which browsers they are: the two that are installed
    const pages = readFileSync(path.join(root, 'packages', 'content', 'page.test.ts'), 'utf8')
    expect(pages).toMatch(/import \{[^}]*\bchromium\b[^}]*\bfirefox\b[^}]*\} from 'playwright'/)
    expect(pages).not.toMatch(/\bwebkit\b/)
  })

  test('the door’s tests, the service’s, the content service’s, and the test that It asks its own backend and door directly are run under Bun as well as under Node', () => {
    const door = steps('test').find((step) => step.includes('bun test ./packages/cli/door.test.ts'))
    const service = steps('test').find((step) => step.includes('bun test ./packages/cli/serve.test.ts'))
    const content = steps('test').find((step) => step.includes('test:bun'))
    expect(door).toBeDefined()
    expect(door).toMatch(/run: bun test \.\/packages\/cli\/door\.test\.ts \.\/packages\/cli\/push\.test\.ts \.\/packages\/cli\/direct\.test\.ts$/m)
    // The service's are a step of their own, run on Linux, and not allowed to fail either
    expect(service).toMatch(/if: \$\{\{ !cancelled\(\) && runner\.os == 'Linux' \}\}/)
    expect(service).not.toMatch(/continue-on-error/)
    expect(content).toMatch(/run: npm run test:bun -w @it\/content$/m)
    // Each is a step of its own, run whatever became of the one before it, and neither is allowed to fail
    expect(content).not.toBe(door)
    for (const step of [door, content]) {
      expect(step).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/)
      expect(step).not.toMatch(/continue-on-error/)
    }
    expect(stepWith('test', 'uses: oven-sh/setup-bun@')).toBeGreaterThan(-1)
  })

  test('no step is allowed to fail without failing its job, except the audit of what only the build and the tests use', () => {
    // A step may run whatever became of the one before it. That is not the same: its own failure still fails the job.
    const allowed = Object.keys(jobs).flatMap((id) =>
      steps(id)
        .filter((step) => /continue-on-error/.test(step))
        .map((step) => `${id}: ${step.trim().split('\n')[0]}`),
    )
    expect(allowed).toEqual(["audit: - name: Everything, the build's and the tests' tools included"])
  })

  test('the end-to-end suite runs in full with the Node bundle and in its quick form with the standalone program', () => {
    const legs = [...jobs.e2e.join('\n').matchAll(/- cli: (.+)\n\s+suite: (.+)/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(legs).toEqual(['node bundle ""', 'standalone program --quick'])
    const order = [
      'node e2e/stack.mjs',
      'node e2e/ready.mjs',
      'node e2e/run.mjs $SUITE',
      'node e2e/push.mjs',
      'kill "$(cat it-stack.pid)"',
      'node e2e/logs.mjs',
      'actions/upload-artifact@',
    ].map((text) => stepWith('e2e', text))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // Each leg names the command the suite runs, so that the stack builds none of its own: a bundle built here, or the program built once for every job
    const bundle = steps('e2e')[stepWith('e2e', 'IT_CLI=')]
    expect(bundle).toMatch(/if: matrix\.cli == 'node bundle'/)
    expect(bundle).toMatch(/npm run generate\n\s+echo "IT_CLI=\$GITHUB_WORKSPACE\/packages\/cli\/dist\/it\.mjs" >> "\$GITHUB_ENV"/)
    expect(steps('e2e')[stepWith('e2e', 'IT_BIN=')]).toMatch(/if: matrix\.cli == 'standalone program'/)
    expect(stepWith('e2e', 'node e2e/stack.mjs')).toBeGreaterThan(Math.max(stepWith('e2e', 'IT_CLI='), stepWith('e2e', 'IT_BIN=')))
  })

  test('It is asked to stop and waited for, and no step of the workflow ends a program by force or looks for one by name', () => {
    expect(workflow).not.toMatch(/kill -9|kill -KILL|kill -s KILL|pkill|killall/)
    const start = steps('e2e')[stepWith('e2e', 'node e2e/stack.mjs')]
    // What the stack ends with is written down, so that a later step can learn of it
    expect(start).toMatch(/id: stack/)
    expect(start).toContain(`node e2e/stack.mjs & echo $! > "$RUNNER_TEMP/it-stack.pid"; wait $!; echo $? > "$RUNNER_TEMP/it-stack.ended"`)
    const stop = steps('e2e')[stepWith('e2e', 'kill "$(cat it-stack.pid)"')]
    expect(stop).toMatch(/id: stop/)
    expect(stop).toMatch(/if: always\(\) && steps\.stack\.outcome != 'skipped'/)
    expect(stop).toMatch(/working-directory: \$\{\{ runner\.temp \}\}/)
    // The step waits longer than the stack gives everything it stops: setup that is under way two minutes, the service one, and a backend program left behind one more
    const waits = Number(/^ {10}WAITS: (\d+)$/m.exec(stop)?.[1])
    expect(waits).toBeGreaterThan(120 + 60 + 60)
    expect(stop).toMatch(/for _ in \$\(seq 1 "\$WAITS"\); do \[ -s it-stack\.ended \] && break; sleep 1; done/)
    // Nothing is copied before the stack is seen to have ended, and a stack that ended badly fails the step once the copy is made
    const order = [
      'kill "$(cat it-stack.pid)"',
      '[ -s it-stack.ended ] || {',
      'cp -R it-logs/. it-kept/',
      'echo "set-aside=yes" >> "$GITHUB_OUTPUT"',
      '[ "$ended" = 0 ] || {',
    ].map((text) => stop.indexOf(text))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('what a run wrote down is read only once the stack has ended, before any of it is kept, and kept only if nothing was found', () => {
    const scan = steps('e2e')[stepWith('e2e', 'node e2e/logs.mjs')]
    expect(scan).toMatch(/id: scan/)
    expect(scan).toMatch(/if: always\(\) && steps\.stop\.outputs\.set-aside == 'yes'/)
    expect(scan).toMatch(/run: node e2e\/logs\.mjs "\$RUNNER_TEMP\/it-kept"/)
    const kept = steps('e2e')[stepWith('e2e', 'actions/upload-artifact@')]
    expect(kept).toMatch(/if: always\(\) && steps\.scan\.outcome == 'success'/)
    expect(kept).toMatch(/path: \$\{\{ runner\.temp \}\}\/it-kept\//)
    // The folder It lives in holds its keys, and is not under what is kept
    const places = steps('e2e')[0]
    expect(places).toMatch(/echo "IT_HOME=\$RUNNER_TEMP\/it-home" >> "\$GITHUB_ENV"/)
    expect(places).toMatch(/echo "IT_STACK_LOGS=\$RUNNER_TEMP\/it-logs" >> "\$GITHUB_ENV"/)
    expect(places).toMatch(/echo "IT_E2E_INVENTORY=\$RUNNER_TEMP\/it-run-holds\.jsonl" >> "\$GITHUB_ENV"/)
  })

  test('the standalone programs are checked against their checksums and against the notices, and the two other systems start theirs', () => {
    for (const text of [
      'node packages/cli/release.mjs',
      'sha256sum -c SHA256SUMS',
      'node e2e/install.mjs',
      'node scripts/notices.mjs --check --bun',
      'actions/upload-artifact@',
    ])
      expect(stepWith('programs', text), text).toBeGreaterThan(-1)
    const started = [...jobs['programs-smoke'].join('\n').matchAll(/- os: (\S+)\n\s+program: (\S+)/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(started).toEqual(['macos-latest it-darwin-arm64', 'windows-latest it-windows-x64.exe'])
    expect(stepWith('programs-smoke', 'node e2e/install.mjs "$RUNNER_TEMP/it-programs"')).toBeGreaterThan(-1)
  })

  test('the first job reads every earlier commit for credentials and holds the notices to the bundles', () => {
    expect(steps('check')[0]).toMatch(/fetch-depth: 0/)
    for (const text of CHECKS) expect(stepWith('check', text), text).toBeGreaterThan(-1)
  })

  test('each check of the first job is run whatever became of the ones before it, so that one run says everything that is wrong', () => {
    const built = stepWith('check', 'npm run generate')
    expect(built).toBeGreaterThan(-1)
    for (const text of CHECKS) {
      const at = stepWith('check', text)
      expect(at, text).toBeGreaterThan(built)
      expect(steps('check')[at], text).toMatch(/^ {6}(?:- | {2})if: \$\{\{ !cancelled\(\) \}\}$/m)
    }
    // Nothing comes after the build but the checks, so none is left to be hidden by another
    expect(steps('check').length).toBe(built + 1 + CHECKS.length)
  })

  test('each check of the programs that were built is run whatever became of the others, and the programs are kept only when every one passed', () => {
    const build = steps('programs')[stepWith('programs', 'node packages/cli/release.mjs')]
    expect(build).toMatch(/id: build/)
    expect(build).not.toMatch(/^ {6}(?:- | {2})if:/m)
    // The first of them follows the build, and so is run when the build passed. The two after it say so themselves.
    expect(stepWith('programs', 'sha256sum -c SHA256SUMS')).toBe(stepWith('programs', 'node packages/cli/release.mjs') + 1)
    expect(steps('programs')[stepWith('programs', 'sha256sum -c SHA256SUMS')]).not.toMatch(/^ {6}(?:- | {2})if:/m)
    for (const text of ['node e2e/install.mjs', 'node scripts/notices.mjs --check --bun'])
      expect(steps('programs')[stepWith('programs', text)], text).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}$/m)
    const kept = steps('programs')[stepWith('programs', 'actions/upload-artifact@')]
    expect(kept).not.toMatch(/^ {6}(?:- | {2})if:/m)
    expect(stepWith('programs', 'actions/upload-artifact@')).toBe(steps('programs').length - 1)
  })

  test('the notifications are checked whatever became of the suite before them, where It was started', () => {
    const push = steps('e2e')[stepWith('e2e', 'node e2e/push.mjs')]
    expect(push).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) && matrix\.cli == 'node bundle' && steps\.stack\.outcome == 'success' \}\}$/m)
    expect(push).not.toMatch(/continue-on-error/)
  })

  test('the audit of everything is run whatever the audit of what the product depends on found', () => {
    const product = stepWith('audit', 'npm audit --omit=dev --audit-level=high')
    const everything = stepWith('audit', 'run: npm audit --audit-level=high')
    expect(product).toBeGreaterThan(-1)
    expect(everything).toBeGreaterThan(product)
    expect(steps('audit')[product]).not.toMatch(/continue-on-error/)
    expect(steps('audit')[everything]).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m)
  })
})

// The list of what the unit suite leaves out on Windows is kept beside the code, in a folder
// that is no part of what is committed. Where that folder is on the machine the list is held to
// the test files. Where it is not, as on the workflow's own machines, that is said in a line.
const handbook = path.join(root, 'internal', 'testing.md')
const listed = existsSync(handbook)
if (!listed) console.log('  skip  the check of the list of what is left out on Windows: the list is kept beside the code, and is not on this machine')
describe.skipIf(!listed)('what the list of what is left out on Windows says', () => {
  const testing = listed ? readFileSync(handbook, 'utf8') : ''
  const said = testing.slice(testing.indexOf('**Windows** runs'), testing.indexOf('### What has been seen to run, and what has not'))
  /** Every test file under a folder, by its path from the repository's own. */
  const testsUnder = (folder) =>
    readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
      const at = `${folder}/${entry.name}`
      if (entry.isDirectory()) return ['node_modules', 'dist'].includes(entry.name) ? [] : testsUnder(at)
      return /\.test\.(ts|mjs)$/.test(entry.name) ? [at] : []
    })
  const files = ['packages', 'addons', 'e2e', 'web/src', 'convex'].flatMap(testsUnder)
  /** Whether a test file leaves a test or a group of tests out on Windows, by its own word. */
  const leavesOut = (file) => {
    const text = readFileSync(path.join(root, file), 'utf8')
    const windows = /const windows = process\.platform === 'win32'/.test(text)
    return [...text.matchAll(/\.skipIf\(([^)]*)\)/g)].some(([, when]) => /'win32'/.test(when) || (windows && /\bwindows\b/.test(when)))
  }

  test('names every test file that leaves something out there, and no file that leaves nothing out', () => {
    expect(said.length).toBeGreaterThan(500)
    expect(files.length).toBeGreaterThan(30)
    const leaving = files.filter(leavesOut)
    expect(leaving.length).toBeGreaterThan(8)
    // Each by its path, or by its own name where that is enough to tell it by
    for (const file of leaving)
      expect(said.includes(`\`${file}\``) || (!file.startsWith('e2e/') && said.includes(`\`${path.basename(file)}\``)), file).toBe(true)
    // And the other way: a test file the list names by its own name is one that leaves something out, or one the configuration leaves out whole
    const named = [...said.matchAll(/`((?:[\w.*/-]+\/)?[\w*-]+\.test\.(?:ts|mjs))`/g)].map(([, name]) => name)
    expect(named.length).toBeGreaterThan(8)
    for (const name of new Set(named)) {
      if (name === 'addons/*/addon.test.ts') continue
      const file = files.filter((f) => f === name || path.basename(f) === name)
      expect(file.length, name).toBeGreaterThan(0)
      expect(file.some(leavesOut), name).toBe(true)
    }
  })

  test('says how many groups of the connector’s tests are left out, and that the command’s tests are left out whole', () => {
    const groups = (file) => {
      const text = readFileSync(path.join(root, file), 'utf8')
      return {
        all: text.match(/^describe(?:\.skipIf\([^)]*\))?\(/gm)?.length ?? 0,
        out: text.match(/^describe\.skipIf\(process\.platform === 'win32'[^)]*\)\(/gm)?.length ?? 0,
      }
    }
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
    const connector = groups('packages/cli/connector.test.ts')
    expect(connector.out).toBeGreaterThan(0)
    expect(said).toContain(`- ${words[connector.out - 1]} groups of \`connector.test.ts\``)
    const command = groups('packages/cli/command.test.ts')
    expect(command.all).toBeGreaterThan(0)
    expect(command.out).toBe(command.all)
    expect(said).toContain('- The whole of `packages/cli/command.test.ts`')
  })

  test('names the four add-ons’ tests the configuration leaves out, as the configuration does', () => {
    expect(readFileSync(path.join(root, 'vitest.config.ts'), 'utf8')).toMatch(
      /exclude: windows \? \[\.\.\.configDefaults\.exclude, 'addons\/\*\/addon\.test\.ts'\]/,
    )
    expect(files.filter((file) => /^addons\/[^/]+\/addon\.test\.ts$/.test(file))).toHaveLength(4)
    expect(said).toContain("- The four add-ons' test files, `addons/*/addon.test.ts`")
  })
})

describe('what docs/troubleshooting.md says a service that could not start writes', () => {
  const page = readFileSync(path.join(root, 'docs', 'troubleshooting.md'), 'utf8')
  const from = page.indexOf('## What the service could not start for')
  const said = page.slice(from, page.indexOf('\n## ', from + 1))
  /** The codes the table names: the words in the first cell of each of its rows. */
  const named = said
    .split('\n')
    .filter((line) => /^\| `/.test(line))
    .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
  /**
   * The code of every Problem a source file makes: the second thing each is given, where that
   * is a word, or a choice between words. A comma inside a string or a bracket divides nothing.
   */
  const problemsOf = (file) => {
    const text = readFileSync(path.join(root, file), 'utf8')
    const codes = []
    for (const made of text.matchAll(/new Problem\(/g)) {
      const given = ['']
      const inside = ['(']
      for (let i = made.index + made[0].length; inside.length && i < text.length; i++) {
        const c = text[i]
        const within = inside.at(-1)
        if (within === "'" || within === '"' || within === '`') {
          if (c === '\\') given[given.length - 1] += text[i++]
          else if (c === within) inside.pop()
          else if (within === '`' && c === '$' && text[i + 1] === '{') inside.push(text[i++] + text[i])
        } else if (c === "'" || c === '"' || c === '`' || '([{'.includes(c)) inside.push(c)
        else if (')]}'.includes(c)) inside.pop()
        else if (c === ',' && inside.length === 1) {
          given.push('')
          continue
        }
        given[given.length - 1] += text[i]
      }
      // Where it is a choice, the words chosen between come after what is asked
      const code = given[1] ?? ''
      codes.push(...[...code.slice(code.indexOf('?') + 1).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
    }
    return codes
  }
  // What `it serve` runs before it says it has started: its settings, the backend program, the door
  const START = ['packages/cli/src/serve/index.ts', 'packages/cli/src/serve/config.ts', 'packages/cli/src/serve/backend.ts', 'packages/cli/src/serve/door.ts']
  // Made in those files, and never what a start ends with: a service asked to stop while it starts has stopped, which is no failure, and only setup and joining wait their turn for the folder
  const NOT_A_START = ['stopped', 'busy']

  test('names every code of It’s own that a start can end with', () => {
    expect(named.length).toBeGreaterThan(20)
    const made = [...new Set(START.flatMap(problemsOf))].filter((code) => !NOT_A_START.includes(code))
    expect(made.length).toBeGreaterThan(20)
    expect(made.filter((code) => !named.includes(code))).toEqual([])
    // Two more are made where every command can reach them: a port that is none, and a folder that was never set up
    const shared = problemsOf('packages/cli/src/lib.ts')
    for (const code of ['invalid', 'not_set_up']) {
      expect(shared, code).toContain(code)
      expect(named, code).toContain(code)
    }
  })

  test('names the one word a start ends with where what stopped it has no code', () => {
    const main = readFileSync(path.join(root, 'packages/cli/src/main.ts'), 'utf8')
    expect(main).toMatch(/const code = own \?\? \(\/\^E\[A-Z0-9_\]\{2,30\}\$\/\.test\(system\) \? system : 'error'\)\n\s+line\(`could not start: \$\{code\}`\)/)
    expect(named).toContain('error')
    expect(said).toMatch(/or the system's own code for what a file or a socket refused/)
  })

  test('names no code that the service does not make', () => {
    const made = [...START.flatMap(problemsOf), ...problemsOf('packages/cli/src/lib.ts'), 'error']
    expect(named.filter((code) => !made.includes(code))).toEqual([])
    expect(new Set(named).size).toBe(named.length)
  })
})

describe('what docs/troubleshooting.md says the door refused', () => {
  const page = readFileSync(path.join(root, 'docs', 'troubleshooting.md'), 'utf8')
  const from = page.indexOf('## What the door refused')
  const said = page.slice(from, page.indexOf('\n## ', from + 1))
  /** The codes the table names: the words in the first cell of each of its rows. */
  const named = said
    .split('\n')
    .filter((line) => /^\| `/.test(line))
    .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
  /**
   * Every code the door writes down for a request it refused or could not answer: what it
   * answers a refusal with, what it notes of a connection it turned away, and what the part
   * of it that sends notifications refuses with, which the door writes down for it.
   */
  const written = ['packages/cli/src/serve/door.ts', 'packages/cli/src/serve/push.ts'].flatMap((file) => {
    const text = readFileSync(path.join(root, file), 'utf8')
    return [
      ...[...text.matchAll(/\b(?:refuse|no)\(\s*\d{3},\s*'([a-z_]+)'/g)].map((m) => m[1]),
      ...[...text.matchAll(/\b(?:noted|turned)\('([a-z_]+)'\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/^export type Turned = (.+)$/gm)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((code) => code[1])),
      ...[...text.matchAll(/const unread = \(why: ([^)]+)\)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((code) => code[1])),
    ]
  })

  test('names every code the door writes down, and no code that it does not', () => {
    const codes = [...new Set(written)].sort()
    expect(codes.length).toBeGreaterThan(35)
    expect(codes.filter((code) => !named.includes(code))).toEqual([])
    expect(named.filter((code) => !codes.includes(code))).toEqual([])
    expect(new Set(named).size).toBe(named.length)
  })

  test('says of every code what a person can do, and the line the door writes is the one the page gives', () => {
    const rows = said.split('\n').filter((line) => /^\| `/.test(line))
    for (const row of rows) expect(row.split('|').length, row.slice(0, 60)).toBe(5)
    for (const row of rows) expect(row.split('|')[3].trim().length, row.slice(0, 60)).toBeGreaterThan(6)
    const door = readFileSync(path.join(root, 'packages/cli/src/serve/door.ts'), 'utf8')
    expect(door).toMatch(/say\(`door refused a request \(\$\{code\}\)/)
    expect(said).toContain('`door refused a request (<code>)`')
  })
})

describe('what docs/add-ons.md says of the agent apps', () => {
  const page = readFileSync(path.join(root, 'docs', 'add-ons.md'), 'utf8')
  const setup = readFileSync(path.join(root, 'packages/cli/src/setup.ts'), 'utf8')

  test('names for each the oldest version that setup installs an add-on into, as setup has it', () => {
    const known = [...setup.matchAll(/^ {2}(?:'[a-z-]+'|[a-z]+): \{ label: '([^']+)', bin: '[^']+', min: '([^']+)' \},$/gm)].map((m) => `| ${m[1]} | ${m[2]} |`)
    expect(known.length).toBe(6)
    const from = page.indexOf('| Agent app | The oldest version `it setup` installs into |')
    expect(from).toBeGreaterThan(-1)
    const rows = page.slice(from, page.indexOf('\n\n', from)).split('\n').slice(2)
    expect([...rows].sort()).toEqual([...known].sort())
  })
})

// The end-to-end job runs on Linux, and these run its two steps as they are written, with its
// shell and its signals. A stand-in takes the place of `node`, and so of the stack.
describe.skipIf(!shell || process.platform === 'win32')('stopping It at the end of an end-to-end run, with the steps run as they are written', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-workflow-test-'))
  const started = []
  afterAll(() => {
    // A stand-in that was left running is ended by its own process id
    for (const pid of started) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const start = scriptOf(steps('e2e')[stepWith('e2e', 'node e2e/stack.mjs')])
  const stop = scriptOf(steps('e2e')[stepWith('e2e', 'kill "$(cat it-stack.pid)"')])
  let made = 0
  /**
   * A runner's folders, with a stack started in them by the workflow's own step. The stand-in
   * writes a log as the stack does, and then does as `asked` says when it is asked to stop: it
   * ends with that status, or, for `never`, goes on running.
   */
  const runner = (asked) => {
    const temp = path.join(dir, `runner-${++made}`)
    const bin = path.join(temp, 'bin')
    mkdirSync(bin, { recursive: true })
    const standIn = [
      '#!/bin/sh',
      '[ "$1" = e2e/stack.mjs ] || exit 0',
      'echo "ready" > "$IT_STACK_LOGS/service.log"',
      asked === 'at once' ? 'exit 3' : asked === 'never' ? `trap '' TERM` : `trap 'exit ${asked}' TERM`,
      // It ends by itself within the minute, so that none is left running whatever becomes of the test
      'n=0; while [ $n -lt 600 ]; do sleep 0.1; n=$((n + 1)); done',
      '',
    ].join('\n')
    writeFileSync(path.join(bin, 'node'), standIn)
    chmodSync(path.join(bin, 'node'), 0o755)
    const output = path.join(temp, 'output')
    writeFileSync(output, '')
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: temp,
      IT_STACK_LOGS: path.join(temp, 'it-logs'),
      GITHUB_OUTPUT: output,
    }
    const began = asRunner(start, { env, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(began.status, began.stderr).toBe(0)
    // The stack is started behind the step, and has written its process id down a moment later
    const noted = path.join(temp, 'it-stack.pid')
    for (const end = Date.now() + 10_000; !(existsSync(noted) && readFileSync(noted, 'utf8').trim()) && Date.now() < end; ) spawnSync('sleep', ['0.05'])
    const pid = Number(readFileSync(noted, 'utf8'))
    expect(pid).toBeGreaterThan(1)
    started.push(pid)
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    return {
      temp,
      alive,
      stops: (waits) => asRunner(stop, { env: { ...env, WAITS: String(waits) }, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] }),
      kept: () => (existsSync(path.join(temp, 'it-kept')) ? readdirSync(path.join(temp, 'it-kept')).sort() : null),
      setAside: () => readFileSync(output, 'utf8'),
    }
  }

  test('a stack that stops when it is asked to passes the step, and what it wrote is set aside', () => {
    const it = runner(0)
    const ran = it.stops(20)
    expect(ran.status, ran.stdout).toBe(0)
    expect(it.alive()).toBe(false)
    expect(it.kept()).toEqual(['service.log', 'stack.log'])
    expect(it.setAside()).toBe('set-aside=yes\n')
  }, 60_000)

  test('a stack that ends as a failure, as one does that had to end It by force, fails the step, and what it wrote is set aside to be read all the same', () => {
    const it = runner(1)
    const ran = it.stops(20)
    expect(ran.status).toBe(1)
    expect(ran.stdout).toMatch(/::error::The stack ended with 1/)
    expect(it.kept()).toEqual(['service.log', 'stack.log'])
    expect(it.setAside()).toBe('set-aside=yes\n')
  }, 60_000)

  test('a stack that had stopped by itself before it was asked fails the step in the same way', async () => {
    const it = runner('at once')
    for (const end = Date.now() + 10_000; !existsSync(path.join(it.temp, 'it-stack.ended')) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50))
    const ran = it.stops(20)
    expect(ran.status).toBe(1)
    expect(ran.stdout).toMatch(/::error::The stack ended with 3/)
    expect(it.setAside()).toBe('set-aside=yes\n')
  }, 60_000)

  test('a stack that has not ended when the wait is over fails the step, is not killed, and nothing it wrote is copied, so that nothing is read or kept', () => {
    const it = runner('never')
    const ran = it.stops(2)
    expect(ran.status).toBe(1)
    expect(ran.stdout).toMatch(/::error::The stack had not ended 2 seconds after it was asked to stop/)
    expect(it.alive()).toBe(true)
    expect(it.kept()).toBe(null)
    expect(it.setAside()).toBe('')
  }, 60_000)
})
