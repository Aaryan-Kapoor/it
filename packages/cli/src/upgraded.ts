// What `it upgrade` does once the new program is in place, and what it then says: It is started
// again as the new version where the system starts it, and the add-ons in the agent apps are
// brought up to that version on every way there is, or left for It to bring up when it starts.
import { execFile } from 'node:child_process'
import type { Harness } from '@it/protocol'
import type { AddonOutcome } from './setup'

/** What a run of the new program gave: whether it ended well, what it printed, and what it said on its other stream. */
export interface Ran {
  ok: boolean
  said: string
  failed: string
}
/** Runs the new program with these words and this environment. */
export type Runner = (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Ran>

export const runProgram: Runner = (program, args, env) =>
  new Promise((resolve) =>
    execFile(program, args, { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) =>
      resolve({ ok: !err, said: String(stdout), failed: String(stderr) }),
    ),
  )

/**
 * What became of It and of its add-ons once the new program was in place. `started` is
 * `again` where the system starts It and it was started again as the new version, `failed`
 * where that could not be done, and `by hand` where nothing starts It by itself. `running` says,
 * for the last, whether an It started by hand is running here now. `addons` is what became of
 * each add-on that was put in, and `addonsLater` that the add-ons were left for It to bring up
 * to date when it starts as the new version.
 */
export interface AfterUpgrade {
  started: 'again' | 'by hand' | 'failed'
  running?: boolean
  why?: string
  addons?: AddonOutcome[]
  addonsLater?: true
}

/** The add-ons a setup of the new program said it put in, or tried to: none where it said nothing of them. */
export function outcomesIn(printed: string): AddonOutcome[] | undefined {
  try {
    const said = (JSON.parse(printed) as { addons?: unknown }).addons
    if (!Array.isArray(said)) return undefined
    return said.filter(
      (o): o is AddonOutcome =>
        !!o &&
        typeof o === 'object' &&
        typeof (o as AddonOutcome).id === 'string' &&
        ((o as AddonOutcome).did === 'installed' || (o as AddonOutcome).did === 'failed') &&
        ((o as AddonOutcome).detail === undefined || typeof (o as AddonOutcome).detail === 'string'),
    )
  } catch {
    return undefined
  }
}

/**
 * Where the system starts It by itself, the new program's setup writes the service's definition
 * as its version has it, starts It again, and brings every add-on that is wanted up to it.
 * Where nothing starts It by itself and nothing of It is running, the new program brings up to
 * date the add-ons this folder put into the apps, so that an app started before It is loads the
 * build that will run. Where an It started by hand is running, the add-ons are left as they are:
 * that It is the older version, and on finding a newer It's add-on in an app it would stop to
 * make way for the newer It, which nothing would then start. They are brought up to date when It
 * is started again, as the new version, which the person is told to do.
 */
export async function afterUpgrade(
  program: string,
  how: { service: boolean; againWith: NodeJS.ProcessEnv; env: NodeJS.ProcessEnv; running: () => Promise<boolean>; run?: Runner },
): Promise<AfterUpgrade> {
  const run = how.run ?? runProgram
  if (how.service) {
    const ran = await run(program, ['setup'], how.againWith)
    let why: string | undefined
    if (!ran.ok) {
      // Why, as setup said it: in what it printed, or in the problem it ended with
      try {
        why = (JSON.parse(ran.said) as { problem?: string }).problem
      } catch {}
      if (!why)
        for (const line of ran.failed.split('\n').reverse())
          try {
            why = (JSON.parse(line) as { error?: { message?: string } }).error?.message
            if (why) break
          } catch {}
    }
    const addons = outcomesIn(ran.said)
    return { started: ran.ok ? 'again' : 'failed', ...(why ? { why } : {}), ...(addons ? { addons } : {}) }
  }
  if (await how.running()) return { started: 'by hand', running: true, addonsLater: true }
  // Read whether or not it ended well: it ends as a failure where an add-on could not be brought
  // up to date, and says which, beside the others it did bring up. Where it said nothing of
  // them, as a program that does not know the switch does not, It brings them up as it starts
  const ran = await run(program, ['setup', '--refresh'], how.env)
  const addons = outcomesIn(ran.said)
  return { started: 'by hand', running: false, ...(addons ? { addons } : { addonsLater: true }) }
}

/** The apps named as a person reads them: "Claude Code", "Claude Code and Codex", "Pi, OpenCode and Codex". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''))

/** The one sentence that names the apps to restart, by their names, where there are any. */
export const restartLine = (names: string[]): string | null =>
  names.length
    ? `Restart ${listed(names)} to load ${names.length === 1 ? 'its new add-on' : 'their new add-ons'}. Until then, one that is already running goes on with the add-on it loaded, which still takes clicks.`
    : null

/**
 * What a person is told to do in every Claude Code conversation that was already open, once
 * It's add-on there is a new one: Claude Code loads an add-on as a conversation starts, and
 * one that was open goes on with what it loaded, which may be nothing at all. An It whose
 * add-on Claude Code did not load, as 0.1.36's in a Claude Code of now, left every such
 * conversation without one, and nothing done on their pages reaches them until this is done.
 */
export const RELOAD_OPEN =
  'Type /reload-plugins in any Claude Code conversation that was already open, so that it loads It’s new add-on: until then, what is done on its pages may not reach it.'

/**
 * What a person is told of the add-ons once It is upgraded: which could not be brought up to
 * date, which apps to restart, and, where Claude Code has It's add-on (`claude`), what to type
 * in its conversations that were open.
 */
export function addonsSaid(done: AfterUpgrade, label: (id: Harness) => string, claude = false): string[] {
  const lines: string[] = []
  for (const o of done.addons ?? [])
    if (o.did === 'failed') {
      const app = label(o.id)
      lines.push(
        `${app}'s add-on could not be brought up to date${o.detail ? `: ${o.detail.replace(/\.$/, '')}` : ''}. ${app} keeps the add-on it had, which still takes clicks, and It tries again each time it starts and every half hour.`,
      )
    }
  // Claude Code is said apart, below: a conversation of its loads the new add-on without a restart
  const restart = restartLine((done.addons ?? []).filter((o) => o.did === 'installed' && o.restart && o.id !== 'claude-code').map((o) => label(o.id)))
  if (restart) lines.push(restart)
  if (done.addonsLater) lines.push('Its add-ons in your agent apps are brought up to date when It starts as the new version.')
  if (claude) lines.push(done.addonsLater ? `Once it has, ${RELOAD_OPEN.charAt(0).toLowerCase()}${RELOAD_OPEN.slice(1)}` : RELOAD_OPEN)
  return lines
}
