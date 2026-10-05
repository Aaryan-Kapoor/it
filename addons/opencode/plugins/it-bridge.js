// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
// This notice stays with the file. The terms are in LICENSE.md, in It's own folder on this machine.
//
// The It add-on for OpenCode. It runs inside OpenCode and brings the user's clicks on pages a
// conversation made into that conversation:
//   - conversation idle  -> a turn starts with the click
//   - turn running       -> the click joins the turn at its next step (nothing is interrupted)
//
// OpenCode gives both of those through one call, `client.session.promptAsync`, which returns
// as soon as OpenCode has agreed to try. Whether the message then got into the conversation
// is told by what OpenCode announces afterwards: see `handOver`. One OpenCode holds many
// conversations, so this add-on asks the connector about each conversation that has had a
// message here since OpenCode started. It asks once a second and never holds a request open.
// Ownership, retries and receipts live in the connector.
//
// OpenCode never changes the id of a conversation: its /new and /clear start another one and
// leave the first as it was. So the connector is never told that an id has changed, and a
// click on a page goes to the conversation that made it, whichever one is on screen.
//
// This file must export the plugin and nothing else: OpenCode treats every export of a plugin
// file as a plugin and refuses the file if one of them is not a function.
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Where It keeps its files, when that was somewhere other than the usual folder at the time
// `it setup` put this add-on in place. `it setup` fills it in. The IT_HOME variable comes first.
const IT_HOME_AT_SETUP = null

const HARNESS = 'opencode'
const EVERY_MS = 1000 // the connector stops counting a conversation as listening after 5 seconds
const ANSWER_MS = 1500 // how long the connector may stay silent, and how long OpenCode is given to say who started a conversation
const DEADLINE_MS = 3000 // how long one question to the connector may take from start to finish, however its answer arrives
const MOST_BYTES = 256 * 1024 // an answer longer than this is not read to its end, and counts as no answer
const PROMPT_MS = 5000 // how long OpenCode is given to say that it will take a message
const SHOWN_MS = 30_000 // how long it is then given to show that message in the conversation
const AGAIN_MS = [1000, 5000, 30_000, 180_000] // how long to wait before trying a refused click again
const MOST = 20 // how many conversations are asked about at once; the least recently active go first

/** Gives up on a call that takes too long, so that nothing here can hold OpenCode up. */
function within(ms, promise) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('too slow')), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** The code that proves a message came from someone who knows the token, without the token being sent. */
const seal = (token, nonce, what) => createHmac('sha256', token).update(`${nonce}\n${what}`).digest('hex')

/** It's folder: where the IT_HOME variable says, or where it was when the add-on was set up, or the usual place. */
const itHome = () => process.env.IT_HOME || (typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP ? IT_HOME_AT_SETUP : path.join(os.homedir(), '.it'))

/** Whether a piece of text in a conversation carries a click: the connector's words for it, or the name those words end with. */
const carries = (text, click) => text.includes(click.text) || text.includes(`[action ${click.id}]`)

export const ItBridge = async ({ client }) => {
  let connector = null // { socket | port, token }, read from the connector's own file
  let lookedAt = 0
  let timer = null
  let asking = false // one round of questions to the connector is in progress
  // The conversations asked about, by id. Each one remembers the agent and model its last
  // message used, the clicks being handed over now, the clicks OpenCode was given and has not
  // yet shown in the conversation, and how many times in a row a click for it came to nothing.
  // No click is kept for handing over between one answer of the connector and the next.
  const sessions = new Map()
  const roots = new Map() // a conversation's id -> the id of the conversation the person sees
  const given = new Set() // clicks the agent already has, which must never be handed over a second time
  const users = new Set() // ids of messages on the person's side of a conversation, which is where a click arrives

  async function find() {
    if (Date.now() - lookedAt < (connector ? 30000 : 3000)) return connector
    lookedAt = Date.now()
    const home = itHome()
    try {
      const c = JSON.parse(await readFile(path.join(home, 'connector.json'), 'utf8'))
      // Only a token and a port number are taken from the file. The socket is always the one in
      // that same folder, whatever the file says, so nothing in it can point anywhere else.
      const socket = typeof c.socket === 'string' && c.socket ? path.join(home, 'connector.sock') : null
      const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null
      const usable = typeof c.token === 'string' && /^[0-9a-f]{16,128}$/.test(c.token) && (socket || port)
      connector = usable ? { socket, port, token: c.token } : null
    } catch {
      connector = null
    }
    return connector
  }

  /**
   * Asks the connector one thing. The answer is null whenever there was none to be believed:
   * none at all, one that took too long or was too long, or one over a port that was not sealed
   * with the token.
   */
  async function ask(pathname, body) {
    const c = await find()
    if (!c) return null
    const text = body === undefined ? undefined : JSON.stringify(body)
    const method = text === undefined ? 'GET' : 'POST'
    // Over the socket, which only this user can open, the token is shown. Over a port it never
    // is: the request and the answer are each sealed with it, so a program that took the
    // connector's port after a crash learns nothing, and nothing it answers is believed.
    const nonce = randomBytes(16).toString('hex')
    const proof = c.socket ? { 'x-it-token': c.token } : { 'x-it-nonce': nonce, 'x-it-mac': seal(c.token, nonce, `${method}\n${pathname}\n${text ?? ''}`) }
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
      // sent a little at a time cannot hold a round up for ever
      deadline = setTimeout(giveUp, DEADLINE_MS)
      deadline.unref?.()
      try {
        req = http.request(
          {
            ...(c.socket ? { socketPath: c.socket } : { host: '127.0.0.1', port: c.port }),
            path: pathname,
            method,
            headers: { ...proof, 'content-type': 'application/json', ...(text === undefined ? {} : { 'content-length': Buffer.byteLength(text) }) },
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
            res.on('end', () => {
              if (over) return
              const got = Buffer.concat(pieces).toString('utf8')
              if (res.statusCode === 401) lookedAt = 0 // the connector restarted: read its file again
              if (res.statusCode !== 200) return answer(null)
              if (!c.socket && res.headers['x-it-mac'] !== seal(c.token, nonce, `200\n${got}`)) return answer(null)
              try {
                answer(JSON.parse(got))
              } catch {
                answer(null)
              }
            })
            res.on('error', giveUp)
            res.on('close', giveUp)
          },
        )
        req.on('timeout', giveUp)
        req.on('error', () => {
          lookedAt = 0
          giveUp()
        })
        req.end(text)
      } catch {
        giveUp()
      }
    })
  }

  /**
   * The conversation the person sees. A subagent runs in a conversation of its own, which is
   * over when its task is done, so a page a subagent makes belongs to the conversation that
   * started it, and a click on that page goes there.
   *
   * Null when that conversation is not known for sure: OpenCode could not be asked, or did not
   * answer in time, or the chain of who started whom was longer than is followed here. Taking
   * the conversation that asked for its own root would then make a subagent's page the
   * subagent's own. Nothing is remembered about a failure, so it is looked up again next time.
   */
  async function rootOf(id) {
    const known = roots.get(id)
    if (known) return known
    let at = id
    try {
      for (let hops = 0; hops < 8; hops++) {
        const res = await within(ANSWER_MS, client.session.get({ path: { id: at } }))
        if (!res || res.error || res.data?.id !== at) return null
        const parent = res.data.parentID
        if (typeof parent !== 'string' || !parent) {
          // Nobody started this one: it is the conversation the person is in
          roots.set(id, at)
          if (roots.size > 500) roots.delete(roots.keys().next().value)
          return at
        }
        at = parent
      }
    } catch {}
    return null
  }

  /**
   * From now on this conversation is one of those asked about. The asking itself starts once
   * its agent is known: see `round`.
   */
  function listen(id) {
    const known = sessions.get(id)
    if (known) {
      // Put back at the end, so that the conversations used least recently are the first to go
      sessions.delete(id)
      sessions.set(id, known)
      return known
    }
    const s = { id, agent: undefined, model: undefined, variant: undefined, sending: [], watched: new Map(), waiting: null, tries: 0, notBefore: 0 }
    sessions.set(id, s)
    while (sessions.size > MOST) sessions.delete(sessions.keys().next().value)
    if (!timer) {
      timer = setInterval(() => void round(), EVERY_MS)
      // The timer alone must not keep OpenCode running once its own work is done
      timer.unref?.()
    }
    return s
  }

  /** The agent has these now. The connector is told, and told again on a later check if that fails. */
  function gave(clicks) {
    for (const c of clicks) given.add(c.id)
    if (given.size > 2000) for (const id of [...given].slice(0, 1000)) given.delete(id)
    void ask('/ack', { ids: clicks.map((c) => c.id) })
  }

  /** Whether an answer of OpenCode's says that it will take the message. */
  const took = (res) => Boolean(res) && !res.error && (!res.response || res.response.ok)

  /** A message on the person's side of a conversation. Its id is how a piece of text is known to be theirs and not the agent's. */
  function person(id) {
    if (typeof id !== 'string' || !id) return
    users.add(id)
    if (users.size > 500) for (const old of [...users].slice(0, 250)) users.delete(old)
  }

  /**
   * OpenCode has put a piece of text into a conversation. If it is in a message on the
   * person's side and carries clicks that were handed over, the agent has those clicks now,
   * and only now are they reported.
   */
  function shown(part) {
    if (part?.type !== 'text' || typeof part.text !== 'string' || !users.has(part.messageID)) return
    const s = sessions.get(part.sessionID)
    if (!s) return
    // OpenCode has just stored a message for this conversation, so whatever made a click come
    // to nothing before may be over (the person may have chosen another model, for one). A
    // click that is waiting is tried again at once.
    s.tries = 0
    s.notBefore = 0
    const here = [...s.watched.values()].map((w) => w.click).filter((c) => carries(part.text, c))
    if (!here.length) return
    for (const c of here) s.watched.delete(c.id)
    gave(here)
    s.waiting?.(false)
  }

  /**
   * Waits until every one of these clicks has been seen in the conversation. False when
   * OpenCode says something went wrong in that conversation first, when the time is up, or
   * when the waiting is called off (`s.waiting(true)`).
   */
  function untilShown(s, clicks, until) {
    return new Promise((resolve) => {
      const all = () => clicks.every((c) => given.has(c.id))
      const settle = (over) => {
        if (!all() && !over) return
        clearTimeout(timer)
        if (s.waiting === settle) s.waiting = null
        resolve(all())
      }
      const timer = setTimeout(() => settle(true), Math.max(0, until - Date.now()))
      timer.unref?.()
      s.waiting = settle
    })
  }

  async function handOver(s, clicks) {
    s.sending = clicks
    const began = Date.now()
    for (const [id, w] of s.watched) if (began - w.since > 10 * SHOWN_MS) s.watched.delete(id)
    // Watched and waited for from before OpenCode is asked. What it announces about a message
    // can arrive before its answer to the call does, and must not be missed.
    for (const c of clicks) s.watched.set(c.id, { click: c, since: began })
    const there = untilShown(s, clicks, began + SHOWN_MS)
    let res = null
    try {
      // Not waited on for long, so that an OpenCode that never answers cannot keep this
      // conversation from ever being given anything again
      res = await within(
        PROMPT_MS,
        client.session.promptAsync({
          path: { id: s.id },
          body: {
            // The same agent and model as the conversation's last message. Left out, OpenCode
            // would switch to its default agent, which may be allowed more than the one in use.
            agent: s.agent,
            ...(s.model ? { model: s.model } : {}),
            ...(s.variant ? { variant: s.variant } : {}),
            // One wording, made by the connector, which names each click so a repeat can be told apart
            parts: [{ type: 'text', text: clicks.map((c) => c.text).join('\n') }],
          },
        }),
      )
    } catch {}
    // OpenCode answers as soon as it has agreed to try, and only then does its work: other
    // add-ons may still refuse the message, and storing it may still fail. So its answer is
    // not taken as proof. The proof is the message itself: OpenCode announces every piece of
    // text it stores, and the click counts as handed over once its text has been announced
    // in a message on the person's side of this conversation. Without OpenCode's agreement
    // there is nothing to wait for.
    if (!took(res)) s.waiting?.(true)
    const shownThere = await there
    s.sending = []
    if (shownThere) {
      s.tries = 0
      s.notBefore = 0
      return
    }
    // OpenCode said no outright, so nothing will appear. In every other case the clicks stay
    // watched for a while: should their text turn up after this add-on has stopped waiting,
    // the agent has them all the same, and they are reported then and not given again.
    if (res && !took(res)) for (const c of clicks) s.watched.delete(c.id)
    if (res?.response?.status === 404) {
      // The conversation is gone. It is not asked about again, and the connector lets
      // the click wait where the person can see it.
      if (sessions.get(s.id) === s) sessions.delete(s.id)
      return
    }
    // Anything else: the message did not get into the conversation, as far as can be told.
    // Nothing is kept for handing over. If the connector still offers the clicks once the wait
    // is over, they are tried again, each time after a longer wait.
    s.notBefore = Date.now() + AGAIN_MS[Math.min(s.tries, AGAIN_MS.length - 1)]
    s.tries++
  }

  async function check(s) {
    const got = await ask(`/clicks?harness=${HARNESS}&session=${encodeURIComponent(s.id)}`)
    // The conversation may have been dropped while the connector was answering
    if (!got || !Array.isArray(got.clicks) || sessions.get(s.id) !== s) return
    const clicks = got.clicks.filter((c) => c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text)
    const again = clicks.filter((c) => given.has(c.id))
    // Offered something the agent already has: the earlier report of it was lost, so it is sent again
    if (again.length) void ask('/ack', { ids: again.map((c) => c.id) })
    // Only what the connector offers this very moment is handed over. A click it has stopped
    // offering may have gone to someone else.
    const fresh = clicks.filter((c) => !given.has(c.id))
    if (!fresh.length || s.sending.length || Date.now() < s.notBefore) return
    // Not waited for: the connector goes on being asked while OpenCode takes the message
    void handOver(s, fresh)
  }

  /** Asks about every conversation, one after the other. A round never overlaps the one before. */
  async function round() {
    if (asking) return
    asking = true
    try {
      for (const s of [...sessions.values()]) {
        // Asking tells the connector that someone is listening, and it then sets the
        // conversation's clicks aside for this add-on. So a conversation is only asked about
        // once a click could be handed to it, which takes knowing the agent it is in: a click
        // handed over without one could move the conversation to OpenCode's default agent.
        // And one that has refused twice running is not asked about while it is being left
        // alone: asking would keep its click set aside here, where `it wait` and the site
        // cannot have it.
        if (sessions.get(s.id) === s && s.agent && !(s.tries >= 2 && Date.now() < s.notBefore)) await check(s)
      }
    } catch {
    } finally {
      asking = false
    }
  }

  return {
    // Every message that reaches a conversation passes here, whoever sent it
    'chat.message': async (input, output) => {
      try {
        // Noted before anything is waited for, so that it is known by the time OpenCode announces the message's text
        person(output?.message?.id)
        const id = input?.sessionID
        if (typeof id !== 'string' || !id) return
        const root = await rootOf(id)
        if (!root) return // whose message this is cannot be told, so nothing is learned from it
        const s = listen(root)
        if (root !== id) return // a subagent's own agent and model are not the conversation's
        const said = output?.message
        const unknown = !s.agent
        if (typeof said?.agent === 'string' && said.agent) s.agent = said.agent
        const m = said?.model
        if (typeof m?.providerID === 'string' && typeof m?.modelID === 'string') {
          s.model = { providerID: m.providerID, modelID: m.modelID }
          s.variant = typeof m.variant === 'string' && m.variant ? m.variant : undefined
        }
        if (unknown && s.agent) void round()
      } catch {}
    },
    // Every command the agent runs says which conversation it belongs to, which is how the
    // `it` command knows whose page it is making. OpenCode does not say so by itself.
    'shell.env': async (input, output) => {
      try {
        const id = input?.sessionID
        // A terminal the person opened themselves belongs to no conversation
        if (typeof id !== 'string' || !id || !output?.env) return
        const root = await rootOf(id)
        // When the conversation the person sees is not known for sure, the command is told
        // nothing. A page it makes then belongs to no conversation, and its clicks wait where
        // the person can see them, which is better than a subagent's page becoming its own.
        if (!root) return
        output.env.IT_HARNESS = HARNESS
        output.env.IT_SESSION = root
        // The commands the agent runs are told where It's folder is too, when it is not the usual place: the `it` command they run must use the same one as this add-on
        if (!process.env.IT_HOME && typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP) output.env.IT_HOME = IT_HOME_AT_SETUP
        listen(root)
      } catch {}
    },
    // Everything OpenCode announces passes here. Four things matter: a message on the person's
    // side being stored, a piece of text being stored, something going wrong in a conversation,
    // and a conversation being deleted.
    event: async ({ event }) => {
      try {
        const about = event?.properties
        if (event?.type === 'message.updated') {
          if (about?.info?.role === 'user') person(about.info.id)
        } else if (event?.type === 'message.part.updated') {
          shown(about?.part)
        } else if (event?.type === 'session.error') {
          // Whatever was on its way into this conversation may not have got there
          sessions.get(about?.sessionID)?.waiting?.(true)
        } else if (event?.type === 'session.deleted') {
          const id = about?.info?.id
          if (typeof id !== 'string') return
          sessions.get(id)?.waiting?.(true)
          sessions.delete(id)
          roots.delete(id)
        }
      } catch {}
    },
    dispose: async () => {
      if (timer) clearInterval(timer)
      timer = null
      for (const s of sessions.values()) s.waiting?.(true)
      sessions.clear()
    },
  }
}
