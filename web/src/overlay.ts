import type { RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'

// Only the last opened dialog takes keys. Capture keeps Escape from reaching the page below.
const layers: HTMLElement[] = []
export function useDialogKeys(panel: RefObject<HTMLElement | null>, close: () => void, open = true, opener?: RefObject<HTMLElement | null>) {
  const [before] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const closing = useRef(close)
  closing.current = close
  useEffect(() => {
    const box = panel.current
    if (!open || !box) return
    layers.push(box)
    if (!box.contains(document.activeElement)) box.focus()
    const key = (event: KeyboardEvent) => {
      if (layers.at(-1) !== box) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closing.current()
      } else if (event.key === 'Tab') {
        const all = [...box.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.hasAttribute('disabled') &&
            !element.closest('[hidden], [inert]') &&
            getComputedStyle(element).display !== 'none' &&
            getComputedStyle(element).visibility !== 'hidden',
        )
        const first = all[0]
        const last = all.at(-1)
        const at = document.activeElement
        if (!first || !last || !all.includes(at as HTMLElement) || (event.shiftKey && at === first) || (!event.shiftKey && at === last)) {
          event.preventDefault()
          ;(event.shiftKey ? (last ?? box) : (first ?? box)).focus()
        }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => {
      const top = layers.at(-1) === box
      layers.splice(layers.indexOf(box), 1)
      document.removeEventListener('keydown', key, true)
      const target = opener?.current ?? before
      if (top && target?.isConnected && (box.contains(document.activeElement) || document.activeElement === document.body)) target.focus()
    }
  }, [panel, open, opener, before])
}
