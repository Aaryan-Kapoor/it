// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.1.
// This notice stays with the file. The terms are in LICENSE.md, in It's own folder on this machine.
//
// The It add-on for OpenCode. It runs inside OpenCode and brings the user's clicks on pages a
// conversation made into that conversation:
//   - conversation idle  -> a turn starts with the click
//   - turn running       -> the click joins the turn at its next step (nothing is interrupted)
//
// OpenCode has two plugin interfaces, and this one file serves both. OpenCode 1.x loads the
// `server` function of the default export and hands it a client of OpenCode's HTTP API; OpenCode
// 2.x loads the `setup` function and hands it OpenCode's own domains. Each runs the same bridge
// (`bridge`), and differs only in how it learns of a conversation, how it hands a message over,
// and how it learns that the message got into the conversation. One OpenCode holds many
// conversations, so this add-on asks the connector about each conversation that has had a
// message here since OpenCode started. It asks once a second and never holds a request open.
// Ownership, retries and receipts live in the connector.
//
// OpenCode never changes the id of a conversation: its /new and /clear start another one and
// leave the first as it was. So the connector is never told that an id has changed, and a
// click on a page goes to the conversation that made it, whichever one is on screen.
//
// This file must export the plugin definition as its default export and nothing else. OpenCode
// 1.x refuses a file whose default export has an id and no `server` function, and treats every
// export as a plugin where there is no such default. OpenCode 2.x refuses a file whose default
// export has no id or no `setup` function.
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Where It keeps its files, when that was somewhere other than the usual folder at the time
// `it setup` put this add-on in place. `it setup` fills it in. The IT_HOME variable comes first.
const IT_HOME_AT_SETUP = null

const ADDON_VERSION = 'IT_ADDON_BUILD'
const HARNESS = 'opencode'
// What the agent is told of It among its own instructions, which this add-on adds: when a page
// is the answer. The skill says how, and an agent reads it only once it has decided to use It.
// The same words as every add-on that says them, kept in It's protocol as `WHEN`.
const WHEN =
  'It is set up on this machine: a two-way workspace that you custom-make for the user, on any screen they own. You build the interface the task calls for as a page, what the user does on it comes back to you, and you answer on the page. Whenever the user is to see, use, play, choose, fill in or decide on something, build it there and do not write it into the chat. Load the skill named `it` before the first page. A plain answer to a plain question stays in the chat.'
const EVERY_MS = 1000 // the connector stops counting a conversation as listening after 5 seconds
const ANSWER_MS = 1500 // how long the connector may stay silent, and how long OpenCode is given to say who started a conversation
const DEADLINE_MS = 3000 // how long one question to the connector may take from start to finish, however its answer arrives
const MOST_BYTES = 256 * 1024 // an answer longer than this is not read to its end, and counts as no answer
const PROMPT_MS = 5000 // how long OpenCode is given to say that it will take a message
const SHOWN_MS = 30_000 // how long it is then given to show that message in the conversation
const ADMITTED_MS = 30 * 60_000 // how long a message OpenCode 2.x has admitted to a conversation's inbox keeps other clicks for that conversation waiting
const AGAIN_MS = [1000, 5000, 30_000, 180_000] // how long to wait before trying a refused click again
const MOST = 40 // how many conversations are asked about at once, which is as many as the connector watches; the least recently active go first

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

/**
 * The answer in what the connector sent before it closed the connection: its status, its
 * headers by their names in small letters, and its body as text. Null when what was sent is
 * not a whole answer.
 */
function answerIn(raw) {
  const end = raw.indexOf('\r\n\r\n')
  if (end < 0) return null
  const [first, ...lines] = raw.toString('latin1', 0, end).split('\r\n')
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(first)?.[1]
  if (!status) return null
  const headers = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  let body = raw.subarray(end + 4)
  if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) {
    // Sent in pieces, each behind a line that says how long it is, with a piece of no length last
    const pieces = []
    for (let at = 0; ; ) {
      const line = body.indexOf('\r\n', at)
      const length = line < 0 ? Number.NaN : Number.parseInt(body.toString('latin1', at, line), 16)
      if (!(length >= 0) || line + 2 + length > body.length) return null
      if (length === 0) break
      pieces.push(body.subarray(line + 2, line + 2 + length))
      at = line + 2 + length + 2
    }
    body = Buffer.concat(pieces)
  } else if (headers['content-length'] !== undefined) {
    const length = Number(headers['content-length'])
    if (!Number.isInteger(length) || length < 0 || length > body.length) return null
    body = body.subarray(0, length)
  }
  return { status: Number(status), headers, text: body.toString('utf8') }
}

/**
 * Puts one question to the connector on a connection of this add-on's own, opened to the socket
 * in It's folder or to the port on this machine and to nothing else, with the question written
 * out as plain HTTP. Neither `node:http` nor `fetch` is used for it. Node, told to use the
 * environment's proxy, sends what they ask through it, and Bun does whenever a proxy is named
 * there, though the question is for this very machine: the proxy would be shown which
 * conversation is asked about, and what was done on its pages. Null when there was no answer:
 * none at all, one that took too long or was too long, or one that is not an answer.
 */
function exchange(c, method, route, headers, text) {
  return new Promise((resolve) => {
    const pieces = []
    let size = 0
    let over = false
    let socket
    const answer = (value) => {
      if (over) return
      over = true
      clearTimeout(deadline)
      socket?.destroy()
      resolve(value)
    }
    // Counted from the start and not put off by bytes that keep arriving, so that an answer
    // sent a little at a time cannot hold a check up for ever
    const deadline = setTimeout(() => answer(null), DEADLINE_MS)
    deadline.unref?.()
    try {
      socket = c.socket ? net.connect({ path: c.socket }) : net.connect({ host: '127.0.0.1', port: c.port })
      socket.setTimeout(ANSWER_MS, () => answer(null))
      // Whatever goes wrong, the connection ends by closing, and a second answer to a promise is ignored
      socket.on('error', () => answer(null))
      socket.on('close', () => answer(null))
      socket.on('connect', () => {
        const head = [
          `${method} ${route} HTTP/1.1`,
          `host: ${c.socket ? 'it' : `127.0.0.1:${c.port}`}`,
          // The connector closes the connection once it has answered, so the answer is whole when the connection ends
          'connection: close',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          ...(text ? [`content-length: ${Buffer.byteLength(text)}`] : []),
        ]
        socket.write(`${head.join('\r\n')}\r\n\r\n${text ?? ''}`)
      })
      // An answer that grows past the limit is dropped there and then, before its seal is
      // looked at and before any of it is read as JSON. The next question starts afresh.
      socket.on('data', (piece) => {
        size += piece.length
        if (size > MOST_BYTES) answer(null)
        else pieces.push(piece)
      })
      socket.on('end', () => answer(answerIn(Buffer.concat(pieces))))
    } catch {
      answer(null)
    }
  })
}

/**
 * What both of OpenCode's plugin interfaces share: finding the connector, asking it about each
 * conversation, and handing the clicks it offers over to OpenCode. What differs between them is
 * given as `app`:
 *   - `missing`: which of the calls a click needs this OpenCode lacks ('session', 'submit')
 *   - `ready(s)`: whether a click can be handed to this conversation yet
 *   - `submit(s, text)`: hands the text to the conversation `s.into` as a message on the
 *     person's side. It answers 'took' where OpenCode said it will take it, 'no' where it said
 *     no, 'gone' where the conversation is not there, and null where nothing was heard in time.
 *   - `admitted(s, clicks)`, where the app has one: whether OpenCode holds a message with these
 *     clicks that it has taken and not yet put into the conversation or dropped
 *
 * What comes back is how each interface tells the bridge what OpenCode says has happened.
 */
function bridge(app) {
  // Each bridge is an add-on of its own to the connector: OpenCode 2.x may set the plugin up
  // once for each folder it works in, all in one process
  const INSTANCE = randomBytes(12).toString('hex')
  // When this bridge began, by this machine's clock: the connector goes by it to tell an add-on
  // that was loaded after OpenCode refused one from an add-on that had been running since before
  const SINCE = Date.now()
  let connector = null // { socket | port, token }, read from the connector's own file
  let lookedAt = 0
  let timer = null
  let asking = false // one round of questions to the connector is in progress
  // The conversations asked about, by the id the connector knows each one's pages by. `into` is
  // the conversation its clicks are handed to, which is the one the person sees: the same id,
  // or for a subagent's own conversation the one that started it. Each one remembers the clicks
  // being handed over now, the clicks OpenCode was given and has not yet shown in the
  // conversation, and how many times in a row a click for it came to nothing. No click is kept
  // for handing over between one answer of the connector and the next.
  const sessions = new Map()
  const given = new Set() // clicks the agent already has, which must never be handed over a second time

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

  const addon = () => ({ api: 1, version: ADDON_VERSION, delivery: app.missing.length === 0, idle: false, missing: [...app.missing], since: SINCE })

  /**
   * Asks the connector one thing. The answer is null whenever there was none to be believed:
   * none at all, one that took too long or was too long, or one over a port that was not sealed
   * with the token.
   */
  async function ask(pathname, body) {
    if (pathname === '/session' || pathname.startsWith('/clicks?')) body = { ...body, instance: INSTANCE, addon: addon() }

    const c = await find()
    if (!c) return null
    const text = body === undefined ? undefined : JSON.stringify(body)
    const method = text === undefined ? 'GET' : 'POST'
    // Over the socket, which only this user can open, the token is shown. Over a port it never
    // is: the request and the answer are each sealed with it, so a program that took the
    // connector's port after a crash learns nothing, and nothing it answers is believed.
    const nonce = randomBytes(16).toString('hex')
    const proof = c.socket ? { 'x-it-token': c.token } : { 'x-it-nonce': nonce, 'x-it-mac': seal(c.token, nonce, `${method}\n${pathname}\n${text ?? ''}`) }
    const got = await exchange(c, method, pathname, { ...proof, 'content-type': 'application/json' }, text)
    // No answer, or an answer that says the word is wrong: the connector restarted, so its file is read again
    if (!got || got.status === 401) lookedAt = 0
    if (got?.status !== 200) return null
    if (!c.socket && got.headers['x-it-mac'] !== seal(c.token, nonce, `200\n${got.text}`)) return null
    try {
      return JSON.parse(got.text)
    } catch {
      return null
    }
  }

  /**
   * From now on this conversation is one of those asked about, and its clicks are handed to
   * `into`. The asking itself starts once a click could be handed to it: see `round`.
   */
  function listen(id, into = id) {
    const known = sessions.get(id)
    if (known) {
      // Put back at the end, so that the conversations used least recently are the first to go
      sessions.delete(id)
      sessions.set(id, known)
      return known
    }
    const s = { id, into, sending: [], watched: new Map(), waiting: null, tries: 0, notBefore: 0 }
    sessions.set(id, s)
    while (sessions.size > MOST) sessions.delete(sessions.keys().next().value)
    start()
    return s
  }

  /** Asking begins, if it has not: once a second, about every conversation listened for, or else to say that this OpenCode is open. */
  function start() {
    if (timer) return
    timer = setInterval(() => void round(), EVERY_MS)
    // The timer alone must not keep OpenCode running once its own work is done
    timer.unref?.()
  }

  /** The agent has these now. The connector is told, and told again on a later check if that fails. */
  function gave(clicks) {
    for (const c of clicks) given.add(c.id)
    if (given.size > 2000) for (const id of [...given].slice(0, 1000)) given.delete(id)
    void ask('/ack', { ids: clicks.map((c) => c.id) })
  }

  /** Every conversation whose clicks are handed to this one, the one the person sees. */
  const handedTo = (into) => [...sessions.values()].filter((s) => s.into === into)

  /**
   * OpenCode has put this text into the conversation `into`, on the person's side. Clicks that
   * were handed over and that it carries are with the agent now, and only now are they reported.
   */
  function shown(into, text) {
    if (typeof into !== 'string' || typeof text !== 'string') return
    for (const s of handedTo(into)) {
      // OpenCode has just stored a message for this conversation, so whatever made a click come
      // to nothing before may be over (the person may have chosen another model, for one). A
      // click that is waiting is tried again at once.
      s.tries = 0
      s.notBefore = 0
      const here = [...s.watched.values()].map((w) => w.click).filter((c) => carries(text, c))
      if (!here.length) continue
      for (const c of here) s.watched.delete(c.id)
      gave(here)
      s.waiting?.(false)
    }
  }

  /** Whatever was on its way into the conversation `into` may not have got there: whoever waits for it stops waiting. */
  function failed(into) {
    for (const s of handedTo(into)) s.waiting?.(true)
  }

  /** OpenCode dropped this text on its way into the conversation `into`. Only clicks it carries stop being waited for. */
  function dropped(into, text) {
    if (typeof text !== 'string') return
    for (const s of handedTo(into)) if ([...s.watched.values()].some((w) => carries(text, w.click))) s.waiting?.(true)
  }

  /** The conversation is gone. Nothing is asked about it again, nor handed to it. */
  function gone(id) {
    if (typeof id !== 'string') return
    for (const s of [...sessions.values()])
      if (s.id === id || s.into === id) {
        s.waiting?.(true)
        sessions.delete(s.id)
      }
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
    // Clicks OpenCode still holds stay watched however long that takes, so that they are reported when it delivers them
    for (const [id, w] of s.watched) if (began - w.since > 10 * SHOWN_MS && !app.admitted?.(s, [w.click])) s.watched.delete(id)
    // Watched and waited for from before OpenCode is asked. What it announces about a message
    // can arrive before its answer to the call does, and must not be missed.
    for (const c of clicks) s.watched.set(c.id, { click: c, since: began })
    const there = untilShown(s, clicks, began + SHOWN_MS)
    let said = null
    try {
      // Not waited on for long, so that an OpenCode that never answers cannot keep this
      // conversation from ever being given anything again. One wording, made by the connector,
      // which names each click so a repeat can be told apart.
      said = await within(PROMPT_MS, app.submit(s, clicks.map((c) => c.text).join('\n')))
    } catch {}
    // OpenCode answers as soon as it has agreed to try, and only then does its work: other
    // add-ons may still refuse the message, and storing it may still fail. So its answer is
    // not taken as proof. The proof is the message itself: the click counts as handed over once
    // OpenCode has said that its text is in a message on the person's side of this
    // conversation. Without OpenCode's agreement there is nothing to wait for.
    if (said !== 'took') s.waiting?.(true)
    let shownThere = await there
    // OpenCode 2.x admits a message to the conversation's inbox, and delivers it at the
    // conversation's next step, which a long command can put off for minutes. While the message
    // is admitted and neither delivered nor dropped, the clicks are on their way: handing them
    // over again would put them into the conversation twice. So they are waited for, and are
    // never handed over again while OpenCode holds them (see `check`). Past half an hour the
    // conversation is given other clicks meanwhile, and these stay watched until OpenCode
    // delivers them or drops them.
    while (!shownThere && said === 'took' && app.admitted?.(s, clicks) && Date.now() - began < ADMITTED_MS)
      shownThere = await untilShown(s, clicks, Math.min(Date.now() + SHOWN_MS, began + ADMITTED_MS))
    s.sending = []
    if (!shownThere && said === 'took' && app.admitted?.(s, clicks)) return
    if (shownThere) {
      s.tries = 0
      s.notBefore = 0
      return
    }
    // OpenCode said no outright, so nothing will appear. In every other case the clicks stay
    // watched for a while: should their text turn up after this add-on has stopped waiting,
    // the agent has them all the same, and they are reported then and not given again.
    if (said === 'no' || said === 'gone') for (const c of clicks) s.watched.delete(c.id)
    if (said === 'gone') {
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
    // Nor what OpenCode holds already, on its way into the conversation
    const fresh = clicks.filter((c) => !given.has(c.id) && !app.admitted?.(s, [c]))
    if (!fresh.length || s.sending.length || Date.now() < s.notBefore) return
    // Not waited for: the connector goes on being asked while OpenCode takes the message
    void handOver(s, fresh)
  }

  /** Asks about every conversation, one after the other. A round never overlaps the one before. */
  async function round() {
    if (asking) return
    asking = true
    try {
      if (!addon().delivery || ![...sessions.values()].some((s) => app.ready(s))) {
        await ask('/addon', { harness: HARNESS, instance: INSTANCE, addon: addon() })
        return
      }
      let polled = false
      for (const s of [...sessions.values()]) {
        // Asking tells the connector that someone is listening, and it then sets the
        // conversation's clicks aside for this add-on. So a conversation is only asked about
        // once a click could be handed to it. And one that has refused twice running is not
        // asked about while it is being left alone: asking would keep its click set aside
        // here, where `it wait` and the site cannot have it.
        if (sessions.get(s.id) === s && app.ready(s) && !(s.tries >= 2 && Date.now() < s.notBefore)) {
          polled = true
          await check(s)
        }
      }
      // Backoff releases the clicks, not the evidence that this host is still open.
      if (!polled) await ask('/addon', { harness: HARNESS, instance: INSTANCE, addon: addon() })
    } catch {
    } finally {
      asking = false
    }
  }

  function dispose() {
    if (timer) clearInterval(timer)
    timer = null
    for (const s of sessions.values()) s.waiting?.(true)
    sessions.clear()
  }

  // No supported event identifies a selected saved session. Report the host without guessing one.
  start()

  return { sessions, listen, round, shown, failed, dropped, gone, dispose }
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
 * `parentOf` answers the conversation that started one, '' for none, or null where that could
 * not be told.
 */
function roots(parentOf) {
  const known = new Map()
  return async (id) => {
    const found = known.get(id)
    if (found) return found
    let at = id
    try {
      for (let hops = 0; hops < 8; hops++) {
        const parent = await within(ANSWER_MS, parentOf(at))
        if (parent === null || parent === undefined) return null
        if (!parent) {
          // Nobody started this one: it is the conversation the person is in
          known.set(id, at)
          if (known.size > 500) known.delete(known.keys().next().value)
          return at
        }
        at = parent
      }
    } catch {}
    return null
  }
}

/** Puts It's folder of programs last on a command's PATH, where it is not there already, so that an `it` already on the PATH comes first. */
function withIt(env) {
  // The commands the agent runs are told where It's folder is too, when it is not the usual place: the `it` command they run must use the same one as this add-on
  if (!process.env.IT_HOME && typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP) env.IT_HOME = IT_HOME_AT_SETUP
  // An OpenCode started from the terminal It was installed in has a PATH from before It was on it
  const bin = path.join(itHome(), 'bin')
  const now = env.PATH ?? process.env.PATH ?? ''
  if (!now.split(path.delimiter).includes(bin)) env.PATH = now ? `${now}${path.delimiter}${bin}` : bin
}

/**
 * The add-on as OpenCode 1.x loads it. Its client is OpenCode's HTTP API: `session.promptAsync`
 * returns as soon as OpenCode has agreed to try, and whether the message then got into the
 * conversation is told by what OpenCode announces afterwards, each piece of text it stores.
 */
async function server({ client }) {
  const session = typeof client?.session?.get === 'function'
  const submit = typeof client?.session?.promptAsync === 'function'
  const rootOf = roots(async (id) => {
    const res = await client.session.get({ path: { id } })
    if (!res || res.error || res.data?.id !== id) return null
    const parent = res.data.parentID
    return typeof parent === 'string' && parent ? parent : ''
  })
  const users = new Set() // ids of messages on the person's side of a conversation, which is where a click arrives
  /** Whether an answer of OpenCode's says that it will take the message. */
  const took = (res) => Boolean(res) && !res.error && (!res.response || res.response.ok)
  const b = bridge({
    missing: [...(session ? [] : ['session']), ...(submit ? [] : ['submit'])],
    // A click handed over without the agent the conversation is in could move the conversation
    // to OpenCode's default agent, which may be allowed more than the one in use
    ready: (s) => Boolean(s.agent),
    async submit(s, text) {
      const res = await client.session.promptAsync({
        path: { id: s.into },
        body: {
          // The same agent and model as the conversation's last message. Left out, OpenCode
          // would switch to its default agent, which may be allowed more than the one in use.
          agent: s.agent,
          ...(s.model ? { model: s.model } : {}),
          ...(s.variant ? { variant: s.variant } : {}),
          parts: [{ type: 'text', text }],
        },
      })
      if (took(res)) return 'took'
      if (res?.response?.status === 404) return 'gone'
      return res ? 'no' : null
    },
  })

  /** A message on the person's side of a conversation. Its id is how a piece of text is known to be theirs and not the agent's. */
  function person(id) {
    if (typeof id !== 'string' || !id) return
    users.add(id)
    if (users.size > 500) for (const old of [...users].slice(0, 250)) users.delete(old)
  }

  return {
    // Said last among the agent's instructions, once, each time OpenCode puts them together
    'experimental.chat.system.transform': async (_input, output) => {
      if (Array.isArray(output?.system) && !output.system.includes(WHEN)) output.system.push(WHEN)
    },
    // Every message that reaches a conversation passes here, whoever sent it
    'chat.message': async (input, output) => {
      try {
        // Noted before anything is waited for, so that it is known by the time OpenCode announces the message's text
        person(output?.message?.id)
        const id = input?.sessionID
        if (typeof id !== 'string' || !id) return
        const root = await rootOf(id)
        if (!root) return // whose message this is cannot be told, so nothing is learned from it
        const s = b.listen(root)
        if (root !== id) return // a subagent's own agent and model are not the conversation's
        const said = output?.message
        const unknown = !s.agent
        if (typeof said?.agent === 'string' && said.agent) s.agent = said.agent
        const m = said?.model
        if (typeof m?.providerID === 'string' && typeof m?.modelID === 'string') {
          s.model = { providerID: m.providerID, modelID: m.modelID }
          s.variant = typeof m.variant === 'string' && m.variant ? m.variant : undefined
        }
        if (unknown && s.agent) void b.round()
      } catch {}
    },
    // Every command the agent runs says which conversation it belongs to, which is how the
    // `it` command knows whose page it is making. OpenCode 1.x does not say so by itself.
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
        withIt(output.env)
        b.listen(root)
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
          const part = about?.part
          if (part?.type === 'text' && users.has(part.messageID)) b.shown(part.sessionID, part.text)
        } else if (event?.type === 'session.error') {
          b.failed(about?.sessionID)
        } else if (event?.type === 'session.deleted') {
          b.gone(about?.info?.id)
        }
      } catch {}
    },
    dispose: async () => b.dispose(),
  }
}

/**
 * The add-on as OpenCode 2.x loads it, given OpenCode's own domains. `session.prompt` admits a
 * message to a conversation's inbox and answers with it; OpenCode then says when the message
 * has been delivered into the conversation (`session.inbox.delivered`), or that it was dropped
 * (`session.inbox.cancelled`). A conversation keeps its own agent and model, so a message
 * handed over moves it to no other.
 *
 * OpenCode 2.x tells every command the agent runs which conversation it is in, as
 * OPENCODE_SESSION_ID, and gives a plugin no way to see which conversation a command belongs
 * to. So a page a subagent makes belongs to the subagent's own conversation, and this add-on
 * asks about that conversation too and hands its clicks to the conversation that started it.
 */
async function setup(ctx) {
  // OpenCode 1.x carries an early copy of the 2.x plugin host beside its own, which loads this
  // file too and calls `setup` with a context that cannot hand a message over. That OpenCode runs
  // `server` as well, which can. So where the context lacks any call a click needs, this does
  // nothing at all: it says nothing to the connector, which would otherwise take OpenCode for one
  // that cannot take clicks.
  const can = (domain, name) => typeof ctx?.[domain]?.[name] === 'function'
  if (!(can('session', 'get') && can('session', 'prompt') && can('session', 'hook') && can('shell', 'hook') && can('event', 'subscribe'))) return
  const rootOf = roots(async (id) => {
    try {
      const got = await ctx.session.get({ sessionID: id })
      if (got?.id !== id) return null
      return typeof got.parentID === 'string' && got.parentID ? got.parentID : ''
    } catch {
      return null
    }
  })
  // The messages on their way into a conversation, by the id OpenCode gives each one, with
  // their text: what is delivered or dropped is told by that id alone
  const inbox = new Map()
  const delivered = new Set() // what was said to be delivered before this add-on knew its text
  const note = (map, id, value) => {
    if (value === undefined) map.add(id)
    else map.set(id, value)
    if (map.size > 500) map.delete(map.keys().next().value)
  }
  const b = bridge({
    missing: [],
    ready: () => true,
    // Admitted to the conversation's inbox, and not yet delivered or dropped: on its way
    admitted: (s, clicks) => [...inbox.values()].some((m) => m.into === s.into && clicks.every((c) => carries(m.text, c))),
    async submit(s, text) {
      try {
        // Steered: taken at the conversation's next step when a turn is running, and starting a turn when none is
        const got = await ctx.session.prompt({ sessionID: s.into, text, delivery: 'steer' })
        if (typeof got?.id === 'string' && got.id) {
          if (delivered.delete(got.id)) b.shown(s.into, text)
          else if (!inbox.has(got.id)) note(inbox, got.id, { into: s.into, text })
        }
        return 'took'
      } catch (err) {
        return err?._tag === 'Session.NotFoundError' ? 'gone' : 'no'
      }
    },
  })

  /** A message has reached this conversation: it is listened for from now on, and a subagent's own conversation for the conversation that started it. */
  async function heard(id) {
    try {
      if (typeof id !== 'string' || !id) return
      const root = await rootOf(id)
      if (!root) return // whose conversation this is cannot be told, so nothing is learned from it
      const fresh = !b.sessions.has(root) || !b.sessions.has(id)
      b.listen(root)
      if (root !== id) b.listen(id, root)
      // A conversation heard of for the first time is asked about at once, and not a second later
      if (fresh) void b.round()
    } catch {}
  }

  const registrations = []
  const stop = new AbortController()
  // Every message on the person's side of a conversation passes here, whoever sent it. Not
  // waited on, so that OpenCode's taking of the message is held up by nothing here.
  registrations.push(await ctx.session.hook('prompt', (input) => void heard(input?.sessionID)))
  // Said last among the agent's instructions, once, each time OpenCode puts them together
  registrations.push(
    await ctx.session.hook('context', (input) => {
      if (Array.isArray(input?.system) && !input.system.some((part) => part?.text === WHEN)) input.system.push({ type: 'text', text: WHEN })
    }),
  )
  // Every command the agent runs is told where the `it` command is. Which conversation it is in,
  // OpenCode says itself; a pair of It's own that the command would otherwise inherit from
  // whatever started OpenCode would name another app's conversation, and is taken away.
  registrations.push(
    await ctx.shell.hook('create.before', (input) => {
      if (!input?.env) return
      delete input.env.IT_HARNESS
      delete input.env.IT_SESSION
      withIt(input.env)
    }),
  )
  // Four things OpenCode announces matter: a message being admitted to a conversation, being
  // delivered into it or dropped, and a conversation being deleted.
  ;(async () => {
    const types = ['session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.deleted']
    for await (const event of ctx.event.subscribe({ types, signal: stop.signal })) {
      try {
        const about = event?.data
        if (event.type === 'session.inbox.enqueued') {
          const item = about?.item
          if (item?.type === 'user' && typeof about.inboxID === 'string' && typeof item.payload?.text === 'string')
            note(inbox, about.inboxID, { into: about.sessionID, text: item.payload.text })
        } else if (event.type === 'session.inbox.delivered') {
          const was = inbox.get(about?.inboxID)
          if (was) {
            inbox.delete(about.inboxID)
            b.shown(was.into, was.text)
          } else if (typeof about?.inboxID === 'string') note(delivered, about.inboxID)
        } else if (event.type === 'session.inbox.cancelled') {
          const was = inbox.get(about?.inboxID)
          inbox.delete(about?.inboxID)
          if (was) b.dropped(was.into, was.text)
        } else if (event.type === 'session.deleted') {
          b.gone(about?.sessionID)
        }
      } catch {}
    }
  })().catch(() => {})

  return async () => {
    stop.abort()
    b.dispose()
    for (const r of registrations) {
      try {
        await r?.dispose?.()
      } catch {}
    }
  }
}

export default { id: 'it-bridge', server, setup }
