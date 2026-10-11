"""Mod Organizer 2, read straight from its own files: MO2 does not need to run, and nothing of it is ever written.

An MO2 instance is a folder with ModOrganizer.ini: a global one in %LOCALAPPDATA%\\ModOrganizer\\<name>, or a portable
one next to ModOrganizer.exe (with portable.txt). Its ini names the game folder (gamePath, also a "Stock Game" copy)
and the mods, profiles and overwrite folders. A profile folder holds modlist.txt (the mods, highest priority first:
+enabled, -disabled, *unmanaged such as DLC), plugins.txt (same format as the game's) and, when the profile has its own
game settings (settings.ini LocalSettings), its own Fallout4.ini and Fallout4Custom.ini.

What the game sees in MO2's virtual Data folder is the game's Data with each enabled mod's folder laid over it in
priority order and Overwrite on top; MO2Profile builds the same view from those folders (sources.py describes the
interface). Files and folders that end in .mohidden are hidden by MO2 and left out here too.
"""
import os
import re
import sys

from fileshare import exists, stamp

# Data subfolders whose loose files the viewer reads (meshes and animations, textures, materials, plugin strings);
# the rest (sound, music, scripts, ...) is never asked for, so it is not indexed
INDEXED = ('meshes', 'textures', 'materials', 'strings')


# ---- QSettings INI files ------------------------------------------------------------------------------------------

def _unescape(v):
    """A value as Qt's QSettings writes it to an INI file: "quoted" parts, backslash escapes (\\\\ \\" \\n \\x00e9
    ...), commas between list items, ';' starting a comment. Returns a string, or a list for a comma list."""
    parts, cur, i, n, quoted = [], [], 0, len(v), False
    simple = {'a': '\a', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v'}
    while i < n:
        c = v[i]
        if c == '"':
            quoted = not quoted
            i += 1
        elif c == '\\' and i + 1 < n:
            d = v[i + 1]
            i += 2
            if d in simple:
                cur.append(simple[d])
            elif d == 'x':
                m = re.match(r'[0-9a-fA-F]+', v[i:])
                if m:
                    cur.append(chr(int(m.group(0), 16)))
                    i += len(m.group(0))
            elif d in '01234567':
                m = re.match(r'[0-7]+', v[i - 1:])
                cur.append(chr(int(m.group(0), 8)))
                i += len(m.group(0)) - 1
            else:
                cur.append(d)                      # \\ \" \' \? \; \,
        elif c == ',' and not quoted:
            parts.append(''.join(cur).strip())
            cur = []
            i += 1
        elif c == ';' and not quoted:
            break
        else:
            cur.append(c)
            i += 1
    parts.append(''.join(cur).strip())
    if len(parts) == 1:
        return _value(parts[0])
    return [_value(p) for p in parts]


def _value(s):
    """@ByteArray(...) holds raw bytes (MO2 stores paths as UTF-8 bytes this way)."""
    if s.startswith('@ByteArray(') and s.endswith(')'):
        s = s[11:-1]
        try:
            return s.encode('latin-1').decode('utf-8')
        except UnicodeError:
            return s
    return s


def _unescape_key(k):
    k = re.sub(r'%U([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), k)
    k = re.sub(r'%([0-9a-fA-F]{2})', lambda m: chr(int(m.group(1), 16)), k)
    return k.replace('/', '\\')


def read_ini(path):
    """{section lower: {key lower: value}} of a QSettings INI file; {} when it cannot be read."""
    out = {}
    try:
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            lines = f.read().splitlines()
    except OSError:
        return out
    sec = out.setdefault('general', {})
    for line in lines:
        s = line.strip()
        if not s or s[0] in ';#':
            continue
        if s.startswith('[') and s.endswith(']'):
            sec = out.setdefault(_unescape_key(s[1:-1]).lower(), {})
            continue
        if '=' in s:
            k, v = s.split('=', 1)
            sec[_unescape_key(k.strip()).lower()] = _unescape(v.strip())
    return out


def _text(v):
    return v if isinstance(v, str) else ','.join(v) if isinstance(v, list) else ''


def _truthy(v):
    return _text(v).strip().lower() in ('true', '1', 'yes')


# ---- instances ----------------------------------------------------------------------------------------------------

def _local():
    return os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')


class Instance:
    """One MO2 instance folder (read from its ModOrganizer.ini)."""

    def __init__(self, folder):
        self.folder = os.path.normpath(folder)
        self.ini = os.path.join(self.folder, 'ModOrganizer.ini')
        cfg = read_ini(self.ini)
        gen, st = cfg.get('general', {}), cfg.get('settings', {})
        self.portable = os.path.isfile(os.path.join(self.folder, 'portable.txt')) or \
            os.path.normcase(os.path.dirname(self.folder)) != os.path.normcase(os.path.join(_local(), 'ModOrganizer'))
        self.name = 'Portable' if self.portable else os.path.basename(self.folder)
        self.game_name = _text(gen.get('gamename', ''))
        gp = _text(gen.get('gamepath', ''))
        self.game_dir = os.path.normpath(gp) if gp else None
        self.selected = _text(gen.get('selected_profile', '')) or 'Default'
        base = self._dir(st, 'base_directory', self.folder)
        self.mods_dir = self._dir(st, 'mod_directory', os.path.join(base, 'mods'), base)
        self.profiles_dir = self._dir(st, 'profiles_directory', os.path.join(base, 'profiles'), base)
        self.overwrite_dir = self._dir(st, 'overwrite_directory', os.path.join(base, 'overwrite'), base)
        # files MO2 leaves out of its virtual Data folder (by name ending) and folders it skips (by exact name)
        sfx = st.get('skip_file_suffixes')
        self.skip_suffixes = tuple(x.strip().lower() for x in ([sfx] if isinstance(sfx, str) else sfx or [])
                                   if x.strip()) or ('.mohidden',)
        sd = st.get('skip_directories')
        self.skip_dirs = {x.strip().lower() for x in ([sd] if isinstance(sd, str) else sd or []) if x.strip()} \
            or {'.git'}
        # a profile without its own LocalSettings line has its own game INIs unless MO2 is set otherwise
        self.profile_inis = _truthy(st.get('profile_local_inis', 'true'))

    def _dir(self, st, key, default, base=None):
        v = _text(st.get(key, '')).strip()
        if not v:
            return os.path.normpath(default)
        if base is not None:
            v = re.sub('%BASE_DIR%', lambda m: base, v, flags=re.I)
        v = os.path.expandvars(v)
        return os.path.normpath(v if os.path.isabs(v) else os.path.join(self.folder, v))

    def is_fallout4(self):
        """A Fallout 4 instance whose game folder is there (also Fallout 4 VR, London, ... : Fallout4.esm decides)."""
        return bool(self.game_dir) and os.path.isfile(os.path.join(self.game_dir, 'Data', 'Fallout4.esm'))

    def profiles(self):
        try:
            names = sorted(os.listdir(self.profiles_dir), key=str.lower)
        except OSError:
            return []
        return [n for n in names if os.path.isfile(os.path.join(self.profiles_dir, n, 'modlist.txt'))]


def _reg(hive_name, key, value):
    if sys.platform != 'win32':
        return None
    try:
        import winreg
        with winreg.OpenKey(getattr(winreg, hive_name), key) as k:
            return winreg.QueryValueEx(k, value)[0]
    except (ImportError, OSError):
        return None


def current_instance():
    """The global instance MO2 opened last (empty: a portable one)."""
    return _reg('HKEY_CURRENT_USER', r'Software\Mod Organizer Team\Mod Organizer', 'CurrentInstance')


def _known_executables():
    """ModOrganizer.exe files this PC knows about: the nxm link handler (registered by MO2) and its handler list."""
    out, ini_dirs = [], [os.path.join(_local(), 'ModOrganizer')]
    cmd = _reg('HKEY_CURRENT_USER', r'Software\Classes\nxm\shell\open\command', '') or \
        _reg('HKEY_CLASSES_ROOT', r'nxm\shell\open\command', '')
    if cmd:
        m = re.match(r'\s*"([^"]+)"|\s*(\S+)', cmd)
        exe = m and (m.group(1) or m.group(2))
        if exe and os.path.basename(exe).lower() in ('nxmhandler.exe', 'modorganizer.exe'):
            out.append(os.path.join(os.path.dirname(exe), 'ModOrganizer.exe'))
            ini_dirs.append(os.path.dirname(exe))         # (its list sits there when %LOCALAPPDATA% has none)
    for d in ini_dirs:
        for name in ('nxmhandler.ini', 'downloadhandler.ini'):       # (the second: MO2 after 2.5.2)
            for sec in read_ini(os.path.join(d, name)).values():
                for v in sec.values():
                    v = _text(v)
                    if v.lower().endswith('modorganizer.exe'):
                        out.append(v)
    return out


def _under_mo2_path():
    """Inside MO2's virtual file system (its usvfs DLL is loaded into every program MO2 starts, and their children):
    the ModOrganizer.exe in the folder MO2 adds to PATH for them."""
    try:
        import ctypes
        if not ctypes.WinDLL('kernel32').GetModuleHandleW('usvfs_x64.dll'):
            return None
    except Exception:
        return None
    for d in os.environ.get('PATH', '').split(os.pathsep):
        exe = os.path.join(d.strip().strip('"'), 'ModOrganizer.exe')
        if d.strip() and os.path.isfile(exe):
            return exe
    return None


def launched_from():
    """The ModOrganizer.exe this viewer was started from (MO2's Run button), or None."""
    if sys.platform != 'win32':
        return None
    return _parent_mo2() or _under_mo2_path()


def _parent_mo2():
    """ModOrganizer.exe among this process's parents (python <- FO4 Lightbox.exe <- ModOrganizer.exe)."""
    try:
        import ctypes
        from ctypes import wintypes

        class PE(ctypes.Structure):
            _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('pid', wintypes.DWORD),
                        ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                        ('ppid', wintypes.DWORD), ('pri', ctypes.c_long), ('flags', wintypes.DWORD),
                        ('exe', ctypes.c_wchar * 260)]
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
        k32.Process32FirstW.argtypes = k32.Process32NextW.argtypes = (ctypes.c_void_p, ctypes.POINTER(PE))
        k32.CloseHandle.argtypes = (ctypes.c_void_p,)
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.QueryFullProcessImageNameW.argtypes = (ctypes.c_void_p, wintypes.DWORD, ctypes.c_wchar_p,
                                                   ctypes.POINTER(wintypes.DWORD))
        snap = k32.CreateToolhelp32Snapshot(2, 0)                     # TH32CS_SNAPPROCESS
        if not snap or snap == ctypes.c_void_p(-1).value:
            return None
        procs = {}
        try:
            e = PE()
            e.dwSize = ctypes.sizeof(PE)
            ok = k32.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                procs[e.pid] = (e.ppid, e.exe)
                ok = k32.Process32NextW(snap, ctypes.byref(e))
        finally:
            k32.CloseHandle(snap)
        pid = os.getpid()
        for _ in range(6):                                            # python <- FO4 Lightbox.exe <- ModOrganizer.exe
            ppid = procs.get(pid, (0, ''))[0]
            if not ppid or ppid == pid or ppid not in procs:
                return None
            pid = ppid
            if procs[pid][1].lower() == 'modorganizer.exe':
                h = k32.OpenProcess(0x1000, False, pid)              # PROCESS_QUERY_LIMITED_INFORMATION
                if not h:
                    return None
                try:
                    buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
                    if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                        return buf.value
                finally:
                    k32.CloseHandle(h)
                return None
    except Exception:
        return None
    return None


def _instance_of_exe(exe):
    """The instance a ModOrganizer.exe uses: its own folder when portable, else the global current instance."""
    d = os.path.dirname(exe)
    if os.path.isfile(os.path.join(d, 'portable.txt')) and os.path.isfile(os.path.join(d, 'ModOrganizer.ini')):
        return d
    cur = current_instance()
    if cur:
        g = os.path.join(_local(), 'ModOrganizer', cur)
        if os.path.isfile(os.path.join(g, 'ModOrganizer.ini')):
            return g
    return None


def instance_folder(path):
    """An MO2 instance folder from a path the user gave (the instance folder, its ModOrganizer.ini, the folder of
    ModOrganizer.exe, or a profile folder); None if there is none."""
    p = os.path.normpath(path.strip().strip('"'))
    if os.path.isfile(p):
        p = os.path.dirname(p)
    for d in (p, os.path.dirname(p), os.path.dirname(os.path.dirname(p))):
        if os.path.isfile(os.path.join(d, 'ModOrganizer.ini')):
            return d
    if os.path.isfile(os.path.join(p, 'ModOrganizer.exe')):
        return _instance_of_exe(os.path.join(p, 'ModOrganizer.exe'))
    return None


def find_instances(extra=()):
    """(Fallout 4 instances, the instance folder MO2 started this viewer from or None). extra: instance folders the
    user added by hand."""
    folders, started = [], None
    exe = launched_from()
    if exe:
        started = _instance_of_exe(exe)
        if started:
            folders.append(started)
    base = os.path.join(_local(), 'ModOrganizer')
    try:
        for n in sorted(os.listdir(base), key=str.lower):
            if os.path.isfile(os.path.join(base, n, 'ModOrganizer.ini')):
                folders.append(os.path.join(base, n))
    except OSError:
        pass
    for exe in _known_executables():
        d = os.path.dirname(exe)
        if os.path.isfile(os.path.join(d, 'ModOrganizer.ini')):
            folders.append(d)
    folders += [f for f in extra if f]
    out, seen = [], set()
    for f in folders:
        key = os.path.normcase(os.path.normpath(f))
        if key in seen:
            continue
        seen.add(key)
        try:
            inst = Instance(f)
        except Exception:
            continue
        if inst.is_fallout4():
            out.append(inst)
    return out, (os.path.normcase(os.path.normpath(started)) if started else None)


# ---- a profile as a source ------------------------------------------------------------------------------------------

def read_modlist(path):
    """Enabled mod folder names, LOWEST priority first (modlist.txt lists the highest first). '+' or no prefix:
    enabled; '-': disabled; '*': unmanaged (DLC, files already in Data); '#': comment. Separators (*_separator) and
    MO2's backup folders (*backup, *backup2, ...) are never enabled."""
    mods = []
    try:
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            lines = f.read().splitlines()
    except OSError:
        return mods
    for line in lines:
        s = line.strip()
        if not s or s[0] in '#-*':
            continue
        name = s[1:] if s[0] == '+' else s
        if name and not name.endswith('_separator') and not re.fullmatch(r'.*backup[0-9]*', name):
            mods.append(name)
    mods.reverse()
    return mods


class MO2Profile:
    kind = 'mo2'

    def __init__(self, inst, profile):
        self.inst, self.profile = inst, profile
        self.pdir = os.path.join(inst.profiles_dir, profile)
        self.game_dir = inst.game_dir
        self.data = os.path.join(self.game_dir, 'Data')
        self.id = 'mo2:%s|%s' % (os.path.normcase(inst.folder), profile)
        self.label = 'MO2 · ' + profile
        self.detail = inst.folder
        self.loose_index = None                # key -> path, built by load()
        self.owner = {}                        # key -> mod name (for the file info)
        self.mods = []
        self._top, self._roots, self._sig = {}, [], None

    # the parts of the profile the viewer reads
    def _settings(self):
        return read_ini(os.path.join(self.pdir, 'settings.ini')).get('general', {})

    def local_settings(self):
        """The profile has its own game INI files (MO2 maps them over My Games when the game starts)."""
        v = self._settings().get('localsettings')
        return self.inst.profile_inis if v is None else _truthy(v)

    def watch(self):
        return [os.path.join(self.pdir, n) for n in ('modlist.txt', 'plugins.txt', 'settings.ini')]

    def _stamps(self):
        out = []
        for p in self.watch():
            try:
                out.append(stamp(p))
            except OSError:
                out.append(None)
        return out

    def changed(self):
        """True when the profile's mod list, plugin list or settings were saved since load()."""
        return self._sig is not None and self._stamps() != self._sig

    def load(self):
        """Read the mod list and index the loose files of the enabled mods and Overwrite (higher priority wins). The
        game's own Data folder is not indexed: it is looked at as it is (an export into Data shows at once), with the
        mods' files winning over it."""
        self._sig = self._stamps()
        mods = [m for m in read_modlist(os.path.join(self.pdir, 'modlist.txt'))
                if os.path.isdir(os.path.join(self.inst.mods_dir, m))]
        roots = [(m, os.path.join(self.inst.mods_dir, m)) for m in mods] + [('Overwrite', self.inst.overwrite_dir)]
        top, index, owner = {}, {}, {}
        for mod, root in roots:
            try:
                entries = os.listdir(root)
            except OSError:
                continue
            for e in entries:
                low = e.lower()
                if low.endswith(self.inst.skip_suffixes):
                    continue
                full = os.path.join(root, e)
                if low in INDEXED:
                    if os.path.isdir(full):
                        self._walk(full, low, mod, index, owner, self.inst.skip_suffixes, self.inst.skip_dirs)
                elif '.' in low:
                    top[low] = (e, full)
        self.mods, self._roots, self._top = mods, roots, top
        self.loose_index, self.owner = index, owner

    @staticmethod
    def _walk(folder, key0, mod, index, owner, suffixes, skip_dirs):
        cut = len(folder)
        for dp, dn, fn in os.walk(folder):
            dn[:] = [d for d in dn if not d.lower().endswith(suffixes) and d.lower() not in skip_dirs]
            rel = key0 + dp[cut:].lower().replace('/', '\\')
            for f in fn:
                low = f.lower()
                if low.endswith(suffixes):
                    continue
                k = rel + '\\' + low
                index[k] = os.path.join(dp, f)
                owner[k] = mod

    def roots(self):
        return [self.data] + [r for _, r in self._roots]

    def plugins_txt(self):
        return os.path.join(self.pdir, 'plugins.txt')

    def ini_dir(self):
        if self.local_settings() and any(os.path.isfile(os.path.join(self.pdir, n))
                                         for n in ('fallout4.ini', 'fallout4custom.ini')):
            return self.pdir
        from fo4paths import my_games_dir
        return my_games_dir()

    def resolve(self, name):
        hit = self._top.get(name.lower())
        if hit and exists(hit[1]):
            return hit[1]
        p = os.path.join(self.data, name)
        return p if exists(p) else None

    def resolver(self):
        """resolve() for a batch of names: Data listed once, the mods' top-level files from the index (sources.py)."""
        from sources import listed_resolver
        return listed_resolver(self.resolve, [self.data], self._top)

    def top_files(self, ext):
        out = {}
        try:
            for f in os.listdir(self.data):             # Data as it is now, the mods' files over it
                if f.lower().endswith(ext):
                    out[f.lower()] = (f, os.path.join(self.data, f))
        except OSError:
            pass
        out.update((k, v) for k, v in self._top.items() if k.endswith(ext))
        return out

    def in_use(self):
        """A profile with mods enabled (an instance made once and left empty is not what the game runs with)."""
        return bool(read_modlist(os.path.join(self.pdir, 'modlist.txt')))

    def mod_of(self, key):
        return self.owner.get(key)

    def describe(self):
        mods = len(self.mods) if self.loose_index is not None else \
            sum(os.path.isdir(os.path.join(self.inst.mods_dir, m))
                for m in read_modlist(os.path.join(self.pdir, 'modlist.txt')))
        return dict(id=self.id, kind=self.kind, label=self.label, detail=self.detail, instance=self.inst.name,
                    profile=self.profile, game_dir=self.game_dir, mods=mods, local_settings=self.local_settings())


def profiles_of(instances):
    """Every profile of these instances as a source (not loaded yet)."""
    return [MO2Profile(inst, p) for inst in instances for p in inst.profiles()]
