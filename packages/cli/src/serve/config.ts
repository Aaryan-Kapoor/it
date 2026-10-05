// It's settings on the machine it runs on. They are one file in It's folder, made the first
// time `it setup` runs: the port everything is counted from, and the secrets the service works
// with. Whoever can read the file can do anything to It's data, so it is this person's alone.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { PORTS } from '@it/protocol'
import { asPort, home, inHome, Problem, portAsked, readJson, settingsFile, writeFlushed, writePrivate as writeWhole } from '../lib'

// How a record is written lives with everything else that writes into It's folder, and is
// given on from here under the names the service knows it by
export { rename, writeAll, writeFlushed, writePrivate as writeWhole } from '../lib'

export interface ServiceConfig {
  /** The port the door listens on. Every other port is counted from it. */
  port: number
  /** Whether the door answers other machines on the network, or this one alone. */
  network: boolean
  /** With the network on, whether the door answers the person's tailnet alone, and no other network this machine is on. */
  tailnet?: boolean
  /** What the backend program makes its own keys from. */
  instanceSecret: string
  /** What the service shows the backend to load functions into it and to run its internal ones. */
  adminKey: string
  /** What the pages' sessions are sealed with. */
  sessionSecret: string
  /** The hash of the functions and settings last loaded into the backend. There is none until a first load has worked. */
  functions?: string
  /** The release of the backend program that last ran on this folder's data. */
  backend?: string
}

/** The release of Convex's backend program that this version of It runs. */
export const RELEASE = 'precompiled-2026-09-28-5c7cb5b'
/** Where the backend keeps its database and its files, and where the program itself is kept. */
export const backendFolder = () => inHome('backend')
/**
 * The backend program: the one IT_BACKEND_BIN names, used as it is, or else the one fetched
 * for this release. Each release has a folder of its own, so that a program fetched for an
 * earlier one is never taken for this one's.
 */
export const programFile = () =>
  process.env.IT_BACKEND_BIN
    ? path.resolve(process.env.IT_BACKEND_BIN)
    : path.join(backendFolder(), 'bin', RELEASE, `convex-local-backend${process.platform === 'win32' ? '.exe' : ''}`)
/**
 * The name the backend runs under, which it says to whoever asks at its port. It follows from
 * the secret, so two folders on one machine never have the same one, and a backend that
 * answers with this name is this folder's.
 */
export const instanceName = (instanceSecret: string) => `it-${createHash('sha256').update(instanceSecret).digest('hex').slice(0, 12)}`

/** The settings as the file holds them. Null when there is no file, and a refusal when there is one that It did not write. */
function kept(): ServiceConfig | null {
  if (!existsSync(settingsFile())) return null
  const c = readJson<Record<string, unknown>>(settingsFile())
  const port = asPort(c?.port)
  if (
    !c ||
    port === undefined ||
    typeof c.network !== 'boolean' ||
    (c.tailnet !== undefined && typeof c.tailnet !== 'boolean') ||
    typeof c.instanceSecret !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.instanceSecret) ||
    typeof c.adminKey !== 'string' ||
    !c.adminKey ||
    typeof c.sessionSecret !== 'string' ||
    !c.sessionSecret ||
    (c.functions !== undefined && typeof c.functions !== 'string') ||
    (c.backend !== undefined && typeof c.backend !== 'string')
  )
    throw new Problem(
      `It’s settings in ${settingsFile()} are not as It wrote them.`,
      'settings',
      'They hold the keys to what It keeps on this machine, so It makes no new ones in their place. Put the file back as it was.',
    )
  return {
    port,
    network: c.network,
    ...(c.tailnet === true ? { tailnet: true } : {}),
    instanceSecret: c.instanceSecret,
    adminKey: c.adminKey,
    sessionSecret: c.sessionSecret,
    ...(c.functions === undefined ? {} : { functions: c.functions }),
    ...(c.backend === undefined ? {} : { backend: c.backend }),
  }
}

/** It's settings, with the port IT_PORT names in place of the file's when it names one. Null where It has not been set up. */
export function readConfig(): ServiceConfig | null {
  const config = kept()
  return config && { ...config, port: portAsked() ?? config.port }
}

/**
 * The key the backend takes as its administrator's, which the backend program itself makes
 * from its secret. So the program has to be on this machine before the settings can be made.
 */
function adminKey(instanceSecret: string): string {
  const ran = spawnSync(programFile(), ['keygen', 'admin-key', '--instance-name', instanceName(instanceSecret), '--instance-secret', instanceSecret], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  const key = ran.status === 0 ? ran.stdout.trim() : ''
  if (!key.startsWith(`${instanceName(instanceSecret)}|`))
    throw new Problem('The backend program could not make the key It runs it with.', 'backend_program', `It is the program at ${programFile()}.`)
  return key
}

/**
 * Gives a file that has been written whole its name, where nothing has that name yet. A second
 * name for a file is given in one step and only where the name is free, so of all the programs
 * that try at the same moment one does it, and what the others then find under the name is
 * finished. Whether this program was the one. The file's first name is taken away either way.
 *
 * This is the only way It makes a file that must be made once: its settings, and its locks.
 * A disk that cannot give a file a second name has no other step that only one program can
 * take and that leaves nothing half made for another to find. So It does not keep its folder
 * on such a disk, and says so here.
 */
export function makeOnce(whole: string, file: string): boolean {
  try {
    linkSync(whole, file)
    return true
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException).code ?? '')
    if (code === 'EEXIST') return false
    throw new Problem(
      `It cannot keep its folder at ${home()}: the disk it is on did not let It make a file there in the one way that only one program at a time can${/^E[A-Z0-9_]{2,30}$/.test(code) ? ` (${code})` : ''}.`,
      'home_unfit',
      'The folder has to be on a disk of this computer’s own, and not on a memory stick or a network share. IT_HOME names another folder for It.',
    )
  } finally {
    rmSync(whole, { force: true })
  }
}

/**
 * That a record It keeps and acts on is there and is not as It wrote it. Such a record is
 * never taken for one that says nothing: whatever would have acted on it stops here, and the
 * person is told which file it is and what they can do.
 */
export const unread = (said: string, todo: string) => new Problem(said, 'record_unread', todo)

/**
 * Makes the settings, on a first run: the secrets are made here, and the file is written for
 * this person alone. It is written whole or not at all, and only where there is none: settings
 * that are already there are given back as they are, and never made again. Of two programs
 * that make the settings at the same moment, one's are kept and both use them.
 */
export function makeConfig(): ServiceConfig {
  const existing = readConfig()
  if (existing) return existing
  const instanceSecret = randomBytes(32).toString('hex')
  const config: ServiceConfig = {
    port: portAsked() ?? PORTS.base,
    network: false,
    instanceSecret,
    adminKey: adminKey(instanceSecret),
    sessionSecret: randomBytes(32).toString('base64url'),
  }
  const file = settingsFile()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const whole = `${file}.${process.pid}.tmp`
  writeFlushed(whole, JSON.stringify(config, null, 1))
  if (makeOnce(whole, file)) return readConfig() ?? config
  // Another program made them first, and those are the settings
  const theirs = readConfig()
  if (!theirs) throw new Problem(`It’s settings in ${file} were removed while they were being read.`, 'settings', 'Run `it setup` again.')
  return theirs
}

/**
 * Turns the network on or off in the settings, which are otherwise left as the file has them.
 * `tailnet` says that, on, it is the person's tailnet alone that is answered.
 * The running service looks there every second, and opens its door anew when this has changed.
 * False where there are no settings to change.
 */
export function noteNetwork(network: boolean, tailnet = false): boolean {
  const config = kept()
  // The tailnet alone is a way of being on, and is not kept once the network is off
  const only = network && tailnet
  if (config && (config.network !== network || (config.tailnet === true) !== only)) {
    const { tailnet: _, ...rest } = config
    writeWhole(settingsFile(), { ...rest, network, ...(only ? { tailnet: true } : {}) })
  }
  return config !== null
}

/** Notes what was last loaded into the backend, and which release ran, beside settings that are otherwise left as the file has them. */
export function noteLoaded(loaded: Pick<ServiceConfig, 'functions' | 'backend'>): void {
  const config = kept()
  if (config) writeWhole(settingsFile(), { ...config, ...loaded })
}

/**
 * What the door shows the backend with a request about a session. The backend is given the same
 * words as a setting, and answers such a request only when it carries them: a browser that
 * reaches the backend's own port, with nothing of the door's in between, is answered nothing.
 */
export const doorKey = (config: ServiceConfig): string => createHmac('sha256', config.sessionSecret).update('it-door').digest('base64url')
