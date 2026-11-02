// A card's picture of its page: the page itself, shown small and out of reach. It is a showing
// like any other, with a ticket of its own, so what is in the frame is held to everything a page
// is held to. Nothing done in it reaches the backend: the site gives it the page's state, so
// that it looks as the page looks now, and takes nothing from it.
import { CHANNEL_VERSION, contentPort, SANDBOX, type SiteToPage } from '@it/protocol'
import { useConvex } from 'convex/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { askTwice } from './backend'
import { api, displayKey, type Id } from './lib'
import { useLiveState } from './live'

/** How many cards show their page at once. The rest show their cover until one of these leaves the screen. */
const AT_ONCE = 9
/** How long after a picture was shown afresh, because its showing ran out, before it is shown afresh for that again. */
const AFRESH_EVERY_MS = 60_000
const showing = new Set<symbol>()
const waiting = new Set<() => void>()
const letGo = (me: symbol) => {
  if (!showing.delete(me)) return
  for (const next of waiting) next()
}

const pages = () => `${location.protocol}//${location.hostname}:${contentPort(Number(location.port) || (location.protocol === 'https:' ? 443 : 80))}`

/** The page's state, passed down to a picture of it that is being shown: whole at first, and then what changed. */
function StateFor({ artifactId, port }: { artifactId: Id<'artifacts'>; port: MessagePort }) {
  const live = useLiveState(artifactId)
  useEffect(() => {
    const whole = live.whole()
    if (whole) port.postMessage(whole)
    return live.listen((message) => port.postMessage(message))
  }, [live, port])
  return null
}

export function Preview({ artifactId, title, cover }: { artifactId: Id<'artifacts'>; title: string; cover: ReactNode }) {
  const convex = useConvex()
  const box = useRef<HTMLSpanElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [near, setNear] = useState(false)
  const [mine, setMine] = useState(false)
  const [address, setAddress] = useState<string | null>(null)
  const [port, setPort] = useState<MessagePort | null>(null)
  // The picture's showing ran out (the browser slept, or It was started again): it is shown
  // afresh, and no oftener than now and then, so that one that cannot be shown is not asked for in a loop
  const [again, setAgain] = useState(0)
  const lapsedAt = useRef(0)

  // Only a card that is on screen, or about to be, shows its page
  useEffect(() => {
    const el = box.current
    if (!el || !('IntersectionObserver' in window)) return setNear(true)
    const seen = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: '200px 0px' })
    seen.observe(el)
    return () => seen.disconnect()
  }, [])

  // And only so many at once
  useEffect(() => {
    if (!near) return
    const me = Symbol()
    const take = () => {
      if (showing.size >= AT_ONCE) return
      waiting.delete(take)
      showing.add(me)
      setMine(true)
    }
    waiting.add(take)
    take()
    return () => {
      waiting.delete(take)
      setMine(false)
      letGo(me)
    }
  }, [near])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is counted up to have the picture shown afresh, and is read by nothing
  useEffect(() => {
    if (!mine) return
    let live = true
    askTwice(
      convex,
      async (calls) => {
        const m = await calls.mutation(api.mounts.create, { artifactId, displayKey: displayKey() })
        if (!live) return null
        const { ticket } = await calls.action(api.mounts.ticket, { mountId: m.mountId })
        return `${pages()}/open/${ticket}`
      },
      () => live,
    ).then(
      (at) => live && at && setAddress(at),
      // A picture that cannot be had is no fault to tell anyone of: the cover stays
      () => {},
    )
    return () => {
      live = false
      setAddress(null)
      setPort(null)
    }
  }, [mine, convex, artifactId, again])

  // The page's own script says hello, and is given a channel that carries its state to it. What
  // it sends back is refused, each time, so that a script waiting on an answer is given one
  useEffect(() => {
    if (!address) return
    let channel: MessageChannel | null = null
    let answered = ''
    /** The showing afresh that a picture which ran out too soon after the last one is waiting for. */
    let later: ReturnType<typeof setTimeout> | undefined
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const said = e.data as { type?: unknown; doc?: unknown } | null
      if (said?.type !== 'it:hello' || typeof said.doc !== 'string' || !said.doc || said.doc === answered) return
      answered = said.doc
      channel?.port1.close()
      channel = new MessageChannel()
      const mine = channel.port1
      mine.onmessage = (m) => {
        const asked = m.data as { type?: unknown; requestId?: unknown } | null
        if (asked?.type === 'it:lapsed') {
          // One that ran out so soon after the last was begun is shown afresh when that while
          // has passed, and is not let go by: a document says that its showing is over only once
          const afresh = () => {
            lapsedAt.current = Date.now()
            setAgain((n) => n + 1)
          }
          const wait = Math.min(lapsedAt.current + AFRESH_EVERY_MS - Date.now(), AFRESH_EVERY_MS)
          if (wait < 0) afresh()
          else later ??= setTimeout(afresh, wait)
          return
        }
        if (asked?.type !== 'it:action' && asked?.type !== 'it:store') return
        const requestId = typeof asked.requestId === 'string' ? asked.requestId.slice(0, 100) : ''
        mine.postMessage({ type: 'it:result', requestId, ok: false, error: 'This is a picture of the page. Open the page to use it.' } satisfies SiteToPage)
      }
      ;(e.source as Window).postMessage({ type: 'it:port', v: CHANNEL_VERSION }, '*', [channel.port2])
      setPort(mine)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(later)
      channel?.port1.close()
    }
  }, [address])

  return (
    <span className="card-shot" ref={box}>
      {cover}
      {address && (
        <iframe
          ref={frame}
          className="card-frame"
          title={`Preview of ${title}`}
          src={address}
          sandbox={SANDBOX}
          allow="focus-without-user-activation 'none'"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          data-shown={port !== null}
        />
      )}
      {port && <StateFor artifactId={artifactId} port={port} />}
    </span>
  )
}
