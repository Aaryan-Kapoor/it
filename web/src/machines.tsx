// The machines where the person's agents run, and which agent apps (harnesses, in the code) on
// each are connected. The site only records the choice; the connector on the machine does the
// installing.
import { HARNESSES, WAKES } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copyable, Dialog } from './dialog'
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
  wakes: { harness: string; since: number }[]
}

/**
 * How one agent app on a machine stands, in a word or two, and whether that is something the
 * person has to act on. That its add-on is installed is not the same as a click reaching a
 * conversation, which takes the machine being online as well, so no more is said than is known.
 */
function standing(h: Harness, wanted: boolean, online: boolean): { word: string; tone?: 'ok' | 'wait' | 'bad'; detail?: string } {
  if (h.addon === 'unavailable') return { word: 'Not available yet', detail: h.detail }
  if (h.addon === 'too_old') return { word: 'Version too old', tone: 'bad', detail: h.detail }
  if (h.addon === 'error') return { word: 'Could not connect', tone: 'bad', detail: h.detail }
  if (h.addon === 'needs_approval')
    return { word: 'Needs your approval', tone: 'wait', detail: h.detail ?? 'It is waiting for your approval inside the agent app.' }
  if (wanted && h.addon !== 'connected') return { word: online ? 'Connecting…' : 'Connects when online', tone: 'wait' }
  if (!wanted && h.addon === 'connected') return { word: online ? 'Disconnecting…' : 'Disconnects when online', tone: 'wait' }
  if (h.addon !== 'connected') return { word: 'Off' }
  return online ? { word: 'Connected', tone: 'ok' } : { word: 'Connected, offline', tone: 'wait' }
}

export function Machines() {
  const machines = useQuery(api.machines.list, {}) as Machine[] | undefined
  const now = useNow(15_000)
  const [adding, setAdding] = useState(false)
  const done = useCallback(() => setAdding(false), [])
  if (machines === undefined) return <main className="list-view" role="status" />
  return (
    <main className="list-view">
      <header className="list-head">
        <h2>Machines</h2>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add a machine
        </button>
      </header>
      {machines.length === 0 && (
        <div className="panel panel-pad">
          <p className="modal-lede">No machine is connected. Run this where It runs:</p>
          <Copyable prompt text="it setup" />
        </div>
      )}
      {machines.map((m) => (
        <MachineCard key={m.id} m={m} now={now} />
      ))}
      {adding && <AddMachine onClose={done} />}
    </main>
  )
}

/** How long a code to join with lasts when the backend does not say. */
const CODE_MS = 10 * 60_000

/**
 * Adding a machine: another computer where the person's agents run joins this It with a code
 * that works once. What is shown is the one command to run there. It names this machine's
 * address on the person's network, which another computer can reach only once the network is
 * on: until then the dialog shows the command that turns it on, and the other appears by itself.
 */
function AddMachine({ onClose }: { onClose: () => void }) {
  const convex = useConvex()
  const where = useWhere()
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState('')
  const now = useNow(5_000)
  const add = useCallback(async () => {
    try {
      const r: { code: string; expiresAt?: number } = await convex.mutation(api.sessions.inviteMachine, {})
      setMade({ code: r.code, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : serverNow() + CODE_MS })
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    }
  }, [convex])
  // A code is made as the dialog opens: opening it is the asking
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void add()
  }, [add])
  const ranOut = made !== null && made.expiresAt <= now
  // An address under IPv6 is written in brackets, which a shell would read as more than they are
  const quoted = (address: string) => (address.includes('[') ? `"${address}"` : address)
  return (
    <Dialog eyebrow="Machines" title="Add a machine" onClose={onClose} className="pairing">
      {ranOut ? (
        <>
          <p className="modal-lede">That code has run out.</p>
          <button type="button" className="primary" onClick={() => void add()}>
            Make another
          </button>
        </>
      ) : !made ? (
        !error && <p className="modal-lede">Making a code…</p>
      ) : where.address ? (
        <>
          <p className="modal-lede">Install It on the other computer, then run this there.</p>
          <div className="pair-command">
            <Copyable prompt text={`it login --url ${quoted(where.address)} --code ${made.code}`} />
          </div>
          <OtherAddresses where={where} />
        </>
      ) : (
        <NoAddress where={where} />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Done
        </button>
        {made && !ranOut && <span className="modal-sub">One machine, once, for ten minutes.</span>}
      </div>
    </Dialog>
  )
}

function MachineCard({ m, now }: { m: Machine; now: number }) {
  const toggle = useMutation(api.machines.toggle)
  const wake = useMutation(api.machines.wake)
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
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by the person a moment ago
              autoFocus
              aria-label="Machine name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setName(null)}
            />
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
        <p className="panel-note">
          {m.connectorVersion === null ? 'Run it setup on this machine to look for agent apps.' : 'No agent app was found on this machine.'}
        </p>
      ) : (
        <ul className="rows checks">
          {known.map((h) => {
            const wanted = m.wanted.includes(h.id)
            const fixed = h.addon === 'unavailable' || h.addon === 'too_old'
            const is = standing(h, wanted, online)
            // Only for an app It can reopen a closed conversation of, and only while it is connected
            const wakeable = wanted && !fixed && (WAKES as readonly string[]).includes(h.id)
            const wakes = m.wakes.some((w) => w.harness === h.id)
            return (
              <li key={h.id} className="row">
                <label className="row-main switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={wanted}
                    checked={wanted}
                    disabled={fixed}
                    // One box at a time: two ticked in quick succession must not undo each other
                    onChange={(e) => act(toggle({ machineId, harness: h.id, on: e.target.checked }))}
                  />
                  <span className="row-name check-name">
                    {LABEL[h.id] ?? h.id}
                    {h.version && <span className="mono row-version">{h.version}</span>}
                  </span>
                </label>
                <span className="status check-note" data-tone={is.tone} title={is.tone ? undefined : is.detail}>
                  {is.word}
                </span>
                {/* Only what the person has to do something about is spelled out */}
                {is.tone && is.tone !== 'ok' && is.detail && <span className="row-detail">{is.detail}</span>}
                {wakeable && (
                  <label
                    className="row-detail switch-row wake-row"
                    title="Runs this agent on this machine, with nobody watching, when you use a page whose conversation is closed."
                  >
                    <input
                      type="checkbox"
                      role="switch"
                      aria-checked={wakes}
                      aria-label={`Auto-wake ${LABEL[h.id] ?? h.id}`}
                      checked={wakes}
                      onChange={(e) => act(wake({ machineId, harness: h.id, on: e.target.checked }))}
                    />
                    <span className="wake-name">Auto-wake</span>
                    <span className="row-sub">
                      {wakes ? 'Closed conversations are reopened for a click' : 'A click waits until you reopen its conversation'}
                    </span>
                  </label>
                )}
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
