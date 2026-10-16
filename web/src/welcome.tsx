// What a display shows while there is nothing on it: the things It can be, played one after
// another as the launch film draws them, and beside them the sentence that gets a person
// started, to give to their agent.
import { ALIVE } from '@it/protocol'
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copyable, Dialog } from './dialog'
import type { Playing } from './film/play'
import { agentName, api, navigate, refusal, useNow } from './lib'
import { say as toast } from './notifications'

/** What the person gives their agent to be led through It. */
export const TOUR_PROMPT = 'Give me the It tour.'
/** Where it is said what It counts of its use, and how to turn that off. */
const PRIVACY = 'https://itcan.do/privacy'

/**
 * The things It is shown being, in the film's own order, each with what a person says to an
 * agent to get one. The name is the film's, and a thing the film does not have is not shown.
 */
const THINGS: { key: string; name: string; say: string }[] = [
  { key: 'whiteboard', name: 'whiteboard', say: 'Open a whiteboard so I can sketch what I mean' },
  { key: 'map', name: 'map', say: 'Find me somewhere for dinner and show me on a map' },
  { key: 'chess', name: 'chessboard', say: 'Let’s play chess' },
  { key: 'checklist', name: 'checklist', say: 'Make me a packing list I can tick off' },
  { key: 'quiz', name: 'quiz', say: 'Quiz me on what we just went through' },
  { key: 'plan', name: 'floor plan', say: 'Draw my floor plan and let me move the furniture' },
  { key: 'cal', name: 'calendar', say: 'Put this week on a calendar I can move things around on' },
  { key: 'drums', name: 'drum machine', say: 'Make me a drum machine' },
  { key: 'seats', name: 'seating chart', say: 'Make a seating chart for the dinner' },
  { key: 'mood', name: 'mood board', say: 'Make me a mood board for the living room' },
  { key: 'dash', name: 'dashboard', say: 'Put the numbers on a dashboard I can leave up' },
  { key: 'button', name: 'big red button', say: 'Give me one big button that ships it' },
  { key: 'late', name: 'hours later', say: 'Ask me on my screen, and wait for my answer' },
]

/**
 * Things to ask an agent for, shown to someone who has no pages and has had the tour: one for
 * each of a few ways It is used, in words a person would say. They are not the film's things,
 * which show what a page can be: these are what a day's work asks for.
 */
export const STARTERS: { use: string; say: string }[] = [
  { use: 'To leave up', say: 'Make me a dashboard for this project that I can leave open, and keep it up to date as you work' },
  { use: 'Before a change', say: 'Show me the plan first, and let me approve it before you touch anything' },
  { use: 'While I am away', say: 'When you need a decision, ask me on my phone and wait for my answer' },
  { use: 'To read', say: 'Put what you found in a report I can read and comment on' },
  { use: 'To decide', say: 'Lay out the options side by side and let me pick one' },
  { use: 'To think', say: 'Open a whiteboard so I can sketch what I mean' },
]

/** How things stand with the tour, as the backend keeps it. Times are the backend's own. */
interface Tour {
  waitingUntil: number | null
  by: string | null
  askedAt: number | null
  takenAt: number | null
  doneAt: number | null
}
/** How long an agent that was asked has to bring the tour up before the person is given the sentence as well. */
export const TOUR_SLOW_MS = 40_000

/**
 * The tour, as the site can ask for it. An agent that is waiting to give it (`it tour --wait`,
 * which an agent that has just installed It runs) says so every few seconds, and for as long as
 * one does the person asks with a button, which the agent hears of. With none waiting there is
 * only the sentence to give an agent, as before there was a button.
 */
export function useTour() {
  const tour = useQuery(api.tour.get, {}) as Tour | undefined
  const asking = useMutation(api.tour.ask)
  const ending = useMutation(api.tour.done)
  // Looked at often while this is on screen: whether an agent waits is a matter of seconds
  const now = useNow(2_000)
  /** When the person pressed the button here, and whether an agent was waiting to hear it. */
  const [pressed, setPressed] = useState<{ at: number; heard: boolean } | null>(null)
  // A reply to an older asking must not bring the tour back after the person chose Skip.
  const request = useRef(0)
  const waiting = tour !== undefined && tour.waitingUntil !== null && tour.waitingUntil > now
  const by = agentName(tour?.by ?? null) ?? 'Your agent'
  const ask = useCallback(() => {
    const mine = ++request.current
    asking({}).then(
      (said) => {
        if (request.current === mine) setPressed({ at: Date.now(), heard: (said as { waiting: boolean }).waiting })
      },
      (err) => {
        if (request.current === mine) toast(refusal(err).message, 'error')
      },
    )
  }, [asking])
  const skip = useCallback(() => {
    const mine = request.current
    void ending({}).then(
      () => {
        if (request.current !== mine) return
        request.current++
        setPressed(null)
      },
      (err) => {
        if (request.current === mine) toast(refusal(err).message, 'error')
      },
    )
  }, [ending])
  return {
    /** Whether the backend has said how things stand. */
    known: tour !== undefined,
    /** An agent is waiting to give the tour: the button reaches it. */
    waiting,
    /** The name of the agent app that waits, or last did. */
    by,
    /** The person asked here and an agent heard: the tour is on its way. */
    coming: pressed?.heard === true,
    /** They asked and nothing has come of it for a while, or nobody was waiting: the sentence is what is left. */
    stalled: pressed !== null && (!pressed.heard || Date.now() - pressed.at > TOUR_SLOW_MS),
    /** A tour was finished, or the person wanted none. */
    done: tour !== undefined && tour.doneAt !== null,
    ask,
    skip,
  }
}

/** The way into the tour: a button where an agent is waiting to give it, and the sentence to give an agent where none is. */
export function TourAsk({ tour, quiet = false }: { tour: ReturnType<typeof useTour>; quiet?: boolean }) {
  if (tour.coming && !tour.stalled)
    return (
      <p className="hello-coming" role="status">
        <span className="hello-coming-dot" />
        {tour.by} is starting the tour. It comes up here by itself.
      </p>
    )
  if (tour.waiting && !tour.stalled)
    return (
      <>
        <button type="button" className="hello-go" onClick={tour.ask}>
          Take the tour
        </button>
        {!quiet && <p className="hello-hint">{tour.by} is ready, and shows you round in a couple of minutes, on this screen.</p>}
      </>
    )
  return (
    <>
      <div className="hello-label">{tour.stalled && tour.coming ? `${tour.by} has not answered. Say this in its chat` : 'Say this to your agent'}</div>
      <Copyable text={TOUR_PROMPT} label={quiet ? 'Copy prompt' : 'Copy'} />
      {!quiet && <p className="hello-hint">It shows you round in a couple of minutes, on this screen.</p>}
    </>
  )
}

/** The dialog the bar's button opens: the same way into the tour, from anywhere on the site. */
export function TourDialog({ onClose }: { onClose: () => void }) {
  const tour = useTour()
  return (
    <Dialog eyebrow="Tour" title={tour.waiting || tour.coming ? 'Your agent gives the tour' : 'Hand this to your agent'} onClose={onClose}>
      {!tour.waiting && !tour.coming && <p className="modal-lede">Your agent gives the tour. Paste this into its chat.</p>}
      <div className="hello-say hello-say--dialog">
        <TourAsk tour={tour} quiet />
      </div>
    </Dialog>
  )
}

/**
 * The agent apps on the person's machines, for the owner: those that are connected, those of
 * them on machines currently available, and those that were found there and could be connected. Unknown
 * until the backend has said.
 */
function useApps(owner: boolean): { connected: string[]; ready: string[]; approval: string[]; more: string[] } | undefined {
  const machines = useQuery(api.machines.list, owner ? {} : 'skip') as
    | {
        harnesses: { id: string; addon: string }[]
        wanted?: string[]
        lastSeenAt: number
        connectorVersion: string | null
        off?: boolean
        paused?: string | null
      }[]
    | undefined
  const now = useNow()
  if (!owner || !machines) return undefined
  const named = (ids: string[]) => [...new Set(ids)].map((id) => agentName(id) ?? id)
  const appsOn = (m: (typeof machines)[number]) => m.harnesses.map((h) => ({ ...h, addon: m.wanted && !m.wanted.includes(h.id) ? 'not_connected' : h.addon }))
  const all = machines.flatMap(appsOn)
  const connected = (h: { addon: string }) => h.addon === 'connected' || h.addon === 'needs_approval'
  const on = all.filter(connected).map((h) => h.id)
  const there = machines.filter((m) => !m.off && !m.paused && m.connectorVersion !== null && now - m.lastSeenAt < ALIVE.onlineMs)
  const ready = there.flatMap((m) =>
    appsOn(m)
      .filter((h) => h.addon === 'connected')
      .map((h) => h.id),
  )
  const approval = there.flatMap((m) =>
    appsOn(m)
      .filter((h) => h.addon === 'needs_approval' && !ready.includes(h.id))
      .map((h) => h.id),
  )
  // Found and not connected, and nothing stands in the way of connecting it: not one that is too old, or that It cannot connect yet
  const off = all.filter((h) => !on.includes(h.id) && h.addon !== 'unavailable' && h.addon !== 'too_old').map((h) => h.id)
  return { connected: named(on), ready: named(ready), approval: named(approval), more: named(off) }
}

/** A list of names as a person says it: "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Pi". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''))

/** A link to another part of the site, which goes there without loading the site afresh. */
function To({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="hello-connect"
      href={href}
      onClick={(e) => {
        e.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}

/**
 * What a person who has no pages and has had the tour is shown: a few things to ask an agent
 * for, each to copy, and the way back into the tour.
 */
export function Starters({ owner }: { owner: boolean }) {
  const apps = useApps(owner)
  const [tour, setTour] = useState(false)
  return (
    <main className="starters">
      <div className="starters-in">
        <h2 className="starters-h">Nothing here yet</h2>
        <p className="starters-lede">
          Your agent makes a page when you ask for something to see or to use. Say what you want in its chat, in your own words. A few to start from:
        </p>
        <ul className="starters-list">
          {STARTERS.map((s) => (
            <li key={s.say}>
              <span className="hello-label">{s.use}</span>
              <Copyable text={s.say} />
            </li>
          ))}
        </ul>
        <p className="starters-foot">
          {apps?.connected.length === 0 && <To href="/machines">No agent app is connected yet. Connect one</To>}
          <button type="button" className="link" onClick={() => setTour(true)}>
            Take the tour again
          </button>
        </p>
      </div>
      {tour && <TourDialog onClose={() => setTour(false)} />}
    </main>
  )
}

/** What a browser is asked, to learn that the person's system asks for less motion. */
const LESS_MOTION = '(prefers-reduced-motion: reduce)'
const lessMotion = () => typeof matchMedia === 'function' && matchMedia(LESS_MOTION)?.matches === true

/**
 * The first screen. How things stand with the tour is given to it by whoever chose to show it:
 * that the person asked for the tour here is known in this tab alone, and what chooses between
 * this screen and the one for when a tour is over has to know it too.
 */
export function Welcome({ owner, tour }: { owner: boolean; tour: ReturnType<typeof useTour> }) {
  const apps = useApps(owner)
  const panel = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLSpanElement>(null)
  const second = useRef<HTMLSpanElement>(null)
  const you = useRef<HTMLParagraphElement>(null)
  const did = useRef<HTMLParagraphElement>(null)
  const playing = useRef<Playing | null>(null)
  /** The things the film has, once it is playing, and which of them is up. Until then the screen stands still. */
  const [things, setThings] = useState<typeof THINGS>([])
  const [at, setAt] = useState(-1)
  // Whether the film stands still. It does from the start for someone who has asked their
  // system for less motion, where a thing is shown whole and nothing moves: the stylesheet
  // stills what it animates, and cannot still what is drawn here. And it does when the person
  // stops it, with the button under it, which is the one way to stop it from the keyboard
  const [still, setStill] = useState(lessMotion)
  const stillNow = useRef(still)
  stillNow.current = still
  useEffect(() => playing.current?.still(still), [still])

  useEffect(() => {
    // Where there is nothing to draw with, the screen says what it has to say in words and shows no picture
    if (typeof FontFace === 'undefined' || typeof ResizeObserver === 'undefined' || !panel.current || !stage.current) return
    let over = false
    const say = (line: HTMLParagraphElement | null, text: string | null, who?: string) => {
      if (!line) return
      if (who) line.firstElementChild!.textContent = who
      if (text === null) return line.classList.remove('in')
      line.lastElementChild!.textContent = text
      line.classList.remove('in')
      void line.offsetWidth
      line.classList.add('in')
    }
    // What the person's system asks is followed as it changes while this screen is up
    const less = typeof matchMedia === 'function' ? matchMedia(LESS_MOTION) : null
    const changed = (e: { matches: boolean }) => setStill(e.matches)
    less?.addEventListener?.('change', changed)
    const begunStill = stillNow.current
    void import('./film/play')
      .then(({ play }) =>
        play(
          panel.current!,
          stage.current!,
          {
            headline(text) {
              const [a, b = ''] = text.split('\n')
              if (first.current) first.current.textContent = a ?? ''
              if (second.current) second.current.textContent = b
            },
            thing: (index) => setAt(index),
            you: (text) => say(you.current, text),
            did: (text, by) => say(did.current, text, by),
          },
          begunStill,
        ),
      )
      .then((started) => {
        if (over) return started.stop()
        playing.current = started
        // It may have changed while the film's typefaces were being fetched
        if (stillNow.current !== begunStill) started.still(stillNow.current)
        // Only what the film has is offered, in its order, under the names given here
        setThings(started.cards.flatMap((card) => THINGS.filter((t) => t.key === card.key)))
      })
      // A browser that cannot draw it shows the words alone
      .catch(() => {})
    return () => {
      over = true
      less?.removeEventListener?.('change', changed)
      playing.current?.stop()
      playing.current = null
    }
  }, [])

  const hold = useCallback((on: boolean) => playing.current?.hold(on), [])
  const up = at >= 0 ? things[at] : undefined
  return (
    <main className="hello" data-playing={things.length ? '' : undefined}>
      <div className="hello-text">
        <div className="hello-eyebrow">It is ready to show pages</div>
        {/* What is typed here is read out once, whole: letter by letter it would be read as noise */}
        <h2 className="hello-h" aria-label="It can be anything your agent needs">
          <span aria-hidden="true">
            <span ref={first}>It can be</span>
            <br />
            <span ref={second}>anything</span>
            <i className="hello-dot" />
          </span>
        </h2>
        <p className="hello-lede">Open your agent to start. It builds a page here, and what you do on the page goes back to the agent.</p>
        {apps && apps.connected.length > 0 && apps.ready.length === 0 && apps.approval.length === 0 && (
          <p className="hello-hint">Your agent's machine is offline or paused. Check Machines before starting.</p>
        )}
        {apps && apps.approval.length > 0 && (
          <p className="hello-hint">
            {`${listed(apps.approval)} needs add-on approval. Open the app to review it.`}
            {apps.approval.includes('Codex') && ' Codex can still receive queued clicks in an open conversation.'}
          </p>
        )}
        <div className="hello-say">
          <TourAsk tour={tour} />
        </div>
        {up && (
          <div className="hello-say hello-say--quiet">
            <div className="hello-label">Or ask for this</div>
            <Copyable text={up.say} />
          </div>
        )}
        {/* What a setup at a terminal asks and an agent's does not: the other agent apps, and the other screens */}
        {owner && apps && (
          <ul className="hello-setup">
            <li>
              {apps.connected.length === 0 ? (
                <To href="/machines">No agent app is connected yet. Connect one</To>
              ) : apps.more.length > 0 ? (
                <To href="/machines">{`${listed(apps.more)} ${apps.more.length > 1 ? 'are' : 'is'} on this machine too. Connect ${apps.more.length > 1 ? 'them' : 'it'}`}</To>
              ) : null}
            </li>
            <li>
              <To href="/displays">Add your phone or another screen</To>
            </li>
            <li>
              <button type="button" className="link hello-skip" onClick={tour.skip}>
                Skip the tour
              </button>
            </li>
          </ul>
        )}
        <p className="hello-counts">
          It collects usage data to help improve it, under a random id and never what is on a page. To read how it is used and how to opt out, see the{' '}
          <a href={PRIVACY} target="_blank" rel="noreferrer noopener">
            privacy policy
          </a>
          .
        </p>
      </div>
      <div className="hello-show" aria-hidden={things.length ? undefined : 'true'}>
        {/* It stays on what it shows for as long as it is pointed at */}
        <div className="hello-panel" ref={panel} onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}>
          <div className="hello-stage" ref={stage} />
          <div className="hello-log" aria-hidden="true">
            <p className="hello-you" ref={you}>
              <span>← you</span>
              <b />
            </p>
            <p className="hello-did" ref={did}>
              <span>agent</span>
              <b />
            </p>
          </div>
        </div>
        <fieldset className="hello-things">
          <legend className="sr-only">Things It can be</legend>
          {things.map((thing, i) => (
            <button
              type="button"
              key={thing.key}
              className={i === at ? 'hello-thing on' : 'hello-thing'}
              aria-pressed={i === at}
              onClick={() => playing.current?.show(i)}
            >
              {thing.name}
            </button>
          ))}
          {things.length > 0 && (
            <button type="button" className="hello-thing" aria-label={still ? 'Play the film' : 'Pause the film'} onClick={() => setStill(!still)}>
              {still ? 'Play' : 'Pause'}
            </button>
          )}
        </fieldset>
      </div>
    </main>
  )
}
