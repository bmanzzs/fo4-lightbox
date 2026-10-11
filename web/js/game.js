// Game mode: the reference body and everything it wears walks through the loaded cell like the player does.
// Third-person camera behind the character, movement relative to the camera, walk / run / sprint clips with a short
// crossfade, jumps with the game's take-off / fall / landing clips, ground following and wall stops from small depth
// probes of the cell (no Havok: an approximation). Holding Space after a jump keeps lifting the character (flying).
export const SPEED = { walk: 90, run: 350.9, sprint: 500 };    // Fallout4.esm MOVT Player_1HM_MT, forward (units/s)
const CLIP = { walk: 'walk', run: 'run', sprint: 'sprint' };
const STEP = 45;            // highest ledge the character steps onto (and the largest drop it sticks to the ground over)
const GRAVITY = 700;        // units/s² (about 9.8 m/s² at 70 units per metre)
const RADIUS = 18;          // keep this far from walls
const JUMP_HEIGHT = 90;     // Fallout4.esm GMST fJumpHeightMin
const JUMP_V = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);     // take-off speed for that height (~355 units/s)
const FLY_UP = 340;         // holding Space: climb speed (not a game feature, a viewer one)
const FLY_AFTER = 0.22;     // seconds of the jump before a held Space starts lifting
// take-off, airborne loop and landing clip ids per kind of jump (female clips use the same id + '_f')
const JUMPS = { still: ['jump_start', 'jump_fall', 'jump_land'], walk: ['jumpwalk_start', 'jumpwalk_fall', 'jumpwalk_land'],
  run: ['jumprun_start', 'jumprun_fall', 'jumprun_land'] };
const PHASE = { jump: 0, fall: 1, land: 2 };

const angleTo = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

export class GameMode {
  // hooks: clipPath(id) -> .hkx path, sex() -> 'm' | 'f', skeleton() -> promise
  constructor(R, api, hooks) {
    this.R = R; this.api = api; this.hooks = hooks;
    this.on = false; this.clips = {}; this.state = ''; this.vz = 0; this.walk = false;
    this.air = false; this.airTime = 0; this.stateTime = 0; this.jumpKind = 'still'; this.moving = false;
    this.lastGround = null;
  }

  async clip(id) {
    if (!(id in this.clips)) {
      const path = this.hooks.clipPath(id);
      this.clips[id] = path ? this.R.decodeClip(await this.api(`anim?path=${encodeURIComponent(path)}&in_place=1`)) : null;
    }
    return this.clips[id];
  }
  // the female clip where the game has one
  clipFor(id) {
    return (this.hooks.sex() === 'f' && this.clips[id + '_f']) || this.clips[id] || null;
  }

  // stand the character on the first surface below (x, y, z + lift); returns the height used
  ground(x, y, zTop) {           // outside a cell the character stands at height 0, as it does before game mode
    return this.R.cellMode ? this.onFloor(this.R.groundAt(x, y, zTop), zTop) : 0;
  }
  // a cell drawn on the studio floor (the Simple scene): the floor is solid ground too
  onFloor(g, zTop) {
    const R = this.R, f = R.ground.z;
    if (!R.cellFloor || !R.settings.ground || f > zTop) return g;
    return g == null ? f : Math.max(g, f);
  }

  place(x, y, z, heading = this.R.playerHeading, lift = 60) {
    const g = this.ground(x, y, z + lift);
    const pz = g ?? z;
    this.R.setPlayer([x, y, pz], heading);
    this.air = false; this.vz = 0;
    if (g != null) this.lastGround = [x, y, pz];
    return pz;
  }

  async enter() {
    const R = this.R, c = R.camera;
    const sex = this.hooks.sex();
    await this.hooks.skeleton();                   // the clips drive the character skeleton's bones
    const ids = [sex === 'f' ? 'idle_f' : 'idle_m', 'walk', 'run', 'sprint', ...Object.values(JUMPS).flat()];
    if (sex === 'f') ids.push(...Object.values(JUMPS).flat().map(id => id + '_f'));
    await Promise.all(ids.map(id => this.clip(id).catch(() => null)));
    const t = [c.target[0] + c.pan[0], c.target[1] + c.pan[1], c.target[2] + c.pan[2]];
    const near = Math.hypot(t[0] - R.playerPos[0], t[1] - R.playerPos[1]) < 2000;   // keep a placement already in view
    const start = near ? R.playerPos : t;
    // face away from the camera, so the view starts behind the character
    const heading = Math.atan2(Math.cos(c.yaw), -Math.sin(c.yaw));
    this.place(start[0], start[1], start[2], heading);
    c.pan = [0, 0, 0]; c.dist = this.wantDist = this.setDist = 260; c.pitch = 0.2;
    c.target = [R.playerPos[0], R.playerPos[1], R.playerPos[2] + 105];
    R.playing = true; R.speed = 1;
    this.vz = 0; this.state = ''; this.on = true;
    this.setState('idle');
  }

  exit() { this.on = false; this.air = false; this.vz = 0; }

  // Space pressed: take off (standing, walking or running jump, as the game picks its clips)
  jump() {
    if (!this.on || this.air) return;
    this.air = true; this.vz = JUMP_V; this.airTime = 0;
    this.jumpKind = !this.moving ? 'still' : this.walk ? 'walk' : 'run';
    this.setState('jump');
  }

  setState(s) {
    if (s === this.state) return;
    let clip, fade = this.state ? 0.22 : 0;
    if (s in PHASE) {
      const ids = JUMPS[this.jumpKind];
      clip = this.clipFor(ids[PHASE[s]]) || this.clipFor(JUMPS.still[PHASE[s]]);
      fade = s === 'jump' ? 0.08 : s === 'land' ? 0.1 : 0.18;
    } else clip = this.clipFor(s === 'idle' ? (this.hooks.sex() === 'f' ? 'idle_f' : 'idle_m') : CLIP[s]);
    if (clip) this.R.useClip(clip, fade);
    this.state = s; this.stateTime = 0;
  }

  update(dt, keys) {
    if (!this.on || dt <= 0) return;
    const R = this.R, c = R.camera, cell = R.cellMode;
    const pos = [...R.playerPos];
    let heading = R.playerHeading;
    this.stateTime += dt;
    const fwd = [-Math.cos(c.yaw), -Math.sin(c.yaw)], right = [-Math.sin(c.yaw), Math.cos(c.yaw)];   // right = fwd × up
    let mx = 0, my = 0;
    if (keys.has('w')) { mx += fwd[0]; my += fwd[1]; }
    if (keys.has('s')) { mx -= fwd[0]; my -= fwd[1]; }
    if (keys.has('d')) { mx += right[0]; my += right[1]; }
    if (keys.has('a')) { mx -= right[0]; my -= right[1]; }
    const len = Math.hypot(mx, my);
    const mode = keys.has('shift') ? 'sprint' : this.walk ? 'walk' : 'run';
    this.moving = len > 0;
    let dir = null, step = 0;
    if (len > 0) {                                  // the same control in the air (the game is stricter)
      dir = [mx / len, my / len];
      heading += angleTo(heading, Math.atan2(-dir[0], dir[1])) * Math.min(1, dt * 10);   // turn toward the motion
      step = SPEED[mode] * dt;
    }
    // airborne: gravity, or a steady climb while Space stays held after the take-off
    let flying = false;
    if (this.air) {
      this.airTime += dt;
      flying = keys.has('space') && this.airTime > FLY_AFTER;
      if (flying) this.vz += (FLY_UP - this.vz) * Math.min(1, dt * 5);
      else this.vz -= GRAVITY * dt;
    }
    const z = this.air ? pos[2] + this.vz * dt : pos[2];
    // walls between the character and the camera pull the camera in (the wheel still sets the wanted distance)
    if (Math.abs(c.dist - this.setDist) > 0.5) this.wantDist = c.dist;
    const back = [Math.cos(c.pitch) * Math.cos(c.yaw), Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch)];
    // this update's depth probes, drawn and read back together: the wall ahead, the ground where the step lands
    // (if nothing stops it; a stopped step ends at least RADIUS short of the wall, outside the ground probe's box)
    // and the line from the character back to the camera. Outside a cell the floor is flat at height 0.
    let hit = null, g = 0, camHit = null;
    if (cell) {
      const px = dir ? pos[0] + dir[0] * step : pos[0], py = dir ? pos[1] + dir[1] * step : pos[1];
      const probes = [R.groundProbe(px, py, this.air ? z + 20 : pos[2] + STEP), R.rayProbe(c.target, back, this.wantDist)];
      if (dir) probes.push(R.aheadProbe(pos, dir, step + RADIUS + 10));
      [g, camHit, hit = null] = R.probe(probes);
      g = this.onFloor(g, this.air ? z + 20 : pos[2] + STEP);
    }
    if (dir) {
      const free = hit == null ? step : Math.max(0, hit - RADIUS);
      pos[0] += dir[0] * free; pos[1] += dir[1] * free;
    }

    if (this.air) {
      pos[2] = z;
      if (g != null && this.vz <= 0 && pos[2] <= g) {
        pos[2] = g; this.vz = 0; this.air = false;
        this.setState('land');
      } else {
        const start = this.clipFor(JUMPS[this.jumpKind][0]);
        this.setState(!flying && this.state === 'jump' && start && this.stateTime < start.duration ? 'jump' : 'fall');
        if (g == null && this.lastGround && pos[2] < this.lastGround[2] - 5000) {   // fell into the void: back to solid ground
          pos.splice(0, 3, ...this.lastGround); this.vz = 0; this.air = false; this.setState('idle');
        }
      }
    } else {
      // on the ground: follow steps and slopes up and down by up to STEP; a bigger drop is a fall
      if (g != null && g >= pos[2] - STEP) {
        pos[2] = g;
        this.lastGround = [...pos];
      } else {
        this.air = true; this.vz = 0; this.airTime = FLY_AFTER; this.jumpKind = this.moving ? (this.walk ? 'walk' : 'run') : 'still';
        this.setState('fall');
      }
      if (!this.air) {
        const land = this.clipFor(JUMPS[this.jumpKind][2]);
        const landing = this.state === 'land' && !this.moving && land && this.stateTime < land.duration;
        if (!landing) this.setState(this.moving ? mode : 'idle');
      }
    }
    R.setPlayer(pos, heading);
    // the camera follows the chest, smoothly
    const want = [pos[0], pos[1], pos[2] + 105], k = 1 - Math.exp(-dt * 14);
    c.target = c.target.map((v, i) => v + (want[i] - v) * k);
    c.pan = [0, 0, 0];
    c.dist = camHit == null ? this.wantDist : Math.max(25, camHit - 12);
    this.setDist = c.dist;
  }
}
