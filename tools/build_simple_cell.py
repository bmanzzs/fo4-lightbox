"""Build scenes/LightboxSimple.esp: the viewer's small test cell ("Simple" in the World panel).

A handful of Fallout4.esm objects around a studio-floor clearing: a scrap shack, a rusted sedan, dead shrubs and
dried grass, dead trees and hedges along the back, a street lamp, a mailbox, a picket fence and some litter. One interior cell flagged to
use the sky, sun and sun shadows (Show Sky, Use Sky Lighting, Sunlight Shadows), so the viewer lights it with the
chosen weather like an exterior, and a COC marker where the character stands. Small on purpose: it loads in about
a second. Stop the Lightbox server before building again (it keeps the plugin open).

The plugin only references Fallout4.esm records (by FormID); it adds no assets. The viewer reads it from
NifViewer/scenes; it is not installed in the game's Data folder.

    python tools/build_simple_cell.py            (needs the game, found like the server finds it)
"""
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# compiled caches of the viewer's modules go to %LOCALAPPDATA%, never next to the code (see server/app.py)
sys.pycache_prefix = sys.pycache_prefix or os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
                                                        'FO4 Lightbox', 'pycache')
sys.path.insert(0, os.path.join(ROOT, 'server'))
from fo4paths import find_game_dir                  # noqa: E402
from esm_weather import _Plugin, _subrecords, _cstr  # noqa: E402

OUT = os.path.join(ROOT, 'scenes', 'LightboxSimple.esp')
CELL_EDID, CELL_NAME = 'LightboxSimple', 'Lightbox Simple'
FORM_VERSION = 131                                  # as Fallout4.esm
COC_MARKER = 0x00000032                             # COCMarkerHeading
# CELL DATA flags: interior, Show Sky, Use Sky Lighting, Sunlight Shadows
CELL_FLAGS = 0x0001 | 0x0080 | 0x0100 | 0x0800

# The view: the camera looks at the character from azimuth CAM_AZ (degrees from +Y toward +X); at 08:30 Clear the
# sun stands at azimuth 103 and 38 degrees up, so it lights the character from the camera's right and the shadows
# fall back to the left. Objects are placed by (lateral, depth): metres to the right of / behind the character as
# the camera sees it (1 m = 70 units below).
CAM_AZ = 48.0
FACE_AZ = 38.0                                       # the character turns a little to the camera's left

# (base EDID, lateral, depth, yaw degrees (relative to the view), scale, z)
LAYOUT = [
    # the building and the car, either side behind the character
    ('workshop_ShackPrefabCompleteSm01', 5.4, 10.5, 200, 1.0, 0),
    ('Sedan01_Static', -4.3, 6.2, 125, 1.0, 0),
    # trees: a dead maple and clusters at the back, filling the horizon
    ('TreeMapleForest1', -3.0, 15.0, 30, 1.0, 0),
    ('TreeClusterDead04', -11.0, 13.0, 140, 1.0, 0),
    ('TreeCluster01', 11.5, 19.0, 70, 1.0, 0),
    ('TreeLeanScrub02', 2.0, 24.0, 200, 1.0, 0),
    ('TreeCluster04', -18.0, 26.0, 10, 1.0, 0),
    ('TreeMapleForest1', 17.0, 28.0, 250, 1.1, 0),
    ('HedgeRow02', -9.0, 18.0, 10, 1.0, 0),
    ('HedgeRow02', 14.0, 14.0, 80, 1.0, 0),
    ('HedgeRow02', -4.0, 30.0, 0, 1.2, 0),
    ('HedgeRow02', 10.0, 33.0, 15, 1.2, 0),
    ('TreeCluster04', 6.0, 36.0, 120, 1.0, 0),
    ('TreeMapleForest1', -12.0, 38.0, 60, 1.0, 0),
    ('TreeSapling04', -6.8, 9.5, 40, 1.0, 0),
    ('TreeSapling04', 8.5, 3.5, 160, 0.9, 0),
    # street furniture
    ('ResidentialStreetLamp01', -8.6, 3.6, 90, 1.0, 0),
    ('SanctuaryMailboxStand', 3.4, 4.0, 180, 1.0, 0),
    ('SanctuaryMailbox', 3.4, 4.0, 180, 1.0, 0),
    ('PicketFenceB_Long01', 4.4, 5.8, 0, 1.0, 0),
    ('PicketFenceB_Long01', 8.1, 6.1, 8, 1.0, 0),
    ('PicketFenceB_Post01', 2.1, 5.7, 0, 1.0, 0),
    # shrubs, litter, rocks
    ('DeadShrub06', 1.4, 6.6, 40, 1.1, 0),
    ('HollyShrub03', 9.9, 8.8, 120, 1.0, 0),
    ('Bramble02', -1.6, 10.2, 70, 1.2, 0),
    ('Bramble02', 11.1, 12.4, 200, 1.0, 0),
    ('DeadShrub06', -8.4, 8.6, 160, 0.9, 0),
    ('MetalBarrelStatic01', 8.6, 7.4, 25, 1.0, 0),
    ('MetalBarrelStatic01', 9.2, 8.1, 80, 1.0, 0),
    ('Tire02', -1.9, 4.6, 20, 1.0, 0),
    ('Tire02', -2.4, 5.1, 75, 1.0, 0),
    ('TrashEdge03', 3.2, 8.3, 10, 1.0, 0),
    ('TrashEdge03', 7.0, 8.7, 185, 1.0, 0),
    ('LeafPile02', -3.2, 8.4, 0, 1.0, 0),
    ('LeafPile02', -1.2, 15.6, 120, 1.3, 0),
    ('RockBoulder02', 12.9, 15.4, 40, 1.0, 0),
    ('RockBoulder02', -12.6, 11.0, 210, 0.8, 0),
    # ground cover (the grass-mound decals are made to blend into landscape textures; on the studio floor they
    # show as pale patches, so only grass clusters here)
    ('DriedGrassCluster01', -2.1, 1.6, 0, 1.0, 0),
    ('DriedGrassCluster04', 2.8, 1.2, 60, 1.0, 0),
    ('DriedGrassCluster01', -7.4, 3.6, 120, 1.1, 0),
    ('DriedGrassCluster04', 6.8, 4.3, 200, 1.0, 0),
    ('DriedGrassCluster01', -0.9, 7.0, 250, 1.0, 0),
    ('DriedGrassCluster04', 5.0, 13.8, 30, 1.2, 0),
    ('DriedGrassCluster01', -8.6, 11.0, 300, 1.2, 0),
    ('DriedGrassCluster04', 11.0, 2.6, 90, 1.0, 0),
    ('DriedGrassCluster01', -3.6, -2.2, 170, 0.9, 0),
    ('DriedGrassCluster04', 4.4, -2.6, 20, 0.9, 0),
    ('DriedGrassCluster01', 13.5, 9.0, 80, 1.1, 0),
    ('DriedGrassShapes02New', 0.6, 9.6, 0, 1.0, 0),
    ('DriedGrassShapes02New', -5.6, 12.6, 90, 1.0, 0),
]
UNITS = 70.0
NEEDED_TYPES = (b'STAT', b'MSTT', b'CONT', b'TREE', b'SCOL')


def base_ids(esm, edids):
    """EDID -> FormID for the wanted base objects in Fallout4.esm."""
    out = {}
    for label, gpos, gsize in esm.iter_top_groups():
        if label not in NEEDED_TYPES:
            continue
        for sig, fid, flags, body in esm.iter_records(gpos + 24, gpos + gsize, {label}):
            for k, v in _subrecords(body):
                if k == 'EDID':
                    e = _cstr(v)
                    if e in edids:
                        out[e] = fid
                    break
    return out


def sub(tag, data):
    return tag.encode() + struct.pack('<H', len(data)) + data


def zstr(s):
    return s.encode('cp1252') + b'\0'


def record(sig, fid, body, flags=0):
    return struct.pack('<4sIIIHHHH', sig.encode(), len(body), flags, fid, 0, 0, FORM_VERSION, 0) + body


def group(label, gtype, content):
    if isinstance(label, int):
        label = struct.pack('<I', label)
    return struct.pack('<4sI4siHHI', b'GRUP', 24 + len(content), label, gtype, 0, 0, 0) + content


def refr(fid, base, pos, rot, scale=1.0, flags=0):
    body = sub('NAME', struct.pack('<I', base))
    if abs(scale - 1.0) > 1e-6:
        body += sub('XSCL', struct.pack('<f', scale))
    body += sub('DATA', struct.pack('<6f', *pos, *rot))
    return record('REFR', fid, body, flags)


def main():
    game = find_game_dir(None)
    if not game:
        sys.exit('Fallout 4 not found')
    esm = _Plugin(os.path.join(game, 'Data', 'Fallout4.esm'))
    try:
        ids = base_ids(esm, {e for e, *_ in LAYOUT})
    finally:
        esm.close()                                 # never keep the game's master mapped
    missing = sorted({e for e, *_ in LAYOUT} - set(ids))
    if missing:
        sys.exit('not in Fallout4.esm: ' + ', '.join(missing))

    cam = math.radians(CAM_AZ)
    back = (-math.sin(cam), -math.cos(cam))        # from the camera through the character, on the ground
    right = (back[1], -back[0])                     # the camera's right
    next_id = 0x800
    cell_fid = 0x01000000 | next_id
    next_id += 1
    temp = b''
    for edid, lat, depth, yaw, scale, z in LAYOUT:
        x = (lat * right[0] + depth * back[0]) * UNITS
        y = (lat * right[1] + depth * back[1]) * UNITS
        # yaw is relative to the view: 0 = the object's +Y axis points at the camera
        rz = math.radians(CAM_AZ + 180 + yaw)
        temp += refr(0x01000000 | next_id, ids[edid], (x, y, z * UNITS), (0.0, 0.0, rz), scale)
        next_id += 1
    # where the character stands and which way it faces (rot z = facing azimuth; the viewer: heading = -rot z)
    coc = refr(0x01000000 | next_id, COC_MARKER, (0.0, 0.0, 0.0), (0.0, 0.0, math.radians(FACE_AZ)), flags=0x400)
    next_id += 1

    cell_body = (sub('EDID', zstr(CELL_EDID)) + sub('FULL', zstr(CELL_NAME)) +
                 sub('DATA', struct.pack('<H', CELL_FLAGS)))
    children = group(cell_fid, 8, coc) + group(cell_fid, 9, temp)
    obj = cell_fid & 0xFFFFFF
    block, subblock = obj % 10, (obj // 10) % 10
    cells = group(b'CELL', 0, group(block, 2, group(subblock, 3, record('CELL', cell_fid, cell_body) + group(cell_fid, 6, children))))
    n_records = 1 + len(LAYOUT) + 1 + 5          # cell, refs, COC marker, groups
    tes4 = (sub('HEDR', struct.pack('<fII', 1.0, n_records, next_id)) + sub('CNAM', zstr('Bman')) +
            sub('SNAM', zstr('FO4 Lightbox test scene: Fallout4.esm objects only, read by the viewer.')) +
            sub('MAST', zstr('Fallout4.esm')) + sub('DATA', struct.pack('<Q', 0)))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(record('TES4', 0, tes4) + cells)
    print(f'{OUT}: {len(LAYOUT)} objects + COC marker, {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
