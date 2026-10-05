// The connection to the backend, as the site makes it, and what is written to the browser's
// console when something asked of the backend failed.
//
// A refusal the backend gave, with its code, is an answer, and whoever asked sees to it: the
// person is told on the page, or the site does what the refusal calls for. The commonest is
// being refused as nobody, which is what every call of a tab meets once its session is over or
// the browser has been paired again, and which the site answers by asking what the browser is
// now. None of that is an error of the site's, and none of it is written as one. A failure that
// carries no code is trouble on the backend's side, and is written as an error.
import { ConvexReactClient, type ConvexReactClientOptions } from 'convex/react'
import { refusal } from './lib'

/** Whether something that failed is trouble, and not a refusal the backend gave with its code. */
const trouble = (err: unknown): boolean => refusal(err).code === 'error'

/** What the client writes of a call that failed, which names the function and the request and never says why. */
const A_CALL_FAILED = /^\[CONVEX [MA]\(/

type Logger = Exclude<NonNullable<ConvexReactClientOptions['logger']>, boolean>
/**
 * What the client writes to the console, as it writes it, but for one thing: of a call that
 * failed it writes an error whatever the failure was, before whoever called has seen it. That
 * is left to `failed`, which knows a refusal from trouble.
 */
const logger: Logger = {
  logVerbose: () => {},
  log: (...said) => console.log(...said),
  warn: (...said) => console.warn(...said),
  error: (...said) => {
    if (typeof said[0] === 'string' && A_CALL_FAILED.test(said[0])) return
    console.error(...said)
  },
}

/** A call failed: trouble is written as an error, by the first line the client has for it, and a refusal is not written. Whoever called is given the failure either way. */
function failed(err: unknown): never {
  if (trouble(err)) console.error(String((err as { message?: unknown } | null)?.message ?? err).split('\n')[0])
  throw err
}

/** How a connection calls a function. */
type Calls = Pick<ConvexReactClient, 'mutation' | 'action'>
/** Each connection's calls as they are before a failure is written: what `askTwice` asks with, which writes only the failure it could not get past. */
const unwritten = new WeakMap<ConvexReactClient, Calls>()

/** The connection to the backend at an address. */
export function connect(address: string, options: ConvexReactClientOptions = {}): ConvexReactClient {
  const client = new ConvexReactClient(address, { ...options, logger })
  const { mutation, action } = client
  unwritten.set(client, { mutation: mutation.bind(client), action: action.bind(client) })
  client.mutation = ((...asked: Parameters<typeof mutation>) => mutation.apply(client, asked).catch(failed)) as typeof mutation
  client.action = ((...asked: Parameters<typeof action>) => action.apply(client, asked).catch(failed)) as typeof action
  return client
}

/** How long the site waits before it asks again for what met trouble: a second or two, and not the same for two tabs that met it together. */
const AGAIN_MS = 1000

/**
 * Asks the backend for something that is harmless to ask for twice, and asks once more by itself
 * where the first asking met trouble. Much of what a browser asks is counted against the one
 * person all its tabs are, and tabs that ask in the same instant can be in each other's way for
 * that instant and not after it. Trouble that the second asking got past is recovered from, and
 * is written nowhere. Trouble that is still there is written as an error, once, and given to
 * whoever asked. A refusal is an answer, and is given at once. Whoever asked can say, with
 * `wanted`, that the answer is wanted no more by the time of the second asking: then nothing
 * more is asked or written, and the first trouble is all that is given.
 */
export async function askTwice<T>(client: ConvexReactClient, ask: (calls: Calls) => Promise<T>, wanted: () => boolean = () => true): Promise<T> {
  const calls = unwritten.get(client) ?? client
  try {
    return await ask(calls)
  } catch (err) {
    if (!trouble(err)) throw err
    await new Promise((r) => setTimeout(r, AGAIN_MS + Math.random() * AGAIN_MS))
    if (!wanted()) throw err
    return ask(calls).catch(failed)
  }
}

/**
 * Something a view threw was caught, and the site shows what it is in the view's place. A
 * refusal of the backend's is shown as what it says, or, where it is a refusal as nobody,
 * answered by asking what the browser is now: it is not written. Anything else is written as
 * an error.
 */
export function caught(error: unknown): void {
  if (trouble(error)) console.error(error)
}
