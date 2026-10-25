// The files a page sent with a click, kept in this browser until It has them, beside the click
// itself in the outbox (outbox.ts). A click is kept in the browser's `localStorage`, which holds
// a few megabytes for the whole site, and a few photos would fill it: so a click keeps there
// only what its files are, and their bytes are kept here, in the browser's IndexedDB, under the
// click's own name. That name begins with whose click it is, as everything the outbox keeps
// does, so that letting go of one person's things finds theirs.

/** At most so many bytes may be kept under names that begin with `under`: the files of one person's unsent clicks. */
export interface Room {
  under: string
  most: number
}

/** Where the bytes are kept. A test gives one that keeps them in memory. */
export interface ByteStore {
  /**
   * Keeps the files of a click, where they and what is kept already under `room.under` come to
   * no more than `room.most`, and answers 'full' where they would. The looking and the keeping
   * are one step, which no other tab of the browser comes between: two clicks sent at once
   * cannot both be let into the last of the room.
   */
  put(key: string, files: Blob[], room: Room): Promise<'kept' | 'full'>
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

/** How many bytes the files of a record come to. */
const bytesOf = (files: Blob[]) => files.reduce((n, f) => n + f.size, 0)

const indexed: ByteStore = {
  // In one transaction that writes, which the browser runs alone among every tab's transactions
  // on the store: what is kept already is read, and the files are put only where they fit
  put: async (key, files, room) => {
    const db = await database()
    return new Promise<'kept' | 'full'>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      let said: 'kept' | 'full' = 'kept'
      const all = store.getAll() as IDBRequest<{ key: string; files: Blob[] }[]>
      all.onsuccess = () => {
        const taken = all.result.filter((r) => r.key !== key && r.key.startsWith(room.under)).reduce((n, r) => n + bytesOf(r.files), 0)
        if (taken + bytesOf(files) > room.most) said = 'full'
        else store.put({ key, files, at: Date.now() })
      }
      tx.oncomplete = () => resolve(said)
      tx.onerror = () => reject(tx.error ?? new Error('The files could not be kept in this browser.'))
      tx.onabort = () => reject(tx.error ?? new Error('The files could not be kept in this browser.'))
    })
  },
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
    // Nothing is waited for between the looking and the keeping, so nothing comes between them
    put: async (key, files, room) => {
      const taken = [...held].filter(([k]) => k !== key && k.startsWith(room.under)).reduce((n, [, v]) => n + bytesOf(v.files), 0)
      if (taken + bytesOf(files) > room.most) return 'full'
      held.set(key, { files, at: Date.now() })
      return 'kept'
    },
    get: async (key) => held.get(key)?.files ?? null,
    remove: async (key) => void held.delete(key),
    list: async () => [...held].map(([key, { at }]) => ({ key, at })),
  }
}
