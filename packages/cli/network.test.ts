// The home network: which of this machine's addresses another device can open It at, and `it
// network on` and `it network off` run as the program itself against the real backend program,
// with a service that is running and with none. Each test has an It folder and a base port of
// its own, and nothing here reaches a remote.
//
// A test that has the It it started listen on every address this machine has opens that It to
// whatever network the machine is on, for a moment. Whoever runs the tests on their own machine
// has not asked for that, so those tests run only where CI is set or IT_E2E_NETWORK=1 says they
// may, as the end-to-end suite's do, and a line says so where they are left out.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { backendAt } from './src/lib'
import { asAdmin } from './src/serve/backend'
import { RELEASE } from './src/serve/config'
import { reachable } from './src/serve/network'
import { bases } from './test-ports'

// ---------- which addresses ----------

const four = (address: string) => ({ address, family: 'IPv4' as const, internal: false })
const six = (address: string) => ({ address, family: 'IPv6' as const, internal: false })

describe('the addresses another device can open the site at', () => {
  test('on a Linux machine with a wire, a tunnel and containers: the home network’s first, then the tunnel’s, then IPv6, and nothing of the containers', () => {
    const listed = reachable(4700, {
      lo: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
      ],
      enp3s0: [four('10.0.0.20'), six('2001:db8:100:c690:1111:2222:3333:4444'), six('2001:db8:100:c690::4f1a'), six('fe80::1111:2222:3333:4444')],
      tailscale0: [four('100.101.42.17'), six('fd7a:115c:a1e0::ab12:4843'), six('fe80::5555:6666:777:8888')],
      docker0: [four('172.17.0.1'), six('fe80::42:acff:fe11:1')],
      'br-0a1b2c3d4e5f': [four('172.18.0.1')],
      veth9a8b7c6: [six('fe80::1c2d:3eff:fe4f:5a6b')],
      virbr0: [four('192.168.122.1')],
    })
    expect(listed).toEqual([
      'http://10.0.0.20:4700',
      'http://100.101.42.17:4700',
      'http://[2001:db8:100:c690:1111:2222:3333:4444]:4700',
      'http://[2001:db8:100:c690::4f1a]:4700',
      'http://[fd7a:115c:a1e0::ab12:4843]:4700',
    ])
  })

  test('on a Mac with Wi-Fi and a wire, both are given, in the order the system lists them, and the tunnels and the bridge to its virtual machines are not ahead of them', () => {
    const listed = reachable(4700, {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }, six('fe80::1')],
      en0: [six('fe80::1c3f:7d2a:9b10:44aa'), four('192.168.1.20'), six('fd12:3456:789a:1::20')],
      en7: [four('192.168.1.31')],
      utun3: [four('10.8.0.2')],
      bridge100: [four('192.168.64.1'), six('fd0c:7d6e:11a4:5e3f::1')],
    })
    expect(listed).toEqual(['http://192.168.1.20:4700', 'http://192.168.1.31:4700', 'http://10.8.0.2:4700', 'http://[fd12:3456:789a:1::20]:4700'])
  })

  test('on Windows the switches of its virtual machines and the adapters of other programs’ are left out by the names it gives them', () => {
    const listed = reachable(4700, {
      'Wi-Fi': [six('fe80::d5a2:7c31:19ee:3f02'), four('192.168.0.14')],
      'vEthernet (WSL (Hyper-V firewall))': [four('172.29.112.1')],
      'vEthernet (Default Switch)': [four('172.20.32.1')],
      'VirtualBox Host-Only Network': [four('192.168.56.1')],
      'VMware Network Adapter VMnet8': [four('192.168.80.1')],
      Tailscale: [four('100.90.1.2')],
      'Loopback Pseudo-Interface 1': [
        { address: '::1', family: 'IPv6', internal: true },
        { address: '127.0.0.1', family: 'IPv4', internal: true },
      ],
    })
    expect(listed).toEqual(['http://192.168.0.14:4700', 'http://100.90.1.2:4700'])
  })

  test('an address a machine gave itself comes after every other under IPv4, a public one after the home network’s, and each address is given once', () => {
    const listed = reachable(39500, {
      eth0: [four('169.254.10.20'), four('203.0.113.9'), four('192.168.1.20'), four('192.168.1.20')],
      eth1: [four('172.16.5.5'), four('172.32.0.1')],
    })
    expect(listed).toEqual([
      'http://192.168.1.20:39500',
      'http://172.16.5.5:39500',
      'http://203.0.113.9:39500',
      'http://172.32.0.1:39500',
      'http://169.254.10.20:39500',
    ])
  })

  test('a machine on no network has none, and one with a dozen addresses under IPv6 is given the first few', () => {
    expect(reachable(4700, { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toEqual([])
    expect(reachable(4700, {})).toEqual([])
    const many = reachable(4700, { eth0: [four('192.168.1.20'), ...Array.from({ length: 12 }, (_, n) => six(`2001:db8::${n + 1}`))] })
    expect([many.length, many[0], many[1]]).toEqual([8, 'http://192.168.1.20:4700', 'http://[2001:db8::1]:4700'])
  })

  test('what the system lists for this machine gives addresses that are whole, each with the port, and none of them this machine’s own name for itself', () => {
    for (const at of reachable(4700)) {
      expect(at).toMatch(/^http:\/\/(\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+):4700$/)
      expect(at).not.toMatch(/127\.0\.0\.1|\[::1\]|\[fe80/)
    }
  })
})

// ---------- the command, with the real backend program ----------

const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, 'convex-local-backend')].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)
const listening = (port: number, address = '127.0.0.1') =>
  new Promise<net.Server | null>((resolve) => {
    const server = net.createServer((socket) => socket.destroy())
    server.once('error', () => resolve(null)).listen(port, address, () => resolve(server))
  })
const closed = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))
/**
 * The base ports this file's tests take: each from a block of the file's own, below the ports
 * the system hands out by itself to whatever asks for one, and each held from when a test takes
 * it until the test is over, so that no other run of the tests on this machine has the same one.
 */
const ports = bases(26_100, 15)
const until = async (what: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await what()) return true
  return false
}
/** An address of this machine on a network, where it has one: what another device would open. */
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && !a.internal && a.family === 'IPv4')?.address
/** Whether a test may have the It it started listen on every address this machine has. */
const mayOpen = Boolean(process.env.CI) || process.env.IT_E2E_NETWORK === '1'
/** The names of the tests that turn the network on for a running It from beginning to end, and are left out where that was not asked for. */
const TURN_IT_ON: string[] = []
/** A test that turns the network on for an It that is running, which is run only where that may be done. */
const turningItOn = (name: string, run: () => Promise<void>, ms: number) => {
  TURN_IT_ON.push(name)
  test.skipIf(!mayOpen)(name, run, ms)
}
/** Set in the run of this file that one of its own tests starts, so that the run does not start another in its turn. */
const WITHIN = 'IT_NETWORK_TESTS_WITHIN'
/** Whether anything answers at an address and port. */
const answers = (address: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, address)
    socket.once('connect', () => resolve(true)).once('error', () => resolve(false))
    socket.setTimeout(2000, () => resolve(false))
  }).finally(() => {})

describe.skipIf(!program || process.platform === 'win32')('`it network`, run as the program itself', () => {
  let scratch: string
  let it: string
  let folder: string
  let port: number
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'it-net-'))
    it = path.join(scratch, 'it.mjs')
    // Bundled the way `build.mjs` bundles it, into a folder that is thrown away afterwards
    await build({
      entryPoints: [path.join(__dirname, 'src/main.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: it,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
    mkdirSync(path.join(scratch, 'commands'))
    symlinkSync(process.execPath, path.join(scratch, 'commands', 'node'))
    if (!mayOpen)
      console.log(
        '  skip  the tests that turn the network on for an It that is running: set IT_E2E_NETWORK=1 to have them open the It they start to this machine’s network for a moment',
      )
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  beforeEach(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-network-'))
    port = await ports.next()
  })

  const children: ChildProcess[] = []
  /** Runs the program for this test's folder, with only what is given here in its environment. */
  const run = (args: string[], env: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [it, ...args], {
      cwd: folder,
      env: {
        PATH: path.join(scratch, 'commands'),
        HOME: folder,
        IT_HOME: folder,
        IT_PORT: String(port),
        IT_BACKEND_BIN: program!,
        IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
        IT_HARNESSES: 'none',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout!.on('data', (c: Buffer) => (out += c))
    child.stderr!.on('data', (c: Buffer) => (err += c))
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    return { child, ended, out: () => out, err: () => err }
  }
  /** What a command answered, having ended well. */
  const said = async (args: string[]) => {
    const ran = run(args)
    expect([args.join(' '), await ran.ended, ran.err().includes('"error"') ? ran.err() : '']).toEqual([args.join(' '), 0, ''])
    return { answer: JSON.parse(ran.out()), words: ran.err() }
  }
  const refused = async (args: string[], env: Record<string, string> = {}) => {
    const ran = run(args, env)
    const code = await ran.ended
    return { exit: code, ...(JSON.parse(ran.err().trim().split('\n').pop()!).error as { code: string; message: string; hint?: string }) }
  }
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    }
    // Where nobody asked for it, no service a test here started has had its door open on every address of the machine
    const opened = lines().filter((line) => line.includes('the network is on'))
    rmSync(folder, { recursive: true, force: true })
    // Given back last, when everything the test started on it has stopped
    await ports.release()
    if (!process.env.CI && process.env.IT_E2E_NETWORK !== '1') expect(opened).toEqual([])
  })
  const settings = () => JSON.parse(readFileSync(path.join(folder, 'service.json'), 'utf8')) as { network: boolean; adminKey: string }
  const log = () => (existsSync(path.join(folder, 'service.log')) ? readFileSync(path.join(folder, 'service.log'), 'utf8') : '')
  const lines = () =>
    log()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^\S+ /, ''))
  /** How the running service last told the backend its door stands. */
  const told = () =>
    asAdmin({ api: backendAt(port).api, adminKey: settings().adminKey }, 'network:current', {}) as Promise<{ on: boolean; addresses: string[] }>
  /** Sets It up, starts its service by hand as `it serve`, and waits until it is all there. */
  async function serving() {
    expect(await run(['setup', '--none', '--no-service']).ended).toBe(0)
    const service = run(['serve', '--log', path.join(folder, 'service.log')])
    // Where it does not start, what it wrote down says why
    expect([await until(() => lines().some((line) => /^connector \S+ started/.test(line))), lines().join(' | ')]).toEqual([true, expect.any(String)])
    return service
  }
  const ON = 'The network is on. Devices on the same network can open It at:'
  const OFF = 'The network is off. It answers this machine only.'
  /**
   * Holds the site's port on another address of this machine than the ones It answers at when
   * the network is off: one of the machine's own beside its first, or its address on a network.
   * While it is held, It cannot listen on every address, and stops trying at the first of them,
   * so nothing of it is opened to a network. Null where the machine has no such address, and on
   * macOS: there the system lets one program listen on every address while another has the port
   * on one of them, so nothing held this way is in It's way.
   */
  const heldBeside = async () => (process.platform === 'darwin' ? null : ((await listening(port, '127.0.0.2')) ?? (lan ? await listening(port, lan) : null)))

  test('where It was never set up it says to run `it setup`, on a machine that only joined an It it says where to turn it, and it takes on, off or nothing', async () => {
    expect(await refused(['network'])).toMatchObject({ exit: 1, code: 'not_set_up' })
    expect(await refused(['network', 'on'])).toMatchObject({ exit: 1, code: 'not_set_up' })
    expect(existsSync(path.join(folder, 'service.json'))).toBe(false)
    writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'laptop', key: {}, at: 'http://192.168.1.20:4700' }))
    expect(await refused(['network', 'on'], { IT_PORT: '' })).toEqual({
      exit: 2,
      code: 'invalid',
      message: 'This machine joined an It that runs on another machine, and has no network of It’s own to turn on.',
      hint: 'Run `it network` on the machine It runs on.',
    })
    expect(await refused(['network', 'maybe'])).toMatchObject({
      exit: 2,
      code: 'invalid',
      message: 'It is `it network`, `it network on`, `it network tailscale` or `it network off`.',
    })
    expect(await refused(['network', 'on', 'now'])).toMatchObject({ exit: 2, code: 'invalid' })
  })

  test('with no service running it writes the setting and says that It is not running, when it is turned on and when it is asked about afterwards', async () => {
    expect(await run(['setup', '--none', '--no-service']).ended).toBe(0)
    const STOPPED = 'It is not running on this machine at the moment, so this takes effect when it starts.'
    const off = await said(['network'])
    expect(off).toEqual({ answer: { network: false, addresses: [] }, words: expect.stringContaining(OFF) })
    expect(off.words).toContain(STOPPED)
    const on = await said(['network', 'on'])
    expect(on.answer).toEqual({ network: true, addresses: reachable(port) })
    expect(on.words).toContain(STOPPED)
    expect(settings().network).toBe(true)
    // Asked how it stands, it says what the setting is, and that nothing listens until It starts
    const asked = await said(['network'])
    expect(asked.answer).toEqual({ network: true, addresses: reachable(port) })
    expect(asked.words).toContain(STOPPED)
    expect((await said(['status'])).answer).toMatchObject({ running: false, network: { on: true, addresses: reachable(port) } })
    if (lan) expect(await answers(lan, port)).toBe(false)
  }, 120_000)

  turningItOn(
    'a service that starts with the network turned on in its settings listens on every address this machine has',
    async () => {
      expect(await run(['setup', '--none', '--no-service']).ended).toBe(0)
      expect((await said(['network', 'on'])).answer.network).toBe(true)
      run(['serve', '--log', path.join(folder, 'service.log')])
      expect(await until(() => lines().some((line) => /^connector \S+ started/.test(line)))).toBe(true)
      expect(lines().filter((line) => line.startsWith('door open'))).toEqual([`door open on port ${port} (the network is on: every address this machine has)`])
      expect(await told()).toMatchObject({ on: true, addresses: reachable(port) })
      if (lan) expect(await answers(lan, port)).toBe(true)
      // Asked about now, nothing is said of It not running
      expect((await said(['network'])).words).not.toContain('not running')
    },
    120_000,
  )

  turningItOn(
    'a service that is running, started by hand, takes each change by itself: its door is opened anew, the command waits for that, and nothing else of the service is stopped',
    async () => {
      const service = await serving()
      expect(await told()).toMatchObject({ on: false, addresses: [] })
      if (lan) expect(await answers(lan, port)).toBe(false)
      const backendWas = JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')).program as number

      const on = await said(['network', 'on'])
      expect(on.answer).toEqual({ network: true, addresses: reachable(port) })
      expect(on.words).toContain(ON)
      expect(on.words).not.toContain('not running')
      // The likeliest address is said in words, and every one of them is in what the command answers
      if (reachable(port).length) expect(on.words).toContain(`${ON} ${reachable(port)[0]}`)
      // By the time the command has ended, the door answers the network and the backend has been told at which addresses
      expect(await told()).toMatchObject({ on: true, addresses: reachable(port) })
      if (lan) {
        expect(await answers(lan, port)).toBe(true)
        const page = await fetch(`http://${lan}:${port}/`)
        expect([page.status, (await page.text()).includes('<div id="root">')]).toEqual([200, true])
      }
      expect((await said(['network'])).answer).toEqual({ network: true, addresses: reachable(port) })
      expect((await said(['status'])).answer).toMatchObject({ running: true, enrolled: true, network: { on: true, addresses: reachable(port) } })
      // Asked for again as it already is, it is said again and nothing is opened anew
      const opened = () => lines().filter((line) => line.startsWith('door open')).length
      expect(opened()).toBe(2)
      expect((await said(['network', 'on'])).answer.network).toBe(true)
      expect(opened()).toBe(2)

      const off = await said(['network', 'off'])
      expect(off.answer).toEqual({ network: false, addresses: [] })
      expect(off.words).toContain(OFF)
      expect(await told()).toMatchObject({ on: false, addresses: [] })
      if (lan) expect(await answers(lan, port)).toBe(false)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      expect((await said(['status'])).answer.network).toEqual({ on: false, addresses: [] })

      // Only the door was closed and opened: the backend program and the connector are the ones that were started
      expect(
        lines()
          .filter((line) => /^(door|backend: started|connector \S+ started|stopped)/.test(line))
          .map((line) => line.replace(/ \(pid.*$/, '').replace(/^connector.*$/, 'connector started')),
      ).toEqual([
        'backend: started',
        `door open on port ${port} (the network is off: this machine only)`,
        'connector started',
        'door closed',
        `door open on port ${port} (the network is on: every address this machine has)`,
        'door closed',
        `door open on port ${port} (the network is off: this machine only)`,
      ])
      expect(JSON.parse(readFileSync(path.join(folder, 'backend', 'lock'), 'utf8')).program).toBe(backendWas)
      expect(service.child.exitCode).toBeNull()
      // What the service wrote down names none of this machine's addresses
      for (const at of reachable(port)) expect(log()).not.toContain(new URL(at).hostname)
    },
    120_000,
  )

  test('where another program has It’s port on one of this machine’s addresses, the network is left off, the command says so at once, and the site goes on answering this machine', async ({
    skip,
  }) => {
    await serving()
    const other = await heldBeside()
    // A machine with no address but its first has none for another program to hold, and on macOS holding one keeps It from nothing
    if (!other) return skip()
    try {
      const began = Date.now()
      expect(await refused(['network', 'on'])).toMatchObject({
        exit: 1,
        code: 'cannot_listen',
        message: 'It could not listen on this machine’s network addresses, so the network is left off.',
      })
      expect(Date.now() - began).toBeLessThan(15_000)
      expect(settings().network).toBe(false)
      expect(lines()).toContain('door: could not listen on the network (port_taken); it answers this machine only')
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      expect((await said(['network'])).answer).toEqual({ network: false, addresses: [] })
      if (lan) expect(await answers(lan, port)).toBe((other.address() as net.AddressInfo).address === lan)
    } finally {
      await closed(other)
    }
    // With the port free again, it is turned on as ever
    if (!mayOpen) return
    expect((await said(['network', 'on'])).answer.network).toBe(true)
    if (lan) expect(await answers(lan, port)).toBe(true)
  }, 120_000)

  test('a page that is being shown stays shown, at the address it has, when the door is closed and opened anew', async ({ skip }) => {
    await serving()
    const door = `http://127.0.0.1:${port}`
    // A browser is paired as the person's own, through the door as a browser is, and is a display
    const site = run(['site', '--no-open'])
    expect(await site.ended).toBe(0)
    const asSite = { origin: door, 'x-it-site': '1', 'content-type': 'application/json' }
    const redeemed = await fetch(`${door}/session/redeem`, {
      method: 'POST',
      headers: asSite,
      body: JSON.stringify({ code: new URL(JSON.parse(site.out()).url).hash.slice(1) }),
    })
    expect(redeemed.status).toBe(200)
    const cookie = redeemed.headers.getSetCookie()[0]!.split(';')[0]!
    const session = (await (await fetch(`${door}/session/token`, { method: 'POST', headers: { ...asSite, cookie } })).json()) as { token: string }
    const browser = new ConvexHttpClient(door, { logger: false })
    browser.setAuth(session.token)
    const displayKey = 'a-display-key-000001'
    await browser.mutation(makeFunctionReference<'mutation'>('displays:register'), {
      key: displayKey,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0',
    })
    // A page is made and shown there: the site asks for the showing's one ticket, and trades it at the pages' port for the showing's address
    expect((await said(['create', 'A page', '--id', 'plan', '--html', '<p>what is being shown</p>'])).answer).toMatchObject({ id: 'plan', version: 1 })
    const page = (await browser.query(makeFunctionReference<'query'>('artifacts:get'), { slug: 'plan' })) as { id: string }
    const { mountId } = (await browser.mutation(makeFunctionReference<'mutation'>('mounts:create'), { artifactId: page.id, displayKey })) as { mountId: string }
    const { ticket } = (await browser.action(makeFunctionReference<'action'>('mounts:ticket'), { mountId })) as { ticket: string }
    const pages = `http://127.0.0.1:${port + 1}`
    const opened = await fetch(`${pages}/open/${ticket}`, { redirect: 'manual' })
    expect(opened.status).toBeGreaterThanOrEqual(300)
    const address = new URL(opened.headers.get('location')!, pages).href
    expect(address).toMatch(/\/s\/[A-Za-z0-9_-]{20,}\/v\/1\//)
    const shown = async () => {
      const answer = await fetch(address)
      return [answer.status, (await answer.text()).includes('what is being shown')]
    }
    expect(await shown()).toEqual([200, true])

    // The door is closed and opened anew. Where the network may not be opened to, that is had by
    // asking for the network while another program holds the site's port beside It's own
    // address: It closes its door, cannot listen on every address, and opens it for this machine again
    const doors = () => lines().filter((line) => line.startsWith('door open')).length
    if (mayOpen) {
      expect((await said(['network', 'on'])).answer.network).toBe(true)
      expect(await shown()).toEqual([200, true])
      expect((await said(['network', 'off'])).answer.network).toBe(false)
      expect(doors()).toBe(3)
    } else {
      const other = await heldBeside()
      if (!other) return skip()
      try {
        expect(await refused(['network', 'on'])).toMatchObject({ exit: 1, code: 'cannot_listen' })
      } finally {
        await closed(other)
      }
      expect(doors()).toBe(2)
    }
    expect(lines()).toContain('door closed')
    // The showing answers at its address as before, and the ticket it was opened with opens nothing a second time
    expect(await shown()).toEqual([200, true])
    expect((await fetch(`${pages}/open/${ticket}`, { redirect: 'manual' })).status).toBeGreaterThanOrEqual(400)
  }, 120_000)

  test('how the door stands is the service’s to say and the owner’s to read: a machine’s own token can do neither', async () => {
    await serving()
    expect((await said(['whoami'])).answer).toMatchObject({ name: os.hostname() })
    const token = (JSON.parse(readFileSync(path.join(folder, 'token.json'), 'utf8')) as { token: string }).token
    const call = (kind: string, name: string, args: unknown) =>
      fetch(`${backendAt(port).api}/api/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: name, args: [args], format: 'json' }),
      }).then((r) => r.json() as Promise<{ status: string; errorData?: { code?: string } }>)
    expect((await call('mutation', 'network:report', { on: true, wanted: true, addresses: ['http://203.0.113.9:1'] })).status).toBe('error')
    expect((await call('query', 'network:current', {})).status).toBe('error')
    expect(await call('query', 'network:get', {})).toMatchObject({ status: 'error', errorData: { code: 'forbidden' } })
    expect(await told()).toMatchObject({ on: false, addresses: [] })
  }, 120_000)
})

describe.skipIf(!program || process.platform === 'win32')('the tests that turn the network on for an It that is running', () => {
  // The run that this test starts is of this very file, and does not start one more
  test.skipIf(process.env[WITHIN] === '1')(
    'are left out where neither CI nor IT_E2E_NETWORK=1 says they may be run, and no other test here opens an It to the network then',
    async () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-net-within-'))
      const report = path.join(scratch, 'report.json')
      // This file's tests once more, as whoever runs them on a machine of their own does: with neither of the two set
      const env: Record<string, string | undefined> = { ...process.env, [WITHIN]: '1' }
      delete env.CI
      delete env.IT_E2E_NETWORK
      const root = path.join(__dirname, '..', '..')
      const child = spawn(
        process.execPath,
        [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/cli/network.test.ts', '--reporter=json', `--outputFile=${report}`],
        { cwd: root, env, stdio: 'ignore' },
      )
      try {
        const code = await new Promise<number | null>((resolve) => child.once('exit', (ended) => resolve(ended)))
        const tests = (
          JSON.parse(readFileSync(report, 'utf8')) as { testResults: { assertionResults: { title: string; status: string }[] }[] }
        ).testResults.flatMap((file) => file.assertionResults)
        const how = (status: string) => tests.filter((one) => one.status === status).map((one) => one.title)
        // Every test that was run passed: among them the look, after each, at whether its It had opened its door to the network
        expect([code, how('failed')]).toEqual([0, []])
        // Each of the tests that turn the network on was left out, and the others were run
        expect(TURN_IT_ON.length).toBeGreaterThan(0)
        expect(TURN_IT_ON.filter((name) => how('passed').includes(name))).toEqual([])
        expect(TURN_IT_ON.filter((name) => !tests.some((one) => one.title === name))).toEqual([])
        expect(how('passed').length).toBeGreaterThan(8)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
