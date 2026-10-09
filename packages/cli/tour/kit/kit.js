// What every page of the tour does the same way: it finds the agent's name, keeps its plate,
// says under the card what each of the two did, and has the two buttons that go on. A page
// tells the agent what was done with It.action and hears back through the page's state.
window.Tour = (() => {
  var It = window.It || { state: {}, onState: () => () => {}, action: () => Promise.resolve() }
  var P = window.__PARAMS || {}
  var agent = String(P.agent || '') || 'Your agent'
  var $ = (id) => document.getElementById(id)

  // The plate: the agent's name, and after it a word of what it is doing. `busy` makes its light beat.
  function plate(doing, busy) {
    var el = $('t-plate')
    if (!el) return
    el.querySelector('b').textContent = agent
    el.querySelector('small').textContent = doing || ''
    el.setAttribute('data-busy', busy ? '1' : '0')
  }
  // One of the two lines under the card: what you did, or what the agent did. Nothing takes the line away.
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
  // Tells the agent something was done. The plate beats until the page hears back, or until
  // `quiet` milliseconds have passed with nothing heard, where a page gives that.
  function act(name, data) {
    plate('', true)
    return It.action(name, data || {}).catch(() => {
      plate('did not get that', false)
      throw new Error('not sent')
    })
  }
  // The two buttons that go on. Each is an ordinary action: the agent is what moves the tour on.
  function rail() {
    var more = $('t-more'),
      next = $('t-next')
    var go = (btn, name, waiting) => {
      if (!btn) return
      btn.addEventListener('click', () => {
        var was = btn.textContent
        more.disabled = next.disabled = true
        btn.textContent = waiting
        It.action(name, { from: P.tour_id || null }).catch(() => {
          more.disabled = next.disabled = false
          btn.textContent = was
        })
      })
    }
    go(more, 'menu', 'One moment…')
    go(next, 'next', 'Coming up…')
  }
  // Bits of coloured paper, thrown from a point and left to fall
  function confetti(x, y) {
    var c = document.createElement('canvas')
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:40'
    document.body.appendChild(c)
    var dpr = window.devicePixelRatio || 1,
      w = (c.width = innerWidth * dpr),
      h = (c.height = innerHeight * dpr),
      g = c.getContext('2d')
    var colours = ['#ff5b45', '#1fb877', '#3d7bff', '#ffc53d', '#ff9ec6', '#ffffff']
    var bits = []
    for (var i = 0; i < 140; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4,
        v = (7 + Math.random() * 13) * dpr
      bits.push({
        x: x * dpr,
        y: y * dpr,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        r: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.5,
        s: (5 + Math.random() * 7) * dpr,
        c: colours[i % colours.length],
      })
    }
    var t0 = performance.now()
    ;(function frame(now) {
      var age = (now - t0) / 1000
      g.clearRect(0, 0, w, h)
      bits.forEach((b) => {
        b.vy += 0.42 * dpr
        b.vx *= 0.99
        b.x += b.vx
        b.y += b.vy
        b.r += b.vr
        g.save()
        g.translate(b.x, b.y)
        g.rotate(b.r)
        g.globalAlpha = Math.max(0, 1 - age / 2.6)
        g.fillStyle = b.c
        g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2)
        g.restore()
      })
      if (age < 2.6) requestAnimationFrame(frame)
      else c.remove()
    })(t0)
  }
  function ready(fn) {
    var go = () => {
      plate('', false)
      rail()
      fn()
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
  }
  return { It: It, P: P, agent: agent, plate: plate, say: say, act: act, confetti: confetti, ready: ready }
})()
