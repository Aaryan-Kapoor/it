// The browsers that are paired with It, for the owner to see and to end, and what ending a
// browser or revoking a machine takes along. A paired browser is shown whether or not it ever
// registered as a display: one that did not is as much a way in as one that did.
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { ago, api, type Id, refusal, useNow } from './lib'

export interface Paired {
  id: string
  role: 'owner' | 'screen'
  pairedAt: number
  lastSeenAt: number
  mine: boolean
  /** The displays it registered: none, for a browser that never registered as one. */
  displays: { id: string; name: string }[]
  /** What asked for the code it was paired with: a machine, or a browser, by the name of the display that browser is, and whether that browser is paired still. */
  invitedBy: { kind: 'machine'; name: string } | { kind: 'browser'; paired: boolean; name: string | null } | null
  /** What ending it ends with it: the paired browsers and the machines that came from it, each by its id. */
  along: { browsers: string[]; machines: string[] }
}

/** A number of things, in words: "1 machine", "3 machines". */
const some = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** That so many paired browsers and machines came from something and are ended with it, as a sentence. Nothing, when none did. */
function cameFromIt(browsers: number, machines: number): string {
  const along = [browsers ? some(browsers, 'paired browser', 'paired browsers') : '', machines ? some(machines, 'machine', 'machines') : ''].filter(Boolean)
  return along.length ? `${along.join(' and ')} came from it, and ${browsers + machines === 1 ? 'is' : 'are'} ended with it.` : ''
}

/**
 * What ending a paired browser takes along, said before the person confirms: how many paired
 * browsers and machines came from it, and that the browser being read on is one of them when
 * it is. Nothing, when nothing came from it.
 */
export function goesAlong(along: Paired['along'] | undefined, me: string | undefined): string {
  if (!along) return ''
  const said = cameFromIt(along.browsers.length, along.machines.length)
  if (!said || me === undefined || !along.browsers.includes(me)) return said
  return `${said} ${along.browsers.length === 1 ? 'This browser is that one.' : 'This browser is one of them.'}`
}

/** What the person is asked before every paired browser but the one being read on is ended. */
function endingOthers(paired: Paired[]): string {
  const others = paired.filter((s) => !s.mine)
  const machines = new Set(others.flatMap((s) => s.along.machines)).size
  const me = paired.find((s) => s.mine)?.id
  const said = [
    `End all others? The ${some(others.length, 'paired browser', 'paired browsers')} besides this one ${others.length === 1 ? 'is' : 'are'} signed out at once, and each has to be paired again before it can be used.`,
  ]
  if (machines) said.push(`${some(machines, 'machine', 'machines')} that came from them ${machines === 1 ? 'is' : 'are'} ended with them.`)
  // This browser was paired with a code from a machine that one of the others added, and so came
  // from that one. Ending every other browser never ends the one it is asked from
  if (me !== undefined && others.some((s) => s.along.browsers.includes(me))) said.push('This browser came from one of them, and stays paired.')
  return said.join(' ')
}

/** What asked for the code a browser was paired with, as the end of a sentence. */
function letInBy(by: Paired['invitedBy']): string {
  if (!by) return ''
  if (by.kind === 'machine') return ` with a code the machine “${by.name}” asked for`
  if (!by.paired) return ' with a code asked for by a browser whose pairing has ended since'
  return by.name === null ? ' with a code a paired browser asked for' : ` with a code the browser “${by.name}” asked for`
}

/**
 * Every paired browser, on the Displays page: which displays it is, or that it is none; whether
 * it is the owner's or a screen; when it was paired, and by whose code; and when it was last
 * used. Each can be ended, and all but the one being read on can be ended at once. Before the
 * person confirms an ending, they are told how many paired browsers and machines go with it.
 */
export function PairedBrowsers() {
  const paired = useQuery(api.sessions.list, {}) as Paired[] | undefined
  const end = useMutation(api.sessions.end)
  const endOthers = useMutation(api.sessions.endOthers)
  const now = useNow()
  const [error, setError] = useState('')
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  if (paired === undefined) return null
  const others = paired.filter((s) => !s.mine).length
  const me = paired.find((s) => s.mine)?.id
  return (
    <section>
      <header className="section-head">
        <h3>Paired browsers</h3>
        <button type="button" className="link danger" disabled={others === 0} onClick={() => confirm(endingOthers(paired)) && act(endOthers({}))}>
          End all others
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows panel">
        {paired.map((s) => (
          <li key={s.id} className="row">
            <span className="row-main">
              <span className="row-name">
                {s.displays.length ? s.displays.map((d) => d.name).join(', ') : 'No display'}
                {s.mine && <span className="chip quiet">This browser</span>}
                <span className="chip quiet">{s.role === 'owner' ? 'Yours' : 'Screen'}</span>
              </span>
              <span className="row-sub">
                Paired {ago(s.pairedAt, now)}
                {letInBy(s.invitedBy)}
                {/* A browser's use is noted once an hour, so nothing finer than that is said of it */}
                {s.mine ? ' · Open now' : now - s.lastSeenAt < 3_600_000 ? ' · Used within the last hour' : ` · Last used ${ago(s.lastSeenAt, now)}`}
              </span>
            </span>
            <span className="row-actions">
              <button
                type="button"
                className="link danger"
                onClick={() =>
                  confirm(
                    [
                      s.mine
                        ? 'End this browser’s pairing? This browser is signed out, and has to be paired again before it can be used.'
                        : 'End this paired browser? It is signed out at once, and pages open on it stop working. It has to be paired again before it can be used.',
                      goesAlong(s.along, me),
                    ]
                      .filter(Boolean)
                      .join(' '),
                  ) && act(end({ session: s.id as Id<'sessions'> }))
                }
              >
                End
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface Revocable {
  id: string
  name: string
  /** Whether it is the machine It runs on. */
  runsIt?: boolean
  /** What descends from it, and so goes with it: paired browsers, whether the one being read on is among them, and machines. */
  descendants?: { browsers: number; mine: boolean; machines: number }
}

/** What the person is told before a machine is revoked: what ends at once, what goes with it, and how it is used again. */
function revoking(m: Revocable): string {
  const { browsers = 0, mine = false, machines = 0 } = m.descendants ?? {}
  const said = [`Revoke “${m.name}”? Its agents can ask nothing more of It from this moment, though an upload already begun may still finish.`]
  const along = cameFromIt(browsers, machines)
  if (along) said.push(along)
  if (m.runsIt) {
    if (browsers) said.push(`This is the machine It runs on, so that is every browser you have paired${mine ? ', this one too' : ''}.`)
    said.push(
      'To use It again, run it setup on that machine, which enrols it anew and gives it back the pages it made, and then it site, which pairs a browser.',
    )
  } else {
    if (mine) said.push(browsers === 1 ? 'This browser is that one.' : 'This browser is one of them.')
    said.push('To use it again, run it logout on it and add it again with “Add a machine”.')
  }
  return said.join(' ')
}

/** The Revoke button of a machine on the Machines page. It says, before the person confirms, how many paired browsers and machines go with the machine. */
export function RevokeMachine({ m, act }: { m: Revocable; act: (p: Promise<unknown>) => Promise<void> }) {
  const revoke = useMutation(api.machines.revoke)
  return (
    <button type="button" className="link danger" onClick={() => confirm(revoking(m)) && act(revoke({ machineId: m.id as Id<'machines'> }))}>
      Revoke
    </button>
  )
}
