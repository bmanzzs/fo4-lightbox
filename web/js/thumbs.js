// Preview pictures for the reference buttons, rendered once in the browser from the user's own install (a second,
// small renderer in the background) and kept in localStorage. Nothing is shipped with the tool.
import { Renderer, defaultEnv, ambientRows } from './renderer.js';
import { vec3 } from './math.js';

const STORE = 'lightbox.refthumbs.v7';
const W = 168, H = 240;                      // rendered at 2x the button picture
const BUST = [200, 136];                     // outfit half-buttons: head to hips

export function cachedThumbs(gameDir) {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || '{}');
    return c.dir === gameDir ? c : { dir: gameDir };
  } catch { return { dir: gameDir }; }
}

// jobs: [{ key, ref, clip, tone, bust }] -> onThumb(key, dataUrl) as each picture is ready (tone: the skin tone, /api/skintones)
// opts.after: rendering starts once it resolves (the view's start-up scene first); opts.idle(): awaited before each
// picture (not while the view loads: they share the server and the GPU)
export async function renderThumbs(api, gameDir, jobs, onThumb, opts = {}) {
  const cache = cachedThumbs(gameDir);
  for (const j of jobs) if (cache[j.key]) onThumb(j.key, cache[j.key]);
  const todo = jobs.filter(j => !cache[j.key]);
  if (!todo.length) return;
  await opts.after;
  const cv = document.createElement('canvas');
  let T;
  try {
    T = new Renderer(cv);
  } catch (e) { console.warn('preview renderer:', e.message); return; }
  try {
    // no TAA: one renderer draws a different body for each thumbnail (no history may carry over), MSAA does the edges
    Object.assign(T.settings, { ground: false, bloom: false, exposureAuto: false, exposure: 0.35, lut: false, fovH: 24, taa: false });
    const e = defaultEnv();
    e.sunDir = vec3.norm([0.55, 0.85, 0.75]);            // key light from the front right, above
    e.sunColor = [2.6, 2.5, 2.35];
    e.ambRows = ambientRows([0.5, 0.52, 0.56], [0.42, 0.44, 0.48], [0.5, 0.52, 0.56], [0.36, 0.37, 0.4], [0.6, 0.62, 0.66], [0.25, 0.24, 0.23]);
    e.skyUpper = e.skyLower = e.horizon = [0, 0, 0]; e.sunDisc = [0, 0, 0]; e.sunGlare = [0, 0, 0];
    T.env = e;
    const sk = await api('skeleton?vanilla=1');
    T.setSkeleton(sk.nodes);
    const clips = new Map();                     // each clip asked for once
    let loaded = '';                             // the reference the renderer holds
    for (const j of todo) {
      if (opts.idle) await opts.idle();
      // the same body again (the full figure, then its bust): kept, nothing in it runs on (no particles or cloth)
      const keep = loaded === j.ref && T.models.every(m => !m.psys?.length && !m.cloth);
      if (!keep) for (const m of [...T.models]) T.removeModel(m);
      const [w, h] = j.bust ? BUST : [W, H];
      T.fixedSize = [w, h];
      T.settings.skinTint = j.tone ? j.tone.rgb : [0.5, 0.5, 0.5]; T.settings.skinTintAmount = j.tone ? j.tone.amount : 0;
      if (!keep) {
        const ref = await api(`reference?id=${j.ref}&vanilla=1`);
        for (const part of ref.parts) T.addModel(part, { role: 'ref' });
        loaded = j.ref;
      }
      if (j.clip) {
        if (!clips.has(j.clip)) clips.set(j.clip, await api(`anim?path=${encodeURIComponent(j.clip)}`));
        T.setClip(clips.get(j.clip)); T.time = T.clip.start + 0.5; T.playing = false;
      }
      await Promise.all([...T.texCache.values()]);
      // frame the whole figure (or head to hips for an outfit), three-quarter front (FO4 characters face +Y)
      const [lo, hi] = T.sceneBounds();
      const c = T.camera, height = hi[2] - lo[2];
      const [cz, half] = j.bust ? [0.735, 0.235] : [0.5, 0.54];
      c.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + height * cz]; c.pan = [0, 0, 0];
      c.yaw = Math.PI / 2 - 0.42; c.pitch = 0.06;
      const fovV = 2 * Math.atan(Math.tan(T.settings.fovH * Math.PI / 360) / (w / h));
      c.dist = (height * half) / Math.tan(fovV / 2);
      for (let i = 0; i < 3; i++) { T.snapAdapt = true; T.frame(0); }     // direct luminance read: no async queue here
      const url = keyOut(cv, w, h);
      if (j.tone) cache[j.key] = url;              // without the skin tone the picture is only for this visit
      onThumb(j.key, url);
    }
    try { localStorage.setItem(STORE, JSON.stringify(cache)); } catch { /* storage full or blocked: render again next time */ }
  } catch (e) {
    console.warn('preview render failed:', e);
  } finally {
    T.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// the backdrop renders pure black; make it transparent so the figure sits on the button
function keyOut(src, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, W, H), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const m = Math.max(p[i], p[i + 1], p[i + 2]);
    if (m < 6) p[i + 3] = Math.round(m / 6 * 255);
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/webp', 0.92);
}
