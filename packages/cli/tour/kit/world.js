// The world every page of the tour is held in. It is a field of dots, and the field is what
// things are made of here: each dot has a home on a grid, can be pulled away from it, and
// springs back. Dots fly together to form the large words, run to the outline of something
// before it is filled, stream from a touch to the agent's hand, gather and turn round the hand
// for as long as something is unanswered, and are thrown outward when the answer lands. A
// finger or a mouse dragged over the field leaves a wake in it. The screen is also an
// instrument: a touch plays a note of one scale, chosen by where it lands.
//
// Nothing here knows what the agent is doing. A page moves the hand and has it say something
// only when the page has heard something: that It took what was done, or that the agent
// changed the page's state. The dots that gather round the hand do so while a page has the
// hand count the seconds something has gone unanswered, and for no other reason.
//
// A browser that cannot draw the field or make a sound shows the page all the same, without
// that part, and one that asks for less motion is given a field that stands still.
window.World = (() => {
  var It = window.It || { state: {}, onState: () => () => {}, action: () => Promise.resolve() }
  var P = window.__PARAMS || {}
  var agent = String(P.agent || '') || 'Your agent'
  var calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  var soon = window.requestAnimationFrame ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16)
  /** Time given to something that moves. Where nothing moves, none is taken. */
  var wait = (ms) => (calm || !(ms > 0) ? Promise.resolve() : new Promise((done) => setTimeout(done, ms)))
  /** Time given to the person, to read what was just written. It is the same however little moves. */
  var pause = (ms) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve())
  var make = (tag, id, svg) => {
    var el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)
    if (id) el.id = id
    return el
  }
  var clock = () => performance.now()

  // ── The field ──
  var canvas = make('canvas', 'w-field')
  var ink = make('svg', 'w-ink', true)
  var g = null
  try {
    g = canvas.getContext ? canvas.getContext('2d') : null
  } catch (_) {}
  /** Whether the field moves: there is one to draw, and the person has not asked for less motion. */
  var moving = !!g && !calm
  var WHITE = 0,
    GREEN = 1,
    AMBER = 2
  var COLOUR = ['#ffffff', '#34d399', '#ffc53d']
  var dpr = 1,
    wide = 0,
    high = 0
  // Each dot: its home, where it is and how fast it goes, where it is held if it is held
  // anywhere (`to`), how lit it is of itself (`heat`) and in what colour (`hue`)
  var dots = []
  var waves = [] // each { x, y, at, gain, hue, speed, band, life }
  var beams = [] // each { from, bend, to, at, lasts }
  var sparks = [] // each { x, y, vx, vy, at, lasts, hue, size }
  var at = { x: -999, y: -999 } // where the hand is going
  var hp = { x: -999, y: -999 } // where the hand is
  var pointer = null // where a finger or the mouse is, and how far it came since the field was last drawn
  var pull = 0 // how far the whole field leans toward the hand, from 0 to 1
  var rest = 0
  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    wide = innerWidth
    high = innerHeight
    canvas.width = wide * dpr
    canvas.height = high * dpr
    // As many dots as the screen has room for, and never more than a phone moves with ease
    var gap = Math.max(24, Math.ceil(Math.sqrt((wide * high) / 1700)))
    var first = !dots.length
    dots = []
    orbit.dots = []
    for (var y = gap / 2; y < high; y += gap) {
      for (var x = gap / 2; x < wide; x += gap) {
        var d = { hx: x, hy: y, x: x, y: y, vx: 0, vy: 0, to: 0, tx: 0, ty: 0, heat: 0, hue: WHITE, stiff: 0, path: null, after: 0 }
        // A page begins with the field gathered at one place and let go from it
        if (first && moving) {
          var a = Math.random() * Math.PI * 2,
            far = Math.random() * 60
          d.x = wide * 0.5 + Math.cos(a) * far
          d.y = high * 0.45 + Math.sin(a) * far
          d.after = clock() + Math.random() * 260
          d.heat = 0.8
        }
        dots.push(d)
      }
    }
    rest = 0
  }
  var along = (b, k) => ({
    x: (1 - k) * (1 - k) * b.from.x + 2 * (1 - k) * k * b.bend.x + k * k * b.to.x,
    y: (1 - k) * (1 - k) * b.from.y + 2 * (1 - k) * k * b.bend.y + k * k * b.to.y,
  })
  /** Dots that nothing holds, taken from all over the field: at most `most` of them. */
  function free(most) {
    var out = []
    var step = Math.max(1, Math.floor(dots.length / Math.max(1, most)))
    var from = Math.floor(Math.random() * step)
    for (var i = from; i < dots.length && out.length < most; i += step) if (!dots[i].to && !dots[i].path) out.push(dots[i])
    return out
  }
  /** The dots that nothing holds and that are nearest a point: at most `most` of them. */
  function nearest(x, y, most) {
    return dots
      .filter((d) => !d.to && !d.path)
      .map((d) => ({ d: d, far: Math.hypot(d.x - x, d.y - y) }))
      .sort((a, b) => a.far - b.far)
      .slice(0, most)
      .map((one) => one.d)
  }

  // What gathers round the hand while something is unanswered: more of the field the longer it has been, turning faster
  var orbit = { on: false, since: 0, hue: GREEN, dots: [], tick: 0, lean: false }
  function gather(now) {
    if (!orbit.on) return
    var seconds = Math.max(0, (Date.now() - orbit.since) / 1000)
    var most = Math.min(wide < 600 ? 40 : 84, 12 + Math.floor(seconds * 8))
    if (orbit.dots.length < most && ++orbit.tick % 2 === 0) {
      var one = nearest(hp.x, hp.y, 1)[0]
      if (one) {
        one.to = 2
        one.hue = orbit.hue
        one.ring = 24 + (orbit.dots.length % 5) * 12 + Math.random() * 5
        one.turn = Math.random() * Math.PI * 2
        one.way = orbit.dots.length % 2 ? 1 : -1
        orbit.dots.push(one)
      }
    }
    var fast = (orbit.hue === AMBER ? 0.0011 : 0.002) * (1 + Math.min(seconds, 24) / 12)
    for (var i = 0; i < orbit.dots.length; i++) {
      var d = orbit.dots[i]
      var a = d.turn + now * fast * d.way * (40 / d.ring)
      d.tx = hp.x + 4 + Math.cos(a) * d.ring
      d.ty = hp.y + 6 + Math.sin(a) * d.ring
      d.hue = orbit.hue
    }
    // While the person waits for another page, the whole field leans toward the hand
    pull += ((orbit.lean ? Math.min(0.3, 0.05 + seconds * 0.02) : 0) - pull) * 0.04
  }
  /** What was gathered round the hand is let go, outward. */
  function scatter() {
    orbit.on = false
    for (var i = 0; i < orbit.dots.length; i++) {
      var d = orbit.dots[i]
      var far = Math.hypot(d.x - hp.x, d.y - hp.y) || 1
      d.to = 0
      d.vx += ((d.x - hp.x) / far) * 9
      d.vy += ((d.y - hp.y) / far) * 9
      d.heat = 1
    }
    orbit.dots = []
  }

  function frame() {
    soon(frame)
    if (document.hidden) return
    var now = clock()
    waves = waves.filter((w) => now - w.at < w.life)
    beams = beams.filter((b) => now - b.at < b.lasts + 200)
    sparks = sparks.filter((s) => now - s.at < s.lasts)
    var was = { x: hp.x, y: hp.y }
    step(now)
    gather(now)
    if (!orbit.on) pull *= 0.9
    var hdx = hp.x - was.x,
      hdy = hp.y - was.y,
      trail = Math.hypot(hdx, hdy) > 0.6 && Math.abs(hdx) < 400
    // The hand leaves a short tail of lit dots behind it as it goes
    if (trail && sparks.length < 400)
      sparks.push({ x: hp.x + 3, y: hp.y + 5, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, at: now, lasts: 460, hue: el.dataset.tone === 'amber' ? AMBER : GREEN, size: 2.4 })
    var drag = pointer && (pointer.dx || pointer.dy) ? pointer : null
    var lights = beams.map((b) => along(b, Math.min(1, (now - b.at) / b.lasts)))
    // A field in which nothing is happening is drawn a few times a second, for the dots near the hand that breathe
    var busy = waves.length || beams.length || sparks.length || trail || drag || orbit.on || pull > 0.002
    var breath = 0.2 + 0.08 * Math.sin(now / 620)
    var mood = el.dataset.tone === 'amber' ? AMBER : GREEN
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    rest++
    var draws = busy || rest < 40 || rest % 4 === 0
    if (draws) g.clearRect(0, 0, wide, high)
    var colour = -1
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i]
      // Where it is held, or its home
      var tx = d.hx,
        ty = d.hy,
        hard = 0.085,
        slow = 0.2
      if (d.path) {
        var k = (now - d.path.at) / d.path.lasts
        if (k >= 1) {
          d.path = null
          d.heat = 0.7
        } else if (k > 0) {
          var on = along(d.path.b, k)
          tx = on.x + d.path.off
          ty = on.y - d.path.off
          hard = 0.32
          slow = 0.42
        }
      } else if (d.to) {
        tx = d.tx
        ty = d.ty
        hard = d.to === 2 ? 0.16 : 0.1 + d.stiff
        slow = d.to === 2 ? 0.3 : 0.26
      } else if (pull > 0.002) {
        tx += (hp.x - d.hx) * pull
        ty += (hp.y - d.hy) * pull
      }
      if (drag) {
        var px = d.x - drag.x,
          py = d.y - drag.y,
          pd = Math.hypot(px, py)
        if (pd < 74) {
          var pf = 1 - pd / 74
          d.vx += drag.dx * 0.07 * pf + (px / (pd || 1)) * pf * 0.9
          d.vy += drag.dy * 0.07 * pf + (py / (pd || 1)) * pf * 0.9
          if (pf * drag.glow > d.heat) {
            d.heat = pf * drag.glow
            if (!d.to && !d.path) d.hue = WHITE
          }
        }
      }
      if (trail) {
        var qd = Math.hypot(d.x - hp.x, d.y - hp.y)
        if (qd < 40) {
          var qf = 1 - qd / 40
          d.vx += hdx * 0.03 * qf
          d.vy += hdy * 0.03 * qf
          if (qf > d.heat) {
            d.heat = qf
            if (!d.to && !d.path) d.hue = mood
          }
        }
      }
      if (now >= d.after) {
        var fx = tx - d.x,
          fy = ty - d.y
        if (d.to || d.path || fx > 0.05 || fx < -0.05 || fy > 0.05 || fy < -0.05 || d.vx > 0.02 || d.vx < -0.02 || d.vy > 0.02 || d.vy < -0.02) {
          d.vx = (d.vx + fx * hard) * (1 - slow)
          d.vy = (d.vy + fy * hard) * (1 - slow)
          d.x += d.vx
          d.y += d.vy
          busy = true
        }
      }
      if (d.heat > 0.01) {
        d.heat *= 0.94
        busy = true
      }
      if (!draws) continue
      var dx = 0,
        dy = 0,
        lit = 0.2 + d.heat,
        hue = d.heat > 0.12 || d.to || d.path ? d.hue : WHITE
      for (var w = 0; w < waves.length; w++) {
        var wv = waves[w]
        var age = (now - wv.at) / 1000
        if (age < 0) continue
        var far = Math.hypot(d.x - wv.x, d.y - wv.y)
        var off = Math.abs(far - age * wv.speed)
        if (off > wv.band || far < 1) continue
        var push = (1 - off / wv.band) * wv.gain * Math.max(0, 1 - (age * 1000) / wv.life)
        dx += ((d.x - wv.x) / far) * push * 8
        dy += ((d.y - wv.y) / far) * push * 8
        lit += push * 0.8
        if (wv.hue && push > 0.2) hue = wv.hue
      }
      for (var j = 0; j < lights.length; j++) {
        var near = Math.hypot(d.x - lights[j].x, d.y - lights[j].y)
        if (near < 70) {
          lit += (1 - near / 70) * 0.9
          hue = GREEN
        }
      }
      var by = Math.hypot(d.x - hp.x, d.y - hp.y)
      if (by < 110) {
        lit += (1 - by / 110) * breath
        if (by < 66 && hue === WHITE) hue = mood
      }
      if (d.to || d.path) lit = 1
      if (hue !== colour) g.fillStyle = COLOUR[(colour = hue)]
      // A dot that is lit has a little light round it, and one that is held is larger
      if (lit > 0.7) {
        g.globalAlpha = 0.12
        g.fillRect(d.x + dx - 5, d.y + dy - 5, 10, 10)
      }
      g.globalAlpha = lit > 1 ? 1 : lit
      var s = d.to || d.path ? 3.2 : lit > 0.36 ? 2.6 : 1.8
      g.fillRect(d.x + dx - s / 2, d.y + dy - s / 2, s, s)
    }
    if (drag) drag.dx = drag.dy = 0
    if (busy) rest = 0
    if (!draws) return
    // Dots thrown from a point, which slow as they go and are gone
    for (var n = 0; n < sparks.length; n++) {
      var p = sparks[n]
      var t = (now - p.at) / p.lasts
      var gone = 1 - (1 - t) * (1 - t)
      g.globalAlpha = Math.max(0, 1 - t * t)
      g.fillStyle = COLOUR[p.hue]
      g.fillRect(p.x + p.vx * gone - p.size / 2, p.y + p.vy * gone - p.size / 2, p.size, p.size)
    }
    g.globalAlpha = 1
  }
  /** The field moves outward from a point, as water does from a stone. `green` is true for the agent's doing, and `life` is how long it lasts where that is not the usual. */
  function wave(x, y, gain, green, life) {
    if (moving && waves.length < 40) waves.push({ x: x, y: y, at: clock(), gain: gain || 1, hue: green ? GREEN : WHITE, speed: 560, band: 54, life: life || 1700 })
  }
  /** A wave that crosses the whole field, for the moment an answer lands or something large is done. */
  function shock(x, y, green, gain) {
    if (!moving) return
    var far = Math.hypot(Math.max(x, wide - x), Math.max(y, high - y))
    waves.push({ x: x, y: y, at: clock(), gain: gain || 2.2, hue: green ? GREEN : WHITE, speed: 1050, band: 110, life: Math.max(900, (far / 1050) * 1000 + 300) })
    waves.push({ x: x, y: y, at: clock() + 130, gain: (gain || 2.2) * 0.5, hue: green ? GREEN : WHITE, speed: 820, band: 70, life: Math.max(900, (far / 820) * 1000 + 300) })
  }
  function ripple(x, y) {
    var r = make('i')
    r.className = 'w-ripple'
    r.style.left = `${x}px`
    r.style.top = `${y}px`
    document.body.appendChild(r)
    setTimeout(() => r.remove(), 950)
    wave(x, y, 1)
  }
  function throwDots(x, y, many, reach, hue) {
    var now = clock()
    for (var i = 0; i < many; i++) {
      var a = Math.random() * Math.PI * 2,
        far = reach * (0.25 + Math.random() * 0.75)
      sparks.push({ x: x, y: y, vx: Math.cos(a) * far, vy: Math.sin(a) * far, at: now, lasts: 700 + Math.random() * 900, hue: hue(i), size: 2 + Math.random() * 3 })
    }
  }
  /** Something to be glad of happened at a point: the field is thrown outward from it, in the agent's green and in white. */
  function burst(x, y) {
    if (!moving) return
    throwDots(x, y, 120, Math.min(wide, high) * 0.62, (i) => (i % 3 ? GREEN : WHITE))
    shock(x, y, true, 2.6)
  }
  /** Something at a point breaks into dots. */
  function shatter(x, y, green) {
    if (!moving) return
    throwDots(x, y, 34, 84, () => (green ? GREEN : WHITE))
    wave(x, y, 0.7, green)
  }

  // ── Things made of the field ──
  /** Holds some of the field at the points given, each [x, y] on the screen, and gives back what lets them go. */
  function hold(points, hue, stagger) {
    var taken = free(points.length)
    var now = clock()
    taken.forEach((d, i) => {
      var p = points[Math.floor((i * points.length) / taken.length)]
      d.to = 1
      d.tx = p[0]
      d.ty = p[1]
      d.hue = hue
      d.stiff = Math.random() * 0.05
      d.after = now + Math.random() * (stagger || 0)
    })
    rest = 0
    return () =>
      taken.forEach((d) => {
        if (d.to !== 1) return
        d.to = 0
        d.heat = 0.9
        d.after = clock() + Math.random() * 180
      })
  }
  var forming = new WeakMap()
  /**
   * Writes words into a part of the page out of the field: dots fly from all over the screen
   * to where the letters are, and then the letters themselves take over and the dots go home.
   * Where the field does not move, the words are simply there.
   */
  function form(target, text) {
    var mine = {}
    var was = forming.get(target)
    if (was) was.release()
    target.textContent = text
    if (!moving || !text) return Promise.resolve()
    var points = []
    try {
      points = sampled(target)
    } catch (_) {}
    if (!points.length) return Promise.resolve()
    target.style.transition = 'none'
    target.style.opacity = '0'
    mine.release = hold(points, WHITE, 240)
    forming.set(target, mine)
    return new Promise((done) => {
      setTimeout(() => {
        if (forming.get(target) !== mine) return done()
        target.style.transition = 'opacity .35s'
        target.style.opacity = ''
        setTimeout(() => {
          mine.release()
          if (forming.get(target) === mine) forming.delete(target)
          done()
        }, 220)
      }, 1250)
    })
  }
  // Where the letters of an element are, as points of the screen: its words are drawn out of
  // sight where the page has laid them out, and what was drawn is read back a few pixels apart
  function sampled(target) {
    var box = target.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return []
    var style = getComputedStyle(target)
    var off = make('canvas')
    off.width = Math.ceil(box.width) + 8
    off.height = Math.ceil(box.height) + 8
    var c = off.getContext('2d', { willReadFrequently: true })
    c.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    if ('letterSpacing' in c) c.letterSpacing = style.letterSpacing
    c.textBaseline = 'alphabetic'
    c.fillStyle = '#fff'
    var rise = c.measureText('Mg').fontBoundingBoxAscent || parseFloat(style.fontSize) * 0.9
    var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    var range = document.createRange()
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var word = /\S+/g
      for (var m = word.exec(node.data); m; m = word.exec(node.data)) {
        range.setStart(node, m.index)
        range.setEnd(node, m.index + m[0].length)
        var r = range.getClientRects()[0]
        if (r) c.fillText(m[0], r.left - box.left + 4, r.top - box.top + 4 + rise)
      }
    }
    var every = Math.max(3, Math.round(parseFloat(style.fontSize) / 13))
    var data = c.getImageData(0, 0, off.width, off.height).data
    var points = []
    for (var y = 0; y < off.height; y += every) for (var x = 0; x < off.width; x += every) if (data[(y * off.width + x) * 4 + 3] > 120) points.push([box.left + x - 4, box.top + y - 4])
    // No more of the field than can be spared
    var most = Math.floor(dots.length * 0.6)
    if (points.length <= most) return points
    var kept = []
    for (var i = 0; i < most; i++) kept.push(points[Math.floor((i * points.length) / most)])
    return kept
  }
  /**
   * Draws the outline of a part of the page out of the field: dots run to its edges, and when
   * they are there the caller fills it in. What is given back lets the dots go home.
   */
  function outline(target, green) {
    if (!moving) return Promise.resolve(() => {})
    var r = target.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return Promise.resolve(() => {})
    var round = 2 * (r.width + r.height)
    var many = Math.min(Math.floor(dots.length * 0.22), Math.max(24, Math.round(round / 11)))
    var points = []
    for (var i = 0; i < many; i++) {
      var d = (i / many) * round
      if (d < r.width) points.push([r.left + d, r.top])
      else if (d < r.width + r.height) points.push([r.right, r.top + d - r.width])
      else if (d < 2 * r.width + r.height) points.push([r.right - (d - r.width - r.height), r.bottom])
      else points.push([r.left, r.bottom - (d - 2 * r.width - r.height)])
    }
    var release = hold(points, green === false ? WHITE : GREEN, 160)
    return new Promise((done) => setTimeout(() => done(release), 620))
  }

  // ── The hand ──
  var el = make('div', 'w-hand')
  el.innerHTML =
    '<i id="w-ring"></i><svg width="22" height="26" viewBox="0 0 16 22" aria-hidden="true"><path d="M1 1 L1 17.5 L5.2 13.8 L8.2 20.6 L10.9 19.4 L7.9 12.8 L13.6 12.8 Z"/></svg><span id="w-tag" role="status"></span>'
  var tag = el.querySelector('#w-tag')
  var ticking = null
  var counts = null // what writes the hand's words while it counts the seconds, which is done again whenever the page's state changes
  var going = null // the hand's way from one place to the next: { fx, fy, at, ms, over }
  // The plate hangs to the right of the pointer, and is drawn back as far as it must be to stay on the screen
  function place() {
    var over = at.x + 15 + tag.offsetWidth + 8 - innerWidth
    tag.style.setProperty('--shift', `${-Math.max(0, Math.min(over, at.x + 7))}px`)
  }
  var put = (x, y) => {
    el.style.transform = `translate(${x}px, ${y}px)`
  }
  // Where the hand is at this moment: on its way, with a little too far at the end of a long one, or where it rests, drifting a little as it listens
  function step(now) {
    if (going) {
      var k = Math.min(1, (now - going.at) / going.ms)
      var e = going.over ? 1 + 2.3 * (k - 1) ** 3 + 1.3 * (k - 1) ** 2 : 1 - (1 - k) ** 3
      hp.x = going.fx + (at.x - going.fx) * e
      hp.y = going.fy + (at.y - going.fy) * e
      if (k >= 1) going = null
      put(hp.x, hp.y)
    } else if (el.dataset.tone === 'amber') put(hp.x, hp.y)
    else put(hp.x + Math.sin(now / 1700) * 3, hp.y + Math.cos(now / 2300) * 2.4)
  }
  function tone(name, since, lean) {
    el.dataset.tone = name || ''
    var counting = since !== undefined
    if (!counting) {
      if (orbit.on) scatter()
      return
    }
    if (!moving) return
    var hue = name === 'amber' ? AMBER : GREEN
    if (orbit.on && orbit.hue !== hue) scatter()
    orbit.on = true
    orbit.since = since
    orbit.hue = hue
    orbit.lean = !!lean
  }
  var hand = {
    /** Goes to a point of the screen, and says when it is there. */
    move(x, y, ms) {
      ms = !moving ? 0 : ms === undefined ? 650 : ms
      var from = hp.x === -999 ? { x: x, y: y } : hp
      at = { x: x, y: y }
      el.classList.add('on')
      el.classList.remove('up', 'left')
      place()
      if (ms > 0) going = { fx: from.x, fy: from.y, at: clock(), ms: ms, over: ms >= 300 && Math.hypot(x - from.x, y - from.y) > 90 }
      else {
        going = null
        hp = { x: x, y: y }
        put(x, y)
      }
      rest = 0
      return wait(ms)
    },
    /**
     * Goes to a part of the page: its middle, just under it, or its top left corner. At a
     * corner the hand points at the thing from outside it, with its plate above, so that
     * nothing of the thing is covered.
     */
    to(target, where, ms) {
      var r = target.getBoundingClientRect()
      if (where === 'middle') return hand.move(r.left + r.width / 2, r.top + r.height / 2, ms)
      if (where === 'under') return hand.move(r.left + 26, r.bottom - 6, ms)
      // Beside something, at its left, the plate is to the left of the pointer, where there is room for it
      if (where === 'beside') {
        var beside = hand.move(r.left - 4, r.top + r.height / 2, ms)
        if (r.left > 260) el.classList.add('left')
        return beside
      }
      var there = hand.move(Math.max(4, r.left - 3), Math.max(30, r.top - 3), ms)
      el.classList.add('up')
      return there
    },
    /** Where the hand is going, or is. */
    where: () => ({ x: at.x, y: at.y }),
    tap() {
      el.classList.remove('tap')
      void el.offsetWidth
      el.classList.add('tap')
      wave(at.x, at.y, 0.5, true)
    },
    /**
     * What stands on the hand's plate after the agent's name. With no `tone` the hand is
     * listening, which is how it waits for the person. `live` is for when it is setting
     * something down, and `amber` for when the agent cannot hear.
     */
    say(words, how) {
      clearInterval(ticking)
      ticking = counts = null
      tag.textContent = words ? `${agent} · ${words}` : agent
      tone(how)
      place()
    },
    /**
     * The same, with how long it has been so, counted from `since` by this browser's clock. It
     * is for something that is unanswered: the field gathers round the hand for as long as it
     * stands, more of it the longer it has been. `lean` is for when what is awaited is another
     * page, and the whole field leans toward the hand.
     */
    clock(words, since, how, lean) {
      var began = since || Date.now()
      var tick = () => {
        tag.textContent = `${agent} · ${words()} · ${Math.max(0, Math.floor((Date.now() - began) / 1000))} s`
        place()
      }
      clearInterval(ticking)
      tone(how || 'live', began, lean)
      tick()
      counts = tick
      ticking = setInterval(tick, 250)
    },
  }
  /** Something done at a point travels to the hand: dots of the field stream along the way, and a line is drawn as they go. */
  function pulse(from, colour) {
    var to = { x: at.x + 2, y: at.y + 2 }
    var far = Math.hypot(to.x - from.x, to.y - from.y)
    var lasts = !moving ? 0 : Math.max(300, Math.min(680, far * 0.9))
    var bend = { x: (from.x + to.x) / 2 + (to.y - from.y) * 0.18, y: (from.y + to.y) / 2 - (to.x - from.x) * 0.18 }
    if (moving) {
      var path = make('path', '', true)
      path.setAttribute('d', `M${from.x} ${from.y} Q${bend.x} ${bend.y} ${to.x} ${to.y}`)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', colour || 'var(--w-ok)')
      path.setAttribute('stroke-width', '2')
      path.setAttribute('stroke-linecap', 'round')
      ink.appendChild(path)
      var long = path.getTotalLength ? path.getTotalLength() : far
      path.style.strokeDasharray = `${long * 0.28} ${long}`
      path.style.strokeDashoffset = `${long * 0.28}`
      path.style.transition = `stroke-dashoffset ${lasts}ms cubic-bezier(.5,0,.3,1), opacity .3s ${lasts}ms`
      soon(() => {
        path.style.strokeDashoffset = `${-long}`
        path.style.opacity = '0'
      })
      setTimeout(() => path.remove(), lasts + 400)
      var b = { from: from, bend: bend, to: to, at: clock(), lasts: lasts }
      beams.push(b)
      var hue = colour ? AMBER : GREEN
      nearest(from.x, from.y, 18).forEach((d, i) => {
        d.path = { b: b, at: b.at + i * 16, lasts: lasts, off: (Math.random() - 0.5) * 16 }
        d.hue = hue
      })
    }
    return wait(lasts)
  }
  /** A straight line between two points of the screen, drawn from the first to the second. */
  function line(a, b) {
    var l = make('line', '', true)
    var long = Math.hypot(b.x - a.x, b.y - a.y)
    l.setAttribute('x1', a.x)
    l.setAttribute('y1', a.y)
    l.setAttribute('x2', b.x)
    l.setAttribute('y2', b.y)
    l.setAttribute('stroke', 'var(--w-ok)')
    l.setAttribute('stroke-width', '2')
    l.setAttribute('stroke-linecap', 'round')
    l.style.strokeDasharray = long
    l.style.strokeDashoffset = moving ? long : 0
    l.style.transition = 'stroke-dashoffset .55s cubic-bezier(.22,1,.36,1), opacity .6s'
    ink.appendChild(l)
    soon(() => {
      l.style.strokeDashoffset = '0'
    })
    return l
  }

  // ── Words written a letter at a time ──
  var writing = new WeakMap()
  async function type(target, text, speed) {
    var mine = {}
    writing.set(target, mine)
    if (calm) {
      target.textContent = text
      return
    }
    target.classList.add('w-caret')
    target.textContent = ''
    for (var ch of String(text)) {
      if (writing.get(target) !== mine) return
      target.textContent += ch
      await wait(1000 / (speed || 34) + (ch === '.' || ch === ',' ? 150 : 0))
    }
    if (writing.get(target) === mine) target.classList.remove('w-caret')
  }

  // ── Sound: the screen as an instrument. A browser allows it only once the person has touched the page ──
  var audio = null
  var out = null
  var quiet = false
  // One scale, five notes to the octave, from the A below middle C: whatever is played together sounds well
  var SCALE = [0, 3, 5, 7, 10]
  var pitch = (n) => 220 * 2 ** ((SCALE[((n % 5) + 5) % 5] + 12 * Math.floor(n / 5)) / 12)
  function begin() {
    if (audio) return
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)()
      out = audio.createGain()
      out.gain.value = 0.9
      out.connect(audio.destination)
      // What is played is heard again, fainter, a moment later, which gives the room some size
      var echo = audio.createDelay(1)
      var back = audio.createGain()
      var soft = audio.createBiquadFilter()
      echo.delayTime.value = 0.27
      back.gain.value = 0.3
      soft.type = 'lowpass'
      soft.frequency.value = 1800
      out.connect(echo)
      echo.connect(soft)
      soft.connect(back)
      back.connect(echo)
      back.connect(audio.destination)
    } catch (_) {
      audio = null
    }
  }
  function note(hz, lasts, loud, shape, after) {
    if (quiet || !audio) return
    try {
      var o = audio.createOscillator(),
        v = audio.createGain(),
        t = audio.currentTime + (after || 0)
      o.type = shape || 'sine'
      o.frequency.value = hz
      v.gain.setValueAtTime(0, t)
      v.gain.linearRampToValueAtTime(loud, t + 0.008)
      v.gain.exponentialRampToValueAtTime(0.0001, t + lasts)
      o.connect(v).connect(out)
      o.start(t)
      o.stop(t + lasts + 0.02)
    } catch (_) {}
  }
  var set = 0
  var sound = {
    /** The person touched the screen: a note of the scale, higher the further right, and an octave up in the top half. */
    touch(x, y) {
      var n = typeof x === 'number' ? Math.floor(Math.max(0, Math.min(0.999, x / (innerWidth || 1))) * 8) + (y < innerHeight / 2 ? 5 : 0) : 5
      note(pitch(n), 0.5, 0.05, 'triangle')
      note(pitch(n) * 2, 0.2, 0.012)
    },
    /** What they did has left for the agent: two notes going up. */
    sent() {
      note(pitch(7), 0.16, 0.03)
      note(pitch(9), 0.22, 0.03, 'sine', 0.08)
    },
    /** The agent's answer landed: the scale's own chord, from the bottom up. */
    land() {
      set = 0
      ;[0, 2, 5, 6, 8].forEach((n, i) => note(pitch(n), 1.5 - i * 0.12, 0.034, i < 2 ? 'triangle' : 'sine', i * 0.045))
    },
    /** The agent set down one thing among several: each a step higher than the one before. */
    step() {
      note(pitch(10 + (set++ % 8)), 0.16, 0.024)
    },
    /** The agent set down something with weight. */
    thud() {
      note(pitch(-5), 0.3, 0.07)
      note(pitch(5), 0.18, 0.02, 'triangle', 0.01)
    },
    /** Whether the person has turned the sound off. */
    off: () => quiet,
  }
  var told = []
  /** A page that makes a sound of its own is told when the person turns the sound off or on. */
  sound.onToggle = (fn) => told.push(fn)
  var toggle = make('button', 'w-sound')
  toggle.type = 'button'
  var said = () => {
    toggle.textContent = quiet ? 'sound off' : 'sound on'
    toggle.setAttribute('aria-pressed', String(!quiet))
  }
  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    quiet = !quiet
    said()
    told.forEach((fn) => fn(quiet))
  })
  var inside = (e, what) => !!(e.target && e.target.closest && e.target.closest(what))
  addEventListener(
    'pointerdown',
    (e) => {
      if (typeof e.clientX !== 'number') return
      begin()
      pointer = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, glow: 1, down: true }
      // The field moves wherever the screen is touched, and the touch is a note, except on what has a sound of its own
      wave(e.clientX, e.clientY, 0.55)
      if (!inside(e, '[data-sound="own"], input, textarea, #w-sound')) sound.touch(e.clientX, e.clientY)
    },
    true,
  )
  addEventListener(
    'pointermove',
    (e) => {
      if (!moving || typeof e.clientX !== 'number') return
      var down = pointer ? pointer.down : false
      var dx = pointer ? pointer.dx + e.clientX - pointer.x : 0,
        dy = pointer ? pointer.dy + e.clientY - pointer.y : 0
      // A finger that drags, or a mouse held down, leaves the brighter wake
      pointer = { x: e.clientX, y: e.clientY, dx: Math.max(-60, Math.min(60, dx)), dy: Math.max(-60, Math.min(60, dy)), glow: down ? 1 : 0.6, down: down }
    },
    true,
  )
  var lifted = () => {
    if (pointer) pointer.down = false
  }
  addEventListener('pointerup', lifted, true)
  addEventListener('pointercancel', lifted, true)

  function ready(fn) {
    var go = () => {
      document.body.prepend(canvas, ink)
      document.body.append(el, toggle)
      said()
      fit()
      addEventListener('resize', fit)
      addEventListener('resize', place)
      if (moving) soon(frame)
      else if (g) still()
      hand.say('')
      // Words the hand takes from the page's state are the state's at once, and not at the next count
      It.onState(() => {
        if (counts) counts()
      })
      fn()
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
  }
  // The field as it stands when nothing may move: every dot at its home
  function still() {
    var draw = () => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, wide, high)
      g.fillStyle = COLOUR[WHITE]
      g.globalAlpha = 0.2
      for (var i = 0; i < dots.length; i++) g.fillRect(dots[i].hx - 0.9, dots[i].hy - 0.9, 1.8, 1.8)
      g.globalAlpha = 1
    }
    draw()
    addEventListener('resize', draw)
  }
  return {
    It: It,
    P: P,
    agent: agent,
    calm: calm,
    moving: moving,
    wait: wait,
    pause: pause,
    soon: soon,
    wave: wave,
    shock: shock,
    ripple: ripple,
    burst: burst,
    shatter: shatter,
    form: form,
    outline: outline,
    hand: hand,
    pulse: pulse,
    line: line,
    type: type,
    sound: sound,
    ready: ready,
  }
})()
