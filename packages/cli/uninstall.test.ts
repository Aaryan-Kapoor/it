// The deferred deletion line is checked without moving a running program or changing the registry.
import { describe, expect, test } from 'vitest'
import { windowsDeletionCommand } from './src/lib'

describe('the deletion Windows runs at the next sign-in', () => {
  test('takes a percent-delimited name as the literal file path, including spaces, apostrophes and Unicode', () => {
    for (const file of [
      'C:\\%USERNAME%\\it.exe',
      "C:\\a b\\o'neil\\é.exe",
      'C:\\a’b\\it.exe',
      'C:\\Users\\someone\\AppData\\Local\\Temp\\it-removed-1234-mg11cvk4.exe',
    ]) {
      const line = windowsDeletionCommand(file)!
      expect(line).not.toContain('%USERNAME%')
      const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(line)?.[1]
      expect(encoded).toBeDefined()
      expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe(file)
      expect(line).toContain('-Command "Remove-Item -LiteralPath ([System.Text.Encoding]::UTF8.GetString(')
      expect(line).toMatch(/ -Force"$/)
      expect(line.length).toBeLessThanOrEqual(260)
    }
  })

  test('leaves a path for manual deletion when its encoded command is longer than RunOnce accepts', () => {
    expect(windowsDeletionCommand(`C:\\${'long folder\\'.repeat(30)}it.exe`)).toBeUndefined()
  })
})
