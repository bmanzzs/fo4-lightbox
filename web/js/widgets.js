// Small custom controls: icon sliders (one stop per choice with an icon under each tick: weather, body pose) and the
// hour ticks.
import { WEATHER_ICONS } from './icons.js';

export function weatherIcon(edid = '') {
  const e = edid.toLowerCase();
  if (!e) return 'studio';
  if (e.includes('radstorm')) return 'radstorm';
  if (e.includes('gs') && e.includes('overcast')) return 'glowingsea';
  if (e.includes('clearest')) return 'clearest';
  if (e.includes('clear')) return 'clear';
  if (e.includes('rain') || e.includes('storm')) return 'rain';
  if (e.includes('fog')) return 'foggy';
  if (e.includes('mist')) return 'misty';
  return 'overcast';
}

export class IconSlider {
  // opts: icons (name -> svg), label (for screen readers)
  constructor(root, onChange, opts = {}) {
    this.root = root; this.onChange = onChange; this.items = []; this.index = 0;
    this.icons = opts.icons || WEATHER_ICONS;
    root.classList.add('wslider');
    root.tabIndex = 0;
    root.setAttribute('role', 'slider');
    root.setAttribute('aria-label', opts.label || 'Weather');
    root.innerHTML = '<div class="wtrack"></div><div class="wstops"></div><div class="wthumb"></div>';
    this.stops = root.querySelector('.wstops');
    const pick = (ev) => {
      const r = this.root.getBoundingClientRect(), pad = 14, n = this.items.length;
      if (n < 2) return;
      const f = (ev.clientX - r.left - pad) / Math.max(1, r.width - 2 * pad);
      this.set(Math.round(Math.min(1, Math.max(0, f)) * (n - 1)), true);
    };
    root.addEventListener('pointerdown', (ev) => {
      root.setPointerCapture(ev.pointerId); pick(ev);
      root.onpointermove = pick;
      root.onpointerup = () => { root.onpointermove = null; };
    });
    root.addEventListener('keydown', (ev) => {
      const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[ev.key];
      if (d) { ev.preventDefault(); this.set(Math.min(this.items.length - 1, Math.max(0, this.index + d)), true); }
      if (ev.key === 'Home') this.set(0, true);
      if (ev.key === 'End') this.set(this.items.length - 1, true);
    });
  }
  // items: [{ label, icon, title }]
  setItems(items, index = 0) {
    this.items = items;
    this.root.style.setProperty('--n', Math.max(1, items.length - 1));
    this.stops.innerHTML = items.map((it, i) => `<span class="wstop" data-i="${i}" title="${it.title || it.label}" style="--i:${i}">` +
      `<i class="wtick"></i>${this.icons[it.icon] || Object.values(this.icons)[0]}</span>`).join('');
    this.set(index, false);
  }
  // i = -1: no stop chosen (something off the scale is shown, e.g. a clip from the search)
  set(i, emit) {
    if (!this.items.length) return;
    const changed = i !== this.index;
    this.index = i;
    this.root.classList.toggle('none', i < 0);
    this.root.style.setProperty('--i', Math.max(0, i));
    this.root.setAttribute('aria-valuenow', i);
    this.root.setAttribute('aria-valuetext', i >= 0 ? this.items[i].label : '');
    this.stops.querySelectorAll('.wstop').forEach((s, k) => s.classList.toggle('on', k === i));
    if (emit && changed) this.onChange(i, this.items[i]);
  }
}

export const WeatherSlider = IconSlider;

// tick marks under the game-hour slider: every hour, labelled every six (12:00 sits in the middle)
export function hourTicks(el) {
  let h = '';
  for (let i = 0; i <= 24; i++) {
    const major = i % 6 === 0;
    h += `<span class="ht${major ? ' maj' : ''}" style="--p:${i / 24}">${major ? `<b>${String(i).padStart(2, '0')}:00</b>` : ''}</span>`;
  }
  el.innerHTML = h;
}
