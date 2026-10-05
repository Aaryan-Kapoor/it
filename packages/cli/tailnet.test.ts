// Keeping It to a person's tailnet: which addresses are a tailnet's, which of this machine's
// are, what its name there is, and that the addresses another device is given are those alone.
import { afterEach, describe, expect, test } from 'vitest'
import { reachable } from './src/serve/network'
import { forgetTailnetName, inTailnet, isLoopback, tailnetAddresses, tailnetName } from './src/serve/tailnet'

const HERE = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4' as const, internal: true },
    { address: '::1', family: 'IPv6' as const, internal: true },
  ],
  eth0: [
    { address: '192.168.1.20', family: 'IPv4' as const, internal: false },
    { address: '2601:cb:8100:c690::4f1a', family: 'IPv6' as const, internal: false },
  ],
  tailscale0: [
    { address: 'fd7a:115c:a1e0::cc01:2c98', family: 'IPv6' as const, internal: false },
    { address: '100.109.44.60', family: 'IPv4' as const, internal: false },
  ],
  docker0: [{ address: '172.17.0.1', family: 'IPv4' as const, internal: false }],
}

afterEach(forgetTailnetName)

describe('a tailnet’s addresses', () => {
  test('are the two ranges a tailnet gives out of, however one is written, and nothing beside them', () => {
    for (const address of [
      '100.64.0.1',
      '100.109.44.60',
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
      '10.0.0.74',
      '192.168.1.20',
      '127.0.0.1',
      '::1',
      'fd7a:115c:a1e1::1',
      '2601:cb:8100::1',
      '',
      'localhost',
    ])
      expect(inTailnet(address), address).toBe(false)
  })

  test('this machine itself is told from every other caller', () => {
    for (const address of ['127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1', '[::1]']) expect(isLoopback(address), address).toBe(true)
    for (const address of ['100.109.44.60', '10.0.0.1', '::', '1.127.0.0', '']) expect(isLoopback(address), address).toBe(false)
  })

  test('the machine’s own are found whatever its interfaces are called, IPv4 first, and none where it is on no tailnet', () => {
    expect(tailnetAddresses(HERE)).toEqual(['100.109.44.60', 'fd7a:115c:a1e0::cc01:2c98'])
    // By the address and not by the interface's name, which each system gives differently
    expect(tailnetAddresses({ utun4: HERE.tailscale0 })).toEqual(['100.109.44.60', 'fd7a:115c:a1e0::cc01:2c98'])
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
      'http://100.109.44.60:4700',
      'http://[fd7a:115c:a1e0::cc01:2c98]:4700',
    ])
    // Without a name to give, the addresses alone
    expect(reachable(4700, HERE, true, () => undefined)).toEqual(['http://100.109.44.60:4700', 'http://[fd7a:115c:a1e0::cc01:2c98]:4700'])
    expect(reachable(4700, { lo: HERE.lo, eth0: HERE.eth0 }, true, () => undefined)).toEqual([])
  })

  test('open to every network, the home network’s address still comes first and the tailnet’s after it, and the name is not asked for', () => {
    const named = () => {
      throw new Error('asked')
    }
    expect(reachable(4700, HERE, false, named)).toEqual([
      'http://192.168.1.20:4700',
      'http://100.109.44.60:4700',
      'http://[2601:cb:8100:c690::4f1a]:4700',
      'http://[fd7a:115c:a1e0::cc01:2c98]:4700',
    ])
  })
})
