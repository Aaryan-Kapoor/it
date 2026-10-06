// What `it setup` puts into an agent app and takes out again. Each app's own commands are
// stand-ins that keep what the real ones keep (which plugin is installed, and from where), and
// every folder is a temporary one, so nothing here touches an app a person has. What it must
// get right: only what It put there is ever replaced or removed, it is removed from where it
// was put, and an add-on another It folder installed is left to that folder.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { Harness } from '@it/protocol'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ADDONS } from './src/addons.generated'
import { startOf } from './src/serve/backend'
import { AFTER, afterHermes, alone, codexLetsItOut, connect, detectAll, disconnect, reconcile, shim, stampFile, unpack } from './src/setup'

const fake = vi.hoisted(() => ({ execFile: vi.fn(), randomBytes: undefined as ((size: number) => Buffer) | undefined }))
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), execFile: fake.execFile }))
// A test may say which bytes are drawn at random, to know the name a copy is written under
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>()
  return { ...real, randomBytes: (size: number) => fake.randomBytes?.(size) ?? real.randomBytes(size) }
})

let tmp: string
/** The person's own folder, where each app keeps its settings unless it is told otherwise. */
let person: string
/** Every command a stand-in app was given, and what it was told about where its settings are. */
let ran: { bin: string; args: string; env: NodeJS.ProcessEnv }[]
/** Commands a stand-in was given that the real app does not have, or that this file does not know. */
let unknown: string[]
/** What each stand-in app has installed, for each folder it has been told to keep its settings in. */
let kept: Record<string, Map<string, { from?: string; on?: boolean; packages?: Set<string> }>>
/** A command a test has made fail, as `<app> <words>`. */
let failing: string[]

const VERSIONS: Record<string, string> = {
  claude: '2.1.287 (Claude Code)',
  codex: 'codex-cli 0.160.0',
  pi: '0.82.0',
  opencode: '1.18.32',
  openclaw: 'OpenClaw 2026.9.6',
  hermes: 'Hermes Agent v0.21.5',
}
const ID = 'it-bridge@it'

/** Where a stand-in app keeps its settings, going by what it was told and otherwise by the person's own folder. */
const folderOf = (bin: string, env: NodeJS.ProcessEnv = process.env): string =>
  ({
    claude: env.CLAUDE_CONFIG_DIR ?? path.join(person, '.claude'),
    codex: env.CODEX_HOME ?? path.join(person, '.codex'),
    pi: env.PI_CODING_AGENT_DIR ?? path.join(person, '.pi'),
    opencode: path.join(env.XDG_CONFIG_HOME ?? path.join(person, '.config'), 'opencode'),
    openclaw: env.OPENCLAW_STATE_DIR ?? path.join(person, '.openclaw'),
    hermes: env.HERMES_HOME ?? path.join(person, '.hermes'),
  })[bin]!

/** One command of a stand-in app. What it prints, as the real app prints it; it throws where the real one fails. */
function standIn(bin: string, words: string[], env: NodeJS.ProcessEnv): string {
  const said = words.join(' ')
  if (failing.includes(`${bin} ${said}`)) throw new Error('the stand-in was told to fail')
  if (said === '--version') return VERSIONS[bin]!
  const folder = folderOf(bin, env)
  // An app makes its settings folder when it is first asked to keep something there
  mkdirSync(folder, { recursive: true })
  kept[bin] ??= new Map()
  if (!kept[bin].has(folder)) kept[bin].set(folder, {})
  const has = kept[bin].get(folder)!
  if (bin === 'claude') {
    // Claude Code keeps a copy of the plugin, and says where
    const copy = path.join(folder, 'plugins/cache/it/it-bridge/0.1.0')
    if (said === 'plugin list --json')
      return JSON.stringify(has.on === undefined ? [] : [{ id: ID, version: '0.1.0', scope: 'user', enabled: has.on, installPath: copy }])
    if (said === `plugin uninstall ${ID}`) {
      if (has.on === undefined) throw new Error('not installed')
      rmSync(copy, { recursive: true, force: true })
      has.on = undefined
      return ''
    }
    if (said === 'plugin marketplace remove it') {
      if (!has.from) throw new Error('no such marketplace')
      has.from = undefined
      return ''
    }
    if (words.length === 4 && said.startsWith('plugin marketplace add ')) {
      has.from = words[3]
      return ''
    }
    if (said === `plugin install ${ID} --scope user`) {
      if (!has.from) throw new Error('no such marketplace')
      cpSync(path.join(has.from, 'it-bridge'), copy, { recursive: true })
      has.on = true
      return ''
    }
  }
  if (bin === 'codex') {
    // Codex installs from the marketplace's folder, and lists that folder as the plugin's source
    if (said === 'plugin list --marketplace it') {
      if (!has.from) return 'No plugins found in marketplace `it`.'
      const source = path.join(has.from, 'plugins/it-bridge')
      const row = has.on ? `${ID}  installed, enabled  0.1.0    ${source}` : `${ID}  not installed           ${source}`
      return `Marketplace \`it\`\n${path.join(has.from, '.agents/plugins/marketplace.json')}\n\nPLUGIN        STATUS              VERSION  SOURCE\n${row}`
    }
    if (said === `plugin remove ${ID}`) {
      if (!has.on) throw new Error('not installed')
      has.on = undefined
      return ''
    }
    if (said === 'plugin marketplace remove it') {
      if (!has.from) throw new Error('no such marketplace')
      has.from = undefined
      return ''
    }
    if (words.length === 4 && said.startsWith('plugin marketplace add ')) {
      has.from = words[3]
      return ''
    }
    if (said === `plugin add ${ID}`) {
      if (!has.from) throw new Error('no such marketplace')
      has.on = true
      return ''
    }
  }
  if (bin === 'pi') {
    // Pi knows a package by the folder it was installed from, and loads it from there
    has.packages ??= new Set()
    if (said === 'list') return [...has.packages].join('\n')
    if (words.length === 2 && words[0] === 'install') {
      has.packages.add(words[1]!)
      return ''
    }
    if (words.length === 2 && words[0] === 'remove') {
      has.packages.delete(words[1]!)
      return ''
    }
  }
  if (bin === 'opencode' && said === 'debug paths') return `home ${person}\nconfig ${folder}`
  if (bin === 'openclaw') {
    // OpenClaw keeps a copy of the plugin among its extensions, and says where
    const root = path.join(folder, 'extensions/it-bridge')
    if (said === 'plugins inspect it-bridge --json') {
      if (!existsSync(root)) throw new Error('Plugin not found: it-bridge.')
      return JSON.stringify({ plugin: { id: 'it-bridge', enabled: has.on === true, status: 'loaded', rootDir: root } })
    }
    if (words.length === 5 && said.startsWith('plugins install ') && said.endsWith(' --force --accept-capabilities')) {
      rmSync(root, { recursive: true, force: true })
      cpSync(words[2]!, root, { recursive: true })
      return ''
    }
    if (said === 'plugins enable it-bridge --accept-capabilities') {
      has.on = true
      return ''
    }
    if (said === 'plugins uninstall it-bridge --force') {
      rmSync(root, { recursive: true, force: true })
      has.on = undefined
      return ''
    }
  }
  if (bin === 'hermes') {
    // Hermes loads a plugin from its own plugins folder once it is listed as enabled, and its
    // own command for removing one takes that folder away whole
    const plugin = path.join(folder, 'plugins/it-bridge')
    if (said === 'plugins list --json --no-bundled')
      return JSON.stringify(existsSync(path.join(plugin, 'plugin.yaml')) ? [{ name: 'it-bridge', status: has.on ? 'enabled' : 'disabled' }] : [])
    if (said === 'plugins enable it-bridge') {
      has.on = true
      return ''
    }
    if (said === 'plugins disable it-bridge') {
      has.on = false
      return ''
    }
    if (said === 'plugins remove it-bridge') {
      rmSync(plugin, { recursive: true, force: true })
      has.on = undefined
      return ''
    }
  }
  unknown.push(`${bin} ${said}`)
  throw new Error('no such command')
}

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const read = (file: string) => readFileSync(file, 'utf8')
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
/** Every file under a folder, by its name from there, written with forward slashes on every system. */
const under = (dir: string, base = dir): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? under(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]))
        .sort()
    : []
/** Every later command is run for this It folder. */
const useHome = (name: string) => {
  const dir = path.join(tmp, name)
  vi.stubEnv('IT_HOME', dir)
  return dir
}
/** Whether two names are one folder, as the system itself names it: Windows has a short and a long name for the same one. */
const sameFolder = (a: string | undefined, b: string) => {
  if (a === undefined) return false
  try {
    return realpathSync.native(a) === realpathSync.native(b)
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}
/** What this It folder has noted about an app's add-on. */
const noted = (id: Harness) =>
  JSON.parse(read(stampFile(id))) as {
    installs: { version: string; at: number; env: Record<string, string>; dir?: string; files?: { path: string; sha256: string }[] }[]
  }
const statusOf = async (id: Harness) => (await detectAll()).find((h) => h.id === id)
const commands = (bin: string) => ran.filter((r) => r.bin === bin).map((r) => r.args)
const lines = () => {
  const said: string[] = []
  return { said, say: (line: string) => void said.push(line) }
}

/** The apps a second It folder can share a settings folder with, the name of the variable that says where that folder is, and where the add-on's note ends up in it. */
const SHARED: { id: Harness; bin: string; variable: string; note: (folder: string) => string }[] = [
  { id: 'claude-code', bin: 'claude', variable: 'CLAUDE_CONFIG_DIR', note: (f) => path.join(f, 'plugins/cache/it/it-bridge/0.1.0/it-home.json') },
  { id: 'codex', bin: 'codex', variable: 'CODEX_HOME', note: () => path.join(process.env.IT_HOME!, 'addons/codex/plugins/it-bridge/it-home.json') },
  { id: 'opencode', bin: 'opencode', variable: 'XDG_CONFIG_HOME', note: (f) => path.join(f, 'opencode/skills/it/it-home.json') },
  { id: 'hermes', bin: 'hermes', variable: 'HERMES_HOME', note: (f) => path.join(f, 'plugins/it-bridge/it-home.json') },
  { id: 'openclaw', bin: 'openclaw', variable: 'OPENCLAW_STATE_DIR', note: (f) => path.join(f, 'extensions/it-bridge/it-home.json') },
]

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-setup-test-')))
  person = path.join(tmp, 'person')
  mkdirSync(person)
  ran = []
  unknown = []
  kept = {}
  failing = []
  fake.randomBytes = undefined
  // Nothing may reach the folders of whoever runs the tests: every app's settings are looked for under the temporary folder
  vi.spyOn(os, 'homedir').mockReturnValue(person)
  for (const name of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'OPENCLAW_HOME',
    'OPENCLAW_STATE_DIR',
    'OPENCLAW_CONFIG_PATH',
  ])
    vi.stubEnv(name, undefined)
  vi.stubEnv('HERMES_HOME', path.join(person, '.hermes'))
  vi.stubEnv('IT_EXPERIMENTAL', 'openclaw')
  vi.stubEnv('IT_HARNESSES', undefined)
  useHome('it')
  fake.execFile.mockImplementation(
    (bin: string, given: string[], options: { env: NodeJS.ProcessEnv }, done: (err: Error | null, out: string, err2: string) => void) => {
      // On Windows each word is given in quotes, for the shell that starts the app to take off
      const args = process.platform === 'win32' ? given.map((word) => word.replace(/^"(.*)"$/, '$1')) : given
      ran.push({ bin, args: args.join(' '), env: options.env })
      try {
        done(null, standIn(bin, args, options.env), '')
      } catch (err) {
        done(err as Error, '', (err as Error).message)
      }
    },
  )
})
afterEach(() => {
  expect(unknown).toEqual([])
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('an add-on whose files It copies into an app’s folder', () => {
  test.each([
    { id: 'opencode' as const, files: ['plugins/it-bridge.js', 'skills/it/SKILL.md'] },
    { id: 'hermes' as const, files: ['plugins/it-bridge/__init__.py', 'plugins/it-bridge/plugin.yaml', 'skills/it/SKILL.md'] },
  ])('keeps a file that was already in its place beside it under another name, and leaves that copy when it is removed ($id)', async ({ id, files }) => {
    const folder = folderOf(id)
    for (const rel of files) put(path.join(folder, rel), `the person's own ${rel}`)
    const { said, say } = lines()
    expect((await connect(id, say)).addon).toBe('connected')
    for (const rel of files) {
      // The add-on is in, and what was there is beside it, whole
      expect(read(path.join(folder, rel))).not.toContain("the person's own")
      expect(read(path.join(folder, `${rel}.set-aside-by-it`))).toBe(`the person's own ${rel}`)
    }
    // The person is told which files, and where each now is
    const told = said.find((line) => line.includes('set-aside-by-it'))!
    expect(told).toContain(`${files.length} files that It had not put there`)
    for (const rel of files) expect(told).toContain(path.join(folder, `${rel}.set-aside-by-it`))
    expect(await disconnect(id, say)).toBe(true)
    // Only what It put there is gone
    expect(under(folder)).toEqual(files.map((rel) => `${rel}.set-aside-by-it`).sort())
    expect(existsSync(stampFile(id))).toBe(false)
  })

  test('removing Hermes’s add-on leaves everything else the person keeps in the skill’s folder and in the plugin’s', async () => {
    const folder = folderOf('hermes')
    put(path.join(folder, 'skills/it/SKILL.md'), 'a skill of the person’s own')
    put(path.join(folder, 'skills/it/scripts/mine.py'), 'a helper of the person’s own')
    expect((await connect('hermes', () => {})).addon).toBe('connected')
    // The person adds something of their own to the plugin's folder afterwards
    put(path.join(folder, 'plugins/it-bridge/notes.txt'), 'notes')
    expect(await disconnect('hermes', () => {})).toBe(true)
    expect(under(folder)).toEqual(['plugins/it-bridge/notes.txt', 'skills/it/SKILL.md.set-aside-by-it', 'skills/it/scripts/mine.py'])
    expect(read(path.join(folder, 'skills/it/scripts/mine.py'))).toBe('a helper of the person’s own')
    // Hermes's own command for removing a plugin would have taken the notes with it, so the
    // plugin was switched off with Hermes's own command instead
    expect(commands('hermes')).toContain('plugins disable it-bridge')
    expect(commands('hermes')).not.toContain('plugins remove it-bridge')
  })

  test('Hermes’s own command removes the plugin when its folder holds nothing but what It put there, and the skill’s folder goes once it is empty', async () => {
    const folder = folderOf('hermes')
    expect((await connect('hermes', () => {})).addon).toBe('connected')
    expect(under(folder)).toEqual([
      'plugins/it-bridge/LICENSE.md',
      'plugins/it-bridge/__init__.py',
      'plugins/it-bridge/it-home.json',
      'plugins/it-bridge/plugin.yaml',
      'skills/it/SKILL.md',
    ])
    // Python leaves this beside code it has run: it is nobody's file
    put(path.join(folder, 'plugins/it-bridge/__pycache__/__init__.cpython-312.pyc'), 'compiled')
    expect(await disconnect('hermes', () => {})).toBe(true)
    expect(commands('hermes')).toContain('plugins remove it-bridge')
    expect(under(folder)).toEqual([])
    expect(existsSync(path.join(folder, 'skills/it'))).toBe(false)
    // Hermes's own skills folder is never removed
    expect(existsSync(path.join(folder, 'skills'))).toBe(true)
  })

  test('an add-on whose own file the person changed, the one the app loads it from, is left whole and is not said to be gone: the person is told to look at the file, and the note of the add-on is kept', async () => {
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    await connect('opencode', () => {})
    writeFileSync(plugin, `${read(plugin)}\n// the person's own change\n`)
    const { said, say } = lines()
    expect(await disconnect('opencode', say)).toBe(false)
    // OpenCode still loads the changed file, so the skill that tells an agent how to treat what arrives stays with it
    expect(under(folder)).toEqual(['plugins/it-bridge.js', 'skills/it/SKILL.md', 'skills/it/it-home.json'])
    expect(said).toContain(
      `OpenCode: the file that OpenCode loads the add-on from had been changed since It put it there, so the add-on was left in OpenCode as it is. Look at the file, and delete it or move it away to finish: ${plugin}`,
    )
    expect((await statusOf('opencode'))!.addon).toBe('connected')
    expect(noted('opencode').installs[0]!.files!.map((f) => f.path)).toContain(plugin)
    // Once the person has moved it away, the rest is taken out and the add-on is seen to be gone
    rmSync(plugin)
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(under(folder)).toEqual([])
    expect(existsSync(stampFile('opencode'))).toBe(false)
  })

  test('a file of the add-on that the person changed, other than the one the app loads it from, is left where it is while the rest is taken out, and the add-on is not said to be gone', async () => {
    const folder = folderOf('opencode')
    const skill = path.join(folder, 'skills/it/SKILL.md')
    await connect('opencode', () => {})
    writeFileSync(skill, 'the person’s own words')
    const { said, say } = lines()
    expect(await disconnect('opencode', say)).toBe(false)
    expect(under(folder)).toEqual(['skills/it/SKILL.md'])
    expect(said).toContain(
      `OpenCode: one of the add-on’s files had been changed since It put it there, and was left where it is, so the add-on is not all gone from OpenCode. Look at it, and delete it or move it away to finish: ${skill}`,
    )
    expect((await statusOf('opencode'))!.addon).toBe('not_connected')
    // Asked for again, the add-on is put in whole, and the changed file is kept beside it
    expect((await connect('opencode', () => {})).addon).toBe('connected')
    expect(read(`${skill}.set-aside-by-it`)).toBe('the person’s own words')
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(under(folder)).toEqual(['skills/it/SKILL.md.set-aside-by-it'])
  })

  test('a file the person changed after It put it there is kept aside when a newer version of the add-on is installed', async () => {
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    /** Makes what is noted another version's, so that the add-on is installed again. */
    const ofAnother = () => {
      const installs = noted('opencode').installs.map((i) => ({ ...i, version: 'another-version', at: 1 }))
      writeFileSync(stampFile('opencode'), JSON.stringify({ installs }))
    }
    await connect('opencode', () => {})
    writeFileSync(plugin, `${read(plugin)}\n// the person's own change\n`)
    ofAnother()
    // The file as it is now is not what It put there: it is kept, and the add-on is whole beside it
    expect((await connect('opencode', () => {})).addon).toBe('connected')
    expect(read(`${plugin}.set-aside-by-it`)).toContain("the person's own change")
    expect(read(plugin)).not.toContain("the person's own change")
    expect(under(folder)).toEqual(['plugins/it-bridge.js', 'plugins/it-bridge.js.set-aside-by-it', 'skills/it/SKILL.md', 'skills/it/it-home.json'])
    // A second copy kept aside does not write over the first
    writeFileSync(plugin, 'changed again')
    ofAnother()
    await connect('opencode', () => {})
    expect(read(`${plugin}.set-aside-by-it`)).toContain("the person's own change")
    expect(read(`${plugin}.set-aside-by-it-2`)).toBe('changed again')
  })

  test('a newer version replaces the files It put there, keeps aside none of them, and takes away a file It put there that the add-on does not have', async () => {
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    await connect('opencode', () => {})
    // As another version of the add-on left it: other words in the plugin, and a file this version does not have
    const gone = path.join(folder, 'plugins/it-other.js')
    put(plugin, 'another version')
    put(gone, 'a file of another version')
    const before = noted('opencode')
    const other = before.installs[0]!
    other.version = 'another-version'
    other.at = 1
    other.files = [
      ...other.files!.filter((f) => f.path !== plugin),
      { path: plugin, sha256: sha('another version') },
      { path: gone, sha256: sha('a file of another version') },
    ]
    writeFileSync(stampFile('opencode'), JSON.stringify(before))
    const { said, say } = lines()
    expect((await connect('opencode', say)).addon).toBe('connected')
    expect(under(folder)).toEqual(['plugins/it-bridge.js', 'skills/it/SKILL.md', 'skills/it/it-home.json'])
    expect(read(plugin)).toContain('The It add-on for OpenCode')
    expect(said).toEqual(['connecting OpenCode'])
    expect(noted('opencode').installs.map((i) => i.version)).toEqual([ADDONS.opencode!.version])
  })

  test('an install that stops half way leaves a note of every file it wrote, and they are removed with it', async () => {
    const folder = folderOf('hermes')
    failing = ['hermes plugins enable it-bridge']
    expect((await connect('hermes', () => {})).addon).toBe('error')
    expect(noted('hermes').installs[0]!.version).toBe('installing')
    expect(
      noted('hermes')
        .installs[0]!.files!.map((f) => path.relative(folder, f.path).split(path.sep).join('/'))
        .sort(),
    ).toEqual(under(folder))
    failing = []
    expect(await disconnect('hermes', () => {})).toBe(true)
    expect(under(folder)).toEqual([])
  })

  test.each([
    ['cannot be read', 'not a note'],
    ['holds no list of installations', JSON.stringify({ version: 'some-version', at: 1 })],
  ])('an installation whose note %s, and so names none of its files, is put out of the app’s way under another name and not deleted', async (_, note) => {
    const folder = folderOf('opencode')
    put(path.join(folder, 'plugins/it-bridge.js'), '// The It add-on for OpenCode, with words that are not this version’s')
    put(path.join(folder, 'skills/it/SKILL.md'), 'and here')
    put(path.join(folder, 'skills/it/more.md'), 'something the person keeps beside it')
    put(stampFile('opencode'), note)
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(under(folder)).toEqual(['plugins/it-bridge.js.set-aside-by-it', 'skills/it/SKILL.md.set-aside-by-it', 'skills/it/more.md'])
    expect(existsSync(stampFile('opencode'))).toBe(false)
  })

  test('the note of an installation says where it was made and names every file written, with a checksum of each, and is the person’s alone to read', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(tmp, 'settings'))
    const folder = folderOf('opencode')
    await connect('opencode', () => {})
    const [made] = noted('opencode').installs
    expect(made).toMatchObject({ version: ADDONS.opencode!.version, env: { XDG_CONFIG_HOME: path.join(tmp, 'settings') }, dir: folder })
    expect(made!.files!.map((f) => f.path).sort()).toEqual(under(folder).map((rel) => path.join(folder, rel)))
    for (const f of made!.files!) expect(f.sha256).toBe(sha(readFileSync(f.path)))
    if (process.platform !== 'win32') expect(statSync(stampFile('opencode')).mode & 0o777).toBe(0o600)
    // And the note holds its installations and nothing beside them
    expect(Object.keys(noted('opencode'))).toEqual(['installs'])
  })
})

/** A folder's permissions mean nothing to an administrator, and Windows keeps them another way. */
const permissionsHold = process.platform !== 'win32' && process.getuid?.() !== 0

describe('what It writes and removes in an app’s folder', () => {
  test.skipIf(process.platform === 'win32')('is never written through a link, wherever one has been put in its way', async () => {
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    const skill = path.join(folder, 'skills/it/SKILL.md')
    const outside = path.join(tmp, 'outside.txt')
    const another = path.join(tmp, 'another.txt')
    put(outside, 'not the app’s')
    put(another, 'nor is this')
    mkdirSync(path.dirname(plugin), { recursive: true })
    mkdirSync(path.dirname(skill), { recursive: true })
    // One under a name that a copy on its way in might be given, and one where a file of the add-on goes
    symlinkSync(outside, `${plugin}.${process.pid}.part`)
    symlinkSync(another, skill)
    expect((await connect('opencode', () => {})).addon).toBe('connected')
    expect(read(outside)).toBe('not the app’s')
    expect(read(another)).toBe('nor is this')
    expect(lstatSync(plugin).isFile()).toBe(true)
    expect(lstatSync(skill).isFile()).toBe(true)
    // The link that was in the skill's place is kept beside it, as a file would be
    expect(lstatSync(`${skill}.set-aside-by-it`).isSymbolicLink()).toBe(true)
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(read(outside)).toBe('not the app’s')
    expect(read(another)).toBe('nor is this')
  })

  test.skipIf(process.platform === 'win32')(
    'is copied in under a name made new for it, and is not written at all when something has that name already',
    async () => {
      const folder = folderOf('opencode')
      const plugin = path.join(folder, 'plugins/it-bridge.js')
      const outside = path.join(tmp, 'outside.txt')
      put(outside, 'not the app’s')
      // The name is drawn at random. Were it ever one that is taken, by a link or by a file, the copy is not made.
      fake.randomBytes = (size) => Buffer.alloc(size, 0xab)
      const taken = `${plugin}.${'ab'.repeat(12)}.part`
      mkdirSync(path.dirname(plugin), { recursive: true })
      symlinkSync(outside, taken)
      expect((await connect('opencode', () => {})).addon).toBe('error')
      expect(read(outside)).toBe('not the app’s')
      expect(lstatSync(taken).isSymbolicLink()).toBe(true)
      expect(existsSync(plugin)).toBe(false)
      // With a name of its own the copy goes in, and none is left lying beside the file
      fake.randomBytes = undefined
      expect((await connect('opencode', () => {})).addon).toBe('connected')
      expect(under(folder).filter((rel) => rel !== 'plugins/it-bridge.js.abababababababababababab.part')).toEqual([
        'plugins/it-bridge.js',
        'skills/it/SKILL.md',
        'skills/it/it-home.json',
      ])
    },
  )

  test.skipIf(process.platform === 'win32')('goes into the app’s folder when that folder is itself a link to where the person keeps it', async () => {
    const folder = folderOf('opencode')
    const kept = path.join(tmp, 'kept-elsewhere')
    mkdirSync(kept)
    mkdirSync(path.dirname(folder), { recursive: true })
    symlinkSync(kept, folder, 'dir')
    expect((await connect('opencode', () => {})).addon).toBe('connected')
    expect(under(kept)).toEqual(['plugins/it-bridge.js', 'skills/it/SKILL.md', 'skills/it/it-home.json'])
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(under(kept)).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'is not written into a folder inside the app’s that is a link to somewhere else, and then none of the add-on is put in',
    async () => {
      const folder = folderOf('opencode')
      const outside = path.join(tmp, 'outside')
      mkdirSync(outside)
      mkdirSync(folder, { recursive: true })
      symlinkSync(outside, path.join(folder, 'skills'), 'dir')
      const status = await connect('opencode', () => {})
      expect(status.addon).toBe('error')
      expect(status.detail).toContain('is not inside')
      expect(under(outside)).toEqual([])
      expect(existsSync(path.join(folder, 'plugins/it-bridge.js'))).toBe(false)
      expect(noted('opencode').installs[0]!.files ?? []).toEqual([])
    },
  )

  test.skipIf(process.platform === 'win32')('is not removed from a folder of the add-on’s that has since been made a link to somewhere else', async () => {
    const folder = folderOf('opencode')
    await connect('opencode', () => {})
    const skill = path.join(folder, 'skills/it')
    const outside = path.join(tmp, 'outside')
    cpSync(skill, outside, { recursive: true })
    rmSync(skill, { recursive: true })
    symlinkSync(outside, skill, 'dir')
    const { said, say } = lines()
    expect(await disconnect('opencode', say)).toBe(true)
    expect(under(outside)).toEqual(['SKILL.md', 'it-home.json'])
    expect(lstatSync(skill).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(folder, 'plugins/it-bridge.js'))).toBe(false)
    expect(said).toContain(
      `OpenCode: 2 files that It has a note of putting there are not inside OpenCode’s own folder now, and were not touched: ${path.join(skill, 'SKILL.md')}, ${path.join(skill, 'it-home.json')}`,
    )
  })

  test('is never a file outside the app’s folder, whatever the note of the installation names and whatever that file holds', async () => {
    await connect('opencode', () => {})
    const folder = folderOf('opencode')
    const reached = path.join(tmp, 'reached.txt')
    const named = path.join(tmp, 'named.txt')
    put(reached, 'the person’s')
    put(named, 'the person’s')
    const before = noted('opencode')
    // One by a way that leads out of the folder, and one by its own address, each with the right checksum
    before.installs[0]!.files!.push({ path: `${folder}/../../../reached.txt`, sha256: sha('the person’s') }, { path: named, sha256: sha('the person’s') })
    writeFileSync(stampFile('opencode'), JSON.stringify(before))
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(read(reached)).toBe('the person’s')
    expect(read(named)).toBe('the person’s')
    expect(under(folder)).toEqual([])
  })

  test('does not include a file that was there already, though it holds the very words the add-on has: it is kept aside, and is still there when the add-on is gone', async () => {
    const skill = path.join(folderOf('opencode'), 'skills/it/SKILL.md')
    put(skill, ADDONS.opencode!.files['skills/it/SKILL.md']!)
    const { said, say } = lines()
    expect((await connect('opencode', say)).addon).toBe('connected')
    expect(said.join('\n')).toContain(`${skill}.set-aside-by-it`)
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(under(folderOf('opencode'))).toEqual(['skills/it/SKILL.md.set-aside-by-it'])
    expect(read(`${skill}.set-aside-by-it`)).toBe(ADDONS.opencode!.files['skills/it/SKILL.md'])
  })

  test.skipIf(!permissionsHold)(
    'is noted only once it has been written: an install that stops at its first file has a note of none, and its removal takes nothing away',
    async () => {
      const folder = folderOf('opencode')
      const skill = path.join(folder, 'skills/it/SKILL.md')
      put(skill, ADDONS.opencode!.files['skills/it/SKILL.md']!)
      // The plugins folder cannot be written to, so the first file of the add-on cannot be put in
      mkdirSync(path.join(folder, 'plugins'))
      chmodSync(path.join(folder, 'plugins'), 0o500)
      try {
        expect((await connect('opencode', () => {})).addon).toBe('error')
        expect(noted('opencode').installs[0]!.version).toBe('installing')
        expect(noted('opencode').installs[0]!.files ?? []).toEqual([])
        expect(await disconnect('opencode', () => {})).toBe(true)
        expect(read(skill)).toBe(ADDONS.opencode!.files['skills/it/SKILL.md'])
        expect(under(folder)).toEqual(['skills/it/SKILL.md'])
      } finally {
        chmodSync(path.join(folder, 'plugins'), 0o700)
      }
    },
  )

  test.skipIf(!permissionsHold)(
    'an install that stops part of the way still says where each file it kept aside is, and has a note of just the files it wrote',
    async () => {
      const folder = folderOf('opencode')
      const plugin = path.join(folder, 'plugins/it-bridge.js')
      put(plugin, 'the person’s own')
      // The skills folder cannot be written to, so the add-on's second file cannot be put in
      mkdirSync(path.join(folder, 'skills'))
      chmodSync(path.join(folder, 'skills'), 0o500)
      try {
        const { said, say } = lines()
        expect((await connect('opencode', say)).addon).toBe('error')
        expect(said.join('\n')).toContain(`kept beside the add-on, as ${plugin}.set-aside-by-it`)
        expect(noted('opencode').installs[0]!.files!.map((f) => f.path)).toEqual([plugin])
        expect(await disconnect('opencode', () => {})).toBe(true)
        expect(under(folder)).toEqual(['plugins/it-bridge.js.set-aside-by-it'])
      } finally {
        chmodSync(path.join(folder, 'skills'), 0o700)
      }
    },
  )

  test.skipIf(!permissionsHold)(
    'an add-on whose folder cannot be looked into is not taken to be gone: the note of it is kept, the person is told, and it is removed once the folder can be read',
    async () => {
      const folder = folderOf('opencode')
      await connect('opencode', () => {})
      chmodSync(folder, 0o000)
      const { said, say } = lines()
      try {
        expect(await disconnect('opencode', say)).toBe(false)
      } finally {
        chmodSync(folder, 0o700)
      }
      expect(existsSync(stampFile('opencode'))).toBe(true)
      expect(said.join('\n')).toContain(
        'OpenCode: 3 of the add-on’s files could not be looked at or taken out, so they were left as they are and the note of the add-on is kept',
      )
      expect(under(folder)).toEqual(['plugins/it-bridge.js', 'skills/it/SKILL.md', 'skills/it/it-home.json'])
      expect(await disconnect('opencode', () => {})).toBe(true)
      expect(under(folder)).toEqual([])
    },
  )

  test.skipIf(!permissionsHold)('a settings folder that cannot be reached is not taken to have been deleted', async () => {
    const closed = path.join(tmp, 'closed')
    vi.stubEnv('XDG_CONFIG_HOME', path.join(closed, 'settings'))
    await connect('opencode', () => {})
    chmodSync(closed, 0o000)
    const { said, say } = lines()
    try {
      expect(await disconnect('opencode', say)).toBe(false)
    } finally {
      chmodSync(closed, 0o700)
    }
    expect(said).toContain('OpenCode: the folder its add-on was put into could not be looked at, so the add-on was left as it is and the note of it is kept')
    expect(noted('opencode').installs.length).toBe(1)
    expect(await disconnect('opencode', () => {})).toBe(true)
  })

  test('Hermes’s own command, which takes the plugin’s folder away whole, is not used when the person keeps a file of their own where Python keeps what it has run', async () => {
    const folder = folderOf('hermes')
    await connect('hermes', () => {})
    const theirs = path.join(folder, 'plugins/it-bridge/__pycache__/notes.txt')
    put(theirs, 'the person’s own')
    put(path.join(folder, 'plugins/it-bridge/__pycache__/__init__.cpython-312.pyc'), 'compiled')
    expect(await disconnect('hermes', () => {})).toBe(true)
    expect(commands('hermes')).not.toContain('plugins remove it-bridge')
    expect(read(theirs)).toBe('the person’s own')
  })
})

describe('where an add-on was installed', () => {
  test.each(SHARED)('is where it is removed from, though the app has since been pointed at another folder ($id)', async ({ id, bin, variable }) => {
    const first = path.join(tmp, 'first')
    const second = path.join(tmp, 'second')
    vi.stubEnv(variable, first)
    expect((await connect(id, () => {})).addon).toMatch(/^(connected|needs_approval)$/)
    // The person points the app at another folder, which has things of its own under the same names
    vi.stubEnv(variable, second)
    const theirs = [
      path.join(folderOf(bin), 'plugins/it-bridge.js'),
      path.join(folderOf(bin), 'skills/it/SKILL.md'),
      path.join(folderOf(bin), 'plugins/it-bridge/__init__.py'),
    ]
    for (const file of theirs) put(file, 'in the other folder')
    ran = []
    expect(await disconnect(id, () => {})).toBe(true)
    // Every command that took the add-on out was told the folder it was put into
    expect(ran.filter((r) => r.args !== '--version').map((r) => r.env[variable])).toEqual(ran.filter((r) => r.args !== '--version').map(() => first))
    // The other folder is as it was, and nothing of the add-on is left in the first
    for (const file of theirs) expect(read(file)).toBe('in the other folder')
    vi.stubEnv(variable, first)
    expect((await statusOf(id))!.addon).toBe('not_connected')
    expect(under(folderOf(bin)).filter((rel) => rel.includes('it-bridge') || rel.includes('skills/it'))).toEqual([])
    expect(existsSync(stampFile(id))).toBe(false)
  })

  test('is not guessed for an installation whose note cannot be read, and so does not say it: a folder with no add-on of It’s in it is left as it is, and the note is kept', async () => {
    const first = path.join(tmp, 'first')
    vi.stubEnv('XDG_CONFIG_HOME', first)
    await connect('opencode', () => {})
    const installed = path.join(folderOf('opencode'), 'plugins/it-bridge.js')
    // The note is there and says nothing that can be read, and the add-on's own note of where it came from is gone
    put(stampFile('opencode'), 'not a note')
    rmSync(path.join(folderOf('opencode'), 'skills/it/it-home.json'))
    // OpenCode is pointed at another folder since, where the person keeps a plugin of their own under the same name
    vi.stubEnv('XDG_CONFIG_HOME', path.join(tmp, 'second'))
    const theirs = path.join(folderOf('opencode'), 'plugins/it-bridge.js')
    put(theirs, 'a plugin of the person’s own')
    const { said, say } = lines()
    expect(await disconnect('opencode', say)).toBe(false)
    expect(read(theirs)).toBe('a plugin of the person’s own')
    expect(under(path.join(tmp, 'second'))).toEqual(['opencode/plugins/it-bridge.js'])
    expect(existsSync(installed)).toBe(true)
    expect(existsSync(stampFile('opencode'))).toBe(true)
    expect(said).toContain(
      'OpenCode: It has a note of putting its add-on there that does not say where OpenCode kept its settings then, and no add-on of It’s is where OpenCode keeps them now. Nothing was touched, and the note is kept',
    )
    // Pointed back at the folder the add-on is in, it is found and put out of OpenCode's way
    vi.stubEnv('XDG_CONFIG_HOME', first)
    expect(await disconnect('opencode', () => {})).toBe(true)
    expect(existsSync(installed)).toBe(false)
    expect(existsSync(`${installed}.set-aside-by-it`)).toBe(true)
  })

  test('is not guessed for an installation whose note cannot be read in an app that removes its own add-ons: an app that has none where it keeps its settings now is asked to remove nothing', async () => {
    const first = path.join(tmp, 'first')
    vi.stubEnv('CLAUDE_CONFIG_DIR', first)
    await connect('claude-code', () => {})
    put(stampFile('claude-code'), 'not a note')
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(tmp, 'second'))
    ran = []
    expect(await disconnect('claude-code', () => {})).toBe(false)
    expect(commands('claude').filter((said) => /uninstall|remove/.test(said))).toEqual([])
    expect(kept.claude!.get(first)!.on).toBe(true)
    expect(existsSync(stampFile('claude-code'))).toBe(true)
    vi.stubEnv('CLAUDE_CONFIG_DIR', first)
    expect(await disconnect('claude-code', () => {})).toBe(true)
    expect(kept.claude!.get(first)!.on).toBe(undefined)
  })

  test('is noted by its whole address, though the app was told it by one that depends on where the command was run', async () => {
    const whole = path.join(tmp, 'settings-of-claude')
    // As it is written from where the tests run, so that it leads into the temporary folder
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.relative(process.cwd(), whole))
    await connect('claude-code', () => {})
    expect(noted('claude-code').installs[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: whole })
    // Run from somewhere else afterwards, the removal still goes to where the add-on was put
    vi.spyOn(process, 'cwd').mockReturnValue(person)
    ran = []
    expect(await disconnect('claude-code', () => {})).toBe(true)
    expect(ran.filter((r) => r.args !== '--version').map((r) => r.env.CLAUDE_CONFIG_DIR)).toEqual(ran.filter((r) => r.args !== '--version').map(() => whole))
    expect(kept.claude!.get(whole)!.on).toBe(undefined)
  })

  test('is where Pi is told to remove its add-on from, though Pi has since been pointed at another folder', async () => {
    const first = path.join(tmp, 'first')
    vi.stubEnv('PI_CODING_AGENT_DIR', first)
    expect((await connect('pi', () => {})).addon).toBe('connected')
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(tmp, 'second'))
    ran = []
    expect(await disconnect('pi', () => {})).toBe(true)
    expect(ran.filter((r) => r.args !== '--version').map((r) => r.env.PI_CODING_AGENT_DIR)).toEqual([first, first])
    expect([...kept.pi!.get(first)!.packages!]).toEqual([])
  })

  test('may have been deleted since, add-on and all: the app is then asked nothing about that folder, and the note of the installation goes', async () => {
    const first = path.join(tmp, 'first')
    vi.stubEnv('CLAUDE_CONFIG_DIR', first)
    await connect('claude-code', () => {})
    rmSync(first, { recursive: true })
    ran = []
    expect(await disconnect('claude-code', () => {})).toBe(true)
    // Asked about a folder that is gone, Claude Code would make it anew
    expect(commands('claude')).toEqual(['--version'])
    expect(existsSync(first)).toBe(false)
    expect(existsSync(stampFile('claude-code'))).toBe(false)
  })

  test('is noted for each folder an app has been connected in, and the add-on is removed from each', async () => {
    const first = path.join(tmp, 'first')
    const second = path.join(tmp, 'second')
    vi.stubEnv('CLAUDE_CONFIG_DIR', first)
    await connect('claude-code', () => {})
    vi.stubEnv('CLAUDE_CONFIG_DIR', second)
    // In the second folder nothing is installed yet, whatever was noted for the first
    expect((await statusOf('claude-code'))!.addon).toBe('not_connected')
    expect((await connect('claude-code', () => {})).addon).toBe('connected')
    expect(noted('claude-code').installs.map((i) => i.env)).toEqual([{ CLAUDE_CONFIG_DIR: first }, { CLAUDE_CONFIG_DIR: second }])
    expect(await disconnect('claude-code', () => {})).toBe(true)
    expect([...kept.claude!.values()].map((has) => has.on)).toEqual([undefined, undefined])
  })

  test('stays noted for a folder the add-on could not be removed from, when it has gone from another', async () => {
    const first = path.join(tmp, 'first')
    const second = path.join(tmp, 'second')
    vi.stubEnv('CLAUDE_CONFIG_DIR', first)
    await connect('claude-code', () => {})
    vi.stubEnv('CLAUDE_CONFIG_DIR', second)
    await connect('claude-code', () => {})
    // Claude Code will not take the plugin out of the first folder just now
    const real = fake.execFile.getMockImplementation()!
    fake.execFile.mockImplementation(
      (bin: string, given: string[], options: { env: NodeJS.ProcessEnv }, done: (err: Error | null, out: string, err2: string) => void) => {
        // On Windows each word is given in quotes, for the shell that starts the app to take off
        const words = (process.platform === 'win32' ? given.map((word) => word.replace(/^"(.*)"$/, '$1')) : given).join(' ')
        return words === `plugin uninstall ${ID}` && sameFolder(options.env.CLAUDE_CONFIG_DIR, first)
          ? done(new Error('busy'), '', 'busy')
          : real(bin, given, options, done)
      },
    )
    expect(await disconnect('claude-code', () => {})).toBe(false)
    expect(noted('claude-code').installs.map((i) => sameFolder(i.env?.CLAUDE_CONFIG_DIR, first))).toEqual([true])
    // The files the first folder's plugin is installed from are kept for as long as it is
    expect(existsSync(path.join(process.env.IT_HOME!, 'addons/claude-code/it-bridge'))).toBe(true)
    fake.execFile.mockImplementation(real)
    expect(await disconnect('claude-code', () => {})).toBe(true)
    expect(existsSync(stampFile('claude-code'))).toBe(false)
  })
})

describe('two It folders connected to one app', () => {
  test.each(SHARED)(
    'an add-on carries a note of the It folder that installed it, and the other folder neither replaces nor removes it ($id)',
    async ({ id, bin, variable, note }) => {
      const shared = path.join(tmp, 'shared')
      vi.stubEnv(variable, shared)
      const first = useHome('it-first')
      expect((await connect(id, () => {})).addon).toMatch(/^(connected|needs_approval)$/)
      const where = note(shared)
      expect(JSON.parse(read(where)).home).toBe(first)
      const before = under(shared)

      // A second It folder finds the app already connected to the first
      const second = useHome('it-second')
      const found = (await statusOf(id))!
      expect(found.addon).toBe('unavailable')
      // What is said of it may be shown on the site, and names no folder
      expect(found.detail).toMatch(/has It’s add-on from another It folder on this machine\. It stays with that folder until it is disconnected there\.$/)
      expect(found.detail).not.toContain(tmp)
      const { said, say } = lines()
      expect((await connect(id, say)).addon).toBe('unavailable')
      expect(said.join('\n')).toContain(`was installed from the It folder at ${first}, and was left as it is`)
      // The person is told the command that takes it out of the other folder
      expect(said.join('\n')).toMatch(
        /take it out of that one first: run `it setup --none` with IT_HOME set to that folder, which takes out every add-on that folder put in\.$/,
      )
      expect(await disconnect(id, say)).toBe(true)
      expect(JSON.parse(read(where)).home).toBe(first)
      expect(under(shared)).toEqual(before)
      expect(existsSync(path.join(second, 'addons', `${id}.json`))).toBe(false)

      // Only the folder that installed it takes it out
      useHome('it-first')
      expect((await statusOf(id))!.addon).toMatch(/^(connected|needs_approval)$/)
      expect(await disconnect(id, () => {})).toBe(true)
      expect((await statusOf(id))!.addon).toBe('not_connected')
      expect(under(folderOf(bin)).filter((rel) => rel.includes('it-bridge') || rel.includes('skills/it'))).toEqual([])
    },
  )

  test.each(SHARED)(
    'an add-on whose It folder has no note of it any more is taken over, and the person is told that it now belongs to this folder ($id)',
    async ({ id, variable, note }) => {
      const shared = path.join(tmp, 'shared')
      vi.stubEnv(variable, shared)
      const first = useHome('it-first')
      await connect(id, () => {})
      // The first folder forgets the installation: its note is gone, as when the folder was emptied by hand
      rmSync(stampFile(id))
      const second = useHome('it-second')
      // Nobody's add-on is not this folder's connection
      expect((await statusOf(id))!.addon).toBe('not_connected')
      const { said, say } = lines()
      expect((await connect(id, say)).addon).toMatch(/^(connected|needs_approval)$/)
      expect(said.join('\n')).toContain(`came from the It folder at ${first}, which has no note of it any more. It now belongs to this It folder, at ${second}`)
      expect(JSON.parse(read(note(shared))).home).toBe(second)

      // The first folder, were it to have a note of the installation again, finds that the add-on is another folder's to remove
      useHome('it-first')
      put(stampFile(id), JSON.stringify({ installs: [{ version: 'some-version', at: 1 }] }))
      const again = lines()
      expect(await disconnect(id, again.say)).toBe(true)
      expect(again.said.join('\n')).toContain(`now belongs to the It folder at ${second}, and was left as it is`)
      useHome('it-second')
      expect((await statusOf(id))!.addon).toMatch(/^(connected|needs_approval)$/)
    },
  )

  test('a note in an add-on that names an It folder with no installation of it on record does not make the add-on that folder’s', async () => {
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    const note = path.join(folder, 'skills/it/it-home.json')
    await connect('opencode', () => {})
    // The note is changed to name a folder that has a file where its record would be, and nothing in it
    const named = path.join(tmp, 'names-no-installation')
    put(path.join(named, 'addons/opencode.json'), '{}')
    put(note, JSON.stringify({ home: named }))
    // Taken out, the add-on is removed by the folder that has it on record, which does not forget it while the changed note is there
    const { said, say } = lines()
    expect(await disconnect('opencode', say)).toBe(false)
    expect(existsSync(plugin)).toBe(false)
    expect(said.join('\n')).toContain(
      `was left where it is, so the add-on is not all gone from OpenCode. Look at it, and delete it or move it away to finish: ${note}`,
    )
    expect(existsSync(stampFile('opencode'))).toBe(true)
    // Asked for again, it is put back whole, and the person is told what became of the note
    const again = lines()
    expect((await connect('opencode', again.say)).addon).toBe('connected')
    expect(JSON.parse(read(note)).home).toBe(process.env.IT_HOME)
    expect(JSON.parse(read(`${note}.set-aside-by-it`)).home).toBe(named)
  })

  test.skipIf(!permissionsHold)('an add-on that names another It folder stays that folder’s when its record cannot be looked at', async () => {
    const shared = path.join(tmp, 'shared')
    vi.stubEnv('XDG_CONFIG_HOME', shared)
    const first = useHome('it-first')
    await connect('opencode', () => {})
    useHome('it-second')
    chmodSync(path.join(first, 'addons'), 0o000)
    try {
      expect((await statusOf('opencode'))!.addon).toBe('unavailable')
      expect((await connect('opencode', () => {})).addon).toBe('unavailable')
    } finally {
      chmodSync(path.join(first, 'addons'), 0o700)
    }
    expect(JSON.parse(read(path.join(shared, 'opencode/skills/it/it-home.json'))).home).toBe(first)
  })

  test('each keep an add-on of their own in one Pi, which knows an add-on by the folder it came from, and each removes only its own', async () => {
    const first = useHome('it-first')
    expect((await connect('pi', () => {})).addon).toBe('connected')
    const second = useHome('it-second')
    expect((await statusOf('pi'))!.addon).toBe('not_connected')
    expect((await connect('pi', () => {})).addon).toBe('connected')
    const packages = kept.pi!.get(folderOf('pi'))!.packages!
    expect([...packages]).toEqual([path.join(first, 'addons/pi'), path.join(second, 'addons/pi')])
    useHome('it-first')
    expect(await disconnect('pi', () => {})).toBe(true)
    expect([...packages]).toEqual([path.join(second, 'addons/pi')])
  })

  test('an add-on that says it came from this It folder is this folder’s again, though the folder has lost its note of installing it', async () => {
    await connect('claude-code', () => {})
    rmSync(stampFile('claude-code'))
    const { said, say } = lines()
    expect((await connect('claude-code', say)).addon).toBe('connected')
    // Nothing is said of replacing someone else's: it is its own
    expect(said).toEqual(['connecting Claude Code'])
    expect(existsSync(stampFile('claude-code'))).toBe(true)
  })

  test('an add-on under It’s name that no It folder has a note of is replaced, and the person is told so', async () => {
    // Installed, and nothing inside it to say from where
    const elsewhere = path.join(tmp, 'elsewhere')
    put(path.join(elsewhere, 'it-bridge/hooks/register.js'), 'an add-on from somewhere else')
    kept.claude = new Map([[folderOf('claude'), { from: elsewhere, on: true }]])
    const { said, say } = lines()
    expect((await connect('claude-code', say)).addon).toBe('connected')
    expect(said).toContain(
      'Claude Code: it already had an add-on under It’s name that this It folder has no note of installing, and that add-on is replaced by this folder’s',
    )
    // What it was installed from is not touched
    expect(read(path.join(elsewhere, 'it-bridge/hooks/register.js'))).toBe('an add-on from somewhere else')
  })
})

describe('the lock one program holds while it changes what is installed', () => {
  const lock = () => path.join(process.env.IT_HOME!, 'addons', 'setup.lock')
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /** A process number that no process has, and a process that lives: the one this one was started by. */
  const NOBODY = 999_999_999
  const ALIVE = process.ppid
  const beside = () => readdirSync(path.dirname(lock()))
  /** A lock as one is made on this machine, learnt by holding it for a moment. */
  const aLock = async () => {
    let made: Record<string, unknown> = {}
    await alone(async () => {
      made = JSON.parse(readFileSync(lock(), 'utf8'))
    })
    return made
  }
  /** The lock as a program that is gone left it, and as a program that lives holds it. */
  const leftBehind = (shape: Record<string, unknown>) => JSON.stringify({ ...shape, pid: NOBODY, started: 'never', holder: 'a'.repeat(16) })
  const heldByAnother = (shape: Record<string, unknown>, holder = 'b'.repeat(16)) =>
    JSON.stringify({ ...shape, pid: ALIVE, started: startOf(ALIVE) || '', holder })
  /** Work done under the lock that says how many were at it together, and waits to be let go. */
  const atWork = () => {
    const seen = { inside: 0, most: 0, done: 0 }
    const letGo: (() => void)[] = []
    const work = async () => {
      seen.most = Math.max(seen.most, ++seen.inside)
      await new Promise<void>((go) => letGo.push(go))
      seen.inside--
      seen.done++
    }
    return { seen, work, letGo }
  }

  test('names its holder from the moment it is there, is let go when the work is done, and leaves nothing beside it', async () => {
    let held = { pid: 0 }
    expect(
      await alone(async () => {
        held = JSON.parse(readFileSync(lock(), 'utf8'))
        return 'done'
      }),
    ).toBe('done')
    expect([held.pid, beside()]).toEqual([process.pid, []])
    // Let go as well when the work fails
    await expect(
      alone(async () => {
        throw new Error('the work failed')
      }),
    ).rejects.toThrow('the work failed')
    expect(beside()).toEqual([])
  })

  test('is given its name only once it is whole: it is written under another name first, and nothing is ever under its own name that names no holder', async () => {
    // Whom the lock named at the moment it was given its name, and whether anything had that name then
    const given: { pid: unknown; there: boolean }[] = []
    const real = fs.linkSync
    fs.linkSync = ((from: string, to: string) => {
      if (path.basename(to) === 'setup.lock') given.push({ pid: JSON.parse(readFileSync(from, 'utf8')).pid, there: existsSync(to) })
      return real(from, to)
    }) as typeof fs.linkSync
    syncBuiltinESMExports()
    try {
      await alone(async () => {})
    } finally {
      fs.linkSync = real
      syncBuiltinESMExports()
    }
    expect(given).toEqual([{ pid: process.pid, there: false }])
  })

  test('one left behind by a program that is gone is taken over, and nothing of the taking is left beside it', async () => {
    writeFileSync(lock(), leftBehind(await aLock()))
    let held = { pid: 0 }
    await alone(async () => {
      held = JSON.parse(readFileSync(lock(), 'utf8'))
    })
    expect([held.pid, beside()]).toEqual([process.pid, []])
  })

  test('one whose holder lives is that holder’s for as long as it takes: whoever waits for it gives up after the time it was given and says so, and the lock is as it was', async () => {
    const theirs = heldByAnother(await aLock())
    writeFileSync(lock(), theirs)
    // Held since long ago: how long a lock has been there says nothing of whether its holder is gone
    const longAgo = new Date(Date.now() - 3_600_000)
    utimesSync(lock(), longAgo, longAgo)
    let worked = false
    const refused = await alone(async () => {
      worked = true
    }, 700).then(
      () => undefined,
      (err: { code?: string; message?: string; hint?: string }) => ({ code: err.code, message: err.message, hint: err.hint }),
    )
    expect(refused).toEqual({
      code: 'busy',
      message: 'Another `it` is still changing It’s add-ons in the agent apps on this machine.',
      hint: 'Run this again when it has finished.',
    })
    expect([worked, readFileSync(lock(), 'utf8')]).toEqual([false, theirs])
    // Its holder lets it go, and the next to come has it
    rmSync(lock())
    await alone(async () => {
      worked = true
    }, 700)
    expect(worked).toBe(true)
  })

  test('while one program is in the middle of taking over a lock that was left behind, two more that come for it both wait, and the three have it one after another', async () => {
    const shape = await aLock()
    // A lock that was left, and a first program that has said, in the one way only one can, that it is the one to replace it
    const left = leftBehind(shape)
    const taking = heldByAnother(shape, 'c'.repeat(16))
    writeFileSync(lock(), left)
    writeFileSync(`${lock()}.after.${'a'.repeat(16)}`, taking)
    // Every try at making the lock, which is the one step by which it can be had
    let tries = 0
    const real = fs.linkSync
    fs.linkSync = ((from: string, to: string) => {
      if (to === lock()) tries++
      return real(from, to)
    }) as typeof fs.linkSync
    syncBuiltinESMExports()
    /** Waits until the lock has been tried for so many times more, by the two that wait for it. */
    const triedAgain = async (times: number) => {
      const from = tries
      await vi.waitFor(() => expect(tries - from).toBeGreaterThanOrEqual(times), { timeout: 20_000, interval: 20 })
    }
    try {
      const { seen, work, letGo } = atWork()
      const second = alone(work, 60_000)
      const third = alone(work, 60_000)
      // Each of the two comes for it again and again meanwhile, and neither has it
      await triedAgain(6)
      expect([seen.inside, readFileSync(lock(), 'utf8')]).toEqual([0, left])
      // The first puts its own lock in the place of the one that was left, and has it
      writeFileSync(`${lock()}.first`, taking)
      renameSync(`${lock()}.first`, lock())
      rmSync(`${lock()}.after.${'a'.repeat(16)}`)
      await triedAgain(6)
      expect([seen.inside, readFileSync(lock(), 'utf8')]).toEqual([0, taking])
      // And lets it go when its work is done: the other two have it, one and then the other
      rmSync(lock())
      await vi.waitFor(() => expect(letGo.length).toBe(1), { timeout: 20_000 })
      // The one that has not got it goes on trying, and still has not
      await triedAgain(3)
      expect([seen.inside, letGo.length]).toEqual([1, 1])
      letGo[0]!()
      await vi.waitFor(() => expect(letGo.length).toBe(2), { timeout: 20_000 })
      expect(seen.inside).toBe(1)
      letGo[1]!()
      await Promise.all([second, third])
      expect([seen.most, seen.done, beside()]).toEqual([1, 2, []])
    } finally {
      fs.linkSync = real
      syncBuiltinESMExports()
    }
  }, 120_000)

  test('three programs that come at the same moment for a lock that was left behind have it one after another, and never two of them at once', async () => {
    const shape = await aLock()
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-three-'))
    const script = path.join(scratch, 'contender.mjs')
    // What each of the three runs: it says that it is ready, waits for the word to go, and does its work under the lock
    await build({
      stdin: {
        contents: `
          import fs from 'node:fs'
          import { alone } from ${JSON.stringify(path.join(__dirname, 'src/setup'))}
          const [tally, go] = process.argv.slice(2)
          process.stdout.write('ready\\n')
          while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2))
          await alone(async () => {
            fs.appendFileSync(tally, 'in ' + process.pid + '\\n')
            await new Promise((r) => setTimeout(r, 40))
            fs.appendFileSync(tally, 'out ' + process.pid + '\\n')
          })
        `,
        resolveDir: __dirname,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: script,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
    try {
      for (let round = 0; round < 5; round++) {
        const [tally, go] = [path.join(scratch, `tally-${round}`), path.join(scratch, `go-${round}`)]
        writeFileSync(lock(), leftBehind(shape))
        const contenders = Array.from({ length: 3 }, () => {
          const child = spawn(process.execPath, [script, tally, go], {
            env: { PATH: process.env.PATH, IT_HOME: process.env.IT_HOME },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let said = ''
          child.stdout.on('data', (piece: Buffer) => (said += piece))
          child.stderr.on('data', (piece: Buffer) => (said += piece))
          return {
            child,
            ready: () => said.includes('ready'),
            said: () => said,
            ended: new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
          }
        })
        // All three are there before any of them comes for the lock
        await vi.waitFor(() => expect(contenders.every((c) => c.ready())).toBe(true), { timeout: 30_000 })
        writeFileSync(go, '')
        expect([round, await Promise.all(contenders.map((c) => c.ended)), contenders.map((c) => c.said().replace('ready\n', ''))]).toEqual([
          round,
          [0, 0, 0],
          ['', '', ''],
        ])
        // Each came in and went out again before the next came in
        const lines = readFileSync(tally, 'utf8').trim().split('\n')
        const pids = contenders.map((c) => String(c.child.pid)).sort()
        expect([
          round,
          lines.length,
          lines
            .filter((line) => line.startsWith('in '))
            .map((line) => line.slice(3))
            .sort(),
        ]).toEqual([round, 6, pids])
        for (let n = 0; n < lines.length; n += 2) expect([round, lines[n + 1]]).toEqual([round, lines[n]!.replace(/^in /, 'out ')])
        expect([round, beside()]).toEqual([round, []])
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  test('many that want it at the same moment each have it by themselves, one after another', async () => {
    let inside = 0
    let most = 0
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        alone(async () => {
          most = Math.max(most, ++inside)
          await pause(20)
          order.push(n)
          inside--
        }),
      ),
    )
    expect([most, order.length, existsSync(lock())]).toEqual([1, 6, false])
  }, 30_000)
})

describe('what the connector writes down about installing and removing', () => {
  test('names no folder and no file, whatever was kept aside, left behind or belongs to another It folder', async () => {
    vi.stubEnv('IT_HARNESSES', 'opencode,claude-code')
    const folder = folderOf('opencode')
    const plugin = path.join(folder, 'plugins/it-bridge.js')
    put(plugin, 'the person’s own')
    const { said, say } = lines()
    await reconcile(['opencode'], say, true)
    writeFileSync(plugin, 'changed by the person')
    await reconcile([], say, true)
    expect(said).toEqual([
      'connecting OpenCode',
      'OpenCode: one file that It had not put there, or that had been changed since, was kept beside the add-on under another name',
      'disconnecting OpenCode',
      'OpenCode: the file that OpenCode loads the add-on from had been changed since It put it there, so the add-on was left in OpenCode as it is',
    ])
    // The person moves the changed file away, and the add-on is then seen to be gone
    rmSync(plugin)
    await reconcile([], say, true)
    expect(existsSync(stampFile('opencode'))).toBe(false)
    // Another It folder's add-on, met while connecting and while disconnecting
    const first = useHome('it-first')
    await connect('claude-code', () => {})
    useHome('it')
    said.length = 0
    await reconcile(['claude-code'], say, true)
    put(stampFile('claude-code'), JSON.stringify({ installs: [{ version: 'some-version', at: 1 }] }))
    await reconcile([], say, true)
    expect(said).toEqual([
      'Claude Code: its add-on belongs to another It folder, and was left as it is',
      'disconnecting Claude Code',
      'Claude Code: the add-on in it now belongs to another It folder, and was left as it is',
    ])
    // And one taken over from an It folder that has forgotten it
    rmSync(path.join(first, 'addons/claude-code.json'))
    said.length = 0
    await reconcile(['claude-code'], say, true)
    expect(said).toEqual([
      'connecting Claude Code',
      'Claude Code: the add-on in it came from an It folder that has no note of it any more, and now belongs to this one',
    ])
    for (const line of said) expect(line).not.toContain(tmp)
  })

  test('says what went wrong as one of the system’s own codes or the word "error", and never in an error’s own name, code or words', async () => {
    vi.stubEnv('IT_HARNESSES', 'opencode')
    const failsWith = (code: string) =>
      fake.execFile.mockImplementation(() => {
        throw Object.assign(new Error('could not start /home/PRIVATE PERSON/bin/opencode'), { name: 'PRIVATE NAME', code })
      })
    const { said, say } = lines()
    failsWith('PRIVATE CODE')
    await reconcile(['opencode'], say, true)
    failsWith('EACCES')
    await reconcile(['opencode'], say, true)
    expect(said).toEqual(['OpenCode: error', 'OpenCode: EACCES'])
    // At a terminal the person is shown the error's own words
    await reconcile(['opencode'], say)
    expect(said[2]).toBe('OpenCode: could not start /home/PRIVATE PERSON/bin/opencode')
  })
})

describe('what a person is told about an app', () => {
  test('that is too old says which version is needed, which was found, and what to do', async () => {
    VERSIONS.claude = '2.1.100 (Claude Code)'
    try {
      expect(await statusOf('claude-code')).toEqual({
        id: 'claude-code',
        version: '2.1.100',
        addon: 'too_old',
        detail: 'It needs Claude Code 2.1.287 or newer, and this one is 2.1.100. Update Claude Code, then run `it setup` again.',
      })
    } finally {
      VERSIONS.claude = '2.1.287 (Claude Code)'
    }
  })

  test('whose add-on they switched off inside it says so, and is not switched on again for them', async () => {
    await connect('hermes', () => {})
    standIn('hermes', ['plugins', 'disable', 'it-bridge'], process.env)
    const status = await connect('hermes', () => {})
    expect(status).toMatchObject({
      addon: 'not_connected',
      detail:
        'It’s add-on is switched off inside Hermes Agent. Switch it on there, or untick Hermes Agent here and tick it again to have the add-on installed afresh.',
    })
    expect(commands('hermes').filter((said) => said === 'plugins enable it-bridge').length).toBe(1)
  })

  test('after connecting Hermes says only what the Hermes that was found can do', async () => {
    // The released Hermes takes a plugin's message in the plain terminal and nowhere else: nothing is said of a setting that would change nothing
    await detectAll()
    expect(AFTER.hermes).toBe(afterHermes('0.21.5'))
    // What everyone has to do comes first and on a line of its own
    expect(afterHermes('0.21.5').split('\n')).toEqual([
      'If Hermes is open, restart it. What you do on a page then arrives by itself in the plain `hermes` terminal.',
      'In this Hermes (0.21.5) that is the only place it does: in its TUI, its desktop app and its messaging gateway it waits on the page until the agent runs `it wait`.',
    ])
    expect(afterHermes('0.21.5')).not.toContain('allow_gateway_injection')
    expect(afterHermes('0.20.1')).not.toContain('allow_gateway_injection')
    // A later one may take it in the TUI and the desktop app, once allowed: the setting is named, and so is what happens where this Hermes does not take it
    VERSIONS.hermes = 'Hermes Agent v0.22.0'
    try {
      await detectAll()
      expect(AFTER.hermes).toBe(afterHermes('0.22.0'))
      // The command stands on a line of its own, so that no terminal breaks it in the middle of a word
      expect(AFTER.hermes!.split('\n')).toContain('    hermes config set plugins.entries.it-bridge.allow_gateway_injection true')
      expect(AFTER.hermes).toContain('If this Hermes (0.22.0) does not take that setting, what you do waits on the page until the agent runs `it wait`')
    } finally {
      VERSIONS.hermes = 'Hermes Agent v0.21.5'
    }
  })
})

describe('on Windows', () => {
  const platform = process.platform
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

  test('a hook’s command is written without quotes when the launcher’s address needs none, so that cmd and PowerShell both run it', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const command = (dir: string) =>
      (JSON.parse(read(path.join(dir, 'plugins/it-bridge/hooks/hooks.json'))) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.Stop![0]!
        .hooks[0]!.command
    expect(command(unpack('codex'))).toBe(`${shim()} hook codex`)
    // An address with a space in it has to be in quotes, and is written as cmd reads it
    useHome('an it folder')
    expect(command(unpack('codex'))).toBe(`"${shim()}" hook codex`)
  })

  test.each([
    { id: 'claude-code' as const, bin: 'claude' },
    { id: 'codex' as const, bin: 'codex' },
  ])('an add-on that cannot be installed, because a folder’s name cannot be passed to the app’s command, is not taken out first ($id)', async ({ id, bin }) => {
    // An It folder whose name holds a character that a command line on Windows cannot carry.
    // The add-on was put in on a system where that does not matter.
    useHome('R&D it')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await connect(id, () => {})
    const before = noted(id)
    writeFileSync(stampFile(id), JSON.stringify({ installs: [{ ...before.installs[0]!, version: 'another-version', at: 1 }] }))
    Object.defineProperty(process, 'platform', { value: 'win32' })
    ran = []
    const status = await connect(id, () => {})
    expect(status.addon).toBe('error')
    expect(status.detail).toMatch(/cannot be passed safely to a command on Windows, so the command was not run and nothing was changed\.$/)
    // Nothing was asked of the app but what it has, so what was installed is still there
    expect(commands(bin).filter((said) => /uninstall|remove|add|install/.test(said))).toEqual([])
    expect(kept[bin]!.get(folderOf(bin))!.on).toBe(true)
  })
})

describe('whether Codex, as it is set, lets `it` reach It', () => {
  test('is read from the two settings that say it plainly, and not guessed where the settings are arranged another way', () => {
    // As it comes, and with no settings file at all: no network for the agent's commands
    expect(codexLetsItOut(null)).toBe(false)
    expect(codexLetsItOut('model = "gpt-6"\n[tui]\nnotifications = true\n')).toBe(false)
    // Allowed for the sandbox it uses for a workspace, written either way
    expect(codexLetsItOut('model = "gpt-6"\n\n[sandbox_workspace_write]\nnetwork_access = true\n')).toBe(true)
    expect(codexLetsItOut('sandbox_workspace_write.network_access = true\n')).toBe(true)
    expect(codexLetsItOut('[sandbox_workspace_write]\nnetwork_access = false # not yet\n')).toBe(false)
    expect(codexLetsItOut('[sandbox_workspace_write]\n# network_access = true\n')).toBe(false)
    // No sandbox at all, or one that may do nothing
    expect(codexLetsItOut('sandbox_mode = "danger-full-access"\n')).toBe(true)
    expect(codexLetsItOut('sandbox_mode = "read-only"\n[sandbox_workspace_write]\nnetwork_access = true\n')).toBe(false)
    // A profile that is chosen, or permissions written out: nothing is said of what is not understood
    expect(codexLetsItOut('profile = "work"\n[profiles.work]\nsandbox_mode = "danger-full-access"\n')).toBeUndefined()
    expect(codexLetsItOut('[permissions.mine]\n')).toBeUndefined()
    expect(codexLetsItOut('default_permissions = "mine"\n')).toBeUndefined()
    // And a file that is there and cannot be read
    expect(codexLetsItOut(false)).toBeUndefined()
  })
})
