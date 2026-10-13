// Cell viewer: loads a cell (or a block of exterior cells) from the server and builds it in the renderer:
// landscape quadrants, water planes, placed lights and every placed model (one template per NIF, drawn at each
// placement). Models stream in nearest first, so the view fills from where the camera is.
import { defaultEnv, ambientRows, lin, refMatrix } from './renderer.js';

const DEFAULT_LAYER = { d: 'textures\\landscape\\ground\\commonwealthdefault01_d.dds',
  n: 'textures\\landscape\\ground\\commonwealthdefault01_n.dds', s: 'textures\\landscape\\ground\\commonwealthdefault01_s.dds' };
const TILE = 512;                 // landscape texture repeat, game units (same as the calibrated ground)
// The last few cells' answers: the server builds a cell's references again on every request (0.3-0.6 s for an
// exterior block), so going back to a place asked for the same data again. The answers are only read here (lights,
// decals and instances are copied into new objects). Cleared by File > Reload game files (a plugin change reloads
// the page, and with it this).
const CELL_MEMO = new Map(), CELL_MEMO_MAX = 3;
export function clearCellMemo() { CELL_MEMO.clear(); }
function cellAnswer(api, path) {
  let q = CELL_MEMO.get(path);
  if (q) { CELL_MEMO.delete(path); CELL_MEMO.set(path, q); return q; }       // most recently used last
  q = api(path);
  q.catch(() => { if (CELL_MEMO.get(path) === q) CELL_MEMO.delete(path); });
  CELL_MEMO.set(path, q);
  if (CELL_MEMO.size > CELL_MEMO_MAX) CELL_MEMO.delete(CELL_MEMO.keys().next().value);
  return q;
}

export class CellLoader {
  constructor(R, api, onProgress) {
    this.R = R; this.api = api; this.onProgress = onProgress || (() => {});
    this.token = 0; this.info = null; this.interiorEnv = null;
  }

  unload() {
    this.token++;
    this.R.clearCell();
    this.info = null; this.data = null; this.interiorEnv = null; this.spawn = null; this.focus = null;
    this.lodTemplates = [];      // freed with the cell (their JS data would stay alive until the next exterior's LOD)
    this.R.scheduleSweep();      // the cell's textures are unused now (renderer sweepTextures)
  }

  // Resolves with the cell once its models are placed ('done': the character stands, the caller frames the view); the
  // distant land (loadLod) starts with the last model requests and streams on: this.lodDone resolves when it is in
  // (or will not come). Callers that render a finished picture (place previews, the dev hooks) await both.
  open(formid, radius = 1, camera = null) {
    const run = { lod: null };
    const p = this._open(formid, radius, camera, run);
    this.lodDone = p.catch(() => {}).then(() => run.lod).then(() => {
      if (run.token === this.token) this.R.scheduleSweep();     // the previous cell's textures are unused now
    }, () => {});
    return p;
  }
  async _open(formid, radius, camera, run) {
    const token = run.token = ++this.token, R = this.R;
    this.onProgress({ phase: 'reading', done: 0, total: 0 });
    const c = await cellAnswer(this.api, `cell?id=${encodeURIComponent(formid)}&r=${radius}`);
    if (token !== this.token) return null;
    R.clearCell();
    this.lodTemplates = [];
    R.cellMode = true;
    this.info = c.cell;
    this.data = c;               // the references and the landscape (physics.js builds the cell's collision from them)
    // an interior flagged Use Sky Lighting (the viewer's Simple scene) is lit by the weather like an exterior
    this.interiorEnv = c.cell.interior && !c.cell.sky ? interiorEnv(c.lighting, c.imagespace) : null;

    for (const L of c.land) this.buildLand(L);
    for (const w of c.water || []) R.addWater(w.grid[0] * 4096, w.grid[1] * 4096, (w.grid[0] + 1) * 4096, (w.grid[1] + 1) * 4096, w.height);
    // placed lights (§8). LIGH flags: 0x20 Off By Default, 0x400 Shadow Spotlight, 0x800 Shadow Hemisphere, 0x1000
    // Shadow Omnidirectional, 0x4000 Non-Shadow Spotlight, 0x8000 Non Specular, 0x100000 Ambient Only. A spotlight
    // shines along its reference's +X axis (rot (0, 270, 0) = straight down, as the ceiling spots are placed) within
    // its FOV; fade, FOV, shadow bias and near clip include the reference's XLIG adjustments. Shadow-casting lights
    // (§23): kind 1 spot, 2 hemisphere, 3 omni; nothing nearer to the light than its near clip casts (the lamp's own
    // fitting)
    R.setPointLights(c.refs.filter(r => r.light && r.light.radius > 0 && !(r.light.flags & 0x20) && (r.light.fade ?? 1) > 0)
      .map(r => {
        const L = r.light, spot = !!(L.flags & 0x4400);
        const Rm = refMatrix(r.pos, r.rot, null, 1);
        const dir = [Rm[0], Rm[1], Rm[2]];
        const half = Math.min(179, Math.max(1, L.fov || 90)) * Math.PI / 360;
        const shadow = L.flags & 0x100000 ? 0 : L.flags & 0x400 ? 1 : L.flags & 0x800 ? 2 : L.flags & 0x1000 ? 3 : 0;
        return {
          id: r.ref, pos: r.pos, radius: L.radius,
          color: lin(L.color).map(v => v * Math.max(0, L.fade ?? 1)),
          att: [L.constant ?? 0, L.scalar || 1, L.exponent || 2],
          spec: L.flags & 0x8000 ? 0 : 1, ambient: L.flags & 0x100000 ? 1 : 0,
          dir, cone: spot ? Math.cos(half) : -2, falloff: Math.max(0.01, L.falloff || 1),
          shadow, near: Math.max(0, L.near || 0), bias: L.shadow_bias ?? 1,
          // §24 a spotlight's own god rays (GDRY): colours x scales, phases, intensity, near clip of the rays
          gr: L.god_rays && (L.god_rays.intensity ?? 0) > 0 ? { intensity: L.god_rays.intensity,
            air: (L.god_rays.air_color || [0, 0, 0]).map(v => v * (L.god_rays.air_color_scale ?? 0)),
            fwd: (L.god_rays.fwd_color || [0, 0, 0]).map(v => v * (L.god_rays.fwd_color_scale ?? 0)),
            back: (L.god_rays.back_color || [0, 0, 0]).map(v => v * (L.god_rays.back_color_scale ?? 0)),
            gF: L.god_rays.fwd_phase ?? 0, gB: L.god_rays.back_phase ?? 0, near: L.god_rays.near || 0 } : null,
        };
      }));

    // §22 projected decals (placed texture sets: grime, blood, scorch marks, puddles)
    R.setDecals(c.refs.filter(r => r.decal));

    // where to look and where the character stands: the cell's COC marker (where the console's coc puts the player)
    // or the navmesh nearest the middle (server side); else the middle cell of an exterior block / the placed objects
    this.spawn = c.spawn || null;
    const focus = this.focus = c.spawn?.pos || this.focusPoint(c);
    if (camera) camera(focus, c.cell.interior);

    // one template per model and material swap (a STAT's MODS or the reference's own, e.g. the blue cryo pipes)
    const groups = new Map();
    for (const r of c.refs) {
      if (!r.model) continue;
      const k = r.model.toLowerCase() + '|' + (r.swap || '');
      if (!groups.has(k)) groups.set(k, { path: r.model, swap: r.swap || '', items: [], dist: Infinity });
      const g = groups.get(k);
      g.items.push(r);
      g.dist = Math.min(g.dist, Math.hypot(r.pos[0] - focus[0], r.pos[1] - focus[1], r.pos[2] - focus[2]));
    }
    const queue = [...groups.values()].sort((a, b) => a.dist - b.dist);
    const total = queue.length;
    let done = 0, failed = 0, placed = 0;
    this.onProgress({ phase: 'models', done, total, cell: c });
    const startLod = () => {
      if (!run.lod && !c.cell.interior && c.cell.grid && c.cell.world && R.settings.lod !== false && token === this.token)
        run.lod = this.loadLod(c, radius, token);
    };
    const worker = async () => {
      while (queue.length && token === this.token) {
        const g = queue.shift();
        try {
          const req = this.api(`nif?path=${encodeURIComponent(g.path)}${g.swap ? `&swap=${g.swap}` : ''}&placed=1`);
          if (!queue.length) startLod();          // the last model requests are out: the distant land's go after them
          const sc = await req;
          if (token !== this.token) return;
          const tpl = R.addTemplate(sc);
          R.placeInstances(tpl, g.items);
          placed += g.items.length;
        } catch (e) {
          if (token !== this.token) return;       // a request of a cell that was left meanwhile: nothing to report
          failed++;
        }
        done++;
        this.onProgress({ phase: 'models', done, total, failed, placed, cell: c });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (token !== this.token) return null;
    this.onProgress({ phase: 'done', done, total, failed, placed, cell: c });
    startLod();                                    // (a cell without models)
    return c;
  }

  // Distant LOD beyond the loaded cells, as the game draws it: the worldspace's terrain chunks (.btr: one Land mesh
  // over 4 x 4 cells, placed at the chunk's corner) out to 12 cells, the object LOD (.bto: trees, rocks, buildings,
  // already in world space) out to 8, and level-8 terrain out to 32. What the loaded cells draw themselves is cut out
  // on the server (the triangles wholly inside); the LOD water shape is left to the cells' water planes.
  async loadLod(c, radius, token) {
    const R = this.R, ws = c.cell.world.toLowerCase(), [gx, gy] = c.cell.grid, C = 4096;
    const hole = [(gx - radius) * C, (gy - radius) * C, (gx + radius + 1) * C, (gy + radius + 1) * C];
    const jobs = [];
    const add = (lvl, ext, reach, cutRect, placeAt) => {
      const cx = Math.floor(gx / lvl) * lvl, cy = Math.floor(gy / lvl) * lvl, n = Math.ceil(reach / lvl);
      for (let X = cx - n * lvl; X <= cx + n * lvl; X += lvl) for (let Y = cy - n * lvl; Y <= cy + n * lvl; Y += lvl) {
        const r = [X * C, Y * C, (X + lvl) * C, (Y + lvl) * C];
        if (r[0] >= cutRect[0] && r[1] >= cutRect[1] && r[2] <= cutRect[2] && r[3] <= cutRect[3]) continue;   // all loaded
        const o = placeAt ? [X * C, Y * C] : [0, 0];
        const overlap = r[0] < cutRect[2] && r[2] > cutRect[0] && r[1] < cutRect[3] && r[3] > cutRect[1];
        const cut = overlap ? [cutRect[0] - o[0], cutRect[1] - o[1], cutRect[2] - o[0], cutRect[3] - o[1]].join(',') : '';
        const dir = ext === 'bto' ? `${ws}\\objects` : ws;
        jobs.push({ path: `meshes\\terrain\\${dir}\\${ws}.${lvl}.${X}.${Y}.${ext}`, cut, pos: [o[0], o[1], 0],
          dist: Math.hypot((X + lvl / 2) - (gx + 0.5), (Y + lvl / 2) - (gy + 0.5)) + (ext === 'bto' ? 0.5 : 0) + lvl });
      }
    };
    add(4, 'btr', 12, hole, true);
    add(4, 'bto', 8, hole, false);
    const n4 = 12 / 4, c4x = Math.floor(gx / 4) * 4, c4y = Math.floor(gy / 4) * 4;
    add(8, 'btr', 32, [(c4x - n4 * 4) * C, (c4y - n4 * 4) * C, (c4x + n4 * 4 + 4) * C, (c4y + n4 * 4 + 4) * C], true);
    jobs.sort((a, b) => a.dist - b.dist);
    this.lodTemplates = [];
    const worker = async () => {
      while (jobs.length && token === this.token) {
        const j = jobs.shift();
        try {
          const sc = await this.api(`nif?path=${encodeURIComponent(j.path)}&placed=1${j.cut ? `&cut=${j.cut}` : ''}`);
          if (token !== this.token) return;
          const tpl = R.addTemplate(sc);
          tpl.lod = true;
          for (const s of tpl.shapes) if (s.mat.kind !== 'lighting') s.hidden = true;     // the LOD water
          for (const s of tpl.shapes) s.visible = !s.hidden && R.settings.lod !== false;
          R.placeInstances(tpl, [{ pos: j.pos, rot: [0, 0, 0], scale: 1, edid: 'LOD' }]);
          this.lodTemplates.push(tpl);
        } catch (e) { /* no chunk there (beyond the map) */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }
  // the Distant land switch: show or hide what loadLod placed (an exterior opened while it was off loads none)
  setLod(on) {
    for (const t of this.lodTemplates || []) for (const s of t.shapes) s.visible = on && !s.hidden;
    this.R.nonCasterChange(); this.R.version++;      // distant LOD casts no shadows (renderer placeInstances)
  }

  focusPoint(c) {
    if (!c.cell.interior && c.cell.grid) {
      const [gx, gy] = c.cell.grid;
      const L = c.land.find(l => l.grid[0] === gx && l.grid[1] === gy);
      const z = L && L.heights ? L.heights[16 * 33 + 16] : median(c.refs.map(r => r.pos[2]));
      return [(gx + 0.5) * 4096, (gy + 0.5) * 4096, z];
    }
    const xs = c.refs.map(r => r.pos[0]), ys = c.refs.map(r => r.pos[1]), zs = c.refs.map(r => r.pos[2]);
    return [median(xs), median(ys), median(zs)];
  }

  // one LAND record -> four quadrant meshes, each with up to four blended layers (base + strongest additional)
  buildLand(L) {
    const [gx, gy] = L.grid, ox = gx * 4096, oy = gy * 4096;
    const H = L.heights || new Array(1089).fill(0), C = L.colors;
    const h = (r, c) => H[Math.min(32, Math.max(0, r)) * 33 + Math.min(32, Math.max(0, c))];
    for (let q = 0; q < 4; q++) {
      const x0 = (q & 1) * 16, y0 = (q >> 1) * 16;
      const info = L.layers.find(l => l.quad === q) || { base: null, layers: [] };
      // compositing: each layer covers the ones below it by its alpha
      const N = 17 * 17;
      const sets = [{ tex: info.base, w: new Float32Array(N).fill(1) }];
      for (const ly of info.layers) {
        if (!ly.tex || !ly.tex.diffuse) continue;
        const a = new Float32Array(N);
        for (const [pos, al] of ly.alpha) if (pos < N) a[pos] = al;
        for (const st of sets) for (let i = 0; i < N; i++) st.w[i] *= 1 - a[i];
        sets.push({ tex: ly.tex, w: a });
      }
      const keep = [sets[0], ...sets.slice(1).map(st => [st, st.w.reduce((x, y) => x + y, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0])];
      const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), bt = new Float32Array(N * 3), tn = new Float32Array(N * 3);
      const uv = new Float32Array(N * 2), col = new Float32Array(N * 4), wts = new Float32Array(N * 4);
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 0; i < 17; i++) for (let j = 0; j < 17; j++) {
        const v = i * 17 + j, r = y0 + i, cc = x0 + j;
        const z = h(r, cc);
        zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
        pos.set([ox + cc * 128, oy + r * 128, z], v * 3);
        const dzdx = (h(r, cc + 1) - h(r, cc - 1)) / (cc > 0 && cc < 32 ? 256 : 128);
        const dzdy = (h(r + 1, cc) - h(r - 1, cc)) / (r > 0 && r < 32 ? 256 : 128);
        const nl = Math.hypot(dzdx, dzdy, 1);
        nrm.set([-dzdx / nl, -dzdy / nl, 1 / nl], v * 3);
        const bl = Math.hypot(1, dzdx), tl = Math.hypot(1, dzdy);
        bt.set([1 / bl, 0, dzdx / bl], v * 3);              // normal-map red axis: +X
        tn.set([0, -1 / tl, -dzdy / tl], v * 3);            // green axis: -Y (texture v runs down)
        uv.set([gx * (4096 / TILE) + cc * 128 / TILE, -(gy * (4096 / TILE) + r * 128 / TILE)], v * 2);
        const k = (r * 33 + cc) * 3;
        col.set(C ? [C[k] / 255, C[k + 1] / 255, C[k + 2] / 255, 1] : [1, 1, 1, 1], v * 4);
        let sum = 0;
        for (let t = 0; t < keep.length; t++) sum += keep[t].w[v];
        for (let t = 0; t < 4; t++) wts[v * 4 + t] = t < keep.length ? keep[t].w[v] / (sum || 1) : 0;
      }
      const idx = new Uint32Array(16 * 16 * 6);
      let o = 0;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
        const a = i * 17 + j, b = a + 1, c2 = a + 17, d = c2 + 1;
        idx.set([a, b, d, a, d, c2], o); o += 6;
      }
      const layerSet = (t) => t && t.diffuse ? { d: t.diffuse, n: t.normal, s: t.spec } : DEFAULT_LAYER;
      this.R.addLandQuad({ pos, normal: nrm, bitan: bt, tan: tn, uv, color: col, weights: wts, indices: idx,
        layers: keep.map(k => layerSet(k.tex)),
        center: [ox + (x0 + 8) * 128, oy + (y0 + 8) * 128, (zmin + zmax) / 2], radius: Math.hypot(1024, 1024, (zmax - zmin) / 2) + 16 });
    }
  }
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// Interior light from the cell's XCLL (or its lighting template) and its imagespace. Interiors have no sun shadows
// in the game; the XCLL directional light is a fill light scaled by its fade.
export function interiorEnv(lt, ims) {
  const e = defaultEnv();
  e.name = 'Interior lighting (cell XCLL)';
  e.noShadows = true;
  e.sunDisc = [0, 0, 0]; e.sunGlare = [0, 0, 0];
  if (lt && lt.source) {
    const D = lt.dalc;
    if (D) e.ambRows = ambientRows(D['X-'], D['X+'], D['Y-'], D['Y+'], D['Z-'], D['Z+']);
    const az = (lt.dir_rot_xy || 0) * Math.PI / 180, el = (lt.dir_rot_z || 0) * Math.PI / 180;
    const d = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
    e.sunDir = d[2] < 0.05 ? [d[0] * 0.7, d[1] * 0.7, 0.7] : d;
    e.sunColor = lin(lt.directional || [0, 0, 0]).map(v => v * Math.max(0, lt.dir_fade || 0));
    const fogN = lin(lt.fog_near_color || [0, 0, 0]), fogF = lin(lt.fog_far_color || lt.fog_near_color || [0, 0, 0]);
    e.skyUpper = e.skyLower = e.horizon = fogF;
    if (lt.fog_far > lt.fog_near) {
      e.fog = { near: lt.fog_near, far: lt.fog_far, power: lt.fog_power || 1, max: lt.fog_max ?? 1, high_density_scale: 1 };
      e.fogNear = e.fogNearHigh = fogN; e.fogFar = e.fogFarHigh = fogF;
    }
    e.note = 'Indoor light from the cell itself. Lights the game marks as shadow-casting cast shadows.';
    e.detail = `cell lighting: ${lt.source}${ims ? `\nimagespace: ${ims.edid || ''}` : ''}`;
  } else e.note = 'This cell has no lighting of its own: neutral light.';
  const hdr = ims?.hdr;
  if (hdr) {
    e.bloomThreshold = hdr['Bloom Threshold'] ?? e.bloomThreshold; e.bloomScale = hdr['Bloom Scale'] ?? e.bloomScale;
    e.tonemapE = hdr['Tonemap E'] ?? e.tonemapE; e.middleGray = hdr['Middle Gray'] ?? e.middleGray;
    e.aeMin = hdr['Auto Exposure Min'] ?? e.aeMin; e.aeMax = hdr['Auto Exposure Max'] ?? e.aeMax;
    e.eyeAdaptSpeed = hdr['Eye Adapt Speed'] ?? e.eyeAdaptSpeed;
    e.skyScale = hdr['Sky Scale'] ?? 1;
    e.sunColor = e.sunColor.map(v => v * (hdr['Sunlight Scale'] ?? 1));
  }
  const cin = ims?.cinematic;
  if (cin) e.cinematic = [cin.Saturation ?? 1, cin.Brightness ?? 1, cin.Contrast ?? 1];
  if (ims?.tint) e.tint = [...lin(ims.tint.Color), ims.tint.Amount];
  e.luts = ims?.lut ? [{ path: ims.lut, weight: 1 }] : [];
  return e;
}
