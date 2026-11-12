// The machines where the person's agents run, and which agent apps (harnesses, in the code) on
// each are connected. The site only records the choice; the connector on the machine does the
// installing.
import { ALIVE, HARNESSES, INSTALL, newer, noWakeHere, TURN_ON_MS, TURNS_ON, UPGRADE_MS, WAKES, wakesOn } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copyable, Dialog } from './dialog'
import { ago, api, type Id, refusal, serverNow, useNow, useOpener } from './lib'
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
  runtime?: { state: string; version?: string; idle?: boolean; outdated?: boolean; detail: string }
}
interface Machine {
  id: string
  name: string
  lastSeenAt: number
  connectorVersion: string | null
  /** The system it runs on, as its connector names it, where it has said. */
  system?: string | null
  /** That it reopens closed conversations on its system, as a machine on Windows says of itself. False from functions that do not say. */
  reopens?: boolean
  /** Why it hands nothing to an agent for now, though it is there. Null where it does, and from functions that do not say. */
  paused?: string | null
  /** Its connector said it was stopping, and has not been heard from since. */
  off?: boolean
  /** It runs on this machine, where every other joined it. */
  runsIt?: boolean
  /** The newest version of It this machine has learned is out, where it looks for one. */
  latest?: string | null
  /** An upgrade of this machine that was asked for here, and how far it has got. */
  upgrade?: { at: number; state: 'asked' | 'working' | 'restarting' | 'failed' | 'installed' | 'done'; why?: string; version?: string } | null
  /** Turning It's add-on back on in an app that has it turned off, asked for here, and how far each has got. Missing from functions that do not say. */
  turnOn?: { harness: string; at: number; state: 'asked' | 'working' | 'failed' | 'done'; why?: string }[]
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
  // In the app, and turned off there, perhaps on purpose: not connecting, and never turned on again but by the person
  if (wanted && h.addon === 'disabled')
    return {
      word: `Turned off in ${LABEL[h.id] ?? 'the app'}`,
      tone: 'wait',
      detail: (TURNS_ON as readonly string[]).includes(h.id)
        ? `It’s add-on is turned off inside ${LABEL[h.id] ?? 'the app'} on this machine, so nothing you do on a page reaches it by itself, unless the conversation is in a T3 Code thread. It stays off until you turn it back on.`
        : h.id === 'pi'
          ? 'It’s extension is turned off in Pi’s settings on this machine, so nothing you do on a page reaches Pi by itself. Run pi config in a terminal there and turn It’s extension back on.'
          : `It’s add-on is turned off inside ${LABEL[h.id] ?? 'the app'} on this machine. Turn it back on there.`,
    }
  if (wanted && h.addon !== 'connected') return { word: online ? 'Connecting…' : 'Connects when online', tone: 'wait' }
  if (!wanted && h.addon === 'connected') return { word: online ? 'Disconnecting…' : 'Disconnects when online', tone: 'wait' }
  if (h.addon !== 'connected') return { word: 'Off' }
  if (!online) return { word: 'Installed, offline', tone: 'wait' }
  if (h.runtime?.state === 'incompatible') return { word: 'Add-on needs attention', tone: 'bad', detail: h.runtime.detail }
  // Clicks still arrive. Said with what to do, since the person would not otherwise know that a restart brings the add-on up to date
  if (h.runtime?.state === 'active' && h.runtime.outdated) return { word: 'Restart to update the add-on', tone: 'wait', detail: h.runtime.detail }
  if (h.runtime?.state === 'active' && h.runtime.idle === false) return { word: 'Open a conversation', tone: 'wait', detail: h.runtime.detail }
  if (h.runtime?.state === 'active') return { word: 'Add-on loaded', tone: 'ok', detail: h.runtime.detail }
  return {
    word: 'Installed, not verified',
    tone: 'wait',
    detail: h.runtime?.detail ?? 'No loaded add-on has reported its delivery APIs yet. Open the app and its conversation.',
  }
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
/** How long the site says that an update it was asked for is over, and what is left to do after it. */
const DONE_SAID_MS = 6 * 60 * 60_000

/**
 * Adding a machine: another computer where the person's agents run joins this It with a code
 * that works once. What is shown first is one line to run there, which installs It and joins
 * and sets no It up on that computer: installed by itself at a terminal, It asks where the
 * person's It is, and a computer that is given an It of its own cannot join another. Under it
 * is the joining alone, which is what is pasted when the install asks, as it does on Windows,
 * and what a computer runs that has the command already. Both
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
            On Windows, install It with <code>{INSTALL.ps}</code>. When it asks where your It is, choose “On another computer of mine” and paste the line below.
            That line is also all that a computer needs that has the <code>it</code> command already.
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
  // By the backend's clock, which is the one the asking was timed by
  const now = useNow(15_000)
  const out = newer(m.latest, m.connectorVersion) ? (m.latest as string) : null
  const state = m.upgrade?.state
  // Claude Code has It's add-on there: its conversations that were open have not loaded the new one
  const claude = m.harnesses.some((h) => h.id === 'claude-code' && (h.addon === 'connected' || h.addon === 'needs_approval'))
  const reload = claude ? ' Type /reload-plugins in any Claude Code chat that was already open there, so that it loads It’s new add-on.' : ''
  if (state === 'installed')
    return (
      <p className="panel-note newer" data-tone="wait">
        {/* Said by a machine that could not start It again by itself: one started in a terminal, and one whose service was registered by an It
            from before 0.1.35, whose launcher does not say that it is the service, as well as an older It that sent every Windows machine here */}
        It {m.upgrade?.version ?? ''} is installed on {m.name}. It runs once It is started again there. If you started It in a terminal with{' '}
        <code>it serve</code>, stop it and start it again. Otherwise run <code>it setup</code> in a terminal on that machine, which starts It again and lets the
        next update start it again by itself. As it starts it brings the add-ons in the agent apps there up to date.
        {claude
          ? ' Then type /reload-plugins in any Claude Code chat that was already open there, so that it loads It’s new add-on.'
          : ' An app that is already running goes on with the add-on it loaded until it is restarted, and its line on this page then says so.'}
      </p>
    )
  const behind = !m.runsIt && newer(host, m.connectorVersion)
  // An update the site asked for is over: said for a few hours, with what is left to do there, unless something newer waits already
  if (state === 'done' && now - (m.upgrade?.at ?? 0) < DONE_SAID_MS && !out && !behind)
    return (
      <p className="panel-note newer" data-tone={claude ? 'wait' : undefined}>
        It {m.upgrade?.version ?? m.connectorVersion} is running on {m.name}.{reload}
      </p>
    )
  const mismatch = behind ? `This machine runs It ${m.connectorVersion}. The machine It runs on uses ${host}. ` : ''
  if (!out || (behind && newer(host, out)))
    return behind ? (
      <p className="panel-note newer" data-tone="wait">
        {mismatch}A matching release has not been confirmed here. Run <code>it upgrade --check</code> on this machine to check for updates.
      </p>
    ) : null
  const first = !m.runsIt && newer(out, host)
  // At work for as long as an upgrade takes, and no longer: one that has said nothing since
  // was cut short, and is said to have been, with the way to ask for it again. A machine that
  // was starting again as the new program and has not reported it since did not start as it:
  // its launcher goes on trying, and what it met is in the service's log there.
  const restarting = state === 'restarting'
  const asked = state === 'asked' || state === 'working' || restarting
  const cutShort = asked && now - (m.upgrade?.at ?? 0) > UPGRADE_MS
  const working = asked && !cutShort
  return (
    <p className="panel-note newer" data-tone={state === 'failed' || cutShort ? 'bad' : undefined}>
      {working ? (
        restarting ? (
          `Starting again as It ${out}…`
        ) : (
          `Updating to It ${out}…`
        )
      ) : (
        <>
          {state === 'failed'
            ? `The update to It ${out} did not finish: ${(m.upgrade?.why ?? 'it is not known why').replace(/\.$/, '')}. `
            : cutShort && restarting
              ? `It ${out} is in place, and has not been heard from since it was started. Run it service logs on that machine to read why. `
              : cutShort
                ? `The update to It ${out} did not finish. This machine still runs ${m.connectorVersion}. `
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
              {state === 'failed' || cutShort ? 'Try again' : 'Update'}
            </button>
          )}
        </>
      )}
    </p>
  )
}

/**
 * Turn back on, beside an app that has It's add-on turned off on a machine: the machine turns it
 * on with the app's own command, and says here whether that worked and, where it did not, why.
 * It is never turned on by itself, since the person may have turned it off on purpose.
 */
function TurnBackOn({ m, h, online, act }: { m: Machine; h: Harness; online: boolean; act: (p: Promise<unknown>) => Promise<void> }) {
  const turnOn = useMutation(api.machines.turnOn)
  // By the backend's clock, which is the one the asking was timed by
  const now = useNow(15_000)
  const asked = m.turnOn?.find((t) => t.harness === h.id)
  const label = LABEL[h.id] ?? 'the app'
  const atWork = (asked?.state === 'asked' || asked?.state === 'working') && now - asked.at < TURN_ON_MS
  if (atWork)
    return (
      <span className="row-detail row-sub" role="status">
        Turning It’s add-on back on in {label}…
      </span>
    )
  const cutShort = asked?.state === 'asked' || asked?.state === 'working'
  const failed = asked?.state === 'failed'
  // Done, and the machine has not yet said that the app has it on: it says so with its next report
  if (asked?.state === 'done')
    return (
      <span className="row-detail row-sub" role="status">
        Turned back on. Waiting for {m.name} to report it.
      </span>
    )
  return (
    <span className="row-detail turn-on" data-tone={failed || cutShort ? 'bad' : undefined}>
      {failed && `It could not be turned back on: ${(asked?.why ?? 'it is not known why').replace(/\.$/, '')}. `}
      {cutShort && `${m.name} did not say whether it turned It’s add-on back on. `}
      <button
        type="button"
        className="link"
        disabled={!online}
        title={online ? undefined : 'This machine is off'}
        onClick={() => void act(turnOn({ machineId: m.id as Id<'machines'>, harness: h.id }))}
      >
        {failed || cutShort ? 'Try again' : 'Turn back on'}
      </button>
    </span>
  )
}

/**
 * Why a machine that is there hands nothing done on a page to an agent for now, as its
 * connector told It: the two do not fit, or it has not yet been able to ask whether they do.
 */
export const pausedFor = (why: string, machine: string): string =>
  why === 'unchecked'
    ? `${machine} has not yet been able to ask It whether the two are of versions that work together. Until it has, nothing done on a page is handed to an agent there. It asks again every minute.`
    : `${machine} and It are of versions that do not work together. Until It is updated on the one that is behind, nothing done on a page is handed to an agent there, and no conversation is reopened. Run it status on ${machine} to see which to update.`

function MachineCard({ m, now, host }: { m: Machine; now: number; host: string | null }) {
  const toggle = useMutation(api.machines.toggle)
  const wake = useMutation(api.machines.wake)
  const rename = useMutation(api.machines.rename)
  const [error, setError] = useState('')
  const [name, setName] = useState<string | null>(null)
  const renaming = useOpener<HTMLButtonElement>(name !== null)
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
        <span className="status" data-tone={online && !m.paused ? 'ok' : 'wait'}>
          {online ? (m.paused ? 'Online, paused' : 'Online') : m.connectorVersion === null ? 'Connector not running' : `Last seen ${ago(m.lastSeenAt, now)}`}
        </span>
        {/* Which of several machines It is on: revoking that one ends every paired browser, and two machines may go by one name */}
        {m.runsIt && <span className="status">It runs on this machine</span>}
        <span className="grow" />
        {name === null && (
          <button ref={renaming} type="button" className="link" onClick={() => setName(m.name)}>
            Rename
          </button>
        )}
        <RevokeMachine m={m} act={act} />
      </header>
      <NewerOut m={m} host={host} online={online} act={act} />
      {/* There, and handing nothing to an agent for now: said with why, since everything else about it looks ready */}
      {online && m.paused && <p className="panel-note">{pausedFor(m.paused, m.name)}</p>}
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
            // Only for a selected app It can reopen a closed conversation of
            const couldWake = wanted && !fixed && (WAKES as readonly string[]).includes(h.id)
            // And only on a machine of a system It reopens conversations on
            const wakeable = couldWake && wakesOn(m.system, m.reopens)
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
                {wanted && h.addon === 'disabled' && (TURNS_ON as readonly string[]).includes(h.id) && <TurnBackOn m={m} h={h} online={online} act={act} />}
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
                      // A connection failure must not stop the owner from turning existing permission off.
                      disabled={!wakes && h.addon !== 'connected' && h.addon !== 'needs_approval'}
                      onChange={(e) => act(wake({ machineId, harness: h.id, on: e.target.checked }))}
                    />
                    <span className="wake-name">Auto-wake</span>
                    {/* Said where it can be read, and not only where a pointer rests: it is on from the start, and it runs an agent with nobody there */}
                    <span className="row-sub">
                      {wakes && h.runtime?.state === 'incompatible'
                        ? 'On, waiting for the add-on to be repaired'
                        : wakes && h.runtime?.idle === false
                          ? 'On, waiting while this app is open'
                          : wakes
                            ? 'On. When you use a page whose conversation is closed, It reopens it and runs this agent here with nobody watching'
                            : 'Off. A click waits until you open its conversation again'}
                    </span>
                  </label>
                )}
                {couldWake && !wakeable && <span className="row-detail row-sub">{noWakeHere(m.system)}</span>}
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
