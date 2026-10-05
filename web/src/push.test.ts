// Turning notifications off, and dropping a subscription the browser is paired for nobody to
// have: both wait on the browser, and neither may finish against whoever it has been paired for
// meanwhile. And what goes
// from a browser when everything It held for its person is erased.
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { forgetAll, keepFor, letGoElsewhere } from './lib'
import { outboxBelongsTo, stillPairedFor, thisPairing } from './outbox'
import { dropPushHere, forgetPushHere, turnOffPush, turnOnPush } from './push'

/** A promise the test settles when it chooses, standing in for a browser that answers late. */
const late = <T>() => {
  let settle!: (v: T) => void
  const promise = new Promise<T>((r) => {
    settle = r
  })
  return { promise, settle }
}
const subscription = () => ({ unsubscribe: vi.fn(async () => true) })
const browser = (registration: Promise<unknown>) =>
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => registration } })
const backend = () => {
  const calls: string[] = []
  return { calls, client: { mutation: vi.fn(async (fn: never) => void calls.push(getFunctionName(fn))) } as never }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  outboxBelongsTo(null)
})
afterEach(() => {
  outboxBelongsTo(null)
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

test('turning notifications off takes the subscription away and tells the backend', async () => {
  outboxBelongsTo('alice', 'session-1')
  const sub = subscription()
  browser(Promise.resolve({ pushManager: { getSubscription: async () => sub } }))
  const b = backend()
  const began = thisPairing()
  await turnOffPush(b.client, () => stillPairedFor('alice', began))
  expect(sub.unsubscribe).toHaveBeenCalledOnce()
  expect(b.calls).toEqual(['push:unsubscribe'])
})

test('begun for one person and answered once the browser is paired for another, it touches neither their subscription nor their display', async () => {
  outboxBelongsTo('alice', 'session-1')
  const registration = late<unknown>()
  browser(registration.promise)
  const b = backend()
  const began = thisPairing()
  const off = turnOffPush(b.client, () => stillPairedFor('alice', began))
  outboxBelongsTo('bob', 'session-2')
  const bobs = subscription()
  registration.settle({ pushManager: { getSubscription: async () => bobs } })
  await off
  expect(bobs.unsubscribe).not.toHaveBeenCalled()
  expect(b.calls).toEqual([])
})

test('nor when the browser has been paired again for the same person: it was the earlier pairing that asked', async () => {
  outboxBelongsTo('alice', 'session-1')
  const registration = late<unknown>()
  browser(registration.promise)
  const b = backend()
  const began = thisPairing()
  const off = turnOffPush(b.client, () => stillPairedFor('alice', began))
  outboxBelongsTo(null)
  outboxBelongsTo('alice', 'session-2')
  const hers = subscription()
  registration.settle({ pushManager: { getSubscription: async () => hers } })
  await off
  expect(hers.unsubscribe).not.toHaveBeenCalled()
  expect(b.calls).toEqual([])
})

test('a subscription dropped because the browser is paired for nobody is dropped', async () => {
  const sub = subscription()
  browser(Promise.resolve({ pushManager: { getSubscription: async () => sub } }))
  await dropPushHere()
  expect(sub.unsubscribe).toHaveBeenCalledOnce()
})

test('and is still dropped when the browser has been paired for someone meanwhile and notifications were left off: it was the last person’s, and would go on bringing them notifications here', async () => {
  const registration = late<unknown>()
  browser(registration.promise)
  const dropping = dropPushHere()
  outboxBelongsTo('bob', 'session-2')
  const left = subscription()
  registration.settle({ pushManager: { getSubscription: async () => left } })
  await dropping
  expect(left.unsubscribe).toHaveBeenCalledOnce()
})

test('and is left alone once someone has begun to turn notifications on here: what is there by then is theirs', async () => {
  const registration = late<unknown>()
  browser(registration.promise)
  const dropping = dropPushHere()
  outboxBelongsTo('bob', 'session-2')
  // Bob begins to turn notifications on. This stand-in browser has no notifications, so the
  // attempt ends at once, however it ends, and it has still been begun
  void turnOnPush(backend().client).catch(() => {})
  const bobs = subscription()
  registration.settle({ pushManager: { getSubscription: async () => bobs } })
  await dropping
  expect(bobs.unsubscribe).not.toHaveBeenCalled()
})

/** What a browser holds for the site once notifications were turned on: the script, its subscription, and what it is showing. */
function registered() {
  const shown = [{ close: vi.fn() }, { close: vi.fn() }]
  const sub = subscription()
  const registration = { getNotifications: async () => shown, pushManager: { getSubscription: async () => sub }, unregister: vi.fn(async () => true) }
  return { shown, sub, registration }
}
const browserWith = (registrations: Promise<unknown[]>) =>
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistrations: () => registrations, getRegistration: async () => undefined },
  })

test('when everything is erased, the notifications still showing are closed, the subscription is dropped, and the site’s script is unregistered', async () => {
  const { shown, sub, registration } = registered()
  browserWith(Promise.resolve([registration]))
  await forgetPushHere()
  expect(shown.map((n) => n.close.mock.calls.length)).toEqual([1, 1])
  expect(sub.unsubscribe).toHaveBeenCalledOnce()
  expect(registration.unregister).toHaveBeenCalledOnce()
})

test('a browser that will not say what it is showing or what it is subscribed to still has the site’s script unregistered', async () => {
  const unregister = vi.fn(async () => true)
  const refusing = Promise.reject(new Error('NotAllowedError'))
  refusing.catch(() => {})
  browserWith(
    Promise.resolve([
      { getNotifications: () => refusing, pushManager: { getSubscription: () => refusing }, unregister },
      // And one of a browser that has neither
      { unregister },
    ]),
  )
  await forgetPushHere()
  expect(unregister).toHaveBeenCalledTimes(2)
})

test('that is done in the tab that lets go of a person’s things and in every tab that is told, and not for a browser that kept things for nobody', async () => {
  const { registration } = registered()
  browserWith(Promise.resolve([registration]))
  forgetAll(null)
  await new Promise((r) => setTimeout(r, 5))
  expect(registration.unregister).not.toHaveBeenCalled()
  keepFor('alice')
  forgetAll('alice')
  await vi.waitFor(() => expect(registration.unregister).toHaveBeenCalledTimes(1))
  letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' }))
  await vi.waitFor(() => expect(registration.unregister).toHaveBeenCalledTimes(2))
})

test('once the browser has been paired for somebody else, the script and what it shows are theirs, and word that an erased person’s things are to go leaves them be', async () => {
  const { shown, sub, registration } = registered()
  browserWith(Promise.resolve([registration]))
  keepFor('alice')
  // Everything of Alice's was erased, It was set up again, and the browser was paired for Bob, who turned notifications on
  localStorage.clear()
  keepFor('bob')
  forgetAll('alice')
  letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' }))
  await new Promise((r) => setTimeout(r, 10))
  expect([shown[0]!.close.mock.calls.length, sub.unsubscribe.mock.calls.length, registration.unregister.mock.calls.length]).toEqual([0, 0, 0])
})

test('a browser paired again that has begun to turn notifications on keeps what is there by then: it is that pairing’s', async () => {
  const { shown, sub, registration } = registered()
  const registrations = late<unknown[]>()
  browserWith(registrations.promise)
  const forgetting = forgetPushHere()
  outboxBelongsTo('bob', 'session-2')
  void turnOnPush(backend().client).catch(() => {})
  registrations.settle([registration])
  await forgetting
  expect([shown[0]!.close.mock.calls.length, sub.unsubscribe.mock.calls.length, registration.unregister.mock.calls.length]).toEqual([0, 0, 0])
})

test('a browser with no script of the site’s, or that keeps none at the address it reached the site by, has nothing to let go of', async () => {
  browserWith(Promise.resolve([]))
  await expect(forgetPushHere()).resolves.toBeUndefined()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  await expect(forgetPushHere()).resolves.toBeUndefined()
})

describe('turning notifications on, stopped at each thing it waits for', () => {
  /** What turning notifications on waits for, in the order it waits for them. */
  const WAITS = [
    'permission',
    'the script there already',
    'the script registered',
    'the script ready',
    'the key',
    'the subscription there already',
    'that one dropped',
    'the new subscription',
    'the backend told',
  ] as const
  type Wait = (typeof WAITS)[number]

  /**
   * A browser that can be notified, and a backend, in which every wait of turning notifications
   * on lasts until the test ends it. It keeps what was done to it: whether the site's script is
   * registered, and how often each thing was asked for or taken away.
   */
  function standIn(scriptThere: boolean) {
    const gates = Object.fromEntries(WAITS.map((wait) => [wait, late<void>()])) as Record<Wait, ReturnType<typeof late<void>>>
    /** How often each of them was asked for, by anything. */
    const asked = Object.fromEntries(WAITS.map((wait) => [wait, 0])) as Record<Wait, number>
    const at = (wait: Wait) => {
      asked[wait] += 1
      return gates[wait].promise
    }
    /** Gives something once the wait for it is over. */
    const after = async <T>(wait: Wait, given: T): Promise<T> => {
      await at(wait)
      return given
    }
    const b = { registered: scriptThere, stored: 0, shown: [{ close: vi.fn() }] }
    /** The subscription whoever used the browser before left, and the one a new attempt makes. */
    const left = { unsubscribe: vi.fn(() => after('that one dropped', true)) }
    const made = { endpoint: 'https://push.example/made', getKey: () => new ArrayBuffer(4), unsubscribe: vi.fn(async () => true) }
    const registration = {
      unregister: vi.fn(async () => {
        b.registered = false
        return true
      }),
      getNotifications: async () => b.shown,
      pushManager: {
        getSubscription: vi.fn(() => after('the subscription there already', left)),
        subscribe: vi.fn(() => after('the new subscription', made)),
      },
    }
    const register = vi.fn(async () => {
      await at('the script registered')
      b.registered = true
      return registration
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: () => after('the script there already', b.registered ? registration : undefined),
        getRegistrations: async () => (b.registered ? [registration] : []),
        register,
        get ready() {
          return at('the script ready').then(() => registration)
        },
      },
    })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: () => after('permission', 'granted') })
    const client = {
      action: () => after('the key', 'AAAA'),
      mutation: vi.fn(async (fn: never) => {
        if (getFunctionName(fn) !== 'push:subscribe') return
        await at('the backend told')
        b.stored += 1
      }),
    } as never
    /** Ends every wait up to one, so that an attempt stands at that one, and then lets what follows be done. */
    const until = async (wait: Wait) => {
      for (const earlier of WAITS.slice(0, WAITS.indexOf(wait))) gates[earlier].settle()
      await new Promise((r) => setTimeout(r, 5))
    }
    const all = async () => {
      for (const wait of WAITS) gates[wait].settle()
      await new Promise((r) => setTimeout(r, 5))
    }
    return { b, asked, left, made, registration, register, client, until, all }
  }
  /** How many of the waits an attempt has got past by the time it stands at one. */
  const past = (wait: Wait, earlier: Wait) => WAITS.indexOf(wait) >= WAITS.indexOf(earlier)

  beforeEach(() => {
    keepFor('alice')
    outboxBelongsTo('alice', 'session-1')
  })
  afterEach(() => vi.unstubAllGlobals())

  test('with nothing in its way it registers the script, drops the subscription that was left, makes its own and tells the backend', async () => {
    const s = standIn(false)
    const on = turnOnPush(s.client)
    await s.all()
    expect(await on).toBe('on')
    expect([s.b.registered, s.left.unsubscribe.mock.calls.length, s.made.unsubscribe.mock.calls.length, s.b.stored]).toEqual([true, 1, 0, 1])
  })

  test.each(WAITS)('signed out while it waits for %s, it does nothing more, and takes away again what it made itself and nothing else', async (wait) => {
    for (const scriptThere of [false, true]) {
      const s = standIn(scriptThere)
      const on = turnOnPush(s.client)
      await s.until(wait)
      // The pairing it was begun under is over, and nothing else touches what is in the browser
      const off = turnOffPush(s.client, () => false)
      await s.all()
      await off
      expect([wait, await on]).toEqual([wait, 'Signed out'])
      // The script goes only where this attempt registered it, and it had begun to
      const registered = !scriptThere && past(wait, 'the script registered')
      expect([wait, scriptThere, s.register.mock.calls.length > 0, s.registration.unregister.mock.calls.length, s.b.registered]).toEqual([
        wait,
        scriptThere,
        past(wait, 'the script registered'),
        registered ? 1 : 0,
        scriptThere,
      ])
      // What was left by whoever was here before is dropped only where the attempt had already begun to drop it
      expect([wait, s.left.unsubscribe.mock.calls.length]).toEqual([wait, past(wait, 'that one dropped') ? 1 : 0])
      // A subscription is made only where it had already been asked for, and is then taken away again
      const subscribed = past(wait, 'the new subscription')
      expect([wait, s.registration.pushManager.subscribe.mock.calls.length, s.made.unsubscribe.mock.calls.length]).toEqual([
        wait,
        subscribed ? 1 : 0,
        subscribed ? 1 : 0,
      ])
      // And the backend is told nothing that had not been sent already
      expect([wait, s.b.stored]).toEqual([wait, wait === 'the backend told' ? 1 : 0])
      // Nothing was asked of the person, the browser or the backend past what it was waiting for
      // when it was overtaken. (Signing out asks once, itself, which script is there.)
      for (const each of WAITS)
        expect([wait, each, s.asked[each]]).toEqual([wait, each, (past(wait, each) ? 1 : 0) + (each === 'the script there already' ? 1 : 0)])
    }
  })

  test.each(WAITS)('everything erased while it waits for %s, no script of the site’s is left registered and no subscription is left', async (wait) => {
    for (const scriptThere of [false, true]) {
      keepFor('alice')
      const s = standIn(scriptThere)
      const on = turnOnPush(s.client)
      await s.until(wait)
      // The erasing lets go of everything here, and has looked for the site's script before the wait is over
      forgetAll('alice')
      await new Promise((r) => setTimeout(r, 5))
      await s.all()
      expect([wait, await on]).toEqual([wait, 'Signed out'])
      await new Promise((r) => setTimeout(r, 5))
      expect([wait, scriptThere, s.b.registered]).toEqual([wait, scriptThere, false])
      if (past(wait, 'the new subscription')) expect([wait, s.made.unsubscribe.mock.calls.length > 0]).toEqual([wait, true])
      else expect([wait, s.registration.pushManager.subscribe.mock.calls.length]).toEqual([wait, 0])
      expect([wait, s.b.stored]).toEqual([wait, wait === 'the backend told' ? 1 : 0])
    }
  })

  test.each(WAITS)(
    'overtaken by a later attempt while it waits for %s, it touches nothing: what is in the browser by then is the later one’s',
    async (wait) => {
      const s = standIn(false)
      const first = turnOnPush(s.client)
      await s.until(wait)
      const second = turnOnPush(s.client)
      await s.all()
      expect([wait, await first, await second]).toEqual([wait, 'Signed out', 'on'])
      // Nothing was undone by the one that was overtaken
      expect([wait, s.b.registered, s.registration.unregister.mock.calls.length, s.made.unsubscribe.mock.calls.length]).toEqual([wait, true, 0, 0])
      // What was left before is dropped once by the later attempt, and by the earlier one only where it had already begun to
      expect([wait, s.left.unsubscribe.mock.calls.length]).toEqual([wait, past(wait, 'that one dropped') ? 2 : 1])
      // And the backend is told once by the later attempt, and by the earlier only where it had already been sent
      expect([wait, s.b.stored]).toEqual([wait, wait === 'the backend told' ? 2 : 1])
    },
  )

  /** A backend that fails with no word of why the first time it is asked for the key, and how often it was asked. */
  function keyTroubledOnce(s: ReturnType<typeof standIn>) {
    const key = vi.fn(async () => {
      if (key.mock.calls.length === 1) throw new Error('[CONVEX A(push:publicKey)] [Request ID: 0123456789abcdef] Server Error')
      return 'AAAA'
    })
    ;(s.client as { action: unknown }).action = key
    return key
  }

  test('a key the backend had trouble giving is asked for once more by itself, and notifications are turned on with nothing written as an error', async () => {
    vi.useFakeTimers()
    const written = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = standIn(false)
    const key = keyTroubledOnce(s)
    const on = turnOnPush(s.client)
    const all = s.all()
    await vi.advanceTimersByTimeAsync(2000)
    await all
    expect([await on, key.mock.calls.length, s.b.stored]).toEqual(['on', 2, 1])
    expect(written).not.toHaveBeenCalled()
    vi.useRealTimers()
    written.mockRestore()
  })

  test('signed out before the key is asked for a second time, it is not asked for again', async () => {
    vi.useFakeTimers()
    const s = standIn(false)
    const key = keyTroubledOnce(s)
    const on = turnOnPush(s.client)
    const all = s.all()
    await vi.advanceTimersByTimeAsync(500)
    await all
    expect(key.mock.calls.length).toBe(1)
    const off = turnOffPush(s.client, () => false)
    await vi.advanceTimersByTimeAsync(2000)
    await off
    expect([await on, key.mock.calls.length, s.b.stored]).toEqual(['Signed out', 1, 0])
    vi.useRealTimers()
  })

  test('a click on “Turn on notifications” in a browser that is kept for nobody by then registers nothing', async () => {
    const s = standIn(false)
    forgetAll('alice')
    const on = turnOnPush(s.client)
    await s.all()
    expect([await on, s.register.mock.calls.length, s.b.registered]).toEqual(['Signed out', 0, false])
  })

  test('an attempt the backend refuses, because the pairing it was begun under is over, takes away again what it made', async () => {
    const s = standIn(false)
    const { ConvexError } = await import('convex/values')
    ;(s.client as { mutation: unknown }).mutation = vi.fn(async () => {
      // The session ended while the answer was on its way, and the site has let go of the pairing
      await turnOffPush(s.client, () => false)
      throw new ConvexError({ code: 'unauthenticated', message: 'This browser is not paired.' })
    })
    const on = turnOnPush(s.client)
    await s.all()
    expect([await on, s.made.unsubscribe.mock.calls.length, s.registration.unregister.mock.calls.length, s.b.registered]).toEqual(['Signed out', 1, 1, false])
  })

  test('an erasing that is waiting to hear what the browser is showing closes nothing of a pairing that has begun to turn notifications on since', async () => {
    const showing = late<{ close: ReturnType<typeof vi.fn> }[]>()
    const shown = { close: vi.fn() }
    const registration = { unregister: vi.fn(async () => true), getNotifications: () => showing.promise, pushManager: { getSubscription: async () => null } }
    browserWith(Promise.resolve([registration]))
    const forgetting = forgetPushHere()
    await new Promise((r) => setTimeout(r, 5))
    void turnOnPush(backend().client).catch(() => {})
    showing.settle([shown])
    await forgetting
    expect([shown.close.mock.calls.length, registration.unregister.mock.calls.length]).toEqual([0, 0])
  })
})

describe('taking the site’s script away when everything is erased, stopped at each thing it waits for', () => {
  const WAITS = ['which scripts are registered', 'what is showing', 'the subscription', 'that one dropped', 'the script unregistered'] as const
  type Wait = (typeof WAITS)[number]
  afterEach(() => vi.unstubAllGlobals())

  test.each(WAITS.slice(0, 4))(
    'once a new pairing has begun to turn notifications on while it waits for %s, it does nothing more: what is there is that pairing’s',
    async (wait) => {
      const gates = Object.fromEntries(WAITS.map((each) => [each, late<void>()])) as Record<Wait, ReturnType<typeof late<void>>>
      const asked = Object.fromEntries(WAITS.map((each) => [each, 0])) as Record<Wait, number>
      /** Gives something once the wait for it is over. */
      const after = async <T>(each: Wait, given: T): Promise<T> => {
        asked[each] += 1
        await gates[each].promise
        return given
      }
      const shown = { close: vi.fn() }
      const sub = { unsubscribe: () => after('that one dropped', true) }
      const registration = {
        getNotifications: () => after('what is showing', [shown]),
        pushManager: { getSubscription: () => after('the subscription', sub) },
        unregister: () => after('the script unregistered', true),
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistrations: () => after('which scripts are registered', [registration]), getRegistration: async () => undefined },
      })
      const forgetting = forgetPushHere()
      for (const earlier of WAITS.slice(0, WAITS.indexOf(wait))) gates[earlier].settle()
      await new Promise((r) => setTimeout(r, 5))
      // It was set up again and the browser paired anew, and notifications are being turned on. In this
      // stand-in browser the attempt ends at once, however it ends, and it has still been begun
      void turnOnPush(backend().client).catch(() => {})
      for (const each of WAITS) gates[each].settle()
      await forgetting
      // Nothing past what it was waiting for was asked of the browser, and what was showing was
      // closed only where it had heard what that was before the new pairing began
      const reached = WAITS.indexOf(wait)
      expect(WAITS.map((each) => asked[each])).toEqual(WAITS.map((_, n) => (n <= reached ? 1 : 0)))
      expect(shown.close.mock.calls.length).toBe(reached > WAITS.indexOf('what is showing') ? 1 : 0)
    },
  )

  test('with no new pairing in its way it closes what is showing, drops the subscription and unregisters the script, in that order', async () => {
    const done: string[] = []
    const registration = {
      getNotifications: async () => [{ close: () => void done.push('closed') }],
      pushManager: { getSubscription: async () => ({ unsubscribe: async () => void done.push('dropped') }) },
      unregister: async () => void done.push('unregistered'),
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: async () => [registration] } })
    await forgetPushHere()
    expect(done).toEqual(['closed', 'dropped', 'unregistered'])
  })
})
