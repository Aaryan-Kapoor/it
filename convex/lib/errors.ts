import { ConvexError } from 'convex/values'

/** Every refusal the backend gives carries one of these, so a caller can tell them apart. */
export type Code = 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid' | 'limit' | 'rate_limited' | 'conflict' | 'unavailable'

export function fail(code: Code, message: string, extra: Record<string, string | number | boolean> = {}): never {
  throw new ConvexError({ code, message, ...extra })
}
