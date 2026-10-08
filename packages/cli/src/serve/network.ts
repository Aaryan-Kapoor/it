// Where another device on the same network reaches this machine: the addresses It's site is
// opened at once the network is on. They are read from the system's own list of this machine's
// interfaces. The one most likely to work comes first, and the ones no other device could use
// are left out.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { inTailnet, tailnetName } from './tailnet'

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

/**
 * An address of this machine that anyone on the internet can ask: one under IPv4 that is in
 * none of the ranges kept for private networks, for one machine or one link, or for carriers.
 * A rented server has one, and a computer behind a home router has none. With one, "the network"
 * that It can be opened to is the internet, which whoever turns the network on has to be told.
 */
export function publicAddress(interfaces: Interfaces = os.networkInterfaces()): string | undefined {
  for (const [name, addresses] of Object.entries(interfaces))
    for (const a of addresses ?? []) {
      if (a.internal || a.family !== 'IPv4' || BRIDGE.test(name)) continue
      const [first = 0, second = 0, third = 0] = a.address.split('.').map(Number)
      const kept =
        first === 0 ||
        first === 10 ||
        first === 127 ||
        first >= 224 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 192 && second === 0 && third === 0) ||
        (first === 198 && (second === 18 || second === 19))
      if (!kept) return a.address
    }
  return undefined
}

/**
 * An address of this machine under IPv6 that is one of the internet's own (2000::/3), and not
 * one kept for a private network, one link or one machine. A rented server has one, and so
 * has many a computer at home: there, whether the internet reaches it is the router's doing.
 */
export function publicAddress6(interfaces: Interfaces = os.networkInterfaces()): string | undefined {
  for (const [name, addresses] of Object.entries(interfaces))
    for (const a of addresses ?? []) {
      if (a.internal || a.family !== 'IPv6' || BRIDGE.test(name)) continue
      if (/^[23][0-9a-f]{3}:/i.test(a.address)) return a.address
    }
  return undefined
}

/**
 * Whose machine this is, where it says of itself that it is rented from one of the companies
 * that rent servers: such a machine is on the internet by an address that is not written on it
 * anywhere, and all it shows is an address of a private network. Read from what the machine's
 * firmware says of its maker, on Linux, and nothing where that says nothing.
 */
export function rentedFrom(read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | undefined {
  if (process.platform !== 'linux') return undefined
  const said = ['sys_vendor', 'product_name', 'chassis_vendor', 'bios_vendor', 'chassis_asset_tag']
    .map((name) => {
      try {
        return read(`/sys/class/dmi/id/${name}`).trim()
      } catch {
        return ''
      }
    })
    .join('\n')
  const known: [RegExp, string][] = [
    [/amazon ec2|^amazon/im, 'Amazon'],
    [/google compute engine|^google$/im, 'Google Cloud'],
    [/7783-7084-3265-9085-8269-3286-77|^microsoft corporation[\s\S]*virtual machine/im, 'Microsoft Azure'],
    [/digitalocean/i, 'DigitalOcean'],
    [/hetzner/i, 'Hetzner'],
    [/vultr/i, 'Vultr'],
    [/linode|akamai/i, 'Linode'],
    [/ovh/i, 'OVH'],
    [/scaleway/i, 'Scaleway'],
    [/oraclecloud/i, 'Oracle Cloud'],
    [/alibaba cloud/i, 'Alibaba Cloud'],
    [/upcloud/i, 'UpCloud'],
  ]
  return known.find(([like]) => like.test(said))?.[1]
}

/**
 * Why turning the network on would open It to the internet on this machine, in words that
 * finish "This machine …", and nothing where there is no sign that it would. Whoever turns the
 * network on is told, and nobody is led to it by pressing Enter.
 */
export function onTheInternet(
  interfaces: Interfaces = os.networkInterfaces(),
  rented: string | undefined = rentedFrom(),
): { address?: string; why: string } | undefined {
  const four = publicAddress(interfaces)
  if (four) return { address: four, why: `has a public address (${four})` }
  if (rented) return { why: `is a server rented from ${rented}, which the internet reaches by an address of its own` }
  const six = publicAddress6(interfaces)
  if (six) return { address: six, why: `has an address the internet can reach unless a router or a firewall in between stops it (${six})` }
  return undefined
}

/** The most addresses that are listed. A machine may have a dozen under IPv6, each as good as the next. */
const MOST = 8

/**
 * The addresses at which another device on the same network can open the site, as whole
 * addresses with the port, the one most likely to work first: an address of the home network,
 * then any other under IPv4, then those of a tunnel, then IPv6. Loopback, addresses that mean
 * something on one link only, and the bridges to this machine's own containers and virtual
 * machines are left out. With `tailnet`, It answers the person's tailnet alone: the machine's
 * name there comes first, where it is known, and then its addresses there, and nothing else.
 */
export function reachable(
  port: number,
  interfaces: Interfaces = os.networkInterfaces(),
  tailnet = false,
  named: () => string | undefined = tailnetName,
): string[] {
  const found: { at: string; rank: number }[] = []
  // On a tailnet the machine has a name there, which goes on working when its addresses change
  const name = tailnet ? named() : undefined
  if (name) found.push({ at: `http://${name}:${port}`, rank: -1 })
  for (const [name, addresses] of Object.entries(interfaces))
    for (const a of addresses ?? []) {
      // Kept to the tailnet, only its addresses there are ones another device can use
      const ranked = tailnet ? (a.internal || !inTailnet(a.address) ? undefined : a.family === 'IPv4' ? 0 : 1) : rank(name, a)
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
