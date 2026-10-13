"""Check the collision reading (server/collision.py) against the vanilla meshes of a Fallout 4 install.

    python tools/collision_check.py [--game "C:\\...\\Fallout 4"] [--sample N] [--show K]

For every NIF with collision (precombined and LOD meshes left out; --sample N: a random N of them):
  * each physics system decodes, and no shape class is left unread;
  * the collision sits on the render geometry: the box of all collision points against the box of the (unskinned)
    render shapes, as the gap of each side relative to the render box's size. Collision is a simplified hull of what
    is drawn, so small gaps are normal; a misplaced body (wrong space, wrong unit, wrong axis) shows as a large one.
Reads only; prints a summary and the worst files.
"""
import argparse
import base64
import collections
import os
import random
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.pycache_prefix = sys.pycache_prefix or os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
                                                        'FO4 Lightbox', 'pycache')
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))
from fo4paths import find_game_dir      # noqa: E402
from fo4nif import Nif                  # noqa: E402
from vfs import VFS                     # noqa: E402
import collision                        # noqa: E402


def pts(b64):
    return np.frombuffer(base64.b64decode(b64), '<f4').reshape(-1, 3)


def render_box(n):
    par, lo, hi = n.parents(), None, None
    for i, b in enumerate(n.blocks):
        g = (b or {}).get('geometry')
        if not g or b.get('skin', -1) >= 0:
            continue
        p = g['position'] @ n.world(i, par)[:3, :3].T + n.world(i, par)[:3, 3]
        lo = p.min(0) if lo is None else np.minimum(lo, p.min(0))
        hi = p.max(0) if hi is None else np.maximum(hi, p.max(0))
    return lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--show', type=int, default=15)
    a = ap.parse_args()
    v = VFS(find_game_dir(a.game))
    keys = sorted(k for k in v.index if k.endswith('.nif') and not k.startswith(('meshes\\precombined', 'meshes\\lod')))
    if a.sample:
        random.seed(7)
        keys = random.sample(keys, min(a.sample, len(keys)))
    t0 = time.time()
    stats = collections.Counter()
    skipped, motions, layers = collections.Counter(), collections.Counter(), collections.Counter()
    gaps, errors = [], []
    for k in keys:
        try:
            n = Nif(v.read(k))
        except Exception:
            stats['unreadable nif'] += 1
            continue
        if 'bhkPhysicsSystem' not in n.block_types:
            continue
        stats['with collision'] += 1
        try:
            c = collision.nif_collision(n)
        except Exception as e:
            errors.append((k, repr(e)))
            continue
        for e in c['errors']:
            errors.append((k, e))
        if not c['bodies']:
            stats['no bodies decoded'] += 1
            continue
        stats['decoded'] += 1
        P = []
        for b in c['bodies']:
            motions[b['motion']] += 1
            layers[b['layer']] += 1
            for s in b['skipped']:
                skipped[s] += 1
            stats['hulls'] += len(b['hulls'])
            stats['meshes'] += len(b['meshes'])
            stats['triangles'] += sum(m['m'] for m in b['meshes'])
            P += [pts(h['v']) for h in b['hulls']] + [pts(m['v']) for m in b['meshes']]
        P = np.concatenate(P)
        lo, hi = render_box(n)
        if lo is None:
            stats['no unskinned render geometry'] += 1
            continue
        size = np.maximum(hi - lo, 10.0)
        gap = float(max(((lo - P.min(0)) / size).max(), ((P.max(0) - hi) / size).max(), 0.0))
        gaps.append((gap, k, len(c['bodies'])))
    gaps.sort(reverse=True)
    g = np.array([x[0] for x in gaps]) if gaps else np.zeros(1)
    print(f'{len(keys)} NIFs read in {time.time() - t0:.0f} s')
    for k_, n_ in stats.most_common():
        print(f'  {k_}: {n_}')
    print('  motions:', dict(motions), ' layers:', dict(sorted(layers.items())))
    print('  shapes not read:', dict(skipped) or 'none')
    print('  decode errors:', len(errors), errors[:5])
    print('  collision outside the render box (fraction of its size): median %.3f, 95%% %.3f, 99%% %.3f, over 0.25: %d of %d'
          % (np.median(g), np.percentile(g, 95), np.percentile(g, 99), int((g > 0.25).sum()), len(g)))
    for gap, k_, nb in gaps[:a.show]:
        print(f'    {gap:7.3f}  {k_}  ({nb} bodies)')


if __name__ == '__main__':
    main()
