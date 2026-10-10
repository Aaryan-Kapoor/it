// The agent skill is the contract an agent reads, and it is written by hand. These tests hold
// it to the program it describes: a command, a flag or a field that the skill names is one the
// `it` command and the in-page script really have.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { LIMITS, QUOTA } from '../../packages/protocol/src/index'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const skill = source('./SKILL.md')
const main = source('../../packages/cli/src/main.ts')
const help = /const HELP = `([\s\S]*?)`\n/.exec(main)![1]!

/** Everything the skill writes as code: what stands between backticks, and the lines of its examples. */
const code = [...skill.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/g)].flatMap((m) => (m[1] ?? m[2]!).split('\n'))
/** The `it` commands among it, each as its words. */
const commands = code.filter((line) => /^it [a-z]/.test(line)).map((line) => line.split(/\s+/))

describe('the agent skill', () => {
  test('names only commands that the `it` command has', () => {
    const named = [...new Set(commands.map((words) => words[1]!))].sort()
    expect(named.length).toBeGreaterThan(15)
    for (const command of named) expect(main, `it ${command}`).toMatch(new RegExp(`case '${command}':|cmd === '${command}'`))
    // The one it names with a second word, in the two forms it names
    expect([...new Set(commands.filter((words) => words[1] === 'service').map((words) => words[2]))].sort()).toEqual(['logs', 'status'])
    for (const sub of ['logs', 'status']) expect(main).toContain(`sub === '${sub}'`)
  })

  test('names only flags that the command it gives them to takes', () => {
    const flags = new Map<string, Set<string>>()
    for (const words of commands)
      for (const word of words.slice(2)) {
        const flag = /^[[(]?(--[a-z-]+)/.exec(word)?.[1]
        if (flag) flags.set(words[1]!, (flags.get(words[1]!) ?? new Set()).add(flag))
      }
    expect([...flags.keys()].sort()).toEqual(['ack', 'action', 'actions', 'create', 'notify', 'open', 'patch', 'update', 'wait'])
    for (const [command, taken] of flags) {
      // What the program's own help says of that command
      const said = help
        .split('\n')
        .filter((line) => new RegExp(`^\\s+it ${command}\\b`).test(line))
        .join('\n')
      for (const flag of taken) expect(said, `it ${command} ${flag}`).toContain(flag)
    }
    // Flags named by themselves, away from a command, are flags of some command
    for (const flag of new Set(code.flatMap((line) => line.match(/--[a-z-]+/g) ?? []))) expect(help, flag).toContain(flag)
  })

  test('names only fields that the commands print', () => {
    for (const field of [
      'url',
      'shownOn',
      'notShown',
      'notShownOn',
      'hint',
      'revision',
      'timedOut',
      'sentByThePageItself',
      'pageIsNowAtVersion',
      'stateIsNowAtRevision',
      'harnesses',
      'connector',
    ]) {
      expect(skill, field).toContain(field)
      expect(main, field).toMatch(new RegExp(`\\b${field}\\b`))
    }
    // What `it status` says of an add-on and of the connector
    const setup = source('../../packages/cli/src/setup.ts')
    for (const state of ['connected', 'needs_approval']) {
      expect(skill).toContain(`"${state}"`)
      expect(setup).toContain(`'${state}'`)
    }
    expect(skill).toContain('`"ok": true`')
    expect(source('../../packages/cli/src/connector.ts')).toMatch(/pathname === '\/health'[\s\S]{0,200}ok: true/)
  })

  test('names only what the in-page script gives a page', () => {
    const runtime = source('../../packages/runtime/src/it.ts')
    for (const name of ['action', 'stage', 'commit', 'onState', 'store']) {
      expect(skill).toContain(`It.${name}`)
      expect(runtime, name).toMatch(new RegExp(`\\b${name}\\b`))
    }
    for (const attribute of ['data-it-bind', 'data-it-show']) {
      expect(skill).toContain(attribute)
      expect(runtime).toContain(attribute)
    }
  })

  test('tells an agent what to do when no display took the page, and how to wait where nothing arrives by itself', () => {
    expect(skill).toMatch(
      /If `shownOn` is empty and there is neither `notShown` nor `notShownOn`, .* give the user the `url`, and tell them that no display is paired\./,
    )
    // A display that was asked for by name and shows nothing is said of that display, and not of all of them
    expect(skill).toContain('Where `notShownOn` names the display you asked for, it is that display that shows nothing')
    // The word for a display that can be shown on is the program's own: what it says when there is none
    expect(main).toContain('No display is paired yet')
    expect(skill).not.toMatch(/signed in|sign one in|signs? in\b/)
    expect(skill).toContain('`it status`')
    expect(skill).toContain('`it wait --id deploy-plan --timeout 100`')
    expect(skill).toContain('`{"timedOut": true}`')
    expect(skill).toMatch(/`it ack <action-id>` is for an action you took from `it actions`\./)
  })

  test('says that a page which was published and could not be shown is published all the same, and what to read before saying anything of the displays', () => {
    // What the command does: the page and `notShown` on standard output, and a status of 1
    expect(main).toMatch(/\.\.\.result,\s*shownOn: \[\],\s*notShown: \{ code: err\.code[\s\S]{0,600}?process\.exitCode = 1/)
    expect(skill).toMatch(/prints the page as usual on standard output, with `notShown` beside it, and exits with status 1/)
    expect(skill).toContain('read `notShown.code` before you say anything about displays')
    // Each code the skill names is one the command can give
    const given = main + source('../../packages/cli/src/lib.ts')
    for (const code of ['not_found', 'rate_limited', 'offline', 'timeout']) {
      expect(skill).toContain(`\`${code}\``)
      expect(given, code).toContain(`'${code}'`)
    }
    expect(skill).toMatch(/do not publish the page again: `it open deploy-plan` asks the displays once more/)
  })

  test('does not take a connected add-on and a running connector for proof that a message will reach this conversation', () => {
    expect(skill).toMatch(/Both are needed, and neither is proof that a message will reach this conversation/)
    // What setup tells a person who has just connected Hermes is the same
    const setup = source('../../packages/cli/src/setup.ts')
    expect(skill).toMatch(/In Hermes a message arrives by itself in the plain `hermes` terminal\./)
    expect(setup).toContain('then arrives by itself in the plain `hermes` terminal')
    expect(skill).toContain('later than 0.21.5')
    expect(setup).toContain("older('0.21.5', version)")
  })

  test('tells an agent what a page cannot do in the sandbox it is shown in, and where a page keeps things', () => {
    // What the sandbox is: the words the pages' port and the site's frame both say, with nothing that would give a page an origin
    const protocol = source('../../packages/protocol/src/index.ts')
    const sandbox = /export const SANDBOX = '([^']+)'/.exec(protocol)![1]!
    expect(sandbox.split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-popups']))
    for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox']) expect(sandbox).not.toContain(word)
    expect(skill).toContain('It has no cookies.')
    expect(skill).toContain('There is no IndexedDB, no `caches` and no service worker.')
    expect(skill).toContain('A worker starts only from a `blob:` address.')
    expect(skill).toContain('It cannot frame its own files.')
    expect(skill).toContain('Whatever it opens is held to the same.')
    // The in-page script stands in for the two kinds of storage, for as long as the document is open and not after
    const runtime = source('../../packages/runtime/src/it.ts')
    expect(runtime).toMatch(/for \(const name of \['localStorage', 'sessionStorage'\] as const\)/)
    expect(skill).toContain('`localStorage` and `sessionStorage` last only while the page is open.')
    expect(skill).toContain('Anything the page must remember goes in `It.store`.')
    // Only the site may frame what the pages' port sends, so a page cannot frame a file of its own
    expect(source('../../packages/content/src/index.ts')).toMatch(/frame-ancestors \$\{siteAt\(/)
  })

  test('gives the limits a page meets in the numbers the program keeps', () => {
    const MB = 1024 * 1024
    expect(skill).toContain(
      `A page is at most ${LIMITS.filesPerVersion} files and ${LIMITS.versionBytes / MB} MB, with no file over ${LIMITS.fileBytes / MB} MB.`,
    )
    expect(skill).toContain(`A file's path is at most ${LIMITS.pathLength} bytes.`)
    expect(LIMITS.versionsKept).toBe(10)
    expect(skill).toContain('Ten versions of a page are kept')
    expect(skill).toContain(`It holds ${QUOTA.artifacts} pages and ${QUOTA.bytes / MB / 1024} GB of their files in all`)
    expect(skill).toContain(`State is at most ${LIMITS.stateBytes / 1024} KB of JSON,`)
    expect(skill).toContain(`An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB.`)
    expect(skill).toContain(`Its name is 1 to ${LIMITS.actionName} letters, digits, dots, colons, dashes or underscores.`)
    expect(skill).toContain(`A value kept with \`It.store\` is at most ${LIMITS.storeValueBytes / 1024} KB too`)
    expect(skill).toContain(`At most ${QUOTA.pendingActionsPerPage} actions wait on one page.`)
    // How fast: what the backend counts for one page, and what the site takes from one before that
    const limits = source('../../convex/lib/limits.ts')
    const rule = (name: string) => {
      const [, perMinute, burst] = new RegExp(`${name}: \\{ perMinute: (\\d+), burst: (\\d+) \\}`).exec(limits)!
      return { perMinute: Number(perMinute), burst: Number(burst) }
    }
    expect(rule('submitActionPage').perMinute).toBe(60)
    expect(skill).toContain(`It takes ${rule('submitActionPage').burst} actions from one page before it slows that page to one a second`)
    const state = rule('stateKilobytesPage')
    expect(skill).toContain(`one page may write ${state.burst / 1024} MB of it at once, and then ${state.perMinute / 1024} MB a minute`)
    const frame = source('../../web/src/mount.tsx')
    expect(/const PER_SECOND = (\d+)/.exec(frame)![1]).toBe('5')
    expect(skill).toContain(
      `The site takes ${/const BURST = (\d+)/.exec(frame)![1]} messages from a page at once, actions and stored values together, and then five a second`,
    )
    // How often a page may ask for its own files, and how many conversations a machine listens for
    const reads = /READS: limit\((\d+)\)/.exec(source('../../packages/content/src/limits.ts'))![1]!
    expect(skill).toContain(`The files of one showing may be asked for ${Number(reads).toLocaleString('en-US')} times in a minute.`)
    const listening = /export const LISTENING_MOST = (\d+)/.exec(source('../../packages/protocol/src/index.ts'))![1]!
    expect(skill).toContain(`It also listens for at most ${listening} conversations on one machine at a time`)
    expect(skill).toContain(`is among the ${listening} again`)
    // What a refusal is called, and that a page is told of one
    for (const code of ['limit', 'rate_limited']) expect(source('../../convex/lib/errors.ts'), code).toContain(`'${code}'`)
    expect(source('../../packages/runtime/src/it.ts')).toContain('rejects if it was refused')
  })

  test('says that an agent is given JSON by the commands that speak to a person at a terminal, and how to ask for it', () => {
    // What the program says of itself: the commands that speak, and what makes them print JSON
    // Read with its line breaks taken out: where a line of the help ends says nothing
    const spoken =
      /Run at a terminal, (.*?) say how things stand in a few sentences\. With --json, wherever a program reads what they print, and for an agent, they print JSON\./.exec(
        help.replace(/\s+/g, ' '),
      )![1]!
    const nine = spoken
      .replace(/\s+/g, ' ')
      .split(/, | and /)
      .map((command) => command.trim())
    expect(nine).toEqual([
      'it setup',
      'it site',
      'it network',
      'it status',
      'it service status',
      'it list',
      'it displays',
      'it whoami',
      'it upgrade',
      'it updates',
      'it uninstall',
    ])
    expect(skill).toContain(
      `Some of them, ${nine
        .slice(0, -1)
        .map((command) => `\`${command}\``)
        .join(', ')} and \`${nine.at(-1)}\`, speak in sentences to a person at a terminal.`,
    )
    expect(skill).toContain('What you run is known to be an agent’s, so you get JSON from those too, and `--json` asks for it')
    expect(main).toMatch(/const forPerson = \(a: Args\): boolean => process\.stdout\.isTTY === true && a\.flags\.json !== true/)
  })

  test('tells an agent what a display that is not paired means, and how to change state only while it is as it was read', () => {
    // What the command prints of a display it was asked onto and that shows nothing, and the one reason there is
    expect(main).toMatch(/notShownOn\?: \{ display: string; reason: string \}\[\]/)
    expect(main).toContain("d.reason === 'not_paired'")
    expect(skill).toContain('If `notShownOn` is there, it lists each display the page was asked onto and is not shown on, with a `reason`.')
    expect(skill).toContain('The one reason is `not_paired`')
    expect(source('../../convex/displays.ts')).toMatch(/paired: await stillPaired\(ctx, d\)/)
    expect(skill).toContain("Each display has `paired`, which is `false` for one whose browser's pairing was ended")
    // The revision `it state` prints is the one `--if-revision` is held to, and a state that has moved on is refused as a conflict
    expect(main).toMatch(/out\(\{ state: parseJson\(s\.json\) \?\? \{\}, revision: s\.revision \}\)/)
    expect(main).toMatch(/const base = text\(a, 'if-revision'\)[\s\S]{0,400}baseRevision: Number\(base\)/)
    expect(source('../../convex/state.ts')).toMatch(/baseRevision !== \(s\?\.revision \?\? 0\)\) \{\s+fail\('conflict'/)
    expect(skill).toContain('`it patch deploy-plan \'{"total":42}\' --if-revision 7`')
    expect(skill).toContain('refused with the code `conflict`')
  })

  test('says that asking a display to show a page is not seeing it shown, and that what a page saved arrives after its scripts first run', () => {
    // The command prints the displays it asked, and waits to hear from none of them
    expect(source('../../convex/displays.ts')).toMatch(/showing: \{ artifactId: artifact\._id, at: Math\.max\(Date\.now\(\), /)
    expect(skill).toContain('`shownOn` in what is printed names the displays that were asked. Asked is all it says:')
    expect(skill).toContain('the displays in `shownOn` were asked to show it')
    expect(skill).not.toMatch(/are showing it/)
    // The state begins empty, what a page stored is read from it at that moment, and a listener is told when it arrives
    const runtime = source('../../packages/runtime/src/it.ts')
    expect(runtime).toMatch(/let state: Record<string, unknown> = \{\}/)
    expect(runtime).toMatch(/get: \(key: string\) => \{\s+const kept = state\[STORE_KEY\]/)
    expect(runtime).toMatch(/if \(message\.type === 'it:state'\) \{[\s\S]{0,160}emit\(\)/)
    expect(skill).toContain("It is not there yet when the page's scripts first run")
    expect(skill).toContain('so as the page starts it returns `undefined` even for something that was saved')
    // The example reads what was saved where the state arrives, once, and saves no faster than a page may send
    const example = /```html\n<textarea id="draft">[\s\S]*?```/.exec(skill)![0]
    expect(example).toMatch(/It\.onState\(\(\) => \{\s+if \(restored\) return\s+restored = true\s+box\.value = It\.store\.get\('draft'\) \?\? ''/)
    expect(example).toMatch(/setTimeout\(\(\) => It\.store\.set\('draft', box\.value\)/)
  })

  test('its first lines are read the same by every app, the strictest of them included', () => {
    // An app reads the lines between the dashes as YAML. Pi reads them strictly: a colon followed by a space
    // inside the description begins a mapping there, the whole skill is refused ("Nested mappings are not
    // allowed in compact mappings") and its agent is never told that It exists.
    const head = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!.split('\n')
    expect(head.map((line) => line.slice(0, line.indexOf(':')))).toEqual(['name', 'description'])
    for (const line of head) {
      const value = line.slice(line.indexOf(':') + 1).trim()
      // What makes a plain value mean something else: a colon and a space, a space and a hash, and a first character YAML reads as a mark
      expect(value, line.slice(0, 40)).not.toMatch(/: | #|:$/)
      expect(value).not.toMatch(/^[[\]{}&*!|>'"%@`,?-]/)
    }
    // It is written as a condition and what follows from it, and both come before the first full
    // stop, since an app may list no more than that: the words a person says and the kind of thing
    // they need, and then that It is used for it in place of what the app itself has for showing things
    expect(head[1]).toMatch(
      /^description: IF the user says "show me", "let's play" or "it this"[^.]*, THEN use It, INSTEAD OF your own built-in [^.]*, unless the user names one of those\./,
    )
    expect(head[1]).toMatch(/interactive or two-way/)
    // And all of it is short enough for the app that cuts a description shortest: Codex gives its model a little over 530 characters of one
    expect(head[1]!.length - 'description: '.length).toBeLessThanOrEqual(520)
  })

  test('says where the command is when its name is not found', () => {
    // By its name alone first. From where it is only when the name is not found, and then with the path
    // written out: a harness that cannot read a command plainly (`$HOME/.it/bin/it …`) stops and asks the person
    expect(skill).toContain('Run it by that name alone, `it`, every time.')
    expect(skill).toMatch(/Only if the name is not found .* is the command run from where it is, `~\/\.it\/bin\/it`/)
    expect(skill).toContain('with no variable such as `$HOME` in it')
    expect(source('../../packages/cli/src/setup.ts')).toContain("inHome('bin', windows ? 'it.exe' : 'it')")
  })

  test('does not let an action stand for the user’s approval of something that matters', () => {
    expect(skill).toContain('The page chooses what an action says.')
    expect(skill).toMatch(/That does not mean the person chose this action/)
    expect(skill).toMatch(/Before you delete, send, pay or publish because of an action/)
    expect(skill).toMatch(/ask in the conversation/)
  })
})
