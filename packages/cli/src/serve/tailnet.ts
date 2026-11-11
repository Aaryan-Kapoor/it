// A tailnet is a private network of a person's own devices, made by Tailscale: each device has
// an address there that only the others can reach, wherever they are. It can be told to answer
// its tailnet alone, which is how a person reaches an It on a machine with no screen, or from
// outside their home, without opening it to every device on whatever network the machine is on.
//
// A device's addresses on a tailnet are known by their ranges, which Tailscale gives out of and
// nothing else on a network does: 100.64.0.0/10 under IPv4, and fd7a:115c:a1e0::/48 under IPv6.
import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'

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
    execFileSync('tailscale', ['status', '--json', '--peers=false'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }),
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

/** Public Funnel listeners that forward to one of It's ports, regardless of their external port. */
export function funnelPorts(status: unknown, ports: number[]): number[] {
  const s = status as {
    AllowFunnel?: Record<string, unknown>
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>
    TCP?: Record<string, { TCPForward?: unknown }>
    Foreground?: Record<string, unknown>
  } | null
  const found = Object.entries(s?.AllowFunnel ?? {})
    .filter(([host, allowed]) => {
      if (allowed !== true) return false
      const at = host.slice(host.lastIndexOf(':') + 1)
      const targets = [...Object.values(s?.Web?.[host]?.Handlers ?? {}).map((handler) => handler.Proxy), s?.TCP?.[at]?.TCPForward]
      return targets.some((target) => {
        if (typeof target !== 'string') return false
        try {
          const url = new URL(target.includes('://') ? target : `tcp://${target}`)
          return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
        } catch {
          return false
        }
      })
    })
    .map(([host]) => Number(host.slice(host.lastIndexOf(':') + 1)))
  return [...new Set([...found, ...Object.values(s?.Foreground ?? {}).flatMap((entry) => funnelPorts(entry, ports))])]
}

/** Read-only inspection. Never changes the person's Tailscale configuration. */
export async function inspectFunnel(ports: number[]): Promise<number[] | undefined> {
  return new Promise<number[] | undefined>((resolve) => {
    execFile('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(error.code === 'ENOENT' ? [] : undefined)
      try {
        const status: unknown = JSON.parse(stdout)
        if (!status || typeof status !== 'object' || Array.isArray(status)) return resolve(undefined)
        resolve(funnelPorts(status, ports))
      } catch {
        resolve(undefined)
      }
    })
  }).catch(() => undefined)
}
let inspection: { key: string; at: number; value?: number[]; pending: boolean } | undefined
/** Refresh without blocking the service, with at most one inspection in flight. */
export function publicFunnel(ports: number[]): number[] | undefined {
  const key = ports.join(',')
  if (!inspection || (!inspection.pending && (inspection.key !== key || Date.now() - inspection.at > 5000))) {
    const next = { key, at: Date.now(), value: inspection?.key === key ? inspection.value : undefined, pending: true }
    inspection = next
    void inspectFunnel(ports).then((value) => {
      next.value = value
      next.at = Date.now()
      next.pending = false
    })
  }
  return inspection.key === key ? inspection.value : undefined
}

export function funnelWarning(funnel: 'off' | 'public' | 'unknown' | undefined): string | undefined {
  return funnel === 'public'
    ? 'Tailscale Funnel makes It public, even with the network off. Turn off the Funnel in Tailscale to keep It private.'
    : funnel === 'unknown'
      ? 'It could not check Tailscale Funnel. Check Tailscale before relying on the network setting to keep It private.'
      : undefined
}

/** An unknown proxy policy qualifies the listener's report without dropping it. */
export function funnelSaid(funnel: 'off' | 'public' | 'unknown' | undefined, said: string): string {
  const warning = funnelWarning(funnel)
  return funnel === 'unknown' ? `${warning}\n${said}` : (warning ?? said)
}
