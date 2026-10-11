// Inline SVG icons (drawn for this project; 24x24 viewBox, stroked with currentColor unless noted).
const svg = (body, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// radiation trefoil: three 60-degree blades around a hub
function trefoil(cx, cy, ri, ro) {
  const P = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  let d = '';
  for (const c of [-90, 30, 150]) {
    const a1 = (c - 30) * Math.PI / 180, a2 = (c + 30) * Math.PI / 180;
    d += `M${P(ri, a1)}L${P(ro, a1)}A${ro} ${ro} 0 0 1 ${P(ro, a2)}L${P(ri, a2)}A${ri} ${ri} 0 0 0 ${P(ri, a1)}Z`;
  }
  return `<path d="${d}" fill="currentColor" stroke="none"/><circle cx="${cx}" cy="${cy}" r="${(ri * 0.62).toFixed(2)}" fill="currentColor" stroke="none"/>`;
}
const CLOUD = 'M7.5 18h9.2a3.8 3.8 0 0 0 .5-7.57A5.6 5.6 0 0 0 6.4 11.3 3.4 3.4 0 0 0 7.5 18z';
const CLOUD_HI = 'M7.5 14h9.2a3.6 3.6 0 0 0 .5-7.17A5.4 5.4 0 0 0 6.5 7.5 3.25 3.25 0 0 0 7.5 14z';
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315].map(a => {
  const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return `M${(12 + 6.6 * c).toFixed(2)} ${(12 + 6.6 * s).toFixed(2)}L${(12 + 9 * c).toFixed(2)} ${(12 + 9 * s).toFixed(2)}`;
}).join('');

export const WEATHER_ICONS = {
  studio: svg('<path d="M9.2 17.5h5.6M10 20.5h4"/><path d="M12 3.2a5.8 5.8 0 0 0-3.4 10.5c.6.5.9 1.1.9 1.9v1.9h5v-1.9c0-.8.3-1.4.9-1.9A5.8 5.8 0 0 0 12 3.2z"/>'),
  clear: svg(`<circle cx="12" cy="12" r="4.2"/><path d="${RAYS}"/>`),
  clearest: svg(`<circle cx="11" cy="13" r="3.8"/><path d="${[0, 60, 120, 180, 240, 300].map(a => {
    const r = a * Math.PI / 180; return `M${(11 + 6 * Math.cos(r)).toFixed(2)} ${(13 + 6 * Math.sin(r)).toFixed(2)}L${(11 + 8.2 * Math.cos(r)).toFixed(2)} ${(13 + 8.2 * Math.sin(r)).toFixed(2)}`;
  }).join('')}"/><path d="M19 2.5v4M17 4.5h4" stroke-width="1.5"/>`),
  overcast: svg(`<path d="${CLOUD}"/><path d="M15.5 8.2a4.6 4.6 0 0 1 5 4.6"/>`),
  misty: svg(`<path d="${CLOUD_HI}"/><path d="M4 17.5h11M8 21h12"/>`),
  foggy: svg('<path d="M4 7h16M3 11h12M7 15h14M4 19h11"/>'),
  rain: svg(`<path d="${CLOUD_HI}"/><path d="M8.5 16.5l-1.2 3M12.5 16.5l-1.2 3M16.5 16.5l-1.2 3"/>`),
  radstorm: svg(`<path d="${CLOUD_HI}"/><path d="M12.8 14.5l-2.6 4h3l-2 4" stroke-width="1.8"/>`),
  glowingsea: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${trefoil(12, 12, 2.9, 9)}</svg>`,
};

export const CAT_ICONS = {
  armor: svg('<path d="M12 3l7 2.8v5.4c0 4.4-2.9 7.9-7 9.8-4.1-1.9-7-5.4-7-9.8V5.8z"/>'),
  clothes: svg('<path d="M8.5 3.5L4 6.5l2 3.5 2-1V20.5h8V9l2 1 2-3.5-4.5-3c-.6 1.5-2 2.4-3.5 2.4S9.1 5 8.5 3.5z"/>'),
  weapons: svg('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>'),
  actors: svg('<circle cx="7" cy="9" r="1.9"/><circle cx="11" cy="5.8" r="1.9"/><circle cx="16" cy="6.5" r="1.9"/><circle cx="18.6" cy="11" r="1.9"/><path d="M8.5 18.5c-1.6-2.8 1.3-6.8 4.6-6.6 3.4.3 5.2 4.6 2.7 7-1.6 1.5-5.8 1.6-7.3-.4z"/>'),
  character: svg('<circle cx="12" cy="7.5" r="3.8"/><path d="M4.5 20.5c.6-4.2 3.6-6.8 7.5-6.8s6.9 2.6 7.5 6.8"/>'),
  architecture: svg('<path d="M4 20.5V8l8-4.5L20 8v12.5M4 20.5h16"/><path d="M9 20.5v-5h6v5M8 10.5h.01M12 10.5h.01M16 10.5h.01"/>'),
  props: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  landscape: svg('<path d="M2.5 19.5l6.5-10 4.2 6 3-4.2 5.3 8.2z"/>'),
  plants: svg('<path d="M12 21v-6"/><path d="M12 3.5l5 6.5h-3l4 5.5H6l4-5.5H7z"/>'),
  effects: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  furniture: svg('<path d="M6.5 11V4.5h11V11M5 11h14v3.5H5zM6.5 14.5v6M17.5 14.5v6"/>'),
  workshop: svg('<path d="M14.5 6.5a4 4 0 0 0 4.9 5.2l-8.6 8.6a2.1 2.1 0 0 1-3-3l8.6-8.6a4 4 0 0 0 5.2 4.9l-2.6-2.6.6-2.5 2.5-.6z"/>'),
  vehicles: svg('<path d="M4 16.5v-4l2-4.5h12l2 4.5v4z"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/><path d="M4 12.5h16"/>'),
  sky: svg(`<path d="${CLOUD}"/>`),
  terminals: svg('<rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M8 20h8M12 16v4M7 8.5l2.5 2-2.5 2M11.5 12.5h4"/>'),
  backpack: svg('<path d="M8 7V5.5a4 4 0 0 1 8 0V7"/><rect x="5" y="7" width="14" height="14" rx="3"/><path d="M9 14h6v4H9z"/>'),
  other: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>'),
};

// body poses, facing right: bind (T-pose), relaxed idle, walk, jog, run, sprint
export const POSE_ICONS = {
  bind: svg('<circle cx="12" cy="4.6" r="2"/><path d="M3.5 9.4h17M12 7v7.4M12 14.4l-2.6 6.6M12 14.4l2.6 6.6"/>'),
  idle: svg('<circle cx="12" cy="4.6" r="2"/><path d="M12 7v7.4M12 8.8l-2.3 5.4M12 8.8l2.3 5.4M12 14.4l-1.7 6.6M12 14.4l1.7 6.6"/>'),
  walk: svg('<circle cx="12.6" cy="4.6" r="2"/><path d="M12.4 7l-.6 7M12.3 8.9l-2.4 4.2M12.3 8.9l2.3 3.9M11.8 14l-2.5 6.8M11.8 14l2.3 3.4.1 3.4"/>'),
  jog: svg('<circle cx="13.4" cy="4.6" r="2"/><path d="M12.9 7.1l-1.6 6.6M12.6 8.8l-2.8 2.2 1 2.6M12.6 8.8l2.8 1.6 1.4-2M11.3 13.7l-3.2 4.9-1.6-.2M11.3 13.7l3 2.8-.4 4.4"/>'),
  run: svg('<circle cx="14.8" cy="4.6" r="2"/><path d="M14.1 7.2l-2.9 6.2M13.6 8.9l-3.6 1.4-1.2 3M13.6 8.9l3.3 2.5 2.4-1.4M11.2 13.4l-4.3 3.9-2-.6M11.2 13.4l3.7 2.5-.2 5"/>'),
  sprint: svg('<circle cx="16.2" cy="4.8" r="2"/><path d="M15.4 7.4l-3.4 5.8M14.9 9l-3.4.9-1.6 2.8M14.9 9l3.1 2.9 2.6-1M12 13.2l-4.1 4.3-2.2-.3M12 13.2l3.9 2.3.3 5.2M2.5 7.5h4M2 11h3.5M3 14.5h2.5"/>'),
};

// clip categories in the animation search
export const ANIM_ICONS = {
  move: POSE_ICONS.run,
  idle: POSE_ICONS.idle,
  weapon: svg('<path d="M3 7.5h16.5v3.2H11l-.9 2H8l-1.4 6.3H3.4l1.5-6.3L3 10.7z"/><path d="M8.6 10.7l.6 2"/>'),
  melee: svg('<path d="M20 3.5l.5 2.6L9.8 16.8 7.2 14.2 17.9 3.5z"/><path d="M5.6 12.6l5.8 5.8M4 20l3.4-3.4"/>'),
  unarmed: svg('<path d="M6.5 11V8.2a1.6 1.6 0 0 1 3.2 0V11M9.7 8.2V7a1.6 1.6 0 0 1 3.2 0v4M12.9 8a1.6 1.6 0 0 1 3.2 0v3M16.1 9.4a1.6 1.6 0 0 1 3.2 0v4.1a7 7 0 0 1-7 7h-.6a6 6 0 0 1-5-2.7l-2.3-3.6a1.6 1.6 0 0 1 2.6-1.8l1.5 1.8"/>'),
  furniture: svg('<path d="M6.5 11V4.5h11V11M5 11h14v3.5H5zM6.5 14.5v6M17.5 14.5v6"/>'),
  paired: svg('<circle cx="7.5" cy="5.2" r="2"/><circle cx="16.5" cy="5.2" r="2"/><path d="M7.5 7.6v6.6M16.5 7.6v6.6M7.5 10l9 0M5 21l2.5-6.8L10 21M14 21l2.5-6.8L19 21"/>'),
  creature: svg('<circle cx="7" cy="9" r="1.9"/><circle cx="11" cy="5.8" r="1.9"/><circle cx="16" cy="6.5" r="1.9"/><circle cx="18.6" cy="11" r="1.9"/><path d="M8.5 18.5c-1.6-2.8 1.3-6.8 4.6-6.6 3.4.3 5.2 4.6 2.7 7-1.6 1.5-5.8 1.6-7.3-.4z"/>'),
  powerarmor: svg('<path d="M6 10.5a6 6 0 0 1 12 0v3.5l-2 4.5H8L6 14z"/><path d="M8.5 12.5h7M10 15.5h4M12 4.5v3"/>'),
  firstperson: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  object: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  other: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>'),
};

export const UI_ICONS = {
  bulb: svg('<path d="M9.2 17.2h5.6M10 20.2h4"/><path d="M12 2.8a6 6 0 0 0-3.7 10.7c.7.6 1 1.3 1 2.1v1.6h5.4v-1.6c0-.8.3-1.5 1-2.1A6 6 0 0 0 12 2.8z"/>'
    + '<path d="M10.3 6.6a2.7 2.7 0 0 1 1.9-.9" stroke-width="1.4"/>', 'bulb'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
  wear: svg('<circle cx="12" cy="5" r="2"/><path d="M12 7v1.8L3 16.5h18L12 8.8"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11.5v6M9 14.5h6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  // placeholders on the reference buttons until the rendered previews are ready
  male: svg('<circle cx="12" cy="4.6" r="2.4"/><path d="M8 21v-7.5L6.8 9.2c-.2-.9.4-1.7 1.3-1.7h7.8c.9 0 1.5.8 1.3 1.7L16 13.5V21M12 13v8"/>'),
  female: svg('<circle cx="12" cy="4.6" r="2.4"/><path d="M9 21v-5.5H7l2.2-6.5c.3-.9 1.1-1.5 2-1.5h1.6c.9 0 1.7.6 2 1.5l2.2 6.5h-2V21"/>'),
  suit: svg('<circle cx="12" cy="4.6" r="2.4"/><path d="M8 21v-7.5L6.8 9.2c-.2-.9.4-1.7 1.3-1.7h7.8c.9 0 1.5.8 1.3 1.7L16 13.5V21M12 7.5V21M9.5 12h5"/>'),
  leathers: svg('<path d="M8.5 3.5L4 6.5l2 3.5 2-1V20.5h8V9l2 1 2-3.5-4.5-3L12 8z"/><path d="M12 8v12.5M9.5 13.5h1.2"/>'),
  // environment and camera controls
  timeRun: svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v4h-4"/><path d="M12 7.5V12l3 2"/>'),
  slow: svg('<path d="M9 7l6 5-6 5z"/>'),
  fast: svg('<path d="M4.5 7l6 5-6 5zM12.5 7l6 5-6 5z"/>'),
  sunTurn: svg('<circle cx="12" cy="12" r="2.8"/><path d="M12 6.8v1M12 16.2v1M6.8 12h1M16.2 12h1M8.3 8.3l.7.7M15 15l.7.7M8.3 15.7l.7-.7M15 9l.7-.7"/>' +
    '<path d="M20.2 8.5A9 9 0 1 0 21 12.5"/><path d="M21.3 4.9l-1.1 3.6-3.6-1.1"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  aperture: svg('<circle cx="12" cy="12" r="9"/><path d="M14.3 3.3L8.6 13.2M20.6 9.6H9.2M17.8 18.3L12.1 8.4M9.7 20.7l5.7-9.9M3.4 14.4h11.4M6.2 5.7l5.7 9.9"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  chevronsRight: svg('<path d="M6 7l5 5-5 5M12 7l5 5-5 5"/>'),
  play: svg('<path d="M8 5.5l11 6.5-11 6.5z"/>'),
  // File menu
  camera: svg('<path d="M3.5 8.5a2 2 0 0 1 2-2h2.2l1.5-2.2h5.6l1.5 2.2h2.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>'),
  save: svg('<path d="M5 3.5h11.5l3.5 3.5v11.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M7.5 3.5v5h8v-5M7 20.5v-6h10v6"/>'),
  open: svg('<path d="M3.5 18.5v-12a2 2 0 0 1 2-2h4l2 2.5h6.5a2 2 0 0 1 2 2v1.5"/><path d="M3.5 18.5l2.6-7.2a1.6 1.6 0 0 1 1.5-1.1h13.1a1 1 0 0 1 .9 1.4l-2.4 6.5a1.6 1.6 0 0 1-1.5 1z"/>'),
  // environment toggles: sun shadows (a block casting a shadow under the sun), studio floor (a plane)
  shadows: svg('<circle cx="17.5" cy="5.5" r="2.4"/><path d="M17.5 1.6v.8M17.5 8.6v.8M13.6 5.5h.8M20.6 5.5h.8"/>' +
    '<path d="M4.5 20.5h16"/><rect x="5" y="11" width="5" height="9.5"/><path d="M10 20.5l7-3.5h-7z" fill="currentColor" opacity=".45"/>'),
  floor: svg('<path d="M2.5 18.5l4.5-9h10l4.5 9z"/><path d="M9.3 9.5l-1.6 9M14.7 9.5l1.6 9M4.8 14h14.4"/>'),
  eyeClosed: svg('<path d="M2.5 10S6 16 12 16s9.5-6 9.5-6"/><path d="M5.6 13.6l-1.7 2.1M9.6 15.6l-.6 2.6M14.4 15.6l.6 2.6M18.4 13.6l1.7 2.1"/>'),
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13"/>', 'thick'),
  restart: svg('<path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3"/><path d="M4.4 4.2v4.4h4.4"/>'),
};
