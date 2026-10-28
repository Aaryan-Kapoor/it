import { createHash } from 'node:crypto'
import { gunzipSync as inflate } from 'node:zlib'
import { expect, test, vi } from 'vitest'

test('the generated functions stay compressed until deployment asks for them', async () => {
  vi.resetModules()
  const gunzipSync = vi.fn(inflate)
  vi.doMock('node:zlib', () => ({ gunzipSync }))
  try {
    const generated = await import('./src/functions.generated')
    expect(gunzipSync).not.toHaveBeenCalled()
    expect(generated.functions).toBeTypeOf('function')
    const text = generated.functions()
    expect(gunzipSync).toHaveBeenCalledTimes(1)
    expect(createHash('sha256').update(text).digest('hex')).toBe(generated.FUNCTIONS_HASH)
    expect(Buffer.byteLength(generated.FUNCTIONS_GZIP, 'base64')).toBeLessThan(Buffer.byteLength(text))
    expect(JSON.parse(text)).not.toHaveProperty('adminKey')
  } finally {
    vi.doUnmock('node:zlib')
    vi.resetModules()
  }
})
