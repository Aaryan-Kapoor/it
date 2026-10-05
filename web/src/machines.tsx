// The machines where the person's agents run, and which agent apps (harnesses, in the code) on
// each are connected. The site only records the choice; the connector on the machine does the
// installing.
import { HARNESSES } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { ago, api, type Id, refusal, serverNow, useNow } from './lib'
import { NoAddress, OtherAddresses, useWhere } from './network'
import { RevokeMachine } from './paired'

const LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  hermes: 'Hermes Agent',
  opencode: 'OpenCode',
  pi: 'Pi',
}
const ONLINE_MS = 6 * 60_000

interface Harness {
  id: string
  version?: string
  addon: string
  detail?: string
}
interface Machine {
  id: string
  name: string
  lastSeenAt: number
  connectorVersion: string | null
  harnesses: Harness[]
  wanted: string[]
}

/**
 * What is said beside one agent app on a machine. That its add-on is installed is not the same
 * as a click reaching a conversation: that takes the machine being online as well, and an app
 * that lets an add-on speak in the conversation, so no more is said than is known here.
 */
function harnessNote(h: Harness, wanted: boolean, online: boolean): string {
  if (h.addon === 'unavailable') return h.detail ?? 'It cannot connect to this yet.'
  if (h.addon === 'too_old') return h.detail ?? 'This version is too old.'
  if (h.addon === 'error') return h.detail ? `It could not connect to this app. ${h.detail}` : 'It could not connect to this app, and was not told why.'
  if (h.addon === 'needs_approval') return h.detail ?? 'It is waiting for your approval inside the agent app.'
  if (wanted && h.addon !== 'connected') return online ? 'It is connecting to this app.' : 'It will connect to this app when this machine is online.'
  if (!wanted && h.addon === 'connected') return online ? 'It is disconnecting from this app.' : 'It will disconnect from this app when this machine is online.'
  if (h.addon !== 'connected') return 'It is not connected to this app.'
  return online
    ? 'Its add-on is installed, and this machine is online. What you do on a page is handed to the conversation that made it, where the app lets an add-on speak there.'
    : 'Its add-on is installed. Nothing is handed to a conversation there until this machine is online.'
}

export function Machines() {
  const machines = useQuery(api.machines.list, {}) as Machine[] | undefined
  const now = useNow(15_000)
  if (machines === undefined) return <main className="empty" role="status" />
  return (
    <main className="list-view">
      <h2>Machines</h2>
      <p className="muted">
        A machine is a computer where your agents run. The one It runs on is here from the first time It is set up, and you choose here which of its agent apps
        It connects to.
      </p>
      {machines.length === 0 && (
        <div className="panel">
          <p>No machine is connected. On the machine It runs on, run:</p>
          <pre className="steps">
            <code>it setup</code>
          </pre>
        </div>
      )}
      {machines.map((m) => (
        <MachineCard key={m.id} m={m} now={now} />
      ))}
      <AddMachine />
    </main>
  )
}

/** How long a code to join with lasts when the backend does not say. */
const CODE_MS = 10 * 60_000

/**
 * Adding a machine: another computer where the person's agents run joins this It with a code
 * that works once. What is shown is the one command to run there. It names this machine's
 * address on the person's network, which another computer can reach only once the network is
 * on: until then the panel says how to turn it on, and the command appears by itself.
 */
function AddMachine() {
  const convex = useConvex()
  const where = useWhere()
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(5_000)
  const add = async () => {
    setBusy(true)
    try {
      const r: { code: string; expiresAt?: number } = await convex.mutation(api.sessions.inviteMachine, {})
      setMade({ code: r.code, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : serverNow() + CODE_MS })
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    } finally {
      setBusy(false)
    }
  }
  const ranOut = made !== null && made.expiresAt <= now
  // An address under IPv6 is written in brackets, which a shell would read as more than they are
  const quoted = (address: string) => (address.includes('[') ? `"${address}"` : address)
  return (
    <section className="panel pairing">
      <h3>Add a machine</h3>
      {!made || ranOut ? (
        <>
          <p className="muted">
            {ranOut
              ? 'That code has run out. Make another when the other computer is ready.'
              : 'Agents on another computer can make pages here too. That computer has It installed, and joins this one with a code.'}
          </p>
          <button type="button" disabled={busy} onClick={() => void add()}>
            Add a machine
          </button>
        </>
      ) : where.address ? (
        <>
          <p>On the other computer, run this:</p>
          <p className="mono pair-command">{`it login --url ${quoted(where.address)} --code ${made.code}`}</p>
          <OtherAddresses where={where} />
        </>
      ) : (
        <NoAddress where={where} appears="the command to run on the other computer" />
      )}
      {made && !ranOut && (
        <>
          <p className="muted">The code joins one machine, once, and works for ten minutes.</p>
          <button type="button" onClick={() => setMade(null)}>
            Done
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function MachineCard({ m, now }: { m: Machine; now: number }) {
  const toggle = useMutation(api.machines.toggle)
  const rename = useMutation(api.machines.rename)
  const [error, setError] = useState('')
  const [name, setName] = useState<string | null>(null)
  const online = now - m.lastSeenAt < ONLINE_MS && m.connectorVersion !== null
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  const machineId = m.id as Id<'machines'>
  const known = m.harnesses.filter((h) => (HARNESSES as readonly string[]).includes(h.id))

  return (
    <section className="panel">
      <header className="panel-head">
        {name === null ? (
          <h3>{m.name}</h3>
        ) : (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault()
              void act(rename({ machineId, name }).then(() => setName(null)))
            }}
          >
            <input aria-label="Machine name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name.trim()}>
              Save
            </button>
            <button type="button" className="link" onClick={() => setName(null)}>
              Cancel
            </button>
          </form>
        )}
        <span className="status" data-tone={online ? 'ok' : 'wait'}>
          {online ? 'Online' : m.connectorVersion === null ? 'Connector not running' : `Last seen ${ago(m.lastSeenAt, now)}`}
        </span>
        <span className="grow" />
        {name === null && (
          <button type="button" className="link" onClick={() => setName(m.name)}>
            Rename
          </button>
        )}
        <RevokeMachine m={m} act={act} />
      </header>
      {known.length === 0 ? (
        <p className="muted">
          {m.connectorVersion === null ? 'Run it setup on this machine to look for agent apps.' : 'No agent app was found on this machine.'}
        </p>
      ) : (
        <ul className="checks">
          {known.map((h) => {
            const wanted = m.wanted.includes(h.id)
            const fixed = h.addon === 'unavailable' || h.addon === 'too_old'
            return (
              <li key={h.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={wanted}
                    disabled={fixed}
                    // One box at a time: two ticked in quick succession must not undo each other
                    onChange={(e) => act(toggle({ machineId, harness: h.id, on: e.target.checked }))}
                  />
                  <span className="check-name">{LABEL[h.id] ?? h.id}</span>
                  {h.version && <span className="mono">{h.version}</span>}
                </label>
                <span className="muted check-note" data-tone={h.addon === 'error' ? 'bad' : h.addon === 'needs_approval' ? 'wait' : undefined}>
                  {harnessNote(h, wanted, online)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
