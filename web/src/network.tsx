// Where another device opens It: the address a screen that is being added is sent to, and the
// address a machine that is to join is given. The site, opened as `localhost` on the machine It
// runs on, cannot know that machine's addresses by itself. The service that listens knows them,
// and tells the backend whether the network is on and at which addresses it is reached; the
// owner's browser reads that here, and what it shows changes by itself when `it network on` or
// `it network off` is run.
import { useQuery } from 'convex/react'
import { useState } from 'react'
import { api, pairingAddress } from './lib'

export interface Where {
  /**
   * `known` when there is an address to give. `off` while It answers the machine it runs on and
   * nothing else, and `nowhere` when the network is on and that machine has no address on one.
   * `unknown` until the backend has said.
   */
  state: 'unknown' | 'off' | 'nowhere' | 'known'
  /** The address to give: the one most likely to work, or the one the person chose instead. */
  address: string | null
  /** Every address there is to choose from, the likeliest first. */
  all: string[]
  choose(address: string): void
}

/** This browser's own address for the site, when another device could open it too: when it is not a name that only means this machine. */
const ownAddress = (): string | null => (pairingAddress('') === null ? null : location.origin)

/**
 * The addresses another device can open It at. The address this browser itself reached the
 * site by comes first when another device could use it, since it is known to work; then the
 * ones the service gave, in its order.
 */
export function useWhere(): Where {
  const said = useQuery(api.network.get, {}) as { on: boolean; addresses: string[] } | undefined
  const [chosen, choose] = useState<string | null>(null)
  const here = ownAddress()
  const all = [...new Set([...(here ? [here] : []), ...(said?.on ? said.addresses : [])])]
  const address = chosen !== null && all.includes(chosen) ? chosen : (all[0] ?? null)
  return { state: address !== null ? 'known' : said === undefined ? 'unknown' : said.on ? 'nowhere' : 'off', address, all, choose }
}

/** The machine's other addresses, for when the first is not the one the other device can open: its other network, or IPv6. Nothing when there is only one. */
export function OtherAddresses({ where }: { where: Where }) {
  if (where.all.length < 2 || where.address === null) return null
  return (
    <p className="muted">
      <label>
        The machine It runs on has more than one address. If the other device cannot open that one, choose another:{' '}
        <select value={where.address} onChange={(e) => where.choose(e.target.value)}>
          {where.all.map((address) => (
            <option key={address} value={address}>
              {address}
            </option>
          ))}
        </select>
      </label>
    </p>
  )
}

/**
 * What is said in place of an address when there is none to give: that the network has to be
 * turned on, or that the machine is on no network. `appears` names what will show here once
 * there is one.
 */
export function NoAddress({ where, appears }: { where: Where; appears: string }) {
  if (where.state === 'off')
    return (
      <p>
        It answers only the machine it runs on until the network is turned on, so no other device can open it yet. Run <code>it network on</code> on that
        machine, and {appears} appears here.
      </p>
    )
  if (where.state === 'nowhere')
    return <p>The network is on, but the machine It runs on has no address on a network just now. Once it is on one, {appears} appears here.</p>
  return null
}
