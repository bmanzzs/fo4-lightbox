// NIF controller playback: NiTimeController time mapping + key interpolation (linear, quadratic/Hermite, TBC as
// Catmull-Rom-like, constant), applied to shader values and node transforms.
import { mat4, quatSlerp, quatFromEulerXYZ } from './math.js';

export const LIGHTING_FLOAT = { 0: 'refraction', 8: 'env_mask_scale', 9: 'smoothness', 10: 'specular_mult',
  11: 'emit_mult', 12: 'alpha', 20: 'u_offset', 21: 'u_scale', 22: 'v_offset', 23: 'v_scale' };
export const LIGHTING_COLOR = { 0: 'specular_color', 1: 'emit_color' };
export const EFFECT_FLOAT = { 0: 'emit_mult', 1: 'falloff_start_angle', 2: 'falloff_stop_angle',
  3: 'falloff_start_opacity', 4: 'falloff_stop_opacity', 5: 'alpha', 6: 'u_offset', 7: 'u_scale', 8: 'v_offset',
  9: 'v_scale' };
export const EFFECT_COLOR = { 0: 'emit_color' };

// Gamebryo NiTimeController::ComputeScaledTime
export function scaledTime(c, t) {
  const lo = c.start, hi = c.stop, span = hi - lo;
  const st = t * (c.frequency || 1) + (c.phase || 0);
  const cycle = (c.flags >> 1) & 3;
  if (span <= 0) return lo;
  if (cycle === 2) return Math.min(hi, Math.max(lo, st));                // clamp
  if (cycle === 1) {                                                        // reverse (ping-pong)
    let u = ((st - lo) % (2 * span) + 2 * span) % (2 * span);
    return lo + (u > span ? 2 * span - u : u);
  }
  return lo + (((st - lo) % span) + span) % span;                          // loop
}

function hermite(p0, m0, p1, m1, s) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

// keys: {type, keys:[[t, [v..], fwd, bwd]]}; returns array of width n
export function sampleKeys(k, t, fallback) {
  if (!k || !k.keys || !k.keys.length) return fallback;
  const keys = k.keys, n = keys.length;
  if (t <= keys[0][0] || n === 1) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] < t) i++;
  const [t0, v0, f0] = keys[i], [t1, v1, , b1] = keys[i + 1];
  const s = (t - t0) / Math.max(1e-9, t1 - t0);
  if (k.type === 5) return v0;                                             // constant
  if (k.type === 2 && f0 && b1) return v0.map((a, j) => hermite(a, f0[j], v1[j], b1[j], s));
  if (k.type === 3) {                                                       // TBC: tangents from neighbours
    const vp = keys[Math.max(0, i - 1)][1], vn = keys[Math.min(n - 1, i + 2)][1];
    return v0.map((a, j) => hermite(a, (v1[j] - vp[j]) * 0.5, v1[j], (vn[j] - a) * 0.5, s));
  }
  return v0.map((a, j) => a + (v1[j] - a) * s);
}

export function sampleTransform(ip, t) {
  let q = ip.rotation, tr = ip.translation, sc = ip.scale;
  if (ip.rot_keys && ip.rot_keys.length) {
    const k = ip.rot_keys;
    if (t <= k[0][0]) q = k[0][1];
    else if (t >= k[k.length - 1][0]) q = k[k.length - 1][1];
    else {
      let i = 0; while (i < k.length - 2 && k[i + 1][0] < t) i++;
      q = quatSlerp(k[i][1], k[i + 1][1], (t - k[i][0]) / Math.max(1e-9, k[i + 1][0] - k[i][0]));
    }
  } else if (ip.xyz_keys) {
    const e = ip.xyz_keys.map(kk => sampleKeys(kk, t, [0])[0]);
    q = quatFromEulerXYZ(e[0], e[1], e[2]);
  }
  if (ip.trans_keys && ip.trans_keys.keys.length) tr = sampleKeys(ip.trans_keys, t, tr);
  if (ip.scale_keys && ip.scale_keys.keys.length) sc = sampleKeys(ip.scale_keys, t, [sc])[0];
  // NIF interpolator "invalid" sentinels (-FLT_MAX) mean: keep the node's own value
  const bad = v => !isFinite(v) || Math.abs(v) > 1e30;
  return { q: q && !q.some(bad) ? q : null, t: tr && !tr.some(bad) ? tr : null, s: bad(sc) ? null : sc };
}

export function transformMatrix(base, smp) {
  // base: column-major local matrix of the node; replace the parts the interpolator provides
  const t = smp.t || [base[12], base[13], base[14]];
  const sx = Math.hypot(base[0], base[1], base[2]);
  const s = smp.s ?? sx;
  if (!smp.q) {
    const m = new Float32Array(base);
    const k = s / (sx || 1);
    for (let i = 0; i < 11; i++) if (i % 4 !== 3) m[i] *= k;
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
  }
  return mat4.fromQuatTRS(smp.q, t, s);
}
