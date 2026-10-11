"""HKX animation clips for the viewer: decompressed per-frame bone transforms, named by the character skeleton.

The clip and the skeleton are read from the user's install at run time (vendor/anim_fo4.py does the Havok
decoding). Checked on this install: the HKX skeleton's reference pose composed with the standard quaternion
convention reproduces skeleton.nif's rest world transforms to 0.005 game units on all 77 shared bones.
"""
import base64

import numpy as np

from vendor import anim_fo4

SKELETON_HKX = 'meshes\\actors\\character\\characterassets\\skeleton.hkx'
SKELETON_NIF = 'meshes\\actors\\character\\characterassets\\skeleton.nif'
ANIM = 'meshes\\actors\\character\\animations\\'

# A few vanilla clips that are useful for judging a worn item (the UI also accepts any .hkx path)
CLIPS = [
    dict(id='idle_m', label='Relaxed idle (male)', path=ANIM + 'mt\\neutral\\posea_idle1.hkx'),
    dict(id='idle_f', label='Relaxed idle (female)', path=ANIM + 'mt\\neutral\\female\\posea_idle1.hkx'),
    dict(id='walk', label='Walk forward', path=ANIM + 'mt\\neutral\\walkforward.hkx', in_place=True),
    dict(id='jog', label='Jog forward', path=ANIM + 'mt\\neutral\\jogforward.hkx', in_place=True),
    dict(id='run', label='Run forward', path=ANIM + 'mt\\neutral\\runforward.hkx', in_place=True),
    dict(id='sprint', label='Sprint forward', path=ANIM + 'mt\\neutral\\sprintforward.hkx', in_place=True),
    # game-mode jumps: take-off, airborne loop and landing, standing / walking / running (female where the game has one)
    dict(id='jump_start', label='Jump (standing)', path=ANIM + 'mt\\neutral\\jumpinplace.hkx', in_place=True),
    dict(id='jump_fall', label='Jump fall (standing)', path=ANIM + 'mt\\neutral\\jumpinplacefall.hkx', in_place=True),
    dict(id='jump_land', label='Jump land (standing)', path=ANIM + 'mt\\neutral\\jumpinplaceland.hkx', in_place=True),
    dict(id='jumpwalk_start', label='Jump (walking)', path=ANIM + 'mt\\neutral\\jumpwalk.hkx', in_place=True),
    dict(id='jumpwalk_fall', label='Jump fall (walking)', path=ANIM + 'mt\\neutral\\jumpwalkfall.hkx', in_place=True),
    dict(id='jumpwalk_land', label='Jump land (walking)', path=ANIM + 'mt\\neutral\\jumpwalkland.hkx', in_place=True),
    dict(id='jumprun_start', label='Jump (running)', path=ANIM + 'mt\\neutral\\jumprun.hkx', in_place=True),
    dict(id='jumprun_fall', label='Jump fall (running)', path=ANIM + 'mt\\neutral\\jumprunfall.hkx', in_place=True),
    dict(id='jumprun_land', label='Jump land (running)', path=ANIM + 'mt\\neutral\\jumprunland.hkx', in_place=True),
    dict(id='jump_start_f', label='Jump (standing, female)', path=ANIM + 'mt\\neutral\\female\\jumpinplace.hkx', in_place=True),
    dict(id='jump_fall_f', label='Jump fall (standing, female)', path=ANIM + 'mt\\neutral\\female\\jumpinplacefall.hkx', in_place=True),
    dict(id='jump_land_f', label='Jump land (standing, female)', path=ANIM + 'mt\\neutral\\female\\jumpinplaceland.hkx', in_place=True),
    dict(id='jumprun_start_f', label='Jump (running, female)', path=ANIM + 'mt\\neutral\\female\\jumprun.hkx', in_place=True),
    dict(id='jumprun_fall_f', label='Jump fall (running, female)', path=ANIM + 'mt\\neutral\\female\\jumprunfall.hkx', in_place=True),
    dict(id='jumprun_land_f', label='Jump land (running, female)', path=ANIM + 'mt\\neutral\\female\\jumprunland.hkx', in_place=True),
]

_skeleton_cache = {}


def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype='<f4').tobytes()).decode('ascii')


def skeleton(vfs, path=SKELETON_HKX):
    if path not in _skeleton_cache:
        _skeleton_cache[path] = anim_fo4._parse_skeleton_hkx(vfs.read(path))
    return _skeleton_cache[path]


def load_clip(vfs, path, in_place=False, skeleton_path=SKELETON_HKX):
    sk = skeleton(vfs, skeleton_path)
    an = anim_fo4._parse_animation_hkx(vfs.read(path))
    if an is None:
        raise ValueError('not a Fallout 4 animation clip')
    tracks, root_speed = [], 0.0
    for ti, tr in enumerate(an.tracks):
        bi = an.track_to_bone_indices[ti] if ti < len(an.track_to_bone_indices) else ti
        name = sk.bones[bi] if 0 <= bi < len(sk.bones) else (an.bone_names[ti] if ti < len(an.bone_names) else '')
        t = np.array(tr.translations, dtype=np.float32).reshape(-1, 3)
        r = np.array(tr.rotations, dtype=np.float32).reshape(-1, 4)          # x y z w
        s = np.array(tr.scales, dtype=np.float32).reshape(-1, 3)[:, 0]
        if name.lower() == 'root' and len(t) > 1 and an.duration > 0:       # the clip's own travel speed (units/s)
            root_speed = float(np.hypot(*(t[-1, :2] - t[0, :2]))) / an.duration
        if in_place and name.lower() == 'root':                             # drop root motion (stay on the spot)
            t[:, :2] = t[0, :2]
        tracks.append(dict(name=name, t=_b64(t), r=_b64(r), s=_b64(s)))
    return dict(path=path, duration=an.duration, frames=an.num_frames, frame_duration=an.frame_duration,
                additive=an.blend_hint == 1, tracks=tracks, root_speed=round(root_speed, 2), in_place=bool(in_place),
                annotations=[dict(time=a.time, text=a.text) for a in an.annotations][:200])
