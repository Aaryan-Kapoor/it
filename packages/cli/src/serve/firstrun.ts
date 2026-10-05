// What `it setup` does on the machine It runs on before it looks at the agent apps. On a first
// run that is everything It needs to exist here: its settings are made, its service is started,
// and this machine is enrolled as the first of the person's machines. On a later run each of
// those is found done, and is put right where it is not.
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import { exportJWK, generateKeyPair } from 'jose'
import { backendAt, direct, inHome, keepMachine, type Machine, machineFile, Problem, readJson } from '../lib'
import { keepPending, pendingFor, settleKept, settlePending } from '../login'
import * as service from '../service'
import { alone, asAdmin, program, startBackend } from './backend'
import { makeConfig, programFile, readConfig, type ServiceConfig, unread } from './config'

export interface Begun {
  config: ServiceConfig
  /** The background service as the system has it, when one was asked for and could be registered. */
  background?: service.ServiceStatus
  /** Why It does not run in the background, when it was meant to. */
  trouble?: string
  /** Whether this machine was enrolled just now. */
  enrolled: boolean
  /** Whether the backend is run from here, only for as long as setup takes. */
  own: boolean
  /** Ends what was started only for as long as setup takes. */
  done(): Promise<void>
}

/** Whether It's backend answers on this machine with its functions loaded, asked for as long as given. */
async function backendAnswers(config: ServiceConfig, forMs: number): Promise<boolean> {
  const until = Date.now() + forMs
  for (;;) {
    const ok = await direct(`${backendAt(config.port).site}/health`, { signal: AbortSignal.timeout(2000) }).then(
      (answer) => answer.ok,
      () => false,
    )
    if (ok) return true
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Enrols this machine. The key is made here and its private half never leaves this machine.
 * The backend is asked as its administrator, which only this machine can be: the key for that
 * is in It's settings. `replaces` names the identity this machine had before, so that the
 * pages its conversations made come along to the new one.
 *
 * The key is kept before the backend is asked. Should the answer be lost on its way back, or
 * setup be ended before it has kept it, the next setup asks with the same key, and the backend
 * answers with the machine it made for that key the first time. So no machine is ever made
 * that nobody holds the key of. A key kept for joining an It on another machine is not one for
 * enrolling here, and is left where it is.
 */
async function enrol(config: ServiceConfig, name: string, replaces?: string): Promise<Machine> {
  let pending = pendingFor(undefined, replaces)
  if (!pending) {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    pending = { name, key: await exportJWK(privateKey), ...(replaces ? { replaces } : {}) }
    keepPending(pending)
  }
  const { kty, crv, x, y } = pending.key
  const made = (await asAdmin({ api: backendAt(config.port).api, adminKey: config.adminKey }, 'bridge:enroll', {
    subject: 'owner',
    name: pending.name,
    publicKey: { kty, crv, x, y },
    ...(replaces ? { replaces } : {}),
  })) as { machineId?: unknown; error?: unknown } | null
  if (typeof made?.machineId !== 'string')
    throw made?.error === 'limit'
      ? new Problem('It has as many machines as it can have.', 'limit', 'Revoke one on the site, then run `it setup` again.')
      : new Problem('This machine could not be enrolled.', 'error')
  const machine: Machine = { id: made.machineId, name: pending.name, key: pending.key }
  keepMachine(machine)
  settlePending(undefined, replaces)
  // A token kept for the identity this machine had is of no more use
  rmSync(inHome('token.json'), { force: true })
  return machine
}

/** Whether the backend still takes this machine for one of the person's. Taken for yes where it cannot be asked. */
async function known(config: ServiceConfig, machine: Machine): Promise<boolean> {
  const found = (await asAdmin({ api: backendAt(config.port).api, adminKey: config.adminKey }, 'bridge:machine', { id: machine.id }).catch(() => undefined)) as
    | { revoked?: unknown }
    | null
    | undefined
  return found === undefined || (found !== null && found.revoked !== true)
}

/**
 * Makes It exist on this machine, as far as it does not yet. With `background`, It is
 * registered as a background service and started there. Without, or where that could not be
 * done, and when nothing is running It already, the backend is run from here for as long as
 * setup takes, so that setup can finish; `done` stops it again.
 */
export async function begin(opts: {
  say: (line: string) => void
  background: boolean
  name?: string
  /** Told how far the fetching of the backend program has got, where it is fetched. */
  progress?: (got: number, of: number | undefined) => void
  /** Told as each part of the first run is begun: `program`, `service`, `machine`. */
  stage?: (stage: 'program' | 'service' | 'machine', how?: 'fetching') => void
}): Promise<Begun> {
  const { say } = opts
  // The program comes first: the settings hold a key that only it can make
  const fetching = !process.env.IT_BACKEND_BIN && !existsSync(programFile())
  opts.stage?.('program', fetching ? 'fetching' : undefined)
  if (fetching)
    say(
      `Fetching the backend program that It runs on this machine, from ${process.env.IT_BACKEND_RELEASES ? 'the place IT_BACKEND_RELEASES names' : 'its release on GitHub'}. It is about 60 MB. It is fetched the first time It is set up, and again when a newer It runs a newer one.`,
    )
  await program(() => {}, undefined, opts.progress)
  const config = readConfig() ?? makeConfig()
  opts.stage?.('service')
  const begun: Begun = { config, enrolled: false, own: false, done: async () => {} }
  if (opts.background) {
    try {
      begun.background = service.install()
    } catch (err) {
      begun.trouble = `It could not be registered as a background service: ${(err as Error).message}`
    }
    // Registered is not yet running: the backend is asked, and given a while to answer
    if (!begun.trouble && !(await backendAnswers(config, 90_000)))
      begun.trouble = 'It was registered as a background service, but it is not answering. Run `it service logs` to read why.'
  }
  if (!(await backendAnswers(config, 0))) {
    try {
      const own = await startBackend(config, () => {})
      begun.own = true
      begun.done = () => own.stop()
    } catch (err) {
      // Another has the folder: the service, or a setup begun in the same moment. Its backend is the one to wait for.
      if (!(err instanceof Problem && err.code === 'already_running') || !(await backendAnswers(config, 90_000))) throw err
    }
  }
  try {
    opts.stage?.('machine')
    // One enrolment at a time for a folder. Whether this machine is enrolled is looked at only
    // once the folder is this setup's alone: another may have enrolled it a moment ago.
    await alone('enrol', async () => {
      const machine = readJson<Machine>(machineFile())
      // An identity that is there and cannot be read is not taken for none: the file holds the
      // key this machine is known by, and enrolling anew would write another over it
      if (existsSync(machineFile()) && (typeof machine?.id !== 'string' || typeof machine.key?.d !== 'string'))
        throw unread(
          `This machine’s identity, in ${machineFile()}, is not as It wrote it.`,
          'It holds the key this machine is known by, so It does not enrol the machine anew over it. Put the file back as it was, or move it away to have this machine enrolled again.',
        )
      if (!machine) {
        const made = await enrol(config, opts.name ?? os.hostname())
        say(`This machine is enrolled as "${made.name}".`)
        begun.enrolled = true
      } else if (!(await known(config, machine))) {
        await enrol(config, opts.name ?? machine.name, machine.id)
        say('It had stopped knowing this machine, so it was enrolled again.')
        begun.enrolled = true
      } else {
        // A key that was waiting for an answer this machine has since kept is of no more use.
        // Any other that is kept is waiting still, and stays. Nothing here needs a key, so keys
        // that cannot be read are left as they are and keep nothing from going on.
        try {
          settleKept(machine.key)
        } catch {}
      }
    })
  } catch (err) {
    await begun.done()
    throw err
  }
  return begun
}
