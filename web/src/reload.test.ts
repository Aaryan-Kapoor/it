import { TAKES } from '@it/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { learnTakes } from './lib'
import { ReloadNotice } from './reload'

const query = vi.hoisted(() => vi.fn())
vi.mock('convex/react', () => ({ useQuery: (...args: unknown[]) => query(...args) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
beforeEach(() => {
  learnTakes([])
  query.mockReset()
  query.mockImplementation((_fn, args) => {
    if (args !== 'skip') throw new Error('Could not find public function artifacts:notLoaded')
    return undefined
  })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  learnTakes([])
  vi.restoreAllMocks()
})
const show = () => act(async () => root.render(createElement('main', null, 'Pages still render', createElement(ReloadNotice))))

test('a new site keeps rendering with an old backend that has no reload query', async () => {
  await show()
  expect(host.textContent).toBe('Pages still render')
  expect(query.mock.calls.every(([, args]) => args === 'skip')).toBe(true)
})

test('a failing reload query stays inside the banner', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  learnTakes(['artifacts.notLoaded'])
  await show()
  expect(host.textContent).toBe('Pages still render')
  expect(host.querySelector('[data-reload]')).toBeNull()
})

test('the advertised reload query shows the notice and stops when no longer advertised', async () => {
  query.mockImplementation((_fn, args) => (args === 'skip' ? undefined : [{ harness: 'claude', slugs: ['board'], title: 'Board', seenAt: Date.now() }]))
  learnTakes([TAKES.reloadReport])
  await show()
  expect(host.querySelector('[data-reload]')?.textContent).toContain('/reload-plugins')
  await act(async () => learnTakes([]))
  expect(host.querySelector('[data-reload]')).toBeNull()
})
