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
/** Room enough for anything, where a test only means to put files there. */
const ANY_ROOM = { under: '', most: Number.POSITIVE_INFINITY }
const MB = 1024 * 1024

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

  test('waits between rounds where the door keeps refusing its grant, and does not ask It again and again', async () => {
    const b = it()
    let there = true
    b.state.door = () => 401
    const done = submit(b.client, 'alice', 'page1', envelope('click-refused-01'), () => there, undefined, [photo(100)])
    await new Promise((r) => setTimeout(r, 3500))
    // A round, a second at once with a fresh grant, and then only so many more with waits between
    expect(b.state.prepared.length).toBeGreaterThanOrEqual(2)
    expect(b.state.prepared.length).toBeLessThanOrEqual(5)
    // The page goes: it is told, and the click stays kept for later
    there = false
    await expect(done).rejects.toBeInstanceOf(ConvexError)
    expect(stored()).toHaveLength(1)
  }, 30_000)

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
    // What is kept unsent already, of the person's, counts, whichever tab kept it: a browser does not fill with files
    bytes.held.set('it.outbox.alice.page2.click-waiting-1', { files: [{ size: 99 * MB } as Blob], at: Date.now() })
    // Another person's files are theirs, and take none of this person's room
    bytes.held.set('it.outbox.bob.page2.click-bobs-waiting', { files: [{ size: 99 * MB } as Blob], at: Date.now() })
    expect(await send('click-room-001', [photo(2 * 1024 * 1024)])).toMatch(/^Too many files are still waiting to be sent from this browser/)
    expect(b.state.prepared).toEqual([])
    expect(b.state.uploads).toEqual([])
  })

  test('sent several at once, from one tab or many, is held to the room this browser keeps for files all the same: the click past it is refused, and not kept', async () => {
    const b = it()
    // Nothing is answered, so that each click that is let in stays kept, as with no connection
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const half = () => [new File([new Uint8Array(17 * MB)], 'a.mov'), new File([new Uint8Array(17 * MB)], 'b.mov')]
    const sent = await Promise.allSettled(
      ['click-at-once-1', 'click-at-once-2', 'click-at-once-3'].map((id) =>
        Promise.race([
          submit(b.client, 'alice', 'page1', envelope(id), () => true, undefined, half()),
          new Promise((resolve) => setTimeout(() => resolve('still on its way'), 8000)),
        ]),
      ),
    )
    const said = sent.map((r) => (r.status === 'fulfilled' ? r.value : (r.reason as Error).message))
    expect(said.filter((s) => s === 'still on its way')).toHaveLength(2)
    expect(said.filter((s) => /^Too many files are still waiting to be sent from this browser/.test(String(s)))).toHaveLength(1)
    expect([...bytes.held.values()].map((v) => v.files.reduce((n, f) => n + f.size, 0))).toEqual([34 * MB, 34 * MB])
    expect(stored()).toHaveLength(2)
  }, 30_000)

  test.each([
    ['everything is erased', () => forgetAll('alice')],
    ['the browser is paired for someone else', () => outboxBelongsTo('bob')],
  ])('keeps nothing of itself where, while its files were being kept, %s', async (_what, meanwhile) => {
    const b = it()
    // The browser takes its time keeping the files, and the pairing ends in that time
    let release!: () => void
    const slow = {
      ...bytes,
      put: (key: string, files: Blob[], room: { under: string; most: number }) =>
        new Promise<void>((r) => (release = r)).then(() => bytes.put(key, files, room)),
    }
    keepBytesIn(slow)
    const sending = submit(b.client, 'alice', 'page1', envelope('click-meanwhile-1'), () => true, undefined, [photo(10)]).then(
      () => 'sent',
      (e: Error) => e.message,
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    meanwhile()
    release()
    expect(await sending).toBe('This browser’s pairing has ended.')
    await vi.waitFor(() => expect([...bytes.held.keys()]).toEqual([]))
    expect(stored()).toEqual([])
    expect(b.state.prepared).toEqual([])
  })

  test.each([
    ['the browser is paired again', () => outboxBelongsTo('alice', 'session-new')],
    ['the browser finds it is paired for nobody', () => outboxBelongsTo(null)],
  ])('has its files let go of at once, however lately they were kept, where its pairing ends and %s', async (_what, ending) => {
    outboxBelongsTo('alice', 'session-old')
    const key = 'it.outbox.alice.page1.click-ended-0001'
    // Saved a moment ago, and its sender gone: the files are as new as the click
    await bytes.put(key, [photo(10)], ANY_ROOM)
    const files = [{ name: 'a.jpg', type: 'image/jpeg', size: 10, sha256: 'a'.repeat(64) }]
    localStorage.setItem(
      key,
      JSON.stringify({
        user: 'alice',
        artifactId: 'page1',
        envelope: envelope('click-ended-0001'),
        files,
        format: 2,
        session: 'session-old',
        at: Date.now(),
        left: true,
      }),
    )
    ending()
    await vi.waitFor(() => expect([...bytes.held.keys()]).toEqual([]))
    expect(stored()).toEqual([])
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
    await bytes.put(key, [photo(10)], ANY_ROOM)
    await bytes.put('it.outbox.bob.page1.click-bobs-0001', [photo(10)], ANY_ROOM)
    localStorage.setItem(key, JSON.stringify({ user: 'alice', artifactId: 'page1', envelope: envelope('click-erased-1'), at: Date.now() }))
    forgetAll('alice')
    await vi.waitFor(() => expect([...bytes.held.keys()]).toEqual([]))
    // Bytes kept a moment before their click are left, and bytes whose click has gone are cleared once that moment is over
    await bytes.put('it.outbox.alice.page1.click-alone-01', [photo(10)], ANY_ROOM)
    await tidyBytes()
    expect([...bytes.held.keys()]).toEqual(['it.outbox.alice.page1.click-alone-01'])
    bytes.held.get('it.outbox.alice.page1.click-alone-01')!.at -= 120_000
    await tidyBytes()
    expect([...bytes.held.keys()]).toEqual([])
  })
})
