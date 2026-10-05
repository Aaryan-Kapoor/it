// The backend's settings. The service that runs the backend on this machine gives them to it
// as environment variables when it loads these functions.

/** The base port, given as IT_PORT: the door listens on it, and every other port is counted from it. */
export function basePort(): number {
  const port = Number(process.env.IT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('missing setting IT_PORT')
  return port
}
/** What the door shows with a request it passes on about a session, given as IT_DOOR_KEY. */
export function doorKey(): string {
  const key = process.env.IT_DOOR_KEY
  if (!key || key.length < 32) throw new Error('missing setting IT_DOOR_KEY')
  return key
}
/** The door, as the backend reaches it: the service's own address on this machine, where it takes the backend's messages and a machine's uploads. */
export const door = () => `http://127.0.0.1:${basePort()}`
/** The site, as the person at this machine opens it. */
export const site = () => `http://localhost:${basePort()}`
/** This backend's own address for HTTP, which is also the issuer of everything it signs. */
export const issuer = () => process.env.CONVEX_SITE_URL as string
