// The files a page sends with a click, as the site's outbox keeps and sends them: taken by It,
// uploaded and found whole before the click is sent; kept in this browser, apart from the click,
// while they are not; and let go of with it.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { inMemory, keepBytesIn } from './kept'
import { forgetAll, keepFor } from './lib'
import { drain, outboxBelongsTo, type Sent, submit, tidyBytes, unsaved, unsent } from './outbox'

const envelope = (id: string, payload = '{"photo":{"file":1}}'): Sent => ({ v: 1, clientActionId: id, name: 'receipt', payload, contentVersion: 1 })
const photo = (size = 5000, name = 'receipt.jpg') => new File([new Uint8Array(size).fill(7)], name, { type: 'image/jpeg' })
const stored = () => Object.keys(localStorage).filter((k) => k.startsWith('it.outbox.'))
let connected = true

/**
 * Stands in for It: the backend, which takes a click's files and then the click, and the door,
 * which takes their bytes. `holds` is how many of the files It has whole; `uploads` lists each
 * upload as it arrived; `door` says how each is answered.
 */
function it() {
  const state = {
    holds: 0,
    files: 0,
    uploads: [] as { n: number; grant: string; sha256: string; bytes: number }[],
    prepared: [] as Record<string, unknown>[],
    submitted: [] as Record<string, unknown>[],
    door: (_n: number): number | 'offline' => 200,
    prepare: (): ConvexError<any> | null => null,
  }
  const action = vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
    expect(getFunctionName(fn as never)).toBe('files:prepare')
    state.prepared.push(args)
    const refused = state.prepare()
    if (refused) throw refused
    state.files = (args.files as unknown[]).length
    if (state.holds >= state.files) return { id: 'att1', stored: true }
    // As the backend answers: which of them are still to come, by number
    const missing = Array.from({ length: state.files }, (_, i) => i + 1).filter((n) => n > state.holds)
    return { id: 'att1', stored: false, missing, grant: `grant-${state.prepared.length}` }
  })
  const mutation = vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
    if (getFunctionName(fn as never) === 'actions:replayGrant') return { until: Date.now() + 6 * 86400_000 }
    state.submitted.push(args)
    return { actionId: 'a1' }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const n = Number(String(url).split('/upload/')[1])
      const said = state.door(n)
      if (said === 'offline') throw new TypeError('Failed to fetch')
      const headers = init.headers as Record<string, string>
      state.uploads.push({ n, grant: headers.authorization!.slice(7), sha256: headers['x-it-sha256']!, bytes: (init.body as Blob).size })
      if (said === 200) state.holds = Math.max(state.holds, n)
      return new Response(null, { status: said })
    }),
  )
  return { client: { mutation, action, connectionState: () => ({ isWebSocketConnected: connected }) } as never, state }
}

let bytes: ReturnType<typeof inMemory>
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  connected = true
  bytes = inMemory()
  keepBytesIn(bytes)
  outboxBelongsTo(null)
  keepFor('alice')
  outboxBelongsTo('alice')
})
afterEach(() => vi.unstubAllGlobals())

describe('a click with files', () => {
  test('has them taken by It, uploaded, and found whole before the click is sent, naming them; and leaves nothing behind', async () => {
    const b = it()
    const file = photo()
    const sheet = new File(['a,b\n1,2\n'], 'totals.csv', { type: 'text/csv' })
    expect(await submit(b.client, 'alice', 'page1', envelope('click-files-01'), () => true, undefined, [file, sheet])).toEqual({ actionId: 'a1' })
    // What each file is, which It takes it by: the name the page gave it, its kind, its size and its checksum
    expect(b.state.prepared[0]).toMatchObject({
      artifactId: 'page1',
      clientActionId: 'click-files-01',
      files: [
        { name: 'receipt.jpg', type: 'image/jpeg', size: 5000, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { name: 'totals.csv', type: 'text/csv', size: 8, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    })
    expect(b.state.uploads.map((u) => [u.n, u.grant, u.bytes])).toEqual([
      [1, 'grant-1', 5000],
      [2, 'grant-1', 8],
    ])
    // Asked again once they were uploaded, and found: only then is the click sent, with them
    expect(b.state.prepared).toHaveLength(2)
    expect(b.state.submitted).toEqual([
      expect.objectContaining({ attachment: 'att1', envelope: expect.objectContaining({ clientActionId: 'click-files-01' }) }),
    ])
    expect(stored()).toEqual([])
    expect(bytes.held.size).toBe(0)
  })

  test('keeps its files in this browser apart from the click, which holds only what they are, until It has them', async () => {
    const b = it()
    let release!: () => void
    // The door does not answer yet: the click is on its way
    b.state.door = () => 200
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Response(null, { status: 200 }))
        }),
    )
    const sending = submit(b.client, 'alice', 'page1', envelope('click-files-02'), () => true, undefined, [photo(20_000)])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const [key] = stored()
    const entry = JSON.parse(localStorage.getItem(key!)!)
    expect(entry.files).toEqual([{ name: 'receipt.jpg', type: 'image/jpeg', size: 20_000, sha256: expect.any(String) }])
    // The click in localStorage is small: the bytes are kept apart, under its name
    expect(localStorage.getItem(key!)!.length).toBeLessThan(2000)
    expect((await bytes.get(key!))?.map((f) => f.size)).toEqual([20_000])
    b.state.holds = 1
    release()
    await sending
    expect(stored()).toEqual([])
    expect(bytes.held.size).toBe(0)
  })

  test('waits out a dropped connection while its page is there, and does not send again a file that had arrived', async () => {
    const b = it()
    let offline = 1
    // The first file arrives; the connection goes as the second is sent, and comes back
    b.state.door = (n) => (n === 2 && offline-- > 0 ? 'offline' : 200)
    const done = submit(b.client, 'alice', 'page1', envelope('click-files-03'), () => true, undefined, [photo(100), photo(200, 'b.jpg')])
    await expect(done).resolves.toEqual({ actionId: 'a1' })
    expect(b.state.uploads.map((u) => u.n)).toEqual([1, 2])
    expect(b.state.submitted).toHaveLength(1)
    expect(stored()).toEqual([])
  })

  test('stays kept, files and all, when its page goes while there is no connection, and is sent once it is back, from what was kept', async () => {
    const b = it()
    let there = true
    b.state.door = () => 'offline'
    const done = submit(b.client, 'alice', 'page1', envelope('click-files-04'), () => there, undefined, [photo(300)])
    await vi.waitFor(() => expect(b.state.prepared.length).toBeGreaterThan(0))
    there = false
    await expect(done).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toHaveLength(1)
    expect(bytes.held.size).toBe(1)
    expect(unsent('alice', 'page1')).toBe(1)
    // The connection comes back: what was left is sent, its file read from where it was kept
    b.state.door = () => 200
    await drain(b.client, 'alice')
    expect(b.state.submitted).toEqual([expect.objectContaining({ attachment: 'att1' })])
    expect(stored()).toEqual([])
    expect(bytes.held.size).toBe(0)
  })

  test('is not sent and not kept where its files are no longer kept in this browser', async () => {
    const b = it()
    const key = 'it.outbox.alice.page1.click-files-05'
    const files = [{ name: 'a.jpg', type: 'image/jpeg', size: 10, sha256: 'a'.repeat(64) }]
    localStorage.setItem(
      key,
      JSON.stringify({
        user: 'alice',
        artifactId: 'page1',
        envelope: envelope('click-files-05'),
        files,
        format: 2,
        session: null,
        at: Date.now() - 60_000,
        left: true,
      }),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await drain(b.client, 'alice')
    expect(b.state.submitted).toEqual([])
    expect(stored()).toEqual([])
    vi.restoreAllMocks()
  })

  test('is held to what one action may carry, and to what this browser keeps unsent, before anything is kept or sent', async () => {
    const b = it()
    const send = (id: string, files: Blob[]) =>
      submit(b.client, 'alice', 'page1', envelope(id), () => true, undefined, files).then(
        () => 'sent',
        (e: Error) => e.message,
      )
    expect(
      await send(
        'click-many-001',
        Array.from({ length: 11 }, () => photo(1)),
      ),
    ).toBe('An action carries at most 10 files.')
    expect(await send('click-large-01', [new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'big.mov')])).toBe('A file sent with an action is at most 25 MB.')
    // What is kept unsent already, of the person's, counts: a browser does not fill with files
    localStorage.setItem(
      'it.outbox.alice.page2.click-waiting-1',
      JSON.stringify({
        user: 'alice',
        artifactId: 'page2',
        envelope: envelope('click-waiting-1'),
        files: [{ name: 'v.mov', type: 'video/quicktime', size: 99 * 1024 * 1024, sha256: 'b'.repeat(64) }],
        format: 2,
        session: null,
        at: Date.now(),
        held: Date.now() + 60_000,
      }),
    )
    expect(await send('click-room-001', [photo(2 * 1024 * 1024)])).toMatch(/^Too many files are still waiting to be sent from this browser/)
    expect(b.state.prepared).toEqual([])
    expect(b.state.uploads).toEqual([])
  })

  test('where this browser keeps no files, is sent from this tab while it is open, and said not to be saved meanwhile; with no connection it is refused at once', async () => {
    const b = it()
    keepBytesIn({ ...bytes, put: () => Promise.reject(new Error('no room')) })
    let release!: () => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Response(null, { status: 200 }))
        }),
    )
    const sending = submit(b.client, 'alice', 'page1', envelope('click-unkept-1'), () => true, undefined, [photo(10)])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect([stored(), unsaved('alice', 'page1')]).toEqual([[], 1])
    b.state.holds = 1
    release()
    await expect(sending).resolves.toEqual({ actionId: 'a1' })
    expect(unsaved('alice', 'page1')).toBe(0)
    connected = false
    await expect(submit(b.client, 'alice', 'page1', envelope('click-unkept-2'), () => true, undefined, [photo(10)])).rejects.toThrow(
      'This could not be saved or sent. Check the connection and try again.',
    )
  })

  test('has its files let go of with everything else when everything is erased, and a file left with no click goes after a while', async () => {
    const key = 'it.outbox.alice.page1.click-erased-1'
    await bytes.put(key, [photo(10)])
    await bytes.put('it.outbox.bob.page1.click-bobs-0001', [photo(10)])
    localStorage.setItem(key, JSON.stringify({ user: 'alice', artifactId: 'page1', envelope: envelope('click-erased-1'), at: Date.now() }))
    forgetAll('alice')
    await vi.waitFor(() => expect([...bytes.held.keys()]).toEqual([]))
    // Bytes kept a moment before their click are left, and bytes whose click has gone are cleared once that moment is over
    await bytes.put('it.outbox.alice.page1.click-alone-01', [photo(10)])
    await tidyBytes()
    expect([...bytes.held.keys()]).toEqual(['it.outbox.alice.page1.click-alone-01'])
    bytes.held.get('it.outbox.alice.page1.click-alone-01')!.at -= 120_000
    await tidyBytes()
    expect([...bytes.held.keys()]).toEqual([])
  })
})
