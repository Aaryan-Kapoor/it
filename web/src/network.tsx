// Where another device opens It: the address a screen that is being added is sent to, and the
// address a machine that is to join is given. The site, opened as `localhost` on the machine It
// runs on, cannot know that machine's addresses by itself. The service that listens knows them,
// and tells the backend whether the network is on and at which addresses it is reached; the
// owner's browser reads that here, and what it shows changes by itself when `it network on` or
// `it network off` is run.
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Copyable } from './dialog'
import { api, pairingAddress, refusal, useNow } from './lib'

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
  // Compare destinations as origins, keeping the first spelling for display.
  const origins = new Map<string, string>()
  for (const address of [...(here ? [here] : []), ...(said?.on ? said.addresses : [])]) {
    const origin = new URL(address).origin
    if (!origins.has(origin)) origins.set(origin, address)
  }
  const all = [...origins.values()]
  const address = (chosen !== null ? origins.get(new URL(chosen).origin) : null) ?? all[0] ?? null
  return { state: address !== null ? 'known' : said === undefined ? 'unknown' : said.on ? 'nowhere' : 'off', address, all, choose }
}

/** The machine's other addresses, for when the first is not the one the other device can open: its other network, or IPv6. Nothing when there is only one. */
export function OtherAddresses({ where }: { where: Where }) {
  if (where.all.length < 2 || where.address === null) return null
  return (
    <label className="pair-other">
      <span>Cannot open it? Try another address</span>
      <select value={where.address} onChange={(e) => where.choose(e.target.value)}>
        {where.all.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The three ways the network can be: off, on for every network the machine is on, or on for the person's tailnet alone. */
export type Way = 'off' | 'on' | 'tailscale'
/** How the door stands, as the backend tells the owner's browser, with what was asked of it here and what became of that. */
interface Stands {
  on: boolean
  addresses: string[]
  tailnet?: boolean
  /** Whether the machine It runs on is on a tailnet. Null while its service has not said, as one of an earlier It never does. */
  canTailnet?: boolean | null
  /** Why "on" would mean the internet on that machine, in words that finish "This machine …", where it would. */
  exposed?: string | null
  /** What was asked and is not yet answered. When it was asked is the name it goes by. */
  asked?: { to: Way; at: number } | null
  /** What became of the last asking that was answered, and under `asked` which asking that was. */
  answered?: { to: Way; at: number; ok: boolean; why?: string; asked?: number } | null
  /** Where the links agents give are to be. Kept as chosen while It cannot be reached there. */
  link?: LinkWay
  /** Each place the links can be at as the network stands, by the address a link there is at. */
  links?: Partial<Record<LinkWay, string>> & { local: string }
}
/** How long an asking may go untaken before the person is told that It has not taken it. The service looks every second. */
export const UNTAKEN_MS = 8000
/** How long an asking is waited for at all. After that the choice is given back, with how the network stands, and nobody is left looking at a choice they cannot make. */
export const GIVEN_UP_MS = 30_000
/** What is said of an asking that came to nothing, by the service's one word for why. */
const WHY_NOT: Record<string, string> = {
  cannot_listen:
    'It could not listen on that machine’s network addresses, so the network is left off. Another program may have one of the ports It listens on there.',
  no_tailnet: 'That machine is on no tailnet, so there is none to keep It to.',
  too_late: 'It was not running to do that. Try it again.',
}
/** Whether this browser reached the site at a name that only means the machine It runs on. */
const onThatMachine = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

/**
 * The network as the owner turns it on and off from the site. Nothing is changed by the
 * asking itself: the service that listens takes it up within a second or two, opens its door
 * anew as `it network` has it do, and says what became of it, which is what is shown here.
 */
export function useNetwork() {
  const said = useQuery(api.network.get, {}) as Stands | undefined
  const asking = useMutation(api.network.ask)
  // Looked at again every second, for the two waits below. The time `useNow` gives is the
  // backend's, and is not what they are counted by: an asking is timed from when this browser
  // made it, by this browser's own clock, and one that is ahead of the backend's would
  // otherwise wait as much longer as it is ahead
  useNow(1000)
  /**
   * What was asked here and is not yet over: for which way, when by this browser's clock, and
   * the name the backend gave the asking, once it has. An answer is this asking's only if it
   * names it: with the site open in two tabs, the answer to what the other asked is not taken
   * for the answer to this, and what the other was refused is not said here.
   */
  const [mine, setMine] = useState<{ to: Way; at: number; id: number | null } | null>(null)
  /** When the last asking was made here, which is the one a refusal has to be of to be said here. */
  const last = useRef(0)
  /** Why what was last asked here did not come about, in a sentence, until something else is asked. */
  const [failed, setFailed] = useState('')
  const way: Way | undefined = said === undefined ? undefined : !said.on ? 'off' : said.tailnet ? 'tailscale' : 'on'
  useEffect(() => {
    if (!mine || mine.id === null || !said) return
    const answered = said.answered
    // Answered: it is over, and where it did not come about, why is said
    if (answered && answered.asked === mine.id) {
      setMine(null)
      setFailed(answered.ok ? '' : (WHY_NOT[answered.why ?? ''] ?? 'It could not do that.'))
    }
    // Another asking took its place before the service came to it, here or in another tab: it
    // is over too, and nothing is said of it. The choice shows how the network stands
    else if ((said.asked && said.asked.at !== mine.id) || (answered && (answered.asked ?? 0) > mine.id)) setMine(null)
  }, [mine, said])
  // Never waited for for ever: an asking that nothing is heard of gives the choice back
  const givenUp = mine !== null && Date.now() - mine.at > GIVEN_UP_MS
  useEffect(() => {
    if (!givenUp) return
    setMine(null)
    setFailed('It has not said what became of that. The choice shows how the network stands now.')
  }, [givenUp])
  const waiting = mine !== null
  const ask = useCallback(
    (to: Way) => {
      if (!said || waiting) return
      // What "on" means on a machine the internet reaches is said before it is done, and so is
      // what a browser that came over the network loses with the way it came by
      if (to === 'on' && said.exposed && !confirm(`This machine ${said.exposed}. With the network on, It answers the internet, over plain http. Turn it on?`))
        return
      if (to !== 'on' && said.on && !onThatMachine()) {
        const loses =
          to === 'off'
            ? 'This browser reaches It over the network. With the network off it loses It, and the network is turned on again only at the machine It runs on.'
            : 'Kept to your tailnet, It answers this browser only if it reached It over the tailnet.'
        if (!confirm(`${loses} Go on?`)) return
      }
      setFailed('')
      const at = Date.now()
      last.current = at
      setMine({ to, at, id: null })
      asking({ to }).then(
        // The name the backend gave it, by which its answer is known
        (given) => setMine((was) => (was && was.at === at ? { ...was, id: (given as { asked?: number } | null)?.asked ?? null } : was)),
        (err) => {
          // Refused only after it was given up on and something else was asked: that asking
          // goes on, and what is said is its own
          if (last.current !== at) return
          setMine(null)
          setFailed(refusal(err).message)
        },
      )
    },
    [asking, said, waiting],
  )
  return {
    /** How it stands now: undefined until the backend has said. */
    way,
    /** Whether the service says enough of itself for the switch to be offered. One of an earlier It does not, and the command is shown instead. */
    offered: said !== undefined && said.canTailnet !== null && said.canTailnet !== undefined,
    canTailnet: said?.canTailnet === true,
    exposed: said?.exposed ?? null,
    addresses: said?.on ? said.addresses : [],
    /** What is being turned to, while the service has not yet said what became of it. */
    turning: mine ? mine.to : null,
    /** It has gone unanswered for longer than the service takes to look. */
    untaken: mine !== null && Date.now() - mine.at > UNTAKEN_MS,
    /** Why what was asked here did not come about, in a sentence, where it did not. */
    failed,
    ask,
  }
}

const WAYS: Way[] = ['off', 'on', 'tailscale']

/**
 * The network as three ways to choose from, with what each lets in said under it, and what
 * became of the last choosing. Turned on, It speaks plain http to whatever can reach it, which
 * is why none of the three is chosen by a single press where the machine is one the internet reaches.
 */
export function NetworkSwitch() {
  const net = useNetwork()
  // A name of its own for each place the choice is shown. Under one name, the choice in "Add a
  // display" and the one on the page behind it were one group to the browser, which lets only
  // one of a group be chosen: the one in the dialog stood with nothing chosen.
  const group = useId()
  if (net.way === undefined) return null
  const label: Record<Way, string> = {
    off: 'This computer only',
    on: net.exposed ? 'Every network this machine is on, the internet included' : 'My home network',
    tailscale: 'My tailnet only',
  }
  const hint: Record<Way, string> = {
    off: 'Nothing but the machine It runs on can open It.',
    on: net.exposed ? `This machine ${net.exposed}. It answers over plain http.` : 'Other devices on the same network can open It, over plain http.',
    tailscale: net.canTailnet ? 'Only your own devices that are signed in to Tailscale.' : 'Tailscale was not found on the machine It runs on.',
  }
  const shown = net.turning ?? net.way
  return (
    <div className="net">
      <fieldset className="net-ways" disabled={net.turning !== null}>
        <legend className="sr-only">Who can reach It</legend>
        {WAYS.map((to) => (
          <label key={to} className="net-way" data-on={shown === to || undefined}>
            <input
              type="radio"
              className="net-radio"
              name={group}
              checked={shown === to}
              disabled={to === 'tailscale' && !net.canTailnet}
              onChange={() => net.ask(to)}
            />
            <span>
              <b>{label[to]}</b>
              <small>{hint[to]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {net.turning !== null && (
        <p className="net-said" role="status">
          {net.untaken
            ? 'It has not taken that yet. It looks every second while it is running: if this goes on, run `it status` on the machine It runs on.'
            : net.turning === 'off'
              ? 'Turning the network off…'
              : 'Turning the network on…'}
        </p>
      )}
      {net.turning === null && net.failed && (
        <p className="net-said error" role="alert">
          {net.failed}
        </p>
      )}
    </div>
  )
}

/**
 * What is shown in place of an address when there is none to give: the network to turn on, or
 * that the machine is on no network. What is waited for appears by itself once there is an
 * address. Where the service says too little of itself for the switch, as one of an earlier It
 * does, the command that turns the network on is shown as before.
 */
export function NoAddress({ where }: { where: Where }) {
  const net = useNetwork()
  if (where.state === 'off')
    return net.offered ? (
      <>
        <p className="modal-lede">It answers only its own machine for now. Choose who else can reach it:</p>
        <NetworkSwitch />
      </>
    ) : (
      <>
        <p className="modal-lede">It answers only its own machine for now. Turn the network on there:</p>
        <Copyable prompt text="it network on" />
      </>
    )
  if (where.state === 'nowhere') return <p className="modal-lede">The network is on, but the machine It runs on has no address on a network just now.</p>
  return null
}

/** Where the links that agents give can be: at this computer's own name, at the machine's name on the tailnet, or at its address on the network. */
export type LinkWay = 'local' | 'tailnet' | 'network'
const LINK_WAYS: LinkWay[] = ['local', 'tailnet', 'network']

/**
 * Where the links agents give are, for the owner to choose. Only a place It can be reached at as
 * the network stands is offered, each with the address a link there is at, so that nobody is
 * given a link that opens nothing. A choice It can no longer be reached at is kept, and said to
 * be, while the links are this computer's: they are at it again once It can be reached there.
 * Nothing is shown by a backend that says nothing of links, as one of an earlier It does.
 */
export function LinkChoice() {
  const said = useQuery(api.network.get, {}) as Stands | undefined
  const choosing = useMutation(api.network.link)
  const group = useId()
  /** What is being chosen, until the backend has taken it. */
  const [turning, setTurning] = useState<LinkWay | null>(null)
  /** Why what was last chosen here was not taken, in a sentence, until something else is chosen. */
  const [failed, setFailed] = useState('')
  const links = said?.links
  if (!links || !said?.link) return null
  const offered = LINK_WAYS.filter((to) => links[to] !== undefined)
  const kept = offered.includes(said.link) ? said.link : 'local'
  const shown = turning ?? kept
  const choose = (to: LinkWay) => {
    setFailed('')
    setTurning(to)
    choosing({ to }).then(
      () => setTurning(null),
      (err) => {
        setTurning(null)
        setFailed(refusal(err).message)
      },
    )
  }
  const label: Record<LinkWay, string> = {
    local: 'This computer',
    tailnet: 'My tailnet',
    network: said.exposed ? 'Its address on the network' : 'My home network',
  }
  const hint: Record<LinkWay, string> = {
    local: 'Opens only on the machine It runs on. An agent on a machine that joined gives the address that machine reaches It at.',
    tailnet: 'Opens on your own devices that are signed in to Tailscale.',
    network: said.exposed ? 'Opens wherever that address can be reached from.' : 'Opens on other devices on the same network.',
  }
  return (
    <div className="net">
      <fieldset className="link-ways" disabled={turning !== null}>
        <legend className="sr-only">Where the links agents give are</legend>
        {offered.map((to) => (
          <label key={to} className="link-way" data-on={shown === to || undefined}>
            <input type="radio" className="net-radio" name={group} checked={shown === to} onChange={() => choose(to)} />
            <span>
              <b>{label[to]}</b>
              <small className="mono">{links[to]}</small>
              <small>{hint[to]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {said.link !== kept ? (
        <p className="net-said" role="status">
          Links are set to be at {said.link === 'tailnet' ? 'It’s name on your tailnet' : 'It’s address on the network'}, and It cannot be reached there as the
          network stands. Agents give this computer’s link until it can.
        </p>
      ) : (
        offered.length === 1 && <p className="net-said">Another place is offered here once another device can reach It.</p>
      )}
      {failed && (
        <p className="net-said error" role="alert">
          {failed}
        </p>
      )}
    </div>
  )
}
