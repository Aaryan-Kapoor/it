// The site's service worker has one job: showing a notification that arrives while the site is
// not open, and opening the page it points at when it is tapped. It caches nothing and never
// touches a page's content, which is served from another address.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let data = {}
  try {
    data = e.data ? e.data.json() : {}
  } catch {}
  const url = typeof data.url === 'string' ? data.url : '/'
  e.waitUntil(
    self.registration.showNotification(typeof data.title === 'string' ? data.title : 'It', {
      body: typeof data.body === 'string' ? data.body : '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
      // One per notification, so a second one never silently replaces the first
      tag: typeof data.id === 'string' ? data.id : undefined,
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  // Only ever an address on this site
  let target = '/'
  try {
    const u = new URL(e.notification.data?.url, self.location.origin)
    // The whole address as the browser read it, so that nothing in it can be read a second time as another site
    if (u.origin === self.location.origin) target = u.href
  } catch {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (all) => {
      // A window that is already open is taken to the page; if that cannot be done, a new one is opened
      for (const c of all) {
        try {
          const moved = await c.navigate(target)
          // Waited for here, so that a window that closed in the meantime is passed over too
          return await (moved || c).focus()
        } catch {}
      }
      return self.clients.openWindow(target)
    }),
  )
})
