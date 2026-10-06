// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
// The terms are in LICENSE.md beside this add-on.
//
// The It add-on for Pi. It runs inside Pi and brings the user's clicks on pages this
// conversation made into the conversation, as a message from the user:
//   - Pi idle     -> the message starts a turn
//   - Pi working  -> the message is queued as steering, which Pi reads once the tools it is
//                    running have finished and before it next asks the model (nothing is
//                    interrupted)
//
// It asks the connector on this machine once a second and never holds a request open.
// Ownership, retries and receipts live in the connector. Commands the agent runs already say
// which conversation they belong to, because Pi puts PI_SESSION_ID in the environment of its
// shell tools, and that is the same id this add-on asks with.
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Where It keeps its files, when that was somewhere other than the usual folder at the time
// `it setup` put this add-on in place. `it setup` fills it in. The IT_HOME variable comes first.
const IT_HOME_AT_SETUP = null

const HARNESS = 'pi'
const ANSWER_MS = 1500 // how long the connector may stay silent before it is given up on
const DEADLINE_MS = 3000 // how long one question may take from start to finish, however its answer arrives
const MOST_BYTES = 256 * 1024 // an answer longer than this is not read to its end, and counts as no answer
// How many checks in a row Pi must be idle, with nothing queued, before a message it was
// given and never showed in the conversation is taken to be lost.
const LOST_AFTER = 10

// Pi makes a fresh copy of this add-on whenever the conversation is reloaded or replaced
// (/reload, /new, /resume, /fork). What must outlive a copy is kept here, once for the whole
// Pi process: the clicks the agent already has, which must never be handed over a second time,
// and every change of a conversation's id that the connector has not yet been told of.
const KEY = Symbol.for('it.addon.pi')
globalThis[KEY] ??= { given: new Set() }
const shared = globalThis[KEY]
// Each as { was, now }, in the order they happened
shared.moves ??= []

// One wording, made by the connector, which names each click so a repeat can be told apart
const textOf = (clicks) => clicks.map((c) => c.text).join('\n')

/** The text of a message in Pi's conversation, whichever of its two shapes it has. */
function words(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
}

/** The code that proves a message came from someone who knows the token, without the token being sent. */
const seal = (token, nonce, what) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')

export default function (pi) {
  // The commands the agent runs are told where It's folder is too, when it is not the usual place: the `it` command they run must use the same one as this add-on
  if (!process.env.IT_HOME && typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP) process.env.IT_HOME = IT_HOME_AT_SETUP
  // And where the `it` command is. A Pi that was started from the terminal It was installed in,
  // or that was already open, has a PATH from before It was on it, and its agent's first `it`
  // would not be found. Put last, so that an `it` the person has put on their PATH themselves comes first.
  try {
    const bin = path.join(process.env.IT_HOME || path.join(os.homedir(), '.it'), 'bin')
    const now = process.env.PATH ?? ''
    if (!now.split(path.delimiter).includes(bin)) process.env.PATH = now ? `${now}${path.delimiter}${bin}` : bin
  } catch {}
  let connector = null // { socket | port, token }, read from the connector's own file
  let lookedAt = 0
  let ctx = null // Pi's handle on this conversation, from when it starts until it is shut down
  let timer = null
  let checking = false // a check is under way, so the next one waits its turn
  let running = false // the agent is working
  let session = null // this conversation's id
  let file = null // the file Pi keeps this conversation in, which is how the same conversation is known under a new id
  let sent = [] // clicks given to Pi, which has not yet shown them in the conversation
  let quiet = 0 // how many checks in a row Pi has been idle with those still not shown
  let retryAt = 0 // after a message was lost, nothing is handed over before this time
  let retryWait = 0

  function find() {
    if (Date.now() - lookedAt < (connector ? 30000 : 3000)) return connector
    lookedAt = Date.now()
    connector = null
    try {
      const home = process.env.IT_HOME || (typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP ? IT_HOME_AT_SETUP : path.join(os.homedir(), '.it'))
      const c = JSON.parse(readFileSync(path.join(home, 'connector.json'), 'utf8'))
      // Only a token and a port number are taken from the file. The socket is always the one in
      // that same folder, whatever the file says, so nothing in it can point anywhere else.
      const socket = typeof c.socket === 'string' && c.socket ? path.join(home, 'connector.sock') : null
      const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null
      if (typeof c.token === 'string' && /^[0-9a-f]{16,128}$/.test(c.token) && (socket || port)) connector = { socket, port, token: c.token }
    } catch {}
    return connector
  }

  /**
   * Asks the connector one thing. The answer, or null if there was none to be believed: none at
   * all, one that took too long or was too long, or one over a port that was not sealed with the
   * token. This never throws.
   */
  function ask(route, body) {
    const c = find()
    if (!c) return Promise.resolve(null)
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
            // A connection of its own for each question, closed with the answer, and never waited on for long
            agent: false,
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
            res.on('close', giveUp)
            res.on('end', () => {
              if (over) return
              const out = Buffer.concat(pieces).toString('utf8')
              if (res.statusCode === 401) lookedAt = 0 // the connector restarted: read its file again
              if (res.statusCode !== 200) return answer(null)
              if (!c.socket && res.headers['x-it-mac'] !== seal(c.token, nonce, `200\n${out}`)) return answer(null)
              try {
                answer(JSON.parse(out))
              } catch {
                answer(null)
              }
            })
          },
        )
        req.on('timeout', giveUp)
        req.on('error', () => {
          lookedAt = 0
          giveUp()
        })
        if (text) req.write(text)
        req.end()
      } catch {
        giveUp()
      }
    })
  }

  /** The agent has these now. The connector is told, and told again on a later check if that fails. */
  function gave(clicks) {
    for (const c of clicks) shared.given.add(c.id)
    if (shared.given.size > 2000) for (const id of [...shared.given].slice(0, 1000)) shared.given.delete(id)
    retryWait = 0
    retryAt = 0
    void ask('/ack', { ids: clicks.map((c) => c.id) })
  }

  /**
   * Pi takes a message without saying whether it got in, so the proof is the conversation
   * itself: a click counts as handed over only once a message from the user that carries its
   * text has appeared there.
   */
  function saw(event) {
    if (!sent.length || event?.message?.role !== 'user') return
    const text = words(event.message)
    const landed = sent.filter((c) => text.includes(c.text))
    if (!landed.length) return
    sent = sent.filter((c) => !landed.includes(c))
    gave(landed)
  }

  /** Notices when a message Pi was given never reached the conversation, so it can be given again. */
  function settle() {
    if (!sent.length) return
    // While Pi is working, or still has the message queued, it is on its way and there is nothing to decide
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      quiet = 0
      return
    }
    quiet += 1
    if (quiet < LOST_AFTER) return
    // Pi refused it (no model, or no key for one), or the user stopped the turn that was to
    // carry it. The clicks were never reported as handed over, so the connector still offers
    // them. They are tried again, less and less often, so that a refusal Pi shows the user is
    // not shown every few seconds.
    sent = []
    quiet = 0
    retryWait = Math.min(retryWait ? retryWait * 2 : 5000, 60000)
    retryAt = Date.now() + retryWait
  }

  /**
   * Whether a click could be handed to Pi now, or will be once what Pi is doing has finished.
   * While it could not, the connector is not asked at all. Asking tells the connector that this
   * conversation is listening, and it then sets the conversation's clicks aside for this
   * add-on, where nothing else (`it wait`, for one) can have them.
   */
  function open() {
    // A click is on its way into the conversation, and stays this add-on's to report
    if (sent.length) return true
    // After a message was lost, nothing is handed over for a while
    if (Date.now() < retryAt) return false
    // Working: the click is queued as steering, or waits a moment for Pi to finish what it is busy with
    if (!ctx.isIdle()) return true
    // A one-shot run (pi -p, pi --mode json) ends when its agent stops, so a turn started now
    // would be cut off. The click stays with the connector for whoever listens next.
    if (ctx.mode === 'print' || ctx.mode === 'json') return false
    // With no model chosen Pi would refuse the message
    return Boolean(ctx.model)
  }

  function handOver(clicks) {
    // Pi may have changed while the connector was answering
    if (!clicks.length || !open()) return
    if (ctx.isIdle()) {
      // The message that starts a turn is still on its way in; a second one now would collide with it
      if (sent.length) return
    } else if (!running) {
      // Pi is busy with something that is not the agent (shortening its history, for one) and
      // would refuse a message now
      return
    }
    sent.push(...clicks)
    quiet = 0
    try {
      pi.sendUserMessage(textOf(clicks), { deliverAs: 'steer' })
    } catch {
      // Pi did not take it. Nothing was handed over, so nothing is remembered as handed over.
      sent = sent.filter((c) => !clicks.includes(c))
    }
  }

  async function check() {
    if (!ctx || checking) return
    checking = true
    try {
      const id = ctx.sessionManager.getSessionId()
      const kept = ctx.sessionManager.getSessionFile?.() ?? null
      // The same conversation under a new id: Pi still keeps it in the same file. Pages made
      // under the old id follow it to the new one. An id that changes together with the file
      // is a different conversation, and the pages of the one that was here stay its own.
      if (session && id !== session && file && kept === file) shared.moves.push({ was: session, now: id })
      session = id
      file = kept
      settle()
      if (!open()) return
      // The connector is told of each change of id, in the order they happened. One is
      // forgotten only once the connector has taken it, so it is told on a later check if not
      // now, and an id that changes again meanwhile takes nothing away from the one before.
      while (shared.moves.length) {
        const move = shared.moves[0]
        if (!(await ask('/session', { harness: HARNESS, session: move.now, was: move.was }))) return
        if (shared.moves[0] === move) shared.moves.shift()
      }
      const got = await ask(`/clicks?harness=${HARNESS}&session=${encodeURIComponent(id)}`)
      // Pi may have shut this conversation down while the connector was answering, or gone to
      // another one: what was asked for the first is not handed to the second
      if (!ctx || !got || !Array.isArray(got.clicks) || ctx.sessionManager.getSessionId() !== id) return
      const clicks = got.clicks.filter((c) => c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text)
      const again = clicks.filter((c) => shared.given.has(c.id))
      // Offered something the agent already has: the earlier report of it was lost, so it is sent again
      if (again.length) void ask('/ack', { ids: again.map((c) => c.id) })
      // Only what the connector offers this very moment is handed over. A click it has stopped
      // offering may have gone to someone else.
      handOver(clicks.filter((c) => !shared.given.has(c.id) && !sent.some((s) => s.id === c.id)))
    } catch {
      // Pi has replaced this conversation, and this copy of the add-on with it
    } finally {
      checking = false
    }
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    ctx = null
  }

  // Pi asks add-ons not to start timers until a conversation has started, because it also
  // loads them for commands that have no conversation (pi list, pi install).
  pi.on('session_start', (_event, context) => {
    stop()
    ctx = context
    running = false
    // Whatever conversation was in this window before (/new, /resume and /fork each put another
    // one in its place) still exists and can be opened again. Its pages stay its own: the
    // connector is not told that it became this one, and a click on one of its pages waits
    // until that conversation is open again.
    try {
      session = ctx.sessionManager.getSessionId()
      file = ctx.sessionManager.getSessionFile?.() ?? null
    } catch {}
    timer = setInterval(() => void check(), 1000)
    // The timer alone must never keep Pi from exiting
    timer.unref?.()
    void check()
  })
  pi.on('session_shutdown', () => {
    // Clicks given to Pi and not yet shown in the conversation were never reported as handed
    // over, so the connector offers them again to whoever listens next.
    stop()
  })
  pi.on('agent_start', () => {
    running = true
  })
  pi.on('agent_end', () => {
    running = false
  })
  pi.on('message_start', (event) => {
    saw(event)
  })
  pi.on('message_end', (event) => {
    saw(event)
  })
}
