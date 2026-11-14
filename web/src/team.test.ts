// What the Team page says before a teammate is removed, and how it marks who is shown a page.
import { describe, expect, test } from 'vitest'
import { markOf, removing } from './team'

describe('the Team page', () => {
  test('says how many browsers end and how many pages come back before a teammate is removed', () => {
    expect(removing({ name: 'Ada', browsers: 2, reviewing: 1 })).toBe(
      'Remove Ada from the team? This ends 2 browsers paired for them and everything that came from them, and takes back 1 page that is out with them.',
    )
    expect(removing({ name: 'Ada', browsers: 1, reviewing: 0 })).toBe(
      'Remove Ada from the team? This ends 1 browser paired for them and everything that came from it, and takes back 0 pages that are out with them.',
    )
  })
  test('marks a page private until it is shared with the team or out for review', () => {
    expect(markOf({})).toBe('Private')
    expect(markOf({ sent: 1 })).toBe('Out for review')
    expect(markOf({ team: true, sent: 1 })).toBe('Team')
  })
})
