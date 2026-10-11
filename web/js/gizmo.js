// Transform gizmo, after Outfit Studio's: three arrows to move along an axis, three rings to turn about it, a cube on
// each axis to stretch along it and a black cube in the middle to scale evenly. It appears on the selected model (the
// reference body as one group) and changes only how Lightbox shows it (renderer.setModelXform), never the NIF.
// Drawn on a 2D canvas over the view in the character's own axes (X red, Y green, Z blue), slightly see-through.
// Ctrl while dragging snaps: 1 unit, 15 degrees, 5 %.
import { mat4, vec3 } from './math.js';

const RING_PX = 95;                        // ring radius on screen
const COLORS = ['224,64,64', '64,200,72', '72,88,232'];
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function axisRot(k, a) {                   // 3 x 3 rotation about axis k by a (column-major)
  const c = Math.cos(a), s = Math.sin(a), r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const i = (k + 1) % 3, j = (k + 2) % 3;
  r[i * 3 + i] = c; r[i * 3 + j] = s; r[j * 3 + i] = -s; r[j * 3 + j] = c;
  return r;
}
function mul3(a, b) {
  const o = new Array(9);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) o[j * 3 + i] = a[i] * b[j * 3] + a[3 + i] * b[j * 3 + 1] + a[6 + i] * b[j * 3 + 2];
  return o;
}

export class Gizmo {
  constructor(R, view, overlay) {
    this.R = R; this.view = view; this.cv = overlay; this.ctx = overlay.getContext('2d');
    this.hover = null; this.drag = null; this.onChange = null; this.enabled = true;
  }
  // the models the gizmo moves: the selected model, or the whole reference body when one of its parts is selected
  targets() {
    const sel = this.R.selection;
    if (!this.enabled || !sel || sel.kind !== 'model' || !sel.model.visible) return null;
    return sel.model.refBody ? this.R.models.filter(m => m.refBody) : [sel.model];
  }
  // character-space pivot: the middle of the targets' own bounds, moved by their transform
  pivot(list) {
    const m0 = list[0];
    if (m0.xf) return vec3.add(m0.xf.c, m0.xf.t);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of list) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], m.bbox[0][i]); hi[i] = Math.max(hi[i], m.bbox[1][i]); }
    return vec3.scale(vec3.add(lo, hi), 0.5);
  }
  // screen geometry of this frame: pivot, axes, size (null when there is nothing to show)
  frame() {
    const list = this.targets(), L = this.R._last;
    if (!list || !L) return null;
    const W = this.view.clientWidth, H = this.view.clientHeight;
    const root = this.R.playerRoot, P = mat4.transformPoint(root, this.pivot(list));
    const VP = mat4.mul(L.proj, L.view);
    const toScreen = (p) => {
      const x = VP[0] * p[0] + VP[4] * p[1] + VP[8] * p[2] + VP[12], y = VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13];
      const w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15];
      return w > 1e-4 ? [(x / w * 0.5 + 0.5) * W, (0.5 - y / w * 0.5) * H, w] : null;
    };
    const c = toScreen(P);
    if (!c) return null;
    const r = RING_PX / ((H / 2) * L.proj[5] / c[2]);               // world size of RING_PX at the pivot's depth
    const axes = [0, 1, 2].map(k => vec3.norm([root[k * 4], root[k * 4 + 1], root[k * 4 + 2]]));
    return { list, P, c, r, axes, W, H, toScreen, inv: mat4.invert(VP), VP };
  }
  // everything the handles' screen shapes come from (shapes): the same key, the same shapes
  shapeKey(f) { return `${f.W}x${f.H}|${f.VP}|${f.P}|${f.r}|${f.axes}`; }
  shapesFor(f) {
    const k = this.shapeKey(f);
    if (k !== this._shKey) { this._shKey = k; this._sh = this.shapes(f); }
    return this._sh;
  }
  ray(f, x, y) {
    const ndc = [x / f.W * 2 - 1, 1 - y / f.H * 2];
    const un = (z) => { const p = [ndc[0], ndc[1], z, 1], m = f.inv, o = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) o[i] = m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i] * p[3];
      return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
    const a = un(-1), b = un(1);
    return { o: a, d: vec3.norm(vec3.sub(b, a)) };
  }
  // where along the axis line through P the mouse ray passes closest
  axisParam(f, k, x, y) {
    const { o, d } = this.ray(f, x, y), A = f.axes[k], w0 = vec3.sub(f.P, o);
    const b = vec3.dot(A, d), dd = vec3.dot(A, w0), e = vec3.dot(d, w0), den = 1 - b * b;
    return den < 1e-4 ? null : (b * e - dd) / den;
  }
  // the mouse's angle about axis k, in the ring's plane (null when the ring is seen edge on)
  ringAngle(f, k, x, y) {
    const { o, d } = this.ray(f, x, y), A = f.axes[k], dn = vec3.dot(d, A);
    if (Math.abs(dn) < 0.08) return null;
    const t = vec3.dot(vec3.sub(f.P, o), A) / dn, q = vec3.sub(vec3.add(o, vec3.scale(d, t)), f.P);
    const U = f.axes[(k + 1) % 3], V = f.axes[(k + 2) % 3];
    return Math.atan2(vec3.dot(q, V), vec3.dot(q, U));
  }
  // the handles' screen shapes, for drawing and for hit tests
  shapes(f) {
    const { P, r, axes, toScreen } = f, out = { rings: [], arrows: [], cubes: [] };
    for (let k = 0; k < 3; k++) {
      const U = axes[(k + 1) % 3], V = axes[(k + 2) % 3], pts = [];
      for (let i = 0; i <= 72; i++) {
        const a = i / 72 * Math.PI * 2;
        const s = toScreen(vec3.add(P, vec3.add(vec3.scale(U, Math.cos(a) * r), vec3.scale(V, Math.sin(a) * r))));
        if (s) pts.push(s);
      }
      out.rings.push(pts);
      const base = toScreen(vec3.add(P, vec3.scale(axes[k], r * 1.28))), tip = toScreen(vec3.add(P, vec3.scale(axes[k], r * 1.62)));
      out.arrows.push(base && tip ? [base, tip] : null);
      out.cubes.push(toScreen(vec3.add(P, vec3.scale(axes[k], r * 0.72))));
    }
    return out;
  }
  hit(x, y) {
    const f = this.frame();
    if (!f) return null;
    const sh = this.shapesFor(f), d2 = (p) => Math.hypot(p[0] - x, p[1] - y);
    const seg = (a, b) => {
      const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / l2));
      return Math.hypot(a[0] + ab[0] * t - x, a[1] + ab[1] * t - y);
    };
    // cubes first, then the arrow heads, the rings, and last the arrow shafts (which cross the rings)
    if (d2(f.c) < 13) return { kind: 'scaleAll' };
    for (let k = 0; k < 3; k++) if (sh.cubes[k] && d2(sh.cubes[k]) < 11) return { kind: 'scale', k };
    for (let k = 0; k < 3; k++) {
      const a = sh.arrows[k];
      if (a && (d2(a[1]) < 14 || seg(a[0], a[1]) < 10)) return { kind: 'move', k };
    }
    let best = null;
    for (let k = 0; k < 3; k++) {
      const pts = sh.rings[k];
      for (let i = 1; i < pts.length; i++) {
        const dd = seg(pts[i - 1], pts[i]);
        if (dd < 7 && (!best || dd < best.d)) best = { kind: 'turn', k, d: dd };
      }
    }
    if (best) return best;
    for (let k = 0; k < 3; k++) if (sh.arrows[k] && seg(f.c, sh.arrows[k][0]) < 6) return { kind: 'move', k };
    return null;
  }
  begin(h, x, y) {
    const f = this.frame();
    if (!f) return false;
    const list = f.list, c = this.pivot(list);
    const xf0 = list[0].xf ? { ...list[0].xf } : { t: [0, 0, 0], r: IDENT.slice(), s: [1, 1, 1], c };
    this.drag = { h, xf0, x0: x, y0: y, s0: h.k != null ? this.axisParam(f, h.k, x, y) : null,
      a0: h.kind === 'turn' ? this.ringAngle(f, h.k, x, y) : null, list, sumA: 0, lastX: x };
    return true;
  }
  move(x, y, snap) {
    const D = this.drag;
    if (!D) return;
    const f = this.frame();
    if (!f) return;
    const { h, xf0 } = D, xf = { t: xf0.t.slice(), r: xf0.r.slice(), s: xf0.s.slice(), c: xf0.c };
    if (h.kind === 'move' && D.s0 != null) {
      const s = this.axisParam(f, h.k, x, y);
      if (s != null) { let dt = s - D.s0; if (snap) dt = Math.round(dt); xf.t[h.k] += dt; }
    } else if (h.kind === 'turn') {
      let da;
      const a = this.ringAngle(f, h.k, x, y);
      if (a != null && D.a0 != null) { da = a - D.a0; da = Math.atan2(Math.sin(da), Math.cos(da)); }
      else da = (x - D.x0) * 0.01;                                   // edge on: turn by the mouse's sideways motion
      if (snap) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
      xf.r = mul3(axisRot(h.k, da), xf0.r);
      D.turned = da * 180 / Math.PI;
    } else if (h.kind === 'scale' && D.s0 != null && Math.abs(D.s0) > 1e-3) {
      const s = this.axisParam(f, h.k, x, y);
      if (s != null) { let k = Math.max(0.05, s / D.s0); if (snap) k = Math.max(0.05, Math.round(k * 20) / 20); xf.s[h.k] = xf0.s[h.k] * k; }
    } else if (h.kind === 'scaleAll') {
      let k = Math.exp(-(y - D.y0) * 0.006);
      if (snap) k = Math.max(0.05, Math.round(k * 20) / 20);
      xf.s = xf0.s.map(v => v * k);
    }
    for (const m of D.list) this.R.setModelXform(m, { ...xf });
    this.onChange && this.onChange(false);
  }
  end() {
    if (!this.drag) return;
    this.drag = null;
    this.onChange && this.onChange(true);
  }
  // a short text for the HUD: how far the selection is from where its file puts it
  summary() {
    const list = this.targets();
    const xf = list && list[0].xf;
    if (!xf) return '';
    const r = xf.r, f = (v) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
    // Z-Y-X angles of the rotation, for reading only
    const ry = Math.asin(Math.max(-1, Math.min(1, -r[2]))), rx = Math.atan2(r[5], r[8]), rz = Math.atan2(r[1], r[0]);
    const deg = (a) => f(a * 180 / Math.PI);
    const sc = xf.s.every(v => Math.abs(v - xf.s[0]) < 1e-4) ? `x${xf.s[0].toFixed(2)}` : `x${xf.s.map(v => v.toFixed(2)).join(' ')}`;
    return `moved ${xf.t.map(f).join(' ')}  turned ${deg(rx)} ${deg(ry)} ${deg(rz)}  ${sc}`;
  }
  // Called on every display refresh (main.js loop), but paints only when the picture changes: a 2D canvas touched each
  // refresh makes the browser composite a new page frame each time, so a still view would never let the GPU idle.
  // _paints counts the paints (dev check)
  draw() {
    const cv = this.cv, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const W = this.view.clientWidth, H = this.view.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {       // (a resize clears the canvas)
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); this._key = null; this._painted = false;
    }
    const f = this.frame();
    if (!f) {                                                         // nothing to show: clear once
      if (this._painted) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); this._painted = false; }
      this._key = null;
      return;
    }
    const act = this.drag ? this.drag.h : this.hover;
    const key = `${cv.width}x${cv.height}@${dpr}|${this.shapeKey(f)}|${act ? `${act.kind}:${act.k}` : ''}`;
    if (key === this._key) return;
    this._key = key; this._painted = true; this._paints = (this._paints || 0) + 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sh = this.shapesFor(f);
    const on = (kind, k) => act && act.kind === kind && act.k === k;
    const col = (k, a, lit) => lit ? `rgba(255,214,90,${Math.min(1, a + 0.2)})` : `rgba(${COLORS[k]},${a})`;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let k = 0; k < 3; k++) {                                     // rings
      const pts = sh.rings[k];
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.strokeStyle = col(k, 0.55, on('turn', k)); ctx.lineWidth = on('turn', k) ? 7 : 5.5; ctx.stroke();
    }
    for (let k = 0; k < 3; k++) {                                     // arrows: shaft and head
      const a = sh.arrows[k];
      if (!a) continue;
      const lit = on('move', k), [b, t] = a, dx = t[0] - b[0], dy = t[1] - b[1], l = Math.hypot(dx, dy);
      ctx.beginPath(); ctx.moveTo(f.c[0], f.c[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = col(k, 0.62, lit); ctx.lineWidth = lit ? 6 : 4.5; ctx.stroke();
      ctx.fillStyle = col(k, 0.72, lit); ctx.beginPath();
      if (l < 9) ctx.arc(t[0], t[1], 11, 0, Math.PI * 2);              // seen head on: the cone's round base
      else {
        const ux = dx / l, uy = dy / l, w = 11;
        ctx.moveTo(t[0], t[1]); ctx.lineTo(b[0] - uy * w, b[1] + ux * w); ctx.lineTo(b[0] + uy * w, b[1] - ux * w);
      }
      ctx.closePath(); ctx.fill();
    }
    for (let k = 0; k < 3; k++) {                                     // the axis stretch cubes
      const p = sh.cubes[k];
      if (!p) continue;
      const lit = on('scale', k);
      ctx.fillStyle = col(k, 0.85, lit); ctx.fillRect(p[0] - 8, p[1] - 8, 16, 16);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.strokeRect(p[0] - 8, p[1] - 8, 16, 16);
    }
    const lit = act && act.kind === 'scaleAll';                       // the even scale cube in the middle
    ctx.fillStyle = lit ? 'rgba(255,214,90,.95)' : 'rgba(10,10,12,.85)'; ctx.fillRect(f.c[0] - 9, f.c[1] - 9, 18, 18);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.strokeRect(f.c[0] - 9, f.c[1] - 9, 18, 18);
  }
}
