// What the site says of the Claude Code conversations that are open and have not loaded It's
// add-on, from what the machine they are open on says: on one of their pages, and elsewhere.
import { describe, expect, test } from 'vitest'
import { notLoaded, reloadWords, standing } from './listening'

const one = { harness: 'claude-code', slugs: ['plan', 'notes'], title: 'Deploy plan', seenAt: 1_000 }
const other = { harness: 'claude-code', slugs: ['chess'], title: 'Chess', seenAt: 50_000 }

describe('the notice that asks for /reload-plugins', () => {
  test('on a page of a conversation that has not loaded the add-on, says so of this page', () => {
    expect(reloadWords([one], 'notes')).toBe('Your Claude Code chat can’t hear this page yet. Type /reload-plugins in that chat.')
  })

  test('on a page of a conversation that hears it, says nothing, whatever other conversations do', () => {
    expect(reloadWords([one], 'chess')).toBeNull()
    expect(reloadWords([], 'plan')).toBeNull()
  })

  test('elsewhere on the site, names the one conversation by its page, or says how many there are', () => {
    expect(reloadWords([one])).toBe('Your Claude Code chat can’t hear “Deploy plan” yet. Type /reload-plugins in that chat.')
    expect(reloadWords([one, other])).toBe('2 of your Claude Code chats can’t hear their pages yet. Type /reload-plugins in each of them.')
    expect(reloadWords([])).toBeNull()
  })

  test('goes by the page’s own word, and only by that', () => {
    expect(notLoaded('not_loaded')).toBe(true)
    for (const said of ['yes', 'no', null, undefined] as const) expect(notLoaded(said)).toBe(false)
  })

  test('lets go by its own clock of a conversation whose machine has gone quiet', () => {
    expect(standing([one, other], 60_000, 20_000)).toEqual([other])
    expect(standing([one, other], 200_000, 20_000)).toEqual([])
  })
})
