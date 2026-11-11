// The studio of the tour’s first page, which is a place kept for a part that is still to be made.
import { describe, expect, test } from 'vitest'
import { opened } from '../start-page'

describe('the studio', () => {
  test('is a part like any other in the frame, shows that there is nothing to do yet, and sends nothing', async () => {
    const page = await opened()
    page.to('studio')
    expect(page.$('#title').textContent).toBe('A studio')
    expect(page.$('#studio-soon').textContent).toContain('still being made')
    expect(page.read('studio').stage).toBe('idle')
    await page.advance(60_000)
    page.$('#next').click()
    expect(page.shown()).toBe('chess')
    expect(page.sent).toEqual([])
    expect(page.errors).toEqual([])
    page.close()
  })
})
