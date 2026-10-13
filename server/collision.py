"""The collision of a Fallout 4 NIF, read-only: the Havok physics systems behind its bhkNPCollisionObjects, as plain
shapes in the NIF's own space and game units, for the page's physics (game mode, items dropped with physics, the
collision view).

Each bhkNPCollisionObject (on a node) points at a bhkPhysicsSystem (an hk_2014.1.0 x64 packfile) and a body in it.
A body (hknpBodyCinfo) has a shape (in the space of the node holding the collision object, in Havok units: 1 =
69.99125 game units), a material and, when it moves, a motion. Shapes:
  hknpConvexPolytopeShape / hknpConvexShape / hknpCapsuleShape / hknpSphereShape: points + a convex radius (a hull
      rounded by the radius; a capsule is two points, a sphere one)
  hknpScaledConvexShape: a convex child, scaled and moved
  hknpCompressedMeshShape -> hknpCompressedMeshShapeData: a triangle mesh in quantised sections
  hknpStaticCompoundShape / hknpDynamicCompoundShape: instances (rotation, translation, scale) of other shapes
Offsets follow PyNifly's bhk_autounpack.py (Bad Dog), which documents the body, material, motion, convex polytope
and compressed mesh layouts; the compound instance scale (+0x40) and the scaled convex shape (child +0x30, scale
+0x40, translation +0x50) were read off vanilla SCOL meshes here. tools/collision_check.py checks the result against
the render geometry of every vanilla mesh with collision.
"""
import base64
import struct

import numpy as np

import havok

HK = 69.99125                       # game units per Havok unit
MOTION_STATIC = 0x7FFFFFFF
CONVEX = ('hknpConvexPolytopeShape', 'hknpConvexShape', 'hknpCapsuleShape', 'hknpSphereShape')
COMPOUND = ('hknpStaticCompoundShape', 'hknpDynamicCompoundShape')


def _b64(a, dtype):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode('ascii')


def _half(bits):                    # hkHalf16: the top 16 bits of a float32
    return struct.unpack('<f', struct.pack('<I', bits << 16))[0]


class _System:
    """One packfile: its objects by offset and the readers the shapes need."""

    def __init__(self, data):
        self.p = havok.Packfile(data)
        self.data, self.ds = data, self.p.ds
        self.cls = self.p.virt                                  # rel -> class name

    def u16(self, rel):
        return struct.unpack_from('<H', self.data, self.ds + rel)[0]

    def u32(self, rel):
        return struct.unpack_from('<I', self.data, self.ds + rel)[0]

    def f(self, rel, n):
        return np.frombuffer(self.data, '<f4', n, self.ds + rel).astype(np.float64)

    def ptr(self, rel):
        g = self.p.glob.get(rel)
        return g[1] if g else None

    def array(self, rel, off):
        """(rel of the first element, count) of an hkArray member."""
        n = self.u32(rel + off + 8) & 0x3FFFFFFF
        t = self.p.local.get(rel + off)
        return (t, n) if (t is not None and n) else (None, 0)


def _quat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def _apply(M, v):
    return v @ M[:3, :3].T + M[:3, 3]


def _compressed_mesh(s, rel):
    """hknpCompressedMeshShapeData -> (vertices (n, 3) in Havok units, triangles (m, 3))."""
    sec_t, nsec = s.array(rel, 0x50)
    quad_t, nquad = s.array(rel, 0x60)
    shi_t, nshi = s.array(rel, 0x70)
    ver_t, nver = s.array(rel, 0x80)
    sha_t, nsha = s.array(rel, 0x90)
    if not nsec or not nquad or not (nver or nsha):
        return None
    data, ds = s.data, s.ds
    packed = np.frombuffer(data, '<u4', nver, ds + ver_t) if nver else np.zeros(0, np.uint32)
    q = np.stack([packed & 0x7FF, (packed >> 11) & 0x7FF, (packed >> 22) & 0x3FF], 1).astype(np.float64)
    shared = np.zeros((0, 3))
    if nsha:                                               # 21-21-22 bits across the whole shape's box
        big = np.frombuffer(data, '<u8', nsha, ds + sha_t)
        lo, hi = s.f(rel + 0x20, 3), s.f(rel + 0x30, 3)
        qq = np.stack([big & 0x1FFFFF, (big >> np.uint64(21)) & 0x1FFFFF, (big >> np.uint64(42)) & 0x3FFFFF], 1)
        shared = lo + qq.astype(np.float64) * (hi - lo) / np.array([(1 << 21) - 1, (1 << 21) - 1, (1 << 22) - 1])
    shidx = np.frombuffer(data, '<u2', nshi, ds + shi_t).astype(np.int64) if nshi else np.zeros(0, np.int64)
    quads = np.frombuffer(data, np.uint8, 4 * nquad, ds + quad_t).reshape(nquad, 4).astype(np.int64)
    secs = []
    for i in range(nsec):
        a = sec_t + i * 0x60
        secs.append((s.f(a + 0x30, 3), s.f(a + 0x3C, 3), s.u32(a + 0x48), s.u32(a + 0x4C) >> 8,
                     s.u32(a + 0x50) & 0xFF, s.u32(a + 0x50) >> 8))
    V, T, base = [], [], 0
    for i, (b, sc, fv, fs, nq, fq) in enumerate(secs):
        nv = (secs[i + 1][2] if i + 1 < nsec else nver) - fv
        ns = (secs[i + 1][3] if i + 1 < nsec else nshi) - fs
        if nq == 0 or nv < 0 or ns < 0:
            continue
        loc = b + q[fv:fv + nv] * sc
        sh = np.zeros((0, 3))
        if ns and len(shared):
            sh = shared[np.clip(shidx[fs:fs + ns], 0, len(shared) - 1)]
        pts = np.concatenate([loc, sh]) if len(sh) else loc
        qd = quads[fq:fq + nq]
        ok = (qd < len(pts)).all(1)
        qd = qd[ok]
        tri = np.concatenate([qd[:, [0, 1, 2]], qd[qd[:, 2] != qd[:, 3]][:, [0, 2, 3]]])
        tri = tri[(tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])]
        V.append(pts)
        T.append(tri + base)
        base += len(pts)
    if not V:
        return None
    return np.concatenate(V), np.concatenate(T)


def _shape(s, rel, M, out, depth=0):
    """Every primitive of a shape, placed by M (Havok shape units -> NIF space, game units): appended to out."""
    if rel is None or depth > 8:
        return
    c = s.cls.get(rel, '?')
    if c in CONVEX:
        n, off = struct.unpack_from('<HH', s.data, s.ds + rel + 0x30)
        if n == 0 or n > 4096:
            out['skipped'].append(c)
            return
        v = s.f(rel + 0x30 + off, 4 * n).reshape(n, 4)[:, :3]
        r = float(s.f(rel + 0x14, 1)[0]) * abs(np.linalg.det(M[:3, :3])) ** (1 / 3)
        out['hulls'].append((_apply(M, v), r))
    elif c == 'hknpScaledConvexShape':
        sc, tr = s.f(rel + 0x40, 3), s.f(rel + 0x50, 3)
        L = np.eye(4)
        L[:3, :3] = np.diag(sc)
        L[:3, 3] = tr
        _shape(s, s.ptr(rel + 0x30), M @ L, out, depth + 1)
    elif c == 'hknpCompressedMeshShape':
        d = s.ptr(rel + 0x60)
        m = _compressed_mesh(s, d) if d is not None else None
        if m is not None:
            out['meshes'].append((_apply(M, m[0]), m[1]))
        else:
            out['skipped'].append(c)
    elif c in COMPOUND:
        t, n = s.array(rel, 0x60)
        for i in range(n):
            a = t + i * 0x80
            child = s.ptr(a + 0x50)
            if child is None:                                # a free slot
                continue
            cols = s.f(a, 12).reshape(3, 4)[:, :3]           # three columns (w carries flags)
            L = np.eye(4)
            L[:3, :3] = cols.T * s.f(a + 0x40, 3)
            L[:3, 3] = s.f(a + 0x30, 3)
            _shape(s, child, M @ L, out, depth + 1)
    else:
        out['skipped'].append(c)


def system_bodies(data):
    """A bhkPhysicsSystem's packfile -> its bodies (shapes in the body's node space, game units)."""
    s = _System(data)
    psd = next((r for r, c in s.cls.items() if c == 'hknpPhysicsSystemData'), None)
    if psd is None:
        return []
    mat_t, nmat = s.array(psd, 0x10)
    mc_t, nmc = s.array(psd, 0x30)
    bod_t, nbod = s.array(psd, 0x40)
    bodies = []
    for i in range(nbod):
        b = bod_t + i * 0x60
        motion, matid, filt = s.u32(b + 0x0C), s.u16(b + 0x12), s.u32(b + 0x14)
        # the shapes are in the space of the node that holds the collision object; the body's own position and
        # orientation are left as the exporter wrote them (a copy of the node's transform, a centre, or nothing) and
        # are not used: the node places the body (tools/collision_check.py: with them, ~14-20 % of the meshes are
        # moved or turned twice)
        B = np.diag([HK, HK, HK, 1.0])
        out = {'hulls': [], 'meshes': [], 'skipped': []}
        _shape(s, s.ptr(b), B, out)
        friction, restitution = 0.5, 0.4
        if mat_t is not None and matid < nmat:
            m = mat_t + matid * 0x50
            friction, restitution = _half(s.u16(m + 0x12)), _half(s.u16(m + 0x16))
        mass, kind = 0.0, 'static'
        if motion != MOTION_STATIC and mc_t is not None and motion < nmc:
            inv = float(s.f(mc_t + motion * 0x70 + 0x04, 1)[0])
            mass = 1.0 / inv if inv > 0 else 0.0
            kind = 'dynamic' if inv > 0 else 'keyframed'
        bodies.append(dict(motion=kind, mass=round(mass, 3), friction=round(friction, 3),
                           restitution=round(restitution, 3), layer=filt & 0x7F, **out))
    return bodies


def nif_collision(nif):
    """Every collision body of a parsed NIF (fo4nif.Nif), in the NIF's own space: a dict for the page."""
    par = nif.parents()
    cache, bodies, errors = {}, [], []
    for i, blk in enumerate(nif.blocks):
        co = (blk or {}).get('collision', -1)
        if co is None or not (0 <= co < nif.nblocks) or nif.block_types[co] != 'bhkNPCollisionObject':
            continue
        o = nif.offsets[co]
        _target, _flags, sysref, body_id = struct.unpack_from('<iHiI', nif.raw, o)
        if not (0 <= sysref < nif.nblocks) or nif.block_types[sysref] != 'bhkPhysicsSystem':
            continue
        if sysref not in cache:
            so = nif.offsets[sysref]
            size, = struct.unpack_from('<I', nif.raw, so)
            try:
                cache[sysref] = system_bodies(nif.raw[so + 4:so + 4 + size])
            except Exception as e:                           # one odd system never sinks the rest
                cache[sysref] = []
                errors.append('%s: %s' % (blk.get('name') or i, e))
        sb = cache[sysref]
        if not sb:
            continue
        N = nif.world(i, par)
        for b in ([sb[body_id]] if body_id < len(sb) else sb):
            hulls = [dict(v=_b64(_apply(N, v), '<f4'), n=len(v), r=round(r * abs(np.linalg.det(N[:3, :3])) ** (1 / 3), 3))
                     for v, r in b['hulls']]
            meshes = [dict(v=_b64(_apply(N, v), '<f4'), t=_b64(t, '<u4'), n=len(v), m=len(t)) for v, t in b['meshes']]
            if not hulls and not meshes:
                continue
            bodies.append(dict(node=blk.get('name') or '', block=i, motion=b['motion'], mass=b['mass'],
                               friction=b['friction'], restitution=b['restitution'], layer=b['layer'],
                               hulls=hulls, meshes=meshes, skipped=sorted(set(b['skipped']))))
    return dict(bodies=bodies, errors=errors)
