// Mesh path -> a short display name plus a few readable tags, for the search list.
// "meshes\armor\raiderheavy02\heavytorso02.nif" -> name "heavytorso02", tags Armor · Raider · Heavy.

const CATEGORY = {
  armor: ['Armor', 'armor'], armour: ['Armor', 'armor'], clothes: ['Clothes', 'clothes'], weapons: ['Weapons', 'weapons'],
  actors: ['Actors', 'actors'], setdressing: ['Set dressing', 'props'], architecture: ['Architecture', 'architecture'],
  interiors: ['Interiors', 'architecture'], dungeons: ['Dungeons', 'architecture'], landscape: ['Landscape', 'landscape'],
  rocks: ['Rocks', 'landscape'], plants: ['Plants', 'plants'], trees: ['Trees', 'plants'], effects: ['Effects', 'effects'],
  fx: ['Effects', 'effects'], furniture: ['Furniture', 'furniture'], props: ['Props', 'props'], items: ['Items', 'props'],
  vehicles: ['Vehicles', 'vehicles'], workshop: ['Workshop', 'workshop'], sky: ['Sky', 'sky'], water: ['Water', 'landscape'],
  terminals: ['Terminals', 'terminals'], traps: ['Traps', 'props'], interface: ['Interface', 'other'], markers: ['Markers', 'other'],
  marker: ['Markers', 'other'], animobjects: ['Anim objects', 'props'], lod: ['LOD', 'landscape'], decals: ['Decals', 'effects'],
  characterassets: ['Character', 'character'], pipboy: ['Pip-Boy', 'terminals'], quest: ['Quest', 'props'],
  powerarmor: ['Power Armor', 'armor'], creatures: ['Creatures', 'actors'],
};
const DLC = { dlc01: 'Automatron', dlc02: 'Wasteland Workshop', dlc03: 'Far Harbor', dlc04: 'Nuka-World',
  dlc05: 'Contraptions', dlc06: 'Vault-Tec' };

// words that occur glued together in vanilla folder names
const WORDS = `raider raiders heavy light medium power armor armour combat leather metal synth synths vault tec suit suits
backpack backpacks pack packs bag bags clothes clothing outfit outfits helmet helmets hat hats mask masks torso chest arm arms
leg legs left right male female body head heads hand hands glove gloves boot boots shoe shoes dress coat coats jacket shirt
pants uniform uniforms marine trapper robe robes gunner gunners minutemen minuteman brotherhood steel institute railroad
children atom disciples operators pack nuka world harbor far mutant mutants super ghoul ghouls feral deathclaw mirelurk
radroach molerat dog dogmeat cat brahmin robot robots protectron assaultron sentry bot bots handy mister gutsy eyebot turret
turrets vertibird weapon weapons gun guns rifle rifles pistol pistols laser plasma gauss minigun missile launcher melee knife
sword bat hammer grenade grenades mine mines ammo mod mods scope sight barrel stock receiver magazine muzzle grip workshop
settlement furniture chair chairs table tables bed beds desk shelf shelves lamp lamps sign signs door doors wall walls floor
roof building buildings house houses shack barn fence fences car cars truck trucks bus train boat tree trees rock rocks plant
plants grass bush bushes cliff cliffs road roads bridge tower towers water fire smoke steam spark sparks glow effect effects
red rocket diamond city good neighbor sanctuary lexington concord boston corvega commonwealth cabin collar slave shock
wastelander wastelanders settler settlers farmer scavenger military army soldier police swat hazmat rad radiation chem chems
food drink bottle bottles can cans box boxes crate crates container containers safe footlocker cooler trunk case display rack
stand character characters assets face parts eyes hair beard brow brows teeth tongue mouth skeleton creature creatures camp
cart sack bedroll lantern trader caravan vendor merchant cage cages pole poles wire wires light lights neon tube tubes pipe
pipes machine machines generator console terminal terminals computer monitor radio tv television clock fan engine tank tanks
pod pods glass metal wood wooden stone concrete brick bricks paper cloth rubber plastic gold silver bronze iron ruined
destroyed broken old new small large big tall short long round square main base trim kit kits set clutter debris junk scrap
pile piles trash garbage interior exterior industrial office store shop diner bar market factory hospital church school
library museum police station subway sewer cave mine mines dock docks pier ship ships plane planes jet jets satellite
vault111 cryo pod lab labs science medical stim stimpak nuka cola quantum bottlecap cap caps marine wetsuit diving
faction factions banner banners flag flags poster posters bldg explorer explorers hunter hunters assassin silver shroud mechanist automatron gorilla goat yao guai radstag bloatfly
stingwing radscorpion mantis fog crawler angler gulper hermit crab cazador radrat bug bugs fish fishing frog
railway gamma shoulder mounted digging dig sitting leaning kneel kneeling sleep sleeping lying shotgun sniper hunting double
barrel fatman baseball pool cue ripper sledge sledgehammer board lead wrench machete knuckles boxing deliverer flamer
cryolator alien blaster broadsider harpoon radium lever action handmade revolver submachine assault gauss syringer couch
barstool stool counter workbench cooking station chemistry injured paired dynamic grip grips straight fired machinegun
missilelauncher queen king hunter behemoth hound vicious mole rat yao guai crow
editor dummy small town player clean lunchbox kids federalist floor ceil dmg brass plaque elevator button roller coaster
soda mixing auto fixtures modern domestic kiddie kingdom souvenirs dest statue bits circuit breaker duffle attach ref uss
constitution grave stones traffic condensor memory lounge work stations load screen art foodware vases pots bunker hill
loose boards audio equipment panels sports objects glowing sea alien data stream blood worm sidewalk hanging galactic
zone liberty prime switch latch generic emergency anim card reader basketball hoop lobster float kitchen bathroom
bedroom tech appliances electrical shelving rubble barrier barriers sandbag sandbags planks tiles stair stairs railing
catwalk scaffold pallet pallets barrel barrels vent vents duct ducts valve mailbox newspaper books magazines bones bodies`;
const VOCAB = new Set(WORDS.split(/\s+/).filter(Boolean));
const MAXW = Math.max(...[...VOCAB].map(w => w.length));
const DROP = new Set(['meshes', 'nif', 'characterassets', 'assets', 'mesh', 'meshs', 'parts']);
const title = (w) => w ? w[0].toUpperCase() + w.slice(1) : w;

// split one lowercase folder token into dictionary words (dynamic programming; unknown letters cost more)
export function words(token) {
  const pa = token.match(/^([tx])(\d{2})([a-z]*)$/);           // power armour models: t45, t51, t60, x01
  if (pa) return [`${pa[1].toUpperCase()}-${pa[2]}`];
  const out = [];
  for (const part of token.match(/[a-z]+|\d+/g) || []) {
    if (/^\d+$/.test(part)) { if (part.length >= 3 && out.length) out[out.length - 1] += ' ' + part; continue; }
    const n = part.length, cost = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(-1), known = new Array(n + 1);
    cost[0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = Math.max(0, i - MAXW); j < i; j++) {
        if (cost[j] + 1 < cost[i] && VOCAB.has(part.slice(j, i))) { cost[i] = cost[j] + 1; from[i] = j; known[i] = true; }
      }
      if (cost[i - 1] + 3 < cost[i]) { cost[i] = cost[i - 1] + 3; from[i] = i - 1; known[i] = false; }
    }
    const seg = [];
    for (let i = n; i > 0; i = from[i]) seg.unshift([part.slice(from[i], i), known[i]]);
    const unknown = seg.filter(s => !s[1]).length;
    if (unknown > n * 0.4) { out.push(title(part)); continue; }
    let run = '';
    for (const [w, k] of seg) {
      if (k) { if (run) { out.push(title(run)); run = ''; } out.push(title(w)); } else run += w;
    }
    if (run.length >= 3) out.push(title(run));
  }
  return out;
}

export function pathInfo(path) {
  const parts = path.replace(/\//g, '\\').split('\\').filter(Boolean);
  if (parts[0] === 'meshes') parts.shift();
  const file = parts.pop() || path;
  const dot = file.lastIndexOf('.');
  const info = { name: dot > 0 ? file.slice(0, dot) : file, ext: dot > 0 ? file.slice(dot) : '', tags: [], cat: 'other' };
  let dirs = parts;
  if (dirs.length && DLC[dirs[0]]) info.tags.push({ text: DLC[dirs[0]], kind: 'dlc' }), dirs = dirs.slice(1);
  else if (dirs.length && /^cc[a-z]{3}fo4\d+/.test(dirs[0])) info.tags.push({ text: 'Creation Club', kind: 'dlc' }), dirs = dirs.slice(1);
  if (dirs.length && CATEGORY[dirs[0]]) {
    const [text, cat] = CATEGORY[dirs[0]];
    info.cat = cat;
    if (dirs[0] === 'actors' && dirs[1] === 'character') { info.cat = 'character'; info.tags.push({ text: 'Character', kind: 'character' }); dirs = dirs.slice(2); }
    else if (dirs[0] === 'actors' && dirs[1] === 'powerarmor') { info.cat = 'armor'; info.tags.push({ text: 'Power Armor', kind: 'armor' }); dirs = dirs.slice(2); }
    else { info.tags.push({ text, kind: cat }); dirs = dirs.slice(1); }
  } else if (dirs.length) { info.tags.push({ text: words(dirs[0]).join(' ') || title(dirs[0]), kind: 'other' }); dirs = dirs.slice(1); }
  if (/backpack/.test(path)) info.cat = 'backpack';
  const seen = new Set(info.tags.map(t => t.text.toLowerCase()));
  // the item family (first folder) and the most specific folder (last one)
  for (const d of dirs.length > 2 ? [dirs[0], dirs[dirs.length - 1]] : dirs) {
    if (DROP.has(d)) continue;
    for (const w of words(d)) {
      const k = w.toLowerCase();
      if (seen.has(k) || DROP.has(k) || k.length < 2) continue;
      seen.add(k); info.tags.push({ text: w, kind: 'sub' });
    }
  }
  info.tags = info.tags.slice(0, 4);
  return info;
}
