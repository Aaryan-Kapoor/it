import { describe, expect, test } from 'vitest'
import { reportedConnection } from './readiness'

describe('reported app readiness from an older backend', () => {
  test('the app selection takes precedence over a stale connected report', () => {
    expect(reportedConnection('codex', { wanted: [], harnesses: [{ id: 'codex', addon: 'connected', version: '0.160.0' }] })).toEqual({
      harness: 'codex',
      state: 'disconnected',
      queue: false,
    })
  })
  test.each([
    ['0.159.0', false],
    ['0.160.0', true],
    ['0.161.0', true],
    [undefined, false],
    ['unknown', false],
    ['99999999.0.0', false],
  ])('Codex %s can use the queue while its hooks await approval: %s', (version, queue) => {
    expect(reportedConnection('codex', { wanted: ['codex'], harnesses: [{ id: 'codex', addon: 'needs_approval', version }] })).toEqual({
      harness: 'codex',
      state: 'needs_approval',
      queue,
    })
  })
  test('an unreported or unrecognized add-on state is unknown', () => {
    expect(reportedConnection('pi', { wanted: ['pi'] })?.state).toBe('unknown')
    expect(reportedConnection('pi', { wanted: ['pi'], harnesses: [{ id: 'pi', addon: 'future-state' }] })?.state).toBe('unknown')
    expect(reportedConnection('pi', undefined)).toBeUndefined()
  })
})
