// The files a page sent with a click, kept in this browser until It has them, beside the click
// itself in the outbox (outbox.ts). A click is kept in the browser's `localStorage`, which holds
// a few megabytes for the whole site, and a few photos would fill it: so a click keeps there
// only what its files are, and their bytes are kept here, in the browser's IndexedDB, under the
// click's own name. That name begins with whose click it is, as everything the outbox keeps
// does, so that letting go of one person's things finds theirs.

/** Where the bytes are kept. A test gives one that keeps them in memory. */
export interface ByteStore {
  put(key: string, files: Blob[]): Promise<void>
  /** The files kept under a click's name, or nothing where none are. */
  get(key: string): Promise<Blob[] | null>
  remove(key: string): Promise<void>
  /** The name of every click whose files are kept, with when they were kept. */
  list(): Promise<{ key: string; at: number }[]>
}

const DB = 'it-outbox'
const STORE = 'files'

let opening: Promise<IDBDatabase> | null = null
function database(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser keeps no files for the site.'))
    const asked = indexedDB.open(DB, 1)
    asked.onupgradeneeded = () => asked.result.createObjectStore(STORE, { keyPath: 'key' })
    asked.onsuccess = () => {
      const db = asked.result
      // Another tab that needs the database changed lets go of this one, which is opened again when next asked
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    asked.onerror = () => reject(asked.error ?? new Error('The files could not be kept in this browser.'))
    asked.onblocked = () => reject(new Error('The files could not be kept in this browser just now.'))
  })
  // Not opened, as in a private window that keeps nothing: asked again next time
  opening.catch(() => {
    opening = null
  })
  return opening
}

/** Does one thing with the store, and answers once it is done and on the disk, as far as the browser says. */
async function within<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const asked = work(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(asked.result)
    tx.onerror = () => reject(tx.error ?? new Error('The files could not be kept in this browser.'))
    tx.onabort = () => reject(tx.error ?? new Error('The files could not be kept in this browser.'))
  })
}

const indexed: ByteStore = {
  put: (key, files) => within('readwrite', (s) => s.put({ key, files, at: Date.now() })).then(() => {}),
  get: (key) => within('readonly', (s) => s.get(key) as IDBRequest<{ files: Blob[] } | undefined>).then((kept) => kept?.files ?? null),
  remove: (key) => within('readwrite', (s) => s.delete(key)).then(() => {}),
  list: () => within('readonly', (s) => s.getAll() as IDBRequest<{ key: string; at: number }[]>).then((all) => all.map(({ key, at }) => ({ key, at }))),
}

let store: ByteStore = indexed
/** Where the bytes are kept now. */
export const kept = (): ByteStore => store
/** Keeps them somewhere else from now on, as a test does. */
export const keepBytesIn = (other: ByteStore): void => {
  store = other
}
/** A store that keeps them in this tab's memory, and nowhere else. */
export function inMemory(): ByteStore & { held: Map<string, { files: Blob[]; at: number }> } {
  const held = new Map<string, { files: Blob[]; at: number }>()
  return {
    held,
    put: async (key, files) => void held.set(key, { files, at: Date.now() }),
    get: async (key) => held.get(key)?.files ?? null,
    remove: async (key) => void held.delete(key),
    list: async () => [...held].map(([key, { at }]) => ({ key, at })),
  }
}
