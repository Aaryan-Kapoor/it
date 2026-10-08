import { ConvexProviderWithAuth } from 'convex/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { caught, connect } from './backend'
import { dropOld } from './outbox'
import { begin, EARLY_MS, useLiveSession } from './session'
import './styles.css'

// The site and the backend are reached at one address: the live connection goes to wherever
// the site itself came from
const convex = connect(location.origin, { authRefreshTokenLeewaySeconds: EARLY_MS / 1000 })
/**
 * Whether this browser lets the site keep anything in it. The site keeps which display this
 * browser is, and what was done on a page until It has it: where a browser refuses that
 * outright (its storage is switched off for sites, as some settings and some private windows
 * do), nothing of the site works, and that is said in place of a screen with nothing on it.
 */
const keeps = (() => {
  try {
    // Reading is what a browser that refuses a site its storage does not allow at all
    void localStorage.length
    void localStorage.getItem('it.display')
  } catch {
    return false
  }
  try {
    localStorage.setItem('it.keeps', '1')
    localStorage.removeItem('it.keeps')
  } catch (err) {
    // Full, and not refused: what is kept here can still be read and sent, which is what makes room again
    return (err as { name?: string } | null)?.name === 'QuotaExceededError'
  }
  return true
})()
if (keeps) {
  // What was done on a page too long ago to be sent is not kept, whoever is paired here now
  try {
    dropOld()
  } catch {}
  // A code in the address is seen to, and the backend is asked whether this browser is paired,
  // before anything is shown
  void begin()
}

createRoot(document.getElementById('root')!, { onCaughtError: caught }).render(
  !keeps ? (
    <main className="splash" role="alert">
      <p>
        This browser will not let a site keep anything in it, and It needs to: which display this browser is, and what you do on a page until it has been sent.
        Allow site data (cookies and storage) for this address, or open it in a window that is not private, and load it again.
      </p>
      <button type="button" onClick={() => location.reload()}>
        Load it again
      </button>
    </main>
  ) : (
    <StrictMode>
      <ConvexProviderWithAuth client={convex} useAuth={useLiveSession}>
        <App />
      </ConvexProviderWithAuth>
    </StrictMode>
  ),
)
