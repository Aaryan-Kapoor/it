// Whether It runs inside WSL, and what a person is told of its background service there.
import { describe, expect, test } from 'vitest'
import { inWsl, wslSaid } from './src/service'

describe('a Linux inside WSL', () => {
  test('is told by the distribution WSL names, or by the kernel WSL runs, and only on Linux', () => {
    expect(inWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '6.6.87.2-generic')).toBe(true)
    expect(inWsl('linux', {}, '6.6.87.2-microsoft-standard-WSL2')).toBe(true)
    expect(inWsl('linux', {}, '6.8.0-49-generic')).toBe(false)
    expect(inWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' }, '10.0.26200')).toBe(false)
    expect(inWsl('darwin', {}, '24.1.0')).toBe(false)
  })

  test('is told that Windows stops it with its last window, and that one window has to stay open, by the distribution’s name where it is a plain one', () => {
    expect(wslSaid({ WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toBe(
      'This Linux runs in WSL, and Windows stops it, and It with it, within a minute of its last window closing. Keep one Ubuntu-24.04 window open while you use It: opening one again brings It back.',
    )
    expect(wslSaid({})).toContain('Keep one WSL window open')
    // A name that is not a plain one is not repeated
    expect(wslSaid({ WSL_DISTRO_NAME: 'x`$(rm)`' })).toContain('Keep one WSL window open')
  })
})
