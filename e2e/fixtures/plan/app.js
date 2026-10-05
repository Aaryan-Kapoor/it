window.scriptLoaded = true
// Everything the site says to this window is kept, as text, for whoever looks at what a page is told
window.heardFromTheSite = []
window.addEventListener('message', (e) => window.heardFromTheSite.push(JSON.stringify(e.data)))
It.onState((s) => {
  document.title = 'state ' + JSON.stringify(s.status ?? null)
})
