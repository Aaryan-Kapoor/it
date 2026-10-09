// What a display shows while there is nothing on it: the things It can be, played one after
// another as the launch film draws them, and beside them the sentence that gets a person
// started, to give to their agent.
import { useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copyable, Dialog } from './dialog'
import type { Playing } from './film/play'
import { agentName, api, navigate } from './lib'

/** What the person gives their agent to be led through It. */
export const TOUR_PROMPT = 'Give me the It tour.'

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

/** The dialog that hands the person the one sentence to give their agent. */
export function TourDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog eyebrow="Tour" title="Hand this to your agent" onClose={onClose}>
      <p className="modal-lede">Your agent gives the tour. Paste this into its chat.</p>
      <Copyable text={TOUR_PROMPT} label="Copy prompt" />
    </Dialog>
  )
}

/** The agent apps that are connected on any machine, for the owner. Unknown until the backend has said. */
function useConnected(owner: boolean): string[] | undefined {
  const machines = useQuery(api.machines.list, owner ? {} : 'skip') as { harnesses: { id: string; addon: string }[] }[] | undefined
  if (!owner || !machines) return undefined
  const ids = machines.flatMap((m) => m.harnesses.filter((h) => h.addon === 'connected' || h.addon === 'needs_approval').map((h) => h.id))
  return [...new Set(ids)].map((id) => agentName(id) ?? id)
}

/** A list of names as a person says it: "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Pi". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''))

export function Welcome({ owner }: { owner: boolean }) {
  const connected = useConnected(owner)
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
    void import('./film/play')
      .then(({ play }) =>
        play(panel.current!, stage.current!, {
          headline(text) {
            const [a, b = ''] = text.split('\n')
            if (first.current) first.current.textContent = a ?? ''
            if (second.current) second.current.textContent = b
          },
          thing: (index) => setAt(index),
          you: (text) => say(you.current, text),
          did: (text, by) => say(did.current, text, by),
        }),
      )
      .then((started) => {
        if (over) return started.stop()
        playing.current = started
        // Only what the film has is offered, in its order, under the names given here
        setThings(started.cards.flatMap((card) => THINGS.filter((t) => t.key === card.key)))
      })
      // A browser that cannot draw it shows the words alone
      .catch(() => {})
    return () => {
      over = true
      playing.current?.stop()
      playing.current = null
    }
  }, [])

  const hold = useCallback((on: boolean) => playing.current?.hold(on), [])
  const up = at >= 0 ? things[at] : undefined
  return (
    <main className="hello" data-playing={things.length ? '' : undefined}>
      <div className="hello-text">
        <div className="hello-eyebrow">{connected?.length ? `${listed(connected)} ${connected.length > 1 ? 'are' : 'is'} listening` : 'It is listening'}</div>
        {/* What is typed here is read out once, whole: letter by letter it would be read as noise */}
        <h2 className="hello-h" aria-label="It can be anything your agent needs">
          <span aria-hidden="true">
            <span ref={first}>It can be</span>
            <br />
            <span ref={second}>anything</span>
            <i className="hello-dot" />
          </span>
        </h2>
        <p className="hello-lede">Your agent builds whatever the moment needs, here, and what you do on it goes back to the agent.</p>
        <div className="hello-say">
          <div className="hello-label">Say this to your agent</div>
          <Copyable text={TOUR_PROMPT} />
          <p className="hello-hint">It shows you round in a couple of minutes, on this screen.</p>
        </div>
        {up && (
          <div className="hello-say hello-say--quiet">
            <div className="hello-label">Or ask for this</div>
            <Copyable text={up.say} />
          </div>
        )}
        {connected?.length === 0 && (
          <a
            className="hello-connect"
            href="/machines"
            onClick={(e) => {
              e.preventDefault()
              navigate('/machines')
            }}
          >
            No agent app is connected yet. Connect one
          </a>
        )}
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
        </fieldset>
      </div>
    </main>
  )
}
