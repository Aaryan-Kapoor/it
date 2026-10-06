// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
// The terms are in LICENSE.md beside this add-on.
//
// The It add-on for OpenClaw. It runs inside the OpenClaw gateway and brings the user's clicks
// on pages a conversation made into that conversation:
//   - conversation idle  -> a turn starts with the click
//   - turn running       -> OpenClaw's own queue decides, as it does for any message that
//                           arrives mid-turn. Unless the user changed it, the click waits in
//                           line behind the running turn, and starts a turn when that one ends.
//
// Both go through one call, `api.runtime.channel.inbound.dispatch`, which is how a message from
// any channel enters a conversation. The agent's answer goes where that conversation's answers
// already go (the Telegram chat, the Slack thread), because the click is handed over with the
// address OpenClaw has on record for the conversation and with nothing else about where it
// came from, so that record is left as it was.
//
// One gateway holds many conversations. Commands the agent runs are told which conversation
// they are in through OpenClaw's `resolve_exec_env` hook, and each conversation seen there is
// asked about from then on, once a second, without ever holding a request open. Ownership,
// retries and receipts live in the connector.
//
// OpenClaw names a conversation by a key that /new and /reset do not change, so the connector
// is never told that an id has changed.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import { connectorInfo, homeAtSetup, loadSessions, saveSessions } from './home.js'

const HARNESS = 'openclaw'
const EVERY_MS = 1000 // the connector stops counting a conversation as listening after 5 seconds
const ANSWER_MS = 1500 // how long the connector may stay silent before it is given up on
const DEADLINE_MS = 3000 // how long one question may take from start to finish, however its answer arrives
const MOST_BYTES = 256 * 1024 // an answer longer than this is not read to its end, and counts as no answer
const QUIET_MS = 30 * 24 * 60 * 60 * 1000 // a conversation that has run no command for this long is not asked about any more: a month, which is as long as a click waits for anyone. A gateway is always there, and a page left up for a week is still answered
const MOST = 40 // how many conversations are asked about at once, which is as many as the connector watches
const AGAIN_MS = [5_000, 15_000] // how long to wait before trying a refused click again
const REFUSALS = 3 // after this many refusals in a row a conversation is not asked about for a while
const LEFT_ALONE_MS = [60 * 1000, 10 * 60 * 1000] // how long that while is: a minute the first time, which is as long as a gateway takes to restart, and ten minutes each time after. A command it runs in that time does not start the asking again, and when the time is up it is asked about again by itself
const HANDING_MS = 10 * 60 * 1000 // how long OpenClaw is given to say that the agent has a click
const SAVE_MS = 10 * 60 * 1000 // how often the list of conversations is written down when only times have changed

/** The code that proves a message came from someone who knows the token, without the token being sent. */
const seal = (token, nonce, what) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')

/**
 * Asks the connector one thing. Null when there was no answer to be believed: none at all, one
 * that took too long or was too long, or one over a port that was not sealed with the token.
 */
function ask(c, route, body) {
  const text = body === undefined ? undefined : JSON.stringify(body)
  const method = text ? 'POST' : 'GET'
  // Over the socket, which only this user can open, the token is shown. Over a port it never
  // is: the request and the answer are each sealed with it, so a program that took the
  // connector's port after a crash learns nothing, and nothing it answers is believed.
  const nonce = randomBytes(16).toString('hex')
  const proof = c.socket ? { 'x-it-token': c.token } : { 'x-it-nonce': nonce, 'x-it-mac': seal(c.token, nonce, `${method}\n${route}\n${text ?? ''}`) }
  return new Promise((resolve) => {
    let over = false
    let req
    let deadline
    const answer = (value) => {
      if (over) return
      over = true
      clearTimeout(deadline)
      resolve(value)
    }
    const giveUp = () => {
      answer(null)
      req?.destroy()
    }
    // Counted from the start and not put off by bytes that keep arriving, so that an answer
    // sent a little at a time cannot hold a check up for ever
    deadline = setTimeout(giveUp, DEADLINE_MS)
    deadline.unref?.()
    try {
      req = http.request(
        {
          ...(c.socket ? { socketPath: c.socket } : { host: '127.0.0.1', port: c.port }),
          path: route,
          method,
          headers: { ...proof, 'content-type': 'application/json', ...(text ? { 'content-length': Buffer.byteLength(text) } : {}) },
          timeout: ANSWER_MS,
        },
        (res) => {
          const pieces = []
          let size = 0
          // An answer that grows past the limit is dropped there and then, before its seal is
          // looked at and before any of it is read as JSON. The next question starts afresh.
          res.on('data', (piece) => {
            size += piece.length
            if (size > MOST_BYTES) giveUp()
            else pieces.push(piece)
          })
          res.on('error', giveUp)
          res.on('end', () => {
            if (over) return
            const got = Buffer.concat(pieces).toString('utf8')
            if (!c.socket && res.statusCode === 200 && res.headers['x-it-mac'] !== seal(c.token, nonce, `200\n${got}`)) return answer(null)
            let json = null
            try {
              json = JSON.parse(got)
            } catch {}
            answer({ status: res.statusCode, json })
          })
        },
      )
      // Whatever goes wrong, the request ends by closing, and a second answer to a promise is ignored
      req.on('timeout', giveUp)
      req.on('error', giveUp)
      req.on('close', giveUp)
      if (text) req.write(text)
      req.end()
    } catch {
      giveUp()
    }
  })
}

/**
 * A conversation as it is named in OpenClaw's log: a few letters made from its key, the same
 * few the connector's own log names it by. The key itself can hold a telephone number or the
 * name of a chat, and is never written down.
 */
const short = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8)

/** OpenClaw's keys look like `agent:<agent>:<the rest>`. */
const agentOf = (key) => /^agent:([^:]+):/.exec(key)?.[1]

/**
 * Whether a key is that of a helper the agent started (a subagent) or of a scheduled run. Each
 * of those is taken to work under a key of its own, with a part that says what it is, as in
 * `agent:main:subagent:<id>` and `agent:main:cron:<job>`. Nobody is in such a conversation, and
 * a subagent's is over when its task is done, so a click must never start a turn there. This
 * add-on is not told which conversation started a subagent, so a page one makes belongs to no
 * conversation at all, and its clicks wait where the person can see them.
 *
 * These shapes of key have not been checked against a running OpenClaw. A key wrongly taken
 * for one of them costs a conversation its clicks, which then wait on the page. A key wrongly
 * let through would let a click start a turn where nobody is, which is the worse of the two.
 */
const unattended = (key) =>
  key
    .toLowerCase()
    .split(':')
    .some((part) => part === 'subagent' || part === 'cron')

/**
 * The working copy of this add-on: what it knows of the conversations, and what it does about
 * them. There is one for a gateway, made by the load that has the running gateway behind it.
 */
function make(api) {
  /**
   * Conversations to ask about: key -> { agent, seen, handing, tries, notBefore, leftUntil, lefts }. `handing` is
   * null, or says since when a click has been on its way to the agent and how to stop waiting for it.
   */
  const sessions = new Map()
  const given = new Set() // clicks the agent already has, which must never be handed over a second time
  let connector = null // { socket | port, token }, read from the connector's own file
  let lookedAt = 0
  let timer
  let checking = false
  let unsaved = false // a conversation was added or dropped since the list was last written down
  let moved = false // only times have changed
  let savedAt = 0

  const say = (line) => {
    try {
      api.logger?.warn?.(`It: ${line}`)
    } catch {}
  }

  /** The parts of OpenClaw this add-on needs. Without all of them it does nothing at all. */
  function host() {
    try {
      const rt = api.runtime
      if (typeof rt?.channel?.inbound?.dispatch !== 'function') return null
      if (typeof rt?.agent?.session?.getSessionEntry !== 'function' || typeof rt?.config?.current !== 'function') return null
      return rt
    } catch {
      return null
    }
  }

  function find() {
    if (Date.now() - lookedAt < (connector ? 30_000 : 3000)) return connector
    lookedAt = Date.now()
    connector = connectorInfo()
    return connector
  }

  async function tell(route, body) {
    const c = find()
    if (!c) return null
    const answer = await ask(c, route, body)
    // No answer, or an answer that says the word is wrong: the connector restarted, so its file is read again
    if (!answer || answer.status === 401) lookedAt = 0
    return answer?.status === 200 ? answer.json : null
  }

  function learn(key, agent, seen) {
    const known = sessions.get(key)
    if (known) {
      known.agent = agent
      if (seen > known.seen) {
        known.seen = seen
        moved = true
      }
      return
    }
    sessions.set(key, { agent, seen, handing: null, tries: 0, notBefore: 0, leftUntil: 0, lefts: 0 })
    unsaved = true
    // Past the most the connector watches, the conversation that has been quiet longest gives way
    while (sessions.size > MOST) {
      const [oldest] = [...sessions].filter(([, s]) => !s.handing).sort((a, b) => a[1].seen - b[1].seen)[0] ?? []
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  function save() {
    saveSessions([...sessions].map(([key, s]) => [key, s.agent, s.seen]))
    unsaved = false
    moved = false
    savedAt = Date.now()
  }

  /** The agent has these now. The connector is told, and told again on a later check if that fails. */
  function gave(clicks) {
    for (const c of clicks) given.add(c.id)
    if (given.size > 2000) for (const id of [...given].slice(0, 1000)) given.delete(id)
    void tell('/ack', { ids: clicks.map((c) => c.id) })
  }

  /**
   * Puts clicks into the conversation, in the connector's own words. Null when the conversation
   * is gone: a click must never start a conversation of its own.
   */
  function deliver(rt, key, s, clicks, started) {
    const entry = rt.agent.session.getSessionEntry({ agentId: s.agent, sessionKey: key })
    if (!entry) return null
    // Where this conversation's answers go, as OpenClaw has it on record. A conversation held
    // in OpenClaw's own window has no such address, and its answer appears in that window.
    const to = entry.delivery?.kind === 'external' ? entry.delivery.context : null
    const address =
      to && typeof to.channel === 'string' && to.channel && typeof to.to === 'string' && to.to
        ? {
            OriginatingChannel: to.channel,
            OriginatingTo: to.to,
            ...(to.accountId ? { AccountId: to.accountId } : {}),
            ...(to.threadId !== undefined && to.threadId !== null ? { MessageThreadId: to.threadId } : {}),
          }
        : {}
    // One wording, made by the connector, which names each click so a repeat can be told apart
    const text = clicks.map((c) => c.text).join('\n')
    return rt.channel.inbound.dispatch({
      cfg: rt.config.current(),
      channel: 'it',
      route: { agentId: s.agent, sessionKey: key },
      ctxPayload: {
        Body: text,
        RawBody: text,
        BodyForAgent: text,
        // A click is never a command to OpenClaw, even if a page's text begins with a slash
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
        SessionKey: key,
        AgentId: s.agent,
        // Who brought this message, and a name for it. OpenClaw needs both of any message it is
        // to put into a turn that is already running: without them it fails there, and the
        // click has to be tried again. The name is made from the first click's own id and from
        // how often this hand-over has been tried, so that a second try is a second message to
        // OpenClaw and is never taken for one it has had. Neither says where an answer goes.
        Provider: 'it',
        Surface: 'it',
        MessageSid: `it-${clicks[0].id}-${s.tries}`,
        ...address,
      },
      record: { createIfMissing: false },
      // Only answers that have no address reach here. They are already in the conversation,
      // where the user reads them, so there is nothing to send and nothing is sent.
      delivery: { deliver: async () => ({ visibleReplySent: false }), onError: () => {} },
      replyOptions: { onAgentRunStart: started },
    })
  }

  function handOver(rt, key, s, clicks) {
    // 'open' while OpenClaw has not said what became of the click, 'unsure' once this add-on has
    // stopped waiting to hear, and 'done' when there is nothing more to learn
    let state = 'open'
    const accepted = () => {
      if (state === 'unsure') {
        // OpenClaw started the agent's turn after this add-on had stopped waiting for it. The
        // agent has the click all the same, so it is remembered and reported, and not given again.
        state = 'done'
        if (!s.handing) {
          s.tries = 0
          s.notBefore = 0
          s.lefts = 0
        }
        gave(clicks)
        return
      }
      if (state !== 'open') return
      state = 'done'
      s.handing = null
      s.tries = 0
      s.notBefore = 0
      s.lefts = 0
      s.seen = Date.now()
      moved = true
      gave(clicks)
    }
    // `kind` is one of a few fixed words, and is all the log is told of why. What OpenClaw
    // itself said, in an error or in its answer, can repeat what a page or a person sent.
    const refused = (kind) => {
      if (state !== 'open') return
      state = 'unsure'
      s.handing = null
      s.tries++
      if (s.tries >= REFUSALS) {
        // A conversation that takes nothing is left alone for a while. Asking about it would
        // keep its clicks set aside for this add-on, where nothing else can have them: once the
        // asking has stopped, the connector lets them wait where the person can see them. It
        // is not forgotten. What stood in the way may be over in a moment (a gateway that is
        // restarting takes no work), so when the while is up it is asked about again by
        // itself, and its click is tried again, with nobody having to say anything to it.
        s.tries = 0
        s.leftUntil = Date.now() + LEFT_ALONE_MS[Math.min(s.lefts, LEFT_ALONE_MS.length - 1)]
        s.lefts++
        say(`a click could not be given to a conversation (${short(key)}), ${REFUSALS} times in a row, and waits: ${kind}`)
        return
      }
      s.notBefore = Date.now() + AGAIN_MS[Math.min(s.tries - 1, AGAIN_MS.length - 1)]
      say(`a click could not be given to a conversation (${short(key)}) and will be tried again: ${kind}`)
    }
    const gone = () => {
      state = 'done'
      s.handing = null
      // Nothing is asked about it any more, so the connector lets its clicks wait where the user can see them
      sessions.delete(key)
      unsaved = true
    }
    s.handing = { since: Date.now(), giveUp: () => refused('no_word') }
    let turn
    try {
      turn = deliver(rt, key, s, clicks, accepted)
    } catch {
      refused('dispatch_threw')
      return
    }
    if (turn === null) {
      gone()
      return
    }
    // The agent has the click once OpenClaw says its turn has started, and that is the only
    // thing taken as proof. What OpenClaw answers to the call itself says less than it seems.
    // Run against a real gateway: where the conversation is idle, the turn starts and the call
    // answers when the turn is over. Where the conversation is busy, the call answers at once
    // that the message was dispatched, and no turn has started: OpenClaw either puts the
    // message into the running turn, and says so, or keeps it in line behind that turn and
    // starts a turn with it when that one ends. So an answer that the message was taken, with
    // no turn yet, is not a refusal. The click is on its
    // way, nothing more is handed to this conversation until its turn starts, and it is given up
    // on, and tried again, only if OpenClaw says nothing of a turn for as long as HANDING_MS.
    // Were it tried again sooner, the agent would be sent the same click once for each try.
    Promise.resolve(turn).then(
      (result) => {
        if (result?.dispatched === false) return refused('not_taken')
        // Put into the turn that is running, which is what OpenClaw does with a message for a
        // conversation busy with a turn of the same kind: the agent reads it at its next step.
        // OpenClaw starts no turn for it, and so never says that one started. Its own word that
        // the message was steered into the running turn is the proof here. Left waiting for a
        // start that never comes, the conversation would be handed nothing more for ten minutes.
        if (result?.dispatchResult?.deferredToActiveRun === 'steer') accepted()
      },
      () => refused('dispatch_failed'),
    )
  }

  async function checkOne(rt, key, s) {
    const got = await tell(`/clicks?harness=${HARNESS}&session=${encodeURIComponent(key)}`)
    // The conversation may have been dropped, or dropped and seen again, while the connector was answering
    if (!got || !Array.isArray(got.clicks) || sessions.get(key) !== s) return
    const clicks = got.clicks.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && c.text)
    const again = clicks.filter((c) => given.has(c.id))
    // Offered something the agent already has: the earlier report of it was lost, so it is sent again
    if (again.length) void tell('/ack', { ids: again.map((c) => c.id) })
    const fresh = clicks.filter((c) => !given.has(c.id))
    if (fresh.length && !s.handing && Date.now() >= s.notBefore) handOver(rt, key, s, fresh)
  }

  async function check() {
    if (checking) return
    checking = true
    try {
      const now = Date.now()
      // OpenClaw has had long enough to say what became of a click. From here on it counts as
      // refused: the conversation is treated like any other again, and the click is tried again.
      for (const s of sessions.values()) if (s.handing && now - s.handing.since > HANDING_MS) s.handing.giveUp()
      for (const [key, s] of sessions) {
        if (s.handing || now - s.seen <= QUIET_MS) continue
        sessions.delete(key)
        unsaved = true
      }
      if (unsaved || (moved && now - savedAt > SAVE_MS)) save()
      // Asking tells the connector that someone is listening, so nothing is asked unless a click could be handed over
      const rt = host()
      if (!rt || !sessions.size) return
      // One that is being left alone is not asked about until its while is up
      await Promise.all([...sessions].filter(([, s]) => now >= s.leftUntil).map(([key, s]) => checkOne(rt, key, s).catch(() => {})))
    } finally {
      checking = false
    }
  }

  // Every shell command the agent runs is told which conversation it belongs to. That is how a
  // page comes to belong to a conversation, and how this add-on learns which ones to ask about.
  const execEnv = (event, ctx) => {
    const key = event?.sessionKey ?? ctx?.sessionKey
    // The connector cuts a longer id short, and the two sides would then disagree about it
    if (typeof key !== 'string' || !key || key.length > 200) return undefined
    // A subagent's commands, and a scheduled run's, are told nothing: see `unattended`
    if (unattended(key)) return undefined
    const agent = typeof ctx?.agentId === 'string' && ctx.agentId ? ctx.agentId : agentOf(key)
    if (!agent) return undefined
    // Its commands are always told which conversation they are in. One that is being left alone
    // after refusing is not asked about any sooner for running one.
    learn(key, agent, Date.now())
    // The commands the agent runs are told where It's folder is too, when it is not the usual place: the `it` command they run must use the same one as this add-on
    const elsewhere = homeAtSetup()
    return { IT_HARNESS: HARNESS, IT_SESSION: key, ...(elsewhere ? { IT_HOME: elsewhere } : {}) }
  }

  const service = {
    id: 'it-clicks',
    start() {
      clearInterval(timer)
      const now = Date.now()
      let already = unsaved
      for (const [key, agent, seen] of loadSessions()) {
        // What the file holds is held to what is asked of a key OpenClaw gives: a subagent's or
        // a scheduled run's is not taken, and is left out of the file when it is next written
        if (unattended(key)) already = true
        else if (now - seen <= QUIET_MS && seen <= now) learn(key, agent, seen)
      }
      // What was just read is what is written down already
      unsaved = already
      timer = setInterval(() => void check().catch(() => {}), EVERY_MS)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      if (unsaved || moved) save()
    },
  }
  return { execEnv, service }
}

/** Where the one working copy is kept, for every load of this plugin in the same gateway to find. */
const ONE = Symbol.for('it-bridge.openclaw')

/**
 * OpenClaw loads a plugin more than once in one gateway: in full when the gateway starts, and
 * again, afresh, to list what the plugin offers. It then asks the hooks of whichever load it
 * made last, and starts the services of the full one only. So every load registers the hook,
 * and each answers through the one working copy, which the full load makes: were each load to
 * keep its own, the one that is told which conversation a command belongs to would not be the
 * one that asks for that conversation's clicks, and no click would ever arrive.
 */
function register(api) {
  const full = typeof api?.registrationMode !== 'string' || api.registrationMode === 'full'
  if (full) {
    // A gateway that loads its plugins again, in full, has the copy made again: the one before is stopped first
    try {
      globalThis[ONE]?.service.stop()
    } catch {}
    globalThis[ONE] = make(api)
  }
  try {
    api.on('resolve_exec_env', (event, ctx) => globalThis[ONE]?.execEnv(event, ctx))
  } catch {}
  if (full) api.registerService(globalThis[ONE].service)
}

export default {
  id: 'it-bridge',
  name: 'It',
  description: 'Brings what the user does on It pages into the OpenClaw conversation that made the page.',
  register,
}
