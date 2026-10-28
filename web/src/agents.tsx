// Project agents, an experiment: an agent the person starts here, in a folder that one of their
// machines offers, with an agent app connected there, and which It keeps running on that
// machine. The site records what the person wants of each and shows how each stands; the
// connector on the machine does the running. Nothing is shown here until a machine offers them,
// which only someone at the machine can turn on.
import { AGENTS, ALIVE } from '@it/protocol'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { Copyable } from './dialog'
import { ago, api, type Id, refusal, useNow } from './lib'

const LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const appLabel = (app: string) => LABEL[app] ?? app

interface Seen {
  name: string
  lastSeenAt: number
  off: boolean
  connectorVersion: string | null
}
interface Offering extends Seen {
  id: string
  most: number
  projects: { id: string; name: string; where: string }[]
  apps: string[]
}
interface Agent {
  id: string
  machineId: string
  project: string
  name: string
  where: string
  app: string
  want: 'run' | 'stop'
  state: string
  why: string | null
  session: string | null
  said: { text: string; at: number } | null
  createdAt: number
  changedAt: number
  waiting: number
  machine: Seen
}
interface Listed {
  machines: Offering[]
  agents: Agent[]
}

const online = (m: Seen, now: number) => !m.off && now - m.lastSeenAt < ALIVE.onlineMs && m.connectorVersion !== null

/** The person's project agents and what offers them, in the owner's browser only. Undefined while it is asked, and for a screen. */
export const useAgents = (owner: boolean) => useQuery(api.agents.list, owner ? {} : 'skip') as Listed | undefined

/** Whether the site has anything to show of project agents: a machine that offers them, or an agent that is still listed. */
export const agentsShown = (listed: Listed | undefined) => listed !== undefined && (listed.machines.length > 0 || listed.agents.length > 0)

export function Agents() {
  const listed = useAgents(true)
  const now = useNow(15_000)
  if (listed === undefined) return <main className="list-view" role="status" />
  return (
    <main className="list-view agents-view">
      <header className="list-head">
        <h2>
          Agents <span className="experiment">Experimental</span>
        </h2>
      </header>
      {listed.machines.length === 0 ? (
        <div className="panel panel-pad">
          <p className="modal-lede">
            No machine offers project agents. They are an experiment, and they are off until someone at a machine turns them on and names the folders an agent
            may be started in. Run these on a machine where Claude Code or Codex is connected:
          </p>
          <Copyable prompt text="it agents on" />
          <Copyable prompt text="it agents add ~/code/your-project" />
        </div>
      ) : (
        <StartAgent machines={listed.machines} now={now} />
      )}
      {listed.agents.length > 0 && (
        <section>
          <h3>Your agents</h3>
          {listed.agents.map((a) => (
            <AgentCard key={a.id} a={a} now={now} />
          ))}
        </section>
      )}
    </main>
  )
}

/** Starting an agent: a machine, a folder it offers, an app connected there, and what it is to do first. */
function StartAgent({ machines, now }: { machines: Offering[]; now: number }) {
  const start = useMutation(api.agents.start)
  const [machineId, setMachine] = useState(machines[0]!.id)
  const m = machines.find((x) => x.id === machineId) ?? machines[0]!
  const [project, setProject] = useState(m.projects[0]?.id ?? '')
  const [app, setApp] = useState(m.apps[0] ?? '')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Another machine has other folders and apps: the first of each is chosen
  useEffect(() => {
    if (!m.projects.some((p) => p.id === project)) setProject(m.projects[0]?.id ?? '')
    if (!m.apps.includes(app)) setApp(m.apps[0] ?? '')
  }, [m, project, app])
  const there = online(m, now)
  const ready = m.projects.length > 0 && m.apps.length > 0
  return (
    <form
      className="panel panel-pad agent-start"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        start({ machineId: m.id as Id<'machines'>, project, app, ...(text.trim() ? { text } : {}) })
          .then(
            () => {
              setText('')
              setError('')
            },
            (err) => setError(refusal(err).message),
          )
          .finally(() => setBusy(false))
      }}
    >
      <p className="modal-lede">
        Start an agent in a folder on one of your machines. It keeps running there, with nobody watching: it can change files in its folder and run{' '}
        <code>it</code>, and whatever else its app’s own settings do not allow is refused.
      </p>
      <div className="agent-fields">
        <label>
          <span>Machine</span>
          <select value={m.id} onChange={(e) => setMachine(e.target.value)}>
            {machines.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Folder</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} disabled={!m.projects.length}>
            {m.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.where})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent app</span>
          <select value={app} onChange={(e) => setApp(e.target.value)} disabled={!m.apps.length}>
            {m.apps.map((x) => (
              <option key={x} value={x}>
                {appLabel(x)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!m.projects.length && (
        <p className="row-sub">
          {m.name} names no folder yet. Run <code>it agents add &lt;folder&gt;</code> there.
        </p>
      )}
      {!m.apps.length && <p className="row-sub">Connect Claude Code or Codex on {m.name}, under Machines, to start an agent there.</p>}
      <textarea
        className="agent-text"
        rows={3}
        maxLength={AGENTS.messageText}
        placeholder="What it is to do first (you can leave this empty)"
        aria-label="What it is to do first"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="modal-actions">
        <button type="submit" className="primary" disabled={!ready || busy}>
          Start agent
        </button>
        <span className="modal-sub">{there ? `${m.name} runs at most ${m.most} at once.` : `${m.name} is offline. The agent starts when it is back.`}</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** How an agent stands, in a word or two, and whether the person has anything to do about it. */
function standing(a: Agent, now: number): { word: string; tone?: 'ok' | 'wait' | 'bad'; sub?: string } {
  if (a.want === 'stop') return a.state === 'stopping' && online(a.machine, now) ? { word: 'Stopping…', tone: 'wait' } : { word: 'Stopped' }
  if (!online(a.machine, now))
    return { word: `Waits for ${a.machine.name}`, tone: 'wait', sub: `${a.machine.name} is offline. The agent goes on when it is back.` }
  if (a.state === 'failed') return { word: 'Stopped by a problem', tone: 'bad' }
  if (a.state === 'working') return { word: 'Working…', tone: 'ok' }
  if (a.state === 'ready') return { word: 'Ready', tone: 'ok' }
  if (a.state === 'resting') return { word: 'Idle', tone: 'ok', sub: 'Its program rests until there is something for it, and resumes the same conversation.' }
  return { word: 'Starting…', tone: 'wait' }
}

/** The command that opens the agent's conversation in a terminal, once It is not running it. */
const resumeCommand = (a: Agent) =>
  a.session ? `cd ${a.where.includes(' ') ? `"${a.where}"` : a.where} && ${a.app === 'codex' ? 'codex resume' : 'claude --resume'} ${a.session}` : null

function AgentCard({ a, now }: { a: Agent; now: number }) {
  const send = useMutation(api.agents.send)
  const stop = useMutation(api.agents.stop)
  const restart = useMutation(api.agents.restart)
  const forget = useMutation(api.agents.forget)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const agentId = a.id as Id<'agents'>
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  const is = standing(a, now)
  const running = a.want === 'run'
  const resume = !running && resumeCommand(a)
  return (
    <section className="panel agent-card" aria-label={`${a.name}, ${appLabel(a.app)}`}>
      <header className="panel-head">
        <div className="row-main">
          <span className="row-name">
            {a.name} <span className="row-sub">· {appLabel(a.app)}</span>
          </span>
          <span className="row-sub">
            on {a.machine.name}, in <code>{a.where}</code>, started {ago(a.createdAt, now)}
          </span>
        </div>
        <span className="status" data-tone={is.tone}>
          {is.word}
        </span>
      </header>
      {is.sub && <p className="panel-note">{is.sub}</p>}
      {a.why && (a.state === 'failed' || a.want === 'stop' || a.state === 'ready') && <p className="panel-note agent-why">{a.why}</p>}
      {a.said && (
        <div className="agent-said">
          <span className="row-sub">It said, {ago(a.said.at, now)}</span>
          <p className="agent-said-text">{a.said.text}</p>
        </div>
      )}
      {running && (
        <form
          className="agent-send"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return
            void act(send({ agentId, text }).then(() => setText('')))
          }}
        >
          <textarea
            rows={2}
            maxLength={AGENTS.messageText}
            placeholder={`Send ${a.name}’s agent a message`}
            aria-label={`Message to ${a.name}’s agent`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
      {running && a.waiting > 0 && (
        <p className="panel-note">
          {a.waiting === 1 ? 'One message waits' : `${a.waiting} messages wait`} for it, and {a.waiting === 1 ? 'goes' : 'go'} to it when it is next free.
        </p>
      )}
      {resume && (
        <div className="panel-note agent-resume">
          <span>Its conversation is kept by {appLabel(a.app)}. To open it yourself on that machine:</span>
          <Copyable prompt text={resume} />
        </div>
      )}
      <div className="agent-actions">
        {running ? (
          <>
            <button type="button" className="link" onClick={() => void act(restart({ agentId }))}>
              {a.state === 'failed' ? 'Start again' : 'Restart'}
            </button>
            <button type="button" className="link danger" onClick={() => void act(stop({ agentId }))}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link" onClick={() => void act(restart({ agentId }))}>
              Start again
            </button>
            <button type="button" className="link danger" onClick={() => void act(forget({ agentId }))}>
              Remove
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
