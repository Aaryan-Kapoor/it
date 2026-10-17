import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ServiceNotice } from './service'

let session: { role: string; service?: { functions: string } } = { role: 'owner' }
vi.mock('./session', () => ({ useSession: () => session }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
const root = createRoot(host)
afterEach(async () => {
  await act(async () => root.render(null))
})

test('the owner sees recovery advice and a screen gets only the safe explanation', async () => {
  session = { role: 'owner', service: { functions: 'retained' } }
  await act(async () => root.render(createElement(ServiceNotice)))
  expect(host.textContent).toContain('older backend functions')
  expect(host.textContent).toContain('it status')
  expect(host.textContent).toContain('it service logs')
  session = { role: 'screen', service: { functions: 'retained' } }
  await act(async () => root.render(createElement(ServiceNotice)))
  expect(host.textContent).toContain('older backend functions')
  expect(host.textContent).toContain('owner browser')
  expect(host.textContent).not.toContain('it service logs')
  for (const service of [undefined, { functions: 'current' }]) {
    session = { role: 'owner', service }
    await act(async () => root.render(createElement(ServiceNotice)))
    expect(host.textContent).toBe('')
  }
})
