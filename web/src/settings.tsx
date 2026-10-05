// The person's displays, and what It holds for them: adding a display, taking the records out,
// and erasing everything.
import { parseJson } from '@it/protocol'
import { useConvex, useMutation, useQuery } from 'convex/react'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useRef, useState } from 'react'
import { REMOVED_STAYS, TASKS_STAY, WhatItDoes } from './about'
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
  return (
    <li className="panel row">
      {name !== null ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault()
            void act(rename({ displayId: d.id as Id<'displays'>, name }).then(() => setName(null)))
          }}
        >
          <input aria-label="Display name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button type="button" className="link" onClick={() => setName(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <span className="row-name">
          {d.name}
          {here && <span className="chip quiet">This display</span>}
          {d.paired === false && <span className="chip quiet">Not paired</span>}
          {!d.named && <span className="muted"> (not named yet)</span>}
        </span>
      )}
      <span className="muted">
        {here
          ? 'Open now'
          : d.paired === false
            ? 'Its browser’s pairing has ended. It shows nothing until that browser is paired again'
            : `Last open ${ago(d.lastSeenAt, now)}`}
        {d.push ? ' · notifications on' : ''}
      </span>
      <span className="grow" />
      {here && pushSupport() !== 'unsupported' && (
        <button
          type="button"
          className="link"
          onClick={() => {
            // Turned off for the session that asked, and for no later one
            const began = thisPairing()
            return act(
              d.push
                ? turnOffPush(convex, () => thisPairing() === began)
                : turnOnPush(convex).then((r) => (r === 'on' ? undefined : Promise.reject(new Error(r)))),
            )
          }}
        >
          {d.push ? 'Turn off notifications' : 'Turn on notifications'}
        </button>
      )}
      {(owner || here) && (
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
  if (displays === undefined) return <main className="empty" role="status" />
  return (
    <main className="list-view">
      <h2>Displays</h2>
      <p className="muted">
        A display is a browser you have paired with It. Give each a name and an agent can send a page to it: “put it on the kitchen TV”. A display whose
        browser’s pairing has ended stays here as not paired: paired again, that browser is the same display, and forgetting it removes it.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows">
        {displays.map((d) => (
          <DisplayItem key={d.id} d={d} here={d.id === thisDisplay} owner now={now} act={act} along={alongWith(d.id)} />
        ))}
      </ul>
      <AddDisplay />
      <PairedBrowsers />
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
function AddDisplay() {
  const convex = useConvex()
  const where = useWhere()
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(5_000)
  const add = async () => {
    setBusy(true)
    try {
      const r: { code: string; expiresAt?: number } = await convex.mutation(api.sessions.inviteScreen, {})
      setMade({ code: r.code, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : serverNow() + CODE_MS })
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    } finally {
      setBusy(false)
    }
  }
  const ranOut = made !== null && made.expiresAt <= now
  return (
    <section className="panel pairing">
      <h3>Add a display</h3>
      {!made || ranOut ? (
        <>
          <p className="muted">
            {ranOut
              ? 'That code has run out. Make another when the other screen is ready.'
              : 'Pair another screen with It: a TV, a tablet, a phone. A paired screen can open every page you have and answer on any of them, so pair only screens that are your own. It cannot delete a page, and it cannot see or change your machines, your other displays or what It holds.'}
          </p>
          <button type="button" disabled={busy} onClick={() => void add()}>
            Add a display
          </button>
        </>
      ) : where.address ? (
        <>
          <p>On the other screen, open this address, or read it with that screen’s camera from the square below.</p>
          <p className="mono pair-address">{`${where.address}/pair#${encodeURIComponent(made.code)}`}</p>
          <Qr text={`${where.address}/pair#${encodeURIComponent(made.code)}`} />
          <OtherAddresses where={where} />
          <p>
            Or open <span className="mono">{where.address}</span> there and type this code:
          </p>
          <p className="mono pair-code">{spaced(made.code)}</p>
        </>
      ) : (
        <>
          <NoAddress where={where} appears="the address to open on the other screen" />
          <p>
            A browser on the machine It runs on can be paired as a screen meanwhile: open <span className="mono">{location.origin}</span> in it and type this
            code:
          </p>
          <p className="mono pair-code">{spaced(made.code)}</p>
        </>
      )}
      {made && !ranOut && (
        <>
          <p className="muted">
            The code pairs one browser, once, and works for ten minutes. A browser that opens the address is asked whether it is the screen to pair, so opening
            it anywhere else uses nothing.
          </p>
          <button type="button" onClick={() => setMade(null)}>
            Done
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
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
  return (
    <main className="list-view">
      <h2>Settings</h2>
      {!owner && display && (
        <ul className="rows">
          <DisplayItem d={display} here owner={false} now={now} act={act} />
        </ul>
      )}
      {rowError && (
        <p className="error" role="alert">
          {rowError}
        </p>
      )}
      <section className="panel">
        <h3>This browser</h3>
        {owner ? (
          <p className="muted">
            This browser is paired with It as yours, and everything on the site can be done from it. Signing out ends that. To pair it again, run{' '}
            <code>it site</code> on the machine It runs on.
          </p>
        ) : (
          <p className="muted">
            This browser is paired with It as a screen. It can open every page and answer on any of them. Machines, other displays and what It holds are looked
            after from a browser that is paired as yours. Signing out ends the pairing, and the display has to be added again before it can be used.
          </p>
        )}
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </section>
      {owner && (
        <>
          <section className="panel">
            <h3>Your data</h3>
            <p className="muted">
              Download the records It holds: your pages and their state, what was done on them, your displays and machines, and for each version of a page the
              names, sizes and checksums of its files. The files themselves are not in the download, so it is a record of your pages and not a way to put them
              back.
            </p>
            <button type="button" disabled={busy} onClick={() => void download()}>
              Download my data
            </button>
          </section>
          <section className="panel">
            <h3>Erase everything</h3>
            <p className="muted">
              This ends what every display and machine can do at once, and then removes every page, its files and every record of them from what It holds on the
              computer It runs on, with the copies of its database that It kept from before an update. A page that is open on a display may go on showing for a
              moment. It cannot be undone.
            </p>
            <p className="muted">
              This browser lets go of what it keeps too, in every tab the site is open in: the cookie that is its pairing, which display it is, anything done on
              a page that it had not sent yet, and, where notifications were on, the script that shows them and any notification still showing. Every other
              browser that was paired does the same the next time the site is opened in it. For a day more each keeps one thing, the name of the cookie it held,
              which is no secret and opens nothing: with it the browser asks again for that cookie to be cleared, should an answer that was on its way have put
              it back. What a browser keeps for itself of your having used the site, such as its history and whether it lets the site notify you, stays until
              you clear it there.
            </p>
            <p className="muted">
              Some of it stays a while longer. The backend program keeps what was removed inside its database’s file for {REMOVED_STAYS} more, as it does with
              anything that is deleted, where nothing of It reads it, and traces of it can stay in the file’s unused space until the program writes over them.
              For {TASKS_STAY} it also keeps a note of each task it ran in the background, by the id of the machine, the page, the notification or the
              conversation the task was about, with nothing that was on a page. The part of It that shows pages keeps two notes, by ids alone, so that nothing
              from before can be used: that every display was signed out, which it clears away the next time a page is shown more than a day later, and that the
              files were deleted, which it clears away the next time something is deleted more than an hour later. The program stays, with its settings, its
              keys and what it wrote down while it ran, which holds ids and counts and nothing that was on a page. A copy of its folder that you made yourself,
              and the records you downloaded, are yours to remove.
            </p>
            <p className="muted">
              Afterwards It is as it was before it was first set up: to use it again, run <code>it setup</code> on the machine It runs on, and then{' '}
              <code>it site</code> to pair a browser. Type “{PHRASE}” to confirm.
            </p>
            <div className="inline">
              <input aria-label={`Type ${PHRASE} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={PHRASE} />
              <button type="button" className="danger" disabled={busy || typed.trim().toLowerCase() !== PHRASE} onClick={() => void erase()}>
                Erase everything
              </button>
            </div>
          </section>
          <WhatItDoes />
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        It is source-available under the It License. You can read{' '}
        <a href="/LICENSE.md" target="_blank" rel="noreferrer">
          the license
        </a>{' '}
        and{' '}
        <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
          the notices of what It includes
        </a>
        .
      </p>
    </main>
  )
}
