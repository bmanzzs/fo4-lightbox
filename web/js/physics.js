// Physics: game mode on the models' own collision, items dropped with physics, and the collision view.
// The shapes are each NIF's Havok collision as the server reads it (server/collision.py, /api/collision: convex hulls
// with their rounding radius and triangle meshes, in the NIF's space). Rapier (web/vendor/rapier, Apache-2.0, loaded on
// first use) simulates them in Havok units (1 = 69.99125 game units, a metre) with Z up:
//   static: the loaded cell's landscape and every placed model's static / keyframed bodies (non-solid layers left out),
//           and the Studio floor outside a cell; built nearest the character first as the models' collision arrives;
//   items:  models dropped or thrown with physics (their dynamic bodies; a model without one drops as its hulls);
//   shown:  in the collision view, the loaded models' own collision follows them (it blocks nothing);
//   the character: a capsule moved by Rapier's character controller (steps, slopes, walls, pushing items).
// Nothing is written anywhere: a dropped item's place is the model's view-only transform (as the gizmo's).
import { refMatrix } from './renderer.js';

export const HK = 69.99125;
const GRAVITY = 9.81;
// collision layers (filter info & 0x7F) nothing walks into or lands on: water, triggers, traps' zones, non-collidable,
// cloud traps, portals, acoustic spaces, actor / projectile zones, gas traps, avoid boxes, camera, pick and line of
// sight layers, navmesh cuts, spell triggers (the Creation Engine's layer numbers)
const NONSOLID = new Set([11, 12, 14, 15, 16, 18, 21, 22, 23, 24, 34, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 51, 53, 54]);
const CAP_R = 0.3, CAP_H = 1.8;           // the character's capsule: radius, total height (Havok units)
const VIEW_R = 1700;                      // the collision view draws the static shapes this near the view's centre
const SHOWN = 0x00040000;                 // collision groups of the shown models' shapes: in no group's filter
const SOLID_QUERY = 0xFFFFFFFF;           // queries (character, camera) see every group that has a filter
export const COLORS = { static: [0.35, 0.82, 1.0, 0.7], item: [1.0, 0.62, 0.2, 0.95], model: [0.55, 1.0, 0.45, 0.95],
  char: [0.75, 1.0, 0.75, 0.55] };

let RAPIER = null;
async function loadRapier() {
  if (!RAPIER) {
    const m = await import('../vendor/rapier/rapier.mjs');
    await m.init();                       // (the WebAssembly is inside the module: nothing is fetched)
    RAPIER = m;
  }
  return RAPIER;
}
const bytes = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const toHK = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / HK; return o; };
const scaled = (a, s) => { if (Math.abs(s - 1) < 1e-4) return a; const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * s; return o; };
const yieldNow = () => new Promise(r => setTimeout(r, 0));

// a column-major 4 x 4 (rotation x scale s) -> unit quaternion
function quatOf(m, s = 1) {
  const r00 = m[0] / s, r10 = m[1] / s, r20 = m[2] / s, r01 = m[4] / s, r11 = m[5] / s, r21 = m[6] / s,
    r02 = m[8] / s, r12 = m[9] / s, r22 = m[10] / s, tr = r00 + r11 + r22;
  let x, y, z, w;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = S / 4; x = (r21 - r12) / S; y = (r02 - r20) / S; z = (r10 - r01) / S; }
  else if (r00 > r11 && r00 > r22) { const S = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / S; x = S / 4; y = (r01 + r10) / S; z = (r02 + r20) / S; }
  else if (r11 > r22) { const S = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / S; x = (r01 + r10) / S; y = S / 4; z = (r12 + r21) / S; }
  else { const S = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / S; x = (r02 + r20) / S; y = (r12 + r21) / S; z = S / 4; }
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}
// unit quaternion -> 3 x 3, column-major
function rotOf(q) {
  const { x, y, z, w } = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
// the shortest turn of +Y (Rapier's capsule axis) onto d
function yTo(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1, v = [d[0] / l, d[1] / l, d[2] / l];
  if (v[1] < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const s = Math.sqrt((1 + v[1]) * 2);                      // axis (0,1,0) x v = (v.z, 0, -v.x)
  return { x: v[2] / s, y: 0, z: -v[0] / s, w: s / 2 };
}

export class Physics {
  constructor(R, api, cells) {
    this.R = R; this.api = api; this.cells = cells;
    this.RA = null; this.world = null; this.loading = null;
    this.shapes = new Map();               // 'path|placed' -> promise of the model's bodies (Havok units)
    this.statics = new Set();              // handles of the fixed bodies of the cell / floor
    this.refBody = new Map();              // placed reference id -> its fixed body (doors switch theirs off when open)
    this.colNode = new Map();              // collider handle -> the node its body hangs on (lower case)
    this.land = new Map();                 // landscape body handle -> its cell's corner (Havok units)
    this.floor = null;                     // the Studio floor's body
    this.staticOf = null;                  // the cell answer (or 'floor:z') the statics were built for
    this.buildToken = 0;
    this.items = new Map();                // model -> { rb, xf, root, scale }   (dropped with physics)
    this.tracked = new Map();              // model -> { rb } | null             (shown in the collision view)
    this.show = false; this.charOn = false;
    this.status = { models: 0, done: 0, colliders: 0 };
    this.lines = { stat: null, statAt: null, statN: -1 };
  }

  get ready() { return !!this.world; }
  // something to simulate or draw this frame
  get active() { return !!this.world && (this.show || this.items.size > 0 || this.charOn); }

  async ensure() {
    if (this.world) return this;
    if (!this.loading) this.loading = (async () => {
      const RA = this.RA = await loadRapier();
      const w = new RA.World({ x: 0, y: 0, z: -GRAVITY });
      w.timestep = 1 / 60;
      const cc = w.createCharacterController(0.02);
      cc.setUp({ x: 0, y: 0, z: 1 });
      cc.setMaxSlopeClimbAngle(50 * Math.PI / 180);
      cc.setMinSlopeSlideAngle(55 * Math.PI / 180);
      cc.enableAutostep(0.55, 0.12, false);          // ~38 game units of step (stairs, curbs)
      cc.enableSnapToGround(0.6);
      cc.setSlideEnabled(true);
      cc.setApplyImpulsesToDynamicBodies(true);
      cc.setCharacterMass(80);
      this.cc = cc;
      this.charCol = w.createCollider(RA.ColliderDesc.capsule(CAP_H / 2 - CAP_R, CAP_R).setRotation(yTo([0, 0, 1]))
        .setTranslation(0, 0, -1000));      // (out of the way until game mode)
      this.world = w;
    })();
    await this.loading;
    return this;
  }

  // ------------------------------------------------------------------------------------------------ model shapes
  // a model's bodies, in Havok units: { motion, mass, friction, restitution, solid, hulls: [{ p, r }], meshes: [{ p, t }] }
  shapesOf(path, placed) {
    const key = path.toLowerCase() + (placed ? '|p' : '');
    let s = this.shapes.get(key);
    if (!s) {
      s = this.api(`collision?path=${encodeURIComponent(path)}${placed ? '&placed=1' : ''}`).then(c => (c.bodies || []).map(b => ({
        motion: b.motion, mass: b.mass, friction: b.friction, restitution: b.restitution, layer: b.layer,
        node: (b.node || '').toLowerCase(),
        solid: !NONSOLID.has(b.layer),
        hulls: b.hulls.map(h => ({ p: toHK(new Float32Array(bytes(h.v))), r: h.r / HK })),
        meshes: b.meshes.map(m => ({ p: toHK(new Float32Array(bytes(m.v))), t: new Uint32Array(bytes(m.t)) })),
      }))).catch(() => []);
      this.shapes.set(key, s);
    }
    return s;
  }

  // collider choices of one body: for each shape, descriptions to try in turn (Rapier builds a hull only when the
  // collider is made, and throws if the points have no volume). Points scaled by s; dynamic: meshes become their
  // hull, as Rapier does not collide moving triangle meshes with the static ones
  descs(b, s, dynamic) {
    const RA = this.RA, out = [];
    const hull = (p, r) => {
      const alts = [];
      if (r > 0.003) alts.push(() => RA.ColliderDesc.roundConvexHull(p, r));
      alts.push(() => RA.ColliderDesc.convexHull(p));
      const n = p.length / 3;
      if (n === 1) alts.push(() => RA.ColliderDesc.ball(Math.max(r, 0.01)).setTranslation(p[0], p[1], p[2]));
      if (n === 2) {
        const a = [p[0], p[1], p[2]], c = [p[3], p[4], p[5]], dv = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        alts.push(() => RA.ColliderDesc.capsule(Math.hypot(...dv) / 2, Math.max(r, 0.01))
          .setTranslation((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2).setRotation(yTo(dv)));
      }
      if (n >= 3) alts.push(() => {                 // flat: thickened along the plane's normal, so it has a volume
        const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
        let nrm = null;
        for (let k = 2; k < n && !nrm; k++) {
          const e2 = [p[3 * k] - p[0], p[3 * k + 1] - p[1], p[3 * k + 2] - p[2]];
          const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...c);
          if (l > 1e-6) nrm = c.map(v => v / l);
        }
        if (!nrm) return null;
        const t = Math.max(r, 0.004), q = new Float32Array(p.length * 2);
        for (let k = 0; k < n; k++) for (let j = 0; j < 3; j++) { q[3 * k + j] = p[3 * k + j] + nrm[j] * t; q[3 * (n + k) + j] = p[3 * k + j] - nrm[j] * t; }
        return RA.ColliderDesc.convexHull(q);
      });
      return alts;
    };
    for (const h of b.hulls) out.push(hull(scaled(h.p, s), h.r * s));
    for (const m of b.meshes) {
      const p = scaled(m.p, s);
      out.push(dynamic ? hull(p, 0) : [() => RA.ColliderDesc.trimesh(p, m.t)]);
    }
    const fr = b.friction > 0 ? b.friction : 0.5, re = Math.min(0.6, Math.max(0, b.restitution));
    return out.map(alts => alts.map(f => () => { const d = f(); return d && d.setFriction(fr).setRestitution(re); }));
  }
  // make each shape's first choice that works, on body rb (mod: changes to the description); returns the colliders
  attach(choices, rb, mod) {
    const made = [];
    for (const alts of choices) for (const f of alts) {
      try {
        const d = f();
        if (!d) continue;
        made.push(this.world.createCollider(mod ? mod(d) : d, rb));
        break;
      } catch (e) { /* no volume: the next choice */ }
    }
    return made;
  }

  // ------------------------------------------------------------------------------------------------ statics
  clearStatics() {
    this.buildToken++;
    for (const h of this.statics) { const rb = this.world.getRigidBody(h); if (rb) this.world.removeRigidBody(rb); }
    this.statics.clear(); this.land.clear(); this.refBody.clear(); this.colNode.clear(); this.floor = null;
    this.staticOf = null;
    this.status = { models: 0, done: 0, colliders: 0 };
    this.lines.stat = null;
  }
  fixedAt(t, q) {
    const rb = this.world.createRigidBody(this.RA.RigidBodyDesc.fixed().setTranslation(t[0], t[1], t[2]).setRotation(q));
    this.statics.add(rb.handle);
    return rb;
  }
  // the loaded cell (or the Studio floor) as fixed bodies; rebuilt when the cell changed
  syncStatics() {
    const R = this.R, data = this.cells.data;
    const key = R.cellMode ? (data || 'loading') : `floor:${(R.ground ? R.ground.z : 0).toFixed(1)}`;
    if (key === this.staticOf) return;
    // another place: dropped items go back to the character (their ground is gone)
    const place = R.cellMode ? data : 'studio';
    if (this.placeOf !== undefined && place !== this.placeOf) for (const m of [...this.items.keys()]) { this.release(m); R.setModelXform(m, null); }
    this.placeOf = place;
    this.clearStatics();
    this.staticOf = key;
    if (!R.cellMode || R.cellFloor) {
      const z = R.ground ? R.ground.z : 0;
      this.floor = this.fixedAt([0, 0, z / HK - 1], { x: 0, y: 0, z: 0, w: 1 });
      this.world.createCollider(this.RA.ColliderDesc.cuboid(2000, 2000, 1).setFriction(0.8), this.floor);
      this.status.colliders++;
    }
    if (data && R.cellMode) this.buildCell(data, this.buildToken);
  }
  async buildCell(c, token) {
    const RA = this.RA, W = this.world;
    // landscape: one triangle mesh per cell (33 x 33 heights 128 units apart), as world.js buildLand draws it
    for (const L of c.land || []) {
      if (!L.heights) continue;
      const ox = L.grid[0] * 4096, oy = L.grid[1] * 4096, p = new Float32Array(33 * 33 * 3), t = new Uint32Array(32 * 32 * 6);
      for (let r = 0; r < 33; r++) for (let k = 0; k < 33; k++) p.set([(ox + k * 128) / HK, (oy + r * 128) / HK, L.heights[r * 33 + k] / HK], (r * 33 + k) * 3);
      let o = 0;
      for (let r = 0; r < 32; r++) for (let k = 0; k < 32; k++) { const a = r * 33 + k, b = a + 1, c2 = a + 33, d = c2 + 1; t.set([a, b, d, a, d, c2], o); o += 6; }
      const rb = this.fixedAt([0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
      W.createCollider(RA.ColliderDesc.trimesh(p, t).setFriction(0.8), rb);
      this.land.set(rb.handle, [ox / HK, oy / HK]);
      this.status.colliders++;
    }
    // the placed models, nearest the character first
    const pp = this.R.playerPos, groups = new Map();
    for (const r of c.refs || []) {
      if (!r.model) continue;
      const k = r.model.toLowerCase();
      if (!groups.has(k)) groups.set(k, { path: r.model, items: [], dist: Infinity });
      const g = groups.get(k);
      g.items.push(r);
      g.dist = Math.min(g.dist, Math.hypot(r.pos[0] - pp[0], r.pos[1] - pp[1], r.pos[2] - pp[2]));
    }
    const queue = [...groups.values()].sort((a, b) => a.dist - b.dist);
    this.status.models = queue.length;
    let last = performance.now();
    const worker = async () => {
      while (queue.length && token === this.buildToken) {
        const g = queue.shift();
        const bodies = await this.shapesOf(g.path, true);
        if (token !== this.buildToken) return;
        const solid = bodies.filter(b => b.solid);
        if (solid.length) for (const r of g.items) {
          const s = r.scale || 1, M = refMatrix(r.pos, r.rot, r.rot2, s);
          const rb = this.fixedAt([M[12] / HK, M[13] / HK, M[14] / HK], quatOf(M, s));
          for (const b of solid) for (const c of this.attach(this.descs(b, s, false), rb)) {
            this.colNode.set(c.handle, b.node);            // (a door's moving parts: setRefSolid)
            this.status.colliders++;
          }
          if (r.ref) this.refBody.set(r.ref, rb);
        }
        this.status.done++;
        if (performance.now() - last > 8) { await yieldNow(); last = performance.now(); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // a placed reference's collision on or off (an open door lets the character through). nodes: the moving parts (lower
  // case node names): only their shapes change, the frame and threshold stay solid; when none of the shapes hangs on
  // one of them, the hulls change and triangle meshes (frames, floors) stay
  setRefSolid(ref, on, nodes) {
    const rb = this.world && this.refBody.get(ref);
    if (!rb) return;
    const cs = Array.from({ length: rb.numColliders() }, (_, i) => rb.collider(i));
    let pick = nodes ? cs.filter(c => nodes.has(this.colNode.get(c.handle))) : cs;
    if (nodes && !pick.length) pick = cs.filter(c => c.shapeType() !== this.RA.ShapeType.TriMesh);
    for (const c of pick) c.setEnabled(on);
    this.lines.stat = null;
  }

  // ------------------------------------------------------------------------------------------------ the character
  setCharacter(on) {
    this.charOn = on;
    if (!on && this.charCol) this.charCol.setTranslation({ x: 0, y: 0, z: -1000 });
  }
  // move the capsule standing at feet (game units) by d (game units): where it ends up, and whether it stands. air:
  // airborne (no snapping down onto the ground below: the fall plays out)
  moveCharacter(feet, d, air = false) {
    const RA = this.RA, c = this.charCol, ch = c.handle;
    if (air !== this.charAir) { if (air) this.cc.disableSnapToGround(); else this.cc.enableSnapToGround(0.6); this.charAir = air; }
    c.setTranslation({ x: feet[0] / HK, y: feet[1] / HK, z: feet[2] / HK + CAP_H / 2 + 0.02 });
    this.cc.computeColliderMovement(c, { x: d[0] / HK, y: d[1] / HK, z: d[2] / HK }, RA.QueryFilterFlags.EXCLUDE_SENSORS,
      SOLID_QUERY, (o) => o.handle !== ch);
    const m = this.cc.computedMovement();
    const out = [feet[0] + m.x * HK, feet[1] + m.y * HK, feet[2] + m.z * HK];
    c.setTranslation({ x: out[0] / HK, y: out[1] / HK, z: out[2] / HK + CAP_H / 2 + 0.02 });
    return { pos: out, grounded: this.cc.computedGrounded() };
  }
  // distance along a unit ray (game units) to the first static or item surface, or null (the camera's wall check)
  castRay(from, dir, dist) {
    const RA = this.RA;
    const ray = new RA.Ray({ x: from[0] / HK, y: from[1] / HK, z: from[2] / HK }, { x: dir[0], y: dir[1], z: dir[2] });
    const hit = this.world.castRay(ray, dist / HK, true, RA.QueryFilterFlags.EXCLUDE_SENSORS | RA.QueryFilterFlags.EXCLUDE_DYNAMIC,
      SOLID_QUERY, this.charCol);
    return hit ? (hit.timeOfImpact ?? hit.toi) * HK : null;
  }

  // ------------------------------------------------------------------------------------------------ items
  // a model's world matrix (the character's placement x its view transform): column-major, game units
  modelWorld(m) {
    const P = this.R.playerRoot, X = m.xform;
    if (!X) return Float32Array.from(P);
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = P[r] * X[c * 4] + P[4 + r] * X[c * 4 + 1] + P[8 + r] * X[c * 4 + 2] + P[12 + r] * X[c * 4 + 3];
    return o;
  }
  canDrop(m) { return !!(m && m.loadArgs && !m.refBody && !m.shapes.some(s => s.skinData)); }
  // drop (or throw: v = velocity, game units/s) a model with physics, from where it is or from opts.from (a matrix)
  async drop(m, opts = {}) {
    await this.ensure();
    this.syncStatics();                    // (the place as it is now: a place change after this sends items back)
    const bodies = (await this.shapesOf(m.loadArgs.path, false)).filter(b => b.solid);
    if (!bodies.length) return { ok: false, why: 'it has no collision' };
    this.release(m);
    this.untrack(m);
    const RA = this.RA, W = this.world;
    const dyn = bodies.some(b => b.motion === 'dynamic') ? bodies.filter(b => b.motion === 'dynamic') : bodies;
    const M = opts.from || this.modelWorld(m);
    const s = Math.hypot(M[0], M[1], M[2]) || 1;
    const lift = opts.lift ?? 30;
    const rb = W.createRigidBody(RA.RigidBodyDesc.dynamic().setTranslation(M[12] / HK, M[13] / HK, (M[14] + lift) / HK)
      .setRotation(quatOf(M, s)).setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.08));
    const mass = dyn.reduce((a, b) => a + (b.mass || 0), 0) || 5;
    const ds = dyn.flatMap(b => this.descs(b, s, true));
    const made = this.attach(ds, rb, (d) => d.setMass(mass / ds.length)).length;
    if (!made) { W.removeRigidBody(rb); return { ok: false, why: 'its collision has no solid shape' }; }
    const v = opts.v || [0, 0, 0];
    rb.setLinvel({ x: v[0] / HK, y: v[1] / HK, z: v[2] / HK }, true);
    rb.setAngvel(opts.spin || { x: 0.12, y: -0.08, z: 0.05 }, true);      // (a slight tumble, as a hand lets go)
    this.items.set(m, { rb, xf: null, root: null, scale: s });
    return { ok: true, mass, shapes: made, dynamic: dyn !== bodies || bodies.every(b => b.motion === 'dynamic') };
  }
  release(m) {
    const it = this.items.get(m);
    if (it) { this.world.removeRigidBody(it.rb); this.items.delete(m); }
  }
  releaseAll() { for (const m of [...this.items.keys()]) this.release(m); }
  // the items' bodies -> the models' view transforms (relative to the character, which may have moved meanwhile)
  syncItems() {
    const R = this.R;
    let moved = false;
    for (const [m, it] of this.items) {
      if (!R.models.includes(m) || (it.xf && m.xf !== it.xf)) { this.release(m); continue; }   // removed, or reset / moved by hand
      if (it.xf && it.rb.isSleeping() && it.root === R.playerRoot) continue;
      const t = it.rb.translation(), r = rotOf(it.rb.rotation()), P = R.playerRoot;
      // X = P^-1 W, P a turn about Z and a move: rows of P's rotation applied to W's columns and offset
      const back = (v) => [P[0] * v[0] + P[1] * v[1] + P[2] * v[2], P[4] * v[0] + P[5] * v[1] + P[6] * v[2], P[8] * v[0] + P[9] * v[1] + P[10] * v[2]];
      const xf = { t: back([t.x * HK - P[12], t.y * HK - P[13], t.z * HK - P[14]]),
        r: [...back(r.slice(0, 3)), ...back(r.slice(3, 6)), ...back(r.slice(6, 9))], s: [it.scale, it.scale, it.scale], c: [0, 0, 0] };
      R.setModelXform(m, xf);
      it.xf = m.xf; it.root = R.playerRoot;
      moved = true;
    }
    return moved;
  }

  // ------------------------------------------------------------------------------------------------ collision view
  // the loaded models' own collision (the Studio, a model looked at): bodies that follow the models and block nothing
  async track(m) {
    if (this.tracked.has(m) || this.items.has(m) || !m.loadArgs || m.refBody) return;
    this.tracked.set(m, null);
    const bodies = (await this.shapesOf(m.loadArgs.path, false)).filter(b => b.solid);
    if (!this.tracked.has(m) || !bodies.length) return;
    const rb = this.world.createRigidBody(this.RA.RigidBodyDesc.kinematicPositionBased());
    for (const b of bodies) this.attach(this.descs(b, 1, false), rb, (d) => d.setCollisionGroups(SHOWN));
    this.tracked.set(m, { rb });
  }
  untrack(m) {
    const t = this.tracked.get(m);
    if (t) this.world.removeRigidBody(t.rb);
    this.tracked.delete(m);
  }
  syncTracked() {
    const R = this.R;
    if (this.show) for (const m of R.models) if (m.role === 'main' && m.visible && !this.items.has(m)) this.track(m);
    for (const [m, t] of this.tracked) {
      if (!R.models.includes(m) || !m.visible || !this.show || this.items.has(m)) { this.untrack(m); continue; }
      if (!t) continue;
      const M = this.modelWorld(m), s = Math.hypot(M[0], M[1], M[2]) || 1;
      t.rb.setTranslation({ x: M[12] / HK, y: M[13] / HK, z: M[14] / HK }, false);
      t.rb.setRotation(quatOf(M, s), false);
    }
  }
  async setShow(on) {
    this.show = on;
    this.lines.stat = null;
    if (on) await this.ensure();
    else { for (const m of [...this.tracked.keys()]) this.untrack(m); this.R.collisionLines = null; this.R.version++; }
  }
  // line lists for the renderer: the static shapes near the view's centre (kept until the centre moves or more arrive),
  // then each frame the items, the shown models and the character
  buildLines(force) {
    const R = this.R, W = this.world, c = R.camera, L = this.lines;
    let rebuilt = false;
    const at = [c.target[0] + c.pan[0], c.target[1] + c.pan[1], c.target[2] + c.pan[2]];
    const far = !L.statAt || Math.hypot(at[0] - L.statAt[0], at[1] - L.statAt[1], at[2] - L.statAt[2]) > VIEW_R * 0.3;
    if (!L.stat || far || L.statN !== this.status.colliders) {
      const r2 = (VIEW_R / HK) ** 2, a = [at[0] / HK, at[1] / HK, at[2] / HK], cell = 4096 / HK;
      const near = (col) => {
        const p = col.parent();
        if (!p || !this.statics.has(p.handle) || (this.floor && p.handle === this.floor.handle)) return false;
        const land = this.land.get(p.handle);
        if (land) return a[0] > land[0] - 20 && a[0] < land[0] + cell + 20 && a[1] > land[1] - 20 && a[1] < land[1] + cell + 20;
        const t = p.translation();
        return (t.x - a[0]) ** 2 + (t.y - a[1]) ** 2 + (t.z - a[2]) ** 2 < r2;
      };
      L.stat = { pos: this.lineEnds(W.debugRender(undefined, near)), color: COLORS.static };
      L.statAt = at; L.statN = this.status.colliders;
      rebuilt = true;
    }
    if (!rebuilt && !force && R.collisionLines) return false;
    const of = (pred) => this.lineEnds(W.debugRender(undefined, pred));
    const itemSet = new Set([...this.items.values()].map(i => i.rb.handle));
    const shownSet = new Set([...this.tracked.values()].filter(Boolean).map(t => t.rb.handle));
    const sets = [L.stat];
    if (itemSet.size) sets.push({ pos: of((col) => !!col.parent() && itemSet.has(col.parent().handle)), color: COLORS.item });
    if (shownSet.size) sets.push({ pos: of((col) => !!col.parent() && shownSet.has(col.parent().handle)), color: COLORS.model });
    if (this.charOn) { const ch = this.charCol.handle; sets.push({ pos: of((col) => col.handle === ch), color: COLORS.char }); }
    R.collisionLines = sets;
    return true;
  }
  shownSig() {
    let s = '';
    for (const [m, t] of this.tracked) if (t) { const X = m.xform; s += `${t.rb.handle}:${X ? X[12].toFixed(1) + ',' + X[13].toFixed(1) + ',' + X[14].toFixed(1) + ',' + X[0].toFixed(3) + ',' + X[1].toFixed(3) : '-'};`; }
    return s + this.R.playerPos.map(v => v.toFixed(1)).join(',') + this.R.playerHeading.toFixed(3);
  }
  // debugRender's line ends in game units, without the 0.5-long body axes it adds (one pure colour channel each)
  lineEnds(b) {
    const v = b.vertices, c = b.colors, o = new Float32Array(v.length);
    let n = 0;
    for (let i = 0; i + 1 < v.length / 3; i += 2) {
      const r = Math.abs(c[4 * i]), g = Math.abs(c[4 * i + 1]), bl = Math.abs(c[4 * i + 2]);
      const pure = (r > 0.01) + (g > 0.01) + (bl > 0.01) === 1;
      if (pure && Math.abs(Math.hypot(v[3 * i + 3] - v[3 * i], v[3 * i + 4] - v[3 * i + 1], v[3 * i + 5] - v[3 * i + 2]) - 0.5) < 0.01) continue;
      for (let k = 0; k < 6; k++) o[n++] = v[3 * i + k] * HK;
    }
    return o.subarray(0, n);
  }

  // ------------------------------------------------------------------------------------------------ each frame
  // dt: seconds since the last frame. True when something moved (the view must be drawn again)
  tick(dt) {
    if (!this.active) return false;
    this.syncStatics();
    this.syncTracked();
    const W = this.world;
    W.timestep = Math.min(1 / 30, Math.max(1 / 240, dt || 1 / 60));
    W.step();                               // (also brings newly built shapes into the scene queries)
    const moved = this.syncItems();
    // the view's lines: again when the statics' set changed, something moved, or the shown models moved
    const sig = this.shownSig();
    if (this.show && this.buildLines(moved || this.charOn || sig !== this.lines.sig)) this.R.version++;
    this.lines.sig = sig;
    return moved;
  }
}
