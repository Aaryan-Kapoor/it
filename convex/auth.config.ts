// Who the backend believes: only tokens it made itself (http.ts), each for a named audience.
//  - a machine, with the five-minute token its key earns it
//  - a paired browser, with the five-minute token its session earns it
import { AUDIENCE } from '@it/protocol'

const site = process.env.CONVEX_SITE_URL
const own = (audience: string) => ({
  type: 'customJwt' as const,
  issuer: site as string,
  jwks: `${site}/.well-known/jwks.json`,
  algorithm: 'ES256' as const,
  applicationID: audience,
})

export default {
  providers: [own(AUDIENCE.machine), own(AUDIENCE.browser)],
}
