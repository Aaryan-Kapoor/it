// Web push: how a notification reaches this display when the site is not open. It is part of
// the notification system, not a second channel: the same notification, delivered by the
// device instead of the page.
import type { ConvexReactClient } from 'convex/react'
import { askTwice } from './backend'
import { api, displayKey, keptFor, note, refusal, whenLetGo } from './lib'

export type PushSupport = 'ready' | 'granted' | 'denied' | 'needs-install' | 'unsupported'

/**
 * Whether this browser reached the site at an address it does not count as secure: over plain
 * http, by anything but the name of the machine the browser is itself on. That is how a screen
 * on the home network reaches It. A browser switches a good deal off there, and of what the site
 * uses, one thing: a notification once the site is closed, which needs a service worker. The
 * site says so where notifications are read, and offers nothing that could not work.
 */
export const notSecure = (): boolean => window.isSecureContext === false

/** What is said on a screen that cannot be notified once the site is closed, and why. */
export const NOT_SECURE =
  'On this screen, notifications show while the site is open. A browser allows one after the site is closed only at a secure address, and this screen reached It over plain http.'

export function pushSupport(): PushSupport {
  // Nothing is offered where it cannot work, and adding the site to a Home Screen would not make it work
  if (notSecure()) return 'unsupported'
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return Notification.permission === 'granted' ? 'granted' : 'ready'
}

const bytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const b64u = (buf: ArrayBuffer | null) =>
  btoa(String.fromCharCode(...new Uint8Array(buf ?? new ArrayBuffer(0))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

// Turning notifications on takes a few steps, each of which waits on the person, the browser
// or the network. If the person signs out while they are under way, or everything is erased,
// the steps that remain must not put the site's script or a subscription back. Each "off" moves
// this on, and an "on" that finds it moved since it started undoes what it made itself.
let generation = 0

// Each attempt to turn notifications on has a number. One that has been overtaken stops where
// it is, at whichever step it finds so. Overtaken by a later attempt, it touches nothing: what
// is in the browser by then belongs to that one. Overtaken by a sign-out or an erasing, it
// takes away again what it made itself, the script it registered and the subscription it made,
// and nothing that was there before it or that anything later put there.
let attempt = 0
/** Asks for permission, subscribes this browser, and gives the subscription to this display. Returns 'on' or a short reason. */
export async function turnOnPush(convex: ConvexReactClient): Promise<string> {
  const started = generation
  const mine = ++attempt
  // Whose the browser is when this begins. Kept for nobody, or for somebody else by a later
  // step, it is not theirs to be notified in: everything of theirs was erased, or it was paired anew
  const person = keptFor()
  const overtaken = () => generation !== started || attempt !== mine || keptFor() !== person
  const support = pushSupport()
  if (notSecure()) return 'Needs a secure address'
  if (support === 'needs-install') return 'Add It to your Home Screen first'
  if (support === 'unsupported') return 'Not available in this browser'
  if (support === 'denied') return 'Blocked in this browser’s settings'
  if (person === null) return 'Signed out'
  /** What this attempt itself put in the browser: the script, where none was registered before it, and its subscription. */
  const made: { script?: ServiceWorkerRegistration; subscription?: PushSubscription } = {}
  /** Stops an attempt that was overtaken, taking away again what it made unless a later attempt has begun. */
  const stopped = async (): Promise<string> => {
    if (attempt === mine) {
      await made.subscription?.unsubscribe().catch(() => {})
      await made.script?.unregister().catch(() => {})
    }
    return 'Signed out'
  }
  try {
    // Asked after every wait, before the next thing is done: a wait may last as long as the person takes to answer the browser
    if ((await Notification.requestPermission()) !== 'granted') return 'Not allowed'
    if (overtaken()) return stopped()
    const before = await navigator.serviceWorker.getRegistration()
    if (overtaken()) return stopped()
    const registration = await navigator.serviceWorker.register('/sw.js')
    if (!before) made.script = registration
    if (overtaken()) return stopped()
    await navigator.serviceWorker.ready
    if (overtaken()) return stopped()
    const key = await askTwice(
      convex,
      (calls) => calls.action(api.push.publicKey, {}),
      () => !overtaken(),
    )
    if (overtaken()) return stopped()
    // A subscription left by whoever used this browser before is dropped, so that this one
    // belongs to this person's display and nobody else's
    const left = await registration.pushManager.getSubscription()
    // Asked again before anything is taken away: what is there by now may be a later attempt's
    if (overtaken()) return stopped()
    await left?.unsubscribe().catch(() => {})
    if (overtaken()) return stopped()
    made.subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) })
    if (overtaken()) return stopped()
    const sub = made.subscription
    await convex.mutation(api.push.subscribe, { key: displayKey(), endpoint: sub.endpoint, p256dh: b64u(sub.getKey('p256dh')), auth: b64u(sub.getKey('auth')) })
    if (overtaken()) return stopped()
    return 'on'
  } catch (err) {
    // Refused or failed after it was overtaken, as the backend refuses a browser whose session is over: what it made goes all the same
    if (overtaken()) return stopped()
    note('notifications could not be turned on', refusal(err).code ?? (err as Error)?.name)
    return 'Could not turn on notifications'
  }
}

/**
 * Takes this browser's subscription away and tells the backend. Each step waits on the browser
 * or the network, and `still` is asked before the next: once the browser is paired for someone
 * else or under another session, or notifications are being turned on again, what is in the
 * browser is not this pairing's, and the rest is left undone.
 */
export async function turnOffPush(convex: ConvexReactClient, still: () => boolean = () => true): Promise<void> {
  const mine = ++generation
  const turnedOnSince = attempt
  const overtaken = () => generation !== mine || attempt !== turnedOnSince || !still()
  const registration = await navigator.serviceWorker?.getRegistration()
  if (overtaken()) return
  const sub = await registration?.pushManager.getSubscription()
  if (overtaken()) return
  await sub?.unsubscribe().catch(() => {})
  if (overtaken()) return
  await convex.mutation(api.push.unsubscribe, { key: displayKey() })
}

/** Drops this browser's own push subscription, if it has one. Nothing is asked of the backend. */
export async function dropPushHere(): Promise<void> {
  const mine = ++generation
  const turnedOnSince = attempt
  // A browser that has been paired again since, and has begun to turn notifications on, has or
  // is about to have a subscription of its new session's here, and it is not this one's to take
  // away. One that has been paired again and left notifications off has none: what is here is
  // still the last session's, and it goes
  const overtaken = () => generation !== mine || attempt !== turnedOnSince
  // The next time this browser is paired it is offered notifications again: the last answer was
  // about a subscription that is now gone
  localStorage.removeItem('it.pushAsked')
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (overtaken()) return
    const sub = await registration?.pushManager.getSubscription()
    if (overtaken()) return
    await sub?.unsubscribe()
  } catch {}
}

/**
 * Everything It held for the person this browser was paired for has been erased. Besides the
 * subscription, the notifications of It that are still showing go, since each says what an
 * agent wrote, and so does the site's script that shows them: the browser keeps it registered
 * for this address until it is told otherwise. Nothing is asked of the backend. A browser
 * that has been paired again since, and has begun to turn notifications on, keeps what is
 * there by then: it is that pairing's.
 */
export async function forgetPushHere(): Promise<void> {
  // Whatever was turning notifications on for that person undoes itself
  generation++
  const turnedOnSince = attempt
  const overtaken = () => attempt !== turnedOnSince
  try {
    for (const registration of (await navigator.serviceWorker?.getRegistrations()) ?? []) {
      // Each step is taken whatever became of the one before it: a browser that will not say
      // what it is showing, or what it is subscribed to, still has the script taken away. And
      // each is taken only once it is known that no new pairing has begun to turn notifications
      // on while the step before it was waited for: what is found by then would be that pairing's
      if (overtaken()) return
      const showing = (await registration.getNotifications?.().catch(() => [])) ?? []
      if (overtaken()) return
      for (const shown of showing) shown.close()
      const subscription = await registration.pushManager?.getSubscription().catch(() => null)
      if (overtaken()) return
      await subscription?.unsubscribe().catch(() => {})
      if (overtaken()) return
      await registration.unregister().catch(() => {})
    }
  } catch {}
}
// A person's things are let go of in this tab, or in another tab of the browser, which says so
// to this one. The script and what it shows go with them while everything here was theirs:
// once the browser has been paired for somebody else, the script is that person's
whenLetGo((person, whole) => {
  if (person !== null && whole) void forgetPushHere()
})

/**
 * The backend believes this display is subscribed. If the browser is not any more, it subscribes
 * again without asking, where the person's permission still stands; where it does not, the
 * backend is told, so that the display stops being shown as one that gets notifications and
 * the offer to turn them on comes back.
 */
export async function mendPush(convex: ConvexReactClient): Promise<void> {
  try {
    if (pushSupport() === 'unsupported' || pushSupport() === 'needs-install') return
    const registration = await navigator.serviceWorker?.getRegistration()
    if (await registration?.pushManager.getSubscription()) return
    const started = generation
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const mine = attempt + 1
      if ((await turnOnPush(convex)) === 'on') return
      // Overtaken by the person turning notifications on or off themselves, or by signing out:
      // what is there now is theirs, and nothing is cleaned up
      if (generation !== started || attempt !== mine) return
    }
    await convex.mutation(api.push.unsubscribe, { key: displayKey() })
    localStorage.removeItem('it.pushAsked')
  } catch {}
}
