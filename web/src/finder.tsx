// Finding a page by its name, from anywhere on the site, with the keyboard.
import { NOUN } from '@it/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ago, navigate, useNow } from './lib'
import { agentName, type Card } from './pages'

export function Finder({ pages, onClose }: { pages: Card[]; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [at, setAt] = useState(0)
  const [shown, setShown] = useState(false)
  const now = useNow()
  const list = useRef<HTMLDivElement>(null)
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
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' })
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, from the field
    // biome-ignore lint/a11y/noStaticElementInteractions: the box itself is the dialog
    <div className={`finder-overlay${shown ? ' finder-overlay--visible' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder-panel" role="dialog" aria-label={`Find a ${NOUN.one}`}>
        <div className="finder-input-wrap">
          <input
            className="finder-input"
            // biome-ignore lint/a11y/noAutofocus: opened by the person a moment ago, to type in
            autoFocus
            placeholder={`Find a ${NOUN.one}…`}
            aria-label={`Find a ${NOUN.one}`}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') move(active + 1)
              else if (e.key === 'ArrowUp') move(active - 1)
              else if (e.key === 'Enter') open(found[active])
              else return
              e.preventDefault()
            }}
          />
        </div>
        <div className="finder-results" role="listbox" ref={list}>
          {found.length === 0 && <div className="finder-empty">{`No ${NOUN.many} match “${typed.trim()}”`}</div>}
          {found.map((p, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field takes the keys for the whole list
            <div
              key={p.id}
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
