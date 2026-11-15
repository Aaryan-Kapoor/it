import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// What `it https on` asks of Tailscale, against a stand-in for Tailscale's command that writes
// down each thing it is asked and answers from files the test writes: where a Funnel stands in
// the way it changes nothing, and where it cannot confirm afterwards that none does, it takes
// away the two entries it made, and only those.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { funnelOff, servedNow, tailscaleRun, turnHttpsOn } from './src/https'
import { inspectFunnel, type System } from './src/serve/tailnet'

const NAME = 'studio.tail1234.ts.net'
const PORTS = [
  { port: 5130, at: 5132 },
  { port: 5131, at: 5133 },
]

describe.skipIf(process.platform === 'win32')('it https on, against a stand-in Tailscale', () => {
  let dir = ''
  let system: System = { platform: 'linux', env: {} }
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'it-https-'))
    system = { platform: 'linux', env: { PATH: dir }, root: dir }
    // It serves what it was told to with `serve --bg`, which it keeps in `made`, and takes away
    // what it was told to with `serve --https=<port> off`; `status` is what it says it serves
    // where it was told to serve nothing; `status.<n>`, what it says the nth time it is asked;
    // `slow.<n>`, that it takes three seconds to say it the nth time; `fail-bg.<port>` and
    // `fail-off.<port>`, that it refuses to serve on that port, or to stop serving there
    writeFileSync(
      path.join(dir, 'tailscale'),
      `#!/bin/sh
cd '${dir}'
printf '%s\\n' "$*" >> calls
touch made
if [ "$1 $2" = "serve status" ]; then
  n=$(($(cat asked 2>/dev/null || echo 0) + 1)); echo $n > asked
  [ -f slow.$n ] && sleep 3
  if [ -f status.$n ]; then cat status.$n; exit 0; fi
  if [ -s made ]; then
    tcp=''; web=''
    while read at port; do
      tcp="$tcp\${tcp:+,}\\"$at\\":{\\"HTTPS\\":true}"
      web="$web\${web:+,}\\"${NAME}:$at\\":{\\"Handlers\\":{\\"/\\":{\\"Proxy\\":\\"http://127.0.0.1:$port\\"}}}"
    done < made
    printf '{"TCP":{%s},"Web":{%s}}' "$tcp" "$web"
  else cat status; fi
  exit 0
fi
if [ "$2" = "--bg" ]; then
  at=\${3#--https=}; [ -f fail-bg.$at ] && { echo "refused" >&2; exit 1; }
  echo "$at \${4##*:}" >> made; exit 0
fi
at=\${2#--https=}; [ -f fail-off.$at ] && { echo "refused" >&2; exit 1; }
grep -v "^$at " made > made.next; mv made.next made
exit 0
`,
      { mode: 0o700 },
    )
    writeFileSync(path.join(dir, 'status'), '')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const said = (file: string, text: string) => writeFileSync(path.join(dir, file), text)
  const calls = () => (existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : [])
  const on = () => turnHttpsOn(NAME, PORTS, tailscaleRun(system), (ports) => inspectFunnel(ports, system, 1000))
  const refused = async () => {
    try {
      await on()
    } catch (err) {
      return err as { code?: string; message: string; hint?: string }
    }
    throw new Error('it https on did not refuse')
  }
  const BOTH = ['serve --bg --https=5132 http://127.0.0.1:5130', 'serve --bg --https=5133 http://127.0.0.1:5131']

  test('with nothing served, empty or null, it sets up its two entries and confirms that no Funnel reaches It', async () => {
    for (const nothing of ['', 'null', '{}']) {
      said('status', nothing)
      for (const file of ['calls', 'asked', 'made']) rmSync(path.join(dir, file), { force: true })
      await on()
      expect(calls()).toEqual(['serve status --json', ...BOTH, 'serve status --json'])
    }
  })

  test('a public Funnel to It is refused with its port and the command that turns it off, and nothing is changed', async () => {
    said(
      'status',
      JSON.stringify({
        AllowFunnel: { [`${NAME}:443`]: true },
        TCP: { '443': { HTTPS: true } },
        Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://[::ffff:127.0.0.1]:5131' } } } },
      }),
    )
    const problem = await refused()
    expect(problem.code).toBe('funnel_public')
    expect(problem.message).toBe('Tailscale Funnel makes It public on port 443, so https was not turned on.')
    expect(problem.hint).toBe('Turn that Funnel off with `tailscale funnel --https=443 off`, then run `it https on` again.')
    expect(calls()).toEqual(['serve status --json'])
  })

  test('a Funnel that may reach It is refused before anything is changed', async () => {
    said('status', JSON.stringify({ AllowFunnel: { [`${NAME}:443`]: true }, TCP: { '443': { TCPForward: 'nas.lan:5130', TerminateTLS: NAME } } }))
    expect((await refused()).code).toBe('funnel_unconfirmed')
    expect(calls()).toEqual(['serve status --json'])
  })

  test('a status It cannot read is refused before anything is changed', async () => {
    for (const unreadable of ['not json', '[]', '"text"']) {
      said('status', unreadable)
      rmSync(path.join(dir, 'calls'), { force: true })
      const problem = await refused()
      expect(problem.code, unreadable).toBe('tailscale')
      expect(problem.message).toContain('form It cannot read')
      expect(calls()).toEqual(['serve status --json'])
    }
  })

  const UNDONE = ['serve status --json', 'serve --https=5132 off', 'serve --https=5133 off']

  test('where Tailscale is slow to confirm afterwards, the two entries just made are taken away, and nothing else', async () => {
    said('slow.2', '')
    const problem = await refused()
    expect(problem.code).toBe('funnel_unconfirmed')
    expect(problem.message).toContain('took away what it had just set up')
    expect(calls()).toEqual(['serve status --json', ...BOTH, 'serve status --json', ...UNDONE])
    expect(readFileSync(path.join(dir, 'made'), 'utf8')).toBe('')
  })

  test('where a Funnel reaches It afterwards, or what Tailscale says cannot be read, the entries are taken away too', async () => {
    said(
      'status.2',
      JSON.stringify({
        AllowFunnel: { [`${NAME}:5132`]: true },
        TCP: { '5132': { HTTPS: true } },
        Web: { [`${NAME}:5132`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5130' } } } },
      }),
    )
    expect((await refused()).code).toBe('funnel_public')
    expect(calls().slice(-3)).toEqual(UNDONE)
    for (const file of ['calls', 'asked', 'made']) rmSync(path.join(dir, file), { force: true })
    said('status.2', 'garbage')
    expect((await refused()).code).toBe('funnel_unconfirmed')
    expect(calls().slice(-3)).toEqual(UNDONE)
  })

  test('an entry that was It’s already is kept, and only the one made now is taken away', async () => {
    said('made', '5132 5130\n')
    said('status.2', 'garbage')
    await refused()
    expect(calls()).toEqual(['serve status --json', BOTH[1], 'serve status --json', 'serve status --json', 'serve --https=5133 off'])
    expect(readFileSync(path.join(dir, 'made'), 'utf8')).toBe('5132 5130\n')
  })

  test('an entry another program changed while It was confirming is that program’s, and is left as it is', async () => {
    said('status.2', 'garbage')
    said(
      'status.3',
      JSON.stringify({
        TCP: { '5132': { HTTPS: true }, '5133': { HTTPS: true } },
        Web: {
          [`${NAME}:5132`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } },
          [`${NAME}:5133`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5131' } } },
        },
      }),
    )
    expect((await refused()).code).toBe('funnel_unconfirmed')
    expect(calls().slice(-2)).toEqual(['serve status --json', 'serve --https=5133 off'])
  })

  test('where what Tailscale serves cannot be read again, nothing is taken away, and it says what Tailscale may still serve', async () => {
    said('slow.2', '')
    said('status.3', 'garbage')
    const left = await refused()
    expect(left.code).toBe('tailscale')
    expect(left.message).toBe(
      'It could not take away what it had just set up, so Tailscale may still serve https for It on port 5132 and 5133. https is not turned on in It’s settings.',
    )
    expect(calls().filter((call) => call.endsWith(' off'))).toEqual([])
  })

  test('where the second entry is refused, the first is taken away, and where an entry cannot be taken away it says so', async () => {
    said('fail-bg.5133', '')
    const problem = await refused()
    expect(problem.code).toBe('tailscale')
    expect(problem.message).toContain('would not serve https on port 5133')
    expect(calls()).toEqual(['serve status --json', ...BOTH, 'serve status --json', 'serve --https=5132 off'])
    for (const file of ['fail-bg.5133', 'calls', 'asked', 'made']) rmSync(path.join(dir, file), { force: true })
    said('slow.2', '')
    said('fail-off.5133', '')
    const left = await refused()
    expect(left.code).toBe('tailscale')
    expect(left.message).toBe(
      'It could not take away what it had just set up, so Tailscale may still serve https for It on port 5133. https is not turned on in It’s settings.',
    )
    expect(left.hint).toContain('`it https on` again')
  })
})

test('the command that turns a Funnel off is the one for its kind of listener, and a foreground Funnel has none', () => {
  const allowed = (at: number) => ({ AllowFunnel: { [`${NAME}:${at}`]: true } })
  expect(funnelOff({ ...allowed(443), TCP: { '443': { HTTPS: true } } }, 443)).toBe('tailscale funnel --https=443 off')
  expect(funnelOff({ ...allowed(80), TCP: { '80': { HTTP: true } } }, 80)).toBe('tailscale funnel --http=80 off')
  expect(funnelOff({ ...allowed(8443), TCP: { '8443': { TCPForward: '127.0.0.1:5130', TerminateTLS: NAME } } }, 8443)).toBe(
    'tailscale funnel --tls-terminated-tcp=8443 off',
  )
  expect(funnelOff({ ...allowed(10000), TCP: { '10000': { TCPForward: '127.0.0.1:5130' } } }, 10000)).toBe('tailscale funnel --tcp=10000 off')
  expect(funnelOff({ Foreground: { s: { ...allowed(443), TCP: { '443': { HTTPS: true } } } } }, 443)).toBeUndefined()
})

test('nothing served, as Tailscale prints it, is read as nothing served', () => {
  for (const out of ['', '  \n', 'null'])
    expect(
      servedNow(() => ({ ok: true, out, err: '' })),
      JSON.stringify(out),
    ).toEqual({})
  expect(() => servedNow(() => ({ ok: false, out: '', err: 'failed to connect' }))).toThrow(/would not say what it serves/)
})
