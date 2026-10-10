// What happens between a screen and the backend, noted for the counts of how It is used: a
// display is paired, a display opens the site, a page is shown, a click is sent, a notification
// is answered. The program that sends the counts is the service, which is not there when these
// happen, so each is noted here as a name and a few properties, every one of which is one of a
// fixed set of words. The service takes the notes away a few times a minute (`counted:take`).
//
// Nothing is noted while counts are not being sent, which the service says in the one row it
// keeps of how it stands, and nothing of a page, a display's name or a person is ever in a note.
import type { MutationCtx } from '../_generated/server'

export type Screen = 'phone' | 'tablet' | 'computer' | 'tv'

/** What kind of screen a browser is on, as far as the name it gives itself says. */
export function screenOf(userAgent: string): Screen {
  const ua = userAgent.slice(0, 400)
  if (/smart-?tv|\btv\b|tizen|web0s|webos|appletv|crkey|roku|aft[a-z]{1,3}\b|bravia|hbbtv|googletv|android tv/i.test(ua)) return 'tv'
  if (/ipad|tablet|kindle|silk\/|playbook/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet'
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'phone'
  return 'computer'
}

/** Notes one thing that happened, where counts are being sent. Whatever goes wrong here, what was being done is done all the same. */
export async function counted(ctx: MutationCtx, name: string, properties: Record<string, string | boolean>): Promise<void> {
  try {
    if ((await ctx.db.query('network').first())?.usage !== true) return
    await ctx.db.insert('counted', { name, properties: JSON.stringify(properties), at: Date.now() })
  } catch {}
}
