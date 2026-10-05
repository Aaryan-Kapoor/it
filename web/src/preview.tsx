// A card's picture of its page: the page itself, shown small and out of reach. It is a showing
// like any other, with a ticket of its own, so what is in the frame is held to everything a page
// is held to. Nothing done in it reaches the backend: the site gives it the page's state, so
// that it looks as the page looks now, and takes nothing from it.
import { contentPort, parseJson, SANDBOX, type SiteToPage } from '@it/protocol'
import { useConvex, useQuery } from 'convex/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { askTwice } from './backend'
import { api, displayKey, type Id } from './lib'

/** How many cards show their page at once. The rest show their cover until one of these leaves the screen. */
const AT_ONCE = 9
const showing = new Set<symbol>()
const waiting = new Set<() => void>()
const letGo = (me: symbol) => {
  if (!showing.delete(me)) return
  for (const next of waiting) next()
}

const pages = () => `${location.protocol}//${location.hostname}:${contentPort(Number(location.port) || (location.protocol === 'https:' ? 443 : 80))}`

/** The page's state, passed down to a picture of it that is being shown. */
function StateFor({ artifactId, port }: { artifactId: Id<'artifacts'>; port: MessagePort }) {
  const state = useQuery(api.state.get, { artifactId })
  useEffect(() => {
    if (state) port.postMessage({ type: 'it:state', state: parseJson(state.json) ?? {}, revision: state.revision } satisfies SiteToPage)
  }, [state, port])
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
  }, [mine, convex, artifactId])

  // The page's own script says hello, and is given a channel that carries its state to it. What
  // it sends back is refused, each time, so that a script waiting on an answer is given one
  useEffect(() => {
    if (!address) return
    let channel: MessageChannel | null = null
    let answered = ''
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
        if (asked?.type !== 'it:action' && asked?.type !== 'it:store') return
        const requestId = typeof asked.requestId === 'string' ? asked.requestId.slice(0, 100) : ''
        mine.postMessage({ type: 'it:result', requestId, ok: false, error: 'This is a picture of the page. Open the page to use it.' } satisfies SiteToPage)
      }
      ;(e.source as Window).postMessage({ type: 'it:port' }, '*', [channel.port2])
      setPort(mine)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
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
