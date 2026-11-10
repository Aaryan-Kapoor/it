// The notice that asks the person to type /reload-plugins in a Claude Code conversation that is
// open and has not loaded It's add-on, so that what they do on its pages reaches it. It is shown
// as soon as It knows of one that has pages, on the site and on those pages, whatever the agent
// said, and it goes once the add-on is heard from there.
import { ALIVE } from '@it/protocol'
import { useQuery } from 'convex/react'
import { api, useNow } from './lib'
import { type NotLoaded, reloadWords, standing } from './listening'

export function ReloadNotice({ slug }: { slug?: string }) {
  const conversations = useQuery(api.artifacts.notLoaded, {}) as NotLoaded[] | undefined
  // By It's clock, so that a machine that has gone quiet is let go of here too
  const now = useNow(15_000)
  const words = reloadWords(standing(conversations ?? [], now, ALIVE.onlineMs), slug)
  if (!words) return null
  return (
    <p className="notice reload" role="status" data-reload="">
      <span>{words}</span>
    </p>
  )
}
