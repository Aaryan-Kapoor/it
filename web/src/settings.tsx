// The person's displays, and what It holds for them: adding a display, taking the records out,
// and erasing everything.
import { parseJson } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import qrcode from 'qrcode-generator'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { version } from '../package.json'
import { About } from './about'
import { Dialog } from './dialog'
import { ago, api, doneLeaving, forgetAll, type Id, noteErased, refusal, serverNow, startLeaving, useNow } from './lib'
import { NoAddress, OtherAddresses, useWhere } from './network'
import { thisPairing } from './outbox'
import { goesAlong, type Paired, PairedBrowsers } from './paired'
import { pushSupport, turnOffPush, turnOnPush } from './push'
import { current, signOut as endSession, recheck, spaced } from './session'

interface DisplayRow {
  id: string
  name: string
  named: boolean
  lastSeenAt: number
  push: boolean
  /** False for a display whose browser's pairing has ended. Said only where every display is listed. */
  paired?: boolean
}

/**
 * One display in a list. The browser it is being read on may turn its own notifications on and
 * off and give itself a name. Naming another display and forgetting any are the owner's.
 * `along` says what forgetting it ends besides its own browser's pairing, when it ends more.
 */
function DisplayItem({
  d,
  here,
  owner,
  now,
  act,
  along = '',
}: {
  d: DisplayRow
  here: boolean
  owner: boolean
  now: number
  act: (p: Promise<unknown>) => Promise<void>
  along?: string
}) {
  const convex = useConvex()
  const rename = useMutation(api.displays.rename)
  const forget = useMutation(api.displays.forget)
  const [name, setName] = useState<string | null>(null)
  const support = pushSupport()
  return (
    <li className="row">
      {name !== null ? (
        <form
          className="inline row-main"
          onSubmit={(e) => {
            e.preventDefault()
            void act(rename({ displayId: d.id as Id<'displays'>, name }).then(() => setName(null)))
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by the person a moment ago
            autoFocus
            aria-label="Display name"
            placeholder="Kitchen TV"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setName(null)}
          />
          <button type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button type="button" className="link" onClick={() => setName(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <span className="row-main">
          <span className="row-name">
            {d.name}
            {here && <span className="chip quiet">This display</span>}
            {d.paired === false && (
              <span className="chip quiet" title="Its browser’s pairing has ended. It shows nothing until that browser is paired again.">
                Not paired
              </span>
            )}
          </span>
          <span className="row-sub">
            {here ? 'Open now' : d.paired === false ? 'Shows nothing until its browser is paired again' : `Last open ${ago(d.lastSeenAt, now)}`}
          </span>
        </span>
      )}
      <span className="row-actions">
        {here && support !== 'unsupported' && (
          <label className="switch" title={support === 'needs-install' ? 'On an iPhone or iPad, add this site to the Home Screen first' : undefined}>
            <span>Notifications</span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={d.push}
              checked={d.push}
              onChange={() => {
                // Turned off for the session that asked, and for no later one
                const began = thisPairing()
                return act(
                  d.push
                    ? turnOffPush(convex, () => thisPairing() === began)
                    : turnOnPush(convex).then((r) => (r === 'on' ? undefined : Promise.reject(new Error(r)))),
                )
              }}
            />
          </label>
        )}
        {(owner || here) && name === null && (
          <button type="button" className="link" onClick={() => setName(d.named ? d.name : '')}>
            Rename
          </button>
        )}
        {owner && (
          <button
            type="button"
            className="link danger"
            onClick={() =>
              confirm(
                [
                  here
                    ? 'Forget this display? This browser is signed out, and has to be paired again before it can be used.'
                    : `Forget “${d.name}”? It is signed out, and pages open on it stop working, usually at once. It has to be paired again before it can be used.`,
                  along,
                ]
                  .filter(Boolean)
                  .join(' '),
              ) && act(forget({ displayId: d.id as Id<'displays'> }))
            }
          >
            Forget
          </button>
        )}
      </span>
    </li>
  )
}

/** Says what went wrong with the last thing asked, until something asked after it works. */
function useAct(): [string, (p: Promise<unknown>) => Promise<void>] {
  const [error, setError] = useState('')
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  return [error, act]
}

/** Every display there is, for the owner: each can be named or forgotten, and another can be added. */
export function Displays({ thisDisplay }: { thisDisplay?: string }) {
  const displays = useQuery(api.displays.list, {}) as DisplayRow[] | undefined
  // Forgetting a display ends the pairing of the browser that is that display, and with it what that browser let in
  const paired = useQuery(api.sessions.list, {}) as Paired[] | undefined
  const me = paired?.find((s) => s.mine)?.id
  const alongWith = (display: string) => goesAlong(paired?.find((s) => s.displays.some((d) => d.id === display))?.along, me)
  const now = useNow()
  const [error, act] = useAct()
  const [adding, setAdding] = useState(false)
  const done = useCallback(() => setAdding(false), [])
  if (displays === undefined) return <main className="list-view" role="status" />
  return (
    <main className="list-view">
      <header className="list-head">
        <h2>Displays</h2>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add a display
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows panel">
        {displays.map((d) => (
          <DisplayItem key={d.id} d={d} here={d.id === thisDisplay} owner now={now} act={act} along={alongWith(d.id)} />
        ))}
      </ul>
      <PairedBrowsers />
      {adding && <AddDisplay onClose={done} />}
    </main>
  )
}

/** How long a code to pair with lasts when the backend does not say. */
const CODE_MS = 10 * 60_000

/**
 * Adding a display: the backend makes a code that pairs one browser as a screen, once. It is
 * shown as an address to open on the other screen, as a QR code of that address, and in
 * letters to type there. The address is the machine's own on the person's network, which the
 * site is told once the network is on; until then the panel says how to turn it on, and the
 * address appears by itself when that is done.
 */
function AddDisplay({ onClose }: { onClose: () => void }) {
  const convex = useConvex()
  const where = useWhere()
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState('')
  const now = useNow(5_000)
  const add = useCallback(async () => {
    try {
      const r: { code: string; expiresAt?: number } = await convex.mutation(api.sessions.inviteScreen, {})
      setMade({ code: r.code, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : serverNow() + CODE_MS })
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    }
  }, [convex])
  // A code is made as the dialog opens: opening it is the asking
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void add()
  }, [add])
  const ranOut = made !== null && made.expiresAt <= now
  const address = made && where.address ? `${where.address}/pair#${encodeURIComponent(made.code)}` : null
  return (
    <Dialog eyebrow="Displays" title="Add a display" onClose={onClose} className="pairing">
      {ranOut ? (
        <>
          <p className="modal-lede">That code has run out.</p>
          <button type="button" className="primary" onClick={() => void add()}>
            Make another
          </button>
        </>
      ) : !made ? (
        !error && <p className="modal-lede">Making a code…</p>
      ) : address ? (
        <>
          <p className="modal-lede">Scan this on the other screen, or open the address there.</p>
          <Qr text={address} />
          <p className="mono pair-address">{address}</p>
          <OtherAddresses where={where} />
          <p className="pair-or">
            Or open <span className="mono">{where.address}</span> and type
          </p>
          <p className="mono pair-code">{spaced(made.code)}</p>
        </>
      ) : (
        <>
          <NoAddress where={where} />
          <p className="pair-or">
            A browser on this machine can use <span className="mono">{location.origin}</span> with
          </p>
          <p className="mono pair-code">{spaced(made.code)}</p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Done
        </button>
        {made && !ranOut && <span className="modal-sub">One screen, once, for ten minutes. It can open and answer every page, so pair only your own.</span>}
      </div>
    </Dialog>
  )
}

/** A QR code, drawn dark on white whatever the site's own colours are, since that is what a camera reads best. */
function Qr({ text }: { text: string }) {
  const { size, squares } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const size = qr.getModuleCount()
    let squares = ''
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) squares += `M${col} ${row}h1v1h-1z`
    return { size, squares }
  }, [text])
  // The empty margin a reader needs around the code to find it
  const edge = 4
  return (
    <svg
      className="qr"
      viewBox={`${-edge} ${-edge} ${size + 2 * edge} ${size + 2 * edge}`}
      role="img"
      aria-label="QR code of the address"
      shapeRendering="crispEdges"
    >
      <rect x={-edge} y={-edge} width={size + 2 * edge} height={size + 2 * edge} fill="#fff" />
      <path d={squares} fill="#000" />
    </svg>
  )
}

/** What the person types to confirm, which is also the word the backend asks for with a request of that weight. */
const PHRASE = 'erase everything'

export function Settings({ user, owner, display, onSignOut }: { user: string; owner: boolean; display: DisplayRow | null; onSignOut: () => void }) {
  const convex = useConvex()
  const requestDeletion = useMutation(api.account.requestDeletion)
  const now = useNow()
  const [rowError, act] = useAct()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typed, setTyped] = useState('')

  // Read a piece at a time and put together here, so that records of any size can be taken
  // away. The pieces are kept as separate pieces of text and handed to the browser as they are:
  // the whole history never has to fit in one string.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const download = async () => {
    setBusy(true)
    try {
      const start = await convex.mutation(api.account.exportStart, {})
      // Whose export this is. The backend refuses the rest to anyone else, so nothing is
      // downloaded that began as one person's and ended as another's.
      const owner = start.owner
      const still = () => {
        if (!alive.current) throw new Error('The export was stopped.')
      }
      const parts: string[] = [`{\n"exportedAt": ${start.exportedAt},\n"displays": ${JSON.stringify(start.displays)},\n"machines": [`]
      const list = async <T,>(fetchBatch: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>, shape: (item: T) => unknown) => {
        let first = true
        for (let cursor: string | null = null; ; ) {
          const batch = await fetchBatch(cursor)
          still()
          for (const item of batch.items) {
            parts.push(`${first ? '' : ','}\n${JSON.stringify(shape(item))}`)
            first = false
          }
          if (batch.next === null) break
          cursor = batch.next
        }
      }
      await list(
        async (cursor) => {
          const b = await convex.query(api.account.exportMachines, { owner, cursor })
          return { items: b.machines, next: b.next }
        },
        (m) => m,
      )
      parts.push('\n],\n"pages": [')
      let firstPage = true
      for (const artifactId of start.pages) {
        const page = await convex.query(api.account.exportPage, { artifactId })
        still()
        // The page's own record, left open so that its history can follow a batch at a time
        parts.push(`${firstPage ? '' : ','}\n${JSON.stringify({ ...page, state: parseJson(page.state) ?? {} }).slice(0, -1)},"actions": [`)
        firstPage = false
        await list(
          async (cursor) => {
            const b: { actions: { payload: string }[]; next: string | null } = await convex.query(api.account.exportActions, { artifactId, cursor })
            return { items: b.actions, next: b.next }
          },
          (a) => ({ ...a, payload: parseJson(a.payload) ?? null }),
        )
        parts.push('\n]}')
      }
      parts.push('\n],\n"notifications": [')
      await list(
        async (cursor) => {
          const b: { notifications: unknown[]; next: string | null } = await convex.query(api.account.exportNotifications, { owner, cursor })
          return { items: b.notifications, next: b.next }
        },
        (n) => n,
      )
      // Said last, and only when every piece was read
      parts.push('\n],\n"complete": true\n}\n')
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: `it-export-${new Date().toISOString().slice(0, 10)}.json` })
      document.body.append(a)
      a.click()
      a.remove()
      // Left a while before it is released: some browsers have not started the download yet
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      if (alive.current) setError('')
    } catch (err) {
      if (alive.current) setError(err instanceof Error && !('data' in err) && err.message === 'The export was stopped.' ? '' : refusal(err).message)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const erase = async () => {
    setBusy(true)
    try {
      // From here this browser is on its way out by its own doing: the rest of the site must
      // not sign it out from under the steps that follow
      startLeaving()
      // Whose records are erased is fixed now: the person this browser was paired for when they
      // confirmed. The backend refuses a request that names anyone but whoever is asking.
      const began = thisPairing()
      await requestDeletion({ confirm: PHRASE, user: user as Id<'users'> })
      // Everything It held is being erased. What this browser kept goes at once: which display
      // it is, what was done on a page and not yet sent, and the rest. Nothing that is still
      // under way for the person keeps any of it again, and the browser's other tabs are told.
      // The answer may come late, after It was set up again and this browser paired anew in
      // another tab: what is here is then the new person's, and only what was kept under the
      // erased person's id goes
      forgetAll(user)
      noteErased()
      // This browser's session went with everything else. It is ended here as well, so that the
      // browser lets go of its cookie, unless the browser has been paired again meanwhile
      const out = thisPairing() !== began || (await endSession())
      // And whatever the site wrote here while it was still on screen goes with the rest
      if (!current().paired) forgetAll(user)
      // The backend could not be reached to end it: the session is over there all the same, and the site finds that out for itself
      if (!out) {
        doneLeaving()
        void recheck()
      }
    } catch (err) {
      doneLeaving()
      setError(refusal(err).message)
      setBusy(false)
    }
  }
  const [erasing, setErasing] = useState(false)
  const closeErase = useCallback(() => {
    setErasing(false)
    setTyped('')
  }, [])
  return (
    <main className="list-view">
      <header className="list-head">
        <h2>Settings</h2>
      </header>
      {rowError && (
        <p className="error" role="alert">
          {rowError}
        </p>
      )}
      <section>
        <h3>This browser</h3>
        <ul className="rows panel">
          {display && <DisplayItem d={display} here owner={false} now={now} act={act} />}
          <li className="row">
            <span className="row-main">
              <span className="row-name">{owner ? 'Paired as yours' : 'Paired as a screen'}</span>
              <span className="row-sub">{owner ? 'Everything on the site can be done from here.' : 'It can open every page and answer on it.'}</span>
            </span>
            <span className="row-actions">
              <button type="button" onClick={onSignOut}>
                Sign out
              </button>
            </span>
          </li>
        </ul>
      </section>
      {owner && (
        <>
          <section>
            <h3>Data</h3>
            <ul className="rows panel">
              <li className="row">
                <span className="row-main">
                  <span className="row-name">Records</span>
                  <span className="row-sub">Pages, their state and what was done on them, as JSON. The files are not in it.</span>
                </span>
                <span className="row-actions">
                  <button type="button" disabled={busy} onClick={() => void download()}>
                    Download my data
                  </button>
                </span>
              </li>
              <li className="row">
                <span className="row-main">
                  <span className="row-name">Erase everything</span>
                  <span className="row-sub">Every page, file and record, and every pairing.</span>
                </span>
                <span className="row-actions">
                  <button type="button" className="danger" onClick={() => setErasing(true)}>
                    Erase…
                  </button>
                </span>
              </li>
            </ul>
          </section>
          <About />
        </>
      )}
      {error && !erasing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="list-foot">
        <span>{`It ${version}`}</span>
        <a href="/LICENSE.md" target="_blank" rel="noreferrer">
          License
        </a>
        <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
          Third-party notices
        </a>
      </p>
      {erasing && (
        <Dialog eyebrow="Settings" title="Erase everything" onClose={closeErase}>
          <p className="modal-lede">
            This removes every page, its files and every record of them, and signs out every display and machine. It cannot be undone. Afterwards, run{' '}
            <code>it setup</code> to use It again.
          </p>
          <div className="inline">
            <input autoFocus aria-label={`Type ${PHRASE} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={PHRASE} />
            <button type="button" className="danger solid" disabled={busy || typed.trim().toLowerCase() !== PHRASE} onClick={() => void erase()}>
              Erase everything
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </main>
  )
}
