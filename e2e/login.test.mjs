// How a second machine joins the stack's It in a run (e2e/login.mjs): an invite is asked for
// as the machine It runs on, and the program is run with it in the second machine's folder.
// Nothing here joins anything: the backend, the first machine's token and the program are all
// stand-ins.
import { describe, expect, test } from 'vitest'
import { inviteMachine, join } from './login.mjs'
import { redact } from './logs.mjs'

describe('an invite for a machine', () => {
  test('is asked of the backend as the machine It runs on, and the code it answers with is noted as a credential', async () => {
    const asked = []
    const code = 'abcdefghijklmnopqrst'
    const made = await inviteMachine({
      home: '/tmp/the-first-machine',
      token: async (home) => `token-of ${home}`,
      asked: async (...how) => {
        asked.push(how)
        return { ok: true, value: { code, expiresAt: 1 } }
      },
    })
    expect(made).toBe(code)
    expect(asked).toEqual([['mutation', 'sessions:inviteMachine', {}, 'token-of /tmp/the-first-machine']])
    expect(redact(`joining with ${code}`)).not.toContain(code)
  })

  test('one the backend refuses, or answers with no code, is a failure that says which', async () => {
    const token = async () => 'a-token'
    await expect(inviteMachine({ home: '/tmp/x', token, asked: async () => ({ ok: false, code: 'forbidden' }) })).rejects.toThrow(
      'no invite was made for a machine (forbidden)',
    )
    await expect(inviteMachine({ home: '/tmp/x', token, asked: async () => ({ ok: true, value: {} }) })).rejects.toThrow('the answer held no code')
  })

  test('one It says to try again shortly for is asked for again, until there is a code or it has been asked six times', async () => {
    const token = async () => 'a-token'
    let times = 0
    const thirdTime = async () => (++times < 3 ? { ok: false, code: 'rate_limited' } : { ok: true, value: { code: 'made-at-the-third-asking' } })
    expect(await inviteMachine({ home: '/tmp/x', token, asked: thirdTime, wait: 1 })).toBe('made-at-the-third-asking')
    expect(times).toBe(3)
    times = 0
    const never = async () => {
      times += 1
      return { ok: false, code: 'rate_limited' }
    }
    await expect(inviteMachine({ home: '/tmp/x', token, asked: never, wait: 1 })).rejects.toThrow('no invite was made for a machine (rate_limited)')
    expect(times).toBe(6)
  })
})

describe('joining a machine', () => {
  test('runs the program in the machine’s own folder with the stack’s door and the invite, without setting anything up, and gives back what it answered', async () => {
    const ran = []
    const run = async (...how) => {
      ran.push(how)
      return { machine: 'j57abc', name: 'a name' }
    }
    const joined = await join('/tmp/a-second-machine', 'a name', { run, invite: async () => 'the-invite', at: 'http://localhost:20000' })
    expect(joined).toEqual({ machine: 'j57abc', name: 'a name' })
    expect(ran).toEqual([['/tmp/a-second-machine', ['login', '--url', 'http://localhost:20000', '--code', 'the-invite', '--name', 'a name', '--no-setup']]])
  })

  test('with no invite to be had, the program is not run, and why is passed on', async () => {
    let ran = 0
    const run = async () => {
      ran += 1
    }
    const invite = async () => {
      throw new Error('no invite was made for a machine (rate_limited)')
    }
    await expect(join('/tmp/a-second-machine', 'a name', { run, invite, at: 'http://localhost:20000' })).rejects.toThrow('rate_limited')
    expect(ran).toBe(0)
  })

  test('a machine the program could not join is the failure that is passed on', async () => {
    const run = async () => {
      throw Object.assign(new Error('That invite is wrong, used or out of date.'), { code: 'unauthenticated' })
    }
    await expect(join('/tmp/a-second-machine', 'a name', { run, invite: async () => 'the-invite', at: 'http://localhost:20000' })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })
})
