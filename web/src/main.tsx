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
// What was done on a page too long ago to be sent is not kept, whoever is paired here now
dropOld()
// A code in the address is seen to, and the backend is asked whether this browser is paired,
// before anything is shown
void begin()

createRoot(document.getElementById('root')!, { onCaughtError: caught }).render(
  <StrictMode>
    <ConvexProviderWithAuth client={convex} useAuth={useLiveSession}>
      <App />
    </ConvexProviderWithAuth>
  </StrictMode>,
)
