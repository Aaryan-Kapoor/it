// It's service: everything that runs on the machine It runs on, as one program. It starts the
// backend, then the door, then the connector, and stops them in the opposite order. On a machine
// whose backend is elsewhere it is the connector alone.
import { existsSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { contentPort } from '@it/protocol'
import { runConnector } from '../connector'
import { elsewhere, type Machine, machine, machineFile, notSetUp, Problem, readJson, why } from '../lib'
import { startsByItself, stopFile } from '../service'
import { ageBand, begin, countBand, counting, failureOf, record, recordNoted, sinceBegun } from '../usage'
import { asAdmin, type Backend, endOf, removeCopies, startBackend } from './backend'
import { backendFolder, readConfig, type ServiceConfig } from './config'
import { makeContent, startDoor } from './door'
import { reachable } from './network'

/**
 * Runs the service until it is asked to stop. A backend that ends by itself, and a newer It
 * installed on the machine, end it too, as a failure, so that whatever keeps it running starts
 * it again. On a machine whose backend is elsewhere, the connector is all of It there is to run.
 */
export async function serve(say: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): Promise<void> {
  const config = elsewhere() ? null : readConfig()
  if (!config && !elsewhere()) throw notSetUp()
  if (!config) machine()
  const asked = new AbortController()
  /** The signal that asked, which the connector is told in its turn. */
  let heard: NodeJS.Signals | undefined
  const hear = (signal: NodeJS.Signals) => {
    heard ??= signal
    asked.abort()
  }
  const told = () => heard ?? 'SIGTERM'
  process.on('SIGINT', hear)
  process.on('SIGTERM', hear)
  // Where the system has no signal to ask with, the service is asked to stop by a file in It's
  // folder, and stops as it does for a signal. One left from before this service began asks nothing.
  rmSync(stopFile(), { force: true })
  const asking = setInterval(() => {
    if (!existsSync(stopFile())) return
    rmSync(stopFile(), { force: true })
    say('asked to stop')
    hear('SIGTERM')
  }, 500)
  let failed = false
  // Counting begins with the service where no command has begun it, so that a service that
  // cannot start is counted as one that could not
  begin()
  try {
    failed = config ? await here(config, say, asked, told) : await connector(say, asked.signal, told)
  } catch (err) {
    // Asked to stop while it was still starting, it has stopped, which is no failure
    if (!(err instanceof Problem && err.code === 'stopped')) {
      // Counted by the one word of what went wrong, where It has a word for it, and never by what was said of it
      record('service.failed', { what: failureOf(err instanceof Problem ? err.code : undefined) })
      throw err
    }
  } finally {
    clearInterval(asking)
    process.off('SIGINT', hear)
    process.off('SIGTERM', hear)
  }
  say('service stopped')
  if (failed) process.exitCode = 1
}

/** The ports the door listens on: the site's, and the pages'. */
const doorPorts = (base: number): number[] => [base, contentPort(base)]

/**
 * Whether a port of this machine can be listened on, which is found out by listening on it for
 * a moment. Whatever connects in that moment is ended at once and answered nothing. The look is
 * over when the last connection it was given has ended, so one that was left open would hold
 * the service's start up for as long as whoever made it cared to wait for an answer.
 */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tried = net.createServer((given) => {
      given.on('error', () => {})
      given.destroy()
    })
    tried.once('error', (err) => resolve((err as NodeJS.ErrnoException).code !== 'EADDRINUSE'))
    tried.listen({ port, host: '127.0.0.1' }, () => tried.close(() => resolve(true)))
  })
}

/**
 * Refuses to go on where another program has one of the door's ports on this machine. It is
 * looked at before the backend program is started, so that a port that is taken is said at
 * once, and not after the backend has been started and its functions loaded for nothing.
 */
async function portsFree(config: ServiceConfig): Promise<void> {
  // Where a service already holds this folder, the ports are its own, and that it is running is what there is to say
  const holder = readJson<{ pid?: unknown }>(path.join(backendFolder(), 'lock'))?.pid
  if (typeof holder === 'number' && holder !== process.pid) {
    try {
      process.kill(holder, 0)
      return
    } catch {}
  }
  for (const port of doorPorts(config.port)) {
    if (!(await portFree(port)))
      throw new Problem(
        `Port ${port} is already in use on this machine, so It cannot listen on it.`,
        'port_taken',
        'Stop whatever is using it, or choose another first port for It by setting IT_PORT.',
      )
  }
}

/** The backend, then the door, then the connector, and when the connector has stopped, the door and then the backend. Whether it ended as a failure. */
async function here(config: ServiceConfig, say: (line: string) => void, asked: AbortController, told: () => NodeJS.Signals): Promise<boolean> {
  let failed = false
  await portsFree(config)
  const backend = await startBackend(config, say, asked.signal)
  /** Set once the service itself is stopping the backend, which is then not a backend that ended by itself. */
  let stopping = false
  try {
    void backend.ended.then((end) => {
      if (asked.signal.aborted || stopping) return
      say(`backend: ended by itself (${endOf(end)}); stopping`)
      record('service.failed', { what: 'backend_exited' })
      failed = true
      asked.abort()
    })
    const door = asked.signal.aborted
      ? null
      : await keptDoor(config, backend, say, () => {
          record('service.failed', { what: 'door' })
          failed = true
          asked.abort()
        })
    try {
      if (door) say(`service started (pid ${process.pid}); the site is on port ${config.port}`)
      if (await connector(say, asked.signal, told)) failed = true
    } finally {
      await door?.stop()
    }
  } finally {
    stopping = true
    await backend.stop()
  }
  return failed
}

/** How often the service looks at whether the network is to be on, and at which addresses this machine has. */
const LOOK_MS = 1000
/** How often the service takes from the backend what it noted for the counts of how It is used. */
const COLLECT_MS = 20_000

/**
 * What the service says to the backend of how it stands, under the names the backend's
 * `network:report` takes: whether its door is open to the network (`on`), what its settings
 * asked for (`wanted`), the addresses another device reaches it at, and two things that only
 * the computer It runs on can know, which the owner's settings then say as they are: whether It
 * is registered with the system to start by itself from this folder (`background`), and whether
 * counts of its use are being sent at this moment (`usage`).
 */
export const standsAs = (door: { network: boolean; tailnet?: boolean }, wanted: boolean, port: number) => ({
  on: door.network,
  wanted,
  addresses: door.network ? reachable(port, undefined, door.tailnet === true) : [],
  background: startsByItself(),
  usage: counting(),
})
type Stands = ReturnType<typeof standsAs>
/** How long a backend that would not take everything said is told only how the door stands, before it is told everything again. */
const SHORT_MS = 600_000
/**
 * Something that tells the backend how the service stands, whenever that is not what the
 * backend was last told. A backend that serves the functions of an earlier version of It, kept
 * because this version's could not be put onto the data, takes only how the door stands. It is
 * told that much, so that the site and `it network` go on working, and the rest is left unsaid.
 * So is a backend that refuses everything said and then takes that much: it is told everything
 * again a while later, and whenever what there is to say has changed.
 */
export function teller(tell: (said: Partial<Stands>) => Promise<unknown>, behind: boolean, clock: () => number = Date.now): (stands: Stands) => Promise<void> {
  let told = ''
  let shortUntil = behind ? Number.POSITIVE_INFINITY : 0
  const short = ({ on, wanted, addresses }: Stands) => ({ on, wanted, addresses })
  return async (stands) => {
    const said = clock() < shortUntil ? short(stands) : stands
    if (JSON.stringify(said) === told) return
    try {
      await tell(said)
      told = JSON.stringify(said)
    } catch (err) {
      if (said !== stands) throw err
      // Whatever it was that failed is what is said of it, should the shorter word fail as well
      await tell(short(stands)).catch(() => {
        throw err
      })
      told = JSON.stringify(short(stands))
      shortUntil = clock() + SHORT_MS
    }
  }
}

/**
 * What the service does when it is told that a person has erased everything: the copies of
 * the database from before an update go too, since each holds what was erased as it was when
 * the copy was made. Where they cannot be removed, that is said with the code of what stopped
 * it, and the telling fails: the backend's deleting is then not done, and it asks again.
 */
export function erasing(say: (line: string) => void): (person: string) => void {
  return (person) => {
    let copies: number
    try {
      copies = removeCopies(person)
    } catch (err) {
      say(
        `backend: everything was erased, and the copies of the database from before an update could not be removed (${why(err)}); it will be tried when the backend asks again`,
      )
      throw err
    }
    if (copies) say(`backend: everything was erased, and the copies of the database from before an update went with it (${copies})`)
  }
}

/**
 * The door, kept as the settings say it should be for as long as the service runs. `it network
 * on` and `it network off` write the settings, and the service looks there every second: when
 * what they say has changed, the door is closed and opened anew, on every address this machine
 * has or on this machine alone, with nothing else of the service stopped. The backend is told
 * how the door stands, and at which addresses another device reaches it, when the door opens
 * and whenever either changes: a machine's addresses change as it moves between networks. It
 * is told in the same word whether It starts by itself here and whether usage counts are being
 * sent, and told again within a second or two of either changing.
 *
 * Where the door cannot listen on the network, it is opened for this machine alone, and that is
 * said: the site goes on working where the person is. `lost` is called if it cannot be opened
 * at all, which ends the service as a failure.
 *
 * The content package is made once, here, and given to every door that is opened. It is what
 * remembers each page that is being shown, so a page that is open stays shown, at the address
 * it has, when the door is closed and opened anew. It is closed when the service ends: after
 * the last door, through which it was asked, and before the backend program is stopped.
 */
async function keptDoor(config: ServiceConfig, backend: Backend, say: (line: string) => void, lost: () => void): Promise<{ stop(): Promise<void> }> {
  const erased = erasing(say)
  const content = makeContent(config, backend, say, erased)
  const open = async (network: boolean, tailnet: boolean) => {
    try {
      return {
        door: await startDoor({ ...config, network, tailnet: network && tailnet }, backend, say, { content, erased }),
        network,
        tailnet: network && tailnet,
      }
    } catch (err) {
      if (!network) throw err
      say(`door: could not listen on the network (${why(err)}); it answers this machine only`)
      return { door: await startDoor({ ...config, network: false, tailnet: false }, backend, say, { content, erased }), network: false, tailnet: false }
    }
  }
  let now: Awaited<ReturnType<typeof open>>
  try {
    now = await open(config.network, config.tailnet === true)
  } catch (err) {
    // No door was opened to ask anything of it
    await content.close().catch(() => {})
    throw err
  }
  /** What the settings last said, which is what was last tried. */
  let wanted = config.network
  let wantedTailnet = config.network && config.tailnet === true
  const report = teller((said) => asAdmin(backend, 'network:report', said), backend.behind !== undefined)
  const tell = () => report(standsAs(now, wanted, config.port))
  /** Whether it has been said that the backend could not be told. Said once, until it has been told again. */
  let untold = false
  const telling = () =>
    tell().then(
      () => {
        untold = false
      },
      (err) => {
        // Tried again at the next look. Until it works, the site and `it network` go by what was said last
        if (!untold) say(`door: the backend could not be told how the door stands (${why(err)}); trying again`)
        untold = true
      },
    )
  let looking = false
  let stopped = false
  const look = async () => {
    if (looking || stopped) return
    looking = true
    try {
      // Settings that cannot be read just now say nothing, and the door stays as it is
      let said: boolean | undefined
      let saidTailnet = false
      try {
        const kept = readConfig()
        said = kept?.network
        saidTailnet = kept?.network === true && kept.tailnet === true
      } catch {}
      if (said !== undefined && (said !== wanted || saidTailnet !== wantedTailnet)) {
        wanted = said
        wantedTailnet = saidTailnet
        // Whom the door answers is part of how it was opened, so it is opened anew for that too
        if (said !== now.network || saidTailnet !== now.tailnet) {
          await now.door.stop()
          now = await open(said, saidTailnet)
        }
      }
      await telling()
    } catch (err) {
      say(`door: could not be opened again (${why(err)}); stopping`)
      stopped = true
      lost()
    } finally {
      looking = false
    }
  }
  await telling()
  const timer = setInterval(() => void look(), LOOK_MS)
  // What happened between a screen and the backend is noted there, and taken from it here a few
  // times a minute, where what is sent is sent from (see `convex/lib/counted.ts`). Once a day
  // the backend is also asked how much this It holds, which is counted in bands. A backend that
  // serves the functions of an earlier It keeps no notes and is asked for none. Whatever goes
  // wrong in this stops nothing, and is tried again at the next pass.
  let collecting = false
  let picturedAt = 0
  const collect = async () => {
    if (collecting || stopped || backend.behind !== undefined) return
    collecting = true
    try {
      const on = counting()
      for (let pass = 0, more = true; more && pass < 5; pass++) {
        const got = (await asAdmin(backend, 'counted:take', { keep: on })) as { notes?: { name: string; properties: string }[]; more?: boolean }
        for (const note of got.notes ?? []) recordNoted(note.name, note.properties)
        more = got.more === true
      }
      if (on && Date.now() - picturedAt > 86_400_000) {
        const holds = (await asAdmin(backend, 'counted:picture', {})) as {
          pages: number
          displays: number
          machines: number
          conversations: number
          push: boolean
        }
        picturedAt = Date.now()
        record('installation.seen', {
          pages: countBand(holds.pages),
          displays: countBand(holds.displays),
          machines: countBand(holds.machines),
          conversations: countBand(holds.conversations),
          network: !now.network ? 'off' : now.tailnet ? 'tailscale' : 'lan',
          background: startsByItself(),
          push: holds.push === true,
          age: ageBand(sinceBegun() ?? 0),
        })
      }
    } catch {
    } finally {
      collecting = false
    }
  }
  const collector = setInterval(() => void collect(), COLLECT_MS)
  collector.unref()
  void collect()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      clearInterval(collector)
      // A door that is being opened anew at this moment is waited for, and then closed
      while (looking) await new Promise((resolve) => setTimeout(resolve, 20))
      await now.door.stop().catch(() => {})
      // With the last door closed, nothing more is asked of the content package
      await content.close().catch(() => {})
    },
  }
}

/**
 * Runs the connector for as long as the service runs and this machine is one of It's machines.
 * On a first run the service is started a moment before the machine is enrolled, so the
 * connector starts when it has been. A machine that It has stopped knowing has no use for a
 * connector until it is enrolled anew, and the site goes on being served meanwhile. Whether
 * the connector ended as a failure, which it does to make way for a newer It.
 */
async function connector(say: (line: string) => void, asked: AbortSignal, heard: () => NodeJS.Signals): Promise<boolean> {
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        asked.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      asked.addEventListener('abort', done)
    })
  /** The identity the connector last ran as, and stopped by itself as. */
  let ended: string | undefined
  while (!asked.aborted) {
    const id = readJson<Machine>(machineFile())?.id
    if (!id || id === ended) {
      await pause(1000)
      continue
    }
    // The connector listens for a signal only once it has started. One that came before then
    // is said to it again until it has heard.
    let running = true
    const again = setInterval(() => {
      if (asked.aborted && running) process.emit(heard())
    }, 250)
    try {
      await runConnector(say)
    } catch (err) {
      say(`connector: could not start: ${why(err)}`)
      await pause(30_000)
      continue
    } finally {
      running = false
      clearInterval(again)
    }
    if (process.exitCode === 1) return true
    ended = id
  }
  return false
}
