// The connector's part in project agents, an experiment: it keeps each agent the person started
// on this machine as they want it. What they want is said by It (`agents.mine`); which folders
// an agent may run in, and how many may run at once, is said on this machine (`it agents`).
//
// An agent that is to run is started in its folder with its app's own interface for holding a
// conversation open (see agent-session.ts), or resumed where it has a conversation already. It
// is given what the person sent it from the site, and what was done on its pages, a turn at a
// time: the keeper asks the connector for those clicks as an add-on does, and is the only thing
// the connector gives them to. Its program is let go after it has had nothing to do for a while
// and resumed the moment there is something for it, so that an agent that is on costs nothing
// while it waits. Each program is written down before it is given anything, so that a
// connector that died can end what it left when it next starts, and an agent whose turn was cut
// off by It stopping is resumed and told so. One that ends by itself is not started again until
// the person starts it again.
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { AGENTS, type AgentState } from '@it/protocol'
import { type AgentSession, appName, type Launch, type SessionEvents, sessionFor } from './agent-session'
import { type AgentSettings, agentsFile, folderOf, offerOf, readAgents } from './agents'
import { inHome, readJson, writePrivate } from './lib'
import { bootId, endTree, fromAnotherStart, processes, SINCE_TOLD } from './wake'

/** An agent as It says the person wants it. */
export interface Wanted {
  id: string
  project: string
  app: string
  want: 'run' | 'stop'
  round: number
  state: string
  session: string | null
  messages: { id: string; text: string }[]
}
/** A click as the connector hands it over: its id and the words the agent reads. */
export interface Handed {
  id: string
  text: string
}

/** What a turn that It cut off is resumed with. */
export const CUT_OFF =
  '[It] It was stopped while you were in the middle of a turn, and has resumed this conversation. Some of what that turn was doing may be done and some not: look at where things stand, and carry on with what is left of it, if anything is.'

/** Where the programs this machine started for agents are written down until each is known to have ended. */
export const agentRunsFile = () => inHome('agent-runs.json')
interface Note {
  pid: number
  since: string
  told: number
  run: string
  app: string
  session: string | null
  boot?: string
  busy?: boolean
}
interface Notes {
  runs: Record<string, Note>
  /** The agents whose turn was cut off by It stopping, and which are resumed and told so. */
  cutOff: string[]
  /**
   * Programs that ended, where whether anything they started is still running could not be
   * told: the system would not say of some process of this user what it was started with. Each
   * is looked at again when It next starts, until that can be told or the machine has been
   * started again.
   */
  left: Note[]
}
const LEFT_MOST = 50
function readNotes(file: string): Notes | 'unread' {
  try {
    statSync(file)
  } catch {
    return { runs: {}, cutOff: [], left: [] }
  }
  const n = readJson<Notes>(file)
  if (!n || typeof n !== 'object' || typeof n.runs !== 'object' || n.runs === null || !Array.isArray(n.cutOff)) return 'unread'
  if (n.left !== undefined && !Array.isArray(n.left)) return 'unread'
  return { runs: n.runs, cutOff: n.cutOff.filter((x) => typeof x === 'string'), left: n.left ?? [] }
}

/** Ends what a note names, as far as the system lets it be told. */
const endNoted = (n: Note) =>
  fromAnotherStart(n.boot)
    ? Promise.resolve('gone' as const)
    : endTree(n.pid, n.since, { harness: n.app, session: n.session ?? '', run: n.run, told: n.told }).catch(() => 'unknown' as const)
/** Whether the app's own program that a note names is there still, or may be: two programs are never run on one conversation. Its number alone may be another's by now. */
const stillThere = (n: Note): boolean => {
  if (fromAnotherStart(n.boot)) return false
  const now = processes([n.pid])
  // Where the system cannot be asked, it may be
  return now === null || now.get(n.pid) === n.since
}

export interface KeeperDeps {
  offer: (offer: ReturnType<typeof offerOf>) => Promise<unknown>
  report: (r: { agentId: string; round: number; state: AgentState; why?: string; session?: string; said?: string }) => Promise<{ gone?: boolean } | null>
  taken: (agentId: string, ids: string[]) => Promise<unknown>
  /** The clicks the connector holds for a conversation, asked for as an add-on asks. Null where it could not be asked. */
  clicks: (app: string, session: string, busy: boolean, folder: string) => Promise<Handed[] | null>
  /** Says that the agent has these clicks. */
  ack: (ids: string[]) => Promise<unknown>
  connected: (app: string) => boolean
  env: () => Promise<NodeJS.ProcessEnv>
  say: (line: string) => void
  itHome: string
  itAt: string[]
  /** For tests: the program to start in place of an app. */
  commandFor?: (app: string) => string[] | undefined
  settingsFile?: string
  runsFile?: string
  idleMs?: number
  everyMs?: number
}

interface Kept {
  w: Wanted
  /** The round its program was started for, and the program. */
  round: number
  run: AgentSession | null
  busy: () => boolean
  /** Starting or ending is under way. */
  doing: Promise<void> | null
  session: string | null
  idleAt: number
  /** Messages handed over and not yet known to be let go of by It, and those It could not be told of, which it is told of again. */
  given: Set<string>
  untold: Set<string>
  /** Clicks taken from the connector and not yet handed over, and the ones handed over lately. */
  clicks: Map<string, Handed>
  acked: Set<string>
  cutOff: boolean
  /** It ended by itself or could not start, in this round: not started again until the person starts it again. */
  failed: boolean
  last: string
  pending: Parameters<KeeperDeps['report']>[0] | null
}

export class AgentKeeper {
  private kept = new Map<string, Kept>()
  private wanted: Wanted[] = []
  private settings: AgentSettings | 'unread' = { on: false, most: AGENTS.most, projects: [] }
  private settingsSeen = ''
  private offered: string | null = null
  private notes: Notes | 'unread' = { runs: {}, cutOff: [], left: [] }
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private closing = false
  private saidOnce = new Set<string>()

  constructor(private readonly d: KeeperDeps) {}

  private get settingsFile() {
    return this.d.settingsFile ?? agentsFile()
  }
  private get runsFile() {
    return this.d.runsFile ?? agentRunsFile()
  }

  /** Ends whatever a connector before this one left running, and begins to keep agents. */
  async begin(): Promise<void> {
    this.notes = readNotes(this.runsFile)
    if (this.notes !== 'unread') {
      for (const [agent, n] of Object.entries(this.notes.runs)) {
        const outcome = await endNoted(n)
        // The app's own program is there still: it stays noted, and the agent is not started beside it (see `keep`)
        if (outcome === 'unknown' && stillThere(n)) continue
        if (outcome === 'unknown') this.notes.left.push(n)
        if (n.busy && !this.notes.cutOff.includes(agent)) this.notes.cutOff.push(agent)
        delete this.notes.runs[agent]
        this.d.say(`project agents: an agent's program left from before (${agent.slice(-6)}) was ended`)
      }
      const looked: Note[] = []
      for (const n of this.notes.left) if ((await endNoted(n)) === 'unknown') looked.push(n)
      this.notes.left = looked.slice(-LEFT_MOST)
      this.keepNotes()
    }
    this.readSettings(true)
    await this.tick()
    this.timer = setInterval(() => void this.tick(), this.d.everyMs ?? 1000)
    this.timer.unref?.()
  }

  /** What It says the person wants of this machine's agents. */
  update(wanted: Wanted[]): void {
    this.wanted = wanted
    void this.tick()
  }

  /** Whether a conversation is one of this machine's agents that is to run: its clicks go to the keeper and nowhere else. */
  owns(key: string): boolean {
    return this.wanted.some((w) => w.want === 'run' && `${w.app}:${this.kept.get(w.id)?.session ?? w.session}` === key)
  }

  /** How each agent here stands, for `it agents`. */
  standing(): { app: string; state: string }[] {
    return [...this.kept.values()].map((k) => ({ app: k.w.app, state: k.last ? (JSON.parse(k.last) as { state: string }).state : k.w.state }))
  }

  /** Ends every program, writes down whose turn was cut off, and keeps nothing more. */
  async close(): Promise<void> {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    const all = [...this.kept.values()]
    await Promise.race([
      Promise.all(
        all.map(async (k) => {
          await k.doing?.catch(() => {})
          if (!k.run) return
          if (k.busy() && this.notes !== 'unread' && !this.notes.cutOff.includes(k.w.id)) this.notes.cutOff.push(k.w.id)
          await this.endProgram(k)
          await this.d.report({ agentId: k.w.id, round: k.round, state: 'resting' }).catch(() => {})
        }),
      ),
      new Promise((r) => setTimeout(r, 12_000)),
    ])
    this.keepNotes()
  }

  private readSettings(force = false): void {
    let seen = ''
    try {
      const s = statSync(this.settingsFile)
      seen = `${s.mtimeMs}:${s.size}`
    } catch {}
    if (!force && seen === this.settingsSeen) return
    this.settingsSeen = seen
    this.settings = readAgents(this.settingsFile)
    if (this.settings === 'unread') this.d.say('project agents: agents.json could not be read, so this machine offers none')
    this.offered = null
  }

  private keepNotes(): void {
    if (this.notes === 'unread') return
    writePrivate(this.runsFile, this.notes)
  }

  private sayOnce(about: string, line: string): void {
    if (this.saidOnce.has(about)) return
    this.saidOnce.add(about)
    this.d.say(line)
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.closing) return
    this.ticking = true
    try {
      this.readSettings()
      const offer = offerOf(this.settings)
      const offerText = JSON.stringify(offer)
      if (offerText !== this.offered) {
        await this.d.offer(offer).then(
          () => {
            this.offered = offerText
          },
          (err) =>
            this.sayOnce('offer', `project agents: It could not be told what this machine offers (${String((err as Error)?.message ?? err).slice(0, 80)})`),
        )
      }
      const ids = new Set(this.wanted.map((w) => w.id))
      // An agent It no longer lists is not to run: it was removed, or its machine let go of
      for (const [id, k] of this.kept)
        if (!ids.has(id) && !k.doing) {
          if (k.run) k.doing = this.endProgram(k).finally(() => this.kept.delete(id))
          else this.kept.delete(id)
        }
      for (const w of this.wanted) await this.keep(w)
    } finally {
      this.ticking = false
    }
  }

  private keptFor(w: Wanted): Kept {
    let k = this.kept.get(w.id)
    if (!k) {
      k = {
        w,
        round: w.round,
        run: null,
        busy: () => false,
        doing: null,
        session: w.session,
        idleAt: Date.now(),
        given: new Set(),
        untold: new Set(),
        clicks: new Map(),
        acked: new Set(),
        cutOff: this.notes !== 'unread' && this.notes.cutOff.includes(w.id),
        failed: false,
        // What It already says of it is not said again
        last: JSON.stringify({ state: w.state }),
        pending: null,
      }
      this.kept.set(w.id, k)
    }
    k.w = w
    return k
  }

  private async keep(w: Wanted): Promise<void> {
    const k = this.keptFor(w)
    if (k.pending) await this.send(k, k.pending)
    if (k.doing) return
    // Started again by the person: a new round, with nothing held against it
    if (w.round !== k.round) {
      if (k.run) {
        k.doing = this.endProgram(k).finally(() => {
          k.doing = null
        })
        return
      }
      k.round = w.round
      k.failed = false
      k.last = ''
    }
    if (w.want === 'stop') {
      k.cutOff = false
      this.forgetCutOff(w.id)
      if (k.run) {
        k.doing = this.endProgram(k).finally(() => {
          k.doing = null
        })
        return
      }
      return this.state(k, 'stopped')
    }
    const folder = folderOf(this.settings, w.project)
    const cannot =
      this.notes === 'unread'
        ? 'It could not read its own note of the agents it ran on this machine (agent-runs.json in It’s folder), so it starts none until that is seen to. Check that none is still running there, then move the file aside.'
        : this.settings === 'unread'
          ? 'It could not read its note of project agents on this machine (agents.json in It’s folder), so the machine offers none.'
          : !folder
            ? 'This machine does not offer this agent’s folder any more, or the folder is gone.'
            : !this.d.connected(w.app)
              ? `${appName(w.app)} is not connected on this machine any more. Connect it there again to run this agent.`
              : null
    if (cannot) {
      if (k.run) {
        k.doing = this.endProgram(k).finally(() => {
          k.doing = null
        })
        return
      }
      k.failed = true
      return this.state(k, 'failed', { why: cannot })
    }
    // A program of it from before is still noted: where it has ended since, it is let go of; where it has not, nothing is started beside it
    const before = this.notes !== 'unread' && !k.run ? this.notes.runs[w.id] : undefined
    if (before) {
      if (stillThere(before)) {
        k.failed = true
        return this.state(k, 'failed', {
          why: `Its program from before (process ${before.pid}) is still running and could not be ended, so It starts no other beside it. End that process, then start the agent again.`,
        })
      }
      this.forgetRun(w.id)
    }
    if (k.failed) return
    // What was done on its pages, asked for whether or not its program is running, so that its clicks wait for it and go nowhere else
    if (k.session) {
      const got = await this.d.clicks(w.app, k.session, k.busy(), folder!)
      for (const c of got ?? []) if (!k.acked.has(c.id) && !k.clicks.has(c.id)) k.clicks.set(c.id, c)
    }
    // What It still lists that was handed over, and what it no longer lists
    for (const id of k.given) if (!w.messages.some((m) => m.id === id)) k.given.delete(id)
    if (k.untold.size) this.tell(k, [...k.untold])
    const messages = w.messages.filter((m) => !k.given.has(m.id))
    const something = messages.length > 0 || k.clicks.size > 0 || k.cutOff
    if (!k.run?.alive) {
      if (k.run) k.run = null
      // A new agent, or one the person has just started again, is started at once; one that rests is started for something to do
      const asked = !k.session || w.state === 'starting'
      if (!asked && !something) return this.state(k, 'resting')
      const running = [...this.kept.values()].filter((x) => x.run?.alive || (x.doing && x !== k)).length
      if (running >= (this.settings === 'unread' ? 0 : this.settings.most)) {
        this.sayOnce(`full:${w.id}`, `project agents: an agent waits for room, since ${running} already run here`)
        return this.state(k, 'resting')
      }
      k.doing = this.start(k, folder!).finally(() => {
        k.doing = null
      })
      return
    }
    if (k.busy()) return this.state(k, 'working')
    if (something) {
      k.doing = this.hand(k, messages).finally(() => {
        k.doing = null
      })
      return
    }
    // Nothing to do for long enough: its program is let go, and the conversation resumed when there is something for it
    if (Date.now() - k.idleAt > (this.d.idleMs ?? AGENTS.idleMs)) {
      k.doing = this.endProgram(k).finally(() => {
        k.doing = null
      })
      return
    }
    return this.state(k, 'ready')
  }

  /** Says how an agent stands, where that is not what was said last. */
  private async state(k: Kept, state: AgentState, extra: { why?: string; session?: string; said?: string } = {}): Promise<void> {
    const r = { agentId: k.w.id, round: k.round, state, ...extra }
    const said = JSON.stringify({ state, why: extra.why })
    if (said === k.last && !extra.said && !extra.session) return
    k.last = said
    await this.send(k, r)
  }
  private async send(k: Kept, r: Parameters<KeeperDeps['report']>[0]): Promise<void> {
    k.pending = null
    try {
      const answer = await this.d.report(r)
      if (answer?.gone && k.run) await this.endProgram(k)
    } catch {
      // Said again on the next pass
      k.pending = r
    }
  }

  private async start(k: Kept, folder: string): Promise<void> {
    const w = k.w
    await this.state(k, 'starting')
    const resume = k.session !== null
    // Claude Code is given the id of a new conversation; Codex makes its own
    const session = k.session ?? (w.app === 'claude-code' ? randomUUID() : null)
    const run = `agent-${randomUUID()}`
    const round = k.round
    const on: SessionEvents = {
      session: (id) => {
        k.session = id
        this.note(w.id, (n) => ({ ...n, session: id }))
        void this.state(k, 'ready', { session: id })
      },
      idle: (said, failed) => {
        k.idleAt = Date.now()
        this.note(w.id, (n) => ({ ...n, busy: false }))
        void this.state(k, 'ready', { ...(said ? { said } : {}), ...(failed ? { why: `Its last turn failed: ${failed}` } : {}) })
        void this.tick()
      },
      exited: (why, words) => {
        if (k.run !== s || k.round !== round) return
        k.run = null
        k.failed = true
        this.forgetRun(w.id)
        void this.state(k, 'failed', { why: words ? `${why}. Its last words were: ${words}` : why })
      },
    }
    let launch: Launch
    try {
      launch = {
        app: w.app,
        folder,
        session,
        resume,
        env: await this.d.env(),
        itHome: this.d.itHome,
        itAt: this.d.itAt,
        run,
        command: this.d.commandFor?.(w.app),
        began: (pid, since) => {
          if (this.notes === 'unread') throw new Error('its note cannot be read')
          const boot = bootId()
          this.notes.runs[w.id] = { pid, since, told: SINCE_TOLD, run, app: w.app, session, ...(boot ? { boot } : {}) }
          this.keepNotes()
        },
      }
    } catch {
      k.failed = true
      return this.state(k, 'failed', { why: 'Its environment could not be made ready.' })
    }
    const s = sessionFor(launch, on)
    if (!s) {
      k.failed = true
      return this.state(k, 'failed', { why: `It cannot start an agent with ${appName(w.app)}.` })
    }
    k.run = s
    k.busy = () => s.busy
    try {
      await s.start()
    } catch (err) {
      if (k.run === s) k.run = null
      k.failed = true
      await s.end().catch(() => {})
      this.forgetRun(w.id)
      return this.state(k, 'failed', {
        why: `${appName(w.app)} could not ${resume ? 'resume its conversation' : 'be started'}: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      })
    }
    if (k.run !== s) return
    k.idleAt = Date.now()
    if (s.session && s.session !== k.session) k.session = s.session
    this.d.say(`project agents: ${appName(w.app)} ${resume ? 'resumed' : 'started'} for an agent (${w.id.slice(-6)})`)
    await this.state(k, 'ready', s.session ? { session: s.session } : {})
  }

  /** Hands an agent that is free what waits for it, as one turn. */
  private async hand(k: Kept, messages: { id: string; text: string }[]): Promise<void> {
    const clicks = [...k.clicks.values()]
    const text = [...(k.cutOff ? [CUT_OFF] : []), ...messages.map((m) => m.text), ...clicks.map((c) => c.text)].join('\n\n')
    try {
      await k.run!.send(text)
    } catch {
      return
    }
    if (k.cutOff) {
      k.cutOff = false
      this.forgetCutOff(k.w.id)
    }
    this.note(k.w.id, (n) => ({ ...n, busy: true }))
    for (const m of messages) k.given.add(m.id)
    if (messages.length)
      this.tell(
        k,
        messages.map((m) => m.id),
      )
    for (const c of clicks) {
      k.clicks.delete(c.id)
      k.acked.add(c.id)
    }
    while (k.acked.size > 200) k.acked.delete(k.acked.values().next().value!)
    if (clicks.length) void this.d.ack(clicks.map((c) => c.id)).catch(() => {})
    // A turn that is over already has said so, and is not said to be at work after that
    if (k.busy()) await this.state(k, 'working')
  }

  /** Tells It that these messages were handed over, and again on a later pass where it could not be told. */
  private tell(k: Kept, ids: string[]): void {
    for (const id of ids) k.untold.delete(id)
    void this.d.taken(k.w.id, ids).catch(() => {
      for (const id of ids) k.untold.add(id)
    })
  }

  /** Ends an agent's program, and says how it stands now. */
  private async endProgram(k: Kept): Promise<void> {
    const s = k.run
    if (!s) return
    k.run = null
    const outcome = await s.end().catch(() => 'unknown' as const)
    const noted = this.notes !== 'unread' ? this.notes.runs[k.w.id] : undefined
    if (outcome === 'unknown' && noted && stillThere(noted)) {
      // Not ended: it stays noted, and nothing is started beside it
      this.d.say(`project agents: an agent's program (${k.w.id.slice(-6)}) did not end when it was asked to`)
      if (this.closing) return
      k.failed = true
      return this.state(k, 'failed', {
        why: `Its program (process ${noted.pid}) did not end when It asked, so It starts no other beside it. End that process, then start the agent again.`,
      })
    }
    if (outcome === 'unknown' && noted && this.notes !== 'unread') {
      this.notes.left = [...this.notes.left, noted].slice(-LEFT_MOST)
      this.d.say(
        `project agents: an agent's program (${k.w.id.slice(-6)}) ended, and whether anything it started is still running could not be told; that is looked at again when It next starts`,
      )
    }
    this.forgetRun(k.w.id)
    if (this.closing) return
    await this.state(k, k.w.want === 'stop' ? 'stopped' : k.w.round !== k.round ? 'starting' : 'resting')
  }

  private note(agent: string, change: (n: Note) => Note): void {
    if (this.notes === 'unread' || !this.notes.runs[agent]) return
    this.notes.runs[agent] = change(this.notes.runs[agent])
    try {
      this.keepNotes()
    } catch {}
  }
  private forgetRun(agent: string): void {
    if (this.notes === 'unread' || !this.notes.runs[agent]) return
    delete this.notes.runs[agent]
    try {
      this.keepNotes()
    } catch {}
  }
  private forgetCutOff(agent: string): void {
    if (this.notes === 'unread' || !this.notes.cutOff.includes(agent)) return
    this.notes.cutOff = this.notes.cutOff.filter((x) => x !== agent)
    try {
      this.keepNotes()
    } catch {}
  }
}
