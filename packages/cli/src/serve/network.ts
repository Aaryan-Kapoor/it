// Where another device on the same network reaches this machine: the addresses It's site is
// opened at once the network is on. They are read from the system's own list of this machine's
// interfaces. The one most likely to work comes first, and the ones no other device could use
// are left out.
import os from 'node:os'

/** An address of this machine as the system lists it, under the name of the interface it is on. */
type Listed = Pick<os.NetworkInterfaceInfo, 'address' | 'family' | 'internal'>
type Interfaces = NodeJS.Dict<Listed[]>

/**
 * Interfaces that join this machine to containers and virtual machines of its own, by the names
 * each system and each such program gives them. What is on the other side of one is inside this
 * machine, and no screen on the person's network reaches it there.
 */
const BRIDGE =
  /^(docker\d|br-[0-9a-f]{12}$|veth|virbr|vboxnet|vmnet|lxcbr|lxdbr|cni|flannel|cali|podman|bridge\d{3}|vethernet \(|virtualbox host-only|vmware network adapter)/i
/** Interfaces that are one end of a private tunnel. A device on the same tunnel reaches this machine by them, and a screen on the home network does not. */
const TUNNEL = /^(tun|tap|utun|wg|tailscale|ppp|zt|ipsec|nordlynx)|vpn|wireguard|tailscale|zerotier/i

/** How likely an address is to be the one a screen on the home network can open: the lower the likelier, and nothing for one that no other device can use. */
function rank(name: string, a: Listed): number | undefined {
  if (a.internal || BRIDGE.test(name)) return undefined
  const tunnel = TUNNEL.test(name)
  if (a.family === 'IPv4') {
    const [first = 0, second = 0] = a.address.split('.').map(Number)
    if (first === 127 || first === 0) return undefined
    // An address a machine gives itself when nothing on the network gave it one
    if (first === 169 && second === 254) return 3
    if (tunnel) return 2
    const home = first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
    return home ? 0 : 1
  }
  const address = a.address.toLowerCase()
  // An address that means something on one link only is written with the link's name on this machine, which no other device knows
  if (address === '::1' || address === '::' || /^fe[89ab]/.test(address) || address.startsWith('ff')) return undefined
  if (tunnel) return 6
  return /^f[cd]/.test(address) ? 4 : 5
}

/** The most addresses that are listed. A machine may have a dozen under IPv6, each as good as the next. */
const MOST = 8

/**
 * The addresses at which another device on the same network can open the site, as whole
 * addresses with the port, the one most likely to work first: an address of the home network,
 * then any other under IPv4, then those of a tunnel, then IPv6. Loopback, addresses that mean
 * something on one link only, and the bridges to this machine's own containers and virtual
 * machines are left out.
 */
export function reachable(port: number, interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: { at: string; rank: number }[] = []
  for (const [name, addresses] of Object.entries(interfaces))
    for (const a of addresses ?? []) {
      const ranked = rank(name, a)
      if (ranked === undefined) continue
      let at: string
      try {
        at = new URL(`http://${a.family === 'IPv6' ? `[${a.address.split('%')[0]}]` : a.address}:${port}`).origin
      } catch {
        continue
      }
      if (!found.some((f) => f.at === at)) found.push({ at, rank: ranked })
    }
  // Within one kind they stay in the order the system lists its interfaces
  return found
    .map((f, n) => ({ ...f, n }))
    .sort((a, b) => a.rank - b.rank || a.n - b.n)
    .slice(0, MOST)
    .map((f) => f.at)
}
