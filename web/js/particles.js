// Fallout 4 particle systems (NiParticleSystem), simplified: the NIF's own emitters, forces and colour / size /
// flipbook curves (server scene.py scene_particles), simulated on the CPU and drawn as camera-facing quads with the
// system's effect material. Not a copy of the engine: the parts that decide the look are followed (birth rate from
// the emitter controller, emitter shape and spread, life span, gravity, drag, rotation, the simple colour modifier,
// the scale curve, the sub-texture flipbook, velocity-stretched sparks); spawn-on-death, LOD, colliders, bombs, wind
// and inherited velocity are left out. engine-notes Section 26 has the conventions and how they were worked out.
import { scaledTime, sampleKeys } from './anim.js';

const EMITTERS = new Set(['box', 'cylinder', 'sphere', 'mesh']);
const DRAG_FPS = 30;          // drag "Percentage" read as a fraction per 1/30 s frame (engine-notes §26)

// small fast seeded random numbers (mulberry32): every system gets its own stream
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sym = (r) => r() * 2 - 1;

// an interpolator's value at time t: float -> number; bool -> 0/1 (value 2 = "use the keys", true without keys)
function interpValue(ip, t, fallback) {
  if (!ip || ip.kind === 'unsupported') return fallback;
  const v = sampleKeys(ip.keys, t, [ip.value]);
  const x = Array.isArray(v) ? v[0] : v;
  if (ip.kind === 'bool') return x === 2 ? 1 : (x >= 0.5 ? 1 : 0);
  return Number.isFinite(x) && Math.abs(x) < 1e30 ? x : fallback;
}
// particles preview controllers on a loop (a clamped one-shot burst would play once and leave nothing to look at)
const loopTime = (c, t) => scaledTime({ ...c, flags: (c.flags || 0) & ~6 }, t);

// column-major 4x4 helpers on plain arrays (world matrices from the renderer)
const xfP = (m, x, y, z, o, k) => {
  o[k] = m[0] * x + m[4] * y + m[8] * z + m[12];
  o[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  o[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
};
const xfV = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export class ParticleSim {
  constructor(def, seed = 1) {
    this.def = def;
    const cap = this.cap = Math.max(1, def.max | 0);
    this.P = new Float32Array(cap * 3); this.V = new Float32Array(cap * 3);
    this.A = new Float32Array(cap); this.L = new Float32Array(cap); this.R = new Float32Array(cap);
    this.ROT = new Float32Array(cap); this.RS = new Float32Array(cap);
    this.F0 = new Float32Array(cap); this.FPS = new Float32Array(cap); this.LS = new Float32Array(cap);
    this.C = new Float32Array(cap * 4);
    this.n = 0;
    this.rand = rng(seed * 2654435761 + (def.block | 0) * 97 + 7);
    const mods = def.modifiers.filter(m => m.active !== false);
    this.emitters = mods.filter(m => EMITTERS.has(m.kind)).map(e => ({ ...e, acc: 0 }));
    const ctl = (kind, name) => (def.controllers || []).find(c => c.kind === kind && c.modifier === name);
    const births = (def.controllers || []).filter(c => c.kind === 'birth');
    for (const e of this.emitters) {
      e.birth = ctl('birth', e.name) || (births.length === 1 ? births[0] : null);
      e.speedCtl = ctl('speed', e.name); e.radiusCtl = ctl('radius', e.name); e.lifeCtl = ctl('life', e.name);
    }
    this.gravity = mods.filter(m => m.kind === 'gravity').map(g => ({ ...g, ctl: ctl('strength', g.name) }));
    this.drag = mods.filter(m => m.kind === 'drag');
    this.rot = mods.find(m => m.kind === 'rotation') || null;
    this.color = mods.find(m => m.kind === 'color') || null;
    this.subtex = mods.find(m => m.kind === 'subtex') || null;
    const sc = mods.find(m => m.kind === 'scale');
    this.scales = sc && sc.scales && sc.scales.length ? sc.scales : null;
    this.frames = def.subtex && def.subtex.length ? def.subtex : null;
    const al = def.material && def.material.alpha || {};
    this.additive = !!al.blend && al.dst === 0;                  // ONE as destination: no sorting needed
    this.prevSys = null;
    this.live = false;
  }

  reset() { this.n = 0; this.prevSys = null; for (const e of this.emitters) e.acc = 0; }

  // ctx: { node(block) -> world matrix or null, sys: the system's world matrix, root: the model root's world matrix }
  update(dt, t, ctx) {
    if (!(dt > 0)) return;
    const { P, V, A, L, ROT, RS } = this;
    // object-space systems follow their node (world-space ones leave their particles where they were born)
    if (!this.def.world_space && this.prevSys) {
      const D = mulInv(ctx.sys, this.prevSys);
      if (D) for (let i = 0; i < this.n; i++) {
        const k = i * 3, x = P[k], y = P[k + 1], z = P[k + 2];
        xfP(D, x, y, z, P, k);
        const v = xfV(D, V[k], V[k + 1], V[k + 2]); V[k] = v[0]; V[k + 1] = v[1]; V[k + 2] = v[2];
      }
    }
    this.prevSys = ctx.sys;
    // age and death
    for (let i = 0; i < this.n;) {
      A[i] += dt;
      if (A[i] >= L[i]) this.kill(i); else i++;
    }
    // birth: the emitter controller's rate (particles per second) while its visibility key is on
    for (const e of this.emitters) {
      const c = e.birth;
      if (!c) continue;
      const tc = loopTime(c, t);
      const on = interpValue(c.visibility, tc, 1);
      const rate = on ? Math.max(0, interpValue(c.interp, tc, 0)) : 0;
      e.acc += rate * dt;
      let k = Math.floor(e.acc);
      e.acc -= k;
      if (k > this.cap) k = this.cap;
      for (; k > 0 && this.n < this.cap; k--) this.spawn(e, ctx, t, this.rand() * dt);
      if (this.n >= this.cap) e.acc = 0;
    }
    // forces, in world space this frame
    let ax = 0, ay = 0, az = 0;
    const spheres = [];
    for (const g of this.gravity) {
      const s = g.ctl ? interpValue(g.ctl.interp, loopTime(g.ctl, t), g.strength) : g.strength;
      const O = ctx.node(g.object) || ctx.sys;
      if (g.force_type === 1) { spheres.push([O[12], O[13], O[14], s]); continue; }
      const a = norm3(g.world_aligned ? g.axis : xfV(O, g.axis[0], g.axis[1], g.axis[2]));
      ax += a[0] * s; ay += a[1] * s; az += a[2] * s;
    }
    const drags = this.drag.map(d => {
      const O = ctx.node(d.object) || ctx.sys;
      return [norm3(xfV(O, d.axis[0], d.axis[1], d.axis[2])), 1 - Math.pow(Math.max(0, 1 - d.percentage), dt * DRAG_FPS)];
    });
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      let vx = V[k] + ax * dt, vy = V[k + 1] + ay * dt, vz = V[k + 2] + az * dt;
      for (const [cx, cy, cz, s] of spheres) {
        const dx = cx - P[k], dy = cy - P[k + 1], dz = cz - P[k + 2], l = Math.hypot(dx, dy, dz) || 1;
        vx += dx / l * s * dt; vy += dy / l * s * dt; vz += dz / l * s * dt;
      }
      for (const [a, f] of drags) {
        const along = (vx * a[0] + vy * a[1] + vz * a[2]) * f;
        vx -= a[0] * along; vy -= a[1] * along; vz -= a[2] * along;
      }
      V[k] = vx; V[k + 1] = vy; V[k + 2] = vz;
      P[k] += vx * dt; P[k + 1] += vy * dt; P[k + 2] += vz * dt;
      ROT[i] += RS[i] * dt;
    }
    this.live = this.n > 0 || this.emitters.some(e => e.birth);
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const { P, V, C } = this;
    P[i * 3] = P[j * 3]; P[i * 3 + 1] = P[j * 3 + 1]; P[i * 3 + 2] = P[j * 3 + 2];
    V[i * 3] = V[j * 3]; V[i * 3 + 1] = V[j * 3 + 1]; V[i * 3 + 2] = V[j * 3 + 2];
    for (let c = 0; c < 4; c++) C[i * 4 + c] = C[j * 4 + c];
    for (const a of [this.A, this.L, this.R, this.ROT, this.RS, this.F0, this.FPS, this.LS]) a[i] = a[j];
  }

  spawn(e, ctx, t, age) {
    const r = this.rand, i = this.n++, k = i * 3;
    // direction: declination from the emitter's +Z axis, planar angle around it
    const dec = e.declination + sym(r) * e.declination_var, pl = e.planar + sym(r) * e.planar_var;
    let dx = Math.sin(dec) * Math.cos(pl), dy = Math.sin(dec) * Math.sin(pl), dz = Math.cos(dec);
    let px = 0, py = 0, pz = 0, M;
    if (e.kind === 'mesh') {
      // points on the emitter mesh (NIF root space); the spread is around the surface normal there
      M = ctx.root;
      const n = e.points.length / 3, j = Math.min(n - 1, Math.floor(r() * n)) * 3;
      px = e.points[j]; py = e.points[j + 1]; pz = e.points[j + 2];
      const N = [e.normals[j], e.normals[j + 1], e.normals[j + 2]];
      const T = norm3(Math.abs(N[2]) < 0.9 ? [-N[1], N[0], 0] : [0, -N[2], N[1]]);
      const B = [N[1] * T[2] - N[2] * T[1], N[2] * T[0] - N[0] * T[2], N[0] * T[1] - N[1] * T[0]];
      const ox = dx, oy = dy, oz = dz;
      dx = T[0] * ox + B[0] * oy + N[0] * oz; dy = T[1] * ox + B[1] * oy + N[1] * oz; dz = T[2] * ox + B[2] * oy + N[2] * oz;
    } else {
      M = ctx.node(e.object) || ctx.sys;
      const s = e.size || [0, 0, 0];
      if (e.kind === 'box') { px = (r() - 0.5) * s[0]; py = (r() - 0.5) * s[1]; pz = (r() - 0.5) * s[2]; }
      else if (e.kind === 'cylinder') {
        const a = r() * 2 * Math.PI, rr = s[0] * Math.sqrt(r());
        px = Math.cos(a) * rr; py = Math.sin(a) * rr; pz = (r() - 0.5) * s[1];
      } else {
        const u = norm3([sym(r), sym(r), sym(r)]), rr = s[0] * Math.cbrt(r());
        px = u[0] * rr; py = u[1] * rr; pz = u[2] * rr;
      }
    }
    xfP(M, px, py, pz, this.P, k);
    const scale = Math.hypot(M[0], M[1], M[2]) || 1;
    const d = norm3(xfV(M, dx, dy, dz));
    const speed = ((e.speedCtl ? interpValue(e.speedCtl.interp, loopTime(e.speedCtl, t), e.speed) : e.speed) + sym(r) * e.speed_var) * scale;
    this.V[k] = d[0] * speed; this.V[k + 1] = d[1] * speed; this.V[k + 2] = d[2] * speed;
    const rad = (e.radiusCtl ? interpValue(e.radiusCtl.interp, loopTime(e.radiusCtl, t), e.radius) : e.radius) + sym(r) * e.radius_var;
    this.R[i] = Math.max(0, rad) * scale;
    const life = (e.lifeCtl ? interpValue(e.lifeCtl.interp, loopTime(e.lifeCtl, t), e.life) : e.life) + sym(r) * e.life_var;
    this.L[i] = Math.max(0.02, life);
    this.A[i] = Math.min(age, this.L[i] * 0.5);
    const c = e.color || [1, 1, 1, 1];
    for (let q = 0; q < 4; q++) this.C[i * 4 + q] = c[q];
    const ro = this.rot;
    if (ro) {
      this.ROT[i] = ro.angle + sym(r) * ro.angle_var;
      let sp = ro.speed + sym(r) * ro.speed_var;
      if (ro.random_sign && r() < 0.5) sp = -sp;
      this.RS[i] = sp;
    } else { this.ROT[i] = 0; this.RS[i] = 0; }
    const st = this.subtex;
    if (st) {
      this.F0[i] = st.start + Math.floor(r() * Math.max(0, st.start_fudge));
      this.FPS[i] = Math.max(0, st.fps + sym(r) * st.fps_fudge);
      this.LS[i] = st.loop_start + Math.floor(r() * Math.max(0, st.loop_start_fudge));
    }
  }

  // colour and alpha at life fraction f (BSPSysSimpleColorModifier, engine-notes §26)
  colorAt(i, f, out) {
    const m = this.color;
    if (!m) { for (let q = 0; q < 4; q++) out[q] = this.C[i * 4 + q]; return out; }
    const [a, b, e, g] = m.keys, c = m.colors;
    let c0, c1, s;
    if (!(g > 0) || b < a || e < b || g < e) { c0 = c1 = c[1]; s = 0; }          // keys unused: the middle colour
    else if (f <= a) { c0 = c1 = c[0]; s = 0; }
    else if (f < b) { c0 = c[0]; c1 = c[1]; s = (f - a) / (b - a); }
    else if (f <= e) { c0 = c1 = c[1]; s = 0; }
    else if (f < g) { c0 = c[1]; c1 = c[2]; s = (f - e) / (g - e); }
    else { c0 = c1 = c[2]; s = 0; }
    for (let q = 0; q < 3; q++) out[q] = c0[q] + (c1[q] - c0[q]) * s;
    // alpha: the middle colour's alpha (the peak opacity) through the fade-in / fade-out envelope. The colours'
    // own alphas mostly repeat the same fade (0 -> peak -> 0 at almost the same percentages); applying both
    // would fade twice (a fire barrel's smoke vanished by 40 % of its life)
    let env = 1;
    if (m.fade_in > 0 && f < m.fade_in) env = f / m.fade_in;
    if (m.fade_out < 1 && f > m.fade_out) env = Math.min(env, (1 - f) / (1 - m.fade_out));
    out[3] = c[1][3] * Math.max(0, env);
    return out;
  }

  // Camera-facing quads into the caller's arrays (4 vertices per particle): positions (xyz), uv, rgba bytes.
  // cam: { right, up, eye }. Returns { count, center, radius } of what was written.
  build(pos, uv, col, cam, aspect) {
    const n = this.n, { P, V, A, L, R, ROT } = this;
    if (!n) return { count: 0 };
    const [rx, ry, rz] = cam.right, [ux, uy, uz] = cam.up, eye = cam.eye;
    // blended (not additive): far to near, so near smoke covers far smoke
    let order = null;
    if (!this.additive && n > 1) {
      order = new Uint32Array(n); const d = new Float32Array(n);
      for (let i = 0; i < n; i++) { order[i] = i; const k = i * 3; d[i] = (P[k] - eye[0]) ** 2 + (P[k + 1] - eye[1]) ** 2 + (P[k + 2] - eye[2]) ** 2; }
      order.sort((x, y) => d[y] - d[x]);
    }
    const [ar, aflags, ar2, s1, s2] = aspect, frames = this.frames, st = this.subtex, scales = this.scales;
    const c = [0, 0, 0, 0];
    let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity, hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity, big = 0;
    for (let o = 0; o < n; o++) {
      const i = order ? order[o] : o, k = i * 3, f = Math.min(1, A[i] / L[i]);
      this.colorAt(i, f, c);
      let size = R[i];
      if (scales) {
        const x = f * (scales.length - 1), j = Math.min(scales.length - 2, Math.floor(x)), w = x - j;
        size *= scales.length > 1 ? scales[j] + (scales[j + 1] - scales[j]) * w : scales[0];
      }
      // shape: width = size x aspect, height = size; sparks stretch with speed and turn along their motion
      let ratio = ar || 1;
      const vx = V[k], vy = V[k + 1], vz = V[k + 2];
      if (aflags & 256) {
        const sp = Math.hypot(vx, vy, vz), tt = s2 > s1 ? Math.min(1, Math.max(0, (sp - s1) / (s2 - s1))) : 0;
        ratio = ar + (ar2 - ar) * tt;
      }
      let Rx, Ry, Rz, Ux, Uy, Uz;
      const sx = vx * rx + vy * ry + vz * rz, sy = vx * ux + vy * uy + vz * uz, sl = Math.hypot(sx, sy);
      if ((aflags & 1) && sl > 1e-4) {
        const a = sx / sl, b = sy / sl;                   // up along the screen-space velocity
        Ux = a * rx + b * ux; Uy = a * ry + b * uy; Uz = a * rz + b * uz;
        Rx = b * rx - a * ux; Ry = b * ry - a * uy; Rz = b * rz - a * uz;
      } else {
        const cs = Math.cos(ROT[i]), sn = Math.sin(ROT[i]);
        Rx = cs * rx + sn * ux; Ry = cs * ry + sn * uy; Rz = cs * rz + sn * uz;
        Ux = -sn * rx + cs * ux; Uy = -sn * ry + cs * uy; Uz = -sn * rz + cs * uz;
      }
      const hw = size * ratio, hh = size;
      // flipbook frame (frames per second from the particle's own start frame, looping from the loop frame)
      let u0 = 0, du = 1, v0 = 0, dv = 1;
      if (frames) {
        let fr = 0;
        if (st) {
          fr = this.F0[i] + A[i] * this.FPS[i];
          if (fr > st.end) { const ls = Math.min(this.LS[i], st.end), span = st.end - ls + 1; fr = span > 1 ? ls + ((fr - ls) % span) : st.end; }
        }
        const q = frames[Math.max(0, Math.min(frames.length - 1, Math.floor(fr)))];
        u0 = q[0]; du = q[1]; v0 = q[2]; dv = q[3];
      }
      const px = P[k], py = P[k + 1], pz = P[k + 2], b = o * 12, t = o * 8, cb = o * 16;
      // corners: top-left, top-right, bottom-right, bottom-left (v grows downwards in the texture)
      pos[b] = px - Rx * hw + Ux * hh; pos[b + 1] = py - Ry * hw + Uy * hh; pos[b + 2] = pz - Rz * hw + Uz * hh;
      pos[b + 3] = px + Rx * hw + Ux * hh; pos[b + 4] = py + Ry * hw + Uy * hh; pos[b + 5] = pz + Rz * hw + Uz * hh;
      pos[b + 6] = px + Rx * hw - Ux * hh; pos[b + 7] = py + Ry * hw - Uy * hh; pos[b + 8] = pz + Rz * hw - Uz * hh;
      pos[b + 9] = px - Rx * hw - Ux * hh; pos[b + 10] = py - Ry * hw - Uy * hh; pos[b + 11] = pz - Rz * hw - Uz * hh;
      uv[t] = u0; uv[t + 1] = v0; uv[t + 2] = u0 + du; uv[t + 3] = v0;
      uv[t + 4] = u0 + du; uv[t + 5] = v0 + dv; uv[t + 6] = u0; uv[t + 7] = v0 + dv;
      const r8 = Math.round(Math.min(1, Math.max(0, c[0])) * 255), g8 = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
      const b8 = Math.round(Math.min(1, Math.max(0, c[2])) * 255), a8 = Math.round(Math.min(1, Math.max(0, c[3])) * 255);
      for (let vtx = 0; vtx < 4; vtx++) { const q = cb + vtx * 4; col[q] = r8; col[q + 1] = g8; col[q + 2] = b8; col[q + 3] = a8; }
      if (px < lo0) lo0 = px; if (py < lo1) lo1 = py; if (pz < lo2) lo2 = pz;
      if (px > hi0) hi0 = px; if (py > hi1) hi1 = py; if (pz > hi2) hi2 = pz;
      const ext = Math.max(hw, hh); if (ext > big) big = ext;
    }
    return { count: n, center: [(lo0 + hi0) / 2, (lo1 + hi1) / 2, (lo2 + hi2) / 2],
      radius: Math.hypot(hi0 - lo0, hi1 - lo1, hi2 - lo2) / 2 + big * 1.5 };
  }
}

// a * inverse(b) for rigid-ish world matrices (the move of an object-space system's node since the last frame)
function mulInv(a, b) {
  const det = b[0] * (b[5] * b[10] - b[6] * b[9]) - b[4] * (b[1] * b[10] - b[2] * b[9]) + b[8] * (b[1] * b[6] - b[2] * b[5]);
  if (!det) return null;
  let same = true;
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6) { same = false; break; }
  if (same) return null;
  const id = 1 / det, inv = new Float32Array(16);
  inv[0] = (b[5] * b[10] - b[6] * b[9]) * id; inv[1] = (b[2] * b[9] - b[1] * b[10]) * id; inv[2] = (b[1] * b[6] - b[2] * b[5]) * id;
  inv[4] = (b[6] * b[8] - b[4] * b[10]) * id; inv[5] = (b[0] * b[10] - b[2] * b[8]) * id; inv[6] = (b[2] * b[4] - b[0] * b[6]) * id;
  inv[8] = (b[4] * b[9] - b[5] * b[8]) * id; inv[9] = (b[1] * b[8] - b[0] * b[9]) * id; inv[10] = (b[0] * b[5] - b[1] * b[4]) * id;
  inv[12] = -(inv[0] * b[12] + inv[4] * b[13] + inv[8] * b[14]);
  inv[13] = -(inv[1] * b[12] + inv[5] * b[13] + inv[9] * b[14]);
  inv[14] = -(inv[2] * b[12] + inv[6] * b[13] + inv[10] * b[14]);
  inv[15] = 1;
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let q = 0; q < 4; q++) s += a[q * 4 + r] * inv[c * 4 + q]; o[c * 4 + r] = s;
  }
  return o;
}
