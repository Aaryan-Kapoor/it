// The agent skill is the contract an agent reads, and it is written by hand. These tests hold
// it to the program it describes: a command, a flag or a field that the skill names is one the
// `it` command and the in-page script really have.
import { readdirSync, readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, onTestFinished, test } from 'vitest'
import { RUNTIME } from '../../packages/content/src/runtime.generated'
import { CHANNEL_VERSION, deepMerge, LIMITS, QUOTA, SHRINK, STORAGE, STORE_EVERY_MS, STORE_KEY, sizeSaid } from '../../packages/protocol/src/index'

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
// A command written for Windows as `it.exe` is the same command, and is read as `it`
const commands = code
  .map((line) => line.replace(/^it\.exe /, 'it '))
  .filter((line) => /^it [a-z]/.test(line))
  .map((line) => line.split(/\s+/))

/** The skill's examples of a page, each as it is written in `it help page`. */
const examples = [...more.page!.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]!)

/** Run one example page with the served runtime, with its timers and the site's port in the test's hands. */
const runExample = (example: string) => {
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
  w.dispatchEvent(
    Object.assign(new w.Event('message'), { origin: 'http://app.test', source: w.parent, data: { type: 'it:port', v: CHANNEL_VERSION }, ports: [port] }),
  )
  const stores = () => sent.filter((m) => m.type === 'it:store')
  /** Time goes by long enough for the runtime's pause between two writes of what the page keeps, and what it holds is sent. */
  const settled = async () => {
    for (const [id, { fn, ms }] of [...later]) {
      if (ms !== STORE_EVERY_MS) continue
      later.delete(id)
      fn()
    }
    await new Promise(setImmediate)
  }
  const arrives = (state: unknown, revision: number) => port.onmessage!({ data: { type: 'it:state', state, revision } })
  return { w, later, port, stores, settled, arrives }
}

/** Run the documented draft example with the served runtime and control the site's answers. */
const draftPage = () => {
  const { w, later, port, stores, settled, arrives } = runExample(examples[0]!)
  const box = w.document.getElementById('draft')
  return {
    box,
    retry: w.document.getElementById('draft-retry'),
    said: () => w.document.getElementById('draft-status')?.textContent,
    types(text: string) {
      box.value = text
      box.dispatchEvent(new w.Event('input'))
    },
    arrives,
    settled,
    /** Run only the documented debounce, and the runtime's pause between writes, which is shorter, and not its connection retry. */
    async aMomentLater() {
      await settled()
      for (const [id, { fn, ms }] of [...later]) {
        if (ms !== 800) continue
        later.delete(id)
        fn()
      }
      await new Promise(setImmediate)
    },
    stored: () => stores().flatMap((m) => m.changes.map(([, text]: [string, string]) => JSON.parse(text))),
    async answer(index: number, ok: boolean) {
      const requestId = stores()[index].requestId
      port.onmessage!({ data: { type: 'it:result', requestId, ok, ...(ok ? { revision: 10 + index } : { error: 'The save was refused.' }) } })
      await settled()
    },
  }
}

/**
 * One page's state as It keeps it, shared by every screen that shows the documented example of
 * controls. It applies each write in the order it takes them, at the next revision, answers the
 * screen that wrote, and sends every screen what changed, as the site does. What it sends a
 * screen waits there until the test delivers it, so the test chooses who hears what first.
 */
const sharedPage = (agent: Record<string, unknown>, stored: Record<string, unknown> = {}) => {
  const example = examples.find((html) => html.includes('data-control'))!
  const kept = new Map(Object.entries(stored))
  let revision = 1
  /** Whether It refuses the page's writes for good, as it does once the page's state is full. */
  let full = false
  const screens: Screen[] = []
  const whole = () => (kept.size > 0 ? { ...agent, [STORE_KEY]: Object.fromEntries(kept) } : { ...agent })
  const toAll = (message: unknown) => {
    for (const screen of screens) screen.inbox.push(message)
  }
  function openScreen() {
    const { w, later, port, stores, settled } = runExample(example)
    const control = (name: string) => w.document.querySelector(`[data-control="${name}"]`)
    const inbox: unknown[] = [{ type: 'it:state', state: whole(), revision }]
    /** What each field held when the user went into it: a browser says a change was made only when it holds something else when they leave. */
    const atFocus = new Map<unknown, string>()
    let taken = 0
    return {
      inbox,
      control,
      settled,
      /** A while goes by, and whatever the page or It's script meant to do after a while is done. */
      async aWhileLater() {
        for (const [id, { fn }] of [...later]) {
          later.delete(id)
          fn()
        }
        await settled()
      },
      /** Every write this screen has sent, each as the values it set. */
      writes: (): Record<string, unknown>[] =>
        stores().map((m) => Object.fromEntries(m.changes.map(([key, text]: [string, string]) => [key, JSON.parse(text)]))),
      /** The writes it sent that It has not taken yet. */
      untaken() {
        const sent = stores().slice(taken)
        taken += sent.length
        return sent
      },
      /** What It sent this screen arrives, in the order It sent it, and what the page set meanwhile goes out. */
      async hears() {
        while (inbox.length > 0) port.onmessage!({ data: inbox.shift() })
        await settled()
      },
      cards: () => [...w.document.querySelectorAll('#cards li')].map((li: any) => li.textContent),
      saysUnsaved: () => !w.document.getElementById('unsaved').hidden,
      retries: () => w.document.getElementById('retry').click(),
      /** The user chooses in a dropdown, and the browser says so, and that the change is made. */
      chooses(name: string, value: string) {
        const el = control(name)
        el.value = value
        el.dispatchEvent(new w.Event('input', { bubbles: true }))
        el.dispatchEvent(new w.Event('change', { bubbles: true }))
      },
      /** The user types in a field, and is still in it. */
      types(name: string, value: string) {
        const el = control(name)
        if (w.document.activeElement !== el) {
          el.focus()
          atFocus.set(el, el.value)
        }
        el.value = value
        el.dispatchEvent(new w.Event('input', { bubbles: true }))
      },
      /** The user leaves the field: the browser says a change was made, if it holds something else than when they went in, and the field loses the focus. */
      leaves(name: string) {
        const el = control(name)
        if (el.value !== atFocus.get(el)) el.dispatchEvent(new w.Event('change', { bubbles: true }))
        el.blur()
      },
    }
  }
  type Screen = ReturnType<typeof openScreen>
  /** It takes each write this screen has sent, in order. */
  function takes(screen: Screen) {
    for (const { requestId, changes } of screen.untaken()) {
      if (full) {
        screen.inbox.push({ type: 'it:result', requestId, ok: false, error: 'The page has stored as much as it may.' })
        continue
      }
      revision += 1
      const values: [string, unknown][] = changes.map(([key, text]: [string, string]) => [key, JSON.parse(text)])
      for (const [key, value] of values) kept.set(key, value)
      screen.inbox.push({ type: 'it:result', requestId, ok: true, revision })
      toAll({ type: 'it:changed', revision, kept: values })
    }
  }
  return {
    kept,
    takes,
    /** A screen opens the page. It is sent the state as It holds it now, which arrives when the test delivers it. */
    open() {
      const screen = openScreen()
      screens.push(screen)
      return screen
    },
    refuses(refusing: boolean) {
      full = refusing
    },
    /** The agent writes values under `_page`, as `it set` and `it patch` do: each merged into what is kept under its name. */
    agentSets(values: Record<string, unknown>) {
      revision += 1
      const changed: [string, unknown][] = []
      for (const [key, value] of Object.entries(values)) {
        const merged = deepMerge(kept.get(key), value)
        if (merged === undefined) kept.delete(key)
        else kept.set(key, merged)
        changed.push([key, merged ?? null])
      }
      toAll({ type: 'it:changed', revision, state: { ...agent }, kept: changed })
    },
    /** It takes what each screen wrote and every screen hears what it was sent, until nothing more moves. */
    async settles() {
      for (let round = 0; round < 20; round++) {
        for (const screen of screens) {
          await screen.settled()
          takes(screen)
        }
        if (screens.every((screen) => screen.inbox.length === 0)) return
        for (const screen of screens) await screen.hears()
      }
      throw new Error('The screens and It went on writing to each other')
    },
  }
}

describe('the agent skill', () => {
  test('is short, and names each part it leaves out where an agent would want it, by the command that prints it', () => {
    // It is read whole every time, by every agent that uses It: what it once held was 27 KB. It
    // grew by half a kilobyte when it came to say that a page keeps all it shows, and its controls, in its state
    expect(Buffer.byteLength(short)).toBeLessThan(13_000)
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

  test('tells an agent on Windows to run It as it.exe, which Pester’s own It command never answers to, and by its full path where it is not found', () => {
    expect(more.page).toContain('Run It as `it.exe` on Windows, as in `it.exe state board`, and never as a bare `it`.')
    expect(more.page).toContain('"The It command may only be used inside a Describe block"')
    expect(more.page).toContain('`C:/Users/ana/.it/bin/it.exe state board`')
    expect(more.page).toContain('`& "C:/Users/Ana Lee/.it/bin/it.exe" state board`')
    expect(more.page).toContain('in cmd write it in quotes with backslashes')
  })

  test('tells an agent on Windows to give JSON in a file, which Windows PowerShell 5.1 cannot change, and not to pipe it there', () => {
    expect(more.page).toContain('## On Windows')
    expect(more.page).toContain('`it.exe patch board --file ')
    expect(more.page).toContain('`--state-file "<path>"` on `it.exe create`')
    expect(more.page).toContain('in double quotes and with forward slashes')
    expect(more.page).toContain('Do not pipe JSON into It from Windows PowerShell 5.1')
    // The program names the same form in what it says when it refuses such JSON
    expect(main).toContain('it patch $' + '{slug} --file <path>')
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
    expect([...flags.keys()].sort()).toEqual(['ack', 'actions', 'create', 'delete', 'notify', 'open', 'patch', 'save', 'set', 'update', 'wait'])
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
      'urlNote',
      'shownOn',
      'notShown',
      'notShownOn',
      'hint',
      'revision',
      'timedOut',
      'sentByThePageItself',
      'typedByTheUser',
      'pageIsNowAtVersion',
      'stateIsNowAtRevision',
      'forAnotherConversation',
      'files',
      'harnesses',
      'connector',
    ]) {
      expect(skill, field).toContain(field)
      expect(commands, field).toMatch(new RegExp(`\\b${field}\\b`))
    }
    // What `it status` says of an add-on and of the connector
    const setup = source('../../packages/cli/src/setup.ts')
    for (const state of ['connected', 'needs_approval', 'outdated', 'incompatible']) {
      expect(skill).toContain(`"${state}"`)
      expect(setup).toContain(`'${state}'`)
    }
    expect(skill).toContain('`runtime.detail`')
    expect(source('../../packages/cli/src/addon-runtime.ts')).toMatch(/\bdetail: string\b/)
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
    expect(more.actions).toContain('`it save <id> receipt.jpg` writes it to that file')
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
    expect(skill).toContain('Where the one display you named takes nothing now, the command is refused as `it notify` is')
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
    // What the sandbox is: the words the pages' port and the site's frame both say, with nothing
    // that would give a page an origin, and windows that leave it as ordinary tabs
    const protocol = source('../../packages/protocol/src/index.ts')
    const sandbox = /export const SANDBOX = '([^']+)'/.exec(protocol)![1]!
    expect(sandbox.split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox']))
    for (const word of ['allow-same-origin', 'allow-top-navigation']) expect(sandbox).not.toContain(word)
    expect(skill).toContain('It has no cookies.')
    expect(skill).toContain('There is no IndexedDB, no `caches` and no service worker.')
    expect(skill).toContain('A worker starts only from a `blob:` address.')
    expect(skill).toContain('It cannot frame its own files.')
    // A link out opens a tab of its own with no hold either way, which the in-page script sees to
    expect(skill).toContain('A link to another site opens in a new tab.')
    expect(skill).toContain('so `window.open` returns `null`: do not take that for a blocked window. No referrer is sent.')
    expect(skill).toContain("a tab of the page's own files is sandboxed as the page is")
    expect(skill).toContain("call `It.open(url)` in the handler of the user's click or key")
    expect(source('../../packages/runtime/src/it.ts')).toContain('noopener,noreferrer')
    // The in-page script stands in for the two kinds of storage, for as long as the document is open and not after
    const runtime = source('../../packages/runtime/src/it.ts')
    expect(runtime).toMatch(/for \(const name of \['localStorage', 'sessionStorage'\] as const\)/)
    expect(skill).toContain('`localStorage` and `sessionStorage` last only while the page is open.')
    expect(skill).toContain('Anything the page must remember goes in `It.store`.')
    // Only the site may frame what the pages' port sends, so a page cannot frame a file of its own
    expect(source('../../packages/content/src/index.ts')).toMatch(/frame-ancestors \$\{siteAt\(/)
  })

  test('gives the limits a page meets in the numbers the program keeps', () => {
    expect(skill).toContain(
      `A page is at most ${LIMITS.filesPerVersion} files and ${sizeSaid(LIMITS.versionBytes)}, with no file over ${sizeSaid(LIMITS.fileBytes)}.`,
    )
    expect(skill).toContain(`A file's path is at most ${LIMITS.pathLength} bytes.`)
    expect(LIMITS.versionsKept).toBe(10)
    expect(skill).toContain('Ten versions of a page are kept')
    expect(skill).toContain(`It holds ${QUOTA.artifacts} pages and ${sizeSaid(STORAGE.pages.bytes)} of their files in all`)
    expect(skill).toContain(`It always leaves some of its disk free, ${sizeSaid(STORAGE.keepFree.bytes)} unless the user said otherwise`)
    expect(skill).toContain(`State is at most ${LIMITS.stateBytes / 1024} KB of JSON,`)
    expect(skill).toContain(
      `An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB of data, and beside it up to ${LIMITS.actionFiles} files, each at most ${sizeSaid(LIMITS.actionFileBytes)} and ${sizeSaid(LIMITS.actionFilesBytes)} together.`,
    )
    expect(skill).toContain(`It holds ${sizeSaid(STORAGE.actionFiles.bytes)} of files sent from pages in all`)
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
    expect(/const ACTION_PER_SECOND = (\d+)/.exec(frame)![1]).toBe('15')
    expect(skill).toContain(`The site takes ${/const ACTION_BURST = (\d+)/.exec(frame)![1]} actions from a page at once, and then fifteen a second`)
    // What comes too fast for It waits in the browser, up to so many from one page
    expect(/const MAX_PER_PAGE = (\d+)/.exec(source('../../web/src/outbox.ts'))![1]).toBe('100')
    expect(skill).toContain('so its promise resolves late, until 100 actions from the page are waiting')
    // What the page keeps: how often the script in a page writes it, how many values, and that a write coming too fast waits
    expect(1000 / STORE_EVERY_MS).toBe(20)
    expect(skill).toContain('It sends no more than twenty writes a second from one display')
    expect(skill).toContain(`a page keeps at most ${LIMITS.storeKeys.toLocaleString('en-US')} values with \`It.store\``)
    expect(source('../../packages/runtime/src/it.ts')).toMatch(/result\.retryAfterMs !== undefined[\s\S]{0,400}toSend\.set\(key, setting\)/)
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
    expect(main).toMatch(/import \{[^}]*\bforPerson\b[^}]*\} from '\.\/output'/)
    expect(source('../../packages/cli/src/output.ts')).toMatch(
      /const forPerson = \(a: Args\): boolean => process\.stdout\.isTTY === true && a\.flags\.json !== true && sessionAsked\(\) === undefined/,
    )
  })

  test('tells an agent what a display that is not paired means, and how to change state only while it is as it was read', () => {
    // What the command prints of a display it was asked onto and that shows nothing, and the one reason there is
    expect(main).toMatch(/notShownOn\?: \{ display: string; displayId\?: string; reason: string \}\[\]/)
    expect(main).toContain("of('not_paired')")
    expect(skill).toContain('If `notShownOn` is there, it lists each other display with a `reason`.')
    // Every reason the skill names is one the backend gives
    for (const reason of ['not_chosen', 'not_paired', 'agents_off', 'locked']) {
      expect(skill).toContain(`\`${reason}\``)
      expect(source('../../convex/lib/aim.ts')).toContain(`'${reason}'`)
    }
    for (const code of ['agents_off', 'not_paired', 'nowhere']) expect(skill).toContain(`\`${code}\``)
    expect(source('../../convex/notifications.ts')).toContain("notSent: 'nowhere'")
    // A lock is the person's to undo: an agent is told to ask them, and has no command for it
    expect(skill).toContain('No command of yours unlocks it')
    expect(skill).toContain('ask the user to unlock the display')
    // And what a lock does not do, as the docs say: it is navigation only
    expect(skill).toContain("A lock only keeps that display on its page: it does not keep anyone at the display from other pages' state or actions.")
    expect(source('../../docs/screens.md')).toContain('A lock is about navigation and nothing more.')
    // A lock stops pages, and not notifications
    expect(skill).toContain('A locked display still gets notifications')
    expect(source('../../docs/screens.md')).toContain('It still gets notifications. A lock stops agents sending the screen pages, and not notifications')
    expect(main).not.toMatch(/api\.displays\.(lock|unlock)\b/)
    expect(source('../../convex/displays.ts')).toMatch(/paired: await stillPaired\(ctx, d\)/)
    expect(skill).toContain("Each display has `paired`, which is `false` for one whose browser's pairing was ended")
    // The revision `it state` prints is the one `--if-revision` is held to, and a state that has moved on is refused as a conflict
    expect(main).toMatch(/out\(\{ state: parseJson\(s\.json\) \?\? \{\}, revision: s\.revision \}\)/)
    expect(main).toMatch(/const base = text\(a, 'if-revision'\)[\s\S]{0,400}baseRevision: Number\(base\)/)
    expect(source('../../convex/state.ts')).toMatch(/baseRevision !== at\.revision\) fail\('conflict'/)
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
    expect(runtime).toMatch(/let state: State = \{\}/)
    expect(runtime).toMatch(/get: \(key: string\) => \{\s+const kept = keptIn\(state\)/)
    expect(runtime).toMatch(/if \(message\.type === 'it:state'\) \{[\s\S]{0,160}emit\(\)/)
    expect(skill).toContain("It is not there yet when the page's scripts first run")
    expect(skill).toContain('so as the page starts it returns `undefined` even for something that was saved')
    // The example reads what was saved where the state arrives, and saves at every letter, which the script in the page gathers
    const example = /```html\n[\s\S]*?```/.exec(more.page!)![0]
    expect(example).toMatch(/It\.onState\(\(\) => \{[\s\S]{0,80}box\.value = It\.store\.get\('draft'\) \?\? ''/)
    expect(example).toMatch(/box\.addEventListener\('input', \(\) => \{[\s\S]{0,40}save\(\)/)
    expect(example).not.toContain('setTimeout')
  })

  test('its example of a draft, run as it is written, puts back what was saved once and never over what was typed, before the state came or after', async () => {
    // Opened with nothing typed: what was saved is put back, and what is typed after it stays through every later change of the state
    const opened = draftPage()
    opened.arrives({ _page: { draft: 'what was saved' } }, 3)
    expect(opened.box.value).toBe('what was saved')
    opened.types('what was saved, and more')
    opened.arrives({ _page: { draft: 'what was saved' }, status: 'Working' }, 4)
    expect(opened.box.value).toBe('what was saved, and more')
    await opened.settled()
    expect(opened.stored()).toEqual(['what was saved, and more'])
    // Typed into before the state came, which takes a moment: what was typed stays, and it is what is saved
    const early = draftPage()
    early.types('typed before the state came')
    early.arrives({ _page: { draft: 'what was saved' } }, 3)
    expect(early.box.value).toBe('typed before the state came')
    await early.settled()
    expect(early.stored()).toEqual(['typed before the state came'])
  })

  test('the draft example saves at every letter, and what is typed within a moment goes as one write with the last text', async () => {
    const p = draftPage()
    p.arrives({}, 0)
    expect(p.said()).toBe('No unsaved changes.')
    p.types('f')
    p.types('fi')
    p.types('first')
    expect(p.said()).toBe('Saving...')
    await p.settled()
    expect(p.stored()).toEqual(['first'])
    // Typed while that is on its way: sent once it is answered, and only then is the draft saved
    p.types('first words')
    await p.settled()
    expect(p.stored()).toEqual(['first'])
    await p.answer(0, true)
    expect(p.said()).toBe('Saving...')
    expect(p.stored()).toEqual(['first', 'first words'])
    await p.answer(1, true)
    expect(p.said()).toBe('Saved.')
  })

  test('the draft example reports a failed save, preserves its text and retries without another edit', async () => {
    const p = draftPage()
    p.arrives({}, 0)
    p.types('first letter')
    p.types('the whole draft')
    await p.settled()
    expect(p.stored()).toEqual(['the whole draft'])
    expect(p.said()).toBe('Saving...')
    await p.answer(0, false)
    expect(p.box.value).toBe('the whole draft')
    expect(p.said()).toMatch(/^Not saved\. Keep this page open and try again\./)
    expect(p.retry.hidden).toBe(false)
    // A failure does not start an endless retry loop.
    await p.aMomentLater()
    expect(p.stored()).toHaveLength(1)
    p.retry.click()
    p.retry.click()
    await p.settled()
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
    await p.settled()
    // Typed before the older request is answered
    p.types('newest draft')
    await p.settled()
    expect(p.stored()).toEqual(['older draft'])
    await p.answer(0, ok)
    expect(p.box.value).toBe('newest draft')
    expect(p.said()).toBe('Saving...')
    expect(p.retry.hidden).toBe(true)
    expect(p.stored()).toEqual(['older draft', 'newest draft'])
    await p.answer(1, false)
    expect(p.said()).toMatch(/^Not saved\./)
    // Even a repeated answer for the old request cannot clear this edit's failure.
    await p.answer(0, true)
    expect(p.said()).toMatch(/^Not saved\./)
    expect(p.retry.hidden).toBe(false)
    p.retry.click()
    await p.settled()
    await p.answer(2, true)
    expect(p.said()).toBe('Saved.')
    expect(p.box.value).toBe('newest draft')
  })

  test('the draft example saves an edit made during a retry before saying it is saved', async () => {
    const p = draftPage()
    p.types('a draft')
    await p.settled()
    await p.answer(0, false)
    p.retry.click()
    await p.settled()
    p.types('a draft with another sentence')
    // The retry finishes before the new edit is sent
    await p.answer(1, true)
    expect(p.said()).toBe('Saving...')
    expect(p.stored()).toEqual(['a draft', 'a draft', 'a draft with another sentence'])
    await p.answer(2, true)
    expect(p.said()).toBe('Saved.')
  })

  const board = { items: { c1: { title: 'Buy milk', done: true }, c2: { title: 'Call the bank', done: false } }, order: ['c2', 'c1'] }

  test.each(['the first screen', 'the second screen'])(
    'its example of controls stores each as it stands, and shows what the agent sets on every screen, %s hearing it first, writing nothing back',
    async (first) => {
      const page = sharedPage(board)
      const [a, b] = [page.open(), page.open()]
      await page.settles()
      // Opened: each control is stored as it stands, so that the agent sees it, and the list is drawn in its order
      expect(Object.fromEntries(page.kept)).toEqual({ show: 'all', find: '' })
      expect(a.cards()).toEqual(['Call the bank', 'Buy milk'])
      const written = [a.writes().length, b.writes().length]
      // One screen has the field focused, and nothing typed in it: that is no edit to keep
      a.control('find').focus()
      page.agentSets({ show: 'open', find: 'bank' })
      for (const screen of first === 'the first screen' ? [a, b] : [b, a]) await screen.hears()
      await page.settles()
      for (const screen of [a, b]) {
        expect(screen.control('show').value).toBe('open')
        expect(screen.control('find').value).toBe('bank')
        expect(screen.cards()).toEqual(['Call the bank'])
      }
      // The agent's change is one value, and no screen writes another in answer to it
      expect([a.writes().length, b.writes().length]).toEqual(written)
      expect(Object.fromEntries(page.kept)).toEqual({ show: 'open', find: 'bank' })
      // Opened again, it shows what is kept
      const again = page.open()
      await page.settles()
      expect(again.control('show').value).toBe('open')
      expect(again.cards()).toEqual(['Call the bank'])
    },
  )

  test.each([
    ['the user’s', 'milk'],
    ['the agent’s', 'bank'],
  ])('its example of controls, on two screens, ends where %s write saved last', async (last, wins) => {
    const page = sharedPage(board, { show: 'all', find: '' })
    const [a, b] = [page.open(), page.open()]
    await page.settles()
    a.types('find', 'milk')
    a.leaves('find')
    await a.settled()
    if (last === 'the user’s') {
      page.agentSets({ find: 'bank' })
      page.takes(a)
    } else {
      page.takes(a)
      page.agentSets({ find: 'bank' })
    }
    await page.settles()
    expect(page.kept.get('find')).toBe(wins)
    for (const screen of [a, b, page.open()]) {
      await page.settles()
      expect(screen.control('find').value).toBe(wins)
      expect(screen.cards()).toEqual([wins === 'milk' ? 'Buy milk' : 'Call the bank'])
    }
  })

  test('its example of controls keeps what was typed before the state arrived, once the field is left, over the older value', async () => {
    const page = sharedPage(board, { show: 'all', find: 'milk' })
    const a = page.open()
    // Typed and left before the state that was sent as the page opened has arrived
    a.types('find', 'ba')
    a.leaves('find')
    await a.settled()
    page.takes(a)
    await a.hears()
    expect(a.control('find').value).toBe('ba')
    await page.settles()
    expect(a.control('find').value).toBe('ba')
    expect(a.cards()).toEqual(['Call the bank'])
    expect(page.kept.get('find')).toBe('ba')
    const again = page.open()
    await page.settles()
    expect(again.control('find').value).toBe('ba')
  })

  test('its example of controls shows a value the agent set while the user typed once they leave the field, unless they typed after it came', async () => {
    const page = sharedPage(board, { show: 'all', find: '' })
    const [a, b] = [page.open(), page.open()]
    await page.settles()
    a.types('find', 'ba')
    await page.settles()
    page.agentSets({ find: 'milk' })
    await page.settles()
    // The user is still typing: their text stays and draws the list, while the other screen shows the agent's
    expect(a.control('find').value).toBe('ba')
    expect(a.cards()).toEqual(['Call the bank'])
    expect(b.control('find').value).toBe('milk')
    expect(page.kept.get('find')).toBe('milk')
    // They leave the field: the agent's value was saved after theirs, and shows now, with nothing written in answer
    const written = a.writes().length
    a.leaves('find')
    await page.settles()
    expect(a.control('find').value).toBe('milk')
    expect(a.cards()).toEqual(['Buy milk'])
    expect(a.writes().length).toBe(written)
    // They type again after the agent's next value came: theirs is saved after it, and stays
    a.types('find', 'c')
    await page.settles()
    page.agentSets({ find: 'rent' })
    await page.settles()
    a.types('find', 'call')
    a.leaves('find')
    await page.settles()
    for (const screen of [a, b, page.open()]) {
      await page.settles()
      expect(screen.control('find').value).toBe('call')
    }
    expect(page.kept.get('find')).toBe('call')
    // An edit taken back to what the field held is still an edit until they leave, though the browser then says no change was made
    a.types('find', 'callx')
    a.types('find', 'call')
    await page.settles()
    page.agentSets({ find: 'milk' })
    await page.settles()
    expect(a.control('find').value).toBe('call')
    a.leaves('find')
    await page.settles()
    expect(a.control('find').value).toBe('milk')
  })

  test('its example of controls keeps a change It refused for good on the screen, sends it again only when the user asks, and keeps it once saved', async () => {
    const page = sharedPage(board, { show: 'all', find: '' })
    const a = page.open()
    await page.settles()
    page.refuses(true)
    a.chooses('show', 'open')
    await page.settles()
    expect(a.control('show').value).toBe('open')
    expect(a.cards()).toEqual(['Call the bank'])
    expect(a.saysUnsaved()).toBe(true)
    // Nothing sends it again by itself, not even a change of the agent's to something else
    const written = a.writes().length
    page.agentSets({ find: '' })
    await page.settles()
    await a.aWhileLater()
    await page.settles()
    expect(a.writes().length).toBe(written)
    expect(a.control('show').value).toBe('open')
    expect(page.kept.get('show')).toBe('all')
    // The user tries again once It takes it
    page.refuses(false)
    a.retries()
    await page.settles()
    expect(a.writes().length).toBe(written + 1)
    expect(a.saysUnsaved()).toBe(false)
    expect(page.kept.get('show')).toBe('open')
    const again = page.open()
    await page.settles()
    expect(again.control('show').value).toBe('open')
    // A page opened while its state is full stores its controls once, and says so, and stops there
    const fresh = sharedPage(board)
    fresh.refuses(true)
    const opened = fresh.open()
    await fresh.settles()
    await opened.aWhileLater()
    await fresh.settles()
    expect(opened.writes().length).toBe(1)
    expect(opened.saysUnsaved()).toBe(true)
    expect(opened.cards()).toEqual(['Call the bank', 'Buy milk'])
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

  test('says that `it actions --id` lists the newest within a bound, that a short list is not the end, and how to page through the rest by the notes the program prints', () => {
    expect(more.actions).toContain('With `--id <id>` it lists the newest that wait on that one page, and fewer than 50 where they carry a lot')
    expect(more.actions).toContain('a short list there does not mean that nothing older waits')
    expect(more.actions).toContain('answering the newest and stopping can leave older ones unanswered')
    expect(more.actions).toContain('with `it actions --id <id> --after 0`, and then with `--after` set to the `cursor` of the last one listed')
    // The notes it points to are the program's own words: it says older ones wait, how to read them, and that more wait after a page
    const program = source('../../packages/cli/src/watch-actions.ts')
    expect(program).toContain('than these. To read every one, oldest first, run \\`it actions --id ')
    expect(program).toContain(' --after 0\\`, and again with --after set to the cursor of the last one listed.')
    expect(program).toContain('More actions wait after these: run \\`it actions --id ')
  })

  test('says that `it actions` lists what is this conversation’s and what is no conversation’s, that --all lists the rest marked as another’s, and that none of it is a wall between agents', () => {
    expect(more.actions).toContain("`it actions` lists what waits on this conversation's pages, and on pages that no conversation has")
    expect(more.actions).toContain(
      '`it actions --all` lists every action that waits, and marks each that is another conversation\'s with `"forAnotherConversation": true`',
    )
    expect(more.actions).toContain('is not a wall between agents: any agent on the machine can list every action')
    // The program asks for the conversation the command is in, under every id the connector has
    // written down for it, and asks for everything only with --all or where no conversation is named
    expect(main).toMatch(/const ids = asked \? conversationIds\(asked\.session\) : \[\][\s\S]{0,300}api\.delivery\.allWaiting, \{ for: s \}/)
    expect(main).toMatch(/if \(ids\.length && !a\.flags\.all\)/)
    // And the backend reads a conversation's by itself, with what is no conversation's
    expect(source('../../convex/delivery.ts')).toMatch(/export const allWaiting = query\(\{\s+args: \{ for: v\.optional\(session\) \}/)
    expect(source('../../convex/delivery.ts')).toMatch(/\.eq\('harness', undefined\)\.eq\('sessionId', undefined\)/)
    // Where the harness names no conversation, everything is listed, which the skill says
    expect(more.actions).toContain('Where your harness does not tell `it` which conversation this is, `it actions` lists every action')
  })

  test('says that a page is a conversation’s to keep or to take only where the harness names the conversation, and what to do where it does not', () => {
    // With no conversation named, the command does not ask for the page as its own, nothing is taken by opening it, and taking it is refused
    expect(source('../../packages/cli/src/publish.ts')).toContain('...(input.own && !input.take && session ? { own: true } : {})')
    expect(main).toMatch(/const mine = asked\?\.session[\s\S]{0,900}show\(slug, a, mine \? \{ session: mine, agent: mine\.harness \} : \{\}\)/)
    expect(source('../../convex/displays.ts')).toMatch(
      /const took = mine && aimed\.to\.length \? \(await takePage\(ctx, artifact, machine, mine, agent\)\)\.took : false/,
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
    expect(skill).toContain('Run it by that name alone, `it` (on Windows `it.exe`), every time.')
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
