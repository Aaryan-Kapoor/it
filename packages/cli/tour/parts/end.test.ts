// The ending of the tour’s first page.
import { describe, expect, test } from 'vitest'
import { opened, SLOW } from '../start-page'

describe('the ending', () => {
  test('“Go to my pages” asks the agent to finish, and is the person’s to press again where nothing comes of it', async () => {
    const page = await opened()
    page.$('#skip').click()
    page.$('#fin').click()
    const finish = page.sentOf('finish')[0]!
    expect(finish.data).toEqual({ part: 'end', from: 'start' })
    expect(page.$('#fin').disabled).toBe(true)
    await finish.accept()
    // The dock says where the asking has got to. The answer is the page going, so nothing more is drawn here
    expect([page.read('end').stage, page.read('end').did]).toEqual(['took', 'asked for your pages'])
    expect(page.read('end').hint).toBe('Claude Code takes the tour away, and then you are at your pages.')
    await page.advance(SLOW)
    expect([page.$('#fin').disabled, page.read('end').stage]).toEqual([false, 'slow'])
    page.$('#fin').click()
    await page.sentOf('finish')[1]!.refuse()
    expect([page.$('#fin').disabled, page.read('end').stage]).toEqual([false, 'refused'])
    page.close()
  })
})
