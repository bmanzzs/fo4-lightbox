"""Check the cloth decoding (server/cloth.py) against every Havok cloth in a Fallout 4 install.

    python tools/cloth_check.py [--game "C:\\...\\Fallout 4"] [--all]

For each NIF with BSClothExtraData under meshes\\clothes and meshes\\armor (--all: every mesh, slow):
  * the cloth decodes (operators, constraint sets, capsules);
  * skinning the simulation mesh in the rest pose puts every particle on its rest position (a constant offset of up to
    ~0.9 units between the skin and the stored pose exists in a few vanilla files and is reported, not failed);
  * every cloth bone rebuilt from its rest triangle equals its rest matrix;
  * stored link stiffness x (1/massA + 1/massB) is the author's stiffness, at most 1 (Havok pre-divides it;
    web/js/cloth.js undoes that): 1.00 in nearly all vanilla cloth, 0.95 in a few small pouches.
Reads only; prints a summary.
"""
import argparse
import collections
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# compiled caches of the viewer's modules go to %LOCALAPPDATA%, never next to the code (see server/app.py)
sys.pycache_prefix = sys.pycache_prefix or os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
                                                        'FO4 Lightbox', 'pycache')
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))
from fo4paths import find_game_dir      # noqa: E402
from fo4nif import Nif                  # noqa: E402
from vfs import VFS                     # noqa: E402
import cloth                            # noqa: E402


def mat(cm):
    return np.array(cm, float).reshape(4, 4).T


def check(c):
    """-> (skin offset spread, skin offset size, worst bone error, link stiffness x mobility range)"""
    rest = [mat(m) for m in c['rest']]
    sk = c['skin']
    ents = [rest[e['bone']] @ mat(e['bfs']) for e in sk['entries']]
    S = sk['count']
    P = np.zeros((S, 3))
    for v in range(S):
        M = sum(sk['w'][4 * v + k] * ents[sk['e'][4 * v + k]] for k in range(sk['n'][v]))
        P[v] = (M @ np.append(sk['pos'][3 * v:3 * v + 3], 1.0))[:3]
    pose = np.array(c['particles']['pose'], float).reshape(-1, 3)
    anim = np.array(c['particles']['anim'])
    ok = anim >= 0
    d = P[anim[ok]] - pose[ok] if ok.any() else np.zeros((1, 3))
    spread = float(np.abs(d - d.mean(0)).max())
    worst = 0.0
    for b in c['cloth_bones']:
        A, B, C = pose[b['tri'][0]], pose[b['tri'][1]], pose[b['tri'][2]]
        G = (A + B + C) / 3
        T = np.eye(4)
        T[:3, 0], T[:3, 1], T[:3, 2], T[:3, 3] = A - G, B - G, np.cross(A - G, B - G), G
        worst = max(worst, float(np.abs(T @ mat(b['local']) - rest[b['bone']]).max()))
    inv = np.array(c['particles']['inv'])
    ks = []
    for s in c['sets']:
        if s['type'] == 'link':
            w = inv[s['a']] + inv[s['b']]
            ks += list((np.array(s['k']) * w)[w > 0])
    return spread, float(np.linalg.norm(d.mean(0))), worst, (min(ks), max(ks)) if ks else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--game')
    ap.add_argument('--all', action='store_true', help='every mesh, not only clothes and armour (slow)')
    a = ap.parse_args()
    game = find_game_dir(a.game)
    if not game:
        sys.exit('Fallout 4 not found; pass --game')
    v = VFS(game)
    keys = sorted(set(k for k in v.index if k.endswith('.nif')) | set(v.loose_files('meshes', ('.nif',))))
    if not a.all:
        keys = [k for k in keys if ('\\clothes\\' in k or '\\armor\\' in k) and not k.startswith('meshes\\precombined')]
    stats, problems, unsup = collections.Counter(), [], collections.Counter()
    for k in keys:
        try:
            raw = v.read(k)
        except Exception:
            continue
        if b'BSClothExtraData' not in raw:
            continue
        log = []
        for c in cloth.scene_cloth(Nif(raw), log):
            stats['cloths'] += 1
            for u in c['unsupported']:
                unsup[u] += 1
            spread, off, worst, kr = check(c)
            if spread > 0.05:
                problems.append((k, 'skinned rest differs from the pose by %.3f' % spread))
            elif off > 0.01:
                stats['constant skin offset (%.2f..)' % round(off, 1)] += 1
            if worst > 0.01:
                problems.append((k, 'cloth bone rest error %.3f' % worst))
            if kr and kr[1] > 1.01:                          # above 1: not pre-divided after all
                problems.append((k, 'link stiffness x mobility %.3f..%.3f' % kr))
            elif kr:
                stats['link stiffness (undivided) %.2f..%.2f' % kr] += 1
        for l in log:
            if re.match(r'cloth \d+: failed: ', l):          # a cloth the viewer had to drop (cloth.scene_cloth)
                problems.append((k, l))
    print('%d cloth blocks checked in %s' % (stats.pop('cloths', 0), game))
    for s, n in sorted(stats.items()):
        print('  %4d  %s' % (n, s))
    print('not solved yet:', dict(unsup) or 'none')
    print('problems: %d' % len(problems))
    for p in problems[:40]:
        print('  ', *p)


if __name__ == '__main__':
    main()
