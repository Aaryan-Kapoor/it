// What `it upgrade` does once the new program is in place, with a stand-in for that program.
import { describe, expect, test } from 'vitest'
import type { AddonOutcome } from './src/setup'
import { addonsSaid, afterUpgrade, outcomesIn, type Runner } from './src/upgraded'

const LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' }
const label = (id: string) => LABELS[id]!

/** A stand-in for the new program, which answers each run as it is told and keeps what it was run with. */
function program(answer: (args: string[]) => { ok?: boolean; said?: unknown; failed?: string }) {
  const runs: { args: string[]; env: NodeJS.ProcessEnv }[] = []
  const run: Runner = async (_program, args, env) => {
    runs.push({ args, env })
    const a = answer(args)
    return { ok: a.ok ?? true, said: typeof a.said === 'string' ? a.said : JSON.stringify(a.said ?? {}), failed: a.failed ?? '' }
  }
  return { run, runs }
}
const updated: AddonOutcome[] = [
  { id: 'claude-code', did: 'installed', restart: true },
  { id: 'pi', did: 'installed' },
]

describe('once the new program is in place, it upgrade', () => {
  test('where the system starts It, has the new program set It up, which starts It again and brings up the add-ons, and names what that said of them', async () => {
    const p = program(() => ({ said: { harnesses: [], addons: updated } }))
    const again = { IT_HOME: '/the-folder', FROM_THE_SERVICE: '1' }
    const done = await afterUpgrade('/the/new/it', { service: true, againWith: again, env: {}, running: async () => true, run: p.run })
    expect(p.runs).toEqual([{ args: ['setup'], env: again }])
    expect(done).toEqual({ started: 'again', addons: updated })
    expect(addonsSaid(done, label)).toEqual([
      'Restart Claude Code to load its new add-on. Until then, one that is already running goes on with the add-on it loaded, which still takes clicks.',
    ])
  })

  test('says an add-on that could not be brought up to date, with why, and that the app keeps the one it had', async () => {
    const p = program(() => ({ said: { addons: [{ id: 'codex', did: 'failed', detail: 'Codex would not add the plugin.' }, ...updated] } }))
    const done = await afterUpgrade('/the/new/it', { service: true, againWith: {}, env: {}, running: async () => false, run: p.run })
    expect(addonsSaid(done, label)).toEqual([
      "Codex's add-on could not be brought up to date: Codex would not add the plugin. Codex keeps the add-on it had, which still takes clicks, and It tries again each time it starts and every half hour.",
      'Restart Claude Code to load its new add-on. Until then, one that is already running goes on with the add-on it loaded, which still takes clicks.',
    ])
  })

  test('where setup fails, says why as setup said it, and what it said of the add-ons it got to', async () => {
    const p = program(() => ({ ok: false, said: { problem: 'It could not be registered.', addons: [{ id: 'pi', did: 'installed', restart: true }] } }))
    const done = await afterUpgrade('/the/new/it', { service: true, againWith: {}, env: {}, running: async () => false, run: p.run })
    expect(done).toEqual({ started: 'failed', why: 'It could not be registered.', addons: [{ id: 'pi', did: 'installed', restart: true }] })
  })

  test('where nothing starts It and nothing of It is running, has the new program bring up the add-ons this folder put in, and nothing else', async () => {
    const p = program(() => ({ said: { addons: updated } }))
    const env = { IT_HOME: '/the-folder' }
    const done = await afterUpgrade('/the/new/it', { service: false, againWith: {}, env, running: async () => false, run: p.run })
    expect(p.runs).toEqual([{ args: ['setup', '--refresh'], env }])
    expect(done).toEqual({ started: 'by hand', running: false, addons: updated })
  })

  test('where an It started by hand is running, leaves the add-ons for it to bring up once it is started again as the new version', async () => {
    const p = program(() => ({}))
    const done = await afterUpgrade('/the/new/it', { service: false, againWith: {}, env: {}, running: async () => true, run: p.run })
    // The older It that is running would stop to make way for a newer It's add-on, and nothing would start It again
    expect(p.runs).toEqual([])
    expect(done).toEqual({ started: 'by hand', running: true, addonsLater: true })
    expect(addonsSaid(done, label)).toEqual(['Its add-ons in your agent apps are brought up to date when It starts as the new version.'])
  })

  test('where the new program could bring up only some add-ons, and so ends as a failure, says which failed and which apps to restart', async () => {
    const said = { addons: [{ id: 'codex', did: 'failed', detail: 'Codex would not add the plugin.' }, ...updated] }
    const p = program(() => ({ ok: false, said }))
    const done = await afterUpgrade('/the/new/it', { service: false, againWith: {}, env: {}, running: async () => false, run: p.run })
    expect(done).toEqual({ started: 'by hand', running: false, addons: said.addons })
    expect(addonsSaid(done, label)).toHaveLength(2)
  })

  test('where the new program cannot bring up the add-ons, says that It does so when it starts', async () => {
    const p = program(() => ({ ok: false, failed: 'not a switch it knows' }))
    const done = await afterUpgrade('/the/new/it', { service: false, againWith: {}, env: {}, running: async () => false, run: p.run })
    expect(done).toEqual({ started: 'by hand', running: false, addonsLater: true })
  })

  test('reads only what is an add-on outcome from what setup printed, and nothing from what is no JSON', () => {
    expect(outcomesIn('not JSON')).toBeUndefined()
    expect(outcomesIn('{"harnesses":[]}')).toBeUndefined()
    expect(
      outcomesIn(
        JSON.stringify({
          addons: [
            { id: 'pi', did: 'installed' },
            null,
            { id: 'codex', did: 'something else' },
            { id: 7, did: 'failed' },
            { id: 'codex', did: 'failed', detail: 3 },
          ],
        }),
      ),
    ).toEqual([{ id: 'pi', did: 'installed' }])
  })

  test('names several apps to restart in one sentence', () => {
    const addons: AddonOutcome[] = ['claude-code', 'codex', 'pi'].map((id) => ({ id: id as AddonOutcome['id'], did: 'installed', restart: true }))
    expect(addonsSaid({ started: 'again', addons }, label)).toEqual([
      'Restart Claude Code, Codex and Pi to load their new add-ons. Until then, one that is already running goes on with the add-on it loaded, which still takes clicks.',
    ])
  })
})
