// A tailnet is a private network of a person's own devices, made by Tailscale: each device has
// an address there that only the others can reach, wherever they are. It can be told to answer
// its tailnet alone, which is how a person reaches an It on a machine with no screen, or from
// outside their home, without opening it to every device on whatever network the machine is on.
//
// A device's addresses on a tailnet are known by their ranges, which Tailscale gives out of and
// nothing else on a network does: 100.64.0.0/10 under IPv4, and fd7a:115c:a1e0::/48 under IPv6.
import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Listed = Pick<os.NetworkInterfaceInfo, 'address' | 'family' | 'internal'>
type Interfaces = NodeJS.Dict<Listed[]>

/** Whether an address is one of a tailnet's. One under IPv4 that arrives written as IPv6 is read as what it is. */
export function inTailnet(address: string): boolean {
  const plain = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
  const four = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(plain)
  if (four) return Number(four[1]) === 100 && Number(four[2]) >= 64 && Number(four[2]) <= 127
  return /^fd7a:115c:a1e0:/.test(plain)
}

/** Whether an address is this machine itself. */
export const isLoopback = (address: string): boolean => /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^::1$/.test(address.toLowerCase().replace(/^\[|\]$/g, ''))

/** This machine's addresses on a tailnet, IPv4 first. None where it is on none. */
export function tailnetAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: string[] = []
  for (const addresses of Object.values(interfaces))
    for (const a of addresses ?? []) {
      const address = a.address.split('%')[0]!
      if (!a.internal && inTailnet(address) && !found.includes(address)) found.push(address)
    }
  return found.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
}

let asked: { at: number; name: string | undefined } | undefined
/**
 * The name this machine has on its tailnet, such as `studio.tail1234.ts.net`, where Tailscale's
 * own command is there to say it. Asked at most once a minute, and given a moment to answer:
 * a tailnet works without the name, by the machine's addresses there.
 */
export function tailnetName(
  ask: () => string = () =>
    execFileSync(tailscaleCommand() ?? 'tailscale', ['status', '--json', '--peers=false'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
): string | undefined {
  if (asked && Date.now() - asked.at < 60_000) return asked.name
  let name: string | undefined
  try {
    const said = (JSON.parse(ask()) as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName
    // A name a browser can open and a policy can say: letters, digits, dots and hyphens
    if (typeof said === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(said)) name = said.replace(/\.$/, '').toLowerCase()
  } catch {}
  asked = { at: Date.now(), name }
  return name
}
/** Forgets what was last heard of the tailnet's name, so that it is asked again. For tests. */
export const forgetTailnetName = () => {
  asked = undefined
}

/**
 * What Tailscale on this machine takes on the port it would take https at for one of It's two
 * (`at`): https, handed on whole to It's port `to` on this machine, which is It's own (`its`);
 * nothing (`free`); or something else, which is another program's and is left as it is. Read
 * from `tailscale serve status --json`.
 */
export function servedAs(status: unknown, name: string, at: number, to: number): 'its' | 'free' | 'other' {
  const s = status as { TCP?: Record<string, Record<string, unknown>>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null
  const tcp = s?.TCP?.[String(at)]
  if (!tcp) return 'free'
  const handlers = s?.Web?.[`${name}:${at}`]?.Handlers ?? {}
  const proxies = Object.entries(handlers)
  const its = tcp.HTTPS === true && proxies.length === 1 && proxies[0]![0] === '/' && proxies[0]![1].Proxy === `http://127.0.0.1:${to}`
  return its ? 'its' : 'other'
}

/**
 * What a forward reaches: this machine (`here`), another machine (`elsewhere`), or a place It
 * cannot be sure of (`unsure`), such as a name that the system looks up.
 */
type Reach = 'here' | 'elsewhere' | 'unsure'

/** This machine as a forward can name it: each address it has, written as `canonical` writes one, and its own names. */
export type Here = { addresses: Set<string>; names: Set<string> }

/**
 * A host as the WHATWG URL parser writes it: an IPv4 address in four decimal parts, whatever
 * form it was given in, an IPv6 one in brackets, compressed and in lower case, with no zone,
 * and a name in lower case without a final dot. Nothing for a host that is none of these.
 */
function canonical(host: string): string | undefined {
  const h = host.toLowerCase().replace(/^(\[[^\]%]*)%[^\]]*\]$/, '$1]')
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/.test(h)) return undefined
  try {
    const written = new URL(`http://${h}/`).hostname.replace(/\.$/, '')
    // An IPv4 address written as IPv6 is read as the IPv4 address it is
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(written)
    if (!mapped) return written || undefined
    const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)]
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  } catch {
    return undefined
  }
}

/**
 * Names that are this machine wherever they are looked up: `localhost` and every name under it,
 * and the names Linux distributions give loopback in `/etc/hosts`.
 */
const LOOPBACK_NAME = /^(?:(?:[a-z0-9_-]+\.)*localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$/

/**
 * This machine's own addresses, each of every interface whether or not the door listens there,
 * and its own names: its host name, that name under `.local`, and the names Tailscale serves at.
 * A forward to any of them reaches It whenever the network is on, which the site can turn on at
 * any moment, so it counts whatever the network setting.
 */
export function thisMachine(interfaces: Interfaces = os.networkInterfaces(), host = os.hostname()): Here {
  const addresses = new Set<string>()
  for (const listed of Object.values(interfaces))
    for (const a of listed ?? []) {
      const written = canonical(a.address.includes(':') ? `[${a.address}]` : a.address)
      if (written) addresses.add(written)
    }
  const name = host.toLowerCase().replace(/\.$/, '')
  return { addresses, names: new Set(name ? [name, ...(name.includes('.') ? [] : [`${name}.local`])] : []) }
}

function reach(host: string, here: Here): Reach {
  const written = canonical(host)
  if (!written) return 'unsure'
  // Every address of 127.0.0.0/8 is loopback, and an unspecified address is taken for this machine when it is dialled
  if (/^\d+\.\d+\.\d+\.\d+$/.test(written)) return written.startsWith('127.') || written === '0.0.0.0' || here.addresses.has(written) ? 'here' : 'elsewhere'
  if (written.startsWith('[')) return written === '[::1]' || written === '[::]' || here.addresses.has(written) ? 'here' : 'elsewhere'
  return LOOPBACK_NAME.test(written) || here.names.has(written) ? 'here' : 'unsure'
}

/**
 * Where a forward of Tailscale's goes, in each form its target parser takes and its status
 * writes: a bare port, which is 127.0.0.1's; `host:port`; or a URL with or without a path, whose
 * port is its scheme's where it names none. A Unix socket is no port of It's (`socket`), and a
 * target that cannot be read gives nothing.
 */
function forwardOf(target: unknown, fallback: 'http' | 'tcp'): { host: string; port: number } | 'socket' | undefined {
  if (typeof target !== 'string') return undefined
  const t = target.trim()
  if (/^\d+$/.test(t)) return { host: '127.0.0.1', port: Number(t) }
  if (/^unix:/i.test(t)) return 'socket'
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(t)
  const kind = scheme ? scheme[1]!.toLowerCase() : fallback
  const authority = (scheme ? t.slice(scheme[0].length) : t).split(/[/?#]/)[0]!
  const parts = /^(\[[^\]]*\]|[^:[\]]+)(?::(\d*))?$/.exec(authority.slice(authority.lastIndexOf('@') + 1))
  if (!parts) return undefined
  const port = parts[2] ? Number(parts[2]) : kind === 'http' ? 80 : kind === 'https' || kind === 'https+insecure' ? 443 : undefined
  return port !== undefined && port > 0 && port <= 65535 ? { host: parts[1]!, port } : undefined
}

type ServeStatus = {
  AllowFunnel?: Record<string, unknown>
  Web?: Record<string, { Handlers?: Record<string, Record<string, unknown> | null> } | null>
  TCP?: Record<string, { TCPForward?: unknown } | null>
  Foreground?: Record<string, unknown>
} | null

/**
 * The public Funnel listeners whose forward reaches one of It's ports (`ports`) on this machine,
 * whatever port they listen on: a proxy of a path, for http or https, or a TCP forward, with or
 * without TLS ended first, in the saved settings or in a `tailscale funnel` still running in the
 * foreground. A forward reaches It where it goes to one of It's ports at loopback, at an
 * unspecified address, or at this machine's own addresses or names (`here`). Nothing where no
 * listener is shown to reach It and a forward at one of It's ports, or one that cannot be read,
 * could: a name the system looks up, or a target in a form It does not know.
 */
export function funnelPorts(status: unknown, ports: number[], here: Here = thisMachine()): number[] | undefined {
  const configs: ServeStatus[] = []
  const gather = (s: unknown) => {
    if (!s || typeof s !== 'object') return
    configs.push(s as ServeStatus)
    for (const entry of Object.values((s as ServeStatus)?.Foreground ?? {})) gather(entry)
  }
  gather(status)
  // The names Tailscale serves at are this machine's
  const names = new Set(here.names)
  for (const s of configs)
    for (const host of [...Object.keys(s?.AllowFunnel ?? {}), ...Object.keys(s?.Web ?? {})])
      names.add(host.slice(0, host.lastIndexOf(':')).toLowerCase().replace(/\.$/, ''))
  const known: Here = { addresses: here.addresses, names }
  const found = new Set<number>()
  let unsure = false
  for (const s of configs)
    for (const [host, allowed] of Object.entries(s?.AllowFunnel ?? {})) {
      if (allowed !== true) continue
      const at = Number(host.slice(host.lastIndexOf(':') + 1))
      const handlers = Object.values(s?.Web?.[host]?.Handlers ?? {})
      // A handler that serves files or words, or sends the browser elsewhere, forwards nothing
      const proxies = handlers.filter((handler) => !handler || typeof handler !== 'object' || 'Proxy' in handler).map((handler) => handler?.Proxy)
      const forwards = [...proxies.map((target) => forwardOf(target, 'http'))]
      const tcp = s?.TCP?.[String(at)]
      if (tcp && typeof tcp === 'object' && 'TCPForward' in tcp) forwards.push(forwardOf(tcp.TCPForward, 'tcp'))
      for (const forward of forwards) {
        if (forward === 'socket') continue
        const reached = forward ? (ports.includes(forward.port) ? reach(forward.host, known) : 'elsewhere') : 'unsure'
        if (reached === 'here' && Number.isInteger(at) && at > 0) found.add(at)
        else if (reached !== 'elsewhere') unsure = true
      }
    }
  return found.size ? [...found] : unsure ? undefined : []
}

/**
 * The system It looks for Tailscale on: which one it is, its environment, and a folder that the
 * usual places are under, which is the root of the disk but in tests. `service` says whether
 * Windows has the Tailscale service, where the system is Windows.
 */
export type System = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; root?: string; service?: () => Promise<boolean> }
const thisSystem = (): System => ({ platform: process.platform, env: process.env })

/** The places Tailscale's installers put its command on each system, where they are not on PATH. */
export function tailscalePlaces(system: System): string[] {
  if (system.platform === 'win32') {
    const programs = Object.entries(system.env).find(([key]) => key.toLowerCase() === 'programfiles')?.[1] || 'C:\\Program Files'
    return [path.win32.join(programs, 'Tailscale', 'tailscale.exe')]
  }
  if (system.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
  return ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']
}

const isFile = (file: string) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Tailscale's command on this machine: the first on PATH, and where PATH has none, the first in
 * the places its installers use. A service is often started with a shorter PATH than a person's
 * terminal has, and macOS starts one with none of the places Tailscale's app or Homebrew use.
 */
export function tailscaleCommand(system: System = thisSystem()): string | undefined {
  const windows = system.platform === 'win32'
  const join = windows ? path.win32.join : path.posix.join
  const listed = Object.entries(system.env).find(([key]) => (windows ? key.toLowerCase() === 'path' : key === 'PATH'))?.[1] ?? ''
  const onPath = listed
    .split(windows ? ';' : ':')
    .filter((dir) => dir && (windows ? path.win32.isAbsolute(dir) : dir.startsWith('/')))
    .map((dir) => join(dir, windows ? 'tailscale.exe' : 'tailscale'))
  const usual = tailscalePlaces(system).map((place) => `${system.root ?? ''}${place}`)
  return [...onPath, ...usual].find((file) => {
    if (!isFile(file)) return false
    if (windows) return true
    try {
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** Whether Windows has a service named Tailscale, as `sc.exe` says. Taken for there where `sc.exe` cannot say. */
const windowsService = (env: NodeJS.ProcessEnv) => () =>
  new Promise<boolean>((resolve) => {
    const windir = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] || 'C:\\Windows'
    execFile(path.win32.join(windir, 'System32', 'sc.exe'), ['query', 'Tailscale'], { timeout: 2000, windowsHide: true }, (error) => {
      // 1060: no such service is installed
      resolve(!(error && (error as { code?: unknown }).code === 1060))
    })
  })

const isSocket = (file: string) => {
  try {
    return statSync(file).isSocket()
  } catch {
    return false
  }
}

/**
 * Whether Tailscale's daemon is on this machine though its command was not found: its socket on
 * Linux, from its packages or its snap; the app, or the open-source daemon's socket, on macOS;
 * and the Tailscale service on Windows. A Funnel set up already keeps serving while the daemon
 * runs, whether or not It can find the command to ask it.
 */
export async function tailscaleDaemon(system: System = thisSystem()): Promise<boolean> {
  const root = system.root ?? ''
  if (system.platform === 'win32') return (system.service ?? windowsService(system.env))()
  if (system.platform === 'darwin') return existsSync(`${root}/Applications/Tailscale.app`) || isSocket(`${root}/var/run/tailscaled.socket`)
  return ['/var/run/tailscale/tailscaled.sock', '/run/tailscale/tailscaled.sock', '/var/snap/tailscale/common/socket/tailscaled.sock'].some((socket) =>
    isSocket(`${root}${socket}`),
  )
}

/**
 * Whether what Tailscale's command printed, failing, says that its daemon is not running. The
 * command looks through the system's processes for the daemon before it says so, and says that
 * it found one, and which, where it could not connect to one that runs.
 */
export const daemonDown = (said: string): boolean =>
  /failed to connect to local (?:tailscaled|tailscale)\b/i.test(said) &&
  /doesn't appear to be running|is tailscale running\?|is the tailscale service running\?/i.test(said) &&
  !/appears to be running as/i.test(said)

/**
 * Read-only inspection. Never changes the person's Tailscale configuration. The public Funnel
 * listeners that reach It, and none where Tailscale is shown not to be on this machine at all, or
 * its command says its daemon is not running, since no Funnel is up without the daemon. Nothing
 * where Tailscale is there and cannot be asked, or what it says cannot be read with certainty.
 */
export async function inspectFunnel(ports: number[], system: System = thisSystem(), timeout = 2000): Promise<number[] | undefined> {
  const command = tailscaleCommand(system)
  if (!command) return (await tailscaleDaemon(system).catch(() => true)) ? undefined : []
  return new Promise<number[] | undefined>((resolve) => {
    execFile(command, ['serve', 'status', '--json'], { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(!error.killed && daemonDown(`${stderr}\n${stdout}`) ? [] : undefined)
      try {
        // Tailscale prints nothing, or `null`, where nothing is served
        const status: unknown = stdout.trim() ? JSON.parse(stdout) : null
        if (status === null) return resolve([])
        if (typeof status !== 'object' || Array.isArray(status)) return resolve(undefined)
        resolve(funnelPorts(status, ports))
      } catch {
        resolve(undefined)
      }
    })
  }).catch(() => undefined)
}

/** How a Funnel stands for It: none reaches it (`off`), one does (`public`), or It could not tell (`unknown`). */
export type Funnel = 'off' | 'public' | 'unknown'
const funnelOf = (found: number[] | undefined): Funnel => (found === undefined ? 'unknown' : found.length ? 'public' : 'off')

/** How long the service waits between asking Tailscale, at first, and at most while the answer stays the same. */
const FUNNEL_EVERY_MS = 5000
const FUNNEL_AT_MOST_MS = 30_000
let inspection: { key: string; at: number; every: number; value?: Funnel; pending: boolean } | undefined
/**
 * How a Funnel stands for It's ports, as the service last heard, without waiting for Tailscale,
 * with at most one inspection in flight. Nothing until the first inspection has answered, so that
 * nothing is said of a Funnel before Tailscale has been heard. Tailscale is asked again five
 * seconds after it answered, and while the answer stays the same, after twice as long each time,
 * up to thirty seconds.
 */
export function funnelNow(ports: number[], inspect: (ports: number[]) => Promise<number[] | undefined> = inspectFunnel): Funnel | undefined {
  const key = ports.join(',')
  const known = inspection?.key === key ? inspection : undefined
  if (!inspection || (!inspection.pending && (!known || Date.now() - inspection.at > inspection.every))) {
    const next = { key, at: Date.now(), every: known?.every ?? FUNNEL_EVERY_MS, value: known?.value, pending: true }
    inspection = next
    void inspect(ports)
      .catch(() => undefined)
      .then((found) => {
        const value = funnelOf(found)
        next.every = value === next.value ? Math.min(next.every * 2, FUNNEL_AT_MOST_MS) : FUNNEL_EVERY_MS
        next.value = value
        next.at = Date.now()
        next.pending = false
      })
  }
  return inspection.key === key ? inspection.value : undefined
}
/** Forgets what the service last heard of a Funnel. For tests. */
export const forgetFunnel = () => {
  inspection = undefined
}

export function funnelWarning(funnel: Funnel | undefined): string | undefined {
  return funnel === 'public'
    ? 'Tailscale Funnel makes It public, even with the network off. Turn off the Funnel in Tailscale to keep It private.'
    : funnel === 'unknown'
      ? 'It could not check Tailscale Funnel. Check Tailscale before relying on the network setting to keep It private.'
      : undefined
}

/** The warning of a Funnel, where there is one to give, and then what was to be said, which it never replaces. */
export function funnelSaid(funnel: Funnel | undefined, said: string): string {
  const warning = funnelWarning(funnel)
  return warning ? `${warning}\n${said}` : said
}
