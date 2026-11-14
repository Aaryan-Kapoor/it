// The team: the people the person works with, each with browsers of their own that are shown
// the team's pages and what was sent to them, and nothing else. The person's own browser
// invites and removes teammates here, shares a page with the team and sends one for review. A
// teammate's browser is shown what was sent to it, to open and to send back.
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useState } from 'react'
import { Dialog } from './dialog'
import { ago, api, type Id, navigate, refusal, serverNow, useNow } from './lib'
import { NoAddress, useWhere } from './network'

interface Teammate {
  id: string
  name: string
  since: number
  browsers: number
  reviewing: number
}
interface Sent {
  id: string
  slug: string
  title: string
  at: number
  back: number | null
  to?: string
}
interface Card {
  id: string
  slug: string
  title: string
  team?: boolean
  sent?: number
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What removing a teammate ends, said before the person confirms. */
export const removing = (t: Pick<Teammate, 'name' | 'browsers' | 'reviewing'>): string =>
  `Remove ${t.name} from the team? This ends ${count(t.browsers, 'browser', 'browsers')} paired for them and everything that came from ${
    t.browsers === 1 ? 'it' : 'them'
  }, and takes back ${count(t.reviewing, 'page', 'pages')} that ${t.reviewing === 1 ? 'is' : 'are'} out with them.`

/** How a page is marked: who is shown it. */
export const markOf = (p: Pick<Card, 'team' | 'sent'>): string => (p.team ? 'Team' : p.sent ? 'Out for review' : 'Private')

export function Team({ owner }: { owner: boolean }) {
  const team: { you: string | null; teammates: Teammate[] } | undefined = useQuery(api.team.list, {})
  const inbox: Sent[] | undefined = useQuery(api.team.inbox, {})
  const pages: Card[] | undefined = useQuery(api.artifacts.list, {})
  const remove = useMutation(api.team.remove)
  const share = useMutation(api.team.share)
  const send = useMutation(api.team.send)
  const sendBack = useMutation(api.team.sendBack)
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(30_000)
  const act = useCallback((did: Promise<unknown>) => {
    did.then(
      () => setError(''),
      (err) => setError(refusal(err).message),
    )
  }, [])
  if (!team || !inbox) return <main className="list-view" />
  const problem = error && (
    <p className="error" role="alert">
      {error}
    </p>
  )

  // A teammate's browser, or a plain screen: what was sent here, and nothing of the team
  if (!owner)
    return (
      <main className="list-view">
        <header className="list-head">
          <h2>{team.you ? `Sent to you, ${team.you}` : 'Sent to you'}</h2>
        </header>
        {problem}
        {inbox.length === 0 ? (
          <div className="panel panel-pad">
            <p className="modal-lede">
              {team.you
                ? 'Nothing is out with you for review. A page that is sent to you appears here.'
                : 'This browser is a screen, and nothing is sent to a screen for review.'}
            </p>
          </div>
        ) : (
          <ul className="rows panel">
            {inbox.map((x) => (
              <li key={x.id} className="row">
                <span className="row-main">
                  <span className="row-name">{x.title}</span>
                  <span className="row-sub">Sent {ago(x.at, now)}</span>
                </span>
                <span className="row-actions">
                  <button type="button" className="link" onClick={() => navigate(`/p/${encodeURIComponent(x.slug)}`)}>
                    Open
                  </button>
                  <button type="button" className="link" onClick={() => act(sendBack({ artifactId: x.id as Id<'artifacts'> }))}>
                    Send back
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    )

  return (
    <main className="list-view">
      <header className="list-head">
        <h2>Team</h2>
        <button type="button" className="primary" onClick={() => setInviting(true)}>
          Invite a teammate
        </button>
      </header>
      {problem}
      {team.teammates.length === 0 ? (
        <div className="panel panel-pad">
          <p className="modal-lede">
            Nobody is on your team. A teammate has browsers of their own here. They are shown the pages you share with the team and the pages sent to them, and
            none of your private pages, displays or machines.
          </p>
        </div>
      ) : (
        <ul className="rows panel">
          {team.teammates.map((t) => (
            <li key={t.id} className="row">
              <span className="row-main">
                <span className="row-name">{t.name}</span>
                <span className="row-sub">
                  {count(t.browsers, 'browser', 'browsers')} paired · {count(t.reviewing, 'page', 'pages')} out for review
                </span>
              </span>
              <span className="row-actions">
                <button type="button" className="link danger" onClick={() => confirm(removing(t)) && act(remove({ teammate: t.id as Id<'teammates'> }))}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <section>
        <header className="section-head">
          <h3>Who is shown each page</h3>
        </header>
        <ul className="rows panel">
          {(pages ?? []).map((p) => (
            <li key={p.id} className="row">
              <span className="row-main">
                <span className="row-name">
                  {p.title} <span className="chip quiet">{markOf(p)}</span>
                </span>
              </span>
              <span className="row-actions">
                <button type="button" className="link" onClick={() => act(share({ artifactId: p.id as Id<'artifacts'>, team: !p.team }))}>
                  {p.team ? 'Make private' : 'Share with the team'}
                </button>
                {team.teammates.length > 0 && (
                  <select
                    aria-label={`Send ${p.title} to a teammate for review`}
                    value=""
                    onChange={(e) => e.target.value && act(send({ artifactId: p.id as Id<'artifacts'>, to: e.target.value }))}
                  >
                    <option value="">Send to…</option>
                    {team.teammates.map((t) => (
                      <option key={t.id} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {inbox.length > 0 && (
        <section>
          <header className="section-head">
            <h3>Sent for review</h3>
          </header>
          <ul className="rows panel">
            {inbox.map((x) => (
              <li key={`${x.id}-${x.to}`} className="row">
                <span className="row-main">
                  <span className="row-name">{x.title}</span>
                  <span className="row-sub">{x.back === null ? `Out with ${x.to} since ${ago(x.at, now)}` : `${x.to} sent it back ${ago(x.back, now)}`}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {inviting && <Invite onClose={() => setInviting(false)} />}
    </main>
  )
}

/** Inviting a teammate: a name, and then the address that pairs one browser of theirs, good once and for ten minutes. */
function Invite({ onClose }: { onClose: () => void }) {
  const invite = useMutation(api.team.invite)
  const where = useWhere()
  const [name, setName] = useState('')
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState('')
  const now = useNow(5_000)
  const ask = async () => {
    try {
      const r: { code: string; expiresAt?: number } = await invite({ name })
      setMade({ code: r.code, expiresAt: r.expiresAt ?? serverNow() + 600_000 })
      setError('')
    } catch (err) {
      setError(refusal(err).message)
    }
  }
  const ranOut = made !== null && made.expiresAt <= now
  const base = where.address ?? location.origin
  return (
    <Dialog eyebrow="Team" title="Invite a teammate" onClose={onClose} className="pairing">
      {!made || ranOut ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void ask()
          }}
        >
          <p className="modal-lede">{ranOut ? 'That code has run out. Make another for the same teammate.' : 'What is your teammate called?'}</p>
          <input aria-label="Your teammate’s name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary" disabled={!name.trim()}>
            Make a code
          </button>
        </form>
      ) : (
        <>
          <p className="modal-lede">
            Have {name.trim()} open this address in their browser. It pairs that one browser as theirs, works once, and lasts ten minutes. They will see the
            pages you share with the team and the pages sent to them, and nothing else of yours.
          </p>
          <p className="mono pair-address">{`${base}/pair#${encodeURIComponent(made.code)}`}</p>
          {!where.address && <NoAddress where={where} />}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
