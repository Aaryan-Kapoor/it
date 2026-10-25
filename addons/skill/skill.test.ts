// The agent skill is the contract an agent reads, and it is written by hand. These tests hold
// it to the program it describes: a command, a flag or a field that the skill names is one the
// `it` command and the in-page script really have.
import { readdirSync, readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, onTestFinished, test } from 'vitest'
import { RUNTIME } from '../../packages/content/src/runtime.generated'
import { LIMITS, QUOTA, SHRINK } from '../../packages/protocol/src/index'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
/** What an agent reads whole each time it uses It. */
const short = source('./SKILL.md')
/** The parts it leaves for when they are needed, each printed by `it help` and its name. */
const PARTS = ['actions', 'page', 'showing', 'waiting']
const more = Object.fromEntries(PARTS.map((part) => [part, source(`./more/${part}.md`)]))
/** Everything an agent can be told: most of what is held to the program here may stand in either. */
const skill = [short, ...Object.values(more)].join('\n')
const main = source('../../packages/cli/src/main.ts')
const help = /const HELP = `([\s\S]*?)`\n/.exec(main)![1]!

/** Everything the skill writes as code: what stands between backticks, and the lines of its examples. */
const code = [...skill.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/g)].flatMap((m) => (m[1] ?? m[2]!).split('\n'))
/** The `it` commands among it, each as its words. */
const commands = code.filter((line) => /^it [a-z]/.test(line)).map((line) => line.split(/\s+/))

/** Run the documented draft example with the served runtime and control the site's answers. */
const draftPage = () => {
  const example = /```html\n([\s\S]*?)```/.exec(more.page!)![1]!
  const script = /<script>([\s\S]*?)<\/script>/.exec(example)![1]!
  const w = new JSDOM(`<!doctype html><body>${example.replace(/<script>[\s\S]*?<\/script>/, '')}</body>`, {
    url: 'http://content.test/s/a-token/v/1/index.html',
    runScripts: 'outside-only',
  }).window as any
  onTestFinished(() => w.close())
  const later = new Map<number, { fn: () => void; ms: number }>()
  let timer = 0
  w.setTimeout = (fn: () => void, ms: number) => {
    later.set(++timer, { fn, ms })
    return timer
  }
  w.clearTimeout = (n: number) => later.delete(n)
  w.setInterval = () => 0
  w.__IT__ = { app: 'http://app.test', id: 'notes', version: 1, keep: '/s/a-token/__it/keep' }
  w.parent.postMessage = () => {}
  w.eval(RUNTIME)
  w.eval(script)
  const sent: any[] = []
  const port = { postMessage: (m: unknown) => sent.push(m), onmessage: null as ((e: { data: unknown }) => void) | null }
  w.dispatchEvent(Object.assign(new w.Event('message'), { origin: 'http://app.test', source: w.parent, data: { type: 'it:port' }, ports: [port] }))
  const box = w.document.getElementById('draft')
  const stores = () => sent.filter((m) => m.type === 'it:store')
  return {
    box,
    retry: w.document.getElementById('draft-retry'),
    said: () => w.document.getElementById('draft-status')?.textContent,
    types(text: string) {
      box.value = text
      box.dispatchEvent(new w.Event('input'))
    },
    arrives: (state: unknown, revision: number) => port.onmessage!({ data: { type: 'it:state', state, revision } }),
    /** Run only the documented debounce, not the runtime's connection retry. */
    aMomentLater() {
      for (const [id, { fn, ms }] of [...later]) {
        if (ms !== 800) continue
        later.delete(id)
        fn()
      }
    },
    stored: () => stores().map((m) => m.value),
    async answer(index: number, ok: boolean) {
      const requestId = stores()[index].requestId
      port.onmessage!({ data: { type: 'it:result', requestId, ok, ...(ok ? {} : { error: 'The save was refused.' }) } })
      await new Promise(setImmediate)
    },
  }
}

describe('the agent skill', () => {
  test('is short, and names each part it leaves out where an agent would want it, by the command that prints it', () => {
    // It is read whole every time, by every agent that uses It: what it once held was 27 KB
    expect(Buffer.byteLength(short)).toBeLessThan(12_500)
    expect(readdirSync(new URL('./more', import.meta.url)).sort()).toEqual(PARTS.map((part) => `${part}.md`))
    // A part nothing in the skill points to is never opened
    for (const part of PARTS) expect(short, part).toContain(`\`it help ${part}\``)
    // The program prints a part by its name, and its own help says which there are
    expect(main).toMatch(/cmd === 'help' && a\._\[0\] !== undefined && Object\.hasOwn\(MORE, a\._\[0\]\)/)
    expect(help.replace(/\s+/g, ' ')).toContain('showing, page, waiting or actions')
    expect(source('../../packages/cli/addons.mjs')).toContain("readdirSync(path.join(root, 'skill/more'))")
  })

  test('says in its own lines what every page needs: the link in chat, the answer on the page, and what is not a page', () => {
    expect(short).toContain('**Give the user the `url` in chat, every time you make a page**')
    expect(short).toContain('**Answer on the page.** The user is looking at the page and not at this conversation')
    expect(short).toContain('`it say deploy-plan "…"`')
    expect(short).toContain('Only a plain answer to a plain question stays in chat.')
    // What the person types above a page is told to the agent in these words, by the program
    expect(short).toContain('"The user typed this to you in the box above the page"')
    expect(source('../../packages/protocol/src/index.ts')).toContain('[It] The user typed this to you in the box above the ')
  })

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
    expect([...flags.keys()].sort()).toEqual(['ack', 'action', 'actions', 'create', 'delete', 'notify', 'open', 'patch', 'update', 'wait'])
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
    const commands = main + source('../../packages/cli/src/wait.ts')
    for (const field of [
      'url',
      'shownOn',
      'notShown',
      'notShownOn',
      'sentTo',
      'notSentTo',
      'hint',
      'revision',
      'timedOut',
      'sentByThePageItself',
      'typedByTheUser',
      'pageIsNowAtVersion',
      'stateIsNowAtRevision',
      'files',
      'harnesses',
      'connector',
    ]) {
      expect(skill, field).toContain(field)
      expect(commands, field).toMatch(new RegExp(`\\b${field}\\b`))
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

  test('says in one line of its own that a file goes in an action as it is, and is never cut up or written as text', () => {
    expect(short).toContain(
      "- **Files go in the data as they are**: `It.action('receipt', { photo: input.files[0] })` sends a `File` or `Blob` (input, drop, `canvas.toBlob`) whole. Never slice one or write it as text.",
    )
    // In the numbers and the words the in-page script keeps: how far a photo is made smaller, and how a page keeps it as it is
    expect(short).toContain(`A photo is shrunk to ${SHRINK.side} px unless a third argument says \`{ original: true }\`.`)
    expect(source('../../packages/runtime/src/it.ts')).toMatch(/original\?: boolean/)
    // And what the agent then reads it with
    expect(more.actions).toContain('`it action <id> --save receipt.jpg` writes it to that file')
    expect(more.actions).toContain('`--number 2` says which to write')
  })

  test('names only what the in-page script gives a page', () => {
    const runtime = source('../../packages/runtime/src/it.ts')
    for (const name of ['action', 'stage', 'commit', 'onState', 'store']) {
      expect(short).toContain(`It.${name}`)
      expect(runtime, name).toMatch(new RegExp(`\\b${name}\\b`))
    }
    for (const attribute of ['data-it-bind', 'data-it-show']) {
      expect(short).toContain(attribute)
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

  test('tells an agent to show a page on the one display the user is on, unless the user asked for another or for every one', () => {
    expect(short).toContain('the display asked to bring it up: the one the user is on, or one `--on` names')
    expect(short).toContain('`--on all`: every one, if the user asks')
    expect(more.showing).toContain('leave `--on` out unless the user named a display')
    expect(more.showing).toContain('use it only when the user asked for the page on all of their screens')
    // Each reason the skill names is one the backend gives, and `all` is the word the backend takes for every display
    const aim = source('../../convex/lib/aim.ts')
    for (const reason of ['not_chosen', 'not_paired', 'agents_off', 'locked']) {
      expect(more.showing).toContain(`\`${reason}\``)
      expect(aim, reason).toContain(`'${reason}'`)
    }
    expect(aim).toContain("EVERY_DISPLAY = 'all'")
    // And the codes a display named for a notification is refused with are the program's own
    expect(main).toContain("'agents_off'")
    expect(main).toContain("'not_paired'")
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
    expect(skill).toContain(
      `An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB of data, and beside it up to ${LIMITS.actionFiles} files, each at most ${LIMITS.actionFileBytes / MB} MB and ${LIMITS.actionFilesBytes / MB} MB together.`,
    )
    expect(skill).toContain(`It holds ${QUOTA.actionFileBytes / MB / 1024} GB of files sent from pages in all`)
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
    expect(main).toContain("import { failure, forPerson } from './output'")
    expect(source('../../packages/cli/src/output.ts')).toMatch(
      /const forPerson = \(a: Args\): boolean => process\.stdout\.isTTY === true && a\.flags\.json !== true && sessionAsked\(\) === undefined/,
    )
  })

  test('tells an agent what a display that is not paired means, and how to change state only while it is as it was read', () => {
    // What the command prints of a display that shows nothing, and why
    expect(main).toMatch(/notShownOn\?: \{ display: string; reason: string \}\[\]/)
    expect(main).toContain("of('not_paired')")
    expect(skill).toContain('If `notShownOn` is there, it lists each display the page is not shown on, with a `reason`:')
    expect(skill).toContain('- `not_paired`: the pairing of that display')
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
    // The example reads what was saved where the state arrives, and saves no faster than a page may send
    const example = /```html\n[\s\S]*?```/.exec(more.page!)![0]
    expect(example).toMatch(/It\.onState\(\(\) => \{[\s\S]{0,80}box\.value = It\.store\.get\('draft'\) \?\? ''/)
    expect(example).toContain('setTimeout(save, 800)')
  })

  test('its example of a draft, run as it is written, puts back what was saved once and never over what was typed, before the state came or after', () => {
    // Opened with nothing typed: what was saved is put back, and what is typed after it stays through every later change of the state
    const opened = draftPage()
    opened.arrives({ _page: { draft: 'what was saved' } }, 3)
    expect(opened.box.value).toBe('what was saved')
    opened.types('what was saved, and more')
    opened.arrives({ _page: { draft: 'what was saved' }, status: 'Working' }, 4)
    expect(opened.box.value).toBe('what was saved, and more')
    opened.aMomentLater()
    expect(opened.stored()).toEqual(['what was saved, and more'])
    // Typed into before the state came, which takes a moment: what was typed stays, and it is what is saved
    const early = draftPage()
    early.types('typed before the state came')
    early.arrives({ _page: { draft: 'what was saved' } }, 3)
    expect(early.box.value).toBe('typed before the state came')
    early.aMomentLater()
    expect(early.stored()).toEqual(['typed before the state came'])
  })

  test('the draft example reports a failed save, preserves its text and retries without another edit', async () => {
    const p = draftPage()
    p.arrives({}, 0)
    expect(p.said()).toBe('No unsaved changes.')
    p.types('first letter')
    p.types('the whole draft')
    expect(p.said()).toBe('Changes not saved yet.')
    expect(p.stored()).toEqual([])
    p.aMomentLater()
    expect(p.stored()).toEqual(['the whole draft'])
    expect(p.said()).toBe('Saving...')
    await p.answer(0, false)
    expect(p.box.value).toBe('the whole draft')
    expect(p.said()).toMatch(/^Not saved\. Keep this page open and try again\./)
    expect(p.retry.hidden).toBe(false)
    // A failure does not start an endless retry loop.
    p.aMomentLater()
    expect(p.stored()).toHaveLength(1)
    p.retry.click()
    p.retry.click()
    expect(p.stored()).toEqual(['the whole draft', 'the whole draft'])
    expect(p.said()).toBe('Saving...')
    expect(p.retry.hidden).toBe(true)
    await p.answer(1, true)
    expect(p.said()).toBe('Saved.')
    expect(p.box.value).toBe('the whole draft')
    expect(p.retry.hidden).toBe(true)
  })

  test.each([true, false])('the draft example keeps newer text unsaved when an older request finishes with ok=%s', async (ok) => {
    const p = draftPage()
    p.types('older draft')
    p.aMomentLater()
    // Typing and its debounce both happen before the older request is answered.
    p.types('newest draft')
    p.aMomentLater()
    expect(p.stored()).toEqual(['older draft'])
    await p.answer(0, ok)
    expect(p.box.value).toBe('newest draft')
    expect(p.said()).toBe('Changes not saved yet.')
    expect(p.retry.hidden).toBe(true)
    p.aMomentLater()
    expect(p.stored()).toEqual(['older draft', 'newest draft'])
    await p.answer(1, false)
    expect(p.said()).toMatch(/^Not saved\./)
    // Even a repeated answer for the old request cannot clear this revision's failure.
    await p.answer(0, true)
    expect(p.said()).toMatch(/^Not saved\./)
    expect(p.retry.hidden).toBe(false)
    p.retry.click()
    await p.answer(2, true)
    expect(p.said()).toBe('Saved.')
    expect(p.box.value).toBe('newest draft')
  })

  test('the draft example saves an edit made during a retry before saying it is saved', async () => {
    const p = draftPage()
    p.types('a draft')
    p.aMomentLater()
    await p.answer(0, false)
    p.retry.click()
    p.types('a draft with another sentence')
    // The retry finishes before the new edit's debounce.
    await p.answer(1, true)
    expect(p.said()).toBe('Changes not saved yet.')
    p.aMomentLater()
    expect(p.stored()).toEqual(['a draft', 'a draft', 'a draft with another sentence'])
    await p.answer(2, true)
    expect(p.said()).toBe('Saved.')
  })

  test('says how much of what is waiting one `it wait` or one `it actions` prints, in the number the program keeps, and to run it again past that', () => {
    // Each of the three lists a command reads from is cut at the same number
    const read = source('../../convex/delivery.ts')
    for (const list of ['waiting', 'waitingFor', 'allWaiting']) {
      // The query's own text, from where it begins to where the next one does, however it comes to its answer
      const from = read.indexOf(`export const ${list} = query({`)
      const body = read.slice(from, read.indexOf('\nexport const ', from + 1))
      expect([list, from >= 0 && body.includes('.take(50)')]).toEqual([list, true])
    }
    expect(more.waiting).toContain('at most 50 at once: read every line, and where 50 came, run it again, since more may be waiting.')
    expect(more.actions).toContain('only lists what is waiting, 50 at most: where it lists 50, run it again once you have run `it ack` for those')
    expect(skill).not.toContain('they are all printed')
  })

  test('says that a page is a conversation’s to keep or to take only where the harness names the conversation, and what to do where it does not', () => {
    // With no conversation named, the command does not ask for the page as its own, nothing is taken by opening it, and taking it is refused
    expect(source('../../packages/cli/src/publish.ts')).toContain('...(input.own && !input.take && session ? { own: true } : {})')
    expect(main).toMatch(
      /const mine = asked\?\.session[\s\S]{0,900}api\.displays\.show[\s\S]{0,300}\.\.\.\(mine \? \{ session: mine, agent: mine\.harness \} : \{\}\)/,
    )
    expect(source('../../convex/displays.ts')).toMatch(
      /const took = mine && shown\.length \? \(await takePage\(ctx, artifact, machine, mine, agent\)\)\.took : false/,
    )
    expect(source('../../convex/publish.ts')).toMatch(/if \(args\.take && !args\.session\) fail\('invalid'/)
    expect(short).toContain('None of that holds where your harness does not tell `it` which conversation this is: read `it help actions`')
    expect(more.actions).toContain('publishes over its page and answers no `conflict`, `it open` brings a page up without making it yours, `--take` is refused')
    // What it is told to do instead is there to be done: a page that is not there is said so
    expect(source('../../convex/artifacts.ts')).toMatch(/artifactBySlug\(ctx, userId, ref\.slug\)\) \?\? fail\('not_found'/)
    expect(more.actions).toContain('use the id only if that answers `not_found`')
  })

  test('its first lines are read the same by every app, the strictest of them included', () => {
    // An app reads the lines between the dashes as YAML. Pi reads them strictly: a colon followed by a space
    // inside the description begins a mapping there, the whole skill is refused ("Nested mappings are not
    // allowed in compact mappings") and its agent is never told that It exists.
    const head = /^---\n([\s\S]*?)\n---\n/.exec(short)![1]!.split('\n')
    expect(head.map((line) => line.slice(0, line.indexOf(':')))).toEqual(['name', 'description'])
    for (const line of head) {
      const value = line.slice(line.indexOf(':') + 1).trim()
      // What makes a plain value mean something else: a colon and a space, a space and a hash, and a first character YAML reads as a mark
      expect(value, line.slice(0, 40)).not.toMatch(/: | #|:$/)
      expect(value).not.toMatch(/^[[\]{}&*!|>'"%@`,?-]/)
    }
    // It is written as a condition and what follows from it, and both come before the first full
    // stop, since an app may list no more than that: when the user needs something to see and act
    // on, or the agent needs something back from them, It is used, in place of a reply in chat
    // and of what the app itself has for showing things
    expect(head[1]).toMatch(
      /^description: IF the user needs something to see and act on rather than text to read, or you need input back from them, THEN build it as an interface with It, INSTEAD OF a chat reply or your own built-in [^.]*, unless the user asks for one of those by name\./,
    )
    // It says what It is, in the words that tell an agent what it is for
    expect(head[1]).toMatch(/It is a two-way workspace, where you build any interface on any screen the user owns and what they do on it comes back to you\./)
    // And it names no particular thing to build. A list of them (a game, a chart, a form) narrows
    // what an agent thinks It is for to that list, where the condition is meant to be the whole of it
    expect(head[1]).not.toMatch(/\b(quiz|games?|boards?|charts?|dashboards?|forms?|drawings?|plans?|maps?)\b/i)
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
