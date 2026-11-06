// Hand gestures -> view controls (shared by the street and library pages).
//   one hand: how open the five fingers are -> scatter, continuously (pinched = 0, fully open = 1).
//             Hold a half-open hand and the cloud stays half spread; no pushing needed.
//   one hand moved sideways (outside a dead zone)  -> small yaw, at most +-MAX_YAW
//   two hands: distance between them -> zoom, continuously, relative to when both hands appeared
//   two hands moved together sideways             -> walk along the route
// The open/pinched range calibrates itself to the user's hand (widest and tightest seen so far), and a hand
// that drops out for a moment (closed fists are often lost by the tracker) keeps its last value.

export const MAX_YAW = 0.18;    // radians (~10 degrees)
const HOLD_MS = 600;           // keep the last hands this long when tracking drops out

const ema = (a, b, k) => a + (b - a) * k;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export function handFeatures(lm) {
  const palm = [0, 5, 9, 13, 17].reduce((s, i) => ({ x: s.x + lm[i].x / 5, y: s.y + lm[i].y / 5 }), { x: 0, y: 0 });
  const scale = dist(lm[0], lm[9]) || 1e-6;                         // wrist -> middle knuckle (hand size on screen)
  const tips = [4, 8, 12, 16, 20];
  const spread = tips.reduce((s, i) => s + dist(lm[i], palm), 0) / tips.length / scale;   // ~0.6 pinched, ~1.6 open
  return { x: 1 - palm.x, y: palm.y, scale, spread };               // x mirrored, like a mirror
}

export function createGestureState() {
  return { hands: [], seen: 0, lo: 0.75, hi: 1.45, open: null, scatter: null, zoom: 1, zoom0: 1, d0: 0, yaw: 0, du: 0, pan: null, label: '手なし' };
}

// Returns { label, open (0..1 or null), scatter (0..1 or null = leave as is), zoom, yaw, du }.
export function updateGestures(g, hands, now, opts = {}) {
  const sens = opts.sensitivity ?? 1, walk = opts.walk ?? 1;
  let feats = hands.slice(0, 2).map(handFeatures).sort((a, b) => a.x - b.x);
  if (feats.length) g.seen = now;
  else if (now - g.seen < HOLD_MS) feats = g.hands.map(h => ({ ...h }));     // short drop-out: keep last hands
  // Smooth per hand slot.
  g.hands = feats.map((f, i) => { const p = g.hands[i]; return p && g.hands.length === feats.length ? { x: ema(p.x, f.x, .35), y: ema(p.y, f.y, .35), scale: ema(p.scale, f.scale, .3), spread: ema(p.spread, f.spread, .3) } : f; });
  let du = 0, yawT = 0;

  if (g.hands.length === 1) {
    const h = g.hands[0];
    // Self-calibration: widen the range to what this hand actually does, relax slowly back.
    g.lo = Math.min(g.lo + .0006, h.spread); g.hi = Math.max(g.hi - .0006, h.spread);
    const span = Math.max(.35, g.hi - g.lo);
    let o = clamp01((h.spread - g.lo) / span);
    o = clamp01((o - .5) * (0.9 + 0.4 * sens) + .5);                // sensitivity = contrast of the response
    g.open = g.open == null ? o : ema(g.open, o, .25);
    g.scatter = g.open;
    const dx = h.x - .5;
    yawT = Math.abs(dx) < .15 ? 0 : Math.sign(dx) * Math.min(1, (Math.abs(dx) - .15) / .3) * MAX_YAW;
    g.label = g.open < .15 ? 'つまむ → 収束' : g.open > .85 ? '開く → 拡散' : `開き具合 ${Math.round(g.open * 100)}%`;
    g.pan = null; g.d0 = 0;
  } else if (g.hands.length === 2) {
    const [a, b] = g.hands, mx = (a.x + b.x) / 2, d = Math.max(.05, dist(a, b));
    if (!g.d0) { g.d0 = d; g.zoom0 = g.zoom; }
    // Hands further apart -> closer (smaller camera distance), continuously.
    const zT = Math.max(.45, Math.min(2.2, g.zoom0 * Math.pow(g.d0 / d, 0.5 + 0.2 * sens)));
    g.zoom = ema(g.zoom, zT, .2);
    if (g.pan != null) { const v = mx - g.pan; if (Math.abs(v) > .002) du = -v * 60 * walk; }
    g.pan = mx;
    g.label = Math.abs(du) > .05 ? '両手で移動' : `両手の間隔で拡大・縮小 ×${(1 / g.zoom).toFixed(2)}`;
  } else { g.label = '手なし'; g.pan = null; g.d0 = 0; }

  g.yaw = ema(g.yaw, yawT, .1);
  g.du = du;
  return { label: g.label, open: g.hands.length === 1 ? g.open : null, scatter: g.hands.length === 1 ? g.scatter : null, zoom: g.zoom, yaw: g.yaw, du };
}

// Preview: mirrored camera image, hand skeletons, current gesture and an "openness" bar.
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
export function drawPreview(ctx, video, hands, g) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
  if (video && video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 2; ctx.strokeStyle = '#3b6cff'; ctx.fillStyle = '#ffffff';
  for (const lm of hands) {
    ctx.beginPath();
    for (const [a, b] of BONES) { ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H); ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H); }
    ctx.stroke();
    for (const p of lm) { ctx.beginPath(); ctx.arc((1 - p.x) * W, p.y * H, 2.2, 0, 6.283); ctx.fill(); }
  }
  ctx.fillStyle = 'rgba(11,12,16,.85)'; ctx.fillRect(0, H - 30, W, 30);
  if (g.open != null && g.hands.length === 1) {
    ctx.fillStyle = '#262a33'; ctx.fillRect(8, H - 26, W - 16, 6);
    ctx.fillStyle = '#3b6cff'; ctx.fillRect(8, H - 26, (W - 16) * g.open, 6);
  }
  ctx.fillStyle = '#e8eaf0'; ctx.font = '12px "Yu Gothic", sans-serif'; ctx.fillText(g.label, 8, H - 8);
}
