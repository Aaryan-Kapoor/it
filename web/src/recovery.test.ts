import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLElement | undefined
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('every ordinary reload waits for work started before or during its connection check, then resumes', async () => {
  const { holdPending } = await import('./pending')
  const { reloadWhenThere } = await import('./lib')
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  const heads: ((response: { ok: boolean }) => void)[] = []
  const fetch = vi.fn(() => new Promise((resolve) => heads.push(resolve)))
  vi.stubGlobal('fetch', fetch)
  const first = holdPending('person')
  reloadWhenThere()
  expect(fetch).not.toHaveBeenCalled()
  first()
  expect(fetch).toHaveBeenCalledTimes(1)
  const duringHead = holdPending('person')
  heads[0]!({ ok: true })
  await Promise.resolve()
  expect(reload).not.toHaveBeenCalled()
  duringHead()
  expect(fetch).toHaveBeenCalledTimes(2)
  heads[1]!({ ok: true })
  await Promise.resolve()
  expect(reload).toHaveBeenCalledTimes(1)
})

test('revocation deliberately clears pending work and late completions cannot clear newer work', async () => {
  const { holdPending, hasPending, discardPending } = await import('./pending')
  const old = holdPending('old-person')
  discardPending('old-person')
  expect(hasPending()).toBe(false)
  const next = holdPending('next-person')
  old()
  expect(hasPending()).toBe(true)
  next()
  expect(hasPending()).toBe(false)
})

async function render(fails: () => boolean) {
  const { Guard } = await import('./app')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host, { onCaughtError: () => {} })
  function Child() {
    if (fails()) throw new Error('Temporary connection failure')
    return createElement('p', {}, 'The page recovered')
  }
  await act(async () => root!.render(createElement(Guard, null, createElement(Child))))
}

test('a failed inner view recovers without a press once its pending request settles', async () => {
  const { holdPending } = await import('./pending')
  const finish = holdPending('person')
  let broken = true
  await render(() => broken)
  broken = false
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(host!.textContent).toContain('That did not work')
  await act(async () => finish())
  expect(host!.textContent).toBe('The page recovered')
})

test('a persistently failing inner view stops after four increasingly spaced retries and retains manual Retry', async () => {
  let attempted = 0
  await render(() => {
    attempted++
    return true
  })
  const first = attempted
  await act(async () => vi.advanceTimersByTimeAsync(999))
  expect(attempted).toBe(first)
  for (const wait of [1, 5000, 15_000, 60_000]) {
    const before = attempted
    await act(async () => vi.advanceTimersByTimeAsync(wait))
    expect(attempted).toBeGreaterThan(before)
  }
  const stopped = attempted
  await act(async () => vi.advanceTimersByTimeAsync(600_000))
  expect(attempted).toBe(stopped)
  const retry = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  await act(async () => retry.click())
  expect(attempted).toBeGreaterThan(stopped)
})
