// Location shortcuts: six places from the load order, each opened with the character at a chosen spot, a camera that
// frames it and a weather / hour that lights it well. Picked from twenty measured places (draw calls and frame time
// at 3x3, a clean floor at the spot, something worth seeing behind; docs/DEVELOPMENT.md "Default scene").
// The button pictures are rendered once from the user's own install by a small background renderer (with the Vault
// suit character in place) and kept in the browser, like the reference previews. Nothing is shipped with the tool.
import { Renderer } from './renderer.js';
import { CellLoader } from './world.js';

// view: heading (radians) faces the character where there is no cell; stand [x, y] replaces the spawn spot; landmark
// [x, y, z] puts the camera on the far side of the character so
// the landmark stands behind it (the character turns toward the camera); side turns the camera around the character
// (radians, from the spawn's facing or from the landmark line); dist / pitch / tz frame it.
// The grid shows them in rows of four: the first column holds the viewer's own scenes (Studio, the start-up scene:
// no cell, the studio floor; Simple: a small scene of Fallout4.esm objects, scenes/LightboxSimple.esp).
// cell null = no cell; floor = the cell stands on the studio floor
export const PLACES = [
  { key: 'studio', label: 'Studio', cell: null, weather: 'CommonwealthClear', hour: 10,      // facing the 10:00 sun
    view: { heading: -2.618, side: -0.61, dist: 330, pitch: 0.08, tz: 88 } },
  { key: 'sanctuary', label: 'Sanctuary', cell: 'SanctuaryExt', weather: 'CommonwealthClear', hour: 10,
    view: { side: -0.7, dist: 300 } },
  { key: 'prewar', label: 'Sanctuary 2077', cell: 'PrewarSanctuaryExt01', weather: 'CommonwealthClear', hour: 15.5,
    view: { side: 0.7, dist: 230 } },
  { key: 'redrocket', label: 'Red Rocket', cell: 'RedRocketExt', weather: 'CommonwealthClear', hour: 10,
    view: { stand: [-69330, 80980], landmark: [-69350, 80250, 7600], side: -0.35, dist: 330, pitch: 0.06, tz: 105 } },
  { key: 'simple', label: 'Simple', cell: 'LightboxSimple', weather: 'CommonwealthClear', hour: 8.5, floor: true,
    view: { side: -0.17, dist: 410, pitch: 0.08, tz: 92 } },
  { key: 'starlight', label: 'Starlight', cell: 'StarlightDriveInExt', weather: 'CommonwealthClear', hour: 15.5,
    view: { landmark: [-37813, 60266, 4936], side: 0.3, dist: 330, pitch: 0.05, tz: 110 } },
  { key: 'tenpines', label: 'Tenpines Bluff', cell: 'TenPinesBluff', weather: 'CommonwealthClear', hour: 10,
    view: { side: -0.7, dist: 300 } },
  { key: 'oberland', label: 'Oberland', cell: 'OberlandStation', weather: 'CommonwealthClear', hour: 10,
    view: { side: 0.7, dist: 300 } },
];

const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];

// where the character faces and where the camera sits, for a character standing at pos
export function placeView(view, pos, spawnHeading = 0) {
  let base;
  if (view.landmark) {
    const dx = pos[0] - view.landmark[0], dy = pos[1] - view.landmark[1], l = Math.hypot(dx, dy) || 1;
    base = [dx / l, dy / l];
  } else base = [-Math.sin(spawnHeading), Math.cos(spawnHeading)];
  const camDir = rot(base, view.side || 0);
  const face = view.landmark ? rot(camDir, view.turn ?? -0.45) : base;
  return {
    heading: Math.atan2(-face[0], face[1]),
    camera: { target: [pos[0], pos[1], pos[2] + (view.tz ?? 80)], pan: [0, 0, 0], yaw: Math.atan2(camDir[1], camDir[0]),
      pitch: view.pitch ?? 0.08, dist: view.dist ?? 300 },
  };
}

// a place's cell, found once per page (the load order is fixed for a page: a plugin change reloads it, File > Reload
// game files clears this); saves a serial search request on every place click
const CELL_FOUND = new Map();
export function clearFoundCells() { CELL_FOUND.clear(); }
export async function findCell(api, edid, tries = 20) {
  const key = edid.toLowerCase();
  if (CELL_FOUND.has(key)) return CELL_FOUND.get(key);
  for (let k = 0; k < tries; k++) {                       // the load-order index builds in the background
    const j = await api('cells?q=' + encodeURIComponent(edid)).catch(() => ({ cells: [] }));
    const c = (j.cells || []).find(x => (x.edid || '').toLowerCase() === key);
    if (c) { CELL_FOUND.set(key, c); return c; }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

const STORE = 'lightbox.placethumbs.v3';
const TW = 288, TH = 176;

// opts: api, gameDir, envFor(place) -> lighting env, skyRings, clipPath (relaxed idle), tone (skin), onThumb(key, url),
// onDone() when no more pictures will come (also after a failure: the buttons stop waiting for theirs), idle()
// awaited before each place
export async function renderPlaceThumbs(opts) {
  try { await placeThumbs(opts); } finally { opts.onDone?.(); }
}
async function placeThumbs(opts) {
  let cache;
  try { cache = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { cache = {}; }
  if (cache.dir !== opts.gameDir) cache = { dir: opts.gameDir };
  for (const p of PLACES) if (cache[p.key]) opts.onThumb(p.key, cache[p.key]);
  const todo = PLACES.filter(p => !cache[p.key]);
  if (!todo.length) return;
  const cv = document.createElement('canvas');
  let T;
  try { T = new Renderer(cv); } catch (e) { console.warn('place previews:', e.message); return; }
  T.settings.taa = false;          // one renderer draws place after place (no history may carry over), as thumbs.js
  const { api } = opts;
  try {
    T.fixedSize = [TW, TH];
    T.skyRings = opts.skyRings;
    // the character: the male body in the Vault suit with the default look, in the relaxed idle
    T.setSkeleton((await api('skeleton?vanilla=1')).nodes);
    for (const part of (await api('reference?id=vault_m&vanilla=1')).parts) T.addModel(part, { role: 'ref' });
    if (opts.tone) { T.settings.skinTint = opts.tone.rgb; T.settings.skinTintAmount = opts.tone.amount; }
    if (opts.clipPath) { T.setClip(await api(`anim?path=${encodeURIComponent(opts.clipPath)}`)); T.time = T.clip.start + 0.5; T.playing = false; }
    const loader = new CellLoader(T, api);
    for (const p of todo) {
      if (opts.idle) await opts.idle();                 // not while the view itself loads (the same server and GPU)
      T.env = await opts.envFor(p);
      if (!p.cell) {                                      // the studio: the character on the floor, no cell
        loader.unload();
        T.settings.ground = true;
        const v = placeView(p.view, [0, 0, 0], p.view.heading ?? 0);
        T.setPlayer([0, 0, 0], v.heading);
        Object.assign(T.camera, v.camera);
        for (let i = 0; i < 3; i++) { T.frame(0); await Promise.all([...T.texCache.values()]); await new Promise(r => setTimeout(r, 60)); }
        for (let i = 0; i < 3; i++) { T.snapAdapt = true; T.frame(0); }
        const url = cv.toDataURL('image/webp', 0.86);
        cache[p.key] = url;
        opts.onThumb(p.key, url);
        try { localStorage.setItem(STORE, JSON.stringify(cache)); } catch { /* storage full: render again next time */ }
        continue;
      }
      const c = await findCell(api, p.cell, 4);
      if (!c) continue;
      await loader.open(c.formid, 1);
      await loader.lodDone;                                // the picture shows the distant land too
      T.cellFloor = !!p.floor;
      let pos = loader.spawn?.pos || loader.focus;
      if (p.view.stand) pos = [p.view.stand[0], p.view.stand[1], pos[2]];
      const g = T.groundAt(pos[0], pos[1], pos[2] + (p.view.stand ? 300 : 60));
      if (g != null) pos = [pos[0], pos[1], g];
      const v = placeView(p.view, pos, loader.spawn?.heading ?? 0);
      T.setPlayer(pos, v.heading);
      Object.assign(T.camera, v.camera);
      for (let i = 0; i < 3; i++) {                        // textures arrive in waves (models first, then LUTs)
        T.frame(0);
        await Promise.all([...T.texCache.values()]);
        await new Promise(r => setTimeout(r, 60));
      }
      for (let i = 0; i < 3; i++) { T.snapAdapt = true; T.frame(0); }
      const url = cv.toDataURL('image/webp', 0.86);
      cache[p.key] = url;
      opts.onThumb(p.key, url);
      try { localStorage.setItem(STORE, JSON.stringify(cache)); } catch { /* storage full: render again next time */ }
      loader.unload();
      dropTextures(T);                                     // one place's textures at a time on the GPU
    }
  } catch (e) {
    console.warn('place previews:', e);
  } finally {
    T.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function dropTextures(T) {
  for (const [key, p] of [...T.texCache]) {
    if (key.includes('\\luts\\')) continue;     // LUTs stay (cached apart)
    if (T.models.some(m => m.shapes.some(s => Object.values(s.tex).some(t => t && t.info && key.startsWith(t.info.path.toLowerCase()))))) continue;
    T.texCache.delete(key);
    p.then(t => { if (t && t.tex) T.gl.deleteTexture(t.tex); });
  }
}
