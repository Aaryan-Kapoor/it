// The bell and its tray, in a stand-in browser with a stand-in backend. What they must get
// right here: what became of an answer given in the tray is said aloud, to whoever cannot see
// it change, and the keyboard is not lost when the tray closes.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

/** What the backend says of the notifications, which a test changes as the backend would. */
let notes: Record<string, unknown>[]
/** What the backend answers a choice with: nothing, until the test lets it. */
let answer: { accept: () => void; refuse: (why: unknown) => void } | null
const asked: string[] = []
vi.mock('convex/react', () => ({
  useConvex: () => ({
    mutation: (fn: unknown) => {
      asked.push(getFunctionName(fn as never))
      return new Promise((accept, refuse) => {
        answer = { accept: () => accept({ actionId: null }), refuse }
      })
    },
    connectionState: () => ({ isWebSocketConnected: true }),
  }),
  useMutation: (fn: unknown) => () => {
    const name = getFunctionName(fn as never)
    asked.push(name)
    return name === 'notifications:answer'
      ? new Promise<null>((accept, refuse) => {
          answer = { accept: () => accept(null), refuse }
        })
      : Promise.resolve(null)
  },
  useQuery: () => notes,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const bell = () => host.querySelector<HTMLButtonElement>('.notif-btn')!
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
/** Draws the bell, and again where it is when the backend has something new to say. */
async function drawn() {
  const { Bell } = await import('./notifications')
  await act(async () => root.render(createElement(Bell)))
}

beforeEach(async () => {
  const { outboxBelongsTo } = await import('./outbox')
  outboxBelongsTo(null)
  outboxBelongsTo('user-1', 'session-1')
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  notes = [
    {
      id: 'note-1',
      text: 'The deploy finished',
      slug: null,
      sticky: true,
      buttons: [
        { label: 'Roll back', action: 'rollback' },
        { label: 'Fine', action: 'ok' },
      ],
      at: Date.now(),
      seen: true,
      answer: null,
    },
  ]
  answer = null
  asked.length = 0
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

test('what became of an answer given in the tray is said aloud: that it is on its way, that it was sent, and why it was not', async () => {
  await drawn()
  await act(async () => bell().click())
  // Where it is said is there before there is anything to say, so that what comes to be said in it is said
  const where = host.querySelector('.notif-item [role="status"]')!
  expect(where.textContent).toBe('')
  await act(async () => button('Fine').click())
  expect(where.textContent).toBe('“Fine” is not confirmed yet. Saved on this browser and retried when It is back')
  // Refused: said as an alert, and the choice can be made again
  await act(async () => answer!.refuse(new ConvexError({ code: 'conflict', message: 'That could not be sent.' })))
  expect(where.textContent).toBe('')
  expect(host.querySelector('.notif-item [role="alert"]')!.textContent).toBe('That could not be sent.')
  await act(async () => button('Fine').click())
  expect(host.querySelector('.notif-item [role="alert"]')).toBeNull()
  await act(async () => answer!.accept())
  notes = [{ ...notes[0], answer: 'ok' }]
  await drawn()
  expect(host.querySelector('.notif-item [role="status"]')).toBe(where)
  expect(where.textContent).toBe('Sent to your agent: Fine')
})

test('Escape from inside the tray closes it and leaves the keyboard on the bell, and from anywhere else it closes it and leaves the keyboard where it is', async () => {
  await drawn()
  const other = document.body.appendChild(document.createElement('button'))
  const pressed = (from: Element) => act(async () => void from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  try {
    await act(async () => bell().click())
    button('Dismiss').focus()
    await pressed(button('Dismiss'))
    expect(host.querySelector('.notif-panel')).toBeNull()
    expect(document.activeElement).toBe(bell())
    await act(async () => bell().click())
    other.focus()
    await pressed(other)
    expect(host.querySelector('.notif-panel')).toBeNull()
    expect(document.activeElement).toBe(other)
  } finally {
    other.remove()
  }
})

test('closing and reopening the tray restores the pending choice without allowing a different answer', async () => {
  await drawn()
  await act(async () => bell().click())
  await act(async () => button('Fine').click())
  const { hasPending } = await import('./pending')
  expect(hasPending()).toBe(true)
  await act(async () => bell().click())
  expect(host.querySelector('.notif-panel')).toBeNull()
  await act(async () => bell().click())
  expect(host.querySelector('.notif-item [role="status"]')?.textContent).toContain('“Fine” is not confirmed yet')
  expect(button('Roll back').disabled).toBe(true)
  expect(asked.filter((name) => name === 'notifications:answer')).toHaveLength(1)
  await act(async () => answer!.accept())
  expect(hasPending()).toBe(false)
  notes = [{ ...notes[0], answer: 'ok' }]
  await drawn()
  expect(host.querySelector('.notif-item [role="status"]')?.textContent).toBe('Sent to your agent: Fine')
})
