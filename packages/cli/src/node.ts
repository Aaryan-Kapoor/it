// What this program needs of Node when it is run as a script under it. The standalone program
// carries its own runtime and needs none of this.
import { Problem } from './lib'

/** The oldest Node this program runs under: the first that has a database of its own with no flag to be given. */
export const NODE_NEEDED = [22, 13] as const
/** Among the releases of Node 23, the first that has it so. The ones before it are newer than 22.13 and still need the flag. */
const NODE_23_NEEDED = [23, 4] as const

/**
 * Why this program cannot run under a version of Node, as one sentence, or nothing when it
 * can. Under an older one it would start, and fail somewhere inside the first time it opened
 * its database, with nothing said of why.
 */
export function nodeTooOld(version: string): Problem | undefined {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const hint = 'Run it under a newer Node, or install the standalone `it` program, which needs no Node at all.'
  if (major === NODE_23_NEEDED[0])
    return minor >= NODE_23_NEEDED[1]
      ? undefined
      : new Problem(`It needs Node ${NODE_23_NEEDED.join('.')} or later among the releases of Node 23, and this is Node ${version}.`, 'unsupported', hint)
  if (major > NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor >= NODE_NEEDED[1])) return undefined
  return new Problem(`It needs Node ${NODE_NEEDED.join('.')} or later, and this is Node ${version}.`, 'unsupported', hint)
}

/**
 * Node 22 says, each time its database module is first used, that the module is experimental.
 * That is Node's word about itself and nothing the person can act on, and it would be printed
 * into every terminal the service is started in. That one notice is kept off, and every other
 * warning is passed on as it was.
 */
export function quietAboutItsDatabase(): void {
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type
    if (type === 'ExperimentalWarning' && typeof warning === 'string' && warning.startsWith('SQLite ')) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
}
