// The Explorer thumbnail page (thumb.html). The thumbnail service (app.py --thumbs) keeps it open in a headless
// browser: it takes one job at a time from the server, draws the NIF with the viewer's renderer and posts the picture
// back as a PNG with a transparent background. Nothing here runs in the viewer's own page.
import { Renderer, defaultEnv, ambientRows } from './renderer.js';
import { vec3 } from './math.js';

const FOV = 24;                 // degrees across the square picture: little perspective, like a product shot
const MARGIN = 0.94;            // the model fills this much of the picture
const TEX_KEEP = 256 << 20;     // textures kept between thumbnails (a folder of one mod's meshes shares most)

async function api(p) {
  const r = await fetch('/api/' + p);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let T;
const out2d = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

async function setup() {
  T = new Renderer(document.createElement('canvas'));
  // no TAA (one renderer draws a different model each time), no floor, sky or bloom; the backdrop is set per picture
  Object.assign(T.settings, { ground: false, bloom: false, exposureAuto: false, exposure: 0.35, lut: false, fovH: FOV,
    taa: false, grid: false, godrays: false, fog: false, lod: false, backdrop: [0, 0, 0] });
  try {
    T.setSkeleton((await api('skeleton?vanilla=1')).nodes);      // skinned meshes are drawn in the skeleton's rest pose
  } catch (e) { console.warn('no skeleton:', e.message); }
}

// the view: three-quarter front from a little above (FO4 meshes face +Y); tall things nearly level, long ones
// (weapons point along +Y) from the side, flat ones from higher up. A worn (skinned) piece behind the body, like a
// backpack, from behind: its outside faces the other way. sure: worn pieces and weapons, whose side the rule knows
// (anything else may face -Y after all: see betterSide)
function viewFor(lo, hi, worn) {
  const ext = vec3.sub(hi, lo), wide = Math.max(ext[0], ext[1]);
  let yaw = Math.PI / 2 - 0.42, pitch = 0.32, sure = worn;
  // (its straps may reach the chest; a coat that reaches the floor sits as far back, but is seen from the front)
  if (worn && (lo[1] + hi[1]) / 2 < -5 && lo[2] > 40) yaw = -Math.PI / 2 - 0.42;
  else if (ext[1] > 1.5 * Math.max(ext[0], ext[2])) { yaw = 0.35; sure = true; }
  if (ext[2] > 1.6 * wide) pitch = 0.1;
  else if (ext[2] < 0.25 * wide) pitch = 0.75;
  return [yaw, pitch, sure];
}

// The side. Many props face -Y, not +Y: the mailbox, the Nuka-Cola machine, the prewar radio, the teddy bear, and
// every display piece of the backpack rack. So the rule's view and the same view from the opposite side are drawn
// small, and the side with clearly more surface detail (logos, dials, screens, pockets: the mean brightness change
// between neighbouring pixels of the model) wins, unless the model shows much smaller from there. Measured on 30 rack
// displays, 41 ground models and 20 vanilla props with a known front (2026-10-18): 1.2 turns 18 rack displays the
// right way round and keeps the props whose front is +Y (the Federalist chair turns: its carved back is busier).
const SIDE_N = 96, SIDE_GAIN = 1.2, SIDE_COVER = 0.8;
function sideScore() {
  const M = SIDE_N * 2, n = SIDE_N;
  T.fixedSize = [M, M];
  T.settings.backdrop = [0, 0, 0]; T.frame(0);
  const A = grab(M);
  T.settings.backdrop = [1, 1, 1]; T.frame(0);
  const B = grab(M);
  T.settings.backdrop = [0, 0, 0];
  const L = new Float32Array(n * n), solid = new Uint8Array(n * n);
  let cover = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let a = 0, lum = 0;                                  // 2 x 2 pixels each (as the measurements were taken)
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const i = ((y * 2 + sy) * M + x * 2 + sx) * 4;
      a += Math.max(0, Math.min(1, 1 - ((B[i] - A[i]) + (B[i + 1] - A[i + 1]) + (B[i + 2] - A[i + 2])) / 765));
      lum += 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];          // (on black: premultiplied)
    }
    a /= 4; cover += a;
    if (a > 0.95) { const p = y * n + x; solid[p] = 1; L[p] = lum / 4 / a / 255; }
  }
  let s = 0, c = 0;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const p = y * n + x;
    if (solid[p] && solid[p + 1] && solid[p + n]) { s += Math.abs(L[p + 1] - L[p]) + Math.abs(L[p + n] - L[p]); c++; }
  }
  return { detail: c ? s / c : 0, cover: cover / (n * n) };
}
function look(lo, hi, yaw, pitch) {
  const f = fit(lo, hi, yaw, pitch);
  Object.assign(T.camera, { target: f.target, pan: [0, 0, 0], yaw, pitch, dist: f.dist });
  light(f.d, f.r);
}
function betterSide(lo, hi, yaw, pitch) {
  look(lo, hi, yaw, pitch);
  const a = sideScore();
  look(lo, hi, yaw + Math.PI, pitch);
  const b = sideScore();
  const turn = b.detail > a.detail * SIDE_GAIN && b.cover > a.cover * SIDE_COVER;
  return { yaw: turn ? yaw + Math.PI : yaw, why: `detail ${a.detail.toFixed(3)} / other side ${b.detail.toFixed(3)}` };
}

// camera target and distance that fit the bounding box's corners in the square picture, centred
function fit(lo, hi, yaw, pitch) {
  const t = Math.tan(FOV * Math.PI / 360) * MARGIN;
  const d = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];   // towards the eye
  const r = vec3.norm(vec3.cross(vec3.scale(d, -1), [0, 0, 1])), u = vec3.cross(r, vec3.scale(d, -1));
  const corners = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
  let c = vec3.scale(vec3.add(lo, hi), 0.5), dist = 1;
  for (let it = 0; it < 4; it++) {
    dist = 1e-3;
    for (const p of corners) {
      const v = vec3.sub(p, c), z = vec3.dot(v, d);
      dist = Math.max(dist, Math.abs(vec3.dot(v, r)) / t + z, Math.abs(vec3.dot(v, u)) / t + z);
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of corners) {
      const v = vec3.sub(p, c), depth = Math.max(1e-3, dist - vec3.dot(v, d));
      const sx = vec3.dot(v, r) / depth, sy = vec3.dot(v, u) / depth;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    c = vec3.add(c, vec3.add(vec3.scale(r, (x0 + x1) / 2 * dist), vec3.scale(u, (y0 + y1) / 2 * dist)));
  }
  return { target: c, dist, d, r };
}

// studio light: a key light from the upper left of the camera, soft cool ambient (thumbs.js, the reference buttons)
function light(d, r) {
  const e = defaultEnv();
  e.sunDir = vec3.norm(vec3.add(vec3.add(vec3.scale(d, 0.8), vec3.scale(r, -0.35)), [0, 0, 0.75]));
  e.sunColor = [2.6, 2.5, 2.35];
  e.ambRows = ambientRows([0.5, 0.52, 0.56], [0.42, 0.44, 0.48], [0.5, 0.52, 0.56], [0.36, 0.37, 0.4], [0.6, 0.62, 0.66], [0.25, 0.24, 0.23]);
  e.skyUpper = e.skyLower = e.horizon = [0, 0, 0]; e.sunDisc = [0, 0, 0]; e.sunGlare = [0, 0, 0];
  T.env = e;
}

async function settle() {
  for (let i = 0; i < 40; i++) {
    T.frame(0);                                  // a frame queues the textures it needs
    const n = T.texCache.size;
    await Promise.all([...T.texCache.values()]);
    if (T.texCache.size === n) return;
  }
}

function grab(px) {
  out2d.canvas.width = out2d.canvas.height = px;
  out2d.clearRect(0, 0, px, px);
  out2d.drawImage(T.canvas, 0, 0);
  return out2d.getImageData(0, 0, px, px).data;
}

async function draw(job) {
  const sc = await api('thumbscene?id=' + job.id);
  for (const m of [...T.models]) T.removeModel(m);
  delete sc.attach_bone;                         // a worn rigid piece (Prn) is shown where its file puts it
  const worn = sc.shapes.some(s => s.skin);      // (before addModel, which lets go of the vertex data)
  T.addModel(sc, { role: 'main' });
  const size = job.size, ss = size <= 512 ? 2 : 1, px = size * ss;
  T.fixedSize = [px, px];
  const [lo, hi] = T.sceneBounds();
  let [yaw, pitch, sure] = job.view ? job.view.split(',').map(Number).concat(true) : viewFor(lo, hi, worn);  // (view: tests)
  look(lo, hi, yaw, pitch);
  T.settings.backdrop = [0, 0, 0];
  await settle();                                // (the textures first: the side test looks at them)
  let why = '';
  if (!sure) {
    const s = betterSide(lo, hi, yaw, pitch);
    why = `, ${s.yaw !== yaw ? 'turned round' : 'kept'} (${s.why})`;
    yaw = s.yaw;
  }
  job.note = `bounds ${lo.map(Math.round)} .. ${hi.map(Math.round)}${worn ? ' skinned' : ''}, view ${yaw.toFixed(2)} ` +
    `${pitch.toFixed(2)}${why}`;
  T.fixedSize = [px, px];
  look(lo, hi, yaw, pitch);
  T.settings.backdrop = [0, 0, 0];
  T.frame(0);
  const A = grab(px);                            // on black
  T.settings.backdrop = [1, 1, 1];
  T.frame(0);                                    // (the tonemap only: the scene is not drawn again)
  const B = grab(px);                            // on white
  T.settings.backdrop = [0, 0, 0];
  // the backdrop is laid behind the models by their coverage: on black c = a * m, on white c = a * m + (1 - a), so
  // the difference gives the coverage exactly (edges, glass and hair cards included), and m = c_black / a
  const img = out2d.createImageData(size, size), o = img.data;
  let seen = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let ar = 0, rr = 0, gg = 0, bb = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const i = ((y * ss + sy) * px + x * ss + sx) * 4;
      const a = Math.max(0, Math.min(1, 1 - ((B[i] - A[i]) + (B[i + 1] - A[i + 1]) + (B[i + 2] - A[i + 2])) / 765));
      ar += a; rr += A[i]; gg += A[i + 1]; bb += A[i + 2];      // premultiplied: summed as they are
    }
    const k = (y * size + x) * 4, a = ar / (ss * ss);
    if (a > 0.002) {
      o[k] = Math.min(255, rr / ar); o[k + 1] = Math.min(255, gg / ar); o[k + 2] = Math.min(255, bb / ar);
      o[k + 3] = Math.round(a * 255);
      seen++;
    }
  }
  if (!seen) throw new Error('nothing visible');
  T.sweepTextures(TEX_KEEP);
  out2d.canvas.width = out2d.canvas.height = size;
  out2d.putImageData(img, 0, 0);
  return await new Promise((ok, no) => out2d.canvas.toBlob(b => b ? ok(b) : no(new Error('no PNG')), 'image/png'));
}

async function run() {
  await setup();
  document.title = 'thumbnails ready';
  for (;;) {
    let job;
    try { job = await api('thumbjob'); } catch { await sleep(1000); continue; }       // (the service is stopping)
    if (!job.id) continue;
    let png = null, err = null;
    try { png = await draw(job); } catch (e) { err = e.message || String(e); console.warn(job.name, e); }
    try {
      const q = (err ? '&error=' + encodeURIComponent(err) : '') + (job.note ? '&note=' + encodeURIComponent(job.note) : '');
      await fetch(`/api/thumbdone?id=${job.id}${q}`, { method: 'POST', body: png || '' });
    } catch { /* the service went away */ }
  }
}
run();
