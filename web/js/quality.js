// Quality tiers: Lightbox on every PC. Ultra is Lightbox as it always drew: every knob below holds the value the
// renderer used before tiers existed, so a strong GPU's pictures are unchanged. The lower tiers trade detail for speed
// and video memory on weaker GPUs (laptop graphics, 2-4 GB cards, Fallout 4's minimum-spec class). Auto picks a tier
// from the GPU's name (classify) and steps down while frames stay slow (main.js, the governor); a tier chosen by hand
// is kept as it is.
export const TIERS = ['ultra', 'high', 'medium', 'low'];
export const TIER_LABEL = { ultra: 'Ultra', high: 'High', medium: 'Medium', low: 'Low' };
const MB = 2 ** 20;
// texCap: textures larger than this are uploaded from their first smaller mip (0: as the file is). texKeep: unused
// textures kept on the GPU (renderer.sweepTextures). dprCap: device pixels per CSS pixel. msaa: most MSAA samples.
// aoSamples / grSteps: SAO samples and light-shaft march steps (§21 / §24). lsMax: placed lights casting shadows at once
// (§23). animFps: frame-rate cap while only an animation moves (0: the display's rate). playScale: render scale while
// something moves (an animation, the camera), full resolution again when still. inFlight: frames queued to the GPU
// before the page waits (a slow GPU otherwise answers input seconds late). outScale: the whole picture (the final
// full-screen passes too, which cost as much as the scene on a slow GPU) drawn this much smaller and scaled up by
// the browser; screenshots keep their full size.
export const KNOBS = {
  ultra: { texCap: 0, texKeep: 768 * MB, dprCap: 2, msaa: 4, aoSamples: 10, grSteps: 32, lsMax: 8, animFps: 0, playScale: 1, inFlight: 2, outScale: 1 },
  high: { texCap: 0, texKeep: 512 * MB, dprCap: 2, msaa: 4, aoSamples: 10, grSteps: 32, lsMax: 8, animFps: 60, playScale: 1, inFlight: 2, outScale: 1 },
  medium: { texCap: 1024, texKeep: 256 * MB, dprCap: 1.5, msaa: 2, aoSamples: 8, grSteps: 20, lsMax: 4, animFps: 30, playScale: 0.85, inFlight: 2, outScale: 0.85 },
  low: { texCap: 512, texKeep: 128 * MB, dprCap: 1, msaa: 1, aoSamples: 6, grSteps: 12, lsMax: 2, animFps: 30, playScale: 0.8, inFlight: 1, outScale: 0.7 },
};

// The GPU's name as the browser reports it, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Ti (0x00002208) Direct3D11
// vs_5_0 ps_5_0, D3D11)" or "ANGLE (Intel, Intel(R) UHD Graphics 620 ...)".
export function gpuName(gl) {
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return String((e && gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
}

// A starting tier from the GPU's name. Rough classes, by relative speed: current and recent discrete cards keep Ultra;
// GTX 1060 / 970 / RX 580 class High; GTX 1050 / 960, recent integrated graphics (Iris Xe, Radeon 680M) Medium; older
// integrated graphics, MX parts, software renderers Low. Unknown names start at High (the governor steps down if needed).
export function classify(name) {
  const n = name.toLowerCase();
  const rule = (tier, why) => ({ tier, why });
  if (/swiftshader|basic render driver|llvmpipe|software/.test(n)) return rule('low', 'software renderer');
  if (/nvidia|geforce|quadro/.test(n)) {
    if (/rtx|titan (v|rtx)|quadro rtx|\brtx a\d/.test(n)) return rule('ultra', 'GeForce RTX class');
    if (/gtx\s*16\d\d|gtx\s*10[678]0|gtx\s*9[78]0|titan x/.test(n)) return rule('high', 'GTX 1060 / 970 class');
    if (/gtx\s*10[35]0|gtx\s*9[56]0|gtx\s*7[78]0/.test(n)) return rule('medium', 'GTX 1050 / 960 class');
    if (/\bmx\s*\d|gt\s*\d|gtx\s*[4-7]\d\d/.test(n)) return rule('low', 'entry or older GeForce');
    return rule('high', 'NVIDIA, model not recognised');
  }
  if (/amd|radeon|ati /.test(n)) {
    if (/radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|radeon r\d graphics|radeon \d{3}m|vega \d\b/.test(n))
      return /\b(680m|760m|780m|880m|890m)\b/.test(n) ? rule('medium', 'recent Radeon integrated graphics') : rule('low', 'Radeon integrated graphics');
    if (/rx\s*[679]\d{3}|radeon vii|rx\s*5[67]00/.test(n)) return rule('ultra', 'Radeon RX 5700 class or newer');
    if (/rx\s*5[0-5]00|rx\s*[45]\d0\b|rx\s*590|vega (56|64)|r9 (fury|nano)/.test(n)) return rule('high', 'RX 580 class');
    if (/r9\s*\d/.test(n)) return rule('medium', 'Radeon R9 class');
    if (/r7\s*\d|r5\s*\d|hd\s*\d{4}/.test(n)) return rule('low', 'older Radeon');
    return rule('high', 'AMD, model not recognised');
  }
  if (/intel/.test(n)) {
    if (/\barc\b/.test(n)) return rule('high', 'Intel Arc');
    if (/iris.*xe|xe graphics/.test(n)) return rule('medium', 'Intel Iris Xe');
    return rule('low', 'Intel integrated graphics');
  }
  return rule('high', 'GPU not recognised');
}

// The Auto governor's budget: the GPU time per frame above which, held for a while, Auto steps down one tier. A GPU
// classed Ultra steps down only when frames are plainly too slow to use.
export const STEP_DOWN_MS = { ultra: 70, high: 45, medium: 45, low: Infinity };
