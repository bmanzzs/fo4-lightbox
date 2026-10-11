"""Cells, placed objects and landscape from the active load order, for the cell viewer. Read only.

Index (built once, in the background): worldspaces, every CELL (interior and exterior, with the places in each
plugin where its children are stored) and the base objects a placed reference can point at. The children
(REFR, LAND) are only parsed when a cell is opened. Later plugins override earlier ones, as in the game:
a REFR override replaces the earlier version, a deleted record removes it.

No plugin stays open or mapped: each is mapped only while it is indexed; after that every operation (opening a cell,
an armour lookup) opens the plugins it reads and closes them when it ends (files(), fileshare.py), so the Creation
Kit or FO4Edit can save a plugin while the viewer runs. changed() reports a plugin saved since; the server then
builds the index again (app.py world()).

Reference rotation (verified on tilted vanilla SCOL parts, see memory notes): world = Rx(-rx)·Ry(-ry)·Rz(-rz)·local.
"""
import contextlib
import math
import os
import struct
import threading
import zlib

from fileshare import exists, stamp
from esm_weather import _Plugin, _subrecords, _cstr, _COMPRESSED, _DELETED, GDRY_FIELDS

_PERSISTENT = 0x400
_DISABLED = 0x800            # initially disabled
_LOCALIZED = 0x80            # TES4 header flag: FULL holds a string-table id

# base types a REFR can place that carry a model
MODEL_TYPES = (b'STAT', b'SCOL', b'MSTT', b'FURN', b'CONT', b'DOOR', b'LIGH', b'ACTI', b'TREE', b'FLOR', b'MISC',
               b'WEAP', b'ARMO', b'BOOK', b'ALCH', b'AMMO', b'KEYM', b'NOTE', b'TERM', b'IDLM', b'BNDS', b'MOVS',
               b'ADDN', b'PKIN', b'TACT', b'CMPO')
OTHER_TYPES = (b'LTEX', b'TXST', b'LGTM', b'WATR', b'ARMA', b'OMOD', b'MSWP', b'KYWD', b'RACE', b'NPC_', b'HDPT', b'CLFM',
               b'GDRY')
# armour OMOD properties that change what is drawn (FO4Edit armour property list)
OMOD_ADDON_INDEX, OMOD_MATERIAL_SWAPS = 7, 13
COC_MARKER = 0x000032         # COCMarkerHeading (Fallout4.esm): where the console's coc puts the player
_NAV_TRI = struct.Struct('<3H3hfBHH')     # NVNM v15 triangle: 3 verts, 3 edges, float, u8, flags, cover (21 bytes)
SKIP_MODELS = ('editor\\', '\\fx\\fxinvisible')
_IS_MARKER = 0x00800000      # base record flag "Is Marker" (XMarker, COC and heading markers...): never drawn


_REC = struct.Struct('<4sIII').unpack_from      # record header: signature, size, flags, FormID
_SIG_SIZE = struct.Struct('<4sI').unpack_from
_U16 = struct.Struct('<H').unpack_from
_U32 = struct.Struct('<I').unpack_from
_I32 = struct.Struct('<i').unpack_from
_CELL_SUBS = frozenset((b'EDID', b'FULL', b'DATA', b'XCLC'))


class _Strings:
    """A plugin's string table (STRINGS file), each string decoded when first asked for (the index needs a few
    thousand of Fallout4.esm's 60,000). Gives what the table read in full gave: get(id, default); later duplicates
    win; a short directory keeps the entries it holds in full."""

    def __init__(self, d):
        n = _U32(d, 0)[0]
        m = min(n, max(0, (len(d) - 8) // 8))
        self.d, self.data0, self.cache = d, 8 + n * 8, {}
        self.off = dict(struct.iter_unpack('<II', d[8:8 + 8 * m]))

    def get(self, sid, default=None):
        s = self.cache.get(sid)
        if s is None:
            off = self.off.get(sid)
            if off is None:
                return default
            o = self.data0 + off
            e = self.d.find(b'\0', o)
            s = self.cache[sid] = self.d[o:e].decode('cp1252', 'replace')
        return s


def _model_path(p):
    p = p.replace('/', '\\').lstrip('\\')
    if not p.lower().startswith('meshes\\'):
        p = 'meshes\\' + p
    return p


def _tex_path(p):
    p = p.replace('/', '\\').lstrip('\\')
    if p and not p.lower().startswith('textures\\'):
        p = 'textures\\' + p
    return p


def _rgba(b, o):
    return [b[o] / 255.0, b[o + 1] / 255.0, b[o + 2] / 255.0]


class WorldDB:
    def __init__(self, data_dir, plugins, vfs=None):
        self.data_dir, self.vfs = data_dir, vfs
        self.requested = list(plugins)      # the load order this index was built for (see changed())
        self.plugins = []
        for name in plugins:
            path = os.path.join(data_dir, name)
            if exists(path):
                try:
                    self.plugins.append(_Plugin(path))
                except ValueError:
                    pass
        self._assign_load_order()
        self.base = {}        # load-order FormID -> (plugin, record offset), last override wins
        self.base_sig = {}    # load-order FormID -> signature
        self.cells = {}       # load-order FormID -> cell entry (see _cell_entry)
        self.worlds = {}      # load-order FormID -> {'edid', 'name', 'persistent', 'water'}
        self.grid = {}        # (world FormID, x, y) -> cell FormID
        self.strings = {}     # plugin name -> string table (lazy)
        self._items = None    # ARMO list for the item search (lazy)
        self._omod_kw = None  # keyword FormID -> armour OMODs that change the addon index or material swaps
        self._model_names = None   # model path -> in-game names of the armour that uses it (mesh search)
        self._memo = None     # inside one cell() call: lookups its references repeat (see cell())
        self._pers = {}       # world FormID -> its persistent references, parsed (cell(); never modified)
        self._labels = None   # the cell search's labels (lazy)
        self.lock = threading.Lock()
        try:
            for p in self.plugins:
                self._index(p)
                p.unmap()          # indexed: records are read on demand from here on, nothing stays mapped
        finally:
            for p in self.plugins:
                p.unmap()
        # each requested plugin as it was read: (name, size, mtime) or (name, None, None) when absent
        by_path = {p.path: p.stamp for p in self.plugins}
        self.signature = tuple((name,) + by_path.get(os.path.join(data_dir, name), (None, None)) for name in plugins)

    def changed(self):
        """True when a plugin was saved, replaced or removed after it was indexed (the index then no longer fits)."""
        return any(p.file.changed() for p in self.plugins)

    @contextlib.contextmanager
    def files(self):
        """One operation's reads: each plugin is opened on its first read and all are closed when the operation ends."""
        with contextlib.ExitStack() as st:
            for p in self.plugins:
                st.enter_context(p.file.hold())
            yield

    def close(self):
        for p in self.plugins:
            p.close()

    # ---- load order (same scheme as WeatherDB) -------------------------------------------------------------
    def _assign_load_order(self):
        full_idx, light_idx, prefix = 0, 0, {}
        for p in self.plugins:
            if p.is_light:
                base = 0xFE000000 | (light_idx << 12)
                prefix[p.name.lower()] = (lambda b: (lambda raw: b | (raw & 0xFFF)))(base)
                light_idx += 1
            else:
                base = full_idx << 24
                prefix[p.name.lower()] = (lambda b: (lambda raw: b | (raw & 0xFFFFFF)))(base)
                full_idx += 1
        for p in self.plugins:
            p.prefix_map = [prefix.get(m.lower()) for m in p.masters]
            p.self_map = prefix[p.name.lower()]
            p.localized = bool(p.flags & _LOCALIZED)

    # ---- index -------------------------------------------------------------------------------------------
    def _index(self, p):
        d = p.map()
        for label, gpos, gsize in p.iter_top_groups():
            end = gpos + gsize
            if label in MODEL_TYPES or label in OTHER_TYPES:
                pos = gpos + 24
                while pos + 24 <= end:
                    sig, size, flags, raw = _REC(d, pos)
                    if sig == b'GRUP':
                        pos += size
                        continue
                    fid = p.global_fid(raw)
                    if fid is not None:
                        if flags & _DELETED:
                            self.base.pop(fid, None)
                        else:
                            self.base[fid] = (p, pos)
                            self.base_sig[fid] = sig
                    pos += 24 + size
            elif label == b'CELL':
                self._walk_cells(p, gpos + 24, end, None)
            elif label == b'WRLD':
                self._walk_worlds(p, gpos + 24, end)

    def _body(self, p, pos):
        sig, size, flags, raw = _REC(p.read(pos, 16))
        body = p.read(pos + 24, size)
        if flags & _COMPRESSED:
            body = zlib.decompress(body[4:])
        return sig, flags, raw, body

    def _walk_worlds(self, p, start, end):
        d, pos = p.map(), start
        while pos + 24 <= end:
            sig, size = _SIG_SIZE(d, pos)
            if sig == b'GRUP':
                gtype = _I32(d, pos + 12)[0]
                if gtype == 1:                       # world children
                    wfid = p.global_fid(_U32(d, pos + 8)[0])
                    self._walk_cells(p, pos + 24, pos + size, wfid)
                pos += size
                continue
            if sig == b'WRLD':
                _, flags, raw, body = self._body(p, pos)
                fid = p.global_fid(raw)
                if fid is not None:
                    subs = list(_subrecords(body))
                    w = self.worlds.setdefault(fid, {'edid': '', 'name': '', 'persistent': None, 'water': 0.0})
                    for k, v in subs:
                        if k == 'EDID':
                            w['edid'] = _cstr(v)
                        elif k == 'FULL':
                            w['name'] = self._text(p, v)
                        elif k == 'DNAM' and len(v) >= 8:
                            w['water'] = struct.unpack_from('<f', v, 4)[0]      # default water height
            pos += 24 + size

    def _walk_cells(self, p, start, end, world):
        d, pos, last = p.map(), start, None
        while pos + 24 <= end:
            sig, size = _SIG_SIZE(d, pos)
            if sig == b'GRUP':
                gtype = _I32(d, pos + 12)[0]
                if gtype in (2, 3, 4, 5):
                    self._walk_cells(p, pos + 24, pos + size, world)
                elif gtype == 6:
                    cfid = p.global_fid(_U32(d, pos + 8)[0])
                    c = self.cells.get(cfid)
                    if c is not None:
                        c['children'].append((p, pos + 24, pos + size))
                pos += size
                continue
            if sig == b'CELL':
                self._cell_record(p, pos, world)
            pos += 24 + size

    def _cell_record(self, p, pos, world):
        _, flags, raw, body = self._body(p, pos)
        fid = p.global_fid(raw)
        if fid is None:
            return
        c = self.cells.get(fid)
        if c is None:
            c = self.cells[fid] = {'fid': fid, 'edid': '', 'name': '', 'world': world, 'grid': None, 'interior': world is None,
                                   'sky': False, 'persistent': bool(flags & _PERSISTENT), 'recs': [], 'children': []}
        c['recs'].append((p, pos))
        # _subrecords inlined on byte signatures, slicing only the four wanted (60,000 cells per index build)
        q, end, big = 0, len(body), None
        while q + 6 <= end:
            k = body[q:q + 4]
            size = _U16(body, q + 4)[0]
            q += 6
            if k == b'XXXX':
                big = _U32(body, q)[0]
                q += size
                continue
            if big is not None:
                size, big = big, None
            if k in _CELL_SUBS:
                v = body[q:q + size]
                if k == b'EDID':
                    c['edid'] = _cstr(v)
                elif k == b'FULL':
                    c['name'] = self._text(p, v)
                elif k == b'DATA' and len(v) >= 1:
                    c['interior'] = bool(v[0] & 1)
                    # an interior with Use Sky Lighting (0x100) is lit by the weather's sun and sky like an exterior
                    c['sky'] = c['interior'] and len(v) >= 2 and bool(struct.unpack_from('<H', v)[0] & 0x100)
                elif k == b'XCLC' and len(v) >= 8 and world is not None:
                    c['grid'] = struct.unpack_from('<ii', v, 0)
            q += size
        if world is not None:
            if c['persistent']:
                self.worlds.setdefault(world, {'edid': '', 'name': '', 'persistent': None, 'water': 0.0})['persistent'] = fid
            elif c['grid'] is not None:
                self.grid[(world, c['grid'][0], c['grid'][1])] = fid

    # ---- strings -------------------------------------------------------------------------------------------
    def _text(self, p, v):
        if not getattr(p, 'localized', False):
            return _cstr(v)
        if len(v) != 4:
            return _cstr(v)
        sid = struct.unpack('<I', v)[0]
        return self._table(p.name).get(sid, '')

    def _table(self, plugin):
        t = self.strings.get(plugin)
        if t is not None:
            return t
        t = {}
        base = os.path.splitext(plugin)[0]
        path = 'strings\\%s_en.strings' % base.lower()
        try:
            if self.vfs is not None and self.vfs.exists(path):
                t = _Strings(self.vfs.read(path))
        except Exception:
            pass
        self.strings[plugin] = t
        return t

    # ---- queries -------------------------------------------------------------------------------------------
    def world_name(self, wfid):
        w = self.worlds.get(wfid) or {}
        return w.get('name') or w.get('edid') or ('%08X' % wfid if wfid is not None else '')

    def _search_labels(self):
        """(cell, search label, edid lower, name lower) of every cell the search lists, made once per index."""
        if self._labels is None:
            out = []
            for c in self.cells.values():
                if c['persistent'] and not c['interior']:
                    continue
                label = ('%s %s %s' % (c['edid'], c['name'], '' if c['interior'] else self.world_name(c['world']))).lower()
                if c['grid'] is not None:
                    label += ' %d,%d' % c['grid']
                out.append((c, label, c['edid'].lower(), c['name'].lower()))
            self._labels = out
        return self._labels

    def search(self, q, limit=200):
        terms = [t for t in q.lower().split() if t]
        out = []
        for c, label, edid, name in self._search_labels():
            if terms and not all(t in label for t in terms):
                continue
            if not terms and not c['edid']:
                continue
            score = 0
            for t in terms:
                if edid.startswith(t) or name.startswith(t):
                    score -= 2
                elif t in edid or t in name:
                    score -= 1
            out.append((score, not c['edid'], edid, c))
        out.sort(key=lambda x: x[:3])
        return [self.cell_info(c) for *_, c in out[:limit]], len(out)

    def cell_info(self, c):
        return {'formid': '%08X' % c['fid'], 'edid': c['edid'], 'name': c['name'], 'interior': c['interior'], 'sky': c['sky'],
                'world': None if c['interior'] else self.world_name(c['world']), 'grid': c['grid'],
                'plugins': sorted({p.name for p, _ in c['recs']}, key=[x.name for x in self.plugins].index)}

    def find_cell(self, key):
        key = str(key).strip()
        try:
            fid = int(key, 16)
            if fid in self.cells:
                return self.cells[fid]
        except ValueError:
            pass
        k = key.lower()
        for c in self.cells.values():
            if c['edid'].lower() == k:
                return c
        raise KeyError('cell %r not found' % key)

    # ---- one cell -------------------------------------------------------------------------------------------
    def cell(self, key, radius=1):
        """Placed objects (with their model), landscape and lighting of a cell; exteriors include the
        surrounding (2r+1)^2 cells and the worldspace's persistent references that fall inside that area."""
        with self.lock, self.files():
            # per-call memos (thousands of references share a few hundred models, decal materials, land textures and
            # god rays): dropped when the call ends, so the next open sees exported models and edited BGSMs as before
            self._memo = {'exists': {}, 'bgsm': {}, 'ltex': {}, 'gdry': {}}
            try:
                return self._cell(key, radius)
            finally:
                self._memo = None

    def _cell(self, key, radius):
        c = self.find_cell(key)
        cells = [c]
        area = None
        if not c['interior'] and c['grid'] is not None:
            gx, gy = c['grid']
            cells = []
            for dy in range(-radius, radius + 1):
                for dx in range(-radius, radius + 1):
                    f = self.grid.get((c['world'], gx + dx, gy + dy))
                    if f is not None:
                        cells.append(self.cells[f])
            area = ((gx - radius) * 4096.0, (gy - radius) * 4096.0, (gx + radius + 1) * 4096.0, (gy + radius + 1) * 4096.0)
        refs, lands, navs, pers = {}, [], {}, {}
        for cc in cells:
            for p, s, e in cc['children']:
                self._read_children(p, s, e, refs, lands, cc, navs)
        if area is not None:
            pc = self.worlds.get(c['world'], {}).get('persistent')
            if pc is not None:
                # the worldspace's persistent references (the Commonwealth: 33,000, ~0.1 s to read) are parsed once per
                # index; the ones in the area are copied, so the 'off' set below never reaches the cached dicts
                pers = self._pers.get(c['world'])
                if pers is not None and any(p.file.changed() for p in {p for p, s, e in self.cells[pc]['children']}):
                    pers = None        # a plugin behind them was saved: read again, which raises Stale (index rebuilt)
                if pers is None:
                    pers = {}
                    for p, s, e in self.cells[pc]['children']:
                        self._read_children(p, s, e, pers, None, None)
                    self._pers[c['world']] = pers
                for k, r in pers.items():
                    if r.get('deleted'):
                        continue
                    x, y = r['pos'][0], r['pos'][1]
                    if area[0] <= x < area[2] and area[1] <= y < area[3]:
                        refs[k] = dict(r)
        # the state the game starts a reference in: its own Initially Disabled flag, or its enable parent's state
        # (XESP), flipped when the reference is set to the opposite of its parent; parents elsewhere count as on
        lookup = dict(pers)
        lookup.update(refs)
        memo = {}

        def off(r, depth=0):
            if r.get('deleted') or r['flags'] & _DISABLED:
                return True
            x = r.get('xesp')
            if not x or depth > 12:
                return False
            if r['id'] not in memo:
                par = lookup.get(x[0])
                memo[r['id']] = par is not None and off(par, depth + 1) != bool(x[1] & 1)
            return memo[r['id']]
        for r in refs.values():
            if not r.get('deleted') and off(r):
                r['off'] = True
        placed, skipped = [], {'no model': 0, 'marker': 0, 'disabled': 0, 'deleted': 0, 'unresolved': 0}
        for k, r in refs.items():
            if r.get('deleted'):
                skipped['deleted'] += 1
                continue
            if r.get('off'):
                skipped['disabled'] += 1
                continue
            for item in self._expand(r):
                if item is None:
                    skipped['unresolved'] += 1
                elif item == 'nomodel':
                    skipped['no model'] += 1
                elif item == 'marker':
                    skipped['marker'] += 1
                else:
                    placed.append(item)
        out = {'cell': self.cell_info(c), 'refs': placed, 'skipped': skipped,
               'land': [self._land_json(l) for l in lands], 'lighting': self._lighting(c),
               'water': self._water(c, cells), 'spawn': self._spawn(c, refs, navs)}
        return out

    def _spawn(self, c, refs, navs):
        """Where a character can stand: the cell's COCMarkerHeading (what coc uses; position and facing), else the
        middle of the navmesh triangle nearest the cell's middle (navmesh = where actors can walk), else None."""
        live = [r for r in refs.values() if not r.get('deleted') and not r.get('off') and not r['flags'] & _DISABLED]
        if not c['interior'] and c['grid'] is not None:
            gx, gy = c['grid']
            mid, flat = [(gx + 0.5) * 4096.0, (gy + 0.5) * 4096.0, 0.0], True
        else:
            pts = sorted(r['pos'] for r in live) or [[0.0, 0.0, 0.0]]
            mid = [sorted(q[i] for q in pts)[len(pts) // 2] for i in range(3)]
            flat = False

        def dist(q):
            d = (q[0] - mid[0]) ** 2 + (q[1] - mid[1]) ** 2
            return d if flat else d + (q[2] - mid[2]) ** 2
        coc = [r for r in live if r['base'] == COC_MARKER]
        if coc:
            r = min(coc, key=lambda r: dist(r['pos']))
            return {'pos': r['pos'], 'heading': -r['rot'][2], 'source': 'coc marker', 'ref': '%08X' % r['id']}
        best = None
        for nv in navs.values():
            try:
                k = 16
                n = struct.unpack_from('<I', nv, k)[0]
                k += 4
                verts = struct.unpack_from('<%df' % (3 * n), nv, k)
                k += 12 * n
                nt = struct.unpack_from('<I', nv, k)[0]
                k += 4
                for i in range(nt):
                    a, b, cc, *_ = _NAV_TRI.unpack_from(nv, k + 21 * i)
                    q = [(verts[3 * a + j] + verts[3 * b + j] + verts[3 * cc + j]) / 3 for j in range(3)]
                    d = dist(q)
                    if best is None or d < best[0]:
                        best = (d, q)
            except (struct.error, IndexError):
                continue
        if best:
            return {'pos': best[1], 'heading': None, 'source': 'navmesh'}
        return None

    def _read_children(self, p, start, end, refs, lands, cell, navs=None):
        """A cell's children GRUP (one positioned read) -> placed references, landscape and navmeshes."""
        d = p.read(start, end - start)
        self._children(p, d, 0, len(d), refs, lands, cell, navs)

    def _children(self, p, d, pos, end, refs, lands, cell, navs):
        while pos + 24 <= end:
            sig, size = struct.unpack_from('<4sI', d, pos)
            if sig == b'GRUP':
                gtype = struct.unpack_from('<i', d, pos + 12)[0]
                if gtype in (8, 9):
                    self._children(p, d, pos + 24, pos + size, refs, lands, cell, navs)
                pos += size
                continue
            if sig == b'REFR':
                _, flags, raw, body = _record(d, pos)
                fid = p.global_fid(raw)
                if fid is not None:
                    if flags & _DELETED:
                        refs[fid] = {'deleted': True}
                    else:
                        r = {'id': fid, 'flags': flags, 'base': None, 'pos': [0.0, 0.0, 0.0], 'rot': [0.0, 0.0, 0.0],
                             'scale': 1.0, 'plugin': p.name}
                        for k, v in _subrecords(body):
                            if k == 'NAME' and len(v) >= 4:
                                r['base'] = p.global_fid(struct.unpack_from('<I', v)[0])
                            elif k == 'DATA' and len(v) >= 24:
                                vals = struct.unpack_from('<6f', v)
                                r['pos'], r['rot'] = list(vals[:3]), list(vals[3:])
                            elif k == 'XSCL' and len(v) >= 4:
                                r['scale'] = struct.unpack_from('<f', v)[0]
                            elif k == 'XRDS' and len(v) >= 4:
                                r['radius'] = struct.unpack_from('<f', v)[0]          # light radius override
                            elif k == 'XESP' and len(v) >= 8:                          # enable parent, flags
                                r['xesp'] = (p.global_fid(struct.unpack_from('<I', v)[0]), struct.unpack_from('<I', v, 4)[0])
                            elif k == 'XMSP' and len(v) >= 4:                          # material swap override
                                r['mswp'] = p.global_fid(struct.unpack_from('<I', v)[0])
                            elif k == 'XLIG' and len(v) >= 8:                          # light: FOV and fade +/-, end
                                r['xlig'] = struct.unpack_from('<%df' % min(6, len(v) // 4), v)   # distance cap, shadow
                                                                                       # depth bias, near clip, volumetric
                            elif k == 'XPDD' and len(v) >= 8:                          # projected decal: width, height scale
                                r['xpdd'] = struct.unpack_from('<2f', v)
                            elif k == 'XPRM' and len(v) >= 12:                         # primitive box (half sizes)
                                r['xprm'] = struct.unpack_from('<3f', v)
                        refs[fid] = r
            elif sig == b'LAND' and lands is not None:
                _, flags, raw, body = _record(d, pos)
                if not flags & _DELETED:
                    lands.append((p, cell, list(_subrecords(body))))
            elif sig == b'NAVM' and navs is not None:          # navmesh: later plugins override by FormID
                _, flags, raw, body = _record(d, pos)
                fid = p.global_fid(raw)
                if flags & _DELETED:
                    navs.pop(fid, None)
                else:
                    nv = next((v for k, v in _subrecords(body) if k == 'NVNM'), None)
                    if nv:
                        navs[fid] = nv
            pos += 24 + size

    def _base(self, fid):
        e = self.base.get(fid)
        if e is None:
            return None, None, None
        p, pos = e
        sig, flags, raw, body = self._body(p, pos)
        return sig, p, list(_subrecords(body))

    def _expand(self, r):
        """A placed REFR -> one or more {model, pos, rot, scale} items (SCOLs without their own model expand
        into their parts)."""
        e = self.base.get(r['base'])
        if e is None:
            return [None]
        p, pos = e
        sig, flags, raw, body = self._body(p, pos)
        subs = list(_subrecords(body))
        model = next((_cstr(v) for k, v in subs if k == 'MODL'), '')
        edid = next((_cstr(v) for k, v in subs if k == 'EDID'), '')
        # Is Marker (XMarker, COC and heading markers, scene flags...) and idle markers (IDLM, e.g. Dogmeat's sniff
        # spots, a blue dog figure in the editor): the game never draws these. Everything else draws its NIF
        # (BlackPlane, the Freedom Trail signs live under markers\ too); editor-only shapes (EditorMarker) are
        # hidden by the scene builder
        if (flags & _IS_MARKER and sig != b'LIGH') or sig == b'IDLM':
            return ['marker']
        if model and self._exists(_model_path(model)):
            m = _model_path(model)
            if any(s in m.lower() for s in SKIP_MODELS):
                return ['marker']
            item = {'ref': '%08X' % r['id'], 'base': '%08X' % r['base'], 'type': sig.decode(), 'edid': edid, 'model': m,
                    'pos': r['pos'], 'rot': r['rot'], 'scale': r['scale']}
            # material swap: the reference's own (XMSP) else its base object's (MODS), e.g. the blue cryo pipes
            sw = r.get('mswp') or next((p.global_fid(struct.unpack_from('<I', v)[0]) for k, v in subs
                                         if k == 'MODS' and len(v) >= 4), None)
            if sw:
                item['swap'] = '%08X' % sw
            if sig == b'LIGH':
                item['light'] = self._light(subs, r, p)
            return [item]
        if sig == b'SCOL':
            return self._scol_parts(r, p, subs) or ['nomodel']
        if sig == b'TXST':
            d = self._decal(r, p, subs)
            if d is None:
                return ['nomodel']
            return [{'ref': '%08X' % r['id'], 'base': '%08X' % r['base'], 'type': 'TXST', 'edid': edid, 'model': None,
                     'pos': r['pos'], 'rot': r['rot'], 'scale': r['scale'], 'decal': d}]
        if sig == b'LIGH':
            return [{'ref': '%08X' % r['id'], 'base': '%08X' % r['base'], 'type': 'LIGH', 'edid': edid, 'model': None,
                     'pos': r['pos'], 'rot': r['rot'], 'scale': r['scale'], 'light': self._light(subs, r, p)}]
        return ['nomodel']

    def _exists(self, path):
        m = self._memo
        if m is None:
            return self.vfs is None or self.vfs.exists(path)
        m = m['exists']
        if path not in m:
            m[path] = self.vfs is None or self.vfs.exists(path)
        return m[path]

    def _decal(self, r, p, subs):
        """A placed texture set with decal data (TXST DODT) -> the projected decal the viewer draws (§22): its box
        (width x height across the reference's X and Z, depth along +Y, the projection direction), material, colour,
        subtexture."""
        dodt = next((v for k, v in subs if k == 'DODT'), None)
        if not dodt or len(dodt) < 36:
            return None
        minw, maxw, minh, maxh, depth, shininess, pscale = struct.unpack_from('<7f', dodt)
        passes, flags = dodt[28], dodt[29]
        athr = struct.unpack_from('<H', dodt, 30)[0]
        color = [dodt[32] / 255.0, dodt[33] / 255.0, dodt[34] / 255.0]
        tex = {k: _tex_path(_cstr(v)) for k, v in subs if len(k) == 4 and k.startswith('TX')}
        mnam = next((_cstr(v) for k, v in subs if k == 'MNAM'), '')
        dnam = next((struct.unpack_from('<H', v)[0] for k, v in subs if k == 'DNAM' and len(v) >= 2), 0)
        # one size per reference between the minimum and maximum, the same every time the cell is opened
        h = (r['id'] * 2654435761) & 0xFFFFFFFF
        u1, u2, u3 = (h & 0x3FF) / 1023.0, ((h >> 10) & 0x3FF) / 1023.0, ((h >> 20) & 0x3FF) / 1023.0
        w = minw + (maxw - minw) * u1
        hh = minh + (maxh - minh) * u2
        if r.get('xpdd'):
            w *= r['xpdd'][0]
            hh *= r['xpdd'][1]
        mat = None
        if mnam:
            from materials import read_material
            from scene import bgsm_fields, mat_path
            mp = mat_path(mnam)
            memo = self._memo['bgsm'] if self._memo is not None else {}
            if mp not in memo:                  # read and parsed once per cell() call (None: unreadable)
                try:
                    memo[mp] = read_material(self.vfs.read(mp))
                except Exception:
                    memo[mp] = None
            bg = memo[mp]
            try:
                if bg is not None and bg.get('kind') == 'bgsm':      # (a fresh dict per decal)
                    mat = dict(kind='lighting', source='bgsm', material_path=mp, **bgsm_fields(bg))
            except Exception:
                mat = None
        if mat is None:
            if not tex.get('TX00'):
                return None
            mat = dict(kind='lighting', source='txst',
                       textures=dict(diffuse=tex.get('TX00', ''), normal=tex.get('TX01', ''),
                                     smoothspec=tex.get('TX07', '') if not dnam & 1 else '', glow='', greyscale='',
                                     envmap=tex.get('TX05', '')),
                       alpha=dict(blend=bool(flags & 2), src=6, dst=7, test=bool(flags & 4), ref=min(255, athr),
                                  value=1.0),
                       specular_enabled=bool(tex.get('TX07')) and not dnam & 1, specular_mult=1.0, smoothness=1.0,
                       uv_offset=[0.0, 0.0], uv_scale=[1.0, 1.0], tile_u=False, tile_v=False)
        mat.update(decal=True, vertex_colors=True, vertex_alpha=True, two_sided=False, zwrite=False)
        if not (mat.get('alpha') or {}).get('blend') and not (mat.get('alpha') or {}).get('test'):
            mat['alpha'] = dict(blend=True, src=6, dst=7, test=False, ref=0, value=1.0)
        return {'size': [round(w, 3), round(hh, 3)], 'depth': depth, 'offset': 0.0,
                'sub': -1 if flags & 8 else int(u3 * 4) % 4, 'quad': not flags & 8, 'color': color,
                'flags': flags, 'multiply': bool(flags & 0x10), 'parallax': [pscale, passes] if flags & 1 else None,
                'shininess': shininess, 'material': mat, 'txst': tex, 'mnam': mnam,
                'xprm': r.get('xprm'), 'xpdd': r.get('xpdd')}

    def _scol_parts(self, r, p, subs):
        out, part = [], None
        R = _rot_matrix(r['rot'])
        for k, v in subs:
            if k == 'ONAM' and len(v) >= 4:
                part = p.global_fid(struct.unpack_from('<I', v)[0])
            elif k == 'DATA' and part is not None:
                psig, pp, psubs = self._base(part)
                model = next((_cstr(x) for kk, x in psubs or [] if kk == 'MODL'), '')
                if not model:
                    continue
                m = _model_path(model)
                sw = next((pp.global_fid(struct.unpack_from('<I', x)[0]) for kk, x in psubs if kk == 'MODS' and len(x) >= 4), None)
                for i in range(len(v) // 28):
                    px, py, pz, rx, ry, rz, sc = struct.unpack_from('<7f', v, i * 28)
                    lp = [px * r['scale'], py * r['scale'], pz * r['scale']]
                    wp = [r['pos'][j] + sum(R[j][kk] * lp[kk] for kk in range(3)) for j in range(3)]
                    it = {'ref': '%08X' % r['id'], 'base': '%08X' % part, 'type': 'SCOL part', 'edid': '',
                          'model': m, 'pos': wp, 'rot': r['rot'], 'rot2': [rx, ry, rz], 'scale': r['scale'] * sc}
                    if sw:
                        it['swap'] = '%08X' % sw
                    out.append(it)
        return out

    def _god_rays(self, p, raw):
        """A GDRY (god rays) record referenced from plugin p -> its DATA fields (esm_weather GDRY_FIELDS, keys as the
        weather sample's god_rays: back_color, fwd_color, intensity, air_color_scale, ...), or None."""
        fid = p.global_fid(raw)
        memo = self._memo['gdry'] if self._memo is not None else None
        if memo is None:
            return self._god_rays_of(fid)
        if fid not in memo:
            memo[fid] = self._god_rays_of(fid)
        gr = memo[fid]
        return dict(gr) if gr is not None else None          # a copy: _light sets its own 'near'

    def _god_rays_of(self, fid):
        sig, gp, gsubs = self._base(fid) if fid is not None else (None, None, None)
        if sig != b'GDRY':
            return None
        v = next((x for k, x in gsubs if k == 'DATA'), None)
        if not v:
            return None
        f = struct.unpack_from('<%df' % (len(v) // 4), v)
        out, pos = {'formid': '%08X' % fid, 'edid': next((_cstr(x) for k, x in gsubs if k == 'EDID'), '')}, 0
        for name, n in GDRY_FIELDS:
            if pos + n > len(f):
                break
            key = name.lower().replace(' - ', '_').replace(' ', '_')
            out[key] = [round(x, 6) for x in f[pos:pos + n]] if n > 1 else round(f[pos], 6)
            pos += n
        return out

    def _light(self, subs, ref=None, p=None):
        v = next((x for k, x in subs if k == 'DATA'), None)
        if not v or len(v) < 12:
            return None
        # LIGH DATA (FO4Edit order): time int32, radius uint32, colour RGBA, flags uint32, falloff exponent, FOV,
        # near clip, flicker period / intensity amplitude / movement amplitude, constant, scalar, exponent, ...
        f = lambda o: struct.unpack_from('<f', v, o)[0] if len(v) >= o + 4 else None
        out = {'radius': struct.unpack_from('<I', v, 4)[0], 'color': _rgba(v, 8),
               'flags': struct.unpack_from('<I', v, 12)[0] if len(v) >= 16 else 0,
               'falloff': f(16) or 1.0,                             # spotlights: the cone's falloff exponent
               'fov': f(20) or 90.0,                                # spotlights: cone angle, degrees
               'near': f(24) or 0.0,                                # shadow-casting lights: nothing nearer casts
               'constant': f(40), 'scalar': f(44), 'exponent': f(48),
               'fade': next((struct.unpack_from('<f', x)[0] for k, x in subs if k == 'FNAM' and len(x) >= 4), 1.0)}
        # §24 a spotlight's own god rays (WGDR -> GDRY) and their near clip (DATA +52)
        wg = next((struct.unpack_from('<I', x)[0] for k, x in subs if k == 'WGDR' and len(x) >= 4), 0)
        if wg and p is not None:
            gr = self._god_rays(p, wg)
            if gr:
                gr['near'] = f(52) or 0.0
                out['god_rays'] = gr
        if ref is not None and (ref.get('radius') or 0) > 0:      # some refs store negative values: keep the base radius
            out['radius'] = ref['radius']
        x = ref.get('xlig') if ref is not None else None
        if x:                                                     # the reference's own adjustments (XLIG "+/-")
            out['fov'] += x[0]
            out['fade'] += x[1]
            if len(x) >= 4:
                out['shadow_bias'] = x[3]                         # shadow depth bias (CK "Depth Bias")
            if len(x) >= 5 and x[4] > 0:
                out['near'] = x[4]                                # near clip override
        return out

    # ---- landscape ---------------------------------------------------------------------------------------
    def _land_json(self, item):
        p, cell, subs = item
        gx, gy = cell['grid'] if cell and cell['grid'] else (0, 0)
        out = {'grid': [gx, gy], 'heights': None, 'colors': None, 'layers': []}
        quads = {}
        cur = None
        for k, v in subs:
            if k == 'VHGT' and len(v) >= 4 + 1089:
                off = struct.unpack_from('<f', v)[0]
                dl = struct.unpack_from('<1089b', v, 4)
                h, rowstart = [], off
                for i in range(33):
                    rowstart += dl[i * 33]
                    acc = rowstart
                    h.append(acc)
                    for j in range(1, 33):
                        acc += dl[i * 33 + j]
                        h.append(acc)
                out['heights'] = [round(x * 8.0, 2) for x in h]
            elif k == 'VCLR' and len(v) >= 3267:
                out['colors'] = list(v[:3267])
            elif k == 'BTXT' and len(v) >= 8:
                tex, quad = struct.unpack_from('<IB', v)
                quads.setdefault(quad, {'base': None, 'layers': []})['base'] = self._ltex(p.global_fid(tex))
            elif k == 'ATXT' and len(v) >= 8:
                tex, quad, _, layer = struct.unpack_from('<IBBH', v)
                cur = {'tex': self._ltex(p.global_fid(tex)), 'layer': layer, 'alpha': []}
                quads.setdefault(quad, {'base': None, 'layers': []})['layers'].append(cur)
            elif k == 'VTXT' and cur is not None:
                cur['alpha'] = [[struct.unpack_from('<H', v, i * 8)[0], round(struct.unpack_from('<f', v, i * 8 + 4)[0], 4)]
                                for i in range(len(v) // 8)]
        for q, info in sorted(quads.items()):
            info['layers'].sort(key=lambda L: L['layer'])
            out['layers'].append({'quad': q, 'base': info['base'], 'layers': info['layers']})
        return out

    def _ltex(self, fid):
        memo = self._memo['ltex'] if self._memo is not None else None
        if memo is None:
            return self._ltex_of(fid)
        if fid not in memo:
            memo[fid] = self._ltex_of(fid)
        t = memo[fid]
        return dict(t) if t is not None else None

    def _ltex_of(self, fid):
        if fid is None:
            return None
        sig, p, subs = self._base(fid)
        if sig != b'LTEX':
            return None
        tnam = next((struct.unpack_from('<I', v)[0] for k, v in subs if k == 'TNAM' and len(v) >= 4), None)
        edid = next((_cstr(v) for k, v in subs if k == 'EDID'), '')
        out = {'edid': edid, 'diffuse': None, 'normal': None, 'spec': None}
        if tnam is not None:
            tsig, tp, tsubs = self._base(p.global_fid(tnam))
            if tsig == b'TXST':
                for k, v in tsubs:
                    if k == 'TX00':
                        out['diffuse'] = _tex_path(_cstr(v))
                    elif k == 'TX01':
                        out['normal'] = _tex_path(_cstr(v))
                    elif k == 'TX07':
                        out['spec'] = _tex_path(_cstr(v))
        return out

    # ---- lighting and water ------------------------------------------------------------------------------
    def _lighting(self, c):
        """Interior lighting from XCLL (or the lighting template's DATA when the cell has none)."""
        if not c['interior']:
            return None
        p, pos = c['recs'][-1]
        _, _, _, body = self._body(p, pos)
        subs = list(_subrecords(body))
        xcll = next((v for k, v in subs if k == 'XCLL'), None)
        ltmp = next((struct.unpack_from('<I', v)[0] for k, v in subs if k == 'LTMP' and len(v) >= 4), None)
        xcim = next((struct.unpack_from('<I', v)[0] for k, v in subs if k == 'XCIM' and len(v) >= 4), None)
        source = 'XCLL'
        if xcll is None and ltmp:
            tsig, tp, tsubs = self._base(p.global_fid(ltmp))
            if tsig == b'LGTM':
                xcll = next((v for k, v in tsubs if k == 'DATA'), None)
                source = 'lighting template'
        out = {'source': source if xcll else None, 'imagespace': '%08X' % p.global_fid(xcim) if xcim else None}
        if xcll and len(xcll) >= 92:
            f = lambda o: struct.unpack_from('<f', xcll, o)[0]
            i32 = lambda o: struct.unpack_from('<i', xcll, o)[0]
            out.update({
                'ambient': _rgba(xcll, 0), 'directional': _rgba(xcll, 4), 'fog_near_color': _rgba(xcll, 8),
                'fog_near': f(12), 'fog_far': f(16), 'dir_rot_xy': i32(20), 'dir_rot_z': i32(24), 'dir_fade': f(28),
                'fog_clip': f(32), 'fog_power': f(36),
                'dalc': {n: _rgba(xcll, 40 + 4 * i) for i, n in enumerate(['X+', 'X-', 'Y+', 'Y-', 'Z+', 'Z-'])},
                'fog_far_color': _rgba(xcll, 72) if len(xcll) >= 76 else None,
                'fog_max': f(76) if len(xcll) >= 80 else 1.0,
            })
        return out

    def _water(self, c, cells):
        if c['interior']:
            return None
        h = self.worlds.get(c['world'], {}).get('water', 0.0)
        out = []
        for cc in cells:
            p, pos = cc['recs'][-1]
            _, _, _, body = self._body(p, pos)
            wh = next((struct.unpack_from('<f', v)[0] for k, v in _subrecords(body) if k == 'XCLW' and len(v) >= 4), h)
            if wh is not None and abs(wh) < 1e6 and cc['grid']:
                out.append({'grid': list(cc['grid']), 'height': wh})
        return out


def _record(d, pos):
    """(signature, flags, raw FormID, body) of the record at pos in a buffer; compressed bodies are inflated."""
    sig, size, flags, raw = struct.unpack_from('<4sIII', d, pos)
    body = d[pos + 24:pos + 24 + size]
    if flags & _COMPRESSED:
        body = zlib.decompress(body[4:])
    return sig, flags, raw, body


def _rot_matrix(rot):
    """3x3 for world = Rx(-rx)·Ry(-ry)·Rz(-rz)."""
    def rx(a):
        c, s = math.cos(a), math.sin(a)
        return [[1, 0, 0], [0, c, -s], [0, s, c]]

    def ry(a):
        c, s = math.cos(a), math.sin(a)
        return [[c, 0, s], [0, 1, 0], [-s, 0, c]]

    def rz(a):
        c, s = math.cos(a), math.sin(a)
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]]

    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mul(mul(rx(-rot[0]), ry(-rot[1])), rz(-rot[2]))


# ---------------------------------------------------------------------------------------------------------------
# Plugin items: what an ARMO record actually makes the game load (attached to WorldDB below)
# ---------------------------------------------------------------------------------------------------------------

def _u32s(v):
    return [struct.unpack_from('<I', v, 4 * i)[0] for i in range(len(v) // 4)]


def _edid(subs):
    return next((_cstr(v) for k, v in subs if k == 'EDID'), '')


def _file_info(self, path):
    """Where the game would load a resource from, and when a loose copy was last written."""
    if not path:
        return None
    src = self.vfs.source(path) if self.vfs else None
    out = {'path': path, 'source': src}
    if src == 'loose':
        from vfs import norm
        key = norm(path)
        lp = self.vfs.loose_path(key) or os.path.join(self.data_dir, path)
        mod = self.vfs.origin.mod_of(key)
        if mod:
            out['mod'] = mod                    # Mod Organizer 2: the mod it comes from
        size, mtime_ns = stamp(lp)
        out['mtime'] = mtime_ns / 1e9
        out['size'] = size
        out['overrides_archive'] = bool(self.vfs and path.lower() in self.vfs.index)
    return out


def _items_index(self):
    if self._items is not None:
        return
    items, kw = [], {}
    for fid, sig in list(self.base_sig.items()):
        if sig == b'ARMO':
            _, p, subs = self._base(fid)
            if subs is None:
                continue
            bod = next((v for k, v in subs if k == 'BOD2'), None)
            items.append({'formid': '%08X' % fid, 'edid': _edid(subs),
                          'name': next((self._text(p, v) for k, v in subs if k == 'FULL'), ''),
                          'plugin': p.name, 'slots': struct.unpack_from('<I', bod)[0] if bod and len(bod) >= 4 else 0})
        elif sig == b'OMOD':
            _, p, subs = self._base(fid)
            if subs is None:
                continue
            d = next((v for k, v in subs if k == 'DATA'), None)
            if not d or len(d) < 24 or d[10:14] != b'ARMO':
                continue
            try:
                ninc, nprop = struct.unpack_from('<II', d, 0)
                k = 20
                nslot = struct.unpack_from('<I', d, k)[0]
                k += 4 + 4 * nslot
                nitem = struct.unpack_from('<I', d, k)[0]
                k += 4 + 8 * nitem
                k += 7 * ninc
                addon, addon_op, swaps, removes = None, 'set', [], []
                for i in range(nprop):
                    vt, ft, prop = struct.unpack_from('<III', d, k)
                    v1 = struct.unpack_from('<I', d, k + 12)[0]
                    if prop == OMOD_ADDON_INDEX:
                        addon, addon_op = v1, ('add' if ft == 2 else 'set')     # function type 2 = ADD
                    elif prop == OMOD_MATERIAL_SWAPS:       # FormID values: 0 set, 1 remove, 2 add
                        g = p.global_fid(v1)
                        if g:
                            (removes if ft == 1 else swaps).append(g)
                    k += 24
            except struct.error:
                continue
            if addon is None and not swaps and not removes:
                continue
            info = {'formid': '%08X' % fid, 'edid': _edid(subs), 'plugin': p.name,
                    'name': next((self._text(p, v) for k, v in subs if k == 'FULL'), ''),
                    'addon_index': addon, 'addon_op': addon_op, 'swaps': ['%08X' % x for x in swaps],
                    'removes_swaps': ['%08X' % x for x in removes]}
            mnam = next((v for kk, v in subs if kk == 'MNAM'), b'')
            for t in _u32s(mnam):
                g = p.global_fid(t)
                if g is not None:
                    kw.setdefault(g, []).append(info)
    items.sort(key=lambda x: (x['name'] or x['edid']).lower())
    self._items, self._omod_kw = items, kw


def armor_search(self, q, limit=150):
    with self.lock, self.files():
        _items_index(self)
    terms = [t for t in q.lower().split() if t]
    out = [it for it in self._items
           if all(t in ('%s %s %s %s' % (it['edid'], it['name'], it['plugin'], it['formid'])).lower() for t in terms)]

    def rank(it):
        n = (it['name'] or '').lower()
        return (0 if terms and (n.startswith(terms[0]) or it['edid'].lower().startswith(terms[0])) else 1, n)
    out.sort(key=rank)
    return out[:limit], len(out)


def model_names(self):
    """Model path (normalised, lower case) -> [(in-game name, EDID)] of every armour (clothing included) whose world
    model or armature (male / female, first person) uses it: the mesh search finds a NIF by the name the game shows."""
    with self.lock, self.files():
        if self._model_names is not None:
            return self._model_names
        _items_index(self)
        names = {}

        def add(path, it):
            if not path:
                return
            k = _model_path(path).lower()
            e = (it['name'] or it['edid'], it['edid'])
            lst = names.setdefault(k, [])
            if e not in lst:
                lst.append(e)
        for it in self._items:
            sig, p, subs = self._base(int(it['formid'], 16))
            if subs is None:
                continue
            for k, v in subs:
                if k in ('MOD2', 'MOD4'):                       # ground models
                    add(_cstr(v), it)
                elif k == 'MODL' and len(v) == 4:               # armatures by addon index
                    asig, ap, asubs = self._base(p.global_fid(struct.unpack_from('<I', v)[0]))
                    if asig == b'ARMA':
                        for kk, mv in asubs:
                            if kk in ('MOD2', 'MOD3', 'MOD4', 'MOD5'):
                                add(_cstr(mv), it)
        self._model_names = names
        return names


def _mswp(self, fid):
    sig, p, subs = self._base(fid)
    if sig != b'MSWP':
        return None
    pairs, cur = [], None
    for k, v in subs:
        if k == 'BNAM':
            cur = {'orig': _cstr(v), 'new': None, 'remap': None}
            pairs.append(cur)
        elif k == 'SNAM' and cur is not None:
            cur['new'] = _cstr(v)
        elif k == 'CNAM' and cur is not None and len(v) >= 4:
            cur['remap'] = struct.unpack_from('<f', v)[0]
    return {'formid': '%08X' % fid, 'edid': _edid(subs), 'plugin': p.name, 'pairs': [x for x in pairs if x['new']]}


def _swap_list(p, v):
    """MO?S subrecord: one FormID, or a count followed by FormIDs."""
    if len(v) == 4:
        raw = _u32s(v)
    else:
        n = struct.unpack_from('<I', v)[0]
        raw = _u32s(v[4:4 + 4 * n])
    return ['%08X' % g for g in (p.global_fid(x) for x in raw) if g]


def armor(self, key):
    """ARMO -> world models, every ARMA by addon index (race, male / female / first-person models with where the
    game would load them from), the default addon index, OMOD variants and every material swap involved."""
    with self.lock, self.files():
        _items_index(self)
        key = str(key).strip()
        fid = None
        try:
            fid = int(key, 16)
        except ValueError:
            pass
        if fid is None or self.base_sig.get(fid) != b'ARMO':
            fid = next((int(it['formid'], 16) for it in self._items if it['edid'].lower() == key.lower()), None)
        if fid is None:
            raise KeyError('armour %r not found' % key)
        sig, p, subs = self._base(fid)
        out = {'formid': '%08X' % fid, 'edid': _edid(subs), 'plugin': p.name,
               'name': next((self._text(p, v) for k, v in subs if k == 'FULL'), ''), 'world': {}, 'addons': [],
               'variants': [], 'swaps': {}}
        swap_ids = set()
        for mk, sk, label in (('MOD2', 'MO2S', 'male'), ('MOD4', 'MO4S', 'female')):
            v = next((x for k, x in subs if k == mk), None)
            if v:
                sw = next((_swap_list(p, x) for k, x in subs if k == sk), [])
                swap_ids.update(sw)
                out['world'][label] = dict(_file_info(self, _model_path(_cstr(v))) or {}, swaps=sw)
        pairs, idx = [], 0
        for k, v in subs:
            if k == 'INDX' and len(v) >= 2:
                idx = struct.unpack_from('<H', v)[0]
            elif k == 'MODL' and len(v) == 4:
                pairs.append((idx, p.global_fid(struct.unpack_from('<I', v)[0])))
        default = None
        obts = next((v for k, v in subs if k == 'OBTS'), None)
        if obts and len(obts) >= 8:
            ninc, nprop = struct.unpack_from('<II', obts)
            for i in range(nprop):
                o = len(obts) - 24 * (nprop - i)
                if o >= 0 and struct.unpack_from('<I', obts, o + 8)[0] == OMOD_ADDON_INDEX:
                    default = struct.unpack_from('<I', obts, o + 12)[0]
        out['default_addon_index'] = default if default is not None else (min(i for i, _ in pairs) if pairs else 0)
        for i, afid in pairs:
            asig, ap, asubs = self._base(afid)
            if asig != b'ARMA':
                out['addons'].append({'index': i, 'formid': '%08X' % afid if afid else None, 'missing': True})
                continue
            rn = next((struct.unpack_from('<I', v)[0] for k, v in asubs if k == 'RNAM' and len(v) >= 4), None)
            rsig, rp, rsubs = self._base(ap.global_fid(rn)) if rn else (None, None, None)
            a = {'index': i, 'formid': '%08X' % afid, 'edid': _edid(asubs), 'plugin': ap.name,
                 'race': _edid(rsubs) if rsubs else None, 'models': {}}
            for mk, sk, label in (('MOD2', 'MO2S', 'male'), ('MOD3', 'MO3S', 'female'),
                                  ('MOD4', 'MO4S', 'male_1st'), ('MOD5', 'MO5S', 'female_1st')):
                v = next((x for k, x in asubs if k == mk), None)
                if v:
                    sw = next((_swap_list(ap, x) for k, x in asubs if k == sk), [])
                    swap_ids.update(sw)
                    a['models'][label] = dict(_file_info(self, _model_path(_cstr(v))) or {}, swaps=sw)
            out['addons'].append(a)
        kws = next((v for k, v in subs if k == 'KWDA'), b'')
        seen = set()
        for t in _u32s(kws):
            g = p.global_fid(t)
            for m in self._omod_kw.get(g, []):
                if m['formid'] not in seen:
                    seen.add(m['formid'])
                    out['variants'].append(m)
                    swap_ids.update(m['swaps'])
        out['variants'] = [dict(m) for m in out['variants']]
        base = out['default_addon_index']
        for m in out['variants']:              # the addon index this OMOD selects: SET = value, ADD = default + value
            if m['addon_index'] is not None:
                m['resolved_index'] = m['addon_index'] if m['addon_op'] == 'set' else base + m['addon_index']
        out['variants'].sort(key=lambda m: (m['name'] or m['edid']).lower())
        for sid in swap_ids:
            sw = _mswp(self, int(sid, 16))
            if sw:
                out['swaps'][sid] = sw
        return out


def swap_map(self, ids):
    """{normalised original material: {'new', 'remap'}} for a list of MSWP FormIDs (later ones win)."""
    from scene import mat_path
    out = {}
    with self.lock, self.files():
        for sid in ids:
            try:
                sw = _mswp(self, int(sid, 16))
            except ValueError:
                sw = None
            for pr in (sw or {}).get('pairs', []):
                out[mat_path(pr['orig'])] = {'new': pr['new'], 'remap': pr['remap']}
    return out


def swap_changed(self, ids):
    """The file name of a plugin holding one of these MSWP records that was saved after indexing (else None): what
    swap_map() would find by reading it (Stale). One stat per plugin; for a cached scene, whose swaps are not read."""
    ps = set()
    for sid in ids:
        try:
            e = self.base.get(int(sid, 16))
        except ValueError:
            e = None
        if e is not None:
            ps.add(e[0])
    return next((os.path.basename(p.file.path) for p in ps if p.file.changed()), None)


# The skin tone of the reference bodies. An NPC's QNAM ("texture lighting", four floats) is the colour the game soft-light
# blends over its skin shaders (SkinTint body and hands; the face tint's skin-tone layer uses the same colour and blend);
# the fourth float is the amount. The Player record dresses the male body, Nora (MQ101PlayerSpouseFemale) the female.
SKIN_NPCS = {'m': 0x000007, 'f': 0x0A7D35}


def skin_tones(self):
    out = {}
    with self.lock, self.files():
        for sex, fid in SKIN_NPCS.items():
            sig, p, subs = self._base(fid)
            q = next((v for k, v in subs or [] if k == 'QNAM' and len(v) >= 16), None)
            if sig == b'NPC_' and q:
                r, g, b, amount = struct.unpack_from('<4f', q)
                out[sex] = {'rgb': [round(r, 6), round(g, 6), round(b, 6)], 'amount': round(amount, 6),
                            'npc': _edid(subs), 'plugin': p.name}
    return out


# The rest of the default look: the same NPCs' hair and facial-hair head parts (HDPT types 3 and 4) with their extra
# parts (HNAM, e.g. the hairline), and the hair colour. FO4 hair colours (CLFM) are a remapping index: the row of the
# hair material's greyscale-to-palette gradient (CNAM read as a float).
HDPT_EYES, HDPT_HAIR, HDPT_FACIAL_HAIR = 2, 3, 4


def default_look(self, sex):
    # parts: hair, hairline, beard (hair colour remap); eye_parts: the eyes' own extra parts (wet layer, AO under the
    # lids, lashes: Nora's FemaleEyesHumanHazel brings FemaleEyesHumanWet / AO / Lashes), shown with the reference eyes
    out = {'parts': [], 'eye_parts': [], 'hair_remap': None, 'hair_color': None}
    with self.lock, self.files():
        sig, p, subs = self._base(SKIN_NPCS.get(sex, 0))
        if sig != b'NPC_':
            return out
        seen = set()

        def add(fid, depth=0, into='parts'):
            hs, hp, hsubs = self._base(fid)
            if hs != b'HDPT' or fid in seen:
                return
            kind = next((struct.unpack_from('<I', v)[0] for k, v in hsubs if k == 'PNAM' and len(v) >= 4), None)
            if depth == 0:
                if kind == HDPT_EYES:              # the eyes mesh itself is one of the reference's own files
                    into = 'eye_parts'
                elif kind not in (HDPT_HAIR, HDPT_FACIAL_HAIR):
                    return
            seen.add(fid)
            model = next((_cstr(v) for k, v in hsubs if k == 'MODL'), '')
            if model and not (depth == 0 and kind == HDPT_EYES):
                out[into].append(_model_path(model))
            for k, v in hsubs:
                if k == 'HNAM' and len(v) >= 4:
                    add(hp.global_fid(struct.unpack_from('<I', v)[0]), depth + 1, into)
        for k, v in subs:
            if k == 'PNAM' and len(v) >= 4:
                add(p.global_fid(struct.unpack_from('<I', v)[0]))
        hc = next((p.global_fid(struct.unpack_from('<I', v)[0]) for k, v in subs if k == 'HCLF' and len(v) >= 4), None)
        cs, cp, csubs = self._base(hc) if hc else (None, None, None)
        if cs == b'CLFM':
            cn = next((v for k, v in csubs if k == 'CNAM'), b'')
            if len(cn) >= 4:
                f = struct.unpack_from('<f', cn)[0]
                if 0.0 <= f <= 1.0:
                    out['hair_remap'] = f
            out['hair_color'] = _edid(csubs)
    return out


WorldDB.default_look = default_look
WorldDB.skin_tones = skin_tones
WorldDB.armor_search = armor_search
WorldDB.armor = armor
WorldDB.swap_map = swap_map
WorldDB.swap_changed = swap_changed

WorldDB.model_names = model_names
