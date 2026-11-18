// Signing, for actions. Everything the backend signs is a short-lived ES256 token for one named
// audience, checked by its receiver against the public key at /.well-known/jwks.json.
//
// The backend makes its signing key the first time it needs one, and keeps it in the
// signingKeys table, which only internal functions can read.
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose'
import { internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import { issuer } from '../config'
import { overClashes } from './clash'

interface Key {
  kid: string
  privateJwk: JWK
  publicJwk: JWK
}

/** The key, made the first time it is needed, asked for until `until` where the one signing gives a time (see `askingUntil`). */
async function signingKey(ctx: ActionCtx, until?: number): Promise<Key> {
  const kept = await ctx.runQuery(internal.keys.current, {})
  if (kept) return kept
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  // Two requests may each find no key and make one: the first to be kept is the key, for both
  const made = { kid: `it-${Date.now().toString(36)}`, privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) }
  return overClashes(() => ctx.runMutation(internal.keys.keep, made), { until })
}

export async function mint(
  ctx: ActionCtx,
  audience: string,
  subject: string,
  claims: Record<string, unknown>,
  seconds: number,
  until?: number,
): Promise<string> {
  const key = await signingKey(ctx, until)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'JWT' })
    .setIssuer(issuer())
    .setAudience(audience)
    .setSubject(subject)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(await importJWK(key.privateJwk, 'ES256'))
}

/** The key a receiver should believe, as a key set: only what makes it public, never its private part. */
export async function publicKeys(ctx: ActionCtx, until?: number): Promise<{ keys: JWK[] }> {
  const { kid, publicJwk } = await signingKey(ctx, until)
  return { keys: [{ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, kid, alg: 'ES256', use: 'sig' }] }
}
