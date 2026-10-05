// A base port for a test that starts It, held for as long as the test has it.
//
// The service counts its ports from a base: the site, the pages, and the backend program's two,
// forty and forty-one above. A test that only looked for a free base and then started the
// service could meet another run of the tests that looked in the same moment. So a base is
// held: the test listens on the last port of the base's block, which nothing of It uses, until
// it gives the base back. One program on a machine can listen there, the system frees the port
// when that program ends however it ends, and every test that takes a base takes it this way.
import net from 'node:net'

/** How far one base is from the next. */
export const BLOCK = 50
/** The port of a block, counted from its base, that says the block is held. */
const HELD = BLOCK - 1
/** How many ports from a base on the service may listen on: the last is the backend program's second. */
const COUNTED = 42

/** Something that has a port and says nothing on it. Null when the port is not free. */
const listening = (port: number, address: string) =>
  new Promise<net.Server | null>((resolve) => {
    const server = net.createServer((socket) => socket.destroy())
    server.once('error', () => resolve(null)).listen(port, address, () => resolve(server))
  })
const closed = (server: net.Server) => new Promise<void>((resolve) => void server.close(() => resolve()))
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Whether this machine has the second family of address at all. One that has not is looked at in the first alone. */
let second: Promise<boolean> | undefined
const both = () =>
  (second ??= listening(0, '::1').then(async (server) => {
    if (server) await closed(server)
    return Boolean(server)
  }))

/** A base that is held, and the giving of it back. */
export interface Held {
  base: number
  release(): Promise<void>
}

/**
 * Holds a base among `blocks` of them that begin at `first`, fifty apart, with every port the
 * service counts from it free in both families of address. The first block looked at is any one
 * of them, so that runs at the same time seldom ask for the same one. Where every block is
 * held or in use, they are gone round again a little later, `rounds` times in all.
 */
export async function holdBase(first: number, blocks: number, rounds = 40): Promise<Held> {
  let block = Math.floor(Math.random() * blocks)
  for (let tried = 0; tried < blocks * rounds; tried++) {
    if (tried > 0 && tried % blocks === 0) await pause(250)
    block = (block + 1) % blocks
    const base = first + block * BLOCK
    const held = await listening(base + HELD, '127.0.0.1')
    if (!held) continue
    // What holds a base never keeps the program that holds it from ending
    held.unref()
    const families = (await both()) ? ['127.0.0.1', '::1'] : ['127.0.0.1']
    const looked = await Promise.all(Array.from({ length: COUNTED }, (_, n) => families.map((address) => listening(base + n, address))).flat())
    await Promise.all(looked.map((server) => server && closed(server)))
    if (looked.every(Boolean)) return { base, release: () => closed(held) }
    await closed(held)
  }
  throw new Error(`none of the ${blocks} base ports from ${first} is free`)
}

/** The bases one file of tests takes from its own blocks, given back together when a test is over. */
export function bases(first: number, blocks: number) {
  const held: Held[] = []
  return {
    /** The next base, held until `release`. */
    async next(): Promise<number> {
      const one = await holdBase(first, blocks)
      held.push(one)
      return one.base
    },
    /** Gives back every base taken since the last time. */
    async release(): Promise<void> {
      await Promise.all(held.splice(0).map((one) => one.release()))
    },
  }
}
