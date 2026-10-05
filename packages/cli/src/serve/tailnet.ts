// A tailnet is a private network of a person's own devices, made by Tailscale: each device has
// an address there that only the others can reach, wherever they are. It can be told to answer
// its tailnet alone, which is how a person reaches an It on a machine with no screen, or from
// outside their home, without opening it to every device on whatever network the machine is on.
//
// A device's addresses on a tailnet are known by their ranges, which Tailscale gives out of and
// nothing else on a network does: 100.64.0.0/10 under IPv4, and fd7a:115c:a1e0::/48 under IPv6.
import { execFileSync } from 'node:child_process'
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
