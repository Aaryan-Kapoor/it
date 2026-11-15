// A clock for the camera live to a page (media.ts), while the screen does not show the site. A
// browser then holds the site's own timers to about one a second, and leaves a worker's alone,
// whose ticks reach the site as messages. Told how many milliseconds apart to tick, it ticks so,
// until it is told something else or is ended.
let ticking
self.addEventListener('message', (m) => {
  clearInterval(ticking)
  const ms = Number(m.data)
  if (Number.isFinite(ms) && ms >= 4 && ms <= 1000) ticking = setInterval(() => postMessage(0), ms)
})
