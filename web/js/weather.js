// Weather sample (Fallout4.esm via server/esm_weather.py) -> renderer lighting environment.
// Every number comes from the sample; how it is turned into light follows docs/engine-notes.md and
// docs/weather-notes.md. Items marked LOW are the notes' low-confidence calls, to be settled by the in-game shots.
import { vec3 } from './math.js';
import { defaultEnv, ambientRows, lin } from './renderer.js';

const mul = (c, s) => c.map(v => v * s);

// Sun path, fitted to in-game shadows (tools/calibration, 2026-10-05): a sun on a circular sky path, written as
// latitude / declination / hour angle; "rise" and "set" are the middles of the climate's sunrise and sunset windows
// (07:00 / 19:00 in DefaultClimate, solar noon 13:00). Fit: lat 76.6, decl 34.0 -> 12:00 at 46.8 deg elevation,
// azimuth 161.7 (measured 44.6-48 deg, about 165); 07:00 at 33 deg (measured about 33); 9:00 -> 12:00 swing 50.6
// deg (registered 47-50). FO4's sun stays fairly high all day. Night (after "set", before "rise"): the light (moon
// colours from the weather) runs back along the same arc, west to east, like a reflection of a sun circling below
// the horizon; it is continuous at both ends. Fit to the night shots: at 22:00 the game lights from the south-west
// at a medium height (shadows to the north-east in the back, side and top views), which this gives (the 16:00
// position).
export const SUN_FIT = { lat: 76.6, decl: 34.0 };
export function sunDirection(hour, rise = 7, set = 19, az = 0) {
  const span = set - rise;
  let h = ((hour - rise) % 24 + 24) % 24, night = false;          // hours since sunrise
  if (h > span) { night = true; h = span * (1 - (h - span) / (24 - span)); }
  const r = Math.PI / 180, H = (h - span / 2) * 15 * r, p = SUN_FIT.lat * r, dl = SUN_FIT.decl * r;
  let d = [-Math.cos(dl) * Math.sin(H),
    Math.sin(dl) * Math.cos(p) - Math.cos(dl) * Math.sin(p) * Math.cos(H),
    Math.sin(p) * Math.sin(dl) + Math.cos(p) * Math.cos(dl) * Math.cos(H)];
  d[2] = Math.max(d[2], 0.03);
  const c = Math.cos(az), s = Math.sin(az);
  d = [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  return { dir: vec3.norm(d), night };
}

// The visible sun disc does not sit where the light comes from (game shots 2026-10-08, engine-notes Section 25):
// shadows at 12:00 and 14:00 match a sun about 45 degrees up (the path above), while the disc is drawn about
// 12 degrees higher. The disc's path, measured hourly from 09:00 to 18:00 with the exact first-person camera and
// symmetric about solar noon: [hours from noon, elevation, degrees from due south]. The 6 h row (horizon) is
// extrapolated; past it the disc keeps sinking.
const SUN_DISC = [[0, 61.9, 0], [1, 56.74, 16.72], [2, 47.09, 31.62], [3, 34.99, 42.79], [4, 21.88, 50.42],
  [5, 10.03, 55.9], [6, -1.5, 60]];
export function sunDiscDirection(hour, rise = 7, set = 19, az = 0) {
  const noon = (rise + set) / 2, half = (set - rise) / 2;
  let t = ((hour - noon) % 24 + 36) % 24 - 12;               // hours from solar noon, -12..12
  t *= 6 / half;                                               // the table is for a 12-hour day
  const a = Math.abs(t);
  let el, off;
  if (a > 6) {                                                 // night: keep sinking (no disc pops up anywhere)
    el = Math.max(-80, -1.5 - (a - 6) * 12); off = Math.min(90, 60 + (a - 6) * 5);
  } else {
    const i = Math.min(SUN_DISC.length - 2, Math.floor(a)), f = a - i;
    el = SUN_DISC[i][1] + (SUN_DISC[i + 1][1] - SUN_DISC[i][1]) * f;
    off = SUN_DISC[i][2] + (SUN_DISC[i + 1][2] - SUN_DISC[i][2]) * f;
  }
  const r = Math.PI / 180, azd = (180 + Math.sign(t) * off) * r, e = el * r;   // morning (t < 0): east of south
  let d = [Math.cos(e) * Math.sin(azd), Math.cos(e) * Math.cos(azd), Math.sin(e)];
  const c = Math.cos(az), s = Math.sin(az);
  d = [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  return vec3.norm(d);
}

// The weather's time-of-day light in words: 'daylight', 'between sunrise and morning light'
const TOD_WORD = { Night: 'night', EarlySunrise: 'dawn', Sunrise: 'sunrise', LateSunrise: 'morning', Day: 'day',
  EarlySunset: 'afternoon', Sunset: 'sunset', LateSunset: 'dusk' };
const TOD_ORDER = ['Night', 'EarlySunrise', 'Sunrise', 'LateSunrise', 'Day', 'EarlySunset', 'Sunset', 'LateSunset'];
function lightWords(weights) {
  const top = Object.entries(weights).filter(([k]) => TOD_WORD[k]).sort((a, b) => b[1] - a[1]);
  if (!top.length) return '';
  const one = (k) => k === 'Day' ? 'daylight' : `${TOD_WORD[k]} light`;
  if (top.length < 2 || top[0][1] >= 0.9) return one(top[0][0]);
  const pair = [top[0][0], top[1][0]].sort((a, b) => TOD_ORDER.indexOf(a) - TOD_ORDER.indexOf(b));
  if (pair[0] === 'Night' && pair[1] === 'LateSunset') pair.reverse();
  return `between ${TOD_WORD[pair[0]]} and ${one(pair[1])}`;
}

// Directional ambient. 'dalc' = the weather's six DALC colours (gamma rows, weather-notes §5): with the fitted sun,
// the shadowed ground in the calibration shots matches the game's colour within 2 levels of 255 in both clear and
// overcast weather, including its sky-blue tint. 'flat' (NAM0 "Ambient" from every direction) is kept for
// comparison: it gives a grey shadow with no blue.
export const AMBIENT = { mode: 'dalc' };

export function envFromWeather(w, hour, az) {
  const e = defaultEnv();
  const C = w.colors, D = w.dalc, hdr = w.imagespace?.hdr || {}, cin = w.imagespace?.cinematic || {};
  // sun path anchored on the middle of the climate's sunrise and sunset windows (07:00 / 19:00 in DefaultClimate)
  const tm = w.timing || {};
  const rise = tm.sunrise_begin != null ? (tm.sunrise_begin + tm.sunrise_end) / 2 : 7;
  const set = tm.sunset_begin != null ? (tm.sunset_begin + tm.sunset_end) / 2 : 19;
  e.name = `${w.weather?.edid || 'weather'} · ${w.climate?.edid || ''}`;
  const sun = sunDirection(hour, rise, set, az);
  e.sunDir = sun.dir;
  e.sunDiscDir = sunDiscDirection(hour, rise, set, az);       // the sky's disc (below the horizon at night)
  // §4: sun = linear(WTHR Sunlight) x IMGS Sunlight Scale (medium)
  e.sunColor = mul(lin(C['Sunlight']), hdr['Sunlight Scale'] ?? 1);
  // §5 ambient. 'dalc': six colours as gamma rows; a surface facing +Z receives the "Z-" colour (weather-notes §5).
  if (AMBIENT.mode === 'dalc') e.ambRows = ambientRows(D['X-'], D['X+'], D['Y-'], D['Y+'], D['Z-'], D['Z+']);
  else { const a = C['Ambient']; e.ambRows = [0, 1, 2].map(i => [0, 0, 0, a[i]]); }
  e.ambientMode = AMBIENT.mode;
  const skyScale = e.skyScale = hdr['Sky Scale'] ?? 1;
  e.skyUpper = mul(lin(C['Sky-Upper']), skyScale);
  e.skyLower = mul(lin(C['Sky-Lower']), skyScale);
  e.horizon = mul(lin(C['Horizon']), skyScale);
  e.sunDisc = mul(lin(C['Sun']), skyScale * 20 * (w.day_factor ?? 1));   // no sun disc in the night sky
  e.sunGlare = mul(lin(C['Sun Glare']), (w.sun?.glare ?? 0.5) * skyScale);
  e.fog = w.fog || null;
  e.fogNear = lin(C['Fog Near']); e.fogFar = lin(C['Fog Far']);
  e.fogNearHigh = lin(C['Fog Near High'] || C['Fog Near']); e.fogFarHigh = lin(C['Fog Far High'] || C['Fog Far']);
  e.bloomThreshold = hdr['Bloom Threshold'] ?? 0.5;
  e.bloomScale = hdr['Bloom Scale'] ?? 0.1;
  e.tonemapE = hdr['Tonemap E'] ?? 0.02;
  e.middleGray = hdr['Middle Gray'] ?? 0.18;
  e.aeMin = hdr['Auto Exposure Min'] ?? 0.5;
  e.aeMax = hdr['Auto Exposure Max'] ?? 10;
  e.eyeAdaptSpeed = hdr['Eye Adapt Speed'] ?? 3;
  e.cinematic = [cin.Saturation ?? 1, cin.Brightness ?? 1, cin.Contrast ?? 1];
  const t = w.imagespace?.tint;
  e.tint = t ? [...lin(t.color), t.amount] : [1, 1, 1, 0];
  e.luts = w.imagespace?.luts || [];
  e.night = sun.night;
  // §24 light shafts: the weather's god rays (GDRY) at this hour; colours x scales, as stored (not linearised)
  const g = w.god_rays;
  if (g && (g.intensity ?? 0) > 0) e.godRays = {
    intensity: g.intensity, gF: g.fwd_phase ?? 0, gB: g.back_phase ?? 0,
    air: mul(g.air_color || [0, 0, 0], g.air_color_scale ?? 0), fwd: mul(g.fwd_color || [0, 0, 0], g.fwd_color_scale ?? 0),
    back: mul(g.back_color || [0, 0, 0], g.back_color_scale ?? 0),
    name: (g.sources || []).map(s => `${s.edid} ×${(+s.weight).toFixed(2)}`).join(' + '),
  };
  // the sidebar line is plain words (main.js); the record details go in its tooltip
  e.light = lightWords(w.tod_weights || {});
  e.detail = `${w.weather?.edid} (${w.weather?.formid}, ${w.weather?.plugin || 'ESM'})\n` +
    `${(w.imagespace?.sources || []).map(s => `${s.edid} ×${(+s.weight).toFixed(2)}`).join(' + ')}\n` +
    `time of day ${Object.entries(w.tod_weights || {}).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}\n` +
    `sunlight scale ${hdr['Sunlight Scale'] ?? '-'}, exposure ${e.aeMin}-${e.aeMax}`;
  return e;
}
