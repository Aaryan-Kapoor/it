// Finding a page by its name, from anywhere on the site, with the keyboard.
import { NOUN } from '@it/protocol'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ago, navigate, useNow } from './lib'
import { useDialogKeys } from './overlay'
import { agentName, type Card } from './pages'

export function Finder({ pages, onClose }: { pages: Card[]; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [at, setAt] = useState(0)
  const [shown, setShown] = useState(false)
  const now = useNow()
  const list = useRef<HTMLDivElement>(null)
  // The keyboard stays in the field while the arrows choose a result, so which result is chosen
  // is the field's to say, to whoever cannot see the list: it names the list as its own, and the
  // chosen result in it, by these
  const id = useId()
  const named = (p: Card) => `${id}-${p.id}`
  const field = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useDialogKeys(panel, onClose)
  const found = useMemo(() => {
    const q = typed.trim().toLowerCase()
    const all = [...pages].sort((a, b) => b.updatedAt - a.updatedAt)
    return (q ? all.filter((p) => p.title.toLowerCase().includes(q) || p.slug.includes(q)) : all).slice(0, 50)
  }, [pages, typed])
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(t)
  }, [])
  const active = Math.min(at, Math.max(0, found.length - 1))
  const open = (p: Card | undefined) => {
    if (!p) return
    onClose()
    navigate(`/p/${p.slug}`)
  }
  const move = (to: number) => {
    if (!found.length) return
    const next = (to + found.length) % found.length
    setAt(next)
    list.current?.children[next]?.scrollIntoView?.({ block: 'nearest' })
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, wherever the keyboard is
    // biome-ignore lint/a11y/noStaticElementInteractions: the box itself is the dialog
    <div className={`finder-overlay${shown ? ' finder-overlay--visible' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} className="finder-panel" role="dialog" aria-modal="true" aria-label={`Find a ${NOUN.one}`}>
        <div className="finder-input-wrap">
          <input
            ref={field}
            className="finder-input"
            // biome-ignore lint/a11y/noAutofocus: opened by the person a moment ago, to type in
            autoFocus
            placeholder={`Find a ${NOUN.one}…`}
            aria-label={`Find a ${NOUN.one}`}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={found[active] ? named(found[active]) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') move(active + 1)
              else if (e.key === 'ArrowUp') move(active - 1)
              else if (e.key === 'Enter') open(found[active])
              else return
              e.preventDefault()
            }}
          />
        </div>
        {/* That nothing matches is said aloud too. Kept here empty while something does: what is put in place with its words already in it is not always said */}
        <span className="sr-only" role="status">
          {found.length === 0 ? `No ${NOUN.many} match “${typed.trim()}”` : ''}
        </span>
        <div className="finder-results" role="listbox" id={`${id}-list`} aria-label={NOUN.Many} ref={list}>
          {found.length === 0 && <div className="finder-empty" aria-hidden="true">{`No ${NOUN.many} match “${typed.trim()}”`}</div>}
          {found.map((p, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field takes the keys for the whole list
            <div
              key={p.id}
              id={named(p)}
              className={`finder-result${i === active ? ' finder-result--active' : ''}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              onMouseEnter={() => setAt(i)}
              onClick={() => open(p)}
            >
              <div className="finder-result-title">{p.title}</div>
              <div className="finder-result-sub">{[agentName(p.agent), ago(p.updatedAt, now)].filter(Boolean).join(' · ')}</div>
            </div>
          ))}
        </div>
        <div className="finder-footer">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
