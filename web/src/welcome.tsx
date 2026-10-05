// What a display shows while there is nothing on it: what to say to an agent, the tour, and
// pictures of pages agents have made.
import { useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { copy } from './brand'
import { Copyable, Dialog } from './dialog'
import { api, navigate } from './lib'

/** Things a person could say to their agent, typed out one after another under the headline. */
const SUGGESTIONS = [
  'Let’s play chess',
  'Show me the plan as a page I can approve',
  'Put the test results on my screen',
  'a pomodoro timer',
  'Show me three takes on this button',
  'a bill-split calculator',
  'Put today’s weather on my screen',
  'a kanban board for this week',
  'Show me a 7-minute workout',
  'a flashcard deck for biology',
  'Open a whiteboard',
  'a habit tracker',
]

/** What the person gives their agent to be led through It. */
export const TOUR_PROMPT = 'Give me the It tour.'

/** Pages agents have made, shown as pictures, each with what a person said to get it. */
const IDEAS = [
  {
    src: '/demos/delete.jpg',
    title: 'Three takes, pick one',
    sub: 'Each one works. Your choice goes back.',
    prompt: 'Show me three takes on the delete button and let me pick',
  },
  { src: '/demos/whiteboard.jpg', title: 'A whiteboard', sub: 'Draw what you mean', prompt: 'Open a whiteboard so I can sketch what I mean' },
  { src: '/demos/floorplan.jpg', title: 'A floor plan', sub: 'Move things until it fits', prompt: 'Draw the floor plan and let me move the furniture' },
  { src: '/demos/agentsfail.jpg', title: 'Slides', sub: 'A paper you can step through', prompt: 'Turn this paper into slides I can step through' },
  { src: '/demos/cube.jpg', title: 'Something to turn', sub: 'Drag it, and the agent follows', prompt: 'Show me the cube and let me turn it' },
  { src: '/demos/sphere.jpg', title: 'A lesson you can touch', sub: 'Learn by dragging', prompt: 'Teach me spherical coordinates with something I can drag' },
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

/** Types a suggestion out, holds it, takes it back, and goes on to the next. */
function Suggestion() {
  const slot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let i = Math.floor(Math.random() * SUGGESTIONS.length)
    const step = (typing: boolean, at: number) => {
      const el = slot.current
      if (!el) return
      const text = SUGGESTIONS[i]!
      el.textContent = text.slice(0, at)
      if (typing) timer = at < text.length ? setTimeout(() => step(true, at + 1), 38 + Math.random() * 24) : setTimeout(() => step(false, at), 2400)
      else if (at > 0) timer = setTimeout(() => step(false, at - 1), 24)
      else {
        i = (i + 1) % SUGGESTIONS.length
        timer = setTimeout(() => step(true, 1), 120)
      }
    }
    step(true, 1)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="empty-suggestions">
      <span className="empty-suggestion-arrow">›</span>
      <span className="empty-suggestion-text" ref={slot} />
    </div>
  )
}

/** The pictures, moving slowly upward and round again, and stopping while the pointer is over them. */
function Gallery() {
  const track = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(-1)
  const hovering = useRef(false)
  useEffect(() => {
    const el = track.current
    if (!el) return
    let frame = 0
    let position = 0
    let velocity = 0
    let last = 0
    // The list is there twice, so that the second copy is where the first was when it comes round
    const tick = (now: number) => {
      const half = el.scrollHeight / 2
      const dt = last ? Math.min(now - last, 50) : 16
      last = now
      const target = hovering.current || half <= 0 ? 0 : -half / 96_000
      velocity += (target - velocity) * (1 - Math.exp((-7 * dt) / 1000))
      position += velocity * dt
      if (half > 0 && position <= -half) position += half
      el.style.transform = `translate3d(0, ${position}px, 0)`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
  const twice = [...IDEAS, ...IDEAS]
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only stops moving while it is pointed at
    <div
      className="empty-portal"
      onMouseEnter={() => {
        hovering.current = true
      }}
      onMouseLeave={() => {
        hovering.current = false
      }}
    >
      <div className="portal-gallery">
        <div className="portal-track" ref={track}>
          {twice.map((idea, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same list twice, in a fixed order
            <div className="portal-card" key={i} aria-hidden={i >= IDEAS.length}>
              <div className="portal-disc">
                <img className="portal-demo" src={idea.src} alt="" loading="lazy" decoding="async" />
              </div>
              <div className="portal-meta">
                <div className="portal-title">{idea.title}</div>
                <div className="portal-sub">{idea.sub}</div>
                <button
                  type="button"
                  className={`portal-prompt${copied === i ? ' portal-prompt--copied' : ''}`}
                  tabIndex={i >= IDEAS.length ? -1 : 0}
                  title="Copy this to say to your agent"
                  onClick={async () => {
                    if (await copy(idea.prompt)) {
                      setCopied(i)
                      setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1100)
                    }
                  }}
                >
                  <span className="portal-prompt-arrow">›</span>
                  <span className="portal-prompt-text">{copied === i ? 'copied' : idea.prompt}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Whether any agent app is connected on any machine, for the owner. Unknown until the backend has said. */
function useConnected(owner: boolean): boolean | undefined {
  const machines = useQuery(api.machines.list, owner ? {} : 'skip') as { harnesses: { addon: string }[] }[] | undefined
  if (!owner) return true
  return machines?.some((m) => m.harnesses.some((h) => h.addon === 'connected' || h.addon === 'needs_approval'))
}

export function Welcome({ owner }: { owner: boolean }) {
  const [tour, setTour] = useState(false)
  const connected = useConnected(owner)
  const close = useCallback(() => setTour(false), [])
  return (
    <main className="empty-state">
      <div className="empty-text">
        <div className="empty-eyebrow">It is listening</div>
        <h2 className="empty-prompt">What should I make?</h2>
        <Suggestion />
        <div className="empty-sub">Say it to your agent, and it lands here.</div>
        <button type="button" className="empty-tour-btn" onClick={() => setTour(true)}>
          Start the tour
        </button>
        {connected === false && (
          <a
            className="empty-connect"
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
      <Gallery />
      {tour && <TourDialog onClose={close} />}
    </main>
  )
}
