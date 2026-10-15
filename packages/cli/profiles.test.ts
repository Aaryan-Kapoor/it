import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { profileEnvironment, profileOf, readProfile } from './src/profiles'
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

test('The resumed child receives the recorded profile even when its service uses another one.', async () => {
  const first = folder(),
    second = folder()
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
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([first, first])
})

test('Legacy and malformed profile records never fall back to the service’s profile.', () => {
  expect(profileEnvironment('codex', undefined, { CODEX_HOME: folder() })).toMatch(/not recorded/)
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
