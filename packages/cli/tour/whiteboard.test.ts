import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'

const page = readFileSync(new URL('./pages/whiteboard.html', import.meta.url), 'utf8')
const start = page.indexOf('    function snapshot(')
const end = page.indexOf('    sendBtn.addEventListener', start)
const fitting = page.slice(start, end)
const PICTURE = `data:image/png;base64,${'A'.repeat(9000)}`
const stroke = (points: number) => ({
  width: 5,
  erase: false,
  color: '#0e0e10',
  points: Array.from({ length: points }, (_, i) => [(i % 997) / 997, (i % 991) / 991]),
})

/** The page's fitting functions, with each measured candidate counted rather than timed. */
function fitted(mine: ReturnType<typeof stroke>[], picture: string | null, limit: number) {
  let measured = 0
  const data = runInNewContext(`${fitting}\nfitted()`, {
    mine,
    picture: () => picture,
    TextEncoder: class extends TextEncoder {
      override encode(value: string) {
        measured++
        expect(measured).toBeLessThanOrEqual(limit)
        return super.encode(value)
      }
    },
  })
  return { data, measured }
}

describe('the whiteboard fitting', () => {
  test('many dots and a long line go as their picture without searching drawings whose ends cannot fit', () => {
    const mine = [...Array.from({ length: 600 }, () => stroke(1)), stroke(8000)]
    const { data, measured } = fitted(mine, PICTURE, 2)
    expect(data).toEqual({ png: PICTURE, strokes: [] })
    expect(measured).toBe(2)
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(30000)
  })

  test('a drawing whose ends and picture cannot fit stops after measuring those two choices', () => {
    const mine = [...Array.from({ length: 600 }, () => stroke(1)), stroke(8000)]
    const { data, measured } = fitted(mine, `data:image/png;base64,${'A'.repeat(40_000)}`, 2)
    expect(data).toBeNull()
    expect(measured).toBe(2)
  })

  test('a long line beside many dots is fitted with a bounded number of measured drawings and retains both ends', () => {
    const line = stroke(8000)
    const mine = [...Array.from({ length: 480 }, () => stroke(1)), line]
    const { data, measured } = fitted(mine, PICTURE, 2 * (Math.ceil(Math.log2(line.points.length)) + 2))
    expect(measured).toBeGreaterThan(1)
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(30000)
    expect(data.strokes).toHaveLength(mine.length)
    const points = data.strokes.at(-1).points
    expect(points.length).toBeGreaterThan(2)
    expect([points[0], points.at(-1)]).toEqual([[0, 0], line.points.at(-1)!.map((n) => Math.round(n * 1000) / 1000)])
  })
})
