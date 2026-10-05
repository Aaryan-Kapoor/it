// A script a page might try to leave behind in the browser, to go on running after the page
// has gone. Valid as one, so that a refusal to install it is the service's doing and not a
// fault of this file.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
