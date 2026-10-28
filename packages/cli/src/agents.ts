// Project agents, an experiment, as this machine keeps them: whether someone at this machine has
// turned them on, which folders they named for an agent to be started in, and how many may run
// here at once. `it agents` changes it, and the connector reads it and tells It what the machine
// offers. Nothing is offered until it is turned on here: the site cannot turn it on, and cannot
// name a folder, since an agent started in a folder can do there whatever its app lets it.
import { randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, wakesOn } from '@it/protocol'
import { inHome, Problem, readJson, writePrivate } from './lib'

export const agentsFile = () => inHome('agents.json')

/** One folder an agent may be started in: It's own word for it, which is all the site is told to name it by, and where it is. */
export interface Project {
  id: string
  path: string
}
export interface AgentSettings {
  on: boolean
  most: number
  projects: Project[]
}
const OFF: AgentSettings = { on: false, most: AGENTS.most, projects: [] }

/**
 * What is kept, or `unread` where the file is there and is not as It wrote it. A file that cannot
 * be read turns nothing on: the machine offers nothing until it is written again.
 */
export function readAgents(file = agentsFile()): AgentSettings | 'unread' {
  try {
    statSync(file)
  } catch {
    return OFF
  }
  const kept = readJson<unknown>(file)
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return 'unread'
  const k = kept as { on?: unknown; most?: unknown; projects?: unknown }
  if (typeof k.on !== 'boolean' || !Array.isArray(k.projects) || (k.most !== undefined && !Number.isInteger(k.most))) return 'unread'
  const projects: Project[] = []
  for (const p of k.projects as unknown[]) {
    const q = p as Partial<Project> | null
    if (!q || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.id) || typeof q.path !== 'string' || !path.isAbsolute(q.path)) return 'unread'
    projects.push({ id: q.id, path: q.path })
  }
  return { on: k.on, most: clampMost((k.most as number | undefined) ?? AGENTS.most), projects }
}

const clampMost = (n: number) => Math.max(1, Math.min(AGENTS.mostAllowed, Math.floor(n)))

/** A folder as it is offered to the site: its name, and where it is with the person's home folder written as `~`. */
export function shownAs(folder: string, homeDir = os.homedir()): { name: string; where: string } {
  const inside = path.relative(homeDir, folder)
  const where = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? `~${path.sep}${inside}` : inside === '' ? '~' : folder
  return { name: path.basename(folder) || folder, where }
}

/** What the machine offers It, from what is kept: nothing where it is off or cannot be read. */
export function offerOf(kept: AgentSettings | 'unread', homeDir = os.homedir()) {
  if (kept === 'unread' || !kept.on) return null
  return { most: kept.most, projects: kept.projects.map((p) => ({ id: p.id, ...shownAs(p.path, homeDir) })) }
}

/** The folder a project names, where it is still offered and still a folder. */
export function folderOf(kept: AgentSettings | 'unread', id: string): string | null {
  if (kept === 'unread' || !kept.on) return null
  const p = kept.projects.find((x) => x.id === id)
  if (!p) return null
  try {
    return statSync(p.path).isDirectory() ? p.path : null
  } catch {
    return null
  }
}

const unreadProblem = () =>
  new Problem(
    'It could not read its own note of project agents on this machine (agents.json in It’s folder), so this machine offers none.',
    'record_unread',
    'Look at the file, or move it aside, and run `it agents on` again.',
  )

/** Whether this system is one It starts project agents on. */
const here = () => {
  if (!wakesOn(process.platform)) throw new Problem('It starts project agents only on Linux and macOS.', 'invalid')
}

/** What each change does: turned on or off, a folder added or removed, or how many may run at once. */
export function changeAgents(
  how: { to?: 'on' | 'off'; add?: string; remove?: string; most?: number },
  file = agentsFile(),
): AgentSettings & { added?: Project; removed?: Project } {
  const now = readAgents(file)
  if (now === 'unread') throw unreadProblem()
  const next: AgentSettings = { ...now, projects: [...now.projects] }
  let added: Project | undefined
  let removed: Project | undefined
  if (how.to) {
    if (how.to === 'on') here()
    next.on = how.to === 'on'
  }
  if (how.most !== undefined) {
    if (!Number.isInteger(how.most) || how.most < 1 || how.most > AGENTS.mostAllowed)
      throw new Problem(`--most is a whole number from 1 to ${AGENTS.mostAllowed}.`, 'invalid')
    next.most = how.most
  }
  if (how.add !== undefined) {
    here()
    let real: string
    try {
      real = realpathSync(path.resolve(how.add))
      if (!statSync(real).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new Problem(`There is no folder at ${how.add}.`, 'not_found')
    }
    if (real === path.parse(real).root || real === os.homedir())
      throw new Problem('An agent is started in a project’s own folder, and not in the whole of the disk or of your home folder.', 'invalid')
    added = next.projects.find((p) => p.path === real)
    if (!added) {
      if (next.projects.length >= AGENTS.projects) throw new Problem(`It offers at most ${AGENTS.projects} folders. Remove one first.`, 'limit')
      added = { id: randomBytes(9).toString('base64url'), path: real }
      next.projects.push(added)
    }
  }
  if (how.remove !== undefined) {
    let real = path.resolve(how.remove)
    try {
      real = realpathSync(real)
    } catch {}
    removed = next.projects.find((p) => p.path === real || p.path === path.resolve(how.remove!))
    if (!removed) throw new Problem(`${how.remove} is not a folder that It offers.`, 'not_found', 'Run `it agents` to see the ones it offers.')
    next.projects = next.projects.filter((p) => p !== removed)
  }
  writePrivate(file, next)
  return { ...next, ...(added ? { added } : {}), ...(removed ? { removed } : {}) }
}

/** The sentences `it agents` says to a person at a terminal. */
export function agentsSaid(kept: AgentSettings, running: boolean): string[] {
  const folders = kept.projects.map((p) => `  ${shownAs(p.path).where}`)
  if (!kept.on)
    return [
      'Project agents are off on this machine. They are an experiment: once they are on, you can start an agent from the site in a folder you name here, and It keeps it running.',
      ...(kept.projects.length ? ['The folders named for them are kept for when they are on:', ...folders] : []),
      'Turn them on with `it agents on`, and name a folder with `it agents add <folder>`.',
    ]
  return [
    `Project agents are on here, an experiment, and at most ${kept.most} run at once. From the site you can start one, with Claude Code or Codex where they are connected, in a folder named here. It runs with nobody watching: it can change files in its folder and run \`it\`, and whatever else its app’s own settings do not allow is refused.`,
    ...(kept.projects.length ? ['The folders It offers:', ...folders] : ['No folder is named yet. Name one with `it agents add <folder>`.']),
    running ? 'The site shows them under Agents.' : 'It is not running on this machine at the moment, so this takes effect when it starts.',
    '`it agents off` stops every agent running here and offers none.',
  ]
}
