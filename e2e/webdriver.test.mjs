// The deadline of each request e2e/safari.mjs makes of a WebDriver driver: it covers the answer's
// body as well as its headers, so that a driver that stops partway cannot hold a wait past it.
import http from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { webdriver } from './webdriver.mjs'

const servers = []
/** A stand-in driver on a port of its own, answering each request as `answer` does. */
async function driverThat(answer) {
  const server = http.createServer(answer)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return webdriver(`http://127.0.0.1:${server.address().port}`)
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('a request to a WebDriver driver', () => {
  test('gives up at its deadline on an answer whose body stops partway', async () => {
    // The headers and the start of the body come at once, and the rest never does
    const ask = await driverThat((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"value":')
    })
    const begun = Date.now()
    await expect(ask('GET', '/session/abc/screenshot', undefined, { ms: 200 })).rejects.toThrow('GET /session/…/screenshot: no whole answer within 0.2 s')
    expect(Date.now() - begun).toBeLessThan(2000)
  })

  test('gives up at its deadline on a driver that never answers at all', async () => {
    const ask = await driverThat(() => {})
    const begun = Date.now()
    await expect(ask('POST', '/session', {}, { ms: 200 })).rejects.toThrow('no whole answer within 0.2 s')
    expect(Date.now() - begun).toBeLessThan(2000)
  })

  test('is not made when no time is left for it', async () => {
    let asked = 0
    const ask = await driverThat((_req, res) => {
      asked++
      res.end('{"value":null}')
    })
    await expect(ask('GET', '/status', undefined, { ms: 0 })).rejects.toThrow('no time was left')
    expect(asked).toBe(0)
  })

  test('resolves with the value of a whole answer, and throws with the driver’s words for a refusal', async () => {
    const ask = await driverThat((req, res) => {
      if (req.url === '/status') return res.end('{"value":{"ready":true}}')
      res.writeHead(404).end('{"value":{"error":"no such window"}}')
    })
    await expect(ask('GET', '/status')).resolves.toEqual({ ready: true })
    await expect(ask('GET', '/session/abc/window')).rejects.toThrow('GET /session/…/window: 404 {"error":"no such window"}')
  })
})
