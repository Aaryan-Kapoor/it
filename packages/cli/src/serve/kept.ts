// Keeping It's folder to the person, on Windows, while the service runs. Each record It writes is
// kept to the person as it is written. This sees to the rest: what was written before It did
// that, what other programs write in It's folder (the backend's database, the logs, the program
// itself), and permissions that another program has given away since, as Codex's sandbox gives
// its own accounts each folder of the person's profile, and lasting write to each folder a
// sandboxed conversation was let write in.
import { INSTALLATION_FILE } from '../installation'
import { home } from '../lib'
import { type Kept, keepFolderToOwner } from '../owner'
import { installationFile, ROOT_FILES, ROOT_FOLDERS, ROOT_LOCKS } from '../uninstall-files'

/** How often It's folder is looked at again, while the service runs. */
export const KEEP_MS = 15 * 60_000
/** The records that would let whoever read them act as this machine, or as the backend. */
const KEYS = ['machine.json', 'machine.pending.json', 'token.json', 'service.json', 'connector.json', 'push.json']

/**
 * The entries of It's folder that are It's: the ones uninstall knows as It's, and nothing else,
 * since IT_HOME may name a folder that also holds a person's own files. The folder itself is
 * among them, as `.`, where it is It's alone: the usual one, or one It marked as its own.
 */
export function itsEntries(folder = home(), named = process.env.IT_HOME): string[] {
  const own = !named || installationFile(folder, INSTALLATION_FILE) !== undefined
  return [...(own ? ['.'] : []), INSTALLATION_FILE, ...ROOT_FILES, ...ROOT_LOCKS, ...ROOT_FOLDERS]
}

/** What the service says of what it changed: nothing of a file's contents, and no name but It's own. `said` is what was said already in this run. */
export function keptSaid(found: Kept, said: Set<string>): string[] {
  const lines: string[] = []
  const entries = found.opened.filter((name) => name !== '.')
  if (entries.some((name) => KEYS.includes(name)))
    lines.push(
      `It's folder was open to another account of this computer, and so were the keys it keeps: whoever read this machine's key can act as this machine until it is revoked on the site's Machines page. ${entries.length} of It's files and folders are kept to you again.`,
    )
  else if (entries.length)
    lines.push(`It's folder was open to another account of this computer. ${entries.length} of It's files and folders are kept to you again.`)
  // An account Codex's sandbox runs as is given the folder itself again each time a sandboxed command runs, which is no news after the first time
  if (found.opened.includes('.') && !said.has('.')) {
    said.add('.')
    lines.push(
      "It's folder itself was open to another account of this computer, and is kept to you again. Another program may open it again: what is in it stays kept to you.",
    )
  }
  const failed = found.failed.filter((name) => !said.has(`failed ${name}`))
  for (const name of failed) said.add(`failed ${name}`)
  if (failed.length) lines.push(`${failed.length} of It's files and folders could not be kept to you.`)
  return lines
}

/** Keeps It's folder to the person once, and says what that changed. */
export async function keepItsFolder(say: (line: string) => void, said: Set<string>): Promise<void> {
  const found = await keepFolderToOwner(home(), itsEntries())
  if (found) for (const line of keptSaid(found, said)) say(line)
}
