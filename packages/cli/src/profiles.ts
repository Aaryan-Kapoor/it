import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Only paths that choose an app's profile are kept. Credentials and inline settings are never copied. */
const KEYS: Record<string, string[]> = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  pi: ['PI_CODING_AGENT_DIR'],
  hermes: ['HERMES_HOME'],
  opencode: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG'],
}

export interface Profile {
  version: 1
  paths: Record<string, string | null>
  unsupported?: true
  configPresent?: boolean
}

/** Capture defaults too, so a service's other profile cannot silently replace them. */
export function profileOf(harness: string, env: NodeJS.ProcessEnv = process.env): Profile | undefined {
  const keys = KEYS[harness]
  if (!keys) return undefined
  const own = (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || os.homedir()
  const defaults: Record<string, string> = {
    CLAUDE_CONFIG_DIR: path.join(own, '.claude'),
    CODEX_HOME: path.join(own, '.codex'),
    PI_CODING_AGENT_DIR: path.join(own, '.pi', 'agent'),
    HERMES_HOME: path.join(own, '.hermes'),
    XDG_CONFIG_HOME: path.join(own, '.config'),
    XDG_DATA_HOME: path.join(own, '.local', 'share'),
    XDG_STATE_HOME: path.join(own, '.local', 'state'),
    XDG_CACHE_HOME: path.join(own, '.cache'),
  }
  const paths = Object.fromEntries(keys.map((key) => [key, env[key] || defaults[key] || null]))
  const unsupported =
    Object.values(paths).some((p) => p !== null && (!path.isAbsolute(p) || p.length > 4096 || p.includes('\0'))) ||
    (harness === 'opencode' && Boolean(env.OPENCODE_CONFIG_CONTENT))
  return {
    version: 1,
    paths,
    ...(harness === 'opencode' ? { configPresent: existsSync(path.join(paths.XDG_CONFIG_HOME!, 'opencode')) } : {}),
    ...(unsupported ? { unsupported: true } : {}),
  }
}

/** A local record or authenticated add-on may still send malformed data. Accept exactly the path allow-list. */
export function readProfile(harness: string, value: unknown): Profile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const p = value as Profile
  const keys = KEYS[harness]
  if (!keys || p.version !== 1 || !p.paths || typeof p.paths !== 'object' || Array.isArray(p.paths)) return undefined
  if (Object.keys(p.paths).length !== keys.length || keys.some((key) => !Object.hasOwn(p.paths, key))) return undefined
  if (Object.values(p.paths).some((v) => v !== null && (typeof v !== 'string' || !path.isAbsolute(v) || v.length > 4096 || v.includes('\0')))) return undefined
  const required = harness === 'opencode' ? keys.slice(0, 4) : keys
  if (required.some((key) => p.paths[key] === null)) return undefined
  if (p.configPresent !== undefined && typeof p.configPresent !== 'boolean') return undefined
  return {
    version: 1,
    paths: Object.fromEntries(keys.map((key) => [key, p.paths[key]!])),
    ...(harness === 'opencode' ? { configPresent: p.configPresent === true } : {}),
    ...(p.unsupported ? { unsupported: true } : {}),
  }
}

/** Restore a recorded profile without substituting the service's profile if it is gone. */
export function profileEnvironment(harness: string, value: unknown, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv | string {
  // Conversations recorded before profiles were kept used the service's own environment.
  // Keep that behaviour until the conversation records its profile by publishing or reporting again.
  if (value === undefined) return { ...base }
  const profile = readProfile(harness, value)
  if (!profile) return 'its app profile is not recorded; open the conversation and publish its page again'
  if (profile.unsupported) return 'its app profile uses settings It cannot safely restore; open the conversation to receive its clicks'
  // OpenCode can run with no user config directory. A directory known to have existed must still be there.
  const roots =
    harness === 'opencode'
      ? [
          path.join(profile.paths.XDG_DATA_HOME!, 'opencode'),
          ...(profile.configPresent ? [path.join(profile.paths.XDG_CONFIG_HOME!, 'opencode')] : []),
          profile.paths.OPENCODE_CONFIG_DIR,
          profile.paths.OPENCODE_CONFIG,
        ]
      : Object.values(profile.paths)
  if (roots.some((p) => p !== null && p !== undefined && !existsSync(p)))
    return 'its recorded app profile is gone; restore that profile or open the conversation and publish its page again'
  const env = { ...base }
  for (const [key, value] of Object.entries(profile.paths)) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  // Inline configuration belongs to the service, never to the recorded conversation.
  if (harness === 'opencode') delete env.OPENCODE_CONFIG_CONTENT
  return env
}
