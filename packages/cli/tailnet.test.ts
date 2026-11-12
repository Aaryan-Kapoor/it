import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
// Keeping It to a person's tailnet: which addresses are a tailnet's, which of this machine's
// are, what its name there is, and that the addresses another device is given are those alone.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reachable } from './src/serve/network'
import {
  daemonDown,
  forgetFunnel,
  forgetTailnetName,
  funnelNow,
  funnelPorts,
  funnelSaid,
  inspectFunnel,
  inTailnet,
  isLoopback,
  type System,
  servedAs,
  tailnetAddresses,
  tailnetName,
  tailscaleCommand,
  tailscaleDaemon,
  tailscalePlaces,
  thisMachine,
} from './src/serve/tailnet'

const HERE = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4' as const, internal: true },
    { address: '::1', family: 'IPv6' as const, internal: true },
  ],
  eth0: [
    { address: '192.168.1.20', family: 'IPv4' as const, internal: false },
    { address: '2001:db8:100:c690::4f1a', family: 'IPv6' as const, internal: false },
  ],
  tailscale0: [
    { address: 'fd7a:115c:a1e0::ab12:4843', family: 'IPv6' as const, internal: false },
    { address: '100.101.42.17', family: 'IPv4' as const, internal: false },
  ],
  docker0: [{ address: '172.17.0.1', family: 'IPv4' as const, internal: false }],
}

afterEach(forgetTailnetName)

describe('a tailnet’s addresses', () => {
  test('are the two ranges a tailnet gives out of, however one is written, and nothing beside them', () => {
    for (const address of [
      '100.64.0.1',
      '100.101.42.17',
      '100.127.255.254',
      '::ffff:100.100.1.2',
      'fd7a:115c:a1e0::1',
      '[fd7a:115c:a1e0:ab12::7]',
      'FD7A:115C:A1E0::9',
    ])
      expect(inTailnet(address), address).toBe(true)
    for (const address of [
      '100.63.255.255',
      '100.128.0.1',
      '10.0.0.20',
      '192.168.1.20',
      '127.0.0.1',
      '::1',
      'fd7a:115c:a1e1::1',
      '2001:db8:100::1',
      '',
      'localhost',
    ])
      expect(inTailnet(address), address).toBe(false)
  })

  test('this machine itself is told from every other caller', () => {
    for (const address of ['127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1', '[::1]']) expect(isLoopback(address), address).toBe(true)
    for (const address of ['100.101.42.17', '10.0.0.1', '::', '1.127.0.0', '']) expect(isLoopback(address), address).toBe(false)
  })

  test('the machine’s own are found whatever its interfaces are called, IPv4 first, and none where it is on no tailnet', () => {
    expect(tailnetAddresses(HERE)).toEqual(['100.101.42.17', 'fd7a:115c:a1e0::ab12:4843'])
    // By the address and not by the interface's name, which each system gives differently
    expect(tailnetAddresses({ utun4: HERE.tailscale0 })).toEqual(['100.101.42.17', 'fd7a:115c:a1e0::ab12:4843'])
    expect(tailnetAddresses({ lo: HERE.lo, eth0: HERE.eth0 })).toEqual([])
  })
})

describe('the machine’s name on its tailnet', () => {
  test('is what Tailscale says it is, without the dot it ends with, and is asked once and kept a while', () => {
    let asked = 0
    const says = () => {
      asked++
      return JSON.stringify({ Self: { DNSName: 'Studio.tail1234.ts.net.' } })
    }
    expect(tailnetName(says)).toBe('studio.tail1234.ts.net')
    expect(tailnetName(says)).toBe('studio.tail1234.ts.net')
    expect(asked).toBe(1)
  })

  test('is nothing where Tailscale is not there to say, or says what is no name', () => {
    expect(
      tailnetName(() => {
        throw new Error('not found')
      }),
    ).toBeUndefined()
    for (const said of ['not json', '{}', '{"Self":{"DNSName":""}}', '{"Self":{"DNSName":"a name with spaces.ts.net"}}', '{"Self":{"DNSName":"<script>"}}']) {
      forgetTailnetName()
      expect(
        tailnetName(() => said),
        said,
      ).toBeUndefined()
    }
  })
})

describe('where another device is told to open It', () => {
  test('kept to the tailnet, it is the machine’s name there first, then its addresses there, and nothing of any other network', () => {
    expect(reachable(4700, HERE, true, () => 'studio.tail1234.ts.net')).toEqual([
      'http://studio.tail1234.ts.net:4700',
      'http://100.101.42.17:4700',
      'http://[fd7a:115c:a1e0::ab12:4843]:4700',
    ])
    // Without a name to give, the addresses alone
    expect(reachable(4700, HERE, true, () => undefined)).toEqual(['http://100.101.42.17:4700', 'http://[fd7a:115c:a1e0::ab12:4843]:4700'])
    expect(reachable(4700, { lo: HERE.lo, eth0: HERE.eth0 }, true, () => undefined)).toEqual([])
  })

  test('on for the network the machine is on, the home network’s address still comes first and the tailnet’s after it, an address of the internet’s is left out, and the name is not asked for', () => {
    const named = () => {
      throw new Error('asked')
    }
    expect(reachable(4700, HERE, false, named)).toEqual(['http://192.168.1.20:4700', 'http://100.101.42.17:4700', 'http://[fd7a:115c:a1e0::ab12:4843]:4700'])
    // Open to the internet too, it is given among them
    expect(reachable(4700, HERE, false, named, true)).toEqual([
      'http://192.168.1.20:4700',
      'http://100.101.42.17:4700',
      'http://[2001:db8:100:c690::4f1a]:4700',
      'http://[fd7a:115c:a1e0::ab12:4843]:4700',
    ])
  })
})

describe('what Tailscale serves on It’s ports', () => {
  const NAME = 'studio.tail1234.ts.net'
  /** What \`tailscale serve status --json\` says, as Tailscale 1.104 writes it, with It's two ports and another program's beside them. */
  const status = {
    TCP: { '4702': { HTTPS: true }, '4703': { HTTPS: true }, '8443': { HTTPS: true }, '33000': { TCPForward: '127.0.0.1:33000' }, '8080': { HTTP: true } },
    Web: {
      [`${NAME}:4702`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700' } } },
      [`${NAME}:4703`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4701' } } },
      [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4321' } } },
      [`${NAME}:8080`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } },
    },
  }

  test('a port is It’s own only where Tailscale takes https there and hands all of it to It’s own port on this machine', () => {
    expect([servedAs(status, NAME, 4702, 4700), servedAs(status, NAME, 4703, 4701)]).toEqual(['its', 'its'])
    // Handed to another port than the one it stands for, it is not what It set up
    expect(servedAs(status, NAME, 4702, 4701)).toBe('other')
    expect(servedAs(status, NAME, 4802, 4800)).toBe('free')
    expect(servedAs({}, NAME, 4702, 4700)).toBe('free')
    expect(servedAs(null, NAME, 4702, 4700)).toBe('free')
  })

  test('anything else on the port is another program’s, and is not taken from it: another address, a plain forward, plain http, or more than one path', () => {
    expect(servedAs(status, NAME, 8443, 8441)).toBe('other')
    expect(servedAs(status, NAME, 33000, 32998)).toBe('other')
    expect(servedAs(status, NAME, 8080, 8078)).toBe('other')
    const split = { ...status, Web: { [`${NAME}:4702`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700' }, '/admin': { Proxy: 'http://127.0.0.1:9' } } } } }
    expect(servedAs(split, NAME, 4702, 4700)).toBe('other')
    // Served at another of the machine's names, it is not what It set up
    expect(servedAs(status, 'other.tail1234.ts.net', 4702, 4700)).toBe('other')
  })
})

test('Funnel detection follows public proxies to It even on another listener', () => {
  const status = {
    AllowFunnel: { 'studio.ts.net:443': true, 'studio.ts.net:8443': false },
    Web: { 'studio.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5130' } } } },
  }
  expect(funnelPorts(status, [5130, 5131])).toEqual([443])
  expect(funnelPorts(status, [5140, 5141])).toEqual([])
  expect(funnelPorts(null, [5130])).toEqual([])
})

test('Foreground Funnels and URL paths still expose It', () => {
  for (const path of ['/', '/pair']) {
    const config = {
      AllowFunnel: { 'studio.ts.net:443': true },
      Web: { 'studio.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:5130${path}` } } } },
    }
    expect(funnelPorts({ Foreground: { session: config } }, [5130])).toEqual([443])
    expect(funnelPorts({ ...config, Foreground: { session: config } }, [5130])).toEqual([443])
  }
})

test('Funnel inspection only asks the stand-in Tailscale for status and preserves failures', async () => {
  if (process.platform === 'win32') return
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-funnel-'))
  const original = process.env.PATH
  try {
    process.env.PATH = `${dir}:${original}`
    const log = path.join(dir, 'calls')
    const command = path.join(dir, 'tailscale')
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s' '{"AllowFunnel":{"studio.ts.net:443":true},"Web":{"studio.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5130/pair"}}}}}'\n`,
      { mode: 0o700 },
    )
    expect(await inspectFunnel([5130, 5131])).toEqual([443])
    expect(readFileSync(log, 'utf8')).toBe('serve status --json\n')
    writeFileSync(command, '#!/bin/sh\necho invalid-json\n', { mode: 0o700 })
    expect(await inspectFunnel([5130])).toBeUndefined()
    writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    expect(await inspectFunnel([5130])).toBeUndefined()
  } finally {
    process.env.PATH = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A Funnel warning is said beside what is said of the network, and never instead of it', () => {
  const said = 'The network is off, so It answers this machine only.'
  expect(funnelSaid('unknown', said)).toBe(
    `It could not check Tailscale Funnel. Check Tailscale before relying on the network setting to keep It private.\n${said}`,
  )
  expect(funnelSaid('public', said)).toBe(
    `Tailscale Funnel makes It public, even with the network off. Turn off the Funnel in Tailscale to keep It private.\n${said}`,
  )
  expect(funnelSaid('off', said)).toBe(said)
  expect(funnelSaid(undefined, said)).toBe(said)
})

describe('which Funnel forwards reach It', () => {
  // This machine, as the fixture's interfaces and a host name of its own make it
  const here = thisMachine({ ...HERE, eth1: [{ address: 'fe80::5555:6666:777:8888', family: 'IPv6', internal: false }] }, 'studio')
  const NAME = 'studio.tail1234.ts.net'
  const web = (target: unknown, listener = 443) => ({
    AllowFunnel: { [`${NAME}:${listener}`]: true },
    TCP: { [String(listener)]: { HTTPS: true } },
    Web: { [`${NAME}:${listener}`]: { Handlers: { '/': { Proxy: target } } } },
  })
  const tcp = (target: unknown, tls: boolean, listener = 443) => ({
    AllowFunnel: { [`${NAME}:${listener}`]: true },
    TCP: { [String(listener)]: { TCPForward: target, ...(tls ? { TerminateTLS: NAME } : {}) } },
  })

  test('every address and name of this machine reaches It, at either of its ports, over http, https or TCP, with or without TLS ended first', () => {
    const hosts = [
      '127.0.0.1',
      '127.5.6.7',
      '127.1',
      'localhost',
      'LocalHost.',
      'app.localhost',
      'localhost.localdomain',
      'ip6-localhost',
      'ip6-loopback',
      '[::1]',
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::FFFF:127.9.9.9]',
      '[0:0:0:0:0:ffff:7f00:1]',
      '0.0.0.0',
      '[::]',
      '[::ffff:0.0.0.0]',
      '192.168.1.20',
      '100.101.42.17',
      '172.17.0.1',
      '[fd7a:115c:a1e0::ab12:4843]',
      '[FD7A:115C:A1E0:0::AB12:4843]',
      '[2001:db8:100:c690::4f1a]',
      '[fe80::5555:6666:777:8888%eth1]',
      'studio',
      'studio.local',
      NAME,
    ]
    for (const host of hosts)
      for (const port of [5130, 5131]) {
        for (const scheme of ['http', 'https', 'https+insecure'])
          expect(funnelPorts(web(`${scheme}://${host}:${port}`), [5130, 5131], here), `${scheme} ${host}:${port}`).toEqual([443])
        for (const tls of [false, true]) expect(funnelPorts(tcp(`${host}:${port}`, tls), [5130, 5131], here), `tcp ${host}:${port} ${tls}`).toEqual([443])
        expect(funnelPorts(tcp(`tcp://${host}:${port}`, true), [5130, 5131], here), `tcp:// ${host}:${port}`).toEqual([443])
      }
  })

  test('a proxy of a path, a mount below the root, a bare port and a scheme’s own port each reach It', () => {
    const mounted = {
      AllowFunnel: { [`${NAME}:8443`]: true },
      Web: { [`${NAME}:8443`]: { Handlers: { '/files': { Path: '/srv/files' }, '/it': { Proxy: 'http://127.0.0.1:5131/v/1/' } } } },
    }
    expect(funnelPorts(mounted, [5130, 5131], here)).toEqual([8443])
    expect(funnelPorts(web('http://127.0.0.1:5130/pair?x=1#y', 10000), [5130, 5131], here)).toEqual([10000])
    expect(funnelPorts(web('5130'), [5130, 5131], here)).toEqual([443])
    expect(funnelPorts(web('http://user@127.0.0.1:5130'), [5130, 5131], here)).toEqual([443])
    expect(funnelPorts(web('http://localhost'), [80, 81], here)).toEqual([443])
    expect(funnelPorts(web('https://localhost/'), [443, 444], here)).toEqual([443])
    expect(funnelPorts(tcp('localhost:5130', true, 8443), [5130, 5131], here)).toEqual([8443])
  })

  test('a forward to another machine, another port, a Unix socket, or files is not It, and nor is a listener not open to the internet', () => {
    for (const target of [
      'http://192.168.1.99:5130',
      'http://10.0.0.1:5131',
      'http://[2001:db8::1]:5130',
      'http://[::ffff:192.168.1.99]:5130',
      'http://127.0.0.1:9999',
      'http://localhost',
      'http://nas.lan:9999',
      'unix:/var/run/app.sock',
    ])
      expect(funnelPorts(web(target), [5130, 5131], here), target).toEqual([])
    expect(funnelPorts(tcp('192.168.1.99:5130', false), [5130, 5131], here)).toEqual([])
    const files = { AllowFunnel: { [`${NAME}:443`]: true }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Path: '/srv' }, '/hi': { Text: 'hi' } } } } }
    expect(funnelPorts(files, [5130, 5131], here)).toEqual([])
    expect(funnelPorts({ ...web('http://127.0.0.1:5130'), AllowFunnel: { [`${NAME}:443`]: false } }, [5130, 5131], here)).toEqual([])
    expect(funnelPorts({}, [5130, 5131], here)).toEqual([])
  })

  test('a forward It cannot be sure of is unknown, never off, and one that is sure to reach It still says public', () => {
    for (const target of ['http://nas.lan:5130', 'https://example.com:5131', 'http://[zz::1]:5130', 'http://127.0.0.1:99999', 'http://', '', 42, null])
      expect(funnelPorts(web(target), [5130, 5131], here), String(target)).toBeUndefined()
    expect(funnelPorts(tcp('nas:5130', true), [5130, 5131], here)).toBeUndefined()
    // A TCP forward names its port: one with none cannot be read
    expect(funnelPorts(tcp('127.0.0.1', false), [5130, 5131], here)).toBeUndefined()
    const both = {
      AllowFunnel: { [`${NAME}:443`]: true, [`${NAME}:8443`]: true },
      Web: {
        [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://nas.lan:5130' } } },
        [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://[::ffff:127.0.0.1]:5130' } } },
      },
    }
    expect(funnelPorts(both, [5130, 5131], here)).toEqual([8443])
    expect(funnelPorts({ Foreground: { session: web('http://nas.lan:5131') } }, [5130, 5131], here)).toBeUndefined()
  })
})

describe('finding Tailscale on each system', () => {
  test('its command is looked for where each system’s installers put it', () => {
    expect(tailscalePlaces({ platform: 'linux', env: {} })).toEqual(['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'])
    expect(tailscalePlaces({ platform: 'darwin', env: {} })).toEqual([
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    ])
    expect(tailscalePlaces({ platform: 'win32', env: { ProgramFiles: 'D:\\Programs' } })).toEqual(['D:\\Programs\\Tailscale\\tailscale.exe'])
    expect(tailscalePlaces({ platform: 'win32', env: { PROGRAMFILES: 'E:\\P' } })).toEqual(['E:\\P\\Tailscale\\tailscale.exe'])
    expect(tailscalePlaces({ platform: 'win32', env: {} })).toEqual(['C:\\Program Files\\Tailscale\\tailscale.exe'])
  })

  describe.skipIf(process.platform === 'win32')('against stand-ins under a folder of the test’s own', () => {
    let root = ''
    const sockets: net.Server[] = []
    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'it-ts-'))
    })
    afterEach(async () => {
      await Promise.all(sockets.splice(0).map((server) => new Promise((done) => server.close(done))))
      rmSync(root, { recursive: true, force: true })
    })
    const place = (file: string, script = '#!/bin/sh\nexit 1\n', mode = 0o700) => {
      const at = `${root}${file}`
      mkdirSync(path.dirname(at), { recursive: true })
      writeFileSync(at, script)
      chmodSync(at, mode)
      return at
    }
    const listen = async (file: string) => {
      const at = `${root}${file}`
      mkdirSync(path.dirname(at), { recursive: true })
      const server = net.createServer()
      sockets.push(server)
      await new Promise<void>((done) => server.listen(at, done))
    }
    const linux = (): System => ({ platform: 'linux', env: { PATH: path.join(root, 'nothing') }, root })
    const FUNNEL = `#!/bin/sh\nprintf '%s' '{"AllowFunnel":{"studio.ts.net:443":true},"TCP":{"443":{"TCPForward":"[::ffff:127.0.0.1]:5130","TerminateTLS":"studio.ts.net"}}}'\n`

    test('on Linux, the command in /usr/bin, /usr/sbin or /usr/local/bin is found off PATH and asked, and PATH comes first', async () => {
      expect(tailscaleCommand(linux())).toBeUndefined()
      for (const dir of ['/usr/bin', '/usr/sbin', '/usr/local/bin']) {
        const at = place(`${dir}/tailscale`, FUNNEL)
        expect(tailscaleCommand(linux())).toBe(at)
        expect(await inspectFunnel([5130, 5131], linux())).toEqual([443])
        rmSync(at)
      }
      // A file there that cannot be run is not the command
      place('/usr/sbin/tailscale', FUNNEL, 0o600)
      expect(tailscaleCommand(linux())).toBeUndefined()
      const first = place('/home/someone/bin/tailscale')
      place('/usr/bin/tailscale', FUNNEL)
      expect(tailscaleCommand({ ...linux(), env: { PATH: `relative:${path.dirname(first)}` } })).toBe(first)
    })

    test('on macOS, the command inside Tailscale’s app and Homebrew’s are found off PATH', async () => {
      const mac = (): System => ({ platform: 'darwin', env: { PATH: path.join(root, 'nothing') }, root })
      for (const file of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
        const at = place(file, FUNNEL)
        expect(tailscaleCommand(mac())).toBe(at)
        expect(await inspectFunnel([5130, 5131], mac())).toEqual([443])
        rmSync(at)
      }
    })

    test('on Windows, the command in Program Files is found off PATH, as the environment names that folder', async () => {
      const windows = (): System => ({
        platform: 'win32',
        env: { Path: 'C:\\Windows\\System32', ProgramFiles: 'D:\\Apps' },
        root: `${root}/`,
        service: async () => false,
      })
      expect(tailscaleCommand(windows())).toBeUndefined()
      const at = place('/D:\\Apps\\Tailscale\\tailscale.exe', FUNNEL)
      expect(tailscaleCommand(windows())).toBe(at)
      expect(await inspectFunnel([5130, 5131], windows())).toEqual([443])
    })

    test('with no command anywhere, a running daemon makes the Funnel unknown: its socket on Linux, the app or its socket on macOS, the service on Windows', async () => {
      expect(await tailscaleDaemon(linux())).toBe(false)
      expect(await inspectFunnel([5130, 5131], linux())).toEqual([])
      for (const socket of ['/var/run/tailscale/tailscaled.sock', '/run/tailscale/tailscaled.sock', '/var/snap/tailscale/common/socket/tailscaled.sock']) {
        await listen(socket)
        expect(await tailscaleDaemon(linux()), socket).toBe(true)
        expect(await inspectFunnel([5130, 5131], linux()), socket).toBeUndefined()
        await new Promise((done) => sockets.pop()!.close(done))
      }
      // A plain file where the socket would be is no daemon
      place('/run/tailscale/tailscaled.sock', '')
      expect(await inspectFunnel([5130, 5131], linux())).toEqual([])

      let running: string[] | undefined = ['/sbin/launchd', '/usr/libexec/logd']
      const mac = (): System => ({ platform: 'darwin', env: { PATH: path.join(root, 'nothing') }, root, processes: async () => running })
      expect(await inspectFunnel([5130, 5131], mac())).toEqual([])
      await listen('/var/run/tailscaled.socket')
      expect(await inspectFunnel([5130, 5131], mac())).toBeUndefined()
      await new Promise((done) => sockets.pop()!.close(done))
      // Tailscale's app, the network extension of either of its apps, or the open-source daemon, running
      for (const program of [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        '/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension',
        '/Library/SystemExtensions/AB/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension',
        '/opt/homebrew/bin/tailscaled',
      ]) {
        running = ['/sbin/launchd', program]
        expect(await inspectFunnel([5130, 5131], mac()), program).toBeUndefined()
      }
      // And where the programs running cannot be listed, Tailscale is taken to be running
      running = undefined
      expect(await inspectFunnel([5130, 5131], mac())).toBeUndefined()

      const windows = (service: boolean): System => ({
        platform: 'win32',
        env: { Path: '', ProgramFiles: 'D:\\Apps' },
        root: `${root}/`,
        service: async () => service,
      })
      expect(await inspectFunnel([5130, 5131], windows(false))).toEqual([])
      expect(await inspectFunnel([5130, 5131], windows(true))).toBeUndefined()
    })

    test('a command found that cannot answer leaves the Funnel unknown', async () => {
      place('/usr/sbin/tailscale', '#!/bin/sh\necho "failed to connect to local tailscaled" >&2\nexit 1\n')
      expect(await inspectFunnel([5130, 5131], linux())).toBeUndefined()
    })
  })

  test.runIf(process.platform === 'win32')(
    'on Windows itself, the command is found in Program Files, and one that cannot run leaves the Funnel unknown',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'it-ts-'))
      try {
        const system: System = { platform: 'win32', env: { Path: '', ProgramFiles: dir }, service: async () => false }
        expect(await inspectFunnel([5130, 5131], system)).toEqual([])
        mkdirSync(path.join(dir, 'Tailscale'))
        writeFileSync(path.join(dir, 'Tailscale', 'tailscale.exe'), '')
        expect(tailscaleCommand(system)).toBe(path.join(dir, 'Tailscale', 'tailscale.exe'))
        expect(await inspectFunnel([5130, 5131], system)).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // CI's Windows machines have no Tailscale, which the system's own list of services says
  test.runIf(process.platform === 'win32' && process.env.CI === 'true')(
    'on Windows itself, a machine without the Tailscale service is said to have no daemon',
    async () => {
      expect(await tailscaleDaemon({ platform: 'win32', env: process.env })).toBe(false)
    },
  )
})

describe('a Tailscale that is there and not running', () => {
  test('is known by what its command says, on each system, where it looked for the daemon and found none', () => {
    for (const said of [
      "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)",
      "failed to connect to local tailscaled; it doesn't appear to be running",
      'failed to connect to local Tailscale service; is Tailscale running?',
      'failed to connect to local tailscaled process; is the Tailscale service running?',
      "failed to connect to local tailscaled process; it doesn't appear to be running",
    ])
      expect(daemonDown(said), said).toBe(true)
    for (const said of [
      'failed to connect to local tailscaled (which appears to be running as /usr/sbin/tailscaled, pid 812). Got error: connect: permission denied',
      'Access denied: serve config denied',
      '',
      'is Tailscale running?',
    ])
      expect(daemonDown(said), said).toBe(false)
  })

  test.skipIf(process.platform === 'win32')('makes the Funnel off, and a daemon that runs and cannot be reached leaves it unknown', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'it-ts-'))
    try {
      const system: System = { platform: 'linux', env: { PATH: root }, root }
      const command = path.join(root, 'tailscale')
      const says = (out: string, err: string, code: number) =>
        writeFileSync(command, `#!/bin/sh\nprintf '%s' '${out}'\nprintf '%s\\n' "${err}" >&2\nexit ${code}\n`, { mode: 0o700 })
      says('', "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)", 1)
      expect(await inspectFunnel([5130, 5131], system)).toEqual([])
      says('', 'failed to connect to local Tailscale service; is Tailscale running?', 1)
      expect(await inspectFunnel([5130, 5131], system)).toEqual([])
      says('', 'failed to connect to local tailscaled (which appears to be running as tailscaled, pid 9). Got error: refused', 1)
      expect(await inspectFunnel([5130, 5131], system)).toBeUndefined()
      // The command says the daemon is not running, and the system shows its socket: a daemon the
      // command could not see among the processes, as a system that hides other users' processes
      // has it, still runs the Funnels it was given
      const socket = path.join(root, 'run', 'tailscale', 'tailscaled.sock')
      mkdirSync(path.dirname(socket), { recursive: true })
      const daemon = net.createServer()
      await new Promise<void>((done) => daemon.listen(socket, done))
      try {
        says('', "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)", 1)
        expect(await inspectFunnel([5130, 5131], system)).toBeUndefined()
        // On Windows, where the service is not stopped; and on macOS, where Tailscale's programs run
        const windows: System = { platform: 'win32', env: { Path: root }, root: `${root}/`, service: async () => true }
        writeFileSync(`${root}/C:\\Program Files\\Tailscale\\tailscale.exe`, readFileSync(command), { mode: 0o700 })
        says('', 'failed to connect to local tailscaled process; is the Tailscale service running?', 1)
        writeFileSync(`${root}/C:\\Program Files\\Tailscale\\tailscale.exe`, readFileSync(command), { mode: 0o700 })
        expect(await inspectFunnel([5130, 5131], windows)).toBeUndefined()
        expect(await inspectFunnel([5130, 5131], { ...windows, service: async () => false })).toEqual([])
      } finally {
        await new Promise((done) => daemon.close(done))
      }
      // Nothing set up: Tailscale prints nothing, or null
      says('', '', 0)
      expect(await inspectFunnel([5130, 5131], system)).toEqual([])
      says('null', '', 0)
      expect(await inspectFunnel([5130, 5131], system)).toEqual([])
      says('[]', '', 0)
      expect(await inspectFunnel([5130, 5131], system)).toBeUndefined()
      // A command that does not answer in time is not taken for a stopped daemon, whatever it said first
      writeFileSync(command, `#!/bin/sh\necho "is Tailscale running?" >&2\nexec sleep 5\n`, { mode: 0o700 })
      expect(await inspectFunnel([5130, 5131], system, 300)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the service’s view of a Funnel', () => {
  afterEach(forgetFunnel)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('says nothing until Tailscale has first answered, and then what it answered', async () => {
    let answer: (found: number[] | undefined) => void = () => {}
    const asked: number[][] = []
    const inspect = (ports: number[]) => {
      asked.push(ports)
      return new Promise<number[] | undefined>((resolve) => {
        answer = resolve
      })
    }
    expect(funnelNow([5130, 5131], inspect)).toBeUndefined()
    expect(funnelNow([5130, 5131], inspect)).toBeUndefined()
    // One inspection at a time
    expect(asked).toHaveLength(1)
    answer([])
    await settle()
    expect(funnelNow([5130, 5131], inspect)).toBe('off')
    forgetFunnel()
    funnelNow([5130, 5131], inspect)
    answer(undefined)
    await settle()
    expect(funnelNow([5130, 5131], inspect)).toBe('unknown')
    forgetFunnel()
    funnelNow([5130, 5131], inspect)
    answer([443])
    await settle()
    expect(funnelNow([5130, 5131], inspect)).toBe('public')
  })

  test('asks less often while the answer stays the same, up to thirty seconds apart, and every five seconds again once it changes', async () => {
    const start = Date.now()
    let now = start
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let found: number[] = []
      const times: number[] = []
      const inspect = async () => {
        times.push(now - start)
        return found
      }
      // Looked at every second, as the service looks
      for (let second = 0; second <= 120; second++) {
        now = start + second * 1000
        if (second === 100) found = [443]
        funnelNow([5130, 5131], inspect)
        await settle()
      }
      const gaps = times.slice(1).map((at, i) => at - times[i]!)
      expect(gaps.slice(0, 4)).toEqual([6000, 11_000, 21_000, 31_000])
      // Changed at a hundred seconds: heard at the next asking, and asked five seconds after that
      const heard = times.findIndex((at) => at >= 100_000)
      expect(times[heard + 1]! - times[heard]!).toBe(6000)
      expect(funnelNow([5130, 5131], inspect)).toBe('public')
    } finally {
      clock.mockRestore()
    }
  })
})
