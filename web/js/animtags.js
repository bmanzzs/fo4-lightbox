// Animation clip path -> a short name, a few readable tags and whether it drives the human body.
// "meshes\actors\character\animations\mt\depressed\female\posea_talk_s4.hkx" -> Human · Movement · Depressed · Female.
import { words } from './pathtags.js';

const DLC = { dlc01: 'Automatron', dlc02: 'Wasteland Workshop', dlc03: 'Far Harbor', dlc04: 'Nuka-World',
  dlc05: 'Contraptions', dlc06: 'Vault-Tec' };
// the folder right under "animations": what kind of clip it is ([tag, icon category])
const GROUP = {
  mt: ['Movement', 'move'], weapon: ['Weapon', 'weapon'], weapons: ['Weapon', 'weapon'], grips: ['Weapon', 'weapon'],
  furniture: ['Furniture', 'furniture'], '1hm': ['One-hand melee', 'melee'], '2hm': ['Two-hand melee', 'melee'],
  '2hmwide': ['Two-hand melee', 'melee'], h2h: ['Unarmed', 'unarmed'], paired: ['Paired', 'paired'],
  quest: ['Quest', 'idle'], player: ['Player', 'idle'], synth: ['Synth', 'idle'], dynamicanims: ['Dynamic idle', 'idle'],
  idles: ['Idle', 'idle'], injured: ['Injured', 'move'],
};
const SKIP = new Set(['animations', 'animation', 'default', 'meshes', 'actors', 'character', 'male', 'neutral']);
const title = (w) => w ? w[0].toUpperCase() + w.slice(1) : w;

export function animInfo(path) {
  const parts = path.replace(/\//g, '\\').toLowerCase().split('\\').filter(Boolean);
  if (parts[0] === 'meshes') parts.shift();
  const file = parts.pop() || path;
  const info = { name: file.replace(/\.hkx$/, ''), ext: '.hkx', tags: [], cat: 'other', fits: false, skeleton: '' };
  let d = parts;
  const dlc = d[0] === 'actors' && DLC[d[1]] ? DLC[d[1]] : null;
  if (d[0] === 'actors') {
    d = d.slice(dlc ? 2 : 1);
    const who = d.shift() || '';
    const first = d[0] === '_1stperson' || d[0] === '1stperson';
    if (first) d = d.slice(1);
    if (who === 'character') {
      info.skeleton = first ? 'first-person arms' : 'human';
      info.fits = !first;
      info.tags.push({ text: first ? '1st person' : 'Human', kind: first ? 'warn' : 'lead' });
      if (first) info.cat = 'firstperson';
    } else {
      info.skeleton = who === 'powerarmor' ? 'Power Armor' : words(who).join(' ').toLowerCase() || who;
      info.tags.push({ text: who === 'powerarmor' ? 'Power Armor' : words(who).join(' ') || title(who), kind: 'warn' });
      info.cat = who === 'powerarmor' ? 'powerarmor' : 'creature';
      if (first) info.tags.push({ text: '1st person', kind: 'sub' });
    }
  } else if (d[0] === 'critters') {
    info.skeleton = words(d[1] || '').join(' ').toLowerCase() || 'critter';
    info.tags.push({ text: words(d[1] || '').join(' ') || 'Critter', kind: 'warn' });
    info.cat = 'creature';
    d = d.slice(2);
  } else {
    info.skeleton = 'object';
    info.tags.push({ text: words(d[0] || '').join(' ') || 'Object', kind: 'warn' });
    info.cat = 'object';
    d = d.slice(1);
  }
  if (dlc) info.tags.push({ text: dlc, kind: 'dlc' });
  const ai = d.indexOf('animations');
  if (ai >= 0) d = d.slice(ai + 1);
  const idleName = /idle|talk|pose|lean|sit|stand/.test(info.name);
  if (d.length && GROUP[d[0]]) {
    const [text, cat] = GROUP[d[0]];
    info.tags.push({ text, kind: 'sub' });
    if (info.fits) info.cat = cat === 'move' && idleName ? 'idle' : cat;
    d = d.slice(1);
  } else if (info.fits) {
    info.cat = /^(sneak)?wpn/.test(info.name) ? 'weapon' : idleName ? 'idle'
      : /walk|run|jog|sprint|turn|jump|forward|backward/.test(info.name) ? 'move' : 'other';
  }
  const seen = new Set(info.tags.map(t => t.text.toLowerCase()));
  const add = (w) => { const k = w.toLowerCase(); if (!seen.has(k) && k.length > 1) { seen.add(k); info.tags.push({ text: w, kind: 'sub' }); } };
  for (const f of d) {
    if (SKIP.has(f)) continue;
    if (f === 'female') { add('Female'); continue; }
    for (const w of words(f)) add(w);
  }
  if (/^sneak/.test(info.name)) add('Sneak');
  info.tags = info.tags.slice(0, 4);
  return info;
}
