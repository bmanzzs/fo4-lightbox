// WebGL2 renderer: HDR forward pass (MSAA), sun shadow maps, bloom, eye adaptation, tonemap + cinematic + LUT.
// The shading maths follows docs/engine-notes.md (see shaders.js); section numbers (§) refer to those notes.
//
// Performance (none of it changes the shading): every draw is an instanced draw whose model matrices come from a
// per-pass buffer, so all copies of a cell object take one call; per-frame values sit in one uniform block, material
// values in a block slot per shape that is uploaded only when a value changes; texture and render-state changes are
// skipped when nothing differs; solid objects draw nearest first (alpha-tested ones and the landscape after them, the
// sky last) so hidden pixels are rejected before shading; the cell's shadow map is kept until the sun or the view
// moves far enough, while the character gets its own small map drawn each frame it moves; eye adaptation runs on the
// GPU; a still scene is not redrawn at all.
import { mat4, vec3 } from './math.js';
import { Cloth } from './cloth.js';
import { KNOBS } from './quality.js';
import { ParticleSim } from './particles.js';
import { uploadDDS, solidTexture } from './dds.js';
import * as S from './shaders.js';
import { scaledTime, sampleKeys, sampleTransform, transformMatrix, LIGHTING_FLOAT, LIGHTING_COLOR, EFFECT_FLOAT,
  EFFECT_COLOR } from './anim.js';

// base64 vertex / clip data -> a typed array. The browser's own decoder where it has one (Chromium 140+, Firefox 133+,
// Safari 18.2+): one native pass instead of atob's binary string and a JS copy loop; the same bytes either way (the
// server's b64encode: standard alphabet, padded, no whitespace)
const b64 = typeof Uint8Array.fromBase64 === 'function' ? (s, T) => new T(Uint8Array.fromBase64(s).buffer)
  : (s, T) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new T(u.buffer); };
const PAYLOAD = ['position', 'indices', 'normal', 'uv', 'dpdu', 'dpdv', 'color', 'skin'];    // a scene shape's vertex data
export const MAX_LIGHTS = 4096;             // placed point lights in view at once (cell viewer, clustered)
const AO_UNIT = 7;                          // texture unit of the ambient occlusion (lit and landscape programs)
const LIGHT_UNIT = 13;                       // texture unit of the clustered light grid (lit and landscape programs)
// §23 shadows of placed lights: up to LS_MAX lights at once, each a cube (6 layers: omni and hemisphere lights) or one
// layer (spotlights) of a depth texture array; read on LS_UNIT by the lit and decal programs (the landscape has no unit
// free: it takes no light shadows)
export const LS_SIZE = 1024;
const LS_MAX = 8, LS_LAYERS = 48, LS_UNIT = 8;
// the game's local shadow settings ([Display]); renderer.lsParams overrides them (the user's own INI)
const LS_PARAMS = { resolution: 2048, filter: 3, halve_every: 750, distance: 3000 };
// §24 light shafts: GDRY scattering (colour x scale) per game unit = x scale (the engine's own world scale is not
// traced: calibration value); the sky and anything further is integrated to maxDist; the march (steps) covers the
// sun's shadow maps
// scale: scattering per unit = GDRY colour x scale x this (calibrated, engine-notes §24); spotGain: the spotlights'
// shafts are that much brighter (the same air, so the same extinction; calibrated). air / fwd / back: each lobe's
// share, and backSign -1 turns the record's back lobe towards the sun: fitted 2026-10-08 to the game's gr on / off
// difference in six views at Vault 111 (noon facing N / E / S / W, 18:00 into and away from the sun), error 4 of 255
// (25 before); with the lobes as written the air ahead of a view away from the sun turned white
const GR_PARAMS = { scale: 8e-5, spotGain: 50, maxDist: 4000, steps: 32, air: 0, fwd: 0.3, back: 0.15, backSign: -1 };
const CUBE_FACES = [[[1, 0, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 0]], [[0, 0, -1], [0, 1, 0]]];      // view direction, up (+x -x +y -y +z -z, as LIGHTING_BODY lsTap)
export const lin = (c) => c.map(v => Math.pow(Math.max(0, v), 2.2));     // authored colour -> linear (CPU side, §2)
const lin1 = (v) => Math.pow(Math.max(0, v), 2.2);

// §5: directional ambient as 3 gamma-space rows (ax, ay, az, b) per channel, from the colours received by surfaces
// facing +X, -X, +Y, -Y, +Z, -Z (least-squares fit; the engine's own conversion is not visible in the shaders)
export function ambientRows(px, nx, py, ny, pz, nz) {
  return [0, 1, 2].map(c => [(px[c] - nx[c]) / 2, (py[c] - ny[c]) / 2, (pz[c] - nz[c]) / 2,
    (px[c] + nx[c] + py[c] + ny[c] + pz[c] + nz[c]) / 6]);
}

// Frame uniform block (std140 float offsets; shaders.js FRAME)
const FR = { view: 0, proj: 16, sh: 32, sh2: 48, cam: 64, sun: 68, sunCol: 72, amb: 76, fogA: 88, fogH: 92, fogN: 96,
  fogF: 100, fogNH: 104, fogFH: 108, flags: 112, texel: 116, bias: 120, screen: 124, tint: 128, res: 132,
  cluster: 136, clusterZ: 140, clusterI: 144, prevVP: 148, curVP: 164, size: 180 };
const MAT_FLOATS = 32;                       // a material block: 8 vec4 (the largest layout)
const BIND = { Frame: 0, Material: 1, Bones: 2, BonesPrev: 3, LightShadows: 4 };
// TAA sub-pixel offsets: Halton (2, 3), 16 per cycle (one new position for each of the TAA_STILL refining frames),
// centred on the pixel (in pixels)
const HALTON = Array.from({ length: 16 }, (_, i) => {
  const h = (b, n) => { let f = 1, r = 0; for (n += 1; n > 0; n = Math.floor(n / b)) { f /= b; r += f * (n % b); } return r; };
  return [h(2, i) - 0.5, h(3, i) - 0.5];
});
const TAA_STILL = 16;                       // still frames a TAA picture keeps refining (then nothing is redrawn)
// §21 the game's SAO settings (Fallout4_Default.ini [Display]: fSAORadius, fSAOBias, fSAOIntensity; Fallout4Prefs.ini
// bSAOEnable=1); renderer.aoParams overrides them (the user's own INI)
const AO_PARAMS = { radius: 108.2, bias: 0.6, intensity: 7.1, samples: 10, turns: 7 };   // (the game's no-history variant)
// the game's AO darkens about half as much as these maths with the INI intensity: in-game sao 7.1 / 0 A/B at Red Rocket
// (2026-10-08, matched camera) gave the same darkening as the viewer at x0.5 on the pack, a pillar base and rubble
// (engine-notes §21, Calibration). The INI value stays the user's; this scales it
const AO_GAIN = 0.5;
const SHADOW_SIZE = [4096, 2048, 2048];     // cell map (kept for many frames), character map, far map (light shafts)
const FAR_R = 6000;                          // §24 the far sun map's reach around the camera (light shafts only)
const SHADOW_UNITS = [14, 15];               // cell map, character map: read by every lit and effect program
const ACTOR_REACH = 4000;                    // the character's shadow reaches this far beyond its own box (low sun)
const IDENTITY = mat4.identity();
// particles (particles.js): placed effects in a cell are simulated only near the camera, the nearest first; a system
// that comes into range is run ahead for up to PSYS_WARM seconds so it does not start from nothing
const PSYS_RANGE = 5000, PSYS_MAX_CELL = 40, PSYS_WARM = 3;
// texture cache sweep (sweepTextures): unused textures kept up to this many bytes; one is freed only after two sweeps
// at least TEX_GRACE ms apart found it unused
const TEX_KEEP = 768 * 2 ** 20, TEX_GRACE = 30000;
// the server's game-data generation (status data_gen): archived textures may stay in the browser's cache, but only
// for the archives they came from (a repacked archive starts a new generation)
let dataGen = '0';
export function setDataGeneration(g) { dataGen = String(g); }

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float missing (HDR targets)');
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('KHR_parallel_shader_compile');
    // bone palette size for GPU skinning: one uniform block per skinned shape
    this.maxBones = Math.max(64, Math.min(256, Math.floor(gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) / 64)));
    const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT);
    this.matSlot = Math.ceil(MAT_FLOATS * 4 / align) * align;      // bytes per material slot
    this.models = [];
    this.texCache = new Map();
    this.buildPrograms();
    this.white = solidTexture(gl, [255, 255, 255, 255]);
    this.black = solidTexture(gl, [0, 0, 0, 255]);
    this.flatN = solidTexture(gl, [128, 128, 255, 255]);
    this.greyCube = solidTexture(gl, [90, 90, 90, 255], true);
    this.emptyVao = gl.createVertexArray();
    this.frameUbo = gl.createBuffer(); this.frameData = new Float32Array(FR.size);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo); gl.bufferData(gl.UNIFORM_BUFFER, FR.size * 4, gl.DYNAMIC_DRAW);
    this._matFree = [];
    this._md = new Float32Array(MAT_FLOATS);
    this.inst = { main: this.instBuffer(), world: this.instBuffer(), actor: this.instBuffer(), probe: this.instBuffer(),
      lshadow: this.instBuffer() };
    this.time = 0; this.playing = true; this.speed = 1;
    this.clothSim = false;     // cloth physics (experimental, off by default; off: cloth bones follow the body, as the game's Animate state)
    this.aoParams = { ...AO_PARAMS };   // §21 the game's SAO settings (main.js: the user's own INI files)
    this.lsParams = { ...LS_PARAMS };   // §23 the game's local shadow settings (main.js: the user's own INI files)
    this.grParams = { ...GR_PARAMS };   // §24 light shafts
    this.compare = null;       // before / after (Reload textures & materials): see twinShapes
    this.extraModels = []; this._retired = new Set();
    this.treadmill = true;     // in-place walk / run clips: the cloth sees the clip's own travel speed (off in game mode)
    this._tread = { speed: 0, dist: 0 };
    this.settings = { shadows: true, bloom: true, exposureAuto: true, exposure: 0, exposureBias: 0, tonemap: 0,
      grade: true, lut: true, fog: true, debug: 0, ground: true, showBloom: 0, msaa: 4, fovH: 55, specAA: true,
      ao: true,              // screen-space ambient occlusion (the game's SAO, on by default in the game too)
      lightShadows: true,    // shadows of the placed lights the game marks as shadow-casting (cell viewer)
      godrays: true,         // light shafts: the weather's god rays (cell viewer, exteriors)
      particles: true,       // particle systems (fire, smoke, steam, sparks, dust): simplified, particles.js
      lod: true,             // distant land: terrain and object LOD beyond the loaded cells (world.js loadLod)
      backdrop: null,        // [r, g, b] 0..1, a plain background on screen in place of the sky and floor (NifSkope black,
                             // Outfit Studio grey); the scene behind is still drawn, so exposure and light stay as they are
      grid: true,            // with a backdrop: NifSkope's floor grid and corner axes
      evenLight: false,      // the editors' even light (evenEnv) in place of the weather's
      taa: false,            // temporal anti-aliasing (experimental; the game's default AA), with or without MSAA (msaa 1 = off)
      skinTint: [0.5, 0.5, 0.5], skinTintAmount: 0 };          // set from the NPC skin tone (main.js applySkinTone)
    this.env = defaultEnv();
    this.camera = { target: [0, 0, 80], yaw: Math.PI * 1.25, pitch: 0.15, dist: 160, pan: [0, 0, 0] };
    this.shadowSize = SHADOW_SIZE.map(n => Math.min(n, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    this.makeShadowTargets();
    this.makeAdaptTargets();
    this.lsDummy = this.depthArray(1, 1);     // bound while no light has a shadow map (the samplers need an array)
    this.ground = this.makeGround();
    this.lumAdapted = 0.18; this.lumMeasured = 0.18;
    this.dynScale = 1;         // dynamic resolution while the camera moves (adaptScale)
    this.quality = KNOBS.ultra; this.qualityName = 'ultra';     // the quality tier (quality.js, setQuality)
    this.version = 0;          // bumped by changes the frame signature cannot see (textures arriving, models added)
    this.geomVersion = 0;      // bumped when node transforms or the skinning pose change
    this.cellVersion = 0;      // bumped when the cell's shadow casters change
    this.frameNo = 0;
    this._lumPending = []; this._lumPx = new Float32Array(4); this._lumReadAt = 0; this._settleUntil = 0;
    // cell viewer: shared model templates, their placed copies (one batch per template shape), landscape quads,
    // water, placed lights
    this.cellTemplates = []; this.batches = []; this.lands = []; this.waters = []; this.pointLights = [];
    this.decalSets = [];       // §22 projected decals: one set per decal texture set, its boxes drawn by one call
    this.cellPsys = [];        // particle systems of the cell's placed objects (one per placement and system)
    this._psysDraw = []; this._psysLive = false; this._psysSeed = 0;
    this.box = this.makeBox();
    this.cellMode = false;
    this.cellVisible = true;   // the cell's layer eye: hidden = nothing of the cell is drawn or lights anything
    this.cellFloor = false;    // a cell drawn on the studio floor (the Simple scene: no landscape of its own)
    // the player group (reference body, worn items, opened models): one world placement for all of them
    this.playerRoot = mat4.identity(); this.playerPos = [0, 0, 0]; this.playerHeading = 0;
    this.resetState();
  }

  // even light (settings.evenLight): the editors' look in place of the weather's (evenEnv); the weather's own env is
  // kept and comes back as it was
  get env() { return this.settings.evenLight ? this.evenEnv() : this._env; }
  // The editors' look: no shadows, AO, light shafts, fog or colour grading. The lit shaders light the meshes the way
  // Outfit Studio does instead of with this env (shaders.js editorLook, flag in uClusterI.w) and TONEMAP_FS skips the
  // game's exposure, bloom and LUTs for the editor's own curve; this env still lights what has no lit shader (the sky).
  evenEnv() {
    if (!this._even) {
      const amb = [0.42, 0.42, 0.42];
      this._even = {
        name: 'Even light (like NifSkope / Outfit Studio)',
        sunDir: [0, -1, 0], sunColor: [1.9, 1.9, 1.9], sunDisc: [0, 0, 0], sunGlare: [0, 0, 0], noShadows: true,
        ambRows: ambientRows(amb, amb, amb, amb, amb, amb),
        skyUpper: [0.3, 0.3, 0.32], skyLower: [0.25, 0.25, 0.26], horizon: [0.4, 0.4, 0.42],
        bloomThreshold: 0.8, bloomScale: 0.12, tonemapE: 0.02, middleGray: 0.18, aeMin: 1.8, aeMax: 1.8,
        cinematic: [1, 1, 1], tint: [1, 1, 1, 0], luts: [], fog: null, eyeAdaptSpeed: 3,
      };
    }
    return this._even;
  }

  // FO4 characters face +Y; heading turns them about Z (radians)
  setPlayer(pos, heading = 0) {
    const c = Math.cos(heading), sn = Math.sin(heading), m = mat4.identity();
    m[0] = c; m[1] = sn; m[4] = -sn; m[5] = c; m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
    this.playerRoot = m; this.playerPos = [...pos]; this.playerHeading = heading;
    this.version++;
  }
  playerWorld(s) {
    const F = s._model && s._model.fixedWorld;          // a model placed in the world (an opened door, main.js)
    if (F) return mat4.mul(F, s.world);
    if (!s._player) return s.world;
    const X = s._model && s._model.xform;               // the transform gizmo's move / turn / scale (view only)
    return mat4.mul(this.playerRoot, X ? mat4.mul(X, s.world) : s.world);
  }
  // A model's view-only transform from the gizmo (main.js / gizmo.js), in the character's own space, about the pivot c:
  // X = T(c + t) R S T(-c). xf = { t: [x, y, z], r: 3 x 3 rotation (column-major), s: [sx, sy, sz], c: [x, y, z] } or
  // null. Nothing of it reaches the NIF.
  setModelXform(model, xf) {
    model.xf = xf || null;
    if (!xf) model.xform = null;
    else {
      const { t, r, s, c } = xf, M = new Float32Array(16);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) M[j * 4 + i] = r[j * 3 + i] * s[j];
      for (let i = 0; i < 3; i++) M[12 + i] = c[i] + t[i] - (M[i] * c[0] + M[4 + i] * c[1] + M[8 + i] * c[2]);
      M[15] = 1;
      model.xform = M;
    }
    this.version++; this.geomVersion++;
  }
  set env(e) { this._env = e; this.version++; }

  // ---------------------------------------------------------------------------------------------------- programs
  buildPrograms() {
    const P = (name, vs, fs, defs, samplers) => this.program(vs, fs, name, defs, samplers, true);
    const two = (f) => [f(0), f(1)];
    const LIT = { uDiffuse: 0, uNormalTex: 1, uSpecTex: 2, uGlowTex: 3, uPalette: 4, uEnvTex: 5, uAO: AO_UNIT, uLightGrid: LIGHT_UNIT,
      uLightShadow: LS_UNIT, uShadowMap: 14, uShadowMap2: 15 };
    const FX = { uBase: 0, uNormalTex: 1, uEnvMask: 2, uPalette: 4, uEnvTex: 5, uSceneDepth: 6, uShadowMap: 14, uShadowMap2: 15 };
    const LAND = { uLD0: 0, uLD1: 1, uLD2: 2, uLD3: 3, uLN0: 4, uLN1: 5, uLN2: 6, uLN3: 8, uLS0: 9, uLS1: 10, uLS2: 11,
      uLS3: 12, uAO: AO_UNIT, uLightGrid: LIGHT_UNIT, uShadowMap: 14, uShadowMap2: 15 };
    this.progs = {
      lit: two(sk => two(cl => P(`lit${sk}${cl}`, S.MESH_VS, S.LIGHTING_FS, { SKINNED: sk, CLIP: cl, LIGHT_SHADOWS: 1 }, LIT))),
      fx: two(sk => P(`fx${sk}`, S.MESH_VS, S.EFFECT_FS, { SKINNED: sk, CLIP: 1 }, FX)),
      land: P('land', S.LAND_VS, S.LAND_FS, { SKINNED: 0, CLIP: 0, LIGHT_SHADOWS: 0 }, LAND),
      refr: two(sk => P(`refr${sk}`, S.MESH_VS, S.REFRACT_FS, { SKINNED: sk, CLIP: 0 }, { uScene: 0, uNormalTex: 1 })),
      shadow: two(sk => two(cl => P(`shadow${sk}${cl}`, S.SHADOW_VS, S.SHADOW_FS, { SKINNED: sk, CLIP: cl }, { uDiffuse: 0 }))),
      probe: two(sk => P(`probe${sk}`, S.SHADOW_VS, S.PROBE_FS, { SKINNED: sk, CLIP: 0 }, {})),
      sky: P('sky', S.SKY_VS, S.SKY_FS, {}, { uSkyLut: 0 }),
      bright: P('bright', S.FULLSCREEN_VS, S.BRIGHT_FS, {}, { uSrc: 0 }),
      blur: P('blur', S.FULLSCREEN_VS, S.BLUR_FS, {}, { uSrc: 0 }),
      tone: P('tone', S.FULLSCREEN_VS, S.TONEMAP_FS, {}, { uScene: 0, uBloom: 1, uLut0: 2, uLut1: 3, uAdapt: 4, uCover: 5 }),
      lum: P('lum', S.FULLSCREEN_VS, S.LUM_FS, {}, { uSrc: 0 }),
      adapt: P('adapt', S.FULLSCREEN_VS, S.ADAPT_FS, {}, { uLum: 0, uPrev: 1 }),
      taa: P('taa', S.FULLSCREEN_VS, S.TAA_FS, {}, { uCur: 0, uHist: 1, uVel: 2 }),
      // §21 ambient occlusion: depth of the solid scene, occlusion, blur
      prez: two(sk => two(cl => P(`prez${sk}${cl}`, S.MESH_VS, S.PREZ_FS, { SKINNED: sk, CLIP: cl }, { uDiffuse: 0 }))),
      prezLand: P('prezLand', S.LAND_VS, S.PREZ_FS, { SKINNED: 0, CLIP: 0 }, {}),
      sao: P('sao', S.FULLSCREEN_VS, S.SAO_FS, {}, { uDepth: 0 }),
      saoBlur: P('saoBlur', S.FULLSCREEN_VS, S.SAO_BLUR_FS, {}, { uDepth: 0, uAOin: 1 }),
      // §22 projected decals: the lit body on the scene surface found inside each decal's box
      godrays: P('godrays', S.FULLSCREEN_VS, S.GODRAYS_FS, { LIGHT_SHADOWS: 1 }, { uDepth: 0, uFarMap: 2, uLightShadow: 3, uShadowMap: 14, uShadowMap2: 15 }),
      godraysBlur: P('godraysBlur', S.FULLSCREEN_VS, S.GODRAYS_BLUR_FS, {}, { uSrc: 0 }),
      godraysApply: P('godraysApply', S.FULLSCREEN_VS, S.GODRAYS_APPLY_FS, {}, { uSrc: 0, uDepth: 1 }),
      decal: P('decal', S.DECAL_VS, S.DECAL_FS, { SKINNED: 0, CLIP: 1, LIGHT_SHADOWS: 1 }, { ...LIT, uSceneDepth: 6 }),
      // §23 the shadow maps of placed lights
      lsCast: two(sk => two(cl => P(`lscast${sk}${cl}`, S.LSHADOW_VS, S.LSHADOW_FS, { SKINNED: sk, CLIP: cl }, { uDiffuse: 0 }))),
    };
    // Every program is handed to the driver here and its link result read only when it is first used (useProg):
    // with parallel compilation (KHR_parallel_shader_compile) the driver works on all of them at once, the page goes
    // on meanwhile, and programs a session never draws with (a studio session: the landscape, decals, light shafts,
    // light-shadow casters...) never make it wait. The Frame block layout is checked when the main program is ready.
    const lit = this.progs.lit[0][0], f = lit._finish;
    lit._finish = () => { f(); this.checkFrameLayout(lit); };
  }
  // the click-selection and outline programs, handed to the driver ahead of their first use (main.js, once the
  // start-up scene is up); else created on the first click
  prewarmPrograms() {
    const P = (vs, fs, name, defs, samplers) => this.program(vs, fs, name, defs, samplers, true);
    if (!this.progs.pick) {
      const pk = (sk, cl) => P(S.PICK_VS, S.PICK_FS, `pick${sk}${cl}`, { SKINNED: sk, CLIP: cl }, { uDiffuse: 0 });
      this.progs.pick = [[pk(0, 0), pk(0, 1)], [pk(1, 0), pk(1, 1)]];
    }
    if (!this.progs.wire) this.progs.wire = [0, 1].map(sk => P(S.MESH_VS, S.WIRE_FS, `wire${sk}`, { SKINNED: sk, CLIP: 0 }, { uSceneDepth: 6 }));
  }

  // lazy: the link status, block bindings and sampler units are applied by useProg before the program's first use
  program(vsSrc, fsSrc, name, defs = {}, samplers = {}, lazy = false) {
    const gl = this.gl;
    const head = `#version 300 es\n#define MAX_BONES ${this.maxBones}\n#define MAX_LIGHTS ${MAX_LIGHTS}\n#define LS_MAX ${LS_MAX}\n#define LS_LAYERS ${LS_LAYERS}\n#define LS_SIZE ${LS_SIZE}\n` +
      Object.entries(defs).map(([k, v]) => `#define ${k} ${v}\n`).join('');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src.replace('#version 300 es\n', head)); gl.compileShader(s); return s; };
    const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    p._loc = {}; p._name = name;
    const finish = () => {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const logs = [vs, fs].map(s => gl.getShaderInfoLog(s)).filter(Boolean).join('\n');
        throw new Error(`${name} shader: ${gl.getProgramInfoLog(p)}\n${logs}`);
      }
      for (const [b, i] of Object.entries(BIND)) {
        const k = gl.getUniformBlockIndex(p, b);
        if (k !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, k, i);
      }
      gl.useProgram(p);        // sampler units are fixed per program, set once
      for (const [n, u] of Object.entries(samplers)) { const l = gl.getUniformLocation(p, n); if (l) gl.uniform1i(l, u); }
    };
    if (lazy) p._finish = finish; else finish();
    return p;
  }
  // the CPU-side Frame offsets must match the GLSL block (std140); a mismatch would light everything wrongly
  checkFrameLayout(p) {
    const gl = this.gl;
    const names = ['uProj', 'uCamPos', 'uAmbRow[0]', 'uFlags', 'uTint', 'uRes', 'uCluster', 'uClusterI'];
    const want = [FR.proj, FR.cam, FR.amb, FR.flags, FR.tint, FR.res, FR.cluster, FR.clusterI];
    const idx = gl.getUniformIndices(p, names);
    const off = gl.getActiveUniforms(p, idx, gl.UNIFORM_OFFSET);
    names.forEach((n, i) => { if (idx[i] !== gl.INVALID_INDEX && off[i] !== want[i] * 4) console.error(`Frame block: ${n} at ${off[i]}, expected ${want[i] * 4}`); });
  }
  U(p, n) { if (!(n in p._loc)) p._loc[n] = this.gl.getUniformLocation(p, n); return p._loc[n]; }
  u1f(p, n, v) { const l = this.U(p, n); if (l) this.gl.uniform1f(l, v); }
  u1i(p, n, v) { const l = this.U(p, n); if (l) this.gl.uniform1i(l, v); }
  u2f(p, n, a, b) { const l = this.U(p, n); if (l) this.gl.uniform2f(l, a, b); }
  u3f(p, n, v) { const l = this.U(p, n); if (l) this.gl.uniform3f(l, v[0], v[1], v[2]); }
  u4f(p, n, v) { const l = this.U(p, n); if (l) this.gl.uniform4f(l, v[0], v[1], v[2], v[3]); }
  um4(p, n, m) { const l = this.U(p, n); if (l) this.gl.uniformMatrix4fv(l, false, m); }

  // ---------------------------------------------------------------------------------------------------- GL state
  // A frame (and each depth probe) starts from known state; the caches below then skip calls that change nothing.
  resetState() {
    const gl = this.gl;
    this._tex = []; this._prog = null; this._vao = null; this._matBound = null; this._bonesBound = null; this._cv = [];
    this._st = {};
    gl.cullFace(gl.BACK); gl.frontFace(gl.CCW); gl.depthFunc(gl.LEQUAL);
  }
  useProg(p) {
    if (this._prog !== p) {
      if (p._finish) { const f = p._finish; p._finish = null; f(); }      // first use (buildPrograms)
      this.gl.useProgram(p); this._prog = p;
    }
  }
  // cube: true for a cube map, 'array' for a 2D array (each target keeps its own binding on a unit)
  bindUnit(unit, tex, cube = false) {
    const kind = cube === 'array' ? 2 : cube ? 1 : 0, k = unit * 3 + kind;
    if (this._tex[k] === tex) return;
    this._tex[k] = tex;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture([gl.TEXTURE_2D, gl.TEXTURE_CUBE_MAP, gl.TEXTURE_2D_ARRAY][kind], tex);
  }
  setCull(on) {
    if (this._st.cull === on) return;
    this._st.cull = on; on ? this.gl.enable(this.gl.CULL_FACE) : this.gl.disable(this.gl.CULL_FACE);
  }
  setBlend(on, src = 0, dst = 0) {
    const gl = this.gl;
    if (this._st.blend !== on) { this._st.blend = on; on ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND); }
    // alpha: "over" coverage (1 where a model covers the pixel, 0 for the sky / floor of a backdrop scene), whatever
    // the colour's blend; TONEMAP_FS reads it to lay the backdrop behind the models
    if (on && (this._st.src !== src || this._st.dst !== dst)) {
      this._st.src = src; this._st.dst = dst; gl.blendFuncSeparate(src, dst, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }
  setDepthTest(on) {
    if (this._st.dtest === on) return;
    this._st.dtest = on; on ? this.gl.enable(this.gl.DEPTH_TEST) : this.gl.disable(this.gl.DEPTH_TEST);
  }
  setDepthMask(on) { if (this._st.dmask !== on) { this._st.dmask = on; this.gl.depthMask(on); } }
  // decals: pulled a little towards the camera so they win the depth test against the surface they lie on (the game
  // draws them with a depth bias); without it they flicker with it as the view moves
  // 'shadow': shadow casters pushed away from the sun, more on surfaces seen edge-on by it (slope-scaled), so lit
  // surfaces do not shadow themselves in a pattern that crawls as they move
  setOffset(on) {
    if (this._st.offset === on) return;
    const gl = this.gl;
    this._st.offset = on;
    if (!on) { gl.disable(gl.POLYGON_OFFSET_FILL); return; }
    gl.enable(gl.POLYGON_OFFSET_FILL);
    if (on === 'shadow') gl.polygonOffset(1.5, 4); else gl.polygonOffset(-1, -2);
  }
  // constant values for attributes a shape lacks are context state (not VAO state): set only when they differ
  constAttrib(c) {
    const [loc, x, y, z, w] = c, v = this._cv[loc];
    if (v && v[0] === x && v[1] === y && v[2] === z && v[3] === w) return;
    this._cv[loc] = [x, y, z, w];
    this.gl.vertexAttrib4f(loc, x, y, z, w);
  }

  // ---------------------------------------------------------------------------------------------------- per-draw data
  // Model matrices of one pass, in draw order; each draw reads `count` of them from `base` (instanced attributes)
  instBuffer() { return { buf: this.gl.createBuffer(), data: new Float32Array(16 * 512), n: 0 }; }
  pushInst(ib, m) {
    if ((ib.n + 1) * 16 > ib.data.length) { const d = new Float32Array(ib.data.length * 2); d.set(ib.data); ib.data = d; }
    ib.data.set(m, ib.n * 16);
    return ib.n++;
  }
  uploadInst(ib) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, ib.buf);
    gl.bufferData(gl.ARRAY_BUFFER, ib.data, gl.DYNAMIC_DRAW, 0, Math.max(16, ib.n * 16));
  }
  // with a VAO bound: attributes 8-11 are the instance's model matrix columns
  instAttribs() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst.main.buf);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(8 + k); gl.vertexAttribPointer(8 + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(8 + k, 1);
    }
  }
  drawInstanced(s, ib, base, count) {
    const gl = this.gl;
    if (this._vao !== s.vao) { gl.bindVertexArray(s.vao); this._vao = s.vao; }
    if (s.consts) for (const c of s.consts) this.constAttrib(c);
    // the instance pointers are VAO state: set only when this VAO points elsewhere (the pre-pass and the main pass draw
    // most shapes from the same buffer and offset). Kept on the VAO: twins share it. A buffer re-filled by bufferData
    // stays the same buffer object, so the pointer stays valid. Anything else that points 8-11 must update _ib / _o.
    const v = s.vao, o = base * 64;
    if (v._ib !== ib.buf || v._o !== o) {
      gl.bindBuffer(gl.ARRAY_BUFFER, ib.buf);
      gl.vertexAttribPointer(8, 4, gl.FLOAT, false, 64, o); gl.vertexAttribPointer(9, 4, gl.FLOAT, false, 64, o + 16);
      gl.vertexAttribPointer(10, 4, gl.FLOAT, false, 64, o + 32); gl.vertexAttribPointer(11, 4, gl.FLOAT, false, 64, o + 48);
      v._ib = ib.buf; v._o = o;
    }
    gl.drawElementsInstanced(gl.TRIANGLES, s.count, s.indexType || gl.UNSIGNED_INT, 0, count);
  }
  // one material block slot per shape (256-byte aligned ranges in shared buffers), uploaded only when it changes
  bindMaterial(s, data) {
    const gl = this.gl;
    let M = s._matSlot;
    if (!M) {
      if (!this._matFree.length) {
        const buf = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
        gl.bufferData(gl.UNIFORM_BUFFER, 256 * this.matSlot, gl.DYNAMIC_DRAW);
        for (let i = 255; i >= 0; i--) this._matFree.push({ buf, off: i * this.matSlot });
      }
      const f = this._matFree.pop();
      M = s._matSlot = { buf: f.buf, off: f.off, data: null };
    }
    let same = !!M.data;
    if (same) for (let i = 0; i < MAT_FLOATS; i++) if (M.data[i] !== data[i]) { same = false; break; }
    if (!same) {
      M.data = M.data || new Float32Array(MAT_FLOATS);
      M.data.set(data);
      gl.bindBuffer(gl.UNIFORM_BUFFER, M.buf); gl.bufferSubData(gl.UNIFORM_BUFFER, M.off, data);
    }
    if (this._matBound !== M) { this._matBound = M; gl.bindBufferRange(gl.UNIFORM_BUFFER, BIND.Material, M.buf, M.off, this.matSlot); }
  }
  bindBones(k) {
    if (this._bonesBound === k) return;
    this._bonesBound = k;
    this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, BIND.Bones, k.ubo);
    this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, BIND.BonesPrev, this.settings.taa && k.uboPrev ? k.uboPrev : k.ubo);
  }
  // the mesh shaders' uPrevDelta: last frame's placement from this one's. A character-group shape keeps its own (it.pd,
  // shapePrevDelta): the player walks and turns in game mode, and rigid parts move by themselves (spinning fans, worn
  // pieces hung on a posed bone); cell objects and the ground do not move (identity)
  setPrevDelta(it) {
    const p = this._prog, m = it.pd || IDENTITY;
    if (p._pd !== m) { p._pd = m; this.um4(p, 'uPrevDelta', m); }
  }
  // uReactive: 1 when the shape's texture placement or fade changed since the last frame (flipbooks, scrolling or
  // fading textures): the picture changes with no motion for TAA to follow (TAA_FS then trusts this frame there)
  setReactive(s) {
    let r = 0;
    const lv = s.live;
    if (this.settings.taa && s.isParticles) r = 1;              // particles: new every frame, nothing to follow
    else if (this.settings.taa && lv) {
      if (s._rkFrame !== this.frameNo) {
        const k = s._rk || (s._rk = [NaN, NaN, NaN, NaN, NaN]), v = [lv.u_offset, lv.v_offset, lv.u_scale, lv.v_scale, lv.alpha];
        s._react = !isNaN(k[0]) && v.some((x, i) => x !== k[i]) ? 1 : 0;
        for (let i = 0; i < 5; i++) k[i] = v[i];
        s._rkFrame = this.frameNo;
      }
      r = s._react;
    }
    const p = this._prog;
    if (p._react !== r) { p._react = r; this.u1f(p, 'uReactive', r); }
  }
  shapePrevDelta(s, W) {
    s._prevWNext = W;
    if (!this.settings.taa) return IDENTITY;
    return s._prevW ? mat4.mul(s._prevW, mat4.invert(W)) : this._prevDelta;
  }
  freeShape(s) {
    const gl = this.gl;
    gl.deleteVertexArray(s.vao);
    for (const b of s._bufs || []) gl.deleteBuffer(b);
    if (s._matSlot) { this._matFree.push({ buf: s._matSlot.buf, off: s._matSlot.off }); s._matSlot = null; }
    if (s.skinData && s.skinData.ubo) { gl.deleteBuffer(s.skinData.ubo); s.skinData.ubo = null; }
    if (s.skinData && s.skinData.uboPrev) { gl.deleteBuffer(s.skinData.uboPrev); s.skinData.uboPrev = null; }
    if (s._wireIB) { gl.deleteBuffer(s._wireIB); s._wireIB = null; }
  }

  // lit material block (shaders.js LIT_MATERIAL); the landscape fills it with its calibrated constants
  litMaterial(s, o, isGround = false) {
    const m = s.mat, a = m.alpha || {}, lv = s.live, T = s.tex, land = m.kind === 'land';
    o[0] = lv.u_offset; o[1] = lv.v_offset; o[2] = lv.u_scale; o[3] = lv.v_scale;
    o[4] = lv.alpha; o[5] = a.test ? 1 : 0; o[6] = (a.ref ?? 128) / 255; o[7] = a.blend ? 1 : 0;
    // vertex colours: rgb^2.2 x albedo; their alpha x the material alpha with the Vertex Alpha flag, and on BLENDED
    // surfaces with vertex colours too: the eyes' tear film and the hairline layer fade only through their vertex alpha
    // (no flag). Not on alpha-tested ones: foliage keeps other data there (applied, grass and branches vanish)
    o[8] = m.vertex_colors ? 1 : 0; o[9] = m.vertex_alpha || (m.vertex_colors && a.blend) ? 1 : 0; o[10] = land || T.normal ? 1 : 0; o[11] = land || T.spec ? 1 : 0;
    o[12] = !land && T.glow ? 1 : 0; o[13] = !land && m.env_mapping && T.env ? 1 : 0;
    o[14] = !land && m.greyscale && T.palette ? 1 : 0; o[15] = land || m.specular_enabled !== false ? 1 : 0;
    o[16] = lv.specular_mult; o[17] = lv.smoothness; o[18] = lv.env_mask_scale; o[19] = m.greyscale_scale ?? 0;
    const ec = lv.emit_color || [0, 0, 0], em = lv.emit_mult;
    o[20] = lin1(ec[0]) * em; o[21] = lin1(ec[1]) * em; o[22] = lin1(ec[2]) * em; o[23] = !land && m.emit_enabled ? 1 : 0;
    const tintable = m.skin_tint || m.shader_type === 'SkinTint' || m.shader_type === 'FaceTint';
    o[24] = land ? 0 : (m.backlight ?? 0); o[25] = land ? 0 : (m.wrap ?? 0); o[26] = m.glowmap ? 1 : 0; o[27] = !land && tintable ? 1 : 0;
    o[28] = isGround && this.settings.debug < 5 ? 0 : this.settings.debug;
    o[29] = land || !a.blend || isDecal(m) ? 1 : 0;   // §21 a deferred surface in the game (its occlusion applies); o[30] = o[31] = 0
    o[30] = 0; o[31] = 0;
  }
  fxMaterial(s, o) {
    const m = s.mat, a = m.alpha || {}, lv = s.live, T = s.tex;
    o[0] = lv.u_offset; o[1] = lv.v_offset; o[2] = lv.u_scale; o[3] = lv.v_scale;
    o[4] = lv.alpha; o[5] = a.test ? 1 : 0; o[6] = (a.ref ?? 128) / 255; o[7] = a.blend ? 1 : 0;
    const bc = lv.emit_color || m.base_color;
    o[8] = lin1(bc[0]); o[9] = lin1(bc[1]); o[10] = lin1(bc[2]); o[11] = m.base_color[3] ?? 1;
    o[12] = lv.emit_mult; o[13] = T.base ? 1 : 0; o[14] = T.palette ? 1 : 0; o[15] = m.greyscale_color ? 1 : 0;
    o[16] = m.greyscale_alpha ? 1 : 0; o[17] = m.vertex_colors ? 1 : 0; o[18] = m.falloff_enabled ? 1 : 0; o[19] = m.lighting_influence ?? 0;
    o[20] = lv.falloff_start_angle; o[21] = lv.falloff_stop_angle; o[22] = lv.falloff_start_opacity; o[23] = lv.falloff_stop_opacity;
    o[24] = m.effect_lighting ? 1 : 0; o[25] = m.env_mapping && T.env ? 1 : 0; o[26] = lv.env_mask_scale; o[27] = T.normal ? 1 : 0;
    o[28] = T.envmask ? 1 : 0; o[29] = m.soft && a.blend ? 1 : 0; o[30] = m.soft_depth || 100;
    o[31] = s.isParticles ? 1 : 0;      // particles: the palette rows follow the particle's colour (EFFECT_FS)
  }
  refrMaterial(s, o) {
    const m = s.mat, lv = s.live;
    o.fill(0);
    o[0] = lv.u_offset; o[1] = lv.v_offset; o[2] = lv.u_scale; o[3] = lv.v_scale;
    o[4] = lv.refraction ?? m.refraction_strength ?? 0; o[5] = s.tex.normal || s.tex.diffuse ? 1 : 0; o[6] = m.vertex_alpha ? 1 : 0;
  }

  // ---------------------------------------------------------------------------------------------------- textures
  // opts: clamp (edge clamp), lookup (palette/LUT: no anisotropy), srgb (colour data: sRGB view, §2), vanilla (archived copy)
  // opts.tag: the file's tag after an edit (Reload textures & materials): a new address, so no cached copy answers
  texture(path, opts = {}) {
    if (!path) return Promise.resolve(null);
    const key = path.toLowerCase() + (opts.clamp ? '|c' : '') + (opts.lookup ? '|l' : '') + (opts.srgb ? '|s' : '') + (opts.vanilla ? '|v' : '');
    if (!this.texCache.has(key)) {          // vanilla: the archived copy, never a loose override (a body mod's textures)
      const p = fetch('/api/file?path=' + encodeURIComponent(path) + (opts.vanilla ? '&vanilla=1' : '') + '&g=' + dataGen +
        (opts.tag ? '&t=' + encodeURIComponent(opts.tag) : '')).then(async r => {
        if (!r.ok) throw new Error(`missing texture ${path}`);
        const gl = this.gl;
        const o = { lookup: opts.lookup, srgb: opts.srgb, maxSize: opts.lookup ? 0 : this.quality.texCap };
        if (opts.clamp) { o.wrapS = gl.CLAMP_TO_EDGE; o.wrapT = gl.CLAMP_TO_EDGE; }
        const t = uploadDDS(gl, await r.arrayBuffer(), o);
        t.info.path = path;
        t.info.tag = (r.headers.get('ETag') || '').replace(/"/g, '');      // where it came from (size + date)
        this.version++;
        return t;
      }).catch(e => { console.warn(e.message); this.onWarn && this.onWarn(e.message); return null; });
      p.then(t => { p._t = t; });            // the resolved texture (null: missing), for sweepTextures
      this.texCache.set(key, p);
      return p;
    }
    const p = this.texCache.get(key);
    p._idle = 0;                             // asked for again: in use
    return p;
  }
  // The texture cache would keep every texture ever loaded on the GPU (0.3-1.5 GB per exterior visited). A sweep
  // (deferred after a cell opens or unloads, a model or the reference is removed) frees the oldest textures nothing
  // draws any more, while those exceed keepBytes (a revisit within that budget needs no new upload; one beyond it
  // loads the same file again). In use: every shape of the models, the before / after twins, the cell's templates,
  // particles, landscape layers, decals, the studio floor and the LUTs. A texture must be found unused by two sweeps
  // at least TEX_GRACE apart (a caller may hold one it has just been given while it waits for the next), and none is
  // freed while applyMaterial is collecting a material's textures; loading and missing entries are never touched.
  // textures still on their way (main.js: the preview renderers wait for the view)
  texturesLoading() {
    for (const p of this.texCache.values()) if (p._t === undefined) return true;
    return false;
  }
  scheduleSweep(ms = 2000) {
    clearTimeout(this._sweepTimer);
    this._sweepTimer = setTimeout(() => this.sweepTextures(), ms);
  }
  sweepTextures(keepBytes = this.quality.texKeep) {
    if (this._texHold) { this.scheduleSweep(); return 0; }
    const used = new Set();
    const shapeTex = (s) => { for (const k in s.tex) if (s.tex[k]) used.add(s.tex[k]); };
    const modelTex = (m) => { for (const s of m.shapes) shapeTex(s); for (const p of m.psys || []) shapeTex(p.shape); };
    for (const m of this.models) modelTex(m);
    for (const m of this.extraModels) modelTex(m);
    if (this.compare) for (const t of this.compare.twins.values()) for (const s of t.shapes) shapeTex(s);
    for (const m of this.cellTemplates) modelTex(m);
    for (const p of this.cellPsys) shapeTex(p.shape);
    for (const q of this.lands) for (const L of q.layerTex) for (const k in L) if (L[k]) used.add(L[k]);
    for (const d of this.decalSets) shapeTex(d.s);
    shapeTex(this.ground);
    for (const t of (this._lutCache || new Map()).values()) if (t) used.add(t);
    const now = performance.now(), idle = [];
    let idleBytes = 0;
    for (const [key, p] of this.texCache) {
      const t = p._t;
      if (!t) continue;
      if (used.has(t)) { p._idle = 0; continue; }
      if (!p._idle) { p._idle = 1; p._idleAt = now; } else p._idle++;
      idleBytes += t.info.bytes || 0;
      if (p._idle >= 2 && now - p._idleAt >= TEX_GRACE) idle.push([key, p._idleAt, t]);
    }
    idle.sort((a, b) => a[1] - b[1]);
    let freed = 0;
    for (const [key, , t] of idle) {
      if (idleBytes <= keepBytes) break;
      this.texCache.delete(key);
      this.gl.deleteTexture(t.tex);
      idleBytes -= t.info.bytes || 0;
      freed++;
    }
    return freed;
  }

  // ---------------------------------------------------------------------------------------------------- models
  addModel(scene, opts = {}) {
    const gl = this.gl;
    const model = { scene, name: scene.name, visible: true, role: opts.role || 'main', nodes: new Map(), shapes: [],
      controllers: scene.controllers || [], bbox: scene.bbox };
    // "Prn": the game hangs this model's root on a skeleton bone (rigid worn parts, e.g. spinning fans)
    if (scene.attach_bone && !opts.template) model.attach = scene.attach_bone.toLowerCase();
    for (const n of scene.nodes) model.nodes.set(n.block, { ...n, base: new Float32Array(n.local), local: new Float32Array(n.local), world: null });
    model.nodeByName = new Map([...model.nodes.values()].map(n => [n.name, n]));
    model.sequences = scene.sequences || [];
    // Havok cloth (coats, dangling pouches, keychains): simulated by cloth.js, its bones override the bind pose
    if (scene.cloth && scene.cloth.length && !opts.template) {
      model.cloth = [];
      for (const c of scene.cloth) {
        try { model.cloth.push(new Cloth(c)); } catch (e) { console.warn(e); this.onWarn && this.onWarn(`${scene.name}: cloth ${c.name}: ${e.message}`); }
      }
      model.clothPose = new Map();
      model.nodeByLname = new Map([...model.nodes.values()].map(n => [n.name.toLowerCase(), n]));
    }
    model.activeSeq = model.sequences.find(q => /idle|loop|default|special/i.test(q.name)) || null;
    model.liveControllers = model.controllers.some(c => (c.flags & 8) && c.interp && c.interp.kind !== 'unsupported');
    for (const s of scene.shapes) {
      // vertex data as the NIF stores it (server scene.py put_compact): half-float positions (4 per vertex) and UVs,
      // byte normals / bitangents / tangents (0..1, the shader maps them to -1..1), 16-bit weights and indices
      const F = s.fmt || {}, idx16 = F.idx === 'u16';
      const idx = b64(s.indices, idx16 ? Uint16Array : Uint32Array);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const bufs = [], attrs = [];
      // every attribute of the shape in one vertex buffer, one after another (each at a 4-byte aligned offset, read
      // with the same size / type / normalisation as from a buffer of its own): one GL buffer per shape instead of up
      // to eight
      const buf = (loc, data, size, type = gl.FLOAT, norm = false) => attrs.push([loc, data, size, type, norm]);
      const unit = (b) => F.nrm === 'u8x4' ? [b64(b, Uint8Array), 4, gl.UNSIGNED_BYTE, true]
        : [b64(b, Float32Array).map(v => (v + 1) * 0.5), 3, gl.FLOAT, false];          // older float payloads
      // constant values for missing attributes are global GL state (not VAO state): applied at draw time
      const consts = [];
      if (F.pos === 'f2x4') buf(0, b64(s.position, Uint16Array), 4, gl.HALF_FLOAT); else buf(0, b64(s.position, Float32Array), 3);
      if (s.normal) buf(1, ...unit(s.normal)); else consts.push([1, 0.5, 0.5, 1, 0]);
      if (s.dpdu) { buf(2, ...unit(s.dpdu)); buf(3, ...unit(s.dpdv)); }
      else consts.push([2, 0.5, 0.5, 0.5, 0], [3, 0.5, 0.5, 0.5, 0]);
      if (s.uv) { if (F.uv === 'f2x2') buf(4, b64(s.uv, Uint16Array), 2, gl.HALF_FLOAT); else buf(4, b64(s.uv, Float32Array), 2); }
      else consts.push([4, 0, 0, 0, 0]);
      if (s.color) buf(5, b64(s.color, Uint8Array), 4, gl.UNSIGNED_BYTE, true); else consts.push([5, 1, 1, 1, 1]);
      let skin = null;
      if (s.skinned && s.skin) {
        if (F.w === 'u16x4') buf(6, b64(s.skin.weights, Uint16Array), 4, gl.UNSIGNED_SHORT, true);
        else buf(6, b64(s.skin.weights, Float32Array), 4);
        buf(7, b64(s.skin.index, Uint8Array), 4, gl.UNSIGNED_BYTE, false);
        const n = s.skin.bones.length;
        const ubo = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, this.maxBones * 64, gl.DYNAMIC_DRAW);
        // uboPrev: last frame's palette (TAA motion vectors); ver / prevVer: which palette each block holds
        const uboPrev = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, uboPrev); gl.bufferData(gl.UNIFORM_BUFFER, this.maxBones * 64, gl.DYNAMIC_DRAW);
        skin = { names: s.skin.bones, lnames: s.skin.bones.map(x => x.toLowerCase()),
          s2b: s.skin.skin_to_bone.map(a => new Float32Array(a)), bind: s.skin.bind_world.map(a => new Float32Array(a)),
          mats: new Float32Array(n * 16), ubo, uboPrev, ver: 0, prevVer: -1, used: 0 };
        if (n > this.maxBones) this.onWarn && this.onWarn(`${s.name}: ${n} bones exceed this GPU's skinning limit (${this.maxBones})`);
      } else consts.push([6, 0, 0, 0, 0], [7, 0, 0, 0, 0]);
      let bytes = 0;
      for (const a of attrs) { a.push(bytes); bytes += (a[1].byteLength + 3) & ~3; }
      const all = new Uint8Array(bytes);
      for (const [, d, , , , off] of attrs) all.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), off);
      const vb = gl.createBuffer(); bufs.push(vb); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW);
      for (const [loc, , size, type, norm, off] of attrs) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, off); }
      this.instAttribs();
      const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const m = s.material || { kind: 'none' };
      // the shape without its vertex payload, built without `delete` (a deleted key turns the object into a slow
      // dictionary, and the draw loops read ~20 of its fields per draw)
      const { position, indices, normal, uv, dpdu, dpdv, color, skin: skinIn, ...rest } = s;
      // _idxData: the indices for the selection outline (buildWire); a cell template's are read back from the GPU on
      // the rare selection instead of keeping a copy of every template's indices
      const shape = { ...rest, vao, consts, skinData: skin, count: idx.length, indexType: idx16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
        _idxData: opts.template ? null : idx, _ib: ib, mat: m, live: liveValues(m),
        tex: {}, visible: !s.hidden, vanilla: !!scene.vanilla, _template: !!opts.template,
        center: [(s.bbox[0][0] + s.bbox[1][0]) / 2, (s.bbox[0][1] + s.bbox[1][1]) / 2, (s.bbox[0][2] + s.bbox[1][2]) / 2],
        localM: s.local ? new Float32Array(s.local) : null, world: mat4.identity(), _bufs: bufs };
      // the vertex payload is on the GPU now: model.scene keeps only its bbox / deps / names (a cell's templates and
      // LOD chunks held tens of MB of base64 strings otherwise)
      for (const k of PAYLOAD) delete s[k];
      this.loadShapeTextures(shape);
      model.shapes.push(shape);
    }
    // particle systems (particles.js): one simulation per system; a cell template's get one per placement
    // (placeInstances)
    const psysDefs = (scene.particles || []).filter(d => !d.hidden);
    if (opts.template) model.psysDefs = psysDefs;
    else model.psys = psysDefs.map(d => this.newPsys(d, model, null));
    if (!opts.template) { this.models.push(model); for (const sh of model.shapes) { sh._player = true; sh._model = model; } }
    this.updateTransforms(model);
    this.version++;
    return model;
  }

  loadShapeTextures(shape) {
    const m = shape.mat;
    for (const [k, p] of this.texturesFor(m, shape.vanilla)) p.then(r => {
      shape.tex[k] = r; this.version++;
      // alpha-tested shadow casters (the batch exists: placeInstances ran synchronously after addTemplate): the maps
      // that drew one with the white stand-in are drawn again as a whole (casterRetexture); one no map drew yet is
      // simply drawn later
      if (shape._template && k === 'diffuse' && m.alpha?.test) this.cellTouched();
      if (shape._template && k === 'diffuse' && m.alpha?.test && (this._casterAnim || (shape._batch && this.isCaster(shape._batch)))) {
        if (this._casterAnim || !(shape._batch._addAt >= 0)) this.casterEpoch();
        else if (shape._batch._addAt < this.casterLog().seen) this.casterRetexture(shape._batch);
        else this.cellVersion++;
      }
    });
  }
  // [[slot, promise of the texture]] a material reads
  texturesFor(m, vanilla) {
    const t = m.textures || {}, out = [];
    const clamp = m.tile_u === false && m.tile_v === false;
    const set = (k, p, o) => out.push([k, this.texture(p, { ...o, vanilla })]);
    if (m.kind === 'lighting') {
      set('diffuse', t.diffuse, { clamp, srgb: true });
      set('normal', t.normal, { clamp }); set('spec', t.smoothspec, { clamp });
      if (m.glowmap || m.emit_enabled) set('glow', t.glow, { clamp, srgb: true });
      if (m.greyscale) set('palette', t.greyscale, { clamp: true, lookup: true, srgb: true });
      if (m.env_mapping) set('env', t.envmap, { srgb: true });
    } else if (m.kind === 'effect') {
      set('base', t.base, { clamp, srgb: true });
      if (m.greyscale_color || m.greyscale_alpha) set('palette', t.greyscale, { clamp: true, lookup: true, srgb: true });
      if (m.env_mapping) {
        set('env', t.envmap, { srgb: true }); set('normal', t.normal, { clamp }); set('envmask', t.envmask, { clamp });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------- before / after
  // Reload textures & materials (main.js) keeps a changed model's previous look as its "before" twin: its shapes with
  // the old material and textures, sharing the geometry, bones and placement (twin.shapes[i]._of = the live shape), or
  // the whole old model when the NIF itself changed (twin.whole, posed with the live one). compare: { split (0..1, before
  // on the left), peek (all before), twins: Map(model -> twin) }.
  twinShapes(model) {
    return { shapes: model.shapes.map(s => ({ ...s, tex: { ...s.tex }, _matSlot: null, _of: s, _twin: true })) };
  }
  setTwin(model, twin) {
    const cmp = this.compare || (this.compare = { split: 0.5, peek: false, twins: new Map() });
    const old = cmp.twins.get(model);
    cmp.twins.set(model, twin);
    if (old && old !== twin) this.freeTwin(old);
    this.extraModels = [...cmp.twins.values()].filter(t => t.whole).map(t => t.whole);
    this._taaReset = true; this.version++;
  }
  // the live model was replaced by a reloaded one (a NIF changed): its twin follows it
  moveTwin(from, to) {
    const cmp = this.compare, t = cmp && cmp.twins.get(from);
    if (!t) return;
    cmp.twins.delete(from); cmp.twins.set(to, t);
  }
  endCompare() {
    const cmp = this.compare;
    if (!cmp) return;
    this.compare = null; this.extraModels = [];
    for (const t of cmp.twins.values()) this.freeTwin(t);
    this._taaReset = true; this.version++;
  }
  // a twin's own GPU data: material slots, a whole old model's buffers, and the textures a reload replaced that no
  // live shape uses any more (textures still in use stay)
  freeTwin(t) {
    if (t.whole) { for (const s of t.whole.shapes) this.freeShape(s); this.freePsys(t.whole.psys); t.whole.psys = null; }
    else for (const s of t.shapes) if (s._matSlot) { this._matFree.push({ buf: s._matSlot.buf, off: s._matSlot.off }); s._matSlot = null; }
    const used = new Set();
    const keep = (sh) => { for (const x of Object.values(sh.tex || {})) if (x) used.add(x); };
    for (const m of [...this.models, ...this.cellTemplates]) for (const s of m.shapes) keep(s);
    for (const o of this.compare ? this.compare.twins.values() : []) if (o !== t) for (const s of o.shapes) keep(s);
    for (const s of t.shapes) for (const x of Object.values(s.tex || {})) {
      if (x && this._retired.has(x) && !used.has(x)) { this.gl.deleteTexture(x.tex); this._retired.delete(x); }
    }
  }
  // a texture changed on disk: load it again under every option it is used with (the old one is kept for the twins)
  reloadTexture(path, tag) {
    const pl = path.toLowerCase();
    for (const key of [...this.texCache.keys()]) {
      if (key !== pl && !key.startsWith(pl + '|')) continue;
      this.texCache.get(key).then(t => { if (t) this._retired.add(t); });
      this.texCache.delete(key);
      const o = key.slice(pl.length).split('|');
      this.texture(path, { clamp: o.includes('c'), lookup: o.includes('l'), srgb: o.includes('s'), vanilla: o.includes('v'), tag });
    }
  }
  // a shape's new material (and its textures) in one go, once they are all loaded: no frame shows it half-textured
  async applyMaterial(s, mat) {
    const tex = {};
    this._texHold = (this._texHold || 0) + 1;      // holds textures no shape shows yet: no sweep meanwhile
    try { for (const [k, p] of this.texturesFor(mat, s.vanilla)) tex[k] = await p; } finally { this._texHold--; }
    if (s.mat !== mat) { s.mat = mat; s.live = liveValues(mat); }
    s.tex = tex;
    this.version++;
  }
  // models posed every frame: the live ones and the whole "before" twins of reloaded NIFs
  get liveModels() { return this.extraModels.length ? this.models.concat(this.extraModels) : this.models; }

  removeModel(model) {
    if (this.selection && this.selection.model === model) this.setSelection(null);
    this.models = this.models.filter(m => m !== model);
    const tw = this.compare && this.compare.twins.get(model);
    if (tw) {                                  // its "before" goes with it (a twin's shapes share its geometry)
      this.compare.twins.delete(model);
      this.freeTwin(tw);
      this.extraModels = [...this.compare.twins.values()].filter(t => t.whole).map(t => t.whole);
      if (!this.compare.twins.size) this.endCompare();
    }
    for (const s of model.shapes) this.freeShape(s);
    this.freePsys(model.psys); model.psys = null;
    this.version++;
  }

  // ---------------------------------------------------------------------------------------------------- cell viewer
  clearCell() {
    if (this.selection && this.selection.kind === 'cell') this.setSelection(null);
    for (const t of this.cellTemplates) for (const sh of t.shapes) this.freeShape(sh);
    for (const q of [...this.lands, ...this.waters]) this.freeShape(q);
    this.freePsys(this.cellPsys); this.cellPsys = []; this._psysDraw = [];
    this.setDecals([]);
    if (this.lightShadow) {                      // (the layers' array is made again when a light needs it)
      const S = this.lightShadow;
      S.entries.clear(); S.parked.clear(); S.free.fill(true); S.slotKey = '';
      if (S.tex) { this.gl.deleteTexture(S.tex); this.gl.deleteFramebuffer(S.fbo); S.tex = S.fbo = null; this._tex = []; }
      if (S.pool) { this.gl.deleteTexture(S.pool.tex); this.gl.deleteFramebuffer(S.pool.fbo); this.gl.deleteFramebuffer(S.pool.rfbo); S.pool = null; this._tex = []; }
    }
    this.cellTemplates = []; this.batches = []; this.lands = []; this.waters = []; this.setPointLights([]);
    this.cellMode = false; this.cellFloor = false; this.cellVisible = true; this._worldKey = null; this.version++;
    this._grid = null;           // the probe grid held the freed batches
    this._casterAnim = false; this.casterEpoch();
  }
  // the cell's layer eye: placed objects, landscape, water and placed lights drawn or not (the character stays)
  setCellVisible(on) {
    this.cellVisible = !!on;
    if (!on && this.selection && this.selection.kind === 'cell') this.setSelection(null);
    this.lightsVersion = (this.lightsVersion || 0) + 1;
    // (the cell map is kept: its key and casters do not depend on the eye; casterSettle drops it when casters arrive
    // while hidden. An animated alpha-tested caster: drawn again, as it was drawn at a time)
    if (this._casterAnim) this._worldKey = null;
    this.cellTouched(); this.version++;
  }
  addTemplate(scene) {
    const m = this.addModel(scene, { role: 'cell', template: true });
    this.cellTemplates.push(m);
    return m;
  }
  // one placement of a template hidden (an opened door is drawn by a copy that plays its animation): culled everywhere
  // by an impossible bounding sphere, the batch's flat copies and the shadow maps made again
  hideInstance(tpl, item, hidden) {
    const j = (tpl.items || []).indexOf(item);
    if (j < 0) return false;
    for (const sh of tpl.shapes) {
      const b = sh._batch, it = b && b.inst[j];
      if (!it) continue;
      if (hidden && !(it.radius < 0)) { it._r = it.radius; it.radius = -1e9; }
      else if (!hidden && it.radius < 0) it.radius = it._r;
      b._fn = -1;
    }
    this.casterEpoch(); this.version++;
    return true;
  }
  get instanceCount() { let n = 0; for (const b of this.batches) n += b.inst.length; return n; }
  // §22 projected decals of the cell (server esm_world: placed TXST references). Each: { base, edid, pos, rot, scale,
  // decal: { material, size: [width, height], depth, sub, quad, color } }. One set per texture set: a shape-like
  // record (material, textures) drawn on the shared unit box, its placements in one instanced call.
  setDecals(list) {
    for (const d of this.decalSets) if (d.s._matSlot) { this._matFree.push({ buf: d.s._matSlot.buf, off: d.s._matSlot.off }); d.s._matSlot = null; }
    this.decalSets = [];
    const byBase = new Map();
    for (const r of list || []) {
      const dd = r.decal;
      if (!dd || !dd.material) continue;
      let set = byBase.get(r.base);
      if (!set) {
        const mat = dd.material;
        const s = { name: `decal ${r.edid || r.base}`, mat, live: liveValues(mat), tex: {}, vao: this.box.vao, count: this.box.count,
          indexType: this.gl.UNSIGNED_SHORT, consts: this.box.consts, visible: true, vanilla: false,
          decalColor: dd.color || [1, 1, 1], quad: !!dd.quad, multiply: !!dd.multiply };
        this.loadShapeTextures(s);
        set = { s, inst: [], items: [] };
        byBase.set(r.base, set);
        this.decalSets.push(set);
      }
      // world = T(pos) · R(ref) · S(scale) · T(0, offset, 0) · S(width, depth, height); the bottom row carries the
      // subtexture (DECAL_VS)
      const M = refMatrix(r.pos, r.rot, null, r.scale || 1);
      const [w, h] = dd.size, dp = dd.depth, off = dd.offset || 0;
      const B = mat4.identity();
      B[0] = w; B[5] = dp; B[10] = h; B[13] = off;
      const W = mat4.mul(M, B);
      W[3] = dd.sub >= 0 ? dd.sub : 0;
      const c = [W[12], W[13], W[14]];
      set.inst.push({ world: W, center: c, radius: 0.5 * Math.hypot(w, h, dp) * Math.abs(r.scale || 1) + 1 });
      set.items.push(r);
    }
    this.version++;
  }
  // the unit box (-0.5 .. 0.5) the projected decals are drawn with; faces wound counter-clockwise seen from outside
  makeBox() {
    const gl = this.gl;
    const P = new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    const I = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, P, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.instAttribs();
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: I.length, consts: [] };
  }
  // One template drawn at many placements. world = T(pos) · R(ref) · R(part) · S(scale), R = Rx(-x)·Ry(-y)·Rz(-z).
  // Each template shape keeps one batch: all its placements are drawn by one instanced call.
  placeInstances(tpl, items) {
    tpl.items = items;                           // the placed references (EDID, FormID), in instance order
    const mats = items.map(it => [refMatrix(it.pos, it.rot, it.rot2, it.scale), Math.abs(it.scale || 1)]);
    const adds = [];
    for (const sh of tpl.shapes) {
      if (sh.mat.kind === 'none' || sh.hidden) continue;
      let b = sh._batch;
      if (!b) {         // lod: distant LOD (world.js loadLod), which casts no shadows and nothing stands on
        b = sh._batch = { sh, inst: [], lod: !!tpl.lod, blend: !!(sh.mat.alpha && sh.mat.alpha.blend), decal: isDecal(sh.mat),
          clip: !!(sh.mat.alpha && sh.mat.alpha.test) || isDecal(sh.mat) };
        this.batches.push(b);
      }
      const r0 = vec3.len(vec3.sub(sh.bbox[1], sh.bbox[0])) / 2, i0 = b.inst.length;
      for (const [M, sc] of mats)
        b.inst.push({ world: mat4.mul(M, sh.world), center: mat4.transformPoint(M, sh.center), radius: r0 * sc + 1 });
      if (mats.length && this.isCaster(b)) adds.push({ b, i0, i1: b.inst.length });
    }
    for (const d of tpl.psysDefs || []) for (const [M] of mats) this.cellPsys.push(this.newPsys(d, tpl, M));
    // the shadow maps, light layers and probe grid see only casters: distant LOD and effect / blended / refraction
    // shapes leave them as they are (version still redraws the view), new casters are drawn into the maps as they are
    // (casterAdds). An animated alpha-tested caster (an effect template's own animation, updateParticles) makes the
    // time a map is drawn visible: then every placement redraws every map as a whole
    if (this.animatesCasterUV(tpl)) this._casterAnim = true;
    this.cellTouched();
    if (adds.length || this._casterAnim) this.casterAdds(adds);
    this.version++;
  }

  // ---------------------------------------------------------------------------------------------------- particles
  // One particle system on screen: its simulation and a shape whose vertex buffers are refilled each frame with
  // camera-facing quads in world space, drawn with the system's own effect material among the blended surfaces.
  newPsys(def, model, base) {
    const gl = this.gl, cap = Math.max(1, Math.min(4096, def.max | 0));
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const bufs = [];
    const dyn = (loc, bytes, size, type, normd) => {
      const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, normd, 0, 0);
      return b;
    };
    const bPos = dyn(0, cap * 48, 3, gl.FLOAT, false), bUV = dyn(4, cap * 32, 2, gl.FLOAT, false);
    const bCol = dyn(5, cap * 16, 4, gl.UNSIGNED_BYTE, true);
    this.instAttribs();
    const idx = new Uint16Array(cap * 6);
    // counter-clockwise seen from the camera (corners: top-left, top-right, bottom-right, bottom-left)
    for (let q = 0; q < cap; q++) idx.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4, q * 4 + 3, q * 4 + 2], q * 6);
    const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const mat = def.material;
    // the normal faces the camera (set each frame); no tangents, no skinning
    const shape = { name: `particles ${def.name}`, mat, live: liveValues(mat), tex: {}, vao, count: 0,
      indexType: gl.UNSIGNED_SHORT, consts: [[1, 0.5, 0.5, 1, 1], [2, 0.5, 0.5, 0.5, 0], [3, 0.5, 0.5, 0.5, 0],
        [6, 0, 0, 0, 0], [7, 0, 0, 0, 0]],
      visible: true, vanilla: false, isParticles: true, shader_block: def.shader_block, _bufs: bufs,
      bPos, bUV, bCol, pos: new Float32Array(cap * 12), uv: new Float32Array(cap * 8), col: new Uint8Array(cap * 16),
      world: IDENTITY, center: [0, 0, 0], bbox: [[0, 0, 0], [0, 0, 0]] };
    this.loadShapeTextures(shape);
    return { def, model, base, shape, sim: new ParticleSim(def, ++this._psysSeed), active: false,
      origin: base ? [base[12], base[13], base[14]] : null };
  }
  freePsys(list) { for (const p of list || []) this.freeShape(p.shape); }
  // world matrices for one system this frame: its model's root (the player group's placement, or the cell
  // placement), its nodes (emitter, gravity and drag objects) and the system itself
  psysCtx(p) {
    const m = p.model, root = p.base || (m.xform ? mat4.mul(this.playerRoot, m.xform) : this.playerRoot), memo = new Map();
    const node = (b) => {
      if (b == null || b < 0 || !m.nodes.has(b)) return null;
      if (!memo.has(b)) memo.set(b, mat4.mul(root, m.nodes.get(b).world || IDENTITY));
      return memo.get(b);
    };
    const parent = node(p.def.parent) || root;
    return { node, root, sys: mat4.mul(parent, p._local || (p._local = new Float32Array(p.def.local))) };
  }
  // simulate (while playing) and rebuild the quads of the systems in play; called once per frame before culling
  updateParticles(dt, view, eye) {
    this._psysDraw = [];
    this._psysLive = false;
    const all = [];
    for (const m of this.models) if (m.visible && m.psys) all.push(...m.psys);
    const near = [];
    for (const p of this.cellVisible ? this.cellPsys : []) {
      const o = p.origin, d = (o[0] - eye[0]) ** 2 + (o[1] - eye[1]) ** 2 + (o[2] - eye[2]) ** 2;
      if (d < PSYS_RANGE * PSYS_RANGE) near.push([d, p]); else if (p.active) { p.active = false; p.sim.reset(); }
    }
    near.sort((a, b) => a[0] - b[0]);
    near.forEach(([, p], i) => { if (i < PSYS_MAX_CELL) all.push(p); else if (p.active) { p.active = false; p.sim.reset(); } });
    if (this.settings.particles === false || !all.length) return;
    // the cell objects these systems belong to (fire barrels, steam vents) also play their own animation (flames
    // are effect meshes with flipbook / fade controllers): one shared evaluation per template
    const tpls = new Set(all.filter(p => p.base).map(p => p.model));
    for (const t of tpls) {
      if (t._animKey === this.time) continue;
      t._animKey = this.time;
      try { this.animate(t, this.time); } catch (e) { /* a template that does not animate stays still */ }
    }
    const gl = this.gl, step = this.playing && this.speed ? Math.min(0.1, dt * this.speed) : 0;
    const cam = { right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], eye };
    const nrm = [1, (view[2] + 1) / 2, (view[6] + 1) / 2, (view[10] + 1) / 2, 1];
    for (const p of all) {
      const ctx = this.psysCtx(p), sim = p.sim;
      if (!p.active) {                         // just came into play: run it ahead so it is already burning
        p.active = true; sim.reset();
        const life = Math.max(0, ...sim.emitters.map(e => e.life + Math.abs(e.life_var)));
        const warm = Math.min(PSYS_WARM, life), h = 1 / 20;
        for (let t = warm; t > 0; t -= h) sim.update(Math.min(h, t), this.time - t, ctx);
      }
      if (step > 0) sim.update(step, this.time, ctx);
      if (sim.live) this._psysLive = true;
      const s = p.shape, r = sim.build(s.pos, s.uv, s.col, cam, p.def.aspect);
      s.count = r.count * 6;
      if (!r.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.pos, 0, r.count * 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.bUV); gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.uv, 0, r.count * 8);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.bCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.col, 0, r.count * 16);
      s.consts[0] = nrm; s.center = r.center;
      this._psysDraw.push({ s, c: r.center, radius: r.radius });
    }
  }
  // q: typed arrays for one landscape quadrant + up to four layer texture sets [{d, n, s}]
  addLandQuad(q) {
    const gl = this.gl, bufs = [];
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (loc, data, size) => {
      const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    const unit = (a) => a.map(v => (v + 1) * 0.5);            // the shader reads unit vectors as 0..1
    buf(0, q.pos, 3); buf(1, unit(q.normal), 3); buf(2, unit(q.bitan), 3); buf(3, unit(q.tan), 3); buf(4, q.uv, 2);
    buf(5, q.color, 4); buf(6, q.weights, 4);
    this.instAttribs();
    const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, q.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const shape = { vao, _bufs: bufs, count: q.indices.length, indexType: gl.UNSIGNED_INT, consts: [[7, 0, 0, 0, 0]],
      mat: LAND_MAT, live: liveValues(LAND_MAT), tex: {}, layerTex: q.layers.map(() => ({})), world: mat4.identity(),
      center: q.center, radius: q.radius, visible: true, name: 'landscape' };
    q.layers.forEach((L, i) => {
      if (!L) return;
      this.texture(L.d, { srgb: true }).then(t => { shape.layerTex[i].d = t; this.version++; });
      this.texture(L.n).then(t => { shape.layerTex[i].n = t; this.version++; });
      if (L.s) this.texture(L.s).then(t => { shape.layerTex[i].s = t; this.version++; });
    });
    this.lands.push(shape);
    this.cellTouched(); this.casterAdds([{ q: shape }]); this.version++;
    return shape;
  }
  addWater(x0, y0, x1, y1, z) {
    const gl = this.gl, bufs = [];
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.instAttribs();
    const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const w = { vao, _bufs: bufs, count: 6, indexType: gl.UNSIGNED_INT, mat: WATER_MAT, live: liveValues(WATER_MAT), tex: {},
      world: mat4.identity(), center: [(x0 + x1) / 2, (y0 + y1) / 2, z], radius: Math.hypot(x1 - x0, y1 - y0) / 2,
      visible: true, blend: true, name: 'water',
      consts: [[1, 0.5, 0.5, 1, 0], [2, 1, 0.5, 0.5, 0], [3, 0.5, 0, 0.5, 0], [4, 0, 0, 0, 0], [5, 0.16, 0.24, 0.26, 0.78], [6, 0, 0, 0, 0], [7, 0, 0, 0, 0]] };
    this.waters.push(w);
    this.version++;
  }

  // ---------------------------------------------------------------------------------------------------- depth probes
  // Game mode: the depth of the nearest solid surface in tiny orthographic views. Every probe of one update is drawn
  // side by side into one small target and read back with a single readPixels: each read-back makes the page wait
  // for the GPU process to work through everything queued, so one wait per frame instead of three.
  // A probe: { vp, map(depth) -> result } (groundProbe / rayProbe / aheadProbe); depth 1 = nothing in the box.
  // A box drawn before over the same cell gives the same depth (probeItems draws only the landscape and probeGrid's
  // solid objects, both fixed for a cellVersion, with fixed state): the raw depth is kept per box (its 16 floats), so a
  // character standing still in game mode costs no draw and no read-back wait; each probe's own map makes its result.
  probe(list) {
    const gl = this.gl, N = 8, K = list.length;
    if (!K) return [];
    if (K > 4) throw new Error('at most 4 probes at once');
    let C = this._probeCache;
    const ver = `${this.cellVersion}|${this.tplBones || 0}`;       // (a skinned template draws with its palette)
    if (!C || C.ver !== ver) C = this._probeCache = { ver, depth: new Map() };
    const keys = list.map(pr => Array.prototype.join.call(pr.vp));
    if (keys.every(k => C.depth.has(k))) return list.map((pr, i) => pr.map(C.depth.get(keys[i])));
    if (C.depth.size > 64) C.depth.clear();
    const outer = this.prof?.cur?.name;
    this._mark('probe');
    if (!this.probeFbo) {
      this.probeTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, N * 4, N);
      const db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, db); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, N * 4, N);
      this.probeFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.probeTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
      this.probePx = new Float32Array(N * 4 * N * 4);
    }
    this.resetState();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
    gl.viewport(0, 0, N * K, N);
    gl.clearColor(1, 1, 1, 1); this.setDepthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.clearColor(0, 0, 0, 1);
    this.setDepthTest(true); this.setBlend(false); this.setCull(false);
    const ib = this.inst.probe;
    ib.n = 0;
    const draws = list.map(pr => this.probeItems(pr.vp, ib));
    this.uploadInst(ib);
    list.forEach((pr, i) => {
      gl.viewport(i * N, 0, N, N);
      for (const [s, base, n] of draws[i]) {
        const p = this.progs.probe[s.skinData ? 1 : 0];
        this.useProg(p);
        if (p._vp !== pr.vp) { p._vp = pr.vp; this.um4(p, 'uShadowVP', pr.vp); }
        if (s.skinData) this.bindBones(s.skinData);
        this.drawInstanced(s, ib, base, n);
      }
    });
    gl.bindVertexArray(null); this._vao = null;
    gl.readPixels(0, 0, N * K, N, gl.RGBA, gl.FLOAT, this.probePx);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._mark(outer || null);
    return list.map((pr, i) => {
      let m = 1;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m = Math.min(m, this.probePx[(y * N * K + i * N + x) * 4]);
      C.depth.set(keys[i], m);
      return pr.map(m);
    });
  }
  // the landscape and solid cell objects inside one probe box (found through a coarse grid of the cell's objects)
  probeItems(vp, ib) {
    const planes = frustumPlanes(vp), items = [];
    for (const q of this.lands) if (sphereVisible(planes, q.center, q.radius)) items.push([q, this.pushInst(ib, q.world), 1]);
    const G = this.probeGrid(), S = G.size;
    // the probe box's extent on the ground plane: its eight corners back in world space
    const inv = mat4.invert(vp);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const cx of [-1, 1]) for (const cy of [-1, 1]) for (const cz of [-1, 1]) {
      const p = mat4.transformPoint(inv, [cx, cy, cz]);
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    const stamp = ++this._probeStamp, found = new Map();
    for (let gx = Math.floor(x0 / S); gx <= Math.floor(x1 / S); gx++) for (let gy = Math.floor(y0 / S); gy <= Math.floor(y1 / S); gy++) {
      const cell = G.cells.get(gx * 65536 + gy);
      if (!cell) continue;
      for (const e of cell) {
        if (e.it._stamp === stamp) continue;
        e.it._stamp = stamp;
        if (!sphereVisible(planes, e.it.center, e.it.radius)) continue;
        if (!found.has(e.b)) found.set(e.b, []);
        found.get(e.b).push(e.it);
      }
    }
    for (const [b, list] of found) {
      const base = ib.n;
      for (const it of list) this.pushInst(ib, it.world);
      items.push([b.sh, base, list.length]);
    }
    return items;
  }
  // solid surfaces only: alpha-tested foliage, fences and decals do not stop or carry the character
  probeGrid() {
    if (this._grid && this._grid.ver === this.cellVersion) return this._grid;
    const S = 1024, cells = new Map();
    for (const b of this.batches) {
      const m = b.sh.mat;
      if (b.lod || !b.sh.visible || b.blend || m.kind !== 'lighting' || m.alpha?.test || isDecal(m) || m.refraction) continue;
      for (const it of b.inst) {
        const c = it.center, r = it.radius;
        for (let gx = Math.floor((c[0] - r) / S); gx <= Math.floor((c[0] + r) / S); gx++)
          for (let gy = Math.floor((c[1] - r) / S); gy <= Math.floor((c[1] + r) / S); gy++) {
            const k = gx * 65536 + gy;
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k).push({ b, it });
          }
      }
    }
    this._probeStamp = this._probeStamp || 0;
    return (this._grid = { ver: this.cellVersion, size: S, cells });
  }
  // the highest surface below zTop within `range` under a small footprint (height, or null)
  groundProbe(x, y, zTop, range = 2000, half = 8) {
    const view = mat4.lookAt([x, y, zTop], [x, y, zTop - 1], [0, 1, 0]);
    return { vp: mat4.mul(mat4.ortho(-half, half, -half, half, 0, range), view), map: d => d >= 1 ? null : zTop - d * range };
  }
  // distance along any ray to the nearest solid surface (a thin orthographic box), or null
  rayProbe(origin, dir, dist, half = 6) {
    const up = Math.abs(dir[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
    const view = mat4.lookAt(origin, [origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]], up);
    return { vp: mat4.mul(mat4.ortho(-half, half, -half, half, 0, dist), view), map: d => d >= 1 ? null : d * dist };
  }
  // distance to the nearest solid surface ahead between knee and head height, or null
  aheadProbe(pos, dir, dist) {
    const eye = [pos[0], pos[1], pos[2] + 80];
    const view = mat4.lookAt(eye, [eye[0] + dir[0], eye[1] + dir[1], eye[2]], [0, 0, 1]);
    return { vp: mat4.mul(mat4.ortho(-14, 14, -45, 45, 0, dist), view), map: d => d >= 1 ? null : d * dist };
  }
  groundAt(x, y, zTop, range, half) { return this.probe([this.groundProbe(x, y, zTop, range, half)])[0]; }
  rayDistance(origin, dir, dist, half) { return this.probe([this.rayProbe(origin, dir, dist, half)])[0]; }
  obstacleAhead(pos, dir, dist) { return this.probe([this.aheadProbe(pos, dir, dist)])[0]; }

  // lights: [{pos, radius, color (linear), att: [c0, c1, c2]}]
  setPointLights(lights) { this.pointLights = lights; this.lightsVersion = (this.lightsVersion || 0) + 1; this.version++; }

  updateTransforms(model) {
    const memo = new Map();
    const base = model.attach ? this.boneWorld(model.attach) : null;     // the Prn bone, posed or at rest
    const world = (b) => {
      if (b < 0 || !model.nodes.has(b)) return base || mat4.identity();
      if (memo.has(b)) return memo.get(b);
      const n = model.nodes.get(b);
      const w = mat4.mul(world(n.parent), n.local);
      memo.set(b, w); n.world = w;
      return w;
    };
    for (const n of model.nodes.values()) world(n.block);
    for (const s of model.shapes) s.world = s.skinned || !s.localM ? mat4.identity() : mat4.mul(world(s.parent), s.localM);
    if (model.attach) {                          // bounds follow the bone (camera framing, shadow fit)
      const [a, b] = model.scene.bbox, m = base || mat4.identity();
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) {
        const p = mat4.transformPoint(m, [x, y, z]);
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
      }
      model.bbox = [lo, hi];
    }
    // a cell template's own nodes only place its particle emitters (psysCtx reads them each frame): its placed copies
    // keep the matrices of placeInstances and its palettes the bind pose, so nothing keyed on geomVersion changes
    if (model.role !== 'cell') this.geomVersion++;
  }
  // a skeleton bone's world matrix: in the current pose, else at rest (skeleton.nif); null without a skeleton
  boneWorld(lname) {
    return (this.pose && this.pose.get(lname)) || (this.skelRest && this.skelRest.get(lname)) || null;
  }
  // re-hang Prn-attached models when the pose (or the skeleton) changed
  updateAttached() {
    const key = `${this.pose ? `${this._poseClip?.path}@${this._poseTime}` : 'rest'}|${this.skelSerial || 0}`;
    for (const m of this.liveModels) {
      if (!m.attach || m._attachKey === key) continue;
      m._attachKey = key;
      this.updateTransforms(m);
    }
  }

  // ---------------------------------------------------------------------------------------------------- animation
  animate(model, t) {
    if (!model.controllers.length && !model.activeSeq) return;        // nothing that moves (most cell templates)
    let moved = false;
    const byShader = new Map();
    for (const s of [...model.shapes, ...(model.psys || []).map(p => p.shape)]) {    // particle materials too
      if (!byShader.has(s.shader_block)) byShader.set(s.shader_block, []);
      byShader.get(s.shader_block).push(s);
    }
    const apply = (kind, valueKind, variable, ip, st, shaderBlock) => {
      const table = kind === 'lighting' ? (valueKind === 'float' ? LIGHTING_FLOAT : LIGHTING_COLOR)
        : (valueKind === 'float' ? EFFECT_FLOAT : EFFECT_COLOR);
      const key = table[variable];
      if (!key) return;
      const v = sampleKeys(ip.keys, st, ip.kind === 'float' ? [ip.value] : ip.value);
      if (!v || !v.every(Number.isFinite) || Math.abs(v[0]) > 1e30) return;   // FLT_MAX sentinel = keep material value
      for (const s of byShader.get(shaderBlock) || []) s.live[key] = valueKind === 'float' ? v[0] : v;
    };
    for (const c of model.controllers) {
      // inactive, or driven by a sequence through a blend interpolator (played below, when a sequence is active)
      if (!(c.flags & 8) || !c.interp || c.interp.kind === 'unsupported') continue;
      const st = scaledTime(c, t);
      if (c.shader_kind) apply(c.shader_kind, c.value_kind, c.variable, c.interp, st, c.target);
      else if (c.interp.kind === 'transform' && c.type === 'NiTransformController' && model.nodes.has(c.target)) {
        const n = model.nodes.get(c.target);
        n.local = transformMatrix(n.base, sampleTransform(c.interp, st));
        moved = true;
      }
    }
    const seq = model.activeSeq;
    if (seq) {
      const st = scaledTime({ start: seq.start, stop: seq.stop, frequency: seq.frequency || 1, phase: 0,
        flags: 8 | (seq.cycle << 1) }, t - (model.seqStart || 0));
      for (const ch of seq.channels) {
        const ip = ch.interp;
        if (ch.shader_kind) { if (ip.keys) apply(ch.shader_kind, ch.value_kind, ch.variable, ip, st, ch.shader_block); }
        else if (ip.kind === 'transform') {
          const n = model.nodeByName.get(ch.node);
          if (!n) continue;
          n.local = transformMatrix(n.base, sampleTransform(ip, st));
          moved = true;
        }
      }
    }
    if (moved) this.updateTransforms(model);
  }

  // ---------------------------------------------------------------------------------------------------- skeleton pose
  // skeleton.nif nodes (rest locals) + an HKX clip -> world matrix per bone name (lower case). Bones the clip does
  // not animate (the *_skin helpers) keep their rest offset from their animated ancestor.
  setSkeleton(nodes) {
    this.skel = nodes.map(n => ({ block: n.block, parent: n.parent, lname: n.name.toLowerCase(), rest: new Float32Array(n.local) }));
    this.skelByBlock = new Map(this.skel.map(n => [n.block, n]));
    const rest = new Map();
    const W = (b) => {
      if (rest.has(b)) return rest.get(b);
      const n = this.skelByBlock.get(b);
      const m = !n ? mat4.identity() : (this.skelByBlock.has(n.parent) ? mat4.mul(W(n.parent), n.rest) : n.rest);
      rest.set(b, m);
      return m;
    };
    this.skelRest = new Map(this.skel.map(n => [n.lname, W(n.block)]));
    this.skelSerial = (this.skelSerial || 0) + 1;
    this.version++;
  }
  decodeClip(clip) {
    const tracks = new Map();
    for (const tr of clip.tracks) tracks.set(tr.name.toLowerCase(), { t: b64(tr.t, Float32Array), r: b64(tr.r, Float32Array), s: b64(tr.s, Float32Array) });
    return { ...clip, tracks };
  }
  setClip(clip) {
    this.version++; this.geomVersion++; this._fade = null;
    if (!clip) { this.clip = null; this.pose = null; return; }
    this.clip = { ...this.decodeClip(clip), start: this.time };
  }
  // switch to an already decoded clip, blending from the current one over `fade` seconds
  useClip(decoded, fade = 0.25) {
    if (this.clip && this.clip.path === decoded.path) return;
    this._fade = this.clip && fade > 0 ? { clip: this.clip, from: this.time, until: this.time + fade } : null;
    this.clip = { ...decoded, start: this.time };
    this.version++; this.geomVersion++;
  }
  // one bone of clip c at `time` into o: translation x y z, rotation w x y z, scale (false: no track for the bone).
  // Scalars instead of small arrays (it runs for every bone every animated frame), the same arithmetic in the same order
  sampleTRS(c, n, time, o) {
    const tr = c.tracks.get(n.lname);
    if (!tr) return false;
    const fd = c.frame_duration || c.duration / Math.max(1, c.frames - 1);
    const tt = (((time - c.start) % c.duration) + c.duration) % c.duration;
    const fpos = Math.min(tt / fd, c.frames - 1), i0 = Math.floor(fpos), i1 = Math.min(i0 + 1, c.frames - 1), a = fpos - i0;
    const T = tr.t, Q = tr.r, b = 1 - a, t0 = i0 * 3, t1 = i1 * 3, r0 = i0 * 4, r1 = i1 * 4;
    o[0] = T[t0] * b + T[t1] * a; o[1] = T[t0 + 1] * b + T[t1 + 1] * a; o[2] = T[t0 + 2] * b + T[t1 + 2] * a;
    const w0 = Q[r0 + 3], x0 = Q[r0], y0 = Q[r0 + 1], z0 = Q[r0 + 2];                // -> w x y z
    let w1 = Q[r1 + 3], x1 = Q[r1], y1 = Q[r1 + 1], z1 = Q[r1 + 2];
    if (w0 * w1 + x0 * x1 + y0 * y1 + z0 * z1 < 0) { w1 = -w1; x1 = -x1; y1 = -y1; z1 = -z1; }
    o[3] = w0 * b + w1 * a; o[4] = x0 * b + x1 * a; o[5] = y0 * b + y1 * a; o[6] = z0 * b + z1 * a;
    o[7] = tr.s[i0] * b + tr.s[i1] * a;
    return true;
  }
  computePose() {
    const c = this.clip;
    if (!c || !this.skel) { this.pose = null; return; }
    if (this.pose && this._poseClip === c && this._poseTime === this.time) return;   // same frame of the same clip
    this._poseClip = c; this._poseTime = this.time;
    const fade = this._fade && this.time < this._fade.until ? this._fade : null;
    const w = fade ? (this.time - fade.from) / (fade.until - fade.from) : 1;
    const A = this._trsA || (this._trsA = new Float64Array(8)), B = this._trsB || (this._trsB = new Float64Array(8));
    const local = new Map();
    for (const n of this.skel) {
      let has = this.sampleTRS(c, n, this.time, A);
      if (fade) {                                   // crossfade from the previous clip
        const hb = this.sampleTRS(fade.clip, n, this.time, B);
        if (has && hb) {
          if (A[3] * B[3] + A[4] * B[4] + A[5] * B[5] + A[6] * B[6] < 0) for (let k = 3; k < 7; k++) A[k] = -A[k];
          for (let k = 0; k < 8; k++) A[k] = B[k] + (A[k] - B[k]) * w;
        } else if (hb) { A.set(B); has = true; }
      }
      if (!has) { local.set(n.block, n.rest); continue; }
      const ql = Math.hypot(A[3], A[4], A[5], A[6]) || 1;
      // mat4.fromQuatTRS of the normalised quaternion, written out
      const qw = A[3] / ql, x = A[4] / ql, y = A[5] / ql, z = A[6] / ql, sc = A[7], m = new Float32Array(16);
      m[0] = (1 - 2 * (y * y + z * z)) * sc; m[1] = 2 * (x * y + qw * z) * sc; m[2] = 2 * (x * z - qw * y) * sc;
      m[4] = 2 * (x * y - qw * z) * sc; m[5] = (1 - 2 * (x * x + z * z)) * sc; m[6] = 2 * (y * z + qw * x) * sc;
      m[8] = 2 * (x * z + qw * y) * sc; m[9] = 2 * (y * z - qw * x) * sc; m[10] = (1 - 2 * (x * x + y * y)) * sc;
      m[12] = A[0]; m[13] = A[1]; m[14] = A[2]; m[15] = 1;
      local.set(n.block, m);
    }
    const world = new Map(), pose = new Map();
    const W = (b) => {
      if (world.has(b)) return world.get(b);
      const n = this.skelByBlock.get(b);
      const m = !n ? mat4.identity() : (this.skelByBlock.has(n.parent) ? mat4.mul(W(n.parent), local.get(b)) : local.get(b));
      world.set(b, m);
      return m;
    };
    for (const n of this.skel) pose.set(n.lname, W(n.block));
    this.pose = pose;
    this.geomVersion++;
  }
  // cloth physics (cloth.js): each worn model's cloth is stepped in world space (the player group's placement, so walking
  // in game mode moves it), then its cloth bones go back to model space for the bone palettes. dt: animation seconds
  // (0 while paused: the cloth stops with the body)
  updateCloth(dt) {
    let changed = false;
    let root = this.playerRoot;
    // treadmill: a clip played in place still moves the character through the air for the cloth (Havok's damping acts
    // on world velocities, so a running coat trails behind); speed eased over ~0.3 s like a real start or stop
    const tr = this._tread, c = this.clip;
    const want = this.treadmill && c && c.in_place && this.skel ? (this.treadSpeed || c.root_speed || 0) : 0;
    tr.speed += (want - tr.speed) * Math.min(1, dt / 0.3);
    if (Math.abs(tr.speed) < 0.01 && !want) tr.speed = 0;
    tr.dist += tr.speed * dt;
    const fwd = [root[4], root[5], root[6]];                 // the character faces its +Y
    // stopped (a standing pose, game mode): bring the cloth back from the treadmill's run, else a later turn of the
    // character would swing it round on a circle as wide as the distance walked
    if (Math.abs(tr.dist) > 20000 || (tr.dist && !want && !tr.speed)) {   // (and stay near the origin on long runs)
      for (const m of this.models) for (const cl of m.cloth || []) cl.shift(fwd.map(v => -v * tr.dist));
      tr.dist = 0;
    }
    if (tr.dist) { const T = mat4.identity(); T[12] = fwd[0] * tr.dist; T[13] = fwd[1] * tr.dist; T[14] = fwd[2] * tr.dist; root = mat4.mul(T, root); }
    let rootInv = null;
    for (const m of this.models) {
      if (!m.cloth || !m.cloth.length || !m.visible) continue;
      const getBone = (i, lname, rest) => {
        let w = (this.pose && this.pose.get(lname)) || (this.skelRest && this.skelRest.get(lname));
        if (!w) { const n = m.nodeByLname.get(lname); w = n && n.world; }
        return mat4.mul(root, w || rest);
      };
      for (const c of m.cloth) {
        if (!c.update(dt, getBone, this.clothSim)) continue;
        rootInv = rootInv || mat4.invert(root);
        for (const b of c.cb) m.clothPose.set(b.lname, mat4.mul(rootInv, b.out));
        changed = true;
      }
    }
    if (changed) this.geomVersion++;
  }
  // let the cloth hang in the current pose for `seconds` (headless captures: a still shot of settled cloth)
  settleCloth(seconds = 3) {
    if (!this.models.some(m => m.cloth && m.cloth.length)) return;
    try { this.computePose(); } catch (e) { this.pose = null; }
    for (let i = 0; i < Math.round(seconds * 60); i++) this.updateCloth(1 / 60);
  }
  // restart every cloth on the body (the physics switch, or a scene that moved the character)
  resetCloth() {
    for (const m of this.models) for (const c of m.cloth || []) c.started = false;
    this.version++;
  }
  // bone palettes (bone world x skin-to-bone) into each skinned shape's uniform block, when the pose changed. A
  // palette reads only the pose, its model's clothPose and its own bind / skin-to-bone data. When geomVersion changed
  // (computePose, updateCloth, setClip / useClip, setModelXform) every live palette is made again; when only version
  // changed (textures arriving, models added), only those whose inputs changed (the pose Map or the clothPose Map
  // replaced without a geomVersion bump: a failed pose, a reloaded NIF's "before" twin) and new shapes (ver 0): the
  // others would come out the same. A cell template's (bind x skin-to-bone: no pose, no cloth) is made once.
  updateBones() {
    const gl = this.gl, live = this.liveModels;
    // TAA: the palette the last frame drew with becomes "previous" (written once after each change; a template's is
    // written with its first palette, below, and never changes)
    if (this.settings.taa) for (const m of live) for (const s of m.shapes) {
      const k = s.skinData;
      if (!k || !k.uboPrev || k.prevVer === k.ver || !k.used) continue;
      gl.bindBuffer(gl.UNIFORM_BUFFER, k.uboPrev); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, k.mats, 0, k.used);
      k.prevVer = k.ver;
    }
    if (this.geomVersion === this._bonesGeo && this.version === this._bonesVer) return;   // the palettes are valid
    const posed = this.geomVersion !== this._bonesGeo;
    this._bonesGeo = this.geomVersion; this._bonesVer = this.version;
    for (const m of live) {
      const pose = m.role === 'cell' ? null : this.pose;
      const all = posed || pose !== m._bonesPose || m.clothPose !== m._bonesCloth;
      m._bonesPose = pose; m._bonesCloth = m.clothPose;
      for (const s of m.shapes) {
        const k = s.skinData;
        if (k && k.ubo && (all || !k.ver)) this.bonePalette(k, pose, m.clothPose);
      }
    }
    for (const m of this.cellTemplates) for (const s of m.shapes) {
      const k = s.skinData;
      if (k && k.ubo && !k.ver) { this.bonePalette(k, null, m.clothPose); this.tplBones = (this.tplBones || 0) + 1; }
    }
  }
  // one shape's palette: bone world x skin-to-bone written straight into k.mats (mat4.mul's loop order and double sums,
  // rounded to float once), then uploaded
  bonePalette(k, pose, cloth) {
    const gl = this.gl, M = k.mats, n = Math.min(k.lnames.length, this.maxBones);
    for (let i = 0; i < n; i++) {
      const a = (cloth && cloth.get(k.lnames[i])) || (pose && pose.get(k.lnames[i])) || k.bind[i], b = k.s2b[i], o = i * 16;
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0; for (let j = 0; j < 4; j++) s += a[j * 4 + r] * b[c * 4 + j]; M[o + c * 4 + r] = s;
      }
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, k.ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, M, 0, n * 16);
    k.used = n * 16; k.ver++;
    if (k.prevVer < 0 && k.uboPrev) {           // a new shape: no motion on its first frame
      gl.bindBuffer(gl.UNIFORM_BUFFER, k.uboPrev); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, M, 0, n * 16);
      k.prevVer = k.ver;
    }
  }

  // ---------------------------------------------------------------------------------------------------- scene bounds
  // placed = false: the character where it stands before game mode moves it (the flat ground plane's height)
  sceneBounds(includeRefs = true, placed = true) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of this.models) {
      if (!m.visible || (!includeRefs && m.role === 'ref')) continue;
      for (const x of [m.bbox[0][0], m.bbox[1][0]]) for (const y of [m.bbox[0][1], m.bbox[1][1]]) for (const z of [m.bbox[0][2], m.bbox[1][2]]) {
        const w = placed ? mat4.transformPoint(this.playerRoot, [x, y, z]) : [x, y, z];
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], w[i]); hi[i] = Math.max(hi[i], w[i]); }
      }
    }
    if (!isFinite(lo[0])) return [[-50, -50, 0], [50, 50, 100]];
    return [lo, hi];
  }

  // ---------------------------------------------------------------------------------------------------- targets
  // three depth maps read with hardware comparison (filtered PCF): [0] the cell's static objects, [1] the character,
  // [2] the light shafts' far map. [0] and [2] are made when first drawn (drawCasters): until then (the studio, the
  // thumbnail renderers) a 1 x 1 stand-in is bound in their place, never read (uFlags.x / uFarOn are off until drawn)
  makeShadowTargets() {
    const gl = this.gl;
    this.shadowTex = []; this.shadowFbo = [];
    const none = this.depthTarget(1);
    for (let i = 0; i < 3; i++) {
      const t = i === 1 ? this.depthTarget(this.shadowSize[i]) : none;
      this.shadowTex.push(t.tex); this.shadowFbo.push(i === 1 ? t.fbo : null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.worldVP = IDENTITY; this.actorVP = IDENTITY;
  }
  // a square DEPTH_COMPONENT24 map with comparison sampling and its depth-only framebuffer
  depthTarget(n) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, n, n);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    this._tex = [];                              // the unit caches no longer know what is bound
    return { tex: t, fbo: f };
  }
  // eye adaptation: two 1 x 1 targets (adapted luminance, this frame's mean), swapped each frame
  makeAdaptTargets() {
    const gl = this.gl;
    this.adapt = [this.colorTex(1, 1, 'RGBA32F'), this.colorTex(1, 1, 'RGBA32F')];
    for (const t of this.adapt) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0.18, 0.18, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.clearColor(0, 0, 0, 1); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._ad = 0;
  }

  colorTex(w, h, fmt = 'RGBA16F', mips = false) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl[fmt], w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: t, fbo: f, w, h, levels };
  }

  resize(w, h) {
    const gl = this.gl, taa = !!this.settings.taa;
    const msaa = Math.min(this.settings.msaa, this.quality.msaa);      // (the quality tier's cap)
    if (this.size && this.size[0] === w && this.size[1] === h && this.size[2] === msaa && this.size[3] === taa) return;
    this.size = [w, h, msaa, taa];
    this.canvas.width = w; this.canvas.height = h;
    // the previous size's targets go back to the driver (screenshots and window resizes used to pile them up)
    const old = this._targets;
    if (old) {
      for (const f of old.fbos) gl.deleteFramebuffer(f);
      for (const r of old.rbs) gl.deleteRenderbuffer(r);
      for (const t of old.texs) gl.deleteTexture(t);
    }
    // msaa 1: no multisampling at all (TAA alone, as the game)
    const samples = msaa > 1 ? Math.min(msaa, gl.getParameter(gl.MAX_SAMPLES)) : 0;
    this.msFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
    const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, db);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    // TAA: the mesh shaders' motion (xy) and coverage (a) in a second attachment, resolved like the colour
    const rbs = [rb, db];
    if (taa) {
      const vb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, vb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, vb);
      rbs.push(vb);
    }
    gl.drawBuffers(taa ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    // the solid scene's depth, resolved for soft particles
    this.sceneDepth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.sceneDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.depthFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.sceneDepth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.hdr = this.colorTex(w, h);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);   // bloom at quarter resolution (§12, medium)
    this.bloomA = this.colorTex(qw, qh); this.bloomB = this.colorTex(qw, qh);
    if (!this.lum) this.lum = this.colorTex(256, 256, 'RGBA16F', true);
    this._targets = { fbos: [this.msFbo, this.depthFbo, this.hdr.fbo, this.bloomA.fbo, this.bloomB.fbo], rbs,
      texs: [this.sceneDepth, this.hdr.tex, this.bloomA.tex, this.bloomB.tex] };
    // TAA: resolved motion, and the history (two textures, written in turn)
    this.vel = taa ? this.colorTex(w, h) : null;
    this.taaTex = taa ? [this.colorTex(w, h), this.colorTex(w, h)] : null;
    for (const t of taa ? [this.vel, ...this.taaTex] : []) { this._targets.fbos.push(t.fbo); this._targets.texs.push(t.tex); }
    // §21 ambient occlusion: the solid scene's depth (pre-pass, no multisampling) and two occlusion targets (in turn)
    this.prezDepth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.prezDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.prezFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.prezFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.prezDepth, 0);
    // the pre-pass depth of the cell alone, kept while the view stays (ambientOcclusion); same format as prezDepth
    // (depth blits need identical formats)
    this.prezCache = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.prezCache);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.prezCacheFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.prezCacheFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.prezCache, 0);
    this._prezKey = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);           // half resolution, as the game
    this.aoA = this.colorTex(hw, hh, 'R8'); this.aoB = this.colorTex(hw, hh, 'R8');
    // the occlusion pass also writes each texel's linear depth (aoZ, exact floats, nearest) for the two blur passes:
    // its own target pair aoA + aoZ (saoFbo)
    this.aoZ = this.colorTex(hw, hh, 'R32F');
    gl.bindTexture(gl.TEXTURE_2D, this.aoZ.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.saoFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.saoFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.aoA.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.aoZ.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._targets.fbos.push(this.prezFbo, this.prezCacheFbo, this.aoA.fbo, this.aoB.fbo, this.aoZ.fbo, this.saoFbo);
    this._targets.texs.push(this.prezDepth, this.prezCache, this.aoA.tex, this.aoB.tex, this.aoZ.tex);
    // §24 light shafts at half resolution, two targets (march, then the blur in turn); nearest filtering (depth-aware)
    this.grA = this.colorTex(hw, hh); this.grB = this.colorTex(hw, hh);
    for (const t of [this.grA, this.grB]) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._targets.fbos.push(t.fbo); this._targets.texs.push(t.tex);
    }
    this._tex = [];
    this._taaReset = true;
  }

  // ---------------------------------------------------------------------------------------------------- ground
  makeGround() {
    const gl = this.gl, S2 = 4000, T = S2 / 256;
    const pos = new Float32Array([-S2, -S2, 0, S2, -S2, 0, S2, S2, 0, -S2, S2, 0]);
    const uv = new Float32Array([0, T, T, T, T, 0, 0, 0]);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    let b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 0, 0);
    this.instAttribs();
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // Landscape writes the same G-buffer as the lighting shader (engine-notes §2): albedo, normal, and smoothness /
    // specular = per-draw factors x the layer's _s map (G, R). The factors are set CPU-side and not in the ESM;
    // specular 0.6 is CALIBRATED (sun/shade contrast on landscape asphalt, clear and overcast noon, 2026-10-05).
    const g = { vao, count: 6, indexType: gl.UNSIGNED_INT, z: 0, tex: {}, world: mat4.identity(),
      consts: [[1, 0.5, 0.5, 1, 0], [2, 1, 0.5, 0.5, 0], [3, 0.5, 0, 0.5, 0], [5, 1, 1, 1, 1], [6, 0, 0, 0, 0], [7, 0, 0, 0, 0]],
      mat: { kind: 'lighting', textures: {}, alpha: {}, specular_enabled: true, specular_mult: 0.6, smoothness: 1,
        uv_offset: [0, 0], uv_scale: [1, 1] } };
    g.live = liveValues(g.mat);
    return g;
  }
  setGroundTextures(d, n, s) {
    const g = this.ground;
    this.texture(d, { srgb: true }).then(t => { g.tex.diffuse = t; this.version++; });
    this.texture(n).then(t => { g.tex.normal = t; this.version++; });
    if (s) this.texture(s).then(t => { g.tex.spec = t; this.version++; }); else delete g.tex.spec;
  }

  // ---------------------------------------------------------------------------------------------------- camera
  cameraMatrices(aspect) {
    const c = this.camera;
    const tgt = vec3.add(c.target, c.pan);
    const eye = [tgt[0] + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw), tgt[1] + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      tgt[2] + c.dist * Math.sin(c.pitch)];
    const view = mat4.lookAt(eye, tgt, [0, 0, 1]);
    const fovH = this.settings.fovH * Math.PI / 180;
    const fovV = 2 * Math.atan(Math.tan(fovH / 2) / aspect);
    this.zNear = Math.max(0.5, c.dist * 0.01); this.zFar = 30000;
    const proj = mat4.perspective(fovV, aspect, this.zNear, this.zFar);
    return { eye, view, proj };
  }

  // ---------------------------------------------------------------------------------------------------- redraw on demand
  // Something moves on its own: a playing clip, NiControllerSequence or active controller.
  isAnimating() {
    if (!this.playing || !this.speed) return false;
    if (this.clip && this.skel) return true;
    if (this.clothSim && this.models.some(m => m.visible && m.cloth && m.cloth.some(c => c.active))) return true;
    if (this._psysLive && this.settings.particles !== false) return true;      // particles still emitting or alive
    return this.models.some(m => m.visible && (m.activeSeq || m.liveControllers));
  }
  // Everything a still frame depends on that the UI can change, as one cheap string. settings: a JSON.stringify
  // replacer (sceneKey leaves out the settings only the tonemap reads)
  signature(settings) {
    const c = this.camera, cv = this.canvas;
    let s = `${cv.clientWidth}x${cv.clientHeight}@${window.devicePixelRatio}*${this.renderScale || 1}|${this.fixedSize}|${this.qualityName}|` +
      `${c.target}|${c.pan}|${c.yaw}|${c.pitch}|${c.dist}|${JSON.stringify(this.settings, settings)}|${this.version}|` +
      `${this.time}|${this.groundZ}|${this.sunOverride}|${(this.skyRings || []).length}|`;
    const cmp = this.compare;
    if (cmp) s += `cmp${cmp.split}${cmp.peek ? 'p' : ''}${cmp.twins.size}|`;
    for (const m of this.models) {
      s += m.visible ? '1' : '0';
      for (const sh of m.shapes) s += sh.visible ? '1' : '0';
      s += (m.activeSeq?.name || '') + ';';
    }
    return s;
  }
  // ---------------------------------------------------------------------------------------------------- dynamic resolution
  // While the camera is being moved (poke() from the input handlers) on a GPU that cannot keep 40 fps, the scene is
  // drawn into a smaller part of its targets and scaled up (down to 60 %); the moment the input stops, the next frame
  // is full resolution again. A GPU that keeps up never sees it, and when a smaller picture does not help (the CPU is
  // the limit) it is left at full resolution.
  poke() { this._interactUntil = performance.now() + 350; }
  // the quality tier (quality.js): Ultra holds every knob at the value the renderer always used
  setQuality(name) {
    if (!KNOBS[name] || name === this.qualityName) return;
    this.qualityName = name; this.quality = KNOBS[name]; this.version++;
  }
  adaptScale(now) {
    const last = this._lastFrameAt || 0;
    this._lastFrameAt = now;
    if (now - last > (this.quality.playScale < 1 ? 1000 : 120)) return;   // the first frame after a pause says nothing
    const ft = (now - last) / 1000;
    this._ftEma = this._ftEma ? this._ftEma * 0.85 + ft * 0.15 : ft;
    if (now < (this._dynHold || 0)) return;
    const s = this.dynScale;
    if (s < 1 && this._ftFull && this._ftEma > this._ftFull * 0.95) {       // smaller did not help
      this.dynScale = 1; this._dynHold = now + 15000; return;
    }
    const floor = Math.min(0.6, this.quality.playScale - 0.1);
    if (this._ftEma > 1 / 40 && s > floor) {
      if (s === 1) this._ftFull = this._ftEma;
      this.dynScale = Math.max(floor, Math.round((s - 0.1) * 10) / 10); this._dynHold = now + 500;
    } else if (this._ftEma < 1 / 55 && s < 1) {
      this.dynScale = Math.min(1, Math.round((s + 0.1) * 10) / 10); this._dynHold = now + 500;
    }
  }

  // how long the eye takes to settle (to 0.2 %) after the picture changed: frames keep coming until then
  settleMs() {
    // TAA: after a change seen from a still camera (an hour, a material, a model toggled) a converged pixel takes in
    // 1/17 of the new picture per frame; 1.1 s of frames leaves about 2 % of the old one (16 frames would leave 36 %)
    const taa = this.settings.taa ? 1100 : 0;
    if (!this.settings.exposureAuto) return Math.max(250, taa);
    return Math.max(taa, 1000 * Math.min(10, 6.3 / Math.max(this.env.eyeAdaptSpeed || 3, 0.2)));
  }
  // Called once per display refresh: true if a new frame would look different from the one on screen.
  needsFrame() {
    this.pollLum();
    const sig = this.signature(), now = performance.now();
    if (sig !== this._sig) { this._sig = sig; this._settleUntil = now + this.settleMs(); return true; }
    if (this.isAnimating() || this.snapAdapt) { this._settleUntil = now + this.settleMs(); return true; }
    if (this._lastScale < 1 && now >= (this._interactUntil || 0)) return true;   // input stopped: full resolution again
    if (now < this._settleUntil) return true;                  // the eye is still adapting (on the GPU)
    if (this.settings.taa && (this.taaStill || 0) < TAA_STILL) return true;   // TAA still refining the picture
    if (this._lumReadFrame !== this.frameNo && this.size) {    // settled: one read-back of the final exposure (HUD)
      this._lumReadFrame = this.frameNo; this.readLumAsync();
    }
    return false;
  }

  // The adapted / measured luminance for the HUD and captures: readPixels into a pixel-pack buffer guarded by a
  // fence, collected at the start of a later frame. Only now and then: under load each collection waits for the
  // GPU process to work through what is queued.
  readLumAsync() {
    const gl = this.gl;
    if (this._lumPending.length >= 2) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.adapt[this._ad].fbo);
    // a fresh 16-byte buffer each time: Chrome drops its fast readback copy when a READ buffer is written again
    const pbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this._lumPending.push({ pbo, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), frame: this.frameNo });
    this._lumReadAt = performance.now();
  }
  pollLum() {
    const gl = this.gl;
    while (this._lumPending.length) {
      const r = this._lumPending[0];
      const st = gl.clientWaitSync(r.sync, 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) break;
      gl.deleteSync(r.sync);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._lumPx);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(r.pbo); this._lumPending.shift();
      if (isFinite(this._lumPx[0]) && isFinite(this._lumPx[1])) { this.lumAdapted = this._lumPx[0]; this.lumMeasured = this._lumPx[1]; }
    }
  }

  // ---------------------------------------------------------------------------------------------------- profiling
  // Development aid: R.profile(true) collects GPU and CPU milliseconds per pass (timer queries); R.profile() reads
  // and clears them. Off, each mark costs one property check.
  profile(on) {
    if (on === true) {
      const ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.prof = { ext, cur: null, pending: [], gpu: {}, cpu: {}, n: {}, frames: 0 };
      return true;
    }
    const P = this.prof;
    if (!P) return null;
    this._profPoll(true);
    const out = {};
    for (const k of Object.keys(P.cpu)) out[k] = { gpu: P.n[k] ? +(P.gpu[k] / P.n[k]).toFixed(3) : null,
      cpu: +(P.cpu[k] / Math.max(1, P.frames)).toFixed(3) };
    if (on === false) {               // queries whose result is still on its way go back to the driver too
      for (const r of P.pending) this.gl.deleteQuery(r.q);
      this.prof = null;
    } else Object.assign(P, { gpu: {}, cpu: {}, n: {}, frames: 0 });
    return out;
  }
  _mark(name) {
    const P = this.prof;
    if (!P) return;
    const gl = this.gl, now = performance.now();
    if (P.cur) {
      if (P.ext) { gl.endQuery(P.ext.TIME_ELAPSED_EXT); P.pending.push({ q: P.cur.q, name: P.cur.name }); }
      P.cpu[P.cur.name] = (P.cpu[P.cur.name] || 0) + now - P.cur.t;
      P.cur = null;
    }
    if (name) {
      let q = null;
      if (P.ext) { q = gl.createQuery(); gl.beginQuery(P.ext.TIME_ELAPSED_EXT, q); }
      P.cur = { q, name, t: now };
    }
  }
  _profPoll(wait) {
    const P = this.prof, gl = this.gl;
    if (!P || !P.ext) return;
    if (wait) gl.finish();
    const disjoint = gl.getParameter(P.ext.GPU_DISJOINT_EXT);
    P.pending = P.pending.filter(r => {
      if (!gl.getQueryParameter(r.q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) { P.gpu[r.name] = (P.gpu[r.name] || 0) + gl.getQueryParameter(r.q, gl.QUERY_RESULT) / 1e6; P.n[r.name] = (P.n[r.name] || 0) + 1; }
      gl.deleteQuery(r.q);
      return false;
    });
  }

  // ---------------------------------------------------------------------------------------------------- frame
  // Everything the HDR picture (renderScene: scene, its alpha coverage, depth, bloom, measured luminance) depends on,
  // without the settings only the tonemap reads. aoParams / grParams / lsParams are changed in place (main.js: the
  // user's INI) and skyRings is assigned without a version bump: their contents and identity are compared too.
  sceneKey(w, h) {
    if (!this._sceneRep) {     // read by renderPost only (renderScene asks only whether there is a backdrop)
      const post = new Set(['exposureAuto', 'exposure', 'exposureBias', 'tonemap', 'grade', 'lut', 'showBloom', 'grid']);
      this._sceneRep = (k, v) => post.has(k) ? undefined : k === 'backdrop' ? !!v : v;
    }
    return `${this.signature(this._sceneRep)}${w}x${h}|${this.geomVersion}|${this.cellVersion}|${this.lightsVersion || 0}|` +
      `${this.cellMode}${this.cellVisible}${this.cellFloor}|${JSON.stringify(this.aoParams)}|${JSON.stringify(this.grParams)}|` +
      JSON.stringify(this.lsParams);
  }
  frame(dt) {
    const gl = this.gl;
    this.frameNo++;
    if (this.prof) { this.prof.frames++; this._profPoll(false); this._mark('prep'); }
    if (this.isAnimating()) this.time += dt * this.speed;     // a still scene keeps its time (and its signature)
    for (const m of this.liveModels) {
      const ak = `${this.time}|${m.activeSeq?.name}|${m.seqStart}`;
      if (m._animKey === ak) continue;           // nothing to re-evaluate at the same time
      m._animKey = ak;
      try { this.animate(m, this.time); } catch (e) {
        if (!m._animErr) { m._animErr = true; console.warn(e); this.onWarn && this.onWarn(`${m.name}: animation stopped: ${e.message}`); }
      }
    }
    try { this.computePose(); } catch (e) { console.warn(e); this.pose = null; }
    this.updateAttached();
    this.updateCloth(this.playing ? dt * this.speed : 0);
    this.updateBones();
    // the quality tier's caps apply to the live view; a capture (this.capture) keeps the output it asked for
    const capt = !!this.capture, qk = this.quality;
    const dpr = Math.min(window.devicePixelRatio || 1, capt ? 2 : qk.dprCap) * (this.renderScale || 1) * (capt ? 1 : qk.outScale);
    const w = this.fixedSize ? this.fixedSize[0] : Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = this.fixedSize ? this.fixedSize[1] : Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.resize(w, h);
    const now = performance.now(), moving = !this.fixedSize && now < (this._interactUntil || 0);
    if (moving) this.adaptScale(now); else this._lastFrameAt = 0;
    // below Ultra, anything moving (the camera, an animation) is drawn at the tier's scale or smaller; still: full
    let sc = moving ? this.dynScale : 1;
    if (this.quality.playScale < 1 && !this.fixedSize && (moving || this.isAnimating())) sc = Math.min(sc, this.quality.playScale);
    this._lastScale = sc;
    const sw = Math.max(1, Math.round(w * sc)), sh = Math.max(1, Math.round(h * sc));
    const { eye, view, proj } = this.cameraMatrices(sw / sh);
    this.eye = eye; this._last = { view, proj };
    if (this.settings.evenLight) {               // the even light follows the camera
      const t = vec3.add(this.camera.target, this.camera.pan), d = vec3.norm(vec3.sub(eye, t));
      this.evenEnv().sunDir = vec3.norm([d[0], d[1], d[2] + 0.35]);
    }
    // ---- TAA: this frame's sub-pixel shift (only the drawing uses it; picking, culling of the light grid and the
    // motion vectors use the plain matrices), and how long the picture has been still: a still picture averages its
    // frames evenly and is no longer redrawn after TAA_STILL of them
    const taa = !!this.settings.taa;
    let projR = proj;
    const curVP = mat4.mul(proj, view), viewNoT = new Float32Array(view);
    viewNoT[12] = viewNoT[13] = viewNoT[14] = 0;
    const curSky = mat4.mul(proj, viewNoT);
    if (taa) {
      const j = HALTON[this.frameNo % HALTON.length];
      projR = new Float32Array(proj); projR[8] += 2 * j[0] / sw; projR[9] += 2 * j[1] / sh;
      if (sc !== this._taaScale) { this._taaReset = true; this._taaScale = sc; }
      const key = `${this.signature()}|${this.geomVersion}`;
      this.taaStill = key === this._taaKey && !this._taaReset ? (this.taaStill || 0) + 1 : 0;
      this._taaKey = key;
    }
    this._curVP = curVP;
    this._prevVPUse = this._prevVP || curVP;
    this._skyReproj = taa ? mat4.mul(this._prevSky || curSky, mat4.invert(curSky)) : IDENTITY;   // (TAA_FS only)
    this._prevDelta = taa && this._prevRoot ? mat4.mul(this._prevRoot, mat4.invert(this.playerRoot)) : IDENTITY;
    const env = this.env;
    this.ground.z = this.groundZ ?? Math.min(0, this.sceneBounds(true, false)[0][2]);   // not lifted by a jump
    const skyLut = this.skyLut();
    // ---- a still scene settling (the eye adapting after a change, tonemap-only settings): when nothing the HDR picture
    // depends on changed since the last full frame, that frame's scene, coverage, depth, bloom and measured luminance are
    // still in their targets (nothing else writes them) and a full frame would draw the same bits again (no TAA, so no
    // jitter; nothing animating, so dt reaches nothing but the adaptation): only the adaptation and the tonemap run.
    // Never while profiling (lightboxBench times full frames); R.noReuse = true turns it off (A/B checks)
    const reuseKey = !taa && sc === 1 && !this.prof && !this.noReuse && !this.isAnimating() ? this.sceneKey(w, h) : null;
    const ids = this._sceneIds;
    if (reuseKey !== null && !this.snapAdapt && reuseKey === this._sceneKey && this._sceneOut && ids[0] === this.hdr &&
      ids[1] === this.skyRings && ids[2] === env) {
      this._fastFrames = (this._fastFrames || 0) + 1;
      this.resetState();
      this.setDepthTest(false); this.setCull(false); this.setBlend(false);     // as renderScene leaves them
      gl.disable(gl.SCISSOR_TEST);
      gl.bindVertexArray(this.emptyVao); this._vao = this.emptyVao;
      this.renderPost(w, h, dt, this._sceneOut.scene, this._sceneOut.uvs);
      return;
    }
    this._sceneKey = null;                       // (set again once renderScene has filled the targets)
    this.resetState();

    // ---- sun shadows. The game uses cascades; here two maps: the cell's static objects around the view (kept until
    // the sun moves, the view moves past a 128-texel step or zooms past a 19 % step; a quarter wider than the area
    // the view needs, so the soft fade at its edge stays outside it) and the character group, fitted tightly around
    // it and drawn again only when it moves or animates.
    const sunUp = this.settings.shadows && env.sunDir[2] > 0.0 && !env.noShadows;
    this._worldOn = false; this._actorOn = false; this._farOn = false;
    const CL = this.casterLog(), addsEnd = CL.base + CL.adds.length;
    if (sunUp && this.cellMode && this.cellVisible) {
      const cam = this.camera, c = vec3.add(cam.target, cam.pan);
      const r = 1.25 * Math.pow(2, Math.ceil(Math.log2(Math.min(4000, Math.max(700, cam.dist * 1.1))) * 4) / 4);
      const L = mat4.lookAt(env.sunDir, [0, 0, 0], Math.abs(env.sunDir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]);
      const lc = mat4.transformPoint(L, c), g = 2 * r / this.shadowSize[0] * 128;
      const sx = Math.round(lc[0] / g) * g, sy = Math.round(lc[1] / g) * g, d = -lc[2];
      // (casters placed since the map was drawn are drawn into it: casterLog)
      const key = `${env.sunDir}|${sx}|${sy}|${r}|${CL.epoch}`;
      const touched = (this._cellTouch || 0) !== this._worldTouch;
      if (key !== this._worldKey || CL.world < CL.base || (touched && d !== this._worldD)) {
        this._worldKey = key; this._worldD = d;
        this.worldVP = mat4.mul(mat4.ortho(sx - r, sx + r, sy - r, sy + r, d - 2.5 * r, d + 3 * r), L);
        this._worldR = r;
        this.drawWorldShadow(this.worldVP);
      } else if (CL.world < addsEnd) this.drawWorldShadow(this.worldVP, 0, CL.world);
      CL.world = addsEnd; this._worldTouch = this._cellTouch || 0;
      this._worldOn = true;
      // §24 the light shafts' far sun map: the cell's casters FAR_R around the camera, coarse (kept while the camera
      // stays within an eighth of that and the sun does not move); the cell map above covers only the view's middle
      const gr = env.godRays;
      if (this.settings.godrays !== false && gr && gr.intensity > 0) {
        const e = this.eye || c, gq = FAR_R / 8;
        const fc = [Math.round(e[0] / gq) * gq, Math.round(e[1] / gq) * gq, Math.round(e[2] / gq) * gq];
        // the shafts' march reaches this far from the eye (godRays); casters beyond it are not drawn (drawWorldShadow)
        const reach = Math.min((this.grParams || GR_PARAMS).maxDist, FAR_R);
        const fkey = `${env.sunDir}|${fc}|${reach}|${CL.epoch}`;
        if (fkey !== this._farKey || CL.far < CL.base) {
          this._farKey = fkey;
          this._farReach = { fc, reach, sun: env.sunDir };
          const lf = mat4.transformPoint(L, fc), R = FAR_R * 1.25;
          this.farVP = mat4.mul(mat4.ortho(lf[0] - R, lf[0] + R, lf[1] - R, lf[1] + R, -lf[2] - 3 * R, -lf[2] + 3 * R), L);
          this.drawWorldShadow(this.farVP, 2);
        } else if (CL.far < addsEnd) this.drawWorldShadow(this.farVP, 2, CL.far);
        CL.far = addsEnd;
        this._farOn = true;
      }
    }
    // (none at all without a visible caster of the character group: an empty map shades nothing, the same as no map;
    // nor while its box lies wholly outside the view, where nothing reads it: actorInView)
    if (sunUp && this.actorCasts()) {
      const [lo, hi] = this.sceneBounds();
      const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const r = Math.max(vec3.len(vec3.sub(hi, lo)) / 2, 30) * 1.15;
      const sv = mat4.lookAt(vec3.add(c, vec3.scale(env.sunDir, r * 3)), c, Math.abs(env.sunDir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]);
      const near = r * 0.5, far = r * 6 + ACTOR_REACH;
      this.actorBias = (r * 5.5) / (far - near);        // the same depth bias in world units as a box ending at 6r
      let key = `${env.sunDir}|${c}|${r}|${this.geomVersion}|${this.version}|`;
      for (const m of this.models) {
        key += m.visible ? 'M' : 'm';
        for (const s of m.shapes) {
          key += s.visible ? '1' : '0';
          if (s.visible && s.mat.alpha?.test) key += `${s.live.u_offset},${s.live.v_offset},${s.live.u_scale},${s.live.v_scale};`;
        }
      }
      const vp = mat4.mul(mat4.ortho(-r, r, -r, r, near, far), sv);
      if (this.actorInView(vp, curVP, sw, sh)) {
        if (key !== this._actorKey) {            // (kept while out of view: drawn when it comes into view)
          this._actorKey = key;
          this.actorVP = vp;
          this.drawActorShadow(this.actorVP);
        }
        this._actorOn = true;
      }
    }
    this.updateLightShadows(eye, frustumPlanes(curVP));
    this.casterSettle();
    this.renderScene(w, h, sw, sh, view, projR, eye, dt, skyLut);
    this._sceneKey = reuseKey; this._sceneIds = [this.hdr, this.skyRings, env];
    // this frame becomes the TAA's "last frame" (a shape not drawn this frame starts again from the root's motion)
    this._prevVP = curVP; this._prevSky = curSky; this._prevRoot = new Float32Array(this.playerRoot);
    for (const m of this.models) for (const s of m.shapes) { s._prevW = s._prevWNext || null; s._prevWNext = null; }
  }

  // a visible shape of the character group the actor map and light layers draw (drawActorShadow / drawLightLayer)
  actorCasts() {
    for (const m of this.models) if (m.visible) for (const s of m.shapes) {
      const mt = s.mat;
      if (s.visible && mt.kind === 'lighting' && !(mt.alpha && mt.alpha.blend) && !mt.refraction) return true;
    }
    return false;
  }
  // whether the character map's box can meet what the view reads: every point drawn, lit, decalled or marched by the
  // light shafts lies inside the camera's four side planes (any depth, the eye included). The box is out when all its
  // corners lie beyond one of them, with a margin of 8 pixels (TAA jitter is under one)
  actorInView(vp, curVP, sw, sh) {
    const inv = mat4.invert(vp), mx = 1 + 16 / Math.max(1, sw), my = 1 + 16 / Math.max(1, sh), out = [0, 0, 0, 0];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const p = mat4.transformPoint(inv, [x, y, z]);
      const cx = curVP[0] * p[0] + curVP[4] * p[1] + curVP[8] * p[2] + curVP[12];
      const cy = curVP[1] * p[0] + curVP[5] * p[1] + curVP[9] * p[2] + curVP[13];
      const cw = curVP[3] * p[0] + curVP[7] * p[1] + curVP[11] * p[2] + curVP[15];
      if (cx > mx * cw) out[0]++; if (cx < -mx * cw) out[1]++;
      if (cy > my * cw) out[2]++; if (cy < -my * cw) out[3]++;
    }
    return !out.includes(8);
  }
  // whether a cell template's own animation (played only for one with particle systems: updateParticles) moves what
  // the shadow passes read of an alpha-tested lit caster: its UV offset / scale (SHADOW_FS / LSHADOW_FS mUV; the alpha
  // test reference is the material's own). Its controllers and its active sequence's channels, as animate() applies them
  animatesCasterUV(tpl) {
    if (!tpl.psysDefs?.length) return false;
    const blocks = new Set(tpl.shapes.filter(s => s.mat.kind === 'lighting' && s.mat.alpha?.test).map(s => s.shader_block));
    if (!blocks.size) return false;
    const uv = (kind, vk, v) => kind === 'lighting' && vk === 'float' && /^[uv]_(offset|scale)$/.test(LIGHTING_FLOAT[v] || '');
    for (const c of tpl.controllers)
      if ((c.flags & 8) && c.interp && c.interp.kind !== 'unsupported' && c.shader_kind && uv(c.shader_kind, c.value_kind, c.variable) && blocks.has(c.target)) return true;
    for (const ch of tpl.activeSeq?.channels || [])
      if (ch.shader_kind && ch.interp?.keys && uv(ch.shader_kind, ch.value_kind, ch.variable) && blocks.has(ch.shader_block)) return true;
    return false;
  }
  // a batch the cell's shadow maps and light layers draw (the filter of drawWorldShadow / drawLightLayer)
  isCaster(b) {
    const sh = b.sh, m = sh.mat;
    return !b.lod && sh.visible && !b.blend && m.kind === 'lighting' && !m.refraction;
  }
  // a change of the cell no shadow map sees (distant LOD shown or hidden): see placeInstances for the exception
  nonCasterChange() { this.cellTouched(); if (this._casterAnim) this.casterEpoch(); }
  // a change after which the cell map used to be drawn again whatever it changed (placements of any kind, distant
  // LOD, alpha-tested template textures, the cell eye): the map is still drawn again then if the view moved along the
  // sun since it was drawn (its depth range follows the view's centre, frame()), as it was before, so the depths it
  // holds stay those of the same moment
  cellTouched() { this._cellTouch = (this._cellTouch || 0) + 1; }
  // The cell's shadow casters as the sun maps and light layers see them. epoch: a change after which every map is
  // drawn again as a whole (another cell; an alpha-tested caster's texture arriving after a map drew it with the white
  // stand-in). adds: casters placed since (template placements, landscape quads), which a map that is still valid draws
  // into itself without clearing it: a depth-only map drawn with LEQUAL from a 1.0 clear holds the nearest depth of
  // everything drawn into it, in any order and any number of calls, so it ends exactly as a whole redraw. base: the log
  // position of adds[0]; world / far: how far the two sun maps have drawn; seen: the log's end when a map last drew.
  // cellVersion (probe grid, layers with the character) still changes with every add.
  casterLog() { return this._clog || (this._clog = { epoch: 0, adds: [], base: 0, seen: 0, world: 0, far: 0 }); }
  casterEpoch() {
    this.cellTouched();
    const CL = this.casterLog();
    CL.epoch++; CL.base += CL.adds.length; CL.adds = [];
    this.cellVersion++;
  }
  // [{ b: batch, i0, i1 } (its new instances) | { q: landscape quad }]
  casterAdds(list) {
    if (this._casterAnim) { this.casterEpoch(); return; }
    const CL = this.casterLog();
    for (const a of list) { if (a.b && a.b._addAt === undefined) a.b._addAt = CL.base + CL.adds.length; CL.adds.push(a); }
    this.cellVersion++;
  }
  // an alpha-tested caster's texture arrived after maps drew it with the white stand-in: each map in which one of its
  // instances passed the cull is drawn again as a whole (the sun maps: the planes and reach they were drawn with; a
  // light's faces: those whose list holds it); maps that culled all of them hold nothing of it
  casterRetexture(b) {
    const W = this._worldCull, F = this._farCull;
    if (this._worldKey && W && b.inst.some(it => W(it.center, it.radius))) this._worldKey = null;
    if (this._farKey && F && b.inst.some(it => F(it.center, it.radius))) this._farKey = null;
    const S = this.lightShadow;
    if (S) for (const e of [...S.entries.values(), ...S.parked.values()]) {
      if (!e.faces) continue;
      e.faces.forEach((f, k) => { if (f && f.runs.some(r => r[0] === b.sh)) { e.keys[k] = ''; f.ver++; } });
    }
    this.cellVersion++;
  }
  // a map is drawn (as a whole or with the adds): everything placed so far may now be in a map, with the white
  // stand-in for an alpha-tested caster whose texture has not arrived (loadShapeTextures)
  casterSeen() { const CL = this.casterLog(); CL.seen = CL.base + CL.adds.length; }
  // after the frame's shadow maps: one that did not take the adds (not drawn this frame) is drawn again as a whole
  // when it is next used, and the log forgets them
  casterSettle() {
    const CL = this.casterLog(), end = CL.base + CL.adds.length;
    if (!CL.adds.length) return;
    if (CL.world < end) this._worldKey = null;
    if (CL.far < end) this._farKey = null;
    if (this.lightShadow) {
      for (const e of this.lightShadow.entries.values()) if (e.cur !== end) { e.castersKey = ''; e.keys.fill(''); }
      for (const [l, e] of this.lightShadow.parked) {
        const got = this.lightAppend(l, e);
        if (got) got.forEach((g, k) => { if (g) e.keys[k] = ''; });
        if (e.cur !== end) { e.castersKey = ''; e.keys.fill(''); }
      }
    }
    CL.base = end; CL.adds = [];
  }
  // dev counters (shadow work): full redraws of the cell / far / character sun maps and of light layers
  // (and the casters drawn into a map as it is: worldAdd / farAdd / layerAdds; layers copied from the pool: layerCopies)
  _countShadow(k) {
    const c = this._shadowStats || (this._shadowStats = { world: 0, far: 0, actor: 0, layers: 0, worldAdd: 0, farAdd: 0, layerAdds: 0, layerCopies: 0 });
    c[k]++;
    if (k === 'world' || k === 'far' || k === 'layers') this._shadowRedraws = (this._shadowRedraws || 0) + 1;
  }
  // the cell's shadow casters (solid and alpha-tested lit objects, the landscape), one instanced call per template shape
  // from: a casterLog position: only the casters placed since, drawn into the map as it is (the same cull, programs and
  // state as the whole map)
  // The far map (2) holds only the casters the shafts' march can see: it reads the map at points within `reach` of the
  // eye, the eye stays within half a step's diagonal (FAR_R / 16 x sqrt 3) of the map's centre fc, a bilinear read
  // takes texels within 1.5 texels of its point, and a caster covers texels within its radius of its centre, all seen
  // along the sun (light-space x / y). A caster further from fc across the sun than their sum changes no texel read.
  drawWorldShadow(vp, map = 0, from = null) {
    this._mark('shadow');
    const planes = frustumPlanes(vp), ib = this.inst.world, items = [];
    let vis = (c, r) => sphereVisible(planes, c, r);
    if (map === 2) {
      const F = this._farReach, fc = F.fc, sd = F.sun, s2 = sd[0] * sd[0] + sd[1] * sd[1] + sd[2] * sd[2];
      const lim0 = F.reach + FAR_R / 16 * Math.sqrt(3) + 2 * (2 * FAR_R * 1.25 / this.shadowSize[2]);
      vis = (c, r) => {
        const vx = c[0] - fc[0], vy = c[1] - fc[1], vz = c[2] - fc[2], a = vx * sd[0] + vy * sd[1] + vz * sd[2], lim = lim0 + r;
        return vx * vx + vy * vy + vz * vz - a * a / s2 <= lim * lim && sphereVisible(planes, c, r);
      };
    }
    ib.n = 0;
    if (from === null) {
      this._countShadow(map ? 'far' : 'world');
      if (map === 2) this._farCull = vis; else this._worldCull = vis;
      for (const b of this.batches) {
        const sh = b.sh, m = sh.mat;
        if (b.lod || !sh.visible || b.blend || m.kind !== 'lighting' || m.refraction) continue;
        const base = ib.n;
        for (const it of b.inst) if (vis(it.center, it.radius)) this.pushInst(ib, it.world);
        if (ib.n > base) items.push([sh, base, ib.n - base]);
      }
      for (const q of this.lands) if (vis(q.center, q.radius)) items.push([q, this.pushInst(ib, q.world), 1]);
    } else {
      const CL = this.casterLog();
      for (const a of CL.adds.slice(from - CL.base)) {
        if (a.q) { if (vis(a.q.center, a.q.radius)) items.push([a.q, this.pushInst(ib, a.q.world), 1]); continue; }
        const b = a.b, base = ib.n;
        if (!this.isCaster(b)) continue;
        for (let i = a.i0; i < a.i1; i++) { const it = b.inst[i]; if (vis(it.center, it.radius)) this.pushInst(ib, it.world); }
        if (ib.n > base) items.push([b.sh, base, ib.n - base]);
      }
      if (!items.length) return;                 // nothing new reaches this map
      this._countShadow(map ? 'farAdd' : 'worldAdd');
    }
    this.casterSeen();
    this.drawCasters(map, vp, ib, items, from !== null);
  }
  drawActorShadow(vp) {
    this._mark('shadowActor');
    this._countShadow('actor');
    const ib = this.inst.actor, items = [];
    ib.n = 0;
    for (const m of this.models) if (m.visible) for (const s of m.shapes) {
      const mt = s.mat;
      if (!s.visible || mt.kind !== 'lighting' || (mt.alpha && mt.alpha.blend) || mt.refraction) continue;
      items.push([s, this.pushInst(ib, this.playerWorld(s)), 1]);
    }
    this.drawCasters(1, vp, ib, items);
  }
  // keep: draw into the map as it is (casterLog adds)
  drawCasters(i, vp, ib, items, keep = false) {
    const gl = this.gl;
    if (!this.shadowFbo[i]) { const t = this.depthTarget(this.shadowSize[i]); this.shadowTex[i] = t.tex; this.shadowFbo[i] = t.fbo; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo[i]);
    gl.viewport(0, 0, this.shadowSize[i], this.shadowSize[i]);
    this.setDepthTest(true); this.setDepthMask(true);
    if (!keep) gl.clear(gl.DEPTH_BUFFER_BIT);
    this.setCull(false); this.setBlend(false); this.setOffset('shadow');
    this.uploadInst(ib);
    const md = this._md;
    for (const [s, base, n] of items) {
      const clip = !!s.mat.alpha?.test;
      const p = this.progs.shadow[s.skinData ? 1 : 0][clip ? 1 : 0];
      this.useProg(p);
      if (p._vp !== vp) { p._vp = vp; this.um4(p, 'uShadowVP', vp); }
      if (clip) { this.litMaterial(s, md); this.bindMaterial(s, md); this.bindUnit(0, s.tex.diffuse?.tex || this.white); }
      if (s.skinData) this.bindBones(s.skinData);
      this.drawInstanced(s, ib, base, n);
    }
    this.setOffset(false);
  }

  // ---------------------------------------------------------------------------------------------------- §23 light shadows
  // a depth texture array (comparison sampling): the light maps, or a 1 x 1 stand-in
  depthArray(size, layers) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this._tex = [];                              // the unit caches no longer know what is bound
    return t;
  }
  lsDummyUbo() {
    if (!this._lsDummyUbo) {
      const gl = this.gl;
      this._lsDummyUbo = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, this._lsDummyUbo);
      gl.bufferData(gl.UNIFORM_BUFFER, (LS_MAX * 4 + LS_LAYERS * 16) * 4, gl.DYNAMIC_DRAW);
    }
    return this._lsDummyUbo;
  }
  // Which shadow-casting lights get a map this frame, their layers, and the layers to draw again. The game's choice is
  // not traced; here: the lights whose sphere is in view within the shadow distance (fShadowDistance), nearest the
  // camera first, up to LS_MAX lights / LS_LAYERS layers. A light keeps its layers while it stays chosen; a layer is
  // drawn again when the cell changes, or the character moves in it. A light no longer chosen is parked: its layers
  // stay as they are until a newly chosen light needs them (oldest parked first), and if it is chosen again first, the
  // same keys decide which of them to draw again.
  updateLightShadows(eye, planes) {
    const gl = this.gl, P = this.lsParams || LS_PARAMS;
    const S = this.lightShadow || (this.lightShadow = { tex: null, fbo: null, ubo: null, entries: new Map(), parked: new Map(), free: new Array(LS_LAYERS).fill(true), slotKey: '' });
    const on = this.settings.lightShadows !== false && this.cellMode && this.cellVisible;
    const cand = [];
    if (on) for (const l of this.pointLights) {
      if (!l.shadow || !sphereVisible(planes, l.pos, l.radius)) continue;
      const d = Math.max(0, Math.hypot(l.pos[0] - eye[0], l.pos[1] - eye[1], l.pos[2] - eye[2]) - l.radius);
      if (d <= (P.distance || 3000)) cand.push([d, l]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const chosen = [];
    let layers = 0;
    for (const [d, l] of cand) {
      const n = l.shadow === 1 ? 1 : 6;
      if (chosen.length >= Math.min(LS_MAX, this.quality.lsMax) || layers + n > LS_LAYERS) continue;
      chosen.push([d, l]); layers += n;
    }
    // release the layers of lights no longer chosen, then place the new ones: a cube light in a free group of six
    // (bases 0, 6, ... 42), a spotlight in a free layer of a group that already holds spotlights, else of an empty group.
    // Every chosen light then takes one group, LS_MAX of them fill LS_LAYERS, so a new cube light always finds a group
    // (parked: not with the light shadows switched off, nor for lights of an earlier light list; and never while an
    // animated alpha-tested caster makes the time a layer was drawn visible: placeInstances)
    const keep = new Set(chosen.map(c => c[1]));
    const release = (l, e) => { for (let i = 0; i < e.n; i++) S.free[e.base + i] = true; };
    const park = this.settings.lightShadows !== false && !this._casterAnim;
    if (S.parked.size && (!park || this._lsLights !== this.pointLights)) { for (const [l, e] of S.parked) release(l, e); S.parked.clear(); }
    this._lsLights = this.pointLights;
    for (const [l, e] of S.entries) if (!keep.has(l)) {
      S.entries.delete(l); l._lsSlot = -1;
      if (!park) { release(l, e); continue; }
      for (let k = 0; k < e.n; k++) if (!e.keys[k].startsWith('e')) e.keys[k] = '';    // the character: drawn again
      S.parked.set(l, e);
    }
    for (const l of this.pointLights) if (!keep.has(l)) l._lsSlot = -1;
    const place = (n) => {
      let base = -1;
      if (n === 6) {
        for (let g = 0; g + 6 <= LS_LAYERS && base < 0; g += 6) if (S.free.slice(g, g + 6).every(f => f)) base = g;
      } else {
        let empty = -1;
        for (let g = 0; g + 6 <= LS_LAYERS && base < 0; g += 6) {
          const used = S.free.slice(g, g + 6).some(f => !f), at = S.free.indexOf(true, g);
          if (at < 0 || at >= g + 6) continue;
          if (used) base = at; else if (empty < 0) empty = at;
        }
        if (base < 0) base = empty;
      }
      return base;
    };
    for (const [, l] of chosen) {
      if (S.entries.has(l)) continue;
      const pe = S.parked.get(l);
      if (pe) { S.parked.delete(l); S.entries.set(l, pe); continue; }
      const n = l.shadow === 1 ? 1 : 6;
      let base = place(n);
      while (base < 0 && S.parked.size) {        // the oldest parked lights give their layers up
        const [ol, oe] = S.parked.entries().next().value;
        S.parked.delete(ol); release(ol, oe);
        base = place(n);
      }
      for (let k = 0; k < n; k++) S.free[base + k] = false;
      S.entries.set(l, { base, n, keys: new Array(n).fill(''), casters: null, castersKey: '', faces: null, cur: 0, mats: null });
    }
    const slotKey = chosen.map(c => c[1].id + ':' + S.entries.get(c[1]).base).join(',');
    if (!chosen.length) { S.slotKey = slotKey; return; }
    if (!S.tex) {
      S.tex = this.depthArray(LS_SIZE, LS_LAYERS);
      S.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.fbo); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);   // depth only
    }
    if (!S.ubo) {
      S.ubo = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, S.ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, (LS_MAX * 4 + LS_LAYERS * 16) * 4, gl.DYNAMIC_DRAW);
      S.data = new Float32Array(LS_MAX * 4 + LS_LAYERS * 16);
    }
    // the character group's sphere and state: the layers it stands in are drawn again whenever it moves or animates
    // (a group with no visible caster stands in none: sceneBounds' stand-in box at the origin would draw nothing there)
    const charCasts = this.actorCasts();
    const [lo, hi] = this.sceneBounds(true, true);
    const cc = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], cr = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    let charKey = `${this.geomVersion}|${Array.from(this.playerRoot).join(',')}|`;
    for (const m of this.models) { charKey += m.visible ? 'M' : 'm'; for (const sh of m.shapes) charKey += sh.visible ? '1' : '0'; }
    this._mark('lightShadow');
    const D = S.data, CL = this.casterLog(), addsEnd = CL.base + CL.adds.length, epoch = String(CL.epoch);
    chosen.forEach(([dcam, l], slot) => {
      const e = S.entries.get(l);
      l._lsSlot = slot;
      if (!e.mats) e.mats = this.lightShadowMatrices(l);
      // casters placed since the light's list was made (casterLog): added to the list and to each face's, and drawn
      // into the faces they reach (layers with the character are drawn again as a whole: their key holds cellVersion)
      const fresh = this.lightAppend(l, e);
      // the game's map halves its resolution every flocalShadowMapHalveEveryXUnit from the camera; its filter reaches
      // 3 (uiShadowFilter 3), 1 (2) or half a texel (1) of that map: an angle, here at least one texel of ours
      const res = Math.max(64, (P.resolution || 2048) / Math.pow(2, Math.floor(dcam / Math.max(1, P.halve_every || 750))));
      // (an angle: ~3 / resolution radians per texel of the game's paraboloid map), here in uv units of this light's
      // layers (a cube face spans tan 1 each side, a spotlight tan of half its FOV), at least 3/4 of a texel
      const taps = P.filter >= 3 ? 3 : P.filter >= 2 ? 1 : 0.5;
      const tanHalf = l.shadow === 1 ? Math.tan(Math.min(85, Math.acos(Math.max(-1, Math.min(1, l.cone))) * 180 / Math.PI + 1) * Math.PI / 180) : 1;
      D.set([e.base, e.n, 1 / l.radius, Math.max(taps * 3 / res / (2 * tanHalf), 0.75 / LS_SIZE)], slot * 4);
      for (let k = 0; k < e.n; k++) D.set(e.mats[k], LS_MAX * 4 + (e.base + k) * 16);
      const charNear = charCasts && Math.hypot(cc[0] - l.pos[0], cc[1] - l.pos[1], cc[2] - l.pos[2]) < l.radius + cr;
      for (let k = 0; k < e.n; k++) {
        const fp = e.mats[k + e.n];                 // the face's planes in world space
        const withChar = charNear && sphereVisible(fp, cc, cr);
        const key = withChar ? `${this.cellVersion}|${charKey}` : `e${CL.epoch}`;
        if (e.keys[k] !== key) { e.keys[k] = key; this.drawLightLayer(l, e, k, withChar); }
        else if (fresh && fresh[k]) this.drawLightLayer(l, e, k, false, fresh[k]);
      }
      if (e.castersKey === epoch) e.cur = addsEnd;
    });
    gl.bindBuffer(gl.UNIFORM_BUFFER, S.ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    S.slotKey = slotKey;
  }
  // per layer: the light-relative view-projection, then (after all of them) the world-space planes of each layer
  lightShadowMatrices(l) {
    const near = Math.max(0.5, (l.near || 0) / Math.sqrt(3)), far = Math.max(near * 2, l.radius);
    const T = mat4.identity(); T[12] = -l.pos[0]; T[13] = -l.pos[1]; T[14] = -l.pos[2];
    const out = [], planes = [];
    const views = l.shadow === 1
      ? [[l.dir, Math.abs(l.dir[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1], Math.min(170, Math.acos(Math.max(-1, Math.min(1, l.cone))) * 360 / Math.PI + 2)]]
      : CUBE_FACES.map(([d, up]) => [d, up, 90]);
    for (const [d, up, fov] of views) {
      const vp = mat4.mul(mat4.perspective(fov * Math.PI / 180, 1, near, far), mat4.lookAt([0, 0, 0], d, up));
      out.push(vp); planes.push(frustumPlanes(mat4.mul(vp, T)));
    }
    return out.concat(planes);
  }
  // the pool of light-shadow layers with the casters alone (drawLightLayer), LRU: 12 layers of LS_SIZE^2 (24 MiB), made
  // when a layer with the character is first drawn, dropped with the cell. A slot is valid for its entry, face, face
  // list and that list's version (adds and late alpha-tested textures change it)
  lsPool() {
    const S = this.lightShadow;
    if (!S.pool) {
      const gl = this.gl, n = 12, P = { tex: this.depthArray(LS_SIZE, n), fbo: gl.createFramebuffer(), rfbo: gl.createFramebuffer(),
        slots: new Array(n).fill(null), tick: 0 };
      for (const f of [P.fbo, P.rfbo]) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
      S.pool = P;
    }
    return S.pool;
  }
  // casters placed since a light's list was made (casterLog): added to the list and to each face's; per face, the new
  // ones it sees (or null), or null for none. A list of an earlier epoch is left to be made again
  lightAppend(l, e) {
    const CL = this.casterLog(), end = CL.base + CL.adds.length;
    if (e.castersKey !== String(CL.epoch)) return null;
    if (e.cur < CL.base) { e.castersKey = ''; e.keys.fill(''); return null; }
    if (e.cur >= end) return null;
    const add = this.lightCasters(l, CL.adds.slice(e.cur - CL.base));
    e.cur = end;
    if (!add.length) return null;
    e.casters.push(...add);
    return e.faces.map((F, k) => {
      if (!F) return null;                       // not drawn since the list was made: made from the list when it is
      const planes = e.mats[k + e.n], got = [];
      let n = 0;
      for (const [sh, inst] of add) {
        const v = inst.filter(it => sphereVisible(planes, it.center, it.radius));
        if (v.length) { got.push([sh, v]); n += v.length; }
      }
      if (!n) return null;
      const data = new Float32Array(F.data.length + n * 16);
      data.set(F.data);
      let o = F.data.length;
      for (const [sh, v] of got) { F.runs.push([sh, v.length]); for (const it of v) { data.set(it.world, o); o += 16; } }
      F.data = data; F.n += n; F.ver++;
      return got;
    });
  }
  // the casters within a light's reach among [{ b: batch, i0, i1 } | { q: landscape quad }]: [[shape, instances]]
  lightCasters(l, list) {
    const p = l.pos, R = l.radius, out = [];
    const near = (c, r) => (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2 < (R + r) ** 2;
    for (const a of list) {
      if (a.q) { if (near(a.q.center, a.q.radius)) out.push([a.q, [{ world: a.q.world, center: a.q.center, radius: a.q.radius }]]); continue; }
      if (!this.isCaster(a.b)) continue;
      const inst = (a.i0 === 0 && a.i1 === a.b.inst.length ? a.b.inst : a.b.inst.slice(a.i0, a.i1)).filter(it => near(it.center, it.radius));
      if (inst.length) out.push([a.b.sh, inst]);
    }
    return out;
  }
  // one layer of a light's map: the cell's casters in reach of the light (and the character when it stands there);
  // fresh: only these casters [[shape, instances]], drawn into the layer as it is (casterLog adds).
  // A layer with the character (drawn again each frame it animates there) starts from a copy of the same layer with
  // the casters alone, kept in a small pool (lsPool): a depth blit of the same format copies the values exactly, and
  // the character drawn into it with LEQUAL leaves each texel at the nearest of both, as drawing all of them at once
  drawLightLayer(l, e, k, withChar, fresh = null) {
    const gl = this.gl, S = this.lightShadow, ib = this.inst.lshadow, items = [];
    let pooled = false;
    if (fresh) {
      this._countShadow('layerAdds');
      ib.n = 0;
      for (const [sh, inst] of fresh) { const base = ib.n; for (const it of inst) this.pushInst(ib, it.world); items.push([sh, base, inst.length]); }
    } else {
      const epoch = String(this.casterLog().epoch);
      if (e.castersKey !== epoch) {              // the cell's casters within the light's reach
        e.castersKey = epoch;
        e.casters = this.lightCasters(l, [...this.batches.map(b => ({ b, i0: 0, i1: b.inst.length })), ...this.lands.map(q => ({ q }))]);
        e.faces = new Array(e.n).fill(null);
      }
      // the face's casters, culled once per caster list (same order as culling them here each time): their matrices
      // packed in draw order, and the runs [shape, count]
      let F = e.faces[k];
      if (!F) {
        const planes = e.mats[k + e.n], runs = [], seen = [];
        let n = 0;
        for (const [sh, inst] of e.casters) {
          const worlds = inst.filter(it => sphereVisible(planes, it.center, it.radius));
          if (worlds.length) { runs.push([sh, worlds.length]); seen.push(worlds); n += worlds.length; }
        }
        const data = new Float32Array(n * 16);
        let o = 0;
        for (const list of seen) for (const it of list) { data.set(it.world, o); o += 16; }
        F = e.faces[k] = { runs, data, n, ver: 0 };
      }
      const casters = () => {
        if (ib.data.length < F.data.length + 16 * 64) ib.data = new Float32Array(Math.max(ib.data.length * 2, F.data.length + 16 * 64));
        ib.data.set(F.data, 0);
        ib.n = F.n;
        let at = 0;
        for (const [sh, n] of F.runs) { items.push([sh, at, n]); at += n; }
      };
      if (withChar && this.lsPoolOn !== false) {
        // the casters alone: from the pool, else drawn into a pool layer first; then copied into the live layer
        const P = this.lsPool();
        let slot = P.slots.findIndex(x => x && x.e === e && x.k === k && x.F === F && x.ver === F.ver);
        if (slot < 0) {
          this._countShadow('layers');
          slot = P.slots.indexOf(null);
          if (slot < 0) slot = P.slots.reduce((a, x, i) => (x.used < P.slots[a].used ? i : a), 0);
          P.slots[slot] = { e, k, F, ver: F.ver, used: 0 };
          casters();
          this.casterSeen();
          this.lsPass(l, e, k, P.fbo, P.tex, slot, ib, items, true);
          items.length = 0;
        } else this._countShadow('layerCopies');
        P.slots[slot].used = ++P.tick;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, P.rfbo);
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, P.tex, 0, slot);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, S.fbo);
        gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, S.tex, 0, e.base + k);
        this.setDepthMask(true);
        gl.blitFramebuffer(0, 0, LS_SIZE, LS_SIZE, 0, 0, LS_SIZE, LS_SIZE, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        ib.n = 0;
        pooled = true;
      } else {
        this._countShadow('layers');
        casters();
      }
      if (withChar) for (const m of this.models) if (m.visible) for (const s of m.shapes) {
        const mt = s.mat;
        if (!s.visible || mt.kind !== 'lighting' || (mt.alpha && mt.alpha.blend) || mt.refraction) continue;
        items.push([s, this.pushInst(ib, this.playerWorld(s)), 1]);
      }
    }
    if (!pooled) this.casterSeen();
    this.lsPass(l, e, k, S.fbo, S.tex, e.base + k, ib, items, !fresh && !pooled);
  }
  // draw items into one layer of a light-shadow array (clear: from a 1.0 clear, else into it as it is)
  lsPass(l, e, k, fbo, tex, layer, ib, items, clear) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, tex, 0, layer);
    gl.viewport(0, 0, LS_SIZE, LS_SIZE);
    this.setDepthTest(true); this.setDepthMask(true); this.setOffset(false);
    if (clear) gl.clear(gl.DEPTH_BUFFER_BIT);
    this.setCull(false); this.setBlend(false);
    if (!items.length) return;
    this.uploadInst(ib);
    const vp = e.mats[k], md = this._md;
    for (const [s, base, n] of items) {
      const clip = !!s.mat.alpha?.test;
      const prog = this.progs.lsCast[s.skinData ? 1 : 0][clip ? 1 : 0];
      this.useProg(prog);
      // program uniforms persist: set only for another layer (vp: the entry's own matrix of that face) or light
      if (prog._lsVP !== vp || prog._lsL !== l) {
        prog._lsVP = vp; prog._lsL = l;
        this.um4(prog, 'uShadowVP', vp); this.u3f(prog, 'uLightPos', l.pos);
        this.u2f(prog, 'uLSRange', l.near || 0, 1 / l.radius);
      }
      if (clip) { this.litMaterial(s, md); this.bindMaterial(s, md); this.bindUnit(0, s.tex.diffuse?.tex || this.white); }
      if (s.skinData) this.bindBones(s.skinData);
      this.drawInstanced(s, ib, base, n);
    }
  }

  // ---- the frame's uniform block: camera, sun, ambient, fog, shadow maps, placed lights
  fillFrame(view, proj, eye, w, h, sw, sh) {
    const F = this.frameData, env = this.env, st = this.settings;
    F.set(view, FR.view); F.set(proj, FR.proj); F.set(this.worldVP, FR.sh); F.set(this.actorVP, FR.sh2);
    F.set(eye, FR.cam); F.set(env.sunDir, FR.sun); F.set(env.sunColor, FR.sunCol);
    env.ambRows.forEach((r, i) => F.set(r, FR.amb + 4 * i));
    const f = env.fog, fogOn = !!(f && st.fog);
    if (f) {
      F.set([f.near, f.far, f.power, f.max], FR.fogA);
      F.set([f.near_height_mid ?? 0, f.near_height_range ?? 1e9, f.far_height_mid ?? 0, f.far_height_range ?? 1e9], FR.fogH);
      const fn = env.fogNear || [0, 0, 0], ff = env.fogFar || fn;
      F.set(fn, FR.fogN); F[FR.fogN + 3] = f.high_density_scale ?? 1;
      F.set(ff, FR.fogF); F.set(env.fogNearHigh || fn, FR.fogNH); F.set(env.fogFarHigh || ff, FR.fogFH);
    }
    const L = this._lightGrid;
    F.set([this._worldOn ? 1 : 0, this._actorOn ? 1 : 0, fogOn ? 1 : 0, L && L.on ? 1 : 0], FR.flags);
    const [n0, n1] = this.shadowSize;
    F.set([1 / n0, 1 / n0, 1 / n1, 1 / n1], FR.texel);
    F.set([1 / 1.25, this.actorBias || 1, 0.04, 0], FR.bias);     // cell map: the depth bias of the box it widens
    F.set([w, h, this.zNear, this.zFar], FR.screen);
    F.set(st.skinTint, FR.tint); F[FR.tint + 3] = st.skinTintAmount;
    F.set([sw / w, sh / h, 0, 0], FR.res);
    if (L && L.on) {
      F.set([L.tx, L.ty, L.sz, L.clusterStart], FR.cluster);
      F.set([L.zscale, L.near, sw / L.tx, sh / L.ty], FR.clusterZ);
      F.set([L.indexStart, 0, 0, 0], FR.clusterI);
    }
    F[FR.clusterI + 1] = st.specAA === false ? 0 : 1;
    F[FR.clusterI + 2] = this._aoOn ? 1 : 0;                   // §21 the lit shaders read this frame's occlusion
    // the editors' look (shaders.js editorLook): 1 + the character's heading (its light rig turns with it)
    F[FR.clusterI + 3] = st.evenLight ? 1 + (((this.playerHeading || 0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : 0;
    F.set(this._prevVPUse || IDENTITY, FR.prevVP); F.set(this._curVP || IDENTITY, FR.curVP);
    const gl = this.gl;
    // (the block's storage is allocated once, in the constructor: the same bytes, no new allocation per frame)
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, F);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND.Frame, this.frameUbo);
  }

  // §21 Screen-space ambient occlusion, as the game's SAO (engine-notes §21): the depth of the solid surfaces (the main
  // pass's own instances, matrices and jitter, so it lines up per pixel), the occlusion from it, then a depth-aware
  // blur across and down. The result (aoA) is read by the lit shaders at their own pixel.
  ambientOcclusion(lists, sw, sh, proj) {
    const gl = this.gl;
    this._mark('ao');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.prezFbo);
    gl.viewport(0, 0, sw, sh);
    this.setDepthMask(true); this.setDepthTest(true); this.setBlend(false);
    // The cell's part (its items live in inst.cell, cellLists) is kept in prezCache while the view and the cell stay:
    // then only the character group and the floor are drawn on a copy of it. Depth alone with LEQUAL ends at the
    // nearest surface per pixel whatever the order, so the result is the same as drawing everything. Alpha-tested
    // cell shapes cut by an animated texture placement (a template's controllers) make it miss. A view seen for the
    // first time is drawn as before (no copy): only the second frame of a still view fills the cache, so a moving
    // camera or TAA's jitter (a new view every frame) costs nothing extra.
    const cell = this.inst.cell, C = this._cellLists;
    let fresh = false, cached = false;
    if (C && this.prezCacheFbo && (C.opaque.length || C.clip.length || C.lands.length)) {
      const uv = [];
      for (const list of [C.opaque, C.clip]) for (const it of list) {
        const m = it.s.mat;
        if (m.kind !== 'effect' && m.alpha && m.alpha.test) { const lv = it.s.live; uv.push(lv.u_offset, lv.v_offset, lv.u_scale, lv.v_scale); }
      }
      // (the Frame block's view and projection as the shaders read them, not just their product the lists keep)
      const key = `${C.serial}|${sw}|${sh}|${this.frameData.subarray(FR.view, FR.view + 16)}|${this.frameData.subarray(FR.proj, FR.proj + 16)}|${uv}`;
      cached = key === this._prezKey;
      fresh = !cached && key === this._prezLast;
      if (fresh) this._prezKey = key;
      this._prezLast = key;
    } else this._prezLast = null;
    if (cached) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.prezCacheFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.prezFbo);
      gl.blitFramebuffer(0, 0, this.size[0], this.size[1], 0, 0, this.size[0], this.size[1], gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.prezFbo);
      for (const list of lists) for (const it of list) if (it.side !== 1 && it.ib !== cell) this.drawPrez(it);
    } else if (fresh) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      for (const list of lists) for (const it of list) if (it.side !== 1 && it.ib === cell) this.drawPrez(it);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.prezFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.prezCacheFbo);
      gl.blitFramebuffer(0, 0, this.size[0], this.size[1], 0, 0, this.size[0], this.size[1], gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.prezFbo);
      for (const list of lists) for (const it of list) if (it.side !== 1 && it.ib !== cell) this.drawPrez(it);
    } else {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      for (const list of lists) for (const it of list) if (it.side !== 1) this.drawPrez(it);
    }
    gl.bindVertexArray(this.emptyVao); this._vao = this.emptyVao;
    this.setDepthTest(false); this.setDepthMask(false); this.setCull(false);
    const common = (p) => {
      this.bindUnit(0, this.prezDepth);
      this.u4f(p, 'uProj', [proj[0], proj[5], proj[8], proj[9]]);
      this.u2f(p, 'uNF', this.zNear, this.zFar); this.u2f(p, 'uSize', sw, sh);
    };
    const aw = Math.max(1, Math.ceil(sw / 2)), ah = Math.max(1, Math.ceil(sh / 2));
    const run = (prog, target, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, aw, ah);
      const p = this.progs[prog]; this.useProg(p); common(p); setup(p);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const A = this.aoParams || AO_PARAMS;
    run('sao', { fbo: this.saoFbo }, p => {          // occlusion into aoA, linear depth into aoZ
      this.u4f(p, 'uSAO', [A.radius, A.bias, A.intensity * AO_GAIN, sh / 1080]);
      gl.uniform1i(this.U(p, 'uSamples'), Math.min(A.samples, this.quality.aoSamples)); this.u1f(p, 'uTurns', A.turns);
    });
    const blur = (p, src, dx, dy) => {
      this.bindUnit(1, src.tex); this.bindUnit(2, this.aoZ.tex);
      if (!p._uZ) { p._uZ = true; gl.uniform1i(this.U(p, 'uZ'), 2); }       // (the sampler's unit, set once)
      gl.uniform2i(this.U(p, 'uDir'), dx, dy); gl.uniform2i(this.U(p, 'uAOSize'), aw, ah);
      gl.uniform2i(this.U(p, 'uZSize'), this.aoZ.w, this.aoZ.h);
    };
    run('saoBlur', this.aoB, p => blur(p, this.aoA, 1, 0));
    run('saoBlur', this.aoA, p => blur(p, this.aoB, 0, 1));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // §24 the shafts: march at half resolution into grA, blur across and down, add to the HDR scene (hdr)
  // the spotlights with their own god rays (LIGH WGDR) whose sphere is in view, nearest first, up to 4
  godRaySpots(planes, eye) {
    const out = [];
    for (const l of this.pointLights) if (l.gr && l.cone > -1.5 && sphereVisible(planes, l.pos, l.radius))
      out.push([Math.hypot(l.pos[0] - eye[0], l.pos[1] - eye[1], l.pos[2] - eye[2]) - l.radius, l]);
    return out.sort((a, b) => a[0] - b[0]).slice(0, 4).map(x => x[1]);
  }
  godRays(gr, sw, sh, ivp, spots = []) {
    const gl = this.gl, P = this.grParams || GR_PARAMS, k = P.scale;
    const aw = Math.max(1, Math.ceil(sw / 2)), ah = Math.max(1, Math.ceil(sh / 2));
    gl.bindVertexArray(this.emptyVao); this._vao = this.emptyVao;
    this.setDepthTest(false); this.setDepthMask(false); this.setCull(false); this.setBlend(false);
    const sc = (c, s) => c.map(v => v * s * k);
    let p = this.progs.godrays;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.grA.fbo); gl.viewport(0, 0, aw, ah);
    this.useProg(p);
    this.bindUnit(0, this.sceneDepth);
    this.bindUnit(14, this.shadowTex[0]); this.bindUnit(15, this.shadowTex[1]); this.bindUnit(2, this.shadowTex[2]);
    this.um4(p, 'uInvViewProj', ivp);
    this.um4(p, 'uFarVP', this.farVP || IDENTITY); this.u1f(p, 'uFarOn', this._farOn ? 1 : 0);
    const G = gr || { intensity: 0, air: [0, 0, 0], fwd: [0, 0, 0], back: [0, 0, 0], gF: 0, gB: 0 };
    this.u4f(p, 'uAir', [...sc(G.air, P.air ?? 1), 0]);
    this.u4f(p, 'uFwd', [...sc(G.fwd, P.fwd ?? 1), G.gF]);
    this.u4f(p, 'uBack', [...sc(G.back, P.back ?? 1), (P.backSign ?? 1) * G.gB]);
    // spotlight shafts: each light's own medium (its GDRY) and colour x the GDRY intensity
    this.bindUnit(3, this.lightShadow?.tex || this.lsDummy, 'array');
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND.LightShadows, this.lightShadow?.ubo || this.lsDummyUbo());
    // eight vec4[4] uniform arrays, kept between frames (zeroed: unused slots upload as before)
    const SA = this._grSpotArrays || (this._grSpotArrays = Array.from({ length: 8 }, () => new Float32Array(16)));
    for (const a of SA) a.fill(0);
    const [pos, dir, col, att, air, fwd, back, xx] = SA;
    const gain = P.spotGain ?? 1;
    spots.forEach((l, i) => {
      const g = l.gr, o = i * 4;
      pos.set([...l.pos, l.radius], o); dir.set([...l.dir, l.cone], o);
      col.set([...l.color.map(v => v * g.intensity * gain), l._lsSlot ?? -1], o);
      att.set([...l.att, l.falloff ?? 1], o);
      air.set([...sc(g.air, 1), 0], o); fwd.set([...sc(g.fwd, 1), g.gF], o); back.set([...sc(g.back, 1), g.gB], o);
      // the rays start at the light's near clip (lights placed outside a window: no beam before it) or their own
      xx.set([Math.max(g.near || 0, l.near || 0), l.shadow === 1 ? 1 : 0, 0, 0], o);
    });
    gl.uniform1i(this.U(p, 'uSpotN'), spots.length);
    for (const [n, v] of [['uSpotPos', pos], ['uSpotDir', dir], ['uSpotCol', col], ['uSpotAtt', att], ['uSpotAir', air],
      ['uSpotFwd', fwd], ['uSpotBack', back], ['uSpotX', xx]]) { const loc = this.U(p, n + '[0]') || this.U(p, n); if (loc) gl.uniform4fv(loc, v); }
    // the march covers the cell's sun map (centred near the camera's target) and the camera's distance to it
    const reach = Math.min(P.maxDist, this._farOn ? FAR_R : (this._worldR || 3000) * 1.2 + (this.camera.dist || 0));
    this.u4f(p, 'uGR', [G.intensity, reach, gr ? Math.min(P.steps, this.quality.grSteps) : 0, this.settings.taa ? this.frameNo % 64 : 0]);   // no sun: no march
    this.u1f(p, 'uMaxDist', P.maxDist);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    p = this.progs.godraysBlur; this.useProg(p);
    gl.uniform2i(this.U(p, 'uSize'), aw, ah);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.grB.fbo); this.bindUnit(0, this.grA.tex);
    gl.uniform2i(this.U(p, 'uDir'), 1, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.grA.fbo); this.bindUnit(0, this.grB.tex);
    gl.uniform2i(this.U(p, 'uDir'), 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    p = this.progs.godraysApply; this.useProg(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo); gl.viewport(0, 0, sw, sh);
    this.bindUnit(0, this.grA.tex); this.bindUnit(1, this.sceneDepth);
    this.um4(p, 'uInvViewProj', ivp); this.u1f(p, 'uMaxDist', P.maxDist);
    this.setBlend(true, gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.setBlend(false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // one solid draw item into the depth pre-pass (alpha-tested ones cut by their texture, as in the main pass)
  drawPrez(it) {
    const s = it.s, m = s.mat, a = m.alpha || {}, sk = s.skinData ? 1 : 0;
    if (m.kind === 'effect') return;                  // the game's effect shaders draw after its occlusion pass
    if (m.kind === 'land') this.useProg(this.progs.prezLand);
    else {
      const clip = !!a.test;
      this.useProg(this.progs.prez[sk][clip ? 1 : 0]);
      if (clip) { this.litMaterial(s, this._md, it.isGround); this.bindMaterial(s, this._md); this.bindUnit(0, s.tex.diffuse?.tex || this.white); }
    }
    if (sk) this.bindBones(s.skinData);
    this.setCull(!(m.two_sided || it.isGround || m.kind === 'land'));
    this.drawInstanced(s, it.ib || this.inst.main, it.base, it.count);
  }

  // ---- the cell's part of the draw lists for one view: culled, sorted and its matrices uploaded (inst.cell) once, then
  // reused while the view and the cell stay as they are (the default: the idle clip playing under a still camera).
  // vp: the drawing projection x view (TAA's jitter included, so a jittered frame never reuses one). Everything else
  // that changes the lists bumps version: placements (LOD too), setLod, landscape, decal sets, clearCell, the cell's
  // eye, materials and textures arriving.
  cellLists(vp, planes, eye) {
    const st = this.settings, decalsOn = st.decals !== false, lodOn = st.lod !== false;
    let L = this._cellLists;
    if (L && L.version === this.version && L.cellVersion === this.cellVersion && L.cellVisible === this.cellVisible &&
      L.decalsOn === decalsOn && L.lodOn === lodOn && L.eye[0] === eye[0] && L.eye[1] === eye[1] && L.eye[2] === eye[2]) {
      let i = 0;
      while (i < 16 && L.vp[i] === vp[i]) i++;
      if (i === 16) return L;
    }
    L = this._cellLists = this.buildCellLists(planes, eye);
    Object.assign(L, { version: this.version, cellVersion: this.cellVersion, cellVisible: this.cellVisible, decalsOn, lodOn,
      eye: [eye[0], eye[1], eye[2]], vp: Float64Array.from(vp), serial: (this._cellSerial = (this._cellSerial || 0) + 1) });
    return L;
  }
  buildCellLists(planes, eye) {
    const ib = this.inst.cell || (this.inst.cell = this.instBuffer());
    ib.n = 0;
    const L = { opaque: [], clip: [], late: [], lands: [], decals: [], refr: [], pdecals: [], blend: [], objects: 0 };
    const d2 = (c) => { const x = c[0] - eye[0], y = c[1] - eye[1], z = c[2] - eye[2]; return x * x + y * y + z * z; };
    const cellOn = this.cellVisible, none = [], e0 = eye[0], e1 = eye[1], e2 = eye[2];
    const P = new Float64Array(24);
    planes.forEach((p, i) => P.set(p, i * 4));
    for (const b of cellOn ? this.batches : none) {
      const sh = b.sh;
      if (!sh.visible) continue;
      if (b.blend && !b.decal && !sh.mat.refraction) {
        for (const it of b.inst) if (sphereVisible(planes, it.center, it.radius)) L.blend.push({ s: sh, W: it.world, c: it.center, d: d2(it.center) });
        continue;
      }
      // flat copies of the batch's spheres and matrices (made again when its placements changed in number): the same
      // tests in the same order as sphereVisible and d2, and each run of visible instances copied at once
      const n = b.inst.length;
      if (b._fn !== n) {
        const S = b._sph = new Float64Array(n * 4), W = b._W = new Float32Array(n * 16);
        b.inst.forEach((it, i) => { S.set(it.center, i * 4); S[i * 4 + 3] = it.radius; W.set(it.world, i * 16); });
        b._fn = n;
      }
      if ((ib.n + n) * 16 > ib.data.length) { const d = new Float32Array(Math.max(ib.data.length * 2, (ib.n + n) * 16)); d.set(ib.data); ib.data = d; }
      const S = b._sph, W = b._W, D = ib.data, base = ib.n;
      let dmin = Infinity, n1 = base, run = -1;
      for (let i = 0; i <= n; i++) {
        let vis = false;
        if (i < n) {
          const k = i * 4, x = S[k], y = S[k + 1], z = S[k + 2], r = -S[k + 3];
          vis = !(P[0] * x + P[1] * y + P[2] * z + P[3] < r || P[4] * x + P[5] * y + P[6] * z + P[7] < r ||
            P[8] * x + P[9] * y + P[10] * z + P[11] < r || P[12] * x + P[13] * y + P[14] * z + P[15] < r ||
            P[16] * x + P[17] * y + P[18] * z + P[19] < r || P[20] * x + P[21] * y + P[22] * z + P[23] < r);
          if (vis) {
            const dx = x - e0, dy = y - e1, dz = z - e2, dd = dx * dx + dy * dy + dz * dz;
            if (dd < dmin) dmin = dd;
            if (run < 0) run = i;
            continue;
          }
        }
        if (run >= 0) { D.set(W.subarray(run * 16, i * 16), n1 * 16); n1 += i - run; run = -1; }
      }
      ib.n = n1;
      if (ib.n === base) continue;
      L.objects += ib.n - base;
      // blended decals lie on surfaces drawn before them: their own pass, one call per model, no sorting (as the game).
      // Refraction shapes (SF1 Refraction, e.g. the ripples under Vault 111's ceiling drips) bend the finished picture:
      // drawn last by drawRefraction, never as a lit surface (their diffuse slot holds a normal map: green swirls)
      const it = { s: sh, base, count: ib.n - base, d: dmin, ib };
      if (sh.mat.refraction) L.refr.push(it);
      else if (b.blend) L.decals.push(it); else (writesDepth(sh.mat) ? (b.clip ? L.clip : L.opaque) : L.late).push(it);
    }
    for (const q of cellOn ? this.lands : none) if (sphereVisible(planes, q.center, q.radius)) L.lands.push({ s: q, base: this.pushInst(ib, q.world), count: 1, d: d2(q.center), ib });
    // §22 projected decals: the boxes in view, one call per texture set
    if (this.settings.decals !== false) for (const set of cellOn ? this.decalSets : none) {
      const base = ib.n;
      for (const it of set.inst) if (sphereVisible(planes, it.center, it.radius)) this.pushInst(ib, it.world);
      if (ib.n > base) L.pdecals.push({ s: set.s, base, count: ib.n - base, ib });
    }
    L.opaque.sort((a, b) => a.d - b.d); L.clip.sort((a, b) => a.d - b.d); L.lands.sort((a, b) => a.d - b.d);
    this.uploadInst(ib);
    return L;
  }

  renderScene(w, h, sw, sh, view, proj, eye, dt, skyLut) {
    const gl = this.gl, env = this.env;
    this._mark('particles');
    this.updateParticles(dt, view, eye);
    this._mark('cull');
    // ---- what to draw this frame, in order: the character group first (near the camera, it hides the most),
    // then solid cell objects nearest first, then alpha-tested ones, the landscape and the sky; blended last
    const vp = mat4.mul(proj, view), planes = frustumPlanes(vp), ib = this.inst.main;
    ib.n = 0;
    const opaque = [], clip = [], late = [], decals = [], blended = [], refr = [];
    // solid shapes that do not write depth go after the sky: the sky only fills pixels no depth has reached yet and
    // would cover them where nothing solid stands behind. Alpha-tested ones always write depth (writesDepth): vanilla
    // hair is alpha-tested with Z write off in its BGSM, yet the game layers its cards by depth (its deferred pass)
    const solid = (s, it, list) => (writesDepth(s.mat) ? list : late).push(it);
    const d2 = (c) => { const x = c[0] - eye[0], y = c[1] - eye[1], z = c[2] - eye[2]; return x * x + y * y + z * z; };
    // before / after: a compared model's live shapes are drawn right of the split (side 2), its twin's left (side 1);
    // holding the peek key shows the twin everywhere; everything else is drawn on both sides (side 0)
    const cmp = this.compare && this.compare.twins.size ? this.compare : null;
    const groups = [];
    for (const m of this.models) if (m.visible) {
      const tw = cmp && cmp.twins.get(m);
      if (!tw) groups.push([m.shapes, 0]);
      else if (cmp.peek) groups.push([tw.shapes, 0]);
      else groups.push([m.shapes, 2], [tw.shapes, 1]);
    }
    for (const [list, side] of groups) for (const s of list) {
      const src = s._of || s;                    // a twin shape is placed, posed and shown like its live shape
      if (!src.visible || s.mat.kind === 'none') continue;
      const W = this.playerWorld(src), a = s.mat.alpha, pd = this.shapePrevDelta(src, W);
      if (a && a.blend && !s.mat.refraction && isDecal(s.mat)) { decals.push({ s, base: this.pushInst(ib, W), count: 1, pd, side }); continue; }
      if (a && a.blend && !s.mat.refraction) { blended.push({ s, W, c: mat4.transformPoint(src._model?.xform ? mat4.mul(this.playerRoot, src._model.xform) : this.playerRoot, src.center), pd, side }); continue; }
      const it = { s, base: this.pushInst(ib, W), count: 1, d: -1, pd, side, pl: true };
      if (s.mat.refraction) refr.push(it); else solid(s, it, a && a.test ? clip : opaque);
    }
    if (this.settings.ground && (!this.cellMode || this.cellFloor)) {
      const g = this.ground;
      g.world = mat4.identity(); g.world[14] = g.z;
      opaque.push({ s: g, base: this.pushInst(ib, g.world), count: 1, d: -0.5, isGround: true });
    }
    // the cell (cellLists, kept while the view stays): the character group's items have d = -1 and the ground -0.5,
    // cell items d >= 0, so with the stable sort the cell's own sorted lists simply follow them; late, decals and
    // refraction were never sorted (character group first)
    for (const it of blended) it.d = d2(it.c);
    const C = this.cellLists(vp, planes, eye), cellOn = this.cellVisible, none = [];
    for (const it of C.opaque) opaque.push(it);
    for (const it of C.clip) clip.push(it);
    for (const it of C.late) late.push(it);
    for (const it of C.decals) decals.push(it);
    for (const it of C.refr) refr.push(it);
    for (const it of C.blend) blended.push(it);
    const lands = C.lands, pdecals = C.pdecals, objects = C.objects;
    for (const wt of cellOn ? this.waters : none) if (sphereVisible(planes, wt.center, wt.radius)) blended.push({ s: wt, W: wt.world, c: wt.center, d: d2(wt.center) });
    // particle systems (world-space quads, updateParticles): sorted with the other blended surfaces
    for (const d of this._psysDraw) if (sphereVisible(planes, d.c, d.radius)) blended.push({ s: d.s, W: IDENTITY, c: d.c, d: d2(d.c) });
    // blended: farthest first; copies of one model that end up next to each other in that order share a call
    // (instances draw in order, so the blending order is the same)
    blended.sort((a, b) => b.d - a.d);
    const blendDraws = [];
    for (const it of blended) {
      const last = blendDraws[blendDraws.length - 1], base = this.pushInst(ib, it.W);
      if (last && last.s === it.s && last.base + last.count === base) last.count++;
      else blendDraws.push({ s: it.s, base, count: 1, pd: it.pd, side: it.side });
    }
    this.uploadInst(ib);
    this.buildLightGrid(view, proj, planes, sw, sh);
    this.stats_draws = opaque.length + clip.length + lands.length + late.length + decals.length + blendDraws.length + refr.length + pdecals.length;
    this.stats_decals = pdecals.reduce((n, it) => n + it.count, 0);
    this.stats_objects = objects;

    // ---- §21 ambient occlusion of the solid scene, before the lit scene reads it
    this._aoOn = !!(this.settings.ao && this.prezFbo && !this.settings.evenLight);
    this.fillFrame(view, proj, eye, w, h, sw, sh);
    if (this._aoOn) this.ambientOcclusion([opaque, clip, lands], sw, sh, proj);

    // ---- HDR scene
    this._mark('opaque');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
    gl.viewport(0, 0, sw, sh);
    this.setDepthMask(true);
    // TAA: solid surfaces write their motion and coverage into the second attachment; the sky, decals and blended
    // layers do not (they keep what lies behind them; the sky's own motion is the camera's, worked out in TAA_FS)
    const taa = !!(this.settings.taa && this.vel);
    const both = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1], colourOnly = [gl.COLOR_ATTACHMENT0, gl.NONE];
    if (taa) gl.drawBuffers(both);
    // a backdrop: the sky and the floor are drawn (exposure and light stay those of the scene) but leave alpha at 0,
    // so TONEMAP_FS can put the backdrop there
    const bd = !!this.settings.backdrop;
    if (bd) gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (bd) gl.clearColor(0, 0, 0, 1);
    if (taa) gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    this.bindUnit(AO_UNIT, this._aoOn ? this.aoA.tex : this.white);
    this.bindUnit(SHADOW_UNITS[0], this.shadowTex[0]); this.bindUnit(SHADOW_UNITS[1], this.shadowTex[1]);
    this.bindUnit(LIGHT_UNIT, this._lightGrid?.tex || this.black);
    this.bindUnit(LS_UNIT, this.lightShadow?.tex || this.lsDummy, 'array');
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND.LightShadows, this.lightShadow?.ubo || this.lsDummyUbo());
    // before / after split: the whole sequence twice, each half of the picture with its side's shapes
    const sx = cmp ? Math.round(Math.min(1, Math.max(0, cmp.split)) * sw) : 0;
    const passes = cmp && !cmp.peek ? [[1, 0, sx], [2, sx, sw]] : [[0, 0, sw]];
    const viewNoT = new Float32Array(view); viewNoT[12] = viewNoT[13] = viewNoT[14] = 0;
    const skyIVP = mat4.invert(mat4.mul(proj, viewNoT));
    // §22 the projected decals find their surfaces in the cell's depth: the character group is drawn after them, so
    // no decal lands on the character (the game keeps its decals off actors too)
    const cellFirst = pdecals.length > 0;
    const invVP = skyIVP;              // camera-relative (DECAL_FS uInvViewProj)
    for (const [side, x0, x1] of passes) {
      if (x1 <= x0) continue;
      const draw = (it) => {
        if (side && it.side && it.side !== side) return;
        if (bd && it.isGround) { gl.colorMask(true, true, true, false); this.drawItem(it); gl.colorMask(true, true, true, true); }
        else this.drawItem(it);
      };
      if (side) { gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, 0, x1 - x0, sh); }
      if (taa) gl.drawBuffers(both);
      this._mark('opaque');
      for (const it of opaque) if (!cellFirst || !it.pl) draw(it);
      if (!cellFirst) for (const it of clip) draw(it);
      for (const it of lands) draw(it);
      if (cellFirst) {
        // the solid cell's depth for the decals to find their surfaces in; alpha-tested surfaces (grates, foliage,
        // fences) are drawn after the decals and take none, as the game (Fallout4.ini bAllowDecalsOnAlpha off)
        this._mark('decals');
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthFbo);
        gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.DEPTH_BUFFER_BIT, gl.NEAREST);    // (within the scissor)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
        if (taa) gl.drawBuffers(colourOnly);
        for (const it of pdecals) this.drawProjDecal(it, invVP);
        this.endProjDecals();
        if (taa) gl.drawBuffers(both);
        this._mark('opaque');
        for (const it of clip) if (!it.pl) draw(it);
        for (const it of opaque) if (it.pl) draw(it);
        for (const it of clip) if (it.pl) draw(it);
      }

      // ---- sky: on the far plane, behind everything drawn so far
      this._mark('sky');
      const sky = this.progs.sky;
      this.useProg(sky);
      this.um4(sky, 'uInvViewProj', skyIVP);
      this.u3f(sky, 'uSunDisc', env.sunDisc); this.u3f(sky, 'uSunDir', env.sunDiscDir || env.sunDir); this.u3f(sky, 'uGlare', env.sunGlare);
      this.u1f(sky, 'uSunSize', 0.012);
      this.bindUnit(0, skyLut);
      this.setDepthTest(true); this.setDepthMask(false); this.setBlend(false); this.setCull(false);
      gl.bindVertexArray(this.emptyVao); this._vao = this.emptyVao;
      if (taa) gl.drawBuffers(colourOnly);
      if (bd) gl.colorMask(true, true, true, false);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (bd) gl.colorMask(true, true, true, true);
      if (taa) gl.drawBuffers(both);
      for (const it of late) draw(it);
      if (taa) gl.drawBuffers(colourOnly);
      for (const it of decals) draw(it);
      this.setOffset(false);

      this._mark('blended');
      if (this.selection || blendDraws.some(it => it.s.mat && it.s.mat.soft)) {   // the solid scene's depth (soft particles, outline)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthFbo);
        gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.DEPTH_BUFFER_BIT, gl.NEAREST);    // (within the scissor)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
      }
      for (const it of blendDraws) draw(it);
      this.setDepthMask(true); this.setBlend(false);
    }
    gl.disable(gl.SCISSOR_TEST);
    // the depth resolve above (made on every side of a split, so the whole target) still holds for the light shafts
    // when no blended draw wrote depth since (drawItem's depth mask; refraction never writes it)
    const depthFresh = !!(this.selection || blendDraws.some(it => it.s.mat && it.s.mat.soft)) &&
      !blendDraws.some(({ s: { mat: m } }) => (m.alpha && m.alpha.blend ? m.zwrite === true : writesDepth(m)));

    this._mark('resolve');
    const resolve = (withVel) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo);
      if (taa && withVel) {                      // the motion attachment first, then back to the colour
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.vel.fbo);
        gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.hdr.fbo);
      gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    };
    resolve(true);
    // ---- refraction: drawn last, each shape shows the resolved scene behind it, shifted; then resolve again (the
    // colour only: refraction writes no motion)
    if (refr.length && this.settings.debug === 0) {
      this._mark('refraction');
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
      gl.viewport(0, 0, sw, sh);
      for (const [side, x0, x1] of passes) {
        if (x1 <= x0) continue;
        if (side) { gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, 0, x1 - x0, sh); }
        for (const it of refr) if (!side || !it.side || it.side === side) this.drawRefraction(it);
      }
      gl.disable(gl.SCISSOR_TEST);
      this.setDepthMask(true);
      resolve(false);
    }
    // ---- §24 light shafts: added to the HDR scene before TAA, bloom and eye adaptation
    const gr = env.godRays && env.godRays.intensity > 0 ? env.godRays : null;
    const grView = this.settings.debug === 10;          // the View list's 'light shafts': the shafts alone
    const grSpots = this.settings.godrays !== false && this.cellMode && this.cellVisible ? this.godRaySpots(planes, eye) : [];
    if (this.settings.godrays !== false && (gr || grSpots.length) && this.cellMode && this.cellVisible && (this.settings.debug === 0 || grView)) {
      this._mark('godrays');
      if (!depthFresh) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthFbo);
        gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      }
      if (grView) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo); gl.viewport(0, 0, sw, sh); gl.clear(gl.COLOR_BUFFER_BIT); }
      this.godRays(gr, sw, sh, skyIVP, grSpots);
    }
    this.setDepthTest(false); this.setCull(false); this.setBlend(false);
    gl.bindVertexArray(this.emptyVao); this._vao = this.emptyVao;
    const uvs = [sw / w, sh / h];

    // ---- TAA (TAA_FS): this frame blended into the history; everything after reads the result
    let scene = this.hdr;
    if (taa) {
      this._mark('taa');
      const out = this.taaTex[this._taaI || 0], hist = this.taaTex[1 - (this._taaI || 0)], p = this.progs.taa;
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.viewport(0, 0, sw, sh);
      this.useProg(p);
      this.bindUnit(0, this.hdr.tex); this.bindUnit(1, hist.tex); this.bindUnit(2, this.vel.tex);
      this.u2f(p, 'uUVScale', uvs[0], uvs[1]); this.u2f(p, 'uTexel', 1 / w, 1 / h);
      // per pixel in TAA_FS (the history's age); moving pixels keep at least 10 % of the newest frame
      this.u1f(p, 'uAlpha', 0.1);
      this.u1i(p, 'uReset', this._taaReset ? 1 : 0);
      this.um4(p, 'uReproj', this._skyReproj);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._taaI = 1 - (this._taaI || 0);
      this._taaReset = false;
      scene = out;
    }

    // ---- bloom (§12): max(HDR - threshold, 0) x scale at quarter resolution, 15-tap Gaussian, clamped to 1
    this._mark('bloom');
    if (this.settings.bloom) {
      this.pass('bright', this.bloomA, p => {
        this.bindUnit(0, scene.tex); this.u1f(p, 'uThreshold', env.bloomThreshold);
        this.u1f(p, 'uScale', env.bloomScale); this.u2f(p, 'uTexel', 1 / w, 1 / h); this.u2f(p, 'uUVScale', uvs[0], uvs[1]);
      });
      this.pass('blur', this.bloomB, p => { this.bindUnit(0, this.bloomA.tex); this.u2f(p, 'uStep', 1 / this.bloomA.w, 0); this.u1f(p, 'uClampOne', 0); });
      this.pass('blur', this.bloomA, p => { this.bindUnit(0, this.bloomB.tex); this.u2f(p, 'uStep', 0, 1 / this.bloomB.h); this.u1f(p, 'uClampOne', 1); });
    }

    // ---- eye adaptation (§12): arithmetic mean of Rec.709 luminance via the mip chain (here), then adapt over time on
    // the GPU (renderPost). The game's adaptation rate formula is CPU-side and unknown; a first-order lag with Eye
    // Adapt Speed is used.
    this._mark('lum');
    this.pass('lum', this.lum, p => { this.bindUnit(0, scene.tex); this.u2f(p, 'uUVScale', uvs[0], uvs[1]); });
    this.bindUnit(0, this.lum.tex); gl.activeTexture(gl.TEXTURE0); gl.generateMipmap(gl.TEXTURE_2D);
    this._sceneOut = { scene, uvs };
    this.renderPost(w, h, dt, scene, uvs);
  }

  // The frame after the HDR picture: eye adaptation, tonemap (cinematic, LUT, backdrop) and the selection outline. A
  // still scene that is only settling runs this alone (frame): it reads the scene, bloomA, the lum mip chain and
  // sceneDepth as the last full frame left them, so bloom and lum are made before it (their order with the adaptation
  // does not matter: none reads another's target).
  renderPost(w, h, dt, scene, uvs) {
    const gl = this.gl, env = this.env;
    const k = this.snapAdapt ? 1 : Math.min(1, 1 - Math.exp(-Math.max(dt, 0) * (env.eyeAdaptSpeed || 3)));
    const prev = this.adapt[this._ad], next = this.adapt[1 - this._ad];
    this.pass('adapt', next, p => {
      this.bindUnit(0, this.lum.tex); this.bindUnit(1, prev.tex);
      this.u1i(p, 'uLevel', this.lum.levels - 1); this.u1f(p, 'uK', k);
    });
    this._ad = 1 - this._ad;
    if (this.snapAdapt) {                      // calibration captures and previews need this frame's value now
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, next.fbo);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, this._lumPx);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      if (isFinite(this._lumPx[0])) { this.lumAdapted = this._lumPx[0]; this.lumMeasured = this._lumPx[1]; }
    } else if (performance.now() - this._lumReadAt > 1000) this.readLumAsync();      // the HUD's numbers
    this.snapAdapt = false;
    this.stats = { avgLum: this.lumMeasured, adapted: this.lumAdapted };

    // ---- tonemap, cinematic, gamma, LUT (§12-§13)
    this._mark('tonemap');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const t = this.progs.tone, st = this.settings;
    this.useProg(t);
    this.bindUnit(0, scene.tex);
    this.bindUnit(1, st.bloom ? this.bloomA.tex : this.black);
    this.bindUnit(4, next.tex);
    this.u2f(t, 'uUVScale', uvs[0], uvs[1]);
    this.u4f(t, 'uExpo', [st.exposureAuto ? 1 : 0, Math.pow(2, st.exposureAuto ? (st.exposureBias || 0) : st.exposure), env.middleGray ?? 0.18, 0]);
    this.u2f(t, 'uAeRange', env.aeMin ?? 0.5, env.aeMax ?? 10);
    this.u1f(t, 'uWhite', 11.2);
    this.u1f(t, 'uTonemapE', env.tonemapE ?? 0.02);
    const luts = st.lut ? this.lutTextures(env.luts || []) : [];
    this.bindUnit(2, luts[0]?.tex || this.black);
    this.bindUnit(3, luts[1]?.tex || this.black);
    this.u2f(t, 'uLutW', luts[0] ? luts[0].weight : 0, luts[1] ? luts[1].weight : 0);
    this.u3f(t, 'uCinematic', st.grade ? env.cinematic : [1, 1, 1]);
    this.u4f(t, 'uTintIS', st.grade ? env.tint : [1, 1, 1, 0]);
    this.u1i(t, 'uTonemapMode', st.tonemap);
    this.u1f(t, 'uEditor', st.evenLight ? 1 : 0);
    this.u1i(t, 'uShowBloom', st.showBloom);
    // a backdrop (NifSkope black, Outfit Studio grey) behind the models, with NifSkope's grid and corner axes: the
    // coverage is this frame's resolved alpha (also under TAA, whose output keeps its history's age there)
    const bdc = st.backdrop;
    this.bindUnit(5, this.hdr.tex);
    this.u4f(t, 'uBackdrop', bdc ? [bdc[0], bdc[1], bdc[2], 1] : [0, 0, 0, 0]);
    if (bdc) {
      const L = this._last, gz = this.ground ? this.ground.z : 0;
      this.um4(t, 'uInvVP', mat4.invert(mat4.mul(L.proj, L.view)));
      this.u3f(t, 'uEye', this.eye);
      this.um4(t, 'uView', L.view);
      this.u4f(t, 'uGrid', [st.grid ? 1 : 0, gz, 1024, 0]);
      this.u4f(t, 'uAxes', [st.grid ? 1 : 0, Math.min(w / 10, 125), 0, 0]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.selection || this.collisionLines) {
      // the outline is drawn after TAA, where no history averages the sub-pixel jitter away: the plain projection
      // (fillFrame writes the whole block again next frame)
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo); gl.bufferSubData(gl.UNIFORM_BUFFER, FR.proj * 4, this._last.proj);
      if (this.collisionLines) this.drawCollision(w, h);
      if (this.selection) this.drawSelection(w, h);
    }
    gl.bindVertexArray(null); this._vao = null;
    this._mark(null);
  }

  // ---------------------------------------------------------------------------------------------------- selection
  // A single click picks the model under the cursor: the character group's models, or one placed cell object.
  // (x, y): CSS pixels in the canvas. Returns {kind: 'model', model} | {kind: 'cell', tpl, index} | null.
  pick(x, y) {
    const gl = this.gl, L = this._last;
    if (!L || !this.size) return null;
    const W = this.size[0], H = this.size[1];
    const px = x * W / this.canvas.clientWidth, py = H - y * H / this.canvas.clientHeight;
    // gluPickMatrix: the one pixel under the cursor fills the 1 x 1 target
    const pm = mat4.identity();
    pm[0] = W; pm[5] = H; pm[12] = W - 2 * px; pm[13] = H - 2 * py;
    const vp = mat4.mul(pm, mat4.mul(L.proj, L.view));
    if (!this.pickFbo) {
      this.pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
      const db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, db); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
      this.pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    }
    if (!this.progs.pick) this.prewarmPrograms();     // (finished by useProg below)
    this.resetState();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, 1, 1);
    gl.clearColor(0, 0, 0, 0); this.setDepthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.clearColor(0, 0, 0, 1);
    this.setDepthTest(true); this.setBlend(false); this.setCull(false);
    const planes = frustumPlanes(vp), ib = this.inst.probe, draws = [], targets = [];
    ib.n = 0;
    const pickable = (s) => s.visible && s.mat.kind !== 'none' && !s.mat.refraction && !(s.mat.alpha && s.mat.alpha.blend);
    for (const m of this.models) if (m.visible) for (const s of m.shapes) {
      if (!pickable(s)) continue;
      draws.push([s, this.pushInst(ib, this.playerWorld(s)), 1, targets.length]);
      targets.push({ kind: 'model', model: m, shape: s });       // (shape: Alt+click selects it alone)
    }
    for (const t of this.cellVisible ? this.cellTemplates : []) for (const s of t.shapes) {
      const b = s._batch;
      if (!b || b.blend || !pickable(s)) continue;
      const base = ib.n, first = targets.length;
      b.inst.forEach((it, i) => {
        if (!sphereVisible(planes, it.center, it.radius)) return;
        this.pushInst(ib, it.world);
        targets.push({ kind: 'cell', tpl: t, index: i });
      });
      if (ib.n > base) draws.push([s, base, ib.n - base, first]);
    }
    this.uploadInst(ib);
    const md = this._md;
    for (const [s, base, n, id0] of draws) {
      const clip = !!s.mat.alpha?.test;
      const p = this.progs.pick[s.skinData ? 1 : 0][clip ? 1 : 0];
      this.useProg(p);
      if (p._vp !== vp) { p._vp = vp; this.um4(p, 'uShadowVP', vp); }
      this.u1i(p, 'uBase', id0);
      if (clip) { this.litMaterial(s, md); this.bindMaterial(s, md); this.bindUnit(0, s.tex.diffuse?.tex || s.tex.base?.tex || this.white); }
      if (s.skinData) this.bindBones(s.skinData);
      this.drawInstanced(s, ib, base, n);
    }
    gl.bindVertexArray(null); this._vao = null;
    const px4 = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const id = px4[0] | (px4[1] << 8) | (px4[2] << 16);
    return id ? targets[id - 1] || null : null;
  }
  setSelection(sel) {
    this.selection = sel || null;
    this.version++;
  }
  // the selected model's shapes with their placements
  selectionDraws() {
    const sel = this.selection, out = [];
    if (!sel) return out;
    if (sel.kind === 'model') {
      if (!sel.model.visible) return out;
      for (const s of sel.model.shapes) if (s.visible && s.mat.kind !== 'none' && s._ib) out.push([s, this.playerWorld(s)]);
    } else if (sel.kind === 'shape') {                 // one shape of a model (Alt+click, the Scene list's shape rows):
      if (!sel.model.visible) return out;              // its .nif outlined as usual, the shape lighter on top (hi)
      for (const s of sel.model.shapes) if (s !== sel.shape && s.visible && s.mat.kind !== 'none' && s._ib) out.push([s, this.playerWorld(s)]);
      const s = sel.shape;
      if (s.visible && s.mat.kind !== 'none' && s._ib) out.push([s, this.playerWorld(s), true]);
    } else {
      for (const s of sel.tpl.shapes) {
        const it = s._batch && s._batch.inst[sel.index];
        if (it && s._ib) out.push([s, it.world]);
      }
    }
    return out;
  }
  buildWire(s) {
    if (s._wireIB) return;
    const gl = this.gl, seen = new Set(), out = [];
    let idx = s._idxData;
    if (!idx) {                    // a cell template keeps no CPU copy: read its triangle indices back once
      idx = s.indexType === gl.UNSIGNED_SHORT ? new Uint16Array(s.count) : new Uint32Array(s.count);
      gl.bindVertexArray(null); this._vao = null;       // the element binding is VAO state
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s._ib);
      gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idx);
    }
    const nv = (s.nverts || 0) + 1;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const tri = [idx[t], idx[t + 1], idx[t + 2]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3], k = a < b ? a * nv + b : b * nv + a;
        if (!seen.has(k)) { seen.add(k); out.push(a, b); }
      }
    }
    const arr = s.indexType === gl.UNSIGNED_SHORT ? new Uint16Array(out) : new Uint32Array(out);
    s._wireIB = gl.createBuffer();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s._wireIB); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    s._wireCount = arr.length;
  }
  // the collision view (physics.js): [{ pos: Float32Array of line ends (world, game units), color }]; each list's
  // buffer is kept while the list object is the same one
  drawCollision(w, h) {
    const gl = this.gl, sets = this.collisionLines.filter(s => s && s.pos && s.pos.length >= 6);
    if (!this.progs.coll) this.progs.coll = this.program(S.COLL_VS, S.COLL_FS, 'coll', {}, { uSceneDepth: 6 });
    const keep = new Set(sets);
    for (const [s, buf] of this._collBufs || []) if (!keep.has(s)) { gl.deleteBuffer(buf); this._collBufs.delete(s); }
    this._collBufs = this._collBufs || new Map();
    if (!sets.length) return;
    if (!this._collVao) this._collVao = gl.createVertexArray();
    const p = this.progs.coll;
    gl.viewport(0, 0, w, h);
    this.setDepthTest(false); this.setCull(false); this.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.bindUnit(6, this.sceneDepth);
    this.useProg(p);
    gl.bindVertexArray(this._collVao); this._vao = this._collVao;
    gl.enableVertexAttribArray(0);
    for (const s of sets) {
      let buf = this._collBufs.get(s);
      if (!buf) {
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, s.pos, gl.STATIC_DRAW);
        this._collBufs.set(s, buf);
      } else gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      this.u4f(p, 'uColor', s.color);
      gl.drawArrays(gl.LINES, 0, s.pos.length / 3);
    }
    gl.bindVertexArray(null); this._vao = null;
    this.setBlend(false);
  }

  drawSelection(w, h) {
    const gl = this.gl, list = this.selectionDraws();
    if (!list.length) return;
    if (!this.progs.wire) this.progs.wire = [0, 1].map(sk => this.program(S.MESH_VS, S.WIRE_FS, `wire${sk}`, { SKINNED: sk, CLIP: 0 }, { uSceneDepth: 6 }));
    const ib = this.inst.wire || (this.inst.wire = this.instBuffer());
    ib.n = 0;
    const items = list.map(([s, W, hi]) => [s, this.pushInst(ib, W), hi]);
    this.uploadInst(ib);
    gl.viewport(0, 0, w, h);
    this.setDepthTest(false); this.setCull(false); this.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.bindUnit(6, this.sceneDepth);
    for (const [s, base, hi] of items) {
      this.buildWire(s);
      const p = this.progs.wire[s.skinData ? 1 : 0];
      this.useProg(p);
      this.u4f(p, 'uColor', hi ? [0.8, 1.0, 0.84, 0.6] : [0.45, 1.0, 0.56, 0.22]);   // (hi: an Alt+clicked shape)
      if (s.skinData) this.bindBones(s.skinData);
      gl.bindVertexArray(s.vao); this._vao = s.vao;
      if (s.consts) for (const c of s.consts) this.constAttrib(c);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s._wireIB);
      gl.bindBuffer(gl.ARRAY_BUFFER, ib.buf);
      const o = base * 64;
      for (let k = 0; k < 4; k++) gl.vertexAttribPointer(8 + k, 4, gl.FLOAT, false, 64, o + 16 * k);
      s.vao._ib = ib.buf; s.vao._o = o;                     // (drawInstanced's pointer cache)
      gl.drawElementsInstanced(gl.LINES, s._wireCount, s.indexType, 0, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s._ib);       // the VAO keeps its triangle indices
    }
    this.setBlend(false);
  }

  // one entry of the main pass: program variant, material block, textures, render state, instanced draw
  drawItem(it) {
    const gl = this.gl, s = it.s, m = s.mat, a = m.alpha || {}, T = s.tex, md = this._md;
    const sk = s.skinData ? 1 : 0;
    if (m.kind === 'effect') {
      this.useProg(this.progs.fx[sk]);
      this.fxMaterial(s, md); this.bindMaterial(s, md);
      this.bindUnit(0, T.base?.tex || this.white);
      this.bindUnit(1, T.normal?.tex || this.flatN);
      this.bindUnit(2, T.envmask?.tex || this.white);
      this.bindUnit(4, T.palette?.tex || this.white);
      this.bindUnit(5, T.env?.tex || this.greyCube, true);
      this.bindUnit(6, this.sceneDepth || this.black);
    } else if (m.kind === 'land') {
      this.useProg(this.progs.land);
      this.litMaterial(s, md); this.bindMaterial(s, md);
      const LT = s.layerTex;
      for (let i = 0; i < 4; i++) {
        const t = LT[i] || {};
        this.bindUnit(i, t.d?.tex || this.white);
        this.bindUnit([4, 5, 6, 8][i], t.n?.tex || this.flatN);
        this.bindUnit(9 + i, t.s?.tex || this.black);
      }
    } else {
      this.useProg(this.progs.lit[sk][a.test || a.blend ? 1 : 0]);
      this.litMaterial(s, md, it.isGround); this.bindMaterial(s, md);
      this.bindUnit(0, T.diffuse?.tex || this.white);
      this.bindUnit(1, T.normal?.tex || this.flatN);
      this.bindUnit(2, T.spec?.tex || this.black);
      this.bindUnit(3, T.glow?.tex || this.white);
      this.bindUnit(4, T.palette?.tex || this.white);
      this.bindUnit(5, T.env?.tex || this.greyCube, true);
    }
    this.setPrevDelta(it); this.setReactive(s);
    if (sk) this.bindBones(s.skinData);
    this.setOffset(isDecal(m));
    this.setCull(!(m.two_sided || it.isGround || m.kind === 'land'));
    if (a.blend) { this.setBlend(true, BLEND[a.src] ?? gl.SRC_ALPHA, BLEND[a.dst] ?? gl.ONE_MINUS_SRC_ALPHA); this.setDepthMask(m.zwrite === true); }
    else { this.setBlend(false); this.setDepthMask(writesDepth(m)); }
    this.setDepthTest(m.ztest !== false);
    this.drawInstanced(s, it.ib || this.inst.main, it.base, it.count);
  }

  // §22 one texture set's projected decals (DECAL_FS): the boxes' far sides, depth-tested GEQUAL against the cell (a
  // surface must lie in front of the far side to be inside the box), blended over the lit surface
  drawProjDecal(it, invVP) {
    const gl = this.gl, s = it.s, m = s.mat, a = m.alpha || {}, T = s.tex, md = this._md, p = this.progs.decal;
    this.useProg(p);
    this.litMaterial(s, md); this.bindMaterial(s, md);
    this.bindUnit(0, T.diffuse?.tex || this.white);
    this.bindUnit(1, T.normal?.tex || this.flatN);
    this.bindUnit(2, T.spec?.tex || this.black);
    this.bindUnit(3, T.glow?.tex || this.white);
    this.bindUnit(4, T.palette?.tex || this.white);
    this.bindUnit(5, T.env?.tex || this.greyCube, true);
    this.bindUnit(6, this.sceneDepth);
    if (p._ivp !== invVP) { p._ivp = invVP; this.um4(p, 'uInvViewProj', invVP); }
    const c = s.decalColor;
    this.u4f(p, 'uDecal', [c[0], c[1], c[2], s.quad ? 1 : 0]);
    // multiplicative: the material's blend is DST_COLOR x ZERO (a BGSM's Multiplicative mode) or the decal data says so
    const mul = s.multiply || (a.src === 4 && a.dst === 1);
    this.u1f(p, 'uDecalMul', mul ? 1 : 0);
    if (!this._inDecals) {
      this._inDecals = true;
      gl.cullFace(gl.FRONT); gl.depthFunc(gl.GEQUAL);
      this.setOffset(false); this.setCull(true); this.setDepthTest(true); this.setDepthMask(false);
    }
    if (mul && this.settings.debug === 0) this.setBlend(true, gl.DST_COLOR, gl.ZERO);
    else this.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawInstanced(s, it.ib || this.inst.main, it.base, it.count);
  }
  endProjDecals() {
    if (!this._inDecals) return;
    this._inDecals = false;
    const gl = this.gl;
    gl.cullFace(gl.BACK); gl.depthFunc(gl.LEQUAL);
    this.setBlend(false); this.setDepthMask(true);
  }

  // a refraction shape (SF1 Refraction): see REFRACT_FS
  drawRefraction(it) {
    const s = it.s, m = s.mat, md = this._md;
    this.useProg(this.progs.refr[s.skinData ? 1 : 0]);
    this.setPrevDelta(it);
    this.refrMaterial(s, md); this.bindMaterial(s, md);
    this.bindUnit(1, s.tex.normal?.tex || s.tex.diffuse?.tex || this.flatN);
    this.bindUnit(0, this.hdr.tex);
    if (s.skinData) this.bindBones(s.skinData);
    this.setBlend(false); this.setDepthMask(false); this.setDepthTest(true);
    this.setCull(!m.two_sided);
    this.drawInstanced(s, it.ib || this.inst.main, it.base, it.count);
  }

  // §12: Ex = clamp(Middle Gray / (adapted luminance + 0.001), Auto Exposure Min, Auto Exposure Max)
  // (the picture uses the GPU's own value; this one, read back now and then, is for the HUD)
  exposureValue() {
    const s = this.settings, env = this.env;
    if (!s.exposureAuto) return Math.pow(2, s.exposure);
    const e = (env.middleGray ?? 0.18) / (this.lumAdapted + 0.001);
    return Math.min(Math.max(e, env.aeMin ?? 0.5), env.aeMax ?? 10) * Math.pow(2, s.exposureBias || 0);
  }

  lutTextures(list) {
    // [{tex, weight}] for the two heaviest imagespace LUTs that have loaded (the game blends up to four)
    this._lutCache = this._lutCache || new Map();
    const out = [];
    for (const l of [...list].sort((a, b) => b.weight - a.weight).slice(0, 2)) {
      const path = 'textures\\' + l.path.replace(/^textures[\\/]/i, '');
      if (!this._lutCache.has(path)) {
        this._lutCache.set(path, null);
        this.texture(path, { clamp: true, lookup: true }).then(t => this._lutCache.set(path, t));
      }
      const t = this._lutCache.get(path);
      if (t) out.push({ tex: t.tex, weight: l.weight });
    }
    return out;
  }

  // §20 sky colour by elevation into a 1024 x 1 strip (sine of the elevation, -1 .. 1), rebuilt when the weather
  // or the sky-dome rings change; the sky shader reads it instead of walking the rings for every pixel
  skyLut() {
    const env = this.env;
    if (this._skyTex && this._skyEnv === env && this._skyRings === this.skyRings) return this._skyTex;
    const rings = (this.skyRings || []).slice(0, 32);
    const key = `${env.skyUpper}|${env.skyLower}|${env.horizon}|${env.skyScale ?? 1}|${rings.map(r => r.join(',')).join(';')}`;
    this._skyEnv = env; this._skyRings = this.skyRings;
    if (this._skyTex && key === this._skyKey) return this._skyTex;
    this._skyKey = key;
    const gl = this.gl, N = 1024, data = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { data.set(skyColor((i + 0.5) / N * 2 - 1, env, rings), i * 4); data[i * 4 + 3] = 1; }
    if (!this._skyTex) {
      this._skyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this._skyTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else gl.bindTexture(gl.TEXTURE_2D, this._skyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, 1, 0, gl.RGBA, gl.FLOAT, data);
    return this._skyTex;
  }

  pass(name, target, setup) {
    const gl = this.gl, p = this.progs[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    this.useProg(p); setup(p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // §8 placed lights, clustered. The view is cut into tiles across x tiles down x depth slices (logarithmic); each
  // cluster lists every light whose sphere reaches into it, and a pixel loops over its own cluster only. So every
  // light touching a surface lights it (as in the game), nothing depends on which lights are nearest the camera (no
  // lights popping in and out while the view moves), and a pixel still evaluates only the few around it.
  // One RGBA32F texture 1024 wide (LIGHTING_FS lightTexel): 3 texels per light, 1 per cluster (first index, count),
  // then the light indices 4 per texel. Rebuilt only when the view, the render size or the lights change.
  buildLightGrid(view, proj, planes, sw, sh) {
    const gl = this.gl, all = this.cellVisible ? this.pointLights : [];
    const G = this._lightGrid || (this._lightGrid = { on: false, tex: null, rows: 0, data: new Float32Array(0), box: null, key: '' });
    const key = `${view.join(',')}|${proj[0]},${proj[5]}|${sw}x${sh}|${this.zNear}|${this.lightsVersion || 0}|${this.lightShadow?.slotKey || ''}`;
    if (key === G.key) return;
    G.key = key; G.on = false;
    if (!all.length) return;
    const vis = [];
    for (const l of all) if (sphereVisible(planes, l.pos, l.radius)) { vis.push(l); if (vis.length >= MAX_LIGHTS) break; }
    if (!vis.length) return;
    const TX = 16, TY = Math.max(6, Math.min(16, Math.round(16 * sh / Math.max(1, sw)))), SZ = 24;
    const near = this.zNear, far = Math.max(near * 2, Math.min(this.zFar, 20000));
    const zscale = SZ / Math.log(far / near), NC = TX * TY * SZ, n = vis.length;
    const slice = (d) => Math.min(SZ - 1, Math.max(0, Math.floor(Math.log(Math.max(d, near) / near) * zscale)));
    if (!G.box || G.box.length < n * 6) G.box = new Int16Array(Math.max(n * 6, 6144));
    const box = G.box, counts = new Uint32Array(NC), V = view, P = proj;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const l = vis[i], p = l.pos, r = l.radius, o = i * 6;
      const vx = V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12];
      const vy = V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13];
      const vz = V[2] * p[0] + V[6] * p[1] + V[10] * p[2] + V[14];
      const d = -vz;                                         // depth in front of the camera
      box[o] = 1; box[o + 1] = 0;                            // empty unless filled below
      if (d + r < near) continue;
      let x0 = 0, x1 = TX - 1, y0 = 0, y1 = TY - 1;
      if (d - r > near) {                                    // wholly in front: the screen box of its view-space box
        let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        for (let c = 0; c < 8; c++) {
          const x = vx + (c & 1 ? r : -r), y = vy + (c & 2 ? r : -r), z = vz + (c & 4 ? r : -r);
          const cw = P[3] * x + P[7] * y + P[11] * z + P[15];
          const nx = (P[0] * x + P[4] * y + P[8] * z + P[12]) / cw, ny = (P[1] * x + P[5] * y + P[9] * z + P[13]) / cw;
          if (nx < mnx) mnx = nx; if (nx > mxx) mxx = nx; if (ny < mny) mny = ny; if (ny > mxy) mxy = ny;
        }
        x0 = Math.max(0, Math.floor((mnx * 0.5 + 0.5) * TX)); x1 = Math.min(TX - 1, Math.floor((mxx * 0.5 + 0.5) * TX));
        y0 = Math.max(0, Math.floor((mny * 0.5 + 0.5) * TY)); y1 = Math.min(TY - 1, Math.floor((mxy * 0.5 + 0.5) * TY));
        if (x0 > x1 || y0 > y1) continue;
      }
      const s0 = slice(d - r), s1 = slice(d + r);
      box[o] = x0; box[o + 1] = x1; box[o + 2] = y0; box[o + 3] = y1; box[o + 4] = s0; box[o + 5] = s1;
      for (let s = s0; s <= s1; s++) for (let y = y0; y <= y1; y++) {
        const row = (s * TY + y) * TX;
        for (let x = x0; x <= x1; x++) counts[row + x]++;
      }
      total += (x1 - x0 + 1) * (y1 - y0 + 1) * (s1 - s0 + 1);
    }
    const W = 1024, clusterStart = n * 5, indexStart = clusterStart + NC;
    const rows = Math.ceil((indexStart + Math.ceil(total / 4)) / W);
    if (G.data.length < rows * W * 4) G.data = new Float32Array(rows * W * 4);
    const D = G.data;
    for (let i = 0; i < n; i++) {               // 5 texels: xyz radius | colour, specular | attenuation, ambient only | spot
      const l = vis[i], o = i * 20, dir = l.dir || [0, 0, -1];   // | cone falloff exponent, shadow spotlight, shadow slot
      D[o] = l.pos[0]; D[o + 1] = l.pos[1]; D[o + 2] = l.pos[2]; D[o + 3] = (l.cone ?? -2) > -1.5 ? -l.radius : l.radius;
      D[o + 4] = l.color[0]; D[o + 5] = l.color[1]; D[o + 6] = l.color[2]; D[o + 7] = l.spec ?? 1;
      D[o + 8] = l.att[0]; D[o + 9] = l.att[1]; D[o + 10] = l.att[2]; D[o + 11] = l.ambient || 0;
      D[o + 12] = dir[0]; D[o + 13] = dir[1]; D[o + 14] = dir[2]; D[o + 15] = l.cone ?? -2;
      D[o + 16] = l.falloff ?? 1; D[o + 17] = l.shadow === 1 ? 1 : 0; D[o + 18] = l._lsSlot ?? -1; D[o + 19] = 0;
    }
    const cursor = new Uint32Array(NC);
    for (let c = 0, acc = 0; c < NC; c++) {
      const t = (clusterStart + c) * 4;
      D[t] = acc; D[t + 1] = counts[c]; D[t + 2] = 0; D[t + 3] = 0;
      cursor[c] = acc; acc += counts[c];
    }
    const ib = indexStart * 4;
    for (let i = 0; i < n; i++) {
      const o = i * 6, x0 = box[o], x1 = box[o + 1];
      if (x0 > x1) continue;
      const y0 = box[o + 2], y1 = box[o + 3], s0 = box[o + 4], s1 = box[o + 5];
      for (let s = s0; s <= s1; s++) for (let y = y0; y <= y1; y++) {
        const row = (s * TY + y) * TX;
        for (let x = x0; x <= x1; x++) D[ib + cursor[row + x]++] = i;
      }
    }
    if (!G.tex || G.rows < rows) {
      if (G.tex) gl.deleteTexture(G.tex);
      G.rows = Math.max(rows, 8);
      G.tex = gl.createTexture();
      this.bindUnit(LIGHT_UNIT, G.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, G.rows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else this.bindUnit(LIGHT_UNIT, G.tex);
    gl.activeTexture(gl.TEXTURE0 + LIGHT_UNIT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, rows, gl.RGBA, gl.FLOAT, D, 0);
    Object.assign(G, { on: true, tx: TX, ty: TY, sz: SZ, clusterStart, indexStart, zscale, near, lights: n, entries: total });
  }
}

const isDecal = (m) => !!(m.decal || m.dynamic_decal);
// a solid (not blended) surface writes depth unless its material turns it off; alpha-tested ones always do (hair)
const writesDepth = (m) => m.zwrite !== false || !!(m.alpha && m.alpha.test);
const BLEND = (() => { const g = WebGL2RenderingContext; return [g.ONE, g.ZERO, g.SRC_COLOR, g.ONE_MINUS_SRC_COLOR, g.DST_COLOR,
  g.ONE_MINUS_DST_COLOR, g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.DST_ALPHA, g.ONE_MINUS_DST_ALPHA, g.SRC_ALPHA_SATURATE]; })();

// Landscape: the calibrated landscape factors (specular 0.6, smoothness 1) and the LAND vertex colours
const LAND_MAT = { kind: 'land', textures: {}, alpha: {}, specular_enabled: true, specular_mult: 0.6, smoothness: 1,
  vertex_colors: true, uv_offset: [0, 0], uv_scale: [1, 1] };
// Water (placeholder until the water shader exists): a flat, translucent tinted plane
const WATER_MAT = { kind: 'lighting', textures: {}, alpha: { blend: true, src: 6, dst: 7 }, specular_enabled: false,
  specular_mult: 0, smoothness: 0, vertex_colors: true, vertex_alpha: true, two_sided: true, zwrite: false,
  uv_offset: [0, 0], uv_scale: [1, 1] };

// §20: the sky colour seen at elevation sin = e: the sky dome's ring weights for (Horizon, Sky-Lower, Sky-Upper),
// mixed in gamma space and linearised (matched the calibration shots better than a linear mix), or without dome rings
// a plain gradient. The same maths the sky shader ran per pixel before the lookup strip.
function skyColor(e, env, rings) {
  const sat = (x) => Math.min(1, Math.max(0, x));
  if (rings.length > 1) {
    const el = Math.asin(Math.max(-1, Math.min(1, e))) * 180 / Math.PI;
    let w = rings[0].slice(1, 4);
    for (let i = 1; i < rings.length; i++) {
      if (el <= rings[i][0]) {
        const t = sat((el - rings[i - 1][0]) / Math.max(rings[i][0] - rings[i - 1][0], 1e-4));
        w = [1, 2, 3].map(k => rings[i - 1][k] + (rings[i][k] - rings[i - 1][k]) * t);
        break;
      }
      w = rings[i].slice(1, 4);
    }
    const s = Math.max(env.skyScale ?? 1, 1e-4), g = (v) => Math.pow(Math.max(v / s, 0), 1 / 2.2);
    return [0, 1, 2].map(c => Math.pow(Math.max(w[0] * g(env.horizon[c]) + w[1] * g(env.skyLower[c]) + w[2] * g(env.skyUpper[c]), 0), 2.2) * s);
  }
  if (e >= 0) { const t = Math.pow(sat(e / 0.55), 0.6); return [0, 1, 2].map(c => env.horizon[c] + (env.skyUpper[c] - env.horizon[c]) * t); }
  const t = sat(-e / 0.1);
  return [0, 1, 2].map(c => env.horizon[c] + (env.skyLower[c] - env.horizon[c]) * t);
}

function rot3(r) {                // Rx(-x)·Ry(-y)·Rz(-z), row-major 3x3
  const [cx, sx] = [Math.cos(-r[0]), Math.sin(-r[0])], [cy, sy] = [Math.cos(-r[1]), Math.sin(-r[1])];
  const [cz, sz] = [Math.cos(-r[2]), Math.sin(-r[2])];
  const X = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], Y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Z = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return mul3(mul3(X, Y), Z);
}
function mul3(a, b) { return [0, 1, 2].map(i => [0, 1, 2].map(j => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])); }
export function refMatrix(pos, rot, rot2, scale) {
  let R = rot3(rot || [0, 0, 0]);
  if (rot2) R = mul3(R, rot3(rot2));
  const sc = scale || 1, m = new Float32Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = R[r][c] * sc;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  return m;
}
// six planes (a, b, c, d) of a view-projection matrix, normalised; inside when a·x + b·y + c·z + d > -radius
export function frustumPlanes(m) {
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), out = [];
  for (const [a, sgn] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) {
    const p = [r3[0] + sgn * a[0], r3[1] + sgn * a[1], r3[2] + sgn * a[2], r3[3] + sgn * a[3]];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
  }
  return out;
}
export function sphereVisible(planes, c, r) {
  for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  return true;
}

// Values controllers may animate, starting from the material's own (falloff "angles" are the stored cosines)
function liveValues(m) {
  return {
    u_offset: m.uv_offset?.[0] ?? 0, v_offset: m.uv_offset?.[1] ?? 0, u_scale: m.uv_scale?.[0] ?? 1, v_scale: m.uv_scale?.[1] ?? 1,
    alpha: m.alpha?.value ?? 1, emit_mult: m.kind === 'effect' ? (m.base_color_scale ?? 1) : (m.emit_mult ?? 1),
    emit_color: m.kind === 'effect' ? null : (m.emit_color || [0, 0, 0]),
    specular_color: m.specular_color || [1, 1, 1], specular_mult: m.specular_mult ?? 1, smoothness: m.smoothness ?? 1,
    env_mask_scale: m.env_mask_scale ?? 1, refraction: m.refraction_strength ?? 0,
    falloff_start_angle: m.falloff?.[0] ?? 1, falloff_stop_angle: m.falloff?.[1] ?? 0,
    falloff_start_opacity: m.falloff?.[2] ?? 1, falloff_stop_opacity: m.falloff?.[3] ?? 1,
  };
}

export function defaultEnv() {
  // neutral built-in light, NOT from the game: used until a weather is chosen
  const up = [0.55, 0.62, 0.72], side = [0.42, 0.44, 0.47], down = [0.25, 0.23, 0.21];
  return {
    name: 'Neutral studio (built-in, not from the game)',
    sunDir: vec3.norm([0.4, -0.5, 0.75]), sunColor: [3.0, 2.9, 2.7], sunDisc: [40, 38, 34], sunGlare: [1.0, 0.9, 0.7],
    ambRows: ambientRows(side, side, side, side, up, down),
    skyUpper: [0.25, 0.42, 0.75], skyLower: [0.35, 0.33, 0.3], horizon: [0.75, 0.8, 0.85],
    bloomThreshold: 0.5, bloomScale: 0.2, tonemapE: 0.02, middleGray: 0.18, aeMin: 1, aeMax: 3,
    cinematic: [1, 1, 1], tint: [1, 1, 1, 0], luts: [], fog: null, eyeAdaptSpeed: 3,
  };
}
