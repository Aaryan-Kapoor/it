import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { claudeFolder, profileEnvironment, profileOf, readProfile } from './src/profiles'
import { carryOn } from './src/wake'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-profile-'))
  made.push(dir)
  return dir
}

test.each([
  ['codex', 'CODEX_HOME'],
  ['claude-code', 'CLAUDE_CONFIG_DIR'],
  ['pi', 'PI_CODING_AGENT_DIR'],
  ['hermes', 'HERMES_HOME'],
])('A %s conversation restores its own profile and refuses a removed profile.', (app, key) => {
  const first = folder(),
    second = folder()
  const p = profileOf(app, { [key]: first, SECRET_KEY: 'never kept' })!
  expect(p.paths).toEqual({ [key]: first })
  expect(profileEnvironment(app, p, { [key]: second, PATH: '/bin' })).toEqual({ [key]: first, PATH: '/bin' })
  const q = profileOf(app, { [key]: second })!
  expect(profileEnvironment(app, q, { [key]: first })).toEqual({ [key]: second })
  rmSync(first, { recursive: true })
  expect(profileEnvironment(app, p, { [key]: second })).toMatch(/profile is gone/)
})

test('OpenCode restores config, data, state and cache together and clears another profile’s optional config.', () => {
  const first = folder(),
    second = folder()
  mkdirSync(path.join(first, 'data', 'opencode'), { recursive: true })
  mkdirSync(path.join(first, 'config', 'opencode'), { recursive: true })
  const config = path.join(first, 'custom.json')
  writeFileSync(config, '{}')
  const profile = profileOf('opencode', {
    XDG_CONFIG_HOME: path.join(first, 'config'),
    XDG_DATA_HOME: path.join(first, 'data'),
    XDG_STATE_HOME: path.join(first, 'state'),
    XDG_CACHE_HOME: path.join(first, 'cache'),
    OPENCODE_CONFIG: config,
  })!
  const restored = profileEnvironment('opencode', profile, {
    XDG_DATA_HOME: second,
    OPENCODE_CONFIG_DIR: second,
    OPENCODE_CONFIG_CONTENT: 'private inline config',
  })
  expect(restored).toEqual({
    XDG_CONFIG_HOME: path.join(first, 'config'),
    XDG_DATA_HOME: path.join(first, 'data'),
    XDG_STATE_HOME: path.join(first, 'state'),
    XDG_CACHE_HOME: path.join(first, 'cache'),
    OPENCODE_CONFIG: config,
  })
  rmSync(path.join(first, 'config'), { recursive: true })
  expect(profileEnvironment('opencode', profile, {})).toMatch(/profile is gone/)
  const inline = profileOf('opencode', { OPENCODE_CONFIG_CONTENT: 'never kept' })!
  expect(JSON.stringify(inline)).not.toContain('never kept')
  expect(profileEnvironment('opencode', inline, {})).toMatch(/cannot safely restore/)
})

test.each(['directory', 'symlink'])('The resumed child receives the recorded profile even when its service uses another one (%s).', async (kind) => {
  const target = folder()
  const first = kind === 'symlink' ? path.join(folder(), 'profile') : target
  if (kind === 'symlink') symlinkSync(target, first, 'junction')
  const second = folder()
  const env = profileEnvironment('codex', profileOf('codex', { CODEX_HOME: first }), { ...process.env, CODEX_HOME: second })
  expect(typeof env).toBe('object')
  if (typeof env === 'string') throw new Error(env)
  const output = path.join(first, 'received.json')
  const result = await carryOn(
    {
      app: 'The profile test process',
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.env.CODEX_HOME,process.cwd()]))', output],
      input: 'a test message',
    },
    first,
    { harness: 'codex', session: 'test-session' },
    { env },
  )
  expect(result).toBeNull()
  const [profile, cwd]: [string, string] = JSON.parse(readFileSync(output, 'utf8'))
  expect(profile).toBe(first)
  expect(realpathSync(cwd)).toBe(realpathSync(first))
})

test.each(['codex', 'claude-code', 'pi', 'hermes', 'opencode'])('A legacy %s conversation keeps the service’s own environment.', (app) => {
  const env = { CODEX_HOME: folder(), OPENCODE_CONFIG_CONTENT: 'the service configuration', PATH: '/bin' }
  expect(profileEnvironment(app, undefined, env)).toEqual(env)
})

test('Malformed profile records never fall back to the service’s profile.', () => {
  expect(profileEnvironment('codex', { version: 1, paths: { CODEX_HOME: null } }, { CODEX_HOME: folder() })).toMatch(/not recorded/)
  expect(readProfile('codex', { version: 1, paths: { CODEX_HOME: null } })).toBeUndefined()
  expect(readProfile('codex', { version: 1, paths: { CODEX_HOME: folder(), SECRET_KEY: 'no' } })).toBeUndefined()
  expect(readProfile('codex', { version: 1, paths: { CODEX_HOME: '../another' } })).toBeUndefined()
})

test('OpenCode with no global config directory can restore its intact data profile.', () => {
  const first = folder()
  mkdirSync(path.join(first, 'data', 'opencode'), { recursive: true })
  const profile = profileOf('opencode', { XDG_DATA_HOME: path.join(first, 'data'), XDG_CONFIG_HOME: path.join(first, 'config') })!
  expect(profile.configPresent).toBe(false)
  expect(typeof profileEnvironment('opencode', profile, {})).toBe('object')
  rmSync(path.join(first, 'data', 'opencode'), { recursive: true })
  expect(profileEnvironment('opencode', profile, {})).toMatch(/profile is gone/)
})

/** Runs what is given as if on another system, which is what decides the person's own folder. */
function on<T>(platform: NodeJS.Platform, run: () => T): T {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...was, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', was)
  }
}
/** What names a home on every system: HOME, and USERPROFILE, which Windows goes by. */
const homeIs = (home: string) => ({ HOME: home, USERPROFILE: home })
/** A home of its own with Claude Code's usual folder in it. */
const homeWithClaude = () => {
  const home = folder()
  mkdirSync(path.join(home, '.claude'))
  return home
}

test('A Claude Code conversation started with no CLAUDE_CONFIG_DIR is reopened with none, as a terminal starts it.', () => {
  const home = homeWithClaude()
  const profile = profileOf('claude-code', { ...homeIs(home), PATH: '/bin' })!
  // What is recorded is what 0.1.42 records too: the usual folder, named
  expect(profile.paths).toEqual({ CLAUDE_CONFIG_DIR: path.join(home, '.claude') })
  const env = profileEnvironment('claude-code', profile, { ...homeIs(home), PATH: '/bin' })
  expect(env).toEqual({ ...homeIs(home), PATH: '/bin' })
  expect(Object.hasOwn(env as object, 'CLAUDE_CONFIG_DIR')).toBe(false)
  // Its transcript and It's add-on are looked for in the folder Claude Code itself then uses
  expect(claudeFolder(env as NodeJS.ProcessEnv)).toBe(path.join(home, '.claude'))
})

test('A service with another CLAUDE_CONFIG_DIR does not hand it to a conversation that used the usual folder.', () => {
  const home = homeWithClaude()
  const other = folder()
  const profile = profileOf('claude-code', homeIs(home))!
  const env = profileEnvironment('claude-code', profile, { ...homeIs(home), CLAUDE_CONFIG_DIR: other, PATH: '/bin' })
  expect(env).toEqual({ ...homeIs(home), PATH: '/bin' })
  expect(claudeFolder(env as NodeJS.ProcessEnv)).toBe(path.join(home, '.claude'))
})

test('A Claude Code conversation started with another folder is reopened with that folder named, whatever the service has.', () => {
  const home = homeWithClaude()
  const other = folder()
  const profile = profileOf('claude-code', { ...homeIs(home), CLAUDE_CONFIG_DIR: other })!
  expect(profile.paths).toEqual({ CLAUDE_CONFIG_DIR: other })
  expect(profileEnvironment('claude-code', profile, homeIs(home))).toEqual({ ...homeIs(home), CLAUDE_CONFIG_DIR: other })
  expect(profileEnvironment('claude-code', profile, { ...homeIs(home), CLAUDE_CONFIG_DIR: path.join(home, '.claude') })).toEqual({
    ...homeIs(home),
    CLAUDE_CONFIG_DIR: other,
  })
  // A usual folder of another home is not this home's usual folder, and is named as it was recorded
  const elsewhere = homeWithClaude()
  const theirs = profileOf('claude-code', homeIs(elsewhere))!
  expect(profileEnvironment('claude-code', theirs, homeIs(home))).toEqual({ ...homeIs(home), CLAUDE_CONFIG_DIR: path.join(elsewhere, '.claude') })
})

test('The usual folder is the one under USERPROFILE on Windows and under HOME elsewhere.', () => {
  const profileHome = homeWithClaude()
  const shellHome = homeWithClaude()
  const base = { USERPROFILE: profileHome, HOME: shellHome }
  // Recorded on Windows with nothing set: the folder under USERPROFILE
  const windows = on('win32', () => profileOf('claude-code', base))!
  expect(windows.paths.CLAUDE_CONFIG_DIR).toBe(path.join(profileHome, '.claude'))
  expect(on('win32', () => profileEnvironment('claude-code', windows, base))).toEqual(base)
  // Windows does not tell the case of a folder's name apart
  const shouted = { ...base, USERPROFILE: profileHome.toUpperCase() }
  expect(on('win32', () => profileEnvironment('claude-code', windows, shouted))).toEqual(shouted)
  // On Linux or macOS that folder is not the usual one, and is named, and there case counts
  expect(on('linux', () => profileEnvironment('claude-code', windows, base))).toEqual({ ...base, CLAUDE_CONFIG_DIR: path.join(profileHome, '.claude') })
  // Recorded on Linux or macOS with nothing set: the folder under HOME
  const posix = on('darwin', () => profileOf('claude-code', base))!
  expect(posix.paths.CLAUDE_CONFIG_DIR).toBe(path.join(shellHome, '.claude'))
  expect(on('darwin', () => profileEnvironment('claude-code', posix, base))).toEqual(base)
  expect(on('darwin', () => profileEnvironment('claude-code', posix, { ...base, HOME: shellHome.toUpperCase() }))).toEqual({
    ...base,
    HOME: shellHome.toUpperCase(),
    CLAUDE_CONFIG_DIR: path.join(shellHome, '.claude'),
  })
  // Where the variable the reopened app finds its home by is not set, it would ask the system for
  // its home, which may be another: the recorded folder stays named
  const alone = { USERPROFILE: profileHome }
  expect(on('linux', () => profileEnvironment('claude-code', windows, alone))).toEqual({ ...alone, CLAUDE_CONFIG_DIR: path.join(profileHome, '.claude') })
  const shellOnly = { HOME: shellHome }
  expect(on('win32', () => profileEnvironment('claude-code', posix, shellOnly))).toEqual({ ...shellOnly, CLAUDE_CONFIG_DIR: path.join(shellHome, '.claude') })
})

test('Only Claude Code is reopened without its variable: the other apps keep their usual folder named.', () => {
  const home = folder()
  for (const dir of ['.codex', '.hermes', path.join('.pi', 'agent')]) mkdirSync(path.join(home, dir), { recursive: true })
  for (const [app, key] of [
    ['codex', 'CODEX_HOME'],
    ['pi', 'PI_CODING_AGENT_DIR'],
    ['hermes', 'HERMES_HOME'],
  ] as const) {
    const env = profileEnvironment(app, profileOf(app, { HOME: home }), { HOME: home }) as NodeJS.ProcessEnv
    expect(env[key]).toBe(profileOf(app, { HOME: home })!.paths[key])
  }
})

test('The reopened Claude Code process is given no CLAUDE_CONFIG_DIR where the conversation had none.', async () => {
  const home = homeWithClaude()
  const work = folder()
  const env = profileEnvironment('claude-code', profileOf('claude-code', homeIs(home)), { ...process.env, ...homeIs(home), CLAUDE_CONFIG_DIR: folder() })
  if (typeof env === 'string') throw new Error(env)
  const output = path.join(work, 'received.json')
  const result = await carryOn(
    {
      app: 'The profile test process',
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env.CLAUDE_CONFIG_DIR ?? null))', output],
      input: 'a test message',
    },
    work,
    { harness: 'claude-code', session: 'test-session' },
    { env },
  )
  expect(result).toBeNull()
  expect(JSON.parse(readFileSync(output, 'utf8'))).toBeNull()
})

test('Claude Code’s folder is the one CLAUDE_CONFIG_DIR names, even empty, and otherwise the usual one of the home it is given.', () => {
  const home = folder()
  expect(claudeFolder({ ...homeIs(home), CLAUDE_CONFIG_DIR: '' })).toBe('')
  expect(claudeFolder({ ...homeIs(home), CLAUDE_CONFIG_DIR: path.join(home, 'other') })).toBe(path.join(home, 'other'))
  expect(claudeFolder(homeIs(home))).toBe(path.join(home, '.claude'))
})
