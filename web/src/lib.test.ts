// The sign-out token a browser keeps: when it can be counted on, and when it is spent. One small
// thing the site works out for itself: whether a browser has been paired again since it
// registered as a display. And letting go of everything the site keeps in a browser, in the tab
// that does it and in a tab that is told.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  displayKey,
  forgetAll,
  forgetDisplayKey,
  hasSignOutToken,
  keepFor,
  keepSignOutToken,
  keptFor,
  letGoElsewhere,
  letGoOf,
  noteRegistered,
  pairedSinceRegistering,
  pairingAddress,
  signOutLater,
  signOutTokenSpent,
  timesLetGo,
  whenLetGo,
} from './lib'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('the address another screen opens to pair itself', () => {
  const CODE = 'abcdefghij0123456789'

  test('it is the site as this browser reached it, with the code where it is sent to nobody', () => {
    expect(pairingAddress(CODE, { origin: 'http://192.168.1.20:39500', hostname: '192.168.1.20' })).toBe(`http://192.168.1.20:39500/pair#${CODE}`)
    expect(pairingAddress(CODE, { origin: 'https://den.example', hostname: 'den.example' })).toBe(`https://den.example/pair#${CODE}`)
    // Everything of the code is after the `#`, whatever it is made of
    expect(new URL(pairingAddress('a/b?c#d e', { origin: 'http://den.local:39500', hostname: 'den.local' })!).pathname).toBe('/pair')
  })

  test('there is none when this browser reached the site by a name that only means this machine', () => {
    for (const hostname of ['localhost', 'it.localhost', '127.0.0.1', '127.8.9.10', '[::1]'])
      expect(pairingAddress(CODE, { origin: `http://${hostname}:39500`, hostname })).toBeNull()
    // As it does in this stand-in browser
    expect(pairingAddress(CODE)).toBeNull()
  })
})

describe('a display the person forgot', () => {
  test('it is the same display under the session that registered it, and a new one once the browser has been paired again', () => {
    // Never registered from this browser: whatever session it has is a new pairing
    expect(pairedSinceRegistering('session-1')).toBe(true)
    noteRegistered('session-1')
    expect(pairedSinceRegistering('session-1')).toBe(false)
    expect(pairedSinceRegistering('session-2')).toBe(true)
  })

  test('letting go of the key lets go of the session it was registered under too', () => {
    const key = displayKey()
    noteRegistered('session-1')
    forgetDisplayKey()
    expect(displayKey()).not.toBe(key)
    expect(pairedSinceRegistering('session-1')).toBe(true)
  })
})

describe('the sign-out token a browser keeps', () => {
  const display = { id: 'display-1', epoch: 3 }

  test('it counts only for the person and the display it was fetched for, at a number it would still raise', () => {
    expect(hasSignOutToken('alice', display)).toBe(false)
    keepSignOutToken('token', 'alice', 4, 'display-1')
    expect(hasSignOutToken('alice', display)).toBe(true)
    // Before the display's own record has been heard from, the token is taken as it is
    expect(hasSignOutToken('alice', undefined)).toBe(true)
    expect(hasSignOutToken('bob', display)).toBe(false)
    // The display has since reached that number by some other route
    expect(hasSignOutToken('alice', { id: 'display-1', epoch: 4 })).toBe(false)
    // This browser is now another display: its old record made room, and it registered again
    expect(hasSignOutToken('alice', { id: 'display-2', epoch: 0 })).toBe(false)
  })

  test('a token that is spent is known to be, so that another is fetched', () => {
    expect(signOutTokenSpent('alice', display)).toBe(false)
    keepSignOutToken('token', 'alice', 4, 'display-1')
    expect(signOutTokenSpent('alice', display)).toBe(false)
    expect(signOutTokenSpent('alice', { id: 'display-1', epoch: 4 })).toBe(true)
    expect(signOutTokenSpent('alice', { id: 'display-2', epoch: 0 })).toBe(true)
    // Someone else's kept token says nothing about this person's
    expect(signOutTokenSpent('bob', { id: 'display-1', epoch: 9 })).toBe(false)
  })

  test('each sign-out that is owed is kept by itself, and the kept token is used up by it', () => {
    keepSignOutToken('first', 'alice', 4, 'display-1')
    expect(signOutLater()).toBe(true)
    expect(hasSignOutToken('alice', display)).toBe(false)
    keepSignOutToken('second', 'bob', 2, 'display-9')
    expect(signOutLater()).toBe(true)
    const owed = Object.keys(localStorage).filter((k) => k.startsWith('it.signout.pending.'))
    expect(owed.map((k) => localStorage.getItem(k)).sort()).toEqual(['first', 'second'])
    // With nothing kept there is nothing to leave behind, and that is said
    expect(signOutLater()).toBe(false)
  })
})

describe('letting go of everything the site keeps in a browser', () => {
  /** What the site keeps for a person: in the store every tab shares, and in the one a tab has to itself. */
  const keep = (person: string) => {
    keepFor(person)
    localStorage.setItem('it.display', 'a-display-key-000001')
    localStorage.setItem(`it.outbox.${person}.page-1.click-0001`, '{"payload":"private"}')
    localStorage.setItem('it.signout.pending.0f', 'sign-out-token')
    sessionStorage.setItem(`it.shownAt.${person}`, '7')
    sessionStorage.setItem('it.reloadedAt', '1')
    // And what is not the site's, which a browser keeps for the same address
    localStorage.setItem('another-programs', 'kept')
    sessionStorage.setItem('another-programs', 'kept')
  }
  const kept = () => [Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]

  test('all of it goes from both of the browser’s stores, nothing that is not the site’s does, and the other tabs are told for whom', () => {
    keep('alice')
    const written: [string, string][] = []
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      written.push([name, value])
    })
    try {
      const before = timesLetGo('alice')
      forgetAll('alice')
      expect(kept()).toEqual([['another-programs'], ['another-programs']])
      expect([keptFor(), letGoOf('alice'), letGoOf('bob'), timesLetGo('alice') - before]).toEqual([null, true, false, 1])
      // Said through a value the browser tells every other tab of, and taken away again at once
      expect(written).toEqual([['it.letgo', 'alice']])
    } finally {
      set.mockRestore()
    }
    keep('alice')
    forgetAll('alice')
    expect(kept()).toEqual([['another-programs'], ['another-programs']])
  })

  test('a browser that keeps things for nobody lets go of them without a word to its other tabs: there is nobody to name', () => {
    localStorage.setItem('it.display', 'a-display-key-000001')
    sessionStorage.setItem('it.reconnectedAt', '1')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    try {
      forgetAll(null)
      expect(set).not.toHaveBeenCalled()
    } finally {
      set.mockRestore()
    }
    expect(kept()).toEqual([[], []])
  })

  test('a tab told so by another lets go of what it keeps to itself, and of whatever it wrote for all of them before it heard', () => {
    keep('alice')
    const heard: [string | null, boolean][] = []
    whenLetGo((person, whole) => void heard.push([person, whole]))
    // The other tab removed what all tabs share. This one has written a click back since, and has its own store as it was
    localStorage.removeItem('it.person')
    localStorage.removeItem('it.display')
    const before = timesLetGo('alice')
    expect(letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice', oldValue: null }))).toBe(true)
    expect(kept()).toEqual([['another-programs'], ['another-programs']])
    expect([letGoOf('alice'), timesLetGo('alice') - before, heard]).toEqual([true, 1, [['alice', true]]])
  })

  /** The browser as it stands once It was set up again and the browser paired for another person, with something of the erased person's written late by a tab that had yet to hear. */
  const pairedForAnotherSince = () => {
    keep('bob')
    localStorage.setItem('it.outbox.alice.page-1.click-0009', '{"payload":"written late"}')
    sessionStorage.setItem('it.shownAt.alice', '3')
  }
  const BOBS = [
    ['another-programs', 'it.display', 'it.outbox.bob.page-1.click-0001', 'it.person', 'it.signout.pending.0f'],
    ['another-programs', 'it.reloadedAt', 'it.shownAt.bob'],
  ]

  test('an erasing whose word comes after the browser was paired for another person lets go only of what is named for the erased one, in both stores', () => {
    pairedForAnotherSince()
    const heard: [string | null, boolean][] = []
    whenLetGo((person, whole) => void heard.push([person, whole]))
    const before = [timesLetGo('alice'), timesLetGo('bob')]
    forgetAll('alice')
    // The new person's display, their click, the sign-out they are owed and what their tab keeps to itself are as they were
    expect(kept()).toEqual(BOBS)
    expect([keptFor(), localStorage.getItem('it.display'), localStorage.getItem('it.outbox.bob.page-1.click-0001')]).toEqual([
      'bob',
      'a-display-key-000001',
      '{"payload":"private"}',
    ])
    // Nothing more is kept for the erased person, and what is under way for the new one is not disturbed
    expect([letGoOf('alice'), letGoOf('bob'), timesLetGo('alice') - before[0]!, timesLetGo('bob') - before[1]!]).toEqual([true, false, 1, 0])
    // Whatever holds things in the tab's memory is told that it was that person's alone
    expect(heard).toEqual([['alice', false]])
  })

  test('where the browser has been paired for another person since, a tab told so by another removes only what is named for the one let go of, of what it keeps to itself too', () => {
    pairedForAnotherSince()
    const heard: [string | null, boolean][] = []
    whenLetGo((person, whole) => void heard.push([person, whole]))
    const before = timesLetGo('bob')
    letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' }))
    expect(kept()).toEqual(BOBS)
    expect([keptFor(), letGoOf('alice'), letGoOf('bob'), timesLetGo('bob') - before, heard]).toEqual(['bob', true, false, 0, [['alice', false]]])
  })

  test('a browser that is kept for somebody is not taken for one that is kept for nobody, whatever a tab that was slow to ask comes to believe', () => {
    keep('bob')
    forgetAll(null)
    expect(kept()).toEqual(BOBS)
    expect(letGoOf('bob')).toBe(false)
  })

  test('the names of the sessions whose cookies are still to be cleared are left by every letting go, in the tab that does it and in a tab that is told', () => {
    const names = JSON.stringify([{ id: 'session-1', at: 1 }])
    for (const letGo of [
      () => forgetAll('alice'),
      () => forgetAll(null),
      () => letGoElsewhere(new StorageEvent('storage', { key: 'it.letgo', newValue: 'alice' })),
    ]) {
      localStorage.clear()
      localStorage.setItem('it.cookies', names)
      localStorage.setItem('it.display', 'a-display-key-000001')
      letGo()
      expect(Object.keys(localStorage)).toEqual(['it.cookies'])
      expect(localStorage.getItem('it.cookies')).toBe(names)
    }
  })

  test('any other change another tab makes is not that, and neither is the value being taken away again', () => {
    keep('alice')
    const before = timesLetGo('alice')
    for (const [key, newValue] of [
      ['it.letgo', null],
      ['it.session', '1'],
      ['it.person', null],
      [null, null],
    ] as const)
      expect(letGoElsewhere(new StorageEvent('storage', { key, newValue, oldValue: 'alice' }))).toBe(false)
    expect([timesLetGo('alice') - before, letGoOf('alice'), Object.keys(sessionStorage).length]).toEqual([0, false, 3])
  })

  test('nothing is kept again for a person whose things were let go of, until the backend says the browser is paired for them', () => {
    keepFor('alice')
    forgetAll('alice')
    // A sign-out token that was on its way when everything was erased arrives now
    keepSignOutToken('token', 'alice', 4, 'display-1')
    expect(localStorage.getItem('it.signout')).toBeNull()
    keepFor('alice')
    expect([letGoOf('alice'), keptFor()]).toEqual([false, 'alice'])
    keepSignOutToken('token', 'alice', 4, 'display-1')
    expect(hasSignOutToken('alice', { id: 'display-1', epoch: 3 })).toBe(true)
  })
})
