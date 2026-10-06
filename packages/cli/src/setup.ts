// Finding the agent harnesses on this machine and connecting the ones the person chose.
//
// It is a plugin to each harness and nothing more: an add-on is installed with the harness's
// own plugin commands, from files this program carries, and removed the same way. Nothing in
// a harness is patched, wrapped or replaced.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESSES, type Harness } from '@it/protocol'
import { ADDONS, LICENSE } from './addons.generated'
import { harnessEnv, home, inHome, Problem, readJson, writePrivate } from './lib'
import { alone as oneAtATime } from './serve/backend'

export type AddonState = 'connected' | 'not_connected' | 'needs_approval' | 'too_old' | 'unavailable' | 'error'
export interface HarnessStatus {
  id: Harness
  version?: string
  addon: AddonState
  detail?: string
}

interface Known {
  label: string
  bin: string
  min?: string
}
export const KNOWN: Record<Harness, Known> = {
  'claude-code': { label: 'Claude Code', bin: 'claude', min: '2.1.287' },
  // 0.160.0 is the first that says which conversations are open (see `codexHeld`), which is how a click knows whether Codex's queue will take it
  codex: { label: 'Codex', bin: 'codex', min: '0.160.0' },
  openclaw: { label: 'OpenClaw', bin: 'openclaw', min: '2026.9.6' },
  hermes: { label: 'Hermes Agent', bin: 'hermes', min: '0.20.1' },
  opencode: { label: 'OpenCode', bin: 'opencode', min: '1.18.32' },
  pi: { label: 'Pi', bin: 'pi', min: '0.82.0' },
}
const PLUGIN = 'it-bridge'
const MARKET = 'it'

interface Ran {
  ok: boolean
  out: string
  err: string
}
/**
 * On Windows a harness is usually a .cmd file, which only a shell can start. Every word is then
 * quoted, and a word the shell could read as more than a word is refused outright.
 */
const unsafe = (args: string[]) => process.platform === 'win32' && args.some((a) => /["&^%|<>!\r\n]/.test(a))
const UNSAFE: Ran = {
  ok: false,
  out: '',
  err: 'A path on this machine has a character that cannot be passed safely to a command on Windows, so the command was not run and nothing was changed.',
}
/**
 * Runs a harness's own command, outside any agent session this program may itself be inside.
 * `env` is given when the command is for an add-on installed where the harness kept its
 * settings at the time, which may not be where it keeps them now.
 */
function run(bin: string, args: string[], timeoutMs = 60_000, env: NodeJS.ProcessEnv = harnessEnv()): Promise<Ran> {
  const windows = process.platform === 'win32'
  if (unsafe(args)) return Promise.resolve(UNSAFE)
  const words = windows ? args.map((a) => `"${a}"`) : args
  return new Promise((resolve) =>
    execFile(bin, words, { env, timeout: timeoutMs, shell: windows, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) =>
      resolve({ ok: !err, out: String(out).trim(), err: String(stderr).trim() || (err ? err.message : '') }),
    ),
  )
}

const semver = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number)
function older(have: string, need: string): boolean {
  const a = semver(have)
  const b = semver(need)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!
  return false
}

// ---------- where things are kept ----------

const addonDir = (id: string) => inHome('addons', id)
export const stampFile = (id: string) => inHome('addons', `${id}.json`)

/** Where a harness keeps its settings: what an add-on is installed into, and later removed from. */
interface Place {
  /** Of the variables that say where the harness keeps its settings, those that were set, as they were. */
  env: Record<string, string>
  /** For an add-on whose files this program copies in itself: the harness's folder they go into. */
  dir?: string
}
/** A file this program put into a harness's folder, and a checksum of what it held when it was put there. */
interface Put {
  path: string
  sha256: string
}
/**
 * One installation of an add-on. Where it was made is kept, because the person may point the
 * harness at another folder afterwards, and the add-on is then still removed from where it was
 * put. One with no place is what a note that cannot be read stands for: it is taken to be about
 * the place the harness is found in now.
 */
interface Installation extends Partial<Place> {
  /**
   * The add-on's version, or 'installing' while the add-on is not whole: from when an install
   * starts until it has finished, and after a removal that had to leave some of it.
   */
  version: string
  at: number
  /** For an add-on whose files this program copies in itself: every file it wrote and has not seen gone, and no other. */
  files?: Put[]
}
/** What is kept about a harness's add-on: each installation of it that this program made and has not yet seen gone. */
interface Stamp {
  installs: Installation[]
}

function installations(id: string): Installation[] {
  const stamp = readJson<Partial<Stamp>>(stampFile(id))
  if (Array.isArray(stamp?.installs)) return stamp.installs.filter((i) => i && typeof i.version === 'string')
  // A note that cannot be read, or that holds no list of installations, still says that
  // something was installed. Where, and which files, it does not say.
  return existsSync(stampFile(id)) ? [{ version: 'installing', at: 0 }] : []
}
/** Whether this folder has a note of an add-on that it put into an agent app and has not seen gone. */
export const holdsAddons = (): boolean => HARNESSES.some((id) => installations(id).length > 0)
function keep(id: string, installs: Installation[]): void {
  writePrivate(stampFile(id), { installs } satisfies Stamp)
}
/** Where an installation was made, when that was noted with it. */
const placed = (i: Installation): Place | undefined => (i.env ? { env: i.env, dir: i.dir } : undefined)
/** Two places are one when the files went into the same folder, or the harness was told the same about where it keeps its settings. */
const samePlace = (a: Place, b: Place) => (a.dir ?? JSON.stringify(Object.entries(a.env).sort())) === (b.dir ?? JSON.stringify(Object.entries(b.env).sort()))
/** The environment for a harness's command about an add-on at a place: as now, but with what said where its settings were as it was then. */
function envAt(profile: readonly string[], at: Place): NodeJS.ProcessEnv {
  const env = harnessEnv()
  for (const k of profile) {
    if (at.env[k] === undefined) delete env[k]
    else env[k] = at.env[k]
  }
  return env
}

const real = (dir: string) => {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}
/** This It folder, by the one name it has however it was reached. */
const thisHome = () => real(home())
/**
 * The name of the note inside an add-on that says which It folder installed it. Two It folders
 * on one machine may be connected to the same harness, and an add-on that one of them put there
 * is not the other's to replace or remove.
 */
const HOME_NOTE = 'it-home.json'

const sum = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
/** Whether an error says that nothing is there. Any other says only that it could not be looked at, which is not the same. */
const absent = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')
/** Whether a folder is another, or is inside it. */
const holds = (top: string, inner: string) => {
  const rel = path.relative(top, inner)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
/**
 * What is at a place in a harness's folder where this program puts a file, or once put one:
 *  - 'file', with a checksum of what it holds: an ordinary file
 *  - 'other': something that is not an ordinary file, such as a link or a folder
 *  - 'none': nothing
 *  - 'outside': the place is not inside the harness's folder once every link on the way to it
 *    is followed. Nothing there is this program's to read, write or remove.
 *  - 'closed': it could not be looked at, so nothing is known of it. That is never taken to
 *    mean that nothing is there.
 */
type Found = { is: 'file'; sha256: string } | { is: 'other' | 'none' | 'outside' | 'closed' }
function lookAt(root: string, file: string): Found {
  const place = path.resolve(file)
  if (!holds(path.resolve(root), path.dirname(place))) return { is: 'outside' }
  try {
    const top = realpathSync(root)
    // The folder the file is in, by the one name it has however it is reached. Where that
    // folder is not there, the nearest one above it that is.
    let dir = path.dirname(place)
    let missing = false
    for (;;) {
      try {
        dir = realpathSync(dir)
        break
      } catch (err) {
        if (!absent(err) || dir === path.dirname(dir)) throw err
        missing = true
        dir = path.dirname(dir)
      }
    }
    if (!holds(top, dir)) return { is: 'outside' }
    if (missing) return { is: 'none' }
    if (!lstatSync(place).isFile()) return { is: 'other' }
    return { is: 'file', sha256: sum(readFileSync(place)) }
  } catch (err) {
    return { is: absent(err) ? 'none' : 'closed' }
  }
}
/** Whether a file is there and holds just what this program put in it. */
const asPut = (root: string, f: Put) => {
  const now = lookAt(root, f.path)
  return now.is === 'file' && now.sha256 === f.sha256
}
/**
 * Makes a folder inside a harness's folder, one step at a time. A step that is a link leading
 * out of the harness's folder is not gone through, so nothing is ever made on the far side of it.
 */
function makeWithin(root: string, dir: string): void {
  mkdirSync(root, { recursive: true })
  const top = realpathSync(root)
  let at = path.resolve(root)
  for (const step of path.relative(at, path.resolve(dir)).split(path.sep).filter(Boolean)) {
    at = path.join(at, step)
    try {
      mkdirSync(at)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    if (step === '..' || !holds(top, realpathSync(at))) throw new Error(`${at} is not inside ${root}, so nothing was written there`)
  }
}
/**
 * Puts a file in place. It is written beside its place and then moved into it, so that the file
 * is never half there. The name it is written under is one nobody could have known beforehand,
 * and the file of that name is made new by this very call and never opened through a link: what
 * is written can go nowhere but into that new file.
 */
function putInPlace(data: Buffer, to: string): void {
  const part = `${to}.${randomBytes(12).toString('hex')}.part`
  const made = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666)
  try {
    try {
      writeFileSync(made, data)
    } finally {
      closeSync(made)
    }
    renameSync(part, to)
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
}
/** Whether a file, a folder or anything else is at a place. One that cannot be looked at is not known to be gone. */
const reached = (file: string): 'there' | 'none' | 'closed' => {
  try {
    statSync(file)
    return 'there'
  } catch (err) {
    return absent(err) ? 'none' : 'closed'
  }
}
const there = (file: string) => {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}
/** A name beside a file for a copy of it that is being kept: the first such name that is free. */
function aside(file: string): string {
  for (let n = 1; ; n++) {
    const name = `${file}.set-aside-by-it${n > 1 ? `-${n}` : ''}`
    if (!there(name)) return name
  }
}
/** Written by `it hook codex` the first time Codex runs one of our hooks: proof they were approved. */
export const hookSeenFile = (id: string) => inHome('addons', `${id}.hooks-seen`)

/**
 * A fixed address for this program, so that a hook's text never changes: a harness asks the
 * person to approve a hook again whenever its definition changes, and a desktop app often does
 * not have the terminal's PATH.
 */
export function shim(): string {
  const windows = process.platform === 'win32'
  let file = inHome('bin', windows ? 'it.cmd' : 'it')
  const self = process.execPath
  const script = process.argv[1]
  // A standalone build is the program itself; under Node or Bun it is the runtime plus a script
  const standalone = !script || !/\.(m?js|ts)$/.test(script) || /^it(\.exe)?$/.test(path.basename(self))
  // When It's own folder is not the usual one, whatever runs this later (a hook, a service) is
  // told where it is, since it will not have the environment this was set up from
  const elsewhere = process.env.IT_HOME ? path.resolve(process.env.IT_HOME) : null
  const installed = standalone && path.resolve(self) === path.resolve(inHome('bin', windows ? 'it.exe' : 'it'))
  // The installed program is its own fixed address, unless it has to be told where its folder
  // is: then a launcher beside it does the telling
  if (installed && !elsewhere) return self
  if (installed) file = inHome('bin', windows ? 'it-here.cmd' : 'it-here')
  const target = standalone ? [self] : [self, path.resolve(script!)]
  const quote = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`
  // In a .cmd file a percent sign begins a variable's name, so one in a path is doubled. The
  // launcher's own folder is never written into it: `%~dp0` is where cmd.exe found the file,
  // whatever characters and whatever alphabet that folder's name is in, and It's folder is the
  // one above it.
  const inCmd = (t: string) => (path.dirname(t) === path.dirname(file) ? `%~dp0${path.basename(t).replace(/%/g, '%%')}` : t.replace(/%/g, '%%'))
  const run = windows ? `${target.map((t) => `"${inCmd(t)}"`).join(' ')} %*` : `exec ${target.map(quote).join(' ')} "$@"`
  const body = windows
    ? [
        '@echo off',
        // An exclamation mark in a path, or in what the launcher is given, is then only itself,
        // whatever the shell that runs the launcher has been set to read it as
        'setlocal DisableDelayedExpansion',
        // A path outside It's folder is written here as it is, and this file is written as
        // UTF-8. cmd.exe is told so before it reads the line, only where a letter in it needs
        // that: the console keeps what it is told after the launcher has ended.
        ...(/[\u0080-\uffff]/.test(run) ? ['chcp 65001 >nul 2>&1'] : []),
        ...(elsewhere ? ['if not defined IT_HOME set "IT_HOME=%~dp0.."'] : []),
        run,
        '',
      ].join('\r\n')
    : // The folder's name is written in apostrophes, where a shell reads every character as
      // itself. Written inside `${IT_HOME:=…}` it would end at the first closing brace in it.
      `#!/bin/sh\n${elsewhere ? `[ -n "\${IT_HOME:-}" ] || IT_HOME=${quote(elsewhere)}\nexport IT_HOME\n` : ''}${run}\n`
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    if (!windows) chmodSync(file, 0o755)
  }
  return file
}

/**
 * An add-on that runs inside a harness finds It's folder by itself. When that folder is not
 * the usual one, it is written into the add-on here: the harness may be started later from
 * somewhere that was never told.
 */
export function itHomeWritten(text: string, elsewhere = process.env.IT_HOME ? path.resolve(process.env.IT_HOME) : null): string {
  if (!elsewhere) return text
  return text
    .replace(/^const IT_HOME_AT_SETUP = null$/m, () => `const IT_HOME_AT_SETUP = ${JSON.stringify(elsewhere)}`)
    .replace(/^IT_HOME_AT_SETUP = None$/m, () => `IT_HOME_AT_SETUP = ${JSON.stringify(elsewhere)}`)
}

/** Writes an add-on's files where the harness will install them from. */
export function unpack(id: Harness): string {
  const addon = ADDONS[id]
  if (!addon) throw new Error(`there is no add-on for ${id}`)
  const dir = addonDir(id)
  rmSync(dir, { recursive: true, force: true })
  // The terms are kept in It's own folder wherever an add-on is installed from it, as the
  // install script leaves them. An add-on that is one file with no folder of its own (OpenCode's)
  // says in its first lines that they are here.
  if (!existsSync(inHome('LICENSE.md')) || readFileSync(inHome('LICENSE.md'), 'utf8') !== LICENSE) {
    mkdirSync(home(), { recursive: true })
    writeFileSync(inHome('LICENSE.md'), LICENSE)
  }
  const it = shim()
  // The launcher's address, written so that a shell reads it as one word whatever is in it:
  // a space, an apostrophe, a dollar sign. On Windows a harness may hand a hook to cmd or to
  // PowerShell, and the two read an address in quotes differently: PowerShell takes it for a
  // piece of text, not for a command to run. An address with nothing in it that needs quotes
  // is written without them, which both read alike. One that needs them is written as cmd reads it.
  const windows = process.platform === 'win32'
  const plain = windows ? /^[A-Za-z0-9_:.~\\/-]+$/ : /^[A-Za-z0-9_@%+=:,./-]+$/
  const quoted = plain.test(it) ? it : windows ? `"${it}"` : `'${it.replace(/'/g, `'\\''`)}'`
  const command = `${quoted} hook ${id}`
  for (const [rel, text] of Object.entries(addon.files)) {
    const file = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    // A hook is one fixed command at one fixed address; all the logic is inside this program
    // Put into the JSON as a value, so that whatever the address contains it stays one string
    if (rel.endsWith('hooks.json')) writeFileSync(file, text.replaceAll(JSON.stringify(`it hook ${id}`), JSON.stringify(command)))
    // The note of which It folder the add-on comes from says this one
    else if (path.basename(rel) === HOME_NOTE) writeFileSync(file, `${JSON.stringify({ ...(readNote(text) ?? {}), home: thisHome() }, null, 1)}\n`)
    else writeFileSync(file, itHomeWritten(text))
  }
  return dir
}
const readNote = (text: string): { home?: unknown } | null => {
  try {
    const said: unknown = JSON.parse(text)
    return typeof said === 'object' && said !== null && !Array.isArray(said) ? said : null
  } catch {
    return null
  }
}

// ---------- each harness ----------

interface Adapter {
  /**
   * The variables that say where this harness keeps its settings. What they were when an
   * add-on was installed is noted with it, and its removal is done with the same.
   */
  profile: readonly string[]
  /** For an add-on whose files this program copies in itself: the harness's folder they go into, as things stand now. */
  folder?(): Promise<string>
  /** Whether our add-on is installed in the harness right now, and switched on. `was` is what this program noted when it installed one there. */
  installed(at: Place, was?: Installation): Promise<boolean>
  /**
   * Whether our add-on is in the harness at all, switched on or not. Null when the harness
   * could not be asked: that is not the same as the add-on being gone.
   */
  present(at: Place, was?: Installation): Promise<boolean | null>
  /**
   * Where the note of which It folder installed it is, in the add-on the harness has. Null when
   * the harness has none, or does not say where it keeps it.
   */
  note?(at: Place): Promise<string | null>
  /** `wrote` is told, each time a file has been written, every file of the add-on that is this program's now. */
  install(dir: string, at: Place, was: Installation | undefined, wrote: (files: Put[]) => void): Promise<Ran & { files?: Put[]; aside?: string[] }>
  /** Takes the add-on out. What it returns are the files it did not take out. */
  remove(at: Place, was?: Installation): Promise<Left | undefined>
  /** Something the person still has to do inside the harness, if anything. */
  pending?(): string | undefined
}

/** The files of an add-on that a removal left where they were. */
interface Left {
  /** Changed by the person since they were put there, so theirs to keep or to take out. */
  changed: string[]
  /** Could not be looked at, or could not be taken out. */
  closed: string[]
  /** Not inside the harness's own folder now, by the address this program has for them. */
  outside: string[]
  /**
   * Nothing was looked for or taken out, because the note of the installation does not say
   * where it was made, and no add-on of It's is where the harness keeps its settings now. Where
   * it was put is then not known, and is not guessed.
   */
  nowhere?: boolean
  /**
   * Nothing was taken out, because the file the harness loads the add-on from is the one the
   * person changed. It stays, and the harness goes on running it, so the rest of the add-on
   * stays with it: the skill above all, which tells an agent how to treat what arrives.
   */
  whole?: boolean
}
const NOWHERE: Left = { changed: [], closed: [], outside: [], nowhere: true }
/**
 * Whether an installation was noted without its place, and the harness has no add-on of It's
 * where it keeps its settings now. A harness that could not be asked is not known to have none.
 */
const unplaced = async (adapter: Pick<Adapter, 'present'>, at: Place, was: Installation | undefined) =>
  was !== undefined && !placed(was) && (await adapter.present(at)) === false

/** What Claude Code says of our plugin. Null when it could not be asked, and nothing when it has none. */
async function claudeHas(at: Place): Promise<{ enabled?: boolean; installPath?: unknown } | undefined | null> {
  const r = await run('claude', ['plugin', 'list', '--json'], 60_000, envAt(['CLAUDE_CONFIG_DIR'], at))
  if (!r.ok) return null
  try {
    return (JSON.parse(r.out) as { id: string; enabled?: boolean; installPath?: unknown }[]).find((p) => p.id === `${PLUGIN}@${MARKET}`)
  } catch {
    return null
  }
}
/** What Codex says of our plugin in the list of its marketplace: its status, its version and the folder it came from. Null when Codex could not be asked. */
async function codexHas(at: Place): Promise<string | undefined | null> {
  const r = await run('codex', ['plugin', 'list', '--marketplace', MARKET], 60_000, envAt(['CODEX_HOME'], at))
  return r.ok ? new RegExp(`^${PLUGIN}@${MARKET}\\s+(.*)$`, 'm').exec(r.out)?.[1] : null
}
const OPENCLAW_VARS = ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'] as const
/** What OpenClaw says of our plugin. Null when it could not be asked, and nothing when it has none. */
async function openclawHas(at: Place): Promise<{ enabled?: boolean; status?: string; rootDir?: unknown } | undefined | null> {
  const r = await run('openclaw', ['plugins', 'inspect', PLUGIN, '--json'], 30_000, envAt(OPENCLAW_VARS, at))
  // OpenClaw saying it knows no such plugin is the one refusal that means it is gone
  if (!r.ok) return /not found|no such plugin|unknown plugin|not installed/i.test(`${r.out}\n${r.err}`) ? undefined : null
  try {
    return (JSON.parse(r.out.slice(r.out.indexOf('{'))) as { plugin?: { enabled?: boolean; status?: string; rootDir?: unknown } }).plugin
  } catch {
    return null
  }
}

const ADAPTERS: Partial<Record<Harness, Adapter>> = {
  'claude-code': {
    profile: ['CLAUDE_CONFIG_DIR'],
    installed: async (at) => Boolean((await claudeHas(at))?.enabled),
    async present(at) {
      const ours = await claudeHas(at)
      return ours === null ? null : ours !== undefined
    },
    // Claude Code keeps a copy of the plugin, and says where
    async note(at) {
      const ours = await claudeHas(at)
      return typeof ours?.installPath === 'string' && path.isAbsolute(ours.installPath) ? path.join(ours.installPath, HOME_NOTE) : null
    },
    async install(dir, at) {
      // Looked at before anything is taken out, so that an install that cannot go ahead leaves what was there
      if (unsafe([dir])) return UNSAFE
      const env = envAt(this.profile, at)
      await run('claude', ['plugin', 'uninstall', `${PLUGIN}@${MARKET}`], 60_000, env)
      await run('claude', ['plugin', 'marketplace', 'remove', MARKET], 60_000, env)
      const added = await run('claude', ['plugin', 'marketplace', 'add', dir], 60_000, env)
      if (!added.ok) return added
      return run('claude', ['plugin', 'install', `${PLUGIN}@${MARKET}`, '--scope', 'user'], 60_000, env)
    },
    async remove(at, was) {
      if (await unplaced(this, at, was)) return NOWHERE
      const env = envAt(this.profile, at)
      await run('claude', ['plugin', 'uninstall', `${PLUGIN}@${MARKET}`], 60_000, env)
      // The place it was installed from goes only once the add-on itself is seen to be gone:
      // while it is still listed, there is something left to try removing again
      if ((await this.present(at)) === false) await run('claude', ['plugin', 'marketplace', 'remove', MARKET], 60_000, env)
      return undefined
    },
  },
  codex: {
    profile: ['CODEX_HOME'],
    installed: async (at) => /^installed, enabled/.test((await codexHas(at)) ?? ''),
    async present(at) {
      const ours = await codexHas(at)
      // Codex lists what a marketplace offers as well as what is installed from it. An add-on
      // that is merely on offer there ("not installed") is not in Codex.
      return ours === null ? null : ours !== undefined && !ours.startsWith('not installed')
    },
    // Codex says which folder it took the plugin from: its status, its version, and then that folder
    async note(at) {
      const from = /^installed\b.*?\s{2,}\S+\s{2,}(\S.*)$/.exec((await codexHas(at)) ?? '')?.[1]?.trim()
      return from && path.isAbsolute(from) ? path.join(from, HOME_NOTE) : null
    },
    async install(dir, at) {
      // Looked at before anything is taken out, so that an install that cannot go ahead leaves what was there
      if (unsafe([dir])) return UNSAFE
      const env = envAt(this.profile, at)
      await run('codex', ['plugin', 'remove', `${PLUGIN}@${MARKET}`], 60_000, env)
      await run('codex', ['plugin', 'marketplace', 'remove', MARKET], 60_000, env)
      const added = await run('codex', ['plugin', 'marketplace', 'add', dir], 60_000, env)
      if (!added.ok) return added
      return run('codex', ['plugin', 'add', `${PLUGIN}@${MARKET}`], 60_000, env)
    },
    async remove(at, was) {
      if (await unplaced(this, at, was)) return NOWHERE
      const env = envAt(this.profile, at)
      await run('codex', ['plugin', 'remove', `${PLUGIN}@${MARKET}`], 60_000, env)
      // Its marketplace is what `present` looks in. It goes only once the add-on is seen to be
      // gone from Codex (whoever removed it): otherwise a failed removal would look like a
      // finished one.
      if ((await this.present(at)) === false) await run('codex', ['plugin', 'marketplace', 'remove', MARKET], 60_000, env)
      return undefined
    },
    pending() {
      // Codex runs no hook until the person has approved it, and says nothing when it skips one.
      // That one has run is the proof; so is Codex's own note of the approval, which it writes
      // the moment the person gives it, a turn before any hook runs.
      if (existsSync(hookSeenFile('codex')) || /^\[hooks\.state\."it-bridge@it:/m.test(codexConfig() || '')) return undefined
      const hooks =
        'Start Codex once and choose "Trust all and continue" when it says the hooks need review. Until then clicks still arrive, as a new message when Codex is idle.'
      return codexLetsItOut() === false ? `${hooks} ${CODEX_NO_NETWORK}` : hooks
    },
  },
}

/** OpenCode's own settings folder, as OpenCode itself reports it. */
async function opencodeConfig(): Promise<string> {
  const r = await run('opencode', ['debug', 'paths'], 15_000)
  const line = r.ok ? r.out.split('\n').find((l) => /^config\s/.test(l)) : undefined
  const said = line?.replace(/^config\s+/, '').trim()
  return said && path.isAbsolute(said) ? said : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
}

/** What has to be said about an add-on whose files this program copies into a harness's folder itself. */
interface Copied {
  profile: readonly string[]
  folder(): Promise<string>
  /** Where each of the add-on's files goes in that folder. */
  goes(rel: string): string
  /** The file whose being there makes the harness load the add-on. */
  main: string
  /** Folders that are the add-on's alone. One is taken away only when nothing is left in it; the harness's own folders never are. */
  own: readonly string[]
  /** The harness's own word on whether the add-on is switched on, where it has one. */
  on?(at: Place): Promise<boolean>
  /** What the harness is told once the files are in. */
  after?(at: Place): Promise<Ran>
  /** What the harness is told before they are taken out. */
  before?(at: Place, was: Installation | undefined): Promise<void>
}

/** Whether a folder holds nothing but files this program put there, unchanged, and what Python leaves beside code it has run. */
function onlyOurs(root: string, dir: string, files: Put[]): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).every((entry) => {
      const full = path.join(dir, entry.name)
      // What Python leaves is compiled code and nothing else: any other file kept there is the person's
      if (entry.isDirectory() && entry.name === '__pycache__')
        return readdirSync(full, { withFileTypes: true }).every((left) => left.isFile() && left.name.endsWith('.pyc'))
      if (entry.isDirectory()) return onlyOurs(root, full, files)
      return files.some((f) => f.path === full && asPut(root, f))
    })
  } catch {
    return false
  }
}

/**
 * An add-on that is copied in. It is given the same care a harness's own installer would take:
 * this program replaces and removes only the files it put there itself and that are still as
 * it left them. A file that was there already, or that the person has changed since, is theirs.
 * On the way in it is kept beside the new one under another name, and on the way out it is left
 * where it is.
 */
function copied(id: Harness, c: Copied): Adapter {
  const all = (at: Place) => Object.keys(ADDONS[id]?.files ?? {}).map((rel) => ({ rel, to: path.join(at.dir!, ...c.goes(rel).split('/')) }))
  return {
    profile: c.profile,
    folder: c.folder,
    async installed(at, was) {
      const main = path.join(at.dir!, ...c.main.split('/'))
      // A file of that name which this program has no note of putting there is not our add-on
      if (!was || (was.files && !was.files.some((f) => f.path === main)) || !there(main)) return false
      return c.on ? c.on(at) : true
    },
    async present(at, was) {
      // Whatever is still where this program put a file, changed since or not. A note that
      // holds no list of what was written is taken to be of the files an add-on always has.
      const found = (was?.files?.map((f) => f.path) ?? all(at).map((f) => f.to)).map((file) => lookAt(at.dir!, file).is)
      // A file that cannot be looked at is not known to be gone
      if (found.includes('closed')) return null
      return found.some((is) => is === 'file' || is === 'other')
    },
    async note(at) {
      return all(at).find((f) => path.basename(f.rel) === HOME_NOTE)?.to ?? null
    },
    async install(dir, at, was, wrote) {
      const root = at.dir!
      const kept: string[] = []
      // The files that are this program's: what the last install left, and then each file this
      // one writes, from the moment it has been written and no sooner
      const mine = new Map((was?.files ?? []).map((f) => [f.path, f.sha256]))
      const noted = () => [...mine].map(([file, sha256]) => ({ path: file, sha256 }))
      try {
        const wanted = all(at).map((f) => {
          const data = readFileSync(path.join(dir, ...f.rel.split('/')))
          return { to: f.to, data, sha256: sum(data) }
        })
        const look = (file: string) => {
          const now = lookAt(root, file)
          if (now.is === 'outside') throw new Error(`${file} is not inside ${root}, so nothing was written there`)
          if (now.is === 'closed') throw new Error(`${file} could not be looked at, so nothing was written there`)
          return now
        }
        // Every place is looked at before anything is written, so that an add-on which cannot
        // all go in is not put in by halves
        for (const f of wanted) look(f.to)
        for (const f of wanted) {
          const now = look(f.to)
          const own = now.is === 'file' && mine.get(f.to) === now.sha256
          if (own && now.sha256 === f.sha256) continue
          makeWithin(root, path.dirname(f.to))
          // Whatever is there that this program did not put there, or that has been changed
          // since, is the person's, though it hold the very same words
          if (now.is !== 'none' && !own) {
            const name = aside(f.to)
            renameSync(f.to, name)
            mine.delete(f.to)
            kept.push(name)
          }
          putInPlace(f.data, f.to)
          mine.set(f.to, f.sha256)
          wrote(noted())
        }
        // A file noted as put there that this add-on does not have is taken away, where it is still as it was put
        for (const [file, sha256] of [...mine]) {
          if (wanted.some((f) => f.to === file)) continue
          const now = lookAt(root, file)
          if (now.is === 'file' && now.sha256 === sha256) rmSync(file, { force: true })
          if (now.is !== 'closed') mine.delete(file)
        }
        return { ...((await c.after?.(at)) ?? { ok: true, out: '', err: '' }), files: noted(), aside: kept }
      } catch (err) {
        return { ok: false, out: '', err: (err as Error).message, files: noted(), aside: kept }
      }
    },
    async remove(at, was) {
      const root = at.dir!
      const main = path.join(root, ...c.main.split('/'))
      // A note that holds no list of what was written, as one that cannot be read holds none,
      // says neither the place nor which files are It's. The folder the harness uses now is
      // taken for that place only when the file the add-on is loaded from is there and says
      // that it is It's add-on. A file of that name which does not is the person's own, and
      // nothing is asked of the harness.
      if (!was?.files) {
        const now = lookAt(root, main)
        if (now.is === 'closed') return { changed: [], closed: [main], outside: [] }
        if (now.is !== 'file' || !readFileSync(main, 'utf8').includes('The It add-on for ')) return NOWHERE
      }
      // The file the add-on is loaded from, changed by the person since: nothing is taken out
      const loaded = was?.files?.find((f) => f.path === main)
      if (loaded) {
        const now = lookAt(root, main)
        if (now.is === 'other' || (now.is === 'file' && now.sha256 !== loaded.sha256)) return { changed: [main], closed: [], outside: [], whole: true }
      }
      await c.before?.(at, was)
      const left: Left = { changed: [], closed: [], outside: [] }
      const leave = (file: string, now: Found) => {
        if (now.is === 'file' || now.is === 'other') left.changed.push(file)
        else if (now.is !== 'none') left[now.is].push(file)
      }
      if (was?.files) {
        for (const f of was.files) {
          const now = lookAt(root, f.path)
          if (now.is !== 'file' || now.sha256 !== f.sha256) leave(f.path, now)
          else
            try {
              rmSync(f.path)
            } catch (err) {
              if (!absent(err)) left.closed.push(f.path)
            }
        }
      } else {
        // Its files cannot be shown to be as this program left them, so they are put out of the
        // harness's way under another name and not deleted.
        for (const f of all(at)) {
          const now = lookAt(root, f.to)
          if (now.is === 'file' || now.is === 'other') renameSync(f.to, aside(f.to))
          else leave(f.to, now)
        }
      }
      for (const own of c.own) {
        const dir = path.join(root, ...own.split('/'))
        // A link standing where the folder was is not the add-on's folder
        if (lookAt(root, dir).is !== 'other' || lstatSync(dir).isSymbolicLink()) continue
        try {
          rmdirSync(dir)
        } catch {}
      }
      return left
    },
    // Neither harness that is given its files this way asks the person to approve anything
    pending: () => undefined,
  }
}

Object.assign(ADAPTERS, {
  // Pi installs a package from a folder with its own command, and loads it from there. It knows
  // an add-on by that folder, which is inside this It folder: another It folder's add-on is
  // another package to Pi, and each folder puts in and takes out its own.
  pi: {
    profile: ['PI_CODING_AGENT_DIR'],
    async installed(at) {
      const r = await run('pi', ['list'], 60_000, envAt(this.profile, at))
      return r.ok && r.out.split('\n').some((line) => line.trim() === path.resolve(addonDir('pi')))
    },
    async present(at) {
      const r = await run('pi', ['list'], 60_000, envAt(this.profile, at))
      return r.ok ? r.out.split('\n').some((line) => line.trim() === path.resolve(addonDir('pi'))) : null
    },
    install(dir, at) {
      return run('pi', ['install', dir], 60_000, envAt(this.profile, at))
    },
    async remove(at, was) {
      if (await unplaced(this, at, was)) return NOWHERE
      await run('pi', ['remove', addonDir('pi')], 60_000, envAt(this.profile, at))
      return undefined
    },
  },
  // OpenCode loads whatever is in its settings folder's plugins and skills folders. The files
  // are copied there, since OpenCode has no command that both adds and removes a plugin, and it
  // reads its plugins when it starts.
  opencode: copied('opencode', {
    profile: ['XDG_CONFIG_HOME'],
    folder: opencodeConfig,
    goes: (rel) => rel,
    main: 'plugins/it-bridge.js',
    // The skill's own folder; OpenCode's plugins and skills folders are never removed
    own: ['skills/it'],
  }),
  // OpenClaw installs a plugin from a folder with its own command. A running gateway applies
  // the change by itself; one that is stopped picks it up when it next starts.
  openclaw: {
    profile: OPENCLAW_VARS,
    async installed(at) {
      const ours = await openclawHas(at)
      return ours?.enabled === true && ours.status !== 'error'
    },
    async present(at) {
      const ours = await openclawHas(at)
      return ours === null ? null : ours !== undefined
    },
    // OpenClaw keeps a copy of the plugin, and says where
    async note(at) {
      const ours = await openclawHas(at)
      return typeof ours?.rootDir === 'string' && path.isAbsolute(ours.rootDir) ? path.join(ours.rootDir, HOME_NOTE) : null
    },
    async install(dir, at) {
      const env = envAt(this.profile, at)
      // Asked for by the person in `it setup` or on the site, which is what accepting the
      // plugin's capabilities on their behalf rests on
      const added = await run('openclaw', ['plugins', 'install', dir, '--force', '--accept-capabilities'], 180_000, env)
      if (!added.ok) return added
      return run('openclaw', ['plugins', 'enable', PLUGIN, '--accept-capabilities'], 180_000, env)
    },
    async remove(at, was) {
      if (await unplaced(this, at, was)) return NOWHERE
      await run('openclaw', ['plugins', 'uninstall', PLUGIN, '--force'], 180_000, envAt(this.profile, at))
      return undefined
    },
  },
  // Hermes loads plugins from a folder in its own home, and has to be told to enable one. Its
  // installer only takes a git address, so the files are copied and Hermes's own command
  // enables them.
  hermes: copied('hermes', {
    profile: ['HERMES_HOME'],
    folder: async () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'),
    // The plugin goes into Hermes's plugins folder, and the skill beside Hermes's other skills
    goes: (rel) => (rel.startsWith(`${PLUGIN}/`) ? `plugins/${rel}` : rel),
    main: `plugins/${PLUGIN}/__init__.py`,
    own: [`plugins/${PLUGIN}`, 'skills/it'],
    async on(at) {
      const r = await run('hermes', ['plugins', 'list', '--json', '--no-bundled'], 30_000, envAt(this.profile, at))
      if (!r.ok) return false
      try {
        return (JSON.parse(r.out) as { name?: string; status?: string }[]).some((p) => p.name === PLUGIN && p.status === 'enabled')
      } catch {
        return false
      }
    },
    after(at) {
      return run('hermes', ['plugins', 'enable', PLUGIN], 60_000, envAt(this.profile, at))
    },
    async before(at, was) {
      // Hermes's own command for removing a plugin takes the plugin's folder away whole, and
      // with it the person's permission for the plugin in their settings. It is used when that
      // folder holds nothing but what this program put there. When the person has changed or
      // added something in it, the plugin is switched off with Hermes's own command instead,
      // and only this program's files are taken out.
      const whole = was?.files !== undefined && onlyOurs(at.dir!, path.join(at.dir!, 'plugins', PLUGIN), was.files)
      await run('hermes', ['plugins', whole ? 'remove' : 'disable', PLUGIN], 60_000, envAt(this.profile, at))
    },
  }),
} satisfies Partial<Record<Harness, Adapter>>)

/** The version of each harness that was found the last time it was looked for. */
const found: Partial<Record<Harness, string>> = {}

/**
 * What a person who has just connected Hermes is told. It depends on the Hermes that was found:
 * up to 0.21.5 a plugin's message reaches the plain terminal and nowhere else. A later Hermes
 * has a setting by which the person allows one in the TUI and the desktop app as well. Not
 * every later Hermes is known to take it, so the person is told what happens where one does not.
 */
export function afterHermes(version: string | undefined): string {
  if (!version || !older('0.21.5', version))
    return `Restart Hermes. In this Hermes${version ? ` (${version})` : ''}, what you do on a page arrives by itself only in the plain \`hermes\` terminal. In its TUI, its desktop app and its messaging gateway it waits on the page until the agent runs \`it wait\`.`
  return `Restart Hermes. What you do on a page arrives by itself in the plain \`hermes\` terminal. For the Hermes TUI or desktop app, also run \`hermes config set plugins.entries.it-bridge.allow_gateway_injection true\` once, which lets It put what you do into those conversations. If this Hermes (${version}) does not take that setting, what you do waits on the page until the agent runs \`it wait\`, as it does in the messaging gateway.`
}

/** Codex's own settings file, as text. Null when there is none, and false when one is there and cannot be read. */
function codexConfig(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string | null | false {
  try {
    return readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}
/**
 * Whether Codex, as its settings stand, gives the commands its agent runs the network, which
 * `it` needs to reach It. As it comes it does not, and the agent's first `it create` then
 * fails where nothing It runs can see it. True and false only where the settings say it
 * plainly; undefined where they are arranged some other way (a profile, permissions of the
 * person's own), which is not guessed at. Someone who runs Codex with full access by a switch
 * on its command line is not seen here either, so what is said of this is said as advice.
 */
export function codexLetsItOut(config: string | null | false = codexConfig()): boolean | undefined {
  if (config === false) return undefined
  if (config === null) return false
  let table = ''
  let mode: string | undefined
  let network: boolean | undefined
  for (const raw of config.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header) {
      table = header[1]!
      // Settings of another shape than the two looked at: a profile that is chosen, or permissions written out by hand
      if (/^(profiles|permissions)\b/.test(table)) return undefined
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    if (table === '' && (key === 'profile' || key === 'default_permissions')) return undefined
    if (table === '' && key === 'sandbox_mode') mode = value!.replace(/["']/g, '')
    if ((table === 'sandbox_workspace_write' && key === 'network_access') || (table === '' && key === 'sandbox_workspace_write.network_access')) network = value === 'true'
  }
  if (mode === 'danger-full-access') return true
  if (mode === 'read-only') return false
  return network === true
}
/** What a person is told where Codex, as it is set, would keep `it` from reaching It. */
export const CODEX_NO_NETWORK =
  'As it is set, Codex gives the commands its agent runs no network, and `it` needs it to reach It on this machine, so Codex would fail to make its first page. To let it, add the two lines `[sandbox_workspace_write]` and `network_access = true` to `~/.codex/config.toml` and start Codex again. You need not if you run Codex with full access, or would sooner approve `it` each time Codex asks.'

/** What the person still has to do themselves once an add-on is in, if anything. Shown once, by `it setup`. */
export const AFTER: Partial<Record<Harness, string>> = {
  get hermes() {
    return afterHermes(found.hermes)
  },
  opencode: 'Restart OpenCode: it reads its plugins when it starts.',
  pi: 'Restart Pi, or run /reload in it.',
  get codex() {
    const hooks = 'Start Codex once and choose "Trust all and continue" when it says the hooks need review.'
    return codexLetsItOut() === false ? `${hooks} ${CODEX_NO_NETWORK}` : hooks
  },
}

/**
 * Add-ons that are not yet proven in every place their harness is used. They are not offered
 * until they are, except to someone who asks for them by name (IT_EXPERIMENTAL=openclaw).
 *
 * OpenClaw's has been run on a real gateway, with a real model, for a conversation held in
 * OpenClaw's own interface. It has not been run for a conversation held in a chat channel,
 * which is where most of OpenClaw's are, and where the agent's answer to a click is sent on to
 * the chat: until that has been seen to go where it should, it stays held back.
 */
const HELD_BACK: Partial<Record<Harness, string>> = {
  openclaw:
    'The OpenClaw add-on works for a conversation held in OpenClaw itself, and has not yet been tried in a chat channel, so it is not switched on. To use it all the same, run `IT_EXPERIMENTAL=openclaw it setup` once.',
}
/** The add-ons this person has asked for by name, written down in It's folder. */
const askedForFile = () => inHome('addons', 'asked-for.json')
const askedFor = (): string[] => {
  const kept = readJson<unknown>(askedForFile())
  return Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : []
}
/**
 * Why an add-on is not offered, or nothing if it is. One that is held back is offered to
 * someone who asks for it by name, with IT_EXPERIMENTAL. That is asked once and then written
 * down in It's folder: the variable is in the terminal the person typed it in, and not in the
 * background service, nor in the shell an agent app runs `it` from, and each of those took the
 * add-on for one nobody had asked for and switched it off again.
 */
const heldBack = (id: Harness) => {
  if (!HELD_BACK[id]) return undefined
  const named = (process.env.IT_EXPERIMENTAL ?? '')
    .split(',')
    .map((x) => x.trim())
    .includes(id)
  const asked = askedFor()
  if (named && !asked.includes(id)) {
    try {
      mkdirSync(path.dirname(askedForFile()), { recursive: true })
      writePrivate(askedForFile(), [...asked, id])
    } catch {
      // Where It's folder cannot be written the variable still counts, for this command
    }
  }
  return named || asked.includes(id) ? undefined : HELD_BACK[id]
}
/** Why an agent app's add-on is not offered here, if it is one that is held back and that nobody has asked for. */
export const whyHeldBack = (id: string): string | undefined => ((HARNESSES as readonly string[]).includes(id) ? heldBack(id as Harness) : undefined)

/** Which add-ons this build carries and offers. */
export const supported = (id: string): id is Harness => id in ADAPTERS && id in ADDONS && !heldBack(id as Harness)

async function versionOf(id: Harness): Promise<string | undefined> {
  const r = await run(KNOWN[id].bin, ['--version'], 15_000)
  if (!r.ok) return undefined
  return semver(r.out)?.join('.') ?? r.out.split('\n')[0]!.slice(0, 40)
}

/** Where a harness keeps its settings as things stand now: where an add-on installed now would go. */
async function whereNow(adapter: Pick<Adapter, 'profile' | 'folder'> | undefined): Promise<Place> {
  // Each is noted by its whole address. One that depends on where a command is run from would
  // lead a later command, run from somewhere else, to another folder. One that begins with a
  // tilde is the harness's own to read, and is kept as it was written.
  const whole = (said: string) => (path.isAbsolute(said) || said.startsWith('~') ? said : path.resolve(said))
  const env = Object.fromEntries((adapter?.profile ?? []).flatMap((k) => (process.env[k] ? [[k, whole(process.env[k]!)]] : [])))
  return adapter?.folder ? { env, dir: path.resolve(await adapter.folder()) } : { env }
}

/** The It folder that the add-on a harness has at a place says it was installed from. Null when it has none, or none that says. */
async function cameFrom(adapter: Pick<Adapter, 'note'>, at: Place): Promise<string | null> {
  const file = await adapter.note?.(at)
  const said = file ? readJson<{ home?: unknown }>(file)?.home : undefined
  return typeof said === 'string' && said ? said : null
}
interface Other {
  /** The It folder the add-on says it was installed from. */
  home: string
  /** Whether that folder still has the installation on record. If it has not, nothing will ever remove the add-on from there. */
  kept: boolean
}
/**
 * Whether an It folder has on record an installation of a harness's add-on at a place. What an
 * add-on says of where it came from is only words in a file: it is that folder's own record of
 * having installed it there which makes the add-on that folder's.
 */
function onRecord(from: string, id: Harness, at: Place): boolean {
  const file = path.join(from, 'addons', `${id}.json`)
  const seen = reached(file)
  // A record that cannot be looked at is not known to be gone
  if (seen !== 'there') return seen === 'closed'
  const stamp = readJson<Partial<Stamp>>(file)
  // One that cannot be read still says that something was installed
  if (stamp === null) return true
  return Array.isArray(stamp.installs) && stamp.installs.some((i) => i && typeof i.version === 'string' && samePlace(placed(i) ?? at, at))
}
/** Whether an add-on that says it came from an It folder belongs to another folder than this one. */
const elsewhere = (id: Harness, from: string | null, at: Place): Other | null =>
  from && real(from) !== thisHome() ? { home: from, kept: onRecord(from, id, at) } : null

/** What is found out about a harness in one look: its status, and what the status rests on. */
interface Seen {
  status: HarnessStatus
  adapter: Adapter
  at: Place
  /** Every installation this program has on record for the harness, and the one made at this place. */
  all: Installation[]
  was?: Installation
  /** The It folder that the add-on which is there says it came from, if it says. */
  from: string | null
  /** That folder, when it is another than this one. */
  other: Other | null
}
async function look(id: Harness): Promise<Seen | HarnessStatus | null> {
  const version = await versionOf(id)
  if (!version) return null
  found[id] = version
  const adapter = ADAPTERS[id]
  if (!adapter || !ADDONS[id]) return { id, version, addon: 'unavailable', detail: `It cannot connect to ${KNOWN[id].label} yet.` }
  const held = heldBack(id)
  if (held) return { id, version, addon: 'unavailable', detail: held }
  const min = KNOWN[id].min
  if (min && older(version, min))
    return {
      id,
      version,
      addon: 'too_old',
      detail: `It needs ${KNOWN[id].label} ${min} or newer, and this one is ${version}. Update ${KNOWN[id].label}, then run \`it setup\` again.`,
    }
  const at = await whereNow(adapter)
  const all = installations(id)
  const was = all.find((i) => samePlace(placed(i) ?? at, at))
  // An add-on that another It folder installed brings clicks to that folder's connector, not to
  // this one's. While that folder still has it on record it stays that folder's, and It is not
  // connected here. One that no folder has on record is nobody's, and is replaced when asked for.
  const from = await cameFrom(adapter, at)
  const other = elsewhere(id, from, at)
  const seen = { adapter, at, all, was, from, other }
  if (other?.kept)
    return {
      ...seen,
      status: {
        id,
        version,
        addon: 'unavailable',
        detail: `${KNOWN[id].label} has It’s add-on from another It folder on this machine. It stays with that folder until it is disconnected there.`,
      },
    }
  if (other || !(await adapter.installed(at, was))) return { ...seen, status: { id, version, addon: 'not_connected' } }
  const todo = adapter.pending?.()
  return { ...seen, status: todo ? { id, version, addon: 'needs_approval', detail: todo } : { id, version, addon: 'connected' } }
}
const statusOf = async (id: Harness): Promise<HarnessStatus | null> => {
  const seen = await look(id)
  return seen && 'status' in seen ? seen.status : seen
}

/** Every harness found on this machine, and whether It is connected to it. */
export async function detectAll(): Promise<HarnessStatus[]> {
  // IT_HARNESSES limits which harnesses are looked for at all: for tests, and for a machine
  // where one of them should be left entirely alone
  const only = process.env.IT_HARNESSES?.split(',').map((x) => x.trim())
  const found = await Promise.all(HARNESSES.filter((id) => !only || only.includes(id)).map((id) => statusOf(id).catch(() => null)))
  return found.filter((s): s is HarnessStatus => s !== null)
}

/** When this program started: what was installed after that was installed by another copy of it. */
const STARTED = Date.now()
let newer = false
/** Whether, while this program has been running, a newer copy of it installed an add-on. A connector that sees so should make way for the newer one. */
export const newerProgramSeen = (): boolean => newer

/**
 * What to do about a harness's add-on when it is wanted. `stamp` is the version this program
 * last installed, if it installed one; `present` is asked for only where it decides anything.
 *  - connected, at the version this program carries: nothing to do
 *  - connected, at an older one: installed again, so that fixes reach installations that have it
 *  - installed by this program, still there, and not connected: the person switched it off
 *    inside the harness. That is theirs to decide, and is not undone, by a newer version either.
 *  - connected at another version that was installed after this program started: a newer copy of
 *    the program put it there, and this one leaves it alone
 *  - anything else: installed
 */
export async function whatToDo(
  addon: HarnessStatus['addon'],
  stamp: string | undefined,
  carried: string,
  present: () => Promise<boolean | null>,
  /** When the add-on was last installed, and when this program started. */
  installedAt = 0,
  startedAt = STARTED,
): Promise<'nothing' | 'leave switched off' | 'install' | 'leave to the newer program'> {
  // Connected at a version this program does not carry, and installed since this program
  // started: a newer copy of the program did that, while this one (a connector that has been
  // running since before the upgrade) went on. Putting this one's older add-on back over it
  // would undo the upgrade.
  if (addon !== 'not_connected' && stamp !== carried && stamp !== undefined && stamp !== 'installing' && installedAt > startedAt)
    return 'leave to the newer program'
  if (addon !== 'not_connected') return stamp === carried ? 'nothing' : 'install'
  if (stamp && stamp !== 'installing' && (await present()) === true) return 'leave switched off'
  return 'install'
}

/**
 * `forLog` is how the connector calls this and `disconnect`: what is said is then written to its
 * log, and names no folder and no file.
 */
export async function connect(id: Harness, say: (line: string) => void, forLog = false): Promise<HarnessStatus> {
  const label = KNOWN[id].label
  const seen = await look(id)
  if (!seen) return { id, addon: 'error', detail: `${label} was not found on this machine.` }
  if (!('status' in seen)) return seen
  const { status: before, adapter, at, all, was, from, other } = seen
  if (other?.kept) {
    say(
      forLog
        ? `${label}: its add-on belongs to another It folder, and was left as it is`
        : `${label}: the add-on in it was installed from the It folder at ${other.home}, and was left as it is. To connect ${label} to this It folder instead, take it out of that one first: run \`it setup --none\` with IT_HOME set to that folder, which takes out every add-on that folder put in.`,
    )
    return before
  }
  // An add-on that no It folder has on record is replaced whatever state it is in
  const doing = other ? 'install' : await whatToDo(before.addon, was?.version, ADDONS[id]!.version, () => adapter.present(at, was), was?.at)
  if (doing === 'nothing') return before
  if (doing === 'leave to the newer program') {
    newer = true
    return before
  }
  if (doing === 'leave switched off')
    return {
      ...before,
      detail: `It’s add-on is switched off inside ${label}. Switch it on there, or untick ${label} here and tick it again to have the add-on installed afresh.`,
    }
  say(`connecting ${label}`)
  // The person is told plainly when what is about to be replaced is not something this It
  // folder put there: an add-on from an It folder that keeps no note of it any more, or one
  // under It's name that this folder has no note of either
  if (other)
    say(
      forLog
        ? `${label}: the add-on in it came from an It folder that has no note of it any more, and now belongs to this one`
        : `${label}: the add-on in it came from the It folder at ${other.home}, which has no note of it any more. It now belongs to this It folder, at ${thisHome()}`,
    )
  else if (!was && !from && !adapter.folder && (before.addon !== 'not_connected' || (await adapter.present(at)) === true))
    say(`${label}: it already had an add-on under It’s name that this It folder has no note of installing, and that add-on is replaced by this folder’s`)
  const dir = unpack(id)
  // Noted before anything is installed: if installing stops half way, what it left behind is
  // still known to be this program's, and is removed when the person disconnects
  const others = all.filter((i) => i !== was)
  const noted = (version: string, files?: Put[]): Installation[] => [...others, { version, at: Date.now(), env: at.env, dir: at.dir, files }]
  keep(id, noted('installing', was?.files))
  // Each file is noted once it has been written: a file that an install never got as far as
  // writing is not this program's, whatever was there under its name
  const r = await adapter.install(dir, at, was, (files) => keep(id, noted('installing', files)))
  if (r.aside?.length) {
    const one = r.aside.length === 1
    const found = `${label}: ${one ? 'one file' : `${r.aside.length} files`} that It had not put there, or that had been changed since,`
    say(
      forLog
        ? `${found} ${one ? 'was' : 'were'} kept beside the add-on under another name`
        : `${found} ${one ? 'was' : 'were'} in the add-on’s place. Nothing was written over: ${one ? 'it is' : 'each is'} kept beside the add-on, as ${r.aside.join(', ')}`,
    )
  }
  if (!r.ok) {
    if (r.files) keep(id, noted('installing', r.files))
    return { id, version: before.version, addon: 'error', detail: (r.err || r.out).split('\n').slice(-3).join(' ').slice(0, 200) }
  }
  keep(id, noted(ADDONS[id]!.version, r.files))
  return (await statusOf(id)) ?? before
}

/** False when the add-on could not be removed, or it could not be told whether it was: it is then tried again later. */
export async function disconnect(
  id: Harness,
  say: (line: string) => void,
  // What does the removing, and whether the harness can be run at all: given by the tests
  how: { adapter?: Pick<Adapter, 'remove' | 'present' | 'note'>; runnable?: () => Promise<boolean> } = {},
  forLog = false,
): Promise<boolean> {
  const label = KNOWN[id].label
  // Only what this program installed is removed, and from where it installed it
  let left = installations(id)
  if (!left.length) return true
  const adapter = how.adapter ?? ADAPTERS[id]
  const runnable = how.runnable ?? (async () => Boolean(await versionOf(id)))
  // The harness's own command does the removing. If the harness cannot be run from here, it
  // cannot be told whether the add-on is gone, so the note that it was installed is kept.
  if (!adapter || !(await runnable())) {
    say(`${label} could not be run from here, so its add-on was left as it is`)
    return false
  }
  say(`disconnecting ${label}`)
  for (const was of left) {
    const at = placed(was) ?? (await whereNow(ADAPTERS[id]))
    // A settings folder the person has deleted since took the add-on with it. The harness is
    // not asked about such a folder: asking would only make it anew.
    const folders = [...Object.values(was.env ?? {}), ...(was.dir ? [was.dir] : [])].map(reached)
    // A folder that cannot be looked at is not known to be gone, and neither is what is in it
    if (folders.length && !folders.includes('there') && folders.includes('closed')) {
      say(`${label}: the folder its add-on was put into could not be looked at, so the add-on was left as it is and the note of it is kept`)
      continue
    }
    if (!folders.length || folders.includes('there')) {
      // What is there now may have been put there since by another It folder, and is then that
      // folder's: this one's installation is gone already, and nothing is taken out. It is
      // another folder's only when that folder has it on record, whatever the add-on says.
      const other = elsewhere(id, await cameFrom(adapter, at), at)
      if (other?.kept) {
        say(
          forLog
            ? `${label}: the add-on in it now belongs to another It folder, and was left as it is`
            : `${label}: the add-on in it now belongs to the It folder at ${other.home}, and was left as it is`,
        )
      } else {
        const stayed = await adapter.remove(at, was)
        if (stayed?.nowhere) {
          say(
            `${label}: It has a note of putting its add-on there that does not say where ${label} kept its settings then, and no add-on of It’s is where ${label} keeps them now. Nothing was touched, and the note is kept`,
          )
          continue
        }
        if (stayed?.whole) {
          const kept = `${label}: the file that ${label} loads the add-on from had been changed since It put it there, so the add-on was left in ${label} as it is`
          say(forLog ? kept : `${kept}. Look at the file, and delete it or move it away to finish: ${stayed.changed.join(', ')}`)
          continue
        }
        const told = (files: string[], one: string, many: (n: number) => string, then = '') =>
          files.length && say(`${label}: ${files.length === 1 ? one : many(files.length)}${forLog ? '' : `${then}: ${files.join(', ')}`}`)
        told(
          stayed?.outside ?? [],
          `one file that It has a note of putting there is not inside ${label}’s own folder now, and was not touched`,
          (n) => `${n} files that It has a note of putting there are not inside ${label}’s own folder now, and were not touched`,
        )
        told(
          stayed?.closed ?? [],
          'one of the add-on’s files could not be looked at or taken out, so it was left as it is and the note of the add-on is kept',
          (n) => `${n} of the add-on’s files could not be looked at or taken out, so they were left as they are and the note of the add-on is kept`,
        )
        // A file the person changed is theirs, and stays. The add-on is not said to be gone
        // while a file of it is there.
        told(
          stayed?.changed ?? [],
          `one of the add-on’s files had been changed since It put it there, and was left where it is, so the add-on is not all gone from ${label}`,
          (n) =>
            `${n} of the add-on’s files had been changed since It put them there, and were left where they are, so the add-on is not all gone from ${label}`,
          `. Look at ${stayed?.changed.length === 1 ? 'it' : 'each'}, and delete it or move it away to finish`,
        )
        if (stayed?.closed.length || stayed?.changed.length) {
          // What is left is noted as an add-on that is not whole: asked for again, it is installed afresh
          was.version = 'installing'
          keep(id, left)
          continue
        }
        // Only the harness saying the add-on is gone counts. Still there, or a harness that could
        // not be asked, leaves the note that it was installed, and removal is tried again later.
        if ((await adapter.present(at, was)) !== false) {
          say(`${label}: the add-on could not be removed, or it could not be told whether it was; it will be tried again`)
          continue
        }
      }
    }
    // Each installation's note is kept until that installation is gone, and not after
    left = left.filter((i) => i !== was)
    if (left.length) keep(id, left)
  }
  if (left.length) return false
  rmSync(stampFile(id), { force: true })
  rmSync(addonDir(id), { recursive: true, force: true })
  rmSync(hookSeenFile(id), { force: true })
  return true
}

/** How long a program waits for another that is changing what is installed: longer than one pass over every agent app takes at its slowest. */
const INSTALLING_MS = 15 * 60_000
/**
 * One program at a time changes what is installed: `it setup` and the background connector can
 * both be asked to at the same moment. The lock is a file in It's folder, taken as the
 * backend's is, by the one exclusion there is for a lock that is free and for one that was
 * left behind. A program that holds it and lives keeps it for as long as its work takes, and
 * one that waits for it gives up after `forMs` and says that another is still at it. One left
 * behind by a program that is gone is taken over, by one of those that find it and no more.
 */
export async function alone<T>(work: () => Promise<T>, forMs = INSTALLING_MS): Promise<T> {
  let mine = false
  try {
    return await oneAtATime(
      'addons/setup',
      () => {
        mine = true
        return work()
      },
      forMs,
    )
  } catch (err) {
    if (mine || !(err instanceof Problem && err.code === 'busy')) throw err
    throw new Problem('Another `it` is still changing It’s add-ons in the agent apps on this machine.', 'busy', 'Run this again when it has finished.')
  }
}

/**
 * What went wrong, as it may be written to a log: one of the system's own codes for a file that
 * could not be read or written, or the one word "error". An error's own code, its name and its
 * words are all free text, and any of them can repeat a folder's name or what a person typed.
 */
const CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'EEXIST',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EMFILE',
  'ENFILE',
  'EXDEV',
  'ETIMEDOUT',
])
const coded = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && CODES.has(code) ? code : 'error'
}

let reconciling: Promise<void> = Promise.resolve()
/**
 * Makes the machine match what the person chose: connects what is wanted, removes what is not.
 * `forLog` is how the connector calls it: what went wrong is then said as a fixed word, never
 * in the words of a harness's own installer or of an error, which can hold a path or a name.
 */
export function reconcile(chosen: readonly string[] | (() => readonly string[]), say: (line: string) => void, forLog = false): Promise<void> {
  // One run's failure (the lock could not be had, say) is that run's alone: the next still runs
  reconciling = reconciling
    .catch(() => {})
    .then(() =>
      alone(async () => {
        // Whoever follows a choice that can change gives a way to ask for it, and it is asked
        // for here, once the add-ons are this run's alone to change: a run that waited its turn
        // behind another then goes by the choice as it stands, and undoes nothing the other did
        const wanted = typeof chosen === 'function' ? chosen() : chosen
        const only = process.env.IT_HARNESSES?.split(',').map((x) => x.trim())
        for (const id of HARNESSES) {
          if (!(id in ADAPTERS && id in ADDONS) || (only && !only.includes(id))) continue
          try {
            // An add-on that is held back is never installed, and one that was installed before
            // it was held back can still be taken out
            if (wanted.includes(id) && supported(id)) {
              const s = await connect(id, say, forLog)
              if (s.addon === 'error') say(forLog ? `${KNOWN[id].label}: its add-on could not be installed` : `${KNOWN[id].label}: ${s.detail}`)
            } else await disconnect(id, say, {}, forLog)
          } catch (err) {
            say(forLog ? `${KNOWN[id].label}: ${coded(err)}` : `${KNOWN[id].label}: ${(err as { message?: string }).message}`)
          }
        }
      }),
    )
  return reconciling
}
