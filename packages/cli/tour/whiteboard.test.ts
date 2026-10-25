import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'

const page = readFileSync(new URL('./pages/whiteboard.html', import.meta.url), 'utf8')
const start = page.indexOf('    function snapshot(')
const end = page.indexOf('    sendBtn.addEventListener', start)
const fitting = page.slice(start, end)
/** What stands for the picture: it goes beside the action as a file, and is nothing in what the action carries as text. */
const PICTURE = { file: 'the picture' }
const stroke = (points: number) => ({
  width: 5,
  erase: false,
  color: '#0e0e10',
  points: Array.from({ length: points }, (_, i) => [(i % 997) / 997, (i % 991) / 991]),
})

/** The page's fitting functions, with each measured candidate counted rather than timed. */
function fitted(mine: ReturnType<typeof stroke>[], picture: object | null, limit: number) {
  let measured = 0
  const data = runInNewContext(`${fitting}\nfitted(png)`, {
    mine,
    png: picture,
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
  test('many dots and a long line go as their picture alone, without searching drawings whose ends cannot fit', () => {
    const mine = [...Array.from({ length: 600 }, () => stroke(1)), stroke(8000)]
    const { data, measured } = fitted(mine, PICTURE, 1)
    expect(data).toEqual({ png: PICTURE, strokes: [] })
    expect(measured).toBe(1)
  })

  test('a drawing whose ends cannot fit, with no picture to be had, stops after measuring them once', () => {
    const mine = [...Array.from({ length: 600 }, () => stroke(1)), stroke(8000)]
    const { data, measured } = fitted(mine, null, 1)
    expect(data).toBeNull()
    expect(measured).toBe(1)
  })

  test('a long line beside many dots goes beside the picture, fitted with a bounded number of measured drawings, and retains both ends', () => {
    const line = stroke(8000)
    const mine = [...Array.from({ length: 480 }, () => stroke(1)), line]
    const { data, measured } = fitted(mine, PICTURE, Math.ceil(Math.log2(line.points.length)) + 2)
    expect(measured).toBeGreaterThan(1)
    expect(data.png).toEqual(PICTURE)
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(30000)
    expect(data.strokes).toHaveLength(mine.length)
    const points = data.strokes.at(-1).points
    expect(points.length).toBeGreaterThan(2)
    expect([points[0], points.at(-1)]).toEqual([[0, 0], line.points.at(-1)!.map((n) => Math.round(n * 1000) / 1000)])
  })
})
