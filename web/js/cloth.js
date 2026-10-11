// Cloth physics preview. A worn NIF's Havok cloth data (decoded by server/cloth.py) run by the viewer's own
// position-based solver: not Havok (closed, it cannot ship), but the same particles, constraint sets in the game's
// order, body capsules, gravity, damping and motion transfer the game is given, stepped like the game does it
// (a fixed 60 Hz frame split into the cloth's substeps, few solver iterations: soft). The result is the world matrix
// of each cloth bone (CLOTH_BN_*); the renderer skins the meshes with them.
//
// Per frame: skin the simulation mesh to the posed body bones -> pin the fixed particles there -> hand over part of
// the body's motion (transfer motion: the cloth does not lag behind a running character) -> integrate (gravity,
// damping per second as exp(-d t)) -> constraint sets and collisions in the cloth's execution order -> cloth bones
// from their particle triangles. With physics off (or at the first frame) the particles sit where the game's
// "Animate" state puts them: on the skinned mesh.

const STEP = 1 / 60;           // the game steps cloth once per frame; a fixed 60 Hz frame here
const MAX_STEPS = 4;           // at most this many per drawn frame (a slow frame does not run away)
const TELEPORT_MOVE = 120;     // units per frame: the character was moved, not walked -> start again on the body
const TELEPORT_TURN = 1.2;     // radians per frame

// ---- small column-major 4x4 helpers on Float64Array (the scene's matrices are column-major too)
function mul(a, b, o) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function invertRigid(m, o) {     // rotation (+ uniform scale) and translation
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = m[r * 4 + c] / s2;
  o[3] = o[7] = o[11] = 0; o[15] = 1;
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  return o;
}

// The rotation part of a bone matrix without scale or shear (polar decomposition): a cloth bone comes from a particle
// triangle, which stretches and shears when the cloth gives; the bone keeps its position and turns with the triangle,
// but the mesh skinned to it is not stretched into spikes. Determinant-scaled iteration R <- (gR + (gR)^-T) / 2,
// g = |det R|^(-1/3), run until it converges (plain iterations stall on strongly squashed triangles). False for a
// degenerate matrix (the caller keeps the last good rotation).
function orthonormalize(M) {
  let a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], k = M[10];
  for (let it = 0; it < 20; it++) {
    // cofactors C_ij of [[a b c] [d e f] [g h k]]; the inverse transpose is C / det
    const A = e * k - f * h, B = f * g - d * k, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-12)) return false;
    const D = c * h - b * k, E = a * k - c * g, F = b * g - a * h;
    const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
    const gs = Math.cbrt(1 / Math.abs(det)), s = 0.5 / (det * gs), u = 0.5 * gs;
    const na = u * a + A * s, nb = u * b + B * s, nc = u * c + C * s, nd = u * d + D * s, ne = u * e + E * s;
    const nf = u * f + F * s, ng = u * g + G * s, nh = u * h + H * s, nk = u * k + I * s;
    const ch = Math.abs(na - a) + Math.abs(nb - b) + Math.abs(nc - c) + Math.abs(nd - d) + Math.abs(ne - e) +
      Math.abs(nf - f) + Math.abs(ng - g) + Math.abs(nh - h) + Math.abs(nk - k);
    a = na; b = nb; c = nc; d = nd; e = ne; f = nf; g = ng; h = nh; k = nk;
    if (ch < 1e-12) break;
  }
  M[0] = a; M[4] = b; M[8] = c; M[1] = d; M[5] = e; M[9] = f; M[2] = g; M[6] = h; M[10] = k;
  return true;
}

export class Cloth {
  constructor(d) {
    this.d = d;
    this.name = d.name;
    this.lbones = d.bones.map(s => s.toLowerCase());
    this.rest = d.rest.map(a => Float64Array.from(a));
    const nb = d.bones.length;
    this.B = Array.from({ length: nb }, () => new Float64Array(16));      // bone world matrices this frame
    this.B0 = Array.from({ length: nb }, () => new Float64Array(16));     // ... last frame
    // skinned simulation mesh
    const sk = d.skin;
    this.S = sk.count;
    this.ent = sk.entries.map(e => ({ bone: e.bone, bfs: Float64Array.from(e.bfs), M: new Float64Array(16) }));
    this.sn = Int32Array.from(sk.n); this.se = Int32Array.from(sk.e); this.sw = Float64Array.from(sk.w);
    this.sp = Float64Array.from(sk.pos); this.snr = Float64Array.from(sk.nrm);
    this.skinP = new Float64Array(3 * this.S); this.skinN = new Float64Array(3 * this.S);
    this.skinP0 = new Float64Array(3 * this.S); this.skinN0 = new Float64Array(3 * this.S);
    // particles
    const P = d.particles, n = P.count;
    this.n = n;
    this.inv = Float64Array.from(P.inv); this.rad = Float64Array.from(P.radius);
    this.pose = Float64Array.from(P.pose); this.anim = Int32Array.from(P.anim);
    this.fixedP = Int32Array.from(P.fixed.map(f => f[0])); this.fixedS = Int32Array.from(P.fixed.map(f => f[1]));
    this.X = new Float64Array(3 * n); this.Xp = new Float64Array(3 * n);
    this.mask = Uint32Array.from(d.masks);
    this.cb = d.cloth_bones.map(c => ({ bone: c.bone, lname: this.lbones[c.bone], tri: c.tri, L: Float64Array.from(c.local),
      sim: new Float64Array(16), prevL: new Float64Array(16), curL: new Float64Array(16), out: new Float32Array(16) }));
    this.st = d.settings;
    this.sets = d.sets.map(s => this.prepSet(s));
    this.cols = d.collidables.map(c => c.kind === 'capsule' ? { ...c, off: Float64Array.from(c.offset), M: new Float64Array(16),
      A: new Float64Array(3), Bp: new Float64Array(3) } : null);
    this.anyCollide = this.mask.some(m => m !== 0) && this.cols.some(c => c);
    // the bones this cloth reads (skinning, capsules, planes, transfer)
    const need = new Set(this.ent.map(e => e.bone));
    for (const c of this.cols) if (c) need.add(c.bone);
    for (const s of this.sets) if (s.type === 'planes') for (const b of s.bone) need.add(b);
    need.add(this.st.transfer.bone);
    this.need = [...need];
    // the particles the shown cloth bones are made of: the still test looks at these only
    this.shown = Int32Array.from(new Set(this.cb.flatMap(c => c.tri)));
    this.freezeLoose();
    this.started = false;
    this.acc = 0;
    this.quiet = 0;              // frames in a row with (almost) nothing moving
    this.active = true;
    this.tmp = new Float64Array(16); this.tmp2 = new Float64Array(16);
  }

  // particles with no constraint path to a pinned particle or to the body (a range constraint on the skin) would fall
  // for ever (e.g. 49 particles of Lorenzo's outfit): those no cloth bone uses are frozen (they show nothing)
  freezeLoose() {
    const n = this.n, up = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
    const join = (i, j) => { up[find(i)] = find(j); };
    for (const s of this.sets) {
      if (s.a && s.b) for (let l = 0; l < s.a.length; l++) join(s.a[l], s.b[l]);
      else if (s.type === 'bend') for (let l = 0; l + 3 < s.p.length; l += 4) { join(s.p[l], s.p[l + 1]); join(s.p[l], s.p[l + 2]); join(s.p[l], s.p[l + 3]); }
      else if (s.type === 'range' && s.ref_particle) for (let l = 0; l < s.p.length; l++) join(s.p[l], s.ref[l]);
    }
    const anchored = new Set();
    for (let p = 0; p < n; p++) if (this.inv[p] === 0) anchored.add(find(p));
    for (const p of this.fixedP) anchored.add(find(p));
    for (const s of this.sets) if (s.type === 'range' && !s.ref_particle) for (const p of s.p) anchored.add(find(p));
    const shown = new Set(this.shown), loose = [];
    for (let p = 0; p < n; p++) if (!anchored.has(find(p)) && !shown.has(p) && this.inv[p] !== 0) { this.inv[p] = 0; loose.push(p); }
    this.loose = Int32Array.from(loose);      // carried on the body each frame (placeLoose), never simulated
  }
  placeLoose() {
    if (!this.loose.length) return;
    const tb = this.st.transfer.bone, R = mul(this.B[tb], invertRigid(this.rest[tb], this.tmp), this.tmp2);
    for (const p of this.loose) {
      const s = this.anim[p], q = 3 * p;
      if (s >= 0) { this.X[q] = this.skinP[3 * s]; this.X[q + 1] = this.skinP[3 * s + 1]; this.X[q + 2] = this.skinP[3 * s + 2]; }
      else {
        const x = this.pose[q], y = this.pose[q + 1], z = this.pose[q + 2];
        this.X[q] = R[0] * x + R[4] * y + R[8] * z + R[12]; this.X[q + 1] = R[1] * x + R[5] * y + R[9] * z + R[13];
        this.X[q + 2] = R[2] * x + R[6] * y + R[10] * z + R[14];
      }
      this.Xp[q] = this.X[q]; this.Xp[q + 1] = this.X[q + 1]; this.Xp[q + 2] = this.X[q + 2];
    }
  }

  prepSet(s) {
    const I = (a) => Int32Array.from(a), F = (a) => Float64Array.from(a);
    // standard / compressible / bend links store their stiffness divided by (1/massA + 1/massB): x that sum is exactly
    // 1.000 for all 44,000 vanilla links. Stretch links (tethers, 0.9-1.0) are stored as they are.
    const undiv = (a, b, k) => Float64Array.from(k, (v, l) => Math.min(1, v * (this.inv[a[l]] + this.inv[b[l]])));
    // the solver's stiffness per constraint (stiff: the settings never change), worked out once instead of in every
    // iteration of every substep: sk, skmin, skmax next to k, kmin, kmax
    const adapt = (o, ...keys) => { for (const k of keys) o['s' + k] = Float64Array.from(o[k], v => this.stiff(v)); return o; };
    if (s.type === 'link') return adapt({ ...s, a: I(s.a), b: I(s.b), rest: F(s.rest), k: undiv(s.a, s.b, s.k) }, 'k');
    if (s.type === 'stretch') return adapt({ ...s, a: I(s.a), b: I(s.b), rest: F(s.rest), k: F(s.k) }, 'k');
    if (s.type === 'compress') return adapt({ ...s, a: I(s.a), b: I(s.b), rest: F(s.rest), min: F(s.min), k: undiv(s.a, s.b, s.k) }, 'k');
    if (s.type === 'bendlink') return adapt({ ...s, a: I(s.a), b: I(s.b), min: F(s.min), max: F(s.max), kmin: undiv(s.a, s.b, s.kmin),
      kmax: undiv(s.a, s.b, s.kmax) }, 'kmin', 'kmax');
    if (s.type === 'bend') return adapt({ ...s, p: I(s.p), w: F(s.w), k: F(s.k), rest: F(s.rest) }, 'k');
    if (s.type === 'range') return { ...s, p: I(s.p), ref: I(s.ref), max: F(s.max), nmax: F(s.nmax), nmin: F(s.nmin) };
    if (s.type === 'planes') {
      const o = { ...s, p: I(s.p), bone: I(s.bone), plane: F(s.plane), k: F(s.k), sign: 1 };
      // which side is "outside": the side the rest pose is on (the data does not say)
      let neg = 0;
      for (let i = 0; i < o.p.length; i++) {
        const R = this.rest[o.bone[i]], inv = invertRigid(R, new Float64Array(16)), q = o.p[i] * 3;
        const x = this.pose[q], y = this.pose[q + 1], z = this.pose[q + 2];
        const bx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12], by = inv[1] * x + inv[5] * y + inv[9] * z + inv[13],
          bz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
        if (o.plane[i * 4] * bx + o.plane[i * 4 + 1] * by + o.plane[i * 4 + 2] * bz + o.plane[i * 4 + 3] < 0) neg++;
      }
      if (neg > o.p.length / 2) o.sign = -1;
      return o;
    }
    return s;
  }

  // the body bones this frame: getBone(i, lname, rest) -> world matrix (16 numbers, column-major). B0 / skinP0 keep
  // the body as it was at the last solver step (a display faster than 60 Hz draws frames without a step)
  readBones(getBone) {
    for (const i of this.need) this.B[i].set(getBone(i, this.lbones[i], this.rest[i]));
  }
  stepped() {
    for (const i of this.need) this.B0[i].set(this.B[i]);
    this.skinP0.set(this.skinP); this.skinN0.set(this.skinN);
  }

  skin() {
    for (const e of this.ent) mul(this.B[e.bone], e.bfs, e.M);
    const P = this.skinP, N = this.skinN, sp = this.sp, sn = this.snr;
    for (let v = 0; v < this.S; v++) {
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
      const x = sp[3 * v], y = sp[3 * v + 1], z = sp[3 * v + 2], a = sn[3 * v], b = sn[3 * v + 1], c = sn[3 * v + 2];
      for (let k = 0; k < this.sn[v]; k++) {
        const M = this.ent[this.se[4 * v + k]].M, w = this.sw[4 * v + k];
        px += w * (M[0] * x + M[4] * y + M[8] * z + M[12]); py += w * (M[1] * x + M[5] * y + M[9] * z + M[13]);
        pz += w * (M[2] * x + M[6] * y + M[10] * z + M[14]);
        nx += w * (M[0] * a + M[4] * b + M[8] * c); ny += w * (M[1] * a + M[5] * b + M[9] * c); nz += w * (M[2] * a + M[6] * b + M[10] * c);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      P[3 * v] = px; P[3 * v + 1] = py; P[3 * v + 2] = pz;
      N[3 * v] = nx / l; N[3 * v + 1] = ny / l; N[3 * v + 2] = nz / l;
    }
  }

  // particles on the skinned mesh (the game's Animate state); the few without a skinned vertex ride rigidly with
  // the transfer bone from their rest pose
  placeOnBody() {
    const tb = this.st.transfer.bone;
    const R = mul(this.B[tb], invertRigid(this.rest[tb], this.tmp), this.tmp2);
    for (let p = 0; p < this.n; p++) {
      const s = this.anim[p], q = 3 * p;
      if (s >= 0) { this.X[q] = this.skinP[3 * s]; this.X[q + 1] = this.skinP[3 * s + 1]; this.X[q + 2] = this.skinP[3 * s + 2]; }
      else {
        const x = this.pose[q], y = this.pose[q + 1], z = this.pose[q + 2];
        this.X[q] = R[0] * x + R[4] * y + R[8] * z + R[12]; this.X[q + 1] = R[1] * x + R[5] * y + R[9] * z + R[13];
        this.X[q + 2] = R[2] * x + R[6] * y + R[10] * z + R[14];
      }
    }
    this.Xp.set(this.X);
  }

  // dt: seconds of animation time since the last call; simulate false = physics off (cloth follows the body).
  // True when the cloth bones were written again.
  update(dt, getBone, simulate = true) {
    this.readBones(getBone);
    if (this.started && !simulate) {    // physics off and the body did not move: nothing to write
      let d = 0;
      for (const i of this.need) for (let j = 0; j < 16; j++) d = Math.max(d, Math.abs(this.B[i][j] - this.B0[i][j]));
      if (d < 1e-5) return false;
    }
    this.skin();
    if (!this.started || !simulate) {
      this.started = true;
      this.placeOnBody();
      this.stepped();
      this.acc = 0;
      this.active = simulate;
      this.writeBones(); this.keepLocal(true); this.compose(1, true);
      return true;
    }
    // the transfer bone's motion since the last solver step: teleports start the cloth again on the body
    const tb = this.st.transfer.bone, A = this.B0[tb], Bm = this.B[tb];
    const dx = Bm[12] - A[12], dy = Bm[13] - A[13], dz = Bm[14] - A[14];
    const turn = this.relRotation(A, Bm);
    if (Math.hypot(dx, dy, dz) > TELEPORT_MOVE || turn.angle > TELEPORT_TURN) {
      this.placeOnBody(); this.stepped(); this.acc = 0; this.writeBones(); this.keepLocal(true); this.compose(1, true); return true;
    }
    if (!this.active) {                 // settled: nothing to do until the body moves
      let d = 0;
      for (const i of this.need) for (let j = 0; j < 16; j++) d = Math.max(d, Math.abs(this.B[i][j] - this.B0[i][j]));
      if (d < 1e-5) { this.acc = 0; return false; }
      this.active = true; this.quiet = 0;
    }
    this.acc += Math.max(0, dt);
    const K = Math.min(MAX_STEPS, Math.floor(this.acc / STEP + 1e-6));   // (1e-6: exact 60 Hz frames step every time)
    if (K === 0) {
      // paused (no time) while the body changed pose (another clip, a pose button): the pinned rows would stay where
      // they were on the body, so the cloth starts again on it
      if (!(dt > 0) && this.poseChanged()) {
        this.placeOnBody(); this.stepped(); this.writeBones(); this.keepLocal(true); this.compose(1, true); return true;
      }
      return this.compose(this.acc / STEP);   // between steps: shown in between, on the body as it is now
    }
    this.acc = Math.min(Math.max(0, this.acc - K * STEP), STEP);
    const T = this.st.transfer, frameTime = K * STEP;
    const speed = Math.hypot(dx, dy, dz) / frameTime, aspeed = turn.angle * 180 / Math.PI / frameTime;
    const ramp = (v, sp, bl) => sp[1] <= sp[0] ? bl[1] : bl[0] + (bl[1] - bl[0]) * Math.min(1, Math.max(0, (v - sp[0]) / (sp[1] - sp[0])));
    const bt = T.on && T.translate ? ramp(speed, T.tspeed, T.tblend) : 0;
    const br = T.on && T.rotate ? ramp(aspeed, T.rspeed, T.rblend) : 0;
    let moved = 0, prevDone = false;
    for (let k = 0; k < K; k++) {
      // hand over this step's share of the body's motion (both positions: no velocity is added)
      if (bt > 0 || br > 0) this.transfer([A[12] + dx * k / K, A[13] + dy * k / K, A[14] + dz * k / K],
        [dx / K * bt, dy / K * bt, dz / K * bt], turn.axis, turn.angle / K * br);
      moved = Math.max(moved, this.stepOnce(k, K));
      // several steps in one frame (a 60 Hz display whose frame times read 16.6 / 16.7 ms, or a slow frame): the
      // display blends from the step before the last one, not from the last frame's (K steps old), else it judders
      if (K >= 2 && k === K - 2) { this.writeBones(); this.keepPrevAt((K - 1) / K); prevDone = true; }
    }
    this.placeLoose();
    this.stepped();
    const before = this.cb.map(c => [c.curL[12], c.curL[13], c.curL[14]]);
    this.writeBones(); this.keepLocal(false, prevDone); this.compose(this.acc / STEP, true);
    // still: the particles shown stopped, or (a few cloths keep a tiny fight going) the cloth bones barely move on the
    // body; then the cloth sleeps and a still scene stops redrawing
    let boneMove = 0;
    this.cb.forEach((c, i) => { boneMove = Math.max(boneMove, Math.hypot(c.curL[12] - before[i][0], c.curL[13] - before[i][1], c.curL[14] - before[i][2])); });
    const still = (moved < 0.004 || boneMove < 0.01 * K) && speed < 0.5 && aspeed < 0.5;
    this.quiet = still ? this.quiet + 1 : 0;
    this.active = this.quiet < 30;
    return true;
  }

  relRotation(A, B) {                   // rotation taking A's axes to B's: axis + angle
    // R = Rb * Ra^T (unit axes)
    const sa = Math.hypot(A[0], A[1], A[2]) || 1, sb = Math.hypot(B[0], B[1], B[2]) || 1;
    const r = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let c = 0; c < 3; c++) s += (B[c * 4 + i] / sb) * (A[c * 4 + j] / sa);
      r[j * 3 + i] = s;
    }
    const tr = r[0] + r[4] + r[8], cos = Math.min(1, Math.max(-1, (tr - 1) / 2)), angle = Math.acos(cos);
    let ax = [r[5] - r[7], r[6] - r[2], r[1] - r[3]];
    const l = Math.hypot(...ax);
    ax = l > 1e-9 ? ax.map(v => v / l) : [0, 0, 1];
    return { axis: ax, angle };
  }

  transfer(pivot, shift, axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, [ux, uy, uz] = axis;
    const r00 = c + ux * ux * t, r01 = ux * uy * t - uz * s, r02 = ux * uz * t + uy * s;
    const r10 = uy * ux * t + uz * s, r11 = c + uy * uy * t, r12 = uy * uz * t - ux * s;
    const r20 = uz * ux * t - uy * s, r21 = uz * uy * t + ux * s, r22 = c + uz * uz * t;
    for (const Xa of [this.X, this.Xp]) for (let p = 0; p < this.n; p++) {
      if (this.inv[p] === 0) continue;
      const q = 3 * p, x = Xa[q] - pivot[0], y = Xa[q + 1] - pivot[1], z = Xa[q + 2] - pivot[2];
      Xa[q] = pivot[0] + r00 * x + r01 * y + r02 * z + shift[0];
      Xa[q + 1] = pivot[1] + r10 * x + r11 * y + r12 * z + shift[1];
      Xa[q + 2] = pivot[2] + r20 * x + r21 * y + r22 * z + shift[2];
    }
  }

  // one 60 Hz frame (k of K this drawn frame): substeps of integration + constraint passes
  stepOnce(k, K) {
    const st = this.st, sub = st.substeps, h = STEP / sub, X = this.X, Xp = this.Xp, inv = this.inv;
    const damp = Math.exp(-st.damping * h), g = st.gravity, gh = [g[0] * h * h, g[1] * h * h, g[2] * h * h];
    let moved = 0;
    const X0 = this._X0 || (this._X0 = new Float64Array(3 * this.n));
    X0.set(X);                                    // where the particles were before this step (the still test)
    for (let s = 0; s < sub; s++) {
      const a = (k + (s + 1) / sub) / K;           // how far from last frame's body to this one
      this.alpha = a;
      for (let p = 0; p < this.n; p++) {
        if (inv[p] === 0) continue;
        const q = 3 * p;
        for (let i = 0; i < 3; i++) {
          const v = (X[q + i] - Xp[q + i]) * damp;
          Xp[q + i] = X[q + i];
          X[q + i] += v + gh[i];
        }
      }
      for (let f = 0; f < this.fixedP.length; f++) {         // pinned particles follow the skinned mesh
        const q = 3 * this.fixedP[f], v = 3 * this.fixedS[f];
        for (let i = 0; i < 3; i++) { Xp[q + i] = X[q + i]; X[q + i] = this.skinP0[v + i] + (this.skinP[v + i] - this.skinP0[v + i]) * a; }
      }
      if (this.anyCollide) this.placeCollidables(a);
      for (let it = 0; it < st.iterations; it++) {
        this._it = it;
        for (const ce of st.execution) {
          if (ce === -1) { if (this.anyCollide) this.collide(); continue; }
          const set = this.sets[ce];
          if (set) this.solve(set);
        }
      }
    }
    // how far what is shown really moved this step (particles no cloth bone uses may swing unseen; X - Xp is not it:
    // a cloth held in shape by its bend constraints keeps a difference while it stands still)
    for (const p of this.shown) {
      const q = 3 * p;
      moved = Math.max(moved, Math.abs(X[q] - X0[q]) + Math.abs(X[q + 1] - X0[q + 1]) + Math.abs(X[q + 2] - X0[q + 2]));
    }
    return moved;
  }

  stiff(k) {                                   // adaptConstraintStiffness: the same stiffness for any iteration count
    return this.st.adapt && this.st.iterations > 1 ? 1 - Math.pow(1 - Math.min(k, 0.9999), 1 / this.st.iterations) : k;
  }

  solve(s) {
    const X = this.X, inv = this.inv;
    const pair = (i, j, target, k) => {            // move i, j toward distance `target`
      const qi = 3 * i, qj = 3 * j, wi = inv[i], wj = inv[j], w = wi + wj;
      if (w === 0) return;
      const dx = X[qj] - X[qi], dy = X[qj + 1] - X[qi + 1], dz = X[qj + 2] - X[qi + 2], L = Math.hypot(dx, dy, dz);
      if (L < 1e-9) return;
      const c = (L - target) / L * k / w;
      X[qi] += dx * c * wi; X[qi + 1] += dy * c * wi; X[qi + 2] += dz * c * wi;
      X[qj] -= dx * c * wj; X[qj + 1] -= dy * c * wj; X[qj + 2] -= dz * c * wj;
    };
    const dist = (i, j) => Math.hypot(X[3 * j] - X[3 * i], X[3 * j + 1] - X[3 * i + 1], X[3 * j + 2] - X[3 * i + 2]);
    switch (s.type) {
      case 'link':
        for (let l = 0; l < s.a.length; l++) pair(s.a[l], s.b[l], s.rest[l], s.sk[l]);
        break;
      case 'stretch':
        for (let l = 0; l < s.a.length; l++) if (dist(s.a[l], s.b[l]) > s.rest[l]) pair(s.a[l], s.b[l], s.rest[l], s.sk[l]);
        break;
      case 'compress':
        for (let l = 0; l < s.a.length; l++) {
          const L = dist(s.a[l], s.b[l]);
          if (L > s.rest[l]) pair(s.a[l], s.b[l], s.rest[l], s.sk[l]);
          else if (L < s.min[l]) pair(s.a[l], s.b[l], s.min[l], s.sk[l]);
        }
        break;
      case 'bendlink':
        for (let l = 0; l < s.a.length; l++) {
          const L = dist(s.a[l], s.b[l]);
          if (L < s.min[l]) pair(s.a[l], s.b[l], s.min[l], s.skmin[l]);
          else if (L > s.max[l]) pair(s.a[l], s.b[l], s.max[l], s.skmax[l]);
        }
        break;
      case 'bend': this.solveBend(s); break;
      case 'range': this.solveRange(s); break;
      case 'planes': this.solvePlanes(s); break;
      default: break;                             // not solved yet (volume constraints)
    }
  }

  solveBend(s) {
    const X = this.X, Xp = this.Xp, inv = this.inv, P = s.p, W = s.w;
    for (let l = 0; l < s.k.length; l++) {
      const k = s.sk[l];
      if (k <= 0) continue;
      const i0 = 3 * P[4 * l], i1 = 3 * P[4 * l + 1], i2 = 3 * P[4 * l + 2], i3 = 3 * P[4 * l + 3];
      let den = 0;
      for (let j = 0; j < 4; j++) den += W[4 * l + j] * W[4 * l + j] * inv[P[4 * l + j]];
      if (den <= 0) continue;
      // hinge frame now (as server/cloth.py built the rest vector): edge, mean normal of both triangles, binormal
      let ex = X[i1] - X[i0], ey = X[i1 + 1] - X[i0 + 1], ez = X[i1 + 2] - X[i0 + 2];
      const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
      const ax = X[i1] - X[i0], ay = X[i1 + 1] - X[i0 + 1], az = X[i1 + 2] - X[i0 + 2];
      const bx = X[i2] - X[i0], by = X[i2 + 1] - X[i0 + 1], bz = X[i2 + 2] - X[i0 + 2];
      const cx = X[i3] - X[i0], cy = X[i3 + 1] - X[i0 + 1], cz = X[i3 + 2] - X[i0 + 2];
      let n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
      let n2x = cy * az - cz * ay, n2y = cz * ax - cx * az, n2z = cx * ay - cy * ax;
      const l1 = Math.hypot(n1x, n1y, n1z) || 1, l2 = Math.hypot(n2x, n2y, n2z) || 1;
      let nx = n1x / l1 + n2x / l2, ny = n1y / l1 + n2y / l2, nz = n1z / l1 + n2z / l2;
      const d = nx * ex + ny * ey + nz * ez; nx -= ex * d; ny -= ey * d; nz -= ez * d;
      const nl = Math.hypot(nx, ny, nz);
      // the mean normal is only a frame while the wings are less than about 90-130 degrees apart: folded further, it
      // flips sign from step to step and the correction throws the particles through the fold and back (a hem that
      // twitches on a still body), so the constraint fades out there
      const fade = Math.min(1, Math.max(0, (nl - 0.8) / 0.6));
      if (fade <= 0) continue;
      nx /= nl; ny /= nl; nz /= nl;
      const qx = ny * ez - nz * ey, qy = nz * ex - nx * ez, qz = nx * ey - ny * ex;       // n x e
      const r0 = s.rest[3 * l], r1 = s.rest[3 * l + 1], r2 = s.rest[3 * l + 2];
      const tx = r0 * ex + r1 * nx + r2 * qx, ty = r0 * ey + r1 * ny + r2 * qy, tz = r0 * ez + r1 * nz + r2 * qz;
      let Cx = 0, Cy = 0, Cz = 0;
      for (let j = 0; j < 4; j++) {
        const q = 3 * P[4 * l + j], w = W[4 * l + j];
        Cx += w * X[q]; Cy += w * X[q + 1]; Cz += w * X[q + 2];
      }
      // half the stored stiffness: at full strength the corrections of neighbouring hinges overshoot each other and
      // some cloths (Children of Atom female skirt, Maxson's coat) shiver on a still body; not yet checked against the
      // game, like the rest of the solver's tuning
      const kf = 0.5 * k * fade, fx = (Cx - tx) * kf / den, fy = (Cy - ty) * kf / den, fz = (Cz - tz) * kf / den;
      // the target comes from the frame of the particles it moves: applied to the last positions too, the correction
      // reshapes the cloth without turning into velocity (else it pumps energy in and some cloths never come to rest)
      for (let j = 0; j < 4; j++) {
        const pj = P[4 * l + j], f = W[4 * l + j] * inv[pj], q = 3 * pj;
        X[q] -= fx * f; X[q + 1] -= fy * f; X[q + 2] -= fz * f;
        Xp[q] -= fx * f; Xp[q + 1] -= fy * f; Xp[q + 2] -= fz * f;
      }
    }
  }

  solveRange(s) {
    const X = this.X, a = this.alpha, k = s.k;
    for (let l = 0; l < s.p.length; l++) {
      const p = s.p[l];
      if (this.inv[p] === 0) continue;
      const q = 3 * p, r = s.ref[l];
      let rx, ry, rz, nx = 0, ny = 0, nz = 0;
      if (s.ref_particle) { rx = X[3 * r]; ry = X[3 * r + 1]; rz = X[3 * r + 2]; }
      else {
        const v = 3 * r, P0 = this.skinP0, P1 = this.skinP, N0 = this.skinN0, N1 = this.skinN;
        rx = P0[v] + (P1[v] - P0[v]) * a; ry = P0[v + 1] + (P1[v + 1] - P0[v + 1]) * a; rz = P0[v + 2] + (P1[v + 2] - P0[v + 2]) * a;
        nx = N0[v] + (N1[v] - N0[v]) * a; ny = N0[v + 1] + (N1[v + 1] - N0[v + 1]) * a; nz = N0[v + 2] + (N1[v + 2] - N0[v + 2]) * a;
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      }
      if (s.normal && !s.ref_particle) {
        const dn = (X[q] - rx) * nx + (X[q + 1] - ry) * ny + (X[q + 2] - rz) * nz;
        let c = 0;
        if (dn > s.nmax[l]) c = s.nmax[l] - dn; else if (dn < s.nmin[l]) c = s.nmin[l] - dn;
        if (c) { X[q] += nx * c * k; X[q + 1] += ny * c * k; X[q + 2] += nz * c * k; }
      }
      const dx = X[q] - rx, dy = X[q + 1] - ry, dz = X[q + 2] - rz, L = Math.hypot(dx, dy, dz), m = s.max[l];
      if (L > m) {
        const f = 1 - k * (1 - m / L);
        X[q] = rx + dx * f; X[q + 1] = ry + dy * f; X[q + 2] = rz + dz * f;
      }
    }
  }

  solvePlanes(s) {
    const X = this.X, inv = this.tmp;
    for (let l = 0; l < s.p.length; l++) {
      const p = s.p[l];
      if (this.inv[p] === 0) continue;
      const M = this.B[s.bone[l]];
      invertRigid(M, inv);
      const q = 3 * p, x = X[q], y = X[q + 1], z = X[q + 2];
      const bx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12], by = inv[1] * x + inv[5] * y + inv[9] * z + inv[13],
        bz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
      const pn = s.plane, sg = s.sign;
      const dist = sg * (pn[4 * l] * bx + pn[4 * l + 1] * by + pn[4 * l + 2] * bz + pn[4 * l + 3]);
      if (dist >= 0) continue;
      // push along the plane normal in world space
      let nx = sg * (M[0] * pn[4 * l] + M[4] * pn[4 * l + 1] + M[8] * pn[4 * l + 2]);
      let ny = sg * (M[1] * pn[4 * l] + M[5] * pn[4 * l + 1] + M[9] * pn[4 * l + 2]);
      let nz = sg * (M[2] * pn[4 * l] + M[6] * pn[4 * l + 1] + M[10] * pn[4 * l + 2]);
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const c = -dist * s.k[l];
      X[q] += nx * c; X[q + 1] += ny * c; X[q + 2] += nz * c;
    }
  }

  placeCollidables(a) {
    for (const c of this.cols) {
      if (!c) continue;
      // the bone between last frame and this one (translation lerp is enough between two close frames)
      const B0 = this.B0[c.bone], B1 = this.B[c.bone], T = this.tmp;
      for (let i = 0; i < 16; i++) T[i] = B0[i] + (B1[i] - B0[i]) * a;
      mul(T, c.off, c.M);
      const M = c.M;
      for (const [src, dst] of [[c.a, c.A], [c.b, c.Bp]]) {
        dst[0] = M[0] * src[0] + M[4] * src[1] + M[8] * src[2] + M[12];
        dst[1] = M[1] * src[0] + M[5] * src[1] + M[9] * src[2] + M[13];
        dst[2] = M[2] * src[0] + M[6] * src[1] + M[10] * src[2] + M[14];
      }
    }
  }

  // particles out of the body capsules (radius = capsule + particle; the cloth's collisionTolerance, up to 14 units in
  // vanilla coats, is Havok's contact-detection margin, not extra thickness: added here it blew skirts outward)
  collide() {
    const X = this.X;
    for (let p = 0; p < this.n; p++) {
      const m = this.mask[p];
      if (!m || this.inv[p] === 0) continue;
      const q = 3 * p;
      for (let ci = 0; ci < this.cols.length && ci < 32; ci++) {
        if (!(m & (1 << ci))) continue;
        const c = this.cols[ci];
        if (!c) continue;
        const A = c.A, B = c.Bp;
        const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2], dd = dx * dx + dy * dy + dz * dz;
        let t = dd > 0 ? ((X[q] - A[0]) * dx + (X[q + 1] - A[1]) * dy + (X[q + 2] - A[2]) * dz) / dd : 0;
        t = Math.min(1, Math.max(0, t));
        const cx = A[0] + dx * t, cy = A[1] + dy * t, cz = A[2] + dz * t;
        const vx = X[q] - cx, vy = X[q + 1] - cy, vz = X[q + 2] - cz, L = Math.hypot(vx, vy, vz);
        const r = c.ra + (c.rb - c.ra) * t + this.rad[p];
        if (L < r && L > 1e-9) {
          const f = r / L;
          X[q] = cx + vx * f; X[q + 1] = cy + vy * f; X[q + 2] = cz + vz * f;
        }
      }
    }
  }

  // Display. The solver steps at 60 Hz like the game, the body animates at the display's rate: shown as they are, the
  // cloth bones would judder against the body (and their shadows flicker) on a faster display. So each cloth bone is
  // kept relative to the transfer bone at the last two steps, blended by the time since the last step, and placed on
  // the transfer bone as it is in this frame: the cloth stays on the body every frame and its own swing runs smoothly.
  keepLocal(both, prevDone = false) {
    const inv = invertRigid(this.B[this.st.transfer.bone], this.tmp);
    for (const c of this.cb) {
      if (!both && !prevDone) c.prevL.set(c.curL);
      mul(inv, c.sim, c.curL);
      if (both) c.prevL.set(c.curL);
    }
  }
  // prevL from the cloth as it is now, relative to the transfer bone at fraction f between the last step and this frame
  keepPrevAt(f) {
    const tb = this.st.transfer.bone, A = this.B0[tb], Bm = this.B[tb], T = new Float64Array(16);
    for (let i = 0; i < 16; i++) T[i] = A[i] + (Bm[i] - A[i]) * f;
    const inv = invertRigid(T, this.tmp);
    for (const c of this.cb) mul(inv, c.sim, c.prevL);
  }
  // the body's pose (not just where it stands) changed since the last step: any bone moved relative to the transfer bone
  poseChanged() {
    const tb = this.st.transfer.bone, i0 = invertRigid(this.B0[tb], new Float64Array(16)), i1 = invertRigid(this.B[tb], new Float64Array(16));
    const r0 = new Float64Array(16), r1 = new Float64Array(16);
    for (const i of this.need) {
      if (i === tb) continue;
      mul(i0, this.B0[i], r0); mul(i1, this.B[i], r1);
      for (let j = 12; j < 15; j++) if (Math.abs(r0[j] - r1[j]) > 0.05) return true;
    }
    return false;
  }
  // false when nothing would change (no time passed, the body did not move): the renderer then skips the redraw
  compose(a, force = false) {
    a = Math.min(1, Math.max(0, a));
    const L = this.tmp2, Bt = this.B[this.st.transfer.bone], O = new Float64Array(16);
    const key = `${a}|${Bt.join(',')}`;
    if (!force && key === this._composed) return false;
    this._composed = key;
    for (const c of this.cb) {
      for (let i = 0; i < 16; i++) L[i] = c.prevL[i] + (c.curL[i] - c.prevL[i]) * a;
      if (a > 0 && a < 1 && !orthonormalize(L)) L.set(c.curL);
      mul(Bt, L, O);
      c.out.set(O);
    }
    return true;
  }

  // cloth bones: [A-G, B-G, (A-G)x(B-G), G] of their triangle x the stored local transform (world space)
  writeBones() {
    const X = this.X, T = this.tmp, O = this.tmp2;
    for (const c of this.cb) {
      const a = 3 * c.tri[0], b = 3 * c.tri[1], d = 3 * c.tri[2];
      const gx = (X[a] + X[b] + X[d]) / 3, gy = (X[a + 1] + X[b + 1] + X[d + 1]) / 3, gz = (X[a + 2] + X[b + 2] + X[d + 2]) / 3;
      const ux = X[a] - gx, uy = X[a + 1] - gy, uz = X[a + 2] - gz, vx = X[b] - gx, vy = X[b + 1] - gy, vz = X[b + 2] - gz;
      T[0] = ux; T[1] = uy; T[2] = uz; T[3] = 0;
      T[4] = vx; T[5] = vy; T[6] = vz; T[7] = 0;
      T[8] = uy * vz - uz * vy; T[9] = uz * vx - ux * vz; T[10] = ux * vy - uy * vx; T[11] = 0;
      T[12] = gx; T[13] = gy; T[14] = gz; T[15] = 1;
      mul(T, c.L, O);
      if (!orthonormalize(O)) {                 // a collapsed triangle: the last good rotation at the new centre
        for (let i = 0; i < 12; i++) O[i] = c.sim[i];
        if (!c.sim[15]) { O.fill(0); O[0] = O[5] = O[10] = O[15] = 1; O[12] = gx; O[13] = gy; O[14] = gz; }
      }
      c.sim.set(O);
    }
  }

  // move the whole simulation (re-centring a long treadmill run)
  shift(v) {
    for (const A of [this.X, this.Xp]) for (let p = 0; p < this.n; p++) { A[3 * p] += v[0]; A[3 * p + 1] += v[1]; A[3 * p + 2] += v[2]; }
    for (const A of [this.skinP0, this.skinP]) for (let s = 0; s < this.S; s++) { A[3 * s] += v[0]; A[3 * s + 1] += v[1]; A[3 * s + 2] += v[2]; }
    for (const M of [...this.B0, ...this.B]) { M[12] += v[0]; M[13] += v[1]; M[14] += v[2]; }
  }

  // debug: particle positions and capsules (world space)
  debugShapes() {
    return { particles: this.X, capsules: this.cols.filter(c => c).map(c => ({ a: [...c.A], b: [...c.Bp], ra: c.ra, rb: c.rb })) };
  }
}
