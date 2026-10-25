// The checksum the site takes a file by, held to the one every other part of It computes.
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { Sha256, sha256Of } from './sha256'

const theirs = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('the checksum of a file', () => {
  test('is SHA-256, for every length a block can end at, given whole or a piece at a time', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096 + 7]) {
      const bytes = new Uint8Array(randomBytes(n))
      expect([n, new Sha256().update(bytes).hex()]).toEqual([n, theirs(bytes)])
      const pieces = new Sha256()
      for (let at = 0; at < n; at += 13) pieces.update(bytes.subarray(at, at + 13))
      expect([n, pieces.hex()]).toEqual([n, theirs(bytes)])
    }
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('is read from a file a piece at a time, across the places the pieces meet', async () => {
    const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 3))
    expect(await sha256Of(new Blob([bytes]))).toBe(theirs(bytes))
    expect(await sha256Of(new Blob([]))).toBe(theirs(new Uint8Array(0)))
  })
})
