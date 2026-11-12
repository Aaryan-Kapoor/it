// Setting Tailscale up to take https for It: what `it https on` asks of Tailscale's own command,
// and what it refuses. It reads what Tailscale serves, adds only its own two entries, and takes
// those two away again where it cannot confirm that no Tailscale Funnel makes It public. It never
// changes a Funnel, or anything Tailscale serves for another program.
import { spawnSync } from 'node:child_process'
import { Problem } from './lib'
import { funnelPorts, inspectFunnel, type System, servedAs, tailscaleCommand } from './serve/tailnet'

/** Tailscale's own command, as it is run here: what it printed, and whether it did what it was asked. */
export type Ran = { ok: boolean; out: string; err: string }
export type Run = (args: string[]) => Ran

/** Runs Tailscale's command where `tailscaleCommand` finds it, on the system given. */
export const tailscaleRun =
  (system?: System): Run =>
  (args) => {
    const ran = spawnSync(tailscaleCommand(system) ?? 'tailscale', args, {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: ran.status === 0, out: ran.stdout ?? '', err: `${ran.stderr ?? ''}${ran.error ? ` ${ran.error.message}` : ''}`.trim() }
  }

/** What is said where Tailscale could not be asked or would not do it, with its own words where it said any. */
export function tailscaleRefused(what: string, ran: Ran): Problem {
  const said = ran.err || ran.out
  const operator = /access denied|permission|operator/i.test(said)
  const enable = /not enabled|https?:\/\/login\.tailscale\.com\S*/i.exec(said)
  return new Problem(
    `Tailscale on this machine would not ${what}.${said ? ` It said: ${said.split('\n').slice(0, 3).join(' ').trim()}` : ''}`,
    'tailscale',
    operator
      ? 'Let your user run `tailscale serve` with `sudo tailscale set --operator=$USER`, and run this again.'
      : enable
        ? 'Turn on MagicDNS and https certificates for your tailnet in Tailscale’s admin console (DNS), as the address it gave says, and run this again.'
        : 'Check that Tailscale is running and signed in here, and that your tailnet has MagicDNS and https certificates turned on.',
  )
}

/**
 * What Tailscale serves, as `tailscale serve status --json` says it. Nothing served where it
 * prints nothing or `null`, which is what it prints where nothing has been set up.
 */
export function servedNow(run: Run): unknown {
  const status = run(['serve', 'status', '--json'])
  if (!status.ok) throw tailscaleRefused('say what it serves', status)
  try {
    const served: unknown = status.out.trim() ? JSON.parse(status.out) : null
    if (served === null) return {}
    if (typeof served !== 'object' || Array.isArray(served)) throw new Error('not an object')
    return served
  } catch {
    throw new Problem(
      'Tailscale said what it serves in a form It cannot read, so https was not turned on.',
      'tailscale',
      '`tailscale serve status` says what it serves.',
    )
  }
}

/**
 * The `tailscale funnel` command that turns off the Funnel on a listener port (`at`), by the kind
 * of listener it is. Nothing where the Funnel is one a `tailscale funnel` command keeps up while
 * it runs in the foreground, which ends when that command does.
 */
export function funnelOff(status: unknown, at: number): string | undefined {
  const s = status as { AllowFunnel?: Record<string, unknown>; TCP?: Record<string, Record<string, unknown> | null> } | null
  if (!Object.entries(s?.AllowFunnel ?? {}).some(([host, allowed]) => allowed === true && host.endsWith(`:${at}`))) return undefined
  const tcp = s?.TCP?.[String(at)]
  const kind = tcp?.HTTPS ? 'https' : tcp?.HTTP ? 'http' : tcp?.TCPForward ? (tcp.TerminateTLS ? 'tls-terminated-tcp' : 'tcp') : 'https'
  return `tailscale funnel --${kind}=${at} off`
}

const both = (items: (string | number)[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : String(items[0]))

/**
 * Has Tailscale take https at the machine's name (`name`) on each of It's ports (`ports`), each
 * at the port Tailscale takes https at for it (`at`). Refused before anything is changed where a
 * Funnel reaches It, where one may, or where Tailscale serves something else at one of those
 * ports. Once It has set its entries up it asks again whether a Funnel reaches It, and where
 * that cannot be confirmed, or a later entry is refused, it takes away the entries it has just
 * made, and only those.
 */
export async function turnHttpsOn(
  name: string,
  ports: { port: number; at: number }[],
  run: Run,
  inspect: (ports: number[]) => Promise<number[] | undefined> = (asked) => inspectFunnel(asked, undefined, 10_000),
): Promise<void> {
  const served = servedNow(run)
  const own = ports.map(({ port }) => port)
  const exposed = funnelPorts(served, own)
  if (exposed === undefined)
    throw new Problem(
      'A Tailscale Funnel forwards to a place that may be It, and It cannot tell whether it is, so https was not turned on.',
      'funnel_unconfirmed',
      '`tailscale funnel status` says where each Funnel forwards. Turn off any that may reach It, then run `it https on` again.',
    )
  if (exposed.length) {
    const commands = exposed.map((at) => funnelOff(served, at))
    const told = commands.filter((command): command is string => command !== undefined).map((command) => `\`${command}\``)
    throw new Problem(
      `Tailscale Funnel makes It public on port ${both(exposed)}, so https was not turned on.`,
      'funnel_public',
      `${told.length ? `Turn that Funnel off with ${both(told)}` : 'Stop the `tailscale funnel` command that runs in the foreground'}${told.length && told.length < commands.length ? ', and stop the `tailscale funnel` command that runs in the foreground' : ''}, then run \`it https on\` again.`,
    )
  }
  const taken = ports.filter(({ port, at }) => servedAs(served, name, at, port) === 'other').map(({ at }) => at)
  if (taken.length)
    throw new Problem(
      `Tailscale on this machine already serves something else on port ${taken.join(' and ')}, which It would answer https at.`,
      'port_taken',
      `\`tailscale serve status\` says what. Take it away there, or run It on other ports with IT_PORT, and run this again.`,
    )
  const made: number[] = []
  /**
   * Takes away the entries made just now, each only where Tailscale still serves it as It set it
   * up: one that another program has changed since is that program's, and is left as it is. The
   * ports where Tailscale may still serve It, if any: every one made, where what Tailscale serves
   * cannot be read again.
   */
  const undo = () => {
    if (!made.length) return []
    let now: unknown
    try {
      now = servedNow(run)
    } catch {
      return [...made]
    }
    return made.filter((at) => {
      const port = ports.find((p) => p.at === at)!.port
      return servedAs(now, name, at, port) === 'its' && !run(['serve', `--https=${at}`, 'off']).ok
    })
  }
  const leftAt = (left: number[]) =>
    new Problem(
      `It could not take away what it had just set up, so Tailscale may still serve https for It on port ${both(left)}. https is not turned on in It’s settings.`,
      'tailscale',
      'Run `it https on` again once Tailscale answers, which finishes setting it up, or `it https off`, which takes it away.',
    )
  for (const { port, at } of ports) {
    if (servedAs(served, name, at, port) === 'its') continue
    const ran = run(['serve', '--bg', `--https=${at}`, `http://127.0.0.1:${port}`])
    if (!ran.ok) {
      const left = undo()
      if (left.length) throw leftAt(left)
      throw tailscaleRefused(`serve https on port ${at}`, ran)
    }
    made.push(at)
  }
  const verified = await inspect(own)
  if (verified === undefined || verified.length) {
    const left = undo()
    if (left.length) throw leftAt(left)
    throw new Problem(
      verified === undefined
        ? 'It could not confirm that no Tailscale Funnel makes It public, so it took away what it had just set up in Tailscale and did not turn https on.'
        : `Tailscale Funnel makes It public on port ${both(verified)}, so It took away what it had just set up in Tailscale and did not turn https on.`,
      verified === undefined ? 'funnel_unconfirmed' : 'funnel_public',
      '`tailscale funnel status` says what Tailscale makes public. Check it, then run `it https on` again.',
    )
  }
}
