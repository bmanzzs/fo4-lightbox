"""Reading game files without getting in anybody's way.

The viewer reads plugins and BA2 archives that their owners may be editing while it runs: the Creation Kit, FO4Edit,
an archive packer or a script can save, rewrite, replace, rename or delete them at any moment, and that must work.
So nothing stays open while the server waits:
  * a file is opened (with all sharing allowed: read, write and delete) only for the operation that reads it - one
    read, or one hold() around a batch of reads such as opening a cell - and closed right after;
  * nothing stays memory-mapped (a mapped file cannot be truncated or replaced): plugins are mapped only while they
    are indexed, then unmapped.
(Measured: opening, reading and closing a file costs ~65 us; a read on a held handle ~0.1 us.)

A file that changed on disk since it was indexed (size or modification time) raises Stale instead of being read with
offsets that no longer fit; the owner (the VFS, the cell index) reads it again.
"""
import contextlib
import os
import sys
import threading


class Stale(Exception):
    """A file changed on disk since it was indexed."""


def stamp(path):
    """(size, modification time in ns): what says a file was rewritten. Read through an open handle, the same way the
    reads and the index see the file: asking the file system by name can answer differently under a virtual Data
    folder (Mod Organizer 2), and then every check would see a change that is not there."""
    with open_shared(path) as f:
        return fstamp(f)


def fstamp(f):
    st = os.fstat(f.fileno())
    return st.st_size, st.st_mtime_ns


_usvfs = None


def under_usvfs():
    """Running inside Mod Organizer 2's virtual file system (its usvfs DLL is loaded into every program MO2 starts and
    their children, from their start): checked once."""
    global _usvfs
    if _usvfs is None:
        try:
            import ctypes
            gmh = ctypes.WinDLL('kernel32').GetModuleHandleW
            gmh.restype = ctypes.c_void_p      # (a module address: the default int result keeps only its low 32 bits)
            _usvfs = sys.platform == 'win32' and bool(gmh('usvfs_x64.dll'))
        except Exception:
            _usvfs = False
    return _usvfs


def exists(path):
    """A file the reads will find. Asking by name first (fast); if that says no, trying to open it, because under Mod
    Organizer 2 a file that lives only in its virtual Data folder can be missed by name and still open fine. Outside
    MO2's virtual file system a name the file system denies cannot be opened either: no failing open (~40 us each)."""
    if os.path.isfile(path):
        return True
    if not under_usvfs():
        return False
    try:
        open_shared(path).close()
        return True
    except OSError:
        return False


if sys.platform == 'win32':
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _CreateFileW = _k32.CreateFileW
    _CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                             wintypes.DWORD, wintypes.HANDLE]
    _CreateFileW.restype = wintypes.HANDLE
    _CloseHandle = _k32.CloseHandle
    _INVALID = wintypes.HANDLE(-1).value
    _GENERIC_READ, _SHARE_ALL, _OPEN_EXISTING, _NORMAL = 0x80000000, 0x7, 3, 0x80

    def open_shared(path):
        """A read-only binary file that other programs may write, truncate, rename or delete while it is open.
        (Python's own open() leaves out FILE_SHARE_DELETE, so a save that renames the file would fail.)"""
        h = _CreateFileW(os.path.abspath(path), _GENERIC_READ, _SHARE_ALL, None, _OPEN_EXISTING, _NORMAL, None)
        if h is None or h == _INVALID:
            raise ctypes.WinError(ctypes.get_last_error())      # FileNotFoundError and friends, as open() raises
        try:
            fd = msvcrt.open_osfhandle(h, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            _CloseHandle(h)
            raise
        return os.fdopen(fd, 'rb')
else:
    def open_shared(path):
        return open(path, 'rb')            # POSIX: an open file never stops others from writing or replacing it


class SharedFile:
    """Positioned reads from one file, thread-safe. Without hold() every read opens, reads and closes the file; inside
    hold() (any thread, nestable) one handle serves all reads until the last hold ends. A file that no longer matches
    `expect` (size, modification time) when it is opened raises Stale."""

    def __init__(self, path, expect=None):
        self.path = path
        self.expect = expect if expect is not None else stamp(path)
        self.lock = threading.Lock()
        self.f = None
        self.holds = 0

    def _open(self):
        f = open_shared(self.path)
        try:
            if fstamp(f) != self.expect:
                raise Stale(f'{os.path.basename(self.path)} changed on disk')
        except BaseException:
            f.close()
            raise
        return f

    @contextlib.contextmanager
    def hold(self):
        """Keep the file open (once read) for a batch of reads; closed when the last hold ends."""
        with self.lock:
            self.holds += 1
        try:
            yield self
        finally:
            with self.lock:
                self.holds -= 1
                if self.holds == 0 and self.f is not None:
                    f, self.f = self.f, None
                    f.close()

    def read(self, pos, n):
        with self.lock:
            if self.holds:
                if self.f is None:
                    self.f = self._open()
                self.f.seek(pos)
                d = self.f.read(n)
            else:
                with self._open() as f:
                    f.seek(pos)
                    d = f.read(n)
        if len(d) != n:
            raise Stale(f'{os.path.basename(self.path)}: short read (the file changed on disk)')
        return d

    def changed(self):
        """True when the file on disk is no longer the one indexed (rewritten, replaced or gone)."""
        try:
            return stamp(self.path) != self.expect
        except OSError:
            return True

    def close(self):
        with self.lock:
            if self.f is not None:
                f, self.f = self.f, None
                f.close()

    @property
    def is_open(self):
        return self.f is not None
