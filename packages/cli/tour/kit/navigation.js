// A navigation attempt is saved before it is sent, so reloading the same showing cannot reuse it.
window.TourNavigation = (It, from) => {
  var attempt = 0
  // The page has no display id. Keep a random tie-breaker for this load, never one read from the shared store.
  var display = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('')
  var key = 'tour-navigation'
  function ready() {
    return !It.store || It.revision > 0
  }
  function next() {
    var saved = It.store && It.store.get(key)
    if (saved && saved.version === It.version && Number.isSafeInteger(saved.attempt)) attempt = Math.max(attempt, saved.attempt)
    return ++attempt
  }
  function send(name, data, current) {
    var payload = Object.assign({}, data, { from: from, from_version: It.version, attempt: current, attempt_display: display })
    if (!It.store) return It.action(name, payload)
    return It.store.set(key, { version: It.version, attempt: current, attempt_display: display }).then(() => It.action(name, payload))
  }
  // Saving the counter also sends state. It is not the agent opening the page again.
  function onState(fn) {
    var revision = It.revision
    var stored = JSON.stringify((It.state || {})._page)
    var state = agentState()
    function agentState() {
      return JSON.stringify(It.state || {}, (key, value) => (key === '_page' ? undefined : value))
    }
    return It.onState(() => {
      var nextStored = JSON.stringify((It.state || {})._page)
      var nextState = agentState()
      var answered = nextState !== state || (It.revision !== revision && nextStored === stored)
      revision = It.revision
      stored = nextStored
      state = nextState
      fn(answered)
    })
  }
  return { ready: ready, next: next, send: send, onState: onState }
}
