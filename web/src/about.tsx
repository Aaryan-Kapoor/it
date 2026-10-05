// How It stands on the computer it runs on, said to the owner in Settings as a few plain facts.
// The owner may be reading on another computer, so none of it speaks of "this computer". What
// only that computer can know (whether It is registered to start by itself, whether counts of
// its use are sent, and which port it counts from) is what the service there has told the
// backend, and is said as a fact only once the service has said it.
import { contentPort, PORTS } from '@it/protocol'
import { useQuery } from 'convex/react'
import { api } from './lib'

/** What the service says of itself (`network.service`). Each of the last two is null while it has not said. */
interface Itself {
  port: number
  background: boolean | null
  usage: boolean | null
}

/** The four ports It uses, counted from the one the service says it counts from. */
const ports = (base: number): string => [base, contentPort(base), base + PORTS.backendApi, base + PORTS.backendSite].join(' · ')

/** One fact: what it is about, how it stands, and under that the command that changes it. */
function Fact({ name, value, change }: { name: string; value: string; change?: string }) {
  return (
    <li className="row">
      <span className="row-main">
        <span className="row-name">{name}</span>
        {change && (
          <span className="row-sub">
            <code>{change}</code>
          </span>
        )}
      </span>
      <span className="row-value">{value}</span>
    </li>
  )
}

/** The section of the owner's Settings that says how It stands on the computer it runs on. */
export function About() {
  const itself = useQuery(api.network.service, {}) as Itself | undefined
  const said = (is: boolean | null | undefined, yes: string, no: string) => (is === true ? yes : is === false ? no : '…')
  return (
    <section>
      <h3>Where It runs</h3>
      <ul className="rows panel">
        <Fact
          name="Starts by itself"
          value={said(itself?.background, 'On', 'Off')}
          change={itself?.background === false ? 'it service install' : itself?.background === true ? 'it service uninstall' : undefined}
        />
        <Fact
          name="Usage counts"
          value={said(itself?.usage, 'Sent', 'Not sent')}
          change={itself?.usage === false ? 'it telemetry on' : itself?.usage === true ? 'it telemetry off' : undefined}
        />
        <Fact name="Ports" value={itself ? ports(itself.port) : '…'} />
        <Fact name="Kept in" value="~/.it" />
      </ul>
    </section>
  )
}
