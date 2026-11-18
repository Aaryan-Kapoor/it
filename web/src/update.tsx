// What the site says of a newer It: under each machine's name on the Machines page, in a banner
// at the top of the home page for the machine It runs on, and as a small mark in the top bar.
// Every word and every state comes from `updateSaid` here, so the places can never say
// different things of one machine. All of it is shown only in the owner's browser, which is
// the one that may read the machines and ask for an update; a screen is shown none of it.
import { ALIVE, newer, UPGRADE_MS } from '@it/protocol'
import { useMutation, useQuery } from 'convex/react'
import { Component, type ReactNode, useState } from 'react'
import { api, type Id, navigate, refusal, useNow } from './lib'

/** What of a machine the words about an update are made from, as `machines.list` gives it. */
export interface Upgradable {
  id: string
  name: string
  lastSeenAt: number
  connectorVersion: string | null
  system?: string | null
  off?: boolean
  runsIt?: boolean
  latest?: string | null
  upgrade?: { at: number; state: 'asked' | 'working' | 'restarting' | 'failed' | 'installed' | 'done'; why?: string; version?: string } | null
  harnesses: { id: string; addon: string }[]
}

/** How long the site says that an update it was asked for is over, and what is left to do after it. */
export const DONE_SAID_MS = 6 * 60 * 60_000

/** What becomes of a Claude Code chat that was open across an update: nothing needs doing in it but where its page says so. */
const CLAUDE_OPEN =
  'A Claude Code chat that was already open there goes on with the add-on it loaded, which still takes clicks. Type /reload-plugins only in one whose page says it cannot hear it.'

/** Whether a machine's connector is there to be asked now. */
export const online = (m: Upgradable, now: number): boolean => !m.off && now - m.lastSeenAt < ALIVE.onlineMs && m.connectorVersion !== null

/**
 * Where an update of one machine stands, and what to say of it: the words, with a command to
 * run between backticks, how they are coloured, and the button there is to press, if any.
 */
export interface UpdateSaid {
  kind: 'out' | 'first' | 'working' | 'restarting' | 'failed' | 'cut-short' | 'not-heard' | 'installed' | 'done' | 'behind'
  words: string
  tone?: 'wait' | 'bad'
  press: 'Update' | 'Try again' | null
}

/**
 * What is said of a newer It on one machine, or null where nothing is. `host` is the version
 * the machine It runs on runs. The machine It runs on goes first: another at a newer version
 * than that one would ask for what the backend there does not have yet. `now` is by the
 * backend's clock, which is the one the asking was timed by.
 */
export function updateSaid(m: Upgradable, host: string | null, now: number): UpdateSaid | null {
  const out = newer(m.latest, m.connectorVersion) ? (m.latest as string) : null
  const state = m.upgrade?.state
  // Claude Code has It's add-on there: its conversations that were open go on with the add-on they loaded, which still takes
  // clicks, and only one that never loaded it needs /reload-plugins, which its page says (see RELOAD_OPEN in the program)
  const claude = m.harnesses.some((h) => h.id === 'claude-code' && (h.addon === 'connected' || h.addon === 'needs_approval'))
  if (state === 'installed')
    // Said by a machine that could not start It again by itself: one started in a terminal, and one whose service was registered by an It
    // from before 0.1.35, whose launcher does not say that it is the service, as well as an older It that sent every Windows machine here
    return {
      kind: 'installed',
      tone: 'wait',
      press: null,
      words:
        `It ${m.upgrade?.version ?? ''} is installed on ${m.name}. It runs once It is started again there. If you started It in a terminal with \`it serve\`, stop it and start it again. ` +
        'Otherwise run `it setup` in a terminal on that machine, which starts It again and lets the next update start it again by itself. ' +
        'As it starts it brings the add-ons in the agent apps there up to date. ' +
        (claude
          ? CLAUDE_OPEN
          : 'An app that is already running goes on with the add-on it loaded until it is restarted, and its line on this page then says so.'),
    }
  const behind = !m.runsIt && newer(host, m.connectorVersion)
  // An update the site asked for is over: said for a few hours, with what is left to do there, unless something newer waits already
  if (state === 'done' && now - (m.upgrade?.at ?? 0) < DONE_SAID_MS && !out && !behind)
    return { kind: 'done', press: null, words: `It ${m.upgrade?.version ?? m.connectorVersion} is running on ${m.name}.${claude ? ` ${CLAUDE_OPEN}` : ''}` }
  if (!out || (behind && newer(host, out)))
    return behind
      ? {
          kind: 'behind',
          tone: 'wait',
          press: null,
          words: `This machine runs It ${m.connectorVersion}. The machine It runs on uses ${host}. A matching release has not been confirmed here. Run \`it upgrade --check\` on this machine to check for updates.`,
        }
      : null
  // At work for as long as an upgrade takes, and no longer: one that has said nothing since
  // was cut short, and is said to have been, with the way to ask for it again. A machine that
  // was starting again as the new program and has not reported it since did not start as it:
  // its launcher goes on trying, and what it met is in the service's log there.
  const restarting = state === 'restarting'
  const asked = state === 'asked' || state === 'working' || restarting
  const cutShort = asked && now - (m.upgrade?.at ?? 0) > UPGRADE_MS
  if (asked && !cutShort)
    return restarting
      ? { kind: 'restarting', press: null, words: `Starting again as It ${out}…` }
      : { kind: 'working', press: null, words: `Updating to It ${out}…` }
  const said: UpdateSaid =
    state === 'failed'
      ? {
          kind: 'failed',
          tone: 'bad',
          press: 'Try again',
          words: `The update to It ${out} did not finish: ${(m.upgrade?.why ?? 'it is not known why').replace(/\.$/, '')}.`,
        }
      : cutShort && restarting
        ? {
            kind: 'not-heard',
            tone: 'bad',
            press: 'Try again',
            words: `It ${out} is in place, and has not been heard from since it was started. Run it service logs on that machine to read why.`,
          }
        : cutShort
          ? {
              kind: 'cut-short',
              tone: 'bad',
              press: 'Try again',
              words: `The update to It ${out} did not finish. This machine still runs ${m.connectorVersion}.`,
            }
          : { kind: 'out', press: 'Update', words: `It ${out} is out. This machine runs ${m.connectorVersion}.` }
  // A machine that joined this It, offered a newer one than the machine It runs on has: that one is updated first, and this has no button until it is
  if (!m.runsIt && newer(out, host))
    return { ...said, kind: said.kind === 'out' ? 'first' : said.kind, press: null, words: `${said.words} Update the machine It runs on first.` }
  return said
}

/** A sentence with what it puts in backticks, a command to run, shown as code. */
export const withCode = (said: string) => {
  const parts = said.split('`')
  // Where the backticks do not pair up, the sentence is shown as it is
  if (parts.length % 2 === 0) return said
  // Every other part is between backticks, and each is known by where it begins in the sentence
  let at = 0
  let inside = true
  return parts.map((part) => {
    const from = at
    at += part.length + 1
    inside = !inside
    return inside ? <code key={from}>{part}</code> : part
  })
}

/**
 * What is said of an update of one machine, with the button that has the machine put it in
 * place. The machine fetches what the place releases are kept says is newest and checks it as
 * an install does: nothing here says which version or where from.
 */
export function UpdateNote({ m, said, on, act }: { m: Upgradable; said: UpdateSaid; on: boolean; act: (p: Promise<unknown>) => Promise<void> }) {
  const upgrade = useMutation(api.machines.upgrade)
  return (
    // Polite, so that a reader hears it move from updating to starting again to done without being interrupted
    <p className="update newer" data-tone={said.tone} data-kind={said.kind} aria-live="polite">
      <span>{withCode(said.words)}</span>
      {said.press && ' '}
      {said.press && (
        <button
          type="button"
          className="primary"
          disabled={!on}
          title={on ? undefined : 'This machine is off'}
          onClick={() => void act(upgrade({ machineId: m.id as Id<'machines'> }))}
        >
          {said.press}
        </button>
      )}
    </p>
  )
}

/** Machines that joined this It and have an update waiting that the person can act on, from the Machines page. */
function waitingElsewhere(machines: Upgradable[], host: string | null, now: number): Upgradable[] {
  return machines.filter((m) => {
    if (m.runsIt) return false
    const said = updateSaid(m, host, now)
    // One at work, and one whose update is over, wants nothing of the person
    return said !== null && said.kind !== 'done' && said.kind !== 'working' && said.kind !== 'restarting'
  })
}

/** Names, as a sentence says them: "the laptop", "the laptop and the studio", "the laptop and 3 other machines". */
const names = ([first, ...rest]: Upgradable[]): string =>
  rest.length === 0 ? (first?.name ?? '') : rest.length === 1 ? `${first?.name} and ${rest[0]?.name}` : `${first?.name} and ${rest.length} other machines`

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const BANNER_ID = 'it-update'

/**
 * The banner at the top of the home page. The machine It runs on comes first, with the button
 * that updates it and every state of that update. A machine that joined this It and is behind
 * is said in one line under it, with the way to the Machines page, where its own button is.
 */
export function UpdateBanner() {
  const machines = useQuery(api.machines.list, {}) as Upgradable[] | undefined
  const now = useNow(15_000)
  const [error, setError] = useState('')
  if (!machines) return null
  const here = machines.find((m) => m.runsIt)
  const host = here?.connectorVersion ?? null
  const said = here ? updateSaid(here, host, now) : null
  const others = waitingElsewhere(machines, host, now)
  if (!said && others.length === 0) return null
  const act = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  return (
    <section className="update-banner" id={BANNER_ID} tabIndex={-1} aria-label="Update of It">
      {here && said && <UpdateNote m={here} said={said} on={online(here, now)} act={act} />}
      {others.length > 0 && (
        <p className="update" data-kind="joined">
          <span>{`${capital(names(others))} ${others.length === 1 ? 'has' : 'have'} an update of It waiting.`}</span>{' '}
          <a
            className="update-link"
            href="/machines"
            onClick={(e) => {
              e.preventDefault()
              navigate('/machines')
            }}
          >
            Go to Machines
          </a>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * The small mark beside the version in the top bar, on every page of the site, while an update
 * of the machine It runs on is out, at work or waits on the person. It leads to the banner.
 */
export function UpdateMark() {
  const machines = useQuery(api.machines.list, {}) as Upgradable[] | undefined
  const now = useNow(15_000)
  const here = machines?.find((m) => m.runsIt)
  const said = here ? updateSaid(here, here.connectorVersion, now) : null
  if (!said || said.kind === 'done') return null
  const label = said.kind === 'working' || said.kind === 'restarting' ? 'updating' : 'update'
  return (
    <a
      className="update-mark"
      href="/"
      data-tone={said.tone}
      title={said.words.replaceAll('`', '')}
      onClick={(e) => {
        e.preventDefault()
        navigate('/')
        // Once the home page is there, to the banner's button, or to the banner where it has none
        setTimeout(() => {
          const banner = document.getElementById(BANNER_ID)
          const button = banner?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          ;(button ?? banner)?.focus()
        }, 0)
      }}
    >
      {label}
    </a>
  )
}

/**
 * Around the banner and the mark: where the backend refuses the machines for a moment, they are
 * left out and asked for again half a minute on, and nothing else on the site is taken down with
 * them. A refusal as from nobody is passed on, to be answered as the site answers it anywhere.
 */
export class Quietly extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown }
  private timer: ReturnType<typeof setTimeout> | undefined
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override componentDidCatch() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.setState({ error: null }), 30_000)
  }
  override componentWillUnmount() {
    clearTimeout(this.timer)
  }
  override render() {
    if (this.state.error && refusal(this.state.error).code === 'unauthenticated') throw this.state.error
    return this.state.error ? null : this.props.children
  }
}
