// The site: pairing, this display's registration, and the frame around everything else.
import { NOUN } from '@it/protocol'
import { useConvex, useConvexAuth, useMutation, useQuery } from 'convex/react'
import { Component, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { version } from '../package.json'
import { askTwice } from './backend'
import { IconGuide, IconMore, Mark } from './brand'
import { Copyable } from './dialog'
import { Finder } from './finder'
import {
  api,
  displayKey,
  doneLeaving,
  forgetDisplayKey,
  hasSignOutToken,
  isLeaving,
  keepSignOutToken,
  learnClock,
  navigate,
  noteRegistered,
  pairedSinceRegistering,
  presentPendingSignOut,
  refusal,
  reloadWhenThere,
  signOutConfirmed,
  signOutLater,
  signOutTokenSpent,
  startLeaving,
  usePath,
  useStored,
  wasErasedHere,
} from './lib'
import { Machines } from './machines'
import { Bell, Toasts } from './notifications'
import { drain, outboxBelongsTo, pairedForSomeone, stillPairedFor, thisPairing } from './outbox'
import { Grid, PageView } from './pages'
import { dropPushHere, mendPush, pushSupport, turnOffPush, turnOnPush } from './push'
import { codeSeen, current, signOut as endSession, pair, pairAsScreen, recheck, useSession } from './session'
import { Displays, Settings } from './settings'
import { TourDialog } from './welcome'

export function App() {
  const { loaded, paired, user, session } = useSession()
  const { isLoading, isAuthenticated } = useConvexAuth()
  // Whose clicks may be sent from this browser right now: the person it is paired for, and
  // nobody else's. Which session of theirs it is goes with it, for whatever is begun under one
  outboxBelongsTo(paired ? user : null, paired ? session : null)
  // Leaving is one session's doing. When the browser turns out to be under another (it was
  // paired again in another tab meanwhile), whoever is here now did not ask to leave
  const under = useRef(session)
  if (under.current !== session) {
    under.current = session
    doneLeaving()
  }
  // A sign-out the backend could not be told about at the time is told now, and again whenever
  // the connection comes back, until it has been taken
  useEffect(() => {
    void presentPendingSignOut()
    const again = () => void presentPendingSignOut()
    window.addEventListener('online', again)
    const t = setInterval(again, 60_000)
    return () => {
      window.removeEventListener('online', again)
      clearInterval(t)
    }
  }, [])
  if (!loaded) return <Splash />
  if (!paired) {
    doneLeaving()
    // However the session ended (the button, being forgotten from another display, or
    // everything being erased), nothing more is to be pushed to a browser that is not paired.
    // Dropping the subscription here needs no backend: the next push to it is refused, and the
    // backend forgets it.
    void dropPushHere()
    // A token still kept here means the session did not end by the Sign out button, which
    // uses its token up. It is presented now: pages left open on this display stop working,
    // and the backend stops pushing to it, without waiting to be told some other way.
    if (signOutLater()) void presentPendingSignOut()
    return <NotPaired />
  }
  if (isLoading || !isAuthenticated) return <Connecting stuck={!isLoading} />
  return <Paired />
}

/**
 * Paired, and waiting for the backend to agree. If it has said no (a token could not be
 * fetched while the connection was down, say) nothing asks it again by itself, so a display
 * nobody is standing at would wait here for ever: it starts afresh, once, and again whenever
 * the connection comes back.
 */
function Connecting({ stuck }: { stuck: boolean }) {
  useEffect(() => {
    if (!stuck) return
    const reload = () => {
      const last = Number(sessionStorage.getItem('it.reconnectedAt') ?? 0)
      if (Date.now() - last < 60_000) return
      sessionStorage.setItem('it.reconnectedAt', String(Date.now()))
      reloadWhenThere()
    }
    const t = setTimeout(reload, 20_000)
    window.addEventListener('online', reload)
    return () => {
      clearTimeout(t)
      window.removeEventListener('online', reload)
    }
  }, [stuck])
  return <Splash note="Connecting…" />
}

const Splash = ({ note }: { note?: string }) => (
  <main className="splash" role="status">
    <span className="mark">
      <Mark />
    </span>
    {note && <span className="muted">{note}</span>}
  </main>
)

/**
 * Said where a code was not tried at all: too many wrong codes came from this browser's address
 * within a minute, and the door tries none from it until the minute is over. The code is as
 * good as it was, and how long there is to wait is said, so that the person need only wait.
 */
const waitFirst = (seconds: number): string =>
  `Too many wrong codes have come from this device in the last minute, so this one was not tried. Wait ${
    seconds >= 55 ? 'a minute' : seconds === 1 ? '1 second' : `${seconds} seconds`
  }, and then try it again.`

/**
 * Said in a browser that was opened at an address with a screen's code in it. The code is not
 * used by the address being opened: an address can be opened anywhere, and in the owner's own
 * browser, reached by another of the machine's names, it would make that browser a screen and
 * leave nothing for the screen it was made for. It is used when the person says this browser is
 * that screen. A browser that is paired already is shown it under the bar, and may decline.
 */
function ScreenOffered({ onDecline }: { onDecline?: () => void }) {
  const { wait } = useSession()
  const [busy, setBusy] = useState(false)
  return (
    <div className={onDecline ? 'notice' : 'offer'} role="status">
      <span>This address pairs one screen, once. Use it here only if this browser is that screen.</span>
      {wait !== null && !busy && (
        <span className="error" role="alert">
          {waitFirst(wait)}
        </span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void pairAsScreen().finally(() => setBusy(false))
        }}
      >
        {busy ? 'Pairing…' : 'Make this browser a screen of It'}
      </button>
      {onDecline && (
        <button type="button" className="link" disabled={busy} onClick={onDecline}>
          Not now
        </button>
      )}
    </div>
  )
}

/** What a browser that is not paired shows: the command that gets a code, and where to put the code. */
function NotPaired() {
  const { code, wait } = useSession()
  // Signing out went ahead before it was confirmed that pages open on this display had stopped
  // working. They will, as soon as that is confirmed; until then the person is told the truth.
  const [note] = useState(() => {
    const had = sessionStorage.getItem('it.signout.note') === '1'
    sessionStorage.removeItem('it.signout.note')
    return had
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const erased = wasErasedHere()
  return (
    <main className="door">
      <div className="door-card">
        <h1 className="mark door-mark">
          <Mark />
        </h1>
        <p className="door-line">Connect this browser</p>
        {note && (
          <p className="door-note" role="status">
            This browser is signed out. A page that was open on this display may go on working for a moment yet; close its tab to be sure.
          </p>
        )}
        {erased && (
          <p className="door-note" role="status">
            Everything It held is being erased. This browser is not paired with It.
          </p>
        )}
        {code === 'screen' && <ScreenOffered />}
        <ol className="door-steps">
          <li>
            <span className="door-n">1</span>
            <div className="door-step">
              <h2>Run this where It runs</h2>
              <Copyable prompt text={erased ? 'it setup && it site' : 'it site'} />
            </div>
          </li>
          <li>
            <span className="door-n">2</span>
            <div className="door-step">
              <h2>Open the address it prints, or enter its code</h2>
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault()
                  setBusy(true)
                  // The whole address may be pasted: the code is what follows the last #
                  void pair(typed.slice(typed.lastIndexOf('#') + 1)).finally(() => setBusy(false))
                }}
              >
                <input
                  className="mono"
                  aria-label="Pairing code"
                  placeholder="abcd efgh ijkl mnop qrst"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={300}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
                <button type="submit" className="primary" disabled={busy || !typed.trim()}>
                  {busy ? 'Pairing…' : 'Pair this browser'}
                </button>
              </form>
            </div>
          </li>
        </ol>
        {wait !== null && code !== 'screen' && !busy ? (
          <p className="error" role="alert">
            {waitFirst(wait)}
          </p>
        ) : (
          code &&
          code !== 'screen' &&
          !busy && (
            <p className="error" role="alert">
              {code === 'refused'
                ? 'That code is wrong, has already been used, or has run out. Get a new one and try again.'
                : 'That code could not be checked just now. Try it again in a moment.'}
            </p>
          )
        )}
        <p className="door-foot">A second screen is added from Displays, on a browser that is already paired.</p>
      </div>
    </main>
  )
}

/** A browser It has not seen registers as a display the moment it is paired, with nothing in the way. */
function Paired() {
  const convex = useConvex()
  const { session, user, role } = useSession()
  /** Whether this browser has registered, and under which session it did: under another, it has yet to. */
  const [state, setState] = useState<{ ready: boolean; error?: string; session?: string | null }>({ ready: false })
  /** Counted up by "Try again", so that registering is asked for once more. */
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let live = true
    if (isLeaving() || !session) return
    void tries
    const register = () => convex.mutation(api.displays.register, { key: displayKey(), userAgent: navigator.userAgent })
    ;(async () => {
      try {
        await register()
      } catch (err) {
        // The person forgot this display, and has paired this browser again since. That is them
        // bringing it back: it starts afresh, as a new display, under the session it has now.
        // So it does when the key it kept is a display's that another session still holds (this
        // browser lost its cookie and was paired again, say): that display is not this browser's
        // to be. The backend answers a screen in the same words for both, as for any display
        // that is not there, and tells only the owner's browser that a display was forgotten
        const said = refusal(err)
        if (!(said.forgotten || said.code === 'not_found') || !live || !pairedSinceRegistering(session)) throw err
        forgetDisplayKey()
        await register()
      }
      if (live) noteRegistered(session)
      if (user) void drain(convex, user)
    })().then(
      () => live && setState({ ready: true, session }),
      (err) => {
        const said = refusal(err)
        // This display was forgotten, and the session it had then is still the one here. It
        // does not come back by itself: the browser signs out, and is a new display the next
        // time it is paired. Unless the session this was asked under has ended meanwhile:
        // whoever is here now was not refused
        if (said.forgotten && !live) return
        if (said.forgotten) {
          startLeaving()
          // The refused key is let go of only once the browser is really signed out. If signing
          // out fails, the person is told, and the next visit meets the same refusal and tries again.
          const failed = () => live && setState({ ready: false, error: 'This display was forgotten. Signing it out did not work; try again.' })
          void Promise.race([endSession(), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]).then(
            (out) =>
              out
                ? // A browser paired again while this was being signed out has a key of its own here by now
                  pairedForSomeone() || forgetDisplayKey()
                : failed(),
            failed,
          )
          return
        }
        if (live) setState({ ready: false, error: said.message })
      },
    )
    return () => {
      live = false
    }
  }, [convex, session, user, tries])
  if (state.error)
    return (
      <main className="splash" role="alert">
        <span className="mark">
          <Mark />
        </span>
        <p>{state.error}</p>
        <button
          type="button"
          onClick={() => {
            doneLeaving()
            setState({ ready: false })
            setTries((n) => n + 1)
          }}
        >
          Try again
        </button>
        <button type="button" className="link" onClick={() => void endSession()}>
          Sign out
        </button>
      </main>
    )
  if (!state.ready || state.session !== session || !user) return <Splash note="Connecting…" />
  return (
    <Root onRefused={recheck}>
      <Shell user={user} owner={role === 'owner'} />
    </Root>
  )
}

/**
 * Said to the owner who opened, in their own browser, the address they made for another screen.
 * The code in it was not used here: used, it would have made this browser a screen. It is still
 * good for the screen it was made for.
 */
function CodeForAnotherScreen() {
  return (
    <p className="notice" role="status">
      <span>This browser is already paired with It as the owner’s, so the code was not used here. Open the address on the other screen.</span>
      <button type="button" onClick={codeSeen}>
        OK
      </button>
    </p>
  )
}

/** Everything a paired browser shows. A screen is shown what a screen may use, and the owner the rest as well. */
function Shell({ user, owner }: { user: string; owner: boolean }) {
  const convex = useConvex()
  const { code } = useSession()
  const path = usePath()
  const key = displayKey()
  const display = useQuery(api.displays.mine, { key })
  const pages = useQuery(api.artifacts.list, {})
  const heartbeat = useMutation(api.displays.heartbeat)
  const [leaving, setLeaving] = useState(false)
  const [stillIn, setStillIn] = useState(false)
  // What is typed into the search, the finder and the tour's dialog, which the bar opens and the shell shows
  const [query, setQuery] = useState('')
  const [finding, setFinding] = useState(false)
  const [tour, setTour] = useState(false)
  const closeFinder = useCallback(() => setFinding(false), [])
  const closeTour = useCallback(() => setTour(false), [])
  // The finder opens on its key from anywhere on the site
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      setFinding(true)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])

  // Presence, so a notification knows whether this display is open. The answer carries the
  // backend's clock, which is what "recent" is judged by everywhere on the site.
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== 'visible') return
      heartbeat({ key }).then(
        (r) => learnClock(r.now),
        () => {},
      )
    }
    beat()
    const t = setInterval(beat, 60_000)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [heartbeat, key])

  // Clicks that were waiting to be sent go when the connection comes back: when the browser
  // says it is online again, and when the connection to the backend itself is made again,
  // which the browser does not always notice
  useEffect(() => {
    const go = () => void drain(convex, user)
    window.addEventListener('online', go)
    let connected = convex.connectionState().isWebSocketConnected
    const stop = convex.subscribeToConnectionState((s) => {
      if (s.isWebSocketConnected && !connected) go()
      connected = s.isWebSocketConnected
    })
    return () => {
      window.removeEventListener('online', go)
      stop()
    }
  }, [convex, user])

  // The token that signs this display out is fetched while the browser is paired, so that it
  // is there if the backend cannot be reached at the moment the person signs out
  // It is fetched again whenever it may have been used up or gone stale: every few hours, when
  // the connection returns, soon after a fetch that failed, and after a sign-out that did not
  // go through (`tokenWanted`).
  const [tokenWanted, setTokenWanted] = useState(0)
  /** The number the display is at, as last heard, for judging a token when it arrives. */
  const epochNow = useRef<number | undefined>(undefined)
  epochNow.current = display?.epoch
  // The display's number has moved (a sign-out that was still owed has just been taken, say):
  // the token kept here was for the old number and does nothing any more, so another is fetched
  const displayAt = display?.epoch
  const displayIs = display?.id
  useEffect(() => {
    if (displayAt !== undefined && displayIs !== undefined && signOutTokenSpent(user, { id: displayIs, epoch: displayAt })) setTokenWanted((n) => n + 1)
  }, [displayAt, displayIs, user])
  useEffect(() => {
    let live = true
    let soon: ReturnType<typeof setTimeout> | undefined
    const fetchIt = () => {
      clearTimeout(soon)
      askTwice(
        convex,
        (calls) => calls.action(api.displays.signOutToken, { key }),
        () => live,
      ).then(
        (r) => {
          // One that arrives once signing out has begun is already out of date, and is not kept
          if (!live || isLeaving()) return
          // Nor is one the display has already passed (a sign-out still owed was taken while
          // this was on its way): another is asked for, a little later
          if (epochNow.current !== undefined && r.raisesTo <= epochNow.current) soon = setTimeout(fetchIt, 2000)
          else keepSignOutToken(r.token, user, r.raisesTo, r.display)
        },
        () => {
          if (live) soon = setTimeout(fetchIt, 30_000)
        },
      )
    }
    void tokenWanted
    fetchIt()
    const t = setInterval(fetchIt, 6 * 3_600_000)
    window.addEventListener('online', fetchIt)
    return () => {
      live = false
      clearInterval(t)
      clearTimeout(soon)
      window.removeEventListener('online', fetchIt)
    }
  }, [convex, key, tokenWanted, user])

  // The backend's record says notifications are on here; the browser may have dropped its
  // subscription since (it was signed out for a while, say). The two are made to agree, once.
  const pushOn = display?.push
  useEffect(() => {
    if (pushOn) void mendPush(convex)
  }, [pushOn, convex])

  // This display was forgotten from somewhere else: it is signed out here too
  const wasRegistered = useRef(false)
  /** Whether this part of the site is still on screen: what was started for it stops when it is not. */
  const shellHere = useRef(true)
  useEffect(() => {
    shellHere.current = true
    return () => {
      shellHere.current = false
    }
  }, [])
  useEffect(() => {
    if (display) wasRegistered.current = true
    else if (display === null && wasRegistered.current) {
      // Its record is gone. Either the person forgot this display from somewhere else, and it
      // is signed out here too; or it was let go to make room while this tab sat in the
      // background, and it registers again.
      wasRegistered.current = false
      const began = thisPairing()
      convex.query(api.displays.wasForgotten, { key }).then(
        (forgotten) => {
          // Answered late, after the session it was asked under ended: it says nothing about whoever is here now
          if (!shellHere.current || !stillPairedFor(user, began)) return
          // Let go to make room: it is simply registered again, and carries on
          if (!forgotten) {
            // Tried until it works: registering can be refused for a while (too many at once,
            // or no room yet), and a display left unregistered can show nothing
            const again = (tries: number) =>
              void convex.mutation(api.displays.register, { key, userAgent: navigator.userAgent }).catch((err) => {
                // A key that is refused for good is not asked with again: it was forgotten, or is another browser's
                if (refusal(err).forgotten || refusal(err).code === 'not_found' || !shellHere.current) return
                setTimeout(() => again(tries + 1), Math.min(5000 * 2 ** tries, 300_000))
              })
            return again(0)
          }
          startLeaving()
          // If signing out does not work, the site starts again: registering is then refused, and
          // that screen says what happened and offers to try again
          void Promise.race([endSession(), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]).then(
            // The key is let go of only if the browser has not been paired again meanwhile: by then it is that pairing's
            (out) => (out ? pairedForSomeone() || forgetDisplayKey() : reloadWhenThere()),
            reloadWhenThere,
          )
        },
        () => {},
      )
    }
  }, [display, convex, key, user])

  // An agent asked for a page to be brought up here. What counts as new is anything after the
  // request this display had already seen when it loaded, so no clock is compared with another.
  // Remembered in this tab only, so a browser that is paired again starts afresh
  const shownKey = `it.shownAt.${user}`
  const shownAt = useRef<number | null>(sessionStorage.getItem(shownKey) === null ? null : Number(sessionStorage.getItem(shownKey)))
  useEffect(() => {
    if (display === undefined || display === null) return
    const showing = display.showing
    if (shownAt.current === null) {
      shownAt.current = showing?.at ?? 0
      sessionStorage.setItem(shownKey, String(shownAt.current))
      return
    }
    if (!showing || showing.at <= shownAt.current) return
    shownAt.current = showing.at
    sessionStorage.setItem(shownKey, String(showing.at))
    navigate(`/p/${encodeURIComponent(showing.slug)}`)
  }, [display, shownKey])

  const signOut = async () => {
    // The paired view goes at once. Then, as far as each can be done: nothing more is pushed
    // to this browser, and pages already open on this display stop working. None of that is
    // allowed to hold up signing out, whatever the connection is doing.
    setLeaving(true)
    startLeaving()
    // The session this is ending. Asked about before every step that waits: the browser being
    // paired again counts as someone else, since that is not the session they asked to end
    const began = thisPairing()
    const within = <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
    await within(
      turnOffPush(convex, () => stillPairedFor(user, began)),
      3000,
    )
    // Each step below waits on the network, and the connection it uses is that of whichever
    // session is here at that moment. If this session ended meanwhile and there is another,
    // nothing more of this is done: it would end the other one's pages and sign it out.
    const mine = () => {
      if (stillPairedFor(user, began)) return true
      // Whoever is here now did not ask to leave: they are not left looking at "Signing out"
      doneLeaving()
      setLeaving(false)
      return false
    }
    if (!mine()) return
    // The backend is told, and it tells the part of It that shows pages, which is what
    // actually stops pages already open here. If the backend does not confirm in time, the
    // display's own sign-out token is left to be presented as soon as the backend can be reached.
    const told = await Promise.race([
      convex.mutation(api.displays.signOut, { key }).then(
        (r) => r.job,
        () => null,
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ])
    if (!mine()) return
    let ended = false
    if (told) {
      signOutConfirmed()
      // The backend goes on telling it until it confirms, whatever happens here. This only
      // finds out whether it already has, so that the person can be told the truth.
      for (let i = 0; i < 8 && !ended; i++) {
        ended = (await within(convex.query(api.displays.signOutConfirmed, { job: told }), 1500)) === true
        if (!ended) await new Promise((r) => setTimeout(r, 400))
      }
    } else if (hasSignOutToken(user, display)) {
      signOutLater()
      void presentPendingSignOut()
    } else {
      // The backend could not be told, and there is nothing to leave behind that would tell it
      // later. Signing out now would leave pages open on this display working, so it is not
      // done: the person is told, and can try again.
      doneLeaving()
      setLeaving(false)
      setStillIn(true)
      setTokenWanted((n) => n + 1)
      return
    }
    if (!mine()) return
    // Asked about again the next time this browser is paired, not before
    localStorage.removeItem('it.pushAsked')
    if (!ended) sessionStorage.setItem('it.signout.note', '1')
    // The one step that matters most. If it cannot be done, the person is told so plainly:
    // someone who walks away believing they signed out, and did not, is worse off than before.
    const out = await Promise.race([endSession(), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))])
    if (!out) {
      doneLeaving()
      setLeaving(false)
      setStillIn(true)
      // Whatever token there was has been used or put aside: a new one is fetched in case the
      // person stays, so that the next sign-out has one too
      setTokenWanted((n) => n + 1)
      sessionStorage.removeItem('it.signout.note')
    }
    // The browser was paired again in another tab while this went on, and nothing was ended:
    // there is nothing to say on the pairing screen, which is not where this browser is
    else if (current().paired) sessionStorage.removeItem('it.signout.note')
  }
  if (leaving) return <Splash note="Signing out…" />
  if (stillIn)
    return (
      <main className="splash" role="alert">
        <span className="mark">
          <Mark />
        </span>
        <p>
          This browser could not be signed out, because It could not be reached to end its pairing. It is still paired with It: try again when the connection is
          back, or stay paired.
        </p>
        <button
          type="button"
          onClick={() => {
            setStillIn(false)
            void signOut()
          }}
        >
          Try again
        </button>
        <button type="button" className="link" onClick={() => setStillIn(false)}>
          Stay paired
        </button>
      </main>
    )

  const slug = safeDecode(/^\/p\/([^/]+)$/.exec(path)?.[1])
  const view = (
    <Guard key={path}>
      {slug ? (
        <PageView slug={slug} user={user} owner={owner} />
      ) : owner && path === '/machines' ? (
        <Machines />
      ) : owner && path === '/displays' ? (
        <Displays thisDisplay={display?.id} />
      ) : path === '/settings' ? (
        <Settings user={user} owner={owner} display={display ?? null} onSignOut={signOut} />
      ) : (
        <>
          {/* A screen that was given an address of the owner's is shown its pages, and told why */}
          {!owner && (path === '/machines' || path === '/displays') && (
            <p className="notice" role="status">
              <span>
                This browser is paired as a screen, which can open every page and answer on it. {path === '/machines' ? 'Machines' : 'Displays'} is shown in a
                browser paired as yours: run `it site` where It runs to pair one.
              </span>
            </p>
          )}
          <Grid pages={pages} owner={owner} query={query} onQuery={setQuery} />
        </>
      )}
    </Guard>
  )
  const notices = (
    <>
      {code === 'owner' && <CodeForAnotherScreen />}
      {code === 'screen' && <ScreenOffered onDecline={codeSeen} />}
    </>
  )
  return (
    <div className="shell" data-view={slug ? 'page' : 'site'}>
      {slug ? (
        <>
          {notices}
          {view}
        </>
      ) : (
        <Site>
          <TopBar
            display={display ?? null}
            owner={owner}
            count={pages?.length}
            onSignOut={signOut}
            search={path === '/' && (pages?.length ?? 0) > 0 ? { query, onQuery: setQuery, onFind: () => setFinding(true) } : null}
            onTour={() => setTour(true)}
          />
          {notices}
          {view}
        </Site>
      )}
      {finding && pages && <Finder pages={pages} onClose={closeFinder} />}
      {tour && <TourDialog onClose={closeTour} />}
      <Toasts />
    </div>
  )
}

/** Everything of the site but a page that is shown: it scrolls under its own bar, which draws a line once something has passed under it. */
function Site({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false)
  return (
    <div className={`site${scrolled ? ' is-scrolled' : ''}`} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
      {children}
    </div>
  )
}

interface DisplayView {
  id: string
  name: string
  named: boolean
  push: boolean
}

interface Search {
  query: string
  onQuery: (q: string) => void
  onFind: () => void
}

/** The bar over the site: the name, the sections, the search, how things stand, and the few buttons. */
function TopBar({
  display,
  owner,
  count,
  search,
  onSignOut,
  onTour,
}: {
  display: DisplayView | null
  owner: boolean
  count: number | undefined
  search: Search | null
  onSignOut: () => void
  onTour: () => void
}) {
  const convex = useConvex()
  const path = usePath()
  const [menu, setMenu] = useState(false)
  // Whether the connection to It is up, which is what the dot says
  const live = useSyncExternalStore(
    useCallback((fn: () => void) => convex.subscribeToConnectionState(fn), [convex]),
    () => convex.connectionState().isWebSocketConnected,
  )
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])
  const tab = (href: string, label: string) => (
    <a
      className="grid-chip"
      href={href}
      aria-current={path === href ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(href)
      }}
    >
      {label}
    </a>
  )
  return (
    <header className="bar grid-header">
      <div className="grid-brand">
        <a
          className="mark grid-title"
          href="/"
          onClick={(e) => {
            e.preventDefault()
            navigate('/')
          }}
        >
          <Mark />
        </a>
        <nav aria-label="Sections">
          {tab('/', NOUN.Many)}
          {owner && tab('/machines', 'Machines')}
          {owner && tab('/displays', 'Displays')}
        </nav>
      </div>
      <div className="grid-header-spacer" />
      {search && (
        <span className="grid-search-wrap">
          <input
            type="search"
            className="grid-search"
            placeholder={`Search ${NOUN.many}`}
            aria-label={`Search ${NOUN.many}`}
            spellCheck={false}
            autoComplete="off"
            value={search.query}
            onChange={(e) => search.onQuery(e.target.value)}
          />
          <button type="button" className="grid-kbd" title={`Find a ${NOUN.one} (⌘K)`} aria-label={`Find a ${NOUN.one}`} onClick={search.onFind}>
            ⌘K
          </button>
        </span>
      )}
      <div className={`grid-meta${live ? ' online' : ''}`}>
        {display && <Reminders display={display} />}
        {search && count !== undefined && <span className="grid-meta-count">{`${count} ${count === 1 ? NOUN.one : NOUN.many}`}</span>}
        <span className="grid-meta-live" role="status">
          <span className="live-dot" />
        </span>
        <span className="grid-version">{`v${version}`}</span>
      </div>
      <div className="grid-actions">
        <Bell />
        <button type="button" className="grid-icon-btn" title="Take the tour" aria-label="Take the tour" onClick={onTour}>
          <IconGuide />
        </button>
        <div className="menu" ref={box}>
          <button
            type="button"
            className="icon grid-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label="More"
            title="More"
            onClick={() => setMenu(!menu)}
          >
            <IconMore />
          </button>
          {menu && (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the items themselves are buttons
            <div className="menu-list" role="menu" onClick={() => setMenu(false)}>
              <button type="button" role="menuitem" onClick={() => navigate('/settings')}>
                Settings
              </button>
              <button type="button" role="menuitem" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

/** The small asks that live in the top bar: a name for this display, and permission to notify. */
function Reminders({ display }: { display: DisplayView }) {
  const convex = useConvex()
  const rename = useMutation(api.displays.rename)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [pushAsked, setPushAsked] = useStored('it.pushAsked')
  const [pushNote, setPushNote] = useState('')
  const support = pushSupport()

  const save = async () => {
    try {
      await rename({ displayId: display.id as never, name })
      setEditing(false)
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    }
  }
  return (
    <div className="reminders">
      {editing ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by the person a moment ago
            autoFocus
            aria-label="Name for this display"
            placeholder="Kitchen TV"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <button type="submit" disabled={!name.trim()}>
            Save
          </button>
          {error && <span className="error">{error}</span>}
        </form>
      ) : (
        <button
          type="button"
          className={display.named ? 'chip' : 'chip ask'}
          title={display.named ? 'Rename this display' : 'Agents send pages to a display by its name'}
          onClick={() => {
            setName(display.named ? display.name : '')
            setEditing(true)
          }}
        >
          {display.named ? display.name : 'Name this display'}
        </button>
      )}
      {/* Offered whenever notifications are off here and the person has not said no: also after the backend had to drop a subscription that stopped working */}
      {!display.push && pushAsked !== 'no' && support !== 'unsupported' && support !== 'denied' && (
        <span className="chip-pair">
          <button
            type="button"
            className="chip ask"
            title={
              support === 'needs-install' ? 'On an iPhone or iPad, add this site to the Home Screen first' : 'Get a notification here when the site is closed'
            }
            onClick={async () => {
              const result = await turnOnPush(convex)
              if (result === 'on') setPushAsked('yes')
              else setPushNote(result)
            }}
          >
            {pushNote || 'Turn on notifications'}
          </button>
          <button type="button" className="chip x" aria-label="Not now" onClick={() => setPushAsked('no')}>
            ×
          </button>
        </span>
      )}
    </div>
  )
}

/** A page's id from the address bar, or nothing if it is not one. */
function safeDecode(part: string | undefined): string | undefined {
  if (part === undefined) return undefined
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/** How often one showing of the site asks whether the browser is still paired before it gives a refusal up as something else. */
const ASKS = 3

/**
 * Around everything a paired browser shows. If the backend refuses a query as coming from
 * nobody (the session was ended from another display, say, or everything was erased, or the
 * browser was paired again in another tab), the site asks whether this browser is paired and
 * follows the answer instead of going blank: it shows how to pair, or carries on under the
 * session the browser has now. It ends no session over it. Anything else unexpected offers a
 * way back.
 */
class Root extends Component<{ children: ReactNode; onRefused: () => Promise<void> }, { error: unknown; asking: boolean }> {
  override state = { error: null as unknown, asking: false }
  private asked = 0
  private here = false
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override componentDidMount() {
    this.here = true
  }
  override componentWillUnmount() {
    this.here = false
  }
  override componentDidCatch(error: unknown) {
    // Only a refusal as from nobody. Being refused something a screen may not do is not that,
    // and the view that asked says so itself
    if (refusal(error).code === 'unauthenticated') {
      // Unless this browser is already on its way out by its own doing (signing out, or
      // erasing everything, which has steps of its own still to finish). And not for ever: a
      // refusal that comes back each time the backend has said the browser is paired is
      // something else, is left for the person to see, and is written down as the error it is
      if (isLeaving()) return
      if (this.asked >= ASKS) return console.error(error)
      this.asked++
      this.setState({ asking: true })
      // Paired still, and as the session this was shown under: what was refused is shown again
      void this.props.onRefused().then(() => this.here && this.setState({ error: null, asking: false }))
      return
    }
    // A display nobody is standing at puts itself right: one reload, and not a second within
    // ten minutes, so that something that fails every time does not reload for ever
    if (Date.now() - Number(sessionStorage.getItem('it.reloadedAt') ?? 0) > 600_000) {
      sessionStorage.setItem('it.reloadedAt', String(Date.now()))
      setTimeout(reloadWhenThere, 5000)
    }
  }
  override render() {
    if (!this.state.error) return this.props.children
    if (this.state.asking) return <Splash note="Connecting…" />
    return (
      <main className="splash" role="alert">
        <span className="mark">
          <Mark />
        </span>
        <p className="muted">Something went wrong.</p>
        <button type="button" onClick={() => location.assign('/')}>
          Start again
        </button>
      </main>
    )
  }
}

/** Catches a refusal thrown while showing a view, such as a page that does not exist. */
class Guard extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override render() {
    if (!this.state.error) return this.props.children
    const r = refusal(this.state.error)
    // Being refused as nobody is not this view's to explain: it goes up, where the site asks whether this browser is still paired
    if (r.code === 'unauthenticated') throw this.state.error
    return (
      <main className="empty" role="alert">
        <h2>{r.code === 'not_found' ? `No such ${NOUN.one}` : 'That did not work'}</h2>
        <p className="muted">{r.code === 'not_found' ? 'It may have been deleted, or the address is wrong.' : r.message}</p>
        <button type="button" className="primary" onClick={() => navigate('/')}>
          Back to your {NOUN.many}
        </button>
      </main>
    )
  }
}
