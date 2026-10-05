// The one box every dialog of the site is built to, and a button that copies what is beside it.
import { type ReactNode, useEffect, useState } from 'react'
import { copy, IconCopy } from './brand'

/**
 * A dialog over whatever is on screen. It opens with a small word that says what it is about
 * and a title under it. Escape closes it, and so does a click outside the box.
 */
export function Dialog({
  eyebrow,
  title,
  onClose,
  children,
  className = '',
}: {
  eyebrow: string
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  // Drawn hidden and shown a moment later, so that it eases in
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true))
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(t)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, wherever the keyboard is
    // biome-ignore lint/a11y/noStaticElementInteractions: the box itself is the dialog
    <div className={`modal-overlay${shown ? ' modal-overlay--visible' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal-panel ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="modal-eyebrow">{eyebrow}</div>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Something to copy, in letters of one width, with the button that copies it. */
export function Copyable({ text, label = 'Copy', prompt = false }: { text: string; label?: string; prompt?: boolean }) {
  const [said, setSaid] = useState('')
  return (
    <div className="copyable">
      {prompt && <span className="copyable-prompt">$</span>}
      <code className="copyable-text">{text}</code>
      <button
        type="button"
        className="copyable-btn"
        onClick={async () => {
          setSaid((await copy(text)) ? 'Copied' : 'Copy failed')
          setTimeout(() => setSaid(''), 1600)
        }}
      >
        <IconCopy />
        {said || label}
      </button>
    </div>
  )
}
