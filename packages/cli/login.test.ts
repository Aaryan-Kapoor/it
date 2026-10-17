import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { joinedBefore, login } from './src/login'
import { type Held, holdBase } from './test-ports'

describe('joining when a previous identity has already been replaced', () => {
  let folder: string
  let held: Held
  let server: http.Server
  let at: string
  let answer: { machine: string; waitsFor?: unknown }

  beforeEach(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-login-'))
    vi.stubEnv('IT_HOME', folder)
    held = await holdBase(57_000, 10)
    at = `http://127.0.0.1:${held.base}`
    answer = { machine: 'new-machine' }
    server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const body = req.url === '/cli/config' ? { issuer: at, protocol: PROTOCOL_VERSION } : answer
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => server.listen(held.base, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await held?.release()
    vi.unstubAllEnvs()
    rmSync(folder, { recursive: true, force: true })
  })

  test('keeps the name of the earlier machine that still holds its pages when joining succeeds', async () => {
    answer.waitsFor = 'the earlier laptop'
    expect(await login({ url: at, code: 'a test invite', name: 'this laptop' })).toEqual({
      machine: 'new-machine',
      name: 'this laptop',
      waitsFor: 'the earlier laptop',
    })
    expect(existsSync(path.join(folder, 'machine.json'))).toBe(true)
  })

  test('says nothing of an earlier machine where the answer names none', async () => {
    expect(await login({ url: at, code: 'a test invite', name: 'this laptop' })).toEqual({ machine: 'new-machine', name: 'this laptop' })
  })

  test('takes no earlier machine name from an answer whose field is not a name', async () => {
    answer.waitsFor = { name: 'the earlier laptop' }
    expect(await login({ url: at, code: 'a test invite', name: 'this laptop' })).toEqual({ machine: 'new-machine', name: 'this laptop' })
  })

  test('says which earlier machine keeps the pages and how to bring them to this computer', () => {
    expect(joinedBefore('the earlier laptop')).toBe(
      'This computer joined before as "the earlier laptop", which is still among your machines, and the pages it made then stay with that one. Revoke "the earlier laptop" on the site\'s Machines page and they come to this computer.',
    )
  })
})
