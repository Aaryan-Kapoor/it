// Made by scripts/film.mjs from the launch film's source. Do not edit it here:
// change the film, or scripts/film-site.js, and run the script again.
export const film = (() => {
// The film reads its ending from the address bar. The page always plays the one that was posted.
const location = { search: "" };
// ════ core.js ════
// Core: frame constants, the music's beat grid, math, easing, springs, colour,
// seeded randomness and the small drawing vocabulary every scene shares.
// Everything here is a pure function of its inputs, which is what lets any
// frame be rendered in any order.

// The film is cut to the owner's music ("Background Music" by Sub_Clair), which
// runs at exactly 118 BPM with its first downbeat at 0.538 s. Every scene is
// timed in bars and beats of that grid. The track's main section ends on the
// downbeat of bar 40 and its outro runs on to about 98 s, so the ending plays
// over the outro: three more bars for the install, or one for the plain end
// card, and then five seconds of black while the music fades.
const BPM = 118, BEAT = 60 / BPM, BAR = 4 * BEAT, DOWN0 = 0.538;
// The time of beat b (0 to 3, fractions allowed) of bar n.
const bar = (n, b = 0) => DOWN0 + n * BAR + b * BEAT;
// The ending: 'agent' types "Install itcan.do" into the agent's message field,
// 'plain' ends on the wordmark and the address. Chosen with ?end= in the URL.
const ENDING = new URLSearchParams(location.search).get('end') === 'plain' ? 'plain' : 'agent';
const W = 1920, H = 1080, FPS = 60, DURATION = bar(ENDING === 'plain' ? 41 : 43);
// SPEED maps story time onto the rendered clock. It stays at 1: the cuts sit on
// the music's beats, so a different length means re-cutting by bars, not scaling.
const RUNTIME = DURATION, SPEED = DURATION / RUNTIME;
const TAIL = 5;
// The story time of the rendered frame that shows story time t. Anything
// discrete (typed characters, a counter) uses it so it can't change mid-shutter.
const frameTime = (t) => (Math.round((t / SPEED) * FPS) / FPS) * SPEED;
const CX = W / 2, CY = H / 2;
const TAU = Math.PI * 2;

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const mixN = (a, b, t) => a + (b - a) * t;

const E = {
  lin: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inQuart: (x) => x * x * x * x,
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  inQuint: (x) => x * x * x * x * x,
  outQuint: (x) => 1 - Math.pow(1 - x, 5),
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutExpo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
  outBack: (x) => { const s = 1.70158, c = s + 1; return 1 + c * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); },
  outBackSoft: (x) => { const s = 0.9, c = s + 1; return 1 + c * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); },
  inBack: (x) => { const s = 1.70158; return (s + 1) * x * x * x - s * x * x; },
  outCirc: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  outSine: (x) => Math.sin((x * Math.PI) / 2),
};

// Eased progress of a tween that starts at t0 and lasts d seconds.
function tw(t, t0, d, ease = E.outExpo) { return ease(prog(t, t0, t0 + d)); }

// Analytic step response of a damped spring, 0 before t0 and settling at 1.
function spring(t, t0, f = 2.4, z = 0.42) {
  const x = t - t0;
  if (x <= 0) return 0;
  const w = TAU * f;
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + ((z * w) / wd) * Math.sin(wd * x));
  }
  return 1 - Math.exp(-w * x) * (1 + w * x);
}

// A short decaying wobble, used for hops and settles. 0 before t0.
function wobble(t, t0, freq = 9, decay = 7) {
  const x = t - t0;
  if (x <= 0) return 0;
  return Math.sin(x * freq * TAU) * Math.exp(-x * decay);
}

// Seeded PRNG (mulberry32) so every frame sees the same "randomness".
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth deterministic noise from summed sines, for shakes and drift.
function snoise(x, seed = 0) {
  return (
    Math.sin(x * 1.0 + seed * 1.7) * 0.5 +
    Math.sin(x * 2.3 + seed * 3.1) * 0.3 +
    Math.sin(x * 5.7 + seed * 0.9) * 0.2
  );
}

// ---------- colour ----------
function hexRgb(h) {
  if (h[0] === 'r') { const m = h.match(/[\d.]+/g); return [+m[0], +m[1], +m[2]]; }
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const _lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const _gam = (c) => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return clamp(v) * 255; };
function toOklab([r, g, b]) {
  r = _lin(r); g = _lin(g); b = _lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [_gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), _gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), _gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const _labCache = new Map();
function lab(hex) { let v = _labCache.get(hex); if (!v) { v = toOklab(hexRgb(hex)); _labCache.set(hex, v); } return v; }
function rgbStr([r, g, b], a = 1) { return a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`; }
// Perceptual mix of two hex colours.
function mix(h1, h2, t, a = 1) {
  if (t <= 0) return rgbStr(hexRgb(h1), a);
  if (t >= 1) return rgbStr(hexRgb(h2), a);
  const p = lab(h1), q = lab(h2);
  return rgbStr(fromOklab([lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)]), a);
}
// Mix along a list of [stop, hex] pairs.
function ramp(stops, t, a = 1) {
  if (t <= stops[0][0]) return rgbStr(hexRgb(stops[0][1]), a);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [s0, c0] = stops[i - 1], [s1, c1] = stops[i];
      return mix(c0, c1, (t - s0) / (s1 - s0), a);
    }
  }
  return rgbStr(hexRgb(stops[stops.length - 1][1]), a);
}
function rgba(hex, a) { return rgbStr(hexRgb(hex), a); }

// ---------- palette ----------
// Ink on warm paper, and one bright field per thing It becomes.
const C = {
  ink: '#0e0e10', ink2: '#3a3b40', ink3: '#6e6f76', ink4: '#a3a3a8',
  paper: '#f4f1ea', paper2: '#ebe6dc', card: '#ffffff', line: '#e3ded4',
  coral: '#ff5b45', mint: '#1fb877', sky: '#3d7bff', sun: '#ffc53d',
};
// The fields behind the drop, in order, and the extra ones the fast reel cycles through.
const FIELD = {
  quiz: '#ff9ec6', plan: '#9fd2ff', cal: '#ffd84d', drums: '#151518', seats: '#8fe3bd',
  mood: '#cdb6ff', dash: '#dcf36b', button: '#2f4bff',
  peach: '#ffb896', aqua: '#86e1e6', tomato: '#ff6d58', lime: '#c9f27a', rose: '#ffc2d6', paper: '#f4f1ea',
};

// ---------- canvas vocabulary ----------
const FONT = { disp: 'Disp', body: 'Body', mark: 'Mark' };
function setFont(ctx, weight, size, fam = FONT.disp, ls = 0) {
  ctx.font = `${weight} ${size}px ${fam}`;
  ctx.letterSpacing = ls ? `${(ls * size).toFixed(2)}px` : '0px';
}
function measure(ctx, s) { return ctx.measureText(s).width; }

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}
function fillRR(ctx, x, y, w, h, r, fill) { rr(ctx, x, y, w, h, r); ctx.fillStyle = fill; ctx.fill(); }
function strokeRR(ctx, x, y, w, h, r, stroke, lw = 1) { rr(ctx, x, y, w, h, r); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
function circle(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU); ctx.fillStyle = fill; ctx.fill(); }
function ring(ctx, x, y, r, stroke, lw) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }

// Text with alignment and baseline in one call.
function text(ctx, s, x, y, { color = C.ink, align = 'left', base = 'alphabetic', alpha = 1 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(s, x, y);
  ctx.restore();
}

// Soft layered drop shadow for cards on paper, drawn as stacked blurred rects.
function cardShadow(ctx, x, y, w, h, r, strength = 1, dark = false) {
  if (strength <= 0) return;
  ctx.save();
  const col = dark ? '0,0,0' : '28,22,16';
  ctx.shadowColor = `rgba(${col},${0.16 * strength})`;
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 34;
  fillRR(ctx, x, y, w, h, r, `rgba(${col},${0.02 * strength})`);
  ctx.shadowColor = `rgba(${col},${0.12 * strength})`;
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 5;
  fillRR(ctx, x, y, w, h, r, `rgba(${col},${0.02 * strength})`);
  ctx.restore();
}

// Lay out a line of words and return each word's x offset and width.
function layoutWords(ctx, str) {
  const words = str.split(' ');
  const space = measure(ctx, ' ');
  let x = 0;
  const out = [];
  for (const w of words) {
    const width = measure(ctx, w);
    out.push({ w, x, width });
    x += width + space;
  }
  return { words: out, width: x - space };
}

// A line of words that rise out of a mask one after another. `colorOf(i, word)`
// may recolour individual words. Returns the laid-out width.
function riseLine(ctx, str, x, y, size, t, t0, { stagger = 0.06, dur = 0.55, align = 'left', color = C.ink, colorOf = null, out = null, maskPad = 0.32, alpha = 1 } = {}) {
  const L = layoutWords(ctx, str);
  const x0 = align === 'center' ? x - L.width / 2 : align === 'right' ? x - L.width : x;
  L.words.forEach((wd, i) => {
    const p = tw(t, t0 + i * stagger, dur, E.outExpo);
    if (p <= 0) return;
    let dy = (1 - p) * size * 1.05;
    let a = alpha;
    if (out) {
      const q = tw(t, out.t + i * (out.stagger ?? 0.03), out.dur ?? 0.35, E.inCubic);
      dy -= q * size * 1.05;
      if (q >= 1) return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 + wd.x - size, y - size * (1 + maskPad), wd.width + size * 2, size * (1.28 + maskPad * 2));
    ctx.clip();
    text(ctx, wd.w, x0 + wd.x, y + dy, { color: colorOf ? colorOf(i, wd.w) : color, alpha: a });
    ctx.restore();
  });
  return L.width;
}

// Words that fade up out of a blur, for lines that mix sizes or sit on busy backgrounds.
function fadeLine(ctx, str, x, y, size, t, t0, { stagger = 0.05, dur = 0.45, align = 'left', color = C.ink, colorOf = null, rise = 0.3, blur = true, alpha = 1 } = {}) {
  const L = layoutWords(ctx, str);
  const x0 = align === 'center' ? x - L.width / 2 : align === 'right' ? x - L.width : x;
  L.words.forEach((wd, i) => {
    const p = tw(t, t0 + i * stagger, dur, E.outExpo);
    if (p <= 0) return;
    ctx.save();
    if (blur && p < 0.98) ctx.filter = `blur(${((1 - p) * 12).toFixed(1)}px)`;
    text(ctx, wd.w, x0 + wd.x, y + (1 - p) * size * rise, { color: colorOf ? colorOf(i, wd.w) : color, alpha: alpha * clamp(p * 1.4) });
    ctx.restore();
  });
  return L.width;
}

// The touch indicator: a soft fingertip with a ring. `press` in 0..1.
function drawTouch(ctx, x, y, alpha, press = 0, dark = false) {
  if (alpha <= 0) return;
  const r = 40 * (1 - 0.14 * press);
  ctx.save();
  ctx.globalAlpha *= alpha;
  const base = dark ? '255,255,255' : '15,16,18';
  const edge = dark ? '15,16,18' : '255,255,255';
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  circle(ctx, x, y, r, `rgba(${base},${0.2 + 0.14 * press})`);
  ctx.shadowColor = 'transparent';
  ring(ctx, x, y, r + 1.5, `rgba(${edge},${0.7})`, 2);
  ring(ctx, x, y, r - 1.5, `rgba(${base},${0.55 + 0.25 * press})`, 3);
  ctx.restore();
}

// An expanding ring from a tap.
function drawRipple(ctx, x, y, t, t0, color = C.ink, maxR = 110, dur = 0.5) {
  const p = prog(t, t0, t0 + dur);
  if (p <= 0 || p >= 1) return;
  const e = E.outCubic(p);
  ctx.save();
  ctx.globalAlpha *= (1 - p) * 0.7;
  ring(ctx, x, y, 20 + e * maxR, color, 3 * (1 - p) + 1);
  ctx.restore();
}

// Clip the context to a circle (for circular wipes).
function clipCircle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.01, r), 0, TAU); ctx.clip(); }

// A quadratic Bézier point and tangent.
function qpt(p0, p1, p2, u) {
  const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
}
function qpath(ctx, p0, p1, p2, u0, u1, steps = 40) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [x, y] = qpt(p0, p1, p2, lerp(u0, u1, i / steps));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
}

// ---------- registry ----------
// Scenes register a time window and a draw function; film.js runs them.
const Film = {
  scenes: [],
  flashes: [],
  shakes: [],
  inits: [],
  boosts: [],
  scene(a, b, draw, name = '') { this.scenes.push({ a, b, draw, name }); },
  flash(t, d, color = '#fff', a = 1) { this.flashes.push({ t, d, color, a }); },
  shake(t, d, amp, f = 22) { this.shakes.push({ t, d, amp, f }); },
  init(fn) { this.inits.push(fn); },
  // Extra motion-blur sub-frames for fast moments.
  boost(a, b, k) { this.boosts.push([a, b, k]); },
};

// ════ ui.js ════
// Pieces every scene shares: the wordmark's letters as shapes (so the full stop
// can open into a card, a question mark can unwind into a full stop and a
// capital I can become the i of "it."), a word slot that rolls to its next
// word, buttons, checks and the touch indicator's ripple.

// ---------- the wordmark as shapes ----------
// Arimo Bold, measured from the font file in em: [x0, x1, y0, y1] with y up
// from the baseline negative. The stems, the tittle and both dots are plain
// rectangles in this face, which is what lets them move on their own.
const GL = {
  ls: -0.024,
  adv: { i: 0.2778, I: 0.2778, t: 0.333, '.': 0.2778, '?': 0.6108 },
  stemI: [0.067, 0.211, -0.688, 0],
  stemi: [0.070, 0.207, -0.528, 0],
  tittle: [0.070, 0.207, -0.725, -0.624],
  period: [0.068, 0.209, -0.149, 0],
  qdot: [0.214, 0.355, -0.132, 0],
};
// The centre line of the question mark's hook, from the end of the curl to the
// foot of the stem (skeleton of the glyph at 1000 px).
const QHOOK = [[0.047, -0.491], [0.078, -0.512], [0.110, -0.530], [0.136, -0.548], [0.155, -0.580], [0.184, -0.608], [0.216, -0.626], [0.248, -0.636], [0.279, -0.640], [0.311, -0.642], [0.342, -0.639], [0.374, -0.635], [0.406, -0.624], [0.437, -0.604], [0.461, -0.572], [0.471, -0.541], [0.478, -0.509], [0.473, -0.477], [0.465, -0.446], [0.450, -0.414], [0.422, -0.383], [0.390, -0.357], [0.358, -0.333], [0.328, -0.306], [0.306, -0.274], [0.284, -0.250], [0.252, -0.234], [0.220, -0.212]];
const QLEN = (() => { const L = [0]; for (let i = 1; i < QHOOK.length; i++) L.push(L[i - 1] + Math.hypot(QHOOK[i][0] - QHOOK[i - 1][0], QHOOK[i][1] - QHOOK[i - 1][1])); return L; })();

function glyphRect(ctx, x, base, size, r, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x + r[0] * size, base + r[2] * size, (r[1] - r[0]) * size, (r[3] - r[2]) * size);
}

// A question mark at (x, base) whose hook has unwound by `u` (0 whole, 1 gone),
// leaving only its dot, which slides to where a full stop sits (`dot` 0..1).
let _qc = null;
function drawQuestion(ctx, x, base, size, u, dot, color) {
  if (u <= 0.001) {
    setFont(ctx, 700, size, FONT.mark, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(x - size, base - size * 1.2, size * 3, size * (1.2 - 0.16)); ctx.clip();
    text(ctx, '?', x, base, { color });
    ctx.restore();
  } else if (u < 0.999) {
    const pw = Math.ceil(size * 0.8), ph = Math.ceil(size * 0.9);
    if (!_qc || _qc.width < pw || _qc.height < ph) { _qc = document.createElement('canvas'); _qc.width = Math.max(pw, _qc ? _qc.width : 0); _qc.height = Math.max(ph, _qc ? _qc.height : 0); }
    const g = _qc.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, _qc.width, _qc.height);
    const ox = size * 0.1, ob = size * 0.8;
    g.save(); g.beginPath(); g.rect(0, 0, pw, ob - size * 0.16); g.clip();
    setFont(g, 700, size, FONT.mark, 0);
    g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText('?', ox, ob);
    g.restore();
    // Keep only the part of the hook between the moving point and the foot of the stem.
    const s0 = u * QLEN[QLEN.length - 1];
    g.globalCompositeOperation = 'destination-in';
    g.beginPath();
    let started = false;
    for (let i = 1; i < QHOOK.length; i++) {
      if (QLEN[i] < s0) continue;
      if (!started) {
        const k = (s0 - QLEN[i - 1]) / (QLEN[i] - QLEN[i - 1]);
        g.moveTo(ox + lerp(QHOOK[i - 1][0], QHOOK[i][0], k) * size, ob + lerp(QHOOK[i - 1][1], QHOOK[i][1], k) * size);
        started = true;
      }
      g.lineTo(ox + QHOOK[i][0] * size, ob + QHOOK[i][1] * size);
    }
    g.lineWidth = size * 0.2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#000';
    g.stroke();
    g.globalCompositeOperation = 'source-over';
    ctx.drawImage(_qc, 0, 0, pw, ph, x - ox, base - ob, pw, ph);
  }
  const r = GL.qdot.map((v, i) => lerp(v, GL.period[i], E.inOutCubic(dot)));
  glyphRect(ctx, x, base, size, r, color);
}

// The wordmark "it." at (x, base), letter by letter so it can be assembled:
// `cap` 1 draws a capital I, 0 the i with its tittle; `tittle` 0..1 drops the
// tittle in from above; `stop` scales the full stop in place.
function wordmark(ctx, x, base, size, { color = C.ink, cap = 0, tittle = 1, stop = 1, t = 1 } = {}) {
  const ls = GL.ls * size;
  const stem = GL.stemI.map((v, i) => lerp(GL.stemi[i], v, cap));
  glyphRect(ctx, x, base, size, stem, color);
  if (tittle > 0 && cap < 1) {
    const drop = (1 - tittle) * -0.5;
    ctx.save(); ctx.globalAlpha *= clamp(tittle * 3) * (1 - cap);
    glyphRect(ctx, x, base + drop * size, size, GL.tittle, color);
    ctx.restore();
  }
  const tx = x + GL.adv.i * size + ls;
  if (t > 0) {
    setFont(ctx, 700, size, FONT.mark, 0);
    text(ctx, 't', tx, base, { color, alpha: t });
  }
  if (stop > 0) {
    const px = tx + GL.adv.t * size + ls, r = GL.period;
    const cx = px + ((r[0] + r[1]) / 2) * size, cy = base + ((r[2] + r[3]) / 2) * size, s = (r[1] - r[0]) * size * stop;
    ctx.fillStyle = color;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  }
}
// Where the parts of "it." sit, relative to x, base (in px).
function wordmarkGeom(size) {
  const ls = GL.ls * size, tx = GL.adv.i * size + ls, px = tx + GL.adv.t * size + ls, r = GL.period;
  return {
    width: px + r[1] * size,                 // to the right edge of the full stop
    inkLeft: GL.stemi[0] * size,
    stop: { x: px + ((r[0] + r[1]) / 2) * size, y: ((r[2] + r[3]) / 2) * size, s: (r[1] - r[0]) * size },
  };
}

// ---------- the It mark ----------
// A full stop, the square it is in the wordmark. Opened up, it is a card.
function stopMark(ctx, x, y, s, color = C.ink) {
  ctx.fillStyle = color;
  ctx.fillRect(x - s / 2, y - s / 2, s, s);
}

// ---------- type ----------
// Words that roll: at each time in `times` the slot rolls from one word to the
// next, the old one rising out of the line's mask as the new one rises in.
function rollWords(ctx, words, times, t, x, y, size, { dur = 0.34, color = C.ink, align = 'left', colorOf = null, draw = null, outT = 1e9 } = {}) {
  let i = -1;
  for (let k = 0; k < times.length; k++) if (t >= times[k]) i = k;
  if (i < 0) return;
  const p = E.outExpo(prog(t, times[i], times[i] + dur));
  ctx.save();
  ctx.beginPath(); ctx.rect(-W, y - size * 0.93, W * 3, size * 1.24); ctx.clip();
  const off = -E.inCubic(prog(t, outT, outT + 0.3)) * size * 1.2;
  const put = (k, dy) => {
    dy += off;
    if (draw) { draw(ctx, k, x, y + dy); return; }
    text(ctx, words[k], x, y + dy, { color: colorOf ? colorOf(k) : color, align });
  };
  if (p < 1 && i > 0) put(i - 1, -p * size * 1.2);
  put(i, (1 - p) * size * 1.2);
  ctx.restore();
}

// Text that ends in the It mark instead of the font's full stop. Returns the
// mark's centre and size so the mark can leave the sentence and come back.
function sentenceStop(ctx, s, x, y, size) {
  const w = measure(ctx, s);
  const k = size * 0.155;
  return { x: x + w + size * 0.02 + k / 2, y: y - k / 2, s: k, w: w + size * 0.02 + k };
}

// ---------- controls ----------
function drawButton(ctx, x, y, w, h, label, { fill = C.ink, color = '#fff', size = 26, weight = 600, radius = null, stroke = null, alpha = 1, scale = 1 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (scale !== 1) { ctx.translate(x + w / 2, y + h / 2); ctx.scale(scale, scale); ctx.translate(-(x + w / 2), -(y + h / 2)); }
  const r = radius == null ? h / 2 : radius;
  if (fill) fillRR(ctx, x, y, w, h, r, fill);
  if (stroke) strokeRR(ctx, x + 1, y + 1, w - 2, h - 2, r, stroke, 2);
  setFont(ctx, weight, size, FONT.body, -0.01);
  text(ctx, label, x + w / 2, y + h / 2 + size * 0.36, { color, align: 'center' });
  ctx.restore();
}

// A check mark inside a box of size s at (x, y) (top-left), drawn to progress p.
function drawCheck(ctx, x, y, s, color, lw, p = 1) {
  if (p <= 0) return;
  const pts = [[0.2, 0.52], [0.42, 0.72], [0.8, 0.3]];
  const seg1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const seg2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  const L = (seg1 + seg2) * p;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + pts[0][0] * s, y + pts[0][1] * s);
  if (L <= seg1) {
    const k = L / seg1;
    ctx.lineTo(x + lerp(pts[0][0], pts[1][0], k) * s, y + lerp(pts[0][1], pts[1][1], k) * s);
  } else {
    ctx.lineTo(x + pts[1][0] * s, y + pts[1][1] * s);
    const k = (L - seg1) / seg2;
    ctx.lineTo(x + lerp(pts[1][0], pts[2][0], k) * s, y + lerp(pts[1][1], pts[2][1], k) * s);
  }
  ctx.stroke();
  ctx.restore();
}
// A filled round badge with a check, popping in with k.
function checkBadge(ctx, x, y, r, k, fill = C.ink, mark = '#fff') {
  if (k <= 0) return;
  const s = E.outBack(clamp(k * 1.5));
  circle(ctx, x, y, r * s, fill);
  drawCheck(ctx, x - r * 0.62, y - r * 0.62, r * 1.24, mark, r * 0.2, clamp(k * 1.6 - 0.3));
}

// A tap: press amount at time u for a tap at t0.
const pressAt = (u, t0, d = 0.12) => (u > t0 && u < t0 + d ? Math.sin(((u - t0) / d) * Math.PI) : 0);

// The fingertip travelling along a list of [time, x, y, press?] keys.
function touchPath(ctx, t, keys, { dark = false, taps = [], fadeIn = 0.12, fadeOut = 0.2 } = {}) {
  if (t < keys[0][0] || t > keys[keys.length - 1][0] + fadeOut) return;
  let x = keys[0][1], y = keys[0][2];
  for (let i = 1; i < keys.length; i++) {
    const [ta, xa, ya] = keys[i - 1], [tb, xb, yb] = keys[i];
    if (t >= tb) { x = xb; y = yb; continue; }
    if (t > ta) { const e = E.inOutCubic(prog(t, ta, tb)); x = lerp(xa, xb, e); y = lerp(ya, yb, e); }
    break;
  }
  let press = 0;
  for (const tp of taps) press = Math.max(press, pressAt(t, tp));
  const a = tw(t, keys[0][0], fadeIn) * (1 - tw(t, keys[keys.length - 1][0], fadeOut));
  drawTouch(ctx, x, y, a, press, dark);
}

// ---------- the agent, beside you ----------
// The agent is on the page the way a collaborator is in a shared document: as a
// nameplate on a corner of the page, with a green dot while it is there. What
// you do on the page travels to the plate as a green bead (green is the way
// back, as it is on the site), and the plate lights as it lands. What the agent
// does next it does in the page's own way: a route appears on a map, a piece
// moves on a board, a row is added to a list. Only on a canvas, where a pointer
// is how anyone works, does the plate leave its corner with a pointer and do
// something by hand.
const LIVE_GREEN = '#34d399';
const BEAD = 0.32;   // how long an answer takes to reach the agent
const PLATE = { h: 54, font: 28, scale: 1.14 };   // drawn a little large on the stage, so the name reads at a glance

// Where a point is at time t along [t, x, y] keys, eased from each to the next.
function keyPos(keys, t) {
  let x = keys[0][1], y = keys[0][2];
  for (let i = 1; i < keys.length; i++) {
    const [ta, xa, ya] = keys[i - 1], [tb, xb, yb] = keys[i];
    if (t >= tb) { x = xb; y = yb; continue; }
    if (t > ta) { const e = E.inOutCubic(prog(t, ta, tb)); x = lerp(xa, xb, e); y = lerp(ya, yb, e); }
    break;
  }
  return [x, y];
}
// Where a list of [time, words] has got to: the words now, the words before
// them, and how far the change from one to the other has gone.
function wordsAt(list, t, dur = 0.36) {
  let i = -1;
  for (let k = 0; k < list.length; k++) if (t >= list[k][0]) i = k;
  if (i < 0) return { cur: '', was: '', p: 1 };
  return { cur: list[i][1], was: i > 0 ? list[i - 1][1] : '', p: E.outExpo(prog(t, list[i][0], list[i][0] + dur)) };
}

// The plate's box. (x, y) is the middle of its right-hand end, or of its
// left-hand end where `align` is 'left'.
function plateBox(ctx, x, y, name, { was = null, roll = 1, note = null, busy = 0, scale = 1, align = 'right' } = {}) {
  setFont(ctx, 700, PLATE.font, FONT.body, 0);
  const wn = lerp(measure(ctx, was || name), measure(ctx, name), roll);
  let wt = 0;
  if (note) { setFont(ctx, 600, PLATE.font - 3, FONT.body, 0); wt = lerp(note.was ? measure(ctx, note.was) + 13 : 0, note.cur ? measure(ctx, note.cur) + 13 : 0, note.p); }
  const w = (44 + wn + wt + 44 * busy + 22) * scale, h = PLATE.h * scale, x0 = align === 'right' ? x - w : x;
  return { x0, y0: y - h / 2, w, h, cx: x0 + w / 2, cy: y, wn, wt };
}
// The plate itself.
//   was, roll   the name it is changing from, and how far the change has gone
//   note        { cur, was, p }: words after the name
//   busy        0..1: three dots while it works
//   lit         0..1: green as an answer lands
//   asleep      0..1: its conversation is closed
//   dark        0..1: a white plate, for dark pages
//   done        0..1: the dot becomes a tick
function agentPlate(ctx, x, y, name, o = {}) {
  const { was = null, roll = 1, note = null, busy = 0, lit = 0, asleep = 0, dark = 0, done = 0, alpha = 1, scale = 1, bump = 0, t = 0 } = o;
  const B = plateBox(ctx, x, y, name, o);
  if (alpha <= 0) return B;
  const body = mix(mix(mix(C.ink, '#ffffff', dark), '#70727f', asleep), LIVE_GREEN, lit);
  const fg = mix(mix('#ffffff', C.ink, dark), C.ink, lit), edge = mix('#ffffff', C.ink, dark);
  const k = 1 + 0.07 * lit + 0.09 * bump, h = PLATE.h, w = B.w / scale;
  ctx.save();
  ctx.globalAlpha *= alpha * lerp(1, 0.8, asleep);
  ctx.translate(B.cx, B.cy); ctx.scale(scale * k, scale * k); ctx.translate(-w / 2, -h / 2);
  ctx.save();
  ctx.shadowColor = 'rgba(20,12,6,0.26)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 7;
  fillRR(ctx, 0, 0, w, h, h / 2, body);
  ctx.restore();
  strokeRR(ctx, 0, 0, w, h, h / 2, edge, 2.5);
  if (done > 0) checkBadge(ctx, 24, h / 2, 12, done, C.mint, '#fff');
  else circle(ctx, 24, h / 2, 7.5, mix(mix(LIVE_GREEN, '#ffffff', lit), '#b4b5bf', asleep));
  // The words, which roll inside the plate when they change.
  ctx.save();
  rr(ctx, 2, 2, w - 4, h - 4, h / 2 - 2); ctx.clip();
  const base = h / 2 + 10;
  setFont(ctx, 700, PLATE.font, FONT.body, 0);
  if (was && roll < 1) text(ctx, was, 44, base - roll * h, { color: fg, alpha: 1 - roll });
  text(ctx, name, 44, base + (was ? (1 - roll) * h : 0), { color: fg });
  if (note) {
    setFont(ctx, 600, PLATE.font - 3, FONT.body, 0);
    const nx = 44 + B.wn + 13, soft = rgba(fg, 0.74);
    if (note.was && note.p < 1) text(ctx, note.was, nx, base - 1 - note.p * h, { color: soft, alpha: 1 - note.p });
    if (note.cur) text(ctx, note.cur, nx, base - 1 + (1 - note.p) * h, { color: soft });
  }
  if (busy > 0) {
    for (let i = 0; i < 3; i++) {
      const u = Math.max(0, Math.sin(t * 9 - i * 0.9));
      circle(ctx, 44 + B.wn + B.wt + 15 + i * 12, h / 2 + 1 - 5 * u, 3.6, rgba(fg, busy * (0.55 + 0.45 * u)));
    }
  }
  ctx.restore();
  ctx.restore();
  return B;
}

// The agent's pointer, tip at (x, y), for the pages where it works by hand.
function agentPointer(ctx, x, y, { alpha = 1, dark = 0, press = 0 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  const k = 1.3 * (1 - 0.14 * press);
  ctx.scale(k, k);
  ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 46); ctx.lineTo(12.5, 34.5); ctx.lineTo(22, 53); ctx.lineTo(29.5, 49); ctx.lineTo(20, 31); ctx.lineTo(36, 31); ctx.closePath();
  ctx.fillStyle = mix(C.ink, '#ffffff', dark); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = mix('#ffffff', C.ink, dark); ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
}
// Where the plate hangs from the pointer's tip.
const HAND = { dx: 36, dy: 62 };

// Your answer on its way back to the agent.
function returnBead(ctx, t, t0, from, to, { dur = BEAD, size = 1 } = {}) {
  const p = prog(t, t0, t0 + dur);
  if (p <= 0 || p >= 1) return;
  const e = E.inOutCubic(p);
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const mid = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - Math.min(90, d * 0.3)];
  for (let k = 5; k >= 0; k--) {
    const [x, y] = qpt(from, mid, to, clamp(e - k * 0.05));
    ctx.save();
    ctx.globalAlpha *= k ? 0.5 * (1 - k / 6) : 1;
    if (!k) circle(ctx, x, y, 19 * size, '#ffffff');
    circle(ctx, x, y, (14.5 - k * 1.6) * size, LIVE_GREEN);
    ctx.restore();
  }
}
// How brightly a plate is lit at time t by answers that left you at these times.
function litBy(times, t, dur = BEAD) {
  let lit = 0;
  for (const th of times) if (t >= th + dur) lit = Math.max(lit, Math.exp(-(t - th - dur) * 4.5));
  return lit;
}

// One agent's part, on the screen's own coordinates.
//   names   [[t, name], ...]: whose plate it is, from each time on
//   at      (t) => [x, y]: where the plate sits, by the middle of its right-hand end
//   in, out when it comes and goes
//   heard   [[t, x, y], ...]: moments something you did sets off for it, and from where
//   busy    [[t0, t1], ...]: while it is working
//   beats   [t, ...]: moments it does something worth a nod
//   notes   [[t, words], ...]: what it says after its name
//   done    when its dot becomes a tick
//   dark    (t) => 0..1: over a dark page
//   asleep  [[t0, t1], ...]: its conversation is closed between these times
//   hands   [{ keys: [[t, x, y], ...], track, clicks }, ...]: on a canvas, where
//           its pointer goes; the plate leaves its corner for the first key and
//           comes back after the last
function agentShow(ctx, t, A) {
  if (t < A.in || t > A.out + 0.3) return;
  const alpha = tw(t, A.in, 0.3, E.outCubic) * (1 - tw(t, A.out, 0.24, E.inCubic));
  const N = wordsAt(A.names, t), note = A.notes ? wordsAt(A.notes, t) : null;
  let busy = 0, asleep = 0, bump = 0, woke = null;
  for (const [a, b] of A.busy || []) busy = Math.max(busy, tw(t, a, 0.18, E.outCubic) * (1 - tw(t, b, 0.18, E.inCubic)));
  for (const [a, b] of A.asleep || []) { asleep = Math.max(asleep, tw(t, a, 0.3, E.outCubic) * (1 - tw(t, b, 0.3, E.outCubic))); woke = b; }
  for (const b of A.beats || []) if (t >= b) bump = Math.max(bump, Math.exp(-(t - b) * 9));
  const dark = A.dark ? A.dark(t) : 0;
  const o = { was: N.was || null, roll: N.p, note, busy, asleep, dark, bump, t, alpha, scale: PLATE.scale, done: A.done != null ? prog(t, A.done, A.done + 0.3) : 0 };
  let [x, y] = A.at(t);
  // On a canvas, the plate goes with the pointer.
  let hand = 0, press = 0, tip = null;
  for (const Hd of A.hands || []) {
    const k0 = Hd.keys[0][0], k1 = Hd.keys[Hd.keys.length - 1][0];
    const g = E.inOutCubic(prog(t, k0 - 0.26, k0)) * (1 - E.inOutCubic(prog(t, k1, k1 + 0.32)));
    if (g <= 0) continue;
    const [hx, hy] = (Hd.track && Hd.track(t)) || keyPos(Hd.keys, t);
    const B0 = plateBox(ctx, 0, 0, N.cur, o);
    x = lerp(x, hx + HAND.dx + B0.w, g); y = lerp(y, hy + HAND.dy + B0.h / 2, g);
    hand = g;
    for (const c of Hd.clicks || []) press = Math.max(press, pressAt(t, c, 0.16));
    tip = Hd;
  }
  const B = plateBox(ctx, x, y, N.cur, o);
  const px = B.x0 - HAND.dx, py = B.y0 - HAND.dy;
  for (const [th] of A.heard || []) drawRipple(ctx, B.cx, B.cy, t, th + BEAD, LIVE_GREEN, 96, 0.5);
  if (woke != null) drawRipple(ctx, B.cx, B.cy, t, woke + 0.03, LIVE_GREEN, 150, 0.7);
  if (tip) for (const c of tip.clicks || []) drawRipple(ctx, px, py, t, c + 0.02, mix(C.ink, '#ffffff', dark), 70, 0.42);
  agentPlate(ctx, x, y, N.cur, { ...o, lit: litBy((A.heard || []).map((q) => q[0]), t) });
  agentPointer(ctx, px, py, { alpha: alpha * hand, dark, press });
  for (const [th, fx, fy] of A.heard || []) returnBead(ctx, t, th, [fx, fy], [B.cx, B.cy]);
}
// Every agent part in the film, so the sound can find when each answer lands.
const AGENT_PARTS = [];
const agentPart = (A) => { AGENT_PARTS.push(A); return A; };
function agentCues() {
  const heard = [];
  for (const A of AGENT_PARTS) for (const h of A.heard || []) heard.push(h[0] + (A.bead ?? BEAD));
  return { heard: heard.sort((a, b) => a - b) };
}

// ════ home.js ════
// The "Mornings" homepage the agent designed three ways, drawn for any box.
// `build` (0..1) assembles version B piece by piece, the way a live preview
// fills in while the agent works.

function coffeeBag(ctx, x, y, w, h, body = '#2b1d16', label = '#f3e2cf', ink = '#2b1d16') {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + w * 0.08, y + h * 0.1);
  ctx.lineTo(x + w * 0.92, y + h * 0.1);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = body; ctx.fill();
  fillRR(ctx, x + w * 0.06, y, w * 0.88, h * 0.13, h * 0.03, body);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + w * 0.06, y + h * 0.13, w * 0.88, h * 0.015);
  fillRR(ctx, x + w * 0.2, y + h * 0.42, w * 0.6, h * 0.32, h * 0.03, label);
  // Sized to stay inside the bag's label.
  setFont(ctx, 800, w * 0.098, FONT.disp, -0.02);
  text(ctx, 'MORNINGS', x + w / 2, y + h * 0.565, { color: ink, align: 'center' });
  fillRR(ctx, x + w * 0.32, y + h * 0.63, w * 0.36, h * 0.025, h * 0.01, rgba(ink, 0.5));
  ctx.restore();
}

function drawHome(ctx, x, y, w, h, style, { radius = 0, build = 1 } = {}) {
  const u = w / 100;
  const B = (a, d = 0.12) => E.outCubic(clamp((build - a) / d));
  ctx.save();
  rr(ctx, x, y, w, h, radius);
  ctx.clip();
  if (style === 'A') {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#f6ecdf'); g.addColorStop(1, '#e7d2b8');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    setFont(ctx, 800, 3.2 * u, FONT.disp, -0.02);
    text(ctx, 'Mornings', x + w / 2, y + 6.2 * u, { color: '#2b1d16', align: 'center' });
    setFont(ctx, 700, 7.4 * u, FONT.disp, -0.035);
    text(ctx, 'Brew better mornings.', x + w / 2, y + 19 * u, { color: '#2b1d16', align: 'center' });
    setFont(ctx, 500, 2.4 * u, FONT.body, 0);
    text(ctx, 'Small-batch coffee, roasted every week.', x + w / 2, y + 24.5 * u, { color: 'rgba(43,29,22,0.65)', align: 'center' });
    drawButton(ctx, x + w / 2 - 9 * u, y + 28 * u, 18 * u, 5.4 * u, 'Order now', { fill: '#1b1411', size: 2.2 * u });
    coffeeBag(ctx, x + w / 2 - 9 * u, y + h - 26 * u, 18 * u, 26 * u);
  } else if (style === 'C') {
    ctx.fillStyle = '#0f0d0c'; ctx.fillRect(x, y, w, h);
    setFont(ctx, 700, 2.6 * u, FONT.disp, -0.02);
    text(ctx, 'Mornings', x + 4 * u, y + 5.5 * u, { color: '#fff' });
    setFont(ctx, 500, 2.2 * u, FONT.body, 0);
    ['Shop', 'Pricing', 'Journal'].forEach((s, i) => text(ctx, s, x + w - 4 * u - (2 - i) * 11 * u, y + 5.5 * u, { color: i === 1 ? '#ffb27a' : 'rgba(255,255,255,0.7)', align: 'right' }));
    setFont(ctx, 900, 15.5 * u, FONT.disp, -0.06);
    text(ctx, 'BREW', x + 3 * u, y + 25 * u, { color: '#fff' });
    text(ctx, 'BETTER.', x + 3 * u, y + 39 * u, { color: '#fff' });
    const cols = ['#6b3b22', '#a55a2a', '#d88a4a', '#3d2417'];
    for (let i = 0; i < 4; i++) fillRR(ctx, x + (3 + i * 24) * u, y + h - 17 * u, 22 * u, 13 * u, 1.2 * u, cols[i]);
    circle(ctx, x + 14 * u, y + h - 10.5 * u, 2.4 * u, 'rgba(255,255,255,0.85)');
  } else {
    // B: split, with a tilted phone and a coral accent.
    ctx.fillStyle = '#fbf5ef'; ctx.fillRect(x, y, w, h);
    const coral = '#f0664f';
    const a0 = B(0.0);
    ctx.globalAlpha = a0;
    setFont(ctx, 800, 2.8 * u, FONT.disp, -0.02);
    text(ctx, 'Mornings', x + 5 * u, y + 5.6 * u, { color: '#2a1a14' });
    setFont(ctx, 500, 1.9 * u, FONT.body, 0);
    let nx = x + 50 * u;
    for (const s of ['Shop', 'Subscriptions', 'Journal']) { text(ctx, s, nx, y + 5.4 * u, { color: 'rgba(42,26,20,0.6)' }); nx += measure(ctx, s) + 3.4 * u; }
    fillRR(ctx, x + w - 15 * u, y + 2.6 * u, 10 * u, 4 * u, 2 * u, '#2a1a14');
    setFont(ctx, 600, 1.7 * u, FONT.body, 0);
    text(ctx, 'Sign in', x + w - 10 * u, y + 5.2 * u, { color: '#fff', align: 'center' });
    ctx.globalAlpha = 1;
    // Headline, typed in as it builds.
    const hl = ['Brew better', 'mornings.'];
    setFont(ctx, 800, 7.6 * u, FONT.disp, -0.04);
    const tb = clamp((build - 0.12) / 0.3);
    const total = hl.join('').length;
    let n = Math.round(tb * total);
    hl.forEach((s, i) => {
      const k = Math.min(n, s.length); n -= k;
      if (k > 0) text(ctx, s.slice(0, k), x + 5 * u, y + (19 + i * 8.2) * u, { color: i === 1 ? coral : '#2a1a14' });
    });
    const a1 = B(0.45);
    if (a1 > 0) {
      ctx.globalAlpha = a1;
      setFont(ctx, 500, 2.3 * u, FONT.body, 0);
      text(ctx, 'Small-batch coffee, roasted every week', x + 5 * u, y + (34 + (1 - a1) * 2) * u, { color: 'rgba(42,26,20,0.66)' });
      text(ctx, 'and at your door by Friday.', x + 5 * u, y + (37.4 + (1 - a1) * 2) * u, { color: 'rgba(42,26,20,0.66)' });
      ctx.globalAlpha = 1;
    }
    const a2 = B(0.58, 0.1);
    if (a2 > 0) {
      const s2 = E.outBack(a2);
      drawButton(ctx, x + 5 * u, y + 42 * u, 15 * u, 5.4 * u, 'Order now', { fill: coral, size: 2.1 * u, scale: s2, alpha: a2 });
      drawButton(ctx, x + 21.5 * u, y + 42 * u, 14 * u, 5.4 * u, 'Our beans', { fill: null, stroke: '#2a1a14', color: '#2a1a14', size: 2.1 * u, scale: s2, alpha: a2 });
    }
    // The phone slides up and tilts in.
    const a3 = B(0.7, 0.2);
    if (a3 > 0) {
      ctx.save();
      const pcx = x + 73 * u, pcy = y + h * 0.56 + (1 - a3) * 20 * u;
      circle(ctx, x + 74 * u, y + h * 0.5, 22 * u * a3, 'rgba(240,102,79,0.16)');
      ctx.translate(pcx, pcy); ctx.rotate(-0.16 * a3);
      ctx.shadowColor = 'rgba(60,20,10,0.25)'; ctx.shadowBlur = 5 * u; ctx.shadowOffsetY = 2 * u;
      fillRR(ctx, -10 * u, -20 * u, 20 * u, 40 * u, 3.2 * u, '#1b1411');
      ctx.shadowColor = 'transparent';
      fillRR(ctx, -9 * u, -19 * u, 18 * u, 38 * u, 2.5 * u, coral);
      coffeeBag(ctx, -5 * u, -12 * u, 10 * u, 14 * u, '#2a1a14', '#ffe6d6');
      fillRR(ctx, -6.5 * u, 7 * u, 13 * u, 3.4 * u, 1.7 * u, '#fff');
      setFont(ctx, 700, 1.6 * u, FONT.body, 0);
      text(ctx, 'Reorder', 0, 9.3 * u, { color: coral, align: 'center' });
      ctx.restore();
    }
  }
  ctx.restore();
}

// ════ stage.js ════
// The stage: one card that lives through the middle of the film. It starts as
// the full stop of "it.", opens into whatever the agent needs, closes back into
// a full stop, and flies to the end of the next sentence before opening again.
// Its whole life is a list of moves (MOVES); each move starts from wherever the
// previous one had the card at that moment.

const CARD_R = 34;
// A pose: centre, size, corner radius, fill, and the content it shows.
const P = (x, y, w, h, extra = {}) => ({ x, y, w, h, r: CARD_R, fill: C.card, kind: null, k: 0, t0: 0, ...extra });
const stopPose = (x, y, s) => ({ x, y, w: s, h: s, r: 0, fill: C.ink, kind: null, k: 0, t0: 0, stop: true });

// A card's life as a list of moves. The stage has one (MOVES); other scenes can make their own.
class CardTrack {
  constructor() { this.moves = []; }
  add(m) { const prev = this.moves[this.moves.length - 1]; m.from = prev ? evalMove(prev, m.t) : m.to; this.moves.push(m); return this; }
  at(t) { let m = null; for (const x of this.moves) { if (x.t <= t) m = x; else break; } return m ? evalMove(m, t) : null; }
}
const STAGE = new CardTrack();
const MOVES = STAGE.moves;
// Things register how to draw themselves: THING[kind] = { w, h, draw(ctx, w, h, lt, t) }.
const THING = {};

function evalMove(m, t) {
  const F = m.from;
  switch (m.kind) {
    case 'hold': return { ...m.to, pulse: m.pulse };
    case 'open': {
      const T = m.to, s = spring(t, m.t, m.f ?? 1.7, m.z ?? 0.74), g = clamp(s);
      return {
        x: lerp(F.x, T.x, s), y: lerp(F.y, T.y, s), w: Math.max(F.w, lerp(F.w, T.w, s)), h: Math.max(F.h, lerp(F.h, T.h, s)),
        r: lerp(0, T.r, g), fill: mix(C.ink, T.fill, prog(Math.min(lerp(F.w, T.w, s), lerp(F.h, T.h, s)), F.w + 10, F.w + 90)),
        kind: T.kind, k: prog(t, m.t + 0.18, m.t + 0.4), t0: m.t, open: g,
      };
    }
    case 'close': {
      const e = (m.ease ?? E.inBack)(prog(t, m.t, m.t + m.d)), T = m.to;
      return {
        x: lerp(F.x, T.x, e), y: lerp(F.y, T.y, e), w: Math.max(T.w, lerp(F.w, T.w, e)), h: Math.max(T.h, lerp(F.h, T.h, e)),
        r: lerp(F.r, 0, clamp(e)), fill: mix(F.fill, C.ink, 1 - prog(Math.min(lerp(F.w, T.w, e), lerp(F.h, T.h, e)), T.w + 10, T.w + 90)),
        kind: F.kind, k: F.k * (1 - prog(t, m.t, m.t + 0.1)), t0: F.t0, stop: e > 0.97,
      };
    }
    case 'fly': {
      const e = E.inOutCubic(prog(t, m.t, m.t + m.d)), T = m.to;
      const lift = Math.sin(e * Math.PI) * (m.arc ?? 120);
      return { ...T, x: lerp(F.x, T.x, e), y: lerp(F.y, T.y, e) - lift, w: lerp(F.w, T.w, e), h: lerp(F.h, T.h, e) };
    }
    case 'morph': {
      const T = m.to, s = spring(t, m.t, m.f ?? 2.3, m.z ?? 0.66);
      return {
        x: lerp(F.x, T.x, s), y: lerp(F.y, T.y, s), w: lerp(F.w, T.w, s), h: lerp(F.h, T.h, s), r: lerp(F.r, T.r, clamp(s)),
        fill: mix(F.fill, T.fill, prog(t, m.t, m.t + 0.2)),
        kind: T.kind, k: prog(t, m.t + (m.inA ?? 0.1), m.t + (m.inB ?? 0.26)), t0: m.t,
        prev: F.kind ? { kind: F.kind, k: 1 - prog(t, m.t - 0.04, m.t + 0.08), t0: F.t0 } : null, open: 1,
      };
    }
  }
}
const addMove = (m) => STAGE.add(m);
const cardAt = (t) => STAGE.at(t);

function drawContent(ctx, pose, kind, k, t0, t) {
  const T = typeof kind === 'object' ? kind : THING[kind];
  if (!T || k <= 0) return;
  ctx.save();
  ctx.globalAlpha *= k;
  // Content keeps its own layout and scales with the card as it opens.
  const sc = Math.min(pose.w / T.w, pose.h / T.h);
  ctx.translate(pose.x, pose.y);
  ctx.scale(sc, sc);
  ctx.translate(-T.w / 2, -T.h / 2);
  T.draw(ctx, T.w, T.h, t - t0, t);
  ctx.restore();
}
function drawCard(ctx, t, pose) {
  if (!pose) return;
  const { x, y, w, h } = pose;
  if (pose.stop || w < 34) {
    const pl = pose.pulse ? pose.pulse(t) : 1;
    stopMark(ctx, x, y, w * pl, pose.fill);
    return;
  }
  ctx.save();
  if (w > 120) cardShadow(ctx, x - w / 2, y - h / 2, w, h, pose.r, clamp((w - 120) / 300));
  fillRR(ctx, x - w / 2, y - h / 2, w, h, pose.r, pose.fill);
  rr(ctx, x - w / 2, y - h / 2, w, h, pose.r);
  ctx.clip();
  if (pose.prev) drawContent(ctx, pose, pose.prev.kind, pose.prev.k, pose.prev.t0, t);
  drawContent(ctx, pose, pose.kind, pose.k, pose.t0, t);
  ctx.restore();
}

// Warm paper, lit from above.
let _paper = null;
function paper(ctx, color = C.paper) {
  if (!_paper) {
    _paper = document.createElement('canvas'); _paper.width = W; _paper.height = H;
    const g = _paper.getContext('2d');
    const rad = g.createRadialGradient(CX, -200, 100, CX, -200, 1500);
    rad.addColorStop(0, 'rgba(255,255,255,0.55)'); rad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rad; g.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(_paper, 0, 0);
}

// ════ scene-chat.js ════
// Act one: the agent has made three versions of a homepage and can only
// describe them in words. The user types "can I just see it?", and the "it?"
// lifts out of the message. On the downbeat the question mark unwinds into a
// full stop, and the full stop opens into a bright room: it.

const PROMPT = 'can I just see it?';
const PROMPT_BREAK = 11;   // "can I just " then a beat
const S1 = {
  fade: 0.45, streamA: 0.28, streamB: 3.4,
  typeA1: 3.8, typeB1: 4.55, typeA2: 4.85, typeB2: 5.62,
  send: bar(2, 3), fly: bar(2, 3) + 0.05,
  push: bar(3), lift: bar(3, 1.3), liftEnd: bar(3, 2.8),
  snap: bar(4), bloomEnd: bar(4) + 0.5,
};
Film.shake(S1.snap, 0.35, 9, 24);
Film.boost(S1.fly - 0.05, S1.fly + 0.5, 12);
Film.boost(S1.lift, S1.liftEnd, 12);
Film.boost(S1.snap - 0.05, S1.bloomEnd, 24);

// Graphite, the palette of a real dark-mode app.
const D1 = {
  bgTop: '#111112', bgBot: '#060607', win: '#1b1b1d', winEdge: 'rgba(255,255,255,0.11)', bar: '#1f1f22', side: '#171719',
  ink: '#ededef', ink2: '#a1a1a7', ink3: '#636369', bubble: '#2c2c30', field: '#222225', fieldEdge: 'rgba(255,255,255,0.09)',
  word: '#d6d6db', strong: '#ffffff',
};
// The window, in world units that the camera maps to the screen.
const WIN = { x: 160, y: 40, w: 1600, h: 1000, bar: 78, side: 330, r: 30 };
const COL = { x0: WIN.x + WIN.side + 96, x1: WIN.x + WIN.w - 96 };
const MX = (COL.x0 + COL.x1) / 2;
const COMP = { w: COL.x1 - COL.x0, h: 104, font: 34, y: WIN.y + WIN.h - 40 - 52 };
const VIEW = { top: WIN.y + WIN.bar, bottom: COMP.y - 52 - 30 };
const REPLY = { font: 34, lh: 54, para: 28, top: 300 };

// A typist's rhythm: quick runs inside a word, a beat at each space, a reach for shifted keys.
function typist(str, a, b, from = 0, to = str.length, seed = 4.1) {
  const d = [];
  for (let i = from; i < to; i++) {
    const c = str[i], prev = str[i - 1], x = Math.sin(i * 12.9898 + seed) * 43758.5453, h = x - Math.floor(x);
    const shifted = c === '?' || c !== c.toLowerCase();
    d.push((c === ' ' ? 1.35 : shifted ? 1.6 : prev === ' ' ? 1.5 : 1) * (0.72 + 0.56 * h));
  }
  const sum = d.reduce((s, v) => s + v, 0) - d[0], out = [];
  let t = a;
  d.forEach((v, k) => { if (k) t += ((b - a) * v) / sum; out.push(t); });
  return out;
}
const TYPE_T = [
  ...typist(PROMPT, S1.typeA1 + 0.03, S1.typeB1, 0, PROMPT_BREAK),
  ...typist(PROMPT, S1.typeA2 + 0.03, S1.typeB2, PROMPT_BREAK, PROMPT.length),
];
const countUpTo = (T, t) => { let n = 0; while (n < T.length && T[n] <= t) n++; return n; };
function typeTimes() { return TYPE_T.slice(); }

// ---------- the reply ----------
const REPLY_TEXT = [
  [['I made three versions of your homepage.', 600]],
  [['Version A', 600], [' is calm and centred: a large headline over a soft sand gradient, the product photo underneath and a single black button.', 400]],
  [['Version B', 600], [' is split in two: the headline and two buttons on the left, a tilted phone on the right and a warm coral accent.', 400]],
  [['Version C', 600], [' is bold and editorial: an oversized headline that runs edge to edge, a looping video strip, and the pricing link moved up into the nav.', 400]],
  [['Which one should I build: A, B or C?', 400]],
];
const RW = [];          // words: {w, x, y, weight, t}
const RL = [];          // line bottoms with the time each appears
let REPLY_END = 0;
Film.init((ctx) => {
  let y = REPLY.top;
  for (const para of REPLY_TEXT) {
    let x = COL.x0;
    for (const [s, weight] of para) {
      setFont(ctx, weight, REPLY.font, FONT.body, -0.005);
      const sp = measure(ctx, ' ');
      for (const w of s.split(' ')) {
        if (!w) continue;
        const ww = measure(ctx, w);
        if (x > COL.x0 && x + ww > COL.x1) { RL.push({ bottom: y + REPLY.lh * 0.35 }); y += REPLY.lh; x = COL.x0; }
        RW.push({ w, x, y, width: ww, weight, line: RL.length });
        x += ww + sp;
      }
    }
    RL.push({ bottom: y + REPLY.lh * 0.35 });
    y += REPLY.lh + REPLY.para;
  }
  REPLY_END = y - REPLY.para;
  const n = RW.length;
  RW.forEach((Wd, k) => { Wd.t = S1.streamA + (S1.streamB - S1.streamA) * Math.pow(k / n, 1 / 1.5); });
  for (const Wd of RW) { const L = RL[Wd.line]; if (L.t === undefined || Wd.t < L.t) L.t = Wd.t; }
});
// The newest line's bottom, eased as each line arrives.
function replyBottom(t) {
  let b = REPLY.top - REPLY.lh;
  for (const L of RL) { if (L.t === undefined || t < L.t) break; b = lerp(b, L.bottom, E.outCubic(clamp((t - L.t) / 0.14))); }
  return b;
}
// The sent message sits under the reply; the thread scrolls to keep the newest thing in view.
const BUBBLE = { h: 80, gap: 70 };
const bubbleY = () => REPLY_END + BUBBLE.gap + BUBBLE.h / 2;
function contentBottom(t) {
  const sent = E.inOutCubic(prog(t, S1.fly, S1.fly + 0.45));
  return lerp(replyBottom(t), bubbleY() + BUBBLE.h / 2, sent);
}
const scrollAt = (t) => Math.max(0, contentBottom(t) + 40 - (VIEW.bottom - VIEW.top));

// ---------- camera ----------
const zlerp = (a, b, e) => Math.exp(lerp(Math.log(a), Math.log(b), e));
function camMix(A, B, e) { return { x: lerp(A.x, B.x, e), y: lerp(A.y, B.y, e), z: zlerp(A.z, B.z, e) }; }
// Where "it?" sits in the sent message, in world units.
function itWorld(ctx, t) {
  setFont(ctx, 450, COMP.font, FONT.body, -0.008);
  const full = measure(ctx, PROMPT), head = measure(ctx, 'can I just see ');
  const bw = full + 64, x1 = COL.x1;
  const y = VIEW.top + bubbleY() - scrollAt(t);
  return { x: x1 - bw + 32 + head, y: y + COMP.font * 0.36, bx: x1 - bw, bw, by: y, size: COMP.font, itW: measure(ctx, 'it?') };
}
let _it0 = null;
function cam1(ctx, t) {
  const open = (u) => ({ x: MX - 30, y: 470 + 70 * E.inOutSine(clamp(u / 3.4)), z: zlerp(1.34, 1.18, E.inOutSine(clamp(u / 3.4))) });
  const typing = { x: CX + 120, y: 590, z: 1.1 };
  if (t < 3.3) return open(t);
  if (t < S1.push) return camMix(open(3.3), typing, E.inOutCubic(prog(t, 3.3, 4.1)));
  const P = itWorld(ctx, t);
  const close = { x: P.x + P.itW * 0.5, y: P.by, z: 2.5 };
  return camMix(typing, close, E.inOutCubic(prog(t, S1.push, S1.lift + 0.25)));
}

// ---------- drawing ----------
// `acc` fades the plus and the send button, `textX` moves the words, and `paper`
// gives it the softer shadow of a thing lying on paper (all three for the finale).
function composer(ctx, x, y, w, h, { font = 34, msg = PROMPT, chars = msg.length, caret = true, solid = false, t = 0, sendPress = 0, mode = 'send', placeholder = 'Reply to your agent…', alpha = 1, acc = 1, textX = null, paper = false } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (paper) { ctx.shadowColor = 'rgba(40,24,12,0.30)'; ctx.shadowBlur = h * 0.5; ctx.shadowOffsetY = h * 0.18; }
  else { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = h * 0.45; ctx.shadowOffsetY = h * 0.14; }
  fillRR(ctx, x - w / 2, y - h / 2, w, h, h / 2, D1.field);
  ctx.shadowColor = 'transparent';
  strokeRR(ctx, x - w / 2 + 0.75, y - h / 2 + 0.75, w - 1.5, h - 1.5, h / 2, D1.fieldEdge, 1.5);
  if (acc > 0) {
    ctx.save();
    ctx.globalAlpha *= acc;
    const ax = x - w / 2 + h * 0.52, ar = h * 0.27;
    ring(ctx, ax, y, ar, 'rgba(255,255,255,0.14)', Math.max(1, h * 0.018));
    ctx.strokeStyle = D1.ink2; ctx.lineWidth = h * 0.026; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ax - ar * 0.42, y); ctx.lineTo(ax + ar * 0.42, y); ctx.moveTo(ax, y - ar * 0.42); ctx.lineTo(ax, y + ar * 0.42); ctx.stroke();
    ctx.restore();
  }
  const tx = textX ?? x - w / 2 + h * 1.02, base = y + font * 0.36;
  setFont(ctx, 450, font, FONT.body, -0.008);
  const s = msg.slice(0, chars);
  if (s.length) text(ctx, s, tx, base, { color: D1.ink });
  else text(ctx, placeholder, tx, base, { color: D1.ink3 });
  if (caret && (solid || Math.floor(t * 2.2) % 2 === 0)) {
    const cw = s.length ? measure(ctx, s) : 0;
    fillRR(ctx, tx + cw + font * 0.06, y - font * 0.56, Math.max(2, font * 0.07), font * 1.12, 1, '#f5f5f7');
  }
  if (acc > 0) {
    ctx.save();
    ctx.globalAlpha *= acc;
    const bx = x + w / 2 - h * 0.52, br = h * 0.33 * (1 - 0.12 * sendPress);
    const on = mode === 'stop' || chars > 0;
    circle(ctx, bx, y, br, on ? '#f4f4f6' : '#343438');
    if (mode === 'stop') {
      fillRR(ctx, bx - br * 0.3, y - br * 0.3, br * 0.6, br * 0.6, br * 0.08, '#111');
    } else {
      ctx.strokeStyle = on ? '#111' : '#6a6a70'; ctx.lineWidth = br * 0.16; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(bx, y + br * 0.4); ctx.lineTo(bx, y - br * 0.42); ctx.moveTo(bx - br * 0.36, y - br * 0.08); ctx.lineTo(bx, y - br * 0.44); ctx.lineTo(bx + br * 0.36, y - br * 0.08); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

let _bg1 = null;
function backdrop(ctx) {
  if (!_bg1) {
    _bg1 = document.createElement('canvas'); _bg1.width = W; _bg1.height = H;
    const g = _bg1.getContext('2d');
    const lin = g.createLinearGradient(0, 0, 0, H);
    lin.addColorStop(0, D1.bgTop); lin.addColorStop(1, D1.bgBot);
    g.fillStyle = lin; g.fillRect(0, 0, W, H);
    const rad = g.createRadialGradient(CX, -120, 60, CX, -120, 1300);
    rad.addColorStop(0, 'rgba(255,255,255,0.06)'); rad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rad; g.fillRect(0, 0, W, H);
  }
  ctx.drawImage(_bg1, 0, 0);
}

function chatWindow(ctx, t) {
  const tf = frameTime(t);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 90; ctx.shadowOffsetY = 40;
  fillRR(ctx, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r, D1.win);
  ctx.shadowColor = 'transparent';
  ctx.save(); rr(ctx, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r); ctx.clip();
  ctx.fillStyle = D1.side; ctx.fillRect(WIN.x, WIN.y, WIN.side, WIN.h);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(WIN.x + WIN.side, WIN.y, 1.5, WIN.h);
  ctx.fillStyle = D1.bar; ctx.fillRect(WIN.x + WIN.side + 1.5, WIN.y, WIN.w - WIN.side, WIN.bar);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(WIN.x + WIN.side, WIN.y + WIN.bar, WIN.w - WIN.side, 1.5);
  ctx.restore();
  for (let k = 0; k < 3; k++) circle(ctx, WIN.x + 42 + k * 30, WIN.y + WIN.bar / 2, 8.5, '#3c3c40');
  setFont(ctx, 500, 25, FONT.body, 0);
  ['Homepage redesign', 'Pricing page copy', 'Launch checklist', 'Onboarding emails', 'Q4 roadmap', 'Fix mobile nav'].forEach((c, k) => {
    const y = WIN.y + WIN.bar + 72 + k * 60;
    if (k === 0) fillRR(ctx, WIN.x + 18, y - 38, WIN.side - 36, 54, 12, 'rgba(255,255,255,0.07)');
    text(ctx, c, WIN.x + 40, y, { color: k === 0 ? D1.ink : D1.ink3 });
  });
  setFont(ctx, 550, 26, FONT.body, 0);
  text(ctx, 'Homepage redesign', MX, WIN.y + WIN.bar / 2 + 9, { color: D1.ink2, align: 'center' });

  // The thread, scrolled so the newest thing stays in view.
  const sc = scrollAt(t);
  ctx.save();
  ctx.beginPath(); ctx.rect(WIN.x + WIN.side + 2, VIEW.top + 2, WIN.w - WIN.side - 4, COMP.y - 52 - 14 - VIEW.top);
  ctx.clip();
  ctx.translate(0, VIEW.top - sc);
  // The earlier request.
  setFont(ctx, 450, 30, FONT.body, -0.008);
  const q0 = 'Can you redo the homepage? Something fresher.';
  const qw = measure(ctx, q0) + 60;
  fillRR(ctx, COL.x1 - qw, 70, qw, 72, 36, D1.bubble);
  text(ctx, q0, COL.x1 - qw + 30, 116, { color: D1.ink });
  // The agent.
  const ay = 214;
  circle(ctx, COL.x0 + 22, ay, 22, '#2e2e33');
  ring(ctx, COL.x0 + 22, ay, 21, 'rgba(255,255,255,0.12)', 1.5);
  circle(ctx, COL.x0 + 22, ay, 7, '#f1f1f3');
  setFont(ctx, 600, 28, FONT.body, 0);
  text(ctx, 'Agent', COL.x0 + 62, ay + 10, { color: D1.ink });
  // The reply, word by word.
  let font = '', last = null;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const Wd of RW) {
    if (Wd.t > t) break;
    const f = `${Wd.weight} ${REPLY.font}px ${FONT.body}`;
    if (f !== font) { ctx.font = f; ctx.letterSpacing = '-0.17px'; font = f; }
    ctx.globalAlpha = clamp((t - Wd.t) / 0.1);
    ctx.fillStyle = Wd.weight > 500 ? D1.strong : D1.word;
    ctx.fillText(Wd.w, Wd.x, Wd.y);
    if (Wd.t <= tf) last = Wd;
  }
  ctx.globalAlpha = 1;
  if (last && t < S1.streamB + 0.15) circle(ctx, last.x + last.width + 16, last.y - REPLY.font * 0.34, 8, `rgba(245,245,247,${0.6 + 0.4 * Math.sin(t * 18)})`);
  // The message, lifting out of the field into the thread.
  if (t >= S1.send) {
    const fly = E.outExpo(prog(t, S1.fly, S1.fly + 0.5));
    setFont(ctx, 450, COMP.font, FONT.body, -0.008);
    const full = measure(ctx, PROMPT), bw = full + 64;
    const by = bubbleY();
    const fromX = COL.x0 + COMP.h * 1.02, toX = COL.x1 - bw + 32;
    const fromY = COMP.y + sc - VIEW.top;
    const tx = lerp(fromX, toX, fly), ty = lerp(fromY, by, fly);
    fillRR(ctx, COL.x1 - bw, by - BUBBLE.h / 2 + (1 - fly) * 30, bw, BUBBLE.h, BUBBLE.h / 2, rgba(D1.bubble, clamp(fly * 1.6)));
    // Once "it?" has lifted away, only "can I just see" is left behind.
    const s = t >= S1.lift ? 'can I just see' : PROMPT;
    text(ctx, s, tx, ty + COMP.font * 0.36, { color: D1.ink });
  }
  ctx.restore();

  strokeRR(ctx, WIN.x + 0.75, WIN.y + 0.75, WIN.w - 1.5, WIN.h - 1.5, WIN.r, D1.winEdge, 1.5);
  const press = pressAt(t, S1.send);
  const typingNow = (tf >= S1.typeA1 && tf <= S1.typeB1 + 0.05) || (tf >= S1.typeA2 && tf <= S1.typeB2 + 0.05);
  composer(ctx, MX, COMP.y, COMP.w, COMP.h, {
    font: COMP.font, chars: tf < S1.send + 0.04 ? countUpTo(TYPE_T, tf) : 0,
    caret: tf > S1.typeA1 - 0.3 && tf < S1.send, solid: typingNow, t: tf,
    sendPress: press, mode: t < S1.streamB + 0.1 ? 'stop' : 'send',
  });
  ctx.restore();
}

// The lifted "it?" in screen space: from its place in the message to the middle
// of the frame, where it becomes the wordmark's letters.
const IT = { size: 330 };
function itPose(ctx, t, c) {
  const P = itWorld(ctx, S1.lift);
  const cl = c ?? cam1(ctx, S1.lift);
  const sx = CX + (P.x - cl.x) * cl.z, sy = CY + (P.y - cl.y) * cl.z, ss = P.size * cl.z;
  const e = E.inOutCubic(prog(t, S1.lift, S1.liftEnd));
  const size = zlerp(ss, IT.size, e);
  const endX = CX - 0.421 * IT.size, endY = CY + 0.30 * IT.size;
  // A little arc upward on the way.
  const x = lerp(sx, endX, e), y = lerp(sy, endY, e) - Math.sin(e * Math.PI) * 90;
  return { x, y, size, e };
}
function drawLiftedIt(ctx, t, pose, color = '#fff') {
  const { x, y, size, e } = pose;
  const g = wordmarkGeom(size);
  // Inter in the message, the wordmark's own face once it is out.
  const k = clamp((e - 0.05) / 0.3);
  if (k < 1) {
    setFont(ctx, 450, size, FONT.body, -0.008);
    text(ctx, 'it?', x, y, { color, alpha: 1 - k });
  }
  if (k > 0) {
    ctx.save(); ctx.globalAlpha *= k;
    wordmark(ctx, x, y, size, { color, stop: 0 });
    const qx = x + (GL.adv.i + GL.adv.t + 2 * GL.ls) * size;
    const u = prog(t, S1.snap - 0.05, S1.snap + 0.09);
    const dot = prog(t, S1.snap, S1.snap + 0.12);
    drawQuestion(ctx, qx, y, size, E.inCubic(u), dot, color);
    ctx.restore();
  }
  return g;
}

let _world1 = null;
function sceneChat(ctx, t) {
  if (!_world1) { _world1 = document.createElement('canvas'); _world1.width = W; _world1.height = H; }
  const wc = _world1.getContext('2d');
  wc.setTransform(1, 0, 0, 1, 0, 0);
  wc.globalAlpha = 1; wc.filter = 'none';
  backdrop(wc);
  const c = cam1(wc, t);
  wc.save();
  wc.translate(CX, CY); wc.scale(c.z, c.z); wc.translate(-c.x, -c.y);
  chatWindow(wc, t);
  wc.restore();
  // Rack focus: the chat drops back as "it?" comes forward.
  const focus = tw(t, S1.lift - 0.1, 0.6, E.inOutCubic);
  ctx.save();
  if (focus > 0.01) ctx.filter = `blur(${(focus * 7).toFixed(2)}px) brightness(${(1 - 0.62 * focus).toFixed(3)})`;
  ctx.drawImage(_world1, 0, 0);
  ctx.restore();
  const fade = 1 - tw(t, 0, S1.fade, E.inOutSine);
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }

  if (t >= S1.lift) {
    const pose = itPose(ctx, t);
    drawLiftedIt(ctx, t, pose);
    // The full stop opens into the next room: a square of daylight grows from it,
    // and the room is drawn inside it.
    if (t >= S1.snap + 0.02) {
      const g = wordmarkGeom(pose.size);
      const px = pose.x + g.stop.x, py = pose.y + g.stop.y;
      const p = E.inOutCubic(prog(t, S1.snap + 0.02, S1.bloomEnd));
      const s = lerp(g.stop.s, 2 * Math.hypot(Math.max(px, W - px), Math.max(py, H - py)) + 40, p);
      ctx.save();
      ctx.beginPath(); ctx.rect(px - s / 2, py - s / 2, s, s); ctx.clip();
      sceneLoop(ctx, t);
      ctx.restore();
      if (p < 0.2) stopMark(ctx, px, py, g.stop.s, '#fff');
    }
  }
}

Film.scene(0, S1.bloomEnd, sceneChat, 'chat');

// ════ scene-loop.js ════
// Act two: "it." sits in the light, and its full stop opens into the question
// the agent could only describe in words. It asks. You tap. The agent continues.
// Then the same full stop becomes a whiteboard, a map, a chessboard and a
// checklist, closing back into the end of each sentence between them.

const S2 = {
  a: bar(4), pulse: [bar(4, 2), bar(4, 3)], open: bar(5),
  asks: bar(5) + 0.42, touchIn: bar(5, 3), youTap: bar(6), tap: bar(6, 1),
  agent: bar(6, 3), build: bar(6, 3) + 0.5, ready: bar(7, 2) + 0.2, out: bar(8) - 0.32,
};
// Part one of "It can be": two bars each.
const PART1 = [
  { kind: 'whiteboard', noun: 'a whiteboard', bar: 8 },
  { kind: 'map', noun: 'a map', bar: 10 },
  { kind: 'chess', noun: 'a chessboard', bar: 12 },
  { kind: 'checklist', noun: 'a checklist', bar: 14 },
];
PART1.forEach((p) => { p.t = bar(p.bar); p.launch = bar(p.bar, 1) + 0.2; });
Film.boost(S2.open - 0.02, S2.open + 0.5, 16);
Film.boost(S2.agent - 0.02, S2.agent + 0.6, 12);
Film.boost(S2.out - 0.02, bar(8) + 0.5, 16);
for (const p of PART1) { Film.boost(p.t - 0.35, p.t + 0.5, 16); Film.boost(p.launch - 0.02, p.launch + 0.45, 16); }

// The sentence at the top of act two, and the two-line stack after it.
const HL2 = { size: 88, y: 196, parts: ['It', 'asks.', 'You', 'tap.', 'The', 'agent', 'continues.'] };
const STACK = { x: 150, y1: 468, y2: 604, size: 118 };
const CARD1 = { x: 1372, y: 540 };            // where part one's cards sit
const PICK = { x: CX, y: 624, w: 1268, h: 500 };
const PAGE = { x: CX, y: 624, w: 1268, h: 760 };

// The wordmark's pose where act one leaves it.
const IT0 = { size: 330, x: CX - 0.421 * 330, y: CY + 0.30 * 330 };

Film.init((ctx) => {
  setFont(ctx, 800, HL2.size, FONT.disp, -0.035);
  const sp = measure(ctx, ' ');
  const ws = HL2.parts.map((p) => measure(ctx, p));
  const total = ws.reduce((a, b) => a + b, 0) + sp * (ws.length - 1);
  let x = CX - total / 2;
  HL2.x = ws.map((w) => { const v = x; x += w + sp; return v; });
  setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
  STACK.canX = STACK.x + measure(ctx, 'It ');
  for (const p of PART1) {
    const w = measure(ctx, p.noun);
    const s = STACK.size * 0.15;
    p.stop = { x: STACK.x + w + STACK.size * 0.035 + s / 2, y: STACK.y2 - s / 2, s };
  }

  // The card's life through acts two and three.
  const g = wordmarkGeom(IT0.size);
  const s0 = g.stop.s;
  const pulse = (t) => 1 + 0.22 * S2.pulse.reduce((a, p) => a + Math.max(0, wobble(t, p, 2.2, 9)) , 0);
  addMove({ kind: 'hold', t: S2.a, to: stopPose(IT0.x + g.stop.x, IT0.y + g.stop.y, s0), pulse });
  addMove({ kind: 'open', t: S2.open, to: P(PICK.x, PICK.y, PICK.w, PICK.h, { kind: 'picker' }) });
  addMove({ kind: 'morph', t: S2.agent, to: P(PAGE.x, PAGE.y, PAGE.w, PAGE.h, { kind: 'pageB' }), inA: 0, inB: 0.01 });
  let from = { x: PAGE.x, y: PAGE.y };
  PART1.forEach((p, i) => {
    addMove({ kind: 'close', t: p.t - 0.3, d: 0.3, to: stopPose(from.x, from.y, p.stop.s) });
    addMove({ kind: 'fly', t: p.t, d: 0.42, to: stopPose(p.stop.x, p.stop.y, p.stop.s), arc: 140 });
    const T = THING[p.kind];
    addMove({ kind: 'open', t: p.launch, to: P(CARD1.x, CARD1.y, T.w, T.h, { kind: p.kind, fill: T.fill ?? C.card }) });
    from = CARD1;
  });
});

// "It": the wordmark's letters, then the first word of every sentence.
function itWord(ctx, t) {
  if (t < S2.open - 0.12) {
    wordmark(ctx, IT0.x, IT0.y, IT0.size, { stop: 0 });
    return;
  }
  const head = { x: HL2.x[0], y: HL2.y, size: HL2.size };
  const stack = { x: STACK.x, y: STACK.y1, size: STACK.size };
  let A, B, e, k = 1;
  if (t < S2.out + 0.1) {
    e = E.outQuart(prog(t, S2.open - 0.12, S2.open + 0.5));
    A = { x: IT0.x, y: IT0.y, size: IT0.size }; B = head;
    k = prog(e, 0.2, 0.65);
  } else {
    e = E.inOutCubic(prog(t, S2.out + 0.1, bar(8) + 0.3));
    A = head; B = stack;
  }
  const x = lerp(A.x, B.x, e), y = lerp(A.y, B.y, e), size = Math.exp(lerp(Math.log(A.size), Math.log(B.size), e));
  if (k < 1) { ctx.save(); ctx.globalAlpha *= 1 - k; wordmark(ctx, x, y, size, { stop: 0 }); ctx.restore(); }
  if (k > 0) {
    setFont(ctx, 800, size, FONT.disp, -0.035);
    text(ctx, 'It', x, y, { color: C.ink, alpha: k });
  }
}

function headlineLoop(ctx, t) {
  setFont(ctx, 800, HL2.size, FONT.disp, -0.035);
  const out = { t: S2.out, stagger: 0.025, dur: 0.26 };
  const newest = t >= S2.agent ? 2 : t >= S2.youTap ? 1 : 0;
  const col = (ph) => (ph === newest ? C.ink : mix(C.ink, C.ink4, tw(t, [S2.youTap, S2.agent][ph], 0.4, E.inOutSine)));
  riseLine(ctx, 'asks.', HL2.x[1], HL2.y, HL2.size, t, S2.asks, { dur: 0.5, color: col(0), out });
  riseLine(ctx, 'You tap.', HL2.x[2], HL2.y, HL2.size, t, S2.youTap, { stagger: 0.07, dur: 0.5, color: col(1), out });
  riseLine(ctx, 'The agent continues.', HL2.x[4], HL2.y, HL2.size, t, S2.agent, { stagger: 0.07, dur: 0.5, color: col(2), out });
}

function stackPart1(ctx, t) {
  if (t < PART1[0].t) return;
  setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
  riseLine(ctx, 'can be', STACK.canX, STACK.y1, STACK.size, t, PART1[0].t + 0.12, { stagger: 0.06, dur: 0.5, out: { t: bar(16) - 0.36, stagger: 0.03, dur: 0.28 } });
  rollWords(ctx, PART1.map((p) => p.noun), PART1.map((p) => p.t + (p === PART1[0] ? 0.18 : 0)), t, STACK.x, STACK.y2, STACK.size, { dur: 0.45, outT: bar(16) - 0.33 });
}

// ---------- act two's two interfaces ----------
THING.picker = {
  w: PICK.w, h: PICK.h,
  thumbs: [0, 1, 2].map((i) => ({ x: 64 + i * 392, y: 150, w: 356, h: 232, style: 'ABC'[i], name: ['Calm', 'Split', 'Bold'][i] })),
  draw(ctx, w, h, lt, t) {
    setFont(ctx, 700, 50, FONT.disp, -0.03);
    text(ctx, 'Which one should I build?', 64, 96, { color: C.ink });
    const picked = t >= S2.tap + 0.04;
    const pk = tw(t, S2.tap + 0.04, 0.4, E.outCubic);
    this.thumbs.forEach((T, i) => {
      const sc = i === 1 ? 1 - 0.035 * pressAt(t, S2.tap) : 1;
      ctx.save();
      ctx.translate(T.x + T.w / 2, T.y + T.h / 2); ctx.scale(sc, sc); ctx.translate(-(T.x + T.w / 2), -(T.y + T.h / 2));
      ctx.globalAlpha *= picked && i !== 1 ? lerp(1, 0.35, pk) : 1;
      drawHome(ctx, T.x, T.y, T.w, T.h, T.style, { radius: 16 });
      strokeRR(ctx, T.x + 0.5, T.y + 0.5, T.w - 1, T.h - 1, 16, 'rgba(0,0,0,0.08)', 1);
      circle(ctx, T.x + 22, T.y + T.h + 52, 22, i === 1 && picked ? C.ink : '#ecebe7');
      setFont(ctx, 700, 25, FONT.body, 0);
      text(ctx, T.style, T.x + 22, T.y + T.h + 61, { color: i === 1 && picked ? '#fff' : C.ink, align: 'center' });
      setFont(ctx, 600, 30, FONT.body, -0.01);
      text(ctx, T.name, T.x + 58, T.y + T.h + 63, { color: C.ink2 });
      if (i === 1 && picked) {
        strokeRR(ctx, T.x - 9, T.y - 9, T.w + 18, T.h + 18, 24, C.ink, 5 * E.outBack(pk));
        checkBadge(ctx, T.x + T.w - 4, T.y + 4, 26, pk);
      }
      ctx.restore();
    });
  },
};
// Version B, growing out of its thumbnail and assembling as the agent builds it.
THING.pageB = {
  w: PAGE.w, h: PAGE.h,
  draw(ctx, w, h, lt, t) {
    const T = THING.picker.thumbs[1];
    const x0 = T.x, y0 = T.y + (PAGE.h - PICK.h) / 2;
    const e = E.inOutCubic(prog(t, S2.agent, S2.agent + 0.55));
    const x = lerp(x0, 0, e), y = lerp(y0, 0, e), ww = lerp(T.w, w, e), hh = lerp(T.h, h, e);
    // The picker's other pieces fall away behind it.
    if (e < 1) {
      ctx.save();
      ctx.globalAlpha *= 1 - prog(t, S2.agent, S2.agent + 0.25);
      ctx.translate(0, (PAGE.h - PICK.h) / 2);
      THING.picker.draw.call(THING.picker, ctx, PICK.w, PICK.h, lt, t);
      ctx.restore();
    }
    const build = prog(t, S2.build, S2.ready - 0.1);
    drawHome(ctx, x, y, ww, hh, 'B', { radius: lerp(16, 0, e), build: e < 1 ? 1 : build });
  },
};

function touchLoop(ctx, t) {
  const T = THING.picker.thumbs[1];
  const bx = PICK.x - PICK.w / 2 + T.x + T.w / 2, by = PICK.y - PICK.h / 2 + T.y + T.h / 2 + 10;
  touchPath(ctx, t, [[S2.touchIn, bx + 330, by + 420], [S2.tap - 0.05, bx, by], [S2.agent - 0.1, bx + 40, by + 60]], { taps: [S2.tap] });
  drawRipple(ctx, bx, by, t, S2.tap + 0.02, C.ink, 120);
}

// Claude, in the first exchange. Its plate is on the corner of the question it
// asked. Your tap goes back to it, and the plate says what it is doing about it.
let AGENT_LOOP = null;
Film.init(() => {
  const T = THING.picker.thumbs[1];
  const tapAt = [PICK.x - PICK.w / 2 + T.x + T.w / 2, PICK.y - PICK.h / 2 + T.y + T.h / 2 + 10];
  AGENT_LOOP = agentPart({
    names: [[0, 'Claude']], in: S2.open + 0.5, out: S2.out - 0.1,
    at: (t) => { const p = cardAt(t); return [p.x + p.w / 2 - 30, p.y + p.h / 2 - 30 - PLATE.h * PLATE.scale / 2]; },
    heard: [[S2.tap + 0.04, ...tapAt]],
    notes: [[S2.agent, 'is building version B'], [S2.ready, 'built version B']],
    busy: [[S2.agent + 0.2, S2.ready - 0.05]], done: S2.ready,
  });
});

function sceneLoop(ctx, t) {
  paper(ctx);
  itWord(ctx, t);
  headlineLoop(ctx, t);
  stackPart1(ctx, t);
  drawCard(ctx, t, cardAt(t));
  touchLoop(ctx, t);
  touchPart1(ctx, t);
  if (AGENT_LOOP) agentShow(ctx, t, AGENT_LOOP);
  agentPart1(ctx, t);
}

Film.scene(S1.bloomEnd, bar(16), sceneLoop, 'loop');

// ════ things-part1.js ════
// The first four things It becomes, two bars each, and each one a real
// exchange: you do something, your answer goes back to the agent, whose name
// is on the corner of the page, and the agent does the next thing in the page's
// own way.
//
// Local time `lt` starts when the card begins to open; it is fully open by 0.4 s
// and closes about 3 s later.

const P1 = (kind) => PART1.find((p) => p.kind === kind);
// Card-local point to the screen, for the fingertip.
const onCard1 = (kind, x, y) => { const T = THING[kind]; return [CARD1.x - T.w / 2 + x, CARD1.y - T.h / 2 + y]; };

function titleBlock(ctx, title, sub, x = 56, y = 88, { color = C.ink, subColor = C.ink3, size = 46 } = {}) {
  setFont(ctx, 700, size, FONT.disp, -0.03);
  text(ctx, title, x, y, { color });
  if (sub) { setFont(ctx, 500, 27, FONT.body, -0.005); text(ctx, sub, x + 2, y + 44, { color: subColor }); }
}

// Points along a polyline, resampled to n by length.
function resample(pts, n) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * L[L.length - 1];
    let i = 1; while (i < L.length - 1 && L[i] < s) i++;
    const u = (s - L[i - 1]) / (L[i] - L[i - 1] || 1);
    out.push([lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)]);
  }
  return out;
}
function polyPath(ctx, pts, n = pts.length) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
}

// ---------- a whiteboard: you sketch it, the agent cleans it up ----------
const WB = { strokes: [], draw: [0.45, 1.5], tidy: [2.05, 2.5] };
Film.init(() => {
  const r = rng(12);
  const j = (v, a = 5) => v + (r() - 0.5) * a;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 6]];
  const circ = (cx, cy, rad) => { const p = []; for (let i = 0; i <= 36; i++) { const a = -Math.PI / 2 + (i / 36) * TAU * 1.04; p.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); } return p; };
  const line = (x0, x1, y) => [[x0, y], [x1, y]];
  // [rough path, clean path, clean style]
  const S = [
    [rect(90, 160, 670, 380), rect(90, 160, 670, 380), 'box'],
    [line(130, 410, 226), line(130, 410, 226), 'bar'],
    [line(130, 350, 270), line(130, 350, 270), 'bar2'],
    [circ(555, 270, 66), circ(555, 270, 66), 'dot'],
    [rect(130, 308, 292, 348), rect(130, 308, 292, 348), 'btn'],
    [line(90, 370, 462), line(90, 370, 462), 'row'],
    [line(390, 670, 462), line(390, 670, 462), 'row'],
  ];
  for (const [rough, clean, style] of S) {
    const n = 40;
    const a = resample(rough, n).map(([x, y], i) => [j(x, 9) + Math.sin(i * 0.7) * 3, j(y, 9) + Math.cos(i * 0.5) * 3]);
    const b = resample(clean, n);
    WB.strokes.push({ rough: a, clean: b, style, len: n });
  }
});
function wbTip(p) {
  const total = WB.strokes.length;
  const f = clamp(p) * total, i = Math.min(total - 1, Math.floor(f)), u = f - i;
  const s = WB.strokes[i];
  return s.rough[Math.min(s.len - 1, Math.floor(u * s.len))];
}
THING.whiteboard = {
  w: 760, h: 580,
  draw(ctx, w, h, lt, t) {
    ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14,14,16,0.12)';
    for (let x = 30; x < w; x += 30) for (let y = 30; y < h; y += 30) ctx.fillRect(x - 1.25, y - 1.25, 2.5, 2.5);
    // Toolbar.
    fillRR(ctx, w / 2 - 170, 26, 340, 70, 35, '#ffffff');
    strokeRR(ctx, w / 2 - 170, 26, 340, 70, 35, 'rgba(0,0,0,0.08)', 1.5);
    ['#0e0e10', '#ff5b45', '#3d7bff', '#1fb877'].forEach((c, i) => {
      circle(ctx, w / 2 - 110 + i * 56, 61, 17, c);
      if (i === 0) ring(ctx, w / 2 - 110, 61, 24, 'rgba(14,14,16,0.35)', 3);
    });
    const draw = prog(lt, WB.draw[0], WB.draw[1]);
    const tidy = E.inOutCubic(prog(lt, WB.tidy[0], WB.tidy[1]));
    const n = WB.strokes.length;
    WB.strokes.forEach((S, i) => {
      const u = clamp(draw * n - i);
      if (u <= 0) return;
      const k = Math.max(2, Math.floor(u * S.len));
      const pts = S.rough.slice(0, k).map((p, q) => [lerp(p[0], S.clean[q][0], tidy), lerp(p[1], S.clean[q][1], tidy)]);
      // The clean shapes fill in as the strokes straighten.
      if (tidy > 0) {
        ctx.save(); ctx.globalAlpha *= tidy;
        const c = S.clean;
        const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        if (S.style === 'box') fillRR(ctx, x0, y0, x1 - x0, y1 - y0, 22, '#f1ede5');
        if (S.style === 'dot') circle(ctx, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, C.coral);
        if (S.style === 'btn') { fillRR(ctx, x0, y0, x1 - x0, y1 - y0, (y1 - y0) / 2, C.ink); setFont(ctx, 700, 20, FONT.body, 0); text(ctx, 'Order now', (x0 + x1) / 2, y0 + 27, { color: '#fff', align: 'center' }); }
        if (S.style === 'bar') fillRR(ctx, x0, y0 - 13, x1 - x0, 26, 13, C.ink);
        if (S.style === 'bar2') fillRR(ctx, x0, y0 - 8, x1 - x0, 16, 8, C.ink4);
        if (S.style === 'row') fillRR(ctx, x0 + 6, y0 - 34, x1 - x0 - 12, 100, 18, '#f1ede5');
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha *= 1 - tidy;
      ctx.strokeStyle = C.ink; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      polyPath(ctx, pts); ctx.stroke();
      ctx.restore();
    });
  },
};

// ---------- a map: you pick a place, the agent books it ----------
const MAPC = { tap: 0.9, route: [1.3, 1.9], sheet: 1.95, booked: 2.45 };
const PINS = [
  { name: 'Ostra', x: 206, y: 330 }, { name: 'Luna', x: 486, y: 262, pick: true }, { name: 'Bodega', x: 540, y: 520 },
];
const YOU = { x: 196, y: 600 };
// The way from you to the place you picked, and how far along it the line has got.
const MAP_ROUTE = resample([[YOU.x, YOU.y], [YOU.x + 20, 470], [360, 440], [390, 330], [486, 302]], 60);
const routeHead = (lt) => MAP_ROUTE[Math.min(59, Math.max(1, Math.floor(E.inOutCubic(prog(lt, MAPC.route[0], MAPC.route[1])) * 60)) - 1)];
THING.map = {
  w: 700, h: 800,
  draw(ctx, w, h, lt, t) {
    titleBlock(ctx, 'Dinner at 8. Where?', 'Three places near you with a table for four');
    const mx = 30, my = 160, mw = w - 60, mh = h - 190;
    ctx.save();
    rr(ctx, mx, my, mw, mh, 22); ctx.clip();
    ctx.fillStyle = '#eee8dc'; ctx.fillRect(mx, my, mw, mh);
    // Park and river.
    fillRR(ctx, mx + 380, my + 360, 240, 180, 26, '#cfe5c1');
    ctx.strokeStyle = '#bcdcf2'; ctx.lineWidth = 46; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(mx - 20, my + 120); ctx.bezierCurveTo(mx + 200, my + 60, mx + 300, my + 250, mx + mw + 20, my + 180); ctx.stroke();
    // Streets.
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 16; ctx.lineCap = 'butt';
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(mx + 60 + i * 120, my); ctx.lineTo(mx + 20 + i * 120, my + mh); ctx.stroke(); }
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(mx, my + 60 + i * 130); ctx.lineTo(mx + mw, my + 90 + i * 130); ctx.stroke(); }
    ctx.lineWidth = 26; ctx.strokeStyle = '#fff6e0';
    ctx.beginPath(); ctx.moveTo(mx, my + 470); ctx.lineTo(mx + mw, my + 330); ctx.stroke();
    // The route from you to the pick.
    const L = PINS[1];
    const rt = prog(lt, MAPC.route[0], MAPC.route[1]);
    if (rt > 0) {
      ctx.strokeStyle = C.sky; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      polyPath(ctx, MAP_ROUTE, Math.max(2, Math.floor(E.inOutCubic(rt) * 60)));
      ctx.stroke();
    }
    ctx.restore();
    // You.
    circle(ctx, YOU.x, YOU.y, 30 + 10 * Math.sin(t * 5), 'rgba(61,123,255,0.18)');
    circle(ctx, YOU.x, YOU.y, 16, '#fff'); circle(ctx, YOU.x, YOU.y, 11, C.sky);
    // Pins.
    PINS.forEach((p, i) => {
      const picked = p.pick && lt >= MAPC.tap;
      const hop = p.pick ? Math.abs(wobble(lt, MAPC.tap, 3, 7)) * 26 : 0;
      const dim = !p.pick && lt >= MAPC.tap ? lerp(1, 0.45, tw(lt, MAPC.tap, 0.3)) : 1;
      const pop = E.outBack(clamp((lt - 0.25 - i * 0.08) / 0.3));
      if (pop <= 0) return;
      ctx.save();
      ctx.globalAlpha *= dim;
      ctx.translate(p.x, p.y - hop); ctx.scale(pop, pop);
      const col = picked ? C.coral : C.ink;
      ctx.beginPath(); ctx.moveTo(0, 36); ctx.bezierCurveTo(-8, 22, -24, 10, -24, -6); ctx.arc(0, -6, 24, Math.PI, 0); ctx.bezierCurveTo(24, 10, 8, 22, 0, 36); ctx.fillStyle = col; ctx.fill();
      circle(ctx, 0, -6, 9, '#fff');
      setFont(ctx, 700, 26, FONT.body, 0);
      const lw = measure(ctx, p.name) + 30;
      ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      fillRR(ctx, -lw / 2, -84, lw, 42, 21, picked ? C.coral : '#fff');
      ctx.shadowColor = 'transparent';
      text(ctx, p.name, 0, -55, { color: picked ? '#fff' : C.ink, align: 'center' });
      ctx.restore();
    });
    // The agent books it.
    const sh = tw(lt, MAPC.sheet, 0.45, E.outExpo);
    if (sh > 0) {
      const sy = h - 30 - 150 + (1 - sh) * 190;
      ctx.save();
      ctx.shadowColor = 'rgba(30,20,10,0.22)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = -4;
      fillRR(ctx, 44, sy, w - 88, 140, 24, '#fff');
      ctx.shadowColor = 'transparent';
      setFont(ctx, 700, 36, FONT.disp, -0.02);
      text(ctx, 'Luna', 80, sy + 60, { color: C.ink });
      setFont(ctx, 500, 26, FONT.body, 0);
      text(ctx, 'Table for 4 · 8:00 PM', 80, sy + 102, { color: C.ink3 });
      const bk = prog(lt, MAPC.booked, MAPC.booked + 0.35);
      if (bk > 0) {
        // The pill is as wide as its word, and keeps its right edge.
        setFont(ctx, 700, 24, FONT.body, 0);
        const bw = 62 + measure(ctx, 'Booked') + 26, bx = w - 74 - bw, by = sy + 44;
        ctx.save(); ctx.globalAlpha *= clamp(bk * 2);
        const s = E.outBack(bk);
        ctx.translate(bx + bw / 2, by + 26); ctx.scale(s, s); ctx.translate(-(bx + bw / 2), -(by + 26));
        fillRR(ctx, bx, by, bw, 52, 26, C.mint);
        text(ctx, 'Booked', bx + 62, by + 35, { color: '#fff' });
        drawCheck(ctx, bx + 14, by + 10, 34, '#fff', 4.5, clamp(bk * 1.6));
        ctx.restore();
      }
      ctx.restore();
    }
  },
};

// ---------- a chessboard: the agent moves, you move, the agent answers ----------
const CH = { sq: 76, x: 46, y: 170, agent1: [0.4, 0.75], grab: 1.05, drop: 1.6, check: 1.65, agent2: [2.25, 2.6] };
// Squares as file (0..7 = a..h) and rank (1..8).
const sqXY = (f, r) => [CH.x + f * CH.sq + CH.sq / 2, CH.y + (8 - r) * CH.sq + CH.sq / 2];
const PIECES = [
  ['K', 'w', 4, 1], ['Q', 'w', 3, 1], ['R', 'w', 0, 1], ['R', 'w', 7, 1], ['B', 'w', 2, 4, 'bish'], ['N', 'w', 5, 3],
  ['P', 'w', 0, 2], ['P', 'w', 1, 2], ['P', 'w', 2, 3], ['P', 'w', 3, 3], ['P', 'w', 4, 4], ['P', 'w', 5, 2], ['P', 'w', 6, 2], ['P', 'w', 7, 2],
  ['K', 'b', 4, 8, 'king'], ['Q', 'b', 3, 8], ['R', 'b', 0, 8], ['R', 'b', 7, 8], ['B', 'b', 2, 5], ['N', 'b', 2, 6], ['N', 'b', 6, 8, 'knight'],
  ['P', 'b', 0, 7], ['P', 'b', 1, 7], ['P', 'b', 2, 7], ['P', 'b', 3, 6], ['P', 'b', 4, 5], ['P', 'b', 5, 7, 'victim'], ['P', 'b', 6, 7], ['P', 'b', 7, 7],
];
// Classic Staunton pieces from Noto Sans Symbols 2: white pieces are the solid
// glyph filled white with the outline glyph over it.
const GLYPH_W = { K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659' };
const GLYPH_B = { K: '\u265A', Q: '\u265B', R: '\u265C', B: '\u265D', N: '\u265E', P: '\u265F' };
function drawPiece(ctx, type, side, x, y, s, lift = 0) {
  ctx.save();
  ctx.translate(x, y - lift);
  ctx.font = `400 ${s}px Chess`; ctx.letterSpacing = '0px';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const by = s * 0.34;
  if (lift > 0) { ctx.shadowColor = 'rgba(0,0,0,0.32)'; ctx.shadowBlur = 14 + lift; ctx.shadowOffsetY = 6 + lift * 0.6; }
  ctx.fillStyle = side === 'w' ? '#fffcf5' : '#1d1c20';
  ctx.fillText(GLYPH_B[type], 0, by);
  ctx.shadowColor = 'transparent';
  if (side === 'w') { ctx.fillStyle = '#1d1c20'; ctx.fillText(GLYPH_W[type], 0, by); }
  ctx.restore();
}
THING.chess = {
  w: 700, h: 800,
  draw(ctx, w, h, lt, t) {
    titleBlock(ctx, 'Your move.', null, 56, 96);
    for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
      const [x, y] = sqXY(f, r);
      ctx.fillStyle = (f + r) % 2 === 1 ? '#c9a27e' : '#f3ebdd';
      ctx.fillRect(x - CH.sq / 2, y - CH.sq / 2, CH.sq, CH.sq);
    }
    // Last-move highlights.
    const hl = (f, r, a) => { const [x, y] = sqXY(f, r); ctx.fillStyle = `rgba(255,214,77,${a})`; ctx.fillRect(x - CH.sq / 2, y - CH.sq / 2, CH.sq, CH.sq); };
    if (lt >= CH.agent1[1] && lt < CH.grab) { hl(6, 8, 0.45); hl(5, 6, 0.45); }
    if (lt >= CH.drop && lt < CH.agent2[1]) { hl(2, 4, 0.45); hl(5, 7, 0.45); }
    if (lt >= CH.agent2[1]) { hl(4, 8, 0.45); hl(4, 7, 0.45); }
    // Check: the king's square glows.
    const ck = prog(lt, CH.check, CH.check + 0.2) * (1 - prog(lt, CH.agent2[0], CH.agent2[1]));
    if (ck > 0) { const [x, y] = sqXY(4, 8); const g = ctx.createRadialGradient(x, y, 4, x, y, CH.sq * 0.7); g.addColorStop(0, `rgba(255,70,50,${0.85 * ck})`); g.addColorStop(1, 'rgba(255,70,50,0)'); ctx.fillStyle = g; ctx.fillRect(x - CH.sq / 2, y - CH.sq / 2, CH.sq, CH.sq); }
    const sz = CH.sq * 0.84;
    let held = null;
    for (const [type, side, f, r, tag] of PIECES) {
      let [x, y] = sqXY(f, r), lift = 0, a = 1;
      if (tag === 'knight') {
        const e = E.inOutCubic(prog(lt, CH.agent1[0], CH.agent1[1]));
        const [x2, y2] = sqXY(5, 6); x = lerp(x, x2, e); y = lerp(y, y2, e); lift = Math.sin(e * Math.PI) * 40;
      }
      if (tag === 'king') {
        const e = E.inOutCubic(prog(lt, CH.agent2[0], CH.agent2[1]));
        const [x2, y2] = sqXY(4, 7); x = lerp(x, x2, e); y = lerp(y, y2, e); lift = Math.sin(e * Math.PI) * 24;
        if (ck > 0) x += wobble(lt, CH.check, 9, 6) * 5;
      }
      if (tag === 'victim') {
        // Taken: it hops off the board.
        const e = prog(lt, CH.drop - 0.02, CH.drop + 0.45);
        if (e >= 1) continue;
        if (e > 0) { x += e * 190; y -= Math.sin(e * Math.PI) * 120 - e * e * 60; a = 1 - e; }
      }
      if (tag === 'bish') {
        const [x2, y2] = sqXY(5, 7);
        const g = prog(lt, CH.grab, CH.drop), e = E.inOutCubic(g);
        if (lt > CH.grab) { x = lerp(x, x2, e); y = lerp(y, y2, e); lift = lt < CH.drop ? 26 * clamp((lt - CH.grab) / 0.12) : 26 * (1 - clamp((lt - CH.drop) / 0.08)); }
        if (lt > CH.grab && lt < CH.drop + 0.08) { held = [type, side, x, y, lift]; continue; }
      }
      ctx.save(); ctx.globalAlpha *= a;
      drawPiece(ctx, type, side, x, y + CH.sq * 0.02, sz, lift);
      ctx.restore();
    }
    if (held) drawPiece(ctx, held[0], held[1], held[2], held[3], sz, held[4]);
    // "Check."
    if (ck > 0) {
      const [x, y] = sqXY(4, 8);
      const s = E.outBack(clamp(ck * 1.2));
      ctx.save(); ctx.translate(x + 60, y - 30); ctx.scale(s, s);
      fillRR(ctx, -4, -30, 124, 52, 26, C.coral);
      setFont(ctx, 800, 28, FONT.disp, -0.02);
      text(ctx, 'Check.', 58, 5, { color: '#fff', align: 'center' });
      ctx.restore();
    }
  },
};

// ---------- a checklist: you tick, the agent adds what you forgot ----------
const CHK = {
  items: ['Passport', 'Phone charger', 'Sunscreen', 'Swimsuit', 'Plug adapter (type F)'],
  ticks: [null, 0.5, 1.0, 1.5, null], add: 2.05, row: 86, top: 176,
};
THING.checklist = {
  w: 620, h: 800,
  // `extra.umbrella` (0..1) ticks the row the agent added, which happens on the phone.
  draw(ctx, w, h, lt, t, extra = {}) {
    titleBlock(ctx, 'Packing for Lisbon', 'Thursday to Sunday · 3 nights');
    const add = E.outExpo(prog(lt, CHK.add, CHK.add + 0.5));
    const rows = [...CHK.items.map((s, i) => ({ s, i })), { s: 'Umbrella', i: 5, note: 'Rain on Friday' }];
    rows.forEach((R, k) => {
      const y = CHK.top + k * CHK.row;
      if (R.i === 5) {
        if (add <= 0) return;
        ctx.save(); ctx.globalAlpha *= add;
        ctx.translate(0, (1 - add) * 40);
        fillRR(ctx, 30, y - 8, w - 60, CHK.row - 6, 18, rgba('#ffc53d', 0.28 * (1 - 0.6 * prog(lt, CHK.add + 0.6, CHK.add + 1.2))));
      } else ctx.save();
      const tick = R.i === 5 ? extra.umbrella ?? 0 : R.i === 0 ? 1 : CHK.ticks[R.i] != null ? prog(lt, CHK.ticks[R.i], CHK.ticks[R.i] + 0.22) : 0;
      const bx = 56, by = y + 14, bs = 44;
      const sc = R.i === 5 ? 1 - 0.12 * (extra.press ?? 0) : CHK.ticks[R.i] != null ? 1 - 0.12 * pressAt(lt, CHK.ticks[R.i]) : 1;
      ctx.save(); ctx.translate(bx + bs / 2, by + bs / 2); ctx.scale(sc, sc); ctx.translate(-(bx + bs / 2), -(by + bs / 2));
      if (tick > 0) fillRR(ctx, bx, by, bs, bs, 12, mix('#ffffff', C.ink, clamp(tick * 2)));
      strokeRR(ctx, bx + 1.5, by + 1.5, bs - 3, bs - 3, 11, tick > 0 ? C.ink : '#c9c4ba', 3);
      drawCheck(ctx, bx + 2, by + 2, bs - 4, '#fff', 5, clamp(tick * 1.6 - 0.3));
      ctx.restore();
      setFont(ctx, 600, 32, FONT.body, -0.01);
      text(ctx, R.s, 126, y + 48, { color: mix(C.ink, C.ink4, tick * 0.8) });
      if (tick > 0.2) { const lw = measure(ctx, R.s); ctx.fillStyle = rgba(C.ink4, 0.9); ctx.fillRect(126, y + 37, lw * E.outCubic(clamp((tick - 0.2) / 0.6)), 3); }
      if (R.note) {
        setFont(ctx, 600, 22, FONT.body, 0);
        const nw = measure(ctx, R.note) + 30;
        fillRR(ctx, w - 56 - nw, y + 16, nw, 40, 20, C.ink);
        text(ctx, R.note, w - 56 - nw + 15, y + 43, { color: '#fff' });
      }
      if (k < rows.length - 1) { ctx.fillStyle = C.line; ctx.fillRect(56, y + CHK.row - 2, w - 112, 2); }
      ctx.restore();
    });
  },
};

// ---------- the fingertip for part one ----------
function touchPart1(ctx, t) {
  // Whiteboard: it draws every stroke, then leaves.
  {
    const p = P1('whiteboard'), lt = t - p.launch;
    if (lt > WB.draw[0] - 0.3 && lt < WB.draw[1] + 0.4) {
      const u = prog(lt, WB.draw[0], WB.draw[1]);
      const [x, y] = wbTip(u);
      const [sx, sy] = onCard1('whiteboard', x, y);
      const a = tw(lt, WB.draw[0] - 0.3, 0.2) * (1 - tw(lt, WB.draw[1] + 0.05, 0.25));
      const into = lt < WB.draw[0] ? 1 - E.outCubic(prog(lt, WB.draw[0] - 0.3, WB.draw[0])) : 0;
      drawTouch(ctx, sx + into * 200, sy + into * 260, a, lt >= WB.draw[0] && lt <= WB.draw[1] ? 1 : 0);
    }
  }
  // Map: a tap on Luna.
  {
    const p = P1('map'), L = PINS[1];
    const [bx, by] = onCard1('map', L.x, L.y - 6);
    const tp = p.launch + MAPC.tap;
    touchPath(ctx, t, [[tp - 0.5, bx + 260, by + 380], [tp - 0.04, bx, by], [tp + 0.4, bx + 60, by + 120]], { taps: [tp] });
    drawRipple(ctx, bx, by, t, tp + 0.02, C.ink, 100);
  }
  // Chess: pick up the bishop and take f7.
  {
    const p = P1('chess');
    const [x1, y1] = onCard1('chess', ...sqXY(2, 4)), [x2, y2] = onCard1('chess', ...sqXY(5, 7));
    const g = p.launch + CH.grab, d = p.launch + CH.drop;
    touchPath(ctx, t, [[g - 0.45, x1 + 240, y1 + 260], [g - 0.02, x1, y1 - 10], [g, x1, y1 - 10], [d, x2, y2 - 36], [d + 0.35, x2 + 70, y2 + 90]], { taps: [g - 0.02] });
  }
  // Checklist: three ticks.
  {
    const p = P1('checklist');
    const pts = CHK.ticks.map((tk, i) => (tk == null ? null : [p.launch + tk, ...onCard1('checklist', 78, CHK.top + i * CHK.row + 36)])).filter(Boolean);
    const keys = [[pts[0][0] - 0.4, pts[0][1] + 220, pts[0][2] + 300]];
    for (const [tt, x, y] of pts) keys.push([tt - 0.06, x, y], [tt + 0.1, x, y]);
    keys.push([pts[pts.length - 1][0] + 0.5, pts[pts.length - 1][1] + 80, pts[pts.length - 1][2] + 200]);
    touchPath(ctx, t, keys, { taps: pts.map((q) => q[0]) });
  }
}

// ---------- the agents of part one ----------
// Each has its plate on the top right corner of its card, half over the edge.
// On the whiteboard, which is a canvas, the plate comes down with a pointer.
const AGENTS1 = [];
Film.init(() => {
  const mk = (kind, name, { heard = [], busy = [], notes = null, hands = null }) => {
    const p = P1(kind), T = THING[kind], at = (x, y) => onCard1(kind, x, y), L = (lt) => p.launch + lt;
    AGENTS1.push(agentPart({
      names: [[0, name]], in: L(0.34), out: L(2.92),
      at: () => [CARD1.x + T.w / 2 - 28, CARD1.y - T.h / 2],
      heard: heard.map(([lt, x, y]) => [L(lt), ...at(x, y)]),
      busy: busy.map(([a, b]) => [L(a), L(b)]),
      notes: notes && notes.map(([lt, s]) => [L(lt), s]),
      hands: hands && hands.map((Hd) => ({ keys: Hd.keys.map(([lt, x, y]) => [L(lt), ...at(x, y)]), clicks: (Hd.clicks || []).map(L) })),
    }));
  };
  const got = (lt) => lt + BEAD;   // when an answer that left at lt has landed
  // Whiteboard: Claude watches you sketch, then goes over it by hand and the sketch becomes a layout.
  const tip = wbTip(1);
  mk('whiteboard', 'Claude', {
    heard: [[WB.draw[1] + 0.02, tip[0], tip[1]]],
    hands: [{ keys: [[WB.tidy[0], 640, 400], [WB.tidy[0] + 0.24, 400, 236], [WB.tidy[1], 540, 470], [WB.tidy[1] + 0.12, 540, 470]] }],
  });
  // Map: Codex finds the way there and books the table.
  mk('map', 'Codex', { heard: [[MAPC.tap + 0.03, PINS[1].x, PINS[1].y - 6]], busy: [[got(MAPC.tap + 0.06), MAPC.booked + 0.05]] });
  // Chess: OpenCode plays its knight, hears your capture, thinks, and moves its king out of check.
  const hit = sqXY(5, 7);
  mk('chess', 'OpenCode', {
    heard: [[CH.drop + 0.04, hit[0], hit[1]]], busy: [[got(CH.drop + 0.08), CH.agent2[0] + 0.12]],
    notes: [[CH.agent1[1] - 0.1, 'Knight to f6'], [CH.agent2[1] - 0.1, 'King to e7']],
  });
  // Checklist: Hermes hears your ticks and adds the thing you forgot.
  mk('checklist', 'Hermes', { heard: [[CHK.ticks[3] + 0.04, 78, CHK.top + 3 * CHK.row + 36]], busy: [[got(CHK.ticks[3] + 0.08), CHK.add + 0.12]] });
});
function agentPart1(ctx, t) { for (const A of AGENTS1) agentShow(ctx, t, A); }

// ════ scene-where.js ════
// The breakdown. The camera pulls back from the checklist to find it on a
// phone, and the same trip goes on from screen to screen: a phone, a laptop, a
// TV and the screen in a car. Hermes, the agent that made the list, has its
// plate on every one of them. On each you do one thing, it hears it, and the
// screen shows what it did about it.
// "It goes where you are." Then the agents it works with roll past to "yours.",
// "works with" turns into "can be", and "It can be yours." waits out the
// music's break, its full stop pulsing on the beats, until the drop.

const S3 = {
  a: bar(16), head: bar(16) + 0.25, headOut: bar(20) - 0.4,
  dev: [bar(16), bar(17), bar(18), bar(19)],
  agents: bar(20), canbe: bar(23), b: bar(24),
};
// When things happen on each screen, counted from the moment its card opens
// (for the phone, from the start of the act). A screen is in view for about a
// second and a half, so each gets one thing from you and one from the agent.
const WH = {
  phoneTap: 0.62,
  lapClick: 0.5, lapHeld: 0.88,
  tvFocus: [0.2, 0.4], tvPick: 0.52, tvLoad: 0.88,
  carTap: 0.42, carRoute: [0.78, 1.12], carEta: 1.04,
};
// On a screen the answer has less far to go.
const BEAD3 = 0.26;
// Hermes's plate on each screen, in the screen's own coordinates: where it is,
// how big, and where what you did sets off from.
const HERMES = {
  phone: { x: 300, y: 508, scale: 0.6, align: 'right' },
  laptop: { x: 944, y: 76, scale: 0.86, align: 'right' },
  tv: { x: 1110, y: 86, scale: 1, align: 'right', dark: 1 },
  car: { x: 560, y: 52, scale: 0.78, align: 'left', dark: 1 },
};
// The plate on a screen, lit by an answer that left you at `heard` (screen time).
function hermesPlate(ctx, kind, u, heard, t) {
  const Hm = HERMES[kind];
  return agentPlate(ctx, Hm.x, Hm.y, 'Hermes', { scale: Hm.scale, align: Hm.align, dark: Hm.dark || 0, lit: litBy([heard], u, BEAD3), t });
}
// The agent apps It works with, in the order of the table in It's docs/agents.md.
// T3 Code has no add-on of its own: the Claude Code and Codex add-ons load inside
// its threads, and a click on an idle thread starts a turn there.
const AGENTS = ['Claude Code', 'Codex', 'T3 Code', 'Pi', 'OpenCode', 'Hermes Agent', 'yours'];
// Two beats each, but for Pi and OpenCode, which take one, so that "yours."
// still lands where it did.
const AGENT_T = [0, 2, 4, 6, 7, 8, 10].map((b) => bar(20, b));
S3.dev.forEach((t, i) => { if (i) { Film.boost(t - 0.5, t + 0.3, 20); } });
Film.boost(S3.a - 0.02, S3.a + 0.7, 14);
Film.boost(S3.agents - 0.45, S3.agents + 0.4, 18);
Film.boost(S3.canbe - 0.3, S3.canbe + 0.5, 14);

// Devices in a row in world space; the camera pans along them.
const DEVW = [
  { kind: 'phone', x: CX, y: 648, sw: 340, sh: 716, r: 44 },
  { kind: 'laptop', x: CX + 2100, y: 600, sw: 1000, sh: 625, r: 14 },
  { kind: 'tv', x: CX + 4200, y: 596, sw: 1180, sh: 664, r: 8 },
  { kind: 'car', x: CX + 6700, y: 712, sw: 900, sh: 430, r: 26 },
];
const HL3 = { size: 88, y: 158 };
const AG = { y1: 430, y2: 650, s1: 96, s2: 176 };

// The camera: at first framed so the phone's screen sits exactly where the
// checklist card was, then back to show the phone, then a pan per bar.
function cam3(t) {
  const D0 = DEVW[0];
  const z0 = THING.checklist.w / D0.sw;
  const tl = [CARD1.x - THING.checklist.w / 2, CARD1.y - THING.checklist.h / 2];
  const start = { x: D0.x - D0.sw / 2 - (tl[0] - CX) / z0, y: D0.y - D0.sh / 2 - (tl[1] - CY) / z0, z: z0 };
  const at = (i) => ({ x: DEVW[i].x, y: 560, z: 1 });
  let c = camMix(start, at(0), E.inOutCubic(prog(t, S3.a, S3.a + 0.75)));
  for (let i = 1; i < 4; i++) {
    const e = E.inOutCubic(prog(t, S3.dev[i] - 0.45, S3.dev[i] + 0.22));
    if (e > 0) c = { x: lerp(c.x, DEVW[i].x, e), y: 560, z: 1 };
  }
  return c;
}

function drawDevice(ctx, D) {
  const { x, y, sw, sh } = D;
  ctx.save();
  ctx.shadowColor = 'rgba(40,24,12,0.26)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 30;
  if (D.kind === 'phone') {
    fillRR(ctx, x - sw / 2 - 16, y - sh / 2 - 16, sw + 32, sh + 32, D.r + 14, '#111113');
    ctx.shadowColor = 'transparent';
    strokeRR(ctx, x - sw / 2 - 15, y - sh / 2 - 15, sw + 30, sh + 30, D.r + 13, 'rgba(255,255,255,0.12)', 2);
  } else if (D.kind === 'laptop') {
    fillRR(ctx, x - sw / 2 - 22, y - sh / 2 - 22, sw + 44, sh + 48, 26, '#141416');
    ctx.shadowColor = 'transparent';
    const by = y + sh / 2 + 26;
    ctx.beginPath();
    ctx.moveTo(x - sw / 2 - 90, by); ctx.lineTo(x + sw / 2 + 90, by);
    ctx.lineTo(x + sw / 2 + 120, by + 22); ctx.quadraticCurveTo(x, by + 34, x - sw / 2 - 120, by + 22);
    ctx.closePath(); ctx.fillStyle = '#c9c6c0'; ctx.fill();
    fillRR(ctx, x - 90, by, 180, 8, 4, '#a9a59e');
  } else if (D.kind === 'tv') {
    // A television on the wall over a low sideboard, with a lamp and a plant.
    ctx.shadowColor = 'transparent';
    const fy = y + sh / 2 + 62;
    ctx.save(); ctx.shadowColor = 'rgba(40,24,12,0.22)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 26;
    fillRR(ctx, x - 760, fy, 1520, 190, 18, '#c9a57c');
    ctx.restore();
    fillRR(ctx, x - 760, fy, 1520, 22, 10, '#d8b68f');
    for (let k = 0; k < 4; k++) { strokeRR(ctx, x - 736 + k * 370, fy + 44, 350, 122, 10, 'rgba(90,60,30,0.28)', 3); circle(ctx, x - 561 + k * 370, fy + 105, 7, 'rgba(90,60,30,0.45)'); }
    // The lamp, and the light it throws on the wall.
    const lg = ctx.createRadialGradient(x - 930, fy - 150, 10, x - 930, fy - 150, 420);
    lg.addColorStop(0, 'rgba(255,214,150,0.55)'); lg.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = lg; ctx.fillRect(x - 1400, fy - 600, 900, 800);
    ctx.fillStyle = '#3a3531'; ctx.fillRect(x - 936, fy - 120, 12, 120);
    fillRR(ctx, x - 990, fy - 14, 120, 14, 7, '#3a3531');
    ctx.beginPath(); ctx.moveTo(x - 990, fy - 110); ctx.lineTo(x - 870, fy - 110); ctx.lineTo(x - 895, fy - 210); ctx.lineTo(x - 965, fy - 210); ctx.closePath(); ctx.fillStyle = '#f3d9ae'; ctx.fill();
    // The plant.
    fillRR(ctx, x + 880, fy - 130, 130, 130, 18, '#d9d2c5');
    ctx.fillStyle = '#5f8a57';
    for (let k = 0; k < 7; k++) { ctx.save(); ctx.translate(x + 945, fy - 124); ctx.rotate(-1.1 + k * 0.37); ctx.beginPath(); ctx.ellipse(0, -120, 30, 128, 0, 0, TAU); ctx.fillStyle = k % 2 ? '#5f8a57' : '#7aa56e'; ctx.fill(); ctx.restore(); }
    ctx.save(); ctx.shadowColor = 'rgba(40,24,12,0.30)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 28;
    fillRR(ctx, x - sw / 2 - 14, y - sh / 2 - 14, sw + 28, sh + 28, 14, '#0d0d0f');
    ctx.restore();
  } else if (D.kind === 'car') {
    // From the driver's seat: the road and the coast through the windscreen,
    // the dashboard, the wheel with its instruments behind it, and the screen
    // standing in the middle of the dash.
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.beginPath(); ctx.rect(x - 1300, -400, 2600, 2000); ctx.clip();
    const sky = ctx.createLinearGradient(0, -60, 0, 470);
    sky.addColorStop(0, '#f2b386'); sky.addColorStop(0.55, '#f8d9bd'); sky.addColorStop(1, '#fdefdf');
    ctx.fillStyle = sky; ctx.fillRect(x - 1300, -400, 2600, 900);
    circle(ctx, x + 430, 418, 150, 'rgba(255,240,205,0.5)');
    circle(ctx, x + 430, 418, 64, '#fff6dd');
    // The sea on the right, the hills on the left, and the land the road runs through.
    ctx.fillStyle = '#9cc5d6'; ctx.fillRect(x + 150, 430, 1200, 130);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; for (let k = 0; k < 5; k++) ctx.fillRect(x + 300 + k * 150, 452 + k * 14, 90 + k * 18, 4);
    ctx.fillStyle = '#b6bfa9'; ctx.beginPath(); ctx.moveTo(x - 1300, 452); ctx.bezierCurveTo(x - 900, 300, x - 520, 420, x - 240, 396); ctx.bezierCurveTo(x - 90, 384, x + 40, 420, x + 150, 440); ctx.lineTo(x + 150, 560); ctx.lineTo(x - 1300, 560); ctx.fill();
    ctx.fillStyle = '#8e9b82'; ctx.beginPath(); ctx.moveTo(x - 1300, 478); ctx.bezierCurveTo(x - 800, 430, x - 300, 470, x + 190, 440); ctx.lineTo(x + 1300, 560); ctx.lineTo(x - 1300, 560); ctx.fill();
    // The road, running out to a point, with its centre line and the rail on the sea's side.
    const vx = x + 150, vy = 440;
    ctx.fillStyle = '#5b5856'; ctx.beginPath(); ctx.moveTo(vx - 10, vy); ctx.lineTo(vx + 14, vy); ctx.lineTo(x + 980, 620); ctx.lineTo(x - 760, 620); ctx.fill();
    ctx.fillStyle = '#f6f1e6';
    for (let k = 0; k < 6; k++) { const u = Math.pow(k / 6, 1.7), v = Math.pow((k + 0.55) / 6, 1.7), cxl = (q) => lerp(vx + 2, x + 110, q), wd = (q) => 1.5 + q * 13, yy = (q) => lerp(vy, 620, q); ctx.beginPath(); ctx.moveTo(cxl(u) - wd(u), yy(u)); ctx.lineTo(cxl(u) + wd(u), yy(u)); ctx.lineTo(cxl(v) + wd(v), yy(v)); ctx.lineTo(cxl(v) - wd(v), yy(v)); ctx.fill(); }
    ctx.strokeStyle = '#e9e4da'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(vx + 20, vy - 4); ctx.lineTo(x + 1020, 596); ctx.stroke();
    // The pillars at the windscreen's sides.
    ctx.fillStyle = '#141416';
    ctx.beginPath(); ctx.moveTo(x - 1300, -400); ctx.lineTo(x - 830, -400); ctx.lineTo(x - 980, 560); ctx.lineTo(x - 1300, 560); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 1300, -400); ctx.lineTo(x + 830, -400); ctx.lineTo(x + 980, 560); ctx.lineTo(x + 1300, 560); ctx.fill();
    // The dashboard, with a soft edge of light along its top.
    const dash = () => { ctx.beginPath(); ctx.moveTo(x - 1300, 548); ctx.bezierCurveTo(x - 700, 500, x + 700, 500, x + 1300, 548); ctx.lineTo(x + 1300, 1500); ctx.lineTo(x - 1300, 1500); ctx.closePath(); };
    const dg = ctx.createLinearGradient(0, 500, 0, 1100);
    dg.addColorStop(0, '#2a2a2e'); dg.addColorStop(0.18, '#1a1a1d'); dg.addColorStop(1, '#101012');
    dash(); ctx.fillStyle = dg; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 1300, 549); ctx.bezierCurveTo(x - 700, 501, x + 700, 501, x + 1300, 549); ctx.stroke();
    // The vents on the passenger's side.
    for (let k = 0; k < 2; k++) { fillRR(ctx, x + 520, 640 + k * 44, 380, 26, 13, '#0b0b0c'); for (let j = 0; j < 9; j++) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x + 544 + j * 40, 644 + k * 44, 4, 18); } }
    // The instruments, under their hood.
    ctx.fillStyle = '#17171a'; ctx.beginPath(); ctx.ellipse(x - 640, 566, 300, 86, 0, Math.PI, 0); ctx.fill();
    fillRR(ctx, x - 800, 552, 320, 104, 22, '#08080a');
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x - 740, 626, 40, Math.PI, Math.PI * 1.75); ctx.stroke();
    ctx.strokeStyle = LIVE_GREEN; ctx.beginPath(); ctx.arc(x - 740, 626, 40, Math.PI, Math.PI * 1.45); ctx.stroke();
    setFont(ctx, 800, 50, FONT.disp, -0.03); text(ctx, '62', x - 640, 624, { color: '#ffffff', align: 'center' });
    setFont(ctx, 600, 18, FONT.body, 0.04); text(ctx, 'km/h', x - 562, 622, { color: 'rgba(255,255,255,0.5)', align: 'center' });
    // The wheel: a rim, a hub and three spokes.
    const wx = x - 640, wy = 992, wr = 290;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    ring(ctx, wx, wy, wr, '#26262a', 54);
    ctx.restore();
    ring(ctx, wx, wy, wr + 22, 'rgba(255,255,255,0.07)', 3);
    ctx.strokeStyle = '#222226'; ctx.lineWidth = 58; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(wx - wr + 20, wy + 10); ctx.lineTo(wx - 90, wy + 6); ctx.moveTo(wx + 90, wy + 6); ctx.lineTo(wx + wr - 20, wy + 10); ctx.moveTo(wx, wy + 70); ctx.lineTo(wx, wy + wr - 20); ctx.stroke();
    fillRR(ctx, wx - 120, wy - 66, 240, 150, 46, '#1c1c20');
    strokeRR(ctx, wx - 120, wy - 66, 240, 150, 46, 'rgba(255,255,255,0.08)', 3);
    circle(ctx, wx, wy + 6, 22, '#2e2e33');
    ctx.restore();
    // The screen stands on a short foot in the middle of the dash.
    fillRR(ctx, x - 110, y + sh / 2 - 6, 220, 70, 16, '#0c0c0e');
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 22;
    fillRR(ctx, x - sw / 2 - 18, y - sh / 2 - 18, sw + 36, sh + 36, D.r + 14, '#050506');
    ctx.restore();
    strokeRR(ctx, x - sw / 2 - 17, y - sh / 2 - 17, sw + 34, sh + 34, D.r + 13, 'rgba(255,255,255,0.14)', 2);
  }
  ctx.restore();
}

// ---------- what It shows on each screen ----------
const SEAT = { rows: [11, 12, 13, 14, 15, 16], taken: ['11B', '11C', '12A', '12E', '13B', '13F', '15C', '15D', '16A', '16B', '16F', '12D'], pick: '14A' };
// The two ways to the airport on the car's map, and how far the new one has been drawn.
const CAR_A1 = [[96, 372], [126, 236], [240, 150], [372, 92]];
const CAR_COAST = resample([[96, 372], [250, 350], [410, 296], [456, 190], [372, 92]], 50);
const coastHead = (lt) => CAR_COAST[Math.min(49, Math.max(1, Math.floor(E.inOutCubic(prog(lt, WH.carRoute[0], WH.carRoute[1])) * 50)) - 1)];
const WHERE = {
  // The checklist, as it looks on a phone. You tick the umbrella the agent added.
  phone: {
    w: 340, h: 716,
    draw(ctx, w, h, lt, t) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      // While the camera is close the list sits exactly where the card was. As
      // the phone comes into view it settles under the status bar, which fades
      // in above it, so the clock and the island never lie over the title.
      const e = E.inOutCubic(prog(t, S3.a, S3.a + 0.75)), u = t - S3.a;
      const sc = w / THING.checklist.w;
      ctx.save(); ctx.translate(0, 50 * e); ctx.scale(sc, sc);
      THING.checklist.draw(ctx, THING.checklist.w, THING.checklist.h, 9, t, { umbrella: prog(u, WH.phoneTap, WH.phoneTap + 0.22), press: pressAt(u, WH.phoneTap) });
      ctx.restore();
      ctx.save(); ctx.globalAlpha *= e;
      setFont(ctx, 600, 17, FONT.body, 0);
      text(ctx, '9:41', 30, 30, { color: C.ink });
      fillRR(ctx, w - 58, 18, 30, 14, 4, C.ink);
      fillRR(ctx, w / 2 - 50, 12, 100, 28, 14, '#000');
      // Under the list, what is left to do, with Hermes's plate on the panel's corner.
      const heardAt = WH.phoneTap + 0.04 + BEAD3, done = u >= heardAt, k = tw(u, heardAt, 0.3, E.outBack);
      fillRR(ctx, 22, 508, w - 44, 150, 26, done ? mix('#f4f1ea', '#dff6ea', clamp(k)) : '#f4f1ea');
      setFont(ctx, 700, 30, FONT.body, -0.01);
      text(ctx, done ? 'All packed' : '1 thing left', 44, 590, { color: C.ink });
      setFont(ctx, 500, 19, FONT.body, 0);
      text(ctx, 'Flight Thursday 8:45', 44, 624, { color: C.ink3 });
      if (done) checkBadge(ctx, w - 66, 596, 22, clamp(k), C.mint);
      hermesPlate(ctx, 'phone', u, WH.phoneTap + 0.04, t);
      fillRR(ctx, w / 2 - 60, h - 16, 120, 6, 3, 'rgba(14,14,16,0.75)');
      ctx.restore();
    },
  },
  // The seat map, on a laptop. You pick a seat and the agent holds it.
  laptop: {
    w: 1000, h: 625,
    draw(ctx, w, h, lt, t) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      titleBlock(ctx, 'Window or aisle?', 'Lisbon, Thursday 8:45 · pick a seat', 56, 92);
      const picked = lt >= WH.lapClick + 0.02, held = tw(lt, WH.lapHeld, 0.3, E.outCubic);
      // A slice of the cabin.
      const x0 = 110, y0 = 200, s = 58, g = 12;
      setFont(ctx, 600, 22, FONT.body, 0);
      'ABC DEF'.split('').forEach((c, j) => { if (c !== ' ') text(ctx, c, x0 + 90 + j * (s + g) + s / 2, y0 - 14, { color: C.ink3, align: 'center' }); });
      SEAT.rows.forEach((row, i) => {
        const y = y0 + i * (s + g) * 0.95;
        text(ctx, String(row), x0 + 40, y + s * 0.62, { color: C.ink3, align: 'center' });
        'ABC DEF'.split('').forEach((c, j) => {
          if (c === ' ') return;
          const id = row + c, x = x0 + 90 + j * (s + g);
          const taken = SEAT.taken.includes(id), me = id === SEAT.pick;
          const sc = me ? 1 - 0.1 * pressAt(lt, WH.lapClick) : 1;
          ctx.save(); ctx.translate(x + s / 2, y + s * 0.42); ctx.scale(sc, sc);
          fillRR(ctx, -s / 2, -s * 0.42, s, s * 0.84, 12, me && picked ? mix(C.ink, C.mint, held) : taken ? '#e4e0d8' : '#fff');
          if (!taken && !(me && picked)) strokeRR(ctx, -s / 2 + 1.5, -s * 0.42 + 1.5, s - 3, s * 0.84 - 3, 11, me ? C.ink : '#cfc9bf', me ? 3 : 2);
          if (me && picked) drawCheck(ctx, -s * 0.32, -s * 0.36, s * 0.64, '#fff', 5, clamp((lt - WH.lapClick - 0.02) / 0.25));
          ctx.restore();
        });
      });
      // What was picked, and the agent's word on it.
      const a = tw(lt, WH.lapClick + 0.1, 0.3, E.outCubic);
      if (a > 0) {
        ctx.save(); ctx.globalAlpha *= a;
        fillRR(ctx, 680, 236 + (1 - a) * 20, 276, 232, 24, '#f4f1ea');
        setFont(ctx, 800, 72, FONT.disp, -0.03);
        text(ctx, '14A', 710, 326 + (1 - a) * 20, { color: C.ink });
        setFont(ctx, 500, 27, FONT.body, 0);
        text(ctx, 'Window seat', 712, 372 + (1 - a) * 20, { color: C.ink3 });
        ctx.restore();
        chip(ctx, 708, 398, 'Held for you', { fill: C.mint, k: held, check: true, size: 23 });
      }
      hermesPlate(ctx, 'laptop', lt, WH.lapClick + 0.04, t);
    },
    cursor: [[0.16, 880, 560], [WH.lapClick - 0.04, 229, 424], [1.25, 300, 540]],
  },
  // The films, on the TV. You pick one with the remote and the agent starts the download.
  tv: {
    w: 1180, h: 664,
    draw(ctx, w, h, lt, t) {
      ctx.fillStyle = '#121214'; ctx.fillRect(0, 0, w, h);
      titleBlock(ctx, 'A film for the flight?', 'Pick one and it downloads tonight', 70, 104, { color: '#fff', subColor: 'rgba(255,255,255,0.55)', size: 52 });
      const films = [['The Long Coast', '#e8744f', '#3a1f2d'], ['Paper Moons', '#7fa7e8', '#1f2a4a'], ['Salt & Fado', '#f2c65a', '#4a2a14']];
      const fx = E.inOutCubic(prog(lt, WH.tvFocus[0], WH.tvFocus[1]));
      const chosen = lt >= WH.tvPick;
      films.forEach(([name, a, b], i) => {
        const x = 70 + i * 360, y = 190, fw = 320, fh = 380;
        const g = ctx.createLinearGradient(x, y, x, y + fh);
        g.addColorStop(0, a); g.addColorStop(1, b);
        const sc = i === 1 && chosen ? 1.04 - 0.04 * prog(lt, WH.tvPick, WH.tvPick + 0.2) : 1;
        ctx.save(); ctx.translate(x + fw / 2, y + fh / 2); ctx.scale(sc, sc); ctx.translate(-(x + fw / 2), -(y + fh / 2));
        ctx.globalAlpha *= chosen && i !== 1 ? 0.4 : 1;
        fillRR(ctx, x, y, fw, fh, 18, g);
        circle(ctx, x + fw * 0.68, y + fh * 0.32, fw * 0.16, 'rgba(255,255,255,0.35)');
        setFont(ctx, 800, 40, FONT.disp, -0.03);
        text(ctx, name, x + 24, y + fh - 34, { color: '#fff' });
        ctx.restore();
      });
      // The remote's focus ring slides to the middle film.
      const rx = 70 + fx * 360;
      ctx.save();
      ctx.globalAlpha *= tw(lt, 0.12, 0.15);
      strokeRR(ctx, rx - 10, 180, 340, 400, 26, '#fff', 6);
      ctx.restore();
      // The agent's download, with how far it has got.
      const dl = tw(lt, WH.tvLoad - 0.05, 0.25, E.outCubic);
      if (dl > 0) {
        const p = E.outCubic(prog(lt, WH.tvLoad, WH.tvLoad + 0.55));
        ctx.save(); ctx.globalAlpha *= dl;
        setFont(ctx, 600, 26, FONT.body, 0);
        text(ctx, 'Downloading for the flight', 430, 628, { color: 'rgba(255,255,255,0.85)' });
        text(ctx, Math.round(p * 100) + '%', 430 + 680, 628, { color: '#fff', align: 'right' });
        fillRR(ctx, 430, 642, 680, 10, 5, 'rgba(255,255,255,0.18)');
        fillRR(ctx, 430, 642, Math.max(10, 680 * p), 10, 5, LIVE_GREEN);
        ctx.restore();
      }
      hermesPlate(ctx, 'tv', lt, WH.tvPick + 0.04, t);
    },
  },
  // The way to the airport, on the screen in the car. You take the coast road and the agent draws it.
  car: {
    w: 900, h: 430,
    draw(ctx, w, h, lt, t) {
      ctx.fillStyle = '#16171a'; ctx.fillRect(0, 0, w, h);
      // The map: a few streets, the sea, the motorway with its jam, and the coast road.
      ctx.save(); rr(ctx, 24, 24, 500, h - 48, 22); ctx.clip();
      ctx.fillStyle = '#22252b'; ctx.fillRect(24, 24, 500, h - 48);
      ctx.fillStyle = '#1b3440'; ctx.beginPath(); ctx.moveTo(524, 24); ctx.lineTo(524, 300); ctx.bezierCurveTo(470, 250, 500, 150, 430, 24); ctx.fill();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#33373f'; ctx.lineWidth = 9;
      for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.moveTo(24 + k * 104, 24); ctx.lineTo(64 + k * 96, h); ctx.stroke(); }
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(24, 110 + k * 110); ctx.lineTo(524, 150 + k * 100); ctx.stroke(); }
      const go = prog(lt, WH.carRoute[0], WH.carRoute[1]), alt = lt >= WH.carRoute[0];
      ctx.lineWidth = 15; ctx.strokeStyle = alt ? mix('#ff6d58', '#4a4d55', clamp(go * 2)) : '#ff6d58';
      polyPath(ctx, CAR_A1); ctx.stroke();
      if (go > 0) { ctx.strokeStyle = LIVE_GREEN; polyPath(ctx, CAR_COAST, Math.max(2, Math.floor(E.inOutCubic(go) * 50))); ctx.stroke(); }
      circle(ctx, 96, 372, 20, 'rgba(255,255,255,0.18)'); circle(ctx, 96, 372, 12, '#fff');
      // The airport.
      circle(ctx, 372, 92, 22, '#fff');
      ctx.save(); ctx.translate(372, 92); ctx.rotate(-0.6); ctx.fillStyle = '#16171a';
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(4, -3); ctx.lineTo(15, 4); ctx.lineTo(15, 8); ctx.lineTo(4, 4); ctx.lineTo(3, 11); ctx.lineTo(7, 14); ctx.lineTo(-7, 14); ctx.lineTo(-3, 11); ctx.lineTo(-4, 4); ctx.lineTo(-15, 8); ctx.lineTo(-15, 4); ctx.lineTo(-4, -3); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (!alt || go < 0.5) chip(ctx, 150, 150, '+25 min', { fill: '#ff6d58', size: 21, k: (1 - clamp(go * 2)) * tw(lt, 0.2, 0.25) });
      ctx.restore();
      // Hermes's message, under its plate.
      hermesPlate(ctx, 'car', lt, WH.carTap + 0.04, t);
      setFont(ctx, 700, 42, FONT.disp, -0.02);
      text(ctx, 'Traffic on the A1', 560, 124, { color: '#fff' });
      setFont(ctx, 500, 26, FONT.body, 0);
      text(ctx, 'The coast road still', 562, 164, { color: 'rgba(255,255,255,0.62)' });
      text(ctx, 'makes your 8:45 flight.', 562, 198, { color: 'rgba(255,255,255,0.62)' });
      const sc = 1 - 0.06 * pressAt(lt, WH.carTap), took = lt >= WH.carTap + 0.03;
      drawButton(ctx, 560, 226, 310, 78, took ? 'Coast road' : 'Take the coast road', { fill: took ? 'rgba(255,255,255,0.14)' : '#fff', color: took ? '#fff' : C.ink, size: 28, scale: sc });
      chip(ctx, 560, 326, 'Arrive 7:52 · on time', { fill: LIVE_GREEN, color: C.ink, size: 24, k: tw(lt, WH.carEta, 0.3, E.outCubic), check: true });
    },
    tap: [WH.carTap, 715, 265],
  },
};

// The card for this act: the checklist is already open on the phone; after
// that it closes into a full stop, hops to the next screen and opens there.
const WTRACK = new CardTrack();
Film.init(() => {
  const D = DEVW;
  WTRACK.add({ kind: 'hold', t: -1, to: { x: D[0].x, y: D[0].y, w: D[0].sw, h: D[0].sh, r: D[0].r, fill: '#ffffff', kind: WHERE.phone, k: 1, t0: S3.a } });
  for (let i = 1; i < 4; i++) {
    const t = S3.dev[i], A = D[i - 1], B = D[i];
    WTRACK.add({ kind: 'close', t: t - 0.44, d: 0.22, to: stopPose(A.x, A.y, 26), ease: E.inCubic });
    WTRACK.add({ kind: 'fly', t: t - 0.22, d: 0.34, to: stopPose(B.x, B.y, 26), arc: 160 });
    WTRACK.add({ kind: 'open', t: t + 0.12, to: { x: B.x, y: B.y, w: B.sw, h: B.sh, r: B.r, fill: i === 2 || i === 3 ? '#121214' : '#ffffff', kind: WHERE[B.kind] }, f: 2.3, z: 0.82 });
  }
  const last = D[3];
  WTRACK.add({ kind: 'close', t: S3.agents - 0.5, d: 0.22, to: stopPose(last.x, last.y, 26), ease: E.inCubic });
});

// What you do on each screen, on its way to Hermes's plate, in the world the
// camera pans across: [when it sets off, from where, which screen].
const HEARD3 = [];
Film.init(() => {
  const D = DEVW, on = (i, x, y) => [D[i].x - D[i].sw / 2 + x, D[i].y - D[i].sh / 2 + y];
  const open = (i) => S3.dev[i] + 0.12;
  const sc = D[0].sw / THING.checklist.w;
  HEARD3.push([S3.a + WH.phoneTap + 0.04, ...on(0, 78 * sc, 50 + (CHK.top + 5 * CHK.row + 36) * sc), 0, 0.6]);
  HEARD3.push([open(1) + WH.lapClick + 0.04, ...on(1, 229, 430), 1, 0.9]);
  HEARD3.push([open(2) + WH.tvPick + 0.04, ...on(2, 590, 380), 2, 1]);
  HEARD3.push([open(3) + WH.carTap + 0.04, ...on(3, 715, 265), 3, 0.85]);
  agentPart({ heard: HEARD3, bead: BEAD3 });
});
function beads3(ctx, t) {
  for (const [th, fx, fy, i, size] of HEARD3) {
    if (t < th || t > th + BEAD3 + 0.5) continue;
    const D = DEVW[i], Hm = HERMES[D.kind];
    const B = plateBox(ctx, D.x - D.sw / 2 + Hm.x, D.y - D.sh / 2 + Hm.y, 'Hermes', Hm);
    drawRipple(ctx, B.cx, B.cy, t, th + BEAD3, LIVE_GREEN, 80 * size, 0.45);
    returnBead(ctx, t, th, [fx, fy], [B.cx, B.cy], { dur: BEAD3, size });
  }
}

// Screen content fills its screen exactly (no card shadow: the device is the frame).
function drawScreenCard(ctx, t, pose) {
  if (!pose) return;
  if (pose.stop || pose.w < 34) { stopMark(ctx, pose.x, pose.y, pose.w, pose.fill); return; }
  ctx.save();
  fillRR(ctx, pose.x - pose.w / 2, pose.y - pose.h / 2, pose.w, pose.h, pose.r, pose.fill);
  rr(ctx, pose.x - pose.w / 2, pose.y - pose.h / 2, pose.w, pose.h, pose.r); ctx.clip();
  drawContent(ctx, pose, pose.kind, pose.k, pose.t0, t);
  ctx.restore();
}

// "It": from the end of the checklist sentence to the headline, to "It works
// with", and back to "It can be".
function itWord3(ctx, t) {
  setFont(ctx, 800, HL3.size, FONT.disp, -0.035);
  const w1 = measure(ctx, 'It goes where you are.');
  const head = { x: CX - w1 / 2, y: HL3.y, size: HL3.size };
  setFont(ctx, 800, AG.s1, FONT.disp, -0.035);
  const w2 = measure(ctx, 'It works with');
  const ag = { x: CX - w2 / 2, y: AG.y1, size: AG.s1 };
  const stack = { x: STACK.x, y: STACK.y1, size: STACK.size };
  const seg = (A, B, a, b) => { const e = E.inOutCubic(prog(t, a, b)); return { x: lerp(A.x, B.x, e), y: lerp(A.y, B.y, e), size: Math.exp(lerp(Math.log(A.size), Math.log(B.size), e)) }; };
  let p;
  if (t < S3.headOut) p = seg(stack, head, S3.a - 0.05, S3.a + 0.5);
  else if (t < S3.canbe - 0.26) p = seg(head, ag, S3.agents - 0.45, S3.agents);
  else p = seg(ag, stack, S3.canbe - 0.26, S3.canbe + 0.14);
  setFont(ctx, 800, p.size, FONT.disp, -0.035);
  text(ctx, 'It', p.x, p.y, { color: C.ink });
  return { head, ag };
}

function sceneWhere(ctx, t) {
  paper(ctx);
  const c = cam3(t);
  // Devices and the card, in world space.
  if (t < S3.agents + 0.06) {
    ctx.save();
    ctx.translate(CX, CY); ctx.scale(c.z, c.z); ctx.translate(-c.x, -c.y);
    const out = tw(t, S3.agents - 0.35, 0.4, E.inCubic);
    ctx.globalAlpha *= 1 - out;
    ctx.translate(0, out * 700);
    for (const D of DEVW) if (Math.abs(D.x - c.x) < 2600) drawDevice(ctx, D);
    const pose = WTRACK.at(t);
    if (pose && !(pose.stop && t > S3.agents - 0.3)) drawScreenCard(ctx, t, pose);
    // Your part: a fingertip on the phone and in the car, a pointer on the laptop.
    {
      const Ph = DEVW[0], sc = Ph.sw / THING.checklist.w, u = t - S3.a;
      const bx = Ph.x - Ph.sw / 2 + 78 * sc, by = Ph.y - Ph.sh / 2 + 50 + (CHK.top + 5 * CHK.row + 36) * sc;
      touchPath(ctx, u, [[WH.phoneTap - 0.4, bx + 150, by + 260], [WH.phoneTap - 0.03, bx, by], [WH.phoneTap + 0.35, bx + 70, by + 150]], { taps: [WH.phoneTap] });
    }
    const L = DEVW[1], ltL = t - (S3.dev[1] + 0.12);
    if (ltL > 0.16 && ltL < 1.45) {
      const [x, y] = keyPos(WHERE.laptop.cursor, ltL);
      const px = L.x - L.sw / 2 + x, py = L.y - L.sh / 2 + y;
      ctx.save(); ctx.globalAlpha *= tw(ltL, 0.16, 0.15) * (1 - tw(ltL, 1.22, 0.2));
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + 40); ctx.lineTo(px + 11, py + 30); ctx.lineTo(px + 19, py + 46); ctx.lineTo(px + 25, py + 43); ctx.lineTo(px + 17, py + 28); ctx.lineTo(px + 30, py + 28); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
    }
    const Cr = DEVW[3], ltC = t - (S3.dev[3] + 0.12), [tt, tx, ty] = WHERE.car.tap;
    const bx = Cr.x - Cr.sw / 2 + tx, by = Cr.y - Cr.sh / 2 + ty;
    touchPath(ctx, ltC, [[tt - 0.38, bx + 200, by + 300], [tt - 0.03, bx, by], [tt + 0.4, bx + 90, by + 190]], { taps: [tt], dark: true });
    drawRipple(ctx, bx, by, ltC, tt + 0.02, '#ffffff', 100);
    // Your answer, on its way to the agent's plate.
    beads3(ctx, t);
    ctx.restore();
  }
  itWord3(ctx, t);
  // "It goes where you are."
  setFont(ctx, 800, HL3.size, FONT.disp, -0.035);
  const w1 = measure(ctx, 'It goes where you are.'), wIt = measure(ctx, 'It ');
  riseLine(ctx, 'goes where you are.', CX - w1 / 2 + wIt, HL3.y, HL3.size, t, S3.head, { stagger: 0.06, dur: 0.5, out: { t: S3.headOut, stagger: 0.02, dur: 0.26 } });

  // "It works with" and the agents, each ending in the full stop.
  if (t >= S3.agents - 0.1) {
    setFont(ctx, 800, AG.s1, FONT.disp, -0.035);
    const w2 = measure(ctx, 'It works with'), wIt2 = measure(ctx, 'It ');
    riseLine(ctx, 'works with', CX - w2 / 2 + wIt2, AG.y1, AG.s1, t, S3.agents, { stagger: 0.06, dur: 0.5, out: { t: S3.canbe - 0.26, stagger: 0.02, dur: 0.25 } });
    if (t < S3.canbe - 0.26) {
      setFont(ctx, 800, AG.s2, FONT.disp, -0.04);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, AG.y2 - AG.s2 * 0.95, W, AG.s2 * 1.25); ctx.clip();
      rollWords(ctx, AGENTS, AGENT_T, t, CX, AG.y2, AG.s2, {
        dur: 0.4,
        draw: (g, k, x, y) => {
          const w = measure(g, AGENTS[k]), s = AG.s2 * 0.15;
          text(g, AGENTS[k], x - (w + s + AG.s2 * 0.035) / 2, y, { color: k === AGENTS.length - 1 ? C.coral : C.ink });
          stopMark(g, x + (w + s + AG.s2 * 0.035) / 2 - s / 2, y - s / 2, s, C.ink);
        },
      });
      ctx.restore();
    } else yoursAt(ctx, t);
  }

  // "It can be yours." through the break, then the drop rolls "yours" away.
  if (t >= S3.canbe) {
    setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
    riseLine(ctx, 'can be', STACK.canX, STACK.y1, STACK.size, t, S3.canbe + 0.08, { stagger: 0.06, dur: 0.5, maskPad: 0.05 });
  }
}

// "yours." glides from the middle of the agents' line to the second line of
// "It can be", where the drop picks it up. Its full stop pulses on the beats of
// the break.
function yoursAt(ctx, t) {
  const e = E.inOutCubic(prog(t, S3.canbe - 0.26, S3.canbe + 0.14));
  setFont(ctx, 800, AG.s2, FONT.disp, -0.04);
  const w0 = measure(ctx, 'yours'), g0 = AG.s2 * 0.035, s0 = AG.s2 * 0.15;
  const A = { x: CX - (w0 + s0 + g0) / 2, y: AG.y2, size: AG.s2, ls: -0.04 };
  const B = { x: STACK.x, y: STACK.y2, size: STACK.size, ls: -0.035 };
  const size = Math.exp(lerp(Math.log(A.size), Math.log(B.size), e));
  const x = lerp(A.x, B.x, e), y = lerp(A.y, B.y, e);
  setFont(ctx, 800, size, FONT.disp, lerp(A.ls, B.ls, e));
  const w = measure(ctx, 'yours'), s = size * 0.15;
  text(ctx, 'yours', x, y, { color: C.coral });
  let pulse = 0;
  for (let k = 1; k < 4; k++) { const b0 = bar(23, k); if (t >= b0) pulse = Math.max(pulse, Math.exp(-(t - b0) * 9)); }
  const ps = s * (1 + 0.45 * pulse);
  stopMark(ctx, x + w + size * 0.035 + s / 2, y - s / 2, ps, C.ink);
}

Film.scene(S3.a, S3.b, sceneWhere, 'where');

// ════ things-drop.js ════
// The eight things It becomes after the drop, one bar each, and each of them a
// turn taken by two: you do one thing on the second beat, your answer goes
// back to the agent, and the agent does the next thing on the third, in the
// page's own way. Each thing names its agent, and may say when it is `busy`,
// which `beats` it nods on, when it is `asleep`, or, on a canvas, where its
// `hand` goes. Local time `lt` starts on the bar's downbeat; the card is open
// by about 0.3 s.

const TAP2 = 2 * BEAT;
const YOU2 = BEAT;      // when you act
const ACT2 = TAP2;      // when the agent acts
function chip(ctx, x, y, s, { fill = C.ink, color = '#fff', size = 24, check = false, k = 1 } = {}) {
  if (k <= 0) return;
  setFont(ctx, 700, size, FONT.body, 0);
  const w = measure(ctx, s) + size * 1.4 + (check ? size * 1.1 : 0), h = size * 2;
  ctx.save();
  ctx.globalAlpha *= clamp(k * 2);
  const sc = E.outBack(clamp(k));
  ctx.translate(x + w / 2, y + h / 2); ctx.scale(sc, sc); ctx.translate(-(x + w / 2), -(y + h / 2));
  fillRR(ctx, x, y, w, h, h / 2, fill);
  if (check) drawCheck(ctx, x + size * 0.45, y + size * 0.35, size * 1.3, color, size * 0.17, clamp(k * 1.5));
  text(ctx, s, x + size * 0.7 + (check ? size * 1.1 : 0), y + h / 2 + size * 0.36, { color });
  ctx.restore();
  return w;
}

// ---------- a quiz: you answer, the agent marks it ----------
THING.quiz = {
  w: 700, h: 640,
  draw(ctx, w, h, lt) {
    setFont(ctx, 600, 25, FONT.body, 0);
    text(ctx, 'Question 3 of 10', 56, 78, { color: C.ink3 });
    setFont(ctx, 700, 50, FONT.disp, -0.03);
    text(ctx, 'What’s the capital', 56, 150, { color: C.ink });
    text(ctx, 'of Australia?', 56, 206, { color: C.ink });
    const opts = ['Sydney', 'Canberra', 'Melbourne', 'Perth'];
    const chose = lt >= YOU2 + 0.03, marked = tw(lt, ACT2, 0.22, E.outCubic);
    opts.forEach((o, i) => {
      const x = 56 + (i % 2) * 304, y = 262 + Math.floor(i / 2) * 116, bw = 284, bh = 96;
      const me = i === 1;
      const sc = me ? 1 - 0.05 * pressAt(lt, YOU2) : 1;
      ctx.save(); ctx.translate(x + bw / 2, y + bh / 2); ctx.scale(sc, sc); ctx.translate(-(x + bw / 2), -(y + bh / 2));
      ctx.globalAlpha *= chose && !me ? lerp(1, 0.4, tw(lt, YOU2 + 0.03, 0.2)) : 1;
      const k = me ? marked : 0;
      fillRR(ctx, x, y, bw, bh, 22, mix('#f3efe7', C.mint, k));
      if (me && chose && k < 1) strokeRR(ctx, x + 2, y + 2, bw - 4, bh - 4, 20, C.ink, 4 * (1 - k));
      setFont(ctx, 700, 32, FONT.body, -0.01);
      text(ctx, o, x + 32, y + 60, { color: mix(C.ink, '#ffffff', k) });
      if (k > 0) drawCheck(ctx, x + bw - 70, y + 24, 48, '#fff', 6, clamp(k * 1.5));
      ctx.restore();
    });
    chip(ctx, 56, 528, 'Correct · 3 in a row', { fill: C.ink, k: tw(lt, ACT2 + 0.16, 0.3, E.outCubic) });
  },
  tap: [YOU2, 56 + 304 + 142, 262 + 48],
  agent: { name: 'Pi' },
};

// ---------- a floor plan: you move the sofa, the agent measures the gap ----------
const PLAN_R = { x: 70, y: 136, w: 600, h: 450 };
THING.plan = {
  w: 740, h: 640,
  draw(ctx, w, h, lt) {
    setFont(ctx, 700, 44, FONT.disp, -0.03);
    text(ctx, 'Where does the sofa go?', 56, 86, { color: C.ink });
    const R = PLAN_R;
    fillRR(ctx, R.x, R.y, R.w, R.h, 6, '#faf7f1');
    ctx.strokeStyle = C.ink; ctx.lineWidth = 12; ctx.lineJoin = 'miter';
    ctx.beginPath(); ctx.moveTo(R.x + 130, R.y + R.h); ctx.lineTo(R.x, R.y + R.h); ctx.lineTo(R.x, R.y); ctx.lineTo(R.x + R.w, R.y); ctx.lineTo(R.x + R.w, R.y + R.h); ctx.lineTo(R.x + 250, R.y + R.h); ctx.stroke();
    ctx.lineWidth = 3; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.arc(R.x + 130, R.y + R.h, 120, Math.PI, Math.PI * 1.5); ctx.stroke(); ctx.setLineDash([]);
    // Window on the top wall.
    ctx.fillStyle = '#9fd2ff'; ctx.fillRect(R.x + 330, R.y - 6, 200, 12);
    // Rug, table, chair, TV.
    fillRR(ctx, R.x + 150, R.y + 70, 300, 170, 18, '#efe3d0');
    fillRR(ctx, R.x + 250, R.y + 120, 110, 70, 10, '#c9a27e');
    fillRR(ctx, R.x + 470, R.y + 60, 100, 100, 18, '#d9d2c5');
    fillRR(ctx, R.x + R.w - 36, R.y + 150, 22, 170, 4, C.ink2);
    // The sofa: dragged from the middle of the room to the wall by the door.
    const g = E.inOutCubic(prog(lt, 0.24, YOU2)), snap = lt >= YOU2;
    const sx = lerp(R.x + 230, R.x + 96, g), sy = lerp(R.y + 250, R.y + 318, g), rot = lerp(-0.18, 0, g);
    const f = E.outCubic(prog(lt, ACT2, ACT2 + 0.28));
    ctx.save();
    ctx.translate(sx + 150, sy + 44); ctx.rotate(rot + (snap ? wobble(lt, YOU2, 7, 12) * 0.02 : 0));
    ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = lt > 0.24 && !snap ? 22 : 6; ctx.shadowOffsetY = lt > 0.24 && !snap ? 12 : 3;
    fillRR(ctx, -150, -44, 300, 88, 16, C.coral);
    ctx.shadowColor = 'transparent';
    for (let k = 0; k < 3; k++) fillRR(ctx, -134 + k * 92, -30, 84, 50, 10, '#ff7a66');
    fillRR(ctx, -150, 22, 300, 22, 10, '#e14d38');
    ctx.restore();
    // The agent's measure: the gap between the sofa and the swing of the door.
    if (f > 0) {
      const y = R.y + 426, x0 = R.x + 96, x1 = lerp(x0, R.x + 396, f);
      ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.moveTo(x0, y - 12); ctx.lineTo(x0, y + 12); ctx.moveTo(x1, y - 12); ctx.lineTo(x1, y + 12); ctx.stroke();
    }
    chip(ctx, R.x + 266, R.y + 206, 'Fits, 4 cm to spare', { fill: C.ink, k: tw(lt, ACT2 + 0.3, 0.3, E.outCubic), check: true, size: 24 });
  },
  drag: [0.24, 70 + 230 + 150, 136 + 250 + 44, 70 + 96 + 150, 136 + 318 + 44],
  // A plan is a canvas: Codex pulls the measure across by hand.
  agent: {
    name: 'Codex',
    hand: {
      keys: [[ACT2, 70 + 96, 136 + 426], [ACT2 + 0.28, 70 + 396, 136 + 426], [ACT2 + 0.5, 70 + 396, 136 + 426]],
      track: (lt) => (lt >= ACT2 && lt <= ACT2 + 0.28 ? [lerp(70 + 96, 70 + 396, E.outCubic(prog(lt, ACT2, ACT2 + 0.28))), 136 + 426] : null),
    },
  },
};

// ---------- a calendar: you move dinner, the agent checks all four diaries ----------
const CAL = { x: 110, y: 170, cw: 124, rh: 88, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], hours: ['5 pm', '6 pm', '7 pm', '8 pm'] };
const CAL_SWEEP = 0.34;   // how long the agent takes to go along the four of them
THING.cal = {
  w: 760, h: 640,
  draw(ctx, w, h, lt) {
    setFont(ctx, 700, 44, FONT.disp, -0.03);
    text(ctx, 'When can all four do dinner?', 56, 86, { color: C.ink });
    setFont(ctx, 600, 22, FONT.body, 0);
    CAL.days.forEach((d, i) => text(ctx, d, CAL.x + i * CAL.cw + CAL.cw / 2, CAL.y - 18, { color: C.ink3, align: 'center' }));
    CAL.hours.forEach((hh, j) => text(ctx, hh, CAL.x - 14, CAL.y + j * CAL.rh + 26, { color: C.ink3, align: 'right' }));
    for (let i = 0; i <= 5; i++) { ctx.fillStyle = C.line; ctx.fillRect(CAL.x + i * CAL.cw - 1, CAL.y, 2, CAL.rh * 4); }
    for (let j = 0; j <= 4; j++) { ctx.fillStyle = C.line; ctx.fillRect(CAL.x, CAL.y + j * CAL.rh - 1, CAL.cw * 5, 2); }
    const busy = [[0, 0, 2], [1, 1, 2], [2, 0, 1], [2, 2, 2], [4, 1, 3], [3, 0, 1]];
    for (const [d, a, n] of busy) fillRR(ctx, CAL.x + d * CAL.cw + 6, CAL.y + a * CAL.rh + 6, CAL.cw - 12, n * CAL.rh - 12, 12, '#e7e2d8');
    // Dinner, dragged from Tuesday to Thursday at 7.
    const g = E.inOutCubic(prog(lt, 0.24, YOU2));
    const ex = lerp(CAL.x + 1 * CAL.cw, CAL.x + 3 * CAL.cw, g), ey = CAL.y + 2 * CAL.rh;
    const lifted = lt > 0.24 && lt < YOU2, ok = tw(lt, ACT2 + CAL_SWEEP, 0.25, E.outCubic);
    ctx.save();
    if (lifted) { ctx.shadowColor = 'rgba(0,0,0,0.22)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 10; }
    fillRR(ctx, ex + 6, ey + 6, CAL.cw - 12, CAL.rh * 2 - 12, 14, mix(C.coral, C.mint, ok));
    ctx.restore();
    setFont(ctx, 700, 24, FONT.body, 0);
    text(ctx, 'Dinner', ex + 20, ey + 42, { color: '#fff' });
    setFont(ctx, 500, 20, FONT.body, 0);
    text(ctx, '7:00', ex + 20, ey + 70, { color: 'rgba(255,255,255,0.85)' });
    // The four of them, ticked one after another as the agent goes along the row.
    const people = ['#ff9ec6', '#9fd2ff', '#ffd84d', '#8fe3bd'];
    people.forEach((c, i) => {
      const x = 80 + i * 62, y = 560;
      circle(ctx, x, y, 26, c);
      ring(ctx, x, y, 26, '#fff', 4);
      const at = ACT2 + (i / 3) * CAL_SWEEP;
      const k = prog(lt, at, at + 0.16);
      if (k > 0) checkBadge(ctx, x + 18, y - 18, 13, k, C.mint);
    });
    chip(ctx, 340, 536, 'Everyone’s free', { fill: C.ink, k: tw(lt, ACT2 + CAL_SWEEP + 0.04, 0.3, E.outCubic) });
  },
  drag: [0.24, 110 + 124 * 1.5, 170 + 88 * 3, 110 + 124 * 3.5, 170 + 88 * 3],
  agent: { name: 'Claude', busy: [YOU2 + 0.04 + BEAD, ACT2 + CAL_SWEEP] },
};

// ---------- a drum machine: you play the beats, the agent plays between them ----------
const PADS = ['#ff4f8b', '#ff8a3d', '#c9f27a', '#3ee0e8'];
// Your pads, one on each beat, and the agent's, on the half beats after it has heard the first.
const DRUM_YOU = [12, 13, 9, 5];
const DRUM_AGENT = [[1.5, 6], [2.5, 3], [3.5, 10]];
const drumPad = (id, w = 640) => { const g = 16, s = (w - 100 - 3 * g) / 4; return [50 + (id % 4) * (s + g) + s / 2, 130 + Math.floor(id / 4) * (s + g) + s / 2]; };
THING.drums = {
  w: 640, h: 716,
  draw(ctx, w, h, lt) {
    setFont(ctx, 700, 44, FONT.disp, -0.03);
    text(ctx, 'Make a beat.', 50, 84, { color: '#fff' });
    chip(ctx, w - 50 - 136, 48, '118 BPM', { fill: 'rgba(255,255,255,0.12)', color: '#fff', size: 22 });
    const g = 16, s = (w - 100 - 3 * g) / 4;
    const hitAt = new Map();
    DRUM_YOU.forEach((id, b) => hitAt.set(id, [b * BEAT, false]));
    DRUM_AGENT.forEach(([b, id]) => hitAt.set(id, [b * BEAT, true]));
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const id = r * 4 + c, x = 50 + c * (s + g), y = 130 + r * (s + g);
      const hit = hitAt.get(id);
      const glow = hit && lt >= hit[0] ? Math.exp(-(lt - hit[0]) * 5) : 0, on = hit && lt >= hit[0] ? 1 : 0;
      const col = PADS[r];
      ctx.save();
      if (glow > 0.05) { ctx.shadowColor = col; ctx.shadowBlur = 44 * glow; }
      fillRR(ctx, x, y, s, s, 18, mix('#2a2a30', col, 0.3 + 0.35 * on + 0.35 * glow));
      ctx.restore();
      const sc = 1 - 0.05 * glow;
      if (glow > 0.3) strokeRR(ctx, x + (1 - sc) * s / 2, y + (1 - sc) * s / 2, s * sc, s * sc, 18, 'rgba(255,255,255,0.5)', 3);
      // A pad the agent played keeps the green dot of its plate, so its part can be told from yours.
      if (hit && hit[1] && on) { circle(ctx, x + s - 24, y + 24, 12, 'rgba(14,14,16,0.55)'); circle(ctx, x + s - 24, y + 24, 8, LIVE_GREEN); }
    }
  },
  agent: { name: 'OpenCode', heard: [[0.03, ...drumPad(12)]], beats: DRUM_AGENT.map(([b]) => b * BEAT) },
};

// ---------- a seating chart: you move one guest, the agent fills the gap ----------
const TABLES = [{ x: 190, y: 280, n: 'Table 1' }, { x: 520, y: 250, n: 'Table 2' }, { x: 370, y: 480, n: 'Table 3' }];
const seatAt = (ti, k) => { const a = -Math.PI / 2 + (k / 6) * TAU; return [TABLES[ti].x + Math.cos(a) * 100, TABLES[ti].y + Math.sin(a) * 100]; };
const SEAT_MOVE = 0.36;   // how long the agent's own move takes
THING.seats = {
  w: 700, h: 640,
  draw(ctx, w, h, lt) {
    setFont(ctx, 700, 44, FONT.disp, -0.03);
    text(ctx, 'Wedding seating', 56, 86, { color: C.ink });
    const cols = ['#9fd2ff', '#ffd84d', '#cdb6ff', '#ff9ec6', '#8fe3bd'];
    TABLES.forEach((T, ti) => {
      circle(ctx, T.x, T.y, 70, '#f1ece2');
      setFont(ctx, 700, 26, FONT.body, 0);
      text(ctx, T.n.replace('Table ', ''), T.x, T.y + 10, { color: C.ink3, align: 'center' });
      for (let k = 0; k < 6; k++) {
        const [x, y] = seatAt(ti, k);
        // Bob's old seat, the seat he moves to, and the seat the agent's guest leaves.
        if ((ti === 0 && k === 1) || (ti === 2 && k === 4) || (ti === 1 && k === 4)) { ring(ctx, x, y, 22, '#d6d0c4', 3); continue; }
        circle(ctx, x, y, 24, cols[(ti * 6 + k) % cols.length]);
      }
    });
    // Aunt May, whom the agent moves into the seat Bob left, to keep the table even.
    const m0 = seatAt(1, 4), m1 = seatAt(0, 1), mg = E.inOutCubic(prog(lt, ACT2, ACT2 + SEAT_MOVE));
    circle(ctx, lerp(m0[0], m1[0], mg), lerp(m0[1], m1[1], mg) - Math.sin(mg * Math.PI) * 26, 25, '#3d7bff');
    // Uncle Bob, moved to the far table.
    const p0 = seatAt(0, 1), p1 = seatAt(2, 4);
    const g = E.inOutCubic(prog(lt, 0.24, YOU2));
    const x = lerp(p0[0], p1[0], g), y = lerp(p0[1], p1[1], g) - Math.sin(g * Math.PI) * 30;
    circle(ctx, x, y, 26, C.coral);
    setFont(ctx, 700, 26, FONT.body, 0);
    const lw = measure(ctx, 'Uncle Bob') + 30, lx = x - 64 * g;
    fillRR(ctx, lx - lw / 2, y - 80, lw, 44, 22, C.ink);
    text(ctx, 'Uncle Bob', lx, y - 49, { color: '#fff', align: 'center' });
    chip(ctx, 460, 560, 'Much better', { fill: C.ink, k: tw(lt, ACT2 + SEAT_MOVE + 0.02, 0.3, E.outCubic), check: true, size: 22 });
  },
  dragFrom: () => seatAt(0, 1),
  dragTo: () => seatAt(2, 4),
  // A seating chart is a canvas too: Hermes carries its guest across by hand.
  agent: {
    name: 'Hermes',
    hand: {
      keys: [[ACT2, ...seatAt(1, 4)], [ACT2 + SEAT_MOVE, ...seatAt(0, 1)], [ACT2 + SEAT_MOVE + 0.14, ...seatAt(0, 1)]], clicks: [ACT2],
      track: (lt) => { if (lt < ACT2 || lt > ACT2 + SEAT_MOVE) return null; const a = seatAt(1, 4), b = seatAt(0, 1), g = E.inOutCubic(prog(lt, ACT2, ACT2 + SEAT_MOVE)); return [lerp(a[0], b[0], g), lerp(a[1], b[1], g) - Math.sin(g * Math.PI) * 26]; },
    },
  },
};

// ---------- a mood board ----------
function photo(ctx, x, y, w, h, k) {
  ctx.save(); rr(ctx, x, y, w, h, 16); ctx.clip();
  const P = [
    () => { const g = ctx.createLinearGradient(x, y, x, y + h); g.addColorStop(0, '#ff9a6b'); g.addColorStop(1, '#ffd29a'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); circle(ctx, x + w * 0.5, y + h * 0.62, w * 0.2, '#fff3dc'); ctx.fillStyle = '#e0694a'; ctx.fillRect(x, y + h * 0.72, w, h); },
    () => { ctx.fillStyle = '#dfe8d6'; ctx.fillRect(x, y, w, h); for (let i = 0; i < 5; i++) { ctx.fillStyle = ['#5f8a57', '#7aa56e', '#3f6b40'][i % 3]; ctx.beginPath(); ctx.ellipse(x + w * (0.3 + i * 0.1), y + h * 0.5, w * 0.08, h * 0.32, -0.5 + i * 0.25, 0, TAU); ctx.fill(); } fillRR(ctx, x + w * 0.35, y + h * 0.7, w * 0.3, h * 0.3, 8, '#c77a52'); },
    () => { ctx.fillStyle = '#efe7da'; ctx.fillRect(x, y, w, h); fillRR(ctx, x + w * 0.2, y + h * 0.3, w * 0.28, h * 0.55, 30, '#b88a6a'); fillRR(ctx, x + w * 0.52, y + h * 0.42, w * 0.3, h * 0.43, 40, '#e2c9ab'); },
    () => { const g = ctx.createLinearGradient(x, y, x, y + h); g.addColorStop(0, '#9fd2ff'); g.addColorStop(0.55, '#e6f4ff'); g.addColorStop(0.56, '#3d7bff'); g.addColorStop(1, '#1e4fc2'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); },
    () => { ctx.fillStyle = '#f5efe4'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#e5dccd'; ctx.lineWidth = 6; for (let i = -4; i < 10; i++) { ctx.beginPath(); ctx.moveTo(x + i * 30, y); ctx.lineTo(x + i * 30 + h * 0.4, y + h); ctx.stroke(); } },
    () => { ctx.fillStyle = '#ffe07a'; ctx.fillRect(x, y, w, h); circle(ctx, x + w * 0.4, y + h * 0.45, w * 0.24, '#ff9f1c'); circle(ctx, x + w * 0.4, y + h * 0.45, w * 0.17, '#ffc15e'); circle(ctx, x + w * 0.72, y + h * 0.7, w * 0.16, '#9bd35a'); },
  ];
  P[k]();
  ctx.restore();
}
function heart(ctx, x, y, s, fill, k = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s * k, s * k);
  ctx.beginPath(); ctx.moveTo(0, 0.35); ctx.bezierCurveTo(-0.5, 0, -0.5, -0.45, 0, -0.2); ctx.bezierCurveTo(0.5, -0.45, 0.5, 0, 0, 0.35); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
}
// Two more pictures in the same vein, which the agent brings in.
function photoMore(ctx, x, y, w, h, k) {
  ctx.save(); rr(ctx, x, y, w, h, 16); ctx.clip();
  if (k === 0) {
    ctx.fillStyle = '#e4ecdb'; ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 4; i++) { ctx.fillStyle = ['#6f9a63', '#4f7b4c', '#8db47e'][i % 3]; ctx.beginPath(); ctx.ellipse(x + w * (0.3 + i * 0.14), y + h * 0.46, w * 0.07, h * 0.3, -0.6 + i * 0.4, 0, TAU); ctx.fill(); }
    fillRR(ctx, x + w * 0.36, y + h * 0.68, w * 0.28, h * 0.32, 8, '#e8dccb');
  } else {
    const g = ctx.createLinearGradient(x, y, x, y + h); g.addColorStop(0, '#bfe3ff'); g.addColorStop(0.6, '#eaf6ff'); g.addColorStop(0.61, '#4b86f0'); g.addColorStop(1, '#2a5bd0'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    circle(ctx, x + w * 0.72, y + h * 0.3, w * 0.1, '#fff6d6');
  }
  ctx.restore();
}
const MOOD_NEW = [[2, ACT2, 0], [4, ACT2 + 0.26, 1]];   // tile, when the agent swaps it, which new picture
const moodAt = (k) => [56 + (k % 3) * 214 + 98, 128 + Math.floor(k / 3) * 214 + 98];
THING.mood = {
  w: 740, h: 640,
  picks: [[1, 0.26], [3, YOU2]],
  draw(ctx, w, h, lt) {
    setFont(ctx, 700, 44, FONT.disp, -0.03);
    text(ctx, 'Pick the vibe.', 56, 86, { color: C.ink });
    const s = 196, g = 18;
    for (let k = 0; k < 6; k++) {
      const x = 56 + (k % 3) * (s + g), y = 128 + Math.floor(k / 3) * (s + g);
      const pk = this.picks.find((p) => p[0] === k);
      const on = pk ? tw(lt, pk[1], 0.25, E.outCubic) : 0;
      const sw = MOOD_NEW.find((m) => m[0] === k);
      const fl = sw ? prog(lt, sw[1], sw[1] + 0.3) : 0;            // the agent's swap: the tile turns over
      const sc = pk ? 1 - 0.05 * pressAt(lt, pk[1]) : 1, sx = sw ? Math.abs(Math.cos(fl * Math.PI)) : 1;
      ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.scale(sc * Math.max(0.02, sx), sc); ctx.translate(-(x + s / 2), -(y + s / 2));
      if (sw && fl > 0.5) { photoMore(ctx, x, y, s, s, sw[2]); strokeRR(ctx, x - 5, y - 5, s + 10, s + 10, 20, LIVE_GREEN, 5 * (1 - prog(lt, sw[1] + 0.5, sw[1] + 0.9))); }
      else photo(ctx, x, y, s, s, k);
      if (on > 0) strokeRR(ctx, x - 5, y - 5, s + 10, s + 10, 20, C.ink, 5 * on);
      if (!(sw && fl > 0.5)) {
        circle(ctx, x + s - 30, y + 30, 20, on > 0 ? C.ink : 'rgba(255,255,255,0.85)');
        heart(ctx, x + s - 30, y + 30, 26, on > 0 ? C.coral : 'rgba(14,14,16,0.25)', on > 0 ? 1 + 0.3 * Math.sin(on * Math.PI) : 1);
      }
      ctx.restore();
    }
    chip(ctx, 56, 560, 'Two more like these', { fill: C.ink, k: tw(lt, ACT2 + 0.5, 0.3, E.outCubic), size: 22 });
  },
  agent: { name: 'Pi', busy: [YOU2 + 0.04 + BEAD, ACT2 + 0.5] },
};

// ---------- a dashboard: you ask about the jump, the agent pins the reason to it ----------
const DASH = [0.3, 0.34, 0.31, 0.4, 0.45, 0.42, 0.5, 0.58, 0.55, 0.66, 0.72, 0.7, 0.8, 0.9];
const DASH_BOX = { x0: 56, x1: 740 - 56, y0: 520, y1: 250 };
const DASH_ASK = [lerp(DASH_BOX.x0, DASH_BOX.x1, 9 / 13), lerp(DASH_BOX.y0, DASH_BOX.y1, DASH[9])];   // the point you tap
THING.dash = {
  w: 740, h: 600,
  draw(ctx, w, h, lt, t) {
    setFont(ctx, 600, 28, FONT.body, 0);
    text(ctx, 'Signups today', 56, 80, { color: C.ink3 });
    const n = Math.round(lerp(1204, 1286, E.outCubic(prog(frameTime(t) - (t - lt), 0.15, 1.2))));
    setFont(ctx, 800, 120, FONT.disp, -0.04);
    text(ctx, n.toLocaleString('en-US'), 50, 196, { color: C.ink });
    chip(ctx, 470, 124, '+12% today', { fill: C.mint, size: 24, k: tw(lt, 0.3, 0.3, E.outCubic) });
    const { x0, x1, y0, y1 } = DASH_BOX;
    for (let i = 0; i < 4; i++) { ctx.fillStyle = C.line; ctx.fillRect(x0, lerp(y0, y1, i / 3), x1 - x0, 2); }
    const d = E.inOutCubic(prog(lt, 0.08, 0.46));
    const pts = DASH.map((v, i) => [lerp(x0, x1, i / (DASH.length - 1)), lerp(y0, y1, v)]);
    const rs = resample(pts, 120), m = Math.max(2, Math.floor(d * 120));
    const g = ctx.createLinearGradient(0, y1, 0, y0);
    g.addColorStop(0, 'rgba(31,184,119,0.35)'); g.addColorStop(1, 'rgba(31,184,119,0)');
    ctx.beginPath(); ctx.moveTo(rs[0][0], y0);
    for (let i = 0; i < m; i++) ctx.lineTo(rs[i][0], rs[i][1]);
    ctx.lineTo(rs[m - 1][0], y0); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = C.mint; ctx.lineWidth = 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    polyPath(ctx, rs, m); ctx.stroke();
    const [ex, ey] = rs[m - 1];
    circle(ctx, ex, ey, 10, C.mint);
    // The point you asked about, and what the agent found for it.
    const [ax, ay] = DASH_ASK, asked = tw(lt, YOU2 + 0.02, 0.2, E.outBack);
    if (asked > 0) { circle(ctx, ax, ay, 17 * asked, '#fff'); circle(ctx, ax, ay, 11 * asked, C.ink); }
    const pin = tw(lt, ACT2, 0.3, E.outCubic);
    if (pin > 0) {
      ctx.save(); ctx.globalAlpha *= pin;
      ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ax, ay - 16); ctx.lineTo(ax, ay - 16 - 52 * pin); ctx.stroke();
      ctx.restore();
      setFont(ctx, 700, 24, FONT.body, 0);
      const cw = measure(ctx, 'Your post went live') + 34;
      chip(ctx, ax - cw / 2, ay - 122, 'Your post went live', { fill: C.ink, size: 24, k: pin });
    }
  },
  tap: [YOU2, DASH_ASK[0], DASH_ASK[1]],
  agent: { name: 'Codex' },
};

// ---------- a big red button ----------
const CONF = [];
Film.init(() => {
  const r = rng(77);
  const cols = ['#ff5b45', '#ffd84d', '#1fb877', '#9fd2ff', '#0e0e10', '#ff9ec6', '#cdb6ff'];
  for (let i = 0; i < 70; i++) {
    const a = -Math.PI / 2 + (r() - 0.5) * 2.6, sp = 700 + r() * 1300;
    CONF.push({ vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: r() * TAU, vr: (r() - 0.5) * 18, w: 12 + r() * 14, h: 7 + r() * 9, c: cols[i % cols.length], round: r() < 0.3 });
  }
});
function confetti(ctx, x, y, u, a = 1) {
  if (u <= 0 || u > 1.6) return;
  for (const P of CONF) {
    const px = x + P.vx * u * 0.6, py = y + P.vy * u * 0.6 + 900 * u * u;
    ctx.save(); ctx.globalAlpha *= a * clamp((1.6 - u) * 2);
    ctx.translate(px, py); ctx.rotate(P.rot + P.vr * u);
    if (P.round) circle(ctx, 0, 0, P.h * 0.6, P.c); else { ctx.fillStyle = P.c; ctx.fillRect(-P.w / 2, -P.h / 2, P.w, P.h); }
    ctx.restore();
  }
}
THING.button = {
  w: 560, h: 620,
  draw(ctx, w, h, lt, t) {
    setFont(ctx, 700, 40, FONT.disp, -0.03);
    text(ctx, 'The new homepage', w / 2, 84, { color: C.ink, align: 'center' });
    text(ctx, 'is ready.', w / 2, 132, { color: C.ink, align: 'center' });
    const cx = w / 2, cy = 380, R = 170;
    const press = pressAt(lt, YOU2, 0.16), going = lt >= YOU2 + 0.06, done = lt >= ACT2;
    circle(ctx, cx, cy + 16, R, '#a3170b');
    const dy = press * 12 + (going && !done ? 6 : 0);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
    circle(ctx, cx, cy + dy, R, done ? mix('#ff3b24', C.mint, tw(lt, ACT2, 0.22)) : '#ff3b24');
    ctx.restore();
    const gl = ctx.createRadialGradient(cx - 50, cy - 70 + dy, 10, cx, cy + dy, R);
    gl.addColorStop(0, 'rgba(255,255,255,0.45)'); gl.addColorStop(0.5, 'rgba(255,255,255,0.05)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    circle(ctx, cx, cy + dy, R, gl);
    // While the agent ships it, a ring runs round the button.
    if (going && !done) {
      const p = prog(lt, YOU2 + 0.06, ACT2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy + dy, R - 22, -Math.PI / 2, -Math.PI / 2 + TAU * E.inOutCubic(p)); ctx.stroke();
    }
    setFont(ctx, 800, 62, FONT.disp, -0.035);
    text(ctx, done ? 'Shipped' : going ? 'Shipping' : 'Ship it', cx, cy + 22 + dy, { color: '#fff', align: 'center' });
  },
  tap: [YOU2, 280, 380],
  agent: { name: 'Claude' },
};

// ---------- hours later: the agent's conversation is closed, and your answer wakes it ----------
// Two bars. The question has been waiting since the afternoon. You answer it at
// night, your answer goes back, the agent that asked comes back for it and does
// the work, and the page says so.
const LATE = { tap: 2 * BEAT, work: [4 * BEAT, 4 * BEAT + 0.95], done: 6 * BEAT };
THING.late = {
  w: 700, h: 640,
  draw(ctx, w, h, lt) {
    setFont(ctx, 600, 25, FONT.body, 0);
    text(ctx, 'Codex asked at 5:40 pm', 56, 78, { color: C.ink3 });
    setFont(ctx, 700, 50, FONT.disp, -0.03);
    text(ctx, 'Run the migration', 56, 150, { color: C.ink });
    text(ctx, 'on production?', 56, 206, { color: C.ink });
    const said = lt >= LATE.tap + 0.03, k = tw(lt, LATE.tap + 0.03, 0.2, E.outCubic);
    const sc = 1 - 0.05 * pressAt(lt, LATE.tap);
    ctx.save(); ctx.translate(56 + 142, 262 + 48); ctx.scale(sc, sc); ctx.translate(-(56 + 142), -(262 + 48));
    fillRR(ctx, 56, 262, 284, 96, 22, C.ink);
    setFont(ctx, 700, 32, FONT.body, -0.01);
    text(ctx, 'Run it', 56 + 142, 322, { color: '#fff', align: 'center' });
    ctx.restore();
    ctx.save(); ctx.globalAlpha *= said ? lerp(1, 0.35, k) : 1;
    strokeRR(ctx, 362, 264, 280, 92, 20, '#cfc9bf', 3);
    text(ctx, 'Not yet', 360 + 142, 322, { color: C.ink2, align: 'center' });
    ctx.restore();
    // What the agent is doing about it, with the time on the clock.
    const heard = LATE.tap + 0.04 + BEAD, woke = tw(lt, heard, 0.3, E.outCubic);
    const work = prog(lt, LATE.work[0], LATE.work[1]), done = tw(lt, LATE.done, 0.3, E.outCubic);
    fillRR(ctx, 40, 410, w - 80, 180, 26, mix('#f1ede5', '#e3f6ec', done));
    chip(ctx, 62, 432, '11:02 pm', { fill: C.ink, size: 22 });
    circle(ctx, 76, 524, 10, woke > 0 ? LIVE_GREEN : '#b9b6ae');
    if (woke > 0 && done <= 0) ring(ctx, 76, 524, 10 + 14 * ((lt * 1.6) % 1), rgba(LIVE_GREEN, 0.5 * (1 - ((lt * 1.6) % 1))), 3);
    setFont(ctx, 700, 32, FONT.body, -0.01);
    const line = done > 0 ? 'Migrated. Tests pass.' : work > 0 ? 'Codex is running it' : woke > 0 ? 'Codex is back' : 'Its conversation is closed';
    text(ctx, line, 102, 535, { color: woke > 0 ? C.ink : C.ink3 });
    if (work > 0 && done <= 0) { fillRR(ctx, 62, 558, w - 124, 10, 5, 'rgba(14,14,16,0.12)'); fillRR(ctx, 62, 558, Math.max(10, (w - 124) * E.inOutCubic(work)), 10, 5, LIVE_GREEN); }
    if (done > 0) checkBadge(ctx, w - 86, 524, 22, done, C.mint);
  },
  tap: [LATE.tap, 56 + 142, 262 + 48],
  agent: { name: 'Codex', heard: [[LATE.tap + 0.04, 56 + 142, 262 + 48]], asleep: [0.16, LATE.tap + 0.04 + BEAD], busy: [LATE.work[0], LATE.done] },
};

// ════ things-reel.js ════
// The fast reel: sixteen more things, two beats each and then one beat each.
// Each is one glance: a shape you recognise and one small motion.

const REEL = [
  ['a tier list', 'tier'], ['a poll', 'poll'], ['a timeline', 'timeline'], ['a game', 'game'],
  ['a palette', 'palette'], ['a signature', 'sign'], ['a storyboard', 'story'], ['a scoreboard', 'score'],
  ['a form', 'form'], ['a playlist', 'playlist'], ['a slide deck', 'deck'], ['a flashcard', 'flash'],
  ['a timer', 'timer'], ['a budget', 'budget'], ['a menu', 'menu'], ['a photo booth', 'booth'],
];
const RC = { w: 600, h: 600 };
const RDRAW = {
  tier(ctx, w, h, u) {
    const rows = [['S', '#ff6d58'], ['A', '#ffb896'], ['B', '#ffd84d'], ['C', '#c9f27a']];
    rows.forEach(([l, c], i) => {
      const y = 70 + i * 120;
      fillRR(ctx, 50, y, 100, 100, 16, c);
      setFont(ctx, 800, 54, FONT.disp, 0); text(ctx, l, 100, y + 70, { color: C.ink, align: 'center' });
      fillRR(ctx, 164, y, 386, 100, 16, '#f3efe7');
      const n = [3, 2, 2, 1][i];
      for (let k = 0; k < n; k++) fillRR(ctx, 176 + k * 96, y + 12, 84, 76, 12, ['#3d7bff', '#1fb877', '#cdb6ff'][(i + k) % 3]);
    });
    const e = E.outBack(clamp(u * 3));
    fillRR(ctx, 176 + 2 * 96, 70 + 1 * 120 + 12 - (1 - e) * 60, 84, 76, 12, C.ink);
  },
  poll(ctx, w, h, u) {
    setFont(ctx, 700, 44, FONT.disp, -0.03); text(ctx, 'Friday lunch?', 50, 100, { color: C.ink });
    [['Tacos', 0.62], ['Ramen', 0.26], ['Salad', 0.12]].forEach(([l, v], i) => {
      const y = 160 + i * 130;
      fillRR(ctx, 50, y, 500, 100, 20, '#f3efe7');
      fillRR(ctx, 50, y, 500 * v * E.outCubic(clamp(u * 2.5)), 100, 20, i ? '#e2dccf' : C.coral);
      setFont(ctx, 700, 32, FONT.body, 0); text(ctx, l, 80, y + 62, { color: i ? C.ink : '#fff' });
      text(ctx, `${Math.round(v * 100 * clamp(u * 2.5))}%`, 520, y + 62, { color: C.ink, align: 'right' });
    });
  },
  timeline(ctx, w, h, u) {
    ctx.fillStyle = C.ink; ctx.fillRect(80, 300, 430 * E.outCubic(clamp(u * 2)), 8);
    ['Plan', 'Build', 'Test', 'Launch'].forEach((l, i) => {
      const x = 90 + i * 140, k = clamp(u * 3 - i * 0.4);
      circle(ctx, x, 304, 26 * E.outBack(k), i === 3 ? C.coral : C.ink);
      setFont(ctx, 700, 30, FONT.body, 0); text(ctx, l, x, i % 2 ? 390 : 250, { color: C.ink, align: 'center', alpha: k });
    });
  },
  game(ctx, w, h, u) {
    ctx.strokeStyle = C.ink; ctx.lineWidth = 12; ctx.lineCap = 'round';
    for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(100 + i * 133, 100); ctx.lineTo(100 + i * 133, 500); ctx.stroke(); ctx.beginPath(); ctx.moveTo(100, 100 + i * 133); ctx.lineTo(500, 100 + i * 133); ctx.stroke(); }
    const X = (c, r) => { const x = 166 + c * 133, y = 166 + r * 133; ctx.strokeStyle = C.coral; ctx.beginPath(); ctx.moveTo(x - 36, y - 36); ctx.lineTo(x + 36, y + 36); ctx.moveTo(x + 36, y - 36); ctx.lineTo(x - 36, y + 36); ctx.stroke(); };
    const O = (c, r) => ring(ctx, 166 + c * 133, 166 + r * 133, 40, C.sky, 12);
    X(0, 0); O(1, 1); X(2, 0); O(0, 2);
    if (u > 0.3) X(1, 0);
    if (u > 0.4) { ctx.strokeStyle = C.ink; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(120, 166); ctx.lineTo(120 + 360 * E.outCubic(prog(u, 0.4, 0.8)), 166); ctx.stroke(); }
  },
  palette(ctx, w, h, u) {
    const cols = ['#ff6d58', '#ffb896', '#ffd84d', '#c9f27a', '#8fe3bd', '#86e1e6', '#9fd2ff', '#3d7bff', '#cdb6ff', '#ff9ec6', '#0e0e10', '#f3efe7'];
    cols.forEach((c, i) => { const x = 60 + (i % 4) * 124, y = 90 + Math.floor(i / 4) * 150; fillRR(ctx, x, y, 110, 130, 18, c); if (i === 5) strokeRR(ctx, x - 7, y - 7, 124, 144, 24, C.ink, 6 * E.outBack(clamp(u * 3))); });
  },
  sign(ctx, w, h, u) {
    setFont(ctx, 600, 28, FONT.body, 0); text(ctx, 'Sign here', 60, 390, { color: C.ink3 });
    ctx.fillStyle = C.ink; ctx.fillRect(60, 360, 480, 3);
    const pts = []; for (let i = 0; i <= 60; i++) { const s = i / 60; pts.push([90 + s * 400, 320 - Math.sin(s * 14) * 40 * (1 - s * 0.5) - Math.sin(s * 5) * 30]); }
    ctx.strokeStyle = C.sky; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    polyPath(ctx, pts, Math.max(2, Math.floor(clamp(u * 1.8) * 61))); ctx.stroke();
  },
  story(ctx, w, h, u) {
    for (let i = 0; i < 3; i++) {
      const x = 40 + i * 180, y = 190;
      fillRR(ctx, x, y, 160, 220, 14, '#f3efe7');
      circle(ctx, x + 80, y + 80, 26, ['#ffb896', '#9fd2ff', '#ffd84d'][i]);
      fillRR(ctx, x + 50, y + 116, 60, 70, 20, C.ink2);
      setFont(ctx, 700, 24, FONT.body, 0); text(ctx, String(i + 1), x + 80, y + 250, { color: C.ink3, align: 'center' });
    }
  },
  score(ctx, w, h, u) {
    fillRR(ctx, 40, 150, 520, 300, 30, C.ink);
    setFont(ctx, 700, 28, FONT.body, 0);
    text(ctx, 'HOME', 170, 220, { color: 'rgba(255,255,255,0.6)', align: 'center' }); text(ctx, 'AWAY', 430, 220, { color: 'rgba(255,255,255,0.6)', align: 'center' });
    setFont(ctx, 800, 140, FONT.disp, -0.03);
    text(ctx, u > 0.4 ? '3' : '2', 170, 390, { color: '#fff', align: 'center' }); text(ctx, '2', 430, 390, { color: '#fff', align: 'center' });
  },
  form(ctx, w, h, u) {
    ['Name', 'Email', 'Company'].forEach((l, i) => {
      const y = 90 + i * 130;
      setFont(ctx, 600, 26, FONT.body, 0); text(ctx, l, 60, y, { color: C.ink3 });
      strokeRR(ctx, 60, y + 16, 480, 76, 16, i === 1 ? C.ink : '#d6d0c4', 3);
    });
    drawButton(ctx, 60, 480, 480, 80, 'Send', { fill: C.ink, size: 30 });
  },
  playlist(ctx, w, h, u) {
    for (let i = 0; i < 4; i++) {
      const y = 90 + i * 120;
      fillRR(ctx, 60, y, 90, 90, 14, ['#ff6d58', '#3d7bff', '#ffd84d', '#1fb877'][i]);
      fillRR(ctx, 176, y + 22, 260 - i * 30, 20, 10, C.ink); fillRR(ctx, 176, y + 56, 160, 14, 7, C.ink4);
      if (i === 1) { circle(ctx, 500, y + 45, 30, C.ink); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(492, y + 30); ctx.lineTo(514, y + 45); ctx.lineTo(492, y + 60); ctx.fill(); }
    }
  },
  deck(ctx, w, h, u) {
    fillRR(ctx, 50, 120, 500, 330, 18, '#f3efe7');
    setFont(ctx, 800, 44, FONT.disp, -0.03); text(ctx, 'Q3 in one slide', 80, 190, { color: C.ink });
    [0.4, 0.6, 0.5, 0.85].forEach((v, i) => fillRR(ctx, 90 + i * 110, 420 - 190 * v * E.outCubic(clamp(u * 3)), 70, 190 * v, 10, i === 3 ? C.coral : C.ink));
    for (let i = 0; i < 5; i++) circle(ctx, 250 + i * 26, 500, 7, i === 2 ? C.ink : C.ink4);
  },
  flash(ctx, w, h, u) {
    fillRR(ctx, 60, 130, 480, 340, 28, C.ink);
    setFont(ctx, 800, 60, FONT.disp, -0.03); text(ctx, 'obrigado', 300, 300, { color: '#fff', align: 'center' });
    setFont(ctx, 600, 28, FONT.body, 0); text(ctx, 'tap to flip', 300, 370, { color: 'rgba(255,255,255,0.5)', align: 'center' });
  },
  timer(ctx, w, h, u) {
    ring(ctx, 300, 300, 190, '#f3efe7', 34);
    ctx.strokeStyle = C.coral; ctx.lineWidth = 34; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(300, 300, 190, -Math.PI / 2, -Math.PI / 2 + TAU * (0.7 - u * 0.2)); ctx.stroke();
    setFont(ctx, 800, 110, FONT.disp, -0.03); text(ctx, '4:59', 300, 340, { color: C.ink, align: 'center' });
  },
  budget(ctx, w, h, u) {
    const parts = [[0.4, '#3d7bff'], [0.25, '#ffd84d'], [0.2, '#1fb877'], [0.15, '#ff6d58']];
    let a = -Math.PI / 2;
    for (const [v, c] of parts) { ctx.strokeStyle = c; ctx.lineWidth = 80; ctx.beginPath(); ctx.arc(300, 300, 170, a, a + TAU * v * E.outCubic(clamp(u * 2.5)) - 0.03); ctx.stroke(); a += TAU * v * E.outCubic(clamp(u * 2.5)); }
    setFont(ctx, 800, 64, FONT.disp, -0.03); text(ctx, '$2,400', 300, 322, { color: C.ink, align: 'center' });
  },
  menu(ctx, w, h, u) {
    setFont(ctx, 800, 50, FONT.disp, -0.03); text(ctx, 'Tonight', 60, 110, { color: C.ink });
    [['Burrata', '14'], ['Cacio e pepe', '19'], ['Branzino', '28'], ['Tiramisu', '9']].forEach(([n, p], i) => {
      const y = 200 + i * 90;
      setFont(ctx, 600, 34, FONT.body, 0); text(ctx, n, 60, y, { color: C.ink }); text(ctx, p, 540, y, { color: C.ink, align: 'right' });
      if (i === 1) circle(ctx, 36, y - 12, 10, C.coral);
    });
  },
  booth(ctx, w, h, u) {
    for (let i = 0; i < 4; i++) {
      const x = 80 + (i % 2) * 230, y = 70 + Math.floor(i / 2) * 230;
      fillRR(ctx, x, y, 210, 210, 16, ['#ffb896', '#9fd2ff', '#cdb6ff', '#ffd84d'][i]);
      circle(ctx, x + 105, y + 90, 44, '#fff3e6'); fillRR(ctx, x + 45, y + 150, 120, 60, 30, '#fff3e6');
    }
    ctx.save(); ctx.globalAlpha *= (1 - clamp(u * 4)) * 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.restore();
  },
};
for (const [noun, k] of REEL) THING['r_' + k] = { w: RC.w, h: RC.h, draw(ctx, w, h, lt) { RDRAW[k](ctx, w, h, clamp(lt / 0.5)); } };

// ════ scene-drop.js ════
// The drop. On the downbeat after the break, the waiting full stop bursts into
// a quiz on a pink field, and from then on It changes on every bar: a floor
// plan, a calendar, a drum machine, a seating chart, a mood board, a dashboard
// and a big red button. On each you take one turn and the agent takes the next,
// and one plate on the card's corner is handed from agent to agent as the card
// changes. Then the reel runs faster and faster, until the question.

const DROP = [
  { kind: 'quiz', noun: 'a quiz', field: FIELD.quiz },
  { kind: 'plan', noun: 'a floor plan', field: FIELD.plan },
  { kind: 'cal', noun: 'a calendar', field: FIELD.cal },
  { kind: 'drums', noun: 'a drum machine', field: FIELD.drums, dark: true },
  { kind: 'seats', noun: 'a seating chart', field: FIELD.seats },
  { kind: 'mood', noun: 'a mood board', field: FIELD.mood },
  { kind: 'dash', noun: 'a dashboard', field: FIELD.dash },
  { kind: 'button', noun: 'a big red button', field: FIELD.button, dark: true },
  // Two bars at night: the answer that comes hours later, and the closed conversation it wakes.
  { kind: 'late', noun: 'hours later', field: '#171a2b', dark: true },
];
DROP.forEach((d, i) => { d.t = bar(24 + i); d.bar = 24 + i; });
// The reel takes up after it: twelve things in two bars, a beat each and then half a beat.
const REEL_BEATS = [8, 9, 10, 11, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5];
const REEL_FIELDS = [FIELD.cal, FIELD.plan, FIELD.tomato, FIELD.mood, FIELD.seats, FIELD.quiz, FIELD.peach, FIELD.aqua, FIELD.lime, FIELD.rose, FIELD.cal, FIELD.plan];
const REELS = REEL.slice(4).map(([noun, k], i) => ({ kind: 'r_' + k, noun, field: REEL_FIELDS[i], t: bar(32, REEL_BEATS[i]) }));
const ITEMS = [...DROP, ...REELS];
ITEMS.forEach((d, i) => { d.end = i + 1 < ITEMS.length ? ITEMS[i + 1].t : bar(36); });
const S4 = { a: bar(24), reel: bar(32), b: bar(36) };
Film.shake(S4.a, 0.45, 16, 24);
Film.flash(S4.a, 0.22, '#ffffff', 0.4);
ITEMS.forEach((d) => Film.boost(d.t - 0.03, d.t + 0.3, 18));

const DTRACK = new CardTrack();
Film.init((ctx) => {
  setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
  for (const d of ITEMS) {
    const T = THING[d.kind];
    d.nounW = measure(ctx, d.noun);
    const s = STACK.size * 0.15;
    d.stop = { x: STACK.x + d.nounW + STACK.size * 0.035 + s / 2, y: STACK.y2 - s / 2, s };
    const x = Math.min(1900 - 40 - T.w / 2, Math.max(1400, STACK.x + d.nounW + 90 + T.w / 2));
    d.card = { x, y: 540, w: T.w, h: T.h };
  }
  const first = ITEMS[0];
  DTRACK.add({ kind: 'hold', t: -1, to: stopPose(first.stop.x, first.stop.y, first.stop.s) });
  DTRACK.add({ kind: 'open', t: first.t, to: P(first.card.x, first.card.y, first.card.w, first.card.h, { kind: first.kind }), f: 2.2, z: 0.7 });
  ITEMS.slice(1).forEach((d) => {
    const fast = d.t >= bar(34);
    DTRACK.add({
      kind: 'morph', t: d.t, to: P(d.card.x, d.card.y, d.card.w, d.card.h, { kind: d.kind, fill: d.kind === 'drums' ? '#1b1b1f' : C.card }),
      f: fast ? 3.4 : 2.4, z: 0.7, inA: fast ? 0.02 : 0.08, inB: fast ? 0.08 : 0.22,
    });
  });
});
const itemAt = (t) => { let k = 0; ITEMS.forEach((d, i) => { if (t >= d.t) k = i; }); return k; };
// The noun line starts from "yours.", where the breakdown leaves it.
const ROLL = [{ noun: 'yours', t: -1, color: C.coral }, ...ITEMS];
Film.init((ctx) => {
  setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
  const s = STACK.size * 0.15;
  ROLL[0].stop = { x: STACK.x + measure(ctx, 'yours') + STACK.size * 0.035 + s / 2, y: STACK.y2 - s / 2, s };
});

// The fields: each new colour grows out of the card as a circle.
function fields(ctx, t) {
  const k = itemAt(t), d = ITEMS[k];
  const prev = k > 0 ? ITEMS[k - 1].field : C.paper;
  ctx.fillStyle = prev; ctx.fillRect(0, 0, W, H);
  const dur = d.t >= bar(34) ? 0.2 : 0.38;
  const p = E.outCubic(prog(t, d.t, d.t + dur));
  const pose = DTRACK.at(t);
  const ox = k === 0 ? d.stop.x : pose ? pose.x : d.card.x, oy = k === 0 ? d.stop.y : pose ? pose.y : d.card.y;
  ctx.save();
  ctx.beginPath(); ctx.arc(ox, oy, Math.max(0.01, p * 2300), 0, TAU); ctx.fillStyle = d.field; ctx.fill();
  ctx.restore();
  return { dark: !!d.dark, prevDark: k > 0 && !!ITEMS[k - 1].dark, p };
}

function touchDrop(ctx, t) {
  const at = (d, x, y) => [d.card.x - d.card.w / 2 + x, d.card.y - d.card.h / 2 + y];
  for (const d of DROP) {
    const lt = t - d.t, T = THING[d.kind];
    if (lt < 0 || lt > d.end - d.t + 0.1) continue;
    const dark = false;   // every card but the drum machine is light, and that one draws its own taps
    if (T.tap) {
      const [tt, px, py] = T.tap, [x, y] = at(d, px, py);
      touchPath(ctx, lt, [[tt - 0.36, x + 180, y + 300], [tt - 0.04, x, y], [tt + 0.4, x + 80, y + 170]], { taps: [tt], dark });
      drawRipple(ctx, x, y, lt, tt + 0.02, dark ? '#fff' : C.ink, 110);
    }
    if (T.drag) {
      const [t0, x0, y0, x1, y1] = T.drag, [ax, ay] = at(d, x0, y0), [bx, by] = at(d, x1, y1);
      touchPath(ctx, lt, [[t0 - 0.2, ax + 130, ay + 220], [t0, ax, ay], [YOU2, bx, by], [YOU2 + 0.4, bx + 70, by + 160]], { taps: [t0] });
    }
    if (d.kind === 'seats') {
      const [ax, ay] = at(d, ...T.dragFrom()), [bx, by] = at(d, ...T.dragTo());
      touchPath(ctx, lt, [[0.04, ax + 130, ay + 220], [0.24, ax, ay], [YOU2, bx, by], [YOU2 + 0.4, bx - 90, by + 150]], { taps: [0.24] });
    }
    if (d.kind === 'mood') {
      const [x1, y1] = at(d, moodAt(1)[0] + 68, moodAt(1)[1] - 68), [x2, y2] = at(d, moodAt(3)[0] + 68, moodAt(3)[1] - 68);
      const [p1, p2] = T.picks.map((q) => q[1]);
      touchPath(ctx, lt, [[p1 - 0.22, x1 + 140, y1 + 240], [p1 - 0.03, x1, y1], [p2 - 0.03, x2, y2], [p2 + 0.4, x2 + 80, y2 + 170]], { taps: [p1, p2] });
    }
    if (d.kind === 'drums') {
      const seq = DRUM_YOU.map((id, b) => [b * BEAT, ...at(d, ...drumPad(id))]);
      const keys = [[-0.25, seq[0][1] + 120, seq[0][2] + 200]];
      for (const [tt, x, y] of seq) keys.push([tt - 0.05, x, y], [tt + 0.08, x, y]);
      keys.push([3 * BEAT + 0.4, seq[3][1] + 90, seq[3][2] + 170]);
      touchPath(ctx, lt, keys, { taps: seq.map((q) => q[0]), dark: true });
    }
  }
  // Confetti from the big red button, when the agent has shipped.
  const B = DROP[7], lt = t - B.t;
  if (lt > ACT2) confetti(ctx, B.card.x, B.card.y - B.card.h / 2 + 380, lt - ACT2 - 0.02, 1 - prog(lt, 1.78, 2.0));
}

// The agents of the drop. One plate rides the top right corner of the card and
// its name rolls as the card changes. Where a card does not say what the agent
// hears, it hears what you did there: your tap, or the place you let go.
let AGENT_DROP = null;
Film.init(() => {
  const A = {
    names: [], heard: [], busy: [], beats: [], asleep: [], hands: [], in: DROP[0].t + 0.34, out: ITEMS[DROP.length].t - 0.24,
    at: (t) => { const p = DTRACK.at(t); return [p.x + p.w / 2 - 28, p.y - p.h / 2]; },
  };
  const darks = [];
  DROP.forEach((d, i) => {
    const T = THING[d.kind], G = T.agent, L = (lt) => d.t + lt;
    const at = (x, y) => [d.card.x - d.card.w / 2 + x, d.card.y - d.card.h / 2 + y];
    A.names.push([i ? d.t + 0.04 : 0, G.name]);
    let from = null;
    if (T.tap) from = [T.tap[1], T.tap[2]];
    else if (T.drag) from = [T.drag[3], T.drag[4]];
    else if (d.kind === 'seats') from = T.dragTo();
    else if (d.kind === 'mood') from = [moodAt(3)[0] + 68, moodAt(3)[1] - 68];
    for (const [lt, x, y] of G.heard ?? (from ? [[YOU2 + 0.04, ...from]] : [])) A.heard.push([L(lt), ...at(x, y)]);
    if (G.busy) A.busy.push(G.busy.map(L));
    if (G.asleep) A.asleep.push(G.asleep.map(L));
    for (const b of G.beats || []) A.beats.push(L(b));
    if (G.hand) A.hands.push({
      keys: G.hand.keys.map(([lt, x, y]) => [L(lt), ...at(x, y)]), clicks: (G.hand.clicks || []).map(L),
      track: G.hand.track ? (t) => { const q = G.hand.track(t - d.t); return q ? at(q[0], q[1]) : null; } : null,
    });
    if (d.kind === 'drums') darks.push([d.t, d.end]);
  });
  A.dark = (t) => { let k = 0; for (const [a, b] of darks) k = Math.max(k, tw(t, a, 0.25, E.outCubic) * (1 - tw(t, b, 0.25, E.outCubic))); return k; };
  AGENT_DROP = agentPart(A);
});

function sceneDrop(ctx, t) {
  const F = fields(ctx, t);
  const k = itemAt(t), d = ITEMS[k];
  // Type goes white on the dark fields.
  const dk = lerp(F.prevDark ? 1 : 0, F.dark ? 1 : 0, clamp(F.p * 2.2));
  const ink = mix(C.ink, '#ffffff', dk);
  setFont(ctx, 800, STACK.size, FONT.disp, -0.035);
  text(ctx, 'It can be', STACK.x, STACK.y1, { color: ink });
  // The noun rolls, starting from "yours." on the downbeat of the drop.
  rollWords(ctx, ROLL.map((i) => i.noun), ROLL.map((i) => i.t), t, STACK.x, STACK.y2, STACK.size, {
    dur: t >= bar(34) ? 0.18 : 0.3,
    draw: (g, j, x, y) => {
      const it = ROLL[j];
      text(g, it.noun, x, y, { color: it.color ?? ink });
      stopMark(g, it.stop.x, y - it.stop.s / 2, it.stop.s, ink);
    },
  });
  drawCard(ctx, t, DTRACK.at(t));
  touchDrop(ctx, t);
  if (AGENT_DROP) agentShow(ctx, t, AGENT_DROP);
}

Film.scene(S4.a, S4.b, sceneDrop, 'drop');

// ════ scene-finale.js ════
// The finale, in the wordmark's own face. "Can it do that?" lands a word a
// beat. On the next downbeat the first two words swap places and the question
// mark unwinds into a full stop: "It can do that." Then the rest of the line
// falls away, "It" and the full stop meet, and the capital I becomes an i as its
// tittle drops in: "it."
//
// Then the install. The wordmark moves up and the message field the film opened
// on comes back under it. "Install itcan.do" is typed into it and sent, the
// field closes around the words, the wordmark's full stop turns into the green
// dot of the logo, and "That's it." lands on the next downbeat. The plain
// ending (?end=plain) keeps the wordmark where it is and puts the address under
// it in a pill.

const INSTALL = 'Install itcan.do';
const INSTALL_BREAK = 8;   // "Install " then a beat
const S5 = {
  a: bar(36), words: [bar(36, 0), bar(36, 1), bar(36, 2), bar(36, 3)],
  swap: bar(37), fall: bar(38), meet: [bar(38) + 0.3, bar(38) + 0.78], lower: bar(38, 2), pill: bar(38, 3) - 0.1,
  comp: bar(39) - 0.12, typeA1: bar(39, 1.5), typeB1: bar(39, 3), typeA2: bar(40), typeB2: bar(40, 2),
  send: bar(40, 3), done: bar(41), b: DURATION,
};
// The moment the full stop turns green.
S5.live = ENDING === 'agent' ? S5.send + 0.1 : S5.pill + 0.45;
Film.shake(S5.swap, 0.3, 8, 24);
Film.boost(S5.swap - 0.05, S5.swap + 0.5, 20);
Film.boost(S5.fall, S5.meet[1] + 0.05, 16);
Film.boost(S5.lower - 0.02, S5.lower + 0.3, 12);
if (ENDING === 'agent') {
  Film.boost(S5.comp, S5.comp + 0.6, 12);
  Film.boost(S5.send, S5.send + 0.45, 12);
}

const INSTALL_T = [
  ...typist(INSTALL, S5.typeA1 + 0.03, S5.typeB1, 0, INSTALL_BREAK, 7.3),
  ...typist(INSTALL, S5.typeA2 + 0.03, S5.typeB2, INSTALL_BREAK, INSTALL.length, 7.3),
];
function installTimes() { return ENDING === 'agent' ? INSTALL_T.slice() : []; }

// `small` and `upY` are the wordmark once it has moved up for the message field.
const FIN = { size: 200, y: 600, mark: 300, small: 230, upY: 388 };
// The message field, the line over it and the line under it.
const INST = { y: 636, w: 1040, h: 152, font: 60, labelY: 508, label: 54, capY: 862, cap: 100, repoY: 978 };
// Where the source is, set small under everything else on the last frame.
const REPO = 'github.com/Aaryan-Kapoor/it';
// The green of the logo's dot (the favicon of itcan.do).
const LIVE = '#34d399';
Film.init((ctx) => {
  setFont(ctx, 700, FIN.size, FONT.mark, GL.ls);
  const w = (s) => measure(ctx, s);
  const xF0 = CX - w('It can do that.') / 2;
  const xDo = xF0 + w('It can ');
  const xQ0 = xDo - w('Can it ');
  FIN.q = { Can: xQ0, it: xQ0 + w('Can '), do: xDo, that: xDo + w('do '), end: xDo + w('do that') };
  FIN.f = { It: xF0, can: xF0 + w('It '), do: xDo, that: xDo + w('do '), end: xDo + w('do that') };
  const g = wordmarkGeom(FIN.mark);
  FIN.mx = CX - (g.inkLeft + g.width) / 2;
  FIN.my = CY + 0.36 * FIN.mark - 50;
});

// A word that rises out of its line on its beat and falls away at the end.
function finWord(ctx, s, x, y, t, t0, { fall = null, color = C.ink } = {}) {
  const p = tw(t, t0, 0.42, E.outExpo);
  if (p <= 0) return;
  let dy = (1 - p) * FIN.size * 0.9, a = clamp(p * 2), rot = 0;
  if (fall != null) {
    const q = E.inBack(prog(t, fall, fall + 0.42));
    if (q >= 1) return;
    dy += q * 520; rot = q * 0.25; a *= 1 - clamp(q * 1.4 - 0.4);
  }
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.translate(x, y + dy); ctx.rotate(rot);
  text(ctx, s, 0, 0, { color });
  ctx.restore();
}

function sceneFinale(ctx, t) {
  paper(ctx);
  // A slow push-in across the whole finale.
  const z = 1 + 0.035 * E.inOutSine(prog(t, S5.a, S5.b));
  ctx.save();
  ctx.translate(CX, CY); ctx.scale(z, z); ctx.translate(-CX, -CY);
  setFont(ctx, 700, FIN.size, FONT.mark, GL.ls);
  const y = FIN.y;
  const sw = E.inOutCubic(prog(t, S5.swap, S5.swap + 0.42));
  const Q = FIN.q, F = FIN.f;
  if (t < S5.fall + 0.5) {
    // "Can" swings down and right into "can"; "it" swings up and left into "It".
    const arc = Math.sin(sw * Math.PI);
    const k = clamp((sw - 0.35) / 0.3);
    const cx = lerp(Q.Can, F.can, sw), cy = y + arc * 70;
    const ix = lerp(Q.it, F.It, sw), iy = y - arc * 90;
    const pCan = tw(t, S5.words[0], 0.42, E.outExpo), pIt = tw(t, S5.words[1], 0.42, E.outExpo);
    // Before the swap they rise like the others; the swap takes over from there.
    if (sw <= 0) {
      finWord(ctx, 'Can', Q.Can, y, t, S5.words[0]);
      finWord(ctx, 'it', Q.it, y, t, S5.words[1]);
    } else {
      const fq = E.inBack(prog(t, S5.fall, S5.fall + 0.42));
      ctx.save();
      ctx.globalAlpha *= pCan * (1 - clamp(fq * 1.4 - 0.4));
      ctx.translate(cx, cy + fq * 520); ctx.rotate(fq * 0.25 - arc * 0.08);
      if (k < 1) text(ctx, 'Can', 0, 0, { color: C.ink, alpha: 1 - k });
      if (k > 0) text(ctx, 'can', 0, 0, { color: C.ink, alpha: k });
      ctx.restore();
      // "It" stays; after the fall it is drawn with the full stop below.
      if (t < S5.meet[0]) {
        ctx.save();
        ctx.globalAlpha *= pIt;
        ctx.translate(ix, iy); ctx.rotate(arc * 0.1);
        if (k < 1) text(ctx, 'it', 0, 0, { color: C.ink, alpha: 1 - k });
        if (k > 0) text(ctx, 'It', 0, 0, { color: C.ink, alpha: k });
        ctx.restore();
      }
    }
    finWord(ctx, 'do', Q.do, y, t, S5.words[2], { fall: S5.fall + 0.04 });
    finWord(ctx, 'that', Q.that, y, t, S5.words[3], { fall: S5.fall + 0.08 });
  }
  // The question mark, and then the full stop it becomes.
  const pq = tw(t, S5.words[3], 0.42, E.outExpo);
  const u = E.inCubic(prog(t, S5.swap - 0.04, S5.swap + 0.1));
  const dot = prog(t, S5.swap + 0.01, S5.swap + 0.13);
  // "It" and the full stop meet and grow into the wordmark.
  const m = E.inOutCubic(prog(t, S5.meet[0], S5.meet[1]));
  if (t < S5.meet[0]) {
    if (pq > 0) {
      ctx.save(); ctx.globalAlpha *= clamp(pq * 2);
      drawQuestion(ctx, Q.end, y + (1 - pq) * FIN.size * 0.9, FIN.size, u, dot, C.ink);
      ctx.restore();
    }
  } else {
    // From "It" + "." across the line to "it." in the middle, and then up to
    // make room for the message field.
    const up = ENDING === 'agent' ? E.inOutCubic(prog(t, S5.comp, S5.comp + 0.7)) : 0;
    const mark = lerp(FIN.mark, FIN.small, up), gm = wordmarkGeom(mark);
    const mx = CX - (gm.inkLeft + gm.width) / 2, my = lerp(FIN.my, FIN.upY, up);
    const size = Math.exp(lerp(Math.log(FIN.size), Math.log(mark), m));
    const x = lerp(F.It, mx, m), base = lerp(y, my, m);
    const cap = 1 - E.inOutCubic(prog(t, S5.lower, S5.lower + 0.14));
    const td = prog(t, S5.lower + 0.02, S5.lower + 0.5);
    const tittle = td <= 0 ? 0 : spring(t, S5.lower + 0.02, 2.4, 0.62);
    wordmark(ctx, x, base, size, { cap, tittle: td > 0 ? tittle : 0, stop: 0 });
    // The full stop slides in from the end of the line. When It is installed it
    // turns into the logo's green dot, with one pulse and a ring.
    const g = wordmarkGeom(size);
    const px0 = F.end + ((GL.period[0] + GL.period[1]) / 2) * FIN.size, py0 = y + ((GL.period[2] + GL.period[3]) / 2) * FIN.size;
    const px = lerp(px0, x + g.stop.x, m), py = lerp(py0, base + g.stop.y, m);
    const on = E.outCubic(prog(t, S5.live, S5.live + 0.22));
    const pulse = t >= S5.live ? Math.exp(-(t - S5.live) * 6) : 0;
    const ss = lerp((GL.period[1] - GL.period[0]) * FIN.size, g.stop.s, m) * lerp(1, 1.14, on) * (1 + 0.5 * pulse);
    fillRR(ctx, px - ss / 2, py - ss / 2, ss, ss, (ss / 2) * on, mix(C.ink, LIVE, on));
    drawRipple(ctx, px, py, t, S5.live, LIVE, 120, 0.7);
  }
  if (ENDING === 'agent') installField(ctx, t);
  ctx.restore();

  // The plain ending: the address in a pill.
  const pp = ENDING === 'plain' ? tw(t, S5.pill, 0.6, E.outExpo) : 0;
  if (pp > 0) {
    setFont(ctx, 600, 40, FONT.disp, 0);
    const s = 'itcan.do', w = measure(ctx, s) + 112, h = 96;
    const px = CX - w / 2, py = FIN.my + 104 + (1 - pp) * 40;
    ctx.save();
    ctx.globalAlpha = pp;
    fillRR(ctx, px, py, w, h, h / 2, C.ink);
    text(ctx, s, CX, py + h / 2 + 14, { color: '#fff', align: 'center' });
    ctx.restore();
    repoLine(ctx, t, S5.pill + 0.9, FIN.my + 276);
  }
}

// The install, under the wordmark: a line that says who to say it to, the
// message field with the sentence typed into it, and the line that follows.
function installField(ctx, t) {
  const p = tw(t, S5.comp, 0.7, E.outExpo);
  if (p <= 0) return;
  const tf = frameTime(t);
  setFont(ctx, 600, INST.label, FONT.disp, -0.01);
  riseLine(ctx, 'Tell your agent', CX, INST.labelY, INST.label, t, S5.comp + 0.22, { align: 'center', color: C.ink2, stagger: 0.05, dur: 0.5 });

  // Sent, the field closes around its words and loses its buttons.
  const sent = E.inOutCubic(prog(t, S5.send + 0.03, S5.send + 0.42));
  setFont(ctx, 450, INST.font, FONT.body, -0.008);
  const full = measure(ctx, INSTALL);
  const w = lerp(INST.w, full + INST.h * 0.95, sent);
  const typingNow = (tf >= S5.typeA1 && tf <= S5.typeB1 + 0.05) || (tf >= S5.typeA2 && tf <= S5.typeB2 + 0.05);
  composer(ctx, CX, INST.y + (1 - p) * 70, w, INST.h, {
    font: INST.font, msg: INSTALL, chars: countUpTo(INSTALL_T, tf), placeholder: '',
    caret: tf > S5.comp + 0.5 && tf < S5.send, solid: typingNow, t: tf,
    sendPress: pressAt(t, S5.send), alpha: clamp(p * 1.6), acc: 1 - clamp(sent * 2.2),
    textX: lerp(CX - INST.w / 2 + INST.h * 1.02, CX - full / 2, sent), paper: true,
  });

  setFont(ctx, 800, INST.cap, FONT.disp, -0.035);
  riseLine(ctx, "That's it.", CX, INST.capY, INST.cap, t, S5.done, { align: 'center', stagger: 0.07, dur: 0.55 });
  repoLine(ctx, t, S5.done + 0.7, INST.repoY);
}

function repoLine(ctx, t, t0, y) {
  const a = tw(t, t0, 0.6, E.outCubic);
  if (a <= 0) return;
  setFont(ctx, 500, 34, FONT.body, 0);
  text(ctx, REPO, CX, y + (1 - a) * 14, { color: C.ink3, align: 'center', alpha: a });
}

Film.scene(S5.a, S5.b, sceneFinale, 'finale');

// ---------- the page's cuts of the film ----------
// Appended to the film's own source by scripts/film.mjs, so everything above
// this line is the launch film as it was rendered. The page plays five cuts of
// it: each thing It becomes, on its own; the fast reel; "It asks. You tap. The
// agent continues."; the four screens; and the ending, where "Install itcan.do"
// is typed to an agent. Times are the film's own, in
// seconds, so a cut is a stretch of the film and a place to look at it from.

// The page's fonts under the film's family names.
const SITE_FONTS = [
  ['Disp', 'display-600', 600], ['Disp', 'display-700', 700], ['Disp', 'display-800', 800],
  ['Body', 'text-400', 400], ['Body', 'text-500', 500], ['Body', 'text-600', 600], ['Body', 'text-700', 700],
  ['Chess', 'chess', 400], ['Mark', 'mark', 700],
];
const SITE = { cards: [], reel: null, loop: null, where: null, ending: null, paper: C.paper };
let _siteReady = null;
function siteReady() {
  return (_siteReady ??= (async () => {
    await Promise.all(SITE_FONTS.map(async ([fam, file, weight]) => {
      const f = new FontFace(fam, `url(/fonts/${file}.woff2)`, { weight: String(weight) });
      await f.load();
      document.fonts.add(f);
    }));
    const ctx = document.createElement('canvas').getContext('2d');
    for (const fn of Film.inits) fn(ctx);
    siteCuts();
    return SITE;
  })());
}

// A canvas sets its shadows in device pixels whatever the transform, and the
// film was drawn at one scale. On a context returned by this, a shadow is as
// large against the drawing as it was in the film: set ctx._k to the scale.
const _SHADOW = ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY'].map((n) => [n, Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, n)]);
function siteScaled(ctx) {
  if (ctx._k === undefined) {
    ctx._k = 1;
    for (const [n, d] of _SHADOW) Object.defineProperty(ctx, n, { get() { return d.get.call(this) / this._k; }, set(v) { d.set.call(this, v * this._k); } });
  }
  return ctx;
}

// What each exchange is, in words, for the two lines under the card.
const SAID = {
  whiteboard: ['sketched a layout', 'redrew it as a clean one'],
  map: ['tapped a restaurant', 'found the way and booked the table'],
  chess: ['took a pawn with your bishop', 'moved its king out of check'],
  checklist: ['ticked three things', 'added an umbrella, for the rain on Friday'],
  quiz: ['chose an answer', 'marked it'],
  plan: ['moved the sofa', 'measured the gap'],
  cal: ['moved dinner to Thursday', 'checked all four diaries'],
  drums: ['played the four beats', 'played between them'],
  seats: ['moved Uncle Bob', 'filled the seat he left'],
  mood: ['picked two pictures', 'brought two more like them'],
  dash: ['tapped the jump in the line', 'pinned the reason to it'],
  button: ['pressed it', 'shipped the homepage'],
  late: ['answered hours later', 'came back and ran the migration'],
};

// A card of its own: the full stop opens where it stands, and closes again.
// `lead` opens the card that long before its content's clock starts.
function soloPose(cx, cy, T, kind, fill, at, end, lead, how) {
  const tr = new CardTrack();
  tr.add({ kind: 'hold', t: -1, to: stopPose(cx, cy, 18) });
  tr.add({ kind: 'open', t: at - lead, to: P(cx, cy, T.w, T.h, { kind, fill }), ...how });
  tr.add({ kind: 'close', t: end, d: 0.3, to: stopPose(cx, cy, 18) });
  tr.moves[2].from.t0 = at;
  return (t) => { const p = tr.at(t); if (t < end && !p.stop) p.t0 = at; return p; };
}

// Your part on one of the drop's cards, as scene-drop.js draws it for all of them.
function touchSolo(ctx, t, d) {
  const lt = t - d.t, T = THING[d.kind];
  const at = (x, y) => [d.card.x - d.card.w / 2 + x, d.card.y - d.card.h / 2 + y];
  if (T.tap) {
    const [tt, px, py] = T.tap, [x, y] = at(px, py);
    touchPath(ctx, lt, [[tt - 0.36, x + 180, y + 300], [tt - 0.04, x, y], [tt + 0.4, x + 80, y + 170]], { taps: [tt] });
    drawRipple(ctx, x, y, lt, tt + 0.02, C.ink, 110);
  }
  if (T.drag) {
    const [t0, x0, y0, x1, y1] = T.drag, [ax, ay] = at(x0, y0), [bx, by] = at(x1, y1);
    touchPath(ctx, lt, [[t0 - 0.2, ax + 130, ay + 220], [t0, ax, ay], [YOU2, bx, by], [YOU2 + 0.4, bx + 70, by + 160]], { taps: [t0] });
  }
  if (d.kind === 'seats') {
    const [ax, ay] = at(...T.dragFrom()), [bx, by] = at(...T.dragTo());
    touchPath(ctx, lt, [[0.04, ax + 130, ay + 220], [0.24, ax, ay], [YOU2, bx, by], [YOU2 + 0.4, bx - 90, by + 150]], { taps: [0.24] });
  }
  if (d.kind === 'mood') {
    const [x1, y1] = at(moodAt(1)[0] + 68, moodAt(1)[1] - 68), [x2, y2] = at(moodAt(3)[0] + 68, moodAt(3)[1] - 68);
    const [p1, p2] = T.picks.map((q) => q[1]);
    touchPath(ctx, lt, [[p1 - 0.22, x1 + 140, y1 + 240], [p1 - 0.03, x1, y1], [p2 - 0.03, x2, y2], [p2 + 0.4, x2 + 80, y2 + 170]], { taps: [p1, p2] });
  }
  if (d.kind === 'drums') {
    const seq = DRUM_YOU.map((id, b) => [b * BEAT, ...at(...drumPad(id))]);
    const keys = [[-0.25, seq[0][1] + 120, seq[0][2] + 200]];
    for (const [tt, x, y] of seq) keys.push([tt - 0.05, x, y], [tt + 0.08, x, y]);
    keys.push([3 * BEAT + 0.4, seq[3][1] + 90, seq[3][2] + 170]);
    touchPath(ctx, lt, keys, { taps: seq.map((q) => q[0]), dark: true });
  }
  // The film cuts away a bar after the button; here the confetti is left to fall.
  if (d.kind === 'button' && lt > ACT2) confetti(ctx, d.card.x, d.card.y - d.card.h / 2 + 380, lt - ACT2 - 0.02, 1 - prog(lt, 2.1, 2.6));
}

// The agent of one of the drop's cards, with a plate of its own. In the film
// one plate is handed from card to card.
function agentSolo(d, end) {
  const T = THING[d.kind], G = T.agent, L = (lt) => d.t + lt;
  const at = (x, y) => [d.card.x - d.card.w / 2 + x, d.card.y - d.card.h / 2 + y];
  let from = null;
  if (T.tap) from = [T.tap[1], T.tap[2]];
  else if (T.drag) from = [T.drag[3], T.drag[4]];
  else if (d.kind === 'seats') from = T.dragTo();
  else if (d.kind === 'mood') from = [moodAt(3)[0] + 68, moodAt(3)[1] - 68];
  return {
    names: [[0, G.name]], in: L(0.1), out: end,
    at: () => [d.card.x + d.card.w / 2 - 28, d.card.y - d.card.h / 2],
    heard: (G.heard ?? (from ? [[YOU2 + 0.04, ...from]] : [])).map(([lt, x, y]) => [L(lt), ...at(x, y)]),
    busy: G.busy ? [G.busy.map(L)] : [], asleep: G.asleep ? [G.asleep.map(L)] : [], beats: (G.beats || []).map(L),
    hands: G.hand ? [{
      keys: G.hand.keys.map(([lt, x, y]) => [L(lt), ...at(x, y)]), clicks: (G.hand.clicks || []).map(L),
      track: G.hand.track ? (t) => { const q = G.hand.track(t - d.t); return q ? at(q[0], q[1]) : null; } : null,
    }] : [],
    dark: () => (d.kind === 'drums' ? 1 : 0),
  };
}

function siteCuts() {
  // The four of part one, each as the film has it: the fingertip, the agent's
  // plate, and on the whiteboard its pointer.
  const did1 = { whiteboard: WB.tidy[0] + 0.25, map: MAPC.route[0], chess: CH.agent2[0] + 0.1, checklist: CHK.add };
  PART1.forEach((p, i) => {
    const T = THING[p.kind], A = AGENTS1[i], end = p.launch + 2.9;
    const pose = soloPose(CARD1.x, CARD1.y, T, p.kind, C.card, p.launch, end, 0, {});
    SITE.cards.push({
      key: p.kind, noun: p.noun, by: A.names[0][1], field: C.paper, dark: false, rate: 0.62,
      a: p.launch - 0.02, end, out: end + 0.32, cx: CARD1.x, cy: CARD1.y, vw: T.w + 130, vh: T.h + 150,
      you: [A.heard[0][0], SAID[p.kind][0]], did: [p.launch + did1[p.kind], SAID[p.kind][1]],
      draw(ctx, t) { drawCard(ctx, t, pose(t)); touchPart1(ctx, t); agentShow(ctx, t, A); },
    });
  });
  // The nine of the drop. Each gets as long as it needs to finish, where the
  // film gives it a bar.
  const ends = { drums: 2.2, mood: 2.25, button: 2.7, late: 3.9 };
  const did2 = { drums: 1.5 * BEAT, late: LATE.work[0] };
  DROP.forEach((d) => {
    const T = THING[d.kind], end = d.t + (ends[d.kind] ?? 1.95), lead = 0.22;
    const A = agentSolo(d, end);
    const pose = soloPose(d.card.x, d.card.y, T, d.kind, d.kind === 'drums' ? '#1b1b1f' : C.card, d.t, end, lead, { f: 2.2, z: 0.7 });
    SITE.cards.push({
      key: d.kind, noun: d.noun, by: A.names[0][1], field: d.field, dark: !!d.dark, rate: d.kind === 'late' ? 0.62 : 0.52,
      a: d.t - lead - 0.04, end, out: end + 0.32, cx: d.card.x, cy: d.card.y, vw: T.w + 130, vh: T.h + 150,
      you: [A.heard[0][0], SAID[d.kind][0]], did: [d.t + (did2[d.kind] ?? ACT2), SAID[d.kind][1]],
      draw(ctx, t) { drawCard(ctx, t, pose(t)); touchSolo(ctx, t, d); agentShow(ctx, t, A); },
    });
  });

  // The fast reel: one glance each, on a card that stays where it is.
  const fields = [FIELD.cal, FIELD.plan, FIELD.tomato, FIELD.mood, FIELD.seats, FIELD.quiz, FIELD.peach, FIELD.aqua, FIELD.lime, FIELD.rose];
  SITE.reel = {
    items: REEL.map(([noun, k], i) => ({ noun, kind: 'r_' + k, field: fields[i % fields.length] })),
    cx: 1400, cy: 540, vw: RC.w + 130, vh: RC.h + 150,
    // `lt` is the time since this one came up.
    draw(ctx, i, lt) {
      const s = 1 - 0.06 * Math.exp(-lt * 16);
      drawCard(ctx, lt, P(1400, 540, RC.w * s, RC.h * s, { kind: this.items[i].kind, k: clamp(lt / 0.08), t0: 0 }));
    },
  };

  // "It asks. You tap. The agent continues.": the full stop opens into the
  // question, your tap goes back to Claude, and version B is built in its place.
  SITE.loop = {
    a: S2.open - 0.3, end: S2.out - 0.14, out: bar(8) - 0.005, rate: 0.72,
    cx: PAGE.x, cy: PAGE.y, vw: PAGE.w + 150, vh: PAGE.h + 130,
    marks: [[S2.open, 'asks'], [S2.tap, 'tap'], [S2.agent, 'continues'], [S2.ready, 'done']],
    draw(ctx, t) { drawCard(ctx, t, cardAt(t)); touchLoop(ctx, t); agentShow(ctx, t, AGENT_LOOP); },
  };

  // The four screens, and the full stop that hops from one to the next.
  const need = [640, 1420, 1500, 1500];
  SITE.where = {
    parts: DEVW.map((D, i) => ({ kind: D.kind, a: i ? S3.dev[i] - 0.47 : S3.a, end: i < 3 ? S3.dev[i + 1] - 0.47 : S3.agents - 0.52 })),
    a: S3.a, out: S3.agents - 0.27, rate: 0.6, cy: 640, vh: 900,
    // Where the camera is, and how much width the screen it is on needs.
    cam(t) {
      let x = DEVW[0].x, w = need[0];
      for (let i = 1; i < 4; i++) {
        const e = E.inOutCubic(prog(t, S3.dev[i] - 0.45, S3.dev[i] + 0.22));
        if (e > 0) { x = lerp(x, DEVW[i].x, e); w = lerp(w, need[i], e); }
      }
      return { x, need: w };
    },
    // The world of scene-where.js without its headline: the devices, what each
    // shows, your part on each, and your answer on its way to Hermes.
    draw(ctx, t, camX) {
      for (const D of DEVW) if (Math.abs(D.x - camX) < 2600) drawDevice(ctx, D);
      const pose = WTRACK.at(t);
      if (pose) drawScreenCard(ctx, t, pose);
      {
        const Ph = DEVW[0], sc = Ph.sw / THING.checklist.w, u = t - S3.a;
        const bx = Ph.x - Ph.sw / 2 + 78 * sc, by = Ph.y - Ph.sh / 2 + 50 + (CHK.top + 5 * CHK.row + 36) * sc;
        touchPath(ctx, u, [[WH.phoneTap - 0.4, bx + 150, by + 260], [WH.phoneTap - 0.03, bx, by], [WH.phoneTap + 0.35, bx + 70, by + 150]], { taps: [WH.phoneTap] });
      }
      const L = DEVW[1], ltL = t - (S3.dev[1] + 0.12);
      if (ltL > 0.16 && ltL < 1.45) {
        const [x, y] = keyPos(WHERE.laptop.cursor, ltL);
        const px = L.x - L.sw / 2 + x, py = L.y - L.sh / 2 + y;
        ctx.save(); ctx.globalAlpha *= tw(ltL, 0.16, 0.15) * (1 - tw(ltL, 1.22, 0.2));
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + 40); ctx.lineTo(px + 11, py + 30); ctx.lineTo(px + 19, py + 46); ctx.lineTo(px + 25, py + 43); ctx.lineTo(px + 17, py + 28); ctx.lineTo(px + 30, py + 28); ctx.closePath();
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.restore();
      }
      const Cr = DEVW[3], ltC = t - (S3.dev[3] + 0.12), [tt, tx, ty] = WHERE.car.tap;
      const bx = Cr.x - Cr.sw / 2 + tx, by = Cr.y - Cr.sh / 2 + ty;
      touchPath(ctx, ltC, [[tt - 0.38, bx + 200, by + 300], [tt - 0.03, bx, by], [tt + 0.4, bx + 90, by + 190]], { taps: [tt], dark: true });
      drawRipple(ctx, bx, by, ltC, tt + 0.02, '#ffffff', 100);
      beads3(ctx, t);
    },
  };

  // The ending: the wordmark moves up, "Install itcan.do" is typed into the
  // agent's message field and sent, the full stop turns green, and "That's it."
  SITE.ending = {
    a: S5.comp - 0.15, end: S5.done + 1.7, rate: 0.85, cx: CX, cy: 604, vw: 1240, vh: 900,
    marks: [[S5.typeA1, 'typing'], [S5.send + 0.1, 'sent'], [S5.done, 'done']],
    draw(ctx, t) { sceneFinale(ctx, t); },
  };
}

return Object.assign(SITE, { ready: siteReady, scaled: siteScaled });
})();
