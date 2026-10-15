import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Card } from './pages'

let receipts: { job: string; title: string; state: string }[]
let unavailable = false
const asked = vi.fn()
vi.mock('convex/react', () => ({
  useQuery: (fn: unknown) => {
    asked(getFunctionName(fn as never))
    if (unavailable) throw new Error('Could not find public function for deletions:list')
    return receipts
  },
  useMutation: () => vi.fn(),
}))
vi.mock('./welcome', () => ({
  useTour: () => ({ known: true }),
  Welcome: () => createElement('main', { className: 'hello' }, 'Welcome'),
  Starters: () => null,
}))
vi.mock('./preview', () => ({ Preview: () => null }))
vi.mock('./mount', () => ({ Mount: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  receipts = [{ job: 'deletion-1', title: 'Trip plan', state: 'pending' }]
  asked.mockClear()
  unavailable = false
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const draw = async (owner = true, pages: Card[] = []) => {
  const { Grid } = await import('./pages')
  await act(async () => root.render(createElement(Grid, { pages, owner, query: '', onQuery: () => {} })))
}

test('unfinished deletion remains visible after the last page disappears and reports a failed attempt honestly', async () => {
  await draw()
  expect(host.textContent).toContain('Trip plan is being deleted.')
  expect(host.querySelector('main.hello')).toBeNull()
  expect(host.textContent).toContain('Its files may still answer')
  receipts[0]!.state = 'retrying'
  await draw()
  expect(host.textContent).toContain('could not be fully deleted yet. It will retry.')
  expect(host.textContent).not.toContain('deletion confirmed')
  receipts[0]!.state = 'completed'
  await draw()
  expect(host.textContent).not.toContain('Its files may still answer')
  const button = host.querySelector('button')!
  await act(async () => button.click())
  expect(host.textContent).toContain('Trip plan: deletion confirmed.')
})

test('a fresh page reads unfinished deletions from the backend, while a paired screen asks for no receipts', async () => {
  receipts[0]!.state = 'retrying'
  await draw()
  expect(host.textContent).toContain('It will retry.')
  asked.mockClear()
  await draw(false)
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  expect(asked).not.toHaveBeenCalled()
})

test('the welcome screen returns when there are no pages and no deletion receipts', async () => {
  receipts = []
  await draw()
  expect(host.querySelector('main.hello')).not.toBeNull()
})

test('an older backend without the receipt query leaves ordinary pages usable and never claims completion', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  unavailable = true
  await draw(true, [
    { id: 'page-1', slug: 'trip-plan', title: 'Trip plan', version: 1, updatedAt: Date.now(), agent: null, machine: null, pending: 0, pinned: false },
  ])
  expect(host.querySelector('a[href="/p/trip-plan"]')).not.toBeNull()
  expect(host.querySelector('button[aria-label="Delete"]')).not.toBeNull()
  expect(host.textContent).toContain('Deletion status is unavailable. Completion cannot be confirmed.')
  expect(host.textContent).not.toContain('deletion confirmed.')
  unavailable = false
  receipts = []
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click())
  expect(host.textContent).not.toContain('Deletion status is unavailable')
  expect(host.querySelector('a[href="/p/trip-plan"]')).not.toBeNull()
})
