// What the background service is given when it is registered, and what is kept of it when it
// is registered again: checked on the definitions themselves, with no system asked to take one.
import { describe, expect, test } from 'vitest'
import { environment } from './src/service'

describe('what a service is given of the shell that registered it', () => {
  test('that the person’s shell is not to be asked is said to the service, which is what would ask it', () => {
    expect(environment({ PATH: '/bin', IT_SHELL_ENV: 'off' })).toEqual({ PATH: '/bin', IT_SHELL_ENV: 'off' })
  })
  test('that It is not to look for a newer version is not, since `it updates on` could then never turn it back on', () => {
    expect(environment({ PATH: '/bin', IT_UPDATE_CHECK: 'false' })).toEqual({ PATH: '/bin' })
  })
})
