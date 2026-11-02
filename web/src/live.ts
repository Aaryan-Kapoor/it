// A page's state as a display keeps it. The backend sends the whole state once, and after that
// only what changed since the revision this display has: the agent's part whole where it
// changed, and each value the page keeps for itself that changed. So a page that keeps a
// thousand strokes and draws one more is sent the one, and so is every display showing it.
// What changed is passed on to the page's frame as it comes, and the whole state is kept here
// for a document of the page that is shown afresh.
import { parseJson, type SiteToPage, STORE_KEY } from '@it/protocol'
import { useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Id } from './lib'

type State = Record<string, unknown>
const isObject = (x: unknown): x is State => typeof x === 'object' && x !== null && !Array.isArray(x)

interface Held {
  revision: number
  agent: State
  kept: Map<string, unknown>
}

/** The whole state of what is held: the agent's part, with what the page keeps under its own key where it keeps anything. */
const wholeOf = (held: Held): State => (held.kept.size > 0 ? { ...held.agent, [STORE_KEY]: Object.fromEntries(held.kept) } : held.agent)
const agentOf = (json: string | undefined): State => {
  const parsed = json === undefined ? undefined : parseJson(json)
  return isObject(parsed) ? parsed : {}
}

export interface LiveState {
  /** The whole state as it is held now, as a message for a document that has just been given its channel; none until it has arrived. */
  whole: () => SiteToPage | null
  /** Hears each message that brings the page's frame up to date. Returns how to stop hearing. */
  listen: (hear: (message: SiteToPage) => void) => () => void
}

/** A page's state, kept up to date by what changed, for the frames that show it. */
export function useLiveState(artifactId: Id<'artifacts'>): LiveState {
  const [asked, setAsked] = useState<{ artifactId: Id<'artifacts'>; since?: number }>({ artifactId })
  // Another page is a state of its own, begun again from nothing
  const since = asked.artifactId === artifactId ? asked.since : undefined
  const answer = useQuery(api.state.live, { artifactId, ...(since === undefined ? {} : { since }) })
  const held = useRef<Held | null>(null)
  const heldFor = useRef(artifactId)
  const hearers = useRef(new Set<(message: SiteToPage) => void>())
  if (heldFor.current !== artifactId) {
    heldFor.current = artifactId
    held.current = null
  }

  useEffect(() => {
    if (!answer) return
    const tell = (message: SiteToPage) => {
      for (const hear of [...hearers.current]) hear(message)
    }
    const now = held.current
    if (answer.whole || !now) {
      // The first state, or one from which what came before is not to be built on. An answer
      // that is no whole state when nothing is held yet cannot be, and is asked again whole
      if (!answer.whole) return setAsked({ artifactId })
      const kept = new Map<string, unknown>()
      for (const [key, json] of answer.kept ?? []) if (json !== null) kept.set(key, parseJson(json))
      held.current = { revision: answer.revision, agent: agentOf(answer.state), kept }
      tell({ type: 'it:state', state: wholeOf(held.current), revision: answer.revision })
    } else if (answer.revision > now.revision) {
      const kept: [string, unknown][] = []
      for (const [key, json] of answer.kept ?? []) {
        const value = json === null ? null : parseJson(json)
        if (value === null) now.kept.delete(key)
        else now.kept.set(key, value)
        kept.push([key, value])
      }
      if (answer.state !== undefined) now.agent = agentOf(answer.state)
      now.revision = answer.revision
      tell({ type: 'it:changed', revision: answer.revision, ...(answer.state !== undefined ? { state: now.agent } : {}), kept })
    }
    // Asked from here on for what changes after this
    if (held.current && answer.revision !== since) setAsked({ artifactId, since: held.current.revision })
  }, [answer, artifactId, since])

  const whole = useCallback(
    (): SiteToPage | null => (held.current ? { type: 'it:state', state: wholeOf(held.current), revision: held.current.revision } : null),
    [],
  )
  const listen = useCallback((hear: (message: SiteToPage) => void) => {
    hearers.current.add(hear)
    return () => void hearers.current.delete(hear)
  }, [])
  return useMemo(() => ({ whole, listen }), [whole, listen])
}
