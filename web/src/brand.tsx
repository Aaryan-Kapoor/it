// The name as it is drawn, and the small pictures the site's buttons carry. All of them are
// drawn here and none is fetched, so a display shows them with no connection.

/**
 * The wordmark: "it" in white and a green dot after it. The two letters are drawn as outlines,
 * so they look the same whatever fonts a display has. It takes its size from the text around
 * it, and its colour from the text's own.
 */
export function Mark({ label = 'It' }: { label?: string }) {
  return (
    <svg className="wordmark" viewBox="83 -1503 1472 1503" role="img" aria-label={label}>
      <path
        fill="currentColor"
        d="M104 0H399V-1056H104ZM251 -1189C348 -1189 419 -1256 419 -1346C419 -1436 348 -1503 251 -1503C154 -1503 83 -1436 83 -1346C83 -1256 154 -1189 251 -1189ZM1111.6 -1056H895.6V-1344H600.6V-1056H418.6V-825H600.6V-280C600.6 -88 707.6 0 939.6 0H1111.6V-231H998.6C918.6 -231 895.6 -254 895.6 -326V-825H1111.6Z"
      />
      <circle className="wordmark-dot" cx="1350" cy="-205" r="205" />
    </svg>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const IconBell = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke} strokeWidth="1.4">
    <path d="M4 6.6a4 4 0 0 1 8 0c0 2.5.7 3.7 1.2 4.3.3.3.1.8-.3.8H3.1c-.4 0-.6-.5-.3-.8.5-.6 1.2-1.8 1.2-4.3Z" />
    <path d="M6.5 14a1.7 1.7 0 0 0 3 0" />
  </svg>
)
export const IconGuide = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke} strokeWidth="1.4">
    <path d="M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13Z" />
    <path d="M6.2 6.1a1.9 1.9 0 1 1 2.6 1.77c-.5.19-.8.62-.8 1.13v.35" />
    <circle cx="8" cy="11.6" r="0.85" fill="currentColor" stroke="none" />
  </svg>
)
export const IconMore = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
)
export const IconBack = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" {...stroke} strokeWidth="2.1">
    <path d="M15 5l-7 7 7 7" />
  </svg>
)
export const IconLink = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" {...stroke} strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7.1.1l2.9-2.9a5 5 0 0 0-7.1-7.1L11.3 4.7" />
    <path d="M14 11a5 5 0 0 0-7.1-.1L4 13.8a5 5 0 0 0 7.1 7.1l1.5-1.5" />
  </svg>
)
export const IconCopy = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" {...stroke} strokeWidth="2">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
export const IconPin = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" {...stroke} strokeWidth="2">
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
  </svg>
)
export const IconX = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" {...stroke} strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export const IconStop = () => (
  <svg viewBox="0 0 24 24" width="9" height="9" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
  </svg>
)

/** Puts text on the clipboard, and says whether it got there. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // A page reached over plain http by another name than this machine's has no clipboard to
    // write to. The older way still works there, from a field that holds the text
    const field = Object.assign(document.createElement('textarea'), { value: text })
    field.className = 'offscreen'
    document.body.append(field)
    field.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {}
    field.remove()
    return ok
  }
}
