import { execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { BLOCK, bases, holdBase } from './test-ports'

const here = path.dirname(fileURLToPath(import.meta.url))
// This file's own blocks, which no other file of tests takes a base from
const FIRST = 17_800
const listens = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

describe('a base port held for a test', () => {
  test('is held until it is given back: a second taker of the only block gets none meanwhile, and gets it afterwards', async () => {
    const one = await holdBase(FIRST, 1)
    expect(one.base).toBe(FIRST)
    await expect(holdBase(FIRST, 1, 1)).rejects.toThrow('none of the 1 base ports')
    await one.release()
    const again = await holdBase(FIRST, 1, 1)
    expect(again.base).toBe(FIRST)
    await again.release()
  })

  test('is not given where something listens on a port the service would count from it, and the block is left free for whoever comes next', async () => {
    const first = FIRST + BLOCK
    const inTheWay = net.createServer()
    await new Promise<void>((resolve) => inTheWay.listen(first + 41, '127.0.0.1', () => resolve()))
    try {
      await expect(holdBase(first, 1, 1)).rejects.toThrow('none of the 1 base ports')
      // Nothing is left holding the block
      expect(await listens(first + BLOCK - 1)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => inTheWay.close(() => resolve()))
    }
  })

  test('is another one for each taker at the same moment, and all are given back together', async () => {
    const first = FIRST + 2 * BLOCK
    const mine = bases(first, 2)
    const taken = await Promise.all([mine.next(), mine.next()])
    expect([...taken].sort()).toEqual([first, first + BLOCK])
    await mine.release()
    expect(await Promise.all(taken.map((base) => listens(base + BLOCK - 1)))).toEqual([true, true])
  })

  test('is held against another program on the machine, and is free again when the program that held it has ended without giving it back', async () => {
    const first = FIRST + 4 * BLOCK
    // Another program takes the only block, says so, and stays until it is ended
    const holder = [
      `import { holdBase } from ${JSON.stringify(pathToFileURL(path.join(here, 'test-ports.ts')).href)}`,
      `const one = await holdBase(${first}, 1)`,
      `console.log(one.base)`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    const child = execFile(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', holder])
    // Waited for from the start, so that a program that ended by itself is not waited for without end
    const ended = new Promise<void>((resolve) => child.once('close', () => resolve()))
    let complained = ''
    child.stderr?.on('data', (d) => (complained += d))
    try {
      const said = await new Promise<string>((resolve, reject) => {
        child.stdout?.once('data', (d) => resolve(String(d).trim()))
        child.once('close', (code) =>
          reject(new Error(`the other program ended with ${code} before it had a base, and said: ${complained.trim().slice(0, 400)}`)),
        )
      })
      expect(said).toBe(String(first))
      await expect(holdBase(first, 1, 1)).rejects.toThrow('none of the 1 base ports')
    } finally {
      child.kill('SIGKILL')
      await ended
    }
    const mine = await holdBase(first, 1, 8)
    expect(mine.base).toBe(first)
    await mine.release()
  })
})
