/*navigation.js*/
/*world.js*/
// What every thing the tour shows does the same way: it keeps the agent's hand, says under the
// words what each of the two did, and has the two buttons that go on. A page tells the agent
// what was done with It.action and hears back through the page's state.
//
// The hand says that the agent is at work in two cases only. It took something the person did
// and the page has not heard the agent answer it: the hand says so, with how long it has been.
// Or the agent wrote in the page's state, under `doing`, what it is doing: the hand says those
// words. Nothing else makes it look busy.
window.Tour = (() => {
  var World = window.World
  var It = World.It,
    P = World.P,
    agent = World.agent,
    hand = World.hand
  var $ = (id) => document.getElementById(id)

  var pending = 0 // when It took what the person did last, while the page has not heard the agent answer it
  var leaving = false // whether what is unanswered is one of the two ways on, which another page answers
  var words = '' // what the agent did last, in a few words
  var doingWas = '',
    doingAt = 0
  var doing = () => {
    var said = (It.state || {}).doing
    return typeof said === 'string' ? said.trim().slice(0, 80) : ''
  }
  // What stands on the hand: the agent's own word for what it is doing, or that it has not answered, or what it did last
  function show() {
    var now = doing()
    if (now !== doingWas) {
      doingWas = now
      doingAt = Date.now()
    }
    if (pending) hand.clock(() => doing() || 'has not answered yet', pending, 'live', leaving)
    else if (now) hand.clock(doing, doingAt)
    else hand.say(words)
  }
  /**
   * The page has heard the agent answer. `said` is what it did, in a few words. Where something
   * was unanswered until now, the field is thrown outward from the hand as the answer lands.
   */
  function answered(said) {
    var landed = pending > 0
    // Whatever was asked up to now is answered, also where It has yet to say that it took it
    heard = asks
    quiet(said)
    if (landed) World.shock(hand.where().x, hand.where().y, true)
  }
  /**
   * Nothing is awaited any longer, with no answer having come: a page that asks more than it
   * needs answered says so after a while, and so does a way on that was given back. Where no
   * words are given the hand keeps the ones it had.
   */
  function quiet(said) {
    pending = 0
    leaving = false
    if (said !== undefined) words = said
    show()
  }
  // One of the two lines under the words: what you did, or what the agent did. Nothing takes the line away.
  function say(who, text) {
    var el = $(who === 'you' ? 't-you' : 't-did')
    if (!el) return
    if (who !== 'you') el.querySelector('span').textContent = agent
    if (!text) {
      el.classList.remove('in')
      return
    }
    if (el.querySelector('b').textContent === text && el.classList.contains('in')) return
    el.querySelector('b').textContent = text
    el.classList.remove('in')
    void el.offsetWidth
    el.classList.add('in')
  }
  // Where the person pressed last, with a pointer or with a key: what they did leaves for the hand from there
  var last = null
  addEventListener('pointerdown', (e) => { last = { x: e.clientX, y: e.clientY } }, true)
  addEventListener(
    'click',
    (e) => {
      if (e.detail !== 0 || !e.target || !e.target.getBoundingClientRect) return
      var r = e.target.getBoundingClientRect()
      last = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    true,
  )
  var from = () => last || { x: innerWidth / 2, y: innerHeight / 2 }
  // It took what was done: a pulse goes from where it was done to the hand, and the hand says that the agent has not answered yet
  function taken() {
    pending = Date.now()
    show()
    World.sound.sent()
    World.pulse(from()).then(() => {
      if (pending) hand.tap()
    })
  }
  // How many things the agent was told of, and how many of them the page has heard an answer after
  var asks = 0,
    heard = 0
  /**
   * Tells the agent something was done. The hand hears of it when It has taken it, and not
   * before. Where the agent's answer came first, as it can when It is slow to say that it took
   * what was done, the hand is left saying what the agent did.
   */
  function act(name, data) {
    var mine = ++asks
    return It.action(name, data || {}).then(
      (result) => {
        if (heard < mine) taken()
        return result
      },
      () => {
        quiet('did not get that')
        throw new Error('not sent')
      },
    )
  }
  // How long an agent has to show what was asked for before the buttons that asked are the
  // person's again. The site gives an agent as long to bring the tour up.
  var SLOW = 40000
  // The two buttons that go on. Each is an ordinary action: the agent is what moves the tour on,
  // and the page it shows takes this one away. That It took a press is not the agent having
  // moved on: where this page is still here a while after, the buttons are given back with a
  // word of why, and the person may press again or go the other way.
  function rail() {
    var more = $('t-more'),
      next = $('t-next')
    if (!more || !next) return
    var navigation = window.TourNavigation(It, P.tour_id || null)
    var attempt = 0
    var asked = false
    function lock() {
      more.disabled = next.disabled = asked || !navigation.ready()
    }
    navigation.onState(lock)
    lock()
    var go = (btn, name) => {
      btn.addEventListener('click', () => {
        if (!navigation.ready() || asked) return
        var current = (attempt = navigation.next())
        asked = true
        var back = () => {
          if (attempt !== current) return
          asked = false
          btn.removeAttribute('data-picked')
          lock()
        }
        lock()
        btn.setAttribute('data-picked', '1')
        navigation.send(name, {}, current).then(() => {
          if (attempt !== current) return
          leaving = true
          taken()
          setTimeout(() => {
            if (attempt !== current) return
            back()
            quiet('has not answered')
          }, SLOW)
        }, back)
      })
    }
    go(more, 'menu')
    go(next, 'next')
  }
  // Where the hand rests on a thing: over its top left corner, with its plate clear of what is on it
  var rests = null
  function home(el, ms) {
    rests = el || rests
    if (!rests) return Promise.resolve()
    var r = rests.getBoundingClientRect()
    return hand.move(Math.max(8, r.left + 6), Math.max(8, r.top - 50), ms)
  }
  /** Whether the page's state has arrived. What it holds then was there before anyone did anything on this showing. */
  var arrived = () => It.revision > 0 || Object.keys(It.state || {}).length > 0
  function ready(fn) {
    World.ready(() => {
      // The agent's own word for what it is doing is heard here, on every page
      It.onState(show)
      rail()
      fn()
      show()
    })
  }
  return { It: It, P: P, agent: agent, hand: hand, answered: answered, quiet: quiet, say: say, act: act, home: home, arrived: arrived, ready: ready }
})()
