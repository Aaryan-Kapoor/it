// Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
// The terms are in LICENSE.md beside this add-on.
//
// What this add-on reads and keeps in It's own folder on this machine (`~/.it`, or wherever
// IT_HOME says, or wherever it was when `it setup` put this add-on in place). Two files:
//
//   connector.json          written by the connector: how to reach it, and the word to say
//   openclaw-sessions.json  written here: which OpenClaw conversations to ask the connector about
//
// Nothing here talks to anything. Reaching the connector is the business of index.js.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Where It keeps its files, when that was somewhere other than the usual folder at the time
// `it setup` put this add-on in place. `it setup` fills it in. The IT_HOME variable comes first.
const IT_HOME_AT_SETUP = null

const home = () => process.env.IT_HOME || (typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP ? IT_HOME_AT_SETUP : path.join(os.homedir(), '.it'))
const sessionsFile = () => path.join(home(), 'openclaw-sessions.json')
/** It's folder as it was at setup, when the environment names none and it is not the usual one: what commands must be told. */
export const homeAtSetup = () => (!process.env.IT_HOME && typeof IT_HOME_AT_SETUP === 'string' && IT_HOME_AT_SETUP ? IT_HOME_AT_SETUP : null)

/** How to reach the connector, or null when it is not running or its file is not what it writes. */
export function connectorInfo() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home(), 'connector.json'), 'utf8'))
    // Only a token and a port number are taken from the file. The socket is always the one in
    // that same folder, whatever the file says, so nothing in it can point anywhere else.
    const socket = typeof c.socket === 'string' && c.socket ? path.join(home(), 'connector.sock') : null
    const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null
    if (typeof c.token === 'string' && /^[0-9a-f]{16,128}$/.test(c.token) && (socket || port)) return { socket, port, token: c.token }
  } catch {}
  return null
}

/** The conversations remembered from before OpenClaw was last restarted: [key, agent, seen]. */
export function loadSessions() {
  try {
    const saved = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'))
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return []
    return Object.entries(saved)
      .filter(([key, s]) => key && key.length <= 200 && s && typeof s.agent === 'string' && s.agent && Number.isFinite(s.seen))
      .map(([key, s]) => [key, s.agent, s.seen])
  } catch {
    return []
  }
}

/**
 * Remembers the conversations, so that a click on a page still finds its conversation after
 * OpenClaw has been restarted. The folder itself is never made here: with no It on this
 * machine, nothing is written.
 */
export function saveSessions(sessions) {
  try {
    const text = JSON.stringify(Object.fromEntries(sessions.map(([key, agent, seen]) => [key, { agent, seen }])))
    const part = `${sessionsFile()}.${process.pid}.part`
    fs.writeFileSync(part, text, { mode: 0o600 })
    fs.renameSync(part, sessionsFile())
  } catch {}
}
