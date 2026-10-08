// The machines where the person's agents run, and which agent apps (harnesses, in the code) on
// each are connected. The site only records the choice; the connector on the machine does the
// installing.
import { ALIVE, HARNESSES, INSTALL, newer, WAKES } from '@it/protocol'
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
  /** Its connector said it was stopping, and has not been heard from since. */
  off?: boolean
  /** It runs on this machine, where every other joined it. */
  runsIt?: boolean
  /** The newest version of It this machine has learned is out, where it looks for one. */
  latest?: string | null
  /** An upgrade of this machine that was asked for here, and how far it has got. */
  upgrade?: { at: number; state: 'asked' | 'working' | 'failed' | 'installed'; why?: string; version?: string } | null
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
  // A fault only for an app the person chose. One they do not use, found on the machine, is said plainly
  if (h.addon === 'too_old') return { word: 'Version too old', ...(wanted ? { tone: 'bad' as const } : {}), detail: h.detail }
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
        <MachineCard key={m.id} m={m} now={now} host={machines.find((x) => x.runsIt)?.connectorVersion ?? null} />
      ))}
      {adding && <AddMachine onClose={done} />}
    </main>
  )
}

/** How long a code to join with lasts when the backend does not say. */
const CODE_MS = 10 * 60_000

/**
 * Adding a machine: another computer where the person's agents run joins this It with a code
 * that works once. What is shown first is one line to run there, which installs It and joins
 * and sets no It up on that computer: installed by itself at a terminal, It is set up there,
 * and a computer that runs an It of its own cannot join another. Under it is the joining alone,
 * for Windows, whose install sets nothing up, and for a computer that has It already. Both
 * name this machine's address on the person's network, which another computer can reach only
 * once the network is on: until then the dialog shows the command that turns it on, and the
 * others appear by themselves.
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
          <p className="modal-lede">Run this on the other computer. It installs It there and joins it to this one.</p>
          <div className="pair-command install">
            <Copyable prompt text={`${INSTALL.sh} -s -- login --url ${quoted(where.address)} --code ${made.code}`} />
          </div>
          <p className="modal-sub">
            On Windows, install It with <code>{INSTALL.ps}</code>, open a new terminal, and run the line below. It is also all that a computer needs that has It
            already.
          </p>
          <div className="pair-command join">
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

/**
 * A newer It is out, as this machine has learned: said under its name, with the button that has
 * the machine put it in place. The machine fetches what the place releases are kept says is
 * newest and checks it as an install does. Nothing here says which version or where from. The
 * machine It runs on goes first: another at a newer version than that one would ask for
 * what the backend there does not have yet.
 */
function NewerOut({ m, host, online, act }: { m: Machine; host: string | null; online: boolean; act: (p: Promise<unknown>) => Promise<void> }) {
  const upgrade = useMutation(api.machines.upgrade)
  const out = newer(m.latest, m.connectorVersion) ? (m.latest as string) : null
  const state = m.upgrade?.state
  if (state === 'installed')
    return (
      <p className="panel-note newer" data-tone="wait">
        It {m.upgrade?.version ?? ''} is installed on {m.name}. It runs once It is started again there: stop <code>it serve</code> where it is running, and
        start it.
      </p>
    )
  if (!out) return null
  const first = !m.runsIt && newer(out, host)
  const working = state === 'asked' || state === 'working'
  return (
    <p className="panel-note newer" data-tone={state === 'failed' ? 'bad' : undefined}>
      {working ? (
        `Updating to It ${out}…`
      ) : (
        <>
          {state === 'failed'
            ? `It ${out} could not be put in place: ${m.upgrade?.why ?? 'it is not known why'}. `
            : `It ${out} is out. This machine runs ${m.connectorVersion}. `}
          {first ? (
            'Update the machine It runs on first.'
          ) : (
            <button
              type="button"
              className="link"
              disabled={!online}
              title={online ? undefined : 'This machine is off'}
              onClick={() => void act(upgrade({ machineId: m.id as Id<'machines'> }))}
            >
              {state === 'failed' ? 'Try again' : 'Update'}
            </button>
          )}
        </>
      )}
    </p>
  )
}

function MachineCard({ m, now, host }: { m: Machine; now: number; host: string | null }) {
  const toggle = useMutation(api.machines.toggle)
  const wake = useMutation(api.machines.wake)
  const rename = useMutation(api.machines.rename)
  const [error, setError] = useState('')
  const [name, setName] = useState<string | null>(null)
  const online = !m.off && now - m.lastSeenAt < ALIVE.onlineMs && m.connectorVersion !== null
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
        {/* Which of several machines It is on: revoking that one ends every paired browser, and two machines may go by one name */}
        {m.runsIt && <span className="status">It runs on this machine</span>}
        <span className="grow" />
        {name === null && (
          <button type="button" className="link" onClick={() => setName(m.name)}>
            Rename
          </button>
        )}
        <RevokeMachine m={m} act={act} />
      </header>
      <NewerOut m={m} host={host} online={online} act={act} />
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
                <span className="status check-note" data-tone={is.tone}>
                  {is.word}
                </span>
                {/* Why, and what to do about it, in words that can be read without a pointer */}
                {is.tone !== 'ok' && is.detail && <span className="row-detail">{is.detail}</span>}
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
