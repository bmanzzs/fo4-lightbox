"""Read-only virtual file system over a Fallout 4 Data folder: loose files override BA2 archives, and later
archives in the game's mount order override earlier ones. Paths are game resource paths such as
'meshes\\clothes\\vault111suit\\vault111suit.nif' (case-insensitive, either slash).

Archives are never held open while the server waits (fileshare.py), so a packer can rebuild or replace one while the
viewer runs; refresh() then reads the new version (and picks up archives added or removed)."""
import contextlib
import itertools
import os
import struct
import threading
import time
import zlib
from collections import OrderedDict

from fileshare import SharedFile, Stale, exists, fstamp, open_shared, stamp
from fo4paths import archive_order


_scope = threading.local()


@contextlib.contextmanager
def lookup_scope():
    """One request's loose-override lookups: inside it, VFS.loose_path answers each (VFS, profile index, key) once (a
    scene build asks for the same NIF / BGSM 3-4 times: read, source, mod, dependency tag). Nothing outlives the
    scope, so files exported, edited or deleted between requests are seen as before. Nested scopes share the outer one."""
    if getattr(_scope, 'memo', None) is not None:
        yield
        return
    _scope.memo = {}
    try:
        yield
    finally:
        _scope.memo = None


def norm(path):
    p = path.replace('/', '\\').strip().lstrip('\\').lower()
    while '\\\\' in p:
        p = p.replace('\\\\', '\\')
    if p.startswith('data\\'):
        p = p[5:]
    return p


class BA2:
    """One archive: name table + per-file records. Files are read on demand (thread-safe); the archive is open only
    for the moment of each read (fileshare.SharedFile), so it can be rebuilt or replaced while the viewer runs.
    An archive rewritten after it was indexed raises fileshare.Stale; VFS.refresh() reads the new one.

    Small general files (materials above all: a cell's NIFs share a few hundred BGSMs) are kept once read, up to
    SMALL_BUDGET for all archives together (least recently used out first). An archive packed again is a new BA2 object
    (VFS.refresh) with its own entries; until then a kept entry is served while the archive is unchanged on disk, a
    stat at most every SMALL_CHECK seconds (a changed one is read, which raises Stale as before, automatic refresh or
    not). Loose overrides are looked up before the archive (VFS._read)."""
    SMALL_MAX = 64 << 10
    SMALL_BUDGET = 64 << 20
    SMALL_CHECK = 1.0
    _small = OrderedDict()                 # (archive token, entry key) -> bytes, shared by all BA2 objects
    _small_size = 0
    _small_lock = threading.Lock()
    _tokens = itertools.count()

    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        with open_shared(path) as f:
            self.stamp = fstamp(f)
            self._parse(f)
        self.file = SharedFile(path, self.stamp)
        self._token = next(BA2._tokens)    # (not the object: kept entries must not keep an unmounted archive alive)
        self._small_checked = time.monotonic()

    _GNRL = struct.Struct('<I4sIIQIII')
    _DX10 = struct.Struct('<I4sIBBHHHBBH')
    _CHUNK = struct.Struct('<QIIHHI')

    def _parse(self, f):
        """Mounting 31 archives (~500,000 names) is most of the server's start: the record table is read in large
        blocks and parsed from memory, and a plain name (no outer spaces, leading or doubled backslash) gets its key
        without norm(). Anything unexpected (a damaged archive) goes through _parse_slow, the reference reading, from
        the start: the same entries, or the same error."""
        try:
            self._parse_fast(f)
        except Exception:
            f.seek(0)
            self._parse_slow(f)

    def _parse_fast(self, f):
        magic, ver, typ, nfiles, name_off = struct.unpack('<4sI4sIQ', f.read(24))
        if magic != b'BTDX':
            raise ValueError('not a BA2')
        if ver in (2, 3):
            f.read(12 if ver == 3 else 8)
        kind = typ.decode('ascii', 'replace')
        if kind == 'GNRL':
            raw = f.read(36 * nfiles)
            if len(raw) != 36 * nfiles:
                raise ValueError('short record table')
            recs = [(off, packed, size) for _, _, _, _, off, packed, size, _ in self._GNRL.iter_unpack(raw)]
        elif kind == 'DX10':
            buf, p, recs = f.read(24 * nfiles + (64 << 10)), 0, []
            for _ in range(nfiles):
                if len(buf) - p < 24:
                    buf = buf[p:] + f.read(64 << 10)
                    p = 0
                (_, _, _, _, nchunks, _, height, width, nmips, fmt, flags16) = self._DX10.unpack_from(buf, p)
                p += 24
                if len(buf) - p < 24 * nchunks:
                    buf = buf[p:] + f.read(24 * nchunks + (64 << 10))
                    p = 0
                chunks = []
                for _ in range(nchunks):
                    off, packed, size, smip, emip, _ = self._CHUNK.unpack_from(buf, p)
                    p += 24
                    chunks.append((off, packed, size))
                recs.append(dict(w=width, h=height, mips=nmips, fmt=fmt, flags=flags16, chunks=chunks))
        else:
            raise ValueError('unsupported type')
        f.seek(name_off)
        blob = f.read()
        entries, p = {}, 0
        for r in recs:
            n = blob[p] | blob[p + 1] << 8
            name = blob[p + 2:p + 2 + n].decode('utf-8', 'replace')
            p += 2 + n
            t = name.replace('/', '\\')
            if t == t.strip() and t[:1] != '\\' and '\\\\' not in t:      # what norm() leaves to do: lower, data\
                k = t.lower()
                if k.startswith('data\\'):
                    k = k[5:]
            else:
                k = norm(name)
            entries[k] = r
        self.version, self.kind, self.entries = ver, kind, entries

    def _parse_slow(self, f):
        magic, ver, typ, nfiles, name_off = struct.unpack('<4sI4sIQ', f.read(24))
        if magic != b'BTDX':
            raise ValueError(f'{self.path}: not a BA2')
        self.version = ver
        if ver in (2, 3):                      # Starfield-era headers carry extra fields
            f.read(8)
            if ver == 3:
                f.read(4)
        self.kind = typ.decode('ascii', 'replace')
        recs = []
        if self.kind == 'GNRL':
            raw = f.read(36 * nfiles)
            for i in range(nfiles):
                _, _, _, _, off, packed, size, _ = struct.unpack_from('<I4sIIQIII', raw, 36 * i)
                recs.append((off, packed, size))
        elif self.kind == 'DX10':
            for _ in range(nfiles):
                (_, _, _, _, nchunks, _, height, width, nmips, fmt, flags16) = \
                    struct.unpack('<I4sIBBHHHBBH', f.read(24))
                chunks = []
                for _ in range(nchunks):
                    off, packed, size, smip, emip, _ = struct.unpack('<QIIHHI', f.read(24))
                    chunks.append((off, packed, size))
                recs.append(dict(w=width, h=height, mips=nmips, fmt=fmt, flags=flags16, chunks=chunks))
        else:
            raise ValueError(f'{self.path}: unsupported BA2 type {self.kind}')
        f.seek(name_off)
        blob = f.read()
        self.entries = {}
        p = 0
        for r in recs:
            n, = struct.unpack_from('<H', blob, p)
            name = blob[p + 2:p + 2 + n].decode('utf-8', 'replace')
            p += 2 + n
            self.entries[norm(name)] = r

    def changed(self):
        return self.file.changed()

    def close(self):
        self.file.close()

    def _read(self, off, packed, size):
        d = self.file.read(off, packed if packed else size)
        # (the record knows the inflated size: one output buffer instead of growing it in steps)
        return zlib.decompress(d, bufsize=max(size, 1)) if packed else d

    def read(self, key):
        r = self.entries[key]
        if self.kind == 'GNRL':
            if r[2] > self.SMALL_MAX:
                return self._read(*r)
            ck = (self._token, key)
            with BA2._small_lock:
                d = BA2._small.get(ck)
                if d is not None:
                    BA2._small.move_to_end(ck)
            if d is not None:
                now = time.monotonic()
                if now - self._small_checked < self.SMALL_CHECK:
                    return d
                if not self.file.changed():
                    self._small_checked = now
                    return d
            d = self._read(*r)
            with BA2._small_lock:
                if ck not in BA2._small:
                    BA2._small[ck] = d
                    BA2._small_size += len(d)
                    while BA2._small_size > self.SMALL_BUDGET:
                        BA2._small_size -= len(BA2._small.popitem(last=False)[1])
            return d
        with self.file.hold():                     # a texture's chunks: one open for all of them
            parts = [dds_header(r['w'], r['h'], r['mips'], r['fmt'], cube=bool(r['flags'] & 1))]
            parts += [self._read(*c) for c in r['chunks']]
        return b''.join(parts)                     # (one copy of the texture, not two)


def dds_header(w, h, mips, dxgi, cube=False):
    """A DX10-extended DDS header for raw texture data stored in a DX10 BA2."""
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000           # caps|height|width|pixelformat|mipcount|linearsize
    hdr = struct.pack('<4sIIIIIII44x', b'DDS ', 124, flags, h, w, 0, 0, max(1, mips))
    pf = struct.pack('<II4sIIIII', 32, 0x4, b'DX10', 0, 0, 0, 0, 0)
    caps1 = 0x1000 | 0x400000 | 0x8 | (0x8 if cube else 0)
    caps2 = 0xFE00 if cube else 0
    caps = struct.pack('<IIIII', caps1, caps2, 0, 0, 0)
    dx10 = struct.pack('<IIIII', dxgi, 3, 0x4 if cube else 0, 1, 0)
    return hdr + pf + caps + dx10


class VFS:
    REFRESH_EVERY = 1.0       # seconds between looks at the archives on disk (only while files are being read)
    SETTLE = 1.5              # seconds a changed archive must stay unchanged before it is read again

    def __init__(self, origin):
        from sources import as_source
        self.origin = as_source(origin)        # the game folder or a Mod Organizer 2 profile (sources.py)
        self.game_dir = self.origin.game_dir
        self.data = self.origin.data
        self.generation = 0                   # +1 whenever the archives change on disk (cache keys use it)
        self.auto = True                       # look for changed archives by itself (off: only forced refreshes)
        self.last_change = []                  # the archives the last refresh read again (for the console)
        self.on_change = None                  # called with those names after a refresh read archives again
        self._lock = threading.Lock()
        self.archives, self.errors, self.unused_archives, self.index = [], [], [], {}
        if self.origin.loose_index is None:
            self.origin.load()
        self._load({})
        self._checked, self._pending = time.monotonic(), None

    def _load(self, keep):
        """Mount the game's archives in order; keep: path -> BA2 already read and unchanged on disk."""
        ordered, unused = archive_order(self.origin)
        archives, errors, failed = [], [], {}
        keep = {os.path.normcase(k): v for k, v in keep.items()}
        for p in ordered:
            a = keep.get(os.path.normcase(p))
            if a is None:
                try:
                    a = BA2(p)
                except Exception as e:                               # keep going; report in /api/status
                    errors.append(f'{os.path.basename(p)}: {e}')
                    try:
                        failed[p] = stamp(p)
                    except OSError:
                        failed[p] = None
                    continue
            archives.append(a)
        index = {}                                                   # key -> archive (last mount wins)
        for a in archives:
            index.update(dict.fromkeys(a.entries, a))
        # swapped in one go: a request in flight keeps the lists it started with
        self.archives, self.errors, self.unused_archives, self.index = archives, errors, unused, index
        self._order, self._failed = ordered, failed

    def refresh(self, force=False, rescan=False):
        """Read again the archives rebuilt, replaced, added or removed since they were indexed (an archive packed while
        the viewer runs), once they have been left alone for SETTLE seconds (a packer writes for a while). A stat per
        archive, at most once per REFRESH_EVERY; True when something changed. force: no waiting (a read needs it).
        Mod Organizer 2: a saved mod list or plugin list (or rescan, File > Reload game files) reads the mod folders
        again too."""
        if not force and (not self.auto or time.monotonic() - self._checked < self.REFRESH_EVERY):
            return False
        with self._lock:
            if not force and time.monotonic() - self._checked < self.REFRESH_EVERY:
                return False
            now = self._checked = time.monotonic()
            remod = rescan or self.origin.changed()
            if remod:
                self.origin.load()
            ordered, _ = archive_order(self.origin)
            stale = {a.path for a in self.archives if a.changed()}

            def mtime(p):
                try:
                    return stamp(p)
                except OSError:
                    return None
            retry = {p for p, t in self._failed.items() if mtime(p) != t}
            same = [os.path.normcase(p) for p in ordered] == [os.path.normcase(p) for p in self._order]
            if same and not stale and not retry:
                self._pending = None
                if not remod:
                    return False
                self.last_change = ['mod list']             # the same archives, other loose files
            else:
                key = (tuple(ordered), frozenset((p, mtime(p)) for p in stale | retry))
                if self._pending is None or self._pending[0] != key:     # changed (again): wait until it stays so
                    self._pending = (key, now)
                if not force and now - self._pending[1] < self.SETTLE:
                    return False
                for a in self.archives:
                    if a.path in stale:
                        a.close()
                before = {os.path.normcase(p) for p in self._order}
                self._load({a.path: a for a in self.archives if a.path not in stale})
                moved = before ^ {os.path.normcase(p) for p in self._order}       # archives added or removed
                self.last_change = sorted(os.path.basename(p) for p in stale | retry | moved)
                self._pending = None
            self.generation += 1
        if self.on_change:
            self.on_change(self.last_change)
        return True

    def loose_path(self, key):
        idx = self.origin.loose_index
        memo = getattr(_scope, 'memo', None)
        if memo is None:
            return self._loose_path(key, idx)
        # keyed by this VFS and its source's current loose index (MO2 re-read mid-request: a new dict, a new memo);
        # the entry holds both, so their ids cannot be reused while the scope lives
        m = memo.get(id(self))
        if m is None or m[0] is not self or m[1] is not idx:
            m = memo[id(self)] = (self, idx, {})
        d = m[2]
        if key not in d:
            d[key] = self._loose_path(key, idx)
        return d[key]

    def _loose_path(self, key, idx):
        if idx:                                # Mod Organizer 2: a file in an enabled mod or Overwrite wins over Data
            p = idx.get(key)
            if p and exists(p):
                return p
        p = os.path.join(self.data, key)
        return p if exists(p) else None

    def source(self, path):
        """'loose', the archive name, or None."""
        key = norm(path)
        if self.loose_path(key):
            return 'loose'
        a = self.index.get(key)
        return a.name if a else None

    def exists(self, path):
        return self.source(path) is not None

    def read(self, path, archives_only=False):
        """File bytes. archives_only=True skips loose files (to get the shipped vanilla copy of an asset)."""
        self.refresh()
        try:
            return self._read(path, archives_only)
        except Stale:                    # its archive was rebuilt a moment ago: read the new one
            self.refresh(force=True)
            return self._read(path, archives_only)

    def _read(self, path, archives_only):
        key = norm(path)
        if archives_only and key in self.index:
            return self.index[key].read(key)
        lp = self.loose_path(key)
        if lp:
            with open(lp, 'rb') as f:
                return f.read()
        a = self.index.get(key)
        if a is None:
            raise FileNotFoundError(path)
        return a.read(key)

    def vanilla(self):
        """This VFS with loose overrides ignored wherever an archived copy exists (see ArchiveView)."""
        return ArchiveView(self)

    def loose_files(self, top, exts):
        """All loose files under Data\\<top> with the given extensions, as resource keys."""
        out = []
        root = os.path.join(self.data, top)
        for dp, dn, fn in os.walk(root):
            for f in fn:
                if f.lower().endswith(exts):
                    out.append(norm(os.path.relpath(os.path.join(dp, f), self.data)))
        idx = self.origin.loose_index
        if idx:                                # Mod Organizer 2: the enabled mods' and Overwrite's files too
            prefix = norm(top) + '\\'
            out += [k for k in idx if k.startswith(prefix) and k.endswith(exts)]
        return out

    def list_files(self, top='meshes', exts=('.nif',)):
        """Sorted union of loose and archived resource keys under one top folder."""
        top = norm(top)
        keys = {k for k in self.index if k.startswith(top + '\\') and k.endswith(exts)}
        keys.update(self.loose_files(top, exts))
        return sorted(keys)


class ArchiveView:
    """A VFS where the archived copy of a file wins over a loose override: the game's own vanilla asset. Used for the
    reference bodies, so a body replacer's loose textures (other UV layout) never land on the vanilla mesh. Files that
    exist only loose are still read."""

    def __init__(self, vfs):
        self.vfs = vfs

    def read(self, path, archives_only=True):
        return self.vfs.read(path, archives_only=True)

    def source(self, path):
        a = self.vfs.index.get(norm(path))
        return a.name if a else self.vfs.source(path)

    def exists(self, path):
        return self.vfs.exists(path)

    def __getattr__(self, name):
        return getattr(self.vfs, name)
