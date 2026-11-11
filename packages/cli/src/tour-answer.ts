// What an agent that gives the tour answers the tour's first page with, in one command, and the
// picture an action of that page carried, which It writes to a file for the agent before the
// agent hears of the action.
//
// An agent on a slow model pays for every command it runs and for everything it has to work
// out. So `it tour answer` takes the action's id and the answer alone: which part of the page
// the action came from and which request it waits on are read from the action itself, the
// answer is set under that part in the page's state, the action is acknowledged, the picture
// It saved for it is taken away, and, where what the person does next does not arrive in the
// conversation by itself, the command waits for it and prints it. `it tour next` is that wait
// alone.
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseJson, TOUR } from '@it/protocol'
import { saveAttached } from './files'
import { api, call, Problem } from './lib'

/** The page these answer: the tour's first. */
export const START_SLUG = `${TOUR.prefix}${TOUR.start}`
/** The id a part of the page gives each thing it asks, as the page makes it. */
const REQUEST = /^[0-9a-f]{32}$/
/** The name of a part of the page. */
const PART = /^[a-z][a-z0-9]*$/
/** The name of the file a picture is kept in: the tour's own, with the request it belongs to. Nothing else is ever written or removed by this. */
const PICTURE = /^\.it-tour-[0-9a-f]{32}\.png$/
export const pictureName = (request: string): string => `.it-tour-${request}.png`

/** An action as far as this needs it: which page it is from, what it carried as JSON text, and the files beside that. */
export interface Carried {
  id: string
  artifact: string
  payload: string
  files?: readonly { name: string; type: string; bytes: number }[]
}

/** The part of the first page an action came from and the request it waits on, as the action itself says. Nothing of either where it does not say. */
export function askedBy(c: Pick<Carried, 'artifact' | 'payload'>): { part?: string; request?: string } {
  if (c.artifact !== START_SLUG) return {}
  const data = parseJson(c.payload)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const { part, request } = data as { part?: unknown; request?: unknown }
  return {
    ...(typeof part === 'string' && PART.test(part) ? { part } : {}),
    ...(typeof request === 'string' && REQUEST.test(request) ? { request } : {}),
  }
}

/** The most a picture kept for the agent may be. A sheet of the whiteboard is a few tens of kilobytes. */
const MOST_BYTES = 8 * 1024 * 1024

/**
 * Writes the picture an action of the tour's first page carried into `folder`, under the name
 * its request gives it, and says where it is. Nothing where the action is not one of that page's
 * with a request and a picture beside it. A file of that name that is there already is the
 * picture, written by whichever of the connector and the agent's own command came first.
 */
export async function keepPicture(c: Carried, folder: string): Promise<string | undefined> {
  const { request } = askedBy(c)
  const first = c.files?.[0]
  if (!request || !first || first.type !== 'image/png' || first.bytes > MOST_BYTES) return undefined
  const at = path.join(folder, pictureName(request))
  if (lstatSync(at, { throwIfNoEntry: false })?.isFile()) return at
  try {
    await saveAttached(c.id, 1, at)
  } catch (err) {
    // Written meanwhile by the other of the two that write it
    if (lstatSync(at, { throwIfNoEntry: false })?.isFile()) return at
    throw err
  }
  return at
}

/** Takes away the picture kept for a request, from each folder it may have been written to. */
export function dropPicture(request: string | undefined, folders: readonly (string | undefined)[]): void {
  if (!request || !REQUEST.test(request)) return
  for (const folder of new Set(folders)) if (folder) rmSync(path.join(folder, pictureName(request)), { force: true })
}

/** Takes away every picture the tour kept in these folders, as when the tour is cleared. Only files named as the tour names its pictures. */
export function dropPictures(folders: readonly (string | undefined)[]): void {
  for (const folder of new Set(folders)) {
    if (!folder) continue
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of names)
      if (PICTURE.test(name) && lstatSync(path.join(folder, name), { throwIfNoEntry: false })?.isFile()) rmSync(path.join(folder, name), { force: true })
  }
}

/** The pictures the connector has begun to keep, by the action each is of, so that each is asked for once. */
const begun = new Set<string>()
/**
 * The connector's part: as it hears of an action waiting for a conversation on this machine, it
 * has the action's picture written into the folder that conversation works in, so that the file
 * is there by the time the agent is told of the action. It waits for nothing and holds nothing
 * up. Where it cannot be written, the agent's own command writes it, or the agent saves it.
 */
export function keepPictureFor(
  c: Carried & { session: { harness: string; id: string } | null },
  folderOf: (session: { harness: string; id: string }) => string | undefined,
): void {
  if (c.artifact !== START_SLUG || !c.files?.length || !c.session || begun.has(c.id)) return
  begun.add(c.id)
  if (begun.size > 200) begun.delete(begun.values().next().value!)
  const folder = folderOf(c.session)
  if (!folder) return
  void keepPicture(c, folder).catch(() => {})
}

/**
 * Answers an action of the tour's first page: sets `answer` under the part the action came from,
 * with the request the action waits on, and acknowledges the action. With no answer, as for an
 * action that waits for none, it is acknowledged alone.
 */
export async function answerAction(id: string, answer: Record<string, unknown> | undefined): Promise<{ part?: string; request?: string; revision?: number }> {
  const c = await call<Carried>('query', api.delivery.get, { id })
  if (c.artifact !== START_SLUG)
    throw new Problem(
      `That action is from the page ${c.artifact}, and \`it tour answer\` answers the tour’s first page, ${START_SLUG}.`,
      'invalid',
      `Answer it as that page’s section of the tour says, or with \`it patch ${c.artifact} '<json>'\`.`,
    )
  const { part, request } = askedBy(c)
  let revision: number | undefined
  if (answer !== undefined) {
    if (!part)
      throw new Problem(
        'That action does not say which part of the page it is from, so there is nowhere to put an answer to it.',
        'invalid',
        'It needs no answer. Run `it tour answer` with its id alone to acknowledge it.',
      )
    // The request is the action's own, whatever the answer says of one: the page draws only the answer to the request it waits on
    const patch = { [part]: { ...answer, ...(request ? { request } : {}) } }
    revision = (await call<{ revision?: number }>('mutation', api.state.patch, { slug: START_SLUG, patch: JSON.stringify(patch) }))?.revision
  }
  // Acknowledged as `it ack` does it. The answer is on the page by now, and stands whatever becomes of this
  await call('mutation', api.delivery.handedOff, { id, route: 'manual' })
    .then(() => call('mutation', api.delivery.settle, { id, outcome: 'succeeded' }))
    .catch(() => {})
  return { ...(part ? { part } : {}), ...(request ? { request } : {}), ...(revision === undefined ? {} : { revision }) }
}
