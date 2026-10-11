// FO4 Lightbox front end: UI wiring, camera controls, weather -> lighting environment.
import { Renderer, defaultEnv, setDataGeneration } from './renderer.js';
import { vec3 } from './math.js';
import { envFromWeather, AMBIENT } from './weather.js';
import { CAT_ICONS, UI_ICONS, POSE_ICONS, ANIM_ICONS } from './icons.js';
import { pathInfo } from './pathtags.js';
import { animInfo } from './animtags.js';
import { WeatherSlider, IconSlider, weatherIcon, hourTicks } from './widgets.js';
import { renderThumbs } from './thumbs.js';
import { CellLoader, clearCellMemo } from './world.js';
import { TIERS, TIER_LABEL, STEP_DOWN_MS, classify, gpuName } from './quality.js';
import { PLACES, placeView, findCell, clearFoundCells, renderPlaceThumbs } from './places.js';
import { GameMode, SPEED } from './game.js';
import { Gizmo } from './gizmo.js';
import { mat4 } from './math.js';

const $ = (id) => document.getElementById(id);
// the server's game-data generation (archives packed again, plugins saved): responses the browser may keep (clips,
// the skeleton, archived textures) are only reused within one generation
let dataGen = '0';
const api = async (path, opts) => {
  const r = await fetch('/api/' + path + (opts ? '' : `${path.includes('?') ? '&' : '?'}g=${dataGen}`), opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
// answers asked for ahead (restoreScene: the body, the saved models and the clip while the cell loads): the next
// apiOnce of the same path takes it, as if it had asked itself
const ahead = new Map();
function askAhead(path) { if (!ahead.has(path)) { const q = api(path); q.catch(() => {}); ahead.set(path, q); } }
function apiOnce(path) { const q = ahead.get(path); if (q) { ahead.delete(path); return q; } return api(path); }
const logEl = $('log');
function log(msg, warn = false) {
  const d = document.createElement('div');
  if (warn) d.className = 'w';
  d.textContent = msg;
  logEl.prepend(d);
}
function toast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', ms);
}

let R;
try {
  R = new Renderer($('view'));
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font:16px system-ui;color:#eee">FO4 Lightbox needs WebGL2 with float render targets.<br><br>${e.message}</div>`;
  throw e;
}
R.onWarn = (m) => log(m, true);
window.lightbox = R;     // handy for debugging from the console
window.lightboxAmbient = AMBIENT;
window.lightboxApplyEnv = () => applyEnv();
window.lightboxLoad = (path, role = 'main', vanilla = false) => loadNif(path, role, vanilla);
// performance check: draws `frames` frames as they come (opts.size: render size, opts.orbit: radians of yaw per frame)
// and returns CPU ms per frame and GPU / CPU ms per pass (R.profile). The screen keeps its normal redraw afterwards.
window.lightboxBench = async (opts = {}) => {
  const N = opts.frames || 90, nf = R.needsFrame, cam = { ...R.camera }, fixed = R.fixedSize, yaw0 = R.camera.yaw;
  R.needsFrame = () => false;
  if (opts.size) R.fixedSize = opts.size;
  R.profile(true);
  const cpu = [];
  let prof;
  try {
    for (let i = 0; i < N; i++) {
      if (opts.orbit) R.camera.yaw = yaw0 + opts.orbit * i;
      if (opts.each) opts.each(i);
      const t0 = performance.now(); R.pollLum(); R.frame(1 / 60); cpu.push(performance.now() - t0);   // as needsFrame + frame
      await new Promise(r => requestAnimationFrame(r));
    }
  } finally {
    prof = R.profile(false);
    Object.assign(R.camera, cam); R.fixedSize = fixed; R.needsFrame = nf;
  }
  cpu.sort((a, b) => a - b);
  let gpu = 0;
  for (const k in prof) gpu += prof[k].gpu || 0;
  return { cpu: +cpu[N >> 1].toFixed(2), cpu90: +cpu[Math.floor(N * 0.9)].toFixed(2), gpu: +gpu.toFixed(2), passes: prof,
    draws: R.stats_draws, size: [R.canvas.width, R.canvas.height] };
};
// calibration: render at an exact size (16:9 like the game's shots) and save it through the server (--save-dir only)
window.lightboxCapture = async (name, w = 3840, h = 2160) => {
  const cv = R.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const old = [cv.style.width, cv.style.height, R.renderScale];
  cv.style.width = `${w / 2}px`; cv.style.height = `${h / 2}px`; R.renderScale = 2 / dpr; R.capture = true;
  for (let i = 0; i < (R.settings.taa ? 21 : 3); i++) R.frame(0);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  cv.style.width = old[0]; cv.style.height = old[1]; R.renderScale = old[2]; R.capture = false;
  const r = await fetch('/api/devsave?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
  return r.json();
};

// ------------------------------------------------------------------------------------------------ status / setup
const state = { weather: null, presets: [], sample: null, hour: 12, refModels: [], refSex: '', refOutfit: '', weatherIndex: 0 };

async function init() {
  const saved = readSettings();
  applySettings(saved, { environment: false, reference: false });
  const st = await api('status');
  dataGen = String(st.data_gen ?? 0); setDataGeneration(dataGen);
  state.gameDir = st.game_dir;
  for (const k of ['radius', 'bias', 'intensity']) if (Number.isFinite(st.sao?.[k])) R.aoParams[k] = st.sao[k];   // your INI's SAO
  for (const k of ['resolution', 'filter', 'halve_every', 'distance'])          // and its light shadows
    if (Number.isFinite(st.light_shadows?.[k])) R.lsParams[k] = st.light_shadows[k];
  state.dataVersion = String(st.data);           // the game data this page was loaded with
  showBodyMods(st.body_mods || {});
  if (saved?.reference && 'bodyMod' in saved.reference) { $('bodyMod').checked = !!saved.reference.bodyMod; showBodyModChips(); }
  const src = st.source || { kind: 'game' };
  state.sourceId = src.id;
  state.sourceLabel = src.kind === 'mo2' ? `Mod Organizer 2 profile "${src.profile}"` : 'the game folder';
  const where = src.kind === 'mo2' ? `MO2 · ${src.profile} (${src.mods} mod${src.mods === 1 ? '' : 's'})` : st.game_dir;
  $('status').textContent = `${where} · ${st.archives.length} archives · ${st.files.toLocaleString()} files`;
  $('status').title = (src.kind === 'mo2' ? `Mod Organizer 2: ${src.detail}\nprofile ${src.profile}, ${src.mods} mods enabled\n` +
    `game: ${st.game_dir}\n` : `${st.game_dir}\n`) + 'Mods menu: where the game files come from';
  if (st.source_auto && src.kind === 'mo2') {              // picked for the user: say so, once per profile
    let seen = '';
    try { seen = localStorage.getItem('lightbox.sourceSeen') || ''; localStorage.setItem('lightbox.sourceSeen', src.id); } catch (e) { /* storage blocked */ }
    if (seen !== src.id) setTimeout(() => toast(`Reading your Mod Organizer 2 profile "${src.profile}" (${src.mods} mods). The Mods menu switches to the game folder.`, 9000), 1500);
  }
  state.version = st.version;
  if (st.unused_archives.length) log(`${st.unused_archives.length} archives in Data are not loaded by the game (no active plugin) and are ignored.`);
  R.setGroundTextures('textures\\landscape\\ground\\commonwealthdefault01_d.dds', 'textures\\landscape\\ground\\commonwealthdefault01_n.dds',
    'textures\\landscape\\ground\\commonwealthdefault01_s.dds');
  api('sky').then(s => { R.skyRings = s.rings; if (s.error) log('sky dome: ' + s.error, true); })
    .catch(e => log('sky dome: ' + e.message, true));
  await Promise.all([loadPresets(), loadSkinTones(), clipsReady]);      // independent requests, side by side
  const clip = (id) => state.clips?.find(c => c.id === id && c.available)?.path;
  if (captureSpec) {
    const b = atob(captureSpec.replace(/-/g, '+').replace(/_/g, '/'));
    const spec = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, ch => ch.charCodeAt(0))));
    if (spec.pose !== 'bind' && spec.ref && spec.ref !== 'none') {      // relaxed idle unless the bind pose is asked for
      const id = spec.pose && spec.pose !== 'auto' ? spec.pose : (spec.ref === 'f' ? 'idle_f' : 'idle_m');
      await playClip(clip(id), false, id);
      R.playing = false;
    }
    await runCapture(spec);
    return;
  }
  const tone = state.skinTones || {};
  // the reference buttons' pictures: the ones kept in the browser at once, missing ones rendered once the scene is up
  // (the bust of the Vault suit right after the full male figure: the same body, loaded once)
  let sceneUp;
  const sceneReady = new Promise(r => { sceneUp = r; });
  renderThumbs(api, st.game_dir, [{ key: 'm', ref: 'vault_m', clip: clip('idle_m'), tone: tone.m },     // bodies shown
    { key: 'vault', ref: 'vault_m', clip: clip('idle_m'), tone: tone.m, bust: true },                    // in the Vault suit
    { key: 'f', ref: 'vault_f', clip: clip('idle_f'), tone: tone.f },
    { key: 'leathers', ref: 'leathers_m', clip: clip('idle_m'), tone: tone.m, bust: true },
    { key: 'radstag', ref: 'radstag_m', clip: clip('idle_m'), tone: tone.m, bust: true }], setRefThumb,
  { after: sceneReady, idle: viewIdle }).catch(e => console.warn(e));
  let snap = null;
  try {
    snap = JSON.parse(sessionStorage.getItem(SNAPSHOT) || 'null'); sessionStorage.removeItem(SNAPSHOT);
    if (snap) snap.reason = sessionStorage.getItem('lightbox.reloadReason') || 'code';
    sessionStorage.removeItem('lightbox.reloadReason');
  } catch (e) { /* none */ }
  if (snap) await restoreSnapshot(snap).catch(e => log('restoring the scene: ' + e.message, true));
  if (state.poseId === undefined) playPose('idle', true);    // bodies start in the relaxed idle (the slider stays)
  if (!snap) {
    await loadShowcase(saved?.reference).catch(e => log('default scene: ' + e.message, true));
    if (saved) { applyEnvironment(saved.environment || {}); if (saved.animation?.pose !== undefined) playPose(saved.animation.pose, true); }
  }
  R.prewarmPrograms();                         // the click-selection programs compile in the background
  sceneUp();
  startAutosave();
  // the location buttons' pictures: rendered once, in the background, after the scene is up
  renderPlaceThumbs({ api, gameDir: st.game_dir, envFor: envForPlace, skyRings: R.skyRings, clipPath: clip('idle_m'),
    tone: state.skinTones?.m, onThumb: setPlaceThumb, idle: viewIdle,
    onDone: () => { for (const b of Object.values(PLACE_BTN)) b.classList.remove('busy'); } }).catch(e => console.warn(e));
}
// The background preview renderers wait while the view itself loads (a cell or its distant land streaming, textures
// arriving): they share the server's connections and the GPU with it
async function viewIdle() {
  for (let i = 0; i < 240; i++) {               // (a minute at most)
    await cells.lodDone;
    if (!R.texturesLoading()) return;
    await new Promise(r => setTimeout(r, 250));
  }
}

// The default scene: the male body in the Vault 111 suit with the Player record's hair, in the relaxed idle, at the
// first location (Sanctuary after the war, Clear at 10:00, three-quarter front; places.js).
async function loadShowcase(ref) {
  state.starting = true;
  try {
    await setRef(ref?.sex ?? 'm', ref ? ref.outfit : 'vault');
    await openPlace(PLACES[0]);
  } finally { state.starting = false; }
}

// ------------------------------------------------------------------------------------------------ locations
// Six shortcut buttons (places.js): each loads its place, puts the character at its spot facing the camera that frames
// it, and sets the weather and hour that light it well.
const PLACE_BTN = {};
for (const pl of PLACES) {
  const b = document.createElement('button');
  b.className = 'placebtn busy';
  b.title = `${pl.label}: ${pl.cell ? `${pl.cell}${pl.floor ? '' : ' (3x3)'}` : 'no cell, the studio floor'}, ` +
    `${pl.weather.replace('Commonwealth', '')} at ${hourText(pl.hour)}`;
  b.innerHTML = `<span class="pic">${CAT_ICONS.landscape}</span><span class="lbl">${pl.label}</span>`;
  b.onclick = () => { b.blur(); if (state.backdrop) setBackdrop(''); openPlace(pl); };
  $('places').append(b);
  PLACE_BTN[pl.key] = b;
}
function setPlaceThumb(key, url) {
  const b = PLACE_BTN[key];
  if (!b) return;
  b.querySelector('.pic').innerHTML = `<img alt="" draggable="false" src="${url}">`;
  b.classList.remove('busy');
}
function markPlace(key) {
  state.placeKey = key;
  for (const [k, b] of Object.entries(PLACE_BTN)) b.classList.toggle('on', k === key && !state.backdrop);
  updateTitle();
}
async function envForPlace(pl) {
  const p = state.presets.find(x => x.edid === pl.weather) || state.presets[0];
  if (!p) return R.env;
  return envFromWeather(await weatherSample(p, pl.hour), pl.hour, 0);
}
async function openPlace(pl) {
  markPlace(pl.key);
  const i = state.presets.findIndex(p => p.edid === pl.weather);
  setWeatherHour(i >= 0 ? i : null, pl.hour);
  if (!state.refSex) await setRef('m', 'vault');            // someone to show the place with
  if (!pl.cell) {                                           // the studio: no cell, the character on the studio floor
    if (game.on) toggleGame();
    if (cells.info) { cells.unload(); cellStats = null; renderCellLayer(); hideLoadBar(); }
    R.settings.ground = true;
    showEnvToggles();
    const v = placeView(pl.view, [0, 0, 0], pl.view.heading ?? 0);
    R.setPlayer([0, 0, 0], v.heading);
    Object.assign(R.camera, v.camera);
    applyEnv();
    return;
  }
  const c = await findCell(api, pl.cell);
  if (!c) { log(`${pl.label}: cell ${pl.cell} is not in the load order`, true); frameCamera('three'); return; }
  await openCell(c, pl.key);
  if (state.placeKey !== pl.key) return;                    // another place or cell was picked meanwhile
  let pos = [...R.playerPos];
  if (pl.view.stand) { game.place(pl.view.stand[0], pl.view.stand[1], pos[2] + 100, R.playerHeading, 200); pos = [...R.playerPos]; }
  const v = placeView(pl.view, pos, cells.spawn?.heading ?? R.playerHeading);
  R.setPlayer(pos, v.heading);
  Object.assign(R.camera, v.camera);
}

// ------------------------------------------------------------------------------------------------ live update
// index.html reloads the page when the server restarts or a page file changes; the scene is saved first and put back
// here: body and outfit, models loaded from the game files (with plugin material swaps), the cell, weather, hour,
// sun direction, pose and camera. Imported files cannot come back (the browser would have to read them again).
const SNAPSHOT = 'lightbox.snapshot';
window.lightboxSnapshot = () => {
  if (state.restoring) return state.restoring;   // reloaded again while putting a scene back: keep the whole one
  if (state.starting) return null;               // the start-up scene is still loading: start it again
  const c = R.camera;
  return {
    ref: { sex: state.refSex, outfit: state.refOutfit },
    weather: state.weatherIndex, hour: state.hour, sunAz: +$('sunAz').value,
    pose: state.poseId, clip: state.poseId === 'clip' ? state.clipPath : null,
    models: R.models.filter(m => m.loadArgs && !m.refBody).map(m => ({ ...m.loadArgs, source: m.source, visible: m.visible, xf: m.xf || null })),
    imported: R.models.filter(m => m.source === 'imported' || m.source === 'file').length,
    cell: cells.info ? { formid: cells.info.formid, radius: cellRadius } : null, place: state.placeKey ?? null,
    camera: { target: c.target, pan: c.pan, yaw: c.yaw, pitch: c.pitch, dist: c.dist },
    player: { pos: R.playerPos, heading: R.playerHeading },
  };
};
async function restoreSnapshot(s) {
  state.restoring = s;
  try { await restoreScene(s); } finally { state.restoring = null; ahead.clear(); }     // (anything asked for ahead and not used)
}
async function restoreScene(s) {
  const what = s.reason === 'data' ? 'Game files changed on disk' : s.reason === 'gpu' ? 'The graphics driver reset'
    : s.reason === 'source' ? `Now reading ${state.sourceLabel || 'other game files'}` : 'Lightbox updated';
  toast(`${what}: putting the scene back…`, 60000);
  setWeatherHour(s.weather != null && s.weather < state.presets.length ? s.weather : null, s.hour != null ? s.hour : undefined);
  if (s.sunAz != null) { $('sunAz').value = s.sunAz; $('sunAzV').textContent = s.sunAz + '°'; }
  // the body, the saved models and the clip are asked for now, side by side and while the cell loads; they are put in
  // below, after it and in the same order as ever
  if (s.ref?.sex) { const o = s.ref.outfit === true ? 'vault' : s.ref.outfit; askAhead(refPath(s.ref.sex, `${o || 'body'}_${s.ref.sex}`)); }
  for (const d of s.models || []) askAhead(nifPath(d.path, d.vanilla, d.swaps || []));
  if (s.pose === 'clip' && s.clip) askAhead(clipPath(s.clip, /forward|walk|run|jog|sprint/i.test(s.clip)));
  if (s.cell) {
    cellRadius = s.cell.radius ?? cellRadius;
    document.querySelectorAll('#cellRadius button[data-r]').forEach(b => b.classList.toggle('on', +b.dataset.r === cellRadius));
    await openCell({ formid: s.cell.formid }, s.place ?? null);        // (the place's button lit again)
  } else if (s.place) markPlace(s.place);
  if (s.ref?.sex) await setRef(s.ref.sex, s.ref.outfit);
  for (const d of s.models || []) {
    const m = await loadNif(d.path, d.role, d.vanilla, d.swaps || []);
    if (!m) continue;
    if (d.source === 'plugin item') { m.source = 'plugin item'; state.itemModels.push(m); }
    m.visible = d.visible !== false;
    if (d.xf) R.setModelXform(m, d.xf);
  }
  refreshModels();
  if (s.pose === 'clip' && s.clip) {
    const info = animInfo(s.clip);
    state.poseId = 'clip'; state.clipPath = s.clip;
    poseSlider.set(-1, false); $('poseV').textContent = info.name;
    await playClip(s.clip, /forward|walk|run|jog|sprint/i.test(s.clip), info.name, true);
  } else if (s.pose !== undefined) await playPose(s.pose, true);
  if (s.cell && s.player) R.setPlayer(s.player.pos, s.player.heading);
  if (s.camera) Object.assign(R.camera, s.camera);
  applyEnv();
  toast(`${what}: scene ${s.reason === 'code' ? 'restored' : 'read again'}${s.imported ? ` (${s.imported} imported file${s.imported > 1 ? 's' : ''} must be dropped in again)` : ''}`, 3500);
}

// weather slider: the built-in studio light first, then the game's weathers (state.weatherIndex -1 = studio)
const weatherSlider = new WeatherSlider($('weatherSlider'), (i) => selectWeather(i - 1));
function weatherItems() {
  return [{ label: 'Studio', icon: 'studio', title: 'Neutral studio light (built in, not from the game)' },
    ...state.presets.map(p => ({ label: p.label || p.edid, icon: weatherIcon(p.edid), title: `${p.label || p.edid}: ${p.note || p.edid}` }))];
}
function selectWeather(i) {
  state.weatherIndex = i;
  weatherSlider.set(i + 1, false);
  $('weatherV').textContent = i < 0 ? 'Studio' : (state.presets[i]?.label || state.presets[i]?.edid || '');
  return updateWeather();
}
// a weather (index, or null: keep it) and an hour (or undefined: keep it) set together: one sample request for the
// pair (picking the weather first would ask for the previous hour's sample, the hour's timer then for the new one)
function setWeatherHour(i, h) {
  if (h !== undefined) setHour(h, false, true);
  if (i != null) selectWeather(i);
  else if (h !== undefined) updateWeather();
}
async function loadPresets(retry = 0) {
  let j;
  try { j = await api('weather/presets'); } catch (e) { j = { presets: [], error: e.message }; }
  if (!j.presets.length) {
    state.presets = [];
    weatherSlider.setItems(weatherItems(), 0);
    if (retry < 20 && !j.error?.includes('Error')) return setTimeout(() => loadPresets(retry + 1), 1500);
    $('weatherNote').textContent = j.error ? `Weather records unavailable: ${j.error}` : '';
    selectWeather(-1);
    return;
  }
  state.presets = j.presets;
  weatherSlider.setItems(weatherItems(), 1);
  selectWeather(0);
}

// Samples answer in any order (a slider drag or the running clock asks every 0.1 s): only the newest request is
// applied, and a superseded call resolves when the newest one has been (setLighting awaits the weather it set)
let weatherSeq = 0, weatherLatest = null;
function updateWeather() {
  const k = ++weatherSeq;
  const run = (async () => {
    const i = state.weatherIndex;
    if (i < 0 || !state.presets[i]) { state.sample = null; applyEnv(); return; }
    try {
      const s = await weatherSample(state.presets[i], state.hour);
      if (k !== weatherSeq) return weatherLatest;
      state.sample = s;
      applyEnv();
    } catch (e) { if (k === weatherSeq) log('weather: ' + e.message, true); else return weatherLatest; }
  })();
  weatherLatest = run;
  return run;
}
// One weather at one hour, as the server samples it (the same answer within a data generation): kept for the last 64
// asked, so a place, a restore or a revisited hour does not ask again. Nothing changes a sample (envFromWeather reads it)
const sampleMemo = new Map();
function weatherSample(p, hour) {
  const path = `weather/sample?id=${encodeURIComponent(p.formid || p.edid)}&hour=${hour}` +
    (p.climate ? `&climate=${encodeURIComponent(p.climate.formid || p.climate.edid || p.climate)}` : '');
  const key = dataGen + '|' + path;
  let q = sampleMemo.get(key);
  if (q) { sampleMemo.delete(key); sampleMemo.set(key, q); return q; }        // most recently used last
  q = api(path);
  q.catch(() => { if (sampleMemo.get(key) === q) sampleMemo.delete(key); });
  sampleMemo.set(key, q);
  if (sampleMemo.size > 64) sampleMemo.delete(sampleMemo.keys().next().value);
  return q;
}

function applyEnv() {
  const az = +$('sunAz').value * Math.PI / 180;
  R.env = cells?.interiorEnv ? { ...cells.interiorEnv } : state.sample ? envFromWeather(state.sample, state.hour, az) : studioEnv(az);
  if (R.sunOverride) R.env.sunDir = R.sunOverride;     // calibration: a sun direction measured from game shots
  const p = state.presets[state.weatherIndex];
  $('weatherNote').textContent = !cells?.interiorEnv && state.sample && p
    ? `${p.label || p.edid} weather, ${R.env.light || 'game light'}.` : (R.env.note || '');
  $('weatherNote').title = R.env.detail || '';
}

function studioEnv(az) {
  const e = defaultEnv();
  const d = e.sunDir, c = Math.cos(az), s = Math.sin(az);
  e.sunDir = [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  e.note = 'Built-in neutral light, not from the game.';
  return e;
}

// ------------------------------------------------------------------------------------------------ models
// swaps: material-swap (MSWP) FormIDs from a plugin record, applied to the NIF's materials
const nifPath = (path, vanilla = false, swaps = []) =>
  `nif?path=${encodeURIComponent(path)}${vanilla ? '&vanilla=1' : ''}${swaps.length ? '&swap=' + swaps.join(',') : ''}`;
async function loadNif(path, role = 'main', vanilla = false, swaps = []) {
  toast('Loading ' + path.split('\\').pop() + '…', 60000);
  try {
    const sc = await apiOnce(nifPath(path, vanilla, swaps));
    if (sc.attach_bone) await ensureSkeleton();
    const m = addScene(sc, role);
    m.loadArgs = { path, role, vanilla, swaps };      // enough to load it again after a live update
    toast('Loaded ' + path.split('\\').pop());
    return m;
  } catch (e) { log(`${path}: ${e.message}`, true); toast('Failed: ' + e.message, 5000); return null; }
}

function addScene(sc, role, refBody = false) {
  const m = R.addModel(sc, { role });
  m.source = sc.source;
  m.mod = sc.mod || '';                     // Mod Organizer 2: the mod a loose mesh comes from
  m.refBody = refBody;
  for (const l of sc.log || []) log(`${sc.name.split('\\').pop()}: ${l}`, true);
  if (sc.attach_bone) {
    const short = sc.name.split('\\').pop();
    if (R.skelRest?.has(sc.attach_bone.toLowerCase())) log(`${short}: hangs on the ${sc.attach_bone} bone (Prn), as in the game`);
    else log(`${short}: its Prn bone ${sc.attach_bone} is not in the skeleton; shown where the file puts it`, true);
  }
  if (role === 'ref') state.refModels.push(m);
  refreshModels();
  if (role === 'main' && R.models.filter(x => x.role === 'main').length === 1) frameCamera('three');
  return m;
}

// show / hide a scene row, like a layer's eye
function eyeToggle(row, get, set) {
  const b = document.createElement('button'); b.className = 'eye';
  const show = () => {
    const on = get();
    b.innerHTML = on ? UI_ICONS.eye : UI_ICONS.eyeClosed;
    b.title = on ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', on);
    b.classList.toggle('off', !on); row.classList.toggle('off', !on);
  };
  b.onclick = () => { set(!get()); show(); refreshShapes(); };
  show();
  return b;
}

// The window's title (the title bar, the taskbar preview, Alt+Tab) says what is open: "VaultTecM.nif · Sanctuary",
// a plugin record by its in-game name. The menu bar's logo already says FO4 Lightbox, so the name only stands in the
// title when nothing is open
function updateTitle() {
  const what = [...new Set(R.models.filter(m => !m.refBody).map(m => m.source === 'plugin item' && state.item
    ? state.item.name || state.item.edid : m.name.split('\\').pop()))];
  const pl = PLACES.find(p => p.key === state.placeKey), c = cells.info;
  const where = c ? pl?.label || c.name || c.edid || c.formid : what.length && pl && pl.key !== 'studio' ? pl.label : '';
  document.title = [what.length ? what[0] + (what.length > 1 ? ` +${what.length - 1}` : '') : '', where]
    .filter(Boolean).join(' · ') || 'FO4 Lightbox';
}
// a moved / turned / scaled model (the transform gizmo) gets a button that puts it back where its file has it
function resetXform(list) {
  if (!list.some(m => m.xf)) return [];
  const b = document.createElement('button'); b.className = 'x rs'; b.textContent = '\u21ba';
  b.title = 'Undo the move, turn and scale (the gizmo): back where the file puts it';
  b.onclick = () => { for (const m of list) R.setModelXform(m, null); refreshModels(); };
  return [b];
}
// a model's shapes as small rows under its own (the Scene list's ▸): an eye each, a click on the name selects that shape
const expanded = new WeakSet();
function setShapeVisible(s, v) { s.visible = v; R.geomVersion++; R.version++; }
function shapeRows(el, m) {
  for (const s of m.shapes) {
    const d = document.createElement('div');
    d.className = 'm sh' + (R.selection?.kind === 'shape' && R.selection.shape === s ? ' sel' : '');
    const cb = eyeToggle(d, () => s.visible, (v) => setShapeVisible(s, v));
    const n = document.createElement('span'); n.className = 'n'; n.textContent = s.name || '(unnamed shape)';
    n.title = `${s.name} · ${s.ntris} tris · ${s.mat.material_path || '(NIF shader)'}\nclick: select this shape (Alt+click in the view does the same)`;
    n.onclick = () => { R.setSelection({ kind: 'shape', model: m, shape: s }); refreshModels(); };
    const t = document.createElement('span'); t.className = 'tris'; t.textContent = s.ntris;
    d.append(cb, n, t); el.append(d);
  }
}
function shapeTwisty(m) {
  const b = document.createElement('button'); b.className = 'tw';
  b.textContent = expanded.has(m) ? '▾' : '▸';
  b.title = expanded.has(m) ? 'Hide its shapes' : `Show its ${m.shapes.length} shapes`;
  b.onclick = () => { if (expanded.has(m)) expanded.delete(m); else expanded.add(m); refreshModels(); };
  return b;
}
function refreshModels() {
  updateTitle();
  showClothUI();
  showCompare();
  const el = $('models');
  el.innerHTML = '';
  // the reference body (suit or body + hands, head, head rear, eyes) is one row
  const body = R.models.filter(m => m.refBody);
  if (body.length) {
    const d = document.createElement('div'); d.className = 'm';
    const cb = eyeToggle(d, () => body.some(m => m.visible), (v) => { for (const m of body) m.visible = v; });
    const n = document.createElement('span'); n.className = 'n'; n.textContent = state.refLabel || 'Reference body';
    n.title = body.map(m => m.name).join('\n');
    const tag = document.createElement('span'); tag.className = 'tag ref'; tag.textContent = 'reference';
    const x = document.createElement('button'); x.className = 'x'; x.innerHTML = UI_ICONS.close; x.title = 'Remove the reference body';
    x.onclick = () => setRef('', '');
    d.append(cb, n, tag, ...resetXform(body), x); el.append(d);
  }
  for (const m of R.models) {
    if (m.refBody) continue;
    const d = document.createElement('div'); d.className = 'm';
    const cb = eyeToggle(d, () => m.visible, (v) => { m.visible = v; });
    const n = document.createElement('span'); n.className = 'n'; n.textContent = m.name.split('\\').pop(); n.title = `${m.name}\nsource: ${m.source}${m.mod ? ` (Mod Organizer 2 mod "${m.mod}")` : ''}`;
    const tag = document.createElement('span');
    const kind = m.source === 'imported' ? 'imported' : m.source === 'plugin item' ? 'plugin' : m.role === 'ref' ? 'ref' : '';
    tag.className = `tag ${kind}`;
    tag.textContent = m.source === 'plugin item' ? 'plugin' : m.role === 'ref' && m.source !== 'imported' ? 'reference' : (m.mod || m.source || '');
    if (m.role === 'ref' && m.source === 'imported') tag.title = 'imported, worn as reference';
    else if (m.mod) tag.title = `loose file from the Mod Organizer 2 mod "${m.mod}"`;
    const x = document.createElement('button'); x.className = 'x'; x.innerHTML = UI_ICONS.close; x.title = 'Remove from the scene';
    x.onclick = () => { R.removeModel(m); state.refModels = state.refModels.filter(r => r !== m); refreshModels(); R.scheduleSweep(); };
    d.prepend(shapeTwisty(m));
    d.append(cb, n, tag, ...resetXform([m]), x); el.append(d);
    if (R.selection?.kind === 'shape' && R.selection.model === m) expanded.add(m);   // (an Alt+clicked shape shows its row)
    if (expanded.has(m)) shapeRows(el, m);
  }
  refreshShapes();
  // one line per animated model (moving parts / material animations); the full controller list on hover
  const ctl = R.models.flatMap(m => m.controllers.map(c => `${m.name.split('\\').pop()}: ${c.type.replace('BSLightingShaderProperty', 'Lighting').replace('BSEffectShaderProperty', 'Effect')} var ${c.variable ?? ''} (${(c.stop - c.start).toFixed(2)} s)`));
  const lines = R.models.filter(m => m.controllers.length).map(m => {
    const moving = m.controllers.filter(c => c.type === 'NiTransformController').length;
    const parts = [moving && `${moving} moving part${moving > 1 ? 's' : ''}`, m.controllers.length - moving && `${m.controllers.length - moving} material animation${m.controllers.length - moving > 1 ? 's' : ''}`];
    return `${m.name.split('\\').pop()}: ${parts.filter(Boolean).join(', ')}`;
  });
  $('animInfo').textContent = lines.length ? lines.join('\n') : 'Nothing in the scene animates on its own.';
  $('animInfo').title = ctl.join('\n');
  $('animInfo').style.whiteSpace = 'pre-wrap';
  const sel = $('seq');
  const opts = ['<option value="">(none)</option>'];
  R.models.forEach((m, mi) => m.sequences?.forEach((q, qi) => opts.push(
    `<option value="${mi}:${qi}" ${m.activeSeq === q ? 'selected' : ''}>${m.name.split('\\').pop()}: ${q.name} (${(q.stop - q.start).toFixed(2)} s, ${['loop', 'reverse', 'clamp'][q.cycle] ?? q.cycle})</option>`)));
  sel.innerHTML = opts.join('');
  sel.parentElement.style.display = opts.length > 1 ? '' : 'none';
}

function texLine(label, t) {
  if (!t) return '';
  const i = t.info;
  return `${label}: <b>${i.path}</b>\n   ${i.w}x${i.h} ${i.fmt}${i.srgb ? ' sRGB' : ''}${i.cube ? ' cube' : ''} mips ${i.mips}\n`;
}

function refreshShapes() {
  const el = $('shapes');
  el.innerHTML = '';
  for (const m of R.models) {
    if (m.role === 'ref') continue;
    for (const s of m.shapes) {
      const d = document.createElement('details');
      const sm = document.createElement('summary');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.visible;
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => { s.visible = cb.checked; };
      sm.append(cb, ` ${s.name} · ${s.ntris} tris`);
      d.append(sm);
      const kv = document.createElement('div'); kv.className = 'kv';
      d.ontoggle = () => {
        const mt = s.mat;
        let h = `type ${s.type}${s.skinned ? ' (skinned, ' + s.bones.length + ' bones)' : ''}\n`;
        h += `material: <b>${mt.material_path || '(NIF shader)'}</b> [${mt.source}${mt.material_source ? ', ' + mt.material_source : ''}]\n`;
        if (mt.kind === 'lighting') {
          h += `shader ${mt.shader_type} · SF1 ${hex(mt.sf1)} SF2 ${hex(mt.sf2)}\n`;
          h += `spec ${mt.specular_enabled ? 'on' : 'off'} ×${fmt(mt.specular_mult)} color ${mt.specular_color.map(fmt).join(',')} · smooth ${fmt(mt.smoothness)} · fresnel ${fmt(mt.fresnel_power)}\n`;
          h += `env ${mt.env_mapping ? 'on ×' + fmt(mt.env_mask_scale) : 'off'} · emit ${mt.emit_enabled ? 'on ' + mt.emit_color.map(fmt).join(',') + ' ×' + fmt(mt.emit_mult) : 'off'} · glowmap ${mt.glowmap ? 'on' : 'off'}\n`;
          h += `alpha ${mt.alpha.blend ? 'blend ' + mt.alpha.src + '/' + mt.alpha.dst : ''}${mt.alpha.test ? ' test ' + mt.alpha.ref : ''}${!mt.alpha.blend && !mt.alpha.test ? 'opaque' : ''} · two-sided ${mt.two_sided ? 'yes' : 'no'}${mt.greyscale ? ' · greyscale palette ' + fmt(mt.greyscale_scale) : ''}\n`;
          h += texLine('diffuse', s.tex.diffuse) + texLine('normal', s.tex.normal) + texLine('smooth/spec', s.tex.spec) +
            texLine('glow', s.tex.glow) + texLine('palette', s.tex.palette) + texLine('envmap', s.tex.env);
          for (const [k, v] of Object.entries(mt.textures)) if (v && !Object.values(s.tex).some(t => t && t.info.path === v)) h += `${k}: ${v} (not used or missing)\n`;
        } else if (mt.kind === 'effect') {
          h += `effect · base color ${mt.base_color.map(fmt).join(',')} ×${fmt(mt.base_color_scale)} · falloff ${mt.falloff_enabled ? mt.falloff.map(fmt).join(',') : 'off'}\n`;
          h += texLine('base', s.tex.base) + texLine('palette', s.tex.palette);
        }
        kv.innerHTML = h;
      };
      d.append(kv);
      el.append(d);
    }
  }
  if (!el.children.length) el.textContent = 'Load a NIF.';
}
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

// ------------------------------------------------------------------------------------------------ search
// Results float under the search box: file name first, the folder path turned into a few tags (full path on hover).
$('searchIcon').outerHTML = UI_ICONS.search;
const results = $('results');
let searchTimer, hits = [], active = -1, lastQuery = '';
const esc = (t) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function highlight(name, terms) {
  let h = esc(name);
  for (const t of terms) {
    if (!t || t.includes('\\')) continue;
    h = h.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  }
  return h;
}
function showResults(on) { results.hidden = !on || !results.innerHTML; }
function setActive(i) {
  const rows = results.querySelectorAll('.hit');
  if (!rows.length) return;
  active = (i + rows.length) % rows.length;
  rows.forEach((r, k) => r.classList.toggle('act', k === active));
  rows[active].scrollIntoView({ block: 'nearest' });
}
function openHit(i, asRef = false) {
  const p = hits[i];
  if (!p) return;
  showResults(false);
  if (asRef) loadNif(p, 'ref'); else loadNif(p);
}
async function runSearch() {
  const q = $('search').value.trim();
  if (q === lastQuery && results.innerHTML) { showResults(true); return; }
  lastQuery = q;
  if (q.length < 2) { results.innerHTML = ''; showResults(false); return; }
  let j;
  try { j = await api('search?q=' + encodeURIComponent(q) + '&limit=300'); }
  catch (e) {                                            // say so instead of showing nothing
    hits = []; lastQuery = '';
    results.innerHTML = `<div class="popempty">The mesh search failed: ${esc(e.message)}</div>`;
    showResults(true); return;
  }
  if ($('search').value.trim() !== q) return;            // typed on meanwhile
  hits = j.results; active = -1;
  const terms = q.toLowerCase().split(/\s+/);
  if (!hits.length) results.innerHTML = `<div class="popempty">No mesh matches “${esc(q)}”.</div>`;
  else results.innerHTML = hits.map((p, i) => {
    const info = pathInfo(p), game = j.names?.[p];
    const chips = info.tags.map((t, k) => `<span class="chip${k === 0 ? (t.kind === 'dlc' ? ' dlc' : ' lead') : ''}">${esc(t.text)}</span>`).join('');
    // armour and clothing: the name the game shows first, the file after it
    const nm = game ? `${highlight(game, terms)}<span class="file">${highlight(info.name, terms)}${esc(info.ext)}</span>`
      : `${highlight(info.name, terms)}<i>${esc(info.ext)}</i>`;
    return `<div class="hit cat-${info.cat}" data-i="${i}" title="${esc(game ? `${game}\n${p}` : p)}">` +
      `<span class="cat">${CAT_ICONS[info.cat] || CAT_ICONS.other}</span>` +
      `<span class="t"><div class="nm">${nm}</div><div class="chips">${chips}</div></span>` +
      `<button class="wear" data-wear="${i}" title="Wear on the reference body">${UI_ICONS.wear}</button></div>`;
  }).join('') + `<div class="popfoot"><span>${(j.matches ?? hits.length).toLocaleString()} meshes` +
    `${(j.matches ?? 0) > hits.length ? `, best ${hits.length}` : ''}</span><span><kbd>↑</kbd><kbd>↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span></div>`;
  showResults(true);
}
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
$('search').addEventListener('focus', () => { if ($('search').value.trim().length >= 2) runSearch(); });
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (results.hidden) runSearch(); else setActive(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) openHit(active, e.shiftKey); else if (hits.length === 1) openHit(0, e.shiftKey); }
  else if (e.key === 'Escape') showResults(false);
});
results.addEventListener('mousedown', (e) => e.preventDefault());     // keep the focus in the search box
results.addEventListener('click', (e) => {
  const w = e.target.closest('[data-wear]');
  if (w) { openHit(+w.dataset.wear, true); return; }
  const h = e.target.closest('.hit');
  if (h) openHit(+h.dataset.i);
});
results.addEventListener('mousemove', (e) => { const h = e.target.closest('.hit'); if (h && +h.dataset.i !== active) setActive(+h.dataset.i); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) showResults(false); });

$('clear').onclick = () => {
  for (const m of [...R.models]) R.removeModel(m);
  state.refModels = []; state.refSex = ''; state.refOutfit = ''; state.itemModels = [];
  updateRefButtons(); refreshModels(); R.scheduleSweep();
};

// ------------------------------------------------------------------------------------------------ world (cells)
const cells = new CellLoader(R, api, cellProgress);
window.lightboxCells = cells;
$('cellSearchIcon').outerHTML = UI_ICONS.search;
const cellResults = $('cellResults');
let cellTimer, cellHits = [], cellActive = -1, cellRadius = 1;
const VANILLA = /^(fallout4|dlc\w+)\.esm$/i;
function cellRow(c, i) {
  const title = c.name || c.edid || (c.grid ? `${c.world} ${c.grid.join(', ')}` : c.formid);
  const chips = [`<span class="chip lead">${c.interior ? 'Interior' : esc(c.world || 'Exterior')}</span>`];
  if (c.grid) chips.push(`<span class="chip">${c.grid.join(', ')}</span>`);
  if (c.name && c.edid) chips.push(`<span class="chip">${esc(c.edid)}</span>`);
  for (const p of c.plugins.filter(x => !VANILLA.test(x))) chips.push(`<span class="chip dlc">${esc(p.replace(/\.es[mpl]$/i, ''))}</span>`);
  return `<div class="hit ${c.interior ? 'cat-architecture' : 'cat-landscape'}" data-i="${i}" title="${esc(c.edid)} [${c.formid}]">` +
    `<span class="cat">${c.interior ? CAT_ICONS.architecture : CAT_ICONS.landscape}</span>` +
    `<span class="t"><div class="nm">${esc(title)}</div><div class="chips">${chips.join('')}</div></span><span></span></div>`;
}
async function runCellSearch() {
  const q = $('cellSearch').value.trim();
  if (q.length < 2) { cellResults.innerHTML = ''; cellResults.hidden = true; return; }
  const j = await api('cells?q=' + encodeURIComponent(q) + '&limit=150');
  if ($('cellSearch').value.trim() !== q) return;
  cellHits = j.cells; cellActive = -1;
  cellResults.innerHTML = j.error ? `<div class="popempty">${esc(j.error)}</div>`
    : !cellHits.length ? `<div class="popempty">No cell matches “${esc(q)}”.</div>`
    : cellHits.map(cellRow).join('') + `<div class="popfoot"><span>${j.matches.toLocaleString()} cells</span><span><kbd>↑</kbd><kbd>↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span></div>`;
  cellResults.hidden = false;
}
function setCellActive(i) {
  const rows = cellResults.querySelectorAll('.hit');
  if (!rows.length) return;
  cellActive = (i + rows.length) % rows.length;
  rows.forEach((r, k) => r.classList.toggle('act', k === cellActive));
  rows[cellActive].scrollIntoView({ block: 'nearest' });
}
$('cellSearch').addEventListener('input', () => { clearTimeout(cellTimer); cellTimer = setTimeout(runCellSearch, 160); });
$('cellSearch').addEventListener('focus', () => { if (cellResults.innerHTML) cellResults.hidden = false; });
$('cellSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setCellActive(cellActive + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCellActive(cellActive - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); const i = cellActive >= 0 ? cellActive : 0; if (cellHits[i]) openCell(cellHits[i]); }
  else if (e.key === 'Escape') cellResults.hidden = true;
});
cellResults.addEventListener('mousedown', (e) => e.preventDefault());
cellResults.addEventListener('click', (e) => { const h = e.target.closest('.hit'); if (h) openCell(cellHits[+h.dataset.i]); });
cellResults.addEventListener('mousemove', (e) => { const h = e.target.closest('.hit'); if (h && +h.dataset.i !== cellActive) setCellActive(+h.dataset.i); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) cellResults.hidden = true; });
document.querySelectorAll('#cellRadius button[data-r]').forEach(b => b.onclick = () => {
  cellRadius = +b.dataset.r;
  document.querySelectorAll('#cellRadius button[data-r]').forEach(x => x.classList.toggle('on', x === b));
  if (cells.info && !cells.info.interior) openCell(cells.info, state.placeKey);
});

// Plain backgrounds, the two slim buttons either side of the places: NifSkope's black (its Background colour, 0 0 0)
// and Outfit Studio's grey (BodySlide Config.xml ColorBackground 149 149 149), with NifSkope's floor grid and corner
// axes (the grid button). The Studio's sky and floor are still drawn behind them (TONEMAP_FS swaps them for the
// backdrop on screen), so the light and the exposure stay the Studio's. A place or a cell takes the backdrop away.
const BACKDROPS = { black: [0, 0, 0], grey: [149, 149, 149] };
const BD_BTN = { black: $('bdBlack'), grey: $('bdGrey') };
state.backdrop = '';
$('bdGrid').disabled = true;                   // until black or grey is on
function setBackdrop(key) {
  key = BACKDROPS[key] ? key : '';
  state.backdrop = key;
  R.settings.backdrop = key ? BACKDROPS[key].map(v => v / 255) : null;
  for (const [k, b] of Object.entries(BD_BTN)) b.classList.toggle('on', k === key);
  markPlace(state.placeKey);
  $('bdGrid').disabled = !key;
  document.body.classList.toggle('axes', !!key && R.settings.grid);
  document.body.style.setProperty('--dpr', String(window.devicePixelRatio || 1));
  R.version++;
}
async function pickBackdrop(key) {
  if (state.backdrop === key) { setBackdrop(''); return; }       // the lit button again: back to the Studio's sky
  if (cells.info || state.placeKey !== 'studio') await openPlace(PLACES.find(p => p.key === 'studio'));
  setBackdrop(key);
}
for (const [k, b] of Object.entries(BD_BTN)) b.onclick = () => { b.blur(); pickBackdrop(k); };
// even light (renderer.evenEnv): the editors' look, on top of any place, backdrop or weather; off: the weather's again
$('evenLight').innerHTML = UI_ICONS.bulb;
function setEvenLight(on) {
  R.settings.evenLight = !!on;
  $('evenLight').classList.toggle('on', R.settings.evenLight);
  R.snapAdapt = true; R.version++;
}
$('evenLight').onclick = () => { $('evenLight').blur(); setEvenLight(!R.settings.evenLight); };
$('bdGrid').onclick = () => {
  R.settings.grid = !R.settings.grid;
  $('bdGrid').classList.toggle('on', R.settings.grid);
  $('bdGrid').blur();
  setBackdrop(state.backdrop);
};

async function openCell(c, placeKey = null) {
  if (state.backdrop) setBackdrop('');
  if (state.placeKey !== placeKey) markPlace(placeKey);     // a cell from the search is not one of the locations
  cellResults.hidden = true;
  $('cellSearch').blur();
  state.cellOpening = c.name || c.edid || c.formid;         // the loading bar's name until the cell has arrived
  try {
    await cells.open(c.formid, cellRadius, (focus, interior) => {
      const pl = PLACES.find(p => p.cell && p.cell.toLowerCase() === (cells.info?.edid || '').toLowerCase());
      if (pl?.floor) { R.cellFloor = true; R.settings.ground = true; }
      const cam = R.camera;
      cam.target = interior ? [focus[0], focus[1], focus[2] + 60] : [focus[0], focus[1], focus[2] + 100];
      cam.pan = [0, 0, 0];
      cam.dist = interior ? 700 : 2600;
      cam.pitch = interior ? 0.45 : 0.42;
      applyEnv();
    });
  } catch (e) { hideLoadBar(); log(`cell ${c.edid || c.formid}: ${e.message}`, true); toast('Cell failed: ' + e.message, 5000); }
}
// The loaded cell is a layer of its own at the top of the World section, like the Scene's rows: the eye draws it or
// not (objects, landscape, water and placed lights; the character stays), the X unloads it. While a cell loads, a
// progress bar sits over the top left of the view.
let cellStats = null, loadBarTimer = 0;
function renderCellLayer() {
  updateTitle();
  const box = $('cellLayer'), c = cells.info;
  box.innerHTML = '';
  box.hidden = !c;
  if (!c) return;
  const d = document.createElement('div'); d.className = 'm';
  const eye = eyeToggle(d, () => R.cellVisible, (v) => R.setCellVisible(v));
  // in-game name first (its EditorID beside it); a cell without one shows the EditorID, and exteriors their grid
  const title = c.name || c.edid || c.formid;
  const id = [c.name ? c.edid : '', !c.interior && c.grid ? `${c.grid[0]},${c.grid[1]}` : ''].filter(Boolean).join(' ');
  const n = document.createElement('span'); n.className = 'n';
  n.innerHTML = `<b>${esc(title)}</b>${id && id !== title ? `<i>${esc(id)}</i>` : ''}`;
  n.title = [title, c.edid && `EditorID ${c.edid}`, `FormID ${c.formid}`,
    c.interior ? 'interior' : `exterior${c.world ? `, ${c.world}` : ''}${c.grid ? ` ${c.grid[0]},${c.grid[1]}` : ''}`,
    c.plugins?.length && `from ${c.plugins.join(', ')}`, cellStats?.text].filter(Boolean).join('\n');
  const tag = document.createElement('span'); tag.className = 'tag cell';
  tag.textContent = !cellStats || cellStats.loading ? 'loading…' : `${cellStats.placed.toLocaleString()} objects`;
  const x = document.createElement('button'); x.className = 'x'; x.innerHTML = UI_ICONS.close; x.title = 'Unload the cell';
  x.onclick = unloadCell;
  d.append(eye, n, tag, x); box.append(d);
}
function showLoadBar(name, frac, text, done = false) {
  const b = $('loadBar');
  clearTimeout(loadBarTimer);
  b.hidden = false; b.classList.remove('done');
  b.querySelector('.nm').textContent = name;
  b.querySelector('.ct').textContent = text;
  b.querySelector('.bar i').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  if (done) loadBarTimer = setTimeout(() => { b.classList.add('done'); loadBarTimer = setTimeout(() => { b.hidden = true; }, 450); }, 900);
}
function hideLoadBar() { clearTimeout(loadBarTimer); $('loadBar').hidden = true; }

// Each streamed model reports progress (~1,000 per big exterior): the sidebar row, the bar and the title are drawn
// once per display frame with the latest numbers; 'reading' and 'done' (which places the character) at once
let progressNext = null, progressRaf = 0;
function cellProgress(p) {
  quality.busyUntil = performance.now() + 2500;      // (frames while a place loads: not the GPU's speed)
  if (p.phase === 'models') {
    progressNext = p;
    if (!progressRaf) progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      const q = progressNext;
      progressNext = null;
      if (q && q.cell?.cell === cells.info) showProgress(q);      // not a cell unloaded or replaced meanwhile
    });
    return;
  }
  progressNext = null;          // a pending count is older than this
  showProgress(p);
}
function showProgress(p) {
  const c = p.cell?.cell || cells.info;
  const name = p.phase === 'reading' ? (state.cellOpening || 'Cell') : c ? (c.name || c.edid || c.formid) : '';
  showEnvToggles();
  if (p.phase === 'reading') { showLoadBar(name, 0.04, 'reading the cell…'); return; }
  if (p.phase !== 'done') {
    cellStats = { loading: true };
    showLoadBar(name, p.total ? p.done / p.total : 1, `models ${p.done} / ${p.total}`);
  }
  if (p.phase === 'done' && cells.focus) {
    // the character stands where coc would put the player (the COC marker, facing its way), else on the navmesh
    // nearest the middle of the cell, else at the middle on whatever is there; the camera starts behind it
    const f = cells.focus, sp = cells.spawn;
    const heading = sp && sp.heading != null ? sp.heading : 0;
    game.place(f[0], f[1], f[2], heading, sp ? 40 : 80);
    const cam = R.camera;
    cam.target = [R.playerPos[0], R.playerPos[1], R.playerPos[2] + 100]; cam.pan = [0, 0, 0];
    cam.dist = 480; cam.pitch = 0.3; cam.yaw = Math.atan2(-Math.cos(heading), Math.sin(heading));
    if (sp) log(`${name}: character placed ${sp.source === 'coc marker' ? `at the COC marker ${sp.ref} (where coc puts the player)` : 'on the navmesh nearest the middle of the cell'}`);
    else log(`${name}: no COC marker or navmesh; character placed at the middle of the cell`, true);
  }
  if (p.phase === 'done') {
    const sk = p.cell?.skipped;
    // the details on the layer's hover
    cellStats = { loading: false, placed: p.placed, text: `${p.placed.toLocaleString()} objects, ${p.total} models` +
      (p.failed ? ` (${p.failed} failed to load)` : '') + (sk ? `; skipped ${sk.marker} markers, ${sk.disabled} initially disabled` : '') };
    showLoadBar(name, 1, `${p.placed.toLocaleString()} objects${p.failed ? `, ${p.failed} models failed` : ''}`, true);
  }
  renderCellLayer();
}
function unloadCell() {
  markPlace(null);
  setTimeout(showEnvToggles, 0);
  if (game.on) toggleGame();
  cells.unload();
  R.setPlayer([0, 0, 0], 0);
  cellStats = null; renderCellLayer(); hideLoadBar();
  applyEnv();
  frameCamera('three');
}

// Game mode: the character walks through the scene (game.js); G toggles, Esc leaves
const game = new GameMode(R, api, {
  clipPath: (id) => state.clips?.find(c => c.id === id && c.available)?.path,
  skeleton: () => ensureSkeleton(),
  sex: () => state.refSex || 'm',
});
window.lightboxGame = game;
async function toggleGame() {
  if (game.on) {
    game.exit();
    // back to the pose the slider shows (game mode left its own in-place clip playing), with that pose's treadmill
    if (state.poseId === 'clip' && state.clipPath) playClip(state.clipPath, /forward|walk|run|jog|sprint/i.test(state.clipPath), null, true);
    else playPose(state.poseId ?? '', true);
    R.treadSpeed = clipTreadSpeed(state.poseId === 'clip' ? state.clipPath : state.poseId);
  } else {
    if (!state.refSex) await setRef('m', state.refOutfit);     // someone has to wear it
    try { await game.enter(); } catch (e) { log('game mode: ' + e.message, true); toast('Game mode failed: ' + e.message, 5000); }
  }
  R.treadmill = !game.on;          // game mode moves the character for real: cloth needs no treadmill then
  $('gameBtn').classList.toggle('on', game.on);
  $('gameBtnText').textContent = game.on ? 'Leave game mode' : 'Play as character';
  showKeys();
  toast(game.on ? 'Game mode: WASD to move, Space jump (hold to fly), Shift sprint, Caps Lock walk/run, G or Esc to leave' : 'Left game mode', 3000);
}
$('gameBtn').onclick = () => { $('gameBtn').blur(); toggleGame(); };
// the controls, at the bottom of the view
function showKeys() {
  $('keys').innerHTML = game.on
    ? '<b>Game mode</b> · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Space</kbd> jump (hold to fly) · <kbd>Shift</kbd> sprint · <kbd>Caps Lock</kbd> walk / run · drag: camera · wheel: zoom · <kbd>G</kbd> / <kbd>Esc</kbd> leave'
    : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> fly · <kbd>Q</kbd> / <kbd>E</kbd> down / up · <kbd>Shift</kbd> faster · drag: look · wheel: zoom · <kbd>G</kbd> play as character';
}
showKeys();

// WASD: flies the camera, or walks the character in game mode (Q/E down/up, Shift faster)
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ('wasdqe'.includes(k) && k.length === 1) { keys.add(k); e.preventDefault(); }
  if (e.key === 'Shift') keys.add('shift');
  if (e.key === 'CapsLock' && game.on) { game.walk = !game.walk; toast(game.walk ? 'Walking' : 'Running', 1200); }
  if (e.code === 'Space' && game.on) {           // jump; held, it keeps lifting (never "clicks" a focused button)
    e.preventDefault();
    if (!e.repeat) game.jump();
    keys.add('space');
  }
  if (k === 'g' && !e.repeat) toggleGame();
  if (e.key === 'Escape' && game.on) toggleGame();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') keys.delete('shift');
  if (e.code === 'Space') { keys.delete('space'); if (game.on) e.preventDefault(); }
});
window.addEventListener('blur', () => keys.clear());      // keys released while another window had the focus
function moveCamera(dt) {
  if (keys.size) R.poke();                       // the camera (or the character) is being moved: dynamic resolution
  if (game.on) { game.update(dt, keys); return; }
  if (!keys.size) return;
  const c = R.camera, sp = Math.max(150, c.dist * 0.9) * (keys.has('shift') ? 4 : 1) * dt;
  const fwd = [-Math.cos(c.yaw), -Math.sin(c.yaw), 0], right = [-Math.sin(c.yaw), Math.cos(c.yaw), 0];   // right = fwd × up
  const m = [0, 0, 0];
  const add = (v, s) => { m[0] += v[0] * s; m[1] += v[1] * s; m[2] += v[2] * s; };
  if (keys.has('w')) add(fwd, sp); if (keys.has('s')) add(fwd, -sp);
  if (keys.has('d')) add(right, sp); if (keys.has('a')) add(right, -sp);
  if (keys.has('e')) m[2] += sp; if (keys.has('q')) m[2] -= sp;
  c.target = vec3.add(c.target, m);
}

// ------------------------------------------------------------------------------------------------ from a plugin (ARMO)
// What an armour record makes the game load: the armature picked by the addon index (default or an OMOD variant), its
// male / female models with the material swaps of the armature and the variant, and the ground model.
$('itemSearchIcon').outerHTML = UI_ICONS.search;
const itemResults = $('itemResults');
let itemTimer, itemHits = [], itemActive = -1;
state.item = null; state.itemVariant = ''; state.itemModels = [];
function itemRow(it, i) {
  const chips = [`<span class="chip ${VANILLA.test(it.plugin) ? 'lead' : 'dlc'}">${esc(it.plugin.replace(/\.es[mpl]$/i, ''))}</span>`,
    `<span class="chip">${esc(it.edid)}</span>`];
  return `<div class="hit cat-${/backpack/i.test(it.edid + it.name) ? 'backpack' : 'armor'}" data-i="${i}" title="${esc(it.edid)} [${it.formid}]">` +
    `<span class="cat">${/backpack/i.test(it.edid + it.name) ? CAT_ICONS.backpack : CAT_ICONS.armor}</span>` +
    `<span class="t"><div class="nm">${esc(it.name || it.edid)}</div><div class="chips">${chips.join('')}</div></span><span></span></div>`;
}
async function runItemSearch() {
  const q = $('itemSearch').value.trim();
  if (q.length < 2) { itemResults.innerHTML = ''; itemResults.hidden = true; return; }
  const j = await api('armors?q=' + encodeURIComponent(q) + '&limit=120');
  if ($('itemSearch').value.trim() !== q) return;
  itemHits = j.items; itemActive = -1;
  itemResults.innerHTML = j.error ? `<div class="popempty">${esc(j.error)}</div>`
    : !itemHits.length ? `<div class="popempty">No armour record matches “${esc(q)}”.</div>`
    : itemHits.map(itemRow).join('') + `<div class="popfoot"><span>${j.matches.toLocaleString()} records</span><span><kbd>↑</kbd><kbd>↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span></div>`;
  itemResults.hidden = false;
}
function setItemActive(i) {
  const rows = itemResults.querySelectorAll('.hit');
  if (!rows.length) return;
  itemActive = (i + rows.length) % rows.length;
  rows.forEach((r, k) => r.classList.toggle('act', k === itemActive));
  rows[itemActive].scrollIntoView({ block: 'nearest' });
}
$('itemSearch').addEventListener('input', () => { clearTimeout(itemTimer); itemTimer = setTimeout(runItemSearch, 160); });
$('itemSearch').addEventListener('focus', () => { if (itemResults.innerHTML) itemResults.hidden = false; });
$('itemSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setItemActive(itemActive + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setItemActive(itemActive - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); const i = itemActive >= 0 ? itemActive : 0; if (itemHits[i]) selectItem(itemHits[i].formid); }
  else if (e.key === 'Escape') itemResults.hidden = true;
});
itemResults.addEventListener('mousedown', (e) => e.preventDefault());
itemResults.addEventListener('click', (e) => { const h = e.target.closest('.hit'); if (h) selectItem(itemHits[+h.dataset.i].formid); });
itemResults.addEventListener('mousemove', (e) => { const h = e.target.closest('.hit'); if (h && +h.dataset.i !== itemActive) setItemActive(+h.dataset.i); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) itemResults.hidden = true; });

async function selectItem(formid, variant = '') {
  itemResults.hidden = true;
  $('itemSearch').blur();
  try {
    state.item = await api('armor?id=' + encodeURIComponent(formid));
    state.itemVariant = variant;
    renderItemCard();
  } catch (e) { log('item: ' + e.message, true); toast('Item failed: ' + e.message, 5000); }
  return state.item;
}
// the variant's armature (prefer the human race) and the swaps for one model slot
function resolveItem(a = state.item, variantId = state.itemVariant) {
  const v = a.variants.find(x => x.formid === variantId) || null;
  const idx = v && v.resolved_index != null ? v.resolved_index : a.default_addon_index;
  const cand = a.addons.filter(x => x.index === idx && !x.missing);
  const arma = cand.find(x => /^humanrace$/i.test(x.race || '')) || cand[0] || null;
  const swaps = (base) => {
    let s = [...(base || [])];
    if (v) { s = s.filter(x => !(v.removes_swaps || []).includes(x)); s.push(...v.swaps); }
    return s;
  };
  return { v, idx, arma, swaps };
}
function fileBadge(f) {
  if (!f || !f.source) return '<span class="badge missing">missing</span>';
  if (f.source === 'loose') {
    const d = new Date(f.mtime * 1000);
    const t = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toTimeString().slice(0, 5);
    const mod = f.mod ? ` from the Mod Organizer 2 mod "${esc(f.mod)}"` : '';
    return `<span class="badge loose" title="loose file${mod}${f.overrides_archive ? ', overrides the archived copy' : ''}, ${(f.size / 1024).toFixed(0)} KB">${f.mod ? esc(f.mod) : 'loose'} · ${t}</span>`;
  }
  return `<span class="badge" title="${esc(f.source)}">${esc(f.source.replace(/\.ba2$/i, ''))}</span>`;
}
function renderItemCard() {
  const a = state.item, card = $('itemCard');
  if (!a) { card.hidden = true; return; }
  const r = resolveItem();
  const row = (k, f, extra = '') => `<div class="irow"><span class="k">${k}</span><span class="v" title="${esc(f?.path || '')}">` +
    `${esc(f?.path ? f.path.split('\\').pop() : '(none)')}${extra}</span>${f ? fileBadge(f) : ''}</div>`;
  const sw = (ids) => ids.map(id => a.swaps[id]?.edid || id).join(', ');
  const m = r.arma?.models || {};
  const swM = r.swaps(m.male?.swaps), swF = r.swaps(m.female?.swaps);
  card.innerHTML = `<div class="ih"><b>${esc(a.name || a.edid)}</b><span class="chip ${VANILLA.test(a.plugin) ? 'lead' : 'dlc'}">${esc(a.plugin.replace(/\.es[mpl]$/i, ''))}</span></div>` +
    `<div class="isub">${esc(a.edid)} · ${a.formid}</div>` +
    `<label><span class="k">Variant</span><select id="itemVariant"><option value="">default (addon ${a.default_addon_index})</option>` +
    a.variants.map(v => `<option value="${v.formid}" ${v.formid === state.itemVariant ? 'selected' : ''}>${esc(v.name || v.edid)}` +
      `${v.resolved_index != null ? ` → addon ${v.resolved_index}` : ''}${v.swaps.length ? ' · swap' : ''}${v.removes_swaps?.length ? ' · base material' : ''}</option>`).join('') +
    `</select></label>` +
    `<div class="irow"><span class="k">Armature</span><span class="v" title="${esc(r.arma?.plugin || '')}">${r.arma ? esc(`${r.arma.edid} · ${r.idx} · ${r.arma.race || '?'}`) : `none at addon index ${r.idx}`}</span>${r.arma ? '' : '<span class="badge missing">missing</span>'}</div>` +
    row('Worn ♂', m.male) + row('Worn ♀', m.female) + row('1st person', m.male_1st) + row('Ground', a.world.male) +
    (swM.length || swF.length ? `<div class="irow"><span class="k">Swaps</span><span class="v" title="${esc(sw([...new Set([...swM, ...swF])]))}">${esc(sw([...new Set([...swM, ...swF])]))}</span><span></span></div>` : '') +
    `<div class="row"><button id="itemWearM">Wear ♂</button><button id="itemWearF">Wear ♀</button><button id="itemGround">Ground</button></div>`;
  card.hidden = false;
  $('itemVariant').onchange = () => { state.itemVariant = $('itemVariant').value; renderItemCard(); };
  $('itemWearM').onclick = () => wearItem('m');
  $('itemWearF').onclick = () => wearItem('f');
  $('itemGround').onclick = () => itemGround();
}
function dropItemModels() {
  for (const m of state.itemModels) { R.removeModel(m); state.refModels = state.refModels.filter(x => x !== m); }
  state.itemModels = [];
}
// Wear / Ground clicked again while the item still loads: only the newest one stays (a superseded load is taken out
// again and its call resolves with the newest one)
let itemSeq = 0, itemLatest = null;
function loadItem(path, role, swaps, before) {
  const k = ++itemSeq;
  return (itemLatest = (async () => {
    dropItemModels();
    if (before) await before();
    if (k !== itemSeq) return itemLatest;
    const m = await loadNif(path, role, false, swaps);
    if (k !== itemSeq) {
      if (m) { R.removeModel(m); state.refModels = state.refModels.filter(x => x !== m); refreshModels(); }
      return itemLatest;
    }
    if (m) { m.source = 'plugin item'; state.itemModels.push(m); refreshModels(); }
    return m;
  })());
}
async function wearItem(sex) {
  const r = resolveItem(), f = r.arma?.models?.[sex === 'f' ? 'female' : 'male'];
  if (!f?.path || !f.source) { toast('This record has no ' + (sex === 'f' ? 'female' : 'male') + ' model for that variant', 4000); return null; }
  return loadItem(f.path, 'ref', r.swaps(f.swaps), state.refSex !== sex ? () => setRef(sex, state.refOutfit) : null);
}
async function itemGround() {
  const r = resolveItem(), f = state.item.world.male;
  if (!f?.path || !f.source) { toast('This record has no ground model', 4000); return null; }
  return loadItem(f.path, 'main', r.swaps(f.swaps), null);
}

// ------------------------------------------------------------------------------------------------ references
// Male / Female pick the body (click the lit one again for none). The outfits dress that body: an outfit never stands
// alone, so picking one with no body chosen picks the last body (male at first), and removing the body removes it too.
const OUTFIT_KEYS = ['vault', 'leathers', 'radstag'];
const REF_BTN = { m: $('refMale'), f: $('refFemale'), vault: $('refVault'), leathers: $('refLeathers'), radstag: $('refRadstag') };
const REF_PLACEHOLDER = { m: UI_ICONS.male, f: UI_ICONS.female, vault: UI_ICONS.suit, leathers: UI_ICONS.leathers, radstag: CAT_ICONS.clothes };
for (const [k, b] of Object.entries(REF_BTN)) { b.querySelector('.pic').innerHTML = REF_PLACEHOLDER[k]; b.classList.add('busy'); }
function setRefThumb(key, url) {
  const b = REF_BTN[key];
  if (!b) return;
  b.querySelector('.pic').innerHTML = `<img alt="" draggable="false" src="${url}">`;
  b.classList.remove('busy');
}
setTimeout(() => Object.values(REF_BTN).forEach(b => b.classList.remove('busy')), 30000);   // no previews: keep the icons
function refId() { return state.refSex ? `${state.refOutfit || 'body'}_${state.refSex}` : ''; }
const refPath = (sex, id) => `reference?id=${id}&vanilla=${useBodyMod(sex) ? 0 : 1}`;
function updateRefButtons() {
  REF_BTN.m.classList.toggle('on', state.refSex === 'm');
  REF_BTN.f.classList.toggle('on', state.refSex === 'f');
  for (const k of OUTFIT_KEYS) REF_BTN[k].classList.toggle('on', !!state.refSex && state.refOutfit === k);
  for (const b of Object.values(REF_BTN)) b.setAttribute('aria-pressed', b.classList.contains('on'));
}
function setRef(sex, outfit = '') {
  if (outfit === true) outfit = 'vault';          // older callers: setRef(sex, true) = the Vault suit
  if (sex) state.lastSex = sex;
  state.refSex = sex; state.refOutfit = sex ? (outfit || '') : '';
  if (sex && state.poseId === 'idle' && poseClip('idle')?.path !== R.clip?.path) playPose('idle', true);   // male / female idle
  applySkinTone();
  updateRefButtons();
  return setReference();
}
// Overlapping calls (a quick second click while the first body loads) add only the newest body; a superseded call
// resolves with the newest one
let refSeq = 0, refLatest = null;
function setReference() {
  const k = ++refSeq;
  return (refLatest = (async () => {
    const hadBody = state.refModels.some(x => x.refBody);   // swapping body or outfit keeps the camera where it is
    for (const m of state.refModels.filter(x => x.refBody)) R.removeModel(m);
    state.refModels = state.refModels.filter(x => !x.refBody);
    const id = refId();
    if (id) {
      toast('Loading reference…', 60000);
      try {
        const j = await apiOnce(refPath(state.refSex, id));
        if (k !== refSeq) return refLatest;
        state.refLabel = j.label;
        for (const part of j.parts) addScene(part, 'ref', true);
        toast(j.label);
      } catch (e) { if (k !== refSeq) return refLatest; log('reference: ' + e.message, true); }
    }
    refreshModels();
    if (!hadBody && !cells.info && !R.models.some(m => m.role === 'main')) frameCamera('three');
    R.scheduleSweep();                                   // the previous body's textures may be unused now
  })());
}
REF_BTN.m.onclick = () => setRef(state.refSex === 'm' ? '' : 'm', state.refOutfit);
REF_BTN.f.onclick = () => setRef(state.refSex === 'f' ? '' : 'f', state.refOutfit);
for (const k of OUTFIT_KEYS) {
  REF_BTN[k].onclick = () => setRef(state.refSex || state.lastSex || 'm', state.refSex && state.refOutfit === k ? '' : k);
}
// Skin tone: the game soft-light blends an NPC's skin colour (NPC_ QNAM) over every skin shader; without it the
// vanilla skin textures look deeply tanned. The male body wears the Player record's tone, the female body Nora's.
async function loadSkinTones() {
  for (let i = 0; i < 40 && !state.skinTones; i++) {        // the load-order index builds in the background (~1 s)
    try { state.skinTones = await api('skintones'); } catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!state.skinTones) log('skin tone: could not read the Player / Nora records; skin is drawn untinted', true);
  applySkinTone();
}
function applySkinTone() {
  const t = state.skinTones?.[state.refSex || 'm'];
  R.settings.skinTint = t ? t.rgb : [0.5, 0.5, 0.5];
  R.settings.skinTintAmount = t ? t.amount : 0;
}

// Body replacers (CBBE and the like) installed as loose files: off = the game's own vanilla body with its own textures
// (a replacer's loose textures have another UV layout), on = the replacer's body, hands and textures.
state.bodyMods = {};
function useBodyMod(sex) { return !!(sex && state.bodyMods[sex] && $('bodyMod').checked); }
// a tiny checkbox at the feet of the body's card (only for a body that has a replacer installed)
function showBodyMods(mods) {
  state.bodyMods = mods;
  try { $('bodyMod').checked = localStorage.getItem('lightbox.bodymod') === '1'; } catch (e) { /* storage blocked */ }
  for (const [sex, mod] of Object.entries(mods)) {
    const card = REF_BTN[sex];
    if (!card) continue;
    const chip = document.createElement('span');
    chip.className = 'modchk'; chip.setAttribute('role', 'checkbox'); chip.tabIndex = 0;
    chip.innerHTML = `<i class="box"></i>${esc(mod.name)}`;
    chip.title = `${mod.name} replaces the ${sex === 'f' ? 'female' : 'male'} body with loose files:\n` + mod.files.join('\n') +
      "\n\nTicked: the reference wears the replacer's body, hands and textures. Unticked: the game's own vanilla body.";
    const flip = (e) => { e.preventDefault(); e.stopPropagation(); $('bodyMod').checked = !$('bodyMod').checked; $('bodyMod').onchange(); };
    chip.addEventListener('click', flip);
    chip.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') flip(e); });
    chip.addEventListener('keyup', (e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); } });
    card.append(chip);
  }
  showBodyModChips();
}
function showBodyModChips() {
  for (const c of document.querySelectorAll('.modchk')) {
    c.classList.toggle('on', $('bodyMod').checked); c.setAttribute('aria-checked', $('bodyMod').checked);
  }
}
$('bodyMod').onchange = () => {
  try { localStorage.setItem('lightbox.bodymod', $('bodyMod').checked ? '1' : '0'); } catch (e) { /* storage blocked */ }
  showBodyModChips();
  if (state.refSex && state.bodyMods[state.refSex]) setReference();
};
$('refFileIcon').outerHTML = UI_ICONS.file;
$('refFile').onclick = () => $('refFileInput').click();
$('refFileInput').onchange = async () => {
  for (const f of $('refFileInput').files) await importNif(f, 'ref');
  $('refFileInput').value = '';
};
async function importNif(f, role) {
  try {
    const sc = await api('nif?name=' + encodeURIComponent(f.name), { method: 'POST', body: await f.arrayBuffer() });
    sc.source = 'imported';
    if (sc.attach_bone) await ensureSkeleton();
    addScene(sc, role);
    toast(`${f.name} ${role === 'ref' ? 'worn on the reference' : 'imported'}`);
  } catch (err) { log(`${f.name}: ${err.message}`, true); toast('Failed: ' + err.message, 5000); }
}

// ------------------------------------------------------------------------------------------------ environment UI
function hourText(h) { const t = Math.round(h * 60) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
hourTicks($('hourTicks'));
let weatherTimer;
// noFetch: the caller asks for the sample itself (setWeatherHour)
function setHour(h, fetchNow = false, noFetch = false) {
  state.hour = ((h % 24) + 24) % 24;
  $('hour').value = state.hour; $('hourV').textContent = hourText(state.hour);
  clearTimeout(weatherTimer);
  if (!noFetch) weatherTimer = setTimeout(updateWeather, fetchNow ? 0 : 60);
}
$('hour').oninput = () => setHour(+$('hour').value);
$('sunAz').oninput = () => { $('sunAzV').textContent = $('sunAz').value + '°'; applyEnv(); };
$('sunAzIcon').innerHTML = UI_ICONS.sunTurn;
// running time: a switch, and how fast (left slow, right fast: one game hour per 60 s ... 1 s)
$('timeIcon').outerHTML = UI_ICONS.timeRun;
$('slowIcon').innerHTML = UI_ICONS.slow; $('fastIcon').innerHTML = UI_ICONS.fast;
function timeRate() { return Math.round(Math.pow(60, 1 - +$('timeRate').value)); }    // real seconds per game hour
$('timeBtn').onclick = () => { $('timePlay').checked = !$('timePlay').checked; $('timeBtn').blur(); showTimeRate(); };
function showTimeRate() {
  const s = timeRate(), on = $('timePlay').checked;
  $('timeBtn').innerHTML = on ? UI_ICONS.pause : UI_ICONS.play;
  $('timeBtn').title = on ? 'Stop the clock' : 'Let time run';
  $('timeBtn').setAttribute('aria-label', $('timeBtn').title);
  $('timeRateV').textContent = `${s} s`;
  $('timeRow').title = `${$('timePlay').checked ? 'Time is running' : 'Time stands still'}: one game hour every ${s} s`;
  $('timeRow').classList.toggle('on', $('timePlay').checked);
}
$('timePlay').onchange = showTimeRate; $('timeRate').oninput = showTimeRate; showTimeRate();
// exposure: auto (eye adaptation) or fixed
$('expAutoIcon').outerHTML = UI_ICONS.eye; $('expFixedIcon').outerHTML = UI_ICONS.aperture;
$('advIcon').outerHTML = UI_ICONS.chevron;
function setExposureMode(auto) {
  R.settings.exposureAuto = auto;
  for (const b of $('expMode').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.v === 'auto') === auto);
}
for (const b of $('expMode').querySelectorAll('button')) b.onclick = () => setExposureMode(b.dataset.v === 'auto');
// sun shadows on / off; the studio floor (the flat ground shown without a cell; a cell brings its own ground)
$('shadowsBtn').innerHTML = UI_ICONS.shadows; $('floorBtn').innerHTML = UI_ICONS.floor;
function showEnvToggles() {
  const sb = $('shadowsBtn'), fb = $('floorBtn');
  sb.classList.toggle('on', R.settings.shadows); sb.setAttribute('aria-pressed', R.settings.shadows);
  sb.title = `Sun shadows: ${R.settings.shadows ? 'on' : 'off'}`;
  fb.classList.toggle('on', R.settings.ground); fb.setAttribute('aria-pressed', R.settings.ground);
  fb.disabled = !!R.cellMode && !R.cellFloor;
  fb.title = R.cellMode && !R.cellFloor ? 'Studio floor: not used while a cell is loaded (the cell has its own ground)'
    : `Studio floor (the flat ground under the model): ${R.settings.ground ? 'shown' : 'hidden'}`;
}
$('shadowsBtn').onclick = () => { R.settings.shadows = !R.settings.shadows; $('shadowsBtn').blur(); showEnvToggles(); };
$('floorBtn').onclick = () => { R.settings.ground = !R.settings.ground; $('floorBtn').blur(); showEnvToggles(); };
showEnvToggles();
$('fov').oninput = () => { R.settings.fovH = +$('fov').value; $('fovV').textContent = $('fov').value; };
$('ev').oninput = () => { const v = +$('ev').value; $('evV').textContent = v.toFixed(1); R.settings.exposure = v; R.settings.exposureBias = v; };
$('bloom').onchange = () => R.settings.bloom = $('bloom').checked;
$('grade').onchange = () => R.settings.grade = $('grade').checked;
$('lut').onchange = () => R.settings.lut = $('lut').checked;
$('specAA').onchange = () => R.settings.specAA = $('specAA').checked;
$('ao').onchange = () => R.settings.ao = $('ao').checked;
$('decals').onchange = () => { R.settings.decals = $('decals').checked; R.version++; };
$('particles').onchange = () => { R.settings.particles = $('particles').checked; R.version++; };
$('lod').onchange = () => { R.settings.lod = $('lod').checked; cells.setLod(R.settings.lod); };
$('lightShadows').onchange = () => { R.settings.lightShadows = $('lightShadows').checked; R.version++; };
$('godrays').onchange = () => { R.settings.godrays = $('godrays').checked; R.version++; };
// anti-aliasing: TAA (the game's default) with or without MSAA, or MSAA alone (renderer.js rebuilds its targets)
const AA_MODES = { taa4: { taa: true, msaa: 4 }, taa: { taa: true, msaa: 1 }, msaa: { taa: false, msaa: 4 } };
$('aa').onchange = () => Object.assign(R.settings, AA_MODES[$('aa').value] || AA_MODES.msaa);
$('tonemap').onchange = () => R.settings.tonemap = +$('tonemap').value;
$('debug').onchange = () => R.settings.debug = +$('debug').value;
function showPlaying() {
  $('play').innerHTML = R.playing ? UI_ICONS.pause : UI_ICONS.play;
  $('play').title = R.playing ? 'Pause' : 'Play';
  $('play').setAttribute('aria-label', $('play').title);
}
$('play').onclick = () => { R.playing = !R.playing; showPlaying(); };
showPlaying();
$('restart').innerHTML = UI_ICONS.restart;
$('restart').onclick = () => { R.time = 0; for (const m of R.models) m.seqStart = 0; };
$('seq').onchange = () => {
  const v = $('seq').value;
  for (const m of R.models) {
    m.activeSeq = null;
    for (const n of m.nodes.values()) n.local = new Float32Array(n.base);
    R.updateTransforms(m);
  }
  if (v) { const [mi, qi] = v.split(':').map(Number); const m = R.models[mi]; m.activeSeq = m.sequences[qi]; m.seqStart = R.time; }
};
$('speed').oninput = () => { R.speed = +$('speed').value; $('speedV').textContent = R.speed.toFixed(2) + '×'; };
// cloth physics preview (cloth.js): the switch shows when a worn item has Havok cloth; the choice is kept
try { R.clothSim = localStorage.getItem('lightbox.cloth') === '1'; } catch (e) { /* storage blocked */ }   // experimental: off unless turned on
$('clothSim').checked = R.clothSim;
$('clothSim').onchange = () => {
  R.clothSim = $('clothSim').checked; R.resetCloth();
  try { localStorage.setItem('lightbox.cloth', R.clothSim ? '1' : '0'); } catch (e) { /* storage blocked */ }
};
$('clothReset').onclick = () => R.resetCloth();
function showClothUI() {
  const cl = R.models.flatMap(m => (m.cloth || []).map(c => ({ m, c })));
  $('clothRow').hidden = $('clothInfo').hidden = !cl.length;
  if (!cl.length) return;
  const parts = cl.map(({ m, c }) => `${m.name.split('\\').pop()}: ${c.n} particles, ${c.cb.length} cloth bones` +
    (c.d.unsupported.length ? ` (not solved yet: ${c.d.unsupported.map(u => u.replace(/^hcl|ConstraintSet.*$|Mx$/g, '')).join(', ')})` : ''));
  $('clothInfo').textContent = `${parts.join('; ')}. Lightbox's own solver on the game's cloth data: close to Havok, not the same.`;
}

// ------------------------------------------------------------------------------------------------ camera
function frameCamera(kind) {
  const mains = R.models.filter(m => m.visible && m.role === 'main');
  const refsOnly = !mains.length;
  const [lo, hi] = R.sceneBounds(refsOnly, false);    // model space: placed by playerRoot below (once)
  const [mlo, mhi] = mains.length ? boundsOf(mains) : [lo, hi];
  const c = R.camera;
  c.target = mat4.transformPoint(R.playerRoot, [(mlo[0] + mhi[0]) / 2, (mlo[1] + mhi[1]) / 2, (mlo[2] + mhi[2]) / 2]);
  c.pan = [0, 0, 0];
  const r = Math.max(vec3.len(vec3.sub(mhi, mlo)) / 2, 5);
  const cw = R.canvas.clientWidth, ch = R.canvas.clientHeight;
  const fovV = 2 * Math.atan(Math.tan(R.settings.fovH * Math.PI / 360) / (cw > 0 && ch > 0 ? cw / ch : 1.6));
  const d = r / Math.sin(Math.min(R.settings.fovH * Math.PI / 360, fovV / 2)) * 1.05;
  c.dist = Number.isFinite(d) ? d : r * 3;
  // FO4 characters face +Y: "front" looks at them from +Y, "back" from -Y
  const yaw = { front: Math.PI / 2, back: -Math.PI / 2, left: Math.PI, right: 0, three: -Math.PI * 0.72, top: -Math.PI / 2 }[kind];
  if (yaw !== undefined) { c.yaw = yaw + R.playerHeading; c.pitch = kind === 'top' ? 1.45 : 0.12; }
}
function boundsOf(models) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of models) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], m.bbox[0][i]); hi[i] = Math.max(hi[i], m.bbox[1][i]); }
  return [lo, hi];
}
document.querySelectorAll('#toolbar [data-cam]').forEach(b => b.onclick = () => frameCamera(b.dataset.cam));

const cv = $('view');
let drag = null;
// the transform gizmo on the selected model (gizmo.js): its handles take the left button before the camera does
const gizmo = new Gizmo(R, cv, $('gizmo'));
gizmo.onChange = (done) => { R.poke(); if (done) refreshModels(); };
const viewXY = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('pointerdown', e => {
  if (e.button === 0 && !e.shiftKey) {
    const [x, y] = viewXY(e), h = gizmo.hit(x, y);
    if (h && gizmo.begin(h, x, y)) { drag = { gizmo: true, button: 0 }; cv.setPointerCapture(e.pointerId); return; }
  }
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey, x0: e.clientX, y0: e.clientY, t0: performance.now(), button: e.button };
  cv.setPointerCapture(e.pointerId);
});
// a single left or right click (no drag) selects the model under the cursor (its edges are outlined, its file is named
// in the HUD; a right click then opens the menu below); a click on nothing clears the selection
cv.addEventListener('pointerup', e => {
  const d = drag;
  if (d && d.gizmo) { gizmo.end(); return; }
  if (!d || (d.button !== 0 && d.button !== 2) || e.shiftKey || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4 ||
      performance.now() - d.t0 > 450) return;
  const r = cv.getBoundingClientRect();
  try {
    const hit = R.pick(e.clientX - r.left, e.clientY - r.top), was = R.selection?.kind;
    R.setSelection(e.altKey && hit?.kind === 'model' && hit.shape ? { kind: 'shape', model: hit.model, shape: hit.shape } : hit);
    if (R.selection?.kind === 'shape' || was === 'shape') refreshModels();       // the shape's row in the Scene list
  } catch (err) { console.warn('pick:', err); }
  if (d.button === 2) openCtxMenu(e.clientX, e.clientY);
});

// ------------------------------------------------------------------------------------------------ right-click menu
// A right click (no drag: dragging with the right button still pans) selects like a left click, then offers Hide and
// Delete for the selected model (the whole body for any part of the reference body, as its Scene row). Delete takes it
// out of the scene only: Lightbox never changes a file.
const ctx = $('ctxMenu');
function closeCtxMenu() { ctx.hidden = true; }
function openCtxMenu(x, y) {
  const s = R.selection;
  const list = !s || (s.kind !== 'model' && s.kind !== 'shape') ? [] : s.model.refBody ? R.models.filter(m => m.refBody) : [s.model];
  if (!list.length) { closeCtxMenu(); return; }
  const m = list[0], body = !!m.refBody;
  ctx.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ctxname';
  head.textContent = (body ? 'Reference body' : m.name.split('\\').pop()) + (s.kind === 'shape' ? ` › ${s.shape.name}` : '');
  ctx.append(head);
  const item = (label, title, fn, enabled = true) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.disabled = !enabled;
    b.onclick = () => { closeCtxMenu(); fn(); };
    ctx.append(b);
  };
  if (s.kind === 'shape') {
    const shape = s.shape;
    item('Hide shape', 'Hide this shape (its eye under the .nif in the Scene list shows it again)', () => {
      setShapeVisible(shape, false); expanded.add(s.model); R.setSelection(null); refreshModels();
    });
  }
  item(body ? 'Hide body' : 'Hide .nif', 'Hide it (its eye in the Scene list shows it again)', () => {
    for (const x of list) x.visible = false;
    R.setSelection(null); refreshModels(); R.version++;
  });
  item('Reset', 'Undo the move, turn and scale (the gizmo): back where the file puts it', () => {
    for (const x of list) R.setModelXform(x, null);
    refreshModels();
  }, list.some(x => x.xf));
  item(body ? 'Delete body' : 'Delete .nif', 'Take it out of the scene (the file itself is not touched)', () => {
    R.setSelection(null);
    if (body) { setRef('', ''); return; }
    R.removeModel(m); state.refModels = state.refModels.filter(r => r !== m); refreshModels(); R.scheduleSweep();
  });
  ctx.hidden = false;
  ctx.style.left = `${Math.max(4, Math.min(x, innerWidth - ctx.offsetWidth - 4))}px`;
  ctx.style.top = `${Math.max(4, Math.min(y, innerHeight - ctx.offsetHeight - 4))}px`;
}
window.addEventListener('pointerdown', e => { if (!ctx.hidden && !ctx.contains(e.target)) closeCtxMenu(); }, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });
window.addEventListener('blur', closeCtxMenu);
// the browser's own right-click menu (Open image in new tab, Inspect...) is not Lightbox's: off, except in text
// fields (copy, paste)
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
});
cv.addEventListener('wheel', closeCtxMenu, { passive: true });
cv.addEventListener('pointerup', () => drag = null);
cv.addEventListener('pointermove', e => {
  if (drag && drag.gizmo) { const [x, y] = viewXY(e); gizmo.move(x, y, e.ctrlKey); return; }
  if (!drag) {                                   // hovering: light the gizmo handle under the cursor
    const [x, y] = viewXY(e), h = gizmo.hit(x, y), key = h ? h.kind + (h.k ?? '') : '';
    if (key !== (gizmo.hover ? gizmo.hover.kind + (gizmo.hover.k ?? '') : '')) { gizmo.hover = h; cv.classList.toggle('ongizmo', !!h); }
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  R.poke();
  const c = R.camera;
  if (drag.pan) {
    const k = c.dist * 0.0018;
    const right = [Math.sin(c.yaw), -Math.cos(c.yaw), 0];
    const up = [-Math.sin(c.pitch) * Math.cos(c.yaw), -Math.sin(c.pitch) * Math.sin(c.yaw), Math.cos(c.pitch)];
    c.pan = vec3.add(c.pan, vec3.add(vec3.scale(right, dx * k), vec3.scale(up, dy * k)));
  } else {
    c.yaw -= dx * 0.008;
    c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch + dy * 0.008));
  }
});
cv.addEventListener('wheel', e => { e.preventDefault(); R.camera.dist *= Math.exp(e.deltaY * 0.0012); R.poke(); }, { passive: false });

// ------------------------------------------------------------------------------------------------ drag & drop
// The hint shows only while files are dragged over the page. Browsers repeat dragover while a drag stays over the
// page, so a quiet second means the drag ended elsewhere; leaving the window or losing focus clears it at once.
const drop = $('drop');
let dropTimer = 0;
const hideDrop = () => { clearTimeout(dropTimer); drop.style.display = 'none'; };
const fileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragover', e => {
  if (!fileDrag(e)) return;
  e.preventDefault(); drop.style.display = 'flex';
  clearTimeout(dropTimer); dropTimer = setTimeout(hideDrop, 1200);
});
window.addEventListener('dragleave', e => { if (!e.relatedTarget) hideDrop(); });
window.addEventListener('dragend', hideDrop);
window.addEventListener('blur', hideDrop);
document.addEventListener('visibilitychange', hideDrop);
document.addEventListener('pointermove', () => { if (drop.style.display === 'flex') hideDrop(); });   // no drag in progress
window.addEventListener('drop', async e => {
  e.preventDefault(); hideDrop();
  for (const f of e.dataTransfer.files) {
    if (/\.(png|jpe?g|webp|bmp)$/i.test(f.name)) { $('compareSec').classList.remove('closed'); setOverlay(f); continue; }
    if (!f.name.toLowerCase().endsWith('.nif')) { log(`${f.name}: not a .nif or an image`, true); continue; }
    await importNif(f, 'main');
  }
});

// ------------------------------------------------------------------------------------------------ compare overlay
const ov = $('overlay'), split = $('splitLine');
const ovCanvas = document.createElement('canvas');
let ovSplit = 0.5, ovUrl = '';
function setOverlay(file) {
  if (ovUrl) URL.revokeObjectURL(ovUrl);       // the picture it replaces
  const url = ovUrl = URL.createObjectURL(file);
  ov.onload = () => {
    ovCanvas.width = ov.naturalWidth; ovCanvas.height = ov.naturalHeight;
    ovCanvas.getContext('2d', { willReadFrequently: true }).drawImage(ov, 0, 0);
    log(`overlay ${file.name}: ${ov.naturalWidth}x${ov.naturalHeight}`);
    applyOverlayMode();
  };
  ov.src = url; ov.style.display = 'block'; ov.dataset.name = file.name;
}
function overlayRect() {          // where the image is drawn inside the view (object-fit: contain)
  const W = cv.clientWidth, H = cv.clientHeight, iw = ov.naturalWidth || 1, ih = ov.naturalHeight || 1;
  const s = Math.min(W / iw, H / ih), w = iw * s, h = ih * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h, s };
}
function applyOverlayMode() {
  const mode = $('ovMode').value;
  ov.style.mixBlendMode = mode === 'difference' ? 'difference' : 'normal';
  ov.style.opacity = mode === 'split' ? 1 : $('ovOpacity').value;
  split.style.display = mode === 'split' && ov.style.display !== 'none' ? 'block' : 'none';
  if (mode === 'split') {
    const r = overlayRect(), x = r.x + r.w * ovSplit;
    ov.style.clipPath = `inset(0 0 0 ${x}px)`; split.style.left = `${x - 1}px`;
  } else ov.style.clipPath = '';
}
$('ovOpacity').oninput = () => { $('ovOpacityV').textContent = (+$('ovOpacity').value).toFixed(2); applyOverlayMode(); };
$('ovMode').onchange = applyOverlayMode;
$('ovHide').onclick = () => { if (!ov.src) return; ov.style.display = ov.style.display === 'none' ? 'block' : 'none'; $('ovHide').textContent = ov.style.display === 'none' ? 'show overlay' : 'hide overlay'; applyOverlayMode(); };
$('ovClear').onclick = () => {
  ov.removeAttribute('src'); ov.style.display = 'none'; split.style.display = 'none'; $('probe').textContent = '';
  if (ovUrl) { URL.revokeObjectURL(ovUrl); ovUrl = ''; }
};
split.addEventListener('pointerdown', e => {
  e.stopPropagation(); split.setPointerCapture(e.pointerId);
  const move = (ev) => { const r = overlayRect(), b = cv.getBoundingClientRect(); ovSplit = Math.min(1, Math.max(0, (ev.clientX - b.left - r.x) / r.w)); applyOverlayMode(); };
  split.onpointermove = move; split.onpointerup = () => { split.onpointermove = null; };
});
window.addEventListener('resize', applyOverlayMode);

function samplePatch(ctxRead, x, y, w, h, flipY) {   // 5x5 mean, sRGB bytes
  const xs = Math.round(x), ys = Math.round(y);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.min(w - 1, Math.max(0, xs + dx)), py = Math.min(h - 1, Math.max(0, ys + dy));
    const v = ctxRead(px, flipY ? h - 1 - py : py);
    r += v[0]; g += v[1]; b += v[2]; n++;
  }
  return [r / n, g / n, b / n];
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
cv.addEventListener('click', e => {
  if (!e.altKey) return;
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  const gl = R.gl, W = R.canvas.width, H = R.canvas.height, sx = W / cv.clientWidth;
  const px = new Uint8Array(4);
  const view = samplePatch((x, y) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; }, mx * sx, my * sx, W, H, true);
  let line = `viewer  rgb ${view.map(v => v.toFixed(0)).join(',')}  lum ${lum(view).toFixed(4)}`;
  if (ov.src && ov.naturalWidth) {
    const r = overlayRect(), ix = (mx - r.x) / r.s, iy = (my - r.y) / r.s;
    if (ix >= 0 && iy >= 0 && ix < ov.naturalWidth && iy < ov.naturalHeight) {
      const c2 = ovCanvas.getContext('2d', { willReadFrequently: true });
      const game = samplePatch((x, y) => { const d = c2.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; }, ix, iy, ov.naturalWidth, ov.naturalHeight, false);
      const ratio = lum(view) / Math.max(1e-5, lum(game));
      line += `\ngame    rgb ${game.map(v => v.toFixed(0)).join(',')}  lum ${lum(game).toFixed(4)}\nviewer/game luminance ×${ratio.toFixed(3)} (${(Math.log2(ratio)).toFixed(2)} EV)`;
    }
  }
  $('probe').textContent = line + '\n' + $('probe').textContent.split('\n').slice(0, 9).join('\n');
  log(line.replace(/\n/g, ' | '));
});

// ------------------------------------------------------------------------------------------------ body pose (HKX)
let skeletonReady = null;
function ensureSkeleton() {             // (a failed request is asked again next time)
  return (skeletonReady ||= api('skeleton?vanilla=1').then(j => R.setSkeleton(j.nodes), e => { skeletonReady = null; throw e; }));
}
// The newest call wins (a pose picked while another clip still loads; a superseded call resolves with the newest);
// a clip that is already playing or loading is not asked for again (start-up asked for the relaxed idle up to three
// times: init, setRef and the saved pose)
let clipSeq = 0, clipLatest = null, clipLoading = null, clipShown = null;
const clipPath = (path, inPlace) => `anim?path=${encodeURIComponent(path)}${inPlace ? '&in_place=1' : ''}`;
function playClip(path, inPlace = false, label = '', quiet = false) {
  const key = path ? `${path}|${inPlace ? 1 : 0}` : '';
  if (key && clipLoading && clipLoading.key === key && clipLoading.k === clipSeq) return clipLoading.p;
  const k = ++clipSeq;
  const run = (async () => {
    if (!path) { R.setClip(null); clipShown = null; $('animInfo').dataset.clip = ''; refreshModels(); return; }
    if (clipShown && clipShown.key === key && clipShown.clip === R.clip) return;     // (game mode sets clips of its own)
    clipLoading = { key, k, p: null };
    try {
      await ensureSkeleton();
      if (!quiet) toast('Loading clip…', 30000);
      const clip = await apiOnce(clipPath(path, inPlace));
      if (k !== clipSeq) return clipLatest;
      R.setClip(clip);
      clipShown = { key, clip: R.clip };
      if (!quiet) toast(`${label || path.split('\\').pop()}: ${clip.duration.toFixed(2)} s, ${clip.frames} frames`);
      log(`pose clip ${path} (${clip.duration.toFixed(2)} s, ${clip.tracks.length} tracks${clip.additive ? ', ADDITIVE: shown as absolute' : ''})`);
    } catch (e) {
      if (k !== clipSeq) return clipLatest;
      log(`clip ${path}: ${e.message}`, true); toast('Clip failed: ' + e.message, 5000);
    } finally { if (clipLoading && clipLoading.k === k) clipLoading = null; }
  })();
  clipLatest = run;
  if (clipLoading && clipLoading.k === k) clipLoading.p = run;
  return run;
}
// Body pose: one stop per built-in clip, like the weather slider. The relaxed idle follows the body (male / female
// clip); a clip picked in the search below leaves the slider without a stop.
const POSES = [
  { id: '', label: 'Bind pose', icon: 'bind', title: 'Bind pose: the pose stored in the NIF' },
  { id: 'idle', label: 'Relaxed idle', icon: 'idle', title: 'Relaxed idle (the male or female clip, matching the body)' },
  { id: 'walk', label: 'Walk', icon: 'walk', title: 'Walk forward, in place' },
  { id: 'jog', label: 'Jog', icon: 'jog', title: 'Jog forward, in place' },
  { id: 'run', label: 'Run', icon: 'run', title: 'Run forward, in place' },
  { id: 'sprint', label: 'Sprint', icon: 'sprint', title: 'Sprint forward, in place' },
];
let poseItems = POSES.slice(0, 1);
const poseSlider = new IconSlider($('poseSlider'), (i, it) => playPose(it.id), { icons: POSE_ICONS, label: 'Body pose' });
poseSlider.setItems(poseItems, 0);
function poseClip(id) {
  const find = (k) => (state.clips || []).find(c => c.id === k && c.available);
  return id === 'idle' ? (state.refSex === 'f' && find('idle_f')) || find('idle_m') || find('idle_f') : find(id);
}
// the speed the character would travel at (game mode's MOVT speeds; jogging shares the run speed): the cloth's
// treadmill while a clip plays in place. A pose id or a clip path; backward clips and anything else: none
function clipTreadSpeed(id) {
  const s = (id || '').toLowerCase();
  if (/back|left|right|turn/.test(s)) return 0;
  return /sprint/.test(s) ? SPEED.sprint : /run|jog/.test(s) ? SPEED.run : /walk/.test(s) ? SPEED.walk : 0;
}
function playPose(id, quiet = false) {
  state.poseId = id;
  R.treadSpeed = clipTreadSpeed(id);
  const i = poseItems.findIndex(p => p.id === id);
  poseSlider.set(i, false);
  $('poseV').textContent = i >= 0 ? poseItems[i].label : '';
  const c = id ? poseClip(id) : null;
  return playClip(c ? c.path : '', c?.in_place, c?.label, quiet);
}
async function loadClips() {
  try {
    const j = await api('clips');
    state.clips = j.clips;
    poseItems = POSES.filter(p => !p.id || poseClip(p.id));
    poseSlider.setItems(poseItems, 0);
  } catch (e) { log('clips: ' + e.message, true); }
}

// Clip search: like the mesh search, a floating list with the clip name and tags read from its folders. Clips made
// for another skeleton (creatures, Power Armor, first-person arms) are dimmed: the body would not follow them.
$('hkxSearchIcon').outerHTML = UI_ICONS.search;
const clipResults = $('hkxResults');
let hkxTimer, clipHits = [], clipActive = -1;
function showClips(on) {
  clipResults.hidden = !on || !clipResults.innerHTML;
  if (!clipResults.hidden) clipResults.scrollIntoView({ block: 'nearest' });   // low in the sidebar: bring it up
}
function setClipActive(i) {
  const rows = clipResults.querySelectorAll('.hit');
  if (!rows.length) return;
  clipActive = (i + rows.length) % rows.length;
  rows.forEach((r, k) => r.classList.toggle('act', k === clipActive));
  rows[clipActive].scrollIntoView({ block: 'nearest' });
}
function pickClip(i) {
  const p = clipHits[i];
  if (!p) return;
  showClips(false);
  const info = animInfo(p);
  state.poseId = 'clip';
  poseSlider.set(-1, false);
  $('poseV').textContent = info.name;
  if (!info.fits) toast(`${info.name} is made for the ${info.skeleton} skeleton: the body won't follow it`, 4000);
  state.clipPath = p;
  R.treadSpeed = clipTreadSpeed(p);
  playClip(p, /forward|walk|run|jog|sprint/i.test(p), info.name);
}
// An empty box shows how to search instead of nothing (a Nexus report read "the search window won't open").
const CLIP_EXAMPLES = ['idle', 'walk', 'run', 'sneak', 'sit', 'reload', 'wave'];
function clipHint() {
  clipHits = []; clipActive = -1;
  clipResults.innerHTML = `<div class="pophint">Type at least 2 letters of a clip name. Try ` +
    CLIP_EXAMPLES.map(t => `<button class="chip lead" data-q="${t}">${t}</button>`).join(' ') + `</div>`;
  showClips(true);
}
async function runClipSearch() {
  const q = $('hkxSearch').value.trim();
  if (q.length < 2) { clipHint(); return; }
  let j;
  try { j = await api('search?kind=hkx&q=' + encodeURIComponent(q) + '&limit=300'); }
  catch (e) {
    clipHits = [];
    clipResults.innerHTML = `<div class="popempty">The clip search failed: ${esc(e.message)}</div>`;
    showClips(true); return;
  }
  if ($('hkxSearch').value.trim() !== q) return;
  clipHits = j.results; clipActive = -1;
  const terms = q.toLowerCase().split(/\s+/);
  if (!clipHits.length) clipResults.innerHTML = `<div class="popempty">No clip matches “${esc(q)}”.</div>`;
  else clipResults.innerHTML = clipHits.map((p, i) => {
    const info = animInfo(p);
    const chips = info.tags.map(t => `<span class="chip${t.kind === 'lead' ? ' lead' : t.kind === 'dlc' ? ' dlc' : t.kind === 'warn' ? ' warn' : ''}">${esc(t.text)}</span>`).join('');
    const tip = info.fits ? p : `${p}\nMade for the ${info.skeleton} skeleton: the reference body won't follow it.`;
    return `<div class="hit acat-${info.cat}${info.fits ? '' : ' off'}" data-i="${i}" title="${esc(tip)}">` +
      `<span class="cat">${ANIM_ICONS[info.cat] || ANIM_ICONS.other}</span>` +
      `<span class="t"><div class="nm">${highlight(info.name, terms)}<i>${info.ext}</i></div><div class="chips">${chips}</div></span>` +
      `<span class="go">${UI_ICONS.play}</span></div>`;
  }).join('') + `<div class="popfoot"><span>${(j.matches ?? clipHits.length).toLocaleString()} clips` +
    `${(j.matches ?? 0) > clipHits.length ? `, best ${clipHits.length}` : ''}</span><span><kbd>↑</kbd><kbd>↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span></div>`;
  showClips(true);
}
$('hkxSearch').addEventListener('input', () => { clearTimeout(hkxTimer); hkxTimer = setTimeout(runClipSearch, 180); });
$('hkxSearch').addEventListener('focus', runClipSearch);
$('hkxSearch').addEventListener('click', () => { if (clipResults.hidden) runClipSearch(); });
$('hkxSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (clipResults.hidden) runClipSearch(); else setClipActive(clipActive + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setClipActive(clipActive - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (clipActive >= 0) pickClip(clipActive); else if (clipHits.length === 1) pickClip(0); }
  else if (e.key === 'Escape') showClips(false);
});
clipResults.addEventListener('mousedown', (e) => e.preventDefault());
clipResults.addEventListener('click', (e) => {
  const ex = e.target.closest('[data-q]');
  if (ex) { $('hkxSearch').value = ex.dataset.q; runClipSearch(); return; }
  const h = e.target.closest('.hit'); if (h) pickClip(+h.dataset.i);
});
clipResults.addEventListener('mousemove', (e) => { const h = e.target.closest('.hit'); if (h && +h.dataset.i !== clipActive) setClipActive(+h.dataset.i); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) showClips(false); });
const clipsReady = loadClips();

// ------------------------------------------------------------------------------------------------ calibration scenes
// The setups of the in-game test shots the viewer was calibrated against: Vault 111 suit + Backpacks of the
// Commonwealth's Mountaineer's Backpack (the game equips MountaineerMStrapless.nif), FOV 55, the player turned to face
// north (+Y, the NIF forward axis). The pack and the Nuka-World collar are loaded only where they are installed.
async function loadIfPresent(path) {
  try {
    const sc = await api(`nif?path=${encodeURIComponent(path)}`);
    if (sc.attach_bone) await ensureSkeleton();
    const m = addScene(sc, 'main');
    m.loadArgs = { path, role: 'main', vanilla: false, swaps: [] };
    return m;
  } catch (e) { return null; }
}
const CALIB = {
  A: { weather: 'CommonwealthClear', hour: 12 }, B: { weather: 'CommonwealthOvercast', hour: 12 },
  C: { weather: 'CommonwealthClear', hour: 22, collar: true }, D: { weather: 'CommonwealthClear', hour: 7 },
};
$('calib').onchange = async () => {
  const c = CALIB[$('calib').value];
  if (!c) return;
  for (const m of [...R.models]) R.removeModel(m);
  state.refModels = [];
  $('bodyMod').checked = false; showBodyModChips();   // calibration: the vanilla character
  await setRef('m', 'vault');
  if (!await loadIfPresent('meshes\\clothes\\backpacks\\mountaineer\\mountaineermstrapless.nif'))
    log("Calibration: the Mountaineer's Backpack (Backpacks of the Commonwealth) is not installed; the suit is shown alone");
  if (c.collar && !await loadIfPresent('meshes\\dlc04\\clothes\\slavecollar\\dlc04_slavecollarm.nif'))
    log('Calibration: the shock collar needs Nuka-World; left out');
  const i = state.presets.findIndex(p => p.edid === c.weather);
  if (i >= 0) { state.weatherIndex = i; weatherSlider.set(i + 1, false); $('weatherV').textContent = state.presets[i].label || c.weather; }
  $('sunAz').value = 0; $('sunAzV').textContent = '0°';
  $('fov').value = 55; R.settings.fovH = 55; $('fovV').textContent = '55';
  R.snapAdapt = true;
  setHour(c.hour, true);
  await playPose('idle');
  frameCamera('three');
  toast(`Calibration ${$('calib').value}: ${c.weather} ${hourText(c.hour)}`);
};

// ------------------------------------------------------------------------------------------------ screenshot
// TAA: a new render size starts without history; still frames (no time passes: pose, cloth and exposure stay) refine
// it into the full supersample before the picture is taken
function settleTAA() { if (R.settings.taa) for (let i = 0; i < 18; i++) R.frame(0); }
// a shot larger than the screen with TAA: TAA alone (its 16 still frames are a 16-sample supersample; MSAA's targets
// at 2x / 3x would about double the GPU memory for nothing). Returns the setting to put back.
function shotAA(scale) {
  const msaa = R.settings.msaa;
  if (R.settings.taa && scale > 1) R.settings.msaa = 1;
  return msaa;
}
$('shot').onclick = () => {
  const scale = captureScale(+$('shotScale').value), msaa = shotAA(scale);
  R.renderScale = scale; R.capture = true;
  R.frame(0);
  settleTAA();
  // a before / after split: small labels on each side of the line
  let src = R.canvas;
  if (R.compare && R.compare.twins.size && !R.compare.peek) {
    src = document.createElement('canvas'); src.width = R.canvas.width; src.height = R.canvas.height;
    const g = src.getContext('2d'), x = Math.round(R.compare.split * src.width), f = Math.max(12, Math.round(src.height / 60));
    g.drawImage(R.canvas, 0, 0);
    g.fillStyle = 'rgba(232,176,74,.9)'; g.fillRect(x - Math.max(1, f / 12), 0, Math.max(2, f / 6), src.height);
    g.font = `600 ${f}px system-ui, sans-serif`; g.textBaseline = 'top';
    const label = (t, right) => {
      const w = g.measureText(t).width, pad = f * 0.45, bx = right ? x + f : x - f - w - 2 * pad, by = f * 2.5;
      g.fillStyle = 'rgba(10,12,14,.62)'; g.fillRect(bx, by, w + 2 * pad, f + 2 * pad);
      g.fillStyle = '#fff'; g.fillText(t, bx + pad, by + pad);
    };
    label('BEFORE', false); label('AFTER', true);
  }
  src.toBlob(b => {
    const a = document.createElement('a');
    const main = R.models.find(m => m.role === 'main');
    a.download = `lightbox_${main ? main.name.split('\\').pop().replace('.nif', '') : 'scene'}_${hourText(state.hour).replace(':', '')}.png`;
    a.href = URL.createObjectURL(b); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
  R.renderScale = 1; R.settings.msaa = msaa; R.capture = false;
  R.version++;                                 // redraw at screen size on the next refresh
};

// ------------------------------------------------------------------------------------------------ quality tiers
// quality.js: Ultra is Lightbox as it always drew; the lower tiers trade detail for speed and video memory on weaker
// GPUs. Auto starts from the GPU's name and steps down one tier when the GPU stays slow for a few seconds (never up:
// no back and forth; a reload starts again from the name). A tier picked by hand is kept.
const GPU_NAME = gpuName(R.gl), GPU_CLASS = classify(GPU_NAME);
const quality = { pref: 'auto', auto: GPU_CLASS.tier, why: GPU_CLASS.why, samples: [], since: performance.now(), busyUntil: 0 };
try {                                            // a GPU reset in Auto: this session starts one tier lower
  const t = sessionStorage.getItem('lightbox.qualityAfterReset');
  if (t && TIERS.indexOf(t) > TIERS.indexOf(quality.auto)) { quality.auto = t; quality.why = 'after a graphics driver reset'; }
} catch (e) { /* storage blocked */ }
const qualityTier = () => quality.pref === 'auto' ? quality.auto : quality.pref;
function applyQuality() {
  R.setQuality(qualityTier());
  quality.samples = []; quality.since = performance.now();
  $('quality').title = `Auto: ${TIER_LABEL[quality.auto]} (${GPU_NAME.replace(/^ANGLE \(|\)$/g, '') || 'GPU not reported'}: ${quality.why})`;
}
$('quality').onchange = () => { quality.pref = TIERS.includes($('quality').value) ? $('quality').value : 'auto'; applyQuality(); };
applyQuality();
// gpuMs: one frame's GPU time (from its fence). Frames drawn while a place loads (uploads, compiles) do not count.
function qualityGovernor(gpuMs, now) {
  if (quality.pref !== 'auto' || now < quality.busyUntil) return;
  const S = quality.samples;
  S.push([now, gpuMs]);
  while (S.length && now - S[0][0] > 4000) S.shift();
  if (now - quality.since < 4000 || S.length < 8) return;
  const med = S.map(x => x[1]).sort((a, b) => a - b)[S.length >> 1], i = TIERS.indexOf(quality.auto);
  if (med > STEP_DOWN_MS[quality.auto] && i < TIERS.length - 1) {
    quality.auto = TIERS[i + 1]; quality.why = `the GPU took ${Math.round(med)} ms per frame`;
    applyQuality();
    toast(`Quality: ${TIER_LABEL[quality.auto]} (Auto: ${quality.why}). View > Quality to choose`, 6000);
  }
}
// Frames queued to the GPU: a fence after each frame; no new frame while the tier's limit is still unfinished (a slow
// GPU otherwise lets input wait behind seconds of queued frames). The fences also time each frame for Auto: the
// smaller of submit-to-done and done-to-done.
const fences = [];
let lastDone = 0;
function gpuBusy(now) {
  const gl = R.gl;
  while (fences.length && gl.getSyncParameter(fences[0].s, gl.SYNC_STATUS) === gl.SIGNALED) {
    const f = fences.shift(); gl.deleteSync(f.s);
    qualityGovernor(Math.min(now - f.t, lastDone ? now - lastDone : Infinity), now);
    lastDone = now;
  }
  while (fences.length && now - fences[0].t > 3000) { gl.deleteSync(fences.shift().s); lastDone = 0; }   // (a lost context)
  return fences.length >= R.quality.inFlight;
}
// A GPU reset (Windows resets a GPU that does not answer for ~2 s): the page reloads with the scene put back, in Auto
// one tier lower for the rest of the session.
R.canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (quality.pref === 'auto') {
    const t = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(qualityTier()) + 1)];
    try { sessionStorage.setItem('lightbox.qualityAfterReset', t); } catch (er) { /* storage blocked */ }
  }
  toast('The graphics driver reset: putting the view back…', 10000);
  setTimeout(() => window.lightboxReloadNow ? window.lightboxReloadNow('gpu') : location.reload(), 1500);
});
// a screenshot is one frame at scale x the view: lowered while that frame is more than the GPU can draw at once
// (its renderbuffer limit; below High, the tier's pixel budget), so it cannot make Windows reset the GPU
function captureScale(want) {
  const gl = R.gl, maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = R.canvas.clientWidth * dpr, h = R.canvas.clientHeight * dpr;
  const budget = { ultra: Infinity, high: Infinity, medium: 16e6, low: 8e6 }[R.qualityName] ?? Infinity;
  let s = want;
  while (s > 1 && (w * s > maxRb || h * s > maxRb || w * h * s * s > budget)) s--;
  if (s < want) toast(`Screenshot at ${s}x: ${want}x is more than this GPU can draw in one frame (Quality: ${TIER_LABEL[R.qualityName]})`, 5000);
  return s;
}

// ------------------------------------------------------------------------------------------------ loop
// ------------------------------------------------------------------------------------------------ capture (automation)
// tools/capture.py opens the page with ?capture=<base64url JSON spec> in a headless browser, on a server started with
// --save-dir. The page loads the scene, waits for every texture, renders each lighting x camera preset straight to
// PNG (no animation frames needed), writes a contact sheet and a manifest (<name>_manifest.json = done marker).
const LIGHTING_PRESETS = {
  noon: { weather: 'clear', hour: 12 }, morning: { weather: 'clear', hour: 7 }, evening: { weather: 'clear', hour: 18.5 },
  night: { weather: 'clear', hour: 22 }, overcast: { weather: 'overcast', hour: 12 }, rain: { weather: 'rain', hour: 12 },
  foggy: { weather: 'foggy', hour: 12 }, glowingsea: { weather: 'glowing sea', hour: 12 }, radstorm: { weather: 'radstorm', hour: 12 },
  studio: { weather: 'studio', hour: 12 },
};
const CAMERA_PRESETS = {   // FO4 characters face +Y: "front" looks at them from +Y
  front: [Math.PI / 2, 0.12], back: [-Math.PI / 2, 0.12], left: [Math.PI, 0.12], right: [0, 0.12],
  three: [-Math.PI * 0.72, 0.12], threefront: [Math.PI / 2 - 0.62, 0.15], top: [-Math.PI / 2, 1.45],
  below: [-Math.PI / 2, -0.55], belowfront: [Math.PI / 2, -0.55],
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settleTextures() {
  for (let i = 0; i < 40; i++) {
    R.frame(0);                                  // a frame queues the lazy textures (LUTs, layers)
    const n = R.texCache.size;
    await Promise.all([...R.texCache.values()]);
    await sleep(30);
    if (R.texCache.size === n) return;
  }
}
function boundsOfModels(models) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of models) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], m.bbox[0][i]); hi[i] = Math.max(hi[i], m.bbox[1][i]); }
  return isFinite(lo[0]) ? [lo, hi] : null;
}
function aimCamera(preset, frame, W, H) {
  const [yaw, pitch] = CAMERA_PRESETS[preset] || CAMERA_PRESETS.three;
  const items = R.models.filter(m => m.visible && !m.refBody);
  const b = (frame !== 'body' && boundsOfModels(items)) || boundsOfModels(R.models.filter(m => m.visible)) || [[-50, -50, 0], [50, 50, 120]];
  const [lo, hi] = b, c = R.camera;
  c.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; c.pan = [0, 0, 0];
  const r = Math.max(vec3.len(vec3.sub(hi, lo)) / 2, 5);
  const fovV = 2 * Math.atan(Math.tan(R.settings.fovH * Math.PI / 360) / (W / H));
  c.dist = r / Math.sin(Math.min(R.settings.fovH * Math.PI / 360, fovV / 2)) * 1.08;
  c.yaw = yaw; c.pitch = pitch;
  const eyeZ = c.target[2] + c.dist * Math.sin(pitch);
  R.settings.ground = eyeZ > 2;                  // a camera under the ground plane looks up at the item, not the floor
}
async function setLighting(L) {
  const spec = typeof L === 'string' ? (LIGHTING_PRESETS[L.toLowerCase()] || { weather: L, hour: 12 }) : L;
  const w = (spec.weather || 'clear').toLowerCase();
  const i = w === 'studio' ? -1 : state.presets.findIndex(p => (p.label || '').toLowerCase() === w || p.edid.toLowerCase() === w ||
    (p.label || '').toLowerCase().includes(w) || p.edid.toLowerCase().includes(w.replace(/\s+/g, '')));
  state.hour = spec.hour ?? 12;
  $('hour').value = state.hour; $('hourV').textContent = hourText(state.hour);
  state.weatherIndex = i;
  weatherSlider.set(i + 1, false);
  $('weatherV').textContent = i < 0 ? 'Studio' : (state.presets[i].label || state.presets[i].edid);
  await updateWeather();
  return { name: typeof L === 'string' ? L : `${spec.weather}@${spec.hour}`, weather: i < 0 ? 'Studio' : state.presets[i].edid, hour: state.hour };
}
async function renderShot(W, H, ss) {
  const cv = R.canvas, dpr = window.devicePixelRatio || 1;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  R.renderScale = ss / Math.min(dpr, 2); R.capture = true;
  const msaa = shotAA(ss);
  R.snapAdapt = true;
  R.frame(0); R.frame(1 / 60); R.frame(1 / 60);
  settleTAA();
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(cv, 0, 0, W, H);
  R.settings.msaa = msaa;
  // quick numbers an agent can check: mean luminance, blown and crushed pixel fractions
  const d = g.getImageData(0, 0, W, H).data;
  let sum = 0, blown = 0, crushed = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += y; if (d[i] > 250 || d[i + 1] > 250 || d[i + 2] > 250) blown++; if (y < 3) crushed++;
  }
  const blob = await new Promise(res => out.toBlob(res, 'image/png'));
  return { blob, canvas: out, stats: { mean_luma: +(sum / n).toFixed(1), blown_pct: +(blown / n * 100).toFixed(2), crushed_pct: +(crushed / n * 100).toFixed(2) } };
}
async function save(name, body) {
  const r = await fetch('/api/devsave?name=' + encodeURIComponent(name), { method: 'POST', body });
  if (!r.ok) throw new Error(`saving ${name}: ${(await r.json()).error}`);
}
async function runCapture(spec) {
  document.body.classList.add('capture');
  const warnings = [];
  R.onWarn = (m) => { warnings.push(m); log(m, true); };
  const W = spec.size?.[0] || 1600, H = spec.size?.[1] || 1200, ss = spec.ss || 1, name = spec.name || 'capture';
  const manifest = { name, spec, shots: [], warnings, started: new Date().toISOString() };
  try {
    const dbg = R.gl.getExtension('WEBGL_debug_renderer_info');
    manifest.gpu = dbg ? R.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : R.gl.getParameter(R.gl.RENDERER);
    for (let i = 0; i < 100 && !state.presets.length; i++) await sleep(200);
    if (spec.ref && spec.ref !== 'none') await setRef(spec.ref, spec.outfit || (spec.suit ? 'vault' : ''));
    const role = spec.worn === false ? 'main' : (spec.ref && spec.ref !== 'none' ? 'ref' : 'main');
    for (const p of spec.nifs || []) { const m = await loadNif(p, role); if (m) m.refBody = false; else warnings.push(`could not load ${p}`); }
    for (const f of spec.files || []) {
      try {
        const sc = await api('nif?file=' + encodeURIComponent(f));
        sc.source = 'file';
        if (sc.attach_bone) await ensureSkeleton();
        addScene(sc, role);
      } catch (e) { warnings.push(`could not load ${f}: ${e.message}`); }
    }
    if (spec.armor) {
      const a = await selectItem(spec.armor.id);
      if (!a) throw new Error(`armour ${spec.armor.id} not found`);
      const v = spec.armor.variant && spec.armor.variant !== 'default'
        ? a.variants.find(x => [x.name, x.edid, x.formid].some(s => (s || '').toLowerCase() === spec.armor.variant.toLowerCase())) : null;
      if (spec.armor.variant && spec.armor.variant !== 'default' && !v) warnings.push(`variant "${spec.armor.variant}" not found; using the default`);
      state.itemVariant = v ? v.formid : '';
      renderItemCard();
      const r = resolveItem();
      manifest.item = { formid: a.formid, edid: a.edid, name: a.name, plugin: a.plugin, variant: v ? (v.name || v.edid) : 'default',
        addon_index: r.idx, arma: r.arma ? r.arma.edid : null, models: r.arma?.models || {}, ground: a.world.male || null,
        swaps: [...new Set([...r.swaps(r.arma?.models?.male?.swaps), ...r.swaps(r.arma?.models?.female?.swaps)])].map(id => a.swaps[id] || id) };
      const m = spec.armor.ground ? await itemGround() : await wearItem((spec.armor.sex || spec.ref || 'm') === 'f' ? 'f' : 'm');
      if (!m) warnings.push('the armour record did not give a model to load');
    }
    if (spec.cloth !== false) R.settleCloth(3);    // cloth hangs under gravity in the pose, as a still in game would
    $('fov').value = spec.fov || 55; R.settings.fovH = spec.fov || 55;
    const lightings = spec.lighting?.length ? spec.lighting : ['noon'];
    const cameras = spec.cameras?.length ? spec.cameras : ['three', 'front', 'left', 'below'];
    const cells = [];
    for (const L of lightings) {
      const li = await setLighting(L);
      for (const cam of cameras) {
        aimCamera(cam, spec.frame || 'item', W, H);
        await settleTextures();
        const shot = await renderShot(W, H, ss);
        const file = `${name}_${li.name.replace(/[^\w@.-]+/g, '')}_${cam}.png`;
        await save(file, shot.blob);
        manifest.shots.push({ file, lighting: li, camera: cam, ...shot.stats });
        cells.push({ canvas: shot.canvas, label: `${li.name} · ${cam}` });
      }
    }
    if (spec.sheet !== false && cells.length > 1) {
      const cols = cameras.length, rows = Math.ceil(cells.length / cols), cw = Math.min(640, W), ch = Math.round(cw * H / W);
      const sh = document.createElement('canvas'); sh.width = cols * cw; sh.height = rows * (ch + 22);
      const g = sh.getContext('2d');
      g.fillStyle = '#121417'; g.fillRect(0, 0, sh.width, sh.height);
      g.imageSmoothingQuality = 'high'; g.font = '14px Segoe UI, sans-serif'; g.fillStyle = '#d9dde3';
      cells.forEach((c, i) => {
        const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + 22);
        g.fillText(c.label, x + 8, y + 16);
        g.drawImage(c.canvas, x, y + 22, cw, ch);
      });
      const sheetBlob = await new Promise(res => sh.toBlob(res, 'image/png'));
      manifest.sheet = `${name}_sheet.png`;
      await save(manifest.sheet, sheetBlob);
    }
    manifest.models = R.models.map(m => ({ name: m.name, source: m.source, role: m.role, shapes: m.shapes.length }));
  } catch (e) {
    manifest.error = e.message;
    console.error(e);
  }
  manifest.finished = new Date().toISOString();
  await save(`${name}_manifest.json`, new Blob([JSON.stringify(manifest, null, 1)], { type: 'application/json' }));
  document.title = 'capture done';
}
const captureSpec = new URLSearchParams(location.search).get('capture');

// Redraws only when the picture would change (camera, settings, weather, animation, eye adaptation, textures
// arriving); a still scene costs no GPU time at all.
let last = performance.now(), fps = 0, timeAcc = 0, hudText = '', pendDt = 0, lastDrawAt = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if ($('timePlay').checked) {
    timeAcc += dt;
    const rate = timeRate();
    if (timeAcc > 0.1) { setHour(state.hour + timeAcc / rate, true); timeAcc = 0; }
  }
  moveCamera(dt);
  // (a frame held back by the GPU queue or the tier's animation cap keeps its time: the next frame advances by it)
  let drew = false, held = false;
  pendDt += dt;
  try {
    if (gpuBusy(now)) held = true;
    else if (R.needsFrame()) {
      const cap = R.quality.animFps;
      if (cap && R.isAnimating() && now >= (R._interactUntil || 0) && now - lastDrawAt < 1000 / cap - 2) held = true;
      else {
        R.frame(Math.min(0.1, pendDt)); drew = true; lastDrawAt = now;
        fences.push({ s: R.gl.fenceSync(R.gl.SYNC_GPU_COMMANDS_COMPLETE, 0), t: now });
      }
    }
  } catch (e) { console.error(e); log(e.message, true); }
  if (!held) pendDt = 0;
  if (drew) fps = fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
  const st = R.stats || {};
  const sel = R.selection, selName = !sel ? '' : sel.kind === 'model' ? sel.model.name.split('\\').pop()
    : sel.kind === 'shape' ? `${sel.model.name.split('\\').pop()} › ${sel.shape.name}`
    : `${(sel.tpl.name || '').split('\\').pop()}${sel.tpl.items?.[sel.index]?.edid ? `  ${sel.tpl.items[sel.index].edid}` : ''}`;
  gizmo.enabled = !game.on;
  gizmo.draw();
  const gz = gizmo.summary();
  const t = (selName ? `\u25b8 ${selName}${gz ? `  ${gz}` : ''}\n` : '') + `${R.env.name || ''}  ${hourText(state.hour)}\n` +
    `exposure ×${R.exposureValue().toFixed(3)}  scene lum ${st.avgLum?.toFixed(3) ?? '-'}  ${drew || held ? fps.toFixed(0) + ' fps' : 'idle'}` +
    (R.qualityName !== 'ultra' ? `  quality ${TIER_LABEL[R.qualityName]}${quality.pref === 'auto' ? ' (auto)' : ''}` : '') +
    (R.cellMode ? `  ${R.stats_draws ?? 0} draws` : '') + (game.on ? `\nGAME MODE · ${game.state}` : '');
  if (t !== hudText) {
    hudText = t;
    const lines = t.split('\n').map(l => l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    if (selName) lines[0] = `<span class="sel">${lines[0]}</span>`;
    $('hud').innerHTML = lines.join('\n');
  }
  requestAnimationFrame(loop);
}
// ------------------------------------------------------------------------------------------------ menu, layouts, settings
// A slim File / View / Help menu. Layouts: Studio, Compact and Viewport only, plus the sidebar on either side, a
// draggable sidebar edge and panels that fold by their title. Settings are kept in this browser as they change, can be
// saved to and loaded from a .json file, and reset to the defaults.
const SETTINGS_KEY = 'lightbox.settings.v1';
const LAYOUTS = {
  studio: { width: 340, closed: ['compareSec'] },
  compact: { width: 300, closed: ['secCamera', 'secPlugin', 'compareSec', 'secShapes', 'secLog'] },
};
const ui = { layout: 'studio', width: 340, right: false, hidden: false, hud: true, keys: true };
const foldable = () => [...document.querySelectorAll('#side section.fold')];
for (const sec of foldable()) {
  const h = sec.querySelector('h2');
  const chev = h.querySelector('.chev');
  if (chev) chev.outerHTML = UI_ICONS.chevron;
  h.addEventListener('click', (e) => { if (!e.target.closest('button, input')) sec.classList.toggle('closed'); });
}
$('showSideIcon').outerHTML = UI_ICONS.chevron;
// the side panel's contents need SIDE_FIT px; a narrower panel draws them smaller (CSS zoom) instead of cutting them
// off, down to SIDE_MIN; dragged past SIDE_SNAP it closes (the ‹ button at the view's edge opens it again)
const SIDE_FIT = 300, SIDE_MIN = 140, SIDE_SNAP = 115;
function applyLayout() {
  const app = $('app');
  ui.width = Math.max(SIDE_MIN, Math.min(620, Math.round(ui.width) || 340));
  app.style.setProperty('--side-w', ui.width + 'px');
  $('side').style.zoom = ui.width < SIDE_FIT ? (ui.width / SIDE_FIT).toFixed(3) : '';
  app.classList.toggle('right', !!ui.right);
  app.classList.toggle('noside', !!ui.hidden);
  $('showSide').hidden = !ui.hidden;
  $('hud').style.display = ui.hud ? '' : 'none';
  $('keys').style.display = ui.keys ? '' : 'none';
  syncMenu();
}
function setLayout(name) {
  if (name === 'viewport') { ui.hidden = true; ui.layout = 'viewport'; applyLayout(); return; }
  const L = LAYOUTS[name] || LAYOUTS.studio;
  Object.assign(ui, { layout: name, hidden: false, width: L.width });
  for (const sec of foldable()) sec.classList.toggle('closed', L.closed.includes(sec.id));
  applyLayout();
}
$('showSide').onclick = () => { ui.hidden = false; ui.layout = ui.width <= 300 ? 'compact' : 'studio'; applyLayout(); };
// the sidebar edge drags
$('splitter').addEventListener('pointerdown', (e) => {
  const sp = $('splitter'); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
  const box = $('app').getBoundingClientRect(), w0 = ui.width;
  let raw = w0;
  sp.onpointermove = (ev) => {
    raw = ui.right ? box.right - ev.clientX : ev.clientX - box.left;
    ui.width = raw; applyLayout();
    sp.classList.toggle('snap', raw < SIDE_SNAP);               // (let go here: the panel closes)
  };
  sp.onpointerup = () => {
    sp.onpointermove = null; sp.classList.remove('drag', 'snap');
    if (raw < SIDE_SNAP) { ui.hidden = true; ui.width = Math.max(w0, SIDE_FIT); applyLayout(); }
  };
});

// settings: what the panels are set to (not the loaded models)
function collectSettings() {
  return {
    app: 'FO4 Lightbox', version: 1,
    layout: { ...ui, folds: Object.fromEntries(foldable().map(sec => [sec.id, sec.classList.contains('closed')])) },
    render: { fov: +$('fov').value, exposureAuto: !!R.settings.exposureAuto, ev: +$('ev').value, bloom: $('bloom').checked,
      grade: $('grade').checked, lut: $('lut').checked, specAA: $('specAA').checked, ao: $('ao').checked, decals: $('decals').checked, particles: $('particles').checked, lod: $('lod').checked, lightShadows: $('lightShadows').checked, godrays: $('godrays').checked, aa: $('aa').value, tonemap: $('tonemap').value, view: $('debug').value,
      screenshot: $('shotScale').value, shadows: !!R.settings.shadows, floor: !!R.settings.ground, quality: quality.pref },
    environment: { weather: state.weatherIndex < 0 ? 'studio' : state.presets[state.weatherIndex]?.edid, hour: state.hour,
      sunAz: +$('sunAz').value, timeRate: +$('timeRate').value },
    reference: { sex: state.refSex, outfit: state.refOutfit, bodyMod: $('bodyMod').checked },
    animation: { pose: state.poseId === 'clip' ? 'idle' : state.poseId, speed: +$('speed').value },
    world: { radius: cellRadius, backdrop: state.backdrop, grid: !!R.settings.grid, evenLight: !!R.settings.evenLight },
  };
}
function setControl(id, v, ev = 'input') {
  if (v === undefined || v === null) return;
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  el.dispatchEvent(new Event(ev));
}
function applySettings(s, opts = {}) {
  if (!s || typeof s !== 'object') return;
  const L = s.layout || {};
  for (const k of ['layout', 'width', 'right', 'hidden', 'hud', 'keys']) if (k in L) ui[k] = L[k];
  if (L.folds) for (const sec of foldable()) if (sec.id in L.folds) sec.classList.toggle('closed', !!L.folds[sec.id]);
  applyLayout();
  const r = s.render || {};
  setControl('fov', r.fov); setControl('ev', r.ev);
  if ('exposureAuto' in r) setExposureMode(!!r.exposureAuto);
  setControl('bloom', r.bloom, 'change'); setControl('grade', r.grade, 'change'); setControl('lut', r.lut, 'change'); setControl('specAA', r.specAA, 'change'); setControl('ao', r.ao, 'change'); setControl('decals', r.decals, 'change'); setControl('particles', r.particles, 'change'); setControl('lod', r.lod, 'change'); setControl('lightShadows', r.lightShadows, 'change'); setControl('godrays', r.godrays, 'change'); setControl('aa', r.aa, 'change');
  setControl('quality', r.quality, 'change'); setControl('tonemap', r.tonemap, 'change'); setControl('debug', r.view, 'change'); setControl('shotScale', r.screenshot, 'change');
  if ('shadows' in r) R.settings.shadows = !!r.shadows;
  if ('floor' in r) R.settings.ground = !!r.floor;
  showEnvToggles();
  setControl('speed', s.animation?.speed);
  setControl('timeRate', s.environment?.timeRate);
  if (s.world && [0, 1, 2].includes(s.world.radius)) {
    cellRadius = s.world.radius;
    document.querySelectorAll('#cellRadius button[data-r]').forEach(b => b.classList.toggle('on', +b.dataset.r === cellRadius));
  }
  if (s.world && 'evenLight' in s.world) setEvenLight(s.world.evenLight);
  if (s.world && 'grid' in s.world) { R.settings.grid = !!s.world.grid; $('bdGrid').classList.toggle('on', R.settings.grid); }
  if (s.world && 'backdrop' in s.world && !cells.info) setBackdrop(s.world.backdrop);
  if (opts.environment !== false) applyEnvironment(s.environment || {});
  if (opts.reference !== false && s.reference) {
    if ('bodyMod' in s.reference) { $('bodyMod').checked = !!s.reference.bodyMod; showBodyModChips(); }
    if ('sex' in s.reference) setRef(s.reference.sex, s.reference.outfit);
    if (s.animation?.pose !== undefined) playPose(s.animation.pose, true);
  }
}
function applyEnvironment(e) {
  let i = null;
  if (e.weather) {
    const k = e.weather === 'studio' ? -1 : state.presets.findIndex(p => p.edid === e.weather);
    if (k >= 0 || e.weather === 'studio') i = k;
  }
  setWeatherHour(i, e.hour);
  if (e.sunAz !== undefined) setControl('sunAz', e.sunAz);
}
function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { return null; }
}
let lastSaved = '';
function startAutosave() {                     // kept in this browser whenever something changes
  setInterval(() => {
    if (state.starting || state.restoring) return;
    const j = JSON.stringify(collectSettings());
    if (j === lastSaved) return;
    lastSaved = j;
    try { localStorage.setItem(SETTINGS_KEY, j); } catch (e) { /* storage blocked */ }
  }, 1500);
}
function saveSettingsFile() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(collectSettings(), null, 2)], { type: 'application/json' }));
  a.download = 'lightbox-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Settings saved to lightbox-settings.json');
}
$('settingsInput').onchange = async () => {
  const f = $('settingsInput').files[0];
  $('settingsInput').value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!s || (!s.layout && !s.render && !s.environment)) throw new Error('not a Lightbox settings file');
    applySettings(s);
    toast(`Settings loaded from ${f.name}`);
  } catch (e) { toast('Could not load settings: ' + e.message, 5000); }
};
function resetSettings() {
  if (!confirm('Reset all settings (layout, panels, render options, weather, body) to the defaults?\nThe page reloads with the start-up scene.')) return;
  try {
    for (const k of Object.keys(localStorage)) if (/^lightbox\.(settings|bodymod|fold\.)/.test(k)) localStorage.removeItem(k);
    sessionStorage.removeItem('lightbox.snapshot');
  } catch (e) { /* storage blocked */ }
  lastSaved = '__reset__';
  location.reload();
}

// the menu bar
for (const m of document.querySelectorAll('#menubar .mi[data-icon], .mtools [data-icon]')) m.innerHTML = UI_ICONS[m.dataset.icon] || '';
for (const b of document.querySelectorAll('.mtools button[data-act]')) b.onclick = () => { b.blur(); setMenu(null); menuAction(b.dataset.act); };
let openMenu = null;
function setMenu(m) {
  if (openMenu) { openMenu.classList.remove('open'); openMenu.querySelector('.mdrop').hidden = true; }
  openMenu = m;
  if (m) { m.classList.add('open'); m.querySelector('.mdrop').hidden = false; syncMenu(); if (m.id === 'modsMenu') fillSources(); }
}
for (const m of document.querySelectorAll('#menubar .menu')) {
  const top = m.querySelector('.mtop'), drop = m.querySelector('.mdrop');
  top.onclick = (e) => { e.stopPropagation(); top.blur(); setMenu(openMenu === m ? null : m); };
  top.onmouseenter = () => { if (openMenu && openMenu !== m) setMenu(m); };
  drop.onclick = (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    setMenu(null);
    menuAction(b.dataset.act, b.dataset.v);
  };
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !e.target.closest('#menubar')) setMenu(null); });
function syncMenu() {
  for (const b of document.querySelectorAll('#menubar [data-act]')) {
    const a = b.dataset.act;
    const on = a === 'layout' ? (ui.hidden ? b.dataset.v === 'viewport' : b.dataset.v === ui.layout)
      : a === 'right' ? ui.right : a === 'hud' ? ui.hud : a === 'keys' ? ui.keys : a === 'autoreload' ? autoReloadOn() : null;
    if (on !== null) b.classList.toggle('on', !!on);
  }
}
function menuAction(act, v) {
  if (act === 'import') $('refFileInput').click();
  else if (act === 'screenshot') $('shot').click();
  else if (act === 'openWith') toggleOpenWith();
  else if (act === 'saveSettings') saveSettingsFile();
  else if (act === 'loadSettings') $('settingsInput').click();
  else if (act === 'resetSettings') resetSettings();
  else if (act === 'layout') setLayout(v);
  else if (act === 'right') { ui.right = !ui.right; applyLayout(); }
  else if (act === 'hud') { ui.hud = !ui.hud; applyLayout(); }
  else if (act === 'keys') { ui.keys = !ui.keys; applyLayout(); }
  else if (act === 'foldAll' || act === 'unfoldAll') for (const sec of foldable()) sec.classList.toggle('closed', act === 'foldAll');
  else if (act === 'autoreload') setAutoReload(!autoReloadOn());
  else if (act === 'reloadData') reloadGameFiles();
  else if (act === 'reloadAssets') reloadAssets();
  else if (act === 'source') useSource(v);
  else if (act === 'addMO2') addMO2();
  else if (act === 'controls') openModal('tplControls');
  else if (act === 'about') openModal('tplAbout');
}

// Game files saved while the viewer runs (CK, FO4Edit, an archive packer): the scene loads again by itself, or, with
// "Reload when game files change" off, a notice offers it (index.html live update); File > Reload game files does it
// on demand.
function autoReloadOn() { try { return localStorage.getItem('lightbox.autoreload') !== '0'; } catch (e) { return true; } }
function setAutoReload(on) {
  try { localStorage.setItem('lightbox.autoreload', on ? '1' : '0'); } catch (e) { /* storage blocked */ }
  syncMenu();
  toast(on ? 'The scene loads again by itself when game files change' : 'Game files changed on disk: a notice will offer to reload', 3500);
}
async function reloadGameFiles() {
  toast('Reading the game files again…', 30000);
  clearCellMemo(); clearFoundCells();
  try {
    const j = await api('reload');
    if (j.changed || String(j.data) !== state.dataVersion) window.lightboxReloadNow?.('data');
    else toast('No game files changed on disk since the scene was loaded', 3000);
  } catch (e) { toast('Reload failed: ' + e.message, 5000); }
}

// ------------------------------------------------------------------------------------------------ before / after
// R (File > Reload textures & materials): the loaded models' meshes, materials and textures that changed on disk are
// read again, and nothing else (camera, pose, hour, weather and the cell stay). Each changed model keeps its previous
// look as "before" (renderer twinShapes): drag the line across the view, hold B to see only "before", tick "keep the
// original" to compare several saves with the first look. Closing the bar frees the before copies.
const ba = { changes: [], busy: false };
const fileTime = (tag) => {            // a loose file's modification time from its tag (l:size:mtime_ns)
  const m = /^l:\d+:(\d+)$/.exec(tag || '');
  return m ? new Date(Number(BigInt(m[1]) / 1000000n)) : new Date();
};
const shortTime = (d) => d.toTimeString().slice(0, 5);
async function reloadAssets() {
  if (ba.busy) return;
  const models = R.models.filter(m => m.loadArgs && m.scene && m.scene.deps);
  if (!models.length) { toast('Nothing to reload: open a model from the game files first', 3500); return; }
  ba.busy = true;
  try {
    // what each model was built from: its NIF and materials (as the server read them) and the textures its shapes show
    const plan = models.map(m => {
      const tex = new Map();
      for (const s of m.shapes) for (const t of Object.values(s.tex)) if (t && t.info && t.info.path)
        tex.set((s.vanilla ? 'v:' : '') + t.info.path, t.info.tag || '');
      return { m, deps: m.scene.deps, tex };
    });
    const paths = new Set();
    for (const p of plan) { for (const k of Object.keys(p.deps)) paths.add(k); for (const k of p.tex.keys()) paths.add(k); }
    const now = await api('tags?paths=' + encodeURIComponent([...paths].join('|')));
    const changedTex = new Map(), found = [];
    for (const p of plan) {
      p.nif = Object.keys(p.deps).filter(k => k.endsWith('.nif') && now[k] !== p.deps[k]);
      p.mats = Object.keys(p.deps).filter(k => !k.endsWith('.nif') && now[k] !== p.deps[k]);
      p.texs = [...p.tex.keys()].filter(k => now[k] && now[k] !== p.tex.get(k));
      for (const k of p.texs) changedTex.set(k, now[k]);
      for (const k of [...p.nif, ...p.mats, ...p.texs]) if (!found.some(f => f.path === k)) found.push({ path: k, tag: now[k] });
    }
    if (!found.length) { toast('Nothing changed on disk since it was loaded', 3000); return; }
    // textures first: one new copy per changed file (the before twins keep the old one)
    for (const [k, tag] of changedTex) R.reloadTexture(k.replace(/^v:/, ''), tag);
    const pin = $('baPin').checked;
    for (const p of plan) {
      const m = p.m;
      if (!p.nif.length && !p.mats.length && !p.texs.length) continue;
      const tw = R.compare && R.compare.twins.get(m);
      const keepTwin = pin && tw;
      if (p.nif.length || p.mats.length) {
        const a = m.loadArgs;
        const sc = await api(`nif?path=${encodeURIComponent(a.path)}${a.vanilla ? '&vanilla=1' : ''}${a.swaps?.length ? '&swap=' + a.swaps.join(',') : ''}`);
        // the NIF itself changed (a new export: the same names and counts can still be new geometry): a whole new model;
        // only its materials changed: the new materials on the same shapes
        const same = sc.shapes.length === m.shapes.length && sc.shapes.every((s, i) => s.name === m.shapes[i].name);
        if (p.nif.length || !same) { await replaceModel(m, sc, keepTwin); continue; }
        if (!keepTwin) R.setTwin(m, R.twinShapes(m));
        await Promise.all(m.shapes.map((s, i) => R.applyMaterial(s, sc.shapes[i].material || { kind: 'none' })));
        m.scene = { ...m.scene, deps: sc.deps };
      } else {
        if (!keepTwin) R.setTwin(m, R.twinShapes(m));
        const hit = new Set(p.texs.map(k => k.replace(/^v:/, '').toLowerCase()));
        await Promise.all(m.shapes.filter(s => Object.values(s.tex).some(t => t && hit.has(t.info.path.toLowerCase())))
          .map(s => R.applyMaterial(s, s.mat)));
      }
    }
    for (const f of found) ba.changes.unshift({ path: f.path.replace(/^v:/, ''), at: fileTime(f.tag) });
    ba.changes = ba.changes.slice(0, 40);
    showCompare();
    toast(`Reloaded ${found.length} file${found.length === 1 ? '' : 's'}: before on the left, after on the right`, 3500);
  } catch (e) { toast('Reload failed: ' + e.message, 6000); }
  finally { ba.busy = false; }
}
// the NIF itself changed (new shapes): the new model takes the old one's place; the old one stays whole as "before"
async function replaceModel(old, sc, keepTwin) {
  if (sc.attach_bone) await ensureSkeleton();
  const m = addScene(sc, old.role, old.refBody);
  R.models.splice(R.models.indexOf(m), 1);
  R.models[R.models.indexOf(old)] = m;
  Object.assign(m, { loadArgs: old.loadArgs, visible: old.visible, mod: sc.mod || '' });
  for (const arr of [state.refModels, state.itemModels]) if (arr) { const i = arr.indexOf(old); if (i >= 0) arr[i] = m; }
  if (R.selection && R.selection.model === old) R.setSelection({ kind: 'model', model: m });
  if (keepTwin) {
    const tw = R.compare.twins.get(old);
    R.moveTwin(old, m);
    if (tw.whole) R.removeModel(old);              // an in-between version: the pinned original stays
    else {                                          // the pinned look shares the old geometry: keep that whole instead
      old.shapes.forEach((s, i) => { s.mat = tw.shapes[i].mat; s.live = tw.shapes[i].live; s.tex = tw.shapes[i].tex; });
      old.cloth = null; old.clothPose = m.clothPose;
      R.setTwin(m, { whole: old, shapes: old.shapes });
    }
  } else {
    old.cloth = null; old.clothPose = m.clothPose;  // posed like the live one (its cloth follows the live simulation)
    R.setTwin(m, { whole: old, shapes: old.shapes });
  }
  refreshModels();
}
function showCompare() {
  const on = !!(R.compare && R.compare.twins.size);
  $('baBar').hidden = !on; $('baSplit').hidden = !on;
  if (!on) return;
  placeSplit();
  $('baList').innerHTML = ba.changes.map(c => `<div><b title="${esc(c.path)}">${esc(c.path.split('\\').pop())}</b><span>${shortTime(c.at)}</span></div>`).join('');
}
function placeSplit() {
  if (!R.compare) return;
  const cv = R.canvas, main = $('main').getBoundingClientRect(), r = cv.getBoundingClientRect();
  $('baSplit').style.left = `${r.left - main.left + R.compare.split * r.width}px`;
}
function closeCompare() { R.endCompare(); ba.changes = []; showCompare(); }
$('baClose').onclick = closeCompare;
$('baSplit').addEventListener('pointerdown', (e) => {
  const el = $('baSplit');
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const r = R.canvas.getBoundingClientRect();
    R.compare.split = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    R._taaReset = true; placeSplit();
  };
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  e.preventDefault(); e.stopPropagation();
});
window.addEventListener('resize', placeSplit);
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'r' && !e.repeat) { e.preventDefault(); reloadAssets(); }
  if (e.key.toLowerCase() === 'b' && R.compare && !R.compare.peek) { R.compare.peek = true; R._taaReset = true; }
});
window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'b' && R.compare && R.compare.peek) { R.compare.peek = false; R._taaReset = true; }
});
window.addEventListener('blur', () => { if (R.compare && R.compare.peek) { R.compare.peek = false; R._taaReset = true; } });

// Mods: where the game's files come from. The game folder as it is (also what Vortex deploys), or a Mod Organizer 2
// profile read from MO2's own files: Data with the profile's enabled mods over it and Overwrite on top, its plugin list
// and INI files (server/mo2.py). The server finds MO2 by itself; a portable one elsewhere can be added here.
async function fillSources() {
  const box = $('sourceList');
  let j;
  try { j = await api('sources'); } catch (e) { box.innerHTML = `<div class="mnote">${esc(e.message)}</div>`; return; }
  box.replaceChildren();
  const several = new Set(j.sources.filter(s => s.kind === 'mo2').map(s => s.detail)).size > 1;
  for (const s of j.sources) {
    const b = document.createElement('button');
    b.className = 'radio' + (s.current ? ' on' : '');
    b.dataset.act = 'source'; b.dataset.v = s.id;
    const name = s.kind === 'game' ? 'Game folder' : `MO2 · ${s.profile}`;
    const sub = s.kind === 'game' ? 'Data as it is' : (several ? `${s.instance} · ` : '') + `${s.mods} mod${s.mods === 1 ? '' : 's'}`;
    b.innerHTML = `<span>${esc(name)}</span><small>${esc(sub)}</small>`;
    b.title = s.kind === 'game' ? `${s.detail}\nThe game's Data folder as it is: plugins.txt and the game's INI files (also mods deployed by Vortex)`
      : `Mod Organizer 2: ${s.detail}\nprofile "${s.profile}": Data with its enabled mods over it, Overwrite on top, its plugin list${s.local_settings ? ' and INI files' : ''}`;
    box.append(b);
  }
  if (!j.sources.some(s => s.kind === 'mo2')) box.insertAdjacentHTML('beforeend', '<div class="mnote">No Mod Organizer 2 set up for Fallout 4 was found</div>');
}
async function useSource(id) {
  if (!id || id === state.sourceId) return;
  toast('Reading the game files from there…', 60000);
  try {
    await api('source?id=' + encodeURIComponent(id));
    window.lightboxReloadNow?.('source');
  } catch (e) { toast('Could not switch: ' + e.message, 6000); }
}
async function addMO2() {
  const p = prompt('Paste the folder of your Mod Organizer 2:\n- a portable install: the folder with ModOrganizer.exe\n- an instance: the folder with ModOrganizer.ini');
  if (!p || !p.trim()) return;
  try {
    const j = await api('source/add?path=' + encodeURIComponent(p.trim()));
    toast(`Added. ${j.sources.filter(s => s.kind === 'mo2').length} Mod Organizer 2 profiles in the Mods menu`, 4000);
    setMenu(document.getElementById('modsMenu'));
  } catch (e) { toast(e.message, 8000); }
}

// dialogs
$('modalClose').innerHTML = UI_ICONS.close;
function openModal(tpl) {
  $('modalBody').replaceChildren($(tpl).content.cloneNode(true));
  for (const v of $('modalBody').querySelectorAll('[data-ver]')) v.textContent = state.version || v.textContent;
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; }
$('modalClose').onclick = closeModal;
$('modal').addEventListener('pointerdown', (e) => { if (e.target === $('modal')) closeModal(); });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) { closeModal(); e.stopImmediatePropagation(); }
  else if (openMenu) { setMenu(null); e.stopImmediatePropagation(); }
}, true);

// development: the game's first-person camera, for shots taken with the GameDriver. x / y / z = player.getpos (the
// feet), pitch = player.getangle x (+ looks down), heading = player.getangle z (clockwise from north). Measured
// 2026-10-07 in Sanctuary: the eye is 120 units above the feet and the horizontal FOV at 16:9 is fDefault1stPersonFOV
// (80 on this PC); the game shot and the viewer matched within half a pixel (engine-notes Section 25).
function gameCamera({ x, y, z, pitch = 0, heading = 0, fov = 80, eye = 120 }) {
  const h = heading * Math.PI / 180, e = -pitch * Math.PI / 180, c = R.camera, d = 10;
  const L = [Math.cos(e) * Math.sin(h), Math.cos(e) * Math.cos(h), Math.sin(e)];
  Object.assign(c, { pitch: -e, yaw: Math.atan2(-L[1], -L[0]), dist: d, pan: [0, 0, 0],
    target: [x + d * L[0], y + d * L[1], z + eye + d * L[2]] });
  R.settings.fovH = fov; $('fov').value = fov; $('fovV').textContent = String(fov);   // the redraw follows the signature
}

// development: drive the page from the console (regression captures, benchmarks)
// (openPlace / openCell resolve once the distant land is in too, as before the place's view came at 'done')
window.lightboxDev = { openPlace: async (k) => { await openPlace(PLACES.find(p => p.key === k)); await cells.lodDone; },
  setLighting, setRef, setHour, loadNif, playPose, openCell: async (c, k) => { await openCell(c, k); await cells.lodDone; },
  findCell: (edid) => findCell(api, edid), unloadCell: () => cells.unload(), state, cells, game, gameCamera };
// ------------------------------------------------------------------------------------------------ Open with
// FO4 Lightbox.exe <file.nif> (a double-click on a .nif, Windows' Open with) hands the file over through the server:
// a game path (the game sees exactly this file: materials and textures as for any game mesh) or, for a file anywhere
// else, its bytes (read like a dropped file). The page asks about once a second; the window's title tells the
// launcher which window to bring to the front.
let openAfter = 0, openTimer = 0;
async function pollOpens() {
  clearTimeout(openTimer);
  try {
    const r = await fetch(`/api/opens?after=${openAfter}&title=${encodeURIComponent(document.title)}`).then(x => x.json());
    for (const it of r.items || []) {
      openAfter = Math.max(openAfter, it.id);
      // like opening a file in NifSkope: it takes the place of the loaded models (the body and what it wears stay)
      for (const m of R.models.filter(x => x.role === 'main')) R.removeModel(m);
      refreshModels();
      if (it.rel) await loadNif(it.rel, 'main');
      else {
        const x = await fetch('/api/openfile?id=' + it.id);
        if (!x.ok) { toast(`${it.name}: could not be read`, 5000); continue; }
        const buf = await x.arrayBuffer();
        await importNif({ name: it.name, arrayBuffer: async () => buf }, 'main');
      }
    }
  } catch (e) { /* the server is restarting: next time */ }
  openTimer = setTimeout(pollOpens, 1000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOpens(); });
// File > Open .nif files with Lightbox: adds it to Windows' Open with list (this user, no admin rights), or takes it out
async function toggleOpenWith() {
  try {
    const s = await api('openwith');
    if (s.on) {
      if (!confirm('Take FO4 Lightbox out of the Open with list for .nif files?')) return;
      await api('openwith?set=0');
      toast('FO4 Lightbox is no longer in the Open with list for .nif files');
    } else {
      await api('openwith?set=1');
      toast('Done: right-click a .nif > Open with > FO4 Lightbox. To open .nif files with a double-click, choose it once ' +
        'with "Always use this app" ticked (Windows leaves the default to you)', 12000);
    }
  } catch (e) { toast('Open with: ' + e.message, 8000); }
}
init().catch(e => log(e.message, true)).finally(pollOpens);
requestAnimationFrame(loop);
