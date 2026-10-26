import { getFunctionName } from 'convex/server'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Card } from './pages'

let receipts: { job: string; title: string; state: string; attempts: number }[]
let unavailable = false
let tourDone = false
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
  useTour: () => ({ known: true, done: tourDone }),
  Welcome: () => createElement('main', { className: 'hello' }, 'Welcome'),
  Starters: ({ notice }: { notice?: ReactNode }) => createElement('main', { className: 'starters' }, notice, 'Things to ask for'),
}))
vi.mock('./preview', () => ({ Preview: () => null }))
vi.mock('./mount', () => ({ Mount: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  receipts = [{ job: 'deletion-1', title: 'Trip plan', state: 'pending', attempts: 0 }]
  asked.mockClear()
  unavailable = false
  tourDone = false
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

test('a deletion that is under way or has gone through says nothing on the Pages screen', async () => {
  await draw(true, [
    { id: 'page-2', slug: 'groceries', title: 'Groceries', version: 1, updatedAt: Date.now(), agent: null, machine: null, pending: 0, pinned: false },
  ])
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  expect(host.textContent).not.toContain('Trip plan')
  receipts[0]!.state = 'completed'
  await draw(true, [
    { id: 'page-2', slug: 'groceries', title: 'Groceries', version: 1, updatedAt: Date.now(), agent: null, machine: null, pending: 0, pinned: false },
  ])
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  expect(host.textContent).not.toContain('deletion confirmed')
})

test('a deletion that failed once and will try again says nothing, and one that keeps failing is named until it goes through', async () => {
  receipts[0]!.state = 'retrying'
  receipts[0]!.attempts = 1
  await draw()
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  receipts[0]!.attempts = 3
  await draw()
  expect(host.textContent).toContain('Trip plan could not be deleted yet. It keeps trying')
  expect(host.textContent).toContain('anyone with its link may still open its files')
  receipts[0]!.state = 'completed'
  await draw()
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
})

test('a paired screen asks for no receipts', async () => {
  receipts[0]!.state = 'retrying'
  receipts[0]!.attempts = 5
  await draw(false)
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  expect(asked).not.toHaveBeenCalled()
})

test('the welcome screen returns when there are no pages, whatever deletions are under way or done', async () => {
  await draw()
  expect(host.querySelector('main.hello')).not.toBeNull()
  receipts = []
  await draw()
  expect(host.querySelector('main.hello')).not.toBeNull()
})

test('with no pages left, a deletion that keeps failing is named above what an empty screen shows', async () => {
  tourDone = true
  receipts[0]!.state = 'retrying'
  receipts[0]!.attempts = 4
  await draw()
  expect(host.querySelector('main.starters')).not.toBeNull()
  expect(host.textContent).toContain('Trip plan could not be deleted yet.')
})

test('an older backend without the receipt query leaves ordinary pages usable and says nothing of deletions', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  unavailable = true
  await draw(true, [
    { id: 'page-1', slug: 'trip-plan', title: 'Trip plan', version: 1, updatedAt: Date.now(), agent: null, machine: null, pending: 0, pinned: false },
  ])
  expect(host.querySelector('a[href="/p/trip-plan"]')).not.toBeNull()
  expect(host.querySelector('button[aria-label="Delete"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Page deletions"]')).toBeNull()
  expect(host.textContent).not.toContain('deletion confirmed')
})

test('finishing the tour returns to suggestions while its completed deletion receipt is retained, and says nothing of it', async () => {
  tourDone = true
  await draw()
  expect(host.querySelector('main.starters')).not.toBeNull()
  receipts[0]!.state = 'completed'
  await draw()
  expect(host.querySelector('main.starters')).not.toBeNull()
  expect(host.querySelector('main.hello')).toBeNull()
  expect(host.textContent).not.toContain('Trip plan')
})
