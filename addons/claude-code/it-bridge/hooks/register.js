// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
// The terms are in LICENSE.md beside this add-on.
//
// The It add-on for Claude Code. It runs inside the session and brings the user's clicks on
// pages this session made into the conversation:
//   - session idle  -> a turn starts with the click
//   - turn running  -> the click is attached to the next tool result (nothing is interrupted),
//                      or starts a turn when this one ends if no tool ran
//
// A click that starts a turn is shown in the conversation as one short line, as the person's
// own message, since it was the person who acted: which page, what was done, and the id by
// which Claude reads the rest with `it action`. Nothing the page sent is put into those words.
//
// It asks the connector on this machine once a second and never holds a request open: in
// Claude Code 2.1.287, a call left open when a turn ends delays the host's next message until
// it returns. Ownership, retries and receipts live in the connector.
const HARNESS = 'claude-code'
// Where It's folder was when this add-on was set up, if not the usual place. Filled in by `it setup`.
const IT_HOME_AT_SETUP = null
let connector = null // { socket | port, token }, read from the connector's own file
let lookedAt = 0
let running = false // a turn is in progress
let session = null // this conversation's id, which /clear changes
const pending = [] // clicks taken from the connector, not yet handed to Claude
const given = new Set() // clicks Claude already has, which must never be handed over a second time

/**
 * The person's own folder, found as the `it` command finds it, so that both look for It's folder
 * in the same place. On Windows that is USERPROFILE, whatever a shell has put in HOME, and
 * anywhere else it is HOME. A variable that is set and empty names no folder.
 */
async function ownFolder($) {
  // Each name is written out where it is asked for: Claude Code loads a module only if every
  // variable it reads is named plainly, and refuses the whole module otherwise
  const home = await $.env.get('HOME')
  const profile = await $.env.get('USERPROFILE')
  return ((await $.env.get('OS')) === 'Windows_NT' ? profile || home : home || profile) || ''
}

/** It's folder: the environment's word first, then what setup wrote down, then the usual place. */
async function itFolder($) {
  return (await $.env.get('IT_HOME')) || (typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP ? IT_HOME_AT_SETUP : `${await ownFolder($)}/.it`)
}

async function find($) {
  if (Date.now() - lookedAt < (connector ? 30000 : 3000)) return connector
  lookedAt = Date.now()
  const home = await itFolder($)
  connector = null
  try {
    const c = JSON.parse(await $.fs.read(`${home}/connector.json`))
    // Only a token and a port number are taken from the file. The socket is always the one in
    // that same folder, whatever the file says, so nothing in it can point anywhere else.
    const socket = typeof c.socket === 'string' && c.socket ? `${home}/connector.sock` : null
    const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null
    if (typeof c.token === 'string' && /^[0-9a-f]{16,128}$/.test(c.token) && (socket || port)) connector = { socket, port, token: c.token }
  } catch {}
  return connector
}

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
/**
 * The code that proves a message came from someone who knows the token, without the token being
 * sent: HMAC with SHA-256, as the connector makes it. Claude Code gives a module one way of
 * hashing and no way of making a keyed code, so the keyed code is put together here from that
 * hashing, as it is defined: the key fills one block of 64 bytes (hashed first when it is
 * longer), and the message is hashed with that block inside and then outside.
 */
async function seal(token, nonce, what) {
  const enc = new TextEncoder()
  const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const key = enc.encode(token)
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? await sha(key) : key)
  const keyed = (pad, rest) => {
    const all = new Uint8Array(64 + rest.length)
    all.set(block.map((b) => b ^ pad))
    all.set(rest, 64)
    return sha(all)
  }
  return hex(await keyed(0x5c, await keyed(0x36, enc.encode(`${nonce}\n${what}`))))
}

/**
 * Gives up on a call that takes too long, so that nothing here is left open when a turn ends.
 * Timed with Claude Code's own clock: a mod has no timers of its own (no `setTimeout`).
 */
function within($, ms, promise) {
  return new Promise((resolve) => {
    let over = false
    let timer
    const finish = (value) => {
      if (over) return
      over = true
      try {
        timer?.cancel?.()
      } catch {}
      resolve(value)
    }
    try {
      timer = $.clock.after(ms, () => finish(null))
    } catch {
      // No such clock: the call is simply waited for
    }
    promise.then(finish, () => finish(null))
  })
}

const ask = ($, path, body) => within($, 3000, asking($, path, body))
async function asking($, path, body) {
  const c = await find($)
  if (!c) return null
  try {
    const method = body ? 'POST' : 'GET'
    const text = body ? JSON.stringify(body) : undefined
    // Over the socket, which only this user can open, the token is shown. Over a port it never
    // is: the request and the answer are each sealed with it, so a program that took the
    // connector's port after a crash learns nothing, and nothing it answers is believed.
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
    const proof = c.socket ? { 'x-it-token': c.token } : { 'x-it-nonce': nonce, 'x-it-mac': await seal(c.token, nonce, `${method}\n${path}\n${text ?? ''}`) }
    const r = await $.http.fetch(c.socket ? `http://it${path}` : `http://127.0.0.1:${c.port}${path}`, {
      method,
      headers: { ...proof, 'content-type': 'application/json' },
      body: text,
      ...(c.socket ? { socketPath: c.socket } : {}),
    })
    if (r.status === 401) lookedAt = 0 // the connector restarted: read its file again
    // The connector's largest honest answer is well under this
    if (!r.ok || !r.text || r.text.length > 262_144) return null
    if (!c.socket) {
      const headers = r.headers ?? {}
      const given = typeof headers.get === 'function' ? headers.get('x-it-mac') : headers['x-it-mac']
      if (given !== (await seal(c.token, nonce, `${r.status}\n${r.text}`))) return null
    }
    return JSON.parse(r.text)
  } catch {
    lookedAt = 0
  }
  return null
}

// One wording, made by the connector, which names each click so a repeat can be told apart
const textOf = (clicks) => clicks.map((c) => c.text).join('\n')
// The few words that stand in the conversation for each click, where the connector gives them.
// A connector from before it gave them gives the whole wording, and that is what is shown.
const briefOf = (clicks) => clicks.map((c) => (typeof c.brief === 'string' && c.brief ? c.brief : c.text)).join('\n')

/**
 * Told to the connector, and told again on a later check if that fails. `woke` says whether the
 * click started a turn (true) or joined one that was running (false); it is left out when that
 * is not known, as when an earlier report is repeated.
 */
const report = ($, ids, woke) => void ask($, '/ack', woke === undefined ? { ids } : { ids, woke })

// Being submitted this moment. Neither new (so not submitted a second time) nor yet Claude's
// (so not reported): a prompt can still be refused, by one of the person's own hooks say.
const submitting = new Set()
// A prompt that was refused is tried again less and less often, so that the person's hooks are
// not run once a second for as long as they go on refusing
const WAITS = [1000, 5000, 30_000, 120_000, 600_000]
let refusals = 0
let refusedAt = 0

function handOver($) {
  if (!pending.length || submitting.size) return
  if (refusals && Date.now() - refusedAt < WAITS[Math.min(refusals, WAITS.length) - 1]) return
  const clicks = pending.splice(0)
  for (const c of clicks) submitting.add(c.id)
  const began = generation
  const refused = () => {
    for (const c of clicks) submitting.delete(c.id)
    // Only for the conversation they were taken for. If another has taken its place since,
    // they are not this one's to hand over, and its refusal says nothing about how soon the
    // new conversation may be tried.
    if (began !== generation) return
    refusals += 1
    refusedAt = Date.now()
    pending.unshift(...clicks)
  }
  // As the person's own message, in a few words. Claude Code shows a prompt submitted that way
  // as it is; one submitted any other way it wraps in several lines of its own, each time.
  $.prompt.submit({ text: briefOf(clicks), asUser: true }).then(
    (result) => {
      // A prompt that another hook refused never reached Claude, so it is not reported as given
      if (result && result.drop !== undefined) return refused()
      if (began === generation) refusals = 0
      for (const c of clicks) {
        submitting.delete(c.id)
        given.add(c.id)
      }
      if (given.size > 2000) for (const id of [...given].slice(0, 1000)) given.delete(id)
      report(
        $,
        clicks.map((c) => c.id),
        true,
      )
    },
    (err) => refused(err),
  )
}

// One check at a time: a slow answer must not let them pile up, one more every second
let checking = false
async function check($) {
  if (checking) return
  checking = true
  try {
    await checkOnce($)
  } finally {
    checking = false
  }
}

async function checkOnce($) {
  const began = generation
  const id = await $.session.id()
  // The same conversation after /clear carries on under a new id, and pages made under the old
  // id follow it there
  const carriedOn = cleared !== null && id !== cleared
  if (carriedOn) {
    moves.push({ was: cleared, now: id })
    cleared = null
  }
  if (id !== session) {
    // Commands run from here on say which conversation they belong to
    await $.env.set('IT_HARNESS', HARNESS)
    await $.env.set('IT_SESSION', id)
    // And where It's folder is, when it is not the usual place: the `it` command they run must
    // use the same one as this add-on
    if (typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP && !(await $.env.get('IT_HOME'))) await $.env.set('IT_HOME', IT_HOME_AT_SETUP)
    // And where the `it` command is. A Claude Code started from the terminal It was installed
    // in has a PATH from before It was on it, and the agent's first `it` is not found. Put
    // last, so that an `it` the person has put on their PATH themselves comes first.
    try {
      const windows = (await $.env.get('OS')) === 'Windows_NT'
      const bin = `${await itFolder($)}${windows ? '\\' : '/'}bin`
      const now = (await $.env.get('PATH')) || ''
      if (now && !now.split(windows ? ';' : ':').includes(bin)) await $.env.set('PATH', `${now}${windows ? ';' : ':'}${bin}`)
    } catch {}
    // Anything but /clear that changes the id (the person resumed another conversation in this
    // window) is a different conversation: the first one keeps its pages, and what was taken
    // for it is not handed to this one.
    if (!carriedOn) pending.length = 0
    session = id
  }
  // The connector is told of each change of id, in the order they happened. Nothing is asked
  // for under the new id until it has taken them all: it would not yet know that the pages
  // made under the old ids are this conversation's.
  while (moves.length) {
    const move = moves[0]
    if (!(await ask($, '/session', { harness: HARNESS, session: move.now, was: move.was }))) return
    if (moves[0] === move) moves.shift()
  }
  const got = await ask($, `/clicks?harness=${HARNESS}&session=${encodeURIComponent(id)}`)
  if (!got || !Array.isArray(got.clicks)) return
  // A click is its id and the words for it. One without either is not handed over: Claude Code
  // takes no empty message, and no empty note beside what a tool gave back.
  got.clicks = got.clicks.filter((c) => c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text)
  // The conversation ended while the connector was answering, and another may be here now:
  // what was asked for the first is not handed to the second
  const now = await $.session.id()
  if (now !== id || began !== generation) return
  // What the connector no longer offers is no longer this add-on's to give: its lease may have
  // run out and something else may have delivered it
  const offered = new Set(got.clicks.map((c) => c.id))
  for (let i = pending.length - 1; i >= 0; i--) if (!offered.has(pending[i].id)) pending.splice(i, 1)
  const again = got.clicks.filter((c) => given.has(c.id))
  // Offered something Claude already has: the earlier report of it was lost, so it is sent again
  if (again.length)
    report(
      $,
      again.map((c) => c.id),
    )
  for (const c of got.clicks) if (!given.has(c.id) && !submitting.has(c.id) && !pending.some((p) => p.id === c.id)) pending.push(c)
  if (!running) handOver($)
}

// The id of a conversation that Claude Code said was ended by /clear, until the id it carries
// on under is known
let cleared = null
// Every change of id that /clear made, as { was, now }, in the order they happened. Each stays
// here until the connector has taken it, so that none is lost while the connector cannot be
// reached, or when the conversation is cleared again before the connector was told of the last time.
const moves = []
// Goes up each time a conversation ends, so that an answer that was asked for before can be told from one asked for since
let generation = 0
let ticking = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    running = false
    // One timer, however often a session starts in this process
    if (!ticking) {
      ticking = true
      $.clock.every(1000, () => check($).catch(() => {}))
    }
    return next(e)
  })
  on('session.end', async (_$, e, next) => {
    const id = e?.sessionId ?? e?.session_id
    const ending = typeof id === 'string' && id ? id : null
    // A conversation that was cleared, and ends again before the connector was next asked: the
    // id it ends under is the one it carried on under
    if (cleared !== null && ending !== null && ending !== cleared) moves.push({ was: cleared, now: ending })
    // How it ended, as Claude Code said: "clear" for /clear
    cleared = e?.reason === 'clear' ? ending : null
    // Whatever is being asked or handed over was for the conversation that has just ended.
    // After a clear it goes on as the same conversation and keeps what was taken for it;
    // after anything else, what was taken is dropped.
    generation += 1
    if (e?.reason !== 'clear') {
      pending.length = 0
      submitting.clear()
      // Another conversation starts with a clean slate: how often the last one refused is its own affair
      refusals = 0
      refusedAt = 0
    }
    return next(e)
  })
  // Only the conversation's own turns say whether it is working. A subagent has turns of its
  // own inside one of them: when a helper finishes, the conversation is still in its turn, and
  // a click handed over then would start a turn of its own instead of joining this one.
  on('turn.start', async (_$, e, next) => {
    if (e?.agentId === undefined) running = true
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e?.agentId === undefined) {
        running = false
        handOver($)
      }
    }
  })
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Only the main conversation is given a click. A tool call made by a subagent belongs to
    // the subagent, which knows nothing of the page; the click waits for the conversation itself.
    if (e.agentId !== undefined || !pending.length || result.deny) return result
    const clicks = pending.splice(0)
    for (const c of clicks) given.add(c.id)
    report(
      $,
      clicks.map((c) => c.id),
      false,
    )
    return { ...result, context: [...(result.context ?? []), textOf(clicks)] }
  })
}
